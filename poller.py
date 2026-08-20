"""Fetch Claude Pro/Max usage the same way the desktop app does.

Decrypts the Claude desktop app's claude.ai cookies with the macOS Keychain
'Claude Safe Storage' key, then calls GET /api/organizations/{org}/usage using
curl_cffi's Chrome TLS-fingerprint impersonation to clear Cloudflare.

Heavy deps (curl_cffi) are imported lazily so the pure helpers below
(`normalize`, `detect_org`) can be unit-tested without them.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
import time

SUPPORT = os.path.expanduser("~/Library/Application Support/Claude")
# Your org id is auto-detected from the Claude app (below) or set via
# CLAUDE_USAGE_ORG; there's no hardcoded default so nothing personal ships here.
DEFAULT_ORG = ""
KEYCHAIN_SERVICE = "Claude Safe Storage"
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")

# Windows we chart / store as scalar columns.
BUCKETS = ("five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet")


def now_ms() -> int:
    return int(time.time() * 1000)


def desktop_available() -> bool:
    """Is the Claude desktop app installed (has a cookie store)? Cheap check —
    doesn't touch the Keychain."""
    return os.path.isfile(os.path.join(SUPPORT, "Cookies"))


def get_keychain_key() -> bytes:
    """Read the app's safe-storage password from the Keychain and derive the
    AES-128 key. This is the call that prompts for Keychain access at startup."""
    try:
        pw = subprocess.check_output(
            ["security", "find-generic-password", "-w", "-s", KEYCHAIN_SERVICE],
            stderr=subprocess.PIPE,
        ).strip()
    except subprocess.CalledProcessError as e:
        raise SystemExit(
            f"Could not read '{KEYCHAIN_SERVICE}' from the Keychain "
            f"(is the Claude desktop app installed and have you clicked Allow?).\n"
            f"{e.stderr.decode(errors='replace')}"
        )
    return hashlib.pbkdf2_hmac("sha1", pw, b"saltysalt", 1003, 16)


def _decrypt(enc: bytes, key: bytes) -> str | None:
    if enc[:3] not in (b"v10", b"v11"):
        return None
    p = subprocess.run(
        ["openssl", "enc", "-aes-128-cbc", "-d", "-nopad",
         "-K", key.hex(), "-iv", (b"\x20" * 16).hex()],
        input=enc[3:], capture_output=True,
    )
    dec = p.stdout
    if dec and 1 <= dec[-1] <= 16:            # strip PKCS7 padding
        dec = dec[:-dec[-1]]
    for cand in (dec, dec[32:]):              # Chrome 130+ prepends 32-byte domain hash
        try:
            t = cand.decode()
            if t.isprintable():
                return t
        except UnicodeDecodeError:
            pass
    return None


def read_cookies(key: bytes) -> dict:
    """Re-read + decrypt claude.ai cookies fresh (they rotate while the app runs)."""
    db = "/tmp/claude_usage_cookies.db"
    shutil.copyfile(os.path.join(SUPPORT, "Cookies"), db)
    rows = sqlite3.connect(db).execute(
        "SELECT name, encrypted_value FROM cookies WHERE host_key LIKE '%claude.ai%'"
    ).fetchall()
    out = {}
    for name, enc in rows:
        v = _decrypt(enc, key)
        if v is not None:
            out[name] = v
    if "sessionKey" not in out:
        raise RuntimeError(f"sessionKey cookie not found/decryptable (got {list(out)})")
    return out


def detect_org() -> str:
    """Prefer an explicit override, else read the org the desktop app last used."""
    if os.environ.get("CLAUDE_USAGE_ORG"):
        return os.environ["CLAUDE_USAGE_ORG"]
    try:
        hist = json.load(open(os.path.join(SUPPORT, "plan-usage-history.json")))
        org = hist["samples"][-1]["org"]
        if org:
            return org
    except Exception:
        pass
    if DEFAULT_ORG:
        return DEFAULT_ORG
    raise SystemExit(
        "Could not determine your Claude organization id. Open the Claude "
        "desktop app once (so it writes plan-usage-history.json), or set "
        "CLAUDE_USAGE_ORG=<your-org-uuid>."
    )


def fetch_usage(key: bytes, org: str) -> dict:
    from curl_cffi import requests as creq  # lazy: keeps pure helpers dep-free
    cookies = read_cookies(key)
    r = creq.get(
        f"https://claude.ai/api/organizations/{org}/usage",
        cookies=cookies,
        headers={"User-Agent": UA, "Accept": "application/json"},
        impersonate="chrome",
        timeout=15,
    )
    if r.status_code in (401, 403):
        raise RuntimeError(
            f"claude.ai returned {r.status_code} — session likely expired. "
            f"Open the Claude desktop app to refresh, then retry."
        )
    r.raise_for_status()
    return r.json()


def normalize(raw: dict, ts: int) -> tuple[dict, dict]:
    """Split the /usage response into a compact storage row (scalars only) and a
    richer 'live' payload for the UI. Pure — unit-tested against a real fixture."""
    def util(k: str):
        b = raw.get(k)
        return b.get("utilization") if isinstance(b, dict) else None

    def resets(k: str):
        b = raw.get(k)
        return b.get("resets_at") if isinstance(b, dict) else None

    extra = raw.get("extra_usage") or {}
    row = {
        "ts": ts,
        "fh": util("five_hour"),
        "sd": util("seven_day"),
        "so": util("seven_day_opus"),
        "sn": util("seven_day_sonnet"),
        "credits": extra.get("used_credits"),
    }
    live = {
        **row,
        "resets": {b: resets(b) for b in BUCKETS},
        "extra_usage": extra,
        "limits": raw.get("limits") or [],
    }
    return row, live


if __name__ == "__main__":
    # Smoke test: print one live sample.
    key = get_keychain_key()
    org = detect_org()
    row, live = normalize(fetch_usage(key, org), now_ms())
    print(json.dumps(live, indent=2))
