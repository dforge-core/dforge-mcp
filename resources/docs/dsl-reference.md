# dForge Action DSL — Reference

The dForge action DSL is a JavaScript ES5 subset (parsed via Esprima, executed via Jint) with dForge-specific extensions for record field access, batch processing, and platform service calls. Use this reference when authoring `logic/actions/*.dsl` files via `dforge_action_add`.

---

## File structure

A `.dsl` file consists of four ordered, optional blocks (only `execute:` is required):

```dsl
params:
    # Parameter declarations (one per line)

canExecute:
    # Single-expression formula returning boolean
    # Determines whether the action button is enabled for current record(s)

onBeforeStart:
    # Pre-queue initialization (async / background actions only)

execute:
    # Main logic — required
```

Block markers are case-insensitive but conventionally lowercase. Whitespace-indented bodies follow each marker. Blocks must appear in the order above when present.

---

## Execution modes

Specified in `ui/actions.json` per action; affects how the DSL body sees record context:

| Mode | DSL sees | Use when |
|---|---|---|
| `single` | one record at a time via `[field]` syntax | per-record operations triggered on each selected row OR a single-record document |
| `each` | same as `single` but explicitly iterated | rare; prefer `single` |
| `batch` | the full selection via `records.*` collection | bulk operations where you want explicit `for x in records { ... }` |

**Mode-context rule:** `[field]` syntax is only valid in `single` / `each` modes. In `batch` mode, write `rec[field]` inside the loop. In actions invoked by the **scheduler** (per `logic/jobs.json`), there is NO current record at all — `[field]` is a hard error; you must use `query()` to fetch what you need.

---

## Parameter declarations (`params:` block)

### Scalar form

```
paramName: fieldTypeCd [required|optional] ["description"] [k=v ...]
```

Common field types + their extra keys:

| `fieldTypeCd` | Extra keys | Example |
|---|---|---|
| `text` | `maxLen` | `name: text required "Name" maxLen=100` |
| `textarea` | (none) | `notes: textarea optional "Notes"` |
| `number` | `min`, `max`, `step` | `quantity: number required "Quantity" min=1` |
| `date` | (none) | `due_date: date required "Due"` |
| `dateTime` | (none) | `scheduled_at: dateTime required "Scheduled at"` |
| `boolean` | (none) | `urgent: boolean optional "Urgent?"` |
| `dropdown` | `options` | `priority: dropdown required "Priority" options=low,medium,high` |
| `lookup` | (use ref form instead — see below) | |
| `file` | `accept` | `attachment: file optional "Attachment" accept=.pdf,.png` |

### Reference form (FK to another entity)

```
paramName: ref entityCd [required|optional] ["description"]
```

```dsl
params:
    supplier: ref supplier required "Supplier"
    dest_warehouse: ref warehouse required "Destination Warehouse"
```

Access the linked record's fields via `params[paramName].targetField`:

```dsl
execute:
    var supplierName = params[supplier].name
    var maxDays = params[supplier].payment_terms
```

---

## Field access syntax

### Current record (single / each mode)

- `[fieldName]` — read or write a field on the current record
- `[refField].[targetField]` — navigate via a Reference (FK) column to a field on the linked entity

```dsl
# Read
if ([quantity] > [available_qty]) { error("Not enough stock") }
if ([supplier].[is_active] == false) { error("Supplier disabled") }

# Write
[status] = 'closed'
[closed_date] = now()
```

### DSL parameters

```dsl
[reference_no] = params[reference_no]
[total] = [unit_price] * params[quantity]
[customer_id] = params[customer].customer_id
```

### Batch mode (`records.*`)

| Expression | Returns |
|---|---|
| `records.count()` | int — number of selected records |
| `records.ids` | array of all selected record PKs |
| `records[n][field]` | the nth selected record's field value |
| `for rec in records { rec[field] }` | iterate; per-record read/write via `rec[fieldName]` |

```dsl
execute:
    for rec in records {
        rec[status] = params[new_status]
        rec[last_updated] = now()
    }
    info('Updated ' + records.count() + ' records.')
```

---

## Built-in functions (30)

All exposed by `ActionScriptEngine.cs` as host globals — no `import` needed.

### Database & data

#### `query(sql, params?) → array`
Execute a parameterized SELECT. Returns array of `{col: val}` dictionaries. SQL uses `@name` placeholders.

```dsl
var open = query(
    'SELECT invoice_id, total FROM fin.invoice WHERE status = @s AND customer_id = @cid',
    { s: 'open', cid: [customer_id] }
)
if (open.length == 0) { exit('Nothing open', 'info') }
info('Open invoices: ' + open.length + ', total $' + open[0].total)
```

#### `insert(entityCd, fields) → record`
Insert a row. Returns the inserted record as a dictionary (PKs populated, defaults applied, audit columns set).

```dsl
var note = insert('activity_note', {
    parent_id: [id],
    parent_entity: 'opportunity',
    note: params[note_text],
    author_id: [created_by]
})
info('Note ' + note.activity_note_id + ' created')
```

The returned record can be passed to a subsequent `insert()` for FK chaining:

```dsl
var po = insert('purchase_order', { supplier_id: params[supplier].supplier_id })
insert('po_line', { po_id: po.purchase_order_id, product_id: [product_id], qty: 1 })
```

#### `getRecord(entityCd, key) → record`
Fetch a single record by key. **Throws** a localized "not found" error if no row
matches — the safe default for a lookup that should always resolve (e.g. an FK you
just read). Fields are readable by dot notation (`rec.name`) or `rec.get('name')`.
`key` is a scalar PK, or an object for a compound key: `getRecord('gl.tag', { tag_group: 'REGION', tag_code: 'EU' })`.
The result is a **read-only** snapshot — writing to it (`rec.set(...)`) throws; use
`update()` to persist. A null key value can't match, so it counts as not-found.

```dsl
var rec = getRecord('crm.customer', [customer_id])
info('Customer: ' + rec.name + ' — credit limit $' + rec.credit_limit)
```

#### `getRecordOrNull(entityCd, key) → record | null`
Same as `getRecord`, but returns `null` instead of throwing when the row is absent —
use it when a missing record is an expected outcome (optional lookup, upsert probe).

```dsl
var existing = getRecordOrNull('crm.customer', [customer_id])
if (existing == null) { insert('crm.customer', { customer_id: [customer_id], name: [name] }) }
```

#### `callProc(name, args?) → record`
Call a stored procedure with named args. Returns the proc's result row (or rows if it RETURNS TABLE).

```dsl
var summary = callProc('fin.compute_balance', { account_id: [account_id], as_of: now() })
info('Balance: ' + summary.balance)
```

#### `preloadRef(fkField)`
Eagerly load the referenced record so subsequent `[fkField].[targetField]` calls don't re-query. Only useful in `single` / `each` mode and only if you'll access ref-nav many times in one execute block.

```dsl
execute:
    preloadRef('customer_id')
    var name  = [customer_id].[name]
    var email = [customer_id].[email]
    var phone = [customer_id].[phone]
    sendEmail(email, 'Welcome ' + name, '...')
```

### Date / time

#### `now() → DateTime`
Current UTC timestamp.

```dsl
[completed_at] = now()
```

#### `addDays(date, days) → DateTime`
Add (or subtract with negative) integer days.

```dsl
[due_date] = addDays(now(), 30)
var lastWeek = addDays(now(), -7)
```

#### `addSeconds(date, seconds) → DateTime`, `addMinutes(date, minutes) → DateTime`
Fractional-unit arithmetic.

```dsl
[token_expires_at] = addMinutes(now(), 15)
```

### Messaging & notifications

#### `info(message, opts?)`, `warn(message, opts?)`
Queue user-facing toast. `opts.links: [{entity, id}]` adds "open record" buttons.

```dsl
info('Created PO ' + po.po_number, {
    links: [{ entity: 'purchase_order', id: po.purchase_order_id }]
})
warn('Stock below reorder point — review supplier')
```

#### `notify(userId, message)`
Send a notification to a specific user's inbox.

```dsl
notify([approver_id], 'New purchase request from ' + [requester_name] + ' awaiting approval')
```

#### `sendEmail(to, subjectOrTemplateCd, bodyOrData?)`
Two modes:

```dsl
# Raw mode: (to, subject, body)
sendEmail('ap@acme.com', 'Bill ' + [bill_number] + ' approved', 'Amount: $' + [amount])

# Template mode: (to, templateCd, dataObject) — template defined in module's email_templates/
sendEmail([customer_id].[email], 'order_confirmation', {
    orderNumber: [order_number],
    total: [total],
    items: query('SELECT * FROM order_line WHERE order_id = @oid', { oid: [id] })
})
```

#### `error(message)`
**Throw** — aborts execution and rolls back the **entire transaction** including any prior `insert()` / writes in this `execute:` block. Use for validation failures.

```dsl
if ([rating] == null || [rating] < 1 || [rating] > 5) {
    error('Rating must be 1-5')
}
```

#### `exit(message?, level?)`
Successful early exit — **commits** work done so far. `level`: `"info"` (default) | `"warning"` | `"danger"` | `"success"`.

```dsl
if ([status] == 'closed') { exit('Already closed — nothing to do', 'info') }
```

### File operations

#### `getFileBase64(fileField) → string`
Read a file column → base64. Max 10 MB.

```dsl
var b64 = getFileBase64([attachment])
var posted = callApi('https://upload.example.com', 'POST', { 'Content-Type': 'application/json' }, JSON.stringify({ file: b64 }))
```

#### `getFileUrl(fileField) → string`
Time-limited signed download URL (typically 15-min TTL).

```dsl
var url = getFileUrl([signed_contract])
notify([approver_id], 'Contract ready: ' + url)
```

#### `getFileInfo(fileField) → object`
Returns `{ storagePath, fileName, mimeType, fileSize, extension, kind }`.

```dsl
var info = getFileInfo([receipt])
if (info.fileSize > 5 * 1024 * 1024) { error('Receipt larger than 5 MB') }
if (info.mimeType != 'application/pdf') { error('Receipt must be PDF') }
```

#### `download(url, fileName?)`
Set HTTP download response. Only valid in UI-triggered actions; the user's browser receives the file.

```dsl
execute:
    var url = getFileUrl([signed_invoice])
    download(url, 'invoice-' + [invoice_number] + '.pdf')
```

### Configuration & secrets

#### `getSetting(settingCd) → any`
Folder-scoped module setting — walks the folder inheritance chain up to the module default.

```dsl
var prefix = getSetting('invoice_number_prefix')  # e.g. "INV-"
var maxDays = getSetting('payment_due_days')      # e.g. 30
[due_date] = addDays(now(), maxDays)
```

#### `getSecret(secretCd) → string`
Decrypt a module-level secret (API key, password, etc.).

```dsl
var apiKey = getSecret('stripe_api_key')
callApi('https://api.stripe.com/v1/charges', 'POST', { Authorization: 'Bearer ' + apiKey }, body)
```

#### `nextNumber(entityCd) → string`
Generate next document number per the entity's `numberSequence` config. Mostly used for **pre-generating** numbers before insert (e.g. for an audit/messaging trail). On INSERT, the platform auto-generates when the target column is empty — no manual call needed there.

```dsl
execute:
    var poNum = nextNumber('purchase_order')
    notify([approver_id], 'PO ' + poNum + ' awaiting your approval')
    insert('purchase_order', { po_number: poNum, status: 'pending_approval', supplier_id: params[supplier].supplier_id })
```

For cross-module: `nextNumber('fin.invoice')`.

### External integration

#### `callApi(url, method, headers?, body?) → string`
HTTP request. Returns response body as string. JSON parsing is your responsibility.

```dsl
var resp = callApi(
    'https://api.weather.gov/points/' + [latitude] + ',' + [longitude],
    'GET',
    { 'Accept': 'application/json' }
)
var data = JSON.parse(resp)
[forecast_url] = data.properties.forecast
```

#### `callService(name, args?) → any`
Invoke a C#-registered DSL service (escape hatch for things the platform exposes but the DSL doesn't have a built-in for). Service signatures live in `dForge.Engine`'s service registry.

```dsl
var result = callService('studio.validate', { module_cd: [module_cd] })
if (!result.isValid) { error('Validation failed: ' + result.errors[0]) }
```

### Utility

#### `flush()`
Commit pending changes mid-script AND broadcast SSE updates to connected clients. **Async / background actions only** — in sync actions, everything commits at the end automatically.

```dsl
# Long-running background job that wants to surface progress
execute:
    var total = records.count()
    var done = 0
    for rec in records {
        rec[processed_at] = now()
        done = done + 1
        if (done % 100 == 0) { flush() }   # progress update every 100 records
    }
```

#### `tryParseJson(value) → any | null`
Parse JSON safely. Returns `null` on parse failure (vs `JSON.parse` which throws).

```dsl
var meta = tryParseJson([metadata_json])
if (meta != null && meta.priority == 'high') { notify([owner_id], 'High priority') }
```

---

## JavaScript subset

Esprima parses ES5; Jint executes.

**Supported control flow:** `if / else`, `for`, `while`, `do...while`, `switch / case / default / break / continue`, `return` (only inside `function`), `try / catch / finally`, `throw`.

**Supported declarations:** `var`, `function`. (No `let`, no `const`.)

**Operators:** all standard arithmetic / comparison / logical / assignment, including ternary `? :`.

**Object & array literals:** `{ key: value }`, `[a, b, c]`. Property access `obj.prop` and `obj['prop']`. Array indexing `arr[i]`.

**Standard library exposed by Jint:** `Math.*`, `JSON.parse` / `JSON.stringify`, `Date`, `Array.prototype.*` (map / filter / forEach / reduce / etc.), `parseInt`, `parseFloat`, `isNaN`, `isFinite`, `console.log` (logged to server stderr).

**NOT supported:** `let`, `const`, arrow functions (`=>`), `async` / `await`, destructuring (`const {a,b} = obj`), spread (`...`), template-literal-tagged calls, ES6+ class syntax, optional chaining (`?.`), nullish coalescing (`??`).

**SQL-style literals auto-rewritten** (for filter-string compatibility): `NULL → null`, `TRUE → true`, `FALSE → false`.

---

## Common patterns

### 1. Validation + early-success exit

```dsl
canExecute:
    [status] == 'new'

execute:
    if ([rating] == null || [rating] < 3) {
        exit('Skipped — not high-priority', 'info')
    }
    [status] = 'reviewed'
    info('Marked as reviewed')
```

### 2. Insert child + reference parent

```dsl
params:
    note_text: textarea required "Note"

execute:
    var note = insert('activity_note', {
        parent_id: [id],
        parent_entity: 'opportunity',
        note: params[note_text],
        author_id: [created_by]
    })
    info('Added note ' + note.activity_note_id)
```

### 3. Cross-entity query + loop

```dsl
canExecute:
    [report_date] != null

execute:
    var prevDate = addDays([report_date], -1)
    var prev = query(
        'SELECT entry_id, estimate_hours FROM pm.time_entry WHERE report_date = @d',
        { d: prevDate }
    )
    if (prev.length == 0) {
        exit('No previous entries found', 'warning')
    }
    for (var i = 0; i < prev.length; i++) {
        insert('time_entry', {
            user_id: [user_id],
            report_date: [report_date],
            hours: prev[i].estimate_hours
        })
    }
    info('Copied ' + prev.length + ' entries from ' + prevDate)
```

### 4. Batch action with loop + count message

```dsl
execute:
    for rec in records {
        rec[status] = 'closed'
        rec[closed_date] = now()
        rec[closed_by] = [current_user_id]
    }
    info('Closed ' + records.count() + ' item(s)')
```

### 5. Settings-driven behavior

```dsl
execute:
    var threshold = getSetting('high_value_threshold')   # e.g. 10000
    var ccApprover = getSetting('cc_approver_user_id')
    if ([amount] >= threshold && ccApprover != null) {
        notify(ccApprover, 'Large order requires your CC approval: $' + [amount])
        [requires_cc_approval] = true
    }
    [status] = 'pending_approval'
```

### 6. Sequential status workflow with audit

```dsl
canExecute:
    [status] == 'draft'

execute:
    insert('status_history', {
        entity_id: [id],
        from_status: [status],
        to_status: 'submitted',
        changed_by: [current_user_id],
        changed_at: now()
    })
    [status] = 'submitted'
    [submitted_at] = now()
    notify([approver_id], 'Request ' + [request_number] + ' awaiting approval')
```

### 7. Aggregating across child records (manual sum)

```dsl
execute:
    var lines = query(
        'SELECT qty, unit_price FROM po_line WHERE po_id = @id',
        { id: [id] }
    )
    var subtotal = 0
    for (var i = 0; i < lines.length; i++) {
        subtotal = subtotal + (lines[i].qty * lines[i].unit_price)
    }
    [subtotal] = subtotal
    [tax] = subtotal * getSetting('default_tax_rate')
    [total] = [subtotal] + [tax]
```

(For frequent recomputation, prefer a Formula column over an action — formulas evaluate automatically.)

### 8. Conditional FK creation (find-or-create)

```dsl
params:
    customer_name: text required "Customer Name"

execute:
    var existing = query(
        'SELECT customer_id FROM crm.customer WHERE name = @n',
        { n: params[customer_name] }
    )
    var cid
    if (existing.length > 0) {
        cid = existing[0].customer_id
    } else {
        var c = insert('customer', { name: params[customer_name], is_active: true })
        cid = c.customer_id
        info('Created new customer: ' + params[customer_name])
    }
    [customer_id] = cid
```

### 9. Email with template + computed body

```dsl
execute:
    var items = query(
        'SELECT description, qty, unit_price FROM order_line WHERE order_id = @oid',
        { oid: [id] }
    )
    var total = 0
    for (var i = 0; i < items.length; i++) {
        total = total + items[i].qty * items[i].unit_price
    }
    sendEmail([customer_id].[email], 'order_confirmation', {
        customerName: [customer_id].[name],
        orderNumber: [order_number],
        items: items,
        total: total,
        shipBy: addDays(now(), 3)
    })
    [confirmation_sent_at] = now()
```

### 10. File processing + validation

```dsl
execute:
    var info = getFileInfo([receipt])
    if (info == null) { error('Receipt is required') }
    if (info.fileSize > 5 * 1024 * 1024) { error('Receipt larger than 5 MB') }
    if (info.mimeType != 'application/pdf' && info.mimeType != 'image/png') {
        error('Receipt must be PDF or PNG')
    }
    [receipt_uploaded_at] = now()
    [receipt_size_bytes] = info.fileSize
```

### 11. Notification fan-out to role members

```dsl
execute:
    var managers = query(
        'SELECT u.user_id FROM auth.user u ' +
        'JOIN dForge.user_role ur ON ur.user_id = u.user_id ' +
        'WHERE ur.role_cd = @role AND u.is_active = true',
        { role: 'pm.manager' }
    )
    for (var i = 0; i < managers.length; i++) {
        notify(managers[i].user_id, 'New high-priority project: ' + [project_name])
    }
```

### 12. Soft-delete (when entity has `soft-delete` trait)

```dsl
canExecute:
    [is_deleted] != true

execute:
    [is_deleted] = true
    [deleted_at] = now()
    [deleted_by] = [current_user_id]
    info('Item moved to trash. Restore via "Undelete" action.')
```

---

## Anti-patterns — what breaks at install or runtime

### ❌ Using `[field]` in batch mode

```dsl
# WRONG — batch mode has no "current record"
execute:
    for rec in records {
        [status] = 'closed'    # ← this references the dispatch context, not rec
    }
```

```dsl
# RIGHT
execute:
    for rec in records {
        rec[status] = 'closed'
    }
```

### ❌ Using `[field]` in a scheduled-job action

Jobs run as system user with no record context. The action must be entity-agnostic.

```dsl
# WRONG — fails at runtime with "no record context"
execute:
    if ([overdue_count] > 0) { notify([owner_id], 'Overdue') }
```

```dsl
# RIGHT — fetch what you need via query
execute:
    var overdue = query('SELECT owner_id, COUNT(*) AS n FROM invoice WHERE due_date < CURRENT_DATE GROUP BY owner_id', {})
    for (var i = 0; i < overdue.length; i++) {
        notify(overdue[i].owner_id, 'You have ' + overdue[i].n + ' overdue invoice(s)')
    }
```

### ❌ Top-level `return`

The DSL body is not wrapped in an IIFE — `return` at top level is a parse error.

```dsl
# WRONG
execute:
    if ([status] == 'closed') { return }
    [last_touched] = now()
```

```dsl
# RIGHT — use exit() for early success, error() for early failure
execute:
    if ([status] == 'closed') { exit('Already closed', 'info') }
    [last_touched] = now()
```

### ❌ Assuming `error()` skips work done above

`error()` rolls back the **entire transaction** including prior `insert()` calls. Don't use it to "log and continue" — it's a hard abort.

```dsl
# WRONG — the insert below is rolled back when error fires
execute:
    insert('audit_log', { event: 'attempted_close', record_id: [id] })   # rolled back!
    if ([balance_due] > 0) { error('Cannot close — balance owing') }
```

```dsl
# RIGHT — validate first, then perform side-effects
execute:
    if ([balance_due] > 0) { error('Cannot close — balance owing') }
    insert('audit_log', { event: 'closed', record_id: [id] })
    [status] = 'closed'
```

### ❌ Calling `nextNumber()` then manually setting the field on insert

The platform auto-generates the number on INSERT when the target column is empty. Manual `nextNumber()` + manual field-set risks double-allocating sequence values if you forget to leave the field blank.

```dsl
# WRONG — wastes a sequence value
execute:
    var n = nextNumber('purchase_order')
    var po = insert('purchase_order', { po_number: n, ... })   # gets a DIFFERENT auto-number, n is wasted
```

```dsl
# RIGHT — let INSERT generate it
execute:
    var po = insert('purchase_order', { supplier_id: params[supplier].supplier_id })
    info('Created PO ' + po.po_number)   # po_number was auto-populated
```

Only use `nextNumber()` explicitly when you need the number BEFORE insert (e.g. to mention in a notification or message).

### ❌ Heavy work in a sync action without `flush()`

Sync actions block the UI until they finish. A 30-second action freezes the user's browser. For >1s work, either:
- Mark the action `background: true` and call `flush()` periodically for progress
- Move heavy lifting to a stored procedure called via `callProc()`

### ❌ String-concatenating into SQL

```dsl
# WRONG — injection-vulnerable + breaks on quotes
var q = query('SELECT * FROM customer WHERE name = ' + "'" + params[name] + "'", {})
```

```dsl
# RIGHT — use named placeholders
var q = query('SELECT * FROM customer WHERE name = @n', { n: params[name] })
```

### ❌ Forgetting to bump `[updated_at]` on writes

The `audit` trait auto-maintains `last_updated` on INSERT/UPDATE if the column exists, but only via the standard data-access path. Direct `[field] = value` writes from DSL trigger the same path, so `last_updated` updates correctly. (No action needed — listed here as reassurance.)

---

## Quick reference card

| Need to… | Use |
|---|---|
| Read current record's field | `[fieldName]` |
| Write current record's field | `[fieldName] = value` |
| Navigate FK | `[fkField].[targetField]` |
| Read DSL param | `params[paramName]` |
| Read FK param's field | `params[paramName].targetField` |
| Loop batch selection | `for rec in records { rec[field] }` |
| Count batch selection | `records.count()` |
| Validate + abort | `error('reason')` |
| Done early, commit | `exit('msg', 'info')` |
| Insert + use returned record | `var x = insert(entity, {...}); x.pk_id` |
| Run SQL | `query('SELECT ... WHERE c = @v', { v: value })` |
| Get setting | `getSetting('setting_cd')` |
| Send toast | `info('msg')`, `warn('msg')` |
| Send email | `sendEmail(to, subj, body)` or `sendEmail(to, templateCd, dataObj)` |
| Send inbox notification | `notify(userId, 'msg')` |
| Add days | `addDays(date, n)` |
| Now | `now()` |

---

## See also

- `dforge://schema/entity` — field types and column flags referenced in `params:` declarations
- `dforge://schema/jobs` — scheduled job → action binding (note the no-record-context caveat above)
- `dforge://docs/conventions` — broader module structure, FK+Reference pattern, traits, security model
