// dforge_translation_sync — generate/refresh translations/<locale>.json from
// what the module actually contains.
//
// Translation completeness is enforced at install: `roles.<code>.label` is
// required for EVERY role in EVERY locale file (including the en-US base), and
// every locale in manifest.supportedLocales must have a file. Hand-maintaining
// that across entity/view/menu churn is exactly the bookkeeping a tool should
// do — and "missing translation key" was a documented install-failure mode with
// no tool behind it.
//
// Non-destructive by contract: an existing translated value is NEVER
// overwritten. Missing keys are seeded with the English source text, so the
// file is immediately installable and the human/agent can translate in place.

import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import { expandTraits } from "@dforge-core/metadata";
import {
	loadManifest,
	readJsonOrDefault,
	jsonText,
	rel,
	makeResult,
	walkFolders,
	duplicateFolderCodes,
	compositeKey,
	assertKnownTraits,
	type ToolResult,
} from "./_helpers";

type Dict = Record<string, unknown>;

/** Turn a snake_case code into a human label: `due_date` → `Due Date`. */
function titleize(code: string): string {
	return code
		.split(/[_-]/)
		.filter(Boolean)
		.map((w) => w[0].toUpperCase() + w.slice(1))
		.join(" ");
}

/** Read `obj[key]` as a non-empty string, or undefined. */
function str(obj: Dict | undefined, key: string): string | undefined {
	const v = obj?.[key];
	return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

export const translationSyncSchema = {
	moduleDir: z.string().describe("Path to the module root."),
	locales: z
		.array(z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/))
		.optional()
		.describe(
			"Locales to sync. Default: 'en-US' plus every entry in manifest.supportedLocales — i.e. exactly the set install requires.",
		),
	prune: z
		.boolean()
		.default(false)
		.describe(
			"Remove keys that no longer correspond to anything in the module (e.g. after an entity delete). Off by default — pruning discards translated text.",
		),
};

interface SkeletonEntry {
	/** Dotted path into the locale JSON, e.g. entities.todo_item.fields.title.label */
	pathParts: string[];
	/** English source text to seed a missing key with. */
	english: string;
	/** True when install FAILS if this key is absent (roles only, today). */
	required: boolean;
}

/** Build the full set of translatable keys from the module's own files. */
function buildSkeleton(moduleDir: string): { entries: SkeletonEntry[]; counts: Record<string, number> } {
	const { paths, manifest } = loadManifest(moduleDir);
	const entries: SkeletonEntry[] = [];
	const counts: Record<string, number> = {};
	const push = (section: string, pathParts: string[], english: string, required = false) => {
		entries.push({ pathParts, english, required });
		counts[section] = (counts[section] ?? 0) + 1;
	};

	// ── entities + fields (including trait-provided columns, which users see) ──
	// An unreadable entity file is FATAL here, not skippable. Skipping it would
	// silently drop that entity's keys from the skeleton, the tool would report
	// success, and the module would then fail install on the missing labels —
	// with nothing pointing back at the real cause.
	for (const [name, relPath] of Object.entries((manifest.entities ?? {}) as Record<string, string>)) {
		if (name.includes(".")) continue; // cross-module extension — foreign module owns it
		const abs = path.join(paths.root, relPath.replace(/^\.\//, ""));
		if (!fs.existsSync(abs)) {
			throw new Error(
				`manifest.entities.${name} points at '${relPath}', which does not exist on disk. ` +
					"Fix the manifest or restore the file — syncing now would silently omit that entity's " +
					"translation keys and the gap would only surface at install.",
			);
		}
		let e: Dict;
		try {
			e = JSON.parse(fs.readFileSync(abs, "utf8")) as Dict;
		} catch (ex) {
			throw new Error(`${relPath} is not valid JSON: ${(ex as Error).message}`);
		}
		push("entities", ["entities", name, "label"], str(e, "description") ?? titleize(name));

		const authored = (e.fields as Record<string, Dict> | undefined) ?? {};
		// Trait-provided columns are user-visible and need labels, so an unknown
		// trait means an incomplete skeleton — and expandTraits would drop it
		// silently rather than complain.
		const traitCodes = (e.traits as string[] | undefined) ?? [];
		assertKnownTraits(traitCodes, name);
		const traitFields = expandTraits(traitCodes, name) as Record<string, Dict>;
		const all = { ...traitFields, ...authored };
		for (const [fname, f] of Object.entries(all)) {
			push(
				"fields",
				["entities", name, "fields", fname, "label"],
				str(f, "description") ?? str(f, "label") ?? titleize(fname),
			);
		}
	}

	// ── views ──
	const views = readJsonOrDefault<Record<string, Dict>>(paths.dataViews, {});
	for (const [code, v] of Object.entries(views)) {
		push("views", ["views", code, "label"], str(v, "label") ?? titleize(code));
	}

	// ── menus (root + nested items, mirroring ui/menus.json) ──
	const menus = readJsonOrDefault<Record<string, Dict>>(paths.menus, {});
	const walkMenu = (node: Dict, trail: string[]): void => {
		const children =
			(node.items as Record<string, Dict> | undefined) ??
			(node.children as Record<string, Dict> | undefined) ??
			{};
		for (const [code, child] of Object.entries(children)) {
			const next = [...trail, "items", code];
			push("menus", [...next, "label"], str(child, "label") ?? titleize(code));
			walkMenu(child, next);
		}
	};
	for (const [code, m] of Object.entries(menus)) {
		push("menus", ["menus", code, "label"], str(m, "label") ?? titleize(code));
		walkMenu(m, ["menus", code]);
	}

	// ── roles — the only completeness-ENFORCED section ──
	const roles = readJsonOrDefault<Record<string, Dict>>(paths.roles, {});
	for (const [code, r] of Object.entries(roles)) {
		push(
			"roles",
			["roles", code, "label"],
			str(r, "description") ?? titleize(code.split(".").pop() ?? code),
			true,
		);
	}

	// ── actions ──
	const actions = readJsonOrDefault<Record<string, Dict>>(paths.actions, {});
	for (const [code, a] of Object.entries(actions)) {
		push("actions", ["actions", code, "label"], str(a, "label") ?? titleize(code));
	}

	// ── folders (root + every nested sub-folder) ──
	// Keys are FLAT folder codes — that's what the platform reads, and it matches
	// how role rights address a folder (`folder:<code>`, no path). Two folders
	// sharing a code would therefore collide here, one label overwriting the
	// other; refuse rather than silently pick a winner. dforge_folder_add and
	// dforge_module_validate enforce the same rule.
	const folders = readJsonOrDefault<Dict>(paths.folders, {});
	if (Object.keys(folders).length > 0) {
		const dupes = duplicateFolderCodes(folders);
		if (dupes.size > 0) {
			const detail = [...dupes]
				.map(([code, paths_]) => `'${code}' (${paths_.join(", ")})`)
				.join("; ");
			throw new Error(
				`ui/folders.json reuses folder code(s) across branches: ${detail}. Translation keys are flat ` +
					"(`folders.<code>.label`), so duplicates would overwrite each other — and role rights " +
					"(`folder:<code>`) can't tell them apart either. Rename them to unique codes, then re-run.",
			);
		}
		// The root folder has no code of its own — it IS the file — so it's keyed
		// on the module code.
		push("folders", ["folders", manifest.code, "label"], str(folders, "label") ?? titleize(manifest.code));
		for (const f of walkFolders(folders)) {
			push("folders", ["folders", f.code, "label"], str(f.node, "label") ?? titleize(f.code));
		}
	}

	// ── settings (completeness-checked for declared locales) ──
	const settings = readJsonOrDefault<Record<string, Dict>>(paths.settings, {});
	for (const [code, s] of Object.entries(settings)) {
		push("settings", ["settings", code, "label"], str(s, "label") ?? titleize(code));
	}

	return { entries, counts };
}

const getIn = (root: Dict, parts: string[]): unknown =>
	parts.reduce<unknown>((acc, p) => (acc && typeof acc === "object" ? (acc as Dict)[p] : undefined), root);

function setIn(root: Dict, parts: string[], value: unknown): void {
	let cursor: Dict = root;
	for (const p of parts.slice(0, -1)) {
		if (!cursor[p] || typeof cursor[p] !== "object") cursor[p] = {};
		cursor = cursor[p] as Dict;
	}
	cursor[parts[parts.length - 1]] = value;
}

/** Drop keys that the skeleton no longer contains, then prune emptied objects. */
function pruneTo(existing: Dict, keep: Set<string>, trail: string[] = []): Dict {
	const out: Dict = {};
	for (const [k, v] of Object.entries(existing)) {
		const parts = [...trail, k];
		if (v && typeof v === "object" && !Array.isArray(v)) {
			const sub = pruneTo(v as Dict, keep, parts);
			if (Object.keys(sub).length > 0) out[k] = sub;
			continue;
		}
		if (keep.has(compositeKey(...parts))) out[k] = v;
	}
	return out;
}

export function translationSync(
	args: z.infer<z.ZodObject<typeof translationSyncSchema>>,
): ToolResult {
	const { paths, manifest } = loadManifest(args.moduleDir);
	const declared = Array.isArray(manifest.supportedLocales)
		? (manifest.supportedLocales as unknown[]).filter((l): l is string => typeof l === "string")
		: [];
	// en-US is the base and is never listed in supportedLocales, but its file is
	// still required — so it's always part of the default set.
	const locales = args.locales ?? ["en-US", ...declared];
	if (locales.length === 0) {
		throw new Error("No locales to sync. Pass `locales`, or declare them in manifest.supportedLocales.");
	}

	const { entries, counts } = buildSkeleton(args.moduleDir);
	if (entries.length === 0) {
		throw new Error(
			"Nothing translatable found — the module has no entities, views, menus, or roles yet. Author them first.",
		);
	}
	const keep = new Set(entries.map((e) => compositeKey(...e.pathParts)));

	const files: Record<string, string> = {};
	const report: string[] = [];
	let totalAdded = 0;
	let missingRequired = 0;

	for (const locale of locales) {
		const abs = path.join(paths.translationsDir, `${locale}.json`);
		let existing: Dict = {};
		if (fs.existsSync(abs)) {
			try {
				existing = JSON.parse(fs.readFileSync(abs, "utf8")) as Dict;
			} catch (e) {
				throw new Error(`translations/${locale}.json is not valid JSON: ${(e as Error).message}`);
			}
		}

		const next: Dict = args.prune ? pruneTo(existing, keep) : JSON.parse(JSON.stringify(existing));
		let added = 0;
		for (const entry of entries) {
			const current = getIn(next, entry.pathParts);
			// Never overwrite existing translated text.
			if (typeof current === "string" && current.trim() !== "") continue;
			setIn(next, entry.pathParts, entry.english);
			added++;
			if (entry.required) missingRequired++;
		}

		files[rel(paths.root, abs)] = jsonText(next);
		totalAdded += added;
		report.push(`${locale}: +${added} key(s)${added === 0 ? " (already complete)" : ""}`);
	}

	const isEnglish = (l: string) => l.toLowerCase() === "en" || l.toLowerCase().startsWith("en-");
	const nonEnglish = locales.filter((l) => !isEnglish(l));
	const warning =
		nonEnglish.length > 0 && totalAdded > 0
			? `Newly-added keys in ${nonEnglish.join(", ")} are seeded with the ENGLISH source text so the file is ` +
				"installable immediately — they still need real translation. (Untranslated values fall back to en-US " +
				"at runtime, so this never breaks; it just shows English.)"
			: undefined;

	const sections = Object.entries(counts)
		.map(([k, v]) => `${v} ${k}`)
		.join(", ");
	return makeResult(
		`Synced ${locales.length} locale file(s) from ${entries.length} translatable keys (${sections}). ` +
			`${report.join("; ")}.${missingRequired > 0 ? ` Filled ${missingRequired} install-blocking role label(s).` : ""}`,
		files,
		warning,
	);
}
