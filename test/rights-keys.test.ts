// Rights-key shapes accepted in security/roles.json. The `sp:` prefix is the one
// that matters here: report.run enforces Execute on the sec_object of every
// stored procedure a datasetType 'S' dataset binds, on top of the report's own
// right, so a role that cannot express `sp:<cd>` ships a report nobody can open
// (dForge-core issue #1146).

import { describe, expect, it } from "vitest";

import { assertValidRightKey, assertValidRightValue } from "../src/tools/_helpers";

const key = (k: string) => () => assertValidRightKey(k);

describe("assertValidRightKey", () => {
	it("accepts entity keys, bare and cross-module", () => {
		expect(key("product")).not.toThrow();
		expect(key("fin.invoice")).not.toThrow();
	});

	it("accepts colon-prefixed objects", () => {
		expect(key("action:approve")).not.toThrow();
		expect(key("report:summary")).not.toThrow();
		expect(key("sp:rpt_totals")).not.toThrow();
		expect(key("folder:east")).not.toThrow();
	});

	it("accepts a qualified report or sp — the two the installer resolves cross-module", () => {
		expect(key("report:fin.ar_aging")).not.toThrow();
		expect(key("sp:fin.rpt_ar_aging")).not.toThrow();
	});

	it("rejects a qualified action or folder, which resolve to nothing at install", () => {
		expect(key("action:fin.approve")).toThrow(/Invalid rights key/);
		expect(key("folder:fin.east")).toThrow(/Invalid rights key/);
	});

	it("rejects the dot form of every object prefix", () => {
		expect(key("sp.rpt_totals")).toThrow(/use a colon: 'sp:rpt_totals'/);
		expect(key("action.approve")).toThrow(/use a colon/);
	});
});

describe("assertValidRightValue", () => {
	it("takes 'E' on an sp key and nothing else", () => {
		expect(() => assertValidRightValue("sp:rpt_totals", "E", false)).not.toThrow();
		expect(() => assertValidRightValue("sp:rpt_totals", "SIUDC", false)).toThrow(/takes 'E'/);
	});
});
