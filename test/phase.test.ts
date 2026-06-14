// The Phase 0 scaffold gate reads a machine-readable marker (docs/phase.json)
// rather than grepping VALIDATION.md, with a legacy substring fallback.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { isReadyToScaffold, phaseStateJson } from "../src/tools/_helpers";

let dir = "";
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

const fixture = () => {
	dir = mkdtempSync(join(tmpdir(), "dforge-mcp-phase-"));
	mkdirSync(join(dir, "docs"), { recursive: true });
	return dir;
};

describe("isReadyToScaffold", () => {
	it("true when the marker says readyToScaffold: true", () => {
		const d = fixture();
		writeFileSync(join(d, "docs", "phase.json"), phaseStateJson({ phase: "0d", readyToScaffold: true }));
		expect(isReadyToScaffold(d)).toBe(true);
	});

	it("false when the marker says readyToScaffold: false", () => {
		const d = fixture();
		writeFileSync(join(d, "docs", "phase.json"), phaseStateJson({ phase: "0c", readyToScaffold: false }));
		// even if a stale VALIDATION.md substring is present, the marker wins
		writeFileSync(join(d, "docs", "VALIDATION.md"), "readyToScaffold: true");
		expect(isReadyToScaffold(d)).toBe(false);
	});

	it("falls back to the VALIDATION.md substring when no marker exists", () => {
		const d = fixture();
		writeFileSync(join(d, "docs", "VALIDATION.md"), "# Report\n\nreadyToScaffold: true\n");
		expect(isReadyToScaffold(d)).toBe(true);
	});

	it("false when neither marker nor a passing VALIDATION.md exists", () => {
		const d = fixture();
		writeFileSync(join(d, "docs", "VALIDATION.md"), "# Report\n\nstill working\n");
		expect(isReadyToScaffold(d)).toBe(false);
	});

	it("tolerates a malformed marker (falls through, doesn't throw)", () => {
		const d = fixture();
		writeFileSync(join(d, "docs", "phase.json"), "{ not json");
		expect(isReadyToScaffold(d)).toBe(false);
	});
});
