#!/usr/bin/env bash
# jev-skill-gate bootstrap installer / updater.
#
# Installs or updates in place, then hands off to the tool's own `update`
# command so state migrations run exactly once, in one place.
#
#   curl -fsSL https://raw.githubusercontent.com/ShivamPansuriya/jev-skill-gate/main/install.sh | bash
#
# Use this when your installed copy is too old to have `jev-skill-gate update`,
# or for a first install. Afterwards, `jev-skill-gate update` is enough.
#
# Nothing under ~/.claude is touched here. Stats, config and cache are the
# tool's own business and are migrated by it, not by this script.
set -euo pipefail

REPO="${JEV_REPO:-ShivamPansuriya/jev-skill-gate}"
BRANCH="${JEV_BRANCH:-main}"
DEST="${JEV_DEST:-$HOME/.local/share/jev-skill-gate}"

say() { printf '  %s\n' "$*"; }

command -v node >/dev/null 2>&1 || { echo "node 18+ is required"; exit 1; }
NODE_MAJOR=$(node -e 'process.stdout.write(process.versions.node.split(".")[0])')
[ "$NODE_MAJOR" -ge 18 ] || { echo "node 18+ is required (found $(node -v))"; exit 1; }
command -v tar >/dev/null 2>&1 || { echo "tar is required"; exit 1; }

echo
say "repo    $REPO@$BRANCH"
say "dest    $DEST"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

say "downloading ..."
if command -v curl >/dev/null 2>&1; then
  curl -fsSL "https://codeload.github.com/$REPO/tar.gz/$BRANCH" -o "$TMP/src.tgz"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$TMP/src.tgz" "https://codeload.github.com/$REPO/tar.gz/$BRANCH"
else
  echo "curl or wget is required"; exit 1
fi

tar xzf "$TMP/src.tgz" -C "$TMP"
SRC=$(find "$TMP" -maxdepth 1 -type d -name 'jev-skill-gate-*' | head -1)
[ -n "$SRC" ] || { echo "unexpected archive layout"; exit 1; }

# Refuse to write anything if the archive is not this project.
for must in package.json bin src; do
  [ -e "$SRC/$must" ] || { echo "archive missing $must; refusing to install"; exit 1; }
done

mkdir -p "$DEST"
for p in src bin eval package.json README.md LICENSE install.sh; do
  [ -e "$SRC/$p" ] && cp -R "$SRC/$p" "$DEST/"
done
chmod +x "$DEST/bin/jev-skill-gate.mjs" 2>/dev/null || true

node --check "$DEST/bin/jev-skill-gate.mjs" || { echo "installed copy does not parse"; exit 1; }

# Hand off: the tool migrates its own on-disk state, so that logic lives in one
# place rather than being duplicated in shell.
say "migrating state ..."
node "$DEST/bin/jev-skill-gate.mjs" migrate 2>&1 | sed "s/^/  /" || true

VERSION=$(node -e "process.stdout.write(require('$DEST/package.json').version)")
echo
say "installed v$VERSION to $DEST"
echo
say "add to your PATH, or link it:"
say "  ln -sf $DEST/bin/jev-skill-gate.mjs ~/.local/bin/jev-skill-gate"
echo
say "then:  jev-skill-gate doctor"
say "later: jev-skill-gate update"
echo
