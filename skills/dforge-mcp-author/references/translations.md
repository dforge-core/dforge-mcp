# Translations Reference

dForge modules support multi-language translations for user-facing labels — entity names, field labels, view titles, folder names, menu items, action labels and params, and report params/dataset captions.

Lives in: `translations/<locale>.json` (e.g. `translations/en-US.json`, `translations/de-DE.json`)

Locale codes use the `ll-CC` format (language-country): `en-US`, `de-DE`, `fr-FR`, `es-ES`, etc.

## Structure

Translation files mirror the module's content structure. Each translatable object has a `label` (and optionally `desc` for description):

```json
{
    "entities": {
        "contact": {
            "label": "Contact",
            "desc": "People at accounts",
            "fields": {
                "contact_id": { "label": "Contact ID" },
                "first_name": { "label": "First Name" },
                "last_name": { "label": "Last Name" },
                "email": { "label": "Email" },
                "phone": { "label": "Phone" },
                "account": { "label": "Account" },
                "owner_id": { "label": "Owner" },
                "created_date": { "label": "Created Date" },
                "last_updated": { "label": "Last Updated" },
                "activities": { "label": "Activities" }
            }
        }
    },
    "folders": {
        "crm": { "label": "Sales CRM" }
    },
    "views": {
        "contacts": { "label": "Contacts" },
        "contacts_list": { "label": "Contact List" },
        "contacts_gallery": { "label": "Contact Cards" }
    },
    "menus": {
        "crm_menu": {
            "label": "Sales CRM",
            "items": {
                "customers": { "label": "Customers" },
                "contacts": { "label": "Contacts" }
            }
        }
    },
    "actions": {
        "create_quote_from_opp": {
            "label": "Create Quote",
            "desc": "Create a draft quote from this opportunity",
            "params": {
                "discount_pct": { "label": "Discount %" }
            }
        }
    },
    "reports": {
        "sales_pipeline": {
            "datasets": {
                "opportunities": { "caption": "Open Opportunities" }
            },
            "params": {
                "min_amount": { "label": "Minimum Amount" }
            }
        }
    }
}
```

## Top-level sections

| Section | Translates | Keys are |
|---|---|---|
| `entities` | Entity labels (`label`, `desc`) and all field labels | Entity codes → `{ label, desc, fields: { field_code: { label } } }` |
| `folders` | Folder labels | Folder codes (root folder key from `ui/folders.json`) |
| `views` | Data view labels | View codes (keys from `ui/data_views.json`) |
| `menus` | Menu node labels (root + nested items) | Menu root key → `{ label, items: { item_code: { label } } }` matching `ui/menus.json` structure |
| `actions` | Action labels, descriptions, and param labels | Action codes (keys from `ui/actions.json`) → `{ label, desc, params: { param_cd: { label } } }` |
| `reports` | Report dataset captions and param labels | Report codes → `{ datasets: { ds_cd: { caption } }, params: { param_cd: { label } } }` |

### Sections that are NOT translated (write-time only)

- `roles` — role rows have no `res_id` column. The `roles` key may appear in shipped translation files (e.g. `modules/crm/translations/de-DE.json`) but is **explicitly skipped** by the installer. Role display name comes from `security/roles.json` `description` only. (Comment in [`TranslationRegistrar.cs:248`](../../../server/src/dForge.Admin/Services/ModuleInstall/TranslationRegistrar.cs#L248): "reserved for future use.")
- `settings` — completeness *is* checked by the validator when listed in `manifest.supportedLocales` (so you'll be forced to ship `settings.<cd>.label` for each declared locale), but the registrar doesn't display those translated labels at runtime. The English `label` in `settings.json` is what users see today.
- `print_templates` — not currently consumed by the registrar. Template labels come from `ui/print_templates.json`.

If you include these sections, the install succeeds (they're silently ignored) — but you won't see localized output for them, so don't expect it.

## German example (de-DE)

```json
{
    "entities": {
        "contact": {
            "label": "Kontakt",
            "desc": "Personen bei Konten",
            "fields": {
                "contact_id": { "label": "Kontakt-ID" },
                "first_name": { "label": "Vorname" },
                "last_name": { "label": "Nachname" },
                "email": { "label": "E-Mail" },
                "phone": { "label": "Telefon" },
                "account": { "label": "Konto" },
                "owner_id": { "label": "Besitzer" },
                "created_date": { "label": "Erstellt am" },
                "last_updated": { "label": "Zuletzt aktualisiert" }
            }
        }
    },
    "folders": {
        "crm": { "label": "Vertrieb CRM" }
    },
    "views": {
        "contacts": { "label": "Kontakte" }
    },
    "menus": {
        "crm_menu": {
            "label": "Vertrieb CRM",
            "items": {
                "customers": { "label": "Kunden" },
                "contacts": { "label": "Kontakte" }
            }
        }
    },
    "actions": {
        "create_quote_from_opp": { "label": "Angebot erstellen" }
    }
}
```

## Manifest declaration

List translation files in the manifest:

```json
"translations": {
    "en-US": "./translations/en-US.json",
    "de-DE": "./translations/de-DE.json"
}
```

## Rules

1. **Always provide `en-US`** as the base language. Other languages fall back to it for missing keys.
2. **Locale format is `ll-CC`** (e.g. `en-US`, `de-DE`, `fr-FR`) — language code + country code, hyphen-separated.
3. **Translate everything user-visible**: entity labels, every field label (including trait-provided fields like `created_date`, `last_updated`), view names, menu items, action labels, role descriptions, setting labels, folder names.
4. **Include virtual columns** (references, sets, formulas) in field translations — they appear in the UI just like physical columns.
5. **Menu translations mirror the `ui/menus.json` structure** — root key → `items` → nested items.
6. **Missing keys fall back** to the `en-US` value, then to the raw code name. So it's safe to ship partial translations — untranslated items show in English rather than breaking.
7. **Don't translate column codes** — only the `label` values. Codes stay as-is in all languages.
8. **File naming**: `translations/en-US.json`, `translations/de-DE.json`, etc. — must match the locale codes in the manifest.

## When to create translations

- **Always** create `translations/en-US.json` — even for English-only modules. It ensures all labels are explicitly declared rather than derived from column codes.
- **On request** create additional languages. The LLM can generate translations from the `en-US` file — the structure is identical, only `label` and `desc` values change.
- **Include all fields** in each language file, including trait-provided fields (`created_date`, `last_updated`, `created_by`, etc.) — users see these columns and they need labels.
