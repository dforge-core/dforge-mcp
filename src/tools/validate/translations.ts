// translations/ checks: constraint-message overrides, role-label completeness, DSL messages.

import * as fs from "node:fs";
import * as path from "node:path";
import { extractMessages, parseDsl } from "@dforge-core/metadata/dsl";
import type { ValidateContext } from "./context";

/**
 * Case-insensitively resolve `translations/<locale>.json` — a `de-de.json` file
 * satisfies a `de-DE` supported locale (matching the server's case-insensitive
 * translation lookup). Returns the absolute path, or undefined if none exists.
 */
function resolveTranslationFile(translationsDir: string, locale: string): string | undefined {
	const exact = path.join(translationsDir, `${locale}.json`);
	if (fs.existsSync(exact)) return exact;
	if (!fs.existsSync(translationsDir)) return undefined;
	const want = `${locale}.json`.toLowerCase();
	for (const f of fs.readdirSync(translationsDir)) {
		if (f.toLowerCase() === want) return path.join(translationsDir, f);
	}
	return undefined;
}

/**
 * True when the locale JSON carries a non-empty
 * `entities.<entityCd>.constraints.<constraintCd>.message`.
 */
function hasConstraintOverride(
	root: Record<string, unknown> | null,
	entityCd: string,
	constraintCd: string,
): boolean {
	if (!root || typeof root !== "object") return false;
	const entities = (root as { entities?: unknown }).entities;
	if (!entities || typeof entities !== "object") return false;
	const entity = (entities as Record<string, unknown>)[entityCd];
	if (!entity || typeof entity !== "object") return false;
	const constraints = (entity as { constraints?: unknown }).constraints;
	if (!constraints || typeof constraints !== "object") return false;
	const ck = (constraints as Record<string, unknown>)[constraintCd];
	if (!ck || typeof ck !== "object") return false;
	const msg = (ck as { message?: unknown }).message;
	return typeof msg === "string" && msg.trim() !== "";
}
// Constraint messages lacking a translation for a declared locale.
// Mirrors the server's install-time UntranslatedConstraint scan (opt-in on
// supportedLocales; the base message is always the fallback, so this is a
// warning, never an error). English is authoritative and never warned;
// extension entities are skipped (their translations belong with the foreign
// module). Surfacing it here catches the gap before the slow install round trip.
export function checkConstraintTranslations(ctx: ValidateContext): void {
	const { paths, warn, entities, supportedLocales } = ctx;
	if (supportedLocales.length > 0) {
		// (entity, constraint, base message) for every constraint that declares one.
		const declared: Array<{ entity: string; constraint: string; message: string }> = [];
		for (const [name, e] of Object.entries(entities)) {
			// Extension entities add constraints to another module's entity; the
			// translation for those lives with the foreign module's files.
			if (typeof e.extends === "string" && e.extends) continue;
			const constraints = e.constraints as Record<string, unknown> | undefined;
			if (!constraints || typeof constraints !== "object") continue;
			for (const [cname, c] of Object.entries(constraints)) {
				if (!c || typeof c !== "object") continue;
				const msg = (c as Record<string, unknown>).message;
				if (typeof msg === "string" && msg.trim() !== "") {
					declared.push({ entity: name, constraint: cname, message: msg });
				}
			}
		}

		if (declared.length > 0) {
			const seen = new Set<string>();
			for (const raw of supportedLocales) {
				const locale = raw.trim();
				if (!locale) continue;
				// English is the base/fallback — translation files are non-English only.
				const lc = locale.toLowerCase();
				if (lc === "en" || lc.startsWith("en-")) continue;
				if (seen.has(lc)) continue;
				seen.add(lc);

				// Resolve the locale file case-insensitively (a de-de.json satisfies
				// a de-DE locale). Absent or malformed → every override is missing.
				let tx: Record<string, unknown> | null = null;
				const abs = resolveTranslationFile(paths.translationsDir, locale);
				if (abs) {
					try {
						tx = JSON.parse(fs.readFileSync(abs, "utf8")) as Record<string, unknown>;
					} catch {
						tx = null;
					}
				}

				for (const d of declared) {
					if (!hasConstraintOverride(tx, d.entity, d.constraint)) {
						warn(
							`translations/${locale}.json`,
							`constraint message '${d.entity}.constraints.${d.constraint}.message' has no ${locale} override — the base message ("${d.message}") will be used as the fallback. Add entities.${d.entity}.constraints.${d.constraint}.message to localize it.`,
						);
					}
				}
			}
		}
	}
}

// Translation completeness.
// `TranslationCompletenessValidator` requires a `roles.<code>.label` for
// EVERY role in security/roles.json, in EVERY translation file — including
// the en-US base. A missing one fails install with `Label for role '<code>'.`
// Also: every locale in supportedLocales must have a matching file.
export function checkTranslationCompleteness(ctx: ValidateContext): void {
	const { paths, err, warn, roles, supportedLocales } = ctx;
	const roleCodes = Object.keys(roles);
	const localeFiles = fs.existsSync(paths.translationsDir)
		? fs
				.readdirSync(paths.translationsDir)
				.filter((f) => f.toLowerCase().endsWith(".json"))
				.sort()
		: [];

	for (const raw of supportedLocales) {
		const locale = raw.trim();
		if (!locale) continue;
		if (!resolveTranslationFile(paths.translationsDir, locale)) {
			err(
				"translations",
				`manifest.supportedLocales lists '${locale}' but translations/${locale}.json does not exist — install fails translation completeness validation.`,
			);
		}
	}

	if (roleCodes.length > 0 && localeFiles.length === 0) {
		warn(
			"translations",
			`no translations/ files — ship at least translations/en-US.json with a roles block (a 'label' for each of: ${roleCodes.join(", ")}); role labels are completeness-enforced at install.`,
		);
	}

	for (const file of localeFiles) {
		let tx: Record<string, unknown>;
		try {
			tx = JSON.parse(fs.readFileSync(path.join(paths.translationsDir, file), "utf8"));
		} catch (ex) {
			err(`translations/${file}`, `invalid JSON: ${(ex as Error).message}`);
			continue;
		}
		const txRoles = (tx.roles as Record<string, unknown> | undefined) ?? {};
		const missing = roleCodes.filter((rc) => {
			const entry = txRoles[rc] as Record<string, unknown> | undefined;
			return !entry || typeof entry.label !== "string" || entry.label.trim() === "";
		});
		if (missing.length > 0) {
			err(
				`translations/${file}`,
				`missing roles.<code>.label for: ${missing.join(", ")} — completeness is enforced in every locale (including en-US); install fails with "Label for role '<code>'."`,
			);
		}
	}
}

const isEnglishLocale = (l: string) => l.toLowerCase() === "en" || l.toLowerCase().startsWith("en-");

function readLocaleFile(translationsDir: string, locale: string): Record<string, unknown> | null {
	const abs = resolveTranslationFile(translationsDir, locale);
	if (!abs) return null;
	try {
		return JSON.parse(fs.readFileSync(abs, "utf8")) as Record<string, unknown>;
	} catch {
		return null;
	}
}

function messagesBlock(root: Record<string, unknown> | null): Record<string, string> {
	const block = root?.messages;
	if (!block || typeof block !== "object" || Array.isArray(block)) return {};
	return Object.fromEntries(
		Object.entries(block).filter((e): e is [string, string] => typeof e[1] === "string" && e[1].trim() !== ""),
	);
}

/**
 * Each non-English locale in supportedLocales → its `messages` block (`{}` when
 * the file or the block is absent). Undefined for a module declaring no locales:
 * the DSL checker's untranslated / concatenated rules then stand down, as the
 * install-time scan does.
 */
export function readMessageTranslations(
	translationsDir: string,
	supportedLocales: unknown,
): Record<string, Record<string, string>> | undefined {
	const declared = Array.isArray(supportedLocales)
		? supportedLocales.filter((l): l is string => typeof l === "string")
		: [];
	const locales = [...new Set(declared.map((l) => l.trim()).filter((l) => l && !isEnglishLocale(l)))];
	if (locales.length === 0) return undefined;
	return Object.fromEntries(locales.map((l) => [l, messagesBlock(readLocaleFile(translationsDir, l))]));
}

/**
 * The fixed message texts of every action script (text → first script using it),
 * in source order. A script is `script` or, as the installer defaults it, the action code.
 */
export function actionMessageTexts(logicDir: string, actions: Record<string, unknown>): Map<string, string> {
	const texts = new Map<string, string>();
	for (const [code, def] of Object.entries(actions)) {
		const declared = (def as Record<string, unknown> | undefined)?.script;
		const script = typeof declared === "string" && declared ? declared : code;
		const file = path.join(logicDir, "actions", `${script}.dsl`);
		if (!fs.existsSync(file)) continue;
		let body: string;
		try {
			body = fs.readFileSync(file, "utf8");
		} catch {
			continue;
		}
		for (const m of extractMessages(parseDsl(body))) {
			if (m.text !== undefined && !texts.has(m.text)) texts.set(m.text, `logic/actions/${script}.dsl`);
		}
	}
	return texts;
}

const placeholdersOf = (text: string) =>
	new Set([...text.matchAll(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g)].map((m) => m[1]!));

// `messages` entries that no script uses, and translations that add a placeholder
// the English text lacks. Mirrors the install-time ActionMessageScanner; the
// per-script rules (untranslated, joined text) run in checkActionDsl.
export function checkMessageTranslations(ctx: ValidateContext): void {
	const { paths, warn } = ctx;
	if (!fs.existsSync(paths.translationsDir)) return;
	let texts: Map<string, string> | undefined;
	for (const f of fs.readdirSync(paths.translationsDir).filter((f) => f.toLowerCase().endsWith(".json")).sort()) {
		const locale = f.slice(0, -".json".length);
		const block = messagesBlock(readLocaleFile(paths.translationsDir, locale));
		if (Object.keys(block).length === 0) continue;
		if (isEnglishLocale(locale)) {
			warn(`translations/${f}`, "has a `messages` block, which install ignores: English is the text in the .dsl scripts.");
			continue;
		}
		texts ??= actionMessageTexts(paths.logicDir, ctx.actions);
		for (const [text, translation] of Object.entries(block)) {
			if (!texts.has(text)) {
				warn(
					`translations/${f}`,
					`messages entry "${text}" matches no info/warn/error/exit text in the action scripts — it never shows. ` +
						"The key must be the exact English text; an edit to the .dsl wording leaves the old entry behind.",
				);
				continue;
			}
			const known = placeholdersOf(text);
			for (const ph of placeholdersOf(translation)) {
				if (!known.has(ph))
					warn(`translations/${f}`, `messages entry "${text}": the translation uses {${ph}}, which the English text has no value for — it shows as written.`);
			}
		}
	}
}
