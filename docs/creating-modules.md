# Creating a dForge module — three paths

dForge gives you three ways to scaffold and author a module. They all produce the same canonical file structure; pick by how much hand-holding you want.

| Path | Driver | Best for |
|---|---|---|
| [1. Terminal CLI](#path-1--terminal-manual-dforge-cli-init-module) | you, typing | you know what you're building, just want the skeleton |
| [2. VS Code sidebar](#path-2--vs-code-sidebar-manual) | you, clicking | same as #1 but launched from a button |
| [3. AI co-pilot wizard](#path-3--ai-co-pilot-wizard-driven) | Claude Code / Cursor / Zed via `dforge-mcp` | you want help designing entities + security |

## Path 1 — Terminal, manual (`dforge-cli init module`)

Pure CLI. Prompts for the basics, writes a minimal scaffold, leaves you to fill in fields / views / roles in your editor.

```bash
npx -y @dforge-core/dforge-cli init module ./my-module
```

You'll be asked for:
- module `code` (lowercase, hyphen/underscore, e.g. `feedback`)
- display name
- description, author, license, version, db schema version
- dependencies (defaults to `admin` + `metadata`)
- preset (Minimal / Minimal + add more entities interactively / Full template)
- first entity name + label + traits (identity vs identity+audit)

Output: ~10 files including `manifest.json`, `entities/<name>.json` (stub), `ui/{data_views,folders,menus,actions}.json`, `security/roles.json`, `.gitignore`, plus `.vscode/settings.json` + `.zed/settings.json` that bind the JSON schemas for inline validation.

After scaffolding, open the directory in VS Code (with [the dForge extension](https://github.com/dforge-core/dforge-editor-support) installed) and start adding fields — schemas validate in real time.

## Path 2 — VS Code sidebar, manual

Same scaffold as Path 1, just launched from a button instead of the terminal.

1. Click the dForge `d` icon in the activity bar.
2. Click the `+` button next to "Modules" view title.
3. Pick a parent folder + module name in the prompts.
4. The extension shells out to `npx -y @dforge-core/dforge-cli init module …` in the dForge terminal — same questions as Path 1.
5. Module appears in the sidebar tree once written; click any file to open it.

Sidebar also gives you right-click commands: **Pack Module**, **Install Module to Tenant**, **Validate Module (schemas)** — all wrappers around `dforge-cli`.

## Path 3 — AI co-pilot, wizard-driven

Claude Code (or Cursor / Zed) with `dforge-mcp` connected. You describe what you want; the AI walks you through six phases via MCP tool calls, pausing at each gate for your approval.

Setup once:

```bash
claude mcp add dforge --scope user -- npx -y @dforge-core/dforge-mcp
# Resolve actual latest from npm, then pin jsdelivr URL to it.
# (jsdelivr's @latest endpoint caches 6-12h; pinning the version skips that.)
VERSION=$(npm view @dforge-core/dforge-mcp version)
mkdir -p ~/.claude/skills/dforge-mcp-author
curl -fsSL "https://cdn.jsdelivr.net/npm/@dforge-core/dforge-mcp@${VERSION}/skills/dforge-mcp-author/SKILL.md" \
  -o ~/.claude/skills/dforge-mcp-author/SKILL.md
```

Restart Claude Code, approve the MCP server on first prompt, then in a new conversation:

```
You: "I want a module to collect end-user feedback on app pages."
```

The wizard runs:

### Phase 0 — Intake (required, ~1 turn)

Four questions in one message: purpose / users / dependencies / language scope.
You can accept defaults to move fast. Writes `_brief/00-intake.md`.

### Phase 1 — Domain (required, looping)

1. Proposes an entity inventory (list of names + one-liners). Get user sign-off.
2. Calls `dforge_module_create` → previews the file map → you approve → AI writes files.
3. Per-entity loop: proposes fields, calls `dforge_entity_field_add` per field. Batches obvious scalar fields; one-at-a-time for refs/formulas/nullable-ambiguous.
4. Extension entities last (those with `extends: "module.entity"`).

### Phase 2 — Actions (optional)

Asks if any business-logic operations need a DSL script. Skipped for pure CRUD modules. When needed: `dforge_action_add` per action, full DSL body composed by the AI.

### Phase 3 — Views (required) + Reports (optional)

- **3a (first):** ensures every entity has a default grid via `dforge_view_add` / `view_modify`.
- **3b (only after 3a):** proposes specialized views (kanban / calendar / list / tree-grid / master-detail) **only when an objective trigger fires** — user explicitly asked, or status field has 3+ values, or required date field for scheduling, etc.
- **3c (optional):** reports for aggregation/grouping the views don't cover.

### Phase 4 — Polish (mostly optional)

Settings (`dforge_setting_add`), translations, seed data — only if intake declared a need.

### Phase 5 — Security

- **5a (required):** inspects scaffolded `<code>.admin` role; adds extra roles via `dforge_role_add` for each additional user group from intake; amends admin via `dforge_role_right_set` for action/report grants.
- **5b (optional):** security folders with row-level filters via `dforge_folder_add` — only when intake says data must be partitioned per folder.

### Phase 6 — Verify (required, non-skippable)

1. `dforge_module_pack` → `.dforge` tarball.
2. `dforge_module_install` against your tenant (uses `DFORGE_URL` / `DFORGE_TOKEN` env or arg fallbacks). Runs the full server-side validator — the only real validator.
3. On failure, the AI follows the **backtrack protocol**: stops, names the issue, identifies the earliest broken phase, asks for sign-off, patches with the smallest tool that fits, re-inspects, resumes.

---

## Behind the scenes (same for all three paths)

All three paths produce the same canonical structure:

```
my-module/
├── manifest.json                  # module metadata
├── entities/<entity>.json         # one file per entity
├── ui/
│   ├── data_views.json            # grids, kanbans, calendars, etc.
│   ├── folders.json               # navigation + security boundaries
│   ├── menus.json                 # left-side nav
│   ├── actions.json               # action registry (DSL files live in logic/actions/)
│   └── reports.json               # report definitions (only if you have any)
├── security/
│   └── roles.json                 # role → rights matrix
├── logic/
│   ├── actions/<name>.dsl         # one DSL file per action
│   └── jobs.json                  # scheduled jobs (only if you have any)
├── settings.json                  # module-level settings (folder-scoped at runtime)
├── seed-data/                     # rows inserted at install time (optional)
├── translations/<locale>.json     # i18n (only if non-English locales declared)
├── .vscode/settings.json          # auto-binds JSON schemas → red squigglies on bad JSON
└── .zed/settings.json             # same for Zed
```

VS Code with the [dForge extension](https://github.com/dforge-core/dforge-editor-support) installed validates every JSON file against its schema as you edit, regardless of which path created the files. Pack and install commands work the same way from any path.

## Quick decision tree

| Goal | Path |
|---|---|
| "I know what I want, give me the skeleton" | **Path 1 or 2** |
| "I want help designing entities + the security model" | **Path 3** — the wizard |
| "I want to extend an EXISTING module" | **Path 3** — the wizard's patch tools (`entity_field_add`, `role_right_set`, etc.) plus the backtrack protocol shine here |
| "I'm in a terminal-only environment (SSH, remote box)" | **Path 1** |
| "I want zero typing" | **Path 2** or **Path 3** |

## Going further

- [SKILL.md](../skills/dforge-mcp-author/SKILL.md) — the full wizard spec the AI follows, including the deterministic backtrack protocol, multi-trigger priority rule, tool-failure protocol, and resume-from-partial-state support
- [README.md](../README.md) — full tool reference (18 tools, 13 resources) + maintainer docs
- [iash44/dForge-core](https://github.com/iash44/dForge-core) — the platform itself: source of truth for the schemas + DSL conventions
