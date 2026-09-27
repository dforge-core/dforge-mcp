// Shared state for the module_validate checks: the manifest, every same-module
// entity with its trait-expanded column set, the files more than one check
// reads, and the issue sink. Built once by loadContext; each check in this
// directory reads from it and reports through err/warn.

import * as fs from "node:fs";
import * as path from "node:path";
import {
	loadManifest,
	readJsonOrDefault,
	readLocalTraits,
	describeTraitConflict,
	expandedEntity,
	unknownTraits,
	TRAIT_CODES,
	type Manifest,
	type ModulePaths,
} from "../_helpers";

type Level = "error" | "warning";
export interface Issue {
	level: Level;
	where: string;
	message: string;
}

// Platform-provided entities that are valid FK targets but not authored in the
// module. PK column name per entity (mirrors the editor's SYSTEM_ENTITY_FIELDS).
const SYSTEM_ENTITY_PK: Record<string, string> = {
	user: "user_id",
	document: "document_id",
	menu_item: "menu_item_id",
	resource: "resource_id",
};

export interface ValidateContext {
	moduleDir: string;
	paths: ModulePaths;
	manifest: Manifest;
	issues: Issue[];
	err: (where: string, message: string) => void;
	warn: (where: string, message: string) => void;
	/** manifest.entities, including cross-module extension keys. */
	entityMap: Record<string, string>;
	/** Same-module entity files that exist and parse. */
	entities: Record<string, Record<string, unknown>>;
	columnsOf: Record<string, Set<string>>;
	fieldDefsOf: Record<string, Record<string, Record<string, unknown>>>;
	partialColumns: Set<string>;
	deps: Set<string>;
	isKnownEntity: (code: string) => boolean;
	pkOf: (code: string) => string | undefined;
	views: Record<string, Record<string, unknown>>;
	viewCodes: Set<string>;
	roles: Record<string, Record<string, unknown>>;
	actions: Record<string, unknown>;
	reports: Record<string, unknown>;
	supportedLocales: string[];
}

export function loadContext(moduleDir: string): ValidateContext {
	const { paths, manifest } = loadManifest(moduleDir);
	const issues: Issue[] = [];
	const err = (where: string, message: string) => issues.push({ level: "error", where, message });
	const warn = (where: string, message: string) => issues.push({ level: "warning", where, message });

	// ── Load same-module entities + compute each one's valid column set ──
	const entityMap = (manifest.entities ?? {}) as Record<string, string>;
	// Overlaid on the platform traits, exactly as the installer does. An
	// unusable file is reported here rather than swallowed: its traits would go
	// missing and every column they contribute would then read as "not a
	// column" — symptoms instead of the cause. Nothing else checks this file
	// offline; its schema is only validated once the package hits the CLI.
	const { traits: localTraits, error: traitsError } = readLocalTraits(paths.root);
	if (traitsError) {
		err(
			"traits.json",
			`${traitsError} This module's own traits can't be overlaid on the platform ones, so ` +
				"entities using them read as declaring an unknown trait — expect knock-on " +
				"'not a column' errors below.",
		);
	}

	const entities: Record<string, Record<string, unknown>> = {};
	const columnsOf: Record<string, Set<string>> = {};
	// Merged field defs per entity (authored fields override trait-contributed
	// ones on key collision) — mirrors the server running the visible-column
	// check AFTER trait expansion, so a trait's 'V' field counts.
	const fieldDefsOf: Record<string, Record<string, Record<string, unknown>>> = {};
	// Entities whose column set came out a FRAGMENT (an unknown trait dropped
	// its columns). Handing one to the DSL checker turns every legitimate read
	// of a missing column into a false "unknown column", so those entities get
	// no record context at all — the trait error above is the thing to fix.
	const partialColumns = new Set<string>();

	for (const [name, relPath] of Object.entries(entityMap)) {
		if (name.includes(".")) continue; // cross-module extension key — not authored here
		const abs = path.join(paths.root, relPath.replace(/^\.\//, ""));
		if (!fs.existsSync(abs)) {
			err(`manifest.entities.${name}`, `points to '${relPath}' which does not exist on disk`);
			continue;
		}
		let e: Record<string, unknown>;
		try {
			e = JSON.parse(fs.readFileSync(abs, "utf8"));
		} catch (ex) {
			err(`entities/${name}.json`, `invalid JSON: ${(ex as Error).message}`);
			continue;
		}
		entities[name] = e;
		// An unknown trait code is NOT an exception — expandTraits silently
		// returns only the codes it recognized, so the trait's columns just
		// vanish and every later check reads them as "not a column". Flag the
		// cause rather than the symptoms. (The authoring tools validate trait
		// codes via `traitsInput`; this catches imports and hand edits.)
		const traits = (e.traits as string[] | undefined) ?? [];
		const badTraits = unknownTraits(traits, localTraits);
		if (badTraits.length > 0) {
			err(
				`entities/${name}.json`,
				`declares unknown trait(s): ${badTraits.join(", ")}. Valid: ${TRAIT_CODES.join(", ")}. ` +
					"An unrecognized trait is ignored when columns are expanded, so its columns are missing " +
					"from this entity — expect knock-on 'not a column' errors below.",
			);
			partialColumns.add(name);
		}
		// Trait columns and authored ones in one pass, so the column set and the
		// field defs can't disagree (`expandedEntity` puts authored last, so an
		// authored override wins).
		const { columns, fieldDefs, conflicts } = expandedEntity(e, name, localTraits);
		for (const c of conflicts) err(`entities/${name}.json`, describeTraitConflict(c));
		columnsOf[name] = columns;
		fieldDefsOf[name] = fieldDefs;
	}

	// A dotted code (cross-module entity, e.g. 'fin.invoice') is only valid if its
	// module prefix is a declared dependency (or this module's own code). We can't
	// confirm the entity exists in the other module offline, but this catches refs
	// to an undeclared/typo'd module instead of accepting any dotted string.
	const deps = new Set(Object.keys(manifest.dependencies ?? {}));
	const isKnownEntity = (code: string): boolean => {
		if (code in entities || code in SYSTEM_ENTITY_PK) return true;
		const dot = code.indexOf(".");
		if (dot > 0) {
			const mod = code.slice(0, dot);
			return deps.has(mod) || mod === manifest.code;
		}
		return false;
	};
	const pkOf = (code: string): string | undefined => {
		if (code in SYSTEM_ENTITY_PK) return SYSTEM_ENTITY_PK[code];
		const e = entities[code];
		if (e && ((e.traits as string[] | undefined) ?? []).includes("identity")) return `${code}_id`;
		return undefined;
	};

	const views = readJsonOrDefault<Record<string, Record<string, unknown>>>(paths.dataViews, {});
	const supportedLocales = Array.isArray(manifest.supportedLocales)
		? (manifest.supportedLocales as unknown[]).filter((l): l is string => typeof l === "string")
		: [];

	return {
		moduleDir,
		paths,
		manifest,
		issues,
		err,
		warn,
		entityMap,
		entities,
		columnsOf,
		fieldDefsOf,
		partialColumns,
		deps,
		isKnownEntity,
		pkOf,
		views,
		viewCodes: new Set(Object.keys(views)),
		roles: readJsonOrDefault<Record<string, Record<string, unknown>>>(paths.roles, {}),
		actions: readJsonOrDefault<Record<string, unknown>>(paths.actions, {}),
		reports: readJsonOrDefault<Record<string, unknown>>(paths.reports, {}),
		supportedLocales,
	};
}
