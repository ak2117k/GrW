"""IST schedule for the MBM loop.

A run fires RUN_OFFSET (45 s) after each 5m bar end from 09:20 to 15:30 IST, Mon–Fri
(09:20:45, 09:25:45, … 15:30:45). The decision time `as_of` of a run is the 5m bar end it
follows. Global daily (Yahoo) data refreshes at 08:30 IST. Exchange holidays are not known
here: on a holiday the bars simply never arrive and every run is skipped as stale.
"""
from __future__ import annotations

from datetime import datetime, time, timedelta
from zoneinfo import ZoneInfo

IST = ZoneInfo("Asia/Kolkata")
STEP = timedelta(minutes=5)
RUN_OFFSET = timedelta(seconds=45)
FIRST_AS_OF = time(9, 20)
LAST_AS_OF = time(15, 30)
SESSION_OPEN = time(9, 15)
SESSION_END = time(15, 30)
DAILY_REFRESH = time(8, 30)
DAILY_SETUPS = time(15, 50)
DEMOTION_CHECK = time(15, 45)      # after close: live-AUC demotion of Model A horizons (M4)
STOCK_MOVE = time(20, 15)          # stock big-move nightly (after the 18:45 self-review), weekdays


def to_ist(now: datetime) -> datetime:
    if now.tzinfo is None:
        raise ValueError("naive datetime: pass an aware clock")
    return now.astimezone(IST)


def is_weekday(d: datetime) -> bool:
    return d.weekday() < 5


def _at(d: datetime, t: time) -> datetime:
    return datetime.combine(d.date(), t, tzinfo=IST)


def floor_5m(now: datetime) -> datetime:
    n = to_ist(now)
    return n.replace(minute=n.minute - n.minute % 5, second=0, microsecond=0)


def as_of_for(now: datetime) -> datetime | None:
    """The decision time a run at `now` serves (the 5m bar end just before it), or None outside
    the 09:20–15:30 IST weekday window."""
    n = to_ist(now)
    if not is_weekday(n):
        return None
    a = floor_5m(n)
    if a.time() < FIRST_AS_OF or a.time() > LAST_AS_OF:
        return None
    return a


def next_run(now: datetime) -> datetime:
    """First run time strictly after `now`."""
    n = to_ist(now)
    day = n
    for _ in range(8):
        if is_weekday(day):
            first = _at(day, FIRST_AS_OF) + RUN_OFFSET
            last = _at(day, LAST_AS_OF) + RUN_OFFSET
            if n < first:
                return first
            if n < last:
                cand = floor_5m(n) + RUN_OFFSET
                return cand if cand > n else cand + STEP
        day = _at(day + timedelta(days=1), time(0, 0))
        n = max(n, day)  # past today: anything tomorrow is after `now`
    raise RuntimeError("unreachable")


def next_daily_refresh(now: datetime) -> datetime:
    n = to_ist(now)
    t = _at(n, DAILY_REFRESH)
    return t if t > n else t + timedelta(days=1)


def next_daily_setups(now: datetime) -> datetime:
    """Next 15:50 IST weekday run of the daily setups job, strictly after `now`. Holidays are
    skipped by the job itself (no session bars for the day ⇒ nothing detected)."""
    n = to_ist(now)
    t = _at(n, DAILY_SETUPS)
    while t <= n or not is_weekday(t):
        t = _at(t + timedelta(days=1), DAILY_SETUPS)
    return t


def next_demotion_check(now: datetime) -> datetime:
    """Next weekday 15:45 IST strictly after `now` (no new outcomes land on weekends)."""
    n = to_ist(now)
    t = _at(n, DEMOTION_CHECK)
    if t <= n:
        t += timedelta(days=1)
    while not is_weekday(t):
        t += timedelta(days=1)
    return t


def next_stock_move(now: datetime) -> datetime:
    """Next weekday 20:15 IST strictly after `now`. Holidays are skipped by the job itself (no new NIFTY
    daily bar ⇒ the latest session is already scored ⇒ nothing to do)."""
    n = to_ist(now)
    t = _at(n, STOCK_MOVE)
    while t <= n or not is_weekday(t):
        t = _at(t + timedelta(days=1), STOCK_MOVE)
    return t


def expected_stock_move_session(now: datetime):
    """The latest weekday whose 20:15 IST run should have happened by `now` (a date). Holidays make this
    an over-estimate, which only costs a redundant catch-up run that finds nothing new to score."""
    t = to_ist(now)
    d = t.date() if t.time() >= STOCK_MOVE else t.date() - timedelta(days=1)
    while d.weekday() >= 5:
        d -= timedelta(days=1)
    return d


def session_end(as_of: datetime) -> datetime:
    return _at(to_ist(as_of), SESSION_END)


def session_open(as_of: datetime) -> datetime:
    return _at(to_ist(as_of), SESSION_OPEN)


def day_start(now: datetime) -> datetime:
    return _at(to_ist(now), time(0, 0))
