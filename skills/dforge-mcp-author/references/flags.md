# Column Flags Reference

Column flags are single-letter codes concatenated into a string. Order doesn't matter — `"VEM"` and `"EMV"` are equivalent.

Valid flags regex: `^[VIEMH]*$`

## Flag letters

| Letter | Name | Meaning |
|---|---|---|
| `V` | Visible | Column appears in grid / form / card views. Omit to hide from standard UI. |
| `I` | Internal | Auto-managed by the platform. Used on PK columns, audit timestamps, system fields. Not shown in UI, not directly editable by users. |
| `E` | Editable | User can modify the value in the UI. Omit for read-only. |
| `M` | Mandatory | Required. Resolved into `isNullable: false` at install — see below. |
| `H` | Hidden | Permanently hidden — never shown, not even in admin metadata views. Stronger than omitting `V`. |

**Only these 5 letters are valid.** The platform rejects any other characters.

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
  meaningless where there is no physical column. It won't fail, but `VEM` on a
  Reference over an *optional* FK reads as a required field to the next author, which
  is exactly how these get out of step. Match the Reference to its FK.
- **Adding `M` to a shipped field aborts the upgrade** on any tenant whose existing
  rows leave it empty — rolled back, naming the column and its NULL row count. Give
  the column a `params.serverDefault` if the install should backfill it. Removing `M`
  is always safe.

Omitting both `M` and `isNullable` leaves the column nullable — that is the default.

## Common column flag combinations

| Flags | Meaning | Use case |
|---|---|---|
| `"VEM"` | Visible, Editable, Mandatory | Required field shown in UI |
| `"VE"` | Visible, Editable, optional | Nullable field — the common case for most business fields |
| `"V"` | Visible, read-only | Display-only, like formula columns or computed values |
| `"E"` | Editable, **not visible** | Hidden FK column of an *optional* relation |
| `"EM"` | Editable, Mandatory, **not visible** | Hidden FK column of a *required* relation |
| `"I"` | Internal | Trait-provided columns (PK, audit timestamps). Platform-managed. |
| `""` (empty) | No flags | Rare — column exists but is invisible and not editable |

## Rules

1. **Hidden FK columns**: `"E"`, or `"EM"` when the relationship is genuinely required.
   Writeable (E), never shown (no V). `M` here is what makes the FK `NOT NULL`.
2. **Visible Reference columns**: `"VE"`, or `"VEM"` when the FK is required — **keep the
   two halves in step**. `dforge_entity_reference_add({ required })` sets both for you.
3. **Formula columns**: usually `"V"` (visible, read-only). The user never edits them.
4. **Trait columns** (PK, audit): use `"I"` (internal). These are set automatically by `traits: ["identity", "audit"]`.
5. **Don't use `I` on your own columns** — it's reserved for trait-provided and platform-managed columns.
6. **Don't mix `I` with `V` or `E`** — internal columns are not user-facing.

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

**Note**: the `I` in column flags (Internal) and the `I` in role rights (Insert) are different concepts using the same letter. Context makes them unambiguous — column flags go on entity fields, role rights go on `security/roles.json`.

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
- Using long names like `"Visible,Editable"` — **wrong**. Single letters concatenated: `"VE"`.
