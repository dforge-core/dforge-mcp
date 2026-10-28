#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
How big is the rest of the port?

Counts fields, tabular sections and references across the client-specific objects that
hold data, so the remaining effort can be estimated from the same numbers the transport
contour was estimated from rather than guessed at.

    python tools/sizing.py
"""
from __future__ import print_function

import codecs
import collections
import json
import os
import re

import attrs
import binding

contours = binding.contours()
import unpack

LOWER_PREFIX = re.compile(r"^([a-zа-яёіїє]{2,6})(?=[A-ZА-Я])")

# The data model is ported for every object in scope, so "done" no longer means the
# object - it means its logic. `contours.DONE` is the set whose logic was looked at while
# the transport contour was designed.
DONE = contours.DONE


_INDEX = None


def code_index():
	"""out/code/index.json, written once by extract_code.py. Falls back to unpacking on
	demand if the code has not been extracted yet."""
	global _INDEX
	if _INDEX is None:
		path = os.path.join(attrs.OUT, "code", "index.json")
		if os.path.isfile(path):
			with codecs.open(path, "r", "utf-8") as f:
				_INDEX = json.load(f)
		else:
			_INDEX = []
	return _INDEX


def code_lines(guid):
	"""Non-blank, non-comment lines of the object's own modules (not its forms)."""
	index = code_index()
	if index:
		return sum(r["lines"] for r in index
		           if r.get("guid") == guid and r.get("entry") == "text")
	total = 0
	for _, blob in unpack.containers_of(guid):
		for name, content in unpack.entries(blob):
			if name != "text":
				continue
			text = unpack.as_text(content) or ""
			total += sum(1 for line in text.splitlines()
			             if line.strip() and not line.strip().startswith("//"))
	return total


def code_breakdown():
	"""Whose code is in the infobase, and is it business logic or UI."""
	index = code_index()
	if not index:
		return
	owner = collections.Counter()
	kinds = collections.Counter()
	for r in index:
		if "lines" not in r:
			continue
		m = LOWER_PREFIX.match(r["object"] or "")
		tag = m.group(1) if m else None
		if tag in binding.client_prefixes():
			bucket = "client"
			kinds["UI (form modules)" if r["entry"] == "module"
			      else "business logic"] += r["lines"]
		elif tag in binding.toolkit_prefixes():
			bucket = "third-party dev toolkit"
		else:
			bucket = "vendor (UTP)"
		owner[bucket] += r["lines"]

	print("\nextracted code, by owner")
	print("-" * 46)
	for bucket, n in owner.most_common():
		print("   %-26s %9d lines" % (bucket, n))
	print("\nthe client's own code splits into")
	print("-" * 46)
	for kind, n in kinds.most_common():
		print("   %-26s %9d lines" % (kind, n))


def main():
	objects = attrs.load_json("objects.json")
	types = attrs.load_json("typemap.json")
	rows = attrs.load_json("report.json")
	by_name = {o["name"]: o for o in objects if o.get("name")}

	def is_custom(name):
		m = LOWER_PREFIX.match(name or "")
		return bool(m and m.group(1) in binding.client_prefixes() + binding.toolkit_prefixes())

	scope = [r for r in rows
	         if is_custom(r["name"]) and ((r["rows"] or 0) or r["childRows"])]

	totals = collections.defaultdict(
		lambda: {"objects": 0, "fields": 0, "sections": 0, "refs": 0, "done": 0,
		         "code": 0})
	grand = {"fields": 0, "sections": 0, "refs": 0, "remaining_fields": 0,
	         "code": 0, "remaining_code": 0}

	for row in scope:
		name = row["name"]
		obj = by_name.get(name)
		if not obj:
			continue
		_, fields = attrs.fields_of(name, objects, types)
		fields = fields or []
		sections = len({f["section"] for f in fields if f["section"]})
		refs = sum(1 for f in fields if "->" in f["type"])
		code = code_lines(obj["guid"])
		bucket = totals[row["family"]]
		bucket["objects"] += 1
		bucket["fields"] += len(fields)
		bucket["sections"] += sections
		bucket["refs"] += refs
		bucket["code"] += code
		grand["fields"] += len(fields)
		grand["sections"] += sections
		grand["refs"] += refs
		grand["code"] += code
		if name in DONE:
			bucket["done"] += 1
		else:
			grand["remaining_fields"] += len(fields)
			grand["remaining_code"] += code

	print("%-12s %8s %6s %8s %9s %6s %9s" %
	      ("family", "objects", "done", "fields", "sections", "refs", "code loc"))
	print("-" * 68)
	for family, b in sorted(totals.items(), key=lambda kv: -kv[1]["fields"]):
		print("%-12s %8d %6d %8d %9d %6d %9d"
		      % (family, b["objects"], b["done"], b["fields"], b["sections"],
		         b["refs"], b["code"]))
	print("-" * 68)
	print("%-12s %8d %6d %8d %9d %6d %9d"
	      % ("total", sum(b["objects"] for b in totals.values()),
	         sum(b["done"] for b in totals.values()),
	         grand["fields"], grand["sections"], grand["refs"], grand["code"]))
	print("\nthe data model is generated for all of these; what remains is the logic:")
	print("%d lines of 1C object-module code outside the contour already studied"
	      % grand["remaining_code"])
	by_module()
	code_breakdown()


def by_module():
	"""How much 1C business logic sits behind each generated dForge module."""
	objects = attrs.load_json("objects.json")
	guid_of = {}
	for obj in objects:
		if obj.get("name"):
			guid_of.setdefault(obj["name"], obj["guid"])

	print("\n1C object-module code, by the module it was assigned to")
	print("-" * 46)
	totals = []
	for module, contour in contours.CONTOURS.items():
		lines = sum(code_lines(guid_of[name])
		            for name in contours.names(contour) if name in guid_of)
		totals.append((module, lines))
	for module, lines in sorted(totals, key=lambda kv: -kv[1]):
		print("   %-26s %9d lines" % (module, lines))


if __name__ == "__main__":
	main()
