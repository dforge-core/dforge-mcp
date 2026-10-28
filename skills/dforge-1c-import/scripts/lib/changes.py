# -*- coding: utf-8 -*-
"""
Bring an MS SQL export up to date with what 1C changed since it was taken, reading only
the change: `dump1c data --changes`. A full export of a large infobase is an hour and a
half (313 M rows); the change of a few days is minutes, and the delta loader reads the
export either way.

    python 1c.py dump1c data --changes                    # since the export's own mark
    python 1c.py dump1c data --changes --since 2026-09-17 # as if exported that day
    python 1c.py dump1c data --changes --since 0x...      # from a given rowversion

What 1C gives to detect change is the same as `delta` reads, decided per TABLE here from
the schema dump alone - the export knows nothing of the column map:

    object     `_IDRRef` and a `_Version` rowversion (catalogs, documents, charts):
               the rows at or above the mark replace theirs; a key 1C no longer holds
               is a deletion. 1C writes an object whole, so this is the whole of its change.
    lines      a tabular part, `_Document12_VT34`, owned through `_Document12_IDRRef`:
               the lines of a changed owner are replaced, those of a vanished one dropped.
    movements  a register with `_RecorderRRef`: the movements of a changed recorder are
               replaced, read through the recorder index; those of a vanished one dropped.
               With `_RecorderTRef` only the recorder types the register holds are asked.
    whole      anything else - an independent information register, totals, constants:
               read again in full.

The mark is the export's oldest horizon (or `--since`); the new one is
`MIN_ACTIVE_ROWVERSION()` taken before anything is read, so a change made during the run
is read again by the next one, never lost. Each table's file is rebuilt in place - what
it held, less every replaced or deleted key, plus the fresh rows - so after a run the
export is what a full one would have been, and `export.json` keeps the run in `changes`.

A table whose columns changed (a configuration update) is read again in full: its old
rows no longer have the shape the new ones do. A row changed below the mark is not found:
the mark has to be one every earlier read was taken after.
"""
from __future__ import print_function

import datetime
import os
import re
import sys
import time

import dump1c

OBJECT = re.compile(r"^_(Document|Reference|Acc|Chrc|CKinds|Node|BPr|Task)\d+$")
OWNER = re.compile(r"^(_(?:Document|Reference|Acc|Chrc|CKinds|Node|BPr|Task)\d+)_IDRRef$")
KEYS_IN_LIST = 500
# Registers whose entries 1C switches on and off without writing the recorder.
ACTIVE = re.compile(r"^_AccRg\d+$")


def hexed(raw):
	return "0x" + bytes(raw).hex()


def classify(name, columns, schema):
	"""(kind, detail) for one table, from its columns and its neighbours' - see the docstring."""
	by = dict((c["column"], c) for c in columns)
	versioned = (by.get("_Version") or {}).get("type") == "timestamp"
	if versioned and "_IDRRef" in by:
		return "object", None
	for column in by:
		match = OWNER.match(column)
		if match and name.startswith(match.group(1) + "_") and match.group(1) in schema:
			return "lines", (column, match.group(1))
	if "_RecorderRRef" in by:
		return "movements", "_RecorderTRef" in by
	return "whole", None


class Objects(object):
	"""Every object key 1C holds, and which of them changed at or after the mark.

	Two reads per table rather than one: the key alone comes off the narrowest index, while
	`_Version` lives only in the clustered one - measured on 2.7 M keys, 90 s for both
	together, a few seconds apart.
	"""

	def __init__(self, source, schema, mark):
		started = time.time()
		self.alive, self.changed = {}, {}
		for name, (columns, _) in sorted(schema.items()):
			if classify(name, columns, schema)[0] != "object":
				continue
			self.changed[name] = [bytes(k) for k in source.column(
				"SELECT _IDRRef FROM [%s] WHERE _Version >= %s" % (name, hexed(mark)))]
			self.alive[name] = [bytes(k) for k in source.column("SELECT _IDRRef FROM [%s]" % name)]
		self.seconds = time.time() - started
		self._arrow = {}

	def alive_of(self, name=None):
		"""The live keys of one object table - or of every one, for recorders - as Arrow,
		built once: 2.7 M keys per register otherwise."""
		import pyarrow as pa
		if name not in self._arrow:
			keys = self.alive[name] if name else [k for ks in self.alive.values() for k in ks]
			self._arrow[name] = pa.array(keys, type=pa.binary())
		return self._arrow[name]

	def all_changed(self):
		return [k for keys in self.changed.values() for k in keys]


def since(source, schema, day):
	"""A mark for a run as if the export had been taken on `day`: the lowest `_Version` of
	any document dated on or after it. Everything 1C wrote from about then on is above it."""
	if day.startswith("0x"):
		return bytes.fromhex(day[2:])
	shifted = "%04d-%s" % (int(day[:4]) + source.year_offset, day[5:])
	lowest = None
	for name, (columns, _) in schema.items():
		by = dict((c["column"], c) for c in columns)
		if not name.startswith("_Document") or not OBJECT.match(name) or "_Date_Time" not in by \
				or (by.get("_Version") or {}).get("type") != "timestamp":
			continue
		found = source.column("SELECT MIN(_Version) FROM [%s] WHERE _Date_Time >= '%s'" % (name, shifted))
		if found and found[0] is not None and (lowest is None or bytes(found[0]) < lowest):
			lowest = bytes(found[0])
	if lowest is None:
		raise SystemExit("changes: no document dated on or after %s" % day)
	return lowest


def in_lists(column, keys):
	for at in range(0, len(keys), KEYS_IN_LIST):
		yield "%s IN (%s)" % (column, ", ".join(hexed(k) for k in keys[at:at + KEYS_IN_LIST]))


def recorder_type(source, register, path, objects, cache={}):
	"""The one table a TRef-less register's recorders come from, by one recorder it holds."""
	import duckdb
	con = duckdb.connect()
	sample = con.execute("SELECT _RecorderRRef FROM read_parquet(?) LIMIT 1", [path]).fetchone()
	con.close()
	if not sample:
		return None
	key = bytes(sample[0])
	if key not in cache:
		cache[key] = next((name for name in sorted(objects.alive, key=lambda n: not n.startswith("_Document"))
		                   if source.column("SELECT COUNT(*) FROM [%s] WHERE _IDRRef = %s"
		                                    % (name, hexed(key)))[0]), None)
	return cache[key]


class Plan(object):
	"""What one table's rebuild reads fresh and which of its old rows it drops."""

	def __init__(self, name, kind):
		self.name, self.kind = name, kind
		self.wheres = []        # T-SQL conditions; each one query against 1C
		self.column = None      # the key column old rows are judged by
		self.replaced = []      # old rows with these keys go: they are read fresh
		self.alive = None       # old rows whose key is not among these go: 1C deleted them
		self.whole = False
		self.owners = 0
		self.toggled = 0        # recorders read again because their entries were switched
		self.switched = {}      # {recorder table number: [key hex]} of those, for `delta`


def plan(source, name, columns, schema, objects, path):
	kind, detail = classify(name, columns, schema)
	p = Plan(name, kind)
	if kind == "object":
		p.column, p.replaced, p.alive = "_IDRRef", objects.changed[name], objects.alive_of(name)
		p.wheres = list(in_lists("_IDRRef", p.replaced))
	elif kind == "lines":
		p.column, owner = detail
		p.replaced, p.alive = objects.changed[owner], objects.alive_of(owner)
		p.wheres = list(in_lists(p.column, p.replaced))
	elif kind == "movements":
		p.column, p.alive = "_RecorderRRef", objects.alive_of()
		if detail:
			# Only the recorder types this register holds, off the recorder index.
			numbers = set(int.from_bytes(bytes(t), "big") for t in
			              source.column("SELECT DISTINCT _RecorderTRef FROM [%s]" % name))
			for number in sorted(numbers):
				keys = objects.changed.get("_Document%d" % number) or []
				p.replaced += keys
				p.wheres += ["_RecorderTRef = 0x%08x AND %s" % (number, c)
				             for c in in_lists("_RecorderRRef", keys)]
		else:
			owner = recorder_type(source, name, path, objects) if os.path.exists(path) else None
			keys = objects.changed[owner] if owner else objects.all_changed()
			p.replaced = keys
			p.wheres = list(in_lists("_RecorderRRef", keys))
	else:
		p.whole = True
	if kind == "movements" and ACTIVE.match(name) and os.path.exists(path) \
			and set(["_Active", "_RecorderTRef"]) <= set(c["column"] for c in columns):
		already = set(p.replaced)
		found = [(n, k) for n, k in switched(source, name, path) if k not in already]
		toggled = [k for _, k in found]
		p.replaced = p.replaced + toggled
		p.wheres = p.wheres + list(in_lists("_RecorderRRef", toggled))
		p.toggled = len(toggled)
		# `delta` finds a changed recorder by `_Version` too, so it is told these by name.
		for number, key in found:
			p.switched.setdefault(str(number), []).append(key.hex())
	p.owners = len(p.replaced)
	return p


def switched(source, name, path):
	"""Recorders whose entries were switched on or off since the export.

	`ПереключитьАктивностьПроводок` (the journal's "switch entries on/off") writes a
	recorder's entry set again with another `_Active` and leaves the document alone, so
	its `_Version` does not move and nothing else here would see it. The count of inactive
	entries per recorder, 1C's against the export's, does: a scan of the register, which on
	the ledger of 24 M entries is seconds, and only accounting registers have the command.
	"""
	import duckdb
	now = dict(((int.from_bytes(bytes(t), "big"), bytes(k)), n) for t, k, n in source.triples(
		"SELECT _RecorderTRef, _RecorderRRef, COUNT(*) FROM [%s] WHERE _Active = 0x00"
		" GROUP BY _RecorderTRef, _RecorderRRef" % name))
	con = duckdb.connect()
	held = dict(((int.from_bytes(bytes(t), "big"), bytes(k)), n) for t, k, n in con.execute(
		"SELECT _RecorderTRef, _RecorderRRef, COUNT(*) FROM read_parquet(?)"
		" WHERE _Active = from_hex('00') GROUP BY _RecorderTRef, _RecorderRRef", [path]).fetchall())
	con.close()
	return sorted(r for r in set(now) | set(held) if now.get(r) != held.get(r))


def same_shape(path, arrow):
	"""Do the file's columns still have the names and types the table has now?"""
	import pyarrow.parquet as pq
	if not os.path.exists(path):
		return False
	held = pq.read_schema(path)
	return [(f.name, f.type) for f in held] == [(f.name, f.type) for f in arrow]


def rebuild(source, p, columns, path):
	"""Old rows less the replaced and the deleted, plus the fresh: the file, rewritten."""
	import duckdb
	import pyarrow as pa
	arrow = dump1c.arrow_schema(columns)
	names = [c["column"] for c in columns]
	fresh = [dump1c.arrow_batch(arrow, columns, batch)
	         for where in p.wheres for batch in source.rows(p.name, names, dump1c.CHUNK, where)]
	fresh = pa.concat_tables(fresh) if fresh else arrow.empty_table()
	con = duckdb.connect()
	con.register("fresh", fresh)
	con.register("replaced", pa.table({"k": pa.array(p.replaced, type=pa.binary())}))
	con.register("alive", pa.table({"k": p.alive}))
	key = '"%s"' % p.column
	kept_sql = ("SELECT * FROM read_parquet(?) o WHERE o.%s IN (SELECT k FROM alive)"
	            " AND o.%s NOT IN (SELECT k FROM replaced)" % (key, key))
	before = con.execute("SELECT COUNT(*) FROM read_parquet(?)", [path]).fetchone()[0]
	kept = con.execute("SELECT COUNT(*) FROM (%s)" % kept_sql, [path]).fetchone()[0]
	if not fresh.num_rows and kept == before:
		# Nothing to replace and nothing deleted: the file stands. On a ledger of 100 M
		# rows that is the difference between a lookup and a rewrite.
		con.close()
		return {"fresh": 0, "dropped": 0, "rows": before}
	tmp = path + ".tmp"
	con.execute("COPY (%s UNION ALL SELECT * FROM fresh) TO '%s' (FORMAT PARQUET, COMPRESSION ZSTD)"
	            % (kept_sql, tmp.replace("\\", "/").replace("'", "''")), [path])
	con.close()
	os.replace(tmp, path)
	return {"fresh": fresh.num_rows, "dropped": before - kept, "rows": kept + fresh.num_rows}


def run(source, held, schema, args, whole_table):
	"""`dump1c data --changes`. `whole_table(name)` re-exports one table in full."""
	if source.kind != "mssql":
		raise SystemExit("data --changes: a file infobase has no rowversion to read changes by"
		                 " - export it again in full (`dump1c data`)")
	exported = sorted(held["tables"])
	if not exported:
		raise SystemExit("data --changes: nothing exported yet - run `dump1c data` first")
	marks = [held["tables"][t].get("horizon") for t in exported]
	if args.since:
		mark = since(source, schema, args.since)
	elif any(m is None for m in marks):
		raise SystemExit("data --changes: a table was exported without a horizon - use --since")
	else:
		mark = bytes.fromhex(min(marks))
	now = source.horizon()
	started = time.time()
	objects = Objects(source, schema, mark)
	changed = sum(len(k) for k in objects.changed.values())
	print("mark %s, horizon %s: %d object(s) changed, %d alive, read in %.1fs"
	      % (hexed(mark), hexed(now), changed, len(objects.alive_of()), objects.seconds))

	summary, totals = {}, {}
	for at, name in enumerate(exported):
		columns, _ = schema[name]
		path = os.path.join(dump1c.DATA, name + ".parquet")
		t0 = time.time()
		p = plan(source, name, columns, schema, objects, path)
		if not p.whole and not same_shape(path, dump1c.arrow_schema(columns)):
			p.whole, p.kind = True, p.kind + " (reshaped)"
		if p.whole:
			rows = whole_table(name, columns)
			result = {"fresh": rows, "dropped": None, "rows": rows}
		else:
			result = rebuild(source, p, columns, path)
		held["tables"][name].update({"rows": result["rows"], "horizon": now.hex(),
		                             "refreshed": datetime.datetime.now().replace(microsecond=0).isoformat()})
		kind = p.kind.split()[0]
		t = totals.setdefault(kind, [0, 0, 0, 0, 0.0])
		t[0] += 1
		t[1] += p.owners
		t[2] += result["fresh"]
		t[3] += result["dropped"] or 0
		t[4] += time.time() - t0
		if result["fresh"] and not p.whole or result["dropped"]:
			summary[name] = dict(result, kind=p.kind, owners=p.owners, toggled=p.toggled)
		if p.switched:
			summary.setdefault(name, dict(result, kind=p.kind, owners=p.owners, toggled=p.toggled))
			summary[name]["switched"] = p.switched
		sys.stderr.write("\r    %d/%d %-40s" % (at + 1, len(exported), name))
	sys.stderr.write("\r" + " " * 60 + "\r")
	held.setdefault("changes", []).append({
		"from": mark.hex(), "to": now.hex(), "since": args.since,
		"at": datetime.datetime.now().replace(microsecond=0).isoformat(),
		"seconds": round(time.time() - started), "tables": summary})
	print("%-10s %7s %10s %10s %10s %8s" % ("kind", "tables", "keys", "fresh", "dropped", "seconds"))
	for kind in ("object", "lines", "movements", "whole"):
		if kind in totals:
			n, owners, fresh, dropped, seconds = totals[kind]
			print("%-10s %7d %10d %10d %10s %8.0f" % (kind, n, owners, fresh,
			                                          dropped if kind != "whole" else "-", seconds))
	print("%.0fs in all" % (time.time() - started))
