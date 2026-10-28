#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Emit dForge module packages from a compact field spec.

Hand-writing entity JSON for 190-odd ported objects would be transcription work with a
transcription error rate, so the shape of a dForge module is encoded once here and each
entity is declared as a list of fields. The generated files are the deliverable; edit
the spec and regenerate rather than patching the JSON.

Field spec: (name, type, description[, mods])

    varchar:N   text            int:N       whole number, numeric(N,0)
    text        textarea        num:P,S     numeric(P,S)
    bool        checkbox        money       numeric(18,2), currency
    date        date            datetime    timestamptz
    user        user picker     drop:a=A|b  dropdown
    drop1c:Enum a dropdown whose options are read from that 1C enum
    ref:entity  FK + Reference pair (qualified codes allowed: ref:masterdata.product)
    rawref      an unresolvable 1C reference: the GUID, with no link (see autospec.py)

    mods: "req" mandatory, "ro" not editable

    python tools/genmodule.py            # writes modules/masterdata, fleet and shipping
"""
from __future__ import print_function

import codecs
import collections
import hashlib
import json
import os
import re
import shutil

import paths

ROOT = paths.ROOT
MODULES = paths.MODULES

# 1C's own key is `_IDRRef binary(16)` - a GUID. dForge does not require the snowflake
# `cuid` for module entities (that is only the metadata schema's own rule), and its write
# pipeline already generates `Guid.NewGuid()` for a uuid identity column, so the ported
# entities keep the infobase's keys verbatim. That is what lets the data come across as a
# plain copy: no old-key -> new-key table, and every reference resolves without a lookup.
KEY_TYPE = "uuid"


# --------------------------------------------------------------------------- emitters

def named(spec, prefix):
	"""Does this type spec start with `prefix`? A spec handed through as a dict does not.

	Every place that reads a spec by its keyword has to answer this, and the dict form would
	otherwise crash in each of them with `AttributeError` on `startswith`.
	"""
	return not isinstance(spec, dict) and spec.startswith(prefix)


def parse_type(spec):
	"""Type spec -> the dbDatatype / fieldTypeCd / extras a dForge column needs.

	A dict is passed through verbatim. The vocabulary below covers what 1C's own types map
	onto, and a register needs two columns 1C has no equivalent for - a generated one, and a
	direction stamp that must be a real `int4` rather than this `int:` shorthand's numeric.
	Inventing a keyword per case would grow the vocabulary for one caller each; handing a
	column spec straight through says plainly that nothing here is being interpreted.
	"""
	if isinstance(spec, dict):
		return dict(spec)
	if named(spec, "varchar:"):
		return {"dbDatatype": "varchar", "fieldTypeCd": "text", "maxLen": int(spec.split(":")[1])}
	if spec == "text":
		return {"dbDatatype": "text", "fieldTypeCd": "textarea"}
	if spec == "bool":
		return {"dbDatatype": "bool", "fieldTypeCd": "checkbox", "formula": "false"}
	if spec.startswith("int:"):
		return {"dbDatatype": "numeric(%s,0)" % spec.split(":")[1], "fieldTypeCd": "number"}
	if spec.startswith("num:"):
		precision, scale = spec.split(":")[1].split(",")
		return {"dbDatatype": "numeric(%s,%s)" % (precision, scale),
		        "fieldTypeCd": "number", "precision": int(scale)}
	if spec == "money":
		return {"dbDatatype": "numeric(18,2)", "fieldTypeCd": "currency", "precision": 2}
	if spec == "date":
		return {"dbDatatype": "date", "fieldTypeCd": "date"}
	if spec == "datetime":
		return {"dbDatatype": "timestamptz", "fieldTypeCd": "datetime"}
	if spec == "user":
		return {"dbDatatype": "int8", "fieldTypeCd": "user"}
	if spec == "recorder":
		# Which document wrote this record. 1C calls it the регистратор and gives a
		# subordinate register one; dForge stamps the same thing as a jsonb entity link,
		# which is what lets unposting find its own rows again.
		return {"dbDatatype": "jsonb", "fieldTypeCd": "entitylink"}
	if spec == "blob":
		# 1C's serialization of a value. Nothing here can read it, so it carries no
		# field type and no editor - the bytes are kept and nothing is claimed.
		return {"dbDatatype": "bytea"}
	if spec == "rawref":
		# A 1C reference with nothing on this side to point at - a composite reference, or
		# a target the port does not own. The GUID is kept so the migration does not lose
		# it, but there is no link and no lookup, so it stays off the card.
		#
		# No `fieldTypeCd`: naming one that resolves to the text group while the column
		# stores a uuid makes the platform bind filters and DML against the wrong type,
		# and it says so at install. Letting it resolve the control from `dbDatatype` is
		# the whole of the fix.
		return {"dbDatatype": KEY_TYPE}
	if spec.startswith("drop:"):
		options = []
		for item in spec[len("drop:"):].split("|"):
			value, _, label = item.partition("=")
			options.append({"value": value, "label": label or value})
		width = max(len(o["value"]) for o in options)
		return {"dbDatatype": "varchar", "fieldTypeCd": "dropdown",
		        "maxLen": max(width, 20), "params": {"options": options}}
	raise ValueError("unknown field type %r" % spec)


def target_pk(entity):
	"""products.product -> product_id; carrier -> carrier_id"""
	return entity.split(".")[-1] + "_id"


def emit_fields(fields, start=10, step=10, line_of=None, ref_names=None):
	"""Spec list -> (ordered column dict, FK reference dict).

	`line_of` names the reference back to the owning document on a tabular-section
	entity; that FK is then half of the composite key, as it is in 1C's `_VT` tables.
	"""
	columns, references = {}, {}
	ref_names = ref_names or {}
	order = start
	for item in fields:
		name, spec, description = item[0], item[1], item[2]
		mods = item[3] if len(item) > 3 else ""
		# "calc" is a register resource: the engine owns it, the user never types it.
		# "cache" is a column the platform WRITES - a totals cache's figures - so it is
		# shown and not editable, and unlike "calc" it is not defaulted or made mandatory:
		# a period with no movement of that resource has nothing in it.
		if "cache" in mods:
			flags = "V"
		else:
			flags = "VM" if "calc" in mods else ("VEM" if "req" in mods else "VE")
		if spec == "rawref" or "hidden" in mods:
			flags = flags.replace("V", "")

		if named(spec, "ref:"):
			entity = spec[len("ref:"):]
			fk = name + "_id"
			columns[fk] = {
				"dbDatatype": KEY_TYPE,
				"flags": "EM" if ("req" in mods or "notnull" in mods) else "E",
				"orderNum": order,
				"description": description + " ID",
			}
			# "notnull" is "req" that reaches the DDL as well: the column is mandatory in
			# the metadata and NOT NULL in the table. Kept apart from "req" because adding
			# NOT NULL to a column already full of rows is a migration that can fail, so it
			# is said where it is true rather than applied to every required reference.
			if "notnull" in mods:
				columns[fk]["isNullable"] = False
			if name == line_of:
				columns[fk]["isPk"] = True
				columns[fk]["isNullable"] = False
			columns[fk] = _ordered_column(columns[fk])
			columns[name] = {
				"columnType": "R",
				"fieldTypeCd": "lookup",
				"flags": flags,
				"orderNum": order + 5,
				"description": description,
				"link": {"entity": entity, "thisKey": fk, "otherKey": target_pk(entity)},
			}
			# The constraint's name is `FK_<Column>` unless the spec names it. An entity
			# already installed carries the name its package was written with, and a
			# renamed reference is a DROP and a re-ADD of the constraint - which on a large
			# table is a validating scan for a cosmetic change.
			references[ref_names.get(fk, "FK_%s" % _camel(fk))] = {
				"from": {"field": fk},
				"to": {"entity": entity, "field": target_pk(entity)},
			}
		else:
			column = {"flags": flags, "orderNum": order, "description": description}
			column.update(parse_type(spec))
			if "req" in mods:
				column["isNullable"] = False
			if "calc" in mods:
				column["formula"] = "0"
				column["isNullable"] = False
			columns[name] = _ordered_column(column)
		order += step
	return columns, references


COLUMN_KEY_ORDER = ["columnType", "dbDatatype", "baseDatatypeCd", "fieldTypeCd", "flags",
                    "isPk", "isIdentity", "isNullable", "maxLen", "precision", "formula",
                    "orderNum", "description", "link", "params"]


def _ordered_column(column):
	return dict_in_order(column, COLUMN_KEY_ORDER)


def dict_in_order(source, order):
	out = {}
	for key in order:
		if key in source:
			out[key] = source[key]
	for key in source:
		if key not in out:
			out[key] = source[key]
	return out


def _camel(name):
	return "".join(part.capitalize() for part in name.split("_"))


def plural(code):
	"""View codes are the entity code pluralised - haulage_class -> haulage_classes."""
	if code.endswith(("s", "x", "ch", "sh")):
		return code + "es"
	if code.endswith("y") and not code.endswith(("ay", "ey", "oy", "uy")):
		return code[:-1] + "ies"
	return code + "s"


def placeholder_column(spec):
	"""`is_missing` — this row stands in for a reference that pointed at nothing.

	1C does not enforce referential integrity and dForge does, so a copy always arrives
	carrying references whose target was deleted from the infobase years ago. Nulling
	them would lose what the document actually said, and dropping the foreign key would
	give up the integrity the port is here to gain. The migration inserts the missing row
	instead and raises this flag, so the reference still resolves and the row says what
	it is rather than pretending to be reference data.

	Only an object that can be the far side of a reference gets it: not a tabular
	section, and not a register.
	"""
	if spec.get("lineOf") or spec.get("family") in ("InfoRg", "AccumRg"):
		return {}
	# Nothing is copied into a derived entity - a totals cache is built from the journal
	# by the platform - so there is no row that could be standing in for one the infobase
	# has and the load has not reached yet.
	if spec.get("derived"):
		return {}
	return {"is_missing": {
		"dbDatatype": "bool",
		"fieldTypeCd": "checkbox",
		"flags": "V",
		"formula": "false",
		"orderNum": 9990,
		"description": "Missing from the infobase",
	}}


def key_columns(code, spec):
	"""The entity's primary key, shaped like the 1C table it was ported from.

	A catalog or document is keyed by its `_IDRRef`, so the column is a uuid the platform
	fills with a fresh GUID for records created here and the migration fills with the
	infobase's own. A tabular section is keyed by `(<owner>_IDRRef, _LineNo)`; the owner
	half is the FK emitted from the spec, so only the line number is added here.

	`key` names the columns of an entity that is keyed by its own values and has no
	surrogate at all. A register's `totals` cache is the case: the platform requires its
	PRIMARY KEY to be exactly (dimensions, period), so a minted key would not just be
	redundant - install refuses the cache outright. Nothing is added here; the named
	columns are marked in place by `mark_key`, because a `ref:` field's key is the `_id`
	column beside it rather than the field's own name.
	"""
	if spec.get("key"):
		return {}
	if spec.get("lineOf"):
		return {"line_no": {
			"dbDatatype": "int4",
			"fieldTypeCd": "number",
			"flags": "VM",
			"isPk": True,
			"isNullable": False,
			"orderNum": 12,
			"description": "Line no",
		}}
	return {code + "_id": {
		"dbDatatype": KEY_TYPE,
		"flags": "I",
		"isPk": True,
		"isIdentity": True,
		"isNullable": False,
		"orderNum": 1,
		"description": code.replace("_", " ").capitalize() + " ID",
	}}


def _readable(column):
	"""A value a caption can show: not a GUID, and not a surrogate integer key."""
	if column.get("fieldTypeCd") == "user":
		return True
	return not (column.get("dbDatatype") in ("uuid", "cuid")
	            or (column.get("isPk") and column.get("dbDatatype") in ("int8", "bigint")))


def _first(codes, *patterns):
	for pattern in patterns:
		for found in codes:
			if (found.lower().endswith(pattern[1:]) if pattern.startswith("*")
			        else found.lower() == pattern):
				return found
	return None


def caption(code, fields):
	"""The entity's toString, for one whose spec names none.

	First what the platform would derive itself - a number with its date, a code and a
	name, a name, a code - so the file says what the record will show instead of leaving
	it to a warning on every validate (ToStringTemplate.Generate is the rule copied here).

	Then what the platform cannot derive: a register record, or a settings row, has no
	number, code or name. 1C lists such a record by what it is about and when, so that is
	its caption here too: the first visible reference, or failing one the first readable
	value, with the period or date after it. A raw GUID is never a caption.
	"""
	visible = [(name, column) for name, column in fields.items()
	           if "V" in column.get("flags", "") and _readable(column)]
	scalars = [name for name, column in visible if column.get("columnType") not in ("R", "S", "F")]
	lookups = [name for name, column in visible if column.get("columnType") == "R"]

	number = _first(scalars, "number", code + "_number", code + "_no")
	date = _first(scalars, "date", code + "_date")
	if number:
		return "{%s} {%s}" % (number, date) if date else "{%s}" % number
	name = _first(scalars, "display_name", "name", "full_name", "title", "subject",
	              "*_name", "*_title", "label", "description")
	coded = _first(scalars, "code", code + "_code", code + "_cd")
	if coded and name:
		return u"{%s} — {%s}" % (coded, name)
	if name or coded:
		return "{%s}" % (name or coded)

	when = _first(scalars, "period", "date", "doc_date", "*_date")
	about = (lookups[0] if lookups else
	         next((n for n in scalars if n != when and fields[n].get("fieldTypeCd") != "checkbox"),
	              None))
	parts = [p for p in (about, when) if p]
	return " ".join("{%s}" % p for p in parts) or None


def mark_key(columns, key):
	"""Mark the named columns as the entity's own primary key.

	A name is taken as `<name>_id` when the spec named a reference - the key is the FK,
	not the lookup column beside it - and as written otherwise.
	A name matching neither is an error rather than a column quietly left out of the key,
	which would leave the cache keyed by less than the register demands.
	"""
	for name in key:
		column = name + "_id" if name + "_id" in columns else name
		if column not in columns:
			raise KeyError("key names %r, which this entity has no column for" % name)
		columns[column]["isPk"] = True
		columns[column]["isNullable"] = False
		columns[column] = _ordered_column(columns[column])
	return columns


def build_entity(code, spec):
	entity = {"description": spec["desc"], "dbObject": code}
	if spec.get("toString"):
		entity["toString"] = spec["toString"]
	elif spec.get("lineOf"):
		# A tabular-section row reads as its document and its line. The platform would
		# derive exactly this, and says so on every validate; written down, it is settled.
		entity["toString"] = "{%s} #{line_no}" % spec["lineOf"]
	# No "identity" trait: that one hard-codes a snowflake `cuid`, and these entities
	# carry the infobase's GUID instead. See key_columns().
	# An entity with no traits carries no key rather than an empty list: a platform-
	# maintained cache is audited by nothing, and saying so with `[]` and with silence
	# are the same thing to the installer.
	if spec.get("traits", ["audit"]):
		entity["traits"] = spec.get("traits", ["audit"])
	if spec.get("numberSequence"):
		entity["numberSequence"] = spec["numberSequence"]

	columns, references = emit_fields(spec["fields"], line_of=spec.get("lineOf"),
	                                  ref_names=spec.get("refNames", {}))
	columns.update(key_columns(code, spec))
	columns.update(placeholder_column(spec))
	if spec.get("key"):
		mark_key(columns, spec["key"])

	order = 10 * (len(spec["fields"]) + 2)
	for name, child, label, thiskey, otherkey in spec.get("sets", []):
		columns[name] = {
			"columnType": "S",
			"fieldTypeCd": "grid",
			"flags": "VE",
			"orderNum": order,
			"description": label,
			"link": {"entity": child, "thisKey": thiskey, "otherKey": otherkey},
		}
		order += 10

	for name, column in spec.get("registry", {}).items():
		column = dict(column)
		column["orderNum"] = 900
		columns[name] = _ordered_column(column)

	# Written in column order rather than the order the spec happened to build them in,
	# so a generated file reads like the card it produces.
	entity["fields"] = collections.OrderedDict(
		sorted(columns.items(), key=lambda kv: kv[1].get("orderNum", 0)))
	if not entity.get("toString"):
		found = caption(code, entity["fields"])
		if found:
			entity["toString"] = found
	if spec.get("constraints"):
		entity["constraints"] = spec["constraints"]
	if spec.get("indexes"):
		entity["indexes"] = spec["indexes"]
	if references:
		entity["references"] = references
	return entity


def build_extension(module, target, fields, registry=None, description=None):
	"""Columns this module adds to another module's entity.

	The column lives here rather than on the entity itself because the reference points
	back at this module: the owning module already depends on us, so declaring it there
	would make the two depend on each other and neither could install first.

	`registry` adds posting columns, as an entity's own do: a bridge that posts the other
	module's document to a register (the state kept in this module's extension table).
	"""
	columns, references = emit_fields(fields, start=60)
	for name, column in (registry or {}).items():
		column = dict(column)
		column["orderNum"] = 900
		columns[name] = _ordered_column(column)
	other = target.split(".")[0]
	return dict_in_order({
		"extends": target,
		"dbObject": target.split(".")[-1],
		"description": description or (
			"%s extension for %s - added here, not in %s, because the reference points "
			"back at %s." % (module.capitalize(), target, other, module)),
		"fields": columns,
		"references": references,
	}, ["extends", "dbObject", "description", "fields", "references"])


# The columns 1C gives every object of its family. They identify the record, so they
# lead the card; everything the integrator added follows behind them.
IDENTITY = ["code", "name", "deletion_mark", "is_folder", "parent", "owner",
            "doc_no", "doc_date", "posted", "period", "recorder", "line_no",
            "record_kind", "is_active", "is_missing"]

CARD_GROUPS_UK = {"main": u"\u0417\u0430\u0433\u0430\u043b\u044c\u043d\u0435",
                  "details": u"\u0420\u0435\u043a\u0432\u0456\u0437\u0438\u0442\u0438"}


def card_fields(entity_spec):
	"""The columns a card shows, split into the identifying ones and the rest.

	A hidden column is hidden on the card too: a raw GUID with nothing to point at has
	nothing to show. A set is not here either - it becomes a tab of its own.
	"""
	head, rest = [], []
	for item in entity_spec["fields"]:
		mods = item[3] if len(item) > 3 else ""
		if item[1] == "rawref" or "hidden" in mods:
			continue
		(head if item[0] in IDENTITY else rest).append(item[0])
	if placeholder_column(entity_spec):
		head.append("is_missing")
	return head, rest


def build_card_layout(code, entity_spec):
	"""One record's form: what identifies it up top, the rest behind tabs.

	`Номенклатура` carries 81 attributes and eleven tabular sections, so the card that
	just lists its columns in order is unreadable. 1C solves this with a tabbed form, and
	so does this: the identifying columns stay visible, and everything else - the
	remaining attributes, then one tab per tabular section - goes behind a tab bar.
	"""
	if entity_spec.get("lineOf"):
		return None
	head, rest = card_fields(entity_spec)
	sets = [item[0] for item in entity_spec.get("sets", [])]
	if not head and not rest and not sets:
		return None

	sections = [{"type": "columnGroup", "code": "main", "label": "General",
	             "cols": 2, "columns": head}]
	tabs = []
	if rest:
		sections.append({"type": "columnGroup", "code": "details",
		                 "label": "Attributes", "cols": 2, "columns": rest})
		if sets:
			tabs.append({"type": "section", "code": "details"})
	for name in sets:
		tabs.append({"type": "set", "code": name})
	if tabs:
		sections.append({"type": "tabGroup", "code": "tabs", "tabs": tabs})

	return {"entity": code, "isDefault": True, "layout": {"sections": sections}}


def build_translations(spec):
	"""The `uk` section of a spec -> a dForge translations/uk-UA.json.

	Hidden FK labels are derived from their Reference sibling ("Перевізник" -> that plus
	" ID"), so only the visible column needs translating by hand. Key columns are derived
	the same way: an entity's own key reads "<entity> ID" and a tabular section's line
	number is always the same word, so neither is worth a spec entry.
	"""
	uk = spec["uk"]
	entities = {}
	for code, entity_uk in uk.get("entities", {}).items():
		entity_spec = spec["entities"][code]
		field_specs = {f[0]: f[1] for f in entity_spec["fields"]}
		fields = {}
		if entity_spec.get("lineOf"):
			fields["line_no"] = {"label": "№ рядка"}
		elif entity_spec.get("key"):
			# Keyed by its own values: there is no surrogate column to label, and naming
			# one makes `validate` report a translation for a field that does not exist.
			pass
		else:
			fields[code + "_id"] = {"label": entity_uk["_"] + " ID"}
			if placeholder_column(entity_spec):
				fields["is_missing"] = {"label": u"Відсутній в інфобазі"}
		for name, label in entity_uk.get("f", {}).items():
			fields[name] = {"label": label}
			if named(field_specs.get(name, ""), "ref:"):
				fields[name + "_id"] = {"label": label + " ID"}
		for name, options in entity_uk.get("o", {}).items():
			fields.setdefault(name, {})["options"] = options
		entry = {"label": entity_uk["_"], "desc": entity_uk.get("desc", entity_uk["_"])}
		if fields:
			entry["fields"] = fields
		# A card's section heading is localized through its column group, under the
		# entity that owns it.
		layout = build_card_layout(code, entity_spec)
		if layout:
			groups = dict(
				(section["code"], {"label": CARD_GROUPS_UK[section["code"]]})
				for section in layout["layout"]["sections"]
				if section["type"] == "columnGroup")
			if groups:
				entry["columnGroups"] = groups
		entities[code] = entry

	# An extension's columns belong to the other module's entity, so they are translated
	# under its dotted code rather than under an entity of our own.
	for target, extension_fields in spec.get("extends", {}).items():
		translated = dict((column, {"label": label}) for column, label
		                  in ((spec.get("extendUk") or {}).get(target) or {}).items())
		for item in extension_fields:
			column, kind, label = item[0], item[1], item[2]
			ukrainian = item[3] if len(item) > 3 else None
			if not ukrainian:
				continue
			translated[column] = {"label": ukrainian}
			if named(kind, "ref:"):
				translated[column + "_id"] = {"label": ukrainian + " ID"}
		if translated:
			entities[target] = {"fields": translated}

	doc = {"entities": entities}
	if uk.get("folder"):
		doc["folders"] = {spec["code"]: {"label": uk["folder"]}}
	if uk.get("views"):
		doc["views"] = {code: {"label": label} for code, label in uk["views"].items()}
	if uk.get("menu"):
		menu = dict(uk["menu"])
		doc["menus"] = {
			"%s_menu" % spec["code"].replace("-", "_"): {
				"label": menu.pop("_"),
				"items": {code: {"label": label} for code, label in menu.items()},
			}
		}
	if uk.get("roles"):
		doc["roles"] = {code: {"label": label} for code, label in uk["roles"].items()}
	if uk.get("settings"):
		doc["settings"] = {code: {"label": label} for code, label in uk["settings"].items()}
	return doc


def write_json(path, doc):
	directory = os.path.dirname(path)
	if not os.path.isdir(directory):
		os.makedirs(directory)
	with codecs.open(path, "w", "utf-8") as f:
		f.write(json.dumps(doc, ensure_ascii=False, indent="\t"))
		f.write("\n")


# Everything under a module directory is written from the spec, so a rename in the spec
# has to take the old file with it. Without this a renamed entity lingers as a stale
# JSON file that still validates and would still install.
OWNED = ["manifest.json", "settings.json", "registers.json",
         os.path.join("entities"), os.path.join("ui"), os.path.join("deps"),
         os.path.join("security"), os.path.join("translations"),
         # Never written from the spec, only copied from the project's `authored/` tree -
         # but owned all the same, so an action dropped there is dropped here too.
         os.path.join("logic"), os.path.join("migrations"), os.path.join("print_templates")]


def clean_module(base):
	for relative in OWNED:
		path = os.path.join(base, relative)
		if os.path.isdir(path):
			shutil.rmtree(path)
		elif os.path.isfile(path):
			os.remove(path)


def menu_view_codes(items):
	"""Every data view a menu opens, however deep its groups nest."""
	for item in items.values():
		if item.get("dataViewCode"):
			yield item["dataViewCode"]
		for code in menu_view_codes(item.get("children") or {}):
			yield code


def data_source(code, entity):
	"""A view's source over one entity, with the columns named when none would show.

	A grid draws an entity's visible scalar columns, and an entity whose every column is
	hidden - a register carrying only composite 1C references, which stay raw GUIDs - draws
	the platform's empty state instead. Naming the columns is what the platform reads as the
	author asking for them, visible or not, so such a view lists them rather than lying
	empty.
	"""
	source = {"entityCode": code, "level": 0}
	fields = entity["fields"]
	scalar = [name for name, column in fields.items() if column.get("columnType") != "S"]
	if not any("V" in fields[name].get("flags", "") for name in scalar):
		shown = [name for name in scalar if not fields[name].get("isPk")]
		source["columns"] = shown or scalar
	return source


def readable_lookups(roles, built, module):
	"""Each role, plus `S` on whatever a lookup it may fill in points at.

	A lookup the user cannot read the target of is hidden from the form, and a required
	one then makes the record unsaveable - for a role that was granted the right to write
	it. Which entities a lookup reaches is a fact of the entity files, not a decision, so
	it is not left to each role to repeat: a right the role already names is kept as it is.

	**A target in THIS module is named bare, whatever the link calls it.** The generator
	writes some same-module links qualified (`production.act_rework`) and some bare, and a
	qualified name does not match the bare key the role already grants - so the read grant
	was added anyway, as a SECOND key for the same entity. The installer resolves both and
	the read-only one wins: 18 of the port's own documents across 7 modules had `U` taken
	off the role that owns them, which is a posting that cannot post and a card that cannot
	be saved. Normalising the name is the whole fix; the rule that a right already named is
	kept then does the rest.
	"""
	out = collections.OrderedDict()
	prefix = module + "."
	for code, role in roles.items():
		rights = collections.OrderedDict(role.get("rights", {}))
		reached = set()
		for entity, granted in role.get("rights", {}).items():
			if not set(granted) & set("IU") or entity not in built:
				continue
			for column in built[entity]["fields"].values():
				if column.get("columnType") == "R" and column.get("link"):
					target = column["link"]["entity"]
					if target.startswith(prefix) and target[len(prefix):] in built:
						target = target[len(prefix):]
					reached.add(target)
		for target in sorted(reached - set(rights)):
			rights[target] = "S"
		out[code] = dict(role, rights=rights)
	return out


# A right on another module's entity is qualified by that module; these keys are not
# entities at all, and their own dots name no provider.
NON_ENTITY_RIGHTS = ("action:", "sp:", "report:")


def dependency_contracts(spec, built, dependencies):
	"""deps/<provider>.json for every manifest dependency: what this module consumes.

	The platform refuses a dependency without one, and checks each against what it can
	read off the package - reference links, FK blocks, `extends`, role grants and view
	sources. So the contract is read off the very same places, from the entities as they
	are written, rather than from the spec's shorthand: a contract derived from anything
	else is a second opinion that can disagree with the files it describes.

	Every cross-module touch lands on the provider's key (`ref:` points at `<entity>_id`),
	so a contract names entities and their keys and no other columns. A touch that lands
	elsewhere raises, because its storage class would have to be looked up in the provider
	and nothing here does that yet.
	"""
	own = spec["code"]
	used = collections.defaultdict(lambda: collections.defaultdict(set))

	def note(qualified, token, column=None):
		module, _, entity = (qualified or "").partition(".")
		if not entity or module == own:
			return
		used[module][entity].add(token)
		if column and column != target_pk(qualified):
			raise ValueError("%s: %s reads %s.%s, which is not its key - deps/%s.json would "
			                 "have to type that column" % (own, token, qualified, column, module))

	for key, entity in built.items():
		if entity.get("extends"):
			note(entity["extends"], "extends:" + entity["extends"])
		for name, column in entity.get("fields", {}).items():
			link = column.get("link")
			if link:
				note(link["entity"], "ref:%s.%s" % (key, name), link["otherKey"])
		for reference in (entity.get("references") or {}).values():
			note(reference["to"]["entity"], "ref:%s.%s" % (key, reference["from"]["field"]),
			     reference["to"]["field"])

	for role, body in spec["roles"].items():
		for right in body.get("rights", {}):
			if not right.startswith(NON_ENTITY_RIGHTS):
				note(right, "role:" + role)

	# A register is declared over an entity, and the declaration is a row in the platform's
	# register table pointing at `metadata.entity`. That is what the `metadata` floor in
	# the manifest buys, so it is what that dependency's contract names.
	# A turnover register keeps its movements in a journal rather than a state entity.
	for register in (spec.get("registerDefs") or {}).values():
		used["metadata"]["entity"].add("ref:%s" % (register.get("entity") or register["journal"]))

	# What the project says a module uses that nothing in the package shows - a posting
	# column bound to another module's register writes that module's journal, and neither
	# the binding nor its register is a reference link a contract can be read off.
	for qualified, token in DECLARED_USES.get(own, ()):
		note(qualified, token)

	# A system module required for what the platform does at install - running a
	# migration - is a version gate, not a consumption: its contract names no entity.
	gates = set(DECLARED_MODULE.get(own, {}).get("requires", {}))
	for gate in gates:
		used.setdefault(gate, collections.defaultdict(set))

	unused = sorted(set(dependencies) - set(used))
	if unused:
		raise ValueError("%s depends on %s but uses nothing of it that a contract can "
		                 "name - drop the dependency or say what it is for"
		                 % (own, ", ".join(unused)))
	undeclared = sorted(set(used) - set(dependencies))
	if undeclared:
		raise ValueError("%s uses %s without depending on it"
		                 % (own, ", ".join("%s (%s)" % (m, ", ".join(sorted(used[m])))
		                                   for m in undeclared)))
	return dict(
		(module, {
			"module": module,
			"version": dependencies[module],
			"entities": collections.OrderedDict(
				(entity, {"pk": entity + "_id", "use": sorted(tokens)})
				for entity, tokens in sorted(used[module].items())),
		})
		for module in sorted(used))


# What each register shape first became understood in. A module asks for the highest floor
# its own declarations reach, because asking for less than a declaration needs is a manifest
# that lies: it installs against a tenant that would refuse the register, and the refusal
# arrives as a register error rather than as the version mismatch it is.
#
# There is one floor now, and the reason is worth keeping. These were seven versions -
# 1.13.0 through 1.20.0, one per shape as each landed - and the platform branch **squashed
# them into 1.13.x**, one minor per branch. So a module generated against the old table asked
# for `metadata >= 1.17.0` and was refused by a tenant carrying every one of those features
# under 1.13.2.
#
# It moved once more, and not because a shape changed: merging main back into the register
# branch pushed the register migration from 1.13.0 to 1.14.0, so the whole set is understood
# at 1.14.0 and a manifest asking for 1.13.0 now understates what it needs. Read the floor
# from the platform's own `system-modules/metadata/manifest.json` when in doubt - it is the
# only place that cannot drift.
#
# The list stays a list: the next feature to land gets a row, and the mechanism below then
# does something again. Reading it as dead weight and deleting it is how the lesson gets
# lost.
REGISTER_FLOOR = [
	("1.14.0", lambda d: True),
	# `recordChangesOnly` / `absentAs`, on the dForge-core branch 261006-binding-literal-types.
	("1.17.1", lambda d: bool(d.get("recordChangesOnly"))),
]


def metadata_floor(register_defs):
	"""The lowest platform metadata version that understands every register declared."""
	floor = "1.14.0"
	for definition in register_defs.values():
		for version, applies in REGISTER_FLOOR:
			if applies(definition) and _version(version) > _version(floor):
				floor = version
	return floor


def _version(text):
	return tuple(int(part) for part in text.split("."))


def emit_module(spec):
	base = os.path.join(MODULES, spec["code"])
	clean_module(base)
	entities = spec["entities"]

	# The metadata floor rides in the dependency map beside the module ones — the
	# manifest has no separate "requires" key and the schema rejects one. Which floor
	# depends on what the registers are, not merely that there are some.
	dependencies = dict(
		spec.get("dependencies", {}),
		**({"metadata": ">=" + metadata_floor(spec["registerDefs"])}
		   if spec.get("registerDefs") else {}))

	write_json(os.path.join(base, "manifest.json"), {
		"packageFormat": 1,
		"moduleId": spec["moduleId"],
		"code": spec["code"],
		# A module whose schema has already changed once carries the version that says
		# so. Hard-coding 0.1.0 here quietly reverted a bump made in the package, and a
		# reverted version is how an upgrade stops being applied.
		"version": spec.get("version", "0.1.0"),
		"dbSchemaVersion": spec.get("version", "0.1.0"),
		"displayName": spec["displayName"],
		"description": spec["description"],
		"auditHistory": spec.get("auditHistory", "basic"),
		"author": {"name": "SweetSoft"},
		"license": "proprietary",
		"category": "operations",
		"tags": spec["tags"],
		"icon": spec["icon"],
		"dependencies": dependencies,
		# An extension is listed under its dotted target code, so the installer knows it
		# adds to another module's entity rather than declaring one of its own.
		"entities": dict(
			[(code, "./entities/%s.json" % code) for code in entities]
			+ [(target, "./entities/%s.json" % target)
			   for target in spec.get("extends", {})]),
	})

	# Written before the entities read as a matter of form only \u2014 the installer resolves
	# the declaration itself \u2014 but a register names the entity holding its state, so the
	# file that owns the invariants belongs beside the module root, not under ui/.
	if spec.get("registerDefs"):
		write_json(os.path.join(base, "registers.json"), spec["registerDefs"])

	built = collections.OrderedDict(
		(code, build_entity(code, entity_spec)) for code, entity_spec in entities.items())
	for code, entity in built.items():
		write_json(os.path.join(base, "entities", code + ".json"), entity)

	for target, fields in spec.get("extends", {}).items():
		built[target] = build_extension(spec["code"], target, fields,
		                                (spec.get("extendRegistry") or {}).get(target),
		                                (spec.get("extendDescription") or {}).get(target))
		write_json(os.path.join(base, "entities", target + ".json"), built[target])

	# `hideInFolder` keeps an entity off the folder's own list, but a menu item opens its
	# view INSIDE the folder, and the platform refuses an entity the folder does not grant
	# ("Entity 'X' is not accessible in folder 'Y'") - only when someone clicks it. So
	# whatever the menu reaches is granted, hidden or not.
	in_menu = set(menu_view_codes(spec["menu"]))
	write_json(os.path.join(base, "ui", "folders.json"), {
		"label": spec["label"],
		"description": spec["description"],
		"color": spec["color"],
		"entities": {code: ({"quickAdd": True} if entities[code].get("quickAdd") else {})
		             for code in entities
		             if not entities[code].get("hideInFolder") or plural(code) in in_menu},
	})

	layouts = collections.OrderedDict()
	for code, entity_spec in entities.items():
		found = build_card_layout(code, entity_spec)
		if found:
			layouts[code + "_card"] = found
	if layouts:
		write_json(os.path.join(base, "ui", "card_layouts.json"), layouts)

	write_json(os.path.join(base, "ui", "data_views.json"), {
		plural(code): {
			"label": entities[code]["desc"],
			"dataSources": [data_source(code, built[code])],
		}
		for code in entities
	})

	write_json(os.path.join(base, "ui", "menus.json"), {
		"%s_menu" % spec["code"].replace("-", "_"): {
			"label": spec["label"],
			"folders": [spec["code"]],
			"items": spec["menu"],
		}
	})

	roles = readable_lookups(spec["roles"], built, spec["code"])
	write_json(os.path.join(base, "security", "roles.json"), roles)

	for provider, contract in dependency_contracts(dict(spec, roles=roles), built,
	                                               dependencies).items():
		write_json(os.path.join(base, "deps", provider + ".json"), contract)

	if spec.get("uk"):
		write_json(os.path.join(base, "translations", "uk-UA.json"),
		           build_translations(spec))

	if spec.get("settings"):
		write_json(os.path.join(base, "settings.json"), spec["settings"])

	copied = apply_authored(base, spec["code"])

	print("%-10s %2d entities -> %s%s" % (spec["code"], len(entities), base,
	                                      " (+%d authored)" % copied if copied else ""))


def _merge(into, extra):
	"""`extra` laid over `into`, nested dictionaries merged and every other value replaced."""
	for key, value in extra.items():
		if isinstance(value, dict) and isinstance(into.get(key), dict):
			_merge(into[key], value)
		else:
			into[key] = value
	return into


def apply_authored(base, module):
	"""Copy the project's `authored/<module>/` files into the module just emitted.

	What the generator cannot derive - an action and its DSL - is written once in the
	project and laid over every regeneration, so `genmodule` never drops it. A translations
	or roles file is merged into the generated one, and so is a dependency contract - the
	library functions an action imports from that dependency (`"functions"`), beside the
	entities the generator found it uses; any other file the generator already wrote is
	refused, since replacing it would quietly discard what was derived. Returns how many
	files were laid over.
	"""
	source = binding.authored(module)
	if not source:
		return 0
	count = 0
	for directory, _, names in os.walk(source):
		for name in sorted(names):
			if name.endswith((".pyc", ".pyo")):
				continue
			path = os.path.join(directory, name)
			relative = os.path.relpath(path, source)
			target = os.path.join(base, relative)
			# Translations, roles and contracts are merged into the generated file: an action's
			# label, its Execute right and its imports live beside what was derived.
			contract = os.path.dirname(relative) == "deps" and name.endswith(".json")
			if contract and not os.path.isfile(target):
				raise ValueError("authored/%s/%s: %s is not a dependency of %s"
				                 % (module, relative.replace(os.sep, "/"), name[:-5], module))
			# An entity file adds what the 1C metadata cannot give - formula columns - to the
			# entity the generator derived; it never stands for an entity of its own.
			entity = os.path.dirname(relative) == "entities" and name.endswith(".json")
			if entity and not os.path.isfile(target):
				raise ValueError("authored/%s/%s: the generator wrote no entity %s"
				                 % (module, relative.replace(os.sep, "/"), name[:-5]))
			if (os.path.dirname(relative) == "translations" and name.endswith(".json") or contract or entity
			        or relative.replace(os.sep, "/") == "security/roles.json"):
				with codecs.open(path, "r", "utf-8") as f:
					extra = json.load(f)
				generated = {}
				if os.path.isfile(target):
					with codecs.open(target, "r", "utf-8") as f:
						generated = json.load(f)
				write_json(target, _merge(generated, extra))
			else:
				if os.path.exists(target):
					raise ValueError("authored/%s/%s would replace a file the generator wrote"
					                 % (module, relative.replace(os.sep, "/")))
				if not os.path.isdir(os.path.dirname(target)):
					os.makedirs(os.path.dirname(target))
				shutil.copyfile(path, target)
			count += 1
	return count


# ------------------------------------------------------------------ generated modules

MODULE_UUID = "b1000000-0000-0000-0000-0000000000%02d"


def module_uuid(code, index):
	"""A stable id for a generated module.

	The counter numbers modules by their position in the contour map, which is fine while
	there is one map and wrong the moment there are two: a second project's twelfth module
	drew the first project's twelfth id, and install refused it - "moduleId is already used
	by a different installed module 'catering'" - after creating 359 tables. Two projects
	meant for the SAME tenant cannot number themselves independently.

	The first project keeps the counter, because its modules are installed in live tenants
	and a module that changes its id is a DIFFERENT module to the platform: the old one
	would be orphaned and the new one installed beside it. Every other project derives its
	ids from the module code instead, which collides with nothing and needs no registry.
	"""
	if os.path.basename(paths.PROJECT) == "project":
		return MODULE_UUID % (10 + index)
	digest = hashlib.sha1(code.encode("utf-8")).hexdigest()
	return "b2000000-0000-0000-0000-%s" % digest[:12]

FAMILY_GROUPS = [
	("documents", "Documents", "file-text", 10, ("Document", "DocumentJournal")),
	("catalogs", "Catalogs", "database", 20, ("Reference", "Chrc", "Acc")),
	("registers", "Registers", "table", 30, ("InfoRg", "AccumRg")),
]


def dependencies_of(entities):
	"""Which other modules this one's references reach into - and whose registers its
	posting columns bind to, since a binding names `module.register` and the register has
	to be installed before the column that posts to it."""
	found = set()
	for entity in entities.values():
		for field in entity["fields"]:
			spec = field[1]
			if named(spec, "ref:") and "." in spec:
				found.add(spec[len("ref:"):].split(".")[0])
		for column in (entity.get("registry") or {}).values():
			register = (column.get("params") or {}).get("register") or ""
			if "." in register:
				found.add(register.split(".")[0])
	return found


def authored_reports(module):
	"""The reports a module's authored `ui/reports.json` declares, in file order: [(code, label)].

	The generator writes the menu, and a report nobody can reach from it is a report nobody
	opens, so the reports the project authors for a generated module get a section of their own
	(`auto_menu`). Their labels are the report's own; the Ukrainian ones come with the authored
	translations, merged like any other."""
	source = binding.authored(module)
	path = source and os.path.join(source, "ui", "reports.json")
	if not path or not os.path.isfile(path):
		return []
	with codecs.open(path, "r", "utf-8") as f:
		reports = json.load(f, object_pairs_hook=collections.OrderedDict)
	return [(code, report.get("label") or code) for code, report in reports.items()]


def auto_menu(entities, module=None):
	"""Menu sections by 1C family, and the module's authored reports. Line entities are
	reached through their parent."""
	menu = {}
	reports = authored_reports(module) if module else []
	if reports:
		menu["reports"] = {"orderNum": 5, "label": "Reports", "icon": "file-earmark-spreadsheet",
		                   "children": dict((code, {"itemType": "R", "reportCode": code,
		                                            "orderNum": 6 + n, "label": label})
		                                    for n, (code, label) in enumerate(reports))}
	for group, label, icon, order, families in FAMILY_GROUPS:
		children = {}
		item_order = order + 1
		for code, entity in entities.items():
			if entity.get("lineOf") or entity.get("family") not in families:
				continue
			children[code] = {"itemType": "V", "dataViewCode": plural(code),
			                  "orderNum": item_order, "label": entity["desc"]}
			item_order += 1
		if children:
			menu[group] = {"orderNum": order, "label": label, "icon": icon,
			               "children": children}
	return menu


def auto_roles(module, entities):
	visible = [c for c, e in entities.items() if not e.get("lineOf")]
	lines = [c for c, e in entities.items() if e.get("lineOf")]
	everything = visible + lines
	return {
		"%s.admin" % module: {
			"description": "%s administrator" % module,
			"rights": dict((code, "SIUDC") for code in everything),
		},
		"%s.user" % module: {
			"description": "Works with %s data" % module,
			"rights": dict((code, "SIU") for code in everything),
		},
		"%s.viewer" % module: {
			"description": "Read-only access to %s data" % module,
			"rights": dict((code, "S") for code in everything),
		},
	}


MENU_GROUP_UK = {"documents": "Документи", "catalogs": "Довідники",
                 "registers": "Регістри", "reports": "Звіти"}

ROLE_SUFFIX_UK = {"admin": "Адміністратор", "user": "Ведення", "viewer": "Перегляд"}


def auto_uk(module, entities, contour, built_menu):
	"""The module's `uk` section, from the Ukrainian each entity carries.

	Everything below the entity - field labels, dropdown options - was translated in
	`autospec`, from the same 1C synonym the English label came from. What is added here
	is the furniture around it: the folder, the views, the menu and the roles.
	"""
	translated = collections.OrderedDict(
		(code, entity["uk"]) for code, entity in entities.items() if entity.get("uk"))
	if not translated:
		return None

	label = contour.get("uk_label", contour["label"])

	# Label only what the MENU actually holds, groups included. Two ways a label for a
	# non-existent item used to get written: a group `auto_menu` left out because no entity
	# of this module belongs to it - `catalogs` in five modules, `registers` in one - and,
	# since the register overlay could introduce an entity, one with no 1C FAMILY, which is
	# what `auto_menu` groups by. The installer reports each as "no code mapping found".
	menu = {"_": label}
	in_menu = set()
	for group, section in (built_menu or {}).items():
		menu[group] = MENU_GROUP_UK.get(group, group)
		in_menu |= set((section.get("children") or {}).keys())
	for code, entity in entities.items():
		if code in in_menu and entity.get("uk"):
			menu[code] = entity["uk"]["_"]
	# an authored report's menu item reads as the report does in the authored translation
	source = binding.authored(module)
	path = source and os.path.join(source, "translations", "uk-UA.json")
	if path and os.path.isfile(path):
		with codecs.open(path, "r", "utf-8") as f:
			reports = json.load(f).get("reports") or {}
		for code, report in reports.items():
			if code in in_menu and report.get("label"):
				menu[code] = report["label"]

	return {
		"folder": label,
		"menu": menu,
		"views": dict((plural(code), entity["uk"]["_"])
		              for code, entity in entities.items() if entity.get("uk")),
		"roles": dict(("%s.%s" % (module, key), "%s - %s" % (suffix, label))
		              for key, suffix in ROLE_SUFFIX_UK.items()),
		"entities": translated,
	}


def apply_registers(module, entities, overlay):
	"""Fold a project's register overlay into a generated module's entities.

	A generated entity is a dict the same shape an authored one has, so a register over
	one is the same three things it is anywhere: the columns the register needs on its
	own table, the declaration, and the `A` column each writing document binds from. The
	only thing this does that an authored spec does not is find the entity by code and
	fail loudly when the code is wrong - a silent miss here would install a register with
	nothing writing to it.
	"""
	if not overlay:
		return None

	# An entity the register needs and the infobase does not have. A dForge balance register
	# keeps its running total in a STATE entity, and 1C keeps no such table - it holds the
	# movements and computes the balance from them on every read. So the state has no 1C
	# original to generate from, and until this the overlay could add columns, bindings and
	# constraints to a generated entity but never an entity of its own.
	#
	# It is applied FIRST so the sections below can target what it introduced, and it refuses
	# a code that already exists: silently shadowing an entity the generator derived from the
	# infobase would replace a copied table with a hand-written one and nothing would say so.
	#
	# The spec is the same shape autospec builds, because everything downstream reads that
	# shape - `fields` as a list of tuples, `uk` with its `_`/`desc`/`f`/`o`. The surrogate
	# primary key is added for it like any other entity, which is what the platform's
	# "one column it mints" rule wants.
	for code, spec in (overlay.get("entities") or {}).items():
		if code in entities:
			raise KeyError("registers.py: %s already has an entity %r - an overlay entity "
			               "may not shadow one the generator derived from the infobase"
			               % (module, code))
		entities[code] = dict(spec)

	# A column the generator typed from the infobase and the register needs typed as what
	# it MEANS. The one case so far is a date dimension the 1C author declared as a string:
	# the physical column is nvarchar, so the generator read nvarchar, and a text date
	# neither sorts nor compares nor matches what a posting would write into it.
	for code, columns in (overlay.get("retype") or {}).items():
		if code not in entities:
			raise KeyError("registers.py: %s has no entity %r to retype a column on"
			               % (module, code))
		fields = list(entities[code]["fields"])
		for name, spec in sorted(columns.items()):
			for i, item in enumerate(fields):
				if item[0] == name:
					fields[i] = (item[0], spec) + tuple(item[2:])
					break
			else:
				raise KeyError("registers.py: %s.%s has no column %r to retype"
				               % (module, code, name))
		entities[code]["fields"] = fields

	for code, fields in (overlay.get("fields") or {}).items():
		if code not in entities:
			raise KeyError("registers.py: %s has no entity %r to add register columns to"
			               % (module, code))
		entities[code]["fields"] = list(entities[code]["fields"]) + list(fields)

	for code, columns in (overlay.get("bind") or {}).items():
		if code not in entities:
			raise KeyError("registers.py: %s has no entity %r to bind a register from"
			               % (module, code))
		registry = dict(entities[code].get("registry") or {})
		registry.update(columns)
		entities[code]["registry"] = registry

	# A rule the 1C handler enforced by refusing to post. The platform has no precondition
	# on an `A` column, so the invariant behind the refusal is declared instead - as a real
	# Postgres CHECK, which holds on every path into the table rather than only the one the
	# UI takes.
	for code, constraints in (overlay.get("constraints") or {}).items():
		if code not in entities:
			raise KeyError("registers.py: %s has no entity %r to constrain" % (module, code))
		entities[code]["constraints"] = dict(entities[code].get("constraints") or {},
		                                     **constraints)

	# An index a posting action's lookup needs on a generated table. 1C keeps its information
	# registers indexed by their dimensions; the generator copies the rows, not the index, so
	# a slice "the price in force for this product here" scans the whole table - fine once,
	# a timeout when a document asks it per line.
	for code, indexes in (overlay.get("indexes") or {}).items():
		if code not in entities:
			raise KeyError("registers.py: %s has no entity %r to index" % (module, code))
		entities[code]["indexes"] = dict(entities[code].get("indexes") or {}, **indexes)

	# The Ukrainian for what was just added. Everything else in a generated module was
	# translated from the 1C synonym it came from; these columns have no 1C original, so
	# the only place their Ukrainian can come from is the overlay that introduced them.
	for code, labels in (overlay.get("uk") or {}).items():
		if code not in entities:
			raise KeyError("registers.py: %s has no entity %r to translate" % (module, code))
		uk = entities[code].get("uk")
		if uk is not None:
			uk["f"] = dict(uk.get("f") or {}, **labels)

	# Another module's document this one posts: its own columns and posting columns on it, in
	# an extension (`extends`) rather than on an entity of this module.
	if overlay.get("extend"):
		OVERLAY_EXTENDS[module] = overlay["extend"]

	# What the module consumes that its files do not show, for its dependency contracts:
	# [("provider_module.entity", "<kind>:<symbol>"), ...].
	if overlay.get("uses"):
		DECLARED_USES[module] = list(overlay["uses"])

	# A generated module is 0.1.0 until its schema has to change under rows already
	# installed. The platform's upgrade adds columns and never removes a constraint, so a
	# rule taken off a column needs an upgrade migration (`authored/<module>/migrations/
	# <version>.sql`), which runs only on a version above the installed one - and only on
	# a platform that runs migrations at all, which is what `requires` gates on.
	declared = dict((key, overlay[key]) for key in ("version", "requires") if overlay.get(key))
	if declared:
		DECLARED_MODULE[module] = declared

	return overlay.get("defs") or None


# module -> [(qualified provider entity, provenance token)], from the register overlay.
DECLARED_USES = {}
# module -> {"version": "x.y.z", "requires": {system module: range}}, from the overlay.
DECLARED_MODULE = {}
# What a module's register overlay adds to another module's entity: {module: {target: {...}}}.
OVERLAY_EXTENDS = {}


def auto_spec(module, entities, contour, index, registerDefs=None):
	"""A generated module's SPEC, around the entities autospec built."""
	extends = collections.OrderedDict(autospec.EXTENSIONS.get(module, {}))
	overlaid = OVERLAY_EXTENDS.get(module, {})
	for target, ext in overlaid.items():
		extends[target] = list(extends.get(target, [])) + list(ext.get("fields", []))
	deps = dependencies_of(entities) - {module}
	deps |= set(target.split(".")[0] for target in extends) - {module}
	deps |= dependencies_of(dict((target, {"fields": ext.get("fields", []),
	                                       "registry": ext.get("registry")})
	                             for target, ext in overlaid.items())) - {module}
	return {
		"extendRegistry": dict((t, e.get("registry")) for t, e in overlaid.items() if e.get("registry")),
		"extendUk": dict((t, e.get("uk")) for t, e in overlaid.items() if e.get("uk")),
		"extendDescription": dict((t, e.get("desc")) for t, e in overlaid.items() if e.get("desc")),
		**({"registerDefs": registerDefs} if registerDefs else {}),
		"extends": extends,
		"uk": auto_uk(module, entities, contour, auto_menu(entities, module)),
		"code": module,
		"moduleId": module_uuid(module, index),
		"displayName": contour["label"],
		"description": contour.get("description", contour["label"]),
		"label": contour["label"],
		"color": contour.get("color", "#78909C"),
		"icon": contour.get("icon", "box"),
		"tags": contour.get("tags", [module]),
		"auditHistory": "basic",
		"dependencies": dict(
			[(name, ">=0.1.0") for name in sorted(deps)]
			+ sorted(DECLARED_MODULE.get(module, {}).get("requires", {}).items())),
		**({"version": DECLARED_MODULE[module]["version"]}
		   if DECLARED_MODULE.get(module, {}).get("version") else {}),
		"entities": entities,
		"menu": auto_menu(entities, module),
		"roles": auto_roles(module, entities),
	}


# --------------------------------------------------------------------------- specs

import autospec
import binding


def resolve_enums(spec, model):
	"""Turn every `drop1c:<enum>` in an authored spec into the enum's real options."""
	uk_entities = spec.get("uk", {}).get("entities", {})
	for code, entity in spec["entities"].items():
		fields = []
		for item in entity.get("fields", []):
			if not named(item[1], "drop1c:"):
				fields.append(item)
				continue
			found = autospec.enum_spec(model, item[1][len("drop1c:"):])
			if not found:
				raise ValueError("no such enum: %s" % item[1])
			fields.append((item[0], found["spec"]) + tuple(item[2:]))
			uk = uk_entities.get(code)
			if uk is not None:
				uk.setdefault("o", {})[item[0]] = found["uk"]
		entity["fields"] = fields
	return spec


def with_extensions(spec, module):
	"""The generated extensions of an authored module, beside the ones its spec declares - a
	bridge the spec posts on another module's document. Assigning the generated ones dropped
	the spec's own without a word."""
	extends = collections.OrderedDict(autospec.EXTENSIONS[module])
	for target, fields in (spec.get("extends") or {}).items():
		extends[target] = list(extends.get(target, [])) + list(fields)
	return extends


def main():
	generated, model = autospec.build()

	hand = dict((code, dict(spec)) for code, spec in binding.specs().items())
	contours = binding.contours()
	overlays = binding.registers()

	unknown = set(overlays) - set(generated)
	if unknown:
		raise KeyError("registers.py declares registers over %s, which %s"
		               % (", ".join(sorted(unknown)),
		                  "is not a generated module - author it in a spec instead"))
	defs = dict((module, apply_registers(module, entities, overlays.get(module)))
	            for module, entities in generated.items())

	# One authored spec owns the base catalogs, and the generated entities for that
	# module - the integrator's classifiers and the stubs for catalogs the port only
	# points at - are added to it rather than living in a module of their own. Which
	# spec that is belongs to the project, so the project says so.
	absorbing = next((code for code, spec in sorted(hand.items())
	                  if spec.get("absorbsGenerated")), None)
	if absorbing is None:
		for module, spec in sorted(hand.items()):
			if module in autospec.EXTENSIONS:
				spec["extends"] = with_extensions(spec, module)
			emit_module(resolve_enums(spec, model))
		for index, (module, entities) in enumerate(generated.items()):
			emit_module(auto_spec(module, entities, contours.CONTOURS[module], index,
			                      defs.get(module)))
		return

	masterdata = hand[absorbing]
	added = generated.pop(absorbing, {})

	# A register declared over the absorbing module's GENERATED entities. Its overlay was
	# applied above like every other module's, but the absorbing module is emitted from its
	# authored spec rather than from `auto_spec`, which is where `registerDefs` is otherwise
	# threaded through - so without this the declaration is computed and silently dropped,
	# constraints and Ukrainian landing while the register itself never appears. The guard
	# at the top of this function cannot catch it either: the absorbing module IS generated
	# when that runs, and stops being so one line above.
	if defs.get(absorbing):
		masterdata["registerDefs"] = dict(masterdata.get("registerDefs") or {},
		                                  **defs[absorbing])
	merged = collections.OrderedDict(masterdata["entities"])
	merged.update(added)
	masterdata["entities"] = merged

	# The authored Ukrainian wins over anything derived from the dictionary; the derived
	# entries fill in the entities the hand-written spec never covered.
	uk = dict(masterdata["uk"])
	uk_entities = collections.OrderedDict(
		(code, entity["uk"]) for code, entity in added.items() if entity.get("uk"))
	uk_entities.update(uk.get("entities", {}))
	uk["entities"] = uk_entities
	uk["views"] = dict(uk.get("views", {}))
	for code, entity in added.items():
		if entity.get("uk"):
			uk["views"].setdefault(plural(code), entity["uk"]["_"])
	masterdata["uk"] = uk

	hand[absorbing] = masterdata
	for module, spec in hand.items():
		if module in autospec.EXTENSIONS:
			spec["extends"] = with_extensions(spec, module)

	for module in sorted(hand):
		emit_module(resolve_enums(hand[module], model))

	for index, (module, entities) in enumerate(generated.items()):
		emit_module(auto_spec(module, entities, contours.CONTOURS[module], index,
			                      defs.get(module)))


if __name__ == "__main__":
	main()
