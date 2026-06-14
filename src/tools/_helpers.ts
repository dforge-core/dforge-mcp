// Shared utilities for patch-style MCP tools. Every tool that modifies an
// existing module reads files from disk, mutates JS objects, and returns a
// FileMap of just the files that changed. The MCP client (Claude / Cursor)
// decides whether to write them.
//
// Convention: paths in FileMap are RELATIVE to the module root.

import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { traits as TRAIT_DEFS } from "@dforge-core/metadata";

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

export interface PhaseState {
	phase?: string;
	readyToScaffold?: boolean;
	validatedAt?: string;
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

/** Override a built entity's `traits` array with a validated code list. */
export function withTraits<T extends object>(
	entity: T,
	traitCodes: readonly string[],
): T & { traits: string[] } {
	return { ...entity, traits: [...traitCodes] };
}
