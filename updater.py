"""Self-update check against the repo's git tags.

A "release" is a semver tag `vX.Y.Z` pushed to origin. We compare the installed
VERSION to the newest remote tag using `git ls-remote --tags` — which rides the
existing SSH/HTTPS git auth (no GitHub token needed, works for private repos).

The pure helpers (parse/compare/pick) are unit-tested; the git calls are thin
wrappers around them. Applying an update is handled out-of-process by update.sh
so it can restart the server that triggered it — here we just spawn it.
"""
from __future__ import annotations

import os
import re
import subprocess
import time

HERE = os.path.dirname(os.path.abspath(__file__))
VERSION_FILE = os.path.join(HERE, "VERSION")
UPDATE_SCRIPT = os.path.join(HERE, "update.sh")
STATUS_FILE = os.path.expanduser("~/.claude-usage/update-status")

_TAG_RE = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)$")


def parse_version(s: str | None) -> tuple[int, int, int] | None:
    """'v1.2.3' or '1.2.3' -> (1, 2, 3); anything else (pre-release, junk) -> None."""
    if not s:
        return None
    m = _TAG_RE.match(s.strip())
    return (int(m.group(1)), int(m.group(2)), int(m.group(3))) if m else None


def pick_latest(tags: list[str]) -> str | None:
    """Highest semver tag from a list, returned in its original 'vX.Y.Z' form.
    Tags that don't parse as plain semver are ignored."""
    best = None
    for t in tags:
        v = parse_version(t)
        if v is not None and (best is None or v > best[0]):
            best = (v, t)
    return best[1] if best else None


def is_newer(latest: str | None, current: str | None) -> bool:
    lv, cv = parse_version(latest), parse_version(current)
    if lv is None:
        return False
    if cv is None:
        return True
    return lv > cv


def current_version() -> str:
    try:
        with open(VERSION_FILE) as fh:
            return fh.read().strip()
    except OSError:
        return "0.0.0"


def _ls_remote_tags() -> list[str]:
    """Tag names on origin, via git (no GitHub API / token)."""
    out = subprocess.check_output(
        ["git", "-C", HERE, "ls-remote", "--tags", "--refs", "origin"],
        stderr=subprocess.PIPE, timeout=20,
    ).decode()
    tags = []
    for line in out.splitlines():
        # "<sha>\trefs/tags/v1.2.3"
        ref = line.split("refs/tags/", 1)
        if len(ref) == 2:
            tags.append(ref[1].strip())
    return tags


def check() -> dict:
    """{current, latest, update_available}. `latest` is None if the remote is
    unreachable or has no semver tags; that's not an error, just 'nothing new'."""
    cur = current_version()
    try:
        latest = pick_latest(_ls_remote_tags())
    except Exception:
        latest = None
    return {
        "current": cur,
        "latest": latest,
        "update_available": bool(latest) and is_newer(latest, cur),
    }


def apply_status() -> dict:
    """What the detached updater last reported: state is busy | ok | fail, or
    idle when it has never run. The page that pressed Update polls this so a
    refusal (dirty checkout, unreachable remote) surfaces instead of hanging."""
    try:
        with open(STATUS_FILE) as fh:
            state, _, message = fh.read().strip().partition("\t")
    except OSError:
        return {"state": "idle", "message": ""}
    return {"state": state or "idle", "message": message}


# A run that was killed (reboot, kill -9) never writes ok/fail, so past this a
# "busy" is a leftover, not an update still going. Longer than the page's wait.
BUSY_STALE_SEC = 5 * 60


def _write_status(state: str, message: str) -> None:
    os.makedirs(os.path.dirname(STATUS_FILE), exist_ok=True)
    with open(STATUS_FILE, "w") as fh:
        fh.write(f"{state}\t{message}\n")


def is_applying() -> bool:
    """An update.sh run is still going. Two at once race on git's refs, and the
    loser reports a failure for an update that actually went through."""
    if apply_status()["state"] != "busy":
        return False
    try:
        return time.time() - os.path.getmtime(STATUS_FILE) < BUSY_STALE_SEC
    except OSError:
        return False


def spawn_apply(tag: str) -> None:
    """Launch the detached updater for `tag`. Returns immediately; the helper
    runs independently so it survives the server restart it triggers."""
    if parse_version(tag) is None:
        raise ValueError(f"refusing to update to non-semver tag: {tag!r}")
    # Marked busy here, not only by update.sh, so a second request arriving
    # before the script gets going already sees it (is_applying).
    _write_status("busy", f"applying {tag}")
    try:
        subprocess.Popen(
            ["/bin/bash", UPDATE_SCRIPT, tag],
            cwd=HERE, start_new_session=True,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL,
        )
    except OSError as e:
        _write_status("fail", f"couldn't start the updater: {e}")
        raise


if __name__ == "__main__":
    import json
    print(json.dumps(check(), indent=2))
