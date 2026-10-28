#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Mark the migrated documents that 1C posted as posted in the source system.

The loader brings **both** sides across from the infobase: the documents and the register
rows they wrote. The platform's posting flag is not among them - it is engine state, and a
generated trigger refuses any write to it but the engine's (`DF006`) - so every migrated
document arrives saying "not posted" while its movements already sit in the register. Left
alone, a user opens a 2018 document, sees it unposted, presses Post, and the engine writes a
second set of rows on top of the migrated ones.

The platform's answer is a distinct state rather than a claim that the engine posted it:
`register.markImported` sets the hidden marker pair beside a state column
(`<state>_imported`, `<state>_imported_source`). A marked document is settled - the engine
refuses to post or unpost it, its locked fields freeze, and the card shows it read-only under
an "Imported" badge - while its state column stays false, so "posted" keeps meaning "the
engine posted this".

    python tools/1c.py posted                  # measure: what 1C posted, what is marked
    DF_TOKEN=<jwt> python tools/1c.py posted --mark     # make the markers match 1C
    DF_TOKEN=<jwt> python tools/1c.py posted --unmark   # take every marker off again

What gets marked is exactly what 1C asserted: `posted` is the infobase's own `Проведен`, so a
document 1C left unposted stays postable here, and its movements were never written either.
`--mark` converges on that: it also takes the marker off a document 1C did not post (an
earlier run marked without the condition), since a marked draft could never be posted here.
It is idempotent - the RPC skips a document already marked or already posted - so it is safe
to run after every load, and it has to be: a reload of a document table brings the rows back
unmarked.

It is deliberately **not** part of `migrate run`. Marking is a statement about history made
once the history is in place, and it needs a token the loader does not have.

Nothing here stamps `source` on the migrated register rows. That column exists so unposting
can find the rows it wrote, and a marked document is never unposted.
"""
from __future__ import print_function

import argparse
import sys

import migrate
import paths
import posting


def source():
	"""The label a marker carries: which infobase the document was posted in."""
	return "1C:%s" % paths.required("DF1C_DB", "which MS SQL infobase the documents came from")


def registry_columns(pg):
	"""Every posting column in the tenant - `A` and ledger `L` alike - with its module and
	the table it sits on.

	Read from the tenant's own metadata rather than listed here, so a register declared
	tomorrow is covered without editing this file - the failure mode otherwise is a new
	binding quietly missing from the sweep, which is exactly the bug this guards against.
	It was one: the sweep read `A` only, and the first ledger binding would have left every
	document 1C posted offered Post again, doubling its postings in the ledger.

	A binding may keep its state in a field of its own (`stateField`), and an extension's
	columns sit in a side table (`storage_table`) joined on the document's key: the column
	returned is the state the marker sits beside, and the storage is that side table or None.
	"""
	cur = pg.cursor()
	cur.execute("""
		SELECT m.module_cd, e.entity_cd, e.schema_name, e.db_object,
		       coalesce(c.params->>'stateField', c.column_cd), s.storage_table,
		       (SELECT k.column_cd FROM "dForge".entity_column k
		        WHERE k.entity_id = e.entity_id AND k.is_pk LIMIT 1)
		FROM "dForge".entity_column c
		JOIN "dForge".entity e ON e.entity_id = c.entity_id
		JOIN "dForge".module m ON m.module_id = e.module_id
		LEFT JOIN "dForge".entity_column s
		       ON s.entity_id = e.entity_id AND s.column_cd = coalesce(c.params->>'stateField', c.column_cd)
		WHERE c.column_type IN ('A', 'L')
		ORDER BY m.module_cd, e.entity_cd, c.column_cd""")
	return [row for row in cur.fetchall() if row[2] and row[3]]


def storage_of(schema, table, storage):
	"""(schema, table) the state and its marker are kept in."""
	if not storage:
		return schema, table
	side_schema, side_table = storage.split(".", 1)
	return side_schema.strip('"'), side_table.strip('"')


def has_column(pg, schema, table, column):
	cur = pg.cursor()
	cur.execute("""SELECT 1 FROM information_schema.columns
	               WHERE table_schema = %s AND table_name = %s AND column_name = %s""",
	            (schema, table, column))
	return cur.fetchone() is not None


def counts(pg, schema, table, column, storage=None, key=None):
	"""(1C posted, engine posted, marked, still to mark, marked though 1C did not post).
	An extension's state is read from its side table, where a document it never wrote has no row."""
	marker = column + "_imported"
	side = ' LEFT JOIN %s x ON x."%s" = t."%s"' % (storage, key, key) if storage else ""
	cur = pg.cursor()
	cur.execute("""SELECT count(*) FILTER (WHERE posted),
	                      count(*) FILTER (WHERE "{c}"),
	                      count(*) FILTER (WHERE "{m}"),
	                      count(*) FILTER (WHERE posted AND NOT coalesce("{c}", false) AND NOT coalesce("{m}", false)),
	                      count(*) FILTER (WHERE "{m}" AND NOT coalesce(posted, false))
	               FROM "{s}"."{t}" t{x}""".format(c=column, m=marker, s=schema, t=table, x=side))
	return cur.fetchone()


def folder_of(pg, module):
	# As a string: the RPC declares folderId as one.
	cur = pg.cursor()
	cur.execute('select f.folder_id from "dForge".folder f '
	            'join "dForge".module m on m.module_id = f.module_id '
	            'where m.module_cd = %s order by f.folder_id limit 1', (module,))
	row = cur.fetchone()
	return str(row[0]) if row else None


def survey(pg, module=None, unmark=False, quiet=False):
	"""The table of what 1C posted against what is marked, and the work it implies.

	Returns (work, total, stale): one (module, label, column) per registry column that can
	be marked, the number of documents a converge would touch, and the modules installed
	before the marker pair existed.
	"""
	columns = [c for c in registry_columns(pg) if not module or c[0] == module]
	out = (lambda *a: None) if quiet else print
	out("%-52s %-22s %9s %9s %9s %9s %9s"
	    % ("document", "state", "1C", "posted", "marked", "to mark", "stray"))
	out("-" * 126)
	work, total, stale = [], 0, []
	for module_cd, entity_cd, schema, table, column, storage, key in columns:
		label = "%s.%s" % (module_cd, entity_cd)
		if not has_column(pg, schema, table, "posted"):
			out("%-52s %-22s   skipped: no `posted` column to read" % (label[:52], column[:22]))
			continue
		if not has_column(pg, *(storage_of(schema, table, storage) + (column + "_imported",))):
			# Installed before the platform synthesised the marker pair. Marking refuses and
			# says to reinstall; saying so here costs nothing.
			stale.append(label)
			out("%-52s %-22s   no marker column: reinstall the module" % (label[:52], column[:22]))
			continue
		in_1c, posted_here, marked, pending, stray = counts(pg, schema, table, column, storage, key)
		total += marked if unmark else pending + stray
		work.append((module_cd, label, column))
		out("%-52s %-22s %9s %9s %9s %9s %9s"
		    % (label[:52], column[:22], format(in_1c, ","), format(posted_here, ","),
		       format(marked, ","), format(pending, ","), format(stray, ",")))
	out("-" * 126)
	out("%-98s %9s" % ("to unmark" if unmark else "to mark or unmark", format(total, ",")))
	return work, total, stale


def converge(pg, work, jwt, unmark=False):
	"""Make the markers match 1C (or take every one off): {verb: count}, and whether all went.

	--mark marks what 1C posted and takes the marker off what it did not. The delta loader
	calls this too, after it has upserted documents: a document it brought in is unmarked,
	and one 1C has since unposted is still marked.
	"""
	steps = [("register.unmarkImported", "true", "unmarked")] if unmark else [
		("register.markImported", "t.posted", "marked"),
		("register.unmarkImported", "NOT coalesce(t.posted, false)", "unmarked")]
	failed = False
	done = {}
	for module, label, column in work:
		for method, where, verb in steps:
			params = {"entity": label, "stateColumn": column, "where": where}
			if method == "register.markImported":
				params["source"] = source()
			result = posting.call(method, params, folder_of(pg, module), jwt)
			count = (result.get("result") or {}).get("count") if isinstance(result, dict) else None
			if count is None:
				failed = True
				print("  %-52s %s" % (label, result), file=sys.stderr)
				continue
			done[verb] = done.get(verb, 0) + count
			if count:
				print("  %-52s %-22s %s %s" % (label, column, verb, format(count, ",")))
	return done, not failed


def main():
	parser = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
	action = parser.add_mutually_exclusive_group()
	action.add_argument("--mark", action="store_true",
	                    help="mark every document 1C posted (needs a token)")
	action.add_argument("--unmark", action="store_true",
	                    help="remove every marker (needs a token)")
	parser.add_argument("module", nargs="?", help="one module only")
	args = parser.parse_args()

	migrate.load_env()
	pg = migrate.pg_connect()
	pg.autocommit = True
	if not any(not args.module or c[0] == args.module for c in registry_columns(pg)):
		print("no registry columns in this tenant")
		return
	work, total, _ = survey(pg, args.module, args.unmark)

	if not (args.mark or args.unmark):
		if total:
			print("\nnothing written. --mark (with a token) marks them.")
		return

	done, ok = converge(pg, work, posting.token(), args.unmark)
	print("\n" + ", ".join("%s %s" % (verb, format(n, ",")) for verb, n in done.items())
	      + " document(s).")
	if not ok:
		sys.exit(1)

if __name__ == "__main__":
	main()
