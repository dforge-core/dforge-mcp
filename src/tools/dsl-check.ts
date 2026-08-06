// Static checker for action DSL bodies (logic/actions/*.dsl).
//
// The DSL is a JS ES5 subset (Esprima/Jint) with dForge extensions, and it is
// only ever compiled server-side at install — a slow, tenant-bound round trip.
// Every rule here is a documented install/runtime failure from
// dforge://docs/dsl ("Anti-patterns") that is decidable from the text alone.
//
// Deliberately conservative: anything that could plausibly be a false positive
// is a `warning`, so a novel-but-valid script never blocks a pack. Only the
// rules with a named, reproducible failure are `error`.

export type DslIssueLevel = "error" | "warning";

export interface DslIssue {
	level: DslIssueLevel;
	/** Stable rule id, so callers can filter (module-validate uses this). */
	rule: string;
	message: string;
	/** 1-indexed line in the DSL body, when the rule pins one. */
	line?: number;
}

export interface DslCheckOpts {
	/** `single` | `each` | `batch`, from ui/actions.json. */
	executionMode?: string;
	/** True when the action is invoked by a scheduled job (no current record). */
	viaJob?: boolean;
}

/** The four ordered block markers a .dsl file may declare. */
const BLOCKS = ["params", "canExecute", "onBeforeStart", "execute"] as const;
type Block = (typeof BLOCKS)[number];

/**
 * Host globals exposed by ActionScriptEngine — see dforge://docs/dsl.
 *
 * Mirrors `DslBuiltins.FunctionNames` in dForge.Core, plus `now`, which the
 * compiler rewrites as a call via its own pattern rather than listing there.
 *
 * `userId` is deliberately absent: it is a bare identifier, not a function, so
 * leaving it out is what makes the `userId()` mistake surface here instead of
 * at runtime. Use `currentUserId()` for the call-shaped form.
 */
export const DSL_BUILTINS = new Set([
	"addDays", "addMinutes", "addSeconds", "applyProfile", "callApi", "callProc",
	"callService", "currentUserId", "delete", "detectDocument", "download",
	"entityLink", "error", "exit", "flush", "getFileBase64", "getFileInfo",
	"getFileUrl", "getRecord", "getRecordOrNull", "getSecret", "getSetting",
	"info", "insert", "nextNumber", "notify", "now", "ocrExtract", "preloadRef",
	"query", "select", "sendEmail", "tryParseJson", "update", "warn",
]);

/** ES5 keywords and the globals Jint exposes — never "unknown functions". */
const JS_RESERVED = new Set([
	"if", "for", "while", "switch", "catch", "return", "typeof", "function",
	"do", "else", "in", "of", "new", "delete", "void", "throw", "try",
	"parseInt", "parseFloat", "isNaN", "isFinite", "String", "Number", "Boolean",
	"Array", "Object", "Date", "Math", "JSON", "RegExp", "Error",
]);

/** Formula-engine functions that are undefined inside `execute:`. */
const FORMULA_ONLY = ["TODAY", "NOW"];

/**
 * Strip string literals and `#`/`//` comments so scanners don't match inside
 * them. Replaces each removed run with same-length spaces to keep line/column
 * offsets — and therefore reported line numbers — accurate.
 */
function blank(src: string): string {
	let out = "";
	let i = 0;
	while (i < src.length) {
		const c = src[i];
		if (c === "'" || c === '"') {
			const quote = c;
			out += " ";
			i++;
			while (i < src.length && src[i] !== quote) {
				if (src[i] === "\\") {
					out += "  ";
					i += 2;
					continue;
				}
				out += src[i] === "\n" ? "\n" : " ";
				i++;
			}
			if (i < src.length) {
				out += " ";
				i++;
			}
			continue;
		}
		if (c === "#" || (c === "/" && src[i + 1] === "/")) {
			while (i < src.length && src[i] !== "\n") {
				out += " ";
				i++;
			}
			continue;
		}
		out += c;
		i++;
	}
	return out;
}

const lineOf = (src: string, index: number): number => src.slice(0, index).split("\n").length;

/**
 * Read the string literal starting at `src[start]` (which must be a quote),
 * honouring backslash escapes. Returns the DECODED contents plus the index just
 * past the closing quote, or null if the literal is unterminated.
 *
 * A regex can't do this: `/'([^']*)'/` stops at the first escaped quote, so
 * `query('... \' ...')` truncates mid-SQL and the placeholder scan then reads
 * whatever follows as if it were code.
 */
function readStringLiteral(src: string, start: number): { value: string; end: number } | null {
	const quote = src[start];
	if (quote !== "'" && quote !== '"') return null;
	let value = "";
	let i = start + 1;
	while (i < src.length) {
		const c = src[i];
		if (c === "\\") {
			// Keep the escaped character verbatim — we only care about the text,
			// not about resolving \n and friends.
			if (i + 1 < src.length) value += src[i + 1];
			i += 2;
			continue;
		}
		if (c === quote) return { value, end: i + 1 };
		value += c;
		i++;
	}
	return null; // unterminated
}

/**
 * Find every `query(...)` / `callProc(...)` whose FIRST argument is a string
 * literal, returning the decoded SQL and the call's offset. Uses the scanner
 * above rather than a regex so escaped quotes inside the SQL are handled.
 */
function sqlLiterals(src: string): Array<{ sql: string; index: number; end: number }> {
	const out: Array<{ sql: string; index: number; end: number }> = [];
	const callRe = /\b(query|callProc)\s*\(\s*/g;
	for (const m of src.matchAll(callRe)) {
		const argStart = (m.index ?? 0) + m[0].length;
		const lit = readStringLiteral(src, argStart);
		if (!lit) continue; // first arg isn't a literal (a variable, a template, …)
		// `index` = start of the call (for line reporting); `end` = just past the
		// literal's closing quote (for looking at what follows it).
		out.push({ sql: lit.value, index: m.index ?? 0, end: lit.end });
	}
	return out;
}

/** Split a DSL body into its block markers, in the order they appear. */
export function parseBlocks(src: string): Array<{ block: Block | string; start: number; end: number; line: number }> {
	const lines = src.split("\n");
	const found: Array<{ block: string; start: number; end: number; line: number }> = [];
	let offset = 0;
	for (let i = 0; i < lines.length; i++) {
		// Markers sit at column 0; block bodies are indented beneath them.
		const m = lines[i].match(/^([A-Za-z][A-Za-z0-9_]*)\s*:\s*$/);
		if (m) found.push({ block: m[1], start: offset + m[0].length, end: src.length, line: i + 1 });
		offset += lines[i].length + 1;
	}
	for (let i = 0; i < found.length - 1; i++) {
		// A block ends where the next marker's line begins.
		found[i].end = src.lastIndexOf("\n", found[i + 1].start - found[i + 1].block.length - 2) + 1;
	}
	return found;
}

/**
 * Check a DSL body. Returns [] for a clean script.
 *
 * `opts.executionMode` and `opts.viaJob` gate the record-context rules — the
 * same body is legal in `single` mode and a hard error in `batch` mode or when
 * fired by the scheduler.
 */
export function checkDsl(src: string, opts: DslCheckOpts = {}): DslIssue[] {
	const issues: DslIssue[] = [];
	const add = (level: DslIssueLevel, rule: string, message: string, line?: number) =>
		issues.push({ level, rule, message, ...(line ? { line } : {}) });

	const code = blank(src);
	const blocks = parseBlocks(src);
	const names = blocks.map((b) => b.block);

	// ── Structure ──
	if (src.trim() === "") {
		add("error", "dsl-empty", "DSL body is empty — at minimum it needs an `execute:` block.");
		return issues;
	}
	if (!names.includes("execute")) {
		add(
			"error",
			"missing-execute",
			"no `execute:` block — it is the only required block in a .dsl file.",
		);
	}
	for (const b of blocks) {
		if (!(BLOCKS as readonly string[]).includes(b.block)) {
			add(
				"warning",
				"unknown-block",
				`'${b.block}:' is not a DSL block marker — expected one of ${BLOCKS.join(", ")}. ` +
					"(A stray label at column 0 is parsed as a block.)",
				b.line,
			);
		}
	}
	const known = names.filter((n) => (BLOCKS as readonly string[]).includes(n));
	const order = known.map((n) => BLOCKS.indexOf(n as Block));
	for (let i = 1; i < order.length; i++) {
		if (order[i] < order[i - 1]) {
			add(
				"error",
				"block-order",
				`blocks must appear in the order ${BLOCKS.join(" → ")}; found '${known[i - 1]}:' before '${known[i]}:'.`,
			);
			break;
		}
	}
	for (const b of BLOCKS) {
		if (known.filter((n) => n === b).length > 1) {
			add("error", "duplicate-block", `'${b}:' is declared more than once.`);
		}
	}

	const execBlock = blocks.find((b) => b.block === "execute");
	const execCode = execBlock ? code.slice(execBlock.start, execBlock.end) : "";
	const execOffset = execBlock ? execBlock.start : 0;

	// ── execute: uses lowercase now(), never the formula-only TODAY()/NOW() ──
	// Documented install failure: "'TODAY' is not defined".
	if (execBlock) {
		for (const fn of FORMULA_ONLY) {
			const re = new RegExp(`\\b${fn}\\s*\\(\\s*\\)`, "g");
			for (const m of execCode.matchAll(re)) {
				add(
					"error",
					"execute-formula-date",
					`the execute: block calls ${fn}(), which is undefined at runtime — install fails with ` +
						`"'${fn}' is not defined". Use lowercase now() in execute:. ${fn}() is formula-only ` +
						"(canExecute:, formula columns).",
					lineOf(src, execOffset + (m.index ?? 0)),
				);
			}
		}
	}

	// ── Record-context `[field]` ──
	// Matches a bracketed identifier NOT preceded by an identifier char or `]`,
	// so `params[name]`, `rec[field]` and `records[0][field]` are excluded — only
	// the bare current-record form is record context.
	const recordRefs = [...code.matchAll(/(?<![\w\]$])\[([a-z][a-z0-9_]*)\]/g)];
	const mode = (opts.executionMode ?? "").toLowerCase();
	if (opts.viaJob && recordRefs.length > 0) {
		const first = recordRefs[0];
		add(
			"error",
			"job-record-context",
			`uses record-context syntax [${first[1]}] but is invoked by a scheduled job — jobs run as the ` +
				"system user with NO current record, so [field] is a hard error. Fetch rows with select() " +
				"(or query()) inside the job action instead.",
			lineOf(src, first.index ?? 0),
		);
	}
	if (mode === "batch" && execBlock) {
		const inExec = recordRefs.filter(
			(m) => (m.index ?? 0) >= execBlock.start && (m.index ?? 0) < execBlock.end,
		);
		if (inExec.length > 0) {
			add(
				"error",
				"batch-record-context",
				`executionMode is 'batch' but execute: uses record-context [${inExec[0][1]}] — in batch mode ` +
					"there is no current record. Iterate the selection instead: `for rec in records { rec[field] }`.",
				lineOf(src, inExec[0].index ?? 0),
			);
		}
	}

	// ── SQL placeholders are @name, not :name ──
	// Scan the RAW source: the placeholder lives inside a string literal, which
	// `code` has blanked out. The literal is read with an escape-aware scanner,
	// so `query('... \' ...')` doesn't truncate mid-SQL.
	for (const { sql, index, end } of sqlLiterals(src)) {
		const bad = sql.match(/(?<![:\w]):([a-z][a-z0-9_]*)/i);
		if (bad) {
			add(
				"error",
				"sql-placeholder",
				`SQL uses ':${bad[1]}' as a placeholder — dForge binds '@${bad[1]}'. ` +
					`Rewrite as '@${bad[1]}' and pass { ${bad[1]}: value } as the params argument.`,
				lineOf(src, index),
			);
		}
		// Concatenation is detected on what FOLLOWS the literal in the source
		// (`'SELECT …' + userInput`), not on the decoded text.
		const after = src.slice(end, end + 40);
		if (/^\s*\+/.test(after)) {
			add(
				"warning",
				"sql-concat",
				"SQL string looks concatenated — build queries with @placeholders + a params object, " +
					"never by string concatenation.",
				lineOf(src, index),
			);
		}
	}

	// ── Top-level `return` ──
	// Not valid outside a function body; use exit()/error() to stop an action.
	// When the body declares no function at all, EVERY return is top-level —
	// including the inline `if (x) { return }` form. Once a `function` appears,
	// distinguishing the two needs a parser, so fall back to the line-anchored
	// form (which catches the usual formatting) rather than risk a false
	// positive on a legitimate helper's return.
	if (execBlock) {
		const declaresFunction = /\bfunction\b/.test(execCode);
		const returnRe = declaresFunction ? /^[ \t]{0,8}return\b/gm : /\breturn\b/g;
		for (const m of execCode.matchAll(returnRe)) {
			add(
				"error",
				"top-level-return",
				"top-level `return` is invalid in a DSL body. Use exit('msg', 'info') to stop and commit, " +
					"or error('msg') to stop and roll back.",
				lineOf(src, execOffset + (m.index ?? 0)),
			);
		}
	}

	// ── Unknown host functions ──
	// Locally declared functions/vars are collected first so user helpers don't
	// trip this. Method calls (`x.foo()`) are excluded by the lookbehind.
	const local = new Set<string>();
	for (const m of code.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)/g)) local.add(m[1]);
	for (const m of code.matchAll(/\bvar\s+([A-Za-z_$][\w$]*)/g)) local.add(m[1]);
	const reported = new Set<string>();
	for (const m of code.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
		const fn = m[1];
		if (
			DSL_BUILTINS.has(fn) ||
			JS_RESERVED.has(fn) ||
			local.has(fn) ||
			reported.has(fn) ||
			FORMULA_ONLY.includes(fn)
		) {
			continue;
		}
		reported.add(fn);
		add(
			"warning",
			"unknown-builtin",
			`calls '${fn}()', which is not a DSL host function or a locally declared one. ` +
				"Check the name against dforge://docs/dsl (Built-in functions).",
			lineOf(src, m.index ?? 0),
		);
	}

	return issues;
}
