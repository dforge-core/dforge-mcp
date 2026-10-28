#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Propose the 1C source of every column in a hand-written spec.

`fleet`, `shipping` and `masterdata` were authored, so their column names were chosen
rather than generated, and nothing in the package records which 1C attribute each one
came from. The migration needs exactly that.

Most of it can be proposed rather than typed: the names were chosen *from* the 1C
attributes, so running the attribute through `naming.code` lands on the same word most of
the time - `БазоваяЕдиницаИзмерения` gives `base_uom_measure` against a column called
`base_uom`. This scores those candidates and prints what it is sure of, what it guessed
and what it could not place, so the confirmed result can go into `sources.py` and the
remainder can be decided by eye.

    python tools/handmap.py                  # every hand-written module
    python tools/handmap.py masterdata       # one of them
"""
from __future__ import print_function

import collections
import sys

import autospec
import naming
import binding

sources = binding.sources()

# The authored modules, whichever the project happens to have.
SPECS = binding.specs()

# Columns the 1C object carries in its own right rather than as an attribute; these are
# resolved from the physical table, exactly as `autospec` resolves them.
STANDARD = set(autospec.STANDARD_PHYSICAL)


def tokens(code):
	return set(code.split("_"))


def score(column, candidate):
	"""How well a 1C attribute's generated code matches a hand-chosen column name."""
	if column == candidate:
		return 100
	ours, theirs = tokens(column), tokens(candidate)
	if not ours or not theirs:
		return 0
	shared = ours & theirs
	if not shared:
		return 0
	# Every word of the shorter name present in the longer one is a strong signal:
	# `base_uom` against `base_uom_measure`.
	if ours <= theirs or theirs <= ours:
		return 90 - abs(len(ours) - len(theirs))
	return int(60 * len(shared) / float(len(ours | theirs)))


def propose(module, entity, spec, model):
	"""(confirmed, guessed, unplaced) for one entity."""
	declared = sources.SOURCES.get(module, {}).get(entity, {})
	object_name = declared.get("object")
	if not object_name:
		return None

	family = declared.get("family")
	section = declared.get("section")
	fields = [f for f in model.fields(object_name, family)
	          if (f.get("section") or None) == section and not naming.is_dead(f["name"])]
	candidates = [(naming.code(f["name"], 48), f) for f in fields]

	manual = declared.get("columns", {})
	confirmed, guessed, unplaced = [], [], []
	taken = set(manual.values())

	for item in spec["fields"]:
		column = item[0]
		if column in manual:
			confirmed.append((column, manual[column], "declared"))
			continue
		if column in STANDARD:
			confirmed.append((column, "(standard)", "standard"))
			continue
		# Sorted on the score and the code only. Two candidates scoring the same
		# under the same code made the tuple comparison reach the field dicts, which
		# do not compare - a latent defect until an object turned up whose attributes
		# generate the same code twice.
		ranked = sorted(
			((score(column, code), code, field) for code, field in candidates
			 if field["name"] not in taken),
			key=lambda ranked_row: (ranked_row[0], ranked_row[1]), reverse=True)
		if ranked and ranked[0][0] >= 90:
			confirmed.append((column, ranked[0][2]["name"], "matched"))
			taken.add(ranked[0][2]["name"])
		elif ranked and ranked[0][0] >= 40:
			guessed.append((column, ranked[0][2]["name"], ranked[0][0]))
		else:
			unplaced.append(column)

	spare = [f["name"] for _, f in candidates if f["name"] not in taken]
	return confirmed, guessed, unplaced, spare, object_name


def main():
	model = autospec.Model()
	wanted = sys.argv[1] if len(sys.argv) > 1 else None
	totals = collections.Counter()

	for module, spec in SPECS.items():
		if wanted and module != wanted:
			continue
		print("\n=== %s ===" % module)
		for entity, entity_spec in spec["entities"].items():
			found = propose(module, entity, entity_spec, model)
			if found is None:
				print("\n%-28s no 1C object declared in sources.py" % entity)
				totals["undeclared"] += len(entity_spec["fields"])
				continue
			confirmed, guessed, unplaced, spare, object_name = found
			totals["confirmed"] += len(confirmed)
			totals["guessed"] += len(guessed)
			totals["unplaced"] += len(unplaced)
			print("\n%-28s <- %s   (%d confirmed, %d to check, %d unplaced)"
			      % (entity, object_name, len(confirmed), len(guessed), len(unplaced)))
			for column, name, how in confirmed:
				if how == "matched":
					print("   ok    %-34s %s" % (column, name))
			for column, name, points in guessed:
				print("   ?%-3d  %-34s %s" % (points, column, name))
			for column in unplaced:
				print("   --    %-34s" % column)
			if spare:
				print("   1C attributes nothing claimed: %s" % ", ".join(spare[:8]))

	print("\n%d confirmed, %d to check by eye, %d unplaced, %d in undeclared entities"
	      % (totals["confirmed"], totals["guessed"], totals["unplaced"],
	         totals["undeclared"]))


if __name__ == "__main__":
	main()
