# The 1C porting toolkit

A Python library that reads a 1C:Enterprise 8 infobase, either a server infobase on MS SQL
Server or a file infobase (`1Cv8.1CD`). It needs no 1C software and no licence. From the
infobase it:

- generates dForge modules;
- copies the rows;
- checks the result.

It was built on a real port: an УТП-based configuration, 16 contours, 30 M+ rows,
reconciled to the row and the kopeck. It is meant to be pointed at the next infobase
unchanged.

```
scripts/
  1c.py                 the one entry point: python 1c.py <command> [args]
  lib/                  the library: 1C storage, metadata, generation, loading, checks
  project-template/     what a new port starts its project package from
```

## Two layers: export, then everything else

Only one step reads 1C itself. `dump1c` exports the infobase to `out/`, and every later
step reads that export, never the infobase.

| layer | modules | reads | writes |
|---|---|---|---|
| export | `dump1c` · `source_mssql` · `source_file` · `onecd` | the infobase: MS SQL (`DF1C_SERVER`/`DF1C_DB`) or a `.1CD` file (`DF1C_FILE`) | `out/config/`, `dbnames.json`, `schema.json`, `data/<table>.parquet`, `export.json` |
| everything else | `store` and every other module | `out/`. Rows are queried with DuckDB through `store.connect()` | modules, the tenant, reports |

The export looks the same whichever kind of infobase it came from:

- names are spelt the MS SQL way (`_Reference12`, `_Fld345RRef`). A file infobase keeps
  them in capitals, and DBNames supplies the spelling back;
- the schema uses MS SQL type names (`binary(16)`, `nvarchar`, `numeric`, `datetime`);
- booleans are `binary(1)`.

Rows are kept as 1C stores them. `export.json` records the infobase's year offset: usually
2000 on MS SQL, always 0 in a file infobase. It also records the horizon (`MIN_ACTIVE_ROWVERSION()`)
taken before each table was read.

- **SQL over the export is DuckDB's.** That includes a project's `sources.QUERIES`. Quote
  names with double quotes (case does not matter), use `LIMIT` instead of `TOP`, write
  a binary constant as `from_hex('01')` instead of `0x01`, and use `CAST` instead of
  `CONVERT`. A port whose queries were written in T-SQL has to rewrite them.
- **`dump1c data --changes` reads only what 1C changed** since the export (or `--since
  <day>`). It works table by table:
  - objects are re-read by `_Version` above the mark, and deletions are found by key;
  - tabular parts are re-read through their changed owners;
  - register movements are re-read through their changed recorders;
  - anything else is re-read whole.

  It rewrites each table's file to what a full export would hold. On an infobase of 2.7 M
  objects, it reads the keys in a few seconds instead of a full export of 1.5 h.

  On an accounting register it also compares each recorder's count of inactive entries.
  Switching entries on or off ("Включить/выключить проводки") rewrites them without
  writing the document, so `_Version` does not show it.
- **Totals and document journals are left out by default** (`_AccumRgT`, `_AccumRgTn`,
  `_AccRgAT`, `_AccRgCT`, `_DocumentJournal`). 1C derives them from other tables, they
  have no `_Version`, and `--changes` would read them in full on every run: 53.7 M of
  313 M rows. Name one, or pass `--derived`, to export it. `seedstate verify` says which
  totals table it needs.
- **`delta` needs an MS SQL export.** In a file infobase `_Version` is a counter per table,
  not a rowversion for the whole database, so a file export has no horizon. Re-export it
  and reload with `migrate run <module> --truncate`.
- **Read a file infobase while 1C is not writing to it.** Copy the `.1CD` first, or close
  the infobase.

## Library and project

- **`lib/` knows 1C and dForge**: how a configuration is stored, how its metadata
  parses, what the physical tables mean, and how rows are copied and checked.
- **The project knows this infobase**:
  - which object goes to which module (`contours.py`);
  - which 1C column feeds an authored column (`sources.py`);
  - the integrator's prefixes;
  - the hand-written modules (`authored/<module>/`).

`lib/binding.py` lists everything a project may provide. Only `contours` and `sources`
are required.

**Never put project facts in `lib/`.** That covers infobase names, tenant names, the
company's abbreviations and prefixes. `python 1c.py --boundary` checks that no library
module imports a project module or names the project's world.

**Never hand-edit generated output.** Put the change in the project, either as a spec
override or as an authored file under `authored/<module>/` that `genmodule` merges.
Then regenerate. If a port keeps needing hand edits, the generator is wrong.

## Setup

- Python 3.7+.
- `pyarrow` and `duckdb`, to write and read the export (on 3.7: `pyarrow==12.0.1`,
  `duckdb==1.1.3`).
- `pyodbc` and an ODBC driver for SQL Server (driver 17 or 18), only to export a server
  infobase. A file infobase needs nothing more.
- `psycopg2`, to load and check the tenant.
- `jsonschema`, for `validate`.
- Node with `liquidjs` in `PRINT_NODE_DIR`, only for `printgen preview`.

On Windows, set `PYTHONIOENCODING=utf-8`.

Lay out a port directory, copy `project-template/.env.example` to `<root>/.env` and fill it in, and export `DF1C_ROOT` / `DF1C_PROJECT` in the shell:

```
myport/
  .env                  credentials (never committed)
  project/              copied from project-template/, then filled in
  out/                  what the extraction writes (DF1C_OUT, default <root>/out)
  modules/              generated modules (DF1C_MODULES, default <root>/modules)
```

```
DF1C_ROOT=/path/to/myport
DF1C_PROJECT=/path/to/myport/project
DF1C_SERVER=<sql server>   DF1C_DB=<infobase db>   DF1C_USER= DF1C_PASS=   # read-only login; Windows auth when USER is empty
DF1C_FILE=<path to 1Cv8.1CD, or its folder>                                 # a file infobase instead of the two above
DF_TENANT=<tenant code>    DF_PG_HOST= DF_PG_PORT= DF_PG_USER= DF_PG_PASS=  # the tenant's Postgres, for load and checks
```

None of these has a default. A default that named one infobase would make the toolkit
quietly read or write that infobase when a variable was forgotten.

## The pipeline

Each step reads what the previous one wrote to `out/`. Every command has `--help` or a
docstring with its options, and `python 1c.py --list` lists them all.

| # | step | command |
|---|---|---|
| 1 | Export the infobase: configuration, DBNames, schema, rows | `dump1c probe` · `dump1c all`, or one at a time: `dump1c dbnames` · `schema` · `extract` · `data [table ...]` |
| 2 | Parse the metadata, resolve type GUIDs, join the physical schema | `meta allobjects` · `typemap` · `analyze` · `attrs <Object>` · `explore <Object>` |
| 3 | Extract the module texts (posting handlers, print procedures) | `extract_code` · `unpack <Object> --code` |
| 4 | Inventory: what exists, what is used, what is the client's | `inventory` · `docusage` · `custom` · `sizing` · `subsystems` |
| 5 | Read the posting handlers: which registers each document writes and from where | `handlers [--client]` · `callgraph` · `recorders` · `recorded` · `idioms` · `spec` |
| 6 | Decide the module boundaries | `subsystems --contours --acyclic`, copied into `project/contours.py` and corrected |
| 7 | Generate and validate the modules | `autospec [module]` · `genmodule` · `validate` · `deps` · `layers` |
| 8 | Install them | `npx -y @dforge-core/dforge-cli@latest module install ...`, or `rebuild --code <tenant> --install` |
| 9 | Copy the rows and reconcile | `migrate plan\|check\|run\|verify\|fill <module>` · `integrity` · `columnmap <module>` |
| 10 | Post state and registers | `posted [--mark]` · `posting` · `seedstate` · `totals` · `coverage` |
| 11 | Catch up with what 1C changed (MS SQL exports only) | once: `dump1c data --objects` (delta needs every object's keys); then `dump1c data --changes`, `delta --baseline` · `delta [--apply]` |
| 12 | Print forms and reports | `mxl list [--client]` · `mxl dump <Object>` · `printgen <spec>` · `printgen preview <spec> <form> <key>` · `reportgen <spec>` |
| 13 | External reports and processings stored in the infobase | `external` |

`rebuild --code <tenant>` runs steps 8–10 from nothing, which makes a tenant
reproducible.

## Rules the toolkit assumes

- **The infobase is read-only.** Use a SELECT-only login. Read a file infobase from a copy.
- **Open ad-hoc database connections in autocommit.** A read transaction left open
  blocks the next install's `ALTER`.
- **Resolve a physical column (`_FldNNN`) only through DBNames** (`attrs`, `columnmap`).
  Never resolve it by cardinality.
- **Stop on a 401 from the tenant.** Ask for a fresh login, then re-run
  `posted --mark` for documents loaded in the meantime.

## Source

This copy is kept in step with the port it was developed on (`tools/lib`, `tools/1c.py`
there). Fixes made in a port go back to the library here. A project's own files never
come here.
