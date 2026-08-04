# Module Conventions Reference

Rules that apply across the entire module package. Violating these produces technically-valid but non-idiomatic modules, and in several cases breaks the installer.

## Naming

| Thing | Convention | Example |
|---|---|---|
| Module `code` | lowercase, letters/digits/underscore | `crm`, `my_module`, `wms_fin` |
| Entity keys / `dbObject` | `snake_case`, singular | `contact`, `opportunity_line` |
| Column codes | `snake_case` | `first_name`, `account_id` |
| Data view codes | `snake_case` | `contact_list`, `deal_kanban` |
| Report codes | `snake_case` | `sales_pipeline` |
| Action codes | `snake_case` | `change_stage`, `send_welcome` |
| Menu codes | `snake_case` | `sales`, `pipeline` |
| Role codes | `snake_case`, domain-specific | `sales_rep`, `sales_admin` |
| Setting codes | `snake_case` | `vat_rate`, `invoice_prefix` |
| Trait names | lowercase single word | `identity`, `audit` |
| Seed data files | numbered prefix | `01-countries.json`, `02-currencies.json` |
| Action DSL files | `<action_code>.dsl` | `change_stage.dsl` |
| Reference keys | `FK_<FromEntity>_<Purpose>` | `FK_Contact_Account` |

Everything is **case-sensitive**. Don't mix snake_case and camelCase.

## File layout

Standard module directory structure:

```
my_module/
├── manifest.json
├── README.md                    # module overview
├── CHANGELOG.md                 # version history
├── MODULE-INFO.md               # user-facing intro (shown in module picker)
├── entities/
│   └── <entity>.json
├── logic/
│   └── actions/
│       └── <action>.dsl
├── ui/
│   ├── data_views.json
│   ├── menus.json
│   ├── actions.json
│   ├── folders.json
│   └── reports/
│       └── <report>.json
├── security/
│   └── roles.json
├── settings.json
├── seed-data/
│   ├── 01-<first>.json
│   └── 02-<second>.json
├── translations/
│   └── de-DE.json              # IETF tags, one file per non-English locale
├── print_templates/
│   └── <template>.scriban
├── files/                       # static assets
└── webhooks.json                # optional
```

Only include what your module actually uses — not every module needs `print_templates/` or `webhooks.json`.

## The FK+Reference pattern (again, because it's critical)

**Every reference to another entity is two columns**:

1. Hidden FK column with `flags: "E"` — `"EM"` when the relation is genuinely required — and `dbDatatype` matching the target PK type
2. Visible Reference column with `columnType: "R"`, `fieldTypeCd: "lookup"`, `flags: "VE"` / `"VEM"` **matching the FK**, and a `link` object pointing at the target

`M` resolves to `isNullable: false` at install, so it is what makes the FK column `NOT NULL` — keep the two halves in step. `dforge_entity_reference_add({ required })` emits both correctly.

Plus the actual FK constraint declared in the entity's `references` block.

See `column-types.md` for the full example.

## Bridge modules

When two core modules need to integrate (e.g. CRM and Finance), create a **bridge module**:

- Name it with a hyphen: `crm-fin`, `wms-fin`, `crm-pricing`
- Depends on **both** core modules
- Owns the integration: extension entities, cross-module actions, cross-module data views
- Core modules stay independent and don't know about each other

Extension entities in a bridge module have `"extends": "fin.invoice"` at the top. Physical columns in the extension go into a 1:1 ext table.

## Seed data ordering

Seed files run in numeric prefix order. Put entities with FK dependencies **after** their targets:

```
seed-data/
├── 01-currencies.json          # no FKs, insert first
├── 02-countries.json           # references currency
├── 03-regions.json             # references country
└── 04-offices.json             # references region
```

Each seed file has two top-level keys: `"entityCode"` (NOT `"entity"`) and `"records"` (array). **Using `"entity"` instead of `"entityCode"` is a silent failure** — the installer reads an empty entity code and the INSERT fails.

Use explicit **numeric** PKs in seed data so cross-file references work. The `identity` trait creates `cuid` columns which are `int8` (bigint) — **NOT UUIDs**. Use simple integers like `1001`, `1002`:

```json
{
    "entityCode": "country",
    "records": [
        { "country_id": 1001, "code": "US", "name": "United States" },
        { "country_id": 1002, "code": "DE", "name": "Germany" }
    ]
}
```

**Common mistake**: using UUID strings like `"10000000-0000-0000-0000-000000000001"` — **wrong**. The `cuid` datatype is a numeric `int8`, not a UUID string. Seed data PKs must be numbers. Use a numbering scheme that avoids collisions (e.g. 1001-1099 for countries, 2001-2099 for regions, etc.).

## Translations

Translation files live in `translations/` and are named after the **IETF locale tag** (`de-DE.json`, `uk-UA.json`, etc.). Filenames are auto-discovered; declare which ones you ship in `manifest.supportedLocales`. English is the default — labels and descriptions live in entity/view JSON, so **don't** create `en.json` or `en-US.json` (they're skipped by the installer).

```json
// translations/de-DE.json
{
    "contact": "Kontakt",
    "account": "Kunde",
    "contact_list.label": "Alle Kontakte"
}
```

Missing keys fall back to the English value declared in the source JSON.

## Versioning — always bump before packaging

The manifest has **two version numbers** that must be managed:

| Field | When to bump | Example |
|---|---|---|
| `version` | **Every release** — any change at all (bug fix, feature, schema change) | `0.1.0` → `0.2.0` |
| `dbSchemaVersion` | **Only when the DB schema changes** — new entity, new column, removed column, changed type, new constraint, new index | `0.0.1` → `0.0.2` |

Both use **semver** (`MAJOR.MINOR.PATCH`).

**Rules**:

- If you added an action but no new columns → bump `version` only, keep `dbSchemaVersion`.
- If you added a new entity or column → bump both `version` and `dbSchemaVersion`.
- If you changed a view or menu → bump `version` only.
- If you changed translations only → bump `version` only.
- The installer uses `dbSchemaVersion` to decide whether to run schema migrations. Wrong version = skipped migrations.
- **Never ship a package without bumping at least `version`** from the previous release. The installer may reject or silently skip a re-install with the same version.
- For brand-new modules, start at `version: "0.1.0"` and `dbSchemaVersion: "0.0.1"`.

## `orderNum` — always set it

On every column, data view, menu item, setting, and action that appears in a list. Without `orderNum`, UI ordering is undefined. Use widely-spaced values (10, 20, 30, 40) so you can insert between them later.

## Consistency across the module

- All timestamps use the same trait (`audit`)
- All primary keys use the same trait (`identity`) with consistent PK type (`cuid`)
- All entities have `toString`
- All views use `dataSources` array
- All roles use `rights`
- All menus use nested dicts + `dataViewCode`
- All actions have `canExecute:` (even if it's just `true`)

## Do not invent

- Do not invent field types (`rating`, `geolocation`, `signature`) — not in the catalog
- Do not invent column types beyond `D` / `R` / `S` / `F`
- Do not invent role rights letters beyond `SIUDC` + `E`
- Do not invent view types beyond the registered ones
- Do not invent menu item types beyond `V` / `R` / `D` / `A`
- Do not invent DSL functions
- Do not invent formula functions

If you genuinely need something new, **say so** and ask the user how to work around it with existing primitives.

## Reference

This file summarises the key conventions. If you need to verify a pattern not covered here, ask the user or check the reference modules in the `examples/` directory.
