// Entity-file checks: references, entity views, field specs, toString, set aggregates.

import { checkFieldSpec, parseSetAggregate } from "../field-rules";
import type { ValidateContext } from "./context";

// Reference columns + references block.
export function checkReferences(ctx: ValidateContext): void {
	const { err, warn, entities, columnsOf, isKnownEntity, pkOf } = ctx;
	for (const [name, e] of Object.entries(entities)) {
		const fields = (e.fields as Record<string, Record<string, unknown>> | undefined) ?? {};
		for (const [fname, f] of Object.entries(fields)) {
			if (!f || f.columnType !== "R" || !f.link) continue;
			const link = f.link as Record<string, unknown>;
			const where = `entities/${name}.json → ${fname}.link`;
			const target = link.entity as string | undefined;
			if (!target || !isKnownEntity(target)) {
				err(where, `link.entity '${target}' is not a known entity (same-module, system, or cross-module dependency)`);
			}
			const thisKey = link.thisKey as string | undefined;
			if (thisKey && !columnsOf[name].has(thisKey)) {
				err(where, `link.thisKey '${thisKey}' is not a column on '${name}' — the hidden FK column is missing (FK+Reference is two columns)`);
			}
			const pk = target ? pkOf(target) : undefined;
			if (pk && link.otherKey && link.otherKey !== pk) {
				warn(where, `link.otherKey '${link.otherKey}' — expected '${pk}' (the target entity's PK)`);
			}
		}
		const refs = (e.references as Record<string, Record<string, unknown>> | undefined) ?? {};
		for (const [rname, r] of Object.entries(refs)) {
			const fromField = (r?.from as Record<string, unknown> | undefined)?.field as string | undefined;
			if (fromField && !columnsOf[name].has(fromField)) {
				err(`entities/${name}.json → references.${rname}`, `from.field '${fromField}' is not a column on '${name}'`);
			}
			const toEntity = (r?.to as Record<string, unknown> | undefined)?.entity as string | undefined;
			if (toEntity && !isKnownEntity(toEntity)) {
				err(`entities/${name}.json → references.${rname}`, `to.entity '${toEntity}' is not a known entity`);
			}
		}
	}
}

// Entity views (column-level security).
// `views.<v>.columns.<cd>` on an entity file. Mirrors what
// EntityViewRegistrar.ValidateView / NormalizeViewNames reject at install —
// each failure is silent at runtime (a column that isn't there, records the
// client can't address) and only surfaces as "the folder is broken", far from
// the file that caused it. Note: unrelated to ui/data_views.json below, and to
// `isView`/`viewSql` (a SQL-view-backed entity) — the platform overloads "view".
export function checkEntityViews(ctx: ValidateContext): void {
	const { err, entities, columnsOf, fieldDefsOf, pkOf } = ctx;
	for (const [name, e] of Object.entries(entities)) {
		const entityViews = (e.views as Record<string, Record<string, unknown>> | undefined) ?? {};
		if (Object.keys(entityViews).length === 0) continue;

		const fields = fieldDefsOf[name] ?? {};
		const cols = columnsOf[name];
		const pk = pkOf(name);

		// A folder binds a view by name case-insensitively, so two names differing
		// only by case leave the binding ambiguous — the installer refuses both.
		const byLower = new Map<string, string[]>();
		for (const vname of Object.keys(entityViews)) {
			const list = byLower.get(vname.trim().toLowerCase()) ?? [];
			list.push(vname);
			byLower.set(vname.trim().toLowerCase(), list);
		}
		for (const [, spellings] of byLower) {
			if (spellings.length > 1) {
				err(
					`entities/${name}.json → views`,
					`views ${spellings.map((v) => `'${v}'`).join(" and ")} differ only by case or surrounding ` +
						"whitespace. A folder binds a view case-insensitively, so only one could ever be reached.",
				);
			}
		}

		for (const [vname, view] of Object.entries(entityViews)) {
			const where = `entities/${name}.json → views.${vname}`;
			const vcols = (view?.columns as Record<string, unknown> | undefined) ?? undefined;

			if (!vcols || Object.keys(vcols).length === 0) {
				err(
					where,
					"lists no columns. A view is the COMPLETE set of columns visible in a folder bound " +
						"to it, so an empty one would hide every field — the installer rejects it.",
				);
				continue;
			}

			const declared = Object.keys(vcols);
			for (const cd of declared) {
				if (cols && !cols.has(cd)) {
					err(where, `column '${cd}' is not a field on entity '${name}'`);
				}
			}

			// Same column under two spellings: both name one column, and the later
			// one would silently win.
			const dupes = declared.filter(
				(c, i) => declared.findIndex((o) => o.toLowerCase() === c.toLowerCase()) !== i,
			);
			for (const d of dupes) {
				err(where, `lists column '${d}' more than once (differing only by case)`);
			}

			// Records are addressed by the PK — a view without it yields rows the
			// client cannot open or save. Hide it with flags instead (omit 'V').
			if (pk && !declared.some((c) => c.toLowerCase() === pk.toLowerCase())) {
				err(
					where,
					`omits the primary key '${pk}'. A view must list it — records are addressed by it. ` +
						"To keep it off the screen, drop 'V' from its flags instead of omitting it.",
				);
			}

			// A view formula is only evaluated on a Formula ("F") column; elsewhere
			// that field is the SQL default, so the override would be inert.
			for (const [cd, ovRaw] of Object.entries(vcols)) {
				const ov = (ovRaw ?? {}) as Record<string, unknown>;
				if (typeof ov.formula !== "string" || ov.formula.trim() === "") continue;
				const colType = fields[cd]?.columnType;
				if (colType !== "F") {
					err(
						`${where}.columns.${cd}`,
						`sets a formula on a column of type '${(colType as string) ?? "D"}'. A view formula is ` +
							"only evaluated on a Formula (\"F\") column — on any other column that field holds " +
							"the SQL default, and the override would do nothing.",
					);
				}
			}
		}
	}
}

// Field-spec rules, module-wide.
// The same rules the entity_field_add/_modify zod schema enforces, re-run
// over every field of every entity. Fields that entered via module_import /
// dbml_import / the CLI scaffolder / a hand edit never passed through that
// schema, so this is the only place those get checked before install.
export function checkFieldSpecs(ctx: ValidateContext): void {
	const { issues, entities } = ctx;
	for (const [name, e] of Object.entries(entities)) {
		const fields = (e.fields as Record<string, Record<string, unknown>> | undefined) ?? {};
		for (const [fname, f] of Object.entries(fields)) {
			for (const issue of checkFieldSpec(`${name}.${fname}`, f)) {
				issues.push({ level: issue.level, where: `entities/${name}.json`, message: issue.message });
			}
		}
	}
}

// Every entity needs a toString, and its {braces} must resolve.
// The platform renders a record's display label from this template; a
// missing one leaves lookups showing raw PKs. Extension entities inherit
// the base entity's template (toString: null is the documented form).
// NOTE: read it as an OWN property — `toString` is inherited from
// Object.prototype, so `e.toString` is a function, never undefined.
export function checkToString(ctx: ValidateContext): void {
	const { err, warn, entities, columnsOf } = ctx;
	for (const [name, e] of Object.entries(entities)) {
		const isExtension = typeof e.extends === "string" && e.extends.length > 0;
		const ts: unknown = Object.prototype.hasOwnProperty.call(e, "toString")
			? e.toString
			: undefined;
		if (ts === undefined || ts === null || (typeof ts === "string" && ts.trim() === "")) {
			// A missing template degrades display (lookups show raw PKs) but does
			// not block install — warn rather than error.
			if (!isExtension) {
				warn(
					`entities/${name}.json`,
					"has no 'toString' template — every entity should have one, e.g. \"toString\": \"{name}\" (extension entities use null to inherit the base).",
				);
			}
			continue;
		}
		if (typeof ts !== "string") {
			err(`entities/${name}.json`, `'toString' must be a string template, got ${typeof ts}.`);
			continue;
		}
		const braces = [...ts.matchAll(/\{([a-z][a-z0-9_]*)\}/gi)].map((m) => m[1]);
		if (braces.length === 0) {
			warn(
				`entities/${name}.json`,
				`'toString' is "${ts}" with no {column} placeholder — every record will render the same label.`,
			);
		}
		for (const b of braces) {
			if (!columnsOf[name].has(b)) {
				err(
					`entities/${name}.json`,
					`'toString' references {${b}}, which is not a column on '${name}'.`,
				);
			}
		}
	}
}

// Set aggregates: must be Generated, over a PHYSICAL child column.
// Two documented install-blockers in one place. An 'F' set-aggregate is
// unsupported and silently renders empty; a 'G' aggregate over a virtual
// (F/R/S) child fails install with `column old.<field> does not exist`.
export function checkSetAggregates(ctx: ValidateContext): void {
	const { err, warn, entities, fieldDefsOf } = ctx;
	for (const [name, e] of Object.entries(entities)) {
		const fields = (e.fields as Record<string, Record<string, unknown>> | undefined) ?? {};
		for (const [fname, f] of Object.entries(fields)) {
			const formula = typeof f?.formula === "string" ? f.formula : "";
			if (!formula) continue;
			const agg = parseSetAggregate(formula);
			if (!agg) continue;
			const where = `entities/${name}.json → ${fname}`;

			if (f.columnType === "F") {
				err(
					where,
					`is a Formula ('F') column with a set aggregate ${agg.agg}([${agg.setField}].[${agg.childField}]) — ` +
						"an F set-aggregate is unsupported and silently renders empty. Use a Generated ('G') column " +
						"with dbDatatype + formula instead. (See dforge://reference/column-types.)",
				);
				continue;
			}
			if (f.columnType !== "G") continue;

			// Resolve the set column → child entity → aggregated child column.
			const setCol = fields[agg.setField] ?? fieldDefsOf[name]?.[agg.setField];
			if (!setCol) {
				err(where, `aggregates over '[${agg.setField}]', which is not a column on '${name}'.`);
				continue;
			}
			if (setCol.columnType !== "S") {
				warn(
					where,
					`aggregates over '[${agg.setField}]', which is not a set column (columnType 'S') on '${name}'.`,
				);
				continue;
			}
			const childEntity = (setCol.link as Record<string, unknown> | undefined)?.entity as
				| string
				| undefined;
			if (!childEntity) continue;
			const childDefs = fieldDefsOf[childEntity];
			if (!childDefs) continue; // cross-module / system child — can't inspect offline
			const childCol = childDefs[agg.childField];
			if (!childCol) {
				err(
					where,
					`aggregates '[${agg.setField}].[${agg.childField}]' but '${agg.childField}' is not a column on child entity '${childEntity}'.`,
				);
				continue;
			}
			const childType = typeof childCol.columnType === "string" ? childCol.columnType : "D";
			if (childType === "F" || childType === "R" || childType === "S") {
				err(
					where,
					`aggregates '[${agg.setField}].[${agg.childField}]', but '${childEntity}.${agg.childField}' is a ` +
						`virtual '${childType}' column. A Generated aggregate reads the child's PHYSICAL column — install fails ` +
						`with \`column old.${agg.childField} does not exist\`. Aggregate a 'D' (or same-row 'G') child column instead.`,
				);
			}
		}
	}
}
