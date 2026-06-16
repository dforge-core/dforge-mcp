import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createModuleSchema, createModuleFiles } from "./tools/create-module";
import { planModuleSchema, planModule } from "./tools/plan-module";
import { addEntitySchema, addEntityFiles } from "./tools/add-entity";
import { moduleImportSchema, moduleImport, dbmlImportSchema, dbmlImport } from "./tools/import";
import { xlsxExtractSchema, xlsxExtract } from "./tools/xlsx-extract";
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
import { viewAddSchema, viewAdd, viewModifySchema, viewModify } from "./tools/view";
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
import type { ToolResult } from "./tools/_helpers";
import { resources } from "./resources";

const server = new McpServer({
	name: "dforge-mcp",
	version: "0.1.0",
});

// Standard envelope for tools that return a ToolResult. Wraps the result
// as MCP content (JSON-in-text) so the LLM can parse it. Used by every
// patch/add tool — keeps the server.ts wiring DRY.
function envelope<T>(fn: (a: T) => ToolResult) {
	return async (args: T) => {
		try {
			const r = fn(args);
			return {
				content: [{ type: "text" as const, text: JSON.stringify(r, null, 2) }],
			};
		} catch (e) {
			return {
				content: [
					{ type: "text" as const, text: `Error: ${(e as Error).message}` },
				],
				isError: true,
			};
		}
	};
}

// ── Module-level tools ──────────────────────────────────────────────

server.tool(
	"dforge_module_plan",
	"Phase 0 owner — CALL THIS FIRST for any new or resumed module task. Drives the full Phase 0 workflow: 'check' returns current state and exact next steps; 'write_identity' (0a) writes CLAUDE.md; 'write_requirements' (0b) confirms docs/REQUIREMENTS.md (already written to disk by the agent) after user confirms YES and ticks CLAUDE.md; 'write_design' (0c) confirms docs/DESIGN.md (already written to disk by the agent) after user confirms YES and ticks CLAUDE.md; 'validate' (0d) runs pre-scaffold checks and writes docs/VALIDATION.md when all pass. dforge_module_create is blocked until this tool reports readyToScaffold: true.",
	planModuleSchema,
	async (args) => {
		try {
			const result = planModule(args);
			return {
				content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
			};
		} catch (e) {
			return {
				content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }],
				isError: true,
			};
		}
	},
);

server.tool(
	"dforge_module_create",
	"Scaffold a new dForge module (Phase 1). ⛔ REQUIRES Phase 0 complete — call dforge_module_plan first. Blocked until CLAUDE.md, docs/REQUIREMENTS.md, docs/DESIGN.md, and docs/VALIDATION.md (all-pass) exist in moduleDir. Returns { files: { '<relPath>': '<contents>' } } — always preview with user before writing.",
	createModuleSchema,
	async (args) => {
		const files = createModuleFiles(args);
		return {
			content: [
				{
					type: "text",
					text: JSON.stringify(
						{
							summary: `Generated ${Object.keys(files).length} files for module '${args.code}' (preset: ${args.preset}, ${args.entities.length} entit${args.entities.length === 1 ? "y" : "ies"}).`,
							files,
						},
						null,
						2,
					),
				},
			],
		};
	},
);

server.tool(
	"dforge_module_inspect",
	"Read the current state of an existing module from disk and return a structured summary. Call this BEFORE any patch tool so you know what entities/views/roles already exist and don't try to re-create them.",
	moduleInspectSchema,
	envelope(moduleInspect),
);

server.tool(
	"dforge_module_validate",
	"Validate the whole module OFFLINE before packing/installing: checks cross-references the per-field tools can't see — dangling FK/reference targets, a missing hidden-FK column, view dataSources/columns pointing at unknown entities/fields, menu dataViewCode → missing view, role rights keyed on unknown entities/actions/reports, and entities with no Select grant. Returns errors + warnings in _validate.json. Run this after authoring and fix every error BEFORE dforge_module_pack — it saves a slow pack/install round trip.",
	moduleValidateSchema,
	envelope(moduleValidate),
);

server.tool(
	"dforge_module_pack",
	"Pack a module directory into a .dforge tarball. Requires the dforge-cli native binary on PATH (or set DFORGE_CLI_BINARY).",
	packModuleSchema,
	async (args) => {
		const result = packModule(args);
		return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
	},
);

server.tool(
	"dforge_module_install",
	"PHASE 6: Install a module (directory or .dforge tarball) to a running tenant. Runs the FULL server-side validator — the only real validator. Reads DFORGE_URL / DFORGE_TOKEN env if not passed as args.",
	installModuleSchema,
	async (args) => {
		const result = installModule(args);
		return {
			content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
			isError: !result.ok,
		};
	},
);

// ── Entity patch tools ──────────────────────────────────────────────

server.tool(
	"dforge_entity_add",
	"PHASE 2: Add an entity to an existing module. Reads manifest from disk, returns the updated file map (manifest + new entity + regenerated UI/security). Other files on disk are NOT touched.",
	addEntitySchema,
	async (args) => {
		const { files, warning } = addEntityFiles(args);
		return {
			content: [
				{
					type: "text",
					text: JSON.stringify(
						{
							summary: `Adds entity '${args.entity.name}' to ${args.moduleDir}.`,
							warning,
							files,
						},
						null,
						2,
					),
				},
			],
		};
	},
);

server.tool(
	"dforge_module_import",
	"Import a normalized table-spec (tables → columns → relationships) into an existing module as entities. Infers each column's fieldTypeCd from an explicit code, a source SQL type (sqlType), sample values, and name heuristics (validated against the metadata registry; dbDatatype derived), and generates the FK+Reference two-column pattern for each relationship. The front-end that produces the table-spec can be DBML/SQL, an Excel/CSV upload, or hand-authored. Scaffold a minimal module first; this ADDS entities and regenerates default views/menus/roles. Review inferred types and run dforge_module_validate after.",
	moduleImportSchema,
	envelope(moduleImport),
);

server.tool(
	"dforge_entity_rename",
	"Refactor-safe rename of an entity code. Moves the entity file (old is listed in the response's `deletes` — delete it), renames the manifest key, cascades the identity PK {old}_id → {new}_id wherever an FK targets it, and repoints every reference: other entities' link.entity / references.to, view entityCode, role rights keys, action entity, folder bindings, and seed-data entityCode + PK keys. Reports/translations/menu labels/DSL are NOT rewritten (warned). Apply `files` AND `deletes`, then run dforge_module_validate.",
	entityRenameSchema,
	envelope(entityRename),
);

server.tool(
	"dforge_entity_delete",
	"Refactor-safe deletion of an entity. Removes the entity file + its seed files (listed in `deletes`), drops the manifest entry, role rights key, folder binding, and data-view sources (deleting a view left with no source). Cross-entity FKs targeting it, actions on it, and menus pointing at removed views are surfaced as warnings — fix those by hand. Apply `files` AND `deletes`, then run dforge_module_validate.",
	entityDeleteSchema,
	envelope(entityDelete),
);

server.tool(
	"dforge_entity_field_add",
	"PHASE 2 / backtrack: Add a single new field to an existing entity. Use this (not entity_add) when refining an existing entity — preserves the rest of the entity definition.",
	entityFieldAddSchema,
	envelope(entityFieldAdd),
);

server.tool(
	"dforge_entity_field_modify",
	"PHASE 2 / backtrack: Replace an existing field's spec on an entity. Pass the full desired field shape, not a partial diff.",
	entityFieldModifySchema,
	envelope(entityFieldModify),
);

server.tool(
	"dforge_entity_field_remove",
	"Refactor-safe field removal. Removes the field AND cascade-cleans the safe dependents: the paired Reference column when you remove its hidden FK, the references entry, view columns + order, and seed-data keys. Formula references and other entities' FKs pointing at the field are surfaced as warnings (not auto-deleted). Run dforge_module_validate after.",
	entityFieldRemoveSchema,
	envelope(entityFieldRemove),
);

server.tool(
	"dforge_entity_field_rename",
	"Refactor-safe rename of a field. Unlike field_modify, this PROPAGATES the new name to every reference: the paired Reference column's link.thisKey + references block, same-entity formula columns ([oldName] → [newName]), data view columns + order arrays, seed-data records for the entity, and OTHER entities' FKs that target this field. Returns the full set of changed files; review then write, and run dforge_module_validate after to confirm nothing dangles.",
	entityFieldRenameSchema,
	envelope(entityFieldRename),
);

// ── Behavior (PHASE 3) ──────────────────────────────────────────────

server.tool(
	"dforge_action_add",
	"PHASE 2: Add a DSL action targeting an entity. Writes logic/actions/<code>.dsl plus an entry in ui/actions.json. **Load dforge://docs/dsl before authoring.**",
	actionAddSchema,
	envelope(actionAdd),
);

server.tool(
	"dforge_trigger_add",
	"PHASE 2: Add a trigger that fires an action on a DB event (insert/update/delete/status_change/any) optionally gated by a condition formula. Appends to logic/triggers.json. **Use trigger when the platform should react to data changes WITHOUT user interaction**; use jobs for cron-driven; use webhooks for outbound HTTP.",
	triggerAddSchema,
	envelope(triggerAdd),
);

server.tool(
	"dforge_job_add",
	"PHASE 2: Schedule an existing action to fire on a 5-field cron. Appends to logic/jobs.json. Action must NOT use record-context (`[field]`) syntax — scheduled jobs run as system user with no current record.",
	jobAddSchema,
	envelope(jobAdd),
);

server.tool(
	"dforge_webhook_add",
	"PHASE 2: Subscribe an outbound HTTP endpoint to a DB event. Appends to logic/webhooks.json. Use for integrations with external systems (Slack, Zapier, custom dashboards).",
	webhookAddSchema,
	envelope(webhookAdd),
);

// ── Views + reports (PHASE 4) ───────────────────────────────────────

server.tool(
	"dforge_view_add",
	"PHASE 4: Add a data view to ui/data_views.json. viewType-specific viewConfig is supplied verbatim — pull dforge://schema/data-views first to know the shape.",
	viewAddSchema,
	envelope(viewAdd),
);

server.tool(
	"dforge_view_modify",
	"PHASE 4 / backtrack: Replace an existing view spec. Pass the full desired shape.",
	viewModifySchema,
	envelope(viewModify),
);

server.tool(
	"dforge_report_add",
	"PHASE 4: Add a report to ui/reports.json. Read dforge://schema/reports for the layout/datasets/parameters shape.",
	reportAddSchema,
	envelope(reportAdd),
);

server.tool(
	"dforge_setting_add",
	"PHASE 4 (polish): Add a configurable module-level setting to settings.json. Settings are folder-scoped at runtime — values inherit through the folder tree.",
	settingAddSchema,
	envelope(settingAdd),
);

// ── Security (PHASE 5) ──────────────────────────────────────────────

server.tool(
	"dforge_role_add",
	"PHASE 5: Add a role to security/roles.json. Roles are namespaced (e.g. 'crm.admin'). Rights are S/I/U/D/C for entities, E for actions/reports.",
	roleAddSchema,
	envelope(roleAdd),
);

server.tool(
	"dforge_role_right_set",
	"PHASE 5 / backtrack: Grant or revoke a single right on a single object for a role. Cheaper than role_add when iterating on rights matrix.",
	roleRightSetSchema,
	envelope(roleRightSet),
);

server.tool(
	"dforge_folder_add",
	"PHASE 5 (optional): Add a sub-folder to ui/folders.json. Folders are SECURITY boundaries (row-level filters + per-folder role mappings). Most modules don't need any beyond the root — only use when intake said data must be separated per folder.",
	folderAddSchema,
	envelope(folderAdd),
);

// ── Cross-cutting ───────────────────────────────────────────────────

server.tool(
	"dforge_dependency_add",
	"Add a dependency on another dForge module to manifest.json. Use the entities list form when only specific entities are imported (smaller coupling).",
	dependencyAddSchema,
	envelope(dependencyAdd),
);

server.tool(
	"dforge_dbml_import",
	"Generate entities from DBML schema text (a front-end to dforge_module_import). Parses Table blocks, typed columns with [settings], inline [ref: > t.c] and top-level Ref: lines; drops the source PK (the identity trait provides {entity}_id), infers field types via the metadata registry, and builds the FK+Reference pair per relationship. Pass `module` when the dir has no manifest (greenfield). Review inferred types + run dforge_module_validate after.",
	dbmlImportSchema,
	envelope(dbmlImport),
);

server.tool(
	"dforge_xlsx_extract",
	"Extract sheets, headers, and sample rows from an .xlsx file into a JSON model ready for dforge_module_import. " +
		"Returns { sheets: [{ name, headers, rows }] }. Call this first when the user provides an Excel file — " +
		"do NOT attempt to read the binary .xlsx directly. " +
		"Falls back: if the file is a .csv, read it directly (plain text, no tool needed). " +
		"See dforge://reference/excel-import for the full import flow.",
	xlsxExtractSchema,
	async (args) => {
		try {
			const result = xlsxExtract(args);
			return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
		} catch (e) {
			return {
				content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }],
				isError: true,
			};
		}
	},
);

// ── Resources ───────────────────────────────────────────────────────

for (const res of resources) {
	server.resource(res.name, res.uri, async (uri) => ({
		contents: [
			{
				uri: uri.href,
				mimeType: res.mimeType,
				text: res.read(),
			},
		],
	}));
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
