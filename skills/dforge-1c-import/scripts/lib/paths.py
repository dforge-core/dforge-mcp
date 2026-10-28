# -*- coding: utf-8 -*-
"""Where the working files live.

Every tool used to derive this from its own `__file__`, two directories up, which quietly
assumed the library sits inside the project it serves. It does not have to: the library
is meant to be lifted out and pointed at a different infobase, and the project it is
pointed at is then somewhere else entirely.

So the root is asked for, not assumed. `DF1C_ROOT` names it; without that, the directory
holding `tools/` is used, which is what a project laid out like this one gets for free.
"""
from __future__ import print_function

import os

HERE = os.path.dirname(os.path.abspath(__file__))


def _default_root():
	# tools/lib/paths.py -> tools -> the project root. Only a library sitting in a
	# project's `tools/` has one; a copy anywhere else (an installed skill) would write
	# the dump into its own directory, so it asks instead.
	if os.path.basename(os.path.dirname(HERE)) != "tools":
		raise SystemExit("set DF1C_ROOT to the porting project's directory (and DF1C_PROJECT"
		                 " to its project package): this library is not inside one")
	return os.path.dirname(os.path.dirname(HERE))


ROOT = os.path.abspath(os.environ.get("DF1C_ROOT") or _default_root())

# What the extraction writes and everything downstream reads. Kept separate from ROOT
# because a second infobase dumped beside the first only differs here.
OUT = os.path.abspath(os.environ.get("DF1C_OUT") or os.path.join(ROOT, "out"))

# Generated dForge modules.
MODULES = os.path.abspath(os.environ.get("DF1C_MODULES") or os.path.join(ROOT, "modules"))

# The project's own package - the contour map, the column map and the authored specs.
# `DF1C_PROJECT` points the library at a different one without moving anything.
PROJECT = os.path.abspath(os.environ.get("DF1C_PROJECT")
                          or os.path.join(os.path.dirname(HERE), "project"))


def required(name, what):
	u"""An environment value the library cannot invent, with a default that would be a lie.

	`DF1C_DB` used to default to `utp_biscuit` and `DF_TENANT` to `hbf1` - this project's own
	names, sitting in the library. Harmless while there is one infobase and a trap as soon as
	there are two: pointing the tools at a second configuration and forgetting one variable
	would have read or written the FIRST one, quietly and with the right-looking output. So
	the library asks and stops rather than guessing.
	"""
	value = os.environ.get(name)
	if value:
		return value
	raise SystemExit(
		"%s is not set - %s.\n"
		"    This is the project's to say, not the library's. Copy .env.example to .env and\n"
		"    fill it in, or export the variable for this shell." % (name, what))


def derived(name):
	"""Where a file BUILT FROM THE PROJECT goes, as opposed to one read from the infobase.

	`out/` holds two different kinds of thing. The extraction - report.json, dbnames.json,
	the configuration dump, the module sources - is about the infobase and is the same
	whoever is porting it. `columnmap.json` and `registers.json` are about the PROJECT:
	which of its entities copies which 1C column, which of its modules declares which
	register. Pointing the library at a second project and rebuilding the first kind is
	free; rebuilding the second kind on top of the first project's copy destroys it.

	Which is what happened: one `columnmap` run against the standard-configuration project
	overwrote the client port's map with 21 modules the client port has never heard of.
	`migrate` reads that file, so the next load would have copied by a map for other
	entities entirely - and the file is committed, so the damage outlives the session.

	The default project keeps writing where it always did, so nothing that exists moves.
	Any other project gets a subdirectory named after it.
	"""
	if os.path.basename(PROJECT) == "project":
		return os.path.join(OUT, name)
	folder = os.path.join(OUT, os.path.basename(PROJECT))
	if not os.path.isdir(folder):
		os.makedirs(folder)
	return os.path.join(folder, name)


def show():
	for name in ("ROOT", "OUT", "MODULES", "PROJECT"):
		print("%-8s %s" % (name, globals()[name]))
