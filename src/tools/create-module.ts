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
import { makeResult, jsonText, type ToolResult } from "./_helpers";
import { readArtifactsState } from "./artifacts";
import { buildClaudeMd, type ModuleIdentity, type ModuleStatus } from "./claude-md";

// Tool input schema. zod gives us both validation and a JSON schema MCP
// can advertise to clients (so the LLM sees argument types).
export const createModuleSchema = {
	moduleDir: z
		.string()
		.optional()
		.describe(
			"Directory where the module files will be written. " +
			"When provided, Phase 0 must be complete: dforge_module_init + dforge_requirements_write + dforge_design_write, and dforge_design_validate (Phase 0d) must have passed — scaffolding is blocked until verifiedAt is set.",
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
	// dforge-mcp-author skill and the dforge_* MCP tool surface. The gate-aware
	// wrapper (createModule) overrides this with a state-derived version when a
	// moduleDir is given; this fallback covers the no-moduleDir one-shot path.
	const t = new Date().toISOString().slice(0, 10);
	const identity: ModuleIdentity = {
		code: args.code,
		displayName: args.displayName,
		description: args.description,
		dependencies: args.dependencies,
	};
	const oneShotStatus: ModuleStatus = {
		identityAt: t,
		requirementsAt: t,
		designAt: t,
		verifiedAt: t,
		scaffoldedAt: t,
	};
	writeText("CLAUDE.md", buildClaudeMd(identity, oneShotStatus));

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
 * When moduleDir is provided we refuse to scaffold until Phase 0d validation
 * has passed (verifiedAt set in .dforge-artifacts.json). This ensures the
 * requirements and design are written, reviewed, validated, and approved
 * before any files are created. The wrapper also re-renders CLAUDE.md from the
 * stored identity with the build marked complete, and records scaffoldedAt.
 */
export function createModule(
	args: z.infer<z.ZodObject<typeof createModuleSchema>>,
): ToolResult {
	const files = createModuleFiles(args);

	if (args.moduleDir) {
		const state = readArtifactsState(path.resolve(args.moduleDir));
		if (!state.verifiedAt) {
			throw new Error(
				"Phase 0d validation has not passed. " +
				"Run dforge_module_init → dforge_requirements_write → dforge_design_write → dforge_design_validate " +
				"(and resolve every finding) before dforge_module_create. " +
				"This ensures requirements and design are reviewed, validated, and approved before any files are created.",
			);
		}

		// Re-render CLAUDE.md from the stored identity with the build complete,
		// and persist scaffoldedAt so the status tracker and resume logic stay
		// accurate. Falls through to the args-derived CLAUDE.md when no identity
		// was captured (legacy/one-shot state).
		const t = new Date().toISOString().slice(0, 10);
		const status: ModuleStatus = { ...stripIdentity(state), scaffoldedAt: t };
		const identity: ModuleIdentity = {
			code: state.code ?? args.code,
			displayName: state.displayName ?? args.displayName,
			description: state.description ?? args.description,
			dependencies: state.dependencies ?? args.dependencies,
			locales: state.locales,
		};
		files["CLAUDE.md"] = buildClaudeMd(identity, status);
		files[".dforge-artifacts.json"] = jsonText({ ...state, scaffoldedAt: t });
	}

	return makeResult(
		`Generated ${Object.keys(files).length} files for module '${args.code}' ` +
		`(preset: ${args.preset}, ${args.entities.length} entit${args.entities.length === 1 ? "y" : "ies"}).`,
		files,
	);
}

/** Keep only the phase-timestamp fields of the artifact state for status rendering. */
function stripIdentity(state: ReturnType<typeof readArtifactsState>): ModuleStatus {
	return {
		identityAt: state.identityAt,
		requirementsAt: state.requirementsAt,
		designAt: state.designAt,
		verifiedAt: state.verifiedAt,
		scaffoldedAt: state.scaffoldedAt,
	};
}

