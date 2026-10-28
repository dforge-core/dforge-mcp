#!/usr/bin/env python
# -*- coding: utf-8 -*-
u"""Does a lower layer of modules name anything in the layer installed on top of it?

A port of a configuration built on a vendor's comes out as two layers: the vendor's,
generated from the client's own configuration, and the client's, installed on top and
depending on it - never the other way round. That is what lets the vendor layer install
for the next client without this one's, and what lets this client's changes be seen and
priced on their own (docs/task-vendor-logic.md section 2).

A convention does not keep that true; this does. It reads every module of the lower layer
and reports each place it names a module of the upper one: an entity link, a foreign key,
a register binding, a declared dependency. Exit status 1 when there is any.

    python tools/1c.py layers <lower dir> <upper dir>     # e.g. modules-utp modules

The directories are arguments rather than names in here, so the check carries to the next
project unchanged.
"""
from __future__ import print_function

import codecs
import collections
import io
import json
import os
import re
import sys

import paths

QUALIFIED = re.compile(r"^([a-z][a-z0-9_]*)\.([a-z0-9_]+)$")


def modules_in(directory):
	"""Module code -> its directory, for every module (a folder holding a manifest)."""
	found = {}
	for name in sorted(os.listdir(directory)):
		manifest = os.path.join(directory, name, "manifest.json")
		if os.path.isfile(manifest):
			with io.open(manifest, encoding="utf-8-sig") as f:
				found[json.load(f).get("code", name)] = os.path.join(directory, name)
	return found


def crossings(lower, upper):
	"""(lower module, file, json path, named upper module.object) for every crossing."""
	upper_codes = set(modules_in(upper))
	found = []
	for code, folder in sorted(modules_in(lower).items()):
		with io.open(os.path.join(folder, "manifest.json"), encoding="utf-8-sig") as f:
			for dependency in json.load(f).get("dependencies", {}):
				if dependency in upper_codes:
					found.append((code, "manifest.json", "dependencies", dependency))
		for root, _, files in os.walk(folder):
			for name in sorted(files):
				if not name.endswith(".json") or name == "manifest.json":
					continue
				path = os.path.join(root, name)
				with io.open(path, encoding="utf-8-sig") as f:
					try:
						tree = json.load(f)
					except ValueError:
						continue
				relative = os.path.relpath(path, folder).replace(os.sep, "/")
				for where, value in _strings(tree, ()):
					match = QUALIFIED.match(value)
					if match and match.group(1) in upper_codes:
						found.append((code, relative, "/".join(where), value))
	return found


def _strings(node, where):
	if isinstance(node, dict):
		for key, value in node.items():
			for item in _strings(value, where + (key,)):
				yield item
	elif isinstance(node, list):
		for index, value in enumerate(node):
			for item in _strings(value, where + (str(index),)):
				yield item
	elif isinstance(node, type(u"")):
		yield where, node


def main():
	args = [a for a in sys.argv[1:] if not a.startswith("-")]
	if len(args) != 2:
		raise SystemExit("usage: layers <lower dir> <upper dir>")
	lower, upper = (os.path.join(paths.ROOT, a) if not os.path.isabs(a) else a for a in args)
	found = crossings(lower, upper)
	out = codecs.getwriter("utf-8")(sys.stdout.buffer)
	by_target = collections.Counter(c[3] for c in found)
	places = collections.defaultdict(set)
	for module, path, where, target in found:
		places[target].add(u"%s/%s" % (module, path))
	for target, count in by_target.most_common():
		out.write(u"%6d  %-34s from %d file(s), e.g. %s\n"
		          % (count, target, len(places[target]), sorted(places[target])[0]))
	out.write(u"%d reference(s) from %s into %s, %d distinct object(s)\n"
	          % (len(found), args[0], args[1], len(by_target)))
	return 1 if found else 0


if __name__ == "__main__":
	sys.exit(main() or 0)
