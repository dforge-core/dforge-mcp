# Porting 1C print forms

The platform's side of this (manifest, context, snippets, Scriban versus LiquidJS) is in
`dforge://reference/print-templates`; queries are in `dforge://reference/queries`. This
file covers what a 1C form brings with it.

## What a 1C form is

1C prints in two steps:

1. The document's print procedure (`Печать…`, often in a shared module) computes almost
   every value. It folds lines by product and series, takes places and packs through the
   series' packaging, looks prices up at the date, totals, and assembles the
   organization's requisites into one text.
2. A spreadsheet template (макет, `MOXCEL`) is filled area by area with those values.

So the template alone is not the form. **Read the procedure first.** It holds the
requirement. The template is only the layout.

The dForge form mirrors the two steps:

| 1C | dForge |
|---|---|
| the print procedure | the template's datasets: a query, with F columns for per-line arithmetic |
| the template (макет) | an HTML template with its CSS |
| the shared printing library (requisites, contact info, amounts in words) | shared datasets and snippets, e.g. the platform's `common-words` for amounts and quantities in words |

## Reading the template

A template is the object's metadata group `{3daea016-69b7-4ed4-9453-127911372fe6, n,
guid…}`. Each template's `<guid>.txt` names it and its body is `<guid>.0.txt`. A spreadsheet
body starts `MOXCEL` and continues as a brace list:

- **Rows** with their cells. A cell is one of:
  - `{0, format}` — empty;
  - `{16, format, {1,1,{lang,text}}}` — text, or a parameter when `lang` is `""`;
  - `{20, …, {"U"}, …}` — a template string whose `[Name]` parts are parameters.
- **Column sets**, **merges** and **named areas**. An area is rows (kind 1) or columns
  (kind 2), with inclusive bounds.
- **Formats.** Each is a bit mask followed by its values, low bit first: font index (1),
  left/top/right/bottom border (2/4/8/16), height (64), width (128). The remaining bits
  (alignment, placement) can be carried by number.
- **Fonts.**

Dump each template to HTML and JSON: areas, cells, parameters, merges, widths, fonts,
borders. **Author the form from the dump; do not convert it.** 1C's layout is a grid of up
to ~50 narrow columns. A faithful HTML copy of it is unmaintainable. Keep the form's
logical columns and labels.

Which areas the procedure outputs, and in what order, is the form's real structure. Typical
areas are header, line, subtotal per group, total and signatures.

## Inventory before porting

- **List the forms per document from the print command's handler**, not from the
  templates. An object can carry dead templates. Templates the code names only for dates
  before some year print only old documents: record them and skip them.
- **Count how often each variant fires** on recent documents. A variant is a template
  chosen by a flag on the buyer or the contract, or a "per code" text. A variant used by
  278 documents since last year is worth a template. One used by none may still be worth a
  column.
- **External print processings** (`ВнешниеОбработки`) live in the infobase as stored
  binaries, not in the configuration. Inventory them separately.

## Reproduce what 1C prints, including its slips

The client compares the new printout to the old one. Where 1C's code has a defect, the
printout has the defect, and the client knows the printout. Reproduce it, and say so in
a comment at the place. Common ones:

- **A misspelt variable** makes a lookup find nothing. For example, a phone kind read from
  a misnamed variable means no phone ever prints. Print nothing.
- **A field list with spaces** (`"НомерСчета, Банк, АдресБанка"`) passed where 1C expects
  no spaces fills only the first field.
- **A test on the wrong attribute**, such as an IBAN check on the account's name instead
  of its number. Do the same test.
- **Mixed Cyrillic and Latin letters** in a literal (`с` against `c`). Copy them byte for
  byte.
- **Language codes** in `НСтр("ru = '…'; en = '…'", Lang)` are matched case-insensitively,
  so `"Ru"` finds `ru`.

If the client later asks to fix one, it is a one-line change with the comment pointing
at it.

## Formatting numbers and dates as 1C does

| 1C | output | Postgres equivalent |
|---|---|---|
| `Строка(n)`, `Формат(n)` without a format | thousands grouped by nbsp, decimal comma, no trailing zeros | `replace(replace(rtrim(rtrim(to_char(n,'FM999G999G999G990D9999999999'),'0'),'.'),',',E' '),'.',',')` (the `G`/`D` result depends on `lc_numeric`; check it) |
| `Формат(n, "ЧДЦ=2")` | always 2 decimals | `to_char(n, 'FM999G999G990D00')` then the same separators |
| `Формат(n, "ЧРД=.")` | decimal point | the replacement above with `.` |
| `Формат(n, "ЧГ=0")` | no grouping | drop `G` |
| `Формат(d, "ДФ=dd.MM.yyyy")` | `13.01.2016` | `to_char(d, 'DD.MM.YYYY')` |
| a date parameter output as is | `13.01.2016 9:05:00` (hour without a leading zero) | `to_char(d, 'DD.MM.YYYY FMHH24:MI:SS')` |

Before choosing the precision a price prints with, measure how many stored values actually
have more decimals. Do not trust the declared precision: stored prices can carry a third
decimal on most rows.

Amounts and quantities in words should come from a shared snippet (the platform's
`common-words`), not per-form code. Verify it on the client's real values against 1C's
`ЧислоПрописью` output: thousands of values, every case. Expect differences only where 1C
is ungrammatical, and agree them with the client.

## Datasets: queries, and where a query falls short

Prefer a query dataset. It runs under the user's rights and folder filters, which a stored
procedure bypasses.

- **Put per-line arithmetic into F columns on the line entity**: weight = places × place
  weight, packs, the VAT percentage through a `SWITCH`, a group section through `IN`.
- **Let the query group and sum** (`agg: group | sum`).
- **Accumulate totals in the template.** The server engine has no `where`, `sum` or
  `group_by` filters, but `plus`, `times`, `round` and `ceil` work.
- **A dataset is always an array.** Take a header row with
  `{% assign h = header | first %}`.

A query cannot (yet) express these, so the dataset stays a procedure until it can:

- a value in force at a date (`СрезПоследних`: prices, positions, codes, shelf lives);
- a filter through a reverse set or a polymorphic reference;
- string aggregation;
- a join on columns that are not a reference;
- formulas over aggregates.

1C rounds after folding (`round(price × SUM(qty))`). A query sums a per-line formula. The two
differ only where lines fold. Measure how many documents that touches, then agree it.

## Verifying a ported form

1. **Compare the dataset with the procedure's output.** Pick tens of random recent
   documents and compare every field, line by line. Zero differences is the bar. An F
   column rewritten from a procedure gets the same check.
2. **Render previews on real documents** for every variant: each language, each flag,
   with and without the optional blocks. Screenshot them against 1C's printout where one
   is available.
3. **Measure the data each block depends on.** How many recent documents have the date,
   the indicators, the shelf life? A block empty on every document is either 1C's state
   (record it) or a column read from the wrong source (fix it).

## Generating templates

When several forms share blocks (requisites, a lines table, signatures, a certificate
body), write the templates from one generator. Do not hand-copy HTML. Keep the generator
in the project, regenerate on every change, and never edit its output.

In Python, keep each formatted literal its own expression. Adjacent string literals
concatenate **before** `%` applies, which produces format errors far from the cause.
