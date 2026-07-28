// Coverage for menu_add / seed_add / translation_sync, plus the validator
// checks that back them: action script files, trigger/job action references,
// and translation completeness.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { menuAdd } from "../src/tools/menu";
import { seedAdd } from "../src/tools/seed";
import { translationSync } from "../src/tools/translations";
import { moduleValidate } from "../src/tools/module-validate";
import { applyToDisk } from "../src/tools/apply";
import type { ToolResult } from "../src/tools/_helpers";

let dir: string;
const apply = (r: ToolResult) => applyToDisk(dir, r);
const readJson = (rel: string) => JSON.parse(readFileSync(join(dir, rel), "utf8"));
const validate = () => JSON.parse(moduleValidate({ moduleDir: dir }).files["_validate.json"]);

/** A minimal but complete module: one entity, one view, one role. */
function makeModule(opts: { traits?: string[]; supportedLocales?: string[] } = {}): void {
	mkdirSync(join(dir, "entities"), { recursive: true });
	mkdirSync(join(dir, "ui"), { recursive: true });
	mkdirSync(join(dir, "security"), { recursive: true });
	const manifest: Record<string, unknown> = {
		code: "shop",
		displayName: "Shop",
		entities: { product: "./entities/product.json" },
	};
	if (opts.supportedLocales) manifest.supportedLocales = opts.supportedLocales;
	writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
	writeFileSync(
		join(dir, "entities", "product.json"),
		JSON.stringify({
			description: "Product",
			toString: "{name}",
			traits: opts.traits ?? ["identity", "audit"],
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

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "dforge-mcp-elements-"));
	makeModule();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("menu_add", () => {
	it("emits a leaf with dataViewCode + itemType and a bare icon name", () => {
		apply(
			menuAdd({
				moduleDir: dir,
				menu: "shop_menu",
				parentPath: "",
				code: "all_products",
				label: "Products",
				dataViewCode: "products",
				icon: "bi-box-seam",
			}),
		);
		expect(readJson("ui/menus.json").shop_menu.items.all_products).toMatchObject({
			itemType: "V",
			dataViewCode: "products",
			icon: "box-seam", // the bi- prefix belongs to ACTION icons, not menu icons
			orderNum: 1,
		});
	});

	it("emits a section node with no itemType, and nests under it", () => {
		apply(
			menuAdd({ moduleDir: dir, menu: "shop_menu", parentPath: "", code: "catalog", label: "Catalog" }),
		);
		const section = readJson("ui/menus.json").shop_menu.items.catalog;
		expect(section.itemType).toBeUndefined();
		expect(section.children).toEqual({});

		apply(
			menuAdd({
				moduleDir: dir,
				menu: "shop_menu",
				parentPath: "catalog",
				code: "products",
				label: "Products",
				dataViewCode: "products",
			}),
		);
		expect(readJson("ui/menus.json").shop_menu.items.catalog.children.products.dataViewCode).toBe(
			"products",
		);
	});

	it("refuses a dataViewCode with no matching view", () => {
		expect(() =>
			menuAdd({
				moduleDir: dir,
				menu: "shop_menu",
				parentPath: "",
				code: "ghost",
				label: "Ghost",
				dataViewCode: "does_not_exist",
			}),
		).toThrow(/no matching view/);
	});

	it("refuses to nest under a leaf", () => {
		apply(
			menuAdd({
				moduleDir: dir,
				menu: "shop_menu",
				parentPath: "",
				code: "leaf",
				label: "Leaf",
				dataViewCode: "products",
			}),
		);
		expect(() =>
			menuAdd({
				moduleDir: dir,
				menu: "shop_menu",
				parentPath: "leaf",
				code: "child",
				label: "Child",
			}),
		).toThrow(/is a leaf item/);
	});
});

describe("seed_add", () => {
	it("writes an ordered file keyed by entityCode", () => {
		const r = seedAdd({
			moduleDir: dir,
			entity: "product",
			records: [{ product_id: 1001, name: "Widget", sku: "W-1" }],
			order: 1,
		});
		apply(r);
		expect(readJson("seed-data/01-product.json")).toEqual({
			entityCode: "product",
			records: [{ product_id: 1001, name: "Widget", sku: "W-1" }],
		});
	});

	it("rejects a record with no PK, or an 'id' key instead", () => {
		expect(() =>
			seedAdd({ moduleDir: dir, entity: "product", records: [{ name: "x" }] }),
		).toThrow(/has no 'product_id'/);
		expect(() =>
			seedAdd({ moduleDir: dir, entity: "product", records: [{ id: 1, name: "x" }] }),
		).toThrow(/found 'id' instead/);
	});

	it("rejects a non-integer PK (cuid is int8, not a UUID)", () => {
		expect(() =>
			seedAdd({
				moduleDir: dir,
				entity: "product",
				records: [{ product_id: "a3f1-uuid", name: "x" }],
			}),
		).toThrow(/must be an INTEGER/);
	});

	it("rejects duplicate PKs and unknown columns", () => {
		expect(() =>
			seedAdd({
				moduleDir: dir,
				entity: "product",
				records: [{ product_id: 1, name: "a" }, { product_id: 1, name: "b" }],
			}),
		).toThrow(/Duplicate 'product_id'/);
		expect(() =>
			seedAdd({ moduleDir: dir, entity: "product", records: [{ product_id: 1, colour: "red" }] }),
		).toThrow(/not defined on 'product': colour/);
	});

	it("accepts trait-provided columns, using the registry's real names", () => {
		// Derived from expandTraits, never hard-coded: audit contributes
		// created_date / last_updated (NOT created_at / updated_at).
		expect(() =>
			seedAdd({
				moduleDir: dir,
				entity: "product",
				records: [
					{ product_id: 1, name: "x", created_date: "2026-01-01", last_updated: "2026-01-01" },
				],
			}),
		).not.toThrow();
	});

	it("rejects a plausible-but-wrong trait column name", () => {
		expect(() =>
			seedAdd({
				moduleDir: dir,
				entity: "product",
				records: [{ product_id: 1, name: "x", created_at: "2026-01-01" }],
			}),
		).toThrow(/not defined on 'product': created_at/);
	});

	it("accepts the columns of whichever traits the entity actually declares", () => {
		rmSync(dir, { recursive: true, force: true });
		dir = mkdtempSync(join(tmpdir(), "dforge-mcp-elements-"));
		makeModule({ traits: ["identity", "audit", "sorting", "soft-delete"] });
		expect(() =>
			seedAdd({
				moduleDir: dir,
				entity: "product",
				records: [{ product_id: 1, name: "x", order_num: 10, active: true }],
			}),
		).not.toThrow();
		// …but not columns from a trait it does NOT declare.
		expect(() =>
			seedAdd({
				moduleDir: dir,
				entity: "product",
				records: [{ product_id: 1, name: "x", period_key: "2026-01" }],
			}),
		).toThrow(/not defined on 'product': period_key/);
	});

	it("requires created_by / last_updated_by on an audit-full entity", () => {
		rmSync(dir, { recursive: true, force: true });
		dir = mkdtempSync(join(tmpdir(), "dforge-mcp-elements-"));
		makeModule({ traits: ["identity", "audit-full"] });
		expect(() =>
			seedAdd({ moduleDir: dir, entity: "product", records: [{ product_id: 1, name: "x" }] }),
		).toThrow(/audit-full/);
		// Setting both to the System user (0) is accepted.
		expect(() =>
			seedAdd({
				moduleDir: dir,
				entity: "product",
				records: [{ product_id: 1, name: "x", created_by: 0, last_updated_by: 0 }],
			}),
		).not.toThrow();
	});
});

describe("translation_sync", () => {
	it("generates every install-required key, including role labels", () => {
		apply(translationSync({ moduleDir: dir, prune: false }));
		const tx = readJson("translations/en-US.json");
		expect(tx.roles["shop.admin"].label).toBe("Shop Administrator");
		expect(tx.entities.product.label).toBe("Product");
		expect(tx.entities.product.fields.name.label).toBe("Name");
		// Trait-provided columns are user-visible and need labels too.
		expect(tx.entities.product.fields.created_date).toBeDefined();
		expect(tx.views.products.label).toBe("Products");
	});

	it("never overwrites existing translated text", () => {
		mkdirSync(join(dir, "translations"), { recursive: true });
		writeFileSync(
			join(dir, "translations", "de-DE.json"),
			JSON.stringify({ entities: { product: { label: "Produkt" } } }),
		);
		apply(translationSync({ moduleDir: dir, locales: ["de-DE"], prune: false }));
		const tx = readJson("translations/de-DE.json");
		expect(tx.entities.product.label).toBe("Produkt"); // preserved
		expect(tx.roles["shop.admin"].label).toBe("Shop Administrator"); // seeded
	});

	it("defaults to en-US plus every declared locale", () => {
		rmSync(dir, { recursive: true, force: true });
		dir = mkdtempSync(join(tmpdir(), "dforge-mcp-elements-"));
		makeModule({ supportedLocales: ["de-DE"] });
		const r = translationSync({ moduleDir: dir, prune: false });
		expect(Object.keys(r.files).sort()).toEqual([
			join("translations", "de-DE.json"),
			join("translations", "en-US.json"),
		]);
		expect(r.warning).toMatch(/still need real translation/);
	});

	it("fixes the validator's translation-completeness errors", () => {
		rmSync(dir, { recursive: true, force: true });
		dir = mkdtempSync(join(tmpdir(), "dforge-mcp-elements-"));
		makeModule({ supportedLocales: ["de-DE"] });
		expect(JSON.stringify(validate().errors)).toMatch(/de-DE\.json does not exist/);
		apply(translationSync({ moduleDir: dir, prune: false }));
		expect(validate().errors).toEqual([]);
	});

	it("fails fast on an entity file the manifest points at but that isn't there", () => {
		// Skipping it would produce a 'successful' but incomplete skeleton, and
		// the gap would only surface as a missing-label install failure.
		rmSync(join(dir, "entities", "product.json"));
		expect(() => translationSync({ moduleDir: dir, prune: false })).toThrow(
			/points at '\.\/entities\/product\.json', which does not exist/,
		);
	});

	it("fails fast on invalid entity JSON, naming the file", () => {
		writeFileSync(join(dir, "entities", "product.json"), "{ not json");
		expect(() => translationSync({ moduleDir: dir, prune: false })).toThrow(
			/entities\/product\.json is not valid JSON/,
		);
	});

	it("fails fast on an unknown trait rather than silently dropping its columns", () => {
		// expandTraits ignores an unrecognized code, so the trait's user-visible
		// columns would just be absent from the skeleton.
		rmSync(dir, { recursive: true, force: true });
		dir = mkdtempSync(join(tmpdir(), "dforge-mcp-elements-"));
		makeModule({ traits: ["identity", "not_a_real_trait"] });
		expect(() => translationSync({ moduleDir: dir, prune: false })).toThrow(
			/declares unknown trait\(s\): not_a_real_trait/,
		);
	});

	it("prunes stale keys only when asked", () => {
		mkdirSync(join(dir, "translations"), { recursive: true });
		writeFileSync(
			join(dir, "translations", "en-US.json"),
			JSON.stringify({ entities: { deleted_entity: { label: "Gone" } } }),
		);
		apply(translationSync({ moduleDir: dir, prune: false }));
		expect(readJson("translations/en-US.json").entities.deleted_entity).toBeDefined();

		apply(translationSync({ moduleDir: dir, prune: true }));
		expect(readJson("translations/en-US.json").entities.deleted_entity).toBeUndefined();
	});
});

describe("validator — actions, triggers and jobs", () => {
	const writeAction = (entry: Record<string, unknown>, dsl?: string) => {
		mkdirSync(join(dir, "ui"), { recursive: true });
		writeFileSync(join(dir, "ui", "actions.json"), JSON.stringify({ archive: entry }));
		if (dsl !== undefined) {
			mkdirSync(join(dir, "logic", "actions"), { recursive: true });
			writeFileSync(join(dir, "logic", "actions", `${entry.script}.dsl`), dsl);
		}
	};

	it("flags an action whose DSL file is missing", () => {
		writeAction({ label: "Archive", entityCode: "product", script: "archive", executionMode: "single" });
		expect(JSON.stringify(validate().errors)).toMatch(/no file at logic\/actions\/archive\.dsl/);
	});

	it("flags a script that isn't a bare filename", () => {
		writeAction({ label: "Archive", entityCode: "product", script: "actions/archive.dsl" });
		expect(JSON.stringify(validate().errors)).toMatch(/must be a BARE filename/);
	});

	it("flags a trigger firing an action that doesn't exist", () => {
		mkdirSync(join(dir, "logic"), { recursive: true });
		writeFileSync(
			join(dir, "logic", "triggers.json"),
			JSON.stringify({ triggers: [{ code: "t1", entity: "product", event: "insert", action: "ghost" }] }),
		);
		expect(JSON.stringify(validate().errors)).toMatch(/fires action 'ghost'/);
	});

	it("flags a job whose action uses record context", () => {
		writeAction(
			{ label: "Archive", entityCode: "product", script: "archive", executionMode: "single" },
			"execute:\n\t[name] = 'x'\n",
		);
		writeFileSync(
			join(dir, "logic", "jobs.json"),
			JSON.stringify({ jobs: [{ code: "nightly", action: "archive", schedule: "0 2 * * *", timeout: 60 }] }),
		);
		expect(JSON.stringify(validate().errors)).toMatch(/jobs run as the system user/);
	});

	it("runs the DSL checker over every action body", () => {
		writeAction(
			{ label: "Archive", entityCode: "product", script: "archive", executionMode: "single" },
			"execute:\n\t[archived_at] = TODAY()\n",
		);
		expect(JSON.stringify(validate().errors)).toMatch(/'TODAY' is not defined/);
	});

	it("accepts a well-formed action", () => {
		writeAction(
			{ label: "Archive", entityCode: "product", script: "archive", executionMode: "single" },
			"execute:\n\t[sku] = 'archived'\n\tinfo('done')\n",
		);
		expect(validate().errors).toEqual([]);
	});
});
