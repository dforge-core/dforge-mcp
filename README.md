# @dforge-core/dforge-mcp

MCP server for dForge module authoring. Exposes scaffold / pack / install
tools and schema resources so AI agents (Claude Code, Cursor, Zed, etc.)
can create and ship dForge modules through structured tool calls instead
of free-form JSON generation.

## Install

```bash
# As an MCP server invoked by an AI editor — usually no install needed,
# the editor runs it via npx on demand. See "Wiring it up" below.

# Local install (for development / debugging):
npm install -g @dforge-core/dforge-mcp
dforge-mcp                # speaks JSON-RPC over stdio; ctrl+C to quit
```

## Wiring it up

### Claude Code

Add to `~/.claude/config.json` (or the project-local `.claude/mcp.json`):

```json
{
  "mcpServers": {
    "dforge": {
      "command": "npx",
      "args": ["-y", "@dforge-core/dforge-mcp"],
      "env": {
        "DFORGE_CLI_BINARY": "/optional/path/to/dForge.Cli"
      }
    }
  }
}
```

`DFORGE_CLI_BINARY` is only needed if you want `dforge_module_pack` /
`dforge_module_install` to use a non-published native binary (e.g. a
local C# build). Otherwise the server uses whatever `dforge-cli` is on
PATH (install via `npm install -g @dforge-core/dforge-cli`).

### Cursor / Zed

Same shape — both editors take a `command + args` MCP config. Refer to
their docs for the exact file path.

## What it exposes

### Tools

| Tool | Behavior |
|---|---|
| `dforge_module_create` | Returns a file map for a new module. Client writes the files. |
| `dforge_entity_add` | Reads an existing module, returns the updated file map (manifest + new entity + regenerated UI/security). |
| `dforge_module_pack` | Shells to `dforge-cli module pack`. Returns tarball path + size. |
| `dforge_module_install` | Shells to `dforge-cli module install`. Returns CLI output. |
| `dforge_dbml_import` | Stub. Returns "not yet implemented" until the underlying CLI command lands. |

The `create` and `entity_add` tools deliberately **return** instead of writing — the LLM previews the file map with the user before commit.

### Resources

| URI | Content |
|---|---|
| `dforge://schema/manifest` | JSON Schema for manifest.json |
| `dforge://schema/entity` | JSON Schema for entity files |
| `dforge://schema/data-view` | JSON Schema for ui/data_views.json |
| `dforge://docs/conventions` | MODULE_CONVENTIONS.md from dForge-core |

The schemas + conventions doc are vendored at build time from
`dForge-core/docs/`. Refresh with `scripts/vendor-resources.sh`.

## Claude Skill

`skills/dforge-mcp-author/SKILL.md` is a Skill file that teaches Claude
how to drive the tools — gather requirements → preview → write → iterate.
Copy it into your `~/.claude/skills/` (or per-project `.claude/skills/`)
to enable.

## For maintainers

### Local development

```bash
pnpm install
pnpm build          # tsup → dist/server.js
pnpm typecheck      # tsc --noEmit
node dist/server.js # smoke-test via stdio JSON-RPC
```

The `@dforge-core/dforge-cli` dep is currently pinned to a `file:`
sibling path so this repo can be developed alongside `dforge-cli`. Before
publishing, change to a real npm version (`^0.1.0-rc.5` or higher — the
first version that exposes the `templates` subpath export).

### Refresh vendored resources

When `dForge-core/docs/schemas/` or `MODULE_CONVENTIONS.md` change:

```bash
scripts/vendor-resources.sh                              # auto-locate ../dForge-core
DFORGE_CORE=/abs/path/to/dForge-core scripts/vendor-resources.sh
```

### Publishing to npm

(Same approach as dforge-cli — `prepublishOnly` runs tsup so the
published tarball gets a fresh `dist/server.js`. No platform binaries to
manage, so a single `npm publish` covers it.)

```bash
npm publish --access public --tag next
```

## License

MIT.
