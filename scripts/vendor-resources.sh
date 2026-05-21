#!/bin/bash
# Refresh the vendored schemas + conventions doc from the dForge-core repo.
# Run before publishing if the source-of-truth files have changed.
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

cp "$SRC/docs/schemas/manifest.schema.json"  "$REPO_ROOT/resources/schemas/manifest.schema.json"
cp "$SRC/docs/schemas/entity.schema.json"    "$REPO_ROOT/resources/schemas/entity.schema.json"
cp "$SRC/docs/schemas/data_views.schema.json" "$REPO_ROOT/resources/schemas/data-view.schema.json"

mkdir -p "$REPO_ROOT/resources/docs"
cp "$SRC/docs/modules/MODULE_CONVENTIONS.md" "$REPO_ROOT/resources/docs/conventions.md"

echo "✓ Vendored:"
find "$REPO_ROOT/resources" -type f | sed "s|$REPO_ROOT/||"
