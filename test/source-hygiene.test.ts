// Guards against control characters sneaking into the source.
//
// A raw NUL is uniquely nasty here: it's invisible in an editor and a diff, it
// gets silently mangled by formatters, it makes any debug print of the value
// unreadable — and `grep` classifies a file containing one as BINARY and stops
// reporting matches in it at all, so the usual "search the codebase" check
// comes back clean while the problem is right there. Composite keys must use
// the named KEY_SEP instead.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { KEY_SEP, compositeKey } from "../src/tools/_helpers";

/** Every .ts file under a directory, recursively. */
function tsFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			out.push(...tsFiles(full));
		} else if (entry.endsWith(".ts")) {
			out.push(full);
		}
	}
	return out;
}

describe("source hygiene", () => {
	const files = [...tsFiles(join(process.cwd(), "src")), ...tsFiles(join(process.cwd(), "test"))];

	it("finds source files to check", () => {
		expect(files.length).toBeGreaterThan(20);
	});

	it("contains no raw NUL bytes", () => {
		const offenders: string[] = [];
		for (const f of files) {
			const buf = readFileSync(f);
			if (!buf.includes(0)) continue;
			// Report the line so a failure is immediately actionable.
			const lines = buf.toString("utf8").split("\n");
			lines.forEach((line, i) => {
				if (line.includes("\u0000")) {
					offenders.push(`${f}:${i + 1}  ${line.replace(/\u0000/g, "<NUL>").trim()}`);
				}
			});
		}
		expect(offenders, `raw NUL bytes found — use compositeKey()/KEY_SEP:\n${offenders.join("\n")}`).toEqual(
			[],
		);
	});

	it("contains no other invisible control characters anywhere in the source", () => {
		// Whole-line scan — code, comments and string literals alike. Nothing in
		// this codebase has a legitimate reason to carry a raw control character,
		// so there is no need to narrow the check to literals.
		// Excludes tab (\t, the indent style here), newline and carriage return.
		const bad = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;
		const offenders: string[] = [];
		for (const f of files) {
			readFileSync(f, "utf8")
				.split("\n")
				.forEach((line, i) => {
					if (bad.test(line)) offenders.push(`${f}:${i + 1}`);
				});
		}
		expect(offenders).toEqual([]);
	});
});

describe("compositeKey", () => {
	it("uses a visible, greppable separator", () => {
		expect(KEY_SEP).toBe("::");
		expect(KEY_SEP).not.toContain("\u0000");
	});

	it("joins parts unambiguously", () => {
		expect(compositeKey("orders_grid", "order")).toBe("orders_grid::order");
		expect(compositeKey("entities", "todo_item", "fields", "title", "label")).toBe(
			"entities::todo_item::fields::title::label",
		);
	});

	it("cannot collide for the identifiers it is used with", () => {
		// Codes are [a-z][a-z0-9_]* (cross-module adds a dot) and JSON object
		// keys — none can contain '::', so no two distinct part-lists collapse
		// to the same key.
		expect(compositeKey("a", "b_c")).not.toBe(compositeKey("a_b", "c"));
		expect(compositeKey("fin.invoice", "line")).toBe("fin.invoice::line");
	});
});
