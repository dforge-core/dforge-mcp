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
#
# 2FA / one-time passwords:
#   You rarely need --otp. If your account requires 2FA on publish the script
#   asks for the 6-digit code right before uploading (codes expire in ~30s, so
#   asking late beats asking early), and re-asks if the registry rejects it.
#   NPM_OTP=123456 works too, for non-interactive runs.
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
OTP="${NPM_OTP:-}"

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

# ── 2FA helpers ──────────────────────────────────────────────────────
# npm prompts for the OTP itself, but only when stdout is a TTY. We pipe
# publish output through tee/sed for the log + indentation, which makes it
# a non-TTY, so npm skips its prompt and fails with EOTP instead. Good:
# a hard failure is recoverable, a silent hang is not. We do the asking.

# Reads the code off the controlling terminal, not stdin — stdin may be
# redirected, and we want this to work under `| tee` too.
read_otp() {
	local code=""
	# /dev/tty exists even with no controlling terminal (cron, CI, a pipe),
	# where opening it fails — probe it rather than trusting the node.
	{ : >/dev/tty; } 2>/dev/null || return 1
	printf "  npm one-time password (6 digits, blank to abort): " >/dev/tty 2>/dev/null
	read -r code </dev/tty 2>/dev/null || return 1
	echo
	[ -n "$code" ] || return 1
	# Strip spaces some authenticator apps show in the code ("123 456").
	code="${code//[[:space:]]/}"
	if ! [[ "$code" =~ ^[0-9]{6,}$ ]]; then
		echo "  ${C_DIM}(that doesn't look like a 6-digit code — sending it anyway)${C_OFF}"
	fi
	OTP="$code"
}

# True when the account has 2FA armed for writes, so we can ask for the
# code up front instead of burning a failed upload. Any hiccup here
# (granular token, offline, npm version without --json) falls through to
# the retry-on-EOTP path below.
otp_required() {
	local profile
	profile=$(npm profile get --json 2>/dev/null) || return 1
	python3 -c '
import json,sys
try: tfa = json.loads(sys.stdin.read()).get("tfa")
except Exception: sys.exit(1)
if isinstance(tfa, dict): mode = "" if tfa.get("pending") else tfa.get("mode", "")
else: mode = tfa or ""
sys.exit(0 if "auth-and-writes" in str(mode) else 1)
' <<<"$profile"
}

# Did the last publish fail *because* of the OTP, as opposed to a version
# clash, a network error, or a 403? Only then is re-prompting the fix.
otp_rejected() {
	grep -qiE "EOTP|one-time pass|otp required|Invalid.*one.?time|code is invalid" "$PUBLISH_LOG"
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
PUBLISH_ARGS=(--access public --tag "$NPM_TAG")
# --provenance only works in CI with id-token: write (npm exchanges the
# GitHub OIDC token for sigstore). Locally it errors out — only pass it
# when the env var is present.
if [ -n "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ]; then
	PUBLISH_ARGS+=(--provenance)
fi

PUBLISH_LOG=$(mktemp -t dforge-mcp-publish)
trap 'rm -f "$PUBLISH_LOG"' EXIT

# Ask up front only if we know 2FA is on — a wasted tarball upload is a
# slow way to discover it, and the code would be stale by the retry.
if [ -z "$OTP" ] && [ -z "${CI:-}" ] && otp_required; then
	echo "  ${C_DIM}2FA is enabled for publishes on this account.${C_OFF}"
	read_otp || fail "no one-time password given"
fi

for attempt in 1 2 3; do
	args=("${PUBLISH_ARGS[@]}")
	if [ -n "$OTP" ]; then args+=(--otp "$OTP"); fi

	set +e
	npm publish "${args[@]}" 2>&1 | tee "$PUBLISH_LOG" | sed 's/^/  /'
	status=${PIPESTATUS[0]}
	set -e
	[ "$status" -eq 0 ] && break

	# Anything that isn't a 2FA complaint won't be fixed by another code.
	otp_rejected || exit "$status"
	[ "$attempt" -lt 3 ] || fail "npm still rejected the one-time password"

	echo
	if [ -n "$OTP" ]; then
		echo "  ${C_RED}✗${C_OFF} npm rejected that code (they expire in ~30s) — try again."
	else
		echo "  ${C_RED}✗${C_OFF} npm wants a one-time password for this publish."
	fi
	OTP=""
	read_otp || fail "no one-time password given"
done

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
