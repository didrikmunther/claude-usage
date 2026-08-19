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
