// Three sister tools for patching fields inside an existing entity:
//   dforge_entity_field_add     — append a new field to entity.fields
//   dforge_entity_field_modify  — replace an existing field's spec
//   dforge_entity_field_remove  — delete a field
//
// All three load the entity JSON, mutate, and return the single-file map.
// They DON'T touch related artifacts (views, roles, menus) — those are
// regenerated separately when the AI follows a backtrack flow.

import { z } from "zod";
import * as path from "node:path";
import {
	loadManifest,
	readJson,
	jsonText,
	rel,
	makeResult,
	withTodayStamp,
	type ToolResult,
} from "./_helpers";

const fieldSchema = z
	.object({
		dbDatatype: z.string().optional(),
		fieldTypeCd: z.string().optional(),
		baseDatatypeCd: z.string().optional(),
		columnType: z.string().optional(),
		flags: z.string().optional(),
		isNullable: z.boolean().optional(),
		maxLen: z.number().int().optional(),
		orderNum: z.number().int().optional(),
		description: z.string().optional(),
		defaultValue: z.unknown().optional(),
		formula: z.string().optional(),
		link: z.record(z.string(), z.unknown()).optional(),
		params: z.record(z.string(), z.unknown()).optional(),
	})
	.passthrough()
	.describe(
		"Field spec. RULES (load dforge://reference/flags, /field-types, /column-types first):\n" +
			"• flags = a subset of V/E/M only. NEVER combine I or H with them. VEM = required+visible; VE = optional+visible; V = read-only/formula; EM = hidden FK. 'VEMHI' is INVALID.\n" +
			"• dbDatatype values: bool, varchar, text, number, timestamptz, date, time, cuid. NOT boolean/string/datetime/integer/timestamp.\n" +
			"• A relation is TWO fields: hidden FK (dbDatatype:'cuid', flags:'EM', NO fieldTypeCd) + a Reference (columnType:'R', fieldTypeCd:'lookup', flags:'VEM', link:{entity,thisKey,otherKey}). otherKey = the target entity's PK ('{entity}_id'), never 'id'.\n" +
			"• Formula column: columnType:'F', baseDatatypeCd set, NO dbDatatype, flags:'V'.\n" +
			"• dropdown/options params = [{value,label}] objects, never bare strings.",
	);

// ── add ─────────────────────────────────────────────────────────────

export const entityFieldAddSchema = {
	moduleDir: z.string().describe("Path to the module root."),
	entityName: z
		.string()
		.regex(/^[a-z][a-z0-9_]*$/)
		.describe("Entity code to add the field to."),
	fieldName: z
		.string()
		.regex(/^[a-z][a-z0-9_]*$/)
		.describe("New field's code."),
	field: fieldSchema,
};

export function entityFieldAdd(
	args: z.infer<z.ZodObject<typeof entityFieldAddSchema>>,
): ToolResult {
	const { paths, manifest } = loadManifest(args.moduleDir);
	const entityPath = path.join(paths.entitiesDir, `${args.entityName}.json`);
	const entity = readJson<Record<string, unknown>>(entityPath);
	const fields = (entity.fields as Record<string, unknown> | undefined) ?? {};
	if (Object.prototype.hasOwnProperty.call(fields, args.fieldName)) {
		throw new Error(
			`Field '${args.fieldName}' already exists on entity '${args.entityName}'. Use entity_field_modify to change it.`,
		);
	}
	entity.fields = { ...fields, [args.fieldName]: args.field };
	const files: Record<string, string> = {
		[rel(paths.root, entityPath)]: jsonText(entity),
		"manifest.json": jsonText(withTodayStamp(manifest)),
	};
	return makeResult(
		`Added field '${args.fieldName}' to entity '${args.entityName}'.`,
		files,
	);
}

// ── modify ──────────────────────────────────────────────────────────

export const entityFieldModifySchema = {
	moduleDir: z.string(),
	entityName: z.string().regex(/^[a-z][a-z0-9_]*$/),
	fieldName: z.string().regex(/^[a-z][a-z0-9_]*$/),
	field: fieldSchema.describe(
		"Replacement spec. Replaces the existing field entirely — pass the full desired shape, not a partial patch.",
	),
};

export function entityFieldModify(
	args: z.infer<z.ZodObject<typeof entityFieldModifySchema>>,
): ToolResult {
	const { paths, manifest } = loadManifest(args.moduleDir);
	const entityPath = path.join(paths.entitiesDir, `${args.entityName}.json`);
	const entity = readJson<Record<string, unknown>>(entityPath);
	const fields = (entity.fields as Record<string, unknown> | undefined) ?? {};
	if (!Object.prototype.hasOwnProperty.call(fields, args.fieldName)) {
		throw new Error(
			`Field '${args.fieldName}' not found on entity '${args.entityName}'.`,
		);
	}
	entity.fields = { ...fields, [args.fieldName]: args.field };
	return makeResult(
		`Modified field '${args.fieldName}' on entity '${args.entityName}'.`,
		{
			[rel(paths.root, entityPath)]: jsonText(entity),
			"manifest.json": jsonText(withTodayStamp(manifest)),
		},
	);
}

// ── remove ──────────────────────────────────────────────────────────

export const entityFieldRemoveSchema = {
	moduleDir: z.string(),
	entityName: z.string().regex(/^[a-z][a-z0-9_]*$/),
	fieldName: z.string().regex(/^[a-z][a-z0-9_]*$/),
};

export function entityFieldRemove(
	args: z.infer<z.ZodObject<typeof entityFieldRemoveSchema>>,
): ToolResult {
	const { paths, manifest } = loadManifest(args.moduleDir);
	const entityPath = path.join(paths.entitiesDir, `${args.entityName}.json`);
	const entity = readJson<Record<string, unknown>>(entityPath);
	const fields = (entity.fields as Record<string, unknown> | undefined) ?? {};
	if (!Object.prototype.hasOwnProperty.call(fields, args.fieldName)) {
		throw new Error(
			`Field '${args.fieldName}' not found on entity '${args.entityName}'.`,
		);
	}
	const { [args.fieldName]: _removed, ...rest } = fields;
	void _removed;
	entity.fields = rest;
	return makeResult(
		`Removed field '${args.fieldName}' from entity '${args.entityName}'. Note: dependent views / formulas referencing this field will break — review them.`,
		{
			[rel(paths.root, entityPath)]: jsonText(entity),
			"manifest.json": jsonText(withTodayStamp(manifest)),
		},
		"Removing fields can break dependent views, role rights, formulas, action DSL, and seed data. Run `dforge_module_inspect` after writing to spot broken references.",
	);
}
