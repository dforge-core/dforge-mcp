# Entity Traits Reference

Traits are **reusable column bundles** that entities inherit. They eliminate boilerplate — instead of declaring PK columns, timestamps, and audit tracking on every entity, you declare `traits: ["identity", "audit"]` and dForge mixes them in automatically.

Declared on an entity:

```json
{
    "description": "Contacts",
    "dbObject": "contact",
    "toString": "{first_name} {last_name}",
    "traits": ["identity", "audit"],
    "fields": {
        "first_name": { /* ... */ }
        // No need to declare contact_id, created_date, last_updated, etc.
    }
}
```

Source of truth: `server/database/system-modules/metadata/traits.json`

## All traits

### `identity`

Adds the primary key column named `{entity}_id`.

- Column: `{dbObject}_id` (e.g. `contact_id` for `dbObject: "contact"`)
- `dbDatatype: "cuid"`, `flags: "I"`, `isPk: true`, `isIdentity: true`
- Auto-generated on insert

**FK columns pointing to an `identity`-trait entity must use `dbDatatype: "cuid"`.** Do not use `bigint`, `int`, `int8`, or `integer` — `cuid` is the platform's type name even though it is physically stored as int8. Using any other value causes an `ENTITY_COLUMN_IMPORT_ERROR` type-mismatch on install.

**Most entities should use `identity`.** Exceptions: junction tables with composite PKs, extension entities that share a PK with their parent, or entities using the `period` trait (which provides its own PK).

### `audit`

Adds **two timestamp columns** (no user tracking):

- `created_date` (`timestamptz`, formula `NOW()`, auto-set on insert)
- `last_updated` (`timestamptz`, formula `NOW()`, auto-set on insert and update)

Both columns have `flags: "I"` (internal — not shown in UI by default, managed by the platform).

**Important**: `audit` does NOT add `created_by` / `updated_by` user columns. For user tracking, use `audit-full`.

### `audit-full`

**Includes everything from `audit`** (timestamps) plus adds **four user-tracking columns**:

- `created_by` (cuid, FK to user)
- `created_by_user` (Reference column, lookup to user — for UI display)
- `last_updated_by` (cuid, FK to user)
- `last_updated_by_user` (Reference column, lookup to user — for UI display)

Also adds FK constraints: `FK_{Entity}_CreatedBy` and `FK_{Entity}_LastUpdatedBy`.

Use `audit-full` when you need to know **who** created/modified a record, not just **when**. All four user columns have `flags: "I"` (internal).

**You don't need to declare both `audit` and `audit-full`** — `audit-full` inherits from `audit` automatically.

> **⚠️ `audit-full` + seed data needs handling.** `created_by` and `last_updated_by` are
> **required** (NOT NULL) cuid FKs to `user`, with **no default formula**. At runtime the platform
> fills them from the current user, but at **seed** time there is no current user, so a seeded
> `audit-full` entity fails install: *"Seed data for '&lt;entity&gt;': required column 'created_by'
> (cuid) is not present in seed records."* (The `audit` timestamps are fine — they default to
> `NOW()`.) `audit-full` is fully supported — when an entity uses it, pick one of two fixes:
>
> 1. **Don't seed that entity (preferred).** Keep `audit-full`, ship it with no seed file. This
>    matches dForge-core — none of its modules seed user-tracked columns — and suits transactional
>    entities (orders, movements) that don't need demo rows.
> 2. **Seed with the System user.** Set `"created_by": 0` and `"last_updated_by": 0` on every seed
>    record. `user_id = 0` ('System') is a real, always-present row in every tenant (inserted by the
>    `admin` dependency), so the FK resolves. Use this when you genuinely need `audit-full` **and**
>    seed data on the same entity:
>    ```json
>    { "entityCode": "purchase_order", "records": [
>        { "purchase_order_id": 1001, "order_number": "PO-2026-0001", "supplier_id": 2001,
>          "created_by": 0, "last_updated_by": 0 }
>    ] }
>    ```

### `soft-delete`

Adds a soft-delete flag:

- `active` (boolean, default `true`, formula `"true"`)

When records are "deleted," they're marked `active = false` instead of being physically removed. This preserves FK integrity and allows recovery.

### `sorting`

Adds a manual sort-order column:

- `order_num` (int4, number, `flags: "VEM"`)

Use for entities where display order matters (menu items, checklist items, FAQ entries).

### `postable`

**Marker trait — adds no columns.** Indicates the entity supports document posting (e.g. invoices that transition from draft to posted state). The actual posting state is managed by `A`-type or `L`-type columns (accumulation/ledger column types).

Use in combination with `accumulation` or `ledger` traits for accounting/registry entities.

### `accumulation`

**Marker trait — adds no columns.** Indicates the entity is an accumulation register. Configuration lives in `A`-type column params (balance entity, dimensions, resources).

Advanced feature for accounting/registry modules.

### `ledger`

**Marker trait — adds no columns.** Indicates the entity uses double-entry bookkeeping. Configuration lives in `L`-type column params (lines, movement entity, balance entity).

Advanced feature for accounting modules.

### `period`

Adds a complete period-entity template with its own PK:

- `period_key` (varchar 20, `isPk: true`, `flags: "VEM"`) — the period identifier (e.g. "2026-Q1")
- `description` (varchar 100, `flags: "VEM"`)
- `closed` (boolean, default `false`, `flags: "VEM"`) — whether the period is closed
- `start_date` (date, `flags: "VEM"`)
- `end_date` (date, `flags: "VEM"`)

**Do not combine with `identity`** — the `period` trait provides its own PK (`period_key`).

## Which traits to use

| Entity type | Recommended traits |
|---|---|
| Most business entities (contacts, orders, products) | `["identity", "audit"]` |
| Documents / approval workflows (`purchase_order`, `invoice`) | `["identity", "audit"]` by default — dForge-core seeds these with plain `audit` |
| Entities that need per-row user attribution (who created/changed it) | `["identity", "audit-full"]` — if also seeded, set `created_by`/`last_updated_by: 0` per record (or don't seed it) |
| Lookup/enum tables (read-only after seeding) | `["identity"]` (no audit needed) |
| Entities with manual ordering (menu items, steps) | `["identity", "audit", "sorting"]` |
| Soft-deletable entities (users, accounts) | `["identity", "audit", "soft-delete"]` |
| Financial documents (invoices) | `["identity", "audit", "postable"]` |
| Accounting periods (fiscal quarters) | `["period"]` (no `identity` — has its own PK) |
| Junction/bridge tables | `["identity", "audit"]` |

**Default to `audit`.** Reach for `audit-full` when the user explicitly needs to track *who* changed a row. If such an entity is **also** seeded, handle its required `created_by`/`last_updated_by` with one of the two options above (don't seed it, or set both to the System user `0`).

## Rules

1. **Always declare `traits` as a JSON array**, not a string or object.
2. **Always include `identity` unless** the entity uses `period` (own PK) or has a manually-declared PK.
3. **Default to `audit`; use `audit-full` only when the user explicitly needs per-row user attribution.** `audit` is lighter (just timestamps). `audit-full` adds four user columns, two of which (`created_by`, `last_updated_by`) are **required** with no default. If an `audit-full` entity is **seeded**, every seed record must set `created_by` and `last_updated_by` to the System user `0` — otherwise install fails on the missing columns. (Prefer not seeding `audit-full` entities at all; see the `audit-full` section.)
4. **Don't redefine trait-provided columns.** If you declare `created_date` manually alongside `traits: ["audit"]`, the installer will error.
5. **Order doesn't matter** inside the `traits` array.
6. **`postable`, `accumulation`, `ledger` are marker traits** — they don't add columns, they flag the entity for advanced accounting behaviour. Only use them if you're building accounting/registry modules and understand the `A`/`L` column types.
7. **Don't invent trait names.** Only use the 9 listed above. Check `server/database/system-modules/metadata/traits.json` if in doubt.
