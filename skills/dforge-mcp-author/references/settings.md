# Module Settings Reference

Module settings are **configurable values** scoped to a module. Tenant admins set them; module code reads them at runtime. Values inherit through the folder tree (child folder overrides parent, parent overrides module default).

Lives in: `settings.json` at the module root.

## Structure

Settings use the **same field type system as entity columns**. Each setting is like a single column with a default value.

```json
{
    "company_name": {
        "fieldTypeCd": "text",
        "baseDatatypeCd": "string",
        "description": "Company name displayed on documents",
        "defaultValue": "Your Company Name"
    },
    "invoice_prefix": {
        "fieldTypeCd": "text",
        "baseDatatypeCd": "string",
        "description": "Prefix for auto-generated invoice numbers",
        "defaultValue": "INV-"
    },
    "default_currency": {
        "fieldTypeCd": "dropdown",
        "baseDatatypeCd": "string",
        "description": "Default currency code for documents",
        "defaultValue": "USD",
        "params": {
            "options": ["USD", "EUR", "GBP", "CHF"]
        }
    },
    "allow_negative_stock": {
        "fieldTypeCd": "checkbox",
        "baseDatatypeCd": "bool",
        "description": "Allow operations that result in negative stock",
        "defaultValue": false
    },
    "company_logo": {
        "fieldTypeCd": "image",
        "description": "Shown on printed documents"
    }
}
```

## Reading settings

From formulas, reference settings with `$[setting_name]`:

```
[total] * (1 + $[vat_rate] / 100)
```

From DSL actions (check your dForge version for exact syntax):

```
execute:
    rate = settings.vat_rate
    tax = [total] * rate / 100
```

From number sequence patterns:

```
"pattern": "$[invoice_prefix]-{yyyy}-{seq:4}"
```

## Folder-scoped inheritance

Settings resolve at runtime through the folder hierarchy:

1. The folder the user is currently in → its override (if any)
2. Parent folder → override (if any)
3. ... up the tree ...
4. Module default (from `settings.json`)

This means different folders can have different VAT rates, different prefixes, different currencies — without any code changes.

## Field types supported in settings

Any field type that makes sense for a single scalar value:

- `text`, `textarea`, `richtext`, `code`
- `number`, `currency`, `percent`
- `checkbox`
- `date`, `datetime`, `time`
- `dropdown`, `flags`, `color`, `tags`
- `image`, `file`
- `json`
- `user` (if you want to store a reference to a specific user)

**Not supported** as settings:

- `lookup` (reference to an entity row) — use a `text` setting holding a code instead
- `grid` (set) — settings are single values

## Params

Settings support the same `params` as entity columns:

- `options` (for `dropdown` and `flags`)
- `min`, `max` (for `number`)
- `currency` (for `currency`)
- `maxLen` (for `text`)

## Declaring setting access in roles

By default, only the module/tenant admin can change settings. If you want specific roles to read or modify settings, grant appropriate rights on the settings objects in `security/roles.json` (check your dForge version for the exact naming).

## Common mistakes

- Forgetting to declare `defaultValue` (the key is `defaultValue`, not `default`) — missing setting values cause runtime errors when formulas reference them.
- Using `lookup` as a setting field type — unsupported.
- Hardcoding values that should be settings — makes the module non-configurable. Any string/number that might vary per deployment is a good candidate for a setting.
- Reading a setting that doesn't exist — returns null, which causes formula errors. Always provide a default.

## Reference

This file covers the module package format for settings. If you need details on the runtime resolution API (`settings.get`, `settings.list`, `settings.set`, `settings.clear`), ask the user to check their dForge version's settings documentation.
