#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Read a FILE infobase - the `1Cv8.1CD` 1C keeps when it runs without a server - with no 1C
software. It is the same tables a server infobase keeps in MS SQL (`Config`, `Params`,
`_Reference12`, `_Fld345`), in 1C's own page format, and this reads them row by row.

Formats 8.2.14 (4 KB pages) and 8.3.8 (4-64 KB pages) - every file infobase 8.2 and 8.3
write. The layout is not published by 1C; it is the one Tool_1CD and onec_dtools read,
checked against the Platform8Demo fixtures in all three formats.

    file header     page 0: "1CDBMSV8", the format version, the page count, the page size
    an object       a header page listing its data pages (directly, or through index pages);
                    a table is three of them - records, blobs, indexes
    the root        object 2: the locale and one text description per table
    a record        a fixed-width row; the first byte set marks a free slot
    a blob          256-byte blocks inside the blob object, chained by the next block's number

Read it while 1C is not writing to it - a copy of the file, or with the infobase closed. A
file has no `MIN_ACTIVE_ROWVERSION`: what is in it is what was committed.
"""
import collections
import datetime
import decimal
import re
import struct

ROOT = 2
BLOCK = 256
FORMATS = ("8.2.14.0", "8.3.8.0")

Field = collections.namedtuple("Field", "name type nullable length precision offset size")


class Database(object):
	def __init__(self, path):
		self.path = path
		self.file = open(path, "rb")
		head = self.file.read(24)
		if head[:8] != b"1CDBMSV8":
			raise ValueError("%s is not a 1C file infobase (no 1CDBMSV8 signature)" % path)
		self.version = ".".join(str(b) for b in bytearray(head[8:12]))
		if self.version not in FORMATS:
			raise NotImplementedError("1CD format %s: only %s are read" % (self.version, ", ".join(FORMATS)))
		self.page_size = 4096
		if self.version == "8.3.8.0":
			(self.page_size,) = struct.unpack_from("<I", head, 20)
		root = Object(self, ROOT)
		if self.version == "8.3.8.0":
			# 8.3.8 keeps the root as a blob in its own object: block 1 is the header.
			data = blob(root, 1)
			describe = lambda offset: blob(root, offset).decode("utf-8")
		else:
			data = root.read(0, len(root))
			describe = lambda offset: Object(self, offset).read_all().decode("utf-16-le")
		self.locale = data[:32].rstrip(b"\x00").decode("utf-8")
		(count,) = struct.unpack_from("<i", data, 32)
		self.tables = collections.OrderedDict()
		for offset in struct.unpack_from("<%di" % count, data, 36):
			table = Table(self, describe(offset))
			self.tables[table.name] = table

	def page(self, number, size=None):
		self.file.seek(number * self.page_size)
		return self.file.read(size or self.page_size)

	def close(self):
		self.file.close()


class Object(object):
	"""One object of the file: its length and the pages that hold it, in order."""

	def __init__(self, db, number):
		self.db = db
		head = db.page(number)
		size = db.page_size
		if db.version == "8.3.8.0":
			if head[:2] != b"\x1c\xfd":
				raise ValueError("object at page %d: signature %r" % (number, head[:2]))
			(fat,) = struct.unpack_from("<H", head, 2)
			(self.length,) = struct.unpack_from("<Q", head, 16)
			slots = struct.unpack_from("<%dI" % ((size - 24) // 4), head, 24)
			if fat == 0:
				self.pages = list(slots[:-(-self.length // size)])
			elif fat == 1:
				self.pages = []
				for index in slots:
					if not index:
						break
					for page in struct.unpack("<%dI" % (size // 4), db.page(index)):
						if not page:
							break
						self.pages.append(page)
			else:
				raise NotImplementedError("object at page %d: allocation depth %d" % (number, fat))
		else:
			if head[:8] != b"1CDBOBV8":
				raise ValueError("object at page %d: signature %r" % (number, head[:8]))
			(self.length,) = struct.unpack_from("<i", head, 8)
			indexes = (self.length - 1) // (1023 * size) + 1 if self.length else 0
			self.pages = []
			for index in struct.unpack_from("<%dI" % indexes, head, 24):
				data = db.page(index)
				(n,) = struct.unpack_from("<i", data, 0)
				self.pages.extend(struct.unpack_from("<%dI" % n, data, 4))

	def __len__(self):
		return self.length

	def read(self, at, count):
		size, out = self.db.page_size, []
		count = min(count, self.length - at)
		while count > 0:
			page, within = divmod(at, size)
			take = min(size - within, count)
			self.db.file.seek(self.pages[page] * size + within)
			out.append(self.db.file.read(take))
			at, count = at + take, count - take
		return b"".join(out)

	def read_all(self):
		return self.read(0, self.length)

	def chunks(self, width, per=None):
		"""The object as consecutive `width`-byte slices, read a run of pages at a time."""
		per = per or max(1, (1 << 20) // width)
		at = 0
		while at < self.length:
			data = self.read(at, width * per)
			for i in range(0, len(data) - width + 1, width):
				yield data[i:i + width]
			at += width * per


def blob(obj, block):
	"""A value kept in a blob object: the 256-byte blocks from `block` on, by their links."""
	out = []
	while block:
		data = obj.read(block * BLOCK, BLOCK)
		block, used = struct.unpack_from("<Ih", data, 0)
		out.append(data[6:6 + used])
	return b"".join(out)


# --------------------------------------------------------------------------- tables

TABLE = re.compile(r'^\{"([^"]+)",\d+,?\s*\{"Fields",(.*?)\},\s*\{"Indexes".*'
                   r'\{"Recordlock","(\d)"\},\s*\{"Files",(\d+),(\d+),(\d+)\}\s*\}\s*$', re.S)
FIELD = re.compile(r'\{"(\w+)","(\w+)",(\d),(\d+),(\d+),"(\w+)"\}')

WIDTH = {
	"B": lambda n: n,          # binary(n)
	"L": lambda n: 1,          # boolean
	"N": lambda n: n // 2 + 1, # BCD digits behind a sign nibble
	"NC": lambda n: n * 2,     # nchar(n), UTF-16
	"NVC": lambda n: n * 2 + 2,# nvarchar(n): a u16 length, then the characters
	"RV": lambda n: 16,        # the row version
	"NT": lambda n: 8,         # ntext: a blob reference
	"I": lambda n: 8,          # image: a blob reference
	"DT": lambda n: 7,         # datetime, BCD YYYYMMDDhhmmss
}


class Table(object):
	def __init__(self, db, description):
		self.db = db
		match = TABLE.match(description.lstrip(u"﻿").strip())
		if not match:
			raise ValueError("cannot read the table description %r" % description[:120])
		self.name = match.group(1)
		self.records, self.blobs, self.indexes = (int(match.group(i)) for i in (4, 5, 6))
		self.fields = collections.OrderedDict()
		specs = FIELD.findall(match.group(2))
		# The row version, when a table has one, sits first after the free-slot byte.
		offset = 17 if any(s[1] == "RV" for s in specs) else 1
		for name, kind, nullable, length, precision, _ in specs:
			if kind not in WIDTH:
				raise ValueError("%s.%s: field type %s" % (self.name, name, kind))
			size = (nullable == "1") + WIDTH[kind](int(length))
			if kind == "RV":
				at = 1
			else:
				at, offset = offset, offset + size
			self.fields[name] = Field(name, kind, nullable == "1", int(length), int(precision), at, size)
		# A record is never shorter than a free-slot byte and the next free slot's number.
		self.width = max(offset, 5)
		self._records = self._blobs = None

	def _object(self, which):
		if which == "records":
			if self._records is None:
				self._records = Object(self.db, self.records) if self.records else None
			return self._records
		if self._blobs is None:
			self._blobs = Object(self.db, self.blobs)
		return self._blobs

	def __len__(self):
		"""Slots, the free ones included; `rows()` skips those."""
		obj = self._object("records")
		return len(obj) // self.width if obj else 0

	def count(self):
		"""Live rows: the slots whose free-slot byte is clear."""
		obj = self._object("records")
		return sum(1 for raw in obj.chunks(self.width) if raw[:1] != b"\x01") if obj else 0

	def rows(self, columns=None):
		"""Live rows as tuples of Python values, in `columns` order (all fields by default)."""
		obj = self._object("records")
		if obj is None:
			return
		fields = [self.fields[c] for c in (columns or list(self.fields))]
		for raw in obj.chunks(self.width):
			if raw[:1] == b"\x01":
				continue
			yield tuple(self.value(f, raw) for f in fields)

	def value(self, field, raw):
		data = raw[field.offset:field.offset + field.size]
		if field.nullable:
			if data[:1] == b"\x00":
				return None
			data = data[1:]
		kind = field.type
		if kind == "B":
			return data
		if kind == "L":
			return data[:1] != b"\x00"
		if kind == "N":
			return numeric(data, field.length, field.precision)
		if kind == "NC":
			return data.decode("utf-16-le")
		if kind == "NVC":
			(n,) = struct.unpack_from("<H", data, 0)
			return data[2:2 + n * 2].decode("utf-16-le")
		if kind == "RV":
			return struct.unpack("<4I", data)
		if kind == "DT":
			return moment(data)
		block, size = struct.unpack("<2I", data)
		if not block and not size:
			return u"" if kind == "NT" else b""
		value = blob(self._object("blobs"), block)[:size]
		return value.decode("utf-16-le") if kind == "NT" else value


def numeric(data, length, precision):
	"""BCD: the high nibble of the first byte is the sign (1 positive), then `length` digits.

	A Decimal, never a float: the kopeck has to survive the read.
	"""
	digits = "".join("%02x" % b for b in bytearray(data))
	sign, body = digits[0], digits[1:1 + length]
	if precision:
		body = body[:length - precision] + "." + body[length - precision:]
	value = decimal.Decimal(body)
	return value if sign != "0" else -value


def moment(data):
	digits = "".join("%02x" % b for b in bytearray(data))
	year = int(digits[0:4])
	if year == 0:
		# The empty date, which a server infobase holds as 0001-01-01 (shifted).
		return datetime.datetime(1, 1, 1)
	return datetime.datetime(year, int(digits[4:6]), int(digits[6:8]),
	                         int(digits[8:10]), int(digits[10:12]), int(digits[12:14]))
