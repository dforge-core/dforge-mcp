// Pre-flight whole-module validator. Read-only: loads every file and runs the
// CROSS-REFERENCE checks that per-tool validation can't see — the errors that
// otherwise only surface at pack/install (a slow, tenant-bound round trip).
//
// Catches: dangling FK/reference targets, the hidden-FK column missing for a
// Reference, view dataSources/columns pointing at unknown entities/fields, a
// grid-style view over an entity with no visible column, menu dataViewCode →
// missing view, role rights keyed on unknown entities/actions/reports, record-report
// attachments (param declared, entity known, source column mappable),
// entities with no Select grant, and docs/diagrams/*.json entity keys that
// resolve to nothing — a dependency key, or an own key close to a built
// entity's code; other own keys are planned entities (warnings only — diagrams are design-time). Returns a
// structured issue list in `_validate.json` plus a one-line summary; never writes anything.
//
// Each check lives in ./validate/ and reads the shared ValidateContext; this
// file runs them in order and shapes the result.

import { z } from "zod";
import type { ToolResult } from "./_helpers";
import type { CliValidate } from "./native-shell";
import { loadContext, type ValidateContext } from "./validate/context";
import {
	checkReferences,
	checkEntityViews,
	checkFieldSpecs,
	checkToString,
	checkSetAggregates,
} from "./validate/entities";
import { checkDataViews, checkVisibleColumns, checkMenus } from "./validate/views";
import { checkRoleRights, checkSelectCoverage } from "./validate/security";
import { checkConstraintTranslations, checkMessageTranslations, checkTranslationCompleteness } from "./validate/translations";
import { checkActions, checkTriggersJobsWebhooks, checkActionDsl } from "./validate/logic";
import { checkFolders, checkDiagrams } from "./validate/folders";
import { checkReports } from "./validate/reports";

export const moduleValidateSchema = {
	moduleDir: z.string().describe("Path to the module root. Run this after authoring and before dforge_module_pack."),
};

// Order matters only for the order issues are listed in (and so the summary's
// "first error").
const CHECKS: Array<(ctx: ValidateContext) => void> = [
	checkReferences,
	checkEntityViews,
	checkDataViews,
	checkVisibleColumns,
	checkMenus,
	checkRoleRights,
	checkSelectCoverage,
	checkConstraintTranslations,
	checkFieldSpecs,
	checkToString,
	checkSetAggregates,
	checkActions,
	checkTriggersJobsWebhooks,
	checkActionDsl,
	checkFolders,
	checkDiagrams,
	checkReports,
	checkTranslationCompleteness,
	checkMessageTranslations,
];

export function moduleValidate(
	args: z.infer<z.ZodObject<typeof moduleValidateSchema>>,
	cli?: CliValidate,
): ToolResult {
	const ctx = loadContext(args.moduleDir);
	for (const check of CHECKS) check(ctx);
	const { manifest, issues, err, warn, entities, viewCodes, roles } = ctx;

	// ── CLI static checks ──
	// The rules `module pack` enforces live in the CLI (ModuleStaticValidator);
	// running it keeps them in one place instead of re-implemented here.
	if (cli) {
		const res = cli(args.moduleDir);
		if ("unavailable" in res) {
			warn("cli", `CLI checks skipped, so pack may still fail: ${res.unavailable}`);
		} else {
			if (res.report.error) err("cli: package", res.report.error);
			for (const c of res.report.checks) if (!c.ok) err(`cli: ${c.name}`, c.message ?? "failed");
			for (const w of res.report.warnings) {
				// The offline pass already warns about a missing toString.
				const dup = issues.some((i) => i.where === w.where && i.message.includes("toString") && w.message.includes("toString"));
				if (!dup) warn(w.where, w.message);
			}
		}
	}

	// ── Result ──
	const errors = issues.filter((i) => i.level === "error");
	const warnings = issues.filter((i) => i.level === "warning");
	const clean = errors.length === 0 && warnings.length === 0;
	const summary = clean
		? `✓ ${manifest.code}: no cross-reference issues found across ${Object.keys(entities).length} entities, ${viewCodes.size} views, ${Object.keys(roles).length} roles.`
		: `${manifest.code}: ${errors.length} error(s), ${warnings.length} warning(s).${errors.length ? ` First error: ${errors[0].where} — ${errors[0].message}` : ""}`;

	return {
		summary,
		files: {
			"_validate.json": JSON.stringify({ ok: errors.length === 0, errors, warnings }, null, "\t") + "\n",
		},
		warning: errors.length
			? `${errors.length} validation error(s) — fix before dforge_module_pack / dforge_module_install. Details in _validate.json.`
			: undefined,
	};
}
