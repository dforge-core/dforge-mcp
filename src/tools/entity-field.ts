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
import { deriveDbDatatype } from "@dforge-core/metadata";
import {
	loadManifest,
	readJson,
	jsonText,
	rel,
	makeResult,
	withTodayStamp,
	type ToolResult,
} from "./_helpers";
import { checkFieldSpec } from "./field-rules";

/**
 * Auto-fill `dbDatatype` from `fieldTypeCd` when the author omitted it, using
 * the canonical derivation in @dforge-core/metadata. Never overrides an
 * author-provided value, and skips relationship/formula columns
 * (`deriveDbDatatype` returns null for lookup/grid — they own no column).
 */
function finalizeField(field: Record<string, unknown>): Record<string, unknown> {
	const ftc = field.fieldTypeCd;
	if (typeof ftc !== "string" || field.dbDatatype !== undefined) return field;
	const derived = deriveDbDatatype(ftc, {
		maxLen: typeof field.maxLen === "number" ? field.maxLen : undefined,
		precision: typeof field.precision === "number" ? field.precision : undefined,
	});
	if (derived == null) return field;
	return { ...field, dbDatatype: derived };
}

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
		formula: z.string().optional(),
		link: z.record(z.string(), z.unknown()).optional(),
		params: z.record(z.string(), z.unknown()).optional(),
	})
	.passthrough()
	.superRefine((val, ctx) => {
		// Rules live in ./field-rules so dforge_module_validate can re-run the
		// exact same set over every field of every entity — catching fields that
		// entered via import / scaffold / a hand edit and never saw this schema.
		// Only `error`-level issues reject the call here; warnings are advisory
		// and surface in the validator.
		for (const issue of checkFieldSpec("field", val)) {
			if (issue.level !== "error") continue;
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: issue.message.replace(/^field: /, ""),
			});
		}
	})
	.describe(
		"Field spec. RULES (load dforge://reference/flags, /field-types, /column-types first):\n" +
			"• flags = a subset of V/E/M only. NEVER combine I or H with them. VEM = required+visible; VE = optional+visible; V = read-only/formula; EM = hidden FK. 'VEMHI' is INVALID.\n" +
			"• dbDatatype is AUTO-DERIVED from fieldTypeCd when omitted (e.g. currency → numeric(18,2), text → varchar) — only set it to override. Values: bool, varchar, text, int, bigint, numeric, timestamptz, date, time, cuid, json. NOT boolean/string/datetime/integer/timestamp/number — 'number' is a fieldTypeCd, not a dbDatatype.\n" +
			"• A relation is TWO fields: hidden FK (dbDatatype:'cuid', flags:'EM', NO fieldTypeCd) + a Reference (columnType:'R', fieldTypeCd:'lookup', flags:'VEM', link:{entity,thisKey,otherKey}). otherKey = the target entity's PK ('{entity}_id'), never 'id'.\n" +
			"• Formula column: columnType:'F', baseDatatypeCd set, NO dbDatatype, flags:'V'.\n" +
			"• Column DEFAULTS use 'formula' (e.g. \"'draft'\" or \"TODAY()\"), NOT 'defaultValue' (settings-only).\n" +
			"• dropdown options go under params.options = [{value,label}] objects, never at the field root and never bare strings.",
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
	entity.fields = { ...fields, [args.fieldName]: finalizeField(args.field as Record<string, unknown>) };
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
	entity.fields = { ...fields, [args.fieldName]: finalizeField(args.field as Record<string, unknown>) };
	return makeResult(
		`Modified field '${args.fieldName}' on entity '${args.entityName}'.`,
		{
			[rel(paths.root, entityPath)]: jsonText(entity),
			"manifest.json": jsonText(withTodayStamp(manifest)),
		},
	);
}

// `entity_field_remove` lives in ./refactor.ts — it's a refactor-safe cascade
// (cleans up paired Reference, views, seed data; warns on formula/cross-entity
// dependents), alongside entity_field_rename.
