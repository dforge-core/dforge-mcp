// Five additive tools that all follow the same shape:
//   1. Load manifest + target JSON (creating an empty default if absent)
//   2. Reject if the key already exists (use *_modify or *_set instead)
//   3. Insert
//   4. Return single-file map
//
// Grouped in one file to keep boilerplate together — each tool is ~15-20
// lines of actual logic.

import { z } from "zod";
import { isFieldTypeCd, fieldTypeCds } from "@dforge-core/metadata";
import {
	loadManifest,
	readJsonOrDefault,
	jsonText,
	rel,
	makeResult,
	withTodayStamp,
	assertValidRights,
	type ToolResult,
} from "./_helpers";

// ── report add ──────────────────────────────────────────────────────

export const reportAddSchema = {
	moduleDir: z.string(),
	code: z
		.string()
		.regex(/^[a-z][a-z0-9_]*$/)
		.describe("Report code (keys ui/reports.json)."),
	report: z
		.object({
			description: z.string(),
			layout: z.record(z.string(), z.unknown()),
			datasets: z.record(z.string(), z.unknown()),
			parameters: z.record(z.string(), z.unknown()).optional(),
		})
		.passthrough()
		.describe(
			"Full report spec per reports.schema.json: { description, layout: { panels: [...] }, datasets: { code: {...} }, parameters? }.",
		),
};

export function reportAdd(args: z.infer<z.ZodObject<typeof reportAddSchema>>): ToolResult {
	const { paths, manifest } = loadManifest(args.moduleDir);
	const reports = readJsonOrDefault<Record<string, unknown>>(paths.reports, {});
	if (Object.prototype.hasOwnProperty.call(reports, args.code)) {
		throw new Error(`Report '${args.code}' already exists in ui/reports.json.`);
	}
	reports[args.code] = args.report;
	return makeResult(`Added report '${args.code}'.`, {
		[rel(paths.root, paths.reports)]: jsonText(reports),
		"manifest.json": jsonText(withTodayStamp(manifest)),
	});
}

// ── setting add ─────────────────────────────────────────────────────

export const settingAddSchema = {
	moduleDir: z.string(),
	code: z
		.string()
		.regex(/^[a-z][a-z0-9_]*$/)
		.describe("Setting code (keys settings.json)."),
	setting: z
		.object({
			fieldTypeCd: z.string(),
			baseDatatypeCd: z.string().optional(),
			label: z.string().optional(),
			description: z.string().optional(),
			defaultValue: z.unknown().optional(),
			formula: z.string().optional(),
			required: z.boolean().optional(),
			params: z.record(z.string(), z.unknown()).optional(),
		})
		.passthrough()
		.superRefine((val, ctx) => {
			const ftc = (val as { fieldTypeCd?: unknown }).fieldTypeCd;
			if (typeof ftc === "string" && !isFieldTypeCd(ftc)) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: `fieldTypeCd '${ftc}' is not a valid field type. Valid codes: ${[...fieldTypeCds].sort().join(", ")}. (See dforge://reference/field-types.)`,
				});
			}
		}),
};

export function settingAdd(args: z.infer<z.ZodObject<typeof settingAddSchema>>): ToolResult {
	const { paths, manifest } = loadManifest(args.moduleDir);
	const settings = readJsonOrDefault<Record<string, unknown>>(paths.settings, {});
	if (Object.prototype.hasOwnProperty.call(settings, args.code)) {
		throw new Error(`Setting '${args.code}' already exists.`);
	}
	settings[args.code] = args.setting;
	return makeResult(`Added setting '${args.code}'.`, {
		[rel(paths.root, paths.settings)]: jsonText(settings),
		"manifest.json": jsonText(withTodayStamp(manifest)),
	});
}

// ── role add ────────────────────────────────────────────────────────

export const roleAddSchema = {
	moduleDir: z.string(),
	code: z
		.string()
		.regex(/^[a-z][a-z0-9_-]*\.[a-z][a-z0-9_-]*$/)
		.describe(
			"Role code, namespaced as `<module>.<role>` (e.g. 'crm.admin'). Conventional namespacing prevents collisions across modules.",
		),
	description: z.string(),
	rights: z
		.record(z.string(), z.string())
		.describe(
			"Map: object code → rights string. Keys: same-module entity bare ('product'), cross-module entity dotted ('fin.invoice'), action/report/folder with a COLON prefix ('action:approve', 'report:summary', 'folder:east') — never a dot. Values: entities use 'S'/'I'/'U'/'D'/'C' (e.g. 'SIUDC'); actions/reports/folders use 'E'. To deny, omit the key (never map to '').",
		),
};

export function roleAdd(args: z.infer<z.ZodObject<typeof roleAddSchema>>): ToolResult {
	assertValidRights(args.rights);
	const { paths, manifest } = loadManifest(args.moduleDir);
	const roles = readJsonOrDefault<Record<string, unknown>>(paths.roles, {});
	if (Object.prototype.hasOwnProperty.call(roles, args.code)) {
		throw new Error(`Role '${args.code}' already exists.`);
	}
	roles[args.code] = { description: args.description, rights: args.rights };
	return makeResult(
		`Added role '${args.code}' with rights on ${Object.keys(args.rights).length} object(s).`,
		{
			[rel(paths.root, paths.roles)]: jsonText(roles),
			"manifest.json": jsonText(withTodayStamp(manifest)),
		},
	);
}

// ── folder add ──────────────────────────────────────────────────────
//
// folders.json IS the root folder (single-folder convention, NOT a map).
// Adding a sub-folder means inserting into the root's (or a nested
// folder's) `children` map. parentPath is a slash-separated path of
// folder codes from root, OR empty for "directly under root".

export const folderAddSchema = {
	moduleDir: z.string(),
	parentPath: z
		.string()
		.default("")
		.describe(
			"Slash-separated folder codes from root, e.g. 'central/east' nests under root → central → east. Empty = add directly under root.",
		),
	code: z
		.string()
		.regex(/^[a-z][a-z0-9_-]*$/)
		.describe("New folder's code (key under parent.children)."),
	folder: z
		.object({
			label: z.string(),
			description: z.string().optional(),
			color: z.string().optional(),
			icon: z.string().optional(),
			inheritSecurity: z.boolean().optional(),
			entities: z.record(z.string(), z.unknown()).optional(),
			children: z.record(z.string(), z.unknown()).optional(),
		})
		.passthrough(),
};

export function folderAdd(args: z.infer<z.ZodObject<typeof folderAddSchema>>): ToolResult {
	const { paths, manifest } = loadManifest(args.moduleDir);
	const root = readJsonOrDefault<Record<string, unknown>>(paths.folders, {
		label: manifest.displayName,
	});

	// Walk parentPath to find the destination folder.
	let cursor: Record<string, unknown> = root;
	const segments = args.parentPath.split("/").filter(Boolean);
	for (const seg of segments) {
		const children = (cursor.children as Record<string, unknown>) ?? {};
		if (!children[seg]) {
			throw new Error(
				`Folder path segment '${seg}' not found under '${segments.slice(0, segments.indexOf(seg)).join("/") || "(root)"}'.`,
			);
		}
		cursor = children[seg] as Record<string, unknown>;
	}

	const children = (cursor.children as Record<string, unknown>) ?? {};
	if (children[args.code]) {
		throw new Error(`Folder '${args.code}' already exists at '${args.parentPath || "(root)"}'.`);
	}
	children[args.code] = args.folder;
	cursor.children = children;

	return makeResult(
		`Added folder '${args.code}' under '${args.parentPath || "(root)"}'.`,
		{
			[rel(paths.root, paths.folders)]: jsonText(root),
			"manifest.json": jsonText(withTodayStamp(manifest)),
		},
	);
}

// ── dependency add ──────────────────────────────────────────────────

export const dependencyAddSchema = {
	moduleDir: z.string(),
	moduleCode: z
		.string()
		.regex(/^[a-z][a-z0-9_-]*$/)
		.describe("Module to depend on."),
	version: z.string().default(">=0.1.0").describe("Semver range."),
	entities: z
		.array(z.string())
		.optional()
		.describe(
			"If only specific entities from the dependency are used, list them — produces the object-style dep `{ version, entities }` for partial coupling. Omit to depend on the whole module.",
		),
};

export function dependencyAdd(
	args: z.infer<z.ZodObject<typeof dependencyAddSchema>>,
): ToolResult {
	const { manifest } = loadManifest(args.moduleDir);
	if (manifest.code === args.moduleCode) {
		throw new Error("A module can't depend on itself.");
	}
	const deps = manifest.dependencies ?? {};
	if (Object.prototype.hasOwnProperty.call(deps, args.moduleCode)) {
		throw new Error(
			`Dependency on '${args.moduleCode}' already exists. Edit manifest.json directly to change the version.`,
		);
	}
	const value =
		args.entities && args.entities.length > 0
			? { version: args.version, entities: args.entities }
			: args.version;
	const newManifest = withTodayStamp({
		...manifest,
		dependencies: { ...deps, [args.moduleCode]: value },
	});
	return makeResult(
		`Added dependency on '${args.moduleCode}' (${args.version})${args.entities ? ` for entities [${args.entities.join(", ")}]` : ""}.`,
		{ "manifest.json": jsonText(newManifest) },
	);
}
