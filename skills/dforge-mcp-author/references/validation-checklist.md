# Validation Checklist

Run through this checklist **before** declaring a module complete. Do it mentally if there's no validate CLI available; run `dforge validate .` if there is.

## Top install-blockers (scan first)

These five have each caused a real install failure. Check them before the section-by-section pass:

- [ ] **DSL dates** — `execute:` blocks use lowercase `now()`, never `TODAY()`/`NOW()` (formula-only; otherwise install fails `'TODAY' is not defined`)
- [ ] **Roll-up totals** — a sum over a child set is a Formula (`F`) column with `SUM([set].[field])`, **not** a Generated (`G`) column over a virtual `F`/`R`/`S` child (otherwise `db_error: column old.<field> does not exist`)
- [ ] **Rights keys** — actions/reports/folders use a **colon** (`action:x`, `report:x`, `folder:x`); entities bare or cross-module-dotted; deny by omitting the key, never `""`
- [ ] **Manifest** — no `translations` key (auto-discovered; non-English locales go in `supportedLocales`)
- [ ] **Column defaults** — set via `formula` / `numberSequence` / DSL, never a `defaultValue` key on an entity field
- [ ] **Seed + traits** — seeded `audit-full` entities set `created_by`/`last_updated_by: 0` (System user) in every record (or use `audit` / don't seed them); otherwise install fails on the missing user columns

## Manifest

- [ ] `manifest.json` exists at the module root
- [ ] `packageFormat` is set (usually `1`)
- [ ] `moduleId` is a valid UUID and unique (not copied from another module)
- [ ] `code` is lowercase, snake_case, letters+digits+underscores only
- [ ] `version` is valid semver
- [ ] `dbSchemaVersion` is valid semver
- [ ] `displayName` and `description` are present
- [ ] `dependencies` includes `admin` (almost always required)
- [ ] Every `entities` entry points to a file that exists
- [ ] Every other content pointer (`dataViews`, `menus`, `security`, etc.) points to existing files

## Entities

For each entity:

- [ ] Has `description`, `dbObject`, `toString`
- [ ] Has `traits: ["identity", "audit"]` (or a justified exception)
- [ ] `toString` template uses only column names that exist on the entity
- [ ] Every column has `fieldTypeCd` (except for formula columns which use `baseDatatypeCd` + `columnType: "F"`)
- [ ] Every `fieldTypeCd` value is from the official catalog (see `field-types.md`)
- [ ] Every column has `flags` (valid letters: V, I, E, M, H only — no U, S, or P; see `flags.md` for meanings)
- [ ] Every column has `orderNum`
- [ ] Every column has `description`

### FK+Reference pattern

- [ ] Every reference column (`columnType: "R"`) has a paired hidden FK column
- [ ] The hidden FK column has `flags: "EM"` (not `V`, not `I`)
- [ ] The reference column has `flags: "VEM"`, `fieldTypeCd: "lookup"`, and a `link` object
- [ ] `link.entity` points to an entity that exists (in this module or a dependency)
- [ ] `link.thisKey` matches the FK column name on this entity
- [ ] `link.otherKey` matches the PK column name on the target entity
- [ ] The entity's `references` block declares the FK constraint

### Formula columns

- [ ] `columnType: "F"`
- [ ] Has `baseDatatypeCd` (required)
- [ ] Has `formula`
- [ ] Uses only known formula functions (see `formulas.md`)
- [ ] Does NOT have `dbDatatype` (formula columns are virtual)
- [ ] Flags is usually `"V"` (read-only)

### Set columns

- [ ] `columnType: "S"`
- [ ] `fieldTypeCd: "grid"` (or another set renderer)
- [ ] Has `link` with `entity`, `thisKey`, `otherKey`
- [ ] `link.otherKey` points to a real FK column on the target entity

## Data views

- [ ] Every data view has `label` and `dataSources` (`viewType` is optional — omit for grid; it defaults to `grid` at runtime)
- [ ] `dataSources` is an array, not an object
- [ ] Each source has `entityCode` and `columns`
- [ ] `entityCode` points to an entity that exists
- [ ] Column codes in `columns` all exist on the entity
- [ ] If set, `viewType` is from the supported list (`grid`, `list`, `kanban`, `calendar`, `gallery`, `tree-grid`, `diagram`, `master-detail`, `library`, `matrix`)
- [ ] A `matrix` view has a `viewConfig` with `rowAxis`, `colAxis`, and `cell` (cell `entity` matches the primary `dataSources` entity; `rowKey`/`colKey` are real cell columns)
- [ ] Sort uses the view-def-root `order` key — a `string[]` like `["-created_date", "name"]` (leading `-` = descending), NOT `sort` / `[{column_cd, direction}]` (that object shape belongs to queries & reports, not data views)

## Menus

- [ ] Menus are **nested dictionaries** with `children`, NOT arrays
- [ ] Every node has `label`
- [ ] Leaf items have `itemType` (`V`, `R`, `D`, or `A`)
- [ ] Folder nodes do **not** have `itemType`
- [ ] Leaf items with `itemType: "V"` have `dataViewCode` (NOT `viewCode`)
- [ ] Every `dataViewCode` points to a data view that exists
- [ ] Every `reportCode` points to a report that exists
- [ ] `orderNum` is set on each node for deterministic ordering

## Security

- [ ] `security/roles.json` exists (at least one role)
- [ ] Every role has `description` and `rights` (both required; no `label` field — display name comes from `description`). The `roles.schema.json` sets `additionalProperties: false`, so any extra field (including `label`) is rejected at install time.
- [ ] The field name is `rights`, NOT `entityRights`
- [ ] Rights strings use only valid letters: `SIUDC` for entities, `E` for actions/reports/folders
- [ ] Entity codes in `rights` all reference real entities (in this module or dependencies)
- [ ] At least one role has `SIUDC` on every entity (typically an admin role)

## Actions

For each action:

- [ ] Registered in `ui/actions.json` with `label`, `script`, `executionMode`, `entityCode`
- [ ] DSL file exists at `logic/actions/<script>.dsl`, where `<script>` is the bare filename in the action's `script` field (no path, no `.dsl` extension)
- [ ] DSL file has `params:`, `canExecute:`, and `execute:` blocks
- [ ] `canExecute:` is a valid formula expression
- [ ] `execute:` uses only documented built-in functions
- [ ] Referenced entities exist
- [ ] Referenced parameters are declared in `params:`

## Settings

- [ ] `settings.json` exists if the module has any settings
- [ ] Every setting has `fieldTypeCd`
- [ ] Every setting has a `defaultValue` (or is explicitly nullable) — note the field is `defaultValue`, not `default`
- [ ] Field types used are from the supported subset (no `lookup`, no `grid`)

## Seed data

- [ ] Seed files are in `seed-data/` with numbered prefixes (`01-`, `02-`, …)
- [ ] Seed files are ordered by FK dependency (parents before children)
- [ ] Seeded `audit-full` entities supply `created_by`/`last_updated_by` — `audit-full` adds these as required (cuid, NOT NULL) columns. Either set both to the System user `0` in every seed record, switch the entity to `audit`, or don't seed it. (The `audit` timestamps need no value — they default to `NOW()`.)
- [ ] Each seed file has `entityCode` and `records`
- [ ] Every record has explicit values for NOT NULL columns
- [ ] PKs are explicit **numeric integers** (e.g. 1001, 1002 — NOT UUID strings, `cuid` is int8)

## Translations

- [ ] `translations/en-US.json` exists
- [ ] Has `entities` section with `label`, `desc`, and `fields` for every entity
- [ ] Every field (including trait-provided: `created_date`, `last_updated`, etc.) has a `label`
- [ ] Has `views` section with labels for every data view
- [ ] Has `menus` section matching the `ui/menus.json` structure
- [ ] Has `actions` section with labels for every action
- [ ] Has `roles` section with labels for every role
- [ ] Has `settings` section with labels for every setting (if settings exist)
- [ ] Has `folders` section with label for the root folder
- [ ] Additional language files (if any) have the same structure as `en-US.json`
- [ ] Manifest `supportedLocales` lists every non-English locale that has a `translations/<locale>.json` file (English is not listed)

## Versioning

- [ ] `version` in manifest is bumped from previous release (or `"0.1.0"` for new modules)
- [ ] `dbSchemaVersion` is bumped if any DB schema changed (new entity, new column, changed type)
- [ ] `dbSchemaVersion` is NOT bumped if only views/menus/actions/translations changed

## Cross-entity consistency

- [ ] Every menu item's `dataViewCode` has a matching entry in `ui/data_views.json`
- [ ] Every data view's `entityCode` has a matching entity in the module (or a dependency)
- [ ] Every role's `rights` object codes match real entities/actions/reports
- [ ] Every action's `entityCode` matches a real entity
- [ ] Every FK constraint in `references` blocks matches a real target entity

## After validation

- [ ] If a local `dforge validate .` CLI is available, run it and fix any errors
- [ ] Try to `dforge package .` to build the `.dforge` file — it should succeed
- [ ] If MCP is connected, run `dry_run_install` to see the generated SQL
- [ ] Only after dry-run looks clean, `install_module` or `install-to-dev`

## Red flags during review

If you see any of these, stop and investigate:

- An entity with no `traits` and no explicit PK column
- A reference column without a paired FK column (or vice versa)
- A column with `fieldTypeCd: "integer"` / `"datePicker"` / `"money"` / `"autocomplete"` / `"boolean"` (wrong names)
- Flags containing `U`, `S`, or `P` (not valid flag letters)
- Menus with `children: [...]` (array, not dict)
- Roles with `entityRights` (wrong key)
- Data views with root-level `entityCode` (should be inside `dataSources`)
- Formula columns without `baseDatatypeCd`
- DSL actions with JavaScript/Python syntax
- Seed data files without numbered prefixes
- Seed data using `"entity"` instead of `"entityCode"` (silent failure — installer reads empty entity code)
- Seed data PKs as UUID strings instead of numeric integers
- Duplicate column codes in the same entity
- `orderNum` missing or duplicated across columns

## When the checklist passes

Tell the user what you built, summarize the entity model (e.g. "7 entities: contact, account, opportunity with its line items, quote with lines, activity, product"), list the data views and actions, and describe the security roles. Then ask if they want to install it.
