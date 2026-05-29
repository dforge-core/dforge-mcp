// Read the current state of a module from disk and return a structured
// summary so the AI can reason about what exists before deciding what to
// patch. Avoids the AI re-reading every file via its own filesystem tools
// (which fragments context).

import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	loadManifest,
	readJsonOrDefault,
	type ToolResult,
} from "./_helpers";
import { readArtifactsState } from "./artifacts";

export const moduleInspectSchema = {
	moduleDir: z.string(),
};

interface InspectSummary {
	module: {
		code: string;
		displayName: string;
		version: string;
		dependencies: Record<string, unknown>;
		auditHistory?: unknown;
		kind?: unknown;
		tags?: unknown;
	};
	entities: Array<{
		name: string;
		isExtension: boolean;
		traits: string[];
		fieldCount: number;
		fields: string[];
		hasNumberSequence: boolean;
		toString: unknown;
	}>;
	views: Array<{ code: string; viewType: string; sources: string[] }>;
	folders: { tree: Record<string, unknown>; depth: number };
	menus: Array<{ code: string; itemCount: number }>;
	roles: Array<{ code: string; objectCount: number; rights: Record<string, string> }>;
	actions: Array<{ code: string; entity: string; mode: string; background: boolean }>;
	reports: string[];
	settings: string[];
	jobs: string[];
	seedFiles: string[];
	translations: string[];
	artifacts: {
		requirementsAt?: string;
		designAt?: string;
	};
}

export function moduleInspect(
	args: z.infer<z.ZodObject<typeof moduleInspectSchema>>,
): ToolResult {
	const { paths, manifest } = loadManifest(args.moduleDir);

	const entities = (manifest.entities ?? {}) as Record<string, string>;
	const entitySummaries = Object.entries(entities).map(([name, relPath]) => {
		const abs = path.join(paths.root, relPath.replace(/^\.\//, ""));
		const e = readJsonOrDefault<Record<string, unknown>>(abs, {});
		const fields = (e.fields as Record<string, unknown> | undefined) ?? {};
		return {
			name,
			isExtension: Boolean(e.extends),
			traits: (e.traits as string[] | undefined) ?? [],
			fieldCount: Object.keys(fields).length,
			fields: Object.keys(fields),
			hasNumberSequence: Boolean(e.numberSequence),
			toString: e.toString,
		};
	});

	const views = readJsonOrDefault<Record<string, Record<string, unknown>>>(paths.dataViews, {});
	const viewSummaries = Object.entries(views).map(([code, v]) => ({
		code,
		viewType: (v.viewType as string) ?? "?",
		sources: ((v.dataSources as Array<Record<string, unknown>> | undefined) ?? []).map(
			(s) => (s.entityCode as string) ?? "?",
		),
	}));

	const foldersTree = readJsonOrDefault<Record<string, unknown>>(paths.folders, {});
	const folderDepth = computeDepth(foldersTree);

	const menus = readJsonOrDefault<Record<string, Record<string, unknown>>>(paths.menus, {});
	const menuSummaries = Object.entries(menus).map(([code, m]) => ({
		code,
		itemCount: Object.keys((m.items as Record<string, unknown>) ?? {}).length,
	}));

	const rolesJson = readJsonOrDefault<Record<string, Record<string, unknown>>>(paths.roles, {});
	const roleSummaries = Object.entries(rolesJson).map(([code, r]) => {
		const rights = (r.rights as Record<string, string>) ?? {};
		return { code, objectCount: Object.keys(rights).length, rights };
	});

	const actions = readJsonOrDefault<Record<string, Record<string, unknown>>>(paths.actions, {});
	const actionSummaries = Object.entries(actions).map(([code, a]) => ({
		code,
		entity: (a.entity as string) ?? "?",
		mode: (a.mode as string) ?? "single",
		background: Boolean(a.background),
	}));

	const reports = Object.keys(readJsonOrDefault<Record<string, unknown>>(paths.reports, {}));
	const settings = Object.keys(readJsonOrDefault<Record<string, unknown>>(paths.settings, {}));
	const jobs = Object.keys(readJsonOrDefault<Record<string, unknown>>(paths.jobs, {}));

	const seedFiles = fs.existsSync(paths.seedDataDir)
		? fs.readdirSync(paths.seedDataDir).filter((f) => f.endsWith(".json")).sort()
		: [];
	const translations = fs.existsSync(paths.translationsDir)
		? fs.readdirSync(paths.translationsDir).filter((f) => f.endsWith(".json")).sort()
		: [];

	const artifacts = readArtifactsState(paths.root);

	const summary: InspectSummary = {
		module: {
			code: manifest.code,
			displayName: manifest.displayName,
			version: manifest.version,
			dependencies: (manifest.dependencies ?? {}) as Record<string, unknown>,
			auditHistory: manifest.auditHistory,
			kind: manifest.kind,
			tags: manifest.tags,
		},
		entities: entitySummaries,
		views: viewSummaries,
		folders: { tree: foldersTree, depth: folderDepth },
		menus: menuSummaries,
		roles: roleSummaries,
		actions: actionSummaries,
		reports,
		settings,
		jobs,
		seedFiles,
		translations,
		artifacts,
	};

	const artifactWarning = !artifacts.designAt
		? "⚠ No design artifact — call dforge_design_write before dforge_module_create. "
		: "";

	// We return the summary as the `files` map's single "inspect.json"
	// entry — the client doesn't write it; tool responses just use the
	// same file-map shape uniformly. (See server.ts where the tool result
	// is serialized.)
	return {
		summary: `${artifactWarning}Module '${manifest.code}' v${manifest.version}: ${entitySummaries.length} entities, ${viewSummaries.length} views, ${roleSummaries.length} roles, ${actionSummaries.length} actions, ${reports.length} reports.`,
		files: { "_inspect.json": JSON.stringify(summary, null, "\t") + "\n" },
	};
}

function computeDepth(folder: Record<string, unknown>, current = 1): number {
	const children = folder.children as Record<string, unknown> | undefined;
	if (!children) return current;
	const childDepths = Object.values(children).map((c) =>
		computeDepth(c as Record<string, unknown>, current + 1),
	);
	return childDepths.length === 0 ? current : Math.max(...childDepths);
}
