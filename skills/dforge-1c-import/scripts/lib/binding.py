# -*- coding: utf-8 -*-
"""What the library needs from the project it is pointed at.

The library knows 1C and it knows dForge. What it cannot know is this infobase: which
object belongs to which module, which 1C column feeds which ported one, and what the
hand-written modules look like. That is the project's to say, and this is the whole of
what it has to say - five names, no more.

Everything here is imported by name from the directory `paths.PROJECT` names, so the
library never mentions a project module and a different infobase is a different
directory rather than a different library.
"""
from __future__ import print_function

import os
import sys

import paths

# What a project must provide, and what for. A project missing one of these fails here,
# naming the file, rather than somewhere downstream as an AttributeError.
REQUIRED = [
	("contours", ["CONTOURS", "CODES"], "which object belongs to which module"),
	("sources", ["SOURCES"], "which 1C column feeds each authored column"),
]

# And what a project may provide. Absent, the library does that much less rather than fail.
OPTIONAL = [
	("registers", ["REGISTERS"], "registers declared over the generated entities"),
	("regulated", ["FORMS"], "the regulated statements this configuration holds"),
	("vocabulary", ["TERMS", "LATIN"], "this company's own proper nouns"),
]

_loaded = {}


def _module(name):
	if name in _loaded:
		return _loaded[name]
	if paths.PROJECT not in sys.path:
		sys.path.insert(0, paths.PROJECT)
	try:
		_loaded[name] = __import__(name)
	except ImportError:
		raise ImportError(
			"the project at %s has no %s.py - see binding.REQUIRED for what a project"
			" has to provide" % (paths.PROJECT, name))
	return _loaded[name]


def contours():
	"""The contour map: CONTOURS, CODES, EXTENSIONS, DONE, names()."""
	return _module("contours")


def client_prefixes():
	u"""The prefixes the integrator's own objects carry (`мсбЗаказ`, `рзТранспорт`).

	Which objects are the client's rather than the vendor's is this configuration's
	convention, so the project names it in `contours.CLIENT_PREFIXES`. Absent, nothing
	counts as the client's - the reports then say so, rather than guessing a convention.
	"""
	return tuple(getattr(contours(), "CLIENT_PREFIXES", ()) or ())


def toolkit_prefixes():
	u"""The prefixes of a third-party toolkit embedded in the configuration (`ир`, `ит`):
	neither the vendor's nor the client's, and dropped from names like the client's."""
	return tuple(getattr(contours(), "TOOLKIT_PREFIXES", ()) or ())


def hand_entities():
	u"""1C object name -> `module.entity` for the objects an authored spec already owns.

	A reference to one of them resolves to that entity rather than generating a second
	copy of it. `contours.HAND_ENTITIES`; absent, everything is generated.
	"""
	return dict(getattr(contours(), "HAND_ENTITIES", {}) or {})


def sources():
	"""The column map for authored modules: SOURCES, ENUMS, QUERIES, TABLEREFS."""
	return _module("sources")


def registers():
	"""Registers declared over the GENERATED entities, module code -> overlay.

	An authored spec says what its registers are inline. A generated module has no spec
	to say it in, and the alternative - authoring all 61 entities of a contour by hand to
	reach the two that are a register - is not one. So a project may name them separately,
	and this is the whole of that overlay:

	    REGISTERS = {"production": {
	        "defs":     {<register code>: <the registers.json declaration>},
	        "entities": {<entity>: <an entity spec, autospec's shape>},
	        "retype":   {<entity>: {<column>: <field spec>}},
	        "fields":   {<entity>: [(name, spec, label), ...]},   # the recorder column
	        "bind":     {<document entity>: {<column>: <the A column>}},
	        "constraints": {<entity>: {<name>: <constraint>}},
	        "load":     {<entity>: {<column>: {"from": <column>, "transform": <name>}}},
	        "uk":       {<entity>: {<column>: <Ukrainian label>}},
	    }}

	This list went stale once already - it named four of the sections while the generator
	applied seven - so it is the whole of the overlay again, and `apply_registers` applies
	them in this order.

	`entities` introduces an entity the infobase has no original for. The case it exists
	for is a BALANCE register's state: dForge keeps the running total in a table of its
	own, and 1C keeps no such table, holding the movements and computing the balance from
	them on every read. `retype` corrects a column the generator typed from the physical
	schema and the register needs typed as what it means. `constraints` declares, as a real
	CHECK, an invariant a 1C handler kept by refusing to post.

	`load` is for a column the register needs that 1C does not hold in that shape - a
	turnover register's direction, which the infobase keeps as the SIGN of the value. It
	names the ported column whose already-resolved 1C source to read again, so DBNames
	stays the only thing that resolves a physical column, and `migrate.TRANSFORMS` says
	what each name does.

	Optional: a project with no registers.py generates exactly what it did before.
	"""
	try:
		module = _module("registers")
	except ImportError:
		return {}
	return getattr(module, "REGISTERS", {}) or {}


def forms():
	"""The regulated statements, as a list of no-argument builders, in reporting order.

	Each builder reads one 1C regulated form and returns the `statements.Form` it filled -
	so the library knows how such a form is STORED and read, and the project knows which
	forms this configuration holds and what is peculiar about each. The peculiar part is
	never small enough to guess: which module of the several editions is current, which of
	its branches are dead, what its `2`-suffixed helpers mean, and whatever it does that no
	regex should be asked to read.

	Optional: a project with no regulated.py reads no statements, which is not an
	error. The name is not `forms.py` because the library already has one of those,
	for the 1C INTERFACE forms, and it would shadow this on the import path.
	"""
	try:
		module = _module("regulated")
	except ImportError:
		return []
	return list(getattr(module, "FORMS", ()) or ())


def terms():
	"""This company's own proper nouns in Ukrainian - abbreviations, plants, customers.

	The library carries the language; a project carries the names that are not language.
	Without this, another configuration's company names would be transliterated into the
	first one's. The module is `vocabulary.py` and not `terms.py` because the library
	already has a `terms.py`, which would shadow it on the import path.
	"""
	return _optional("vocabulary", "TERMS")


def vocabulary():
	"""The same proper nouns in Latin, for the identifiers the port generates."""
	return _optional("vocabulary", "LATIN")


def _optional(module_name, attribute):
	try:
		module = _module(module_name)
	except ImportError:
		return {}
	return getattr(module, attribute, {}) or {}


AUTHORED = "authored"


def authored(module):
	"""The project's hand-written files for one module, or None.

	A generated module is rewritten whole on every `genmodule`, so a file added to it by
	hand - an action, its DSL script - is gone the next time it runs. What the generator
	cannot derive from the infobase is kept in the project instead, under
	`authored/<module>/`, laid out exactly as it is in the module, and copied in when the
	module is emitted:

	    authored/production/ui/actions.json
	    authored/production/logic/actions/post_report.dsl
	    authored/production/translations/uk-UA.json   # merged into the generated one

	A translations file is MERGED into the one the generator writes, the authored value
	winning, because the generated file already holds every entity's Ukrainian and the
	authored one only adds to it - its actions and their messages. Every other file is
	copied as it stands, and one the generator also writes is refused rather than
	silently replaced.

	Optional: a module with no such directory is emitted exactly as before.
	"""
	path = os.path.join(paths.PROJECT, AUTHORED, module)
	return path if os.path.isdir(path) else None


def specs():
	"""The authored modules, code -> SPEC, in the order the project lists them.

	A project that authors nothing returns an empty map and everything is generated.
	"""
	found = {}
	for name in sorted(os.listdir(paths.PROJECT)):
		if not name.startswith("spec_") or not name.endswith(".py"):
			continue
		module = _module(name[:-3])
		spec = getattr(module, "SPEC", None)
		if spec:
			found[spec.get("code") or name[len("spec_"):-3]] = spec
	return found


def check():
	"""Is the project complete enough to run against? Returns what is missing."""
	missing = []
	for name, names, why in REQUIRED:
		try:
			module = _module(name)
		except ImportError:
			missing.append("%s.py is absent - %s" % (name, why))
			continue
		for attribute in names:
			if not hasattr(module, attribute):
				missing.append("%s.py declares no %s - %s" % (name, attribute, why))
	return missing


def main():
	paths.show()
	print("specs    %s" % ", ".join(sorted(specs())) or "(none)")
	overlay = registers()
	print("registers %s" % ", ".join(
		"%s:%d" % (module, len((o.get("defs") or {}))) for module, o in sorted(overlay.items()))
		or "(none)")
	root = os.path.join(paths.PROJECT, AUTHORED)
	print("authored %s" % (", ".join(sorted(
		name for name in os.listdir(root) if os.path.isdir(os.path.join(root, name))))
		if os.path.isdir(root) else "(none)"))
	builders = forms()
	print("forms    %d declared" % len(builders) if builders else "forms    (none)")
	print("vocabulary %d Ukrainian, %d Latin" % (len(terms()), len(vocabulary())))
	problems = check()
	for line in problems:
		print("   %s" % line)
	print("%d problem(s)" % len(problems))
	return 1 if problems else 0


if __name__ == "__main__":
	sys.exit(main() or 0)
