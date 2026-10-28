#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Ask the database what the metadata cannot answer.

`migrate.py verify` reads the column map and `"dForge".entity_column`, so it can only
check a reference the metadata knows about - and it will agree with the metadata even
when the table disagrees with both. Four things it cannot see:

  * a foreign key whose rows point at nothing. The loader runs with
    `session_replication_role = 'replica'`, so Postgres checks not one of them on the
    way in; this asks afterwards.
  * a foreign key that points somewhere the metadata no longer does. A module upgrade
    moves the reference column's `ref_entity_id` and leaves the constraint alone, so the
    card offers one catalog and the table insists on another. That is how
    `FK_OrganizationId` went on naming `masterdata.party` for 88,126 `shipping_order`
    rows after the spec had re-pointed the column at `masterdata.organization`.
  * a reference with no foreign key behind it. An extension column is exactly
    that: the platform builds the 1:1 side table with a key back to the host and
    leaves the reference itself unconstrained, so the first check cannot see it.
  * a physical column the metadata no longer accounts for.

    python tools/integrity.py                 # all four, every module schema
    python tools/integrity.py --schema shipping
    python tools/integrity.py --retarget      # recreate the keys that disagree

`--retarget` only touches a key no row would break: if anything still dangles against
the target the metadata names, the constraint stays and the row is reported instead.

Connection details come from the same place as `migrate.py` - DF_PG_* and DF_TENANT.
"""
from __future__ import print_function

import argparse
import sys

import migrate

# Their own tables pair columns by names that coincide, so the reference check reads
# them as retargeted when they are nothing of the kind.
PLATFORM = ("dForge", "audit", "public", "information_schema", "pg_catalog")

# R, S and F are virtual: the column they name is not a column of the table.
VIRTUAL = ("R", "S", "F")


def module_schemas(cur, only=None):
	cur.execute("""SELECT DISTINCT e.schema_name FROM "dForge".entity e
	               WHERE e.schema_name <> ALL(%s) ORDER BY 1""", (list(PLATFORM),))
	found = [row[0] for row in cur.fetchall()]
	return [s for s in found if not only or s == only]


def foreign_keys(cur, schemas):
	"""Every single-column foreign key out of these schemas, with what it points at."""
	cur.execute("""
		SELECT con.conname, src_ns.nspname, src.relname, src_col.attname,
		       tgt_ns.nspname, tgt.relname, tgt_col.attname
		FROM pg_constraint con
		JOIN pg_class src ON src.oid = con.conrelid
		JOIN pg_namespace src_ns ON src_ns.oid = src.relnamespace
		JOIN pg_class tgt ON tgt.oid = con.confrelid
		JOIN pg_namespace tgt_ns ON tgt_ns.oid = tgt.relnamespace
		JOIN pg_attribute src_col ON src_col.attrelid = con.conrelid
		                         AND src_col.attnum = con.conkey[1]
		JOIN pg_attribute tgt_col ON tgt_col.attrelid = con.confrelid
		                         AND tgt_col.attnum = con.confkey[1]
		WHERE con.contype = 'f' AND array_length(con.conkey, 1) = 1
		  AND src_ns.nspname = ANY(%s)
		ORDER BY src_ns.nspname, src.relname, src_col.attname
	""", (list(schemas),))
	return cur.fetchall()


def dangling(cur, schema, table, column, target_schema, target_table, target_column):
	cur.execute('SELECT count(*) FROM "%s"."%s" s WHERE s."%s" IS NOT NULL'
	            ' AND NOT EXISTS (SELECT 1 FROM "%s"."%s" t WHERE t."%s" = s."%s")'
	            % (schema, table, column,
	               target_schema, target_table, target_column, column))
	return cur.fetchone()[0]


def check_rows(cur, schemas):
	"""Rows whose foreign key points at a row that is not there."""
	print("\nforeign keys whose rows point at nothing")
	print("-" * 78)
	broken = 0
	for name, sn, st, sc, tn, tt, tc in foreign_keys(cur, schemas):
		count = dangling(cur, sn, st, sc, tn, tt, tc)
		if count:
			broken += 1
			print("%-40s %-26s %8d" % ("%s.%s.%s" % (sn, st, sc), name, count))
	print("-" * 78)
	print("%d foreign key(s) with rows pointing at nothing" % broken)
	return broken


def check_targets(cur, schemas, retarget=False):
	"""Foreign keys that point somewhere the metadata no longer does."""
	cur.execute("""
		SELECT con.conname, src_ns.nspname, src.relname, src_col.attname,
		       tgt_ns.nspname, tgt.relname,
		       ref.schema_name, lower(ref.db_object), lower(ec.other_key)
		FROM pg_constraint con
		JOIN pg_class src ON src.oid = con.conrelid
		JOIN pg_namespace src_ns ON src_ns.oid = src.relnamespace
		JOIN pg_class tgt ON tgt.oid = con.confrelid
		JOIN pg_namespace tgt_ns ON tgt_ns.oid = tgt.relnamespace
		JOIN pg_attribute src_col ON src_col.attrelid = con.conrelid
		                         AND src_col.attnum = con.conkey[1]
		JOIN "dForge".entity e ON e.schema_name = src_ns.nspname
		                      AND lower(e.db_object) = src.relname
		JOIN "dForge".entity_column ec ON ec.entity_id = e.entity_id
		                              AND ec.column_type = 'R'
		                              AND lower(ec.this_key) = src_col.attname
		JOIN "dForge".entity ref ON ref.entity_id = ec.ref_entity_id
		WHERE con.contype = 'f' AND array_length(con.conkey, 1) = 1
		  AND src_ns.nspname = ANY(%s)
		  AND (lower(ref.db_object) IS DISTINCT FROM tgt.relname
		       OR ref.schema_name IS DISTINCT FROM tgt_ns.nspname)
		ORDER BY src_ns.nspname, src.relname, src_col.attname
	""", (list(schemas),))
	rows = cur.fetchall()

	print("\nforeign keys that disagree with the metadata")
	print("-" * 78)
	for name, sn, st, sc, fkn, fkt, rn, rt, rpk in rows:
		count = dangling(cur, sn, st, sc, rn, rt, rpk)
		print("%-34s %-22s %s.%s -> %s.%s" % ("%s.%s" % (st, sc), name, fkn, fkt, rn, rt))
		if count:
			print("   %d row(s) dangle against the target the metadata names - left alone"
			      % count)
			continue
		if retarget:
			cur.execute('ALTER TABLE "%s"."%s" DROP CONSTRAINT "%s"' % (sn, st, name))
			cur.execute('ALTER TABLE "%s"."%s" ADD CONSTRAINT "%s" FOREIGN KEY ("%s")'
			            ' REFERENCES "%s"."%s" ("%s")'
			            % (sn, st, name, sc, rn, rt, rpk))
			print("   recreated")
	print("-" * 78)
	print("%d foreign key(s) pointing where the metadata does not" % len(rows))
	return len(rows)


def check_unbacked(cur, schemas):
	"""Reference columns the database is not enforcing.

	`check_rows` walks `pg_constraint`, so a reference with no foreign key behind it is
	invisible to it - and an extension column is exactly that: the platform builds the
	1:1 side table with a key back to the host and leaves the reference itself
	unconstrained. This asks the metadata instead of the catalogue, and counts.
	"""
	cur.execute("""
		SELECT e.schema_name, coalesce(held.storage_table, e.db_object), ec.this_key,
		       ref.schema_name, lower(ref.db_object), lower(ec.other_key)
		FROM "dForge".entity_column ec
		JOIN "dForge".entity e ON e.entity_id = ec.entity_id
		JOIN "dForge".entity ref ON ref.entity_id = ec.ref_entity_id
		-- The physical column is the one named by `this_key`, and it is that row -
		-- not the reference beside it - that says which table actually holds it.
		LEFT JOIN "dForge".entity_column held ON held.entity_id = ec.entity_id
		                                     AND held.column_cd = ec.this_key
		WHERE ec.column_type = 'R' AND ec.this_key IS NOT NULL
		  AND ec.other_key IS NOT NULL
		  AND e.schema_name = ANY(%s)
		ORDER BY 1, 2, 3
	""", (list(schemas),))

	print("\nreferences with no foreign key behind them")
	print("-" * 78)
	loose = 0
	for schema, storage, column, ref_schema, ref_table, ref_key in cur.fetchall():
		if "." in (storage or ""):
			schema, storage = [p.strip().strip('"') for p in storage.split(".")]
		storage = storage.lower()
		cur.execute("""SELECT 1 FROM pg_constraint con
		               JOIN pg_class src ON src.oid = con.conrelid
		               JOIN pg_namespace ns ON ns.oid = src.relnamespace
		               JOIN pg_attribute a ON a.attrelid = con.conrelid
		                                  AND a.attnum = con.conkey[1]
		               WHERE con.contype = 'f' AND ns.nspname = %s
		                 AND src.relname = %s AND a.attname = %s""",
		            (schema, storage, column.lower()))
		if cur.fetchone():
			continue
		cur.execute("""SELECT 1 FROM information_schema.columns
		               WHERE table_schema = %s AND table_name = %s
		                 AND column_name = %s""", (schema, storage, column.lower()))
		if not cur.fetchone():
			continue
		loose += 1
		cur.execute('SELECT count(*) FROM "%s"."%s" s WHERE s."%s" IS NOT NULL'
		            ' AND NOT EXISTS (SELECT 1 FROM "%s"."%s" t WHERE t."%s" = s."%s")'
		            % (schema, storage, column, ref_schema, ref_table, ref_key, column))
		count = cur.fetchone()[0]
		print("%-46s -> %-22s %s"
		      % ("%s.%s.%s" % (schema, storage, column),
		         "%s.%s" % (ref_schema, ref_table),
		         "%d dangling" % count if count else "ok"))
	print("-" * 78)
	print("%d reference(s) the database does not enforce" % loose)
	return 0


def check_columns(cur, schemas):
	"""Physical columns the metadata no longer accounts for."""
	cur.execute("""
		SELECT c.table_schema, c.table_name, c.column_name, c.data_type
		FROM information_schema.columns c
		JOIN "dForge".entity e ON e.schema_name = c.table_schema
		                      AND lower(e.db_object) = c.table_name
		WHERE c.table_schema = ANY(%s)
		  AND NOT EXISTS (
			SELECT 1 FROM "dForge".entity_column ec
			WHERE ec.entity_id = e.entity_id AND lower(ec.column_cd) = c.column_name
			  AND coalesce(ec.column_type, ' ') <> ALL(%s))
		  AND NOT EXISTS (
			SELECT 1 FROM "dForge".entity_column ec
			WHERE lower(coalesce(ec.storage_table, '')) LIKE '%%"' || c.table_name || '"'
			  AND lower(ec.column_cd) = c.column_name)
		ORDER BY 1, 2, 3
	""", (list(schemas), list(VIRTUAL)))
	rows = cur.fetchall()

	print("\ncolumns the metadata no longer accounts for")
	print("-" * 78)
	for schema, table, column, kind in rows:
		cur.execute('SELECT count(*) FROM "%s"."%s"' % (schema, table))
		held = cur.fetchone()[0]
		print("%-40s %-22s %-10s %s"
		      % ("%s.%s" % (schema, table), column, kind,
		         "empty" if not held else "holds %d row(s)" % held))
	print("-" * 78)
	print("%d column(s) left without metadata" % len(rows))
	return len(rows)


def main():
	parser = argparse.ArgumentParser(description=__doc__)
	parser.add_argument("--schema", help="one module schema instead of all of them")
	parser.add_argument("--retarget", action="store_true",
	                    help="recreate the foreign keys that disagree with the metadata")
	args = parser.parse_args()

	migrate.load_env()
	pg = migrate.pg_connect()
	cur = pg.cursor()
	schemas = module_schemas(cur, args.schema)
	if not schemas:
		print("no module schema to look at")
		return 1
	print("%d schema(s): %s" % (len(schemas), ", ".join(schemas)))

	problems = check_rows(cur, schemas)
	problems += check_targets(cur, schemas, args.retarget)
	problems += check_unbacked(cur, schemas)
	problems += check_columns(cur, schemas)
	if args.retarget:
		pg.commit()
	return 1 if problems else 0


if __name__ == "__main__":
	sys.exit(main())
