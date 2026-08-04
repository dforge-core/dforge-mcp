import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createModuleSchema, createModuleFiles } from "./tools/create-module";
import { planModuleSchema, planModule } from "./tools/plan-module";
import { addEntitySchema, addEntityFiles } from "./tools/add-entity";
import { moduleImportSchema, moduleImport, dbmlImportSchema, dbmlImport } from "./tools/import";
import {
	packModuleSchema,
	packModule,
	installModuleSchema,
	installModule,
} from "./tools/native-shell";
import {
	entityFieldAddSchema,
	entityFieldAdd,
	entityFieldModifySchema,
	entityFieldModify,
} from "./tools/entity-field";
import {
	entityReferenceAddSchema,
	entityReferenceAdd,
	entityRollupAddSchema,
	entityRollupAdd,
	entityStatusAddSchema,
	entityStatusAdd,
} from "./tools/entity-compose";
import {
	entityFieldRenameSchema,
	entityFieldRename,
	entityFieldRemoveSchema,
	entityFieldRemove,
	entityRenameSchema,
	entityRename,
	entityDeleteSchema,
	entityDelete,
} from "./tools/refactor";
import { actionAddSchema, actionAdd } from "./tools/action-add";
import { actionCheckSchema, actionCheck } from "./tools/action-check";
import { viewAddSchema, viewAdd, viewModifySchema, viewModify } from "./tools/view";
import { menuAddSchema, menuAdd } from "./tools/menu";
import { translationSyncSchema, translationSync } from "./tools/translations";
import { seedAddSchema, seedAdd } from "./tools/seed";
import {
	reportAddSchema,
	reportAdd,
	settingAddSchema,
	settingAdd,
	roleAddSchema,
	roleAdd,
	folderAddSchema,
	folderAdd,
	dependencyAddSchema,
	dependencyAdd,
} from "./tools/adds";
import { roleRightSetSchema, roleRightSet } from "./tools/role-right";
import { moduleInspectSchema, moduleInspect } from "./tools/module-inspect";
import { moduleValidateSchema, moduleValidate } from "./tools/module-validate";
import {
	triggerAddSchema,
	triggerAdd,
	jobAddSchema,
	jobAdd,
	webhookAddSchema,
	webhookAdd,
} from "./tools/behavior";
import { makeResult, type ToolResult } from "./tools/_helpers";
import { applyInput, applyToDisk } from "./tools/apply";
import { resources } from "./resources";

const server = new McpServer({
	name: "dforge-mcp",
	version: "0.2.0",
});

// ── Envelopes ───────────────────────────────────────────────────────
//
// Every tool returns a ToolResult; these wrap it as MCP content
// (JSON-in-text) so the LLM can parse it, and keep the registration wiring
// below to one line per tool.

/** Args every patch tool shares — the module it targets, and the write flag. */
type PatchArgs = { moduleDir?: string; apply?: boolean };

/**
 * Patch tools: return the file map for the client to write, OR — with
 * `apply: true` — write it here and return only the paths touched. The apply
 * path also guarantees `deletes` are honoured, which a client that forgets to
 * read them would otherwise silently drop.
 */
function envelope<T extends PatchArgs>(fn: (a: T) => ToolResult) {
	return async (args: T) => {
		try {
			// Never silently downgrade an explicit `apply: true` to a preview — a
			// client relying on apply semantics would see a success response and
			// assume the write happened. Every apply-capable tool requires
			// moduleDir in its own schema, so this only fires if that ever drifts.
			if (args.apply && !args.moduleDir) {
				throw new Error(
					"apply: true requires `moduleDir` — it's the root the file map is written relative to. " +
						"Pass moduleDir, or omit `apply` to get the file map back for the client to write.",
				);
			}
			const result = fn(args);
			const payload = args.apply ? applyToDisk(args.moduleDir as string, result) : result;
			return {
				content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
			};
		} catch (e) {
			return {
				content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }],
				isError: true,
			};
		}
	};
}

/**
 * Tools whose result shape is their OWN contract rather than a ToolResult, and
 * which never take `apply` — the inspect/validate/check reports, the pack
 * result, and dforge_module_plan's lifecycle state. Serializes the return value
 * as-is. Read-only-ness is declared by the `annotations`, not by this wrapper,
 * so a tool here may still hand back files for the client to write.
 */
function serialize<T>(fn: (a: T) => unknown) {
	return async (args: T) => {
		try {
			return {
				content: [{ type: "text" as const, text: JSON.stringify(fn(args), null, 2) }],
			};
		} catch (e) {
			return {
				content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }],
				isError: true,
			};
		}
	};
}

const READ_ONLY = { readOnlyHint: true, idempotentHint: true } as const;
const DESTRUCTIVE = { destructiveHint: true } as const;
const EXTERNAL = { openWorldHint: true } as const;

// ── Module-level tools ──────────────────────────────────────────────

server.registerTool(
	"dforge_module_plan",
	{
		title: "Plan module (lifecycle orchestrator)",
		description:
			"Lifecycle owner — CALL THIS FIRST for any new or resumed module task. 'check' returns the current phase, the exact next steps, and which authoring skill to run next (design → build → ship). Phase 0: 'write_identity' (0a) writes CLAUDE.md; 'write_requirements' (0b) confirms docs/REQUIREMENTS.md (already written to disk by the agent) after the user confirms YES and ticks CLAUDE.md; 'write_design' (0c) confirms docs/DESIGN.md the same way; 'validate' (0d) runs pre-scaffold checks and writes docs/VALIDATION.md when all pass. Phases 1-6: 'complete_phase' records a phase as done or deliberately skipped, so a resumed session never re-proposes finished work. dforge_module_create is blocked until this tool reports readyToScaffold: true.",
		inputSchema: planModuleSchema,
	},
	serialize(planModule),
);

server.registerTool(
	"dforge_module_create",
	{
		title: "Scaffold a new module",
		description:
			"Scaffold a new dForge module (Phase 1). ⛔ REQUIRES Phase 0 complete — call dforge_module_plan first. Blocked until CLAUDE.md, docs/REQUIREMENTS.md, docs/DESIGN.md, and docs/VALIDATION.md (all-pass) exist in moduleDir. Returns { files: { '<relPath>': '<contents>' } } — preview with the user before writing, or pass apply: true to write directly.",
		inputSchema: { ...createModuleSchema, ...applyInput },
	},
	envelope((args: Parameters<typeof createModuleFiles>[0] & PatchArgs) => {
		const files = createModuleFiles(args);
		return makeResult(
			`Generated ${Object.keys(files).length} files for module '${args.code}' (preset: ${args.preset}, ${args.entities.length} entit${args.entities.length === 1 ? "y" : "ies"}).`,
			files,
		);
	}),
);

server.registerTool(
	"dforge_module_inspect",
	{
		title: "Inspect module state",
		description:
			"Read the current state of an existing module from disk and return a structured summary — entities + fields, views + sources, roles + rights, actions, triggers, jobs, webhooks, reports, settings, queries, print templates, domains, seed files, translations. Call this BEFORE any patch tool so you know what already exists. The full structured state is in files['_inspect.json']; `summary` is one-line stats.",
		inputSchema: moduleInspectSchema,
		annotations: READ_ONLY,
	},
	serialize(moduleInspect),
);

server.registerTool(
	"dforge_module_validate",
	{
		title: "Validate module (offline)",
		description:
			"Validate the whole module OFFLINE before packing/installing. Runs every check the per-field tools can't see: dangling FK/reference targets, a missing hidden-FK column, view dataSources/columns pointing at unknown entities/fields, menu dataViewCode → missing view, role rights on unknown objects, entities with no Select grant, field-spec rules re-run across EVERY field (catching anything that entered via import or a hand edit), toString templates, Formula-vs-Generated set aggregates over virtual child columns, action script files missing from disk, triggers/jobs firing actions that don't exist, DSL static checks, and translation completeness (role labels are install-blocking). Returns errors + warnings in _validate.json. Fix every error BEFORE dforge_module_pack — it saves a slow pack/install round trip.",
		inputSchema: moduleValidateSchema,
		annotations: READ_ONLY,
	},
	serialize(moduleValidate),
);

server.registerTool(
	"dforge_module_pack",
	{
		title: "Pack module to .dforge",
		description:
			"Pack a module directory into a .dforge tarball. Uses the bundled dforge-cli package, PATH fallback, or DFORGE_CLI_BINARY override. Refuses to build if any entity lacks a role granting Select (the Phase 5a gate).",
		inputSchema: packModuleSchema,
		annotations: EXTERNAL,
	},
	serialize(packModule),
);

server.registerTool(
	"dforge_module_install",
	{
		title: "Install module to a tenant",
		description:
			"PHASE 6: Install a module (directory or .dforge tarball) to a running tenant. Runs the FULL server-side validator — the only real validator. Reads DFORGE_URL / DFORGE_TOKEN env if not passed as args. Always returns raw CLI output, exitCode, and command so the agent can fix module defects and retry.",
		inputSchema: installModuleSchema,
		annotations: { ...EXTERNAL, ...DESTRUCTIVE },
	},
	async (args) => {
		try {
			const result = installModule(args);
			return {
				content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
				isError: !result.ok,
			};
		} catch (e) {
			return {
				content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }],
				isError: true,
			};
		}
	},
);

// ── Entity patch tools (PHASE 1) ────────────────────────────────────

server.registerTool(
	"dforge_entity_add",
	{
		title: "Add an entity",
		description:
			"PHASE 1: Add an entity to an existing module. Reads manifest from disk, returns the updated file map (manifest + new entity + regenerated UI/security). Other files on disk are NOT touched.",
		inputSchema: { ...addEntitySchema, ...applyInput },
	},
	envelope((args: Parameters<typeof addEntityFiles>[0] & PatchArgs) => {
		const { files, warning } = addEntityFiles(args);
		return makeResult(`Adds entity '${args.entity.name}' to ${args.moduleDir}.`, files, warning);
	}),
);

server.registerTool(
	"dforge_module_import",
	{
		title: "Import a table-spec as entities",
		description:
			"Import a normalized table-spec (tables → columns → relationships) into an existing module as entities. Infers each column's fieldTypeCd from an explicit code, a source SQL type (sqlType), sample values, and name heuristics (validated against the metadata registry; dbDatatype derived), and generates the FK+Reference two-column pattern for each relationship. The front-end that produces the table-spec can be DBML/SQL, an Excel/CSV upload, or hand-authored. Scaffold a minimal module first; this ADDS entities and regenerates default views/menus/roles. Review inferred types and run dforge_module_validate after.",
		inputSchema: { ...moduleImportSchema, ...applyInput },
	},
	envelope(moduleImport),
);

server.registerTool(
	"dforge_entity_rename",
	{
		title: "Rename an entity (refactor-safe)",
		description:
			"Refactor-safe rename of an entity code. Moves the entity file (old is listed in the response's `deletes` — delete it), renames the manifest key, cascades the identity PK {old}_id → {new}_id wherever an FK targets it, and repoints every reference: other entities' link.entity / references.to, view entityCode, role rights keys, action entity, folder bindings, and seed-data entityCode + PK keys. Reports/translations/menu labels/DSL are NOT rewritten (warned). Apply `files` AND `deletes` (or pass apply: true), then run dforge_module_validate.",
		inputSchema: { ...entityRenameSchema, ...applyInput },
		annotations: DESTRUCTIVE,
	},
	envelope(entityRename),
);

server.registerTool(
	"dforge_entity_delete",
	{
		title: "Delete an entity (refactor-safe)",
		description:
			"Refactor-safe deletion of an entity. Removes the entity file + its seed files (listed in `deletes`), drops the manifest entry, role rights key, folder binding, and data-view sources (deleting a view left with no source). Cross-entity FKs targeting it, actions on it, and menus pointing at removed views are surfaced as warnings — fix those by hand. Apply `files` AND `deletes` (or pass apply: true), then run dforge_module_validate.",
		inputSchema: { ...entityDeleteSchema, ...applyInput },
		annotations: DESTRUCTIVE,
	},
	envelope(entityDelete),
);

server.registerTool(
	"dforge_entity_field_add",
	{
		title: "Add a field",
		description:
			"PHASE 1 / backtrack: Add a single new field to an existing entity. Use this (not entity_add) when refining an existing entity — it preserves the rest of the definition. For a RELATION, a ROLL-UP total, or a STATUS column, prefer the composite tools (dforge_entity_reference_add / _rollup_add / _status_add): each of those concepts spans several coordinated keys, and the composite tools emit the whole shape so the broken variants aren't representable.",
		inputSchema: { ...entityFieldAddSchema, ...applyInput },
	},
	envelope(entityFieldAdd),
);

server.registerTool(
	"dforge_entity_field_modify",
	{
		title: "Modify a field",
		description:
			"PHASE 1 / backtrack: Replace an existing field's spec on an entity. Pass the full desired field shape, not a partial diff.",
		inputSchema: { ...entityFieldModifySchema, ...applyInput },
	},
	envelope(entityFieldModify),
);

server.registerTool(
	"dforge_entity_field_remove",
	{
		title: "Remove a field (refactor-safe)",
		description:
			"Refactor-safe field removal. Removes the field AND cascade-cleans the safe dependents: the paired Reference column when you remove its hidden FK, the references entry, view columns + order, and seed-data keys. Formula references and other entities' FKs pointing at the field are surfaced as warnings (not auto-deleted). Run dforge_module_validate after.",
		inputSchema: { ...entityFieldRemoveSchema, ...applyInput },
		annotations: DESTRUCTIVE,
	},
	envelope(entityFieldRemove),
);

server.registerTool(
	"dforge_entity_field_rename",
	{
		title: "Rename a field (refactor-safe)",
		description:
			"Refactor-safe rename of a field. Unlike field_modify, this PROPAGATES the new name to every reference: the paired Reference column's link.thisKey + references block, same-entity formula columns ([oldName] → [newName]), data view columns + order arrays, seed-data records for the entity, and OTHER entities' FKs that target this field. Returns the full set of changed files; review then write, and run dforge_module_validate after to confirm nothing dangles.",
		inputSchema: { ...entityFieldRenameSchema, ...applyInput },
	},
	envelope(entityFieldRename),
);

// ── Composite entity tools — one call per CONCEPT ───────────────────
//
// Each of these spans several coordinated keys that hand-authoring gets wrong.
// They exist so the invalid shapes can't be expressed at all.

server.registerTool(
	"dforge_entity_reference_add",
	{
		title: "Add a relation (FK + Reference)",
		description:
			"PHASE 1: Add a relation between two entities in ONE call. Emits the complete FK+Reference pattern — the documented #1 source of broken modules — as all three of its parts: the hidden FK column (dbDatatype 'cuid', flags 'EM'/'E', no fieldTypeCd), the visible Reference column (columnType 'R', fieldTypeCd 'lookup', flags 'VEM'/'VE', link{entity,thisKey,otherKey}), and the `references` block entry. `required` sets 'M' on both halves in step — 'M' resolves to isNullable:false at install, so it is what makes the FK NOT NULL. Use this instead of two dforge_entity_field_add calls — it can't emit the one-column form that fails install.",
		inputSchema: { ...entityReferenceAddSchema, ...applyInput },
	},
	envelope(entityReferenceAdd),
);

server.registerTool(
	"dforge_entity_rollup_add",
	{
		title: "Add a roll-up total",
		description:
			"PHASE 1: Add a roll-up total over child rows (SUM/COUNT/AVG/MIN/MAX) in ONE call. Emits a GENERATED ('G') column — never a Formula ('F'), whose set-aggregates silently render empty — and creates the parent's Set column if it doesn't exist yet. Refuses to aggregate a virtual F/R/S child column, the documented `column old.<field> does not exist` install failure.",
		inputSchema: { ...entityRollupAddSchema, ...applyInput },
	},
	envelope(entityRollupAdd),
);

server.registerTool(
	"dforge_entity_status_add",
	{
		title: "Add a status column",
		description:
			"PHASE 1: Add a status/stage column in ONE call. Emits a dropdown with params.options ({value,label} objects, never bare strings at the field root) and the initial value as a `formula` — entity fields have NO defaultValue key, which the entity schema rejects outright. An entity with a 3+ value status is also the objective trigger for a kanban view in Phase 3.",
		inputSchema: { ...entityStatusAddSchema, ...applyInput },
	},
	envelope(entityStatusAdd),
);

// ── Behavior (PHASE 2) ──────────────────────────────────────────────

server.registerTool(
	"dforge_action_add",
	{
		title: "Add a DSL action",
		description:
			"PHASE 2: Add a DSL action targeting an entity. Writes logic/actions/<code>.dsl plus an entry in ui/actions.json, and runs the DSL static checker first — errors reject the call. **Load dforge://docs/dsl before authoring.**",
		inputSchema: { ...actionAddSchema, ...applyInput },
	},
	envelope(actionAdd),
);

server.registerTool(
	"dforge_action_check",
	{
		title: "Check action DSL",
		description:
			"PHASE 2: Statically check an action's DSL — either a draft `dslBody` BEFORE calling dforge_action_add, or an `actionCode` already on disk. Catches the documented install/runtime failures without a tenant round trip: TODAY()/NOW() inside execute: ('TODAY is not defined'), [field] record-context in batch mode or a scheduled job, block order/duplication, top-level return, ':param' SQL placeholders (dForge binds '@param'), and unknown host functions. Read files['_action_check.json'].",
		inputSchema: actionCheckSchema,
		annotations: READ_ONLY,
	},
	serialize(actionCheck),
);

server.registerTool(
	"dforge_trigger_add",
	{
		title: "Add a DB-event trigger",
		description:
			"PHASE 2: Add a trigger that fires an action on a DB event (insert/update/delete/status_change/any) optionally gated by a condition formula. Appends to logic/triggers.json. **Use a trigger when the platform should react to data changes WITHOUT user interaction**; use jobs for cron-driven; use webhooks for outbound HTTP. The target action must already exist in ui/actions.json.",
		inputSchema: { ...triggerAddSchema, ...applyInput },
	},
	envelope(triggerAdd),
);

server.registerTool(
	"dforge_job_add",
	{
		title: "Schedule a job",
		description:
			"PHASE 2: Schedule an existing action to fire on a 5-field cron. Appends to logic/jobs.json. The action must NOT use record-context (`[field]`) syntax — scheduled jobs run as the system user with no current record (dforge_module_validate flags this).",
		inputSchema: { ...jobAddSchema, ...applyInput },
	},
	envelope(jobAdd),
);

server.registerTool(
	"dforge_webhook_add",
	{
		title: "Add an outbound webhook",
		description:
			"PHASE 2: Subscribe an outbound HTTP endpoint to a DB event. Appends to logic/webhooks.json. Use for integrations with external systems (Slack, Zapier, custom dashboards).",
		inputSchema: { ...webhookAddSchema, ...applyInput },
	},
	envelope(webhookAdd),
);

// ── Views, menus + reports (PHASE 3) ────────────────────────────────

server.registerTool(
	"dforge_view_add",
	{
		title: "Add a data view",
		description:
			"PHASE 3: Add a data view to ui/data_views.json. viewType-specific viewConfig is supplied verbatim — pull dforge://schema/data-views first to know the shape. Every entity needs a default grid before any specialized view.",
		inputSchema: { ...viewAddSchema, ...applyInput },
	},
	envelope(viewAdd),
);

server.registerTool(
	"dforge_view_modify",
	{
		title: "Modify a data view",
		description: "PHASE 3 / backtrack: Replace an existing view spec. Pass the full desired shape.",
		inputSchema: { ...viewModifySchema, ...applyInput },
	},
	envelope(viewModify),
);

server.registerTool(
	"dforge_menu_add",
	{
		title: "Add a menu item",
		description:
			"PHASE 3: Add a leaf or section to ui/menus.json. Pass dataViewCode for a leaf (validated against ui/data_views.json, and emitted with itemType 'V'); omit it for a section node (which correctly omits itemType). Bootstrap icon names are normalized to the bare form menus require — a leading 'bi-' is stripped, unlike action icons which keep it.",
		inputSchema: { ...menuAddSchema, ...applyInput },
	},
	envelope(menuAdd),
);

server.registerTool(
	"dforge_report_add",
	{
		title: "Add a report",
		description:
			"PHASE 3: Add a report to ui/reports.json. Read dforge://schema/reports for the layout/datasets/parameters shape.",
		inputSchema: { ...reportAddSchema, ...applyInput },
	},
	envelope(reportAdd),
);

// ── Polish (PHASE 4) ────────────────────────────────────────────────

server.registerTool(
	"dforge_setting_add",
	{
		title: "Add a module setting",
		description:
			"PHASE 4 (polish): Add a configurable module-level setting to settings.json. Settings are folder-scoped at runtime — values inherit through the folder tree.",
		inputSchema: { ...settingAddSchema, ...applyInput },
	},
	envelope(settingAdd),
);

server.registerTool(
	"dforge_translation_sync",
	{
		title: "Sync translation files",
		description:
			"PHASE 4: Generate or refresh translations/<locale>.json from what the module actually contains — entity + field labels (including trait-provided columns), views, menus, roles, actions, folders, settings. Existing translated text is NEVER overwritten; missing keys are seeded with the English source so the file is immediately installable. Defaults to en-US plus every manifest.supportedLocales entry — exactly the set install requires. Run it after any entity/view/role change: role labels are completeness-enforced and a missing one FAILS install.",
		inputSchema: { ...translationSyncSchema, ...applyInput },
	},
	envelope(translationSync),
);

server.registerTool(
	"dforge_seed_add",
	{
		title: "Add seed data",
		description:
			"PHASE 4: Write a seed-data file for one entity. Enforces the four documented seed traps: an explicit NUMERIC PK under '{entity}_id' (cuid is int8, not a UUID), parent-before-child load order via the NN- filename prefix, created_by/last_updated_by = 0 (System user) on every record of an audit-full entity, and FK values that point at an already-seeded parent. Also rejects seeding a virtual Reference column instead of its hidden FK.",
		inputSchema: { ...seedAddSchema, ...applyInput },
	},
	envelope(seedAdd),
);

// ── Security (PHASE 5) ──────────────────────────────────────────────

server.registerTool(
	"dforge_role_add",
	{
		title: "Add a role",
		description:
			"PHASE 5: Add a role to security/roles.json. Roles are namespaced (e.g. 'crm.admin'). Rights are S/I/U/D/C for entities, E for actions/reports/folders (which use a COLON prefix). Derive roles from the intake's user types — never a generic admin/contributor/viewer taxonomy the user didn't ask for.",
		inputSchema: { ...roleAddSchema, ...applyInput },
	},
	envelope(roleAdd),
);

server.registerTool(
	"dforge_role_right_set",
	{
		title: "Grant or revoke one right",
		description:
			"PHASE 5 / backtrack: Grant or revoke a single right on a single object for a role. Cheaper than role_add when iterating on the rights matrix, and the correct tool for amending the scaffolded admin role (role_add fails on an existing code).",
		inputSchema: { ...roleRightSetSchema, ...applyInput },
	},
	envelope(roleRightSet),
);

server.registerTool(
	"dforge_folder_add",
	{
		title: "Add a security folder",
		description:
			"PHASE 5 (optional): Add a sub-folder to ui/folders.json. Folders are SECURITY boundaries (row-level filters + per-folder role mappings). Most modules don't need any beyond the root — only use when intake said data must be separated per folder.",
		inputSchema: { ...folderAddSchema, ...applyInput },
	},
	envelope(folderAdd),
);

// ── Cross-cutting ───────────────────────────────────────────────────

server.registerTool(
	"dforge_dependency_add",
	{
		title: "Add a module dependency",
		description:
			"Add a dependency on another dForge module to manifest.json. Use the entities list form when only specific entities are imported (smaller coupling).",
		inputSchema: { ...dependencyAddSchema, ...applyInput },
	},
	envelope(dependencyAdd),
);

server.registerTool(
	"dforge_dbml_import",
	{
		title: "Import entities from DBML",
		description:
			"Generate entities from DBML schema text (a front-end to dforge_module_import). Parses Table blocks, typed columns with [settings], inline [ref: > t.c] and top-level Ref: lines; drops the source PK (the identity trait provides {entity}_id), infers field types via the metadata registry, and builds the FK+Reference pair per relationship. Pass `module` when the dir has no manifest (greenfield). Review inferred types + run dforge_module_validate after.",
		inputSchema: { ...dbmlImportSchema, ...applyInput },
	},
	envelope(dbmlImport),
);

// ── Resources ───────────────────────────────────────────────────────
//
// registerResource (unlike the deprecated `resource()`) carries the
// description + mimeType into the client's resource listing, so the agent can
// tell what a dforge:// URI is for before pulling it.

for (const res of resources) {
	server.registerResource(
		res.name,
		res.uri,
		{ description: res.description, mimeType: res.mimeType },
		async (uri) => ({
			contents: [{ uri: uri.href, mimeType: res.mimeType, text: res.read() }],
		}),
	);
}

// ── Boot ────────────────────────────────────────────────────────────

(async () => {
	const transport = new StdioServerTransport();
	await server.connect(transport);
	// MCP servers must NOT log to stdout — stdout is the JSON-RPC wire.
	// stderr is safe for diagnostics.
	process.stderr.write("[dforge-mcp] connected via stdio\n");
})().catch((err) => {
	process.stderr.write(`[dforge-mcp] fatal: ${(err as Error).message}\n`);
	process.exit(1);
});
