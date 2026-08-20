"""Pure formatting for the menu-bar title. No rumps/GUI deps → unit-testable."""
from __future__ import annotations

import datetime


def pct(v) -> str:
    return "–" if v is None else f"{round(v)}%"   # en-dash when unknown


def hours_until(iso: str | None, now: datetime.datetime | None = None) -> str | None:
    """Hours until `iso`, as a string with at most one decimal ('4.1', '4', '0')."""
    if not iso:
        return None
    try:
        dt = datetime.datetime.fromisoformat(iso)
    except (ValueError, TypeError):
        return None
    now = now or datetime.datetime.now(dt.tzinfo)
    h = (dt - now).total_seconds() / 3600
    if h < 0:
        h = 0.0
    return f"{h:.1f}".rstrip("0").rstrip(".")


def title_for(latest: dict | None, now: datetime.datetime | None = None) -> str:
    """Menu-bar title, e.g. '35%4.1h'. Falls back to '—' when no data."""
    if not latest or latest.get("fh") is None:
        return "—"                                 # em-dash: no data
    p = f"{round(latest['fh'])}%"
    h = hours_until((latest.get("resets") or {}).get("five_hour"), now=now)
    return f"{p}{h}h" if h is not None else p


def time_until(iso: str | None, now: datetime.datetime | None = None) -> str | None:
    """Compact time-to-reset: hours under 48h ('4.1h'), else days ('6.9d')."""
    if not iso:
        return None
    try:
        dt = datetime.datetime.fromisoformat(iso)
    except (ValueError, TypeError):
        return None
    now = now or datetime.datetime.now(dt.tzinfo)
    h = max(0.0, (dt - now).total_seconds() / 3600)
    if h < 48:
        return f"{h:.1f}".rstrip("0").rstrip(".") + "h"
    return f"{h / 24:.1f}".rstrip("0").rstrip(".") + "d"


def claude_line(claude: dict | None, now: datetime.datetime | None = None) -> str | None:
    """Claude's 5-hour headline, e.g. '35% · 4.1h'. None when no data."""
    if not claude or claude.get("fh") is None:
        return None
    p = f"{round(claude['fh'])}%"
    t = time_until((claude.get("resets") or {}).get("five_hour"), now=now)
    return f"{p} · {t}" if t else p


def _codex_headline(codex: dict | None) -> dict | None:
    """The binding Codex window: highest utilization, ties broken toward the
    shorter window (more urgent)."""
    if not codex:
        return None
    wins = [w for w in (list(codex.get("windows") or []) + list(codex.get("additional") or []))
            if isinstance(w.get("used_percent"), (int, float))]
    if not wins:
        return None
    return max(wins, key=lambda w: (w["used_percent"], -(w.get("window_seconds") or 0)))


def codex_line(codex: dict | None, now: datetime.datetime | None = None) -> str | None:
    """Codex's binding-window headline, e.g. '12% · 3.2h'. None when no data."""
    w = _codex_headline(codex)
    if w is None:
        return None
    p = f"{round(w['used_percent'])}%"
    t = time_until(w.get("reset_at"), now=now)
    return f"{p} · {t}" if t else p


def lines_for(claude: dict | None, codex: dict | None,
              now: datetime.datetime | None = None) -> list[tuple[str, str]]:
    """(kind, text) rows for the menu bar. One row per source with data, in
    Claude-then-Codex order. Empty list means 'no data'."""
    out = []
    cl = claude_line(claude, now)
    if cl is not None:
        out.append(("claude", cl))
    cx = codex_line(codex, now)
    if cx is not None:
        out.append(("codex", cx))
    return out
