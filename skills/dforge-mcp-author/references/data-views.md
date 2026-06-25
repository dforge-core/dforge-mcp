# Data Views Reference

Data views define how users see and interact with entity data. One entity can have many data views (grid, kanban, gallery, tree-grid, list, calendar, matrix, card).

Lives in: `ui/data_views.json`

## Structure

```json
{
    "contact_list": {
        "label": "All Contacts",
        "description": "Primary list of contacts",
        "viewType": "grid",
        "icon": "bi-people",
        "dataSources": [{
            "entityCode": "contact",
            "label": "Contacts",
            "columns": [
                { "column_cd": "first_name", "width": 150 },
                { "column_cd": "last_name",  "width": 150 },
                { "column_cd": "email",      "width": 220 },
                { "column_cd": "phone",      "width": 130 },
                { "column_cd": "account",    "width": 200 }
            ],
            "filter": null
        }],
        "order": ["last_name"]
    }
}
```

## Critical rule — `dataSources` array

**Always** put `entityCode`, `columns`, and per-source `filter` inside a `dataSources` array. Never at the root. The view-level `order` and `filter` sit at the view-def root, alongside `viewType`.

```json
// WRONG — will fail validation
{
    "contact_list": {
        "label": "Contacts",
        "viewType": "grid",
        "entityCode": "contact",        // WRONG — should be inside dataSources
        "columns": [ /* ... */ ]        // WRONG — should be inside dataSources
    }
}

// RIGHT
{
    "contact_list": {
        "label": "Contacts",
        "viewType": "grid",
        "dataSources": [{
            "entityCode": "contact",
            "columns": [ /* ... */ ]
        }]
    }
}
```

## View types

| `viewType` | Description | `viewConfig` | When to use |
|---|---|---|---|
| `grid` | Spreadsheet-style table with sortable columns | — | Default for most entities; bulk data |
| `list` | Compact list view | — | Mobile-friendly, card-sized items |
| `kanban` | Columns grouped by a status field | `groupByField` | Workflow entities with stages (deals, tickets) |
| `gallery` | Image-forward card grid | — | Image-heavy entities (products, real estate) |
| `tree-grid` | Hierarchical grid with expand/collapse | — | Tree structures (folders, categories, org charts) |
| `calendar` | Calendar display of date-based records | `dateField`, `titleField` | Schedules, due dates, events |
| `matrix` | Pivot grid: `rowAxis` × `colAxis`, one value-source record per cell | `rowAxis`, `colAxis`, `cell` | Cross-tab data: P&L (accounts × periods), timesheets (tasks × days), budgets (categories × months) |
| `card` | Single-record detail view | — | Record detail pages (implicit — every entity has one) |

## View config (`viewConfig`)

Some view types need additional configuration via the `viewConfig` property:

### Kanban

```json
{
    "opportunities_kanban": {
        "viewType": "kanban",
        "label": "Sales Pipeline",
        "dataSources": [{
            "entityCode": "opportunity",
            "columns": ["opportunity_name", "account", "total_amount", "owner_id"]
        }],
        "viewConfig": {
            "groupByField": "stage"
        }
    }
}
```

`groupByField` — the dropdown/status column to group cards by. Each distinct value becomes a kanban column.

### Calendar

```json
{
    "invoices_calendar": {
        "viewType": "calendar",
        "label": "Invoice Calendar",
        "dataSources": [{
            "entityCode": "invoice",
            "columns": ["invoice_number", "customer", "total_amount", "due_date"]
        }],
        "viewConfig": {
            "dateField": "due_date",
            "titleField": "invoice_number"
        }
    }
}
```

- `dateField` — the date column that determines where records appear on the calendar
- `titleField` — the column whose value is shown as the calendar event title

### Matrix

A pivot grid. The view's primary `dataSources` entity is the **cell** entity (one record per row×column intersection). `viewConfig` declares the two axes and how the cell record maps onto them.

```json
{
    "income_statement_matrix": {
        "viewType": "matrix",
        "label": "Income Statement (Matrix)",
        "dataSources": [{
            "entityCode": "balance_register",
            "columns": ["account_id", "period_key", "pl_amount"]
        }],
        "viewConfig": {
            "rowAxis": {
                "kind": "dataset",
                "entity": "account",
                "labelField": "account_name",
                "filter": { "c": "statement", "o": "eq", "v": "IncomeStatement" },
                "sort": [{ "col": "account_code", "dir": "asc" }]
            },
            "colAxis": {
                "kind": "dataset",
                "entity": "accounting_period",
                "labelField": "description",
                "lockedField": "closed",
                "hideEmpty": true,
                "sort": [{ "col": "period_key", "dir": "asc" }]
            },
            "cell": {
                "entity": "balance_register",
                "rowKey": "account_id",
                "colKey": "period_key",
                "fields": ["pl_amount"],
                "editable": false,
                "drill": true
            }
        }
    }
}
```

**`rowAxis` / `colAxis`** — what the rows and columns are. Three `kind`s:

- `"dataset"` — axis values are an entity's records. `entity` + `labelField` required; optional `keyField` (defaults to the axis entity PK — what the cell's `rowKey`/`colKey` matches), `lockedField` (boolean column → that axis value's cells are read-only), `filter` (same `{c,o,v}` grammar as everywhere — scopes which axis records load), `hideEmpty` (**column axis only** — drop columns with no cell record in any row, e.g. periods with no postings; ignored if it would blank the whole grid), `sort` (`[{ col, dir }]`).
- `"dropdown"` — axis values are a dropdown/flags column's options. Just `kind` + `column` (an `"entity.column"` reference). Codes line up by construction.
- `"date"` — generated date window, **column axis only** (not valid on `rowAxis`). `kind` + `grain: "day"` + `window: "week"` (v1).

**`cell`** — the value-source record at each intersection. `entity` (must match the primary dataSource), `rowKey` / `colKey` (cell columns matching the row/column axis keys), `fields` (cell columns rendered in each cell). Optional: `cardinality: "one"` (v1 default), `editable`, `drill` (read-only cells become clickable → open the cell record and its child sets), `seedFromRow` (`{ cellField: rowAxisField }` copied into new cell records on insert), `seedCurrentUser` (cell fields set to the current user id on insert).

## Columns

Each column is either a simple string or an object:

```json
"columns": [
    "first_name",                                // just column code, default width
    { "column_cd": "email", "width": 220 },      // with width override
    { "column_cd": "account", "width": 200, "visible": true }
]
```

## Filters

Filters use dForge's canonical JSON filter format — see [filters.md](filters.md) for the full grammar. Keys are `c` (column), `o` (operator), `v` (value) for conditions, and `g` (group operator), `i` (items) for groups.

Single condition:

```json
"filter": { "c": "status", "o": "=", "v": "active" }
```

Group:

```json
"filter": {
    "g": "and",
    "i": [
        { "c": "status", "o": "=", "v": "active" },
        { "c": "created_date", "o": ">", "v": "2026-01-01" }
    ]
}
```

Do **not** use `op`/`args`/`column`/`value` — that format is rejected.

## Sort (`order`)

Sort lives at the **view-def root** (not inside `dataSources[]`) under the key **`order`** — a `string[]` of column codes. Direction is encoded in the string itself:

- Bare column code → **ascending** (the default; no prefix needed)
- Leading `-` → **descending**

```json
"order": ["last_name", "first_name"]          // both ascending
"order": ["-created_date"]                     // descending (audit trait provides created_date)
"order": ["-created_date", "last_name"]        // primary desc, then asc tiebreak
```

The array order is the sort precedence: the first entry is the primary sort key, subsequent entries are tiebreakers.

This matches the shape the runtime persists and `data.get` accepts. **Do not** use `"sort"`, `[{ column_cd, direction }]`, or `[{ c, d }]` here — those shapes belong to `query.run` and `report.run` (see [queries.md](queries.md)), not `data_views.json`.

## Multi-source views

A view can show data from multiple entities (e.g. a dashboard-style view mixing contacts and activities). Each entry in `dataSources` is independent with its own columns/filter.

```json
"dataSources": [
    { "entityCode": "contact", "columns": [ /* ... */ ] },
    { "entityCode": "activity", "columns": [ /* ... */ ] }
]
```

Most views only have one source. Order is view-level and applies to the primary (level 0) source.

## Common mistakes

- Putting `entityCode` or `columns` at the root — **wrong**. They go inside `dataSources[]`.
- Using `viewCode` or `view_cd` — **wrong**. The code is the dictionary key.
- Using `"sort"` for data view ordering — **wrong**. The field is `"order"` and it lives at view-def root (not inside `dataSources[]`).
- Object-array order like `[{ column_cd: "...", direction: "asc" }]` — **wrong shape for data views**. Use `string[]` with leading `-` for descending.
- `viewType` is **optional** — omitted or unknown values fall back to `grid` at runtime. Set it explicitly for any non-grid view (`kanban`, `calendar`, `matrix`, …); a `matrix` view also **requires** a `viewConfig` with `rowAxis`/`colAxis`/`cell`.
- Inventing view types like `"spreadsheet"` or `"table"` — **wrong**. Use `grid`.
