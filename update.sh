#!/usr/bin/env bash
# Apply a released version, then restart the agents. Run DETACHED (by
# updater.spawn_apply) so it survives the server restart it triggers.
# Usage: update.sh vX.Y.Z
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA="$HOME/.claude-usage"
SERVER_LABEL="com.claude-usage.server"
MB_LABEL="com.claude-usage.menubar"
TAG="${1:-}"

mkdir -p "$DATA"
exec >>"$DATA/update.log" 2>&1
echo "=== update to '$TAG' at $(date) ==="
cd "$DIR" || { echo "! no project dir"; exit 1; }

[ -n "$TAG" ] || { echo "! no tag given"; exit 1; }

before="$(shasum requirements.txt 2>/dev/null | awk '{print $1}')"

git fetch --tags --prune origin || { echo "! fetch failed"; exit 1; }

# Guards (after fetch, so remote refs are current) — keep a dev checkout safe:
#  1) uncommitted edits, or
#  2) local commits not present on origin (unpushed work).
# A real install (clean, at a released commit that's on origin) passes both.
if [ -n "$(git status --porcelain)" ]; then
  echo "! working tree is dirty — refusing to update"; exit 1
fi
if [ -n "$(git rev-list HEAD --not --remotes 2>/dev/null)" ]; then
  echo "! local commits not on origin — refusing to update (dev checkout)"; exit 1
fi
git -c advice.detachedHead=false checkout "tags/$TAG" || { echo "! checkout $TAG failed"; exit 1; }

after="$(shasum requirements.txt 2>/dev/null | awk '{print $1}')"
if [ "$before" != "$after" ]; then
  echo "requirements.txt changed — updating deps"
  "$DIR/.venv/bin/pip" install --quiet -r "$DIR/requirements.txt" || echo "! pip failed (continuing)"
fi

echo "reloading agents"
launchctl kickstart -k "gui/$UID/$SERVER_LABEL" 2>/dev/null || true
launchctl kickstart -k "gui/$UID/$MB_LABEL" 2>/dev/null || true
echo "=== done: now on $TAG ==="
