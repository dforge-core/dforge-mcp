import * as fs from "node:fs";
import * as path from "node:path";

// Resources are vendored at build time into ../../resources/ (sibling to
// src/), then shipped in the npm tarball via package.json `files`. At
// runtime, walk relative to __dirname (which is dist/ in the published
// package) up to the package root.

const RESOURCES_DIR = path.resolve(__dirname, "..", "resources");

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
		"JSON Schema for ui/webhooks.json — outbound webhook definitions.",
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
];

function readVendored(rel: string): string {
	const p = path.join(RESOURCES_DIR, rel);
	if (!fs.existsSync(p)) {
		return `// Resource missing at build time: ${rel}\n// Run scripts/vendor-resources.sh in dforge-mcp to refresh from dForge-core.`;
	}
	return fs.readFileSync(p, "utf8");
}
