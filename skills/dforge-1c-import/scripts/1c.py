#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
One way in, so the split between library and project stays a fact rather than a habit.

    python tools/1c.py <command> [args...]
    python tools/1c.py --list          # what there is
    python tools/1c.py --boundary      # does the library still stand on its own?

`tools/lib` is 1C and dForge: how a configuration is stored, how its metadata parses,
what the physical tables mean, and how rows are copied and checked. It is meant to be
lifted out and pointed at a different infobase.

`tools/project` is this infobase: which object belongs to which module, which 1C column
feeds each ported one, which regulated statements it holds, this company's own proper
nouns, and the modules written by hand. `DF1C_PROJECT` points the library at a different
one; `binding.py` lists the whole of what a project has to provide.

Both directories go on the path, so the modules import each other by plain name and a
move between them costs no edits. That convenience is also the hazard, so `--boundary`
checks two things rather than trusting either: that no library module IMPORTS a project
one, and that no library module NAMES this project's world - its server, its infobase,
its tenant, its company's abbreviations. A literal is the quiet way to bind a library to
one configuration, and it is how `DF1C_DB` came to default to `utp_biscuit` for months.

Because both directories are on one path, a project module may not take a name the
library already uses: `regulated.py` rather than `forms.py`, `vocabulary.py` rather than
`terms.py`. `--boundary` catches the shadowing as an import crossing.
"""
from __future__ import print_function

import io
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.path.join(HERE, "lib")
PROJECT = os.path.abspath(os.environ.get("DF1C_PROJECT") or os.path.join(HERE, "project"))

for entry in (PROJECT, LIB):
	if entry not in sys.path:
		sys.path.insert(0, entry)


def commands():
	"""Every runnable module, library or project, mapped to (path, first docstring line)."""
	found = {}
	for directory in (LIB, PROJECT):
		for name in sorted(os.listdir(directory)):
			if not name.endswith(".py") or name.startswith("_") or name[:-3] in found:
				continue
			path = os.path.join(directory, name)
			summary = _runnable(path)
			if summary is not None:
				found[name[:-3]] = (path, summary)
	return found


def _runnable(path):
	"""The module's first docstring line if it can be run as a script, else None."""
	with io.open(path, encoding="utf-8") as f:
		text = f.read()
	# Anything runnable: most define main(), a few only a __main__ block.
	if "def main(" not in text and "__name__" not in text:
		return None
	if '"""' not in text:
		return ""
	body = text.split('"""', 2)[1].strip().splitlines()
	return (body[0] if body else "").strip()


def boundary():
	"""Two ways the library can stop standing on its own, both read off the source.

	IMPORTS. The path puts both directories in reach, so nothing stops a library module
	importing `contours` directly and nothing would complain until someone tried to lift
	the library out.

	NAMES. An import is the loud way to bind to one infobase; a literal is the quiet one.
	`DF1C_DB` defaulting to `utp_biscuit` and `DF_TENANT` to `hbf1` sat in the library for
	a long while, harmless with one infobase and a trap with two - point the tools at a
	second configuration, forget one variable, and they read the first one with
	right-looking output. So the names of THIS project's world are refused in the library,
	including in its comments, since a stale comment is how the next reader learns the
	wrong thing.

	The list is read from the project rather than written here, so a project that renames
	itself does not have to remember this file.
	"""
	import ast
	import re

	project_modules = set(n[:-3] for n in os.listdir(PROJECT) if n.endswith(".py"))

	# What this project calls itself: the infobase, the tenant and its own proper nouns.
	reserved = set()
	for variable in ("DF1C_DB", "DF1C_SERVER", "DF_TENANT"):
		value = os.environ.get(variable)
		if value:
			reserved.add(value.lower())
	env_example = os.path.join(os.path.dirname(os.path.abspath(PROJECT)), os.pardir,
	                           ".env.example")
	if os.path.exists(env_example):
		with io.open(env_example, encoding="utf-8") as f:
			for line in f:
				match = re.match(r"\s*(DF1C_DB|DF1C_SERVER|DF_TENANT)\s*=\s*(\S+)", line)
				if match:
					reserved.add(match.group(2).lower())
	terms = os.path.join(PROJECT, "terms.py")
	if os.path.exists(terms):
		with io.open(terms, encoding="utf-8") as f:
			for value in re.findall(r'u"([^"]+)"\s*:', f.read()):
				if len(value) > 3:      # two- and three-letter forms collide with real words
					reserved.add(value.lower())

	problems = []
	for name in sorted(os.listdir(LIB)):
		if not name.endswith(".py"):
			continue
		with io.open(os.path.join(LIB, name), encoding="utf-8") as f:
			text = f.read()
		tree = ast.parse(text)
		for node in ast.walk(tree):
			named = []
			if isinstance(node, ast.Import):
				named = [a.name.split(".")[0] for a in node.names]
			elif isinstance(node, ast.ImportFrom) and node.module:
				named = [node.module.split(".")[0]]
			for target in named:
				if target in project_modules:
					problems.append("lib/%s imports %s - go through binding.py instead"
					                % (name, target))
		# paths.py explains why these names are refused, so it is allowed to name them.
		if name == "paths.py":
			continue
		lowered = text.lower()
		for word in sorted(reserved):
			if word in lowered:
				problems.append("lib/%s names %r - that is the project's, not the library's"
				                % (name, word))
	return problems


def main():
	args = sys.argv[1:]
	if not args or args[0] in ("-h", "--help", "--list"):
		import paths
		paths.show()
		print()
		for name, (_, summary) in sorted(commands().items()):
			print("  %-16s %s" % (name, summary[:60]))
		return 0

	if args[0] == "--boundary":
		problems = boundary()
		for line in problems:
			print(line)
		print("%d crossing(s) of the library/project boundary" % len(problems))
		return 1 if problems else 0

	name, rest = args[0], args[1:]
	found = commands()
	if name not in found:
		print("no such command: %s (try --list)" % name)
		return 2
	# run_path rather than calling main(): a few tools only have a __main__
	# block, and this runs every one of them exactly as a script would.
	import runpy
	sys.argv = [name] + rest
	try:
		runpy.run_path(found[name][0], run_name="__main__")
	except SystemExit as stop:
		return stop.code or 0
	return 0


if __name__ == "__main__":
	sys.exit(main() or 0)
