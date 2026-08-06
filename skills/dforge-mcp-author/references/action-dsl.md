# Action DSL Reference

Actions are dForge's business logic. They are scripts with three declarative blocks (`params:`, `canExecute:`, `execute:`) where the `execute:` block uses **JavaScript syntax** executed server-side via the Jint engine, with platform-provided global functions.

Lives in: `logic/actions/<action_name>.dsl`
Registered in: `ui/actions.json`

## When an action is the wrong tool

An action exists to **change something**. Its message is a receipt for work that was done — not the output itself.

Do **not** write an action whose `execute:` block only reads data, computes a value and reports it with `info()`. The result is a line of text that is never stored: it can't be audited, referenced, re-read or reported on, and every reader has to re-run the action to see it again. The value also reaches the user unformatted — a raw `query()` result carries no column metadata, so money renders as `1000.0099999999999` instead of `1,000.01`.

If you are about to write a `check_…`, `calculate_…` or `show_…` action, build one of these instead:

| What's actually needed | Build this |
|---|---|
| The user needs to **see** current numbers | A **report** or a data view — both are metadata-driven, so values format correctly, and the user can return to them any time without re-running anything. |
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
    new_stage: dropdown required "New Stage"
    note: textarea "Follow-up Note"
    adjustment_qty: number required "Adjustment Quantity"
    reason: text required "Reason"
```

Types are a subset of column field types: `text`, `textarea`, `number`, `currency`, `percent`, `checkbox`, `date`, `datetime`, `dropdown`, `lookup`, `user`.

Access in execute block: `params[param_name]` (bracket syntax, NOT dot syntax).

### `canExecute:` — availability formula

A formula expression (same grammar as formula columns) that evaluates to true/false. When false, the action button is hidden or disabled in the UI.

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

Uses formula syntax: `[field]` for field access, `=` / `!=` / `<` / `>` / `AND` / `OR` operators, `TODAY()`, etc.

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

| Function | Returns | Description |
|---|---|---|
| `insert('entity', { field: value, … })` | Inserted row object | Insert a new record. Returns the full row including auto-filled columns (PK, audit, number sequences). Access returned fields with `result.field_name`. |
| `select('entity', opts?)` | Array of row objects | Structured multi-row read — see "select()" below. `opts` = `{columns, filter, orderBy, limit, offset}`, all optional. Prefer over `query()` for row-shaped reads. |
| `update('entity', key, { field: value, … })` | Rows affected (number) | Update the row(s) matched by `key`. Refreshes update-phase server defaults (audit `last_updated` / `last_updated_by`) and coerces values like `insert()`. |
| `delete('entity', key)` | Rows affected (number) | Delete the row(s) matched by `key`. |
| `query('SQL', { arg: value })` | Array of row objects | Execute parameterized SQL. Use `@argName` placeholders. Schema-qualified table names (`crm.contact`). Access row fields with `row.field_name` or `row['field_name']`. **Escape hatch** — prefer `select()`/`update()`/`delete()` when the structured shape fits. |
| `getRecord('entity', key)` | Row object | Fetch a single record by key. Access fields with `rec.field_name` (or `rec.get('field_name')`). **Throws** a localized "not found" error if absent. |
| `getRecordOrNull('entity', key)` | Row object or `null` | Like `getRecord`, but returns `null` instead of throwing when the row is absent — use for an expected-absence lookup, guarded with `if (rec == null)`. |
| `preloadRef('fk_column')` | Row object | Load the referenced record for a FK column. Access its fields with `ref.get('field')`. |

> **Entity codes: always qualify.** Every data built-in (`select`, `insert`, `update`, `delete`,
> `getRecord`, `nextNumber`) accepts a qualified `module.entity` code — write `update('comm.message', …)`,
> not `update('message', …)`, even inside the owning module. It reads unambiguously and keeps the
> script correct if it's ever moved to a bridge module.

> **Keys: scalar or object.** In `update()` / `delete()` / `getRecord()` / `getRecordOrNull()`,
> `key` is either a scalar PK value (`update('task', 42, {…})` — single-column PK only) or an
> object (`{ task_id: 42 }`; multiple entries for compound keys). Scalar **string** ids are coerced
> to the PK's storage type, so a snowflake id carried as a string binds as `int8`, not text. A
> `null` key **throws** (a `col = NULL` predicate can never match), and array keys are rejected —
> loop and mutate per id instead.

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

### Messaging

| Function | Description |
|---|---|
| `error('message')` | **Abort** the action and show an error to the user. Rolls back all changes. |
| `warn('message')` | Show a warning but continue execution. |
| `info('message')` | Show an informational message. A **receipt for work the action did** — not a way to publish a computed value; see *When an action is the wrong tool*. |
| `exit('message'?, 'level'?)` | **Stop the script early without error** — changes made so far are kept. Level `'info'` (default) or `'warn'` styles the message. This is the DSL's early-return: a bare `return` is not valid at the top level of `execute:`. |
| `notify(userId, 'message')` | Send an in-app notification to a specific user. First arg is a user ID (typically `[owner_id]` or similar). |

### Email

| Function | Description |
|---|---|
| `sendEmail(to, subject, htmlBody)` | Send a raw email. `to` is an email address string. |
| `sendEmail(to, subject, htmlBody, templateCode)` | Send a templated email (if email templates are configured). |

### External API Calls

| Function | Returns | Description |
|---|---|---|
| `callApi(url, method, headers?, body?)` | String | Make an HTTP request to an external API. Returns response body as string. Parse JSON with `JSON.parse()`. Max 10 calls per script, 120s timeout, 5MB response limit. Content-Type defaults to `application/json` but can be overridden via headers. |
| `getFileBase64(fileFieldValue)` | String | Read a file from storage and return its content as a base64-encoded string. Use with `callApi()` to send files to AI APIs. Max 10 MB. Example: `getFileBase64([document_file])`. |
| `getFileUrl(fileFieldValue)` | String | Generate a temporary signed download URL (relative path) for a file field. Use in email templates or notifications — not for `callApi()`. |
| `getSecret('secret_cd')` | String | Retrieve a decrypted secret value (API keys, tokens). Secrets are managed in the admin UI. |
| `getFileInfo(fileFieldValue)` | Object \| null | File metadata for a file field. |
| `download(url, fileName?)` | — | Fetch a URL into tenant storage. |
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
| `addDays(date, n)` | Date | Add `n` days to a date, e.g. `addDays(now(), 30)`. |
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

For long-running actions, set `"isAsync": true` in `ui/actions.json`. The action runs in the background via Hangfire, and the user gets a completion notification via SSE. The DSL syntax is the same.

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
| `isTransacted` | Recommended | `true` = the first record that fails aborts the run; `false` = the failure is reported and the loop moves to the next record. It does **not** open a transaction — see *Don't assume your action is atomic* below |
| `orderNum` | Recommended | Display order in the action menu |
| `isAsync` | Optional | `true` = runs in background via Hangfire, user gets completion notification |

## Don't assume your action is atomic

An action is **not** reliably one transaction, and `isTransacted: true` does not
make it one — it only decides whether the first failing record aborts the run.
Whether the writes made before a failure survive depends on the execution path:

| path | mode | writes before the failure |
|---|---|---|
| Sync execute, entity **with** `auditHistory` | `single` | rolled back |
| Sync execute, entity **with** `auditHistory` | `batch` | **stay committed** |
| Sync execute, entity without it | either | **stay committed** |
| Scheduled job | — | rolled back |
| Background (`isAsync: true`) action | either | **stay committed** |

Both "rolled back" rows are a side effect of the audit machinery opening a
transaction the action then inherits — and in `batch` mode it opens only after the
script has finished, so it doesn't cover the script at all. Adding or removing
`auditHistory`, or switching between `single` and `batch`, changes whether a failed
action leaves partial writes behind, with no change to the action itself.

**This is a platform defect, not a contract** — actions are intended to be atomic,
and this table is what happens until that lands. So don't design around either
outcome, and don't reach for `auditHistory` as an atomicity switch.

**Write actions that don't depend on it:** do all validation up front and call
`error()` before any `insert()` / `update()`, so there is nothing to unwind either
way.

## SQL in query() — important notes

`query()` is the **escape hatch** — reach for it only when the structured built-ins can't express the read/write (aggregates, multi-hop joins, CTEs, `FOR UPDATE`). For row-shaped work prefer `select()` / `insert()` / `update()` / `delete()`: they validate entity codes against metadata, coerce values per column, and (for `insert`/`update`) maintain auto-fill and audit columns.

> **`query()` runs on a pooled, shared connection.** Once your statement — or the
> surrounding transaction, where there is one — finishes, that connection is
> handed to another request. So never leave state behind on it: use `SET LOCAL`
> rather than `SET`, `pg_advisory_xact_lock()` rather than `pg_advisory_lock()`,
> and `ON COMMIT DROP` on any temp table. Only `query()` can do any of this — the
> structured built-ins emit plain DML — and nothing checks it statically.

1. **Table names are schema-qualified** within the module: `crm.contact`, `wms.stock_movement`, `fin.invoice`. Use the module code as the schema prefix. (Module codes with a hyphen, e.g. `crm-fin`, cannot be schema-qualified in raw SQL — another reason to use the structured built-ins, which accept the qualified `module.entity` code.)
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
- Forgetting `var` in loops — `for (i = 0; ...)` creates a global. Always `for (var i = 0; ...)`.
- Using ES6 syntax (`const`, `let`, `=>`, template literals) — **may not work**. Jint supports ES5.1 primarily. Stick to `var`, `function`, string concatenation with `+`.
- Calling `TODAY()` or `NOW()` (uppercase) inside `execute:` — **wrong**, they're undefined there and install fails with `'TODAY' is not defined`. Use lowercase **`now()`** in `execute:`; `TODAY()`/`NOW()` are formula-only (`canExecute:`, formula columns).
- Forgetting that `insert()` returns the full row — you can use `quote.quote_id` immediately after insert.
- Using `[field]` inside a `query()` SQL string — **wrong**. `[field]` is resolved in JS scope, not inside SQL strings. Pass values as `@param` arguments.

## Internal API (advanced)

The platform globals (`insert()`, `query()`, `error()`, etc.) are sugar on top of an internal API: `__ctx.insert()`, `__ctx.query()`, `__ctx.error()`, `__r.get('field')`, `__r.set('field', value)`. Both forms work in DSL scripts. The bare form (without `__ctx.` / `__r.`) is preferred for readability.
