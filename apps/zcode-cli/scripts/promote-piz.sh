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
# Usage: run after the verification matrix passes —
#   sh apps/zcode-cli/scripts/promote-piz.sh

set -eu

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
CLI_PKG="$ROOT/apps/zcode-cli/packages/cli"
SRC="$CLI_PKG/dist"
DST="$CLI_PKG/dist-runtime"
TMP="$CLI_PKG/.dist-runtime.tmp.$$"
TUI_PI="$ROOT/apps/zcode-cli/packages/tui-pi"
TUI="$ROOT/apps/zcode-cli/packages/tui"

fail() { echo "promote-piz: $1" >&2; exit 1; }

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

# Atomic-ish swap: same-fs rename; a reader sees the old or new dir, never a
# half-written one.
OLD="$CLI_PKG/.dist-runtime.old.$$"
rm -rf "$OLD"
[ -d "$DST" ] && mv "$DST" "$OLD"
mv "$TMP" "$DST"
rm -rf "$OLD"
trap - EXIT

echo "promoted: $SRC + tui-pi/tui snapshots -> $DST"
