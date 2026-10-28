#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Extract every 1C module text in the configuration to files, once.

Unpacking on demand costs a container parse per question; this walks every container in
out/config and writes the module sources to out/code, so from then on the whole business
logic of the infobase is greppable with ordinary tools.

It iterates the container FILES rather than the metadata tree on purpose: form modules
are their own Config entries and are not reachable from the object list, so a tree walk
would silently miss them.

Layout:

    out/code/<Family>/<ObjectName>/<container>.<entry>.bsl
    out/code/_unowned/<guid>/...        container whose owner is not a top-level object
    out/code/index.json                 one record per file, for attribution and sizing

    python tools/extract_code.py           # everything
    python tools/extract_code.py --stats   # re-print the summary from index.json
"""
from __future__ import print_function

import codecs
import json
import os
import re
import sys

import attrs
import meta
import unpack

OUT = meta.OUT
CONFIG = meta.CONFIG
CODE = os.path.join(OUT, "code")

GUID_PREFIX = re.compile(r"^([0-9a-fA-F-]{36})")
# a module, as opposed to a form layout or a picture, reads as 1C source
CODE_MARKERS = ("Процедура", "Функция", "Перем ", "Procedure", "Function")
SAFE = re.compile(r"[^0-9A-Za-zА-Яа-яЁёІіЇїЄєҐґ._-]")


def safe(name):
	return SAFE.sub("_", name)[:80] or "unnamed"


# DBNames names only the classes that own a table. Two more are named here because the
# evidence is conclusive: 631b75a0's members are ABCАнализПокупателей /
# АнализДвиженияДенежныхСредств, and 07ee8426's containers hold `form` + `module` rather
# than the `info` + `text` every module-bearing object has.
#
# The rest keep their class GUID as a directory name on purpose. Two of them carry a lot
# of code - bf845118 (187 members) and 0fe48980 (128) - and both look like common modules
# from their container shape, which cannot both be true. Guessing would put wrong labels
# on 500k lines, so out/code/classes.md records the evidence instead and anyone who knows
# 1C can name them in a minute. Attribution to the owning OBJECT is exact either way.
CLASS_LABELS = {
	"631b75a0-29e2-11d6-a3c7-0050bae0a776": "Report",
	"07ee8426-87f1-11d5-b99c-0050bae0a95d": "Form",
}


def owner_index():
	"""guid -> (label, object name) for every metadata object in the root.

	objects_all.json is used rather than objects.json: the latter only covers classes
	that own a physical table, which leaves out common modules, reports and event
	subscriptions - most of the configuration's code.
	"""
	index = {}
	for obj in attrs.load_json("objects_all.json"):
		if not obj.get("name"):
			continue
		label = (obj.get("family")
		         or CLASS_LABELS.get(obj["classGuid"])
		         or "class_" + obj["classGuid"][:8])
		index[obj["guid"]] = (label, obj["name"])
	return index


def is_code(text):
	return text is not None and any(marker in text for marker in CODE_MARKERS)


def nested_owner_index(unknown, owners):
	"""Attribute nested containers - form modules, mostly - to the object they belong to.

	A form is its own Config entry with its own GUID and is not in the root object list,
	but that GUID is written into its owner's definition, so one pass over the root
	objects' files resolves them.
	"""
	unknown = set(unknown)
	resolved = {}
	for guid, (label, name) in owners.items():
		text = meta.load(guid)
		if text is None:
			continue
		for found in set(re.findall(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
		                            r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}", text)):
			if found in unknown and found not in resolved:
				resolved[found] = (label, name)
	return resolved


def main():
	if "--stats" in sys.argv:
		report(attrs.load_json(os.path.join("code", "index.json")))
		return

	owners = owner_index()
	files = sorted(f for f in os.listdir(CONFIG) if f.endswith(".bin"))

	unknown = set()
	for filename in files:
		match = GUID_PREFIX.match(filename)
		if match and match.group(1) not in owners:
			unknown.add(match.group(1))
	sys.stderr.write("[i] resolving %d nested containers against %d objects\n"
	                 % (len(unknown), len(owners)))
	nested = nested_owner_index(unknown, owners)
	sys.stderr.write("[i] %d of them attributed\n" % len(nested))

	records = []
	containers = skipped = 0
	written = set()

	for i, filename in enumerate(files):
		path = os.path.join(CONFIG, filename)
		with open(path, "rb") as f:
			blob = f.read()
		if blob[:4] != b"\xff\xff\xff\x7f":
			skipped += 1
			continue
		try:
			items = unpack.entries(blob)
		except Exception as exc:                      # a malformed container is data, not a crash
			records.append({"file": filename, "error": str(exc)[:120]})
			continue
		containers += 1

		base = filename[:-len(".bin")]
		match = GUID_PREFIX.match(base)
		guid = match.group(1) if match else ""
		family, name = owners.get(guid) or nested.get(guid) or ("_unowned", guid or base)
		target = os.path.join(CODE, safe(family), safe(name))

		for entry_name, content in items:
			text = unpack.as_text(content)
			if not is_code(text):
				continue
			if not os.path.isdir(target):
				os.makedirs(target)
			# The container's own identity has to reach the filename. Naming the file
			# after the suffix alone - the `0` of `<guid>.0` - gave every container of
			# an object the same name, so an object owning several (a document and its
			# forms, a report and its variants) kept only whichever was written last.
			# That silently lost 825,327 lines of 2.36 M, and the index went on
			# describing files that no longer held what it said.
			stem = "%s.%s" % (guid[:8] or "x", base.split(".", 1)[-1])
			out_name = "%s.%s.bsl" % (safe(stem), safe(entry_name))
			if os.path.join(target, out_name) in written:
				# Eight hex digits are not a promise. Spend the whole GUID rather
				# than lose a file to the same bug in a smaller form.
				out_name = "%s.%s.bsl" % (safe(base), safe(entry_name))
			written.add(os.path.join(target, out_name))
			with codecs.open(os.path.join(target, out_name), "w", "utf-8") as f:
				f.write(text)
			records.append({
				"family": family, "object": name, "guid": match.group(1) if match else None,
				"container": base,
				"entry": entry_name, "path": os.path.relpath(
					os.path.join(target, out_name), OUT).replace("\\", "/"),
				"lines": sum(1 for line in text.splitlines()
				             if line.strip() and not line.strip().startswith("//")),
			})
		if i and i % 500 == 0:
			sys.stderr.write("[i] %d/%d files, %d modules\n" % (i, len(files), len(records)))

	with codecs.open(os.path.join(CODE, "index.json"), "w", "utf-8") as f:
		json.dump(records, f, ensure_ascii=False, indent="\t")
	write_classes(records)
	print("containers=%d  non-container files skipped=%d" % (containers, skipped))
	report(records)


def write_classes(records):
	"""What each metadata class turned out to hold, so the unlabelled ones can be named."""
	import collections
	objects = attrs.load_json("objects_all.json")
	by_guid = {o["guid"]: o for o in objects}

	# join on the owner GUID, never on the name: names repeat across classes
	# (ABCКлассификацияПокупателей is a Document, an InfoRg and a Report)
	stats = collections.defaultdict(lambda: {"modules": 0, "lines": 0, "objects": set()})
	for r in records:
		if "lines" not in r:
			continue
		owner = by_guid.get(r.get("guid"))
		key = owner["classGuid"] if owner else "(not a root object - forms, etc.)"
		stats[key]["modules"] += 1
		stats[key]["lines"] += r["lines"]
		stats[key]["objects"].add(r.get("guid"))

	members = collections.defaultdict(list)
	for o in objects:
		if o.get("name"):
			members[o["classGuid"]].append(o["name"])

	lines = ["# Metadata classes, by what they actually contain", "",
	         "Generated by `tools/extract_code.py`. Classes without a DBNames family own",
	         "no table, so they have to be identified from their contents.", "",
	         "| class GUID | label | members | with code | modules | lines | sample members |",
	         "|---|---|---:|---:|---:|---:|---|"]
	for class_guid, names in sorted(members.items(), key=lambda kv: -len(kv[1])):
		s = stats.get(class_guid, {"modules": 0, "lines": 0, "objects": set()})
		label = CLASS_LABELS.get(class_guid, "")
		lines.append("| `%s` | %s | %d | %d | %d | %d | %s |"
		             % (class_guid, label, len(names), len(s["objects"]),
		                s["modules"], s["lines"], ", ".join(names[:4])))
	unowned = stats.get("(not a root object - forms, etc.)")
	if unowned:
		lines += ["", "Modules whose container is not a root object (nested forms and the"
		              " like): %d modules, %d lines."
		          % (unowned["modules"], unowned["lines"])]
	with codecs.open(os.path.join(CODE, "classes.md"), "w", "utf-8") as f:
		f.write("\n".join(lines) + "\n")


def report(records):
	import collections
	by_family = collections.Counter()
	lines_by_family = collections.Counter()
	for r in records:
		if "lines" not in r:
			continue
		by_family[r["family"]] += 1
		lines_by_family[r["family"]] += r["lines"]
	print("\n%-16s %8s %10s" % ("family", "modules", "lines"))
	print("-" * 36)
	for family, count in by_family.most_common():
		print("%-16s %8d %10d" % (family, count, lines_by_family[family]))
	print("-" * 36)
	print("%-16s %8d %10d" % ("total", sum(by_family.values()),
	                          sum(lines_by_family.values())))
	print("\n-> %s" % CODE)


if __name__ == "__main__":
	main()
