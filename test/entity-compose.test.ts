// Coverage for the composite entity tools. Their whole reason to exist is that
// the BROKEN shapes should not be expressible — so most of these assert on the
// refusals, not just the happy path.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	entityReferenceAdd,
	entityRollupAdd,
	entityStatusAdd,
} from "../src/tools/entity-compose";
import { moduleValidate } from "../src/tools/module-validate";
import { applyToDisk } from "../src/tools/apply";
import type { ToolResult } from "../src/tools/_helpers";

let dir: string;

/** A two-entity module: `invoice` (parent) and `invoice_line` (child). */
function makeModule(lineFields: Record<string, unknown> = {}): void {
	mkdirSync(join(dir, "entities"), { recursive: true });
	writeFileSync(
		join(dir, "manifest.json"),
		JSON.stringify({
			code: "fin",
			displayName: "Finance",
			entities: { invoice: "./entities/invoice.json", invoice_line: "./entities/invoice_line.json" },
		}),
	);
	writeFileSync(
		join(dir, "entities", "invoice.json"),
		JSON.stringify({
			description: "Invoice",
			toString: "{invoice_id}",
			traits: ["identity", "audit"],
			fields: { number: { dbDatatype: "varchar", fieldTypeCd: "text", flags: "VEM", orderNum: 10 } },
		}),
	);
	writeFileSync(
		join(dir, "entities", "invoice_line.json"),
		JSON.stringify({
			description: "Invoice Line",
			toString: "{invoice_line_id}",
			traits: ["identity", "audit"],
			fields: {
				invoice_id: { dbDatatype: "cuid", flags: "EM", orderNum: 10 },
				amount: { dbDatatype: "numeric(18,2)", fieldTypeCd: "currency", flags: "VEM", orderNum: 20 },
				...lineFields,
			},
		}),
	);
}

const apply = (r: ToolResult) => applyToDisk(dir, r);
const entity = (name: string) => JSON.parse(readFileSync(join(dir, "entities", `${name}.json`), "utf8"));

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "dforge-mcp-compose-"));
	makeModule();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("entity_reference_add", () => {
	it("emits all three parts of the FK+Reference pattern", () => {
		apply(
			entityReferenceAdd({
				moduleDir: dir,
				entity: "invoice_line",
				targetEntity: "invoice",
				name: "invoice",
				fkField: "invoice_id",
				required: true,
			}),
		);
		const e = entity("invoice_line");
		expect(e.fields.invoice).toMatchObject({
			columnType: "R",
			fieldTypeCd: "lookup",
			flags: "VEM",
			link: { entity: "invoice", thisKey: "invoice_id", otherKey: "invoice_id" },
		});
		// The Reference column owns no physical column.
		expect(e.fields.invoice.dbDatatype).toBeUndefined();
		expect(Object.values(e.references)).toContainEqual({
			from: { field: "invoice_id" },
			to: { entity: "invoice", field: "invoice_id" },
		});
	});

	it("optional relations get VE, required get VEM", () => {
		apply(
			entityReferenceAdd({
				moduleDir: dir,
				entity: "invoice",
				targetEntity: "invoice",
				name: "parent",
				required: false,
			}),
		);
		expect(entity("invoice").fields.parent.flags).toBe("VE");
	});

	it("refuses to overwrite an existing visible column", () => {
		expect(() =>
			entityReferenceAdd({
				moduleDir: dir,
				entity: "invoice_line",
				targetEntity: "invoice",
				name: "amount",
				required: true,
			}),
		).toThrow(/already exists/);
	});

	it("completes a half-built relation by reusing an existing FK column", () => {
		// A DBML/table-spec import creates FK columns without their Reference
		// half; this is the tool that finishes the job.
		const r = entityReferenceAdd({
			moduleDir: dir,
			entity: "invoice_line",
			targetEntity: "invoice",
			name: "invoice",
			fkField: "invoice_id", // already present in the fixture
			required: true,
		});
		expect(r.summary).toContain("reused existing FK");
		apply(r);
		const e = entity("invoice_line");
		expect(e.fields.invoice_id).toMatchObject({ dbDatatype: "cuid", flags: "EM" });
		expect(e.fields.invoice.link.thisKey).toBe("invoice_id");
	});

	it("normalizes a reused FK column that isn't in the hidden-FK shape", () => {
		// An import commonly emits the FK as a visible numeric column. Reusing it
		// as-is would produce a pair that looks complete and fails at install.
		rmSync(dir, { recursive: true, force: true });
		dir = mkdtempSync(join(tmpdir(), "dforge-mcp-compose-"));
		makeModule({
			invoice_id: {
				dbDatatype: "int8",
				fieldTypeCd: "number",
				flags: "VEM",
				orderNum: 15,
				description: "Invoice Ref",
			},
		});
		const r = entityReferenceAdd({
			moduleDir: dir,
			entity: "invoice_line",
			targetEntity: "invoice",
			name: "invoice",
			fkField: "invoice_id",
			required: true,
		});
		expect(r.warning).toMatch(/normalized/);
		expect(r.warning).toContain("'int8' → 'cuid'");
		expect(r.warning).toContain("flags 'VEM' → 'EM'");
		expect(r.warning).toContain("dropped fieldTypeCd 'number'");
		apply(r);

		const fk = entity("invoice_line").fields.invoice_id;
		expect(fk).toMatchObject({ dbDatatype: "cuid", flags: "EM" });
		expect(fk.fieldTypeCd).toBeUndefined();
		expect(fk.columnType).toBeUndefined();
		// Author metadata is preserved.
		expect(fk.orderNum).toBe(15);
		expect(fk.description).toBe("Invoice Ref");

		// And the result actually validates.
		const res = JSON.parse(moduleValidate({ moduleDir: dir }).files["_validate.json"]);
		expect(res.errors, JSON.stringify(res.errors)).toEqual([]);
	});

	it("reuses an already-correct FK column without reporting changes", () => {
		const r = entityReferenceAdd({
			moduleDir: dir,
			entity: "invoice_line",
			targetEntity: "invoice",
			name: "invoice",
			fkField: "invoice_id", // fixture already has cuid/EM
			required: true,
		});
		expect(r.warning).toBeUndefined();
		expect(r.summary).not.toContain("normalized");
	});

	it("refuses to reuse a structural column as the hidden FK", () => {
		rmSync(dir, { recursive: true, force: true });
		dir = mkdtempSync(join(tmpdir(), "dforge-mcp-compose-"));
		makeModule({ tag: { columnType: "F", baseDatatypeCd: "string", flags: "V", formula: "'x'" } });
		expect(() =>
			entityReferenceAdd({
				moduleDir: dir,
				entity: "invoice_line",
				targetEntity: "invoice",
				name: "parent",
				fkField: "tag",
				required: true,
			}),
		).toThrow(/as a 'F' column/);
	});

	it("refuses a self-reference whose derived FK collides with the PK", () => {
		expect(() =>
			entityReferenceAdd({
				moduleDir: dir,
				entity: "invoice",
				targetEntity: "invoice",
				name: "invoice",
				required: false,
			}),
		).toThrow(/collides with .* identity PK/);
	});

	it("warns when the target is cross-module", () => {
		const r = entityReferenceAdd({
			moduleDir: dir,
			entity: "invoice_line",
			targetEntity: "crm.product",
			name: "product",
			required: false,
		});
		expect(r.warning).toContain("declared dependency");
	});
});

describe("entity_rollup_add", () => {
	it("emits a Generated column and creates the Set column", () => {
		apply(
			entityRollupAdd({
				moduleDir: dir,
				entity: "invoice",
				name: "total",
				childEntity: "invoice_line",
				childField: "amount",
				agg: "SUM",
				setField: "lines",
			}),
		);
		const e = entity("invoice");
		expect(e.fields.total).toMatchObject({
			columnType: "G",
			dbDatatype: "numeric(18,2)",
			formula: "SUM([lines].[amount])",
			flags: "V",
		});
		// Generated columns take dbDatatype, never baseDatatypeCd (that's Formula).
		expect(e.fields.total.baseDatatypeCd).toBeUndefined();
		expect(e.fields.lines).toMatchObject({
			columnType: "S",
			link: { entity: "invoice_line", thisKey: "invoice_id", otherKey: "invoice_id" },
		});
	});

	it("refuses to aggregate a virtual child column", () => {
		rmSync(dir, { recursive: true, force: true });
		dir = mkdtempSync(join(tmpdir(), "dforge-mcp-compose-"));
		makeModule({
			computed: { columnType: "F", baseDatatypeCd: "decimal", flags: "V", formula: "[amount] * 2" },
		});
		expect(() =>
			entityRollupAdd({
				moduleDir: dir,
				entity: "invoice",
				name: "total",
				childEntity: "invoice_line",
				childField: "computed",
				agg: "SUM",
			}),
		).toThrow(/virtual 'F' column/);
	});

	it("COUNT and AVG pick their own datatype", () => {
		apply(
			entityRollupAdd({
				moduleDir: dir,
				entity: "invoice",
				name: "line_count",
				childEntity: "invoice_line",
				childField: "amount",
				agg: "COUNT",
				setField: "lines",
			}),
		);
		expect(entity("invoice").fields.line_count.dbDatatype).toBe("int8");
	});

	it("explains how to fix a missing back-reference on the child", () => {
		rmSync(dir, { recursive: true, force: true });
		dir = mkdtempSync(join(tmpdir(), "dforge-mcp-compose-"));
		mkdirSync(join(dir, "entities"), { recursive: true });
		writeFileSync(
			join(dir, "manifest.json"),
			JSON.stringify({ code: "fin", entities: { invoice: "./entities/invoice.json", note: "./entities/note.json" } }),
		);
		writeFileSync(
			join(dir, "entities", "invoice.json"),
			JSON.stringify({ toString: "{invoice_id}", traits: ["identity"], fields: {} }),
		);
		writeFileSync(
			join(dir, "entities", "note.json"),
			JSON.stringify({
				toString: "{note_id}",
				traits: ["identity"],
				fields: { qty: { dbDatatype: "int", fieldTypeCd: "number", flags: "VEM" } },
			}),
		);
		expect(() =>
			entityRollupAdd({
				moduleDir: dir,
				entity: "invoice",
				name: "total",
				childEntity: "note",
				childField: "qty",
				agg: "SUM",
			}),
		).toThrow(/dforge_entity_reference_add/);
	});
});

describe("entity_status_add", () => {
	it("emits params.options objects and a formula initial value", () => {
		apply(
			entityStatusAdd({
				moduleDir: dir,
				entity: "invoice",
				name: "status",
				options: ["draft", "posted", "paid"],
				initial: "draft",
				required: true,
			}),
		);
		const f = entity("invoice").fields.status;
		expect(f).toMatchObject({ fieldTypeCd: "dropdown", dbDatatype: "varchar", flags: "VEM" });
		expect(f.params.options).toEqual([
			{ value: "draft", label: "Draft" },
			{ value: "posted", label: "Posted" },
			{ value: "paid", label: "Paid" },
		]);
		// Entity fields have no defaultValue key — the initial value is a formula.
		expect(f.formula).toBe("'draft'");
		expect(f.defaultValue).toBeUndefined();
		expect(f.options).toBeUndefined();
	});

	it("keeps author-supplied labels and colors", () => {
		apply(
			entityStatusAdd({
				moduleDir: dir,
				entity: "invoice",
				name: "stage",
				options: [{ value: "wip", label: "In Progress", color: "#f90" }, { value: "done" }],
				required: true,
			}),
		);
		const opts = entity("invoice").fields.stage.params.options;
		expect(opts[0]).toEqual({ value: "wip", label: "In Progress", color: "#f90" });
		expect(opts[1]).toEqual({ value: "done", label: "Done" });
	});

	it("rejects an initial value that isn't one of the options", () => {
		expect(() =>
			entityStatusAdd({
				moduleDir: dir,
				entity: "invoice",
				name: "status",
				options: ["draft", "posted"],
				initial: "archived",
				required: true,
			}),
		).toThrow(/not one of the declared options/);
	});

	it("rejects duplicate option values", () => {
		expect(() =>
			entityStatusAdd({
				moduleDir: dir,
				entity: "invoice",
				name: "status",
				options: ["draft", "draft"],
				required: true,
			}),
		).toThrow(/Duplicate status value/);
	});
});

describe("composite output validates clean", () => {
	it("a module built entirely from composite tools has no validation errors", () => {
		apply(
			entityReferenceAdd({
				moduleDir: dir,
				entity: "invoice_line",
				targetEntity: "invoice",
				name: "invoice",
				fkField: "invoice_id",
				required: true,
			}),
		);
		apply(
			entityRollupAdd({
				moduleDir: dir,
				entity: "invoice",
				name: "total",
				childEntity: "invoice_line",
				childField: "amount",
				agg: "SUM",
				setField: "lines",
			}),
		);
		apply(
			entityStatusAdd({
				moduleDir: dir,
				entity: "invoice",
				name: "status",
				options: ["draft", "posted"],
				required: true,
			}),
		);
		const res = JSON.parse(moduleValidate({ moduleDir: dir }).files["_validate.json"]);
		expect(res.errors, JSON.stringify(res.errors)).toEqual([]);
	});
});
