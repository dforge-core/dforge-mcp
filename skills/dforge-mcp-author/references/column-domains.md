# Column Domains Reference

A **column domain** is a reusable, named field type — a base datatype, a control, sizing, and a shared option list under one code. Columns reference it instead of restating the definition. Use one whenever the same enum or typed column repeats across entities (a `Draft/Posted/Reversed` status, a currency code, a priority, an account type).

Lives in: `domains.json` at the module root (a flat map `domain_cd → definition`).

Schema: `dforge://schema/domains`.

## Why

Without domains, every "status" column — and every action param that writes to one — restates the same `fieldTypeCd: "dropdown"` + the full `params.options` list, and, if you localize, the same option translations, once per consumer. A domain declares that once; every consuming column **and parameter** inherits the type, the control, the options, **and** their translations. Localize `fin.doc_status` a single time and all its uses update together.

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

## Using a domain in an action / report param

Parameters consume the same domain, so an action that writes to a domain-backed column offers exactly that column's choices instead of restating them:

```
params:
    status: domain fin.doc_status required "New status"
```

```json
"status": { "domain": "fin.doc_status", "label": "New status", "required": true }
```

- **Prefer this over inline `options=`** whenever the param's value ends up on a domain-backed column — otherwise the same enum is authored twice, translated twice, and free to drift (a param option whose code isn't on the column is a value the grid can't label).
- Install materializes the domain's `fieldTypeCd` onto the param; its datatype and sizing don't apply, because a parameter has no storage. A domain with no `fieldTypeCd` is rejected — the param would have no control to render.
- The param keeps its **own caption** (`"New status"` above) and translates it under `actions.<cd>.params.<param_cd>.label` as usual. Only the choices come from the domain, options translations included.
- Nothing may follow the description in the DSL form — `options=`, `min=` and friends are a compile error there, same authority rule columns get. A report param declaring both `domain` and `fieldTypeCd` is rejected for the same reason.

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
- **Runtime** resolves `params` (the options) — and their per-culture overrides — from the domain, not the column *or the param*. That is what lets a shared list be authored and translated once.

You don't act on this split; just know that the option list stays on the domain, so **don't** paste `params.options` onto a domain-backed column (the install rejects it).

## When NOT to use a domain

- A one-off column whose type/options appear nowhere else — inline it (`fieldTypeCd` + `params.options`) and skip the indirection.
- Anything non-scalar (references, sets, formulas).

## Common mistakes

- Putting `params.options` on the column **and** naming a `domain` → install error. Options belong on the domain.
- Restating a domain's list inline on an action param (`options=…`) instead of binding the param to the domain → compiles, but you now maintain and translate the same enum twice.
- Using a cross-module domain without declaring the dependency → "unknown column domain" at install.
- Expecting per-column option overrides — the domain is authoritative in v1; narrow with `optionSets` (which filters by `value`) if you need a conditional subset.
