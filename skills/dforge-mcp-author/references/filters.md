# Filter Format Reference

dForge uses **one canonical JSON filter format everywhere** — folder row filters, data view filters, API filters, report dataset filters, and user ad-hoc filters. Learn it once, use it everywhere.

This is the single filter format used across the entire dForge platform.

## Basic structure

A filter is either a **single condition** or a **group** of conditions.

### Condition — single comparison

```json
{ "c": "status", "o": "=", "v": "draft" }
```

| Key | Type | Description |
|---|---|---|
| `c` | string | Column code (field name on the entity) |
| `o` | string | Operator (see table below) |
| `v` | any | Value to compare against |

### Group — logical combination

```json
{
    "g": "and",
    "i": [
        { "c": "status", "o": "=", "v": "draft" },
        { "c": "amount", "o": ">", "v": 1000 }
    ]
}
```

| Key | Type | Description |
|---|---|---|
| `g` | string | Group operator: `and`, `or`, `!and` (NAND), `!or` (NOR) |
| `i` | array | Items — conditions and/or nested groups |

Groups can nest to arbitrary depth.

## Operators

### Condition operators

| Operator | Description | Example value |
|---|---|---|
| `=` or `eq` | Equal | `"draft"` |
| `!=` or `notEq` | Not equal | `"cancelled"` |
| `>` or `gr` | Greater than | `1000` |
| `>=` or `grEq` | Greater than or equal | `1000` |
| `<` or `less` | Less than | `100` |
| `<=` or `lessEq` | Less than or equal | `100` |
| `between` or `btw` | Between (inclusive) | `[100, 500]` |
| `!between` or `nBetween` | Not between | `[100, 500]` |
| `contains` | Contains substring | `"acme"` |
| `!contains` or `nContain` | Does not contain | `"test"` |
| `start` | Starts with | `"INV-"` |
| `!start` or `nStart` | Does not start with | `"DRAFT-"` |
| `end` | Ends with | `".pdf"` |
| `!end` or `nEnd` | Does not end with | `".tmp"` |
| `mask` | Pattern match (SQL LIKE) | `"INV-2025-%"` |
| `!mask` or `nMask` | Does not match pattern | `"TEST-%"` |
| `null` or `empty` | Is null/empty | _(no `v` needed)_ |
| `!null` or `nEmpty` | Is not null | _(no `v` needed)_ |
| `in` | In a set | `["draft", "pending"]` |
| `!in` or `nIn` | Not in a set | `["cancelled", "deleted"]` |
| `eqRef` | Equal to another column | `"other_column_cd"` |
| `f` | Function (dynamic runtime value) | `{ "fn": "isToday" }` |

### Function operator — dynamic runtime values

The function operator `f` evaluates a named function at query time instead of comparing against a static value. The value must be an object: `{ "fn": "<functionId>" }`.

| Function | Column types | Description |
|---|---|---|
| `isToday` | date, timestamp | `column = CURRENT_DATE` |
| `isYesterday` | date, timestamp | `column = CURRENT_DATE - 1` |
| `isThisWeek` | date, timestamp | Within current ISO week |
| `isThisMonth` | date, timestamp | Within current month |
| `isThisYear` | date, timestamp | Within current year |
| `isPast` | date, timestamp | `column < NOW()` |
| `isFuture` | date, timestamp | `column > NOW()` |
| `isCurrentUser` | guid | `column = <logged-in user ID>` |

```json
{ "c": "due_date", "o": "f", "v": { "fn": "isPast" } }
```

```json
{ "c": "owner_id", "o": "f", "v": { "fn": "isCurrentUser" } }
```

Function conditions require **no value input** — the function provides the comparison logic at runtime.

**Functions are valid only with the `f` operator.** They cannot be used as the value of `<`, `>`, `=`, `!=`, `between`, or any other comparison operator — each function already encodes its own comparison (e.g. `isPast` means "column < NOW()"). If you need to combine a dynamic-date check with another condition, put them as separate items in an `and`/`or` group:

```json
{
    "g": "and",
    "i": [
        { "c": "due_date", "o": "f", "v": { "fn": "isPast" } },
        { "c": "status", "o": "!=", "v": "done" }
    ]
}
```

These are **wrong** and will be rejected:

```json
{ "c": "due_date", "o": "<", "v": "@TODAY" }
{ "c": "due_date", "o": "<", "v": { "fn": "isToday" } }
```

### Group operators

| Operator | SQL equivalent |
|---|---|
| `and` | `A AND B AND C` |
| `or` | `A OR B OR C` |
| `!and` | `NOT (A AND B AND C)` — at least one is false |
| `!or` | `NOT (A OR B OR C)` — none are true |

## Where filters are used

### 1. Folder row filters (`ui/folders.json`)

Scope which records are visible in a subfolder. Used in `rowFilter` property on entity membership:

```json
"stock": {
    "viewName": "default",
    "quickAdd": true,
    "rowFilter": { "c": "warehouse_id", "o": "eq", "v": 2001 }
}
```

Generates: only stock records where `warehouse_id = 2001` appear in this folder.

For compound filters on a folder:

```json
"rowFilter": {
    "g": "and",
    "i": [
        { "c": "warehouse_id", "o": "eq", "v": 2001 },
        { "c": "status", "o": "!=", "v": "archived" }
    ]
}
```

### 2. Data view filters (`ui/data_views.json`)

Pre-filter which records appear in a data view:

```json
{
    "active_leads": {
        "viewType": "grid",
        "label": "Active Leads",
        "dataSources": [{
            "entityCode": "lead",
            "columns": ["name", "email", "stage", "owner_id"],
            "filter": {
                "g": "and",
                "i": [
                    { "c": "stage", "o": "!=", "v": "Closed Lost" },
                    { "c": "stage", "o": "!=", "v": "Converted" }
                ]
            },
            "sort": [{ "column_cd": "created_date", "direction": "desc" }]
        }]
    }
}
```

### 3. Report dataset filters

Same format inside report dataset definitions:

```json
"datasets": {
    "ds_pipeline": {
        "entityCode": "opportunity",
        "columns": ["stage", "total_amount"],
        "filter": {
            "g": "and",
            "i": [
                { "c": "stage", "o": "!in", "v": ["Closed Won", "Closed Lost"] },
                { "c": "total_amount", "o": ">", "v": 0 }
            ]
        },
        "groupBy": ["stage"],
        "aggregations": {
            "total_value": { "func": "sum", "column": "total_amount" }
        }
    }
}
```

### 4. API filters (`data.get` calls)

Same format passed as the `filter` parameter in RPC calls:

```json
{
    "method": "data.get",
    "params": {
        "entityCode": "contact",
        "filter": { "c": "account_id", "o": "=", "v": "some-uuid" },
        "columns": ["first_name", "last_name", "email"]
    }
}
```

### 5. Action DSL (`query()` is different!)

**Important**: the `query()` function in action DSL uses **raw parameterized SQL**, NOT the JSON filter format:

```javascript
// This is SQL, not a JSON filter
var results = query('SELECT * FROM crm.contact WHERE account_id = @accId AND status = @status', {
    accId: [account_id],
    status: 'active'
})
```

The JSON filter format is only used in **declarative contexts** (folders, views, reports, API calls). Action DSL uses SQL directly.

## Common examples

### Filter by status (single condition)

```json
{ "c": "status", "o": "=", "v": "active" }
```

### Exclude multiple statuses

```json
{ "c": "status", "o": "!in", "v": ["cancelled", "deleted", "archived"] }
```

### Date range

```json
{
    "g": "and",
    "i": [
        { "c": "created_date", "o": ">=", "v": "2026-01-01" },
        { "c": "created_date", "o": "<", "v": "2026-04-01" }
    ]
}
```

Or using `between`:

```json
{ "c": "amount", "o": "between", "v": [1000, 5000] }
```

### Non-null check

```json
{ "c": "email", "o": "!null" }
```

### String matching

```json
{ "c": "invoice_number", "o": "start", "v": "INV-2026-" }
```

### Complex: active records in sales or marketing

```json
{
    "g": "and",
    "i": [
        { "c": "is_active", "o": "=", "v": true },
        {
            "g": "or",
            "i": [
                { "c": "department", "o": "=", "v": "sales" },
                { "c": "department", "o": "=", "v": "marketing" }
            ]
        }
    ]
}
```

### Column-to-column comparison

```json
{ "c": "ship_date", "o": "eqRef", "v": "order_date" }
```

Generates: `WHERE ship_date = order_date`

## Filter composition at query time

All filter layers are **ANDed together** automatically:

```
Effective filter = folder_row_filter AND view_filter AND api_filter AND user_ad_hoc_filter
```

The user never sees a record unless it passes **all** layers. You don't need to duplicate folder filters in view filters — they compose automatically.

## Rules

- **`null` filter** (or omitted) means no filtering — show everything the user has access to.
- **Single condition** is valid without a group wrapper.
- Use **short operators** (`=`, `!=`, `>`) or **enum keys** (`eq`, `notEq`, `gr`) — both work.
- For folder `rowFilter` in module packages, prefer the short compact form: `{ "c": "...", "o": "eq", "v": ... }`.
- Dates are ISO strings: `"2026-01-01"`.
- Arrays for `in`/`between`: `["a", "b"]` or `[100, 500]`.

## Common mistakes

- Using the JSON filter format inside `query()` in DSL actions — **wrong**. `query()` uses raw SQL.
- Wrapping a single condition in a group unnecessarily — **valid but noisy**. A bare condition is fine.
- Using `"operator": "equals"` — **wrong**. Use `"o": "="` or `"o": "eq"`.
- Using `"column": "status"` — **wrong**. Use `"c": "status"`.
- Forgetting that `null` means "no filter" (not "filter by null") — to filter for null values, use `{ "c": "field", "o": "null" }`.
- Putting a `{ "fn": "..." }` object (or `@TODAY`/`@CURRENT_USER` placeholder) as the value of a normal comparison like `<`, `>`, `=` — **wrong**. Functions are standalone conditions that only work with `"o": "f"`.
