// Three sister tools for patching fields inside an existing entity:
//   dforge_entity_field_add     — append a new field to entity.fields
//   dforge_entity_field_modify  — replace an existing field's spec
//   dforge_entity_field_remove  — delete a field
//
// All three load the entity JSON, mutate, and return the single-file map.
// They DON'T touch related artifacts (views, roles, menus) — those are
// regenerated separately when the AI follows a backtrack flow.

import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	loadManifest,
	readJson,
	readJsonOrDefault,
	jsonText,
	rel,
	makeResult,
	withTodayStamp,
	fieldTypeCdSchema,
	type ToolResult,
	type ModulePaths,
} from "./_helpers";

const fieldSchema = z
	.object({
		dbDatatype: z.string().optional(),
		fieldTypeCd: fieldTypeCdSchema.optional(),
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
		"Field spec. Common keys: dbDatatype, fieldTypeCd, flags (VEMHI letters), isNullable, maxLen, orderNum, description, link ({entity, otherKey}) for refs, formula for computed columns. Pass through whatever the entity.schema.json allows.",
	);

// ── helpers ──────────────────────────────────────────────────────────

/** Appends fieldCode to the columns array of every view dataSource targeting entityCode. */
function addToViewColumns(
	paths: ModulePaths,
	entityCode: string,
	fieldCode: string,
	files: Record<string, string>,
): void {
	if (!fs.existsSync(paths.dataViews)) return;
	const views = readJsonOrDefault<Record<string, unknown>>(paths.dataViews, {});
	let changed = false;
	for (const vDef of Object.values(views)) {
		const dataSources = (vDef as Record<string, unknown>).dataSources as
			Array<Record<string, unknown>> | undefined;
		if (!Array.isArray(dataSources)) continue;
		for (const src of dataSources) {
			if (src.entityCode !== entityCode) continue;
			if (!Array.isArray(src.columns)) src.columns = [];
			const cols = src.columns as (string | Record<string, unknown>)[];
			const alreadyPresent = cols.some((c) =>
				typeof c === "string"
					? c === fieldCode
					: (c as { column_cd?: string }).column_cd === fieldCode,
			);
			if (!alreadyPresent) {
				cols.push(fieldCode);
				changed = true;
			}
		}
	}
	if (changed) {
		files[rel(paths.root, paths.dataViews)] = jsonText(views);
	}
}

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

	const f = args.field as Record<string, unknown>;
	const files: Record<string, string> = {};

	// Detect merged-field anti-pattern: lookup + link, but neither physical (no dbDatatype)
	// nor virtual (no columnType). Auto-expand into the canonical two-column FK+Reference pattern.
	const isMergedLookup =
		!f.columnType && f.fieldTypeCd === "lookup" && f.link && !f.dbDatatype;

	if (isMergedLookup) {
		const isIdField = args.fieldName.endsWith("_id");
		const fkName  = isIdField ? args.fieldName : `${args.fieldName}_id`;
		const refName = isIdField ? args.fieldName.slice(0, -3) : args.fieldName;
		const linkSpec   = f.link as Record<string, string>;
		const linkEntity = linkSpec.entity ?? "";
		const isMandatory = typeof f.flags === "string" && f.flags.includes("M");

		for (const name of [fkName, refName]) {
			if (Object.prototype.hasOwnProperty.call(fields, name)) {
				throw new Error(
					`Auto-expansion of '${args.fieldName}' needs to create '${name}', ` +
					`but that field already exists on '${args.entityName}'. ` +
					`Add the physical FK and Reference manually.`,
				);
			}
		}

		const baseOrder =
			typeof f.orderNum === "number"
				? f.orderNum
				: Object.keys(fields).length * 10 + 10;

		const fkField: Record<string, unknown> = {
			dbDatatype: "cuid",
			flags: isMandatory ? "EM" : "E",
			orderNum: baseOrder,
		};
		if (f.isNullable === true) fkField.isNullable = true;
		if (f.description) fkField.description = f.description;

		const refField: Record<string, unknown> = {
			columnType: "R",
			fieldTypeCd: "lookup",
			flags: isMandatory ? "VEM" : "VE",
			orderNum: baseOrder + 1,
			link: {
				entity: linkEntity,
				thisKey: fkName,
				otherKey: `${linkEntity}_id`,
			},
		};
		if (f.description) refField.description = f.description;

		entity.fields = { ...fields, [fkName]: fkField, [refName]: refField };
		addToViewColumns(paths, args.entityName, refName, files);

		files[rel(paths.root, entityPath)] = jsonText(entity);
		files["manifest.json"] = jsonText(withTodayStamp(manifest));

		return makeResult(
			`Auto-expanded '${args.fieldName}' into two-column FK+Reference pattern: ` +
			`'${fkName}' (physical, dbDatatype cuid, flags ${fkField.flags as string}) ` +
			`+ '${refName}' (virtual Reference, columnType R, flags ${refField.flags as string}). ` +
			`'${refName}' added to entity views.`,
			files,
			`Merged-field pattern detected and auto-corrected. For future calls, ` +
			`pass the physical FK and Reference as two separate dforge_entity_field_add calls, ` +
			`or rely on this auto-expansion by providing fieldTypeCd:"lookup" + link.`,
		);
	}

	// Normal single-field path
	if (Object.prototype.hasOwnProperty.call(fields, args.fieldName)) {
		throw new Error(
			`Field '${args.fieldName}' already exists on entity '${args.entityName}'. Use entity_field_modify to change it.`,
		);
	}
	entity.fields = { ...fields, [args.fieldName]: f };

	// Auto-add visible fields to the entity's views
	const flags = f.flags as string | undefined;
	const isHiddenOrInternal = flags && (flags.includes("H") || flags.includes("I"));
	const isVisible = !flags || flags.includes("V");
	if (isVisible && !isHiddenOrInternal) {
		addToViewColumns(paths, args.entityName, args.fieldName, files);
	}

	files[rel(paths.root, entityPath)] = jsonText(entity);
	files["manifest.json"] = jsonText(withTodayStamp(manifest));

	return makeResult(`Added field '${args.fieldName}' to entity '${args.entityName}'.`, files);
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
