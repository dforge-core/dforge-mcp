#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Parse the 1C configuration files dumped by dump1c.py into a readable model.

The internal format is a nested brace list:
    {2,
    {1e4190e9-...},6,
    {9cd510cd-...,          <- metadata class GUID
    {1,
    {50, ... ,"Name",{2,"ru","Synonym","uk","Синонім"}, ...

Commands:
    kinds    map metadata class GUIDs to the physical table families via DBNames counts
    objects  extract name + synonym for every metadata object
"""
import codecs
import collections
import json
import os
import re
import sys

import paths

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = paths.OUT
CONFIG = os.path.join(OUT, "config")

GUID = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")


# --------------------------------------------------------------------------- parser

def parse(text):
	"""Nested brace list -> nested Python lists. Strings keep their value, everything
	else stays a bare token (number, GUID, base64 run)."""
	pos = 0
	n = len(text)

	def skip_ws():
		nonlocal pos
		while pos < n and text[pos] in " \t\r\n":
			pos += 1

	def read_string():
		nonlocal pos
		pos += 1  # opening quote
		chunks = []
		while pos < n:
			ch = text[pos]
			if ch == '"':
				if pos + 1 < n and text[pos + 1] == '"':
					chunks.append('"')
					pos += 2
					continue
				pos += 1
				break
			chunks.append(ch)
			pos += 1
		return "".join(chunks)

	def read_list():
		nonlocal pos
		pos += 1  # opening brace
		items = []
		while pos < n:
			skip_ws()
			if pos >= n:
				break
			ch = text[pos]
			if ch == "}":
				pos += 1
				break
			if ch == ",":
				pos += 1
				continue
			items.append(read_value())
		return items

	def read_value():
		nonlocal pos
		skip_ws()
		ch = text[pos]
		if ch == "{":
			return read_list()
		if ch == '"':
			return read_string()
		start = pos
		while pos < n and text[pos] not in ",{}\r\n":
			pos += 1
		return text[start:pos].strip()

	skip_ws()
	return read_value() if pos < n else []


def root():
	"""The configuration's own object: `root` names it, `{2,<guid>,}`. The GUID is the
	configuration's, so it differs from one infobase to the next."""
	match = re.search(r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}", load("root") or "")
	if not match:
		raise SystemExit("meta: %s has no root - run `1c.py dump1c extract` first"
		                 % os.path.join(CONFIG, "root.txt"))
	return match.group(0)


def load(guid):
	path = os.path.join(CONFIG, guid + ".txt")
	if not os.path.isfile(path):
		return None
	with codecs.open(path, "r", "utf-8-sig", errors="replace") as f:
		return f.read()


def walk(node):
	"""Yield every nested list, depth first."""
	if isinstance(node, list):
		yield node
		for item in node:
			for sub in walk(item):
				yield sub


# --------------------------------------------------------------------------- kinds

def collect_guid_groups(tree):
	"""Find '{classGuid, count, guid, guid, ...}': a metadata class and its members."""
	groups = []
	for node in walk(tree):
		if len(node) < 3:
			continue
		class_guid, count = node[0], node[1]
		if not isinstance(class_guid, str) or not GUID.match(class_guid):
			continue
		if not isinstance(count, str) or not count.isdigit():
			continue
		members = [g for g in node[2:] if isinstance(g, str) and GUID.match(g)]
		if members and len(members) == int(count):
			groups.append({"classGuid": class_guid, "members": members})
	return groups


def dbnames_index():
	"""A GUID appears once per physical table it owns: the real one plus change-tracking
	(_..ChngR) and totals (_..T) companions. Keep the primary table."""
	with codecs.open(os.path.join(OUT, "dbnames.json"), "r", "utf-8") as f:
		entries = json.load(f)["entries"]
	index = {}
	for e in entries:
		kind = e["type"]
		if kind.endswith("ChngR") or kind.endswith("Recalc"):
			index.setdefault(e["guid"], e)          # only if nothing better shows up
		else:
			prev = index.get(e["guid"])
			if prev is None or prev["type"].endswith("ChngR") or prev["type"].endswith("Recalc"):
				index[e["guid"]] = e
	return index


def cmd_kinds(args):
	"""Each group's family is whatever DBNames calls its members - no guessing from counts."""
	tree = parse(load(root()) or "")
	groups = collect_guid_groups(tree)
	dbn = dbnames_index()

	print("%-40s %7s  %-18s %s" % ("metadata class GUID", "members", "family", "resolved"))
	print("-" * 84)
	mapping = {}
	for g in sorted(groups, key=lambda g: -len(g["members"])):
		families = collections.Counter(dbn[m]["type"] for m in g["members"] if m in dbn)
		family = families.most_common(1)[0][0] if families else None
		resolved = sum(families.values())
		if family:
			mapping[g["classGuid"]] = {"family": family, "members": g["members"]}
		print("%-40s %7d  %-18s %d" % (g["classGuid"], len(g["members"]), family or "-", resolved))

	with codecs.open(os.path.join(OUT, "kinds.json"), "w", "utf-8") as f:
		json.dump(mapping, f, ensure_ascii=False, indent="\t")


# --------------------------------------------------------------------------- objects

NAME_AFTER_GUID = re.compile(r'\{0,\s*\d+,\s*[0-9a-fA-F-]{36}\},\s*"([^"]*)",')


def object_header(text):
	"""Name and ru/uk synonyms sit right after the object's own identity block."""
	m = NAME_AFTER_GUID.search(text)
	if not m:
		return None, {}
	name = m.group(1)
	syn = {}
	tail = text[m.end():m.end() + 1200]
	# `{N,"ru","...","uk","..."}` - read exactly N pairs. Scanning on past them picked up the
	# first attribute's synonym whenever one sat within reach, so a register was named after
	# its resource ("Стоимость") rather than itself.
	sm = re.match(r'\s*\{(\d+),', tail)
	if sm:
		pos = sm.end()
		for _ in range(int(sm.group(1))):
			pm = PAIR.match(tail, pos)
			if not pm:
				break
			syn[pm.group(1)] = pm.group(2).replace('""', '"')
			pos = pm.end()
	return name, syn


PAIR = re.compile(r'\s*,?\s*"([a-z]{2})",\s*"((?:[^"]|"")*)"')


def cmd_objects(args):
	with codecs.open(os.path.join(OUT, "kinds.json"), "r", "utf-8") as f:
		kinds = json.load(f)
	result = []
	for class_guid, info in kinds.items():
		for guid in info["members"]:
			text = load(guid)
			if text is None:
				result.append({"guid": guid, "family": info["family"], "name": None, "missing": True})
				continue
			name, syn = object_header(text)
			result.append({"guid": guid, "family": info["family"], "name": name,
			               "synonym": syn.get("ru") or syn.get("uk"), "size": len(text)})
	with codecs.open(os.path.join(OUT, "objects.json"), "w", "utf-8") as f:
		json.dump(result, f, ensure_ascii=False, indent="\t")
	named = [r for r in result if r.get("name")]
	print("objects=%d named=%d" % (len(result), len(named)))
	for r in named[:int(args[0]) if args else 20]:
		print("   %-18s %-45s %s" % (r["family"], r["name"], r.get("synonym") or ""))


# --------------------------------------------------------------------------- report

def cmd_report(args):
	"""Named metadata joined to its physical table and row counts: the porting worklist."""
	with codecs.open(os.path.join(OUT, "objects.json"), "r", "utf-8") as f:
		objects = json.load(f)
	with codecs.open(os.path.join(OUT, "schema.json"), "r", "utf-8") as f:
		tables = {t["name"]: t for t in json.load(f)["tables"]}
	dbn = dbnames_index()

	rows = []
	for obj in objects:
		entry = dbn.get(obj["guid"])
		physical = entry["physical"] if entry else None
		table = tables.get(physical) if physical else None
		child = sum((t["rows"] or 0) for name, t in tables.items()
		            if physical and name.startswith(physical + "_"))
		rows.append({
			"family": entry["type"] if entry else obj["family"],
			"name": obj["name"],
			"synonym": obj.get("synonym"),
			"physical": physical,
			"rows": (table["rows"] or 0) if table else None,
			"childRows": child,
			"columns": len(table["columns"]) if table else None,
		})

	with codecs.open(os.path.join(OUT, "report.json"), "w", "utf-8") as f:
		json.dump(rows, f, ensure_ascii=False, indent="\t")

	lines = []
	families = args[0].split(",") if args else ["Document", "Reference", "AccumRg", "InfoRg"]
	for family in families:
		members = [r for r in rows if r["family"] == family]
		used = [r for r in members if (r["rows"] or 0) or r["childRows"]]
		used.sort(key=lambda r: -((r["rows"] or 0) + r["childRows"]))
		lines.append("")
		lines.append("## %s - %d objects, %d with data" % (family, len(members), len(used)))
		lines.append("")
		lines.append("| name | synonym | table | rows | child rows | cols |")
		lines.append("|---|---|---|---:|---:|---:|")
		for r in used:
			lines.append("| %s | %s | %s | %s | %s | %s |" % (
				r["name"], r["synonym"] or "", r["physical"],
				"{:,}".format(r["rows"] or 0), "{:,}".format(r["childRows"]), r["columns"]))
	text = "\n".join(lines)
	with codecs.open(os.path.join(OUT, "report.md"), "w", "utf-8") as f:
		f.write(text)
	print("wrote out/report.json and out/report.md (%d objects)" % len(rows))


def cmd_allobjects(args):
	"""Every metadata object in the root, not only the ones with a physical table.

	`objects` is driven by kinds.json, which only keeps classes DBNames knows about, so
	common modules, roles and subsystems are missing from it - and they hold most of the
	configuration's code.
	"""
	tree = parse(load(root()) or "")
	dbn = dbnames_index()
	result = []
	for group in collect_guid_groups(tree):
		families = collections.Counter(dbn[m]["type"] for m in group["members"] if m in dbn)
		family = families.most_common(1)[0][0] if families else None
		for guid in group["members"]:
			text = load(guid)
			name, syn = object_header(text) if text is not None else (None, {})
			result.append({
				"guid": guid,
				"classGuid": group["classGuid"],
				"family": family,
				"name": name,
				"synonym": syn.get("ru") or syn.get("uk"),
			})
	with codecs.open(os.path.join(OUT, "objects_all.json"), "w", "utf-8") as f:
		json.dump(result, f, ensure_ascii=False, indent="\t")

	by_class = collections.Counter()
	for row in result:
		by_class[(row["classGuid"], row["family"])] += 1
	print("objects=%d  named=%d" % (len(result), sum(1 for r in result if r["name"])))
	for (class_guid, family), n in by_class.most_common(12):
		sample = next(r["name"] for r in result
		              if r["classGuid"] == class_guid and r["name"])
		print("   %-40s %-12s %5d  e.g. %s" % (class_guid, family or "-", n, sample))


COMMANDS = {"kinds": cmd_kinds, "objects": cmd_objects, "report": cmd_report,
            "allobjects": cmd_allobjects}

if __name__ == "__main__":
	COMMANDS[sys.argv[1]](sys.argv[2:])
