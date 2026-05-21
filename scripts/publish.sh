#!/bin/bash
# Publish @dforge-core/dforge-mcp to npm.
#
# Single-package publish (no platform sidecars), so this script is much
# simpler than dforge-cli's. tsup runs via prepublishOnly so dist/ is
# always fresh when npm bundles the tarball.
#
# Prerequisites:
#   1. npm login (run once locally)
#   2. The first publish creates the package — your npm account must own
#      the @dforge-core scope OR Trusted Publisher is configured.
#
# Usage:
#   scripts/publish.sh <version> [--tag <dist-tag>] [--otp <code>] [--dry-run] [--yes]
#
# Examples:
#   scripts/publish.sh 0.1.0                          # publish to `latest` tag
#   scripts/publish.sh 0.1.0-rc.1 --tag next          # publish a prerelease
#   scripts/publish.sh 0.1.0 --otp 123456             # if your npm account has 2FA on publish
#   scripts/publish.sh 0.1.0 --dry-run                # see what would happen
#   scripts/publish.sh 0.1.0 --yes                    # skip the confirmation prompt
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ $# -lt 1 ] || [ "$1" = "-h" ] || [ "$1" = "--help" ]; then
	grep -E "^#( |$)" "$0" | sed 's/^# \?//'
	exit 0
fi

VERSION="$1"; shift
NPM_TAG="latest"
DRY_RUN=0
ASSUME_YES=0
OTP=""

while [ $# -gt 0 ]; do
	case "$1" in
		--tag)     NPM_TAG="$2"; shift 2 ;;
		--otp)     OTP="$2"; shift 2 ;;
		--dry-run) DRY_RUN=1; shift ;;
		--yes)     ASSUME_YES=1; shift ;;
		*) echo "Unknown arg: $1" >&2; exit 1 ;;
	esac
done

if [ -t 1 ]; then
	C_GREEN=$'\033[32m'; C_RED=$'\033[31m'; C_DIM=$'\033[2m'; C_BOLD=$'\033[1m'; C_OFF=$'\033[0m'
else
	C_GREEN=""; C_RED=""; C_DIM=""; C_BOLD=""; C_OFF=""
fi
ok()   { echo "  ${C_GREEN}✓${C_OFF} $1"; }
fail() { echo "  ${C_RED}✗${C_OFF} $1" >&2; exit 1; }
section() { echo; echo "${C_BOLD}── $1 ──${C_OFF}"; }

# JSON-aware version writer. ensure_ascii=False keeps non-ASCII chars
# (em-dashes, accented letters, emoji) intact instead of \uXXXX escapes —
# Python's default would re-mangle a clean package.json on every publish.
write_version() {
	local pj="$1"; local v="$2"
	python3 -c '
import json,sys
p=sys.argv[1]; v=sys.argv[2]
d=json.load(open(p))
d["version"]=v
with open(p,"w",encoding="utf-8") as f: json.dump(d, f, indent="\t", ensure_ascii=False); f.write("\n")
' "$pj" "$v"
}

cd "$REPO_ROOT"

# ── 1. Bump version in package.json ──────────────────────────────────
section "Bumping package.json to $VERSION"
write_version "package.json" "$VERSION"
ok "@dforge-core/dforge-mcp → $VERSION"

# ── 2. npm auth check (skipped under OIDC in CI) ─────────────────────
if [ "$DRY_RUN" -eq 0 ] && [ -z "${CI:-}" ]; then
	section "npm auth"
	if ! WHO=$(npm whoami 2>/dev/null); then
		fail "not logged in — run: ${C_BOLD}npm login${C_OFF}"
	fi
	ok "logged in as $WHO"
fi

# ── 3. Dry-run publish ───────────────────────────────────────────────
section "Dry-run"
npm publish --dry-run --access public --tag "$NPM_TAG" 2>&1 \
	| grep -E "^npm notice 📦|package size:|unpacked size:|total files:" \
	| sed 's/^/  /'

if [ "$DRY_RUN" -eq 1 ]; then
	section "Dry-run complete"
	echo "  Re-run without --dry-run to publish."
	exit 0
fi

# ── 4. Confirm ───────────────────────────────────────────────────────
section "Ready to publish"
echo "  Registry: https://registry.npmjs.org/"
echo "  Tag:      $NPM_TAG"
echo "  Access:   public"
echo "  Version:  $VERSION"
echo
echo "  ${C_DIM}Note: once published, $VERSION is permanent.${C_OFF}"
echo "  ${C_DIM}npm allows unpublish within 72h of first publish, then the version is burned.${C_OFF}"
echo
if [ "$ASSUME_YES" -eq 0 ]; then
	printf "  Publish for real? [y/N] "
	read -r ans
	case "$ans" in
		y|Y|yes|YES) ;;
		*) echo "  Aborted."; exit 0 ;;
	esac
fi

# ── 5. Publish ───────────────────────────────────────────────────────
section "Publishing"
set --
if [ -n "$OTP" ]; then set -- "$@" --otp "$OTP"; fi
# --provenance only works in CI with id-token: write (npm exchanges the
# GitHub OIDC token for sigstore). Locally it errors out — only pass it
# when the env var is present.
if [ -n "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ]; then
	set -- "$@" --provenance
fi
npm publish --access public --tag "$NPM_TAG" "$@" 2>&1 | sed 's/^/  /'

# ── 6. Verify ────────────────────────────────────────────────────────
section "Verifying against registry"
sleep 3
if found=$(npm view "@dforge-core/dforge-mcp@$VERSION" version 2>/dev/null) && [ -n "$found" ]; then
	ok "@dforge-core/dforge-mcp@$found"
else
	echo "  ${C_DIM}…${C_OFF} not visible yet (may take a moment)"
fi

section "Done"
echo "  Try it: ${C_BOLD}npx -y @dforge-core/dforge-mcp${C_OFF}"
echo "  Or wire it into Claude Code / Cursor / Zed — see README.md"
