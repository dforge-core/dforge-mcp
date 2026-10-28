#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""List the distinct collection class GUIDs across a set of objects, with samples,
so each one can be labelled (dimension / resource / attribute / tabular column)."""
from __future__ import print_function

import collections
import sys

import attrs

if __name__ == "__main__":
	objects = attrs.load_json("objects.json")
	types = attrs.load_json("typemap.json")
	report = attrs.load_json("report.json")

	names = sys.argv[1:] or [r["name"] for r in report if r.get("name")]
	seen = collections.OrderedDict()
	for name in names:
		guid, fields = attrs.fields_of(name, objects, types)
		if not fields:
			continue
		family = next((r["family"] for r in report if r["name"] == name), "?")
		for f in fields:
			key = (family, f["collection"])
			entry = seen.setdefault(key, {"count": 0, "samples": []})
			entry["count"] += 1
			if len(entry["samples"]) < 3:
				entry["samples"].append("%s/%s" % (name, f["name"]))

	for (family, guid), entry in sorted(seen.items()):
		print("%-16s %-40s %5d  %s" % (family, guid, entry["count"],
		                               ", ".join(entry["samples"])[:90]))
