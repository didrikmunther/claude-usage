#!/usr/bin/env bash
# Apply a released version, then restart the agents. Run DETACHED (by
# updater.spawn_apply) so it survives the server restart it triggers.
# Usage: update.sh vX.Y.Z
#
# Every exit writes $DATA/update-status ("busy|ok|fail<TAB>message"): the page
# that pressed Update is waiting for a restart, and a refusal here (dirty
# checkout, failed fetch, agent that never came back) would otherwise leave it
# waiting forever with nothing to show.
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA="$HOME/.claude-usage"
SERVER_LABEL="com.claude-usage.server"
MB_LABEL="com.claude-usage.menubar"
PORT="${CLAUDE_USAGE_PORT:-44405}"
TAG="${1:-}"

mkdir -p "$DATA"
STATUS="$DATA/update-status"
status() { printf '%s\t%s\n' "$1" "$2" >"$STATUS"; }
die() { echo "! $1"; status fail "$1"; exit 1; }

exec >>"$DATA/update.log" 2>&1
echo "=== update to '$TAG' at $(date) ==="
status busy "applying $TAG"
cd "$DIR" || die "the app's folder is gone ($DIR)"

[ -n "$TAG" ] || die "no version given"

before="$(shasum requirements.txt 2>/dev/null | awk '{print $1}')"

git fetch --tags --prune origin || die "couldn't reach the code repository — check your network and git access"

# Guards (after fetch, so remote refs are current) — keep a dev checkout safe:
#  1) uncommitted edits, or
#  2) local commits not present on origin (unpushed work).
# A real install (clean, at a released commit that's on origin) passes both.
if [ -n "$(git status --porcelain)" ]; then
  die "this copy has local edits — refusing to overwrite them (run 'git status' in $DIR)"
fi
if [ -n "$(git rev-list HEAD --not --remotes 2>/dev/null)" ]; then
  die "this copy has unpushed commits — refusing to overwrite them (dev checkout)"
fi
git -c advice.detachedHead=false checkout "tags/$TAG" || die "couldn't switch to $TAG"

# Idempotent: hooks installs that predate the status-line hook.
"$DIR/.venv/bin/python" "$DIR/statusline.py" --install || echo "! status line not hooked (continuing)"

after="$(shasum requirements.txt 2>/dev/null | awk '{print $1}')"
if [ "$before" != "$after" ]; then
  echo "requirements.txt changed — updating deps"
  "$DIR/.venv/bin/pip" install --quiet -r "$DIR/requirements.txt" \
    || die "new dependencies failed to install — see $DATA/update.log"
fi

echo "reloading agents"
launchctl kickstart -k "gui/$UID/$SERVER_LABEL" \
  || die "couldn't restart the app — run: launchctl kickstart -k gui/$UID/$SERVER_LABEL"
launchctl kickstart -k "gui/$UID/$MB_LABEL" 2>/dev/null || true

# The new code may not start at all (bad dep, syntax error): wait for it to
# answer before calling this a success, so a crash loop reports as a failure
# instead of as a page that never reloads.
for _ in $(seq 1 30); do
  sleep 1
  if curl -fs -m 2 "http://127.0.0.1:$PORT/api/latest" >/dev/null 2>&1; then
    status ok "$TAG"
    echo "=== done: now on $TAG ==="
    exit 0
  fi
done
die "$TAG is installed but the app didn't come back up — see $DATA/server.err.log"
