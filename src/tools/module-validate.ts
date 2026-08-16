// Pre-flight whole-module validator. Read-only: loads every file and runs the
// CROSS-REFERENCE checks that per-tool validation can't see — the errors that
// otherwise only surface at pack/install (a slow, tenant-bound round trip).
//
// Catches: dangling FK/reference targets, the hidden-FK column missing for a
// Reference, view dataSources/columns pointing at unknown entities/fields, a
// grid-style view over an entity with no visible column, menu dataViewCode →
// missing view, role rights keyed on unknown entities/actions/reports, record-report
// attachments (param declared, entity known, source column mappable), and
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
	duplicateFolderCodes,
	compositeKey,
	unknownTraits,
	TRAIT_CODES,
	type ToolResult,
} from "./_helpers";
import { checkFieldSpec, parseSetAggregate } from "./field-rules";
import { checkDsl } from "./dsl-check";

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
		// An unknown trait code is NOT an exception — expandTraits silently
		// returns only the codes it recognized, so the trait's columns just
		// vanish and every later check reads them as "not a column". Flag the
		// cause rather than the symptoms. (The authoring tools validate trait
		// codes via `traitsInput`; this catches imports and hand edits.)
		const traits = (e.traits as string[] | undefined) ?? [];
		const badTraits = unknownTraits(traits);
		if (badTraits.length > 0) {
			err(
				`entities/${name}.json`,
				`declares unknown trait(s): ${badTraits.join(", ")}. Valid: ${TRAIT_CODES.join(", ")}. ` +
					"An unrecognized trait is ignored when columns are expanded, so its columns are missing " +
					"from this entity — expect knock-on 'not a column' errors below.",
			);
		}
		const traitFields = expandTraits(traits, name) as Record<string, Record<string, unknown>>;
		for (const c of Object.keys(traitFields)) cols.add(c);
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
			const key = compositeKey(vcode, ent);
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

	// ── 7. Field-spec rules, module-wide ──
	// The same rules the entity_field_add/_modify zod schema enforces, re-run
	// over every field of every entity. Fields that entered via module_import /
	// dbml_import / the CLI scaffolder / a hand edit never passed through that
	// schema, so this is the only place those get checked before install.
	for (const [name, e] of Object.entries(entities)) {
		const fields = (e.fields as Record<string, Record<string, unknown>> | undefined) ?? {};
		for (const [fname, f] of Object.entries(fields)) {
			for (const issue of checkFieldSpec(`${name}.${fname}`, f)) {
				issues.push({ level: issue.level, where: `entities/${name}.json`, message: issue.message });
			}
		}
	}

	// ── 8. Every entity needs a toString, and its {braces} must resolve ──
	// The platform renders a record's display label from this template; a
	// missing one leaves lookups showing raw PKs. Extension entities inherit
	// the base entity's template (toString: null is the documented form).
	// NOTE: read it as an OWN property — `toString` is inherited from
	// Object.prototype, so `e.toString` is a function, never undefined.
	for (const [name, e] of Object.entries(entities)) {
		const isExtension = typeof e.extends === "string" && e.extends.length > 0;
		const ts: unknown = Object.prototype.hasOwnProperty.call(e, "toString")
			? e.toString
			: undefined;
		if (ts === undefined || ts === null || (typeof ts === "string" && ts.trim() === "")) {
			// A missing template degrades display (lookups show raw PKs) but does
			// not block install — warn rather than error.
			if (!isExtension) {
				warn(
					`entities/${name}.json`,
					"has no 'toString' template — every entity should have one, e.g. \"toString\": \"{name}\" (extension entities use null to inherit the base).",
				);
			}
			continue;
		}
		if (typeof ts !== "string") {
			err(`entities/${name}.json`, `'toString' must be a string template, got ${typeof ts}.`);
			continue;
		}
		const braces = [...ts.matchAll(/\{([a-z][a-z0-9_]*)\}/gi)].map((m) => m[1]);
		if (braces.length === 0) {
			warn(
				`entities/${name}.json`,
				`'toString' is "${ts}" with no {column} placeholder — every record will render the same label.`,
			);
		}
		for (const b of braces) {
			if (!columnsOf[name].has(b)) {
				err(
					`entities/${name}.json`,
					`'toString' references {${b}}, which is not a column on '${name}'.`,
				);
			}
		}
	}

	// ── 9. Set aggregates: must be Generated, over a PHYSICAL child column ──
	// Two documented install-blockers in one place. An 'F' set-aggregate is
	// unsupported and silently renders empty; a 'G' aggregate over a virtual
	// (F/R/S) child fails install with `column old.<field> does not exist`.
	for (const [name, e] of Object.entries(entities)) {
		const fields = (e.fields as Record<string, Record<string, unknown>> | undefined) ?? {};
		for (const [fname, f] of Object.entries(fields)) {
			const formula = typeof f?.formula === "string" ? f.formula : "";
			if (!formula) continue;
			const agg = parseSetAggregate(formula);
			if (!agg) continue;
			const where = `entities/${name}.json → ${fname}`;

			if (f.columnType === "F") {
				err(
					where,
					`is a Formula ('F') column with a set aggregate ${agg.agg}([${agg.setField}].[${agg.childField}]) — ` +
						"an F set-aggregate is unsupported and silently renders empty. Use a Generated ('G') column " +
						"with dbDatatype + formula instead. (See dforge://reference/column-types.)",
				);
				continue;
			}
			if (f.columnType !== "G") continue;

			// Resolve the set column → child entity → aggregated child column.
			const setCol = fields[agg.setField] ?? fieldDefsOf[name]?.[agg.setField];
			if (!setCol) {
				err(where, `aggregates over '[${agg.setField}]', which is not a column on '${name}'.`);
				continue;
			}
			if (setCol.columnType !== "S") {
				warn(
					where,
					`aggregates over '[${agg.setField}]', which is not a set column (columnType 'S') on '${name}'.`,
				);
				continue;
			}
			const childEntity = (setCol.link as Record<string, unknown> | undefined)?.entity as
				| string
				| undefined;
			if (!childEntity) continue;
			const childDefs = fieldDefsOf[childEntity];
			if (!childDefs) continue; // cross-module / system child — can't inspect offline
			const childCol = childDefs[agg.childField];
			if (!childCol) {
				err(
					where,
					`aggregates '[${agg.setField}].[${agg.childField}]' but '${agg.childField}' is not a column on child entity '${childEntity}'.`,
				);
				continue;
			}
			const childType = typeof childCol.columnType === "string" ? childCol.columnType : "D";
			if (childType === "F" || childType === "R" || childType === "S") {
				err(
					where,
					`aggregates '[${agg.setField}].[${agg.childField}]', but '${childEntity}.${agg.childField}' is a ` +
						`virtual '${childType}' column. A Generated aggregate reads the child's PHYSICAL column — install fails ` +
						`with \`column old.${agg.childField} does not exist\`. Aggregate a 'D' (or same-row 'G') child column instead.`,
				);
			}
		}
	}

	// ── 10. Actions: DSL file on disk + a real target entity ──
	// `script` is a BARE filename; the installer resolves it to
	// logic/actions/<script>.dsl. A typo here surfaces only at install as
	// "action script not found".
	for (const [acode, a] of Object.entries(actions)) {
		const act = (a ?? {}) as Record<string, unknown>;
		const where = `actions → ${acode}`;
		const script = typeof act.script === "string" ? act.script : "";
		if (!script) {
			err(where, "has no 'script' — it must be the bare DSL filename (no path, no .dsl extension).");
		} else if (script.includes("/") || script.includes("\\") || script.endsWith(".dsl")) {
			err(
				where,
				`script '${script}' must be a BARE filename — no path, no '.dsl' extension (e.g. "script": "${script
					.replace(/\.dsl$/, "")
					.split(/[\\/]/)
					.pop()}").`,
			);
		} else if (!fs.existsSync(path.join(paths.logicDir, "actions", `${script}.dsl`))) {
			err(where, `script '${script}' has no file at logic/actions/${script}.dsl.`);
		}
		const ent = (act.entityCode ?? act.entity) as string | undefined;
		if (ent && !isKnownEntity(ent)) {
			err(where, `targets entity '${ent}', which is not a known entity.`);
		}
	}

	// ── 11. Triggers / jobs / webhooks reference real actions + entities ──
	// A trigger or job naming an action that doesn't exist compiles fine
	// offline and fails at install. Cross-module dotted action codes are
	// accepted when the module prefix is a declared dependency.
	const isKnownAction = (code: string): boolean => {
		if (code in actions) return true;
		const dot = code.indexOf(".");
		if (dot > 0) {
			const mod = code.slice(0, dot);
			return deps.has(mod) || mod === manifest.code;
		}
		return false;
	};

	const triggerFile = readJsonOrDefault<{ triggers?: Array<Record<string, unknown>> }>(
		paths.triggers,
		{},
	);
	for (const t of triggerFile.triggers ?? []) {
		const where = `triggers → ${String(t.code ?? "?")}`;
		const act = t.action as string | undefined;
		if (act && !isKnownAction(act)) {
			err(where, `fires action '${act}', which is not in ui/actions.json (add it with dforge_action_add first).`);
		}
		const ent = t.entity as string | undefined;
		if (ent && !isKnownEntity(ent)) err(where, `is bound to entity '${ent}', which is not a known entity.`);
	}

	const jobFile = readJsonOrDefault<{ jobs?: Array<Record<string, unknown>> }>(paths.jobs, {});
	for (const j of jobFile.jobs ?? []) {
		const where = `jobs → ${String(j.code ?? "?")}`;
		const act = j.action as string | undefined;
		if (act && !isKnownAction(act)) {
			err(where, `schedules action '${act}', which is not in ui/actions.json.`);
		}
		// A scheduled job runs as the system user with NO current record, so the
		// action it fires must not use record-context `[field]` syntax.
		if (act && act in actions) {
			const script = (actions[act] as Record<string, unknown> | undefined)?.script;
			if (typeof script === "string") {
				const dslPath = path.join(paths.logicDir, "actions", `${script}.dsl`);
				if (fs.existsSync(dslPath)) {
					let body = "";
					try {
						body = fs.readFileSync(dslPath, "utf8");
					} catch {
						/* unreadable — the missing-file check above already reported it */
					}
					for (const issue of checkDsl(body, { viaJob: true })) {
						if (issue.rule !== "job-record-context") continue;
						issues.push({ level: issue.level, where, message: issue.message });
					}
				}
			}
		}
	}

	const webhookFile = readJsonOrDefault<{ subscriptions?: Array<Record<string, unknown>> }>(
		paths.webhooks,
		{},
	);
	for (const w of webhookFile.subscriptions ?? []) {
		const ent = w.entity as string | undefined;
		if (ent && !isKnownEntity(ent)) {
			err(`webhooks → ${String(w.code ?? "?")}`, `is bound to entity '${ent}', which is not a known entity.`);
		}
	}

	// ── 12. Action DSL static checks ──
	// The DSL only compiles at install (a slow, tenant-bound round trip), so
	// run the statically-decidable subset here. See ./dsl-check.
	for (const [acode, a] of Object.entries(actions)) {
		const script = (a as Record<string, unknown> | undefined)?.script;
		if (typeof script !== "string" || !script) continue;
		const dslPath = path.join(paths.logicDir, "actions", `${script}.dsl`);
		if (!fs.existsSync(dslPath)) continue; // reported by check 10
		let body: string;
		try {
			body = fs.readFileSync(dslPath, "utf8");
		} catch {
			continue;
		}
		const mode = ((a as Record<string, unknown>).executionMode ?? (a as Record<string, unknown>).mode) as
			| string
			| undefined;
		for (const issue of checkDsl(body, { executionMode: mode })) {
			issues.push({
				level: issue.level,
				where: `logic/actions/${script}.dsl`,
				message: `[${acode}] ${issue.message}`,
			});
		}
	}

	// ── 12b. Folder codes are unique across the whole tree ──
	// A folder is referenced flat and path-less — `folder:<code>` in role rights,
	// `folders.<code>.label` in translations — so the same code in two branches
	// makes the rights grant ambiguous and lets one folder's label overwrite the
	// other's. Nesting alone doesn't namespace them.
	const folderRoot = readJsonOrDefault<Record<string, unknown>>(paths.folders, {});
	for (const [code, dupPaths] of duplicateFolderCodes(folderRoot)) {
		err(
			"ui/folders.json",
			`folder code '${code}' is used ${dupPaths.length} times (${dupPaths.join(", ")}). Codes must be ` +
				`unique across the whole tree: role rights say 'folder:${code}' with no path, and translations key ` +
				`on 'folders.${code}.label', so duplicates are ambiguous and silently collide.`,
		);
	}

	// ── 12c. Reports: param declaration site + record-report attachments ──
	// Mirrors the server's ReportAttachmentValidator, which is the pack-time half
	// of the check ReportRegistrar runs at install. Everything here is resolvable
	// offline, and every failure mode is SILENT at runtime rather than loud.
	for (const [rcode, rawReport] of Object.entries(reports)) {
		const report = (rawReport ?? {}) as Record<string, unknown>;
		const where = `ui/reports.json → ${rcode}`;

		// Params are REPORT-scoped: the installer merges the report-level
		// `parameters` block with every dataset's `params` into one param_set,
		// report level winning on a code collision. Mirror that merge here so a
		// record-report mapping resolves against the same set install will build.
		const declaredParams = new Set<string>();

		const checkParamDef = (loc: string, pcode: string, pdef: unknown) => {
			const p = (pdef ?? {}) as Record<string, unknown>;
			if ("isRequired" in p) {
				err(
					`${where} → ${loc}.${pcode}`,
					"uses 'isRequired', which the installer does not read — the param installs as OPTIONAL. Rename it to 'required'.",
				);
			}
			if ("link" in p) {
				err(
					`${where} → ${loc}.${pcode}`,
					"puts 'link' at the top level, where the installer does not read it — a lookup param with no `params.link` has no autocomplete. Nest it: \"params\": { \"link\": { \"entity\": \"…\" } }.",
				);
			}
			if ("fieldTypeCd" in p && "domain" in p) {
				err(
					`${where} → ${loc}.${pcode}`,
					"declares both 'fieldTypeCd' and 'domain' — install rejects the pair rather than picking a winner. A domain supplies the control; drop the fieldTypeCd.",
				);
			}
		};

		const reportParams = (report.parameters as Record<string, unknown> | undefined) ?? {};
		for (const [pcode, pdef] of Object.entries(reportParams)) {
			declaredParams.add(pcode);
			checkParamDef("parameters", pcode, pdef);
		}

		const datasets = (report.datasets as Record<string, Record<string, unknown>> | undefined) ?? {};
		for (const [dcode, ds] of Object.entries(datasets)) {
			const dsParams = (ds?.params as Record<string, Record<string, unknown>> | undefined) ?? {};
			for (const [pcode, pdef] of Object.entries(dsParams)) {
				declaredParams.add(pcode);
				checkParamDef(`datasets.${dcode}.params`, pcode, pdef);
			}
		}

		const attachments = report.entities;
		if (attachments === undefined) continue;
		if (!Array.isArray(attachments)) {
			err(where, "'entities' must be an array of record-report attachments.");
			continue;
		}

		const seen = new Set<string>();
		for (const raw of attachments) {
			const att = (raw ?? {}) as Record<string, unknown>;
			const entityCd = att.entityCd;
			if (typeof entityCd !== "string" || entityCd.trim() === "") {
				err(where, "an entry in 'entities' is missing 'entityCd'.");
				continue;
			}

			// Own-module prefix is redundant: 'crm.quote' inside crm is 'quote'.
			const bare =
				entityCd.startsWith(`${manifest.code}.`) ? entityCd.slice(manifest.code.length + 1) : entityCd;

			// UQ_Entity_Report is (entity_id, report_id): a second entry for the
			// same entity is not a second attachment, it overwrites the first's
			// param_map through the installer's ON CONFLICT upsert.
			if (seen.has(bare)) {
				err(
					where,
					`attaches to '${entityCd}' twice. One attachment per (entity, report) pair — merge the two 'params' maps into a single entry.`,
				);
				continue;
			}
			seen.add(bare);

			if (!isKnownEntity(entityCd)) {
				err(
					where,
					`attaches to '${entityCd}', which is not a known entity (same-module, system, or a declared cross-module dependency). Qualify a foreign entity as 'module.entity' and add that module to the manifest's dependencies.`,
				);
			}

			const paramMap = (att.params as Record<string, unknown> | undefined) ?? {};
			for (const [paramCd, source] of Object.entries(paramMap)) {
				if (!declaredParams.has(paramCd)) {
					err(
						where,
						`maps '${paramCd}' from '${entityCd}.${String(source)}', but '${paramCd}' is not a declared parameter of this report. Declare it in the report's 'parameters' block, or under the 'params' of the dataset that consumes it.`,
					);
					continue;
				}
				if (typeof source !== "string" || source.trim() === "") {
					err(where, `maps parameter '${paramCd}' from an empty source column on '${entityCd}'.`);
					continue;
				}
				// Column-level checks only where this module owns the entity —
				// a cross-module target's columns aren't visible offline, so those
				// fall through to install (same convention as FK targets above).
				const fields = fieldDefsOf[bare];
				if (!fields) continue;
				const col = fields[source];
				if (!col) {
					err(
						where,
						`maps parameter '${paramCd}' from '${entityCd}.${source}', which is not a column of that entity.`,
					);
					continue;
				}
				if (col.columnType === "S" || col.columnType === "F") {
					err(
						where,
						`maps parameter '${paramCd}' from '${entityCd}.${source}', a ${col.columnType === "S" ? "set ('S')" : "formula ('F')"} column. Map the PK, a reference ('R') column, or a bounded scalar.`,
					);
					continue;
				}
				// Free text / json / binary are rejected by the installer's source
				// allowlist — a poor param source, and a runtime surprise if let through.
				const db = typeof col.dbDatatype === "string" ? col.dbDatatype.toLowerCase() : "";
				if (col.columnType !== "R" && col.isPk !== true && /^(text|json|jsonb|bytea|uuid)$/.test(db)) {
					err(
						where,
						`maps parameter '${paramCd}' from '${entityCd}.${source}' (dbDatatype '${db}'), which is not a valid record-report parameter source. Allowed: the entity PK, a reference column, or a bounded scalar (number, date/datetime, bool, dropdown/radio/flags code).`,
					);
				}
			}
		}

		if (seen.size > 0 && !deps.has("metadata")) {
			warn(
				where,
				"declares record-report attachments but the manifest has no 'metadata' dependency. The 'entity_report' table ships with the metadata system module — add \"metadata\": \">=1.5.0\" to dependencies so install fails loudly on a platform without it, rather than the attachment quietly doing nothing.",
			);
		}
	}

	// ── 13. Translation completeness ──
	// `TranslationCompletenessValidator` requires a `roles.<code>.label` for
	// EVERY role in security/roles.json, in EVERY translation file — including
	// the en-US base. A missing one fails install with `Label for role '<code>'.`
	// Also: every locale in supportedLocales must have a matching file.
	const roleCodes = Object.keys(roles);
	const localeFiles = fs.existsSync(paths.translationsDir)
		? fs
				.readdirSync(paths.translationsDir)
				.filter((f) => f.toLowerCase().endsWith(".json"))
				.sort()
		: [];

	for (const raw of supportedLocales) {
		const locale = raw.trim();
		if (!locale) continue;
		if (!resolveTranslationFile(paths.translationsDir, locale)) {
			err(
				"translations",
				`manifest.supportedLocales lists '${locale}' but translations/${locale}.json does not exist — install fails translation completeness validation.`,
			);
		}
	}

	if (roleCodes.length > 0 && localeFiles.length === 0) {
		warn(
			"translations",
			`no translations/ files — ship at least translations/en-US.json with a roles block (a 'label' for each of: ${roleCodes.join(", ")}); role labels are completeness-enforced at install.`,
		);
	}

	for (const file of localeFiles) {
		let tx: Record<string, unknown>;
		try {
			tx = JSON.parse(fs.readFileSync(path.join(paths.translationsDir, file), "utf8"));
		} catch (ex) {
			err(`translations/${file}`, `invalid JSON: ${(ex as Error).message}`);
			continue;
		}
		const txRoles = (tx.roles as Record<string, unknown> | undefined) ?? {};
		const missing = roleCodes.filter((rc) => {
			const entry = txRoles[rc] as Record<string, unknown> | undefined;
			return !entry || typeof entry.label !== "string" || entry.label.trim() === "";
		});
		if (missing.length > 0) {
			err(
				`translations/${file}`,
				`missing roles.<code>.label for: ${missing.join(", ")} — completeness is enforced in every locale (including en-US); install fails with "Label for role '<code>'."`,
			);
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
