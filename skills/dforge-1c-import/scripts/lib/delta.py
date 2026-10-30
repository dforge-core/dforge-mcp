#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Bring a loaded tenant up to date with what 1C changed since the load: the cutover's delta.

    python tools/1c.py delta [module ...]            # dry run: what changed, per table, timed
    python tools/1c.py delta [module ...] --apply    # write it
    python tools/1c.py delta --status                # the watermarks
    python tools/1c.py delta --baseline [module ...] # mark a tenant loaded before marks existed
    python tools/1c.py delta --since 2026-09-17      # dry run as if loaded on that day

It reads the export, not 1C: bring it up to date with `dump1c data --changes` first (minutes,
where a full `dump1c data` is an hour and more), and the delta is what changed between
the rows the tenant was loaded from and the rows that export holds. Only an export of a
server infobase can carry one - a file infobase's `_Version` is a per-table counter, not a
database-wide rowversion, so a file export has no horizon to read changes against, and a
file infobase is small enough to reload whole (`migrate run --truncate`).

What 1C gives to detect change was measured, not assumed (docs/design-cutover.md section 3.1):

- `_Version` (rowversion) is on the OBJECT tables only - catalogs, documents, charts of
  accounts and characteristic types. Tabular parts, register movements and information
  registers have none. It is database-wide and monotonic, and none of the 472 tables
  carrying it has an index on it - but a full scan of all of them for `_Version >= w` takes
  half a second, so none is needed.
- A deletion leaves no row. It is found by key: every object key 1C holds (2.6 M) is read
  once per run into a temporary table, and a target row whose key is not there was deleted.
- A tabular part changes only with its owner: 1C writes the object whole, so a changed line
  bumps the owner's `_Version`. The lines of a changed owner are replaced.
- A register movement changes only with its recorder, the same way: posting, reposting and
  unposting write the document. The movements of a changed recorder are replaced - read
  through the recorder index (`_RecorderTRef, _RecorderRRef`) every register carries.
- What has neither - an independent information register, an aggregate the map reads
  through a query - is read whole and compared row for row. They are small, bar two.

So each loaded entity is one of four kinds, `object`, `lines`, `movements` and `whole`,
decided from the column map and the schema dump, never named here.

Every row goes through `migrate`'s own planning and conversions (`plan_entity`, `converted`,
`reading`), into a staging table shaped like the target, and is compared there as text, so a
row 1C touched without changing reads as unchanged. The apply runs in replica mode, as the
load does, and ends the same way: `fill_missing` stands a placeholder in for a reference a
deletion left dangling, `seedstate` reseeds a balance whose journal moved, and the
`posted` markers are converged on the documents (that needs a token).

The watermark is kept in the tenant, in `df1c.watermark`, one row per loaded entity: the
`MIN_ACTIVE_ROWVERSION()` 1C reported before the export read the rows (`store.horizon()`). Below it every
transaction had committed, so the next delta reads `_Version >= mark` and misses nothing.
In the tenant rather than a file, because it is a fact about the tenant's rows - written in
the transaction that wrote them, so neither can survive without the other, and a second
tenant loaded from the same infobase keeps its own. `migrate run` writes it too.

A delta assumes the target holds only what 1C gave it: a row keyed by nothing 1C knows is
taken for a deletion. While 1C is the system of record, nothing is entered in the tenant.
"""
from __future__ import print_function

import argparse
import collections
import datetime
import re
import struct
import sys
import time

import migrate
import paths
import store
import transactions

SCHEMA = "df1c"
KEYS_IN_LIST = 500
# Charts of calculation types (`_CKinds`) are objects too - `_IDRRef` and `_Version` like a
# catalog. Leaving them out read every row of the four the standard configuration loads as
# deleted, since their keys never reached the set of live ones.
OBJECT = re.compile(r"^_(Document|Reference|Acc|Chrc|CKinds|Node|BPr|Task)\d+$")
OWNER = re.compile(r"^(_(?:Document|Reference|Acc|Chrc|CKinds|Node)\d+)_IDRRef$")


# --------------------------------------------------------------------------- watermarks

_READY = set()


def ensure(pg):
	if id(pg) in _READY:
		return
	cur = pg.cursor()
	cur.execute("CREATE SCHEMA IF NOT EXISTS %s" % SCHEMA)
	cur.execute("""CREATE TABLE IF NOT EXISTS %s.watermark (
		module     text NOT NULL,
		entity     text NOT NULL,
		source     text NOT NULL,
		version    bytea NOT NULL,
		updated_at timestamptz NOT NULL DEFAULT now(),
		PRIMARY KEY (module, entity))""" % SCHEMA)
	# Entities whose rows a delta moved and whose module has not been settled since - its
	# placeholders, balances and markers. Written in the same transaction as the rows, so a
	# run that dies between the two leaves the next one something to finish.
	cur.execute("""CREATE TABLE IF NOT EXISTS %s.unsettled (
		module     text NOT NULL,
		entity     text NOT NULL,
		since      timestamptz NOT NULL DEFAULT now(),
		PRIMARY KEY (module, entity))""" % SCHEMA)
	_READY.add(id(pg))


def unsettle(pg, module, job):
	pg.cursor().execute("INSERT INTO %s.unsettled (module, entity) VALUES (%%s, %%s)"
	                    " ON CONFLICT DO NOTHING" % SCHEMA, (module, job.entity))


def unsettled(pg, module):
	ensure(pg)
	cur = pg.cursor()
	cur.execute("SELECT entity FROM %s.unsettled WHERE module = %%s" % SCHEMA, (module,))
	return set(r[0] for r in cur.fetchall())


def record(pg, module, job, version, lower_only=False):
	"""Set an entity's mark, inside the caller's transaction."""
	ensure(pg)
	cur = pg.cursor()
	cur.execute("""INSERT INTO {s}.watermark AS w (module, entity, source, version)
	               VALUES (%s, %s, %s, %s)
	               ON CONFLICT (module, entity) DO UPDATE
	               SET version = {v}, source = EXCLUDED.source, updated_at = now()"""
	            .format(s=SCHEMA, v="LEAST(w.version, EXCLUDED.version)" if lower_only
	                    else "EXCLUDED.version"),
	            (module, job.entity, job.source, as_binary(version)))


def marks(pg):
	ensure(pg)
	cur = pg.cursor()
	cur.execute("SELECT module, entity, version, updated_at FROM %s.watermark" % SCHEMA)
	return dict(((m, e), (bytes(v), at)) for m, e, v, at in cur.fetchall())


def as_binary(value):
	import psycopg2
	return psycopg2.Binary(value)


def hexed(raw):
	return "0x" + bytes(raw).hex()


# --------------------------------------------------------------------------- classification

def classify(job, source, mapped):
	"""(kind, detail) for one planned entity. See the module docstring for the four kinds.

	An entity whose query joins in a column from ANOTHER table - the latest status of a
	shipping order, read off an information register that other documents write - is read
	whole: its row changes when that table does, and the owner's `_Version` does not move.
	"""
	if mapped.get("joined"):
		return "whole", None
	columns = source[job.source]["columns"]
	versioned = (columns.get("_Version") or {}).get("type") == "timestamp"
	exposes = not job.query or re.search(r"\b\w+\.\*", job.query)
	keys = [c for c, s in job.pairs if s == "_IDRRef"]
	if versioned and keys and exposes:
		return "object", keys[0]
	for column, src in job.pairs:
		match = OWNER.match(src)
		if match and (source.get(match.group(1), {}).get("columns", {})
		              .get("_Version", {}).get("type") == "timestamp"):
			return "lines", (column, src, match.group(1))
	recorder = [c for c, s in job.pairs if s == "_RecorderRRef"]
	if recorder:
		return "movements", (recorder[0], "_RecorderTRef" in columns)
	return "whole", None


def table_number(name):
	return int(re.search(r"(\d+)$", name).group(1))


# --------------------------------------------------------------------------- what 1C holds

class Infobase(object):
	"""Every object key 1C holds and its `_Version`, read once per run.

	2.7 M keys across 472 tables; the read is a few seconds and is the whole of the change
	detection for objects, lines and movements.
	"""

	def __init__(self, export, source, since):
		self.versions = {}          # table -> [(raw key, raw version)] at or after `since`
		self.now = store.horizon()
		started = time.time()
		self.keys = 0
		self.alive = []
		for name, info in sorted(source.items()):
			if not OBJECT.match(name):
				continue
			if (info["columns"].get("_Version") or {}).get("type") != "timestamp":
				continue
			if "_IDRRef" not in info["columns"]:
				continue
			export.execute('SELECT "_IDRRef", "_Version" FROM %s WHERE "_Version" >= %s'
			              % (store.quote(name), store.literal(since)))
			self.versions[name] = [(bytes(k), bytes(v)) for k, v in export.fetchall()]
			export.execute('SELECT "_IDRRef" FROM %s' % store.quote(name))
			while True:
				batch = export.fetchmany(50000)
				if not batch:
					break
				self.keys += len(batch)
				self.alive.extend(bytes(r[0]) for r in batch)
		self.seconds = time.time() - started

	def changed(self, table, mark):
		return [k for k, v in self.versions.get(table, ()) if v >= mark]

	def changed_documents(self, mark):
		"""{table number: [raw key]} over every document table: the recorders that moved."""
		out = {}
		for name, rows in self.versions.items():
			if not name.startswith("_Document"):
				continue
			keys = [k for k, v in rows if v >= mark]
			if keys:
				out[table_number(name)] = keys
		# Recorders whose accounting entries were switched on or off: the document was not
		# written, so its `_Version` says nothing, and `dump1c data --changes` names them.
		# A run ending AT the mark counts too: entries have no rowversion, so switching them
		# does not move the horizon, and a run can end on the very mark a load was taken at.
		# Taking one too many only re-reads recorders that then compare unchanged.
		for run in store.manifest().get("changes", []):
			if bytes.fromhex(run["to"]) < mark:
				continue
			for table in run["tables"].values():
				for number, keys in (table.get("switched") or {}).items():
					held = out.setdefault(int(number), [])
					seen = set(held)
					held.extend(k for k in map(bytes.fromhex, keys) if k not in seen)
		return out

	def load_alive(self, pg):
		"""The key set into a temporary table, for the anti-joins that find deletions."""
		started = time.time()
		cur = pg.cursor()
		cur.execute("DROP TABLE IF EXISTS pg_temp.df1c_alive")
		cur.execute("CREATE TEMP TABLE df1c_alive (id uuid)")
		for at in range(0, len(self.alive), 200000):
			migrate.copy_rows(pg, "pg_temp", "df1c_alive", ["id"],
			                  [[migrate.to_uuid(k)] for k in self.alive[at:at + 200000]])
		cur.execute("CREATE UNIQUE INDEX ON pg_temp.df1c_alive (id)")
		cur.execute("ANALYZE pg_temp.df1c_alive")
		return time.time() - started


# --------------------------------------------------------------------------- staging

def q(name):
	return '"%s"' % name.replace('"', '""')


def stage(pg, export, job, columns, restricts):
	"""Read the rows `restricts` select from 1C through the load's own conversions into a
	temporary table shaped like the target. `restricts` is a list of alias -> condition
	functions, each one query (a long key list is split), or [None] for the whole source."""
	cur = pg.cursor()
	cur.execute("DROP TABLE IF EXISTS pg_temp.df1c_stage")
	cur.execute('CREATE TEMP TABLE df1c_stage AS SELECT %s FROM "%s"."%s" WITH NO DATA'
	            % (", ".join(q(c) for c in columns), job.schema, job.table))
	select = ", ".join(store.quote(p[1]) for p in job.pairs)
	staged = 0
	for restrict in restricts:
		export.execute("SELECT %s FROM %s" % (select, migrate.reading(job, restrict)))
		while True:
			batch = export.fetchmany(migrate.CHUNK)
			if not batch:
				break
			rows = migrate.converted(job, batch)
			migrate.copy_rows(pg, "pg_temp", "df1c_stage", columns, rows)
			staged += len(rows)
	cur.execute("ANALYZE pg_temp.df1c_stage")
	return staged


def in_lists(keys, column, alias):
	"""`alias.column IN (from_hex(..), ...)`, one condition per slice of the key list."""
	out = []
	for at in range(0, len(keys), KEYS_IN_LIST):
		listed = ", ".join(store.literal(k) for k in keys[at:at + KEYS_IN_LIST])
		out.append(lambda a, listed=listed: "%s.%s IN (%s)" % (a, column, listed))
	return out


def recorder_lists(changed, typed):
	"""Restrictions selecting the movements of the changed recorders, through the recorder
	index: by (TRef, RRef) where the register is written by several kinds, by RRef where it
	is written by one."""
	if not typed:
		keys = [k for group in changed.values() for k in group]
		return in_lists(keys, "_RecorderRRef", None)
	out = []
	for number, keys in sorted(changed.items()):
		tref = store.literal(struct.pack(">I", number))
		for cond in in_lists(keys, "_RecorderRRef", None):
			out.append(lambda a, tref=tref, cond=cond:
			           "%s._RecorderTRef = %s AND %s" % (a, tref, cond(a)))
	return out


def texts(columns, alias):
	return ", ".join("%s.%s::text" % (alias, q(c)) for c in columns)


# --------------------------------------------------------------------------- one entity

class Result(object):
	def __init__(self, module, job, kind):
		self.module, self.job, self.kind = module, job, kind
		self.changed = self.new = self.deleted = 0
		self.owners = 0            # lines/movements: owners or recorders replaced
		self.staged = 0
		self.read = self.compare = self.write = 0.0
		self.note = ""

	@property
	def touched(self):
		return bool(self.changed or self.new or self.deleted)


def has_missing(pg, job):
	return any(c[0] == "is_missing" for c in migrate.table_columns(pg, job.schema, job.table))


def run_entity(pg, export, lookup, base, module, job, kind, detail, mark, apply, now):
	res = Result(module, job, kind)
	job = migrate.bind_enums(job, lookup)
	columns = [p[0] for p in job.pairs] + ([job.derived] if job.derived else [])
	keys = sorted(migrate.primary_key(pg, job.schema, job.table))
	missing = has_missing(pg, job)
	real = " AND NOT t.is_missing" if missing else ""
	target = '"%s"."%s"' % (job.schema, job.table)
	cur = pg.cursor()
	started = time.time()

	if kind == "object":
		key_column = detail
		res.staged = stage(pg, export, job, columns,
		                   [lambda a: "%s._Version >= %s" % (a, store.literal(mark))])
		res.read = time.time() - started
		started = time.time()
		on = " AND ".join("t.%s = s.%s" % (q(k), q(k)) for k in keys)
		cur.execute("SELECT count(*) FILTER (WHERE t.%s IS NULL%s),"
		            " count(*) FILTER (WHERE t.%s IS NOT NULL%s AND ROW(%s) IS DISTINCT FROM ROW(%s))"
		            " FROM pg_temp.df1c_stage s LEFT JOIN %s t ON %s"
		            % (q(keys[0]), " OR t.is_missing" if missing else "",
		               q(keys[0]), " AND NOT t.is_missing" if missing else "",
		               texts(columns, "s"), texts(columns, "t"), target, on))
		res.new, res.changed = cur.fetchone()
		gone = ("FROM %s t WHERE NOT EXISTS (SELECT 1 FROM pg_temp.df1c_alive k"
		        " WHERE k.id = t.%s)%s" % (target, q(key_column), real))
		cur.execute("SELECT count(*) " + gone)
		res.deleted = cur.fetchone()[0]
		res.compare = time.time() - started
		if apply and res.touched:
			started = time.time()
			begin(cur)
			updates = [c for c in columns if c not in keys]
			sets = ", ".join("%s = EXCLUDED.%s" % (q(c), q(c)) for c in updates)
			if missing:
				sets += (", " if sets else "") + "is_missing = false"
			into = columns + (["is_missing"] if missing else [])
			cur.execute("INSERT INTO %s AS t (%s) SELECT %s%s FROM pg_temp.df1c_stage"
			            " ON CONFLICT (%s) DO %s"
			            % (target, ", ".join(q(c) for c in into),
			               ", ".join(q(c) for c in columns), ", false" if missing else "",
			               ", ".join(q(k) for k in keys),
			               ("UPDATE SET %s WHERE ROW(%s%s) IS DISTINCT FROM ROW(%s%s)"
			                % (sets, texts(columns, "t"), ", t.is_missing" if missing else "",
			                   ", ".join("EXCLUDED.%s::text" % q(c) for c in columns),
			                   ", false" if missing else "")) if sets else "NOTHING"))
			cur.execute("DELETE " + gone)
			unsettle(pg, module, job)
			record(pg, module, job, now)
			cur.execute("COMMIT")
			res.write = time.time() - started
		elif apply:
			begin(cur)
			record(pg, module, job, now)
			cur.execute("COMMIT")
		return res

	if kind in ("lines", "movements"):
		if kind == "lines":
			owner, owner_src, owner_table = detail
			changed = base.changed(owner_table, mark)
			restricts = in_lists(changed, owner_src, None)
			changed_ids = [migrate.to_uuid(k) for k in changed]
		else:
			owner, typed = detail
			by_type = base.changed_documents(mark)
			restricts = recorder_lists(by_type, typed)
			changed_ids = [migrate.to_uuid(k) for group in by_type.values() for k in group]
		# Owners the target holds that 1C no longer has: their rows go too.
		cur.execute("DROP TABLE IF EXISTS pg_temp.df1c_owners")
		cur.execute("CREATE TEMP TABLE df1c_owners (id uuid)")
		started_gone = time.time()
		# The anti-join first and the DISTINCT over what survives it - next to nothing -
		# rather than a DISTINCT over the whole table: 75 s against 24 M postings otherwise.
		# More memory for this one statement only. Left on the session it outlived its
		# purpose and a later parallel hash join asked for more shared memory than the
		# container's /dev/shm has ("could not resize shared memory segment").
		cur.execute("SET work_mem = '256MB'")
		cur.execute("INSERT INTO pg_temp.df1c_owners SELECT DISTINCT g.id FROM"
		            " (SELECT t.%s AS id FROM %s t WHERE t.%s IS NOT NULL AND NOT EXISTS"
		            " (SELECT 1 FROM pg_temp.df1c_alive k WHERE k.id = t.%s) OFFSET 0) g"
		            % (q(owner), target, q(owner), q(owner)))
		gone_owners = cur.rowcount
		cur.execute("RESET work_mem")
		gone_seconds = time.time() - started_gone
		if changed_ids:
			migrate.copy_rows(pg, "pg_temp", "df1c_owners", ["id"], [[i] for i in changed_ids])
		cur.execute("CREATE INDEX ON pg_temp.df1c_owners (id)")
		cur.execute("ANALYZE pg_temp.df1c_owners")
		res.owners = len(changed_ids) + gone_owners
		res.staged = stage(pg, export, job, columns, restricts) if restricts else 0
		if not restricts:
			cur.execute("DROP TABLE IF EXISTS pg_temp.df1c_stage")
			cur.execute('CREATE TEMP TABLE df1c_stage AS SELECT %s FROM %s WITH NO DATA'
			            % (", ".join(q(c) for c in columns), target))
		res.read = time.time() - started - gone_seconds
		started = time.time()
		# What the target holds for those owners, taken once: the table may have no index on
		# the owner column (the ledger has none on its recorder), and both directions of the
		# comparison read it.
		cur.execute("DROP TABLE IF EXISTS pg_temp.df1c_old")
		cur.execute("CREATE TEMP TABLE df1c_old AS SELECT %s FROM %s t"
		            " WHERE t.%s IN (SELECT id FROM pg_temp.df1c_owners)"
		            % (", ".join("t.%s" % q(c) for c in columns), target, q(owner)))
		subset = "SELECT %s FROM pg_temp.df1c_old t" % texts(columns, "t")
		staged = "SELECT %s FROM pg_temp.df1c_stage s" % texts(columns, "s")
		cur.execute("SELECT (SELECT count(*) FROM (%s EXCEPT ALL %s) a),"
		            " (SELECT count(*) FROM (%s EXCEPT ALL %s) b)"
		            % (staged, subset, subset, staged))
		res.new, res.deleted = cur.fetchone()
		res.compare = time.time() - started + gone_seconds
		if apply and res.touched:
			started = time.time()
			begin(cur)
			cur.execute("DELETE FROM %s t WHERE t.%s IN (SELECT id FROM pg_temp.df1c_owners)"
			            % (target, q(owner)))
			cur.execute("INSERT INTO %s (%s) SELECT %s FROM pg_temp.df1c_stage"
			            % (target, ", ".join(q(c) for c in columns),
			               ", ".join(q(c) for c in columns)))
			unsettle(pg, module, job)
			record(pg, module, job, now)
			cur.execute("COMMIT")
			res.write = time.time() - started
		elif apply:
			begin(cur)
			record(pg, module, job, now)
			cur.execute("COMMIT")
		return res

	# whole: read it all, compare by key.
	res.staged = stage(pg, export, job, columns, [None])
	res.read = time.time() - started
	started = time.time()
	on = " AND ".join("t.%s = s.%s" % (q(k), q(k)) for k in keys)
	cur.execute("SELECT count(*) FILTER (WHERE t.%s IS NULL%s),"
	            " count(*) FILTER (WHERE t.%s IS NOT NULL%s AND ROW(%s) IS DISTINCT FROM ROW(%s))"
	            " FROM pg_temp.df1c_stage s LEFT JOIN %s t ON %s"
	            % (q(keys[0]), " OR t.is_missing" if missing else "",
	               q(keys[0]), " AND NOT t.is_missing" if missing else "",
	               texts(columns, "s"), texts(columns, "t"), target, on))
	res.new, res.changed = cur.fetchone()
	gone = ("FROM %s t WHERE NOT EXISTS (SELECT 1 FROM pg_temp.df1c_stage s WHERE %s)%s"
	        % (target, on, real))
	cur.execute("SELECT count(*) " + gone)
	res.deleted = cur.fetchone()[0]
	res.compare = time.time() - started
	if apply and res.touched:
		started = time.time()
		begin(cur)
		updates = [c for c in columns if c not in keys]
		sets = ", ".join("%s = EXCLUDED.%s" % (q(c), q(c)) for c in updates)
		if missing:
			sets += (", " if sets else "") + "is_missing = false"
		into = columns + (["is_missing"] if missing else [])
		cur.execute("DELETE " + gone)
		cur.execute("INSERT INTO %s AS t (%s) SELECT %s%s FROM pg_temp.df1c_stage"
		            " ON CONFLICT (%s) DO %s"
		            % (target, ", ".join(q(c) for c in into),
		               ", ".join(q(c) for c in columns), ", false" if missing else "",
		               ", ".join(q(k) for k in keys),
		               ("UPDATE SET %s WHERE ROW(%s) IS DISTINCT FROM ROW(%s)"
		                % (sets, texts(columns, "t"),
		                   ", ".join("EXCLUDED.%s::text" % q(c) for c in columns)))
		               if sets else "NOTHING"))
		unsettle(pg, module, job)
		record(pg, module, job, now)
		cur.execute("COMMIT")
		res.write = time.time() - started
	elif apply:
		begin(cur)
		record(pg, module, job, now)
		cur.execute("COMMIT")
	return res


def begin(cur):
	"""One transaction per entity, in replica mode as the load runs: the generated lock
	and posted-document guards would refuse exactly these rows, and so would a foreign key
	to a row another module brings in later in the same delta."""
	cur.execute("BEGIN")
	cur.execute("SET LOCAL session_replication_role = 'replica'")


# --------------------------------------------------------------------------- after a module

SettleResult = collections.namedtuple("SettleResult", "status notes")


def settlement_exit_code(outcomes, apply):
	"""Dry runs only estimate; an applied but unfinished module must block cutover."""
	return 2 if apply and any(o.status != "ready" for o in outcomes) else 0


def settle(pg, module, results, apply, mark_documents):
	"""What a module needs once its rows moved: placeholders, balances, markers."""
	import posted
	import seedstate
	touched = set(r.job.entity for r in results if r.touched)
	if apply:
		touched |= unsettled(pg, module)
	schemas = sorted(set(r.job.schema for r in results))
	notes = []
	settled = True
	if apply and touched:
		with transactions.writing(pg):
			cur = pg.cursor()
			cur.execute("SET LOCAL session_replication_role = 'replica'")
			filled = migrate.fill_missing(pg, schemas, verbose=False)
			pg.commit()
		if filled:
			notes.append("%d placeholder(s)" % sum(f[4] for f in filled))

	cur = pg.cursor()
	for reg in seedstate.registers(cur, set([module])):
		if reg.journal_entity not in touched:
			continue
		if apply:
			with transactions.writing(pg):
				rows, written, _ = seedstate.seed(pg, reg)
			off = seedstate.drift(pg.cursor(), reg)
			settled = settled and not off
			notes.append("reseeded %s.%s: %d tuple(s), check %s"
			             % (reg.module, reg.code, written,
			                "clean" if not off else "OFF BY %d" % off))
		else:
			notes.append("would reseed %s.%s" % (reg.module, reg.code))

	# A totals cache is not maintained by a bulk write any more than by the load: the
	# platform folds movements in only at posting. `totals` refills it from the journal with
	# the platform's own SQL, transcribed, and checks it the platform's way.
	cur.execute("""SELECT r.register_cd, je.entity_cd FROM "dForge".register r
	               JOIN "dForge".module m ON m.module_id = r.module_id
	               JOIN "dForge".entity je ON je.entity_id = r.journal_entity_id
	               WHERE m.module_cd = %s AND r.totals IS NOT NULL""", (module,))
	stale = set(code for code, journal in cur.fetchall() if journal in touched)
	if stale:
		import totals
		for plan in totals.plans(pg.cursor(), set([module])):
			if plan.code not in stale:
				continue
			if not apply:
				notes.append("would rebuild the totals cache of %s.%s" % (module, plan.code))
				continue
			totals.rebuild(pg, plan)
			_, off = totals.check(pg, plan, 5)
			settled = settled and not off
			notes.append("rebuilt the totals cache of %s.%s, check %s"
			             % (module, plan.code, "clean" if not off else "OFF BY %d" % off))

	work, _, _ = posted.survey(pg, module, quiet=True)
	work = [w for w in work if w[1].split(".", 1)[1] in touched]
	if work:
		if apply and mark_documents:
			done, ok = posted.converge(pg, work, mark_documents)
			settled = settled and ok
			notes.append("markers: %s%s" % (", ".join("%s %d" % kv for kv in done.items()) or
			                                "nothing to do", "" if ok else " (FAILED)"))
		elif apply:
			settled = False
			notes.append("markers NOT converged (no token): run `posted --mark %s`, or this"
			             " again with a token" % module)
		else:
			notes.append("would converge markers on %d document table(s)" % len(work))
	if apply and touched and settled:
		pg.cursor().execute("DELETE FROM %s.unsettled WHERE module = %%s AND entity = ANY(%%s)"
		                    % SCHEMA, (module, sorted(touched)))
	return SettleResult("dry_run" if not apply else ("ready" if settled else "partial"), notes)


# --------------------------------------------------------------------------- command

def since_date(export, source, day):
	"""A watermark for estimation: the lowest `_Version` of any document dated on or after
	`day`. Everything 1C wrote from about then on is at or above it."""
	shifted = "%04d-%s" % (int(day[:4]) + store.year_offset(), day[5:])
	lowest = None
	for name, info in source.items():
		if not name.startswith("_Document") or not OBJECT.match(name):
			continue
		if "_Date_Time" not in info["columns"] or \
				(info["columns"].get("_Version") or {}).get("type") != "timestamp":
			continue
		export.execute("SELECT MIN(_Version) FROM %s WHERE _Date_Time >= '%s'"
		              % (store.quote(name), shifted))
		found = export.fetchone()[0]
		if found is not None and (lowest is None or bytes(found) < lowest):
			lowest = bytes(found)
	if lowest is None:
		raise SystemExit("delta: no document dated on or after %s" % day)
	return lowest


def modules_in_order(mapping):
	try:
		import rebuild
		order = [m for m in rebuild.install_order() if m in mapping]
	except SystemExit:
		order = []
	return order + [m for m in mapping if m not in order]


def main():
	migrate.load_env()
	ap = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
	ap.add_argument("module", nargs="*", help="limit to these modules (default: every one)")
	ap.add_argument("--entity", action="append", help="limit to this entity (repeatable)")
	ap.add_argument("--apply", action="store_true", help="write the delta (default: dry run)")
	ap.add_argument("--dry-run", action="store_true", help="report only (the default)")
	ap.add_argument("--since", help="override every watermark: YYYY-MM-DD (estimation) or 0x...")
	ap.add_argument("--baseline", action="store_true",
	                help="set the mark of every entity that has none to 1C's horizon now")
	ap.add_argument("--status", action="store_true", help="list the watermarks")
	ap.add_argument("--no-mark", action="store_true",
	                help="--apply without converging the posted markers")
	args = ap.parse_args()
	if args.apply and args.dry_run:
		raise SystemExit("delta: --apply and --dry-run together")

	mapping, source = migrate.column_map(), migrate.source_schema()
	pg = migrate.pg_connect()
	pg.autocommit = True          # no read transaction held open on the metadata tables
	modules = [m for m in modules_in_order(mapping) if not args.module or m in args.module]
	unknown = set(args.module) - set(mapping)
	if unknown:
		raise SystemExit("delta: not in the column map: %s" % ", ".join(sorted(unknown)))
	known = marks(pg)

	if args.status:
		for (module, entity), (version, at) in sorted(known.items()):
			if module in modules:
				print("%-12s %-40s %s  %s" % (module, entity, hexed(version), at))
		return 0

	if store.horizon() is None:
		raise SystemExit("delta: the export in %s has no horizon - %s.\n"
		                 "    Reload instead: `dump1c data`, then `migrate run <module> --truncate`."
		                 % (paths.OUT, "a file infobase's row versions are per table"
		                    if store.source_kind() == "file" else "a table in it was exported without one"))
	# Every object table is read for its keys - a deletion is a key 1C no longer holds, and
	# a recorder is any object - so one left out of the export is every row it owns taken
	# for deleted. Asked here, by name, rather than as DuckDB's "Table _Acc33 does not exist".
	exported = store.manifest()["tables"]
	missing = sorted(n for n, info in source.items() if OBJECT.match(n) and n not in exported
	                 and (info["columns"].get("_Version") or {}).get("type") == "timestamp")
	if missing:
		raise SystemExit("delta: %d object table(s) are not in the export (%s%s) - every object's keys"
		                 " are needed.\n    `1c.py dump1c data --objects` exports them all."
		                 % (len(missing), ", ".join(missing[:5]), ", ..." if len(missing) > 5 else ""))
	db = migrate.source_connect()
	export, lookup = db.cursor(), db.cursor()
	plan = []
	for module in modules:
		for job in migrate.jobs_for(pg, module, mapping, source, args.entity):
			if job.blocking:
				continue
			plan.append((module, job))

	if args.baseline:
		now = store.horizon()
		set_ = 0
		cur = pg.cursor()
		cur.execute("BEGIN")
		for module, job in plan:
			if (module, job.entity) not in known:
				record(pg, module, job, now)
				set_ += 1
		cur.execute("COMMIT")
		print("baseline %s set on %d entit(ies); %d already had one."
		      % (hexed(now), set_, len(plan) - set_))
		print("Only right if the tenant holds what 1C holds NOW - straight after a full load"
		      " during which 1C did not change.")
		return 0

	override = None
	if args.since:
		override = (bytes.fromhex(args.since[2:]) if args.since.startswith("0x")
		            else since_date(export, source, args.since))
	unmarked = [(m, j.entity) for m, j in plan if (m, j.entity) not in known]
	if unmarked and override is None:
		raise SystemExit("delta: %d entit(ies) have no watermark (e.g. %s.%s) - load them with"
		                 " `migrate run`, or `delta --baseline` if the tenant already matches 1C"
		                 % (len(unmarked), unmarked[0][0], unmarked[0][1]))

	def mark_of(module, job):
		return override if override is not None else known[(module, job.entity)][0]

	lowest = min(mark_of(m, j) for m, j in plan)
	t0 = time.time()
	base = Infobase(export, source, lowest)
	alive_seconds = base.load_alive(pg)
	print("export horizon %s, reading from %s%s" % (hexed(base.now), hexed(lowest),
	                                             " (--since %s)" % args.since if args.since else ""))
	print("object keys: %d read in %.1fs, %.1fs into the tenant"
	      % (base.keys, base.seconds, alive_seconds))
	print("%s\n" % ("APPLYING" if args.apply else "dry run - nothing written; --apply writes it"))

	jwt = None
	if args.apply and not args.no_mark:
		try:
			import posting
			jwt = posting.token()
		except SystemExit as missing:
			print("no token (%s) - markers will be left for `posted --mark`" % missing)

	header = "%-11s %-34s %-9s %8s %8s %8s %8s %7s %7s %7s" % (
		"module", "entity", "kind", "owners", "changed", "new", "deleted",
		"read s", "cmp s", "write s")
	print(header)
	print("-" * len(header))
	totals = [0, 0, 0, 0, 0.0]
	all_notes = []
	outcomes = []
	for module in modules:
		results = []
		for m, job in plan:
			if m != module:
				continue
			kind, detail = classify(job, source, mapping[module][job.entity])
			res = run_entity(pg, export, lookup, base, module, job, kind, detail,
			                 mark_of(module, job), args.apply, base.now)
			results.append(res)
			totals[0] += res.changed
			totals[1] += res.new
			totals[2] += res.deleted
			totals[3] += res.owners
			totals[4] += res.read + res.compare + res.write
			if res.touched or res.owners or res.read + res.compare > 2 or args.entity:
				print("%-11s %-34s %-9s %8s %8d %8d %8d %7.1f %7.1f %7.1f"
				      % (module, job.entity[:34], kind,
				         res.owners if kind in ("lines", "movements") else "",
				         res.changed, res.new, res.deleted, res.read, res.compare, res.write))
				sys.stdout.flush()
		try:
			outcome = settle(pg, module, results, args.apply, jwt if args.apply else None)
		except transactions.ConnectionRecoveryError:
			raise  # Never continue on a connection whose cleanup failed.
		except Exception as failure:
			if not args.apply:
				raise
			transactions.recover(pg)
			outcome = SettleResult("partial", ["settlement FAILED: %s: %s"
			                                  % (type(failure).__name__, failure)])
		outcomes.append(outcome)
		all_notes.append("%s: status %s%s" % (module, outcome.status,
		                                      "" if args.apply else " (estimate only, not a readiness verdict)"))
		for note in outcome.notes:
			all_notes.append("%s: %s" % (module, note))
	print("-" * len(header))
	print("%d entities  changed %d  new %d  deleted %d  (owners/recorders replaced %d)"
	      % (len(plan), totals[0], totals[1], totals[2], totals[3]))
	print("entity work %.0fs, whole run %.0fs" % (totals[4], time.time() - t0))
	for note in all_notes:
		print("  " + note)
	print("(rows of an entity with nothing changed and under 2s are not listed;"
	      " lines/movements count rows replaced as new/deleted)")
	code = settlement_exit_code(outcomes, args.apply)
	if code:
		print("delta incomplete (%s): do not cut over; resolve the notes and rerun --apply."
		      % ", ".join(m for m, o in zip(modules, outcomes) if o.status != "ready"))
	return code


if __name__ == "__main__":
	sys.exit(main() or 0)
