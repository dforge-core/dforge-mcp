# Reports Reference

Reports are **query-driven visualizations** — charts, KPI cards, pivot tables, tables — backed by datasets. Unlike data views (which target one entity), a report can combine **multiple datasets** and lay out several panels.

Lives in: `ui/reports.json` (map of `report_code` → report). Not listed in `manifest.json` — the install pipeline picks up `ui/reports.json` automatically.
SP files: `logic/reports/rpt_*.sql`

## Structure

A report has `description`, a `datasets` map, a `layout` object (`{ panels: [...] }`), and optional `parameters`. Panels reference datasets by code via `datasetCd`.

```json
{
    "sales_pipeline": {
        "description": "Open opportunities by stage",
        "datasets": {
            "pipeline": {
                "caption": "Pipeline Data",
                "datasetType": "Q",
                "query": {
                    "entityCd": "opportunity",
                    "columns": ["stage", "amount", "lead_source", "customer.name"],
                    "filter": {
                        "g": "and",
                        "i": [ { "c": "stage", "o": "nIn", "v": ["Closed Won", "Closed Lost"] } ]
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
        },
        "parameters": {
            "min_amount": { "fieldTypeCd": "number", "label": "Min Amount", "required": false, "default": 0 }
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
        "filter": { "c": "stage", "o": "ne", "v": "Closed Lost" },
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
        "customer_id": { "fieldTypeCd": "lookup", "label": "Customer", "required": false, "params": { "entityCd": "account" } }
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
- Params can be per-dataset or per-report.

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

Parameters prompt the user before running the report. Declare them per-report (`parameters`) or per-dataset (`params`).

```json
"parameters": {
    "start_date": { "fieldTypeCd": "date", "label": "Start Date", "required": true, "default": "=STARTMONTH()" },
    "region": { "fieldTypeCd": "dropdown", "label": "Region", "params": { "options": ["All", "North", "South"] } },
    "customer": { "fieldTypeCd": "lookup", "label": "Customer", "params": { "entityCd": "account" } }
}
```

| Property | Description |
|---|---|
| `fieldTypeCd` | Control type: `date`, `datetime`, `text`, `number`, `dropdown`, `lookup`, `user`, `checkbox` |
| `label` | Display label in the parameter dialog |
| `required` | Whether the user must fill this before running |
| `default` | Plain value or `=`-prefixed formula (`"=NOW()"`, `"=STARTMONTH()"`, `"=TODAY()"`) |
| `params` | Extra config — `options` for dropdowns, `entityCd` for lookups |
| `orderNum` | Display order in the parameter form (falls back to declaration order) |

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

## Grants

Grant report access with the `E` right:

```json
"rights": { "report.sales_pipeline": "E" }
```

## Common mistakes

- Using a bare `"layout": [ ... ]` array — `layout` is an **object**: `"layout": { "panels": [ ... ] }`.
- Setting the chart kind as `vizType` (`"vizType": "bar"`) — the panel `vizType` is `"chart"`; the kind goes in `config.chartType`.
- Using `entityCode` / `groupBy` / `aggregations` on a dataset — use `query.entityCd` + `query.columns`, and aggregate in the viz (`agg`, `metrics`).
- Using `sp` / `procedureName` for an SP dataset — the field is `spCd`.
- Forgetting `columnsDef` on an SP dataset — **required**.
- Forgetting to grant `E` on the report in at least one role — it becomes invisible.
- Forgetting `p_folder_uid` / `p_user_id` as the first two SP function params — the call fails.
- Referencing a parameter as `$param` — use `@param_code` in filters.
