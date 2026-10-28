#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Copy the infobase's rows into a dForge tenant database.

Straight from MS SQL into Postgres with `COPY`, no 1C software and no API: the
column map (`out/columnmap.json`) says where every ported column comes from, and
everything in between is the eight conversions described in docs/design-migration.md.

The target's physical shape is read from the tenant database itself - `"dForge".entity`
gives an entity's schema and table, `information_schema` gives that table's columns - so
the loader cannot disagree with what the installer actually built.

    python tools/migrate.py plan masterdata            # what would be copied
    python tools/migrate.py run masterdata --truncate  # do it
    python tools/migrate.py verify masterdata          # counts, sums, orphans
    python tools/migrate.py check masterdata           # is anything mandatory empty?
    python tools/migrate.py fill masterdata            # placeholders on their own

Source credentials come from DF1C_SERVER / DF1C_DB / DF1C_USER / DF1C_PASS (Windows
auth when DF1C_USER is unset). The target from DF_PG_HOST / DF_PG_PORT / DF_PG_USER /
DF_PG_PASS plus DF_TENANT, which names the database through the platform's own
`dforge_{tenantCd}` pattern. Both sides are read from `.env` if one is present.
"""
from __future__ import print_function

import argparse
import binascii
import codecs
import collections
import datetime
import decimal
import io
import json
import os
import re
import sys
import uuid

import attrs
import paths
import delta
import dump1c

# 1C stores dates shifted by the infobase's _YearOffset: 4012 in the column is 2012.
# The empty date is 0001-01-01, which shifted lands on 2001-01-01.
YEAR_OFFSET = 2000
ZERO_REF = b"\x00" * 16

CHUNK = 20000

TRUE_TEXT = set([u"1", u"true", u"t", u"yes", u"y", u"\u0414\u0430"])


# --------------------------------------------------------------------------- config

def load_env():
	"""Read `.env` into the environment without overriding what is already set."""
	path = os.path.join(os.path.dirname(attrs.OUT), ".env")
	if not os.path.isfile(path):
		return
	with codecs.open(path, "r", "utf-8") as f:
		for line in f:
			line = line.strip()
			if not line or line.startswith("#") or "=" not in line:
				continue
			key, value = line.split("=", 1)
			os.environ.setdefault(key.strip(), value.strip())


def pg_connect():
	import psycopg2
	tenant = paths.required("DF_TENANT", "which dForge tenant to write into")
	db = os.environ.get("DF_PG_DB", "dforge_%s" % tenant)
	host = os.environ.get("DF_PG_HOST", "localhost")
	port = int(os.environ.get("DF_PG_PORT", "5438"))
	user = os.environ.get("DF_PG_USER", "dforge")
	password = os.environ.get("DF_PG_PASS", "dforge")
	sys.stderr.write("[i] %s:%d/%s as %s\n" % (host, port, db, user))
	return psycopg2.connect(host=host, port=port, dbname=db, user=user, password=password)


def mssql_connect():
	return dump1c.connect(paths.required("DF1C_SERVER", "which MS SQL server holds it"),
	                      paths.required("DF1C_DB", "which MS SQL infobase to read"))


# --------------------------------------------------------------------------- the map

def column_map():
	path = paths.derived("columnmap.json")
	with codecs.open(path, "r", "utf-8") as f:
		return json.load(f, object_pairs_hook=collections.OrderedDict)


def source_schema():
	"""Physical column types on the 1C side, from the schema dump."""
	path = os.path.join(attrs.OUT, "schema.json")
	with codecs.open(path, "r", "utf-8") as f:
		doc = json.load(f)
	out = {}
	for table in doc["tables"]:
		out[table["name"]] = {
			"rows": table.get("rows") or 0,
			"columns": dict((c["column"], c) for c in table["columns"]),
		}
	return out


def target_tables(pg, module):
	"""entity_cd -> (schema, table, {column: info}), straight from the tenant DB."""
	cur = pg.cursor()
	cur.execute("""SELECT e.entity_cd, e.schema_name, e.db_object
	               FROM "dForge".entity e
	               JOIN "dForge".module m ON m.module_id = e.module_id
	               WHERE m.module_cd = %s""", (module,))
	entities = cur.fetchall()
	out = collections.OrderedDict()
	for entity_cd, schema, table in sorted(entities):
		if not schema or not table:
			continue
		cur.execute("""SELECT column_name, data_type, is_nullable, column_default,
		                      is_generated, is_identity
		               FROM information_schema.columns
		               WHERE table_schema = %s AND table_name = %s
		               ORDER BY ordinal_position""", (schema, table))
		columns = collections.OrderedDict()
		for name, datatype, nullable, default, generated, identity in cur.fetchall():
			columns[name] = {
				"type": datatype,
				"nullable": nullable == "YES",
				"default": default,
				"generated": generated != "NEVER" or identity == "YES",
			}
		if columns:
			out[entity_cd] = (schema, table, columns)

	# A module can also own columns on someone else's entity. dForge keeps those in a
	# 1:1 side table named by `entity_column.storage_table`, and the entity they belong
	# to is the host's - so they are addressed the way a manifest addresses them, by the
	# host's dotted name, and the column map carries an entry under the same key.
	cur.execute("""SELECT DISTINCT host_m.module_cd, e.entity_cd, ec.storage_table
	               FROM "dForge".entity_column ec
	               JOIN "dForge".entity e ON e.entity_id = ec.entity_id
	               JOIN "dForge".module m ON m.module_id = ec.module_id
	               LEFT JOIN "dForge".module host_m ON host_m.module_id = e.module_id
	               WHERE m.module_cd = %s AND ec.storage_table IS NOT NULL""",
	            (module,))
	for host_module, entity_cd, storage in sorted(cur.fetchall()):
		schema, table = split_storage(storage)
		if not table:
			continue
		cur.execute("""SELECT column_name, data_type, is_nullable, column_default,
		                      is_generated, is_identity
		               FROM information_schema.columns
		               WHERE table_schema = %s AND table_name = %s
		               ORDER BY ordinal_position""", (schema, table))
		columns = collections.OrderedDict()
		for name, datatype, nullable, default, generated, identity in cur.fetchall():
			columns[name] = {
				"type": datatype,
				"nullable": nullable == "YES",
				"default": default,
				"generated": generated != "NEVER" or identity == "YES",
			}
		if columns:
			out["%s.%s" % (host_module, entity_cd)] = (schema, table, columns)
	return out


def split_storage(storage):
	"""`"shipping"."addendum_contract_ext"` -> ("shipping", "addendum_contract_ext")."""
	parts = [p.strip().strip('"') for p in (storage or "").split(".")]
	if len(parts) == 2:
		return parts[0], parts[1]
	return None, None


# --------------------------------------------------------------------------- conversions

def to_uuid(raw):
	"""`_IDRRef binary(16)` -> uuid text. 1C writes the halves the other way round."""
	if raw is None:
		return None
	raw = bytes(raw)
	if raw == ZERO_REF:
		# The empty reference. Left alone it would become a uuid pointing at a row
		# that does not exist, and the foreign key would reject the load.
		return None
	hexed = binascii.hexlify(raw).decode("ascii")
	hexed = hexed[16:] + hexed[:16]
	return "%s-%s-%s-%s-%s" % (hexed[0:8], hexed[8:12], hexed[12:16],
	                           hexed[16:20], hexed[20:32])


def shift_date(value):
	"""Undo the +2000 year offset; 1C's empty date becomes NULL."""
	if value is None:
		return None
	year = value.year - YEAR_OFFSET
	if year <= 1:
		return None
	return value.replace(year=year)


def text_date(value):
	"""A date 1C parked in a STRING column, which it formatted itself.

	A dimension declared `Строка(10)` and assigned `НачалоДня(Дата)` leaves `13.01.2016`
	in the column. The year is the real one: the +2000 offset is how 1C stores a
	datetime, and nothing stored a datetime here - the configuration formatted a string.
	Shifting it as well would move every such value back two millennia.
	"""
	if value is None:
		return None
	if isinstance(value, datetime.datetime):
		return shift_date(value)
	if not isinstance(value, type(u"")):
		return None
	text = value.strip()
	if not text:
		return None
	for fmt in ("%d.%m.%Y", "%Y-%m-%d"):
		try:
			return datetime.datetime.strptime(text, fmt).date()
		except ValueError:
			pass
	raise ValueError("cannot read %r as a date" % text)


def to_bool(value):
	if value is None:
		return None
	if isinstance(value, bool):
		return value
	if isinstance(value, (bytes, bytearray, memoryview)):
		raw = bytes(value)
		return bool(raw) and raw[0] != 0
	if isinstance(value, (int, float, decimal.Decimal)):
		return value != 0
	return value.strip().lower() in TRUE_TEXT


def to_number(value):
	"""A number 1C parked in a string column uses a comma for the decimal point."""
	if value is None:
		return None
	if isinstance(value, (int, float, decimal.Decimal)):
		return value
	text = value.strip().replace(u"\u00a0", u"").replace(u" ", u"")
	if not text:
		return None
	return text.replace(u",", u".")


def to_text(value):
	if value is None:
		return None
	if isinstance(value, (bytes, bytearray, memoryview)):
		return to_uuid(value) if len(bytes(value)) == 16 else None
	if isinstance(value, datetime.datetime):
		value = shift_date(value)
		return value.isoformat() if value else None
	if not isinstance(value, type(u"")):
		# A number or a flag landing in a text column - the port widened the type.
		return str(value)
	# 1C pads its fixed-width strings, `_Code nchar(18)` being the one that shows.
	return value.rstrip()


_ENUM_CACHE = {}


def enum_decoder(mssql, spec):
	"""An enum reference -> the option code the port gave that value.

	1C keeps an enum value's position in `_EnumOrder`, and the port read the values in
	that same order, so position is what pairs a GUID with a code.
	"""
	key = (spec["table"], tuple(spec["options"]))
	if key not in _ENUM_CACHE:
		options = spec["options"]
		found = {}
		mssql.execute("SELECT _IDRRef, _EnumOrder FROM [%s]" % spec["table"])
		for raw, order in mssql.fetchall():
			position = int(order)
			if 0 <= position < len(options):
				found[to_uuid(raw)] = options[position]
		_ENUM_CACHE[key] = found
	found = _ENUM_CACHE[key]

	def decode(value):
		return found.get(to_uuid(value))
	return decode


def tableref_decoder(table):
	"""The table half of a composite reference -> what the port calls that kind.

	1C stores a composite reference as three columns: a type tag, which table, and which
	row. The table half is a plain number, and it is the only thing that says what the
	row on the other end actually is.
	"""
	found = dict((int(number), code) for number, code in table.items())

	def decode(value):
		if value is None:
			return None
		return found.get(int(binascii.hexlify(bytes(value)), 16))
	return decode


def bind_enums(job, mssql):
	"""Swap in the enum decoders once there is a connection to read the tables with."""
	if not any(job.enums):
		return job
	converters = [enum_decoder(mssql, spec) if spec else f
	              for f, spec in zip(job.converters, job.enums)]
	return job._replace(converters=converters)


NUMERIC_TYPES = set(["smallint", "integer", "bigint", "numeric", "decimal",
                     "real", "double precision"])
DATE_TYPES = set(["date", "timestamp without time zone", "timestamp with time zone"])


def to_blob(value):
	"""1C's serialized value, carried as it is.

	Decoding it needs 1C's own format and is a piece of work on its own; losing it
	needs only a `DROP COLUMN`. The bytes are kept so the choice stays open.
	"""
	if value is None:
		return None
	raw = bytes(value)
	return raw or None


def converter(target_type, source_type):
	"""One conversion per (target, source) pair - everything is column-level."""
	if target_type == "bytea":
		return to_blob
	if target_type == "uuid":
		return to_uuid
	if target_type == "boolean":
		return to_bool
	if target_type in NUMERIC_TYPES:
		return to_number
	if target_type in DATE_TYPES:
		# A date the port declares, held as text by the infobase, is not a 1C date value
		# and must not be shifted - see text_date.
		return text_date if source_type in TEXTUAL else shift_date
	return to_text


def magnitude(value):
	"""The size of a movement, without its direction."""
	number = to_number(value)
	return None if number is None else abs(number)


def direction(value):
	"""Which way a movement went: the platform's `journalDirection` stamp, -1 or +1.

	A turnover register requires one, and the infobase does not have the column: this
	register's author kept the direction in the SIGN of the value, so the same 1C column
	feeds both our magnitude and this. Zero reads as +1 rather than 0 - a movement of
	nothing still went one way, and 0 is not one of the two values the platform allows.

	Its sibling for a balance register is `record_kind` below.
	"""
	number = to_number(value)
	return 1 if number is None or number >= 0 else -1


def record_kind(value):
	"""The direction stamp of a BALANCE register's movement, read off `_RecordKind`.

	A balance register keeps its resources unsigned and says which way each row went in
	`_RecordKind` - 0 the receipt, 1 the expense - so 0 maps to +1 and 1 to -1. That is the
	same split the platform's `journalDirection` makes, which is what lets a loaded movement
	table be the register's journal as it stands.

	Anything else is refused rather than guessed: a stamp that read a NULL as +1 would add
	an expense to the balance, and every as-of read would carry the error silently.
	"""
	if value is None:
		raise ValueError("a movement with no _RecordKind has no direction")
	kind = int(value)
	if kind not in (0, 1):
		raise ValueError("_RecordKind %r is neither receipt (0) nor expense (1)" % value)
	return 1 if kind == 0 else -1


# Named in a project's register overlay (`load`), applied instead of the converter the
# column's type would have chosen. Keyed by name so the overlay stays declarative.
def increase(value):
	"""Always +1: a turnover register whose two sides are RESOURCES, not directions.

	`мсбВыпускПродукцииВЦехах` carries what was reworked and what was handed over as two
	pairs of resources, so every row is additive and the platform's `journalDirection` stamp
	is a constant. Declaring `formula: "1"` on the column was meant to cover this through a
	DB default, and on the upgrade path it did not: the column arrived with no default and
	484,153 rows read NULL, which would make every SUM(value * direction) over the register
	come back NULL - an empty answer rather than an error.

	So it is filled here instead, where the loader can be held to it. The value it reads is
	ignored; it takes a source column only because that is how the overlay names one.
	"""
	return 1


def since_beginning(value):
	"""A register period, where 1C's EMPTY date is a value rather than an absence.

	`shift_date` turns the empty date into NULL, which is right for an ordinary date field -
	nobody filled it in. On an information register's PERIOD it is wrong, and the difference
	is visible in what a slice answers. 1C stores the empty date as 0001-01-01 (2001-01-01
	in the column, before the offset is undone), so `СрезПоследних` on any date finds such a
	record: it is in force from the beginning of time. Load it as NULL and the record answers
	NOTHING, because the engine's slice bounds `period <= @OnDate` and NULL never satisfies
	that - the row is in the table and invisible to every read of it.

	Measured on `мсбАналогиНоменклатурыДляРецептур`: 330 of its 1,053 rows carry the empty
	date, on 330 distinct dimension tuples, and 2 of those keys ALSO have a dated row - so the
	floor is what makes the dated one supersede rather than be the only answer. With the floor
	the slice key is unique over all 1,053 rows, which is what lets the register be declared
	independent at all: a unique index over a NULL-bearing key enforces nothing, since NULLs
	are distinct to it.

	It takes the raw column, as every transform does, so it undoes the offset itself.
	"""
	if value is None:
		return None
	year = value.year - YEAR_OFFSET
	return datetime.datetime(1, 1, 1) if year <= 1 else value.replace(year=year)


EMPTY_KEY = "00000000-0000-0000-0000-000000000000"


def ref_key(raw):
	"""A reference as a register KEY, where 1C's empty reference is a value, not an absence.

	`to_uuid` turns the empty reference into NULL, which is right for a link - nothing is
	linked. In a register dimension it is wrong: 1C keys the empty reference as a value of
	its own (`ПартииТоваровНаСкладах` holds a batch with no series on 1,920,300 of its
	13.8M movements), and a dForge dimension holds no NULL, since NULL is not equal to NULL
	in a balance, a GROUP BY or a unique key. So it reads as the nil uuid - which is also
	how 1C stores it, sixteen zero bytes - in a plain key column beside the link, never in
	the link itself, whose foreign key has no row to point at.
	"""
	if raw is None or bytes(raw) == ZERO_REF:
		return EMPTY_KEY
	return to_uuid(raw)


TRANSFORMS = {"magnitude": magnitude, "direction": direction, "record_kind": record_kind,
              "increase": increase, "since_beginning": since_beginning, "ref_key": ref_key}


# --------------------------------------------------------------------------- COPY

def derived_key(src_table, row):
	"""A stable key for a register row 1C never gave one to: the row is the key."""
	seed = src_table + u"|" + u"	".join(encode(v) for v in row)
	return str(uuid.uuid5(uuid.NAMESPACE_OID, seed))


def encode(value):
	"""One field in Postgres' COPY text format."""
	if value is None:
		return "\\N"
	if value is True:
		return "t"
	if value is False:
		return "f"
	if isinstance(value, (datetime.datetime, datetime.date)):
		return value.isoformat()
	if isinstance(value, (bytes, bytearray, memoryview)):
		# COPY reads `\\x...` as hex bytea, and the backslash itself is escaped.
		return u"\\\\x%s" % binascii.hexlify(bytes(value)).decode("ascii")
	if not isinstance(value, type(u"")):
		return str(value)
	return (value.replace(u"\\", u"\\\\").replace(u"\n", u"\\n")
	             .replace(u"\r", u"\\r").replace(u"\t", u"\\t"))


def copy_rows(pg, schema, table, columns, rows):
	buf = io.StringIO()
	for row in rows:
		buf.write(u"\t".join(encode(v) for v in row))
		buf.write(u"\n")
	buf.seek(0)
	cur = pg.cursor()
	cur.copy_expert(
		'COPY "%s"."%s" (%s) FROM STDIN'
		% (schema, table, ", ".join('"%s"' % c for c in columns)), buf)


# ------------------------------------------------------------------- dangling references

FOREIGN_KEYS = """
	SELECT c.conname,
	       tn.nspname, t.relname, sa.attname,
	       fn.nspname, f.relname, fa.attname
	FROM pg_constraint c
	JOIN pg_class t ON t.oid = c.conrelid
	JOIN pg_namespace tn ON tn.oid = t.relnamespace
	JOIN pg_class f ON f.oid = c.confrelid
	JOIN pg_namespace fn ON fn.oid = f.relnamespace
	JOIN unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
	JOIN unnest(c.confkey) WITH ORDINALITY AS fk(attnum, ord) ON fk.ord = k.ord
	JOIN pg_attribute sa ON sa.attrelid = t.oid AND sa.attnum = k.attnum
	JOIN pg_attribute fa ON fa.attrelid = f.oid AND fa.attnum = fk.attnum
	WHERE c.contype = 'f' AND array_length(c.conkey, 1) = 1
	  AND tn.nspname = ANY(%s)
	ORDER BY 2, 3, 1
"""


def foreign_keys(pg, schemas):
	cur = pg.cursor()
	cur.execute(FOREIGN_KEYS, (sorted(set(schemas)),))
	return cur.fetchall()


def table_columns(pg, schema, table):
	cur = pg.cursor()
	cur.execute("""SELECT column_name, data_type, is_nullable, column_default,
	                      is_generated, is_identity, character_maximum_length
	               FROM information_schema.columns
	               WHERE table_schema = %s AND table_name = %s
	               ORDER BY ordinal_position""", (schema, table))
	return cur.fetchall()


def filler(data_type, max_length, key):
	"""What to put in a column the target insists on but the placeholder has no value for.

	A text column gets the missing key itself, so the row is traceable back to whatever
	referenced it rather than being one of a crowd of identical blanks.
	"""
	if data_type in ("character varying", "character", "text"):
		if max_length:
			return 'left(%s::text, %d)' % (key, max_length)
		return "%s::text" % key
	if data_type in NUMERIC_TYPES:
		return "0"
	if data_type == "boolean":
		return "false"
	return None


def note(skipped, cur, schema, table, column,
         target_schema, target_table, target_column, why):
	"""Record a target that cannot take a stand-in - but only if one was wanted.

	Most of these are harmless: a document table has a mandatory date and no default,
	so no placeholder can be built for it, and nothing ever asks for one. Reporting
	those reads like a defect and is not one, so the count comes first.
	"""
	cur.execute('SELECT count(*) FROM "%s"."%s" a WHERE a."%s" IS NOT NULL'
	            ' AND NOT EXISTS (SELECT 1 FROM "%s"."%s" b WHERE b."%s" = a."%s")'
	            % (schema, table, column,
	               target_schema, target_table, target_column, column))
	count = cur.fetchone()[0]
	if count:
		skipped.append(("%s.%s -> %s.%s" % (schema, table, target_schema, target_table),
		                why, count))


UNENFORCED = """
	SELECT m.module_cd, e.entity_cd, e.schema_name, lower(e.db_object), lower(ec.this_key),
	       ref.schema_name, lower(ref.db_object), lower(ec.other_key)
	FROM "dForge".entity_column ec
	JOIN "dForge".entity e ON e.entity_id = ec.entity_id
	JOIN "dForge".module m ON m.module_id = e.module_id
	JOIN "dForge".entity ref ON ref.entity_id = ec.ref_entity_id
	JOIN information_schema.columns c ON c.table_schema = e.schema_name
	                                 AND c.table_name = lower(e.db_object)
	                                 AND c.column_name = lower(ec.this_key)
	WHERE ec.column_type = 'R' AND ec.this_key IS NOT NULL AND ec.other_key IS NOT NULL
	  AND e.schema_name = ANY(%s)
	  AND NOT EXISTS (
		SELECT 1 FROM pg_constraint con
		JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
		WHERE con.contype = 'f'
		  AND con.conrelid = format('%%I.%%I', e.schema_name, lower(e.db_object))::regclass
		  AND a.attname = lower(ec.this_key))
	ORDER BY 3, 4, 5
"""


def unenforced(pg, schemas, mapping=None):
	"""References the metadata declares and no foreign key enforces, shaped like
	`foreign_keys` rows - except those copied from a composite column.

	A key is missing for one of two reasons. Either the install could not build it - it
	adds a missing key on every reinstall and skips it, with a warning nobody reads, when
	the rows already break it - and then the rows are exactly what this pass exists for.
	Or the reference was never one: a value copied from 1C's composite `_RRRef` half points
	at whatever its `_RTRef` says, and a stand-in for it in the declared target would be a
	fabricated row (autospec.reconcile now makes such a column a raw GUID).
	"""
	mapping = mapping if mapping is not None else column_map()
	cur = pg.cursor()
	cur.execute(UNENFORCED, (sorted(set(schemas)),))
	found = []
	for (module, entity, schema, table, column,
	     target_schema, target_table, target_column) in cur.fetchall():
		source = ((mapping.get(module) or {}).get(entity) or {}).get("columns", {}).get(column)
		if isinstance(source, str) and source.endswith("_RRRef"):
			continue
		found.append((None, schema, table, column, target_schema, target_table, target_column))
	return found


def fill_missing(pg, schemas, verbose=True):
	"""Insert a flagged placeholder for every reference whose target is not there.

	1C does not enforce referential integrity, so a copy arrives carrying references
	whose target was deleted from the infobase - 5,271 batches name a unit that is gone
	in 1C itself. Nulling those would lose what the row actually said, and dropping the
	foreign key would give up the integrity the port is here to gain. The row is created
	instead, with `is_missing` raised, so the reference resolves and the placeholder is
	visibly not reference data.

	References no foreign key enforces are walked too (`unenforced`): a reinstall cannot
	build the key while the rows break it, so the stand-ins have to come first.
	"""
	cur = pg.cursor()
	filled, skipped = [], []
	for (_name, schema, table, column,
	     target_schema, target_table, target_column) in (foreign_keys(pg, schemas)
	                                                      + unenforced(pg, schemas)):
		columns = table_columns(pg, target_schema, target_table)
		names = set(c[0] for c in columns)
		key = 'a."%s"' % column
		if "is_missing" not in names:
			note(skipped, cur, schema, table, column,
			     target_schema, target_table, target_column, "no is_missing column")
			continue

		into, values = ['"%s"' % target_column, '"is_missing"'], [key, "true"]
		blocked = None
		for (name, data_type, nullable, default,
		     generated, identity, max_length) in columns:
			if (name in (target_column, "is_missing") or nullable == "YES"
					or default is not None or generated != "NEVER" or identity == "YES"):
				continue
			value = filler(data_type, max_length, key)
			if value is None:
				blocked = "%s %s" % (name, data_type)
				break
			into.append('"%s"' % name)
			values.append(value)
		if blocked:
			note(skipped, cur, schema, table, column,
			     target_schema, target_table, target_column, blocked)
			continue

		cur.execute(
			'INSERT INTO "%s"."%s" (%s) SELECT DISTINCT %s FROM "%s"."%s" a'
			' WHERE %s IS NOT NULL AND NOT EXISTS ('
			'   SELECT 1 FROM "%s"."%s" b WHERE b."%s" = %s)'
			' ON CONFLICT DO NOTHING'
			% (target_schema, target_table, ", ".join(into), ", ".join(values),
			   schema, table, key,
			   target_schema, target_table, target_column, key))
		if cur.rowcount:
			filled.append((schema, table, column, target_table, cur.rowcount))
	pg.commit()

	if verbose and filled:
		print("\nplaceholders for references 1C had already lost")
		print("-" * 70)
		for schema, table, column, target, count in filled:
			print("%-26s %-24s -> %-20s %6d"
			      % ("%s.%s" % (schema, table), column, target, count))
	if verbose and skipped:
		print("\nreferences left dangling - no stand-in could be built:")
		for target, why, count in sorted(set(skipped)):
			print("   %-44s %6d  (%s)" % (target, count, why))
	return filled


# --------------------------------------------------------------------------- planning

Job = collections.namedtuple(
	"Job", "entity schema table source query pairs converters enums rows unmapped"
	       " blocking derived self_refs key_at")


def period_window(query, restrict=None):
	"""Fill in a declared query's period markers from DF1C_FROM / DF1C_TO.

	A query too big to run in one pass is run a year at a time, and where the bound goes
	belongs to the query: the accounting pivot aggregates 99.8M analytic rows, and that
	inner scan is what spills, so bounding only the outer one would not help. The marker
	`/*window:<alias>/` names each place.

	It is filled at READ time rather than baked into the map, because `out/columnmap.json`
	is committed and describes what the loader copies: a map that said "2018 only" would
	be a lie about the mapping.

	The same markers carry a `restrict` - a function of the alias returning one more SQL
	condition - which is how the delta loader narrows the pivot to the recorders that
	changed, at the inner scan where narrowing pays, rather than around the whole query.
	"""
	start, end = os.environ.get("DF1C_FROM"), os.environ.get("DF1C_TO")

	def window(match):
		alias = match.group(1)
		parts = []
		if start and end:
			parts.append("AND %s._Period >= '%s' AND %s._Period < '%s'"
			             % (alias, start, alias, end))
		if restrict:
			parts.append("AND (%s)" % restrict(alias))
		return " ".join(parts)

	return re.sub(r"/\*window:(\w+)\*/", window, query)


def windowed(query):
	"""Does the query carry its own `/*window:...*/` markers?"""
	return bool(re.search(r"/\*window:\w+\*/", query or ""))


def reading(job, restrict=None):
	"""What the loader selects from: the table, or the query declared in its place.

	One of our rows is not always one of theirs. Where it is not, `sources.QUERIES`
	declares a query whose output columns carry the physical names, so the column map,
	the converters and the control sums all go on working unchanged.

	`restrict(alias)` narrows the rows to a condition on the source's own columns - the
	delta loader's "only what changed". A query with window markers takes it at each
	marker; any other source takes it as a WHERE on the whole.
	"""
	if job.query:
		if restrict and not windowed(job.query):
			return "(%s) AS src WHERE %s" % (period_window(job.query), restrict("src"))
		return "(%s) AS src" % period_window(job.query, restrict)
	if restrict:
		return "[%s] AS src WHERE %s" % (job.source, restrict("src"))
	return "[%s]" % job.source


def converted(job, batch):
	"""One fetched batch through the job's conversions: what `run` copies, and the delta."""
	rows = [[f(v) for f, v in zip(job.converters, row)] for row in batch]
	if job.self_refs and job.key_at is not None:
		for row in rows:
			for at in job.self_refs:
				if row[at] == row[job.key_at]:
					row[at] = None
	if job.derived:
		for row in rows:
			row.append(derived_key(job.source, row))
	return rows


def self_references(pg, schema, table):
	"""Columns that point at this same table.

	1C says "the payer is this counterparty itself" by storing the row's own key, and a
	dForge self-reference carries a generated `CHK_..._acyclic` check that refuses
	exactly that. The value means "no separate payer", so it is loaded as NULL and reads
	back as `COALESCE(payer_id, party_id)`.
	"""
	cur = pg.cursor()
	cur.execute("""SELECT a.attname
	               FROM pg_constraint c
	               JOIN pg_class t ON t.oid = c.conrelid
	               JOIN pg_namespace n ON n.oid = t.relnamespace
	               JOIN unnest(c.conkey) k(attnum) ON true
	               JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
	               WHERE c.contype = 'f' AND c.conrelid = c.confrelid
	                 AND n.nspname = %s AND t.relname = %s""", (schema, table))
	return set(r[0] for r in cur.fetchall())


def primary_key(pg, schema, table):
	cur = pg.cursor()
	cur.execute("""SELECT a.attname
	               FROM pg_constraint c
	               JOIN pg_class t ON t.oid = c.conrelid
	               JOIN pg_namespace n ON n.oid = t.relnamespace
	               JOIN unnest(c.conkey) k(attnum) ON true
	               JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
	               WHERE c.contype = 'p' AND n.nspname = %s AND t.relname = %s""",
	            (schema, table))
	return set(r[0] for r in cur.fetchall())


def plan_entity(pg, entity, mapped, target, source):
	"""What a single entity's copy would look like, or why it cannot run."""
	schema, table, columns = target
	src_table = mapped.get("table")
	if not src_table or src_table not in source:
		return None
	src_columns = source[src_table]["columns"]
	keys = primary_key(pg, schema, table)
	pointing_here = self_references(pg, schema, table)

	# Where the entity reads from a query rather than a table, some of the columns it
	# selects belong to a table joined in there. The map says which, so the type comes
	# from the table that actually holds the column.
	joined = mapped.get("joined") or {}

	def holding(column):
		if column in joined:
			return source.get(joined[column], {}).get("columns", {})
		return src_columns

	pairs, converters, enums, unmapped, blocking = [], [], [], [], []
	derived = None
	declared = mapped.get("enums") or {}
	declared_refs = mapped.get("tablerefs") or {}
	declared_transforms = mapped.get("transforms") or {}
	unknown = set(declared_transforms.values()) - set(TRANSFORMS)
	if unknown:
		raise KeyError("%s: no such transform %s - see migrate.TRANSFORMS"
		               % (entity, ", ".join(sorted(unknown))))
	for column, info in columns.items():
		if info["generated"]:
			continue
		src = mapped.get("columns", {}).get(column)
		if (not src or src not in holding(src)) and column in keys 				and info["type"] == "uuid":
			# An information register has no key of its own in 1C. Where the infobase
			# kept one anyway it is `_SimpleKey`; where it did not, the key is derived
			# from the row itself, so a re-run lands on the same value.
			if "_SimpleKey" in src_columns:
				pairs.append((column, "_SimpleKey"))
				converters.append(to_uuid)
				enums.append(None)
			else:
				derived = column
			continue
		if src and mapped.get("query") and src not in holding(src):
			# A declared query produces columns the source TABLE does not have. The
			# pivot that turns the accounting register's analytic ROWS into slot
			# COLUMNS produces eight of them, and the schema dump describes the table,
			# not the query. The map names the column, so the target's own type decides
			# the conversion and the source type is simply not known here.
			pairs.append((column, src))
			converters.append(converter(info["type"], None))
			enums.append(None)
			continue
		if not src or src not in holding(src):
			# Not a defect by itself: some columns are ours with no 1C original. It
			# only blocks when the target insists on a value and has no default.
			unmapped.append(column)
			if not info["nullable"] and info["default"] is None:
				blocking.append(column)
			continue
		pairs.append((column, src))
		if column in declared_transforms:
			# The register overlay says this column is not a copy of its source but a
			# reading of it - the magnitude of a signed value, or its direction.
			converters.append(TRANSFORMS[declared_transforms[column]])
		elif column in declared_refs:
			converters.append(tableref_decoder(declared_refs[column]))
		else:
			converters.append(converter(info["type"], holding(src)[src]["type"]))
		enums.append(declared.get(column))

	columns = [p[0] for p in pairs]
	key_at = next((i for i, c in enumerate(columns) if c in keys), None)
	self_refs = [i for i, c in enumerate(columns) if c in pointing_here]
	return Job(entity, schema, table, src_table, mapped.get("query"),
	           pairs, converters, enums,
	           source[src_table]["rows"], unmapped, blocking, derived,
	           self_refs, key_at)


def jobs_for(pg, module, mapping, source, only):
	target = target_tables(pg, module)
	out = []
	for entity, mapped in mapping.get(module, {}).items():
		if only and entity not in only:
			continue
		if entity not in target:
			continue
		job = plan_entity(pg, entity, mapped, target[entity], source)
		if job:
			out.append(job)
	return out


# --------------------------------------------------------------------------- commands

_COUNTING = []


def counted(job):
	"""How many rows the source actually offers - the table's count, or the query's.

	`plan` otherwise reads everything from `out/schema.json` and needs no server; a
	declared query is the one thing only the server can count, so the connection is
	opened when one turns up and not before.
	"""
	if not job.query:
		return job.rows
	if not _COUNTING:
		_COUNTING.append(mssql_connect().cursor())
	_COUNTING[0].execute("SELECT COUNT(*) FROM %s" % reading(job))
	return _COUNTING[0].fetchone()[0]


def cmd_plan(args):
	mapping, source = column_map(), source_schema()
	pg = pg_connect()
	jobs = jobs_for(pg, args.module, mapping, source, args.entity)
	print("%-34s %-16s %10s %6s %6s" % ("entity", "source", "rows", "cols", "gaps"))
	print("-" * 78)
	total = 0
	for job in sorted(jobs, key=lambda j: -j.rows):
		rows = counted(job)
		total += rows
		print("%-34s %-16s %10d %6d %6d"
		      % (job.entity, job.source, rows, len(job.pairs), len(job.unmapped)))
	print("-" * 78)
	print("%-34s %-16s %10d" % ("%d entities" % len(jobs), "", total))

	blocked = [j for j in jobs if j.blocking]
	if blocked:
		print("\nblocked - a NOT NULL column with no source and no default:")
		for job in blocked:
			print("   %-30s %s" % (job.entity, ", ".join(job.blocking)))


def cmd_run(args):
	mapping, source = column_map(), source_schema()
	pg = pg_connect()
	jobs = jobs_for(pg, args.module, mapping, source, args.entity)
	blocked = [j for j in jobs if j.blocking]
	if blocked and not args.force:
		print("refusing: %d entity(ies) have a NOT NULL column with no source."
		      % len(blocked))
		print("run `plan` to see them, or --force to copy the rest.")
		return 1
	jobs = [j for j in jobs if not j.blocking]

	cur = pg.cursor()
	# The generated period-lock and posted-document guards would reject exactly the
	# rows the migration has to write, and so would every foreign key while the
	# catalogs are still half loaded. Replica mode suspends both for this session.
	cur.execute("SET session_replication_role = 'replica'")

	if args.truncate:
		# TRUNCATE where the table allows it, DELETE where it does not. Postgres refuses
		# to truncate a table another table's foreign key points at, and refuses it in
		# replica mode too - that check is not one of the triggers replica mode suspends.
		# So the referenced tables take a DELETE, as they always did.
		#
		# The rest take a TRUNCATE, and on a large table that is the difference between
		# clearing it and doubling it. Measured: `--truncate` on `accounting.posting`
		# left 24,377,440 dead rows in 15 GB that no later pass could reuse, because
		# DELETE only marks a row dead and the space comes back at VACUUM. The reload
		# then wrote on top of all of it, and the disk holding the database ran down to
		# 4.5 GB. TRUNCATE on the same table returned 15 GB to 32 kB, instantly.
		for job in reversed(jobs):
			cur.execute("""
				SELECT count(*) FROM pg_constraint k
				JOIN pg_class t ON t.oid = k.confrelid
				JOIN pg_namespace n ON n.oid = t.relnamespace
				WHERE k.contype = 'f' AND n.nspname = %s AND t.relname = %s""",
				(job.schema, job.table))
			referenced = cur.fetchone()[0]
			verb = "DELETE FROM" if referenced else "TRUNCATE"
			cur.execute('%s "%s"."%s"' % (verb, job.schema, job.table))
		pg.commit()

	source_db = mssql_connect()
	mssql, lookup = source_db.cursor(), source_db.cursor()
	grand = 0
	for job in jobs:
		job = bind_enums(job, lookup)
		columns = [p[0] for p in job.pairs] + ([job.derived] if job.derived else [])
		select = ", ".join("[%s]" % p[1] for p in job.pairs)
		# Taken BEFORE the read: everything 1C changes from here on has a _Version at or
		# above it, so the delta loader picks up exactly what this copy may have missed.
		horizon = delta.horizon(lookup)
		mssql.execute("SELECT %s FROM %s" % (select, reading(job)))
		copied = 0
		while True:
			batch = mssql.fetchmany(CHUNK)
			if not batch:
				break
			rows = converted(job, batch)
			copy_rows(pg, job.schema, job.table, columns, rows)
			copied += len(rows)
			if job.rows > CHUNK:
				sys.stderr.write("\r    %-30s %9d / %d" % (job.entity, copied, job.rows))
		# In the copy's own transaction, so the mark cannot outlive or precede the rows.
		# A pass that did not empty the table first - the ledger's quarters - only ever
		# lowers the mark: an earlier quarter may have changed since it was read.
		delta.record(pg, args.module, job, horizon,
		             lower_only=not args.truncate or bool(os.environ.get("DF1C_FROM")))
		pg.commit()
		if job.rows > CHUNK:
			sys.stderr.write("\r" + " " * 60 + "\r")
		grand += copied
		print("%-34s %-16s %10d" % (job.entity, job.source, copied))
	print("-" * 62)
	print("%-34s %-16s %10d" % ("%d entities" % len(jobs), "", grand))

	if not args.no_placeholders:
		fill_missing(pg, [j.schema for j in jobs])
	return 0


def real_rows(pg, job):
	"""The WHERE that leaves the placeholders out of a comparison with 1C.

	A stand-in row exists because the infobase lost the thing it points at, so counting
	it against the infobase would always disagree by exactly the number of things 1C
	lost.
	"""
	columns = dict((c[0], c) for c in table_columns(pg, job.schema, job.table))
	return " WHERE NOT is_missing" if "is_missing" in columns else ""


def cmd_verify(args):
	"""Row counts, control sums and orphan references - the three cheap checks."""
	mapping, source = column_map(), source_schema()
	pg = pg_connect()
	mssql = mssql_connect().cursor()
	jobs = jobs_for(pg, args.module, mapping, source, args.entity)
	cur = pg.cursor()

	print("%-34s %10s %10s  %s" % ("entity", "1C", "dForge", ""))
	print("-" * 70)
	bad = 0
	for job in jobs:
		mssql.execute("SELECT COUNT(*) FROM %s" % reading(job))
		want = mssql.fetchone()[0]
		cur.execute('SELECT COUNT(*) FROM "%s"."%s"%s'
		            % (job.schema, job.table, real_rows(pg, job)))
		got = cur.fetchone()[0]
		flag = "" if want == got else "  <- differs"
		bad += 1 if want != got else 0
		print("%-34s %10d %10d%s" % (job.entity, want, got, flag))

	print("\ncontrol sums")
	print("-" * 70)
	for job in jobs:
		numeric = [(c, s) for (c, s), f in zip(job.pairs, job.converters)
		           if f is to_number]
		for column, src in numeric:
			mssql.execute("SELECT SUM(CAST([%s] AS decimal(38,8))) FROM %s"
			              % (src, reading(job)))
			want = mssql.fetchone()[0] or 0
			cur.execute('SELECT COALESCE(SUM("%s"), 0) FROM "%s"."%s"%s'
			            % (column, job.schema, job.table, real_rows(pg, job)))
			got = cur.fetchone()[0] or 0
			if decimal.Decimal(want) != decimal.Decimal(got):
				bad += 1
				print("%-22s %-22s 1C=%s  dForge=%s"
				      % (job.entity, column, want, got))
	print("(only differences are listed)")

	print("\norphan references")
	print("-" * 70)
	for (name, schema, table, column,
	     target_schema, target_table, target_column) in foreign_keys(
			pg, [j.schema for j in jobs]):
		cur.execute('SELECT COUNT(*) FROM "%s"."%s" a WHERE a."%s" IS NOT NULL'
		            ' AND NOT EXISTS (SELECT 1 FROM "%s"."%s" b WHERE b."%s" = a."%s")'
		            % (schema, table, column,
		               target_schema, target_table, target_column, column))
		orphans = cur.fetchone()[0]
		if orphans:
			bad += 1
			print("%-32s %-24s %d" % ("%s.%s" % (schema, table), name, orphans))
	print("(only violations are listed)")

	cur.execute("""SELECT e.schema_name, e.db_object
	               FROM "dForge".entity e
	               JOIN "dForge".module m ON m.module_id = e.module_id
	               JOIN "dForge".entity_column ec ON ec.entity_id = e.entity_id
	               WHERE m.module_cd = %s AND ec.column_cd = 'is_missing'""",
	            (args.module,))
	standing_in = 0
	for schema, table in cur.fetchall():
		cur2 = pg.cursor()
		cur2.execute('SELECT COUNT(*) FROM "%s"."%s" WHERE is_missing' % (schema, table))
		standing_in += cur2.fetchone()[0]
	print("\n%d placeholder row(s) standing in for references 1C had lost"
	      % standing_in)

	print("\n%s" % ("clean" if not bad else "%d problem(s)" % bad))
	return 1 if bad else 0


EMPTY_BY_TYPE = {
	"binary": "[%s] IS NULL OR [%s] = 0x00000000000000000000000000000000",
	"datetime": "[%s] IS NULL OR [%s] < '2001-01-02'",
}


TEXTUAL = ("char", "varchar", "nchar", "nvarchar", "text", "ntext")


def incompatible(target_type, held, is_enum, is_tableref):
	"""Can this column hold what the infobase keeps in that one?

	The three ways an authored spec gets this wrong, all seen: it declares a user picker
	where 1C keeps a typed-in name, it declares a lookup where 1C keeps text, and it
	declares text where 1C keeps a reference and nothing says how to read it.
	"""
	kind, width = held["type"], held.get("len")
	reference = kind == "binary" and width == 16
	if reference and target_type != "uuid" and not (is_enum or is_tableref):
		return "a reference, with nothing saying how to read it"
	if kind in TEXTUAL and target_type in NUMERIC_TYPES:
		return "%s(%s) - text, not a number" % (kind, width)
	if kind in TEXTUAL and target_type == "uuid":
		return "%s(%s) - text, not a key" % (kind, width)
	if not reference and target_type == "uuid" and kind != "binary":
		return "%s - not a key" % kind
	if kind in ("image", "varbinary") and target_type != "bytea":
		return "%s - a serialized value, not a %s" % (kind, target_type)
	return None


def unique_constraints(pg, schema, table):
	"""[(name, [column, ...])] for the unique constraints and indexes on a table."""
	cur = pg.cursor()
	cur.execute("""SELECT c.conname, array_agg(a.attname ORDER BY k.ord)
	               FROM pg_constraint c
	               JOIN pg_class t ON t.oid = c.conrelid
	               JOIN pg_namespace n ON n.oid = t.relnamespace
	               JOIN unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
	               JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
	               WHERE c.contype = 'u' AND n.nspname = %s AND t.relname = %s
	               GROUP BY c.conname""", (schema, table))
	return cur.fetchall()


def cmd_check(args):
	"""Where the port insists on a value, does the infobase actually hold one?

	A mandatory column in an authored spec is a guess about the data until the data is
	asked - and the data disagrees more often than it looks. 264 of the 12,208 vehicles
	carry no kind at all, which the spec had declared required, and the load finds that
	out one failed COPY at a time. This asks every one of them up front.

	`--types` asks only the questions the cached schema dump can answer - can this column
	hold what it copies, and is it wide enough - and skips every count against MS SQL. That
	half is seconds rather than an afternoon, which matters because the afternoon is why it
	gets skipped: a standard configuration's 623 entities were loaded without it, and an
	hour later `to_uuid` was handed a string this would have named at once. `all` in place of
	a module name checks every module in the map.
	"""
	mapping, source = column_map(), source_schema()
	pg = pg_connect()
	mssql = None if args.types else mssql_connect().cursor()
	modules = sorted(mapping) if args.module == "all" else [args.module]
	jobs = [j for m in modules for j in jobs_for(pg, m, mapping, source, args.entity)]

	declared = dict((entity, found) for module in modules
	                for entity, found in mapping.get(module, {}).items())
	declared_enums = dict((e, f.get("enums") or {}) for e, f in declared.items())
	declared_refs = dict((e, f.get("tablerefs") or {}) for e, f in declared.items())
	# A column the entity reads through a joined-in table is typed by that table,
	# not by the entity's own source - the same reading `plan_entity` does.
	declared_joins = dict((e, f.get("joined") or {}) for e, f in declared.items())

	print("%-26s %-22s %10s %10s" % ("entity", "column", "rows", "empty"))
	print("-" * 72)
	wrong, narrow, mistyped = 0, [], []
	for job in jobs:
		columns = dict((c[0], c) for c in table_columns(pg, job.schema, job.table))
		src_columns = source[job.source]["columns"]
		for column, src in job.pairs:
			info = columns.get(column)
			if not info:
				continue
			# An authored width is a guess too. `vehicle.plate_no` was declared
			# varchar(20) against a column 1C gives 25 characters.
			joined = declared_joins.get(job.entity) or {}
			if src in joined:
				held = source[joined[src]]["columns"][src]
			elif src not in src_columns:
				# A column the declared query produces and the table has not got. The
				# schema dump cannot type it, so there is nothing here to check it
				# against - the target's type is the only claim being made.
				continue
			else:
				held = src_columns[src]
			reason = incompatible(info[1], held, column in (declared_enums.get(job.entity)
			                                                or {}),
			                      column in (declared_refs.get(job.entity) or {}))
			if reason:
				mistyped.append((job.entity, column, info[1], reason))
			if info[1] in ("character varying", "character") and info[6]:
				width = held.get("len") or 0
				if held["type"].startswith("n"):
					width //= 2
				if width > info[6]:
					narrow.append((job.entity, column, info[6], width))
			if mssql is None or info[2] == "YES" or info[3] is not None:
				continue
			kind = held["type"]
			predicate = EMPTY_BY_TYPE.get(kind, "[%s] IS NULL")
			predicate = predicate.replace("%s", src)
			mssql.execute("SELECT COUNT(*), SUM(CASE WHEN %s THEN 1 ELSE 0 END)"
			              " FROM %s" % (predicate, reading(job)))
			total, empty = mssql.fetchone()
			if empty:
				wrong += 1
				print("%-26s %-22s %10d %10d" % (job.entity, column, total, empty))
	print("-" * 72)
	if mssql is None:
		print("mandatory columns: not asked (--types)")
	else:
		print("%d mandatory column(s) the infobase leaves empty" % wrong)

	# A uniqueness the port declares is a claim about the data too, and the same kind of
	# guess: 359 plate numbers are on more than one vehicle.
	clashes = []
	for job in (jobs if mssql is not None else []):
		for name, columns in unique_constraints(pg, job.schema, job.table):
			sources = [dict(job.pairs).get(c) for c in columns]
			if not all(sources):
				continue
			listed = ", ".join("[%s]" % c for c in sources)
			mssql.execute("SELECT COUNT(*) FROM (SELECT %s FROM %s"
			              " GROUP BY %s HAVING COUNT(*) > 1) d"
			              % (listed, reading(job), listed))
			repeated = mssql.fetchone()[0]
			if repeated:
				clashes.append((job.entity, name, repeated))
	if clashes:
		print("\n%-26s %-30s %10s" % ("entity", "constraint", "repeated"))
		print("-" * 70)
		for entity, name, repeated in clashes:
			print("%-26s %-30s %10d" % (entity, name, repeated))
		print("-" * 70)
	if mssql is None:
		print("unique constraints: not asked (--types)")
	else:
		print("%d unique constraint(s) the infobase does not honour" % len(clashes))

	if narrow:
		print("\n%-26s %-22s %8s %8s" % ("entity", "column", "ours", "theirs"))
		print("-" * 68)
		for entity, column, ours, theirs in narrow:
			print("%-26s %-22s %8d %8d" % (entity, column, ours, theirs))
		print("-" * 68)
	print("%d column(s) narrower than the column they copy from" % len(narrow))

	if mistyped:
		print("\n%-26s %-22s %-20s %s" % ("entity", "column", "ours", "theirs"))
		print("-" * 78)
		for entity, column, ours, reason in mistyped:
			print("%-26s %-22s %-20s %s" % (entity, column, ours, reason))
		print("-" * 78)
	print("%d column(s) that cannot hold what they copy" % len(mistyped))
	return 1 if (wrong or narrow or clashes or mistyped) else 0


def cmd_fill(args):
	"""The placeholder pass on its own, for a load that ran with --no-placeholders."""
	mapping, source = column_map(), source_schema()
	pg = pg_connect()
	jobs = jobs_for(pg, args.module, mapping, source, args.entity)
	fill_missing(pg, [j.schema for j in jobs])
	return 0


def main():
	load_env()
	ap = argparse.ArgumentParser(
		description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
	ap.add_argument("command",
	                choices=("plan", "run", "verify", "fill", "check"))
	ap.add_argument("module")
	ap.add_argument("entity", nargs="*", help="limit to these entities")
	ap.add_argument("--truncate", action="store_true",
	                help="empty the target tables first")
	ap.add_argument("--force", action="store_true",
	                help="copy what can be copied, skipping blocked entities")
	ap.add_argument("--types", action="store_true",
	                help="check only what the schema dump can answer, over every module")
	ap.add_argument("--no-placeholders", action="store_true",
	                help="leave dangling references dangling instead of standing a"
	                     " flagged row in for each")
	args = ap.parse_args()
	return {"plan": cmd_plan, "run": cmd_run, "verify": cmd_verify,
	        "fill": cmd_fill, "check": cmd_check}[args.command](args)


if __name__ == "__main__":
	sys.exit(main() or 0)
