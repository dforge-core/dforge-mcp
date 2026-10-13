# Registers Reference

A **register** is a declared store of movements or values that documents write to by posting, and that the platform reads back with fixed primitives. Declare it once in `registers.json`; documents bind to it from an `A` or `L` column.

Lives in: `registers.json` at the module root (a keyed dictionary, like `logic/jobs.json`). Schema: [`docs/schemas/registers.schema.json`](../../../docs/schemas/registers.schema.json); binding params: `registryColumnParams` in [`docs/schemas/entity.schema.json`](../../../docs/schemas/entity.schema.json). Full guide: [`docs/business-logic/registers.md`](../../../docs/business-logic/registers.md). Check with `dforge_module_validate`, then `dforge_module_pack` and `dforge_module_install`.

## Register or plain table?

| You need | Use |
|---|---|
| Running quantity or amount per key, with undo on unpost | `balance` register |
| "How much moved in a period", no running total | `turnover` register |
| A value that changes over time, or a keyed lookup, with "value as of a date" | `info` register |
| Double-entry postings by account, with analytics | `accounting` register |
| Ordinary master or transactional data nobody aggregates by key | Plain entity |
| An ad hoc slice by an optional attribute | A report, not a dimension |

A register earns its place when something must be guarded or cached by its key: a negative-stock check, a unique slice, a period lock. Posting and unposting are then the platform's job, not a DSL's.

## The kinds

| `kind` | Keeps | Written by | Read by | Key rules |
|---|---|---|---|---|
| `balance` | State row per dimension tuple, plus optional journal | `A` column | `getBalance`, `getTurnover` | Needs `entity`. Set `journal`, `journalDirection`, `journalDate` from the start. `allowNegative` default `false`, `autoCreate` default `true`. |
| `turnover` | Journal only | `A` column | `getTurnover` | No `entity`, no `allowNegative`/`autoCreate`. `journal`, `journalDirection`, `journalDate` mandatory. `getBalance` refuses it. |
| `info` | One table of records | `data.set` (independent) or `A` column (subordinate, has `recorder`) | `getSlice` | Needs `entity`, no `journal`. Optional `period`. Independent: unique constraint over dimensions + `period`. Binding needs a `recorder`. |
| `accounting`, `classic` | Postings, one account per row | `L` column | `getAccountBalance`, `getAccountTurnover`, dataset `R` | `chart`, `account`, `analyticFields`, `composition`. Every resource split `debitField`/`creditField`. No correspondence. |
| `accounting`, `compound` | Postings, debit and credit account on one row | `L` column | Same, plus `getCorrespondence` | `debitAccount` != `creditAccount`, per-side analytic arrays, optional `sideDimensions`. Resource shared (`field`) or split. Balance check refused. |

Every register needs `dimensions` (1-8 columns) and `resources` (1-64). A resource is `required` by default; set `"required": false` when only some writers supply it. A property a kind refuses fails install; it is never ignored.

## `registers.json`

Register codes: lowercase letters, digits, underscores. A document addresses one as `module_cd.register_cd`. `label` gives it a translatable name.

### Balance (`wms-registry.stock`)

```json
{
    "stock": {
        "kind": "balance",
        "label": "Stock on Hand",
        "entity": "stock",
        "journal": "stock_movement",
        "journalDirection": "movement_direction",
        "journalDate": "movement_date",
        "dimensions": ["warehouse_id", "product_id"],
        "resources": { "quantity": { "field": "quantity" } },
        "allowNegative": false,
        "autoCreate": true
    }
}
```

### Turnover (`wms-registry.product_flow`)

```json
{
    "product_flow": {
        "kind": "turnover",
        "journal": "product_flow",
        "journalDirection": "flow_direction",
        "journalDate": "flow_date",
        "dimensions": ["warehouse_id", "product_id"],
        "resources": {
            "received": { "field": "received", "required": false },
            "shipped": { "field": "shipped", "required": false }
        }
    }
}
```

### Info (`wms-registry.outlet_price`, subordinate)

```json
{
    "outlet_price": {
        "kind": "info",
        "entity": "outlet_price",
        "recorder": "source",
        "period": "effective_from",
        "dimensions": ["warehouse_id", "product_id"],
        "resources": {
            "price": { "field": "price" },
            "currency_cd": { "field": "currency_cd", "required": false }
        }
    }
}
```

`recorder` is a jsonb column the platform stamps with the writing document. Add `"recordChangesOnly": true` (and `absentAs` per resource) to skip a record equal to the slice already in effect.

### Accounting, classic (`acc-registry.gl`)

```json
{
    "gl": {
        "kind": "accounting",
        "lineMode": "classic",
        "chart": "account",
        "journal": "gl_acc_posting",
        "journalDate": "posted_on",
        "account": "account_id",
        "composition": {
            "entity": "account_analytic",
            "account": "account_id",
            "slot": "slot_no",
            "analytic": "analytic_kind_cd"
        },
        "analyticFields": ["analytic1", "analytic2", "analytic3", "analytic4"],
        "dimensions": ["period_key"],
        "resources": {
            "amount": { "debitField": "debit_amount", "creditField": "credit_amount" }
        }
    }
}
```

`composition` is where the chart says which analytic kind each account carries in which slot. It is required exactly when slot columns are declared; `"analyticFields": []` needs none. Its entity needs a unique constraint over `(account, slot)`.

### Accounting, compound (`acc-registry.gl_corr`)

```json
{
    "gl_corr": {
        "kind": "accounting",
        "lineMode": "compound",
        "chart": "account",
        "journal": "gl_corr_posting",
        "journalDate": "posted_on",
        "debitAccount": "debit_account_id",
        "creditAccount": "credit_account_id",
        "composition": { "entity": "account_analytic", "account": "account_id", "slot": "slot_no", "analytic": "analytic_kind_cd" },
        "debitAnalyticFields": ["dt_analytic1", "dt_analytic2"],
        "creditAnalyticFields": ["ct_analytic1", "ct_analytic2"],
        "dimensions": ["period_key", "organization_id", "currency_cd"],
        "sideDimensions": {
            "currency_cd": { "debitField": "dt_currency_cd", "creditField": "ct_currency_cd" }
        },
        "resources": {
            "amount": { "field": "amount" },
            "currency_amount": { "debitField": "dt_currency_amount", "creditField": "ct_currency_amount" }
        }
    }
}
```

The slot cap lives in three places that must agree: the posting's slot columns, `analyticFields`, and the chart's check constraint on the composition table. The platform does not parse that check; a mismatch is refused at post time.

## Binding a document

A register column is a `bool` state column. `A` writes `balance`, `turnover` and `info`; `L` writes `accounting`. Install resolves `register` and refuses an undeclared one.

### `A` column (`wms-registry.stock`)

```json
"stock_out": {
    "columnType": "A",
    "dbDatatype": "bool",
    "flags": "V",
    "description": "Stock Out (source)",
    "params": {
        "stateField": "stock_out_state",
        "register": "wms-registry.stock",
        "direction": "decrease",
        "dateField": "transfer_date",
        "map": {
            "warehouse_id": "source_warehouse_id",
            "product_id": "product_id",
            "quantity": "quantity"
        },
        "lockedFields": ["transfer_date", "source_warehouse_id", "product_id", "quantity"]
    }
}
```

| Param | Meaning |
|---|---|
| `register` | `module_cd.register_cd`. Do not combine with inline `registries`. |
| `direction` | `increase` or `decrease`. Refused on `info`. `sign` decides per row instead. |
| `dateField` | Document date stamped into `journalDate` or `period`. Required once the register declares either. Must be in `lockedFields`. `dateTrunc` (`day`/`month`/`year`) truncates it. |
| `map` | Register name to column. A dimension left out binds to the column of the same name. Every required resource must be mapped. |
| `lineEntity` + `lineField` | Post from lines: one movement per line. Declared per binding. Needs `lockedLineFields`. |
| `headerMap` | On a line posting, register name to a **document** column. A resource may come from the document only on an `info` register. Every column must be in `lockedFields`. |
| `groupLinesBy` | One movement per distinct value of these line columns. `map` is read over a group row; numeric resources are summed. |
| `skipPostingWhenEmpty` | Dimensions whose emptiness means "this row posts nothing". The exception, see below. |
| `lockedFields` / `lockedLineFields` | Columns frozen while posted. `["*"]` freezes the whole row. |
| `movementMapping` | Journal attribute column to document or line column. |

### `map` value forms

| Form | Example | Notes |
|---|---|---|
| Column | `"qty"` | The default. |
| One-hop path | `"product.product_group"` | Root is an `R` column with a `link`. The reference key column must be locked. Two hops refused. |
| Expression | `"=COALESCE([transit_warehouse_id], [dest_warehouse_id])"` | Leading `=`, `F`-column formula, one-hop `[ref].[col]` reads. Every column read must be locked. |
| Quoted constant | `"'1'"` | Stamped as is. A resource constant must be a number, outside `info`. |
| Per-side object | `{ "debit": "dt_currency_cd", "credit": "ct_currency_cd" }` | `L` column only. For a resource or dimension the register splits by side. Both sides named. |

The per-side object shape was missing from the entity schema until metadata 0.0.39. Validate with metadata 0.0.39 or later.

Paths, expressions, `dateTrunc`, `headerMap`, `groupLinesBy` and `skipPostingWhenEmpty` are `A`-only. An `L` column refuses them.

### `L` column (`acc-registry.gl_corr`)

```json
"params": {
    "register": "acc-registry.gl_corr",
    "lineEntity": "gl_corr_line",
    "lineField": "gl_corr_entry_id",
    "debitAccountField": "debit_account_id",
    "creditAccountField": "credit_account_id",
    "dateField": "entry_date",
    "periodDimField": "period_key",
    "map": {
        "organization_id": "organization_id",
        "currency_cd": { "debit": "dt_currency_cd", "credit": "ct_currency_cd" },
        "amount": "amount",
        "currency_amount": { "debit": "dt_currency_amount", "credit": "ct_currency_amount" }
    },
    "debitAnalytics": { "cost_center": "dt_cost_center_id" },
    "creditAnalytics": { "counterparty": "ct_counterparty_id" },
    "lockedFields": ["entry_date", "period_key"],
    "lockedLineFields": ["*"]
}
```

- Classic uses `accountField` and `analytics`. Compound uses `debitAccountField` + `creditAccountField` and `debitAnalytics` / `creditAnalytics`. Mixing them is refused.
- `analytics` maps an analytic **kind** to a line column. The chart decides the slot per account, so one line column can land in `analytic1` on one account and `analytic2` on another.
- `lineEntity` and `lineField` are required. `lockedLineFields` must cover every line column the posting copies, or be `["*"]`.
- Every register dimension must be mapped, be a same-name line column, or be the `periodDimField` (a shared dimension).
- `validation.balanced: ["amount"]` checks debits equal credits on classic. It is refused on compound, which balances by construction.
- `validation.storno: true` posts a **red reversal**: the same correspondence on the **same** side with a negative amount, which is how 1C reverses a sale. Classic and compound both accept it. Turnovers stay on their side as negatives, and every read, the totals cache and the account-balances report sum them signed. The other per-line checks stay, read as non-zero: a classic line still carries one side per resource, and an all-zero line is refused. `balanced` is unchanged. Install refuses it on a column that is not an accounting `L` column.
- `requirePositiveAmounts: false` is **deprecated**: it switches off every per-line check, not only the sign. `storno: true` wins when both are set.
- An accounting register has no negative-balance control, so a quantity account can be driven below zero. The account-balances report drops an account whose opening is zero and whose in-period turnovers cancel out, such as an entry and its storno in the same period.
- A binding over lines, or an `L` column, posted from a document with **no lines** records nothing and leaves its state flag off. It asks for no date or open period, and the document's other registers still post. The inline `registries` form of the `L` column still refuses an entry with no lines.

## Reads

| Read | Kinds | Returns |
|---|---|---|
| `getBalance(register, dims?, asOf?)` | `balance` | `{ resource: value }`, zeros when empty |
| `getTurnover(register, dims, from, to)` | `balance`, `turnover` | `{ resource: { in, out, net } }` |
| `getSlice(register, dims, onDate?, mode?)` | `info` | Record plus `_period`, or `null`. `mode` is `last` (default) or `first`. |
| `getAccountBalance(register, account, filter?, asOf?)` | `accounting` | `{ resource: { debit, credit, net } }` |
| `getAccountTurnover(register, account, filter, from, to)` | `accounting` | Same shape |
| `getCorrespondence(register, debitAccount, creditAccount, filter, from, to)` | compound | Same shape |

```
execute:
    var onHand = getBalance("wms-registry.stock", { warehouse_id: [warehouse_id], product_id: [product_id] })
    var price = getSlice("wms-registry.outlet_price", { warehouse_id: [warehouse_id], product_id: [product_id] }, [order_date])
```

- A dimension left out is summed over by `getBalance` and `getTurnover`. `getSlice` refuses an omitted dimension.
- As-of reads and `getTurnover` need a journal with both stamps.
- A read of the wrong kind is refused, naming the right one.
- DSL reads are gated by the action's Execute right, not Select on the register tables.
- **Reports:** a dataset with `"datasetType": "R"` reads an accounting register over an interval. It returns one row per chart account with `opening_*`, `turnover_*` and `closing_*` debit and credit for one resource. See [`reports.md`](reports.md) and [`docs/business-logic/gl-ledger-to-declared-register.md`](../../../docs/business-logic/gl-ledger-to-declared-register.md).

## Totals cache

`totals` caches the turnover inside each `day`/`month`/`quarter`/`year`, never a closing balance, so a backdated posting touches one row. Declare an `entity` whose PRIMARY KEY is exactly (dimensions, `periodField`), with `inField`/`outField` per resource (`debitField`/`creditField` and an `accountField` on accounting). Posting maintains it; install rebuilds it when its shape changes. Not available on `info`. Details: registers.md section 8.4.

## Common mistakes

- **Undeclared or unqualified register.** `params.register` must be `module_cd.register_cd` and exist. Install fails, not the first posting.
- **Unmapped required resource.** Map it, or mark the resource `"required": false` when only some writers supply it.
- **Empty dimension.** An empty dimension refuses the posting. `skipPostingWhenEmpty` is the exception: it leaves a document posted while some lines moved nothing. Prefer one line table per binding. Use it only when the distinction lives in the data, such as a serial number filled on some rows.
- **Missing or unlocked `dateField`.** Required once the register has `journalDate` or `period`, and it must be in `lockedFields`.
- **Key over dimensions.** The journal, a subordinate `info` register's records and an `autoCreate` state table are written by the platform. Each needs **one** surrogate primary key of type `bigint` (`identity`/`cuid`) or `uuid`. A key over dimensions, a multi-column key, a text key and `int4` are refused.
- **State column narrower than the journal column.** It must hold the journal's value exactly, or unposting cannot take back what posting added.
- **Two resources from one document column**, or two resources storing into one register column. Refused.
- **Binding to an independent `info` register.** Refused. Write it with `data.set`, or give it a `recorder`.
- **Direct writes to register tables.** They are ordinary entities. Withhold `I`/`U`/`D` on state, journal and cache in the module's roles.
- **`A`/`L` column in an `extends` entity.** An `A` column is allowed (a bridge posts another module's document; the state lives in the bridge's `_ext` table). An `L` column is allowed but not yet tested. See [`register-posting-from-extensions.md`](../../../docs/business-logic/register-posting-from-extensions.md).
- **`mark-imported` is not `post`.** A document posted in another system is marked with `dforge-cli register mark-imported --entity <e> --state-column <col> --where "<sql>"`. Its state column stays false, and the engine refuses to post or unpost it. Do not set the flag by hand.
- **Posting a mark-imported document, or unposting a receipt a later shipment consumed** (with `allowNegative: false`), is refused with `REGISTER_NEGATIVE_BALANCE` or an imported-document error.
