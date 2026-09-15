// Shared utilities for patch-style MCP tools. Every tool that modifies an
// existing module reads files from disk, mutates JS objects, and returns a
// FileMap of just the files that changed. The MCP client (Claude / Cursor)
// decides whether to write them.
//
// Convention: paths in FileMap are RELATIVE to the module root.

import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import {
	traits as TRAIT_DEFS,
	expandTraits,
	traitFieldConflicts,
	type TraitFieldConflict,
	type TraitsFile,
} from "@dforge-core/metadata";

export type FileMap = Record<string, string>;

export interface ModulePaths {
	root: string;
	manifest: string;
	entitiesDir: string;
	uiDir: string;
	securityDir: string;
	logicDir: string;
	seedDataDir: string;
	translationsDir: string;
	dataViews: string;
	folders: string;
	menus: string;
	actions: string;
	reports: string;
	queries: string;
	roles: string;
	jobs: string;
	triggers: string;
	webhooks: string;
	printTemplates: string;
	settings: string;
	domains: string;
}

export function modulePaths(moduleDir: string): ModulePaths {
	const root = path.resolve(moduleDir);
	return {
		root,
		manifest: path.join(root, "manifest.json"),
		entitiesDir: path.join(root, "entities"),
		uiDir: path.join(root, "ui"),
		securityDir: path.join(root, "security"),
		logicDir: path.join(root, "logic"),
		seedDataDir: path.join(root, "seed-data"),
		translationsDir: path.join(root, "translations"),
		dataViews: path.join(root, "ui", "data_views.json"),
		folders: path.join(root, "ui", "folders.json"),
		menus: path.join(root, "ui", "menus.json"),
		actions: path.join(root, "ui", "actions.json"),
		reports: path.join(root, "ui", "reports.json"),
		queries: path.join(root, "ui", "queries.json"),
		printTemplates: path.join(root, "ui", "print_templates.json"),
		roles: path.join(root, "security", "roles.json"),
		jobs: path.join(root, "logic", "jobs.json"),
		triggers: path.join(root, "logic", "triggers.json"),
		webhooks: path.join(root, "logic", "webhooks.json"),
		settings: path.join(root, "settings.json"),
		domains: path.join(root, "domains.json"),
	};
}

export function readJson<T = unknown>(absPath: string): T {
	if (!fs.existsSync(absPath)) {
		throw new Error(`Not found: ${absPath}`);
	}
	try {
		return JSON.parse(fs.readFileSync(absPath, "utf8")) as T;
	} catch (e) {
		throw new Error(`${absPath}: ${(e as Error).message}`);
	}
}

export function readJsonOrDefault<T>(absPath: string, dflt: T): T {
	if (!fs.existsSync(absPath)) return dflt;
	try {
		return JSON.parse(fs.readFileSync(absPath, "utf8")) as T;
	} catch (e) {
		throw new Error(`${absPath}: ${(e as Error).message}`);
	}
}

/**
 * Serialize an object as JSON with tab indentation and trailing newline.
 * Matches the dForge convention (CLAUDE.md), keeps git diffs clean.
 */
export function jsonText(obj: unknown): string {
	return JSON.stringify(obj, null, "\t") + "\n";
}

/** Compose a relative path that a FileMap entry should use. */
export function rel(root: string, abs: string): string {
	return path.relative(root, abs);
}

/**
 * Load a module's manifest. Throws with a clear message if the directory
 * isn't actually a dForge module.
 */
export interface Manifest {
	packageFormat: number;
	moduleId: string;
	code: string;
	version: string;
	dbSchemaVersion: string;
	displayName: string;
	description?: string;
	dependencies?: Record<string, string | { version: string; entities?: string[] }>;
	entities?: Record<string, string>;
	updated?: string;
	[k: string]: unknown;
}

export function loadManifest(moduleDir: string): {
	manifest: Manifest;
	paths: ModulePaths;
} {
	const paths = modulePaths(moduleDir);
	if (!fs.existsSync(paths.manifest)) {
		throw new Error(
			`No manifest.json at ${paths.manifest} — is this a dForge module directory?`,
		);
	}
	const manifest = readJson<Manifest>(paths.manifest);
	if (!manifest.code) {
		throw new Error("manifest.json has no `code` field — corrupt module?");
	}
	return { manifest, paths };
}

/**
 * Standard tool response envelope. `summary` is a one-line human-readable
 * status; `files` are the changed files for the client to write; `warning`
 * surfaces caveats (e.g. "this regenerates X, hand-edits will be lost").
 */
export interface ToolResult {
	summary: string;
	files: FileMap;
	warning?: string;
	/**
	 * Module-root-relative paths the client should DELETE (used by rename/delete
	 * refactors that move or drop a file). Distinct from `files`, which are
	 * written. The client must apply both.
	 */
	deletes?: string[];
}

export function makeResult(summary: string, files: FileMap, warning?: string, deletes?: string[]): ToolResult {
	const out: ToolResult = { summary, files };
	if (warning) out.warning = warning;
	if (deletes && deletes.length) out.deletes = deletes;
	return out;
}

/** Bump manifest.updated to today's YYYY-MM-DD. Call this on any patch. */
export function withTodayStamp(manifest: Manifest): Manifest {
	return { ...manifest, updated: new Date().toISOString().slice(0, 10) };
}

// ── Phase 0 readiness gate ───────────────────────────────────────────
//
// Machine-readable marker written by `dforge_module_plan` validate and read by
// the scaffold gate, instead of grepping a human-edited Markdown file for a
// magic substring. `docs/VALIDATION.md` stays the human report; this is the
// source of truth for the gate.

/** Relative path (from the module root) of the Phase 0 state marker. */
export const PHASE_STATE_FILE = "docs/phase.json";

/**
 * Phases 1–6, the build/ship half of the lifecycle. Phase 0's sub-phases
 * (0a–0d) are tracked separately by their artifact files.
 */
export const BUILD_PHASES = ["1", "2", "3", "4", "5", "6"] as const;
export type BuildPhase = (typeof BUILD_PHASES)[number];

export interface PhaseState {
	phase?: string;
	readyToScaffold?: boolean;
	validatedAt?: string;
	/**
	 * Ledger of completed build phases. Before this existed, a resumed session
	 * had to GUESS the last completed phase by cross-referencing inspect output
	 * — which can't distinguish "Phase 2 skipped deliberately" from "Phase 2 not
	 * started". Recording it makes resume (and the design → build → ship skill
	 * handoff) deterministic.
	 */
	phases?: Record<string, { completedAt: string; skipped?: boolean; note?: string }>;
}

/** Serialize a phase-state marker (for the validate action's file map). */
export function phaseStateJson(state: PhaseState): string {
	return JSON.stringify(state, null, "\t") + "\n";
}

/** Read + parse the phase-state marker, or null if absent/unparsable. */
export function readPhaseState(moduleDir: string): PhaseState | null {
	const p = path.join(path.resolve(moduleDir), PHASE_STATE_FILE);
	if (!fs.existsSync(p)) return null;
	try {
		return JSON.parse(fs.readFileSync(p, "utf8")) as PhaseState;
	} catch {
		return null;
	}
}

/**
 * Whether Phase 0 design validation has passed. Prefers the parsed marker;
 * falls back to the legacy `readyToScaffold: true` substring in VALIDATION.md
 * for modules validated before the marker existed.
 */
/**
 * Merge a completed/skipped build phase into the on-disk state and return the
 * serialized marker for the caller's file map. Never clobbers Phase 0 fields.
 */
export function markPhase(
	moduleDir: string,
	phase: BuildPhase,
	opts: { skipped?: boolean; note?: string } = {},
): { state: PhaseState; json: string } {
	const prior = readPhaseState(moduleDir) ?? {};
	const state: PhaseState = {
		...prior,
		phases: {
			...(prior.phases ?? {}),
			[phase]: {
				completedAt: new Date().toISOString().slice(0, 10),
				...(opts.skipped ? { skipped: true } : {}),
				...(opts.note ? { note: opts.note } : {}),
			},
		},
	};
	return { state, json: phaseStateJson(state) };
}

export function isReadyToScaffold(moduleDir: string): boolean {
	const state = readPhaseState(moduleDir);
	if (state && typeof state.readyToScaffold === "boolean") return state.readyToScaffold;
	const v = path.join(path.resolve(moduleDir), "docs", "VALIDATION.md");
	return fs.existsSync(v) && fs.readFileSync(v, "utf8").includes("readyToScaffold: true");
}

// ── rights validation ────────────────────────────────────────────────
//
// A role-rights key is one of: a same-module entity ('product'), a
// cross-module entity ('fin.invoice', dotted), or a non-entity object with
// a COLON prefix ('action:approve', 'report:summary', 'folder:east'). The
// platform (every dForge-core module) uses the colon form for objects; the
// dot form ('action.approve') is the #1 mistake — it's read as entity
// 'approve' in a module named 'action' and rejected as unknown.

const RIGHTS_ENTITY = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)?$/;
const RIGHTS_OBJECT = /^(action|report|folder):[a-z][a-z0-9_]*$/;
const RIGHTS_OBJECT_DOT = /^(action|report|folder)\.[a-z]/;

/** Validate one rights-map key. Throws an actionable error if malformed. */
export function assertValidRightKey(key: string): void {
	if (RIGHTS_OBJECT_DOT.test(key)) {
		const fixed = key.replace(".", ":");
		throw new Error(
			`Rights key '${key}' uses a dot for an action/report/folder — use a colon: '${fixed}'. ` +
				`(A dot is only for cross-module entities like 'fin.invoice'.)`,
		);
	}
	if (RIGHTS_OBJECT.test(key) || RIGHTS_ENTITY.test(key)) return;
	throw new Error(
		`Invalid rights key '${key}'. Use a same-module entity ('product'), a cross-module entity ` +
			`('fin.invoice'), or a colon-prefixed object ('action:approve', 'report:summary', 'folder:east').`,
	);
}

/**
 * Validate a rights value for a key. `allowEmpty` permits "" (used by
 * role_right_set, where "" means "revoke/remove the grant"). For role_add an
 * empty string is rejected — deny by omitting the key instead.
 */
export function assertValidRightValue(key: string, value: string, allowEmpty: boolean): void {
	if (value === "") {
		if (allowEmpty) return;
		throw new Error(
			`Rights on '${key}' is an empty string. To deny access, omit the key entirely; to grant, use rights letters.`,
		);
	}
	if (!/^[SIUDCE]+$/.test(value)) {
		throw new Error(
			`Invalid rights '${value}' on '${key}'. Use S/I/U/D/C for entities, or 'E' for actions/reports/folders.`,
		);
	}
	const isObject = /^(action|report|folder):/.test(key);
	if (isObject && value !== "E") {
		throw new Error(`Object '${key}' takes 'E' (Execute), got '${value}'.`);
	}
	if (!isObject && value.includes("E")) {
		throw new Error(
			`'${key}' is granted 'E' but has no action:/report:/folder: prefix — entity rights are S/I/U/D/C. ` +
				`If '${key}' is an action or report, prefix it (e.g. 'action:${key}' or 'report:${key}').`,
		);
	}
}

/** Validate a whole rights map (role_add). Empty values are rejected. */
export function assertValidRights(rights: Record<string, string>): void {
	for (const [key, value] of Object.entries(rights)) {
		assertValidRightKey(key);
		assertValidRightValue(key, value, false);
	}
}

// ── Phase 5a security-coverage gate ──────────────────────────────────
//
// Phase 5a (roles + rights matrix) is a required phase, but the platform
// installs a security-less module without complaint (it's just inaccessible),
// so nothing downstream catches a missing role. This gate enforces it at pack
// time: every same-module entity must be granted Select by at least one role.
// Actions/reports without an Execute grant are surfaced as a soft warning.

interface RoleShape {
	rights?: Record<string, string>;
}

export function checkSecurityCoverage(moduleDir: string): {
	uncoveredEntities: string[];
	uncoveredObjects: string[];
} {
	const { manifest, paths } = loadManifest(moduleDir);
	// Same-module entities only — cross-module extensions (dotted keys) are
	// owned and secured by their home module.
	const entities = Object.keys(manifest.entities ?? {}).filter((k) => !k.includes("."));
	const roles = readJsonOrDefault<Record<string, RoleShape>>(paths.roles, {});

	const grantedSelect = new Set<string>();
	const grantedExec = new Set<string>();
	for (const role of Object.values(roles)) {
		for (const [obj, r] of Object.entries(role?.rights ?? {})) {
			if (typeof r !== "string") continue;
			if (r.includes("S")) grantedSelect.add(obj);
			if (r.includes("E")) grantedExec.add(obj);
		}
	}

	const uncoveredEntities = entities.filter((e) => !grantedSelect.has(e));
	const actions = Object.keys(readJsonOrDefault<Record<string, unknown>>(paths.actions, {}));
	const reports = Object.keys(readJsonOrDefault<Record<string, unknown>>(paths.reports, {}));
	const uncoveredObjects = [
		...actions.filter((a) => !grantedExec.has(`action:${a}`)).map((a) => `action:${a}`),
		...reports.filter((r) => !grantedExec.has(`report:${r}`)).map((r) => `report:${r}`),
	];
	return { uncoveredEntities, uncoveredObjects };
}

/**
 * Pre-pack gate. Throws if any entity lacks Select coverage (Phase 5a
 * incomplete). Returns an optional soft-warning string for ungranted
 * actions/reports.
 */
export function assertSecurityCoverage(moduleDir: string): string | undefined {
	const { uncoveredEntities, uncoveredObjects } = checkSecurityCoverage(moduleDir);
	if (uncoveredEntities.length > 0) {
		throw new Error(
			`Phase 5a (security) incomplete — no role grants Select (S) on: ${uncoveredEntities.join(", ")}. ` +
				`Every entity must appear in at least one role's rights with at least 'S'. Add or extend roles ` +
				`with dforge_role_add / dforge_role_right_set, then re-pack.`,
		);
	}
	if (uncoveredObjects.length > 0) {
		return `Security note — no role grants Execute (E) on: ${uncoveredObjects.join(", ")}. Add 'E' grants if a role should run these.`;
	}
	return undefined;
}

// ── Composite keys ───────────────────────────────────────────────────

/**
 * Separator for Set/Map keys built by joining several identifiers (a view plus
 * an entity, a dotted path into a translation file, …).
 *
 * Deliberately a VISIBLE string, not a NUL byte. Every identifier joined this
 * way is a code (`[a-z][a-z0-9_]*`, sometimes dotted) or a JSON object key, so
 * a colon pair can't occur inside one and needs no escaping — while a NUL is
 * invisible in a diff, silently mangled by editors and formatters, makes any
 * debug print of the key unreadable, and (worst) makes `grep` treat the whole
 * source file as binary so it stops matching anything in it.
 */
export const KEY_SEP = "::";

/** Join identifiers into a collision-free composite key. */
export function compositeKey(...parts: string[]): string {
	return parts.join(KEY_SEP);
}

// ── Folder tree ──────────────────────────────────────────────────────
//
// ui/folders.json IS the root folder (not a map), with sub-folders nested under
// `children`. Folder CODES are referenced flat and path-less everywhere else in
// the module — role rights use `folder:<code>`, and translations key on
// `folders.<code>.label`. So two folders sharing a code in different branches
// are genuinely ambiguous: the rights grant can't say which one it means, and
// the translation for one silently overwrites the other. Nothing enforced that,
// so these helpers let the add tool, the validator, and the translation sync
// all apply the same rule.

export interface FolderNode {
	/** The folder's code (its key under the parent's `children`). */
	code: string;
	/** Slash-separated trail from the root, e.g. `central/east`. Empty for root. */
	path: string;
	node: Record<string, unknown>;
}

/**
 * Depth-first walk of a folder tree, yielding every sub-folder. The root itself
 * is NOT included — it has no code of its own (it's the file), and callers key
 * it on the module code.
 */
export function walkFolders(root: Record<string, unknown>): FolderNode[] {
	const out: FolderNode[] = [];
	const visit = (node: Record<string, unknown>, trail: string[]): void => {
		const children = (node.children as Record<string, unknown> | undefined) ?? {};
		for (const [code, child] of Object.entries(children)) {
			if (!child || typeof child !== "object") continue;
			const next = [...trail, code];
			out.push({ code, path: next.join("/"), node: child as Record<string, unknown> });
			visit(child as Record<string, unknown>, next);
		}
	};
	visit(root, []);
	return out;
}

/**
 * Folder codes used more than once anywhere in the tree, mapped to every path
 * that claims them. Empty when the tree is well-formed.
 */
export function duplicateFolderCodes(root: Record<string, unknown>): Map<string, string[]> {
	const byCode = new Map<string, string[]>();
	for (const f of walkFolders(root)) {
		const paths = byCode.get(f.code) ?? [];
		paths.push(f.path);
		byCode.set(f.code, paths);
	}
	for (const [code, paths] of byCode) {
		if (paths.length < 2) byCode.delete(code);
	}
	return byCode;
}

// ── Entity traits ────────────────────────────────────────────────────
//
// Trait codes are validated against the canonical registry in
// @dforge-core/metadata (identity, audit, audit-full, soft-delete, sorting,
// postable, accumulation, ledger, period). The platform expands them into
// physical columns at install — the entity JSON only carries the codes — so
// the authoring tools can accept the full set, not just the CLI scaffolder's
// two presets. `withTraits` overwrites the codes array on a built entity.

/** All valid trait codes, from the metadata registry. */
export const TRAIT_CODES: readonly string[] = TRAIT_DEFS.map((t) => t.cd);
/** O(1) membership set, built once, for validating trait codes. */
const TRAIT_CODE_SET = new Set(TRAIT_CODES);

/**
 * Reusable input schema for an entity's trait list. Defaults to identity+audit
 * (the common case). Rejects unknown codes with the valid list.
 */
export const traitsInput = z
	.array(z.string())
	.default(["identity", "audit"])
	.superRefine((arr, ctx) => {
		for (const cd of arr) {
			if (!TRAIT_CODE_SET.has(cd)) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: `trait '${cd}' is not a valid trait. Valid: ${TRAIT_CODES.join(", ")}. (See dforge://reference/traits.)`,
				});
			}
		}
	})
	.describe(
		"Entity trait codes — identity, audit, audit-full, soft-delete, sorting, postable, accumulation, ledger, period. " +
			"'identity' makes the PK '{entity}_id'. Traits expand into columns server-side at install; list only the codes.",
	);

/**
 * Trait codes on `traits` that aren't in the registry.
 *
 * `expandTraits` does NOT throw on an unknown code — it silently returns only
 * the columns of the codes it recognized. So a typo'd trait doesn't fail; it
 * just makes columns disappear, which then reads downstream as "that column
 * doesn't exist". Anything that derives columns from traits should check this
 * first. (`traitsInput` covers the authoring tools; this covers entities that
 * arrived via import or a hand edit.)
 */
export function unknownTraits(
	traitCodes: readonly string[],
	localTraits?: TraitsFile,
): string[] {
	return traitCodes.filter(
		(cd) => !TRAIT_CODE_SET.has(cd) && localTraits?.[cd] === undefined,
	);
}

/** The outcome of reading a module's own `traits.json`. */
export interface LocalTraits {
	/** The parsed file, or undefined when the module ships none (or it is unusable). */
	traits?: TraitsFile;
	/**
	 * Present when the file exists but is unusable — the caller reports it.
	 * A complete phrase naming the defect (`invalid JSON: …`, `not a traits
	 * file: …`), so a caller only has to say which file it came from.
	 */
	error?: string;
}

/**
 * Keys a trait definition may carry (see `TraitsFile`), plus the `cd` the
 * platform's own trait files repeat inside each definition.
 */
const TRAIT_DEF_KEYS = ["cd", "description", "includes", "fields", "references", "constraints"];
const TRAIT_DEF_KEY_SET = new Set(TRAIT_DEF_KEYS);

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Why the shape is checked and not just the syntax: `traits.json` IS the map of
 * trait code → definition, so the natural mistake — wrapping it as
 * `{"traits": {…}}`, the way most of this module's other files are keyed — is
 * perfectly valid JSON. Accepting it registers one trait literally called
 * `traits`, every real local code then reads as a typo, and `assertKnownTraits`
 * goes on to advertise `traits` in the very message that is meant to list the
 * valid codes. The file's real schema is only checked once the package reaches
 * the CLI, so a wrong shape has to be named here or not at all.
 *
 * Returns undefined when the shape is usable.
 */
function traitsShapeError(parsed: unknown): string | undefined {
	if (!isPlainObject(parsed)) {
		const got = Array.isArray(parsed) ? "an array" : parsed === null ? "null" : `a ${typeof parsed}`;
		return `not a traits file: expected an object keyed by trait code, got ${got}.`;
	}
	for (const [cd, def] of Object.entries(parsed)) {
		if (!isPlainObject(def)) {
			const got = Array.isArray(def) ? "an array" : def === null ? "null" : `a ${typeof def}`;
			return `not a traits file: trait '${cd}' is ${got}, not a definition object.`;
		}
		const unexpected = Object.keys(def).filter((k) => !TRAIT_DEF_KEY_SET.has(k));
		if (unexpected.length > 0) {
			// The wrapper mistake lands exactly here, and its own message is far
			// more use than the generic one — the fix is to delete one line.
			if (cd === "traits" && Object.keys(parsed).length === 1) {
				return (
					'not a traits file: the top level is keyed by trait code, so a "traits" wrapper ' +
					`registers one trait called 'traits' and hides the ${unexpected.length} real one(s) ` +
					`(${unexpected.join(", ")}). Remove the wrapper and put the definitions at the top level.`
				);
			}
			return (
				`not a traits file: trait '${cd}' has unexpected key(s): ${unexpected.join(", ")}. ` +
				`A trait definition carries ${TRAIT_DEF_KEYS.join(", ")}.`
			);
		}
		if (def.fields !== undefined && !isPlainObject(def.fields)) {
			return `not a traits file: trait '${cd}' has a 'fields' that is not an object keyed by column code.`;
		}
		const includes = def.includes;
		if (includes !== undefined && !(Array.isArray(includes) && includes.every((i) => typeof i === "string"))) {
			return `not a traits file: trait '${cd}' has an 'includes' that is not an array of trait codes.`;
		}
	}
	return undefined;
}

/**
 * A module's own `traits.json`, when it ships one. The installer overlays these
 * on the platform traits (`TraitExpanderFactory.ForPackage`), so a reader that
 * knows only the platform registry sees an entity missing the columns install
 * will give it — and then reports every read of one as "not a column".
 *
 * A file that doesn't parse — or that parses into something that isn't a traits
 * map — comes back as `error` rather than as a silent absence: both have the
 * same knock-on effect as a typo'd trait code (columns vanish, every use of one
 * reads as "not a column"), and nothing else offline validates this file — its
 * schema is only checked once the package reaches the CLI. Naming the defect
 * names the cause instead of the symptoms.
 */
export function readLocalTraits(moduleRoot: string): LocalTraits {
	const file = path.join(moduleRoot, "traits.json");
	if (!fs.existsSync(file)) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch (ex) {
		return { error: `invalid JSON: ${(ex as Error).message}.` };
	}
	// A file of the wrong shape parses fine and is worse than one that doesn't:
	// it reads as a set of traits nobody declared. Report, don't overlay.
	const shape = traitsShapeError(parsed);
	if (shape) return { error: shape };
	return { traits: parsed as TraitsFile };
}

/**
 * Every column an entity ends up with, and the field definition behind each —
 * authored fields plus the columns its traits expand into, the module's own
 * traits included. Authored fields win on a key collision, which is what the
 * server does when it expands traits before reading `fields`.
 *
 * One function because the two must agree: a column in the set with no def (or
 * the reverse) is what makes a checker reject a field it can see.
 */
export function expandedEntity(
	entity: Record<string, unknown>,
	entityName: string,
	localTraits?: TraitsFile,
): {
	columns: Set<string>;
	fieldDefs: Record<string, Record<string, unknown>>;
	conflicts: TraitFieldConflict[];
} {
	const fields = (entity.fields as Record<string, Record<string, unknown>> | undefined) ?? {};
	const traitCodes = (entity.traits as string[] | undefined) ?? [];
	const traitFields = expandTraits(traitCodes, entityName, localTraits) as Record<
		string,
		Record<string, unknown>
	>;
	return {
		columns: new Set([...Object.keys(fields), ...Object.keys(traitFields)]),
		fieldDefs: { ...traitFields, ...fields },
		// The expansion above is total — a trait field the entity already has
		// under a different type is merged away here, while the installer keeps
		// the first and refuses the entity outright. Ask for those collisions
		// separately, or they are invisible to every caller.
		conflicts: traitFieldConflicts(traitCodes, entityName, {
			localTraits,
			fields: fields as Record<string, never>,
		}),
	};
}

/** One-line rendering of a trait collision, for a validator's issue list. */
export function describeTraitConflict(c: TraitFieldConflict): string {
	const kept = c.existingFrom === "field" ? "an authored field" : "another trait's field";
	return (
		`field '${c.field}' is contributed by a trait but already exists as ${kept} with a ` +
		`different type (${c.existingType ?? "untyped"} vs ${c.traitType ?? "untyped"}). ` +
		"The installer keeps the first and refuses the entity — rename the column, or drop " +
		"the trait that brings it."
	);
}

/**
 * The bare entity code when `code` names an entity of THIS module, else
 * undefined.
 *
 * A module may name its own entity either way — `product` or `shop.product` —
 * and the installer resolves both to the same entity. Reading every dotted
 * code as external hands the column rules no record context on the qualified
 * spelling, so `[nope] = 1` passes on `shop.product` and fails on `product`
 * in the same module. Mirrors `isKnownEntity`, which already treats this
 * module's own prefix as local.
 */
export function localEntityCode(code: string | undefined, moduleCode: string): string | undefined {
	if (!code) return undefined;
	const dot = code.indexOf(".");
	if (dot < 0) return code;
	return code.slice(0, dot) === moduleCode ? code.slice(dot + 1) : undefined;
}

/**
 * The record-context entity behind an action, for the DSL checker's column
 * rules — `{ qualified, columns }`, or undefined when the code can't be
 * resolved from this module alone (a dotted cross-module code, an entity the
 * manifest doesn't list, unreadable JSON).
 *
 * Undefined is the safe answer: the column rules stand down on it. A PARTIAL
 * column set is the one thing that must never be returned — it turns every
 * legitimate read into a false "unknown column" and blocks a pack on a module
 * that installs.
 */
export function entityRecordContext(
	paths: ModulePaths,
	manifest: Manifest,
	entityCode: string | undefined,
	localTraits?: TraitsFile,
): { qualified: string; columns: Set<string> } | undefined {
	const local = localEntityCode(entityCode, manifest.code);
	if (!local) return undefined;
	const relPath = (manifest.entities ?? {})[local];
	if (!relPath) return undefined;
	const abs = path.join(paths.root, relPath.replace(/^\.\//, ""));
	if (!fs.existsSync(abs)) return undefined;
	let entity: Record<string, unknown>;
	try {
		entity = JSON.parse(fs.readFileSync(abs, "utf8")) as Record<string, unknown>;
	} catch {
		return undefined; // reported by whoever validates the entity file
	}
	// An unknown trait code drops its columns silently, so the set would be a
	// fragment — exactly the case the doc comment says not to hand over.
	const traitCodes = (entity.traits as string[] | undefined) ?? [];
	if (unknownTraits(traitCodes, localTraits).length > 0) return undefined;
	return {
		qualified: `${manifest.code}.${local}`,
		columns: expandedEntity(entity, local, localTraits).columns,
	};
}

/** Throw if any trait code is unknown, naming them and the valid set. */
export function assertKnownTraits(
	traitCodes: readonly string[],
	entityName: string,
	localTraits?: TraitsFile,
): void {
	const bad = unknownTraits(traitCodes, localTraits);
	if (bad.length === 0) return;
	const local = Object.keys(localTraits ?? {});
	throw new Error(
		`Entity '${entityName}' declares unknown trait(s): ${bad.join(", ")}. Valid: ${TRAIT_CODES.join(", ")}` +
			(local.length > 0 ? `, plus this module's own traits.json: ${local.join(", ")}` : "") +
			". An unrecognized trait is silently ignored when columns are expanded, so its columns would " +
			"quietly go missing rather than fail loudly. (See dforge://reference/traits.)",
	);
}

/** Override a built entity's `traits` array with a validated code list. */
export function withTraits<T extends object>(
	entity: T,
	traitCodes: readonly string[],
): T & { traits: string[] } {
	return { ...entity, traits: [...traitCodes] };
}

/**
 * Repair the scaffolder's placeholder `toString`.
 *
 * dforge-cli's `buildEntity` emits `"toString": "{id}"`, but the `identity`
 * trait names the PK `{entity}_id` — so every freshly scaffolded entity ships a
 * template referencing a column that doesn't exist, and it stays broken until
 * someone happens to overwrite it. Point it at the real PK instead: still a
 * placeholder the author should replace with a business field, but a valid one.
 * (The real fix belongs in dforge-cli; this normalizes on the way out so
 * dforge_module_validate doesn't flag every new module.)
 */
export function withIdentityToString<T extends { toString?: unknown }>(
	entity: T,
	entityName: string,
	traitCodes: readonly string[],
): T {
	const ts = Object.prototype.hasOwnProperty.call(entity, "toString")
		? (entity as { toString?: unknown }).toString
		: undefined;
	if (typeof ts !== "string" || ts !== "{id}") return entity;
	const pk = traitCodes.includes("identity") ? `${entityName}_id` : "id";
	return { ...entity, toString: `{${pk}}` };
}
