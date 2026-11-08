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


def _claude_headline(claude: dict | None) -> tuple[float, str | None, bool] | None:
    """(percent, reset iso, is_five_hour) for the window the menu bar shows:
    the 5-hour one, or the 7-day one on plans that no longer have a 5-hour
    limit (the API then reports five_hour as null)."""
    if not claude:
        return None
    resets = claude.get("resets") or {}
    if claude.get("fh") is not None:
        return claude["fh"], resets.get("five_hour"), True
    if claude.get("sd") is not None:
        return claude["sd"], resets.get("seven_day"), False
    return None


def title_for(latest: dict | None, now: datetime.datetime | None = None) -> str:
    """Menu-bar title, e.g. '35%4.1h' (or '53%1.4d' on the weekly). '—' when no data."""
    w = _claude_headline(latest)
    if w is None:
        return "—"                                 # em-dash: no data
    v, iso, five = w
    p = f"{round(v)}%"
    if five:
        h = hours_until(iso, now=now)
        return f"{p}{h}h" if h is not None else p
    t = time_until(iso, now=now)
    return f"{p}{t}" if t else p


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
    """Claude's headline, e.g. '35% · 4.1h' — the 5-hour window, or the 7-day
    one where there is no 5-hour limit. None when no data."""
    w = _claude_headline(claude)
    if w is None:
        return None
    v, iso, _ = w
    p = f"{round(v)}%"
    t = time_until(iso, now=now)
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
