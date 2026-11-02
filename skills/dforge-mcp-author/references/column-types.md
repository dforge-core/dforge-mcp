# Column Types Reference

Every column has a `columnType` (optional for the default physical type). Seven values exist:

| `columnType` | Physical DB column? | Description |
|---|---|---|
| (omitted) or `"D"` | Yes | **Data column** — default. Maps to a real SQL column. |
| `"R"` | No | **Reference column** — virtual N:1 lookup. Paired with a hidden FK column (see FK+Reference pattern). |
| `"S"` | No | **Set column** — virtual 1:N backwards reference. Used for detail grids. |
| `"F"` | No | **Formula column** — virtual computed value. Evaluated by the formula engine. |
| `"A"` | Yes | **Accumulation register column** — stores posted state for accumulation registers. Advanced (accounting modules). |
| `"L"` | Yes | **Ledger register column** — stores posted state for double-entry bookkeeping. Advanced (accounting modules). |
| `"G"` | Yes | **Generated column** — DB-level computed value. Two strategies, auto-detected from the formula: a **trigger-based aggregate over a child set** (`SUM([lines].[amount])`), or a same-row PostgreSQL `GENERATED ALWAYS AS` (`[qty] * [price]`). This is the correct type for **roll-up totals over child rows** (see below). The aggregated child column **must be physical** (a `D` column, or a same-row `G`) — never a virtual `F`/`R`/`S` column. |
| `"Q"` | No | **Query column** — read-only list of rows the record does not own: a balance register as of the record's date, or a query filled from the record. See "Query columns" below. |

**For most module development, you'll use D, R, S, and F.** Add `G` when you need a **roll-up total over a child set** (`SUM`/`COUNT`/`AVG`/`MIN`/`MAX`) — see below. Types A and L are for advanced accounting/registry modules that use the `postable`, `accumulation`, or `ledger` traits.

## Data columns (`columnType` omitted or `"D"`)

Most columns. They map 1:1 to a physical SQL column.

```json
"first_name": {
    "dbDatatype": "varchar",
    "fieldTypeCd": "text",
    "flags": "VEM",
    "maxLen": 100,
    "orderNum": 20,
    "description": "First Name"
}
```

## Reference columns (`columnType: "R"`)

Virtual N:1 lookup. No physical column. Always **paired with a hidden FK column** that does hold the physical data. Together they form the **FK+Reference pattern**.

The example below is a **required** relation, so both halves carry `M`. For an optional
one, drop it from both: FK `"E"`, Reference `"VE"`. `M` resolves to `isNullable: false`
at install, so it is what makes the FK column `NOT NULL` — and while `M` is inert on the
virtual Reference half (at the entity level; a per-view override behaves differently, see
`flags.md`), leaving it there over an optional FK reads as a required field to the next
author. `dforge_entity_reference_add({ required })` emits both halves in step.

```json
// Hidden FK column — physical, hidden. "E" instead of "EM" if the relation is optional.
"account_id": {
    "dbDatatype": "cuid",
    "flags": "EM",
    "orderNum": 90,
    "description": "Account ID"
},
// Visible Reference column — virtual, shown as lookup picker
"account": {
    "columnType": "R",
    "fieldTypeCd": "lookup",
    "flags": "VEM",
    "orderNum": 95,
    "description": "Account",
    "link": {
        "entity": "account",
        "thisKey": "account_id",
        "otherKey": "account_id"
    }
}
```

Plus declare the FK constraint in the entity's `references` block:

```json
"references": {
    "FK_Contact_Account": {
        "from": { "field": "account_id" },
        "to": { "entity": "account", "field": "account_id" }
    }
}
```

### Referential actions — `onDelete` / `onUpdate` (optional)

A reference entry may declare `onDelete` and/or `onUpdate` to emit an `ON DELETE` / `ON UPDATE` clause on the FK. Both accept: `"cascade"`, `"setNull"`, `"restrict"`, `"noAction"`. **Omitted = `noAction`** (plain FK — the default and correct choice for most references).

```json
"references": {
    "FK_OpportunityLine_Opportunity": {
        "from": { "field": "opportunity_id" },
        "to":   { "entity": "opportunity", "field": "opportunity_id" },
        "onDelete": "cascade"
    }
}
```

- **`cascade`** — deleting the parent deletes its children. Use for owned child collections (line items under their header) so the parent delete isn't blocked by a FK violation.
- **`setNull`** — nulls the FK column when the parent is deleted; the FK column **must be nullable**.
- **`restrict` / `noAction`** — block the parent delete while children exist (the safe default; leave the keys off to get this).
- **`onUpdate`** — fires when the parent's key value changes. A **no-op for immutable `cuid` PKs** (identity-trait entities), so only meaningful for entities keyed on a natural/mutable PK.
- **Self-healing on reinstall:** the DDL generator reads the live FK's current rule and drops+recreates the FK only when it changed, so changing `onDelete` and reinstalling applies to already-provisioned tenants (and is a no-op otherwise). An unknown value fails install fast.

> **FK column `dbDatatype` must exactly match the referenced entity's PK `dbDatatype`.** Never guess.
> - Entities using the `identity` trait → PK is `dbDatatype: "cuid"` → FK column must also be `"cuid"`
> - Cross-module or legacy entities → call `dforge_module_inspect` on the referenced module and read the PK column's `dbDatatype` before declaring the FK
> - **`bigint`, `integer`, `int8` are wrong values for FK columns** — even though `cuid` is physically stored as int8, the platform type name is `cuid`, not `bigint`

**Why two columns?** The FK stores the actual value. The Reference column configures how the value is rendered in the UI (as a typeahead picker showing the target's `toString`). They must be kept in sync — column order in JSON doesn't matter but `orderNum` determines UI ordering.

### How the picker behaves on a large target

Opening the picker loads the **first 200 rows** of the target entity — enough to browse, cheap on a table of any size. Typing does *not* filter those 200 rows: the query goes to the server as a case-insensitive match over the columns named in the target's `toString`, so a target with 200 000 rows is as pickable as one with 20. Every whitespace-separated term must match at least one of those columns, which is what lets a `toString` of `"{first_name} {last_name}"` answer "John Smith".

Two consequences for the entity you point at:

- **Put the columns people search by in `toString`.** They are the only ones the picker searches. A target whose `toString` is `"{code}"` cannot be found by name, however prominent the name column is elsewhere.
- **A `toString` built only from formula columns can't be searched server-side.** Neither formula nor set columns translate to a `WHERE` clause, so the picker falls back to narrowing the 200 rows it already loaded — rows past that point stay unreachable. Name at least one stored column in the template.

`refFilter` and folder row filters still apply: they are AND-ed onto the search, so a filtered-out row does not surface just because the user typed its name.

## Set columns (`columnType: "S"`)

Virtual 1:N backwards reference. Shows a grid of related records on the parent's detail view.

```json
"activities": {
    "columnType": "S",
    "fieldTypeCd": "grid",
    "flags": "VEM",
    "orderNum": 150,
    "description": "Activities",
    "link": {
        "entity": "activity",
        "thisKey": "contact_id",    // column on THIS entity (parent PK)
        "otherKey": "contact_id"    // column on the OTHER entity (FK back to parent)
    }
}
```

`link.entity` is the child entity. `link.thisKey` is the column on the current entity (typically the PK). `link.otherKey` is the FK column on the child entity pointing back to the parent.

Set columns are **not** declared in the `references` block — the FK already lives on the child entity.

## Formula columns (`columnType: "F"`)

Virtual computed column. No physical storage. Value is calculated at runtime by the formula engine.

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

**Required fields for formula columns**:

- `columnType: "F"`
- `fieldTypeCd` — how to render it
- `baseDatatypeCd` — **required** on formula columns even though there's no physical column; used for type inference
- `flags: "V"` (usually — formula columns are almost always read-only)
- `formula` — the formula expression
- `orderNum`
- `description`

Do **not** include `dbDatatype` on formula columns (there's no physical storage).

See `formulas.md` for syntax.

## Query columns (`columnType: "Q"`)

A read-only list of rows the card shows beside its sets and a print form reads like a set. No physical column, no `link`; the binding is `params`, one of two sources:

```json
"old_stock": {
    "columnType": "Q",
    "description": "Balance on the document's date",
    "params": {
        "register": "wms-registry.stock",
        "asOf": "doc_date",
        "dimensions": { "warehouse_id": "warehouse_id" }
    }
},
"lines_by_product": {
    "columnType": "Q",
    "params": {
        "entity": "retail.document_line",
        "query": {
            "columns": [ { "c": "product_id", "agg": "group" }, { "c": "quantity", "agg": "sum" } ],
            "filter": { "c": "document_id", "o": "eq", "v": "@doc" },
            "sort": [ { "c": "product_id", "d": "asc" } ]
        },
        "params": { "doc": "document_id" }
    }
}
```

- **Register balance** — `register` (a `balance` register of this module or a dependency, with a dated journal), `asOf` (the record's date column; the day is included) and `dimensions` (register dimension → record column; a dimension left out is not narrowed). Rows are the register's state entity rows as of that date; tuples holding nothing are left out.
- **Query** — `entity` (bare for this module's, or a dependency's), `query` (`columns`, `filter`, `sort` as `query.run` takes them; `group` / `sum` apply) and `params` filling each filter `@param` from a stored record column. An aggregate is read under its column's code (`r.quantity`). State a `sort` on a grouped query.
- `params.viz` — `{ "type": "bar", "config": { … } }` — shows the card's rows as a report visualization instead of a table. A print reads the rows as a table whatever `viz` says.
- Read with the reader's rights. At most 1000 rows. An empty date or narrowing column lists nothing, with a warning — never every row.
- **Install refuses:** an unknown register or entity (or one in a module this one does not depend on); a missing `asOf`; an unfilled or extra `@param`; a `viz` without a `type`; both `register` and `query`; a Q column in a data view or as a report parameter source; a Q column in an extension of another module's entity.
- `data.get` skips it like a set and DSL `select()` refuses it. It is a list for a form, not a figure on a card: for a single total use a `G` column.

Full details: `registers.md` and core docs/business-logic/registers.md#query-columns-a-registers-balance-on-the-records-date.

## Roll-up totals over child rows — use `G`, not `F`

To total a child set on a header (line items → order total, movements → quantity on hand),
**use a Generated column (`"G"`) with `SUM([set].[field])`**. The installer detects the set
navigation and generates a database trigger on the child table that keeps the parent value current
on every child insert/update/delete. Because the value is **physically stored**, it displays
everywhere (grid, form, reports) and is **filterable and sortable** in queries.

```json
// purchase_order.total_amount — trigger-maintained roll-up
"total_amount": {
    "columnType": "G",
    "dbDatatype": "numeric(18,2)",
    "formula": "SUM([lines].[amount])",
    "flags": "V",
    "orderNum": 90,
    "description": "Total Amount"
}
```

A `"G"` roll-up requires `dbDatatype` and `formula`; it must **not** have `link` or
`baseDatatypeCd`. Supported aggregate functions: `SUM`, `COUNT`, `AVG`, `MIN`, `MAX` (`SUM`/`COUNT`
default to `0` when there are no children; `MIN`/`MAX`/`AVG` return `NULL`). All set references
inside one aggregate must point at the **same** set column, and `COUNT(*)` is rejected — write
`COUNT([lines])`.

> ⛔ **Do not use a Formula (`F`) column for set aggregation.** `SUM([set].[field])` in an `F`
> column is **not supported** by the engine — the formula runtime has no `SUM`/`COUNT`/`AVG`, and
> nav resolution walks N:1 references only, never a 1:N set (however many hops it is given). The
> column silently renders **empty** on the form, grid, and reports (no error). `F` is for same-row
> expressions (`[qty] * [price]`) and N:1 reference navigation (`[account].[name]`, and multi-hop
> chains — see `dforge://reference/formulas`).

> ⛔ **The aggregated child column must be physical.** A `G` trigger reads the child's `OLD`/`NEW`
> physical values, so aggregating a **virtual** child column (`F`/`R`/`S`) fails at install with
> `db_error: column old.<field> does not exist`. To roll up a *derived* quantity (e.g. a signed
> movement amount), make that child column physical first — a plain `D` column written by action
> logic, or a same-row `G`/`GENERATED ALWAYS AS` column with a `dbDatatype` — then aggregate that.

## Quick reference: which columnType do I use?

- **Plain text/number/date/etc. field that stores a value** → omit `columnType` (default `"D"`)
- **"This contact belongs to one account"** → `"R"` (plus hidden FK)
- **"This account has many contacts"** → `"S"` on the account side
- **"Compute full_name from first_name + last_name"** → `"F"`
- **"User picker" (points to admin.user)** → omit `columnType`, use `fieldTypeCd: "user"` (writes user ID directly, no paired FK)
- **"Polymorphic link to any entity"** → omit `columnType`, use `fieldTypeCd: "entitylink"` (stored as JSON)
- **"Roll-up total over child rows"** (line items → header total, movements → quantity on hand) → `"G"` with `SUM([set].[field])` (trigger-maintained, stored; see "Roll-up totals" above). Aggregate only a **physical** child column — never an `F`/`R`/`S` column. Do **not** use `"F"` for set aggregation — it silently renders empty.
- **"A list of what the register held on this document's date" / "this record's lines grouped and summed"** → `"Q"` (read-only; see "Query columns" above)
- **"Accumulation register state"** → `"A"` (advanced accounting — requires `postable` + `accumulation` traits)
- **"Double-entry ledger state"** → `"L"` (advanced accounting — requires `postable` + `ledger` traits)
