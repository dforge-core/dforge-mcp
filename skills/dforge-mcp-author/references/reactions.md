# Field-Change Reactions Reference

A reaction suggests a **stored, editable** value the moment the user edits another field — 1C's `ПриИзменении`. Pick a product on an order line and its unit, VAT rate and price are filled; the user may still change the price.

## Reaction, or something else?

| Need | Use |
|---|---|
| A value shown, never edited, never stored | `F` column |
| A value the database computes and keeps | `G` column |
| A value set once, when the record is created | a default |
| A value that must hold however the record is written | an `async: false` trigger |
| A value suggested while the user edits | **a reaction** |

A reaction is an input aid, not an invariant. It runs in the UI only: a form, an editable grid, and bulk update (per selected record). A write over the API, an import or a DSL `update()` runs none. Never on load, never on a value the server returns after save.

## Declaring one

`reactions` sits in the entity file beside `fields`. One rule — "when X changes" — may set several columns.

```jsonc
"reactions": [
	{
		"code": "product_defaults",
		"on": ["product_id"],
		"set": {
			"unit_id": "[product_id].[unit_id]",
			"vat_rate": "[product_id].[vat_rate]",
			"description": { "formula": "[product_id].[name]", "ifEmpty": true }
		}
	},
	{
		"code": "price_from_list",
		"on": ["product_id", "price_date"],
		"call": "priceOn",
		"set": ["price"]
	}
]
```

- `code` names the rule and is unique within the entity. It may not contain `.`.
- `on` lists the columns whose **edit** fires the rule: stored or reference columns, not computed ones.
- A **formula rule** has `set` as `{ column: formula }`. The formula uses the `F`-column syntax, one-hop `[ref].[column]` reads included. It runs in the browser.
- A **server rule** has `call` (a top-level function in `logic/functions/*.dsl`, or an imported `namespace.fn`) and `set` as the list of columns the function may write.
- `ifEmpty: true` on a target fills it only when it is empty. The default is to overwrite whenever a source changes.
- Set a reference through its **FK column** (`customer_id`); the visible reference follows.
- A target is a stored, writable column: not the primary key, a reference column, `F`, `G`, `S`, or an `A` / `L` register state. Pack and install refuse it, and check every column, formula and function.

## How a chain runs

- A rule's `set` may fire further rules. Within one edit each rule runs **at most once**, and a column the user edited is **never** overwritten by a rule. That makes two-way arithmetic work with no special case:

```jsonc
{ "code": "amount", "on": ["quantity", "price"], "set": { "amount": "[quantity] * [price]" } },
{ "code": "price",  "on": ["amount"],            "set": { "price": "IF([quantity] = 0, [price], [amount] / [quantity])" } }
```

- A rule that cannot answer at once (a server rule, a formula reading through a reference) replies later, as a pass of its own. An immediate rule that already ran on the old value runs again on the new one, so `amount` follows the price the server suggested.
- A target the user may not edit (column security, a posted or period lock, `canEdit`) is skipped for that user.
- Bulk update counts every column it sets as the user's own edit, per record.
- Cycles are not checked at install; the once-per-edit rule is what stops them.

## Server rules

```js
// logic/functions/price_suggestions.dsl
function priceOn(record) {
	var price = /* read a price list, a register slice, the previous waybill … */ 0;
	if (price == 0) { warn('No price in the list'); return {}; }
	return { price: price };
}
```

- The function gets `record`, the values as the user has them (unsaved, typed by column; a 64-bit key is an exact BigInt), and returns `{ column: value }`. `{}` suggests nothing. A column it returns that `set` does not list is ignored.
- `warn()` / `info()` show as toasts. `error()` suggests nothing and shows its text.
- It runs with the user's rights and settings, in a transaction **that is always rolled back**. `insert()` and `update()` change nothing; queued notifications and e-mails are dropped. A `callApi()` is not undone — keep a reaction free of outside effects.
- The call needs Select and Insert or Update on the entity, and runs only a rule the entity declares.
- A stale reply is dropped: if a source changed again while it was out, or the user edited a target meanwhile, it is not applied.

## From a bridge module

A bridge module may declare `reactions` in an extension file, on its host's entity, calling its **own** functions. `crm-pricing` prices a `crm.quote_line` from the pricing module as it is edited.

```jsonc
// crm-pricing/entities/crm.quote_line.json
{
	"extends": "crm.quote_line",
	"dbObject": "quote_line",
	"reactions": [
		{ "code": "line_pricing", "on": ["product_id", "quantity"],
		  "call": "quoteLinePricing", "set": ["unit_price", "discount_pct"] }
	]
}
```

- Every host column a rule names (in `on` and `set`) must be in `deps/<host>.json`, with the provenance token `reaction:<code>`. Install checks them against the installed host. Name a reference by its **key column**, since a contract column is a stored one.
- Stored on the host under `params.extensionReactions[<bridge>]`, codes qualified `<bridge>.<code>`. The host's upgrade keeps them; the bridge's upgrade replaces them and its uninstall removes them.
- Not yet: exporting a bridge's rules back into its extension file.

## Built in: dependent references

Not declared. When the user edits a column that an `@[field]` placeholder in some reference's `refFilter` reads, that reference is re-checked and **cleared** if it no longer passes. Change the customer and the other customer's contract goes. Save waits for the checks.

## Common mistakes

- **A reaction as an invariant.** It does not run on the API, import or DSL. Use an `async: false` trigger for a value that must hold.
- **A target that is a reference column.** Set its FK column.
- **A dotted `code`.** The dot qualifies a bridge's rules. Rename it.
- **A host column used by a bridge reaction but missing from `deps/<host>.json`.** Add it with `reaction:<code>`.
- **Writing in a server rule.** The transaction rolls back; the form may still be cancelled.
- **Expecting a document header change to recompute every line.** A reaction acts within one record. A line is a record, so product → line price works; header → all lines does not.
- **Expecting a rule to run when a record is created with values** (New from a parent, a copy). It does not.
