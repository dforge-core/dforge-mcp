# @dforge-core/dforge-mcp

MCP server for dForge module authoring. Exposes 34 composable tools and the canonical schemas so AI agents (Claude Code, Cursor, Zed, etc.) can drive the full module lifecycle — scaffold → entities → actions → views → security → install — through structured tool calls instead of free-form JSON generation.

Ships with **four Claude Skills** (`skills/`): a router plus one skill per lifecycle stage — design (Phase 0), build (Phases 1-5), and ship (Phase 6). The router directory carries 25 reference files (field types, flags, traits, formulas, DSL, security, etc.) and two annotated example modules.

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

The server also bundles **`@dforge-core/metadata`** — the canonical, dependency-free registry of field types, traits, column types, and the JSON schemas (the same package the dForge app, SDK, and VS Code extension use). It's the source of truth for the authoring-time validation below (valid `fieldTypeCd` / `columnType` / trait codes, `dbDatatype` derivation) and for the vendored schemas. Bundled at build time, so there's nothing extra to install.

If you want to use a hand-built native binary instead of the npm-shipped one, point `DFORGE_CLI_BINARY` at the executable file's absolute path:

```bash
DFORGE_CLI_BINARY=/Users/me/projects/dForge-core/cli/bin/dForge.Cli
```

(macOS / Linux: no extension. Windows: `dForge.Cli.exe`.) If the path doesn't exist or isn't executable the server reports an error at the first pack/install call.

For AI-assisted module repair, Phase 6 is intentionally tool-driven: the skill runs `dforge_module_validate`, `dforge_module_pack`, and `dforge_module_install` itself. If install fails because the module is invalid, the install tool returns the raw CLI/server output plus `exitCode` and `command`; the AI reads that output, fixes the referenced module files, and repeats validate → pack → install. User action is needed only for environment failures such as missing CLI, missing/expired credentials, an unreachable tenant/API, permissions, or an invalid path.

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

Or inside a Claude Code session, type `/mcp` to see all connected servers + their tools. The 34 `dforge_*` tools should be listed.

### Cursor / Zed

Same `command + args` config shape; check their docs for the file location. Verification is via their respective tool listings.

## What it exposes

### Tools (34)

Grouped by typical phase in the wizard flow. All "return" tools emit `{ summary, files: { '<relPath>': '<contents>' } }`; the client decides whether to write — lets the AI preview diffs with the user before committing.

Phase 0 (identity → requirements → design → validation) is orchestrated by the **`dforge_module_plan`** tool together with the `dforge-mcp-author` skill: the tool tracks progress from the on-disk `docs/` artifacts and gates scaffolding, while the AI authors those artifacts under its direction.

**Module-level**
| Tool | Behavior |
|---|---|
| `dforge_module_plan` | **Lifecycle orchestrator** — drives Phase 0 (identity → requirements → design → validation), gates `dforge_module_create` until `readyToScaffold: true`, then tracks Phases 1-6 via a ledger in `docs/phase.json`. `action: "check"` returns `currentPhase` + `nextSkill`; `complete_phase` records a phase done or skipped. Call first in any session |
| `dforge_module_create` | New module scaffold (blocked until Phase 0 passes) |
| `dforge_module_import` | Import a normalized **table-spec** (tables → columns → relationships) into an existing module as entities. Infers `fieldTypeCd` from SQL type / sample values / name (metadata-validated, `dbDatatype` derived) and builds the FK+Reference pair per relationship. Fed by DBML/SQL, Excel/CSV, or a hand-authored spec |
| `dforge_module_inspect` | Read current module state. Full structured data is in `files["_inspect.json"]`; `summary` is one-line stats |
| `dforge_module_validate` | Offline check (run before pack): dangling FK targets, missing hidden-FK columns, view/menu/role refs to non-existent things, uncovered entities, **field-spec rules re-run across every field**, `toString` templates, Formula-vs-Generated set aggregates, missing action DSL files, triggers/jobs firing non-existent actions, DSL static checks, and translation completeness. Errors + warnings in `files["_validate.json"]` |
| `dforge_module_pack` | Shells to `dforge-cli module pack` via bundled CLI, PATH fallback, or `DFORGE_CLI_BINARY`. Returns tarball path + size |
| `dforge_module_install` | Shells to `dforge-cli module install`. Args: `pathOrTarball`, optional `tenantUrl` / `token` / `tenantCode` — fall back to `DFORGE_URL` / `DFORGE_TOKEN` env. Returns `ok`, `exitCode`, `command`, and raw CLI `output` so the AI can fix install-time module defects and retry |

**Entities (Phase 1)**
| Tool | Behavior |
|---|---|
| `dforge_entity_add` | Add an entity to an existing module. `traits` accepts the full platform set — identity, audit, audit-full, soft-delete, sorting, postable, accumulation, ledger, period |
| `dforge_entity_rename` | **Refactor-safe entity rename** — moves the file (see `deletes`), cascades the PK `{old}_id → {new}_id`, repoints link.entity / references / view entityCode / role keys / action entity / folder bindings / seed |
| `dforge_entity_delete` | **Refactor-safe entity delete** — drops the file + seed (see `deletes`), manifest entry, role key, folder binding, view sources; warns on dangling cross-entity FKs |
| `dforge_entity_field_add` | Patch a single field |
| `dforge_entity_field_modify` | Replace a field's spec (same name) |
| `dforge_entity_field_rename` | **Refactor-safe rename** — propagates the new name to the paired Reference, formulas, view columns + order, seed data, and other entities' FKs |
| `dforge_entity_field_remove` | **Refactor-safe remove** — cascade-cleans paired Reference, view columns + order, seed keys; warns on formula/cross-entity dependents |

**Composite entity tools (Phase 1) — one call per concept, prefer these**

Each of these spans several coordinated keys that hand-assembly gets wrong. They exist so the broken shapes aren't expressible.

| Tool | Emits |
|---|---|
| `dforge_entity_reference_add` | A whole relation: hidden FK (`cuid`/`EM`) **+** Reference column (`R`/`lookup`/`link`) **+** the `references` entry. The documented #1 source of broken modules, in one call. Also completes a half-built relation by reusing an FK an import already created |
| `dforge_entity_rollup_add` | A child total as a **Generated** (`G`) column — never a Formula, whose set-aggregates silently render empty — creating the parent's Set column if needed, and refusing to aggregate a virtual `F`/`R`/`S` child (`column old.<field> does not exist`) |
| `dforge_entity_status_add` | A dropdown with `params.options` objects and the initial value as a `formula` — entity fields have no `defaultValue` key |

The field/entity tools validate against the `@dforge-core/metadata` registry: an unknown `fieldTypeCd` (e.g. `integer`, `reference`), `columnType`, or trait code is rejected at authoring time with a "did you mean" hint, and `dbDatatype` is auto-derived from the field type (currency → `numeric(18,2)`, text → `varchar`; reference/formula columns get none) unless you set it explicitly.

**Behavior (Phase 2 — optional)**
| Tool | Behavior |
|---|---|
| `dforge_action_add` | DSL script + `ui/actions.json` entry. Runs the DSL static checker first — errors reject the call |
| `dforge_action_check` | Statically check a **draft** `dslBody` before committing, or an `actionCode` already on disk. Catches `TODAY()` in `execute:`, `[field]` in batch/job context, block order, top-level `return`, `:param` placeholders, unknown host functions |
| `dforge_trigger_add` | DB-event trigger in `logic/triggers.json` (entity event + optional condition → action) |
| `dforge_job_add` | Scheduled job in `logic/jobs.json` (5-field cron + timeout + action) |
| `dforge_webhook_add` | Outbound webhook in `logic/webhooks.json` (entity event → POST to endpoint) |

**Views, menus + reports (Phase 3)**
| Tool | Behavior |
|---|---|
| `dforge_view_add` | Add a data view |
| `dforge_view_modify` | Replace a view's spec |
| `dforge_menu_add` | Add a menu leaf or section. Validates `dataViewCode` against `data_views.json`, emits `itemType: "V"` on leaves only, and normalizes icons to the bare form menus require (strips `bi-`) |
| `dforge_report_add` | Add a report |

**Polish (Phase 4)**
| Tool | Behavior |
|---|---|
| `dforge_setting_add` | Configurable module-level setting |
| `dforge_translation_sync` | Generate/refresh `translations/<locale>.json` from the module's own contents. Never overwrites existing translated text; fills the role labels that are **completeness-enforced at install**. Defaults to en-US + every `supportedLocales` entry |
| `dforge_seed_add` | Write a seed file for one entity. Enforces numeric `{entity}_id` PKs, parent-before-child load order, `audit-full` System-user columns, and FKs that point at seeded parents |

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
| `dforge_dbml_import` | **DBML front-end** to `module_import` — parses DBML (Table blocks, typed columns, inline + top-level refs) into the table-spec, drops the source PK (identity provides `{entity}_id`), and imports. Pass `module` for a greenfield import |

### Writing files: preview vs `apply`

Every patch tool returns `{ summary, files, deletes? }` for the client to write, so the agent can preview a diff with the user first. Passing **`apply: true`** instead writes the files (and honours `deletes`) directly and returns only the paths touched.

```jsonc
// preview (default) — full file contents come back through the model's context
{ "moduleDir": "/path/to/mod", "entityName": "order", "fieldName": "note", "field": { ... } }

// apply — writes to disk, returns { applied: true, written: [...], deleted: [...] }
{ "moduleDir": "/path/to/mod", "entityName": "order", "fieldName": "note", "field": { ... }, "apply": true }
```

Use `apply` for routine patches inside an already-approved plan, and for every `rename`/`delete` refactor — it guarantees the `deletes` half is applied, which is easy to drop by hand. It refuses to write outside `moduleDir`, and never writes the `_inspect.json` / `_validate.json` / `_action_check.json` report payloads, which only reuse the file-map shape for transport.

### Resources

Served over MCP with descriptions and mime types, so the agent can tell what a URI is for before pulling it.

| URI pattern | Content |
|---|---|
| `dforge://schema/<name>` | JSON Schemas: `manifest`, `entity`, `domains`, `data-views`, `folders`, `menus`, `roles`, `jobs`, `seed-data`, `traits`, `webhooks`, `triggers`, `print-templates`, `settings`, `reports` |
| `dforge://reference/<name>` | 25 per-element authoring references — schema shape + worked example + common-mistakes list for one element type |
| `dforge://example/<path>` | Files from the canonical `simple-todo` module (mandatory structure validators) |
| `dforge://example/matrix-budget/<path>` | Files from the `matrix` (pivot) view example |
| `dforge://docs/conventions` | MODULE_CONVENTIONS.md |
| `dforge://docs/dsl` | Full action-DSL grammar, built-ins, patterns, anti-patterns |
| `dforge://script/xlsx-to-model` | Stdlib Python `.xlsx` → table-spec extractor |

Schemas + conventions are vendored at build time from `iash44/dForge-core`'s `docs/`. The published npm tarball ships them under `resources/`, and jsdelivr serves them at:

```
https://cdn.jsdelivr.net/npm/@dforge-core/dforge-mcp@latest/resources/schemas/<name>.schema.json
```

**Compatibility:** schemas vendored for this release came from `iash44/dForge-core` `main` as of the publish date stamped in `package.json`. If the platform adds new entity properties / field types after this release, generated modules using those features may validate locally but be rejected at install time. Bump the dforge-mcp version when the platform schemas change materially.

## Claude Skills — router + three stage skills

Authoring guidance ships as **four** skills, split by lifecycle stage. Each stage needs a different half of the knowledge base — Phase 0 needs none of the field-type/DSL detail, Phase 6 needs none of the intake guardrails — so loading only the active stage is what keeps a full module build inside one context window.

| Skill | Phases | Owns |
|---|---|---|
| `dforge-mcp-author` | — | **Router. Start here.** Calls `dforge_module_plan` to find the current phase and hands off. Also carries the shared `references/` + `examples/`. |
| `dforge-module-design` | 0a–0d | Identity, intake guardrails, design doc, pre-scaffold validation. Ends at `readyToScaffold: true`. |
| `dforge-module-build` | 1–5 | Entities, behavior, views/menus, polish, security. Loading-policy table, core-rules cheat sheet, backtrack protocol. |
| `dforge-module-ship` | 6 | Validate → pre-pack review → version audit → pack → install-fix loop. |

The handoff is deterministic rather than vibes-based: `dforge_module_plan({ action: "check" })` returns `currentPhase` **and** `nextSkill`, derived from the Phase 0 artifacts, the phase ledger in `docs/phase.json`, and evidence read from the module itself (entities without fields, entities without a view, entities without a Select grant).

The router directory also holds the shared assets:

| Path | Contents |
|---|---|
| `references/*.md` | 25 reference files (field types, flags, traits, formulas, DSL, security, views, menus, translations, …) |
| `examples/simple-todo/` | Annotated reference module showing all core patterns |
| `examples/matrix-budget/` | Worked example for the `matrix` (pivot) view type |
| `scripts/xlsx_to_model.py` | Stdlib Python `.xlsx` → table-spec extractor |

**Skills are NOT auto-installed by `npm install`** — they ship in the npm tarball, but Claude Code looks in `~/.claude/skills/`, not `node_modules`. Use the installer, which is a Node script so it behaves identically on **Windows (cmd.exe / PowerShell), macOS, Linux, Git Bash and WSL**:

```bash
# Straight from the published package — no clone needed:
npx -y -p @dforge-core/dforge-mcp dforge-install-skills

# From a local checkout:
npm run install-skills

# Equivalently, without npm:
node scripts/install-skills.mjs [--from-npm]
```

Destination resolution, in order: `DEST` → `CLAUDE_CONFIG_DIR/skills` → `<home>/.claude/skills`. The home directory comes from Node's `os.homedir()`, so on Windows it's `%USERPROFILE%` no matter which shell invoked it.

```bash
DEST=/path/to/skills npm run install-skills
```

<details>
<summary>Windows notes</summary>

- **cmd.exe / PowerShell**: `npm run install-skills` works directly. There is no bash requirement.
- **WSL**: run it from *Windows*, not inside WSL — inside WSL, `os.homedir()` is the Linux home (`/home/you`), so the skills would land where a Windows Claude Code never looks. If you deliberately run Claude Code inside WSL, then installing from WSL is correct.
- `--from-npm` shells out to `tar`, built into Windows 10 1803+ (and macOS/Linux). Without it, clone the repo and run the installer without `--from-npm`.
- `scripts/install-skills.sh` still exists and works (it just execs the Node script), so the older `curl … | bash` one-liner keeps working on macOS/Linux/Git Bash.

</details>

It replaces each skill directory wholesale — a stale reference file left behind is worse than a missing one, because the agent will happily author against it.

**Re-run after every dforge-mcp upgrade.** The skill version isn't checked at runtime, so stale skills against new tools will misroute calls.

> **Note on CLAUDE.md:** Every module gets a `CLAUDE.md` in its root, authored during Phase 0a (the AI drafts it; you write it) and kept current as later phases complete. It tells Claude Code that the directory is a dForge module, points at the skills, describes the module layout, and carries a live **Module status** tracker so future sessions resume accurately.

The phases:

| Phase | Required? | Skill | Tools used |
|---|---|---|---|
| 0. Identity / requirements / design / validation | yes | design | `module_plan` |
| 1. Domain | yes | build | `module_create`, `entity_add`, `entity_field_*`, `entity_reference_add`, `entity_rollup_add`, `entity_status_add`, `module_import`, `dbml_import` |
| 2. Behavior | optional | build | `action_add`, `action_check`, `trigger_add`, `job_add`, `webhook_add` |
| 3. Views + menus, reports | 3a yes, rest optional | build | `view_*`, `menu_add`, `report_add` |
| 4. Polish | optional | build | `setting_add`, `translation_sync`, `seed_add` |
| 5. Security | 5a yes, folders optional | build | `role_add`, `role_right_set`, `folder_add` |
| 6. Verify | yes | ship | `module_validate`, `module_pack`, `module_install` |

Key principles encoded in the skills: inspect-before-patch, one-at-a-time, composite-tools-first, deterministic backtrack on the earliest-phase-first rule, a tool-failure protocol that distinguishes auth/connectivity from module defects, and user-driven end-of-session cleanup.

## For maintainers

### Local development

```bash
pnpm install
pnpm build          # tsup → dist/server.js (bundles SDK + zod + dforge-cli/templates + metadata)
pnpm typecheck      # tsc --noEmit
pnpm test           # vitest — validation + dbDatatype derivation + trait flow
node dist/server.js # stdio JSON-RPC — pipe a request to smoke-test
```

To iterate against an in-tree `dforge-cli`, temporarily pin the dep at the sibling path:

```bash
sed -i '' 's|"@dforge-core/dforge-cli": "\^0.2.[0-9.]*"|"@dforge-core/dforge-cli": "file:../dforge-cli"|' package.json
rm -rf node_modules pnpm-lock.yaml && pnpm install
# Flip back before publish — file: deps don't resolve for npm consumers.
```

### Refresh vendored resources

**Schemas** (`resources/schemas/`) are copied from the installed **`@dforge-core/metadata`** package — bumping that dep is how you pick up schema changes. They're served as MCP resources via `dforge://schema/*` and, in the published tarball, via jsdelivr.

```bash
pnpm sync-schemas      # node script — cross-platform (Windows/macOS/Linux)
```

You rarely run this by hand: **`prepublishOnly` runs it automatically**, so every publish regenerates the schemas from the exact metadata version this package depends on — they can't silently drift. The schemas are committed, so consumers always have them regardless.

`scripts/vendor-resources.sh` is a Unix convenience wrapper around the same Node script, and it additionally can pull the **conventions doc + skill reference files** from `dForge-core` — but only when `VENDOR_REFS=1`:

```bash
VENDOR_REFS=1 scripts/vendor-resources.sh   # also pull conventions + skill refs from ../dForge-core
```

**That ref pull is off by default on purpose:** the per-topic references under `skills/dforge-mcp-author/references/` are authored in this repo and are ahead of `dForge-core/skills/dforge-module-author/`, so an unguarded pull would clobber them. Only set `VENDOR_REFS=1` once you've confirmed core is the source of truth for those files. (This part is bash-only; on Windows use WSL/Git Bash for the ref pull — schema refresh via `pnpm sync-schemas` is native.)

### Publishing

```bash
scripts/publish.sh 0.1.0-rc.N --tag latest --otp <code>
```

`prepublishOnly` runs `tsup` so the tarball gets a fresh `dist/server.js`. No platform binaries to manage.

**Pre-publish checklist:**
- [ ] `@dforge-core/dforge-cli` dep is a real version (not `file:...`)
- [ ] `pnpm typecheck` passes
- [ ] `pnpm test` passes
- [ ] Smoke test stdio: `tools/list` returns 27 tools
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
