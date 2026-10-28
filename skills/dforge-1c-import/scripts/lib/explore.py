#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Dump one metadata object's parse tree so its attribute layout can be read off."""
from __future__ import print_function

import codecs
import json
import os
import sys

import meta

OUT = meta.OUT


def find(name):
	with codecs.open(os.path.join(OUT, "objects.json"), "r", "utf-8") as f:
		for row in json.load(f):
			if row.get("name") == name:
				return row["guid"]
	return None


def shape(node, depth, max_depth, path):
	pad = "  " * depth
	if isinstance(node, list):
		strings = [x for x in node if isinstance(x, str) and x and not meta.GUID.match(x)
		           and not x.isdigit()]
		hint = (" <- " + ", ".join(repr(s)[:34] for s in strings[:4])) if strings else ""
		print("%s%s list[%d]%s" % (pad, path, len(node), hint))
		if depth >= max_depth:
			return
		for i, item in enumerate(node):
			if isinstance(item, list):
				shape(item, depth + 1, max_depth, "[%d]" % i)
	else:
		if node:
			print("%s%s = %s" % (pad, path, repr(node)[:70]))


if __name__ == "__main__":
	name = sys.argv[1]
	depth = int(sys.argv[2]) if len(sys.argv) > 2 else 4
	guid = find(name)
	print("%s -> %s\n" % (name, guid))
	node = meta.parse(meta.load(guid))
	label = "root"
	if len(sys.argv) > 3:                       # drill into e.g. 6.2
		for part in sys.argv[3].split("."):
			node = node[int(part)]
		label = "root." + sys.argv[3]
	if "--json" in sys.argv:
		print(json.dumps(node, ensure_ascii=False, indent=1))
	else:
		shape(node, 0, depth, label)
