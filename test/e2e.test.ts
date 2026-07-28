// End-to-end: drive a module through the real tool surface, on a real temp
// directory, and assert the result validates clean and inspects correctly.
//
// This is the test that catches CONTRACT drift between tools — one tool writing
// a key another reads under a different name. Focused unit tests can't see it,
// because each one is right in isolation. (It was written after
// dforge_module_inspect was found reading `entity`/`mode`/`background` while
// dforge_action_add had always written `entityCode`/`executionMode`/`isAsync`.)

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createModuleFiles } from "../src/tools/create-module";
import { entityFieldAdd } from "../src/tools/entity-field";
import {
	entityReferenceAdd,
	entityRollupAdd,
	entityStatusAdd,
} from "../src/tools/entity-compose";
import { actionAdd } from "../src/tools/action-add";
import { triggerAdd } from "../src/tools/behavior";
import { viewAdd } from "../src/tools/view";
import { menuAdd } from "../src/tools/menu";
import { seedAdd } from "../src/tools/seed";
import { translationSync } from "../src/tools/translations";
import { roleRightSet } from "../src/tools/role-right";
import { moduleValidate } from "../src/tools/module-validate";
import { moduleInspect } from "../src/tools/module-inspect";
import { planModule } from "../src/tools/plan-module";
import { applyToDisk } from "../src/tools/apply";
import type { ToolResult } from "../src/tools/_helpers";

let dir: string;

/** Write a tool's file map straight to disk, the way `apply: true` does. */
const apply = (r: ToolResult) => applyToDisk(dir, r);

/** Write the four Phase 0 artifacts so the scaffold gate opens. */
function completePhase0(root: string): void {
	mkdirSync(join(root, "docs"), { recursive: true });
	writeFileSync(
		join(root, "CLAUDE.md"),
		"# Orders — dForge Module\n\n| Field | Value |\n|---|---|\n| Code | `orders` |\n| Display name | Orders |\n\n## Module status\n\n- [x] **0a** Identity\n- [x] **0b** Requirements\n- [x] **0c** Design\n- [x] **0d** Validation\n\n**Next step:** scaffold.\n",
	);
	writeFileSync(
		join(root, "docs", "REQUIREMENTS.md"),
		"# Requirements\n\nThe orders module tracks customer orders and their line items.\nStaff create orders and add lines; supervisors approve them.\n",
	);
	writeFileSync(
		join(root, "docs", "DESIGN.md"),
		"# Design\n\n## Entity List\n- customer — who places the order\n- order — an order header\n- order_line — one line of an order\n\n## Relationship Map\n```mermaid\nerDiagram\n    customer ||--o{ order : places\n    order ||--o{ order_line : contains\n```\n",
	);
	writeFileSync(
		join(root, "docs", "VALIDATION.md"),
		"# Validation Report\n\nAll checks passed.\n\nreadyToScaffold: true\n",
	);
	writeFileSync(
		join(root, "docs", "phase.json"),
		JSON.stringify({ phase: "0d", readyToScaffold: true }, null, "\t") + "\n",
	);
}

const readJson = (rel: string) => JSON.parse(readFileSync(join(dir, rel), "utf8"));

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "dforge-mcp-e2e-"));
	completePhase0(dir);
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("end-to-end module build", () => {
	it("scaffolds, builds, validates clean, and inspects accurately", () => {
		// ── Phase 1: scaffold ──
		const files = createModuleFiles({
			moduleDir: dir,
			code: "orders",
			displayName: "Orders",
			license: "MIT",
			version: "0.1.0",
			dbSchemaVersion: "0.0.1",
			dependencies: [],
			preset: "minimal",
			entities: [
				{ name: "customer", label: "Customer", traits: ["identity", "audit"] },
				{ name: "order", label: "Order", traits: ["identity", "audit"] },
				{ name: "order_line", label: "Order Line", traits: ["identity", "audit"] },
			],
		});
		apply({ summary: "scaffold", files });
		expect(existsSync(join(dir, "manifest.json"))).toBe(true);

		// ── Phase 1: fields ──
		apply(
			entityFieldAdd({
				moduleDir: dir,
				entityName: "customer",
				fieldName: "name",
				field: { fieldTypeCd: "text", flags: "VEM", maxLen: 120, description: "Name" },
			}),
		);
		apply(
			entityFieldAdd({
				moduleDir: dir,
				entityName: "order_line",
				fieldName: "amount",
				field: { fieldTypeCd: "currency", flags: "VEM", description: "Amount" },
			}),
		);

		// dbDatatype is derived from fieldTypeCd, not echoed back.
		expect(readJson("entities/customer.json").fields.name.dbDatatype).toBe("varchar(120)");

		// ── Phase 1: relation via the composite tool ──
		apply(
			entityReferenceAdd({
				moduleDir: dir,
				entity: "order",
				targetEntity: "customer",
				name: "customer",
				required: true,
			}),
		);
		const order = readJson("entities/order.json");
		// The FK+Reference pair is TWO columns plus a references entry.
		expect(order.fields.customer_id).toMatchObject({ dbDatatype: "cuid", flags: "EM" });
		expect(order.fields.customer_id.fieldTypeCd).toBeUndefined();
		expect(order.fields.customer).toMatchObject({
			columnType: "R",
			fieldTypeCd: "lookup",
			flags: "VEM",
			link: { entity: "customer", thisKey: "customer_id", otherKey: "customer_id" },
		});
		expect(Object.values(order.references)).toContainEqual({
			from: { field: "customer_id" },
			to: { entity: "customer", field: "customer_id" },
		});

		apply(
			entityReferenceAdd({
				moduleDir: dir,
				entity: "order_line",
				targetEntity: "order",
				name: "order",
				required: true,
			}),
		);

		// ── Phase 1: roll-up + status via composite tools ──
		apply(
			entityRollupAdd({
				moduleDir: dir,
				entity: "order",
				name: "total",
				childEntity: "order_line",
				childField: "amount",
				agg: "SUM",
				setField: "lines",
				childFkField: "order_id",
			}),
		);
		const withRollup = readJson("entities/order.json");
		// A roll-up is a GENERATED column (never Formula), over a Set column.
		expect(withRollup.fields.total).toMatchObject({
			columnType: "G",
			formula: "SUM([lines].[amount])",
			flags: "V",
		});
		expect(withRollup.fields.total.baseDatatypeCd).toBeUndefined();
		expect(withRollup.fields.lines).toMatchObject({ columnType: "S", link: { entity: "order_line" } });

		apply(
			entityStatusAdd({
				moduleDir: dir,
				entity: "order",
				name: "status",
				options: ["draft", "submitted", "approved"],
				required: true,
			}),
		);
		const status = readJson("entities/order.json").fields.status;
		// Options are objects under params; the initial value is a formula, never
		// a defaultValue key.
		expect(status.params.options[0]).toEqual({ value: "draft", label: "Draft" });
		expect(status.formula).toBe("'draft'");
		expect(status.defaultValue).toBeUndefined();

		// ── Phase 2: action + trigger ──
		apply(
			actionAdd({
				moduleDir: dir,
				code: "approve",
				entityCode: "order",
				label: "Approve",
				executionMode: "single",
				isAsync: false,
				dslBody: "canExecute:\n\t[status] = 'submitted'\n\nexecute:\n\t[status] = 'approved'\n\tinfo('Approved')\n",
			}),
		);
		expect(existsSync(join(dir, "logic/actions/approve.dsl"))).toBe(true);
		apply(
			triggerAdd({
				moduleDir: dir,
				code: "on_submit",
				entity: "order",
				event: "status_change",
				action: "approve",
				async: false,
			}),
		);

		// ── Phase 3: view + menu ──
		apply(
			viewAdd({
				moduleDir: dir,
				code: "orders_by_status",
				view: {
					viewType: "kanban",
					label: "Orders by Status",
					dataSources: [{ entityCode: "order", columns: [{ column_cd: "status" }] }],
				},
			}),
		);
		apply(
			menuAdd({
				moduleDir: dir,
				menu: "orders_menu",
				parentPath: "",
				code: "board",
				label: "Order Board",
				dataViewCode: "orders_by_status",
				icon: "bi-kanban",
			}),
		);
		const menu = readJson("ui/menus.json").orders_menu.items.board;
		// Menu icons are BARE names; leaves carry dataViewCode + itemType 'V'.
		expect(menu).toMatchObject({ itemType: "V", dataViewCode: "orders_by_status", icon: "kanban" });

		// ── Phase 4: seed + translations ──
		apply(
			seedAdd({
				moduleDir: dir,
				entity: "customer",
				records: [{ customer_id: 1001, name: "Acme" }],
				order: 1,
			}),
		);
		apply(translationSync({ moduleDir: dir, prune: false }));

		// ── Phase 5: grant execute on the action ──
		apply(
			roleRightSet({
				moduleDir: dir,
				roleCode: "orders.admin",
				object: "action:approve",
				rights: "E",
			}),
		);

		// ── Phase 6: validate ──
		const validated = JSON.parse(moduleValidate({ moduleDir: dir }).files["_validate.json"]);
		expect(validated.errors, JSON.stringify(validated.errors, null, 1)).toEqual([]);
		expect(validated.ok).toBe(true);

		// ── inspect reports what the other tools actually wrote ──
		const inspected = JSON.parse(moduleInspect({ moduleDir: dir }).files["_inspect.json"]);
		expect(inspected.entities.map((e: { name: string }) => e.name).sort()).toEqual([
			"customer",
			"order",
			"order_line",
		]);
		expect(inspected.actions).toEqual([
			{
				code: "approve",
				entityCode: "order",
				executionMode: "single",
				isAsync: false,
				script: "approve",
			},
		]);
		expect(inspected.triggers).toEqual([
			{ code: "on_submit", entity: "order", event: "status_change", action: "approve", async: false },
		]);
		// The scaffolder's placeholder is normalized to the real identity PK
		// (`{order_id}`), not the non-existent `{id}` dforge-cli emits.
		expect(inspected.entities.find((e: { name: string }) => e.name === "order").toString).toBe(
			"{order_id}",
		);
		expect(inspected.translations).toContain("en-US.json");
	});

	it("tracks build phases through the ledger and routes to the next skill", () => {
		const before = planModule({ action: "check", moduleDir: dir });
		expect(before.currentPhase).toBe("1");
		expect(before.nextSkill).toBe("dforge-module-build");
		// The module isn't scaffolded, and the evidence says so.
		expect(JSON.stringify(before.gaps)).toContain("not been scaffolded");

		apply(
			planModule({
				action: "complete_phase",
				moduleDir: dir,
				phase: "1",
				note: "3 entities",
			}) as ToolResult,
		);

		const after = planModule({ action: "check", moduleDir: dir });
		expect(after.currentPhase).toBe("2");
		expect(after.completed).toEqual(["1"]);
		expect(readJson("docs/phase.json").phases["1"].note).toBe("3 entities");
		// Phase 0 state survives the merge.
		expect(readJson("docs/phase.json").readyToScaffold).toBe(true);
	});

	it("refuses to mark a required phase as skipped", () => {
		expect(() =>
			planModule({ action: "complete_phase", moduleDir: dir, phase: "1", skipped: true }),
		).toThrow(/required and can't be marked skipped/);
		// …but the optional ones are fine.
		expect(() =>
			planModule({ action: "complete_phase", moduleDir: dir, phase: "2", skipped: true }),
		).not.toThrow();
	});
});
