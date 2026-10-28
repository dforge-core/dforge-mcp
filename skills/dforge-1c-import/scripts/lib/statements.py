# -*- coding: utf-8 -*-
u"""Read the regulated statements the project declares, and write the module's seed.

This is the part of reading a 1C regulated form that every form shares.

Three forms in, the per-form scripts had become the same five passes with different constants,
so the passes live here and a script says only what is particular about its form. What is
particular turns out to be small: which module, which helpers that module defines, what its
`2`-suffixed helpers mean, which branches of it are dead, and whatever it does that no regex
should be asked to read.

THE PASSES, in the order they run.

0. The dead branches. A form that offers two accounting policies writes both, and taking both
   double-counts. The live one is decided by measurement, never by preference, and the other
   is cut out of the source text before anything reads it.

1. `П<line><col> = <signed sum of helper calls>` - the bulk of every form.

2. Whatever the script does by hand, given the source text with the dead branches gone.

3. `<object>.Области.П<line><col>.Значение = <signed sum of other lines>` - the running
   totals. Reading only shape 1 once cost a day of believing the Balance's own totals lived in
   a binary макет and were unreachable, so this pass is not optional for any form.

4. The checks: every account named exists in the chart, every line referenced is computed by
   something, every indicator the form sets is covered, and every `2` suffix agrees with the
   column it lands in. None of them fix anything; they say whether the reading is finished.

WHY THE `2` SUFFIX IS NOT ONE WINDOW. Each of these forms opens a second totals object over
the previous period, and what "the previous period" means differs BY FORM:

    Звіт про фінансові результати   НачалоГода(start-12) .. (end-12)      the comparable period
    Звіт про рух грошових коштів    НачалоГода(start-12) .. КонецГода()   the whole prior year

Same number for an annual report, different for an interim one. So a script declares what its
suffix means and the engine holds both windows; nothing here guesses from the column.
"""
from __future__ import print_function
import collections
import io
import json
import os
import re
import sys

import migrate
import paths

# `Счет70_9_1 = ПС.Предопределённый` - the underscores are the subaccount separators, so the
# code is what is left once they go, and the predefined name is never needed. Some modules
# write the alias and some the full path, so both are read.
# The leading С may be the LATIN one. That is not defensive programming, it is a typo in the
# vendor's own source: Примітки declares `Cчет98 = ПС.НалогНаПрибыль` with U+0043 and uses it
# the same way two lines later, so 1C is perfectly happy and only a reader that insists on
# Cyrillic notices. Reading it strictly and then widening beats reading it loosely: the strict
# pass is what said which account was missing.
ACCOUNT = re.compile(u'(?m)^\\s*([СC]чет[0-9_]*)\\s*=\\s*(?:ПС|ПланыСчетов\\.Хозрасчетный)'
                     u'\\.([A-Za-zА-Яа-я0-9_]+)\\s*;')

def _patterns(line=u"[0-9]{4}", column=u"[34]", sep=u""):
	u"""The four indicator shapes, built from how a form spells an indicator.

	An indicator is `П<line><column>`, and neither half can be assumed:

	    Баланс, Ф2, Ф3, Ф4     `П10013`    four digits and one, run together
	    Примітки               `П010_14`   three or four digits, an underscore, one or two

	Nor can the columns. The first three forms print two - the reporting period and a
	comparison - Звіт про власний капітал prints seven components and a total, and Примітки
	prints up to fifteen. So each part is a regex fragment the form supplies, and the defaults
	reproduce exactly what was fixed before.

	Without a separator the two halves are told apart only by the line's width being fixed,
	which is why in that shape `line` and `column` cannot both be open-ended.
	"""
	pair = u"(%s)%s(%s)" % (line, re.escape(sep), column)
	# What may NOT follow an indicator. Another digit never may, or a two-column form would
	# read column 1 of a fifteen-column one. With a separator, a further separator may not
	# either: Примітки computes `П1242_3` out of `П1242_3_1 .. _4`, and those four are
	# intermediate variables, not references to line 1242 column 3.
	tail = u"(?![0-9_])" if sep else u"(?![0-9])"
	return {
		"assign": re.compile(u'(?m)^\s*П%s\s*=\s*([^;]+);' % pair),
		# A word boundary after the digits matches nothing once the token carries a Cyrillic
		# prefix, which had a self-reference scan silently finding none of ten. So what is
		# meant is said outright.
		"self": re.compile(u'^\s*П%s%s' % (pair, tail)),
		"line_ref": re.compile(u'([+-]?)\s*П%s%s' % (pair, tail)),
		"derived": re.compile(u'Области\.П%s\.Значение\s*=\s*([^;]+);' % pair),
		"derived_term": re.compile(u'([+-]?)\s*(?:ОкруглитьЧислоПоФормату\s*\(\s*)?'
		                           # the object's name may carry a digit - Примітки keeps one
		                           # totals object per SECTION, `мРаздел1`..`мРаздел15`
		                           u'[А-Яа-яA-Za-z0-9_]*\.Области\.П%s\.Значение' % pair),
	}


COMMENT = re.compile(u"(?m)^[ \t]*//.*$")


def uncommented(source):
	u"""The module with its commented-out CODE gone, which is not tidiness.

	An assignment pattern is anchored at the start of a statement, so a `//` in front of one
	already hides it. Nothing else here is anchored: a standalone call, a running total written
	as `Области.П…Значение = …`, a term in a sum - each is found wherever it appears, and a
	previous version of it left in a comment is found just as well.

	Звіт про власний капітал keeps the reading it used before 2013 commented out two lines
	above the live one, both filling line 4100 - and that pair was skipped only because the
	live assignment had already claimed the indicator. Had the old version filled a line the
	new one does not, it would have been read as current.

	Only a comment that starts its own line goes. A trailing `//` may follow real code, and
	cutting at one would need to know whether it sits inside a string literal.
	"""
	return COMMENT.sub(u"", source)


_DEFAULT = _patterns()
ASSIGN = _DEFAULT["assign"]
SELF = _DEFAULT["self"]
LINE_REF = _DEFAULT["line_ref"]
DERIVED = _DEFAULT["derived"]
DERIVED_TERM = _DEFAULT["derived_term"]
# The name as the FORM spells it, separator and all - `П10013` or `П070_3`. Truncating at the
# separator made Примітки look as though it set 25 indicators when it sets 150, and left every
# one of them looking uncovered.
INDICATOR = re.compile(u'УстановитьЗначениеПоказателя\\(\\s*"П([0-9][0-9_]*)"')

# The helpers these forms define, and what each reads. A form defines the subset it needs.
MEASURE = {
	u"ДО":  ("turnover", "debit"),
	u"КО":  ("turnover", "credit"),
	u"ОБ":  ("turnover", "correspondence"),
	u"СНД": ("opening", "debit"),
	u"СНК": ("opening", "credit"),
	u"СКД": ("closing", "debit"),
	u"СКК": ("closing", "credit"),
}
HELPERS = "|".join(sorted(MEASURE, key=len, reverse=True))
TERM = re.compile(u'([+-]?)\\s*(' + HELPERS + u')(2?)\\s*\\('
                  u'\\s*([A-Za-zА-Яа-я0-9_]+)\\s*'
                  u'((?:,\\s*[A-Za-zА-Яа-я0-9_]+\\s*)*)\\)')


class Form(object):
	u"""One 1C regulated form, being read."""

	def __init__(self, statement, module, title, description, key_base,
	             prior_turnover="turnover_prior", by_hand=(), configured=None,
	             line=u"[0-9]{4}", column=u"[34]", sep=u"", comparative=u"4"):
		self.statement = statement
		self.module = module
		# where this form's seeded keys start; the project picks, so two forms never collide
		self.key_base = key_base
		self.title = title
		self.description = description
		# what this form's `2`-suffixed TURNOVER helpers mean; the balance ones are always
		# the same period a year earlier, which is `opening_prior` either way
		self.prior_turnover = prior_turnover
		self.by_hand = frozenset(by_hand)     # lines pass 1 must leave to the script
		# How this form spells an indicator, and which of its columns compares against another
		# period. Звіт про власний капітал has seven columns and NONE of them is a second
		# period - they are the components of equity - so `comparative=None` turns off the
		# check that pairs a `2`-suffixed helper with a column, there being nothing to pair.
		self.comparative = comparative
		self.sep = sep
		self.pattern = _patterns(line, column, sep)
		self.rules = []
		self.problems = []
		self.unparsed = []
		self.counts = collections.OrderedDict()
		self._cut = (0, 0)
		self.src = io.open(module, encoding="utf-8", errors="replace").read()
		self.live = uncommented(self.src)
		# Every indicator the form is known to set, which the coverage check measures against.
		# Most are set by name; a form that fills some of them from inside a helper adds those
		# as it reads them, because nothing in the source text names them.
		self.wanted = set(INDICATOR.findall(self.live))
		self.accounts = dict(
			(name, name[4:].replace("_", "")) for name, _ in ACCOUNT.findall(self.src))
		if configured:
			# accounts the module reads from a settings register rather than naming, so
			# neither the code nor a regex can say what they are; a script measures them.
			self.accounts.update(configured)

	# --------------------------------------------------------------- pass 0: the dead branch
	def cut(self, condition, keyword=u"Иначе", must_contain=None, dead=u"else", indent=None):
		u"""Remove one half of every `Если <condition> Тогда … <keyword> … КонецЕсли`.

		The opening `Если`, its `<keyword>` and its `КонецЕсли` all sit at the SAME
		indentation, which is what makes a text search safe here: everything nested inside is
		deeper, so the first keyword at that indentation after an opening is its own.

		`dead`    which half goes. `"else"` for a form whose live branch is the first - the
		          accounting-policy blocks - and `"then"` for one whose live branch is the
		          second, which is how a form written for several reporting years keeps the
		          old numbering in the `Тогда` and the current one in the `Иначе`.
		`indent`  only cut occurrences at this indentation. One condition can appear in two
		          places that mean different things - `Если ГодОтчета <= 2013` chooses between
		          two sets of balance line numbers in one place and between two filing schema
		          names in another - and the nesting is what tells them apart.

		Cut back to front so positions stay valid while the text shrinks.
		"""
		opens = []
		for match in re.finditer(re.escape(condition), self.live):
			bol = self.live.rfind(u"\n", 0, match.start()) + 1
			found = self.live[bol:match.start()]
			if found.strip():                       # not the start of a statement
				continue
			if indent is not None and found != indent:
				continue
			opens.append((match.start(), found))
		if not opens:
			raise AssertionError("%s: the condition %r is not in this module%s"
			                     % (self.statement, condition,
			                        " at that indentation" if indent is not None else ""))
		lines = 0
		for open_at, found in reversed(opens):
			else_at = self.live.index(u"\n" + found + keyword, open_at)
			self.live.index(u"\n" + found + u"КонецЕсли", else_at)   # it has to be there
			if dead == u"else":
				lo, hi = else_at, self.live.index(u"\n" + found + u"КонецЕсли", else_at)
			else:
				lo, hi = self.live.index(u"\n", open_at), else_at
			text = self.live[lo:hi]
			if must_contain and not re.search(must_contain, text):
				raise AssertionError("%s: the branch cut at %d does not look like the dead one"
				                     % (self.statement, open_at))
			lines += text.count(u"\n")
			self.live = self.live[:lo] + self.live[hi:]
		# a form may cut more than once, so the count is cumulative
		self._cut = (self._cut[0] + len(opens), self._cut[1] + lines)
		self.counts["dead branches cut"] = "%d, %d source lines" % self._cut
		return self

	# ------------------------------------------------------------------------ adding a rule
	def add(self, line, column, sign, when, side, grain, scope, caption=u""):
		self.rules.append(collections.OrderedDict([
			("line_no", line), ("column", column), ("caption", caption),
			("sign", sign), ("when", when), ("side", side), ("grain", grain),
			("scope", scope),
		]))

	def line_scope(self, ref_line, ref_column, column):
		u"""A reference to another cell: a line, and its column when that is not this one.

		A reference used to be to a line of the SAME column, and one to another column was
		reported as a disagreement, because nothing could represent it. Примітки has 35 of
		them and they are all the same thing - a ROW total, `П710_9 = П710_3 + .. + П710_7` -
		which is what Звіт про власний капітал needed for its column 10 and what the engine
		now carries. So the column is named when it differs and left out when it does not,
		and leaving it out is what the first three forms' 390 references all do.
		"""
		scope = collections.OrderedDict([("lines", [ref_line])])
		if ref_column != column:
			scope["column"] = ref_column
		return scope

	def account_scope(self, debit, credit=None):
		scope = collections.OrderedDict([("include", [debit])])
		if credit is not None:
			scope["includeCredit"] = [credit]
		return scope

	def window(self, measure, prior):
		read_at, side = MEASURE[measure]
		if not prior:
			return read_at, side
		return (self.prior_turnover if read_at == "turnover" else read_at + "_prior"), side

	# --------------------------------------------------- pass 1: the signed sums of helpers
	def read_assignments(self, accumulate=False, line_refs=False, extra=None):
		u"""`П<line><col> = …`, with the options a form needs.

		`accumulate`  a second assignment may begin with the indicator itself, which is more
		              terms for the same line rather than a new shape.
		`line_refs`   the expression may also name other indicators, so a line reads accounts
		              AND lines at once; the engine adds the line part to the account base.
		`extra`       (regex, handler) for whatever else a form puts in these expressions.
		"""
		n_before = len(self.rules)
		accumulated = 0
		for line, column, expr in self.pattern["assign"].findall(self.live):
			if line in self.by_hand:
				continue
			body = expr

			if accumulate:
				me = self.pattern["self"].match(body)
				if me:
					if (me.group(1), me.group(2)) != (line, column):
						# Not an accumulation - an expression that happens to OPEN with
						# another cell. `П775_4 = П491_4` is a cell that copies one, and it is
						# a line reference like any other, so it is left for that pass. Only a
						# form that does not read line references at all can call this wrong.
						if not line_refs:
							self.problems.append(
								"line %s column %s starts from П%s%s, a different indicator"
								% (line, column, me.group(1), me.group(2)))
							continue
					else:
						body = body[me.end():]
						accumulated += 1

			if line_refs:
				for sign, ref_line, ref_column in self.pattern["line_ref"].findall(body):
					self.add(line, column, -1 if sign == "-" else 1, "derived", "none",
					         "line", self.line_scope(ref_line, ref_column, column))
				body = self.pattern["line_ref"].sub("", body)

			if extra is not None:
				pattern, handler = extra
				for match in pattern.finditer(body):
					handler(self, line, column, match)
				body = pattern.sub("", body)

			self.read_terms(line, column, body, whole=expr)

		self.counts["account reads"] = len(self.rules) - n_before
		if accumulate:
			self.counts["accumulating assigns"] = accumulated
		return self

	def read_terms(self, line, column, body, whole=None, outer=1):
		u"""A signed sum of helper calls -> rules on one line and column.

		Its own method in the end, because an assignment is not the only place a form writes
		one. Звіт про власний капітал computes four of its indicators into a COLUMN-LESS
		variable and then prints that into two columns with opposite signs -
		`УстановитьЗначениеПоказателя("П42053", П4205)` and `("П42057", -П4205)` - which is
		Form 2's profit-or-loss split spelled differently: one quantity, two places. The reader
		of that shape hands the variable's expression here, with `outer=-1` for the negated one.

		`whole` is the text to quote if the expression turns out to hold something this cannot
		read. It defaults to `body`; an assignment passes the expression as it was WRITTEN,
		before its self-reference and its line references were taken out of it, because that is
		what someone reading the complaint would go looking for.
		"""
		whole = body if whole is None else whole
		terms = TERM.findall(body)
		if not terms:
			# `= 0` initialises an indicator that later assignments fill; a bare
			# self-reference adds nothing. Neither is an unread shape.
			if body.strip(u" \t\r\n+-()") not in (u"", u"0"):
				self.unparsed.append((line, column, " ".join(whole.split())[:70]))
			return 0
		if TERM.sub("", body).strip(u" \t\r\n+-()"):
			self.unparsed.append((line, column, " ".join(whole.split())[:70]))
			return 0

		added = 0
		for sign, measure, suffix, first, rest in terms:
			prior = (suffix == u"2")
			if self.comparative is not None and prior != (column == self.comparative):
				self.problems.append(
					"line %s column %s: %s%s in a column that wants %s"
					% (line, column, measure, suffix,
					   "the previous period" if column == self.comparative
					   else "the reporting period"))
			read_at, side = self.window(measure, prior)

			args = [x.strip() for x in rest.split(",") if x.strip()]
			second = args[0] if args else None
			if side == "correspondence" and second is None:
				self.problems.append("line %s column %s: %s names one account, needs two"
				                     % (line, column, measure))
				continue
			if len(args) > 1:
				self.problems.append(
					"line %s column %s: %s passes %d further argument(s); its own body "
					"drops them, which needs deciding rather than copying"
					% (line, column, measure, len(args) - 1))
				continue
			debit = self.accounts.get(first)
			credit = self.accounts.get(second) if second else None
			if not debit or (second and not credit):
				self.problems.append(
					"line %s column %s: %s(%s%s) names an account the module never set"
					% (line, column, measure, first, "," + second if second else ""))
				continue
			self.add(line, column, outer * (-1 if sign == "-" else 1), read_at, side, "scope",
			         self.account_scope(debit, credit))
			added += 1
		return added

	# ------------------------------------------------------- pass 3: the lines from lines
	def read_derived(self):
		n_before = len(self.rules)
		term = self.pattern["derived_term"]
		for line, column, expression in self.pattern["derived"].findall(self.live):
			terms = term.findall(expression)
			if not terms or term.sub("", expression).strip(u" \t\r\n+-()"):
				# a bare variable or a `0`; a script reads those by hand if they matter
				continue
			for sign, ref_line, ref_column in terms:
				self.add(line, column, -1 if sign == "-" else 1, "derived", "none", "line",
				         self.line_scope(ref_line, ref_column, column))
		self.counts["derived from lines"] = len(self.rules) - n_before
		return self

	# ------------------------------------------------------------------ pass 4: the checks
	def report(self):
		cur = migrate.pg_connect().cursor()
		cur.execute('SELECT code FROM masterdata.self_supporting WHERE code IS NOT NULL')
		chart = set(row[0] for row in cur.fetchall())

		named, referenced = set(), set()
		for rule in self.rules:
			for role in ("include", "includeCredit", "except"):
				value = rule["scope"].get(role)
				if value:
					named.update([value] if isinstance(value, str) else value)
			referenced.update(rule["scope"].get("lines") or [])
		missing = sorted(code for code in named if code not in chart)
		dangling = sorted(referenced - set(r["line_no"] for r in self.rules))

		wanted = self.wanted
		# spelled the way the FORM spells an indicator, or a separated form would match none
		have = set(r["line_no"] + self.sep + r["column"] for r in self.rules)

		print("rules                      %d over %d lines"
		      % (len(self.rules), len(set(r["line_no"] for r in self.rules))))
		for key, value in self.counts.items():
			print("   %-23s %s" % (key, value))
		print("by side                    debit %d, credit %d, correspondence %d, none %d"
		      % tuple(sum(1 for r in self.rules if r["side"] == s)
		              for s in ("debit", "credit", "correspondence", "none")))
		print("by window                  %s"
		      % dict(collections.Counter(r["when"] for r in self.rules)))
		print("accounts named             %d, not in the chart %d %s"
		      % (len(named), len(missing), missing))
		print("lines named, computed by   nothing: %d %s" % (len(dangling), dangling))
		print("indicators the form sets   %d, covered %d, uncovered %d"
		      % (len(wanted), len(wanted & have), len(wanted - have)))
		if wanted - have:
			print("   %s" % sorted(wanted - have))
		print("expressions not parsed     %d" % len(self.unparsed))
		for row in self.unparsed:
			print("      line %s col %s   %s" % row)
		print("disagreements              %d" % len(self.problems))
		for row in self.problems[:12]:
			print("      " + row)
		return len(self.problems) + len(self.unparsed)

	def write(self):
		path = os.path.join(paths.OUT, "statement-%s.json" % self.statement)
		out = io.open(path, "w", encoding="utf-8")
		out.write(json.dumps({
			"statement": self.statement,
			"title": self.title,
			"source": self.module,
			"description": self.description,
			"rules": self.rules,
		}, ensure_ascii=False, indent="\t", sort_keys=True))
		out.write(u"\n")
		out.close()
		print("\n-> " + path)
		return self


# ==========================================================================================
# From the readings to the module's seed data, and to the index the analytic grain needs.
#
# A rule naming ONE account becomes an `include` of that code, because in 1C a total asked of
# a parent account is the total of its subtree - so "one account" and "a subtree" were never
# two shapes.
#
# Keys are derived from position, not minted: a rule's key is its ordinal within its statement
# and a scope's its own, so regenerating from the same form produces the same keys and a
# reinstall does not duplicate rows. They are numbers rather than UUIDs because the seed
# loader binds a JSON string as `text`, which PostgreSQL will not cast to `uuid` in an INSERT.
#
# Each statement gets its own key range - the project says which - so two forms never collide
# and one can be regenerated without touching the other's rows.

SCOPE_OFFSET = 50000   # so a statement holds up to 50 000 rules and 50 000 scope rows

# How a scope in the extracted form maps to the rows the module stores. A named account and a
# subtree are the same role because they mean the same thing.
ROLE = collections.OrderedDict([
	("account", "include"),
	("subtrees", "include"),
	("include", "include"),
	("includeCredit", "include_credit"),
	("except", "exclude"),
	("exceptCredit", "exclude_credit"),
	("exceptKind", "exclude_kind"),
	("lines", "line"),
	# A line reference may name a COLUMN of its own form; without one it means the column the
	# rule is on. That is what a row total is: line 4300 column 10 is line 4300, columns 3..9.
	("column", "column"),
	# And a rule may read another STATEMENT's line - which statement, which line, which of its
	# columns. Kept in three roles of their own rather than reusing `line`, so that nothing
	# reading `line` has to know the grain to know whose line it is looking at.
	("statement", "statement"),
	("statementLine", "statement_line"),
	("statementColumn", "statement_column"),
])


def read(statement):
	path = os.path.join(paths.OUT, "statement-%s.json" % statement)
	if not os.path.exists(path):
		return None
	return json.load(io.open(path, encoding="utf-8"))


def build(statement, base, spec, rules, scopes):
	seen = collections.Counter()
	first_rule, first_scope = len(rules), len(scopes)
	for r in spec["rules"]:
		line, column = r["line_no"], r["column"]
		seen[(line, column)] += 1
		rule_id = base + (len(rules) - first_rule) + 1
		rules.append(collections.OrderedDict([
			("statement_line_rule_id", rule_id),
			("statement", statement),
			("line_no", line),
			("column_no", column),
			("caption", r.get("caption") or ""),
			("sign", r["sign"]),
			("read_at", r["when"]),
			("side", r["side"]),
			("grain", r["grain"]),
			("rule_no", seen[(line, column)]),
		]))

		parts = []
		for key, role in ROLE.items():
			value = r["scope"].get(key)
			if value is None:
				continue
			for code in ([value] if isinstance(value, str) else value):
				parts.append((role, code))
		if not parts:
			raise AssertionError("%s line %s column %s has no scope" % (statement, line, column))
		for role, code in parts:
			scopes.append(collections.OrderedDict([
				("statement_rule_scope_id",
				 base + SCOPE_OFFSET + (len(scopes) - first_scope) + 1),
				("statement_line_rule_id", rule_id),
				("role", role),
				("code", code),
			]))

	if len(rules) - first_rule > SCOPE_OFFSET or len(scopes) - first_scope > SCOPE_OFFSET:
		raise AssertionError("%s outgrew its key range: %d rules, %d scope rows against %d"
		                     % (statement, len(rules) - first_rule,
		                        len(scopes) - first_scope, SCOPE_OFFSET))


# Where the statements module this port ships keeps what is generated for it.
MODULE_DIR  = os.path.join(paths.MODULES, "statements")
SEED_RULES  = os.path.join(MODULE_DIR, "seed-data", "01-statement_line_rule.json")
SEED_SCOPES = os.path.join(MODULE_DIR, "seed-data", "02-statement_rule_scope.json")
INDEX_SQL   = os.path.join(MODULE_DIR, "logic", "reports", "30-analytic_index.sql")

INDEX_TEMPLATE = u'''-- GENERATED by tools/statements/gen_seed.py - edit that, not this.
--
-- The index the analytic grain needs, over the accounts the forms read that way.
--
-- Розгорнуте сальдо is netted per (account, analytic), so a form has to read the postings of
-- a handful of settlement accounts grouped by the account AND its four analytic columns.
-- Every other read in this module comes from the register's per-period cache, which is keyed
-- by the account on purpose - 24.3M postings carry 99.8M analytic rows, so a cache keyed by
-- those would be about as large as the thing it summarises.
--
-- Measured, that one read WAS the whole cost of the Balance: 490 thousand rows scattered over
-- a 14 GB heap, **56 seconds**, against 2.26 with the index below. It is not CPU and it is
-- not the plan - the rows are found through the register's own account indexes either way. It
-- is half a million random heap fetches, and the fix is for the index to carry what the read
-- projects so there are none: measured 4 554 heap fetches out of 490 thousand rows.
--
-- WHY THE ACCOUNT LIST IS GENERATED INTO THIS FILE rather than read from the rules.
--
-- It was read from `statement_line_rule` at first, which is where it belongs - and that was
-- wrong, because a module's report SQL runs BEFORE its seed data. On a tenant that had the
-- rules from an earlier install it worked; on a virgin one the table was empty, the script
-- concluded that no form reads at the analytic grain, and dropped both indexes. Dropping the
-- statement tables to widen a column reproduced it exactly, and the Balance went from 3.7
-- seconds to 7.5 with no error anywhere.
--
-- So the derivation moved to where the information actually is: the generator that writes the
-- rules writes this list too, from the same extracted form, and they cannot drift. What is
-- generated is the list of ROOT CODES; the subtrees are walked here, against the tenant's own
-- chart. Excludes are deliberately ignored - an index that covers more accounts than a rule
-- needs is larger, never wrong.
--
-- The index has to be PARTIAL. Covering all 24.3M postings with four jsonb columns comes to
-- about 9 GB; restricted to these accounts it is 187 MB. And its predicate has to hold
-- literal uuids, because an index predicate must be immutable and cannot hold a subquery -
-- which is why this is a DO block that builds the DDL rather than plain DDL.
--
-- It is rebuilt only when the set of accounts has actually changed, recorded as a comment on
-- the index rather than compared against `indexdef`, which PostgreSQL normalises into a form
-- a text compare would rebuild on every install. An install that changes nothing does
-- nothing here.
--
-- It indexes another module's table, which is a real smell and is deliberate: `accounting`
-- cannot know which accounts a statement reads at the analytic grain, and `statements` cannot
-- read them quickly without this. The alternative is 1C's own - it keeps `_AccRgAT2840`, a
-- balance per account, subconto and period, 1 551 924 rows - and that is the better answer if
-- this ever needs to survive a form nobody regenerates the index for.

DO $$
DECLARE
\t-- the root codes every rule of grain `analytic` or `by_kind` names, across every form
\tv_codes    text[] := ARRAY[%(codes)s];
\tv_accounts text;
\tv_stamp    text;
\tv_have     text;
BEGIN
\tWITH RECURSIVE tree AS (
\t\t\tSELECT a.self_supporting_id AS node
\t\t\tFROM masterdata.self_supporting a
\t\t\tWHERE a.code = ANY (v_codes)
\t\tUNION ALL
\t\t\tSELECT c.self_supporting_id
\t\t\tFROM tree t
\t\t\tJOIN masterdata.self_supporting c ON c.parent = t.node
\t)
\tSELECT string_agg(quote_literal(t.node::text) || '::uuid', ', ' ORDER BY t.node)
\tINTO v_accounts
\tFROM (SELECT DISTINCT tr.node FROM tree tr) t;

\tIF v_accounts IS NULL THEN
\t\t-- no form reads at the analytic grain, or this chart has none of those accounts
\t\tDROP INDEX IF EXISTS accounting.sx_statements_analytic_dt;
\t\tDROP INDEX IF EXISTS accounting.sx_statements_analytic_ct;
\t\tRETURN;
\tEND IF;

\tv_stamp := md5(v_accounts);

\t-- read through the catalog rather than obj_description('…'::regclass), which RAISES when
\t-- the index is not there yet - the very case this has to handle on a first install
\tSELECT d.description
\tINTO v_have
\tFROM pg_class c
\tJOIN pg_namespace n ON n.oid = c.relnamespace
\tLEFT JOIN pg_description d ON d.objoid = c.oid AND d.classoid = 'pg_class'::regclass
\tWHERE n.nspname = 'accounting' AND c.relname = 'sx_statements_analytic_dt';

\tIF v_have IS NOT NULL AND v_have = v_stamp THEN
\t\tRETURN;
\tEND IF;

\tDROP INDEX IF EXISTS accounting.sx_statements_analytic_dt;
\tDROP INDEX IF EXISTS accounting.sx_statements_analytic_ct;

\tEXECUTE format(
\t\t'CREATE INDEX sx_statements_analytic_dt ON accounting.posting (debit_account_id, period)'
\t\t' INCLUDE (amount, dt_analytic1, dt_analytic2, dt_analytic3, dt_analytic4)'
\t\t' WHERE debit_account_id IN (%%s)', v_accounts);
\tEXECUTE format(
\t\t'CREATE INDEX sx_statements_analytic_ct ON accounting.posting (credit_account_id, period)'
\t\t' INCLUDE (amount, ct_analytic1, ct_analytic2, ct_analytic3, ct_analytic4)'
\t\t' WHERE credit_account_id IN (%%s)', v_accounts);

\tEXECUTE format('COMMENT ON INDEX accounting.sx_statements_analytic_dt IS %%L', v_stamp);
\tEXECUTE format('COMMENT ON INDEX accounting.sx_statements_analytic_ct IS %%L', v_stamp);

\tRAISE NOTICE 'statements: analytic index built for %% account(s)',
\t\tarray_length(string_to_array(v_accounts, ', '), 1);
END $$;
'''


def write_index_sql(specs):
	"""The account list the analytic index covers, taken from the same forms as the rules."""
	codes = set()
	for spec in specs:
		for r in spec["rules"]:
			if r["grain"] not in ("analytic", "by_kind"):
				continue
			for key in ("account", "subtrees", "include"):
				value = r["scope"].get(key)
				if value is None:
					continue
				codes.update([value] if isinstance(value, str) else value)
	if not codes:
		print("%-62s no analytic reads, left alone" % INDEX_SQL)
		return
	literal = ", ".join("'%s'" % code for code in sorted(codes))
	out = io.open(INDEX_SQL, "w", encoding="utf-8", newline="\n")
	out.write(INDEX_TEMPLATE % {"codes": literal})
	out.close()
	print("%-62s %d root codes" % (INDEX_SQL, len(codes)))


def write(path, entity, records):
	out = io.open(path, "w", encoding="utf-8", newline="\n")
	out.write(u'{\n\t"entityCode": "%s",\n\t"records": [\n' % entity)
	for i, rec in enumerate(records):
		comma = "," if i < len(records) - 1 else ""
		body = ", ".join(u'"%s": %s' % (k, json.dumps(v, ensure_ascii=False))
		                 for k, v in rec.items())
		out.write(u"\t\t{ %s }%s\n" % (body, comma))
	out.write(u"\t]\n}\n")
	out.close()
	print("%-62s %d records" % (path, len(records)))




def generate(forms):
	"""Every form's reading -> the module's two seed files, and the index the rules imply."""
	rules, scopes, specs = [], [], []
	for form in forms:
		spec = read(form.statement)
		if spec is None:
			print("%-10s not extracted, skipped" % form.statement)
			continue
		before = len(rules)
		build(form.statement, form.key_base, spec, rules, scopes)
		specs.append(spec)
		print("%-10s %d rules over %d lines"
		      % (form.statement, len(rules) - before,
		         len(set(r["line_no"] for r in spec["rules"]))))

	write(SEED_RULES, "statement_line_rule", rules)
	write(SEED_SCOPES, "statement_rule_scope", scopes)

	# The index covers every form at once, so it may only be rewritten when every form was
	# read. An index written from one form would drop the cover the others need.
	if len(specs) == len(forms):
		write_index_sql(specs)
	else:
		print("%-62s left alone: only %d of %d forms read"
		      % (INDEX_SQL, len(specs), len(forms)))

	assert len(set(r["statement_line_rule_id"] for r in rules)) == len(rules), "rule keys collide"
	assert len(set(s["statement_rule_scope_id"] for s in scopes)) == len(scopes), "scope keys collide"
	print("roles: %s" % dict(collections.Counter(s["role"] for s in scopes)))
	print("reads: %s" % dict(collections.Counter(r["read_at"] for r in rules)))


def main():
	"""Read every regulated form the project declares, then write the module's seed data.

	    python tools/1c.py statements              # every form
	    python tools/1c.py statements balance      # one, leaving the others' seed rows alone
	"""
	import binding

	wanted = sys.argv[1:]
	builders = binding.forms()
	if not builders:
		print("the project at %s declares no forms - see binding.REQUIRED" % paths.PROJECT)
		return 1

	forms, problems = [], 0
	for builder in builders:
		form = builder()
		if wanted and form.statement not in wanted:
			forms.append(form)      # still counted, so the index is not narrowed to one form
			continue
		print("=== %s  <- %s" % (form.statement, form.module))
		problems += form.report()
		form.write()
		forms.append(form)
		print("")

	generate(forms)
	print("")
	print("%d problem(s) across %d form(s)" % (problems, len(forms)))
	return 1 if problems else 0


if __name__ == "__main__":
	sys.exit(main() or 0)
