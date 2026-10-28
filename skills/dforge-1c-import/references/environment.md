# Environment traps

The things that cost hours the first time and minutes every time after. Written down so
they cost minutes the first time.

## 1C physical storage

The infobase's SQL tables carry generated names; the configuration maps GUIDs to them.

| prefix | what it is |
|---|---|
| `_Reference<N>` | catalog (справочник) |
| `_Document<N>` | document; its tabular sections are `_Document<N>_VT<M>` |
| `_InfoRg<N>` | information register; `_InfoRgSL<N>` is its slice-last cache |
| `_AccumRg<N>` | accumulation register; `_AccumRgT<N>` its totals, `_AccumRgTn<N>` turnovers |
| `_AccRg<N>` | accounting register |
| `_Enum<N>` | enumeration; values carry `_EnumOrder`, never their names |
| `_*ChngR<N>` | change registration for exchange — not the object's own data |

Common columns: `_IDRRef` (16-byte GUID key), `_Period`, `_Active`, `_RecordKind`
(0 receipt / 1 expense), `_RecorderRRef` + `_RecorderTRef` (the writing document, typed),
`_LineNo`, `_Fld<N>` for every declared field in declaration order — dimensions first,
then resources, then attributes.

A field ending `RRef` is a single-type reference; a `_TYPE`/`_RTRef`/`_RRRef` triple is a
composite one. `_IDRRef` bytes are stored with the halves swapped relative to the printed
GUID.

**Resolving a `_Fld` number to a name goes through `DBNames`, not through guessing.** The
configuration keys every attribute by GUID, and `DBNames` holds a `Fld` entry per GUID
giving its `_FldNNN`; the same file maps `VT` (a tabular section's table) and `LineNo`.
Parse the object, collect its attributes with their GUIDs, and look each one up. Automate
it once — everything else depends on it being right.

Field numbers do run in declaration order from the object's base number, dimensions first,
and distinct-value counts do look suggestive. Use that only to **check** a resolution you
already made: two reference dimensions of similar shape swap silently, every query still
runs, and every number downstream is confidently wrong.

## The year offset

1C shifts stored dates by the infobase's `_YearOffset` — commonly 2000, so `4012` in the
column is 2012, and the empty date `0001-01-01` lands on `2001-01-01` and should become
NULL.

It applies to **stored datetime columns only**. A date the configuration formatted into a
string (`НачалоДня(Дата)` assigned to a `Строка(10)` dimension) carries the real year, and
shifting it as well moves the value back two millennia.

## An empty string is not NULL

1C writes `''` where a value is absent. So `count(column)` counts it, and a column the
infobase never filled reads as completely full. Sweep for text columns blank on every row
before trusting any of them; the results split into stock fields the client does not use
(fine) and columns the port read from the wrong source (not fine).

## Shell: Cyrillic and backticks

When commands are wrapped for execution, Cyrillic characters and backticks in the command
text can break the wrapper before the command runs — the symptom is `command not found`
for fragments of your own script, or a syntax error near a Cyrillic word.

The fix that always works: write the script to a file with a file-writing tool, then run
it by an ASCII-only path. Inside the file, Cyrillic is fine; in a pinch, `\uXXXX` escapes
in the source keep the command itself ASCII.

## Windows: `bash` is not the bash you want

On Windows, `bash` on PATH resolves to WSL's, which lives in a different filesystem and
fails with `execvpe(/bin/bash) failed` before reaching your script. Anything that shells
out to a `.sh` needs Git's bash by full path:

```
C:\Program Files\Git\bin\bash.exe
```

This is invisible when working interactively from Git Bash and appears the moment a script
does the same thing.

## Python on Windows

Output encoding defaults to the system codepage, so Cyrillic output raises
`UnicodeEncodeError`. Set `PYTHONIOENCODING=utf-8`. When reading and writing files, name
the encoding explicitly (`io.open(path, encoding="utf-8")`) rather than relying on the
default.

## Reading the infobase

Read-only, always. Porting needs no writes to the source, and a `SELECT`-only credential
makes that a property of the connection rather than a promise.

No 1C licence is engaged by reading the SQL tables directly, which is what makes this
approach available at all — but it also means nothing validates your reading of the
metadata except the data itself.

Guard the size of exploratory queries: a register of 14 million rows will answer a
well-scoped question about one month in seconds and an unscoped one in minutes.
