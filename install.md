# Install: claude-usage (agent instructions)

You are an AI coding agent. Install the **claude-usage** menu-bar + dashboard on
the user's Mac by following these steps in order. Run the commands yourself where
possible; where a step needs the human (a GUI/Keychain prompt), stop and ask them.

## 0. Preconditions — check, don't assume
- **macOS only.** If `uname` is not `Darwin`, stop and tell the user it won't work.
- **Python 3.9+** required: `python3 --version`.
- At least one Claude/Codex source must be installed and signed in: the
  **Claude desktop app** (`~/Library/Application Support/Claude`, preferred —
  allows fast polling), **Claude Code** (CLI fallback — `Claude Code-credentials`
  Keychain item or `~/.claude/.credentials.json`), and/or **OpenAI Codex**
  (`~/.codex`). If none exists, stop and ask the user to install/sign in first.

## 1. Clone the repo
```bash
git clone https://github.com/didrikmunther/claude-usage.git
cd claude-usage
```
If the folder already exists, `cd claude-usage && git pull` instead.

## 2. Run the installer
```bash
./install.sh
```
This creates a virtualenv, installs dependencies, vendors the chart library, and
loads two per-user LaunchAgents (`com.claude-usage.server`, `com.claude-usage.menubar`)
that auto-start at login and keep-alive. It prints its own prerequisite errors if
something is missing.

## 3. Approve the Keychain prompt — ASK THE USER
On first launch macOS shows a prompt for a Keychain item (**`Claude Safe Storage`**
for the desktop app, or **`Claude Code-credentials`** if only the CLI is present).
**You cannot click it.** Tell the user: *"macOS will pop up a Keychain prompt —
click **Always Allow**."* (Without this, Claude data can't be read.)

## 4. Verify
```bash
sleep 6
curl -sf http://127.0.0.1:44405/api/latest >/dev/null && echo "✓ server up" || echo "not up yet — check ~/.claude-usage/server.err.log"
```
Then tell the user: the menu bar now shows `x%Xh` (5-hour % + hours to reset);
clicking it drops down the full dashboard, or they can open
**http://127.0.0.1:44405**.

## What it does (so you can reassure the user)
Everything runs locally and binds `127.0.0.1` only. It reads the Claude desktop
app's cookies (or Claude Code's OAuth token as a fallback) and the Codex token
from `~/.codex/auth.json`, calls the official Claude/OpenAI usage endpoints, and
stores history in
`~/.claude-usage/usage.db`. No telemetry, nothing sent anywhere else. The source
(`poller.py`, `codex_poller.py`, `server.py`) is short and auditable.

## Uninstall
```bash
./uninstall.sh            # remove agents + venv (keeps history)
./uninstall.sh --purge    # also delete ~/.claude-usage (history + logs)
```
