# Formula Engine Reference

Formulas are used in:

- **Formula columns** (`columnType: "F"`) — computed values
- **Action `canExecute:` blocks** — availability checks
- **Default values** — a setting's `formula` (e.g. `"formula": "TODAY()"`) or a formula (`F`) column. Note: entity *data* columns have **no** `default`/`defaultValue` key — model a default with an `F` column or set it in action/trigger logic.
- **Filter expressions** (partially)
- **Validation expressions** (partially)

> These are **formula** contexts: date helpers are uppercase `TODAY()` / `NOW()` here. Action
> `execute:` blocks are **not** a formula context — they run as JavaScript and use lowercase
> `now()` (see `action-dsl.md`).

The same grammar applies everywhere.

## Basic syntax

- **Field references**: `[column_name]` — the value of another column on the same entity
- **Navigation**: `[reference_column].[field]` — traverse a reference to a related entity's field
- **Literals**: numbers (`42`, `3.14`), strings in **single quotes** (`'hello'`; embed a quote by doubling it: `'it''s'`), booleans (`true`, `false`), null (`null`). Double quotes are **not** string delimiters — `"hello"` is a lex error
- **Operators**: `+`, `-`, `*`, `/`, `=`, `!=`, `<`, `>`, `<=`, `>=`, `AND`, `OR`, `NOT`, `IN`, `BETWEEN … AND …`, `CONTAINS`, `STARTS_WITH`, `ENDS_WITH`. Equality is a **single** `=` — `==` is a syntax error. There is no `%` operator; use `MOD(a, b)`
- **Function calls**: `FUNCTION_NAME(arg1, arg2, ...)` — uppercase by convention. Only the functions listed below exist; any other name is rejected at module install (see "Unknown functions" below)
- **Parentheses** for grouping

`CONTAINS` / `STARTS_WITH` / `ENDS_WITH` are infix operators, not functions — write
`[note] CONTAINS 'urgent'`, never `CONTAINS([note], 'urgent')`.

## Examples

```
[first_name] + ' ' + [last_name]

[quantity] * [unit_price]

[account].[name]

[account].[billing_address].[country]

[status] = 'active' AND [balance] > 0

TODAY() > [due_date] AND [total_paid] < [total]

SWITCH([priority], 'high', 3, 'medium', 2, 'low', 1, 0)

IF([total] > 1000, 'large', 'small')

COALESCE([nickname], [first_name], 'Unknown')

FORMAT([created_date], 'yyyy-MM-dd')
```

## Built-in functions

### String functions

- `CONCAT(a, b, ...)` — concatenate strings
- `LEN(s)` — string length (`LENGTH` is an alias)
- `LEFT(s, n)`, `RIGHT(s, n)` — leading / trailing `n` characters
- `UPPER(s)`, `LOWER(s)` — case conversion
- `TRIM(s)`, `LTRIM(s)`, `RTRIM(s)` — whitespace removal
- `SUBSTRING(s, start, end)` — substring by 0-based offsets, `end` exclusive
- `MID(s, start, len)` — substring by 0-based offset and length
- `INDEX_OF(s, find)`, `LAST_INDEX_OF(s, find)` — 0-based position, `-1` when absent
- `SPLIT(s, separator)` — split into a list
- `REPLACE(s, find, with)` — replace **every** occurrence
- Substring / prefix / suffix tests are the **operators** `CONTAINS`, `STARTS_WITH`, `ENDS_WITH` (`[note] CONTAINS 'x'`), not functions
- `FORMAT(date, 'pattern')` — format a **date** as text with .NET-style tokens (case-sensitive: `MM` = month, `mm` = minute): `yyyy`, `yy`, `MM`/`M`, `dd`/`d`, `HH`/`H`, `mm`/`m`, `ss`/`s`; single-letter variants unpadded, other characters pass through. Pattern must be a string literal. Dates only — numbers are not supported. Works client-side and SQL-time (reports)

### Number functions

- `ABS(n)`, `ROUND(n, digits)`, `FLOOR(n)`, `CEIL(n)`, `CEILING(n)`
- `MIN(a, b, ...)`, `MAX(a, b, ...)` — smallest / largest argument; nulls are ignored
- `POW(base, exp)`, `SQRT(n)`
- `MOD(a, b)` — modulo; a zero divisor is null, not an error
- `TRUNC(n)`, `SIGN(n)`, `EXP(n)`, `LOG(n)` (natural), `LOG10(n)`, `LOG2(n)`, `LOG1P(n)`
- `FROUND(n)` — round to single (32-bit float) precision
- Trigonometry: `SIN`, `COS`, `TAN`, `ASIN`, `ACOS`, `ATAN`, `ATAN2(y, x)`, and the hyperbolic `SINH`, `COSH`, `TANH`, `ASINH`, `ATANH`

### Date functions

- `TODAY()` — current date
- `NOW()` — current datetime with timezone
- `YEAR(d)`, `MONTH(d)`, `DAY(d)` — date parts (`MONTH` is 1-based)
- `HOUR(dt)`, `MINUTE(dt)`, `SECOND(dt)` — time parts
- `WEEKDAY(d)` — day of week, `0` = Sunday
- `DATE(y, m, d)` — build a date from parts; `DATE(v)` casts a value to a date
- `DATEADD(d, count, unit)` — add time; unit is a **string literal**: `'DAY'`, `'HOUR'`, `'MINUTE'`, `'SECOND'`, `'MONTH'`, `'YEAR'` (plural forms accepted)
- `DATEDIFF(d1, d2, unit)` — difference `d2 − d1` in the given unit (same unit list). `DAY`/`HOUR`/`MINUTE`/`SECOND` floor the elapsed time; `MONTH`/`YEAR` are calendar-component deltas. E.g. days overdue: `DATEDIFF([due_date], TODAY(), 'DAY')`
- `STARTMONTH(d?)`, `ENDMONTH(d?)`, `STARTQUARTER(d?)`, `ENDQUARTER(d?)`, `STARTYEAR(d?)`, `ENDYEAR(d?)`, `STARTNEXTMONTH(d?)` — period boundaries. **Omitting** the argument means today; passing one that is null gives null (a row with no date renders blank, it does not fall back to today)

The whole date family evaluates identically **client-side and SQL-time** (reports, filters, sorts on formula columns) — the SQL translator mirrors the client runtime, including `MONTH` 1-based and `WEEKDAY` 0=Sunday. Unit arguments must be string literals; an unknown unit fails loud with the accepted list.

### Logical functions

- `IF(cond, then, else)` — ternary (`IIF` is an alias)
- `CASE(cond1, result1, cond2, result2, ..., default)` — first **condition** that holds wins
- `SWITCH(expr, val1, result1, val2, result2, ..., default)` — first **value** that matches
  `expr` wins. Note the difference: `CASE` takes conditions, `SWITCH` takes values to compare
- `COALESCE(a, b, c, ...)` — first non-null
- `NULLIF(a, b)` — null if equal, else a
- `ISNULL(x)` — boolean **null check** (returns true/false). This is *not* T-SQL's two-arg "replace null with" — that is `COALESCE(x, fallback)`

### Conversion and context functions

- `TEXT(v)` — as text (null becomes `''`)
- `NUMBER(v)` — as a number, or null when the value isn't numeric (including a blank string)
- `BOOLEAN(v)` — null, `''` and `0` are false; everything else is true
- `JSON_GET(json, 'key' [, type])` — read a key out of a JSON column. The optional type is a
  string literal: `'text'` (default), `'number'`/`'numeric'`, `'int'`/`'integer'`/`'bigint'`,
  `'bool'`/`'boolean'`, `'date'`, `'datetime'`/`'timestamp'`/`'timestamptz'`
- `CURRENT_USER_ID()` — the id of the requesting user

### Client-side vs SQL-time evaluation

An `F` column is evaluated **client-side** in grids and cards, but translated to **SQL** when a
report selects it, or when it is used in a filter or sort. **Every function listed here is
implemented in both**, so a column reads the same in a grid and in a report; a test executes
each one against PostgreSQL and diffs the result against the client runtime.

Two deliberate points of agreement, because the engines disagree by nature:

- **Out-of-domain math is null, not an error.** `SQRT(-1)`, `LOG(0)`, `ASIN(2)`, `EXP(1000)`,
  `POW(0, -1)`, `MOD(x, 0)` — JavaScript would answer NaN or Infinity and PostgreSQL would
  raise (failing the whole report). Both return null, so the cell renders blank.
- **String indexing is JavaScript-flavoured, not SQL's.** `SUBSTRING(s, start, end)` and
  `MID(s, start, len)` take a **0-based** start, and `SUBSTRING`'s third argument is an **end
  offset**, not a length. `INDEX_OF` / `LAST_INDEX_OF` return a 0-based index, or `-1`.

Known remaining difference: `CONCAT` on a numeric column renders PostgreSQL's declared scale
(`-3.0`) where the client renders the JavaScript number (`-3`). Use `FORMAT`/`TEXT` when the
exact rendering matters.

`CURRENT_USER_ID()` needs the requesting user, so it resolves in grids, reports, filters and
`select()`, but not in a context with no user (an unattended job).

### Unknown functions

The parser treats any `NAME(...)` as a call, so a misspelled or non-existent function is a
*grammatically valid* formula. Module install rejects it with the offending name (and a "did
you mean" suggestion where one is close). Before that check existed, such a formula installed
cleanly and then rendered as an **empty cell on every row**, with no error in the server log,
the browser console, or the install output.

### Comparing dates

Date comparisons work directly — `TODAY() > [due_date]`, `[due_date] BETWEEN STARTMONTH() AND
ENDMONTH()`, `[due_date] = TODAY()` — and combine with other conditions through `AND` / `OR`
like any other boolean. A bare `date` column is treated as a **local calendar date**, matching
`TODAY()` and `DATE(y, m, d)`.

### Aggregation over a child set — use a Generated (`G`) column, not `F`

- `SUM([set].[field])` — sum a child field over a set
- `COUNT([set])` — count related rows (`COUNT(*)` is rejected)
- `AVG`, `MIN`, `MAX` similarly

> ⚠️ **Set aggregation is NOT a Formula (`F`) feature.** `SUM([set].[field])` in an `F` column is
> unsupported by the engine — the formula runtime has no `SUM`/`COUNT`/`AVG`, and nav resolution
> only walks single-hop N:1 references, never a 1:N set. It silently renders **empty** (no error).

Put set aggregations in a **Generated (`G`) column** instead. The installer detects the set
navigation and maintains the value with a database trigger on the child table. The aggregated
child column must be **physical** (a `D` column, or a same-row `G`) — never a virtual `F`/`R`/`S`
column, which fails at install with `db_error: column old.<field> does not exist`. Full details
and the JSON shape: `column-types.md` → "Roll-up totals over child rows — use `G`, not `F`".

```json
"total_amount": {
    "columnType": "G",
    "dbDatatype": "numeric(18,2)",
    "formula": "SUM([lines].[amount])",
    "flags": "V",
    "orderNum": 90,
    "description": "Total Amount"
}
```

## Navigation (dot notation)

`[reference].[field]` traverses a reference column to a target entity:

```
[account].[name]                         -- contact's account's name
[owner].[email]                          -- owner user's email
[account].[primary_contact].[phone]      -- chained
```

Navigation works through `columnType: "R"` columns (reference columns). Chains of length 1 are **synchronous** and resolved instantly. Chains of length ≥ 2 are **asynchronous** — the formula engine resolves them after the initial data load.

**SQL-time (reports, filters, sorts):** single-hop navigation (`[ref].[field]`) is translated to a `LEFT JOIN` and computes in reports and query datasets. Multi-hop chains and `$[Setting]` references are **not** available at SQL time — the column returns NULL there and the response carries a warning naming the column. Keep report-bound formulas to single-hop navigation.

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

The constraint's `message` (the violation text shown to users) is **localizable** — add a per-locale override at `entities.<entityCd>.constraints.<constraintName>.message` in each `translations/<locale>.json`. The base `message` in the entity JSON is the fallback. See `translations.md` → "Constraint violation messages ARE translatable".

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
