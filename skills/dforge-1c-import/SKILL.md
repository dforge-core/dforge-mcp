---
name: dforge-1c-import
description: How to port a 1C:Enterprise 8 infobase (УТП, УПП, УТ, БП or a configuration built on them) to dForge modules — how to decide a register's kind, where a posting takes each value from, what to carry and what to drop, and how to check every one of those decisions against the data instead of guessing. Use this whenever the work involves a 1C infobase, a 1C configuration, a file infobase (1Cv8.1CD), MS SQL tables named _Reference/_Document/_AccumRg/_InfoRg/_AccRg, регистры, проведение, ОбработкаПроведения, Движения, партионный учёт, or migrating a client off 1C onto dForge — including when the user only says "the client's old system" and the tables turn out to be 1C's, and including when they ask only for a piece of it such as "which register kind should this be" or "why does this document write more rows than 1C does". Also covers copying the rows (keys, dates, enums, composite references, empty values, reconciliation) and porting 1C print forms (MXL templates, Строка/Формат, НСтр) to dForge print templates.
---

# Porting a 1C infobase to dForge

## The stance

A 1C configuration is two things that disagree: what its author **declared** and what its
documents **do**. The declaration is a proposal, often stale, sometimes never true. The
movements are the record of what actually happened, thousands of times, for years.

So the rule that makes this work tractable: **when a question can be settled by measuring
the data, measure it.** Not because the configuration lies on purpose, but because a port
that copies declarations copies the author's mistakes with them, and a port that copies
behaviour copies the business.

Two worked cases, both from a real port, both where the obvious source was wrong:

- The accounting policy register pointed at position 0 of a three-value enum and the
  configuration text would not say which value that was. The write-offs said it in five
  independent ways in under an hour.
- A register dimension declared `Строка(10)` held `13.01.2016` in 35,799 rows. The
  generator read `nvarchar` faithfully — and faithfully carried the author's mistake, a
  date that does not sort, compare, or match anything a posting would write.

The corollary matters as much: **the volume of 1C code is not the size of the port.** Most
of a posting handler is the platform's job in dForge — clearing movements, locking,
`Свернуть`, balance control, re-posting. What you port is the part that decides *which
value goes where*, and that is usually a few lines inside a handler of hundreds. Read the
code to learn the requirement; do not transcribe it. Concretely: extract only the
value-assignment and computation lines (for example, `ЗаполнитьЗначения` targets and
arithmetic expressions); do not port loop structure, locking calls, or platform
bookkeeping code.

## What the tools do, and what you decide

Generation and loading are mechanical and should stay that way: unpacking the
configuration, parsing metadata, mapping types, emitting entities, copying rows,
reconciling counts. If a port keeps needing hand edits to generated output, the generator
is wrong, not the output. This skill ships that mechanical half as a toolkit (see **The
toolkit** below), so a port starts from it rather than from nothing.

What no tool can decide:

| decision | settled by |
|---|---|
| which module an object belongs to | the business, plus the dependency graph |
| a register's **kind** | measuring the register and reading its writers |
| where a posting takes each value | where the column physically sits |
| whether to carry a link at all | who reads it |
| what a strange column type means | the data in it |

The rest of this file is those decisions. Each one has a measurement attached, because a
decision you can defend with a number survives review and a decision you argued does not.

## Read the posting handler first

Reading a handler before porting it is the cheapest move available and it repeatedly
answers in minutes what the data leaves ambiguous for days. Do it even when you do not
intend to port that handler.

What to extract, in order:

1. **Which registers it writes** (`Движения.<name>`), and for each, whether the register
   belongs to the client or to the vendor configuration. Vendor registers are usually not
  ported; client registers are the porting unit. A register written by **both** is the
  awkward case: measure what fraction of its writes are client-originated before deciding
  anything. A high fraction makes it a client register with vendor writers to account for;
  a low one usually means the register belongs to machinery you are not carrying, and the
  client's few writes into it are a question for the client rather than a port.
2. **Where each movement column is filled from.** `ЗаполнитьЗначения(X, "Col")` after
   loading a tabular section means: that column comes from the HEADER while the rest come
   from the lines. This single fact decides the binding (see below) and it is extremely
   common — in the base measured, 24 of 36 register-writing documents do it.
3. **Whether it collapses.** `Свернуть(dims, resources)` is not tidying. It means the
   document's lines can repeat a key and the register holds one row per key. Getting this
   wrong writes duplicate keys silently.
4. **What a guard protects.** `Если Стр.Количество <> 0` looks like a condition; measuring
   how often it has fired tells you how much it is worth, not whether to keep it. A guard
   that has never fired in years is a poor reason to ask the platform for a new feature —
   but it is not dead code, because future input can still reach it. Keep the condition
   where it is cheap (a column, a computed value, a validation on the target), and drop it
   only when the target genuinely cannot produce the input or the client agrees the rule
   has changed. Record which of those it was.
5. **What it computes.** `-(1 - Количество)` is arithmetic, not logic — it becomes a
   computed column, not code.

**Size does not measure effort, and using it as a proxy is the trap.** A handler's line
count is mostly vendor accounting the port does not carry: the largest in the base measured
here was 1,043 lines writing five registers, four of them the vendor's, and its only
client-owned movement was a status the port already handled. Its client-relevant part was
smaller and easier than that of handlers a tenth its size.

So scan by size once, to know which handlers you will not read end to end — but do not
defer the handler itself on that basis, because the client-owned movement buried in a big
one may be the cheapest thing available. Find the client's registers first and work
outward from them; order that work by what blocks each handler, so everything unblocked
ships while the blocked ones wait on one decision each.

### What counts as blocked

A handler is **blocked** when something it needs is not yet decided or not yet available,
and no amount of writing declarations will change that. Everything else — long, tedious,
unfamiliar — is work, not a block.

Name the category and the resolver together, because the resolver is what determines when
it moves:

| category | example | who resolves it |
|---|---|---|
| a platform feature that does not exist | a value the binding cannot reach from where it sits | the platform team |
| a modelling decision not yet made | which register kind, which dimension is missing | you, by measuring |
| a business question | which valuation method should apply going forward | the client |
| data that is absent or untrustworthy | a dimension empty across the whole register | investigation, then one of the above |

Two habits make this list useful rather than decorative.

**Keep a count against each category, and re-examine it.** A blocker recorded once tends to
stay recorded. In the port this skill comes from, the list shrank three times and every
time *away* from "we need more platform": a collapse the engine already did, a condition
that was a column rather than a feature, a register declared as the wrong kind. Expect
mislabelling in that direction — it is the expensive one, because asking for a platform
feature costs weeks and re-reading your own declaration costs an hour.

**Distinguish "blocked" from "not started".** A handler waiting on a decision is blocked; a
handler nobody has read is not. The second is much more common early, and conflating them
makes the port look stuck when it is merely young.

## Choosing a register kind

The decision most likely to be made wrong, because the obvious answer — copy the 1C family
— is wrong often enough to matter. A 1C `РегистрСведений` is not automatically dForge's
`kind: "info"`.

One fact governs everything below: **only `balance` aggregates lines by dimension tuple.**
`info` and `turnover` keep no state and the engine skips the aggregation for both. So if a
document's lines can repeat a key, `balance` is the only kind that will fold them.

Work through this flow in order. Lines repeat a key when `Свернуть` over the dimensions and
the measurements (§1) show that repeated document-line tuples become one register row.
Quantities add; values replace. A price, status, currency, or percentage share is a value;
a quantity, amount, or count is a quantity.

| Step | Question | Answer | Next step / result |
|---|---|---|---|
| 1 | Can the document's lines repeat a key? | No | Go to step 2; every kind remains available. |
| 1 | Can the document's lines repeat a key? | Yes | Go to step 2. Only `balance` can fold them, but that does not select `balance`: a writer can fold its lines and still replace a snapshot. |
| 2 | Are the resources quantities or values? | Values; lines do not repeat a key | **`info`**. Done. |
| 2 | Are the resources quantities or values? | Values; lines repeat a key | **Stop: no kind fits.** The key is incomplete: summing values is meaningless. Find the missing dimension. |
| 2 | Are the resources quantities or values? | Quantities | Go to step 3. |
| 3 | Do two documents on one key add or replace? Ask the business and the writer's intent; history (§3) only shows whether the case has occurred. | Add | Go to step 4. |
| 3 | Do two documents on one key add or replace? | Replace; lines do not repeat a key | **`info`**. Done. |
| 3 | Do two documents on one key add or replace? | Replace; lines repeat a key | **Stop: no kind fits.** Three options, none free — see the note below. |
| 4 | Is there a running total to keep? | Yes | **`balance`**. |
| 4 | Is there a running total to keep? | No; lines do not repeat a key | **`turnover`**: it keeps no total and answers only over an interval. |
| 4 | Is there a running total to keep? | No; lines repeat a key | **`balance`**: accept the running total because `turnover` would write one row per line. |

**The step 3 "replace, lines repeat" note.** Three options, and the choice belongs in the
declaration's comment along with the reason: declare `balance` and accept that it adds
across documents; collapse before posting, which nothing expresses declaratively today; or
leave it unbound and record it as blocked. Taking the first means **enforcing the
assumption** — a unique constraint over the dimensions on the state entity, so a second
writer fails loudly instead of summing. Where you cannot enforce it, say in the comment
that the semantics are "replace" and the kind is a compromise; the next reader will ask,
and the honest answer is shorter than the reconstruction.

Past uniqueness does not make adding safe: a future correction can otherwise double a
period the first time someone re-states it.

One aside that trips people: `info` with a `recorder` is the shape for a 1C register
subordinate to a регистратор. But subordination is about *who wrote the row*, not about how
rows combine — do not let it answer step 1.

### When the handler cannot be read

Extraction can come up short, the source can be missing for an object, and a heavily
customised configuration can defeat a parser that works everywhere else. None of the four
steps actually depends on the code: the code was only ever the fastest way to see the
answer, and the rows carry the same answer more slowly.

| step | without the handler |
|---|---|
| 1. lines repeat a key? | compare line counts per document against the rows the register holds for that same document — fewer rows than lines **is** the collapse |
| 2. quantities or values? | the column types and what the values do over time: a figure that repeats unchanged across documents is a value, one that varies per movement is a quantity |
| 3. add or replace? | history says only whether it has been exercised, so this one still goes to the business — the code would not have answered it either |
| 4. running total? | whether the register carries a closing or on-hand figure at all, and whether anything reads it as of a date |

Two cautions. A missing handler is worth a moment's suspicion before you route around it:
if the extraction silently dropped it, other objects are missing too, and finding that out
now is cheaper than discovering it three registers later. And when you infer rather than
read, say so in the declaration's comment — an inference that later turns out wrong is much
easier to unpick when it is labelled as one.

## Where a posting takes each value

A binding that posts from lines reads its values off the line. Any value that belongs to
the document goes in `headerMap` beside `map`:

```json
"map":       { "product_id": "product_id", "quantity": "quantity" },
"headerMap": { "dealer_id": "dealer_id", "period_id": "period_id" },
"lockedFields": ["dealer_id", "period_id"]
```

It is explicit rather than a fallback, and that is deliberate: "not on the line, try the
header" turns a typo into a silent read of an unrelated column, and a dimension that reads
as null is how a line says it does not participate — so the document would post fewer rows
than it has lines and say nothing.

Two rules that bite:

- **Every `headerMap` column must be in `lockedFields`.** The posting is keyed by it.
  Change it under a posted document and reversal looks for a tuple that was never posted
  to, leaving the old row carrying the quantity forever.
- **A resource may come from the document only on an `info` register.** Anywhere else four
  lines would add the document's amount four times.

`headerMap` gives the column **as it stands**. If the 1C handler wrote `НачалоДня(Дата)`
and the header column is a timestamp, the port needs a day-truncated computed column —
check whether the time is really there rather than assuming either way, and check whether
the document already carries a date-typed column that says the same thing.

## Whether to carry something at all

Before porting a column, a link or a mechanism, ask **who reads it**. This is a grep, and
it settles arguments that otherwise run on aesthetics.

A worked case: a register was subordinate to a регистратор, so every one of its 322,352
rows knew its document. Carrying that into dForge would have meant declaring a journal.
The grep found that the only object in the entire infobase naming that register was the
document that writes it, and the only appearance of the recorder was
`УдалитьДвиженияРегистратора` — which is unposting, which the platform does on its own. No
reader, no journal.

The same question retires whole categories. A column nothing writes and nothing reads is
worse than absent, because the next reader assumes it means something.

## Identify physical columns from metadata, never from cardinality

1C's SQL columns are `_FldNNN`. The temptation, when the metadata is awkward to parse, is
to identify them by how they behave: the dimension with 86,000 distinct values "must be"
the batch, the one with 40 "must be" the warehouse. **Do not.** The configuration keys
every attribute by GUID and `DBNames` maps that GUID to its `_FldNNN`; resolve them that
way, and use cardinality only as a sanity check on the result.

This is not a style preference. In the port this skill comes from, a cardinality guess
swapped `СерияНоменклатуры` for `ДокументОприходования` — two reference dimensions of the
same shape — and five measurements were then computed confidently against the wrong
column, published, and had to be withdrawn. The failure is silent by construction: every
query still runs, every number still looks plausible, and nothing downstream objects.

The re-measurement also found what the guess had hidden: the real batch dimension was
**empty on all 13.8 million rows**, which is a much larger fact about the client's
accounting than anything the wrong column could have said.

## What a strange column type means

1C's physical types are not the author's intent, and the port reads the physical type. Two
failure modes, both real:

- **A value parked in the wrong type.** A date in `nvarchar`, a number in a string column.
  1C coerces silently, so it looks fine in 1C and is useless afterwards. Sweep for it once
  rather than meeting it one column at a time:

```sql
-- every text column holding something shaped like a date
select '<schema>.<table>.<col>', count(*) from <schema>.<table>
where <col> ~ '^[0-9]{2}\.[0-9]{2}\.[0-9]{4}$'
```

- **An empty string that is not empty.** 1C writes `''` where a value is absent, so
  `count(column)` counts it and a column the infobase never filled reads as completely
  full. Every emptiness check against 1C-sourced data must test for `''`, not `NULL`.

When you retype a column, remember that a date the configuration formatted into a string
is **not** a 1C date value and must not get the `_YearOffset` correction — that offset is
how 1C stores a datetime, and nothing stored a datetime there.

## Vendor and client

Configurations built on a vendor's (УТП, УПП, УТ) carry far more code than the client
wrote. Separate them early — the integrator's own objects almost always carry a lowercase
prefix before a capital (`мсбЗаказ`, `рзТранспорт`), and everything else is the vendor's.
If no such convention exists or it is applied inconsistently, do not fall back to "what the
client's documents touch" — that is circular, since which documents are the client's is the
question. Compare against the vendor's stock configuration instead: an object absent from
it is the integrator's, and an object present but altered is a modification worth reading
before porting either version of it.

**That comparison is often unavailable, and saying so is part of the answer.** The client
may not hold the distribution, the version they run may not be the version you can get, and
obtaining it can require exactly the licence this approach is designed not to need. When
the stock configuration is missing or its version does not match, record the mismatch
explicitly and treat every conclusion that rests on the comparison as provisional until
something measured confirms it.

Signals that need no stock configuration, in rough order of strength: the naming
convention; whether an object holds any data at all (a stock object the client never used
is not a porting question); which objects the extracted code actually writes to; and the
language and style of the names themselves. None of these is conclusive alone, which is why
agreement between several of them is what you are looking for.

**When they disagree, treat the object as the client's until something settles it.** The
two mistakes are not symmetric: porting a vendor object you did not need costs some work
that can be dropped later, while dropping a client object loses business logic silently and
is found months on, by someone who cannot reconstruct it. An object with no prefix but real
data and real writers is exactly the case this rule exists for — and it is common, because
integrators abandon their own conventions under deadline.

Two things follow:

- **Port the client's requirements, not the vendor's metadata structure.** The stock
  configuration is the vendor's intellectual property; what it encodes about the client's
  business is what you are after.
- **Do not assume vendor machinery is unused.** Measure which of the client's own objects
  touch it. A register that looks like pure vendor plumbing may be written by twenty of
  the client's documents, and dropping it silently removes what those documents are for.

## Order of work

1. Extract and inventory: what exists, how many rows, what is the client's.
2. Generate and load the plain entities. Reconcile counts and control sums against the
   infobase before going further — a port that cannot reproduce a count cannot be trusted
  about anything harder. If counts or control sums do not reconcile, stop and diagnose the
  generator or loader before proceeding to any handler work; do not proceed with partial
  or approximate data.
3. Read the posting handlers. Triage by size, then order the work by what blocks each one.
4. Declare registers and bind documents, starting where nothing blocks.
5. Keep a running list of what blocks the rest, with a count against each. The list should
   shrink in both directions: things the platform must gain, and things that turn out to
   have been modelled wrong. Expect the second to be more common than it feels.

Keep the generated half and the project half separated by a check, not by convention. The
generic half is most of the code and lifts to the next infobase; the project half is the
judgement above, written down.

## The toolkit

Do not write the mechanical half again. `scripts/` in this skill's directory holds the
Python library that did it on a real port:

- exporting the infobase (configuration, DBNames, schema, rows) to `out/`, from MS SQL or
  from a file infobase (`1Cv8.1CD`). Every later step reads the export, never 1C;
- parsing the metadata;
- inventorying registers and handlers;
- generating and validating modules;
- copying rows with every conversion in the loader;
- reconciling counts, sums and foreign keys;
- posting checks;
- reading MXL print templates.

`scripts/README.md` gives the setup and the pipeline step by step.

Start a port by copying `scripts/project-template/` into the port's own directory. Set
`DF1C_ROOT` and `DF1C_PROJECT`, then run `python <skill>/scripts/1c.py --list`. Everything
this infobase needs goes into the project package, never into `lib/`; `1c.py --boundary`
checks that. When a tool gets something wrong for a new infobase, fix the library and keep
the fix general. A second infobase is what turns a port's tooling into a library.

## References

- `references/measurements.md` — the queries behind each decision, ready to adapt
- `references/loading.md` — copying the rows: the conversions (keys, empty values, the
  year offset, enums, composite references), register state, triggers, dangling
  references, verification, incremental re-runs
- `references/print-forms.md` — porting 1C print forms: reading MXL templates, what the
  print procedure decides, reproducing 1C's formatting and its slips, datasets as
  queries, verifying a form
- `references/environment.md` — the environment traps that cost time repeatedly (Windows
  bash, Cyrillic in shell commands, 1C physical naming, the year offset)
- Platform side, from the dForge MCP server: `dforge://reference/registers`,
  `dforge://reference/data-migration`, `dforge://reference/print-templates`,
  `dforge://reference/queries`
