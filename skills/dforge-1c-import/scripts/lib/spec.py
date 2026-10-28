#!/usr/bin/env python
# -*- coding: utf-8 -*-
u"""The behaviour spec: what each document's posting writes, read out of the code.

Reading and generating are two steps with a file between them (docs/task-vendor-logic.md
§3). This is the reading step. For every movement 1C actually recorded - a (document,
register) pair in `recorded.json` - it takes the write sites the call graph found behind
it and writes down, per site, the requirement:

  row    `Запись = Набор.Добавить()`: every column assigned to that record before the next
         `Добавить`, including analytics set through `УстановитьСубконто(Счет, Субконто,
         Вид, Значение)` and whole-record copies through `ЗаполнитьЗначенияСвойств`;
  table  a table handed to the set (`Загрузить`, or `мТаблицаДвижений` + `ВыполнитьПриход`):
         the columns filled from the header (`ЗаполнитьЗначения`), the collapse
         (`Свернуть`), the table it was copied from by column name, and where that one
         came from - followed one call up, to the query and the tables it reads.

Each entry also carries the conditions it sits under and the loop it runs in, because a
binding needs both: a condition becomes a filter or a computed column, a loop over a
tabular section is what "posts from lines" means.

Expressions are kept as compact text. They are the requirement as 1C stated it, for a person
and for the generator to read; none of it is meant to be run, and none of it goes into a
module (§8).

What the reader cannot place is listed in the summary, with counts, instead of dropped.

    python tools/1c.py spec                       # every document; out/behaviour/*.json
    python tools/1c.py spec ПриходныйКассовыйОрдер  # one document, printed
"""
from __future__ import print_function

import codecs
import collections
import io
import json
import os
import re
import sys

import bsl
import callgraph
import idioms
import paths

TARGET = os.path.join(paths.OUT, "behaviour")

SUBCONTO = bsl.norm(u"УстановитьСубконто")
ADD_MOVEMENT = bsl.norm(u"ДобавитьДвижение")
COPY_PROPS = bsl.norm(u"ЗаполнитьЗначенияСвойств")
TEXT = bsl.norm(u"Текст")
RECEIPT = frozenset(bsl.norm(x) for x in (u"ВыполнитьПриход", u"ДобавитьПриход",
                                          u"ВыполнитьДвижениеПриход"))
EXPENSE = frozenset(bsl.norm(x) for x in (u"ВыполнитьРасход", u"ДобавитьРасход",
                                          u"ВыполнитьДвижениеРасход"))
QUERY_SOURCE = re.compile(u"(?:ИЗ|FROM|СОЕДИНЕНИЕ|JOIN)\\s+((?:Документ|Справочник|"
                          u"РегистрНакопления|РегистрСведений|РегистрБухгалтерии|"
                          u"Document|Catalog|AccumulationRegister|InformationRegister)"
                          u"\\.[\\w.]+)", re.U | re.I)


def conditions(context):
	"""The conditions a statement sits under, as text, outermost first."""
	found = []
	for frame in context:
		if frame[0] != "if":
			continue
		for earlier in frame[2]:
			found.append(u"НЕ (%s)" % bsl.render(earlier))
		if frame[1] is not None:
			found.append(bsl.render(frame[1]))
	return found


def loop(context):
	"""The innermost loop around a statement, as text."""
	for frame in reversed(context):
		if frame[0] == "foreach":
			return u"Для каждого %s Из %s" % (frame[1], bsl.render(frame[2]))
		if frame[0] == "while":
			return u"Пока %s" % bsl.render(frame[1])
		if frame[0] == "for":
			return u"Для %s = %s По %s" % (frame[1], bsl.render(frame[2]), bsl.render(frame[3]))
	return None


def calls_on(expr, receiver):
	"""Calls `<receiver>.<method>(...)` anywhere inside an expression."""
	for sub in bsl.subexpressions(expr):
		if sub[0] == "callx" and sub[1][0] == "member" and sub[1][1][0] == "name" \
				and bsl.norm(sub[1][1][1]) == receiver:
			yield bsl.norm(sub[1][2]), sub


def named_call(sub, name):
	callee = sub[1]
	if callee[0] == "name":
		return bsl.norm(callee[1]) == name
	return callee[0] == "member" and bsl.norm(callee[2]) == name


class Reader(object):

	def __init__(self, modules):
		self.locator = idioms.Locator(modules)
		self.recordsets = dict((bsl.norm(m.object), m) for m in modules if m.kind == "recordset")
		self.missing = collections.Counter()

	# -- row by row ---------------------------------------------------------------------

	def row(self, method, line, op):
		"""The record added at `line` and every column set on it before the next add."""
		statements = list(bsl.walk(method[5]))
		if op == ADD_MOVEMENT:
			return self.set_properties(statements, line)
		start = None
		record = None
		for index, (st, context) in enumerate(statements):
			if st[1] == line and st[0] == "assign" and st[2][0] == "name":
				for sub in bsl.subexpressions(st[3]):
					# `Набор.Добавить()`, or a bare `Добавить()` inside the set's own module
					if sub[0] == "callx" and named_call(sub, op):
						start, record = index, bsl.norm(st[2][1])
						break
			if start is not None:
				break
		if start is None:
			self.missing["row: record variable not found"] += 1
			return None
		entry = self.row_from(statements, start, record)
		if op in RECEIPT:
			entry["kind"] = "receipt"
		elif op in EXPENSE:
			entry["kind"] = "expense"
		return entry, statements[start][1]

	def set_properties(self, statements, line):
		"""`Набор.Колонка = …; Набор.ДобавитьДвижение()` - the 7.7-style call adds one
		record from the values set on the set itself since its previous add."""
		site = None
		for index, (st, context) in enumerate(statements):
			if st[1] == line and st[0] == "call" and st[2][1][0] == "member" \
					and bsl.norm(st[2][1][2]) == ADD_MOVEMENT:
				site = index
				break
		if site is None:
			self.missing["row: ДобавитьДвижение call not found"] += 1
			return None
		receiver = bsl.render(statements[site][0][2][1][1])
		site_context = statements[site][1]
		begin = 0
		for i in range(site - 1, -1, -1):
			st = statements[i][0]
			if st[0] == "call" and st[2][1][0] == "member" \
					and bsl.norm(st[2][1][2]) == ADD_MOVEMENT \
					and bsl.render(st[2][1][1]) == receiver:
				begin = i + 1
				break
		columns = collections.OrderedDict()
		for st, context in statements[begin:site]:
			if st[0] == "assign" and st[2][0] == "member" and bsl.render(st[2][1]) == receiver:
				extra = conditions(context[len(site_context):]) \
					if context[:len(site_context)] == site_context else conditions(context)
				self._column(columns, st[2][2], st[3], extra)
		return {"shape": "row", "columns": columns, "via": "set properties"}, site_context

	def row_from(self, statements, start, record, stop=None):
		"""The columns set on `record` after statements[start], until it is reassigned."""
		site_context = statements[start][1]
		columns = collections.OrderedDict()
		copies = []
		for st, context in statements[start + 1:stop]:
			if st[0] == "assign" and st[2][0] == "name" and bsl.norm(st[2][1]) == record:
				break                                    # the next record
			extra = conditions(context[len(site_context):])
			if st[0] == "assign" and st[2][0] == "member" and st[2][1][0] == "name" \
					and bsl.norm(st[2][1][1]) == record:
				self._column(columns, st[2][2], st[3], extra)
				continue
			for expr in bsl.expressions(st):
				for sub in bsl.subexpressions(expr):
					if sub[0] != "callx":
						continue
					args = sub[2]
					if named_call(sub, SUBCONTO) and len(args) >= 4 and args[1] is not None \
							and args[1][0] == "member" and args[1][1][0] == "name" \
							and bsl.norm(args[1][1][1]) == record:
						self._column(columns, u"%s[%s]" % (args[1][2], bsl.render(args[2])),
						             args[3], extra)
					elif named_call(sub, COPY_PROPS) and args and args[0] is not None \
							and args[0][0] == "name" and bsl.norm(args[0][1]) == record:
						copies.append({"from": bsl.render(args[1]) if len(args) > 1 else u"",
						               "only": bsl.render(args[2]) if len(args) > 2 else None,
						               "when": extra or None})
		entry = {"shape": "row", "columns": columns}
		if copies:
			entry["copies"] = copies
		return entry

	@staticmethod
	def _column(columns, name, expr, extra):
		value = {"value": bsl.render(expr)}
		if extra:
			value["when"] = extra
		columns.setdefault(name, []).append(value)

	# -- a table at once ----------------------------------------------------------------

	def table(self, module, method, line, op):
		table = self.locator.table_of(method, line, op)
		entry = {"shape": "table"}
		if op in RECEIPT:
			entry["kind"] = "receipt"
		elif op in EXPENSE:
			entry["kind"] = "expense"
		if table is None:
			self.missing["table: no table found"] += 1
			return entry
		entry["table"] = bsl.render(table)
		if table[0] != "name":
			entry["source"] = self.source(module, method, table)
			return entry
		name = bsl.norm(table[1])
		statements = list(bsl.walk(method[5]))
		site = next((i for i, (st, _) in enumerate(statements) if st[1] >= line), len(statements))
		begin = 0
		for i in range(site - 1, -1, -1):
			st = statements[i][0]
			if st[0] == "assign" and st[2][0] == "name" and bsl.norm(st[2][1]) == name:
				begin = i
				break
		window = statements[begin:site]
		fills = collections.OrderedDict()
		per_line = collections.OrderedDict()
		rows = []
		for offset, (st, context) in enumerate(window):
			# a line added to the table and filled column by column
			if st[0] == "assign" and st[2][0] == "name":
				for called, sub in calls_on(st[3], name):
					if called in idioms.ROW_OPS:
						rows.append(self.row_from(statements, begin + offset,
						                          bsl.norm(st[2][1]), stop=site))
			for expr in bsl.expressions(st):
				for called, sub in calls_on(expr, name):
					args = sub[2]
					if called == idioms.FILL and len(args) >= 2 and args[1] is not None 							and args[1][0] == "lit":
						fill = {"value": bsl.render(args[0])}
						if conditions(context):
							fill["when"] = conditions(context)
						fills.setdefault(args[1][1], []).append(fill)
					elif called == idioms.COLLAPSE:
						entry["collapse"] = {
							"by": bsl.render(args[0]) if args else u"",
							"sum": bsl.render(args[1]) if len(args) > 1 else u""}
				for sub in bsl.subexpressions(expr):
					if sub[0] == "callx" and named_call(sub, idioms.LOAD_BY_NAME) 							and len(sub[2]) >= 2 and sub[2][1] is not None 							and sub[2][1][0] == "name" and bsl.norm(sub[2][1][1]) == name:
						entry.setdefault("from", []).append(
							self.source(module, method, sub[2][0]))
			# a loop over the table setting a column on each line
			if st[0] == "assign" and st[2][0] == "member" and st[2][1][0] == "name":
				for frame in context:
					if frame[0] == "foreach" and bsl.norm(st[2][1][1]) == bsl.norm(frame[1]) 							and frame[2][0] == "name" and bsl.norm(frame[2][1]) == name:
						per_line.setdefault(st[2][2], []).append({"value": bsl.render(st[3])})
		if rows:
			entry["rows"] = rows
		if fills:
			entry["header"] = fills
		if per_line:
			entry["per_line"] = per_line
		if "from" not in entry and not rows:
			entry["from"] = [self.source(module, method, table)]
		return entry

	def source(self, module, method, expr, up=True):
		"""Where a table comes from: its origin, and for a query the tables it reads;
		for a parameter, the same one call up, in the callers inside the module."""
		origin = self.locator.origin(method, expr)
		found = {"expr": bsl.render(expr), "origin": origin}
		if "query" in origin:
			tables = self.query_tables(method)
			if tables:
				found["reads"] = tables
		if origin == "param" and up and expr is not None and expr[0] == "name":
			index = [bsl.norm(p[0]) for p in method[3]].index(bsl.norm(expr[1]))
			callers = []
			for other in module.methods.values():
				for st in bsl.statements(other[5]):
					for e in bsl.expressions(st):
						for sub in bsl.subexpressions(e):
							if sub[0] == "callx" and sub[1][0] == "name" \
									and bsl.norm(sub[1][1]) == bsl.norm(method[1]) \
									and len(sub[2]) > index:
								callers.append(dict(self.source(module, other, sub[2][index],
								                                up=False),
								                    caller=other[1]))
			if callers:
				found["callers"] = callers
			else:
				self.missing["source: parameter with no caller in the module"] += 1
		return found

	@staticmethod
	def query_tables(method):
		"""The tables named in the query texts this method sets."""
		tables = []
		for st in bsl.statements(method[5]):
			if st[0] == "assign" and st[2][0] == "member" and bsl.norm(st[2][2]) == TEXT:
				for sub in bsl.subexpressions(st[3]):
					if sub[0] == "lit" and isinstance(sub[1], type(u"")):
						for match in QUERY_SOURCE.findall(sub[1]):
							if match not in tables:
								tables.append(match)
		return tables

	# -- one site -----------------------------------------------------------------------

	def site(self, path, line, op, register=None):
		module, method = self.locator.method_at(path, line)
		if method is None:
			self.missing["site: method not found"] += 1
			return None
		kind = idioms.shape(op)
		own = self.recordsets.get(bsl.norm(register)) if register else None
		if own is not None and op in own.methods and kind != "load":
			# the register's own module defines this method; УТП's write from the table
			# handed over in `мТаблицаДвижений`
			kind = "module"
		where = {"site": u"%s:%d" % (path, line), "in": u"%s.%s" % (module.object, method[1])}
		if kind == "row":
			found = self.row(method, line, op)
			if found is None:
				return dict(where, shape="row", unread=True)
			entry, context = found
		elif kind in ("load", "module"):
			entry = self.table(module, method, line, op)
			context = self._context_at(method, line)
		else:
			return None                                  # `Записать` alone, or a set method
		entry.update(where)
		guards = conditions(context)
		if guards:
			entry["when"] = guards
		around = loop(context)
		if around:
			entry["loop"] = around
		return entry

	@staticmethod
	def _context_at(method, line):
		for st, context in bsl.walk(method[5]):
			if st[1] == line:
				return context
		return ()


def main():
	args = sys.argv[1:]
	out = codecs.getwriter("utf-8")(sys.stdout.buffer)
	modules, _ = callgraph.load()
	graph = callgraph.Graph(modules, callgraph.register_names())
	graph.run()
	graph.document_writes(callgraph.subscriptions(modules), callgraph.declared_movements())
	with io.open(os.path.join(paths.OUT, "recorded.json"), encoding="utf-8") as f:
		recorded = json.load(f)["documents"]
	reader = Reader(modules)

	if not os.path.isdir(TARGET):
		os.makedirs(TARGET)
	shapes = collections.Counter()
	written = 0
	for document in sorted(recorded):
		if args and document != args[0]:
			continue
		movements = collections.OrderedDict()
		for register, rows in sorted(recorded[document].items()):
			key = bsl.norm(register)
			entries = []
			for event in ("posting", "on-write", "before-write"):
				for path, line, op in sorted(graph.document_sites.get((document, event, key),
				                                                      ())):
					entry = reader.site(path, line, op, register)
					if entry is not None:
						entry["event"] = event
						entries.append(entry)
						shapes[entry.get("shape")] += 1
			movements[register] = {"rows_in_1c": rows, "writes": entries}
		spec = {"document": document, "movements": movements}
		with codecs.open(os.path.join(TARGET, document + ".json"), "w", "utf-8") as f:
			json.dump(spec, f, ensure_ascii=False, indent="\t")
		written += 1
		if args:
			out.write(json.dumps(spec, ensure_ascii=False, indent=2))
			out.write(u"\n")
	out.write(u"%d documents, %s entries; unread: %s\n" % (
		written, dict(shapes), dict(reader.missing) or u"none"))
	out.write(u"written %s\n" % TARGET)


if __name__ == "__main__":
	main()
