// Pre-flight whole-module validator. Read-only: loads every file and runs the
// CROSS-REFERENCE checks that per-tool validation can't see — the errors that
// otherwise only surface at pack/install (a slow, tenant-bound round trip).
//
// Catches: dangling FK/reference targets, the hidden-FK column missing for a
// Reference, view dataSources/columns pointing at unknown entities/fields, a
// grid-style view over an entity with no visible column, menu dataViewCode →
// missing view, role rights keyed on unknown entities/actions/reports, and
// entities with no Select grant. Returns a structured issue list in
// `_validate.json` plus a one-line summary; never writes anything.

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

// View types whose rendering doesn't consume the entity's visible scalar columns,
// so an empty visible-column set is not an error for them. Mirrors the server's
// DataViewVisibleColumnValidator.ColumnAgnosticViewTypes and the frontend view
// registrations that set hasFieldsPanel:false.
const COLUMN_AGNOSTIC_VIEW_TYPES = new Set(["diagram", "matrix", "library"]);

/**
 * True when a merged field-def map has at least one VISIBLE SCALAR column — a
 * field whose `flags` string includes `'V'` and whose `columnType` is not a set
 * (`'S'`). Mirrors the frontend's `visibleScalarColumns` empty-state check that
 * the server's DataViewVisibleColumnValidator enforces.
 */
function hasVisibleScalarColumn(fields: Record<string, Record<string, unknown>>): boolean {
	for (const f of Object.values(fields)) {
		if (!f || typeof f !== "object") continue;
		const flags = typeof f.flags === "string" ? f.flags : "";
		if (flags.includes("V") && f.columnType !== "S") return true;
	}
	return false;
}

/**
 * Case-insensitively resolve `translations/<locale>.json` — a `de-de.json` file
 * satisfies a `de-DE` supported locale (matching the server's case-insensitive
 * translation lookup). Returns the absolute path, or undefined if none exists.
 */
function resolveTranslationFile(translationsDir: string, locale: string): string | undefined {
	const exact = path.join(translationsDir, `${locale}.json`);
	if (fs.existsSync(exact)) return exact;
	if (!fs.existsSync(translationsDir)) return undefined;
	const want = `${locale}.json`.toLowerCase();
	for (const f of fs.readdirSync(translationsDir)) {
		if (f.toLowerCase() === want) return path.join(translationsDir, f);
	}
	return undefined;
}

/**
 * True when the locale JSON carries a non-empty
 * `entities.<entityCd>.constraints.<constraintCd>.message`.
 */
function hasConstraintOverride(
	root: Record<string, unknown> | null,
	entityCd: string,
	constraintCd: string,
): boolean {
	if (!root || typeof root !== "object") return false;
	const entities = (root as { entities?: unknown }).entities;
	if (!entities || typeof entities !== "object") return false;
	const entity = (entities as Record<string, unknown>)[entityCd];
	if (!entity || typeof entity !== "object") return false;
	const constraints = (entity as { constraints?: unknown }).constraints;
	if (!constraints || typeof constraints !== "object") return false;
	const ck = (constraints as Record<string, unknown>)[constraintCd];
	if (!ck || typeof ck !== "object") return false;
	const msg = (ck as { message?: unknown }).message;
	return typeof msg === "string" && msg.trim() !== "";
}

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
	// Merged field defs per entity (authored fields override trait-contributed
	// ones on key collision) — mirrors the server running the visible-column
	// check AFTER trait expansion, so a trait's 'V' field counts.
	const fieldDefsOf: Record<string, Record<string, Record<string, unknown>>> = {};

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
		const fields = (e.fields as Record<string, Record<string, unknown>> | undefined) ?? {};
		const cols = new Set<string>(Object.keys(fields));
		let traitFields: Record<string, Record<string, unknown>> = {};
		const traits = (e.traits as string[] | undefined) ?? [];
		try {
			traitFields = expandTraits(traits, name) as Record<string, Record<string, unknown>>;
			for (const c of Object.keys(traitFields)) cols.add(c);
		} catch {
			/* unknown trait — surfaced separately by add-time validation */
		}
		columnsOf[name] = cols;
		// Trait fields first, authored fields last so an authored override wins.
		fieldDefsOf[name] = { ...traitFields, ...fields };
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

	// ── 2b. Data view renders a field grid over an entity with no visible column ──
	// Mirrors the server's DataViewVisibleColumnValidator: a grid-style view over
	// an own-module entity that has no VISIBLE SCALAR column (a field whose flags
	// include 'V' and whose columnType isn't a set 'S') renders the runtime empty
	// state "No visible columns configured for this entity." Column-agnostic view
	// types (diagram/matrix/library — hasFieldsPanel:false) are exempt. Cross-module
	// entities can't be inspected offline, so they're skipped. Erroring here catches
	// it before the slow pack/install round trip.
	const vcSeen = new Set<string>();
	for (const [vcode, v] of Object.entries(views)) {
		const sources = (v.dataSources as Array<Record<string, unknown>> | undefined) ?? [];
		if (sources.length === 0) continue;
		// viewType defaults to grid (a checked type) when unset.
		const viewType = (v.viewType as string | undefined) ?? "grid";
		if (COLUMN_AGNOSTIC_VIEW_TYPES.has(viewType)) continue;
		for (const s of sources) {
			const ent = s.entityCode as string | undefined;
			if (!ent) continue;
			const defs = fieldDefsOf[ent]; // undefined for system/cross-module entities — skip
			if (!defs) continue;
			if (hasVisibleScalarColumn(defs)) continue;
			const key = `${vcode}\u0000${ent}`;
			if (vcSeen.has(key)) continue;
			vcSeen.add(key);
			err(
				`data_views → ${vcode}`,
				`view (${viewType}) renders entity '${ent}', which has no visible column — mark at least one of its fields visible with the 'V' flag (set columns / columnType 'S' don't count for a grid)`,
			);
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
			} else if (!isKnownEntity(key)) {
				// An entity rights key: same-module, a system entity (user, document,
				// …), or a declared cross-module dependency. Reuse the same resolver
				// as FK targets so system/cross-module grants don't false-error.
				err(`roles → ${rcode}`, `grants rights on '${key}', which is not a known entity (same-module, system, or a declared cross-module dependency)`);
			}
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

	// ── 6. Constraint messages lacking a translation for a declared locale ──
	// Mirrors the server's install-time UntranslatedConstraint scan (opt-in on
	// supportedLocales; the base message is always the fallback, so this is a
	// warning, never an error). English is authoritative and never warned;
	// extension entities are skipped (their translations belong with the foreign
	// module). Surfacing it here catches the gap before the slow install round trip.
	const supportedLocales = Array.isArray(manifest.supportedLocales)
		? (manifest.supportedLocales as unknown[]).filter((l): l is string => typeof l === "string")
		: [];
	if (supportedLocales.length > 0) {
		// (entity, constraint, base message) for every constraint that declares one.
		const declared: Array<{ entity: string; constraint: string; message: string }> = [];
		for (const [name, e] of Object.entries(entities)) {
			// Extension entities add constraints to another module's entity; the
			// translation for those lives with the foreign module's files.
			if (typeof e.extends === "string" && e.extends) continue;
			const constraints = e.constraints as Record<string, unknown> | undefined;
			if (!constraints || typeof constraints !== "object") continue;
			for (const [cname, c] of Object.entries(constraints)) {
				if (!c || typeof c !== "object") continue;
				const msg = (c as Record<string, unknown>).message;
				if (typeof msg === "string" && msg.trim() !== "") {
					declared.push({ entity: name, constraint: cname, message: msg });
				}
			}
		}

		if (declared.length > 0) {
			const seen = new Set<string>();
			for (const raw of supportedLocales) {
				const locale = raw.trim();
				if (!locale) continue;
				// English is the base/fallback — translation files are non-English only.
				const lc = locale.toLowerCase();
				if (lc === "en" || lc.startsWith("en-")) continue;
				if (seen.has(lc)) continue;
				seen.add(lc);

				// Resolve the locale file case-insensitively (a de-de.json satisfies
				// a de-DE locale). Absent or malformed → every override is missing.
				let tx: Record<string, unknown> | null = null;
				const abs = resolveTranslationFile(paths.translationsDir, locale);
				if (abs) {
					try {
						tx = JSON.parse(fs.readFileSync(abs, "utf8")) as Record<string, unknown>;
					} catch {
						tx = null;
					}
				}

				for (const d of declared) {
					if (!hasConstraintOverride(tx, d.entity, d.constraint)) {
						warn(
							`translations/${locale}.json`,
							`constraint message '${d.entity}.constraints.${d.constraint}.message' has no ${locale} override — the base message ("${d.message}") will be used as the fallback. Add entities.${d.entity}.constraints.${d.constraint}.message to localize it.`,
						);
					}
				}
			}
		}
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
