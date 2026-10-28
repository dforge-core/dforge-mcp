# -*- coding: utf-8 -*-
"""
The infobase as everything past the export sees it: `out/data/<table>.parquet`, one view
per table, queried with DuckDB. Nothing here knows whether the export came from MS SQL or
from a file infobase - `dump1c` made them the same - and nothing past here talks to 1C.

    cur = store.connect().cursor()
    cur.execute('SELECT "_IDRRef", "_EnumOrder" FROM "_Enum12"')

The SQL is DuckDB's, so a project's `sources.QUERIES` are too: names in double quotes
(DuckDB matches them without regard to case), `LIMIT` for `TOP`, `from_hex('..')` - see
`literal` - for a binary constant. The values are as 1C stores them: a server infobase's
dates still carry its year offset (`year_offset()`), a boolean is binary(1).

The cursor takes parameters the way pyodbc did, `execute(sql, a, b)` or `execute(sql, [a, b])`,
so the readers of the infobase kept their shape when they stopped reading MS SQL.
"""
import codecs
import json
import os

import paths

DATA = os.path.join(paths.OUT, "data")
MANIFEST = os.path.join(paths.OUT, "export.json")

# A boolean as 1C stores it, binary(1): `_Posted`, `_Marked`, `_Folder`.
TRUE = b"\x01"

_MANIFEST = []


def manifest():
	if not _MANIFEST:
		if not os.path.exists(MANIFEST):
			raise SystemExit("no export in %s - run `1c.py dump1c all` first" % paths.OUT)
		with codecs.open(MANIFEST, "r", "utf-8") as f:
			_MANIFEST.append(json.load(f))
	return _MANIFEST[0]


def year_offset():
	"""What 1C adds to a year when it stores a date: 2000 on MS SQL as a rule, 0 in a file."""
	return int(manifest().get("year_offset", 0))


def source_kind():
	return manifest()["source"]["kind"]


def horizon():
	"""The oldest horizon any exported table was read after, or None for a file export.

	Every change 1C committed below it is in the export. One mark for the whole export
	rather than one per table is the cautious reading: a declared query may join tables
	read at different moments, and a mark too low only re-reads, never misses.
	"""
	marks = [t.get("horizon") for t in manifest()["tables"].values()]
	if not marks or any(m is None for m in marks):
		return None
	return bytes.fromhex(min(marks))


def literal(raw):
	"""A binary constant in SQL - what `0x...` was in T-SQL."""
	return "from_hex('%s')" % bytes(raw).hex()


def quote(name):
	return '"%s"' % name.replace('"', '""')


class Cursor(object):
	def __init__(self, con):
		self.con = con

	def execute(self, sql, *params):
		if len(params) == 1 and isinstance(params[0], (list, tuple)):
			params = params[0]
		self.con.execute(sql, list(params))
		return self

	@property
	def description(self):
		return self.con.description

	def fetchone(self):
		return self.con.fetchone()

	def fetchall(self):
		return self.con.fetchall()

	def fetchmany(self, size):
		return self.con.fetchmany(size)


class Database(object):
	def __init__(self):
		import duckdb
		self.con = duckdb.connect()
		# Spill under out/, and only so far. A query that loses its window - a LATERAL join
		# DuckDB filters above rather than at the scan - reads all 99.8 M analytic rows and
		# spilled 17 GB before it died, nearly the whole of the disk it shared with the system.
		spill = os.path.join(paths.OUT, ".duckdb")
		self.con.execute("SET temp_directory = '%s'" % spill.replace("\\", "/").replace("'", "''"))
		self.con.execute("SET max_temp_directory_size = '%s'" % os.environ.get("DF1C_DUCKDB_TEMP", "8GB"))
		tables = manifest()["tables"]
		for name in sorted(tables):
			path = os.path.join(DATA, name + ".parquet")
			if os.path.exists(path):
				self.con.execute("CREATE VIEW %s AS SELECT * FROM read_parquet('%s')"
				                 % (quote(name), path.replace("\\", "/").replace("'", "''")))
		self.tables = tables

	def cursor(self):
		return Cursor(self.con.cursor())


_DB = []


def connect():
	"""One DuckDB per process; each cursor is its own connection to it."""
	if not _DB:
		_DB.append(Database())
	return _DB[0]
