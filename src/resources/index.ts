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

export const resources: ResourceDef[] = [
	{
		uri: "dforge://schema/manifest",
		name: "Module manifest JSON schema",
		description:
			"JSON Schema for manifest.json. The LLM should consult this before " +
			"emitting manifest content to make sure required fields, patterns, " +
			"and types are correct.",
		mimeType: "application/schema+json",
		read: () => readVendored("schemas/manifest.schema.json"),
	},
	{
		uri: "dforge://schema/entity",
		name: "Entity JSON schema",
		description:
			"JSON Schema for entity files under entities/*.json.",
		mimeType: "application/schema+json",
		read: () => readVendored("schemas/entity.schema.json"),
	},
	{
		uri: "dforge://schema/data-view",
		name: "Data view JSON schema",
		description:
			"JSON Schema for entries in ui/data_views.json.",
		mimeType: "application/schema+json",
		read: () => readVendored("schemas/data-view.schema.json"),
	},
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
