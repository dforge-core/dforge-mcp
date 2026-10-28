#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
The configuration's own division into subsystems, and what each one holds.

Where module boundaries come from, when the configuration is not this one. Porting the
client's own development needed no such thing - 195 objects all prefixed `мсб` or `рз`,
grouped by reading them - but that grouping is a judgement about THIS infobase and is
worth nothing to the next one. A 1C configuration already carries a division its authors
made: подсистемы. Reading it costs nothing and applies to every configuration there is.

    python tools/1c.py subsystems                 # every subsystem, with what it holds
    python tools/1c.py subsystems --objects       # each one's data-bearing objects
    python tools/1c.py subsystems --name <name>   # one subsystem in full
    python tools/1c.py subsystems --overlap       # objects claimed by more than one
    python tools/1c.py subsystems --orphans       # objects NO subsystem lists
    python tools/1c.py subsystems --json          # -> out/subsystems.json
    python tools/1c.py subsystems --contours      # -> out/contours_subsystems.py
    python tools/1c.py subsystems --contours --acyclic   # ... and make it installable

What it does NOT do is decide anything. Subsystem membership is presentation in 1C - an
object appears in the command interface of every subsystem that lists it - so overlap is
normal and a module boundary still needs a rule for it. The rule belongs to whoever is
converting; this reports the facts it would be made from.
"""
from __future__ import print_function

import codecs
import collections
import io
import json
import os
import re
import sys

import meta
import naming
import paths

OUT = paths.OUT

# The metadata class of a Подсистема. Class GUIDs are the configuration format's own and
# are the same in every 1C:Enterprise 8 configuration, which is what makes this portable.
SUBSYSTEM = "37f2fa9a-b276-11d4-9435-004095e12fc7"

# Families that hold rows. Everything else a subsystem lists - reports, roles, icons,
# constants, common modules - is real content but not something a conversion loads.
DATA_FAMILIES = ("Reference", "Document", "InfoRg", "AccumRg", "AccRg", "Acc", "Chrc",
                 "CKinds", "Enum", "DocumentJournal", "Seq", "Node", "Task", "CRg", "BPr")

GUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


def _load(name):
	path = os.path.join(OUT, name)
	if not os.path.isfile(path):
		raise SystemExit("subsystems: %s is missing - run `1c.py dump1c` and `meta` first"
		                 % path)
	with codecs.open(path, "r", "utf-8") as f:
		return json.load(f)


def _guids_in(tree, known):
	"""Every known object GUID mentioned in a metadata tree, in the order it appears.

	A subsystem's file is a flat list of the GUIDs it contains plus its own identity and
	presentation. Rather than decode the layout, take every GUID that names an object we
	know - a subsystem cannot mention an object it does not contain, and the two GUIDs
	that are its own are dropped by the caller.
	"""
	found = []
	seen = set()

	def walk(node):
		if isinstance(node, list):
			for item in node:
				walk(item)
		elif isinstance(node, str) and node not in seen and GUID.match(node):
			seen.add(node)
			if node in known:
				found.append(node)

	walk(tree)
	return found


def collect():
	"""One record per subsystem: what it contains, and how much of it holds rows."""
	objects = _load("objects_all.json")
	by_guid = dict((o["guid"], o) for o in objects)

	rows_by_name = {}
	report_path = os.path.join(OUT, "report.json")
	if os.path.isfile(report_path):
		for row in _load("report.json"):
			if row.get("name"):
				rows_by_name[row["name"]] = ((row.get("rows") or 0)
				                             + (row.get("childRows") or 0))

	ported = set()
	colmap_path = os.path.join(OUT, "columnmap.json")
	if os.path.isfile(colmap_path):
		mapped = _load("columnmap.json")
		for module in mapped:
			for entity in mapped[module]:
				record = mapped[module][entity]
				if isinstance(record, dict) and record.get("table"):
					ported.add(record["table"])
	table_of = dict((r["name"], r.get("physical")) for r in _load("report.json")
	                if r.get("name"))

	found = []
	for obj in objects:
		if obj.get("classGuid") != SUBSYSTEM:
			continue
		text = meta.load(obj["guid"])
		if text is None:
			continue
		contents = [g for g in _guids_in(meta.parse(text), by_guid) if g != obj["guid"]]
		holds = []
		for guid in contents:
			other = by_guid[guid]
			family = other.get("family")
			if family not in DATA_FAMILIES:
				continue
			name = other["name"]
			holds.append({
				"name": name,
				"family": family,
				"rows": rows_by_name.get(name, 0),
				"ported": table_of.get(name) in ported,
			})
		found.append({
			"name": obj["name"],
			"synonym": obj.get("synonym") or "",
			"guid": obj["guid"],
			"members": len(contents),
			"objects": holds,
			"rows": sum(h["rows"] for h in holds),
			"ported": sum(1 for h in holds if h["ported"]),
		})
	found.sort(key=lambda s: -s["rows"])
	return found


def table(found):
	print("%-46s %7s %7s %7s %14s"
	      % ("subsystem", "members", "data", "ported", "rows"))
	print("-" * 86)
	for sub in found:
		print("%-46s %7d %7d %7d %14d"
		      % ((sub["synonym"] or sub["name"])[:46], sub["members"],
		         len(sub["objects"]), sub["ported"], sub["rows"]))
	print("-" * 86)
	print("%-46s %7s %7d %7d %14d"
	      % ("%d subsystem(s)" % len(found), "",
	         sum(len(s["objects"]) for s in found),
	         sum(s["ported"] for s in found),
	         sum(s["rows"] for s in found)))
	print("\nRows are counted per subsystem, so an object in two subsystems is counted\n"
	      "twice - `--overlap` says how much of that there is.")


def detail(found, name):
	wanted = [s for s in found
	          if s["name"] == name or s["synonym"] == name
	          or s["name"].lower().startswith(name.lower())]
	if not wanted:
		raise SystemExit("subsystems: no subsystem matches %r" % name)
	for sub in wanted:
		print("%s   %s" % (sub["name"], sub["synonym"]))
		print("   %d member(s), %d of them hold rows, %d already ported, %d rows"
		      % (sub["members"], len(sub["objects"]), sub["ported"], sub["rows"]))
		for held in sorted(sub["objects"], key=lambda h: -h["rows"]):
			print("      %-16s %-46s %12d  %s"
			      % (held["family"], held["name"][:46], held["rows"],
			         "ported" if held["ported"] else ""))


def overlap(found):
	"""An object listed by more than one subsystem, which is normal and is the reason a
	module boundary needs a rule rather than a lookup."""
	owners = collections.OrderedDict()
	rows = {}
	for sub in found:
		for held in sub["objects"]:
			owners.setdefault(held["name"], []).append(sub["name"])
			rows[held["name"]] = held["rows"]
	shared = [(n, o) for n, o in owners.items() if len(o) > 1]
	shared.sort(key=lambda p: (-len(p[1]), -rows[p[0]]))
	print("%d data object(s) in a subsystem; %d are in more than one"
	      % (len(owners), len(shared)))
	print("%d row(s) once each; %d counted more than once"
	      % (sum(rows.values()), sum(rows[n] for n, _ in shared)))
	if not shared:
		return
	print("\nthe 25 most shared:")
	for name, who in shared[:25]:
		print("   %-46s %12d  %d: %s"
		      % (name[:46], rows[name], len(who), ", ".join(who[:4])))


def orphans(found):
	"""Objects that hold rows and that no subsystem lists.

	The reason this view exists rather than being assumed away: subsystem membership is
	optional in 1C, so a conversion that walked the subsystems alone would drop whatever
	nobody bothered to file - silently, and in proportion to how carelessly the
	configuration was maintained. Counting them is how you learn whether the subsystem
	tree is a usable spine for this configuration or only a partial one.
	"""
	claimed = set()
	for sub in found:
		for held in sub["objects"]:
			claimed.add(held["name"])

	loose = []
	for row in _load("report.json"):
		name = row.get("name")
		rows = (row.get("rows") or 0) + (row.get("childRows") or 0)
		if name and name not in claimed and rows:
			loose.append((rows, row.get("family") or "?", name))
	loose.sort(reverse=True)
	print("%d object(s) hold rows and are in no subsystem, %d rows"
	      % (len(loose), sum(l[0] for l in loose)))
	if not loose:
		return
	print("\nthe 30 biggest:")
	for rows, family, name in loose[:30]:
		print("   %-16s %-46s %12d" % (family, name[:46], rows))

# Objects a subsystem lists that a conversion has no business generating an entity for.
# Enums become dropdown options on the fields that cite them; a document journal is 1C's
# own index over documents and holds nothing of its own; a sequence is a posting
# watermark. Each is a decision this tool can make because it follows from what the
# family IS, not from what this configuration does with it.
SKIP_FAMILIES = ("Enum", "DocumentJournal", "Seq")


def _crossing(shared_code):
	"""Entities that something outside their own module references, and everything those
	reach in turn.

	The subsystem rule alone produced a map that GENERATED and VALIDATED cleanly and could
	not be installed: 16 of 22 modules sat in dependency cycles, because a module holding
	shared objects still points at entities in the modules that share them. Merging every
	cycle would collapse the map back into one module, which is the answer nobody wants.

	So: every entity referenced from outside its module moves to the shared one, and so
	does everything those entities reach. Every cross-module edge then ends in the shared
	module, the graph is a star, and a star has no cycles by shape rather than by luck.

	It needs the generated modules to read the references from, which is why this is a
	second pass and not a cleverer first one.
	"""
	import columnmap

	owner, refs, source = {}, collections.defaultdict(set), {}
	generated, mapped = columnmap.build()
	for module in mapped:
		for entity in mapped[module]:
			record = mapped[module][entity]
			if isinstance(record, dict) and record.get("object"):
				source["%s.%s" % (module, entity)] = record["object"]

	if not os.path.isdir(paths.MODULES):
		raise SystemExit("subsystems: --acyclic needs the modules generated first - run "
		                 "`1c.py autospec` and `genmodule` against this project")
	for module in sorted(os.listdir(paths.MODULES)):
		folder = os.path.join(paths.MODULES, module, "entities")
		if not os.path.isdir(folder):
			continue
		for name in sorted(os.listdir(folder)):
			if name.endswith(".json"):
				owner["%s.%s" % (module, name[:-5])] = module
	for key in list(owner):
		module = owner[key]
		path = os.path.join(paths.MODULES, module, "entities",
		                    key.split(".", 1)[1] + ".json")
		with io.open(path, encoding="utf-8") as f:
			spec = json.load(f)
		for field in (spec.get("fields") or {}).values():
			target = (field.get("link") or {}).get("entity")
			if not target:
				continue
			if "." not in target:
				target = "%s.%s" % (module, target)
			if target in owner:
				refs[key].add(target)

	pulled = set()
	for key, targets in refs.items():
		for target in targets:
			if owner[target] != owner[key]:
				pulled.add(target)
	growing = True
	while growing:
		growing = False
		for key in list(pulled):
			for target in refs.get(key, ()):
				if target not in pulled and owner[target] != shared_code:
					pulled.add(target)
					growing = True
	# A line entity has no 1C object of its own - it is a tabular section of its parent -
	# so moving it means moving the parent, which the source map already resolves to.
	return set(source[k] for k in pulled if k in source)


def _already_ported():
	"""1C object names the FIRST project already copies, which this one must leave alone.

	Subsystem membership does not care who has already ported what, so the standard
	configuration's subsystems duly listed 102 objects the client port already carries -
	Добавления МСБ is the client's own development, and `common` picked up СерииНоменклатуры
	and ЕдиницыИзмерения, which are `masterdata` already. Generating them a second time is not
	redundancy to be tidied later: loading both maps would put 4,932,617 rows into a tenant
	twice, in two schemas, with nothing relating the copies and every reference pointing at
	one of them.

	The first project's column map is the register of what it carries, so that is what is
	asked. Returns nothing when this IS the first project, since a project cannot be told
	to leave its own work alone.
	"""
	if os.path.basename(paths.PROJECT) == "project":
		return set()
	path = os.path.join(OUT, "columnmap.json")
	if not os.path.isfile(path):
		return set()
	with codecs.open(path, "r", "utf-8") as f:
		mapped = json.load(f)
	found = set()
	for module in mapped:
		for entity in mapped[module]:
			record = mapped[module][entity]
			if isinstance(record, dict) and record.get("object"):
				found.add(record["object"])
	return found

def emit_contours(found, shared_code="common", acyclic=False):
	"""Write a CONTOURS map, one module per subsystem, ready for a project directory.

	`binding.py` already lets the library be pointed at a different infobase by pointing it
	at a different project directory. What had no answer was where that directory's contour
	map comes from: the one for this client was written by reading 195 objects, which does
	not scale to 524 and does not transfer to the next configuration at all.

	**The overlap rule is the only judgement here, and it is deliberately the dull one.**
	194 of the 524 objects are listed by more than one subsystem - `Хозрасчетный` by twelve
	- because membership in 1C is presentation: an object shows up in the command interface
	of every subsystem that lists it. Putting such an object in one of them arbitrarily
	would make the other modules depend on a module named after someone else's concern, and
	the dependency graph would acquire cycles the moment two subsystems shared in both
	directions. So everything shared goes to one module that the others depend on. That is
	what `masterdata` already is in the hand-written port, arrived at the same way.
	"""
	owners = collections.OrderedDict()
	for sub in found:
		for held in sub["objects"]:
			if held["family"] in SKIP_FAMILIES:
				continue
			owners.setdefault(held["name"], []).append(sub)

	crossing = _crossing(shared_code) if acyclic else set()
	mine = _already_ported()
	assigned = collections.OrderedDict()
	skipped = 0
	for name, subs in owners.items():
		if name in mine:
			skipped += 1
			continue
		shared = len(subs) > 1 or name in crossing
		code = shared_code if shared else naming.code(subs[0]["name"])
		assigned.setdefault(code, []).append(name)
	if skipped:
		print("   %d object(s) left to the first project, which already ports them" % skipped)

	synonym = dict((naming.code(s["name"]), s["synonym"] or s["name"]) for s in found)
	synonym[shared_code] = "Shared across subsystems"

	lines = [u"# -*- coding: utf-8 -*-",
	         u'"""Contour map generated from the configuration\'s own subsystems.',
	         u"",
	         u"Generated by `1c.py subsystems --contours`; edit it or regenerate it, but do",
	         u"not do both and expect the edits to survive.",
	         u"",
	         u"A subsystem is how the configuration's authors arranged their COMMAND",
	         u"INTERFACE. That is a good first guess at a module boundary and no more than a",
	         u"guess: it says what its authors thought belonged together on a menu, which is",
	         u"usually but not always what belongs together in a schema.",
	         u"",
	         u"Two things to know before trusting it:",
	         u"",
	         u"  * every object listed by more than one subsystem is in %r, which the rest"
	         % shared_code,
	         u"    depend on. Assigning such an object to one of its subsystems arbitrarily",
	         u"    would make the others depend on a module named after someone else's",
	         u"    concern, and two subsystems sharing in both directions would put a cycle",
	         u"    in the graph.",
	         u"  * objects in NO subsystem are absent from here entirely. Run",
	         u"    `1c.py subsystems --orphans` before assuming this map is the whole",
	         u"    infobase - in the configuration it was generated from it was not close.",
	         u"",
	         u"The module codes are transliterated from the subsystem names and are meant to",
	         u"be renamed by hand; nothing downstream depends on their spelling.",
	         u'"""',
	         u"import collections",
	         u"",
	         u"CONTOURS = collections.OrderedDict([",
	         u""]
	for code in sorted(assigned):
		label = synonym.get(code, code)
		lines.append(u'\t("%s", {' % code)
		lines.append(u'\t\t"label": u"%s",' % label)
		lines.append(u'\t\t"description": u"%s",' % label)
		lines.append(u'\t\t"color": "#78909C",')
		lines.append(u'\t\t"icon": "box",')
		lines.append(u'\t\t"tags": [],')
		lines.append(u'\t\t"objects": [')
		for name in sorted(assigned[code]):
			lines.append(u'\t\t\tu"%s",' % name)
		lines.append(u"\t\t],")
		lines.append(u"\t}),")
		lines.append(u"")
	lines.append(u"])")
	lines.append(u"")
	lines.append(u"# Object name -> the entity code to use instead of the derived one.")
	lines.append(u"CODES = {}")
	lines.append(u"")
	lines.append(u"# (module, entity, column) -> the module that should own the column,")
	lines.append(u"# for a reference that would otherwise invert a dependency.")
	lines.append(u"EXTENSIONS = {}")
	lines.append(u"")
	lines.append(u"# Objects an authored spec covers. Nothing is authored here.")
	lines.append(u"DONE = set()")
	lines.append(u"")
	lines.append(u"")
	lines.append(u"def names(contour):")
	lines.append(u'\t"""The 1C object names one contour owns."""')
	lines.append(u'\treturn list(contour["objects"])')
	lines.append(u"")

	path = os.path.join(OUT, "contours_subsystems.py")
	with io.open(path, "w", encoding="utf-8", newline="\n") as f:
		f.write(u"\n".join(lines))
	print("%s: %d module(s), %d object(s)"
	      % (path, len(assigned), sum(len(v) for v in assigned.values())))
	for code in sorted(assigned, key=lambda c: -len(assigned[c])):
		print("   %-34s %4d object(s)" % (code, len(assigned[code])))

def main():
	args = sys.argv[1:]
	found = collect()

	if "--json" in args:
		path = os.path.join(OUT, "subsystems.json")
		with io.open(path, "w", encoding="utf-8") as f:
			f.write(json.dumps(found, ensure_ascii=False, indent=1,
			                   sort_keys=True))
		print("%s: %d subsystem(s)" % (path, len(found)))
		return
	if "--overlap" in args:
		return overlap(found)
	if "--orphans" in args:
		return orphans(found)
	if "--contours" in args:
		return emit_contours(found, acyclic="--acyclic" in args)
	if "--name" in args:
		return detail(found, args[args.index("--name") + 1])
	if "--objects" in args:
		for sub in found:
			print("\n%s   %s   %d rows" % (sub["name"], sub["synonym"], sub["rows"]))
			for held in sorted(sub["objects"], key=lambda h: -h["rows"])[:12]:
				print("   %-16s %-44s %12d" % (held["family"], held["name"][:44],
				                               held["rows"]))
		return
	table(found)


if __name__ == "__main__":
	main()
