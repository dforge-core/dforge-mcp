import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createModuleSchema, createModuleFiles } from "./tools/create-module";
import { addEntitySchema, addEntityFiles } from "./tools/add-entity";
import {
	packModuleSchema,
	packModule,
	installModuleSchema,
	installModule,
	dbmlImportSchema,
	dbmlImport,
} from "./tools/native-shell";
import { resources } from "./resources";

const server = new McpServer({
	name: "dforge-mcp",
	version: "0.1.0",
});

// ── Tools ───────────────────────────────────────────────────────────

server.tool(
	"dforge_module_create",
	"Build the file map for a brand-new dForge module. Returns { files: { '<relPath>': '<contents>' } } — the client decides whether to write them. Always preview the file map with the user before writing.",
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
	"dforge_entity_add",
	"Add an entity to an existing module. Reads manifest from disk, returns the updated file map (manifest + new entity + regenerated UI/security). Other files on disk are NOT touched.",
	addEntitySchema,
	async (args) => {
		const { files, warning } = addEntityFiles(args);
		return {
			content: [
				{
					type: "text",
					text: JSON.stringify(
						{
							summary: `Adds entity '${args.entity.name}' to ${args.moduleDir}. ${Object.keys(files).length} files changed.`,
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
	"dforge_module_pack",
	"Pack a module directory into a .dforge tarball. Requires the dforge-cli native binary on PATH (or set DFORGE_CLI_BINARY).",
	packModuleSchema,
	async (args) => {
		const result = packModule(args);
		return {
			content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
		};
	},
);

server.tool(
	"dforge_module_install",
	"Install a module (directory or .dforge tarball) to a running tenant. Reads DFORGE_URL / DFORGE_TOKEN env if not passed as args.",
	installModuleSchema,
	async (args) => {
		const result = installModule(args);
		return {
			content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
			isError: !result.ok,
		};
	},
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
