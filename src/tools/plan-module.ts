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
	content: z
		.string()
		.optional()
		.describe(
			"[write_requirements, write_design] Full markdown content of the document being written.",
		),
	userConfirmed: z
		.boolean()
		.optional()
		.describe(
			"[write_requirements, write_design] MUST be true — only set after the user has explicitly confirmed the draft (replied YES / 'looks good' / 'confirmed').",
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
	const has0b = has0a && fileExists(reqPath);
	const has0c = has0b && fileExists(designPath);
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
				"Draft REQUIREMENTS.md, show full draft to user, wait for explicit YES ('yes', 'looks good', 'confirmed', 'LGTM'), then call dforge_module_plan({ action: 'write_requirements', moduleDir, content, userConfirmed: true }).",
		};
	}

	if (!has0c) {
		return {
			summary: "Phase 0b complete. Proceed to Phase 0c design.",
			currentPhase: "0c",
			completed,
			pending,
			readyToScaffold: false,
			nextStep:
				"Phase 0c — Design. Re-read REQUIREMENTS.md, then draft DESIGN.md with all 8 design items in a single message.",
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
				"Show full DESIGN.md draft to user, wait for explicit YES, then call dforge_module_plan({ action: 'write_design', moduleDir, content, userConfirmed: true }).",
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
			"Write CLAUDE.md to disk. Then start Phase 0b intake: ask the user (1) 'In one sentence, what does this module do?' (2) 'Who will use this, and what does each type DO with it?' — capture as verb-led sentences, not role labels. Ask domain ambiguity follow-ups until no open questions remain. Draft REQUIREMENTS.md, show to user, wait for explicit YES, then call write_requirements.",
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

**Next step:** Phase 0b — run intake questions (purpose, user types, domain ambiguities), draft \`docs/REQUIREMENTS.md\`, get explicit user YES, then call \`dforge_module_plan({ action: "write_requirements", ... })\`.

## Pack and install (after Phase 0 complete)

\`\`\`
dforge_module_pack({ moduleDir: "${root}" })
dforge_module_install({ moduleDir: "${root}" })
\`\`\`
`;
}

// ─── write_requirements ───────────────────────────────────────────────────────

function handleWriteRequirements(root: string, args: Args): unknown {
	if (!args.userConfirmed) {
		throw new Error(
			'User confirmation required — show the REQUIREMENTS.md draft to the user and wait for an explicit YES ("yes", "looks good", "confirmed", "LGTM", or equivalent) before calling write_requirements.',
		);
	}
	if (!args.content) throw new Error("content is required for write_requirements.");

	const claudePath = path.join(root, P0.identity);
	if (!fileExists(claudePath)) {
		throw new Error("CLAUDE.md not found — complete Phase 0a (write_identity) first.");
	}

	const updatedClaude = tickChecklist(
		readFile(claudePath),
		"0b",
		'Phase 0c — draft `docs/DESIGN.md` (8 design items + gap detection pass), get explicit user YES, then call `dforge_module_plan({ action: "write_design", ... })`.',
	);

	return {
		summary: "Phase 0b complete — REQUIREMENTS.md prepared.",
		files: {
			[P0.identity]: updatedClaude,
			[P0.requirements]: args.content,
		},
		nextStep:
			"Write both files to disk. Now draft DESIGN.md with 8 design items: entity list, fields per entity, relationship map, status machines, actions, seed data, reports, special behaviors. Run gap detection pass, add Gaps & Proposals section, resolve all gaps. Show full draft to user, wait for explicit YES, then call write_design.",
	};
}

// ─── write_design ─────────────────────────────────────────────────────────────

function handleWriteDesign(root: string, args: Args): unknown {
	if (!args.userConfirmed) {
		throw new Error(
			"User confirmation required — show the DESIGN.md draft to the user and wait for an explicit YES before calling write_design. Ensure all Gaps & Proposals items are resolved.",
		);
	}
	if (!args.content) throw new Error("content is required for write_design.");

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
		summary: "Phase 0c complete — DESIGN.md prepared.",
		files: {
			[P0.identity]: updatedClaude,
			[P0.design]: args.content,
		},
		nextStep:
			"Write both files to disk. Now run Phase 0d validation: call dforge_module_plan({ action: 'validate', moduleDir }) for the structural pre-check, evaluate the returned semantic checks, then call validate again with all checkResults.",
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

		const claudePath = path.join(root, P0.identity);
		const reqPath = path.join(root, P0.requirements);
		const designPath = path.join(root, P0.design);

		return {
			summary:
				"Structural checks passed. Evaluate the semantic checks below against the document content, then call validate with checkResults.",
			structuralChecks: structuralResults,
			docsContent: {
				"CLAUDE.md": readFile(claudePath),
				"docs/REQUIREMENTS.md": readFile(reqPath),
				"docs/DESIGN.md": readFile(designPath),
			},
			semanticChecks: SEMANTIC_CHECK_DESCRIPTIONS,
			nextStep:
				"Read the docs content above. Evaluate each of the 7 semantic checks. Then call dforge_module_plan({ action: 'validate', moduleDir, checkResults: [...] }) with your results for all 7 checks.",
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

## Phase 0 Pre-Scaffold Checks

| # | Check | Result | Detail |
|---|-------|--------|--------|
${rows}

**Result: ✅ ALL CHECKS PASSED**

readyToScaffold: true
`;

	const claudePath = path.join(root, P0.identity);
	const updatedClaude = tickChecklist(
		readFile(claudePath),
		"0d",
		"Phase 0 complete — call `dforge_module_create({ moduleDir: \"...\", ... })` to scaffold the module.",
	);

	return {
		summary: "Phase 0d validation complete — all checks passed. readyToScaffold: true.",
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
