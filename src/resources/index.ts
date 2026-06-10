import * as fs from "node:fs";
import * as path from "node:path";

// Resources are vendored at build time into ../../resources/ (sibling to
// src/), then shipped in the npm tarball via package.json `files`. At
// runtime, walk relative to __dirname (which is dist/ in the published
// package) up to the package root.

const RESOURCES_DIR = path.resolve(__dirname, "..", "resources");

// The authoring references + worked example live in the skill directory,
// which ships in the npm tarball (package.json `files` includes "skills/").
// Exposing them as dforge:// resources gives the agent stable URIs it can
// pull regardless of its working directory — unlike filesystem paths in the
// skill prompt, which don't resolve from a module-build CWD.
const SKILL_DIR = path.resolve(__dirname, "..", "skills", "dforge-mcp-author");

export interface ResourceDef {
	uri: string;
	name: string;
	description: string;
	mimeType: string;
	read: () => string;
}

// Schema resource registry. URI / file naming intentionally mirrors the
// source filenames in dForge-core/docs/schemas/ (snake_case → kebab-case)
// so anyone hopping between the two repos can map them at a glance.
//
// The same files are served publicly by jsdelivr (see
// scripts/vendor-resources.sh comment), and the dforge-cli scaffolder
// wires those URLs into .vscode/.zed settings — so changes here have a
// ripple effect: rename a schema and you have to bump dforge-cli too.
function schema(name: string, label: string, description: string): ResourceDef {
	return {
		uri: `dforge://schema/${name}`,
		name: label,
		description,
		mimeType: "application/schema+json",
		read: () => readVendored(`schemas/${name}.schema.json`),
	};
}

// A per-element authoring reference (skills/.../references/<name>.md). Carries
// the schema shape, a worked example, and the common-mistakes list for one
// element type — the agent's primary source before authoring that element.
function reference(name: string, description: string): ResourceDef {
	return {
		uri: `dforge://reference/${name}`,
		name: `Reference: ${name}`,
		description,
		mimeType: "text/markdown",
		read: () => readSkill(`references/${name}.md`),
	};
}

// A file from the canonical simple-todo example module. These are the
// mandatory structure validators — copy their shapes, don't invent.
function example(relPath: string, description: string): ResourceDef {
	return {
		uri: `dforge://example/${relPath}`,
		name: `Example: ${relPath}`,
		description,
		mimeType: relPath.endsWith(".json") ? "application/json" : "text/plain",
		read: () => readSkill(`examples/simple-todo/${relPath}`),
	};
}

export const resources: ResourceDef[] = [
	schema(
		"manifest",
		"Module manifest JSON schema",
		"JSON Schema for manifest.json. Consult before emitting manifest content — covers required fields, semver patterns, and the entities map.",
	),
	schema(
		"entity",
		"Entity JSON schema",
		"JSON Schema for entity files under entities/*.json (description, dbObject, toString, traits, fields).",
	),
	schema(
		"data-views",
		"Data view JSON schema",
		"JSON Schema for ui/data_views.json — the map of viewName → { viewType, label, dataSources, ... }.",
	),
	schema(
		"folders",
		"Folders JSON schema",
		"JSON Schema for ui/folders.json — root folder tree with per-entity view bindings.",
	),
	schema(
		"menus",
		"Menus JSON schema",
		"JSON Schema for ui/menus.json — nested menu hierarchy with M.it/M.sub style items.",
	),
	schema(
		"roles",
		"Roles JSON schema",
		"JSON Schema for security/roles.json — rights strings (SIUDC / E) per role per entity.",
	),
	schema(
		"jobs",
		"Scheduled jobs JSON schema",
		"JSON Schema for logic/jobs.json — cron + action binding for the scheduler.",
	),
	schema(
		"seed-data",
		"Seed data JSON schema",
		"JSON Schema for seed-data/*.json — initial rows inserted at install time.",
	),
	schema(
		"traits",
		"Entity traits JSON schema",
		"JSON Schema describing the inheritable trait set (identity, audit, audit-full, soft-delete, sorting, postable, accumulation, ledger, period).",
	),
	schema(
		"webhooks",
		"Webhooks JSON schema",
		"JSON Schema for logic/webhooks.json — outbound webhook subscriptions: entity + event filter → POST to endpointUrl with selected fields.",
	),
	schema(
		"triggers",
		"Triggers JSON schema",
		"JSON Schema for logic/triggers.json — intra-tenant DB-event → action invocation: entity + event + optional condition formula → fires an action (sync or async).",
	),
	schema(
		"print-templates",
		"Print templates JSON schema",
		"JSON Schema for ui/print_templates.json — Liquid HTML print templates and reusable snippets, bound to entities for the print menu.",
	),
	schema(
		"settings",
		"Module settings JSON schema",
		"JSON Schema for settings.json — flat map of setting code → { fieldTypeCd, baseDatatypeCd?, label/description, defaultValue, params, formula?, required? }.",
	),
	schema(
		"reports",
		"Reports JSON schema",
		"JSON Schema for ui/reports.json — map of report code → { description, layout.panels[], datasets, parameters? }. Datasets and panel queries reuse the filter shape from data_views.",
	),
	{
		uri: "dforge://docs/conventions",
		name: "dForge module conventions",
		description:
			"Markdown summary of module structure, field types, view conventions, " +
			"and security model. Reference this before creating non-trivial modules.",
		mimeType: "text/markdown",
		read: () => readVendored("docs/conventions.md"),
	},
	{
		uri: "dforge://docs/dsl",
		name: "dForge action DSL reference",
		description:
			"Full reference for the dForge action DSL (logic/actions/*.dsl files): block structure (params/canExecute/onBeforeStart/execute), execution modes (single/each/batch), field-access syntax ([field], params[name], [ref].[field], records.*), all 30 built-in host functions (query/insert/error/exit/now/sendEmail/...), supported JS subset (ES5 via Esprima/Jint), common patterns, and pitfalls. **Load this before authoring any DSL action (Phase 2 of the wizard).**",
		mimeType: "text/markdown",
		read: () => readVendored("docs/dsl-reference.md"),
	},

	// ── Per-element authoring references (skills/.../references/*.md) ──────
	reference("field-types", "Field types — fieldTypeCd (UI control) vs dbDatatype (SQL type), and the correct value for each. Load before adding any field."),
	reference("flags", "Column flags — only V/I/E/M/H; valid combos (VEM/VE/V/EM/I) and why 'VEMHI' is invalid. Load before setting any flags."),
	reference("column-types", "The FK + Reference two-column pattern (the #1 source of broken modules) and Set columns. Load before any relation."),
	reference("formulas", "Formula columns (columnType 'F'): baseDatatypeCd, no dbDatatype, flags 'V', and the formula expression grammar."),
	reference("traits", "Entity traits (identity, audit, audit-full, ...). identity → PK is '{entity}_id'; don't redefine trait columns."),
	reference("data-views", "Data views: dataSources array, columns, the order string-array ('order': ['-col','col']), and specialized view configs."),
	reference("menus", "Menus: leaf items use dataViewCode; section nodes omit itemType; icons are Bootstrap names WITHOUT the bi- prefix."),
	reference("action-dsl", "Action DSL grammar + 'Registering the action' (ui/actions.json: entityCode/executionMode/script/isAsync/bi- icon)."),
	reference("filters", "Canonical filter shape for views, folders, and reports."),
	reference("security", "Security roles + rights matrix: 'rights' key, SIUDC for entities, E for actions/reports/folders."),
	reference("reports", "Reports: layout panels + datasets (Query or Stored Procedure)."),
	reference("settings", "Module settings shape."),
	reference("jobs", "Scheduled jobs: cron, timeout, jobClass, and the no-record-context constraint."),
	reference("number-sequences", "Number sequences for reference numbers / codes."),
	reference("print-templates", "Liquid HTML print templates."),
	reference("translations", "Translation files: locale-keyed, every trait-provided field needs an entry."),
	reference("queries", "Pre-built saved queries."),
	reference("schema-import", "Importing entities from DBML/SQL."),
	reference("data-migration", "Migrating data from a legacy database."),
	reference("manifest", "manifest.json shape: moduleId UUID, semver, entities map, locale-keyed translations, security block."),
	reference("validation-checklist", "Final pre-pack self-review checklist covering every file type."),

	// ── Canonical example module (skills/.../examples/simple-todo) ────────
	example("manifest.json", "Canonical manifest.json."),
	example("entities/todo_item.json", "Canonical entity: traits, flags (VEM/VE), dropdown options as {value,label}, FK+Reference pattern (otherKey = '{entity}_id'), references block, toString uses a business field."),
	example("entities/todo_list.json", "Canonical parent/lookup entity."),
	example("ui/actions.json", "Canonical ui/actions.json: label/description/icon('bi-...')/entityCode/executionMode/script(bare)/isAsync."),
	example("ui/data_views.json", "Canonical data views: dataSources array + order string-array."),
	example("ui/menus.json", "Canonical menus: dataViewCode leaves, bi-less icons."),
	example("security/roles.json", "Canonical roles: rights with SIUDC / E."),
	example("seed-data/01-lists.json", "Canonical seed data: PK key is '{entity}_id' (not 'id'), parent-before-child via numeric prefix."),
	example("logic/actions/mark_done.dsl", "Canonical action DSL body (params/canExecute/execute)."),
];

function readVendored(rel: string): string {
	const p = path.join(RESOURCES_DIR, rel);
	if (!fs.existsSync(p)) {
		return `// Resource missing at build time: ${rel}\n// Run scripts/vendor-resources.sh in dforge-mcp to refresh from dForge-core.`;
	}
	return fs.readFileSync(p, "utf8");
}

function readSkill(rel: string): string {
	const p = path.join(SKILL_DIR, rel);
	if (!fs.existsSync(p)) {
		return `// Skill resource missing: ${rel}\n// Expected under skills/dforge-mcp-author/ — check the package 'files' list.`;
	}
	return fs.readFileSync(p, "utf8");
}
