# Column Flags Reference

Column flags are single-letter codes concatenated into a string. Order doesn't matter — `"VEM"` and `"EMV"` are equivalent.

Valid flags regex: `^[VIEM]*$`

## Flag letters

| Letter | Name | Meaning |
|---|---|---|
| `V` | Visible | Column appears in grid / form / card views. Omit to hide from standard UI. |
| `I` | Identity | Auto-managed by the platform. Used on PK columns, audit timestamps, system fields. Not shown in UI, not directly editable by users, excluded from required validation. |
| `E` | Editable | User can modify the value in the UI. Omit for read-only. |
| `M` | Mandatory | Required. Resolved into `isNullable: false` at install — see below. |

**Only these 4 letters are valid.** The platform rejects any other characters.
> **There is no `H` flag.** Earlier drafts listed one, described as "stronger than omitting `V`", and nothing ever read it — a column with `flags: "H"` is hidden because the string contains no `V`, not because it contains `H`. To hide a column, omit `V`. To hide it from specific folders (and make it unqueryable there), use an entity view. To render it as a hidden input, use `fieldTypeCd: "hidden"`.

> **The same letters override per entity view.** `views.<v>.columns.<cd>.flags` re-flags a column for the folders bound to that view, while the entity keeps its own flags everywhere else. Same `^[VIEM]*$` vocabulary — see "Per-view overrides" below. See `security.md` → Column-level security.

## `M` is the platform's one notion of "required"

At install, `MandatoryFlagNormalizer` folds `M` into `isNullable: false` before DDL
generation. Everything downstream reads only `isNullable`: the `NOT NULL` in the
generated DDL, `data.insert`'s required-column check, and the red asterisk on the
client. There is no second signal.

Four consequences worth knowing before you type a flag:

- **`M` makes the column `NOT NULL`.** It is not decoration and not a UI hint. Put it
  on a column only when a row is genuinely meaningless without the value.
- **`M` together with `"isNullable": true` is a hard error at pack time**, naming the
  entity and every offending field. It's a contradiction only you can resolve: drop
  `M` if the column is optional, or drop `isNullable` if it is required.
- **`M` is inert on virtual (`R`/`S`/`F`) and identity columns** — nullability is
  meaningless where there is no physical column. (At the *entity* level; a per-view
  override behaves differently — see "Per-view overrides".) It won't fail, but `VEM` on a
  Reference over an *optional* FK reads as a required field to the next author, which
  is exactly how these get out of step. Match the Reference to its FK.
- **Adding `M` to a shipped field aborts the upgrade** on any tenant whose existing
  rows leave it empty — rolled back, naming the column and its NULL row count. Give
  the column a `params.serverDefault` if the install should backfill it. Removing `M`
  is always safe.

Omitting both `M` and `isNullable` leaves the column nullable — that is the default.

## Per-view overrides

`views.<v>.columns.<cd>.flags` re-flags one column for the folders bound to that view. The letters are the same four, and `M` means the same thing — the installer folds it into **that override's** `isNullable`.

Because a view writes no DDL, the requiredness `M` produces there is runtime-only. That is how you express **"nullable in the database, mandatory in this view"**, which no entity-level flag can say:

```json
"views": {
  "compliance": {
    "columns": {
      "party_id": {},
      "party_name": { "flags": "V" },
      "vat_no":     { "flags": "VEM" },
      "salary":     { "flags": "" }
    }
  }
}
```

Three rules to keep straight:

- **The letters replace, they don't merge.** The cascade is `COALESCE(view, entity)`. A non-empty string wins outright, so `{ "flags": "V" }` is read-only there however the entity flagged the column.
- **`""` is a real value, omission is not.** An empty string means "no flags here" — neither visible nor editable. To inherit, leave the key out; `"flags": null` fails schema validation, since the property is typed `string`. (To inherit *everything*, set the whole column override to `{}` or `null`.)
- **The `M` fold is one-directional.** Dropping `M` from a view's flags does NOT make the column optional — `isNullable` still `COALESCE`s to the entity value. Write `"isNullable": true` to loosen it, and only where the database actually allows null, or the save trades a clean validation error for a raw constraint violation.

Unlike the entity level, `M` here is *not* inert on virtual or identity columns: the fold only reaches the runtime required check, so a view can mark a Reference required. (Identity columns stay excluded — they are never asked of the user.)

## Common column flag combinations

| Flags | Meaning | Use case |
|---|---|---|
| `"VEM"` | Visible, Editable, Mandatory | Required field shown in UI |
| `"VE"` | Visible, Editable, optional | Nullable field — the common case for most business fields |
| `"V"` | Visible, read-only | Display-only, like formula columns or computed values |
| `"E"` | Editable, **not visible** | Hidden FK column of an *optional* relation |
| `"EM"` | Editable, Mandatory, **not visible** | Hidden FK column of a *required* relation |
| `"I"` | Identity | Trait-provided columns (PK, audit timestamps). Platform-managed. |
| `""` (empty) | No flags | Rare — column exists but is invisible and not editable |

## Rules

1. **Hidden FK columns**: `"E"`, or `"EM"` when the relationship is genuinely required.
   Writeable (E), never shown (no V). `M` here is what makes the FK `NOT NULL`.
2. **Visible Reference columns**: `"VE"`, or `"VEM"` when the FK is required — **keep the
   two halves in step**. `dforge_entity_reference_add({ required })` sets both for you.
3. **Formula columns**: usually `"V"` (visible, read-only). The user never edits them.
4. **Trait columns** (PK, audit): use `"I"` (identity). These are set automatically by `traits: ["identity", "audit"]`.
5. **Don't use `I` on your own columns** — it's reserved for trait-provided and platform-managed columns.
6. **Don't mix `I` with `V` or `E`** — identity columns are not user-facing.

## Entity rights flags (different namespace — roles only)

These letters appear in role `rights` declarations, **NOT** on column flags. Don't confuse them:

| Letter | Permission | Used on |
|---|---|---|
| `S` | Select (read rows) | Entity in role `rights` |
| `I` | Insert (create rows) | Entity in role `rights` |
| `U` | Update (modify rows) | Entity in role `rights` |
| `D` | Delete (remove rows) | Entity in role `rights` |
| `C` | Clone (duplicate row) | Entity in role `rights` |
| `E` | Execute | Actions, reports, folders in role `rights` |

So `"SIUD"` on a role grants full CRUD; `"SI"` grants read + create only.

**Note**: the `I` in column flags (Identity) and the `I` in role rights (Insert) are different concepts using the same letter. Context makes them unambiguous — column flags go on entity fields, role rights go on `security/roles.json`.

## How uniqueness, PKs, and search work

These are **NOT** flag letters. They're separate properties on the column definition:

| Need | How to declare | NOT this |
|---|---|---|
| Primary key | `"isPk": true` (or use `identity` trait) | NOT a `P` flag |
| Unique column | Add a unique index in the entity's `indexes` block, or `"isUnique": true` | NOT a `U` flag |
| Searchable | Configure in data view columns or search settings | NOT an `S` flag |

## Mistakes to avoid

- Using `"U"` for unique — **not a valid flag**. Use `"isUnique": true` or indexes.
- Using `"S"` for searchable — **not a valid flag**.
- Using `"P"` for primary key — **not a valid flag**. Use `"isPk": true` or the `identity` trait.
- Declaring `M` **and** `"isNullable": true` on the same field — a contradiction that fails the pack.
- Reaching for `"VEM"` by default — `M` now means `NOT NULL`. Most business fields are `"VE"`.
- Putting `M` on a Reference whose hidden FK is optional — inert, but it misreports the field as required.
- Using `"VEM"` on trait-provided columns (PK, audit) — **don't**. Traits set their own flags (`"I"`).
- Using `"I"` on business columns — **don't**. `I` means "platform-managed"; regular business columns use `V`/`E`/`M`.
- Expecting a per-view `{ "flags": "VE" }` to make a column **optional** because it drops `M` — it doesn't. `isNullable` still inherits; write `"isNullable": true`.
- Writing `"flags": null` in a view override to inherit — fails validation. Omit the key.
- Using long names like `"Visible,Editable"` — **wrong**. Single letters concatenated: `"VE"`.
