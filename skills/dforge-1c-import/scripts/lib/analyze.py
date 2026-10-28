#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Join the physical schema against DBNames to see which parts of the configuration
the client actually uses. A stock UTP ships hundreds of catalogs and documents;
only the populated ones are worth porting.
"""
import codecs
import collections
import json
import os
import re
import sys

import paths

OUT = paths.OUT

# Physical table families that carry business data, in the order we care about.
DATA_KINDS = ("Reference", "Document", "InfoRg", "AccumRg", "AccRg", "Chrc", "Acc",
              "Enum", "DocumentJournal", "Node", "BPr", "Task", "Const")

SPLIT = re.compile(r"^_([A-Za-z]+?)(\d+)(?:_(.+))?$")


def load(name):
	with codecs.open(os.path.join(OUT, name), "r", "utf-8") as f:
		return json.load(f)


def classify(table_name):
	"""_Document123_VT456 -> ('Document', 123, 'VT456')"""
	m = SPLIT.match(table_name)
	if not m:
		return None, None, None
	return m.group(1), int(m.group(2)), m.group(3)


def main():
	schema = load("schema.json")
	tables = {t["name"]: t for t in schema["tables"]}

	summary = collections.OrderedDict((k, {"tables": 0, "used": 0, "rows": 0}) for k in DATA_KINDS)
	detail = collections.defaultdict(list)

	for name, t in tables.items():
		kind, number, suffix = classify(name)
		if kind not in summary or suffix:          # skip tabular sections, roll them up separately
			continue
		rows = t["rows"] or 0
		# a document's tabular sections belong to the document's footprint
		child_rows = sum((tables[n]["rows"] or 0) for n in tables
		                 if n.startswith("_%s%d_" % (kind, number)))
		summary[kind]["tables"] += 1
		summary[kind]["rows"] += rows
		if rows:
			summary[kind]["used"] += 1
		detail[kind].append({"table": name, "number": number, "rows": rows,
		                     "childRows": child_rows, "columns": len(t["columns"])})

	print("%-18s %8s %8s %14s" % ("kind", "tables", "used", "rows"))
	print("-" * 52)
	for kind, s in summary.items():
		if s["tables"]:
			print("%-18s %8d %8d %14s" % (kind, s["tables"], s["used"], "{:,}".format(s["rows"])))

	top = int(sys.argv[1]) if len(sys.argv) > 1 else 25
	for kind in ("Document", "Reference", "AccumRg", "InfoRg"):
		rows = sorted(detail[kind], key=lambda d: -(d["rows"] + d["childRows"]))[:top]
		print("\n== %s: top %d by volume ==" % (kind, top))
		for d in rows:
			if not (d["rows"] or d["childRows"]):
				continue
			print("   %-22s rows=%-12s child=%-12s cols=%d"
			      % (d["table"], "{:,}".format(d["rows"]),
			         "{:,}".format(d["childRows"]), d["columns"]))

	with codecs.open(os.path.join(OUT, "usage.json"), "w", "utf-8") as f:
		json.dump({"summary": summary, "detail": detail}, f, ensure_ascii=False, indent="\t")


if __name__ == "__main__":
	main()
