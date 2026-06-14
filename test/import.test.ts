// Coverage for dforge_module_import — the table-spec → entities transformer.
// Asserts the metadata-backed type inference and FK pair generation, then
// writes the result to disk and runs the validator to prove the output is
// internally consistent.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { moduleImport } from "../src/tools/import";
import { moduleValidate } from "../src/tools/module-validate";

const dir = mkdtempSync(join(tmpdir(), "dforge-mcp-import-"));
writeFileSync(join(dir, "manifest.json"), JSON.stringify({ code: "imp", displayName: "Imp", version: "0.1.0", dbSchemaVersion: "0.0.1", entities: {} }));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const { files } = moduleImport({
	moduleDir: dir,
	tables: [
		{
			name: "customer",
			columns: [
				{ name: "name", sqlType: "varchar(100)", required: true },
				{ name: "email", sqlType: "varchar(250)" },
				{ name: "age", sqlType: "int" },
				{ name: "balance", sqlType: "numeric(18,2)" },
				{ name: "active", sqlType: "bool" },
				{ name: "status", sampleValues: ["new", "new", "done", "new"] },
				{ name: "created", sqlType: "timestamptz" },
			],
		},
		{
			name: "sales_order",
			columns: [{ name: "total", sqlType: "numeric" }],
			references: [{ column: "customer_id", toTable: "customer" }],
		},
	],
});

const customer = JSON.parse(files["entities/customer.json"]);
const order = JSON.parse(files["entities/sales_order.json"]);

describe("module_import — type inference", () => {
	it("maps SQL types to field types + derives dbDatatype", () => {
		expect(customer.fields.name.fieldTypeCd).toBe("text");
		expect(customer.fields.name.dbDatatype).toBe("varchar");
		expect(customer.fields.name.flags).toBe("VEM"); // required
		expect(customer.fields.age.fieldTypeCd).toBe("number");
		expect(customer.fields.active.fieldTypeCd).toBe("checkbox");
		expect(customer.fields.active.dbDatatype).toBe("bool");
		expect(customer.fields.created.fieldTypeCd).toBe("datetime");
	});
	it("applies name heuristics (email, currency)", () => {
		expect(customer.fields.email.fieldTypeCd).toBe("email");
		expect(customer.fields.balance.fieldTypeCd).toBe("currency");
		expect(customer.fields.balance.dbDatatype).toBe("numeric(18,2)");
	});
	it("infers a dropdown from repeated sample values", () => {
		expect(customer.fields.status.fieldTypeCd).toBe("dropdown");
		const opts = customer.fields.status.params.options.map((o: { value: string }) => o.value).sort();
		expect(opts).toEqual(["done", "new"]);
	});
	it("picks a text field for toString", () => {
		expect(customer.toString).toBe("{name}");
	});
});

describe("module_import — FK + Reference pair", () => {
	it("generates the hidden FK + Reference + references block", () => {
		expect(order.fields.customer_id).toMatchObject({ dbDatatype: "cuid", flags: "EM" });
		expect(order.fields.customer).toMatchObject({
			columnType: "R",
			fieldTypeCd: "lookup",
			link: { entity: "customer", thisKey: "customer_id", otherKey: "customer_id" },
		});
		expect(order.references.FK_SalesOrder_customer_id).toMatchObject({
			from: { field: "customer_id" },
			to: { entity: "customer", field: "customer_id" },
		});
	});
	it("registers both entities in the manifest", () => {
		const m = JSON.parse(files["manifest.json"]);
		expect(m.entities.customer).toBe("./entities/customer.json");
		expect(m.entities.sales_order).toBe("./entities/sales_order.json");
	});
});

describe("module_import — output validates clean", () => {
	it("writing the import then validating finds no errors", () => {
		for (const [rel, content] of Object.entries(files)) {
			const abs = join(dir, rel);
			mkdirSync(dirname(abs), { recursive: true });
			writeFileSync(abs, content);
		}
		const res = JSON.parse(moduleValidate({ moduleDir: dir }).files["_validate.json"]);
		expect(res.errors, JSON.stringify(res.errors)).toEqual([]);
	});
});
