// A module may ship its own traits.json. The installer overlays those on the
// platform traits (`TraitExpanderFactory.ForPackage`), so every tool that
// derives columns from traits has to do the same — otherwise the entity reads
// as missing the columns install will give it, the trait code reads as a typo,
// and everything downstream reports symptoms of a module that is actually fine.
//
// Three tools expand traits (validate, seed, translations); all three are
// covered here, because the overlay was once wired into only one of them.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { seedAdd } from "../src/tools/seed";
import { translationSync } from "../src/tools/translations";
import { moduleValidate } from "../src/tools/module-validate";
import { actionAdd } from "../src/tools/action-add";
import { actionCheck } from "../src/tools/action-check";

let dir: string;
const validate = () => JSON.parse(moduleValidate({ moduleDir: dir }).files["_validate.json"]);

/** `priced` is not a platform trait — this module declares it itself. */
const LOCAL_TRAITS = {
	priced: {
		description: "Money columns",
		fields: {
			price: { dbDatatype: "numeric", fieldTypeCd: "decimal", flags: "VEM", description: "Price" },
			currency: { dbDatatype: "varchar", fieldTypeCd: "text", flags: "VE", description: "Currency" },
		},
	},
};

function makeModule(traitsJson: string | null = JSON.stringify(LOCAL_TRAITS)): void {
	mkdirSync(join(dir, "entities"), { recursive: true });
	mkdirSync(join(dir, "ui"), { recursive: true });
	mkdirSync(join(dir, "security"), { recursive: true });
	writeFileSync(
		join(dir, "manifest.json"),
		JSON.stringify({ code: "shop", displayName: "Shop", entities: { product: "./entities/product.json" } }),
	);
	if (traitsJson !== null) writeFileSync(join(dir, "traits.json"), traitsJson);
	writeFileSync(
		join(dir, "entities", "product.json"),
		JSON.stringify({
			description: "Product",
			toString: "{name}",
			traits: ["identity", "audit", "priced"],
			fields: {
				name: { dbDatatype: "varchar", fieldTypeCd: "text", flags: "VEM", description: "Name" },
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
	dir = mkdtempSync(join(tmpdir(), "dforge-mcp-traits-"));
	makeModule();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Register `markup`, whose body reads a column only the local trait provides. */
function withMarkupAction(): void {
	mkdirSync(join(dir, "logic", "actions"), { recursive: true });
	writeFileSync(
		join(dir, "ui", "actions.json"),
		JSON.stringify({
			markup: { label: "Markup", entityCode: "product", script: "markup", executionMode: "single" },
		}),
	);
	writeFileSync(join(dir, "logic", "actions", "markup.dsl"), "execute:\n\t[price] = [price] * 2\n");
}

const checkMarkup = () =>
	JSON.parse(
		actionCheck({ moduleDir: dir, actionCode: "markup" }).files["_action_check.json"],
	);

describe("a module's own traits.json is overlaid on the platform traits", () => {
	it("module_validate accepts the trait code and its columns", () => {
		expect(validate().errors, JSON.stringify(validate().errors)).toEqual([]);
	});

	it("module_validate reads a local trait's column as a real column", () => {
		// The DSL checker gets the entity's columns from the same expansion, so
		// a trait that went missing would surface here as "not a column".
		withMarkupAction();
		expect(validate().errors, JSON.stringify(validate().errors)).toEqual([]);
	});

	it("action_add accepts a body that reads a local trait's column", () => {
		expect(() =>
			actionAdd({
				moduleDir: dir,
				code: "markup",
				entityCode: "product",
				label: "Markup",
				executionMode: "single",
				isAsync: false,
				dslBody: "execute:\n\t[price] = [price] * 2\n",
			}),
		).not.toThrow();
	});

	it("seed_add accepts records that set a local trait's columns", () => {
		const r = seedAdd({
			moduleDir: dir,
			entity: "product",
			records: [{ product_id: 1, name: "Widget", price: 9.5, currency: "EUR" }],
		});
		const seedFile = Object.keys(r.files).find((f) => f.includes("product"));
		expect(seedFile, JSON.stringify(Object.keys(r.files))).toBeDefined();
		expect(JSON.parse(r.files[seedFile as string]).records[0].price).toBe(9.5);
	});

	it("translation_sync labels a local trait's columns", () => {
		const r = translationSync({ moduleDir: dir, prune: false });
		const tx = JSON.parse(r.files[join("translations", "en-US.json")]);
		expect(tx.entities.product.fields.price.label).toBe("Price");
		expect(tx.entities.product.fields.currency.label).toBe("Currency");
	});
});

// A trait's columns are as real at install as authored ones, so every seed rule
// has to read the MERGED set. Checking `fields` alone waves through the exact
// record install rejects — and the tool's own known-column check already counts
// the trait column, so the author gets a green light twice over.
describe("seed_add checks trait-contributed columns, not just authored ones", () => {
	/** `owned` adds a virtual R column and the required FK behind it. */
	const OWNED = {
		owned: {
			description: "Ownership",
			fields: {
				owner_id: { dbDatatype: "cuid", fieldTypeCd: "integer", flags: "EM", description: "Owner id" },
				owner: {
					columnType: "R",
					fieldTypeCd: "lookup",
					flags: "VE",
					description: "Owner",
					link: { entity: "user", thisKey: "owner_id", otherKey: "user_id" },
				},
			},
		},
	};

	beforeEach(() => {
		rmSync(dir, { recursive: true, force: true });
		dir = mkdtempSync(join(tmpdir(), "dforge-mcp-traits-"));
		mkdirSync(join(dir, "entities"), { recursive: true });
		writeFileSync(
			join(dir, "manifest.json"),
			JSON.stringify({ code: "shop", displayName: "Shop", entities: { product: "./entities/product.json" } }),
		);
		writeFileSync(join(dir, "traits.json"), JSON.stringify(OWNED));
		writeFileSync(
			join(dir, "entities", "product.json"),
			JSON.stringify({
				description: "Product",
				toString: "{name}",
				traits: ["identity", "owned"],
				fields: { name: { dbDatatype: "varchar", fieldTypeCd: "text", flags: "VEM", description: "Name" } },
			}),
		);
	});

	const seed = (record: Record<string, unknown>) =>
		seedAdd({ moduleDir: dir, entity: "product", records: [record] });

	it("rejects a value set on a trait's Reference column", () => {
		// The installer strips it — the record silently loses its owner.
		expect(() => seed({ product_id: 1, name: "Widget", owner: 123 })).toThrow(/owner_id/);
	});

	it("warns when a trait's required column is unset", () => {
		const r = seed({ product_id: 1, name: "Widget" });
		expect(r.warning ?? "").toMatch(/owner_id/);
	});

	it("stays quiet once the hidden FK is set instead", () => {
		const r = seed({ product_id: 1, name: "Widget", owner_id: 123 });
		expect(r.warning ?? "").not.toMatch(/owner_id/);
	});

	it("rejects a value set on a PLATFORM trait's Reference column", () => {
		writeFileSync(
			join(dir, "entities", "product.json"),
			JSON.stringify({
				description: "Product",
				toString: "{name}",
				traits: ["identity", "audit-full"],
				fields: { name: { dbDatatype: "varchar", fieldTypeCd: "text", flags: "VEM", description: "Name" } },
			}),
		);
		expect(() =>
			seed({ product_id: 1, name: "Widget", created_by: 0, last_updated_by: 0, created_by_user: 0 }),
		).toThrow(/created_by/);
	});

	it("does not invent a requirement from a platform trait", () => {
		// No platform trait marks a column M, so nothing here should warn.
		writeFileSync(
			join(dir, "entities", "product.json"),
			JSON.stringify({
				description: "Product",
				toString: "{name}",
				traits: ["identity", "audit", "sorting", "soft-delete"],
				fields: { name: { dbDatatype: "varchar", fieldTypeCd: "text", flags: "VEM", description: "Name" } },
			}),
		);
		expect(seed({ product_id: 1, name: "Widget" }).warning).toBeUndefined();
	});
});

describe("a traits.json that does not parse", () => {
	beforeEach(() => {
		rmSync(dir, { recursive: true, force: true });
		dir = mkdtempSync(join(tmpdir(), "dforge-mcp-traits-"));
		makeModule("{ not json");
	});

	// Nothing else checks this file offline — its schema is validated only once
	// the package reaches the CLI — so a swallowed parse error would surface as
	// "unknown trait" plus a wall of "not a column", none of them the cause.
	it("module_validate names the syntax error", () => {
		const errs = JSON.stringify(validate().errors);
		expect(errs).toMatch(/traits\.json/);
		expect(errs).toMatch(/invalid JSON/);
	});

	it("module_validate withholds the column rules rather than reporting fragments", () => {
		// The entity's trait columns are missing, so a `[price]` read would be
		// reported as an unknown column — a symptom of the broken file, not a
		// defect in the script.
		withMarkupAction();
		expect(JSON.stringify(validate().errors)).not.toMatch(/unknown-column|not a column on/);
	});

	it("seed_add and translation_sync fail fast, naming the file", () => {
		expect(() =>
			seedAdd({ moduleDir: dir, entity: "product", records: [{ product_id: 1, name: "x" }] }),
		).toThrow(/traits\.json — invalid JSON/);
		expect(() => translationSync({ moduleDir: dir, prune: false })).toThrow(
			/traits\.json — invalid JSON/,
		);
	});

	// action_check is supposed to answer the same question module_validate
	// answers about the same body. Swallowing the read error made it answer
	// "no issues" while validate reported two — and it is the cheap call an
	// author makes first, so that disagreement is the one that gets believed.
	it("action_check reports it rather than passing the action", () => {
		withMarkupAction();
		const r = checkMarkup();
		expect(r.ok).toBe(false);
		expect(JSON.stringify(r.errors)).toMatch(/traits\.json — invalid JSON/);
	});

	it("action_add refuses to write a body it could not fully check", () => {
		expect(() =>
			actionAdd({
				moduleDir: dir,
				code: "markup",
				entityCode: "product",
				label: "Markup",
				executionMode: "single",
				isAsync: false,
				dslBody: "execute:\n\t[price] = [price] * 2\n",
			}),
		).toThrow(/traits\.json — invalid JSON/);
	});
});

// A traits file of the WRONG SHAPE parses, so syntax checking alone waves it
// through — and it is the likelier mistake: every other file in the module is
// keyed by a wrapper, so wrapping this one is the natural thing to do.
describe("a traits.json wrapped in a top-level \"traits\" key", () => {
	beforeEach(() => {
		rmSync(dir, { recursive: true, force: true });
		dir = mkdtempSync(join(tmpdir(), "dforge-mcp-traits-"));
		makeModule(JSON.stringify({ traits: LOCAL_TRAITS }));
	});

	it("module_validate names the wrapper instead of blaming the trait code", () => {
		const errs = JSON.stringify(validate().errors);
		expect(errs).toMatch(/traits\.json/);
		expect(errs).toMatch(/wrapper/);
	});

	// The old failure mode: 'traits' was accepted as a trait code, so the error
	// listing the valid codes ended "...plus this module's own traits.json:
	// traits" — advertising the mistake as the answer.
	it("never advertises the wrapper key as a valid trait code", () => {
		expect(() =>
			seedAdd({ moduleDir: dir, entity: "product", records: [{ product_id: 1, name: "x" }] }),
		).toThrow(/traits\.json — not a traits file/);
		expect(() =>
			seedAdd({ moduleDir: dir, entity: "product", records: [{ product_id: 1, name: "x" }] }),
		).not.toThrow(/own traits\.json: traits/);
	});

	it("action_check and action_add report it too", () => {
		withMarkupAction();
		expect(checkMarkup().ok).toBe(false);
		expect(() =>
			actionAdd({
				moduleDir: dir,
				code: "markup",
				entityCode: "product",
				label: "Markup",
				executionMode: "single",
				isAsync: false,
				dslBody: "execute:\n\t[price] = [price] * 2\n",
			}),
		).toThrow(/not a traits file/);
	});
});

// `TraitExpander.TryAddField` keeps the FIRST definition of a field and refuses
// the entity when a later one differs in type identity, so install fails with
// "Field 'x' conflicts with trait". Expansion here is total and would merge the
// collision away silently — validate has to ask for it.
describe("a trait field the entity already defines under another type", () => {
	/** Redefine `price` as text, against the local trait's numeric. */
	function withClashingField(): void {
		writeFileSync(
			join(dir, "entities", "product.json"),
			JSON.stringify({
				description: "Product",
				toString: "{name}",
				traits: ["identity", "audit", "priced"],
				fields: {
					name: { dbDatatype: "varchar", fieldTypeCd: "text", flags: "VEM", description: "Name" },
					price: { dbDatatype: "varchar", fieldTypeCd: "text", flags: "VE", description: "Price" },
				},
			}),
		);
	}

	it("is an error, naming the field and both types", () => {
		withClashingField();
		const found = JSON.stringify(validate().errors);
		expect(found).toMatch(/'price' is contributed by a trait/);
		expect(found).toMatch(/numeric/);
		expect(found).toMatch(/varchar/);
		expect(found).toMatch(/entities\/product\.json/);
	});

	it("says nothing when the entity's own field agrees with the trait's", () => {
		writeFileSync(
			join(dir, "entities", "product.json"),
			JSON.stringify({
				description: "Product",
				toString: "{name}",
				traits: ["identity", "audit", "priced"],
				fields: {
					name: { dbDatatype: "varchar", fieldTypeCd: "text", flags: "VEM", description: "Name" },
					price: { dbDatatype: "numeric", fieldTypeCd: "decimal", flags: "VE", description: "Price" },
				},
			}),
		);
		expect(JSON.stringify(validate().errors)).not.toMatch(/contributed by a trait/);
	});

	it("leaves an unclashing module alone", () => {
		expect(JSON.stringify(validate().errors)).not.toMatch(/contributed by a trait/);
	});
});
