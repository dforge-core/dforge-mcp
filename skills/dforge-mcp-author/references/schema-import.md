# Schema Import Reference

When the user provides an existing database schema (DBML file, SQL DDL, or a description of their current tables), convert it into a dForge module. This is one of the most valuable things you can do — it turns hours of manual work into a few minutes of conversation.

## Supported inputs

| Input | How to handle |
|---|---|
| `.dbml` file | Parse the DBML syntax directly — tables, columns, refs, enums, notes |
| `.sql` file (DDL) | Parse `CREATE TABLE`, `FOREIGN KEY`, `CHECK`, `UNIQUE`, column types, comments |
| Pasted table description | Treat as informal spec, ask clarifying questions |
| ERD image / diagram | Describe what you see and confirm with the user |

## Conversion process

### Step 1: Identify entities

Each table in the source becomes a dForge entity. Apply naming conventions:

- Table name → entity `dbObject` (lowercase `snake_case`, singular)
- `CUSTOMERS` → `customer`, `tbl_OrderLines` → `order_line`
- Ask the user if naming is ambiguous

### Step 2: Map columns

For each column, determine `fieldTypeCd`, `baseDatatypeCd`, `dbDatatype`, `flags`, and params.

**Type mapping table:**

| Source type | `fieldTypeCd` | `baseDatatypeCd` | `dbDatatype` | Notes |
|---|---|---|---|---|
| `varchar(n)`, `char(n)`, `text` | `text` | `string` | `varchar` | Set `maxLen` from `n` |
| Column named `*email*` | `email` | `string` | `varchar` | Name heuristic |
| Column named `*phone*`, `*tel*`, `*mobile*` | `phone` | `string` | `varchar` | Name heuristic |
| Column named `*url*`, `*website*` | `url` | `string` | `varchar` | Name heuristic |
| `text` (large / multiline context) | `textarea` | `string` | `text` | |
| `int`, `integer`, `bigint`, `smallint` | `number` | `number` | `int4` or `int8` | |
| `numeric(p,s)`, `decimal(p,s)` | `number` | `number` | `numeric` | Set `params.scale` |
| Column named `*price*`, `*amount*`, `*cost*`, `*total*` | `currency` | `number` | `numeric` | Ask user for currency code |
| `numeric` with CHECK `>= 0 AND <= 100` | `percent` | `number` | `numeric` | |
| `boolean`, `bool`, `bit` | `checkbox` | `bool` | `bool` | |
| `date` | `date` | `date` | `date` | |
| `timestamp`, `timestamptz`, `datetime` | `datetime` | `timestamp` | `timestamptz` | |
| `time` | `time` | `time` | `time` | |
| `json`, `jsonb` | `json` | `json` | `jsonb` | |
| `uuid` (non-PK, non-FK) | `text` | `string` | `varchar` | |
| `bytea`, `blob` | `file` | `binary` | — | Best guess, confirm with user |
| DBML `enum` | `dropdown` | `string` | `varchar` | Extract values to `params.options` |
| `varchar` with `CHECK IN (…)` | `dropdown` | `string` | `varchar` | Extract to `params.options` |

### Step 3: Detect audit columns → traits

Look for common audit column patterns and replace them with traits:

| Source columns | Replace with |
|---|---|
| `created_at` + `updated_at` (timestamps only) | `traits: ["audit"]` — remove those columns from `fields` |
| `created_at` + `created_by` + `updated_at` + `updated_by` | `traits: ["audit-full"]` — remove all four |
| `created_date` + `last_updated` | `traits: ["audit"]` — remove both |
| `deleted_at` or `is_active` / `active` (soft delete) | Add `"soft-delete"` to traits |
| `sort_order` / `order_num` / `display_order` | Add `"sorting"` to traits |

If the source uses non-standard audit column names (e.g. `date_created`, `modified_by_user`), still convert them to traits and note the mapping.

### Step 4: Detect PKs → identity trait

| Source PK | Action |
|---|---|
| Single column `id`, `{table}_id` (integer or uuid) | Use `traits: ["identity"]` — don't declare the PK column manually |
| Composite PK (two+ columns) | Declare each column with `"isPk": true`, don't use `identity` trait |
| `uuid` PK with default `gen_random_uuid()` | Use `traits: ["identity"]` (dForge uses cuid, similar concept) |

### Step 5: Map relationships → FK+Reference pattern

**Explicit foreign keys** (DBML `Ref:` or SQL `FOREIGN KEY`):

For each FK, create **two columns** following the FK+Reference pattern:

1. Hidden FK column: `flags: "EM"`, matching `dbDatatype`
2. Visible Reference column: `columnType: "R"`, `fieldTypeCd: "lookup"`, `flags: "VEM"`, with `link`

Plus declare the constraint in the entity's `references` block.

**Implicit foreign keys** (column named `*_id` with no explicit FK):

Look for tables that match the prefix. If `customer_id` exists and a `customer` table exists → probably a FK. Create the reference pair but **ask the user to confirm** ambiguous cases.

### Step 6: Detect small lookup tables → dropdown options

Tables with 2-3 columns, < 20 rows, and a simple `id + name` shape are likely enums, not real entities. Examples: `statuses`, `categories`, `priorities`, `types`.

When detected:

- **Option A**: Convert to a `dropdown` column with `params.options` on the referencing entity. Remove the lookup table entirely.
- **Option B**: Keep as a real entity with a reference column.

**Ask the user** which approach they prefer. Default to Option B (keep the entity) for safety.

### Step 7: Generate the module

Using the converted entities, generate the full module package:

1. **`manifest.json`** — with `version: "0.1.0"`, `dbSchemaVersion: "0.0.1"`, entity list, dependencies (`admin`)
2. **`entities/*.json`** — one per entity, with traits, fields, references
3. **`ui/data_views.json`** — one grid view per entity with the first ~8 visible columns
4. **`ui/menus.json`** — grouped logically (group related entities under section nodes)
5. **`ui/folders.json`** — root folder with all entities listed
6. **`security/roles.json`** — at least `module.admin` (SIUDC on everything) and `module.user` (SIU on main entities)
7. **`translations/en-US.json`** — labels for all entities, fields, views, menus, actions, roles, folders
8. **`seed-data/`** — if the source had enum/lookup tables converted to entities, generate seed data for them

### Step 8: Generate IMPORT_NOTES.md

List everything you couldn't convert automatically:

```markdown
# Import Notes

Imported from: [source file name]
Date: [date]
Source: [N] tables, [N] columns, [N] foreign keys

## Converted
- [list of entities created]

## Decisions made
- `statuses` table converted to dropdown options on `order.status` column
- `created_at`/`updated_at` replaced with `audit` trait
- [etc.]

## Not converted — manual work needed
- View `v_customer_summary` — consider as a dForge report or formula column
- Stored procedure `sp_calculate_totals` — convert to a DSL action
- Trigger `trg_update_stock` — convert to a DSL action
- Index `idx_customer_email` — dForge generates indexes from column flags

## Questions for review
- Is `credit_limit` a currency field? (mapped as `number` — change to `currency` if monetary)
- Column `type` on `order` table — should this be a dropdown with fixed options or a free-text field?
```

## Example: DBML to dForge

### Input (DBML)

```dbml
Table customers {
  id integer [pk, increment]
  name varchar(200) [not null]
  email varchar(250)
  phone varchar(50)
  created_at timestamp [default: `now()`]
  updated_at timestamp [default: `now()`]
}

Table orders {
  id integer [pk, increment]
  customer_id integer [not null, ref: > customers.id]
  order_date date [not null]
  status varchar(20) [not null, note: 'new, processing, shipped, delivered, cancelled']
  total_amount decimal(10,2)
  notes text
  created_at timestamp [default: `now()`]
  updated_at timestamp [default: `now()`]
}

Table order_lines {
  id integer [pk, increment]
  order_id integer [not null, ref: > orders.id]
  product_name varchar(200) [not null]
  quantity integer [not null]
  unit_price decimal(10,2) [not null]
}
```

### Output: `entities/customer.json`

```json
{
    "description": "Customers",
    "dbObject": "customer",
    "toString": "{name}",
    "traits": ["identity", "audit"],
    "fields": {
        "name": {
            "dbDatatype": "varchar",
            "fieldTypeCd": "text",
            "flags": "VEM",
            "maxLen": 200,
            "orderNum": 10,
            "description": "Customer Name"
        },
        "email": {
            "dbDatatype": "varchar",
            "fieldTypeCd": "email",
            "flags": "VE",
            "maxLen": 250,
            "orderNum": 20,
            "description": "Email"
        },
        "phone": {
            "dbDatatype": "varchar",
            "fieldTypeCd": "phone",
            "flags": "VE",
            "maxLen": 50,
            "orderNum": 30,
            "description": "Phone"
        },
        "orders": {
            "columnType": "S",
            "fieldTypeCd": "grid",
            "flags": "VE",
            "orderNum": 100,
            "description": "Orders",
            "link": {
                "entity": "order",
                "thisKey": "customer_id",
                "otherKey": "customer_id"
            }
        }
    }
}
```

### Output: `entities/order.json`

```json
{
    "description": "Orders",
    "dbObject": "order",
    "toString": "Order #{order_id}",
    "traits": ["identity", "audit"],
    "fields": {
        "customer_id": {
            "dbDatatype": "cuid",
            "flags": "EM",
            "orderNum": 10,
            "description": "Customer ID"
        },
        "customer": {
            "columnType": "R",
            "fieldTypeCd": "lookup",
            "flags": "VEM",
            "orderNum": 15,
            "description": "Customer",
            "link": {
                "entity": "customer",
                "thisKey": "customer_id",
                "otherKey": "customer_id"
            }
        },
        "order_date": {
            "dbDatatype": "date",
            "fieldTypeCd": "date",
            "flags": "VEM",
            "orderNum": 20,
            "description": "Order Date"
        },
        "status": {
            "dbDatatype": "varchar",
            "fieldTypeCd": "dropdown",
            "flags": "VEM",
            "maxLen": 20,
            "orderNum": 30,
            "description": "Status",
            "params": {
                "options": [
                    { "value": "new", "label": "New" },
                    { "value": "processing", "label": "Processing" },
                    { "value": "shipped", "label": "Shipped" },
                    { "value": "delivered", "label": "Delivered" },
                    { "value": "cancelled", "label": "Cancelled" }
                ]
            }
        },
        "total_amount": {
            "dbDatatype": "numeric",
            "fieldTypeCd": "currency",
            "flags": "VE",
            "orderNum": 40,
            "description": "Total Amount"
        },
        "notes": {
            "dbDatatype": "text",
            "fieldTypeCd": "textarea",
            "flags": "VE",
            "orderNum": 50,
            "description": "Notes"
        },
        "lines": {
            "columnType": "S",
            "fieldTypeCd": "grid",
            "flags": "VE",
            "orderNum": 100,
            "description": "Order Lines",
            "link": {
                "entity": "order_line",
                "thisKey": "order_id",
                "otherKey": "order_id"
            }
        }
    },
    "references": {
        "FK_Order_Customer": {
            "from": { "field": "customer_id" },
            "to": { "entity": "customer", "field": "customer_id" }
        }
    }
}
```

Note how:
- Source `id` columns → replaced by `identity` trait
- Source `created_at`/`updated_at` → replaced by `audit` trait
- Source `customer_id` FK → FK+Reference pair (hidden `customer_id` + visible `customer` lookup)
- Source `status` with note listing values → `dropdown` with `params.options`
- Source `total_amount decimal(10,2)` → `currency` (inferred from name)
- Parent `customers` gets a `orders` set column (backwards reference)
- PK type changes from `integer` to `cuid` (dForge's native PK type via `identity` trait)

## Tips

- **Always ask about ambiguous columns** rather than guessing. "Is `credit_limit` currency? Is `type` a dropdown or free text?"
- **Generate `IMPORT_NOTES.md`** with every schema import — the user needs to know what wasn't converted.
- **Start with the most referenced entities** (parents) and work down to detail/line entities.
- **Source PKs change type.** dForge uses `cuid` for PKs (via `identity` trait). The old integer PKs don't carry over. If the user later needs to migrate data, the migration script handles PK mapping (see `references/data-migration.md`).
- **Preserve source column names** as `dbObject` / column codes where possible — this makes data migration easier later.
- **Views, stored procedures, and triggers** cannot be converted automatically. List them in `IMPORT_NOTES.md` and offer to convert them one by one to dForge constructs (reports, actions, formulas).
