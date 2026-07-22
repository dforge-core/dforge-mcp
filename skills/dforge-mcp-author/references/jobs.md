# Scheduled Jobs Reference

A scheduled job is **a cron schedule + an action** declared in `logic/jobs.json`. The `dForge.Scheduler` worker process fires the action on schedule. No new DSL surface — jobs reuse existing actions.

Lives in: `logic/jobs.json` at the module root. Schema: [`docs/schemas/jobs.schema.json`](../../../docs/schemas/jobs.schema.json). Full guide: [`docs/business-logic/jobs.md`](../../../docs/business-logic/jobs.md).

## Structure

```json
{
    "jobs": [
        {
            "code": "nightly_invoice_run",
            "description": "Generate recurring invoices for active subscriptions.",
            "action": "generate_invoices",
            "schedule": "0 2 * * *",
            "timeout": 600,
            "class": "long_running",
            "concurrency": 1,
            "timeZone": "Europe/Zurich"
        }
    ]
}
```

## Field reference

| Field            | Required | Default      | Notes                                                                                                                                |
| ---------------- | -------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `code`           | Yes      |              | Unique within the module. `^[a-z][a-z0-9_]*$`.                                                                                       |
| `action`         | Yes      |              | Action `code` from this module's `ui/actions.json`. Cross-module references are rejected — wrap in a local action.                   |
| `schedule`       | Yes      |              | Five-field cron (minute granularity). Sub-minute schedules rejected.                                                                 |
| `timeout`        | Yes      |              | Hard timeout in seconds. Range `(0, 3600]`. **No implicit default.** `timeout > 300` requires `class: "long_running"`.               |
| `class`          | No       | `"standard"` | `"standard"` (≤ 300 s) or `"long_running"` (≤ 3600 s). Explicit opt-in for heavy jobs.                                               |
| `concurrency`    | No       | `1`          | Max parallel runs `[1, 5]`. `1` = single-instance.                                                                                   |
| `idempotencyKey` | No       |              | Template like `"{job_cd}:{run.month}"`. Successful run with same key blocks re-dispatch.                                             |
| `timeZone`       | No       | tenant tz    | IANA name. Falls back to `auth.tenant.time_zone`.                                                                                    |
| `params`         | No       | `{}`         | Static parameters passed to the action as `__params`. For runtime values, use folder-scoped module settings.                         |
| `enabled`        | No       | `true`       | `false` fully disables — no scheduler, no manual trigger.                                                                            |
| `paused`         | No       | `false`      | Soft pause. Scheduler skips, but "Run now" still works.                                                                              |
| `description`    | No       |              | Human-readable description.                                                                                                          |

**Hard cap: 50 jobs per module.**

## Cron — five fields

```
minute  hour  day-of-month  month  day-of-week

0 2 * * *      # daily at 02:00 in the job's tz
*/15 * * * *   # every 15 minutes
0 9 * * 1-5    # 09:00 weekdays
0 0 1 * *      # midnight on the first of each month
```

## Writing the action

Scheduled actions run with **no record bound**. Specifically:

- `user_id = 0` (system user sentinel)
- No `folder_id` — query / insert against the tenant DB directly
- `notify()` writes to inbox only (no live SSE in Phase 1)
- `sendEmail()` raw mode only in Phase 1

**Record context is forbidden.** The install pipeline rejects any action whose compiled DSL references `[field]` or `for x in records { … }` — those compile to `__r.` / `__records.` which would `ReferenceError` at fire time. Refactor to operate via `select()` / `insert()` / `update()`:

```
execute:
    let cutoff = now() - days(30)
    let drafts = query("SELECT invoice_id FROM invoice WHERE status = 'draft' AND created_date < @cutoff",
                       { cutoff: cutoff })
    for d in drafts {
        callAction('archive_invoice', { invoice_id: d.invoice_id })
    }
```

Hide the action from the UI with `canExecute: false` — the scheduler bypasses the check:

```
canExecute:
    false

execute:
    // cron-only logic
```

## Reference example (the `chore` module)

**`logic/jobs.json`**
```json
{
    "jobs": [
        {
            "code": "tick",
            "description": "Smoke test — fires every minute.",
            "action": "log_tick",
            "schedule": "* * * * *",
            "timeout": 30
        }
    ]
}
```

**`ui/actions.json`**
```json
{
    "log_tick": {
        "description": "Insert a chore_log row marking a scheduler tick",
        "label": "Log Tick",
        "icon": "bi-clock-history",
        "entityCode": "chore_log",
        "executionMode": "single",
        "script": "log_tick",
        "isTransacted": true,
        "orderNum": 10
    }
}
```

**`logic/actions/log_tick.dsl`**
```
execute:
    insert('chore_log', {
        ran_at: now(),
        message: 'Scheduler tick',
        source: 'cron'
    })
```

Full source: [`modules/chore/`](../../../modules/chore/).

## Common mistakes

- **Cross-module action reference.** A job in `crm` cannot reference an action in `fin`. Declare a thin `crm.run_fin_thing` action in your own module and bind the job to that.
- **Record-bound action.** Any `[field]` or `for x in records` in the DSL fails install — the action has no record at fire time. Refactor to `select()`/`insert()`/`update()`.
- **Missing `timeout`.** Required, no default. Pick 30 s if you don't know; bump when you have evidence.
- **`timeout > 300` without `class: "long_running"`.** Install fails. Heavy jobs are an explicit opt-in.
- **Sub-minute cron.** The scheduler ticks every 60 s. Anything finer is dishonest — declare a minute cron.
- **Renaming `code` between versions.** Treats it as a new job and leaves the old `scheduled_job` row orphaned until uninstall (actually reaped on upgrade — but you lose `job_run` history). Keep `code` stable.
- **"Schedule this 5 minutes from now" pattern.** There is no per-call `schedule()`. Use a cron-scan job that watches a queue table — see [memory: cron-scan pattern](../../../docs/business-logic/jobs.md#when-to-use-a-job-vs-a-trigger).
- **Confusing `enabled` and `paused`.** `enabled: false` → "Run now" no-ops. `paused: true` → cron skips but "Run now" works. Use `paused` for incident response; use `enabled: false` when you mean "turn this off entirely".

## Reference

- Full developer guide: [`docs/business-logic/jobs.md`](../../../docs/business-logic/jobs.md)
- JSON Schema: [`docs/schemas/jobs.schema.json`](../../../docs/schemas/jobs.schema.json)
- Reference module: [`modules/chore/`](../../../modules/chore/)
- Source (registrar): `server/src/dForge.Admin/Services/ModuleInstall/JobRegistrar.cs`
- Source (scheduler worker): `server/src/dForge.Scheduler/SchedulerWorker.cs`
