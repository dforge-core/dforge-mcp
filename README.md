# @dforge-core/dforge-mcp

MCP server for dForge module authoring. Exposes a small set of composable tools and the canonical schemas so AI agents (Claude Code, Cursor, Zed, etc.) can drive the full module lifecycle — scaffold → entities → actions → views → security → install — through structured tool calls instead of free-form JSON generation.

Ships with a wizard Skill (`skills/dforge-mcp-author/SKILL.md`) that walks the AI through six phases with explicit backtrack support when later phases expose earlier gaps.

## Install

```bash
# As an MCP server invoked by an AI editor — usually no install needed,
# the editor runs it via npx on demand. See "Wiring it up" below.

# Local install (for development / debugging):
npm install -g @dforge-core/dforge-mcp
dforge-mcp                # speaks JSON-RPC over stdio; ctrl+C to quit
```

## Wiring it up

### Claude Code

Add to `~/.claude/config.json` (or the project-local `.claude/mcp.json`):

```json
{
  "mcpServers": {
    "dforge": {
      "command": "npx",
      "args": ["-y", "@dforge-core/dforge-mcp"],
      "env": {
        "DFORGE_CLI_BINARY": "/optional/path/to/dForge.Cli"
      }
    }
  }
}
```

`DFORGE_CLI_BINARY` is only needed if you want `dforge_module_pack` / `dforge_module_install` to use a non-published native binary (e.g. a local C# build). Otherwise the server uses whatever `dforge-cli` is on PATH (install via `npm install -g @dforge-core/dforge-cli`, or let npx fetch it on demand).

### Cursor / Zed

Same shape — both editors take a `command + args` MCP config. Refer to their docs for the exact file path.

## What it exposes

### Tools (18)

Grouped by typical phase in the wizard flow. All return-not-write tools emit a `{ summary, files: { '<relPath>': '<contents>' } }` map; the client decides whether to write the files (lets the AI preview diffs with the user before committing).

**Module-level**
| Tool | Behavior |
|---|---|
| `dforge_module_create` | New module scaffold — file map for the client to write |
| `dforge_module_inspect` | Read current module state from disk; returns structured summary of entities, views, roles, actions, etc. Call this BEFORE any patch |
| `dforge_module_pack` | Shells to `dforge-cli module pack`. Returns tarball path + size |
| `dforge_module_install` | Shells to `dforge-cli module install`. Runs the full server-side validator — the only real validator |

**Entities (Phase 1)**
| Tool | Behavior |
|---|---|
| `dforge_entity_add` | Add an entity to an existing module |
| `dforge_entity_field_add` | Patch a single field onto an existing entity |
| `dforge_entity_field_modify` | Replace a field's spec |
| `dforge_entity_field_remove` | Drop a field (warns about dependent views / roles / formulas) |

**Behavior (Phase 2 — optional)**
| Tool | Behavior |
|---|---|
| `dforge_action_add` | DSL script + `ui/actions.json` entry |

**Views + reports (Phase 3)**
| Tool | Behavior |
|---|---|
| `dforge_view_add` | Add a data view |
| `dforge_view_modify` | Replace a view's spec |
| `dforge_report_add` | Add a report (layout + datasets + parameters) |
| `dforge_setting_add` | Configurable module-level setting (folder-scoped at runtime) |

**Security (Phase 5)**
| Tool | Behavior |
|---|---|
| `dforge_role_add` | Add a role + per-object rights matrix |
| `dforge_role_right_set` | Grant/revoke a single right on a single object (cheap backtrack) |
| `dforge_folder_add` | Add a security folder under root or a parent path (optional — most modules ship with just the root) |

**Cross-cutting**
| Tool | Behavior |
|---|---|
| `dforge_dependency_add` | Add a dep on another dForge module (supports the `{ version, entities }` partial-coupling form) |
| `dforge_dbml_import` | Stub. Returns "not yet implemented" until the underlying CLI command lands |

### Resources (13)

Read-only context. Pull these into the conversation at session start; the wizard Skill instructs the AI to consult schemas before emitting files of each kind.

| URI | Content |
|---|---|
| `dforge://schema/manifest` | JSON Schema for manifest.json |
| `dforge://schema/entity` | JSON Schema for entity files |
| `dforge://schema/data-views` | JSON Schema for ui/data_views.json |
| `dforge://schema/folders` | JSON Schema for ui/folders.json |
| `dforge://schema/menus` | JSON Schema for ui/menus.json |
| `dforge://schema/roles` | JSON Schema for security/roles.json |
| `dforge://schema/jobs` | JSON Schema for logic/jobs.json |
| `dforge://schema/seed-data` | JSON Schema for seed-data/*.json |
| `dforge://schema/reports` | JSON Schema for ui/reports.json |
| `dforge://schema/settings` | JSON Schema for settings.json |
| `dforge://schema/traits` | JSON Schema for entity trait codes |
| `dforge://schema/webhooks` | JSON Schema for ui/webhooks.json |
| `dforge://docs/conventions` | MODULE_CONVENTIONS.md — naming, FK+Reference pattern, traits, security model |

Schemas + conventions are vendored at build time from `dForge-core/docs/`. Refresh with `scripts/vendor-resources.sh`. The published npm tarball ships them under `resources/`, and jsdelivr serves them publicly at:

```
https://cdn.jsdelivr.net/npm/@dforge-core/dforge-mcp@latest/resources/schemas/<name>.schema.json
```

The dForge VS Code extension bundles them locally (no jsdelivr dependency at runtime).

## Claude Skill — the wizard

`skills/dforge-mcp-author/SKILL.md` teaches the AI how to drive the tools as a six-phase wizard:

| Phase | Required? | Tools used |
|---|---|---|
| 0. Intake | yes | (none — captures a brief in `_brief/00-intake.md`) |
| 1. Domain (entities) | yes | `module_create`, `entity_add`, `entity_field_*` |
| 2. Actions | optional | `action_add` |
| 3. Views + Reports | views yes, reports optional | `view_add`/`_modify`, `report_add`, `setting_add` |
| 4. Polish (translations, seed) | optional | (file map authored directly) |
| 5. Security | roles required, folders optional | `role_add`, `role_right_set`, `folder_add` |
| 6. Verify | yes | `module_pack`, `module_install` |

**Key principles encoded in the Skill:**
- **Inspect before patch.** `module_inspect` is the first call in any session that touches an existing module.
- **One thing at a time.** Loop per-entity / per-view / per-role, not batch dumps.
- **Backtrack protocol.** When a later phase exposes a gap from earlier, the AI stops, names the issue, gets user sign-off, patches via the smallest tool that fits, propagates forward.
- **Changelog.** Each backtrack appends to `_brief/changelog.md` so the user has a paper trail.
- **Verify-or-it-didn't-happen.** Phase 6 install is non-skippable — it's the only true validator.

**To enable the Skill in Claude Code:**

```bash
mkdir -p ~/.claude/skills/dforge-mcp-author
curl -fsSL https://raw.githubusercontent.com/dforge-core/dforge-mcp/main/skills/dforge-mcp-author/SKILL.md \
  -o ~/.claude/skills/dforge-mcp-author/SKILL.md
# or project-local:
mkdir -p .claude/skills/dforge-mcp-author
cp <repo>/skills/dforge-mcp-author/SKILL.md .claude/skills/dforge-mcp-author/
```

## For maintainers

### Local development

```bash
pnpm install
pnpm build          # tsup → dist/server.js (bundles SDK + zod + dforge-cli/templates)
pnpm typecheck      # tsc --noEmit
node dist/server.js # smoke-test via stdio JSON-RPC
```

To iterate against an in-tree `dforge-cli`, temporarily point the dep at it:

```bash
sed -i '' 's|"@dforge-core/dforge-cli": "\^0.1.0"|"@dforge-core/dforge-cli": "file:../dforge-cli"|' package.json
rm -rf node_modules pnpm-lock.yaml && pnpm install
# Flip back before publish, otherwise the published package.json is unresolvable for consumers.
```

### Refresh vendored resources

When `dForge-core/docs/schemas/` or `MODULE_CONVENTIONS.md` change:

```bash
scripts/vendor-resources.sh                              # auto-locate ../dForge-core
DFORGE_CORE=/abs/path/to/dForge-core scripts/vendor-resources.sh
```

This refreshes `resources/schemas/` and `resources/docs/`. Republish the npm package to update jsdelivr-served schemas. The VS Code extension vendors them at its own build time, so a separate VS Code repackage is needed for that consumer too.

### Publishing to npm

```bash
scripts/publish.sh 0.1.0-rc.N --tag latest --otp <code>
```

`prepublishOnly` runs `tsup` so the published tarball gets a fresh `dist/server.js`. No platform binaries to manage — one publish covers everything.

### Adding a new tool

1. Drop it in `src/tools/<name>.ts`. Use shared helpers from `src/tools/_helpers.ts` (`loadManifest`, `readJsonOrDefault`, `jsonText`, `makeResult`, `withTodayStamp`). Return a `ToolResult`.
2. Import + register in `src/server.ts` via the `envelope()` wrapper.
3. Mention it in the wizard `SKILL.md` if it fits a phase.
4. Bump `package.json` version, publish.

Conventions:
- Return file maps relative to the module root. Don't write to disk.
- Reject if the target key already exists (force users to call the matching `*_modify` / `*_remove`).
- Bump `manifest.updated` on every patch.

## License

MIT.
