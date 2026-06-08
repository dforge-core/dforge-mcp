// View add + modify. Patches ui/data_views.json — a map of viewCode →
// dataView. The dataView object is passed through verbatim; this tool
// doesn't validate viewType-specific config (the schema does, and the
// install-time validator catches anything missed).

import { z } from "zod";
import {
	loadManifest,
	readJsonOrDefault,
	jsonText,
	rel,
	makeResult,
	withTodayStamp,
	type ToolResult,
} from "./_helpers";

const dataSourceSchema = z
	.object({
		entityCode: z.string(),
		level: z.number().int().min(0).optional(),
		label: z.string().optional(),
		columns: z.array(z.unknown()).optional(),
		filter: z.unknown().optional(),
		order: z.unknown().optional(),
		parentSetField: z.string().optional(),
	})
	.passthrough();

const dataViewSchema = z
	.object({
		viewType: z.enum([
			"grid",
			"list",
			"kanban",
			"calendar",
			"gallery",
			"tree-grid",
			"diagram",
			"master-detail",
			"library",
		]),
		label: z.string().optional(),
		description: z.string().optional(),
		icon: z.string().optional(),
		dataSources: z.array(dataSourceSchema).min(1),
		filter: z.unknown().optional(),
		order: z.unknown().optional(),
		viewConfig: z.record(z.string(), z.unknown()).optional(),
	})
	.passthrough();

// ── add ─────────────────────────────────────────────────────────────

export const viewAddSchema = {
	moduleDir: z.string(),
	code: z
		.string()
		.regex(/^[a-z][a-z0-9_]*$/)
		.describe("View code (keys ui/data_views.json + URL slug)."),
	view: dataViewSchema,
};

export function viewAdd(
	args: z.infer<z.ZodObject<typeof viewAddSchema>>,
): ToolResult {
	const { paths, manifest } = loadManifest(args.moduleDir);
	const views = readJsonOrDefault<Record<string, unknown>>(paths.dataViews, {});
	if (Object.prototype.hasOwnProperty.call(views, args.code)) {
		throw new Error(
			`View '${args.code}' already exists in ui/data_views.json. Use view_modify to change it.`,
		);
	}
	views[args.code] = args.view;
	return makeResult(
		`Added ${args.view.viewType} view '${args.code}' over [${args.view.dataSources.map((d) => d.entityCode).join(", ")}].`,
		{
			[rel(paths.root, paths.dataViews)]: jsonText(views),
			"manifest.json": jsonText(withTodayStamp(manifest)),
		},
	);
}

// ── modify ──────────────────────────────────────────────────────────

export const viewModifySchema = {
	moduleDir: z.string(),
	code: z.string().regex(/^[a-z][a-z0-9_]*$/),
	view: dataViewSchema.describe(
		"Replacement view spec — full shape, not a partial patch.",
	),
};

export function viewModify(
	args: z.infer<z.ZodObject<typeof viewModifySchema>>,
): ToolResult {
	const { paths, manifest } = loadManifest(args.moduleDir);
	const views = readJsonOrDefault<Record<string, unknown>>(paths.dataViews, {});
	if (!Object.prototype.hasOwnProperty.call(views, args.code)) {
		throw new Error(
			`View '${args.code}' not found. Use view_add to create it.`,
		);
	}
	views[args.code] = args.view;
	return makeResult(`Modified view '${args.code}'.`, {
		[rel(paths.root, paths.dataViews)]: jsonText(views),
		"manifest.json": jsonText(withTodayStamp(manifest)),
	});
}
