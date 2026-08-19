#!/usr/bin/env bash
# Remove the claude-usage LaunchAgents and venv. Pass --purge to also delete the
# usage history + logs in ~/.claude-usage. The project folder is left untouched.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA="$HOME/.claude-usage"
LA="$HOME/Library/LaunchAgents"

echo "→ stopping + removing LaunchAgents"
for L in com.claude-usage.server com.claude-usage.menubar \
         com.didrik.claude-usage com.didrik.claude-usage-menubar; do
  launchctl bootout "gui/$UID/$L" 2>/dev/null || true   # old labels included for cleanup
  rm -f "$LA/$L.plist"
done

echo "→ removing venv"
rm -rf "$DIR/.venv"

if [ "${1:-}" = "--purge" ]; then
  echo "→ purging data ($DATA)"
  rm -rf "$DATA"
else
  echo "  (kept usage history + logs in $DATA — re-run with --purge to remove)"
fi

echo "✓ uninstalled. Delete the project folder if you no longer need it."
