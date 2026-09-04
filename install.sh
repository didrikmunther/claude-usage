#!/usr/bin/env bash
# Install the claude-usage dashboard: venv + deps + vendored chart lib + LaunchAgent.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LABEL="com.claude-usage.server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
MB_LABEL="com.claude-usage.menubar"
MB_PLIST="$HOME/Library/LaunchAgents/$MB_LABEL.plist"
DATA="$HOME/.claude-usage"
PORT="${CLAUDE_USAGE_PORT:-44405}"
UPLOT_VER="1.6.31"

echo "→ project: $DIR"

# --- prerequisites ---
if [ "$(uname)" != "Darwin" ]; then
  echo "✗ macOS only (needs the Keychain + Claude Code / Claude / Codex)." >&2
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "✗ python3 not found — install it (e.g. 'brew install python' or python.org)." >&2
  exit 1
fi
if ! python3 -c 'import sys; sys.exit(0 if sys.version_info[:2] >= (3, 9) else 1)'; then
  echo "✗ Python 3.9+ required (found $(python3 -V 2>&1))." >&2
  exit 1
fi
has_claude_cli=false
if security find-generic-password -s "Claude Code-credentials" >/dev/null 2>&1 \
   || [ -f "$HOME/.claude/.credentials.json" ]; then
  has_claude_cli=true
fi
if ! $has_claude_cli \
   && [ ! -d "$HOME/Library/Application Support/Claude" ] && [ ! -d "$HOME/.codex" ]; then
  echo "✗ None of Claude Code (CLI), the Claude desktop app, or OpenAI Codex was found." >&2
  echo "  Install and sign in to at least one, then re-run." >&2
  exit 1
fi
echo "→ prerequisites OK ($(python3 -V 2>&1))"

mkdir -p "$DATA" "$DIR/static/vendor" "$HOME/Library/LaunchAgents"

echo "→ creating venv + installing deps"
python3 -m venv "$DIR/.venv"
"$DIR/.venv/bin/pip" install --quiet --upgrade pip
"$DIR/.venv/bin/pip" install --quiet -r "$DIR/requirements.txt"

echo "→ vendoring uPlot $UPLOT_VER"
curl -fsSL "https://cdn.jsdelivr.net/npm/uplot@$UPLOT_VER/dist/uPlot.iife.min.js" \
  -o "$DIR/static/vendor/uPlot.iife.min.js"
curl -fsSL "https://cdn.jsdelivr.net/npm/uplot@$UPLOT_VER/dist/uPlot.min.css" \
  -o "$DIR/static/vendor/uPlot.min.css"

echo "→ writing LaunchAgent $PLIST"
cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$DIR/.venv/bin/python</string>
    <string>$DIR/server.py</string>
  </array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CLAUDE_USAGE_PORT</key><string>$PORT</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$DATA/server.log</string>
  <key>StandardErrorPath</key><string>$DATA/server.err.log</string>
</dict>
</plist>
PLIST_EOF

echo "→ writing menu-bar LaunchAgent $MB_PLIST"
cat > "$MB_PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$MB_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$DIR/.venv/bin/python</string>
    <string>$DIR/menubar.py</string>
  </array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CLAUDE_USAGE_PORT</key><string>$PORT</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$DATA/menubar.log</string>
  <key>StandardErrorPath</key><string>$DATA/menubar.err.log</string>
</dict>
</plist>
PLIST_EOF

echo "→ removing any old-labelled agents (pre-rename / rumps menu bar)"
for OLD in com.didrik.claude-usage com.didrik.claude-usage-menubar; do
  launchctl bootout "gui/$UID/$OLD" 2>/dev/null || true
  rm -f "$HOME/Library/LaunchAgents/$OLD.plist"
done

echo "→ (re)loading agents"
reload_agent() {
  local L="$1" P="$2"
  launchctl bootout "gui/$UID/$L" 2>/dev/null || true
  # Wait until launchd fully releases the label, else bootstrap races -> EIO (err 5).
  local n=0
  while launchctl print "gui/$UID/$L" >/dev/null 2>&1; do
    sleep 0.2; n=$((n + 1)); [ "$n" -ge 25 ] && break
  done
  # Bootstrap, retrying briefly if launchd is still busy.
  local tries=0
  until launchctl bootstrap "gui/$UID" "$P" 2>/dev/null; do
    tries=$((tries + 1)); [ "$tries" -ge 10 ] && { echo "  ! bootstrap $L failed"; break; }
    sleep 0.3
  done
  launchctl enable "gui/$UID/$L" 2>/dev/null || true
  launchctl kickstart -k "gui/$UID/$L" 2>/dev/null || true
}
reload_agent "$LABEL" "$PLIST"
reload_agent "$MB_LABEL" "$MB_PLIST"

echo
echo "✓ installed. On first launch macOS will ask for a Keychain item"
echo "  ('Claude Code-credentials' for the CLI, or 'Claude Safe Storage' for the"
echo "  desktop app) — click 'Always Allow'."
echo "  Dashboard:  http://127.0.0.1:$PORT"
echo "  Menu bar:   shows e.g. '35%4.1h' (5-hour % + hours to reset)"
echo "  Logs:       $DATA/server.log · $DATA/menubar.log (+ *.err.log)"
echo
echo "  Manage:  launchctl kickstart -k gui/$(id -u)/$LABEL      # restart server"
echo "           launchctl kickstart -k gui/$(id -u)/$MB_LABEL   # restart menu bar"
echo "           launchctl bootout   gui/$(id -u)/$LABEL         # stop server"
echo "           launchctl bootout   gui/$(id -u)/$MB_LABEL      # stop menu bar"
