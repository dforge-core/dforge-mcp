// The module-aware half of the DSL rules — unknown columns, undeclared params,
// unqualified entity codes — only runs when a tool hands the checker the
// module's context. That wiring is what these cover: the rules themselves live
// in @dforge-core/metadata/dsl and are tested there.
//
// Every tool that checks a DSL body has to supply the same context, or an
// author fixes everything dforge_action_check reports and then fails at pack on
// something dforge_module_validate found.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { moduleValidate } from "../src/tools/module-validate";
import { actionCheck } from "../src/tools/action-check";
import { actionAdd } from "../src/tools/action-add";

let dir: string;
const validate = () => JSON.parse(moduleValidate({ moduleDir: dir }).files["_validate.json"]);

/** `product` has `name`, `sku`, plus the identity/audit trait columns. */
function makeModule(): void {
	mkdirSync(join(dir, "entities"), { recursive: true });
	mkdirSync(join(dir, "ui"), { recursive: true });
	mkdirSync(join(dir, "security"), { recursive: true });
	mkdirSync(join(dir, "logic", "actions"), { recursive: true });
	writeFileSync(
		join(dir, "manifest.json"),
		JSON.stringify({
			code: "shop",
			displayName: "Shop",
			dependencies: { fin: "^1.0.0" },
			entities: { product: "./entities/product.json" },
		}),
	);
	writeFileSync(
		join(dir, "entities", "product.json"),
		JSON.stringify({
			description: "Product",
			toString: "{name}",
			traits: ["identity", "audit"],
			fields: {
				name: { dbDatatype: "varchar", fieldTypeCd: "text", flags: "VEM", description: "Name" },
				sku: { dbDatatype: "varchar", fieldTypeCd: "text", flags: "VE", description: "SKU" },
			},
		}),
	);
	writeFileSync(
		join(dir, "ui", "data_views.json"),
		JSON.stringify({
			products: { viewType: "grid", label: "Products", dataSources: [{ entityCode: "product" }] },
		}),
	);
	writeFileSync(
		join(dir, "security", "roles.json"),
		JSON.stringify({ "shop.admin": { description: "Shop Administrator", rights: { product: "SIUDC" } } }),
	);
}

const writeAction = (entry: Record<string, unknown>, dsl: string) => {
	writeFileSync(join(dir, "ui", "actions.json"), JSON.stringify({ archive: entry }));
	writeFileSync(join(dir, "logic", "actions", `${entry.script}.dsl`), dsl);
};

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "dforge-mcp-dslctx-"));
	makeModule();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("module_validate hands the checker the entity's columns", () => {
	it("reports a [field] that is not a column, with its line", () => {
		writeAction(
			{ label: "Archive", entityCode: "product", script: "archive", executionMode: "single" },
			"execute:\n\tinfo('go')\n\t[nope] = 1\n",
		);
		const errs = validate().errors as Array<{ where: string; message: string }>;
		const hit = errs.find((e) => /nope/.test(e.message));
		expect(hit, JSON.stringify(errs)).toBeDefined();
		expect(hit?.where).toBe("logic/actions/archive.dsl:3");
	});

	it("counts trait-contributed columns as real ones", () => {
		// `created_date` is contributed by the audit trait, not authored — an
		// unexpanded column set would report it as unknown.
		writeAction(
			{ label: "Archive", entityCode: "product", script: "archive", executionMode: "single" },
			"execute:\n\t[created_date] = now()\n",
		);
		expect(validate().errors, JSON.stringify(validate().errors)).toEqual([]);
	});

	it("resolves an entity code qualified with this module's own prefix", () => {
		// `shop.product` and `product` are the same entity inside module `shop`
		// — the installer resolves both. Reading every dotted code as external
		// stands the column rules down on the qualified spelling, so the same
		// typo passes or fails depending on how the action names its entity.
		writeAction(
			{ label: "Archive", entityCode: "shop.product", script: "archive", executionMode: "single" },
			"execute:\n\tinfo('go')\n\t[nope] = 1\n",
		);
		expect(JSON.stringify(validate().errors)).toMatch(/nope/);
	});

	it("counts trait columns on a self-qualified entity code", () => {
		writeAction(
			{ label: "Archive", entityCode: "shop.product", script: "archive", executionMode: "single" },
			"execute:\n\t[created_date] = now()\n",
		);
		expect(validate().errors, JSON.stringify(validate().errors)).toEqual([]);
	});

	it("stands down for a cross-module entity it cannot resolve", () => {
		// A bridge action on a dependency's entity: the columns are in the other
		// module, so a guess here would block a pack on a module that installs.
		writeAction(
			{ label: "Archive", entityCode: "fin.invoice", script: "archive", executionMode: "single" },
			"execute:\n\t[whatever_column] = 1\n",
		);
		expect(JSON.stringify(validate().errors)).not.toMatch(/whatever_column/);
	});
});

describe("action_check reports what module_validate reports", () => {
	const unknownColumn = "execute:\n\t[nope] = 1\n";

	it("flags an unknown column on an on-disk action", () => {
		writeAction(
			{ label: "Archive", entityCode: "product", script: "archive", executionMode: "single" },
			unknownColumn,
		);
		const r = actionCheck({ moduleDir: dir, actionCode: "archive" });
		const out = JSON.parse(r.files["_action_check.json"]);
		expect(JSON.stringify(out.errors)).toMatch(/nope/);
	});

	it("agrees with module_validate on the same action", () => {
		writeAction(
			{ label: "Archive", entityCode: "product", script: "archive", executionMode: "single" },
			unknownColumn,
		);
		const checked = JSON.parse(actionCheck({ moduleDir: dir, actionCode: "archive" }).files["_action_check.json"]);
		const checkedRules = checked.errors.map((e: { message: string }) => e.message).sort();
		const validated = (validate().errors as Array<{ where?: string; message: string }>)
			.filter((e) => e.where?.startsWith("logic/actions/"))
			.map((e) => e.message.replace(/^\[archive\] /, ""))
			.sort();
		expect(checkedRules).toEqual(validated);
	});

	it("resolves a self-qualified entityCode the same way module_validate does", () => {
		writeAction(
			{ label: "Archive", entityCode: "shop.product", script: "archive", executionMode: "single" },
			unknownColumn,
		);
		const out = JSON.parse(actionCheck({ moduleDir: dir, actionCode: "archive" }).files["_action_check.json"]);
		expect(JSON.stringify(out.errors)).toMatch(/nope/);
	});

	it("checks a draft body against a self-qualified entity code", () => {
		const r = actionCheck({ moduleDir: dir, entityCode: "shop.product", dslBody: unknownColumn });
		expect(JSON.stringify(JSON.parse(r.files["_action_check.json"]).errors)).toMatch(/nope/);
	});

	it("checks a draft body against an entity when given one", () => {
		const r = actionCheck({ moduleDir: dir, entityCode: "product", dslBody: unknownColumn });
		expect(JSON.stringify(JSON.parse(r.files["_action_check.json"]).errors)).toMatch(/nope/);
	});

	it("leaves the column rules off for a bare draft with no module", () => {
		const r = actionCheck({ dslBody: unknownColumn });
		expect(JSON.parse(r.files["_action_check.json"]).errors).toEqual([]);
	});
});

describe("action_add checks the body against the entity it targets", () => {
	it("rejects a body that reads a column the entity does not have", () => {
		expect(() =>
			actionAdd({
				moduleDir: dir,
				code: "archive",
				entityCode: "product",
				label: "Archive",
				executionMode: "single",
				isAsync: false,
				dslBody: "execute:\n\t[nope] = 1\n",
			}),
		).toThrow(/nope/);
	});

	it("accepts one that reads a real column", () => {
		expect(() =>
			actionAdd({
				moduleDir: dir,
				code: "archive",
				entityCode: "product",
				label: "Archive",
				executionMode: "single",
				isAsync: false,
				dslBody: "execute:\n\t[sku] = 'archived'\n",
			}),
		).not.toThrow();
	});
});
