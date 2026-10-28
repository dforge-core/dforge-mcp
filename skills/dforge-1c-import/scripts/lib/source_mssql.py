# -*- coding: utf-8 -*-
"""
A server infobase on MS SQL as an export source. The only module in the library that
speaks T-SQL to 1C; everything past the export reads `out/` (see `store.py`).

Credentials come from env DF1C_USER / DF1C_PASS; without them, Windows auth is used.

The export takes 1C's horizon - `MIN_ACTIVE_ROWVERSION()` - before it reads a table, so a
delta read off the next export picks up everything this one may have missed.
"""
import os
import sys

import dump1c

PREFERRED_DRIVERS = (
	"ODBC Driver 18 for SQL Server",
	"ODBC Driver 17 for SQL Server",
	"ODBC Driver 13 for SQL Server",
	"SQL Server Native Client 11.0",
	"SQL Server",
)

# A server infobase created without the offset option still has the table; one that has
# lost it is old enough to have been created with the offset.
DEFAULT_YEAR_OFFSET = 2000


def connect(server, db):
	import pyodbc
	available = set(pyodbc.drivers())
	driver = next((d for d in PREFERRED_DRIVERS if d in available), None)
	if driver is None:
		raise RuntimeError("no SQL Server ODBC driver found: %r" % sorted(available))
	parts = ["DRIVER={%s}" % driver, "SERVER=%s" % server, "DATABASE=%s" % db,
	         "TrustServerCertificate=yes"]
	user, pwd = os.environ.get("DF1C_USER"), os.environ.get("DF1C_PASS")
	if user:
		parts += ["UID=%s" % user, "PWD=%s" % pwd]
	else:
		parts += ["Trusted_Connection=yes"]
	sys.stderr.write("[i] %s / %s via %s\n" % (server, db, driver))
	return pyodbc.connect(";".join(parts), autocommit=True)


class MssqlSource(object):
	kind = "mssql"
	consistent = "per table: each is read after its horizon is taken"

	def __init__(self, server, db):
		self.server, self.db = server, db
		self.conn = connect(server, db)
		self.cur = self.conn.cursor()
		self._partno = {}
		self._offset = None

	def describe(self):
		return {"kind": self.kind, "server": self.server, "database": self.db}

	@property
	def year_offset(self):
		if self._offset is None:
			try:
				self.cur.execute("SELECT Offset FROM _YearOffset")
				row = self.cur.fetchone()
				self._offset = int(row[0]) if row else DEFAULT_YEAR_OFFSET
			except Exception:
				sys.stderr.write("[!] no _YearOffset; assuming %d\n" % DEFAULT_YEAR_OFFSET)
				self._offset = DEFAULT_YEAR_OFFSET
		return self._offset

	def has_partno(self, table):
		"""8.3 splits large files across rows by PartNo; 8.2 stores one row per file."""
		if table not in self._partno:
			self.cur.execute("SELECT COUNT(*) FROM sys.columns WHERE object_id = OBJECT_ID(?)"
			                 " AND name = 'PartNo'", table)
			self._partno[table] = self.cur.fetchone()[0] > 0
		return self._partno[table]

	def files(self, table):
		self.cur.execute("SELECT DISTINCT FileName FROM %s" % table)
		return sorted(r[0] for r in self.cur.fetchall())

	def read_file(self, table, name):
		"""Concatenate a file's parts in order, then inflate."""
		order = " ORDER BY PartNo" if self.has_partno(table) else ""
		self.cur.execute("SELECT BinaryData FROM %s WHERE FileName = ?%s" % (table, order), name)
		blob = b"".join(bytes(r[0]) for r in self.cur.fetchall() if r[0] is not None)
		return dump1c.inflate(blob)

	def tables(self):
		self.cur.execute("""SELECT t.name, c.name, ty.name, c.max_length, c.precision, c.scale, c.is_nullable
		                    FROM sys.tables t
		                    JOIN sys.columns c ON c.object_id = t.object_id
		                    JOIN sys.types ty ON ty.user_type_id = c.user_type_id
		                    ORDER BY t.name, c.column_id""")
		tables = {}
		for tn, cn, ty, ml, pr, sc, nullable in self.cur.fetchall():
			tables.setdefault(tn, []).append({
				"column": cn, "type": ty, "len": ml,
				"precision": pr, "scale": sc, "nullable": bool(nullable),
			})
		self.cur.execute("""SELECT t.name, SUM(p.rows) FROM sys.tables t
		                    JOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0, 1)
		                    GROUP BY t.name""")
		rows = dict(self.cur.fetchall())
		return [(name, cols, rows.get(name)) for name, cols in sorted(tables.items())]

	def rows(self, table, columns, chunk, where=None):
		"""Batches of rows; `where` is a T-SQL condition on the table's own columns."""
		cur = self.conn.cursor()
		cur.execute("SELECT %s FROM [%s]%s" % (", ".join("[%s]" % c for c in columns), table,
		                                       " WHERE " + where if where else ""))
		while True:
			batch = cur.fetchmany(chunk)
			if not batch:
				break
			yield [tuple(r) for r in batch]

	def column(self, sql):
		"""The first column of a query, every row."""
		cur = self.conn.cursor()
		cur.execute(sql)
		out = []
		while True:
			batch = cur.fetchmany(100000)
			if not batch:
				return out
			out.extend(r[0] for r in batch)

	def triples(self, sql):
		"""The first three columns of a query, every row."""
		cur = self.conn.cursor()
		cur.execute(sql)
		return [(r[0], r[1], r[2]) for r in cur.fetchall()]

	def horizon(self):
		"""Below it every transaction had committed: a read after it misses nothing older."""
		self.cur.execute("SELECT MIN_ACTIVE_ROWVERSION()")
		return bytes(self.cur.fetchone()[0])

	# ------------------------------------------------------------------- diagnostics

	def databases(self):
		"""Which databases does this login actually see? Separates a bad password from missing rights."""
		self.cur.execute("SELECT name, state_desc, HAS_DBACCESS(name) FROM sys.databases ORDER BY name")
		return self.cur.fetchall()

	def probe(self):
		self.cur.execute("SELECT @@VERSION")
		lines = [self.cur.fetchone()[0].splitlines()[0]]
		for table in ("Config", "ConfigSave", "Params", "DBSchema", "_YearOffset"):
			try:
				self.cur.execute("SELECT COUNT(*) FROM [%s]" % table)
				lines.append("  %-12s rows=%s" % (table, self.cur.fetchone()[0]))
			except Exception as exc:
				lines.append("  %-12s -- %s" % (table, str(exc).split("]")[-1].strip()[:70]))
		return lines
