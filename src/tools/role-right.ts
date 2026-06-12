// Grant or revoke a single right on a single entity/action/report for a
// single role. Cheaper backtrack than rewriting the whole role.

import { z } from "zod";
import {
	loadManifest,
	readJson,
	jsonText,
	rel,
	makeResult,
	withTodayStamp,
	assertValidRightKey,
	assertValidRightValue,
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
			"Object to grant rights on. Same-module entity: bare ('product'). Cross-module entity: dotted ('fin.invoice'). Action/report/folder: COLON prefix ('action:approve', 'report:summary', 'folder:east') — never a dot.",
		),
	rights: z
		.string()
		.describe(
			"Rights string. Entities: any combination of S/I/U/D/C (use '' to revoke all). Actions/reports/folders: 'E' or '' to revoke.",
		),
};

export function roleRightSet(args: z.infer<z.ZodObject<typeof roleRightSetSchema>>): ToolResult {
	assertValidRightKey(args.object);
	assertValidRightValue(args.object, args.rights, true); // "" allowed = revoke
	const { paths, manifest } = loadManifest(args.moduleDir);
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
