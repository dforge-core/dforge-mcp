# Action DSL Reference

Actions are dForge's business logic. They are scripts with three declarative blocks (`params:`, `canExecute:`, `execute:`) where the `execute:` block uses **JavaScript syntax** executed server-side via the Jint engine, with platform-provided global functions.

Lives in: `logic/actions/<action_name>.dsl`
Registered in: `ui/actions.json`

## When an action is the wrong tool

An action exists to **change something**. Its message is a receipt for work that was done — not the output itself.

Do **not** write an action whose `execute:` block only reads data, computes a value and reports it with `info()`. The result is a line of text that is never stored: it can't be audited, referenced, re-read or reported on, and every reader has to re-run the action to see it again. The value also reaches the user unformatted — a raw `query()` result carries no column metadata, so money renders as `1000.0099999999999` instead of `1,000.01`.

**Do not compute in the DSL what a report can compute.** Sums, ratios, ageing buckets, exposure, "how much is outstanding" — a report dataset already does aggregation, formatting, drill-through and row caps, and it re-reads live data every time it opens. DSL arithmetic over `select()` results reproduces that badly, once, in a place nothing else can reuse. Reach for the DSL when the number has to be **written down** or has to **stop** something; reach for a report when it has to be **looked at**.

If you are about to write a `check_…`, `calculate_…` or `show_…` action, build one of these instead:

| What's actually needed | Build this |
|---|---|
| The user needs to **see** current numbers **for the record they're on** | A **record report** — a report with an `entities` attachment, which puts it on that record's toolbar and feeds its params from the record. This is the direct replacement for a `check_…` action: same entry point, but the user sees the open invoices and the ageing, not just "FAILED". See `references/reports.md`. |
| The user needs to **see** current numbers generally | A **report** or a data view — both are metadata-driven, so values format correctly, and the user can return to them any time without re-running anything. |
| A derived value **belongs to the record** | A **formula column** (`columnType: "F"`) or a roll-up — computed on read, visible on the card and in grids, filterable and sortable. |
| The **verdict itself matters** (approvals, credit checks, compliance) | An action that **writes a result record** — e.g. `credit_check(customer, checked_at, limit, outstanding, projected, verdict, checked_by)`. Now it's auditable and reportable, and `info()` becomes a legitimate receipt with a link to the new row. |
| The check must **block** something | A **trigger** with `async: false`, or a `canExecute:` guard on the action being gated — enforcement, not narration. |

Messages stay correct for exactly two things, and both are short by nature:

- a **receipt** for a mutation that just happened — `info('Created PO ' + po.po_number, { links: [...] })`
- a **refusal** that prevented one — `error('Period is closed')`

## Structure

A DSL file has up to three blocks. All are optional (but `execute:` is needed to actually do something).

```
params:
    <name>: <type> [required] ["Label"]

canExecute:
    <formula expression returning boolean>

execute:
    <JavaScript with platform globals>
```

## The three blocks

### `params:` — declare user inputs

Each param is one line: `name: type [required] ["Label"]`

```
params:
    new_stage: dropdown required "New Stage" options=[open:Open, won:Won, lost:Lost]
    note: textarea "Follow-up Note"
    adjustment_qty: number required "Adjustment Quantity"
    reason: text required "Reason"
```

Types are a subset of column field types: `text`, `textarea`, `number`, `currency`, `percent`, `checkbox`, `date`, `datetime`, `dropdown`, `lookup`, `user`.

A `ref` names the entity by its code, qualified as `module.entity` for another module; a hyphenated module code is fine (`ref cdy-hr.department`), the schema form `cdy_hr.department` is not. Pack and install refuse a `ref` to a module that is neither this one, a declared dependency nor a system module, and install refuses one naming no installed entity.

A param declared with a text field type (`text`, `textarea`, ...) stays a string whatever JSON type the client sent: `007` keeps its zeros, and a barcode compares to a text column without a cast. No `'' + params[x]` workaround is needed. Every other param is unwrapped as before.

Access in execute block: `params[param_name]` (bracket syntax, NOT dot syntax).

#### Dropdown params: label the options, or borrow a domain

A bare `options=open,won,lost` stores codes with no labels, and the dialog shows `open` /
`won` / `lost` in **every** locale, English included. Two ways to do better, in order of
preference:

1. **`domain <domainCd>`** — the param borrows a shared `column_domain`:

   ```
   params:
       payment_method: domain payment_method required "Payment method for this batch"
       status:         domain fin.doc_status optional "Status"   // module-qualified
   ```

   Use this whenever the choices are the same list a column uses — the usual case, since
   the param's value normally ends up written to that column. Control and options come off
   the domain, so the list and its translations live in **one** place instead of being
   restated here and drifting from the column's. The param keeps its own caption. Nothing
   may follow the description (`options=`, `min=` … are a compile error — the domain owns
   them), and an unknown domain code fails the install.

2. **Inline labels** — for a list that belongs to this parameter alone (a run mode, an
   export format) and matches no column:

   ```
   params:
       method:   dropdown required "Method" options=[bank_transfer:Bank transfer, cash:Cash]
       priority: dropdown required "Priority" options=[{"value":"high","label":"High","color":"#c00"},"normal"]
   ```

   `value:Label` splits on the first colon; wrap the list in `[ ]` (or `" "`) when a label
   contains a space, since the trailing `key=value` scan is whitespace-delimited. An option
   object needs a non-empty string `value` — the stored code, and the key translations match
   on. Per-locale labels: `actions.<cd>.params.<param_cd>.options` (`translations.md`).

### `canExecute:` — availability formula

A formula expression (same grammar as formula columns) that evaluates to true/false.

**It is enforced on both sides.** The client evaluates it to decide whether the
button is **enabled** — the action stays in the toolbar either way, greyed out
rather than hidden. `action.execute` evaluates it again server-side over every
targeted record, before any write, and refuses the call with
`ACTION_EXECUTION_FAIL` when a record is in the wrong state. So it is a real gate,
not a UI hint — a caller hitting the API directly cannot approve an
already-rejected record.

Two consequences worth designing around:

- **`canExecute: false` is the idiom for an action only automation may fire.** The
  server refuses it through `action.execute`; triggers and scheduled jobs invoke
  the script engine directly and are unaffected.
- **The server evaluates the whole formula, and refuses what it cannot read.**
  (Needs platform 1.28.12; older platforms let these through, so the gate is not enforced there.)
  Comparisons between fields and literals (with `AND` / `OR` / `NOT`, a bare
  `true` / `false`) are checked in-process; anything richer — arithmetic, `IN`,
  `BETWEEN`, formula functions, a bare boolean field, `[ref].[col]`
  navigation — is computed in SQL over the record, by the same translator as formula
  columns (chained hops are followed up to a depth cap; a null ref gives `NULL`, which
  counts as not true). A condition the server cannot evaluate (`$[setting]` references, set
  aggregates `SUM` / `COUNT` / `AVG`, an unknown function name, a typo included)
  **refuses the action** with `ACTION_EXECUTION_FAIL` ("cannot be evaluated by the
  server") instead of allowing it. A `NULL` result counts as not true.
  Comparisons themselves are null-safe and two-valued (see `formulas.md`), so an empty
  field does not make `NOT ([x] = 'A')` unknown.
- **The client has gaps of its own, and its failures enable the button.** It
  throws (and its `catch` **enables** the button) on **ref navigation**
  (`[ref].target`), on **`SUM` / `COUNT` / `AVG`** (deliberately not formula
  functions — counting is a Generated `G` column's job) and on **any name it does
  not know, a typo included** (install refuses the last two, see below).
- **`$[setting]` references** resolve to `null` in the client (an ordered comparison
  against null is `false`, so it tends to *disable* the button) and are refused by
  the server and at install (platform 1.28.12 and later). Keep settings out of `canExecute` and read them in `execute:` instead.
- **`TODAY()`** names the requester's calendar day on the server too (their time
  zone: the request's, else the user profile's, else the workspace's, else UTC; a profile zone of
  `UTC` counts as unset). The button is evaluated in the browser and is meant to name the same
  day; `execute:` stays the authority.
- **Install refuses** a `canExecute` that uses `$[setting]`, `SUM` / `COUNT` / `AVG`
  or an unknown function name (a typo included), since the server could never run
  the action. Read settings and count children in `execute:` instead.

| construct | client | server |
|---|---|---|
| comparisons between fields and literals, `AND` / `OR` / `NOT`, bare `true` / `false` | evaluates | evaluates |
| arithmetic, `IN`, `BETWEEN`, formula functions, bare boolean field | evaluates | evaluates (SQL) |
| `[ref].[col]` navigation | **throws, button enabled** | evaluates (SQL) |
| `SUM` / `COUNT` / `AVG`, unknown function (a typo included) | **throws, button enabled** | **refused at install**; if one is already installed, `action.execute` refuses it |
| `$[setting]` references | evaluates as null | **refused at install**; if already installed, `action.execute` refuses it |

Both evaluators agreeing is the healthy shape; the one to design around is a
construct the client throws on, which leaves a button that is enabled and then
refused. Count with a `G` column and compare the scalar (`[detail_count] > 0`);
denormalise instead of navigating; put anything genuinely unexpressible in
`execute:` behind `error()`.

> Never make `canExecute` the *only* guard for something that must hold. Between
> the enqueue-only check on background runs and the fact that the client evaluates
> over the grid row (which does not carry extension columns) while the server
> evaluates over a full record load, the authoritative check belongs in
> `execute:` — validate and `error()` before the first write.

```
canExecute:
    [status] = 'Draft'

canExecute:
    [status] != 'Paid' AND [status] != 'Cancelled'

canExecute:
    [stage] != 'Closed Won' AND [stage] != 'Closed Lost'

canExecute:
    [status] = 'Submitted'

canExecute:
    [quantity] >= 0
```

Uses formula syntax: `[field]` for field access, `=` / `!=` / `<` / `>` / `AND` / `OR` operators, `TODAY()`, etc. — but see the fail-open note above: only the scalar comparison subset is enforced server-side.

**Note**: `canExecute` uses single `=` for equality (formula syntax), NOT `==` (JS syntax).

### `execute:` — the logic (JavaScript with platform globals)

This is **JavaScript** executed via the Jint engine. Standard JS syntax works: `var`, `for`, `if/else`, `+` concatenation, object literals, array indexing, etc.

On top of standard JS, the platform injects global functions and a special field-access syntax.

## Field access and assignment

**Read a field** on the current record:

```javascript
var name = [first_name]         // bracket syntax — reads the field value
var total = [quantity] * [unit_price]
```

`[field_name]` is shorthand for `__r.get('field_name')`. Both work; bracket syntax is cleaner.

**Write a field** on the current record:

```javascript
[status] = 'Approved'           // bracket assignment — updates the field
[approved_date] = now()
[quantity] = newQty
```

`[field] = value` is shorthand for `__r.set('field', value)`. Both work.

**Access params**:

```javascript
var qty = params[adjustment_qty]    // bracket syntax; no quotes around param name in this DSL
var note = params[note]             // no quotes around param name in this DSL
```

`params[param_name]` — note: NO quotes around the param name inside brackets.

## Platform global functions

### Data operations

**No entity rights are checked inside a script.** `insert()`, `update()`, `delete()` and `query()` do not look at the signed-in user's `S`/`I`/`U`/`D` on the entity, nor at column security or the folder's row filter. Only `E` on the action is checked, when it is run. A user with `S` only on an entity can still change it through an action they may execute (core #1580). Treat `E` on an action as write access to everything its script touches; to keep a log free of changes, grant `E` on no action that writes to it.

| Function | Returns | Description |
|---|---|---|
| `insert('entity', { field: value, … })` | Inserted row object | Insert a new record. Returns the full row including auto-filled columns (PK, audit, number sequences). Access returned fields with `result.field_name`. |
| `select('entity', opts?)` | Array of row objects | Structured multi-row read — see "select()" below. `opts` = `{columns, filter, orderBy, limit, offset}`, all optional. Prefer over `query()` for row-shaped reads. |
| `update('entity', key, { field: value, … })` | Rows affected (number) | Update the row(s) matched by `key`. Refreshes update-phase server defaults (audit `last_updated` / `last_updated_by`) and coerces values like `insert()`. A value may be `{ inc: n }` instead of a literal — adds `n` to the column's CURRENT value, so concurrent callers accumulate instead of overwriting. Use it for every counter / balance / quantity. |
| `delete('entity', key)` | Rows affected (number) | Delete the row(s) matched by `key`. |
| `query('SQL', { arg: value })` | Array of row objects | Execute parameterized SQL. Use `@argName` placeholders. Schema-qualified table names (`crm.contact`). Access row fields with `row.field_name` or `row['field_name']`. **Escape hatch** — prefer `select()`/`update()`/`delete()` when the structured shape fits. |
| `getRecord('entity', key)` | Row object | Fetch a single record by key. Access fields with `rec.field_name` (or `rec.get('field_name')`). **Throws** a localized "not found" error if absent. |
| `getRecordOrNull('entity', key)` | Row object or `null` | Like `getRecord`, but returns `null` instead of throwing when the row is absent — use for an expected-absence lookup, guarded with `if (rec == null)`. |
| `preloadRef('fk_column')` | Row object | Load the referenced record for a FK column. Access its fields with `ref.get('field')`. |

> **Entity codes: always qualify.** Every data built-in (`select`, `insert`, `update`, `delete`,
> `getRecord`, `nextNumber`) takes `module.entity` — write `update('comm.message', …)`, not
> `update('message', …)`, even inside the owning module. It reads unambiguously and keeps the script
> correct if it's ever moved to a bridge module. The part before the dot is looked up first as a module
> code, hyphen included (`insert('cdy-tax.invoice', …)`), and otherwise taken as a schema
> (`insert('cdy_tax.invoice', …)`); both work, also for a hyphenated module with no `schemaName`
> (platform #1543). Prefer the module code, as a `ref` param writes it.

> **Keys: scalar or object.** In `update()` / `delete()` / `getRecord()` / `getRecordOrNull()`,
> `key` is either a scalar PK value (`update('task', 42, {…})` — single-column PK only) or an
> object (`{ task_id: 42 }`; multiple entries for compound keys). Scalar **string** ids are coerced
> to the PK's storage type, so a snowflake id carried as a string binds as `int8`, not text. A
> `null` key **throws** (a `col = NULL` predicate can never match), and array keys are rejected —
> loop and mutate per id instead.

> **Posting state.** `update()` setting a register posting state (the `A` / `L` column) posts or unposts
> the document through the register engine, in a trigger action and in a background run alike; a refused
> posting rolls the caller's write back. A background run holds no transaction, so such a call opens its
> own: atomic per call, not per run. A scheduled run cannot post with `update()`.

> **Keys of any type.** A field saved with `[field] = value` binds the record key by the key column's own
> type, so a `uuid` or a digits-only `varchar` key works.

> **These writes raise no events.** `insert()`, `update()`, `delete()` and `query()` are the raw
> write layer: by design they skip folder row-filters, closed-period checks and registry state, and
> they raise no trigger or webhook events either. Only the **acted-on record's own**
> `[field] = value` raises them — that one is indistinguishable from a user editing the same field,
> and fires the entity's `update` / `status_change` triggers exactly as the grid does.
>
> So a trigger on `b` will not see `update('b', …)` from an action bound to `a`. If `b` must react,
> put the trigger on `a` — the entity the action is bound to — or make the change through `b`'s own
> action. The symptom when you get this wrong is a trigger that simply never fires, with nothing in
> the log to say why.

### select() — structured multi-row reads

The read counterpart to `insert()`/`update()`/`delete()`. Entity codes are metadata-validated,
values are parameterized and type-coerced per column, and reference navigation replaces
hand-written LEFT JOINs. A bare `select('entity')` reads every physical column of every row,
ordered by PK.

```javascript
var queued = select('comm.message', {
    columns: ['message_id', 'to_addr', 'to_point.value as point_value', 'subject'],
    filter: { g: 'and', i: [
        { c: 'status', o: '=', v: 'queued' },
        { c: 'channel', o: '=', v: 'email' },
        { g: 'or', i: [
            { c: 'to_addr', o: '!null' },
            { c: 'to_point.value', o: '!null' }
        ] }
    ] },
    orderBy: ['message_id'],
    limit: 10
})
// queued = [{ message_id: 123, to_addr: null, point_value: 'a@b.c', subject: '…' }, …]
```

| Option | Shape | Notes |
|---|---|---|
| `columns` | array of strings | Column paths. A one-hop nav path `'ref.target'` LEFT JOINs the referenced entity; `' as alias'` renames the key in the returned rows (avoids bracket-indexed `row['ref.target']` access). Formula columns are translated to SQL. Defaults to all physical columns. |
| `filter` | object | The platform's canonical filter JSON — `{c, o, v}` conditions inside `{g, i}` groups, same operators as data views (`=`, `!=`, `>`, `in`, `start`, `contains`, `null`, `!null`, `between`, …; see `filters.md`). Nav paths work here too. |
| `orderBy` | array of strings | Column paths; `'-'` prefix for descending (`['-message_id']`). Defaults to the PK for deterministic results. |
| `limit` / `offset` | int | Positive / non-negative. |

- **Fail-loud:** unlike UI filters (which drop untranslatable conditions with a warning),
  `select()` **throws** on an unknown column, unknown operator, or unresolvable nav path — a
  silently narrowed filter in an action means processing the wrong rows.
- **Low-level:** like the other data built-ins, `select()` hits the table directly — no folder
  row-filter, column security, or reference display machinery. A plain reference (`R`) column has
  no value here; select its FK column or a nav path (the error message says which). String
  operators on a reference column are rejected for the same reason — filter a nav path like
  `'customer.company_name'` instead.
- `query()` remains the escape hatch for anything this shape can't express: aggregates, multi-hop
  joins, CTEs, `FOR UPDATE`.

### Register reads

The first argument names a **register** (`module_cd.register_cd`, as declared in that module's `registers.json`), not an entity. These only ask questions; a document posts through its `A` / `L` column.

| Function | Returns | Description |
|---|---|---|
| `getBalance('module.register', dims?, asOf?)` | Object, per resource | Balance of an accumulation register. A dimension left out of `dims` is summed over. |
| `getTurnover('module.register', dims, from, to)` | Object, `{in, out, net}` per resource | Movement over an interval. `dims` may be `null`; `from` and `to` are required. |
| `getSlice('module.register', dims, onDate?, mode?)` | Object or `null` | One record of an information register, the latest on or before `onDate`, plus `_period`. No dimension may be omitted. |
| `getAccountBalance('module.register', account, filter?, asOf?, options?)` | Object, `{debit, credit, net}` per resource; an array of rows with `groupBy` | Balance of one account of an accounting register. `options`: `groupBy` (a name or array — a row per combination, zero balances left out), `exclude: { entity: 'module.document', key }` (not that document's postings), `before` (a moment, exclusive, in place of `asOf`). |
| `getAccountTurnover('module.register', account, filter, from, to, options?)` | Object, `{debit, credit, net}` per resource; an array of rows with `groupBy` | Movement of one account over an interval. `options` takes `groupBy` and `exclude`. |
| `getCorrespondence('module.register', debitAccount, creditAccount, filter, from, to)` | Object, per resource | Movement between two accounts. Needs `lineMode: "compound"`; refuses an analytic filter. |

An analytic filter is the key alone (`{ cost_center: 42 }`) or `{ entity, value }` to name one entity of a union kind.

`getAccountBalance` / `getAccountTurnover` take `exclude` as one `{ entity, key }` or an array of them, of any entities. A register that declares `importedKeyField` (see the registers reference) also leaves out postings *loaded* beside a document, matched by that document's key.

### Messaging

| Function | Description |
|---|---|
| `error('message', values?)` | **Abort** the action and show an error to the user. Rolls back all changes. |
| `warn('message', values?, opts?)` | Show a warning but continue execution. |
| `info('message', values?, opts?)` | Show an informational message. A **receipt for work the action did** — not a way to publish a computed value; see *When an action is the wrong tool*. |
| `exit('message'?, 'level'?, values?)` | **Stop the script early without error** — changes made so far are kept. Level `'info'` (default), `'warning'`, `'danger'` or `'success'` styles the message. This is the DSL's early-return: a bare `return` is not valid at the top level of `execute:`. |
| `notify(userId, 'message')` | Send an in-app notification to a specific user. First arg is a user ID (typically `[owner_id]` or similar). |

The message of `error` / `warn` / `info` / `exit` is translatable: it is looked up by its exact English text in the module's `messages` translations (see `dforge://reference/translations`). Put values in `{name}` placeholders filled from `values` — never join them into the string, which leaves no fixed text to translate. `opts` carries record links (`{ links: [...] }`), so `links` is not a placeholder name:

```javascript
error('Insufficient stock. Available: {available}, requested: {requested}',
    { available: availableQty, requested: params[quantity] })
```

### Email

| Function | Description |
|---|---|
| `sendEmail(to, subject, htmlBody)` | Send a raw email. `to` is an email address string. |
| `sendEmail(to, templateCode, dataObj)` | Send a templated email. The **second** argument picks the mode: one with no spaces that contains `.` or `_` is read as a template code, so give a raw subject spaces. |
| `sendEmail(to, subjectOrTemplate, dataOrBody, attachments)` | The optional fourth argument attaches files: a `printPdf()`, `attachText()` or `attachBase64()` result, or an array of them (`[a, b]`; pass a single file as itself, because a one-name `[a]` reads as a field reference). A `printPdf()` file can be attached only by the user who generated it or a workspace admin, and a scheduled job's email carrying one fails and rolls back; a file built with `attachText()` / `attachBase64()` has no owner and works in a scheduled job too. At most 5 files and 10 MB per email. A file the sender may not attach fails the action. |

### PDF and file output

| Function | Returns | Description |
|---|---|---|
| `printPdf('module.entity', key, templateCd)` | `{ fileId, fileName, mimeType, size, checksum }`, plus `warnings` when a value printed empty because the user may not read it | Render a print template to a PDF **as the current user** (the record is read under their rights and the folder's row filter) and archive it. A descriptor, never the bytes: attach it with `sendEmail()`. Always pass a qualified entity code. Not available in a scheduled job or a background action, refused in a computing-only run, max 10 per run; each render holds the action's transaction open. |
| `downloadText(content, fileName, encoding?, mimeType?)` | URL string | Hand the user a text file the script built. `encoding` is `utf-8` by default; `windows-1251`, `cp866`, `koi8-u` and other code pages work, and a character the encoding cannot represent is an error. Line endings are written as given (join with `'\r\n'` for CR LF), no BOM. Returns the signed download URL (valid an hour). An action has one download: a later call replaces the earlier. In a background or scheduled run nobody receives it, so pass the URL on in `notify()`. Max 10 MB per file, 10 files per run. |
| `attachText(content, fileName, encoding?, mimeType?)` | descriptor | Build a text file for `sendEmail()`'s fourth argument, keeping its `mimeType` (e.g. an `.ics` as `text/calendar`). Same encodings as `downloadText()`; max 10 MB per file, 10 files per run shared with the download functions. Works in a scheduled job. |
| `attachBase64(base64, fileName, mimeType?)` | descriptor | `attachText()` for bytes. |
| `downloadBase64(base64, fileName, mimeType?)` | URL string | `downloadText()` for bytes; `application/octet-stream` unless `mimeType` says otherwise. |

### External API Calls

| Function | Returns | Description |
|---|---|---|
| `callApi(url, method, headers?, body?)` | String | Make an HTTP request to an external API. Returns response body as string. Parse JSON with `JSON.parse()`. Max 10 calls per script, 120s timeout, 5MB response limit. Content-Type defaults to `application/json` but can be overridden via headers. |
| `getFileBase64(fileFieldValue)` | String | Read a file from storage and return its content as a base64-encoded string. Use with `callApi()` to send files to AI APIs. Max 10 MB. Example: `getFileBase64([document_file])`. |
| `getFileUrl(fileFieldValue)` | String | Generate a temporary signed download URL (relative path) for a file field. Use in email templates or notifications — not for `callApi()`. |
| `getSecret('secret_cd')` | String | Retrieve a decrypted secret value (API keys, tokens). Secrets are managed in the admin UI. |
| `getFileInfo(fileFieldValue)` | Object \| null | File metadata for a file field. |
| `download(url, fileName?)` | — | Set a download URL on the action result; the browser opens it when the action returns. It fetches and stores nothing: the URL must already serve the bytes. To hand over a file the script builds, use `downloadText()` / `downloadBase64()`. |
| `callService('name', { args })` | Any | Invoke a registered host service. |

### Files, settings, document extraction

| Function | Returns | Description |
|---|---|---|
| `getSetting('setting_cd')` | Any | Read a module setting, resolved through the folder chain (current folder → parents → module default). |
| `ocrExtract(fileField, endpointBaseUrl, schema?, opts?)` | Object | Run OCR extraction against a document. `opts.profile` selects a registered extraction profile, e.g. `{ profile: 'proc.bill_of_lading' }`. |
| `detectDocument(rawText)` | Object \| null | Score text against reachable extraction profiles; returns the best match `{ profile, docType, score }` or `null`. |
| `applyProfile(json, 'module.profile_cd')` | Object | Map already-extracted JSON through a profile's field schema, without re-running OCR. |

### Utilities

| Function | Returns | Description |
|---|---|---|
| `now()` | DateTime | Current date/time. Use for `date`, `datetime`, and `timestamp` fields. **Lowercase** — this is the execute-block date function. |
| `addDays(date, n)` | Same as `date` | Add `n` days to a date field, a `Date` or an ISO string, e.g. `addDays([order_date], 3)`. Null stays null; anything else is an error. |
| `addMinutes(date, n)` | DateTime | Add `n` minutes, e.g. `addMinutes(now(), 15)`. |
| `addSeconds(date, n)` | DateTime | Add `n` seconds. |
| `currentUserId()` | Long | The acting user's tenant user ID. |
| `userId` | Long | Same value as `currentUserId()`, as a **bare identifier — no parentheses**. `userId()` is a compile error; there is no `current_user_id()`. |
| `flush()` | — | Flush pending writes so a following read sees them. |
| `tryParseJson(value)` | Any \| null | Parse JSON, returning `null` on failure instead of throwing. |
| `nextNumber('entity')` | String | Generate next value from a number sequence. Usually not needed — platform auto-fills on `insert()`. Use for pre-generating numbers. |
| `callProc('proc_name', { args })` | Result | Call a stored procedure. Args are passed as named parameters. |
| `entityLink('entityCd', record, description?)` | Link value | Build a clickable link to any entity record, for storing in an `entitylink` (jsonb) column. `record` is a row object (e.g. the result of `insert()` or `getRecord()`); its PK columns are read and stored as **strings**, so snowflake/cuid ids (> 2^53) stay exact. The entity is resolved at build time and stored **by id** — `entity_cd` is only unique per module, so always pass a qualified code (`'fin.invoice'`). Omit `description` and the link is captioned with the entity's `toString` against `record`; an explicit `description` wins. |

> **Dates: `now()` in `execute:`, `TODAY()`/`NOW()` in formulas.** The `execute:` block runs as
> JavaScript (Jint) and exposes **lowercase `now()`** only — `TODAY()` and `NOW()` (uppercase) are
> **formula-engine** functions and are **undefined in `execute:`** (using them throws
> `'TODAY' is not defined` at install). Use `TODAY()`/`NOW()` only in `canExecute:`, formula
> columns, and other formula contexts; use `now()` everywhere inside `execute:`. (Uppercase `NOW()`
> is also fine *inside a raw SQL string* passed to `query()`, because that's SQL, not JS.)

> **`IF()` is formula-only too.** It was previously listed here as a ternary helper — that was
> wrong. `IF(cond, a, b)` is a **formula-engine** function, valid in `canExecute:` and formula
> columns, and **undefined in `execute:`** (install fails with `'IF' is not defined`). Inside
> `execute:` use the JavaScript conditional operator: `var x = cond ? a : b`.

> **64-bit ids are BigInt in `execute:`.** JS numbers are doubles (53 mantissa bits) and dForge
> ids are 58-bit snowflakes, so any `long` outside ±2^53 — user ids, PKs, FKs — reaches the script
> as a JS **BigInt**. Ids stay exact through reads, writes and comparisons, including
> `currentUserId() == [last_updated_by]`. Smaller `int8` values (counters, quantities) stay
> ordinary numbers, so arithmetic on them is unchanged.
>
> Two operations throw rather than round silently, each with a working form:
> `[owner_id] + 1` → use `Number([owner_id]) + 1` (explicit, and accepts the rounding);
> `JSON.stringify([owner_id])` → assign the object instead (`[payload] = { id: [owner_id] }`),
> which serializes correctly on the write path.
>
> Never write a large id as a bare numeric literal — the literal itself rounds before the
> comparison runs. `[owner_id] == 2006…067` is **false**; quote it (`== '2006…067'`) or suffix
> it with `n` (`== 2006…067n`). Comparing two id columns needs neither.
>
> For "who did this", the platform audit columns (`created_by` / `last_updated_by`) remain the
> better answer — filled server-side, no script involved. For ownership predicates use
> **`CURRENT_USER_ID()`** in `canExecute:` or a formula column — a *formula-engine* function
> (undefined in `execute:`) that the server translates to an exact `::bigint` SQL literal.


## Function libraries

Helpers several actions share go once in `logic/functions/*.dsl`, never pasted into each action. A library is detected by presence; `manifest.json` declares nothing.

```js
// logic/functions/accounting.dsl
var recNo = 0

function round2(x) {
    return Math.round(x * 100) / 100
}

function accountId(code) {
    var rows = query('SELECT account_id FROM account WHERE code = @code', { code: code })
    if (rows.length == 0) error('Account {code} does not exist.', { code: code })
    return rows[0].account_id
}
```

```js
// logic/actions/commit_sale.dsl
execute:
    [amount] = round2([amount])
    var account = accountId(getSetting('sale_account'))
    recNo = recNo + 1
```

- **Contents.** Top-level `function` declarations and top-level `var` / `let` / `const`; any other top-level statement is refused at install. Every built-in an action has.
- **No record context.** `[field]`, `[ref].[target]`, `params[...]` and `old[...]` are refused: pass values as arguments (`round2([amount])`). `[name]` standing alone is refused too, even where JavaScript would read an array; write a one-element array as `Array.of(name)`. An index (`rows[i]`) is fine.
- **Names.** File names use letters, digits, `_`, `-`. A library may not declare a built-in's name, a JS global (`Math`, `Date`), `schema` or a `__` name. A name is declared once across a module's libraries. An action may not declare a global of a library's name (a top-level function or variable, or a `var` outside any function): delete the local copy. Inside a function, or a block-scoped `let` / `const`, a name may repeat.
- **State.** Top-level variables start afresh on every run (each record of a `single` action, each batch, trigger fire and job run), so a counter like `recNo` never leaks between runs or users.
- **Messages.** `error()` / `warn()` / `info()` / `exit()` texts in a library are translated from the module's `messages` block like an action's.
- **Errors.** A runtime error names the file and line: `(logic/functions/tax.dsl, line 3)`. A library that does not compile is reported once, as itself (`Function library failed to compile:` with file and line), at pack, validate and install, not as undefined calls in the actions.
- **Linked at run time**, not copied into actions: changing a library changes every action that calls it.
- **Not available:** formulas (`F` columns, `canExecute:`) cannot call libraries; the in-app editor does not show them; Studio refuses a module that has libraries or imports.

### Another module's functions

List the functions under `"functions"` in that dependency's contract `deps/<module>.json`, then call them as `<module_with_underscores>.<fn>()`:

```json
{
    "module": "cdy-accounting",
    "version": ">=0.3.0",
    "entities": {},
    "functions": ["roleOf"]
}
```

```js
execute:
    var account = cdy_accounting.roleOf([doc_type], 'stock')
```

- The namespace is the provider's code with `-` replaced by `_`, so `foo-bar` and `foo_bar` share one. Only the listed functions are in it; a call to another fails at install. Only a module in `dependencies` can be called.
- The function runs as its provider: unqualified tables resolve in the provider's schema, `getSetting()` reads the provider's settings, its messages use the provider's translations. User, folder, transaction and run limits are the caller's.
- A provider's top-level variables are its own, fresh per run.
- Libraries may call imported functions too, and imports chain (a provider's functions call what the provider imports). Import only what you call yourself.
- Install checks each imported name is a top-level function of the installed provider's libraries. A contract that imports only functions may declare `"entities": {}`.
- A provider upgrade that drops an imported function is not re-checked against consumers: the call finds `undefined` at run time.

## Real examples from the codebase

### Simple field update (status transition)

From `modules/fin/logic/actions/send_reminder.dsl`:

```
canExecute:
    [status] != 'Paid' AND [status] != 'Cancelled' AND [status] != 'Draft' AND [due_date] < TODAY()

execute:
    [status] = 'Overdue'
    notify([owner_id], 'Overdue reminder sent for invoice ' + [invoice_number])
```

### Params + validation + insert

From `modules/wms/logic/actions/adjust_stock.dsl`:

```
params:
    adjustment_qty: number required "Adjustment Quantity"
    reason: text required "Reason"

canExecute:
    [quantity] >= 0

execute:
    var newQty = [quantity] + params[adjustment_qty]

    if (newQty < 0) {
        error('Adjustment would result in negative stock (' + newQty + ')')
    }

    var movementType = IF(params[adjustment_qty] >= 0, 'Adjustment', 'Write-off')

    insert('stock_movement', {
        movement_type: movementType,
        warehouse_id: [warehouse_id],
        product_id: [product_id],
        quantity: IF(params[adjustment_qty] >= 0, params[adjustment_qty], params[adjustment_qty] * -1),
        movement_date: now(),
        reference_no: params[reason]
    })

    [quantity] = newQty
    info('Stock adjusted by ' + params[adjustment_qty] + '. New balance: ' + newQty)
```

### Query + loop + multi-insert (complex orchestration)

From `modules/crm/logic/actions/create_quote_from_opp.dsl`:

```
canExecute:
    [stage] != 'Closed Won' AND [stage] != 'Closed Lost'

execute:
    var lines = query('SELECT line_id, product_id, quantity, unit_price, discount_pct, description, sort_order FROM crm.opportunity_line WHERE opportunity_id = @oppId ORDER BY sort_order', { oppId: [opportunity_id] })

    if (lines.length == 0) {
        error('Cannot create quote: opportunity has no product lines. Add products first.')
    }

    var subtotal = 0
    for (var i = 0; i < lines.length; i++) {
        var line = lines[i]
        subtotal = subtotal + (line.quantity * line.unit_price)
    }

    var quote = insert('quote', {
        opportunity_id: [opportunity_id],
        account_id: [account_id],
        contact_id: [contact_id],
        status: 'Draft',
        quote_date: now(),
        expiry_date: addDays(now(), 30),
        subtotal: subtotal,
        discount_pct: 0,
        tax_pct: 0,
        notes: 'Created from opportunity: ' + [opportunity_name]
    })

    for (var i = 0; i < lines.length; i++) {
        var line = lines[i]
        insert('quote_line', {
            quote_id: quote.quote_id,
            product_id: line.product_id,
            quantity: line.quantity,
            unit_price: line.unit_price,
            discount_pct: line.discount_pct || 0,
            description: line.description,
            sort_order: line.sort_order || (i + 1)
        })
    }

    info('Quote ' + quote.quote_number + ' created from opportunity ' + [opportunity_name])
    notify([owner_id], 'Quote ' + quote.quote_number + ' created for ' + [opportunity_name])
```

### Reference preloading + email

From `modules/crm/logic/actions/approve_quote.dsl`:

```
canExecute:
    [status] = 'Sent'

execute:
    [status] = 'Accepted'
    notify([owner_id], 'Quote ' + [quote_number] + ' has been accepted')

    var contact = preloadRef('contact_id')
    if (contact.get('email') != null) {
        sendEmail(contact.get('email'), 'Your quote ' + [quote_number] + ' is confirmed', '<p>Dear ' + contact.get('first_name') + ',</p><p>Your quote has been accepted.</p>')
    }
```

### Query + update (cross-entity stock management)

From `modules/wms/logic/actions/receive_goods.dsl`:

```
canExecute:
    [status] = 'Approved'

execute:
    var poLines = query("SELECT line_id, product_id, quantity FROM purchase_order_line WHERE purchase_order_id = @poId", { poId: [purchase_order_id] })

    for (var i = 0; i < poLines.length; i++) {
        var line = poLines[i]
        var productId = line['product_id']
        var qty = line['quantity']

        insert('stock_movement', {
            movement_type: 'Receipt',
            warehouse_id: [warehouse_id],
            product_id: productId,
            quantity: qty,
            movement_date: now(),
            reference_no: [po_number]
        })

        var existing = query("SELECT stock_id, quantity FROM stock WHERE warehouse_id = @wh AND product_id = @prod", { wh: [warehouse_id], prod: productId })

        if (existing.length > 0) {
            var newQty = existing[0]['quantity'] + qty
            query("UPDATE stock SET quantity = @newQty, last_updated = NOW() WHERE stock_id = @sid", { newQty: newQty, sid: existing[0]['stock_id'] })
        } else {
            insert('stock', {
                warehouse_id: [warehouse_id],
                product_id: productId,
                quantity: qty
            })
        }
    }

    [status] = 'Received'
    info('Received ' + poLines.length + ' line(s) from PO ' + [po_number])
```

> The two `query()` reads and the raw `query('UPDATE …')` above predate `select()`/`update()` —
> today each would be a structured call (`select('wms.stock', { filter: … })`,
> `update('wms.stock', stockId, { quantity: newQty })`).

### select() + update() with a scalar key (cron-scan dispatch)

From `modules/comm/logic/actions/dispatch_messages.dsl` (a scheduled-job action — no record context):

```
execute:
    var queued = select('comm.message', {
        columns: ['message_id', 'to_addr', 'to_point.value as point_value', 'subject', 'body_html', 'body_text', 'attempt_count'],
        filter: { g: 'and', i: [
            { c: 'status', o: '=', v: 'queued' },
            { c: 'channel', o: '=', v: 'email' }
        ] },
        orderBy: ['message_id'],
        limit: 10
    })

    if (queued.length == 0) {
        exit('No queued messages', 'info')
    }

    for (var i = 0; i < queued.length; i++) {
        var msg = queued[i]
        sendEmail(msg.to_addr || msg.point_value, msg.subject, msg.body_html || msg.body_text || '')

        update('comm.message', msg.message_id, {
            status: 'sent',
            sent_at: now(),
            attempt_count: (msg.attempt_count || 0) + 1
        })
    }
```

## Execution modes

Actions run in one of two modes, declared in `ui/actions.json`:

| Mode | Description | `[field]` refers to |
|---|---|---|
| `"single"` (default) | Action runs once per selected record (server loops over the keys) | The current record |
| `"each"` | Synonym for `"single"` — identical runtime behavior; kept for readability when intent is "do this for each selected row" | The current record |
| `"batch"` | Action runs once with all records exposed as `__records`; iterate explicitly with `for x in records { ... }` | No bare `[field]` — use `x[field]` inside the loop |

In `batch` mode, access individual records with `__records.get(i)`, the count with `__records.count()`, and IDs via `__records.ids`.

## Async actions

An inline run stops after **10 seconds** (`Dsl:Limits:ScriptTimeoutSeconds`) with "The operation has timed out.", rolling its transaction back. Work that imports or posts many documents belongs in a background run; a caller that needs the outcome waits for the records' state (a posting flag) rather than for the call.

For long-running actions, set `"isAsync": true` in `ui/actions.json`. That **permits** background execution: the call is queued as a `background_action` row and picked up by `BackgroundActionService` (a hosted `BackgroundService` polling every ~10s — there is no Hangfire in dForge), and the user gets a completion notification via SSE. The DSL syntax is the same.

`isAsync` does not force it. `action.execute` carries its own `async` argument and the server branches on that, so a parameterless action is queued directly while one with parameters is offered to the user as both "Run" (inline) and "Run in Background". Note that a queued run has **no wrapping transaction** — see *Atomicity* below.

## Registering the action

In `ui/actions.json`:

```json
{
    "mark_done": {
        "label": "Mark Done",
        "description": "Mark this item as completed",
        "icon": "bi-check-circle",
        "entityCode": "todo_item",
        "executionMode": "single",
        "script": "mark_done",
        "isTransacted": true,
        "orderNum": 10
    },
    "create_quote_from_opp": {
        "label": "Create Quote",
        "description": "Create a draft quote from this opportunity's products",
        "icon": "bi-file-earmark-plus",
        "entityCode": "opportunity",
        "executionMode": "single",
        "script": "create_quote_from_opp",
        "isTransacted": true,
        "orderNum": 50
    }
}
```

**Action registration properties:**

| Property | Required | Description |
|---|---|---|
| `label` | Yes | Button label in the UI |
| `description` | Yes | Tooltip/description text |
| `icon` | Yes | Bootstrap icon **with** `bi-` prefix (e.g. `"bi-check-circle"`) — unlike menus which omit the prefix |
| `entityCode` | Yes | Which entity this action applies to |
| `executionMode` | Yes | `"single"` (default) or `"each"` — runs per record, DSL uses `[field]`; or `"batch"` — runs once, DSL uses `for x in records { ... }` with `__records` |
| `script` | Yes | DSL script name (without path or extension — matches filename in `logic/actions/`) |
| `isTransacted` | Recommended | `true` = the whole run is **one transaction**: the first failure aborts it *and* rolls back everything already written. `false` = no transaction, and what happens next depends on the mode — `single`/`each` report the failure and carry on with the next record, keeping what succeeded; a `batch` script is one invocation, so a failure just ends the run there with its earlier writes committed and its `[field]` assignments never flushed. **Defaults to `true`** when omitted — see *Atomicity* below |
| `orderNum` | Recommended | Display order in the action menu |
| `isAsync` | Optional | `true` **permits** background execution — it does not force it. A parameterless action is queued directly; one with params is offered to the user as both "Run" and "Run in Background". Queued runs get a completion notification |
| `previewTemplate` | Optional | Code of a print template of the action's entity (`ui/print_templates.json`). The run dialog opened on one record renders it as a PDF beside the params, so the user reads what the action sends before running it. Each preview renders and archives a PDF |
| `paramSets` | Optional | Saved parameter sets the module ships, keyed by set name: `{ "default": { "description": "…", "values": { "subject": "…" } } }`. Read-only for users and refreshed on every install; a `values` key the action does not declare fails the install. A set named `default` is applied when the dialog opens. A value starting with `=` is a formula over the record (`=[customer].[email]`) and one containing `{{ }}` is a print-style template, both evaluated when the dialog opens on one record. A user's own set of the same name overrides it for that user, and a set an admin saved under a shipped name is left alone with a warning |

**Definitions are cached.** The server reads an action's definition through a per-tenant cache (5 minutes), cleared on module install, uninstall and Studio publish. A CLI install is noticed only through a connected browser, so without one a changed action can run stale for up to 5 minutes.

## Atomicity

`isTransacted: true` makes the run **one transaction**, in both execution modes.
The first failing record aborts the run and every write the run made — including
those for records that already succeeded — is rolled back. It covers the script's
own `insert()` / `update()` / `query()` calls as well as the flush of `[field] = …`
assignments. It does not depend on the entity carrying `auditHistory`.

`isTransacted: false` is the opposite contract — no transaction — and what it means
depends on the mode:

- **`single` / `each`**: each record stands alone. The failure is reported, the loop
  carries on with the next record, and what the earlier records wrote is kept.
- **`batch`**: there is one script invocation and no loop to continue, so a failure
  simply ends the run. Whatever the script had already written with `insert()` /
  `update()` is committed, and the pending `[field] = …` assignments are never
  flushed. There is nothing "independent" about it — which is why `batch` +
  `isTransacted: false` is a shape to avoid.

| path | `isTransacted: true` | `isTransacted: false` |
|---|---|---|
| Sync execute, `single` | whole selection rolled back | writes stay committed |
| Sync execute, `batch` | whole run rolled back | writes stay committed |
| Scheduled job | rolled back | rolled back (the dispatcher owns the transaction) |
| **Queued to background**, `single` / `each` | **stays committed** (run still aborts at the first failure) | **stays committed** (run continues) |
| **Queued to background**, `batch` | **stays committed** (flag not read at all) | **stays committed** (same) |

**The background row is the exception and it is a known platform gap.** The
background worker opens no transaction, so an action that is atomic when run
inline is not when the same call is queued. The rollback half is lost outright;
what survives depends on the mode. The worker's `single` / `each` loop still reads
`isTransacted` to decide whether to abort after the first failed record or carry
on, so there `true` means "stop here", not "undo". Its `batch` path never reads the
flag — one invocation, ending on failure either way — so a queued `batch` action
gets nothing from `isTransacted` at all. And which one happens is decided by
the *request*, not by the manifest: `isAsync: true` only permits queuing, and an
action with parameters is offered to the user as both "Run" (inline, transactional)
and "Run in Background" (queued, not). So an `isAsync` action cannot be assumed to
be either.

**Two things that follow for how you write actions:**

1. **Declare `isTransacted: true`** — which is also the default — for anything that
   writes more than one row. Do *not* reach for `auditHistory` as an atomicity
   switch; that was a workaround for a defect that no longer exists.
2. **Still validate up front.** Call `error()` before the first `insert()` /
   `update()` where you can, so a background-queued run has nothing to unwind
   either. This is the only guard that holds on every path.

## SQL in query() — important notes

`query()` is the **escape hatch** — reach for it only when the structured built-ins can't express the read/write (aggregates, multi-hop joins, CTEs, `FOR UPDATE`). For row-shaped work prefer `select()` / `insert()` / `update()` / `delete()`: they validate entity codes against metadata, coerce values per column, and (for `insert`/`update`) maintain auto-fill and audit columns.

> **`query()` runs on a pooled, shared connection.** Once your statement — or the
> surrounding transaction, where there is one — finishes, that connection is
> handed to another request. So never leave state behind on it: use `SET LOCAL`
> rather than `SET`, `pg_advisory_xact_lock()` rather than `pg_advisory_lock()`,
> and `ON COMMIT DROP` on any temp table. Only `query()` can do any of this — the
> structured built-ins emit plain DML — and nothing checks it statically.

1. **Bare table names are qualified automatically** with the current module's schema after `FROM` / `JOIN` / `USING`, and as the target of `INSERT INTO`, `MERGE INTO` and `UPDATE`. A name already qualified (`wms.stock_movement`) is left as written, so qualify only another module's table. Left alone: words that name no table (`IS DISTINCT FROM`, `EXTRACT(year FROM d)`, `FOR UPDATE`, `DO UPDATE SET`, `SELECT ... INTO var`), built-in set functions (`generate_series`, `unnest`), literals and comments. A CTE name is a source only inside the query that declares its `WITH` (and in its own body only under `RECURSIVE`); a write target is always the real table, so `WITH t AS (...) UPDATE t ...` updates the module's `t`. `;`-separated statements are each qualified. (A module whose code has a hyphen and that declares no `schemaName` lives in a hyphenated schema, which raw SQL cannot name as written — the structured built-ins reach it by module code; give such a module a `schemaName` with underscores if its tables are queried in SQL.)
2. **Use `@param` placeholders** for values — NEVER concatenate user input into SQL strings. The engine auto-parameterizes.
3. **SELECT, INSERT, UPDATE, DELETE all work** via `query()`. For reads, it returns row arrays. For writes, it executes the statement.
4. **`insert()` is preferred over `query('INSERT ...')`**, `update()`/`delete()` over `query('UPDATE/DELETE ...')`, and `select()` over `query('SELECT ...')` for module entities — raw SQL skips auto-fill (PKs, audit, number sequences) and metadata validation.

## Common mistakes

- Writing an action that only reads, computes and prints (`info('Balance: ' + total)`) — **wrong shape**, not just wrong formatting. Nothing is stored, so nobody can re-read the answer. Use a report, a formula column, or write a result record. → *When an action is the wrong tool* (top of this file)
- Writing `params.note` instead of `params[note]` — **wrong**. Use bracket syntax for params.
- Writing `params["note"]` — **also wrong in DSL syntax**. Use `params[note]` without quotes.
- Writing `update [status] = 'Draft'` (declarative style) — **wrong**. Use `[status] = 'Draft'` (assignment).
- Writing `insert('entity', field1, value1)` (positional args) — **wrong**. Use `insert('entity', { field: value })` (object).
- Writing `query('entity', filter)` (filter object) — **wrong**. `query()` takes raw SQL strings with `@param` placeholders. A structured read is `select('entity', { filter: … })`.
- Passing an **array of ids** as the `key` of `update()`/`delete()` — **rejected**. Loop over the ids and mutate one at a time.
- Selecting or string-filtering a plain reference (`R`) column in `select()` — **throws**. Use the FK column or a nav path (`'customer.company_name'`).
- Unqualified entity codes (`update('message', …)`) — works inside the owning module but **always prefer the qualified form** (`update('comm.message', …)`).
- An assignment inside a one-line block, `if (x) { [field] = y }` -- fails at run time with "not a valid reference". Put `[field] = y` on a line of its own.
- Indexing straight after a call or an index, `query(sql)[0]` or `rows[0][name]` -- read as a field reference `[0]` / `[name]` before platform #1537 (2026-10-24). On an older platform, assign the result to a variable first. `rows [name]`, with a space, is still a field read.
- Forgetting `var` in loops — `for (i = 0; ...)` creates a global. Always `for (var i = 0; ...)`.
- Using ES6 syntax (`const`, `let`, `=>`, template literals) — **may not work**. Jint supports ES5.1 primarily. Stick to `var`, `function`, string concatenation with `+`.
- Calling `TODAY()` or `NOW()` (uppercase) inside `execute:` — **wrong**, they're undefined there and install fails with `'TODAY' is not defined`. Use lowercase **`now()`** in `execute:`; `TODAY()`/`NOW()` are formula-only (`canExecute:`, formula columns).
- Forgetting that `insert()` returns the full row — you can use `quote.quote_id` immediately after insert.
- Using `[field]` inside a `query()` SQL string — **wrong**. `[field]` is resolved in JS scope, not inside SQL strings. Pass values as `@param` arguments.
- A **function library** (`logic/functions/*.dsl`) that reads `[field]` / `params[...]` / `old[...]`, uses `[name]` alone (write `Array.of(name)`), or has a top-level statement that is not a `function` / `var` / `let` / `const` -- all refused at install. Pass values in as arguments. See *Function libraries*.
- Keeping a **local copy** of a library function in an action (a top-level function, or a `var` of the same name outside any function) -- refused at install. Delete the copy.
- Calling another module's function without importing it: list it under `"functions"` in `deps/<module>.json`, call it as `<module_with_underscores>.fn()`.
- `ref cdy_hr.department` (schema form) in `params:` -- installs with no picker target. Write `ref cdy-hr.department`.
- `'' + params[barcode]` to keep a text param text -- no longer needed.

## Internal API (advanced)

The platform globals (`insert()`, `query()`, `error()`, etc.) are sugar on top of an internal API: `__ctx.insert()`, `__ctx.query()`, `__ctx.error()`, `__r.get('field')`, `__r.set('field', value)`. Both forms work in DSL scripts. The bare form (without `__ctx.` / `__r.`) is preferred for readability.
