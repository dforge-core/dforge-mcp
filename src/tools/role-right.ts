// Grant or revoke a single right on a single entity/action/report for a
// single role. Cheaper backtrack than rewriting the whole role.

import { z } from "zod";
import {
	loadManifest,
	readJson,
	readJsonOrDefault,
	jsonText,
	rel,
	makeResult,
	withTodayStamp,
	getEntityCodes,
	RIGHTS_PATTERN,
	type ToolResult,
} from "./_helpers";

export const roleRightSetSchema = {
	moduleDir: z.string(),
	roleCode: z
		.string()
		.describe("Role code as it appears in security/roles.json (e.g. 'crm.admin')."),
	object: z
		.string()
		.describe(
			"Entity / action / report code to grant rights on. For cross-module rights, use dotted form ('fin.invoice').",
		),
	rights: z
		.string()
		.regex(RIGHTS_PATTERN, "Rights must contain only S, I, U, D, C, E (or '' to revoke all).")
		.describe(
			"Rights string. Entities: any combination of S/I/U/D/C (use '' to revoke all). Actions/reports: 'E' or ''.",
		),
};

export function roleRightSet(args: z.infer<z.ZodObject<typeof roleRightSetSchema>>): ToolResult {
	const { paths, manifest } = loadManifest(args.moduleDir);

	// For unqualified (non-dotted) object codes, verify the entity exists locally.
	// Dotted codes (e.g. 'fin.invoice') reference dependency entities — skip those.
	if (!args.object.includes(".")) {
		const entityCodes = getEntityCodes(manifest);
		const actionsJson = readJsonOrDefault<Record<string, unknown>>(paths.actions, {});
		const actionCodes = new Set(Object.keys(actionsJson));
		if (!entityCodes.has(args.object) && !actionCodes.has(args.object)) {
			throw new Error(
				`Object '${args.object}' not found — it is not an entity or action in this module. Use dotted form for cross-module references (e.g. 'admin.user').`,
			);
		}
	}

	const roles = readJson<Record<string, Record<string, unknown>>>(paths.roles);
	const role = roles[args.roleCode];
	if (!role) {
		throw new Error(
			`Role '${args.roleCode}' not found in security/roles.json. Use role_add to create it.`,
		);
	}
	const rights = (role.rights as Record<string, string> | undefined) ?? {};

	if (args.rights === "") {
		// Revoke: delete the key entirely so the role no longer mentions this object.
		const { [args.object]: _gone, ...rest } = rights;
		void _gone;
		role.rights = rest;
	} else {
		role.rights = { ...rights, [args.object]: args.rights };
	}

	return makeResult(
		args.rights === ""
			? `Revoked all rights on '${args.object}' from role '${args.roleCode}'.`
			: `Set rights on '${args.object}' for role '${args.roleCode}' to '${args.rights}'.`,
		{
			[rel(paths.root, paths.roles)]: jsonText(roles),
			"manifest.json": jsonText(withTodayStamp(manifest)),
		},
	);
}
