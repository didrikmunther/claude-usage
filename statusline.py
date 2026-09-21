"""Claude Code status-line hook: saves the usage Claude Code already has.

Claude Code pipes a JSON blob to its status-line command on every update, and
for Pro/Max accounts it carries `rate_limits` (5-hour and 7-day % + resets) from
the latest API response. Saving that costs no request, unlike polling the
rate-limited oauth/usage endpoint. The status line itself is left to whatever
command the user had before (kept in CHAIN), which runs with the same input.

  statusline.py              run as the status line (stdin → stdout)
  statusline.py --install    point ~/.claude/settings.json at this script
  statusline.py --uninstall  put the previous status line back
"""
from __future__ import annotations

import json
import os
import shlex
import shutil
import subprocess
import sys
import time

import claude_cli

CHAIN = os.path.expanduser("~/.claude-usage/statusline-chain")
HERE = os.path.abspath(__file__)


def run() -> None:
    data = sys.stdin.buffer.read()
    try:
        # ponytail: Claude Code inside the desktop app may share this settings
        # file but runs as the desktop account; its numbers aren't the terminal's.
        if "desktop" not in os.environ.get("CLAUDE_CODE_ENTRYPOINT", ""):
            w = claude_cli.windows_from_statusline(json.loads(data))
            if w:
                claude_cli.write_snapshot(w, int(time.time() * 1000))
    except Exception:
        pass   # never break the user's status line over our bookkeeping
    try:
        with open(CHAIN) as fh:
            cmd = fh.read().strip()
    except OSError:
        cmd = ""
    if cmd:
        r = subprocess.run(cmd, shell=True, input=data, stdout=subprocess.PIPE)
        sys.stdout.buffer.write(r.stdout)


def _load_settings() -> dict | None:
    try:
        with open(claude_cli.SETTINGS) as fh:
            return json.load(fh)
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as e:
        print(f"  ! can't read {claude_cli.SETTINGS} ({e}); status line not hooked")
        return None


def _save_settings(settings: dict) -> None:
    if os.path.exists(claude_cli.SETTINGS):
        shutil.copy2(claude_cli.SETTINGS, claude_cli.SETTINGS + ".claude-usage.bak")
    tmp = claude_cli.SETTINGS + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(settings, fh, indent=2)
        fh.write("\n")
    os.replace(tmp, claude_cli.SETTINGS)


def install() -> None:
    if not os.path.isdir(os.path.dirname(claude_cli.SETTINGS)):
        return   # no Claude Code here
    settings = _load_settings()
    if settings is None:
        return
    ours = f"{shlex.quote(sys.executable)} {shlex.quote(HERE)}"
    sl = settings.get("statusLine") or {}
    cur = sl.get("command") or ""
    if cur == ours:
        return
    if "statusline.py" not in cur:          # someone else's: keep it running
        os.makedirs(os.path.dirname(CHAIN), exist_ok=True)
        with open(CHAIN, "w") as fh:
            fh.write(cur)
    settings["statusLine"] = {**sl, "type": "command", "command": ours}
    _save_settings(settings)
    print("  status line hooked (previous one still runs; backup: settings.json.claude-usage.bak)")


def uninstall() -> None:
    settings = _load_settings()
    if not settings or "statusline.py" not in ((settings.get("statusLine") or {}).get("command") or ""):
        return
    try:
        with open(CHAIN) as fh:
            prev = fh.read().strip()
    except OSError:
        prev = ""
    if prev:
        settings["statusLine"]["command"] = prev
    else:
        del settings["statusLine"]
    _save_settings(settings)
    if os.path.exists(CHAIN):
        os.remove(CHAIN)
    print("  status line restored")


if __name__ == "__main__":
    arg = sys.argv[1] if len(sys.argv) > 1 else ""
    {"--install": install, "--uninstall": uninstall}.get(arg, run)()
