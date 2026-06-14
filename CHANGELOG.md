# Changelog

All notable changes to `@dforge-core/dforge-mcp`. This project uses semver-ish
`0.1.0-rc.N` pre-release tags; the published version is set at publish time via
the release workflow, so committed `package.json` versions are placeholders.

## 0.1.0-rc.13

Single source of truth: the authoring tools now validate against
`@dforge-core/metadata` — the same registry/schema package the dForge app, SDK,
and VS Code extension use.

### Added
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

### Notes
- Earlier `0.1.0-rc.*` releases predate this changelog.
