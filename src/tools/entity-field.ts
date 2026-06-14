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
import { isFieldTypeCd, fieldTypeCds, deriveDbDatatype, getColumnType } from "@dforge-core/metadata";
import {
	loadManifest,
	readJson,
	jsonText,
	rel,
	makeResult,
	withTodayStamp,
	type ToolResult,
} from "./_helpers";

// Common wrong codes → the real fieldTypeCd, surfaced in the validation error
// so the agent self-corrects instead of guessing.
const FIELD_TYPE_ALIASES: Record<string, string> = {
	integer: "number",
	int: "number",
	decimal: "number",
	float: "number",
	string: "text",
	varchar: "text",
	boolean: "checkbox",
	bool: "checkbox",
	reference: "lookup",
	autocomplete: "lookup",
	fk: "lookup",
	datepicker: "date",
	timestamp: "datetime",
	select: "dropdown",
	multiselect: "flags",
};

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
		const v = val as Record<string, unknown>;
		// `defaultValue`/`default` are settings keys, not entity-field keys — the
		// entity schema is additionalProperties:false. Set defaults via `formula`.
		if (v.defaultValue !== undefined || v.default !== undefined) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message:
					"entity fields have no 'defaultValue'/'default' key (settings-only). Set a default with 'formula' (e.g. \"formula\": \"'draft'\" or \"formula\": \"TODAY()\"), a numberSequence, or DSL logic.",
			});
		}
		// Dropdown options live under params.options, never at the field root.
		if (v.options !== undefined) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message:
					"dropdown options go under params.options, not at the field root, e.g. \"params\": { \"options\": [{ \"value\": \"a\", \"label\": \"A\" }] }.",
			});
		}
		// Flags letters must be from V/I/E/M/H (no U/S/P).
		if (typeof v.flags === "string" && v.flags.length > 0 && !/^[VIEMH]+$/.test(v.flags)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: `flags '${v.flags}' contains invalid letters — use only V/I/E/M/H (e.g. VEM, VE, V, EM). U/S/P are not flag letters.`,
			});
		}
		// fieldTypeCd must be a real code from the platform registry
		// (@dforge-core/metadata, mirror of the field_type seed). A hidden FK
		// column legitimately has no fieldTypeCd, so only validate when present.
		if (typeof v.fieldTypeCd === "string" && v.fieldTypeCd.length > 0 && !isFieldTypeCd(v.fieldTypeCd)) {
			const alias = FIELD_TYPE_ALIASES[v.fieldTypeCd.toLowerCase()];
			const hint = alias
				? ` Did you mean '${alias}'?`
				: ` Valid codes: ${[...fieldTypeCds].sort().join(", ")}.`;
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: `fieldTypeCd '${v.fieldTypeCd}' is not a valid field type.${hint} (See dforge://reference/field-types.)`,
			});
		}
		// columnType, when present, must be a known column kind. A plain data
		// column omits it; R/S/F cover reference/set/formula; A/L/G are register
		// columns. Catches typos like 'ref', 'lookup', 'X'.
		if (typeof v.columnType === "string" && v.columnType.length > 0 && !getColumnType(v.columnType)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: `columnType '${v.columnType}' is invalid. Use 'R' (reference), 'S' (set/child list), or 'F' (formula) — or omit it for a plain data column. (A/L/G exist for register columns.)`,
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
