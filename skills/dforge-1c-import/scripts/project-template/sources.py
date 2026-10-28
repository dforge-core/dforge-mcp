# -*- coding: utf-8 -*-
"""Nothing is authored in this project, so there is nothing to map by hand.

Every module here is generated from the configuration's own subsystems, and `autospec`
records each column's 1C source as it emits the column. These four names exist because
`binding.py` requires them; they stay empty for as long as no module here is written by
hand. If one ever is, this is where its columns say where they came from - see
`tools/project/sources.py` for the shape.

A query in QUERIES runs on the export (`lib/store.py`), so it is DuckDB SQL, not T-SQL:
`"_Fld123"` rather than `[_Fld123]`, `LIMIT` rather than `TOP`, `from_hex('01')` rather
than `0x01`.

Put a `/*window:<alias>*/` marker in the WHERE of the scan it narrows, and do not turn
T-SQL's CROSS APPLY into a LATERAL join: DuckDB applies a filter written above a LATERAL
after the join, so a query narrowed to one recorder still reads every analytic row - on
99.8 M it ran out of memory and spilled 17 GB. A nested SELECT over the table, with the
marker in its own WHERE, ran in under a second. Spill is capped at DF1C_DUCKDB_TEMP (8GB).
"""

ENUMS = {}
TABLEREFS = {}
QUERIES = {}
SOURCES = {}
