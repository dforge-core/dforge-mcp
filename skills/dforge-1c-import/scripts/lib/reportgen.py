# -*- coding: utf-8 -*-
"""Write a module's ported 1C reports from one compact spec.

A report over a stored procedure is declared in four places that have to agree - the
report (`ui/reports.json`), the procedure's call signature and columns
(`logic/stored_procedures.json`), the Ukrainian labels of both (`translations/uk-UA.json`)
and the rights to run them (`security/roles.json`) - and the platform binds them by code,
so a parameter spelled one way in the report and another in the procedure binds NULL
without a word. This writes all four from one spec, into the project's `authored/<module>/`
tree, which `genmodule` lays over the generated module; the menu gets a Reports section
from the reports file (genmodule.auto_menu).

A spec module (tools/project/reports_<module>.py) defines MODULE and REPORTS, an ordered
list of `report(...)`. The SQL of each procedure is the project's own file under
`authored/<module>/logic/reports/`.

    python tools/lib/reportgen.py tools/project/reports_production.py
"""
from __future__ import print_function

import codecs
import collections
import imp
import json
import os
import sys

O = collections.OrderedDict

KINDS = {
	"money": ("currency", "number", 140),
	"qty": ("number", "number", 120),
	"int": ("number", "number", 70),
	"date": ("date", "date", 110),
	"datetime": ("datetime", "timestamp", 150),
	"text": ("text", "string", 160),
	"name": ("text", "string", 380),
	"bool": ("checkbox", "bool", 80),
}

PG_FIELD = {"date": "date", "integer": "number", "numeric": "number", "boolean": "checkbox",
            "text": "text", "uuid": "lookup"}


def col(code, en, uk, kind="text", width=None):
	"""A result column: its code, English and Ukrainian labels, and kind (KINDS)."""
	return dict(code=code, en=en, uk=uk, kind=kind, width=width)


def param(code, pg, en, uk, required=False, default=None, link=None):
	"""A parameter: the procedure's argument and the report's, the same code in both. `link`
	names the entity a uuid parameter picks from (`masterdata.warehouse`)."""
	return dict(code=code, pg=pg, en=en, uk=uk, required=required, default=default, link=link)


def report(code, en, uk, sp, description, params, columns, source=None):
	"""A report over one procedure. `source` names the 1C report it ports."""
	return dict(code=code, en=en, uk=uk, sp=sp, description=description, params=params,
	            columns=columns, source=source)


def date_from(required=True):
	return param("p_date_from", "date", "From", u"Початок періоду", required, "=STARTMONTH(NOW())")


def date_to(required=True):
	return param("p_date_to", "date", "To", u"Кінець періоду", required, "=ENDMONTH(NOW())")


def _field(p):
	field = O([("fieldTypeCd", "lookup" if p["link"] else PG_FIELD.get(p["pg"], "text")),
	           ("label", p["en"]), ("required", p["required"])])
	if p["default"] is not None:
		field["default"] = p["default"]
	if p["link"]:
		field["params"] = {"link": {"entity": p["link"]}}
	return field


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


def build(module, reports, roles, root):
	"""Write the four files for `module` under `root` (authored/<module>/)."""
	ui, sps, uk_reports, uk_sps, rights = O(), O(), O(), O(), O()
	for r in reports:
		columns = []
		for c in r["columns"]:
			field, base, width = KINDS[c["kind"]]
			columns.append(O([("columnCd", c["code"]), ("label", c["en"]), ("fieldTypeCd", field),
			                  ("baseDatatypeCd", base), ("width", c["width"] or width)]))
		sps[r["sp"]] = O([
			("description", r["description"]), ("functionName", r["sp"]),
			("params", [O([("paramCd", p["code"]), ("pgType", p["pg"]),
			               ("fieldTypeCd", _field(p)["fieldTypeCd"]), ("label", p["en"]),
			               ("required", p["required"])]) for p in r["params"]]),
			("columns", columns)])
		uk_sps[r["sp"]] = {"columns": O((c["code"], {"label": c["uk"]}) for c in r["columns"])}
		ui[r["code"]] = O([
			("label", r["en"]),
			("description", r["description"] + (" (1C %s)" % r["source"] if r["source"] else "")),
			("parameters", O((p["code"], _field(p)) for p in r["params"])),
			("layout", {"panels": [O([("vizType", "table"), ("datasetCd", "rows"), ("title", r["en"])])]}),
			("datasets", {"rows": O([("caption", r["en"]), ("datasetType", "S"), ("spCd", r["sp"])])})])
		uk_reports[r["code"]] = O([("label", r["uk"]),
		                           ("params", O((p["code"], {"label": p["uk"]}) for p in r["params"])),
		                           ("datasets", {"rows": {"caption": r["uk"]}})])
		rights["report:" + r["code"]] = "E"
		rights["sp:" + r["sp"]] = "E"

	_write(os.path.join(root, "ui", "reports.json"), ui)
	# the print forms' procedures (printgen, prn_*) share the file and are kept
	kept = _read(os.path.join(root, "logic", "stored_procedures.json"))
	sps.update((k, v) for k, v in kept.items() if k.startswith("prn_"))
	_write(os.path.join(root, "logic", "stored_procedures.json"), sps)

	path = os.path.join(root, "translations", "uk-UA.json")
	translations = _read(path)
	translations["reports"] = uk_reports
	translations["storedProcedures"] = uk_sps
	_write(path, translations)

	path = os.path.join(root, "security", "roles.json")
	doc = _read(path)
	for role in roles:
		entry = doc.setdefault(role, O([("rights", O())]))
		entry.setdefault("rights", O())
		for key in [k for k in entry["rights"] if k.startswith(("report:", "sp:")) and not k.startswith("sp:prn_")]:
			del entry["rights"][key]
		entry["rights"].update(rights)
	_write(path, doc)
	return len(reports)


def main(argv):
	here = os.path.dirname(os.path.abspath(__file__))
	for spec_path in argv[1:]:
		spec = imp.load_source(os.path.splitext(os.path.basename(spec_path))[0], spec_path)
		root = os.path.join(here, "..", "project", "authored", spec.MODULE)
		count = build(spec.MODULE, spec.REPORTS, spec.ROLES, os.path.normpath(root))
		print("%s: %d report(s)" % (spec.MODULE, count))


if __name__ == "__main__":
	main(sys.argv)
