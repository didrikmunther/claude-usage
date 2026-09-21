"""Fetch Claude Pro/Max usage via the Claude Code CLI's OAuth token — no desktop app.

The CLI stores an OAuth access token (auto-refreshed whenever you use it) in the
macOS Keychain item 'Claude Code-credentials', or in ~/.claude/.credentials.json
on other platforms. We read it fresh each poll and call the org-less endpoint
GET https://api.anthropic.com/api/oauth/usage. Its response schema matches the
desktop /usage endpoint, so poller.normalize handles it unchanged.

No cookies, no Cloudflare, no org id — the token identifies the account.

That endpoint is tightly rate-limited, so it is the fallback. Claude Code hands
its status line the same 5-hour / 7-day numbers with every response;
statusline.py saves them to SNAPSHOT, and the server reads that file instead.
"""
from __future__ import annotations

import datetime
import json
import os
import subprocess
import sys
import time

KEYCHAIN_SERVICE = "Claude Code-credentials"
CRED_FILE = os.path.expanduser("~/.claude/.credentials.json")
USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
OAUTH_BETA = "oauth-2025-04-20"
SNAPSHOT = os.path.expanduser("~/.claude-usage/cli-limits.json")
SETTINGS = os.path.expanduser("~/.claude/settings.json")
CLAUDE_JSON = os.path.expanduser("~/.claude.json")
WINDOWS = ("five_hour", "seven_day")
SAME_WINDOW_S = 60   # resets_at wobbles by a second or so between responses


class RateLimited(RuntimeError):
    """429 from the usage endpoint. `retry_after` is seconds from the header
    (0 when the server didn't give a useful value)."""

    def __init__(self, retry_after: int = 0):
        super().__init__(f"rate-limited (retry-after {retry_after}s)")
        self.retry_after = retry_after


def _keychain_secret() -> str | None:
    """Read the credential blob from the Keychain (-w prompts once, like the
    desktop key does; the user can pick 'Always Allow')."""
    if sys.platform != "darwin":
        return None
    try:
        return subprocess.check_output(
            ["security", "find-generic-password", "-w", "-s", KEYCHAIN_SERVICE],
            stderr=subprocess.PIPE,
        ).decode()
    except subprocess.CalledProcessError:
        return None


def _file_secret() -> str | None:
    try:
        with open(CRED_FILE) as fh:
            return fh.read()
    except OSError:
        return None


def read_token() -> str | None:
    raw = _keychain_secret() or _file_secret()
    if not raw:
        return None
    try:
        d = json.loads(raw)
    except ValueError:
        return None
    oa = d.get("claudeAiOauth") or d
    return oa.get("accessToken")


def available() -> bool:
    """Is a CLI credential present? Cheap check — does NOT read the secret or
    prompt (listing a Keychain item's attributes needs no authorization)."""
    if sys.platform == "darwin":
        return subprocess.run(
            ["security", "find-generic-password", "-s", KEYCHAIN_SERVICE],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        ).returncode == 0
    return os.path.isfile(CRED_FILE)


def fetch_usage() -> dict:
    from curl_cffi import requests as creq  # lazy: keep import-time deps light
    tok = read_token()
    if not tok:
        raise RuntimeError("Claude CLI token not found (is Claude Code logged in?).")
    r = creq.get(
        USAGE_URL,
        headers={
            "Authorization": f"Bearer {tok}",
            "anthropic-beta": OAUTH_BETA,
            "anthropic-version": "2023-06-01",
            "Accept": "application/json",
        },
        impersonate="chrome",
        timeout=15,
    )
    if r.status_code == 401:
        raise RuntimeError(
            "Claude CLI token expired — run any `claude` command to refresh it, "
            "then retry."
        )
    if r.status_code == 429:
        try:
            ra = int(float(r.headers.get("retry-after", 0)))
        except (TypeError, ValueError):
            ra = 0
        raise RateLimited(ra)
    r.raise_for_status()
    return r.json()


def account_org() -> str | None:
    """The org the CLI is signed in to — differs from the desktop app's org
    when the two are separate accounts."""
    try:
        with open(CLAUDE_JSON) as fh:
            return (json.load(fh).get("oauthAccount") or {}).get("organizationUuid")
    except (OSError, ValueError):
        return None


def statusline_hooked() -> bool:
    """Is statusline.py feeding SNAPSHOT? Then the snapshot stays fresh on its
    own and the endpoint only needs checking now and then."""
    try:
        with open(SETTINGS) as fh:
            cmd = (json.load(fh).get("statusLine") or {}).get("command") or ""
    except (OSError, ValueError):
        return False
    return "statusline.py" in cmd


# ---- snapshot: {"ts": ms, "windows": {name: [percent, resets_at epoch s]}} ----

def windows_from_statusline(data: dict) -> dict:
    rl = data.get("rate_limits") or {}
    out = {}
    for w in WINDOWS:
        b = rl.get(w) or {}
        if b.get("used_percentage") is not None:
            out[w] = [float(b["used_percentage"]), b.get("resets_at")]
    return out


def windows_from_usage(raw: dict) -> dict:
    out = {}
    for w in WINDOWS:
        b = raw.get(w)
        if isinstance(b, dict) and b.get("utilization") is not None:
            iso = b.get("resets_at")
            out[w] = [float(b["utilization"]),
                      datetime.datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()
                      if iso else None]
    return out


def merge_windows(old: dict, new: dict) -> tuple[dict, bool]:
    """Keep, per window, whichever reading is newer; also say whether any of
    `new` was taken. Several Claude Code sessions write here, and an idle one
    may still hold an old reading: a later reset means a newer window, and
    within one window usage only goes up."""
    out, took = dict(old), False
    for w, (pct, reset) in new.items():
        prev = old.get(w)
        if (prev is None or reset is None or prev[1] is None
                or reset > prev[1] + SAME_WINDOW_S
                or (abs(reset - prev[1]) <= SAME_WINDOW_S and pct >= prev[0])):
            out[w], took = [pct, reset], True
    return out, took


def read_snapshot(path: str = SNAPSHOT) -> dict | None:
    try:
        with open(path) as fh:
            snap = json.load(fh)
        return snap if snap.get("ts") and snap.get("windows") else None
    except (OSError, ValueError, AttributeError):
        return None


def write_snapshot(windows: dict, ts_ms: int, force: bool = False,
                   path: str = SNAPSHOT) -> None:
    """Merge `windows` in, or replace with force (the endpoint is authoritative).
    Nothing is written — so the timestamp stays put — if no reading was taken."""
    if force:
        merged = windows
    else:
        old = read_snapshot(path) or {"windows": {}}
        merged, took = merge_windows(old["windows"], windows)
        if not took:
            return
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "w") as fh:
        json.dump({"ts": ts_ms, "windows": merged}, fh)
    os.replace(tmp, path)


def snapshot_usage(snap: dict, now_s: float | None = None) -> dict:
    """The snapshot in the /usage shape poller.normalize takes. A window whose
    reset has passed since the reading is empty now."""
    now_s = time.time() if now_s is None else now_s
    raw = {}
    for w, (pct, reset) in snap["windows"].items():
        if reset is not None and reset <= now_s:
            raw[w] = {"utilization": 0.0, "resets_at": None}
        else:
            iso = (datetime.datetime.fromtimestamp(reset, datetime.timezone.utc).isoformat()
                   if reset is not None else None)
            raw[w] = {"utilization": pct, "resets_at": iso}
    return raw


if __name__ == "__main__":
    import poller
    _, live = poller.normalize(fetch_usage(), poller.now_ms())
    print(json.dumps(live, indent=2))
