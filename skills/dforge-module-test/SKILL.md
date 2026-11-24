---
name: dforge-module-test
description: How to write, run and fix dForge module tests (tests/*.test.json, run by dforge-cli module test) — what a scenario should cover for actions, triggers, constraints, formulas, registers and reports, how to write each check, what the runner cannot test yet, and how to read a failure. Use when the user asks to add, write, review or fix module tests or scenarios, asks what a module's tests should cover, or when dforge-module-build reaches the scenarios step. Not for packing and installing (dforge-module-ship).
---

# dForge module — Tests

A module test is a JSON scenario that runs the module's behavior as the platform runs it
and checks the result. It finds what `dforge_module_validate` cannot: whether an action
produces the records it should, refuses when it should, and whether a posting moves a
register by the right amount. Validate checks the package's shape; a test checks that
it works.

Tests ship inside the module (`tests/*.test.json`). `module pack` zips them, the
installer ignores them.

## When to write them

Write a scenario as soon as the thing it checks works, not at the end:

- after an action or a trigger (Phase 2): one scenario per action, one per trigger
- after a register binding or a posting (Phase 2): the movement and the reversal
- after a constraint, a check or a formula the module's logic rests on
- after a report whose numbers a person will act on

A failing scenario is either a module defect or a wrong scenario. Decide which before
touching either. Never weaken an expectation to make it pass.

## What to cover

Cover behavior the module's author **chose**, not what the platform guarantees. Do not
test that an insert stores a value or that a grid loads.

| Module element | Scenarios worth writing |
|---|---|
| Action | The result it exists for (records added, fields changed). `refused: "canExecute"` on a record where it must not be offered. An `error` where a param or the data makes it fail. |
| Synchronous trigger (`async: false`) | The effect on the write, and the veto: the write that must be refused, with its error. |
| Check constraint, mandatory field, unique | One write that must be refused, with `error` (`code` and/or `contains`). |
| Formula, roll-up, generated column | `record` + `equals` after a write that changes its inputs, with `precision` for money. |
| Document with a register binding | Post: the register shows the movement (`register` or `query`). Unpost: it is gone. A posting that must be refused. |
| Report | The dataset's rows for records the test created: `report` + `contains`. Add a case where a filter or a param narrows the rows. |
| Number sequence, settings-driven value | One `record` check on the generated value, with the setting's default. |
| Upgrade migration | Not yet (see below). Check by hand against the previous version. |

Pick the cases where a mistake costs something: money, stock, a status that gates other
work. A handful of sharp scenarios beat one per field. Give each test a name that reads
as a sentence about behavior ("An entry that does not balance is not posted"), because
that name is what a failing run shows.

## Anatomy

```json
{
  "describe": "Create Quote from an opportunity",
  "tests": [
    {
      "name": "Create Quote adds a draft quote with a line per opportunity line",
      "given": [ ],
      "do": [
        { "action": "create_quote_from_opp",
          "record": { "opportunity": { "opportunity_name": "Acme Corp — CRM Platform Deployment" } },
          "$as": { "q": "quote" } }
      ],
      "expect": [
        { "record": "$q", "equals": { "status": "Draft" } },
        { "count": "quote_line", "where": { "c": "quote_id", "o": "eq", "v": "$q.quote_id" }, "equals": 2 }
      ]
    }
  ]
}
```

`describe` and `tests` are required, `name` on every test. Every test runs in its own
temporary workspace holding the module, its dependencies and **their demo data**, then the
workspace is dropped, so tests cannot affect each other. There is no `fixture` or
`isolation`: the schema refuses both and the runner fails every test of the suite.

### Records

- **Name a record by its values:** `{ "<entity>": { "<column>": <value>, … } }`, which must
  match exactly one record (none, or two, fails the test). Use a natural key from the
  demo data, or a value the test itself inserted. Prefer the demo data to rebuilding it.
- **Name a record you create:** `"$as": "name"` on an `insert` step or a `given` record;
  read it as `"$name"` and a column as `"$name.column"` (also inside a `where` filter and
  in `values`).
- **Name a record a step added:** on `update` / `delete` / `action`,
  `"$as": { "q": "quote" }` names the one quote the step added through an action's
  `insert()` or an `async: false` trigger. Anything but exactly one new record fails the
  test. An `insert` takes a string `$as`, never an object.

### `given`

`{ "entityCode", "records": [ … ] }` creates records first, as the admin, **by column
values**: a reference column takes the key (`"journal_id": 620001`, `"$je.journal_entry_id"`),
not a display name. Find the key in the dependency's demo data or seed data. Give
every mandatory column; `given` goes through the platform's checks.

`{ "sql": "…" }` (a string or an array of lines, and nothing else in that block) sets up
what records cannot, and commits. Bare table names are the module's. It skips what the
platform does on a write (the module's triggers, number sequences, validation), so use it
last.

### `do`

Steps run in order, as the signed-in admin. `insert`, `update`, `delete`, `action`
(`record`, or `records` for a batch, plus `params`). A step that fails stops the rest and
rolls its transaction back, so expectations after it see the data as before the step —
that is how "refused and nothing changed" is tested. If no `error` or `refused` expects
the failure, the test fails.

### `expect`

| Check | Use it for |
|---|---|
| `record` + `equals` (+ `precision`) | A record's columns, formula columns included |
| `count` + `where` + `equals` | How many records the user sees match a filter (`{c,o,v}` / `{g,i}`) |
| `error` (`code` and/or `contains`) | The step failed with this platform error. `{"error": {}}` is rejected |
| `refused: "canExecute"` | The action is not offered on this record. Not the same as failed |
| `query` | Rows a `query.run` query returns: `columns` with `agg` group / sum / count / avg / min / max, `filter`, `sort`, reference paths (`quote.notes`); at most 1000 rows |
| `register` | An accounting register's balances per account: `name` (`gl.ledger`, in full), `resource`, `interval` with `@params` filled from `params`, `columns` |
| `report` | The rows of a report dataset: the code (`sales_funnel`, or another module's `crm.sales_funnel`), `dataset` (required with more than one), `params` |
| `sql` | Read-only; for what the API cannot show (platform metadata, a column no view shows) |

Row checks (`query`, `register`, `report`, `sql`) need at least one of `equals` (an array
is exactly these rows in order; an object is one row), `contains` (each row is among the
rows, any order) or `rowCount`. A row compares only the columns it names. A result that is
not the whole answer **fails** the check: rows cut at the cap, or a query or report that ran
with warnings.

Check through records, `query` and `register` first. Use `sql` only for what they cannot
show.

## Isolate from demo data

Demo data is background, and it changes. A test that asserts a total over "all quotes" breaks
when someone adds a demo quote.

- Assert on records the test created or on one demo record named by a natural key.
- When a ledger or a report spans a period, use a period of the test's own (in the past,
  as `post_entry` uses March 2020) so demo periods never meet it.
- Use `precision` for every money or ratio comparison.

## What the runner cannot do yet

A step or an expectation it does not support **fails** the test, it is never skipped.
Do not write these; cover them by hand and say so in the module's notes:

- other users: only the signed-in admin runs steps, so rights, row filters, column
  security and `canExecute` for a given role cannot be tested
- `print`, `report` as a step, `drain` (so async triggers, background actions and jobs
  cannot be waited for), `settings` on a test, `given` by display name
- `can`, `message`, `notification`, `email`, `triggerRun`, `setting`, `snapshot`,
  `unchanged`; `tests/test.json` (fixtures, automatic checks), `upgrade.test.json` and
  `logic/tests/*.test.dsl` are not read
- an action with no `record` / `records` (a general action: a period's payroll, a batch)
- a dependency that is not on disk: they are read from the folder next to the module

## Write, validate, run, fix

1. Write the scenario in `tests/<name>.test.json`; the schema is `dforge://schema/test-scenario`.
2. `dforge_module_validate` first. Without a server it checks that every entity, column,
   action, report and register a test names exists, that a step is one the runner knows,
   and that `$as` names are right. A dependency's entities and registers are left to the run.
3. Run: `dforge-cli module test <moduleDir> --url <server>` (sign in once with
   `dforge-cli auth login --url <server>`; instance admin on a server that sets
   `ModuleTests__Enabled=true` — the local docker stack does, production never).
   `--filter <text>` runs tests whose suite and name contain the text; `--keep` keeps each
   workspace for a day; `--no-demo-data` seeds only. Needs CLI 0.2.43 or later.
4. Exit 0 all passed, 1 a test failed, 2 the run could not start. Exit 2 is the
   environment (the server does not allow temporary workspaces, you are not an instance
   admin, a dependency is missing), not a module defect.
5. A failure names the test, the expectation and the first rows it got. Read what came
   back before deciding: a wrong expected number is the scenario's fault; a missing record
   or a refused step is usually the module's.

Do not use `--shared` to get a test green: it runs in your own workspace, commits there,
and the next run finds duplicates ("matched 2 records"). It is for debugging one test.

## Common slips

- A record reference that matches two records after a demo-data change: add a second column.
- `{ "error": {} }` with neither `code` nor `contains`.
- A `register` name without its module (`ledger` instead of `gl.ledger`).
- A reference column in `given` written as a display name instead of the key.
- Expecting a trigger's effect when the trigger is `async: true`: the step does not wait.
  Declare the trigger `async: false` only if the product wants a synchronous effect or
  veto; otherwise leave the effect uncovered.
- Exact value asserted on a number with decimals and no `precision`.
- Writing the action's own formula back into the expectation: compute the expected number
  from the demo data by hand, so the test can disagree with the module.

Reference scenarios: `modules/crm/tests/` (action, `$as`, `canExecute` refusal, `query`,
reports), `modules/gl/tests/post_entry.test.json` (a posting and a `register` check, a
refused posting), `modules/fin/tests/send_invoice.test.json` (`sql` on platform metadata).
