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
		/**
		 * Entity views (column-level security) as `name → column count`. Empty when
		 * the entity declares none, which means every folder shows its full column
		 * set. Distinct from `views` below, which are ui/data_views.json.
		 */
		entityViews: Record<string, number>;
	}>;
	views: Array<{ code: string; viewType: string; sources: string[] }>;
	folders: { tree: Record<string, unknown>; depth: number };
	menus: Array<{ code: string; itemCount: number }>;
	roles: Array<{ code: string; objectCount: number; rights: Record<string, string> }>;
	actions: Array<{
		code: string;
		entityCode: string;
		executionMode: string;
		isAsync: boolean;
		script: string;
	}>;
	triggers: Array<{ code: string; entity: string; event: string; action: string; async: boolean }>;
	webhooks: Array<{ code: string; entity: string; event: string; endpointUrl: string }>;
	reports: string[];
	settings: string[];
	jobs: Array<{ code: string; action: string; schedule: string }>;
	queries: string[];
	printTemplates: string[];
	domains: string[];
	seedFiles: string[];
	translations: string[];
	supportedLocales: string[];
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
			entityViews: Object.fromEntries(
				Object.entries((e.views as Record<string, Record<string, unknown>> | undefined) ?? {}).map(
					([vname, v]) => [vname, Object.keys((v?.columns as Record<string, unknown>) ?? {}).length],
				),
			),
			// Read as an OWN property — `toString` is inherited from
			// Object.prototype, so a plain `e.toString` reports the built-in
			// function (which JSON.stringify then silently drops) for every
			// entity that doesn't declare a template.
			toString: Object.prototype.hasOwnProperty.call(e, "toString") ? e.toString : null,
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

	// Key names MUST match what dforge_action_add writes and what the installer
	// reads (entityCode / executionMode / isAsync / script) — see
	// examples/simple-todo/ui/actions.json. The legacy entity/mode/background
	// fallbacks cover modules authored before the keys were settled.
	const actions = readJsonOrDefault<Record<string, Record<string, unknown>>>(paths.actions, {});
	const actionSummaries = Object.entries(actions).map(([code, a]) => ({
		code,
		entityCode: (a.entityCode as string) ?? (a.entity as string) ?? "?",
		executionMode: (a.executionMode as string) ?? (a.mode as string) ?? "single",
		isAsync: Boolean(a.isAsync ?? a.background),
		script: (a.script as string) ?? code,
	}));

	// triggers.json / webhooks.json are `{ triggers: [...] }` / `{ subscriptions: [...] }`
	// arrays (not code-keyed maps) — see behavior.ts.
	const triggerFile = readJsonOrDefault<{ triggers?: Array<Record<string, unknown>> }>(
		paths.triggers,
		{},
	);
	const triggerSummaries = (triggerFile.triggers ?? []).map((t) => ({
		code: (t.code as string) ?? "?",
		entity: (t.entity as string) ?? "?",
		event: (t.event as string) ?? "?",
		action: (t.action as string) ?? "?",
		async: Boolean(t.async),
	}));

	const webhookFile = readJsonOrDefault<{ subscriptions?: Array<Record<string, unknown>> }>(
		paths.webhooks,
		{},
	);
	const webhookSummaries = (webhookFile.subscriptions ?? []).map((w) => ({
		code: (w.code as string) ?? "?",
		entity: (w.entity as string) ?? "?",
		event: (w.event as string) ?? "?",
		endpointUrl: (w.endpointUrl as string) ?? "?",
	}));

	const reports = Object.keys(readJsonOrDefault<Record<string, unknown>>(paths.reports, {}));
	const settings = Object.keys(readJsonOrDefault<Record<string, unknown>>(paths.settings, {}));
	const jobsFile = readJsonOrDefault<{ jobs?: Array<Record<string, unknown>> }>(paths.jobs, {});
	const jobSummaries = (jobsFile.jobs ?? []).map((j) => ({
		code: (j.code as string) ?? "?",
		action: (j.action as string) ?? "?",
		schedule: (j.schedule as string) ?? "?",
	}));
	const queries = Object.keys(readJsonOrDefault<Record<string, unknown>>(paths.queries, {}));
	const printTemplates = Object.keys(
		readJsonOrDefault<Record<string, unknown>>(paths.printTemplates, {}),
	);
	const domains = Object.keys(readJsonOrDefault<Record<string, unknown>>(paths.domains, {}));

	const seedFiles = fs.existsSync(paths.seedDataDir)
		? fs.readdirSync(paths.seedDataDir).filter((f) => f.endsWith(".json")).sort()
		: [];
	const translations = fs.existsSync(paths.translationsDir)
		? fs.readdirSync(paths.translationsDir).filter((f) => f.endsWith(".json")).sort()
		: [];

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
		triggers: triggerSummaries,
		webhooks: webhookSummaries,
		reports,
		settings,
		jobs: jobSummaries,
		queries,
		printTemplates,
		domains,
		seedFiles,
		translations,
		supportedLocales: Array.isArray(manifest.supportedLocales)
			? (manifest.supportedLocales as unknown[]).filter((l): l is string => typeof l === "string")
			: [],
	};

	// We return the summary as the `files` map's single "inspect.json"
	// entry — the client doesn't write it; tool responses just use the
	// same file-map shape uniformly. (See server.ts where the tool result
	// is serialized.)
	return {
		summary:
			`Module '${manifest.code}' v${manifest.version}: ${entitySummaries.length} entities, ` +
			`${viewSummaries.length} views, ${roleSummaries.length} roles, ${actionSummaries.length} actions, ` +
			`${triggerSummaries.length} triggers, ${jobSummaries.length} jobs, ${reports.length} reports.`,
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
