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
