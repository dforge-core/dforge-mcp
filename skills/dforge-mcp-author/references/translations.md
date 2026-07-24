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
    "roles": {
        "crm.admin": { "label": "CRM Administrator" },
        "crm.sales-rep": { "label": "Sales Representative" }
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
| `roles` | Role display labels | Role codes (keys from `security/roles.json`, already module-qualified — e.g. `crm.admin`) → `{ label }` |
| `views` | Data view labels | View codes (keys from `ui/data_views.json`) |
| `menus` | Menu node labels (root + nested items) | Menu root key → `{ label, items: { item_code: { label } } }` matching `ui/menus.json` structure |
| `actions` | Action labels, descriptions, and param labels | Action codes (keys from `ui/actions.json`) → `{ label, desc, params: { param_cd: { label } } }` |
| `reports` | Report dataset captions and param labels | Report codes → `{ datasets: { ds_cd: { caption } }, params: { param_cd: { label } } }` |
| `entities.<e>.constraints` | Check/unique constraint violation messages (opt-in — warned, not enforced) | Constraint codes → `{ message }` under the owning entity |
| `entities.<e>.fields.<f>.options` | Dropdown/radio/flags **option labels** (opt-in) | Option `value` → localized label (string) or `{ label, icon, color }` |
| `domains` | Column domain labels **and** their shared option labels (opt-in) | Domain codes → `{ label, options: { value: … } }` |

### Constraint violation messages ARE translatable (opt-in)

A check/unique constraint declares a user-facing `message` in the entity JSON (`constraints.<name>.message`). That message is the **base/fallback text**. To localize it, add a per-locale override under `entities.<entityCd>.constraints.<constraintName>.message`:

```json
"entities": {
    "employee": {
        "constraints": {
            "chk_salary_positive": { "message": "Gehalt muss positiv sein" },
            "UQ_employee_code":    { "message": "Mitarbeiter-Code muss eindeutig sein" }
        }
    }
}
```

- The server resolves the message with culture fallback — **per-locale override → base message from the entity JSON**. `EntityMetadataLoader` reads `COALESCE(culture_res.label, resource.label, entity_constrains.description)`, so the same override surfaces on the client pre-save `CheckConstraints` validator and the server DB-violation (23514) path.
- **Opt-in, never mandatory** (unlike roles/labels, which completeness *enforces*). If the manifest lists `supportedLocales` and a constraint `message` has no override for one of those (non-English) locales, install emits a **non-fatal warning** naming the missing `entities.<e>.constraints.<c>.message` keys (printed by the CLI, returned in the marketplace install response). Install still commits with the base message as the fallback. `dforge_module_validate` surfaces the same gap pre-flight as a warning.
- Only constraints that declare a `message` are scanned; English (`en`/`en-*`) is the base and is never warned; extension entities (`"extends": "..."`) are skipped — their constraint translations belong with the foreign module's files.

### Dropdown option labels ARE translatable (opt-in)

The `options` on a `dropdown`/`radio`/`flags` column are the **base (fallback) labels**. To translate the labels a user actually sees, add an `options` map next to the field's `label`, keyed by the option's **value** (the stored code):

```json
"entities": {
    "position": {
        "fields": {
            "status": {
                "label": "Status",
                "options": {
                    "on_hold": { "label": "In Wartestellung", "color": "#f90" },
                    "draft":   "Entwurf"
                }
            }
        }
    }
}
```

- An override is a **partial merged over the base** — a bare string is shorthand for `{ "label": … }`; any field it omits (icon/color) falls through to the authored option. Only `label`, `icon`, `color` are translatable; **`value` is the stored code and is never translated** (translations match on it).
- **Opt-in, never mandatory** — an option with no override keeps its authored label; nothing warns or fails.
- Resolved once at metadata-load time and cached per culture, so the localized labels show up identically in the grid, the form, **and** print templates (`_fmt.<col>` / bare field refs) — which previously always rendered the base English label.
- `optionSets` conditional narrowing is unaffected: it filters by `value`, which translation never touches.

### Column domain labels + options ARE translatable (opt-in) — and shared

If a column uses a **domain** (see `column-domains.md`), translate the domain **once** under a top-level `domains` section — its label and per-option labels then flow to *every* column that references it, instead of once per column:

```json
"domains": {
    "doc_status": {
        "label": "Belegstatus",
        "options": { "draft": "Entwurf", "posted": { "label": "Gebucht", "color": "#0a0" } }
    }
}
```

- Keys are domain codes from this module's `domains.json`. The `options` map uses the same value-keyed, partial-override shape as field options above.
- This is the whole point of domains for localization: the shared option list is authored and translated in one place. Don't also translate the consuming columns' options — they inherit from the domain.

### Roles ARE translated — and completeness is enforced

Role labels are **required and localized** (this changed — older docs said roles were skipped; they are not). `SecurityRegistrar` gives every role a `res_id`, so `TranslationRegistrar` wires the role label exactly like entities/views/menus:

```json
"roles": {
    "crm.admin":      { "label": "CRM Administrator" },
    "crm.sales-rep":  { "label": "Sales Representative" }
}
```

- **Keys are the role codes** from `security/roles.json` — already module-qualified (e.g. `crm.admin`, `crm.sales-rep`). They match `module_role.name`.
- **Value is `{ "label": ... }`** — the localized display name. It supersedes the `description` from `roles.json` at runtime; `description` remains the English fallback if a role has no translation entry.
- **Completeness is enforced.** `TranslationCompletenessValidator` requires `roles.<code>.label` for **every** role in `security/roles.json`, in **every** translation file — including the `en-US` base. A missing role label fails install with `Label for role '<code>'.` So ship a `roles` block with a label for each role in **each** `translations/<locale>.json` (en-US + every locale in `supportedLocales`).

### Sections that are NOT translated (write-time only)

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
    "roles": {
        "crm.admin": { "label": "CRM-Administrator" },
        "crm.sales-rep": { "label": "Vertriebsmitarbeiter" }
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

Non-English locales are declared in `supportedLocales` (an array of `ll-CC` tags) — **not** a `translations` object. The manifest schema has no `translations` key and rejects it (`additionalProperties: false`). Translation files are auto-discovered at `translations/<locale>.json`. Ship `translations/en-US.json` as the English base, but do **not** list `en`/`en-US` in `supportedLocales` — it covers the non-English locales only (the schema rejects `en`/`en-US` entries).

```json
"supportedLocales": ["de-DE", "fr-FR"]
```

Every listed locale MUST have a matching `translations/<locale>.json` with a label for each translatable resource, or install fails completeness validation.

## Rules

1. **Always provide `en-US`** as the base language. Other languages fall back to it for missing keys.
2. **Locale format is `ll-CC`** (e.g. `en-US`, `de-DE`, `fr-FR`) — language code + country code, hyphen-separated.
3. **Translate everything user-visible**: entity labels, every field label (including trait-provided fields like `created_date`, `last_updated`), view names, menu items, action labels, **role labels (required — completeness-enforced, `roles.<code>.label` for every role in every locale incl. en-US)**, setting labels, folder names.
4. **Include virtual columns** (references, sets, formulas) in field translations — they appear in the UI just like physical columns.
5. **Menu translations mirror the `ui/menus.json` structure** — root key → `items` → nested items.
6. **Missing keys fall back** to the `en-US` value, then to the raw code name. So it's safe to ship partial translations — untranslated items show in English rather than breaking.
7. **Don't translate column codes** — only the `label` values. Codes stay as-is in all languages.
8. **File naming**: `translations/<locale>.json` (e.g. `de-DE.json`) — each non-English file must match a locale listed in `supportedLocales`.
9. **Constraint messages are opt-in** — localize them under `entities.<e>.constraints.<c>.message` when you want a per-locale violation message; otherwise the base `message` from the entity JSON is used. Missing overrides warn (non-fatal), they don't fail install. See "Constraint violation messages ARE translatable" above.

## When to create translations

- **Always** create `translations/en-US.json` — even for English-only modules. It ensures all labels are explicitly declared rather than derived from column codes.
- **On request** create additional languages. The LLM can generate translations from the `en-US` file — the structure is identical, only `label` and `desc` values change.
- **Include all fields** in each language file, including trait-provided fields (`created_date`, `last_updated`, `created_by`, etc.) — users see these columns and they need labels.
