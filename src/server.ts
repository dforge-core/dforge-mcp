import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createModuleSchema, createModuleFiles } from "./tools/create-module";
import { planModuleSchema, planModule } from "./tools/plan-module";
import { addEntitySchema, addEntityFiles } from "./tools/add-entity";
import {
	packModuleSchema,
	packModule,
	installModuleSchema,
	installModule,
	dbmlImportSchema,
	dbmlImport,
} from "./tools/native-shell";
import {
	entityFieldAddSchema,
	entityFieldAdd,
	entityFieldModifySchema,
	entityFieldModify,
	entityFieldRemoveSchema,
	entityFieldRemove,
} from "./tools/entity-field";
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
	"Phase 0 owner — CALL THIS FIRST for any new or resumed module task. Drives the full Phase 0 workflow: 'check' returns current state and exact next steps; 'write_identity' (0a) writes CLAUDE.md; 'write_requirements' (0b) writes docs/REQUIREMENTS.md after user confirms YES; 'write_design' (0c) writes docs/DESIGN.md after user confirms YES; 'validate' (0d) runs pre-scaffold checks and writes docs/VALIDATION.md when all pass. dforge_module_create is blocked until this tool reports readyToScaffold: true.",
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
	"PHASE 2 / backtrack: Remove a field from an entity. WARNING: may break dependent views, role rights, formulas, action DSL, seed data — re-run dforge_module_inspect after.",
	entityFieldRemoveSchema,
	envelope(entityFieldRemove),
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
	"Generate a module from DBML schema text. Currently a stub — underlying dforge-cli command is not implemented.",
	dbmlImportSchema,
	async (args) => {
		const result = dbmlImport(args);
		return {
			content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
			isError: true,
		};
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
