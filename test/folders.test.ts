// Folder codes are referenced FLAT and path-less everywhere outside the tree —
// role rights say `folder:<code>`, translations key on `folders.<code>.label` —
// so nesting does NOT namespace them. These tests pin the uniqueness rule at
// all three places that depend on it.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { folderAdd } from "../src/tools/adds";
import { translationSync } from "../src/tools/translations";
import { moduleValidate } from "../src/tools/module-validate";
import { walkFolders, duplicateFolderCodes } from "../src/tools/_helpers";
import { applyToDisk } from "../src/tools/apply";
import type { ToolResult } from "../src/tools/_helpers";

let dir: string;
const apply = (r: ToolResult) => applyToDisk(dir, r);

function makeModule(folders?: Record<string, unknown>): void {
	mkdirSync(join(dir, "entities"), { recursive: true });
	mkdirSync(join(dir, "ui"), { recursive: true });
	mkdirSync(join(dir, "security"), { recursive: true });
	writeFileSync(
		join(dir, "manifest.json"),
		JSON.stringify({ code: "ops", displayName: "Ops", entities: { site: "./entities/site.json" } }),
	);
	writeFileSync(
		join(dir, "entities", "site.json"),
		JSON.stringify({
			description: "Site",
			toString: "{name}",
			traits: ["identity"],
			fields: { name: { dbDatatype: "varchar", fieldTypeCd: "text", flags: "VEM", description: "Name" } },
		}),
	);
	writeFileSync(
		join(dir, "security", "roles.json"),
		JSON.stringify({ "ops.admin": { description: "Ops Admin", rights: { site: "SIUDC" } } }),
	);
	if (folders) writeFileSync(join(dir, "ui", "folders.json"), JSON.stringify(folders));
}

/** Root with `admin` under two different branches — the collision case. */
const COLLIDING_TREE = {
	label: "Ops",
	children: {
		north: { label: "North", children: { admin: { label: "North Admin" } } },
		south: { label: "South", children: { admin: { label: "South Admin" } } },
	},
};

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "dforge-mcp-folders-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("walkFolders / duplicateFolderCodes", () => {
	it("yields every sub-folder with its path, excluding the root", () => {
		const found = walkFolders(COLLIDING_TREE).map((f) => f.path).sort();
		expect(found).toEqual(["north", "north/admin", "south", "south/admin"]);
	});

	it("reports a code reused across branches, with every claiming path", () => {
		const dupes = duplicateFolderCodes(COLLIDING_TREE);
		expect([...dupes.keys()]).toEqual(["admin"]);
		expect(dupes.get("admin")).toEqual(["north/admin", "south/admin"]);
	});

	it("reports nothing for a well-formed tree", () => {
		expect(duplicateFolderCodes({ children: { north: {}, south: {} } }).size).toBe(0);
	});
});

describe("folder_add enforces tree-wide uniqueness", () => {
	it("refuses a code already used in a DIFFERENT branch", () => {
		makeModule({
			label: "Ops",
			children: {
				north: { label: "North", children: { admin: { label: "North Admin" } } },
				south: { label: "South" },
			},
		});
		expect(() =>
			folderAdd({
				moduleDir: dir,
				parentPath: "south",
				code: "admin", // free among south's siblings, taken at north/admin
				folder: { label: "South Admin" },
			}),
		).toThrow(/already used at 'north\/admin'/);
	});

	it("still allows a genuinely new code", () => {
		makeModule({ label: "Ops", children: { north: { label: "North" } } });
		const r = folderAdd({
			moduleDir: dir,
			parentPath: "north",
			code: "north_admin",
			folder: { label: "North Admin" },
		});
		apply(r);
		expect(JSON.parse(
			require("node:fs").readFileSync(join(dir, "ui", "folders.json"), "utf8"),
		).children.north.children.north_admin.label).toBe("North Admin");
	});
});

describe("module_validate flags colliding folder codes", () => {
	it("errors on a code reused across branches", () => {
		makeModule(COLLIDING_TREE);
		const res = JSON.parse(moduleValidate({ moduleDir: dir }).files["_validate.json"]);
		const msg = JSON.stringify(res.errors);
		expect(msg).toMatch(/folder code 'admin' is used 2 times/);
		expect(msg).toContain("north/admin");
		expect(msg).toContain("south/admin");
	});

	it("accepts a tree with unique codes", () => {
		makeModule({ label: "Ops", children: { north: { label: "North" }, south: { label: "South" } } });
		const res = JSON.parse(moduleValidate({ moduleDir: dir }).files["_validate.json"]);
		expect(JSON.stringify(res.errors)).not.toContain("folder code");
	});
});

describe("translation_sync and folder codes", () => {
	it("refuses to generate keys that would overwrite each other", () => {
		makeModule(COLLIDING_TREE);
		expect(() => translationSync({ moduleDir: dir, prune: false })).toThrow(
			/reuses folder code\(s\) across branches/,
		);
	});

	it("emits a flat key per folder, plus the root keyed on the module code", () => {
		makeModule({
			label: "Ops Root",
			children: { north: { label: "North" }, south: { label: "South" } },
		});
		apply(translationSync({ moduleDir: dir, prune: false }));
		const tx = JSON.parse(
			require("node:fs").readFileSync(join(dir, "translations", "en-US.json"), "utf8"),
		);
		// Flat codes — matching how role rights address a folder (`folder:north`).
		expect(tx.folders.ops.label).toBe("Ops Root");
		expect(tx.folders.north.label).toBe("North");
		expect(tx.folders.south.label).toBe("South");
	});
});
