# The measurements

Each decision in SKILL.md has a query that settles it. They are written against a loaded
dForge tenant (Postgres) because that is where both sides are comparable — the 1C rows and
what the platform writes. Where the question can only be asked of the infobase, the query
is against the export (DuckDB over `out/data/`, via `store.connect()`) and says so.

Adapt names; the shapes are the point.

## Contents

1. Does this register need a collapse?
2. Which kind is it?
3. Would accumulation ever accumulate?
4. Did the collapse actually happen?
5. Is a guard in the handler alive?
6. Does anything read this?
7. Is a column's type a lie?
8. Is a text column really full?
9. Which costing method does the base use?

---

## 1. Does this register need a collapse?

The handler's `Свернуть` is the signal; these two confirm it and size it.

```sql
-- how often the lines of one document repeat a dimension
select repeats, count(*) as documents from (
  select <doc_fk>, count(*) - count(distinct <dim>) as repeats
  from <line_table> group by 1) x
group by 1 order by 1 limit 10;

-- lines in, rows 1C actually wrote out, for the same documents
select sum(lines) as lines, sum(rows_1c) as rows_1c from (
  select d.<pk> id,
    (select count(*) from <line_table> l where l.<doc_fk> = d.<pk>) as lines,
    (select count(*) from <register> r where r.recorder = d.<pk>) as rows_1c
  from <documents> d) y;
```

`lines > rows_1c` means the collapse is load-bearing.

## 2. Which kind is it?

```sql
select count(*) as rows,
       count(distinct (<dims>)) as distinct_keys,
       count(distinct recorder) as writing_documents
from <register>;
```

`rows = distinct_keys` means one row per key — a table of records, not a journal. Combine
with question 1: one row per key *and* repeating lines means the writer collapses, which
is `balance` in dForge regardless of the 1C family.

## 3. Would accumulation ever accumulate?

```sql
select docs_per_key, count(*) as keys from (
  select <key columns>, count(*) as docs_per_key
  from <documents>
  where coalesce(deletion_mark, false) = false
  group by <key columns>) z
group by 1 order by 1;
```

One output row showing `1` retires the objection that `balance` would add two openings
together. Record the number in the declaration; it is the answer to the question the next
reader will ask.

## 4. Did the collapse actually happen?

Two traps here, and they pull in opposite directions.

Resource **totals** match whether the engine collapsed or not, because a sum is a sum. So
totals alone cannot show a collapse. But row counts alone cannot either: against a
register that already holds the migrated rows, a posting that did **nothing** adds no rows
and creates no duplicate keys — and so passes a check built only on counts. A posting that
updated the *wrong* existing key passes it too.

What settles it is the expected delta **per full dimension tuple**, checked in both
directions. Compute what the lines say each tuple should move, before posting:

```sql
-- expected, read through the binding's own map and headerMap
select <dims>, sum(<resource>) as expected
from <line_table> l join <documents> d on d.<pk> = l.<doc_fk>
where d.<pk> = '<doc>'
group by <dims>;
```

Then post, and compare per tuple rather than in aggregate:

```sql
select r.<dims>, r.<resource> - b.<resource> as moved
from <register> r join <baseline snapshot> b using (<dims>);
```

Three things must hold together, and any one alone is weak:

1. every expected tuple moved by exactly its expected amount;
2. no tuple outside the expected set moved at all;
3. after unposting, every tuple is back at the baseline.

Point 2 is what catches an update to the wrong key; point 3 is what catches a posting that
silently did nothing, because a no-op also unposts to nothing and the baseline never
moved. Snapshot the register's rows for the affected tuples before posting so the
comparison has something to be against.

And separately, since it is cheap:

```sql
select count(*) as keys_with_two_rows from (
  select 1 from <register> group by <dims> having count(*) > 1) x;
```

## 5. Is a guard in the handler alive?

`Если Стр.Количество <> 0` guards a loop. Has it ever fired?

```sql
select count(*) as lines,
       count(*) filter (where <col> = 0)  as would_be_skipped,
       count(*) filter (where <col> <> 0) as actually_written
from <line_table>;
```

Zero skipped over years of data means the guard is dead code. Porting it as a platform
feature would be paying for nothing.

## 6. Does anything read this?

A grep over the extracted configuration modules, not a query. Count the objects naming the
register, split by whether the object is the client's own (lowercase prefix before a
capital) or the vendor's, and look at what appears near each mention. If the only mentions
are the writing document and `УдалитьДвиженияРегистратора`, nothing reads it.

Do this before carrying a journal, a recorder link, or any mechanism that exists to
support a reader.

## 7. Is a column's type a lie?

Sweep every text column at once rather than meeting them one at a time. Build the union
from `information_schema.columns` in the module schemas, then:

```sql
select '<schema>.<table>.<col>' as col, count(*) as n
from "<schema>"."<table>"
where "<col>" ~ '^[0-9]{2}\.[0-9]{2}\.[0-9]{4}( |$)'
```

A hit is a date the 1C author declared as a string. Expect very few — in the base measured,
one column out of 611 — which is what makes the sweep worth running once and never
worrying again.

## 8. Is a text column really full?

```sql
select count(*) as rows,
       count(*) filter (where <col> is null)  as nulls,
       count(*) filter (where <col> = '')     as empty_strings,
       count(*) filter (where coalesce(<col>, '') <> '') as actually_filled
from <table>;
```

`nulls = 0` while `actually_filled = 0` is the signature of a column read from a field the
infobase never writes. It is invisible to `count(column)`.

## 9. Which costing method does the base use?

The accounting policy register will name an enum position and the configuration text may
not resolve it. The movements answer it several ways, and agreement across them is the
point — any one alone can mislead.

```sql
-- A. batches touched by one write-off. Average costing writes off proportionally across
--    every batch in stock, so a heavy concentration at 1 rules it out.
select batches, count(*) as expenses from (
  select _RecorderRRef, <item>, <warehouse>, count(distinct <batch>) as batches
  from <batch_register>
  where _RecordKind = 1 and _Period >= ? and _Period < ?
  group by 1,2,3) x
group by 1 order by 1;

-- B. distinct unit costs per item and warehouse within one month.
--    A period-weighted average gives exactly one.
select prices, count(*) from (
  select <item>, <warehouse>,
         count(distinct round(<amount> / nullif(<qty>, 0), 4)) as prices
  from <batch_register>
  where _RecordKind = 1 and _Period >= ? and _Period < ? and <qty> <> 0
  group by 1,2) y
group by 1 order by 1;

-- C. was there a choice at all? (validity check: zero-stock cases mean the
--    balance arithmetic is wrong and nothing below can be believed)
--    then, among those with a choice, was the oldest batch in stock taken?
--    FIFO takes the oldest; LIFO the newest; neither dominating means no rule
--    is followed and the batch is effectively identified rather than queued.
```

Read C carefully: "the oldest batch ever received" is a different question from "the oldest
batch that still had stock at that moment", and only the second is FIFO. The first gives a
muddle and will mislead you.

Whatever the answer, it changes the question put to the client rather than replacing it:
not *"which method do you use"* — the base answers that — but *"is that what you meant, and
should it stay that way"*. A rule nobody enforces may be accepted practice or an accident.
