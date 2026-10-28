#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Which 1C column each ported column is copied from.

This is what a direct data copy stands on, and the one mapping that cannot be guessed
from names: 1C stores an attribute in `_Fld2036`, and only DBNames knows which attribute
that is - it keys a `Fld` entry by the attribute's own GUID. The same holds for tabular
sections (`VT`) and their line numbers (`LineNo`).

The map is built by `autospec` while it generates the entities, not derived afterwards,
so it cannot drift from the schema it is a map into.

    python tools/columnmap.py             # coverage per module   -> out/columnmap.json
    python tools/columnmap.py <module>    # one module, column by column
"""
from __future__ import print_function

import codecs
import collections
import json
import os
import sys

import attrs
import paths
import autospec
import handmap
import naming
import binding

sources = binding.sources()


def hand_written(model, mapped):
	"""Fold the authored modules in, resolving `sources.py` to physical columns."""
	resolved = collections.OrderedDict()
	for module, spec in handmap.SPECS.items():
		entities = collections.OrderedDict()
		for entity, entity_spec in spec["entities"].items():
			declared = sources.SOURCES.get(module, {}).get(entity, {})
			object_name = declared.get("object")
			if not object_name:
				continue
			family = declared.get("family")
			section = declared.get("section")
			table, columns = model.physical(object_name, family)
			if declared.get("table"):
				# DBNames resolves an object to its own table and a section to a `_VT`
				# one. A chart of accounts keeps what each account declares in neither -
				# `_Acc34_ExtDim780` has no metadata name to resolve from - so the
				# project names the table and the columns are read off it.
				table = declared["table"]
				columns = model.table_columns(table)

			fields = model.fields(object_name, family)
			by_name = dict((f["name"], f) for f in fields
			               if (f.get("section") or None) == section)
			if section:
				guid = next((f.get("sectionGuid") for f in fields
				             if f.get("section") == section), None)
				suffix = model.vt.get(guid)
				table = (table + suffix) if (table and suffix) else None
				columns = model.table_columns(table)

			found = handmap.propose(module, entity, entity_spec, model)
			# A reference is stored in the hidden FK beside it, so that is the column
			# the copy fills - `head_party` is declared, `head_party_id` is written.
			# a field's type is a short string ("ref:...", "drop1c:...") or a column spec dict
			kinds = dict((f[0], f[1] if isinstance(f[1], str) else "") for f in entity_spec["fields"])

			def target(column):
				return (column + "_id"
				        if kinds.get(column, "").startswith("ref:") else column)

			# `drop1c:` names the 1C enum a dropdown's options were read from, and
			# that is what the migration needs to turn a GUID back into a code.
			enums = collections.OrderedDict()
			for item in entity_spec["fields"]:
				if isinstance(item[1], str) and item[1].startswith("drop1c:"):
					declared_enum = autospec.enum_spec(
						model, item[1][len("drop1c:"):])
					if declared_enum and declared_enum["source"]:
						enums[item[0]] = declared_enum["source"]

			# Where the port chose its own codes rather than taking the enum's, the
			# mapping is declared; the option list stays positional, because
			# `_EnumOrder` is what the decoder has to work with.
			for (owner, name, column), (enum, values) in sources.ENUMS.items():
				if owner != module or name != entity:
					continue
				declared_enum = autospec.enum_spec(model, enum)
				if declared_enum and declared_enum["source"]:
					held = declared_enum["source"]
					# The enum's options come pinned to what the map already holds (autospec's
					# PINNED_ENUMS), and that is this mapping's output - the port's own codes -
					# from the second run on; a code that is already one of ours stays as it is.
					ours = set(values.values())
					enums[column] = {
						"table": held["table"],
						"options": [code if code in ours else values.get(code)
						            for code in held["options"]],
					}

			tablerefs = dict(
				(column, dict((str(number), code) for number, code in table.items()))
				for (owner, name, column), table in sources.TABLEREFS.items()
				if owner == module and name == entity)

			pairs, joined = {}, {}
			if section:
				line_number = model.line_no.get(guid)
				if line_number in columns:
					pairs["line_no"] = line_number
			else:
				pairs[entity + "_id"] = "_IDRRef"
			for column, source, _how in (found[0] if found else []):
				if source == "(standard)":
					for candidate in autospec.STANDARD_PHYSICAL.get(column, []):
						if candidate in columns:
							pairs[target(column)] = candidate
							break
					continue
				if source.startswith("_"):
					# `_Table._Column` is a column the entity's own table does not
					# have: the query in QUERIES joins it in. The loader selects it
					# by its bare name, but it is the other table that says what type
					# it is, so which table that is travels with the map.
					held, _, single = source.rpartition(".")
					if held:
						if single in model.table_columns(held):
							pairs[target(column)] = single
							joined[single] = held
						continue
					if source in columns or sources.QUERIES.get((module, entity)):
						# A declared query may produce a column the table has not got -
						# the accounting pivot folds 1C's analytic ROWS into eight slot
						# COLUMNS. The query names them, so they belong in the map; the
						# schema dump describes the table and knows nothing of them.
						pairs[target(column)] = source
					continue
				field = by_name.get(source)
				physical = autospec.physical_of(field, model, columns) if field else None
				if physical:
					pairs[target(column)] = physical

			entities[entity] = {"object": object_name, "family": family or "",
			                    "table": table, "columns": pairs,
			                    "joined": joined,
			                    "enums": enums, "tablerefs": tablerefs}
			declared_query = sources.QUERIES.get((module, entity))
			if declared_query:
				entities[entity]["query"] = " ".join(declared_query.split())
		resolved[module] = entities
	return resolved


def register_entities(model, mapped):
	"""Where an overlay ENTITY's rows come from, for a generated module.

	A balance register's state has no 1C original: the infobase holds the movements and
	sums them on every read, so there is no table to derive the entity from and the
	overlay introduces it. `sources.SOURCES` then says which 1C object its rows are
	GROUPED from, and `sources.QUERIES` how.

	Resolved the way an authored module's entities are - by 1C attribute name through
	DBNames - so that no `_Fld` is written down in the project. Without this the entity
	has no mapped source at all: the map is built from what autospec extracted, and
	autospec cannot extract a table the infobase does not have.

	The state of a register that declares a `journal` has no 1C source at all and is
	skipped: it is rebuilt from the journal in the tenant (`seedstate`), so the two can
	never disagree about what was summed.
	"""
	for module, overlay in binding.registers().items():
		seeded = set(d.get("entity") for d in (overlay.get("defs") or {}).values()
		             if d.get("kind") == "balance" and d.get("journal"))
		for entity, spec in (overlay.get("entities") or {}).items():
			# Neither is an entity with a 1C source: a seeded state is rebuilt from its
			# journal, and a `computed` one is written by the platform - a document's
			# ledger postings, filled when it is posted. Nothing is copied into either.
			if entity in seeded or spec.get("computed"):
				continue
			declared = sources.SOURCES.get(module, {}).get(entity, {})
			object_name = declared.get("object")
			if not object_name:
				raise KeyError("sources.py: %s.%s is introduced by the register overlay "
				               "and has no SOURCES entry saying what it is grouped from"
				               % (module, entity))
			family = declared.get("family")
			table, columns = model.physical(object_name, family)
			by_name = dict((f["name"], f) for f in model.fields(object_name, family))

			# A reference is declared by its visible name and stored in the hidden FK
			# beside it, exactly as on the authored path: `product` is declared,
			# `product_id` is filled.
			kinds = dict((f[0], f[1]) for f in spec["fields"])

			resolved = collections.OrderedDict()
			resolved[entity + "_id"] = "_IDRRef"
			for ours, theirs in sorted((declared.get("columns") or {}).items()):
				field = by_name.get(theirs)
				physical = (autospec.physical_of(field, model, columns) if field
				            else (theirs if theirs in columns else None))
				if not physical:
					raise KeyError("sources.py: %s.%s reads %r, which %s does not have"
					               % (module, entity, theirs, object_name))
				target = (ours + "_id"
				          if str(kinds.get(ours, "")).startswith("ref:") else ours)
				resolved[target] = physical

			found = collections.OrderedDict([
				("object", object_name), ("family", family or ""), ("table", table),
				("columns", resolved), ("joined", {}), ("enums", {}), ("tablerefs", {}),
			])
			query = sources.QUERIES.get((module, entity))
			if query:
				found["query"] = " ".join(query.split())
			mapped.setdefault(module, collections.OrderedDict())[entity] = found
	return mapped


def register_load(mapped):
	"""Fold the register overlay's `load` in: a second ported column off one 1C column.

	A turnover register wants a magnitude and a direction where the infobase keeps a signed
	value, so one `_Fld` feeds two of our columns and each is converted differently. The
	overlay names the ported column whose source to reuse rather than the physical column
	itself, which keeps DBNames the only thing that resolves an `_Fld` - naming
	`_Fld17248` here would be the cardinality mistake in another costume.
	"""
	for module, overlay in binding.registers().items():
		for entity, columns in (overlay.get("load") or {}).items():
			found = mapped.get(module, {}).get(entity)
			if found is None:
				raise KeyError("registers.py: %s has no mapped entity %r to load into"
				               % (module, entity))
			sources_of = found.setdefault("columns", {})
			transforms = found.setdefault("transforms", {})
			for column, how in sorted(columns.items()):
				borrowed = how["from"]
				if borrowed not in sources_of:
					raise KeyError("registers.py: %s.%s reads %r, which has no 1C source"
					               % (module, entity, borrowed))
				sources_of[column] = sources_of[borrowed]
				transforms[column] = how["transform"]
	return mapped


def build():
	"""(module, entity) -> {table, columns}, alongside the generated entities."""
	generated, model = autospec.build()
	out = collections.OrderedDict()
	for (module, entity), found in autospec.COLUMNS.items():
		# A declared query counts for a generated entity too. It was only attached on the
		# hand-written path, so the chart of accounts - generated, and needing a query to
		# decode `_Kind` into a code - silently went on being read straight from its table.
		declared_query = sources.QUERIES.get((module, entity))
		if declared_query:
			found = dict(found, query=" ".join(declared_query.split()))
		out.setdefault(module, collections.OrderedDict())[entity] = found
	for module, entities in hand_written(model, out).items():
		out.setdefault(module, collections.OrderedDict()).update(entities)
	# Before `register_load`, which needs the entity to be mapped before it can borrow a
	# source for a second column of it.
	register_entities(model, out)
	return generated, register_load(out)


def coverage(generated, mapped):
	"""How many of a module's columns have somewhere to be copied from.

	A column with no source is not a defect by itself - the primary key of a register is
	generated here, and a set column has no storage at all - but the count is what says
	whether a contour is ready to be migrated.
	"""
	# The authored modules are not in `generated` - autospec never built them - so their
	# entities come from the specs themselves.
	everything = collections.OrderedDict()
	for module, entities in generated.items():
		everything.setdefault(module, collections.OrderedDict()).update(entities)
	for module, spec in handmap.SPECS.items():
		everything.setdefault(module, collections.OrderedDict()).update(spec["entities"])

	rows = []
	for module, entities in everything.items():
		total = matched = 0
		missing = []
		for entity, spec in entities.items():
			found = mapped.get(module, {}).get(entity, {})
			columns = found.get("columns", {})
			# Only physical columns can have a source. A Reference column is virtual -
			# the FK beside it is what holds the value - and so is a set column.
			# A type spec may be a dict handed straight through (genmodule.parse_type).
			names = set(f[0] + "_id" if not isinstance(f[1], dict) and f[1].startswith("ref:")
			            else f[0]
			            for f in spec["fields"])
			names.add(entity + "_id" if not spec.get("lineOf") else "line_no")
			total += len(names)
			matched += len(names & set(columns))
			missing.extend((entity, n) for n in sorted(names - set(columns)))
		rows.append((module, matched, total, missing))
	return rows


def main():
	generated, mapped = build()
	wanted = sys.argv[1] if len(sys.argv) > 1 else None

	if wanted:
		for entity, found in mapped.get(wanted, {}).items():
			print("\n%s  <-  %s  (%s)"
			      % (entity, found.get("table") or "-", found.get("object")))
			for column, source in sorted(found.get("columns", {}).items()):
				print("   %-44s %s" % (column, source))
		return

	path = paths.derived("columnmap.json")
	with codecs.open(path, "w", "utf-8") as f:
		f.write(json.dumps(mapped, ensure_ascii=False, indent="\t", sort_keys=False))
		f.write("\n")

	print("%-12s %10s %10s %8s" % ("module", "mapped", "columns", "covered"))
	print("-" * 44)
	grand_matched = grand_total = 0
	unmapped = []
	for module, matched, total, missing in coverage(generated, mapped):
		grand_matched += matched
		grand_total += total
		unmapped.extend((module,) + item for item in missing)
		print("%-12s %10d %10d %7d%%"
		      % (module, matched, total, 100 * matched // max(total, 1)))
	print("-" * 44)
	print("%-12s %10d %10d %7d%%"
	      % ("total", grand_matched, grand_total,
	         100 * grand_matched // max(grand_total, 1)))

	if unmapped:
		print("\n%d column(s) with no source, first 20:" % len(unmapped))
		for module, entity, column in unmapped[:20]:
			print("   %-10s %-40s %s" % (module, entity, column))
	print("\n-> %s" % path)


if __name__ == "__main__":
	main()
