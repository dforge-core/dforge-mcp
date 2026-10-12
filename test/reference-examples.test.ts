// The examples in a shipped reference must pass the same rules a module author's files do.
// A reference that teaches a shape the platform refuses is worse than no reference.

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	checkRegisterBinding,
	checkRegisters,
	type RegisterBindingTarget,
} from "@dforge-core/metadata";
import { checkDsl } from "../src/tools/dsl-check";

const REFERENCES = path.resolve(__dirname, "../skills/dforge-mcp-author/references");

interface Block {
	lang: string;
	body: string;
	/** The `###` heading above the block, which says what kind of column an excerpt is. */
	heading: string;
}

function blocksOf(file: string): Block[] {
	const text = fs.readFileSync(path.join(REFERENCES, file), "utf8");
	const out: Block[] = [];
	let heading = "";
	let open: { lang: string; lines: string[]; heading: string } | null = null;
	for (const line of text.split("\n")) {
		const fence = /^```(\w*)\s*$/.exec(line);
		if (fence && !open) {
			open = { lang: fence[1]!, lines: [], heading };
		} else if (fence && open) {
			out.push({ lang: open.lang, body: open.lines.join("\n"), heading: open.heading });
			open = null;
		} else if (open) {
			open.lines.push(line);
		} else if (/^#{2,4} /.test(line)) {
			heading = line;
		}
	}
	return out;
}

const strip = (s: string): string =>
	s.replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1");

/** A block is a whole object, or a `"key": {...}` excerpt of one. */
function parseJson(body: string): Record<string, unknown> | null {
	const text = strip(body).trim();
	for (const candidate of [text, `{${text}}`]) {
		try {
			const value: unknown = JSON.parse(candidate);
			if (value && typeof value === "object" && !Array.isArray(value)) {
				return value as Record<string, unknown>;
			}
		} catch {
			// try the next shape
		}
	}
	return null;
}

const isRegisters = (o: Record<string, unknown>): boolean => {
	const values = Object.values(o);
	return values.length > 0 && values.every((v) => !!v && typeof v === "object" && "kind" in v);
};

describe("registers.md examples", () => {
	const blocks = blocksOf("registers.md");
	const registers: Record<string, Record<string, unknown>> = {};
	let declarations = 0;
	let bindings = 0;
	let scripts = 0;

	for (const block of blocks.filter((b) => b.lang === "json")) {
		const parsed = parseJson(block.body);
		if (parsed && isRegisters(parsed)) Object.assign(registers, parsed);
	}

	it("declares registers that pass the install rules", () => {
		for (const block of blocks.filter((b) => b.lang === "json")) {
			const parsed = parseJson(block.body);
			if (!parsed || !isRegisters(parsed)) continue;
			declarations += Object.keys(parsed).length;
			const errors = checkRegisters(parsed as never).filter((i) => i.severity === "error");
			expect(errors, Object.keys(parsed).join(",")).toEqual([]);
		}
		expect(declarations).toBeGreaterThanOrEqual(5);
	});

	it("binds columns that pass the binding rules", () => {
		for (const block of blocks.filter((b) => b.lang === "json")) {
			const parsed = parseJson(block.body);
			if (!parsed || isRegisters(parsed)) continue;
			const field = (
				"params" in parsed ? parsed : Object.values(parsed)[0]
			) as { columnType?: string; params?: Record<string, unknown> };
			const params = field?.params;
			const qualified = typeof params?.register === "string" ? params.register : null;
			if (!params || !qualified) continue;

			// An excerpt without a columnType takes it from the heading above it.
			const columnType =
				field.columnType ?? (/`L`/.test(block.heading) ? "L" : /`A`/.test(block.heading) ? "A" : "");
			expect(["A", "L"], `column type of ${qualified}`).toContain(columnType);

			const target = registers[qualified.slice(qualified.indexOf(".") + 1)];
			expect(target, `${qualified} is declared in this document`).toBeDefined();
			bindings++;
			const errors = checkRegisterBinding(
				columnType as "A" | "L",
				params,
				target as unknown as RegisterBindingTarget,
				{ moduleCode: qualified.slice(0, qualified.indexOf(".")) },
			).filter((i) => i.severity === "error");
			expect(errors, qualified).toEqual([]);
		}
		expect(bindings).toBeGreaterThanOrEqual(2);
	});

	it("uses only known functions in its DSL", () => {
		for (const block of blocks.filter((b) => b.lang === "" && /^execute:/m.test(b.body))) {
			scripts++;
			expect(checkDsl(block.body)).toEqual([]);
		}
		expect(scripts).toBeGreaterThanOrEqual(1);
	});
});
