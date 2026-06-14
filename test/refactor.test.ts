// Coverage for dforge_entity_field_rename — the refactor-safe rename. The tool
// returns a file map (it never writes to disk), so we can run it against the
// read-only bundled example and assert the proposed file contents, plus a
// synthetic fixture for the formula + cross-entity paths the example lacks.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { entityFieldRename, entityFieldRemove, entityRename, entityDelete } from "../src/tools/refactor";

const EXAMPLE = join(process.cwd(), "skills", "dforge-mcp-author", "examples", "simple-todo");
const parse = (files: Record<string, string>, rel: string) => JSON.parse(files[rel]);

describe("entity_field_rename — example: rename a plain field", () => {
	const { files } = entityFieldRename({ moduleDir: EXAMPLE, entityName: "todo_list", fieldName: "name", newName: "title" });

	it("renames the field key on the entity", () => {
		const e = parse(files, "entities/todo_list.json");
		expect(e.fields.title).toBeDefined();
		expect(e.fields.name).toBeUndefined();
	});
	it("updates the data view column + order", () => {
		const v = parse(files, "ui/data_views.json");
		const ds = v.todo_list_grid.dataSources[0];
		expect(ds.columns.map((c: { column_cd: string }) => c.column_cd)).toContain("title");
		expect(ds.columns.map((c: { column_cd: string }) => c.column_cd)).not.toContain("name");
		expect(ds.order).toEqual(["title"]);
	});
	it("updates the seed-data records", () => {
		const seed = parse(files, "seed-data/01-lists.json");
		expect(seed.records[0].title).toBe("Personal");
		expect(seed.records[0].name).toBeUndefined();
	});
});

describe("entity_field_rename — example: rename the hidden FK column", () => {
	const { files } = entityFieldRename({ moduleDir: EXAMPLE, entityName: "todo_item", fieldName: "list_id", newName: "list_ref" });
	const e = parse(files, "entities/todo_item.json");

	it("renames the FK field and repoints the paired Reference's thisKey", () => {
		expect(e.fields.list_ref).toBeDefined();
		expect(e.fields.list_id).toBeUndefined();
		expect(e.fields.list.link.thisKey).toBe("list_ref");
	});
	it("updates the references block from.field", () => {
		expect(e.references.FK_TodoItem_List.from.field).toBe("list_ref");
		// to.field (the target PK) is untouched
		expect(e.references.FK_TodoItem_List.to.field).toBe("todo_list_id");
	});
});

describe("entity_field_rename — synthetic: formula + cross-entity FK", () => {
	const dir = mkdtempSync(join(tmpdir(), "dforge-mcp-rename-"));
	mkdirSync(join(dir, "entities"), { recursive: true });
	writeFileSync(
		join(dir, "manifest.json"),
		JSON.stringify({ code: "t", entities: { product: "./entities/product.json", line: "./entities/line.json" } }),
	);
	// product.sku is referenced by a same-entity formula and by line's FK otherKey.
	writeFileSync(
		join(dir, "entities", "product.json"),
		JSON.stringify({
			description: "Product",
			traits: ["identity"],
			fields: {
				sku: { fieldTypeCd: "text", dbDatatype: "varchar", flags: "VEM" },
				label: { columnType: "F", baseDatatypeCd: "string", flags: "V", formula: "[sku] + ' *'" },
			},
		}),
	);
	writeFileSync(
		join(dir, "entities", "line.json"),
		JSON.stringify({
			description: "Line",
			traits: ["identity"],
			fields: {
				product_sku: { fieldTypeCd: "text", dbDatatype: "varchar", flags: "EM" },
				product: { columnType: "R", fieldTypeCd: "lookup", flags: "VEM", link: { entity: "product", thisKey: "product_sku", otherKey: "sku" } },
			},
			references: { FK_Line_Product: { from: { field: "product_sku" }, to: { entity: "product", field: "sku" } } },
		}),
	);
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	const { files } = entityFieldRename({ moduleDir: dir, entityName: "product", fieldName: "sku", newName: "code" });

	it("rewrites the same-entity formula reference", () => {
		const p = parse(files, "entities/product.json");
		expect(p.fields.label.formula).toBe("[code] + ' *'");
	});
	it("repoints another entity's FK otherKey + references.to.field", () => {
		const l = parse(files, "entities/line.json");
		expect(l.fields.product.link.otherKey).toBe("code");
		expect(l.references.FK_Line_Product.to.field).toBe("code");
		// thisKey (the FK column on `line`) is unchanged — we renamed product.sku, not line.product_sku
		expect(l.fields.product.link.thisKey).toBe("product_sku");
	});
});

describe("entity_field_remove — cascade", () => {
	it("removing a plain field cleans the view column and seed key", () => {
		const { files } = entityFieldRemove({ moduleDir: EXAMPLE, entityName: "todo_list", fieldName: "color" });
		const e = parse(files, "entities/todo_list.json");
		expect(e.fields.color).toBeUndefined();
		const v = parse(files, "ui/data_views.json");
		expect(v.todo_list_grid.dataSources[0].columns.map((c: { column_cd: string }) => c.column_cd)).not.toContain("color");
		const seed = parse(files, "seed-data/01-lists.json");
		expect(seed.records[0].color).toBeUndefined();
		expect(seed.records[0].name).toBe("Personal"); // other keys preserved
	});

	it("removing a hidden FK also removes the paired Reference + references entry", () => {
		const { files } = entityFieldRemove({ moduleDir: EXAMPLE, entityName: "todo_item", fieldName: "list_id" });
		const e = parse(files, "entities/todo_item.json");
		expect(e.fields.list_id).toBeUndefined();
		expect(e.fields.list).toBeUndefined(); // paired Reference cascaded
		expect(e.references?.FK_TodoItem_List).toBeUndefined();
	});

	it("rejects an unknown field", () => {
		expect(() => entityFieldRemove({ moduleDir: EXAMPLE, entityName: "todo_list", fieldName: "nope" })).toThrow(/not found/);
	});
});

describe("entity_rename — example (todo_list → todo_board)", () => {
	const res = entityRename({ moduleDir: EXAMPLE, entityName: "todo_list", newName: "todo_board" });
	const files = res.files;

	it("moves the entity file and lists the old for deletion", () => {
		expect(files["entities/todo_board.json"]).toBeDefined();
		expect(res.deletes).toContain("entities/todo_list.json");
	});
	it("renames the manifest key + path", () => {
		const m = JSON.parse(files["manifest.json"]);
		expect(m.entities.todo_board).toBe("./entities/todo_board.json");
		expect(m.entities.todo_list).toBeUndefined();
	});
	it("repoints the child entity's FK link + PK", () => {
		const item = JSON.parse(files["entities/todo_item.json"]);
		expect(item.fields.list.link.entity).toBe("todo_board");
		expect(item.fields.list.link.otherKey).toBe("todo_board_id");
		expect(item.references.FK_TodoItem_List.to.entity).toBe("todo_board");
		expect(item.references.FK_TodoItem_List.to.field).toBe("todo_board_id");
	});
	it("repoints the data view entityCode", () => {
		const v = JSON.parse(files["ui/data_views.json"]);
		expect(v.todo_list_grid.dataSources[0].entityCode).toBe("todo_board");
	});
	it("renames the role rights key", () => {
		const r = JSON.parse(files["security/roles.json"]);
		expect(r["simple_todo.user"].rights.todo_board).toBe("SIUDC");
		expect(r["simple_todo.user"].rights.todo_list).toBeUndefined();
	});
	it("rewrites seed entityCode + PK key", () => {
		const seed = JSON.parse(files["seed-data/01-lists.json"]);
		expect(seed.entityCode).toBe("todo_board");
		expect(seed.records[0].todo_board_id).toBe(1001);
		expect(seed.records[0].todo_list_id).toBeUndefined();
	});
});

describe("entity_delete — example (todo_list)", () => {
	const res = entityDelete({ moduleDir: EXAMPLE, entityName: "todo_list" });

	it("drops the manifest entry and deletes the entity + seed files", () => {
		const m = JSON.parse(res.files["manifest.json"]);
		expect(m.entities.todo_list).toBeUndefined();
		expect(m.entities.todo_item).toBeDefined();
		expect(res.deletes).toContain("entities/todo_list.json");
		expect(res.deletes).toContain("seed-data/01-lists.json");
	});
	it("deletes the view whose only source was the entity", () => {
		const v = JSON.parse(res.files["ui/data_views.json"]);
		expect(v.todo_list_grid).toBeUndefined();
		expect(v.todo_item_grid).toBeDefined();
	});
	it("removes the role rights key", () => {
		const r = JSON.parse(res.files["security/roles.json"]);
		expect(r["simple_todo.user"].rights.todo_list).toBeUndefined();
	});
	it("warns about the dangling cross-entity FK", () => {
		expect(res.warning).toContain("todo_item");
	});
});

describe("entity_field_rename — guards", () => {
	it("rejects a name collision", () => {
		expect(() => entityFieldRename({ moduleDir: EXAMPLE, entityName: "todo_list", fieldName: "name", newName: "color" })).toThrow(/already exists/);
	});
	it("rejects an unknown field", () => {
		expect(() => entityFieldRename({ moduleDir: EXAMPLE, entityName: "todo_list", fieldName: "nope", newName: "x" })).toThrow(/not found/);
	});
	it("rejects a no-op rename", () => {
		expect(() => entityFieldRename({ moduleDir: EXAMPLE, entityName: "todo_list", fieldName: "name", newName: "name" })).toThrow(/differ/);
	});
});
