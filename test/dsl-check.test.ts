// Coverage for the DSL static checker. Every `error` rule below corresponds to
// a documented install/runtime failure in dforge://docs/dsl — the whole point
// is catching them without a tenant round trip.

import { describe, expect, it } from "vitest";
import { checkDsl } from "../src/tools/dsl-check";

const rules = (src: string, opts = {}) => checkDsl(src, opts).map((i) => i.rule);
const errors = (src: string, opts = {}) =>
	checkDsl(src, opts).filter((i) => i.level === "error").map((i) => i.rule);

describe("dsl-check — structure", () => {
	it("accepts the canonical example body", () => {
		expect(checkDsl("canExecute:\n\t[done] = false\n\nexecute:\n\t[done] = true\n\tinfo('Marked as done')\n")).toEqual([]);
	});

	it("requires an execute block", () => {
		expect(errors("params:\n\tqty: number required 'Qty'\n")).toContain("missing-execute");
		expect(errors("")).toContain("dsl-empty");
	});

	it("enforces block order and rejects duplicates", () => {
		expect(errors("execute:\n\tinfo('x')\n\ncanExecute:\n\t[done] = false\n")).toContain("block-order");
		expect(errors("execute:\n\tinfo('a')\n\nexecute:\n\tinfo('b')\n")).toContain("duplicate-block");
	});
});

describe("dsl-check — formula-only dates in execute", () => {
	it("rejects TODAY() inside execute (install fails: 'TODAY' is not defined)", () => {
		const found = checkDsl("execute:\n\t[due] = TODAY()\n");
		expect(found[0].rule).toBe("execute-formula-date");
		expect(found[0].level).toBe("error");
		expect(found[0].line).toBe(2);
	});

	it("allows TODAY() in canExecute — it is valid there", () => {
		expect(errors("canExecute:\n\t[due] < TODAY()\n\nexecute:\n\t[done] = true\n")).toEqual([]);
	});

	it("allows lowercase now() anywhere", () => {
		expect(errors("execute:\n\t[approved_at] = now()\n")).toEqual([]);
	});
});

describe("dsl-check — record context", () => {
	const body = "execute:\n\t[status] = 'done'\n";

	it("is fine in single mode", () => {
		expect(errors(body, { executionMode: "single" })).toEqual([]);
	});

	it("rejects [field] in batch mode", () => {
		expect(errors(body, { executionMode: "batch" })).toContain("batch-record-context");
	});

	it("rejects [field] in a job-invoked action", () => {
		expect(errors(body, { viaJob: true })).toContain("job-record-context");
	});

	it("does not mistake params[x], rec[x] or records[0][x] for record context", () => {
		const ok = "execute:\n\tfor rec in records {\n\t\trec[status] = params[newStatus]\n\t}\n";
		expect(errors(ok, { executionMode: "batch" })).toEqual([]);
	});

	it("ignores bracketed text inside string literals", () => {
		expect(errors("execute:\n\tinfo('use [status] to filter')\n", { viaJob: true })).toEqual([]);
	});
});

describe("dsl-check — SQL", () => {
	it("rejects :name placeholders (dForge binds @name)", () => {
		const found = checkDsl("execute:\n\tvar r = query('SELECT a FROM t WHERE b = :cid', { cid: 1 })\n");
		expect(found.map((i) => i.rule)).toContain("sql-placeholder");
		expect(found.find((i) => i.rule === "sql-placeholder")?.message).toContain("@cid");
	});

	it("accepts @name placeholders", () => {
		expect(errors("execute:\n\tvar r = query('SELECT a FROM t WHERE b = @cid', { cid: 1 })\n")).toEqual([]);
	});

	it("does not flag a PostgreSQL ::cast", () => {
		expect(errors("execute:\n\tvar r = query('SELECT a::text FROM t')\n")).toEqual([]);
	});

	it("reads past an escaped quote inside the SQL", () => {
		// A regex-based extractor stops at the escaped quote and never sees the
		// ':cid' that follows — a false negative.
		const src = "execute:\n\tvar r = query('SELECT a FROM t WHERE b = \\'x\\' AND c = :cid', { cid: 1 })\n";
		expect(errors(src)).toContain("sql-placeholder");
	});

	it("does not read past the literal into surrounding code", () => {
		// The ':' here belongs to an object literal, not the SQL. An extractor
		// that over-runs the closing quote would report a false positive.
		const src = "execute:\n\tvar r = query('SELECT a FROM t WHERE b = @x', { x: [id] })\n";
		expect(errors(src)).toEqual([]);
	});

	it("handles an escaped backslash immediately before the closing quote", () => {
		const src = "execute:\n\tvar r = query('SELECT a FROM t WHERE p = @p\\\\', { p: 1 })\n";
		expect(errors(src)).toEqual([]);
	});

	it("ignores a call whose first argument is not a literal", () => {
		expect(errors("execute:\n\tvar sql = buildSql()\n\tvar r = query(sql, { a: 1 })\n")).toEqual([]);
	});

	it("flags concatenation after the literal, not a ':' inside it", () => {
		const src = "execute:\n\tvar r = query('SELECT a FROM t WHERE b = ' + params[v])\n";
		expect(rules(src)).toContain("sql-concat");
	});
});

describe("dsl-check — misc", () => {
	it("rejects a top-level return", () => {
		expect(errors("execute:\n\tif ([done]) { return }\n")).toContain("top-level-return");
	});

	it("warns on an unknown host function but not on known or local ones", () => {
		expect(rules("execute:\n\tsendSlack('hi')\n")).toContain("unknown-builtin");
		expect(rules("execute:\n\tinfo('hi')\n\tvar x = getSetting('a')\n")).not.toContain("unknown-builtin");
		expect(rules("execute:\n\tfunction helper() { return 1 }\n\tvar y = helper()\n")).not.toContain(
			"unknown-builtin",
		);
	});

	it("does not treat method calls as host functions", () => {
		expect(rules("execute:\n\tvar n = records.count()\n\tvar s = params[name].trim()\n")).not.toContain(
			"unknown-builtin",
		);
	});

	it("comments are not scanned", () => {
		expect(errors("execute:\n\t# [status] would be wrong here\n\tinfo('ok')\n", { viaJob: true })).toEqual([]);
	});
});
