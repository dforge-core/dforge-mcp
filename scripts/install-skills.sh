#!/usr/bin/env bash
# Install the dForge authoring skills into ~/.claude/skills/.
#
# The skills ship inside the npm tarball, but Claude Code only looks in
# ~/.claude/skills/ — not node_modules — so they have to be copied out. There
# are four of them (a router plus three stage skills), and the router's
# directory also carries the shared references/ + examples/ that the MCP server
# serves as dforge:// resources, so hand-copying is error-prone.
#
# Usage:
#   scripts/install-skills.sh              # from a local checkout
#   scripts/install-skills.sh --from-npm   # download the published version
#   DEST=/some/where scripts/install-skills.sh
set -euo pipefail

DEST="${DEST:-$HOME/.claude/skills}"
SKILLS=(dforge-mcp-author dforge-module-design dforge-module-build dforge-module-ship)

if [[ "${1:-}" == "--from-npm" ]]; then
  # Resolve the real latest version rather than using jsdelivr's @latest alias,
  # which caches for 6-12h after a publish and would silently serve stale skills.
  VERSION="$(npm view @dforge-core/dforge-mcp version)"
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  echo "Fetching @dforge-core/dforge-mcp@${VERSION} …"
  (cd "$TMP" && npm pack "@dforge-core/dforge-mcp@${VERSION}" >/dev/null && tar xzf ./*.tgz)
  SRC="$TMP/package/skills"
else
  SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/skills"
fi

if [[ ! -d "$SRC" ]]; then
  echo "error: no skills directory at $SRC" >&2
  exit 1
fi

mkdir -p "$DEST"
for skill in "${SKILLS[@]}"; do
  if [[ ! -d "$SRC/$skill" ]]; then
    echo "  ! skipping $skill (not found in $SRC)" >&2
    continue
  fi
  # Replace wholesale: a stale reference file left behind is worse than a
  # missing one, because the agent will happily author against it.
  rm -rf "${DEST:?}/$skill"
  cp -R "$SRC/$skill" "$DEST/$skill"
  echo "  ✓ $skill"
done

cat <<EOF

Installed ${#SKILLS[@]} skills to $DEST

  dforge-mcp-author     router — start here; also holds the shared
                        references/ and examples/ the MCP server serves
  dforge-module-design  Phase 0  — identity, intake, design, validation
  dforge-module-build   Phases 1-5 — entities, behavior, views, security
  dforge-module-ship    Phase 6  — validate, pack, install-fix loop

Re-run after every dforge-mcp upgrade. The skill version is not checked at
runtime, so stale skills against new tools will misroute calls.
EOF
