// Field-spec rules, in ONE place.
//
// These rules used to live only inside the zod schema of
// dforge_entity_field_add/_modify — which meant every other way a field can
// enter a module (dforge_module_import, dforge_dbml_import, the CLI
// scaffolder, a hand edit) bypassed them entirely, and the defect only
// surfaced at install. They're pure functions here so BOTH the authoring-time
// zod refinement (errors reject the call) and dforge_module_validate (which
// re-runs them over every field of every entity) share one definition.
//
// Rule of thumb for level: `error` = the platform validator rejects it or the
// column silently misbehaves; `warning` = suspicious but installable.

import { isFieldTypeCd, fieldTypeCds, getColumnType } from "@dforge-core/metadata";

export type IssueLevel = "error" | "warning";

export interface FieldIssue {
	level: IssueLevel;
	message: string;
}

/**
 * Common wrong codes → the real fieldTypeCd, surfaced in the message so the
 * agent self-corrects instead of guessing a second time.
 */
export const FIELD_TYPE_ALIASES: Record<string, string> = {
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
 * Wrong `dbDatatype` values → the real SQL type. `dbDatatype` is the SQL type;
 * `fieldTypeCd` is the UI control. Mixing them is the second-most-common
 * field defect after the FK+Reference split.
 *
 * A value may be a list when the right answer depends on range/precision —
 * `formatSuggestion` renders it, so no entry ever embeds quote characters of
 * its own.
 */
const DB_DATATYPE_ALIASES: Record<string, string | string[]> = {
	boolean: "bool",
	string: "varchar",
	datetime: "timestamptz",
	timestamp: "timestamptz",
	integer: "int",
	number: ["int", "bigint", "numeric"],
	float: "numeric",
	decimal: "numeric",
	double: "numeric",
	uuid: "cuid",
};

/** Quote one suggestion, or a list of them, for an error message. */
function formatSuggestion(fix: string | string[]): string {
	return Array.isArray(fix) ? fix.map((f) => `'${f}'`).join(" / ") : `'${fix}'`;
}

/**
 * Check a single field spec in isolation (no cross-entity context).
 *
 * `where` is only used to build readable messages; pass something like
 * `todo_item.due_date`. Returns [] for a valid field.
 */
export function checkFieldSpec(where: string, field: unknown): FieldIssue[] {
	const issues: FieldIssue[] = [];
	if (!field || typeof field !== "object") {
		return [{ level: "error", message: `${where}: field spec is not an object.` }];
	}
	const v = field as Record<string, unknown>;
	const err = (message: string) => issues.push({ level: "error", message: `${where}: ${message}` });
	const warn = (message: string) =>
		issues.push({ level: "warning", message: `${where}: ${message}` });

	// `defaultValue`/`default` are settings keys, not entity-field keys — the
	// entity schema is additionalProperties:false, so this hard-fails install.
	if (v.defaultValue !== undefined || v.default !== undefined) {
		err(
			"entity fields have no 'defaultValue'/'default' key (settings-only). Set a default with " +
				"'formula' (e.g. \"formula\": \"'draft'\" or \"formula\": \"TODAY()\"), a numberSequence, or DSL logic.",
		);
	}

	// Dropdown options live under params.options, never at the field root.
	if (v.options !== undefined) {
		err(
			"dropdown options go under params.options, not at the field root, e.g. " +
				'"params": { "options": [{ "value": "a", "label": "A" }] }.',
		);
	}

	// Flags letters must be from V/I/E/M/H (no U/S/P).
	if (typeof v.flags === "string" && v.flags.length > 0 && !/^[VIEMH]+$/.test(v.flags)) {
		err(
			`flags '${v.flags}' contains invalid letters — use only V/I/E/M/H (e.g. VEM, VE, V, E). ` +
				"U/S/P are not flag letters.",
		);
	}

	// 'M' resolves to isNullable:false at install, so declaring both is a
	// contradiction — the platform's MandatoryFlagNormalizer rejects it and the
	// whole pack fails. Catch it here, where the author can still see which field.
	if (typeof v.flags === "string" && v.flags.includes("M") && v.isNullable === true) {
		const virtual = typeof v.columnType === "string" && ["R", "S", "F"].includes(v.columnType);
		err(
			`flags '${v.flags}' includes 'M' (mandatory) while "isNullable": true — a contradiction that fails ` +
				"at pack time. 'M' is resolved into isNullable:false at install. Drop 'M' if the column is " +
				`optional, or remove "isNullable": true if it is required.${
					virtual ? " (On a virtual column 'M' is inert anyway — drop it.)" : ""
				}`,
		);
	}

	// fieldTypeCd must be a real code from the platform registry. A hidden FK
	// column legitimately has no fieldTypeCd, so only validate when present.
	if (typeof v.fieldTypeCd === "string" && v.fieldTypeCd.length > 0 && !isFieldTypeCd(v.fieldTypeCd)) {
		const alias = FIELD_TYPE_ALIASES[v.fieldTypeCd.toLowerCase()];
		const hint = alias
			? ` Did you mean '${alias}'?`
			: ` Valid codes: ${[...fieldTypeCds].sort().join(", ")}.`;
		err(
			`fieldTypeCd '${v.fieldTypeCd}' is not a valid field type.${hint} (See dforge://reference/field-types.)`,
		);
	}

	// columnType, when present, must be a known column kind. A plain data column
	// omits it; R/S/F cover reference/set/formula; A/L/G are register columns.
	const columnType = typeof v.columnType === "string" ? v.columnType : "";
	if (columnType.length > 0 && !getColumnType(columnType)) {
		err(
			`columnType '${columnType}' is invalid. Use 'R' (reference), 'S' (set/child list), or ` +
				"'F' (formula) — or omit it for a plain data column. (A/L/G exist for register columns.)",
		);
	}

	// dbDatatype is a SQL type, never a fieldTypeCd.
	if (typeof v.dbDatatype === "string" && v.dbDatatype.length > 0) {
		const base = v.dbDatatype.replace(/\(.*$/, "").trim().toLowerCase();
		const fix = DB_DATATYPE_ALIASES[base];
		if (fix) {
			err(
				`dbDatatype '${v.dbDatatype}' is not a SQL type — use ${formatSuggestion(fix)}. ` +
					"(dbDatatype = SQL type; fieldTypeCd = UI control. See dforge://reference/field-types.)",
			);
		} else if (isFieldTypeCd(base) && base !== "date" && base !== "time" && base !== "text") {
			err(
				`dbDatatype '${v.dbDatatype}' is a fieldTypeCd, not a SQL type. Use a SQL type ` +
					"(bool, varchar, text, int, bigint, numeric, timestamptz, date, time, cuid, json), " +
					"or omit it — it's derived from fieldTypeCd.",
			);
		}
	}

	// ── Formula columns (columnType 'F') ──
	if (columnType === "F") {
		if (typeof v.baseDatatypeCd !== "string" || v.baseDatatypeCd.length === 0) {
			err("formula column (columnType 'F') requires 'baseDatatypeCd'. (See dforge://reference/formulas.)");
		}
		if (v.dbDatatype !== undefined) {
			err(
				"formula column (columnType 'F') must NOT set 'dbDatatype' — it owns no physical column. " +
					"Use 'baseDatatypeCd' instead.",
			);
		}
		if (typeof v.formula !== "string" || v.formula.trim() === "") {
			err("formula column (columnType 'F') requires a non-empty 'formula' expression.");
		}
		if (typeof v.flags === "string" && v.flags !== "V" && /^[VIEMH]+$/.test(v.flags)) {
			warn(
				`formula column has flags '${v.flags}' — a computed column is read-only, expected flags 'V'.`,
			);
		}
	}

	// ── Generated columns (columnType 'G') ──
	// The installer maintains these with a DB trigger, so they DO own a physical
	// column: the inverse of the 'F' rules.
	if (columnType === "G") {
		if (typeof v.formula !== "string" || v.formula.trim() === "") {
			err("generated column (columnType 'G') requires a 'formula' expression.");
		}
		if (typeof v.dbDatatype !== "string" || v.dbDatatype.length === 0) {
			err(
				"generated column (columnType 'G') requires 'dbDatatype' — it's a physical, " +
					"trigger-maintained column. (See dforge://reference/column-types.)",
			);
		}
		if (v.baseDatatypeCd !== undefined) {
			err("generated column (columnType 'G') must NOT set 'baseDatatypeCd' — use 'dbDatatype'.");
		}
	}

	// ── Reference columns (columnType 'R') — the visible half of FK+Reference ──
	if (columnType === "R") {
		const link = v.link as Record<string, unknown> | undefined;
		if (!link || typeof link !== "object") {
			err(
				"reference column (columnType 'R') requires a 'link' object " +
					"{ entity, thisKey, otherKey }. (See dforge://reference/column-types.)",
			);
		} else {
			for (const k of ["entity", "thisKey", "otherKey"] as const) {
				if (typeof link[k] !== "string" || (link[k] as string).length === 0) {
					err(`reference column's link.${k} is missing — link needs { entity, thisKey, otherKey }.`);
				}
			}
			if (link.otherKey === "id") {
				err(
					"link.otherKey is 'id' — the identity trait names the PK '{entity}_id' " +
						`(e.g. '${String(link.entity ?? "target")}_id'), never 'id'.`,
				);
			}
		}
		if (v.fieldTypeCd !== undefined && v.fieldTypeCd !== "lookup") {
			warn(
				`reference column has fieldTypeCd '${String(v.fieldTypeCd)}' — the visible half of an ` +
					"FK+Reference pair is normally 'lookup'.",
			);
		}
		if (v.dbDatatype !== undefined) {
			err(
				"reference column (columnType 'R') must NOT set 'dbDatatype' — the physical column is the " +
					"paired hidden FK (flags 'EM' when required, else 'E'), not this one.",
			);
		}
	}

	return issues;
}

/**
 * True when the field spec is the hidden half of an FK+Reference pair.
 *
 * 'M' is NOT part of the shape: it resolves to isNullable:false at install, so it
 * is present only on a *required* relation. Testing for it here would have made
 * every optional hidden FK ('E') invisible to the rules that key off this.
 */
export function isHiddenFk(field: Record<string, unknown>): boolean {
	return (
		typeof field.flags === "string" &&
		field.flags.includes("E") &&
		!field.flags.includes("V") &&
		field.fieldTypeCd === undefined &&
		field.columnType === undefined
	);
}

/**
 * Parse a set aggregate — `SUM([lines].[amount])` — out of a formula.
 * Returns null when the formula isn't a set aggregate. Used by the validator
 * to check the aggregated child column is PHYSICAL (an 'F'/'R'/'S' child fails
 * install with `column old.<field> does not exist`).
 */
export function parseSetAggregate(
	formula: string,
): { agg: string; setField: string; childField: string } | null {
	const m = formula.match(
		/\b(SUM|COUNT|AVG|MIN|MAX)\s*\(\s*\[([a-z][a-z0-9_]*)\]\s*\.\s*\[([a-z][a-z0-9_]*)\]\s*\)/i,
	);
	if (!m) return null;
	return { agg: m[1].toUpperCase(), setField: m[2], childField: m[3] };
}
