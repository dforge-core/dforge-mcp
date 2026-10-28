#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Show sample rows of a physical table, with 1C's standard columns decoded.

Attribute lists from the configuration omit the implicit fields every catalog and
document carries (_Code, _Description, _Date_Time, _Posted, _Marked), so the only
way to see what actually lives in them is to look at the data.

    python tools/peek.py _Reference214            # 5 rows, all columns
    python tools/peek.py _Reference214 10         # 10 rows
    python tools/peek.py --find рзВодители        # resolve a metadata name to its table
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


def resolve(name):
	with codecs.open(os.path.join(OUT, "report.json"), "r", "utf-8") as f:
		for row in json.load(f):
			if row.get("name") == name:
				return row
	return None


def render(value):
	if value is None:
		return "-"
	if isinstance(value, (bytes, bytearray)):
		return value.hex()[:16]
	text = str(value).strip()
	return text[:38] if text else "-"


def main():
	if sys.argv[1] == "--find":
		row = resolve(sys.argv[2])
		print(json.dumps(row, ensure_ascii=False, indent="\t") if row else "not found")
		return

	table = sys.argv[1]
	limit = int(sys.argv[2]) if len(sys.argv) > 2 else 5
	cur = store.connect().cursor()
	cur.execute("SELECT * FROM %s LIMIT %d" % (store.quote(table), limit))
	columns = [d[0] for d in cur.description]
	rows = cur.fetchall()
	# drop columns that are empty across every sampled row - they only add noise
	keep = [i for i, _ in enumerate(columns)
	        if any(render(r[i]) not in ("-", "0", "0.0000") for r in rows)]
	for i in keep:
		print("%-28s | %s" % (columns[i], " | ".join(render(r[i]) for r in rows)))
	print("\n(%d columns, %d hidden as empty)" % (len(columns), len(columns) - len(keep)))


if __name__ == "__main__":
	main()
