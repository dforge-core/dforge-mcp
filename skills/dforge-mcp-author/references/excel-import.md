# Importing a data model from a spreadsheet (.xlsx / .csv)

When the user gives you a spreadsheet to turn into a module, you can't read a
binary `.xlsx` directly — decode it first, then reason over the result.

## Flow

1. **Extract the sheets to a JSON model.** Call `dforge_xlsx_extract({ filePath: "<absolute/path/to/file.xlsx>" })`.
   It returns `{"sheets":[{"name":..,"headers":[..],"rows":[[..],..]}]}`.
   If it errors with "Python 3 not found", fall back: ask the user to export each
   sheet as **CSV** (CSV is plain text — read it directly).

2. **Turn the model into a table-spec.** For each sheet:
   - `name` = the sheet name, snake_cased (`"Order Lines"` → `order_lines`).
   - One **column** per header: `name` = header snake_cased; `sampleValues` =
     that column's values from `rows` (a few are enough). Don't set `fieldTypeCd`
     unless you're sure — let the import infer it. Add a `sqlType` hint only when
     the values make the type obvious (all integers → `int`, decimals → `numeric`,
     `YYYY-MM-DD` strings → `date`; remember xlsx **dates arrive as numbers**, so
     lean on the header name, e.g. `*_date`, to spot them).
   - **References (FKs):** when a column looks like a foreign key — header
     `<thing>_id` (or `<thing> id`) where `<thing>` matches another sheet — put it
     in `references: [{ column, toTable }]` instead of as a plain column.
   - Skip an `id` / primary-key column — the `identity` trait provides `{entity}_id`.

3. **Show the proposed entity inventory for sign-off** (same gate as any Phase 1
   scaffold), then call **`dforge_module_import`**:
   - existing module → `{ moduleDir, tables }`
   - new module → add `module: { code, displayName }` (greenfield).

4. **Run `dforge_module_validate`** and refine the generated default grids to
   surface the imported columns.

## With data or empty — both work

A sheet may be **populated** (headers + rows) or **structure-only** (headers, no
data rows). Both produce a valid entity:

- **Populated** → use the `sampleValues` for type inference (numbers, dates,
  dropdowns). Best results.
- **Empty (headers only)** → the extractor returns `"rows": []`. You still get
  one column per header, but with no samples the import defaults most columns to
  `text` — so lean on the **header name** (`email`, `phone`, `*_date`, `*_id` →
  FK) and add `sqlType` hints where the user can tell you the type. Consider
  confirming the inferred types with the user before importing.

## Notes

- One worksheet (or one Excel table object) = one entity. Ignore obviously
  non-tabular sheets (dashboards, notes).
- The extractor returns the first non-empty row as `headers`; if a sheet has
  title rows above the real header, tell the user or adjust the spec by hand.
- Type inference + the FK+Reference pattern are handled by `dforge_module_import`
  against the `@dforge-core/metadata` registry — you only produce the table-spec.
