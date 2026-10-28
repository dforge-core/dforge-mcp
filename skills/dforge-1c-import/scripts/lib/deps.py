#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Module dependency graph, and whether it can be installed.

dForge installs modules in dependency order, so a cycle between two modules is not a
style problem - it is a package that cannot be installed at all. A cycle is broken with
an extension or a bridge module (see MODULE_CONVENTIONS.md), but first it has to be seen.

    python tools/deps.py
"""
from __future__ import print_function

import codecs
import collections
import json
import os

import paths

ROOT = paths.ROOT
MODULES = paths.MODULES


def load(path):
	with codecs.open(path, "r", "utf-8") as f:
		return json.load(f)


def graph():
	out = collections.OrderedDict()
	for code in sorted(os.listdir(MODULES)):
		manifest = os.path.join(MODULES, code, "manifest.json")
		if os.path.isfile(manifest):
			out[code] = set(load(manifest).get("dependencies", {}))
	return out


def referenced(code):
	"""Modules this one actually points at: `extends`, and every `entity` in a link,
	reference or set. A dependency the manifest forgets to declare still binds the
	install order - masterdata carried a lookup into shipping while declaring nothing,
	and the pair was uninstallable in either order."""
	out = set()

	def walk(node):
		if isinstance(node, dict):
			for key, value in node.items():
				if key in ("entity", "extends") and isinstance(value, str) and "." in value:
					out.add(value.split(".", 1)[0])
				else:
					walk(value)
		elif isinstance(node, list):
			for item in node:
				walk(item)

	directory = os.path.join(MODULES, code, "entities")
	if os.path.isdir(directory):
		for name in sorted(os.listdir(directory)):
			walk(load(os.path.join(directory, name)))
	return out - set([code])


def cycles(edges):
	"""Every cycle reachable in the graph, as a list of module names."""
	found, path, state = [], [], {}

	def walk(node):
		state[node] = "open"
		path.append(node)
		for target in sorted(edges.get(node, ())):
			if target not in edges:
				continue
			if state.get(target) == "open":
				found.append(path[path.index(target):] + [target])
			elif state.get(target) != "done":
				walk(target)
		path.pop()
		state[node] = "done"

	for node in edges:
		if state.get(node) != "done":
			walk(node)
	return found


def order(edges):
	"""Install order: a module after everything it depends on."""
	done, out = set(), []
	remaining = dict((k, set(v) & set(edges)) for k, v in edges.items())
	while remaining:
		ready = sorted(k for k, v in remaining.items() if v <= done)
		if not ready:
			return out, sorted(remaining)
		for code in ready:
			out.append(code)
			done.add(code)
			del remaining[code]
	return out, []


def main():
	edges = graph()
	print("%-12s %s" % ("module", "depends on"))
	print("-" * 60)
	undeclared = collections.OrderedDict()
	for code, deps in edges.items():
		missing = sorted(referenced(code) - deps - set([code]))
		if missing:
			undeclared[code] = missing
			deps.update(missing)
		print("%-12s %s%s" % (code, ", ".join(sorted(deps)) or "-",
		                      "   (undeclared: %s)" % ", ".join(missing) if missing else ""))

	if undeclared:
		print("\n%d module(s) reference a module they do not declare - add the"
		      " dependency, or move the reference to the other side:" % len(undeclared))
		for code, missing in undeclared.items():
			print("   %s -> %s" % (code, ", ".join(missing)))

	found = cycles(edges)
	if found:
		print("\n%d cycle(s) - these cannot be installed as they stand:" % len(found))
		for cycle in found:
			print("   %s" % " -> ".join(cycle))
	else:
		print("\nno cycles")

	sequence, stuck = order(edges)
	print("\ninstall order:\n   %s" % " -> ".join(sequence))
	if stuck:
		print("stuck: %s" % ", ".join(stuck))


if __name__ == "__main__":
	main()
