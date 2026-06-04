// Single source of truth for a module's CLAUDE.md. Rendered by the Phase 0
// artifact tools (dforge_module_init / requirements / design / validate) and by
// dforge_module_create, so the file always reflects the current module status.
//
// CLAUDE.md is loaded automatically by Claude Code at session start: future
// sessions on this module directory pick up MCP-first discipline AND the current
// phase without the user re-explaining anything. Keep this the only place that
// knows the file's shape — both artifacts.ts and create-module.ts import it, so
// it must not import from either (would create a cycle).

export interface ModuleIdentity {
	code: string;
	displayName: string;
	description?: string;
	dependencies?: string[];
	locales?: string[];
}

/** Phase timestamps. A set value means that phase has completed. */
export interface ModuleStatus {
	identityAt?: string;
	requirementsAt?: string;
	designAt?: string;
	verifiedAt?: string;
	scaffoldedAt?: string;
}

function box(done: boolean): string {
	return done ? "[x]" : "[ ]";
}

function stamp(at?: string): string {
	return at ? ` — ${at}` : "";
}

/** The next action the agent should take, derived from which artifacts exist. */
function nextStep(s: ModuleStatus): string {
	if (s.scaffoldedAt) return "Authoring (Phases 1–6) — extend via the `dforge_*` patch tools";
	if (!s.requirementsAt)
		return "Phase 0b — run intake, then `dforge_requirements_write`; let the user review REQUIREMENTS.md before continuing";
	if (!s.designAt)
		return "Phase 0c — design the schema, then `dforge_design_write`; let the user review DESIGN.md before continuing";
	if (!s.verifiedAt)
		return "Phase 0d — `dforge_design_validate`; resolve every finding before scaffolding";
	return "Phase 1 — `dforge_module_create` to scaffold the module files";
}

/**
 * Render CLAUDE.md for a module. `status` drives the live "Module status"
 * checklist; pass `{}` for a brand-new identity with nothing else done yet.
 */
export function buildClaudeMd(identity: ModuleIdentity, status: ModuleStatus = {}): string {
	const { code, displayName, description } = identity;
	const deps =
		identity.dependencies && identity.dependencies.length > 0
			? identity.dependencies.join(", ")
			: "None";
	const locales =
		identity.locales && identity.locales.length > 0 ? identity.locales.join(", ") : "en-US";
	const descLine = description ? `\n${description}\n` : "";

	return `# ${displayName} — dForge Module
${descLine}
This is a **dForge module** managed via the \`dforge-mcp\` MCP server.

## For AI assistants working in this directory

- **Run \`dforge_module_inspect\` at session start.** Do not read entity JSON files directly to infer structure — inspect returns the full authoritative state, including the module status below.
- **Never edit module files directly.** Use the \`dforge_*\` MCP tools — they validate inputs, apply changes, and keep the manifest in sync automatically.
- **Never invent field types, flags, or schemas.** Load \`dforge://docs/conventions\` and the relevant \`dforge://schema/*\` resource before authoring any file type.
- **Use the \`dforge-mcp-author\` skill** for any authoring or modification work here. It enforces the phased flow: 0a identity → 0b requirements → 0c design → 0d validation → scaffold → behaviour/views/security.

## Module identity

| | |
|---|---|
| Code | \`${code}\` |
| Display name | ${displayName} |
| Dependencies | ${deps} |
| Locales | ${locales} |

## Module status

<!-- Maintained by the dforge-mcp Phase 0 tools — regenerated on each phase; do not hand-edit. -->

- ${box(!!status.identityAt)} **0a** Identity & CLAUDE.md${stamp(status.identityAt)}
- ${box(!!status.requirementsAt)} **0b** Requirements — \`docs/REQUIREMENTS.md\`${stamp(status.requirementsAt)}
- ${box(!!status.designAt)} **0c** Design — \`docs/DESIGN.md\`${stamp(status.designAt)}
- ${box(!!status.verifiedAt)} **0d** Validation — \`docs/VALIDATION.md\`${stamp(status.verifiedAt)}
- ${box(!!status.scaffoldedAt)} **1** Scaffolded — module files${stamp(status.scaffoldedAt)}

**Next step:** ${nextStep(status)}

## Pack and install

- Pack:    \`dforge_module_pack\`    → produces a \`.dforge\` tarball
- Install: \`dforge_module_install\` → installs to a live tenant (the real validator)

Install needs \`DFORGE_URL\` and \`DFORGE_TOKEN\` environment variables.

## Module layout

- \`manifest.json\` — module id, code, version, dependencies
- \`entities/*.json\` — one file per entity
- \`logic/actions/*.dsl\` — action DSL scripts
- \`ui/data_views.json\`, \`ui/menus.json\`, \`ui/folders.json\`, \`ui/actions.json\`
- \`security/roles.json\`
- \`seed-data/*.json\` — numbered for load order (01-, 02-, …)
- \`translations/<locale>.json\` — e.g. \`en-US.json\`
- \`docs/REQUIREMENTS.md\`, \`docs/DESIGN.md\`, \`docs/VALIDATION.md\` — Phase 0 artifacts
`;
}
