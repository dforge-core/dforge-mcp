# Field Types Reference

The canonical list of field types supported by dForge. **Do not invent new values — the set is fixed** and validated by the platform on module install.

Source of truth: `server/database/system-modules/metadata/seed-data/field_types.json` in the dForge repo.

## String-backed

| `fieldTypeCd` | `baseDatatypeCd` | Description | Common `dbDatatype` | Params |
|---|---|---|---|---|
| `text` | `string` | Single-line text | `varchar` (with `maxLen`) | `maxLen` |
| `email` | `string` | Email address. Client-side format validation. | `varchar` 250 | — |
| `phone` | `string` | Phone/telephone. | `varchar` 50 | — |
| `url` | `string` | Web URL. | `varchar` 500 | — |
| `textarea` | `string` | Multi-line plain text. | `text` | `defaultLines`, `maxLines` |
| `richtext` | `string` | Rich text editor (HTML). | `text` | — |
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

## Date/time-backed

| `fieldTypeCd` | `baseDatatypeCd` | Description | Common `dbDatatype` | Params |
|---|---|---|---|---|
| `date` | `date` | Calendar date only. | `date` | `min`, `max` (ISO strings or `TODAY()`) |
| `datetime` | `timestamp` | Date + time with timezone. | `timestamptz` | `min`, `max` |
| `time` | `time` | Time of day. | `time` | — |

## Binary / file

| `fieldTypeCd` | `baseDatatypeCd` | Description | Params |
|---|---|---|---|
| `file` | `binary` | Arbitrary file upload. | `accept`, `maxSize` |
| `image` | `binary` | Image upload with preview. | `maxSize`, `dimensions` |

## Reference / lookup / set

| `fieldTypeCd` | `baseDatatypeCd` | `columnType` | Description |
|---|---|---|---|
| `lookup` | `guid` | `R` | Reference to another entity (always paired with a hidden FK column — see SKILL.md "FK+Reference pattern") |
| `user` | `cuid` | `D` | User picker. Writes a user ID directly, no paired FK needed. |
| `grid` | `set` | `S` | Detail grid of related records (1:N backwards reference). Used with `link` declaring the relation. |
| `entitylink` | `json` | `D` | Polymorphic link to any entity (stores `{entity, id}` pair). |

## JSON

| `fieldTypeCd` | `baseDatatypeCd` | Description |
|---|---|---|
| `json` | `json` | JSON editor. Stored in `jsonb`. |

---

## Common mistakes

> **Wrong key name:** `fieldType` is a C# navigation property on the server model — it is not a valid JSON key in entity definitions. Always use `fieldTypeCd` (the string code). Using `fieldType: { ... }` or `fieldType: "date"` causes the platform to silently ignore the field type, producing null constraint errors on save.

These are the field type names LLMs tend to invent. **They are all wrong.**

| Wrong | Right |
|---|---|
| key `fieldType: { fieldTypeCd: "date", ... }` | key `fieldTypeCd: "date"` (plain string) |
| key `fieldType: "date"` | key `fieldTypeCd: "date"` |
| `integer` | `number` |
| `float` | `number` |
| `decimal` | `number` with `scale` param |
| `bool`, `boolean` | `checkbox` |
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
| `richText`, `markdown` | `richtext` |
| `userPicker` | `user` |
| `phoneNumber` | `phone` |

## When in doubt

If the user describes a field type that isn't in this list (e.g. "rating stars", "geo location", "signature pad"), those field types **do not currently exist**. Do not fabricate a `fieldTypeCd` value. Tell the user what's available and ask how they'd like to model it with existing types (e.g. rating as `number` with `min: 1, max: 5`, geo location as two `number` columns or a `json` column).
