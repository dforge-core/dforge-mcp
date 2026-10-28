# -*- coding: utf-8 -*-
"""
A file infobase (`1Cv8.1CD`) as an export source: `onecd` reads it, this makes what it
reads look like what a server infobase gives, so nothing downstream asks which one it was.

Three differences are folded here and nowhere else:

- NAMES. A file infobase keeps every name in capitals - `_REFERENCE12`, `_FLD345RREF` - where
  MS SQL has `_Reference12`, `_Fld345RRef`, and the column map, the project's sources and
  the library all spell them the MS SQL way. The spelling is put back from DBNames, which
  carries every numbered kind in its own case (`AccumRgT`, `ReferenceChngR`, `VT`, `Fld`),
  plus the fixed names 1C gives the standard columns. A name neither covers is a service
  table's own business that nothing reads; it is capitalised and counted in the manifest.
- TYPES. The schema is written in MS SQL's vocabulary - `binary(16)`, `nvarchar`, `numeric`,
  `datetime`, `len` in bytes as `sys.columns` gives it - because that is what the generator
  and the checks read.
- VALUES. A boolean is `binary(1)` 0x01 / 0x00 as on MS SQL; the empty date is 0001-01-01.
  A file infobase has no year offset: its dates are the real ones, and the manifest says so.

What does NOT carry over is the row version. In a file `_Version` is a per-table counter,
not MS SQL's database-wide rowversion, so a file export has no horizon and `delta` cannot
read changes off it. It is exported as `binary(16)`, for completeness only.
"""
import os
import re
import struct

import dump1c
import onecd

SERVICE = dict((n.upper(), n) for n in (
	"Config", "ConfigSave", "Params", "Files", "DBSchema", "IBVersion", "v8users", "_YearOffset",
	"FileName", "Creation", "Modified", "Attributes", "DataSize", "BinaryData", "PartNo",
	"SerializedData",
	# v8users and IBVersion
	"ID", "Name", "Descr", "OSName", "Changed", "RolesID", "Show", "Data", "EAuth", "AdmRole",
	"UsSprH", "PlatformVersionReq"))

# The un-numbered segments of 1C's names as MS SQL spells them, between underscores:
# `_Fld12_TYPE` is `Fld12` and `TYPE`. Harvested from a server infobase's whole schema
# (2,668 tables, 28,715 columns) rather than remembered, so a list that misses one is
# fixed by harvesting again. Where two spellings fold to one - `UserId` and `UserID` both
# occur - the commoner one is here and `migrate` matches the other regardless of case.
WORDS = dict((w.upper(), w) for w in (
	"APDateFrom", "APDateTill", "AccountCtRRef", "AccountDtRRef", "AccountRRef", "ActionPeriod",
	"ActivationCondition", "Active", "ActualPeriod", "BPDateFrom", "BPDateTill", "BaseAsAct",
	"BaseCK", "BaseCKBaseCK", "BaseCKBaseCKRRef", "BaseCKLineNo", "BusinessProcess", "CKRefRRef",
	"CalcKindRRef", "Code", "Completed", "ConfigChngR", "ConnectPrms", "ConstID", "Correspond",
	"Date", "Description", "DimHash", "DimIsMetadata", "DimKindRRef", "DisplNumber", "DisplacedCK",
	"DisplacedCKDisplCKRRef", "DisplacedCKLineNo", "DocumentRRef", "DocumentTRef", "EDHashCt",
	"EDHashDt", "EnumOrder", "Executed", "ExtDataSrcId", "ExtProps", "FileName", "FinishTime",
	"Folder", "HeadTaskRRef", "ID", "IDRRef", "IsMetadata", "JobKey", "KeyField", "Kind",
	"KindRRef", "LeadingCK", "LeadingCKLeadingCK", "LeadingCKLineNo", "LineNo", "MDObjID",
	"Marked", "MessageNo", "MetadataID", "MinPeriod", "Name", "NodeRRef", "NodeTRef", "Number",
	"NumberPrefix", "ObjectKey", "OffBalance", "OrderField", "OwnerID", "OwnerIDRRef",
	"Parameters", "ParentIDRRef", "Period", "Periodicity", "Point", "Posted", "Predefined",
	"PredefinedBaseCKTableLine", "PredefinedDisplCKTableLine", "PredefinedID",
	"PredefinedLeadingCKTableLine", "PredefinedObj", "ReceivedNo", "RecordKey", "RecordKind",
	"Recorder", "RecorderRRef", "RecorderTRef", "RegID", "RepetitionFactor",
	"RestartAttemptNumber", "RestartCount", "RestartPeriod", "RoutePointOrder", "SentNo",
	"SettingsData", "SettingsKey", "SettingsPresentation", "SimpleKey", "SliceUsing", "Splitter",
	"StartTime", "Started", "State", "Storno", "TurnoverOnly", "URL", "URLHash", "Use",
	"UseSplitter", "UseTotals", "UserId", "UserName", "Value", "Value1", "Value2", "Value3",
	"Value4", "Version", "YearOffset",
	# a composite reference's parts, and a column's own type tag
	"RRRef", "RTRef", "RRef", "TRef", "L", "N", "T", "S", "B"))
# What follows a numbered kind inside one segment: `_Fld12RRef`, `_Fld12DtRRef`.
SUFFIXES = ("CtRRef", "DtRRef", "RRef", "TRef", "Ct", "Dt", "")


class Names(object):
	"""Upper-case 1CD names -> the MS SQL spelling, from DBNames' kinds."""

	def __init__(self, kinds):
		self.kinds = sorted(set(kinds), key=len, reverse=True)
		self.numbered = [(re.compile("^%s(\\d+)(%s)$" % (k.upper(), "|".join(s.upper() for s in SUFFIXES))), k)
		                 for k in self.kinds]
		self.guessed = set()

	def __call__(self, name):
		if name in SERVICE:
			return SERVICE[name]
		parts = name.replace("DATE_TIME", "DATE\x00TIME").split("_")
		out = []
		for at, part in enumerate(parts):
			if part == "DATE\x00TIME":
				out.append("Date_Time")
			elif not part:
				out.append(part)
			elif part == "TYPE":
				# A column of its own is `_Type` (a characteristic's value type); after
				# another segment it is a composite reference's tag, `_Fld12_TYPE`.
				out.append("Type" if at == 1 else "TYPE")
			else:
				out.append(self.segment(part, name))
		return "_".join(out)

	def segment(self, part, name):
		for pattern, kind in self.numbered:
			match = pattern.match(part)
			if match:
				suffix = next(s for s in SUFFIXES if s.upper() == match.group(2))
				return kind + match.group(1) + suffix
		if part in WORDS:
			return WORDS[part]
		# A kind with no number of its own: a service table such as `_AccOpt`.
		for kind in self.kinds:
			if part == kind.upper():
				return kind
		self.guessed.add(name)
		match = re.match(r"^([A-Z]+)(\d*)(.*)$", part)
		return (match.group(1).capitalize() + match.group(2) + match.group(3)) if match else part


def numeric_bytes(precision):
	"""What `sys.columns.max_length` says for numeric(p): the schema dump carries it as-is."""
	return 5 if precision <= 9 else 9 if precision <= 19 else 13 if precision <= 28 else 17


def column_type(field):
	"""A 1CD field -> the schema dump's (type, len, precision, scale) in MS SQL terms."""
	kind, n = field.type, field.length
	if kind == "B":
		return "binary", n, 0, 0
	if kind == "L":
		return "binary", 1, 0, 0
	if kind == "N":
		return "numeric", numeric_bytes(n), n, field.precision
	if kind == "NC":
		return "nchar", n * 2, 0, 0
	if kind == "NVC":
		return "nvarchar", n * 2, 0, 0
	if kind == "NT":
		return "nvarchar", -1, 0, 0
	if kind == "I":
		return "varbinary", -1, 0, 0
	if kind == "DT":
		return "datetime", 8, 23, 3
	if kind == "RV":
		return "binary", 16, 0, 0
	raise ValueError("1CD field type %s" % kind)


def canonical(field):
	"""A function turning one of `onecd`'s values for this field into MS SQL's."""
	if field.type == "L":
		return lambda v: None if v is None else (b"\x01" if v else b"\x00")
	if field.type == "RV":
		return lambda v: None if v is None else struct.pack(">4I", *v)
	return None


class FileSource(object):
	kind = "file"
	year_offset = 0
	consistent = "the file as it was read; copy it, or close the infobase, before exporting"

	def __init__(self, path):
		self.path = os.path.abspath(path)
		self.db = onecd.Database(self.path)
		self._files = {}
		self._tables = None
		self.names = Names(e["type"] for e in dump1c.parse_dbnames(self.read_file("Params", "DBNames")))
		self.by_name = dict((self.names(t), t) for t in self.db.tables)

	def describe(self):
		return {"kind": self.kind, "path": self.path, "format": self.db.version,
		        "page_size": self.db.page_size, "locale": self.db.locale}

	def _table(self, name):
		return self.db.tables[self.by_name[name] if name in self.by_name else name.upper()]

	def _service(self, table):
		"""A service table's files, {name: [(part, compressed body)]}, read in one pass: a
		blob is reached only through its row, so a read per file would read them all again."""
		table = table.upper()
		if table not in self._files:
			found = {}
			for name, part, body in self.db.tables[table].rows(["FILENAME", "PARTNO", "BINARYDATA"]):
				found.setdefault(name, []).append((part or 0, body or b""))
			self._files[table] = found
		return self._files[table]

	def files(self, table):
		return sorted(self._service(table))

	def read_file(self, table, name):
		parts = sorted(self._service(table).get(name, ()))
		return dump1c.inflate(b"".join(body for _, body in parts))

	def tables(self):
		"""[(name, columns, rows)] - the schema dump's shape, every table in the file.

		Counting a table's rows reads all of it - a file keeps no row count - so this is
		worked out once per run, however many commands of `dump1c all` ask for it."""
		if self._tables is None:
			self._tables = self._read_tables()
		return self._tables

	def _read_tables(self):
		out = []
		for raw, table in self.db.tables.items():
			columns = []
			for field in table.fields.values():
				kind, length, precision, scale = column_type(field)
				columns.append({"column": self.names(field.name), "type": kind, "len": length,
				                "precision": precision, "scale": scale, "nullable": field.nullable})
			out.append((self.names(raw), columns, table.count()))
		return out

	def rows(self, table, columns, chunk):
		"""Batches of tuples, in `columns` order (the MS SQL spelling)."""
		t = self._table(table)
		by_name = dict((self.names(f), f) for f in t.fields)
		raw = [by_name[c] for c in columns]
		fix = [canonical(t.fields[r]) for r in raw]
		batch = []
		for row in t.rows(raw):
			batch.append(tuple(f(v) if f else v for f, v in zip(fix, row)))
			if len(batch) >= chunk:
				yield batch
				batch = []
		if batch:
			yield batch

	def horizon(self):
		return None
