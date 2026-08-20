"""Fetch Claude Pro/Max usage via the Claude Code CLI's OAuth token — no desktop app.

The CLI stores an OAuth access token (auto-refreshed whenever you use it) in the
macOS Keychain item 'Claude Code-credentials', or in ~/.claude/.credentials.json
on other platforms. We read it fresh each poll and call the org-less endpoint
GET https://api.anthropic.com/api/oauth/usage. Its response schema matches the
desktop /usage endpoint, so poller.normalize handles it unchanged.

No cookies, no Cloudflare, no org id — the token identifies the account.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys

KEYCHAIN_SERVICE = "Claude Code-credentials"
CRED_FILE = os.path.expanduser("~/.claude/.credentials.json")
USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
OAUTH_BETA = "oauth-2025-04-20"


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


if __name__ == "__main__":
    import poller
    _, live = poller.normalize(fetch_usage(), poller.now_ms())
    print(json.dumps(live, indent=2))
