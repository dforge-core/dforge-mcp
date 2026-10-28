#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""What each document's posting handler actually writes.

The first measurement of this counted the body of `ОбработкаПроведения` and stopped there,
and that is not what a handler writes. A four-line handler that calls a procedure writing
two registers per line is not a four-line handler, and a document that writes movements
from `ПриЗаписи` does not write them only when posted. Both shapes are in this base, and
between them they moved the "ports one for one" list by more than a name.

So this follows the calls. For every document module that has a posting handler:

  * the registers the handler names directly;
  * the registers named by any procedure in the same module that the handler calls;
  * the registers written outside posting altogether, from `ПриЗаписи` / `ПередЗаписью`.

A name only counts when the metadata has a register by it. `Движения.` also reaches
accounting-movement collections and a few properties, and counting those inflated an
earlier figure by half.

    python tools/1c.py handlers            # the summary, and out/handlers.json
    python tools/1c.py handlers --client   # the client's own documents, classified
"""
from __future__ import print_function

import codecs
import io
import json
import os
import re
import sys

import binding
import paths

CODE = os.path.join(paths.OUT, "code", "Document")

POST = u"ОбработкаПроведения"
ON_WRITE = u"ПриЗаписи"
BEFORE_WRITE = u"ПередЗаписью"

# The client's own development carries the project's prefixes; everything else is the
# vendor's configuration, whose registers the port deliberately does not carry.
CLIENT = binding.client_prefixes()

WORD = u"[А-Яа-яёЁA-Za-z_][А-Яа-яёЁA-Za-z_0-9]*"
PROC = re.compile(u"^[ \t]*(?:Процедура|Функция)[ \t]+(%s)" % WORD, re.M | re.U)
END = re.compile(u"^[ \t]*(?:КонецПроцедуры|КонецФункции)", re.M | re.U)
REGISTER = re.compile(u"Движения\\.(%s)" % WORD, re.U)


def procedures(text):
	"""Procedure name -> its source. 1C does not nest them, so this is a flat scan."""
	found = {}
	lines = text.splitlines()
	index = 0
	while index < len(lines):
		match = PROC.match(lines[index])
		if not match:
			index += 1
			continue
		end = index + 1
		while end < len(lines) and not END.match(lines[end]):
			end += 1
		found[match.group(1)] = "\n".join(lines[index:end + 1])
		index = end + 1
	return found


def calls(body, name):
	"""Does `body` call `name`? A bare mention in a comment or a longer name is not one."""
	return bool(re.search(u"(?<![А-Яа-яёЁA-Za-z_0-9])%s[ \t]*\\(" % re.escape(name),
	                      body, re.U))


def scan():
	"""One row per document that has a posting handler."""
	rows = []
	for document in sorted(os.listdir(CODE)):
		directory = os.path.join(CODE, document)
		if not os.path.isdir(directory):
			continue
		for name in sorted(os.listdir(directory)):
			if not name.endswith(".bsl"):
				continue
			with io.open(os.path.join(directory, name), encoding="utf-8",
			             errors="replace") as handle:
				text = handle.read()
			if POST not in text:
				continue
			bodies = procedures(text)
			if POST not in bodies:
				continue

			direct = set(REGISTER.findall(bodies[POST]))
			via = {}
			for procedure, body in bodies.items():
				if procedure == POST or not REGISTER.search(body):
					continue
				if calls(bodies[POST], procedure):
					via[procedure] = sorted(set(REGISTER.findall(body)))

			outside = {}
			for hook in (ON_WRITE, BEFORE_WRITE):
				if hook in bodies and REGISTER.search(bodies[hook]):
					outside[hook] = sorted(set(REGISTER.findall(bodies[hook])))

			rows.append({
				"doc": document,
				"module": name,
				"postLines": len(bodies[POST].splitlines()),
				"direct": sorted(direct),
				"viaCalls": via,
				"outsidePosting": outside,
			})
			break
	return rows


def declared_registers():
	with codecs.open(os.path.join(paths.OUT, "objects_all.json"), "r", "utf-8") as handle:
		objects = json.load(handle)
	return set(o["name"] for o in objects
	           if o.get("family") in ("InfoRg", "AccumRg", "AccRg") and o.get("name"))


def classify(rows, registers):
	"""The client's documents, by whose registers they write."""
	out = []
	for row in rows:
		if not row["doc"].startswith(CLIENT):
			continue
		direct = set(row["direct"])
		via = set()
		for names in row["viaCalls"].values():
			via |= set(names)
		outside = set()
		for names in row["outsidePosting"].values():
			outside |= set(names)

		every = (direct | via | outside) & registers
		if not every:
			continue
		out.append({
			"doc": row["doc"],
			"postLines": row["postLines"],
			"client": sorted(n for n in every if n.startswith(CLIENT)),
			"vendor": sorted(n for n in every if not n.startswith(CLIENT)),
			"viaCalls": sorted((via & registers) - direct),
			"outsidePosting": sorted(outside & registers),
		})
	return out


def write_json(name, payload):
	path = os.path.join(paths.OUT, name)
	with codecs.open(path, "w", "utf-8") as handle:
		handle.write(json.dumps(payload, ensure_ascii=False, indent="\t", sort_keys=True))
	return path


def main():
	rows = scan()
	registers = declared_registers()
	client = classify(rows, registers)

	write_json("handlers.json", rows)
	write_json("handlers-client.json", client)

	print("registers the metadata declares:                   %d" % len(registers))
	print("documents with a posting handler:                  %d" % len(rows))
	print("  whose handler calls a procedure writing a register: %d"
	      % len([r for r in rows if r["viaCalls"]]))
	print("  writing movements outside posting as well:          %d"
	      % len([r for r in rows if r["outsidePosting"]]))

	pure = [r for r in client if not r["vendor"]]
	mixed = [r for r in client if r["vendor"] and r["client"]]
	vendor = [r for r in client if r["vendor"] and not r["client"]]
	print()
	print("the client's documents that write a register:      %d" % len(client))
	print("  only the client's own registers:                 %d" % len(pure))
	print("  mixed:                                           %d" % len(mixed))
	print("  only the vendor's:                               %d" % len(vendor))

	if "--client" not in sys.argv:
		return

	print()
	print("Ports one for one, shortest first:")
	for row in sorted(pure, key=lambda r: r["postLines"]):
		print("  %-54s %3d  %s"
		      % (row["doc"], row["postLines"], ", ".join(row["client"])))
		if row["viaCalls"]:
			print("  %-54s      via calls: %s" % ("", ", ".join(row["viaCalls"])))
		if row["outsidePosting"]:
			print("  %-54s      OUTSIDE POSTING: %s"
			      % ("", ", ".join(row["outsidePosting"])))


if __name__ == "__main__":
	main()
