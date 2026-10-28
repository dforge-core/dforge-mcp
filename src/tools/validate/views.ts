// ui/data_views.json and ui/menus.json checks.

import { readJsonOrDefault, compositeKey } from "../_helpers";
import type { ValidateContext } from "./context";

// View types whose rendering doesn't consume the entity's visible scalar columns,
// so an empty visible-column set is not an error for them. Mirrors the server's
// DataViewVisibleColumnValidator.ColumnAgnosticViewTypes and the frontend view
// registrations that set hasFieldsPanel:false.
const COLUMN_AGNOSTIC_VIEW_TYPES = new Set(["diagram", "matrix", "library"]);

/**
 * True when a merged field-def map has at least one VISIBLE SCALAR column — a
 * field whose `flags` string includes `'V'` and whose `columnType` is not a set
 * (`'S'`). Mirrors the frontend's `visibleScalarColumns` empty-state check that
 * the server's DataViewVisibleColumnValidator enforces.
 */
function hasVisibleScalarColumn(fields: Record<string, Record<string, unknown>>): boolean {
	for (const f of Object.values(fields)) {
		if (!f || typeof f !== "object") continue;
		const flags = typeof f.flags === "string" ? f.flags : "";
		if (flags.includes("V") && f.columnType !== "S") return true;
	}
	return false;
}
// Data view entity + column references.
export function checkDataViews(ctx: ValidateContext): void {
	const { err, columnsOf, isKnownEntity, views } = ctx;
	for (const [vcode, v] of Object.entries(views)) {
		const sources = (v.dataSources as Array<Record<string, unknown>> | undefined) ?? [];
		for (const s of sources) {
			const ent = s.entityCode as string | undefined;
			if (!ent || !isKnownEntity(ent)) {
				err(`data_views → ${vcode}`, `dataSource entityCode '${ent}' is not a known entity`);
				continue;
			}
			const cols = columnsOf[ent]; // undefined for system entities — can't check their columns
			if (!cols) continue;
			for (const c of (s.columns as Array<Record<string, unknown>> | undefined) ?? []) {
				const cc = c.column_cd as string | undefined;
				if (cc && !cols.has(cc)) {
					err(`data_views → ${vcode}`, `column '${cc}' is not a field on entity '${ent}'`);
				}
			}
		}
	}
}

// Data view renders a field grid over an entity with no visible column.
// Mirrors the server's DataViewVisibleColumnValidator: a grid-style view over
// an own-module entity that has no VISIBLE SCALAR column (a field whose flags
// include 'V' and whose columnType isn't a set 'S') renders the runtime empty
// state "No visible columns configured for this entity." Column-agnostic view
// types (diagram/matrix/library — hasFieldsPanel:false) are exempt. Cross-module
// entities can't be inspected offline, so they're skipped. Erroring here catches
// it before the slow pack/install round trip.
export function checkVisibleColumns(ctx: ValidateContext): void {
	const { err, fieldDefsOf, views } = ctx;
	const vcSeen = new Set<string>();
	for (const [vcode, v] of Object.entries(views)) {
		const sources = (v.dataSources as Array<Record<string, unknown>> | undefined) ?? [];
		if (sources.length === 0) continue;
		// viewType defaults to grid (a checked type) when unset.
		const viewType = (v.viewType as string | undefined) ?? "grid";
		if (COLUMN_AGNOSTIC_VIEW_TYPES.has(viewType)) continue;
		for (const s of sources) {
			const ent = s.entityCode as string | undefined;
			if (!ent) continue;
			const defs = fieldDefsOf[ent]; // undefined for system/cross-module entities — skip
			if (!defs) continue;
			if (hasVisibleScalarColumn(defs)) continue;
			const key = compositeKey(vcode, ent);
			if (vcSeen.has(key)) continue;
			vcSeen.add(key);
			err(
				`data_views → ${vcode}`,
				`view (${viewType}) renders entity '${ent}', which has no visible column — mark at least one of its fields visible with the 'V' flag (set columns / columnType 'S' don't count for a grid)`,
			);
		}
	}
}

// Menu dataViewCode → existing view (deep walk, structure-agnostic).
export function checkMenus(ctx: ValidateContext): void {
	const { paths, err, viewCodes } = ctx;
	const menus = readJsonOrDefault<Record<string, unknown>>(paths.menus, {});
	const walk = (node: unknown, where: string): void => {
		if (!node || typeof node !== "object") return;
		const rec = node as Record<string, unknown>;
		const dvc = rec.dataViewCode;
		if (typeof dvc === "string" && !viewCodes.has(dvc)) {
			err(where, `dataViewCode '${dvc}' has no matching view in data_views.json`);
		}
		for (const [k, child] of Object.entries(rec)) {
			if (child && typeof child === "object") walk(child, `${where} → ${k}`);
		}
	};
	for (const [mcode, m] of Object.entries(menus)) walk(m, `menus → ${mcode}`);
}

// Grid/list grouping defaults in viewConfig. Mirrors the server's
// ViewGroupingValidator, which fails the install: `groupByField` and every
// `groupByOptions` entry name a dropdown, flags, reference or user column,
// `groupByOptions` includes `groupByField`, and `collapsedGroups` needs a valid
// `groupByField` (for a dropdown, its entries are option values). Extension
// entities are skipped, as the server does.
export function checkViewGrouping(ctx: ValidateContext): void {
	const { err, entities, fieldDefsOf, views } = ctx;
	for (const [vcode, v] of Object.entries(views)) {
		const viewType = (v.viewType as string | undefined) ?? "grid";
		if (viewType !== "grid" && viewType !== "list") continue;
		const config = v.viewConfig;
		if (!config || typeof config !== "object" || Array.isArray(config)) continue;
		const cfg = config as Record<string, unknown>;
		const ent = (v.dataSources as Array<Record<string, unknown>> | undefined)?.[0]?.entityCode as string | undefined;
		if (!ent) continue;
		const defs = fieldDefsOf[ent]; // undefined for system/cross-module entities — skip
		if (!defs || entities[ent]?.extends) continue;
		const where = `data_views → ${vcode}`;

		const resolve = (key: string, cd: string): Record<string, unknown> | undefined => {
			const f = defs[cd];
			if (!f) err(where, `names '${cd}' in '${key}', which entity '${ent}' does not define`);
			else if (!isGroupable(f)) err(where, `names '${cd}' in '${key}', which is not a dropdown, reference or user column`);
			else return f;
			return undefined;
		};
		const readStrings = (key: string): string[] | undefined => {
			const val = cfg[key];
			if (!Array.isArray(val)) return undefined;
			const items: string[] = [];
			for (const item of val) {
				if (typeof item === "string") items.push(item);
				else err(where, `has a non-string item in '${key}'`);
			}
			return items;
		};

		const groupBy = typeof cfg.groupByField === "string" ? cfg.groupByField : undefined;
		const groupField = groupBy !== undefined ? resolve("groupByField", groupBy) : undefined;

		const options = readStrings("groupByOptions");
		if (options) {
			for (const cd of options) resolve("groupByOptions", cd);
			if (groupBy !== undefined && !options.includes(groupBy)) {
				err(where, `has 'groupByOptions' without its 'groupByField' '${groupBy}'`);
			}
		}

		const collapsed = readStrings("collapsedGroups");
		if (collapsed) {
			if (!groupField) err(where, "sets 'collapsedGroups' without a valid 'groupByField'");
			else if (isDropdown(groupField)) {
				const values = optionValues(groupField);
				for (const val of collapsed.filter((c) => !values.has(c))) {
					err(where, `lists '${val}' in 'collapsedGroups', which is not an option of '${groupBy}'`);
				}
			}
		}
	}
}

function isDropdown(f: Record<string, unknown>): boolean {
	return f.fieldTypeCd === "dropdown" || f.fieldTypeCd === "flags";
}

function isGroupable(f: Record<string, unknown>): boolean {
	return isDropdown(f) || f.fieldTypeCd === "user" || f.columnType === "R";
}

function optionValues(f: Record<string, unknown>): Set<string> {
	const result = new Set<string>();
	const options = (f.params as Record<string, unknown> | undefined)?.options;
	if (!Array.isArray(options)) return result;
	for (const item of options) {
		const val = item && typeof item === "object" ? (item as Record<string, unknown>).value : item;
		if (typeof val === "string" || typeof val === "number") result.add(String(val));
	}
	return result;
}
