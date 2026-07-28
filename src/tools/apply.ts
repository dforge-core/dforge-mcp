// Opt-in write mode.
//
// Every patch tool returns a file map for the CLIENT to write, so the agent can
// preview a diff before committing. That's the right default for design
// documents and for anything the user reviews — but for a routine one-field
// patch it means the entire entity JSON round-trips through the model's context
// on every call, and it makes "the agent applied `files` but forgot `deletes`"
// a live failure mode that the refactor tools can't defend against.
//
// `apply: true` writes the map to disk here and returns the PATHS instead of
// the contents. Same tool, same validation, no preview.

import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import type { ToolResult } from "./_helpers";

/**
 * Shared schema fragment. Spread into a patch tool's schema object so MCP
 * advertises the flag on that tool.
 */
export const applyInput = {
	apply: z
		.boolean()
		.default(false)
		.describe(
			"When true, WRITE the resulting files to disk (and remove any `deletes`) instead of returning their contents for the client to write. The response then lists the paths touched. Use it for routine patches the user isn't reviewing line-by-line; leave it false when you want to preview a diff first.",
		),
};

/**
 * Report payloads (`_inspect.json`, `_validate.json`, `_action_check.json`)
 * reuse the file-map shape for transport but are NOT module files — they must
 * never hit the disk.
 */
const isReportPayload = (relPath: string): boolean => path.basename(relPath).startsWith("_");

export interface AppliedResult {
	summary: string;
	applied: true;
	written: string[];
	deleted: string[];
	skipped?: string[];
	warning?: string;
}

/**
 * Resolve a module-root-relative path, refusing anything that escapes the
 * module directory. `files` keys come from tool code rather than user input,
 * but this is the one place that turns them into writes — so it verifies
 * rather than assumes.
 */
function resolveInside(root: string, relPath: string): string {
	const abs = path.resolve(root, relPath);
	const rel = path.relative(root, abs);
	if (rel.startsWith("..") || path.isAbsolute(rel)) {
		throw new Error(
			`Refusing to write '${relPath}' — it resolves outside the module directory (${abs}).`,
		);
	}
	return abs;
}

/**
 * Write a ToolResult's file map to disk and delete its `deletes`, returning a
 * path-only summary. Deletions run AFTER writes so a rename (which writes the
 * new file and deletes the old) can't lose data if a write fails.
 */
export function applyToDisk(moduleDir: string, result: ToolResult): AppliedResult {
	const root = path.resolve(moduleDir);
	const written: string[] = [];
	const skipped: string[] = [];

	for (const [relPath, contents] of Object.entries(result.files ?? {})) {
		if (isReportPayload(relPath)) {
			skipped.push(relPath);
			continue;
		}
		const abs = resolveInside(root, relPath);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, contents, "utf8");
		written.push(relPath);
	}

	// `deletes` is a FILE-only contract: the refactor tools emit it for a moved
	// entity JSON or an orphaned seed file, never a directory. Enforce that
	// rather than papering over it with a recursive remove — if a tool ever does
	// emit a directory path, silently deleting the subtree would be the worst
	// possible response, and a bare rmSync would throw an opaque EISDIR/ERR_FS
	// error instead of naming the problem.
	const deleted: string[] = [];
	for (const relPath of result.deletes ?? []) {
		const abs = resolveInside(root, relPath);
		let stat: fs.Stats;
		try {
			stat = fs.lstatSync(abs);
		} catch {
			continue; // already gone — nothing to do
		}
		if (stat.isDirectory()) {
			throw new Error(
				`Refusing to delete '${relPath}': it is a directory, and \`deletes\` is a file-only contract ` +
					"(it exists to remove a renamed entity's old JSON or an orphaned seed file). Remove the " +
					"directory by hand if that is really what you want.",
			);
		}
		fs.rmSync(abs, { force: true });
		deleted.push(relPath);
	}

	const out: AppliedResult = {
		summary: result.summary,
		applied: true,
		written: written.sort(),
		deleted: deleted.sort(),
	};
	if (skipped.length > 0) out.skipped = skipped.sort();
	if (result.warning) out.warning = result.warning;
	return out;
}
