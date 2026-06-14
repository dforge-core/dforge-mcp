import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import {
	buildEntity,
	buildDataViews,
	buildFolders,
	buildMenus,
	buildRoles,
} from "@dforge-core/dforge-cli/templates";
import type { EntitySpec, ScaffoldOpts } from "@dforge-core/dforge-cli/templates";
import { traitsInput, withTraits } from "./_helpers";

export const addEntitySchema = {
	moduleDir: z
		.string()
		.describe("Absolute or relative path to an existing module directory (contains manifest.json)."),
	entity: z.object({
		name: z.string().regex(/^[a-z][a-z0-9_]*$/),
		label: z.string().min(1),
		traits: traitsInput,
	}),
};

/**
 * Read an existing module, return the FULL updated file map for files that
 * change (new entity + patched manifest + patched UI/security JSONs).
 *
 * The MCP client writes only the returned files; everything else on disk
 * stays untouched. This lets the LLM preview the diff before committing.
 */
export function addEntityFiles(
	args: z.infer<z.ZodObject<typeof addEntitySchema>>,
): { files: Record<string, string>; warning?: string } {
	const root = path.resolve(args.moduleDir);
	const manifestPath = path.join(root, "manifest.json");
	if (!fs.existsSync(manifestPath)) {
		throw new Error(`No manifest.json found at ${manifestPath}`);
	}

	const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
	if (!manifest.code) {
		throw new Error("manifest.json has no `code` field — corrupt module?");
	}

	// Refuse if entity already exists. The AI should call create_module or
	// directly edit the entity JSON if it wants to evolve an existing one.
	const newName = args.entity.name;
	if (manifest.entities && manifest.entities[newName]) {
		throw new Error(
			`Entity '${newName}' already exists in this module. ` +
				`Edit entities/${newName}.json directly, or pick a different name.`,
		);
	}

	// Recompose the full entity list (existing + new) for the builders that
	// regenerate UI/security per-entity (views, menus, roles).
	const existingEntities: EntitySpec[] = Object.keys(manifest.entities ?? {}).map(
		(name) => ({
			name,
			label: tryReadEntityLabel(root, name) ?? name,
			// Traits — we don't read them from disk because they don't matter
			// for view/menu/role generation. Use a sentinel.
			traits: "identity+audit",
		}),
	);

	const newEntity: EntitySpec = {
		name: args.entity.name,
		label: args.entity.label,
		// Placeholder preset for the view/menu/role builders (they ignore traits);
		// the real validated trait codes are applied to the entity JSON below.
		traits: "identity",
	};
	const allEntities = [...existingEntities, newEntity];

	const opts: ScaffoldOpts = {
		path: root,
		code: manifest.code,
		displayName: manifest.displayName ?? manifest.code,
		description: manifest.description ?? "",
		author: manifest.author?.name ?? "",
		license: manifest.license ?? "MIT",
		version: manifest.version ?? "0.1.0",
		dbSchemaVersion: manifest.dbSchemaVersion ?? "0.0.1",
		dependencies: Object.keys(manifest.dependencies ?? {}),
		preset: "minimal",
		entities: allEntities,
	};

	// Patched manifest: add the new entity to the entities map, bump updated date.
	const newManifest = {
		...manifest,
		entities: {
			...(manifest.entities ?? {}),
			[newEntity.name]: `./entities/${newEntity.name}.json`,
		},
		updated: new Date().toISOString().slice(0, 10),
	};

	const files: Record<string, string> = {};
	files["manifest.json"] = JSON.stringify(newManifest, null, "\t") + "\n";
	files[`entities/${newEntity.name}.json`] =
		JSON.stringify(withTraits(buildEntity(newEntity), args.entity.traits), null, "\t") + "\n";
	files["ui/data_views.json"] =
		JSON.stringify(buildDataViews(allEntities), null, "\t") + "\n";
	files["ui/folders.json"] =
		JSON.stringify(buildFolders(opts), null, "\t") + "\n";
	files["ui/menus.json"] =
		JSON.stringify(buildMenus(opts), null, "\t") + "\n";
	files["security/roles.json"] =
		JSON.stringify(buildRoles(opts), null, "\t") + "\n";

	let warning: string | undefined;
	if (existingEntities.length > 0) {
		warning =
			"Re-generated ui/data_views.json, ui/folders.json, ui/menus.json, " +
			"security/roles.json from manifest + builders — any hand-edits to " +
			"those files for OTHER entities will be overwritten if you write " +
			"the returned files as-is. Diff before writing.";
	}

	return { files, warning };
}

function tryReadEntityLabel(root: string, name: string): string | undefined {
	try {
		const e = JSON.parse(
			fs.readFileSync(path.join(root, "entities", `${name}.json`), "utf8"),
		);
		return e.description as string | undefined;
	} catch {
		return undefined;
	}
}
