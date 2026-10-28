#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Read the 1C forms out of the configuration dump.

The port carries every attribute a catalogue declares, because that is what the metadata
says - and the metadata says nothing about how they are grouped. `Номенклатура` is a flat
list of 81 attributes, so the card the port generates is a flat list of 81 fields.

The grouping is in the forms. An ordinary 1C form is not text: it sits in `<guid>.0.bin`
in 1C's own container format - a 16-byte header, then a chain of blocks whose 31-byte
ASCII headers give (data size, page size, next page). The first chain is a directory of
(attributes address, data address) pairs; each attributes block carries an inner file's
name and each data block its body. A form container holds two of them, `form` and
`module` - the control tree and the form's code.

Inside `form`, a panel's pages carry their captions:

    {4, {1,1, {"ru","Цены номенклатуры"}}, ..., -1,1,1,"ЦеныНоменклатуры",1, ...

which is where a card's tabs should come from.

    python tools/forms.py                 # coverage, and writes out/formtabs.json
    python tools/forms.py <1C object>     # that object's forms, and one form's tabs

What is NOT here is which page a given field sits on. A page's controls are not nested
under it: the page list is one node of the panel and the controls are another, tied by
an id mapping whose layout is not documented and did not yield to three readings of it.
The configuration is on ordinary forms throughout - 123 of the 182 ported objects have
only those, and not one has a managed form with anything in it - so there is no clean
tree to fall back on. The tabs below are therefore a description of the 1C card, not yet
a placement for ours.
"""
from __future__ import print_function

import codecs
import collections
import json
import os
import re
import struct
import sys
import zlib

import attrs
import paths
import meta

CONFIG = os.path.join(attrs.OUT, "config")
GUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"

# `{4, {1,1, {"ru","<caption>"}}, ...},-1,1,1,"<name>",1,` - one page of a panel.
PAGE = re.compile(
	r'\{1,1,\s*\{"ru","([^"\n]{2,60})"\}[\s\S]{0,400}?,-1,1,1,"([A-Za-zЀ-ӿ_][^"\n]{0,60})",1,',
	re.S)


# --------------------------------------------------------------------------- container

def read_block(buf, at):
	"""One block chain of a 1C container, concatenated."""
	header = buf[at:at + 31]
	if len(header) < 31 or header[:2] != b"\r\n":
		return None
	left = int(header[2:10], 16)
	page, size, following = at, int(header[11:19], 16), int(header[20:28], 16)
	out = b""
	while True:
		chunk = buf[page + 31:page + 31 + size]
		out += chunk[:left]
		left -= min(len(chunk), left)
		if left <= 0 or following == 0x7fffffff:
			break
		header = buf[following:following + 31]
		size, page, following = (int(header[11:19], 16), following,
		                         int(header[20:28], 16))
	return out


def container_files(path):
	"""The inner files of a 1C container, by name."""
	with open(path, "rb") as f:
		buf = f.read()
	directory = read_block(buf, 16)
	if not directory:
		return {}
	out = {}
	for i in range(0, len(directory) - 11, 12):
		attr_at, data_at, _ = struct.unpack_from("<III", directory, i)
		header = read_block(buf, attr_at)
		if not header or len(header) <= 20:
			continue
		name = header[20:].decode("utf-16-le", "replace").rstrip(u"\x00")
		body = read_block(buf, data_at) or b""
		try:
			body = zlib.decompressobj(-15).decompress(body)
		except zlib.error:
			pass
		out[name] = body
	return out


def form_body(guid, part="form"):
	"""A form's control tree as text, whether it was stored packed or plain."""
	packed = os.path.join(CONFIG, guid + ".0.bin")
	if os.path.isfile(packed):
		body = container_files(packed).get(part)
		return body.decode("utf-8-sig", "replace") if body else None
	plain = os.path.join(CONFIG, guid + ".0.txt")
	if part == "form" and os.path.isfile(plain):
		with codecs.open(plain, "r", "utf-8-sig", "replace") as f:
			return f.read()
	return None


# --------------------------------------------------------------------------- forms

_ON_DISK = None


def on_disk():
	global _ON_DISK
	if _ON_DISK is None:
		_ON_DISK = set(name.split(".")[0] for name in os.listdir(CONFIG))
	return _ON_DISK


def forms_of(object_guid):
	"""[(1C form name, guid)] for one metadata object, in declaration order."""
	text = meta.load(object_guid) or ""
	found = []
	for guid in dict.fromkeys(re.findall(GUID, text)):
		if guid == object_guid or guid not in on_disk():
			continue
		header = meta.load(guid) or ""
		name = re.search(u'"(Форма[^"]*)"', header)
		if name:
			found.append((name.group(1), guid))
	return found


def tabs(text):
	"""A panel's pages, in order: [(caption, control name)].

	1C names a page it was never given a caption for `Страница1`, and a form with one
	such page has no tabs worth porting - that is the whole card.
	"""
	found = []
	for caption, name in PAGE.findall(text or ""):
		if caption.startswith(u"Страница"):
			continue
		found.append((caption, name))
	return found


def element_form(object_guid):
	"""The form a record opens in, preferring the client's own over the stock one."""
	found = forms_of(object_guid)
	for wanted in (u"ФормаЭлементаМСБ",
	               u"ФормаЭлемента",
	               u"ФормаДокумента"):
		for name, guid in found:
			if name == wanted:
				return name, guid
	return (found[0] if found else (None, None))


# --------------------------------------------------------------------------- reporting

def model():
	path = os.path.join(attrs.OUT, "objects_all.json")
	with codecs.open(path, "r", "utf-8") as f:
		doc = json.load(f)
	return doc["objects"] if isinstance(doc, dict) else doc


def main():
	rows = model()
	if len(sys.argv) > 1:
		wanted = sys.argv[1].decode("utf-8") if str is bytes else sys.argv[1]
		row = next((r for r in rows if r.get("name") == wanted), None)
		if not row:
			print("no such object: %s" % wanted)
			return 1
		for name, guid in forms_of(row["guid"]):
			text = form_body(guid)
			found = tabs(text)
			print("%-28s %8d chars  %d tab(s)"
			      % (name, len(text or ""), len(found)))
			for caption, control in found:
				print("      %-42s %s" % (caption, control))
		return 0

	# The objects the port actually carries, which is the column map's own list - a
	# tabular section has no form of its own, so only the owners are asked about.
	with codecs.open(paths.derived("columnmap.json"), "r", "utf-8") as f:
		mapping = json.load(f)
	wanted = set()
	for entities in mapping.values():
		for found in entities.values():
			name = (found.get("object") or "").strip()
			if name and " / " not in name:
				wanted.add(name)

	tally = collections.Counter()
	total_tabs = 0
	found_tabs = collections.OrderedDict()
	for row in rows:
		if row.get("name") not in wanted:
			continue
		name, guid = element_form(row["guid"])
		if not guid:
			tally["no form"] += 1
			continue
		found = tabs(form_body(guid))
		total_tabs += len(found)
		tally["tabs" if found else "one page"] += 1
		if found:
			found_tabs[row["name"]] = {
				"form": name,
				"tabs": [{"caption": caption, "name": control}
				         for caption, control in found],
			}

	path = os.path.join(attrs.OUT, "formtabs.json")
	with codecs.open(path, "w", "utf-8") as f:
		f.write(json.dumps(found_tabs, ensure_ascii=False, indent="\t"))
		f.write("\n")

	print("%-12s %s" % ("ported objects", len(wanted)))
	for key, count in tally.most_common():
		print("%-12s %d" % (key, count))
	print("%-12s %d" % ("tabs found", total_tabs))
	print("\n-> %s" % path)
	return 0


if __name__ == "__main__":
	sys.exit(main())
