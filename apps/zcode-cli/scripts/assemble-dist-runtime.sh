#!/bin/sh
# assemble-dist-runtime — fill a directory with the frozen runtime layout
# `piz` execs. Single implementation shared by promote-piz.sh (local build)
# and the ci workflow (artifact payload).
#
# Layout: mirrors packages/cli/dist/ plus real package snapshots at
# node_modules/@zcode/{tui,tui-pi}. The attach/core bundles resolve their
# external `import("@zcode/tui-pi")` / `import("@zcode/tui")` from the
# bundle's own directory upward, so these copies shadow the live workspace
# symlinks in packages/cli/node_modules — the frozen frontends can't drift
# with source edits. npm deps (react, zod, pi-tui) still resolve at the repo
# root node_modules, unchanged.
#
# Usage: assemble-dist-runtime.sh <repo-root> <dst-dir>
# <dst-dir> must not exist yet or be empty; it is created. PROMOTED_FROM is
# written inside with the HEAD of <repo-root> — for CI that is the pushed sha,
# for promote-piz.sh the clean main sha; same meaning in both paths.

set -eu

ROOT="$1"
DST="$2"
CLI_PKG="$ROOT/apps/zcode-cli/packages/cli"
TUI_PI="$ROOT/apps/zcode-cli/packages/tui-pi"
TUI="$ROOT/apps/zcode-cli/packages/tui"

fail() { echo "assemble-dist-runtime: $1" >&2; exit 1; }

for f in zcode-attach.cjs zcode.cjs; do
	[ -f "$CLI_PKG/dist/$f" ] || fail "missing $CLI_PKG/dist/$f — build first"
done
[ -f "$TUI_PI/dist/index.js" ] || fail "missing $TUI_PI/dist/index.js — build first"
[ -f "$TUI/dist/index.js" ] || fail "missing $TUI/dist/index.js — build first"

mkdir -p "$DST/node_modules/@zcode/tui-pi" "$DST/node_modules/@zcode/tui"
cp -R "$CLI_PKG/dist/." "$DST/"
for pair in "$TUI_PI tui-pi" "$TUI tui"; do
	pkg_dir="${pair% *}"
	name="${pair#* }"
	dst="$DST/node_modules/@zcode/$name"
	mkdir -p "$dst"
	cp "$pkg_dir/package.json" "$dst/"
	cp -R "$pkg_dir/dist" "$dst/"
done

# Records the base for the next `fork-tests.mjs --promote-gate`.
git -C "$ROOT" rev-parse HEAD >"$DST/PROMOTED_FROM"
