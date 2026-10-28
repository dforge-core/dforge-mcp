#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Read a 1C:Enterprise 8 infobase hosted on MS SQL Server *without* any 1C software.

Everything needed to rebuild the data model lives in two service tables:
  Params  -> row FileName='DBNames': GUID -> physical table/column name map
  Config  -> the configuration itself, one row (8.2) or several PartNo rows (8.3) per file

File bodies are raw-deflate compressed (no zlib header).

Credentials come from env DF1C_USER / DF1C_PASS; without them, Windows auth is used.
Server and database default to DF1C_SERVER / DF1C_DB.
"""
import argparse
import codecs
import json
import os
import re
import struct
import sys
import zlib

import paths

OUT = paths.OUT

PREFERRED_DRIVERS = (
	"ODBC Driver 18 for SQL Server",
	"ODBC Driver 17 for SQL Server",
	"ODBC Driver 13 for SQL Server",
	"SQL Server Native Client 11.0",
	"SQL Server",
)


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


def inflate(data):
	"""1C stores file bodies as raw deflate; a few small ones are stored plain."""
	if not data:
		return b""
	data = bytes(data)
	for attempt in (lambda: zlib.decompressobj(-15).decompress(data), lambda: zlib.decompress(data)):
		try:
			return attempt()
		except zlib.error:
			continue
	return data


_HAS_PARTNO = {}


def has_partno(cur, table):
	"""8.3 splits large files across rows by PartNo; 8.2 stores one row per file."""
	if table not in _HAS_PARTNO:
		cur.execute("SELECT COUNT(*) FROM sys.columns WHERE object_id = OBJECT_ID(?) AND name = 'PartNo'", table)
		_HAS_PARTNO[table] = cur.fetchone()[0] > 0
	return _HAS_PARTNO[table]


def read_file(cur, table, name):
	"""Concatenate a file's parts in order, then inflate."""
	order = " ORDER BY PartNo" if has_partno(cur, table) else ""
	cur.execute("SELECT BinaryData FROM %s WHERE FileName = ?%s" % (table, order), name)
	blob = b"".join(bytes(r[0]) for r in cur.fetchall() if r[0] is not None)
	return inflate(blob)


# --------------------------------------------------------------------------- DBNames

DBNAME_ENTRY = re.compile(r'\{([0-9a-fA-F-]{36}),"([^"]*)",(\d+)\}')


def parse_dbnames(buf):
	"""8.2 writes DBNames as UTF-8 text: {ver, {count, {guid,"Kind",N}, ...}}."""
	if buf.startswith(codecs.BOM_UTF8) or buf[:1] == b"{":
		txt = buf.decode("utf-8-sig", "replace")
		entries = [{"guid": g, "type": k, "number": int(n)} for g, k, n in DBNAME_ENTRY.findall(txt)]
		if entries:
			return entries
		raise ValueError("text DBNames matched no entries")
	return parse_dbnames_binary(buf)


def parse_dbnames_binary(buf):
	"""8.3 layout: <u32 count> then count * { <u32 chars> utf16le, <u32 chars> utf16le, <u32 n> }"""
	out, pos = [], 0
	(count,) = struct.unpack_from("<I", buf, pos)
	pos += 4
	if count == 0 or count > 500000:
		raise ValueError("implausible entry count %d" % count)
	for _ in range(count):
		vals = []
		for _ in range(2):
			(ln,) = struct.unpack_from("<I", buf, pos)
			pos += 4
			vals.append(buf[pos:pos + ln * 2].decode("utf-16-le"))
			pos += ln * 2
		(num,) = struct.unpack_from("<I", buf, pos)
		pos += 4
		out.append({"guid": vals[0], "type": vals[1], "number": num})
	return out


def physical_name(entry):
	"""DBNames kind + number -> the SQL object name 1C generated for it."""
	kind, number = entry.get("type"), entry.get("number")
	if not kind or number is None:
		return None
	return "_%s%d" % (kind, number)


# --------------------------------------------------------------------------- commands

def cmd_databases(cur, args):
	"""Which databases does this login actually see? Separates a bad password from missing rights."""
	cur.execute("SELECT name, state_desc, HAS_DBACCESS(name) FROM sys.databases ORDER BY name")
	for name, state, access in cur.fetchall():
		print("%-44s %-10s access=%s" % (name, state, access))


def cmd_probe(cur, args):
	cur.execute("SELECT @@VERSION")
	print(cur.fetchone()[0].splitlines()[0])
	for table in ("Config", "ConfigSave", "Params", "DBSchema", "_YearOffset"):
		try:
			cur.execute("SELECT COUNT(*) FROM [%s]" % table)
			print("  %-12s rows=%s" % (table, cur.fetchone()[0]))
		except Exception as exc:
			print("  %-12s -- %s" % (table, str(exc).split("]")[-1].strip()[:70]))
	cur.execute("""SELECT LEFT(name, PATINDEX('%[0-9]%', name + '0') - 1) AS kind, COUNT(*)
	               FROM sys.tables WHERE name LIKE '[_]%'
	               GROUP BY LEFT(name, PATINDEX('%[0-9]%', name + '0') - 1)
	               ORDER BY 2 DESC""")
	print("\n  physical table families:")
	for kind, n in cur.fetchall():
		print("    %-24s %d" % (kind, n))


def cmd_schema(cur, args):
	cur.execute("""SELECT t.name, c.name, ty.name, c.max_length, c.precision, c.scale, c.is_nullable
	               FROM sys.tables t
	               JOIN sys.columns c ON c.object_id = t.object_id
	               JOIN sys.types ty ON ty.user_type_id = c.user_type_id
	               ORDER BY t.name, c.column_id""")
	tables = {}
	for tn, cn, ty, ml, pr, sc, nullable in cur.fetchall():
		tables.setdefault(tn, []).append({
			"column": cn, "type": ty, "len": ml,
			"precision": pr, "scale": sc, "nullable": bool(nullable),
		})
	cur.execute("""SELECT t.name, SUM(p.rows) FROM sys.tables t
	               JOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0, 1)
	               GROUP BY t.name""")
	rows = dict(cur.fetchall())
	write_json("schema.json", {"tables": [
		{"name": name, "rows": rows.get(name), "columns": cols}
		for name, cols in sorted(tables.items())
	]})
	print("tables=%d" % len(tables))


def cmd_dbnames(cur, args):
	buf = read_file(cur, "Params", "DBNames")
	save("dbnames.bin", buf)
	entries = parse_dbnames(buf)
	for entry in entries:
		entry["physical"] = physical_name(entry)
	write_json("dbnames.json", {"count": len(entries), "entries": entries})
	kinds = {}
	for entry in entries:
		kinds[entry["type"]] = kinds.get(entry["type"], 0) + 1
	print("entries=%d  distinct kinds=%d" % (len(entries), len(kinds)))
	for kind, n in sorted(kinds.items(), key=lambda kv: -kv[1]):
		print("   %-28s %d" % (kind, n))


def cmd_extract(cur, args):
	target = os.path.join(OUT, "config")
	if not os.path.isdir(target):
		os.makedirs(target)
	cur.execute("SELECT DISTINCT FileName FROM Config")
	names = [r[0] for r in cur.fetchall()]
	text = binary = 0
	for i, name in enumerate(names):
		buf = read_file(cur, "Config", name)
		safe = re.sub(r"[^0-9A-Za-z._-]", "_", name)[:120]
		if buf.startswith(codecs.BOM_UTF8) or b"{" in buf[:64]:
			suffix, text = ".txt", text + 1
		else:
			suffix, binary = ".bin", binary + 1
		with open(os.path.join(target, safe + suffix), "wb") as f:
			f.write(buf)
		if i and i % 2000 == 0:
			sys.stderr.write("[i] %d/%d\n" % (i, len(names)))
	print("files=%d text=%d binary=%d -> %s" % (len(names), text, binary, target))


def save(name, data):
	if not os.path.isdir(OUT):
		os.makedirs(OUT)
	with open(os.path.join(OUT, name), "wb") as f:
		f.write(data)


def write_json(name, doc):
	if not os.path.isdir(OUT):
		os.makedirs(OUT)
	with codecs.open(os.path.join(OUT, name), "w", "utf-8") as f:
		json.dump(doc, f, ensure_ascii=False, indent="\t")


COMMANDS = {
	"databases": cmd_databases,
	"probe": cmd_probe,
	"schema": cmd_schema,
	"dbnames": cmd_dbnames,
	"extract": cmd_extract,
}


def main():
	ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
	ap.add_argument("command", choices=sorted(COMMANDS))
	ap.add_argument("--server", default=os.environ.get("DF1C_SERVER")
	                or paths.required("DF1C_SERVER", "which MS SQL server holds it"))
	ap.add_argument("--db", default=os.environ.get("DF1C_DB")
	                or paths.required("DF1C_DB", "which MS SQL infobase to read"))
	args = ap.parse_args()
	COMMANDS[args.command](connect(args.server, args.db).cursor(), args)


if __name__ == "__main__":
	main()
