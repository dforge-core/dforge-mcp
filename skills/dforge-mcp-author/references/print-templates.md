# Print Templates Reference

dForge ships Liquid-based print templates. A record + its child sets are rendered to HTML, which the browser prints or saves as PDF.

Lives in: `ui/print_templates.json` + HTML/CSS files under `print_templates/`. Schema: [`docs/schemas/print_templates.schema.json`](../../../docs/schemas/print_templates.schema.json). Full guide: [`docs/ui/print-templates.md`](../../../docs/ui/print-templates.md). QR + snippets: [`docs/ui/print-qr-codes.md`](../../../docs/ui/print-qr-codes.md).

## Two render paths

| Path        | Engine          | Used by                                                  |
| ----------- | --------------- | -------------------------------------------------------- |
| **Server**  | Scriban (Liquid) | `print.render` RPC — final print / save-as-PDF           |
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
| `{{ <set_name> }}`      | Child set — array. Iterate with `{% for x in <set_name> %}`. Only loaded if the template iterates it.   |
| `{{ _css }}`            | The CSS string attached to the template (rarely needed in template body)                                |

Inside a child-set loop, the same shape applies per row: `line._fmt.<col>`, `line._raw.<col>`, `line._color.<col>`.

## Custom filters

| Filter                                          | Example                                                | Output                       |
| ----------------------------------------------- | ------------------------------------------------------ | ---------------------------- |
| `format_currency: <currency>, <digits?>`        | `{{ amount | format_currency: 'USD' }}`                | `"$1,234.56"` (en-US)        |
| `format_number: <decimals?>`                    | `{{ rate | format_number: 4 }}`                        | `"0.0125"`                   |
| `format_date: <strftime>`                       | `{{ invoice_date | format_date: '%B %d, %Y' }}`        | `"May 22, 2026"`             |
| `qr_code: <size?>, <ecc?>, <margin?>, <format?>`| `{{ payment_url | qr_code: 200, 'M' }}`                | `data:image/png;base64,…`    |

`format_date` supports strftime: `%Y %m %d %B %b %H %M %S %I %p %A %a %e`.

## Snippets

Module-scoped Liquid partials. Pull one in via `{% include 'module_cd.snippet_cd' %}`. Snippets see all variables from the host template by default; pass overrides with `with`:

```liquid
{% include 'fin-sepa.epc_qr_block' %}
{% include 'fin-sepa.epc_qr_block' with currency: 'EUR' %}
```

Declare a snippet with `"type": "snippet"`. No `entityCd`. The `template_cd` must not contain `.` (collides with the `module_cd.snippet_cd` separator).

Full mechanics + an EPC SEPA QR worked example: [`docs/ui/print-qr-codes.md`](../../../docs/ui/print-qr-codes.md).

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
- **Referencing a child set outside a `{% for %}`.** The platform only loads sets that appear in a `for` loop. `{{ lines.size }}` won't trigger the load.
- **Snippet `template_cd` with a dot.** `{% include 'my_module.foo.bar' %}` — the resolver splits on the last dot only, so `my_module.foo` becomes the module name and breaks. No dots in snippet codes.
- **Dropping CSS in `<style>` blocks inline.** The renderer wires `<style>` for you; declare CSS in the separate `.css` file (or inline string via the `css` field).
- **Trying to use `TODAY()` / `NOW()` in a formula column expecting it to render in print.** The print-time formula evaluator skips those. Pre-compute via a formula column at insert time, or use `{{ _today | format_date: '...' }}` directly in Liquid.
- **Module-installed template renamed in editor.** The editor preserves the original `template_cd` so `{% include %}` references stay intact — don't try to work around it.

Module-installed print-template rows can't be deleted from the editor — uninstall the owning module to remove them.

## Reference

- Full developer guide: [`docs/ui/print-templates.md`](../../../docs/ui/print-templates.md)
- QR codes + snippets guide: [`docs/ui/print-qr-codes.md`](../../../docs/ui/print-qr-codes.md)
- JSON Schema: [`docs/schemas/print_templates.schema.json`](../../../docs/schemas/print_templates.schema.json)
- Reference modules: [`modules/fin/`](../../../modules/fin/), [`modules/fin-ch/`](../../../modules/fin-ch/) (Swiss QR-bill), [`modules/crm/`](../../../modules/crm/), [`modules/wms/`](../../../modules/wms/), [`modules/hr/`](../../../modules/hr/)
- Source: `server/src/dForge.Api/Services/PrintTemplateService.cs`, `server/src/dForge.Admin/Services/ModuleInstall/PrintTemplateRegistrar.cs`
