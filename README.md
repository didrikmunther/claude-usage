# claude-usage

<img width="1908" height="1436" alt="CleanShot 2026-08-19 at 16 48 55@2x" src="https://github.com/user-attachments/assets/d881e582-4956-43c8-90e1-a55c8aef6260" />

## 🤖 Give this to your agent

Paste this to your AI coding agent (Claude Code, Cursor, etc.) and it'll install everything for you:

```
Install this tool: https://github.com/didrikmunther/claude-usage/blob/main/install.md
```

---

A local **menu-bar app + web dashboard** for your **Claude** (Pro/Max) and
**OpenAI Codex** usage limits — the same 5-hour / weekly windows the desktop
apps show, but live in one place with history graphs, burn-rate forecasts, and
spike markers.

- **Menu bar:** shows `x%Xh` (5-hour % + hours to reset). Click it to drop the
  full dashboard down as a panel (a webview of the local server).
- **Dashboard** (`http://127.0.0.1:8787`): Claude and Codex side by side —
  5h/weekly bars with reset countdowns, a uPlot history graph (24h / week /
  full), a "used this range" tally, per-window forecasts, and hover-to-reveal
  markers on your biggest spikes.

> macOS only. It's a companion to Claude Code / the Claude desktop app and/or the
> Codex app — it reads their local session, it does not log in for you.

## Requirements

- **macOS**
- **Python 3.9+** (`python3 --version`)
- At least one of, installed and signed in (whichever is present shows up):
  - the **Claude desktop app** (preferred — allows fast 60s polling) or
    **Claude Code** (the CLI) as a fallback
  - **OpenAI Codex**

## Install

```bash
git clone <this-repo-url> claude-usage
cd claude-usage
./install.sh
```

`install.sh` creates a virtualenv, installs deps, vendors the chart library, and
loads two per-user LaunchAgents (auto-start at login, keep-alive):

- `com.claude-usage.server` — the poller + dashboard server
- `com.claude-usage.menubar` — the menu-bar app

On first launch macOS prompts for a Keychain item (**`Claude Safe Storage`** for
the desktop app, or **`Claude Code-credentials`** if only the CLI is present) —
click **Always Allow** (after that it's silent). Then click the usage item in
your menu bar, or open **http://127.0.0.1:8787**.

## Security — what it accesses, and what stays local

Everything runs on your machine; **nothing is sent anywhere except the official
Claude/OpenAI APIs** the apps already talk to. The server binds `127.0.0.1` only.

- **Claude (preferred, desktop app):** reads the `Claude Safe Storage` key from
  your Keychain, decrypts the app's `claude.ai` cookies locally, and calls
  `GET https://claude.ai/api/organizations/{org}/usage`. This endpoint tolerates
  fast (60s) polling.
- **Claude (fallback, CLI):** if the desktop app isn't installed, reads Claude
  Code's OAuth token from the `Claude Code-credentials` Keychain item (or
  `~/.claude/.credentials.json`) and calls `GET https://api.anthropic.com/api/oauth/usage`
  — no cookies, no org id. That endpoint is burst-limited, so Claude is polled
  more gently (≈90s, with automatic back-off on 429).
- **Codex:** reads the Bearer token from `~/.codex/auth.json` and calls
  `GET https://chatgpt.com/backend-api/codex/usage` (quota-free), falling back
  to the on-disk session rollout logs if the token is stale.
- History is stored in SQLite at `~/.claude-usage/usage.db`. No telemetry.

The code is short and readable — audit `poller.py` / `codex_poller.py` /
`server.py` before trusting it with your session.

## Manage

```bash
launchctl kickstart -k gui/$(id -u)/com.claude-usage.server    # restart server
launchctl kickstart -k gui/$(id -u)/com.claude-usage.menubar   # restart menu bar
launchctl bootout   gui/$(id -u)/com.claude-usage.server       # stop server
tail -f ~/.claude-usage/server.log ~/.claude-usage/menubar.log # logs
```

Run in the foreground for development:

```bash
.venv/bin/python server.py      # Ctrl-C to stop
.venv/bin/python poller.py      # print one live Claude sample
.venv/bin/python codex_poller.py# print one live Codex sample
.venv/bin/pytest tests/         # pure-logic tests (no Keychain/network)
```

## Uninstall

```bash
./uninstall.sh            # stop + remove agents and the venv (keeps your history)
./uninstall.sh --purge    # also delete ~/.claude-usage (history + logs)
```

## Config

- **Port:** `CLAUDE_USAGE_PORT` (default 8787). Binds `127.0.0.1` only.
- **Claude source:** the desktop app is used if installed (fast polling), else
  the CLI OAuth token (gentler polling). The desktop path auto-detects the org
  (override with `CLAUDE_USAGE_ORG`); the CLI path needs no org id.
- **Poll interval:** change it in the dashboard (10–3600 s); stored in SQLite.
- **Spike window / chart range / poll interval** are all adjustable in the UI
  and persist.

## Notes / disclaimer

- Uses **undocumented** internal endpoints — keep the interval reasonable, and
  expect it to break if the providers change things.
- Not affiliated with or endorsed by Anthropic or OpenAI. For personal use;
  respect each provider's Terms of Service.
- If a session expires, the UI says so — open the relevant app once to refresh.
