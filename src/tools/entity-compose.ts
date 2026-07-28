// Intent-level entity tools.
//
// Three dForge concepts each require several coordinated edits across an
// entity file, and getting the split wrong is the documented #1 / #2 source of
// broken modules:
//
//   relation  → hidden FK column + visible Reference column + `references` entry
//   roll-up   → Set column on the parent + a Generated column aggregating a
//               PHYSICAL child column (never a Formula, never a virtual child)
//   status    → a dropdown column with params.options + a `formula` initial
//               value (entity fields have no `defaultValue` key)
//
// dforge_entity_field_add can express all three, but only if the caller
// remembers every part. These tools take the INTENT and emit the whole shape,
// so the broken variants aren't representable.

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
	type ModulePaths,
	type Manifest,
	type ToolResult,
} from "./_helpers";

type Entity = Record<string, unknown>;
type Fields = Record<string, Record<string, unknown>>;

/** Load one entity JSON from an existing module, with a clear error if absent. */
function loadEntity(
	moduleDir: string,
	entityName: string,
): { paths: ModulePaths; manifest: Manifest; entity: Entity; entityPath: string } {
	const { paths, manifest } = loadManifest(moduleDir);
	const entityPath = path.join(paths.entitiesDir, `${entityName}.json`);
	try {
		const entity = readJson<Entity>(entityPath);
		return { paths, manifest, entity, entityPath };
	} catch {
		throw new Error(
			`Entity '${entityName}' not found at entities/${entityName}.json. ` +
				`Existing entities: ${Object.keys(manifest.entities ?? {}).join(", ") || "(none)"}.`,
		);
	}
}

const fieldsOf = (entity: Entity): Fields => (entity.fields as Fields | undefined) ?? {};

/** Next free orderNum, so appended columns land after the existing ones. */
function nextOrderNum(fields: Fields): number {
	let max = 0;
	for (const f of Object.values(fields)) {
		const n = typeof f?.orderNum === "number" ? f.orderNum : 0;
		if (n > max) max = n;
	}
	return Math.ceil((max + 10) / 10) * 10;
}

/** The PK column name the `identity` trait provides. */
const pkOf = (entityCode: string): string => `${entityCode.split(".").pop()}_id`;

/** PascalCase a snake_case code, for the `references` block's constraint name. */
const pascal = (s: string): string =>
	s
		.split(/[._]/)
		.filter(Boolean)
		.map((p) => p[0].toUpperCase() + p.slice(1))
		.join("");

// ─── reference add ────────────────────────────────────────────────────────────

export const entityReferenceAddSchema = {
	moduleDir: z.string().describe("Path to the module root."),
	entity: z
		.string()
		.regex(/^[a-z][a-z0-9_]*$/)
		.describe("The CHILD entity — the one that gets the FK columns."),
	targetEntity: z
		.string()
		.regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)?$/)
		.describe(
			"The PARENT entity being pointed at. Cross-module dotted form ('fin.invoice') is allowed when it's a declared dependency.",
		),
	name: z
		.string()
		.regex(/^[a-z][a-z0-9_]*$/)
		.describe(
			"Name of the VISIBLE reference column, e.g. 'list' or 'customer'. The hidden FK column is named '<name>_id' unless fkField overrides it.",
		),
	fkField: z
		.string()
		.regex(/^[a-z][a-z0-9_]*$/)
		.optional()
		.describe("Override the hidden FK column name. Default: '<name>_id'."),
	label: z.string().optional().describe("Display label for the reference column. Default: derived from name."),
	required: z
		.boolean()
		.default(true)
		.describe("true → flags 'VEM' (required); false → 'VE' (optional). Mirrors the FK's nullability."),
	targetPk: z
		.string()
		.regex(/^[a-z][a-z0-9_]*$/)
		.optional()
		.describe(
			"The parent's PK column. Default '{targetEntity}_id' (what the identity trait provides). Never 'id'.",
		),
	orderNum: z.number().int().optional().describe("Order of the reference column in the UI. Default: appended."),
};

/**
 * Emit the complete FK+Reference pair in one call:
 *   • hidden FK column  — dbDatatype 'cuid', flags 'EM', NO fieldTypeCd
 *   • Reference column  — columnType 'R', fieldTypeCd 'lookup', flags VEM/VE, link{}
 *   • `references` entry — from.field → to.entity/to.field
 */
export function entityReferenceAdd(
	args: z.infer<z.ZodObject<typeof entityReferenceAddSchema>>,
): ToolResult {
	const { paths, manifest, entity, entityPath } = loadEntity(args.moduleDir, args.entity);
	const fields = fieldsOf(entity);

	const fkField = args.fkField ?? `${args.name}_id`;
	const targetPk = args.targetPk ?? pkOf(args.targetEntity);

	if (fkField === args.name) {
		throw new Error(
			`fkField and name are both '${fkField}' — an FK+Reference is TWO columns: a hidden FK ('${args.name}_id') ` +
				`plus a visible reference ('${args.name}'). They can't share a name.`,
		);
	}
	// The VISIBLE half must be free — reusing it would silently redefine a column.
	if (Object.prototype.hasOwnProperty.call(fields, args.name)) {
		throw new Error(
			`Column '${args.name}' already exists on '${args.entity}'. Remove it first ` +
				"(dforge_entity_field_remove) or pick a different name.",
		);
	}

	// The HIDDEN FK may already exist — a DBML/table-spec import creates FK
	// columns without their Reference half, and completing that half-built
	// relation is exactly what this tool should do. But an existing column is
	// only a valid hidden FK in one exact shape (dbDatatype 'cuid', flags E+M
	// without V, no fieldTypeCd, no columnType); anything else would emit a pair
	// that looks complete and fails at install. Refuse structural columns, and
	// NORMALIZE the rest to the required shape rather than trusting it.
	const existingFk = fields[fkField];
	if (existingFk && typeof existingFk.columnType === "string" && existingFk.columnType !== "D") {
		throw new Error(
			`Column '${fkField}' already exists on '${args.entity}' as a '${existingFk.columnType}' column, ` +
				"so it can't serve as the hidden FK. Pass a different fkField.",
		);
	}
	const reusedFk = Boolean(existingFk);
	/** What normalization had to change on the reused column, for the response. */
	const fkFixes: string[] = [];
	if (existingFk) {
		const flags = typeof existingFk.flags === "string" ? existingFk.flags : "";
		if (existingFk.dbDatatype !== "cuid") {
			fkFixes.push(
				`dbDatatype ${existingFk.dbDatatype === undefined ? "(unset)" : `'${String(existingFk.dbDatatype)}'`} → 'cuid' (the target PK type)`,
			);
		}
		if (flags !== "EM") {
			fkFixes.push(`flags '${flags || "(unset)"}' → 'EM' (hidden, not user-visible)`);
		}
		if (existingFk.fieldTypeCd !== undefined) {
			fkFixes.push(
				`dropped fieldTypeCd '${String(existingFk.fieldTypeCd)}' (the hidden FK has no UI control — the Reference column carries it)`,
			);
		}
		if (existingFk.columnType !== undefined) {
			fkFixes.push(`dropped columnType '${String(existingFk.columnType)}' (a hidden FK is a plain data column)`);
		}
	}
	if (args.targetEntity === args.entity && !args.fkField) {
		// Self-reference is legal (tree structures) — just make sure the derived
		// FK name doesn't collide with the entity's own PK.
		if (fkField === pkOf(args.entity)) {
			throw new Error(
				`Derived FK column '${fkField}' collides with '${args.entity}'s own identity PK. ` +
					"Pass an explicit fkField (e.g. 'parent_id').",
			);
		}
	}

	const label = args.label ?? pascal(args.name).replace(/([a-z])([A-Z])/g, "$1 $2");
	const flags = args.required ? "VEM" : "VE";
	const base = args.orderNum ?? nextOrderNum(fields);

	if (existingFk) {
		// Keep the author's own metadata (orderNum, description, maxLen, …) but
		// force the four keys that define a hidden FK.
		const { fieldTypeCd: _ft, columnType: _ct, ...keep } = existingFk;
		fields[fkField] = {
			...keep,
			dbDatatype: "cuid",
			flags: "EM",
			orderNum: typeof existingFk.orderNum === "number" ? existingFk.orderNum : base,
			description: typeof existingFk.description === "string" ? existingFk.description : `${label} ID`,
		};
	} else {
		fields[fkField] = {
			dbDatatype: "cuid",
			flags: "EM",
			orderNum: base,
			description: `${label} ID`,
		};
	}
	fields[args.name] = {
		columnType: "R",
		fieldTypeCd: "lookup",
		flags,
		orderNum: base + 5,
		description: label,
		link: { entity: args.targetEntity, thisKey: fkField, otherKey: targetPk },
	};
	entity.fields = fields;

	const refs = (entity.references as Record<string, unknown> | undefined) ?? {};
	const refName = `FK_${pascal(args.entity)}_${pascal(args.name)}`;
	refs[refName] = {
		from: { field: fkField },
		to: { entity: args.targetEntity, field: targetPk },
	};
	entity.references = refs;

	const warnings: string[] = [];
	if (fkFixes.length > 0) {
		warnings.push(
			`Reused column '${fkField}' was not in the hidden-FK shape and has been normalized: ` +
				`${fkFixes.join("; ")}. Re-check anything that referenced it as a plain column.`,
		);
	}
	if (args.targetEntity.includes(".")) {
		warnings.push(
			`'${args.targetEntity}' is cross-module — make sure '${args.targetEntity.split(".")[0]}' is a declared dependency (dforge_dependency_add).`,
		);
	}

	return makeResult(
		`Added reference '${args.name}' on '${args.entity}' → '${args.targetEntity}' ` +
			`(${reusedFk ? `reused existing FK '${fkField}'${fkFixes.length ? " (normalized)" : ""}` : `hidden FK '${fkField}'`} + Reference column + ` +
			`references.${refName}, ${args.required ? "required" : "optional"}).`,
		{
			[rel(paths.root, entityPath)]: jsonText(entity),
			"manifest.json": jsonText(withTodayStamp(manifest)),
		},
		warnings.length > 0 ? warnings.join("\n") : undefined,
	);
}

// ─── roll-up add ──────────────────────────────────────────────────────────────

export const entityRollupAddSchema = {
	moduleDir: z.string().describe("Path to the module root."),
	entity: z
		.string()
		.regex(/^[a-z][a-z0-9_]*$/)
		.describe("The PARENT entity that gets the roll-up total."),
	name: z
		.string()
		.regex(/^[a-z][a-z0-9_]*$/)
		.describe("Name of the new Generated column, e.g. 'total_amount'."),
	childEntity: z
		.string()
		.regex(/^[a-z][a-z0-9_]*$/)
		.describe("The CHILD entity whose rows are aggregated."),
	childField: z
		.string()
		.regex(/^[a-z][a-z0-9_]*$/)
		.describe(
			"The child column to aggregate. MUST be physical (a plain data column or a same-row Generated one) — aggregating a virtual F/R/S column fails install.",
		),
	agg: z
		.enum(["SUM", "COUNT", "AVG", "MIN", "MAX"])
		.default("SUM")
		.describe("Aggregate function."),
	setField: z
		.string()
		.regex(/^[a-z][a-z0-9_]*$/)
		.optional()
		.describe(
			"Name of the Set column on the parent that lists the child rows. Reused if it already exists; created if not. Default: '<childEntity>s'.",
		),
	childFkField: z
		.string()
		.regex(/^[a-z][a-z0-9_]*$/)
		.optional()
		.describe(
			"The FK column on the child pointing back at the parent — only needed when the Set column has to be created. Default: '{parentEntity}_id'.",
		),
	label: z.string().optional().describe("Display label. Default: derived from name."),
	dbDatatype: z
		.string()
		.optional()
		.describe("SQL type of the total. Default: copied from the aggregated child column (numeric for AVG, int8 for COUNT)."),
	orderNum: z.number().int().optional(),
};

/**
 * Emit a roll-up total as a GENERATED ('G') column — the installer maintains it
 * with a DB trigger. Creates the parent's Set column if it doesn't exist yet,
 * and refuses to aggregate a virtual child column (the documented
 * `column old.<field> does not exist` install failure).
 */
export function entityRollupAdd(
	args: z.infer<z.ZodObject<typeof entityRollupAddSchema>>,
): ToolResult {
	const { paths, manifest, entity, entityPath } = loadEntity(args.moduleDir, args.entity);
	const fields = fieldsOf(entity);

	if (Object.prototype.hasOwnProperty.call(fields, args.name)) {
		throw new Error(`Column '${args.name}' already exists on '${args.entity}'.`);
	}

	// ── Validate the child column is PHYSICAL ──
	const { entity: child } = loadEntity(args.moduleDir, args.childEntity);
	const childFields = fieldsOf(child);
	const childCol = childFields[args.childField];
	if (!childCol) {
		throw new Error(
			`'${args.childField}' is not a column on child entity '${args.childEntity}'. ` +
				`Its columns: ${Object.keys(childFields).join(", ") || "(none)"}.`,
		);
	}
	const childType = typeof childCol.columnType === "string" ? childCol.columnType : "D";
	if (childType === "F" || childType === "R" || childType === "S") {
		throw new Error(
			`'${args.childEntity}.${args.childField}' is a virtual '${childType}' column. A Generated aggregate reads ` +
				`the child's PHYSICAL column, so install fails with \`column old.${args.childField} does not exist\`. ` +
				"Aggregate a plain data column (or a same-row Generated one) instead. (See dforge://reference/column-types.)",
		);
	}

	// ── Find or create the Set column on the parent ──
	const setField = args.setField ?? `${args.childEntity}s`;
	const existingSet = fields[setField];
	let createdSet = false;
	if (existingSet) {
		if (existingSet.columnType !== "S") {
			throw new Error(
				`Column '${setField}' already exists on '${args.entity}' but is not a set column (columnType 'S'). ` +
					"Pass a different setField.",
			);
		}
		const linked = (existingSet.link as Record<string, unknown> | undefined)?.entity;
		if (linked && linked !== args.childEntity) {
			throw new Error(
				`Set column '${setField}' on '${args.entity}' points at '${String(linked)}', not '${args.childEntity}'.`,
			);
		}
	} else {
		const childFk = args.childFkField ?? `${args.entity}_id`;
		if (!childFields[childFk]) {
			throw new Error(
				`Can't create the set column '${setField}': the child '${args.childEntity}' has no FK column ` +
					`'${childFk}' pointing back at '${args.entity}'. Add the relation first with ` +
					`dforge_entity_reference_add({ entity: '${args.childEntity}', targetEntity: '${args.entity}', name: '${args.entity}' }), ` +
					"or pass childFkField explicitly.",
			);
		}
		fields[setField] = {
			columnType: "S",
			fieldTypeCd: "grid",
			flags: "VEM",
			orderNum: nextOrderNum(fields),
			description: pascal(setField).replace(/([a-z])([A-Z])/g, "$1 $2"),
			link: { entity: args.childEntity, thisKey: pkOf(args.entity), otherKey: childFk },
		};
		createdSet = true;
	}

	// ── The Generated column itself ──
	const label = args.label ?? pascal(args.name).replace(/([a-z])([A-Z])/g, "$1 $2");
	let dbDatatype = args.dbDatatype;
	if (!dbDatatype) {
		if (args.agg === "COUNT") dbDatatype = "int8";
		else if (args.agg === "AVG") dbDatatype = "numeric(18,4)";
		else if (typeof childCol.dbDatatype === "string" && childCol.dbDatatype) dbDatatype = childCol.dbDatatype;
		else if (typeof childCol.fieldTypeCd === "string") {
			dbDatatype = deriveDbDatatype(childCol.fieldTypeCd, {}) ?? "numeric(18,2)";
		} else dbDatatype = "numeric(18,2)";
	}

	fields[args.name] = {
		columnType: "G",
		dbDatatype,
		flags: "V",
		orderNum: args.orderNum ?? nextOrderNum(fields),
		description: label,
		formula: `${args.agg}([${setField}].[${args.childField}])`,
	};
	entity.fields = fields;

	return makeResult(
		`Added roll-up '${args.name}' on '${args.entity}' = ${args.agg}([${setField}].[${args.childField}]) ` +
			`as a Generated column (${dbDatatype})${createdSet ? `, plus the set column '${setField}'` : ""}.`,
		{
			[rel(paths.root, entityPath)]: jsonText(entity),
			"manifest.json": jsonText(withTodayStamp(manifest)),
		},
	);
}

// ─── status add ───────────────────────────────────────────────────────────────

const statusOption = z.union([
	z.string(),
	z
		.object({
			value: z.string(),
			label: z.string().optional(),
			color: z.string().optional(),
			icon: z.string().optional(),
		})
		.passthrough(),
]);

export const entityStatusAddSchema = {
	moduleDir: z.string().describe("Path to the module root."),
	entity: z.string().regex(/^[a-z][a-z0-9_]*$/).describe("Entity to add the status column to."),
	name: z
		.string()
		.regex(/^[a-z][a-z0-9_]*$/)
		.default("status")
		.describe("Column name. Default 'status'."),
	options: z
		.array(statusOption)
		.min(2)
		.describe(
			"The status values, in workflow order. Either bare strings ('draft') or objects ({ value, label?, color?, icon? }). A single-value status should be a checkbox instead.",
		),
	initial: z
		.string()
		.optional()
		.describe(
			"The value new records start at — emitted as a `formula` (entity fields have NO defaultValue key). Must be one of options. Default: the first option.",
		),
	label: z.string().optional().describe("Display label. Default: derived from name."),
	required: z.boolean().default(true).describe("true → flags 'VEM'; false → 'VE'."),
	orderNum: z.number().int().optional(),
};

/**
 * Emit a status column as a dropdown with `params.options` and a `formula`
 * initial value — the two things hand-authored status columns get wrong
 * (options at the field root; a `defaultValue` key the entity schema rejects).
 */
export function entityStatusAdd(
	args: z.infer<z.ZodObject<typeof entityStatusAddSchema>>,
): ToolResult {
	const { paths, manifest, entity, entityPath } = loadEntity(args.moduleDir, args.entity);
	const fields = fieldsOf(entity);

	if (Object.prototype.hasOwnProperty.call(fields, args.name)) {
		throw new Error(
			`Column '${args.name}' already exists on '${args.entity}'. Use dforge_entity_field_modify to change it.`,
		);
	}

	const options = args.options.map((o) =>
		typeof o === "string"
			? { value: o, label: o.replace(/[_-]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) }
			: { label: o.value.replace(/[_-]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()), ...o },
	);
	const values = options.map((o) => o.value);
	const dupes = values.filter((v, i) => values.indexOf(v) !== i);
	if (dupes.length > 0) {
		throw new Error(`Duplicate status value(s): ${[...new Set(dupes)].join(", ")}.`);
	}

	const initial = args.initial ?? values[0];
	if (!values.includes(initial)) {
		throw new Error(
			`initial '${initial}' is not one of the declared options (${values.join(", ")}).`,
		);
	}

	const label = args.label ?? pascal(args.name).replace(/([a-z])([A-Z])/g, "$1 $2");
	const maxLen = Math.max(20, ...values.map((v) => v.length));

	fields[args.name] = {
		dbDatatype: "varchar",
		fieldTypeCd: "dropdown",
		flags: args.required ? "VEM" : "VE",
		maxLen,
		orderNum: args.orderNum ?? nextOrderNum(fields),
		description: label,
		// Entity fields have no `defaultValue` key — the initial value is a
		// quoted literal formula.
		formula: `'${initial}'`,
		params: { options },
	};
	entity.fields = fields;

	return makeResult(
		`Added status column '${args.name}' on '${args.entity}' with ${values.length} options ` +
			`(${values.join(" → ")}), starting at '${initial}'.`,
		{
			[rel(paths.root, entityPath)]: jsonText(entity),
			"manifest.json": jsonText(withTodayStamp(manifest)),
		},
		`Status values are now fixed in the entity. Any action's canExecute: guard must reference one of: ${values.join(", ")}.`,
	);
}
