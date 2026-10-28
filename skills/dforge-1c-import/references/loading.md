# Copying the rows

How the infobase's data gets into a dForge tenant once the modules are installed. The
general shape of a migration script is in `dforge://reference/data-migration`. This file
covers what is specific to 1C.

## Copy, don't replay

There are two routes:

- **Through the API** (`data.set`, CSV import). Every document is re-posted on the way in.
- **Straight into Postgres** with `COPY`.

Take the second for the history. Re-posting needs the posting logic ported first. Once it
is ported, its arithmetic has to match 1C's to the kopeck, or the imported balances differ
from the ones the client reconciles against. It is also slow: millions of documents
through RPC take days.

A direct copy keeps the values 1C computed and runs at disk speed. The API route stays
useful for one job: catching up the last days at cutover, while 1C is still live.

## Shape the modules so the rows fit

A copy is only mechanical if nothing has to be reshaped:

- **Use the infobase's key as the key.** Key every entity by `_IDRRef` as a `uuid`. Then no
  old-key → new-key table is needed and no reference has to be re-resolved.
- **Line tables keep 1C's composite key**, `(<owner>_id, line_no)`, as
  `_Document<N>_VT<M>` is keyed.
- **Port the reference data as well.** Mirror `Номенклатура`, `Контрагенты`, `Склады`
  rather than mapping them onto platform modules. Then a line's `product_id` is the same
  16 bytes on both sides.
- **Build the column map as the entities are generated**, not afterwards, so it cannot
  drift from the schema. The map records which `_FldNNN` feeds each target column.
  Authored entities, whose names were chosen by hand, get a map written by hand. Propose
  it by running each 1C attribute name through the same naming function and declare only
  the leftovers.
- **Read the target's physical shape from the tenant itself** (`"dForge".entity`,
  `information_schema`). Do not read it from the module files. The loader then cannot
  disagree with what the installer built.

## The conversions

Everything else is column-level and mechanical. Write each conversion once, in the loader.

| # | 1C storage | becomes | the trap |
|---|---|---|---|
| 1 | `_IDRRef binary(16)` | `uuid` | 1C stores the two 8-byte halves swapped relative to the printed GUID. In SQL: `substr(h,17)\|\|substr(h,1,16)` over the hex. Check it once by joining a line to its catalog and seeing the expected name. |
| 2 | sixteen zero bytes | `NULL` in a link | Left as-is, it is a uuid pointing at nothing, and the FK rejects the load. **In a register dimension it is a value, not an absence:** keep it as the nil uuid in a key column, because NULL ≠ NULL in a balance, a GROUP BY or a unique key. |
| 3 | `datetime` | date/timestamp minus `_YearOffset` | The offset is commonly 2000 on MS SQL, and 0 in a file infobase (`export.json` says which). The empty date `0001-01-01` lands on `2001-01-01` and becomes NULL. **On an information register's period it is a value:** "in force since the beginning". Load it as NULL and the slice (`period <= @date`) never finds the row. |
| 4 | a date 1C formatted into a string (`13.01.2016` in `nvarchar`) | `date` | No offset: nothing stored a datetime there. |
| 5 | a number in a string column | numeric | Decimal comma, nbsp or space as the thousands separator. |
| 6 | `binary(1)` flags | `bool` | `_Marked`, `_Posted`, `_Folder`. Check `_Folder`'s polarity against a known group and a known item. Do not trust the name. |
| 7 | enum reference | option code | The value is a GUID into `_Enum<N>`. `_EnumOrder` is its position in the metadata, so read the options in that order and pair by position. Generate the dropdown from the enum: hand-written option lists come out short. |
| 8 | composite reference: `_TYPE` + `_RTRef` + `_RRRef` | the key, plus a "which table" column where the port keeps one | The table number in `_RTRef` is the only thing that says what the row on the other end is. Map numbers to meanings via DBNames. |
| 9 | `ХранилищеЗначения` (`image`) | `bytea`, copied as is | It declares itself a reference. Read as one, it becomes a uuid column that can never be filled. |
| 10 | `nchar` padding | trimmed text | `_Code nchar(N)` shows trailing spaces. |
| 11 | `''` | `''` or NULL, decided once | 1C writes `''` for "no value". Every emptiness check must test both. |

### Register keys

An information register has no key in 1C. Where the infobase kept one, it is `_SimpleKey`.
For the rest, derive the key from the row: a uuid5 over the source table and the row's
values. Then a re-run lands on the same key and a reload is idempotent.

### Movement direction

1C's convention depends on the register kind:

- **Balance register.** Resources are unsigned. `_RecordKind` says which way the row went:
  0 is a receipt (+1), 1 is an expense (−1). Refuse anything else; never default it.
- **Turnover register.** Some authors kept the direction in the sign of the resource. Some
  registers carry the two sides as separate resources, so every row is additive.

Read which convention applies from the writer. Then fill the platform's direction stamp
in the loader, not through a column default. An upgrade can arrive without the default,
and every `SUM(value * direction)` silently becomes NULL.

## What goes where for registers

In 1C, posting writes movements to `_AccumRg<N>`, and `_AccumRgT<N>` caches period totals.
In dForge, a register is an `A` column on the document plus a balance entity. In line
mode the document's lines are the detail. So:

- **Copy the documents and their lines.** `_Posted` becomes the register column's state.
- **Copy the balances** from `_AccumRgT<N>`, or aggregate them from the movements. They are
  1C's numbers, and those are what the client reconciles against.
- **Do not copy line-mode movement rows.** They have nowhere to go: the lines are the detail.
- **Close every period up to cutover after the load.** Unposting an imported document
  recomputes its reversal from the lines. Where 1C's handler did more than sum the lines
  (batch write-off, distribution), that reversal would not match what 1C wrote. The close
  guard then refuses edit, unpost and delete on history.

A raw `UPDATE` of a posted flag is refused (`DF006 REGISTRY_STATE_DIRECT`). Posting state
is the engine's.

## Order and triggers

Postgres fires row triggers on `COPY`. The period lock and the posted-document guards
would reject exactly the rows a migration writes. So:

1. Load with `SET session_replication_role = 'replica'`.
2. Load in dependency order: catalogs, then documents, then lines, then balances.
3. Load self-referencing catalogs (parent hierarchies) in one pass with the constraint
   suspended. A topological sort buys nothing.
4. Re-enable the triggers, close the periods, verify.

Keep ad-hoc measurement connections in **autocommit**. A long read transaction left open in
a console holds a lock that blocks the next install's `ALTER` for as long as it stays open.

## Dangling references

1C does not enforce referential integrity. A copy arrives with references to rows deleted
years ago. Prove it on the 1C side first: it is the infobase's state, not a load bug.
There are three ways out:

- **Null the reference.** The row stops saying what it said.
- **Drop the FK.** You give up the integrity the port exists to gain.
- **Create the missing row and mark it.** Give every ported catalog a read-only
  `is_missing` flag. After a contour loads, walk the FKs and insert one flagged row per
  missing key, its text columns carrying the key so it is traceable. **Recommended:** it
  is the only option that keeps everything.

Verification then counts `WHERE NOT is_missing`.

## Verifying the load

These checks are all cheap, and all should be automated from the first contour:

- **Row counts** per source table against the target.
- **Control sums** on every resource and every money column, 1C against Postgres. This is
  the check that catches a decimal comma or a missed offset.
- **Reference integrity.** Ask `pg_constraint`, not your own metadata: count every
  single-column FK against its target, and compare every FK with the reference column's
  declared target. A check that reads the same metadata the generator wrote agrees with
  it by construction. A retargeted reference can keep its old FK for months.
- **A sample of joins** resolving to the name a 1C report shows.

Before the first load, ask the data what the specs claim: that a column is mandatory,
wide enough, unique, and holds the declared kind. Do it in one pass, not one failed
`COPY` at a time. The answers are usually the port being tidier than the business. For
example, a "mandatory" kind may be empty on 95% of rows, and a "unique" plate number
repeat after years of re-registrations.

## Upgrades leave the physical table behind

`module upgrade` can rewrite the metadata and leave the table as it was. Check this after
any upgrade that changed a column:

- a widened `varchar` still narrow;
- a retargeted reference keeping its old FK;
- a removed unique constraint still in place;
- a type change not applied.

The repair for widths is one query: join `entity_column` to `information_schema.columns`
and alter the pairs that disagree. Never narrow one that holds something longer.

## Incremental re-runs

1C's `_Version` (rowversion) gives a cheap delta. Take the high-water mark **before** the
read, so a row 1C changes during the read is picked up next time rather than lost. The
export takes it before each table and records it in `export.json`. Only a server infobase
has one. In a file infobase `_Version` is a counter per table, so a file infobase is
reloaded whole, which its size allows.
