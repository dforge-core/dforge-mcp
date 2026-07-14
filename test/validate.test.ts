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

describe("module_validate — cross-module references", () => {
	const make = (dependencies: Record<string, unknown>) => {
		const dir = mkdtempSync(join(tmpdir(), "dforge-mcp-xmod-"));
		mkdirSync(join(dir, "entities"), { recursive: true });
		writeFileSync(join(dir, "manifest.json"), JSON.stringify({ code: "t", dependencies, entities: { line: "./entities/line.json" } }));
		writeFileSync(
			join(dir, "entities", "line.json"),
			JSON.stringify({
				description: "Line",
				traits: ["identity"],
				fields: {
					product_id: { dbDatatype: "cuid", flags: "EM" },
					product: { columnType: "R", fieldTypeCd: "lookup", flags: "VEM", link: { entity: "crm.product", thisKey: "product_id", otherKey: "product_id" } },
				},
			}),
		);
		const res = JSON.parse(moduleValidate({ moduleDir: dir }).files["_validate.json"]);
		rmSync(dir, { recursive: true, force: true });
		return res;
	};

	it("flags a dotted ref whose module is NOT a declared dependency", () => {
		const res = make({});
		expect(JSON.stringify(res.errors)).toContain("crm.product");
	});
	it("accepts a dotted ref to a declared dependency", () => {
		const res = make({ crm: ">=0.0.1" });
		expect(JSON.stringify(res.errors)).not.toContain("crm.product");
	});
});

describe("module_validate — role rights key resolution", () => {
	const make = (rights: Record<string, string>, dependencies: Record<string, unknown> = {}) => {
		const dir = mkdtempSync(join(tmpdir(), "dforge-mcp-roles-"));
		mkdirSync(join(dir, "entities"), { recursive: true });
		mkdirSync(join(dir, "security"), { recursive: true });
		writeFileSync(join(dir, "manifest.json"), JSON.stringify({ code: "t", dependencies, entities: { thing: "./entities/thing.json" } }));
		writeFileSync(join(dir, "entities", "thing.json"), JSON.stringify({ description: "Thing", traits: ["identity"], fields: { name: { fieldTypeCd: "text", dbDatatype: "varchar", flags: "VEM" } } }));
		writeFileSync(join(dir, "security", "roles.json"), JSON.stringify({ admin: { rights } }));
		const res = JSON.parse(moduleValidate({ moduleDir: dir }).files["_validate.json"]);
		rmSync(dir, { recursive: true, force: true });
		return res;
	};

	it("allows rights on a system entity (user)", () => {
		const res = make({ thing: "SIUDC", user: "S" });
		expect(JSON.stringify(res.errors)).not.toContain("user");
	});
	it("allows rights on a declared cross-module entity", () => {
		const res = make({ thing: "SIUDC", "crm.lead": "S" }, { crm: ">=0.0.1" });
		expect(JSON.stringify(res.errors)).not.toContain("crm.lead");
	});
	it("flags rights on an unknown entity", () => {
		const res = make({ thing: "SIUDC", phantom: "S" });
		expect(JSON.stringify(res.errors)).toContain("phantom");
	});
});

describe("module_validate — untranslated constraint messages", () => {
	// Builds a module with one entity carrying a check constraint that declares a
	// `message`, plus optional supportedLocales and translation files.
	const make = (opts: {
		supportedLocales?: string[];
		localeFiles?: Record<string, unknown>;
		message?: string;
		extends?: string;
	}) => {
		const dir = mkdtempSync(join(tmpdir(), "dforge-mcp-ckmsg-"));
		mkdirSync(join(dir, "entities"), { recursive: true });
		mkdirSync(join(dir, "translations"), { recursive: true });
		const manifest: Record<string, unknown> = { code: "t", entities: { thing: "./entities/thing.json" } };
		if (opts.supportedLocales) manifest.supportedLocales = opts.supportedLocales;
		writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
		const entity: Record<string, unknown> = {
			description: "Thing",
			traits: ["identity"],
			fields: { qty: { fieldTypeCd: "number", dbDatatype: "int4", flags: "VEM" } },
			constraints: { chk_qty_positive: { type: "check", expression: "qty > 0", ...(opts.message !== undefined ? { message: opts.message } : {}) } },
		};
		if (opts.extends) entity.extends = opts.extends;
		writeFileSync(join(dir, "entities", "thing.json"), JSON.stringify(entity));
		for (const [locale, content] of Object.entries(opts.localeFiles ?? {})) {
			writeFileSync(join(dir, "translations", `${locale}.json`), JSON.stringify(content));
		}
		const res = JSON.parse(moduleValidate({ moduleDir: dir }).files["_validate.json"]);
		rmSync(dir, { recursive: true, force: true });
		return res;
	};

	it("no supportedLocales → no constraint-translation warning (opt-in)", () => {
		const res = make({ message: "Qty must be positive" });
		expect(JSON.stringify(res.warnings)).not.toContain("chk_qty_positive");
	});

	it("warns when a declared locale lacks the constraint override", () => {
		const res = make({ supportedLocales: ["de-DE"], message: "Qty must be positive" });
		expect(res.ok).toBe(true); // never an error
		expect(JSON.stringify(res.warnings)).toContain("chk_qty_positive");
		expect(JSON.stringify(res.warnings)).toContain("de-DE");
	});

	it("no warning when the override is present (case-insensitive file match)", () => {
		const res = make({
			supportedLocales: ["de-DE"],
			message: "Qty must be positive",
			localeFiles: { "de-de": { entities: { thing: { constraints: { chk_qty_positive: { message: "Menge muss positiv sein" } } } } } },
		});
		expect(JSON.stringify(res.warnings)).not.toContain("chk_qty_positive");
	});

	it("does not warn for English locales or constraints without a message", () => {
		expect(JSON.stringify(make({ supportedLocales: ["en-US"], message: "Qty must be positive" }).warnings)).not.toContain("chk_qty_positive");
		expect(JSON.stringify(make({ supportedLocales: ["de-DE"] }).warnings)).not.toContain("chk_qty_positive");
	});

	it("skips extension entities (foreign module owns the translation)", () => {
		const res = make({ supportedLocales: ["de-DE"], message: "Qty must be positive", extends: "fin.invoice" });
		expect(JSON.stringify(res.warnings)).not.toContain("chk_qty_positive");
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
