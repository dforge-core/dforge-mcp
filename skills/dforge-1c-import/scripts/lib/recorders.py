#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Which document types write a register, and how much.

A register with _RecorderTRef is written by several document kinds; the TRef is the
target's type id, which appears in the reference columns of any table pointing at the
same type. Matching it back to a document is done through DBNames: the type id is the
low bytes of the table number, so comparing against every document's table number
identifies it.

    python tools/recorders.py _AccumRg17050
"""
from __future__ import print_function

import codecs
import json
import os
import sys

import paths

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import store

OUT = paths.OUT


def load_report():
	with codecs.open(os.path.join(OUT, "report.json"), "r", "utf-8") as f:
		return json.load(f)


def probe_single(cur, table):
	"""Without a TRef the recorder's type is implicit, so find the one document table
	whose PK matches the recorders we sampled."""
	cur.execute("SELECT DISTINCT _RecorderRRef FROM %s LIMIT 20" % store.quote(table))
	refs = [bytes(r[0]) for r in cur.fetchall()]
	if not refs:
		print("   (register is empty)")
		return
	placeholders = ",".join("?" * len(refs))
	for row in load_report():
		physical = row.get("physical") or ""
		suffix = physical[len("_Document"):] if physical.startswith("_Document") else ""
		if not suffix.isdigit() or not row.get("rows"):
			continue
		cur.execute("SELECT COUNT(*) FROM %s WHERE _IDRRef IN (%s)"
		            % (store.quote(physical), placeholders), *refs)
		hits = cur.fetchone()[0]
		if hits:
			print("   %s - %s  (%d/%d sampled recorders matched)"
			      % (row["name"], row["synonym"] or "", hits, len(refs)))
			return
	print("   no document table matched the sampled recorders")


def main():
	table = sys.argv[1]
	cur = store.connect().cursor()
	cur.execute("SELECT * FROM %s LIMIT 0" % store.quote(table))
	if "_RecorderTRef" not in [d[0] for d in cur.description]:
		print("%s has no _RecorderTRef - one document type writes it; probing for it"
		      % table)
		probe_single(cur, table)
		return

	cur.execute("SELECT _RecorderTRef, COUNT(*) FROM %s GROUP BY _RecorderTRef "
	            "ORDER BY 2 DESC" % store.quote(table))
	rows = cur.fetchall()

	# a document's type id is its table number; _RecorderTRef stores it big-endian
	by_number = {}
	for row in load_report():
		physical = row.get("physical") or ""
		suffix = physical[len("_Document"):] if physical.startswith("_Document") else ""
		if suffix.isdigit():                      # skips _DocumentJournal<N>
			by_number[int(suffix)] = row

	print("%-12s %-12s %s" % ("TRef", "movements", "document"))
	for tref, n in rows:
		number = int.from_bytes(bytes(tref), "big") & 0xFFFF
		doc = by_number.get(number)
		print("%-12s %-12s %s" % (bytes(tref).hex(), "{:,}".format(n),
		                          "%s - %s" % (doc["name"], doc["synonym"] or "") if doc
		                          else "number=%d (unmatched)" % number))


if __name__ == "__main__":
	main()
