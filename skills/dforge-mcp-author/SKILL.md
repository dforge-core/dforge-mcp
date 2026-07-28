---
name: dforge-mcp-author
description: Entry point for authoring dForge modules with the dforge-mcp tool surface. Use when @dforge-core/dforge-mcp is connected and the user asks to create, extend, fix, pack, or install a dForge module. Determines where the module currently stands and hands off to the right stage skill — dforge-module-design (Phase 0), dforge-module-build (Phases 1-5), or dforge-module-ship (Phase 6). Start here when you don't already know which stage you're in.
---

# dForge Module Author — router

This skill routes. It does **not** contain the phase instructions — those live in
three stage skills, each loaded only when its stage is active:

| Stage skill | Phases | What it owns |
|---|---|---|
| `dforge-module-design` | 0a–0d | Identity, intake, design doc, pre-scaffold validation. Ends at `readyToScaffold: true`. |
| `dforge-module-build` | 1–5 | Entities, behavior, views/menus, polish, security. |
| `dforge-module-ship` | 6 | Validate → pre-pack review → pack → install-fix loop. |

**Why split:** each stage needs a different half of the knowledge base. Phase 0
needs none of the field-type/DSL detail; Phase 6 needs none of the intake
guardrails. Loading only the active stage is what keeps a full module build
inside one context window.

## Do this first, every session

1. **Get `moduleDir`.** If the user hasn't given one: _"Where should the module
   directory live? (absolute path)"_ — ask before any tool call.
2. **Call `dforge_module_plan({ action: "check", moduleDir })`.** It reads the
   on-disk state and returns `currentPhase`, `nextSkill`, and `nextStep`.
3. **Invoke the skill it names** (`nextSkill`) and follow it. If the module
   already exists, also run `dforge_module_inspect` first so you know what's
   there before proposing anything.

That single call is the whole routing decision — do not guess the phase from
file listings, and do not load a stage skill you weren't routed to.

**If the user asks to skip Phase 0** ("just scaffold it", "skip the docs"):
respond — _"Phase 0 documents are required before scaffolding. They take 15–30
minutes and prevent hours of backtracking. Let me check where we are."_ — then
call `check`. `dforge_module_create` is gated at the tool level and will refuse
regardless.

## Phase ledger

`dforge_module_plan` tracks Phase 0 by which artifact files exist, and Phases
1–6 by a ledger in `docs/phase.json` **plus** evidence read from the module
itself (entities without fields, entities without a view, entities without a
Select grant). So:

- **Record each phase as you finish it** —
  `dforge_module_plan({ action: "complete_phase", moduleDir, phase: "3", note: "..." })`.
  For an optional phase the user declined, add `skipped: true`.
- A resumed session then knows the difference between "Phase 2 skipped
  deliberately" and "Phase 2 not started". Without the record, it can't.
- `check` reports `gaps` when the ledger and the module disagree. Trust the
  gaps: they're derived from the files.

## Tool inventory

Full descriptions are on the tools themselves — this is the map.

| Group | Tools |
|---|---|
| Lifecycle | `dforge_module_plan`, `dforge_module_create`, `dforge_module_inspect`, `dforge_module_validate`, `dforge_module_pack`, `dforge_module_install` |
| Import | `dforge_module_import`, `dforge_dbml_import` |
| Entities | `dforge_entity_add`, `dforge_entity_rename`, `dforge_entity_delete` |
| Fields | `dforge_entity_field_add`, `_modify`, `_rename`, `_remove` |
| **Composite (prefer these)** | `dforge_entity_reference_add` (relation), `dforge_entity_rollup_add` (child total), `dforge_entity_status_add` (status column) |
| Behavior | `dforge_action_add`, `dforge_action_check`, `dforge_trigger_add`, `dforge_job_add`, `dforge_webhook_add` |
| UI | `dforge_view_add`, `dforge_view_modify`, `dforge_menu_add`, `dforge_report_add` |
| Polish | `dforge_setting_add`, `dforge_translation_sync`, `dforge_seed_add` |
| Security | `dforge_role_add`, `dforge_role_right_set`, `dforge_folder_add` |
| Cross-cutting | `dforge_dependency_add` |

**Composite tools first.** A relation, a roll-up, and a status column each span
several coordinated keys, and hand-assembling them from `entity_field_add` is
the top source of broken modules. The composite tools emit the whole shape and
can't express the broken variants. Reach for `entity_field_add` only for a
plain scalar column.

## Writing files: preview vs `apply`

Every patch tool returns `{ summary, files, deletes? }` for the client to write
— so you can preview a diff with the user first. Passing **`apply: true`**
instead writes the files (and honours `deletes`) directly and returns only the
paths touched.

- **Preview (default)** when the user is reviewing the change, and for anything
  in Phase 0.
- **`apply: true`** for routine patches inside an already-approved plan, and for
  every `rename`/`delete` refactor — it guarantees the `deletes` are applied,
  which is easy to drop by hand.
- Either way, **`_inspect.json` / `_validate.json` / `_action_check.json` are
  report payloads, never files** — don't write them to disk.

## Hard rules — all stages

1. **Co-pilot stance.** Draft → propose → user approves → tool call. Never write
   without confirmation. Read-only tools (`inspect`, `validate`, `action_check`)
   need no gate.
2. **Inspect before patching.** `dforge_module_inspect` at session start and
   after every backtrack. Parse `files["_inspect.json"]`, not just the summary.
3. **One thing at a time.** One question per turn; one entity / view / role /
   action / report proposed per turn. The only exception is the Phase 1 field
   batching rule (see `dforge-module-build`).
4. **Validate and reflect.** After every user answer, restate what you understood
   and ask "Right?" before moving on. Zero ambiguity going into the next step.
5. **Load before authoring.** Pull the matching `dforge://reference/<name>` +
   `dforge://example/<path>` resource before authoring any element type,
   including inside a backtrack. They're **MCP resources — load by URI, not by
   filesystem path**; your CWD is the module dir, so `references/*.md` won't
   resolve on disk. If a needed resource fails to load, stop and tell the user —
   never invent a schema from memory.
6. **Don't invent domain content.** Fields, codes, roles and relationships come
   from the user's domain. Never default to a generic `admin/contributor/viewer`
   taxonomy they didn't ask for.
7. **A step is done only when its file is written AND reviewed.** Deciding what
   you *would* write is not "done". Don't advance a phase on intent.
8. **Tabs in JSON, trailing newline** — the tools already emit this; don't
   reformat.

## Tool failure protocol — all stages

1. **Surface the raw error verbatim.** Don't paraphrase.
2. **Classify before asking for help.** If the output names a module defect, fix
   it yourself with the smallest suitable tool, then re-run validation. The error
   is already in the tool result — never ask the user to paste it back.
3. **Ask the user only for environment issues** you can't fix from module files:
   missing CLI, missing/expired credentials, unreachable tenant, permissions, or
   a path outside the workspace.
4. **Do not advance the phase** until the failing tool succeeds.

Known causes worth distinguishing:

- **`pack`/`install` "command not found"** → dforge-cli isn't on PATH. Tell the
  user: `npm install -g @dforge-core/dforge-cli`, then re-run.
- **`install` HTTP 401/403 or connection refused** → credentials/connectivity,
  NOT a module defect. Verify `DFORGE_URL` / `DFORGE_TOKEN`. Do not backtrack.
- **`install` `ok: false` with validation/compile/schema output** → a module
  defect. Treat `output` as the source of truth and run the fix loop in
  `dforge-module-ship`.

## Resource index

Load these by URI, one per step, at the step that needs them.

**Per-element references** — `dforge://reference/<name>`:
`field-types`, `flags`, `column-types`, `column-domains`, `formulas`, `traits`,
`data-views`, `menus`, `action-dsl`, `filters`, `security`, `reports`,
`settings`, `jobs`, `number-sequences`, `document-extraction`,
`print-templates`, `translations`, `queries`, `schema-import`, `excel-import`,
`data-migration`, `manifest`, `validation-checklist`, `conventions`.

**Schemas** (fallback, when a reference points at one) — `dforge://schema/<name>`:
`manifest`, `entity`, `domains`, `data-views`, `folders`, `menus`, `roles`,
`jobs`, `seed-data`, `traits`, `webhooks`, `triggers`, `print-templates`,
`settings`, `reports`.

**Docs**: `dforge://docs/dsl` (full DSL grammar + built-ins),
`dforge://docs/conventions` (cross-module extension work — §1b only).

**Examples** — `dforge://example/<path>` (simple-todo) and
`dforge://example/matrix-budget/<path>`. These are mandatory structure
validators: copy their shapes, don't invent.

**Script**: `dforge://script/xlsx-to-model` (stdlib Python .xlsx extractor).
