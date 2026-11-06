#!/bin/sh
# promote-piz — install verified build outputs into the dir `piz` execs.
#
# `piz` runs packages/cli/dist-runtime/, NOT dist/. Dev builds and the test
# matrix keep writing dist/; nothing touches dist-runtime/ except this
# script, so a running (or freshly launched) client can only ever see the
# last artifacts promoted after verification.
#
# Layout: dist-runtime/ mirrors dist/ plus real package snapshots at
# node_modules/@zcode/{tui,tui-pi}. The attach/core bundles resolve their
# external `import("@zcode/tui-pi")` / `import("@zcode/tui")` from the
# bundle's own directory upward, so these copies shadow the live workspace
# symlinks in packages/cli/node_modules — the frozen frontends can't drift
# with source edits. npm deps (react, zod, pi-tui) still resolve at the repo
# root node_modules, unchanged.
#
# Usage: run after the promotion gate passes, from a clean main —
#   sh apps/zcode-cli/scripts/promote-piz.sh

set -eu

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
CLI_PKG="$ROOT/apps/zcode-cli/packages/cli"

fail() { echo "promote-piz: $1" >&2; exit 1; }

# Policy (2026-10-24): piz is promoted from main only, never from a patch
# branch. Promoting a branch that main lacks silently regresses the next
# main-based promotion (the resume fix shipped this way once). The gate is
# mechanical so the rule survives memory: HEAD must be main and the tracked
# tree must be clean — dist/ is content-keyed, so a clean main tree is what
# the bundles claim to be.
BRANCH="$(git -C "$ROOT" symbolic-ref --short -q HEAD 2>/dev/null || true)"
[ "$BRANCH" = "main" ] ||
	fail "refusing to promote: HEAD is '${BRANCH:-detached}', not main (promote from main only)"
git -C "$ROOT" diff-index --quiet HEAD -- ||
	fail "refusing to promote: tracked files differ from HEAD (commit or discard first)"
SRC="$CLI_PKG/dist"
DST="$CLI_PKG/dist-runtime"
TMP="$CLI_PKG/.dist-runtime.tmp.$$"
TUI_PI="$ROOT/apps/zcode-cli/packages/tui-pi"
TUI="$ROOT/apps/zcode-cli/packages/tui"

for f in zcode-attach.cjs zcode.cjs; do
	[ -f "$SRC/$f" ] || fail "missing $SRC/$f — build first"
done
[ -f "$TUI_PI/dist/index.js" ] || fail "missing $TUI_PI/dist/index.js — build first"
[ -f "$TUI/dist/index.js" ] || fail "missing $TUI/dist/index.js — build first"

rm -rf "$TMP"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/node_modules/@zcode/tui-pi" "$TMP/node_modules/@zcode/tui"
cp -R "$SRC/." "$TMP/"
for pair in "$TUI_PI tui-pi" "$TUI tui"; do
	pkg_dir="${pair% *}"
	name="${pair#* }"
	dst="$TMP/node_modules/@zcode/$name"
	mkdir -p "$dst"
	cp "$pkg_dir/package.json" "$dst/"
	cp -R "$pkg_dir/dist" "$dst/"
done

# Records the base for the next `fork-tests.mjs --promote-gate`.
git -C "$ROOT" rev-parse HEAD >"$TMP/PROMOTED_FROM"

# Atomic-ish swap: same-fs rename; a reader sees the old or new dir, never a
# half-written one.
OLD="$CLI_PKG/.dist-runtime.old.$$"
rm -rf "$OLD"
[ -d "$DST" ] && mv "$DST" "$OLD"
mv "$TMP" "$DST"
rm -rf "$OLD"
trap - EXIT

echo "promoted: $SRC + tui-pi/tui snapshots -> $DST"
