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
| `description` | string | One-line summary of what the module does. |

## Optional but recommended

| Field | Type | Description |
|---|---|---|
| `author` | object | `{name, email?, url?}` |
| `license` | string | SPDX identifier (e.g. `"MIT"`, `"Apache-2.0"`) |
| `category` | string | Marketplace category slug (e.g. `"sales"`, `"hr"`, `"other"`) |
| `tags` | string[] | Search tags |
| `icon` | string | Bootstrap icon name (e.g. `"bi-briefcase"`) or similar |
| `dependencies` | object | Map of `module_code → semver range` |
| `created`, `updated` | ISO date | Timestamps |

## Content declarations

The manifest lists every file in the package by logical key. The installer reads each path relative to the manifest.

| Key | Type | Shape |
|---|---|---|
| `entities` | object | `{ "entity_code": "./entities/entity.json" }` |
| `entityViews` | object | `{ "view_name": "./ui/entity_views/view.json" }` (optional) |
| `dataViews` | string | path to `./ui/data_views.json` (or object with per-view files) |
| `menus` | string | path to `./ui/menus.json` |
| `actions` | object | Actions defined in `./ui/actions.json`, DSL in `./logic/actions/*.dsl` |
| `reports` | object | `{ "report_code": "./ui/reports/report.json" }` |
| `settings` | string | path to `./settings.json` |
| `security` | object | `{ "roles": "./security/roles.json", "folders": "./ui/folders.json" }` |
| `seedData` | array | List of paths to seed files, in install order |
| `supportedLocales` | string[] | IETF locale tags that the module ships translations for, e.g. `["de-DE", "uk-UA"]`. Files are **auto-discovered** at `./translations/{locale}.json` — there is no per-file manifest entry. English (`en`/`en-*`) is the default and must not be listed. |
| `printTemplates` | object | `{ "template_code": "./print_templates/template.scriban" }` |
| `webhooks` | string | path to `./webhooks.json` |

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

- **Do not** add a `translations` key (e.g. `"translations": { "en-US": "..." }`). There is **no** such manifest field — translation files are auto-discovered at `./translations/{locale}.json`, and non-English locales are declared in `supportedLocales` (English is never listed). The manifest schema is `additionalProperties: false`, so a stray `translations` key fails install.
- **Do not** put entity definitions inline. Always reference external files.
- **Do not** list sample or test files — only content that ships with the module.
- **Do not** include `system: true` unless this is a dForge platform module (`admin`, `metadata`). Regular modules omit it (defaults to `false`).
- **Do not** hardcode absolute paths. Everything is relative to the manifest.

## Versioning notes

- Bump `version` on every release (bug fix, feature add, etc.).
- Bump `dbSchemaVersion` **only** when the DB schema changes. If you added an action but no new columns, `version` goes up but `dbSchemaVersion` stays the same.
- The installer uses `dbSchemaVersion` to decide whether to run migrations.
