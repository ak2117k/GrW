"""NSE trading sessions for the outcome window (aligned with the API's self-review judge, stream W).

A STOCK_MOVE row is judged on the session that ends its window: `as_of` + 5 NSE trading sessions, skipping
weekends and NSE holidays. Truth = the NIFTY index's own daily bars: inside the range the index cache covers,
a weekday is a session iff NIFTY has a bar (Yahoo's 2025 gaps match NSE's official 2025 list exactly).
Beyond it (future dates) the listed holidays below apply.

NOTE (2026-10-22): the API list (market-holidays.service.ts) was corrected the same day to the NSE 2026
circular; this set mirrors it (future: 11-10 Diwali Balipratipada, 11-24 Guru Nanak Jayanti, 12-25 Christmas).
"""
from __future__ import annotations

from datetime import date, timedelta
from typing import Iterable

NSE_HOLIDAYS: dict[int, frozenset[str]] = {
    2025: frozenset({
        "2025-02-26", "2025-03-14", "2025-03-31", "2025-04-10", "2025-04-14", "2025-04-18", "2025-05-01",
        "2025-08-15", "2025-08-27", "2025-10-02", "2025-10-22", "2025-11-05", "2025-12-25",
    }),
    2026: frozenset({
        "2026-01-15", "2026-01-26", "2026-03-03", "2026-03-26", "2026-03-31", "2026-04-03", "2026-04-14",
        "2026-05-01", "2026-05-28", "2026-06-26", "2026-09-14", "2026-10-02", "2026-10-20",
        "2026-11-10", "2026-11-24", "2026-12-25",
    }),
}


class SessionCalendar:
    def __init__(self, index_dates: Iterable = ()):
        ds = sorted({_d(x) for x in index_dates})
        self.observed = set(ds)
        self.last_observed = ds[-1] if ds else None
        self.first_observed = ds[0] if ds else None

    def is_session(self, d: date) -> bool:
        if d.weekday() >= 5:
            return False
        if self.first_observed and self.first_observed <= d <= self.last_observed:
            return d in self.observed                 # the exchange's own record wins
        listed = NSE_HOLIDAYS.get(d.year)
        return True if listed is None else d.isoformat() not in listed

    def add_sessions(self, d: date, n: int) -> date:
        """The n-th NSE session strictly after `d`."""
        cur, k = d, 0
        while k < n:
            cur += timedelta(days=1)
            if self.is_session(cur):
                k += 1
        return cur


def _d(x) -> date:
    if isinstance(x, date) and not hasattr(x, "hour"):
        return x
    import pandas as pd
    return pd.Timestamp(x).date()
