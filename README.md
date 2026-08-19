# claude-usage

A local dashboard for your Claude Pro/Max usage limits — the same data the
desktop app's tray shows (5-hour + weekly windows, per-model, credits), but
live in a browser with a history graph and an adjustable poll interval.

## How it works

`server.py` reads the Claude desktop app's `Claude Safe Storage` Keychain key
**once at startup** (this is the prompt you approve), then on a timer:

1. decrypts the app's claude.ai cookies,
2. calls `GET https://claude.ai/api/organizations/{org}/usage` via `curl_cffi`
   (Chrome TLS impersonation → clears Cloudflare),
3. stores the sample in SQLite (`~/.claude-usage/usage.db`),
4. broadcasts it to every connected browser over WebSocket.

The single-page UI (light, minimal) shows 5h/7d bars with reset countdowns, a
uPlot utilization graph, per-model + credit cards, and a poll-interval slider
that retimes the loop live (and persists the setting).

## Install

```bash
./install.sh
```

This creates a venv, installs deps, vendors the chart lib, and loads a
LaunchAgent (`com.claude-usage.server`) that auto-starts at login and keeps the
server alive. Open **http://127.0.0.1:8787**.

On first launch, macOS prompts for the `Claude Safe Storage` Keychain item —
click **Always Allow** (after that it's silent).

## Run in the foreground (dev)

```bash
.venv/bin/python server.py          # Ctrl-C to stop
.venv/bin/python poller.py          # one-shot: print a single live sample
.venv/bin/pytest tests/             # pure-logic tests (no Keychain/network)
```

## Manage the agent

```bash
launchctl kickstart -k gui/$(id -u)/com.claude-usage.server   # restart
launchctl bootout   gui/$(id -u)/com.claude-usage.server      # stop / uninstall
```

## Config

- Port: `CLAUDE_USAGE_PORT` (default 8787). Binds 127.0.0.1 only.
- Org: auto-detected from the desktop app; override with `CLAUDE_USAGE_ORG`.
- Poll interval: change it in the UI (10–3600 s); stored in SQLite.

## Notes / caveats

- Undocumented internal endpoint — keep the interval reasonable.
- If the Claude app's session cookies expire, the UI shows "session expired —
  open the Claude app"; open it once to refresh.
