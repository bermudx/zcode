#!/bin/sh
# promote-piz-from-ci — install a CI-built dist-runtime into the dir `piz` execs.
#
# Same contract as promote-piz.sh: dist-runtime/ layout, promote-from-clean-main
# policy, matched runtime layout, and PROMOTED_FROM for the next promotion gate.
# Reuse a successful dispatched artifact when its complete source tree equals
# clean main; keep the build SHA and record the main commit/run separately.
#
# Requires: gh authenticated against bermudx/zcode.
# Usage (from the checkout `piz` execs, clean main):
#   sh apps/zcode-cli/scripts/promote-piz-from-ci.sh [run-id] [--repo-root <path>]
# Default: latest successful ci run for HEAD.

set -eu

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
GH_REPO="bermudx/zcode"
WORKFLOW="ci.yml"

fail() { echo "promote-piz-from-ci: $1" >&2; exit 1; }

RUN_ID=""
while [ "$#" -gt 0 ]; do
	case "$1" in
		--repo-root)
			[ "$#" -ge 2 ] || fail "--repo-root requires a path"
			ROOT="$2"
			shift 2
			;;
		*)
			[ -z "$RUN_ID" ] || fail "expected one run id"
			case "$1" in ''|*[!0-9]*) fail "run id must be numeric" ;; esac
			RUN_ID="$1"
			shift
			;;
	esac
done
ROOT="$(cd "$ROOT" && pwd)"
CLI_PKG="$ROOT/apps/zcode-cli/packages/cli"

check_main() {
	BRANCH="$(git -C "$ROOT" symbolic-ref --short -q HEAD 2>/dev/null || true)"
	[ "$BRANCH" = "main" ] ||
		fail "refusing to promote: HEAD is '${BRANCH:-detached}', not main (promote from main only)"
	git -C "$ROOT" diff --quiet && git -C "$ROOT" diff --cached --quiet ||
		fail "refusing to promote: tracked files differ from HEAD (commit or discard first)"
}

check_main
SHA="$(git -C "$ROOT" rev-parse HEAD)"
if [ -z "$RUN_ID" ]; then
	RUN_ID="$(gh run list --repo "$GH_REPO" --workflow "$WORKFLOW" --commit "$SHA" \
		--status success --json databaseId --jq '.[0].databaseId' 2>/dev/null || true)"
	[ -n "$RUN_ID" ] || fail "no successful $WORKFLOW run for $SHA — pass a verified candidate run id or dispatch ci"
fi

# 合并只改变 commit SHA 时不重建；来源必须是完整成功的 dispatch，不能借普通 push 绕过全量门禁。
RUN_INFO="$(gh api "repos/$GH_REPO/actions/runs/$RUN_ID" --jq \
	'[.head_sha, .status, .conclusion, .event, .path] | @tsv')" ||
	fail "cannot read CI run $RUN_ID"
IFS="$(printf '\t')" read -r BUILD_SHA RUN_STATUS RUN_CONCLUSION RUN_EVENT RUN_PATH EXTRA <<EOF
$RUN_INFO
EOF
case "$BUILD_SHA" in ''|*[!0-9a-f]*) fail "invalid CI build SHA" ;; esac
[ "${#BUILD_SHA}" -eq 40 ] || fail "invalid CI build SHA"
[ "$RUN_STATUS" = "completed" ] && [ "$RUN_CONCLUSION" = "success" ] &&
	[ "$RUN_EVENT" = "workflow_dispatch" ] && [ "$RUN_PATH" = ".github/workflows/ci.yml" ] &&
	[ -z "$EXTRA" ] ||
	fail "CI run $RUN_ID is not a successful dispatched $WORKFLOW run"
BUILD_TREE="$(git -C "$ROOT" rev-parse --verify "$BUILD_SHA^{tree}")" ||
	fail "build commit $BUILD_SHA is unavailable locally — fetch it before promotion"
MAIN_TREE="$(git -C "$ROOT" rev-parse "$SHA^{tree}")"
[ "$BUILD_TREE" = "$MAIN_TREE" ] ||
	fail "build tree $BUILD_TREE differs from main tree $MAIN_TREE — refusing to install"
ART="dist-runtime-$BUILD_SHA"
echo "promote-piz-from-ci: verified build=$BUILD_SHA main=$SHA tree=$MAIN_TREE run=$RUN_ID" >&2

DST="$CLI_PKG/dist-runtime"
TMP="$(mktemp -d "$CLI_PKG/.dist-runtime-ci.XXXXXX")"
echo "promote-piz-from-ci: staging at $TMP (retained on failure)" >&2

gh run download "$RUN_ID" --repo "$GH_REPO" --name "$ART" --dir "$TMP" ||
	fail "artifact $ART not found in run $RUN_ID"

[ "$(cat "$TMP/PROMOTED_FROM" 2>/dev/null || true)" = "$BUILD_SHA" ] ||
	fail "artifact PROMOTED_FROM is not $BUILD_SHA — refusing to install"
for f in zcode-attach.cjs zcode.cjs node_modules/@zcode/tui-pi/package.json node_modules/@zcode/tui-pi/dist/index.js node_modules/@zcode/tui/package.json node_modules/@zcode/tui/dist/index.js; do
	[ -f "$TMP/$f" ] || fail "artifact missing $f — incomplete dist-runtime"
done

check_main
[ "$(git -C "$ROOT" rev-parse HEAD)" = "$SHA" ] ||
	fail "main changed during artifact download — refusing to install"
printf '%s\n' "$SHA" >"$TMP/PROMOTED_ON"
printf '%s\n' "$RUN_ID" >"$TMP/PROMOTED_CI_RUN"

# 保留旧安装以便回滚；最终 rename 失败时立即恢复，不删除任一已验证产物。
OLD="$TMP.rollback"
if [ -d "$DST" ]; then
	mv "$DST" "$OLD"
	echo "promote-piz-from-ci: rollback retained at $OLD" >&2
fi
if ! mv "$TMP" "$DST"; then
	[ ! -d "$OLD" ] || mv "$OLD" "$DST"
	fail "install rename failed; previous runtime restored when present"
fi

echo "promoted: ci artifact $ART (run $RUN_ID, main $SHA) -> $DST" >&2
