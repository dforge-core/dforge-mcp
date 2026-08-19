# column-security — entity views example

A minimal module whose only job is to demonstrate **entity views**: dForge's
column-level security. One `product` entity holds both stock and pricing, and two
folders show two different column sets of it.

## The shape

Column-level security is always **two halves**, and both are required:

| Piece | File | Effect |
|---|---|---|
| The column set | `entities/product.json` → `views` | Declares `storekeeper` and `accountant` — each a named subset of the entity's columns |
| The binding | `ui/folders.json` → `entities.product.viewName` | The Warehouse folder binds `storekeeper`, the Finance folder binds `accountant` |

```
product columns:  name  sku  quantity  cost_price  sale_price  margin

Warehouse folder → view "storekeeper":  name  sku  quantity
Finance folder   → view "accountant":   name  sku  quantity(read-only)  cost_price  sale_price  margin
```

A user working in Warehouse cannot see `cost_price` **at all** — not on screen, not
through a filter, not in an export. The columns a view omits are invisible *and*
unqueryable there. That is the mechanism: omission is the restriction.

## What each view demonstrates

- **`storekeeper`** — the plain case: list the columns this folder may see, and no
  others. Note it still lists `product_id`; a view must include the primary key
  because records are addressed by it.
- **`accountant`** — the override cases:
  - `"quantity": { "flags": "V" }` — visible but **not** editable here, while the
    entity itself declares `VEM`. A per-column `flags` override re-flags the column
    for the folders bound to this view only.
  - `"margin": { "formula": "…", "displayFmt": "N1" }` — a per-view **formula**
    override: the entity computes margin as an absolute amount, this view computes it
    as a percentage. Allowed only because `margin` is a `columnType: "F"` column — on
    any other column that field holds the SQL default, so the override would be inert
    and the install rejects it.

## Things that would fail the install

Worth knowing, because each one is silent at runtime if it slips through:

- Dropping `product_id` from a view — records the client cannot open or save.
- A view with **no** columns, or a column code the entity doesn't have.
- Two views whose names differ only by case — a folder binds case-insensitively, so
  only one could ever be reached.
- A `viewName` in `folders.json` that no view declares. This does **not** fall back:
  the fallback would be the entity's full column set, so a typo would quietly
  *unrestrict* the folder. `"default"` is the one exempt name and means "no view".

`dforge_module_validate` checks all of these offline, before packing.

## What this example deliberately leaves out

The `product_grid` data view lists **every** column, including the prices. That is
correct: a data view describes the presentation, and the folder's entity view decides
what a user in that folder is allowed to see of it. The grid renders whichever
columns survive the view — you do not maintain one data view per role.

Entity views are also unrelated to the two other things called "view" here: a *data
view* (`ui/data_views.json`) is a grid/kanban/calendar, and `isView` + `viewSql` on an
entity means it is backed by a SQL view.

See `dforge://reference/security` → Column-level security for the full rules.
