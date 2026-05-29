import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
	buildManifest,
	buildEntity,
	buildDataViews,
	buildFolders,
	buildMenus,
	buildRoles,
	buildActions,
	buildSettings,
	buildTranslations,
	buildSeedData,
	buildGitignore,
	buildVscodeSettings,
	buildZedSettings,
} from "@dforge-core/dforge-cli/templates";
import type {
	EntitySpec,
	Preset,
	ScaffoldOpts,
} from "@dforge-core/dforge-cli/templates";
import { makeResult, type ToolResult } from "./_helpers";
import { readArtifactsState } from "./artifacts";

// Tool input schema. zod gives us both validation and a JSON schema MCP
// can advertise to clients (so the LLM sees argument types).
export const createModuleSchema = {
	moduleDir: z
		.string()
		.optional()
		.describe(
			"Directory where the module files will be written. " +
			"When provided, dforge_design_write must have been called first — scaffolding is blocked until docs/DESIGN.md is confirmed.",
		),
	code: z
		.string()
		.regex(/^[a-z][a-z0-9_-]*$/)
		.describe("Module code, e.g. 'crm' or 'hr-admin'. Lowercase, digits, underscore, hyphen; first char a letter."),
	displayName: z.string().min(1).describe("Human-readable module name."),
	description: z.string().optional().describe("Optional short description."),
	author: z.string().optional().describe("Author display name."),
	license: z.string().default("MIT"),
	version: z
		.string()
		.regex(/^\d+\.\d+\.\d+(-[\w.]+)?$/)
		.default("0.1.0"),
	dbSchemaVersion: z
		.string()
		.regex(/^\d+\.\d+\.\d+(-[\w.]+)?$/)
		.default("0.0.1"),
	dependencies: z
		.array(z.string())
		.default(["admin", "metadata"])
		.describe("System modules this module depends on. Usually ['admin', 'metadata']."),
	preset: z
		.enum(["minimal", "minimal-plus", "full"])
		.default("minimal")
		.describe("'minimal' = manifest+entity+UI+role only. 'full' = also settings/translations/seed-data/logic stubs. 'minimal-plus' behaves like 'minimal' here since MCP can't loop; pass all entities up-front."),
	entities: z
		.array(
			z.object({
				name: z
					.string()
					.regex(/^[a-z][a-z0-9_]*$/)
					.describe("Entity code, e.g. 'customer'. Lowercase, digits, underscore; first char a letter."),
				label: z.string().min(1),
				traits: z
					.enum(["identity", "identity+audit"])
					.default("identity+audit"),
			}),
		)
		.min(1)
		.describe("At least one entity. Each entity gets a stub JSON, a default grid view, a menu item, and rights in the admin role."),
};

/**
 * Build the full file map for a new module. Returns paths relative to the
 * module root, NOT absolute paths — the MCP client decides where to write.
 *
 * This is the pure, return-not-write version. The CLI's `init module`
 * command does the equivalent + writes to disk.
 */
export function createModuleFiles(
	args: z.infer<z.ZodObject<typeof createModuleSchema>>,
): Record<string, string> {
	const moduleId = randomUUID();

	const opts: ScaffoldOpts = {
		path: "",  // unused: builders don't write paths into output
		code: args.code,
		displayName: args.displayName,
		description: args.description ?? "",
		author: args.author ?? "",
		license: args.license,
		version: args.version,
		dbSchemaVersion: args.dbSchemaVersion,
		dependencies: args.dependencies,
		preset: args.preset as Preset,
		entities: args.entities as EntitySpec[],
	};

	const files: Record<string, string> = {};
	const write = (rel: string, obj: unknown) => {
		files[rel] = JSON.stringify(obj, null, "\t") + "\n";
	};
	const writeText = (rel: string, text: string) => {
		files[rel] = text;
	};

	// Minimal set — every preset writes these.
	write("manifest.json", buildManifest(opts, moduleId));
	for (const e of opts.entities) {
		write(`entities/${e.name}.json`, buildEntity(e));
	}
	write("ui/data_views.json", buildDataViews(opts.entities));
	write("ui/folders.json", buildFolders(opts));
	write("ui/menus.json", buildMenus(opts));
	write("ui/actions.json", buildActions());
	write("security/roles.json", buildRoles(opts));
	writeText(".gitignore", buildGitignore());

	// Editor-bindings (see templates.ts for rationale): inline JSON
	// validation + autocomplete in VS Code & Zed with zero per-user setup.
	write(".vscode/settings.json", buildVscodeSettings());
	write(".zed/settings.json", buildZedSettings());

	// CLAUDE.md — project-level context for Claude Code. Written so that
	// future sessions on this module directory automatically know to use the
	// dforge-mcp-author skill and the dforge_* MCP tool surface.
	writeText("CLAUDE.md", buildClaudeMd(args.code, args.displayName, args.description));

	// Full preset adds the optional-but-typical extras.
	if (opts.preset === "full") {
		write("settings.json", buildSettings());
		write("translations/en-US.json", buildTranslations(opts));
		for (const e of opts.entities) {
			write(`seed-data/01-${e.name}.json`, buildSeedData());
		}
		// .gitkeep — empty file, signals presence of an empty dir.
		writeText("logic/actions/.gitkeep", "");
	}

	return files;
}

/**
 * Gate-aware wrapper around createModuleFiles.
 *
 * When moduleDir is provided the caller must have run dforge_design_write
 * first — we refuse to scaffold until docs/DESIGN.md is confirmed in
 * .dforge-artifacts.json. This ensures the entity list and relationship map
 * are reviewed before any files are created.
 */
export function createModule(
	args: z.infer<z.ZodObject<typeof createModuleSchema>>,
): ToolResult {
	if (args.moduleDir) {
		const state = readArtifactsState(path.resolve(args.moduleDir));
		if (!state.designAt) {
			throw new Error(
				"Design artifact not found. " +
				"Call dforge_requirements_write then dforge_design_write before dforge_module_create. " +
				"This ensures the module's entity list and relationship map are reviewed and approved before files are created.",
			);
		}
	}

	const files = createModuleFiles(args);
	return makeResult(
		`Generated ${Object.keys(files).length} files for module '${args.code}' ` +
		`(preset: ${args.preset}, ${args.entities.length} entit${args.entities.length === 1 ? "y" : "ies"}).`,
		files,
	);
}

/**
 * Build the CLAUDE.md content for the new module's project root.
 *
 * This file is read by Claude Code at session start, so future sessions on
 * this module directory automatically pick up the MCP co-pilot context
 * without the user having to explain the setup each time.
 */
function buildClaudeMd(code: string, displayName: string, description?: string): string {
	const descLine = description ? `\n${description}\n` : "";
	return `# CLAUDE.md
${descLine}
This is a **dForge module** (\`${code}\` — ${displayName}).
\`@dforge-core/dforge-mcp\` is connected as an MCP server.

## Always use the dforge-mcp-author skill

When the user asks to build, edit, scaffold, or review any module content —
entities, actions, data views, menus, security roles, reports, translations,
seed data, manifest — invoke the \`dforge-mcp-author\` skill before writing
any files. The skill (in \`.claude/skills/dforge-mcp-author/\`) carries 22+
reference files and a \`simple-todo\` example. Do not author module files
from first principles; use the \`dforge_*\` MCP tool surface.

## All file changes go through MCP tools

Never write module JSON directly. All file creation and editing happens through
\`dforge_*\` tool calls (\`entity_add\`, \`entity_field_add\`, \`view_add\`,
\`role_add\`, etc.). The SKILL.md wizard guides the 6-phase authoring flow.

## Pack and install

- Pack:    \`dforge_module_pack\`    → produces a \`.dforge\` tarball
- Install: \`dforge_module_install\` → installs to a live tenant (real validator)

Requires \`DFORGE_URL\` and \`DFORGE_TOKEN\` environment variables for install.

## Module layout

- \`manifest.json\` — module id, code, version, dependencies
- \`entities/*.json\` — one file per entity
- \`logic/actions/*.dsl\` — action DSL scripts
- \`ui/data_views.json\`, \`ui/menus.json\`, \`ui/folders.json\`, \`ui/actions.json\`
- \`security/roles.json\`
- \`seed-data/*.json\` — numbered for load order (01-, 02-, …)
- \`translations/<locale>.json\` — e.g. \`en-US.json\`
- \`settings.json\`
`;
}
