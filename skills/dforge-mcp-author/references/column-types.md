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
| `"G"` | Yes | **Generated column** — DB-level computed aggregate (e.g. SUM over child set via trigger, or PostgreSQL `GENERATED ALWAYS AS`). The aggregated child column **must be physical** (a `D` column) — never a virtual `F`/`R`/`S` column. For a simple roll-up total, prefer `F` (see below). |

**For most module development, you'll only use D, R, S, and F.** Types A, L, and G are for advanced accounting/registry modules that use the `postable`, `accumulation`, or `ledger` traits.

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

```json
// Hidden FK column — physical, hidden
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

## Roll-up totals over child rows — use `F`, not `G`

To total a child set on a header (line items → order total, movements → quantity on hand),
**use a Formula column (`"F"`) with `SUM([set].[field])`**. It is computed at query time, so it
can reference **any** child column — including the child's own formula columns.

```json
// purchase_order.total_amount — query-time roll-up (installs cleanly)
"total_amount": {
    "columnType": "F",
    "fieldTypeCd": "currency",
    "baseDatatypeCd": "number",
    "flags": "V",
    "orderNum": 90,
    "formula": "SUM([lines].[line_total])",      // line_total may itself be a formula column
    "description": "Total Amount"
}
```

> ⛔ **Never make a `G` (Generated) column aggregate a virtual `F` column.** A `G` aggregate is
> maintained by a database trigger that reads the child's `OLD`/`NEW` *physical* values. A formula
> (`F`) column has no physical storage, so the trigger references a column that doesn't exist and
> **install fails** with `db_error: column old.<field> does not exist`. If you need a stored
> (`G`) aggregate over a *derived* quantity (e.g. a signed movement quantity), make that child
> column **physical** first — either a plain `D` column written by the action logic, or a
> same-row `G`/`GENERATED ALWAYS AS` column with a `dbDatatype` — then aggregate that. For most
> modules a query-time `F` roll-up is the right choice; reserve `G` for high-volume stored aggregates.

## Quick reference: which columnType do I use?

- **Plain text/number/date/etc. field that stores a value** → omit `columnType` (default `"D"`)
- **"This contact belongs to one account"** → `"R"` (plus hidden FK)
- **"This account has many contacts"** → `"S"` on the account side
- **"Compute full_name from first_name + last_name"** → `"F"`
- **"User picker" (points to admin.user)** → omit `columnType`, use `fieldTypeCd: "user"` (writes user ID directly, no paired FK)
- **"Polymorphic link to any entity"** → omit `columnType`, use `fieldTypeCd: "entitylink"` (stored as JSON)
- **"Roll-up total over child rows"** (line items → header total, movements → quantity on hand) → `"F"` with `SUM([set].[field])` (query-time; see "Roll-up totals" above). Reserve `"G"` for high-volume *stored* aggregates, and only over a **physical** child column — never over an `F` column.
- **"Accumulation register state"** → `"A"` (advanced accounting — requires `postable` + `accumulation` traits)
- **"Double-entry ledger state"** → `"L"` (advanced accounting — requires `postable` + `ledger` traits)
