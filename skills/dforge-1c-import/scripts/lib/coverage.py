#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
How much of what 1C wrote the engine can write: per register, per document type that wrote it.

The port is measured one document at a time - a model against 1C's rows, then the engine
against them - and each measurement lands in a commit message or a paragraph. This is the
sum of them: for every register the tenant declares, the rows the infobase holds in a window,
split by the document type that recorded them, and for each type whether a binding writes
that register (an `A` or `L` column naming it) and what the last engine check said.

    python tools/1c.py coverage                       # every register, the last 365 days
    python tools/1c.py coverage --since 2025-10-10    # from a date
    python tools/1c.py coverage accounting.self_supporting --all   # one register, every type
    python tools/1c.py coverage --save                # and keep a snapshot to compare with

Everything is read from the tenant's own metadata ("dForge".register and the binding
columns), so a register or binding installed tomorrow is counted without editing this file.
A row's document type is the document table its recorder is a key of; a recorder that is a
key of none is reported as such rather than dropped. A type counts as bound when any entity
over its table - the document's own module or an extension in another - has a binding column
for the register. Bound is not the same as ported in full: a binding may still refuse some of
its documents, which is what the engine column is for.

The engine column is filled by the tools that put documents through the running engine and
compare with 1C's rows (`record_engine`): the last result per document type and check, with
its date. `--save` writes the table to `<out>/coverage/<date>.json`; the next run prints what
moved since the latest snapshot.
"""
from __future__ import print_function

import argparse
import datetime
import io
import json
import os
import sys

import migrate
import paths

FOLDER = os.path.join(paths.OUT, "coverage")
ENGINE = os.path.join(FOLDER, "engine.json")


def record_engine(table, check, checked, equal, when=None):
	"""Keep the result of an engine check of `table` (schema.table) under the name `check`."""
	if not os.path.isdir(FOLDER):
		os.makedirs(FOLDER)
	found = _read(ENGINE) or {}
	found.setdefault(table, {})[check] = {
		"date": when or datetime.date.today().isoformat(), "checked": checked, "equal": equal}
	_write(ENGINE, found)


def _read(path):
	if not os.path.isfile(path):
		return None
	with io.open(path, encoding="utf-8") as f:
		return json.load(f)


def _write(path, value):
	with io.open(path, "w", encoding="utf-8", newline="\n") as f:
		f.write(json.dumps(value, ensure_ascii=False, indent=1, sort_keys=True) + "\n")


def _column(cur, schema, table, *names):
	"""The first of `names` the table has, or None."""
	for name in names:
		if not name:
			continue
		cur.execute("""SELECT 1 FROM information_schema.columns
		               WHERE table_schema = %s AND table_name = %s AND column_name = %s""",
		            (schema, table, name))
		if cur.fetchone():
			return name
	return None


def registers(cur, only=None):
	"""Every register with the table its rows sit in, the column naming the recorder, and the
	column dating a row - (code, kind, schema, table, recorder, date). A register whose rows
	name no recorder is left out: nothing can be said about who wrote them."""
	cur.execute("""
		SELECT m.module_cd || '.' || r.register_cd, r.kind,
		       coalesce(j.schema_name, e.schema_name), coalesce(j.db_object, e.db_object),
		       r.recorder_field, coalesce(r.journal_date, r.period_field)
		FROM "dForge".register r
		JOIN "dForge".module m ON m.module_id = r.module_id
		LEFT JOIN "dForge".entity e ON e.entity_id = r.entity_id
		LEFT JOIN "dForge".entity j ON j.entity_id = r.journal_entity_id
		ORDER BY 1""")
	out = []
	for code, kind, schema, table, recorder, date in cur.fetchall():
		if only and code not in only:
			continue
		if not schema or not table:
			continue
		# 1C's recorder where the rows were loaded; the binding's own field (`source`, which the
		# engine fills) only after it
		recorder = _column(cur, schema, table, "recorder", "recorder_ref", recorder)
		if recorder is None:
			continue
		cur.execute("""SELECT data_type FROM information_schema.columns
		               WHERE table_schema = %s AND table_name = %s AND column_name = %s""", (schema, table, recorder))
		if cur.fetchone()[0] == 'jsonb':
			recorder = "\"%s\"->>'value'" % recorder
		else:
			recorder = '"%s"::text' % recorder
		out.append((code, kind, schema, table, recorder, _column(cur, schema, table, date)))
	return out


def documents(cur):
	"""Every document table in the tenant - one with a `posted` flag and a key named after it -
	as (schema, table, key)."""
	cur.execute("""
		SELECT c.table_schema, c.table_name, c.table_name || '_id'
		FROM information_schema.columns c
		WHERE c.column_name = 'posted'
		  AND EXISTS (SELECT 1 FROM information_schema.columns k
		              WHERE k.table_schema = c.table_schema AND k.table_name = c.table_name
		                AND k.column_name = c.table_name || '_id')
		ORDER BY 1, 2""")
	return cur.fetchall()


def bindings(cur):
	"""register code -> the document tables (schema.table) a binding column writes it from."""
	cur.execute("""
		SELECT c.params->>'register', e.schema_name || '.' || e.db_object
		FROM "dForge".entity_column c
		JOIN "dForge".entity e ON e.entity_id = c.entity_id
		WHERE c.column_type IN ('A', 'L') AND c.params->>'register' IS NOT NULL""")
	out = {}
	for register, table in cur.fetchall():
		out.setdefault(register, set()).add(table)
	return out


def measure(pg, since, only=None):
	"""{register: {"kind", "rows", "types": {table: {"docs", "rows"}}}} for rows dated from
	`since` (all of them when the register keeps no date)."""
	cur = pg.cursor()
	docs = documents(cur)
	out = {}
	for code, kind, schema, table, recorder, date in registers(cur, only):
		window = ' WHERE "%s" >= %%(since)s' % date if date else ""
		cur.execute('DROP TABLE IF EXISTS coverage_rec')
		cur.execute('CREATE TEMP TABLE coverage_rec AS SELECT %s AS recorder, count(*) AS n FROM "%s"."%s"%s GROUP BY 1'
		            % (recorder, schema, table, window), {"since": since})
		cur.execute("SELECT count(*), coalesce(sum(n), 0) FROM coverage_rec")
		recorders, rows = cur.fetchone()
		types = {}
		if rows:
			cur.execute("CREATE INDEX ON coverage_rec (recorder)")
			for dschema, dtable, key in docs:
				cur.execute('SELECT count(*), coalesce(sum(r.n), 0) FROM coverage_rec r JOIN "%s"."%s" d ON d."%s"::text = r.recorder'
				            % (dschema, dtable, key))
				n, total = cur.fetchone()
				if n:
					types["%s.%s" % (dschema, dtable)] = {"docs": int(n), "rows": int(total)}
			known = sum(t["rows"] for t in types.values())
			if rows - known:
				types["(no document)"] = {"docs": None, "rows": int(rows - known)}
		out[code] = {"kind": kind, "rows": int(rows), "types": types}
	return out


def report(measured, bound, engine, show_all=False, previous=None):
	for code in sorted(measured):
		reg = measured[code]
		if not reg["rows"]:
			continue
		tables = bound.get(code, set())
		covered = sum(t["rows"] for name, t in reg["types"].items() if name in tables)
		print("\n%s (%s) - %s rows, %s by bound types (%.1f%%)" % (
			code, reg["kind"], _n(reg["rows"]), _n(covered), 100.0 * covered / reg["rows"]))
		before = (previous or {}).get(code, {}).get("types", {})
		listed = sorted(reg["types"].items(), key=lambda kv: -kv[1]["rows"])
		for name, t in listed:
			if not show_all and name in tables and len(listed) > 12:
				continue
			mark = "bound" if name in tables else "-"
			checks = engine.get(name, {})
			check = "  ".join("%s %d/%d %s" % (k, v["equal"], v["checked"], v["date"]) for k, v in sorted(checks.items()))
			moved = ""
			if name in before and before[name]["rows"] != t["rows"]:
				moved = "  (was %s)" % _n(before[name]["rows"])
			print("  %-58s %-6s docs %8s  rows %11s%s  %s" % (
				name, mark, _n(t["docs"]) if t["docs"] is not None else "", _n(t["rows"]), moved, check))
		if not show_all and len(listed) > 12:
			hidden = [n for n, _ in listed if n in tables]
			if hidden:
				print("  ... and %d bound types (--all lists them)" % len(hidden))


def _n(value):
	return "{:,}".format(value)


def main():
	parser = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
	parser.add_argument("registers", nargs="*", help="register codes (module.register); every one when omitted")
	parser.add_argument("--since", help="the window's first date (default: 365 days back)")
	parser.add_argument("--all", action="store_true", help="list bound types too where a register has many")
	parser.add_argument("--save", action="store_true", help="keep this run as a snapshot")
	args = parser.parse_args()
	since = args.since or (datetime.date.today() - datetime.timedelta(days=365)).isoformat()

	migrate.load_env()
	pg = migrate.pg_connect()
	pg.autocommit = True
	print("window from %s" % since)
	measured = measure(pg, since, set(args.registers) or None)
	bound = bindings(pg.cursor())
	engine = _read(ENGINE) or {}

	previous = None
	if os.path.isdir(FOLDER):
		snaps = sorted(n for n in os.listdir(FOLDER) if n[:4].isdigit() and n.endswith(".json"))
		for name in reversed(snaps):
			snap = _read(os.path.join(FOLDER, name))
			if snap and snap.get("since") == since:
				previous = snap["registers"]
				print("compared with the snapshot %s" % name)
				break
	report(measured, bound, engine, args.all, previous)

	if args.save:
		if not os.path.isdir(FOLDER):
			os.makedirs(FOLDER)
		path = os.path.join(FOLDER, datetime.date.today().isoformat() + ".json")
		_write(path, {"since": since, "registers": measured,
		              "bound": dict((k, sorted(v)) for k, v in bound.items())})
		print("\nsaved %s" % path)
	return 0


if __name__ == "__main__":
	sys.exit(main())
