---
name: dforge-module-build
description: Phases 1-5 of dForge module authoring — scaffold the module, then build entities and fields, relations, roll-ups and status columns, actions/triggers/jobs/webhooks, data views and menus, reports, settings, translations, seed data, and the security roles and rights matrix. Use when dforge_module_plan reports a currentPhase of 1-5, or when adding to / fixing an existing module's entities, views, or security. Not for the design documents (dforge-module-design) or for packing and installing (dforge-module-ship).
---

# dForge module — Build (Phases 1–5)

Phase 0 is done and `readyToScaffold: true`. You're now producing the actual
module artifacts.

**Before each phase:** run `dforge_module_inspect` and parse
`files["_inspect.json"]` — never plan a patch against what you assume is there.
**After each phase:** record it with
`dforge_module_plan({ action: "complete_phase", moduleDir, phase: "N", note: "..." })`.

## Loading policy — one reference per step, at the step

**Load nothing up front.** Pull the row you need when you need it, by URI.
Re-load on every backtrack into that element type. The example files are
mandatory structure validators — never work from memory for schema shapes,
flags, or column patterns.

| When you need to… | Load (primary reference + example) | Also load |
|---|---|---|
| Add any field | `dforge://reference/field-types`, `dforge://reference/flags`, `dforge://example/entities/todo_item.json` | — |
| Add a relation / Set column | `dforge://reference/column-types`, `dforge://example/entities/todo_item.json` | — |
| Reuse a type/enum across columns (a `domain`) | `dforge://reference/column-domains` | `dforge://schema/domains` |
| Add a formula column | `dforge://reference/formulas` | — |
| Add a trait | `dforge://reference/traits` | — |
| Add a number sequence | `dforge://reference/number-sequences` | — |
| Add a grid / list view | `dforge://reference/data-views`, `dforge://example/ui/data_views.json` | — |
| Add a matrix (pivot) view | `dforge://reference/data-views` (§Matrix), `dforge://example/matrix-budget/ui/data_views.json`, `dforge://example/matrix-budget/entities/budget_line.json` | — |
| Add kanban / calendar / tree-grid / master-detail | `dforge://reference/data-views` | `dforge://schema/data-views` |
| Hide columns from a user type (column-level security) | `dforge://reference/security` (§Column-level security), `dforge://example/column-security/entities/product.json`, `dforge://example/column-security/ui/folders.json` | — |
| Add a menu | `dforge://reference/menus`, `dforge://example/ui/menus.json` | — |
| Add an action | `dforge://reference/action-dsl`, `dforge://example/logic/actions/mark_done.dsl`, `dforge://example/ui/actions.json` | `dforge://docs/dsl` |
| Add a trigger | — | `dforge://schema/triggers`; condition syntax in `dforge://docs/dsl` |
| Add a scheduled job | `dforge://reference/jobs` | `dforge://schema/jobs` |
| Add a webhook | — | `dforge://schema/webhooks` |
| Add filters (views, folders, reports) | `dforge://reference/filters` | — |
| Add roles or security folders | `dforge://reference/security`, `dforge://reference/filters`, `dforge://example/security/roles.json` | — |
| Add a report | `dforge://reference/reports` | `dforge://schema/reports` |
| Add a print template | `dforge://reference/print-templates` | — |
| Wire OCR / document extraction | `dforge://reference/document-extraction` | `dforge://docs/dsl` |
| Add / localize translations | `dforge://reference/translations` | — |
| Add module settings | `dforge://reference/settings` | — |
| Add saved queries | `dforge://reference/queries` | — |
| Import from DBML/SQL | `dforge://reference/schema-import` | — |
| Import from a spreadsheet | `dforge://reference/excel-import` | — |
| Migrate a legacy database | `dforge://reference/data-migration` | — |

## Core rules — the always-on cheat sheet

Enough to author inline; load the linked reference for the full detail.

- **Naming.** `code`, entity `dbObject`, column keys: all `snake_case`,
  case-sensitive, entities singular (`opportunity_line`). `code` = DB schema name.
- **A relation is TWO columns + a references entry.** Use
  `dforge_entity_reference_add` — it emits all three parts. → `column-types`
- **Flags** are letters from `V I E M H` only (never `U`/`S`/`P`): `VEM`
  required+visible, `VE` optional+visible, `V` read-only, `E`/`EM` hidden FK
  (optional/required), `I` trait-provided. `M` means required — it resolves to
  `isNullable: false`, so it makes the column `NOT NULL`; don't spend it as
  decoration, and never pair it with `"isNullable": true`. → `flags`
- **`fieldTypeCd` = UI control; `dbDatatype` = SQL type.** Omit `dbDatatype` on
  plain data columns — it's derived. Set it only for a hidden FK or to override
  size/precision. Common fixes: `number` not `integer`/`float`; `phone` not
  `phoneNumber`; `date` not `datePicker`; `timestamptz` not `datetime`; `bool`
  not `boolean`; `varchar`/`text` not `string`. → `field-types`
- **Formula columns** (`columnType: "F"`): `baseDatatypeCd` required, no
  `dbDatatype`, `flags: "V"`. → `formulas`
- **Roll-up totals** over a child set are Generated (`G`) columns with
  `SUM([set].[field])` — **never** Formula (`F`), whose set-aggregates silently
  render empty — and they aggregate only a **physical** child column. Use
  `dforge_entity_rollup_add`. → `column-types`
- **Column defaults** are set via `formula` (`"TODAY()"`, `"'draft'"`), a
  `numberSequence`, or DSL. Entity fields have **no** `defaultValue` key —
  that's settings-only. → `field-types`
- **Traits:** default `["identity", "audit"]`. `audit-full` adds required
  `created_by`/`last_updated_by` with no default — a seeded `audit-full` entity
  must set both to `0` in every record, or use plain `audit`. → `traits`
- **`toString`** on every entity, `{column}` braces: `"{first_name} {last_name}"`.
- **Data views:** `dataSources` array at root — never a root-level `entityCode` +
  `columns`. Sort is `"order": ["-col", "col"]`. → `data-views`
- **Menus:** leaf items use `dataViewCode` (not `viewCode`); section nodes omit
  `itemType`; icons are Bootstrap names **without** `bi-`. Use
  `dforge_menu_add`. → `menus`
- **Rights keys:** same-module entity bare (`product`); cross-module entity
  dotted (`fin.invoice`); actions/reports/folders take a **colon** —
  `action:approve`, `report:summary`, `folder:east` (never a dot). Deny by
  omitting the key, never `""`. `roles.json` carries `description` + `rights`
  only — no `label`. → `security`
- **Action `script`** in `ui/actions.json` is a bare filename (no path, no
  `.dsl`).
- **Action DSL dates:** inside `execute:` use lowercase `now()`. `TODAY()`/`NOW()`
  are formula-only and undefined in `execute:`. → `action-dsl`
- **SQL placeholders** are `@paramName`, not `:paramName`.
- **Manifest:** non-English locales go in `supportedLocales` (`ll-CC`, never
  `en`/`en-US`); there is no `translations` manifest key. `security` has both
  `roles` and `folders`. → `manifest`
- **Seed data:** explicit numeric PKs under `{entity}_id`; parents before
  children via the `NN-` prefix. Use `dforge_seed_add`.

## Phase 1 — Domain (required)

> **Fast on-ramp.** If the user already has the model in **DBML** → use
> `dforge_dbml_import`. In a **spreadsheet** → load
> `dforge://reference/excel-import`; a binary `.xlsx` must be decoded first with
> `dforge://script/xlsx-to-model` (`python3 tmp.py file.xlsx` → `{sheets:[…]}`),
> then turned into a table-spec for `dforge_module_import`. A `.csv` is plain
> text — read it directly. Both paths ADD entities; show the proposed table-spec
> for sign-off first, then run `dforge_module_validate` and refine the generated
> grids.

**This phase's first deliverable, before any tool call, is the proposed entity
inventory.** The user needs to see "the module will have these N things in it"
before files exist — entities are the spine everything else references.

```
Proposed entities (N):
- <entity_code> — <one-line purpose, tied to a verb from intake>
```

Loop with the user until they explicitly approve.

**Pre-scaffold consistency checks** against `docs/DESIGN.md` — if any fail,
surface it and go back to Phase 0c; don't silently adjust the design:

1. Every FK in the relationship map has a corresponding field on the child.
2. Every action's `canExecute` guard references a status value that exists.
3. Every seed record's FK points at a parent that is also seeded.
4. Every formula uses only fields on the same entity or exactly one FK hop away.
5. Every set aggregate is a Generated column over a physical child column.
6. Every seeded `audit-full` entity sets `created_by`/`last_updated_by: 0`.

Then: `dforge_module_create` → per-entity loop.

**Per-entity loop.** For each entity, propose fields + traits + relations, get
approval, then patch. Reach for the **composite tools first**:

- relation → `dforge_entity_reference_add`
- roll-up total → `dforge_entity_rollup_add`
- status column → `dforge_entity_status_add`
- plain scalar → `dforge_entity_field_add`

**Field batching rule** — the only Phase 1 exception to one-at-a-time. A field
is batchable only if ALL of: scalar primitive (string/integer/decimal/boolean/
date), no FK or reference, no formula, and unambiguous nullability. Everything
else goes one at a time. This never justifies batching entities, views, roles,
actions, or reports.

**Extension entities last.** `extends: "module.entity"`, `toString: null`,
dotted manifest key. Snapshot the base entity's fields with
`dforge_module_inspect` on the dependency dir when it's available locally;
otherwise document the known base fields and note that drift tracking is the
user's responsibility.

**Exit:** every entity has PK + audit traits + at least one user-visible field;
FK references resolve; the manifest's `entities` map reflects reality.

## Phase 2 — Behavior (all optional)

Four kinds of behavior, all individually skippable. **Do not fabricate behavior
to fill a sub-step** — a pure CRUD module skips Phase 2 entirely (record it with
`skipped: true`).

| Sub-step | Fires when | Tool |
|---|---|---|
| 2a Actions | user clicks a button | `dforge_action_add` |
| 2b Triggers | a DB event happens | `dforge_trigger_add` |
| 2c Jobs | a cron timer fires | `dforge_job_add` |
| 2d Webhooks | a DB event → outbound POST | `dforge_webhook_add` |

**2a Actions.** First check the action is an action at all: it must **change**
something. If the `execute:` block would only read, compute and `info()` the
answer, build a **record report** (a report with an `entities` attachment — same
toolbar entry point, but it shows the working and re-reads live data), a formula
column, or an action that writes a result record instead — a printed number is
never stored and can't be re-read (`dforge://reference/action-dsl`, *When an
action is the wrong tool*). Do not compute in DSL what a report dataset already
aggregates. Then load
all four resources in the action row — the wrong-field-access /
wrong-batch-flag / wrong-`ui/actions.json`-property mistakes only surface when
you cross-check them. Draft the DSL, run
**`dforge_action_check({ dslBody, executionMode })`** to catch install failures
before committing, then `dforge_action_add`. One action per turn.

**2b Triggers** reference actions that must already exist. `async: true` runs
after the transaction commits (use for anything slow); `async: false` runs
in-transaction, so a failure rolls back the original change.

**2c Jobs** run as the system user with **no current record** — the action must
not use `[field]` syntax. Wrap a record-context action in a thin job action that
uses `select()`/`query()` first. `timeout` is required (≤ 3600s); over 300s you
must set `jobClass: 'long_running'`. `dforge_module_validate` flags violations.

**2d Webhooks.** For authenticated endpoints, put credentials behind
`getSecret()` and reference them as `"Authorization": "$secret:<secret_cd>"`.

## Phase 3 — Views + menus (3a required), reports (optional)

**3a. Default grids first.** Every entity gets a `viewType: "grid"` view with
`dataSources: [{ entityCode, columns: [...] }]`. The scaffolder already wrote one
per entity, so you'll often `view_modify` rather than `view_add`.

View codes are semantic — the entity name (`feedback_item`), a plural
(`invoices`), or descriptive (`invoices_kanban`). **Never use the literal code
`default`.** Note that `ui/folders.json`'s `viewName` is a different axis
entirely: it binds an *entity view* (column-level security, declared under
`views` on the entity file), not a data view code. `"default"` there means "no
entity view — show the full column set", and any other name the entity does not
declare **fails the install**. See `references/security.md`.

Then wire menus with `dforge_menu_add` — a section node per group, leaves
pointing at the views.

**Do not propose any specialized view until every entity has its grid.**

**3b. Specialized views** only when an objective trigger fires:

- the user explicitly asked for the visualization;
- a status/stage/kind field with **3+ discrete values** → kanban;
- a required date/time field for scheduling → calendar;
- a self-referencing FK → tree-grid;
- a 1:N child with `parentSetField` → list-with-levels or master-detail.

If none fire, skip specialized views for that entity.

**3c. Reports** only when aggregation/grouping isn't covered by views — or when
Phase 2a sent you here because the "action" only wanted to show a number.

Params are **report-scoped**: declare them in the report-level `parameters`
block, or as shorthand under `datasets.<cd>.params` when exactly one dataset uses
the param. The installer merges both into the report's one param set, report level
winning on a collision — so a param several datasets share belongs at report level.
Grant with a **colon** key: `"report:<code>": "E"`.

A report that answers a question *about one record* takes an `entities`
attachment, which puts it on that record's toolbar with the record's values
feeding its params:

```json
"entities": [ { "entityCd": "parties.party", "params": { "customer_id": "party_id" }, "orderNum": 45 } ]
```

`entities[].params` is the **mapping** (report param → source column), not a
param declaration. Qualify a cross-module `entityCd` and declare that module as a
dependency; add `"metadata": ">=1.5.0"` too. Source columns are limited to the
PK, a reference column, or a bounded scalar. Full rules:
`dforge://reference/reports`.

**Exit:** every entity has a grid and a menu entry; every specialized view has a
stated trigger; every report's params sit on a dataset.

## Phase 4 — Polish (mostly optional)

- **Settings** — `dforge_setting_add` per configurable value the user asked for.
- **Translations** — run **`dforge_translation_sync`**. It generates every
  required key from the module's own contents, never overwrites existing
  translated text, and fills the **role labels that are completeness-enforced at
  install**. Run it after any entity/view/role change, and always before Phase 6.
  For a non-English locale the seeded values are English placeholders — tell the
  user they still need real translation.
- **Seed data** — `dforge_seed_add`, only when the module needs reference data on
  install. Parents get a lower `order` than children.

## Phase 5 — Security (5a required)

1. **Inspect first.** The scaffolder pre-created `<code>.admin` with `SIUDC` on
   every entity declared at scaffold time. It exists — don't re-create it
   (`role_add` fails on an existing code; use `role_right_set` to amend).
2. **Derive roles from the intake's user types and verbs.** Re-read the user-type
   sentences in `docs/REQUIREMENTS.md`. One role per distinct user type, named
   `<code>.<user-type>`. **Forbidden:** a generic admin/contributor/viewer matrix
   the user didn't ask for.
3. **Reflect the role list back** before computing rights. Get confirmation.
4. **Show the rights matrix as a table** (rows = entities/actions/reports,
   columns = roles, cells = rights strings), each cell explained by the verb it
   maps to. Get sign-off.
5. **Column-level security only when the intake asks for it.** Roles grant rights
   per entity, not per field. When a user type must not see specific *columns*
   (salaries, cost prices, personal data), that is an **entity view**: declare
   `views.<name>.columns` on the entity and bind it with `viewName` on the folder
   that user type works in. Don't reach for it otherwise — a view is the complete
   column list, so it is one more list to keep in step with the fields. Rules and
   the worked example: `references/security.md` → Column-level security.
5. `dforge_role_add` for new roles; `dforge_role_right_set` per grant when
   amending an existing one.

Rights are **additive** — multiple roles UNION, never revoke. Entities take any
subset of `SIUDC`; actions/reports/folders take `E`.

**5b. Security folders** only if intake said data must be partitioned
(multi-warehouse, multi-region). Default: root only.

**Folder codes must be unique across the whole tree**, not just among siblings.
A folder is addressed flat and path-less everywhere outside `ui/folders.json` —
role rights say `folder:<code>`, translations key on `folders.<code>.label` — so
two folders both coded `admin` under different parents are ambiguous in the
rights matrix and collide in the translation files. `dforge_folder_add` refuses
a duplicate and `dforge_module_validate` errors on one; name them distinctly
(`north_admin`, `south_admin`).

> ⛔ **`dforge_module_pack` refuses to build** if any entity has no role granting
> `S`. Don't lean on the gate — derive real persona roles here, and grant `E` on
> the actions/reports each persona uses.

**Exit:** every entity appears in at least one role's rights with at least `S`;
every folder declared has security mapped.

## Backtrack protocol

When a later phase exposes a problem in an earlier one, in order:

1. **Stop.** Don't paper over it.
2. **Name it precisely.** "Phase 3 wants a kanban grouped by `lead_status`, but
   Phase 1 didn't define `lead_status` on `lead`."
3. **Identify the target phase + decision.**
4. **Get user sign-off**, including cascading impacts.
5. **Apply the smallest tool that fits** — this overrides the phase labels:
   `entity_field_add` over `entity_add`; `entity_field_rename` over remove+add;
   `role_right_set` over `role_add`; `view_modify` over remove+add.
6. **Re-run `dforge_module_inspect`**, fix knock-on impacts, resume.

**Multi-trigger rule:** if several phases expose gaps at once, resolve the
**earliest-phase** gap first, complete its backtrack, re-inspect, then
re-evaluate.

**Rename and delete are handled for you** — `entity_field_rename`,
`entity_field_remove`, `entity_rename`, `entity_delete` each propagate the
cascade in one call. **Always apply the response's `deletes` as well as
`files`** (or just pass `apply: true`, which guarantees it). Each tool surfaces
what it could NOT auto-fix — reports, translations, menu labels, DSL bodies,
dangling cross-entity FKs — in `warning`. **Run `dforge_module_validate` after
any rename/delete.**

After every backtrack, append to `_brief/changelog.md`:

```markdown
## <YYYY-MM-DD> — Phase N → Phase M backtrack
- Trigger: <what the later phase tried to do>
- Change: <what was patched>
- Affected files: <list>
```

## Exit

When Phases 1, 3a and 5a are done (and 2/4 done or recorded as skipped):

1. Record each with `dforge_module_plan({ action: "complete_phase", ... })`.
2. **Hand off:** invoke the **`dforge-module-ship`** skill for Phase 6.
