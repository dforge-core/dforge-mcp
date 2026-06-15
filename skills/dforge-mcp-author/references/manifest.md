# Module Manifest Reference

Every dForge module has a `manifest.json` at its root. This file declares the module's identity, version, dependencies, and the list of files that make up the package.

## Minimal example

```json
{
    "packageFormat": 1,
    "moduleId": "10000000-0000-0000-0000-000000000001",
    "code": "my_module",
    "version": "0.1.0",
    "dbSchemaVersion": "0.0.1",
    "displayName": "My Module",
    "description": "A module that does a thing.",
    "author": { "name": "Your Name" },
    "license": "MIT",
    "category": "other",
    "tags": ["tag1", "tag2"],
    "icon": "bi-box",
    "dependencies": {
        "admin": ">=0.0.1"
    },
    "created": "2026-04-08",
    "updated": "2026-04-08",
    "entities": {
        "my_entity": "./entities/my_entity.json"
    }
}
```

## Required fields

| Field | Type | Description |
|---|---|---|
| `packageFormat` | number | Package format version. Always `1` for now. |
| `moduleId` | UUID | Globally unique module identifier. Generate a fresh UUID for new modules; never reuse. |
| `code` | string | Short identifier, lowercase, letters+digits+underscores. **Becomes the DB schema name.** Cannot be changed after install. |
| `version` | semver | Module version. Bump on every release. |
| `dbSchemaVersion` | semver | Schema version. Bump when the DB schema changes (column add/remove, new entity, etc.). |
| `displayName` | string | Human-readable name shown in the UI and marketplace. |

## Optional but recommended

| Field | Type | Description |
|---|---|---|
| `description` | string | One-line summary of what the module does. |
| `author` | object | `{ name, url? }` — `additionalProperties: false` (no `email`) |
| `auditHistory` | string | Module-wide default audit mode: `"basic"`, `"fields"`, or `"full"`. Omit to disable. Per-entity `auditHistory` overrides it. |
| `license` | string | SPDX identifier (e.g. `"MIT"`, `"Apache-2.0"`) |
| `category` | string | Marketplace category slug (e.g. `"sales"`, `"hr"`, `"other"`) |
| `tags` | string[] | Search tags |
| `icon` | string | Bootstrap icon name (e.g. `"bi-briefcase"`) or similar |
| `dependencies` | object | Map of `module_code → semver range` |
| `created`, `updated` | ISO date | Timestamps |

## Content declarations

The manifest declares **only `entities`**. Every other artifact (views, menus, actions, roles, folders, settings, seed data, …) is **auto-discovered** by the installer from its fixed conventional path — there is **no** manifest key for it. The manifest schema is `additionalProperties: false`, so adding a `dataViews` / `menus` / `actions` / `security` / `seedData` / `webhooks` / `printTemplates` key fails validation.

| Key | Type | Shape |
|---|---|---|
| `entities` | object | `{ "entity_code": "./entities/entity.json" }`. Dotted keys (`"fin.invoice"`) declare an **extension** of another module's entity — the referenced file has `"extends": "fin.invoice"` inside. |
| `supportedLocales` | string[] | Non-English IETF locale tags the module ships translations for, e.g. `["de-DE", "uk-UA"]`. Translation files are auto-discovered at `./translations/{locale}.json` (no per-file entry). English (`en`/`en-*`) is the default and must **not** be listed. |

### Auto-discovered files (do NOT list these in the manifest)

The installer reads each of these from its fixed path when present — none are referenced from `manifest.json`:

| Artifact | Path |
|---|---|
| Security roles | `security/roles.json` |
| Data views | `ui/data_views.json` |
| Menus | `ui/menus.json` |
| Folders | `ui/folders.json` |
| Actions (metadata) | `ui/actions.json` (DSL bodies in `logic/actions/*.dsl`) |
| Reports | `ui/reports.json` |
| Print templates (metadata) | `ui/print_templates.json` (HTML/CSS under `print_templates/`) |
| Saved queries | `ui/queries.json` |
| Settings | `settings.json` |
| Triggers | `logic/triggers.json` |
| Scheduled jobs | `logic/jobs.json` |
| Webhooks | `logic/webhooks.json` |
| Stored procedures | `logic/stored_procedures.json` |
| Traits | `traits.json` |
| Seed data | `seed-data/*.json` (numbered for FK order) |
| Translations | `translations/{locale}.json` |
| Static files | `files/` |

## Dependencies

Dependencies are a map of module codes to semver ranges. The installer checks that all listed dependencies are installed with compatible versions before installing your module.

```json
"dependencies": {
    "admin": ">=0.0.1",
    "fin": ">=0.1.0 <0.2.0"
}
```

**Always depend on `admin`** unless you have a very unusual module — admin provides the user/role system every other module needs.

**For bridge modules** (`crm-fin`, `wms-fin`, etc.), depend on both sides:

```json
"dependencies": {
    "admin": ">=0.0.1",
    "crm": ">=0.1.0",
    "fin": ">=0.1.0"
}
```

## Extension entities

Modules can extend entities owned by other modules. Declare these in `entities` with dotted keys:

```json
"entities": {
    "my_extra_entity": "./entities/my_extra_entity.json",
    "fin.invoice": "./entities/fin.invoice.json"  // extends fin's invoice
}
```

The extension file has `"extends": "fin.invoice"` inside. See MODULE_CONVENTIONS.md for details.

## What NOT to put in the manifest

- **Do not** add artifact-listing keys. There is **no** `dataViews`, `menus`, `actions`, `reports`, `settings`, `security`, `seedData`, `webhooks`, `printTemplates`, `entityViews`, or `translations` manifest field — every artifact is auto-discovered from its fixed path (see "Auto-discovered files" above). The manifest schema is `additionalProperties: false`, so any stray key fails validation. In particular, roles live in `security/roles.json` and folders in `ui/folders.json` (both auto-discovered), **not** in a manifest `security` block; and translation files are auto-discovered at `./translations/{locale}.json` with non-English locales declared in `supportedLocales` (English never listed).
- **Do not** put entity definitions inline. Always reference external files.
- **Do not** list sample or test files — only content that ships with the module.
- **Do not** include `system: true` unless this is a dForge platform module (`admin`, `metadata`). Regular modules omit it (defaults to `false`).
- **Do not** hardcode absolute paths. Everything is relative to the manifest.

## Versioning notes

- Bump `version` on every release (bug fix, feature add, etc.).
- Bump `dbSchemaVersion` **only** when the DB schema changes. If you added an action but no new columns, `version` goes up but `dbSchemaVersion` stays the same.
- The installer uses `dbSchemaVersion` to decide whether to run migrations.
