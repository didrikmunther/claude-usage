"""macOS menu-bar readout for Claude usage.

Reads the local dashboard server's /api/latest every 30s and shows the 5-hour
utilization + hours-to-reset in the menu bar (e.g. '35%4.1h'). Click for detail.
Talks only to 127.0.0.1 — no Keychain or network access of its own.
"""
from __future__ import annotations

import json
import os
import subprocess
import urllib.request

import rumps

from menubar_fmt import title_for, pct

PORT = os.environ.get("CLAUDE_USAGE_PORT", "8787")
BASE = f"http://127.0.0.1:{PORT}"
REFRESH_SEC = 30


class MenuBar(rumps.App):
    def __init__(self):
        super().__init__("…", quit_button="Quit")
        self.m5 = rumps.MenuItem("5-hour: …")
        self.m7 = rumps.MenuItem("7-day: –")
        self.mo = rumps.MenuItem("Opus (7d): –")
        self.ms = rumps.MenuItem("Sonnet (7d): –")
        self.mc = rumps.MenuItem("Extra credits: –")
        self.menu = [
            self.m5, self.m7, None,
            self.mo, self.ms, self.mc, None,
            rumps.MenuItem("Open dashboard", callback=self._open),
        ]
        rumps.Timer(self.refresh, REFRESH_SEC).start()
        self.refresh(None)

    def _open(self, _):
        subprocess.Popen(["open", BASE])

    def refresh(self, _):
        try:
            with urllib.request.urlopen(f"{BASE}/api/latest", timeout=5) as r:
                j = json.load(r)
        except Exception:
            self.title = "—"
            self.m5.title = "server not reachable"
            return

        status = j.get("status") or {}
        latest = j.get("latest")
        if status.get("state") == "error" or not latest:
            self.title = "—"
            self.m5.title = "5-hour: " + (status.get("message") or "no data")[:60]
            return

        self.title = title_for(latest)
        h5 = title_for(latest)[len(f"{round(latest['fh'])}%"):] if latest.get("fh") is not None else ""
        self.m5.title = f"5-hour: {pct(latest.get('fh'))}" + (f"  ·  resets in {h5}" if h5 else "")
        self.m7.title = f"7-day: {pct(latest.get('sd'))}"
        self.mo.title = f"Opus (7d): {pct(latest.get('so'))}"
        self.ms.title = f"Sonnet (7d): {pct(latest.get('sn'))}"
        c = latest.get("credits")
        self.mc.title = "Extra credits: " + ("–" if c is None else f"${c:.2f}")


if __name__ == "__main__":
    # Run as a menu-bar accessory (no Dock icon) when possible.
    try:
        from AppKit import NSApplication, NSApplicationActivationPolicyAccessory
        NSApplication.sharedApplication().setActivationPolicy_(
            NSApplicationActivationPolicyAccessory)
    except Exception:
        pass
    MenuBar().run()
