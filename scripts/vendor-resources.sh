#!/bin/bash
# Refresh the vendored schemas + conventions doc + skill references.
# Run before publishing if the source-of-truth files have changed.
#
# Sources:
#   • JSON schemas      → the published @dforge-core/metadata package
#                         (node_modules) — the single source of truth that
#                         already mirrors dForge-core/docs/schemas. Bump the
#                         metadata dependency to pick up schema changes; no
#                         dForge-core checkout needed for schemas.
#   • conventions doc   → the dForge-core repo (docs/modules)
#   • skill references  → the dForge-core repo (skills/dforge-module-author)
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

# Schemas — delegate to the portable Node script. It's the same logic that
# `pnpm sync-schemas` and the publish step (`prepublishOnly`) run, and it works
# on Windows too (this .sh is the Unix convenience wrapper, not the source of
# truth). It copies the JSON schemas from the installed @dforge-core/metadata
# package into resources/schemas/ (snake_case -> kebab-case).
node "$SCRIPT_DIR/vendor-schemas.cjs"

# ── Conventions doc + skill references — OPT-IN (VENDOR_REFS=1) ────────────
#
# DANGER: the per-topic skill references (skills/dforge-mcp-author/references/)
# and the conventions doc are now authored IN THIS REPO and have diverged ahead
# of dForge-core/skills/dforge-module-author/ (e.g. field-types.md is materially
# richer here). Copying core → mcp would CLOBBER those edits. Until the canonical
# home for the references is settled, this pull is off by default. Run with
# VENDOR_REFS=1 only after you've confirmed core is the source of truth.
if [ "${VENDOR_REFS:-0}" = "1" ]; then
	SRC="${DFORGE_CORE:-$REPO_ROOT/../dForge-core}"
	if [ ! -d "$SRC/skills/dforge-module-author" ]; then
		echo "VENDOR_REFS=1 but can't find dForge-core. Tried: $SRC" >&2
		echo "Set DFORGE_CORE=/path/to/dForge-core and re-run." >&2
		exit 1
	fi
	echo "→ Vendoring docs + references from $SRC"
	mkdir -p "$REPO_ROOT/resources/docs"
	cp "$SRC/docs/modules/MODULE_CONVENTIONS.md" "$REPO_ROOT/resources/docs/conventions.md"
	echo "  ✓ docs/conventions.md"

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
else
	echo "  • skipped conventions doc + skill references (set VENDOR_REFS=1 to pull from dForge-core)"
fi

echo
total=$(find "$REPO_ROOT/resources/schemas" -type f 2>/dev/null | wc -l | tr -d ' ')
echo "✓ Vendored $total schema file(s) from @dforge-core/metadata."
