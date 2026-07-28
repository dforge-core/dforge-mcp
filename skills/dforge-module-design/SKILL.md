---
name: dforge-module-design
description: Phase 0 of dForge module authoring — module identity, requirements intake, the design document, and pre-scaffold validation. Use when starting a NEW dForge module, or when dforge_module_plan reports a currentPhase of 0a/0b/0c/0d. Produces CLAUDE.md, docs/REQUIREMENTS.md, docs/DESIGN.md and docs/VALIDATION.md, and ends by unlocking dforge_module_create. Do not use for building entities or views — that is dforge-module-build.
---

# dForge module — Design (Phase 0)

You are designing a module **before any code exists**. The output is four
documents. Nothing here creates entities, views, or JSON artifacts.

Phase 0 is driven by the **`dforge_module_plan`** tool: call it, ask what it
returns, write what it tells you to write. It is the source of truth for the
question lists, the design template, the gap checks, and the gate — don't
re-derive them from memory.

> **Prerequisite:** you should have arrived here from `dforge-mcp-author` after
> `dforge_module_plan({ action: "check", moduleDir })` reported a Phase 0
> `currentPhase`. If you haven't made that call yet, make it now.

## The loop

| Sub-phase | You do | Then call |
|---|---|---|
| **0a** Identity | Ask the 5 returned questions, ONE at a time | `write_identity` → write the returned `CLAUDE.md` to disk |
| **0b** Intake | Ask the returned questions in free-form prose; write `docs/REQUIREMENTS.md` to disk; get an explicit YES | `write_requirements { userConfirmed: true }` |
| **0c** Design | Draft `docs/DESIGN.md` from the returned `designTemplate` covering all 8 `designItems`; run the gap scan; write to disk; get an explicit YES | `write_design { userConfirmed: true }` |
| **0d** Validate | `validate` (structural) → evaluate the returned `semanticChecks` against the docs → `validate` again with `checkResults` | unlocks `readyToScaffold: true` |

After every user answer: **restate what you understood and confirm** before
moving on.

## Document-write ordering (the one exception to preview-first)

For `REQUIREMENTS.md` and `DESIGN.md` you **write the file to disk first**, then
ask the user to review the file and reply YES — do not paste the full document
into chat. Give them a short orientation instead: section headings, counts, and
gap status ("No gaps" or a one-line list).

On a change request, **edit the file directly** with targeted edits, summarize
the change in one line, and ask again. Loop until they confirm.

`userConfirmed: true` means the user actually said yes to the written file. The
tool has no way to check that — it is on you.

## 0b intake — guardrails the tool can't enforce

**Free-form prose only.** Ask every 0b question as a plain sentence. Do **NOT**
use `AskUserQuestion`, picker UIs, multiple-choice tabs, or any predefined-option
tool. Predefined buckets bias the answer into your taxonomy and destroy the verbs
Phase 5 needs to derive roles. Resume normal tool use in Phase 1.

Forbidden picker variants that have leaked before: _"Single role / Two roles /
Three+ roles"_; _"admin / manager / user / viewer"_.

**Capture user types as verb-form sentences, never role labels.** Write each as
`<descriptor of the person> <verb phrase>`:

✅ Good:
```
- Anyone in the company submits purchase requests and tracks their own.
- Department managers approve or reject pending requests for their team.
- Buyers in procurement manage suppliers, collect quotes, and issue purchase orders.
```

❌ Bad (role-noun headings pre-commit Phase 5 to exactly those roles):
```
- **Requester** — submits purchase requests
- **Approver** — approves pending requests
```

Push back on verb-less answers: "admins and users" → _"What does an admin do
that a user can't?"_

**Hard forbidden in 0b:** role codes (`<code>.admin`), role-noun bullet heads, a
rights matrix, or a "Target user roles" section. Roles are derived from entities
plus verbs in Phase 5 — and entities don't exist yet.

### Requirements gap scan

Run before writing `REQUIREMENTS.md`. Surface each finding inline as
**"Gap:** … **Proposal:** … Confirm or change?"**

- **Approval recovery** — is a reject terminal, or can it be re-submitted?
- **Audit depth** — does the user need to record *who* changed each row, not just
  when? Only then `audit-full`. And if such an entity is also seeded, every seed
  record must set `created_by`/`last_updated_by: 0` (the System user) — otherwise
  use plain `audit`.
- **Integration codes** — the exact `module.entity` codes for anything external.
- **Implied-but-unnamed entities.**
- **Reference-number scale** → does it need a number sequence?

## 0c design — the gap detection pass

After drafting, run the gap detection the tool lists, and add a **Gaps &
Proposals** section for each finding. **All gaps must be resolved before 0d.**
The scan covers: FK optionality, status recovery paths, boolean-that-should-be-a-
status, set aggregation risk, deep navigation (2+ FK hops), self-referential FKs,
security coverage, and seed-data circular references.

Two design decisions to get right here, because fixing them in Phase 1 is a
backtrack:

- **A total over child rows is a Generated column**, not a Formula. Note it as
  such in the design. (`dforge_entity_rollup_add` enforces it later.)
- **A field with 3+ discrete states is a status**, not a boolean — and a 3+ value
  status is the objective trigger for a kanban view in Phase 3.

## 0d validation — what it does and doesn't certify

`docs/VALIDATION.md` / `readyToScaffold: true` certifies only that the **design
documents are internally consistent**. It runs *before* scaffolding and inspects
no entity / UI / security / DSL file.

Artifact correctness is enforced by `dforge_module_validate` and by the platform
at install. **A green VALIDATION.md is not a signal that the module will
install.** Say so if the user reads it that way.

## Exit

When `validate` returns `readyToScaffold: true`:

1. Write the returned `CLAUDE.md`, `docs/VALIDATION.md` and `docs/phase.json`.
2. Tell the user Phase 0 is complete and summarize the design in two lines.
3. **Hand off:** invoke the **`dforge-module-build`** skill to scaffold and build
   Phases 1–5. Do not call `dforge_module_create` from this skill.
