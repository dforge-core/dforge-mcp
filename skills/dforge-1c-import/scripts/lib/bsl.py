# -*- coding: utf-8 -*-
u"""A parser for 1C:Enterprise 8 built-in language (BSL), to a plain tree.

The first readers of this configuration's code found `Движения.<name>` by text and followed
calls one level. That cannot see what УТП actually does: a register set taken into a
variable (`ПроводкиБУ = Движения.Хозрасчетный`), a row added through it, the set handed to
a common module as an argument. Following values needs a parse tree, and this is it.

Why written here rather than taken: the grammar of `bsl-language-server` is ANTLR and
needs a JVM to generate a parser from, and there is no tree-sitter grammar for this
Python. BSL is small - a Pascal-like statement language with one expression grammar - so
a recursive-descent parser is a few hundred lines with no dependency, and it reads the
whole configuration in minutes.

What it does not do, on purpose:

  * The preprocessor is evaluated for one context, the server by default, because that is
    where posting runs; excluded lines are blanked so line numbers hold. This
    configuration has `#Если` branches that split a single statement, so keeping both
    branches does not parse.
  * Query text is a string literal. What a query reads is a separate question.

The tree is tuples, first element the node kind, so it is cheap to build for two million
lines and easy to pattern-match. Every statement carries its line.

    Module      ('module', vars, methods, body)
    Method      ('method', name, is_function, params, export, body, line, end_line)
    param       (name, by_value, default_expr_or_None)

    Statements  ('assign', line, target, value)
                ('call', line, expr)                 # a call used as a statement
                ('if', line, [(cond, body)...], else_body_or_None)
                ('while', line, cond, body)
                ('for', line, var, start, stop, body)
                ('foreach', line, var, collection, body)
                ('try', line, body, except_body)
                ('return', line, expr_or_None)
                ('raise', line, expr_or_None)
                ('break', line) ('continue', line) ('goto', line, label)
                ('label', line, label) ('var', line, names) ('execute', line, expr)
                ('handler', line, 'add'|'remove', event_expr, handler_expr)

    Expressions ('name', id) ('lit', value) ('member', obj, name) ('index', obj, key)
                ('callx', callee, args)  - args hold None for an omitted argument
                ('new', type_name_or_None, args) ('bin', op, a, b) ('not', a)
                ('neg', a) ('tern', cond, a, b)

Names keep their source spelling; `norm()` gives the case-folded key 1C itself compares by.
"""
from __future__ import print_function

import re

# Russian and English spellings of every keyword, mapped to one canonical form.
_KEYWORDS = {
	u"если": "if", u"if": "if",
	u"тогда": "then", u"then": "then",
	u"иначеесли": "elsif", u"elsif": "elsif",
	u"иначе": "else", u"else": "else",
	u"конецесли": "endif", u"endif": "endif",
	u"для": "for", u"for": "for",
	u"каждого": "each", u"each": "each",
	u"из": "in", u"in": "in",
	u"по": "to", u"to": "to",
	u"пока": "while", u"while": "while",
	u"цикл": "do", u"do": "do",
	u"конеццикла": "enddo", u"enddo": "enddo",
	u"процедура": "procedure", u"procedure": "procedure",
	u"функция": "function", u"function": "function",
	u"конецпроцедуры": "endprocedure", u"endprocedure": "endprocedure",
	u"конецфункции": "endfunction", u"endfunction": "endfunction",
	u"перем": "var", u"var": "var",
	u"экспорт": "export", u"export": "export",
	u"знач": "val", u"val": "val",
	u"возврат": "return", u"return": "return",
	u"прервать": "break", u"break": "break",
	u"продолжить": "continue", u"continue": "continue",
	u"попытка": "try", u"try": "try",
	u"исключение": "except", u"except": "except",
	u"конецпопытки": "endtry", u"endtry": "endtry",
	u"вызватьисключение": "raise", u"raise": "raise",
	u"новый": "new", u"new": "new",
	u"и": "and", u"and": "and",
	u"или": "or", u"or": "or",
	u"не": "not", u"not": "not",
	u"истина": "true", u"true": "true",
	u"ложь": "false", u"false": "false",
	u"неопределено": "undefined", u"undefined": "undefined",
	u"null": "null",
	u"перейти": "goto", u"goto": "goto",
}

_TOKEN = re.compile(u"""
	(?P<ws>[ \\t\\r\\f\\v\\ufeff\\xa0]+)
	|(?P<nl>\\n)
	|(?P<comment>//[^\\n]*)
	|(?P<pre>(?<![^\\n \\t])\\#[^\\n]*)
	|(?P<directive>&[^\\n]*)
	|(?P<string>"(?:[^"\\n]|""|\\n(?:[ \\t\\r]*(?://[^\\n]*)?\\n)*[ \\t]*\\|)*")
	|(?P<date>'[^'\\n]*')
	|(?P<number>[0-9]+(?:\\.[0-9]+)?)
	|(?P<ident>[^\\W\\d]\\w*)
	|(?P<op><>|<=|>=|[-+*/%=<>(),.;\\[\\]?:~])
	""", re.U | re.X)


class ParseError(Exception):
	def __init__(self, message, line):
		Exception.__init__(self, u"line %d: %s" % (line, message))
		self.line = line


def norm(name):
	return name.lower().replace(u"ё", u"е")


def tokenize(text):
	"""(kind, value, line) - kind is 'kw', 'id', 'str', 'num', 'date', 'op', 'eof'."""
	out = []
	line = 1
	pos = 0
	end = len(text)
	match = _TOKEN.match
	while pos < end:
		m = match(text, pos)
		if m is None:
			raise ParseError(u"unexpected character %r" % text[pos], line)
		kind = m.lastgroup
		value = m.group(kind)
		if kind == "nl":
			line += 1
		elif kind in ("ws", "comment", "pre", "directive"):
			pass
		elif kind == "string":
			out.append(("str", _string(value), line))
			line += value.count("\n")
		elif kind == "ident":
			key = _KEYWORDS.get(norm(value))
			out.append(("kw", key, line) if key else ("id", value, line))
		elif kind == "number":
			out.append(("num", value, line))
		elif kind == "date":
			out.append(("date", value[1:-1], line))
		else:
			out.append(("op", value, line))
		pos = m.end()
	out.append(("eof", None, line))
	return out


def _string(raw):
	"""The literal's value: quotes doubled inside, continuation lines start with `|`."""
	body = raw[1:-1]
	if "\n" in body:
		parts = body.split("\n")
		kept = [parts[0]]
		for part in parts[1:]:
			stripped = part.lstrip()
			if stripped.startswith("|"):
				kept.append(stripped[1:])
			# a `//` line between continuation lines is a comment, not text
		body = "\n".join(kept)
	return body.replace('""', '"')


# `ДобавитьОбработчик Объект.Событие, Обработчик;` - a statement, not a call.
_HANDLER_STATEMENTS = {u"добавитьобработчик": "add", u"addhandler": "add",
                       u"удалитьобработчик": "remove", u"removehandler": "remove"}

# Statement-ending keywords: a block reads statements until it meets one of these.
_BLOCK_END = frozenset(["elsif", "else", "endif", "enddo", "endprocedure", "endfunction",
                        "except", "endtry"])


class Parser(object):

	def __init__(self, tokens):
		self.t = tokens
		self.i = 0

	# -- token helpers ------------------------------------------------------------------

	def peek(self, offset=0):
		return self.t[min(self.i + offset, len(self.t) - 1)]

	def next(self):
		tok = self.t[self.i]
		if self.i < len(self.t) - 1:
			self.i += 1
		return tok

	def at(self, kind, value=None):
		tok = self.t[self.i]
		return tok[0] == kind and (value is None or tok[1] == value)

	def accept(self, kind, value=None):
		if self.at(kind, value):
			return self.next()
		return None

	def expect(self, kind, value=None):
		tok = self.t[self.i]
		if tok[0] == kind and (value is None or tok[1] == value):
			return self.next()
		raise ParseError(u"expected %s, got %s %r" % (value or kind, tok[0], tok[1]), tok[2])

	def skip_semis(self):
		while self.accept("op", ";"):
			pass

	# -- module -------------------------------------------------------------------------

	def module(self):
		"""Module-level `Перем`, methods and trailing body. A method that fails to parse is
		skipped to its end and reported, so one odd procedure does not lose the module."""
		variables, methods, body, errors = [], [], [], []
		while not self.at("eof"):
			self.skip_semis()
			if self.at("eof"):
				break
			if self.at("kw", "var") and not methods:
				variables.append(self.var_statement())
				continue
			if self.at("kw", "procedure") or self.at("kw", "function"):
				start = self.i
				try:
					methods.append(self.method())
				except ParseError as error:
					errors.append(error)
					self.i = start
					self._skip_method()
				continue
			try:
				statement = self.statement()
			except ParseError as error:
				errors.append(error)
				self._skip_line()
				continue
			if statement is not None:
				body.append(statement)
		return ("module", variables, methods, body), errors

	def _skip_method(self):
		self.next()
		while not self.at("eof"):
			tok = self.next()
			if tok[0] == "kw" and tok[1] in ("endprocedure", "endfunction"):
				return

	def _skip_line(self):
		line = self.peek()[2]
		while not self.at("eof") and self.peek()[2] == line:
			self.next()

	def method(self):
		head = self.next()
		is_function = head[1] == "function"
		name = self.expect("id")[1]
		self.expect("op", "(")
		params = []
		while not self.at("op", ")"):
			by_value = bool(self.accept("kw", "val"))
			pname = self.expect("id")[1]
			default = None
			if self.accept("op", "="):
				default = self.unary()
			params.append((pname, by_value, default))
			if not self.accept("op", ","):
				break
		self.expect("op", ")")
		export = bool(self.accept("kw", "export"))
		body = self.block()
		end = self.next()
		if end[0] != "kw" or end[1] not in ("endprocedure", "endfunction"):
			raise ParseError(u"expected the end of %s, got %r" % (name, end[1]), end[2])
		return ("method", name, is_function, params, export, body, head[2], end[2])

	# -- statements ---------------------------------------------------------------------

	def block(self):
		body = []
		while True:
			self.skip_semis()
			tok = self.peek()
			if tok[0] == "eof" or (tok[0] == "kw" and tok[1] in _BLOCK_END):
				return body
			if tok[0] == "kw" and tok[1] in ("procedure", "function"):
				raise ParseError(u"a method begins inside a block", tok[2])
			statement = self.statement()
			if statement is not None:
				body.append(statement)

	def statement(self):
		tok = self.peek()
		line = tok[2]
		kind, value = tok[0], tok[1]
		if kind == "op" and value == "~":
			self.next()
			label = self.expect("id")[1]
			self.expect("op", ":")
			return ("label", line, label)
		if kind == "kw":
			if value == "if":
				return self.if_statement()
			if value == "while":
				self.next()
				cond = self.expression()
				self.expect("kw", "do")
				body = self.block()
				self.expect("kw", "enddo")
				return ("while", line, cond, body)
			if value == "for":
				return self.for_statement()
			if value == "try":
				self.next()
				body = self.block()
				self.expect("kw", "except")
				handler = self.block()
				self.expect("kw", "endtry")
				return ("try", line, body, handler)
			if value == "return":
				self.next()
				expr = None if self._statement_ends() else self.expression()
				return ("return", line, expr)
			if value == "raise":
				self.next()
				expr = None if self._statement_ends() else self.expression()
				return ("raise", line, expr)
			if value == "break":
				self.next()
				return ("break", line)
			if value == "continue":
				self.next()
				return ("continue", line)
			if value == "goto":
				self.next()
				self.expect("op", "~")
				return ("goto", line, self.expect("id")[1])
			if value == "var":
				return self.var_statement()
		# `Выполнить Текст` without brackets; `Выполнить(Текст)` parses as a call
		if kind == "id" and norm(value) in (u"выполнить", u"execute") \
				and self.peek(1)[0] in ("id", "str"):
			self.next()
			return ("execute", line, self.expression())
		if kind == "id" and norm(value) in _HANDLER_STATEMENTS and self.peek(1)[0] == "id":
			self.next()
			event = self.postfix()
			self.expect("op", ",")
			return ("handler", line, _HANDLER_STATEMENTS[norm(value)], event, self.postfix())
		target = self.postfix()
		if self.accept("op", "="):
			return ("assign", line, target, self.expression())
		if target[0] != "callx":
			# `Выполнить(текст)` parses as a call; anything else bare is an error
			raise ParseError(u"a statement that is neither a call nor an assignment", line)
		return ("call", line, target)

	def _statement_ends(self):
		tok = self.peek()
		return (tok[0] == "op" and tok[1] == ";") or tok[0] == "eof" or \
			(tok[0] == "kw" and tok[1] in _BLOCK_END)

	def var_statement(self):
		line = self.next()[2]
		names = []
		while True:
			names.append(self.expect("id")[1])
			self.accept("kw", "export")
			if not self.accept("op", ","):
				break
		return ("var", line, names)

	def if_statement(self):
		line = self.next()[2]
		branches = []
		cond = self.expression()
		self.expect("kw", "then")
		branches.append((cond, self.block()))
		other = None
		while True:
			if self.accept("kw", "elsif"):
				cond = self.expression()
				self.expect("kw", "then")
				branches.append((cond, self.block()))
				continue
			if self.accept("kw", "else"):
				other = self.block()
			self.expect("kw", "endif")
			return ("if", line, branches, other)

	def for_statement(self):
		line = self.next()[2]
		if self.accept("kw", "each"):
			var = self.expect("id")[1]
			self.expect("kw", "in")
			collection = self.expression()
			self.expect("kw", "do")
			body = self.block()
			self.expect("kw", "enddo")
			return ("foreach", line, var, collection, body)
		var = self.expect("id")[1]
		self.expect("op", "=")
		start = self.expression()
		self.expect("kw", "to")
		stop = self.expression()
		self.expect("kw", "do")
		body = self.block()
		self.expect("kw", "enddo")
		return ("for", line, var, start, stop, body)

	# -- expressions --------------------------------------------------------------------

	def expression(self):
		left = self.and_expr()
		while self.accept("kw", "or"):
			left = ("bin", "or", left, self.and_expr())
		return left

	def and_expr(self):
		left = self.not_expr()
		while self.accept("kw", "and"):
			left = ("bin", "and", left, self.not_expr())
		return left

	def not_expr(self):
		if self.accept("kw", "not"):
			return ("not", self.not_expr())
		return self.comparison()

	def comparison(self):
		left = self.additive()
		while True:
			tok = self.peek()
			if tok[0] == "op" and tok[1] in ("=", "<>", "<", ">", "<=", ">="):
				self.next()
				left = ("bin", tok[1], left, self.additive())
			else:
				return left

	def additive(self):
		left = self.multiplicative()
		while True:
			tok = self.peek()
			if tok[0] == "op" and tok[1] in ("+", "-"):
				self.next()
				left = ("bin", tok[1], left, self.multiplicative())
			else:
				return left

	def multiplicative(self):
		left = self.unary()
		while True:
			tok = self.peek()
			if tok[0] == "op" and tok[1] in ("*", "/", "%"):
				self.next()
				left = ("bin", tok[1], left, self.unary())
			else:
				return left

	def unary(self):
		if self.accept("op", "-"):
			return ("neg", self.unary())
		if self.accept("op", "+"):
			return self.unary()
		return self.postfix()

	def postfix(self):
		expr = self.primary()
		while True:
			if self.accept("op", "."):
				tok = self.next()
				# a member may be spelled like a keyword: `Запрос.Выполнить`, `Стр.Новый`
				if tok[0] not in ("id", "kw"):
					raise ParseError(u"expected a member name", tok[2])
				expr = ("member", expr, tok[1] if tok[0] == "id" else self._kw_text(tok))
			elif self.accept("op", "["):
				key = self.expression()
				self.expect("op", "]")
				expr = ("index", expr, key)
			elif self.at("op", "("):
				expr = ("callx", expr, self.arguments())
			else:
				return expr

	def _kw_text(self, tok):
		# the canonical keyword is English; a member name only needs to be stable
		return tok[1]

	def arguments(self):
		self.expect("op", "(")
		args = []
		if self.accept("op", ")"):
			return args
		while True:
			if self.at("op", ",") or self.at("op", ")"):
				args.append(None)
			else:
				args.append(self.expression())
			if self.accept("op", ","):
				continue
			self.expect("op", ")")
			return args

	def primary(self):
		tok = self.next()
		kind, value = tok[0], tok[1]
		if kind == "id":
			return ("name", value)
		if kind == "num":
			return ("lit", float(value) if "." in value else int(value))
		if kind == "str":
			# adjacent literals concatenate: "a" "b"
			parts = [value]
			while self.at("str"):
				parts.append(self.next()[1])
			return ("lit", u"".join(parts))
		if kind == "date":
			return ("lit", ("date", value))
		if kind == "kw":
			if value == "true":
				return ("lit", True)
			if value == "false":
				return ("lit", False)
			if value in ("undefined", "null"):
				return ("lit", None)
			if value == "new":
				if self.at("id"):
					type_name = self.next()[1]
					args = self.arguments() if self.at("op", "(") else []
					return ("new", type_name, args)
				return ("new", None, self.arguments())
		if kind == "op":
			if value == "(":
				expr = self.expression()
				self.expect("op", ")")
				return expr
			if value == "?":
				args = self.arguments()
				if len(args) != 3:
					raise ParseError(u"?() takes three arguments", tok[2])
				return ("tern", args[0], args[1], args[2])
		raise ParseError(u"unexpected %s %r" % (kind, value), tok[2])


# -- preprocessor -----------------------------------------------------------------------

# Where posting runs. An ordinary-application configuration posts on the server in
# client-server mode, so that is the reading a requirement is taken from.
SERVER = frozenset([u"сервер", u"server", u"насервере", u"atserver",
                    u"внешнеесоединение", u"externalconnection"])

_PRE_LINE = re.compile(u"^[ \\t]*#[ \\t]*([^\\W\\d]+)(.*)$", re.U)


def _pre_condition(text, defined):
	"""Evaluate `Сервер И НЕ Клиент` and the like against the defined symbols."""
	words = re.findall(u"[^\\W\\d]+|\\(|\\)", text, re.U)
	pos = [0]

	def atom():
		word = words[pos[0]] if pos[0] < len(words) else u""
		pos[0] += 1
		key = norm(word)
		if key in (u"не", u"not"):
			return not atom()
		if word == u"(":
			value = disj()
			pos[0] += 1
			return value
		return key in defined

	def conj():
		value = atom()
		while pos[0] < len(words) and norm(words[pos[0]]) in (u"и", u"and"):
			pos[0] += 1
			value = atom() and value
		return value

	def disj():
		value = conj()
		while pos[0] < len(words) and norm(words[pos[0]]) in (u"или", u"or"):
			pos[0] += 1
			value = conj() or value
		return value

	words = [w for w in words if norm(w) not in (u"тогда", u"then")]
	return disj()


def preprocess(text, defined=SERVER):
	"""The text with every line the preprocessor excludes blanked, so line numbers hold.

	`#Область` and other directives that do not choose code are blanked and their content
	kept. A `#Если` whose branches split one statement - this configuration has them -
	then parses as the one statement the platform would compile."""
	lines = text.split("\n")
	stack = []          # (this branch active, some branch already taken, parent active)
	active = True
	for index, line in enumerate(lines):
		m = _PRE_LINE.match(line)
		if not m:
			if not active:
				lines[index] = u""
			continue
		word, rest = norm(m.group(1)), m.group(2)
		if word in (u"если", u"if"):
			chosen = active and _pre_condition(rest, defined)
			stack.append((chosen, chosen, active))
			active = chosen
		elif word in (u"иначеесли", u"elsif") and stack:
			_, taken, parent = stack[-1]
			chosen = parent and not taken and _pre_condition(rest, defined)
			stack[-1] = (chosen, taken or chosen, parent)
			active = chosen
		elif word in (u"иначе", u"else") and stack:
			_, taken, parent = stack[-1]
			chosen = parent and not taken
			stack[-1] = (chosen, True, parent)
			active = chosen
		elif word in (u"конецесли", u"endif") and stack:
			active = stack.pop()[2]
		lines[index] = u""
	return "\n".join(lines)


def parse(text, defined=SERVER):
	"""(module tree, [ParseError]) - errors are per method; the rest still parses.

	`defined` is the preprocessor context; None keeps every branch."""
	if defined is not None:
		text = preprocess(text, defined)
	return Parser(tokenize(text)).module()


def parse_expression(text):
	return Parser(tokenize(text)).expression()


# -- walking ----------------------------------------------------------------------------

def statements(body):
	"""Every statement in a body, depth first, nested blocks included."""
	for st in body:
		yield st
		kind = st[0]
		if kind == "if":
			for _, inner in st[2]:
				for x in statements(inner):
					yield x
			if st[3]:
				for x in statements(st[3]):
					yield x
		elif kind == "while":
			for x in statements(st[3]):
				yield x
		elif kind == "for":
			for x in statements(st[5]):
				yield x
		elif kind == "foreach":
			for x in statements(st[4]):
				yield x
		elif kind == "try":
			for x in statements(st[2]):
				yield x
			for x in statements(st[3]):
				yield x


def expressions(st):
	"""The expressions a statement holds directly (not those of nested statements)."""
	kind = st[0]
	if kind == "assign":
		return [st[2], st[3]]
	if kind in ("call", "execute"):
		return [st[2]]
	if kind == "handler":
		return [st[3], st[4]]
	if kind in ("return", "raise"):
		return [st[2]] if st[2] is not None else []
	if kind == "if":
		return [cond for cond, _ in st[2]]
	if kind == "while":
		return [st[2]]
	if kind == "for":
		return [st[3], st[4]]
	if kind == "foreach":
		return [st[3]]
	return []


def subexpressions(expr):
	"""An expression and everything inside it."""
	stack = [expr]
	while stack:
		e = stack.pop()
		if e is None:
			continue
		yield e
		kind = e[0]
		if kind == "member":
			stack.append(e[1])
		elif kind == "index":
			stack.extend((e[1], e[2]))
		elif kind == "callx":
			stack.append(e[1])
			stack.extend(e[2])
		elif kind == "new":
			stack.extend(e[2])
		elif kind == "bin":
			stack.extend((e[2], e[3]))
		elif kind in ("not", "neg"):
			stack.append(e[1])
		elif kind == "tern":
			stack.extend((e[1], e[2], e[3]))


def walk(body, context=()):
	"""(statement, context) for every statement; context is the enclosing constructs,
	outermost first: ('if', condition, negated earlier conditions), ('foreach', var,
	collection), ('for', var, start, stop), ('while', condition), ('try',), ('except',)."""
	for st in body:
		yield st, context
		kind = st[0]
		if kind == "if":
			earlier = []
			for cond, inner in st[2]:
				for x in walk(inner, context + (("if", cond, tuple(earlier)),)):
					yield x
				earlier.append(cond)
			if st[3]:
				for x in walk(st[3], context + (("if", None, tuple(earlier)),)):
					yield x
		elif kind == "while":
			for x in walk(st[3], context + (("while", st[2]),)):
				yield x
		elif kind == "for":
			for x in walk(st[5], context + (("for", st[2], st[3], st[4]),)):
				yield x
		elif kind == "foreach":
			for x in walk(st[4], context + (("foreach", st[2], st[3]),)):
				yield x
		elif kind == "try":
			for x in walk(st[2], context + (("try",),)):
				yield x
			for x in walk(st[3], context + (("except",),)):
				yield x


_PRECEDENCE = {"or": 1, "and": 2, "=": 4, "<>": 4, "<": 4, ">": 4, "<=": 4, ">=": 4,
               "+": 5, "-": 5, "*": 6, "/": 6, "%": 6}
_WORDS = {"or": u"ИЛИ", "and": u"И"}


def render(expr, parent=0):
	"""An expression as compact text - for a behaviour spec a person reads, not for
	running. Keywords come out in Russian, the way the configuration spells them."""
	if expr is None:
		return u""
	kind = expr[0]
	if kind == "name":
		return expr[1]
	if kind == "lit":
		value = expr[1]
		if value is True:
			return u"Истина"
		if value is False:
			return u"Ложь"
		if value is None:
			return u"Неопределено"
		if isinstance(value, tuple):
			return u"'%s'" % value[1]
		if isinstance(value, type(u"")):
			text = value if len(value) <= 60 else value[:57] + u"..."
			return u'"%s"' % text.replace(u'"', u'""').replace(u"\n", u" ")
		return u"%s" % value
	if kind == "member":
		return u"%s.%s" % (render(expr[1], 9), expr[2])
	if kind == "index":
		return u"%s[%s]" % (render(expr[1], 9), render(expr[2]))
	if kind == "callx":
		return u"%s(%s)" % (render(expr[1], 9), u", ".join(render(a) for a in expr[2]))
	if kind == "new":
		args = u", ".join(render(a) for a in expr[2])
		return u"Новый %s(%s)" % (expr[1] or u"", args) if expr[1] else u"Новый(%s)" % args
	if kind == "not":
		text = u"НЕ " + render(expr[1], 3)
		return u"(%s)" % text if parent > 3 else text
	if kind == "neg":
		return u"-" + render(expr[1], 7)
	if kind == "tern":
		return u"?(%s, %s, %s)" % (render(expr[1]), render(expr[2]), render(expr[3]))
	if kind == "bin":
		op = expr[1]
		mine = _PRECEDENCE[op]
		text = u"%s %s %s" % (render(expr[2], mine), _WORDS.get(op, op), render(expr[3], mine + 1))
		return u"(%s)" % text if mine < parent else text
	return u"?"


def dotted(expr):
	"""`А.Б.В` as ['А', 'Б', 'В'], or None if the expression is not a plain path."""
	parts = []
	while expr[0] == "member":
		parts.append(expr[2])
		expr = expr[1]
	if expr[0] != "name":
		return None
	parts.append(expr[1])
	parts.reverse()
	return parts
