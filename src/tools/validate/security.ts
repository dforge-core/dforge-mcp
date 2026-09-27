// security/roles.json checks: rights keyed on real objects, Select coverage.

import * as fs from "node:fs";
import { readJsonOrDefault, checkSecurityCoverage } from "../_helpers";
import type { ValidateContext } from "./context";

// Role rights keyed on real objects.
export function checkRoleRights(ctx: ValidateContext): void {
	const { paths, manifest, err, deps, isKnownEntity, roles, actions, reports } = ctx;
	const storedProcedures = readJsonOrDefault<Record<string, unknown>>(paths.storedProcedures, {});
	// report: and sp: may be qualified 'module.code'; only a foreign module's objects are out of sight.
	// Codes are [a-z][a-z0-9_]* (no dots), so the single dot is unambiguous — a
	// malformed ref is reported as such rather than as a phantom module or object.
	const checkObjectKey = (rcode: string, key: string, kind: string, own: Record<string, unknown>, absFile: string, file: string): void => {
		const ref = key.slice(kind.length + 1);
		const noun = kind === "sp" ? "stored procedure" : "report";
		if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)?$/.test(ref)) {
			err(`roles → ${rcode}`, `malformed rights key '${key}' — expected '${kind}:code' or '${kind}:module.code', each part matching [a-z][a-z0-9_]*`);
			return;
		}
		const dot = ref.indexOf(".");
		const mod = dot < 0 ? manifest.code : ref.slice(0, dot);
		const code = dot < 0 ? ref : ref.slice(dot + 1);
		if (mod !== manifest.code) {
			if (!deps.has(mod)) err(`roles → ${rcode}`, `grants on '${key}' but '${mod}' is not a declared dependency`);
		} else if (!fs.existsSync(absFile)) {
			err(`roles → ${rcode}`, `grants on '${key}' but ${file} is missing — declare the ${noun} there`);
		} else if (!(code in own)) {
			err(`roles → ${rcode}`, `grants on '${key}' but no such ${noun} exists in ${file}`);
		}
	};
	for (const [rcode, r] of Object.entries(roles)) {
		const rights = (r.rights as Record<string, string> | undefined) ?? {};
		for (const key of Object.keys(rights)) {
			if (key.startsWith("action:")) {
				const a = key.slice("action:".length);
				if (!(a in actions)) err(`roles → ${rcode}`, `grants on 'action:${a}' but no such action exists`);
			} else if (key.startsWith("report:")) {
				checkObjectKey(rcode, key, "report", reports, paths.reports, "ui/reports.json");
			} else if (key.startsWith("sp:")) {
				checkObjectKey(rcode, key, "sp", storedProcedures, paths.storedProcedures, "logic/stored_procedures.json");
			} else if (key.startsWith("folder:")) {
				// folder existence lives in folders.json's tree — skip (soft)
			} else if (!isKnownEntity(key)) {
				// An entity rights key: same-module, a system entity (user, document,
				// …), or a declared cross-module dependency. Reuse the same resolver
				// as FK targets so system/cross-module grants don't false-error.
				err(`roles → ${rcode}`, `grants rights on '${key}', which is not a known entity (same-module, system, or a declared cross-module dependency)`);
			}
		}
	}
}

// Security coverage (every entity needs a Select grant).
export function checkSelectCoverage(ctx: ValidateContext): void {
	const { moduleDir, warn } = ctx;
	try {
		const { uncoveredEntities } = checkSecurityCoverage(moduleDir);
		for (const e of uncoveredEntities) {
			warn("security", `entity '${e}' has no role granting Select (S) — it will be inaccessible`);
		}
	} catch {
		/* roles file unreadable — checkRoleRights reports on it */
	}
}
