#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Check a register's `totals` cache against its journal, and rebuild it by hand when it is not.

The platform keeps a per-period turnover cache beside a register's journal (registers.md 8.4)
and maintains it at the posting seam: a posted movement is folded in, an unposted one taken
off. A bulk load is not a posting, so the cache does not see it. The platform REBUILDS a cache
only at install, and only when the register gains one or its shape changes
(`RegisterRegistrar.TotalsShapeChanged`); there is no standalone rebuild. So after a load:

    python tools/1c.py totals check [module ...]     # cache against a fresh fold, no writes
    python tools/1c.py totals rebuild [module ...]   # refill it from the journal

**The SQL here is the platform's, transcribed.** `check` is `BuildVerify` and `rebuild` is
`BuildRebuild`, from `dForge.Core/Services/RegisterTotals.cs` (balance / turnover) and
`RegisterAccountTotals.cs` (accounting), with the plan built from `"dForge".register` the way
`RegisterRegistrar.Totals.cs` builds it from the manifest:

- the key is (dimensions, period) - (account, cached dimensions, period) on an accounting
  register, where `totals.dimensions` absent means all of them;
- the period is `date_trunc('<period>', <journalDate>)::date`, in the session's time zone,
  which here is the server's (UTC) exactly as it is for the API's connections;
- a balance resource is split by the stamped direction (`> 0` in, `< 0` out); an accounting
  one by side, and a compound posting is read twice - its debit side under its debit account
  and side dimensions, its credit side under its credit ones - so it folds into two rows;
- a group carrying no resource value (`COUNT(field)` summed to 0) is not written;
- a row missing on either side reads as zeros, so a cached row of zeros is no disagreement.

A drift between this file and the C# is a bug in this file; re-read the two classes when the
platform changes either.

`rebuild` refuses an undated, unkeyed or undirected movement as install does. It differs from
the platform's in HOW it writes, not in what: the platform runs one `DELETE` + `INSERT ...
SELECT ... GROUP BY` inside the install transaction; this reads the same `SELECT` once (one
scan of the journal, autocommitted, nothing locked) and writes the result one year of periods
per transaction, so no transaction holds the cache for the length of a 15 GB scan. The writes
run with `session_replication_role = 'replica'`, as the loader's do: the cache carries the
audit trigger, and thousands of "inserted" rows of history describe nothing.

Which registers: every register in the tenant that declares `totals` - read from
`"dForge".register`, so nothing here names one.
"""
from __future__ import print_function

import argparse
import collections
import json
import sys
import time

import migrate
import transactions

GRANULARITIES = ("day", "month", "quarter", "year")

Plan = collections.namedtuple("Plan", [
	"module", "code", "kind", "journal", "totals", "date", "period", "period_field",
	# balance / turnover
	"direction", "dimensions", "resources",
	# accounting: (column, debit field, credit field) per key column, and per resource
	# (debit journal field, credit journal field, debit cache field, credit cache field)
	"compound", "account", "side_dimensions", "account_resources"])


def q(name):
	if not name or '"' in name:
		raise SystemExit("totals: invalid identifier %r" % (name,))
	return '"%s"' % name


def _json(value):
	if value is None or isinstance(value, (dict, list)):
		return value
	return json.loads(value)


def plans(cur, modules):
	cur.execute("""
		SELECT m.module_cd, r.register_cd, r.kind, r.journal_direction, r.journal_date,
		       r.dimensions, r.resources, r.accounting, r.totals,
		       je.schema_name, je.db_object, te.schema_name, te.db_object
		FROM "dForge".register r
		JOIN "dForge".module m ON m.module_id = r.module_id
		JOIN "dForge".entity je ON je.entity_id = r.journal_entity_id
		JOIN "dForge".entity te ON te.entity_id = r.totals_entity_id
		WHERE r.totals IS NOT NULL
		ORDER BY 1, 2""")
	found = []
	for (module, code, kind, direction, date, dims, resources, accounting, totals,
	     j_schema, j_table, t_schema, t_table) in cur.fetchall():
		if modules and module not in modules:
			continue
		dims, resources = _json(dims) or [], _json(resources) or {}
		accounting, totals = _json(accounting) or {}, _json(totals)
		if totals["period"] not in GRANULARITIES:
			raise SystemExit("totals: %s.%s - granularity %r" % (module, code, totals["period"]))
		journal = "%s.%s" % (q(j_schema), q(j_table))
		cache = "%s.%s" % (q(t_schema), q(t_table))
		cached = totals.get("resources") or {}
		if kind == "accounting":
			compound = accounting.get("lineMode") == "compound"
			sides = accounting.get("sideDimensions") or {}
			account = ((totals["accountField"], accounting["debitAccount"], accounting["creditAccount"])
			           if compound else
			           (totals["accountField"], accounting["account"], accounting["account"]))
			chosen = totals.get("dimensions")
			chosen = dims if chosen is None else chosen
			side_dims = [(d, sides[d]["debitField"], sides[d]["creditField"]) if d in sides
			             else (d, d, d) for d in chosen]
			# Iterated in the declaration's order, as the C# does over def.Resources.
			res = [((spec.get("debitField") or spec.get("field")),
			        (spec.get("creditField") or spec.get("field")),
			        cached[name]["debitField"], cached[name]["creditField"])
			       for name, spec in resources.items()]
			found.append(Plan(module, code, kind, journal, cache, date, totals["period"],
			                  totals["periodField"], None, None, None,
			                  compound, account, side_dims, res))
		else:
			res = [(spec["field"], cached[name]["inField"], cached[name]["outField"])
			       for name, spec in resources.items()]
			found.append(Plan(module, code, kind, journal, cache, date, totals["period"],
			                  totals["periodField"], direction, dims, res,
			                  None, None, None, None))
	return found


def period_start(plan, expression):
	return "date_trunc('%s', %s)::date" % (plan.period, expression)


# --------------------------------------------------------------------------- balance / turnover
# RegisterTotals.cs

def _directed(field, direction, increase):
	return "SUM(%s) FILTER (WHERE %s %s 0)" % (q(field), q(direction), ">" if increase else "<")


def _carried_balance(plan):
	return " + ".join("COUNT(%s)" % q(f) for f, _, _ in plan.resources)


def _balance_unplaceable(plan):
	undated = "%s IS NULL" % q(plan.date)
	unkeyed = " OR ".join("%s IS NULL" % q(d) for d in plan.dimensions) or "false"
	undirected = "%s IS NULL" % q(plan.direction)
	return ("SELECT COUNT(*) FILTER (WHERE %s), COUNT(*) FILTER (WHERE %s), "
	        "COUNT(*) FILTER (WHERE %s) FROM %s WHERE %s OR %s OR %s"
	        % (undated, unkeyed, undirected, plan.journal, undated, unkeyed, undirected))


def _balance_select(plan):
	"""BuildRebuild's SELECT, without its DELETE and INSERT."""
	dims = [q(d) for d in plan.dimensions]
	period = period_start(plan, q(plan.date))
	sums = []
	for field, _, _ in plan.resources:
		sums.append("COALESCE(%s, 0)" % _directed(field, plan.direction, True))
		sums.append("COALESCE(%s, 0)" % _directed(field, plan.direction, False))
	return ("SELECT %s FROM %s GROUP BY %s HAVING %s > 0"
	        % (", ".join(dims + [period] + sums), plan.journal,
	           ", ".join(dims + [period]), _carried_balance(plan)))


def _balance_columns(plan):
	key = [q(d) for d in plan.dimensions] + [q(plan.period_field)]
	cached = [q(c) for _, i, o in plan.resources for c in (i, o)]
	return key, cached


def _balance_verify(plan):
	dims = [q(d) for d in plan.dimensions]
	key, _ = _balance_columns(plan)
	period = period_start(plan, q(plan.date))
	computed = []
	for field, i, o in plan.resources:
		computed.append("COALESCE(%s, 0) AS %s" % (_directed(field, plan.direction, True), q(i)))
		computed.append("COALESCE(%s, 0) AS %s" % (_directed(field, plan.direction, False), q(o)))
	cols = [c for _, i, o in plan.resources for c in (i, o)]
	differences = " OR ".join("COALESCE(c.%s, 0) <> COALESCE(t.%s, 0)" % (q(c), q(c)) for c in cols)
	reported = key + ["COALESCE(c.%s, 0), COALESCE(t.%s, 0)" % (q(c), q(c)) for c in cols]
	return ("WITH c AS (SELECT %s, %s AS %s, %s FROM %s GROUP BY %s, %s HAVING %s > 0) "
	        "SELECT %s FROM c FULL OUTER JOIN %s t USING (%s) WHERE %s"
	        % (", ".join(dims), period, q(plan.period_field), ", ".join(computed), plan.journal,
	           ", ".join(dims), period, _carried_balance(plan),
	           ", ".join(reported), plan.totals, ", ".join(key), differences))


# --------------------------------------------------------------------------- accounting
# RegisterAccountTotals.cs

def _side(plan, source, debit):
	column, dt, ct = plan.account
	columns = ["%s AS %s" % (q(dt if debit else ct), q(column)),
	           "%s AS %s" % (q(plan.date), q(plan.period_field))]
	columns += ["%s AS %s" % (q(d_dt if debit else d_ct), q(d)) for d, d_dt, d_ct in plan.side_dimensions]
	for j_dt, j_ct, c_dt, c_ct in plan.account_resources:
		columns.append("%s AS %s" % (q(j_dt), q(c_dt)) if debit or not plan.compound
		               else "NULL AS %s" % q(c_dt))
		columns.append("%s AS %s" % (q(j_ct), q(c_ct)) if not debit or not plan.compound
		               else "NULL AS %s" % q(c_ct))
	return "SELECT %s FROM %s" % (", ".join(columns), source)


def _sides(plan, source):
	debit = _side(plan, source, True)
	return "%s UNION ALL %s" % (debit, _side(plan, source, False)) if plan.compound else debit


def _account_key(plan):
	return [q(plan.account[0])] + [q(d) for d, _, _ in plan.side_dimensions] + [q(plan.period_field)]


def _account_key_select(plan):
	return ([q(plan.account[0])] + [q(d) for d, _, _ in plan.side_dimensions]
	        + [period_start(plan, q(plan.period_field))])


def _account_cached(plan):
	return [c for _, _, c_dt, c_ct in plan.account_resources for c in (c_dt, c_ct)]


def _carried_account(plan):
	return " + ".join("COUNT(%s)" % q(c) for c in _account_cached(plan))


def _account_unplaceable(plan):
	undated = "%s IS NULL" % q(plan.date)
	columns = [plan.account[1]] + ([plan.account[2]] if plan.compound else [])
	for _, d_dt, d_ct in plan.side_dimensions:
		columns += [d_dt, d_ct] if plan.compound else [d_dt]
	seen, unique = set(), []
	for c in columns:
		if c not in seen:
			seen.add(c)
			unique.append(c)
	unkeyed = " OR ".join("%s IS NULL" % q(c) for c in unique)
	return ("SELECT COUNT(*) FILTER (WHERE %s), COUNT(*) FILTER (WHERE %s), 0 FROM %s WHERE %s OR %s"
	        % (undated, unkeyed, plan.journal, undated, unkeyed))


def _account_select(plan):
	"""BuildRebuild's SELECT, without its DELETE and INSERT."""
	key = _account_key(plan)
	sums = ["COALESCE(SUM(%s), 0)" % q(c) for c in _account_cached(plan)]
	return ("SELECT %s FROM (%s) s GROUP BY %s HAVING %s > 0"
	        % (", ".join(_account_key_select(plan) + sums), _sides(plan, plan.journal),
	           ", ".join(str(i) for i in range(1, len(key) + 1)), _carried_account(plan)))


def _account_verify(plan):
	key = _account_key(plan)
	cols = _account_cached(plan)
	computed = ["COALESCE(SUM(%s), 0) AS %s" % (q(c), q(c)) for c in cols]
	differences = " OR ".join("COALESCE(c.%s, 0) <> COALESCE(t.%s, 0)" % (q(c), q(c)) for c in cols)
	reported = key + ["COALESCE(c.%s, 0), COALESCE(t.%s, 0)" % (q(c), q(c)) for c in cols]
	selected = ["%s AS %s" % (e, k) for e, k in zip(_account_key_select(plan), key)] + computed
	return ("WITH c AS (SELECT %s FROM (%s) s GROUP BY %s HAVING %s > 0) "
	        "SELECT %s FROM c FULL OUTER JOIN %s t USING (%s) WHERE %s"
	        % (", ".join(selected), _sides(plan, plan.journal),
	           ", ".join(str(i) for i in range(1, len(key) + 1)), _carried_account(plan),
	           ", ".join(reported), plan.totals, ", ".join(key), differences))


# --------------------------------------------------------------------------- the commands

def unplaceable(plan):
	return _account_unplaceable(plan) if plan.kind == "accounting" else _balance_unplaceable(plan)


def select(plan):
	return _account_select(plan) if plan.kind == "accounting" else _balance_select(plan)


def verify(plan):
	return _account_verify(plan) if plan.kind == "accounting" else _balance_verify(plan)


def columns(plan):
	if plan.kind == "accounting":
		return _account_key(plan), [q(c) for c in _account_cached(plan)]
	return _balance_columns(plan)


def name(plan):
	return "%s.%s" % (plan.module, plan.code)


def check(pg, plan, show):
	"""(cached rows, disagreeing keys) - the cache against a fresh fold of the journal."""
	cur = pg.cursor()
	cur.execute("SELECT count(*) FROM %s" % plan.totals)
	cached = cur.fetchone()[0]
	started = time.time()
	cur.execute(verify(plan))
	rows = cur.fetchall()
	key, cols = columns(plan)
	print("%-28s cache %7d rows   disagreeing keys %d   (%.0fs)"
	      % (name(plan), cached, len(rows), time.time() - started))
	if rows and show:
		width = len(key)
		print("     %s" % "  ".join([k.strip('"') for k in key]
		                            + ["%s fold/cache" % c.strip('"') for c in cols]))
		for row in rows[:show]:
			pairs = ["%s/%s" % (row[width + 2 * i], row[width + 2 * i + 1])
			         for i in range(len(cols))]
			print("     %s" % "  ".join([str(v) for v in row[:width]] + pairs))
		if len(rows) > show:
			print("     ... %d more" % (len(rows) - show))
	return cached, len(rows)


def rebuild(pg, plan):
	cur = pg.cursor()
	started = time.time()
	cur.execute(unplaceable(plan))
	found = cur.fetchone()
	if found and any(found):
		raise SystemExit("totals: %s - the journal holds %d undated, %d unkeyed and %d undirected"
		                 " movement(s); install would refuse the cache, and so does this"
		                 % ((name(plan),) + tuple(found)))
	scanned = time.time()
	cur.execute(select(plan))
	rows = cur.fetchall()
	read = time.time()

	key, cols = columns(plan)
	at = len(key) - 1                                # the period is the last key column
	by_year = collections.defaultdict(list)
	for row in rows:
		by_year[row[at].year].append(row)
	cur.execute("SELECT DISTINCT extract(year FROM %s)::int FROM %s"
	            % (q(plan.period_field), plan.totals))
	years = sorted(set(by_year) | set(r[0] for r in cur.fetchall()))

	insert = ("INSERT INTO %s (%s) VALUES (%s)"
	          % (plan.totals, ", ".join(key + cols), ", ".join(["%s"] * (len(key) + len(cols)))))
	with transactions.writing(pg):
		for year in years:
			cur.execute("SET LOCAL session_replication_role = 'replica'")
			cur.execute("DELETE FROM %s WHERE %s >= %%s AND %s < %%s"
			            % (plan.totals, q(plan.period_field), q(plan.period_field)),
			            ("%d-01-01" % year, "%d-01-01" % (year + 1)))
			if by_year.get(year):
				cur.executemany(insert, by_year[year])
			pg.commit()
	print("%-28s %7d rows written over %d year(s)   checks %.0fs, fold %.0fs, write %.0fs"
	      % (name(plan), len(rows), len(years), scanned - started, read - scanned,
	         time.time() - read))


def main():
	migrate.load_env()
	ap = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
	ap.add_argument("command", choices=("check", "rebuild", "sql"))
	ap.add_argument("module", nargs="*", help="limit to these modules")
	ap.add_argument("--show", type=int, default=10, metavar="N",
	                help="check: disagreeing keys to print")
	args = ap.parse_args()

	pg = migrate.pg_connect()
	# Reads are long scans: autocommit, so no transaction stays open across them.
	pg.autocommit = True
	cur = pg.cursor()
	cur.execute("SHOW TimeZone")
	sys.stderr.write("[i] session time zone %s (the period of a timestamptz depends on it)\n"
	                 % cur.fetchone()[0])
	found = plans(cur, set(args.module))
	if not found:
		print("no register declares totals%s" % (" in " + ", ".join(args.module)
		                                          if args.module else ""))
		return 0
	clean = True
	for plan in found:
		if args.command == "sql":
			print("-- %s\n-- verify\n%s;\n-- rebuild select\n%s;\n" % (name(plan), verify(plan), select(plan)))
		elif args.command == "check":
			clean = check(pg, plan, args.show)[1] == 0 and clean
		else:
			rebuild(pg, plan)
	return 0 if clean else 1


if __name__ == "__main__":
	sys.exit(main())
