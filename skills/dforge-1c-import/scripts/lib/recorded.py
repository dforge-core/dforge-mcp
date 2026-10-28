#!/usr/bin/env python
# -*- coding: utf-8 -*-
u"""What each document type actually wrote: register rows by recorder type, every register.

The call graph (`callgraph.py`) says what the code CAN write. This says what 1C DID write,
and the difference between the two is the call graph's error, measured rather than argued:

  * a register the code reaches but no document of that type ever wrote is either a branch
    this client never took or an over-reach of the analysis - the chain in callgraph.json
    tells which;
  * a register a document wrote that the code does not reach is a miss, always a defect.

A register with several recorder types carries `_RecorderTRef`, whose low two bytes are the
recorder's document table number. One with a single recorder type has no TRef; its type is
the one document table whose keys its recorders match.

    python tools/1c.py recorded            # writes out/recorded.json
    python tools/1c.py recorded --compare  # and scores out/callgraph.json against it

Read off the export (`store.py`), so it asks nothing of the running infobase.
"""
from __future__ import print_function

import codecs
import collections
import io
import json
import os
import sys

import meta
import migrate
import paths
import store

TARGET = os.path.join(paths.OUT, "recorded.json")


def registers():
	"""(family, name, physical table) for every register in the configuration."""
	with io.open(os.path.join(paths.OUT, "objects.json"), encoding="utf-8") as f:
		objects = json.load(f)
	index = meta.dbnames_index()
	found = []
	for obj in objects:
		if obj.get("family") not in ("AccumRg", "InfoRg", "AccRg", "CRg"):
			continue
		entry = index.get(obj["guid"])
		if entry and entry["type"] == obj["family"]:
			found.append((obj["family"], obj["name"], entry["physical"]))
	return sorted(found)


def documents():
	"""Document table number -> (name, physical table)."""
	with io.open(os.path.join(paths.OUT, "objects.json"), encoding="utf-8") as f:
		objects = json.load(f)
	index = meta.dbnames_index()
	found = {}
	for obj in objects:
		if obj.get("family") != "Document":
			continue
		entry = index.get(obj["guid"])
		if entry and entry["type"] == "Document":
			found[int(entry["number"])] = (obj["name"], entry["physical"])
	return found


def columns(table):
	return migrate.source_schema()[table]["columns"]


def single_recorder(cur, table, docs):
	"""The one document type a TRef-less register's recorders belong to."""
	cur.execute("SELECT DISTINCT _RecorderRRef FROM %s LIMIT 20" % store.quote(table))
	refs = [bytes(r[0]) for r in cur.fetchall()]
	if not refs:
		return None
	marks = ",".join("?" * len(refs))
	for number, (name, physical) in sorted(docs.items()):
		cur.execute("SELECT COUNT(*) FROM %s WHERE _IDRRef IN (%s)" % (store.quote(physical), marks),
		            *refs)
		if cur.fetchone()[0]:
			return number
	return None


def measure():
	migrate.load_env()
	cur = migrate.source_connect().cursor()
	docs = documents()
	result = collections.defaultdict(dict)       # document -> register -> rows
	unmatched = []
	for family, name, table in registers():
		cols = columns(table)
		if "_RecorderRRef" not in cols:
			continue                             # not subordinate to a recorder
		if "_RecorderTRef" in cols:
			cur.execute("SELECT _RecorderTRef, COUNT(*) FROM %s"
			            " GROUP BY _RecorderTRef" % store.quote(table))
			for tref, rows in cur.fetchall():
				number = int.from_bytes(bytes(tref), "big") & 0xFFFF
				if number in docs:
					result[docs[number][0]][name] = int(rows)
				else:
					unmatched.append((name, number, int(rows)))
		else:
			cur.execute("SELECT COUNT(*) FROM %s" % store.quote(table))
			rows = int(cur.fetchone()[0])
			if not rows:
				continue
			number = single_recorder(cur, table, docs)
			if number is None:
				unmatched.append((name, None, rows))
			else:
				result[docs[number][0]][name] = rows
		sys.stderr.write(".")
	sys.stderr.write("\n")
	return dict(result), unmatched


def compare(recorded, out):
	"""Score the call graph against what 1C wrote, per document that wrote anything."""
	with io.open(os.path.join(paths.OUT, "callgraph.json"), encoding="utf-8") as f:
		graph = dict((r["document"], set(r["registers"])
		              ) for r in json.load(f)["documents"])
	hit = miss = extra = 0
	lines = []
	for document in sorted(recorded):
		actual = set(recorded[document])
		static = graph.get(document, set())
		missed = actual - static
		over = static - actual
		hit += len(actual & static)
		miss += len(missed)
		extra += len(over)
		if missed or over:
			lines.append((document, sorted(missed), sorted(over)))
	out.write(u"%d documents wrote registers in 1C. Register pairs: %d found by the call "
	          u"graph, %d missed, %d reached by code but never written\n\n"
	          % (len(recorded), hit, miss, extra))
	for document, missed, over in lines:
		if missed:
			out.write(u"%-44s MISSED %s\n" % (document[:44], u", ".join(missed)))
	out.write(u"\n")
	for document, missed, over in lines:
		if over:
			out.write(u"%-44s never written: %s\n" % (document[:44], u", ".join(over)[:150]))


def main():
	out = codecs.getwriter("utf-8")(sys.stdout.buffer)
	if os.path.exists(TARGET) and "--measure" not in sys.argv:
		with io.open(TARGET, encoding="utf-8") as f:
			saved = json.load(f)
		recorded = saved["documents"]
	else:
		recorded, unmatched = measure()
		with codecs.open(TARGET, "w", "utf-8") as f:
			json.dump({"documents": recorded, "unmatched": unmatched}, f,
			          ensure_ascii=False, indent="\t", sort_keys=True)
		out.write(u"%d document types wrote registers; %d register/type pairs unmatched\n"
		          % (len(recorded), len(unmatched)))
		out.write(u"written %s\n" % TARGET)
	if "--compare" in sys.argv:
		compare(recorded, out)


if __name__ == "__main__":
	main()
