import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";

// Phase 0 doc paths (relative to module root)
const P0 = {
	identity: "CLAUDE.md",
	requirements: "docs/REQUIREMENTS.md",
	design: "docs/DESIGN.md",
	validation: "docs/VALIDATION.md",
} as const;

// docs/DESIGN.md template. Returned to the agent (as `designTemplate`) at the
// 0b→0c handoff and on the 0c resume path, so the template lives in exactly one
// place and is delivered just-in-time — instead of sitting permanently in the
// skill prompt. The section headers (## Entity List / ## Relationship Map /
// ## Gaps & Proposals) MUST stay in sync with the regexes in runStructuralChecks.
const DESIGN_TEMPLATE = `# Design Document
<!-- written after Phase 0c approval — edit with care -->

## Entity List
<name — one-line purpose, ordered least- to most-dependent>

## Fields per Entity
### <EntityName>
<key fields, status values, formulas, number sequences>

## Relationship Map
<!-- crow's-foot cardinality: ||--o{ = required N:1 (child must have a parent); |o--o{ = optional N:1. One edge per FK; replace names with your entities. -->
\`\`\`mermaid
erDiagram
    parent_entity ||--o{ child_entity : "verb"
    lookup_entity |o--o{ child_entity : "verb"
\`\`\`

| Relationship (child FK → parent PK) | Required |
|-------------------------------------|----------|
| child_entity.parent_id → parent_entity.id | required |
| child_entity.lookup_id → lookup_entity.id | optional |

Total FKs: <N>

## Status Machines
### <EntityName>
| Status | Transitions via | canExecute guard | Recovery |
|--------|----------------|-----------------|----------|

## Actions
| Name | Target Entity | Description | Params |
|------|--------------|-------------|--------|

## Seed Data
<entity name — rows needed, in parent-before-child order>

## Number Sequences
<column → pattern, or "None">

## Reports & Queries
<report/query name — entity, key columns; or "None">

## Special Behaviors
<entity — soft-delete? sorting? webhooks? print templates? — or "None">

## Gaps & Proposals
<findings from the gap detection pass, or omit this section if none>

---
*Approved: <date>*
`;

// ─── Schema ───────────────────────────────────────────────────────────────────

export const planModuleSchema = {
	action: z
		.enum(["check", "write_identity", "write_requirements", "write_design", "validate"])
		.describe(
			"Sub-command: 'check' = current Phase 0 state; 'write_identity' = Phase 0a; 'write_requirements' = Phase 0b; 'write_design' = Phase 0c; 'validate' = Phase 0d.",
		),
	moduleDir: z
		.string()
		.describe(
			"Absolute path to the module directory. Ask the user for this before the first call.",
		),
	// ── write_identity fields (Phase 0a) ────────────────────────────────
	displayName: z
		.string()
		.optional()
		.describe("[write_identity] Human-readable module name, e.g. 'Purchase Orders'."),
	code: z
		.string()
		.regex(/^[a-z][a-z0-9_]*$/)
		.optional()
		.describe(
			"[write_identity] snake_case module code, e.g. 'purchase_orders'. Becomes the DB schema name.",
		),
	dependencies: z
		.array(z.string())
		.optional()
		.describe(
			"[write_identity] Other dForge module codes this module depends on. admin + metadata are always implicit.",
		),
	locales: z
		.array(z.string())
		.optional()
		.describe("[write_identity] Locale codes, e.g. ['en-US', 'de-DE']. Default: ['en-US']."),
	preset: z
		.enum(["minimal", "minimal-plus", "full"])
		.optional()
		.describe(
			"[write_identity] Scaffold depth: minimal = entities + views + role; full = + settings + translations + seed-data stubs.",
		),
	// ── write_requirements / write_design fields (Phase 0b / 0c) ────────
	userConfirmed: z
		.boolean()
		.optional()
		.describe(
			"[write_requirements, write_design] MUST be true — only set after the user has reviewed the on-disk draft (docs/REQUIREMENTS.md / docs/DESIGN.md, already written by you) and explicitly confirmed (replied YES / 'looks good' / 'confirmed').",
		),
	// ── validate fields (Phase 0d) ───────────────────────────────────────
	checkResults: z
		.array(
			z.object({
				check: z.string().describe("Check name, e.g. 'Persona → entity coverage'."),
				pass: z.boolean(),
				detail: z.string().describe("One sentence explaining the pass or failure."),
			}),
		)
		.optional()
		.describe(
			"[validate] Semantic check results from agent evaluation. Omit on the first call (structural pre-check only). Provide after evaluating the returned semanticChecks.",
		),
};

type Args = z.infer<z.ZodObject<typeof planModuleSchema>>;

// ─── Dispatcher ───────────────────────────────────────────────────────────────

export function planModule(rawArgs: Args): unknown {
	const root = path.resolve(rawArgs.moduleDir);
	switch (rawArgs.action) {
		case "check":
			return handleCheck(root);
		case "write_identity":
			return handleWriteIdentity(root, rawArgs);
		case "write_requirements":
			return handleWriteRequirements(root, rawArgs);
		case "write_design":
			return handleWriteDesign(root, rawArgs);
		case "validate":
			return handleValidate(root, rawArgs);
	}
}

// ─── check ────────────────────────────────────────────────────────────────────

function handleCheck(root: string): unknown {
	const claudePath = path.join(root, P0.identity);
	const reqPath = path.join(root, P0.requirements);
	const designPath = path.join(root, P0.design);
	const validationPath = path.join(root, P0.validation);

	const has0a = fileExists(claudePath);
	const claudeContent = has0a ? readFile(claudePath) : "";
	// 0b/0c file existence alone isn't "done" — the agent writes the draft to disk
	// before the user confirms it, so the CLAUDE.md checklist tick is the source of truth.
	const has0b = has0a && /- \[x\] \*\*0b\*\*/.test(claudeContent);
	const has0c = has0b && /- \[x\] \*\*0c\*\*/.test(claudeContent);
	const has0d =
		has0c &&
		fileExists(validationPath) &&
		readFile(validationPath).includes("readyToScaffold: true");

	const completed: string[] = [];
	if (has0a) completed.push("0a");
	if (has0b) completed.push("0b");
	if (has0c) completed.push("0c");
	if (has0d) completed.push("0d");

	const allPhases = ["0a", "0b", "0c", "0d"];
	const pending = allPhases.filter((p) => !completed.includes(p));

	if (has0d) {
		return {
			summary: "Phase 0 complete — all docs present and validated.",
			currentPhase: "complete",
			completed,
			pending: [],
			readyToScaffold: true,
			nextStep:
				"All Phase 0 docs are in place. Call dforge_module_create({ moduleDir, code, displayName, entities, ... }) to scaffold the module.",
		};
	}

	if (!has0a) {
		return {
			summary: "Phase 0 not started.",
			currentPhase: "0a",
			completed,
			pending,
			readyToScaffold: false,
			nextStep:
				"Phase 0a — Module Identity. Ask the user these questions ONE AT A TIME. After each answer, restate what you understood and confirm before continuing.",
			questions: [
				'What\'s the module\'s display name? (e.g. "Purchase Orders", "HR Leave Requests")',
				"What code should it use? (snake_case, letters + digits + underscores — becomes the DB schema name; suggest a default derived from the display name)",
				"Does this module depend on any other dForge modules — e.g. needing entities from 'crm' or 'parties'? (admin and metadata are platform-implicit; list any others, or say None)",
				"English only, or any other locales the module needs to ship with translations for?",
				"How complete should the initial scaffold be? (minimal = entities + default views + single admin role; minimal-plus = + settings/translation stubs; full = + logic stubs + seed data structure)",
			],
			writeAction:
				"Once all answers are collected and reflected back, call dforge_module_plan({ action: 'write_identity', moduleDir, displayName, code, dependencies, locales, preset }).",
		};
	}

	if (!has0b) {
		if (fileExists(reqPath)) {
			return {
				summary:
					"Phase 0a complete. A draft docs/REQUIREMENTS.md exists on disk but hasn't been confirmed yet.",
				currentPhase: "0b",
				completed,
				pending,
				readyToScaffold: false,
				nextStep:
					"Read docs/REQUIREMENTS.md. Give the user a short outline (section headings + counts) and gap status (open items, or 'No gaps'), then ask them to review the file and reply YES, or describe what to change. If they request changes, edit docs/REQUIREMENTS.md directly (targeted edits), summarize the change in one line, and ask again. Once they reply YES, call dforge_module_plan({ action: 'write_requirements', moduleDir, userConfirmed: true }).",
			};
		}

		return {
			summary: "Phase 0a complete. Proceed to Phase 0b intake.",
			currentPhase: "0b",
			completed,
			pending,
			readyToScaffold: false,
			nextStep:
				"Phase 0b — Intake. Ask the user these questions ONE AT A TIME in free-form prose. After each answer, restate what you understood and confirm before continuing. Do NOT use pickers or predefined options.",
			questions: [
				"In one sentence, what does this module do?",
				"Who will use this, and what does each type DO with it? (Capture as verb-led sentences, e.g. 'Department managers approve or reject pending requests'. NOT role labels like 'Approver — approves requests'. Push back on vague answers like 'admins and users' — ask what each type does that the other can't.)",
			],
			followUpNote:
				"After answers 1-2: ask any domain ambiguity questions that remain open (e.g. 'What counts as a closed item?', 'Can anonymous users submit?'). Continue one at a time until no open questions remain. Dependencies and locales are confirmed from Phase 0a — carry them into REQUIREMENTS.md without re-asking.",
			writeAction:
				"Draft REQUIREMENTS.md and write it directly to docs/REQUIREMENTS.md on disk (do not paste it into chat). Tell the user it's ready: give a short outline (section headings + counts) and gap status ('No gaps' or a one-line list), then ask them to review and reply YES, or describe what to change. If they request changes, edit the file directly and ask again. Once they reply YES ('yes', 'looks good', 'confirmed', 'LGTM'), call dforge_module_plan({ action: 'write_requirements', moduleDir, userConfirmed: true }).",
		};
	}

	if (!has0c) {
		if (fileExists(designPath)) {
			return {
				summary:
					"Phase 0b complete. A draft docs/DESIGN.md exists on disk but hasn't been confirmed yet.",
				currentPhase: "0c",
				completed,
				pending,
				readyToScaffold: false,
				nextStep:
					"Read docs/DESIGN.md. Give the user a short outline (entity/status-machine counts, section headings) and Gaps & Proposals status (open items, or 'No gaps'), then ask them to review the file and reply YES, or describe what to change. If they request changes, edit docs/DESIGN.md directly (targeted edits), summarize the change in one line, and ask again. Once they reply YES, call dforge_module_plan({ action: 'write_design', moduleDir, userConfirmed: true }).",
			};
		}

		return {
			summary: "Phase 0b complete. Proceed to Phase 0c design.",
			currentPhase: "0c",
			completed,
			pending,
			readyToScaffold: false,
			nextStep:
				"Phase 0c — Design. Re-read REQUIREMENTS.md, then draft DESIGN.md (use the designTemplate below) with all 8 design items in a single message.",
			designTemplate: DESIGN_TEMPLATE,
			designItems: [
				"1. Entity list (ordered least-dependent → most-dependent, one-line purpose each)",
				"2. Fields per entity (key fields, status values, lookups, formulas, sequences)",
				"3. Relationship map (Mermaid erDiagram + FK table with required/optional column)",
				"4. Status machines (per-entity: values, transitions, canExecute guards, recovery paths)",
				"5. Actions (name, target entity, description, params)",
				"6. Seed data (entities needing initial rows, parent-before-child order)",
				"7. Reports & queries",
				"8. Special behaviors (soft-delete, sorting, webhooks, print templates)",
			],
			gapDetection:
				"After drafting: run gap detection pass (FK optionality, status recovery, boolean-to-status smell, set aggregation risk, deep navigation, self-referential FK, security coverage, seed data circular refs). Add a 'Gaps & Proposals' section for each issue found. ALL gaps must be resolved before Phase 0d.",
			writeAction:
				"Once gaps are resolved, write docs/DESIGN.md directly to disk (do not paste it into chat). Tell the user it's ready: give a short outline (entity/status-machine counts, section headings) and Gaps & Proposals status ('No gaps' or a one-line summary), then ask them to review and reply YES, or describe what to change. If they request changes, edit the file directly and ask again. Once they reply YES, call dforge_module_plan({ action: 'write_design', moduleDir, userConfirmed: true }).",
		};
	}

	// has0a + has0b + has0c, no 0d
	return {
		summary: "Phase 0c complete. Proceed to Phase 0d validation.",
		currentPhase: "0d",
		completed,
		pending,
		readyToScaffold: false,
		nextStep:
			"Phase 0d — Validation. Call dforge_module_plan({ action: 'validate', moduleDir }) to run structural checks. If all pass, evaluate the returned semantic checks, then call validate again with checkResults.",
	};
}

// ─── write_identity ───────────────────────────────────────────────────────────

function handleWriteIdentity(root: string, args: Args): unknown {
	const { displayName, code, dependencies = [], locales = ["en-US"], preset = "minimal" } = args;

	if (!displayName) throw new Error("displayName is required for write_identity.");
	if (!code) throw new Error("code is required for write_identity.");

	const depsText = dependencies.length > 0 ? dependencies.join(", ") : "None";
	const localesText = locales.join(", ");

	const claudeMd = buildClaudeMd({ root, displayName, code, depsText, localesText, preset });

	return {
		summary: `Phase 0a complete — CLAUDE.md prepared for module '${code}'.`,
		files: { [P0.identity]: claudeMd },
		nextStep:
			"Write CLAUDE.md to disk. Then start Phase 0b intake: ask the user (1) 'In one sentence, what does this module do?' (2) 'Who will use this, and what does each type DO with it?' — capture as verb-led sentences, not role labels. Ask domain ambiguity follow-ups until no open questions remain. Draft REQUIREMENTS.md and write it directly to docs/REQUIREMENTS.md on disk, give the user a short outline + gap status, wait for explicit YES, then call write_requirements with userConfirmed: true.",
	};
}

function buildClaudeMd(opts: {
	root: string;
	displayName: string;
	code: string;
	depsText: string;
	localesText: string;
	preset: string;
}): string {
	const { root, displayName, code, depsText, localesText, preset } = opts;
	return `# ${displayName} — dForge Module

## For AI assistants

- All structural changes go through dforge-mcp tools — do not hand-edit entity/UI/security JSON files.
- Read \`docs/DESIGN.md\` before proposing any changes to entities, fields, or relationships.
- Run \`dforge_module_plan({ action: "check", moduleDir: "..." })\` to check Phase 0 status before any other tool.
- Do NOT call \`dforge_module_create\` until \`dforge_module_plan\` validate returns \`readyToScaffold: true\`.

## Module identity

| Field | Value |
|-------|-------|
| Code | \`${code}\` |
| Display name | ${displayName} |
| Dependencies | ${depsText} |
| Locales | ${localesText} |
| Preset | ${preset} |

## Module status

- [x] **0a** Identity — \`CLAUDE.md\`
- [ ] **0b** Requirements — \`docs/REQUIREMENTS.md\`
- [ ] **0c** Design — \`docs/DESIGN.md\`
- [ ] **0d** Validation — \`docs/VALIDATION.md\`
- [ ] **1** Scaffolded — \`manifest.json\`

**Next step:** Phase 0b — run intake questions (purpose, user types, domain ambiguities), draft \`docs/REQUIREMENTS.md\` and write it to disk, get explicit user YES, then call \`dforge_module_plan({ action: "write_requirements", moduleDir, userConfirmed: true })\`.

## Pack and install (after Phase 0 complete)

\`\`\`
dforge_module_pack({ moduleDir: "${root}" })
dforge_module_install({ moduleDir: "${root}" })
\`\`\`
`;
}

// ─── write_requirements ───────────────────────────────────────────────────────

function handleWriteRequirements(root: string, args: Args): unknown {
	const reqPath = path.join(root, P0.requirements);
	assertDocReady(reqPath, P0.requirements);

	if (!args.userConfirmed) {
		throw new Error(
			'User confirmation required — ask the user to review docs/REQUIREMENTS.md (already written to disk) and wait for an explicit YES ("yes", "looks good", "confirmed", "LGTM", or equivalent) before calling write_requirements with userConfirmed: true.',
		);
	}

	const claudePath = path.join(root, P0.identity);
	if (!fileExists(claudePath)) {
		throw new Error("CLAUDE.md not found — complete Phase 0a (write_identity) first.");
	}

	const updatedClaude = tickChecklist(
		readFile(claudePath),
		"0b",
		'Phase 0c — design docs/DESIGN.md (8 design items + gap detection pass), write it to disk, get explicit user YES, then call `dforge_module_plan({ action: "write_design", moduleDir, userConfirmed: true })`.',
	);

	return {
		summary: "Phase 0b complete — docs/REQUIREMENTS.md confirmed.",
		files: {
			[P0.identity]: updatedClaude,
		},
		designTemplate: DESIGN_TEMPLATE,
		nextStep:
			"Write the updated CLAUDE.md to disk. Now design DESIGN.md using the designTemplate above: 8 design items (entity list, fields per entity, relationship map, status machines, actions, seed data, reports, special behaviors). Run gap detection pass, add Gaps & Proposals section, resolve all gaps. Write docs/DESIGN.md to disk, give the user a short outline (entity/status-machine counts, section headings) plus Gaps & Proposals status, wait for explicit YES, then call write_design with userConfirmed: true.",
	};
}

// ─── write_design ─────────────────────────────────────────────────────────────

function handleWriteDesign(root: string, args: Args): unknown {
	const designPath = path.join(root, P0.design);
	assertDocReady(designPath, P0.design);

	if (!args.userConfirmed) {
		throw new Error(
			"User confirmation required — ask the user to review docs/DESIGN.md (already written to disk, including the Gaps & Proposals section) and wait for an explicit YES before calling write_design with userConfirmed: true. Ensure all Gaps & Proposals items are resolved.",
		);
	}

	const claudePath = path.join(root, P0.identity);
	if (!fileExists(claudePath)) throw new Error("CLAUDE.md not found — complete Phase 0a first.");
	if (!fileExists(path.join(root, P0.requirements))) {
		throw new Error("docs/REQUIREMENTS.md not found — complete Phase 0b first.");
	}

	const updatedClaude = tickChecklist(
		readFile(claudePath),
		"0c",
		'Phase 0d — call `dforge_module_plan({ action: "validate", moduleDir: "..." })` to run structural checks, then provide semantic checkResults.',
	);

	return {
		summary: "Phase 0c complete — docs/DESIGN.md confirmed.",
		files: {
			[P0.identity]: updatedClaude,
		},
		nextStep:
			"Write the updated CLAUDE.md to disk. Now run Phase 0d validation: call dforge_module_plan({ action: 'validate', moduleDir }) for the structural pre-check, evaluate the returned semantic checks, then call validate again with all checkResults.",
	};
}

// ─── validate ─────────────────────────────────────────────────────────────────

const SEMANTIC_CHECK_DESCRIPTIONS = [
	{
		name: "Locale coverage",
		description:
			"Do the locales listed in CLAUDE.md match the translation scope implied in REQUIREMENTS.md?",
	},
	{
		name: "Persona → entity coverage",
		description:
			"Does every user persona listed in REQUIREMENTS.md map to at least one entity in DESIGN.md that they interact with?",
	},
	{
		name: "Core process coverage",
		description:
			"Does every process in REQUIREMENTS.md Core Processes have a corresponding entity, action, or status machine in DESIGN.md?",
	},
	{
		name: "Entity traceability",
		description:
			"Can every entity in DESIGN.md Entity List be traced to a stated need in REQUIREMENTS.md? No invented entities.",
	},
	{
		name: "Status machine completeness",
		description:
			"Does every entity with a status field have a fully documented machine (all values, transitions, guards, recovery path)?",
	},
	{
		name: "Action completeness",
		description:
			"Does every verb in REQUIREMENTS.md Core Processes that implies a user-triggered operation appear in DESIGN.md Actions table?",
	},
	{
		name: "Seed data coverage",
		description:
			"If REQUIREMENTS.md implies initial reference data or starting state, is it covered in DESIGN.md Seed Data section?",
	},
];

interface CheckResult {
	check: string;
	pass: boolean;
	detail: string;
}

function runStructuralChecks(root: string): CheckResult[] {
	const claudePath = path.join(root, P0.identity);
	const reqPath = path.join(root, P0.requirements);
	const designPath = path.join(root, P0.design);

	// Check 11: Docs present & substantive
	const missingDocs: string[] = [];
	if (!fileExists(claudePath)) missingDocs.push("CLAUDE.md");
	if (!fileExists(reqPath)) missingDocs.push("docs/REQUIREMENTS.md");
	if (!fileExists(designPath)) missingDocs.push("docs/DESIGN.md");

	if (missingDocs.length > 0) {
		return [
			{
				check: "Docs present & substantive",
				pass: false,
				detail: `Missing: ${missingDocs.join(", ")}`,
			},
		];
	}

	const reqContent = readFile(reqPath);
	const designContent = readFile(designPath);

	const emptyDocs: string[] = [];
	if (reqContent.trim().length < 100) emptyDocs.push("docs/REQUIREMENTS.md");
	if (designContent.trim().length < 100) emptyDocs.push("docs/DESIGN.md");

	if (emptyDocs.length > 0) {
		return [
			{
				check: "Docs present & substantive",
				pass: false,
				detail: `Appears empty or too short (under 100 chars): ${emptyDocs.join(", ")}`,
			},
		];
	}

	const results: CheckResult[] = [
		{ check: "Docs present & substantive", pass: true, detail: "All 3 docs exist with content." },
	];

	// Check 1: Identity consistency — code + display name in CLAUDE.md appear in REQUIREMENTS.md
	const claudeContent = readFile(claudePath);
	const codeMatch = claudeContent.match(/\|\s*Code\s*\|\s*`([^`]+)`/);
	const nameMatch = claudeContent.match(/\|\s*Display name\s*\|\s*([^\n|]+)/);
	const code = codeMatch?.[1]?.trim();
	const displayName = nameMatch?.[1]?.trim();

	if (!code || !displayName) {
		results.push({
			check: "Identity consistency",
			pass: false,
			detail: "Could not extract code or display name from CLAUDE.md Module identity table — was it hand-edited?",
		});
	} else {
		const reqLower = reqContent.toLowerCase();
		const found = reqLower.includes(code.toLowerCase()) || reqLower.includes(displayName.toLowerCase());
		results.push({
			check: "Identity consistency",
			pass: found,
			detail: found
				? `Module identity (${code} / ${displayName}) referenced in REQUIREMENTS.md.`
				: `Module code '${code}' and display name '${displayName}' not found in REQUIREMENTS.md. Verify both docs describe the same module.`,
		});
	}

	// Check 6: Relationship completeness — every entity in Relationship Map appears in Entity List
	const entityListMatch = designContent.match(/## Entity List\n([\s\S]*?)(?=\n##|$)/);
	const entityListText = entityListMatch?.[1] ?? "";
	const knownEntities = new Set<string>();
	for (const line of entityListText.split("\n")) {
		const m = line.match(/^[-*]\s+(?:\*\*)?([a-z][a-z0-9_]*)(?:\*\*)?/);
		if (m) knownEntities.add(m[1]);
	}

	const relMapMatch = designContent.match(/## Relationship Map\n([\s\S]*?)(?=\n##|$)/);
	const relMapText = relMapMatch?.[1] ?? "";
	const referencedEntities: string[] = [];
	for (const line of relMapText.split("\n")) {
		const entityDef = line.match(/^\s{4}([a-z][a-z0-9_]*)\s*\{/);
		if (entityDef) referencedEntities.push(entityDef[1]);
		const relLine = line.match(/\b([a-z][a-z0-9_]*)\s+[|o]{2}[-]{2}[|o{]{2}\s+([a-z][a-z0-9_]*)\b/);
		if (relLine) {
			referencedEntities.push(relLine[1]);
			referencedEntities.push(relLine[2]);
		}
	}

	if (knownEntities.size === 0 || referencedEntities.length === 0) {
		results.push({
			check: "Relationship completeness",
			pass: true,
			detail:
				"Entity List or Relationship Map section not found — skipped cross-check. Verify manually.",
		});
	} else {
		const missing = [...new Set(referencedEntities.filter((e) => !knownEntities.has(e)))];
		results.push({
			check: "Relationship completeness",
			pass: missing.length === 0,
			detail:
				missing.length === 0
					? "All entities in Relationship Map appear in Entity List."
					: `Entities in Relationship Map not found in Entity List: ${missing.join(", ")}`,
		});
	}

	// Check 10: Gap resolution — scan Gaps & Proposals for unresolved markers
	const gapsMatch = designContent.match(/## Gaps & Proposals\n([\s\S]*?)(?=\n##|$)/i);
	if (!gapsMatch) {
		results.push({
			check: "Gap resolution",
			pass: true,
			detail: "No Gaps & Proposals section in DESIGN.md.",
		});
	} else {
		const gapsText = gapsMatch[1];
		const openPatterns = [/\bTBD\b/i, /\bto be determined\b/i, /\bunresolved\b/i, /\bopen:\b/i, /\bneeds clarification\b/i];
		const found = openPatterns.filter((p) => p.test(gapsText)).map((p) => p.source);
		results.push({
			check: "Gap resolution",
			pass: found.length === 0,
			detail:
				found.length === 0
					? "Gaps & Proposals section present with no open-item markers."
					: `Possible unresolved gaps (matched: ${found.join(", ")}). Resolve all gaps before Phase 0d.`,
		});
	}

	return results;
}

function handleValidate(root: string, args: Args): unknown {
	const structuralResults = runStructuralChecks(root);
	const structuralFailed = structuralResults.filter((r) => !r.pass);

	if (!args.checkResults) {
		// First call: structural pre-check only
		if (structuralFailed.length > 0) {
			return {
				summary: `Structural pre-check: ${structuralFailed.length} check(s) failed. Fix before proceeding.`,
				structuralChecks: structuralResults,
				nextStep:
					"Fix the structural failures listed above, update the relevant document(s), then call dforge_module_plan({ action: 'validate', moduleDir }) again.",
			};
		}

		return {
			summary:
				"Structural checks passed. Evaluate the semantic checks below against the Phase 0 docs, then call validate with checkResults.",
			structuralChecks: structuralResults,
			semanticChecks: SEMANTIC_CHECK_DESCRIPTIONS,
			nextStep:
				"Evaluate each semantic check against the Phase 0 docs — read docs/REQUIREMENTS.md and docs/DESIGN.md from disk (and CLAUDE.md) if they aren't already in your context — then call dforge_module_plan({ action: 'validate', moduleDir, checkResults: [...] }) with your results for all 7 checks.",
		};
	}

	// Second call: merge structural + semantic, write VALIDATION.md if all pass
	if (structuralFailed.length > 0) {
		return {
			summary: `Structural checks still failing — fix documents first.`,
			structuralChecks: structuralResults,
		};
	}

	const allResults: CheckResult[] = [...structuralResults, ...args.checkResults];
	const failedAll = allResults.filter((r) => !r.pass);

	if (failedAll.length > 0) {
		return {
			summary: `Validation failed: ${failedAll.length} check(s) did not pass.`,
			failures: failedAll,
			nextStep:
				"Fix the issues above in the relevant Phase 0 documents. Then call validate again (starting from the first call, without checkResults, to re-run structural checks).",
		};
	}

	// All pass → write VALIDATION.md and tick 0d in CLAUDE.md
	const today = new Date().toISOString().slice(0, 10);
	const rows = allResults
		.map((r, i) => `| ${i + 1} | ${r.check} | ${r.pass ? "✅ PASS" : "❌ FAIL"} | ${r.detail} |`)
		.join("\n");

	const validationMd = `# Validation Report

*Generated: ${today}*

## Phase 0 Pre-Scaffold Design-Doc Checks

| # | Check | Result | Detail |
|---|-------|--------|--------|
${rows}

**Result: ✅ ALL DESIGN-DOC CHECKS PASSED**

> Scope: these checks validate the **Phase 0 design documents** only (identity, requirements,
> design consistency). They do **not** inspect generated entity / UI / security / DSL artifacts —
> those are validated by the platform at install (Phase 6). A pass here unlocks scaffolding; it is
> not a guarantee the module installs. Use the Phase 6 pre-pack self-review before packing.

readyToScaffold: true
`;

	const claudePath = path.join(root, P0.identity);
	const updatedClaude = tickChecklist(
		readFile(claudePath),
		"0d",
		"Phase 0 complete — call `dforge_module_create({ moduleDir: \"...\", ... })` to scaffold the module.",
	);

	return {
		summary:
			"Phase 0d complete — design docs validated (readyToScaffold: true). Note: this validates the design docs only; generated artifacts are checked by the platform at install.",
		readyToScaffold: true,
		files: {
			[P0.identity]: updatedClaude,
			[P0.validation]: validationMd,
		},
		nextStep:
			"Write both files to disk. Phase 0 is complete. Now call dforge_module_create({ moduleDir, code, displayName, entities, preset }) to scaffold the module.",
	};
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fileExists(absPath: string): boolean {
	return fs.existsSync(absPath);
}

function readFile(absPath: string): string {
	return fs.readFileSync(absPath, "utf8");
}

function assertDocReady(absPath: string, relPath: string): void {
	if (!fileExists(absPath)) {
		throw new Error(
			`${relPath} not found — write the draft to disk first (using your file-write tool), then ask the user to review it before calling this action with userConfirmed: true.`,
		);
	}
	if (readFile(absPath).trim().length < 100) {
		throw new Error(
			`${relPath} appears empty or too short (under 100 chars) — write the full draft to disk first.`,
		);
	}
}

function tickChecklist(claudeMd: string, phase: "0b" | "0c" | "0d", nextStep: string): string {
	const ticked = claudeMd.replace(
		new RegExp(`- \\[ \\] (\\*\\*${phase}\\*\\*)`),
		"- [x] $1",
	);
	return ticked.replace(
		/\*\*Next step:\*\* .+/,
		`**Next step:** ${nextStep}`,
	);
}
