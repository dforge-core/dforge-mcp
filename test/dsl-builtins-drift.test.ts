// Guards `DSL_BUILTINS` against the platform's authoritative list.
//
// The set in src/tools/dsl-check.ts is a hand-maintained mirror of
// `DslBuiltins.FunctionNames` in dForge-core. When a builtin is added there and
// not here, `dforge_action_check` reports the new function as
// `unknown-builtin` — it tells the author their *correct* code is wrong, which
// is worse than saying nothing. That drift is exactly what happened to
// addMinutes, applyProfile and getFileBase64, and it went unnoticed because
// nothing compared the two lists.
//
// dForge-core is a sibling checkout, not a dependency, so this can only run
// where it's present. That's the right place for it to run: the person adding a
// builtin to core has core checked out, so the guard fires on their machine and
// in any CI that checks out both repos. Elsewhere it skips loudly rather than
// pretending to pass.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { DSL_BUILTINS } from "../src/tools/dsl-check";

/**
 * Same resolution order as scripts/vendor-resources.sh: explicit DFORGE_CORE,
 * else the conventional sibling checkout.
 */
function findCore(): string | null {
	const candidate = process.env.DFORGE_CORE ?? resolve(process.cwd(), "..", "dForge-core");
	return existsSync(join(candidate, CORE_REL)) ? candidate : null;
}

const CORE_REL = join("server", "src", "dForge.Core", "Dsl", "DslBuiltins.cs");

/** The string literals inside `FunctionNames = new[] { ... };`. */
function parseCoreBuiltins(csharp: string): string[] {
	const marker = "FunctionNames = new[]";
	const start = csharp.indexOf(marker);
	if (start === -1) {
		throw new Error(
			"DslBuiltins.cs has no `FunctionNames = new[]` initializer — the declaration was " +
				"reshaped upstream and this parser needs updating.",
		);
	}
	const end = csharp.indexOf("};", start);
	if (end === -1) throw new Error("DslBuiltins.cs: unterminated FunctionNames initializer.");
	return [...csharp.slice(start, end).matchAll(/"([A-Za-z_]\w*)"/g)].map((m) => m[1]);
}

/**
 * Rewritten by the compiler via dedicated patterns rather than the builtin
 * list, so they are legitimately absent from core's array but present here.
 *
 * `userId` is deliberately NOT in this set: it is a bare identifier, and
 * keeping it out of DSL_BUILTINS is what makes `userId()` surface as
 * `unknown-builtin` instead of failing at runtime.
 */
const REWRITTEN_NOT_LISTED = new Set(["now"]);

const core = findCore();

describe("DSL_BUILTINS vs dForge-core", () => {
	it("parses a plausible list from core when it is available", () => {
		if (!core) {
			console.warn(
				"[skip] dForge-core not found — set DFORGE_CORE=/path/to/dForge-core to enable the drift guard.",
			);
			return;
		}
		expect(parseCoreBuiltins(readFileSync(join(core, CORE_REL), "utf8")).length).toBeGreaterThan(20);
	});

	it("lists every builtin core defines", () => {
		if (!core) return;
		const missing = parseCoreBuiltins(readFileSync(join(core, CORE_REL), "utf8")).filter(
			(n) => !DSL_BUILTINS.has(n),
		);
		expect(
			missing,
			`DSL_BUILTINS is missing builtin(s) that dForge-core defines: ${missing.join(", ")}. ` +
				"dforge_action_check will report them as unknown-builtin. Add them to " +
				"src/tools/dsl-check.ts and document them in resources/docs/dsl-reference.md.",
		).toEqual([]);
	});

	it("lists nothing core does not define", () => {
		if (!core) return;
		const known = new Set(parseCoreBuiltins(readFileSync(join(core, CORE_REL), "utf8")));
		const extra = [...DSL_BUILTINS].filter((n) => !known.has(n) && !REWRITTEN_NOT_LISTED.has(n));
		expect(
			extra,
			`DSL_BUILTINS lists name(s) dForge-core does not define: ${extra.join(", ")}. ` +
				"Either the builtin was removed upstream, or it belongs in REWRITTEN_NOT_LISTED.",
		).toEqual([]);
	});

	it("keeps userId out, so `userId()` is still reported", () => {
		expect(DSL_BUILTINS.has("userId")).toBe(false);
		expect(DSL_BUILTINS.has("currentUserId")).toBe(true);
	});
});
