// Coverage for the DBML front-end: parseDbml (table/column/ref parsing, PK drop,
// snake-casing) and dbmlImport greenfield (no manifest → new module), proven
// consistent by running the validator over the written output.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { parseDbml, dbmlImport } from "../src/tools/import";
import { moduleValidate } from "../src/tools/module-validate";

const DBML = `
// a small blog schema
Table Users {
  id integer [pk]
  name varchar [not null]
  email varchar
}

Table OrderLines {
  id integer [pk]
  title varchar
  user_id integer [ref: > Users.id]
}
`;

describe("parseDbml", () => {
	const tables = parseDbml(DBML);

	it("parses both tables and snake-cases names", () => {
		expect(tables.map((t) => t.name).sort()).toEqual(["order_lines", "users"]);
	});
	it("drops the PK column and keeps the rest", () => {
		const users = tables.find((t) => t.name === "users")!;
		const cols = users.columns.map((c) => c.name);
		expect(cols).toContain("name");
		expect(cols).toContain("email");
		expect(cols).not.toContain("id"); // PK dropped — identity trait provides it
		expect(users.columns.find((c) => c.name === "name")!.required).toBe(true);
	});
	it("turns an inline ref into a reference, remapped to the target's identity PK", () => {
		const lines = tables.find((t) => t.name === "order_lines")!;
		expect(lines.references).toEqual([{ column: "user_id", toTable: "users" }]); // toColumn omitted → defaults to users_id
		expect(lines.columns.map((c) => c.name)).not.toContain("user_id"); // FK column not a plain field
	});
});

describe("dbmlImport — greenfield", () => {
	const dir = mkdtempSync(join(tmpdir(), "dforge-mcp-dbml-"));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	const res = dbmlImport({ moduleDir: dir, dbml: DBML, module: { code: "blog", displayName: "Blog" } });

	it("creates a manifest and both entities", () => {
		const m = JSON.parse(res.files["manifest.json"]);
		expect(m.code).toBe("blog");
		expect(m.entities.users).toBeDefined();
		expect(m.entities.order_lines).toBeDefined();
		expect(m.moduleId).toBeTruthy();
	});
	it("builds the FK+Reference pair pointing at the identity PK", () => {
		const lines = JSON.parse(res.files["entities/order_lines.json"]);
		expect(lines.fields.user_id).toMatchObject({ dbDatatype: "cuid", flags: "EM" });
		expect(lines.fields.user.link).toEqual({ entity: "users", thisKey: "user_id", otherKey: "users_id" });
		expect(lines.references.FK_OrderLines_user_id.to).toEqual({ entity: "users", field: "users_id" });
	});
	it("the imported module validates clean", () => {
		for (const [rel, content] of Object.entries(res.files)) {
			const abs = join(dir, rel);
			mkdirSync(dirname(abs), { recursive: true });
			writeFileSync(abs, content);
		}
		const v = JSON.parse(moduleValidate({ moduleDir: dir }).files["_validate.json"]);
		expect(v.errors, JSON.stringify(v.errors)).toEqual([]);
	});

	it("requires module identity when the dir has no manifest", () => {
		const empty = mkdtempSync(join(tmpdir(), "dforge-mcp-dbml-empty-"));
		expect(() => dbmlImport({ moduleDir: empty, dbml: DBML })).toThrow(/manifest/);
		rmSync(empty, { recursive: true, force: true });
	});
});
