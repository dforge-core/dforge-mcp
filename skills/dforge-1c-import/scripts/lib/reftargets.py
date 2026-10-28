#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Does every authored reference point where the 1C attribute actually points?

The generated modules resolve a reference from the attribute's declared type, so they
cannot get this wrong. The authored ones name their target by hand, and a name is a poor
guide: `БазоваяЕдиницаИзмерения` reads like the product's own units and points at the unit
classifier, and `МестоОтгрузки` reads like a counterparty and is not one.

A wrong target costs nothing until the data arrives, and then it is every row: 7,981 of
8,400 products dangled on the first load of `masterdata`.

    python tools/reftargets.py
"""
from __future__ import print_function

import codecs
import json
import os
import sys

import attrs
import autospec
import handmap
import binding

sources = binding.sources()


def ported(mapping):
	"""1C object name -> the entity the port gave it."""
	out = {}
	for module, entities in mapping.items():
		for entity, found in entities.items():
			name = (found.get("object") or "").split(" / ")[0]
			if name and "columns" in found:
				out.setdefault(name, "%s.%s" % (module, entity))
	return out


def main():
	model = autospec.Model()
	path = os.path.join(attrs.OUT, "columnmap.json")
	with codecs.open(path, "r", "utf-8") as f:
		mapping = json.load(f)
	owner = ported(mapping)

	wrong = 0
	for module in sorted(handmap.SPECS):
		for entity, spec in handmap.SPECS[module]["entities"].items():
			declared = sources.SOURCES.get(module, {}).get(entity, {})
			name = declared.get("object")
			if not name:
				continue
			family, section = declared.get("family"), declared.get("section")
			_, columns = model.physical(name, family)
			by_physical = {}
			for field in model.fields(name, family):
				if (field.get("section") or None) != section:
					continue
				physical = autospec.physical_of(field, model, columns)
				if physical:
					by_physical[physical] = field

			for item in spec["fields"]:
				if not item[1].startswith("ref:"):
					continue
				target = item[1][len("ref:"):]
				if "." not in target:
					target = module + "." + target
				physical = mapping[module][entity]["columns"].get(item[0] + "_id")
				field = by_physical.get(physical)
				if not field:
					continue
				declared_targets = [p.strip()[3:].strip()
				                    for p in (field["type"] or "").split(",")
				                    if p.strip().startswith("->")]
				real = [t.split(".", 1)[1] for t in declared_targets if "." in t]
				if not real:
					continue
				expected = [owner.get(r) for r in real]
				if target in expected:
					continue
				wrong += 1
				print("%-10s %-22s %-20s declared %-38s 1C: %s -> %s"
				      % (module, entity, item[0], target, ", ".join(real),
				         ", ".join(str(e) for e in expected)))

	print("\n%d reference(s) pointing at the wrong entity" % wrong)
	return 1 if wrong else 0


if __name__ == "__main__":
	sys.exit(main())
