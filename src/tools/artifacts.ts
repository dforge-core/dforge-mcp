// Phase 0 artifact tools. These produce the pre-scaffold documents and track
// their state in .dforge-artifacts.json:
//
//   0a  dforge_module_init      → CLAUDE.md            (identityAt + identity)
//   0b  dforge_requirements_write → docs/REQUIREMENTS.md (requirementsAt)
//   0c  dforge_design_write     → docs/DESIGN.md        (designAt)
//   0d  dforge_design_validate  → docs/VALIDATION.md    (verifiedAt)
//
// Each phase gates the next, and dforge_module_create is gated on verifiedAt —
// so the whole 0a→0b→0c→0d ordering holds even when the dforge-mcp-author skill
// is not loaded and the agent is only following tool descriptions/returns.

import * as path from "node:path";
import * as fs from "node:fs";
import { z } from "zod";
import { readJsonOrDefault, jsonText, makeResult, type ToolResult } from "./_helpers";
import { buildClaudeMd, type ModuleIdentity, type ModuleStatus } from "./claude-md";

interface ArtifactsState extends ModuleStatus {
	// Identity captured at Phase 0a, reused to re-render CLAUDE.md and to run
	// identity-consistency checks in Phase 0d without re-asking the user.
	code?: string;
	displayName?: string;
	description?: string;
	dependencies?: string[];
	locales?: string[];
}

function stateFilePath(moduleDir: string): string {
	return path.join(path.resolve(moduleDir), ".dforge-artifacts.json");
}

function today(): string {
	return new Date().toISOString().slice(0, 10);
}

function identityOf(state: ArtifactsState): ModuleIdentity {
	return {
		code: state.code ?? "",
		displayName: state.displayName ?? state.code ?? "",
		description: state.description,
		dependencies: state.dependencies,
		locales: state.locales,
	};
}

/** Render CLAUDE.md reflecting the current artifact state (identity + status). */
function claudeMdFor(state: ArtifactsState): string {
	return buildClaudeMd(identityOf(state), state);
}

// ── Phase 0a — Identity / CLAUDE.md ──────────────────────────────────────────

export const moduleInitSchema = {
	moduleDir: z
		.string()
		.describe(
			"Absolute path to the module directory (need not exist yet — will be created by dforge_module_create later).",
		),
	code: z
		.string()
		.regex(/^[a-z][a-z0-9_-]*$/)
		.describe("Module code, e.g. 'purchase_orders'. Lowercase, digits, underscore, hyphen; first char a letter. Becomes the DB schema name."),
	displayName: z.string().min(1).describe("Human-readable module name, e.g. 'Purchase Orders'."),
	description: z.string().optional().describe("Optional one-line description of the module."),
	dependencies: z
		.array(z.string())
		.optional()
		.describe(
			"Other dForge modules this depends on (e.g. ['crm']). 'admin' and 'metadata' are platform-implicit — omit them. Defaults to none.",
		),
	locales: z
		.array(z.string())
		.optional()
		.describe("Locales to ship translations for, e.g. ['en-US', 'uk-UA']. Defaults to ['en-US']."),
};

export function moduleInit(args: z.infer<z.ZodObject<typeof moduleInitSchema>>): ToolResult {
	const stateFile = stateFilePath(args.moduleDir);
	const prev = readJsonOrDefault<ArtifactsState>(stateFile, {});

	const newState: ArtifactsState = {
		...prev,
		code: args.code,
		displayName: args.displayName,
		description: args.description,
		dependencies: args.dependencies,
		locales: args.locales,
		identityAt: prev.identityAt ?? today(),
	};

	return makeResult(
		"CLAUDE.md written (Phase 0a). NEXT: show CLAUDE.md to the user, then begin Phase 0b intake — ask the requirements questions in free-form prose, one at a time. Call dforge_requirements_write only AFTER you have drafted REQUIREMENTS.md and the user has reviewed and approved it.",
		{
			"CLAUDE.md": claudeMdFor(newState),
			".dforge-artifacts.json": jsonText(newState),
		},
	);
}

// ── Phase 0b — Requirements ──────────────────────────────────────────────────

export const requirementsWriteSchema = {
	moduleDir: z
		.string()
		.describe(
			"Absolute path to the module directory (need not exist yet — will be created by dforge_module_create later).",
		),
	content: z.string().describe("Full markdown content for docs/REQUIREMENTS.md."),
};

export function requirementsWrite(
	args: z.infer<z.ZodObject<typeof requirementsWriteSchema>>,
): ToolResult {
	const stateFile = stateFilePath(args.moduleDir);
	const state = readJsonOrDefault<ArtifactsState>(stateFile, {});

	if (!state.identityAt) {
		throw new Error(
			"Module identity not established. Call dforge_module_init (Phase 0a) to write CLAUDE.md before writing requirements.",
		);
	}

	// Requirements changed → any prior validation/scaffold is stale.
	const newState: ArtifactsState = {
		...state,
		requirementsAt: today(),
		verifiedAt: undefined,
		scaffoldedAt: undefined,
	};

	return makeResult(
		"docs/REQUIREMENTS.md written (Phase 0b). STOP — present the full document to the user and wait for explicit approval. Do NOT call dforge_design_write until the user has reviewed and approved the requirements.",
		{
			"docs/REQUIREMENTS.md": args.content,
			"CLAUDE.md": claudeMdFor(newState),
			".dforge-artifacts.json": jsonText(newState),
		},
	);
}

// ── Phase 0c — Design ────────────────────────────────────────────────────────

export const designWriteSchema = {
	moduleDir: z.string().describe("Absolute path to the module directory."),
	content: z.string().describe("Full markdown content for docs/DESIGN.md."),
};

export function designWrite(args: z.infer<z.ZodObject<typeof designWriteSchema>>): ToolResult {
	const stateFile = stateFilePath(args.moduleDir);
	const state = readJsonOrDefault<ArtifactsState>(stateFile, {});

	if (!state.requirementsAt) {
		throw new Error(
			"Requirements document not found. Call dforge_requirements_write before dforge_design_write.",
		);
	}

	// Design changed → any prior validation/scaffold is stale.
	const newState: ArtifactsState = {
		...state,
		designAt: today(),
		verifiedAt: undefined,
		scaffoldedAt: undefined,
	};

	return makeResult(
		"docs/DESIGN.md written (Phase 0c). STOP — present the full document to the user and wait for explicit approval. Then run Phase 0d: call dforge_design_validate to cross-check CLAUDE.md / REQUIREMENTS / DESIGN. Scaffolding stays blocked until 0d passes with no open findings.",
		{
			"docs/DESIGN.md": args.content,
			"CLAUDE.md": claudeMdFor(newState),
			".dforge-artifacts.json": jsonText(newState),
		},
	);
}

// ── Phase 0d — Validation ────────────────────────────────────────────────────

export const designValidateSchema = {
	moduleDir: z.string().describe("Absolute path to the module directory."),
	findings: z
		.array(
			z.object({
				id: z.string().describe("Short check id, e.g. 'persona-coverage'."),
				title: z.string().describe("Human-readable check name."),
				status: z
					.enum(["pass", "fail"])
					.describe("'fail' = an open gap, flaw, or inconsistency that blocks scaffolding."),
				detail: z.string().describe("What you checked and what you found."),
				proposedFix: z
					.string()
					.optional()
					.describe("For a failing check: which document to change and how."),
			}),
		)
		.describe(
			"Your assessment of the Phase 0d semantic checks (persona→entity coverage, core-process coverage, entity traceability, status-machine completeness, action completeness, seed-data coverage, gap resolution, etc.). Run the SKILL.md Phase 0d checklist and record one entry per check. Structural checks are added automatically.",
		),
};

interface Finding {
	id: string;
	title: string;
	status: "pass" | "fail";
	detail: string;
	proposedFix?: string;
}

export function designValidate(
	args: z.infer<z.ZodObject<typeof designValidateSchema>>,
): ToolResult {
	const root = path.resolve(args.moduleDir);
	const state = readJsonOrDefault<ArtifactsState>(stateFilePath(args.moduleDir), {});

	if (!state.designAt) {
		throw new Error(
			"Design document not found. Call dforge_module_init → dforge_requirements_write → dforge_design_write before dforge_design_validate.",
		);
	}

	const requirements = readTextOrEmpty(path.join(root, "docs", "REQUIREMENTS.md"));
	const design = readTextOrEmpty(path.join(root, "docs", "DESIGN.md"));

	// Deterministic structural checks (conservative — only FAIL on a concrete
	// detected problem, never on "couldn't parse", to avoid false blocks).
	const structural = structuralChecks(state, requirements, design);

	// Merge machine findings with the agent's recorded semantic findings.
	const all: Finding[] = [...structural, ...(args.findings as Finding[])];
	const open = all.filter((f) => f.status === "fail");

	const report = renderValidationReport(all, open.length === 0);
	const files: Record<string, string> = { "docs/VALIDATION.md": report };

	if (open.length === 0) {
		const newState: ArtifactsState = { ...state, verifiedAt: today() };
		files["CLAUDE.md"] = claudeMdFor(newState);
		files[".dforge-artifacts.json"] = jsonText(newState);
		return makeResult(
			`Phase 0d passed — all ${all.length} checks consistent. docs/VALIDATION.md written; scaffolding is now unblocked. Present the report to the user, then call dforge_module_create.`,
			files,
		);
	}

	// Blocked: leave verifiedAt unset, refresh CLAUDE.md (0d still open).
	files["CLAUDE.md"] = claudeMdFor({ ...state, verifiedAt: undefined });
	const list = open.map((f) => `  • ${f.title}: ${f.detail}`).join("\n");
	return makeResult(
		`Phase 0d BLOCKED — ${open.length} open finding(s). Scaffolding stays blocked. Fix the relevant document (re-call dforge_requirements_write / dforge_design_write), then re-run dforge_design_validate until it passes:\n${list}`,
		files,
	);
}

function readTextOrEmpty(absPath: string): string {
	return fs.existsSync(absPath) ? fs.readFileSync(absPath, "utf8") : "";
}

/** Extract the body of a `## Heading` section up to the next `## ` heading. */
function section(md: string, heading: RegExp): string {
	const lines = md.split(/\r?\n/);
	const start = lines.findIndex((l) => /^##\s/.test(l) && heading.test(l));
	if (start === -1) return "";
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) {
		if (/^##\s/.test(lines[i])) {
			end = i;
			break;
		}
	}
	return lines.slice(start + 1, end).join("\n");
}

function structuralChecks(
	state: ArtifactsState,
	requirements: string,
	design: string,
): Finding[] {
	const out: Finding[] = [];

	// 1. Documents are present and substantive (not empty stubs).
	const reqOk = requirements.trim().length > 50;
	const designOk = design.trim().length > 50;
	out.push({
		id: "docs-present",
		title: "Requirements & design documents present",
		status: reqOk && designOk ? "pass" : "fail",
		detail:
			reqOk && designOk
				? "Both docs/REQUIREMENTS.md and docs/DESIGN.md exist on disk with content."
				: `Missing or empty: ${[!reqOk && "docs/REQUIREMENTS.md", !designOk && "docs/DESIGN.md"].filter(Boolean).join(", ")}. Write them before validating.`,
		proposedFix:
			reqOk && designOk
				? undefined
				: "Re-run dforge_requirements_write / dforge_design_write and ensure the client wrote the files to disk.",
	});

	// 2. Identity consistency: the docs should reference this module's identity
	// (fails only when NEITHER the code nor the display name appears anywhere —
	// a strong signal the docs describe a different module).
	if ((reqOk || designOk) && (state.code || state.displayName)) {
		const haystack = `${requirements}\n${design}`.toLowerCase();
		const code = (state.code ?? "").toLowerCase();
		const name = (state.displayName ?? "").toLowerCase();
		const mentioned = (!!code && haystack.includes(code)) || (!!name && haystack.includes(name));
		out.push({
			id: "identity-consistency",
			title: "Documents reference the module identity",
			status: mentioned ? "pass" : "fail",
			detail: mentioned
				? `Requirements/design reference '${state.displayName}' (\`${state.code}\`).`
				: `Neither the module code '${state.code}' nor display name '${state.displayName}' (from CLAUDE.md) appears in REQUIREMENTS.md or DESIGN.md — the documents may describe a different module.`,
			proposedFix: mentioned
				? undefined
				: "Confirm CLAUDE.md identity matches the requirements/design and correct whichever is wrong.",
		});
	}

	// 3. Every entity referenced in the Relationship Map exists in the Entity List.
	if (designOk) {
		const entityList = parseEntityList(section(design, /Entity List/i));
		const referenced = parseRelationshipEntities(section(design, /Relationship Map/i));
		const missing = [...referenced].filter((e) => entityList.size > 0 && !entityList.has(e));
		// Only fail when we positively parsed an entity list AND found a reference
		// to something not in it — otherwise stay silent (format variance).
		if (entityList.size > 0 && missing.length > 0) {
			out.push({
				id: "relationship-entities",
				title: "Relationship map references known entities",
				status: "fail",
				detail: `Relationship map references entit${missing.length === 1 ? "y" : "ies"} not in the Entity List: ${missing.join(", ")}.`,
				proposedFix:
					"Add the missing entit(ies) to the Entity List in DESIGN.md, or correct the relationship map.",
			});
		} else {
			out.push({
				id: "relationship-entities",
				title: "Relationship map references known entities",
				status: "pass",
				detail:
					entityList.size === 0
						? "No machine-parseable Entity List; relying on your recorded findings for entity coverage."
						: "Every entity in the relationship map appears in the Entity List.",
			});
		}
	}

	// 3. Every Gaps & Proposals item carries a resolution marker.
	if (designOk) {
		const gaps = section(design, /Gaps\s*&?\s*Proposals/i);
		const unresolved = unresolvedGaps(gaps);
		if (unresolved.length > 0) {
			out.push({
				id: "gaps-resolved",
				title: "All design gaps resolved",
				status: "fail",
				detail: `${unresolved.length} gap(s) in the Gaps & Proposals section have no recorded resolution.`,
				proposedFix:
					"For each gap, add a 'Resolved:'/'Confirmed:'/'Deferred:' note (or remove it) in DESIGN.md, then re-validate.",
			});
		} else if (gaps.trim().length > 0) {
			out.push({
				id: "gaps-resolved",
				title: "All design gaps resolved",
				status: "pass",
				detail: "Every Gaps & Proposals item has a recorded resolution.",
			});
		}
	}

	return out;
}

/** Pull lowercase snake_case entity codes from the Entity List section. */
function parseEntityList(body: string): Set<string> {
	const set = new Set<string>();
	for (const line of body.split(/\r?\n/)) {
		// Match a leading entity code: "- customer — ...", "`customer` — ...",
		// "| customer |", etc. First snake_case token on the line.
		const m = line.match(/^[\s*\-|]*`?([a-z][a-z0-9_]*)`?\s*[—\-:|]/);
		if (m) set.add(m[1]);
	}
	return set;
}

/** Pull entity codes on both sides of `child.col → parent.col` relationship lines. */
function parseRelationshipEntities(body: string): Set<string> {
	const set = new Set<string>();
	const re = /([a-z][a-z0-9_]*)\.\w+\s*(?:→|->|=>)\s*([a-z][a-z0-9_]*)\.\w+/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(body)) !== null) {
		set.add(m[1]);
		set.add(m[2]);
	}
	return set;
}

/** Bullet lines in a Gaps section that lack a resolution keyword. */
function unresolvedGaps(body: string): string[] {
	const resolved = /(resolved|confirmed|deferred|accepted|won['’]t fix|n\/a)\b/i;
	return body
		.split(/\r?\n/)
		.filter((l) => /^\s*[-*]\s+\S/.test(l) || /\*\*Gap:\*\*/i.test(l))
		.filter((l) => !resolved.test(l));
}

function renderValidationReport(findings: Finding[], passed: boolean): string {
	const fails = findings.filter((f) => f.status === "fail");
	const passes = findings.filter((f) => f.status === "pass");
	const line = (f: Finding) =>
		`- **${f.title}** (\`${f.id}\`) — ${f.detail}${f.proposedFix ? `\n  - _Fix:_ ${f.proposedFix}` : ""}`;

	return `# Validation Report — Phase 0d
<!-- generated by dforge_design_validate — re-run after any change to REQUIREMENTS.md or DESIGN.md -->

**Result:** ${passed ? "✅ PASS — ready to scaffold" : `❌ BLOCKED — ${fails.length} open finding(s)`}
**Validated:** ${today()}

${
	fails.length > 0
		? `## ❌ Open findings (${fails.length})\n\n${fails.map(line).join("\n")}\n`
		: ""
}## ✅ Passing checks (${passes.length})

${passes.map(line).join("\n")}
`;
}

// ── Shared helper (re-exported for use in create-module / inspect gates) ──────

export function readArtifactsState(moduleDir: string): ArtifactsState {
	return readJsonOrDefault<ArtifactsState>(stateFilePath(moduleDir), {});
}
