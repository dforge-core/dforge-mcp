#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Extract the field list of a metadata object, with references resolved.

Every typed thing in a 1C object file - a catalog attribute, a register dimension
or resource, a tabular-section column - is encoded the same way:

    ["2", ["1", ["0","0",<own guid>], "<Name>", ["1","ru","<Synonym>"], ...],
          ["Pattern", <type...>]]

so the collector looks for that shape anywhere in the tree rather than hard-coding
per-kind offsets, and takes the nearest named ancestor as the tabular section.

    python attrs.py <ObjectName>              one object, to the console
    python attrs.py --model <file> <names...> several objects, to a markdown file
"""
from __future__ import print_function

import codecs
import json
import os
import paths
import sys

import meta

OUT = meta.OUT

PRIMITIVE = {"S": "string", "N": "number", "B": "bool", "D": "date"}

# Collection class GUIDs -> what the fields in them mean, confirmed by checking a
# register whose meaning is unambiguous (ТоварыНаСкладах: Количество is the resource,
# Склад/Номенклатура the dimensions). Unknown GUIDs print truncated so they show up.
ROLE = {
	"cf4abea7-37b2-11d4-940f-008048da11f9": "attr",        # catalog attribute
	"45e46cbc-3e24-4165-8b7b-cc98a6f80211": "attr",        # document attribute
	"888744e1-b616-11d4-9436-004095e12fc7": "column",      # tabular section column
	"b64d9a41-1642-11d6-a3c7-0050bae0a776": "resource",    # accumulation register
	"b64d9a42-1642-11d6-a3c7-0050bae0a776": "attr",
	"b64d9a43-1642-11d6-a3c7-0050bae0a776": "dimension",
	"13134202-f60b-11d5-a3c7-0050bae0a776": "resource",    # information register
	"13134203-f60b-11d5-a3c7-0050bae0a776": "dimension",
	"13134204-f60b-11d5-a3c7-0050bae0a776": "attr",
}

ROLE_ORDER = ("dimension", "resource", "attr", "column")


def is_identity(node):
	"""["1", ["0","0",<guid>], "<Name>", ["1","ru","<Synonym>"], "", "0", "0"]"""
	if not (isinstance(node, list) and len(node) >= 3 and isinstance(node[1], list)):
		return False
	if len(node[1]) != 3 or not isinstance(node[1][2], str) or not meta.GUID.match(node[1][2]):
		return False
	return isinstance(node[2], str) and bool(node[2]) and not node[2].isdigit()


def find_identity(node):
	"""First identity block in a header subtree, depth first."""
	if not isinstance(node, list):
		return None
	if is_identity(node):
		return node
	for item in node:
		found = find_identity(item)
		if found is not None:
			return found
	return None


def is_field(node):
	"""A field is an identity block immediately followed by its type pattern."""
	return (isinstance(node, list) and len(node) >= 3 and is_identity(node[1])
	        and isinstance(node[2], list) and node[2] and node[2][0] == "Pattern")


def name_of(node):
	return node[1][2]


def guid_of(node):
	"""The attribute's own GUID, from its identity block.

	This is what DBNames keys its `Fld` entries by, so it is how a ported column is
	traced back to the `_FldNNN` the data actually sits in.
	"""
	ident = node[1]
	head = ident[1] if len(ident) > 1 else None
	return head[2] if isinstance(head, list) and len(head) > 2 else None


def synonym_of(node):
	syn = node[1][3] if len(node[1]) > 3 else None
	return syn[2] if isinstance(syn, list) and len(syn) >= 3 else None


def is_collection(node):
	"""[<class guid>, <count>, member, member, ...] - attributes, dimensions, resources."""
	return (isinstance(node, list) and len(node) > 2 and isinstance(node[0], str)
	        and meta.GUID.match(node[0]) and isinstance(node[1], str) and node[1].isdigit())


def decode_type(pattern, types):
	"""['Pattern', ['S','30','1'], guid, ...] -> readable type."""
	parts, refs = [], []
	for item in pattern[1:]:
		if isinstance(item, str) and meta.GUID.match(item):
			refs.append(item)
		elif isinstance(item, list) and item:
			head = item[0]
			if head == "S":
				parts.append("string(%s)" % (item[1] if len(item) > 1 else "?"))
			elif head == "N":
				parts.append("number(%s,%s)" % (item[1] if len(item) > 1 else "?",
				                                item[2] if len(item) > 2 else "0"))
			elif head == "B":
				parts.append("bool")
			elif head == "D":
				parts.append("date(%s)" % (item[1] if len(item) > 1 else "DateTime"))
			else:
				refs.extend(s for s in item if isinstance(s, str) and meta.GUID.match(s))
	for guid in refs:
		target = types.get(guid)
		parts.append("-> %s.%s" % (target["family"], target["name"]) if target
		             else "-> <%s>" % guid[:8])
	return ", ".join(parts) or "?"


def has_pattern(node):
	if not isinstance(node, list):
		return False
	if node and node[0] == "Pattern":
		return True
	return any(has_pattern(item) for item in node)


def tabular_section_info(node):
	"""A tabular section is [<header>, ..., <columns collection>]: a named header that
	carries no type of its own, followed by a collection of typed columns.

	Returns (name, guid). The GUID is what DBNames keys the section's `_VT` table and
	its `_LineNo` column by.
	"""
	if len(node) < 3 or not isinstance(node[0], list) or not is_collection(node[2]):
		return None
	if has_pattern(node[0]):
		return None
	ident = find_identity(node[0])
	if ident is None:
		return None
	head = ident[1] if len(ident) > 1 else None
	guid = head[2] if isinstance(head, list) and len(head) > 2 else None
	return ident[2], guid


def tabular_section_name(node):
	found = tabular_section_info(node)
	return found[0] if found else None


def collect(node, section, collection, types, fields, section_guid=None):
	if not isinstance(node, list):
		return
	if is_field(node):
		fields.append({
			"section": section,
			"sectionGuid": section_guid,
			"collection": collection,
			"name": name_of(node),
			"guid": guid_of(node),
			"synonym": synonym_of(node),
			"type": decode_type(node[2], types),
		})
		return
	found = tabular_section_info(node)
	if found:
		section, section_guid = found
	if is_collection(node):
		collection = node[0]
		node = node[2:]
	for item in node:
		collect(item, section, collection, types, fields, section_guid)


def enum_values(tree, object_name):
	"""Enum members carry no type pattern, so they are plain identity blocks."""
	values = []
	def walk(node):
		if not isinstance(node, list):
			return
		if is_identity(node):
			if node[2] != object_name and node[2] not in values:
				values.append(node[2])
			return
		for item in node:
			walk(item)
	walk(tree)
	return values


def load_json(name):
	with codecs.open(os.path.join(OUT, name), "r", "utf-8") as f:
		return json.load(f)


def fields_of(name, objects, types):
	guid = next((o["guid"] for o in objects if o.get("name") == name), None)
	if not guid:
		return None, None
	text = meta.load(guid)
	if text is None:
		return guid, None
	fields = []
	collect(meta.parse(text), None, None, types, fields)
	return guid, fields


def main():
	objects = load_json("objects.json")
	types = load_json("typemap.json")
	report = {r["name"]: r for r in load_json("report.json")}

	if sys.argv[1] == "--model":
		out_path, names = sys.argv[2], sys.argv[3:]
		lines = ["# Transport & shipping contour - extracted model", "",
		         "Generated from the `%s` MS SQL infobase without 1C software."
	         % os.environ.get("DF1C_DB", "source"), ""]
		for name in names:
			guid, fields = fields_of(name, objects, types)
			row = report.get(name, {})
			if fields is None:
				lines += ["## %s *(not found)*" % name, ""]
				continue
			lines += ["## %s.%s - %s" % (row.get("family", "?"), name, row.get("synonym") or ""),
			          "",
			          "`%s` - %s rows, %s child rows" % (
				          row.get("physical"),
				          "{:,}".format(row.get("rows") or 0),
				          "{:,}".format(row.get("childRows") or 0)), ""]
			if not fields:
				values = enum_values(meta.parse(meta.load(guid)), name)
				if values:
					lines += ["Values: " + ", ".join(values), ""]
				continue
			sections = [None] + sorted({f["section"] for f in fields if f["section"]})
			for section in sections:
				chunk = [f for f in fields if f["section"] == section]
				if not chunk:
					continue
				chunk.sort(key=lambda f: ROLE_ORDER.index(ROLE[f["collection"]])
				           if ROLE.get(f["collection"]) in ROLE_ORDER else 9)
				lines += ["**%s**" % (section or "header"), "",
				          "| role | field | synonym | type |", "|---|---|---|---|"]
				for f in chunk:
					lines.append("| %s | %s | %s | %s |" % (
						ROLE.get(f["collection"], "?"), f["name"],
						f["synonym"] or "", f["type"]))
				lines.append("")
		with codecs.open(out_path, "w", "utf-8") as f:
			f.write("\n".join(lines))
		print("wrote %s (%d objects)" % (out_path, len(names)))
		return

	name = sys.argv[1]
	guid, fields = fields_of(name, objects, types)
	if fields is None:
		print("no such object: %s" % name)
		return
	print("%s (%s)  fields=%d\n" % (name, guid, len(fields)))
	for f in fields:
		print("   %-10s %-22s %-34s %-28s %s"
		      % (ROLE.get(f["collection"], (f["collection"] or "")[:8]),
		         f["section"] or "", f["name"], f["synonym"] or "", f["type"]))


if __name__ == "__main__":
	main()
