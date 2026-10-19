"""Daily setups monitor (OBSERVE only: logs NIFTY daily-chart signals and their outcomes, touches no trade).

Definitions match the offline test (NIFTY daily 2007–2026, learn 2007–2018, blind 2019–2026, entry at
the next session's open):

- RIBBON_UP_MACD_GREEN_{10_30,12_26}: EMA fast crosses above EMA slow today AND MACD(12,26,9) hist > 0.
- RETEST_20D_LOW_REBOUND: low within 0.5×ATR14 of the lowest low of the 20 sessions ending 3 sessions
  earlier, AND close > open, close > previous close, close > that low.
- BB_LOWER_TOUCH_UPTREND: low < SMA20 − 2·std20 AND close > EMA200.
- BB_BREAKOUT_UP: close > SMA20 + 2·std20.
- GAP_DOWN_REVERSAL: open / previous close − 1 < −0.004 AND close > open.
- RIBBON_UP_TREND_{10_30,12_26}: EMA fast crosses above EMA slow today AND close > EMA200.
- RIBBON_DOWN_MACD_RED_{10_30,12_26}: EMA fast crosses below EMA slow AND hist < 0. Logged as
  EXIT_OR_TIGHTEN_LONGS, never as a short (down-crosses were not profitable to short).

EMAs are on closes with adjust=False; hist = MACD − EMA9(MACD); std20 is pandas `rolling(20).std()`.
Every indicator on day t uses rows ≤ t only (EWM/rolling/shift are causal), so a signal never looks ahead.
"""
from __future__ import annotations

import logging
import math
from datetime import date, datetime, timedelta
from typing import Any, Callable

import numpy as np
import pandas as pd

from ..yahoo import fetch_history
from . import clock

log = logging.getLogger("mbm.setups")

INSTRUMENT = "NIFTY"
NSEI = "^NSEI"
HISTORY_DAYS = 3 * 366
HORIZONS = (5, 10, 20)
SERVE_SESSIONS = 5
LONG, EXIT = "LONG_SETUP", "EXIT_OR_TIGHTEN_LONGS"
PAIRS = ((10, 30), (12, 26))
RETEST_ATR_MULT = 0.5
GAP_DOWN = -0.004
DAILY_COLUMNS = ["open", "high", "low", "close"]


# ------------------------------------------------------------------ daily series

def empty_daily() -> pd.DataFrame:
    return pd.DataFrame(columns=DAILY_COLUMNS, index=pd.Index([], name="date"), dtype="float64")


def yahoo_daily(df: pd.DataFrame | None) -> pd.DataFrame:
    """Yahoo 1d bars (ts UTC) → OHLC indexed by IST session date."""
    if df is None or df.empty:
        return empty_daily()
    d = df.copy()
    d["date"] = pd.to_datetime(d["ts"], utc=True).dt.tz_convert(clock.IST).dt.date
    d = d.dropna(subset=["open", "close"]).groupby("date").last()[DAILY_COLUMNS].astype("float64")
    d.index.name = "date"
    return d


def session_from_1m(bars: pd.DataFrame | None, day: date) -> dict[str, float] | None:
    """One IST session's OHLC from 1m bars (09:15–15:30): first open, max high, min low, last close."""
    if bars is None or bars.empty:
        return None
    ts = pd.to_datetime(bars["ts"], utc=True).dt.tz_convert(clock.IST)
    m = ((ts.dt.date == day) & (ts.dt.time >= clock.SESSION_OPEN) & (ts.dt.time < clock.SESSION_END))
    d = bars[m].assign(_ts=ts[m]).sort_values("_ts")
    if d.empty:
        return None
    return {"open": float(d["open"].iloc[0]), "high": float(pd.to_numeric(d["high"]).max()),
            "low": float(pd.to_numeric(d["low"]).min()), "close": float(d["close"].iloc[-1])}


def build_daily(yahoo: pd.DataFrame, today_bars: pd.DataFrame | None, today: date) -> pd.DataFrame:
    """Yahoo history, plus today's session from the 1m bars when Yahoo has no row for today yet."""
    d = yahoo_daily(yahoo)
    d = d[d.index <= today]
    if today not in d.index:
        s = session_from_1m(today_bars, today)
        if s is not None:
            d = pd.concat([d, pd.DataFrame([s], index=pd.Index([today], name="date"))])
    return d.sort_index()


def fetch_nsei_daily(now: datetime, fetch: Callable = fetch_history) -> pd.DataFrame:
    res = fetch(NSEI, "1d", now - timedelta(days=HISTORY_DAYS), now)
    if res.failed:
        log.warning("[mbm] yahoo %s partial failure: %s", NSEI, res.failed[:1])
    return res.df


# ------------------------------------------------------------------ indicators + detectors

def ema(s: pd.Series, n: int) -> pd.Series:
    return s.ewm(span=n, adjust=False).mean()


def indicators(d: pd.DataFrame) -> pd.DataFrame:
    c, o, h, l = d["close"], d["open"], d["high"], d["low"]
    x = pd.DataFrame(index=d.index)
    for n in sorted({n for p in PAIRS for n in p} | {200}):
        x[f"ema{n}"] = ema(c, n)
    macd = ema(c, 12) - ema(c, 26)
    x["macd"] = macd
    x["macd_signal"] = ema(macd, 9)
    x["hist"] = macd - x["macd_signal"]
    prev_c = c.shift(1)
    tr = pd.concat([h - l, (h - prev_c).abs(), (l - prev_c).abs()], axis=1).max(axis=1)
    x["atr14"] = tr.rolling(14).mean()
    x["ref_low20"] = l.rolling(20).min().shift(3)    # 20 sessions ending 3 sessions earlier
    x["sma20"] = c.rolling(20).mean()
    x["std20"] = c.rolling(20).std()
    x["prev_close"] = prev_c
    return x


def _f(v) -> float | None:
    v = float(v)
    return None if math.isnan(v) else round(v, 4)


def detect(d: pd.DataFrame, i: int = -1) -> list[dict[str, Any]]:
    """Signals on row `i` of the daily series. Uses rows ≤ i only (callers may pass the full
    series; the result is the same as on `d.iloc[:i+1]`)."""
    n = len(d)
    i = i % n if n else 0
    if n < 2:
        return []
    d = d.iloc[: i + 1]
    x = indicators(d)
    t, y = x.iloc[-1], x.iloc[-2]
    row = d.iloc[-1]
    o, h, l, c = (float(row[k]) for k in DAILY_COLUMNS)
    out: list[dict[str, Any]] = []

    def add(setup, action, **vals):
        out.append({"setup": setup, "action": action, "close": c,
                    "details": {k: _f(v) for k, v in vals.items()}})

    hist = float(t["hist"])
    above200 = c > float(t["ema200"])
    for f, s in PAIRS:
        tag = f"{f}_{s}"
        ef, es, pf, ps = t[f"ema{f}"], t[f"ema{s}"], y[f"ema{f}"], y[f"ema{s}"]
        up = ef > es and pf <= ps
        down = ef < es and pf >= ps
        vals = {f"ema{f}": ef, f"ema{s}": es, f"prev_ema{f}": pf, f"prev_ema{s}": ps, "hist": hist}
        if up and hist > 0:
            add(f"RIBBON_UP_MACD_GREEN_{tag}", LONG, **vals)
        if up and above200:
            add(f"RIBBON_UP_TREND_{tag}", LONG, **vals, ema200=t["ema200"])
        if down and hist < 0:
            add(f"RIBBON_DOWN_MACD_RED_{tag}", EXIT, **vals)

    ref, atr, pc = float(t["ref_low20"]), float(t["atr14"]), float(t["prev_close"])
    if (not math.isnan(ref) and not math.isnan(atr) and abs(l - ref) <= RETEST_ATR_MULT * atr
            and c > o and c > pc and c > ref):
        add("RETEST_20D_LOW_REBOUND", LONG, low=l, ref_low20=ref, atr14=atr, open=o, prev_close=pc)

    sma, sd = float(t["sma20"]), float(t["std20"])
    if not math.isnan(sma) and not math.isnan(sd):
        lower, upper = sma - 2 * sd, sma + 2 * sd
        if l < lower and above200:
            add("BB_LOWER_TOUCH_UPTREND", LONG, low=l, bb_lower=lower, sma20=sma, std20=sd, ema200=t["ema200"])
        if c > upper:
            add("BB_BREAKOUT_UP", LONG, bb_upper=upper, sma20=sma, std20=sd)

    if not math.isnan(pc) and pc > 0 and o / pc - 1 < GAP_DOWN and c > o:
        add("GAP_DOWN_REVERSAL", LONG, open=o, prev_close=pc, gap=o / pc - 1)
    return out


# ------------------------------------------------------------------ outcomes

def outcome_returns(d: pd.DataFrame, signal_date: date) -> dict[int, float]:
    """{N: bp} for each horizon whose close N sessions later is in `d`: next session's open → close
    N sessions after the signal. Gross (no cost)."""
    idx = list(d.index)
    if signal_date not in idx:
        return {}
    i = idx.index(signal_date)
    if i + 1 >= len(idx):
        return {}
    entry = float(d["open"].iloc[i + 1])
    return {n: round((float(d["close"].iloc[i + n]) / entry - 1) * 1e4, 2)
            for n in HORIZONS if i + n < len(idx) and entry > 0}


def fill_rows(pending: list[dict[str, Any]], d: pd.DataFrame, at: datetime) -> list[dict[str, Any]]:
    """Update rows for pending signals: new returns only; outcome_at once all horizons are known."""
    out = []
    for r in pending:
        sd = r["signal_date"]
        sd = sd.date() if isinstance(sd, datetime) else sd
        rets = outcome_returns(d, sd)
        have = {n: r.get(f"ret_{n}d_bp") for n in HORIZONS}
        new = {n: v for n, v in rets.items() if have[n] is None}
        if not new:
            continue
        merged = {n: have[n] if have[n] is not None else rets.get(n) for n in HORIZONS}
        out.append({"id": r["id"], **{f"ret_{n}d_bp": merged[n] for n in HORIZONS},
                    "at": at if all(v is not None for v in merged.values()) else None})
    return out


def last_sessions_since(today: date, n: int = SERVE_SESSIONS) -> date:
    """Start date of the last `n` weekday sessions ending today (holidays only widen the window)."""
    return pd.Timestamp(np.busday_offset(today, -(n - 1), roll="backward")).date()
