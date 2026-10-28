# The 1C porting toolkit

A Python library that reads a 1C:Enterprise 8 infobase hosted on MS SQL Server. It needs
no 1C software and no licence. From the infobase it:

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
- `pyodbc` and an ODBC driver for SQL Server (driver 17 or 18), to read the infobase.
- `psycopg2`, to load and check the tenant.
- `jsonschema`, for `validate`.
- Node with `liquidjs` in `PRINT_NODE_DIR`, only for `printgen preview`.

On Windows, set `PYTHONIOENCODING=utf-8`.

Lay out a port directory and point the toolkit at it:

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
DF_TENANT=<tenant code>    DF_PG_HOST= DF_PG_PORT= DF_PG_USER= DF_PG_PASS=  # the tenant's Postgres, for load and checks
```

None of these has a default. A default that named one infobase would make the toolkit
quietly read or write that infobase when a variable was forgotten.

## The pipeline

Each step reads what the previous one wrote to `out/`. Every command has `--help` or a
docstring with its options, and `python 1c.py --list` lists them all.

| # | step | command |
|---|---|---|
| 1 | Read the configuration and DBNames from the SQL tables | `dump1c probe` · `dump1c dbnames` · `dump1c schema` · `dump1c extract` |
| 2 | Parse the metadata, resolve type GUIDs, join the physical schema | `meta allobjects` · `typemap` · `analyze` · `attrs <Object>` · `explore <Object>` |
| 3 | Extract the module texts (posting handlers, print procedures) | `extract_code` · `unpack <Object> --code` |
| 4 | Inventory: what exists, what is used, what is the client's | `inventory` · `docusage` · `custom` · `sizing` · `subsystems` |
| 5 | Read the posting handlers: which registers each document writes and from where | `handlers [--client]` · `callgraph` · `recorders` · `recorded` · `idioms` · `spec` |
| 6 | Decide the module boundaries | `subsystems --contours --acyclic`, copied into `project/contours.py` and corrected |
| 7 | Generate and validate the modules | `autospec [module]` · `genmodule` · `validate` · `deps` · `layers` |
| 8 | Install them | `npx -y @dforge-core/dforge-cli@latest module install ...`, or `rebuild --code <tenant> --install` |
| 9 | Copy the rows and reconcile | `migrate plan\|check\|run\|verify\|fill <module>` · `integrity` · `columnmap <module>` |
| 10 | Post state and registers | `posted [--mark]` · `posting` · `seedstate` · `totals` · `coverage` |
| 11 | Catch up with what 1C changed | `delta --baseline` · `delta [--apply]` |
| 12 | Print forms and reports | `mxl list [--client]` · `mxl dump <Object>` · `printgen <spec>` · `printgen preview <spec> <form> <key>` · `reportgen <spec>` |
| 13 | External reports and processings stored in the infobase | `external` |

`rebuild --code <tenant>` runs steps 8–10 from nothing, which makes a tenant
reproducible.

## Rules the toolkit assumes

- **The infobase is read-only.** Use a SELECT-only login.
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
