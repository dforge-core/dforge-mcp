# Field Types Reference

The canonical list of field types supported by dForge. **Do not invent new values — the set is fixed** and validated by the platform on module install.

Source of truth: `server/database/system-modules/metadata/seed-data/field_types.json` in the dForge repo.

> **You usually don't set `dbDatatype`.** For a plain data column, omit it — the field tools derive it from `fieldTypeCd` (the "Common `dbDatatype`" column below): `currency` → `numeric(18,2)`, `text` → `varchar`, `checkbox` → `bool`, etc. An explicit value is never overridden, so only set `dbDatatype` when you need to:
> - **a hidden FK column** — it has no `fieldTypeCd`, so derivation can't fire; set `dbDatatype: "cuid"` to match the target entity's `identity` PK (see `column-types.md`);
> - **override the size/precision** — e.g. `varchar(100)` via `maxLen`, or a specific numeric scale.
>
> Reference (`columnType: "R"`) and formula (`columnType: "F"`) columns never get a `dbDatatype` at all.

## String-backed

| `fieldTypeCd` | `baseDatatypeCd` | Description | Common `dbDatatype` | Params |
|---|---|---|---|---|
| `text` | `string` | Single-line text | `varchar` (with `maxLen`) | `maxLen` |
| `avatar` | `string` | Person/company name rendered as an initials circle; optional photo. | `varchar` | `imageColumn` (an `image` column on the same entity to use as the photo) |
| `email` | `string` | Email address. Client-side format validation. | `varchar` 250 | — |
| `phone` | `string` | Phone/telephone. | `varchar` 50 | — |
| `url` | `string` | Web URL. | `varchar` 500 | — |
| `textarea` | `string` | Multi-line plain text. | `text` | `defaultLines`, `maxLines` |
| `markdown` | `string` | Markdown editor (Write/Preview tabs), rendered sanitized. | `text` | — |
| `richtext` | `string` | Rich text WYSIWYG editor, stores sanitized HTML. | `text` | — |
| `code` | `string` | Code editor with syntax highlighting. | `text` | `language` |
| `dropdown` | `string` | Fixed list of options. | `varchar` | `options: ["a","b",…]` or `[{value,label,icon,color}]` |
| `flags` | `string` | Multiple checkboxes with letter flags. | `varchar` | `optionSets`, `style: "buttons"` |
| `tags` | `string` | Free-form tag list. | `varchar` or `text` | — |
| `color` | `string` | Color picker. | `varchar(20)` | — |
| `hidden` | `string` | Internal, never shown in UI. | `varchar` | — |

## Number-backed

| `fieldTypeCd` | `baseDatatypeCd` | Description | Common `dbDatatype` | Params |
|---|---|---|---|---|
| `number` | `number` | Numeric value. | `int`, `bigint`, `numeric` | `min`, `max`, `scale` |
| `currency` | `number` | Monetary value. Precision 2. | `numeric(18,2)` | `currency: "USD"`, `min`, `max` |
| `percent` | `number` | Percentage 0–100. Precision 2. | `numeric(5,2)` | `min`, `max` (default 0–100) |

## Boolean-backed

| `fieldTypeCd` | `baseDatatypeCd` | Description | Common `dbDatatype` | Params |
|---|---|---|---|---|
| `checkbox` | `bool` | Boolean checkbox. | `bool` | — |

> **`checkbox` is the only valid `fieldTypeCd` for boolean fields.** Do not use `bool`, `boolean`, or `toggle` as `fieldTypeCd` — those are not valid field type codes. (`bool` IS the correct `dbDatatype` for this field, but `checkbox` is the only correct `fieldTypeCd`.)

## Date/time-backed

| `fieldTypeCd` | `baseDatatypeCd` | Description | Common `dbDatatype` | Params |
|---|---|---|---|---|
| `date` | `date` | Calendar date only. | `date` | `min`, `max` (ISO strings or `TODAY()`) |
| `datetime` | `timestamp` | Date + time with timezone. | `timestamptz` | `min`, `max` |
| `time` | `time` | Time of day. | `time` | — |

## Binary / file

> **Stored as `jsonb`, not `bytea`.** Despite the `binary` base datatype, a `file`/`image` column holds a JSON metadata reference (`{ storagePath, fileName, … }`) — the bytes live in file storage. The field tools derive `jsonb`; do **not** set `dbDatatype: "bytea"`.

| `fieldTypeCd` | `baseDatatypeCd` | Description | Common `dbDatatype` | Params |
|---|---|---|---|---|
| `file` | `binary` | Arbitrary file upload. | `jsonb` | `accept`, `maxSize` |
| `image` | `binary` | Image upload with preview. | `jsonb` | `maxSize`, `dimensions` |

## Reference / lookup / set

| `fieldTypeCd` | `baseDatatypeCd` | `columnType` | Description |
|---|---|---|---|
| `lookup` | `guid` | `R` | Reference to another entity (always paired with a hidden FK column — see SKILL.md "FK+Reference pattern") |
| `user` | `cuid` | `D` | User picker. Writes a user ID directly, no paired FK needed. |
| `grid` | `set` | `S` | Detail grid of related records (1:N backwards reference). Used with `link` declaring the relation. |
| `list` | `set` | `S` | Detail list — same 1:N set as `grid`, rendered as a card list instead of a table. |
| `entitylink` | `json` | `D` | Polymorphic link to any entity (stores `{entity, id}` pair). Populate from action DSL with the `entityLink('entityCd', record, description?)` built-in (see `action-dsl.md`). |

## JSON

| `fieldTypeCd` | `baseDatatypeCd` | Description |
|---|---|---|
| `json` | `json` | JSON editor. Stored in `jsonb`. |

---

## Default values

There is **no** `defaultValue` (or `default`) key on an entity data column — it fails schema
validation (`entity.schema.json` is `additionalProperties: false`). To give a column a default:

| Need | Do this |
|---|---|
| Literal / computed default (`'draft'`, `TODAY()`) | Carry a `formula` on the column (formula context — uppercase `TODAY()`/`NOW()`), e.g. `"formula": "'draft'"` or `"formula": "TODAY()"`. |
| Document number (PO-2026-0001) | Declare a `numberSequence` on the entity — auto-fills on insert. |
| Anything set at create time | Set it in an action/trigger DSL (`execute:` uses lowercase `now()`). |

> `defaultValue` **is** valid on **module settings** (`settings.json`) — that's the only place it
> belongs. Don't carry the settings habit over to entity fields.

---

## Common mistakes

> **Wrong key name:** `fieldType` is a C# navigation property on the server model — it is not a valid JSON key in entity definitions. Always use `fieldTypeCd` (the string code). Using `fieldType: { ... }` or `fieldType: "date"` causes the platform to silently ignore the field type, producing null constraint errors on save.

> **No `defaultValue` on entity fields:** `defaultValue` is a *settings* key, not a column key — on a field it fails schema validation. Set a column default with a `formula`, a `numberSequence`, or DSL logic (see "Default values" above).

### Wrong `dbDatatype` values

These are SQL type names LLMs tend to use for `dbDatatype`. **They are all wrong.** The right values come from the tables above.

| Wrong `dbDatatype` | Right `dbDatatype` | Used with `fieldTypeCd` |
|---|---|---|
| `datetime` | `timestamptz` | `datetime` |
| `timestamp` | `timestamptz` | `datetime` |
| `boolean` | `bool` | `checkbox` |
| `string` | `varchar` (with `maxLen`) or `text` | `text`, `textarea`, `dropdown`, … |
| `integer` | `int` or `bigint` | `number` |
| `float`, `double`, `decimal` | `numeric` | `number`, `currency`, `percent` |
| `number` | `int`, `bigint`, or `numeric` | `number`, `currency`, `percent` |

### Wrong `fieldTypeCd` values

These are the field type names LLMs tend to invent. **They are all wrong.**

| Wrong | Right |
|---|---|
| key `fieldType: { fieldTypeCd: "date", ... }` | key `fieldTypeCd: "date"` (plain string) |
| key `fieldType: "date"` | key `fieldTypeCd: "date"` |
| `bool`, `boolean` | `checkbox` |
| `integer` | `number` |
| `float` | `number` |
| `decimal` | `number` with `scale` param |
| `datePicker` | `date` |
| `timestamp` | `datetime` |
| `money` | `currency` |
| `select`, `enum` | `dropdown` |
| `multiselect` | `flags` or `tags` |
| `autocomplete` | `lookup` |
| `reference` | `lookup` |
| `relation` | `lookup` or `grid` |
| `link` | `url` |
| `picture`, `photo` | `image` |
| `attachment` | `file` |
| `multiline` | `textarea` |
| `md` | `markdown` |
| `richText`, `wysiwyg`, `html` | `richtext` |
| `userPicker` | `user` |
| `phoneNumber` | `phone` |

## When in doubt

If the user describes a field type that isn't in this list (e.g. "rating stars", "geo location", "signature pad"), those field types **do not currently exist**. Do not fabricate a `fieldTypeCd` value. Tell the user what's available and ask how they'd like to model it with existing types (e.g. rating as `number` with `min: 1, max: 5`, geo location as two `number` columns or a `json` column).
