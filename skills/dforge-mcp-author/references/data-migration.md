# Data Migration Reference

When the user has an existing database (typically after running the schema importer to produce a rough-cut module) and wants to **move the actual rows** into dForge, write them a migration script they can run locally.

This assumes:
- dForge is running locally (e.g. `docker compose up`).
- The legacy database is reachable from the developer's machine.
- The target is a **dev tenant**, never production.

## Script template — Python / psycopg

This is the most portable choice. Works against any source database with a Python driver, writes to dForge Postgres.

```python
#!/usr/bin/env python3
"""
Migration script: old_crm → dForge my_crm module
Generated on 2026-04-08
"""

import argparse
import sys
import uuid
import psycopg
from datetime import datetime
from typing import Dict

MIGRATION_USER_ID = "00000000-0000-0000-0000-000000000001"  # override with --migration-user

def cuid() -> str:
    """Generate a new cuid-like identifier for target PKs."""
    return str(uuid.uuid4())

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True, help="Source DB connection string")
    parser.add_argument("--target", required=True, help="Target dForge tenant DB connection string")
    parser.add_argument("--migration-user", default=MIGRATION_USER_ID)
    parser.add_argument("--dry-run", action="store_true", help="Simulate without committing")
    args = parser.parse_args()

    src = psycopg.connect(args.source)
    tgt = psycopg.connect(args.target)

    try:
        with tgt.transaction():
            pk_map: Dict[str, Dict[int, str]] = {}  # source_table → {source_id → target_id}

            # Phase 1: parents (no FK deps)
            migrate_accounts(src, tgt, pk_map, args.migration_user)
            migrate_products(src, tgt, pk_map, args.migration_user)

            # Phase 2: children (depend on parents)
            migrate_contacts(src, tgt, pk_map, args.migration_user)
            migrate_opportunities(src, tgt, pk_map, args.migration_user)

            # Phase 3: grandchildren
            migrate_opportunity_lines(src, tgt, pk_map, args.migration_user)
            migrate_activities(src, tgt, pk_map, args.migration_user)

            if args.dry_run:
                print("[DRY RUN] Rolling back.")
                raise SystemExit(0)

        print("Migration committed successfully.")

    except Exception as e:
        print(f"Migration failed: {e}", file=sys.stderr)
        sys.exit(1)
    finally:
        src.close()
        tgt.close()


def migrate_accounts(src, tgt, pk_map, migration_user):
    print("Migrating accounts…")
    pk_map["accounts"] = {}
    with src.cursor() as sc, tgt.cursor() as tc:
        sc.execute("SELECT id, name, phone, website, created_at FROM accounts")
        count = 0
        for row in sc:
            old_id, name, phone, website, created_at = row
            new_id = cuid()
            pk_map["accounts"][old_id] = new_id
            tc.execute(
                """
                INSERT INTO crm.account
                    (account_id, name, phone, website, created_date, created_by, last_updated, last_updated_by)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (new_id, name, phone, website, created_at or datetime.utcnow(),
                 migration_user, created_at or datetime.utcnow(), migration_user),
            )
            count += 1
    print(f"  {count} accounts migrated")


def migrate_contacts(src, tgt, pk_map, migration_user):
    print("Migrating contacts…")
    pk_map["contacts"] = {}
    skipped = 0
    with src.cursor() as sc, tgt.cursor() as tc:
        sc.execute("SELECT id, first_name, last_name, email, phone, account_id, created_at FROM contacts")
        count = 0
        for row in sc:
            old_id, first_name, last_name, email, phone, old_account_id, created_at = row

            # Resolve FK via pk_map
            new_account_id = pk_map["accounts"].get(old_account_id)
            if old_account_id and not new_account_id:
                print(f"  Skipping contact {old_id}: account {old_account_id} not found in mapping")
                skipped += 1
                continue

            new_id = cuid()
            pk_map["contacts"][old_id] = new_id
            tc.execute(
                """
                INSERT INTO crm.contact
                    (contact_id, first_name, last_name, email, phone, account_id,
                     created_date, created_by, last_updated, last_updated_by)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (new_id, first_name, last_name, email, phone, new_account_id,
                 created_at or datetime.utcnow(), migration_user,
                 created_at or datetime.utcnow(), migration_user),
            )
            count += 1
    print(f"  {count} contacts migrated, {skipped} skipped")


# … migrate_products, migrate_opportunities, migrate_opportunity_lines, migrate_activities follow the same pattern


if __name__ == "__main__":
    main()
```

## Script template — Pure SQL (Postgres → Postgres via dblink)

When both databases are PostgreSQL and you want the fastest possible migration, use `dblink` or `postgres_fdw`. This requires the `dblink` extension to be installed on the target.

```sql
-- migrate.sql — run against the dForge tenant DB
-- Connect to the legacy source via dblink

BEGIN;

-- Ensure dblink is available
CREATE EXTENSION IF NOT EXISTS dblink;

-- Create a PK mapping temp table
CREATE TEMP TABLE pk_map (
    source_table text NOT NULL,
    source_id    bigint NOT NULL,
    target_id    text NOT NULL,
    PRIMARY KEY (source_table, source_id)
);

-- Phase 1: Accounts
INSERT INTO crm.account
    (account_id, name, phone, website, created_date, created_by, last_updated, last_updated_by)
SELECT
    gen_random_uuid()::text,
    src.name,
    src.phone,
    src.website,
    COALESCE(src.created_at, NOW()),
    '00000000-0000-0000-0000-000000000001'::text,
    COALESCE(src.created_at, NOW()),
    '00000000-0000-0000-0000-000000000001'::text
FROM dblink(
    'host=legacy.local dbname=old_crm user=readonly',
    'SELECT id, name, phone, website, created_at FROM accounts'
) AS src(id bigint, name text, phone text, website text, created_at timestamp)
RETURNING account_id;

-- Record mappings for FK resolution
-- (In practice, do this in the same INSERT using a CTE with RETURNING)

-- Phase 2: Contacts (needs account FK resolution)
-- …

COMMIT;
```

Pure SQL is faster but harder to read and debug. **Prefer the Python script unless the dataset is very large.**

## Key rules

### PK generation

Source uses integer PKs, dForge uses cuid (string). Generate a **new cuid for every row** and record it in the mapping table. Never preserve source integer PKs.

### FK resolution order

Topologically sort the entities by FK dependencies. Parents first, then children, then grandchildren. If the source schema has cycles, break them: insert parents with NULL FKs first, then UPDATE the FKs in a second pass.

### Audit fields

Set `created_by` / `last_updated_by` to a designated migration user. The zero user (`00000000-0000-0000-0000-000000000001`) is a common convention for "system-generated" rows. Ask the user if you're unsure which user to attribute to. (Note: `created_by`/`last_updated_by` only exist if the entity uses `audit-full` trait; with just `audit`, only timestamps exist.)

Set `created_date` / `last_updated` from source timestamps if available, otherwise `NOW()`. Note: dForge audit column names are `created_date` and `last_updated` — NOT `created_at`/`updated_at`.

### Enum conversion

If the schema importer converted a lookup table (like `statuses`) to a `dropdown` column, the migration script must map source integer FK values to the new string option values. Read `params.options` on the target column and the importer's `MIGRATION_NOTES.md` to find the mapping.

### NULL handling

Source column is nullable, but the target column has `NOT NULL` (because the importer detected `NOT NULL` or the user made it mandatory). The script should either:

- Provide a sensible default, or
- Skip the row and log it

Never silently insert NULL into a NOT NULL column — it will fail.

### Type conversions

Common cases:

- `varchar(50)` → `varchar(100)` — safe
- `varchar(200)` → `varchar(100)` — **detect and truncate + warn, or skip + log**
- `int` enum → `dropdown` string — use the importer's option map
- Latin-1 → UTF-8 — re-encode bytes
- Naive timestamp → timestamptz — assume a tz (ask user) or keep naive

### Idempotency

Wrap the migration in a transaction. A failed run rolls back cleanly. For re-runs, either:

1. Truncate target tables before running (destructive — explicit user approval)
2. Use `ON CONFLICT DO NOTHING` with deterministic PKs derived from source (e.g. `md5(source_id)`)
3. Simply drop and reinstall the module, then re-run the migration

Default: **transaction + fail-fast**. Let the user re-run after fixing whatever failed.

## Dry-run mode

**Always** include `--dry-run`. In dry-run mode:

1. Connect to both DBs
2. Run all SELECTs
3. Do all transforms
4. Print a summary: `"Would insert 1,243 accounts, 87 contacts, 3,412 activities. 12 rows would be skipped."`
5. Rollback before committing

The user reviews, then re-runs without `--dry-run` to apply.

## What NOT to do

- **Do not go through the dForge API.** The RPC stack is 100x slower than direct SQL and adds no safety for a one-shot migration. Direct INSERTs into the tenant DB are the right tool.
- **Do not skip dry-run mode.** It's the only safe way to preview.
- **Do not migrate to production without multiple explicit confirmations.** Dev/local only by default. If the user insists on production, make the script check `--i-know-this-is-production` and print a scary warning.
- **Do not hardcode credentials.** Pass via arguments or env vars.
- **Do not silently drop rows.** Every skipped row gets logged to stderr with a reason.
- **Do not assume target tables exist.** Check first; bail if the module isn't installed.
- **Do not migrate views, stored procs, or triggers.** Those are listed in `MIGRATION_NOTES.md` and converted manually to dForge constructs (formulas, actions, reports).

## Produce a MIGRATION.md alongside the script

When you generate the migration script, also generate (or update) a `MIGRATION.md` in the module folder with:

- What the script does in plain English
- How to run it (example command lines for dry-run and actual run)
- What gets migrated and what doesn't
- Known caveats specific to this dataset
- Rollback instructions

The user reads `MIGRATION.md` first, then runs the script.
