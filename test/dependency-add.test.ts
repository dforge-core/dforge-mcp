// dforge_dependency_add writes BOTH halves the platform requires: the manifest
// entry and the deps/<module>.json contract. Writing only the manifest (what it
// used to do) left an unpackable module — dForge-core issue #1090.

import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { dependencyAdd } from "../src/tools/adds";
import { applyToDisk } from "../src/tools/apply";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "dforge-deps-"));
	writeFileSync(
		join(dir, "manifest.json"),
		JSON.stringify({ code: "shop", displayName: "Shop", entities: {} }),
	);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const readJson = (rel: string) => JSON.parse(readFileSync(join(dir, rel), "utf8"));

describe("dependencyAdd", () => {
	it("writes the manifest entry and a matching contract", () => {
		const res = dependencyAdd({
			moduleDir: dir,
			moduleCode: "fin",
			version: ">=0.1.0",
			entities: ["invoice"],
			use: ["ref:order.invoice"],
		});
		applyToDisk(dir, res);

		expect(readJson("manifest.json").dependencies.fin).toEqual({
			version: ">=0.1.0",
			entities: ["invoice"],
		});
		expect(readJson("deps/fin.json")).toEqual({
			module: "fin",
			version: ">=0.1.0",
			entities: { invoice: { pk: "invoice_id", use: ["ref:order.invoice"] } },
		});
	});

	it("mirrors the manifest range into the contract verbatim", () => {
		// The validator compares the two ranges — a drift here is a hard error.
		const res = dependencyAdd({
			moduleDir: dir,
			moduleCode: "fin",
			version: ">=0.1.0 <0.2.0",
			entities: ["invoice"],
		});
		expect(JSON.parse(res.files["deps/fin.json"]).version).toBe(">=0.1.0 <0.2.0");
	});

	it("honours pk overrides and flags guessed ones", () => {
		const res = dependencyAdd({
			moduleDir: dir,
			moduleCode: "parties",
			version: ">=0.1.0",
			entities: ["party"],
			use: ["ref:order.customer"],
			pks: { party: "party_uid" },
		});
		expect(JSON.parse(res.files["deps/parties.json"]).entities.party.pk).toBe("party_uid");
		expect(res.warning).not.toContain("guessed");
	});

	it("warns when provenance is a placeholder", () => {
		const res = dependencyAdd({
			moduleDir: dir,
			moduleCode: "fin",
			version: ">=0.1.0",
			entities: ["invoice"],
		});
		expect(res.warning).toContain("placeholder provenance token");
		expect(res.warning).toContain("guessed");
	});

	it("warns that a system module dependency is only a version gate", () => {
		const res = dependencyAdd({
			moduleDir: dir,
			moduleCode: "metadata",
			version: ">=1.5.0",
			entities: ["report"],
			use: ["report:credit_check"],
		});
		expect(res.warning).toContain("system module");
	});

	it("refuses to overwrite a stale contract", () => {
		mkdirSync(join(dir, "deps"), { recursive: true });
		writeFileSync(join(dir, "deps", "fin.json"), "{}");
		expect(() =>
			dependencyAdd({ moduleDir: dir, moduleCode: "fin", version: ">=0.1.0", entities: ["invoice"] }),
		).toThrow(/already exists/);
	});

	it("still rejects self-dependency and duplicates", () => {
		expect(() =>
			dependencyAdd({ moduleDir: dir, moduleCode: "shop", version: ">=0.1.0", entities: ["x"] }),
		).toThrow(/depend on itself/);

		applyToDisk(
			dir,
			dependencyAdd({ moduleDir: dir, moduleCode: "fin", version: ">=0.1.0", entities: ["invoice"] }),
		);
		expect(existsSync(join(dir, "deps", "fin.json"))).toBe(true);
		expect(() =>
			dependencyAdd({ moduleDir: dir, moduleCode: "fin", version: ">=0.2.0", entities: ["invoice"] }),
		).toThrow(/already exists/);
	});
});
