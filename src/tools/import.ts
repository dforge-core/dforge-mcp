// Import core: turn a normalized table-spec (tables → columns → relationships)
// into dForge entities. This is the shared transformer that the front-ends feed
// — DBML/SQL, an Excel/CSV upload, or a hand-authored spec. The interesting part
// is type inference: a column's fieldTypeCd is derived from an explicit code, a
// source SQL type, sample values, and name heuristics — then validated against
// the @dforge-core/metadata registry, with dbDatatype derived from it.

import { randomUUID } from "node:crypto";
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
	type Manifest,
	type ToolResult,
} from "./_helpers";

// Identity for a NEW module — supplied only when importing into an empty dir
// (greenfield). When a manifest already exists it's ignored.
const moduleIdentitySchema = z
	.object({
		code: codeReLazy(),
		displayName: z.string().optional(),
		version: z.string().optional(),
		dbSchemaVersion: z.string().optional(),
		license: z.string().optional(),
	})
	.optional();

// codeRe is declared below; this defers the reference so order doesn't matter.
function codeReLazy() {
	return z.string().regex(/^[a-z][a-z0-9_]*$/);
}

/** Load the module's manifest, or synthesize a minimal one for a greenfield import. */
function ensureManifest(moduleDir: string, identity?: z.infer<typeof moduleIdentitySchema>): Manifest {
	try {
		return loadManifest(moduleDir).manifest;
	} catch {
		if (!identity?.code) {
			throw new Error(`No manifest.json in '${moduleDir}'. Pass module.code (and module.displayName) to start a new module from this import.`);
		}
		return {
			packageFormat: 1,
			moduleId: randomUUID(),
			code: identity.code,
			version: identity.version ?? "0.1.0",
			dbSchemaVersion: identity.dbSchemaVersion ?? "0.0.1",
			displayName: identity.displayName ?? identity.code,
			license: identity.license ?? "MIT",
			entities: {},
		} as Manifest;
	}
}

/** Build the file map for importing `tables` into a module (manifest + entities + regenerated UI/security). */
function buildImportFiles(manifest: Manifest, tables: Table[]): { files: Record<string, string>; added: string[] } {
	const existing = new Set(Object.keys(manifest.entities ?? {}));
	const files: Record<string, string> = {};
	const added: string[] = [];
	const manifestEntities: Record<string, string> = { ...((manifest.entities as Record<string, string>) ?? {}) };

	for (const table of tables) {
		if (existing.has(table.name)) {
			throw new Error(`Entity '${table.name}' already exists — import only ADDS new entities. Remove it from the spec or edit the entity directly.`);
		}
		files[`entities/${table.name}.json`] = jsonText(buildImportedEntity(table));
		manifestEntities[table.name] = `./entities/${table.name}.json`;
		added.push(table.name);
	}
	manifest.entities = manifestEntities;

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
	return { files, added };
}

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
	moduleDir: z.string().describe("Path to the module dir. If it has no manifest, pass `module` to start a new module (greenfield import)."),
	tables: z.array(tableSpec).min(1).describe("Normalized table-spec, produced from DBML/SQL, an Excel/CSV upload (read by the AI), or hand-authored."),
	module: moduleIdentitySchema.describe("New-module identity — required only when moduleDir has no manifest yet."),
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

const IMPORT_WARNING =
	"Review the inferred field types (especially dropdown vs text, and currency vs number) and the generated default grids — refine views to surface the imported columns. Cross-table references resolve only if both tables are in this import or already in the module. Run dforge_module_validate after writing.";

export function moduleImport(
	args: z.infer<z.ZodObject<typeof moduleImportSchema>>,
): ToolResult {
	const manifest = ensureManifest(args.moduleDir, args.module);
	const { files, added } = buildImportFiles(manifest, args.tables);
	return makeResult(
		`Imported ${added.length} entit${added.length === 1 ? "y" : "ies"} (${added.join(", ")}) with inferred field types + FK+Reference pairs; regenerated default views/folders/menus/roles.`,
		files,
		IMPORT_WARNING,
	);
}

// ── DBML front-end ──────────────────────────────────────────────────────────
// Parse the common DBML subset (Table blocks, typed columns with [settings],
// inline [ref: > t.c], and top-level `Ref:` lines) into the table-spec, then
// run the import core. The source PK column is dropped (the identity trait
// provides {entity}_id), and FK targets are remapped to that PK.

export const dbmlImportSchema = {
	moduleDir: z.string().describe("Path to the module dir. If empty, pass `module` to start a new module."),
	dbml: z.string().describe("DBML source text (https://dbml.dbdiagram.io)."),
	module: moduleIdentitySchema.describe("New-module identity — required only when moduleDir has no manifest yet."),
};

/** Normalise a DBML identifier (possibly schema-qualified / CamelCase) to a dForge entity code. */
function snake(name: string): string {
	const base = name.includes(".") ? name.split(".").pop()! : name;
	return base
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.replace(/^([0-9])/, "_$1");
}

interface DbmlTable {
	name: string;
	pk?: string;
	columns: Column[];
	refs: Array<{ column: string; toTable: string; toColumn: string }>;
}

function parseDbmlTableBody(rawName: string, body: string): DbmlTable {
	const t: DbmlTable = { name: snake(rawName), columns: [], refs: [] };
	for (const raw of body.split("\n")) {
		const line = raw.trim();
		if (!line || /^(note|indexes|Note|Indexes)\b/.test(line)) continue;
		const m = line.match(/^"?([A-Za-z_][\w]*)"?\s+"?([A-Za-z_][\w]*(?:\([^)]*\))?)"?\s*(\[[^\]]*\])?/);
		if (!m) continue;
		const colName = snake(m[1]);
		const sqlType = m[2];
		const settings = (m[3] ?? "").toLowerCase();
		const isPk = /\bpk\b|\bprimary key\b/.test(settings);
		const required = /\bnot null\b/.test(settings);
		if (isPk && !t.pk) t.pk = colName;
		const refM = settings.match(/ref\s*:?\s*[<>-]\s*"?([A-Za-z_][\w.]*)"?\.\s*"?([A-Za-z_]\w*)"?/);
		if (refM) t.refs.push({ column: colName, toTable: snake(refM[1]), toColumn: snake(refM[2]) });
		if (!isPk) t.columns.push({ name: colName, sqlType, required });
	}
	return t;
}

export function parseDbml(dbml: string): Table[] {
	const src = dbml.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
	const tables: DbmlTable[] = [];

	const tableRe = /Table\s+"?([\w.]+)"?\s*(?:as\s+\w+\s*)?\{/gi;
	let tm: RegExpExecArray | null;
	while ((tm = tableRe.exec(src))) {
		const start = tableRe.lastIndex;
		let depth = 1;
		let i = start;
		while (i < src.length && depth > 0) {
			if (src[i] === "{") depth++;
			else if (src[i] === "}") depth--;
			i++;
		}
		tables.push(parseDbmlTableBody(tm[1], src.slice(start, i - 1)));
		tableRe.lastIndex = i;
	}

	const byName = new Map(tables.map((t) => [t.name, t]));

	// Top-level Ref lines: `Ref: a.col > b.col` (also `<` and `-`).
	const refRe = /Ref\s*\w*\s*:?\s*"?([\w.]+)"?\.\s*"?(\w+)"?\s*([<>-])\s*"?([\w.]+)"?\.\s*"?(\w+)"?/gi;
	let rm: RegExpExecArray | null;
	while ((rm = refRe.exec(src))) {
		const [, aT, aC, op, bT, bC] = rm;
		const aTable = snake(aT), aCol = snake(aC), bTable = snake(bT), bCol = snake(bC);
		// `>` : left is the FK (many) side; `<` : right is the FK side; `-` : treat left as FK.
		const fkOnLeft = op === ">" || op === "-";
		const fk = fkOnLeft ? { table: aTable, col: aCol, toTable: bTable, toCol: bCol } : { table: bTable, col: bCol, toTable: aTable, toCol: aCol };
		const owner = byName.get(fk.table);
		if (owner && !owner.refs.some((r) => r.column === fk.col)) {
			owner.refs.push({ column: fk.col, toTable: fk.toTable, toColumn: fk.toCol });
		}
	}

	// To table-spec: drop FK columns from regular columns; remap a ref's target
	// to the target entity's identity PK when it points at the source PK.
	return tables.map((t) => {
		const refColNames = new Set(t.refs.map((r) => r.column));
		const references = t.refs.map((r) => {
			const targetPk = byName.get(r.toTable)?.pk;
			const toColumn = targetPk && r.toColumn === targetPk ? undefined : r.toColumn;
			return { column: r.column, toTable: r.toTable, ...(toColumn ? { toColumn } : {}) };
		});
		const columns = t.columns.filter((c) => !refColNames.has(c.name));
		const spec: Table = { name: t.name, columns: columns.length ? columns : [{ name: "name", sqlType: "varchar" }] };
		if (references.length) spec.references = references;
		return spec;
	});
}

export function dbmlImport(
	args: z.infer<z.ZodObject<typeof dbmlImportSchema>>,
): ToolResult {
	const tables = parseDbml(args.dbml);
	if (!tables.length) throw new Error("No `Table` blocks found in the DBML source.");
	const manifest = ensureManifest(args.moduleDir, args.module);
	const { files, added } = buildImportFiles(manifest, tables);
	return makeResult(
		`Parsed ${tables.length} table(s) from DBML and imported ${added.length} as entities (${added.join(", ")}).`,
		files,
		IMPORT_WARNING,
	);
}
