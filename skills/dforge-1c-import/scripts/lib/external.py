#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Pull the external reports and processings an infobase keeps in a catalog out to files.

УТП-based configurations store a user's `.erf` / `.epf` in `Справочник.ВнешниеОбработки`,
attribute `ХранилищеВнешнейОбработки` - a ValueStorage. The value is not compressed:

    01 01 | u32 header length | u32 0 | the header, UTF-8: {"#",<ДвоичныеДанные guid>,{1,{0}}}
    u32 0 | u32 data length | u32 0 | the file itself

and the file is the same paged container `unpack.py` reads for the configuration, its
entries nested a level deeper:

    root                  {2,<object guid>,}
    <object guid>         the object's metadata - its name, forms, templates
    <guid>.0              a container: `info` + `text` is the object module,
                          `form` + `module` a form
    <form or template>    metadata naming it; a template's body is its `.0`, not a container
    <guid>.1              help, base64 HTML - skipped

    python tools/1c.py external                      # every row, to out/external/<code>/
    python tools/1c.py external --kind Отчет         # one kind of processing only
    python tools/1c.py external --catalog <Name>     # another catalog of the same shape

Each row gets `info.json` (code, name, kind, the object's name, its forms and templates)
and the texts: `ObjectModule.bsl`, `Form.<name>.bsl`, `Form.<name>.form`, `Template.<name>.*`.
"""
from __future__ import print_function

import codecs
import json
import os
import re
import shutil
import struct
import sys

import attrs
import meta
import migrate
import paths
import unpack

CONTAINER = b"\xff\xff\xff\x7f"


def stored_file(blob):
	"""The file a ValueStorage holding ДвоичныеДанные carries, or None."""
	blob = bytes(blob or b"")
	if len(blob) < 10 or blob[:2] != b"\x01\x01":
		return None
	(head,) = struct.unpack_from("<I", blob, 2)
	at = 10 + head
	if len(blob) < at + 12:
		return None
	(size,) = struct.unpack_from("<I", blob, at + 4)
	return blob[at + 12:at + 12 + size]


IDENTITY = re.compile(r'\{\d+,\s*\d+,\s*[0-9a-f-]{36}\},\s*"((?:[^"]|"")*)",\s*'
                      r'(?:\{\d+,\s*"[a-z]{2}",\s*"((?:[^"]|"")*)")?')


def name_of(text):
	"""(name, synonym) off the first identity block - `{1,0,<guid>},"Name",{1,"ru","..."}`.
	Its guid is the object's own, not the one `root` names."""
	m = IDENTITY.search(text or "")
	if not m:
		return None, None
	return m.group(1).replace('""', '"'), (m.group(2) or "").replace('""', '"') or None


def read(file_bytes):
	"""{'object': name, 'synonym', 'module': text, 'forms': {name: (form, module)},
	'templates': {name: bytes}} for one external report or processing."""
	top = dict(unpack.entries(file_bytes))
	texts = dict((k, unpack.as_text(v)) for k, v in top.items() if v[:4] != CONTAINER)
	root = re.search(r"\{2,\s*([0-9a-f-]{36})", texts.get("root") or "")
	object_guid = root.group(1) if root else None
	name, synonym = name_of(texts.get(object_guid))
	out = {"object": name, "synonym": synonym,
	       "module": None, "forms": {}, "templates": {}}
	for key, body in sorted(top.items()):
		if not key.endswith(".0"):
			continue
		guid = key[:-2]
		if body[:4] == CONTAINER:
			inner = dict(unpack.entries(body))
			if "form" in inner:
				form = name_of(texts.get(guid))[0] or guid
				out["forms"][form] = (unpack.as_text(inner["form"]), unpack.as_text(inner.get("module") or b""))
			elif "text" in inner:
				out["module"] = unpack.as_text(inner["text"])
		elif guid in texts:
			out["templates"][name_of(texts[guid])[0] or guid] = body
	return out


def template_files(name, body):
	"""[(file name, bytes)]. A composition schema is a short binary header and then several XML
	documents back to back - the schema, its settings, ... - each its own file."""
	starts = [m.start() for m in re.finditer(b"(?:\\xef\\xbb\\xbf)?<\\?xml", body)]
	if starts:
		parts = [body[a:b] for a, b in zip(starts, starts[1:] + [len(body)])]
		return [("Template.%s%s.xml" % (name, "" if i == 0 else ".%d" % i), part)
		        for i, part in enumerate(parts)]
	text = unpack.as_text(body)
	if text:
		return [("Template.%s.txt" % name, text.encode("utf-8"))]
	return [("Template.%s.bin" % name, body)]


def safe(name):
	return re.sub(r'[\\/:*?"<>|]', "_", name or "")


def write(folder, row, parsed):
	if os.path.isdir(folder):
		shutil.rmtree(folder)
	os.makedirs(folder)
	files = []

	def put(file_name, data):
		with open(os.path.join(folder, file_name), "wb") as f:
			f.write(data if isinstance(data, bytes) else data.encode("utf-8"))
		files.append(file_name)

	if parsed["module"]:
		put("ObjectModule.bsl", parsed["module"])
	for form, (layout, module) in sorted(parsed["forms"].items()):
		if layout:
			put("Form.%s.form" % safe(form), layout)
		if module:
			put("Form.%s.bsl" % safe(form), module)
	for template, body in sorted(parsed["templates"].items()):
		for file_name, data in template_files(safe(template), body):
			put(file_name, data)
	info = dict(row, object=parsed["object"], synonym=parsed["synonym"],
	            forms=sorted(parsed["forms"]), templates=sorted(parsed["templates"]), files=files)
	with codecs.open(os.path.join(folder, "info.json"), "w", "utf-8") as f:
		json.dump(info, f, ensure_ascii=False, indent="\t")
	return info


def physical(objects, index, name):
	"""(table, {attribute: column}) for a catalog, resolved through DBNames."""
	guid, fields = attrs.fields_of(name, objects, attrs.load_json("typemap.json"))
	if not guid or guid not in index:
		raise SystemExit("no catalog %s in this configuration" % name)
	columns = {}
	for field in fields or []:
		entry = index.get(field.get("guid"))
		if entry and not field.get("section"):
			columns[field["name"]] = entry["physical"]
	return index[guid]["physical"], columns


def main():
	args = sys.argv[1:]
	catalog = args[args.index("--catalog") + 1] if "--catalog" in args else u"ВнешниеОбработки"
	only = args[args.index("--kind") + 1] if "--kind" in args else None

	objects = attrs.load_json("objects.json")
	index = meta.dbnames_index()
	table, columns = physical(objects, index, catalog)
	storage, kind = columns[u"ХранилищеВнешнейОбработки"], columns[u"ВидОбработки"]

	enum_guid = next(o["guid"] for o in objects
	                 if o.get("family") == "Enum" and o.get("name") == u"ВидыДополнительныхВнешнихОбработок")
	enum_table = index[enum_guid]["physical"]
	kinds = attrs.enum_values(meta.parse(meta.load(enum_guid)), u"ВидыДополнительныхВнешнихОбработок")

	cur = migrate.mssql_connect().cursor()
	cur.execute("SELECT t._Code, t._Description, t._Marked, e._EnumOrder, t.%s FROM %s t "
	            "LEFT JOIN %s e ON e._IDRRef = t.%sRRef WHERE t._Folder = 0x01"
	            % (storage, table, enum_table, kind))
	root = os.path.join(paths.OUT, "external")
	index_rows, skipped = [], []
	for code, name, marked, order, blob in cur.fetchall():
		kind_name = kinds[int(order)] if order is not None and int(order) < len(kinds) else None
		if only and kind_name != only:
			continue
		row = {"code": code.strip(), "name": name.strip(), "kind": kind_name, "marked": marked == b"\x01"}
		data = stored_file(blob)
		if not data or data[:4] != CONTAINER:
			skipped.append(row)
			continue
		info = write(os.path.join(root, row["code"]), row, read(data))
		index_rows.append(dict((k, info[k]) for k in ("code", "name", "kind", "marked", "object", "files")))

	index_rows.sort(key=lambda r: r["code"])
	with codecs.open(os.path.join(root, "index.json"), "w", "utf-8") as f:
		json.dump(index_rows, f, ensure_ascii=False, indent="\t")
	print("%d written to %s, %d without a file" % (len(index_rows), root, len(skipped)))
	for row in skipped:
		print("   no file: %s %s" % (row["code"], row["name"]))


if __name__ == "__main__":
	main()
