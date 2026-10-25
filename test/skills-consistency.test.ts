// The skills point agents at tools and dforge:// resources by name. A name that no longer
// exists, or a reference file nothing can load, silently breaks authoring guidance.

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { resources } from "../src/resources/index";

const ROOT = path.resolve(__dirname, "..");
const SKILLS = path.join(ROOT, "skills");

function markdownFiles(dir: string): string[] {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) return markdownFiles(p);
		return e.name.endsWith(".md") ? [p] : [];
	});
}

const skillText = markdownFiles(SKILLS).map((f) => ({ file: path.relative(ROOT, f), text: fs.readFileSync(f, "utf8") }));
const registeredUris = new Set(resources.map((r) => r.uri));
const serverSource = fs.readFileSync(path.join(ROOT, "src/server.ts"), "utf8");

describe("skills consistency", () => {
	it("every dforge:// URI a skill names is a registered resource (or a prefix of one)", () => {
		const missing: string[] = [];
		for (const { file, text } of skillText) {
			for (const m of text.matchAll(/dforge:\/\/[a-zA-Z0-9_\-./]+/g)) {
				const uri = m[0].replace(/[.,]+$/, "");
				const known = [...registeredUris].some((u) => u === uri || u.startsWith(uri.endsWith("/") ? uri : uri + "/"));
				if (!known) missing.push(`${file}: ${uri}`);
			}
		}
		expect(missing).toEqual([]);
	});

	it("every dforge_* tool a skill names is registered by the server", () => {
		const missing: string[] = [];
		for (const { file, text } of skillText) {
			for (const m of text.matchAll(/\bdforge_[a-z][a-z_]*[a-z]\b/g)) {
				if (!serverSource.includes(`"${m[0]}"`)) missing.push(`${file}: ${m[0]}`);
			}
		}
		expect(missing).toEqual([]);
	});

	it("every reference file is served as dforge://reference/<name>", () => {
		const dir = path.join(SKILLS, "dforge-mcp-author/references");
		const orphans = fs
			.readdirSync(dir)
			.filter((f) => f.endsWith(".md"))
			.map((f) => f.slice(0, -3))
			.filter((n) => !registeredUris.has(`dforge://reference/${n}`));
		expect(orphans).toEqual([]);
	});
});
