#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Post and unpost one real document per register binding, and check what happened.

Declaring a register is cheap and looks right in the JSON. Whether a document can actually
post to it is a question only the running platform answers, and the answers so far have
all been no, each for a different reason one line further in than the last. So this is not
a demonstration: every binding in every generated module is found automatically, one real
document is put through it, and each claim is asserted rather than printed.

Per binding:

    the register holds no row this document owns, before
    posting succeeds
    the state flag is set
    one register row per line (or one, from a header binding)
    source names the writing document
    source.line distinguishes the lines - the whole key, not its first column
    the dimension TUPLE takes as many distinct values as there were lines
    unposting leaves the register with none of this document's rows

The document is put back either way, and a refusal is reported with what the platform
said rather than swallowed. Nothing else in the tenant is touched: the register rows
loaded from 1C carry no `source`, so none of them can match a document's own.

    DF_TOKEN=<jwt> python tools/1c.py posting            # every binding
    DF_TOKEN=<jwt> python tools/1c.py posting shipping   # one module

The token is a tenant-scoped JWT. With DF_TOKEN unset the CLI's own session store
(~/.dforge/auth/*.json) is read, which is where `dforge-cli auth login` leaves one; it
lasts an hour. Nothing here holds a credential and nothing writes one down.
"""
from __future__ import print_function

import base64
import codecs
import glob
import io
import json
import os
import re
import sys
import time

import paths

try:
	import urllib.request as request
	import urllib.error as urlerror
except ImportError:                                            # pragma: no cover
	import urllib2 as request                                   # noqa: F401
	import urllib2 as urlerror                                  # noqa: F401


API = os.environ.get("DF_API", "http://localhost:5001") + "/api/exec"

# How many documents a binding gated on its header is tried on before it is reported as
# wanting a new document rather than failed.
GATED_TRIES = 10


# --------------------------------------------------------------------------- the session

def token():
	"""A tenant-scoped JWT, from the environment or from the CLI's session store."""
	found = os.environ.get("DF_TOKEN")
	if found:
		# an expired one is refused here, before a run starts changing anything
		expires = claims(found.strip()).get("exp")
		if expires and expires <= time.time():
			sys.stderr.write(
				"DF_TOKEN expired %d minute(s) ago. Sign in again with\n"
				"    dforge-cli auth login --url %s\n"
				% (int((time.time() - expires) / 60), os.environ.get("DF_API", "http://localhost:5001")))
			raise SystemExit(2)
		return found.strip()

	# The store holds a session per tenant signed into; the newest one may be another tenant's,
	# and a call with it reads as "Folder not found" rather than as the wrong tenant.
	tenant = tenant_id()
	store = os.path.expanduser("~/.dforge/auth")
	best = None
	for path in glob.glob(os.path.join(store, "*.json")):
		try:
			with io.open(path, encoding="utf-8") as handle:
				session = json.load(handle)
		except (ValueError, IOError):
			continue
		if not session.get("AccessToken"):
			continue
		if (session.get("ExpiresAtUtc") or 0) <= time.time():
			continue
		if tenant and claims(session["AccessToken"]).get("tenant_id") != tenant:
			continue
		if best is None or session["ExpiresAtUtc"] > best["ExpiresAtUtc"]:
			best = session
	if best:
		sys.stderr.write("[i] session for %s, %d minute(s) left\n"
		                 % (best.get("UserEmail") or "?",
		                    int((best["ExpiresAtUtc"] - time.time()) / 60)))
		return best["AccessToken"]

	sys.stderr.write(
		"no token%s. Set DF_TOKEN=<jwt>, or sign in with\n"
		"    dforge-cli auth login --url %s\n"
		% (" for tenant %s" % os.environ.get("DF_TENANT") if tenant else "",
		   os.environ.get("DF_API", "http://localhost:5001")))
	raise SystemExit(2)


def claims(jwt):
	"""A JWT's payload, unverified - only to tell which tenant a stored session is for."""
	try:
		part = jwt.split(".")[1]
		return json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)).decode("utf-8"))
	except (IndexError, ValueError, TypeError):
		return {}


def tenant_id():
	"""DF_TENANT's id from the platform's tenant table, or None when it cannot be read."""
	code = os.environ.get("DF_TENANT")
	if not code:
		return None
	try:
		import psycopg2
		conn = psycopg2.connect(
			host=os.environ.get("DF_PG_HOST", "localhost"),
			port=int(os.environ.get("DF_PG_PORT", "5438")),
			dbname=os.environ.get("DF_AUTH_DB", "dforge"),
			user=os.environ.get("DF_PG_USER", "dforge"),
			password=os.environ.get("DF_PG_PASS", "dforge"))
		try:
			cur = conn.cursor()
			cur.execute("select tenant_id::text from public.tenant where tenant_cd = %s", (code,))
			row = cur.fetchone()
		finally:
			conn.close()
	except Exception as e:                                      # noqa: BLE001
		sys.stderr.write("[!] tenant %s not resolved (%s); any stored session is taken\n" % (code, e))
		return None
	return row[0] if row else None


class SessionExpired(SystemExit):
	"""The API refused the token (401): the session ran out mid-run. A SystemExit, so a script's
	broad `except Exception` does not swallow it and go on refusing every document after."""


def call(method, params, folder, jwt):
	body = json.dumps({"method": method, "params": params,
	                   "context": {"folderId": folder}}).encode("utf-8")
	req = request.Request(API, data=body, headers={
		"Content-Type": "application/json", "Authorization": "Bearer " + jwt})
	try:
		return json.loads(request.urlopen(req).read().decode("utf-8"))
	except urlerror.HTTPError as error:
		if error.code == 401:
			sys.stderr.write(
				"\n[!] the API refused the token (401) at %s - the session has expired. Stopped.\n"
				"    Sign in again:  dforge-cli auth login --url %s\n"
				"    then run `posted --mark` to restore any marker this run took off.\n"
				% (method, os.environ.get("DF_API", "http://localhost:5001")))
			raise SessionExpired(3)
		return {"httpError": error.code,
		        "body": error.read().decode("utf-8", "replace")}


# --------------------------------------------------------------------------- the bindings

def bindings(only=None):
	"""Every A column in every generated module, with what it needs to be exercised."""
	found = []
	for path in sorted(glob.glob(os.path.join(paths.MODULES, "*", "entities", "*.json"))):
		module = os.path.basename(os.path.dirname(os.path.dirname(path)))
		if only and module != only:
			continue
		with io.open(path, encoding="utf-8") as handle:
			entity = json.load(handle)
		code = os.path.splitext(os.path.basename(path))[0]
		for column, spec in (entity.get("fields") or {}).items():
			if spec.get("columnType") != "A":
				continue
			params = spec.get("params") or {}
			reference = params.get("register")
			if not reference:
				continue
			found.append({
				"module": module,
				"entity": "%s.%s" % (module, code),
				"code": code,
				"column": column,
				"register": reference,
				"lineEntity": params.get("lineEntity"),
				"lineField": params.get("lineField"),
				"map": params.get("map") or {},
				# Carried even though the checks below read dimensions off the register
				# table rather than the document: a caller asking "where does this
				# binding get each value" gets a wrong answer from `map` alone, and the
				# first such caller silently measured nothing.
				"headerMap": params.get("headerMap") or {},
				"skip": params.get("skipPostingWhenEmpty") or [],
				"group": params.get("groupLinesBy") or [],
			})
	return found


def declarations():
	"""`module.register` -> its declaration, across every module that declares one."""
	found = {}
	for path in sorted(glob.glob(os.path.join(paths.MODULES, "*", "registers.json"))):
		module = os.path.basename(os.path.dirname(path))
		with io.open(path, encoding="utf-8") as handle:
			for code, definition in json.load(handle).items():
				found["%s.%s" % (module, code)] = (module, definition)
	return found


# --------------------------------------------------------------------------- the checks

class Run(object):
	def __init__(self, cursor, jwt):
		self.cursor, self.jwt, self.failed = cursor, jwt, []
		self.folders = {}

	def one(self, sql, *args):
		self.cursor.execute(sql, args)
		row = self.cursor.fetchone()
		return row[0] if row else None

	def folder(self, module):
		# As a string: the RPC declares folderId as one, and a bigint straight out of
		# psycopg2 is rejected by the model binder before the method is reached.
		if module not in self.folders:
			self.folders[module] = str(self.one(
				'select f.folder_id from "dForge".folder f '
				'join "dForge".module m on m.module_id = f.module_id '
				'where m.module_cd = %s order by f.folder_id limit 1', module))
		return self.folders[module]

	def has_column(self, schema, table, column):
		return self.one("""select 1 from information_schema.columns
		                   where table_schema = %s and table_name = %s
		                     and column_name = %s""", schema, table, column) is not None

	def check(self, label, got, want):
		ok = got == want
		print("      %-52s %s" % (
			label, "ok" if ok else "FAIL  got %r, want %r" % (got, want)))
		if not ok:
			self.failed.append(label)
		return ok

	def set_state(self, binding, key, value):
		return call("data.update",
		            {"entity": binding["entity"], "key": key,
		             "values": {binding["column"]: value}},
		            self.folder(binding["module"]), self.jwt)


def refused(result):
	"""The platform's own words, or None when it did not refuse."""
	if "httpError" in result:
		return "HTTP %s %s" % (result["httpError"], result["body"][:300])
	if result.get("code"):
		return "%s: %s %s" % (result["code"], result.get("message", ""),
		                      json.dumps(result.get("details") or {})[:300])
	return None


def plain(value):
	"""A binding value that names a column of the row it is read off.

	The others are not SQL this file can splice in: a quoted constant is stamped, a
	`<reference>.<column>` path is read through a join, and a value starting with `=` is an
	F-column formula the platform translates at posting time.
	"""
	return not (value.startswith("'") or value.startswith("=") or "." in value)


def explain_shortfall(run, binding, definition, document):
	"""Why a posting wrote fewer records than the document had lines.

	Two causes, and they are not the same problem. A line whose dimension is NULL is
	dropped by the engine without a word - found the first time this ran, where two lines
	of a 361-line draft carry no product - and a document that repeats a dimension tuple
	has fewer keys than lines to begin with. The count alone says neither, and the
	difference decides whether the binding is wrong or the data is.
	"""
	if not binding["lineEntity"]:
		return
	source = '"%s"."%s"' % (binding["module"], binding["lineEntity"])
	where = "%s = %%s" % binding["lineField"]
	# Only the dimensions the LINES supply; a headerMap one is the same on every row.
	columns = [binding["map"][d] for d in (definition.get("dimensions") or [])
	           if d in binding["map"] and plain(binding["map"][d])]
	if not columns:
		return
	blank = " or ".join("%s is null" % c for c in columns)
	print("      of the document's lines: %s carry a NULL dimension, %s distinct key(s)"
	      % (run.one("select count(*) from %s where %s and (%s)" % (source, where, blank),
	                 document),
	         run.one("select count(distinct (%s)) from %s where %s"
	                 % (", ".join(columns), source, where), document)))


SLICE = re.compile(r"getSlice\('([\w.]+)',\s*\{\s*(\w+):\s*(?:old)?\[(\w+)\]\s*\},\s*now\(\)\)")
REFUSE = re.compile(r"if \(([^{]*)\)\s*\{\s*error\(")
TEST = re.compile(r"(\w+)\.(\w+)\s*(==|!=)\s*'([^']*)'")


def unpost_lock(binding, declared):
	"""A SQL test, on the candidate `d`, that a synchronous trigger will let it be unposted.

	A module may freeze a posted document - production's rework act is read-only once its
	work shift is not open - and the freeze refuses the unposting too. Posting a document
	that cannot be unposted leaves it posted, so the lock is read off the module's own
	triggers and the candidate chosen where it does not hold. Only the shape the triggers
	use is understood: a slice of an info register at now(), keyed by one of the row's
	columns, and an `error()` under a test of one of its resources. Returns (sql, words),
	or None when no trigger on this entity guards the state flag.
	"""
	folder = os.path.join(paths.MODULES, binding["module"], "logic")
	try:
		with io.open(os.path.join(folder, "triggers.json"), encoding="utf-8") as handle:
			triggers = json.load(handle).get("triggers") or []
	except (IOError, ValueError):
		return None
	for trigger in triggers:
		if trigger.get("entity") != binding["code"] or trigger.get("async", True) \
				or trigger.get("event") not in ("update", "any"):
			continue
		with io.open(os.path.join(folder, "actions", trigger["action"] + ".dsl"),
		             encoding="utf-8") as handle:
			script = handle.read()
		if "old[%s]" % binding["column"] not in script:
			continue
		slice_, refuse = SLICE.search(script), REFUSE.search(script)
		test = TEST.search(refuse.group(1)) if refuse else None
		if not (slice_ and test) or slice_.group(1) not in declared:
			print("      trigger %s guards %s in a shape this file does not read"
			      % (trigger["code"], binding["column"]))
			continue
		variable, resource, operator, value = test.groups()
		module, definition = declared[slice_.group(1)]
		field = (definition.get("resources") or {}).get(resource, {}).get("field", resource)
		current = ('(select r.%s from "%s"."%s" r where r.%s = d.%s and r.%s <= now() '
		           'order by r.%s desc limit 1)'
		           % (field, module, definition["entity"], slice_.group(2), slice_.group(3),
		              definition["period"], definition["period"]))
		refused_when = "%s %s '%s'" % (current, "=" if operator == "==" else "<>", value)
		if "%s == null" % variable in refuse.group(1):
			refused_when = "%s is null or %s" % (current, refused_when)
		return (" and not coalesce(%s, false)" % refused_when,
		        "%s %s %s '%s' (trigger %s)" % (slice_.group(1), resource, operator, value,
		                                       trigger["code"]))
	return None


def exercise(run, binding, declared, tried=()):
	tried = list(tried)
	if not tried:
		print()
		print("   %s.%s -> %s" % (binding["entity"], binding["column"], binding["register"]))

	if binding["register"] not in declared:
		print("      binds a register no module declares")
		run.failed.append(binding["register"])
		return

	module, definition = declared[binding["register"]]
	# Which table holds what a posting wrote. A balance register keeps state in `entity`; a
	# TURNOVER register keeps none and names a `journal` instead, which is the same rows to
	# look at and a different key to find them under.
	# A balance WITH a journal is traced through the journal: its rows carry `source`, and the
	# state's do not.
	held = (definition.get("journal") if definition.get("kind") == "balance"
	        and definition.get("journal") else None) \
		or definition.get("entity") or definition.get("journal")
	if not held:
		print("      register declares neither 'entity' nor 'journal' - nothing to inspect")
		return
	table = '"%s"."%s"' % (module, held)
	pk_column = binding["code"] + "_id"
	# The register's KEY is the whole dimension tuple, not its first column. Asserting
	# uniqueness on one of them held for the first three registers by accident - each had a
	# dimension unique per line - and failed on the first one keyed by a pair, where 2,184
	# lines share 182 groups and are told apart by the metric.
	dimensions = definition.get("dimensions") or []
	dimension_tuple = ", ".join('"%s"' % d for d in dimensions)

	# A document nobody has posted, that has lines if this binding posts from lines.
	#
	# Preferring one the INFOBASE posted is not cosmetic. Those are the documents whose
	# register rows 1C holds, so what the platform writes can be compared against them;
	# a document 1C never posted is a draft, and a draft's lines can be half filled. The
	# first run of this binding picked a 361-line draft whose last two lines carry no
	# product at all, and spent the failure on that rather than on the binding.
	# `posted` is 1C's own flag and most documents here carry it; the few that have no 1C
	# source do not, so it is asked for rather than assumed.
	best = "posted desc, " if run.has_column(binding["module"], binding["code"], "posted") \
		else ""
	# A document marked as posted in 1C (`tools/1c.py posted --mark`) is settled: the engine
	# refuses to post it, which is the point of the marker, so it is not one to try.
	marker = binding["column"] + "_imported"
	unmarked = (" and not coalesce(d.%s, false)" % marker
	            if run.has_column(binding["module"], binding["code"], marker) else "")
	# A document whose skipped dimension is empty posts nothing and stays unposted by design
	# (`LeaveUnpostedAsync`), so it proves nothing about the binding. For a binding that posts
	# from the document, ask for one that has a value there; on lines the check below counts
	# what the skipped lines leave out.
	if not binding["lineEntity"]:
		for dimension in binding["skip"]:
			source = binding["map"].get(dimension, dimension)
			if plain(source):
				unmarked += " and d.%s is not null" % source
	# A draft whose line leaves a dimension empty that the binding does NOT skip on is refused
	# by design - the engine will not key a row on NULL - and that proves nothing about the
	# binding either: it is a half-filled draft. The act's repacking draft with no batch, one
	# 1C never posted, is one; no posted act has a writing line without one.
	half_filled = ""
	if binding["lineEntity"]:
		required = [binding["map"][d] for d in (definition.get("dimensions") or [])
		            if d in binding["map"] and d not in binding["skip"]
		            and plain(binding["map"][d])]
		if required:
			half_filled = (' and not exists (select 1 from "%s"."%s" e where e.%s = d.%s and (%s))'
			               % (binding["module"], binding["lineEntity"], binding["lineField"],
			                  pk_column, " or ".join("e.%s is null" % c for c in required)))
	# A document already tried and skipped whole - see `tried` below.
	if tried:
		unmarked += " and d.%s::text not in (%s)" % (
			pk_column, ", ".join("'%s'" % t for t in tried))
	# Nor one whose movements the infobase already holds. 1C keeps the movements of a document
	# that was written unposted after posting - two recipes do this - and posting it again here
	# would collide with its own loaded rows on the slice key, which says nothing about the binding.
	if run.has_column(module, held, "recorder"):
		unmarked += ' and not exists (select 1 from %s r where r.recorder = d.%s)' % (table, pk_column)
	# Nor one a synchronous trigger will refuse to unpost once posted - it would be left posted.
	lock = unpost_lock(binding, declared)
	free = lock[0] if lock else ""

	def unlockable_none(document, retry):
		"""True, with the binding reported skipped, when only locked candidates remain."""
		if document is None and lock and retry() is not None:
			print("      skipped: no candidate the lock lets unpost - %s" % lock[1])
			return True
		return False

	if binding["lineEntity"]:
		def candidate(extra):
			return run.one(
				'select d.%s from "%s"."%s" d join "%s"."%s" l on l.%s = d.%s '
				'where d.%s = false%s group by d.%s, d.%s order by %scount(*) desc, d.%s limit 1'
				% (pk_column, binding["module"], binding["code"],
				   binding["module"], binding["lineEntity"], binding["lineField"],
				   pk_column, binding["column"], unmarked + extra, pk_column,
				   "posted" if best else pk_column, best, pk_column))
		document = candidate(half_filled + free)
		if unlockable_none(document, lambda: candidate(half_filled)):
			return
		if document is None and half_filled and candidate("") is not None:
			print("      only drafts whose lines leave %s empty remain - refused by design; "
			      "exercise on a new document" % "/".join(required))
			return
		# A line whose skipped dimension is empty records nothing, by declaration, so the
		# lines a posting must account for are the others - the canteen price document
		# records 7 of a 205-line document, the lines whose price changed.
		skipped = [binding["map"].get(d, d) for d in binding["skip"]
		           if d not in binding["headerMap"]]
		filled = "".join(" and %s is not null" % c for c in skipped if plain(c))
		# A grouped binding writes one movement per distinct value of its grouping columns.
		counted = ("distinct (%s)" % ", ".join(binding["group"])) if binding["group"] else "*"
		lines = run.one('select count(%s) from "%s"."%s" where %s = %%s%s'
		                % (counted, binding["module"], binding["lineEntity"], binding["lineField"],
		                   filled),
		                document) if document else 0
	else:
		def candidate(extra):
			return run.one('select %s from "%s"."%s" d where %s = false%s order by %s limit 1'
			               % (pk_column, binding["module"], binding["code"],
			                  binding["column"], unmarked + extra, best + pk_column))
		document = candidate(free)
		if unlockable_none(document, lambda: candidate("")):
			return
		lines = 1

	if document is None:
		if tried:
			print("      no draft that writes in %d tried, and none left - "
			      "exercise on a new document" % len(tried))
		else:
			print("      no unposted, unmarked document to try")
		return
	print("      document %s, %d line(s)" % (document, lines))

	# What a posting leaves behind depends on what kind of register it is, and the two
	# shapes need different questions asked of them.
	#
	# An information register's records ARE its journal: each one is stamped with the
	# document that wrote it, so a posting can be found, counted and traced to its line.
	#
	# A balance register with no journal keeps only state, grouped by its dimensions. A
	# document's contribution is not a row and cannot be found afterwards — several
	# documents add into the same row. So the question is not "which rows are mine" but
	# "did the totals move by what this document says, and did unposting put them back".
	# That is a stronger check than counting rows, and it is the only one available.
	traceable = definition.get("kind") == "info" or definition.get("journal")

	resources = sorted((name, spec.get("field", name))
	                   for name, spec in (definition.get("resources") or {}).items())

	def totals():
		return tuple(run.one("select coalesce(sum(%s), 0) from %s" % (field, table))
		             for _, field in resources)

	def expected():
		"""What the document itself says each resource should move by.

		Read off the lines through the binding's own map, which is the point: if the map
		names the wrong column the totals still move, and only this catches it.
		"""
		source = binding["lineEntity"] or binding["code"]
		where = ("%s = %%s" % binding["lineField"]) if binding["lineEntity"] \
			else ("%s = %%s" % pk_column)
		moved = []
		for name, _ in resources:
			column = binding["map"].get(name)
			if not column or not plain(column):
				moved.append(0)
				continue
			moved.append(run.one('select coalesce(sum(%s), 0) from "%s"."%s" where %s'
			                     % (column, binding["module"], source, where), document))
		return tuple(moved)

	# `source.pk` is an OBJECT keyed by the document's pk columns, not a scalar, and
	# `source.entity` is the bare entity code without its module. Both were asserted the
	# other way round here until a record was written and looked at - which is the whole
	# reason this file exists rather than a paragraph claiming the binding works.
	owned = ("select count(*) from %s where source->'pk'->>'%s' = %%s"
	         % (table, pk_column))
	before = None
	if traceable:
		run.check("rows this document owns, before", run.one(owned, str(document)), 0)
	else:
		before = totals()
		print("      resource totals before  %s" % (before,))

	key = {pk_column: str(document)}
	result = run.set_state(binding, key, True)
	why = refused(result)
	if why:
		print("      POSTING REFUSED  %s" % why)
		run.failed.append("%s.%s post" % (binding["entity"], binding["column"]))
		return

	# A dimension the DOCUMENT supplies and the binding skips on - a headerMap expression that
	# also carries the handler's gates, as the shop-output act's does - can leave the whole
	# document posting nothing, which is right for it and proves nothing here. Only the platform
	# can evaluate the expression, so the document is tried, and on a skip the next one is.
	# When every draft tried is gated - most of the act's drafts are ones 1C never posted - the
	# binding is not exercised here at all, which is neither a pass nor a failure: the flag is off
	# because the engine leaves it off when nothing was written, so asserting it would FAIL a
	# binding that did what it says. It wants a new document instead.
	header_skip = [d for d in binding["skip"] if d in binding["headerMap"]]
	if header_skip and binding["lineEntity"] and not run.one(
			'select %s from "%s"."%s" where %s = %%s'
			% (binding["column"], binding["module"], binding["code"], pk_column), document) \
			and (not traceable or run.one(owned, str(document)) == 0):
		print("      posted nothing: %s came out empty on the document, as declared"
		      % ", ".join(header_skip))
		if len(tried) + 1 >= GATED_TRIES:
			print("      no draft that writes in %d tried - exercise on a new document"
			      % (len(tried) + 1))
			return
		exercise(run, binding, declared, tried + [str(document)])
		return

	try:
		run.check("state flag set",
		          run.one('select %s from "%s"."%s" where %s = %%s'
		                  % (binding["column"], binding["module"], binding["code"],
		                     pk_column), document), True)
		if traceable:
			if not run.check("rows after posting", run.one(owned, str(document)), lines):
				explain_shortfall(run, binding, definition, document)
			run.check("source names the document",
			          run.one("select distinct source->>'entity' from %s "
			                  "where source->'pk'->>'%s' = %%s" % (table, pk_column), str(document)),
			          binding["code"])
			if binding["group"]:
				# A group's movement names the document alone.
				run.check("no source.line on a grouped movement",
				          run.one("select count(*) from %s where source->'pk'->>'%s' = %%s "
				                  "and source ? 'line'" % (table, pk_column), str(document)), 0)
			elif binding["lineEntity"]:
				run.check("source.line distinguishes every line",
				          run.one("select count(distinct source->'line'->'pk') from %s "
				                  "where source->'pk'->>'%s' = %%s" % (table, pk_column), str(document)),
				          lines)
			# Grouped, two groups may map to one dimension (the packing shop's warehouse).
			if dimension_tuple and not binding["group"]:
				run.check("distinct (%s)" % ", ".join(dimensions),
				          run.one("select count(distinct (%s)) from %s "
				                  "where source->'pk'->>'%s' = %%s"
				                  % (dimension_tuple, table, pk_column),
				                  str(document)), lines)
		else:
			after = totals()
			moved = tuple(a - b for a, b in zip(after, before))
			print("      resource totals after   %s" % (after,))
			run.check("totals moved by what the lines say", moved, expected())
	finally:
		result = run.set_state(binding, key, False)
		why = refused(result)
		if why:
			print("      UNPOSTING REFUSED - DOCUMENT %s LEFT POSTED, fix by hand  %s"
			      % (document, why))
			run.failed.append("%s.%s unpost: %s %s LEFT POSTED"
			                  % (binding["entity"], binding["column"], pk_column, document))
			return
		if traceable:
			run.check("rows after unposting", run.one(owned, str(document)), 0)
		else:
			run.check("totals back where they were", totals(), before)


def main():
	only = next((a for a in sys.argv[1:] if not a.startswith("-")), None)

	import migrate
	migrate.load_env()
	connection = migrate.pg_connect()
	connection.autocommit = True

	declared = declarations()
	found = bindings(only)
	print("%d register(s) declared, %d binding(s) to exercise"
	      % (len(declared), len(found)))
	if not found:
		return 0

	run = Run(connection.cursor(), token())
	for binding in found:
		exercise(run, binding, declared)

	print()
	print("%d check(s) failed" % len(run.failed))
	for name in run.failed:
		print("   %s" % name)
	return 1 if run.failed else 0


if __name__ == "__main__":
	sys.exit(main())
