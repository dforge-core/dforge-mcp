#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Export a 1C:Enterprise 8 infobase to `out/` *without* any 1C software - the one layer that
reads 1C itself. Everything past it reads the export, so it does not matter which kind of
infobase the export came from.

Two kinds of infobase, one export:

    a server infobase on MS SQL   DF1C_SERVER + DF1C_DB      (source_mssql.py)
    a file infobase, 1Cv8.1CD     DF1C_FILE=<path to .1CD>   (source_file.py, onecd.py)

What it writes:

    config/<file>.txt|.bin  the configuration, one file per Config row, inflated  (extract)
    dbnames.json            DBNames: GUID -> physical table/column name           (dbnames)
    schema.json             every table, its columns in MS SQL's terms, row count  (schema)
    data/<table>.parquet    the rows of every `_` table, as 1C stores them         (data)
    export.json             the manifest: which infobase, when, its year offset,
                            and per table the rows and the horizon taken before them

Everything needed to rebuild the data model lives in two service tables:
  Params  -> row FileName='DBNames': GUID -> physical table/column name map
  Config  -> the configuration itself, one row (8.2) or several PartNo rows (8.3) per file
File bodies are raw-deflate compressed (no zlib header), in both kinds of infobase.

The rows are written as 1C stores them - dates still carrying a server infobase's year
offset, booleans as binary(1) - and the manifest records the offset, so a project query
written against the infobase reads the export unchanged.

    python 1c.py dump1c all                      # everything, in order
    python 1c.py dump1c data _Reference12 ...    # re-export these tables only
    python 1c.py dump1c data --skip "ChngR|Settings"
    python 1c.py dump1c data --changes           # only what 1C changed since (MS SQL; changes.py)
    python 1c.py dump1c probe                    # what the source is, before reading it
"""
import argparse
import codecs
import datetime
import json
import os
import re
import struct
import sys
import time
import zlib

import paths

OUT = paths.OUT
DATA = os.path.join(OUT, "data")
MANIFEST = os.path.join(OUT, "export.json")
CHUNK = 50000

# What 1C keeps only as a consequence of other tables: register totals and the document
# journals. 53.7 M rows of a 313 M-row infobase, and no `_Version` to read their change by,
# so each `--changes` would read them all again - 14 minutes of a cutover window that has
# 10. Nothing loads them; `seedstate verify` reads totals, and says which to export.
DERIVED = re.compile(r"^_(AccumRgTn?|AccRgAT|AccRgCT|DocumentJournal)\d+$")


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


def open_source():
	"""The infobase the environment names: a .1CD file, or a server infobase."""
	path = os.environ.get("DF1C_FILE")
	if path:
		if os.environ.get("DF1C_SERVER") or os.environ.get("DF1C_DB"):
			raise SystemExit("DF1C_FILE and DF1C_SERVER/DF1C_DB are both set - say which infobase to read")
		if os.path.isdir(path):
			path = os.path.join(path, "1Cv8.1CD")
		import source_file
		return source_file.FileSource(path)
	import source_mssql
	return source_mssql.MssqlSource(
		paths.required("DF1C_SERVER", "which MS SQL server holds it (or DF1C_FILE for a file infobase)"),
		paths.required("DF1C_DB", "which MS SQL infobase to read"))


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


# --------------------------------------------------------------------------- the manifest

def manifest():
	if not os.path.exists(MANIFEST):
		return None
	with codecs.open(MANIFEST, "r", "utf-8") as f:
		return json.load(f)


def begin(source):
	"""The manifest this run adds to. One export is one infobase: adding a second one's
	tables to it would make a mix no check could tell from the real thing."""
	described = source.describe()
	held = manifest()
	if held and held.get("source") != described:
		raise SystemExit("out/ holds an export of %s, not %s.\n"
		                 "    Point DF1C_OUT somewhere else, or remove %s to start over."
		                 % (json.dumps(held.get("source")), json.dumps(described), MANIFEST))
	held = held or {"source": described, "tables": {}}
	held["year_offset"] = source.year_offset
	held["consistency"] = source.consistent
	return held


def commit(held):
	held["updated"] = datetime.datetime.now().replace(microsecond=0).isoformat()
	write_json("export.json", held)


# --------------------------------------------------------------------------- commands

def cmd_databases(source, args):
	if not hasattr(source, "databases"):
		raise SystemExit("databases: a file infobase is the one file")
	for name, state, access in source.databases():
		print("%-44s %-10s access=%s" % (name, state, access))


def cmd_probe(source, args):
	print(json.dumps(source.describe(), ensure_ascii=False))
	print("year offset %d" % source.year_offset)
	if hasattr(source, "probe"):
		for line in source.probe():
			print(line)
	families = {}
	for name, _, rows in source.tables():
		if name.startswith("_"):
			kind = re.match(r"^_([A-Za-z]+)", name).group(1)
			families[kind] = families.get(kind, 0) + 1
	print("\n  physical table families:")
	for kind, n in sorted(families.items(), key=lambda kv: -kv[1]):
		print("    %-24s %d" % (kind, n))


def cmd_schema(source, args):
	tables = source.tables()
	write_json("schema.json", {"tables": [
		{"name": name, "rows": rows, "columns": cols} for name, cols, rows in sorted(tables)
	]})
	guessed = getattr(getattr(source, "names", None), "guessed", None)
	if guessed:
		held = begin(source)
		held["names_guessed"] = sorted(guessed)
		commit(held)
	print("tables=%d" % len(tables))


def cmd_dbnames(source, args):
	buf = source.read_file("Params", "DBNames")
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


def cmd_extract(source, args):
	target = os.path.join(OUT, "config")
	if not os.path.isdir(target):
		os.makedirs(target)
	names = source.files("Config")
	text = binary = 0
	for i, name in enumerate(names):
		buf = source.read_file("Config", name)
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


def export_table(source, name, columns, expected=None):
	"""One table's rows, in full, into `data/<name>.parquet`. The number written."""
	import pyarrow.parquet as pq
	if not os.path.isdir(DATA):
		os.makedirs(DATA)
	arrow = arrow_schema(columns)
	tmp = os.path.join(DATA, name + ".parquet.tmp")
	writer = pq.ParquetWriter(tmp, arrow, compression="zstd")
	written = 0
	try:
		for batch in source.rows(name, [c["column"] for c in columns], CHUNK):
			writer.write_table(arrow_batch(arrow, columns, batch))
			written += len(batch)
			if (expected or 0) > CHUNK:
				sys.stderr.write("\r    %-30s %9d / %d" % (name, written, expected))
	finally:
		writer.close()
	if (expected or 0) > CHUNK:
		sys.stderr.write("\n")
	os.replace(tmp, os.path.join(DATA, name + ".parquet"))
	return written


def cmd_data(source, args):
	held = begin(source)
	schema = dict((name, (cols, rows)) for name, cols, rows in source.tables())
	if args.changes:
		import changes
		try:
			changes.run(source, held, schema, args,
			            lambda name, columns: export_table(source, name, columns, schema[name][1]))
		finally:
			commit(held)
		return
	if args.since:
		raise SystemExit("data: --since goes with --changes")
	named = list(args.tables)
	if args.objects:
		# Every catalog, document and chart - what `delta` reads the keys of. Small: 407
		# tables and 1.6 M rows of a 313 M-row infobase.
		import changes
		objects = [n for n in sorted(schema) if n not in named
		           and changes.classify(n, schema[n][0], schema)[0] == "object"]
		if not objects:
			# A file infobase: no rowversion, so nothing is an object in that sense - and
			# an empty list would otherwise mean "every table".
			raise SystemExit("data --objects: no table here has a rowversion - this is for an"
			                 " MS SQL export, which `delta` needs")
		named += objects
	args.tables = named
	wanted = args.tables or sorted(n for n in schema if n.startswith("_")
	                               and (args.derived or not DERIVED.match(n)))
	if not args.tables and not args.derived:
		left = [n for n in schema if DERIVED.match(n)]
		print("left out %d table(s) 1C derives from others - totals, journals (%d rows);"
		      " name one, or --derived, to export it" % (len(left), sum(schema[n][1] or 0 for n in left)))
	unknown = [t for t in wanted if t not in schema]
	if unknown:
		raise SystemExit("data: no such table: %s" % ", ".join(unknown))
	if args.tables:
		# A partial export still takes every enum: they are a few rows each, and the loader
		# decodes an enum column by reading its table - left out, a module's load stops at
		# its first enum with "_Enum727 does not exist".
		enums = [n for n in sorted(schema) if re.match(r"^_Enum\d+$", n) and n not in wanted]
		wanted += enums
	if args.skip:
		wanted = [t for t in wanted if not re.search(args.skip, t)]
	started, total = time.time(), 0
	for at, name in enumerate(wanted):
		columns, expected = schema[name]
		horizon = source.horizon()
		written = export_table(source, name, columns, expected)
		held["tables"][name] = {"rows": written,
		                        "horizon": horizon.hex() if horizon is not None else None,
		                        "exported": datetime.datetime.now().replace(microsecond=0).isoformat()}
		total += written
		# The manifest is written as the tables are, so an export stopped half-way says
		# truthfully what it holds.
		if at % 50 == 0 or at == len(wanted) - 1:
			commit(held)
	print("tables=%d rows=%d in %.0fs -> %s" % (len(wanted), total, time.time() - started, DATA))


def cmd_all(source, args):
	for step in (cmd_dbnames, cmd_schema, cmd_extract, cmd_data):
		step(source, args)


# --------------------------------------------------------------------------- parquet

def arrow_type(column):
	"""The schema dump's MS SQL type -> how the export stores it."""
	import pyarrow as pa
	kind = column["type"]
	if kind in ("binary", "varbinary", "image", "timestamp", "rowversion"):
		return pa.binary()
	if kind in ("nchar", "nvarchar", "ntext", "char", "varchar", "text", "sysname", "uniqueidentifier"):
		return pa.string()
	if kind in ("numeric", "decimal"):
		return pa.decimal128(column.get("precision") or 38, column.get("scale") or 0)
	if kind in ("datetime", "datetime2", "smalldatetime", "date"):
		return pa.timestamp("us")
	if kind in ("int", "smallint", "tinyint", "bigint"):
		return pa.int64()
	if kind == "bit":
		return pa.bool_()
	if kind in ("float", "real"):
		return pa.float64()
	return pa.string()


def arrow_schema(columns):
	import pyarrow as pa
	return pa.schema([pa.field(c["column"], arrow_type(c)) for c in columns])


def arrow_batch(arrow, columns, batch):
	import pyarrow as pa
	arrays = []
	for i, field in enumerate(arrow):
		values = [row[i] for row in batch]
		if pa.types.is_string(field.type):
			values = [v if v is None or isinstance(v, str) else str(v) for v in values]
		elif pa.types.is_binary(field.type):
			values = [v if v is None else bytes(v) for v in values]
		arrays.append(pa.array(values, type=field.type))
	return pa.Table.from_arrays(arrays, schema=arrow)


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
	"data": cmd_data,
	"all": cmd_all,
}


def main():
	ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
	ap.add_argument("command", choices=sorted(COMMANDS))
	ap.add_argument("tables", nargs="*", help="data: only these tables")
	ap.add_argument("--skip", help="data: leave out tables matching this regex")
	ap.add_argument("--objects", action="store_true",
	                help="data: every object table (catalogs, documents, charts) besides the named ones")
	ap.add_argument("--derived", action="store_true",
	                help="data: export totals and journals too (left out by default)")
	ap.add_argument("--changes", action="store_true",
	                help="data: read only what 1C changed since the export (MS SQL; see changes.py)")
	ap.add_argument("--since", help="data --changes: from this day (YYYY-MM-DD) or rowversion (0x...)")
	args = ap.parse_args()
	COMMANDS[args.command](open_source(), args)


if __name__ == "__main__":
	main()
