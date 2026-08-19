# Changelog

All notable changes to `@dforge-core/dforge-mcp`. This project uses semver-ish
`0.1.0-rc.N` pre-release tags; the published version is set at publish time via
the release workflow, so committed `package.json` versions are placeholders.

## 0.2.16

Entity views — the platform's **column-level security** — became reachable from a
module package (platform change `e6e29b604`). A view is a named subset of an
entity's columns declared under `views` on the entity file; a folder binds one per
entity with `entities.<code>.viewName`, and users working there see only the
columns that view lists. The schema had gained the property while nothing here
knew about it, so authoring one meant an editor error on valid metadata and a
refactor that could quietly break the module.

### Added — entity views are validated offline

`dforge_module_validate` now mirrors what the platform installer rejects, all of
which is silent at runtime if it slips through:

| Check | Why it matters |
|---|---|
| Column exists on the entity | A stale name is simply not in the view |
| View lists the primary key | Records are addressed by it — the client cannot open a row without it |
| View has at least one column | A view is the COMPLETE visible set, so an empty one would hide every field |
| No two views differing only by case | A folder binds case-insensitively; only one could ever be reached |
| No column listed twice under different casing | Both name one column and the later would silently win |
| `formula` override only on a `columnType: "F"` column | Elsewhere that field is the SQL default, so the override is inert |
| `folders.json` `viewName` resolves to a declared view | **Fails the install** — it does not fall back, because falling back shows every column |

`"default"` is exempt from the last check and means "no view": every shipped module
writes it, and the platform auto-creates a column-less row under that name for any
entity reached without a folder binding.

### Fixed — refactors reach into views

`dforge_entity_field_rename` and `dforge_entity_field_remove` rewrote fields, links,
formulas, data views and seed data but never touched `views.<v>.columns.<cd>`. Since
the platform now rejects a view naming a column the entity does not have, a rename
handed back a module that no longer installs. Both cascade into entity views now,
including per-view `formula` overrides, preserving the view's column order (which is
its display order). Removal warns when a view is left with no columns, or when a
per-view formula still names a removed field — the same judgement-call warnings the
tool already emitted for entity formulas.

### Fixed — `viewName` was documented as a data view code

It is not, and the mistake ran from `schemas/folders.schema.json` through
`references/security.md` to `dforge-module-build`'s Phase 3, which claimed
`"default"` was "a fallback alias the platform resolves to the entity's first
declared view". It resolves to *no view* (the full column set), and any other
undeclared name now fails the install — so the wrong mental model produced a hard
error rather than a shrug. Data view codes are what a menu's `dataViewCode`
references.

### Changed

- `@dforge-core/metadata` → `0.0.16`; `resources/schemas/` re-vendored, so
  `entity.schema.json` carries `views` (with the per-column `formula` override) and
  the editor stops flagging a valid `views` block as an unknown property.
- `references/security.md` gains a **Column-level security** section — the layer the
  3-layer model named but never documented — with the rules, the empty-override trap
  (`COALESCE` skips NULL only, so `"flags": ""` means "no flags", not "inherit"), and
  a table disambiguating the platform's three "views": entity views, data views, and
  `isView`/`viewSql` SQL-backed entities.
- Cross-references in `references/flags.md` (the same letters override per view),
  `references/formulas.md` (the per-view override and its `"F"`-only rule) and
  `references/data-views.md` (the name collision); two new lines in
  `references/validation-checklist.md`; `dforge-module-build` Phase 5 gains guidance
  on when column-level security is the right answer instead of more roles.
- `dforge_module_inspect` reports `entityViews` per entity (name → column count).

### Added — a worked example module

`examples/column-security/` (served as `dforge://example/column-security/…`): one
`product` entity carrying both stock and pricing, two folders showing two different
column sets of it. It is the first bundled example with a `ui/folders.json` at all,
so the *binding* half of column-level security had no example anywhere before.

Its `accountant` view demonstrates both override kinds — `{ "flags": "V" }` making a
column read-only in that view only, and a per-view `formula` computing margin as a
percentage where the entity computes an amount — while `storekeeper` shows the plain
case where the price columns are simply absent. The README lists the five ways a view
fails the install, and a test pins the module at zero errors AND zero warnings, since
a warning copied out of an example propagates into every module built from it.

Note its manifest declares no `dataViews`/`menus`/`security` pointers: those files are
found by convention and the manifest schema is `additionalProperties: false`.

### Fixed — `simple-todo`'s manifest was not schema-valid

It declared `dataViews`, `menus`, `actions`, `security` and `seedData` pointers. None
of those are manifest properties, the schema is `additionalProperties: false`, and no
shipped module declares them — every path is resolved by convention from the module
root (`ui/data_views.json`, `security/roles.json`, …), here and in the platform alike.
Removed. This matters more than a stray key usually would: the examples are served as
resources and described to agents as mandatory structures to copy, so an invalid shape
in one propagates into every module built from it.

### Note — the view-column flag vocabulary

`entity.schema.json` described a view column's `flags` as `I/E/V/O/G/S/F/X/W`, with the
example `'VO'` "to expose it read-only". No such letters: the canonical set is
`V/I/E/M/H` (`flagDefs`), the client honours `V`/`E`/`I`, and the installer resolves
`M` into `isNullable`. Read-only is plain `"V"`.

`references/flags.md` here was already correct, and the guidance and the
`column-security` example both use only `V`/`VE`. The schema text is fixed upstream in
`@dforge-core/metadata` **0.0.17**; the vendored copy under `resources/schemas/` still
carries the old description until that release lands and the dep is bumped past
`^0.0.16` (a caret on `0.0.x` pins the patch, so it does not float).

## 0.2.15

`canExecute` became a real server-side gate and `isTransacted` began opening a real
transaction (platform change `5398a48b0`). Both had been documented here as the
opposite — "a UI hint" and "does not open a transaction" — so this release is a
correction pass across the authoring guidance, with no tool or schema changes.

### Changed — `canExecute` is enforced, with a fail-open subset

`action.execute` now evaluates the stored `can_execute_parsed` AST over every targeted
record before any write and refuses the call with `ACTION_EXECUTION_FAIL`. So
`canExecute: false` is a genuine "only automation may fire this" — the scheduler and
triggers invoke the script engine directly and still bypass it.

The server evaluator is a scalar walker, not the formula engine, and the client has its
own separate gaps, so `references/action-dsl.md` and `dsl-reference.md` now carry a tier
table instead of a single list:

| tier | construct | client | server |
|---|---|---|---|
| 1 | **comparisons** (`=` `!=` `<` `<=` `>` `>=`) between fields and literals, combined with `AND` / `OR` / `NOT`; a bare `true` / `false` | evaluates | **enforces** |
| 2 | arithmetic, `IN`, `BETWEEN`, any formula function | evaluates | fail-open |
| 3 | ref navigation, `SUM` / `COUNT` / `AVG`, any unknown function (a typo included) | **fail-open (throws)** | fail-open |
| — | `$[setting]` references | **evaluates as null** (no throw) | fail-open |

Four things in there are easy to get wrong and are called out explicitly:

- **A bare boolean field is not enforced.** The walker evaluates conditions, not values —
  a field resolves only as an operand of a comparison — so `canExecute: [is_active]` and
  `NOT [is_blocked]` fail open. Write `[is_active] = true` and `NOT ([is_blocked] = true)`.
- **A misspelled function ships silently.** A `canExecute` is never validated against the
  function set at install (`FindUnknownFunctions` is wired only into the formula-column
  path), so `TOADY()` installs and enables the button for every record.
- **Tier 3 mixed into a predicate is worse than useless**, because the two sides disagree
  about short-circuiting: the server's `AND` / `OR` short-circuit, the client's evaluator
  does not. `[status] = 'Pending' AND COUNT([lines]) > 0` on a non-`Pending` record throws
  in the browser, is caught, and **enables** the button — then the server refuses the call.
  An error where a greyed-out button was wanted. Count with a Generated (`G`) column and
  compare the scalar. Mixing tier 1 with tier 2 is fine and is the normal shape.
- **Settings do not work in `canExecute` at all** — the client resolver is stubbed to
  `null` and the server has none, so the guard is unenforced server-side and tends to jam
  the button *shut* client-side. Read them in `execute:`.

`references/jobs.md` also stops promising that `canExecute: false` hides the button: the
action stays in the toolbar, permanently disabled.

### Changed — `isTransacted` opens a transaction, and defaults to `true`

The *Don't assume your action is atomic* section is replaced by *Atomicity*. `true` now
makes the whole run one transaction in both execution modes, covering the script's own
`insert()` / `update()` / `query()` calls as well as the flush of `[field] = …`
assignments, and it no longer depends on the entity carrying `auditHistory` — advice to
reach for that trait as an atomicity switch is gone.

`false` is documented per mode, because "failures are isolated" only ever made sense where
there is a loop: `single` / `each` report the failure and continue with the next record,
while a `batch` script is one invocation, so a failure just ends the run with its earlier
writes committed and its `[field]` assignments never flushed.

The background path is the exception, and it splits by mode too: the worker opens no
transaction, so nothing is ever undone; its `single` / `each` loop still reads the flag for
control flow, while its `batch` path never reads it at all — a queued `batch` action gets
nothing from `isTransacted` in either direction.

### Fixed — `isAsync` does not force background execution, and there is no Hangfire

`isAsync: true` only *permits* queuing. The server branches on the `async` argument the
request carries, so a parameterless action is queued directly while one with parameters is
offered to the user as both "Run" (inline, transactional) and "Run in Background". Whether
an action is atomic is therefore not answerable from the manifest alone.

Two claims that dForge runs background actions "via Hangfire" are removed — the platform
uses a hosted `BackgroundService` polling `background_action`, and `FileCleanupService`
says so in as many words.

### Changed — validation checklist

Two new items under actions: that a `canExecute` meant to *gate* is written in the
server-enforced subset, and that no bare boolean field is used as a whole condition. The
`references/formulas.md` entry for `canExecute:` blocks now summarises the same rules and
points at `action-dsl.md`.

## 0.2.14

Record reports — a report attached to an entity so it opens **from a record**, with the
record's values feeding its parameters — plus a report-level home for report parameters,
and the removal of two parameter spellings the installer never read.

Requires `@dforge-core/metadata` ≥ 0.0.15 (bumped): the vendored
`resources/schemas/reports.schema.json` served as `dforge://schema/reports` comes from
there.

### Added — record-report attachments

A report in `ui/reports.json` gains an `entities` array. Each entry attaches the report to
one entity, mapping report parameters to source columns on it:

```jsonc
"credit_check": {
    "entities": [
        { "entityCd": "parties.party", "params": { "customer_id": "party_id" }, "orderNum": 45 },
        { "entityCd": "crm.quote",     "params": { "customer_id": "customer_id" }, "orderNum": 45 }
    ]
}
```

The report then appears on that record's toolbar and opens on a record-scoped route with
the mapped params resolved server-side and hidden. `dforge_report_add` accepts and
documents the block; `references/reports.md` gains a **Record reports** section with the
rules (source-column allowlist, type compatibility, one attachment per (entity, report)
pair, the `"metadata": ">=1.5.0"` gate, and the cross-module dependency bound).

Note the two different `params` keys, which the tool description now calls out: on an
attachment it is the *mapping* (param code → column); on the report or a dataset it is the
*declaration*.

### Added — `dforge_module_validate` checks reports

Mirrors the server's new pack-time `ReportAttachmentValidator`, so these fail offline
instead of at install against a live tenant:

- a mapped param code neither the report-level `parameters` block nor any dataset declares;
- a source column the entity doesn't have, or one that's a set / formula / free-text column;
- two attachments to the same entity in one report (the second overwrites the first);
- an attachment to a cross-module entity whose module isn't a declared dependency;
- `isRequired`, a top-level `link`, or `fieldTypeCd` + `domain` together on a param;
- a warning when a module ships attachments with no `metadata` dependency.

### Added — report-level `parameters`

Report parameters are **report-scoped**: the declaration is stored once per report
(`report.param_set_id` → `param_set`), the authoring API is `report.params.save`, and
`report.get` flattens per-dataset defaults report-wide before use. The installer had only
ever read the per-dataset shorthand, so a report-level block was silently dropped and the
report installed with no parameters at all — which is what made
`crm-fin.customer_statement` and `wms-fin.vendor_statement` ship parameterless.

Both declaration sites are now legal and mean the same thing; the installer merges them,
**report level winning** on a code collision:

```jsonc
"customer_statement": {
    "parameters": {
        "customer_id": { "label": "Customer", "fieldTypeCd": "lookup",
                         "params": { "link": { "entity": "parties.party" } }, "required": true }
    },
    "datasets": { "statement_invoices": { }, "statement_payments": { } }
}
```

Declare at report level when several datasets use the parameter — `customer_statement` is
exactly that case, and there is no meaningful dataset to attribute it to.
`datasets.<cd>.params` stays the right shorthand for a single-dataset parameter, and every
module written before this keeps working.

`dforge_module_validate` merges both sites when resolving a record-report mapping, so a
mapping onto a report-level parameter resolves exactly as install will resolve it.

### Fixed — two report-param spellings that are silently ignored

Unlike `parameters`, these are simply misspellings of keys that already exist, so they are
gone from the schema rather than implemented — and the validator flags them at either
declaration site:

- **`isRequired`** — the key is `required`; the parameter installed as optional.
- **top-level `link`** on a lookup parameter — it belongs under `params`; the parameter
  installed with no autocomplete.

`references/reports.md` also corrects the rights-key example from `report.<code>` to the
colon form `report:<code>`, and the lookup parameter config from `params.entityCd` to
`params.link.entity`.

### Changed — steer calculation toward reports, not the DSL

`action-dsl.md`'s *When an action is the wrong tool* now names the record report as the
direct replacement for a `check_…` action — same toolbar entry point, but the user sees
the open invoices and the ageing rather than just "FAILED" — and adds the general rule:
**do not compute in the DSL what a report dataset already aggregates.** Sums, ratios,
ageing buckets and exposure get formatting, drill-through, row caps and live re-reads for
free from a report; DSL arithmetic over `select()` reproduces that badly, once, somewhere
nothing else can reuse. Write DSL when the number must be *written down* or must *stop*
something. The same steer is in `dsl-reference.md`, Phase 2a and Phase 3c of the
`dforge-module-build` skill, and the validation checklist.

## 0.2.5

Catches up with the platform's parameter-options work (dForge-core 1.20.0). A dropdown
parameter can now carry real labels, and — better — borrow the shared list its target
column already uses. Both were undocumented here, and one reference actively said the
first was impossible.

### Changed — `translations.md` said param option labels didn't exist

The section table listed `actions` / `reports` params as translating `{ label }` and
nothing else, which was accurate when written: parameters had no schema location for a
per-choice label at all. An author who followed it concluded — correctly, at the time —
that a dropdown param showing `bank_transfer` instead of "Bank transfer" was unfixable.
The platform added the slot, so the table now shows
`params: { param_cd: { label, options: { value: … } } }` for both sections, and a new
**"Action / report PARAM option labels ARE translatable"** section documents the
value-keyed, partial-override shape (identical to field options) plus the two things that
trip authors up: base labels must exist in the DSL first, and a domain-backed param
shouldn't be translated here at all.

### Added — `domain <domainCd>` param form

`action-dsl.md` and `dsl-reference.md` gain the parameter form that borrows a column
domain:

```
params:
    payment_method: domain payment_method required "Payment method for this batch"
    status:         domain fin.doc_status optional "Status"
```

Both now lead with it and frame inline `options=` as the narrow case. The reason is
duplication, not typing: a param whose value gets written to a domain-backed column used
to restate that column's enum, so the same list was authored twice, translated twice, and
free to drift — and a param option whose code isn't on the column is a value the grid
can't label. `column-domains.md` gains a matching **"Using a domain in an action / report
param"** section, and `reports.md` documents the JSON equivalent
(`{"domain": "fin.doc_status"}`, mutually exclusive with `fieldTypeCd`).

Also documented: the param keeps its **own** caption (only the choices come from the
domain), install materializes just the domain's `fieldTypeCd` (a parameter has no
storage, so datatype and sizing don't apply), and nothing may follow the description —
`options=`, `min=` and friends are a compile error there, the same authority rule columns
already had.

### Changed — labeled `options=` in the DSL references

The dropdown row in `dsl-reference.md` showed only `options=low,medium,high`, which is
exactly the shape that renders raw codes in every locale. It now shows the labeled forms
(`options=[low:Low, medium:Medium, high:High]`, and the JSON object form for icon/colour),
with the wrapping rule spelled out: the trailing `key=value` scan is whitespace-delimited,
so a label containing a space needs `[ ]` or quotes around the list.

`resources/docs/conventions.md` (vendored from dForge-core) gains the same guidance
inline. It was **not** re-synced wholesale: the vendored copy has diverged *forward* from
core in ~15 places — seed-data `cuid`-is-int8 warnings, mandatory-flag `M` semantics,
rights characters — so a straight `cp` (what `VENDOR_REFS=1` does) would silently drop
them. That drift is worth reconciling deliberately, in its own pass.

### Fixed — `dforge_module_validate` rejected a domain-backed report param

`resources/schemas/reports.schema.json` required `fieldTypeCd` and had no `domain` key, so
the very form the docs above now recommend failed validation. `@dforge-core/metadata` is
bumped to `^0.0.14` and the 16 vendored schemas re-synced, which lands the new `paramDef`:
`domain` is accepted (`domain_cd` or `module_cd.domain_cd`), `fieldTypeCd` is no longer
required — a param declaring neither installs as `text` — and the one rejected combination
is declaring both. Action params were never affected (the DSL has no JSON schema).

### Changed — dependency bumps

`@dforge-core/dforge-cli` `^0.2.12` → `^0.2.13`, `@dforge-core/metadata` `^0.0.13` →
`^0.0.14`, and the dev toolchain moves to `vitest` 4 and `@types/node` 26. A
`pnpm-workspace.yaml` pins the pnpm build allowlist and exempts the freshly-published
dForge packages from `minimumReleaseAge`, which otherwise blocks installing them the day
they ship.

### Known gap

`dforge_translation_sync` doesn't seed `options` maps for fields, domains or params —
authors write those keys by hand.

## 0.2.3

Catches up with the platform's current-user work: `currentUserId()` exists now,
and the three ways an author can get this wrong each get their own diagnostic
instead of a generic "unknown function".

### Fixed — `dforge_action_check` flagged real built-ins as unknown

`DSL_BUILTINS` is a hand-maintained mirror of `DslBuiltins.FunctionNames` in
dForge-core, and it had drifted: `addMinutes`, `applyProfile` and
`getFileBase64` were missing, so a module using them was told its correct code
was wrong. Nothing compared the two lists, which is why it went unnoticed.
`test/dsl-builtins-drift.test.ts` now asserts they match in both directions,
parsing the authoritative list out of a sibling dForge-core checkout.

### Added — `userId()` and `CURRENT_USER_ID()` diagnostics

- **`userId()`** is now an `error` (`user-id-called-as-function`) carrying the
  platform's own sentence: *'userId' is a value, not a function — write 'userId'
  without parentheses, or 'currentUserId()'*. It used to draw only a generic
  `unknown-builtin` warning that called `userId` "not a DSL host function",
  which is misleading — it is a host value, just not callable. The platform
  rejects this at compile time now, so the checker matches its severity.
- **`CURRENT_USER_ID()`** in `execute:` joins `TODAY()`/`NOW()` as formula-only.
  The message is per-function rather than date-specific, so it points at
  `currentUserId()` here and `now()` there.
- **`currentUserId()`** and bare **`userId`** both check clean.

### Changed — reference docs

`dsl-reference.md` and the skill's `action-dsl.md` gain the full built-in list,
the formula-vs-`execute:` split for `CURRENT_USER_ID()`, and the 64-bit id
contract: ids are BigInt inside `execute:` and stay exact, arithmetic mixing
BigInt and Number throws, and a large id written as a bare numeric literal
rounds before the comparison runs. The skill reference also drops
`IF(condition, trueVal, falseVal)`, which it listed as an `execute:` ternary
helper — it is formula-only and the compiler rejects it.

## 0.2.2

Mirrors the platform change that gives the `M` column flag its meaning — in the
docs, in the schemas, and in the tools that emit flags — and catches up the
formula and `entityLink()` references with the platform work since 0.2.1.

### Fixed — the relation tools emitted `NOT NULL` for every optional relation

The `M` change turned an inert flag into a physical constraint, which made three
places that hard-coded it actively wrong. All three now take `M` from whether the
relation is actually required, and put it on **both** halves in step:

- **`dforge_entity_reference_add`** emitted the hidden FK as `flags: "EM"`
  unconditionally, whatever `required` said. Post-change that made every optional
  relation's FK column `NOT NULL` while its own Reference half said `"VE"` — a pair
  that contradicts itself. It now emits FK `"EM"` + Reference `"VEM"` when
  `required`, and FK `"E"` + Reference `"VE"` when not. Reusing a half-built FK
  normalizes to the same shape, and drops a lingering `"isNullable": true` when the
  relation is required rather than emitting a pair the platform rejects at pack.
- **`dforge_dbml_import` / `dforge_module_import`** did the same for every imported
  FK. They now read the source column's nullability — a DBML `[not null]` on the FK
  is carried onto the reference (the FK column itself is dropped from `columns`, so
  it was being lost) and `required` is accepted explicitly on a table-spec reference.
- **`isHiddenFk()`** required `M` to recognize the hidden half of a pair, so an
  optional FK (`"E"`) became invisible to every rule keyed off it. `M` is not part
  of the shape — it marks the relation required.
- **Set columns** are emitted `"VE"`, not `"VEM"`: `M` is inert on a virtual column,
  but it reads as "this grid must be non-empty", which nothing enforces.

### Added — the validator catches the `M` / `isNullable` contradiction

`dforge_module_validate` (and the authoring-time field schema) now error on a field
declaring `M` together with `"isNullable": true`, naming the field. The platform
rejects this at pack time; catching it here says which column while you can still
see it. On a virtual column the message says so instead of offering both fixes.

### Changed — the `M` column flag now means "required" (platform mirror)

- **`M` resolves to `isNullable: false` at install.** The flag was documented as
  "mandatory" but was inert — nothing on the server or the client read it, so a
  column declared `"flags": "VEM"` rendered without a red asterisk and saved
  empty. It is now folded into `isNullable`, the platform's single notion of
  required, and everything downstream keys off that: `NOT NULL` in generated
  DDL, the `data.insert` required-column check, the client asterisk.
- **Declaring `M` together with `"isNullable": true` is now a hard error** at
  pack time, naming the entity and every offending field — it is a contradiction
  only the author can resolve. **This repo shipped exactly that combination** in
  the extension example in `resources/docs/conventions.md` (`customer_id`, `"flags":
  "EM"` with `"isNullable": true`), so a module authored from that pattern could
  not pack. Corrected to `"flags": "E"`, matching the real `crm-fin` module.
- **The FK+Reference rule no longer prescribes `M` by default.** A hidden FK is
  `flags: "E"`, or `"EM"` when the relationship is genuinely required; omitting
  both leaves the column nullable, which is the default — so the examples no
  longer spell out `"isNullable": true` either. Keep the visible Reference in
  step (`VE` / `VEM`): `M` is inert on a virtual column, so `VEM` over an
  optional FK changes nothing but reads as a required field to the next author,
  which is precisely how the broken example above went unnoticed.
- **An upgrade now reconciles nullability in both directions.** Previously
  neither direction reached an existing table: `ADD COLUMN IF NOT EXISTS` no-ops
  on a column that is already there, and the only nullability statement emitted
  was `DROP NOT NULL`, and that only for an *explicit* `isNullable: true`. So
  adding `M` to a shipped field silently did nothing on upgraded tenants (it
  worked on a fresh install, which goes through `CREATE TABLE`), and merely
  deleting `M` left the constraint standing, failing later inserts with a raw
  Postgres 23502.
- **Authoring consequence:** adding `M` to a field that existing tenant rows
  leave empty now **aborts the upgrade**, rolled back, naming the column and its
  NULL row count — rather than committing a tenant whose API enforces a rule its
  data already breaks. Give the column a `params.serverDefault` if the install
  should backfill it. Removing `M` is always safe.
- **`params.serverDefault` now works on a required column.** The platform's
  required-for-insert check excluded `formula` and `numberSequence` but not
  `serverDefault`, so an insert omitting such a column was rejected as missing
  even though the INSERT would have supplied the value. An `on: "update"`
  default stays required — it does not fire on insert.
- **Also corrected in `conventions.md`:** the hidden-FK examples carried
  `"fieldTypeCd": "hidden"`, which makes install warn that a `cuid` column
  (group *number*) is bound to a *text* field type and can misbind filter/DML
  values at runtime (`operator does not exist: bigint = text`). A hidden FK is
  `dbDatatype: "cuid"` + `flags` — no `fieldTypeCd`.

### Changed — formula navigation at SQL time is no longer single-hop

`formulas.md` and `column-types.md` still described the report/query translator as
single-hop-only, and told authors to keep report-bound formulas to one hop. That
stopped being true upstream:

- **Multi-hop `[a].[b].[c]` translates**, one `LEFT JOIN` per hop, each with the
  same soft-deny rights check as a reference display column. A nav path may land on
  a *formula* column of the referenced entity, whose own hops are joined off that
  alias — which is what makes a two-level formula reachable through a reference.
- **Hops are counted from the query's root** and capped at `MaxNavigationDepth`, so
  the hops spent reaching a formula reduce the budget left for its own navigation.
- **What is still unsupported changed shape:** `$[Setting]` references, paths past
  the cap, **extension-table columns** (they live in a separate 1:1 table needing
  its own JOIN), and misauthored paths. All come back NULL with a response warning.
- **Warning wording follows the clause** — a SELECT slot goes empty, an ORDER BY
  term is dropped so rows come back in a different order, a WHERE condition is
  dropped so *more* rows come back than were asked for. Documented, because the
  third one is the only failure that silently widens a result set.
- **Comparison is null-safe and two-valued** in every context: `null = null` is
  true, `[x] != null` is true for any non-null `x`, and SQL-time `=`/`!=` translate
  to `IS NOT DISTINCT FROM` / `IS DISTINCT FROM` so a card and a report agree.
- Corrected in both files: nav resolution walks N:1 references only, **never a 1:N
  set**, however many hops it is given — the reason `SUM([set].[field])` in an `F`
  column renders empty. That was previously attributed to the single-hop limit.

### Changed — `entityLink()` stores the entity id and captions from `toString`

`entity_cd` is only unique per module, so storing the bare code meant a link built
as `entityLink('fin.invoice', …)` re-resolved at click time against the *reader's*
folder module and could land on another module's `invoice`. It now stores the
resolved entity id. The display caption comes from the entity's `toString`
evaluated against the record (an explicit `description` still wins) — previously
the entity's own description, which names the table, not the record. Documented in
`action-dsl.md`, `field-types.md` and the `dforge://reference/dsl` resource, with
the reminder to pass a qualified code.

### Changed — dependencies

- **`@dforge-core/metadata` `^0.0.10` → `^0.0.12`**, and the vendored schemas
  re-generated from it. `entity.schema.json` and `triggers.schema.json` were stale:
  they still described `M` as plain "Mandatory" with no mention of `isNullable`, and
  omitted that DSL `insert()`/`update()`/`delete()`/`query()` writes to *other*
  records raise no trigger events.
- **`@dforge-core/dforge-cli` `^0.2.7` → `^0.2.10`.**

## 0.2.1

Adds the column-domain schema that `dforge_module_inspect` already reported on,
and corrects three areas where the schemas and reference docs described
behavior the platform doesn't have.

### Added — column domains

- **`resources/schemas/domains.schema.json`** — `domains.json` had no schema, so
  the one file that defines reusable semantic types was the only module file
  authored blind. A domain bundles a base datatype, a control, sizing and a
  shared option list under one code. Structural fields (`dbDatatype`,
  `baseDatatypeCd`, `fieldTypeCd`, `maxLen`, `precision`) are materialized onto
  each consuming column at install; `params` — most importantly `options` —
  stays on the domain and resolves at metadata-load time, which is what lets a
  shared list be authored and translated exactly once.
- **`entity.schema.json` gains `domain`** plus a *Domain-backed column* branch in
  the column `oneOf`. Referencing a domain and restating what it owns is
  rejected at install, so the schema now refuses the same combination rather
  than letting it through to a failed install.

### Fixed — trigger semantics were documented wrong

`triggers.schema.json` and `dforge_trigger_add` both described an invocation
contract the runtime doesn't implement, and agents wrote actions against it:

- **There is no injected `record_id` param.** The trigger binds the affected
  record to the action as *record context* — the action reads it with `[field]`
  and its PK with `[pk_column]`, exactly like a UI-invoked action, with
  pre-change values as `old[field]` on update/delete/status_change. `params` is
  static-only: the literal values written in the trigger, nothing else.
- **The action's `entityCode` must equal the trigger's `entity`**, and its
  `executionMode` must not be `batch` — both enforced at pack time. The old
  description said the opposite, warning the action must *not* rely on the
  triggering record.
- **`condition` rejects reference navigation.** The event-time evaluator reads
  only columns of the changed row, so `[ref].[target]` resolves to null and the
  trigger misfires. Navigate inside the action, or denormalise onto the watched
  entity.
- **`async` defaults to `true`**, matching the platform. The tool defaulted it to
  `false`, so every trigger added without an explicit `async` ran synchronously
  inside the user's transaction — where a failing action rolls back their write.

### Fixed — actions are not reliably atomic

- **`isTransacted` does not open a transaction.** It only decides whether the
  first failing record aborts the run or the loop continues. Whether writes made
  before a failure survive depends on the execution path: `auditHistory` on the
  entity, `single` vs `batch`, sync vs background. `action-dsl.md` now tabulates
  all six combinations, and `dsl-reference.md` no longer claims `error()` rolls
  back the whole transaction. This is a platform defect rather than a contract —
  actions are intended to be atomic — so both documents say to validate before
  writing anything, and not to design around either outcome.
- **`query()` runs on a pooled, shared connection**, which nothing checks
  statically and neither document mentioned: `SET LOCAL` not `SET`,
  `pg_advisory_xact_lock()` not `pg_advisory_lock()`, `ON COMMIT DROP` on temp
  tables.
- Documented `old[fieldName]`, and the single-hop limit on `[ref].[target]` —
  `[a].[b].[c]` is a compile error, not a slow path.

## 0.2.0

Tools go from 27 → 34; the single wizard skill splits into a router plus three
stage skills; `dforge_module_validate` grows the checks that previously only
surfaced at install.

### Fixed

- **`dforge_module_inspect` reported nothing useful about actions.** It read
  `entity` / `mode` / `background`, but `dforge_action_add` has always written
  `entityCode` / `executionMode` / `isAsync` (matching the installer and the
  canonical example), so every action inspected as `entity: "?"`. Since the
  skill makes inspect the pre-patch source of truth, agents were planning
  against wrong data. Legacy key names are still read as a fallback.
- **`dforge_module_inspect` listed `["jobs"]` as the job list** — `logic/jobs.json`
  is `{ jobs: [...] }`, not a code-keyed map, so `Object.keys` returned the
  wrapper key. Jobs, triggers and webhooks are now reported properly, alongside
  queries, print templates, domains and `supportedLocales`.
- **Every entity's `toString` was reported as an inherited function.** `toString`
  comes from `Object.prototype`, so reading `entity.toString` never yields
  `undefined`; `JSON.stringify` then dropped it silently. Now read as an own
  property.
- **Freshly scaffolded entities shipped a dangling `toString`.** dforge-cli's
  `buildEntity` emits `"{id}"`, but the `identity` trait names the PK
  `{entity}_id` — so the template referenced a column that never existed.
  Normalized to `{<entity>_id}` on the way out of `module_create` / `entity_add`.
- **Phase labels in the tool descriptions had drifted** from the skill: entity
  and field tools claimed Phase 2 (they're Phase 1); views and reports claimed
  Phase 4 (they're Phase 3). Tool descriptions are always in context and the
  skill table isn't, so the wrong one was winning.
- **Resource descriptions never reached the client.** The deprecated
  `server.resource()` signature dropped them; `registerResource` carries them.

### Added — composite entity tools

Three dForge concepts each span several coordinated keys, and hand-assembling
them from `entity_field_add` is the top source of broken modules. These take the
intent and emit the whole shape, so the broken variants aren't representable:

- **`dforge_entity_reference_add`** — a relation as all three of its parts:
  hidden FK (`cuid` / `EM` / no `fieldTypeCd`), visible Reference (`R` /
  `lookup` / `link`), and the `references` entry. Also *completes* a half-built
  relation by reusing an FK column an import already created.
- **`dforge_entity_rollup_add`** — a child total as a **Generated** (`G`) column,
  creating the parent's Set column when needed, and refusing to aggregate a
  virtual `F`/`R`/`S` child (the `column old.<field> does not exist` failure).
- **`dforge_entity_status_add`** — a dropdown with `params.options` objects and
  the initial value as a `formula`, never the `defaultValue` key the entity
  schema rejects.

### Added — DSL static checking

- **`dforge_action_check`** — check a draft `dslBody` before committing to
  `action_add`, or an `actionCode` already on disk (its execution mode and job
  bindings are read from the module). Catches `TODAY()`/`NOW()` inside
  `execute:`, `[field]` record-context in batch mode or a job-invoked action,
  block order/duplication, top-level `return`, `:param` SQL placeholders, and
  unknown host functions.
- `dforge_action_add` now runs the same checker and rejects errors, replacing
  the single hard-coded `TODAY()` grep.
- `dforge_module_validate` runs it over every action body in the module.

### Added — the element tools that were missing

- **`dforge_menu_add`** — menus had a reference doc and a schema but no tool, so
  agents hand-wrote the JSON and hit the same three documented mistakes. Now
  `dataViewCode` is validated against `data_views.json`, `itemType` lands on
  leaves only, and icons are normalized to the bare form menus require.
- **`dforge_translation_sync`** — generates every install-required key from the
  module's own contents (entities + trait-provided fields, views, menus, roles,
  actions, folders, settings), never overwriting existing translated text.
  "Missing translation key" was a documented install-failure mode with no tool
  behind it, and role labels are completeness-enforced.
- **`dforge_seed_add`** — enforces the four documented seed traps: numeric
  `{entity}_id` PKs, parent-before-child load order, `audit-full` System-user
  columns, and FKs pointing at seeded parents.

### Added — `apply: true`

Every patch tool accepts `apply`. It writes the file map to disk and returns the
paths instead of the contents — cutting the full-file round trip through context
on routine patches, and guaranteeing the `deletes` half of a rename/delete is
applied. Refuses to write outside `moduleDir`; never writes report payloads.

### Added — full-lifecycle phase ledger

`docs/phase.json` now records Phases 1-6, not just Phase 0.
`dforge_module_plan({ action: "check" })` returns `currentPhase`, `nextSkill`
and `gaps` derived from the ledger **plus** evidence read from the module
(entities without fields, without a view, without a Select grant).
`complete_phase` records a phase as done or deliberately skipped. Previously a
resumed session had to guess the phase by cross-referencing inspect output,
which can't distinguish "skipped deliberately" from "not started".

### Fixed — follow-ups from review

- **`dbDatatype: "number"` produced a suggestion with unbalanced quotes.** The
  alias table smuggled quote characters into its value to fake a list, so the
  rendered message depended on the surrounding template. Multi-option
  suggestions are now real arrays formatted by one helper — `use 'int' /
  'bigint' / 'numeric'.`
- **Folder codes were only checked among siblings.** A folder is addressed flat
  and path-less outside the tree — `folder:<code>` in role rights,
  `folders.<code>.label` in translations — so the same code in two branches was
  ambiguous in the rights matrix and let one folder's label silently overwrite
  the other's in a synced translation file. `dforge_folder_add` now refuses a
  code used anywhere in the tree, `dforge_module_validate` errors on duplicates,
  and `dforge_translation_sync` refuses to generate colliding keys.
- **`apply: true` without `moduleDir` silently degraded to a preview** — a
  client relying on apply semantics got a success response and no write. It now
  errors.
- **Raw NUL bytes were being used as composite-key separators** (the validator's
  view+entity keys and `dforge_translation_sync`'s keep/prune path keys). Beyond
  being invisible in a diff and unreadable in debug output, a NUL makes `grep`
  classify the whole source file as BINARY and stop reporting matches in it — so
  the usual "search the codebase" check came back clean while the problem sat
  right there. Both now use a shared, exported `compositeKey()` / `KEY_SEP =
  "::"`, and a `source-hygiene` test fails the build on any raw NUL or other
  invisible control character in `src/` or `test/`.
- **`dforge_entity_reference_add` reused an existing FK column without checking
  its shape.** An import commonly emits the FK as a visible numeric column;
  reusing it as-is produced a pair that looked complete and failed at install.
  The column is now normalized to the hidden-FK shape (`cuid` / `EM`, no
  `fieldTypeCd`, no `columnType`), preserving author metadata like `orderNum`
  and `description`, and the response reports exactly what changed.
- **`dforge_module_plan` was registered through the ToolResult envelope with a
  cast**, which would have absorbed a real shape mismatch — most of its actions
  return lifecycle state with no `files` at all. It now has an explicit
  `PlanResult` type and a `serialize()` envelope that makes no ToolResult
  assumption. (The envelope was also renamed off `readOnly`: read-only-ness is
  declared by the tool `annotations`, and some tools it wraps do return files.)
- **`applyToDisk` would throw an opaque error if `deletes` ever contained a
  directory.** `deletes` is a file-only contract, so it now says so: directories
  are refused by name rather than removed recursively (silently deleting a
  subtree would be the worst response to a tool bug), and symlinks are unlinked
  rather than followed.

### Fixed — second review pass

- **`dforge_seed_add` hard-coded a list of "trait-provided columns" that was
  wrong on almost every entry.** The registry's real names are `created_date` /
  `last_updated` (audit), `order_num` (sorting), `active` (soft-delete) — not
  `created_at` / `updated_at` / `sort_order` / `is_deleted`, and `audit-full`'s
  `created_by_user` / `last_updated_by_user` and the whole `period` set were
  missing. Seeding a legitimate `created_date` was rejected as an unknown
  column. Now derived from `expandTraits` for the entity's actual trait list.
- **Unknown trait codes were silently dropped, not rejected.** `expandTraits`
  returns only the codes it recognizes, so a typo'd trait doesn't fail — its
  columns just vanish, and every downstream check then reports them as "not a
  column". `dforge_module_validate` now flags the cause, and `seed_add` /
  `translation_sync` refuse to run against one.
- **`dforge_translation_sync` silently skipped unreadable entity files**,
  producing an incomplete skeleton while reporting success — the gap would only
  surface later as a missing-label install failure. A missing or malformed
  entity file named in the manifest is now fatal, and names the path.
- **The SQL-literal scan used a regex that stopped at the first escaped quote**,
  so `query('... \' ... :cid')` truncated mid-statement and the placeholder
  check missed what followed. Replaced with an escape-aware string scanner;
  concatenation is now detected after the literal rather than inside it.
- `dforge_module_plan`'s `complete_phase` cast its own check result back to an
  untyped bag, discarding the `PlanResult` typing; `buildPhaseCheck` now returns
  a declared `BuildPhaseCheck` and the fields are destructured.
- Renamed the control-character guard test to match what it scans (whole source,
  not only string literals).

### Changed — validation is now the single choke point

Field rules lived only in the `entity_field_add` zod schema, so anything
entering via `module_import`, `dbml_import`, the scaffolder or a hand edit
bypassed them entirely. They now live in one place and run in both. New checks
in `dforge_module_validate`:

- every field re-checked against the full rule set, module-wide
- Formula (`F`) and Generated (`G`) column shape; Reference (`R`) column shape
- `dbDatatype` values that are really `fieldTypeCd`s
- `toString` present, and its `{braces}` resolving to real columns
- an `F` column carrying a set aggregate; a `G` aggregate over a virtual child
- action `script` files missing from disk, or not bare filenames
- triggers/jobs firing actions that don't exist; job actions using `[field]`
- DSL static checks on every action body
- translation completeness: a file per `supportedLocales` entry, and a
  `roles.<code>.label` in every locale file including the en-US base

### Fixed — the skills installer did not work on Windows

`scripts/install-skills.sh` was bash-only, so it could not run in cmd.exe or
PowerShell at all — and `npm run install-skills` invoked `bash`, which fails
there too. Under WSL it appeared to work but resolved `$HOME` to the *Linux*
home, silently installing to `/home/you/.claude` while a Windows Claude Code
read `C:\Users\you\.claude`. `scripts/` was also absent from package.json
`files`, so the script did not ship at all.

The installer is now **`scripts/install-skills.mjs`** (Node), behaving
identically on Windows/macOS/Linux/Git Bash/WSL:

- exposed as a `dforge-install-skills` bin, so
  `npx -y -p @dforge-core/dforge-mcp dforge-install-skills` needs no clone and
  no bash (npm shims it as `.cmd` on Windows)
- destination resolves `DEST` → `CLAUDE_CONFIG_DIR/skills` →
  `os.homedir()/.claude/skills`, so Windows gets `%USERPROFILE%` regardless of
  the invoking shell
- `--from-npm` uses `npm pack` + `tar` (built into Windows 10 1803+), which
  fetches only this package rather than its ~35 MB native CLI dependency
- handles `EPIPE` so piping into `head`/`less` doesn't dump a stack trace
- `scripts/install-skills.mjs` added to package.json `files`

`scripts/install-skills.sh` is kept as a thin wrapper that execs the Node
script, so the documented `curl … | bash` one-liner still works.

### Changed — skills split by lifecycle stage

`dforge-mcp-author` becomes a thin router; `dforge-module-design` (Phase 0),
`dforge-module-build` (Phases 1-5) and `dforge-module-ship` (Phase 6) own the
instructions. Each stage needs a different half of the knowledge base, and the
488-line monolith was resident for all of it. Handoff is deterministic via
`dforge_module_plan`'s `nextSkill`. The router directory still carries the
shared `references/` + `examples/` the MCP server serves as resources.

`scripts/install-skills.sh` installs all four (`--from-npm` to pull the
published package).

### Changed — internal

- Migrated from the deprecated `server.tool()` / `server.resource()` to
  `registerTool` / `registerResource`, adding titles and annotations
  (`readOnlyHint` on inspect/validate/action_check, `destructiveHint` on the
  delete/rename refactors and install, `openWorldHint` on pack/install).
- Tests: 80 → 161, including an end-to-end suite that drives a module through
  the real tool surface on a temp directory and asserts it validates clean. That
  suite is what caught the inspect key mismatch and the scaffolder's `{id}`.

## 0.1.12

> Release prerequisite: publish `@dforge-core/metadata@0.0.10` first (adds the
> `domains.schema.json` schema + the domain-backed column branch in
> `entity.schema.json`), then `pnpm install` + `sync-schemas` here so the
> vendored schemas match.

### Skill

- **Column domains** — new `references/column-domains.md`: a reusable field type
  (base datatype + control + shared option list) declared in `domains.json` and
  referenced from a column via a single `"domain": "module_cd.domain_cd"` key
  instead of restating the type. Covers the owned-field rules (restating a
  domain-owned field fails install), scalar-only constraint, cross-module
  dependency requirement, and the localize-once payoff. Added to the SKILL
  loading-policy table and cross-linked from `field-types.md`.
- **Document extraction / OCR** — new `references/document-extraction.md`: the
  `ocrExtract()` forms (v1 raw string, v2 inline `schema` + `{ mode: 'extract' }`,
  v2 `{ profile }`), the `logic/extraction_profiles.json` registry (profile
  lifecycle + `detect` rules), and the `detectDocument(rawText)` doc-type
  auto-detect built-in. The DSL reference (`dforge://docs/dsl`) gains an
  "External integration → Document extraction" section documenting both built-ins.
- **Dropdown / domain option localization** (`translations.md`): per-option labels
  are translatable (opt-in) under `entities.<e>.fields.<f>.options` (value-keyed,
  string shorthand or `{label,icon,color}` partial override — `value` never
  translated), and a column domain's label + shared option labels are translated
  once under a top-level `domains` section, inherited by every consuming column.
- **Formulas** (`formulas.md`) — corrected against the real parser and runtime,
  after a reported `F` column that rendered empty on every row with no error
  anywhere. The doc had documented functions the engine never implemented
  (`ISNULL`, `NULLIF`, `MOD`, `LTRIM`, `RTRIM`) — since the parser accepts any
  `NAME(...)` as a call, those installed cleanly and then rendered blank. They
  are implemented now, and an unknown function is rejected at module install.
  Also fixed: `==`, `%` and `"double-quoted strings"` are **parse errors**
  (four examples used them); `CONTAINS`/`STARTS_WITH`/`ENDS_WITH` are infix
  operators, not functions; and the documented `CASE` signature was actually
  `SWITCH`'s — `CASE([priority], 'high', 3, …)` returns `'high'` for every row,
  because the real `CASE` takes condition/result pairs. Adds the previously
  undocumented `LEFT`/`RIGHT`/`FROUND`/`MID`/`INDEX_OF`/`SPLIT` and the
  conversion functions, so the list now matches the engine exactly, plus notes
  on date comparison, 0-based string indexing, and out-of-domain math. Every
  function is now implemented client-side *and* SQL-side, so a column reads the
  same in a grid and in a report.

### Resources

- New `dforge://schema/domains` (JSON Schema for `domains.json`).
- New `dforge://reference/column-domains` and `dforge://reference/document-extraction`.

### Schema

- Re-vendored `entity.schema.json` — adds the "Domain-backed column" branch
  (`required: ["domain"]`, forbidding restatement of domain-owned fields) and the
  `domain` field property.
- Vendored `domains.schema.json` (new) from `@dforge-core/metadata@0.0.10`.

## 0.1.11

> Release prerequisite: publish `@dforge-core/metadata@0.0.9` first (adds the
> `avatar`/`markdown` field types to the runtime registry — until then the field
> tools reject them), then `pnpm install` + `sync-schemas` here.

### Skill

- **Action DSL: `select()` / `update()` / `delete()` documented.**
  `select('module.entity', {columns, filter, orderBy, limit, offset})` is the
  structured multi-row read: canonical `{c,o,v}`/`{g,i}` filter JSON (same
  operators as data views), one-hop nav paths `'ref.target as alias'` that emit
  LEFT JOINs, **fail-loud** semantics (unknown column/operator/nav path throws —
  unlike UI filters, which drop the condition), and no folder row-filter/column
  security (it hits the table directly; filter nav paths instead of `R`
  columns). `update()`/`delete()` take a scalar PK **or** a `{col: val}` object
  key (string ids coerced to the PK storage type; array and null keys rejected).
  `query()` is repositioned as the escape hatch (aggregates, multi-hop joins,
  CTEs, `FOR UPDATE`). New real example: `comm.dispatch_messages` (cron-scan
  `select()` + scalar-key `update()`). Also documents `exit(message?, level?)` —
  the DSL's early-return — and the rule to always qualify entity codes
  (`update('comm.message', …)`) (`action-dsl.md`, `jobs.md`, `SKILL.md`).
- **Formula date family completed + SQL-time parity** (`formulas.md`). Adds the
  missing `WEEKDAY`, `DATE`, and period-boundary functions (`STARTMONTH`,
  `ENDMONTH`, `STARTQUARTER`, `ENDQUARTER`, `STARTYEAR`, `ENDYEAR`,
  `STARTNEXTMONTH` — optional arg defaults to today) and corrects
  `DATEADD`/`DATEDIFF` signatures (string-literal units `'DAY'`/`'HOUR'`/
  `'MINUTE'`/`'SECOND'`/`'MONTH'`/`'YEAR'`; `DATEDIFF(d1, d2, unit)` = `d2 − d1`).
  The whole family now evaluates identically client-side and SQL-time (reports,
  filters, sorts) — the server SQL translator gained the full set, so
  `DATEDIFF([due_date], TODAY(), 'DAY')` no longer comes back NULL in reports.
- **Field types** (`field-types.md`): added `avatar` (initials circle +
  optional photo via `params.imageColumn`), `markdown` (Write/Preview editor,
  distinct from `richtext` WYSIWYG — the alias table previously mapped
  `markdown` → `richtext`, now wrong), and `list` (card-list rendering of a 1:N
  set, sibling of `grid`).

### Resources

- **`dforge://reference/dsl` (`resources/docs/dsl-reference.md`) caught up with the
  engine**: documents `select()`, `update()`, `delete()` (previously absent — the
  reference stopped at `query()`/`insert()`), plus `entityLink()`, the
  qualify-entity-codes rule, and scalar-vs-object key semantics.

### Schema

- **`entity.schema.json` re-vendored** (from `@dforge-core/metadata@0.0.9`):
  `fieldTypeCd` enum gains `avatar`, `markdown`, `list`; `refFilter` description
  now documents `@[field]` dynamic placeholders (resolved against the current
  record at option load; an unset placeholder drops the condition, and lookups
  re-resolve options on every open).

## 0.1.10

### Schema
- **`entity.schema.json`: `references` gains `onDelete` / `onUpdate`.** Both
  accept `cascade` | `setNull` | `restrict` | `noAction` (omitted = `noAction`,
  a plain FK). `setNull` requires a nullable FK column; `onUpdate` is a no-op for
  immutable `cuid` PKs but matters for entities keyed on a natural/mutable PK.
  The keys were already documented in the skill (0.1.6) but rejected by the
  vendored schema — `dforge_module_validate` now accepts them.
- **`triggers.schema.json`: clarified `async` semantics.** The description now
  spells out that `async: false` runs the action *synchronously inside the
  triggering transaction* (an `error()` rolls the whole mutation back and
  surfaces to the caller), while `async: true` commits first and only logs
  failures — so `async: false` actions must stay fast.

### Skill
- `dforge-mcp-author`: **corrected roll-up totals — use a Generated (`G`) column,
  not a Formula (`F`) column.** Previous guidance (0.1.x) told authors to put
  `SUM([set].[field])` in an `F` column; the formula runtime has no
  `SUM`/`COUNT`/`AVG` and its nav resolution only walks single-hop N:1
  references, so an `F` set-aggregate **silently renders empty** with no error.
  The correct shape is a `G` column with `dbDatatype` + `formula` (no `link` /
  `baseDatatypeCd`), which the installer maintains with a DB trigger on the child
  table — stored, so it is filterable and sortable. The pre-existing rule still
  holds: aggregate only a **physical** child column (`D`, or a same-row `G`);
  a virtual `F`/`R`/`S` child fails install with
  `db_error: column old.<field> does not exist`. Also documents the supported
  aggregates (`SUM`/`COUNT`/`AVG`/`MIN`/`MAX`), empty-set results (`SUM`/`COUNT`
  → `0`; `MIN`/`MAX`/`AVG` → `NULL`), the same-set restriction, and that
  `COUNT(*)` is rejected in favour of `COUNT([lines])`
  (`column-types.md`, `formulas.md`, `SKILL.md`, `validation-checklist.md`).

## 0.1.9

### Changed
- Bumped `@dforge-core/metadata` to `^0.0.8` (re-vendored schemas).

### Skill
- `dforge-mcp-author`: documentation updates to the action-DSL and field-type
  references (no tool/behavior changes).
  - **`getRecord` throws; `getRecordOrNull` is the nullable variant.** Corrected
    the docs: `getRecord(entityCd, key)` raises a localized "not found" error
    instead of returning `null`, so the old `if (rec == null)` guard was dead
    code — use `getRecordOrNull(entityCd, key)` when absence is an expected
    outcome (optional lookup, upsert probe). Also documents compound keys
    (`getRecord('gl.tag', { tag_group: 'REGION', tag_code: 'EU' })`), dot /
    `.get()` field access, and that the returned snapshot is **read-only**
    (`dsl-reference.md`, `action-dsl.md`).
  - **`file` / `image` columns are stored as `jsonb`, not `bytea`.** Despite the
    `binary` base datatype, the column holds a JSON metadata reference
    (`{ storagePath, fileName, … }`) while the bytes live in file storage — the
    field tools derive `jsonb`, so never set `dbDatatype: "bytea"`
    (`field-types.md`).

## 0.1.8

### Added
- **`dforge_module_validate` now flags a grid-style data view over an entity
  with no visible column.** Errors when a column-rendering view (grid, list,
  kanban, calendar, gallery, tree-grid, master-detail, or the default) draws an
  own-module entity that has no *visible scalar column* — a field whose `flags`
  include `V` and whose `columnType` isn't a set (`S`). Without one the view
  renders the runtime empty state *"No visible columns configured for this
  entity."* This mirrors the server's install-time `DataViewVisibleColumnValidator`,
  so authors catch it pre-flight instead of at pack/install. Column-agnostic view
  types (`diagram`, `matrix`, `library`) are exempt; cross-module entities are
  skipped; the check runs after trait expansion so a trait-contributed `V` field
  counts.

### Skill
- `dforge-mcp-author`: documented the **visible-column requirement** for
  column-rendering data views. `references/data-views.md` gains a "the entity
  needs a visible column" rule (visibility is entity-driven via the `V` flag, not
  the view's `columns` array) plus common-mistake bullets, and
  `references/validation-checklist.md` gains matching checklist/red-flag entries.

## 0.1.7

### Changed
- Bumped `@dforge-core/dforge-cli` to `^0.2.7`. Picks up the corrected module
  scaffolder (`buildTranslations` now emits the nested runtime format with the
  completeness-required `roles` block and opt-in constraint-message localization,
  replacing the non-functional flat shape) and the native CLI's install-time
  untranslated-constraint warning.

### Added
- **`dforge_module_validate` now flags untranslated check/unique constraint
  messages.** When the manifest declares `supportedLocales`, the validator
  warns (never errors) for every constraint that declares a `message` but has no
  `entities.<e>.constraints.<c>.message` override in a declared non-English
  locale file. This mirrors the server's install-time `UntranslatedConstraint`
  scan, so authors catch the gap pre-flight instead of at install. English
  locales and extension entities (`extends`) are skipped; the locale file is
  matched case-insensitively (`de-de.json` satisfies `de-DE`). Opt-in — modules
  without `supportedLocales` are not scanned.

### Skill
- `dforge-mcp-author`: documented **localizable constraint violation messages**.
  A constraint's `message` in the entity JSON is the base/fallback text; a
  per-locale override under `entities.<e>.constraints.<c>.message` in
  `translations/<locale>.json` localizes it (culture fallback: per-locale →
  base), surfacing identically on the client pre-save validator and the server
  DB-violation path. Localization is opt-in (warned, not completeness-enforced)
  (`translations.md`, `formulas.md`, `validation-checklist.md`,
  `resources/docs/conventions.md`).

## 0.1.6

### Skill
- `dforge-mcp-author`: documentation updates to the authoring references (no
  tool/behavior changes).
  - **`entityLink()` action-DSL built-in.** Documented
    `entityLink('entityCd', record, description?)` for populating an
    `entitylink` (jsonb) column from an action's `execute:` block — reads the
    record's PK columns and stores them as **strings** so snowflake/cuid ids
    (> 2^53) stay exact, with an optional display `description`
    (`action-dsl.md`, `field-types.md`).
  - **Referential actions on FK references.** Documented the optional
    `onDelete` / `onUpdate` keys on a `references` entry (`cascade`, `setNull`,
    `restrict`, `noAction`; omitted = `noAction`), including nullable-column
    requirements for `setNull`, the `cuid`-PK no-op note for `onUpdate`, and
    the self-healing drop/recreate-on-change behavior (`column-types.md`).
  - **Role labels are translated and completeness-enforced.** Corrected the
    docs: `security/roles.json` carries `description` + `rights` only (**no
    `label`** — `additionalProperties: false`); the localized role display name
    lives in the translation files as `roles.<code>.label`, module-qualified,
    and is required in **every** locale including the `en-US` base or install
    fails (`security.md`, `translations.md`, `SKILL.md`,
    `validation-checklist.md`).

## 0.1.5

### Changed
- Bumped `@dforge-core/metadata` to `^0.0.5`. The re-vendored `reports.schema.json`
  now **structurally validates** KPI and chart panel `config` (previously an
  unvalidated object, so `dforge_module_validate` only checked `vizType`):
  aggregation-vs-formula KPI metrics are mutually exclusive and non-empty; formula
  inputs and chart overlay `series` are shape-checked; charts require
  `chartType`/`categoryCol`/`valueCol`.

## 0.1.3

### Changed
- Bumped the `@dforge-core/metadata` dependency to `^0.0.4` so the publish-time
  schema vendoring (`prepublishOnly` → `vendor-schemas`) picks up the refreshed
  `reports.schema.json` (`vizType: "kpi"` + KPI formula / cross-source config).
  The vendored copy under `resources/schemas/` is regenerated on publish — it is
  not hand-edited.

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
