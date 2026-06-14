// Regression coverage for the @dforge-core/metadata-backed validation and
// derivation added to the authoring tools: fieldTypeCd / columnType / trait
// codes are rejected when bogus, and dbDatatype is auto-derived from the field
// type. Schema-level checks parse the tool input schemas directly; the
// derivation checks drive the tool function against a throwaway module on disk.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { entityFieldAdd, entityFieldAddSchema } from "../src/tools/entity-field";
import { addEntityFiles } from "../src/tools/add-entity";
import { settingAddSchema } from "../src/tools/adds";
import { traitsInput } from "../src/tools/_helpers";

const parseField = (field: unknown) =>
	z.object(entityFieldAddSchema).safeParse({ moduleDir: "/m", entityName: "thing", fieldName: "f", field });

describe("field schema validation", () => {
	it("rejects an unknown fieldTypeCd and suggests the real code", () => {
		const r = parseField({ fieldTypeCd: "integer", flags: "VE" });
		expect(r.success).toBe(false);
		expect(JSON.stringify(r.error?.issues)).toContain("'number'");
	});

	it("rejects an unknown columnType", () => {
		const r = parseField({ fieldTypeCd: "text", columnType: "ref", flags: "VE" });
		expect(r.success).toBe(false);
		expect(JSON.stringify(r.error?.issues)).toContain("columnType");
	});

	it("rejects flags outside V/I/E/M/H", () => {
		expect(parseField({ fieldTypeCd: "text", flags: "VEP" }).success).toBe(false);
	});

	it("accepts a valid data field", () => {
		expect(parseField({ fieldTypeCd: "currency", flags: "VEM" }).success).toBe(true);
	});

	it("accepts a valid reference field", () => {
		const r = parseField({
			columnType: "R",
			fieldTypeCd: "lookup",
			flags: "VEM",
			link: { entity: "todo_list", thisKey: "list_id", otherKey: "todo_list_id" },
		});
		expect(r.success).toBe(true);
	});
});

describe("setting schema validation", () => {
	const parseSetting = (setting: unknown) =>
		z.object(settingAddSchema).safeParse({ moduleDir: "/m", code: "s", setting });

	it("rejects an unknown fieldTypeCd", () => {
		expect(parseSetting({ fieldTypeCd: "datePicker" }).success).toBe(false);
	});
	it("accepts a valid fieldTypeCd", () => {
		expect(parseSetting({ fieldTypeCd: "text", label: "S" }).success).toBe(true);
	});
});

describe("trait code validation", () => {
	it("defaults to identity+audit when omitted", () => {
		const r = traitsInput.safeParse(undefined);
		expect(r.success).toBe(true);
		expect(r.success && r.data).toEqual(["identity", "audit"]);
	});
	it("accepts the full platform trait set", () => {
		expect(traitsInput.safeParse(["identity", "soft-delete", "sorting"]).success).toBe(true);
	});
	it("rejects a typo'd trait", () => {
		const r = traitsInput.safeParse(["identity", "audt"]);
		expect(r.success).toBe(false);
		expect(JSON.stringify(r.success ? [] : r.error.issues)).toContain("audt");
	});
});

describe("dbDatatype derivation (entity_field_add)", () => {
	const dir = mkdtempSync(join(tmpdir(), "dforge-mcp-test-"));
	mkdirSync(join(dir, "entities"), { recursive: true });
	writeFileSync(
		join(dir, "manifest.json"),
		JSON.stringify({ code: "test", entities: { thing: "./entities/thing.json" } }),
	);
	writeFileSync(join(dir, "entities", "thing.json"), JSON.stringify({ description: "Thing", fields: {} }));

	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	const addField = (fieldName: string, field: Record<string, unknown>) => {
		const res = entityFieldAdd({ moduleDir: dir, entityName: "thing", fieldName, field } as never);
		const entity = JSON.parse(res.files["entities/thing.json"]);
		return entity.fields[fieldName] as Record<string, unknown>;
	};

	it("derives numeric(18,2) for a currency field", () => {
		expect(addField("price", { fieldTypeCd: "currency", flags: "VEM" }).dbDatatype).toBe("numeric(18,2)");
	});

	it("derives varchar for a text field", () => {
		expect(addField("note", { fieldTypeCd: "text", flags: "VE" }).dbDatatype).toBe("varchar");
	});

	it("leaves no dbDatatype on a reference (lookup) column", () => {
		const f = addField("owner", {
			columnType: "R",
			fieldTypeCd: "lookup",
			flags: "VEM",
			link: { entity: "user", thisKey: "owner_id", otherKey: "user_id" },
		});
		expect(f.dbDatatype).toBeUndefined();
	});

	it("does not override an explicit dbDatatype", () => {
		expect(addField("code", { fieldTypeCd: "text", dbDatatype: "varchar(50)", flags: "VE" }).dbDatatype).toBe("varchar(50)");
	});
});

describe("traits applied to a new entity (add_entity)", () => {
	const dir = mkdtempSync(join(tmpdir(), "dforge-mcp-traits-"));
	writeFileSync(
		join(dir, "manifest.json"),
		JSON.stringify({ code: "test", displayName: "Test", entities: {} }),
	);
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it("writes the full validated trait set into the entity JSON", () => {
		const res = addEntityFiles({
			moduleDir: dir,
			entity: { name: "invoice", label: "Invoice", traits: ["identity", "audit", "soft-delete"] },
		} as never);
		const entity = JSON.parse(res.files["entities/invoice.json"]);
		expect(entity.traits).toEqual(["identity", "audit", "soft-delete"]);
	});
});
