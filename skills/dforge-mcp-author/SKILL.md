---
name: dforge-mcp-author
description: Wizard-style guide for authoring dForge modules via the dforge-mcp tool surface. Use when the user has @dforge-core/dforge-mcp connected and asks to scaffold, extend, pack, or install a dForge module. Walks the user through six phases (intake → entities → actions → views/reports → security → polish & install) using small composable tools, with explicit support for backtracking when later phases reveal earlier mistakes.
---

# dForge Module Author — Wizard

You're authoring a dForge module via MCP. Drive the user through six phases. Each phase has explicit preconditions, exit criteria, and a backtrack protocol when later work exposes an earlier gap.

## Tools you have

| Phase | Tool | What it does |
|---|---|---|
| any | `dforge_module_inspect` | dump current state — call BEFORE any patch so you know what exists |
| 1 | `dforge_module_create` | scaffold a new module (file map, client writes) |
| 1 backtrack | `dforge_entity_add` | add an entity to existing module |
| 1/2 backtrack | `dforge_entity_field_add`, `_modify`, `_remove` | patch fields without regenerating the entity |
| 2 | `dforge_action_add` | DSL action + ui/actions.json entry |
| 3 | `dforge_view_add`, `dforge_view_modify` | data views in ui/data_views.json |
| 3 | `dforge_report_add` | report in ui/reports.json |
| 4 | `dforge_setting_add` | configurable module setting |
| 5 | `dforge_role_add`, `dforge_role_right_set` | roles + per-object rights |
| 5 (optional) | `dforge_folder_add` | nested security folders |
| any | `dforge_dependency_add` | add a dep on another dForge module |
| 6 | `dforge_module_pack` | produce .dforge tarball (needs dforge-cli on PATH) |
| 6 | `dforge_module_install` | install to a tenant — the real validator |

## Resources to read once per session

Pull these into context at session start (they're the source of truth):

- `dforge://docs/conventions` — naming, FK+Reference pattern, traits cheat sheet, security model
- `dforge://schema/manifest`, `entity`, `data-views`, `folders`, `menus`, `roles`, `reports`, `settings`, `jobs`, `seed-data` — JSON Schemas, consult before emitting any file

## Hard rules (always)

- **Tools return file maps. Preview before writing.** Show the user paths + key contents, get confirmation, then your file-write tool actually writes.
- **One entity / view / role at a time.** Never generate a 12-entity module in one shot. Cement intent before bulk emission.
- **Inspect before patching.** Call `dforge_module_inspect` at the start of every session and after any backtrack.
- **Tabs in JSON, trailing newline.** All tools emit this already — don't reformat.
- **Don't invent fields.** Real fields come from the user's domain, real entity codes from `manifest.entities`. No hallucinated FKs.

## Phase 0 — Intake (required, ~2-3 turns)

**Preconditions:** none.

**Goal:** capture the essentials, fast. Don't interrogate.

**Ask, in one turn if possible:**

1. One-sentence purpose ("what does this module do?")
2. Target user roles (rough list, e.g. "sales reps + sales managers"). If only one role, security stays trivial.
3. Existing dForge modules to extend or depend on? (`admin` + `metadata` are implicit.)
4. Language scope. Default English-only; ask only if user has prior locales.

**Capture in a brief.** Write to `_brief/00-intake.md` in the would-be module dir (or current dir if module doesn't exist yet):

```markdown
# <module-code> — intake

**Purpose**: ...
**Users**: ...
**Dependencies**: admin, metadata, ...
**Languages**: en (default)
**Success criteria** (if mentioned): ...
```

**Exit criteria:** brief written, user confirms it captures intent.

## Phase 1 — Domain (required, looping)

**Preconditions:** intake brief exists.

**Goal:** entity inventory + per-entity design.

**Steps:**

1. **Inventory.** Propose a list of entity names + one-line descriptions. Get user sign-off. Write to `_brief/01-domain-inventory.md`.
2. **Scaffold the module.** Call `dforge_module_create` with the inventory's entity list. Preview file map, write on approval.
3. **Per-entity loop.** For each entity:
   - Read `dforge://schema/entity` if you haven't this session.
   - Propose fields + traits + references. Use FK+Reference pattern per `dforge://docs/conventions` (hidden FK column with `flags: "EM"` + visible Reference column with `columnType: "R"`, `flags: "VEM"`, `link: { entity: "...", otherKey: "..." }`).
   - Numerable entities (orders, invoices, quotes) need `numberSequence: { column, defaultPrefix, pattern, resetPeriod }` — see real modules for patterns.
   - Use `dforge_entity_field_add` (or `entity_add` for new entities post-create) in a loop. ONE field at a time when nuanced; batch obvious fields.
4. **Extension entities last.** If extending other modules' entities (e.g. `crm.quote` for a `crm-fin` bridge), the entity file uses `extends: "module.entityCode"` and `toString: null` (inherits base toString). Manifest key uses dotted form.

**Exit criteria:** every entity has at least PK + audit traits + 1 user-visible field; FK references resolve; manifest's `entities` map reflects reality.

## Phase 2 — Actions (optional)

**Preconditions:** entities settled.

**Goal:** business-logic operations as DSL scripts.

**Skip this phase entirely** if the module is pure CRUD. Don't fabricate actions.

**When you DO need them:**
- Read the DSL reference section of `dforge://docs/conventions`.
- For each action: define `params:`, optional `canExecute:`, required `execute:` block.
- Use `dforge_action_add` with the full DSL body. Pick `mode`: `single` (most common), `each` (per-record loop with record context), `batch` (explicit `for x in records` in DSL).

**Exit criteria:** every action you added compiles cleanly at install time (Phase 6 validates).

## Phase 3 — Views + Reports (views required, reports optional)

**Preconditions:** entities settled.

**Goal:** at least one default grid per entity; specialised views/reports where they add value.

**Steps:**

1. **Default grids.** For each entity, call `dforge_view_add` with `viewType: "grid"` and `dataSources: [{ entityCode: <entity>, columns: [...] }]`. Use `viewName: "default"` per real-module convention.
2. **Specialised views.** Propose only when they materially help — kanban for status pipelines, calendar for date-bound records, list with `levels` for parent-child drilldown, tree-grid for self-referencing hierarchies. Each requires `viewType`-specific `viewConfig` — read `dforge://schema/data-views`.
3. **Reports** (optional). Use when management needs aggregation/grouping the views don't cover. `dforge_report_add` takes a layout (panels) + datasets (Query type with entityCd + filter + sort, OR Stored Procedure type). Pull `dforge://schema/reports`.

**Exit criteria:** every entity has a default view; user agrees the specialised views/reports cover their stated use cases.

## Phase 4 — Polish I: Settings + Translations + Seed (optional)

**Preconditions:** module structure stable.

**Goal:** make the module configurable and locale-aware where needed.

- **Settings**: configurable per-folder values (number prefixes, default currency, etc.). `dforge_setting_add` per setting. Use `fieldTypeCd` matching the kind of value.
- **Translations**: only when intake declared non-English locales. Files go under `translations/<locale>.json` flat-key style.
- **Seed data**: only when the module needs reference data on install (lookups, default folders, etc.). Files under `seed-data/01-<name>.json` etc. — numeric prefixes for FK ordering.

**Exit criteria:** any user-visible config the user requested is exposed as a setting.

## Phase 5 — Security (roles required, folders optional)

**Preconditions:** entities + actions + reports + views all settled (you need their codes to grant rights on).

### 5a. Roles + rights matrix (required)

1. **Inventory roles.** Default for simple modules: one `<code>.admin` role with full rights on everything. If intake mentioned multiple user types, propose one role per group (e.g. `crm.sales`, `crm.manager`).
2. For each role, propose the rights matrix (entity → 'SIUDC' subset, action/report → 'E' or omit). Show as a table for user review.
3. Call `dforge_role_add` per role. Use `dforge_role_right_set` for one-off grant/revoke edits.

**Rights semantics** (additive — multiple roles UNION their rights, no revoke):
- `S` Select, `I` Insert, `U` Update, `D` Delete, `C` Clone (for entities)
- `E` Execute (for actions, reports)
- Omit an object from the rights map to deny it

### 5b. Security folders (optional)

Only if intake said data must be partitioned per folder (multi-warehouse, multi-region, multi-tenant-like). Default: no extra folders, root folder owns everything.

If needed: `dforge_folder_add` per sub-folder, passing `entities` map with `rowFilter` (string SQL expression OR `{c,o,v}` canonical filter) to enforce row-level access.

**Exit criteria:** every entity is reachable to at least one role; if folders were declared, every folder has at least one role bound via `inheritSecurity: true` or explicit rights.

## Phase 6 — Verify (required, non-skippable)

**Preconditions:** all prior phases complete.

**Goal:** prove the module installs. This is the only true validator.

1. **Pack.** Call `dforge_module_pack` to produce a `.dforge` tarball. Confirms file integrity + manifest parseability.
2. **Install.** Call `dforge_module_install` with `DFORGE_URL` + `DFORGE_TOKEN` (env or args) and a test tenant code. The server-side validator checks: manifest identifiers, translation completeness, menu/folder/entity coverage, FK target resolution, package-filter SQL, migration safety.
3. **If install fails**, the error message tells you which phase to backtrack to. Don't paper over — use the appropriate `*_modify` / `*_remove` tool to fix, then re-pack + re-install.

**Exit criteria:** install exits 0 against a real tenant.

## Backtrack protocol

When a later phase exposes a problem in an earlier phase:

1. **Stop.** Don't paper over or improvise around the missing piece.
2. **Name the issue precisely.** E.g.: "Phase 3 wants a kanban view grouped by `lead_status`, but Phase 1 didn't add a `lead_status` field to the `lead` entity."
3. **Identify which phase + decision needs revision.** "Need to backtrack to Phase 1 to add the field."
4. **Get user sign-off.** Describe the change and ask: "OK to add field X to entity Y, then resume Phase 3?"
5. **Make the patch via the smallest tool.** `entity_field_add` not full `entity_add`; `role_right_set` not `role_add`. Preserves existing work.
6. **Propagate forward.** If the change has knock-on effects (renamed field breaks role rights, removed entity breaks reports), the next `module_inspect` reveals them — fix in order.
7. **Resume.** Continue from where the current phase left off, with the new context.

**Append to `_brief/changelog.md`** after each backtrack:

```markdown
## <ISO date> — Phase N → Phase M backtrack
- Trigger: <what later phase tried to do>
- Change: <what was patched in the earlier phase>
- Affected files: <list>
```

This gives the user a paper trail of why the module looks the way it does.

## Final hygiene

- After install succeeds, optionally rm `_brief/` (it's session scratch). Or move to `docs/` if the user wants the design rationale committed.
- Suggest a `git commit` summarizing the module. Don't commit yourself unless asked.
