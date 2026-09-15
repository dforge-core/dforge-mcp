// Static checker for action DSL bodies (logic/actions/*.dsl).
//
// The rules themselves live in `@dforge-core/metadata/dsl`, shared with the
// language server that draws squiggles on these files as they are typed. This
// module is the adapter: it maps the tool surface's options onto the checker's
// `DslContext` and its issues back onto the `{level, rule, message, line}`
// shape the tools already report.
//
// It used to hold a second implementation — regexes over blanked-out source,
// module-blind — which shared three rules with the editor's and disagreed with
// it about the rest. One engine now; see the package for the rules.

import {
	checkDsl as checkDslPackage,
	type DslContext,
	type DslIssue as PackageIssue,
} from "@dforge-core/metadata/dsl";

export type DslIssueLevel = "error" | "warning";

export interface DslIssue {
	level: DslIssueLevel;
	/** Stable rule id, namespaced — `dsl/unknown-column`. */
	rule: string;
	message: string;
	/** 1-indexed line in the DSL body. */
	line?: number;
}

export interface DslCheckOpts {
	/** `single` | `each` | `batch`, from ui/actions.json. */
	executionMode?: string;
	/** True when the action is invoked by a scheduled job (no current record). */
	viaJob?: boolean;
	/** Owning module code, for the qualify-your-entity-codes rule. */
	moduleCode?: string;
	/** Action code, named in the messages that mention it. */
	actionCode?: string;
	/**
	 * The entity behind the record context, with the columns it ends up having
	 * — traits expanded, extensions merged. Omit it and every column rule
	 * stands down: a false "unknown column" would block a pack on a module
	 * that installs.
	 */
	entity?: { qualified: string; columns: Set<string> | Map<string, unknown> };
}

/**
 * Check a DSL body. Returns [] for a clean script.
 *
 * The checker reports three severities; a validator has two. `info` is advice
 * that should never fail a pack (qualify this entity code), so it arrives as a
 * warning rather than an error.
 */
export function checkDsl(src: string, opts: DslCheckOpts = {}): DslIssue[] {
	// ui/actions.json is read straight off disk (imported, or hand-edited), and
	// nothing offline validates this key — so normalize case rather than let
	// 'Batch' fall through as "no mode", which would quietly stand the
	// record-context rules down on the one mode that most needs them.
	const raw = opts.executionMode?.trim();
	const mode = raw?.toLowerCase();
	const executionMode =
		mode === "single" || mode === "each" || mode === "batch" ? mode : undefined;

	const ctx: DslContext = {
		moduleCode: opts.moduleCode,
		action:
			executionMode || opts.viaJob || opts.actionCode
				? { code: opts.actionCode ?? "this action", executionMode, viaJob: opts.viaJob }
				: undefined,
		currentEntity: opts.entity ?? null,
	};

	const issues = checkDslPackage(src, ctx).map(toIssue);

	// Still unrecognized after folding case: say so instead of silently
	// checking the script as if it were 'single'. Namespaced apart from the
	// shared rules — this one is about the registry entry, not the DSL.
	if (raw && !executionMode) {
		issues.unshift({
			level: "warning",
			rule: "action/unknown-execution-mode",
			message:
				`executionMode '${raw}' is not one of single, each, batch — the record-context rules ` +
				"stood down, so a `[field]` read that batch mode forbids would not be reported. " +
				"Fix the value in ui/actions.json.",
		});
	}

	return issues;
}

function toIssue(issue: PackageIssue): DslIssue {
	return {
		level: issue.severity === "error" ? "error" : "warning",
		rule: issue.rule,
		message: issue.message,
		line: issue.line,
	};
}
