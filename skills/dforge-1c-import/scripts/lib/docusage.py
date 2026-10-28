#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""How much each document type is used: last date, last twelve months, posted.

Usage does not narrow what gets ported - a document nobody has posted in years is still
done - but it orders the work, and it says which types have a history to prove a port on.
A type with no posted documents has nothing for the oracle to compare against.

The twelve months are counted back from the newest document in the infobase, not from
today: an extraction is a snapshot, and "the last year" should mean the last year the
client actually worked in it.

    python tools/1c.py docusage              # the table, and out/docusage.json

Read-only. The physical table comes from `DBNames` by the object's GUID, never guessed.
"""
from __future__ import print_function

import codecs
import io
import json
import os
import sys

import handlers
import meta
import migrate
import paths

TARGET = os.path.join(paths.OUT, "docusage.json")


def documents():
	"""(name, physical table) for every document in the configuration."""
	with io.open(os.path.join(paths.OUT, "objects.json"), encoding="utf-8") as f:
		objects = json.load(f)
	index = meta.dbnames_index()
	found = []
	for obj in objects:
		if obj.get("family") != "Document":
			continue
		entry = index.get(obj["guid"])
		if entry and entry["type"] == "Document":
			found.append((obj["name"], entry["physical"]))
	return sorted(found)


def measure(cur, table):
	cur.execute("SELECT COUNT(*), MAX(_Date_Time) FROM dbo.[%s]" % table)
	rows, last = cur.fetchone()
	return rows, last


def main():
	migrate.load_env()
	cur = migrate.mssql_connect().cursor()
	docs = documents()
	newest = None
	raw = []
	for name, table in docs:
		rows, last = measure(cur, table)
		raw.append((name, table, rows, last))
		if last is not None and (newest is None or last > newest):
			newest = last
	cutoff = newest.replace(year=newest.year - 1) if newest else None
	result = []
	for name, table, rows, last in raw:
		recent = posted = 0
		if rows:
			cur.execute("SELECT SUM(CASE WHEN _Date_Time >= ? THEN 1 ELSE 0 END),"
			            " SUM(CASE WHEN _Posted = 0x01 THEN 1 ELSE 0 END) FROM dbo.[%s]"
			            % table, cutoff)
			recent, posted = [int(v or 0) for v in cur.fetchone()]
		result.append({
			"name": name,
			"table": table,
			"client": name.startswith(handlers.CLIENT),
			"rows": rows,
			"posted": posted,
			"last12m": recent,
			# 1C stores dates shifted by the year offset; the snapshot keeps them as stored.
			"last": last.strftime("%Y-%m-%d") if last else None,
		})
	result.sort(key=lambda r: (-r["last12m"], -r["posted"], r["name"]))
	with codecs.open(TARGET, "w", "utf-8") as f:
		json.dump({"newest": newest.strftime("%Y-%m-%d") if newest else None,
		           "cutoff": cutoff.strftime("%Y-%m-%d") if cutoff else None,
		           "documents": result}, f, ensure_ascii=False, indent="\t")
	out = codecs.getwriter("utf-8")(sys.stdout.buffer)
	vendor = [r for r in result if not r["client"]]
	out.write("%d document types, %d vendor; newest document %s, last 12 months from %s\n"
	          % (len(result), len(vendor), newest, cutoff))
	out.write("vendor with rows %d, posted %d, used in last 12m %d\n\n" % (
		sum(1 for r in vendor if r["rows"]), sum(1 for r in vendor if r["posted"]),
		sum(1 for r in vendor if r["last12m"])))
	for r in result:
		if r["rows"]:
			out.write("%-6s %-52s %9d %9d %8d  %s\n" % (
				"client" if r["client"] else "", r["name"], r["rows"], r["posted"],
				r["last12m"], r["last"]))
	out.write("\nwritten %s\n" % TARGET)


if __name__ == "__main__":
	main()
