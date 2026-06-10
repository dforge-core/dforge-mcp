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
	description: z
		.string()
		.optional()
		.describe("Tooltip / description text. Defaults to the label if omitted."),
	executionMode: z
		.enum(["single", "each", "batch"])
		.default("single")
		.describe(
			"Execution mode (emitted as `executionMode`). 'single' = whole selection at once, 'each' = per-record, 'batch' = explicit `for x in records` loop in DSL.",
		),
	icon: z
		.string()
		.optional()
		.describe(
			"Bootstrap icon name. The `bi-` prefix is added automatically if missing (e.g. 'check-circle' → 'bi-check-circle'). NOTE: action icons keep the prefix; menu icons drop it.",
		),
	isAsync: z
		.boolean()
		.default(false)
		.describe("Run asynchronously in the background (emitted as `isAsync`)."),
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

	// Shape MUST match references/action-dsl.md ("Registering the action") and
	// examples/simple-todo/ui/actions.json. The installer reads `script` (bare
	// filename, no path/extension), `entityCode`, `executionMode`, `isAsync` —
	// NOT entity/mode/background/dsl. Icons keep the `bi-` prefix.
	const actionEntry: Record<string, unknown> = {
		label: args.label,
		description: args.description ?? args.label,
		entityCode: args.entityCode,
		executionMode: args.executionMode,
		script: args.code,
		isAsync: args.isAsync,
	};
	if (args.icon) {
		actionEntry.icon = args.icon.startsWith("bi-") ? args.icon : `bi-${args.icon}`;
	}

	actionsJson[args.code] = actionEntry;

	const dslPath = path.join(paths.logicDir, "actions", `${args.code}.dsl`);
	const dslBody = args.dslBody.endsWith("\n") ? args.dslBody : args.dslBody + "\n";

	return makeResult(
		`Added action '${args.code}' targeting entity '${args.entityCode}' (executionMode=${args.executionMode}${args.isAsync ? ", async" : ""}).`,
		{
			[rel(paths.root, paths.actions)]: jsonText(actionsJson),
			[rel(paths.root, dslPath)]: dslBody,
			"manifest.json": jsonText(withTodayStamp(manifest)),
		},
	);
}
