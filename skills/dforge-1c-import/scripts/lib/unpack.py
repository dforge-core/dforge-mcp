#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Unpack a 1C inner container - the `<guid>.0` entries of the Config table.

Those hold the object's modules and forms. The format is a paged container:

    header   FF FF FF 7F | nextPage u32 | pageSize u32 | storageVer u32
    block    \\r\\n <8 hex docSize> ' ' <8 hex pageSize> ' ' <8 hex nextPage> ' ' \\r\\n
             followed by pageSize bytes, chained through nextPage until docSize is read
    TOC      the block at offset 16: 12-byte entries of (attrsAddr, dataAddr, reserved)
    attrs    created u64 | modified u64 | reserved u32 | name, UTF-16LE

Each entry's data may itself be raw deflate.

    python tools/unpack.py <ObjectName>            # list what the object's container holds
    python tools/unpack.py <ObjectName> --dump DIR # write every entry to DIR
    python tools/unpack.py <ObjectName> --code     # print the module texts
"""
from __future__ import print_function

import codecs
import os
import struct
import sys
import zlib

import attrs
import meta

FREE = 0x7FFFFFFF
CONFIG = meta.CONFIG


def read_block(buf, addr):
	head = buf[addr:addr + 31]
	if head[:2] != b"\r\n":
		raise ValueError("no block header at %d" % addr)
	doc_size = int(head[2:10], 16)
	page_size = int(head[11:19], 16)
	next_addr = int(head[20:28], 16)
	out = bytearray(buf[addr + 31:addr + 31 + page_size])
	while next_addr != FREE and len(out) < doc_size:
		head = buf[next_addr:next_addr + 31]
		page_size = int(head[11:19], 16)
		following = int(head[20:28], 16)
		out += buf[next_addr + 31:next_addr + 31 + page_size]
		next_addr = following
	return bytes(out[:doc_size])


def inflate(data):
	try:
		return zlib.decompressobj(-15).decompress(data)
	except zlib.error:
		return data


def entries(buf):
	"""[(name, content), ...] for one container."""
	if buf[:4] != b"\xff\xff\xff\x7f":
		return []
	toc = read_block(buf, 16)
	out = []
	for offset in range(0, len(toc) - 11, 12):
		attrs_addr, data_addr, _ = struct.unpack_from("<III", toc, offset)
		if attrs_addr == FREE or data_addr == FREE:
			continue
		header = read_block(buf, attrs_addr)
		name = header[20:].decode("utf-16-le", "replace").rstrip("\x00")
		out.append((name, inflate(read_block(buf, data_addr))))
	return out


def containers_of(guid):
	"""Every Config file belonging to this object that is a container."""
	found = []
	for suffix in (".0", ".1", ".2"):
		path = os.path.join(CONFIG, guid + suffix + ".bin")
		if os.path.isfile(path):
			with open(path, "rb") as f:
				found.append((guid + suffix, f.read()))
	return found


def as_text(blob):
	for encoding in ("utf-8-sig", "utf-16-le", "cp1251"):
		try:
			text = blob.decode(encoding)
		except (UnicodeDecodeError, LookupError):
			continue
		if text.count("�") == 0:
			return text
	return None


def main():
	name = sys.argv[1]
	objects = attrs.load_json("objects.json")
	guid = next((o["guid"] for o in objects if o.get("name") == name), None)
	if not guid:
		print("no such object: %s" % name)
		return

	found = containers_of(guid)
	if not found:
		print("%s has no container files" % name)
		return

	dump_dir = None
	if "--dump" in sys.argv:
		dump_dir = sys.argv[sys.argv.index("--dump") + 1]
		if not os.path.isdir(dump_dir):
			os.makedirs(dump_dir)

	for container, blob in found:
		items = entries(blob)
		print("== %s  (%d entries, %d bytes)" % (container, len(items), len(blob)))
		for entry_name, content in items:
			text = as_text(content)
			kind = "text %d chars" % len(text) if text else "binary %d bytes" % len(content)
			print("   %-28s %s" % (entry_name or "(unnamed)", kind))
			if dump_dir:
				safe = (entry_name or "unnamed").replace("/", "_")
				path = os.path.join(dump_dir, "%s.%s" % (container, safe))
				with open(path, "wb") as f:
					f.write(content)
			if "--code" in sys.argv and text and "Процедура" in text or \
			   "--code" in sys.argv and text and "Функция" in text:
				print("-" * 70)
				print(text[:4000])
				print("-" * 70)


if __name__ == "__main__":
	main()
