#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
1C names -> dForge codes.

`мсбРасходЭнергоресурсов` has to become `utilities_issue`, `КоличествоМест` has to become
`places_qty`, and 2,620 of these cannot be typed by hand. The rule is: strip the
integrator's prefix, split the CamelCase compound into words, translate each word through
`terms.TERMS`, drop the prepositions, and join with underscores.

Two things keep the result usable rather than merely mechanical:

  * unknown words are transliterated, not dropped, and every one is recorded so
    `python tools/naming.py` can print what the dictionary is still missing;
  * codes are shortened and de-duplicated per scope, because Postgres identifiers are
    capped at 63 characters and 1C names run long.

    python tools/naming.py                  # coverage report over the whole scope
    python tools/naming.py <1C name> ...    # what these particular names become
"""
from __future__ import print_function

import collections
import re
import sys

import terms
import terms_uk

import binding
import paths

# The integrator's and the embedded toolkit's prefixes are tags, not words.
_TAGS = binding.client_prefixes() + binding.toolkit_prefixes()
PREFIX = re.compile(u"^(%s)" % u"|".join(re.escape(p) for p in _TAGS) if _TAGS else u"(?!)")

# Keeps acronym runs together (ГТД, НН, АТТ) instead of splitting them letter by letter.
WORD = re.compile(u"[А-ЯЁA-Z]+(?![а-яёa-z])|[А-ЯЁA-Z][а-яёa-z]*|[а-яёa-z]+|\\d+")

TRANSLIT = {
	u"а": "a", u"б": "b", u"в": "v", u"г": "g", u"д": "d", u"е": "e", u"ё": "e",
	u"ж": "zh", u"з": "z", u"и": "i", u"й": "y", u"к": "k", u"л": "l", u"м": "m",
	u"н": "n", u"о": "o", u"п": "p", u"р": "r", u"с": "s", u"т": "t", u"у": "u",
	u"ф": "f", u"х": "h", u"ц": "ts", u"ч": "ch", u"ш": "sh", u"щ": "sch",
	u"ъ": "", u"ы": "y", u"ь": "", u"э": "e", u"ю": "yu", u"я": "ya",
	u"і": "i", u"ї": "i", u"є": "ie", u"ґ": "g",
}

# Words the dictionary had no entry for, collected so the gap is visible rather than
# silently transliterated away.
UNKNOWN = collections.Counter()

MAX_LEN = 55  # Postgres caps identifiers at 63; leave room for the "_id" suffix and more

# A column named after a Postgres reserved word passes every JSON schema and then fails
# the module import with a raw `syntax error at or near "order"`, because not every
# statement dForge generates quotes its identifiers. These are the collisions the port
# actually hits; the names are the ones already installed, so regenerating does not move
# a column that exists in the tenant. Anything new falls back to a `_col` suffix, which
# `validate.check_reserved` will catch if it ever stops being enough.
RESERVED_RENAME = {
	"order": "order_id",
	"user": "user_id",
	"natural": "natural_qty",
}

RESERVED_WORDS = set("""
all analyse analyze and any array as asc asymmetric authorization binary both case cast
check collate collation column concurrently constraint create cross default deferrable
desc distinct do else end except false fetch for foreign freeze from full grant group
having ilike in initially inner intersect into is isnull join lateral leading left like
limit natural not notnull null offset on only or order outer overlaps placing primary
references returning right select similar some symmetric table tablesample then to
trailing true union unique user using variadic verbose when where window with
""".split())


def translit(word):
	return "".join(TRANSLIT.get(ch, ch if ch.isalnum() else "") for ch in word.lower())


def words(name):
	"""`мсбРасходЭнергоресурсов` -> ['Расход', 'Энергоресурсов']"""
	return WORD.findall(PREFIX.sub("", name or ""))


def is_dead(name):
	"""1C keeps retired attributes under an `Удалить...` name. They are not ported."""
	head = words(name)
	return bool(head) and head[0].lower().startswith(terms.DEAD_PREFIXES)


def code(name, max_len=MAX_LEN, avoid_reserved=True):
	"""1C name -> a snake_case dForge code.

	`avoid_reserved` is on for anything that becomes a Postgres identifier and off for
	anything that becomes a value - a dropdown option code is stored in the column, not
	used as its name, so renaming it would change the data rather than protect it.
	"""
	out = []
	for word in words(name):
		low = word.lower()
		if low in terms.STOP:
			continue
		english = terms.TERMS.get(low)
		if english is None:
			UNKNOWN[low] += 1
			english = translit(low)
		if not english:
			continue
		# `положение` -> `position` twice in a row reads worse than once
		if out and out[-1] == english:
			continue
		out.append(english)
	result = "_".join(out).strip("_")
	result = re.sub(r"_{2,}", "_", result)
	if not result:
		result = translit(name) or "field"
	if result[0].isdigit():
		result = "n" + result
	while len(result) > max_len and "_" in result:
		result = result.rsplit("_", 1)[0]
	result = result[:max_len]
	if avoid_reserved and result in RESERVED_WORDS:
		result = RESERVED_RENAME.get(result, result + "_col")
	return result


def label(name):
	"""1C name or synonym -> an English label. `Количество мест` -> `Qty places`."""
	out = []
	for word in words(name):
		low = word.lower()
		if low in terms.STOP:
			continue
		english = terms.TERMS.get(low)
		if english is None:
			UNKNOWN[low] += 1
			english = translit(low)
		if english and (not out or out[-1] != english):
			out.append(english.replace("_", " "))
	text = " ".join(out).strip()
	if not text:
		text = translit(name)
	return text[0].upper() + text[1:] if text else "Field"


MISSING_UK = collections.Counter()


def label_uk(name):
	"""1C name or synonym -> a Ukrainian label.

	Word for word, keeping the order and the case endings the Russian already carries -
	`Расход материалов` is `Витрата матеріалів`. Prepositions are translated rather than
	dropped, because a label is read as a phrase. A word the dictionary does not have is
	left in Russian and counted, so the gap shows up rather than passing as translated.
	"""
	source = [w for w in words(name) if w.lower() not in terms_uk.DROP]
	out, index = [], 0
	while index < len(source):
		phrase = terms_uk.PHRASES.get(
			tuple(w.lower() for w in source[index:index + 2]))
		if phrase is not None:
			out.append(phrase)
			index += 2
			continue
		word = source[index]
		low = word.lower()
		translated = terms_uk.PREPOSITIONS.get(low) or terms_uk.UK.get(low)
		if translated is None:
			MISSING_UK[low] += 1
			translated = word
		if translated and (not out or out[-1] != translated):
			out.append(translated)
		index += 1
	text = " ".join(out).strip()
	if not text:
		return None
	return text[0].upper() + text[1:]


def unique(name, taken, max_len=MAX_LEN, avoid_reserved=True):
	"""`code()` with a numeric suffix if that code is already spoken for in this scope."""
	base = code(name, max_len, avoid_reserved)
	if base not in taken:
		taken.add(base)
		return base
	for n in range(2, 100):
		candidate = "%s_%d" % (base[:max_len - 3], n)
		if candidate not in taken:
			taken.add(candidate)
			return candidate
	raise ValueError("cannot make %r unique" % base)


def report():
	"""How well the dictionary covers the porting scope."""
	import codecs
	import json
	import os
	import attrs

	root = paths.ROOT
	with codecs.open(os.path.join(root, "out", "report.json"), "r", "utf-8") as f:
		rows = json.load(f)
	objects = attrs.load_json("objects.json")
	types = attrs.load_json("typemap.json")

	scope = [r for r in rows
	         if (r["name"] or "").startswith(binding.client_prefixes())
	         and ((r["rows"] or 0) or r["childRows"])]

	names, fields = 0, 0
	for row in scope:
		code(row["name"])
		label_uk(row.get("synonym") or row["name"])
		names += 1
		_, extracted = attrs.fields_of(row["name"], objects, types)
		for field in (extracted or []):
			if is_dead(field["name"]):
				continue
			code(field["name"])
			label_uk(field.get("synonym") or field["name"])
			fields += 1

	print("named %d objects and %d fields" % (names, fields))

	if UNKNOWN:
		print("\nEnglish: %d words fell back to transliteration (%d occurrences)"
		      % (len(UNKNOWN), sum(UNKNOWN.values())))
		for word, n in UNKNOWN.most_common(40):
			print("   %-32s %3d  -> %s" % (word, n, translit(word)))
	else:
		print("English: every word was in terms.py")

	if MISSING_UK:
		print("\nUkrainian: %d words left in Russian (%d occurrences)"
		      % (len(MISSING_UK), sum(MISSING_UK.values())))
		for word, n in MISSING_UK.most_common(40):
			print("   %-32s %3d" % (word, n))
	else:
		print("Ukrainian: every word was in terms_uk.py")


if __name__ == "__main__":
	if len(sys.argv) > 1:
		for argument in sys.argv[1:]:
			print("%-52s %s" % (argument, code(argument)))
	else:
		report()
