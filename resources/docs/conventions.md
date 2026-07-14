# Module Development Conventions

## Overview

This document defines the conventions and standards for developing modules in the dForge platform.
Use the CRM sample module (`modules/crm/`) as a reference implementation.

---

## File Formatting

### Indentation

**All project files use TABS for indentation:**

- **C# files** (`.cs`): Tabs, size 4
- **JSON files** (`.json`): Tabs, size 2
- **TypeScript/JavaScript** (`.ts`, `.js`): Tabs, size 4
- **Svelte files** (`.svelte`): Tabs, size 4
- **SQL files** (`.sql`): Tabs, size 4
- **Markdown files** (`.md`): Tabs

**Exceptions** (spaces only):
- `package.json`
- `tsconfig.json`
- `*.config.js` files

### Line Endings

- Use LF (Unix-style) line endings for all files
- Ensure final newline at end of file
- Trim trailing whitespace

---

## Module Structure

### Standard Module Layout

```
/your-module/
├── manifest.json              # Module metadata + entity registry
├── settings.json              # Module settings (optional)
├── /entities/                 # Entity definitions (one per file)
│   ├── entity1.json
│   ├── entity2.json
│   └── entity3.json
├── /ui/                       # UI definitions
│   ├── data_views.json        # Data view definitions
│   ├── menus.json             # Menu definitions
│   ├── folders.json           # Folder + entity access definitions
│   ├── actions.json           # Action metadata (optional)
│   ├── reports.json           # Report definitions (optional)
│   └── print_templates.json   # Print template definitions (optional)
├── /logic/                    # Business logic
│   ├── /actions/              # DSL action scripts
│   │   ├── approve.dsl
│   │   └── send_invoice.dsl
│   ├── triggers.json          # Event triggers (optional) — "when X happens, run action Y"
│   ├── webhooks.json          # Webhook subscriptions (optional) — external HTTP notifications
│   └── jobs.json              # Scheduled jobs (optional) — cron-driven action fires
├── /seed-data/                # Seed data files (numbered for FK order)
│   ├── 01-skills.json
│   ├── 02-departments.json
│   └── 03-employees.json
├── /security/                 # Security definitions
│   └── roles.json
├── /translations/             # Translations (optional)
│   ├── en-US.json
│   └── de-DE.json
├── /print_templates/          # HTML/CSS print templates (optional)
│   ├── invoice.html
│   └── invoice.css
└── /files/                    # Module static files (optional) — README, docs
    └── README.md
```

---

## JSON File Conventions

### 1. Manifest (`manifest.json`)

```json
{
	"packageFormat": 1,
	"moduleId": "REPLACE-WITH-A-FRESH-UUID",
	"code": "hr",
	"version": "0.0.1",
	"dbSchemaVersion": "0.0.1",
	"displayName": "Human Resources",
	"description": "HR management module",
	"author": { "name": "dForge" },
	"license": "MIT",
	"entities": {
		"department": "./entities/department.json",
		"employee": "./entities/employee.json"
	}
}
```

**Rules:**
- `code` becomes the DB schema name and folder path
- `entities` maps entity codes to file paths (relative to module root)
- Omit `"system": true` for regular modules (defaults to false)
- Omit `schemaName` to use `code` as the schema name

### 1b. Module Extensions

Modules can add columns to entities owned by other modules using **extension entity files** — entity JSON files with an `extends` property. Extensions support both virtual columns (Reference, Set, Formula — metadata only) and physical columns (actual DB columns stored in a 1:1 extension table). This eliminates circular dependencies: the extending module declares the cross-module columns instead of the target entity.

Extension entity files are referenced from the manifest's `entities` map using dotted keys as a naming convention:

```json
{
	"dependencies": {
		"crm": ">=0.0.1",
		"fin": ">=0.0.1"
	},
	"entities": {
		"fin.invoice": "entities/fin.invoice.json",
		"fin.invoice_line": "entities/fin.invoice_line.json",
		"crm.quote": "entities/crm.quote.json"
	}
}
```

The entity file uses the same `fields` schema as regular entities, plus an `extends` property:

```json
{
	"extends": "fin.invoice",
	"dbObject": "invoice",
	"description": "CRM extensions for Invoice",
	"fields": {
		"customer_id": {
			"dbDatatype": "int8",
			"isNullable": true,
			"flags": "EM",
			"orderNum": 34,
			"description": "Customer FK"
		},
		"customer": {
			"columnType": "R",
			"fieldTypeCd": "lookup",
			"flags": "VEM",
			"orderNum": 35,
			"description": "Customer",
			"link": {
				"entity": "crm.account",
				"thisKey": "customer_id",
				"otherKey": "account_id"
			}
		}
	}
}
```

In this example, `customer_id` is a physical column (has `dbDatatype`) stored in `"crm_fin"."invoice_ext"`, while `customer` is a virtual Reference column (metadata only). The FK+Reference two-column pattern applies to extensions the same way as regular entities.

**Physical extension columns** are stored in a dedicated 1:1 extension table created in the bridge module's schema (e.g., `"crm_fin"."invoice_ext"`), not in the target entity's table. The platform handles this transparently — queries automatically LEFT JOIN the ext table, and writes split between the main table and ext table.

**Rules:**
- Entity files with `extends` are treated as extensions, not new entities
- The `extends` value must be a qualified entity code: `"module.entity"` (e.g., `"fin.invoice"`)
- The target module must be declared as a dependency
- Extension columns **must** use the `link` object (no fallback to `references` section)
- `dbObject` is optional — used for documentation and validation
- Physical columns (those with `dbDatatype`) are created in a 1:1 extension table: `{bridge_schema}.{entity_cd}_ext`
- The ext table PK is an FK to the target entity's PK — enforcing 1:1 relationship
- Virtual columns (`columnType: "R"`, `"S"`, or `"F"`) are metadata only — no ext table needed
- The `storage_table` metadata column tracks which ext table stores each physical extension column (set automatically by the installer)
- Extensions are processed after the module's own entities are registered
- Install order matters: the target module must be installed before the extending module

**File naming convention:** Use dotted names matching the target entity (`entities/fin.invoice.json`). This makes it immediately obvious in the file system which files are extensions:

```
entities/
├── fin.invoice.json        # extends fin.invoice
├── fin.invoice_line.json   # extends fin.invoice_line
└── crm.quote.json          # extends crm.quote
```

**How ext tables work at runtime:**

```sql
-- Query builder automatically adds LEFT JOIN for ext table columns:
SELECT t0."invoice_id", t0."invoice_no", ext0."customer_id"
FROM "fin"."invoice" t0
LEFT OUTER JOIN "crm_fin"."invoice_ext" ext0
  ON ext0."invoice_id" = t0."invoice_id"

-- Writes split automatically:
-- 1. Main table INSERT/UPDATE (columns without storage_table)
-- 2. Ext table UPSERT (INSERT ON CONFLICT DO UPDATE) for ext columns
```

**Uninstall** is clean: `DROP SCHEMA CASCADE` removes the ext tables, and extension column metadata rows are cleaned by matching `storage_table LIKE '{schema}%'`.

**Bridge module pattern (recommended):**
Rather than having core modules extend each other directly, create small bridge modules that own the integration. For example, instead of CRM extending FIN entities, create a `crm-fin` module that depends on both CRM and FIN and declares all the cross-module extensions, actions, and views.

```
CRM (standalone)  ──┐
                    ├── crm-fin (bridge: extensions + actions + views)
FIN (standalone)  ──┘
```

Benefits:
- Core modules remain fully independent (CRM works without FIN and vice versa)
- Integration is opt-in: only install the bridge when both modules are present
- Third-party developers can create bridges between any two modules
- Clean uninstall — DROP SCHEMA removes ext tables, no ALTER TABLE on other modules

Bridge modules typically have no entities of their own — just extensions, `actions`, and optionally `views`.

Multiple bridge modules can extend the same entity (e.g., `crm-fin` and `hr-fin` both extend `fin.invoice`). Each creates its own ext table; the query builder adds multiple LEFT JOINs on PK columns.

Reference implementations: `modules/crm-fin/`, `wms-fin/`

**Bridge menu merge constraints.** When a bridge module declares a `menus.json` with a menu name that already exists (owned by a core module), its items are merged into the existing menu under matching sections. Two constraints apply:

1. **Bridge menu items must be leaves** (`itemType` of `V`, `R`, or `D`). Do not insert sub-folders (`itemType: F`) from a bridge. On reinstall the cleaner identifies bridge-owned items via `data_view_id` / `report_id` FKs back to the bridge's module_id — folder rows have neither FK, so they cannot be traced back and would accumulate on every reinstall.

2. **Bridge menu items must reference the bridge's own views/reports**, not the host module's. The platform populates the report/view lookups from all installed modules so technically a bridge `menus.json` can reference any code, but reinstall cleanup only matches by the bridge's own module_id. Referencing a host-module report means the stale menu_item survives reinstall and the new INSERT then fails against the `ux_menu_item_report` / `ux_menu_item_view` partial unique indexes. If a bridge wants to expose a host-owned resource under its own menu slot, duplicate the definition into the bridge's `reports.json` / `data_views.json` so ownership stays within the bridge.

**When to use extensions vs. regular references:**
- Use extensions (via a bridge module) when two independent modules need cross-module lookups or actions
- Use regular `link` references for one-way dependencies where the target entity already exists

### 2. Data View Definitions (`ui/data_views.json`)

**CRITICAL: Every view MUST use a `dataSources` array. The client will not render views without it.**

**Simple grid view:**
```json
{
	"positions": {
		"viewType": "grid",
		"description": "Positions",
		"dataSources": [
			{
				"entityCode": "position",
				"level": 0,
				"columns": [
					"position_code",
					{ "column_cd": "position_title", "width": 200 },
					"department",
					"is_active"
				]
			}
		]
	}
}
```

**Master-detail view (parent + child tabs):**
```json
{
	"employee_detail": {
		"viewType": "master-detail",
		"description": "Employee Detail",
		"dataSources": [
			{
				"entityCode": "employee",
				"level": 0,
				"columns": ["employee_code", "first_name", "last_name", "department"]
			},
			{
				"entityCode": "leave_request",
				"level": 1,
				"parentSetField": "leave_requests",
				"label": "Leave Requests"
			},
			{
				"entityCode": "document",
				"level": 1,
				"parentSetField": "documents",
				"label": "Documents"
			}
		]
	}
}
```

**Rules:**
- Each view is a dictionary entry keyed by view code
- `dataSources` is a **required array** — never put `entityCode`/`columns` at the root level
- Level 0 = primary data source (one per view)
- Level 1 = child data sources (for master-detail views)
- `parentSetField` on level 1 sources must match a Set column field name on the parent entity
- Columns can be strings (field code) or objects (`{ "column_cd": "name", "width": 200 }`)

**Common Mistakes:**
- ❌ `"entityCode": "employee"` at view root level → ✅ Put inside `dataSources[0]`
- ❌ `"columns": [...]` at view root level → ✅ Put inside `dataSources[0]`
- ❌ `"isDefault": true` at view root level → ✅ Not a recognized property; remove it

### 3. Menu Definitions (`ui/menus.json`)

**Menus use nested dictionaries (not arrays):**

```json
{
	"hr_menu": {
		"description": "Human Resources",
		"items": {
			"organization": {
				"orderNum": 1,
				"description": "Organization",
				"children": {
					"departments": {
						"itemType": "V",
						"dataViewCode": "departments",
						"orderNum": 1,
						"description": "Departments"
					},
					"positions": {
						"itemType": "V",
						"dataViewCode": "positions",
						"orderNum": 2,
						"description": "Positions"
					}
				}
			}
		}
	}
}
```

**Rules:**
- Top-level key is the menu code (e.g. `hr_menu`)
- `items` is a **dictionary** of sections (not an array)
- Section children are also a **dictionary** under `children`
- Omit `itemType` for folder/section items (parent nodes)
- Only leaf items have `"itemType": "V"` with `dataViewCode`
- Use `dataViewCode` (not `viewCode`) to reference data views

**Common Mistakes:**
- ❌ `"items": [{ "code": "...", "label": "..." }]` (array format) → ✅ Use dictionary format
- ❌ `"viewCode": "departments"` → ✅ Use `"dataViewCode": "departments"`
- ❌ `"itemType": null` on sections → ✅ Omit `itemType` entirely

### 4. Folder Definitions (`ui/folders.json`)

**The whole `folders.json` file is the module's root folder.** A module gets
exactly one root folder (named after the module code automatically), and any
subfolders nest under a `children` object. Folder paths and parent/child
relationships are derived from the JSON tree structure — there is no
`folderPath` or `parentCode` field to write.

**Minimal example** (the `crm` module):

```json
{
	"label": "Sales CRM",
	"description": "Customer relationship management and sales pipeline",
	"color": "#2196F3",
	"entities": {
		"account":  { "viewName": "default", "quickAdd": true },
		"contact":  { "viewName": "default", "quickAdd": true },
		"lead":     { "viewName": "default", "quickAdd": true },
		"opportunity": { "viewName": "default", "quickAdd": true }
	}
}
```

That's the entire file. Modules with no subfolders (the 80% case) end here.

**Nested example** (the `wms` module — root + three regional warehouses):

```json
{
	"label": "Warehouse Management",
	"description": "Inventory, purchasing, and warehouse operations",
	"color": "#FF9800",
	"entities": {
		"warehouse": { "viewName": "default", "quickAdd": true },
		"product":   { "viewName": "default", "quickAdd": true },
		"stock":     { "viewName": "default", "quickAdd": true }
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
					"rowFilter": { "c": "warehouse_id", "o": "eq", "v": 2001 }
				}
			}
		},
		"east": {
			"label": "East Warehouse",
			"color": "#4CAF50",
			"inheritSecurity": true,
			"entities": { /* with rowFilter for east */ }
		},
		"west": {
			"label": "West Warehouse",
			"color": "#9C27B0",
			"inheritSecurity": true,
			"entities": { /* with rowFilter for west */ }
		}
	}
}
```

The install pipeline derives:

| Source | `folder_path` in DB | `folder_code` (synthesized) |
|---|---|---|
| Root (the file itself) | `wms` | `wms` |
| `children.central` | `wms/central` | `wms_central` |
| `children.east` | `wms/east` | `wms_east` |
| `children.west` | `wms/west` | `wms_west` |

The synthesized flat code is the module code joined with each child key by
underscores; the DB path is the module code joined with each child key by
slashes.

**Rules:**

- **The whole file is the root folder.** Top-level fields (`label`, `description`, `color`, `entities`) belong to the root.
- **Subfolders nest under `children`** (a dictionary keyed by path segment).
- **Each child key is a single path segment** — lowercase letters, digits, dashes, and underscores only, no slashes. Pattern: `^[a-z0-9][a-z0-9_-]*$`. Slashes are forbidden in keys because deeper trees use `children` recursively, not slashes in keys.
- **`entities` is a dictionary** mapping entity codes to settings objects. Each entity has `viewName` (string or null), `quickAdd` (boolean), and an optional `rowFilter`.
- **`inheritSecurity`** is allowed only on child folders. The root has no parent to inherit from, so the field is rejected at the root level with a clear error.
- **Children can have their own children**, recursively, for arbitrary tree depth.

**Forbidden fields (migration traps):**

- ❌ `folderPath` anywhere in the file. The path is derived; the field is rejected with an error pointing at `modules/<code>/ui/folders.json`.
- ❌ `parentCode` anywhere in the file. Parent/child relationships are expressed by nesting under `children`; the field is rejected with the same kind of error.
- ❌ `inheritSecurity` on the root.

**Common Mistakes:**

- ❌ `"entities": ["department", "employee"]` (array format) → ✅ Use dictionary with objects.
- ❌ `"quickAdd": ["employee"]` (separate array) → ✅ Set `quickAdd: true` per entity.
- ❌ Mixing the old flat-dictionary format with `parentCode` and `folderPath` fields → ✅ Migrate to the tree shape; the install pipeline will tell you exactly which field to remove.
- ❌ Using slashes in child keys (`"regions/east"`) → ✅ Nest with `children: { "regions": { "children": { "east": {} } } }`.

#### Why the format looks like this

The frontend routes folder URLs as `/{folderPath}/v/{viewSlug}` with no
module segment. If two modules' folders shared a `folder_path`, the sidebar
would render them indistinguishably even though the database stores them as
separate rows scoped per module. The previous file format encoded paths and
parent/child relationships as explicit fields (`folderPath`, `parentCode`)
that module authors could easily get wrong — and a scaffold-from-template
flow could silently produce a violating module by copying those fields
verbatim from the source.

The current tree-shape format eliminates the entire class of bug:

- The root path is **always** the module code (it's not even a field).
- Subfolder paths are **derived from nesting**, so they can't disagree with the parent/child relationship.
- The whole file is module-scoped by construction — paths under one module physically cannot collide with another module's paths because they all start with their own module's code.

The DB still has a `UNIQUE INDEX` on `(module_id, folder_path)` as
defense-in-depth, and `FolderTreeFlattener` validates the file format
before the install pipeline touches the database.

### 5. Security Roles (`security/roles.json`)

```json
{
	"hr.admin": {
		"description": "HR Administrator — full access",
		"rights": {
			"department": "SIUDC",
			"employee": "SIUDC",
			"leave_request": "SIUDC"
		}
	},
	"hr.viewer": {
		"description": "HR Viewer — read-only",
		"rights": {
			"department": "S",
			"employee": "S",
			"leave_request": "S"
		}
	}
}
```

**Rules:**
- Key is the role code (convention: `module.role-name`)
- **Property name is `"rights"` (NOT `"entityRights"`)** — this maps to `RoleDef.Rights`
- Each entry in `rights` maps entity code → rights string
- Rights characters: `S` (Select), `I` (Insert), `U` (Update), `D` (Delete), `C` (Clone) for entities, and `E` (Execute) for actions, reports, and folder access (e.g. `"action:create_quote": "E"`). The roles JSON schema enforces `^[SIUDCE]*$`.
- Every entity should appear in every role (even if only `"S"` for read-only)

**Common Mistakes:**
- ❌ `"entityRights": { ... }` → ✅ Use `"rights": { ... }`
- ❌ Omitting entities from a role → Entity will be inaccessible to that role

### 6. Seed Data (`seed-data/*.json`)

**Number files to ensure FK dependency order:**

```
seed-data/
├── 01-skills.json          # No FKs
├── 02-departments.json     # No FKs
├── 03-positions.json       # FK → department
├── 04-employees.json       # FK → department, position
└── 05-leave_requests.json  # FK → employee
```

**File format:**
```json
{
	"entityCode": "department",
	"records": [
		{
			"department_id": 3001,
			"department_code": "EXEC",
			"department_name": "Executive / Leadership",
			"is_active": true
		}
	]
}
```

**Rules:**
- Files are loaded alphabetically — use numbered prefixes (01-, 02-, etc.)
- Parent tables must come before child tables (FK dependency order)
- Include explicit PK values so child records can reference them
- PKs from the `identity` trait are `cuid` — physically `int8` (bigint), **not** UUID strings. Use numeric integers with a stable per-entity scheme: `1001`–`1099` for the first entity type, `2001`–`2099` for the next, etc. Using UUID strings here fails the seed load against `int8` columns.
- Inserts use `ON CONFLICT DO NOTHING` (idempotent)
- Dates in string format are auto-converted by the seed runner
- Omit auto-generated fields (`created_date`, `last_updated`) — they use DB defaults
- Omit cross-module FK fields (e.g., `owner_id` referencing `user` table)

### 7. Scheduled Jobs (`logic/jobs.json`)

Cron-driven action fires. Each entry pairs an existing action (declared in `ui/actions.json`) with a 5-field cron expression; the `dForge.Scheduler` worker fires it on schedule. Full reference: [Scheduled Jobs](../business-logic/jobs.md). Manifest schema: [`jobs.schema.json`](../schemas/jobs.schema.json).

```json
{
	"jobs": [
		{
			"code": "tick",
			"description": "Fires log_tick every minute",
			"action": "log_tick",
			"schedule": "* * * * *",
			"timeout": 30,
			"class": "standard"
		}
	]
}
```

**Rules:**
- `code` — unique within the module, `[a-z][a-z0-9_]*`
- `action` — must be an action declared in this module's `ui/actions.json`; cross-module references are rejected
- `schedule` — five fields, minute granularity (sub-minute schedules are rejected at install)
- `timeout` — required, in seconds, range `(0, 3600]`
- `timeout > 300` requires `"class": "long_running"` (the standard pool is capped at 300s)
- Referenced action must NOT use `[field]` or `for x in records` — scheduled fires have no record context. Install fails fast if it does. Use `query()` / `insert()` for table-level work.
- Max 50 jobs per module
- Optional `timeZone` (IANA name) overrides `auth.tenant.time_zone` for that job
- Use `paused: true` to freeze a job during incidents — admin "Run now" still works while the cron path is silent

**Reference:** `modules/chore/` — single-job smoke-test module.

### 8. Translations (`translations/en-US.json`)

```json
{
	"entities": {
		"department": {
			"label": "Department",
			"desc": "Company departments",
			"fields": {
				"department_id": { "label": "Department ID" },
				"department_name": { "label": "Department Name" }
			}
		},
		"employee": {
			"constraints": {
				"chk_salary_positive": { "message": "Salary must be positive" }
			}
		}
	},
	"folders": {
		"hr": { "label": "Human Resources" }
	},
	"views": {
		"departments": { "label": "Departments" },
		"employees": { "label": "All Employees" }
	},
	"menus": {
		"hr_menu": { "label": "Human Resources" }
	},
	"actions": {
		"approve_leave": { "label": "Approve Leave", "desc": "Approve a leave request" }
	}
}
```

**Translatable sections (consumed by the installer):** `entities` (+ nested `fields` and `constraints`), `folders`, `views`, `menus` (+ nested `items`), `actions` (+ `params`), `reports` (+ `datasets.caption`, `params`).

**Constraint violation messages are localizable (opt-in).** The `message` on a check/unique constraint in the entity JSON is the base (fallback) text. To localize it, add a per-locale override under `entities.<entityCd>.constraints.<constraintName>.message` in each `translations/<locale>.json`. The server resolves it with culture fallback (per-locale → base) and it surfaces identically on the client pre-save validator and the server DB-violation path. Unlike labels, constraint overrides are **not** completeness-enforced: a missing override for a declared `supportedLocales` entry emits a **non-fatal warning** (from `dforge_module_validate` pre-flight and at install) and the base message is used as the fallback.

**Silently ignored at runtime:** `roles` and `print_templates` — the resource rows have no `res_id`, so translations are reserved for future use. `settings` is validated for completeness (when listed in `supportedLocales`) but the registrar does not display the translated labels, so don't expect localized output. Display names for these come from the source manifest (`description` for roles, `label` for print templates and settings).

---

## Entity Definitions (`entities/*.json`)

### Complete Entity Example

```json
{
	"description": "Employees",
	"dbObject": "employee",
	"toString": "{first_name} {last_name}",
	"fields": {
		"employee_id": {
			"dbDatatype": "cuid",
			"isPk": true,
			"isIdentity": true,
			"isNullable": false,
			"orderNum": 10,
			"description": "Employee ID"
		},
		"employee_code": {
			"dbDatatype": "varchar",
			"fieldTypeCd": "text",
			"flags": "VEM",
			"isNullable": false,
			"maxLen": 20,
			"orderNum": 20,
			"description": "Employee Code"
		},
		"department_id": {
			"dbDatatype": "cuid",
			"fieldTypeCd": "hidden",
			"flags": "EM",
			"orderNum": 30,
			"description": "Department ID"
		},
		"department": {
			"columnType": "R",
			"fieldTypeCd": "lookup",
			"flags": "VEM",
			"orderNum": 35,
			"description": "Department",
			"link": {
				"entity": "department",
				"thisKey": "department_id",
				"otherKey": "department_id"
			}
		},
		"employment_status": {
			"dbDatatype": "varchar",
			"fieldTypeCd": "dropdown",
			"flags": "VEM",
			"isNullable": false,
			"maxLen": 50,
			"formula": "'Active'",
			"orderNum": 40,
			"description": "Status",
			"params": {
				"options": ["Active", "On Leave", "Suspended", "Terminated"]
			}
		},
		"leave_requests": {
			"columnType": "S",
			"fieldTypeCd": "grid",
			"flags": "VEM",
			"orderNum": 100,
			"description": "Leave Requests",
			"link": {
				"entity": "leave_request",
				"thisKey": "employee_id",
				"otherKey": "employee_id"
			}
		}
	},
	"constraints": {
		"UQ_employee_code": {
			"type": "unique",
			"fields": ["employee_code"],
			"message": "Employee code must be unique"
		},
		"chk_salary_positive": {
			"type": "check",
			"expression": "salary > 0",
			"message": "Salary must be positive"
		}
	},
	"references": {
		"FK_Employee_Department": {
			"from": { "field": "department_id" },
			"to": { "entity": "department", "field": "department_id" }
		}
	}
}
```

---

## FK+Reference Two-Column Pattern

For every foreign key relationship, create TWO columns:

### 1. Hidden FK Column (Database)
```json
"department_id": {
	"dbDatatype": "cuid",
	"fieldTypeCd": "hidden",
	"flags": "EM",
	"orderNum": 30,
	"description": "Department ID"
}
```

### 2. Visible Reference Column (UI)
```json
"department": {
	"columnType": "R",
	"fieldTypeCd": "lookup",
	"flags": "VEM",
	"orderNum": 35,
	"description": "Department",
	"link": {
		"entity": "department",
		"thisKey": "department_id",
		"otherKey": "department_id"
	}
}
```

### 3. Declare Foreign Key
```json
"references": {
	"FK_Employee_Department": {
		"from": { "field": "department_id" },
		"to": { "entity": "department", "field": "department_id" }
	}
}
```

**Rules:**
- Reference columns use `"link"` (not `"params"`) for entity binding
- `link.entity` = target entity code, `link.thisKey` = local FK field, `link.otherKey` = remote PK field
- `params` is used for other purposes (e.g., dropdown `options`)
- Hidden FK column: `flags: "EM"` (no `V` = hidden from UI)
- Visible reference column: `flags: "VEM"`, `columnType: "R"`
- The FK column's `dbDatatype` **MUST match the referenced PK's type** — use `cuid` for `identity`-trait PKs (`cuid` is physically `int8`, **not** a UUID). A mismatch (e.g. FK `uuid` → PK `cuid`) fails install with *"foreign key constraint … cannot be implemented"*.

---

## Set Columns (1:N Relationships)

Declare set columns on parent entities for child collections:

```json
"leave_requests": {
	"columnType": "S",
	"fieldTypeCd": "grid",
	"flags": "VEM",
	"orderNum": 100,
	"description": "Leave Requests",
	"link": {
		"entity": "leave_request",
		"thisKey": "employee_id",
		"otherKey": "employee_id"
	}
}
```

**Rules:**
- Set columns use `"link"` (same as reference columns)
- `link.entity` = child entity, `link.thisKey` = parent PK, `link.otherKey` = child FK
- The set field name is used as `parentSetField` in master-detail data views

---

## Field Type Reference

### Valid Field Types

| Code | Description | Column Type |
|------|-------------|-------------|
| `text` | Single-line text | D (Data) |
| `email` | Email address | D |
| `phone` | Phone number | D |
| `url` | URL / web address | D |
| `textarea` | Multi-line text | D |
| `code` | Code editor (monospace) | D |
| `richtext` | Rich text editor | D |
| `number` | Numeric input | D |
| `currency` | Currency with precision | D |
| `percent` | Percentage value | D |
| `checkbox` | Boolean checkbox | D |
| `date` | Date | D |
| `datetime` | Date and time | D |
| `time` | Time | D |
| `dropdown` | Dropdown select | D |
| `flags` | Multi-select checkboxes (bitwise flags) | D |
| `tags` | Tag / chip input | D |
| `user` | User selector | D |
| `entitylink` | Entity record link | D |
| `json` | JSON editor | D |
| `hidden` | Hidden field | D |
| `color` | Color picker | D |
| `image` | Image upload | D |
| `file` | File upload | D |
| `lookup` | Reference lookup | R (Reference) |
| `grid` | Detail grid | S (Set) |

**Common Mistakes:**
- ❌ `"integer"` → ✅ Use `"number"`
- ❌ `"datePicker"` → ✅ Use `"date"`
- ❌ `"autocomplete"` → ✅ Use `"lookup"`

### Dropdown Options (`params.options`)

For `dropdown` fields, define available options in `params.options`:

**Simple format** — value equals label:
```json
"status": {
	"dbDatatype": "varchar",
	"fieldTypeCd": "dropdown",
	"flags": "VEM",
	"maxLen": 50,
	"params": {
		"options": ["New", "In Progress", "Done"]
	}
}
```

**Rich format** — separate value/label with optional icon and color:
```json
"priority": {
	"dbDatatype": "varchar",
	"fieldTypeCd": "dropdown",
	"flags": "VEM",
	"maxLen": 20,
	"params": {
		"options": [
			{ "value": "low", "label": "Low", "icon": "🟢", "color": "#e8f5e9" },
			{ "value": "medium", "label": "Medium", "icon": "🟡", "color": "#fff3e0" },
			{ "value": "high", "label": "High", "icon": "🔴", "color": "#ffebee" }
		]
	}
}
```

**Rich option properties:**
| Property | Required | Description |
|----------|----------|-------------|
| `value`  | Yes      | Stored value (must fit `maxLen`) |
| `label`  | Yes      | Display label |
| `icon`   | No       | Emoji or icon string shown before label |
| `color`  | No       | Background color for badge display (hex, e.g. `"#e8f5e9"`) |

Both formats can be mixed in the same array, but this is not recommended.

---

## Version Management

### Semantic Versioning

Use semantic versioning: `MAJOR.MINOR.PATCH`

- **MAJOR**: Breaking changes to schema or entity definitions
- **MINOR**: New entities or backward-compatible features
- **PATCH**: Bug fixes, documentation updates

### Two Version Numbers

1. **`version`**: Overall module version (includes all changes)
2. **`dbSchemaVersion`**: Database schema version (only bumped for schema changes)

---

## Installation & Reinstallation

### CLI Commands

```bash
# Via Docker (from /docker directory)
docker/cli.sh module install --code <tenant> --path /modules/<module>
docker/setup-tenant.sh <code> <name> [email] [--erp]
docker/install-modules.sh <code> --erp

# Local CLI (from /server directory)
dotnet run --project src/dForge.Cli -- module install --code <tenant> --path /path/to/module

# Force reinstall (cleans metadata and re-registers)
dotnet run --project src/dForge.Cli -- module install --code <tenant> --path /path/to/module --force
```

### What Happens During Install

1. **DDL**: Schema + tables created (`CREATE TABLE IF NOT EXISTS`)
2. **Seed data**: Records inserted (`INSERT ... ON CONFLICT DO NOTHING`)
3. **Entities**: Registered in `dForge.entity` + `dForge.entity_column`
4. **Security**: `sec_object` + `module_role` + `module_role_rights` + `user_role`
5. **Data views**: Registered in `dForge.data_view`
6. **Menus**: `dForge.menu` + `dForge.menu_item` + `dForge.folder` + `dForge.folder_entity` + `dForge.folder_menu`

### Force Reinstall

With `--force`, the metadata cleaner runs first:
- Deletes: `folder_entity` → `folder_menu` → `folder` → `menu_item` → `menu` → `data_view` → `module_role_rights` → `user_role` → `module_role` → `sec_object` → `entity_column` → `entity`
- Then re-registers everything fresh

---

## Summary Checklist

When creating a module, ensure:

- [ ] Uses TABS for indentation (JSON: 2, Code: 4)
- [ ] `manifest.json` includes `entities` registry mapping codes to file paths
- [ ] Entity files use `"link"` (not `"params"`) for reference/set column bindings
- [ ] All `fieldTypeCd` values are valid — see [Field Types](../data-model/field-types.md) (use `number`, not `integer`)
- [ ] FK+Reference two-column pattern used for all foreign keys
- [ ] `data_views.json` uses `dataSources` array (not root-level `entityCode`)
- [ ] `menus.json` uses nested dictionaries with `children` (not arrays)
- [ ] `menus.json` leaf items use `dataViewCode` (not `viewCode`)
- [ ] `folders.json` uses entity dictionary with `{ viewName, quickAdd }` objects
- [ ] `roles.json` uses `"rights"` property (not `"entityRights"`)
- [ ] Seed data files are numbered for FK dependency order (01-, 02-, etc.)
- [ ] Seed data includes explicit numeric (int8) PKs for cross-entity references — NOT UUID strings (`cuid` is `int8`)
- [ ] `translations/<locale>.json` covers entities (+ fields), folders, views, menus (+ items), actions (+ params), and reports (+ dataset captions, + params) for every locale declared in `manifest.supportedLocales`. Do not include `en`/`en-US`. Sections `roles` and `print_templates` are not displayed even if listed.
- [ ] Constraints have clear user-facing `message` values
- [ ] Check constraint `expression` uses standard SQL subset (test in PostgreSQL first)
- [ ] Number sequences declared as `numberSequence` on entity definitions (auto-fills on INSERT, never manual counting)
- [ ] Print templates defined in `ui/print_templates.json` with HTML files in `print_templates/` (see [Print Templates](../ui/print-templates.md))
- [ ] Scheduled jobs (if any) declared in `logic/jobs.json` with 5-field cron, explicit `timeout`, and `class: "long_running"` for any `timeout > 300`

---

## Reference Implementations

- **CRM module**: `modules/crm/` — complete example with 9 entities
- **HR module**: `modules/hr/` — complete example with 10 entities
- **Chore module**: `modules/chore/` — minimal `logic/jobs.json` reference (one cron-fired action)
- **System modules**: `server/database/system-modules/admin/` and `metadata/`
