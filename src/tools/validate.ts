// Pre-install module validator. Runs the full validation checklist against
// the module on disk and returns a structured report without modifying any
// files. Call this before dforge_module_pack / dforge_module_install to
// surface errors early.

import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import {
	loadManifest,
	readJsonOrDefault,
	RIGHTS_PATTERN,
	FIELD_TYPE_CODES,
	type Manifest,
	type ModulePaths,
} from "./_helpers";

// ── Types ────────────────────────────────────────────────────────────

interface Issue {
	level: "error" | "warning";
	tag: string;
	message: string;
}

interface ValidateResult {
	summary: string;
	errors: number;
	warnings: number;
	issues: Issue[];
}

// ── Helpers ──────────────────────────────────────────────────────────

function err(tag: string, message: string): Issue {
	return { level: "error", tag, message };
}

function warn(tag: string, message: string): Issue {
	return { level: "warning", tag, message };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEMVER_RE = /^\d+\.\d+\.\d+(-[\w.]+)?$/;
const CODE_RE = /^[a-z][a-z0-9_-]*$/;

// ── Manifest checks ──────────────────────────────────────────────────

function checkManifest(manifest: Manifest, paths: ModulePaths): Issue[] {
	const issues: Issue[] = [];

	if (!manifest.packageFormat) issues.push(err("manifest", "packageFormat is missing or zero."));
	if (!manifest.moduleId) {
		issues.push(err("manifest", "moduleId is missing."));
	} else if (!UUID_RE.test(manifest.moduleId)) {
		issues.push(err("manifest", `moduleId '${manifest.moduleId}' is not a valid UUID.`));
	}
	if (!manifest.code) {
		issues.push(err("manifest", "code is missing."));
	} else if (!CODE_RE.test(manifest.code)) {
		issues.push(err("manifest", `code '${manifest.code}' must be lowercase letters, digits, underscores, or hyphens.`));
	}
	if (!manifest.version) {
		issues.push(err("manifest", "version is missing."));
	} else if (!SEMVER_RE.test(manifest.version)) {
		issues.push(err("manifest", `version '${manifest.version}' is not valid semver.`));
	}
	if (!manifest.dbSchemaVersion) {
		issues.push(err("manifest", "dbSchemaVersion is missing."));
	} else if (!SEMVER_RE.test(manifest.dbSchemaVersion)) {
		issues.push(err("manifest", `dbSchemaVersion '${manifest.dbSchemaVersion}' is not valid semver.`));
	}
	if (!manifest.displayName) issues.push(err("manifest", "displayName is missing."));
	if (!manifest.description) issues.push(warn("manifest", "description is missing."));

	// Check every entity file pointer exists on disk
	for (const [code, filePath] of Object.entries(manifest.entities ?? {})) {
		const abs = path.resolve(paths.root, filePath);
		if (!fs.existsSync(abs)) {
			issues.push(err(`manifest:entity:${code}`, `Entity file '${filePath}' does not exist on disk.`));
		}
	}

	// Warn if admin dependency is absent
	const deps = manifest.dependencies ?? {};
	if (!Object.prototype.hasOwnProperty.call(deps, "admin")) {
		issues.push(warn("manifest:dependencies", "No dependency on 'admin' module — add it unless this module is intentionally standalone."));
	}

	return issues;
}

// ── Entity checks ────────────────────────────────────────────────────

const TRAIT_COLUMNS: Record<string, string[]> = {
	"audit":       ["created_date", "last_updated"],
	"audit-full":  ["created_date", "last_updated", "created_by", "created_by_user",
	               "last_updated_by", "last_updated_by_user"],
	"soft-delete": ["active"],
	"sorting":     ["order_num"],
	"period":      ["period_key", "description", "closed", "start_date", "end_date"],
};

// Virtual column types carry no physical DB column of their own (metadata only).
// A Reference/Set/Formula field must never be the place an FK integer/uuid lives —
// the physical column is always a separate Data field.
const VIRTUAL_COLUMN_TYPES = new Set(["R", "S", "F"]);
const COLUMN_TYPE_NAME: Record<string, string> = { R: "Reference", S: "Set", F: "Formula" };

function checkEntities(manifest: Manifest, paths: ModulePaths): {
	issues: Issue[];
	fieldsByEntity: Map<string, Set<string>>;
} {
	const issues: Issue[] = [];
	const fieldsByEntity = new Map<string, Set<string>>();

	for (const [code, filePath] of Object.entries(manifest.entities ?? {})) {
		const abs = path.resolve(paths.root, filePath);
		if (!fs.existsSync(abs)) continue; // already reported in checkManifest

		let entity: Record<string, unknown>;
		try {
			entity = JSON.parse(fs.readFileSync(abs, "utf8")) as Record<string, unknown>;
		} catch {
			issues.push(err(`entity:${code}`, `Cannot parse entity file '${filePath}' as JSON.`));
			continue;
		}

		if (!entity.description) issues.push(warn(`entity:${code}`, "Missing 'description' field."));
		if (!entity.dbObject) issues.push(err(`entity:${code}`, "Missing 'dbObject' field."));
		if (!entity.toString) issues.push(err(`entity:${code}`, "Missing 'toString' template."));
		if (!entity.traits) issues.push(warn(`entity:${code}`, "No 'traits' defined — identity + audit traits are expected on most entities."));

		const fields = (entity.fields ?? {}) as Record<string, Record<string, unknown>>;
		const fieldCodes = new Set<string>();
		const orderNums = new Set<number>();

		const entityTraits = (entity.traits as string[] | undefined) ?? [];
		const traitColumnOf = new Map<string, string>();
		for (const t of entityTraits) {
			for (const col of TRAIT_COLUMNS[t] ?? []) traitColumnOf.set(col, t);
			if (t === "identity" && typeof entity.dbObject === "string")
				traitColumnOf.set(`${entity.dbObject}_id`, "identity");
		}

		for (const [fCode, fDef] of Object.entries(fields)) {
			if (fieldCodes.has(fCode)) {
				issues.push(err(`entity:${code}`, `Duplicate column code '${fCode}'.`));
			}
			fieldCodes.add(fCode);

			if (traitColumnOf.has(fCode)) {
				issues.push(err(
					`entity:${code}:field:${fCode}`,
					`Field '${fCode}' is already provided by the '${traitColumnOf.get(fCode)!}' trait. Remove this definition — the trait injects it automatically. Redefining it causes install-time errors and engine crashes.`,
				));
			}

			const flags = fDef.flags as string | undefined;
			if (flags && flags.includes("I") && /[VEM]/.test(flags)) {
				issues.push(err(
					`entity:${code}:field:${fCode}`,
					`Field '${fCode}' has invalid flag combination '${flags}': 'I' (Internal) must not be combined with 'V', 'E', or 'M'. Internal fields are platform-managed and not user-facing. For a user-editable required field use 'VEM'.`,
				));
			}

			if (entityTraits.length > 0 && fDef.isNullable === false) {
				issues.push(warn(
					`entity:${code}:field:${fCode}`,
					`Field '${fCode}' has 'isNullable: false' on an entity that uses traits. This can trigger a circular getter crash in the dForge engine. Remove 'isNullable: false' and use the 'M' flag for mandatory enforcement instead.`,
				));
			}

			const columnType = fDef.columnType as string | undefined;

			// Virtual columns (R/S/F) are metadata only — the platform creates no
			// physical DB column for them. Declaring dbDatatype here means the author
			// merged the physical FK and the logical relation into one field; the
			// physical column then never gets created (issue #6).
			if (columnType && VIRTUAL_COLUMN_TYPES.has(columnType) && fDef.dbDatatype) {
				issues.push(err(
					`entity:${code}:field:${fCode}`,
					`Field '${fCode}' is a ${COLUMN_TYPE_NAME[columnType]} column (columnType '${columnType}') but declares 'dbDatatype'. ${COLUMN_TYPE_NAME[columnType]} columns are virtual — the platform creates NO physical DB column for them. Put the physical column in a SEPARATE field (no columnType, with dbDatatype) and remove 'dbDatatype' here.`,
				));
			}

			// A Reference named like a physical FK (`*_id`) is the merged-field
			// anti-pattern from issue #6: the `_id` column is expected to be physical,
			// but columnType "R" makes it virtual, so queries on it fail with 42703.
			if (columnType === "R" && /_id$/.test(fCode)) {
				const refName = fCode.replace(/_id$/, "");
				issues.push(err(
					`entity:${code}:field:${fCode}`,
					`Field '${fCode}' is a Reference (columnType 'R') but its name ends in '_id' — by convention that is the PHYSICAL FK column. References are virtual, so no '${fCode}' column is created and runtime queries fail (PostgreSQL 42703 "column does not exist"). Use the two-column pattern: keep '${fCode}' as a physical FK (dbDatatype, no columnType) and add a separate reference '${refName}' with columnType 'R' and link.thisKey '${fCode}'.`,
				));
			}

			// Formula columns require baseDatatypeCd
			if (columnType === "F" && !fDef.baseDatatypeCd) {
				issues.push(err(`entity:${code}:field:${fCode}`, "Formula column missing 'baseDatatypeCd'."));
			}

			// Detect wrong-key pattern: LLMs sometimes embed the full C# FieldType object
			if (fDef.fieldType !== undefined) {
				const hint = typeof fDef.fieldType === "object" && fDef.fieldType !== null
					? " It looks like the full FieldType object was embedded — use the code string directly."
					: "";
				issues.push(err(
					`entity:${code}:field:${fCode}`,
					`Field '${fCode}' has a 'fieldType' key, which the platform ignores.${hint} The correct key is 'fieldTypeCd' with a plain string value, e.g. fieldTypeCd: "date".`,
				));
			}

			// Regular (non-formula, non-set, non-reference) columns need fieldTypeCd
			if (!columnType && !fDef.fieldTypeCd) {
				issues.push(err(`entity:${code}:field:${fCode}`, "Missing 'fieldTypeCd'. Every data column needs a fieldTypeCd string (e.g. \"date\", \"text\"). Without it the platform treats the field as untyped and saves will fail."));
			} else if (fDef.fieldTypeCd && !(FIELD_TYPE_CODES as readonly string[]).includes(fDef.fieldTypeCd as string)) {
				issues.push(err(`entity:${code}:field:${fCode}`, `Invalid fieldTypeCd '${fDef.fieldTypeCd as string}'. Must be one of: ${FIELD_TYPE_CODES.join(", ")}.`));
			}

			if (fDef.orderNum === undefined || fDef.orderNum === null) {
				issues.push(warn(`entity:${code}:field:${fCode}`, "Missing 'orderNum'."));
			} else {
				const n = fDef.orderNum as number;
				if (orderNums.has(n)) {
					issues.push(warn(`entity:${code}`, `Duplicate orderNum ${n} on field '${fCode}'.`));
				}
				orderNums.add(n);
			}
		}

		// FK+Reference pair check: every columnType:"R" must link via thisKey to a
		// PHYSICAL FK column on this entity — not to itself and not to another virtual
		// (R/S/F) column. Pointing an R column's thisKey at itself was how issue #6's
		// merged field slipped through (the field code existed, so the old check passed).
		for (const [fCode, fDef] of Object.entries(fields)) {
			if ((fDef.columnType as string) !== "R") continue;
			const link = fDef.link as Record<string, string> | undefined;
			if (!link?.thisKey) {
				issues.push(err(`entity:${code}:field:${fCode}`, "Reference column missing 'link.thisKey'."));
				continue;
			}
			for (const key of String(link.thisKey).split(",").map((s) => s.trim()).filter(Boolean)) {
				if (!fieldCodes.has(key)) {
					issues.push(err(`entity:${code}:field:${fCode}`, `Reference 'link.thisKey' ('${key}') has no matching FK column on this entity.`));
					continue;
				}
				const targetCt = fields[key]?.columnType as string | undefined;
				if (key === fCode || (targetCt && VIRTUAL_COLUMN_TYPES.has(targetCt))) {
					issues.push(err(
						`entity:${code}:field:${fCode}`,
						`Reference 'link.thisKey' ('${key}') must point to a PHYSICAL FK column, but '${key}' is ${key === fCode ? "the reference column itself" : `a virtual ${COLUMN_TYPE_NAME[targetCt!]} column`}. Add a physical FK column (dbDatatype, no columnType) and point link.thisKey at it.`,
					));
				}
			}
		}

		fieldsByEntity.set(code, fieldCodes);
	}

	return { issues, fieldsByEntity };
}

// ── Data view checks ─────────────────────────────────────────────────

const VALID_VIEW_TYPES = new Set([
	"grid", "list", "kanban", "calendar", "gallery",
	"tree-grid", "diagram", "master-detail", "library",
]);

function checkDataViews(
	paths: ModulePaths,
	entityCodes: Set<string>,
	fieldsByEntity: Map<string, Set<string>>,
): Issue[] {
	const issues: Issue[] = [];
	if (!fs.existsSync(paths.dataViews)) return issues;

	let views: Record<string, unknown>;
	try {
		views = JSON.parse(fs.readFileSync(paths.dataViews, "utf8")) as Record<string, unknown>;
	} catch {
		issues.push(err("data_views", "Cannot parse ui/data_views.json as JSON."));
		return issues;
	}

	for (const [vCode, vDef] of Object.entries(views)) {
		const view = vDef as Record<string, unknown>;

		if (!view.viewType) {
			issues.push(err(`data_view:${vCode}`, "Missing 'viewType'."));
		} else if (!VALID_VIEW_TYPES.has(view.viewType as string)) {
			issues.push(err(`data_view:${vCode}`, `Unknown viewType '${view.viewType}'.`));
		}

		const dataSources = view.dataSources;
		if (!Array.isArray(dataSources)) {
			issues.push(err(`data_view:${vCode}`, "'dataSources' must be an array, not an object."));
			continue;
		}

		for (const src of dataSources as Array<Record<string, unknown>>) {
			const eCode = src.entityCode as string | undefined;
			if (!eCode) {
				issues.push(err(`data_view:${vCode}`, "A dataSource is missing 'entityCode'."));
				continue;
			}

			// Only validate local (non-dotted) entity codes
			if (!eCode.includes(".") && !entityCodes.has(eCode)) {
				issues.push(err(`data_view:${vCode}`, `dataSource entityCode '${eCode}' not found in manifest entities.`));
				continue;
			}

			// Column code validation (only for local entities we have loaded)
			const knownFields = eCode.includes(".") ? null : fieldsByEntity.get(eCode);
			if (knownFields) {
				const cols = src.columns as Array<Record<string, unknown>> | undefined ?? [];
				for (const col of cols) {
					const colCd = (col.column_cd ?? col.code) as string | undefined;
					if (colCd && !knownFields.has(colCd)) {
						issues.push(warn(`data_view:${vCode}`, `Column '${colCd}' does not exist on entity '${eCode}'.`));
					}
				}
			}
		}
	}

	return issues;
}

// ── Menu checks ──────────────────────────────────────────────────────

function checkMenuNode(
	node: Record<string, unknown>,
	path: string,
	viewCodes: Set<string>,
	reportCodes: Set<string>,
	issues: Issue[],
): void {
	const itemType = node.itemType as string | undefined;

	if (itemType) {
		// Leaf node
		if (itemType === "V") {
			const dvCode = node.dataViewCode as string | undefined;
			if (!dvCode) {
				issues.push(err(`menu:${path}`, "Leaf item with itemType 'V' is missing 'dataViewCode'."));
			} else if (!viewCodes.has(dvCode)) {
				issues.push(err(`menu:${path}`, `dataViewCode '${dvCode}' not found in ui/data_views.json.`));
			}
		} else if (itemType === "R") {
			const rCode = node.reportCode as string | undefined;
			if (!rCode) {
				issues.push(err(`menu:${path}`, "Leaf item with itemType 'R' is missing 'reportCode'."));
			} else if (!reportCodes.has(rCode)) {
				issues.push(err(`menu:${path}`, `reportCode '${rCode}' not found in ui/reports.json.`));
			}
		}
	}

	// Recurse into children (dict) or items (dict used by some menu shapes)
	for (const childKey of ["children", "items"]) {
		const children = node[childKey] as Record<string, unknown> | undefined;
		if (children && typeof children === "object" && !Array.isArray(children)) {
			for (const [key, child] of Object.entries(children)) {
				checkMenuNode(
					child as Record<string, unknown>,
					`${path}/${key}`,
					viewCodes,
					reportCodes,
					issues,
				);
			}
		}
	}
}

function checkMenus(
	paths: ModulePaths,
	viewCodes: Set<string>,
	reportCodes: Set<string>,
): Issue[] {
	const issues: Issue[] = [];
	if (!fs.existsSync(paths.menus)) return issues;

	let menus: Record<string, unknown>;
	try {
		menus = JSON.parse(fs.readFileSync(paths.menus, "utf8")) as Record<string, unknown>;
	} catch {
		issues.push(err("menus", "Cannot parse ui/menus.json as JSON."));
		return issues;
	}

	for (const [key, node] of Object.entries(menus)) {
		checkMenuNode(node as Record<string, unknown>, key, viewCodes, reportCodes, issues);
	}

	return issues;
}

// ── Security checks ──────────────────────────────────────────────────

function checkSecurity(
	paths: ModulePaths,
	entityCodes: Set<string>,
): Issue[] {
	const issues: Issue[] = [];
	if (!fs.existsSync(paths.roles)) {
		issues.push(err("security", "security/roles.json does not exist."));
		return issues;
	}

	let roles: Record<string, unknown>;
	try {
		roles = JSON.parse(fs.readFileSync(paths.roles, "utf8")) as Record<string, unknown>;
	} catch {
		issues.push(err("security", "Cannot parse security/roles.json as JSON."));
		return issues;
	}

	const fullCoverageEntities = new Set<string>();

	for (const [rCode, rDef] of Object.entries(roles)) {
		const role = rDef as Record<string, unknown>;

		if (!role.description) {
			issues.push(warn(`security:role:${rCode}`, "Role is missing 'description'."));
		}

		const rights = (role.rights ?? {}) as Record<string, string>;
		for (const [objCode, rightsStr] of Object.entries(rights)) {
			if (!RIGHTS_PATTERN.test(rightsStr)) {
				issues.push(err(`security:role:${rCode}`, `Rights string '${rightsStr}' for '${objCode}' contains invalid characters. Only S, I, U, D, C, E are allowed.`));
			}
			// Track which local entities have full SIUDC coverage from at least one role
			if (!objCode.includes(".") && entityCodes.has(objCode)) {
				if (rightsStr.includes("S") && rightsStr.includes("I") && rightsStr.includes("U") && rightsStr.includes("D") && rightsStr.includes("C")) {
					fullCoverageEntities.add(objCode);
				}
			}
		}
	}

	// Warn if any local entity has no full-access role
	for (const eCode of entityCodes) {
		if (!fullCoverageEntities.has(eCode)) {
			issues.push(warn("security", `No role grants full rights (SIUDC) on entity '${eCode}' — at least one admin role should.`));
		}
	}

	return issues;
}

// ── Action checks ────────────────────────────────────────────────────

const VALID_EXECUTION_MODES = new Set(["single", "each", "batch"]);

function checkActions(paths: ModulePaths): Issue[] {
	const issues: Issue[] = [];
	if (!fs.existsSync(paths.actions)) return issues;

	let actions: Record<string, unknown>;
	try {
		actions = JSON.parse(fs.readFileSync(paths.actions, "utf8")) as Record<string, unknown>;
	} catch {
		issues.push(err("actions", "Cannot parse ui/actions.json as JSON."));
		return issues;
	}

	const dslDir = path.join(paths.logicDir, "actions");

	for (const [aCode, aDef] of Object.entries(actions)) {
		const action = aDef as Record<string, unknown>;

		const mode = action.mode ?? action.executionMode;
		if (mode && !VALID_EXECUTION_MODES.has(mode as string)) {
			issues.push(err(`action:${aCode}`, `Unknown executionMode '${mode}'.`));
		}

		const dslScript = action.dsl ?? action.script;
		if (!dslScript) {
			issues.push(err(`action:${aCode}`, "Missing 'dsl' (script path) field."));
		} else {
			// Resolve DSL path relative to module root
			const dslFile = path.resolve(paths.root, dslScript as string);
			if (!fs.existsSync(dslFile)) {
				// Also try the dslDir convention
				const byName = path.join(dslDir, `${aCode}.dsl`);
				if (!fs.existsSync(byName)) {
					issues.push(err(`action:${aCode}`, `DSL file '${dslScript}' does not exist on disk.`));
				}
			}
		}
	}

	// Also check for orphaned DSL files (on disk but not in actions.json)
	if (fs.existsSync(dslDir)) {
		const registeredScripts = new Set(
			Object.values(actions).map((a) => {
				const dsl = ((a as Record<string, unknown>).dsl ?? (a as Record<string, unknown>).script) as string | undefined;
				return dsl ? path.basename(dsl, ".dsl") : null;
			}).filter(Boolean) as string[],
		);
		for (const file of fs.readdirSync(dslDir)) {
			if (file.endsWith(".dsl")) {
				const code = path.basename(file, ".dsl");
				if (!registeredScripts.has(code)) {
					issues.push(warn(`action:${code}`, `DSL file '${file}' exists on disk but has no entry in ui/actions.json.`));
				}
			}
		}
	}

	return issues;
}

// ── Settings checks ──────────────────────────────────────────────────

function checkSettings(paths: ModulePaths): Issue[] {
	const issues: Issue[] = [];
	if (!fs.existsSync(paths.settings)) return issues;

	let settings: Record<string, unknown>;
	try {
		settings = JSON.parse(fs.readFileSync(paths.settings, "utf8")) as Record<string, unknown>;
	} catch {
		issues.push(err("settings", "Cannot parse settings.json as JSON."));
		return issues;
	}

	for (const [sCode, sDef] of Object.entries(settings)) {
		const setting = sDef as Record<string, unknown>;
		if (!setting.fieldTypeCd) {
			issues.push(err(`setting:${sCode}`, "Missing 'fieldTypeCd'."));
		} else if (!(FIELD_TYPE_CODES as readonly string[]).includes(setting.fieldTypeCd as string)) {
			issues.push(err(`setting:${sCode}`, `Invalid fieldTypeCd '${setting.fieldTypeCd as string}'. Must be one of: ${FIELD_TYPE_CODES.join(", ")}.`));
		}
		if (setting.defaultValue === undefined) {
			issues.push(warn(`setting:${sCode}`, "Missing 'defaultValue' — settings should declare a default."));
		}
	}

	return issues;
}

// ── Seed data checks ─────────────────────────────────────────────────

function checkSeedData(paths: ModulePaths, entityCodes: Set<string>): Issue[] {
	const issues: Issue[] = [];
	if (!fs.existsSync(paths.seedDataDir)) return issues;

	const files = fs.readdirSync(paths.seedDataDir)
		.filter((f) => f.endsWith(".json"))
		.sort();

	for (const file of files) {
		// Warn if file doesn't start with a numbered prefix
		if (!/^\d/.test(file)) {
			issues.push(warn(`seed:${file}`, "Seed file should start with a numeric prefix (e.g. '01-') for deterministic load order."));
		}

		const abs = path.join(paths.seedDataDir, file);
		let seed: Record<string, unknown>;
		try {
			seed = JSON.parse(fs.readFileSync(abs, "utf8")) as Record<string, unknown>;
		} catch {
			issues.push(err(`seed:${file}`, "Cannot parse seed file as JSON."));
			continue;
		}

		const eCode = seed.entityCode as string | undefined;
		if (!eCode) {
			issues.push(err(`seed:${file}`, "Missing 'entityCode' field — this is a silent failure at install time."));
		} else if (!eCode.includes(".") && !entityCodes.has(eCode)) {
			issues.push(err(`seed:${file}`, `entityCode '${eCode}' not found in manifest entities.`));
		}

		if (!Array.isArray(seed.records)) {
			issues.push(err(`seed:${file}`, "Missing or non-array 'records' field."));
		}
	}

	return issues;
}

// ── Translations checks ──────────────────────────────────────────────

function checkTranslations(paths: ModulePaths): Issue[] {
	const issues: Issue[] = [];
	const enUS = path.join(paths.translationsDir, "en-US.json");
	if (!fs.existsSync(enUS)) {
		issues.push(err("translations", "translations/en-US.json does not exist."));
		return issues;
	}

	let t: Record<string, unknown>;
	try {
		t = JSON.parse(fs.readFileSync(enUS, "utf8")) as Record<string, unknown>;
	} catch {
		issues.push(err("translations", "Cannot parse translations/en-US.json as JSON."));
		return issues;
	}

	for (const section of ["entities", "views", "menus", "actions", "roles"]) {
		if (!Object.prototype.hasOwnProperty.call(t, section)) {
			issues.push(warn(`translations:en-US`, `Missing '${section}' section in en-US.json.`));
		}
	}

	return issues;
}

// ── Main validate function ───────────────────────────────────────────

export const moduleValidateSchema = {
	moduleDir: z.string().describe("Absolute path to the module root directory."),
};

export function moduleValidate(
	args: z.infer<z.ZodObject<typeof moduleValidateSchema>>,
): ValidateResult {
	const { manifest, paths } = loadManifest(args.moduleDir);
	const entityCodes = new Set(Object.keys(manifest.entities ?? {}));

	const allIssues: Issue[] = [];

	allIssues.push(...checkManifest(manifest, paths));

	const { issues: entityIssues, fieldsByEntity } = checkEntities(manifest, paths);
	allIssues.push(...entityIssues);

	const viewCodes = fs.existsSync(paths.dataViews)
		? new Set(Object.keys(readJsonOrDefault<Record<string, unknown>>(paths.dataViews, {})))
		: new Set<string>();

	const reportCodes = fs.existsSync(paths.reports)
		? new Set(Object.keys(readJsonOrDefault<Record<string, unknown>>(paths.reports, {})))
		: new Set<string>();

	allIssues.push(...checkDataViews(paths, entityCodes, fieldsByEntity));
	allIssues.push(...checkMenus(paths, viewCodes, reportCodes));
	allIssues.push(...checkSecurity(paths, entityCodes));
	allIssues.push(...checkActions(paths));
	allIssues.push(...checkSettings(paths));
	allIssues.push(...checkSeedData(paths, entityCodes));
	allIssues.push(...checkTranslations(paths));

	const errors = allIssues.filter((i) => i.level === "error").length;
	const warnings = allIssues.filter((i) => i.level === "warning").length;
	const passed = 9 - (errors > 0 ? 1 : 0); // rough "categories checked" count

	let summary: string;
	if (errors === 0 && warnings === 0) {
		summary = `All checks passed — module '${manifest.code}' looks valid.`;
	} else if (errors === 0) {
		summary = `No errors, ${warnings} warning${warnings !== 1 ? "s" : ""} — review warnings before install.`;
	} else {
		summary = `${errors} error${errors !== 1 ? "s" : ""}, ${warnings} warning${warnings !== 1 ? "s" : ""} — fix errors before installing.`;
	}

	void passed;
	return { summary, errors, warnings, issues: allIssues };
}
