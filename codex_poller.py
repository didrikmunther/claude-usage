"""Fetch OpenAI Codex usage — the analog of poller.py for Codex.

Codex (ChatGPT-login) exposes a dedicated, quota-free usage endpoint:
    GET https://chatgpt.com/backend-api/codex/usage
authenticated with the Bearer access token in ~/.codex/auth.json (plaintext,
auto-refreshed by the Codex app — no Keychain/cookie decryption needed).
chatgpt.com sits behind Cloudflare, so we reuse curl_cffi Chrome impersonation.

If the live call fails (e.g. token expired while the app is closed), we fall
back to the last rate-limit snapshot Codex wrote to its session rollout logs
at ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl — no network, no auth.

Heavy deps (curl_cffi) are imported lazily so the pure helpers stay testable.
"""
from __future__ import annotations

import datetime as _dt
import glob
import json
import os
import time

CODEX_HOME = os.path.expanduser("~/.codex")
AUTH_PATH = os.path.join(CODEX_HOME, "auth.json")
SESSIONS = os.path.join(CODEX_HOME, "sessions")
USAGE_URL = "https://chatgpt.com/backend-api/codex/usage"
UA = "codex_cli_rs"


def now_ms() -> int:
    return int(time.time() * 1000)


def available() -> bool:
    """Show the Codex column only if Codex is actually installed here."""
    return os.path.exists(AUTH_PATH) or os.path.isdir(SESSIONS)


def read_token() -> tuple[str, str]:
    """Read the current Bearer token + account id fresh (the app rotates it)."""
    a = json.load(open(AUTH_PATH))
    tok = (a.get("tokens") or {}).get("access_token")
    acct = (a.get("tokens") or {}).get("account_id")
    if not tok:
        raise RuntimeError("no access_token in ~/.codex/auth.json (is Codex logged in?)")
    return tok, acct


def _iso(unix_s) -> str | None:
    if not unix_s:
        return None
    return _dt.datetime.fromtimestamp(int(unix_s), _dt.timezone.utc).isoformat()


def _label_for(secs) -> str:
    if not secs:
        return "limit"
    if abs(secs - 18000) < 600:        # 300 min
        return "5-hour"
    if abs(secs - 604800) < 3600:      # 7 days
        return "7-day"
    h = secs / 3600
    return f"{round(h)}-hour" if h < 48 else f"{round(h / 24)}-day"


def fetch_active() -> dict:
    """Live GET of the codex/usage endpoint (quota-free). Raises on auth failure."""
    from curl_cffi import requests as creq  # lazy
    tok, acct = read_token()
    r = creq.get(
        USAGE_URL,
        headers={
            "Authorization": f"Bearer {tok}",
            "chatgpt-account-id": acct or "",
            "OpenAI-Beta": "responses=experimental",
            "originator": "codex_cli_rs",
            "User-Agent": UA,
            "Accept": "application/json",
        },
        impersonate="chrome",
        timeout=20,
    )
    if r.status_code in (401, 403):
        raise RuntimeError(
            f"codex/usage returned {r.status_code} — token likely expired. "
            f"Open the Codex app to refresh."
        )
    r.raise_for_status()
    return r.json()


def read_rollout() -> dict | None:
    """Fallback: convert Codex's last on-disk rate_limits snapshot into the same
    schema as the /usage response. No network. Only as fresh as the last request
    Codex made, so it can lag when the app is idle."""
    files = glob.glob(os.path.join(SESSIONS, "**", "rollout-*.jsonl"), recursive=True)
    if not files:
        return None
    newest = max(files, key=os.path.getmtime)
    snap = None
    try:
        for line in open(newest):
            if '"rate_limits"' in line:
                try:
                    obj = json.loads(line)
                except ValueError:
                    continue
                rl = obj.get("rate_limits") if isinstance(obj, dict) else None
                if rl:
                    snap = rl
    except OSError:
        return None
    if not snap:
        return None

    def win(w):
        if not w:
            return None
        return {
            "used_percent": w.get("used_percent"),
            "limit_window_seconds": (w.get("window_minutes") or 0) * 60 or None,
            "reset_at": w.get("resets_at"),
        }

    return {
        "plan_type": snap.get("plan_type"),
        "rate_limit": {
            "primary_window": win(snap.get("primary")),
            "secondary_window": win(snap.get("secondary")),
        },
        "additional_rate_limits": [],
        "credits": snap.get("credits") or {},
        "_source": "rollout",
    }


def normalize(raw: dict, ts: int) -> tuple[dict, dict]:
    """Split the codex/usage response into a compact storage row (scalars) and a
    richer 'live' payload for the UI. Mirrors poller.normalize. Pure."""
    rl = raw.get("rate_limit") or {}
    wins = []
    for key in ("primary_window", "secondary_window"):
        w = rl.get(key)
        if not w:
            continue
        secs = w.get("limit_window_seconds")
        wins.append({
            "key": key.replace("_window", ""),
            "label": _label_for(secs),
            "used_percent": w.get("used_percent"),
            "window_seconds": secs,
            "reset_at": _iso(w.get("reset_at")),
        })

    additional = []
    for a in raw.get("additional_rate_limits") or []:
        w = ((a.get("rate_limit") or {}).get("primary_window")) or {}
        additional.append({
            "label": a.get("limit_name") or a.get("metered_feature") or "extra",
            "used_percent": w.get("used_percent"),
            "window_seconds": w.get("limit_window_seconds"),
            "reset_at": _iso(w.get("reset_at")),
        })

    cr = raw.get("credits") or {}
    try:
        bal = float(cr.get("balance"))
    except (TypeError, ValueError):
        bal = None

    # Map into fixed buckets by window length (like Claude's fh/sd) so the 5-hour
    # and 7-day series stay in stable slots regardless of Codex's primary/secondary.
    by_label = {w["label"]: w["used_percent"] for w in wins}
    cp = by_label.get("5-hour")
    cs = by_label.get("7-day")
    row = {"cp": cp, "cs": cs, "cc": bal}
    live = {
        **row,
        "ts": ts,
        "available": True,
        "source": raw.get("_source", "active"),
        "plan_type": raw.get("plan_type"),
        "windows": wins,
        "additional": additional,
        "credits": {
            "balance": bal,
            "has_credits": bool(cr.get("has_credits")),
            "unlimited": bool(cr.get("unlimited")),
        },
    }
    return row, live


def fetch(ts: int | None = None) -> tuple[dict, dict]:
    """High-level: try the live endpoint, fall back to the rollout snapshot.
    Returns (row, live). Raises only if both paths fail."""
    ts = ts if ts is not None else now_ms()
    try:
        return normalize(fetch_active(), ts)
    except Exception as active_err:
        snap = read_rollout()
        if snap is not None:
            return normalize(snap, ts)
        raise active_err


if __name__ == "__main__":
    row, live = fetch()
    print(json.dumps(live, indent=2))
