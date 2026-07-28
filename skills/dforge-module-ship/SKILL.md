---
name: dforge-module-ship
description: Phase 6 of dForge module authoring — the verify-and-release stage. Runs dforge_module_validate, the pre-pack self-review checklist, the version audit, then dforge_module_pack and dforge_module_install, and drives the install-fix loop until the module installs against a real tenant. Use when dforge_module_plan reports currentPhase 6, or when the user asks to validate, pack, install, deploy, or fix a failing install of an existing dForge module.
---

# dForge module — Ship (Phase 6)

Phase 6 is **required and non-skippable**. Its job is to find every defect
offline, then get a clean install against a real tenant.

**Preconditions:** Phases 0a–0d, 1, 3a and 5a complete. Optional phases (2, 4,
3b/3c, 5b) don't block — explicitly skipped ones are fine.

> **The platform validator at install is the only complete validator.** Every
> step before it exists to make that round trip succeed on the first or second
> try, because it is slow and tenant-bound.

## Step 1 — Automated validation (blocking gate)

Call **`dforge_module_validate`** on the module dir. It runs offline what
otherwise only surfaces at install:

- dangling FK / reference targets; a missing hidden-FK column
- view `dataSources`/columns pointing at unknown entities/fields; a grid over an
  entity with no visible column
- menu `dataViewCode` → missing view; role rights on unknown objects
- entities with no Select grant
- **field-spec rules re-run across every field** — catching anything that entered
  via `module_import` / `dbml_import` / a hand edit and never passed the
  authoring schema
- `toString` templates whose braces don't resolve
- **Formula-vs-Generated set aggregates**, and Generated aggregates over a
  virtual child column
- action `script` files missing from disk; triggers/jobs firing actions that
  don't exist; `[field]` record-context in a job-invoked action
- **DSL static checks** on every action body
- **translation completeness** — a missing `roles.<code>.label` fails install

Read `files["_validate.json"]`. **Every `error` must be fixed** (apply the
backtrack protocol in `dforge-module-build`) before continuing. Review the
`warning`s with the user. Re-run `dforge_module_validate` until `ok: true`.

If `dforge_module_validate` returns a tool error or is unavailable, halt and
tell the user: the automated gate cannot be bypassed; resolve the tooling issue
before continuing.

Structural only — it doesn't judge intent, so still do Step 2.

## Step 2 — Pre-pack self-review (blocking gate)

Load `dforge://reference/validation-checklist` and work every section.

**Top install-blockers — scan these first.** Each is a documented real failure
the platform validator rejects:

1. **DSL dates** — `execute:` uses lowercase `now()`; never `TODAY()`/`NOW()`
   (formula-only → `'TODAY' is not defined`). Verify with
   `dforge_action_check({ moduleDir, actionCode })` per action.
2. **Roll-ups** — a total over a child set is a Generated (`G`) column with
   `SUM([set].[field])`, never a Formula (`F`), and it aggregates a **physical**
   child column (`D` or same-row `G`). A virtual `F`/`R`/`S` child fails with
   `column old.<field> does not exist`.
3. **Rights keys** — actions/reports/folders take a **colon** (`action:x`);
   entities are bare or cross-module-dotted; deny by omitting, never `""`.
4. **Manifest** — no `translations` key; non-English locales in
   `supportedLocales` (never `en`/`en-US`); `moduleId` a valid UUID; `version`
   and `dbSchemaVersion` set; `security` has both `roles` and `folders`.
5. **Column defaults** — via `formula` / `numberSequence` / DSL, never a
   `defaultValue` key on an entity field.
6. **Seed + traits** — a seeded `audit-full` entity sets
   `created_by`/`last_updated_by: 0` on every record, or uses plain `audit`.

Remaining checklist areas: entity traits + `toString` + the FK+Reference pattern;
formula column shape; flags letters (`V I E M H` only); every entity has a
default grid and `dataSources` at root with `"order"` as a string array; menu
leaves use `dataViewCode` and bare icon names; every entity in at least one
role's rights; action `script` values are bare filenames; seed PKs numeric with
parents first; a `translations/<locale>.json` for every `supportedLocales` entry
**plus** the `en-US` base, each carrying a label for every trait-provided field
and every role.

If translations are thin, run **`dforge_translation_sync`** now rather than
hand-patching — it fills exactly the keys install requires.

## Step 3 — Translation deferral check

Read `_brief/changelog.md`. If a translation deferral warning is present
("Translation files for [locales] are incomplete"), **halt**: install will fail
completeness validation. Run `dforge_translation_sync`, confirm the non-English
values are really translated (the tool seeds English placeholders), and clear the
warning before proceeding.

## Step 4 — Final inspect + version audit

Run `dforge_module_inspect`. Show a one-line summary — entity / view / action /
role / trigger / job counts. Then confirm both version strings with the user:

- **`version`** — always bump (semver) before packing.
- **`dbSchemaVersion`** — bump only if entity fields were added, removed, or
  type-changed since the last install.

Get explicit confirmation on both before packing. This version confirmation
applies only to the initial pack. During the install-fix loop, re-pack without
re-asking unless the fix changes the version strings.

## Step 5 — Pack + install

1. `dforge_module_pack` → the `.dforge` tarball. Blocked if any entity lacks a
   role granting Select; fix security coverage and re-run.
2. `dforge_module_install` with `DFORGE_URL` / `DFORGE_TOKEN`.

### Install-fix loop (mandatory)

1. **Call `dforge_module_install` yourself.** Never ask the user to run the
   install command for you.
2. If `ok: false`, read the returned `output` **in full** — it's the raw
   CLI/server validator output and it is the input to the next fix.
3. If it's a module defect, **fix it yourself.** Use the table below to pick the
   phase, then apply the backtrack protocol with the smallest suitable tool.
4. Re-run Step 1 (`validate`) until `ok: true`, then re-run only the Step 2
   checks for the area you touched, then pack and install again.
5. Repeat until install succeeds, or the remaining failure is clearly
   environment/tooling.

Environment/tooling failures include: 401/403 auth errors, network connectivity
refused, server-side feature not enabled for the tenant, and CLI version
incompatibility. All other errors are module defects.

After 4 failed install attempts without progress, pause the loop, summarize all
outstanding errors to the user, and ask how to proceed rather than continuing
autonomously.

| Install error pattern | Backtrack to |
|---|---|
| "unknown entity code" / "unknown view code" | Phase 1 or 3 |
| "missing translation key" | Phase 4 (`dforge_translation_sync`) |
| "FK constraint violation in seed data" | Phase 1 (seed load order) |
| "role right granted on unknown object" | Phase 5 |
| "action script not found" | Phase 2a |
| "formula compile error" | Phase 1 (field def) or Phase 2a (DSL) |
| "duplicate code" | wherever the duplicate was introduced |

**Phase 6 sign-off exception:** when install fails with a clear module defect
(schema validation, missing file/key, translation completeness, DSL compile
error, dependency contract, FK/seed/import error), do **not** ask the user for
sign-off before the corrective patch. The server has already rejected the
package — fix the referenced files, report what changed, and immediately re-run
validate → pack → install. Keep sign-off for product/design choices or genuinely
ambiguous fixes.

**If install fails on auth (401/403) or connectivity (refused):** that is
credentials/connectivity, NOT a module defect. Tell the user to verify
`DFORGE_URL` and `DFORGE_TOKEN`. **Do not backtrack** to earlier phases.

**Exit criterion:** install exits 0 against a real tenant.

## Step 6 — Record and close out

1. `dforge_module_plan({ action: "complete_phase", moduleDir, phase: "6", note: "installed v<x.y.z>" })`.
2. **Ask the user**: "Delete `_brief/` (session scratch), or move it to `docs/`
   as committed design rationale?" Wait for the answer — don't act unilaterally.
3. Suggest a `git commit` summarizing the module. **Do not commit unless the user
   asks.**
