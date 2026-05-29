# Formula Engine Reference

Formulas are used in:

- **Formula columns** (`columnType: "F"`) — computed values
- **Action `canExecute:` blocks** — availability checks
- **Default values** — e.g. `default: TODAY()`
- **Filter expressions** (partially)
- **Validation expressions** (partially)

The same grammar applies everywhere.

## Basic syntax

- **Field references**: `[column_name]` — the value of another column on the same entity
- **Navigation**: `[reference_column].[field]` — traverse a reference to a related entity's field
- **Literals**: numbers (`42`, `3.14`), strings (`'hello'` or `"hello"`), booleans (`true`, `false`), null (`null`)
- **Operators**: `+`, `-`, `*`, `/`, `%`, `==`, `!=`, `<`, `>`, `<=`, `>=`, `AND`, `OR`, `NOT`
- **Function calls**: `FUNCTION_NAME(arg1, arg2, ...)` — uppercase by convention
- **Parentheses** for grouping

## Examples

```
[first_name] + ' ' + [last_name]

[quantity] * [unit_price]

[account].[name]

[account].[billing_address].[country]

[status] == "active" AND [balance] > 0

CASE([priority], "high", 3, "medium", 2, "low", 1, 0)

IF([total] > 1000, "large", "small")

COALESCE([nickname], [first_name], "Unknown")

FORMAT([created_date], "yyyy-MM-dd")
```

## Built-in functions

### String functions

- `CONCAT(a, b, ...)` — concatenate strings
- `LEN(s)` — string length
- `UPPER(s)`, `LOWER(s)` — case conversion
- `TRIM(s)`, `LTRIM(s)`, `RTRIM(s)` — whitespace removal
- `SUBSTRING(s, start, len)` — substring
- `REPLACE(s, find, with)` — replace substring
- `CONTAINS(s, find)` — boolean substring check
- `STARTSWITH(s, prefix)`, `ENDSWITH(s, suffix)` — boolean
- `FORMAT(value, pattern)` — format dates/numbers

### Number functions

- `ABS(n)`, `ROUND(n, digits)`, `FLOOR(n)`, `CEIL(n)`, `CEILING(n)`
- `MIN(a, b)`, `MAX(a, b)` — binary min/max
- `POW(base, exp)`, `SQRT(n)`
- `MOD(a, b)` — modulo

### Date functions

- `TODAY()` — current date
- `NOW()` — current datetime with timezone
- `YEAR(d)`, `MONTH(d)`, `DAY(d)` — date parts
- `HOUR(dt)`, `MINUTE(dt)`, `SECOND(dt)` — time parts
- `DATEADD(d, count, unit)` — add time (unit: `day`, `month`, `year`, `hour`, `minute`)
- `DATEDIFF(a, b, unit)` — difference between dates

### Logical functions

- `IF(cond, then, else)` — ternary
- `CASE(expr, val1, result1, val2, result2, ..., default)` — multi-branch
- `COALESCE(a, b, c, ...)` — first non-null
- `NULLIF(a, b)` — null if equal, else a
- `ISNULL(x)` — boolean null check

### Aggregation (on set columns)

- `COUNT([set_column])` — count related rows (if the formula engine supports aggregation in your version)
- `SUM([set_column].[field])` — sum over a set
- `AVG`, `MIN`, `MAX` similarly

**Note**: set aggregation may not be fully implemented in all dForge versions. Ask the user to confirm before relying on it.

## Navigation (dot notation)

`[reference].[field]` traverses a reference column to a target entity:

```
[account].[name]                         -- contact's account's name
[owner].[email]                          -- owner user's email
[account].[primary_contact].[phone]      -- chained
```

Navigation works through `columnType: "R"` columns (reference columns). Chains of length 1 are **synchronous** and resolved instantly. Chains of length ≥ 2 are **asynchronous** — the formula engine resolves them after the initial data load.

## Sync vs async formulas

- **Sync formula**: pure local math, no navigation, or one-level navigation that can be JOINed. Evaluated on load and on every edit to a dependency.
- **Async formula**: multi-hop navigation. Evaluated after the initial data load, re-evaluated when dependencies change.

You don't declare which is which — the engine detects it from the formula's AST.

## Setting references

In modules that use settings, formulas can reference setting values with `$[SettingName]` syntax:

```
[total] * $[VAT_Rate]
```

## Validation and CHECK constraints

Check constraints use a subset of the formula grammar. The server parses them to AST and converts to SQL. Common patterns:

```
[quantity] > 0
[end_date] >= [start_date]
[email] LIKE '%@%'
```

## Examples — full formula columns

### Full name

```json
"full_name": {
    "columnType": "F",
    "fieldTypeCd": "text",
    "baseDatatypeCd": "string",
    "flags": "V",
    "orderNum": 25,
    "formula": "[first_name] + ' ' + [last_name]",
    "description": "Full Name"
}
```

### Line total (quantity × price)

```json
"line_total": {
    "columnType": "F",
    "fieldTypeCd": "currency",
    "baseDatatypeCd": "number",
    "flags": "V",
    "orderNum": 60,
    "formula": "[quantity] * [unit_price]",
    "description": "Line Total"
}
```

### Customer country (via navigation)

```json
"customer_country": {
    "columnType": "F",
    "fieldTypeCd": "text",
    "baseDatatypeCd": "string",
    "flags": "V",
    "orderNum": 70,
    "formula": "[account].[billing_country]",
    "description": "Customer Country"
}
```

### Days since created

```json
"days_open": {
    "columnType": "F",
    "fieldTypeCd": "number",
    "baseDatatypeCd": "number",
    "flags": "V",
    "orderNum": 200,
    "formula": "DATEDIFF([created_date], NOW(), 'day')",
    "description": "Days Open"
}
```

## Common mistakes

- Using `column_name` without brackets — **wrong**. Always `[column_name]`.
- Inventing functions like `HAS_PERMISSION()`, `IS_ADMIN()`, `GET_USER()` — **do not exist**. Do not use unless confirmed to exist in the actual dForge engine.
- Using JavaScript syntax like `row.field` or `this.field` — **wrong**. Only `[field]`.
- Forgetting `baseDatatypeCd` on formula columns — **required**. Without it, filters and SQL don't work.
- Using SQL syntax like `SELECT`, `JOIN`, `WHERE` — **wrong**. Formulas are expressions, not queries.
- String concatenation with commas — **wrong**. Use `+` or `CONCAT()`.

## Reference

This file covers the most common formula functions and patterns. If you encounter an edge case not covered here, ask the user to check their dForge version's formula documentation.
