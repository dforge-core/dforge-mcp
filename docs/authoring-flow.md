# How the authoring flow works

This is the mechanics behind [the goals and principles](authoring-goals-and-principles.md). It is for people who change `dforge-mcp`, its skills or its checks, and for anyone who wants to understand why the agent asks what it asks.

## Parts

| Part | Where | Role |
|---|---|---|
| MCP tools `dforge_*` | `src/tools/` | Read and patch module files, validate, plan. |
| Skills | `skills/` | Instructions the agent follows per stage. |
| Vendored schemas | `resources/schemas/` | The JSON schemas the platform and the editor use. |
| Validator | `src/tools/validate/` | Static cross-reference and consistency checks. |
| Planner | `src/tools/plan-module.ts`, `src/tools/plan/` | Phase 0 questions, document templates, document checks, phase ledger. |

The skills split by stage so that each loads only what it needs:

| Skill | Phases | Owns |
|---|---|---|
| `dforge-mcp-author` | all | Routing: calls `dforge_module_plan check` and hands off. |
| `dforge-module-design` | 0a–0d | Identity, intake, design document, design validation. |
| `dforge-module-build` | 1–5 | Entities, behaviour, views and menus, polish, security. |
| `dforge-module-ship` | 6 | Validate, pack, install, fix loop. |
| `dforge-module-test` | any | Write, run and fix module tests. |

## Stages and artifacts

Each stage produces a document or a set of files. Each has a check.

| Phase | Artifact | Checked by |
|---|---|---|
| 0a Identity | `CLAUDE.md` | tool refuses missing fields |
| 0b Intake | `docs/REQUIREMENTS.md` | `plan validate` (sections, ids), user says YES |
| 0c Design | `docs/DESIGN.md` | `plan validate` (structure, matrix, outputs, gaps), user says YES |
| 0d Validation | `docs/VALIDATION.md`, `docs/phase.json` | structural checks plus semantic checks the agent evaluates; unlocks `dforge_module_create` |
| 1–5 Build | entity, logic, ui, security files | patch tools + write guard; `dforge_module_validate` |
| 6 Ship | packed and installed module | `dforge_module_validate`, CLI static checks, `pack`, `install` |

`docs/phase.json` records finished phases. `dforge_module_plan check` also reads evidence from the module itself (entities without fields, without a view, without a Select grant) and reports `gaps` when the ledger and the files disagree.

## What the documents contain

### REQUIREMENTS.md

Intake asks, one question at a time and in free prose (no pickers):

1. What the module does, in one sentence.
2. Who uses it and what each user type **does** (verb sentences, never role labels).
3. For each user type: what it must reach and what it must **not** see or change. Written under `## Access Needs`.
4. What the module must **produce**: printed documents, reports, exports, feeds, mails, with the recipient, format, frequency and a real sample or regulatory form. Written under `## Outputs`.

Requirements carry structured statements with ids so later stages can cite them:

| Prefix | Meaning |
|---|---|
| `S-n` | system (behaviour the system must have) |
| `N-n` | notification |
| `V-n` | visibility |
| `U-n` | user (a kind of user) |
| `R-n` | rule |
| `P-n` | permission |
| `O-n` | output (checked by the Outputs table, not by the statement-id check) |

These meanings are the ones the design skill and `plan validate` use; do not reassign them. Each id is defined once. Elsewhere, refer to it inside a sentence.

### DESIGN.md

Drafted from a template the planner returns. Besides entities, relations, statuses, actions, seed data, reports, visibility, rules (each with its enforcing mechanism) and notifications, it holds two machine-readable tables.

**Permissions Matrix**

```
| Role | Object | Rights | Statements |
|---|---|---|---|
| hr.officer | employee | SIU | P-1, V-1 |
| hr.accountant | employee | S | P-2 |
| hr.accountant | action:generate_payroll | E | P-3 |
```

- Role is the full code the role will have in `roles.json`. Object is the key exactly as `roles.json` spells it (`entity`, `dep.entity`, `action:x`, `report:x`, `sp:x`).
- Rights are `S I U D C` for entities and `E` for actions and reports. `-` is an explicit denial on an object the role has no other rights on; "may read, may not edit" is expressed by leaving out `I U D`.
- An absent pair means not granted.
- Actions that only a trigger or a job fires need no row: triggers do not check Execute.

**Outputs**

```
| Output | Kind | Source | Mechanism | Run by | Verified by |
|---|---|---|---|---|---|
| O-1 Hire order | print | employee.full_name, hire_order.salary | print:hire_order | hr.officer | manual: compare with the sample |
| O-2 Payroll file | export | payroll_line.net | export:payroll_line | hr.accountant | manual: open the csv |
```

- Kind is one of `print report export api mail file`.
- Mechanism is `<type>:<code>` with type `print`, `report`, `export`, `job`, `webhook` or `action`.
- Run by is a full role code, or `system`, `schedule`, `external`.
- Verified by is `test:<scenario name>` (only when a scenario can read the result back) or `manual: <how>`.

## What the platform does (and the design must respect)

These facts come from the core team and drive both the skills and the checks.

| Need | Mechanism | Notes |
|---|---|---|
| Printed form from a record | `print:<template>` in `ui/print_templates.json` plus `print_templates/*.html` (Liquid) | Needs Select on the entity. No separate print right. `{{ col }}`, `{{ _fmt.col }}` group numbers by the form's culture (`pageSettings.culture`). |
| PDF from an action | `printPdf(entity, key, templateCd)` | Needs a signed-in user. Fails in a scheduled job or a background action. |
| Mail from an action | `sendEmail(...)` | Queued; needs the workspace mail provider. No dependency on `comm`. |
| Reading mail | `fetchMail()` in an action (IMAP) | Inbound mail through `comm` is not ready; do not promise it. |
| Excel form of a list | `xlsx:<template>` in `ui/export_templates.json` plus `export_templates/*.xlsx`; the grid's Export menu, or `exportXlsx(entity, template, {filter, orderBy, fileName})` in an action | Rows of ONE entity (same columns as data.export). Cells `{{rows.column_cd}}`, `{{_count}}`, `{{_today}}`, totals `$=SUM(D{{$enumrowstart}}:D{{$enumrowend}})`. Needs Select. `exportXlsx()` is refused in a job. Nothing goes in `manifest.json`. |
| Data export | `data.export` of **one entity**, csv or xlsx | Writes visible, non-identity columns, excluding formula, set and query columns. No export of a report or a view. Needs Select. |
| Action without a selected record | omit `executionMode` | Appears in the entity grid toolbar, not in a menu. No `[field]` in the script. |
| Triggers | run in the writer's name | Execute is **not** checked for trigger actions. |
| Role in a folder | a `user_role(user, role, folder)` assignment by the tenant admin | `roles.json` has no folder keys. A folder only gives navigation; data access is entity rights plus the folder's row filter. |
| Test runner | insert, update, delete, action steps; `as: admin` only | No print or report steps, no other users. |

## The checks

`dforge_module_validate` runs a list of checks in `src/tools/module-validate.ts`. Every finding has a `where`, a `message` and, for new checks, a stable `rule` id used to group repeated findings in the summary. Findings are errors only when the module is certainly wrong; mid-build gaps and advisory findings (schema, outputs, most permission reachability) are warnings.

| Family | Rule ids | What it verifies |
|---|---|---|
| schema | `schema:<name>:<keyword>@prop` | Every module JSON against the vendored schema. The validator reports these as **warnings**, because the vendored schemas can differ from the installed platform. The editor, which uses the same schemas, shows each as an error, so treat them as defects to fix unless the schema itself is known to lag. |
| cross-references | (various) | Dangling references, views and menus, role keys on unknown objects, translations, DSL. |
| permissions | `perm:*` | `roles.json` equals the Permissions Matrix row by row (missing, extra, differing, denied-but-granted rights are errors). Per role: writes without Select, actions and reports whose entity it cannot read, actions nobody can run. |
| outputs | `out:*` | Every Outputs row exists in the module (`out:not-built`), reads real entities and columns (`out:source`), is runnable by its roles (`out:no-access`), names an existing test (`out:test-missing`); print templates are bound to a real entity, have their file and read only real columns (`out:print-*`); export columns are exportable (`out:export-column`); an action meant to print or mail calls `printPdf` or `sendEmail` (`out:mechanism-mismatch`); a job does not call `printPdf` (`out:print-in-job`). |
| cli | `cli: …` | The dforge-cli static checks, run in the same pass when the CLI is present. |

Two guards complement the validator:

- **Write guard** (`src/tools/schema-guard.ts`): a patch tool refuses a write that introduces a schema violation that is not already on disk, and lists the new violations. Pre-existing violations do not block unrelated edits. The manifest is advisory because the vendored manifest schema lags the platform.
- **Plan checks** (`src/tools/plan/design-checks.ts`): the same ideas applied to the documents before any module file exists. They are warnings so that older documents keep working; the semantic checks ask the agent to confirm points no parser can judge (for example, that every datum on a sample is a field).

## Extending the checks

A new check follows the same path:

1. Establish the platform fact. Ask the core team or read the core source; record the source in the commit or the message text.
2. Write the check in `src/tools/validate/` (or `plan/design-checks.ts` for documents), give each finding a stable rule id, register it in the `CHECKS` list.
3. Run it on real modules, including platform modules known to be good, and classify every finding true, false or unclear. Remove false positives before keeping it.
4. Add a test in `test/`.
5. Say in the relevant skill what the agent must do about the finding, in one or two sentences.
6. Add a line to `CHANGELOG.md`.

Prefer a warning with a clear next step to an error. Promote to an error only when the module is certainly wrong.

## Known limits and open questions

- Rendering: no check proves a print form or report looks right. The Outputs table marks such rows `manual`.
- The test runner cannot act as another role or render documents. Role permissions are verified statically against the matrix, not by acting as the role.
- Whether the row filter of a folder applies to `data.export` called without a folder was not verified.
- Excel templates cannot hold a record with its child sets, be attached to an email, or run in a job; the platform does not implement those yet. The tool cannot read inside the `.xlsx`, so it does not check that `{{rows.column}}` cells name real columns.
- Inbound mail through `comm` is not implemented in the platform yet.
- The vendored manifest schema may lag the platform (`shortDescription`, `security`).
- Library functions declared in `logic/functions/*.dsl` still produce false "not a DSL host function" warnings; this is a known core-side gap.

## Related

- [Creating a dForge module — three paths](creating-modules.md)
- Skills: `skills/dforge-mcp-author`, `dforge-module-design`, `dforge-module-build`, `dforge-module-ship`, `dforge-module-test`
- `CHANGELOG.md` for the history of changes to checks and skills.
