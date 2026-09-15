// dforge_action_check — run the DSL static checker on a draft body (before
// committing to dforge_action_add) or on an action already on disk.
//
// The point is a fast feedback loop: the DSL only truly compiles server-side
// at install, so every defect caught here is a pack → install → read-output →
// fix round trip avoided.

import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	loadManifest,
	readJsonOrDefault,
	readLocalTraits,
	entityRecordContext,
	type ToolResult,
} from "./_helpers";
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
	entityCode: z
		.string()
		.regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)?$/)
		.optional()
		.describe(
			"Entity the draft body acts on. With moduleDir, this turns on the column rules ('[field]' must be a real column, traits expanded) for a dslBody that isn't registered yet. Read from ui/actions.json when actionCode is used.",
		),
};

type Args = z.infer<z.ZodObject<typeof actionCheckSchema>>;

export function actionCheck(args: Args): ToolResult {
	let body = args.dslBody;
	let mode = args.executionMode as string | undefined;
	let viaJob = args.viaJob ?? false;
	let label = "draft DSL body";
	let entityCode = args.entityCode;
	// The module-aware half of the rules — unknown columns, undeclared params,
	// unqualified entity codes — needs the module to resolve. Without a
	// moduleDir they stand down and this tool reports only what the text alone
	// decides; with one it reports what dforge_module_validate reports, so an
	// action that passes here doesn't then fail at pack.
	let moduleCode: string | undefined;
	let entity: { qualified: string; columns: Set<string> } | undefined;
	// Defects found while resolving the module, reported alongside the DSL ones
	// so a single result answers "is this body ready to commit?".
	const preIssues: DslIssue[] = [];

	if (args.actionCode && !args.moduleDir) {
		throw new Error("moduleDir is required when checking an on-disk action (actionCode).");
	}

	if (args.moduleDir) {
		const { paths, manifest } = loadManifest(args.moduleDir);
		moduleCode = manifest.code;

		if (args.actionCode) {
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
			entityCode = entityCode ?? (entry.entityCode as string | undefined);
			label = `logic/actions/${script}.dsl`;

			// A job binding overrides the record-context rules — detect it rather
			// than trusting the caller to remember.
			if (args.viaJob === undefined) {
				const jobFile = readJsonOrDefault<{ jobs?: Array<Record<string, unknown>> }>(paths.jobs, {});
				viaJob = (jobFile.jobs ?? []).some((j) => j.action === args.actionCode);
			}
		}

		// The module's own traits.json, overlaid as the installer does. An
		// unusable one is REPORTED, not swallowed: without it the entity comes
		// back without the columns those traits contribute, so
		// `entityRecordContext` withholds the record context entirely and every
		// column rule stands down. Dropping the error here would have this tool
		// answer "no issues" on a body dforge_module_validate rejects — the one
		// thing the two are supposed to agree about.
		const { traits: localTraits, error: traitsError } = readLocalTraits(paths.root);
		if (traitsError) {
			preIssues.push({
				level: "error",
				rule: "module/invalid-traits-json",
				message:
					`traits.json — ${traitsError} This module's own traits can't be overlaid on the ` +
					"platform ones, so an entity using them reads as declaring an unknown trait and the " +
					"column rules below stand down. Fix the file, then check again.",
			});
		}
		entity = entityRecordContext(paths, manifest, entityCode, localTraits);
	}

	if (body === undefined) {
		throw new Error("Pass either dslBody (a draft) or actionCode (an action already on disk).");
	}

	const issues: DslIssue[] = [
		...preIssues,
		...checkDsl(body, {
			executionMode: mode,
			viaJob,
			moduleCode,
			actionCode: args.actionCode,
			entity,
		}),
	];
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
