// DSL message translations (#1299): translation_sync seeds `messages`, the validator
// reports what the install would, and the DSL checks see the module's translations.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { translationSync } from "../src/tools/translations";
import { moduleValidate } from "../src/tools/module-validate";
import { checkActionDsl } from "../src/tools/validate/logic";
import { loadContext } from "../src/tools/validate/context";

let dir: string;

function write(rel: string, content: unknown): void {
	const abs = join(dir, rel);
	mkdirSync(join(abs, ".."), { recursive: true });
	writeFileSync(abs, typeof content === "string" ? content : JSON.stringify(content, null, "\t"));
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "dforge-msg-"));
	write("manifest.json", {
		code: "shop",
		moduleId: "00000000-0000-0000-0000-00000000c0de",
		version: "0.1.0",
		dbSchemaVersion: "0.1.0",
		packageFormat: 1,
		supportedLocales: ["de-DE"],
		entities: {},
	});
	write("ui/actions.json", { ship: { label: "Ship", entityCode: "order", executionMode: "single" } });
	write(
		"logic/actions/ship.dsl",
		"execute:\n\tinfo('Shipped')\n\terror('Only {n} left', { n: 3 })\n\twarn('Order ' + [order_no])\n",
	);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const validateIssues = () => {
	const r = moduleValidate({ moduleDir: dir } as never);
	const report = JSON.parse(r.files["_validate.json"]!) as { warnings: { where: string; message: string }[] };
	return report.warnings;
};

describe("translation_sync — messages", () => {
	it("seeds the scripts' fixed texts into non-English files only", () => {
		write("translations/de-DE.json", { messages: { Shipped: "Versandt" } });
		const r = translationSync({ moduleDir: dir, prune: false } as never);
		const de = JSON.parse(r.files["translations/de-DE.json"]!);
		const en = JSON.parse(r.files["translations/en-US.json"]!);
		expect(de.messages).toEqual({ Shipped: "Versandt", "Only {n} left": "Only {n} left" });
		expect(en.messages).toBeUndefined();
	});
});

describe("module_validate — messages", () => {
	it("reports untranslated and joined messages per script, and entries nothing uses", () => {
		write("translations/de-DE.json", { messages: { Gone: "Weg", "Only {n} left": "Nur {m} übrig" } });
		const text = validateIssues().map((w) => `${w.where} ${w.message}`).join("\n");
		expect(text).toContain("joins text and values");
		expect(text).toMatch(/No de-DE translation/);
		expect(text).toContain('messages entry "Gone" matches no');
		expect(text).toContain("uses {m}");
	});

	it("keeps the per-script rules quiet for a module with no locales", () => {
		write("manifest.json", {
			code: "shop",
			moduleId: "00000000-0000-0000-0000-00000000c0de",
			version: "0.1.0",
			dbSchemaVersion: "0.1.0",
			packageFormat: 1,
			entities: {},
		});
		const ctx = loadContext(dir);
		checkActionDsl(ctx);
		expect(ctx.issues.filter((i) => /translat|joins text/.test(i.message))).toEqual([]);
	});
});
