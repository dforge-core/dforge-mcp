#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Separate the client's own development from the stock UTP configuration.

Stock 1C objects are CamelCase starting with a capital; this integrator prefixes
everything it added with a lowercase tag. Whatever carries a tag *and* holds data
is the real porting scope - the rest is vendor code we are not copying anyway.
"""
from __future__ import print_function

import codecs
import collections
import json
import os
import re
import sys

import paths

OUT = paths.OUT
LOWER_PREFIX = re.compile(r"^([a-zа-яёіїє]{2,6})(?=[A-ZА-Я])")
FAMILIES = ("Reference", "Document", "InfoRg", "AccumRg", "Enum", "Chrc", "Acc", "AccRg")


def load(name):
	with codecs.open(os.path.join(OUT, name), "r", "utf-8") as f:
		return json.load(f)


def has_data(row):
	return bool((row["rows"] or 0) or row["childRows"])


def main():
	rows = load("report.json")

	prefixes = collections.Counter()
	for row in rows:
		m = LOWER_PREFIX.match(row["name"] or "")
		if m:
			prefixes[m.group(1)] += 1
	print("integrator prefixes found:")
	for tag, n in prefixes.most_common(10):
		print("   %-8s %d objects" % (tag, n))

	tags = [t for t, n in prefixes.most_common() if n >= 3]
	is_custom = lambda row: bool(LOWER_PREFIX.match(row["name"] or "")
	                             and LOWER_PREFIX.match(row["name"]).group(1) in tags)

	print("\n%-14s %7s %7s %11s %11s" % ("family", "total", "custom", "custom+data", "stock+data"))
	print("-" * 56)
	scope = []
	for family in FAMILIES:
		members = [r for r in rows if r["family"] == family]
		if not members:
			continue
		custom = [r for r in members if is_custom(r)]
		custom_used = [r for r in custom if has_data(r)]
		stock_used = [r for r in members if has_data(r) and not is_custom(r)]
		scope.extend(custom_used)
		print("%-14s %7d %7d %11d %11d"
		      % (family, len(members), len(custom), len(custom_used), len(stock_used)))

	scope.sort(key=lambda r: -((r["rows"] or 0) + r["childRows"]))
	with codecs.open(os.path.join(OUT, "scope.md"), "w", "utf-8") as f:
		f.write("# Client-specific objects that hold data\n\n")
		f.write("| family | name | synonym | table | rows | child rows | cols |\n")
		f.write("|---|---|---|---|---:|---:|---:|\n")
		for r in scope:
			f.write("| %s | %s | %s | %s | %s | %s | %s |\n"
			        % (r["family"], r["name"], r["synonym"] or "", r["physical"],
			           "{:,}".format(r["rows"] or 0), "{:,}".format(r["childRows"]), r["columns"]))
	print("\ncustom objects with data: %d -> out/scope.md" % len(scope))

	top = int(sys.argv[1]) if len(sys.argv) > 1 else 20
	print()
	for r in scope[:top]:
		print("   %-10s %-42s %s" % (r["family"], r["name"], r["synonym"] or ""))


if __name__ == "__main__":
	main()
