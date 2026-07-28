// Coverage for the shared field rules. The key property under test is that
// they're enforced in BOTH places — the authoring-time zod schema and the
// whole-module validator — so a field can't slip in through an import or a
// hand edit and reach install unchecked.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { checkFieldSpec, parseSetAggregate, isHiddenFk } from "../src/tools/field-rules";
import { moduleValidate } from "../src/tools/module-validate";

const messages = (field: unknown) => checkFieldSpec("e.f", field).map((i) => i.message).join(" | ");
const errorCount = (field: unknown) =>
	checkFieldSpec("e.f", field).filter((i) => i.level === "error").length;

describe("checkFieldSpec", () => {
	it("accepts a plain data column", () => {
		expect(checkFieldSpec("e.f", { dbDatatype: "varchar", fieldTypeCd: "text", flags: "VEM" })).toEqual([]);
	});

	it("rejects defaultValue / default (settings-only keys)", () => {
		expect(messages({ fieldTypeCd: "text", defaultValue: "x" })).toMatch(/no 'defaultValue'/);
		expect(messages({ fieldTypeCd: "text", default: "x" })).toMatch(/no 'defaultValue'/);
	});

	it("rejects options at the field root", () => {
		expect(messages({ fieldTypeCd: "dropdown", options: ["a"] })).toMatch(/params\.options/);
	});

	it("rejects invalid flag letters", () => {
		expect(messages({ fieldTypeCd: "text", flags: "VEMU" })).toMatch(/only V\/I\/E\/M\/H/);
		expect(checkFieldSpec("e.f", { fieldTypeCd: "text", flags: "VEM" })).toEqual([]);
	});

	it("suggests the right fieldTypeCd for a common wrong one", () => {
		expect(messages({ fieldTypeCd: "integer" })).toMatch(/Did you mean 'number'/);
		expect(messages({ fieldTypeCd: "reference" })).toMatch(/Did you mean 'lookup'/);
	});

	it("rejects a UI control used as a dbDatatype", () => {
		expect(messages({ fieldTypeCd: "checkbox", dbDatatype: "boolean" })).toMatch(/use 'bool'/);
		expect(messages({ fieldTypeCd: "text", dbDatatype: "string" })).toMatch(/use 'varchar'/);
		expect(messages({ fieldTypeCd: "datetime", dbDatatype: "datetime" })).toMatch(/use 'timestamptz'/);
	});

	it("renders a multi-option suggestion with balanced quotes", () => {
		// 'number' is a fieldTypeCd; the right SQL type depends on range/precision,
		// so the suggestion is a list. Each option must be individually quoted —
		// no stray or unmatched quote characters in the emitted text.
		const msg = messages({ dbDatatype: "number" });
		expect(msg).toContain("use 'int' / 'bigint' / 'numeric'.");
		const quotes = (msg.match(/'/g) ?? []).length;
		expect(quotes % 2).toBe(0);
	});

	it("enforces the formula-column shape", () => {
		// F needs baseDatatypeCd + formula and must NOT carry dbDatatype.
		const bad = { columnType: "F", dbDatatype: "varchar", flags: "V" };
		expect(messages(bad)).toMatch(/requires 'baseDatatypeCd'/);
		expect(messages(bad)).toMatch(/must NOT set 'dbDatatype'/);
		expect(
			checkFieldSpec("e.f", {
				columnType: "F",
				baseDatatypeCd: "string",
				flags: "V",
				formula: "[a] + [b]",
			}),
		).toEqual([]);
	});

	it("enforces the generated-column shape (the inverse of formula)", () => {
		const bad = { columnType: "G", baseDatatypeCd: "decimal", formula: "SUM([l].[a])" };
		expect(messages(bad)).toMatch(/requires 'dbDatatype'/);
		expect(messages(bad)).toMatch(/must NOT set 'baseDatatypeCd'/);
	});

	it("enforces the reference-column shape", () => {
		expect(messages({ columnType: "R", fieldTypeCd: "lookup", flags: "VEM" })).toMatch(
			/requires a 'link' object/,
		);
		expect(
			messages({
				columnType: "R",
				fieldTypeCd: "lookup",
				flags: "VEM",
				link: { entity: "x", thisKey: "x_id", otherKey: "id" },
			}),
		).toMatch(/never 'id'/);
		expect(
			messages({
				columnType: "R",
				fieldTypeCd: "lookup",
				flags: "VEM",
				dbDatatype: "cuid",
				link: { entity: "x", thisKey: "x_id", otherKey: "x_id" },
			}),
		).toMatch(/must NOT set 'dbDatatype'/);
	});

	it("rejects an unknown columnType", () => {
		expect(errorCount({ columnType: "ref" })).toBe(1);
	});
});

describe("isHiddenFk / parseSetAggregate", () => {
	it("recognizes the hidden half of an FK+Reference pair", () => {
		expect(isHiddenFk({ dbDatatype: "cuid", flags: "EM" })).toBe(true);
		expect(isHiddenFk({ dbDatatype: "cuid", flags: "VEM", fieldTypeCd: "lookup" })).toBe(false);
	});

	it("parses a set aggregate out of a formula", () => {
		expect(parseSetAggregate("SUM([lines].[amount])")).toEqual({
			agg: "SUM",
			setField: "lines",
			childField: "amount",
		});
		expect(parseSetAggregate("[qty] * [price]")).toBeNull();
		expect(parseSetAggregate("count([rows].[id])")?.agg).toBe("COUNT");
	});
});

describe("the validator re-runs the rules across the whole module", () => {
	// This is the property that matters: a field that never passed through the
	// entity_field_add schema (import, scaffolder, hand edit) is still checked.
	const validateWith = (fields: Record<string, unknown>) => {
		const dir = mkdtempSync(join(tmpdir(), "dforge-mcp-fieldrules-"));
		mkdirSync(join(dir, "entities"), { recursive: true });
		writeFileSync(
			join(dir, "manifest.json"),
			JSON.stringify({ code: "t", entities: { thing: "./entities/thing.json" } }),
		);
		writeFileSync(
			join(dir, "entities", "thing.json"),
			JSON.stringify({ toString: "{name}", traits: ["identity"], fields }),
		);
		try {
			return JSON.parse(moduleValidate({ moduleDir: dir }).files["_validate.json"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	};

	it("flags a hand-edited field with a defaultValue key", () => {
		const res = validateWith({
			name: { fieldTypeCd: "text", dbDatatype: "varchar", flags: "VEM" },
			state: { fieldTypeCd: "text", dbDatatype: "varchar", flags: "VE", defaultValue: "draft" },
		});
		expect(JSON.stringify(res.errors)).toMatch(/no 'defaultValue'/);
		expect(res.ok).toBe(false);
	});

	it("flags invalid flags that entered outside the authoring tool", () => {
		const res = validateWith({ name: { fieldTypeCd: "text", dbDatatype: "varchar", flags: "VEMS" } });
		expect(JSON.stringify(res.errors)).toMatch(/only V\/I\/E\/M\/H/);
	});

	it("flags an F column carrying a set aggregate", () => {
		const res = validateWith({
			name: { fieldTypeCd: "text", dbDatatype: "varchar", flags: "VEM" },
			total: {
				columnType: "F",
				baseDatatypeCd: "decimal",
				flags: "V",
				formula: "SUM([lines].[amount])",
			},
		});
		expect(JSON.stringify(res.errors)).toMatch(/silently renders empty/);
	});

	it("flags a toString referencing a column that doesn't exist", () => {
		const res = validateWith({ other: { fieldTypeCd: "text", dbDatatype: "varchar", flags: "VEM" } });
		expect(JSON.stringify(res.errors)).toMatch(/'toString' references \{name\}/);
	});
});
