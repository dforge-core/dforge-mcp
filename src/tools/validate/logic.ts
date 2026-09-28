// Action, trigger, job and webhook checks, including the static DSL pass.

import * as fs from "node:fs";
import * as path from "node:path";
import { readJsonOrDefault, localEntityCode } from "../_helpers";
import { checkDsl } from "../dsl-check";
import type { ValidateContext } from "./context";
import { readMessageTranslations } from "./translations";

// Actions: DSL file on disk + a real target entity.
// `script` is a BARE filename; the installer resolves it to
// logic/actions/<script>.dsl. A typo here surfaces only at install as
// "action script not found".
export function checkActions(ctx: ValidateContext): void {
	const { paths, err, isKnownEntity, actions } = ctx;
	for (const [acode, a] of Object.entries(actions)) {
		const act = (a ?? {}) as Record<string, unknown>;
		const where = `actions → ${acode}`;
		const script = typeof act.script === "string" ? act.script : "";
		if (!script) {
			err(where, "has no 'script' — it must be the bare DSL filename (no path, no .dsl extension).");
		} else if (script.includes("/") || script.includes("\\") || script.endsWith(".dsl")) {
			err(
				where,
				`script '${script}' must be a BARE filename — no path, no '.dsl' extension (e.g. "script": "${script
					.replace(/\.dsl$/, "")
					.split(/[\\/]/)
					.pop()}").`,
			);
		} else if (!fs.existsSync(path.join(paths.logicDir, "actions", `${script}.dsl`))) {
			err(where, `script '${script}' has no file at logic/actions/${script}.dsl.`);
		}
		const ent = (act.entityCode ?? act.entity) as string | undefined;
		if (ent && !isKnownEntity(ent)) {
			err(where, `targets entity '${ent}', which is not a known entity.`);
		}
	}
}

// Triggers / jobs / webhooks reference real actions + entities.
// A trigger or job naming an action that doesn't exist compiles fine
// offline and fails at install. Cross-module dotted action codes are
// accepted when the module prefix is a declared dependency.
export function checkTriggersJobsWebhooks(ctx: ValidateContext): void {
	const { paths, manifest, issues, err, deps, isKnownEntity, actions } = ctx;
	const isKnownAction = (code: string): boolean => {
		if (code in actions) return true;
		const dot = code.indexOf(".");
		if (dot > 0) {
			const mod = code.slice(0, dot);
			return deps.has(mod) || mod === manifest.code;
		}
		return false;
	};

	const triggerFile = readJsonOrDefault<{ triggers?: Array<Record<string, unknown>> }>(
		paths.triggers,
		{},
	);
	for (const t of triggerFile.triggers ?? []) {
		const where = `triggers → ${String(t.code ?? "?")}`;
		const act = t.action as string | undefined;
		if (act && !isKnownAction(act)) {
			err(where, `fires action '${act}', which is not in ui/actions.json (add it with dforge_action_add first).`);
		}
		const ent = t.entity as string | undefined;
		if (ent && !isKnownEntity(ent)) err(where, `is bound to entity '${ent}', which is not a known entity.`);
	}

	const jobFile = readJsonOrDefault<{ jobs?: Array<Record<string, unknown>> }>(paths.jobs, {});
	for (const j of jobFile.jobs ?? []) {
		const where = `jobs → ${String(j.code ?? "?")}`;
		const act = j.action as string | undefined;
		if (act && !isKnownAction(act)) {
			err(where, `schedules action '${act}', which is not in ui/actions.json.`);
		}
		// A scheduled job runs as the system user with NO current record, so the
		// action it fires must not use record-context `[field]` syntax.
		if (act && act in actions) {
			const registered = (actions[act] ?? {}) as Record<string, unknown>;
			const script = registered.script;
			if (typeof script === "string") {
				const dslPath = path.join(paths.logicDir, "actions", `${script}.dsl`);
				if (fs.existsSync(dslPath)) {
					let body = "";
					try {
						body = fs.readFileSync(dslPath, "utf8");
					} catch {
						/* unreadable — the missing-file check above already reported it */
					}
					// The mode has to travel with the body: batch reads `[TRUE]`,
					// `[FALSE]` and `[NULL]` as literals rather than record fields,
					// and without it the checker falls back to 'single' and flags
					// them — an error on a script action_check, which does pass the
					// mode, accepts.
					for (const issue of checkDsl(body, {
						executionMode: (registered.executionMode ?? registered.mode) as string | undefined,
						viaJob: true,
						actionCode: act,
						moduleCode: manifest.code,
					})) {
						// Only the job-specific rule here; the action's own pass
						// below reports everything else, against its own file.
						if (issue.rule !== "dsl/job-record-context") continue;
						issues.push({ level: issue.level, where, message: issue.message });
					}
				}
			}
		}
	}

	const webhookFile = readJsonOrDefault<{ subscriptions?: Array<Record<string, unknown>> }>(
		paths.webhooks,
		{},
	);
	for (const w of webhookFile.subscriptions ?? []) {
		const ent = w.entity as string | undefined;
		if (ent && !isKnownEntity(ent)) {
			err(`webhooks → ${String(w.code ?? "?")}`, `is bound to entity '${ent}', which is not a known entity.`);
		}
	}
}

// Action DSL static checks.
// The DSL only compiles at install (a slow, tenant-bound round trip), so
// run the statically-decidable subset here. See ./dsl-check.
export function checkActionDsl(ctx: ValidateContext): void {
	const { paths, manifest, issues, columnsOf, partialColumns, actions } = ctx;
	const messageTranslations = readMessageTranslations(paths.translationsDir, ctx.supportedLocales);
	for (const [acode, a] of Object.entries(actions)) {
		// The installer defaults the script to the action code.
		const declared = (a as Record<string, unknown> | undefined)?.script;
		const script = typeof declared === "string" && declared ? declared : acode;
		const dslPath = path.join(paths.logicDir, "actions", `${script}.dsl`);
		if (!fs.existsSync(dslPath)) continue; // reported by checkActions
		let body: string;
		try {
			body = fs.readFileSync(dslPath, "utf8");
		} catch {
			continue;
		}
		const mode = ((a as Record<string, unknown>).executionMode ?? (a as Record<string, unknown>).mode) as
			| string
			| undefined;
		// The entity behind the action's record context, with traits expanded.
		// Absent (a cross-module action, an entity code that doesn't resolve)
		// the column rules stand down rather than guess — a false "not a
		// column" would block a pack on a module that installs.
		// `shop.product` and `product` name the same entity inside module `shop`,
		// so normalize before the lookup — otherwise the qualified spelling
		// misses `columnsOf` and the column rules stand down on it.
		const entityCode = localEntityCode(
			(a as Record<string, unknown>).entityCode as string | undefined,
			manifest.code,
		);
		const columns =
			entityCode && !partialColumns.has(entityCode) ? columnsOf[entityCode] : undefined;
		for (const issue of checkDsl(body, {
			executionMode: mode,
			actionCode: acode,
			moduleCode: manifest.code,
			entity:
				entityCode && columns
					? { qualified: `${manifest.code}.${entityCode}`, columns }
					: undefined,
			messageTranslations,
		})) {
			issues.push({
				level: issue.level,
				where: `logic/actions/${script}.dsl${issue.line ? `:${issue.line}` : ""}`,
				message: `[${acode}] ${issue.message}`,
			});
		}
	}
}
