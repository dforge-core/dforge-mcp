# matrix-budget — matrix (pivot) view example

A minimal module whose only job is to demonstrate the `matrix` data view. The
simple-todo example has no cross-tab domain, so the matrix shape lives here.

## The shape

A matrix view is `rowAxis × colAxis` with a **cell** entity holding one record
per intersection. Here:

| Piece | Maps to |
|---|---|
| `rowAxis` | `budget_category` records (a **dataset** axis), labelled by `name`, sorted by `code` |
| `colAxis` | the `quarter` dropdown options Q1–Q4 (a **dropdown** axis: `"budget_line.quarter"`) |
| `cell` | a `budget_line` record per (category, quarter); the editable value is `amount` |

So the grid reads: budget categories down the side, quarters across the top,
an editable amount in each cell.

## What it illustrates

- **Two axis kinds in one view** — a `dataset` row axis and a `dropdown` column
  axis (the only worked example of the dropdown axis).
- **Editable cells** (`cell.editable: true`) — typing in an empty cell inserts a
  `budget_line`; the matrix fills `rowKey` (`category_id`) and `colKey`
  (`quarter`) automatically from the row/column it sits in.
- The **cell entity is the view's primary `dataSources` entity**, and
  `cell.rowKey` / `cell.colKey` are real columns on it.

For a read-only `dataset × dataset` matrix (P&L: accounts × periods) plus the
`date` axis and the `lockedField` / `drill` / `seedFromRow` options, see the
§Matrix section of `dforge://reference/data-views`.

## Files

```
manifest.json
entities/budget_category.json   row-axis (dataset) entity
entities/budget_line.json       cell entity (FK+Reference + quarter dropdown + amount)
ui/data_views.json              the matrix view (+ a categories grid)
security/roles.json             S on the axis, SIUD on the editable cell
seed-data/01-categories.json    three categories to populate the rows
```
