#!/usr/bin/env python
# -*- coding: utf-8 -*-
u"""Which registers each document writes, followed through every module.

`handlers.py` finds `Движения.<name>` by text and follows calls one level, inside the
document's own module. In the vendor configuration that misses most of it: the set is taken
into a variable (`ПроводкиБУ = Движения.Хозрасчетный`), the variable is handed to a common
module (`БухгалтерскийУчет.ПереоценкаСчетаРегл(..., ПроводкиБУ, ...)`), and the row is added
three calls away. Or the document object itself goes (`УправлениеЗапасами.X(ЭтотОбъект)`)
and the callee reaches `ДокументОбъект.Движения.<name>`.

So this parses every module (`bsl.py`) and follows VALUES, not text. A value of interest is
a path from a root - the document itself, or a method's parameter - such as
`this.Движения.Хозрасчетный`. Each method gets a summary: the paths it writes through,
in terms of its own parameters. A call site maps the callee's summary through its
arguments, and the whole thing iterates until no summary grows. Recursion converges
because summaries only grow and are finite.

What counts as a write: one of `WRITE_OPS` called on a register set. Reading a set (a
query, `Выгрузить`) is not one, and neither is clearing it - the platform clears movements
on its own.

Reported, not dropped:
  * calls that cannot be resolved (a method on a value of unknown type, `Выполнить`)
    are counted per kind - that count is the call graph's own blind spot;
  * a register name that the metadata does not have is listed rather than counted.

    python tools/1c.py callgraph                    # summary; writes out/callgraph.json
    python tools/1c.py callgraph <Document>         # one document, with the call chains
"""
from __future__ import print_function

import codecs
import collections
import io
import json
import os
import sys

import bsl
import handlers
import paths

CODE = os.path.join(paths.OUT, "code")
TARGET = os.path.join(paths.OUT, "callgraph.json")

# 1C's own metadata class GUIDs - the platform's, not this infobase's.
COMMON_MODULE_CLASS = "class_0fe48980"
SUBSCRIPTION_CLASS = "4e828da6-0f44-4b5b-b1c0-a2b3cfe7bdcc"

# The document events a handler can write movements from, and what each one means.
EVENTS = {
	u"обработкапроведения": "posting",
	u"обработкаудаленияпроведения": "unposting",
	u"призаписи": "on-write",
	u"передзаписью": "before-write",
}

# Methods of a register record set that put rows into it.
WRITE_OPS = frozenset(bsl.norm(x) for x in (
	u"Добавить", u"Загрузить", u"Записать", u"ВыполнитьПриход", u"ВыполнитьРасход",
	u"ВыполнитьДвижения", u"ДобавитьПриход", u"ДобавитьРасход", u"ДобавитьДвижение",
	u"ВыполнитьДвижениеПриход", u"ВыполнитьДвижениеРасход",
	u"Add", u"Load", u"Write"))

MOVEMENTS = (u"движения", u"registerrecords")
THIS = (u"этотобъект", u"thisobject")
MANAGERS = {u"документы": "Document", u"documents": "Document",
            u"справочники": "Reference", u"catalogs": "Reference",
            u"обработки": "DataProcessor", u"отчеты": "Report",
            u"регистрынакопления": "AccumRg", u"регистрысведений": "InfoRg",
            u"регистрыбухгалтерии": "AccRg"}

REGISTER_MANAGERS = frozenset(bsl.norm(x) for x in (
	u"РегистрыНакопления", u"РегистрыСведений", u"РегистрыБухгалтерии", u"РегистрыРасчета",
	u"AccumulationRegisters", u"InformationRegisters", u"AccountingRegisters"))
INSERT = frozenset((bsl.norm(u"Вставить"), u"insert"))
CREATE_SET = frozenset(bsl.norm(x) for x in (u"СоздатьНаборЗаписей", u"CreateRecordSet"))

MAX_PATH = 3


# -- loading ----------------------------------------------------------------------------

class Module(object):
	"""One parsed module: which object it belongs to and what kind it is."""

	def __init__(self, family, obj, kind, path, tree, guid=None):
		self.family, self.object, self.kind, self.path = family, obj, kind, path
		self.guid = guid
		self.methods = {}
		self.variables = set()
		_, variables, methods, _body = tree
		for v in variables:
			for name in v[2]:
				self.variables.add(bsl.norm(name))
		for m in methods:
			self.methods[bsl.norm(m[1])] = m

	@property
	def key(self):
		return u"%s.%s.%s" % (self.family, self.object, self.kind)


def _kind(entry, owner_guid):
	"""object / manager / recordset / form, from the container's place in its object."""
	own = entry["guid"] == owner_guid
	suffix = entry["container"].rsplit(".", 1)[-1]
	if entry["family"] == COMMON_MODULE_CLASS:
		return "common"
	if not own:
		return "form"
	return {"0": "object", "1": "recordset", "2": "manager"}.get(suffix, "other" + suffix)


def load(verbose=True):
	with io.open(os.path.join(CODE, "index.json"), encoding="utf-8") as f:
		index = json.load(f)
	with io.open(os.path.join(paths.OUT, "objects.json"), encoding="utf-8") as f:
		owners = dict(((o["family"], o["name"]), o["guid"]) for o in json.load(f))
	modules, failures = [], []
	for entry in index:
		path = os.path.join(paths.OUT, entry["path"])
		with io.open(path, encoding="utf-8-sig") as f:
			text = f.read()
		if text.lstrip().startswith("{"):        # a form layout saved beside the code
			continue
		owner = owners.get((entry["family"], entry["object"]))
		kind = _kind(entry, owner)
		tree, errors = bsl.parse(text)
		for error in errors:
			failures.append((entry["path"], str(error)))
		modules.append(Module(entry["family"], entry["object"], kind, entry["path"], tree,
		                      entry["guid"]))
	if verbose:
		sys.stderr.write("[i] %d modules parsed, %d methods failed to parse\n"
		                 % (len(modules), len(failures)))
	return modules, failures


def register_names():
	"""Every register the metadata declares, by case-folded name -> (family, name)."""
	with io.open(os.path.join(paths.OUT, "objects.json"), encoding="utf-8") as f:
		objects = json.load(f)
	return dict((bsl.norm(o["name"]), (o["family"], o["name"])) for o in objects
	            if o.get("family") in ("AccumRg", "InfoRg", "AccRg", "CRg"))


# -- the analysis -----------------------------------------------------------------------

class Graph(object):

	def __init__(self, modules, registers):
		self.registers = registers
		self.modules = modules
		self.common = {}
		self.by_object = {}
		self.by_guid = dict((m.guid, m) for m in modules if m.kind == "common")
		self.recordsets = dict((bsl.norm(m.object), m) for m in modules if m.kind == "recordset")
		for m in modules:
			if m.kind == "common":
				self.common[bsl.norm(m.object)] = m
			self.by_object[(m.family, bsl.norm(m.object), m.kind)] = m
		# a common-module method called without its module name: the module is global
		exported = collections.defaultdict(list)
		for m in self.common.values():
			for name, method in m.methods.items():
				if method[4]:
					exported[name].append(m)
		self.global_methods = dict((n, ms[0]) for n, ms in exported.items() if len(ms) == 1)
		# summaries: (module key, method) -> {written path: witness}
		self.summary = collections.defaultdict(dict)
		# beside each summary path, every write site behind it: (module path, line, op)
		self.sites = collections.defaultdict(dict)
		self.module_env = collections.defaultdict(lambda: collections.defaultdict(set))
		self.module_changes = 0
		# a created set kept in a structure field, by field name: УТП builds a structure of
		# record sets in one function and writes them in another
		self.fields = collections.defaultdict(set)
		self.undeclared = {}
		# (document, event, register) -> every write site behind that movement
		self.document_sites = {}
		self.unresolved = collections.Counter()
		self.foreign_ops = collections.Counter()

	# A path is (root, tuple of case-folded member names). root is "this" or ("param", i).

	def register_of(self, path):
		"""The register a path names, if it names one: (..., 'движения', X)."""
		names = path[1]
		if len(names) >= 2 and names[-2] in MOVEMENTS:
			return names[-1]
		return None

	def resolve(self, module, callee, env):
		"""(target module, method) for a call's callee expression, or a reason it has none."""
		if callee[0] == "name":
			name = bsl.norm(callee[1])
			if name in module.methods:
				return module, module.methods[name]
			if name in self.global_methods:
				target = self.global_methods[name]
				return target, target.methods[name]
			return "unknown-global"
		if callee[0] != "member":
			return "computed"
		name = bsl.norm(callee[2])
		parts = bsl.dotted(callee[1])
		if parts is None:
			return "method-of-expression"
		head = bsl.norm(parts[0])
		if len(parts) == 1:
			if head in THIS:
				return (module, module.methods[name]) if name in module.methods else "this-unknown"
			if head in env:
				return "method-of-variable"
			target = self.common.get(head)
			if target is not None:
				if name in target.methods:
					return target, target.methods[name]
				return "common-missing"
			return "method-of-variable"
		if len(parts) == 2 and head in MANAGERS:
			target = self.by_object.get((MANAGERS[head], bsl.norm(parts[1]), "manager"))
			if target is not None and name in target.methods:
				return target, target.methods[name]
			return "manager-missing"
		return "method-of-expression"

	def evaluate(self, module, expr, env):
		"""The set of paths an expression may denote."""
		kind = expr[0]
		if kind == "name":
			name = bsl.norm(expr[1])
			if name in module.variables:
				return env.get(name, set()) | self.module_env[module.key].get(name, set())
			if name in env:
				return env[name]
			if name in THIS and module.kind == "object":
				return {("this", ())}
			if name in THIS and module.kind == "recordset":
				return {("this", (MOVEMENTS[0], bsl.norm(module.object)))}
			if name in MOVEMENTS and module.kind == "object":
				return {("this", (name,))}
			return set()
		if kind == "member":
			found = set()
			member = bsl.norm(expr[2])
			for root, names in self.evaluate(module, expr[1], env):
				if root != "str" and len(names) < MAX_PATH:
					found.add((root, names + (member,)))
			found.update(self.fields.get(member, ()))
			return found
		if kind == "lit":
			if isinstance(expr[1], type(u"")) and expr[1] and len(expr[1]) < 80:
				return {("str", bsl.norm(expr[1]))}
			return set()
		if kind == "index":
			keys = [v[1] for v in self.evaluate(module, expr[2], env) if v[0] == "str"]
			if not keys:
				return set()
			parts = bsl.dotted(expr[1])
			if parts and len(parts) == 1 and bsl.norm(parts[0]) in REGISTER_MANAGERS:
				return set(("manager", (k,)) for k in keys)
			found = set()
			for root, names in self.evaluate(module, expr[1], env):
				if root != "str" and len(names) < MAX_PATH:
					found.update((root, names + (k,)) for k in keys)
			return found
		if kind == "callx":
			return self.created_set(module, expr, env)
		if kind == "tern":
			return self.evaluate(module, expr[2], env) | self.evaluate(module, expr[3], env)
		return set()

	@staticmethod
	def put(writes, sites, path, witness, new_sites):
		"""Record a write: the first witness found for a path, and every site behind it."""
		writes.setdefault(path, witness)
		sites.setdefault(path, set()).update(new_sites)

	def recordset_method(self, module, path, op, writes, sites, line):
		"""`Набор.Расход()` where `Расход` is a method of the register's own record-set
		module: what it writes through its own set lands on the set the caller holds."""
		register = self.register_of(path)
		rs = self.recordsets.get(register) if register else None
		if rs is None or op not in rs.methods:
			return
		key = (rs.key, op)
		summary = self.summary.get(key)
		if not summary:
			return
		callee_sites = self.sites.get(key, {})
		root, names = path
		prefix = names[:-2]
		step = u"%s:%d -> record set %s.%s" % (module.path, line, rs.object, rs.methods[op][1])
		for spath, witness in summary.items():
			sroot, snames = spath
			if sroot == "ctx":
				target = spath
			elif sroot == "this" and len(prefix + snames) <= MAX_PATH:
				target = (root, prefix + snames)
			else:
				continue
			self.put(writes, sites, target, (step,) + witness, callee_sites.get(spath, ()))

	@staticmethod
	def is_insert(call):
		"""`Х.Вставить("Имя", Значение)`: a structure field set by name."""
		if call[0] != "callx" or call[1][0] != "member" or bsl.norm(call[1][2]) not in INSERT:
			return False
		args = call[2]
		return (len(args) >= 2 and args[0] is not None and args[0][0] == "lit"
		        and isinstance(args[0][1], type(u"")) and args[1] is not None)

	def keep_field(self, field, values):
		for value in values:
			if value[0] == "ctx" and value not in self.fields[field]:
				self.fields[field].add(value)
				self.module_changes += 1

	def created_set(self, module, call, env):
		"""`РегистрыНакопления.X.СоздатьНаборЗаписей()`: a set written under the context's
		document. Rooted at "ctx" so it travels up through every caller."""
		callee = call[1]
		if callee[0] != "member" or bsl.norm(callee[2]) not in CREATE_SET:
			return set()
		owner = callee[1]
		parts = bsl.dotted(owner)
		if parts and len(parts) == 2 and bsl.norm(parts[0]) in REGISTER_MANAGERS:
			return {("ctx", (MOVEMENTS[0], bsl.norm(parts[1])))}
		found = set()
		for root, names in self.evaluate(module, owner, env):
			if root == "manager":
				found.add(("ctx", (MOVEMENTS[0],) + names))
		return found

	def analyse(self, module, method):
		"""One pass over a method: its writes, as paths from its own roots."""
		key = (module.key, bsl.norm(method[1]))
		params = method[3]
		env = {}
		for i, (pname, _, _) in enumerate(params):
			env[bsl.norm(pname)] = {(("param", i), ())}
		writes = {}
		body = method[5]
		# flow-insensitive: two passes let a value assigned late reach a use above it in a loop
		for _ in range(2):
			for st in bsl.statements(body):
				if st[0] == "assign" and st[2][0] == "name":
					target = bsl.norm(st[2][1])
					values = self.evaluate(module, st[3], env)
					if values:
						env.setdefault(target, set()).update(values)
				elif st[0] == "assign" and st[2][0] == "member":
					self.keep_field(bsl.norm(st[2][2]), self.evaluate(module, st[3], env))
				elif st[0] == "foreach":
					values = self.evaluate(module, st[3], env)
					if values:
						env.setdefault(bsl.norm(st[2]), set()).update(values)
				if st[0] in ("assign", "call"):
					for expr in bsl.expressions(st):
						for sub in bsl.subexpressions(expr):
							if self.is_insert(sub):
								self.keep_field(bsl.norm(sub[2][0][1]),
								                self.evaluate(module, sub[2][1], env))
		# a module variable assigned here is seen by every method of the module; a value
		# rooted in this method's parameters means nothing outside it, so it stays local
		shared = self.module_env[module.key]
		param_names = set(bsl.norm(p[0]) for p in params)
		for name in module.variables:
			if name in env and name not in param_names:
				for value in env[name]:
					if not isinstance(value[0], tuple) and value not in shared[name]:
						shared[name].add(value)
						self.module_changes += 1
		sites = {}
		for st in bsl.statements(body):
			for expr in bsl.expressions(st):
				for sub in bsl.subexpressions(expr):
					if sub[0] == "callx":
						self.call(module, sub, env, writes, sites, st[1])
		return key, writes, sites

	def call(self, module, call, env, writes, sites, line):
		callee, args = call[1], call[2]
		# an operation on a value we follow
		if callee[0] == "member":
			op = bsl.norm(callee[2])
			for path in self.evaluate(module, callee[1], env):
				if path[0] in ("str", "manager"):
					continue
				if op in WRITE_OPS:
					self.put(writes, sites, path,
					         (u"%s:%d %s" % (module.path, line, callee[2]),),
					         ((module.path, line, op),))
					continue
				self.recordset_method(module, path, op, writes, sites, line)
		elif (callee[0] == "name" and module.kind == "recordset"
		      and bsl.norm(callee[1]) in WRITE_OPS and bsl.norm(callee[1]) not in module.methods):
			# `Добавить()` inside a record-set module adds to the set itself
			self.put(writes, sites, ("this", (MOVEMENTS[0], bsl.norm(module.object))),
			         (u"%s:%d %s" % (module.path, line, callee[1]),),
			         ((module.path, line, bsl.norm(callee[1])),))
		target = self.resolve(module, callee, env)
		if not isinstance(target, tuple):
			self.unresolved[target] += 1
			return
		tmodule, tmethod = target
		key = (tmodule.key, bsl.norm(tmethod[1]))
		summary = self.summary.get(key)
		if not summary:
			return
		callee_sites = self.sites.get(key, {})
		step = u"%s:%d -> %s.%s" % (module.path, line, tmodule.object, tmethod[1])
		arg_values = [self.evaluate(module, a, env) if a is not None else set() for a in args]
		for spath, witness in summary.items():
			root, names = spath
			behind = callee_sites.get(spath, ())
			if root == "ctx":
				self.put(writes, sites, spath, (step,) + witness, behind)
				continue
			if root == "this":
				# the callee's own object: the same object when it is this module's method
				if tmodule is module:
					self.put(writes, sites, spath, witness, behind)
				continue
			index = root[1]
			if index >= len(arg_values):
				continue
			for aroot, anames in arg_values[index]:
				if aroot in ("str", "manager"):
					continue
				joined = anames + names
				if len(joined) <= MAX_PATH:
					self.put(writes, sites, (aroot, joined), (step,) + witness, behind)

	def run(self, verbose=True):
		methods = [(m, method) for m in self.modules for method in m.methods.values()]
		rounds = 0
		while True:
			rounds += 1
			self.unresolved = collections.Counter()
			self.module_changes = 0
			changed = 0
			for module, method in methods:
				key, writes, sites = self.analyse(module, method)
				current = self.summary[key]
				for path, witness in writes.items():
					if path not in current:
						current[path] = witness
						changed += 1
				known = self.sites[key]
				for path, found in sites.items():
					have = known.setdefault(path, set())
					if not found <= have:
						have.update(found)
						changed += 1
			if verbose:
				sys.stderr.write("[i] round %d: %d new paths\n" % (rounds, changed))
			changed += self.module_changes
			if not changed:
				return rounds

	def _handler_writes(self, module, method, base):
		"""What one handler writes, with its first parameter (or its own object) at `base`.

		`base` is the path the handler's object stands for in the document's terms: () for
		the document itself, ('движения', R) for the record set of register R."""
		found = {}
		key = (module.key, bsl.norm(method[1]))
		sites = self.sites.get(key, {})
		for (root, names), witness in self.summary.get(key, {}).items():
			if root == "ctx":
				path = names
			elif root == "this" and module.kind in ("object", "recordset"):
				path = names
			elif root == ("param", 0) and module.kind == "common":
				path = base + names
			else:
				continue
			register = self.register_of(("this", path))
			if register is not None:
				entry = found.setdefault(register, (witness, set()))
				entry[1].update(sites.get((root, names), ()))
		return found

	def document_writes(self, subscriptions, declared=None):
		"""Document -> event -> register -> the shortest call chain that writes it.

		Beyond the document's own handlers: the subscriptions on the document's event, and,
		for every register written, that register's record-set module and the subscriptions
		on its write - which can write further registers, so this runs to a closure."""
		recordsets = dict((bsl.norm(m.object), m) for m in self.modules if m.kind == "recordset")
		result = {}
		# every document, not only those with an object module: one that posts purely
		# through subscriptions has none
		with io.open(os.path.join(paths.OUT, "objects.json"), encoding="utf-8") as f:
			names = sorted(o["name"] for o in json.load(f) if o.get("family") == "Document")
		for name in names:
			m = self.by_object.get(("Document", bsl.norm(name), "object"))
			events = {}
			for event_key, event in EVENTS.items():
				found = {}
				behind = collections.defaultdict(set)

				def add(writes, prefix):
					for register, (witness, sites) in writes.items():
						behind[register].update(sites)
						chain = prefix + tuple(witness)
						best = found.get(register)
						if best is None or len(chain) < len(best):
							found[register] = chain

				if m is not None and event_key in m.methods:
					add(self._handler_writes(m, m.methods[event_key], ()), ())
				for sub in subscriptions.get((bsl.norm(name), event_key), []):
					target = self._subscription_target(sub)
					if target:
						add(self._handler_writes(target[0], target[1], ()),
						    (u"subscription %s" % sub["name"],))
				# a written register fires its own write events
				done = set()
				while True:
					pending = [r for r in found if r not in done]
					if not pending:
						break
					for register in pending:
						done.add(register)
						base = (MOVEMENTS[0], register)
						via = found[register]
						rs = recordsets.get(register)
						for trigger in (u"передзаписью", u"призаписи"):
							if rs is not None and trigger in rs.methods:
								add(self._handler_writes(rs, rs.methods[trigger], base),
								    via + (u"record set %s %s" % (rs.object, trigger),))
							for sub in subscriptions.get((register, trigger), []):
								target = self._subscription_target(sub)
								if target:
									add(self._handler_writes(target[0], target[1], base),
									    via + (u"subscription %s" % sub["name"],))
				allowed = declared.get(bsl.norm(name)) if declared is not None else None
				if allowed is not None:
					for register in list(found):
						if register not in allowed:
							self.undeclared[(name, register)] = found.pop(register)
				if found:
					events[event] = found
					for register in found:
						self.document_sites[(name, event, register)] = behind[register]
			result[name] = events
		return result

	def _subscription_target(self, sub):
		module = self.by_guid.get(sub["module"])
		if module is None:
			return None
		method = module.methods.get(bsl.norm(sub["handler"]))
		return (module, method) if method else None


def declared_movements():
	"""Document -> the registers its metadata lets it record into, case-folded.

	1C refuses a movement into a register the document does not list, whichever way the
	set was reached, so this bounds what the code can write. It matters for handlers that
	serve every document and guard with `Метаданные().Движения.Содержит(...)`: the guard
	is the platform's own rule, and without it every document would reach every register
	such a handler names."""
	import re
	config = os.path.join(paths.OUT, "config")
	with io.open(os.path.join(paths.OUT, "objects_all.json"), encoding="utf-8") as f:
		objects = json.load(f)
	registers = dict((o["guid"], bsl.norm(o["name"])) for o in objects
	                 if o.get("family") in ("AccumRg", "InfoRg", "AccRg", "CRg"))
	reference = re.compile(r'\{"#",157fa490-4ce9-11d4-9415-008048da11f9,\s*\{1,([0-9a-f-]{36})\}')
	found = {}
	for obj in objects:
		if obj.get("family") != "Document":
			continue
		path = os.path.join(config, obj["guid"] + ".txt")
		if not os.path.exists(path):
			continue
		with io.open(path, encoding="utf-8-sig") as f:
			text = f.read()
		found[bsl.norm(obj["name"])] = set(registers[g] for g in reference.findall(text)
		                                   if g in registers)
	return found


def subscriptions(modules):
	"""(source object, event) -> subscriptions, read from the configuration's definitions.

	A subscription names its sources by TYPE guid; every object lists its own type guids at
	the head of its definition, which is how a source maps back to an object."""
	import re
	config = os.path.join(paths.OUT, "config")
	with io.open(os.path.join(paths.OUT, "objects_all.json"), encoding="utf-8") as f:
		objects = json.load(f)
	guid = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
	types = {}
	for obj in objects:
		if obj.get("family") not in ("Document", "AccumRg", "InfoRg", "AccRg", "CRg"):
			continue
		path = os.path.join(config, obj["guid"] + ".txt")
		if not os.path.exists(path):
			continue
		with io.open(path, encoding="utf-8-sig") as f:
			head = f.read(4000)
		head = head.split("{0,0," + obj["guid"], 1)[0]
		for g in guid.findall(head):
			types.setdefault(g, bsl.norm(obj["name"]))
	found = collections.defaultdict(list)
	for obj in objects:
		if obj.get("classGuid") != SUBSCRIPTION_CLASS:
			continue
		path = os.path.join(config, obj["guid"] + ".txt")
		if not os.path.exists(path):
			continue
		with io.open(path, encoding="utf-8-sig") as f:
			text = f.read()
		m = re.search(u'\{"Pattern",(.*?)\},"([A-Za-z]+)_([^"]+)",(%s),"([^"]+)"'
		              % guid.pattern, text, re.S | re.U)
		if not m:
			continue
		event = bsl.norm(m.group(3))
		record = {"name": obj["name"], "module": m.group(4), "handler": m.group(5)}
		for g in guid.findall(m.group(1)):
			source = types.get(g)
			if source:
				found[(source, event)].append(record)
	return found


# -- output -----------------------------------------------------------------------------

def main():
	args = sys.argv[1:]
	modules, failures = load()
	registers = register_names()
	graph = Graph(modules, registers)
	rounds = graph.run()
	documents = graph.document_writes(subscriptions(modules), declared_movements())

	out = codecs.getwriter("utf-8")(sys.stdout.buffer)
	if args:
		wanted = args[0]
		for event, found in sorted(documents.get(wanted, {}).items()):
			out.write(u"%s\n" % event)
			for register, chain in sorted(found.items()):
				known = registers.get(register)
				out.write(u"  %s%s\n" % (known[1] if known else register,
				                         u"" if known else u"   (not a register)"))
				for step in chain:
					out.write(u"      %s\n" % step)
		return

	old = {}
	with io.open(os.path.join(paths.OUT, "handlers.json"), encoding="utf-8") as f:
		for row in json.load(f):
			regs = set(row.get("direct") or [])
			for found in (row.get("viaCalls") or {}).values():
				regs.update(found)
			for found in (row.get("outsidePosting") or {}).values():
				regs.update(found)
			old[row.get("doc")] = regs
	records = []
	unknown = collections.Counter()
	for document in sorted(documents):
		events = documents[document]
		posting = {}
		for event in ("posting", "on-write", "before-write"):
			for register, chain in events.get(event, {}).items():
				posting.setdefault(register, (event, chain))
		named, strays = [], []
		for register in posting:
			known = registers.get(register)
			if known:
				named.append(known[1])
			else:
				strays.append(register)
				unknown[register] += 1
		records.append({
			"document": document,
			"client": document.startswith(handlers.CLIENT),
			"registers": sorted(named),
			"events": dict((event, dict(
				(registers[r][1] if r in registers else r, list(chain))
				for r, chain in sorted(found.items())))
				for event, found in events.items()),
			"not_registers": sorted(strays),
		})
	with codecs.open(TARGET, "w", "utf-8") as f:
		json.dump({"rounds": rounds,
		           "unresolved_calls": dict(graph.unresolved.most_common()),
		           "parse_failures": failures,
		           "documents": records}, f, ensure_ascii=False, indent="\t")

	writing = [r for r in records if r["registers"]]
	out.write(u"%d documents, %d write a register (%d rounds)\n"
	          % (len(records), len(writing), rounds))
	out.write(u"unresolved calls: %s\n" % u", ".join(
		u"%s %d" % kv for kv in graph.unresolved.most_common()))
	if unknown:
		out.write(u"paths that name no register: %s\n" % u", ".join(
			u"%s %d" % kv for kv in unknown.most_common(10)))
	out.write(u"\n%-48s %5s %5s  %s\n" % (u"document", u"now", u"was", u"registers"))
	for r in sorted(writing, key=lambda r: (-len(r["registers"]), r["document"])):
		was = old.get(r["document"])
		out.write(u"%-48s %5d %5s  %s\n" % (r["document"][:48], len(r["registers"]),
		                                     len(was) if was is not None else u"-",
		                                     u", ".join(r["registers"])[:120]))
	out.write(u"\nwritten %s\n" % TARGET)


if __name__ == "__main__":
	main()
