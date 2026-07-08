# Changelog

All notable changes to `@dforge-core/dforge-mcp`. This project uses semver-ish
`0.1.0-rc.N` pre-release tags; the published version is set at publish time via
the release workflow, so committed `package.json` versions are placeholders.

## 0.1.3

### Added
- **Cross-source report metrics & charts (schema).** `reports.schema.json` now
  lists `kpi` as a `vizType` (was `metric`) and documents the two config shapes
  module authors can now write:
  - **Formula KPI metrics** — a metric can be `{ formula, inputs: [{ alias, column,
    agg, source? }], format? }` instead of a single `{ column, agg }`, for ratios /
    derived numbers / win-rate percentages. `format` Auto (omit `style`) inherits the
    first input column's own formatter.
  - **Cross-source inputs & overlay series** — a formula input (`inputs[].source`) or
    a chart overlay series (`config.series`, a single object or array of `{ source?,
    categoryCol, valueCol, agg, label? }`) can aggregate over a **sibling dataset** by
    its code (omit = the panel's own). Chart overlays share one category axis
    (outer-joined; bar fills 0, line/area gaps with null).

### Skill
- `dforge-mcp-author`: **reconciled `references/reports.md` to the real report
  format.** Corrected long-standing drift — `layout` is `{ panels: [...] }` (not a
  bare array); chart panels are `vizType: "chart"` with the kind in
  `config.chartType` (not `vizType: "bar"`); datasets use `datasetType` + nested
  `query.entityCd`/`columns` (not top-level `entityCode`/`groupBy`/`aggregations`,
  which don't exist — aggregation is viz-side); SP datasets use `spCd` (+ multi-set
  via `parentDatasetCd`/`parentRef`), not `sp`/`spCursor`; KPI is
  `config.metrics: [...]` (not `{ valueCol, format }`). Added the formula-KPI,
  cross-dataset-KPI, and chart-overlay sections.

## 0.1.2

### Fixed
- **Windows CLI resolution & argument quoting (`native-shell`).** The PATH
  fallback now routes a bare command name through `cmd.exe` so `PATHEXT`
  resolves the `dforge-cli.cmd` shim that `npm install -g` drops on PATH —
  previously `spawnSync` without a shell matched only an exact file and
  `ENOENT`'d. Arguments are now quoted before the shell sees them (`shell:true`
  performs no escaping), so a path with spaces no longer splits into multiple
  args and a metacharacter (`&`, `|`, `>`, …) can't inject a second command;
  `quoteWinArg` follows the `CommandLineToArgvW` rules. Spawn logic is
  centralized in a single `spawnCli` helper shared by `run()` and
  `installModule()`, with coverage in `test/native-shell.test.ts`.

### Changed
- **`dforge_module_install` always returns raw CLI output.** The tool now
  surfaces the raw CLI output, `exitCode`, and `command` on every call so the
  agent can read a server-side validation failure and fix-and-retry instead of
  getting a swallowed error.
- **`dforge_module_pack` description.** Clarified that it uses the bundled
  `dforge-cli` package, then the PATH fallback, then the `DFORGE_CLI_BINARY`
  override (was "Requires the dforge-cli native binary on PATH").

### Added
- **Matrix data-view support.** Data-view guidance and schemas document matrix
  views with `rangeControl` and per-column select values, alongside the
  register/budgeting examples.

### Skill
- `dforge-mcp-author`: reworked the Phase 6 flow into an explicit
  **validate → pack → install → fix** retry loop (SKILL.md,
  `validation-checklist.md`, `docs/creating-modules.md`), and refreshed the
  module naming conventions in the manifest schema.

## 0.1.0-rc.13

Single source of truth: the authoring tools now validate against
`@dforge-core/metadata` — the same registry/schema package the dForge app, SDK,
and VS Code extension use.

### Added
- **`dforge_dbml_import` — DBML front-end (was a stub).** Parses the common DBML
  subset (Table blocks, typed columns with `[settings]`, inline `[ref: > t.c]`
  and top-level `Ref:` lines) into the table-spec and runs the import core. Drops
  the source PK column (the identity trait provides `{entity}_id`) and remaps FK
  targets to it. Both import tools accept a `module` identity for **greenfield**
  imports (no manifest yet).
- **Spreadsheet (.xlsx) import.** A binary `.xlsx` can't be read directly, so the
  package ships a **pure-stdlib Python extractor** (`dforge://script/xlsx-to-model`,
  no `pip install`) that decodes sheets → headers + sample rows as JSON. The skill
  (`dforge://reference/excel-import`, wired into the Phase 1 on-ramp) drives it:
  run the extractor, build a table-spec from the model, call `dforge_module_import`.
  `.csv` is read directly (plain text).
- **`dforge_module_import` — table-spec → entities (import core).** Takes a
  normalized spec (tables → columns → relationships) and generates entities:
  each column's `fieldTypeCd` is inferred from an explicit code, a source SQL
  type, sample values, and name heuristics (email/phone/url/currency), validated
  against the metadata registry with `dbDatatype` derived; every relationship
  becomes the FK+Reference two-column pair. The shared transformer that DBML/SQL,
  Excel/CSV, and hand-authored front-ends feed (Excel front-end is next). Output
  passes `dforge_module_validate` clean.
- **`dforge_entity_rename` / `dforge_entity_delete` — refactor-safe entity ops.**
  Rename cascades the identity PK (`{old}_id → {new}_id`) and repoints every
  reference (other entities' `link.entity`/`references`, view `entityCode`, role
  rights keys, action entity, folder bindings, seed `entityCode` + PK keys);
  delete drops the entity + its seed + manifest entry + role key + folder
  binding + view sources. Both move/remove files via a new `deletes[]` field on
  the tool response (apply `files` AND `deletes`); surfaces unhandled surfaces
  (reports, translations, menus, DSL, dangling cross-entity FKs) as warnings.
- **`dforge_entity_field_rename` — refactor-safe field rename.** Renames a field
  and propagates the new name to everything that referenced it in one call: the
  paired Reference column's `link.thisKey` + `references` block, same-entity
  formula columns (`[old]` → `[new]`), data view columns and `order` arrays,
  seed-data records, and OTHER entities' FKs targeting it (`link.otherKey` /
  `references.to.field`). Wired into the backtrack protocol ("rename, don't
  remove+add"); pair with `dforge_module_validate` to confirm nothing dangles.
- **`dforge_module_validate` — offline pre-flight cross-reference check.** Loads
  the whole module and catches the errors that previously only surfaced at
  pack/install: dangling FK/reference targets, a missing hidden-FK column, view
  `dataSources`/columns and menu `dataViewCode`s and role rights pointing at
  entities/fields/actions/reports that don't exist, and entities with no Select
  grant. Returns errors + warnings in `_validate.json`. Wired into the skill as
  the first Phase 6 gate (run it and fix every error before packing).
- **Field-type & column-type validation.** `dforge_entity_field_add` /
  `dforge_entity_field_modify` and `dforge_setting_add` reject an unknown
  `fieldTypeCd` (with a "did you mean" hint — e.g. `integer` → `number`,
  `reference` → `lookup`) and an unknown `columnType`. Previously any string
  passed.
- **`dbDatatype` auto-derivation.** When a field omits `dbDatatype`, it's
  derived from `fieldTypeCd` (currency → `numeric(18,2)`, text → `varchar`;
  reference/formula columns get none). An explicit value is never overridden.
- **Full entity trait set.** `dforge_entity_add` / `dforge_module_create`
  accept the complete, metadata-validated trait list — identity, audit,
  audit-full, soft-delete, sorting, postable, accumulation, ledger, period —
  instead of only the two scaffolder presets. Codes expand server-side at
  install.
- **Test harness.** Added `vitest` (`pnpm test`) with coverage for the new
  validation, `dbDatatype` derivation, and the trait flow.

### Changed
- **`dforge_entity_field_remove` now cascade-cleans.** It removes the field and
  the paired Reference (when you remove its hidden FK), the `references` entry,
  view columns + `order`, and seed-data keys — and warns about formula /
  cross-entity dependents instead of leaving them dangling. (Moved into
  `src/tools/refactor.ts` alongside the rename ops.)
- **Schemas sourced from `@dforge-core/metadata`, cross-platform.** A new Node
  script (`scripts/vendor-schemas.cjs`, runnable via `pnpm sync-schemas`) copies
  the JSON schemas from the installed metadata package — works on Windows, and
  runs automatically in `prepublishOnly` so every publish regenerates them from
  the pinned metadata version (no silent drift). `vendor-resources.sh` is now a
  Unix wrapper that delegates schemas to that script. The public
  `resources/schemas/*` surface (MCP resources + jsdelivr) is unchanged.
- **`vendor-resources.sh` reference sync is opt-in.** The conventions doc and
  skill reference pull from `dForge-core` now runs only with `VENDOR_REFS=1`;
  the default run is schemas-only and needs no `dForge-core` checkout. This
  prevents clobbering the in-repo skill references, which are ahead of core.
- **Dependencies.** Added `@dforge-core/metadata ^0.0.2` (bundled into the
  single-file `dist/server.js` via tsup). Bumped `@dforge-core/dforge-cli`
  `^0.1.2` → `^0.2.2` (builder API unchanged; `buildFolders` flat-root output
  verified).

### Skill
- `dforge-mcp-author`: `field-types.md` + `SKILL.md` now tell the agent to
  **omit `dbDatatype` on plain data columns** (it's derived), keeping the
  explicit-value guidance only for FK columns (`cuid`) and size/precision
  overrides — so the derivation is actually used, not bypassed.

### Fixed
- **Phase 0 scaffold gate no longer greps Markdown.** `dforge_module_plan`
  validate now writes a machine-readable `docs/phase.json` marker, and the gate
  (`dforge_module_create` + the plan `check`) **parse** it instead of searching
  `VALIDATION.md` for a `readyToScaffold: true` substring — so reformatting /
  casing / duplicate text in the human report can't fool the gate. Falls back to
  the legacy substring for modules validated before the marker existed.
- **Field rename now updates *every* formula** that references the field, not
  just the first — replaced a reused global `RegExp` (`.test()` carries
  `lastIndex` across calls) with literal bracket-token string ops.
- **Validator no longer rubber-stamps cross-module typos.** A dotted entity ref
  (`crm.product`) is validated against the manifest's declared `dependencies`
  (or this module's own code); an undeclared/typo'd module is now an error
  instead of being accepted. **Role-rights** entity keys use the same resolver,
  so grants on a **system entity** (`user`, `document`, …) or a declared
  cross-module entity no longer false-error, while unknown ones still do.
- **xlsx extractor ignores styled-but-empty rows when sampling.** A bordered/
  formatted cell with no value no longer counts as data, so placeholder rows
  can't exhaust the row sample before the real data is reached. Headers-only
  (structure-only) sheets are supported too — they yield `rows: []`.
- **xlsx extractor is memory-bounded with no value loss.** Worksheets stream
  (capped sample), and the shared-string table is read in a second pass that
  loads **only the indices the sampled cells reference** — so a huge workbook
  never loads the whole table, and there's no cap that could silently return a
  raw index instead of the real string.
- **`module pack` tarball-path resolution is robust.** It collects every
  `*.dforge` candidate from stdout (quoted/spaced paths and Windows separators
  included), **normalizes wrapping punctuation** (quotes, parens, trailing
  commas), and picks the one that **actually exists on disk** — pack just wrote
  it — via a single `stat` per path instead of trusting a fragile regex token.

### Notes
- Earlier `0.1.0-rc.*` releases predate this changelog.
