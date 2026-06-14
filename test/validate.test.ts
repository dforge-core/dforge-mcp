// Coverage for dforge_module_validate — the offline cross-reference check.
// The canonical simple-todo example must validate clean; a hand-broken fixture
// must surface each class of cross-reference error.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { moduleValidate } from "../src/tools/module-validate";

const run = (dir: string) => JSON.parse(moduleValidate({ moduleDir: dir }).files["_validate.json"]);

describe("module_validate — canonical example", () => {
	it("the bundled simple-todo example has no errors", () => {
		// vitest runs from the package root.
		const dir = join(process.cwd(), "skills", "dforge-mcp-author", "examples", "simple-todo");
		const res = run(dir);
		expect(res.errors, JSON.stringify(res.errors)).toEqual([]);
	});
});

describe("module_validate — broken fixture", () => {
	const dir = mkdtempSync(join(tmpdir(), "dforge-mcp-validate-"));
	mkdirSync(join(dir, "entities"), { recursive: true });
	mkdirSync(join(dir, "ui"), { recursive: true });
	mkdirSync(join(dir, "security"), { recursive: true });

	writeFileSync(
		join(dir, "manifest.json"),
		JSON.stringify({ code: "t", displayName: "T", entities: { thing: "./entities/thing.json" } }),
	);
	// `ghost` references a non-existent entity AND its hidden FK column (ghost_id) is missing.
	writeFileSync(
		join(dir, "entities", "thing.json"),
		JSON.stringify({
			description: "Thing",
			traits: ["identity"],
			fields: {
				name: { fieldTypeCd: "text", dbDatatype: "varchar", flags: "VEM" },
				ghost: {
					columnType: "R",
					fieldTypeCd: "lookup",
					flags: "VEM",
					link: { entity: "nonexistent", thisKey: "ghost_id", otherKey: "nonexistent_id" },
				},
			},
		}),
	);
	// View references a column that doesn't exist on `thing`.
	writeFileSync(
		join(dir, "ui", "data_views.json"),
		JSON.stringify({
			thing_grid: {
				viewType: "grid",
				dataSources: [{ entityCode: "thing", columns: [{ column_cd: "name" }, { column_cd: "nosuchcol" }] }],
			},
		}),
	);
	// Role grants on an entity that doesn't exist; `thing` is covered (Select).
	writeFileSync(
		join(dir, "security", "roles.json"),
		JSON.stringify({ admin: { rights: { thing: "SIUDC", phantom: "SIUDC" } } }),
	);

	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	const res = run(dir);
	const msgs = JSON.stringify(res.errors);

	it("flags the module as not ok", () => {
		expect(res.ok).toBe(false);
	});
	it("catches the dangling reference target", () => {
		expect(msgs).toContain("nonexistent");
	});
	it("catches the missing hidden-FK column", () => {
		expect(msgs).toContain("ghost_id");
	});
	it("catches the unknown view column", () => {
		expect(msgs).toContain("nosuchcol");
	});
	it("catches the role right on an unknown entity", () => {
		expect(msgs).toContain("phantom");
	});
	it("does NOT flag the valid column or the covered entity", () => {
		expect(msgs).not.toContain("'name'");
	});
});
