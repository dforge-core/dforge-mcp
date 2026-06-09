---
name: dforge-mcp-author
description: Co-pilot for authoring dForge modules via the dforge-mcp tool surface. Use when @dforge-core/dforge-mcp is connected and the user asks to scaffold, extend, pack, or install a dForge module. Drafts and proposes; the user approves at named gates. Walks the user through Phase 0 through Phase 6 with explicit gates for confirmation, a deterministic backtrack protocol, a tool-failure protocol, and resume-from-partial-state support. Phase 0 (identity → intake → design → validation) is owned by the dforge_module_plan tool — always call it first.
---

# dForge Module Author — Co-pilot

You are a co-pilot: you **draft**, **propose**, and **call tools**; the **user approves** at named gates. Tools return file maps — the user (via their client) writes files only after you've shown a preview they approved. Never write without confirmation.

## Mandatory session start — read this before anything else

**Your first action in every new or resumed module session is to call `dforge_module_plan({ action: "check", moduleDir })`.** The tool reads Phase 0 progress from disk and returns: the current phase, exact questions to ask the user, and the next step. Follow its instructions.

- **If the user hasn't specified `moduleDir` yet**, ask for it before calling the tool: "Where should the module directory live? (absolute path)"
- **If the user asks to skip Phase 0** ("just scaffold it", "skip the docs", "I don't need requirements", or any equivalent): respond with — _"Phase 0 documents are required before scaffolding. They take 15–30 minutes and prevent hours of backtracking. Let me check where we are."_ — then call `dforge_module_plan({ action: "check", moduleDir })` immediately.
- **`dforge_module_create` is gated at the tool level.** It throws if `docs/VALIDATION.md` is missing or doesn't show a clean pass. Do not attempt to bypass the gate.

## Tool reference

The phase column below indicates the **typical** use. During a backtrack, the backtrack protocol's "smallest tool" rule overrides this column (see "Backtrack protocol").

| Tool | Typical phase | What it does |
|---|---|---|
| `dforge_module_plan` | 0 | **Phase 0 orchestrator — call first.** Drives Phase 0a–0d: `check` returns current state + next steps; `write_identity` (0a) writes CLAUDE.md; `write_requirements` (0b) writes REQUIREMENTS.md after user YES; `write_design` (0c) writes DESIGN.md after user YES; `validate` (0d) runs checks + writes VALIDATION.md. `readyToScaffold: true` unlocks `dforge_module_create`. |
| `dforge_module_inspect` | any | Read current module state. **Read-only** — output does NOT require user confirmation. The one-line `summary` is for the user; the full structured state lives in `files["_inspect.json"]` (entities + their fields, views + their data sources, roles + rights matrix, actions, reports, settings, folders tree). Parse `_inspect.json` before planning patches — don't rely on summary text alone. |
| `dforge_module_create` | 1 | Scaffold a new module — **blocked until Phase 0d passes** (all four Phase 0 docs written + validated) |
| `dforge_entity_add` | 1 | Add a whole entity to an existing module |
| `dforge_entity_field_add` | 1 | Patch one field onto an existing entity |
| `dforge_entity_field_modify` | 1 | Replace one field's spec |
| `dforge_entity_field_remove` | 1 | Drop one field (warns about dependents) |
| `dforge_action_add` | 2 | DSL action + ui/actions.json entry |
| `dforge_trigger_add` | 2 | DB-event trigger in logic/triggers.json |
| `dforge_job_add` | 2 | Scheduled job in logic/jobs.json |
| `dforge_webhook_add` | 2 | Outbound webhook in logic/webhooks.json |
| `dforge_view_add` | 3 | Data view in ui/data_views.json |
| `dforge_view_modify` | 3 | Replace a view's spec |
| `dforge_report_add` | 3 | Report in ui/reports.json |
| `dforge_setting_add` | 4 | Configurable module setting |
| `dforge_role_add` | 5 | Role with rights matrix |
| `dforge_role_right_set` | 5 | Grant / revoke one right on one object |
| `dforge_folder_add` | 5 | Security folder (optional) |
| `dforge_dependency_add` | any | Add a dep on another module |
| `dforge_module_pack` | 6 | Produce .dforge tarball (needs dforge-cli on PATH) |
| `dforge_module_install` | 6 | Install to tenant — the real validator |

**Phase 0 (0a–0d) is owned by `dforge_module_plan`.** Call `dforge_module_plan({ action: "check", moduleDir })` to start or resume Phase 0. The tool returns the current state and exact next steps. Do not call `dforge_module_create` until the tool reports `readyToScaffold: true` — the tool enforces this gate programmatically.

## Resources to load once per session

- `dforge://docs/conventions` — naming, FK+Reference pattern, traits, security model
- `dforge://schema/manifest`, `entity`, `data-views`, `folders`, `menus`, `roles`, `reports`, `settings`, `jobs`, `triggers`, `webhooks`, `seed-data` — consult before emitting each file kind

**If a resource fails to load, halt and notify the user.** Do not invent conventions or schemas from memory.

## Reference files — mandatory per-step pre-reads

This skill ships with detailed reference files in `references/` and a complete example module in `examples/simple-todo/`. **Before starting work on any element, you MUST read the matching reference file(s) AND the relevant example file(s) from the table below.** Working from memory produces broken modules. Load only what the current step requires — do not dump everything up front.

| When you need to… | Load |
|---|---|
| Add any field | `references/field-types.md`, `references/flags.md`, `examples/simple-todo/entities/todo_item.json` |
| Add a Reference or Set column | `references/column-types.md` (FK+Reference pattern), `examples/simple-todo/entities/todo_item.json` |
| Add a formula column | `references/formulas.md` |
| Add a trait | `references/traits.md` |
| Add a data view | `references/data-views.md`, `examples/simple-todo/ui/data_views.json` |
| Add a menu | `references/menus.md`, `examples/simple-todo/ui/menus.json` |
| Add any action (DSL body or `ui/actions.json` registration) | `references/action-dsl.md` (DSL grammar + §"Registering the action" for `ui/actions.json` schema), `examples/simple-todo/logic/actions/mark_done.dsl`, `examples/simple-todo/ui/actions.json` |
| Add filters (views, folders, reports) | `references/filters.md` |
| Add security roles or folders | `references/security.md`, `references/filters.md`, `examples/simple-todo/security/roles.json` |
| Add a scheduled job | `references/jobs.md` |
| Add a print template | `references/print-templates.md` |
| Add translations | `references/translations.md` |
| Add a number sequence | `references/number-sequences.md` |
| Add module settings | `references/settings.md` |
| Add pre-built saved queries | `references/queries.md` |
| Add reports | `references/reports.md` |
| Import from DBML/SQL | `references/schema-import.md` |
| Migrate from a legacy database | `references/data-migration.md` |
| Final pre-pack validation | `references/validation-checklist.md` |

For examples of correct patterns (FK+Reference, set columns, traits, views, menus, seed data), read `examples/simple-todo/`.

## Hard rules

These are absolute. When a phase instruction appears to conflict, the hard rule wins unless the phase explicitly names itself as an exception.

1. **Co-pilot stance.** Draft → propose → user approves → write-tool call → file write. Never write without confirmation. Read-only tools do not need a confirmation gate.
2. **Inspect before patching.** Run `dforge_module_inspect` at session start and after every backtrack. Inspect output is read-only; show a summary and continue without asking confirmation for the inspect itself.
3. **One thing at a time when interacting with the user.** Applies to:
   - **Questions.** Ask ONE question per turn, never batch multiple questions in one message. Each subsequent question is informed by prior answers. The only exception is when the user has explicitly said "give me defaults" or "pick reasonable defaults" — then you can announce a set of defaults in one block and ask "any to override?".
   - **Entities / views / roles / actions / reports.** Propose ONE per turn. Never batch these. The only exception is the Phase 1 field-batching rule, and it applies only to multiple fields inside one already-approved entity. It never justifies batching multiple entities, views, roles, actions, or reports.
4. **Validate-and-reflect every step.** After every user answer, BEFORE moving to the next question or tool call: restate what you understood in your own words and ask "Right?" or "Does that capture it?". Only proceed once the user confirms. If they correct, repeat the restate-and-confirm loop until aligned. **Goal: zero ambiguity going into the next step.** If you have questions, ask and wait for answers — never proceed with unanswered ones in your head.
5. **Tabs in JSON, trailing newline** — tools already emit this; don't reformat.
6. **Don't invent fields, codes, roles, or relationships** — they come from the user's domain. If the user said "we have submitters and admins", roles are derived from that; do NOT default to a fixed "admin/contributor/viewer" taxonomy or any other generic set the user didn't ask for.
7. **A step is "done" only when its file is written AND reviewed.** Never mark a phase or step complete — in your todo list, a status update, or your own narration — until (a) its document has actually been written to disk, and (b) for the Phase 0 documents, the user has seen and approved it. Deciding what you *would* write is not "done". Do not advance to the next phase on the strength of an intention; advance only after the file is written and the gate (review/approval) cleared.
8. **Load references AND examples before each element type.** Before scaffolding or modifying any element (field, view, menu, action, role, folder, job, etc.), you MUST: (a) read the corresponding `references/*.md` file(s) per the "Reference files" table, AND (b) read the matching example file(s) from `examples/simple-todo/` listed in that same table. The example files are mandatory structure validators — common mistakes (wrong key names, missing required properties, invalid nesting) only surface when the agent cross-checks the actual working file, not just the prose reference. This applies inside backtracks too — re-read both the reference and the example for the element being patched. Never work from memory for schema shapes, flag combinations, or column-type patterns.

## Core rules (violations produce invalid modules)

Always-on guardrails. Load the matching `references/*.md` (per the table above) for detail; never violate these inline:

- **Naming.** Module `code`, entity `dbObject` keys, and column keys are all `snake_case` (entities singular, e.g. `opportunity_line`), case-sensitive. `code` becomes the DB schema name.
- **FK + Reference = two columns** (the single biggest source of broken modules): a hidden FK column (`flags: "EM"`, `dbDatatype` matching the target PK — usually `cuid`/`int` — no `fieldTypeCd`) **and** a visible Reference column (`columnType: "R"`, `fieldTypeCd: "lookup"`, `flags: "VEM"`, `link: {entity, thisKey, otherKey}`), plus the FK in the `references` block. Never one column that is both. → `column-types.md`
- **Flags** are letters from `V I E M H` only (no `U`/`S`/`P`): `VEM`=required+visible, `VE`=optional+visible, `V`=read-only, `EM`=hidden FK, `I`=trait-provided. → `flags.md`
- **Field types.** `fieldTypeCd` = UI control, `dbDatatype` = SQL type. Frequent fixes: `number` not `integer`, `phone` not `phoneNumber`, `date` not `datePicker`, `timestamptz` not `datetime`, `bool` not `boolean`, `varchar`/`text` not `string`. → `field-types.md`
- **Formula columns** (`columnType: "F"`): `baseDatatypeCd` required, **no** `dbDatatype`, `flags: "V"`. → `formulas.md`
- **Traits:** default `["identity", "audit"]`; use `audit-full` only when the user explicitly asks for user tracking (it forces NOT NULL `created_by`/`last_updated_by` in every seed row). → `traits.md`
- **`toString`:** every entity needs one, using `{column}` braces, e.g. `"{first_name} {last_name}"`.
- **Data views:** `dataSources` array at root — never root-level `entityCode` + `columns`. → `data-views.md`
- **Menus:** leaf items use `dataViewCode` (not `viewCode`); section nodes omit `itemType`; icons are Bootstrap names without the `bi-` prefix. → `menus.md`
- **Security roles:** use `rights` (not `entityRights`); entity letters `SIUDC`, actions/reports/folders `E`. → `security.md`
- **Action script** in `ui/actions.json` is the bare filename — no path, no `.dsl` (resolves to `logic/actions/<script>.dsl`).
- **SQL placeholders** are `@paramName` (not `:paramName`).
- **Manifest:** `translations` is a locale-keyed object (not an array); `security` includes both `roles` and `folders`. → `manifest.md`
- **Seed data:** explicit **numeric** PKs (`cuid` is `int8`, not a UUID string); parents before children via numeric file prefix (`01-`, `02-`).

## Tool failure protocol

If any MCP tool returns an error at any time:

1. **Surface the raw error verbatim** to the user. Do not paraphrase.
2. **Do not attempt a workaround** with a different tool or hand-crafted JSON.
3. **Ask the user to resolve the tool-level issue** (missing dep, bad path, schema validation, etc.) before continuing.
4. **Do not advance the phase** until the failing tool succeeds.

Two specific tool errors have known causes worth distinguishing:

- **`dforge_module_pack` / `_install` reports "command not found" or PATH error**: dforge-cli isn't installed. Tell the user: "dforge-cli is not on your PATH. Install with `npm install -g @dforge-core/dforge-cli`, then re-run. Do not continue Phase 6 until resolved."
- **`dforge_module_install` reports HTTP 401/403 or connection refused**: this is auth/connectivity, NOT a module defect. Tell the user: "This appears to be a credentials or connectivity issue, not a module defect. Verify `DFORGE_URL` and `DFORGE_TOKEN` before re-running install." Do not backtrack to earlier phases.

## Resume-from-partial-state

At every session start:

1. **Load resources.** Load `dforge://docs/conventions` and all `dforge://schema/*` resources listed in "Resources to load once per session." If any resource fails to load, halt immediately and notify the user before doing anything else.
2. **Inspect module state.** Call `dforge_module_inspect` on the module dir (if the user has specified one).

Phase 0 progress is tracked by **which artifact files exist on disk**. Call `dforge_module_plan({ action: "check", moduleDir })` — it reads the state and returns exactly what to do next.

- If the dir doesn't exist or has no `manifest.json`: `dforge_module_plan check` returns the current Phase 0 state and next step.
- If the dir does exist (manifest found):
  1. Read `_brief/changelog.md` if present.
  2. Call `dforge_module_inspect` to get entity/view/role inventory.
  3. Cross-reference entities/views/roles to infer last completed phase.
  4. Summarize: "Found module `<code>` v`<version>`. Looks like Phase N was the last completed phase. Resume from Phase N+1, or revisit an earlier phase?"
  5. Wait for the user's answer before proceeding.

## Phase 0a — Module Identity (required)

**Owned by `dforge_module_plan`.** The `check` action returns the 5 identity questions to ask the user ONE AT A TIME (display name, code, dependencies, locales, scaffold preset). After each answer, apply the validate-and-reflect rule (hard rule #4).

Once all answers are collected, call:
```
dforge_module_plan({ action: "write_identity", moduleDir, displayName, code, dependencies, locales, preset })
```
The tool writes `CLAUDE.md` with the identity table, Phase 0 checklist (0a ticked), and pack/install reference. Write the returned file to disk.

**Exit criteria:** `write_identity` returned success; `CLAUDE.md` written to disk.

## Phase 0b — Intake (required)

**Preconditions:** Phase 0a complete — module identity confirmed, `CLAUDE.md` written.

**Action:** Walk through the questions below **one at a time, in sequence**. After each answer, apply the validate-and-reflect rule (hard rule #4): restate what you understood, confirm, then proceed to the next question. Each subsequent question is informed by prior answers — don't ask Q2 in a way that contradicts what Q1 established. Don't batch.

**Interaction style — free-form prose only.** Every question in Phase 0b is asked as a plain-language sentence in your conversation message. Do **NOT** use `AskUserQuestion`, picker UIs, multiple-choice tabs, structured forms, or any tool that presents the user with predefined options to choose from. The whole point of Phase 0b is to elicit the user's own words about purpose, user types, and verbs — predefined buckets bias the answer into your taxonomy and lose the verbs we need for Phase 5. If your client offers a picker tool, suppress it for Phase 0b; resume normal tool use in Phase 1+.

**Forbidden picker examples that have leaked in past sessions** (do not present any variant of these):
- "Single role / Two roles / Three+ roles" — predetermines security shape before entities exist
- "admin / manager / user / viewer" or "admin / contributor / viewer" — imposes a generic taxonomy

**Exception:** if the user explicitly says "give me defaults" / "pick reasonable defaults" / similar, you may propose a default brief in one block, restate it, and ask "any to override?". Otherwise, sequential free-form text only.

**Question order** (use the wording in your own voice):

1. **Purpose.** "In one sentence, what does this module do?"
   Reflect: "OK — so it's a `<paraphrase>`. Right?" → wait.

2. **User types and verbs** — capture in plain language. "Who'll use this, and what does each type DO with it?" Listen for verbs that imply actions on data: submits, approves, reviews, issues, receives, matches, closes, etc.

   **Capture format — full verb-form sentences, not role labels.** Write each as `<descriptor of the person> <verb phrase>`. Never use role-noun labels (Requester, Manager, Buyer, Admin, Approver, Viewer, Contributor, AP Clerk, etc.) as the bullet head — those are role NAMES which prematurely commit to a security taxonomy.

   ✅ Good:
   ```
   - Anyone in the company submits purchase requests and tracks their own.
   - Department managers approve or reject pending requests for their team.
   - Buyers in the procurement team manage suppliers, collect quotes, and issue purchase orders.
   - Warehouse staff confirm what physically arrived against the PO.
   - Accounts payable staff match supplier bills against the PO and receipt, then approve for payment.
   ```

   ❌ Bad (role labels as headings):
   ```
   - **Requester** — submits purchase requests
   - **Approver** — approves pending requests
   - **Buyer** — manages suppliers
   - **AP Clerk** — matches bills
   ```
   The bad form trades situational verbs for fixed nouns and biases Phase 5 toward exactly those roles. Phase 5 might consolidate (e.g. one role covers both warehouse and AP) or split — that's Phase 5's job.

   Example missing verbs: "admins and users" — push back: "What does an admin do that a user can't?"
   Reflect: "So users are: `<bullets>`. Right?" → wait.

   **Hard forbidden in Phase 0b:** do NOT emit role codes (`<code>.admin`, `<code>.requester`, etc.), do NOT use role-noun labels as bullet heads, do NOT propose a rights matrix, do NOT add a "Target user roles" section to the brief. Roles are derived from entities + verbs in Phase 5, and **entities don't exist yet**.

3. **Optional follow-up — domain ambiguities.** If anything in answers 1-2 left an open question (e.g. "what counts as a 'closed' feedback item?", "is the submitter always a logged-in user or also anonymous?"), ask that question now, one at a time. Continue until you can describe how the module should work without any open questions in your head. **Goal of Phase 0b: you understand the module well enough to design entities in Phase 1 without further clarification.**

Dependencies and locales were already confirmed in Phase 0a — carry them into the brief without re-asking.

**Forbidden sections:** any roles table, any entity proposal (entities are Phase 1's deliverable). If you find yourself drafting a "Target user roles" table — stop and replace it with the verb-only bullet list.

**Requirements gap scan** — before drafting `docs/REQUIREMENTS.md`, run these checks and surface findings inline (one block, format: "**Gap:** … **Proposal:** … Confirm or change?"):

- **Approval recovery**: if any process involves approve/reject, is rejection terminal or re-submittable?
- **Audit depth vs. personas**: if any user type is an approver/reviewer/manager, `audit-full` is likely needed — flag if "timestamps only" was chosen.
- **Integration entity codes**: confirm exact `module.entity` codes if integrations are mentioned.
- **Implied entities**: if a process implies an entity not yet named, flag the gap.
- **Scale → sequence length**: if the domain implies reference numbers, propose a sequence pattern.

**Draft `docs/REQUIREMENTS.md`**, show it in full, wait for explicit YES, then call:
```
dforge_module_plan({ action: "write_requirements", moduleDir, content: "<full markdown>", userConfirmed: true })
```
The tool writes `docs/REQUIREMENTS.md` and ticks 0b in CLAUDE.md. Write the returned files to disk.

## Phase 0c — Schema Design (required)

**Preconditions:** Phase 0b complete, `docs/REQUIREMENTS.md` written, **and the user has explicitly confirmed it**. Do not begin Phase 0c until the requirements file is written and confirmed — this is a hard block, not a suggestion.

**Action:** produce a structured design outline — **readable prose and tables, not JSON yet**. If the user already provided entity names, fields, or relationships in their opening message, incorporate that material directly rather than designing from scratch — treat provided information as confirmed and flag only gaps or additions you are proposing.

**Eight design items** (present all in one message, in this order):

1. **Entity list** — each entity's name and one-line purpose, ordered least-dependent → most-dependent (lookup tables first, line items last).
2. **Fields per entity** — key fields, status dropdown values (all options), required lookups/references, formula columns, number-sequence columns (e.g. `invoice_number → INV-{yyyy}-{seq:4}`).
3. **Relationship map** — a Mermaid `erDiagram` of every entity and its N:1 FKs, plus a compact FK table (`child.fk_col → parent.pk_col`, required/optional). Count the total.
4. **Status machines** — for every entity with a `status` field: all values, which action transitions each, `canExecute` guard expression, recovery path (re-submittable or terminal).
5. **Actions** — name, target entity, what it does, any params the user must fill in.
6. **Seed data** — which entities need initial rows and what records (with explicit numeric PKs), in parent-before-child order.
7. **Reports & queries** — any aggregate reports, saved query shortcuts, or print templates (list each with entity/dataset and key columns, or "None").
8. **Special behaviors** — per entity: soft-delete/archiving, manual ordering (`sorting` trait), outbound webhooks, print templates.

**Gap detection pass** — after drafting all eight items, scan for the following issues. Add a "## Gaps & Proposals" section in `docs/DESIGN.md` for every gap found (format: "**Gap:** … **Proposal:** … Confirm or change?"). If no gaps, omit the section.

- **FK optionality**: a required FK with no seed data for its target causes the first insert to fail — flag it.
- **Status machine recovery**: for any rejected/failed/cancelled state, document whether the record is re-submittable or terminal. Add a "Recovery" column to the status table.
- **Boolean-to-status smell**: if an entity has 2+ boolean fields (e.g. `is_active`, `is_approved`), flag that these may belong in a single `status` dropdown.
- **Set aggregation risk**: any formula using `SUM([set].[field])` → mark `⚠ version-dependent` and ask the user to confirm their dForge version supports it.
- **Deep navigation (async formulas)**: any formula with 2+ dot hops (e.g. `[department].[manager].[email]`) is async and may appear stale on initial page load — propose a denormalized field instead.
- **Self-referential FK**: if an entity references itself, confirm the column is nullable and the seed data has no cycles.
- **Security coverage**: verify every entity appears in at least one role with Insert (`I`) rights. List any entity reachable by no role's Insert right as a gap.
- **Seed data circular references**: if entity A needs a FK to B in seed data and B needs a FK to A, one FK must be nullable and set in a second-pass update — flag which FK to make nullable.

**Write `docs/DESIGN.md`** using this template:

````markdown
# Design Document
<!-- written after Phase 0c approval — edit with care -->

## Entity List
<name — one-line purpose, ordered least- to most-dependent>

## Fields per Entity
### <EntityName>
<key fields, status values, formulas, number sequences>

## Relationship Map
<!-- crow's-foot cardinality: ||--o{ = required N:1 (child must have a parent); |o--o{ = optional N:1. One edge per FK; replace names with your entities. -->
```mermaid
erDiagram
    parent_entity ||--o{ child_entity : "verb"
    lookup_entity |o--o{ child_entity : "verb"
```

| Relationship (child FK → parent PK) | Required |
|-------------------------------------|----------|
| child_entity.parent_id → parent_entity.id | required |
| child_entity.lookup_id → lookup_entity.id | optional |

Total FKs: <N>

## Status Machines
### <EntityName>
| Status | Transitions via | canExecute guard | Recovery |
|--------|----------------|-----------------|----------|

## Actions
| Name | Target Entity | Description | Params |
|------|--------------|-------------|--------|

## Seed Data
<entity name — rows needed, in parent-before-child order>

## Number Sequences
<column → pattern, or "None">

## Reports & Queries
<report/query name — entity, key columns; or "None">

## Special Behaviors
<entity — soft-delete? sorting? webhooks? print templates? — or "None">

## Gaps & Proposals
<findings from the gap detection pass, or omit this section if none>

---
*Approved: <date>*
````

**Confirmation gate — DESIGN.md (blocking):** Output the entire draft `docs/DESIGN.md` in full. End with: "Please review this design document. Reply **YES** to confirm it is correct, or describe what to change."

- Do NOT proceed until the user replies with explicit confirmation ("yes", "looks good", "confirmed", "LGTM", or equivalent).
- If they request changes: apply them, re-output the full updated document, and ask again. Repeat until confirmed.
- Once confirmed, call:
  ```
  dforge_module_plan({ action: "write_design", moduleDir, content: "<full markdown>", userConfirmed: true })
  ```
  The tool writes `docs/DESIGN.md` and ticks 0c in CLAUDE.md. Write the returned files to disk. Phase 0d follows.

## Phase 0d — Pre-Scaffold Verification (required)

**Preconditions:** Phases 0a, 0b, 0c complete.

**Action:** Call `dforge_module_plan({ action: "validate", moduleDir })`. The tool runs structural checks (docs present, identity consistency, relationship completeness, gap resolution) and returns:
- Either: failures to fix + instructions — fix the docs and call `validate` again.
- Or: structural checks pass + document content + 7 semantic check descriptions to evaluate.

Evaluate the 7 semantic checks below against the returned document content, then call:
```
dforge_module_plan({ action: "validate", moduleDir, checkResults: [...] })
```
with results for all 7 checks. If all 11 pass, the tool writes `docs/VALIDATION.md` with `readyToScaffold: true` and ticks 0d.

**The 11 checks** (structural = tool; semantic = you evaluate):

1. **Identity consistency** — module code and display name in `CLAUDE.md` match the Domain section of `REQUIREMENTS.md`.
2. **Locale coverage** — locales declared in `CLAUDE.md` align with translation scope in `REQUIREMENTS.md` (Audit Depth, language implications).
3. **Persona → entity coverage** — every user persona in `REQUIREMENTS.md` User Personas maps to at least one entity in `DESIGN.md` that they interact with. No persona is left without a data home.
4. **Core process coverage** — every core process in `REQUIREMENTS.md` Core Processes has a corresponding entity, action, or status machine in `DESIGN.md`. No orphan processes.
5. **Entity traceability** — every entity in `DESIGN.md` Entity List can be traced to a need stated in `REQUIREMENTS.md`. No invented entities.
6. **Relationship completeness** — every entity referenced in the Relationship Map exists in the Entity List.
7. **Status machine completeness** — every entity with a `status` field has a complete machine: all values, all transitions, all guards, recovery path documented.
8. **Action completeness** — every verb in `REQUIREMENTS.md` Core Processes that implies a user-triggered operation appears in `DESIGN.md` Actions table.
9. **Seed data coverage** — if `REQUIREMENTS.md` implies initial reference data or starting state, `DESIGN.md` Seed Data section covers it.
10. **Gap resolution** — every item in `DESIGN.md` Gaps & Proposals section has an explicit resolution (confirmed or deferred with justification). No open, unaddressed gaps.
11. **Docs present & substantive** — `REQUIREMENTS.md` and `DESIGN.md` both exist with real content, not empty stubs.

**If any check fails:** the tool returns failures without writing VALIDATION.md. Fix the issue in the relevant document, then call `validate` again (without `checkResults` to re-run structural checks, then with new semantic results).

**Exit criteria:** `dforge_module_plan validate` returned `readyToScaffold: true`; `docs/VALIDATION.md` written to disk.

## Phase 1 — Domain (required)

**Preconditions:** Phases 0a through 0d complete — `CLAUDE.md` written; `docs/REQUIREMENTS.md` confirmed; `docs/DESIGN.md` confirmed; `docs/VALIDATION.md` shows a clean pass with no open findings.

> ⛔ **GATE — `dforge_module_create` is blocked at the tool level.** It throws if any of the four Phase 0 docs are missing or if `docs/VALIDATION.md` doesn't contain `readyToScaffold: true`. If you hit the gate error, call `dforge_module_plan({ action: "check", moduleDir })` to see what's needed.

**This phase's FIRST deliverable — before any tool call — is the proposed entity inventory.** Show it. Get explicit sign-off. Then scaffold. The user needs to see "the module will have these N things in it" before files exist, because entities are the spine the rest of the module hangs from (views, actions, roles all reference entity codes).

**Pre-scaffold validation** — before calling `dforge_module_create`, run these five consistency checks against `docs/DESIGN.md`. If any fail, surface the issue to the user and return to Phase 0c to fix it — do not silently adjust the design:

1. Every FK in the relationship map has a corresponding field listed for the child entity.
2. Every action's `canExecute` guard references a status value that exists in that entity's options list.
3. Every seed record's FK references a parent entity that also has seed data (referential integrity in load order).
4. Every formula column uses only fields that exist on the same entity or a directly referenced entity (exactly 1 FK hop). Transitive references (2+ hops) are async and must have been flagged in the Phase 0c gap scan.
5. Any `SUM([set].[field])` formula is flagged as version-dependent.

Once all checks pass, present a brief summary (entity count, action count) and ask for final confirmation before calling `dforge_module_create`.

**Sub-steps:**

1. **Propose the entity inventory.** Re-read `_brief/00-intake.md`'s purpose and user-verbs sections. Derive an entity list: each meaningful "thing the user verbs against" tends to become an entity. Present as:
   ```
   Proposed entities (N):
   - <entity_code> — <one-line description, ties to a verb / use case from intake>
   - ...
   ```
   Apply the validate-and-reflect rule: "Here's what I think the module needs. Right shape and scope? Add / remove / merge?" Loop with the user until they explicitly approve the list.

   Write the approved inventory to `_brief/01-domain.md`.

2. **Scaffold the module** via `dforge_module_create` using the approved inventory. Preview the file map, get approval, then user writes.

3. **Per-entity loop.** For each entity in order, propose fields + traits + references. **Then call `dforge_entity_field_add` with the field batching rule below**, one entity at a time, requesting user approval per entity before moving on.

4. **Extension entities last.** If extending another module's entity, use `extends: "module.entity"`, `toString: null` (inherits base), and a dotted manifest key. **Snapshot the base entity's current fields via `dforge_module_inspect` on the dependency dir** (when available) so you know what's inherited; if the dependency dir is not locally available, document the known base fields from `docs/DESIGN.md` and note in `_brief/changelog.md` that base-entity field drift is the user's responsibility to track.

**Mandatory reference reads for Phase 1** — load these before the first field of each entity, then again whenever the element type changes:

- **Any field:** read `references/field-types.md` + `references/flags.md`.
- **Reference or Set column:** also read `references/column-types.md` + `examples/simple-todo/entities/todo_item.json` (canonical FK + Reference pair).
- **Formula column:** also read `references/formulas.md`.
- **Trait selection:** read `references/traits.md`.
- **Number-sequence column:** read `references/number-sequences.md`.

Do not call `dforge_entity_field_add` for any of these types without having read the matching files first.

**Field batching rule** (the only Phase-1 exception to the hard rule):

A field is **batchable** only if ALL of these are true: scalar primitive (string / integer / decimal / boolean / date), no FK or Reference, no `formula`, and the nullability is unambiguous (e.g. required-not-null per intake context). Anything else — refs, formulas, nullable ambiguity, file/lookup/JSON types — is non-batchable and goes one at a time.

**Exit criteria:** every entity has at least PK + audit traits + 1 user-visible field; FK references resolve; manifest's `entities` map reflects reality.

## Phase 2 — Behavior (optional sub-steps)

**Preconditions:** Phase 1 complete.

Phase 2 covers four kinds of behavior — all optional, all individually skip-able. Each fires action logic, but the **trigger** differs:

| Sub-step | Fires when | File | Tool | Use when |
|---|---|---|---|---|
| 2a Actions | user clicks a button | `ui/actions.json` + `logic/actions/*.dsl` | `dforge_action_add` | bulk operations, business workflows, anything that needs user input via params |
| 2b Triggers | DB event happens (insert/update/delete/status_change) | `logic/triggers.json` | `dforge_trigger_add` | reactive automation: "when X happens, do Y" without user action |
| 2c Scheduled jobs | cron timer | `logic/jobs.json` | `dforge_job_add` | periodic work: nightly cleanup, daily summary, hourly poll |
| 2d Webhooks | DB event happens → POSTs to external URL | `logic/webhooks.json` | `dforge_webhook_add` | integrations: Slack notifications, Zapier, external dashboards, audit log shipping |

Skip a sub-step entirely if the user has no need for it. Do NOT fabricate behavior to fill a sub-step. Phase 2 can be completely skipped for pure CRUD modules.

### 2a. Actions — user-triggered

**Before authoring any action (DSL body or `ui/actions.json` registration), you MUST load all four:** `dforge://docs/dsl` (full grammar + built-ins), `references/action-dsl.md` (patterns + anti-patterns; §"Registering the action" covers the full `ui/actions.json` schema), `examples/simple-todo/logic/actions/mark_done.dsl`, and `examples/simple-todo/ui/actions.json` (working end-to-end examples). Loading fewer than all four is insufficient — common mistakes (wrong field-access syntax, wrong batch-mode flag, wrong or missing `ui/actions.json` property names) are only caught by cross-referencing all four. `dforge://docs/conventions` is broader module-level guidance and does NOT cover the DSL grammar.

Call `dforge_action_add` per action — one at a time — with the full DSL body. Confirm with the user before each call.

### 2b. Triggers — DB-event-driven

**Load `dforge://schema/triggers`** for the shape; also re-read the trigger formula rules in `dforge://docs/dsl` (trigger conditions use the same syntax as `canExecute:`: single-line `[field] op value` formulas).

For each trigger, propose: entity + event + (optional) condition formula + target action + async flag. Use `dforge_trigger_add`. Triggers reference EXISTING actions — make sure the target action was added in Phase 2a before creating any trigger that references it.

**Async vs sync:** `async: true` runs the action in the background after the triggering transaction commits — recommended for slow actions (emails, external API calls). `async: false` runs in the same transaction; action failure rolls back the original DB change.

### 2c. Scheduled jobs — cron-driven

**Load `dforge://schema/jobs`**.

Constraints baked into the tool:
- Action MUST NOT use record-context (`[field]`) syntax — jobs run as system user with NO current record. Wrap any record-context action in a thin job-friendly action that uses `query()` to fetch the records it needs.
- `timeout` is required, ≤ 3600s.
- If `timeout > 300`, you MUST set `jobClass: 'long_running'`.

Use `dforge_job_add` per job.

### 2d. Webhooks — outbound HTTP

**Load `dforge://schema/webhooks`**.

For each webhook: entity + event + endpoint URL + (optional) condition + (optional) payload shape (include/exclude/includeOld). Use `dforge_webhook_add`.

For authenticated endpoints: put bearer tokens / API keys behind `getSecret()` (configure secret in module's secrets), reference in headers as `"Authorization": "$secret:<secret_cd>"` — the platform resolves at fire time.

**Exit criteria for Phase 2:** every action / trigger / job / webhook you added is intended (user-requested, not fabricated to fill space) and references existing entities + actions. Compilation is validated at install in Phase 6.

## Phase 3 — Views (required) + Reports (optional)

**Preconditions:** Phase 1 complete.

**Mandatory reference reads for Phase 3** — load before the first element of each type:

- **Any data view (grid, kanban, calendar, etc.):** read `references/data-views.md` + `examples/simple-todo/ui/data_views.json`.
- **Any menu:** read `references/menus.md` + `examples/simple-todo/ui/menus.json`.
- **Any filter (view, folder, or report):** read `references/filters.md`.
- **Any report:** read `references/reports.md`.

Do not call `dforge_view_add`, `dforge_view_modify`, or `dforge_report_add` without having read the matching files.

### 3a. Default grids (required, do FIRST)

For every entity in the manifest, call `dforge_view_add` with `viewType: "grid"` and `dataSources: [{ entityCode: <entity>, columns: [...] }]`.

**View naming.** View codes in `ui/data_views.json` are semantic — convention is the entity name (`feedback_item`), the plural (`invoices`), or descriptive (`invoices_kanban`, `feedback_by_status`). Do NOT use the literal code `default`. When `ui/folders.json` entities reference `viewName: "default"`, the platform resolves that to the entity's first view declared in `data_views.json` — it's a fallback alias, not a required view code. (The scaffolder already wrote a default grid keyed by entity code in Phase 1, so often you'll `view_modify` it rather than `view_add`.)

**Do not propose any specialized view until every entity has its default grid.**

### 3b. Specialized views (optional, only after 3a complete)

Propose a specialized view (kanban / calendar / list-with-levels / tree-grid / master-detail) **only when one of these objective triggers fires**:

- The user explicitly mentioned the visualization ("show leads as a kanban", "we need a calendar for tasks").
- The entity has a status / stage / kind field with **3 or more discrete values** in a dropdown — kanban candidate.
- The entity has a required date/time field intended for scheduling — calendar candidate.
- The entity self-references (parent FK to itself) — tree-grid candidate.
- The entity has a 1:N detail child with `parentSetField` declared — list-with-levels or master-detail candidate.

If none of these fire, skip specialized views for that entity. Read `dforge://schema/data-views` for the `viewConfig` shape of the type you're proposing before calling `dforge_view_add`.

### 3c. Reports (optional)

Add reports only when management aggregation/grouping isn't covered by views. `dforge_report_add` with layout + datasets (Query type with entityCd + filter + sort, or Stored Procedure). Pull `dforge://schema/reports` first.

**Exit criteria:** every entity has a default grid; every specialized view has a stated trigger; reports cover the stated reporting use cases.

## Phase 4 — Polish: settings, translations, seed (mostly optional)

**Preconditions:** Phase 3 complete.

**Mandatory reference reads for Phase 4** — load before the first element of each type:

- **Settings:** read `references/settings.md`.
- **Translations:** read `references/translations.md`.
- **Seed data with number sequences:** read `references/number-sequences.md`.
- **Print templates:** read `references/print-templates.md`.
- **Saved queries:** read `references/queries.md`.

- **Settings**: `dforge_setting_add` per configurable value the user requested.
- **Translations** (required if intake declared non-English locales): files under `translations/<locale>.json`. **If the user defers translation authoring, append to `_brief/changelog.md`: "Translation files for [locales] are incomplete. Phase 6 install will fail translation completeness validation until added." Remind the user before calling `dforge_module_pack`.**
- **Seed data**: only when the module needs reference data on install.

**Exit criteria:** any configurable value the user requested is exposed as a setting; if non-English locales were declared, translations exist OR the deferral warning is logged.

## Phase 5 — Security

**Preconditions:** Phases 1 and 3a complete (you need entity codes and default grid views to grant rights on; actions and reports added in Phases 2 and 3b/3c can be granted as they are added).

### 5a. Roles + rights matrix (required)

**Mandatory reference reads for Phase 5** — load before any role or folder work:

- **Roles + rights matrix:** read `references/security.md` + `examples/simple-todo/security/roles.json`.
- **Security folders with row filters:** also read `references/filters.md`.

Do not call `dforge_role_add`, `dforge_role_right_set`, or `dforge_folder_add` without having read the matching files.

1. **Inspect first.** Run `dforge_module_inspect` and read the `roles` array. The scaffolder pre-creates `<code>.admin` with `SIUDC` on every entity declared at scaffold time. That role exists already — don't try to re-create it.
2. **Derive role inventory FROM the intake's user types and verbs — never default to a fixed taxonomy.** Re-read `_brief/00-intake.md`'s `User types` section. For each distinct user type, propose ONE role named `<code>.<user-type>` (e.g. intake said "any signed-in user submits + admins triage" → `<code>.user` (covers the "submits" verb) + the existing scaffolded `<code>.admin` (covers triage). If intake mentioned "approvers" or "auditors" or "managers" or any other group, derive roles for those too.) **Forbidden:** spinning up a generic `admin/contributor/viewer` matrix when the user didn't ask for it. The rights set should map to the verbs each user type does, not to a textbook role hierarchy.
3. Reflect the proposed role list back to the user before computing rights: "Based on intake, I see these user types → these roles: `<list>`. Right?" Get explicit confirmation. If the user clarifies / adds / removes, re-list and re-confirm.
4. Show the rights matrix as a table (rows = entities/actions/reports, columns = the confirmed roles, cells = rights string). Each cell explained by the verb-to-right mapping you derived. Get user sign-off on the matrix.
5. **For new roles**: call `dforge_role_add`. **For amending existing roles** (the scaffolded admin, or grants on actions/reports added in Phases 2-3 that aren't yet in any role): call `dforge_role_right_set` per grant — it's the smallest tool and doesn't conflict with the scaffolded admin role. Calling `dforge_role_add` against an existing role code fails — use `role_right_set` to amend instead.

**Rights semantics** (additive — multiple roles UNION, never revoke):
- Entities: any subset of `SIUDC` (Select / Insert / Update / Delete / Clone)
- Actions / reports: `E` (Execute), or omit to deny

### 5b. Security folders (optional)

Only if intake said data must be partitioned per folder (multi-warehouse, multi-region, multi-tenant-like). Default: root only.

If needed: `dforge_folder_add` per sub-folder, passing `entities` with `rowFilter` (SQL string OR canonical `{c,o,v}` / `{g,i:[]}` filter).

**Exit criteria:** run `dforge_module_inspect` and verify every entity code in the manifest appears in at least one role's rights map with at least `S` (Select); list any uncovered entity as a gap before advancing to Phase 6. If folders were declared, every folder has security mapped.

## Phase 6 — Verify (required, non-skippable)

**Preconditions:** all required phases complete: 0a, 0b, 0c, 0d, 1, 3a, 5a. Optional phases (2, 3b/3c, 4, 5b) are not preconditions — explicitly skipped optional phases do not block Phase 6.

**Steps:**

### Step 1 — Pre-pack self-review (blocking gate)

Load `references/validation-checklist.md`. Run through **every section** in order. Surface each failure to the user and apply the backtrack protocol before proceeding. Do not advance to Step 2 until all checks pass. Key areas:

- **Manifest**: `moduleId` is a valid UUID; `version` and `dbSchemaVersion` are set; `supportedLocales` matches the translation files declared; `security` block has both `roles` and `folders`; `translations` is a locale-keyed object (not an array).
- **Entities**: every entity has `identity` + `audit` traits, a `toString` template, and the FK+Reference pattern applied wherever a relation exists (hidden FK column `flags: "EM"` + visible Reference column `columnType: "R"` + entry in `references` block).
- **Formula columns** (`columnType: "F"`): have `baseDatatypeCd`, no `dbDatatype`, `flags: "V"`.
- **Flags**: only `V`, `I`, `E`, `M`, `H` used — no `U`, `S`, or `P`.
- **Data views**: every entity has a default grid; `dataSources` array present at root; sort uses `"order": ["-col", "col"]` string-array (never `"sort": [{column_cd, direction}]`).
- **Menus**: leaf items have `dataViewCode` (not `viewCode`); icons are Bootstrap names without the `bi-` prefix; section nodes omit `itemType`.
- **Security**: every entity code in the manifest appears in at least one role's rights map; `rights` key used (not `entityRights`); entity rights use `SIUDC` letters; actions/reports use `E`.
- **Actions**: every `script` value in `ui/actions.json` is a bare filename (no path, no `.dsl` extension); every action referenced by a trigger or job exists in `ui/actions.json`.
- **Seed data**: numeric PKs; parent entities loaded before children; no circular references.
- **Translations**: a `translations/<locale>.json` file exists for every locale in `supportedLocales`; every trait-provided field (`created_at`, `updated_at`, etc.) has a translation entry in each file.

### Step 2 — Translation deferral check

Read `_brief/changelog.md`. If a translation deferral warning is present ("Translation files for [locales] are incomplete"), halt here. Tell the user: "Translation files must be completed before packing — install will fail translation completeness validation." Do not proceed to Step 3 until resolved.

### Step 3 — Final inspect + version audit

Run `dforge_module_inspect`. Show a one-line summary: entity count, view count, action count, role count. Then confirm version strings with the user:

- **`version`**: always bump (semver) before packing.
- **`dbSchemaVersion`**: bump only if any entity fields were added, removed, or type-changed since the last install. If unsure, compare current entity schemas against the last committed state.

Get user confirmation on both version strings before packing.

### Step 4 — Pack + install

1. `dforge_module_pack` → produces `.dforge` tarball.
2. `dforge_module_install` with `DFORGE_URL` / `DFORGE_TOKEN`. Runs the full server-side validator.

**If install fails on a module defect**, use this table to identify which phase to backtrack to, then apply the backtrack protocol, fix, re-run Step 1 (self-review), and re-pack:

| Install error pattern | Backtrack to |
|---|---|
| "unknown entity code" or "unknown view code" | Phase 1 or 3 |
| "missing translation key" | Phase 4 |
| "FK constraint violation in seed data" | Phase 1 (check seed data load order) |
| "role right granted on unknown object" | Phase 5 |
| "action script not found" | Phase 2a |
| "formula compile error" | Phase 1 (field def) or Phase 2a (DSL) |
| "duplicate code" | Phase where the duplicate was introduced |

**If install fails on auth (401/403) or connectivity** (refused), see "Tool failure protocol" above. Do not backtrack — fix credentials.

**Exit criteria:** install exits 0 against a real tenant.

## Backtrack protocol

When a later phase exposes a problem in an earlier phase, follow steps 1–6 IN ORDER:

**Multi-trigger rule (deterministic):** If multiple phases simultaneously expose gaps in earlier phases (e.g. Phase 3 needs a field; Phase 5 needs an action), resolve the **earliest-phase gap first**, complete its full backtrack, run `dforge_module_inspect`, then evaluate remaining gaps.

1. **Stop the current phase.** Don't paper over or improvise.
2. **Name the issue precisely.** "Phase 3 wants a kanban grouped by `lead_status`, but Phase 1 didn't define `lead_status` on entity `lead`."
3. **Identify the target phase + decision.** "Backtrack to Phase 1: add field `lead_status` to entity `lead`."
4. **Get user sign-off.** Describe the change including any cascading impacts.
5. **Apply the smallest tool that fits.** This rule overrides the "typical phase" labels in the tool reference table. Prefer `entity_field_add` over `entity_add`; `role_right_set` over `role_add`; `view_modify` over `view_add` + remove.
6. **Run `dforge_module_inspect` again** to surface knock-on impacts. Fix in order. Resume the original phase.

**Entity rename or deletion specifically requires cascade discovery:**

Before applying:
1. Run `dforge_module_inspect` to enumerate every reference: views' `dataSources.entityCode`, role `rights` keys, action `entity`, report dataset `entityCd`, seed-data files, formula/DSL bodies.
2. List every affected artifact to the user. Require explicit confirmation.
3. Apply in **reverse dependency order**: roles → reports → views → actions → entity itself.
4. Re-inspect; verify no dangling references remain.

**After every backtrack** append to `_brief/changelog.md`:

```markdown
## <YYYY-MM-DD> — Phase N → Phase M backtrack
- Trigger: <what later phase tried to do>
- Change: <what was patched>
- Affected files: <list>
```

## Final hygiene

After Phase 6 install succeeds:

**Ask the user**: "Delete `_brief/` (session scratch) or move it to `docs/` for committed design rationale?". Wait for their answer; do not act unilaterally.

Suggest a `git commit` summarizing the module. Do not commit unless the user asks.
