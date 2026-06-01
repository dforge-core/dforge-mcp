// Shared utilities for patch-style MCP tools. Every tool that modifies an
// existing module reads files from disk, mutates JS objects, and returns a
// FileMap of just the files that changed. The MCP client (Claude / Cursor)
// decides whether to write them.
//
// Convention: paths in FileMap are RELATIVE to the module root.

import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";

export type FileMap = Record<string, string>;

export interface ModulePaths {
	root: string;
	manifest: string;
	entitiesDir: string;
	uiDir: string;
	securityDir: string;
	logicDir: string;
	seedDataDir: string;
	translationsDir: string;
	dataViews: string;
	folders: string;
	menus: string;
	actions: string;
	reports: string;
	queries: string;
	roles: string;
	jobs: string;
	triggers: string;
	webhooks: string;
	printTemplates: string;
	settings: string;
}

export function modulePaths(moduleDir: string): ModulePaths {
	const root = path.resolve(moduleDir);
	return {
		root,
		manifest: path.join(root, "manifest.json"),
		entitiesDir: path.join(root, "entities"),
		uiDir: path.join(root, "ui"),
		securityDir: path.join(root, "security"),
		logicDir: path.join(root, "logic"),
		seedDataDir: path.join(root, "seed-data"),
		translationsDir: path.join(root, "translations"),
		dataViews: path.join(root, "ui", "data_views.json"),
		folders: path.join(root, "ui", "folders.json"),
		menus: path.join(root, "ui", "menus.json"),
		actions: path.join(root, "ui", "actions.json"),
		reports: path.join(root, "ui", "reports.json"),
		queries: path.join(root, "ui", "queries.json"),
		printTemplates: path.join(root, "ui", "print_templates.json"),
		roles: path.join(root, "security", "roles.json"),
		jobs: path.join(root, "logic", "jobs.json"),
		triggers: path.join(root, "logic", "triggers.json"),
		webhooks: path.join(root, "logic", "webhooks.json"),
		settings: path.join(root, "settings.json"),
	};
}

export function readJson<T = unknown>(absPath: string): T {
	if (!fs.existsSync(absPath)) {
		throw new Error(`Not found: ${absPath}`);
	}
	try {
		return JSON.parse(fs.readFileSync(absPath, "utf8")) as T;
	} catch (e) {
		throw new Error(`${absPath}: ${(e as Error).message}`);
	}
}

export function readJsonOrDefault<T>(absPath: string, dflt: T): T {
	if (!fs.existsSync(absPath)) return dflt;
	try {
		return JSON.parse(fs.readFileSync(absPath, "utf8")) as T;
	} catch (e) {
		throw new Error(`${absPath}: ${(e as Error).message}`);
	}
}

/**
 * Serialize an object as JSON with tab indentation and trailing newline.
 * Matches the dForge convention (CLAUDE.md), keeps git diffs clean.
 */
export function jsonText(obj: unknown): string {
	return JSON.stringify(obj, null, "\t") + "\n";
}

/** Compose a relative path that a FileMap entry should use. */
export function rel(root: string, abs: string): string {
	return path.relative(root, abs);
}

/**
 * Load a module's manifest. Throws with a clear message if the directory
 * isn't actually a dForge module.
 */
export interface Manifest {
	packageFormat: number;
	moduleId: string;
	code: string;
	version: string;
	dbSchemaVersion: string;
	displayName: string;
	description?: string;
	dependencies?: Record<string, string | { version: string; entities?: string[] }>;
	entities?: Record<string, string>;
	updated?: string;
	[k: string]: unknown;
}

export function loadManifest(moduleDir: string): {
	manifest: Manifest;
	paths: ModulePaths;
} {
	const paths = modulePaths(moduleDir);
	if (!fs.existsSync(paths.manifest)) {
		throw new Error(
			`No manifest.json at ${paths.manifest} — is this a dForge module directory?`,
		);
	}
	const manifest = readJson<Manifest>(paths.manifest);
	if (!manifest.code) {
		throw new Error("manifest.json has no `code` field — corrupt module?");
	}
	return { manifest, paths };
}

/**
 * Standard tool response envelope. `summary` is a one-line human-readable
 * status; `files` are the changed files for the client to write; `warning`
 * surfaces caveats (e.g. "this regenerates X, hand-edits will be lost").
 */
export interface ToolResult {
	summary: string;
	files: FileMap;
	warning?: string;
}

export function makeResult(summary: string, files: FileMap, warning?: string): ToolResult {
	const out: ToolResult = { summary, files };
	if (warning) out.warning = warning;
	return out;
}

/** Bump manifest.updated to today's YYYY-MM-DD. Call this on any patch. */
export function withTodayStamp(manifest: Manifest): Manifest {
	return { ...manifest, updated: new Date().toISOString().slice(0, 10) };
}

/** All field type codes recognised by the dForge platform. */
export const FIELD_TYPE_CODES = [
	"text", "email", "phone", "url", "textarea", "number", "currency", "percent",
	"checkbox", "date", "datetime", "time", "dropdown", "flags", "tags", "json",
	"hidden", "color", "image", "file", "richtext", "lookup", "user", "grid",
	"entitylink", "code",
] as const;

export const fieldTypeCdSchema = z.enum(FIELD_TYPE_CODES);

/** Valid rights letters for entity/action/report rights strings. */
export const RIGHTS_PATTERN = /^[SIUDCE]*$/;

/** Returns the set of entity codes declared in manifest.entities. */
export function getEntityCodes(manifest: Manifest): Set<string> {
	return new Set(Object.keys(manifest.entities ?? {}));
}

/** Returns the set of view codes declared in ui/data_views.json (empty set if file absent). */
export function loadDataViewCodes(paths: ModulePaths): Set<string> {
	if (!fs.existsSync(paths.dataViews)) return new Set();
	try {
		const views = JSON.parse(fs.readFileSync(paths.dataViews, "utf8")) as Record<string, unknown>;
		return new Set(Object.keys(views));
	} catch {
		return new Set();
	}
}

/**
 * Returns true if s is a valid 5-field cron expression.
 * Supports: * | * /n | n | n-m | n-m/s and comma-separated lists of any of the above.
 */
export function isValidCron(s: string): boolean {
	const parts = s.trim().split(/\s+/);
	if (parts.length !== 5) return false;
	const field = /^(\*\/\d+|\d+(-\d+)?(\/\d+)?|\*)(,(\*\/\d+|\d+(-\d+)?(\/\d+)?))*$/;
	return parts.every((p) => field.test(p));
}
