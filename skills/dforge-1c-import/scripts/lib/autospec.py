#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Extracted 1C model -> genmodule specs, for the whole infobase.

`spec_fleet.py` and `spec_shipping.py` were written by hand, which was the right way to
learn what a good port looks like and the wrong way to do 124 more objects. This builds
the same spec structure from the extracted model instead: names through `naming.py`,
field types from the type patterns, references resolved against a registry of everything
being ported, tabular sections as their own line entities, and the standard 1C columns
(`_Code`, `_Description`, `_Number`, `_Posted`, `_Period`, `_Recorder`) taken from the
physical table rather than assumed.

What it deliberately does not do:

  * it does not wire accumulation registers as `columnType: "A"` columns. A register
    column needs the posting logic that fills it, which is ported per contour; until then
    the register is an ordinary table, which is also exactly what a direct data copy
    needs. See docs/design-migration.md.
  * it does not invent Ukrainian. Base labels are English, derived from the 1C synonym
    through the same dictionary; `translations/uk-UA.json` is authored per contour as it
    is reviewed, as it already is for fleet, shipping and masterdata.

    python tools/autospec.py              # what would be generated, per module
    python tools/autospec.py <module>     # one module's entities, in detail
"""
from __future__ import print_function

import codecs
import collections
import json
import os
import re
import sys

import attrs
import binding

contours = binding.contours()
import meta
import naming

# 1C objects that are already entities in a hand-written spec: the project says which
# (`contours.HAND_ENTITIES`), since which objects were authored is the project's choice.
HAND_ENTITIES = binding.hand_entities()

# 1C catalogs the port does not own but fields point at. Each gets a minimal entity in
# masterdata - key, code, name, deletion mark - so the reference survives as a reference
# instead of decaying into an opaque GUID. Filled by resolve(), emitted by stubs().
STUBS = collections.Counter()

# Reference targets that are not catalogs (documents, business processes, the vendor's
# own registers) and composite references with several targets. These become a plain
# uuid column: the value is kept for the migration, but there is nothing to point it at.
RAW = collections.Counter()
# (physical type, what the metadata claimed) -> how many fields disagreed.
MISTYPED = collections.Counter()

TYPE_RE = re.compile(r"^(string|number|bool|date)")

# Physical columns every family carries, and what the port calls them.
RESERVED = {"code", "name", "deletion_mark", "is_folder", "parent", "owner",
            "doc_no", "doc_date", "posted", "period", "recorder", "line_no",
            "is_active", "record_kind"}

# Those same columns in Ukrainian. They come from 1C's own vocabulary rather than from a
# synonym, so they are named here instead of going through the dictionary.
STANDARD_UK = {
	"code": u"Код",
	"name": u"Найменування",
	"deletion_mark": u"Позначка видалення",
	"is_folder": u"Група",
	"parent": u"Батьківська група",
	"owner": u"Власник",
	"doc_no": u"Номер",
	"doc_date": u"Дата",
	"posted": u"Проведено",
	"deletion_mark_doc": u"Позначка видалення",
	"period": u"Період",
	"recorder": u"Документ-реєстратор",
	"line_no": u"№ рядка",
	"record_kind": u"Вид руху",
	"is_active": u"Активність",
	"account_kind": u"Вид рахунку",
	"off_balance": u"Позабалансовий",
	"totals_by_analytics": u"Підсумки за аналітикою",
}

RECORD_KIND_UK = {"receipt": u"Прихід", "expense": u"Витрата"}

# The three kinds of account, in the words a Ukrainian accountant uses for them.
ACCOUNT_KIND_UK = {"active": u"Активний", "passive": u"Пасивний",
                   "active_passive": u"Активно-пасивний"}

# The standard columns, and the physical column each one is copied from. `_Recorder` is
# a composite reference: `_RecorderRRef` alone on a register that only one document kind
# writes, `_RecorderTRef` + `_RecorderRRef` where several do.
STANDARD_PHYSICAL = {
	"code": ["_Code"],
	"name": ["_Description"],
	"deletion_mark": ["_Marked"],
	"is_folder": ["_Folder"],
	"parent": ["_ParentIDRRef"],
	"owner": ["_OwnerIDRRef", "_OwnerID_RRRef"],
	"doc_no": ["_Number"],
	"doc_date": ["_Date_Time"],
	"posted": ["_Posted"],
	"period": ["_Period"],
	"recorder": ["_RecorderRRef"],
	"record_kind": ["_RecordKind"],
	"is_active": ["_Active"],
	"account_kind": ["_Kind"],
	"off_balance": ["_OffBalance"],
}

# (module, entity) -> {dForge column: physical column}, filled while generating. The
# migration reads this rather than re-deriving it, so the copy cannot drift from the
# schema it copies into.
COLUMNS = collections.OrderedDict()

# owning module -> {"<module>.<entity>": [field spec, ...]}, for the columns diverted by
# `contours.EXTENSIONS` because they would otherwise invert a dependency.
EXTENSIONS = collections.OrderedDict()


def _pinned():
	"""(1C table, physical column) -> the dForge column name already given to it.

	A name the generator emitted and the loader filled is a column in a tenant, holding rows.
	Renaming it is a migration, and the generator does not know it is doing one: the
	transliteration dictionary improved after the standard configuration's modules were
	loaded (`налоговым` became `tax`, `валютный` `currency`), and a regeneration renamed
	installed columns. So a column the project's column map already names keeps its name; a
	better dictionary applies to columns that are new. Read once, from the map as committed,
	before this run rewrites it.
	"""
	import paths
	path = paths.derived("columnmap.json")
	if not os.path.isfile(path):
		return {}
	with codecs.open(path, "r", "utf-8") as f:
		mapping = json.load(f)
	names = collections.defaultdict(set)
	for entities in mapping.values():
		for spec in entities.values():
			table = spec.get("table")
			for name, source in (spec.get("columns") or {}).items():
				if table and isinstance(source, type(u"")) and source.startswith("_Fld"):
					names[(table, source)].add(name)
	# One 1C column read into two of ours (a magnitude and its direction) pins neither.
	return dict((key, found.pop()) for key, found in names.items() if len(found) == 1)


def _pinned_enums():
	"""1C enum table -> the option codes the project's column map loaded it under, in order."""
	import paths
	path = paths.derived("columnmap.json")
	if not os.path.isfile(path):
		return {}
	with codecs.open(path, "r", "utf-8") as f:
		mapping = json.load(f)
	found = {}
	for entities in mapping.values():
		for spec in entities.values():
			for enum in (spec.get("enums") or {}).values():
				if isinstance(enum, dict) and enum.get("table") and enum.get("options"):
					found.setdefault(enum["table"], list(enum["options"]))
	return found


PINNED = _pinned()
PINNED_ENUMS = _pinned_enums()


def column_name(field, used, table, source, spec, max_len=48):
	"""The column's name: the one the project already gave this 1C column, else a new one.

	The map names a reference by its key column (`<name>_id`); the field is the name
	without it. Any other column is named as it stands, `_id` or not."""
	pinned = PINNED.get((table, source)) if source else None
	if pinned and spec.startswith("ref:"):
		pinned = pinned[:-3] if pinned.endswith("_id") else None
	if pinned and pinned not in used:
		used.add(pinned)
		return pinned
	return naming.unique(field["name"], used, max_len)


# --------------------------------------------------------------------------- loading

class Model(object):
	"""Everything the generator reads, loaded once."""

	def __init__(self):
		self.objects = attrs.load_json("objects.json")
		self.types = attrs.load_json("typemap.json")
		self.report = {}
		for row in attrs.load_json("report.json"):
			self.report[(row["family"], row["name"])] = row
			self.report.setdefault(row["name"], row)
		self.by_name = {}
		for obj in self.objects:
			if obj.get("name"):
				self.by_name[(obj["family"], obj["name"])] = obj
				self.by_name.setdefault(obj["name"], obj)
		with codecs.open(os.path.join(attrs.OUT, "schema.json"), "r", "utf-8") as f:
			schema = json.load(f)
		tables = schema if isinstance(schema, list) else schema["tables"]
		self.tables = {t["name"]: t for t in tables}
		self.registry = {}        # (family, 1C name) -> "module.entity"
		self._enums = {}
		# DBNames keys a Fld entry by the attribute's GUID, which is how a ported column
		# finds the `_FldNNN` holding its data.
		with codecs.open(os.path.join(attrs.OUT, "dbnames.json"), "r", "utf-8") as f:
			names = json.load(f)
		self.fld = dict((e["guid"], e["physical"]) for e in names["entries"]
		                if e["type"] == "Fld")
		# A tabular section's own table and line-number column, keyed the same way.
		self.vt = dict((e["guid"], e["physical"]) for e in names["entries"]
		               if e["type"] == "VT")
		self.line_no = dict((e["guid"], e["physical"]) for e in names["entries"]
		                    if e["type"] == "LineNo")

	def table_columns(self, table):
		found = self.tables.get(table or "")
		return set(c["column"] for c in found["columns"]) if found else set()

	def row(self, name, family=None):
		"""One object's report entry. A name can belong to two families - the infobase
		holds a certificates catalog and a certificates register under the very same
		name - so the family is part of the address wherever it is known."""
		return self.report.get((family, name)) or self.report.get(name) or {}

	def fields(self, name, family=None):
		"""The object's attributes, resolved. The family-aware `attrs.fields_of`."""
		obj = self.by_name.get((family, name)) or self.by_name.get(name)
		if not obj:
			return []
		text = meta.load(obj["guid"])
		if text is None:
			return []
		found = []
		attrs.collect(meta.parse(text), None, None, self.types, found)
		return found

	def physical(self, name, family=None):
		"""The object's own table, and its standard column names."""
		row = self.row(name, family)
		table = self.tables.get(row.get("physical") or "")
		columns = {c["column"] for c in table["columns"]} if table else set()
		return row.get("physical"), columns

	def sections(self, name, family=None):
		"""Tabular-section name -> its physical table, for the sections of one object."""
		physical, _ = self.physical(name, family)
		if not physical:
			return {}
		prefix = physical + "_VT"
		return {n: self.tables[n] for n in self.tables if n.startswith(prefix)}

	def enum_options(self, name):
		"""Enum object -> [(code, label, label_uk)], its values in declaration order."""
		if name in self._enums:
			return self._enums[name]
		obj = self.by_name.get(name)
		options = []
		if obj:
			text = meta.load(obj["guid"])
			if text is not None:
				taken = set()
				for value in attrs.enum_values(meta.parse(text), name):
					options.append((naming.unique(value, taken, 28,
					                             avoid_reserved=False),
					                naming.label(value),
					                naming.label_uk(value) or naming.label(value)))
		# The option codes the project already loaded rows under keep their spelling, by the
		# same rule as column names (see `_pinned`): a stored value that changes spelling is
		# a row that no longer matches its option.
		table, _ = self.physical(name, "Enum")
		kept = PINNED_ENUMS.get(table)
		if kept and len(kept) == len(options):
			options = [(code, label if code == fresh else
			            re.sub(r"_\d+$", "", code).replace("_", " ").capitalize(), uk)
			           for code, (fresh, label, uk) in zip(kept, options)]
		self._enums[name] = options
		return options


# --------------------------------------------------------------------------- types

def parse_target(part):
	"""'-> Reference.Номенклатура' -> ('Reference', 'Номенклатура')"""
	body = part.strip()[3:]
	family, _, name = body.partition(".")
	return family, name


# 1C's own type for a serialized value. The attribute reads as a reference and is
# nothing of the kind: the column is `image`, and what sits in it is 1C's
# serialization - a length, a BOM and a JSON-ish body naming a type GUID.
VALUE_STORAGE = "e199ca70"


def resolve_reference(parts, model):
	"""The reference targets of a field -> a genmodule type, or None for a raw uuid."""
	if len(parts) == 1 and VALUE_STORAGE in parts[0]:
		return "blob"
	targets = [parse_target(p) for p in parts]
	if len(targets) != 1:
		RAW[" + ".join("%s.%s" % t for t in targets)] += 1
		return None
	family, name = targets[0]

	if family == "Enum":
		options = model.enum_options(name)
		if not options:
			RAW["Enum.%s (no values)" % name] += 1
			return None
		return "drop:" + "|".join("%s=%s" % (o[0], o[1]) for o in options)

	if name in HAND_ENTITIES:
		return "ref:" + HAND_ENTITIES[name]
	if (family, name) in model.registry:
		return "ref:" + model.registry[(family, name)]
	if family in ("Reference", "Chrc", "Acc"):
		# A catalog, an analytics kind or a chart-of-accounts entry the port does not own.
		# A stub entity keeps it a reference rather than an opaque GUID.
		STUBS[(family, name)] += 1
		return "ref:%s.%s" % (stub_module(), stub_code(name))

	RAW["%s.%s" % (family, name)] += 1
	return None


def stub_module():
	"""The module a stub entity belongs to, which the project names.

	Moving the stubs to a project-chosen module was half the change: they were still
	REFERENCED as `masterdata.<code>` and recorded under that key in the column map, so a
	second project emitted its stubs into `common` and every reference into them pointed at
	the first project's `masterdata`, which has no such entity. Install said so, once per
	stub. The name and the placement have to come from the same answer.
	"""
	return getattr(contours, "STUB_MODULE", None) or "masterdata"


def stub_code(name):
	return contours.CODES.get(name) or naming.code(name, 40)


def physical_of(field, model, columns):
	"""Where this attribute's data actually sits.

	DBNames gives the base name; which column carries the value depends on the type. A
	reference is `_FldNNNRRef`, a composite one splits into `_FldNNN_TYPE` / `_RTRef` /
	`_RRRef` and the reference half is what a copy wants, and a plain value is the base
	name itself.
	"""
	base = model.fld.get(field.get("guid"))
	if not base:
		return None
	for candidate in (base, base + "RRef", base + "_RRRef"):
		if candidate in columns:
			return candidate
	return None


# A reference lives in its own column: `_FldNNNRRef`, or `_FldNNN_RRRef` when the
# attribute may point at several kinds of thing. The base name holds a VALUE.
REF_STORAGE = ("RRef", "_RRRef")

# Attributes whose column belongs to another object. Reported, not silently dropped.
ORPHANED = {}

# Which side an account is settled on. Active settles on the debit side, passive on the
# credit side, and active-passive on either - which is why a settlement account's balance
# is read EXPANDED (розгорнуте сальдо) rather than netted: a receivable and a payable with
# the same counterparty belong on opposite sides of a balance sheet.
#
# 1C keeps it as 0/1/2 in a numeric column, which is not an enum reference and so not
# something `enum_decoder` can read. The project turns the number into these codes in the
# query it declares for the chart, because that is machinery which already exists and is
# tested, and `WHERE account_kind = 'passive'` is worth the declaration.
ACCOUNT_KIND = "drop:active=Active|passive=Passive|active_passive=Active-passive"


def held_column(table, column):
	"""The physical column's own record, from the schema dump."""
	for held in (table or {}).get("columns", []):
		if held["column"] == column:
			return held
	return None


def physical_spec(held):
	"""A genmodule type for what the column physically is.

	`len` on an `n`-type is bytes, which is why a `Строка(11)` document number reads as
	`nchar(22)`; on `numeric` it is the precision.
	"""
	kind, width, scale = held.get("type"), held.get("len") or 0, held.get("scale") or 0
	if kind in ("nvarchar", "nchar"):
		return "text" if width < 0 else "varchar:%d" % max(width // 2, 1)
	if kind in ("varchar", "char", "sysname"):
		return "text" if width < 0 else "varchar:%d" % max(width, 1)
	if kind in ("text", "ntext"):
		return "text"
	if kind == "numeric":
		return ("int:%d" % (width or 15)) if not scale else ("num:%d,%d" % (width or 15, scale))
	if kind in ("int", "smallint", "bigint", "tinyint"):
		return "int:10"
	if kind == "datetime":
		return "datetime"
	if kind == "bit":
		return "bool"
	return "blob"


def reconcile(spec, source, table):
	"""A reference the physical column cannot be holding.

	`РегистрСведений.Штрихкоды.Штрихкод` reads out of the metadata as a reference to
	`ПланВидовХарактеристик.ТипыШтрихкодов` and is a `Строка(200)`: 1C keeps it in
	`_Fld15870`, nvarchar(400), and a reference would be in `_Fld15870RRef`. Both halves of
	the generator then believed their own source - the spec said `ref:`, so the column was
	declared `uuid` and named `shtrihkod_id`, while the copy was pointed at the string
	column - and the load found out 55 minutes and 44 million rows in, when `to_uuid` was
	handed a str.

	Where the two disagree the COLUMN wins. Of the two it is the one that cannot be a
	misreading: whatever the metadata meant, the value is where the value is. Everything
	this fixes would otherwise be caught by `migrate check`, one failed load at a time.

	The same misreading has a second shape. `СубконтоДт1` is typed
	`Характеристика.ВидыСубконтоХозрасчетные`: its value is a counterparty, a product, a
	cash-flow item - whatever the analytic KIND on that row says - and the metadata reads it
	as a reference to the chart of kinds itself. 1C stores it as a composite, `_FldNNN_TYPE`
	/ `_RTRef` / `_RRRef`, which a value of one reference type never is. Linked to the kinds,
	not one of 884,590 loaded values was a kind: every row that resolved, resolved to a
	placeholder `fill` had stood in for it, and where nothing stood in the install could not
	build the foreign key at all. A single target over composite storage is a raw GUID.
	"""
	if not source or not (spec.startswith("ref:") or spec == "rawref"):
		return spec
	if spec.startswith("ref:") and source.endswith("_RRRef"):
		MISTYPED[("composite", spec)] += 1
		return "rawref"
	if source.endswith(REF_STORAGE):
		return spec
	held = held_column(table, source)
	if not held:
		return spec
	if held.get("type") == "binary" and (held.get("len") or 0) == 16:
		return spec
	MISTYPED[(held.get("type"), spec)] += 1
	return physical_spec(held)


def options_uk(field, spec, model):
	"""The Ukrainian labels of a dropdown's options, when it came from a 1C enum."""
	if not spec.startswith("drop:"):
		return None
	for part in (field["type"] or "").split(","):
		part = part.strip()
		if part.startswith("-> Enum."):
			return dict((o[0], o[2]) for o in model.enum_options(part[len("-> Enum."):]))
	return None


def enum_source(field, model):
	"""An enum attribute's own table, and its values in the order our options are in.

	1C stores an enum value as a reference into `_EnumNNN`, where `_EnumOrder` is the
	value's position in the metadata - the same order `enum_options` reads them in. That
	pairing is what lets the migration turn a GUID back into an option code.
	"""
	for part in (field.get("type") or "").split(","):
		part = part.strip()
		if not part.startswith("-> Enum."):
			continue
		name = part[len("-> Enum."):]
		table, _ = model.physical(name, "Enum")
		options = [o[0] for o in model.enum_options(name)]
		if table and options:
			return {"table": table, "options": options}
	return None


def enum_spec(model, name):
	"""`drop1c:<enum>` -> its dropdown spec, its Ukrainian labels and its source table.

	An authored spec names the 1C enum rather than restating its values, so the options,
	their order and the table the migration decodes them from all come from the same
	place. Restating them by hand is how a code ends up with no value behind it.
	"""
	options = model.enum_options(name)
	if not options:
		return None
	table, _ = model.physical(name, "Enum")
	return {
		"spec": "drop:" + "|".join("%s=%s" % (o[0], o[1]) for o in options),
		"uk": dict((o[0], o[2]) for o in options),
		"source": {"table": table, "options": [o[0] for o in options]} if table else None,
	}


def field_type(raw, model):
	"""The extracted type string -> a genmodule type spec."""
	parts = [p.strip() for p in raw.split(",")] if raw else []
	# `number(15,2)` splits on its own comma; rejoin those
	merged, buffer = [], ""
	for part in parts:
		buffer = (buffer + "," + part) if buffer else part
		if buffer.count("(") == buffer.count(")"):
			merged.append(buffer)
			buffer = ""
	if buffer:
		merged.append(buffer)

	refs = [p for p in merged if p.startswith("->")]
	scalars = [p for p in merged if TYPE_RE.match(p)]

	if refs and not scalars:
		return resolve_reference(refs, model) or "rawref"
	if refs and scalars:
		# 1C's "any of these" - a composite value. Nothing to point at.
		RAW["composite with scalar"] += 1
		return "rawref"

	for part in scalars:
		match = re.match(r"^string\((\d+|\?)\)$", part)
		if match:
			return "text" if match.group(1) == "?" else "varchar:" + match.group(1)
		match = re.match(r"^number\((\d+|\?),(\d+|\?)\)$", part)
		if match:
			precision = match.group(1) if match.group(1) != "?" else "15"
			scale = match.group(2) if match.group(2) != "?" else "0"
			return ("int:" + precision) if scale == "0" else ("num:%s,%s" % (precision, scale))
		if part == "bool":
			return "bool"
		if part.startswith("date("):
			return "date" if part == "date(D)" else "datetime"
	return "text"


# --------------------------------------------------------------------------- entities

def standard_fields(family, columns, table, model):
	"""The columns 1C gives every object of this family, as spec entries."""
	out = []
	width = {c["column"]: c.get("len") for c in (table or {}).get("columns", [])}

	# A chart of accounts is a catalog to 1C as well - code, description, hierarchy - and
	# without these an account reads as its GUID in every posting that names it.
	if family in ("Reference", "Chrc", "Acc"):
		if "_Code" in columns:
			out.append(("code", "varchar:%d" % (width.get("_Code") or 25), "Code"))
		if "_Description" in columns:
			out.append(("name", "varchar:%d" % (width.get("_Description") or 150), "Name"))
		if "_Marked" in columns:
			out.append(("deletion_mark", "bool", "Marked for deletion"))
		if "_Folder" in columns:
			out.append(("is_folder", "bool", "Group"))
		if "_ParentIDRRef" in columns:
			out.append(("parent", "rawref", "Parent group"))
		if "_OwnerIDRRef" in columns or "_OwnerID_RRRef" in columns:
			out.append(("owner", "rawref", "Owner"))
		# A chart of accounts carries two facts no catalog does, and both are
		# structural rather than attributes: which side an account is settled on,
		# and whether it is off-balance. Without them the chart is one nobody can
		# compute a balance from - a trial balance has to know whether a debit
		# total is a balance or a contra.
		if family == "Acc":
			if "_Kind" in columns:
				out.append(("account_kind", ACCOUNT_KIND, "Kind"))
			if "_OffBalance" in columns:
				out.append(("off_balance", "bool", "Off balance"))
			# Not 1C's: the platform's switch for caching an account's totals by its
			# analytics (registers.md 8.5 `analyticTotals.accountFlag`), the job 1C's own
			# subconto totals table does. Copied from nothing, so a reload leaves it at its
			# default; the accounting module sets it on install.
			out.append(("totals_by_analytics", "bool", "Totals by analytics"))

	elif family in ("Document", "DocumentJournal"):
		if "_Number" in columns:
			out.append(("doc_no", "varchar:%d" % (width.get("_Number") or 25), "Number"))
		if "_Date_Time" in columns:
			out.append(("doc_date", "datetime", "Date", "req"))
		if "_Posted" in columns:
			out.append(("posted", "bool", "Posted", "hidden"))
		if "_Marked" in columns:
			out.append(("deletion_mark", "bool", "Marked for deletion"))

	elif family in ("InfoRg", "AccumRg"):
		if "_Period" in columns:
			out.append(("period", "datetime", "Period"))
		if "_RecorderRRef" in columns:
			out.append(("recorder", "rawref", "Recorder document"))
			out.append(("line_no", "int:9", "Line no"))
		if "_RecordKind" in columns:
			out.append(("record_kind", "drop:receipt=Receipt|expense=Expense",
			            "Movement kind"))
		if "_Active" in columns:
			# 1C clears _Active only on a movement whose document is unposted, and none of
			# those is loaded (0 of 13.8M in ПартииТоваровНаСкладах). A journal row the
			# platform writes names no such column, so it takes the default - which has to be
			# true, or every as-of read that drops inactive rows drops the engine's postings.
			out.append(("is_active", {"dbDatatype": "bool", "fieldTypeCd": "checkbox",
			                          "formula": "true"}, "Active"))

	return out


def entity_of(name, family, module, model, taken_codes):
	"""One 1C object -> one spec entity, plus any line entities for its sections."""
	row = model.row(name, family)
	family = family or row.get("family") or "Reference"
	physical, columns = model.physical(name, family)
	table = model.tables.get(physical or "")
	code = model.registry[(family, name)].split(".")[-1]

	extracted = model.fields(name, family)

	header = [f for f in extracted if not f.get("section")]
	sections = collections.OrderedDict()
	for field in extracted:
		if field.get("section"):
			sections.setdefault(field["section"], []).append(field)

	fields = list(standard_fields(family, columns, table, model))
	used = {n for n, _, _ in ((f[0], f[1], f[2]) for f in fields)}
	used |= {code + "_id"}

	uk_fields = dict((f[0], STANDARD_UK[f[0]]) for f in fields if f[0] in STANDARD_UK)
	uk_options = {}
	if "record_kind" in uk_fields:
		uk_options["record_kind"] = dict(RECORD_KIND_UK)
	if "account_kind" in uk_fields:
		uk_options["account_kind"] = dict(ACCOUNT_KIND_UK)

	physical_map = {code + "_id": "_IDRRef"} if family not in ("InfoRg", "AccumRg") else {}
	for name_, candidates in STANDARD_PHYSICAL.items():
		if any(f[0] == name_ for f in fields):
			for candidate in candidates:
				if candidate in columns:
					physical_map[name_] = candidate
					break
	if "line_no" in (f[0] for f in fields) and "_LineNo" in columns:
		physical_map["line_no"] = "_LineNo"
	enum_map = collections.OrderedDict()

	for field in header:
		if naming.is_dead(field["name"]):
			continue
		source = physical_of(field, model, columns)
		spec = field_type(field["type"], model)
		column = column_name(field, used, physical, source, spec)
		spec = reconcile(spec, source, table)
		label = naming.label(field.get("synonym") or field["name"])

		owner = contours.EXTENSIONS.get((module, code, column))
		if owner:
			EXTENSIONS.setdefault(owner, collections.OrderedDict()).setdefault(
				"%s.%s" % (module, code), []).append(
					(column, spec, label,
					 naming.label_uk(field.get("synonym") or field["name"])))
			# The column moves module, not infobase: it is still a column of the host's
			# 1C table, and the copy has to find it there. It is recorded against the
			# owning module under the host's dotted name, which is how dForge itself
			# names an extension, and carries the host's key so the 1:1 row can be
			# written.
			if source:
				held = COLUMNS.setdefault((owner, "%s.%s" % (module, code)), {
					"object": name, "family": family, "table": physical,
					"columns": {code + "_id": "_IDRRef"}, "enums": {},
					"extends": "%s.%s" % (module, code),
				})
				held["columns"][
					column + "_id" if spec.startswith("ref:") else column] = source
			continue

		# An attribute DBNames resolves to a column this table has not got belongs to
		# another object. Measured on this configuration: exactly three, `Суммовой`,
		# `Валютный` and `Количественный` at `_Fld781..783`, which are columns of the
		# OTHER chart of accounts (`Налоговый`) and arrive attached to this one. Emitting
		# them gives three columns nothing can ever fill, which reads as data the port
		# lost rather than data that was never here.
		#
		# The test is deliberately narrow: a name that resolved and points elsewhere. An
		# attribute DBNames cannot resolve AT ALL is still emitted, because that is the
		# port failing to read the metadata, and silently dropping a real column would be
		# the worse of the two mistakes.
		if model.fld.get(field.get("guid")) and not source:
			ORPHANED[(name, field["name"])] = model.fld[field["guid"]]
			continue

		fields.append((column, spec, label))
		translated = naming.label_uk(field.get("synonym") or field["name"])
		if translated:
			uk_fields[column] = translated
		options = options_uk(field, spec, model)
		if options:
			uk_options[column] = options
		if source:
			physical_map[column + "_id" if spec.startswith("ref:") else column] = source
			if spec.startswith("drop:"):
				found = enum_source(field, model)
				if found:
					enum_map[column] = found

	uk_desc = naming.label_uk(row.get("synonym") or name)
	entity = {
		"desc": naming.label(row.get("synonym") or name),
		"source": u"%s (%s)" % (name, physical or "-"),
		"family": family,
		"fields": fields,
		"uk": {"_": uk_desc, "desc": uk_desc, "f": uk_fields, "o": uk_options},
	}
	if any(f[0] == "name" for f in fields):
		entity["toString"] = "{name}"
	elif any(f[0] == "doc_no" for f in fields):
		entity["toString"] = "{doc_no}"
	elif any(f[0] == "code" for f in fields):
		entity["toString"] = "{code}"
	if family in ("InfoRg", "AccumRg"):
		entity["hideInFolder"] = True

	entities = collections.OrderedDict([(code, entity)])
	COLUMNS[(module, code)] = {
		"object": name, "family": family, "table": physical, "columns": physical_map,
		"enums": enum_map,
	}

	# Tabular sections become line entities keyed the way 1C keys a _VT table.
	for section, section_fields in sections.items():
		line_code = naming.unique(u"%s %s" % (name, section), taken_codes, 48)
		line_used = {"line_no", code}
		line_fields = [(code, "ref:" + code, entity["desc"], "req")]
		line_uk = {code: uk_desc, "line_no": STANDARD_UK["line_no"]}
		line_options = {}

		section_guid = section_fields[0].get("sectionGuid")
		# DBNames records a section's table as the suffix alone - `_VT12640` - because
		# the table is that suffix appended to the owner's own table.
		suffix = model.vt.get(section_guid)
		line_table = (physical + suffix) if (physical and suffix) else None
		line_columns = model.table_columns(line_table)
		line_physical = {}
		line_enums = collections.OrderedDict()
		if line_table:
			owner = (physical or "") + "_IDRRef"
			if owner in line_columns:
				line_physical[code + "_id"] = owner
			line_number = model.line_no.get(section_guid)
			if line_number in line_columns:
				line_physical["line_no"] = line_number

		for field in section_fields:
			if naming.is_dead(field["name"]):
				continue
			source = physical_of(field, model, line_columns)
			spec = field_type(field["type"], model)
			column = column_name(field, line_used, line_table, source, spec)
			spec = reconcile(spec, source, model.tables.get(line_table or ""))
			line_fields.append((column, spec,
			                    naming.label(field.get("synonym") or field["name"])))
			translated = naming.label_uk(field.get("synonym") or field["name"])
			if translated:
				line_uk[column] = translated
			options = options_uk(field, spec, model)
			if options:
				line_options[column] = options
			if source:
				line_physical[column + "_id" if spec.startswith("ref:") else column] = source
				if spec.startswith("drop:"):
					found = enum_source(field, model)
					if found:
						line_enums[column] = found
		section_uk = naming.label_uk(section) or naming.label(section)
		line_desc_uk = u"%s - %s" % (uk_desc, section_uk)
		entities[line_code] = {
			"desc": "%s - %s" % (entity["desc"], naming.label(section)),
			"source": u"%s / %s" % (name, section),
			"family": family,
			"lineOf": code,
			"hideInFolder": True,
			"fields": line_fields,
			"uk": {"_": line_desc_uk, "desc": line_desc_uk,
			       "f": line_uk, "o": line_options},
		}
		COLUMNS[(module, line_code)] = {
			"object": u"%s / %s" % (name, section), "family": family,
			"table": line_table, "columns": line_physical, "enums": line_enums,
		}
		set_column = naming.code(section, 30) or "lines"
		entity.setdefault("sets", []).append(
			(set_column, line_code, naming.label(section),
			 code + "_id", code + "_id"))
		uk_fields[set_column] = section_uk

	return entities


def text_widths(model, table):
	"""A stub copies `_Code` and `_Description` as they are, so it must be as wide.

	Guessing costs a load: `_Code` is nchar(9) in one catalog and nchar(50) in another,
	and a column narrower than the one it copies from is a truncation waiting to happen.
	"""
	found = model.tables.get(table or "")
	if not found:
		return {}
	# `sys.columns.max_length` counts bytes, so an `nchar(50)` reports 100.
	return dict((c["column"], c["len"] // 2 if c["type"].startswith("n") else c["len"])
	            for c in found["columns"]
	            if c.get("len") and c["type"] in ("char", "nchar", "varchar", "nvarchar"))


def stubs(model):
	"""Minimal masterdata entities for the vendor catalogs the port only points at."""
	out = collections.OrderedDict()
	for (family, name), hits in sorted(STUBS.items(), key=lambda kv: (-kv[1], kv[0][1])):
		uk_desc = naming.label_uk(name) or naming.label(name)
		code = stub_code(name)
		table, columns = model.physical(name, family)
		# A stub still has to be filled, or every reference into it dangles. Its three
		# columns come from the same standard places any catalog's do.
		COLUMNS[(stub_module(), code)] = {
			"object": name, "family": family, "table": table,
			"columns": dict((ours, theirs) for ours, theirs in (
				(code + "_id", "_IDRRef"), ("code", "_Code"),
				("name", "_Description"), ("deletion_mark", "_Marked"))
				if theirs in columns),
		}
		# A handful of catalogs are keyed by code alone and carry no `_Description`.
		# Declaring a mandatory `name` there would leave a NOT NULL column the
		# migration has nothing to put in.
		named = "_Description" in columns
		wide = text_widths(model, table)
		fields = [("code", "varchar:%d" % wide.get("_Code", 25), "Code")]
		if named:
			fields.append(("name", "varchar:%d" % wide.get("_Description", 200),
			               "Name", "req"))
		fields.append(("deletion_mark", "bool", "Marked for deletion"))
		labels = {"code": STANDARD_UK["code"],
		          "deletion_mark": STANDARD_UK["deletion_mark"]}
		if named:
			labels["name"] = STANDARD_UK["name"]
		# The few attributes a project reads off a catalog it does not own - a report
		# printing a packaging kind's short name - as contours.STUB_FIELDS names them.
		extracted = dict((f["name"], f) for f in model.fields(name, family))
		for ours, attribute, kind, en, uk in getattr(contours, "STUB_FIELDS", {}).get(name, ()):
			# A standard attribute the metadata does not list - the owner - is named by its
			# physical column, `_OwnerIDRRef` or the reference half of a composite owner.
			source = (attribute if attribute.startswith("_") and attribute in columns
			          else physical_of(extracted[attribute], model, columns))
			COLUMNS[(stub_module(), code)]["columns"][ours] = source
			fields.append((ours, kind, en))
			labels[ours] = uk
		out[code] = {
			"desc": naming.label(name),
			"source": u"%s.%s - referenced %d time(s), not ported" % (family, name, hits),
			"toString": "{name}" if named else "{code}",
			"hideInFolder": True,
			"fields": fields,
			"uk": {"_": uk_desc, "desc": uk_desc, "o": {}, "f": labels},
		}
	return out


# --------------------------------------------------------------------------- build

def build():
	"""Every contour -> {module code: {entity code: entity spec}}."""
	model = Model()

	# Pass one: name everything, so a reference can resolve to an entity that has not
	# been generated yet.
	per_module_codes = collections.defaultdict(set)
	assignments = collections.OrderedDict()
	for module, contour in contours.CONTOURS.items():
		listed = []
		for entry in contour["objects"]:
			name, family = entry if isinstance(entry, tuple) else (entry, None)
			family = family or model.row(name).get("family")
			code = contours.CODES.get(name) or naming.unique(
				name, per_module_codes[module], 48)
			per_module_codes[module].add(code)
			model.registry[(family, name)] = "%s.%s" % (module, code)
			listed.append((name, family))
		assignments[module] = listed

	# Pass two: generate.
	generated = collections.OrderedDict()
	for module, listed in assignments.items():
		entities = collections.OrderedDict()
		for name, family in listed:
			entities.update(
				entity_of(name, family, module, model, per_module_codes[module]))
		generated[module] = entities

	# A stub stands in for a vendor catalog the port only POINTS at, so it has to live in
	# a module everything may depend on. Which module that is belongs to the project: this
	# one calls it `masterdata`, and the library knew that name, which meant a second
	# project - one whose shared module is called anything else - died here on a KeyError
	# with nothing to suggest what it was supposed to declare.
	stubbed = stubs(model)
	if stubbed:
		home = stub_module()
		if home not in generated:
			raise SystemExit(
				"autospec: %d reference(s) point at objects no contour lists, so they need "
				"stub entities, and there is nowhere to put them. Name the module every "
				"other one may depend on as STUB_MODULE in the project's contours.py%s"
				% (len(stubbed), "" if home is None else " (%r is not a module here)" % home))
		generated[home].update(stubbed)
	return generated, model


def main():
	generated, _ = build()
	wanted = sys.argv[1] if len(sys.argv) > 1 else None

	total_entities = total_fields = 0
	for module, entities in generated.items():
		fields = sum(len(e["fields"]) for e in entities.values())
		total_entities += len(entities)
		total_fields += fields
		if wanted and module != wanted:
			continue
		print("%-12s %3d entities %5d fields" % (module, len(entities), fields))
		if wanted:
			for code, entity in entities.items():
				print("\n   %s - %s" % (code, entity["desc"]))
				print("   source: %s" % entity["source"])
				for field in entity["fields"]:
					print("      %-42s %-28s %s"
					      % (field[0], field[1][:28], field[2]))

	if not wanted:
		print("-" * 40)
		print("%-12s %3d entities %5d fields" % ("total", total_entities, total_fields))
		if STUBS:
			print("\n%d vendor catalogs referenced but not ported -> masterdata stubs"
			      % len(STUBS))
			for name, hits in sorted(STUBS.items(), key=lambda kv: -kv[1])[:15]:
				print("   %-44s %d" % (name, hits))
		if RAW:
			print("\n%d reference shapes with nothing to point at -> plain uuid"
			      % sum(RAW.values()))
			for shape, hits in sorted(RAW.items(), key=lambda kv: -kv[1])[:15]:
				print("   %-60s %d" % (shape[:60], hits))
		if MISTYPED:
			print("\n%d field(s) the metadata called a reference and the column is not"
			      % sum(MISTYPED.values()))
			for (kind, claimed), hits in sorted(MISTYPED.items(), key=lambda kv: -kv[1]):
				print("   %-30s metadata said %-24s %d" % (kind, claimed[:24], hits))
		if naming.UNKNOWN:
			print("\nwords still missing from terms.py: %s"
			      % ", ".join(sorted(naming.UNKNOWN)[:20]))


if __name__ == "__main__":
	main()
