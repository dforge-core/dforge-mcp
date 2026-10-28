# Data Views Reference

Data views define how users see and interact with entity data. One entity can have many data views (grid, kanban, gallery, tree-grid, list, calendar, matrix, card).

Lives in: `ui/data_views.json`

> **Not to be confused with entity views.** An *entity view* (`views` on an entity file) is column-level **security** — which columns a folder may see at all — and is what `folders.json`'s `viewName` binds. A *data view* is a presentation of an entity, referenced by a menu's `dataViewCode`. See `security.md` → Column-level security.

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

## Critical rule — the view needs something to draw

A grid-style view resolves its columns one of two ways, and **one of them has to produce a renderable scalar column** — anything that isn't a set (`columnType: "S"`, a 1:N collection with no per-row value):

1. **The source names its own columns.** `dataSources[].columns` wins outright — see [the section below](#the-columns-array-is-authoritative). Flags don't enter into it, so this route works even when every field on the entity is internal.
2. **It doesn't, and the entity's `V` flags decide.** With no `columns` array the view falls back to the entity's **visible scalar columns** — fields whose `flags` include `V` and whose `columnType` isn't `S`.

With neither, the view renders the runtime empty state *"No visible columns configured for this entity."* — a broken screen the user only hits when they open the menu item. `dforge_module_validate` / `dforge_module_pack` **reject** that before install.

```jsonc
// WRONG — grid falls back to flags, and no field has "V"
"fields": {
    "code": { "fieldTypeCd": "text", "flags": "EM" },   // E=editable, M=… but no V
    "lines": { "columnType": "S", "flags": "VEM" }        // visible, but a SET — doesn't count for a grid
}
// RIGHT (route 2) — at least one visible scalar field
"fields": {
    "code": { "fieldTypeCd": "text", "flags": "VEM" }     // V present, not a set → satisfies the grid
}
// ALSO RIGHT (route 1) — the entity's fields stay internal, the view says what it shows
"dataSources": [
    { "entityCode": "audit_log", "columns": ["created_date", "created_by_user"] }
]
```

Practical guidance: reach for route 2. Flags are what every other surface reads — the card, the Fields popover, quick-add — so an entity whose real business fields are invisible is usually a mistake, even when one view papers over it. Route 1 is for columns that are *deliberately* internal, audit columns above all.

This applies to every column-rendering view type (grid, list, kanban, calendar, gallery, tree-grid, master-detail, and the default). The column-agnostic types — `diagram`, `matrix`, `library` — draw from `viewConfig`/relationships instead, so they're **exempt** from this rule.

## The `columns` array is authoritative

A column you name in `dataSources[].columns` renders **even if its flags omit `V`**. The list is your statement of what this view shows, so it wins over the entity's default visibility — that's how the internal (`flags: "I"`) columns the `audit` / `audit-full` traits contribute get onto a grid:

```jsonc
{
    "entityCode": "trip",
    "columns": ["trip_number", "status", "created_by_user"]   // renders Created By, read-only
}
```

A promoted column stays **read-only** unless its flags also carry `E`, and it shows up in the Fields popover like any other column.

What `columns` can't do — each fails `dforge_module_validate` / `dforge_module_pack`, instead of dropping silently:

| Entry | Why it's rejected |
|-------|-------------------|
| A code the entity doesn't define | Nothing to render — usually a typo (`avatar` for `avatar_image`) |
| A set column (`columnType: "S"`) | A 1:N collection has no per-row value for a column |
| A nav path (`account.company_name`) | The list takes plain column codes — add a Reference (`R`) or Formula (`F`) column to the entity and list that |

The `matrix` / `diagram` / `library` types are exempt here too: their `columns` entry feeds axes and config, not a header row.

See [flags.md](flags.md) for the flag string, [column-types.md](column-types.md) for `columnType` (`R`/`S`/`F`).

## View types

| `viewType` | Description | `viewConfig` | When to use |
|---|---|---|---|
| `grid` | Spreadsheet-style table with sortable columns | `groupByField`, `groupByOptions`, `collapsedGroups` (all optional) | Default for most entities; bulk data |
| `list` | Compact list view | `groupByField`, `groupByOptions`, `collapsedGroups`, `inlineAdd`, `levels` (all optional) | Mobile-friendly, card-sized items |
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

### Grid and list grouping

A `grid` or `list` view can ship a default grouping. Rows split under a header per value (colour or icon, label, count),
and a header click folds its group away. Every key is optional; without them the view is ungrouped.

```json
{
    "tickets_grid": {
        "viewType": "grid",
        "label": "Tickets",
        "dataSources": [{
            "entityCode": "ticket",
            "columns": ["subject", "status", "priority", "assignee_id"]
        }],
        "viewConfig": {
            "groupByField": "status",
            "groupByOptions": ["status", "priority", "assignee_id"],
            "collapsedGroups": ["closed"]
        }
    }
}
```

- `groupByField`: the column the rows are grouped by. It must be a dropdown, flags, reference (`columnType: "R"`) or
  `user` column.
- `groupByOptions`: the columns the Group menu offers. Each follows the same rule, and the list must include
  `groupByField`. Leave it out to offer every groupable column.
- `collapsedGroups`: values of `groupByField` whose groups start folded. It needs a valid `groupByField`, and for a
  dropdown each entry must be one of its option values.
- `inlineAdd` (`list` only): an add row in each group, or at the top when ungrouped.

The install refuses a view that breaks these rules, and `dforge_module_validate` reports it first. The default is a
single level. A user can stack more levels (priority, then status) from the gear menu; that choice lives in their
session, not in the module. A grouped grid loads up to 2,000 rows instead of paging and warns past that. Needs platform
1.28.11.

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

- `"dataset"` — axis values are an entity's records. `entity` + `labelField` required; optional `keyField` (defaults to the axis entity PK — what the cell's `rowKey`/`colKey` matches), `lockedField` (boolean column → that axis value's cells are read-only), `filter` (same `{c,o,v}` grammar as everywhere — scopes which axis records load), `hideEmpty` (**column axis only** — drop columns with no cell record in any row, e.g. periods with no postings; ignored if it would blank the whole grid), `rangeControl` (**column axis only** — show a From/To range control so the user can narrow the visible columns to a span; persists in view options; composes with `hideEmpty`), `sort` (`[{ col, dir }]`).
- `"dropdown"` — axis values are a dropdown/flags column's options. `kind` + `column` (an `"entity.column"` reference); optional `values` (`[...]` of option value codes — a subset + order of columns, chosen the way kanban lanes are; omit to show every option in field order). Codes line up by construction.
- `"date"` — generated date window, **column axis only** (not valid on `rowAxis`). `kind` + `grain: "day"` + `window: "week"` (v1). *Roadmap (designed, not built): arbitrary `range` (`{from, to}`) + `grain` (`day`/`week`/`month`/`quarter`/`year`), surfaced as a date-picker variant of the range bar — lets a time matrix generate its columns instead of needing seeded period records. Don't author against it yet.*

> **The matrix is source-agnostic.** A matrix is just config over generic entities: point the cell at *any* dated/keyed entity that fits your model — a pre-aggregated registry (e.g. `gl.balance_register`, fast but period-grained), raw dated movements (any-grain, heavier), or your own table. `gl` is a regular, replaceable module, not a platform requirement; nothing about the matrix knows or needs "gl". Choosing a pre-aggregated source vs raw rows (and the grain) is a per-view config decision, with the usual perf-vs-flexibility trade.

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
- A grid-style view over an entity with **no visible scalar column** (no field flagged `V`, or only set columns) — **rejected** at validate/pack. Mark at least one non-set field visible. See the [critical rule above](#critical-rule--the-entity-needs-a-visible-column). `diagram`/`matrix`/`library` are exempt.
