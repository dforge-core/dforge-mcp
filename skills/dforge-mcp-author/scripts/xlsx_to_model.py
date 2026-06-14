#!/usr/bin/env python3
"""Extract sheets/tables from an .xlsx into a JSON "model" for dForge import.

Pure standard library (zipfile + xml.etree) — NO `pip install` needed, runs on
any Python 3. An .xlsx is a zip of XML; this reads each worksheet grid (a capped
sample of rows) and resolves cell strings from the shared-string table, then
prints, per sheet, the header row + a sample of data rows. The AI then turns that
model into a dForge table-spec and calls `dforge_module_import`.

Memory-bounded by design: it streams each worksheet (clearing elements) and only
materialises the FIRST `max_data_rows` rows; it then loads ONLY the shared
strings those sampled cells actually reference — never the whole string table —
so there is no cap that could silently drop values.

Usage:   python3 xlsx_to_model.py <file.xlsx> [max_data_rows]
Output:  JSON on stdout — {"sheets":[{"name","headers":[...],"rows":[[...],...]}]}
         (on failure: {"error": "..."} with a non-zero exit)

Caveat: date cells are stored as serial numbers in xlsx; they come through as
numbers here. Recognise date columns by header name when building the spec.
"""
import sys
import json
import re
import zipfile
import xml.etree.ElementTree as ET

REL_NS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"


def localname(tag):
    return tag.rsplit("}", 1)[-1]


def col_index(ref):
    """'B7' -> 1 (0-based column index)."""
    m = re.match(r"([A-Z]+)", ref or "")
    if not m:
        return 0
    n = 0
    for ch in m.group(1):
        n = n * 26 + (ord(ch) - 64)
    return n - 1


def sheet_paths(z):
    wb = ET.fromstring(z.read("xl/workbook.xml"))
    rels = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
    rid_target = {r.get("Id"): r.get("Target") for r in rels}
    sheets = []
    for sh in wb.iter():
        if localname(sh.tag) != "sheet":
            continue
        rid = sh.get(REL_NS) or sh.get("id")
        target = (rid_target.get(rid) or "").lstrip("/")
        if target and not target.startswith("xl/"):
            target = "xl/" + target
        sheets.append((sh.get("name"), target))
    return sheets


def raw_cell(c):
    """Raw cell payload: the <v> text, or the concatenated <is> inline string."""
    for ch in c:
        name = localname(ch.tag)
        if name == "v":
            return ch.text
        if name == "is":
            return "".join(x.text or "" for x in ch.iter() if localname(x.tag) == "t")
    return None


def parse_sheet_raw(z, path, max_rows):
    """Stream a worksheet into raw rows of (cell_type, raw_value) tuples, capped
    at max_rows+1 non-empty rows. Strings are NOT resolved yet (pass 2 does that)."""
    rows = []
    cells, maxc = {}, -1
    with z.open(path) as f:
        for event, el in ET.iterparse(f, events=("end",)):
            name = localname(el.tag)
            if name == "c":
                i = col_index(el.get("r"))
                cells[i] = (el.get("t"), raw_cell(el))
                if i > maxc:
                    maxc = i
                el.clear()
            elif name == "row":
                row = [cells.get(i) for i in range(maxc + 1)]
                # A row counts only if a cell carries an actual VALUE — styled /
                # bordered but empty cells still emit a <c> node (no <v>), and
                # must not consume a sample slot before the real data is reached.
                if any(c is not None and c[1] not in (None, "") for c in row):
                    rows.append(row)
                cells, maxc = {}, -1
                el.clear()
                if len(rows) >= max_rows + 1:
                    break
    return rows


def needed_string_indices(sheets_raw):
    need = set()
    for rows in sheets_raw:
        for row in rows:
            for cell in row:
                if cell and cell[0] == "s" and cell[1] is not None:
                    try:
                        need.add(int(cell[1]))
                    except ValueError:
                        pass
    return need


def load_shared_subset(z, needed):
    """Stream the shared-string table, keeping ONLY the indices we need (bounded
    by the sampled cells — never the whole table). Stops once the highest needed
    index is read."""
    result = {}
    if not needed:
        return result
    max_needed = max(needed)
    try:
        handle = z.open("xl/sharedStrings.xml")
    except KeyError:
        return result
    idx = -1
    parts = []
    with handle as f:
        for event, el in ET.iterparse(f, events=("start", "end")):
            name = localname(el.tag)
            if event == "start":
                if name == "si":
                    idx += 1
                    parts = []
            elif name == "t":
                parts.append(el.text or "")
            elif name == "si":
                if idx in needed:
                    result[idx] = "".join(parts)
                el.clear()
                if idx >= max_needed:
                    break
    return result


def resolve(cell, shared):
    if cell is None:
        return None
    t, raw = cell
    if raw is None:
        return None
    if t == "s":
        try:
            return shared.get(int(raw))
        except ValueError:
            return raw
    if t in ("inlineStr", "str"):
        return raw
    try:
        f = float(raw)
        return int(f) if f.is_integer() else f
    except ValueError:
        return raw


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "usage: xlsx_to_model.py <file.xlsx> [max_data_rows]"}))
        sys.exit(2)
    max_rows = int(sys.argv[2]) if len(sys.argv) > 2 else 15
    try:
        with zipfile.ZipFile(sys.argv[1]) as z:
            raw = []
            for name, path in sheet_paths(z):
                if not path:
                    raw.append((name, []))
                    continue
                try:
                    raw.append((name, parse_sheet_raw(z, path, max_rows)))
                except KeyError:
                    raw.append((name, []))
            shared = load_shared_subset(z, needed_string_indices([r for _, r in raw]))
            sheets = []
            for name, raw_rows in raw:
                rows = [[resolve(c, shared) for c in row] for row in raw_rows]
                rows = [r for r in rows if any(v is not None and v != "" for v in r)]
                if not rows:
                    continue
                headers = [str(h) if h not in (None, "") else "col%d" % (i + 1) for i, h in enumerate(rows[0])]
                sheets.append({"name": name, "headers": headers, "rows": rows[1:max_rows + 1]})
        print(json.dumps({"sheets": sheets}, default=str))
    except Exception as exc:  # noqa: BLE001 — report any failure as JSON
        print(json.dumps({"error": "%s: %s" % (type(exc).__name__, exc)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
