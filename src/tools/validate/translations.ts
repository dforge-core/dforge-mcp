// translations/ checks: constraint-message overrides, role-label completeness.

import * as fs from "node:fs";
import * as path from "node:path";
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
