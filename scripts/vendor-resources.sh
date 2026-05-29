#!/bin/bash
# Refresh the vendored schemas + conventions doc from the dForge-core repo.
# Run before publishing if the source-of-truth files have changed.
#
# These vendored files are what `@dforge-core/dforge-mcp` ships in its npm
# tarball, so jsdelivr can serve them at stable URLs:
#   https://cdn.jsdelivr.net/npm/@dforge-core/dforge-mcp@latest/resources/schemas/<name>.schema.json
# The scaffolder in dforge-cli writes these URLs into .vscode/settings.json
# and .zed/settings.json on every `init module`, so editors get inline
# validation + autocomplete with zero per-user setup.
#
# Usage:
#   scripts/vendor-resources.sh                                # auto-locate ../dForge-core
#   DFORGE_CORE=/path/to/dForge-core scripts/vendor-resources.sh
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

SRC="${DFORGE_CORE:-$REPO_ROOT/../dForge-core}"
if [ ! -d "$SRC/docs/schemas" ]; then
	echo "Can't find dForge-core schemas. Tried: $SRC/docs/schemas" >&2
	echo "Set DFORGE_CORE=/path/to/dForge-core and re-run." >&2
	exit 1
fi

echo "→ Vendoring from $SRC"

mkdir -p "$REPO_ROOT/resources/schemas" "$REPO_ROOT/resources/docs"

# Schemas. Normalising file names: source uses snake_case (data_views,
# seed_data), output uses kebab-case so the URLs read more like other
# JSON Schema repos. Editor settings emitted by dforge-cli map file paths
# to these kebab-case URLs.
copy_schema() {
	local src_name="$1"; local dst_name="$2"
	cp "$SRC/docs/schemas/$src_name" "$REPO_ROOT/resources/schemas/$dst_name"
	echo "  ✓ schemas/$dst_name"
}

copy_schema manifest.schema.json    manifest.schema.json
copy_schema entity.schema.json      entity.schema.json
copy_schema data_views.schema.json  data-views.schema.json
copy_schema folders.schema.json     folders.schema.json
copy_schema menus.schema.json       menus.schema.json
copy_schema roles.schema.json       roles.schema.json
copy_schema jobs.schema.json        jobs.schema.json
copy_schema seed_data.schema.json   seed-data.schema.json
copy_schema traits.schema.json      traits.schema.json
copy_schema webhooks.schema.json    webhooks.schema.json
copy_schema settings.schema.json    settings.schema.json
copy_schema reports.schema.json     reports.schema.json
copy_schema triggers.schema.json    triggers.schema.json
copy_schema print_templates.schema.json print-templates.schema.json

# Conventions doc.
cp "$SRC/docs/modules/MODULE_CONVENTIONS.md" "$REPO_ROOT/resources/docs/conventions.md"
echo "  ✓ docs/conventions.md"

# Skill reference files — detailed per-topic guides for the dforge-mcp-author skill.
# Source: dForge-core/skills/dforge-module-author/references/
# These are NOT MCP resources (no dforge:// URIs) — they live in the skill
# directory and Claude reads them from disk on demand via the reference table
# in SKILL.md. They are distinct from the MCP server's resources/ directory.
REFS_SRC="$SRC/skills/dforge-module-author/references"
REFS_DST="$REPO_ROOT/skills/dforge-mcp-author/references"
if [ -d "$REFS_SRC" ]; then
	mkdir -p "$REFS_DST"
	cp "$REFS_SRC"/*.md "$REFS_DST/"
	ref_count=$(find "$REFS_DST" -name "*.md" | wc -l | tr -d ' ')
	echo "  ✓ skills/dforge-mcp-author/references/ ($ref_count files)"
else
	echo "  ⚠ $REFS_SRC not found in dForge-core — skipping skill references" >&2
fi

echo
total=$(find "$REPO_ROOT/resources" "$REPO_ROOT/skills/dforge-mcp-author/references" -type f 2>/dev/null | wc -l | tr -d ' ')
echo "✓ Vendored $total files total (MCP resources + skill references)."
