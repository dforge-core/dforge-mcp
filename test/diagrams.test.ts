// dforge_diagram_add: one diagram per docs/diagrams/<code>.json. It creates a
// diagram or extends one — appending only, so positions the user already set
// in the editor survive — and, unlike module_validate, it REJECTS an entity key
// that resolves to nothing, since the caller is authoring.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { diagramAdd, diagramAddSchema } from "../src/tools/adds";
import { applyToDisk } from "../src/tools/apply";
import { z } from "zod";

let dir: string;
const diagramPath = (code: string) => join(dir, "docs", "diagrams", `${code}.json`);
const readDiagram = (code: string) => JSON.parse(readFileSync(diagramPath(code), "utf8"));
const add = (args: Partial<z.input<z.ZodObject<typeof diagramAddSchema>>> & { code: string }) =>
	diagramAdd({ moduleDir: dir, entities: [], ...args });

function makeModule(): void {
	mkdirSync(join(dir, "entities"), { recursive: true });
	mkdirSync(join(dir, "ui"), { recursive: true });
	writeFileSync(
		join(dir, "manifest.json"),
		JSON.stringify({
			code: "ops",
			displayName: "Ops",
			dependencies: { parties: ">=0.1.0" },
			entities: {
				site: "./entities/site.json",
				asset: "./entities/asset.json",
				part: "./entities/part.json",
				invoice: "./entities/invoice.json",
			},
		}),
	);
	writeFileSync(
		join(dir, "ui", "folders.json"),
		JSON.stringify({
			label: "Ops",
			entities: { invoice: {} },
			children: {
				maintenance: {
					label: "Maintenance",
					entities: { site: {} },
					children: {
						assets: { label: "Assets", entities: { asset: {}, site: {} } },
						stores: { label: "Stores", children: { parts: { label: "Parts", entities: { part: {} } } } },
					},
				},
			},
		}),
	);
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "dforge-mcp-diagram-add-"));
	makeModule();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("diagram_add — create", () => {
	it("writes docs/diagrams/<code>.json with the entities unplaced", () => {
		const r = add({ code: "billing", entities: ["invoice", "parties.party"], description: "Invoicing" });
		expect(Object.keys(r.files)).toContain("docs/diagrams/billing.json");
		applyToDisk(dir, r);
		expect(readDiagram("billing")).toEqual({
			label: "billing",
			description: "Invoicing",
			entities: { invoice: {}, "parties.party": {} },
		});
	});

	it("writes showBoundary only when passed", () => {
		applyToDisk(dir, add({ code: "billing", entities: ["invoice"], showBoundary: false }));
		expect(readDiagram("billing").showBoundary).toBe(false);
	});
});

describe("diagram_add — merge into an existing diagram", () => {
	beforeEach(() => {
		mkdirSync(join(dir, "docs", "diagrams"), { recursive: true });
		writeFileSync(
			diagramPath("maint"),
			JSON.stringify({ label: "Maintenance", entities: { site: { x: 120, y: 40 }, asset: {} } }),
		);
	});

	it("appends missing keys and keeps placed ones untouched", () => {
		const r = add({ code: "maint", entities: ["asset", "part"] });
		expect(r.summary).toContain("added 1 entity, 1 already drawn");
		applyToDisk(dir, r);
		const d = readDiagram("maint");
		expect(d.entities).toEqual({ site: { x: 120, y: 40 }, asset: {}, part: {} });
		expect(Object.keys(d.entities)).toEqual(["site", "asset", "part"]);
		expect(d.label).toBe("Maintenance");
	});

	it("updates label/description only when passed, and never drops a key", () => {
		applyToDisk(dir, add({ code: "maint", label: "Upkeep" }));
		const d = readDiagram("maint");
		expect(d.label).toBe("Upkeep");
		expect(d.description).toBeUndefined();
		expect(Object.keys(d.entities)).toEqual(["site", "asset"]);
	});
});

describe("diagram_add — fromFolder", () => {
	it("takes the folder's entities and every descendant's, deduplicated", () => {
		applyToDisk(dir, add({ code: "maint", fromFolder: "maintenance" }));
		const d = readDiagram("maint");
		expect(Object.keys(d.entities)).toEqual(["site", "asset", "part"]);
		expect(d.label).toBe("Maintenance"); // the folder's label, not the code
	});

	it("finds a deeply nested folder", () => {
		applyToDisk(dir, add({ code: "stores", fromFolder: "stores", entities: ["invoice"] }));
		expect(Object.keys(readDiagram("stores").entities)).toEqual(["invoice", "part"]);
	});

	it("rejects an unknown folder code", () => {
		expect(() => add({ code: "x", fromFolder: "warehouse" })).toThrow(/Folder 'warehouse' is not in ui\/folders.json/);
	});
});

describe("diagram_add — rejects", () => {
	it("an entity key that resolves to nothing, writing nothing", () => {
		expect(() => add({ code: "billing", entities: ["invoice", "invoce", "crm.account"] })).toThrow(
			/'invoce' is not an entity in manifest.entities.*'crm.account' is not an entity of this module/,
		);
		expect(existsSync(diagramPath("billing"))).toBe(false);
	});

	it("a code that isn't snake_case", () => {
		expect(() => add({ code: "../evil", entities: ["invoice"] })).toThrow(/must be snake_case/);
		expect(() => add({ code: "Billing", entities: ["invoice"] })).toThrow(/must be snake_case/);
		expect(z.object(diagramAddSchema).safeParse({ moduleDir: dir, code: "bill-ing" }).success).toBe(false);
	});
});
