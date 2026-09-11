"""The changelog: its file format, "what's new since you last looked", and the
section each release adds.

CHANGELOG.md is newest first, one section per release:

    ## [0.14.1] - 2026-09-11
    - The chat spending chart now puts each chat on the day you last used it.

Notes are written for the people using the app, not for developers: what they
will notice, in plain language, no internals. They go under an `## [Unreleased]`
block at the top; `python3 changelog.py release X.Y.Z` (run by release.sh)
promotes it into that release's section, and refuses to release without one.

Stdlib only: release.sh runs this with the system python3.
"""
from __future__ import annotations

import datetime
import os
import re
import subprocess
import sys

from updater import parse_version

HERE = os.path.dirname(os.path.abspath(__file__))
PATH = os.path.join(HERE, "CHANGELOG.md")

_HEAD = re.compile(r"^## \[(?P<v>[^\]]+)\](?:\s*-\s*(?P<d>\S+))?\s*$")
_MOVED = re.compile(r"checkout: moving from (\S+) to tags/(v\S+)")


def parse(text: str) -> list[dict]:
    """Sections in file order: [{version, date, items}]. `Unreleased` included."""
    out, cur = [], None
    for line in text.splitlines():
        m = _HEAD.match(line)
        if m:
            cur = {"version": m["v"], "date": m["d"], "items": []}
            out.append(cur)
        elif cur is not None and line.startswith("- "):
            cur["items"].append(line[2:].strip())
    return out


def pending(entries: list[dict], seen: str | None, current: str) -> list[dict]:
    """Released sections after `seen`, up to and including `current`, newest
    first. seen=None means everything up to current (the full history)."""
    s, c = parse_version(seen), parse_version(current)
    if c is None:
        return []
    keep = [e for e in entries
            if (v := parse_version(e["version"])) is not None
            and v <= c and (s is None or v > s)]
    return sorted(keep, key=lambda e: parse_version(e["version"]), reverse=True)


def format_section(version: str, date: str, items: list[str]) -> str:
    return f"## [{version}] - {date}\n" + "".join(f"- {i}\n" for i in items) + "\n"


def add_release(text: str, version: str, today: str) -> str:
    """`text` with its `## [Unreleased]` notes promoted to a section for
    `version`. Pure, so it is testable without git or files."""
    if parse_version(version) is None:
        raise ValueError(f"not a semver version: {version!r}")
    if any(e["version"] == version for e in parse(text)):
        raise ValueError(f"CHANGELOG.md already has a section for {version}")

    lines = text.splitlines(keepends=True)
    first = next((i for i, l in enumerate(lines) if _HEAD.match(l.rstrip("\n"))), len(lines))
    head, rest = "".join(lines[:first]), lines[first:]

    notes = []
    if rest and _HEAD.match(rest[0].rstrip("\n")).group("v").lower() == "unreleased":
        end = next((i for i in range(1, len(rest)) if _HEAD.match(rest[i].rstrip("\n"))), len(rest))
        notes = [l[2:].strip() for l in rest[:end] if l.startswith("- ")]
        rest = rest[end:]

    if not notes:
        raise ValueError("no release notes: add them under '## [Unreleased]' at the top of "
                         "CHANGELOG.md — plain language, for the people using the app")
    return head + format_section(version, today, notes) + "".join(rest)


def _git(repo: str, *args: str) -> str:
    return subprocess.check_output(["git", "-C", repo, *args],
                                   stderr=subprocess.DEVNULL, timeout=20).decode()


def subjects_since_last_tag(repo: str = HERE) -> list[str]:
    """What went in since the last release — a prompt for writing the notes."""
    try:
        last = _git(repo, "describe", "--tags", "--abbrev=0").strip()
        rng = [f"{last}..HEAD"]
    except subprocess.CalledProcessError:
        rng = []                                        # no tag yet: all history
    out = _git(repo, "log", "--no-merges", "--pretty=%s", *rng)
    return [s for s in out.splitlines() if s and not s.startswith("Release v")]


def previous_version(repo: str = HERE, git=_git) -> str | None:
    """The version this install ran before its latest update, or None.

    update.sh checks out `tags/vX`, and git's reflog records where it moved from,
    so this works even for an install whose previous version predates the
    changelog. A fresh clone has no such entry and returns None — which is what
    stops a new user being shown the entire history on first launch."""
    try:
        for line in git(repo, "reflog", "--format=%gs", "-n", "200").splitlines():
            m = _MOVED.search(line)
            if m:
                v = git(repo, "show", f"{m[1]}:VERSION").strip()
                return v if parse_version(v) else None
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError):
        pass
    return None


def load(path: str = PATH) -> list[dict]:
    try:
        with open(path, encoding="utf-8") as fh:
            return parse(fh.read())
    except OSError:
        return []


if __name__ == "__main__":
    if len(sys.argv) != 3 or sys.argv[1] != "release":
        sys.exit("usage: python3 changelog.py release X.Y.Z")
    version, today = sys.argv[2], datetime.date.today().isoformat()
    with open(PATH, encoding="utf-8") as fh:
        text = fh.read()
    try:
        new = add_release(text, version, today)
    except ValueError as e:
        commits = "".join(f"\n    {s}" for s in subjects_since_last_tag())
        sys.exit(f"✗ {e}" + (f"\n  commits since the last release:{commits}" if commits else ""))
    with open(PATH, "w", encoding="utf-8") as fh:
        fh.write(new)
    print(format_section(version, today, parse(new)[0]["items"]).rstrip())
