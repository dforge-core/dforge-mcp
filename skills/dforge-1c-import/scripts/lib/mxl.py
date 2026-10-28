#!/usr/bin/env python
# -*- coding: utf-8 -*-
u"""Read the configuration's print templates (макеты, MOXCEL spreadsheets) into HTML and JSON.

An object lists its templates as the group `{3daea016-69b7-4ed4-9453-127911372fe6, n, guid...}`
in its metadata. A template's own `<guid>.txt` names it, and its body is `<guid>.0.txt`. A
spreadsheet body is `MOXCEL` and a few binary bytes, then a brace list:

    8, 1, 9, {languages}, {0}, {column sets}, 0, {0,0} x6,
    1, 2, <rows>, then per row: <row>, <format>, <cells>, and per cell <column>, {<cell>}
    {<columns>, 0, <guid>, <count>, then per column <column>, <format>}
    <rows again>, 0 x8,
    {<merges>, {left, top, right, bottom, 0|2} ...}
    {0}, {0},
    {<areas>, name, {1, {kind, left, top, right, bottom, guid}, 0} ...}
    ... {<formats>, {mask, values...} ...}, then {<fonts>, {7, ..., height, ..., weight, ...,
    face, ...}}, the cell value formats, the colors

A cell is `{0, format}` when it is empty, `{16, format, {1, 1, {lang, text}}}` when it holds
text or a parameter - lang "" is a parameter, the text its name - and `{20, format, {"U"},
{1, 1, {lang, text}}}` a template whose `[Name]` are parameters. An area is rows (kind 1, left
and right -1) or columns (kind 2), inclusive. A cell's format is 1-based, 0 for none; a format's font is 0-based.

A format is a bit mask and its values in the order of the bits, low first. What each bit means
was read off the client's templates: font index (1); the left, top, right and bottom border, a
line index (2, 4, 8, 16); height (64) and width (128) in 1C's units. The other bits - alignment
and text placement among them - are carried by number and not reproduced, nor are colors and
line styles: the HTML is a layout to author a print form from, not a facsimile.

    python tools/1c.py mxl list                    # every template: object, name, kind, size
    python tools/1c.py mxl list --client           # the integrator's objects only (мсб*, рз*)
    python tools/1c.py mxl dump <object> [<name>]  # to out/templates/<object>/<name>.html, .json
"""
from __future__ import print_function

import codecs
import html
import io
import json
import os
import re
import sys

import meta
import binding
import paths

TEMPLATES = "3daea016-69b7-4ed4-9453-127911372fe6"
CLIENT = tuple(binding.client_prefixes())
OUT = os.path.join(paths.OUT, "templates")

# a format's bits, in the order their values follow the mask; the unnamed ones are kept by number
NAMED = {1: "font", 2: "left", 4: "top", 8: "right", 16: "bottom", 64: "height", 128: "width"}
BITS = [(1 << k, NAMED.get(1 << k, "b%d" % (1 << k))) for k in range(32)]


def objects():
	with codecs.open(os.path.join(paths.OUT, "objects_all.json"), "r", "utf-8") as f:
		return [o for o in json.load(f) if o.get("name")]


def templates_of(guid):
	"""[(template guid, name, synonym)] an object lists."""
	text = meta.load(guid)
	if text is None:
		return []
	found = []
	for group in meta.collect_guid_groups(meta.parse(text)):
		if group["classGuid"] != TEMPLATES:
			continue
		for member in group["members"]:
			head = meta.load(member)
			if head is None:
				continue
			name, syn = meta.object_header(head)
			found.append((member, name, syn.get("ru") or syn.get("uk") or ""))
	return found


def body(guid):
	"""The template's body as bytes, or None."""
	for suffix in (".0.txt", ".0.bin", ".0"):
		path = os.path.join(meta.CONFIG, guid + suffix)
		if os.path.isfile(path):
			with open(path, "rb") as f:
				return f.read()
	return None


def kind(data):
	if data is None:
		return "missing"
	if data.startswith(b"MOXCEL"):
		return "mxl"
	return "other"


def inventory(client_only=False):
	"""[(object family, object name, template guid, template name, synonym, kind, size)]."""
	seen = set()
	out = []
	for o in objects():
		if o["guid"] in seen or (client_only and not (o["name"] or "").startswith(CLIENT)):
			continue
		seen.add(o["guid"])
		for guid, name, syn in templates_of(o["guid"]):
			data = body(guid)
			out.append((o.get("family") or "", o["name"], guid, name, syn, kind(data), len(data or b"")))
	return out


# --------------------------------------------------------------------------- the spreadsheet

def tree(data):
	at = data.find(b"{")
	return meta.parse(data[at:].decode("utf-8", "replace"))


def _int(value, default=0):
	try:
		return int(value)
	except (TypeError, ValueError):
		return default


def _format(entry):
	"""{property: value} of a format entry {mask, values...}."""
	mask = _int(entry[0])
	values = entry[1:]
	out = {}
	k = 0
	for bit, name in BITS:
		if mask & bit:
			out[name] = values[k] if k < len(values) else None
			k += 1
	return out


def _font(entry):
	# {7, 0, ?, height, 0, 0, 0, weight, italic, underline, strike, charset, ..., face, ...}
	at = lambda k: entry[k] if k < len(entry) else None
	return {"size": _int(at(3)) / 10.0, "bold": _int(at(7)) >= 600,
	        "italic": _int(at(8)) != 0, "underline": _int(at(9)) != 0,
	        "face": next((x for x in entry if isinstance(x, str) and x and not x.lstrip("-").isdigit()), "")}


def _text(cell):
	"""(kind, text) of a cell: 'empty', 'text', 'param' or 'template'."""
	tag = _int(cell[0])
	strings = [n for n in meta.walk(cell) if len(n) == 2 and all(isinstance(x, str) for x in n)
	           and n[0] in ("", "ru", "uk", "en")]
	value = strings[-1][1] if strings else ""
	lang = strings[-1][0] if strings else None
	if tag == 0 or not strings:
		return "empty", ""
	if tag == 20 or (lang != "" and re.search(r"\[[^\]]+\]", value)):
		# a text cell naming [Parameter] is filled as a template: the code sets that parameter
		# (the transfer's "Оператор: [ОтпускРазрешил]" is a text cell, tag 16)
		return "template", value
	return ("param" if lang == "" else "text"), value


def read(data):
	"""The spreadsheet as {columns: {col: format}, rows: [{row, format, cells: {col: (kind,
	text, format)}}], merges, areas, formats, fonts}."""
	r = tree(data)
	i = 15
	rows = []
	for _ in range(_int(r[i])):
		i += 1
		row, fmt, n = _int(r[i]), _int(r[i + 1]), _int(r[i + 2])
		i += 2
		cells = {}
		for _c in range(n):
			col, cell = _int(r[i + 1]), r[i + 2]
			kind_, text = _text(cell)
			cells[col] = (kind_, text, _int(cell[1]))
			i += 2
		rows.append({"row": row, "format": fmt, "cells": cells})
	i += 1
	columns = {}
	col_list = r[i]
	for k in range(4, len(col_list) - 1, 2):
		columns[_int(col_list[k])] = _int(col_list[k + 1])
	lists = [x for x in r[i + 1:] if isinstance(x, list)]
	merges, areas, formats, fonts = [], {}, [], []
	for x in lists:
		if not merges and x and _int(x[0]) == len(x) - 1 and all(isinstance(y, list) and len(y) == 5 for y in x[1:]) and len(x) > 1:
			merges = [tuple(_int(v) for v in y[:4]) for y in x[1:]]
		elif not areas and len(x) > 2 and isinstance(x[1], str) and isinstance(x[2], list) and _int(x[0]) * 2 == len(x) - 1:
			for k in range(1, len(x), 2):
				spec = x[k + 1][1]
				areas[x[k]] = {"kind": "rows" if _int(spec[0]) == 1 else "columns" if _int(spec[0]) == 2 else "cells",
				               "left": _int(spec[1]), "top": _int(spec[2]), "right": _int(spec[3]), "bottom": _int(spec[4])}
	# the formats: the count, then that many lists, each a mask and its values
	for k, x in enumerate(r):
		if isinstance(x, str) and x.isdigit() and k + 1 < len(r) and int(x) > 0 and k > i:
			run = r[k + 1:k + 1 + int(x)]
			if len(run) == int(x) and all(isinstance(y, list) and y and str(y[0]).isdigit() for y in run) \
					and all(len(y) == len([b for b, _ in BITS if _int(y[0]) & b]) + 1 for y in run):
				formats = [_format(y) for y in run]
				after = r[k + 1 + int(x)]
				if isinstance(after, str) and after.isdigit():
					fonts = [_font(y) for y in r[k + 2 + int(x):k + 2 + int(x) + int(after)]]
				break
	return {"columns": columns, "rows": rows, "merges": merges, "areas": areas,
	        "formats": formats, "fonts": fonts}


def parameters(sheet, area=None):
	"""The parameter names an area (or the whole sheet) fills, in reading order."""
	names = []
	for row in _rows(sheet, area):
		for col in sorted(row["cells"]):
			kind_, text, _ = row["cells"][col]
			found = [text] if kind_ == "param" else re.findall(r"\[([^\]]+)\]", text) if kind_ == "template" else []
			for name in found:
				if name not in names:
					names.append(name)
	return names


def _rows(sheet, area):
	if area is None:
		return sheet["rows"]
	a = sheet["areas"][area]
	if a["kind"] != "rows":
		return sheet["rows"]
	return [row for row in sheet["rows"] if a["top"] <= row["row"] <= a["bottom"]]


# --------------------------------------------------------------------------- HTML

def _fmt(sheet, index):
	return sheet["formats"][index - 1] if 0 < index <= len(sheet["formats"]) else {}


def _width(sheet, col):
	return _int(_fmt(sheet, sheet["columns"].get(col, 0)).get("width"), 0)


def _style(sheet, fmt):
	css = []
	font = _int(fmt.get("font"), -1)
	if 0 <= font < len(sheet["fonts"]) and "font" in fmt:
		f = sheet["fonts"][font]
		if f["bold"]:
			css.append("font-weight:bold")
		if f["italic"]:
			css.append("font-style:italic")
		if f["underline"]:
			css.append("text-decoration:underline")
		if f["size"]:
			css.append("font-size:%gpt" % f["size"])
	for side in ("left", "top", "right", "bottom"):
		if side in fmt:
			css.append("border-%s:1px solid #000" % side)
	return ";".join(css)


def area_html(sheet, area=None, value=None):
	"""An area as an HTML table. `value(kind, text)` renders a cell's content - by default the
	text as is and a parameter as `{{ name }}`."""
	value = value or _liquid
	rows = _rows(sheet, area)
	if not rows:
		return ""
	top, bottom = rows[0]["row"], rows[-1]["row"]
	width = max([max(r["cells"]) for r in rows if r["cells"]] + [max(sheet["columns"] or [0])]) + 1
	spans, covered = {}, set()
	for left, t, right, b in sheet["merges"]:
		if right < 0 or b < 0:
			continue
		if t < top or b > bottom:
			continue
		spans[(t, left)] = (b - t + 1, right - left + 1)
		for rr in range(t, b + 1):
			for cc in range(left, right + 1):
				if (rr, cc) != (t, left):
					covered.add((rr, cc))
	widths = [max(1, _width(sheet, col)) for col in range(width)]
	out = ['<table class="mxl">', "<colgroup>"]
	for w in widths:
		out.append('<col style="width:%.2f%%">' % (100.0 * w / sum(widths)))
	out.append("</colgroup>")
	by_row = dict((r["row"], r) for r in rows)
	for rn in range(top, bottom + 1):
		row = by_row.get(rn, {"cells": {}, "format": 0})
		height = _int(_fmt(sheet, row["format"]).get("height"), 0)
		out.append('<tr%s>' % (' style="height:%dpx"' % (height * 4 / 3) if height else ""))
		for col in range(width):
			if (rn, col) in covered:
				continue
			kind_, text, fmt = row["cells"].get(col, ("empty", "", 0))
			attrs = ""
			if (rn, col) in spans:
				rs, cs = spans[(rn, col)]
				attrs += (' rowspan="%d"' % rs if rs > 1 else "") + (' colspan="%d"' % cs if cs > 1 else "")
			style = _style(sheet, _fmt(sheet, fmt))
			if style:
				attrs += ' style="%s"' % style
			out.append("<td%s>%s</td>" % (attrs, value(kind_, text)))
		out.append("</tr>")
	out.append("</table>")
	return "\n".join(out)


def _liquid(kind_, text):
	if kind_ == "param":
		return "{{ %s }}" % text
	if kind_ == "template":
		return re.sub(r"\[([^\]]+)\]", lambda m: "{{ %s }}" % m.group(1), html.escape(text))
	return html.escape(text).replace("\n", "<br>")


def dump(obj_name, template_name=None):
	written = []
	for o in objects():
		if o["name"] != obj_name:
			continue
		for guid, name, syn in templates_of(o["guid"]):
			if template_name and name != template_name:
				continue
			data = body(guid)
			if kind(data) != "mxl":
				continue
			sheet = read(data)
			folder = os.path.join(OUT, obj_name)
			if not os.path.isdir(folder):
				os.makedirs(folder)
			parts = ["<!-- %s.%s: %s -->" % (obj_name, name, syn)]
			for area in sorted(sheet["areas"], key=lambda a: sheet["areas"][a]["top"]):
				if sheet["areas"][area]["kind"] != "rows":
					continue
				parts.append("<h3>%s</h3>" % html.escape(area))
				parts.append(area_html(sheet, area))
			if not any(a["kind"] == "rows" for a in sheet["areas"].values()):
				parts.append(area_html(sheet))
			with io.open(os.path.join(folder, name + ".html"), "w", encoding="utf-8") as f:
				f.write(u"\n".join(parts) + u"\n")
			info = {"object": obj_name, "template": name, "synonym": syn,
			        "areas": dict((a, dict(v, parameters=parameters(sheet, a))) for a, v in sheet["areas"].items()),
			        "parameters": parameters(sheet)}
			with io.open(os.path.join(folder, name + ".json"), "w", encoding="utf-8") as f:
				f.write(json.dumps(info, ensure_ascii=False, indent="\t") + u"\n")
			written.append(os.path.join(folder, name))
	return written


def main():
	args = sys.argv[1:]
	command = args[0] if args else "list"
	if command == "list":
		rows = inventory("--client" in args)
		for family, obj, guid, name, syn, kind_, size in rows:
			print("%-10s %-45s %-50s %-6s %7d" % (family, obj, name, kind_, size))
		print("%d template(s), %d spreadsheet(s)" % (len(rows), sum(1 for r in rows if r[5] == "mxl")))
		return 0
	if command == "dump" and len(args) >= 2:
		for path in dump(args[1], args[2] if len(args) > 2 else None):
			print(path)
		return 0
	print(__doc__)
	return 2


if __name__ == "__main__":
	sys.exit(main())
