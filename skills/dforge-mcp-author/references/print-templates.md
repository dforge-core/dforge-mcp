# Print Templates Reference

dForge ships Liquid-based print templates. A record + its child sets are rendered to HTML, which the browser prints or saves as PDF.

Lives in: `ui/print_templates.json` + HTML/CSS files under `print_templates/`. Schema: [`docs/schemas/print_templates.schema.json`](../../../docs/schemas/print_templates.schema.json). Full guide: [`docs/ui/print-templates.md`](../../../docs/ui/print-templates.md). QR + snippets: [`docs/ui/print-qr-codes.md`](../../../docs/ui/print-qr-codes.md).

## Two render paths

| Path        | Engine          | Used by                                                  |
| ----------- | --------------- | -------------------------------------------------------- |
| **Server**  | Scriban (Liquid) | `print.render` RPC; `print.renderPdf` (Generate PDF, headless Chromium); `printPdf()` in a DSL action |
| **Client**  | LiquidJS         | Editor preview — fast iteration                          |

Filters are mirrored on both sides so the preview matches the print.

## Manifest structure

```json
{
    "invoice": {
        "entityCd": "invoice",
        "description": "Invoice Print Form",
        "file": "invoice.html",
        "css": "invoice.css",
        "pageSettings": {
            "size": "A4",
            "orientation": "portrait",
            "margins": { "top": "15mm", "right": "15mm", "bottom": "15mm", "left": "15mm" }
        }
    },
    "footer": {
        "type": "snippet",
        "description": "Shared invoice footer block",
        "file": "footer.html"
    }
}
```

The key (`"invoice"`, `"footer"`) becomes `template_cd` on the row.

## Field reference

| Field          | Required        | Notes                                                                                                                              |
| -------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `type`         | No              | `"template"` (default) or `"snippet"`.                                                                                              |
| `entityCd`     | Yes (templates) | Entity code. Cross-module form `"module.entity"` supported (bridge modules). Must be omitted on snippets.                          |
| `description`  | No              | Label shown in the print menu.                                                                                                     |
| `template`     | One of these    | Inline Liquid HTML.                                                                                                                |
| `file`         | One of these    | Path relative to `print_templates/`.                                                                                               |
| `css`          | No              | Inline CSS or a `.css` filename under `print_templates/`. Snippets typically inherit and omit.                                     |
| `pageSettings` | No              | `{ size, orientation, margins }`. `size` ∈ `A4` / `letter` / `legal`. `orientation` ∈ `portrait` / `landscape`. Margins are CSS lengths. |

## Template context (what you can read in Liquid)

Every column on the entity is a top-level variable. Display formatting is pre-applied for dropdown / radio / flags / user columns.

| Variable                | What it holds                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------ |
| `{{ <column> }}`        | Display value: dropdown labels resolved, user names resolved, refs resolved to their display column     |
| `{{ _fmt.<column> }}`   | Locale-aware **string**: `currency` → `"$1,234.56"`, `date` → `"5/22/2026"`, `bool` → `"Yes"`/`"No"`    |
| `{{ _raw.<column> }}`   | Original code / id (use for CSS classes, predicates, wire-format payloads)                              |
| `{{ _color.<column> }}` | Option color hex for single-value dropdown/radio columns                                                |
| `{{ _settings.<cd> }}`  | Folder-resolved module setting. Image/file settings come as base64 data URIs (drop into `<img src>`).   |
| `{{ _today }}`          | Typed `DateTimeOffset` (UTC); `{{ _fmt._today }}` is the pre-formatted string                          |
| `{{ <set_name> }}`      | Child set — array, in primary-key order. Loaded wherever the template's Liquid code names it (see below) |
| `{{ _css }}`            | The CSS string attached to the template (rarely needed in template body)                                |

Inside a child-set loop, the same shape applies per row: `line._fmt.<col>`, `line._raw.<col>`, `line._color.<col>`.

A loop over a document's set can read a set of the line's own entity off each line (`{% for l in lines %}{% for a in l.attributes %}`): detected by the template reading it, loaded for every line in one query under the same rights and row filter, one level deep. The editor preview does not fill it.

A printed set, nested or not, needs **Select** on its entity in the folder, as `data.get` does; one the user cannot read prints empty. `print.render` and `print.renderPdf` check Select on the printed entity.

A currency column prints its glyph for the common codes (`EUR` → `€`, `USD` → `$`, `GBP` → `£`, `UAH` → `₴`, `PLN` → `zł`); other codes print as the code. `format_currency` follows the same mapping.

Formula columns (`F`) are read in the same SQL as the record, as `data.get` does, so a formula that navigates references prints what the grid shows, and `TODAY()` / `NOW()` work. A formula uses the built-in formula functions only: it cannot call a module's SQL function. A formula the SQL translator cannot express prints empty and the response carries a warning naming the column.

**Sets: loading and order.** A set is loaded when the template's Liquid code (`{% … %}` or `{{ … }}`) mentions its name anywhere: a `for`, a filter, a condition, `.size`, `.first`. Plain text, `{% comment %}` / `{% raw %}` blocks, string literals and the member of a path (`rec.lines`) do not count, and a snippet's code is not scanned (mention the set in the host template). Rows come in primary-key order; sort in the template:

```liquid
{% assign sorted = doc_lines | sort: 'doc_date' %}            {# ascending #}
{% assign sorted = doc_lines | sort: 'doc_date' | reverse %}  {# descending #}
{% assign s = doc_lines | sort: 'doc_num' | sort: 'doc_date' %} {# date, then number: sort is stable, last key first #}
```

`sort` takes a column code and sorts the value as the template sees it (a dropdown or reference sorts by its label). Text order follows the engine, not the database collation. `{# … #}` after an expression in examples is a note for the reader, not syntax: write a real comment as `{% comment %} … {% endcomment %}`.

## Computed values and grouped rows

| The form needs | Do |
| --- | --- |
| A value of the record or of a record it references (the organization's requisites as one block) | An `F` column on the entity: references and built-in functions |
| A value per line (places, weight through the product's units) | An `F` column on the line entity, printed as `line.<col>` |
| One total over a set | Over a stored line column (`D`, or a `G` on the line): a `G` column on the document (`SUM([lines].[amount])`). Over a line `F` column: a `plus` accumulator in the loop, `{% assign s = 0 %}{% for l in lines %}{% assign s = s \| plus: l.places %}{% endfor %}`, since a `G` cannot sum an `F` child (install fails with `column old.<field> does not exist`) |
| Lines grouped by a column, totals per group (by product and series, by VAT rate, a packing list by pallet) | **Not available in the print context yet.** It prints the record and its sets as stored |

For the last row, do not work around it:

- **Not in Liquid filters.** `where`, `sum`, `group_by` and `where_exp` run in the LiquidJS preview, but Scriban (the print) fails with "The function `where` was not found". Filter and total with `{% if %}` and `plus` inside a `for`, which both engines run.
- **Not a print table filled by an action.** It stores a copy of the document that drifts from it.
- **Not a stored procedure.** The grouping itself is a grouped query (`references/queries.md`): `group` on the column, `sum` over a line `F` column.

## Custom filters

| Filter                                          | Example                                                | Output                       |
| ----------------------------------------------- | ------------------------------------------------------ | ---------------------------- |
| `format_currency: <currency>, <digits?>`        | `{{ amount | format_currency: 'USD' }}`                | `"$1,234.56"` (en-US)        |
| `format_number: <decimals?>`                    | `{{ rate | format_number: 4 }}`                        | `"0.0125"`                   |
| `format_date: <strftime>`                       | `{{ invoice_date | format_date: '%B %d, %Y' }}`        | `"May 22, 2026"`             |
| `qr_code: <size?>, <ecc?>, <margin?>, <format?>`| `{{ payment_url | qr_code: 200, 'M' }}`                | `data:image/png;base64,…`    |

`format_date` supports strftime: `%Y %m %d %B %b %H %M %S %I %p %A %a %e`. `%B` / `%b` / `%A` / `%a` print **English** names whatever the user's language; for a month in another language keep a small snippet that maps `%m` to the name. `format_date` returns a **string**: arithmetic on its result fails ("Operator - not supported on string"), so compute on the raw value and format last.

**Time zones.** A timestamp in `_fmt` and `format_date` on an instant render in the column's `params.timeZone`, else the request's zone (before platform 2026-10-25, always UTC). A bare date or a timestamp without a zone prints as written.

## Snippets

Module-scoped Liquid partials. Pull one in via `{% include 'module_cd.snippet_cd' %}`. Snippets see all variables from the host template by default; pass overrides with `with`:

```liquid
{% include 'fin-sepa.epc_qr_block' %}
{% include 'fin-sepa.epc_qr_block' with currency: 'EUR' %}
```

Declare a snippet with `"type": "snippet"`. No `entityCd`. The `template_cd` must not contain `.` (collides with the `module_cd.snippet_cd` separator).

Full mechanics + an EPC SEPA QR worked example: [`docs/ui/print-qr-codes.md`](../../../docs/ui/print-qr-codes.md).

### Amount in words

The platform has no number-to-words filter. The `common-words` module (`modules/common-words`, a dependency to declare) ships snippets that write an amount or a plain quantity out in Ukrainian, Russian, English or German. Set the inputs, then include:

```liquid
{% assign words_amount = total %}
{% assign words_currency = currency_cd %}
{% assign words_lang = 'de' %}
{% include 'common-words.money' %}
```

1234.56 EUR prints «eintausendzweihundertvierunddreißig Euro 56 Cent». `words_amount` must be a numeric field, not text. `words_currency` is an ISO 4217 code in any case; an unlisted currency prints its code. `words_lang` is `uk` (default), `ru`, `en` or `de`; an unknown code prints `[common-words: unknown language xx]`. `words_cap = true` capitalises the first letter. `common-words.money` only picks the language; `money_uk` / `money_ru` / `money_en` / `money_de` can be included directly, and `common-words.quantity` writes a count of things («двадцять одна штука», «twenty-one pieces»): `words_number` (numeric, a fraction rounds half up), optional `words_unit` (forms joined by `|`: three for Ukrainian and Russian, two for English and German) and `words_gender` (`m` / `f` / `n`), plus `words_lang` and `words_cap` as above; `quantity_uk` / `quantity_ru` can be included directly too. The text lives in the module, so a fix or a new currency is a module update; a new language is a new `money_xx.html` plus a line in `money.html`.

`quantity_uk` and `quantity_ru` also write a fraction in words. With `words_minor` + `words_minor_digits` (1–6) the fraction gets its own unit, as 1C's ЧислоПрописью does for a weight: «одна тысяча двести пятьдесят кг. пятьсот г.» (a zero fraction prints «ноль г.»). With `words_decimal = true` the number is a decimal fraction up to three digits, trailing zeros dropped: «двадцять одна ціла дванадцять сотих тонни». The unit comes in the 2–4 form, or as `words_unit_fraction` ('кілограма' for a Ukrainian masculine unit). The grammar is correct where 1C's is not: 1.001 is «одна ціла одна тисячна». English and German take neither input.

Snippets run on Scriban (print) and LiquidJS (preview), so write them for both:

- No `floor` on big numbers: Scriban's goes through a double and rounds them up.
- No `modulo: 1` on a fraction without snapping the whole part with `round`. LiquidJS 10.30 leaves float noise: `0.44 | modulo: 1` is 0.43999999999999995.
- Round a fraction half up on its decimal digits, read from the number's text (`append: ''`; the server may print a comma; a browser double under 1e-6 prints as `5e-7`), never by `times` / `plus: 0.5` / `floor`. A double's text is the shortest decimal it stands for, so this matches the server's decimals both on a tie (960.015 → 02) and just below one (1000000000.0049999 → 00). No epsilon can do both.
- No number taken from `split` / `slice`. A digit is read as `'x0123456789' | split: ch | first | size | minus: 1`.
- Plain `{% comment %}` without trim dashes.

## Module package layout

```
my_module/
├── manifest.json
├── ui/
│   └── print_templates.json
└── print_templates/
    ├── invoice.html
    ├── invoice.css
    └── footer.html       (snippet)
```

## Example template

```liquid
<div class="invoice-header">
  {% if _settings.company_logo %}
    <img class="company-logo" src="{{ _settings.company_logo }}" />
  {% endif %}
  <h1>INVOICE {{ invoice_number }}</h1>
  <p>Date: {{ _fmt.invoice_date }} · Due: {{ _fmt.due_date }}</p>
  <p>Status: <span class="badge" style="--c: {{ _color.status }}">{{ status }}</span></p>
</div>

<table>
  {% for line in lines %}
    <tr>
      <td>{{ line.description }}</td>
      <td>{{ line.quantity }}</td>
      <td>{{ line._fmt.unit_price }}</td>
      <td>{{ line._fmt.line_total }}</td>
    </tr>
  {% endfor %}
</table>

<p>Total: <strong>{{ _fmt.total_amount }}</strong></p>

{% if amount_paid > 0 %}
  <p>Paid: -{{ _fmt.amount_paid }}</p>
  <p>Due: {{ _fmt.amount_due }}</p>
{% endif %}

{% include 'fin.footer' %}
```

## Common mistakes

- **Using `_fmt` in a predicate.** `{% if _fmt.amount_paid > 0 %}` compares strings. Use the bare reference: `{% if amount_paid > 0 %}`.
- **Forgetting `_raw` for codes.** Direct `{{ status }}` is the label (`"Partially Paid"`). For CSS classes / wire-format payloads / predicates against codes, use `{{ _raw.status }}` (`"P"`).
- **Manually formatting dates/currency.** Don't reach for `format_currency` when the column is already `fieldTypeCd: "currency"` — `_fmt.<col>` already matches the form. Use the filter only for derived values.
- **Expecting a set to load only from a `for`.** It loads wherever the template names it (`sort`, `.size`, `.first`). A set read only inside a snippet is not seen: mention it in the host template.
- **Testing emptiness with `blank` / `empty`.** LiquidJS (preview) knows them, Scriban (print) does not: on the server `x == blank` is false for nil and `''`, and true for a date. Use `{% unless x %}`, `{% if x and x != '' %}` or `x != nil`.
- **Joining text across an empty reference.** A formula that glues several navigated parts (`[frp].[employee].[full_name]`) yields stray spaces when a hop is empty; `| strip` the result. Every role that prints needs Select on each entity of the path, or the value prints empty with a warning.
- **Dashed comment tags.** The server cuts every `{%- comment -%}` block before parsing, but keep snippets to plain `{% comment %}` so both engines agree.
- **Snippet `template_cd` with a dot.** `{% include 'my_module.foo.bar' %}` — the resolver splits on the last dot only, so `my_module.foo` becomes the module name and breaks. No dots in snippet codes.
- **Dropping CSS in `<style>` blocks inline.** The renderer wires `<style>` for you; declare CSS in the separate `.css` file (or inline string via the `css` field).
- **Printing an unsorted set.** Rows come in primary-key order; use `| sort: 'col'` (and `| reverse`) in the template.
- **Writing an amount in words by hand.** Include `common-words.money` instead of a custom filter or lookup table.
- **Module-installed template renamed in editor.** The editor preserves the original `template_cd` so `{% include %}` references stay intact — don't try to work around it.

Module-installed print-template rows can't be deleted from the editor — uninstall the owning module to remove them.

## Reference

- Full developer guide: [`docs/ui/print-templates.md`](../../../docs/ui/print-templates.md)
- QR codes + snippets guide: [`docs/ui/print-qr-codes.md`](../../../docs/ui/print-qr-codes.md)
- JSON Schema: [`docs/schemas/print_templates.schema.json`](../../../docs/schemas/print_templates.schema.json)
- Amount in words: [`modules/common-words/`](../../../modules/common-words/) (README lists the inputs)
- Reference modules: [`modules/fin/`](../../../modules/fin/), [`modules/fin-ch/`](../../../modules/fin-ch/) (Swiss QR-bill), [`modules/crm/`](../../../modules/crm/), [`modules/wms/`](../../../modules/wms/), [`modules/hr/`](../../../modules/hr/)
- Source: `server/src/dForge.Api/Services/PrintTemplateService.cs`, `server/src/dForge.Admin/Services/ModuleInstall/PrintTemplateRegistrar.cs`
