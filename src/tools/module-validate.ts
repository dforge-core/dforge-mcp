// Pre-flight whole-module validator. Read-only: loads every file and runs the
// CROSS-REFERENCE checks that per-tool validation can't see — the errors that
// otherwise only surface at pack/install (a slow, tenant-bound round trip).
//
// Catches: dangling FK/reference targets, the hidden-FK column missing for a
// Reference, view dataSources/columns pointing at unknown entities/fields, menu
// dataViewCode → missing view, role rights keyed on unknown entities/actions/
// reports, and entities with no Select grant. Returns a structured issue list
// in `_validate.json` plus a one-line summary; never writes anything.

import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import { expandTraits } from "@dforge-core/metadata";
import {
	loadManifest,
	readJsonOrDefault,
	checkSecurityCoverage,
	type ToolResult,
} from "./_helpers";

export const moduleValidateSchema = {
	moduleDir: z.string().describe("Path to the module root. Run this after authoring and before dforge_module_pack."),
};

type Level = "error" | "warning";
interface Issue {
	level: Level;
	where: string;
	message: string;
}

// Platform-provided entities that are valid FK targets but not authored in the
// module. PK column name per entity (mirrors the editor's SYSTEM_ENTITY_FIELDS).
const SYSTEM_ENTITY_PK: Record<string, string> = {
	user: "user_id",
	document: "document_id",
	menu_item: "menu_item_id",
	resource: "resource_id",
};

export function moduleValidate(
	args: z.infer<z.ZodObject<typeof moduleValidateSchema>>,
): ToolResult {
	const { paths, manifest } = loadManifest(args.moduleDir);
	const issues: Issue[] = [];
	const err = (where: string, message: string) => issues.push({ level: "error", where, message });
	const warn = (where: string, message: string) => issues.push({ level: "warning", where, message });

	// ── Load same-module entities + compute each one's valid column set ──
	const entityMap = (manifest.entities ?? {}) as Record<string, string>;
	const entities: Record<string, Record<string, unknown>> = {};
	const columnsOf: Record<string, Set<string>> = {};

	for (const [name, relPath] of Object.entries(entityMap)) {
		if (name.includes(".")) continue; // cross-module extension key — not authored here
		const abs = path.join(paths.root, relPath.replace(/^\.\//, ""));
		if (!fs.existsSync(abs)) {
			err(`manifest.entities.${name}`, `points to '${relPath}' which does not exist on disk`);
			continue;
		}
		let e: Record<string, unknown>;
		try {
			e = JSON.parse(fs.readFileSync(abs, "utf8"));
		} catch (ex) {
			err(`entities/${name}.json`, `invalid JSON: ${(ex as Error).message}`);
			continue;
		}
		entities[name] = e;
		const fields = (e.fields as Record<string, unknown> | undefined) ?? {};
		const cols = new Set<string>(Object.keys(fields));
		const traits = (e.traits as string[] | undefined) ?? [];
		try {
			for (const c of Object.keys(expandTraits(traits, name))) cols.add(c);
		} catch {
			/* unknown trait — surfaced separately by add-time validation */
		}
		columnsOf[name] = cols;
	}

	// A dotted code (cross-module entity, e.g. 'fin.invoice') is only valid if its
	// module prefix is a declared dependency (or this module's own code). We can't
	// confirm the entity exists in the other module offline, but this catches refs
	// to an undeclared/typo'd module instead of accepting any dotted string.
	const deps = new Set(Object.keys(manifest.dependencies ?? {}));
	const isKnownEntity = (code: string): boolean => {
		if (code in entities || code in SYSTEM_ENTITY_PK) return true;
		const dot = code.indexOf(".");
		if (dot > 0) {
			const mod = code.slice(0, dot);
			return deps.has(mod) || mod === manifest.code;
		}
		return false;
	};
	const pkOf = (code: string): string | undefined => {
		if (code in SYSTEM_ENTITY_PK) return SYSTEM_ENTITY_PK[code];
		const e = entities[code];
		if (e && ((e.traits as string[] | undefined) ?? []).includes("identity")) return `${code}_id`;
		return undefined;
	};

	// ── 1. Reference columns + references block ──
	for (const [name, e] of Object.entries(entities)) {
		const fields = (e.fields as Record<string, Record<string, unknown>> | undefined) ?? {};
		for (const [fname, f] of Object.entries(fields)) {
			if (!f || f.columnType !== "R" || !f.link) continue;
			const link = f.link as Record<string, unknown>;
			const where = `entities/${name}.json → ${fname}.link`;
			const target = link.entity as string | undefined;
			if (!target || !isKnownEntity(target)) {
				err(where, `link.entity '${target}' is not a known entity (same-module, system, or cross-module dependency)`);
			}
			const thisKey = link.thisKey as string | undefined;
			if (thisKey && !columnsOf[name].has(thisKey)) {
				err(where, `link.thisKey '${thisKey}' is not a column on '${name}' — the hidden FK column is missing (FK+Reference is two columns)`);
			}
			const pk = target ? pkOf(target) : undefined;
			if (pk && link.otherKey && link.otherKey !== pk) {
				warn(where, `link.otherKey '${link.otherKey}' — expected '${pk}' (the target entity's PK)`);
			}
		}
		const refs = (e.references as Record<string, Record<string, unknown>> | undefined) ?? {};
		for (const [rname, r] of Object.entries(refs)) {
			const fromField = (r?.from as Record<string, unknown> | undefined)?.field as string | undefined;
			if (fromField && !columnsOf[name].has(fromField)) {
				err(`entities/${name}.json → references.${rname}`, `from.field '${fromField}' is not a column on '${name}'`);
			}
			const toEntity = (r?.to as Record<string, unknown> | undefined)?.entity as string | undefined;
			if (toEntity && !isKnownEntity(toEntity)) {
				err(`entities/${name}.json → references.${rname}`, `to.entity '${toEntity}' is not a known entity`);
			}
		}
	}

	// ── 2. Data view entity + column references ──
	const views = readJsonOrDefault<Record<string, Record<string, unknown>>>(paths.dataViews, {});
	const viewCodes = new Set(Object.keys(views));
	for (const [vcode, v] of Object.entries(views)) {
		const sources = (v.dataSources as Array<Record<string, unknown>> | undefined) ?? [];
		for (const s of sources) {
			const ent = s.entityCode as string | undefined;
			if (!ent || !isKnownEntity(ent)) {
				err(`data_views → ${vcode}`, `dataSource entityCode '${ent}' is not a known entity`);
				continue;
			}
			const cols = columnsOf[ent]; // undefined for system entities — can't check their columns
			if (!cols) continue;
			for (const c of (s.columns as Array<Record<string, unknown>> | undefined) ?? []) {
				const cc = c.column_cd as string | undefined;
				if (cc && !cols.has(cc)) {
					err(`data_views → ${vcode}`, `column '${cc}' is not a field on entity '${ent}'`);
				}
			}
		}
	}

	// ── 3. Menu dataViewCode → existing view (deep walk, structure-agnostic) ──
	const menus = readJsonOrDefault<Record<string, unknown>>(paths.menus, {});
	const walk = (node: unknown, where: string): void => {
		if (!node || typeof node !== "object") return;
		const rec = node as Record<string, unknown>;
		const dvc = rec.dataViewCode;
		if (typeof dvc === "string" && !viewCodes.has(dvc)) {
			err(where, `dataViewCode '${dvc}' has no matching view in data_views.json`);
		}
		for (const [k, child] of Object.entries(rec)) {
			if (child && typeof child === "object") walk(child, `${where} → ${k}`);
		}
	};
	for (const [mcode, m] of Object.entries(menus)) walk(m, `menus → ${mcode}`);

	// ── 4. Role rights keyed on real objects ──
	const roles = readJsonOrDefault<Record<string, Record<string, unknown>>>(paths.roles, {});
	const actions = readJsonOrDefault<Record<string, unknown>>(paths.actions, {});
	const reports = readJsonOrDefault<Record<string, unknown>>(paths.reports, {});
	for (const [rcode, r] of Object.entries(roles)) {
		const rights = (r.rights as Record<string, string> | undefined) ?? {};
		for (const key of Object.keys(rights)) {
			if (key.startsWith("action:")) {
				const a = key.slice("action:".length);
				if (!(a in actions)) err(`roles → ${rcode}`, `grants on 'action:${a}' but no such action exists`);
			} else if (key.startsWith("report:")) {
				const rp = key.slice("report:".length);
				if (!(rp in reports)) err(`roles → ${rcode}`, `grants on 'report:${rp}' but no such report exists`);
			} else if (key.startsWith("folder:")) {
				// folder existence lives in folders.json's tree — skip (soft)
			} else if (!key.includes(".")) {
				if (!(key in entities)) err(`roles → ${rcode}`, `grants on entity '${key}' but no such entity in this module`);
			}
			// dotted key → cross-module entity; ownership is the other module's — skip
		}
	}

	// ── 5. Security coverage (every entity needs a Select grant) ──
	try {
		const { uncoveredEntities } = checkSecurityCoverage(args.moduleDir);
		for (const e of uncoveredEntities) {
			warn("security", `entity '${e}' has no role granting Select (S) — it will be inaccessible`);
		}
	} catch {
		/* roles file unreadable — already covered above */
	}

	// ── Result ──
	const errors = issues.filter((i) => i.level === "error");
	const warnings = issues.filter((i) => i.level === "warning");
	const clean = errors.length === 0 && warnings.length === 0;
	const summary = clean
		? `✓ ${manifest.code}: no cross-reference issues found across ${Object.keys(entities).length} entities, ${viewCodes.size} views, ${Object.keys(roles).length} roles.`
		: `${manifest.code}: ${errors.length} error(s), ${warnings.length} warning(s).${errors.length ? ` First error: ${errors[0].where} — ${errors[0].message}` : ""}`;

	return {
		summary,
		files: {
			"_validate.json": JSON.stringify({ ok: errors.length === 0, errors, warnings }, null, "\t") + "\n",
		},
		warning: errors.length
			? `${errors.length} validation error(s) — fix before dforge_module_pack / dforge_module_install. Details in _validate.json.`
			: undefined,
	};
}
