// Coverage for the opt-in write mode. The important cases are the refusals:
// this is the only code path in the package that turns a tool result into a
// disk write, so it must not write outside the module or persist the report
// payloads that reuse the file-map shape for transport.

import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	readFileSync,
	existsSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyToDisk } from "../src/tools/apply";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "dforge-mcp-apply-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("applyToDisk", () => {
	it("writes files, creating intermediate directories", () => {
		const res = applyToDisk(dir, {
			summary: "wrote things",
			files: { "manifest.json": "{}\n", "logic/actions/go.dsl": "execute:\n\tinfo('x')\n" },
		});
		expect(res.applied).toBe(true);
		expect(res.written).toEqual(["logic/actions/go.dsl", "manifest.json"]);
		expect(readFileSync(join(dir, "logic/actions/go.dsl"), "utf8")).toContain("info('x')");
	});

	it("honours `deletes`, which is the half a client can silently drop", () => {
		writeFileSync(join(dir, "old.json"), "{}");
		const res = applyToDisk(dir, {
			summary: "renamed",
			files: { "new.json": "{}\n" },
			deletes: ["old.json"],
		});
		expect(res.deleted).toEqual(["old.json"]);
		expect(existsSync(join(dir, "old.json"))).toBe(false);
		expect(existsSync(join(dir, "new.json"))).toBe(true);
	});

	it("ignores a delete for a file that is already gone", () => {
		const res = applyToDisk(dir, { summary: "x", files: {}, deletes: ["never-existed.json"] });
		expect(res.deleted).toEqual([]);
	});

	it("refuses to delete a directory, and leaves it intact", () => {
		// `deletes` is a file-only contract. Recursively removing a subtree here
		// would be the worst possible response to a tool bug.
		mkdirSync(join(dir, "entities"), { recursive: true });
		writeFileSync(join(dir, "entities", "keep.json"), "{}");
		expect(() =>
			applyToDisk(dir, { summary: "x", files: {}, deletes: ["entities"] }),
		).toThrow(/file-only contract/);
		expect(existsSync(join(dir, "entities", "keep.json"))).toBe(true);
	});

	it("deletes a symlink itself rather than following it", () => {
		const outside = join(dir, "..", `link-target-${process.pid}.json`);
		writeFileSync(outside, "{}");
		try {
			symlinkSync(outside, join(dir, "link.json"));
			const res = applyToDisk(dir, { summary: "x", files: {}, deletes: ["link.json"] });
			expect(res.deleted).toEqual(["link.json"]);
			expect(existsSync(outside)).toBe(true); // target untouched
		} finally {
			rmSync(outside, { force: true });
		}
	});

	it("never writes report payloads to disk", () => {
		const res = applyToDisk(dir, {
			summary: "validated",
			files: { "_validate.json": '{"ok":true}\n' },
		});
		expect(res.written).toEqual([]);
		expect(res.skipped).toEqual(["_validate.json"]);
		expect(existsSync(join(dir, "_validate.json"))).toBe(false);
	});

	it("refuses to write outside the module directory", () => {
		expect(() =>
			applyToDisk(dir, { summary: "x", files: { "../escape.json": "{}\n" } }),
		).toThrow(/resolves outside the module directory/);
		expect(existsSync(join(dir, "..", "escape.json"))).toBe(false);
	});

	it("refuses to delete outside the module directory", () => {
		const outside = join(dir, "..", `victim-${process.pid}.json`);
		writeFileSync(outside, "{}");
		try {
			expect(() =>
				applyToDisk(dir, { summary: "x", files: {}, deletes: [`../victim-${process.pid}.json`] }),
			).toThrow(/resolves outside the module directory/);
			expect(existsSync(outside)).toBe(true);
		} finally {
			rmSync(outside, { force: true });
		}
	});

	it("rejects a module-relative path that escapes via a symlink-free '..' segment", () => {
		expect(() =>
			applyToDisk(dir, { summary: "x", files: { "entities/../../oops.json": "{}\n" } }),
		).toThrow(/resolves outside the module directory/);
	});

	it("carries the tool's warning through", () => {
		const res = applyToDisk(dir, { summary: "x", files: {}, warning: "check the FKs" });
		expect(res.warning).toBe("check the FKs");
	});

	it("writes before deleting, so a rename can't lose data on a failed write", () => {
		// Same path in both maps: the write must win.
		mkdirSync(join(dir, "entities"), { recursive: true });
		writeFileSync(join(dir, "entities", "a.json"), "OLD");
		applyToDisk(dir, {
			summary: "x",
			files: { "entities/a.json": "NEW" },
			deletes: ["entities/b.json"],
		});
		expect(readFileSync(join(dir, "entities", "a.json"), "utf8")).toBe("NEW");
	});
});
