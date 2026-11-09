#!/bin/sh
# promote-piz-from-ci — install a CI-built dist-runtime into the dir `piz` execs.
#
# Same contract as promote-piz.sh: dist-runtime/ layout, promote-from-clean-main
# policy, atomic swap, PROMOTED_FROM for `fork-tests.mjs --promote-gate`. The
# payload is the `ci` workflow's dist-runtime-<sha> artifact instead of a local
# dist/ — the artifact only exists when the whole workflow (checks + the
# sha's test tier, incl. --full on main) went green, so the run is the gate
# evidence. Local builds are still needed for patch-branch dev and for
# `promote-piz.sh`.
#
# Requires: gh authenticated against bermudx/zcode.
# Usage (from the checkout `piz` execs, clean main):
#   sh apps/zcode-cli/scripts/promote-piz-from-ci.sh [run-id]
# Default: latest successful ci run for HEAD.

set -eu

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
CLI_PKG="$ROOT/apps/zcode-cli/packages/cli"
GH_REPO="bermudx/zcode"
WORKFLOW="ci.yml"

fail() { echo "promote-piz-from-ci: $1" >&2; exit 1; }

BRANCH="$(git -C "$ROOT" symbolic-ref --short -q HEAD 2>/dev/null || true)"
[ "$BRANCH" = "main" ] ||
	fail "refusing to promote: HEAD is '${BRANCH:-detached}', not main (promote from main only)"
git -C "$ROOT" diff-index --quiet HEAD -- ||
	fail "refusing to promote: tracked files differ from HEAD (commit or discard first)"

SHA="$(git -C "$ROOT" rev-parse HEAD)"
ART="dist-runtime-$SHA"

if [ "${1:-}" ]; then
	RUN_ID="$1"
else
	RUN_ID="$(gh run list --repo "$GH_REPO" --workflow "$WORKFLOW" --commit "$SHA" \
		--status success --json databaseId --jq '.[0].databaseId' 2>/dev/null || true)"
	[ -n "$RUN_ID" ] || fail "no successful $WORKFLOW run for $SHA — push it and wait for ci"
fi

DST="$CLI_PKG/dist-runtime"
TMP="$CLI_PKG/.dist-runtime-ci.tmp.$$"
rm -rf "$TMP"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP"

gh run download "$RUN_ID" --repo "$GH_REPO" --name "$ART" --dir "$TMP" ||
	fail "artifact $ART not found in run $RUN_ID"

[ "$(cat "$TMP/PROMOTED_FROM" 2>/dev/null || true)" = "$SHA" ] ||
	fail "artifact PROMOTED_FROM is not $SHA — refusing to install"
for f in zcode-attach.cjs zcode.cjs node_modules/@zcode/tui-pi/package.json node_modules/@zcode/tui/package.json; do
	[ -f "$TMP/$f" ] || fail "artifact missing $f — incomplete dist-runtime"
done

# Atomic-ish swap: same-fs rename; a reader sees the old or new dir, never a
# half-written one.
OLD="$CLI_PKG/.dist-runtime.old.$$"
rm -rf "$OLD"
[ -d "$DST" ] && mv "$DST" "$OLD"
mv "$TMP" "$DST"
rm -rf "$OLD"
trap - EXIT

echo "promoted: ci artifact $ART (run $RUN_ID) -> $DST"
