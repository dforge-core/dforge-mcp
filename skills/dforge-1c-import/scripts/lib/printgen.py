# -*- coding: utf-8 -*-
"""Write a module's ported 1C print forms from one compact spec, and preview them.

A print form reads its data from the module's stored procedures (a print template's
`datasets`, each a procedure keyed by the record): the procedures' signatures and columns go
in `logic/stored_procedures.json`, the rights to run them in `security/roles.json`, the
template in `ui/print_templates.json` beside its HTML and CSS under `print_templates/`. This
writes the first three from one spec into the project's `authored/<module>/` tree, which
`genmodule` lays over the generated module; the template's HTML and CSS are the project's own
files there. A procedure's columns are read off its `RETURNS TABLE` in the module's SQL, so the
declaration cannot drift from the function.

`ui/print_templates.json` is written only when the platform takes `datasets` on a template
(PRINT_DATASETS=1): until then the schema refuses the key, and a template without its data
would print empty, so the forms wait and the procedures are installed and runnable on their
own.

A spec module (tools/project/prints_<module>.py) defines MODULE, ROLES, SQL (the files that
declare its procedures) and PRINTS, a list of `print_form(...)`.

    python tools/lib/printgen.py tools/project/prints_warehouse.py
    python tools/1c.py printgen preview tools/project/prints_warehouse.py <form> <key>
                                                  # render one record with LiquidJS, screenshot it
"""
from __future__ import print_function

import codecs
import collections
import decimal
import imp
import io
import json
import os
import re
import subprocess
import sys

O = collections.OrderedDict
HERE = os.path.dirname(os.path.abspath(__file__))

# a procedure column's pg type -> (fieldTypeCd, baseDatatypeCd)
PG = {"text": ("text", "string"), "integer": ("number", "number"), "numeric": ("number", "number"),
      "boolean": ("checkbox", "bool"), "date": ("date", "date"), "timestamptz": ("datetime", "timestamp"),
      "uuid": ("text", "string")}


def dataset(name, sp, single=False):
	"""A template's dataset: its name in the template, the procedure, one row or many."""
	return dict(name=name, sp=sp, single=single)


def print_form(code, entity, en, uk, file, datasets, key, css=None, orientation="portrait",
               size="A4", source=None):
	"""A print form on `entity` (the module's own, or `module.entity`), its procedures called
	with the record's `key` column."""
	return dict(code=code, entity=entity, en=en, uk=uk, file=file, css=css, datasets=datasets,
	            key=key, orientation=orientation, size=size, source=source)


def _read(path):
	if not os.path.isfile(path):
		return O()
	with codecs.open(path, "r", "utf-8") as f:
		return json.load(f, object_pairs_hook=O)


def _write(path, doc):
	directory = os.path.dirname(path)
	if not os.path.isdir(directory):
		os.makedirs(directory)
	with codecs.open(path, "w", "utf-8") as f:
		f.write(json.dumps(doc, ensure_ascii=False, indent="\t") + "\n")


def signatures(sql_paths):
	"""{function name: (params [(name, pg type)], columns [(name, pg type)])} off the SQL."""
	out = {}
	pattern = re.compile(r"CREATE OR REPLACE FUNCTION\s+\w+\.(\w+)\s*\(([^)]*)\)\s*RETURNS TABLE\s*\((.*?)\)\s*LANGUAGE",
	                     re.S | re.I)
	for path in sql_paths:
		with io.open(path, encoding="utf-8") as f:
			text = f.read()
		for name, params, columns in pattern.findall(text):
			def pairs(spec):
				return [tuple(part.strip().split()[:2]) for part in spec.split(",") if part.strip()]
			out[name] = (pairs(params), pairs(columns))
	return out


def build(spec, root):
	sql = [os.path.join(root, p) for p in spec.SQL]
	sigs = signatures(sql)
	sps = _read(os.path.join(root, "logic", "stored_procedures.json"))
	for k in [k for k in sps if k.startswith("prn_")]:
		del sps[k]
	rights = O()
	templates = O()
	uk = O()
	for form in spec.PRINTS:
		for ds in form["datasets"]:
			if ds["sp"] not in sigs:
				raise SystemExit("printgen: %s is not declared in %s" % (ds["sp"], ", ".join(spec.SQL)))
			params, columns = sigs[ds["sp"]]
			sps[ds["sp"]] = O([
				("description", "%s: %s" % (form["en"], ds["name"])), ("functionName", ds["sp"]),
				("params", [O([("paramCd", p), ("pgType", t), ("fieldTypeCd", PG.get(t, PG["text"])[0]),
				               ("label", p), ("required", True)]) for p, t in params]),
				("columns", [O([("columnCd", c), ("label", c), ("fieldTypeCd", PG.get(t, PG["text"])[0]),
				                ("baseDatatypeCd", PG.get(t, PG["text"])[1])]) for c, t in columns])])
			rights["sp:" + ds["sp"]] = "E"
		entry = O([("entityCd", form["entity"]), ("description", form["uk"]), ("file", form["file"])])
		if form["css"]:
			entry["css"] = form["css"]
		entry["pageSettings"] = O([("size", form["size"]), ("orientation", form["orientation"]),
		                           ("margins", O([("top", "8mm"), ("right", "8mm"), ("bottom", "8mm"), ("left", "8mm")]))])
		entry["datasets"] = O((ds["name"], O([("sp", ds["sp"]), ("params", O([(sigs[ds["sp"]][0][0][0], form["key"])])),
		                                      ("single", ds["single"])])) for ds in form["datasets"])
		templates[form["code"]] = entry
		uk[form["code"]] = {"label": form["uk"]}

	_write(os.path.join(root, "logic", "stored_procedures.json"), sps)
	path = os.path.join(root, "security", "roles.json")
	doc = _read(path)
	for role in spec.ROLES:
		r = doc.setdefault(role, O([("rights", O())]))
		r.setdefault("rights", O())
		for key in [k for k in r["rights"] if k.startswith("sp:prn_")]:
			del r["rights"][key]
		r["rights"].update(rights)
	_write(path, doc)
	path = os.path.join(root, "translations", "uk-UA.json")
	translations = _read(path)
	translations["print_templates"] = uk
	_write(path, translations)
	target = os.path.join(root, "ui", "print_templates.json")
	if os.environ.get("PRINT_DATASETS") == "1":
		_write(target, templates)
	elif os.path.isfile(target):
		os.remove(target)
	return templates


# --------------------------------------------------------------------------- preview

RENDER_JS = r"""
const { Liquid } = require('liquidjs');
const fs = require('fs');
const [tpl, css, data, out] = process.argv.slice(2);
const engine = new Liquid();
const nf = (v, d) => (v === null || v === undefined || v === '') ? '' :
	Number(v).toLocaleString('uk-UA', { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 });
engine.registerFilter('format_number', (v, d) => nf(v, d));
engine.registerFilter('format_currency', (v, c, d) => nf(v, d === undefined ? 2 : d) + (c ? ' ' + c : ''));
engine.registerFilter('format_date', (v) => v === null || v === undefined ? '' : String(v));
const ctx = JSON.parse(fs.readFileSync(data, 'utf8'));
engine.parseAndRender(fs.readFileSync(tpl, 'utf8'), ctx).then(html => {
	fs.writeFileSync(out, '<!doctype html><html><head><meta charset="utf-8"><style>' +
		(css ? fs.readFileSync(css, 'utf8') : '') + '</style></head><body>' + html + '</body></html>');
});
"""

EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"


def _plain(value):
	if isinstance(value, decimal.Decimal):
		return float(value)
	if hasattr(value, "isoformat"):
		return value.isoformat()
	return value


def preview(spec, root, code, key, out_dir, node_dir):
	"""Render one record's form with LiquidJS (the editor's engine) to HTML and a PNG."""
	import migrate
	migrate.load_env()
	form = [f for f in spec.PRINTS if f["code"] == code][0]
	pg = migrate.pg_connect()
	pg.autocommit = True
	cur = pg.cursor()
	# the module's SQL as written, in a transaction rolled back after the read: the functions the
	# installer owns are left as they are
	cur.execute("BEGIN")
	for path in spec.SQL:
		with io.open(os.path.join(root, path), encoding="utf-8") as f:
			cur.execute(f.read())
	ctx = {}
	for ds in form["datasets"]:
		cur.execute("SELECT * FROM %s.%s(%%s)" % (spec.SCHEMA, ds["sp"]), (key,))
		names = [d[0] for d in cur.description]
		rows = [dict((n, _plain(v)) for n, v in zip(names, r)) for r in cur.fetchall()]
		ctx[ds["name"]] = (rows[0] if rows else None) if ds["single"] else rows
	cur.execute("ROLLBACK")
	if not os.path.isdir(out_dir):
		os.makedirs(out_dir)
	data = os.path.join(out_dir, code + ".json")
	with io.open(data, "w", encoding="utf-8") as f:
		f.write(json.dumps(ctx, ensure_ascii=False))
	script = os.path.join(node_dir, "render.js")
	with io.open(script, "w", encoding="utf-8") as f:
		f.write(RENDER_JS)
	html = os.path.join(out_dir, code + ".html")
	tpl = os.path.join(root, "print_templates", form["file"])
	css = os.path.join(root, "print_templates", form["css"]) if form["css"] else ""
	subprocess.check_call(["node", script, tpl, css, data, html], cwd=node_dir)
	png = os.path.join(out_dir, code + ".png")
	width = 1400 if form["orientation"] == "landscape" else 1000
	subprocess.call([EDGE, "--headless=new", "--disable-gpu", "--screenshot=" + png,
	                 "--window-size=%d,1300" % width, "file:///" + html.replace("\\", "/")],
	                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
	return html, png


def load(spec_path):
	return imp.load_source(os.path.splitext(os.path.basename(spec_path))[0], spec_path)


def main(argv):
	if len(argv) > 1 and argv[1] == "preview":
		spec = load(argv[2])
		root = os.path.normpath(os.path.join(HERE, "..", "project", "authored", spec.MODULE))
		out = os.environ.get("PRINT_PREVIEW_DIR") or os.path.join(HERE, "..", "..", "out", "prints")
		node = os.environ.get("PRINT_NODE_DIR")
		if not node:
			raise SystemExit("printgen preview: set PRINT_NODE_DIR to a folder with liquidjs installed")
		for path in preview(spec, root, argv[3], argv[4], os.path.normpath(out), node):
			print(path)
		return 0
	for spec_path in argv[1:]:
		spec = load(spec_path)
		root = os.path.normpath(os.path.join(HERE, "..", "project", "authored", spec.MODULE))
		templates = build(spec, root)
		print("%s: %d print form(s)%s" % (spec.MODULE, len(templates),
		      "" if os.environ.get("PRINT_DATASETS") == "1" else ", templates held until the platform takes datasets"))
	return 0


if __name__ == "__main__":
	sys.exit(main(sys.argv))
