// Import core: turn a normalized table-spec (tables → columns → relationships)
// into dForge entities. This is the shared transformer that the front-ends feed
// — DBML/SQL, an Excel/CSV upload, or a hand-authored spec. The interesting part
// is type inference: a column's fieldTypeCd is derived from an explicit code, a
// source SQL type, sample values, and name heuristics — then validated against
// the @dforge-core/metadata registry, with dbDatatype derived from it.

import { z } from "zod";
import { isFieldTypeCd, deriveDbDatatype } from "@dforge-core/metadata";
import {
	buildDataViews,
	buildFolders,
	buildMenus,
	buildRoles,
} from "@dforge-core/dforge-cli/templates";
import type { EntitySpec, ScaffoldOpts } from "@dforge-core/dforge-cli/templates";
import {
	loadManifest,
	jsonText,
	makeResult,
	withTodayStamp,
	type ToolResult,
} from "./_helpers";

const codeRe = z.string().regex(/^[a-z][a-z0-9_]*$/);

const columnSpec = z.object({
	name: codeRe.describe("Column code (snake_case)."),
	label: z.string().optional(),
	fieldTypeCd: z.string().optional().describe("Explicit field type; omit to infer."),
	sqlType: z.string().optional().describe("Source SQL type hint, e.g. varchar(50), int, numeric(18,2), timestamptz, bool."),
	sampleValues: z.array(z.union([z.string(), z.number(), z.boolean()])).optional().describe("A few example cell values — used to infer the type when no sqlType is given."),
	required: z.boolean().optional(),
});

const tableSpec = z.object({
	name: codeRe.describe("Entity code (snake_case)."),
	label: z.string().optional(),
	columns: z.array(columnSpec).min(1),
	references: z
		.array(
			z.object({
				column: codeRe.describe("FK column on THIS table (a hidden cuid column is generated for it)."),
				toTable: codeRe.describe("Target entity code."),
				toColumn: codeRe.optional().describe("Target PK column; defaults to {toTable}_id."),
			}),
		)
		.optional(),
});

export const moduleImportSchema = {
	moduleDir: z.string().describe("Path to an existing module dir (scaffold a minimal one first if needed) — import ADDS entities."),
	tables: z.array(tableSpec).min(1).describe("Normalized table-spec, produced from DBML/SQL, an Excel/CSV upload, or hand-authored."),
};

type Column = z.infer<typeof columnSpec>;
type Table = z.infer<typeof tableSpec>;

// Source SQL type (lowercased, params stripped) → fieldTypeCd.
const SQL_TYPE_MAP: Record<string, string> = {
	varchar: "text", nvarchar: "text", char: "text", bpchar: "text", string: "text",
	text: "textarea", ntext: "textarea", clob: "textarea",
	int: "number", integer: "number", int2: "number", int4: "number", int8: "number",
	bigint: "number", smallint: "number", tinyint: "number", serial: "number", bigserial: "number",
	numeric: "number", decimal: "number", float: "number", float8: "number", double: "number", real: "number",
	money: "currency",
	bool: "checkbox", boolean: "checkbox", bit: "checkbox",
	date: "date",
	timestamp: "datetime", timestamptz: "datetime", datetime: "datetime", datetime2: "datetime",
	time: "time", timetz: "time",
	json: "json", jsonb: "json",
	uuid: "text",
};

function titleCase(code: string): string {
	return code.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function inferFromSamples(samples: Array<string | number | boolean>): string {
	const vals = samples.filter((v) => v !== null && v !== "");
	if (!vals.length) return "text";
	if (vals.every((v) => typeof v === "boolean" || /^(true|false|yes|no)$/i.test(String(v)))) return "checkbox";
	if (vals.every((v) => typeof v === "number" || /^-?\d+(\.\d+)?$/.test(String(v)))) return "number";
	if (vals.every((v) => /^\d{4}-\d{2}-\d{2}/.test(String(v)))) return "date";
	return "text";
}

/** Resolve a column to a fieldTypeCd (+ optional params), layering the signals. */
function inferFieldType(col: Column): { fieldTypeCd: string; params?: Record<string, unknown> } {
	if (col.fieldTypeCd) return { fieldTypeCd: col.fieldTypeCd };

	let base: string | undefined;
	if (col.sqlType) {
		base = SQL_TYPE_MAP[col.sqlType.toLowerCase().replace(/\(.*$/, "").trim()];
	}
	if (!base && col.sampleValues?.length) base = inferFromSamples(col.sampleValues);
	base = base ?? "text";

	const n = col.name.toLowerCase();
	if (base === "text" || base === "textarea") {
		if (/email/.test(n)) base = "email";
		else if (/phone|tel|mobile|fax/.test(n)) base = "phone";
		else if (/url|website|homepage/.test(n)) base = "url";
	}
	if (base === "number" && /price|amount|cost|total|salary|fee|balance|revenue|payment|wage/.test(n)) {
		base = "currency";
	}

	// A small set of repeated string values → a dropdown with those options.
	if (base === "text" && col.sampleValues && col.sampleValues.length >= 3) {
		const distinct = [...new Set(col.sampleValues.map(String))];
		if (distinct.length <= 8 && distinct.length < col.sampleValues.length) {
			return { fieldTypeCd: "dropdown", params: { options: distinct.map((v) => ({ value: v, label: v })) } };
		}
	}
	return { fieldTypeCd: base };
}

function buildImportedEntity(table: Table): Record<string, unknown> {
	const fields: Record<string, unknown> = {};
	const refColumns = new Set((table.references ?? []).map((r) => r.column));
	let order = 10;
	let toStringField: string | undefined;

	for (const col of table.columns) {
		if (refColumns.has(col.name)) continue; // emitted as an FK pair below
		const inf = inferFieldType(col);
		if (!isFieldTypeCd(inf.fieldTypeCd)) {
			throw new Error(`Inferred an invalid fieldTypeCd '${inf.fieldTypeCd}' for ${table.name}.${col.name} — pass an explicit fieldTypeCd.`);
		}
		const field: Record<string, unknown> = {
			fieldTypeCd: inf.fieldTypeCd,
			flags: col.required ? "VEM" : "VE",
			orderNum: order,
			description: col.label ?? titleCase(col.name),
		};
		const db = deriveDbDatatype(inf.fieldTypeCd);
		if (db) field.dbDatatype = db;
		if (inf.params) field.params = inf.params;
		fields[col.name] = field;
		if (!toStringField && inf.fieldTypeCd === "text") toStringField = col.name;
		order += 10;
	}

	// FK + Reference pairs.
	const references: Record<string, unknown> = {};
	for (const ref of table.references ?? []) {
		const otherKey = ref.toColumn ?? `${ref.toTable}_id`;
		fields[ref.column] = { dbDatatype: "cuid", flags: "EM", orderNum: order, description: titleCase(ref.column) };
		order += 10;
		const refName = ref.column.endsWith("_id") ? ref.column.slice(0, -3) : `${ref.column}_ref`;
		fields[refName] = {
			columnType: "R",
			fieldTypeCd: "lookup",
			flags: "VEM",
			orderNum: order,
			description: titleCase(refName),
			link: { entity: ref.toTable, thisKey: ref.column, otherKey },
		};
		order += 10;
		references[`FK_${titleCase(table.name).replace(/\s+/g, "")}_${ref.column}`] = {
			from: { field: ref.column },
			to: { entity: ref.toTable, field: otherKey },
		};
	}

	const entity: Record<string, unknown> = {
		description: table.label ?? titleCase(table.name),
		dbObject: table.name,
		toString: toStringField ? `{${toStringField}}` : null,
		traits: ["identity", "audit"],
		fields,
	};
	if (Object.keys(references).length) entity.references = references;
	return entity;
}

export function moduleImport(
	args: z.infer<z.ZodObject<typeof moduleImportSchema>>,
): ToolResult {
	const { manifest } = loadManifest(args.moduleDir);
	const existing = new Set(Object.keys(manifest.entities ?? {}));

	const files: Record<string, string> = {};
	const added: string[] = [];
	const manifestEntities: Record<string, string> = { ...((manifest.entities as Record<string, string>) ?? {}) };

	for (const table of args.tables) {
		if (existing.has(table.name)) {
			throw new Error(`Entity '${table.name}' already exists — import only ADDS new entities. Remove it from the spec or edit the entity directly.`);
		}
		files[`entities/${table.name}.json`] = jsonText(buildImportedEntity(table));
		manifestEntities[table.name] = `./entities/${table.name}.json`;
		added.push(table.name);
	}
	manifest.entities = manifestEntities;

	// Regenerate default UI + security over all entities (same as add_entity).
	const allSpecs: EntitySpec[] = Object.keys(manifestEntities)
		.filter((n) => !n.includes("."))
		.map((n) => ({ name: n, label: titleCase(n), traits: "identity" }));
	const opts: ScaffoldOpts = {
		path: "",
		code: manifest.code,
		displayName: manifest.displayName ?? manifest.code,
		description: manifest.description ?? "",
		author: "",
		license: (manifest.license as string) ?? "MIT",
		version: manifest.version ?? "0.1.0",
		dbSchemaVersion: manifest.dbSchemaVersion ?? "0.0.1",
		dependencies: Object.keys(manifest.dependencies ?? {}),
		preset: "minimal",
		entities: allSpecs,
	};
	files["ui/data_views.json"] = jsonText(buildDataViews(allSpecs));
	files["ui/folders.json"] = jsonText(buildFolders(opts));
	files["ui/menus.json"] = jsonText(buildMenus(opts));
	files["security/roles.json"] = jsonText(buildRoles(opts));
	files["manifest.json"] = jsonText(withTodayStamp(manifest));

	return makeResult(
		`Imported ${added.length} entit${added.length === 1 ? "y" : "ies"} (${added.join(", ")}) with inferred field types + FK+Reference pairs; regenerated default views/folders/menus/roles.`,
		files,
		"Review the inferred field types (especially dropdown vs text, and currency vs number) and the generated default grids — refine views to surface the imported columns. Cross-table references resolve only if both tables are in this import or already in the module. Run dforge_module_validate after writing.",
	);
}
