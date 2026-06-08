// Add a new action: writes logic/actions/<code>.dsl + appends an entry to
// ui/actions.json. The DSL body is supplied verbatim by the caller — this
// tool doesn't compile or validate the DSL syntax (the C# installer does
// that at install time).

import { z } from "zod";
import * as path from "node:path";
import {
	loadManifest,
	readJsonOrDefault,
	jsonText,
	rel,
	makeResult,
	withTodayStamp,
	type ToolResult,
} from "./_helpers";

export const actionAddSchema = {
	moduleDir: z.string(),
	code: z
		.string()
		.regex(/^[a-z][a-z0-9_]*$/)
		.describe("Action code (becomes the DSL filename and registry key)."),
	entityCode: z
		.string()
		.regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)?$/)
		.describe(
			"Entity this action targets. May be cross-module via dot notation ('fin.invoice').",
		),
	label: z.string().min(1).describe("Display label in the action menu."),
	mode: z
		.enum(["single", "each", "batch"])
		.default("single")
		.describe(
			"Execution mode. 'single' = whole selection at once, 'each' = per-record, 'batch' = explicit `for x in records` loop in DSL.",
		),
	icon: z.string().optional().describe("Bootstrap icon class (e.g. 'play-fill')."),
	background: z
		.boolean()
		.default(false)
		.describe("Run asynchronously (queues to background_action table)."),
	dslBody: z
		.string()
		.describe(
			"Full DSL source. Should contain `params:`, optional `canExecute:`, optional `onBeforeStart:` (async only), and required `execute:` blocks.",
		),
};

export function actionAdd(
	args: z.infer<z.ZodObject<typeof actionAddSchema>>,
): ToolResult {
	const { paths, manifest } = loadManifest(args.moduleDir);

	const actionsJson = readJsonOrDefault<Record<string, unknown>>(paths.actions, {});
	if (Object.prototype.hasOwnProperty.call(actionsJson, args.code)) {
		throw new Error(
			`Action '${args.code}' already exists in ui/actions.json. Use a different code or remove the existing entry first.`,
		);
	}

	const actionEntry: Record<string, unknown> = {
		entity: args.entityCode,
		label: args.label,
		mode: args.mode,
		background: args.background,
		dsl: `./logic/actions/${args.code}.dsl`,
	};
	if (args.icon) actionEntry.icon = args.icon;

	actionsJson[args.code] = actionEntry;

	const dslPath = path.join(paths.logicDir, "actions", `${args.code}.dsl`);
	const dslBody = args.dslBody.endsWith("\n") ? args.dslBody : args.dslBody + "\n";

	return makeResult(
		`Added action '${args.code}' targeting entity '${args.entityCode}' (mode=${args.mode}${args.background ? ", background" : ""}).`,
		{
			[rel(paths.root, paths.actions)]: jsonText(actionsJson),
			[rel(paths.root, dslPath)]: dslBody,
			"manifest.json": jsonText(withTodayStamp(manifest)),
		},
	);
}
