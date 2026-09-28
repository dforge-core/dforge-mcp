// ui/folders.json and docs/diagrams/ checks.

import * as fs from "node:fs";
import * as path from "node:path";
import {
	readJsonOrDefault,
	duplicateFolderCodes,
	walkFolders,
	diagramFiles,
	diagramKeyProblem,
	isPlannedDiagramKey,
	likelyMisspelledEntity,
} from "../_helpers";
import type { ValidateContext } from "./context";

// Folder codes are unique, and each folder viewName names a declared entity view.
export function checkFolders(ctx: ValidateContext): void {
	const { paths, err, entities } = ctx;
	// Folder codes are unique across the whole tree.
	// Role rights reference a folder flat and path-less (`folder:<code>`), so the
	// same code in two branches makes the grant ambiguous. Nesting alone doesn't
	// namespace them.
	const folderRoot = readJsonOrDefault<Record<string, unknown>>(paths.folders, {});
	for (const [code, dupPaths] of duplicateFolderCodes(folderRoot)) {
		err(
			"ui/folders.json",
			`folder code '${code}' is used ${dupPaths.length} times (${dupPaths.join(", ")}). Codes must be ` +
				`unique across the whole tree: role rights say 'folder:${code}' with no path, so duplicates are ambiguous.`,
		);
	}

	// Folder viewName → a view the entity declares.
	// `entities.<code>.viewName` binds one entity view per folder. An unresolved
	// name FAILS the install (falling back would serve the entity's FULL column
	// set, so a typo would quietly unrestrict the folder), which makes this worth
	// catching offline. "default" is the conventional placeholder for "no view"
	// and declares nothing — every shipped module writes it — so it is exempt.
	// Cross-module entities (qualified 'mod.entity') can't be inspected offline.
	const folderNodes = [
		{ path: "(root)", node: folderRoot },
		...walkFolders(folderRoot).map((f) => ({ path: f.path, node: f.node })),
	];
	for (const { path: fpath, node } of folderNodes) {
		const bindings = (node.entities as Record<string, Record<string, unknown>> | undefined) ?? {};
		for (const [entityCd, binding] of Object.entries(bindings)) {
			const viewName = (binding ?? {})?.viewName;
			if (typeof viewName !== "string" || viewName.trim() === "") continue;
			if (viewName.trim().toLowerCase() === "default") continue;
			if (entityCd.includes(".")) continue; // cross-module — not authored here
			const e = entities[entityCd];
			if (!e) continue; // unknown entity is reported by the folder/entity checks

			const declared = Object.keys(
				(e.views as Record<string, unknown> | undefined) ?? {},
			).map((v) => v.trim().toLowerCase());
			if (!declared.includes(viewName.trim().toLowerCase())) {
				err(
					`ui/folders.json → ${fpath} → entities.${entityCd}`,
					`viewName '${viewName}' is not declared under 'views' in entities/${entityCd}.json. ` +
						"This fails the install: an unresolved view would show every column of the entity, " +
						"which is the opposite of what naming one asks for. Declare the view, or drop " +
						"'viewName' (or use \"default\", which means no view).",
				);
			}
		}
	}
}

// Diagrams: entity keys resolve, x/y come as a pair.
// docs/diagrams/<code>.json — one diagram per file, the file name its code.
// Design-time only — the installer never reads them — so nothing here may
// block a pack: an unparseable file is worth one error (the editor can't open
// it either), everything else is a warning, and one broken file doesn't stop
// the others being checked. A key is the manifest's own entity code, a
// planned entity (an own code not built yet), or 'module.entity' for a
// declared dependency. Module codes can contain dots,
// so own keys are tried first, then the LONGEST declared dependency code
// followed by '.'.
export function checkDiagrams(ctx: ValidateContext): void {
	const { paths, err, warn, entityMap, deps } = ctx;
	for (const fp of diagramFiles(paths.diagramsDir)) {
		const where = `docs/diagrams/${path.basename(fp)}`;
		let diagram: unknown;
		try {
			diagram = JSON.parse(fs.readFileSync(fp, "utf8"));
		} catch (ex) {
			err(where, `invalid JSON: ${(ex as Error).message}`);
			continue;
		}
		if (!diagram || typeof diagram !== "object" || Array.isArray(diagram)) {
			warn(where, "must be an object — the diagram itself, with an 'entities' map.");
			continue;
		}
		const diagramEntities = (diagram as Record<string, unknown>).entities;
		if (!diagramEntities || typeof diagramEntities !== "object" || Array.isArray(diagramEntities)) {
			warn(where, "has no 'entities' object — list the entities the diagram draws, keyed by entity code.");
			continue;
		}
		for (const [key, placement] of Object.entries(diagramEntities as Record<string, unknown>)) {
			const at = `${where} → entities.${key}`;
			if (isPlannedDiagramKey(key, entityMap)) {
				// A planned entity is valid design content; only a near-miss of a
				// built entity is worth a word, since it's more likely a typo.
				const meant = likelyMisspelledEntity(key, entityMap);
				if (meant) {
					warn(
						at,
						`'${key}' is not built yet, so the diagram draws it as a planned entity. ` +
							`If you meant the existing '${meant}', fix the key.`,
					);
				}
			} else {
				const unresolved = diagramKeyProblem(key, entityMap, deps, paths.root);
				if (unresolved) warn(at, unresolved);
			}
			const p = (placement && typeof placement === "object" ? placement : {}) as Record<string, unknown>;
			if (("x" in p) !== ("y" in p)) {
				warn(
					at,
					`sets '${"x" in p ? "x" : "y"}' without '${"x" in p ? "y" : "x"}'. Give both to pin the ` +
						"entity, or neither to let the diagram place it.",
				);
			}
		}
	}
}
