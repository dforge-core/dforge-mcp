#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Validate generated modules against the dForge platform JSON schemas.

The schemas live in the platform repo, not here. Point DFORGE_SCHEMAS at them, or rely
on the default guess of a sibling checkout.

    python tools/1c.py validate           # every module under modules/
    python tools/1c.py validate fleet     # one module
    python tools/1c.py validate -w        # and list the platform's warnings, not just count them
"""
from __future__ import print_function

import codecs
import json
import os
import re
import sys

import jsonschema

import paths

MODULES = paths.MODULES
SCHEMAS = os.environ.get(
	"DFORGE_SCHEMAS",
	os.path.join(os.path.dirname(paths.ROOT), "dForge-core", "docs", "schemas"))

# module file -> schema file; entities are handled separately, one schema for many files
FILE_SCHEMAS = [
	("manifest.json", "manifest.schema.json"),
	("settings.json", "settings.schema.json"),
	(os.path.join("ui", "data_views.json"), "data_views.schema.json"),
	(os.path.join("ui", "menus.json"), "menus.schema.json"),
	(os.path.join("ui", "folders.json"), "folders.schema.json"),
	(os.path.join("ui", "card_layouts.json"), "card_layouts.schema.json"),
	(os.path.join("security", "roles.json"), "roles.schema.json"),
	("registers.json", "registers.schema.json"),
]


def load(path):
	with codecs.open(path, "r", "utf-8") as f:
		return json.load(f)


def check(doc, schema, label, problems):
	validator = jsonschema.Draft7Validator(schema)
	errors = sorted(validator.iter_errors(doc), key=lambda e: list(e.path))
	for error in errors:
		where = "/".join(str(p) for p in error.path) or "(root)"
		problems.append("%s :: %s :: %s" % (label, where, error.message.split("\n")[0][:160]))
	return not errors


def check_translations(base, entities, problems):
	"""There is no platform schema for translations, so check them against the entities
	they translate: no unknown codes, and no half-translated entity.

	An entity that is absent from the file is not an error. Ukrainian is authored per
	contour as that contour is reviewed, and the platform falls back to the base label
	for anything it does not find; what would be an error is a translated entity with
	some of its fields left behind, because that shows as a card in two languages.
	`coverage()` reports the gap instead."""
	directory = os.path.join(base, "translations")
	if not os.path.isdir(directory):
		return 0
	checked = 0
	for name in sorted(os.listdir(directory)):
		doc = load(os.path.join(directory, name))
		label = "translations/" + name
		for entity_code, entry in doc.get("entities", {}).items():
			entity = entities.get(entity_code)
			if entity is None:
				problems.append("%s :: unknown entity %s" % (label, entity_code))
				continue
			columns = entity["fields"]
			translated = entry.get("fields", {})
			for field in translated:
				if field not in columns:
					problems.append("%s :: %s :: unknown field %s"
					                % (label, entity_code, field))
			missing = [c for c in columns if c not in translated]
			if missing:
				problems.append("%s :: %s :: untranslated: %s"
				                % (label, entity_code, ", ".join(sorted(missing))))
		checked += 1
	return checked


def coverage(base, entities):
	"""How many of a module's entities carry a Ukrainian translation."""
	path = os.path.join(base, "translations", "uk-UA.json")
	if not os.path.isfile(path):
		return 0, len(entities)
	doc = load(path)
	return len(doc.get("entities", {})), len(entities)


# Postgres reserved words (SQL:2016 reserved set as Postgres classifies it). A column
# or table code from this list installs fine through the schemas and then fails the
# import with `db_error: syntax error at or near "..."`, because not every statement
# dForge generates quotes its identifiers. Cheaper to never emit one.
RESERVED = set("""
all analyse analyze and any array as asc asymmetric authorization binary both case cast
check collate collation column concurrently constraint create cross current_catalog
current_date current_role current_schema current_time current_timestamp current_user
default deferrable desc distinct do else end except false fetch for foreign freeze from
full grant group having ilike in initially inner intersect into is isnull join lateral
leading left like limit localtime localtimestamp natural not notnull null offset on only
or order outer overlaps placing primary references returning right select session_user
similar some symmetric table tablesample then to trailing true union unique user using
variadic verbose when where window with
""".split())

# `manifest.schema.json` still carries the pre-release audit vocabulary. The installer
# copies the manifest value straight into `dForge.entity.audit_history`, whose check
# constraint CK_Entity_Audit_History takes 'basic' / 'fields' / 'full' and nothing else,
# so a manifest validated against the published enum fails the install. The DB wins.
AUDIT_HISTORY = ["basic", "fields", "full"]


def check_reserved(entities, problems):
	"""No entity or column may be named after a Postgres reserved word."""
	for entity_code, doc in sorted(entities.items()):
		table = doc.get("dbObject") or entity_code
		if table.lower() in RESERVED:
			problems.append("entities/%s.json :: table %s is a reserved word"
			                % (entity_code, table))
		for field in doc.get("fields", {}):
			if field.lower() in RESERVED:
				problems.append("entities/%s.json :: column %s is a reserved word"
				                % (entity_code, field))


def load_registers():
	"""Every declared register across all modules, keyed "module.register_cd".

	Collected module-wide because a binding may name another module's register, which is
	the whole point of the register being an object: one module owns what it means, and
	anything that depends on it binds rather than restates.
	"""
	declared = {}
	for code in sorted(os.listdir(MODULES)):
		path = os.path.join(MODULES, code, "registers.json")
		if not os.path.isfile(path):
			continue
		for register_cd, definition in load(path).items():
			declared["%s.%s" % (code, register_cd)] = (code, definition)
	return declared


def path_problem(path, owner, owner_cd, entities, code=None):
	"""Why a one-hop reference path `<reference>.<column>` cannot be read, or None.

	The platform reads `dateField`, `map` and `headerMap` values written this way through
	one LEFT JOIN at posting time (`RegisterRegistrar.ValidateRefPathAsync` refuses the same
	things at install). The linked entity is checked only when this module declares it.
	"""
	parts = path.split(".")
	if len(parts) != 2 or not all(parts):
		return "is not a single-hop path '<reference>.<column>'"
	root, target = parts
	field = owner.get("fields", {}).get(root)
	if field is None:
		return "starts at %s, which is not a column of %s" % (root, owner_cd)
	link = field.get("link") or {}
	if field.get("columnType") != "R" or not link.get("entity") or not link.get("thisKey"):
		return "starts at %s.%s, which is not a reference column with a link" % (owner_cd, root)
	module, _, linked_cd = link["entity"].rpartition(".")
	linked = entities.get(linked_cd) if module in ("", code) else None
	if linked is not None:
		column = linked.get("fields", {}).get(target)
		if column is None:
			return "reads %s, which is not a column of %s" % (target, link["entity"])
		if column.get("columnType") in ("R", "S", "F"):
			return "reads %s.%s, which is virtual" % (link["entity"], target)
	return None


# What an EXPRESSION reads: `[column]` off its own row, or `[reference].[column]` one hop
# away. A binding value starting with `=` is an F-column formula the platform translates to
# SQL at posting time (`RegisterEngine.Paths`), and install refuses one reading a column the
# row does not have, a path it cannot follow, or a document column left unfrozen - each of
# which is knowable from the JSON, so it is asked here first.
EXPRESSION_READ = re.compile(r"\[(\w+)\](?:\.\[(\w+)\])?")


def expression_reads(value):
	"""The columns and one-hop paths a `=...` expression reads, as plain names and paths."""
	return [root + "." + target if target else root
	        for root, target in EXPRESSION_READ.findall(value[1:])]


def source_problem(value, owner, owner_cd, entities, code=None):
	"""Why a binding value - column, one-hop path or expression - cannot be read, or None."""
	reads = expression_reads(value) if value.startswith("=") else [value]
	for read in reads:
		if "." in read:
			why = path_problem(read, owner, owner_cd, entities, code)
		elif read not in owner.get("fields", {}):
			why = "reads %s, which is not a column of %s" % (read, owner_cd)
		else:
			why = None
		if why:
			return why
	return None


def locks_of(path, owner):
	"""The document columns that freeze what a value reads: a column itself, a path's
	reference key, every one of those an expression reads."""
	if path.startswith("="):
		return sorted(set(lock for read in expression_reads(path) for lock in locks_of(read, owner)))
	if "." not in path:
		return [path]
	link = owner.get("fields", {}).get(path.split(".")[0], {}).get("link") or {}
	return [c.strip() for c in (link.get("thisKey") or "").split(",") if c.strip()]


def check_registers(code, entities, declared, problems):
	"""What the platform checks at install, checked here instead.

	`RegisterRegistrar.ValidateBindingsAsync` refuses an undeclared register, an unmapped
	required resource and a map naming a column that is not real. All of that is knowable
	from the generated JSON, and finding it here costs a second rather than a failed
	install against a tenant holding 30 M rows.
	"""
	own = {key: value for key, value in declared.items() if key.startswith(code + ".")}

	# The declaration itself: the state entity must exist and carry every dimension and
	# every resource field, or the register keys rows on columns that are not there.
	for register_cd, (owner, definition) in sorted(own.items()):
		entity_cd = definition.get("entity")
		if definition.get("kind") in ("turnover", "accounting"):
			# Neither keeps state. A turnover register IS its journal; an accounting
			# register's postings are, and a balance is read from them. So an `entity`
			# here is a claim about a state table that does not exist.
			if entity_cd:
				problems.append("registers.json :: %s is %s and must name no entity"
				                % (register_cd, definition["kind"]))
			continue
		if not entity_cd:
			problems.append("registers.json :: %s names no entity" % register_cd)
			continue
		entity = entities.get(entity_cd)
		if entity is None:
			problems.append("registers.json :: %s names entity %s, which this module does "
			                "not declare" % (register_cd, entity_cd))
			continue
		columns = entity.get("fields", {})
		for dimension in definition.get("dimensions", []):
			if dimension not in columns:
				problems.append("registers.json :: %s dimension %s is not a column of %s"
				                % (register_cd, dimension, entity_cd))
		for resource, spec in definition.get("resources", {}).items():
			field = spec.get("field", resource)
			if field not in columns:
				problems.append("registers.json :: %s resource %s -> %s is not a column of %s"
				                % (register_cd, resource, field, entity_cd))

	# The bindings: every A column that names a register rather than restating one.
	for entity_cd, entity in sorted(entities.items()):
		for field_cd, field in entity.get("fields", {}).items():
			if field.get("columnType") != "A":
				continue
			params = field.get("params") or {}
			reference = params.get("register")
			where = "entities/%s.json :: %s" % (entity_cd, field_cd)

			if not reference:
				problems.append("%s is an A column that declares its register inline; "
				                "bind a declaration instead" % where)
				continue
			if reference not in declared:
				problems.append("%s binds %s, which no module declares"
				                % (where, reference))
				continue

			definition = declared[reference][1]

			# A line-mode posting reads its values off the line entity; a flat one off the
			# document. Checking the wrong entity would pass a map that cannot resolve.
			source_cd = params.get("lineEntity", entity_cd)
			source = entities.get(source_cd)
			if source is None:
				problems.append("%s posts from %s, which this module does not declare"
				                % (where, source_cd))
				continue
			# `groupLinesBy` reads `map` over a group row: the grouped line columns and
			# every column of the document.
			group = params.get("groupLinesBy") or []
			if group:
				line_fields = source.get("fields", {})
				for column in group:
					if column not in line_fields:
						problems.append("%s groups by %s, which is not a column of %s"
						                % (where, column, source_cd))
				fields = dict(entity.get("fields", {}))
				fields.update((c, line_fields[c]) for c in group if c in line_fields)
				# ...and a numeric line column mapped to a resource, summed over the group.
				resources_declared = definition.get("resources", {})
				fields.update((c, line_fields[c]) for n, c in (params.get("map") or {}).items()
				              if n in resources_declared and c in line_fields)
				source, source_cd = {"fields": fields}, "the group row of " + source_cd
			source_columns = source.get("fields", {})

			mapping = params.get("map") or {}
			dimensions = set(definition.get("dimensions", []))
			resources = definition.get("resources", {})

			# A line posting may take part of the movement off the DOCUMENT. The values
			# of `headerMap` are document columns, the values of `map` are line columns,
			# and the platform refuses the two to name the same field - so they are
			# checked against different tables and then treated as one mapping for the
			# questions that follow, which only ask whether a field is bound at all.
			header_map = params.get("headerMap") or {}
			if header_map:
				if not params.get("lineEntity"):
					problems.append("%s carries a headerMap while posting from the "
					                "document, where every value is the header's already"
					                % where)
				locked = set(params.get("lockedFields") or [])
				for name, column in sorted(header_map.items()):
					if name in mapping:
						problems.append("%s binds %s from both the line and the header"
						                % (where, name))
					if name not in dimensions and name not in resources:
						problems.append("%s takes %s from the header, which %s declares "
						                "as neither a dimension nor a resource"
						                % (where, name, reference))
					elif name in resources and definition.get("kind") != "info":
						# Added once per line otherwise: four lines, four times the value.
						problems.append("%s takes resource %s from the header, and %s is "
						                "a %s register" % (where, name, reference,
						                                   definition.get("kind")))
					if "." in column or column.startswith("="):
						why = source_problem(column, entity, entity_cd, entities, code)
						if why:
							problems.append("%s takes %s from %s, which %s" % (where, name, column, why))
					elif column not in entity.get("fields", {}):
						problems.append("%s takes %s from header column %s, which is not "
						                "a column of %s" % (where, name, column, entity_cd))
					for lock in locks_of(column, entity):
						if lock not in locked:
							# The posting is keyed by it. Change it under a posted document
							# and the reversal looks for a tuple that was never posted to.
							problems.append("%s reads %s off the header without freezing %s "
							                "in lockedFields" % (where, column, lock))
			mapping = dict(header_map, **mapping)

			for name, column in mapping.items():
				if name in header_map and name not in (params.get("map") or {}):
					continue  # checked against the document above, not the line

				if name not in dimensions and name not in resources:
					problems.append("%s maps %s, which %s declares as neither a dimension "
					                "nor a resource" % (where, name, reference))
				# A quoted value is a constant to stamp, not a column to read - which is
				# how a document that asserts one fixed status says so, exactly as the 1C
				# handler assigns an enum value rather than reading a field. The platform
				# accepts it on the header path and the line path alike.
				if column.startswith("'") and column.endswith("'") and len(column) > 2:
					# The platform stamps whatever is between the quotes without looking at
					# it. If the register's column is a dropdown, a value outside its
					# options is a row the UI cannot render and no filter will find, and
					# nothing downstream would say so - so it is said here.
					target = entities.get(definition.get("entity"), {}).get("fields", {})
					options = ((target.get(resources.get(name, {}).get("field", name), {})
					            .get("params") or {}).get("options"))
					if options and column[1:-1] not in [o.get("value") for o in options]:
						problems.append(
							"%s stamps %s into %s, which offers %s"
							% (where, column, name,
							   ", ".join(o.get("value") for o in options)))
					continue
				if "." in column or column.startswith("="):
					why = source_problem(column, source, source_cd, entities, code)
					if why:
						problems.append("%s maps %s -> %s, which %s" % (where, name, column, why))
					continue
				if column not in source_columns:
					problems.append("%s maps %s -> %s, which is not a column of %s"
					                % (where, name, column, source_cd))

			# An unmapped required resource posts a silent zero, so the platform refuses
			# it. A resource only some writers carry is marked optional in the declaration.
			for resource, spec in resources.items():
				if spec.get("required", True) and resource not in mapping:
					problems.append("%s leaves required resource %s of %s unmapped"
					                % (where, resource, reference))

			# A dimension may bind to a column of the same name without being mapped, so
			# an absent one is only wrong when the source has no such column either.
			for dimension in dimensions:
				if dimension not in mapping and dimension not in source_columns:
					problems.append("%s neither maps dimension %s nor carries a column of "
					                "that name" % (where, dimension))

			# A register that dates its journal needs to be told which column supplies it.
			if definition.get("journalDate") and not params.get("dateField"):
				problems.append("%s binds dated register %s but names no dateField"
				                % (where, reference))
			date_field = params.get("dateField")
			if date_field and ("." in date_field or date_field.startswith("=")):
				why = source_problem(date_field, entity, entity_cd, entities, code)
				if why:
					problems.append("%s names dateField %s, which %s" % (where, date_field, why))
			elif date_field and date_field not in entity.get("fields", {}):
				problems.append("%s names dateField %s, which is not a column of %s"
				                % (where, date_field, entity_cd))
			if date_field and definition.get("journalDate"):
				locked = set(params.get("lockedFields") or [])
				if "*" not in locked:
					for lock in locks_of(date_field, entity):
						if lock not in locked:
							# A posted document re-dated, or pointed at another record,
							# leaves what it posted under the old date.
							problems.append("%s reads its date through %s without freezing %s "
							                "in lockedFields" % (where, date_field, lock))


# The schemas say what a file may look like, not whether the module holds together: every
# dependency needs a deps/ contract, every entity a menu opens must be granted to its
# folder, every grid needs a column to draw. The platform checks those in its own CLI, and
# the editor extension runs that same command - so a module this script passed was still
# refused there. Asking the CLI keeps the two from disagreeing again.
def check_static(base, problems, warnings):
	"""The platform's static checks, as `dforge-cli module validate` runs them (tools/lib/cli.py).

	Its warnings are kept apart: they fail nothing, but the editor shows every one of them,
	and a script that dropped them is how 6000 of them went unnoticed.
	"""
	import cli
	try:
		_, text = cli.run(["module", "validate", base, "--json"])
	except SystemExit as missing:
		problems.append("static checks skipped: %s" % missing)
		return
	try:
		result = json.loads(text[text.index("{"):])
	except ValueError:
		problems.append("static checks: the CLI printed no result - %s" % text[:200])
		return
	if result.get("error"):
		problems.append("static checks :: %s" % result["error"])
	for found in result.get("warnings", []):
		warnings.append("%s :: %s" % (found.get("where") or "(module)", found.get("message")))
	for found in result.get("checks", []):
		if not found["ok"]:
			for line in (found.get("message") or "").splitlines():
				if line.strip().startswith("- "):
					problems.append("%s :: %s" % (found["name"], line.strip()[2:]))
			if not any(p.startswith(found["name"] + " ::") for p in problems):
				problems.append("%s :: %s" % (found["name"], found.get("message")))


def validate_module(code, show_warnings=False):
	base = os.path.join(MODULES, code)
	problems, warnings, checked = [], [], 0

	for relative, schema_name in FILE_SCHEMAS:
		path = os.path.join(base, relative)
		schema_path = os.path.join(SCHEMAS, schema_name)
		if not os.path.isfile(path):
			continue
		if not os.path.isfile(schema_path):
			problems.append("%s :: no schema %s" % (relative, schema_name))
			continue
		schema = load(schema_path)
		if schema_name == "manifest.schema.json":
			schema["properties"]["auditHistory"]["enum"] = AUDIT_HISTORY
		check(load(path), schema, relative, problems)
		checked += 1

	entity_schema = load(os.path.join(SCHEMAS, "entity.schema.json"))
	entity_dir = os.path.join(base, "entities")
	entities = {}
	# A module of actions or reports alone has no entities.
	for name in sorted(os.listdir(entity_dir)) if os.path.isdir(entity_dir) else []:
		doc = load(os.path.join(entity_dir, name))
		entities[name[:-len(".json")]] = doc
		check(doc, entity_schema, "entities/" + name, problems)
		checked += 1

	check_reserved(entities, problems)
	check_registers(code, entities, load_registers(), problems)
	checked += check_translations(base, entities, problems)
	check_static(base, problems, warnings)
	translated, total = coverage(base, entities)

	print("%-10s %3d files checked, %d problems, %d warnings, uk %d/%d entities"
	      % (code, checked, len(problems), len(warnings), translated, total))
	for problem in problems:
		print("   %s" % problem)
	for warning in (warnings if show_warnings else []):
		print("   warn %s" % warning)
	return not problems


if __name__ == "__main__":
	if not os.path.isdir(SCHEMAS):
		print("schemas not found at %s - set DFORGE_SCHEMAS" % SCHEMAS)
		sys.exit(2)
	show = "-w" in sys.argv[1:]
	targets = [a for a in sys.argv[1:] if a != "-w"] or sorted(os.listdir(MODULES))
	sys.exit(0 if all([validate_module(c, show) for c in targets]) else 1)
