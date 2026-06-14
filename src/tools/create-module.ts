import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
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
import { traitsInput, withTraits, isReadyToScaffold, PHASE_STATE_FILE } from "./_helpers";

// Tool input schema. zod gives us both validation and a JSON schema MCP
// can advertise to clients (so the LLM sees argument types).
export const createModuleSchema = {
	moduleDir: z
		.string()
		.describe(
			"Absolute path to the directory where the module will be written. Phase 0 must be validated first — dforge_module_plan validate writes a docs/phase.json marker that this gate reads (readyToScaffold: true).",
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
				traits: traitsInput,
			}),
		)
		.min(1)
		.describe("At least one entity. Each entity gets a stub JSON, a default grid view, a menu item, and rights in the admin role."),
};

function assertPhase0Complete(moduleDir: string): void {
	const root = path.resolve(moduleDir);
	const required = [
		{ rel: "CLAUDE.md", phase: "0a" },
		{ rel: "docs/REQUIREMENTS.md", phase: "0b" },
		{ rel: "docs/DESIGN.md", phase: "0c" },
		{ rel: "docs/VALIDATION.md", phase: "0d" },
	];

	const missing = required.filter((f) => !fs.existsSync(path.join(root, f.rel)));
	if (missing.length > 0) {
		const lines = missing.map((f) => `  ✗ Phase ${f.phase}: ${f.rel}`).join("\n");
		throw new Error(
			`Phase 0 incomplete — cannot scaffold yet.\n${lines}\n\nRun dforge_module_plan({ action: "check", moduleDir: "${moduleDir}" }) to see what's needed.`,
		);
	}

	if (!isReadyToScaffold(root)) {
		throw new Error(
			`Phase 0 incomplete — design validation has not passed (no readyToScaffold marker in ${PHASE_STATE_FILE} or docs/VALIDATION.md).\n\nRun dforge_module_plan({ action: "validate", moduleDir: "${moduleDir}" }) to complete Phase 0d.`,
		);
	}
}

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
	assertPhase0Complete(args.moduleDir);
	const moduleId = randomUUID();

	// The trait codes the author chose, kept per-entity. The builders take an
	// EntitySpec whose `traits` is one of two presets and only use it to seed
	// the codes array — so pass a placeholder preset to the builders and apply
	// the real (metadata-validated) codes to each entity JSON below.
	const traitsByName: Record<string, string[]> = {};
	const specEntities: EntitySpec[] = args.entities.map((e) => {
		traitsByName[e.name] = e.traits;
		return { name: e.name, label: e.label, traits: "identity" };
	});

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
		entities: specEntities,
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
		write(`entities/${e.name}.json`, withTraits(buildEntity(e), traitsByName[e.name]));
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
