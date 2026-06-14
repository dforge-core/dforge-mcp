# Action DSL Reference

Actions are dForge's business logic. They are scripts with three declarative blocks (`params:`, `canExecute:`, `execute:`) where the `execute:` block uses **JavaScript syntax** executed server-side via the Jint engine, with platform-provided global functions.

Lives in: `logic/actions/<action_name>.dsl`
Registered in: `ui/actions.json`

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
| `query('SQL', { arg: value })` | Array of row objects | Execute parameterized SQL. Use `@argName` placeholders. Schema-qualified table names (`crm.contact`). Access row fields with `row.field_name` or `row['field_name']`. |
| `getRecord('entity', id)` | Row object | Fetch a single record by primary key. |
| `preloadRef('fk_column')` | Row object | Load the referenced record for a FK column. Access its fields with `ref.get('field')`. |

### Messaging

| Function | Description |
|---|---|
| `error('message')` | **Abort** the action and show an error to the user. Rolls back all changes. |
| `warn('message')` | Show a warning but continue execution. |
| `info('message')` | Show an informational message. |
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

### Utilities

| Function | Returns | Description |
|---|---|---|
| `now()` | DateTime | Current date/time. Use for `date`, `datetime`, and `timestamp` fields. **Lowercase** — this is the execute-block date function. |
| `IF(condition, trueVal, falseVal)` | Any | Ternary helper. |
| `addDays(date, n)` | Date | Add `n` days to a date, e.g. `addDays(now(), 30)`. |
| `nextNumber('entity')` | String | Generate next value from a number sequence. Usually not needed — platform auto-fills on `insert()`. Use for pre-generating numbers. |
| `callProc('proc_name', { args })` | Result | Call a stored procedure. Args are passed as named parameters. |

> **Dates: `now()` in `execute:`, `TODAY()`/`NOW()` in formulas.** The `execute:` block runs as
> JavaScript (Jint) and exposes **lowercase `now()`** only — `TODAY()` and `NOW()` (uppercase) are
> **formula-engine** functions and are **undefined in `execute:`** (using them throws
> `'TODAY' is not defined` at install). Use `TODAY()`/`NOW()` only in `canExecute:`, formula
> columns, and other formula contexts; use `now()` everywhere inside `execute:`. (Uppercase `NOW()`
> is also fine *inside a raw SQL string* passed to `query()`, because that's SQL, not JS.)

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
| `isTransacted` | Recommended | `true` = all changes roll back on error; `false` = partial commits possible |
| `orderNum` | Recommended | Display order in the action menu |
| `isAsync` | Optional | `true` = runs in background via Hangfire, user gets completion notification |

## SQL in query() — important notes

1. **Table names are schema-qualified** within the module: `crm.contact`, `wms.stock_movement`, `fin.invoice`. Use the module code as the schema prefix.
2. **Use `@param` placeholders** for values — NEVER concatenate user input into SQL strings. The engine auto-parameterizes.
3. **SELECT, INSERT, UPDATE, DELETE all work** via `query()`. For reads, it returns row arrays. For writes, it executes the statement.
4. **`insert()` is preferred over `query('INSERT ...')`** for inserting into module entities — it handles auto-fill (PKs, audit, number sequences). Use raw `query('INSERT ...')` only for cross-module or system tables.

## Common mistakes

- Writing `params.note` instead of `params[note]` — **wrong**. Use bracket syntax for params.
- Writing `params["note"]` — **also wrong in DSL syntax**. Use `params[note]` without quotes.
- Writing `update [status] = 'Draft'` (declarative style) — **wrong**. Use `[status] = 'Draft'` (assignment).
- Writing `insert('entity', field1, value1)` (positional args) — **wrong**. Use `insert('entity', { field: value })` (object).
- Writing `query('entity', filter)` (filter object) — **wrong**. `query()` takes raw SQL strings with `@param` placeholders.
- Forgetting `var` in loops — `for (i = 0; ...)` creates a global. Always `for (var i = 0; ...)`.
- Using ES6 syntax (`const`, `let`, `=>`, template literals) — **may not work**. Jint supports ES5.1 primarily. Stick to `var`, `function`, string concatenation with `+`.
- Calling `TODAY()` or `NOW()` (uppercase) inside `execute:` — **wrong**, they're undefined there and install fails with `'TODAY' is not defined`. Use lowercase **`now()`** in `execute:`; `TODAY()`/`NOW()` are formula-only (`canExecute:`, formula columns).
- Forgetting that `insert()` returns the full row — you can use `quote.quote_id` immediately after insert.
- Using `[field]` inside a `query()` SQL string — **wrong**. `[field]` is resolved in JS scope, not inside SQL strings. Pass values as `@param` arguments.

## Internal API (advanced)

The platform globals (`insert()`, `query()`, `error()`, etc.) are sugar on top of an internal API: `__ctx.insert()`, `__ctx.query()`, `__ctx.error()`, `__r.get('field')`, `__r.set('field', value)`. Both forms work in DSL scripts. The bare form (without `__ctx.` / `__r.`) is preferred for readability.
