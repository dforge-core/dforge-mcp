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

// Tool input schema. zod gives us both validation and a JSON schema MCP
// can advertise to clients (so the LLM sees argument types).
export const createModuleSchema = {
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
		.default([])
		.describe("Other modules this one requires, by code (e.g. ['parties']). Leave empty unless it genuinely depends on another module. Do NOT list 'admin' or 'metadata' — they're system modules present in every tenant, so depending on them is redundant (the check always passes and never affects install order)."),
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
