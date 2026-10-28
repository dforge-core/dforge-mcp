#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Every register in the infobase, with the facts a declaration needs.

    python tools/1c.py inventory                 # the client's registers, as a table
    python tools/1c.py inventory --all           # the vendor's too
    python tools/1c.py inventory --json          # out/registers.json, for other tools
    python tools/1c.py inventory --name _AccumRg17011     # one register, in full
    python tools/1c.py inventory --name мсбТараВЦехах     # the same, by 1C name

Written after the same survey was done three times in throwaway scripts, each with the
register names typed in by hand. That is the wrong shape twice over: the names belong to
the configuration rather than to a script, and a script that names them cannot notice a
register nobody has thought of yet.

**What is derivable and what is not.** Everything here is a FACT read from the extracted
metadata: which registers exist, their tables and fields, how many rows, whether 1C keeps
a record kind or a recorder, which ported entity holds them and under what column names.
None of it is a DECISION - that a register is in scope, what KIND it becomes in dForge,
which document binds to it with which direction. Those live in `tools/project/registers.py`
and should key off the names printed here rather than restate them.

The two are easy to confuse because 1C's own family looks like a decision and is not:
`мсбФактическаяРаботаЛиний` is an information register that the client writes signed values
into and sums, so the faithful port is `turnover`. The family is evidence, not an answer,
which is exactly why this tool reports evidence and stops.

**Writers are reported from the handler text, and that source is weak in two ways.** 1C
names a movement set two ways - `Движения.<имя>` and `Движения["<имя>"]` - and a scan that
knows one of them reads as a clean result while missing whole registers; eight of these are
written through the bracket form alone, so both are counted here. Worse, a register is also
written from COMMON modules, which no scan of document handlers can reach at all:
`мсбПродажиНалоговыйУчет` holds 478,260 rows from eight document types and its own handlers
name it nowhere.

So the writer column is evidence, never a census, and an empty one reads `ask data` rather
than `none`. The authoritative answer is in the rows: `python tools/1c.py recorders <table>`
reads the recorder type ids and cannot miss a syntax or a common module.
"""
from __future__ import print_function

import codecs
import collections
import io
import json
import os
import re
import sys

import binding
import paths

OUT = paths.OUT

# The two ways a handler names a movement set, and the marker of a handler that consumes
# from the register's own balance rather than writing what its lines say.
DOT = u"Движения."
BRACKET = u"Движения["
CONSUME = u"ВыполнитьРасход"
CLIENT = binding.client_prefixes()

# THE SECOND WAY A HANDLER CONSUMES, and the one that hid a 31,166-row writer.
# `ВыполнитьРасход` is one spelling: ask the register to take from its balance. The other is
# to JOIN the register's own Остатки inside the posting handler and write movements built
# from what came back - `мсбВыпускБлюд` takes Рецептура and Цена off the balance that way,
# then writes an expense with `ВыполнитьДвижения`. Same algorithm, no marker, and the sweep
# called that register bindable.
#
# WHERE the read sits decides, which is why this is not a plain substring test: a fill
# procedure reading the balance is a user pressing "Заполнить" and says nothing about
# posting. `мсбПланИзготовленияБлюд` reads the same balance in `ЗаполнитьОстатки()` and
# posts only what its lines carry, so it is NOT algorithmic - and a test that ignored the
# procedure would have said it was.
POSTING = u"ОбработкаПроведения"
OWN_READ = (u"РегистрНакопления\\.%s\\.(?:ОстаткиИОбороты|Остатки|Обороты)")
PROCEDURE = re.compile(u"(?m)^[ 	]*(?:Процедура|Функция)[ 	]+([А-Яа-яA-Za-z0-9_]+)")

FAMILIES = ("AccumRg", "InfoRg")

# How a query asks a register for an answer. 1C spells the virtual tables by suffixing the
# register's name, so counting them says what the configuration actually WANTS from it -
# which is the evidence that decides whether a port models it as a balance or a turnover.
# Longest first: ОстаткиИОбороты contains both of the others.
READS = [
	(u"ОстаткиИОбороты", "both"),
	(u"Остатки", "remains"),
	(u"Обороты", "turnover"),
	(u"СрезПоследних", "slice"),
]

# A read that names no virtual table at all. "РегистрНакопления.<name>" with nothing appended is
# the register's own table, which is how a turnover register kept as a fact table gets read -
# and the virtual-table count says nothing at all about that. "Движения.<name>" is a WRITE,
# which is why the prefix is part of the needle rather than the bare name.
DIRECT = [u"РегистрНакопления.", u"РегистрСведений."]


def _mentions(text, name):
	"""Does the text name this register, as opposed to one whose name starts the same?

	`мсбПродажиНалоговыйУчет` is a prefix of `мсбПродажиНалоговыйУчетВременный`, so a plain
	substring search hands the shorter register the longer one's writers - which it did:
	`КорректировкаДолга` was reported as writing the first when it writes the second. 1C
	identifiers run on letters, digits and underscore, so the character after the name has
	to be none of those. Cyrillic counts as alphanumeric here, which is exactly what makes
	the check work.
	"""
	at = text.find(name)
	while at >= 0:
		after = text[at + len(name):at + len(name) + 1]
		if not (after.isalnum() or after == "_"):
			return True
		at = text.find(name, at + 1)
	return False


def _kind(family, record_kind):
	"""What the infobase's own shape says this register is.

	`_RecordKind` tells a balance register from a turnover one **among accumulation
	registers**. An information register never has one, so reading its absence the same way
	labelled all 56 of the client's information registers "turnover" and offered that as
	modelling guidance. The family comes first.
	"""
	if family != "AccumRg":
		return "info"
	return "bal" if record_kind else "turn"


def _every_module():
	"""Object -> the text of every module in the configuration, not only documents.

	A register is READ from anywhere - reports, common modules, other documents - so the
	question "what does the configuration want from this register" cannot be asked of
	document handlers alone.
	"""
	index_path = os.path.join(OUT, "code", "index.json")
	if not os.path.isfile(index_path):
		return {}
	texts = collections.OrderedDict()
	with io.open(index_path, encoding="utf-8") as f:
		index = json.load(f)
	for entry in index:
		path = os.path.join(OUT, entry["path"])
		if not os.path.isfile(path):
			continue
		with io.open(path, encoding="utf-8", errors="ignore") as f:
			texts.setdefault(entry["object"], []).append(f.read())
	return dict((name, u"".join(parts)) for name, parts in texts.items())


def _reads(modules, name):
	"""How the configuration asks this register for an answer, and who asks.

	"ОстаткиИОбороты" CONTAINS both "Остатки" and "Обороты", so its occurrences are
	subtracted from theirs rather than stopping the scan. Stopping at the first suffix that
	matched threw away every other suffix the same module used, and a module that asks for
	the balance in one query and the turnover in another is the ordinary case: it is the
	difference between "this register is read as a balance" and "read as both".
	"""
	counts = collections.OrderedDict((label, 0) for _, label in READS)
	counts["direct"] = 0
	askers = {}
	for obj, text in modules.items():
		big = READS[0][0]
		both = text.count(name + big)
		for suffix, label in READS:
			found = text.count(name + suffix)
			if label in ("remains", "turnover"):
				found -= both
			if found <= 0:
				continue
			counts[label] += found
			askers.setdefault(label, set()).add(obj)
		bare = sum(text.count(prefix + name) for prefix in DIRECT)
		qualified = sum(text.count(prefix + name + suffix)
		                for prefix in DIRECT for suffix, _ in READS)
		# The long suffix was counted three times in `qualified`: once as itself and once
		# inside each of the two shorter suffixes it contains.
		qualified -= 2 * sum(text.count(prefix + name + big) for prefix in DIRECT)
		if bare - qualified > 0:
			counts["direct"] += bare - qualified
			askers.setdefault("direct", set()).add(obj)
	return counts, dict((k, sorted(v)) for k, v in askers.items())


def _handlers():
	"""Document -> the text of every module it has, from the extracted code."""
	index_path = os.path.join(OUT, "code", "index.json")
	if not os.path.isfile(index_path):
		return {}
	with io.open(index_path, encoding="utf-8") as f:
		index = json.load(f)
	texts = collections.OrderedDict()
	for entry in index:
		if entry.get("family") != "Document":
			continue
		path = os.path.join(OUT, entry["path"])
		if not os.path.isfile(path):
			continue
		with io.open(path, encoding="utf-8", errors="ignore") as f:
			texts.setdefault(entry["object"], []).append(f.read())
	return dict((name, u"".join(parts)) for name, parts in texts.items())


def _ported():
	"""Physical table -> (module.entity, {column: source}), from the column map."""
	import columnmap

	generated, mapped = columnmap.build()
	out = {}
	for module in mapped:
		for entity in mapped[module]:
			found = mapped[module][entity]
			if not isinstance(found, dict):
				continue
			table = found.get("table")
			if table:
				out[table] = ("%s.%s" % (module, entity), found.get("columns") or {})
	return out


def _consumes_in_posting(text, name):
	"""The procedure where this document's POSTING path reads the register's own balance.

	The procedures the posting handler can reach are itself plus everything it names - one
	hop, which is as far as this needs to go: a handler that builds its movements out of the
	balance does the reading where it writes, or in a procedure it calls with the movement
	table in hand.

	Returns that procedure's name, or None. Naming it matters: "this is an algorithm" is
	worth no more than the line someone can go and look at.
	"""
	bounds = [(m.group(1), m.start()) for m in PROCEDURE.finditer(text)]
	if not bounds:
		return None
	ends = [start for _, start in bounds[1:]] + [len(text)]
	bodies = [(proc, text[start:end]) for (proc, start), end in zip(bounds, ends)]

	reach = set()
	for proc, body in bodies:
		if proc == POSTING:
			reach.add(proc)
			reach.update(other for other, _ in bodies if other != proc and other in body)

	asked = re.compile(OWN_READ % re.escape(name))
	for proc, body in bodies:
		if proc in reach and asked.search(body):
			return proc
	return None


def collect(everything=False):
	"""One record per register: what it is, where it landed, and who writes it."""
	import attrs
	import autospec

	generated, model = autospec.build()
	ported = _ported()
	handlers = _handlers()
	modules = _every_module()

	rows_by_table = {}
	report_path = os.path.join(OUT, "report.json")
	if os.path.isfile(report_path):
		with codecs.open(report_path, "r", "utf-8") as f:
			for row in json.load(f):
				if row.get("physical"):
					rows_by_table[row["physical"]] = row.get("rows")

	found = []
	for obj in model.objects:
		family = obj.get("family")
		if family not in FAMILIES:
			continue
		name = obj.get("name") or ""
		mine = name.startswith(CLIENT)
		if not (everything or mine):
			continue
		table, _ = model.physical(name, family)
		columns = model.table_columns(table) if table else set()

		fields = []
		for field in model.fields(name, family):
			physical = model.fld.get(field.get("guid"))
			fields.append({
				"name": field.get("name"),
				"type": field.get("type"),
				"column": physical,
				# Which of the three a field is, as 1C declared it. This is the one thing
				# the declaration cannot be guessed from: a register's KEY is its
				# dimensions and what it SUMS is its resources, and reading the two off
				# the column types gets it wrong as soon as a resource is a quantity and
				# a dimension is a number. 1C says so outright, in the collection the
				# field sits in, and the inventory was throwing that away.
				"role": attrs.ROLE.get(field.get("collection"), "?"),
				# 1C splits a reference that may point at several catalogues into
				# _RRRef/_RTRef/_TYPE. dForge references are single-target, so this is
				# a modelling problem and worth carrying as a fact.
				"composite": bool(physical and (physical + "_TYPE") in columns),
			})

		writers = []
		for document, text in handlers.items():
			# The bracket form carries its own boundary - the closing quote - so only the
			# dotted one needs the identifier check.
			dot = _mentions(text, DOT + name)
			bracket = (BRACKET + '"' + name + '"') in text
			if not (dot or bracket):
				continue
			near = []
			lines = text.splitlines()
			for i, line in enumerate(lines):
				if _mentions(line, name):
					near.extend(lines[max(0, i - 25):i + 25])
			writers.append({
				"document": document,
				"client": document.startswith(CLIENT),
				"how": ("dot" if dot else "") + ("+bracket" if dot and bracket
				                                 else "bracket" if bracket else ""),
				# A handler that reads the balance and takes from it is an algorithm, and
				# no declarative binding expresses one. Two spellings, both counted -
				# see the note on POSTING for why the second one needs the procedure.
				"consumes": (CONSUME in u"\n".join(near)
				             or bool(_consumes_in_posting(text, name))),
				"consumesIn": _consumes_in_posting(text, name),
			})

		read_counts, read_by = _reads(modules, name)
		entity, mapped_columns = ported.get(table, (None, {}))
		found.append({
			"reads": read_counts,
			"readBy": read_by,
			"name": name,
			"family": family,
			"table": table,
			"rows": rows_by_table.get(table),
			"client": mine,
			"recordKind": "_RecordKind" in columns,
			"recorder": "_RecorderRRef" in columns,
			"period": "_Period" in columns,
			"entity": entity,
			"columns": mapped_columns,
			"fields": fields,
			"writers": sorted(writers, key=lambda w: w["document"]),
		})
	return sorted(found, key=lambda r: -(r["rows"] or 0))


def declared():
	"""Every register the port has declared: the entity it holds -> its register code.

	Read from the GENERATED packages (`modules/<code>/registers.json`) rather than from a
	project's overlay. A first attempt went through `binding.registers()` and reported two
	declared registers as missing, because that overlay only carries the registers of
	GENERATED modules - an authored module declares its own inline, and `shipping` has two.
	The package is where both end up, and it is also what actually gets installed, so it is
	the one place that cannot disagree with the tenant.
	"""
	out = {}
	if not os.path.isdir(paths.MODULES):
		return out
	for module in sorted(os.listdir(paths.MODULES)):
		path = os.path.join(paths.MODULES, module, "registers.json")
		if not os.path.isfile(path):
			continue
		with io.open(path, encoding="utf-8") as f:
			try:
				declarations = json.load(f)
			except ValueError:
				continue
		for code, definition in (declarations or {}).items():
			if not isinstance(definition, dict):
				continue
			held = definition.get("journal") or definition.get("entity")
			if held:
				out["%s.%s" % (module, held)] = "%s.%s" % (module, code)
	return out


def undeclared(records):
	"""Registers a document writes that the port has not declared, worst first.

	This is the reason the inventory exists. A register nobody has thought of cannot be
	remembered, and a list typed into a script cannot grow. The configuration knows; ask it.

	**A register with no ported entity belongs here too.** The first version skipped them,
	on the reasoning that a declaration needs an entity to be declared over - which is true
	and is not a reason to hide them: not being ported at all is a bigger gap than not being
	declared, not a smaller one. Four registers and 460,813 rows were missing from the
	report because of it. They are listed with the entity shown as `unmapped`.

	**Nor does a register qualify by having a writer we can SEE.** The writer list comes
	from document handler text, and 1C also writes registers from common modules, which no
	scan of documents can reach: `мсбПродажиНалоговыйУчет` holds 478,260 rows written by
	eight document types - the data says so through their recorder ids - and its own
	handlers name it nowhere. Gating on the text would have dropped it from the report
	entirely. So what qualifies is holding ROWS: something wrote them, whether or not we
	can point at it.
	"""
	held = declared()
	out = []
	for record in records:
		if not (record["writers"] or record["rows"]):
			continue
		if record["entity"] and record["entity"] in held:
			continue
		out.append(record)
	return out


def _table(records):
	print("%-46s %-7s %9s %6s %7s %7s  %s"
	      % ("register", "family", "rows", "kind", "writers", "consume", "ported entity"))
	print("-" * 118)
	for record in records:
		writers = record["writers"]
		print("%-46s %-7s %9s %6s %7s %7s  %s"
		      % (record["name"][:46], record["family"],
		         record["rows"] if record["rows"] is not None else "?",
		         _kind(record["family"], record["recordKind"]),
		         "%d/%d" % (sum(1 for w in writers if w["client"]), len(writers)),
		         sum(1 for w in writers if w["consumes"]) or "-",
		         record["entity"] or "-"))
	written = [r for r in records if r["writers"]]
	algorithmic = [r for r in written if any(w["consumes"] for w in r["writers"])]
	print("-" * 118)
	print("%d registers, %d written by a document, %d of those algorithmic; %s rows"
	      % (len(records), len(written), len(algorithmic),
	         sum(r["rows"] or 0 for r in records)))


def _detail(record):
	print("%s   %s   %s" % (record["name"], record["family"], record["table"]))
	shape = {
		"bal": "a record kind, so a balance register",
		"turn": "no record kind, so a turnover register",
		"info": "an information register - a record kind would not apply",
	}[_kind(record["family"], record["recordKind"])]
	print("   rows %s, %s, %s, %s"
	      % (record["rows"], shape,
	         "written by a recorder" if record["recorder"] else "maintained directly",
	         "periodic" if record["period"] else "not periodic"))
	print("   ported to %s" % (record["entity"] or "nothing - not ported at all"))
	print("\n   fields (dimensions key the register, resources are what it sums):")
	order = {"dimension": 0, "resource": 1, "attr": 2}
	for field in sorted(record["fields"], key=lambda f: order.get(f.get("role"), 3)):
		ported = [c for c, source in (record["columns"] or {}).items()
		          if field["column"] and source and field["column"] in source]
		print("      %-10s %-26s %-34s %-12s %s%s"
		      % (field.get("role") or "?", field["name"], str(field["type"])[:34],
		         field["column"] or "", ported[0] if ported else "",
		         "   COMPOSITE" if field["composite"] else ""))
	asked = [(label, n) for label, n in record["reads"].items() if n]
	print("\n   what the configuration asks it for:")
	if asked:
		for label, n in asked:
			who = record["readBy"].get(label) or []
			print("      %-10s %4d query(ies)   %s%s"
			      % (label, n, ", ".join(who[:4]), " ..." if len(who) > 4 else ""))
	else:
		print("      nothing - no query names its virtual tables")
	print("\n   writers:")
	for writer in record["writers"]:
		print("      %-46s %-8s %-8s %s"
		      % (writer["document"][:46], "client" if writer["client"] else "vendor",
		         writer["how"], "CONSUMES from the balance" if writer["consumes"] else ""))
	if not record["writers"]:
		print("      (no document writes it)")
	print("\n   the data has the last word on writers:")
	print("      python tools/1c.py recorders %s" % record["table"])


def main():
	args = sys.argv[1:]
	everything = "--all" in args
	as_json = "--json" in args
	name = None
	if "--name" in args:
		name = args[args.index("--name") + 1].decode("utf-8") \
			if sys.version_info[0] == 2 else args[args.index("--name") + 1]

	records = collect(everything=everything or bool(name))
	if name:
		# By 1C name or by physical table. The table is the ASCII handle: it is what an
		# error, a log line or `recorders` gives you, and it survives a shell that mangles
		# Cyrillic on the command line.
		for record in records:
			if name in (record["name"], record["table"]):
				_detail(record)
				return 0
		print("no register called %s - try --all, or give its _AccumRg/_InfoRg table" % name)
		return 1

	if "--undeclared" in args:
		left = undeclared(records)
		visible = [r for r in left if r["writers"]]
		print("%d register(s) the port has not declared: they hold rows, or a handler names "
		      "them, or both.\n%d have a writer we can see; the rest say `ask data`, which "
		      "means\n`recorders <table>` is the one that knows.\n"
		      % (len(left), len(visible)))
		print("%-46s %9s %5s %8s %10s  %s"
		      % ("register", "rows", "kind", "writers", "consuming", "ported entity"))
		print("-" * 106)
		for record in left:
			writers = record["writers"]
			consuming = sum(1 for w in writers if w["consumes"])
			print("%-46s %9s %5s %8s %10s  %s"
			      % (record["name"][:46], record["rows"],
			         _kind(record["family"], record["recordKind"]),
			         "%d/%d" % (sum(1 for w in writers if w["client"]), len(writers))
			         if writers else "ask data",
			         "%d ALGO" % consuming if consuming else "-",
			         record["entity"] or "unmapped - not ported at all"))
		print("-" * 106)
		print("%s rows, of which %s behind a handler that consumes from the balance"
		      % (sum(r["rows"] or 0 for r in left),
		         sum(r["rows"] or 0 for r in left
		             if any(w["consumes"] for w in r["writers"]))))
		return 0

	if as_json:
		path = paths.derived("registers.json")
		with io.open(path, "w", encoding="utf-8") as f:
			f.write(json.dumps(records, ensure_ascii=False, indent="\t"))
		print("%s: %d register(s)" % (path, len(records)))
		return 0

	_table(records)
	return 0


if __name__ == "__main__":
	sys.exit(main())
