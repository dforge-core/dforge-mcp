#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Build typeGuid -> object map.

An attribute typed "СправочникСсылка.рзАвтотранспортныеПредприятия" does not carry
the catalog's object GUID; it carries one of the *type* GUIDs the catalog declares
for itself, in a block near the top of its own file:

    {1,
    {53,dc8f143c-...,899caee9-...,489d7014-...,...}

Every GUID in that block belongs to that one object, so mapping all of them is
enough to resolve any reference back to its target.
"""
from __future__ import print_function

import codecs
import collections
import json
import os
import re
import sys

import meta

OUT = meta.OUT

# Every object file opens as  {1,\r\n{53,<its own type guids>,{0,{1,...identity...
# The type guids are the unbroken GUID run that follows the two leading counts.
HEAD = re.compile(r"^\{\d+,\s*\{\d+,\s*((?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
                  r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12},\s*)+)")


def own_type_guids(text):
	m = HEAD.match(text)
	if not m:
		return []
	return re.findall(r"[0-9a-fA-F-]{36}", m.group(1))


def main():
	with codecs.open(os.path.join(OUT, "objects.json"), "r", "utf-8") as f:
		objects = json.load(f)

	type_map = {}
	clashes = 0
	for obj in objects:
		text = meta.load(obj["guid"])
		if text is None:
			continue
		guids = own_type_guids(text)
		for i, g in enumerate(guids):
			if g in type_map and type_map[g]["guid"] != obj["guid"]:
				clashes += 1
				continue
			type_map[g] = {"guid": obj["guid"], "name": obj["name"],
			               "family": obj["family"], "index": i + 1}
		# the object GUID itself is sometimes used directly as a type
		type_map.setdefault(obj["guid"], {"guid": obj["guid"], "name": obj["name"],
		                                  "family": obj["family"], "index": 0})

	with codecs.open(os.path.join(OUT, "typemap.json"), "w", "utf-8") as f:
		json.dump(type_map, f, ensure_ascii=False, indent="\t")
	print("objects=%d  type guids mapped=%d  clashes=%d" % (len(objects), len(type_map), clashes))

	# sanity check against a reference we already resolved by hand
	probe = type_map.get("489d7014-f13e-4dc7-ae5e-e5c51da99ea2")
	print("probe 489d7014 ->", probe)


if __name__ == "__main__":
	main()
