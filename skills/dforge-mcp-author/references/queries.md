# Pre-Built Queries Reference

Modules can ship **pre-built saved queries** — lightweight, explorable analytics that appear in the Query Builder alongside user-created queries. Think of them as "light reports" that are easier to author than full reports.

Lives in: `ui/queries.json`

## When to use queries vs reports vs views

| Need | Use |
|---|---|
| Show entity records with filters/sort | **Data view** (`ui/data_views.json`) |
| Simple aggregation — "totals by X" | **Pre-built query** (`ui/queries.json`) |
| Ad-hoc exploration by the user | **Query Builder** (runtime, no module authoring needed) |
| Complex multi-dataset visualizations with charts/KPIs | **Report** (`ui/reports.json`) |
| Full SQL with window functions, CTEs, cross-schema | **Report with stored procedure** |

Queries fill the gap between views (flat, no aggregation) and reports (heavy, need layout config).

## Structure

```json
{
    "overdue_invoices": {
        "name": "Overdue Invoices",
        "description": "All invoices past due date, not yet paid",
        "entityCode": "invoice",
        "query": {
            "entityCd": "invoice",
            "columns": [
                "invoice_number",
                "customer",
                "total_amount",
                "amount_due",
                "due_date",
                "days_overdue",
                "owner_id"
            ],
            "filter": {
                "g": "and",
                "i": [
                    { "c": "status", "o": "!=", "v": "Paid" },
                    { "c": "status", "o": "!=", "v": "Cancelled" },
                    { "c": "due_date", "o": "f", "v": { "fn": "isPast" } }
                ]
            },
            "sort": [
                { "c": "days_overdue", "d": "desc" }
            ]
        }
    },
    "revenue_by_customer": {
        "name": "Revenue by Customer",
        "description": "Total invoiced revenue grouped by customer",
        "entityCode": "invoice",
        "query": {
            "entityCd": "invoice",
            "columns": [
                { "c": "customer", "agg": "group", "alias": "Customer" },
                { "c": "total_amount", "agg": "sum", "alias": "Total Revenue" },
                { "c": "invoice_number", "agg": "count", "alias": "Invoice Count" }
            ],
            "filter": {
                "c": "status", "o": "!=", "v": "Cancelled"
            },
            "sort": [
                { "c": "total_amount", "d": "desc" }
            ]
        }
    }
}
```

## Query JSON format

The `query` object uses the **exact same format** as the Query Builder produces at runtime. This means you can:
1. Design a query in the Query Builder UI
2. Copy the JSON
3. Paste it into `queries.json`

### Flat mode (no aggregation)

```json
{
    "entityCd": "contact",
    "columns": ["first_name", "last_name", "email", "account", "owner_id"],
    "filter": { "c": "email", "o": "!null" },
    "sort": [{ "c": "last_name", "d": "asc" }]
}
```

Columns are plain strings — field codes or reference paths (`"account.name"`, `"project.client.short_name"`).

### Grouped mode (with aggregation)

```json
{
    "entityCd": "opportunity",
    "columns": [
        { "c": "stage", "agg": "group", "alias": "Stage" },
        { "c": "owner_id", "agg": "group", "alias": "Owner" },
        { "c": "total_amount", "agg": "sum", "alias": "Total Value" },
        { "c": "opportunity_id", "agg": "count", "alias": "Deal Count" },
        { "c": "total_amount", "agg": "avg", "alias": "Avg Deal Size" }
    ],
    "filter": {
        "c": "stage", "o": "!in", "v": ["Closed Won", "Closed Lost"]
    },
    "sort": [{ "c": "total_amount", "d": "desc" }]
}
```

In grouped mode, each column is an object with:
- `c` — column code (or reference path)
- `agg` — aggregation: `group` (dimension), `sum`, `count`, `avg`, `min`, `max`
- `alias` — display name for the result column

At least one column must be `"agg": "group"` and at least one must be an aggregate.

### Reference paths in columns

Columns can traverse references up to 2 levels deep:

```json
"columns": [
    "invoice_number",
    "customer.account_name",
    "customer.industry",
    "owner_id"
]
```

The query engine automatically JOINs the referenced entities.

### Filters

Filters use the standard JSON filter format (see `references/filters.md`): `{ "c": column, "o": operator, "v": value }`.

### Dynamic date and user filters (function operator)

Instead of hardcoded date values, use the **function operator** `"f"` with a `{ "fn": "..." }` value. This evaluates at query time on the server.

**A function IS the whole condition — it bakes in the comparison.** You cannot pass a function as the value of `<`, `>`, `=`, `!=`, `between`, etc. Functions are ONLY valid with the `"o": "f"` operator, and each function encodes its own comparison logic (for example, `isPast` already means `column < NOW()`).

| Function | Applies to | Description |
|---|---|---|
| `isToday` | date, timestamp | Current date |
| `isYesterday` | date, timestamp | Previous day |
| `isThisWeek` | date, timestamp | Current ISO week |
| `isThisMonth` | date, timestamp | Current month |
| `isThisYear` | date, timestamp | Current year |
| `isPast` | date, timestamp | Before now |
| `isFuture` | date, timestamp | After now |
| `isCurrentUser` | guid | Matches the logged-in user |

**Example — overdue items (due date is in the past):**

```json
{ "c": "due_date", "o": "f", "v": { "fn": "isPast" } }
```

**Example — records created this month:**

```json
{ "c": "created_date", "o": "f", "v": { "fn": "isThisMonth" } }
```

**Example — assigned to current user:**

```json
{ "c": "owner_id", "o": "f", "v": { "fn": "isCurrentUser" } }
```

### Sort

```json
"sort": [
    { "c": "total_amount", "d": "desc" },
    { "c": "customer", "d": "asc" }
]
```

`d` is direction: `"asc"` or `"desc"`.

## Wrapper properties

Each query in `queries.json` has:

| Property | Required | Description |
|---|---|---|
| `name` | Yes | Display name in the query list |
| `description` | Recommended | Help text |
| `entityCode` | Yes | The root entity this query targets |
| `query` | Yes | The query JSON (flat or grouped format above) |

## Menu integration

Queries are not in menu and not integrated into menu, they have separate section in sidebar, nothing need to be configured additionally.

## Translations

Query names and descriptions are translated in `translations/en-US.json`:

```json
{
    "queries": {
        "overdue_invoices": {
            "name": "Overdue Invoices",
            "description": "All invoices past due date, not yet paid"
        },
        "revenue_by_customer": {
            "name": "Revenue by Customer",
            "description": "Total invoiced revenue grouped by customer"
        }
    }
}
```

## Manifest declaration

```json
{
    "queries": "./ui/queries.json"
}
```

## Example queries for common module types

### CRM — Pipeline by stage and owner
```json
{
    "entityCd": "opportunity",
    "columns": [
        { "c": "stage", "agg": "group", "alias": "Stage" },
        { "c": "owner_id", "agg": "group", "alias": "Owner" },
        { "c": "total_amount", "agg": "sum", "alias": "Total Value" },
        { "c": "opportunity_id", "agg": "count", "alias": "Count" }
    ],
    "sort": [{ "c": "total_amount", "d": "desc" }]
}
```

### HR — Headcount by department
```json
{
    "entityCd": "employee",
    "columns": [
        { "c": "department", "agg": "group", "alias": "Department" },
        { "c": "employee_id", "agg": "count", "alias": "Headcount" },
        { "c": "salary", "agg": "avg", "alias": "Avg Salary" }
    ],
    "filter": { "c": "status", "o": "=", "v": "Active" },
    "sort": [{ "c": "employee_id", "d": "desc" }]
}
```

### Finance — Receivables aging summary
```json
{
    "entityCd": "invoice",
    "columns": [
        "invoice_number",
        "customer",
        "total_amount",
        "amount_due",
        "due_date",
        "days_overdue",
        "status"
    ],
    "filter": {
        "g": "and",
        "i": [
            { "c": "status", "o": "!in", "v": ["Paid", "Cancelled"] },
            { "c": "amount_due", "o": ">", "v": 0 }
        ]
    },
    "sort": [{ "c": "days_overdue", "d": "desc" }]
}
```

### WMS — Low stock items
```json
{
    "entityCd": "stock",
    "columns": [
        "product",
        "warehouse",
        "quantity",
        "reserved_qty",
        "available_qty"
    ],
    "filter": { "c": "available_qty", "o": "<", "v": 10 },
    "sort": [{ "c": "available_qty", "d": "asc" }]
}
```

## Rules

- The `query` object must use the same JSON format as the Query Builder produces.
- Filters use the standard `c`/`o`/`v` format (see `references/filters.md`).
- Module queries are **read-only** for users — they can run them and "Copy to My Queries" to modify.
- Security is automatic — the query execution path respects entity, column, and row-level security.
- Grouped queries need at least one `"agg": "group"` column and one aggregate column.
- Reference paths go up to 2 levels deep (e.g. `"customer.country"` works, deeper may not).

## Common mistakes

- Putting SQL in the `query` object — **wrong**. Queries use the JSON format, not raw SQL. For raw SQL, use stored procedures in reports.
- Using `"column"` instead of `"c"` in columns/filters — **wrong**. Use the short keys.
- Forgetting `"agg"` on columns in grouped mode — every column needs an aggregation assignment.
- Referencing columns from unrelated entities — queries can only traverse the root entity's references.
- Using `@TODAY`, `@CURRENT_USER`, or any `@placeholder` syntax in filter values — **wrong**. Queries do not support parameter substitution. Use the function operator instead: `{ "c": "due_date", "o": "f", "v": { "fn": "isPast" } }`.
- Using a function as the value of a comparison operator (`<`, `>`, `=`, `!=`, `between`) — **wrong**. Functions are standalone conditions, valid only with `"o": "f"` (full detail + examples under "Dynamic date and user filters" above). `{ "c": "due_date", "o": "<", "v": { "fn": "isToday" } }` is invalid; use `{ "c": "due_date", "o": "f", "v": { "fn": "isPast" } }`.
