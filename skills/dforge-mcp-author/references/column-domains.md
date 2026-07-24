# Column Domains Reference

A **column domain** is a reusable, named field type — a base datatype, a control, sizing, and a shared option list under one code. Columns reference it instead of restating the definition. Use one whenever the same enum or typed column repeats across entities (a `Draft/Posted/Reversed` status, a currency code, a priority, an account type).

Lives in: `domains.json` at the module root (a flat map `domain_cd → definition`).

Schema: `dforge://schema/domains`.

## Why

Without domains, every "status" column restates the same `fieldTypeCd: "dropdown"` + the full `params.options` list — and, if you localize, the same option translations, once per column. A domain declares that once; every consuming column inherits the type, the control, the options, **and** their translations. Localize `fin.doc_status` a single time and all its uses update together.

## `domains.json`

```json
{
    "doc_status": {
        "description": "Document Status",
        "baseDatatypeCd": "string",
        "dbDatatype": "varchar",
        "maxLen": 20,
        "fieldTypeCd": "dropdown",
        "params": {
            "options": [
                { "value": "draft", "label": "Draft" },
                { "value": "posted", "label": "Posted", "color": "#0a0" }
            ]
        }
    }
}
```

| Key | Required | Notes |
|---|---|---|
| `baseDatatypeCd` | **yes** | What a consuming column's DDL is generated from (`string`, `number`, `date`, …). |
| `description` | no | Label. Localizable — see below. |
| `dbDatatype` | no | Physical Postgres type; omit to infer from `fieldTypeCd`. |
| `fieldTypeCd` | no | Control (`dropdown`, `text`, `number`, …). |
| `maxLen` / `precision` | no | Sizing for string / numeric domains. |
| `params` | no | Shared field-type config — most importantly `options` for `dropdown`/`radio`/`flags`. |

## Using a domain in an entity

A column swaps its whole type block for a single `domain` key — qualified as `module_cd.domain_cd`, or bare for a domain in the current module (unqualified resolves the current module first, then tenant-created domains):

```json
"status": {
    "domain": "fin.doc_status",
    "flags": "VEM",
    "orderNum": 40,
    "description": "Status"
}
```

The column keeps what is genuinely its own — `description` (its label), `flags`, `orderNum`, `isNullable`, `isPk`, `columnGroupCd`. The domain supplies the rest.

## Rules (these fail the install)

1. **Don't restate what the domain owns.** Declaring `dbDatatype`, `fieldTypeCd`, `maxLen`, `precision`, `baseDatatypeCd` or `params` alongside `domain` is rejected, naming the conflicting key — it is never silently overridden. Domains are authoritative.
2. **Scalar columns only.** A reference (`R`) or set (`S`) column can't use a domain — it has no datatype for the domain to supply. Drop the `domain` key on those.
3. **Declare the dependency for cross-module use.** `"domain": "fin.doc_status"` resolves by looking the domain up in the installed tenant, so declare `fin` in the manifest `dependencies` — dependencies drive install order, and without it nothing guarantees `fin` is installed first, so the resolve fails with "references unknown column domain".

## Localizing a domain (and its options)

Translate a domain **once** in `translations/<locale>.json` under a top-level `domains` section — its label and its per-option labels flow to every consuming column:

```json
"domains": {
    "doc_status": {
        "label": "Belegstatus",
        "options": { "draft": "Entwurf", "posted": { "label": "Gebucht", "color": "#0a0" } }
    }
}
```

An option override is a partial merged over the base — a bare string is shorthand for `{ "label": … }`; `value` is the stored code and is never translated. See `translations.md` ("Dropdown option localization").

## How it resolves (mental model)

- **Install** materializes the domain's structural fields (datatype/control/sizing) onto each consuming column, because DDL generation needs them locally.
- **Runtime** resolves `params` (the options) — and their per-culture overrides — from the domain, not the column. That is what lets a shared list be authored and translated once.

You don't act on this split; just know that the option list stays on the domain, so **don't** paste `params.options` onto a domain-backed column (the install rejects it).

## When NOT to use a domain

- A one-off column whose type/options appear nowhere else — inline it (`fieldTypeCd` + `params.options`) and skip the indirection.
- Anything non-scalar (references, sets, formulas).

## Common mistakes

- Putting `params.options` on the column **and** naming a `domain` → install error. Options belong on the domain.
- Using a cross-module domain without declaring the dependency → "unknown column domain" at install.
- Expecting per-column option overrides — the domain is authoritative in v1; narrow with `optionSets` (which filters by `value`) if you need a conditional subset.
