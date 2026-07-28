#!/usr/bin/env bash
# Thin wrapper around scripts/install-skills.mjs, kept so the documented
# `curl … | bash -s -- --from-npm` one-liner and existing muscle memory still
# work. The real implementation is Node, so that Windows (cmd.exe, PowerShell)
# and WSL behave the same as macOS/Linux — see the header of the .mjs.
#
# On Windows, prefer running the Node script directly:
#   node scripts/install-skills.mjs --from-npm
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
MJS="$HERE/install-skills.mjs"

if [[ -f "$MJS" ]]; then
  exec node "$MJS" "$@"
fi

# Piped in via curl, so the sibling .mjs isn't on disk — fetch it and run it.
# (`bash <(curl …)` isn't available in every shell, hence the temp file.)
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -fsSL \
  "https://raw.githubusercontent.com/dforge-core/dforge-mcp/main/scripts/install-skills.mjs" \
  -o "$TMP/install-skills.mjs"
exec node "$TMP/install-skills.mjs" "$@"
