---
name: dforge-mcp-author
description: Author dForge modules using the dforge-mcp tool surface. Use when the user has the @dforge-core/dforge-mcp MCP server connected and asks to scaffold, extend, pack, or install a dForge module. Replaces hand-writing JSON files with structured tool calls that produce schema-valid output on the first try.
---

# dForge Module Author (MCP-driven)

You're authoring a dForge module via the `dforge-mcp` MCP server. dForge is a metadata-driven, multi-tenant business platform — modules are JSON metadata + DSL scripts.

**Your edge here** is that you have *tools*, not just text generation. Always prefer a tool call over writing a file by hand. Every tool either returns a file map (so the user can preview before commit) or shells out to the validated native CLI.

---

## Tool surface

| Tool | What it does | Returns |
|---|---|---|
| `dforge_module_create` | Build a brand-new module's file map | `{ files: {...} }` — client writes |
| `dforge_entity_add` | Add an entity to an existing module | `{ files: {...}, warning?: ... }` — client writes |
| `dforge_module_pack` | Pack a module dir into a `.dforge` tarball | `{ tarballPath, sizeBytes }` (writes the tarball) |
| `dforge_module_install` | Install a module to a tenant | `{ ok, output }` (live action) |
| `dforge_dbml_import` | Generate from DBML (stub) | not yet implemented |

## Resources

Read these *before* generating any module content so your output matches the canonical schema. Don't memorise — load each on demand when you're about to write that kind of file.

| URI | What it covers |
|---|---|
| `dforge://schema/manifest` | manifest.json — required fields, semver, dependencies, `entities` map, `tags` |
| `dforge://schema/entity` | entities/*.json — `description`, `dbObject`, `toString`, `traits`, `fields` |
| `dforge://schema/data-views` | ui/data_views.json — `viewType` enum, `dataSources[]` (with per-source `filter` + `order`), `viewConfig` per view type, the canonical `filter` shape (`{c,o,v}` or `{g,i:[]}`) |
| `dforge://schema/folders` | ui/folders.json — folder tree, per-entity view bindings, icon, color |
| `dforge://schema/menus` | ui/menus.json — menus + items (with nested `children` for sections), `itemType: V/D/R/null` |
| `dforge://schema/roles` | security/roles.json — role → entity → rights string (`SIUDC` or `E`) |
| `dforge://schema/jobs` | logic/jobs.json — cron + action binding for the scheduler |
| `dforge://schema/seed-data` | seed-data/*.json — initial rows inserted at install |
| `dforge://schema/settings` | settings.json — `fieldTypeCd`, `defaultValue`/`formula`, `params` per setting |
| `dforge://schema/reports` | ui/reports.json — `layout.panels[]`, `datasets` (Q/S types), filter reuse |
| `dforge://schema/traits` | reference for entity trait codes |
| `dforge://schema/webhooks` | ui/webhooks.json — outbound webhooks |
| `dforge://docs/conventions` | naming, FK+Reference pattern, traits cheat sheet, security model |

---

## Standard workflow

### 1. Gather requirements (one short turn)

Ask the user, in order:
1. **What's the module for?** One sentence is enough.
2. **What's the module code?** Lowercase, hyphen-or-underscore, e.g. `crm`, `pm`, `hr-admin`.
3. **What entities does it own?** Rough list with one-line descriptions each.
4. **Greenfield or extending an existing module?** If extending, ask which.

Don't ask about field types, view layouts, or DSL actions yet — those come *after* a working skeleton.

### 2. Read the schemas + conventions

Pull `dforge://schema/manifest`, `dforge://schema/entity`, and `dforge://docs/conventions` into context. Skim, don't memorise.

### 3. Call `dforge_module_create`

Pass:
- `code`, `displayName`, `description` from the user's answers
- `entities`: array of `{ name, label, traits }` — default traits to `"identity+audit"`
- `preset`: `"minimal"` unless the user wants full template (settings/translations/seed)
- `dependencies`: usually `["admin", "metadata"]` — both are required for typical modules

You'll get back `{ summary, files: { "<relPath>": "<contents>", ... } }`.

### 4. Preview the file map with the user

Show the file list (paths only) + the manifest contents. Ask "write these to `./<code>`?". Don't write without confirmation.

### 5. Write the files

Use your filesystem tool (Write / bash heredoc / fs.writeFileSync, whatever your client offers). Each value in `files` is the literal file contents — including JSON indentation. Don't re-format.

### 6. Iterate

Use `dforge_entity_add` to add more entities incrementally — it reads the existing manifest, regenerates the dependent UI/security files, and returns ONLY the files that change. Re-preview each time before writing.

For fields, ref columns, actions, formulas, settings, reports — write those directly into the entity JSON / new files under `logic/`, `ui/`, etc. The schemas are your guide; the tools don't (yet) cover field-level changes.

### 7. Pack + install

Once the module is shaped right:
1. `dforge_module_pack` with `moduleDir: "./<code>"` → returns the tarball path.
2. (Optional) `dforge_module_install` with `pathOrTarball: <tarballPath or moduleDir>` and a `tenantUrl` + `token` (or rely on `DFORGE_URL`/`DFORGE_TOKEN` env). This runs the *full* server-side validator — the only validator available. Surface its output verbatim; if it fails, fix and re-pack.

---

## Hard rules

- **Always preview file maps before writing.** Tools return — the user decides.
- **Use `dforge_entity_add`, not regenerate-from-scratch.** It preserves the existing manifest's UUID, version, dependencies, etc.
- **Tabs in JSON.** All emitted files use `\t` indentation. Don't re-pretty-print with spaces.
- **Don't invent `code` or `moduleId`.** `code` comes from the user; `moduleId` is auto-generated by the tool (UUID). Never hand-write a UUID.
- **Refer to the conventions doc for FK+Reference, traits, flags.** The MCP server doesn't enforce these — your output does. The first install will catch violations, but a clean first install is the goal.

---

## When NOT to use the tools

- **Modifying a single existing field in an entity JSON.** Just edit the file.
- **Writing an action DSL script.** No tool for that — write to `logic/actions/<name>.dsl` directly. Reference the `dforge://docs/conventions` doc for DSL syntax.
- **Querying live tenant state.** No tool for that either — shell out to `dforge-cli` via your bash tool if the user has it installed.

---

## Sanity check before declaring done

- `dforge_module_pack` succeeded → archive size is non-trivial (>100 KB usually)
- `dforge_module_install --code <tenant>` exited 0 → server validated everything
- The user confirms the install log looks right (entities created, no warnings about missing translations / orphan rights)
