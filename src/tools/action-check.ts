// dforge_action_check — run the DSL static checker on a draft body (before
// committing to dforge_action_add) or on an action already on disk.
//
// The point is a fast feedback loop: the DSL only truly compiles server-side
// at install, so every defect caught here is a pack → install → read-output →
// fix round trip avoided.

import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadManifest, readJsonOrDefault, type ToolResult } from "./_helpers";
import { checkDsl, type DslIssue } from "./dsl-check";

export const actionCheckSchema = {
	moduleDir: z
		.string()
		.optional()
		.describe(
			"Module root. Required when checking an on-disk action (actionCode); optional when checking a raw dslBody.",
		),
	actionCode: z
		.string()
		.regex(/^[a-z][a-z0-9_]*$/)
		.optional()
		.describe(
			"Check an action already registered in ui/actions.json — its DSL file, executionMode, and any job binding are read from disk. Omit to check a raw dslBody instead.",
		),
	dslBody: z
		.string()
		.optional()
		.describe("Raw DSL source to check. Use this to validate a draft BEFORE calling dforge_action_add."),
	executionMode: z
		.enum(["single", "each", "batch"])
		.optional()
		.describe(
			"Execution mode the body will run under. Gates the record-context rules ('[field]' is invalid in batch mode). Read from ui/actions.json when actionCode is used.",
		),
	viaJob: z
		.boolean()
		.optional()
		.describe(
			"True when a scheduled job will fire this action — jobs have NO current record, so '[field]' becomes a hard error. Detected automatically from logic/jobs.json when actionCode is used.",
		),
};

type Args = z.infer<z.ZodObject<typeof actionCheckSchema>>;

export function actionCheck(args: Args): ToolResult {
	let body = args.dslBody;
	let mode = args.executionMode as string | undefined;
	let viaJob = args.viaJob ?? false;
	let label = "draft DSL body";

	if (args.actionCode) {
		if (!args.moduleDir) {
			throw new Error("moduleDir is required when checking an on-disk action (actionCode).");
		}
		const { paths } = loadManifest(args.moduleDir);
		const actions = readJsonOrDefault<Record<string, Record<string, unknown>>>(paths.actions, {});
		const entry = actions[args.actionCode];
		if (!entry) {
			throw new Error(
				`Action '${args.actionCode}' is not in ui/actions.json. Registered actions: ${
					Object.keys(actions).join(", ") || "(none)"
				}.`,
			);
		}
		const script = (entry.script as string) ?? args.actionCode;
		const dslPath = path.join(paths.logicDir, "actions", `${script}.dsl`);
		if (!fs.existsSync(dslPath)) {
			throw new Error(
				`Action '${args.actionCode}' declares script '${script}' but logic/actions/${script}.dsl does not exist.`,
			);
		}
		body = fs.readFileSync(dslPath, "utf8");
		mode = mode ?? ((entry.executionMode as string) ?? (entry.mode as string));
		label = `logic/actions/${script}.dsl`;

		// A job binding overrides the record-context rules — detect it rather
		// than trusting the caller to remember.
		if (args.viaJob === undefined) {
			const jobFile = readJsonOrDefault<{ jobs?: Array<Record<string, unknown>> }>(paths.jobs, {});
			viaJob = (jobFile.jobs ?? []).some((j) => j.action === args.actionCode);
		}
	}

	if (body === undefined) {
		throw new Error("Pass either dslBody (a draft) or actionCode (an action already on disk).");
	}

	const issues: DslIssue[] = checkDsl(body, { executionMode: mode, viaJob });
	const errors = issues.filter((i) => i.level === "error");
	const warnings = issues.filter((i) => i.level === "warning");

	const summary =
		errors.length === 0 && warnings.length === 0
			? `✓ ${label}: no DSL issues${mode ? ` (executionMode '${mode}'${viaJob ? ", job-invoked" : ""})` : ""}.`
			: `${label}: ${errors.length} error(s), ${warnings.length} warning(s).${
					errors.length ? ` First: ${errors[0].message}` : ""
				}`;

	return {
		summary,
		files: {
			"_action_check.json": JSON.stringify(
				{ ok: errors.length === 0, executionMode: mode ?? null, viaJob, errors, warnings },
				null,
				"\t",
			) + "\n",
		},
		warning: errors.length
			? `${errors.length} DSL error(s) — each is a documented install failure. Fix before dforge_action_add / dforge_module_pack.`
			: undefined,
	};
}
