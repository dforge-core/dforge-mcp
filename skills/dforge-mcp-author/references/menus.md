# Menus Reference

Menus define the module's navigation tree. Shown in the sidebar when the module is installed.

Lives in: `ui/menus.json`

## Structure — root wrapper with `items`, then nested dictionaries with `children`

**The real format** (from all reference modules — CRM, HR, Fin, WMS):

```json
{
    "todo_menu": {
        "label": "Todos",
        "items": {
            "lists": {
                "orderNum": 1,
                "label": "Lists",
                "icon": "list-ul",
                "children": {
                    "all_lists": {
                        "itemType": "V",
                        "dataViewCode": "todo_list_grid",
                        "orderNum": 1,
                        "label": "All Lists",
                        "icon": "list-ul"
                    }
                }
            },
            "items": {
                "orderNum": 2,
                "label": "Items",
                "icon": "check2-square",
                "children": {
                    "all_items": {
                        "itemType": "V",
                        "dataViewCode": "todo_item_grid",
                        "orderNum": 1,
                        "label": "All Items",
                        "icon": "check-square"
                    }
                }
            }
        }
    }
}
```

Structure: **root key** → `label` + `items` → **section nodes** (with `children`) → **leaf nodes** (with `itemType` + data view/report code).

## Item types (leaf nodes only)

| `itemType` | Description | Required field |
|---|---|---|
| `"V"` | Data view | `dataViewCode` |
| `"R"` | Report | `reportCode` |
| `"D"` | Dashboard | `dashboardCode` |
| `"A"` | Action | `actionCode` |

**Section nodes** (with `children`) **omit `itemType`**. Only leaf items have it.

## Icons

In `ui/menus.json`, icons use Bootstrap icon names **without the `bi-` prefix**:

- `"graph-up-arrow"` (not `"bi-graph-up-arrow"`)
- `"people"` (not `"bi-people"`)
- `"briefcase"` (not `"bi-briefcase"`)
- `"receipt"`, `"building"`, `"calendar-event"`, `"box-seam"`, etc.

**Note:** This no-prefix rule applies to module menu definitions. In other contexts, such as action registration, the icon value may need the full Bootstrap class name **with** the `bi-` prefix (for example, `"bi-graph-up-arrow"`). Always follow the format required by the specific configuration you are editing.
See https://icons.getbootstrap.com/ for the full catalog. Common choices:

- `people` — users/contacts
- `briefcase` — work/business
- `building` — companies/accounts
- `cart` — sales/orders
- `graph-up` — reports/analytics
- `gear` — settings
- `receipt` — invoices/quotes
- `calendar-event` — activities/dates
- `box-seam` — products/items
- `kanban` — pipeline/board views

## Real example from CRM module

```json
{
    "crm_menu": {
        "label": "Sales CRM",
        "items": {
            "sales": {
                "orderNum": 1,
                "label": "Sales",
                "icon": "graph-up-arrow",
                "children": {
                    "leads": {
                        "itemType": "V",
                        "dataViewCode": "leads",
                        "orderNum": 1,
                        "label": "Leads",
                        "icon": "person-plus"
                    },
                    "opportunities": {
                        "itemType": "V",
                        "dataViewCode": "opportunities",
                        "orderNum": 3,
                        "label": "Opportunities",
                        "icon": "trophy"
                    },
                    "sales_pipeline_report": {
                        "itemType": "R",
                        "reportCode": "sales_pipeline",
                        "orderNum": 6,
                        "label": "Sales Pipeline Report",
                        "icon": "file-earmark-bar-graph"
                    }
                }
            },
            "customers": {
                "orderNum": 3,
                "label": "Customers",
                "icon": "people",
                "children": {
                    "accounts": {
                        "itemType": "V",
                        "dataViewCode": "accounts",
                        "orderNum": 1,
                        "label": "Accounts",
                        "icon": "building"
                    },
                    "contacts": {
                        "itemType": "V",
                        "dataViewCode": "contacts",
                        "orderNum": 3,
                        "label": "Contacts",
                        "icon": "person-lines-fill"
                    }
                }
            }
        }
    }
}
```

## Required rules

1. **Root wrapper key** (e.g. `"crm_menu"`) with a `label` and `items` property.
2. **`items`** contains the section nodes, **not** direct leaf items at the top level.
3. **`dataViewCode`**, not `viewCode`. The wrong name silently fails.
4. **Section nodes have `children`**, leaf nodes have `itemType` + code.
5. **`orderNum` controls display order** within a level.
6. **`label` is required** on every node.
7. **`icon` is optional** but recommended. Use Bootstrap icon names **without** `bi-` prefix.

## Common mistakes

- Skipping the root wrapper (no `{root_key: {label, items}}`) — **wrong**. All reference modules use this structure.
- Using arrays like `"children": [...]` — **wrong**. Must be a dictionary.
- Using `viewCode` instead of `dataViewCode` — **wrong**.
- Putting `itemType: "V"` on a section node with `children` — **wrong**. Omit `itemType` on sections.
- Using `"bi-people"` as the icon — **wrong in module menus**. Use `"people"` (no prefix).
- Forgetting `label` — **required**.
- Putting leaf items directly inside `items` without a section wrapper — **technically works** but doesn't match conventions.
