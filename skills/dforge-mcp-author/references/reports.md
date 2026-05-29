# Reports Reference

Reports are **query-driven visualizations** — charts, KPIs, pivot tables, grids — backed by datasets. Unlike data views (which target one entity), reports can combine multiple datasets and render any layout.

Lives in: `ui/reports.json` or `ui/reports/<report_code>.json`
SP files: `logic/reports/rpt_*.sql`

## Structure

```json
{
    "sales_pipeline": {
        "description": "Open opportunities by stage",
        "datasets": {
            "ds_pipeline": {
                "caption": "Pipeline Data",
                "entityCode": "opportunity",
                "columns": ["stage", "total_amount", "account"],
                "filter": {
                    "g": "and",
                    "i": [
                        { "c": "stage", "o": "!in", "v": ["Closed Won", "Closed Lost"] }
                    ]
                },
                "groupBy": ["stage"],
                "aggregations": {
                    "opp_count": { "func": "count", "column": "*" },
                    "total_value": { "func": "sum", "column": "total_amount" }
                }
            }
        },
        "layout": [
            {
                "vizType": "bar",
                "datasetCd": "ds_pipeline",
                "title": "Pipeline Value by Stage",
                "config": {
                    "categoryCol": "stage",
                    "valueCol": "total_value",
                    "agg": "sum"
                }
            },
            {
                "vizType": "grid",
                "datasetCd": "ds_pipeline",
                "title": "Pipeline Detail"
            }
        ],
        "params": {
            "owner_filter": {
                "fieldTypeCd": "user",
                "label": "Filter by Owner",
                "required": false
            },
            "start_date": {
                "fieldTypeCd": "date",
                "label": "Start Date",
                "required": false,
                "default": "=STARTMONTH()"
            }
        }
    }
}
```

## Dataset types

### Entity query dataset (most common)

Queries an entity's data using the platform's query builder. Filters use the standard JSON filter format (see `references/filters.md`).

```json
"ds_sales": {
    "caption": "Sales Data",
    "entityCode": "opportunity",
    "columns": ["stage", "total_amount", "close_date", "account"],
    "filter": { "c": "stage", "o": "!=", "v": "Closed Lost" },
    "sort": [{ "column_cd": "close_date", "direction": "desc" }],
    "groupBy": ["stage"],
    "aggregations": {
        "deal_count": { "func": "count", "column": "*" },
        "total_value": { "func": "sum", "column": "total_amount" },
        "avg_value": { "func": "avg", "column": "total_amount" }
    }
}
```

Aggregation functions: `count`, `sum`, `avg`, `min`, `max`.

### Stored procedure dataset (developer path)

For complex SQL that the entity query can't express — window functions, CTEs, cross-schema joins, conditional aggregation, multi-result sets.

```json
"aging_data": {
    "caption": "AR Aging",
    "datasetType": "S",
    "sp": "rpt_ar_aging",
    "params": {
        "as_of_date": {
            "fieldTypeCd": "date",
            "label": "As of Date",
            "required": true,
            "default": "=NOW()"
        },
        "customer_id": {
            "fieldTypeCd": "lookup",
            "label": "Customer",
            "required": false,
            "params": { "entityCd": "customer" }
        }
    },
    "columnsDef": {
        "customer_name": {
            "label": "Customer",
            "fieldTypeCd": "text",
            "baseDatatypeCd": "string",
            "width": 200
        },
        "current_amount": {
            "label": "Current",
            "fieldTypeCd": "number",
            "baseDatatypeCd": "number",
            "format": "#,##0.00",
            "width": 120
        },
        "days_30": {
            "label": "1-30 Days",
            "fieldTypeCd": "number",
            "baseDatatypeCd": "number",
            "format": "#,##0.00",
            "width": 120
        },
        "total": {
            "label": "Total",
            "fieldTypeCd": "number",
            "baseDatatypeCd": "number",
            "format": "#,##0.00",
            "width": 130
        }
    }
}
```

Key differences from entity datasets:
- `datasetType: "S"` (instead of default entity query)
- `sp` — the stored procedure function name (without schema — uses the module's schema)
- `columnsDef` — **required** — explicitly defines columns since the platform can't infer them from entity metadata
- Params can be defined per-dataset (dataset-level) or per-report (report-level)

### The PostgreSQL function

SP files live in `logic/reports/` and follow this convention:

```sql
CREATE OR REPLACE FUNCTION crm.rpt_ar_aging(
    p_folder_uid uuid,        -- REQUIRED: injected by platform (folder context)
    p_user_id bigint,         -- REQUIRED: injected by platform (current user)
    p_as_of_date date DEFAULT NULL,    -- User parameter
    p_customer_id bigint DEFAULT NULL  -- User parameter (optional)
)
RETURNS TABLE (
    customer_name text,
    current_amount numeric,
    days_30 numeric,
    days_60 numeric,
    days_90 numeric,
    over_90 numeric,
    total numeric
)
LANGUAGE sql STABLE
AS $$
    SELECT
        c.account_name AS customer_name,
        SUM(CASE WHEN age <= 30 THEN i.amount_due ELSE 0 END) AS current_amount,
        SUM(CASE WHEN age BETWEEN 31 AND 60 THEN i.amount_due ELSE 0 END) AS days_30,
        -- ... more columns ...
        SUM(i.amount_due) AS total
    FROM fin.invoice i
    JOIN crm.account c ON c.account_id = i.customer_id
    WHERE i.status != 'Paid'
      AND (p_customer_id IS NULL OR i.customer_id = p_customer_id)
    GROUP BY c.account_name
    ORDER BY total DESC;
$$;
```

**Rules for SP functions:**
- First two params are **always** `p_folder_uid uuid` and `p_user_id bigint` — injected by the platform
- User params come after, with `DEFAULT NULL` for optional ones
- Use `RETURNS TABLE (...)` for single result sets
- Use `RETURNS SETOF refcursor` for multiple result sets (advanced)
- Use the module's schema prefix: `crm.rpt_*`, `fin.rpt_*`, etc.
- Use `STABLE` volatility (read-only, enables PostgreSQL optimization)
- **Security is your responsibility** — filter by `p_folder_uid` and `p_user_id` where needed

### Multi-result-set SPs

For reports with multiple related datasets from one query:

```json
"datasets": {
    "summary": {
        "caption": "Department Summary",
        "datasetType": "S",
        "sp": "rpt_department_overview",
        "spCursor": "department_summary",
        "columnsDef": { /* ... */ }
    },
    "by_role": {
        "caption": "By Role",
        "datasetType": "S",
        "sp": "rpt_department_overview",
        "spCursor": "employee_breakdown",
        "columnsDef": { /* ... */ }
    }
}
```

Multiple datasets share the same `sp` (function called once). `spCursor` maps each dataset to a named refcursor returned by the function.

## Parameters

Parameters prompt the user for input before running the report (or action). Both reports and actions use the same parameter system.

### Report-level parameters

Defined in the report's `params` object:

```json
"params": {
    "start_date": {
        "fieldTypeCd": "date",
        "label": "Start Date",
        "required": true,
        "default": "=STARTMONTH()"
    },
    "end_date": {
        "fieldTypeCd": "date",
        "label": "End Date",
        "required": true,
        "default": "=NOW()"
    },
    "region": {
        "fieldTypeCd": "dropdown",
        "label": "Region",
        "required": false,
        "params": {
            "options": ["All", "North", "South", "East", "West"]
        }
    },
    "customer": {
        "fieldTypeCd": "lookup",
        "label": "Customer",
        "required": false,
        "params": { "entityCd": "account" }
    }
}
```

### Parameter properties

| Property | Description |
|---|---|
| `fieldTypeCd` | UI control type: `date`, `datetime`, `text`, `number`, `dropdown`, `lookup`, `user`, `checkbox` |
| `label` | Display label in the parameter dialog |
| `required` | Whether the user must fill this before running |
| `default` | Default value — plain value or formula with `=` prefix (e.g. `"=NOW()"`, `"=STARTMONTH()"`, `"=TODAY()"`) |
| `params` | Additional config — `options` for dropdowns, `entityCd` for lookups |

### Using parameters in entity query filters

Reference parameters with `@param_code` in filter values:

```json
"filter": {
    "g": "and",
    "i": [
        { "c": "created_date", "o": ">=", "v": "@start_date" },
        { "c": "created_date", "o": "<=", "v": "@end_date" }
    ]
}
```

### Using parameters in SP datasets

Parameters are passed to the PostgreSQL function as positional arguments (after the two required system params). The order matches `params` declaration order in the dataset definition.

### Action parameters (DSL)

Actions declare parameters in the `params:` block of the DSL file:

```
params:
    new_stage: dropdown required "New Stage"
    note: textarea "Note"
    amount: number required "Amount"
```

Access in execute block: `params[param_name]`

See `references/action-dsl.md` for full syntax.

### Named parameter sets (saved combos)

Users can save frequently-used parameter combinations for quick reuse. These are stored per-report or per-action and appear in a dropdown at the top of the parameter dialog. Defined at runtime (not in the module package).

### Cross-parameter validation

Parameters can have cross-validation rules (e.g. `end_date >= start_date`). This is configured via a `validate` formula on the parameter set. For module packages, validation is typically handled by sensible defaults rather than explicit cross-validation formulas.

## Layout

The `layout` array defines how datasets are visualized:

```json
"layout": [
    {
        "vizType": "bar",
        "datasetCd": "ds_pipeline",
        "title": "Pipeline by Stage",
        "config": {
            "categoryCol": "stage",
            "valueCol": "total_value",
            "agg": "sum",
            "chartSize": "l"
        }
    },
    {
        "vizType": "grid",
        "datasetCd": "ds_pipeline",
        "title": "Detail"
    },
    {
        "vizType": "kpi",
        "datasetCd": "ds_pipeline",
        "title": "Total Value",
        "config": {
            "valueCol": "total_value",
            "format": "currency"
        }
    },
    {
        "vizType": "pie",
        "datasetCd": "ds_pipeline",
        "title": "Distribution",
        "config": {
            "categoryCol": "stage",
            "valueCol": "opp_count"
        }
    }
]
```

### Visualization types

| `vizType` | Description | Config |
|---|---|---|
| `grid` | Tabular data with sort/filter | — |
| `bar` | Vertical bar chart | `categoryCol`, `valueCol`, `agg` |
| `bar-stacked` | Stacked vertical bar | `categoryCol`, `valueCol`, `stackCol`, `agg` |
| `h-bar` | Horizontal bar | Same as `bar` |
| `line` | Line chart | `categoryCol`, `valueCol`, `agg` |
| `area` | Area chart | Same as `line` |
| `pie` | Pie chart | `categoryCol`, `valueCol` |
| `doughnut` | Doughnut chart | Same as `pie` |
| `scatter` | Scatter plot | `xCol`, `yCol` |
| `combo` | Combined bar + line | `categoryCol`, `barCol`, `lineCol` |
| `kpi` | Single value card | `valueCol`, `format` (optional: gauge, progress, sparkline, icon variants) |
| `pivot` | Pivot table | `rowCols`, `colCols`, `valueCols`, `aggFunc` |

### Chart size

Chart visualizations support an optional `config.chartSize` property to control the default display height.

| Field | Type | Allowed values | Description |
|---|---|---|---|
| `config.chartSize` | string | `sm`, `m`, `l`, `xl` | Optional size preset for chart height. When omitted, the default is `m`. |

## Grants

Report access is granted via the `E` right:

```json
"rights": {
    "report.sales_pipeline": "E"
}
```

## Common mistakes

- Mixing `entityCode` + SP fields (`datasetType`, `sp`, `columnsDef`) in the same dataset — pick one source type.
- Forgetting `columnsDef` on SP datasets — **required** (platform can't infer columns from a function).
- Forgetting to grant `E` access in at least one role — report becomes invisible.
- Forgetting `p_folder_uid` and `p_user_id` as first two SP function params — call will fail.
- Using `panels` instead of `layout` for the visualization array — use `layout`.
- Using `widget` instead of `vizType` — use `vizType`.
- Referencing a parameter as `$param` — use `@param_code` in filters.
