# Security Reference

dForge has a **3-layer additive security model**:

1. **Row-level** — folders define SQL WHERE filters
2. **Column-level** — entity views control field visibility/editability
3. **Operation-level** — roles grant entity rights (S/I/U/D/C) and object access (E)

Roles are **additive** — a user with multiple roles gets the union of all their rights. Rights are never revoked by another role, only added.

Roles are **folder-scoped** — the same role can have different effective rights in different folders, because folders define the row filter.

Lives in: `security/roles.json`

## Role definition

Role codes use a `module.role` naming pattern (e.g. `crm.admin`, `crm.sales-rep`):

```json
{
    "crm.admin": {
        "description": "CRM Administrator",
        "rights": {
            "account":      "SIUDC",
            "contact":      "SIUDC",
            "lead":         "SIUDC",
            "opportunity":  "SIUDC",
            "opportunity_line": "SIUDC",
            "product":      "SIUDC",
            "quote":        "SIUDC",
            "activity":     "SIUDC"
        }
    },
    "crm.sales-rep": {
        "description": "Sales Representative",
        "rights": {
            "account":      "SIUC",
            "contact":      "SIUC",
            "lead":         "SIUDC",
            "opportunity":  "SIUC",
            "opportunity_line": "SIUC",
            "product":      "S",
            "quote":        "SIUC",
            "activity":     "SIUDC"
        }
    },
    "crm.viewer": {
        "description": "CRM Viewer (Read-Only)",
        "rights": {
            "account": "S",
            "contact": "S",
            "lead": "S",
            "opportunity": "S",
            "product": "S",
            "quote": "S",
            "activity": "S"
        }
    }
}
```

## Rights letters

### Entity rights (on entity codes)

| Letter | Permission |
|---|---|
| `S` | Select (read rows) |
| `I` | Insert (create rows) |
| `U` | Update (modify rows) |
| `D` | Delete (remove rows) |
| `C` | Clone (duplicate a row as a new record) |

### Action/Report/Folder rights

| Letter | Permission |
|---|---|
| `E` | Execute (run the action/report, access the folder) |

### Common combinations

| Rights | Meaning |
|---|---|
| `"S"` | Read only |
| `"SI"` | Read + create, no modify/delete |
| `"SIU"` | Read/write, no delete |
| `"SIUD"` | Full CRUD (most common for primary roles) |
| `"SIUDC"` | Full CRUD + clone |
| `"E"` | Execute (actions/reports/folders) |

## Object references

Role rights map object codes (entities, actions, reports) to rights strings. Object codes are:

- `contact` — the entity named "contact" in this module (bare, same-module)
- `fin.invoice` — the entity "invoice" in the `fin` module (cross-module entity — **dot**)
- `action:send_welcome` — an action named "send_welcome" (**colon**)
- `report:sales_pipeline` — a report named "sales_pipeline" (**colon**)
- `folder:customers` — the folder with code "customers" (**colon**)

> **Separator matters — colon for non-entity objects, dot only for cross-module entities.**
> Actions, reports and folders are prefixed with a **colon**: `action:<code>`, `report:<code>`,
> `folder:<code>`. A **dot** is reserved for a cross-module *entity* (`module.entity`, e.g.
> `parties.party`). Writing `action.send_welcome` (dot) is **wrong** — the installer treats it as
> entity `send_welcome` in a module named `action`, finds nothing, and rejects the grant as an
> unknown object. Same-module entities are bare (`contact`). This matches every dForge-core
> module (`"action:submit_po": "E"`).

## Rules

1. **Use `"rights"`**, never `"entityRights"` (the wrong name is the most common mistake).
2. **Every module should define at least one role.** Without roles, tenant admins can't grant access to anyone.
3. **Create multiple roles for different user personas** — e.g. `sales_rep`, `sales_admin`, `sales_manager`.
4. **Never grant `D` (Delete) to a rep-level role** unless deletion is a normal part of their job. Audit trails prefer soft-delete or update.
5. **Always grant the admin role `SIUDC` on everything the module owns.**
6. **Action and report access** — grant `E` on specific action/report codes, or omit them entirely (defaulting to no access).
7. **Folder access** is granted separately — roles can reference folder codes, but folder definitions themselves live in `ui/folders.json`.

## Folders (`ui/folders.json`)

Folders define the **folder tree** created when the module is installed. They declare which entities are available, default views, quick-add, and optionally **row-level filtering** and **subfolders**.

Lives in: `ui/folders.json`

### Simple example (CRM — flat, no subfolders)

```json
{
    "label": "Sales CRM",
    "description": "Customer relationship management and sales pipeline",
    "color": "#2196F3",
    "entities": {
        "account": { "viewName": "default", "quickAdd": true },
        "contact": { "viewName": "default", "quickAdd": true },
        "opportunity": { "viewName": "default", "quickAdd": true },
        "opportunity_line": { "viewName": "default", "quickAdd": false },
        "product": { "viewName": "default", "quickAdd": true }
    }
}
```

### Advanced example (WMS — subfolders with row filters)

```json
{
    "label": "Warehouse Management",
    "description": "Inventory, purchasing, and warehouse operations",
    "color": "#FF9800",
    "entities": {
        "warehouse": { "viewName": "default", "quickAdd": true },
        "product": { "viewName": "default", "quickAdd": true },
        "stock": { "viewName": "default", "quickAdd": true },
        "stock_movement": { "viewName": "default", "quickAdd": true },
        "purchase_order": { "viewName": "default", "quickAdd": true },
        "purchase_order_line": { "viewName": "default", "quickAdd": false }
    },
    "children": {
        "central": {
            "label": "Central Warehouse",
            "description": "Main distribution center",
            "color": "#2196F3",
            "inheritSecurity": true,
            "entities": {
                "stock": {
                    "viewName": "default",
                    "quickAdd": true,
                    "rowFilter": { "c": "warehouse_id", "o": "eq", "v": 2001 }
                },
                "stock_movement": {
                    "viewName": "default",
                    "quickAdd": true,
                    "rowFilter": { "c": "warehouse_id", "o": "eq", "v": 2001 }
                },
                "purchase_order": {
                    "viewName": "default",
                    "quickAdd": true,
                    "rowFilter": { "c": "warehouse_id", "o": "eq", "v": 2001 }
                }
            }
        },
        "east": {
            "label": "East Warehouse",
            "color": "#4CAF50",
            "inheritSecurity": true,
            "entities": {
                "stock": {
                    "viewName": "default",
                    "quickAdd": true,
                    "rowFilter": { "c": "warehouse_id", "o": "eq", "v": 2002 }
                }
            }
        }
    }
}
```

### Folder properties

| Property | Type | Description |
|---|---|---|
| `label` | string | Display name in sidebar |
| `description` | string | Shown in folder header |
| `color` | string | Hex accent color |
| `entities` | object | Entity membership (see below) |
| `children` | object | Subfolder definitions (same shape recursively) |
| `inheritSecurity` | boolean | Child inherits parent folder's role assignments |

### Entity membership properties

| Property | Type | Description |
|---|---|---|
| `viewName` | string | Default data view (usually `"default"`) |
| `quickAdd` | boolean | Show "+" quick-add button (`true` for main entities, `false` for detail/line items) |
| `rowFilter` | object | Row-level filter scoping which records are visible in this folder |

### Row filters (`rowFilter`)

Row filters use a compact filter object with:
- `c` — column code to filter on
- `o` — operator (`eq`, `neq`, `gt`, `lt`, `gte`, `lte`, `in`, `not_in`, etc.)
- `v` — value to compare against

This is how **row-level security** works in the module package — subfolders with `rowFilter` restrict which rows are visible. Users assigned to "Central Warehouse" only see stock where `warehouse_id = 2001`.

### When to use subfolders

- **Multi-location modules** (warehouses, offices, branches) — one subfolder per location, filtered by location FK
- **Multi-department modules** — one subfolder per department
- **Regional access** — filter by region/country column

For simple modules, a flat root folder (no `children`) is fine — just `label`, `color`, and `entities`.

## Common mistakes

- Using `"entityRights"` instead of `"rights"` — **wrong**.
- Using a **dot** for an action/report/folder (`action.send_welcome`) — **wrong**. Use a **colon**: `action:send_welcome`, `report:...`, `folder:...`. A dot is only for cross-module *entities* (`fin.invoice`).
- Granting a bare action code (`send_welcome` with no prefix) — **wrong**, it's read as an entity and rejected as unknown. Prefix it: `action:send_welcome`.
- Mapping an object to an empty rights string (`"action:x": ""`) — **wrong**. To deny, **omit** the key entirely; to grant, use `"E"`.
- Using long names like `"read,write"` instead of `"SIU"` — **wrong**.
- Forgetting to define any role — module installs but no user can access anything.
- Granting `"D"` casually — delete should be rare.
- Trying to **revoke** rights with a second role — impossible. Rights are additive only.
- Inventing rights letters like `"R"` for read or `"W"` for write — **wrong**. Use `SIUD`.
- Putting folders in `security/` — **wrong**. It's `ui/folders.json`.
