// Refactor-safe modify operations. Unlike the additive entity_field_* tools,
// these PROPAGATE a change to every place that references the renamed thing, so
// the agent doesn't leave dangling references (which dforge_module_validate
// would then flag and the agent would have to chase by hand).
//
// entity_field_rename: rename a field and update —
//   • the field key (order-preserving)
//   • the paired Reference column's link.thisKey + references.*.from.field
//   • same-entity formula columns referencing [oldName]
//   • data views: dataSources[].columns[].column_cd and order[] entries
//   • seed-data files whose entityCode matches (record keys, order-preserving)
//   • OTHER entities' FKs that target this field (link.otherKey / references.to.field)

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
	type ToolResult,
} from "./_helpers";

const code = z.string().regex(/^[a-z][a-z0-9_]*$/);

export const entityFieldRenameSchema = {
	moduleDir: z.string().describe("Path to the module root."),
	entityName: code.describe("Entity that owns the field."),
	fieldName: code.describe("Current field code."),
	newName: code.describe("New field code."),
};

/** Rebuild an object with one key renamed, preserving insertion order. */
function renameKey<T>(obj: Record<string, T>, oldK: string, newK: string): Record<string, T> {
	const out: Record<string, T> = {};
	for (const [k, v] of Object.entries(obj)) out[k === oldK ? newK : k] = v;
	return out;
}

export function entityFieldRename(
	args: z.infer<z.ZodObject<typeof entityFieldRenameSchema>>,
): ToolResult {
	const { entityName, fieldName: oldName, newName } = args;
	if (oldName === newName) throw new Error("newName must differ from fieldName.");

	const { paths, manifest } = loadManifest(args.moduleDir);
	const entityRel = (manifest.entities ?? {})[entityName];
	if (!entityRel) throw new Error(`Entity '${entityName}' is not in the manifest.`);
	const entityPath = path.join(paths.root, entityRel.replace(/^\.\//, ""));
	const entity = readJson<Record<string, unknown>>(entityPath);
	const fields = (entity.fields as Record<string, Record<string, unknown>> | undefined) ?? {};
	if (!(oldName in fields)) throw new Error(`Field '${oldName}' not found on entity '${entityName}'.`);
	if (newName in fields) throw new Error(`Field '${newName}' already exists on entity '${entityName}'. Pick another name.`);

	const changes: string[] = [];
	const files: Record<string, string> = {};

	// 1. Rename the field key (order-preserving).
	entity.fields = renameKey(fields, oldName, newName);
	changes.push(`field '${oldName}' → '${newName}'`);

	// 2. Same-entity: paired Reference's thisKey + formula refs. Use literal
	// bracket-token string ops (not a shared /g/ regex, whose lastIndex would
	// carry across .test() calls and skip later formulas). Field names are
	// [a-z0-9_] so the token is unambiguous.
	const oldToken = `[${oldName}]`;
	const newToken = `[${newName}]`;
	for (const [fname, f] of Object.entries(entity.fields as Record<string, Record<string, unknown>>)) {
		const link = f.link as Record<string, unknown> | undefined;
		if (link && link.thisKey === oldName) {
			link.thisKey = newName;
			changes.push(`${fname}.link.thisKey`);
		}
		if (typeof f.formula === "string" && f.formula.includes(oldToken)) {
			f.formula = f.formula.split(oldToken).join(newToken);
			changes.push(`formula in ${fname}`);
		}
	}
	// references block: from.field on this entity.
	const refs = (entity.references as Record<string, Record<string, unknown>> | undefined) ?? {};
	for (const [rname, r] of Object.entries(refs)) {
		const from = r.from as Record<string, unknown> | undefined;
		if (from && from.field === oldName) {
			from.field = newName;
			changes.push(`references.${rname}.from.field`);
		}
	}
	files[rel(paths.root, entityPath)] = jsonText(entity);

	// 3. OTHER entities whose FK targets this field (otherKey / references.to.field).
	for (const [oname, orel] of Object.entries(manifest.entities ?? {})) {
		if (oname === entityName || oname.includes(".")) continue;
		const op = path.join(paths.root, (orel as string).replace(/^\.\//, ""));
		if (!fs.existsSync(op)) continue;
		const oe = readJson<Record<string, unknown>>(op);
		let touched = false;
		for (const [fn, f] of Object.entries((oe.fields as Record<string, Record<string, unknown>> | undefined) ?? {})) {
			const link = f.link as Record<string, unknown> | undefined;
			if (link && link.entity === entityName && link.otherKey === oldName) {
				link.otherKey = newName;
				touched = true;
				changes.push(`${oname}.${fn}.link.otherKey`);
			}
		}
		for (const [rn, r] of Object.entries((oe.references as Record<string, Record<string, unknown>> | undefined) ?? {})) {
			const to = r.to as Record<string, unknown> | undefined;
			if (to && to.entity === entityName && to.field === oldName) {
				to.field = newName;
				touched = true;
				changes.push(`${oname}.references.${rn}.to.field`);
			}
		}
		if (touched) files[rel(paths.root, op)] = jsonText(oe);
	}

	// 4. Data views: column_cd + order entries on this entity's dataSources.
	const views = readJsonOrDefault<Record<string, Record<string, unknown>>>(paths.dataViews, {});
	let viewsTouched = false;
	for (const v of Object.values(views)) {
		for (const s of (v.dataSources as Array<Record<string, unknown>> | undefined) ?? []) {
			if (s.entityCode !== entityName) continue;
			for (const c of (s.columns as Array<Record<string, unknown>> | undefined) ?? []) {
				if (c.column_cd === oldName) {
					c.column_cd = newName;
					viewsTouched = true;
				}
			}
			if (Array.isArray(s.order)) {
				s.order = (s.order as string[]).map((o) => {
					if (o === oldName) { viewsTouched = true; return newName; }
					if (o === "-" + oldName) { viewsTouched = true; return "-" + newName; }
					return o;
				});
			}
		}
	}
	if (viewsTouched) {
		files[rel(paths.root, paths.dataViews)] = jsonText(views);
		changes.push("data_views.json (columns/order)");
	}

	// 5. Seed-data files for this entity (record keys, order-preserving).
	if (fs.existsSync(paths.seedDataDir)) {
		for (const file of fs.readdirSync(paths.seedDataDir).filter((f) => f.endsWith(".json"))) {
			const fp = path.join(paths.seedDataDir, file);
			let data: Record<string, unknown>;
			try {
				data = JSON.parse(fs.readFileSync(fp, "utf8"));
			} catch {
				continue;
			}
			if (data?.entityCode !== entityName || !Array.isArray(data.records)) continue;
			let touched = false;
			data.records = (data.records as Array<Record<string, unknown>>).map((rec) => {
				if (rec && typeof rec === "object" && oldName in rec) {
					touched = true;
					return renameKey(rec, oldName, newName);
				}
				return rec;
			});
			if (touched) {
				files[rel(paths.root, fp)] = jsonText(data);
				changes.push(`seed-data/${file}`);
			}
		}
	}

	files["manifest.json"] = jsonText(withTodayStamp(manifest));

	return makeResult(
		`Renamed '${entityName}.${oldName}' → '${newName}', propagated to ${changes.length} location(s): ${changes.join("; ")}.`,
		files,
		"Review the returned files before writing — this rewrites every file that referenced the field. Run dforge_module_validate after writing to confirm no references were missed.",
	);
}

// ── entity_field_remove (cascade) ───────────────────────────────────────────
// Removes a field AND cleans up the safe cascade: paired Reference column when
// removing its hidden FK, the references entry, view columns + order, and
// seed-data keys. Formula refs and cross-entity FKs are surfaced as warnings
// (not auto-deleted — those are the user's judgement call).

export const entityFieldRemoveSchema = {
	moduleDir: z.string().describe("Path to the module root."),
	entityName: code.describe("Entity that owns the field."),
	fieldName: code.describe("Field code to remove."),
};

export function entityFieldRemove(
	args: z.infer<z.ZodObject<typeof entityFieldRemoveSchema>>,
): ToolResult {
	const { entityName, fieldName } = args;
	const { paths, manifest } = loadManifest(args.moduleDir);
	const entityRel = (manifest.entities ?? {})[entityName];
	if (!entityRel) throw new Error(`Entity '${entityName}' is not in the manifest.`);
	const entityPath = path.join(paths.root, entityRel.replace(/^\.\//, ""));
	const entity = readJson<Record<string, unknown>>(entityPath);
	const fields = (entity.fields as Record<string, Record<string, unknown>> | undefined) ?? {};
	if (!(fieldName in fields)) throw new Error(`Field '${fieldName}' not found on entity '${entityName}'.`);

	const removed = new Set<string>([fieldName]);
	const changes: string[] = [];
	const warnings: string[] = [];
	const files: Record<string, string> = {};

	// Removing a hidden FK that a Reference column depends on → remove that Reference too.
	for (const [fn, f] of Object.entries(fields)) {
		const link = f.link as Record<string, unknown> | undefined;
		if (fn !== fieldName && link && link.thisKey === fieldName) {
			removed.add(fn);
			changes.push(`paired reference column '${fn}'`);
		}
	}

	const newFields: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(fields)) if (!removed.has(k)) newFields[k] = v;
	entity.fields = newFields;
	changes.push(`field '${fieldName}'`);

	// references entries whose from.field was removed.
	const refs = (entity.references as Record<string, Record<string, unknown>> | undefined) ?? {};
	for (const [rn, r] of Object.entries(refs)) {
		const from = r.from as Record<string, unknown> | undefined;
		if (from && removed.has(from.field as string)) {
			delete refs[rn];
			changes.push(`references.${rn}`);
		}
	}
	files[rel(paths.root, entityPath)] = jsonText(entity);

	// Formula columns (still present) that reference a removed field → warn.
	for (const [fn, f] of Object.entries(entity.fields as Record<string, Record<string, unknown>>)) {
		if (typeof f.formula !== "string") continue;
		for (const r of removed) {
			if (f.formula.includes(`[${r}]`)) {
				warnings.push(`formula in '${fn}' still references removed '[${r}]'`);
			}
		}
	}

	// Views: drop columns + order entries for removed fields on this entity.
	const views = readJsonOrDefault<Record<string, Record<string, unknown>>>(paths.dataViews, {});
	let viewsTouched = false;
	for (const v of Object.values(views)) {
		for (const s of (v.dataSources as Array<Record<string, unknown>> | undefined) ?? []) {
			if (s.entityCode !== entityName) continue;
			if (Array.isArray(s.columns)) {
				const cols = s.columns as Array<Record<string, unknown>>;
				const filtered = cols.filter((c) => !removed.has(c.column_cd as string));
				if (filtered.length !== cols.length) {
					s.columns = filtered;
					viewsTouched = true;
				}
			}
			if (Array.isArray(s.order)) {
				const ord = s.order as string[];
				const filtered = ord.filter((o) => !removed.has(o.replace(/^-/, "")));
				if (filtered.length !== ord.length) {
					s.order = filtered;
					viewsTouched = true;
				}
			}
		}
	}
	if (viewsTouched) {
		files[rel(paths.root, paths.dataViews)] = jsonText(views);
		changes.push("data_views.json (columns/order)");
	}

	// Seed-data: drop removed keys from this entity's records.
	if (fs.existsSync(paths.seedDataDir)) {
		for (const file of fs.readdirSync(paths.seedDataDir).filter((f) => f.endsWith(".json"))) {
			const fp = path.join(paths.seedDataDir, file);
			let data: Record<string, unknown>;
			try {
				data = JSON.parse(fs.readFileSync(fp, "utf8"));
			} catch {
				continue;
			}
			if (data?.entityCode !== entityName || !Array.isArray(data.records)) continue;
			let touched = false;
			data.records = (data.records as Array<Record<string, unknown>>).map((rec) => {
				const out: Record<string, unknown> = {};
				let changed = false;
				for (const [k, val] of Object.entries(rec)) {
					if (removed.has(k)) changed = true;
					else out[k] = val;
				}
				if (changed) touched = true;
				return changed ? out : rec;
			});
			if (touched) {
				files[rel(paths.root, fp)] = jsonText(data);
				changes.push(`seed-data/${file}`);
			}
		}
	}

	// Cross-entity FKs targeting a removed field → warn (don't touch other modules' columns).
	for (const [oname, orel] of Object.entries(manifest.entities ?? {})) {
		if (oname === entityName || oname.includes(".")) continue;
		const op = path.join(paths.root, (orel as string).replace(/^\.\//, ""));
		if (!fs.existsSync(op)) continue;
		let oe: Record<string, unknown>;
		try {
			oe = readJson<Record<string, unknown>>(op);
		} catch {
			continue;
		}
		for (const [fn, f] of Object.entries((oe.fields as Record<string, Record<string, unknown>> | undefined) ?? {})) {
			const link = f.link as Record<string, unknown> | undefined;
			if (link && link.entity === entityName && removed.has(link.otherKey as string)) {
				warnings.push(`'${oname}.${fn}' references removed '${entityName}.${link.otherKey}' — its FK now dangles`);
			}
		}
	}

	files["manifest.json"] = jsonText(withTodayStamp(manifest));

	const warnText = [
		warnings.length ? `Manual follow-up: ${warnings.join("; ")}.` : "",
		"Run dforge_module_validate after writing to confirm nothing dangles.",
	].filter(Boolean).join(" ");

	return makeResult(
		`Removed '${entityName}.${fieldName}'${removed.size > 1 ? ` (+${removed.size - 1} paired column)` : ""}; cascade-cleaned ${changes.length} location(s).`,
		files,
		warnText,
	);
}

// ── entity_rename (with PK + reference cascade) ─────────────────────────────
// Renames an entity code and propagates: the manifest key + file (old deleted),
// the identity PK {old}_id → {new}_id wherever an FK targets it, and every
// reference to the entity code — other entities' link.entity / references.to,
// view entityCode, role rights keys, action entity, folder bindings, and
// seed-data entityCode + PK keys. Reports/translations/menus/DSL are warned, not
// rewritten.

const SYSTEM_ENTITIES = new Set(["user", "document", "menu_item", "resource"]);

export const entityRenameSchema = {
	moduleDir: z.string().describe("Path to the module root."),
	entityName: code.describe("Current entity code."),
	newName: code.describe("New entity code."),
};

export function entityRename(
	args: z.infer<z.ZodObject<typeof entityRenameSchema>>,
): ToolResult {
	const { entityName: oldE, newName: newE } = args;
	if (oldE === newE) throw new Error("newName must differ from entityName.");
	if (SYSTEM_ENTITIES.has(newE)) throw new Error(`'${newE}' is a reserved system entity name.`);

	const { paths, manifest } = loadManifest(args.moduleDir);
	const entityMap = (manifest.entities ?? {}) as Record<string, string>;
	if (!(oldE in entityMap)) throw new Error(`Entity '${oldE}' is not in the manifest.`);
	if (newE in entityMap) throw new Error(`Entity '${newE}' already exists in this module.`);

	const files: Record<string, string> = {};
	const deletes: string[] = [];
	const changes: string[] = [];

	const oldPath = path.join(paths.root, entityMap[oldE].replace(/^\.\//, ""));
	const entity = readJson<Record<string, unknown>>(oldPath);
	const usesIdentity = ((entity.traits as string[] | undefined) ?? []).includes("identity");
	const oldPk = `${oldE}_id`;
	const newPk = `${newE}_id`;

	if (entity.dbObject === oldE) {
		entity.dbObject = newE;
		changes.push("entity.dbObject");
	}

	// Move the entity file: write new path, delete old.
	const newPath = path.join(paths.root, "entities", `${newE}.json`);
	files[rel(paths.root, newPath)] = jsonText(entity);
	deletes.push(rel(paths.root, oldPath));
	changes.push(`entity file → entities/${newE}.json`);

	// Manifest entities map: rename key + path (order-preserving).
	manifest.entities = renameKey(entityMap, oldE, newE);
	(manifest.entities as Record<string, string>)[newE] = `./entities/${newE}.json`;

	// Other entities: link.entity / references.to.entity (+ PK in otherKey/to.field).
	for (const [oname, orel] of Object.entries(entityMap)) {
		if (oname === oldE || oname.includes(".")) continue;
		const op = path.join(paths.root, orel.replace(/^\.\//, ""));
		if (!fs.existsSync(op)) continue;
		const oe = readJson<Record<string, unknown>>(op);
		let touched = false;
		for (const [fn, f] of Object.entries((oe.fields as Record<string, Record<string, unknown>> | undefined) ?? {})) {
			const link = f.link as Record<string, unknown> | undefined;
			if (link && link.entity === oldE) {
				link.entity = newE;
				touched = true;
				changes.push(`${oname}.${fn}.link.entity`);
				if (usesIdentity && link.otherKey === oldPk) link.otherKey = newPk;
			}
		}
		for (const [rn, r] of Object.entries((oe.references as Record<string, Record<string, unknown>> | undefined) ?? {})) {
			const to = r.to as Record<string, unknown> | undefined;
			if (to && to.entity === oldE) {
				to.entity = newE;
				touched = true;
				changes.push(`${oname}.references.${rn}.to.entity`);
				if (usesIdentity && to.field === oldPk) to.field = newPk;
			}
		}
		if (touched) files[rel(paths.root, op)] = jsonText(oe);
	}

	// Views: dataSources[].entityCode.
	const views = readJsonOrDefault<Record<string, Record<string, unknown>>>(paths.dataViews, {});
	let viewsTouched = false;
	for (const v of Object.values(views)) {
		for (const s of (v.dataSources as Array<Record<string, unknown>> | undefined) ?? []) {
			if (s.entityCode === oldE) {
				s.entityCode = newE;
				viewsTouched = true;
			}
		}
	}
	if (viewsTouched) {
		files[rel(paths.root, paths.dataViews)] = jsonText(views);
		changes.push("data_views.json (entityCode)");
	}

	// Roles: rights keys equal to the entity code.
	const roles = readJsonOrDefault<Record<string, Record<string, unknown>>>(paths.roles, {});
	let rolesTouched = false;
	for (const r of Object.values(roles)) {
		const rights = r.rights as Record<string, string> | undefined;
		if (rights && oldE in rights) {
			r.rights = renameKey(rights, oldE, newE);
			rolesTouched = true;
		}
	}
	if (rolesTouched) {
		files[rel(paths.root, paths.roles)] = jsonText(roles);
		changes.push("roles.json (rights keys)");
	}

	// Actions: entity / entityCode.
	const actions = readJsonOrDefault<Record<string, Record<string, unknown>>>(paths.actions, {});
	let actionsTouched = false;
	for (const a of Object.values(actions)) {
		if (a.entity === oldE) { a.entity = newE; actionsTouched = true; }
		if (a.entityCode === oldE) { a.entityCode = newE; actionsTouched = true; }
	}
	if (actionsTouched) {
		files[rel(paths.root, paths.actions)] = jsonText(actions);
		changes.push("actions.json (entity)");
	}

	// Folders: per-entity bindings keyed by entity code (recursive).
	const folders = readJsonOrDefault<Record<string, unknown>>(paths.folders, {});
	let foldersTouched = false;
	const walkFolders = (node: unknown): void => {
		if (!node || typeof node !== "object") return;
		const rec = node as Record<string, unknown>;
		const ents = rec.entities as Record<string, unknown> | undefined;
		if (ents && oldE in ents) {
			rec.entities = renameKey(ents, oldE, newE);
			foldersTouched = true;
		}
		const children = rec.children as Record<string, unknown> | undefined;
		if (children) for (const c of Object.values(children)) walkFolders(c);
	};
	walkFolders(folders);
	if (foldersTouched) {
		files[rel(paths.root, paths.folders)] = jsonText(folders);
		changes.push("folders.json (entity bindings)");
	}

	// Seed-data: entityCode + PK key.
	if (fs.existsSync(paths.seedDataDir)) {
		for (const file of fs.readdirSync(paths.seedDataDir).filter((f) => f.endsWith(".json"))) {
			const fp = path.join(paths.seedDataDir, file);
			let data: Record<string, unknown>;
			try {
				data = JSON.parse(fs.readFileSync(fp, "utf8"));
			} catch {
				continue;
			}
			if (data?.entityCode !== oldE) continue;
			data.entityCode = newE;
			if (usesIdentity && Array.isArray(data.records)) {
				data.records = (data.records as Array<Record<string, unknown>>).map((r) => (oldPk in r ? renameKey(r, oldPk, newPk) : r));
			}
			files[rel(paths.root, fp)] = jsonText(data);
			changes.push(`seed-data/${file}`);
		}
	}

	files["manifest.json"] = jsonText(withTodayStamp(manifest));

	return makeResult(
		`Renamed entity '${oldE}' → '${newE}'${usesIdentity ? ` (PK ${oldPk} → ${newPk})` : ""}; propagated to ${changes.length} location(s). Old entity file deleted.`,
		files,
		`Reports datasets, translation files, menu labels, and DSL bodies are NOT rewritten — check anything referencing '${oldE}'. Run dforge_module_validate after writing.`,
		deletes,
	);
}

// ── entity_delete (with reference cleanup) ──────────────────────────────────
// Deletes an entity: drops the file + manifest entry + its seed files, removes
// role rights keys + folder bindings + data-view sources (deleting a view left
// with no source). Cross-entity FKs targeting it, actions on it, and menus that
// pointed at a removed view are surfaced as warnings — the user decides.

export const entityDeleteSchema = {
	moduleDir: z.string().describe("Path to the module root."),
	entityName: code.describe("Entity code to delete."),
};

export function entityDelete(
	args: z.infer<z.ZodObject<typeof entityDeleteSchema>>,
): ToolResult {
	const { entityName: target } = args;
	const { paths, manifest } = loadManifest(args.moduleDir);
	const entityMap = (manifest.entities ?? {}) as Record<string, string>;
	if (!(target in entityMap)) throw new Error(`Entity '${target}' is not in the manifest.`);

	const files: Record<string, string> = {};
	const deletes: string[] = [];
	const changes: string[] = [];
	const warnings: string[] = [];

	const ePath = path.join(paths.root, entityMap[target].replace(/^\.\//, ""));
	if (fs.existsSync(ePath)) deletes.push(rel(paths.root, ePath));

	const { [target]: _dropped, ...restEntities } = entityMap;
	void _dropped;
	manifest.entities = restEntities;
	changes.push("manifest.entities entry");

	// Cross-entity FKs targeting it → warn (don't silently mangle other entities).
	for (const [oname, orel] of Object.entries(entityMap)) {
		if (oname === target || oname.includes(".")) continue;
		const op = path.join(paths.root, orel.replace(/^\.\//, ""));
		if (!fs.existsSync(op)) continue;
		let oe: Record<string, unknown>;
		try {
			oe = readJson<Record<string, unknown>>(op);
		} catch {
			continue;
		}
		for (const [fn, f] of Object.entries((oe.fields as Record<string, Record<string, unknown>> | undefined) ?? {})) {
			const link = f.link as Record<string, unknown> | undefined;
			if (link && link.entity === target) {
				warnings.push(`'${oname}.${fn}' references deleted entity '${target}' — remove or repoint it`);
			}
		}
	}

	// Roles: drop rights key.
	const roles = readJsonOrDefault<Record<string, Record<string, unknown>>>(paths.roles, {});
	let rolesTouched = false;
	for (const r of Object.values(roles)) {
		const rights = r.rights as Record<string, string> | undefined;
		if (rights && target in rights) {
			delete rights[target];
			rolesTouched = true;
		}
	}
	if (rolesTouched) {
		files[rel(paths.root, paths.roles)] = jsonText(roles);
		changes.push("roles.json (rights key)");
	}

	// Folders: drop binding (recursive).
	const folders = readJsonOrDefault<Record<string, unknown>>(paths.folders, {});
	let foldersTouched = false;
	const walkFolders = (node: unknown): void => {
		if (!node || typeof node !== "object") return;
		const rec = node as Record<string, unknown>;
		const ents = rec.entities as Record<string, unknown> | undefined;
		if (ents && target in ents) {
			delete ents[target];
			foldersTouched = true;
		}
		const children = rec.children as Record<string, unknown> | undefined;
		if (children) for (const c of Object.values(children)) walkFolders(c);
	};
	walkFolders(folders);
	if (foldersTouched) {
		files[rel(paths.root, paths.folders)] = jsonText(folders);
		changes.push("folders.json (binding)");
	}

	// Views: drop sources referencing it; delete a view left with no source.
	const views = readJsonOrDefault<Record<string, Record<string, unknown>>>(paths.dataViews, {});
	let viewsTouched = false;
	const removedViews: string[] = [];
	for (const [vcode, v] of Object.entries(views)) {
		const ds = v.dataSources as Array<Record<string, unknown>> | undefined;
		if (!Array.isArray(ds)) continue;
		const filtered = ds.filter((s) => s.entityCode !== target);
		if (filtered.length === ds.length) continue;
		viewsTouched = true;
		if (filtered.length === 0) {
			delete views[vcode];
			removedViews.push(vcode);
		} else {
			v.dataSources = filtered;
		}
	}
	if (viewsTouched) {
		files[rel(paths.root, paths.dataViews)] = jsonText(views);
		changes.push("data_views.json (sources)");
	}
	if (removedViews.length) {
		warnings.push(`deleted view(s) ${removedViews.join(", ")} (no sources left) — check menus pointing at them`);
	}

	// Actions on it → warn.
	const actions = readJsonOrDefault<Record<string, Record<string, unknown>>>(paths.actions, {});
	for (const [acode, a] of Object.entries(actions)) {
		if (a.entity === target || a.entityCode === target) {
			warnings.push(`action '${acode}' targets deleted entity '${target}'`);
		}
	}

	// Seed files for it → delete.
	if (fs.existsSync(paths.seedDataDir)) {
		for (const file of fs.readdirSync(paths.seedDataDir).filter((f) => f.endsWith(".json"))) {
			const fp = path.join(paths.seedDataDir, file);
			let data: Record<string, unknown>;
			try {
				data = JSON.parse(fs.readFileSync(fp, "utf8"));
			} catch {
				continue;
			}
			if (data?.entityCode === target) {
				deletes.push(rel(paths.root, fp));
				changes.push(`seed-data/${file}`);
			}
		}
	}

	files["manifest.json"] = jsonText(withTodayStamp(manifest));

	const warnText = [
		warnings.length ? `Manual follow-up: ${warnings.join("; ")}.` : "",
		"Run dforge_module_validate after writing.",
	].filter(Boolean).join(" ");

	return makeResult(
		`Deleted entity '${target}'; cleaned ${changes.length} artifact(s)${deletes.length > 1 ? `, removed ${deletes.length} file(s)` : ""}.`,
		files,
		warnText,
		deletes,
	);
}
