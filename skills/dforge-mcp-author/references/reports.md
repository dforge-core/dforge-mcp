# Reports Reference

Reports are **query-driven visualizations** — charts, KPI cards, pivot tables, tables — backed by datasets. Unlike data views (which target one entity), a report can combine **multiple datasets** and lay out several panels.

Lives in: `ui/reports.json` (map of `report_code` → report). Not listed in `manifest.json` — the install pipeline picks up `ui/reports.json` automatically.
SP files: `logic/reports/rpt_*.sql`

## Structure

A report has `description`, a `datasets` map, a `layout` object (`{ panels: [...] }`), optional per-dataset `params`, and an optional `entities` array (record-report attachments). Panels reference datasets by code via `datasetCd`.

```json
{
    "sales_pipeline": {
        "description": "Open opportunities by stage",
        "datasets": {
            "pipeline": {
                "caption": "Pipeline Data",
                "datasetType": "Q",
                "params": {
                    "min_amount": { "fieldTypeCd": "number", "label": "Min Amount", "required": false, "default": 0 }
                },
                "query": {
                    "entityCd": "opportunity",
                    "columns": ["stage", "amount", "lead_source", "customer.name"],
                    "filter": {
                        "g": "and",
                        "i": [
                            { "c": "stage", "o": "nIn", "v": ["Closed Won", "Closed Lost"] },
                            { "c": "amount", "o": "grEq", "v": "@min_amount" }
                        ]
                    },
                    "sort": [ { "c": "amount", "d": "desc" } ]
                }
            }
        },
        "layout": {
            "panels": [
                {
                    "vizType": "chart",
                    "datasetCd": "pipeline",
                    "title": "Pipeline Value by Stage",
                    "config": { "chartType": "bar", "categoryCol": "stage", "valueCol": "amount", "agg": "sum", "chartSize": "l" }
                },
                { "vizType": "table", "datasetCd": "pipeline", "title": "Pipeline Detail" }
            ]
        }
    }
}
```

**Aggregation happens in the viz, not the dataset.** A dataset selects raw columns; the chart/KPI config aggregates them (`agg`, `metrics`). There is no dataset-level `groupBy`/`aggregations` — do not use them.

## Dataset types

### Entity query dataset (most common)

`datasetType: "Q"` (the default) with a `query` object using the platform query builder. Filters use the standard JSON filter format (see `references/filters.md`).

```json
"sales": {
    "caption": "Sales Data",
    "datasetType": "Q",
    "query": {
        "entityCd": "opportunity",
        "columns": ["stage", "amount", "close_date", "customer.name"],
        "filter": { "c": "stage", "o": "!=", "v": "Closed Lost" },
        "sort": [ { "c": "close_date", "d": "desc" } ]
    },
    "columnsDef": { "amount": { "label": "Deal Value" }, "customer.name": { "label": "Account" } }
}
```

- `query.entityCd` — source entity code (**not** `entityCode`).
- `query.columns` — column codes; supports dot navigation (`customer.name`).
- `query.filter` — canonical filter (`{c,o,v}` or `{g,i:[...]}`); use `@param_code` to reference a parameter.
- `query.sort` — `[{ c, d }]` where `d` ∈ `asc | desc`.
- `columnsDef` — optional per-column display overrides (`{ label, visible, width }`).

### Stored procedure dataset (developer path)

For SQL the query builder can't express — window functions, CTEs, cross-schema joins, conditional aggregation, multi-result sets.

```json
"aging": {
    "caption": "AR Aging",
    "datasetType": "S",
    "spCd": "rpt_ar_aging",
    "params": {
        "as_of_date": { "fieldTypeCd": "date", "label": "As of Date", "required": true, "default": "=NOW()" },
        "customer_id": { "fieldTypeCd": "lookup", "label": "Customer", "required": false, "params": { "link": { "entity": "account" } } }
    },
    "columnsDef": {
        "customer_name": { "label": "Customer", "fieldTypeCd": "text", "baseDatatypeCd": "string", "width": 200 },
        "current_amount": { "label": "Current", "fieldTypeCd": "number", "baseDatatypeCd": "number", "width": 120 },
        "total": { "label": "Total", "fieldTypeCd": "number", "baseDatatypeCd": "number", "width": 130 }
    }
}
```

Key differences from entity datasets:
- `datasetType: "S"`.
- `spCd` — the stored-procedure code (the function name **without** the schema prefix; resolved to `sp_id` at install). (**Not** `sp` or `procedureName`.)
- `columnsDef` — **required** — the platform can't infer columns from a function.
- Params work exactly as they do for an entity dataset, and `datasetType` makes no difference: declare them at report level (`parameters`) or on the dataset (`params`). Report level wins on a code collision.

**Multi-result-set SPs** map extra datasets to the same function via `parentDatasetCd` (the dataset that owns the SP call) + `parentRef` (the named refcursor):

```json
"datasets": {
    "summary":  { "caption": "Summary", "datasetType": "S", "spCd": "rpt_department_overview", "columnsDef": { } },
    "by_role":  { "caption": "By Role", "datasetType": "S", "parentDatasetCd": "summary", "parentRef": "employee_breakdown", "columnsDef": { } }
}
```

### The PostgreSQL function

SP files live in `logic/reports/` and follow this convention:

```sql
CREATE OR REPLACE FUNCTION crm.rpt_ar_aging(
    p_folder_uid uuid,        -- REQUIRED: injected by platform (folder context)
    p_user_id bigint,         -- REQUIRED: injected by platform (current user)
    p_as_of_date date DEFAULT NULL,    -- User parameter
    p_customer_id bigint DEFAULT NULL  -- User parameter (optional)
)
RETURNS TABLE ( customer_name text, current_amount numeric, total numeric )
LANGUAGE sql STABLE
AS $$
    SELECT c.account_name, SUM(...) , SUM(i.amount_due)
    FROM fin.invoice i JOIN crm.account c ON c.account_id = i.customer_id
    WHERE i.status <> 'Paid' AND (p_customer_id IS NULL OR i.customer_id = p_customer_id)
    GROUP BY c.account_name ORDER BY 3 DESC;
$$;
```

**Rules for SP functions:**
- First two params are **always** `p_folder_uid uuid` and `p_user_id bigint` — injected by the platform.
- User params come after, `DEFAULT NULL` for optional ones (order matches `params` declaration order).
- `RETURNS TABLE (...)` for a single set; `RETURNS SETOF refcursor` for multi-set (mapped via `parentRef`).
- Use the module's schema prefix (`crm.rpt_*`), `STABLE` volatility, and filter by `p_folder_uid` / `p_user_id` where needed — **security is your responsibility**.

## Parameters

Parameters prompt the user before running the report.

**Parameters are report-scoped**, so there are two legal declaration sites and they mean the same thing:

- **`parameters`** at report level — the canonical home, and the only one that fits a param several datasets use.
- **`datasets.<cd>.params`** — shorthand, fine when exactly one dataset uses it. Every module written before this existed uses it, and it stays fully supported.

The installer merges both into the report's single param set (**report level wins** on a code collision), so either way the param serves the whole report: the param bar, saved param sets, `@param` filters in *any* dataset, and record-report mappings.

> Why report-scoped: the declaration is stored once per report (`report.param_set_id` → `param_set`), the authoring API is `report.params.save`, and `report.get` flattens per-dataset defaults report-wide before use. There is no dataset-scoped parameter behaviour to choose between.

```json
"parameters": {
    "customer": { "fieldTypeCd": "lookup", "label": "Customer", "params": { "link": { "entity": "account" } } }
},
"datasets": {
    "sales": {
        "datasetType": "Q",
        "params": {
            "start_date": { "fieldTypeCd": "date", "label": "Start Date", "required": true, "default": "=STARTMONTH()" },
            "status":   { "domain": "fin.doc_status", "label": "Status" },
            "region": { "fieldTypeCd": "dropdown", "label": "Region", "params": { "options": [
                { "value": "north", "label": "North" }, { "value": "south", "label": "South" }
            ] } }
        },
        "query": { "entityCd": "invoice", "columns": ["invoice_number", "total"] }
    }
}
```

| Property | Description |
|---|---|
| `fieldTypeCd` | Control type: `date`, `datetime`, `text`, `number`, `dropdown`, `lookup`, `user`, `checkbox`. Omit when `domain` is set. |
| `domain` | Column domain (`domain_cd` or `module_cd.domain_cd`) supplying the control **and** the option list. Mutually exclusive with `fieldTypeCd` — declaring both is rejected at install. |
| `label` | Display label in the parameter dialog |
| `required` | Whether the user must fill this before running |
| `default` | Plain value or `=`-prefixed formula (`"=NOW()"`, `"=STARTMONTH()"`, `"=TODAY()"`) |
| `params` | Extra config — `options` for dropdowns, `link: { entity, otherKey? }` for lookups |
| `orderNum` | Display order in the parameter form (falls back to declaration order) |

Two spellings that look right and are silently ignored: **`isRequired`** (the key is `required`, so the param installs as optional) and a **top-level `link`** (it must be nested under `params`, so the lookup installs with no autocomplete). Both are validator errors.

**Dropdown params: prefer `domain`, and never ship bare codes.** A list shared with a column belongs on a `column_domain` — bind the param to it and the options plus their translations are authored once (`column-domains.md`). For a list that exists only for this report, write the rich option form (`{ "value": "north", "label": "North" }`); a bare `"options": ["north", "south"]` renders the raw codes in **every** locale, English included. Per-locale labels go under `reports.<cd>.params.<param_cd>.options` (`translations.md`).

Reference a parameter with `@param_code` inside a query filter value:

```json
"filter": { "g": "and", "i": [ { "c": "created_date", "o": "grEq", "v": "@start_date" } ] }
```

SP params are passed positionally after the two required system params, in `params` declaration order.

## Layout

`layout` is an **object** — `{ "panels": [ ... ] }` (not a bare array). Each panel binds a `vizType` to a `datasetCd`:

```json
"layout": {
    "panels": [
        { "vizType": "chart", "datasetCd": "pipeline", "title": "By Stage", "config": { "chartType": "bar", "categoryCol": "stage", "valueCol": "amount", "agg": "sum", "chartSize": "l" } },
        { "vizType": "kpi", "datasetCd": "pipeline", "title": "Pipeline KPIs", "config": { "metrics": [ { "column": "amount", "agg": "sum", "label": "Open Pipeline" } ] } },
        { "vizType": "table", "datasetCd": "pipeline", "title": "Detail" }
    ]
}
```

### Visualization types

The panel `vizType` is one of `table` / `chart` / `kpi` / `pivot` (also `tree`, `markdown`). **Chart type is set via `config.chartType`** — the panel `vizType` is always `"chart"` for any chart.

| `vizType` | Description | Config |
|---|---|---|
| `table` | Tabular data with sort/filter | optional `groupRules`, `aggregations`, `colorRules` |
| `chart` | Any chart — kind chosen by `config.chartType` | see below |
| `kpi` | One or more metric cards | `{ metrics: [ ... ] }` — see below |
| `pivot` | Pivot table | `rowFields`, `columnFields`, `values` |

**`config.chartType`** ∈ `bar` · `horizontalBar` · `stackedBar` · `combo` · `line` · `area` · `pie` · `doughnut` · `scatter` · `bubble` · `funnel` · `heatmap`.

Chart config: `{ chartType, categoryCol, valueCol, agg, seriesCol?, sizeCol?, chartSize? ('sm'|'m'|'l'|'xl'), clickAction?, showTrend?, series? }`. `agg` ∈ `sum|avg|min|max|count`.

### KPI config (metrics)

`config.metrics` is an array; each metric is one of two modes:

**Aggregation metric** — one column reduced by one aggregation:

```json
{ "column": "amount", "agg": "sum", "display": "value", "label": "Open Pipeline" }
```

Optional: `display` (`value|gauge|progress|sparkline|icon`), `label`, `target`/`min`/`max`, `icon`, `sparklineDimension`.

**Formula metric** — an expression over named aggregation *inputs* (ratios, derived numbers):

```json
{
    "label": "Avg Deal Size",
    "formula": "[total] / [n]",
    "inputs": [
        { "alias": "total", "column": "amount", "agg": "sum" },
        { "alias": "n",     "column": "amount", "agg": "count" }
    ],
    "format": { "style": "number", "decimals": 0 }
}
```

- `formula` references each input by `[alias]`. Missing alias → `0`; non-finite (÷0, NaN) → blank.
- `format.style` ∈ `number|percent`; `decimals` sets fraction digits. **Omit `format` (Auto)** to inherit the *first input column's own formatter* — a money formula then reads as money.

### Cross-source metrics & overlay series

A report already loads **multiple datasets**, so a KPI formula input or a chart overlay series can aggregate over a **sibling** dataset — reference it by its dataset code via `source` (omit = the panel's own `datasetCd`).

**Cross-dataset KPI** (pipeline vs leads):

```json
{ "vizType": "kpi", "datasetCd": "deals", "config": { "metrics": [
    { "label": "Total Funnel Value", "formula": "[pipeline] + [leadval]", "inputs": [
        { "alias": "pipeline", "column": "amount", "agg": "sum" },
        { "alias": "leadval", "column": "estimated_value", "agg": "sum", "source": "leads" }
    ] }
] } }
```

**Cross-source chart overlay** — `config.series` (a single object **or** an array) adds series aggregated from other datasets, aligned on a shared category axis. Supported on `bar`/`horizontalBar`/`line`/`area`. Categories are outer-joined; a missing bucket fills `0` (bar) or gaps with `null` (line/area). Keep each series' `categoryCol` matching the primary axis unless a different axis is intended.

```json
{ "vizType": "chart", "datasetCd": "deals", "config": {
    "chartType": "bar", "categoryCol": "lead_source", "valueCol": "amount", "agg": "sum",
    "series": { "source": "leads", "categoryCol": "lead_source", "valueCol": "estimated_value", "agg": "sum", "label": "Lead Value" }
} }
```

Dashboard KPI/chart *tiles* get the same support via a `sources` map in the tile config (authored with "Add source" in the tile dialog) — not part of a module's `ui/reports.json`.

### Chart size

`config.chartSize` ∈ `sm | m | l | xl` controls the default chart height (`m` when omitted).

## Record reports (`entities`)

A report can be **attached to an entity** so it opens from a record — the way a print template does — with the record's values feeding its parameters. Add an `entities` array to the report:

```json
"credit_check": {
    "description": "Customer Credit Check — limit against outstanding AR and open quotes",
    "entities": [
        { "entityCd": "parties.party", "params": { "customer_id": "party_id" }, "orderNum": 45 },
        { "entityCd": "crm.quote",     "params": { "customer_id": "customer_id" }, "orderNum": 45 }
    ],
    "parameters": {
        "customer_id": {
            "label": "Customer",
            "fieldTypeCd": "lookup",
            "params": { "link": { "entity": "parties.party" } },
            "required": true
        }
    },
    "layout": { "panels": [ { "vizType": "table", "datasetCd": "open_invoices" } ] },
    "datasets": {
        "open_invoices": {
            "caption": "Open Invoices",
            "datasetType": "Q",
            "query": {
                "entityCd": "invoice",
                "columns": ["invoice_number", "due_date", "amount_due"],
                "filter": { "g": "and", "i": [ { "c": "customer_id", "o": "eq", "v": "@customer_id" } ] }
            }
        }
    }
}
```

Each entry becomes one attachment row, and the report gains a toolbar entry on that entity's record. Note the two different `params` keys:

- `entities[].params` — the **mapping**: report param code → **source column on the attached entity**.
- `parameters` / `datasets.<cd>.params` — the param **declaration**. The mapping can only name codes declared in one of those.

| Rule | Detail |
|---|---|
| `entityCd` | Qualified `module.entity` for anything outside this module, and that module must be a **declared dependency**. |
| Source columns | The entity PK, a reference (`R`) column, or a bounded scalar (number, date/datetime, bool, dropdown/radio/flags code). `text`, `json`, `file`/`image` are rejected. |
| Types | Source and target must be compatible; only `lookup`↔`number` and `date`↔`datetime` widen. A names-only match like `{ "customer_id": "created_date" }` is an error, not a runtime surprise. |
| One per pair | One attachment per (entity, report). Two entries for the same entity overwrite each other. |
| Unmapped params | Keep their normal behaviour — default value, or prompt the user. |
| Mapped params | Are **hidden** on the record-report page. The URL is about this record; pivoting means going back to a record. |
| Dependency | Declare `"metadata": ">=1.5.0"` — the attachment table ships with the metadata system module, so this is the gate that fails loudly on an older platform instead of the attachment quietly doing nothing. This is metadata's **`version`**; dependency ranges are never checked against `dbSchemaVersion`, so do not use the `1.4.0` of the migration that creates the table. |
| Rights | Report `E` is still required. A bridge role must grant `E` on the report **and** `S` on the dataset entities. |

There is no `canExecute` on an attachment: if the record exists the report is meaningful for it, and an empty report is a legitimate answer.

> **Prefer a record report over an action that calculates.** See *When an action is the wrong tool* in `references/action-dsl.md`. If the `execute:` block only reads, computes and `info()`s a number, it is not an action — a printed number is never stored, can't be re-read, and shows the verdict without the working. Attach a report instead: it gets you KPI tiles, charts, the underlying rows, drill-through, saved layouts and row caps for free, and the DSL you don't write is DSL that can't drift from the data.
>
> Keep it an action when it **changes** something — writing the result to a column, creating a record, or *blocking* a transition. "Explain the number" is a report; "refuse the over-limit quote" is an action or trigger.

## Grants

Grant report access with the `E` right — a **colon** prefix, never a dot:

```json
"rights": { "report:sales_pipeline": "E" }
```

A dependency's report is granted with the qualified form, `"report:fin.ar_aging": "E"` — bridge modules need this to grant on a report they attach but do not own.

## Common mistakes

- Using a bare `"layout": [ ... ]` array — `layout` is an **object**: `"layout": { "panels": [ ... ] }`.
- Setting the chart kind as `vizType` (`"vizType": "bar"`) — the panel `vizType` is `"chart"`; the kind goes in `config.chartType`.
- Using `entityCode` / `groupBy` / `aggregations` on a dataset — use `query.entityCd` + `query.columns`, and aggregate in the viz (`agg`, `metrics`).
- Using `sp` / `procedureName` for an SP dataset — the field is `spCd`.
- Forgetting `columnsDef` on an SP dataset — **required**.
- Forgetting to grant `E` on the report in at least one role — it becomes invisible.
- Writing the rights key as `report.<code>` — actions/reports/folders take a **colon**: `report:<code>`.
- Writing `isRequired` instead of `required`, or a top-level `link` instead of `params.link` — both are ignored at install.
- Declaring both `fieldTypeCd` and `domain` on one param — install rejects the pair rather than picking a winner.
- Mapping a record-report attachment onto a param no dataset declares, or from a `text`/`json` column — both are rejected.
- Attaching a report to another module's entity without declaring that module as a dependency.
- Forgetting `p_folder_uid` / `p_user_id` as the first two SP function params — the call fails.
- Referencing a parameter as `$param` — use `@param_code` in filters.
- Writing an action that computes a number and `info()`s it, where a record report would show the working.
