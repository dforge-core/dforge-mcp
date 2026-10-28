#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Rebuild a balance register's state from its journal, and check it against 1C's totals.

A dForge `balance` register keeps a running total in a STATE entity and its movements in a
JOURNAL. A port loads the movements - they are 1C's rows - but 1C has no state table to copy:
it keeps per-period totals of its own (`_AccumRgT`) and sums on every read. The platform
does not seed a state from a journal either: posting moves both together, and nothing here
is posted. So this does it, as one idempotent statement per register:

    state := SUM(resource * journalDirection) GROUP BY dimensions, the non-zero tuples only

A zero tuple is left out because a zero row and no row answer `getBalance` alike, and 1C's
own Остатки does not return one either. The state's key is minted from the tuple itself
(md5 -> uuid), so a re-run lands on the same keys rather than reshuffling them.

    python tools/1c.py seedstate run [module ...]      # rebuild every journalled balance state
    python tools/1c.py seedstate check [module ...]    # state against its journal, no writes
    python tools/1c.py seedstate verify [module ...]   # state against 1C's current totals
    python tools/1c.py seedstate verify --asof 2026-08 # as-of read against 1C's month row
    python tools/1c.py seedstate probe [module ...]    # the platform's getBalance against 1C

Which registers: every `kind: "balance"` register in the tenant that names both an entity
and a journal with a `journalDirection` - read from `"dForge".register`, so nothing here
names a register. `run` refuses a journal with a row whose direction is not +1/-1: the
loader stamps it (`migrate.record_kind`), and a NULL would drop the row from the sum.

`verify` reads the journal's 1C table from the column map, finds its totals table through
DBNames (the `AccumRgT` entry beside the `AccumRg` one), and reads the CURRENT totals - the
rows at the table's last `_Period` - by a seek on the clustered index, summing on this side.
No GROUP BY runs on the server, whose tempdb has no room for one.

The writes run with `session_replication_role = 'replica'`, as the loader's do: the state
table carries the audit trigger, and 5,000 rows of "inserted" history describe nothing.
"""
from __future__ import print_function

import argparse
import codecs
import collections
import datetime
import decimal
import json
import os
import sys

import attrs
import migrate
import store

Register = collections.namedtuple("Register", [
	"module", "code", "state", "journal", "journal_entity", "direction", "date",
	"dimensions", "resources", "key", "key_type", "resource_names"])


def q(name):
	return '"%s"' % name.replace('"', '""')


def registers(cur, modules):
	cur.execute("""
		SELECT m.module_cd, r.register_cd, se.schema_name, se.db_object,
		       je.schema_name, je.db_object, je.entity_cd,
		       r.journal_direction, r.journal_date, r.dimensions, r.resources
		FROM "dForge".register r
		JOIN "dForge".module m ON m.module_id = r.module_id
		JOIN "dForge".entity se ON se.entity_id = r.entity_id
		JOIN "dForge".entity je ON je.entity_id = r.journal_entity_id
		WHERE r.kind = 'balance' AND r.journal_direction IS NOT NULL
		ORDER BY 1, 2""")
	found = []
	for (module, code, s_schema, s_table, j_schema, j_table, j_entity,
	     direction, date, dims, resources) in cur.fetchall():
		if modules and module not in modules:
			continue
		dims = dims if isinstance(dims, list) else json.loads(dims)
		resources = resources if isinstance(resources, dict) else json.loads(resources)
		fields = [spec["field"] for _, spec in sorted(resources.items())]
		names = [name for name, _ in sorted(resources.items())]
		cur.execute("""
			SELECT a.attname, format_type(a.atttypid, a.atttypmod)
			FROM pg_index i
			JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
			WHERE i.indrelid = %s::regclass AND i.indisprimary""",
			("%s.%s" % (q(s_schema), q(s_table)),))
		key = cur.fetchall()
		if len(key) != 1:
			raise SystemExit("seedstate: %s.%s - the state %s.%s is not keyed by one column"
			                 % (module, code, s_schema, s_table))
		found.append(Register(module, code, "%s.%s" % (q(s_schema), q(s_table)),
		                      "%s.%s" % (q(j_schema), q(j_table)), j_entity,
		                      direction, date, dims, fields, key[0][0], key[0][1], names))
	return found


def summed(reg):
	"""The journal grouped by tuple: dims, then one signed sum per resource."""
	dims = ", ".join(q(d) for d in reg.dimensions)
	sums = ", ".join("COALESCE(SUM(%s * %s), 0) AS %s" % (q(f), q(reg.direction), q(f))
	                 for f in reg.resources)
	return "SELECT %s, %s FROM %s GROUP BY %s" % (dims, sums, reg.journal, dims)


def nonzero(alias, reg):
	return " OR ".join("%s.%s <> 0" % (alias, q(f)) for f in reg.resources)


def unstamped(cur, reg):
	cur.execute("SELECT count(*) FILTER (WHERE %s IS NULL OR %s NOT IN (1, -1)),"
	            " count(*) FILTER (WHERE %s IS NULL), count(*) FROM %s"
	            % (q(reg.direction), q(reg.direction), q(reg.date), reg.journal))
	return cur.fetchone()


def seed(pg, reg):
	cur = pg.cursor()
	bad, undated, rows = unstamped(cur, reg)
	if bad:
		raise SystemExit("seedstate: %s.%s - %d of %d journal rows carry no direction (+1/-1);"
		                 " reload the journal with its direction transform first"
		                 % (reg.module, reg.code, bad, rows))
	if reg.key_type == "uuid":
		# The tuple is the key: md5 over the quoted values, so NULL and '' stay apart.
		parts = " || '|' || ".join("quote_nullable(g.%s)" % q(d) for d in reg.dimensions)
		key = "md5('%s|' || %s)::uuid" % (reg.state.replace("'", "''"), parts)
	elif reg.key_type == "bigint":
		key = '"dForge".next_id()'
	else:
		raise SystemExit("seedstate: %s.%s - a state key of type %s cannot be minted here"
		                 % (reg.module, reg.code, reg.key_type))
	columns = [reg.key] + reg.dimensions + reg.resources
	cur.execute("SET LOCAL session_replication_role = 'replica'")
	cur.execute("DELETE FROM %s" % reg.state)
	cur.execute("INSERT INTO %s (%s) SELECT %s, %s FROM (%s) g WHERE %s"
	            % (reg.state, ", ".join(q(c) for c in columns), key,
	               ", ".join("g.%s" % q(c) for c in reg.dimensions + reg.resources),
	               summed(reg), nonzero("g", reg)))
	written = cur.rowcount
	pg.commit()
	return rows, written, undated


def drift(cur, reg):
	"""Rows the state and the journal's sum do not share, counted from both sides.

	A set difference rather than a FULL JOIN: the dimensions hold NULLs, which only
	IS NOT DISTINCT FROM matches, and Postgres refuses that as a FULL JOIN condition.
	EXCEPT treats two NULLs as the same value and compares numerics by value.
	"""
	columns = ", ".join(q(c) for c in reg.dimensions + reg.resources)
	journal = "SELECT %s FROM (%s) g WHERE %s" % (columns, summed(reg), nonzero("g", reg))
	# A zero state row is left out as the seed leaves it out: posting keeps the row it created
	# when a tuple returns to zero, and a zero row and no row answer `getBalance` alike.
	state = "SELECT %s FROM %s s WHERE %s" % (columns, reg.state, nonzero("s", reg))
	cur.execute("SELECT (SELECT count(*) FROM (%s EXCEPT ALL %s) a)"
	            " + (SELECT count(*) FROM (%s EXCEPT ALL %s) b)"
	            % (journal, state, state, journal))
	return cur.fetchone()[0]


# --------------------------------------------------------------------------- 1C side

def totals_table(table):
	"""`_AccumRg16999` -> `_AccumRgT17010`: the same object's AccumRgT entry in DBNames."""
	with codecs.open(os.path.join(attrs.OUT, "dbnames.json"), "r", "utf-8") as f:
		entries = json.load(f)["entries"]
	guid = next((e["guid"] for e in entries if e["physical"] == table), None)
	found = [e["physical"] for e in entries
	         if e["guid"] == guid and e["type"] == "AccumRgT"]
	return found[0] if found else None


def one_c_balance(export, pg, reg, mapping, source, period=None):
	"""(totals table, period, {tuple: resources}) - 1C's totals at a period, non-zero only.

	No period means the table's last one: 5999-11-01, where 1C keeps its CURRENT totals. A
	month row `P` holds the balance at the START of P - measured, not assumed: it equals the
	platform's as-of read at the end of the month before, on every month compared.
	"""
	mapped = mapping.get(reg.module, {}).get(reg.journal_entity)
	if not mapped:
		raise SystemExit("seedstate: %s.%s - the column map has no source for %s"
		                 % (reg.module, reg.code, reg.journal_entity))
	table = totals_table(mapped["table"])
	if not table:
		raise SystemExit("seedstate: %s has no totals table in DBNames" % mapped["table"])
	if table not in store.manifest()["tables"]:
		# Totals are derived, so a default export leaves them out (dump1c.DERIVED).
		raise SystemExit("seedstate: %s's totals %s are not in the export - `1c.py dump1c data %s`"
		                 % (mapped["table"], table, table))
	schema, name = [p.strip('"') for p in reg.journal.split(".")]
	types = dict((c[0], c[1]) for c in migrate.table_columns(pg, schema, name))
	held = source[mapped["table"]]["columns"]
	transforms = mapped.get("transforms") or {}

	columns, converters = [], []
	for ours in reg.dimensions + reg.resources:
		physical = mapped["columns"][ours]
		columns.append(physical)
		if ours in transforms:
			converters.append(migrate.TRANSFORMS[transforms[ours]])
		else:
			converters.append(migrate.converter(types[ours], held[physical]["type"]))

	if period is None:
		export.execute("SELECT MAX(_Period) FROM %s" % store.quote(table))
		period = export.fetchone()[0]
	export.execute("SELECT %s FROM %s WHERE _Period = ?"
	              % (", ".join(store.quote(c) for c in columns), store.quote(table)), period)
	width = len(reg.dimensions)
	balance = collections.defaultdict(lambda: [decimal.Decimal(0)] * len(reg.resources))
	for row in export.fetchall():
		values = [normal(f(v), types[c])
		          for f, v, c in zip(converters, row, reg.dimensions + reg.resources)]
		held_now = balance[tuple(values[:width])]
		for i, value in enumerate(values[width:]):
			held_now[i] += decimal.Decimal(value or 0)
	return table, period, dict((k, v) for k, v in balance.items() if any(v))


def normal(value, pg_type):
	"""One value as psycopg2 returns it for a column of that type."""
	if value is None:
		return None
	if pg_type == "date" and isinstance(value, datetime.datetime):
		return value.date()
	if pg_type in ("numeric", "integer", "bigint") and not isinstance(value, bool):
		return decimal.Decimal(str(value))
	return value


def state_balance(pg, reg):
	cur = pg.cursor()
	cur.execute("SELECT %s, %s FROM %s"
	            % (", ".join(q(d) for d in reg.dimensions),
	               ", ".join(q(f) for f in reg.resources), reg.state))
	width = len(reg.dimensions)
	return dict((tuple(normal(v, None) if not isinstance(v, decimal.Decimal) else v
	                   for v in row[:width]),
	             [decimal.Decimal(v or 0) for v in row[width:]])
	            for row in cur.fetchall())


def as_of_balance(pg, reg, until):
	"""What `getBalance(asOf)` answers for the day before `until`: the state minus every
	journal row dated on or after it (RegisterReader.GetBalance), per tuple, non-zero only."""
	dims = ", ".join(q(d) for d in reg.dimensions)
	cur = pg.cursor()
	cur.execute("""SELECT %s, %s FROM (
		SELECT %s, %s FROM %s
		UNION ALL
		SELECT %s, %s FROM %s WHERE %s >= %%s) u GROUP BY %s""" % (
		dims, ", ".join("SUM(%s)" % q(f) for f in reg.resources),
		dims, ", ".join(q(f) for f in reg.resources), reg.state,
		dims, ", ".join("-%s * %s" % (q(f), q(reg.direction)) for f in reg.resources),
		reg.journal, q(reg.date), dims), (until,))
	width = len(reg.dimensions)
	out = {}
	for row in cur.fetchall():
		values = [decimal.Decimal(v or 0) for v in row[width:]]
		if any(values):
			out[tuple(row[:width])] = values
	return out


def verify(pg, reg, mapping, source, export, month=None):
	"""The state against 1C's current totals, or - given a month - the as-of read at its
	end against 1C's totals row for the month after."""
	if month:
		year, number = [int(p) for p in month.split("-")]
		until = datetime.date(year + number // 12, number % 12 + 1, 1)
		period = datetime.datetime(until.year + store.year_offset(), until.month, 1)
		table, period, theirs = one_c_balance(export, pg, reg, mapping, source, period)
		ours = as_of_balance(pg, reg, until)
	else:
		table, period, theirs = one_c_balance(export, pg, reg, mapping, source)
		ours = state_balance(pg, reg)
	both = set(theirs) & set(ours)
	differ = [k for k in both if theirs[k] != ours[k]]
	only_1c = set(theirs) - set(ours)
	only_ours = set(ours) - set(theirs)
	print("%-28s %-15s %s  1C %6d  state %6d  equal %6d  differ %d  only 1C %d  only state %d"
	      % ("%s.%s" % (reg.module, reg.code), table, period.strftime("%Y-%m-%d"),
	         len(theirs), len(ours), len(both) - len(differ), len(differ),
	         len(only_1c), len(only_ours)))
	for k in sorted(differ, key=str)[:5]:
		print("    differ  %s  1C %s  state %s" % (k, theirs[k], ours[k]))
	for k in sorted(only_1c, key=str)[:5]:
		print("    only 1C %s  %s" % (k, theirs[k]))
	for k in sorted(only_ours, key=str)[:5]:
		print("    only us %s  %s" % (k, ours[k]))
	return not (differ or only_1c or only_ours)


# --------------------------------------------------------------------------- the platform

# `verify` checks the state by a formula written to imitate RegisterReader. `probe` asks
# RegisterReader itself, through `modules/register-probe` (one batch action calling
# getBalance per request), and compares each answer with 1C's totals summed client-side.

PROBE_MONTHS = ("2019-03", "2021-06", "2023-12", "2025-12", "2026-07", "2026-08")
PROBE_BATCH = 100


def month_end(month):
	"""'2026-07' -> (2026-07-31, the 1C totals period holding the balance at that end)."""
	year, number = [int(p) for p in month.split("-")]
	start = datetime.date(year + number // 12, number % 12 + 1, 1)
	return (start - datetime.timedelta(days=1),
	        datetime.datetime(start.year + store.year_offset(), start.month, 1))


def sample(reg, tuples, size):
	"""Tuples worth asking about, deterministically: the largest, the negative, the ones
	holding a NULL dimension, and an even spread over the rest."""
	ordered = sorted(tuples, key=str)
	picked = []

	def take(items, n):
		for t in items:
			if n <= 0:
				break
			if t not in picked:
				picked.append(t)
				n -= 1

	take(sorted(ordered, key=lambda t: -abs(tuples[t][0])), size // 4)
	take([t for t in ordered if any(v < 0 for v in tuples[t])], size // 4)
	take([t for t in ordered if None in t], size // 4)
	step = max(1, len(ordered) // max(1, size - len(picked)))
	take(ordered[::step], size - len(picked))
	return picked


def jsonable(value):
	if isinstance(value, decimal.Decimal):
		return float(value)
	if isinstance(value, (datetime.date, datetime.datetime)):
		return value.isoformat()
	return value


def requests_for(reg, picked):
	"""Dimension filters: each full tuple (a NULL dimension left out, since a read cannot
	ask for NULL by equality), the same tuple with each dimension in turn left out, the
	first dimension alone, and nothing at all - the register's grand total."""
	seen, out = set(), []

	def add(dims):
		key = tuple(sorted((k, str(v)) for k, v in dims.items()))
		if key not in seen:
			seen.add(key)
			out.append(dims)

	add({})
	for t in picked:
		full = dict((d, v) for d, v in zip(reg.dimensions, t) if v is not None)
		add(full)
		for d in list(full):
			add(dict((k, v) for k, v in full.items() if k != d))
		first = reg.dimensions[0]
		if first in full:
			add({first: full[first]})
	return out


def expected(reg, theirs, dims):
	"""1C's answer to a dimension filter: every tuple it matches, summed."""
	index = [(reg.dimensions.index(d), v) for d, v in dims.items()]
	total = [decimal.Decimal(0)] * len(reg.resources)
	for t, values in theirs.items():
		if all(t[i] == v for i, v in index):
			total = [a + b for a, b in zip(total, values)]
	return total


def probe(pg, reg, mapping, source, export, size, months):
	import posting
	cur = pg.cursor()
	cur.execute("""SELECT a.action_id FROM "dForge".action a
		JOIN "dForge".module m ON m.module_id = a.module_id
		WHERE m.module_cd = 'register-probe' AND a.action_cd = 'balances'""")
	found = cur.fetchone()
	if not found:
		raise SystemExit("seedstate probe: install modules/register-probe first")
	action = found[0]
	cur.execute("""SELECT f.folder_id FROM "dForge".folder f
		JOIN "dForge".module m ON m.module_id = f.module_id
		WHERE m.module_cd = 'production' ORDER BY 1 LIMIT 1""")
	folder = str(cur.fetchone()[0])
	# Batch mode runs only over records, so one movement is handed in and not touched.
	cur.execute("SELECT output_shop_id::text FROM production.output_shop LIMIT 1")
	record = {"output_shop_id": cur.fetchone()[0]}
	jwt = posting.token()

	dates = [(None, None)] + [month_end(m) for m in months]
	theirs = {}
	for as_of, period in dates:
		theirs[as_of] = one_c_balance(export, pg, reg, mapping, source, period)[2]
	pool = {}
	for got in theirs.values():
		for t, v in got.items():
			pool.setdefault(t, v)
	asked = requests_for(reg, sample(reg, pool, size))

	register = "%s.%s" % (reg.module, reg.code)
	compared = equal = nonzero = 0
	failures = []
	for as_of, _ in dates:
		batch = [{"register": register, "dims": dict((k, jsonable(v)) for k, v in d.items()),
		          "asOf": as_of.isoformat() if as_of else None} for d in asked]
		answers = []
		for i in range(0, len(batch), PROBE_BATCH):
			reply = posting.call("action.execute", {
				"actionId": action, "entity": "production.output_shop", "keys": [record],
				"params": {"requests": json.dumps(batch[i:i + PROBE_BATCH])}}, folder, jwt)
			messages = (reply.get("result") or {}).get("messages") or []
			if len(messages) != 1 or messages[0].get("level") != "info":
				raise SystemExit("seedstate probe: %s" % json.dumps(reply)[:2000])
			answers.extend(json.loads(messages[0]["text"]))
		for dims, answer in zip(asked, answers):
			compared += 1
			want = expected(reg, theirs[as_of], dims)
			nonzero += any(want)
			if "error" in answer:
				failures.append((as_of, dims, want, answer["error"]))
				continue
			got = [decimal.Decimal(str(answer["ok"].get(n, 0))) for n in reg.resource_names]
			# The action hands numbers back through JS doubles; compare to their precision.
			if all(abs(g - w) <= abs(w) * decimal.Decimal("1e-12") + decimal.Decimal("1e-6")
			       for g, w in zip(got, want)):
				equal += 1
			else:
				failures.append((as_of, dims, want, got))
	# 1C's empty date is held as 0001-01-01 (`since_beginning`), and the DSL turns that
	# string into DateTime.MinValue, which Npgsql binds as -infinity: such a tuple reads as
	# zero. The platform's defect, not the seed's - counted apart so it cannot hide another.
	empty_date = [f for f in failures if datetime.date(1, 1, 1) in f[1].values()]
	print("%-28s %3d filters x %d dates  %5d compared (%d non-zero)  %5d equal  %d differ%s"
	      % (register, len(asked), len(dates), compared, nonzero, equal, len(failures),
	         " (%d on a 0001-01-01 dimension)" % len(empty_date) if empty_date else ""))
	for as_of, dims, want, got in [f for f in failures if f not in empty_date][:10]:
		print("    %s %s  1C %s  platform %s" % (as_of or "now", dims, want, got))
	return not failures


def main():
	migrate.load_env()
	ap = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
	ap.add_argument("command", choices=("run", "check", "verify", "probe"))
	ap.add_argument("module", nargs="*", help="limit to these modules")
	ap.add_argument("--asof", metavar="YYYY-MM",
	                help="verify: the as-of read at the end of this month instead of now")
	ap.add_argument("--sample", type=int, default=24, metavar="N",
	                help="probe: tuples per register (each also asked with dimensions left out)")
	args = ap.parse_args()

	pg = migrate.pg_connect()
	found = registers(pg.cursor(), set(args.module))
	if not found:
		print("no journalled balance register%s" % (" in " + ", ".join(args.module)
		                                             if args.module else ""))
		return 0
	clean = True
	if args.command == "run":
		print("%-28s %10s %8s %s" % ("register", "journal", "state", ""))
		for reg in found:
			rows, written, undated = seed(pg, reg)
			print("%-28s %10d %8d %s" % ("%s.%s" % (reg.module, reg.code), rows, written,
			                             "%d undated" % undated if undated else ""))
	elif args.command == "check":
		cur = pg.cursor()
		for reg in found:
			bad, undated, rows = unstamped(cur, reg)
			off = drift(cur, reg)
			clean = clean and not (bad or off)
			print("%-28s journal %8d  unstamped %d  undated %d  state off by %d tuple(s)"
			      % ("%s.%s" % (reg.module, reg.code), rows, bad, undated, off))
	else:
		mapping, source = migrate.column_map(), migrate.source_schema()
		export = migrate.source_connect().cursor()
		for reg in found:
			if args.command == "probe":
				clean = probe(pg, reg, mapping, source, export, args.sample,
				              [args.asof] if args.asof else PROBE_MONTHS) and clean
			else:
				clean = verify(pg, reg, mapping, source, export, args.asof) and clean
	return 0 if clean else 1


if __name__ == "__main__":
	sys.exit(main())
