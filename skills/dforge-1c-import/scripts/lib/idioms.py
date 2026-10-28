#!/usr/bin/env python
# -*- coding: utf-8 -*-
u"""What shapes the movements are written in, weighted by the rows 1C holds for each.

The generator that turns a document's posting into declarative bindings will be written
one idiom at a time, and it is worth knowing before writing any of it how far each idiom
goes. So every movement 1C recorded - a (document, register) pair, with its row count from
`recorded.json` - is traced to the write sites the call graph finds behind it
(`callgraph.py`), and each site is classified by its shape:

  row       `Запись = Набор.Добавить()` and the columns assigned one by one
  load      `Набор.Загрузить(Таблица)` - a whole table at once
  module    `Набор.мТаблицаДвижений = Таблица; Набор.ВыполнитьПриход()` - the register's
            own record-set module does the writing from a table the document prepared
  method    another method of the register's own record-set module
  write     only `Набор.Записать()` here; the set was filled some other way

and, for `load` and `module`, by where the table comes from:

  query     the result of a query (`Запрос.Выполнить().Выгрузить()`)
  section   a tabular section's `Выгрузить()` - the document's own lines
  copy      `Скопировать()` of another table
  built     `Новый ТаблицаЗначений`, filled by the code
  param     handed in by a caller
  function  returned by a call this does not follow

A pair written through sites of more than one shape is `mixed`. Its rows are counted once,
under `mixed`, so the percentages add up.

    python tools/1c.py idioms           # the table; writes out/idioms.json
"""
from __future__ import print_function

import codecs
import collections
import io
import json
import os
import sys

import bsl
import callgraph
import paths

TARGET = os.path.join(paths.OUT, "idioms.json")

ROW_OPS = frozenset(bsl.norm(x) for x in (u"Добавить", u"ДобавитьПриход", u"ДобавитьРасход",
                                          u"ДобавитьДвижение", u"Add"))
LOAD_OPS = frozenset(bsl.norm(x) for x in (u"Загрузить", u"Load"))
MODULE_OPS = frozenset(bsl.norm(x) for x in (u"ВыполнитьПриход", u"ВыполнитьРасход",
                                             u"ВыполнитьДвижения", u"ВыполнитьДвижениеПриход",
                                             u"ВыполнитьДвижениеРасход"))
WRITE_ONLY = frozenset(bsl.norm(x) for x in (u"Записать", u"Write"))

UNLOAD = bsl.norm(u"Выгрузить")
COPY = bsl.norm(u"Скопировать")
EXECUTE = bsl.norm(u"Выполнить")
FILL = bsl.norm(u"ЗаполнитьЗначения")
COLLAPSE = bsl.norm(u"Свернуть")
MOVEMENT_TABLE = bsl.norm(u"мТаблицаДвижений")
COLUMNS = bsl.norm(u"ВыгрузитьКолонки")
LOAD_BY_NAME = bsl.norm(u"ЗагрузитьВТаблицуЗначений")


def shape(op):
	if op in ROW_OPS:
		return "row"
	if op in LOAD_OPS:
		return "load"
	if op in MODULE_OPS:
		return "module"
	if op in WRITE_ONLY:
		return "write"
	return "method"


class Locator(object):
	"""Finds the method around a (module path, line) and reads what feeds a table."""

	def __init__(self, modules):
		self.by_path = dict((m.path, m) for m in modules)

	def method_at(self, path, line):
		module = self.by_path.get(path)
		if module is None:
			return None, None
		for method in module.methods.values():
			if method[6] <= line <= method[7]:
				return module, method
		return module, None

	@staticmethod
	def call_at(method, line, op):
		for st in bsl.statements(method[5]):
			if st[1] != line:
				continue
			for expr in bsl.expressions(st):
				for sub in bsl.subexpressions(expr):
					if sub[0] == "callx" and sub[1][0] == "member" and bsl.norm(sub[1][2]) == op:
						return sub
		return None

	@staticmethod
	def origin(method, expr, depth=0):
		"""Where a table expression comes from, read off the method's assignments."""
		if expr is None or depth > 3:
			return "function"
		if expr[0] == "callx":
			callee = expr[1]
			if callee[0] == "member":
				op = bsl.norm(callee[2])
				if op == UNLOAD:
					receiver = callee[1]
					inner = [s for s in bsl.subexpressions(receiver) if s[0] == "callx"
					         and s[1][0] == "member" and bsl.norm(s[1][2]) == EXECUTE]
					if inner:
						return "query"
					parts = bsl.dotted(receiver)
					if parts and any(u"запрос" in bsl.norm(p) or u"результат" in bsl.norm(p)
					                 or u"выборка" in bsl.norm(p) for p in parts):
						return "query"
					return "section"
				if op == COPY:
					return "copy"
				if op == COLUMNS:
					return "columns"
			return "function"
		if expr[0] == "new":
			return "built"
		if expr[0] == "name":
			name = bsl.norm(expr[1])
			if name in set(bsl.norm(p[0]) for p in method[3]):
				return "param"
			sources = [st[3] for st in bsl.statements(method[5])
			           if st[0] == "assign" and st[2][0] == "name" and bsl.norm(st[2][1]) == name]
			if not sources:
				return "function"
			kinds = set(Locator.origin(method, s, depth + 1) for s in sources)
			if "columns" in kinds:
				# УТП's own step: an empty table of the register's columns, filled by
				# column name from another table - which is the real source
				kinds.discard("columns")
				for st in bsl.statements(method[5]):
					for e in bsl.expressions(st):
						for sub in bsl.subexpressions(e):
							if sub[0] == "callx" and len(sub[2]) >= 2 and sub[2][1] is not None \
									and sub[2][1][0] == "name" and bsl.norm(sub[2][1][1]) == name:
								callee = sub[1]
								called = bsl.norm(callee[2] if callee[0] == "member"
								                  else callee[1] if callee[0] == "name" else u"")
								if called == LOAD_BY_NAME:
									kinds.add("columns<-" + Locator.origin(method, sub[2][0],
									                                       depth + 1))
				if not kinds:
					kinds.add("columns")
			return kinds.pop() if len(kinds) == 1 else "+".join(sorted(kinds))
		return "function"

	@staticmethod
	def treated(method, expr):
		"""Does the method fill a column from the header, or collapse, on this table?"""
		if expr is None or expr[0] != "name":
			return set()
		name = bsl.norm(expr[1])
		found = set()
		for st in bsl.statements(method[5]):
			for e in bsl.expressions(st):
				for sub in bsl.subexpressions(e):
					if sub[0] == "callx" and sub[1][0] == "member" and sub[1][1] == ("name", expr[1]) \
							or (sub[0] == "callx" and sub[1][0] == "member"
							    and sub[1][1][0] == "name" and bsl.norm(sub[1][1][1]) == name):
						op = bsl.norm(sub[1][2])
						if op == FILL:
							found.add("header-fill")
						elif op == COLLAPSE:
							found.add("collapse")
		return found

	def table_of(self, method, line, op):
		"""The table a `load` or `module` site writes from."""
		if op in LOAD_OPS:
			call = self.call_at(method, line, op)
			return call[2][0] if call is not None and call[2] else None
		# module: the table was handed over as `<set>.мТаблицаДвижений = <table>` - the
		# last such hand-over before the site; a method can write several sets in turn
		found = None
		for st in bsl.statements(method[5]):
			if st[0] == "assign" and st[2][0] == "member" \
					and bsl.norm(st[2][2]) == MOVEMENT_TABLE and st[1] <= line:
				if found is None or st[1] >= found[1]:
					found = st
		return found[3] if found is not None else None


def classify(graph, locator, sites):
	"""(shape label, detail counter) for one movement's write sites."""
	shapes = set()
	details = collections.Counter()
	for path, line, op in sites:
		kind = shape(op)
		shapes.add(kind)
		if kind in ("load", "module"):
			_, method = locator.method_at(path, line)
			if method is None:
				details[kind + ":unknown"] += 1
				continue
			table = locator.table_of(method, line, op)
			details[kind + ":" + locator.origin(method, table)] += 1
			for treatment in locator.treated(method, table):
				details[kind + "+" + treatment] += 1
	real = shapes - {"write"} or shapes
	label = real.pop() if len(real) == 1 else "mixed"
	return label, details


def main():
	out = codecs.getwriter("utf-8")(sys.stdout.buffer)
	modules, _ = callgraph.load()
	graph = callgraph.Graph(modules, callgraph.register_names())
	graph.run()
	documents = graph.document_writes(callgraph.subscriptions(modules),
	                                  callgraph.declared_movements())
	with io.open(os.path.join(paths.OUT, "recorded.json"), encoding="utf-8") as f:
		recorded = json.load(f)["documents"]
	locator = Locator(modules)

	by_shape = collections.defaultdict(lambda: [0, 0])       # label -> [pairs, rows]
	origins = collections.Counter()                          # detail -> rows
	pairs = []
	unreached = [0, 0]
	for document, registers in sorted(recorded.items()):
		for register, rows in sorted(registers.items()):
			key = bsl.norm(register)
			sites = set()
			for event in ("posting", "on-write", "before-write"):
				sites |= graph.document_sites.get((document, event, key), set())
			if not sites:
				unreached[0] += 1
				unreached[1] += rows
				pairs.append({"document": document, "register": register, "rows": rows,
				              "shape": "not reached"})
				continue
			label, details = classify(graph, locator, sites)
			by_shape[label][0] += 1
			by_shape[label][1] += rows
			for detail, n in details.items():
				origins[detail] += rows
			pairs.append({"document": document, "register": register, "rows": rows,
			              "shape": label, "sites": len(sites),
			              "details": dict(details)})
	total = sum(v[1] for v in by_shape.values()) + unreached[1]

	with codecs.open(TARGET, "w", "utf-8") as f:
		json.dump({"by_shape": by_shape, "origins": origins, "pairs": pairs}, f,
		          ensure_ascii=False, indent="\t")

	out.write(u"%d movements (document, register) holding %s rows\n\n"
	          % (len(pairs), "{:,}".format(total)))
	out.write(u"%-12s %6s %14s %6s\n" % (u"shape", u"pairs", u"rows", u"share"))
	for label, (n, rows) in sorted(by_shape.items(), key=lambda kv: -kv[1][1]):
		out.write(u"%-12s %6d %14s %5.1f%%\n" % (label, n, "{:,}".format(rows),
		                                          100.0 * rows / total))
	out.write(u"%-12s %6d %14s %5.1f%%\n\n" % (u"not reached", unreached[0],
	                                            "{:,}".format(unreached[1]),
	                                            100.0 * unreached[1] / total))
	out.write(u"table origins and treatments, by rows of the movements they feed:\n")
	for detail, rows in origins.most_common():
		out.write(u"  %-28s %14s\n" % (detail, "{:,}".format(rows)))
	out.write(u"\nwritten %s\n" % TARGET)


if __name__ == "__main__":
	main()
