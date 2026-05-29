# Simple Todo — Example Module

A minimal but complete dForge module. Use it as a reference for:

- Module package layout
- Entity definition with traits, columns, and a reference
- Data view with a grid
- Menu with a single leaf item
- Security role with full CRUD
- Seed data with numbered files
- A simple DSL action (mark as done)

**Not meant for production** — it's a teaching example.

## What it contains

| File | Purpose |
|---|---|
| `manifest.json` | Module metadata and file listing |
| `entities/todo_list.json` | Lists that group todos |
| `entities/todo_item.json` | Individual todo items, with reference to list |
| `ui/data_views.json` | Two grid views — one for lists, one for items |
| `ui/menus.json` | Nested menu with "Lists" and "Items" |
| `ui/actions.json` | Registers the mark-done action |
| `logic/actions/mark_done.dsl` | The action DSL |
| `security/roles.json` | `todo_user` role with full CRUD |
| `seed-data/01-lists.json` | Two seed lists |

## Key patterns demonstrated

1. **FK+Reference pattern** — `todo_item` has `list_id` (hidden FK) + `list` (visible Reference)
2. **Traits** — both entities use `["identity", "audit"]`
3. **toString** — `todo_list` uses `{name}`, `todo_item` uses `{title}`
4. **`dataSources` array** in data views (never root-level `entityCode`)
5. **Nested dict menus** with `dataViewCode` on leaves
6. **`rights` (not `entityRights`)** in roles
7. **Numbered seed files** for FK ordering
8. **DSL action** with `canExecute:` gating on `[done] == false`
