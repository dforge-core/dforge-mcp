# Formula Engine Reference

Formulas are used in:

- **Formula columns** (`columnType: "F"`) — computed values
- **Generated columns** (`columnType: "G"`) — stored aggregates / same-row expressions
- **Action `canExecute:` blocks** — availability checks
- **Default values** — a setting's `formula` (e.g. `"formula": "TODAY()"`) or a formula (`F`) column. Note: entity *data* columns have **no** `default`/`defaultValue` key — model a default with an `F` column or set it in action/trigger logic.
- **Trigger / webhook conditions** — single-expression `[field] op value` checks
- **Filter expressions** (partially)

> These are **formula** contexts: date helpers are uppercase `TODAY()` / `NOW()` here. Action
> `execute:` blocks are **not** a formula context — they run as JavaScript and use lowercase
> `now()` (see `action-dsl.md`).

The same grammar applies in every formula context.

> **The function and operator set below is exhaustive.** The engine recognizes exactly the
> functions and operators listed here (defined in the platform's formula runtime + parser) —
> nothing else. SQL functions (`FORMAT`, `MOD`, `NULLIF`, `ISNULL`, `LTRIM`, `CEILING`, …),
> JavaScript helpers, and invented functions (`HAS_PERMISSION`, `IS_ADMIN`, …) are **not**
> available and fail at install with a formula compile error. Check-constraint `expression`
> strings are the one exception — they are raw SQL, not formulas (see "CHECK constraints" below).

## Basic syntax

- **Field references**: `[column_name]` — the value of another column on the same entity
- **Navigation**: `[reference_column].[field]` — traverse a reference (`R`) column to a related entity's field
- **Literals**: numbers (`42`, `3.14`), strings (`'hello'` or `"hello"`), booleans (`true`, `false`), null (`null`)
- **Setting reference**: `$[SettingName]` — a folder-scoped module setting value
- **Function calls**: `FUNCTION_NAME(arg1, arg2, ...)` — names are uppercase by convention
- **Parentheses** for grouping

### Operators

| Category | Operators |
|---|---|
| Arithmetic | `+`  `-`  `*`  `/`  *(no `%` / modulo)* |
| Comparison | `=`  `!=`  `>`  `>=`  `<`  `<=`  *(equality is a single `=`, **never** `==`)* |
| Logical | `AND`  `OR`  `NOT` |
| String match | `CONTAINS`  `STARTS_WITH`  `ENDS_WITH` *(infix operators, not functions)* |
| Membership | `IN (a, b, ...)`  `NOT IN (a, b, ...)` |
| Range | `BETWEEN low AND high` |

`+` is overloaded: numeric addition when both sides are numbers, string concatenation when
either side is a string. `Date - Date` yields the difference **in days** (so
`TODAY() - [created_date]` is a day count).

The string-match and membership operators are **infix** — write `[name] STARTS_WITH 'A'` or
`[status] IN ('open', 'pending')`, not `STARTSWITH([name], 'A')`.

## Examples

```
[first_name] + ' ' + [last_name]

[quantity] * [unit_price]

[customer].[name]

[customer].[billing_address].[country]

[status] = 'active' AND [balance] > 0

[priority] IN ('high', 'urgent')

[code] STARTS_WITH 'INV-'

SWITCH([priority], 'high', 3, 'medium', 2, 'low', 1, 0)

CASE([score] >= 90, 'A', [score] >= 80, 'B', 'C')

IF([total] > 1000, 'large', 'small')

COALESCE([nickname], [first_name], 'Unknown')

TEXT(YEAR([created_date]))
```

## Built-in functions

The complete set. Anything not listed here does not exist in the formula engine.

### String functions

- `LEN(s)` — string length
- `UPPER(s)`, `LOWER(s)`, `TRIM(s)` — case / whitespace
- `CONCAT(a, b, ...)` — concatenate (null-safe; nulls become empty)
- `REPLACE(s, find, replacement)` — replace substring
- `LEFT(s, n)`, `RIGHT(s, n)` — leading / trailing substring
- `MID(s, start, len)`, `SUBSTRING(s, start, end?)` — substring
- `INDEX_OF(s, search)`, `LAST_INDEX_OF(s, search)` — position (number)
- `SPLIT(s, separator)` — split into an array

> Substring checks are the operators `CONTAINS` / `STARTS_WITH` / `ENDS_WITH` (see Operators), not functions.

### Number functions

- `ABS(n)`, `ROUND(n, decimals?)`, `FLOOR(n)`, `CEIL(n)`, `TRUNC(n)`
- `SIGN(n)`, `FROUND(n)`
- `POW(base, exp)`, `SQRT(n)`
- `MIN(a, b, ...)`, `MAX(a, b, ...)` — variadic
- `EXP(n)`, `LOG(n)`, `LOG10(n)`, `LOG2(n)`, `LOG1P(n)`
- Trig: `SIN` `COS` `TAN` `ASIN` `ACOS` `ATAN` `ATAN2(y, x)` `SINH` `COSH` `TANH` `ASINH` `ATANH`

> There is no `MOD` function and no `%` operator. There is no `CEILING` (use `CEIL`).

### Date functions

- `TODAY()` — current date (no time)
- `NOW()` — current timestamp
- `YEAR(d)`, `MONTH(d)`, `DAY(d)`, `HOUR(d)`, `MINUTE(d)`, `SECOND(d)`, `WEEKDAY(d)` — parts
- `DATE(...)` — construct a date
- `DATEADD(d, count, unit)` — add time; `unit` is a string, case-insensitive, one of
  `'DAY'`/`'DAYS'`, `'MONTH'`/`'MONTHS'`, `'YEAR'`/`'YEARS'`, `'HOUR'`/`'HOURS'`, `'MINUTE'`/`'MINUTES'`, `'SECOND'`/`'SECONDS'`
- `DATEDIFF(d1, d2, unit)` — `d2 - d1` in `unit` (same unit strings as `DATEADD`)
- Period helpers (optional date arg, default today): `STARTMONTH(d?)`, `ENDMONTH(d?)`, `STARTNEXTMONTH(d?)`, `STARTQUARTER(d?)`, `ENDQUARTER(d?)`, `STARTYEAR(d?)`, `ENDYEAR(d?)`

### Logical functions

- `IF(cond, then, else)` — ternary
- `COALESCE(a, b, c, ...)` — first non-null
- `SWITCH(value, match1, result1, match2, result2, ..., default?)` — returns the `resultN`
  whose `matchN` **equals** `value`; an optional trailing arg is the default. Use for
  value lookups: `SWITCH([priority], 'high', 3, 'low', 1, 0)`.
- `CASE(cond1, result1, cond2, result2, ..., default?)` — returns the first `resultN` whose
  `condN` is **true**; an optional trailing arg is the default. Use for ranges / boolean
  branches: `CASE([score] >= 90, 'A', [score] >= 80, 'B', 'C')`.

> `SWITCH` matches by value; `CASE` evaluates conditions. They are not interchangeable — passing a
> bare value as `CASE`'s first arg treats it as a boolean, not a match key.

### Conversion functions

- `TEXT(v)` — to string
- `NUMBER(v)` — to number (or null)
- `BOOLEAN(v)` — to boolean

### Special

- `CURRENT_USER_ID()` — the acting user's id (context-dependent; null outside a user context)
- `JSON_GET(obj, key, type?)` — read a value out of a JSON column

### Aggregation (on set columns)

- `COUNT([set_column])` — count related rows
- `SUM([set_column].[field])` — sum a child field over a set
- `AVG`, `MIN`, `MAX` similarly

Put set aggregations in a **Formula (`F`) column** — they evaluate at query time and may reference
any child column, including the child's own formula columns, e.g. `SUM([lines].[line_total])`.

> ⛔ Do **not** put a `SUM([set].[field])` in a **Generated (`G`)** column unless `field` is a
> *physical* (`D`) column. A `G` aggregate is maintained by a DB trigger that reads the child's
> `OLD`/`NEW` physical values; aggregating a virtual `F` child fails at install with
> `db_error: column old.<field> does not exist`. See `column-types.md` → "Roll-up totals over child rows".

## Navigation (dot notation)

`[reference].[field]` traverses a reference column to a target entity:

```
[customer].[name]                        -- this record's customer's name
[owner].[email]                          -- owner user's email
[customer].[primary_contact].[phone]     -- chained
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

## CHECK constraints are SQL, not formulas

A constraint's `expression` is **raw PostgreSQL**, evaluated by the database — **not** the
formula grammar. Use **bare column names** (no `[brackets]`), full SQL operators (`IS NULL`,
`LIKE`, `AND`/`OR`), and remember the DB runs it verbatim:

```json
"constraints": {
	"chk_quantity_positive": {
		"type": "check",
		"expression": "quantity > 0",
		"message": "Quantity must be positive"
	},
	"chk_dates": {
		"type": "check",
		"expression": "end_date IS NULL OR end_date >= start_date",
		"message": "End date cannot precede start date"
	}
}
```

Writing `[quantity] > 0` (formula syntax) in a check `expression` produces invalid DDL and fails
install. Formula `[bracket]` syntax belongs in `formula` fields and `canExecute:`, never in a
constraint `expression`.

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
	"precision": 2,
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
	"formula": "[customer].[billing_country]",
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
	"formula": "DATEDIFF([created_date], NOW(), 'DAY')",
	"description": "Days Open"
}
```

## Common mistakes

- Using `column_name` without brackets in a formula — **wrong**. Always `[column_name]`. (Bare names are only for check-constraint `expression` SQL.)
- Using `==` for equality — **wrong**. Formula equality is a single `=`. `==` is a parse error.
- Using `%` or `MOD()` — **neither exists** in the formula engine.
- Calling `FORMAT()`, `NULLIF()`, `ISNULL()`, `LTRIM()`, `RTRIM()`, `CEILING()` — **none exist**. Use `TEXT()`, `COALESCE()`, `TRIM()`, `CEIL()`.
- Calling `STARTSWITH(s, x)` / `ENDSWITH(s, x)` / `CONTAINS(s, x)` as functions — **wrong**. They are infix operators: `[s] STARTS_WITH x`.
- Swapping `CASE` and `SWITCH` — `SWITCH(value, match, result, ...)` matches by value; `CASE(cond, result, ...)` evaluates conditions.
- Inventing functions like `HAS_PERMISSION()`, `IS_ADMIN()`, `GET_USER()` — **they do not exist**.
- Using JavaScript syntax like `row.field` or `this.field` — **wrong**. Only `[field]`.
- Forgetting `baseDatatypeCd` on formula columns — **required**. Without it, filters and SQL don't work.
- Using SQL `SELECT` / `JOIN` / `WHERE` inside a formula — **wrong**. Formulas are expressions, not queries.
- String concatenation with commas — **wrong**. Use `+` or `CONCAT()`.

## Reference

The functions and operators above are the complete formula surface (mirrored client- and
server-side). If you need something not listed, model it with an action (`logic/actions/*.dsl`,
see `action-dsl.md`) rather than inventing a formula function.
