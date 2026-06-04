# @dforge-core/dforge-mcp

MCP server for dForge module authoring. Exposes 18 composable tools and the canonical schemas so AI agents (Claude Code, Cursor, Zed, etc.) can drive the full module lifecycle — scaffold → entities → actions → views → security → install — through structured tool calls instead of free-form JSON generation.

Ships with a wizard Skill (`skills/dforge-mcp-author/`) that walks the AI through six phases with explicit backtrack support when later phases expose earlier gaps. The skill bundle includes 22 detailed reference files (field types, flags, traits, formulas, DSL, security, etc.) and an annotated `simple-todo` example module.

**New here?** Start with **[docs/creating-modules.md](docs/creating-modules.md)** — three ways to scaffold a module (terminal CLI, VS Code sidebar, AI wizard) and when to pick each.

> **Two GitHub repos to know:** this MCP server lives at `dforge-core/dforge-mcp`. The dForge platform itself (entities, validator, native CLI source) lives at `iash44/dForge-core` — referenced in `homepage` because the schemas + DSL conventions come from there.

## What it depends on at runtime

```
your AI editor (Claude Code / Cursor / Zed)
    │
    ▼ stdio JSON-RPC
@dforge-core/dforge-mcp       ← this package; pure JS / TS
    │
    ▼ shells out for pack / install
@dforge-core/dforge-cli        ← installed as a transitive dep; thin JS wrapper
    │
    ▼ optionalDependencies
@dforge-core/dforge-cli-<platform>   ← native C# binary per platform (~35 MB)
```

The native binary actually talks to your tenant. The npm-CLI wrapper is just a launcher that picks the right platform binary and exec's it. **You don't need to install dforge-cli separately** — it comes along when you install dforge-mcp (or when `npx -y @dforge-core/dforge-mcp` runs cold).

If you want to use a hand-built native binary instead of the npm-shipped one, point `DFORGE_CLI_BINARY` at the executable file's absolute path:

```bash
DFORGE_CLI_BINARY=/Users/me/projects/dForge-core/cli/bin/dForge.Cli
```

(macOS / Linux: no extension. Windows: `dForge.Cli.exe`.) If the path doesn't exist or isn't executable the server reports an error at the first pack/install call.

## Install + wire into Claude Code

### Recommended — via `claude mcp add` (writes ~/.claude.json for you)

```bash
claude mcp add dforge --scope user -- npx -y @dforge-core/dforge-mcp
```

This appends to `~/.claude.json` (the global config — single file in your home dir, no subdirectory). Restart Claude Code; on the first session that activates the server you'll see "Approve MCP server 'dforge'?" — accept it.

### Manual — per-project

Write `.mcp.json` at **the repo root** (not under `.claude/`):

```json
{
  "mcpServers": {
    "dforge": {
      "command": "npx",
      "args": ["-y", "@dforge-core/dforge-mcp"],
      "env": {
        "DFORGE_CLI_BINARY": "/optional/abs/path/to/dForge.Cli"
      }
    }
  }
}
```

Restart Claude Code → approve on first prompt.

### Verify it's alive

```bash
claude mcp list
# Should show: dforge — npx -y @dforge-core/dforge-mcp — connected
```

Or inside a Claude Code session, type `/mcp` to see all connected servers + their tools. The 18 `dforge_*` tools should be listed.

### Cursor / Zed

Same `command + args` config shape; check their docs for the file location. Verification is via their respective tool listings.

## What it exposes

### Tools (20)

Grouped by typical phase in the wizard flow. All "return" tools emit `{ summary, files: { '<relPath>': '<contents>' } }`; the client decides whether to write — lets the AI preview diffs with the user before committing.

**Pre-scaffold (Phase 0)** — a hard-gated chain: each tool refuses until the prior one has run, so the requirements → design → validation flow can't be skipped.
| Tool | Behavior |
|---|---|
| `dforge_module_init` | **0a** — write `CLAUDE.md` (identity + MCP-first rules + live status tracker) and record identity. First step for a new module; required before requirements |
| `dforge_requirements_write` | **0b** — write `docs/REQUIREMENTS.md`, then pause for user review. Requires `dforge_module_init` first |
| `dforge_design_write` | **0c** — write `docs/DESIGN.md`, then pause for user review. Requires `dforge_requirements_write` first |
| `dforge_design_validate` | **0d** — validate REQUIREMENTS + DESIGN, report every gap/flaw/inconsistency to `docs/VALIDATION.md`; records `verifiedAt` only when clean. **Gates `dforge_module_create`** |

**Module-level**
| Tool | Behavior |
|---|---|
| `dforge_module_create` | New module scaffold. Blocked until Phase 0d (`dforge_design_validate`) passes |
| `dforge_module_inspect` | Read current module state. Full structured data is in `files["_inspect.json"]`; `summary` is one-line stats |
| `dforge_module_pack` | Shells to `dforge-cli module pack`. Returns tarball path + size |
| `dforge_module_install` | Shells to `dforge-cli module install`. Args: `pathOrTarball`, optional `tenantUrl` / `token` / `tenantCode` — fall back to `DFORGE_URL` / `DFORGE_TOKEN` env. `tenantCode` is an optional `--code` sanity check the server cross-references against the JWT |

**Entities (Phase 1)**
| Tool | Behavior |
|---|---|
| `dforge_entity_add` | Add an entity to an existing module |
| `dforge_entity_field_add` | Patch a single field |
| `dforge_entity_field_modify` | Replace a field's spec |
| `dforge_entity_field_remove` | Drop a field (warns about dependents) |

**Behavior (Phase 2 — optional)**
| Tool | Behavior |
|---|---|
| `dforge_action_add` | DSL script + `ui/actions.json` entry |

**Views + reports (Phase 3)**
| Tool | Behavior |
|---|---|
| `dforge_view_add` | Add a data view |
| `dforge_view_modify` | Replace a view's spec |
| `dforge_report_add` | Add a report |
| `dforge_setting_add` | Configurable module-level setting |

**Security (Phase 5)**
| Tool | Behavior |
|---|---|
| `dforge_role_add` | Add a role + rights matrix. **Fails if role already exists** — the scaffolder pre-creates `<code>.admin`, so use `role_right_set` to amend it instead |
| `dforge_role_right_set` | Grant/revoke one right on one object (cheap backtrack) |
| `dforge_folder_add` | Add a security folder (optional — most modules ship with just root) |

**Cross-cutting**
| Tool | Behavior |
|---|---|
| `dforge_dependency_add` | Add a dep on another dForge module |
| `dforge_dbml_import` | Stub — not implemented yet |

### Resources (13)

| URI | Content |
|---|---|
| `dforge://schema/manifest` | manifest.json JSON Schema |
| `dforge://schema/entity` | entity files |
| `dforge://schema/data-views` | ui/data_views.json |
| `dforge://schema/folders` | ui/folders.json |
| `dforge://schema/menus` | ui/menus.json |
| `dforge://schema/roles` | security/roles.json |
| `dforge://schema/jobs` | logic/jobs.json |
| `dforge://schema/seed-data` | seed-data/*.json |
| `dforge://schema/reports` | ui/reports.json |
| `dforge://schema/settings` | settings.json |
| `dforge://schema/traits` | entity trait codes |
| `dforge://schema/webhooks` | ui/webhooks.json |
| `dforge://docs/conventions` | MODULE_CONVENTIONS.md |

Schemas + conventions are vendored at build time from `iash44/dForge-core`'s `docs/`. The published npm tarball ships them under `resources/`, and jsdelivr serves them at:

```
https://cdn.jsdelivr.net/npm/@dforge-core/dforge-mcp@latest/resources/schemas/<name>.schema.json
```

**Compatibility:** schemas vendored for this release came from `iash44/dForge-core` `main` as of the publish date stamped in `package.json`. If the platform adds new entity properties / field types after this release, generated modules using those features may validate locally but be rejected at install time. Bump the dforge-mcp version when the platform schemas change materially.

## Claude Skill — the wizard

The skill bundle lives at `skills/dforge-mcp-author/` and contains:

| Path | Contents |
|---|---|
| `SKILL.md` | Six-phase co-pilot wizard |
| `references/*.md` | 22 detailed reference files (field types, flags, traits, formulas, DSL, security, views, menus, translations, …) |
| `examples/simple-todo/` | Annotated reference module showing all core patterns |

**It is NOT auto-installed by `npm install`** — the skill ships in the npm tarball but Claude Code looks for skills in `~/.claude/skills/`, not in `node_modules`. Sync the whole bundle manually:

```bash
# Resolve the actual latest published version from the npm registry,
# then pin the jsdelivr URL to it. We don't use jsdelivr's `@latest`
# alias directly — that CDN endpoint caches aggressively (6-12h lag
# after a new publish), which silently serves stale Skill content.
VERSION=$(npm view @dforge-core/dforge-mcp version)
BASE="https://cdn.jsdelivr.net/npm/@dforge-core/dforge-mcp@${VERSION}/skills/dforge-mcp-author"

# Wizard
mkdir -p ~/.claude/skills/dforge-mcp-author
curl -fsSL "$BASE/SKILL.md" -o ~/.claude/skills/dforge-mcp-author/SKILL.md

# Reference files (22 guides — load on demand per the table in SKILL.md)
mkdir -p ~/.claude/skills/dforge-mcp-author/references
for f in action-dsl column-types conventions data-migration data-views \
          field-types filters flags formulas jobs manifest menus \
          number-sequences print-templates queries reports schema-import \
          security settings traits translations validation-checklist; do
  curl -fsSL "$BASE/references/${f}.md" \
    -o ~/.claude/skills/dforge-mcp-author/references/${f}.md
done

# simple-todo example
mkdir -p ~/.claude/skills/dforge-mcp-author/examples/simple-todo/{entities,logic/actions,ui,security,seed-data}
for f in README.md manifest.json; do
  curl -fsSL "$BASE/examples/simple-todo/$f" \
    -o ~/.claude/skills/dforge-mcp-author/examples/simple-todo/$f
done
# … entity, ui, security, seed-data files follow the same pattern

# Or, straight from GitHub main (always fresh, but pre-release content):
# curl -fsSL https://raw.githubusercontent.com/dforge-core/dforge-mcp/main/skills/dforge-mcp-author/SKILL.md \
#   -o ~/.claude/skills/dforge-mcp-author/SKILL.md
```

> **Note on CLAUDE.md:** Every module gets a `CLAUDE.md` in its root, written by `dforge_module_init` at Phase 0a (and refreshed by each later phase). It tells Claude Code that the directory is a dForge module, instructs it to use the `dforge-mcp-author` skill, describes the module layout, and carries a live **Module status** tracker (which phase is done) so future sessions resume accurately. No manual installation needed — it's part of the tool output.

Re-run after every dforge-mcp upgrade — the skill version isn't checked at runtime, so a stale skill against new tools will misroute calls.

The phases:

| Phase | Required? | Tools used |
|---|---|---|
| 0. Intake | yes | (brief written manually) |
| 1. Domain | yes | `module_create`, `entity_add`, `entity_field_*` |
| 2. Actions | optional | `action_add` |
| 3. Views + Reports | views yes, reports optional | `view_*`, `report_add`, `setting_add` |
| 4. Polish (translations, seed) | optional | (file map authored directly) |
| 5. Security | roles required, folders optional | `role_add`, `role_right_set`, `folder_add` |
| 6. Verify | yes | `module_pack`, `module_install` |

Key principles encoded in the Skill: inspect-before-patch, one-at-a-time, deterministic backtrack on earliest-phase-first rule, tool-failure protocol that distinguishes auth/connectivity from module defects, end-of-session cleanup user-driven.

## For maintainers

### Local development

```bash
pnpm install
pnpm build          # tsup → dist/server.js (bundles SDK + zod + dforge-cli/templates)
pnpm typecheck      # tsc --noEmit
node dist/server.js # stdio JSON-RPC — pipe a request to smoke-test
```

To iterate against an in-tree `dforge-cli`, temporarily pin the dep at the sibling path:

```bash
sed -i '' 's|"@dforge-core/dforge-cli": "\^0.1.[0-9.]*"|"@dforge-core/dforge-cli": "file:../dforge-cli"|' package.json
rm -rf node_modules pnpm-lock.yaml && pnpm install
# Flip back before publish — file: deps don't resolve for npm consumers.
```

### Refresh vendored resources

When `dForge-core/docs/schemas/`, `MODULE_CONVENTIONS.md`, or the skill reference files change:

```bash
scripts/vendor-resources.sh                              # auto-locate ../dForge-core
DFORGE_CORE=/abs/path/to/dForge-core scripts/vendor-resources.sh
```

This syncs three things:
1. **JSON schemas** (`resources/schemas/`) — served as MCP resources via `dforge://schema/*`
2. **Conventions doc** (`resources/docs/conventions.md`) — served as `dforge://docs/conventions`
3. **Skill reference files** (`skills/dforge-mcp-author/references/`) — 22 Markdown guides, read on demand from disk by Claude

Republish to update jsdelivr-served schemas + the bundled resources + the skill reference files.

### Publishing

```bash
scripts/publish.sh 0.1.0-rc.N --tag latest --otp <code>
```

`prepublishOnly` runs `tsup` so the tarball gets a fresh `dist/server.js`. No platform binaries to manage.

**Pre-publish checklist:**
- [ ] `@dforge-core/dforge-cli` dep is a real version (not `file:...`)
- [ ] `pnpm typecheck` passes
- [ ] Smoke test stdio: `tools/list` returns 18 tools
- [ ] Skill updated for any new/changed tools (it's a SEPARATE artifact; users sync it manually after upgrades)

### Adding a new tool

1. Drop it in `src/tools/<name>.ts`. Use shared helpers from `src/tools/_helpers.ts` (`loadManifest`, `readJsonOrDefault`, `jsonText`, `makeResult`, `withTodayStamp`). Return a `ToolResult`.
2. Import + register in `src/server.ts` via the `envelope()` wrapper.
3. Mention it in `skills/dforge-mcp-author/SKILL.md` (which phase, which backtrack scenarios use it).
4. Bump `package.json` version, publish.

Conventions:
- Return file maps relative to the module root. Don't write to disk.
- Reject if the target key already exists (force users to call the matching `*_modify` / `*_remove`).
- Bump `manifest.updated` on every patch.

## License

MIT.
