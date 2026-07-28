// dforge_menu_add — insert a leaf or section into ui/menus.json.
//
// Menus were the last UI surface with a reference doc but no tool, so agents
// hand-wrote the JSON and hit the same three documented mistakes every time:
// `viewCode` instead of `dataViewCode`, Bootstrap icons keeping their `bi-`
// prefix (menu icons drop it — action icons keep it), and `itemType` on a
// section node. All three are unrepresentable here.

import { z } from "zod";
import {
	loadManifest,
	readJsonOrDefault,
	jsonText,
	rel,
	makeResult,
	withTodayStamp,
	type ToolResult,
} from "./_helpers";

type Node = Record<string, unknown>;

export const menuAddSchema = {
	moduleDir: z.string().describe("Path to the module root."),
	menu: z
		.string()
		.regex(/^[a-z][a-z0-9_]*$/)
		.describe("Root menu key in ui/menus.json, e.g. 'crm_menu'. Created if it doesn't exist yet."),
	menuLabel: z
		.string()
		.optional()
		.describe("Label for the root menu — only used when the root is being created."),
	parentPath: z
		.string()
		.default("")
		.describe(
			"Slash-separated item codes under the root, e.g. 'lists/archive'. Empty = add directly under the root menu.",
		),
	code: z
		.string()
		.regex(/^[a-z][a-z0-9_]*$/)
		.describe("Code of the new item (its key under the parent's items/children)."),
	label: z.string().min(1).describe("Display label."),
	dataViewCode: z
		.string()
		.regex(/^[a-z][a-z0-9_]*$/)
		.optional()
		.describe(
			"For a LEAF item: the view code from ui/data_views.json this item opens. Omit to create a SECTION node (a container for children). Note the key is dataViewCode, never viewCode.",
		),
	icon: z
		.string()
		.optional()
		.describe(
			"Bootstrap icon name. A leading 'bi-' is STRIPPED — menu icons are bare names ('list-ul'), unlike action icons which keep the prefix.",
		),
	orderNum: z
		.number()
		.int()
		.optional()
		.describe("Sort position among siblings. Default: appended after the current highest."),
};

/** Child map of a node: the root uses `items`, nested nodes use `children`. */
function childKey(node: Node, isRoot: boolean): "items" | "children" {
	if (isRoot) return "items";
	return Object.prototype.hasOwnProperty.call(node, "items") ? "items" : "children";
}

function nextOrder(children: Record<string, Node>): number {
	let max = 0;
	for (const c of Object.values(children)) {
		const n = typeof c?.orderNum === "number" ? c.orderNum : 0;
		if (n > max) max = n;
	}
	return max + 1;
}

export function menuAdd(args: z.infer<z.ZodObject<typeof menuAddSchema>>): ToolResult {
	const { paths, manifest } = loadManifest(args.moduleDir);
	const menus = readJsonOrDefault<Record<string, Node>>(paths.menus, {});

	// A leaf must point at a view that exists — a dangling dataViewCode renders
	// a dead menu entry and is flagged by dforge_module_validate anyway.
	if (args.dataViewCode) {
		const views = readJsonOrDefault<Record<string, unknown>>(paths.dataViews, {});
		if (!Object.prototype.hasOwnProperty.call(views, args.dataViewCode)) {
			throw new Error(
				`dataViewCode '${args.dataViewCode}' has no matching view in ui/data_views.json. ` +
					`Existing views: ${Object.keys(views).join(", ") || "(none)"}. Add the view first with dforge_view_add.`,
			);
		}
	}

	let root = menus[args.menu];
	if (!root) {
		root = { label: args.menuLabel ?? manifest.displayName, items: {} };
		menus[args.menu] = root;
	}

	// Walk parentPath down from the root.
	let cursor: Node = root;
	let isRoot = true;
	const segments = args.parentPath.split("/").filter(Boolean);
	const walked: string[] = [];
	for (const seg of segments) {
		const key = childKey(cursor, isRoot);
		const children = (cursor[key] as Record<string, Node> | undefined) ?? {};
		if (!children[seg]) {
			throw new Error(
				`Menu path segment '${seg}' not found under '${walked.join("/") || args.menu}'. ` +
					`Available: ${Object.keys(children).join(", ") || "(none)"}.`,
			);
		}
		cursor = children[seg];
		walked.push(seg);
		isRoot = false;
	}

	// A leaf can't have children hung off it.
	if (!isRoot && cursor.dataViewCode) {
		throw new Error(
			`'${walked.join("/")}' is a leaf item (it has a dataViewCode) — it can't contain children. ` +
				"Nest under a section node instead (a node with no dataViewCode).",
		);
	}

	const key = childKey(cursor, isRoot);
	const children = (cursor[key] as Record<string, Node> | undefined) ?? {};
	if (children[args.code]) {
		throw new Error(
			`Menu item '${args.code}' already exists under '${walked.join("/") || args.menu}'.`,
		);
	}

	const node: Node = { label: args.label, orderNum: args.orderNum ?? nextOrder(children) };
	if (args.icon) {
		// Menu icons are BARE Bootstrap names — the bi- prefix belongs to action
		// icons only. Strip it rather than rejecting, so either input works.
		node.icon = args.icon.replace(/^bi-/, "");
	}
	if (args.dataViewCode) {
		// Leaf: itemType 'V' + the view it opens. Section nodes OMIT itemType.
		node.itemType = "V";
		node.dataViewCode = args.dataViewCode;
	} else {
		node.children = {};
	}

	children[args.code] = node;
	cursor[key] = children;

	const kind = args.dataViewCode ? `leaf → view '${args.dataViewCode}'` : "section";
	return makeResult(
		`Added menu ${kind} '${args.code}' under '${args.menu}${walked.length ? "/" + walked.join("/") : ""}'.`,
		{
			[rel(paths.root, paths.menus)]: jsonText(menus),
			"manifest.json": jsonText(withTodayStamp(manifest)),
		},
	);
}
