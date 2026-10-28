#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
How much of the configuration is actually translated.

1C synonyms are per-language: {2,"ru","Водители","uk","Водії"}. Whether a given object
or field carries a `uk` synonym at all decides whether the port can lift its Ukrainian
labels from the infobase or has to translate them itself.

    python tools/i18n_coverage.py                 # whole configuration, by family
    python tools/i18n_coverage.py <names...>      # named objects, per field
"""
from __future__ import print_function

import collections
import sys

import attrs
import meta


def synonyms(node):
	"""Identity block -> {lang: text}. The block is [count, lang, text, lang, text, ...]."""
	block = node[1][3] if len(node[1]) > 3 else None
	if not isinstance(block, list) or len(block) < 3:
		return {}
	body = block[1:]
	return {body[i]: body[i + 1] for i in range(0, len(body) - 1, 2)
	        if isinstance(body[i], str) and len(body[i]) == 2}


def object_languages(guid, name):
	"""(object synonyms, [(field, {lang: text}), ...])"""
	text = meta.load(guid)
	if text is None:
		return {}, []
	tree = meta.parse(text)
	own = {}
	for node in meta.walk(tree):
		if attrs.is_identity(node) and node[2] == name:
			own = synonyms(["", node])
			break
	fields = []
	for node in meta.walk(tree):
		if attrs.is_field(node):
			fields.append((attrs.name_of(node), synonyms(node)))
	return own, fields


def main():
	objects = attrs.load_json("objects.json")
	report = {r["name"]: r for r in attrs.load_json("report.json")}
	names = sys.argv[1:]

	if names:
		for name in names:
			guid = next((o["guid"] for o in objects if o.get("name") == name), None)
			own, fields = object_languages(guid, name)
			print("\n== %s  %s" % (name, " ".join("%s=%s" % kv for kv in sorted(own.items()))))
			for field, langs in fields:
				print("   %-34s %s" % (field, " | ".join(
					"%s: %s" % (lang, langs[lang]) for lang in sorted(langs))))
		return

	stats = collections.defaultdict(lambda: {"objects": 0, "obj_uk": 0,
	                                         "fields": 0, "fld_uk": 0})
	for obj in objects:
		name = obj.get("name")
		if not name:
			continue
		family = report.get(name, {}).get("family") or obj["family"]
		own, fields = object_languages(obj["guid"], name)
		row = stats[family]
		row["objects"] += 1
		row["obj_uk"] += 1 if "uk" in own else 0
		row["fields"] += len(fields)
		row["fld_uk"] += sum(1 for _, langs in fields if "uk" in langs)

	print("%-18s %8s %8s %10s %8s" % ("family", "objects", "obj uk", "fields", "fld uk"))
	print("-" * 56)
	for family, row in sorted(stats.items(), key=lambda kv: -kv[1]["fields"]):
		print("%-18s %8d %8d %10d %8d"
		      % (family, row["objects"], row["obj_uk"], row["fields"], row["fld_uk"]))


if __name__ == "__main__":
	main()
