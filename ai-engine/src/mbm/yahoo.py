"""Yahoo v8 chart history for global cues (the market-cues module's Yahoo source).

YAHOO_INTERVALS are max days per request — assumptions the probe confirms and records.
"""
from __future__ import annotations

import time
from datetime import datetime, timedelta
from typing import Callable

import pandas as pd

from .angel import FetchResult
from .store import BAR_COLUMNS, empty_bars, normalize

YAHOO_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
YAHOO_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")
YAHOO_INTERVALS: dict[str, int | None] = {"1m": 7, "5m": 59, "60m": 729, "1d": None}
# How far back Yahoo serves each intraday interval (days before now).
YAHOO_LOOKBACK: dict[str, int | None] = {"1m": 29, "5m": 59, "60m": 729, "1d": None}
TRIES = 3


class YahooError(Exception):
    pass


def _httpx_get(url: str, params: dict) -> dict:
    import httpx
    r = httpx.get(url, params=params, headers={"User-Agent": YAHOO_UA}, timeout=30)
    try:
        return r.json()
    except ValueError:
        raise YahooError(f"http {r.status_code}") from None


def parse_chart(payload: dict) -> pd.DataFrame:
    chart = (payload or {}).get("chart") or {}
    if chart.get("error"):
        err = chart["error"]
        raise YahooError(err.get("description") or err.get("code") or "yahoo error")
    res = (chart.get("result") or [None])[0]
    if not res or not res.get("timestamp"):
        return empty_bars()
    q = (res.get("indicators") or {}).get("quote", [{}])[0]
    df = pd.DataFrame({
        "ts": pd.to_datetime(res["timestamp"], unit="s", utc=True),
        "open": q.get("open"), "high": q.get("high"), "low": q.get("low"), "close": q.get("close"),
        "volume": q.get("volume"),
    })
    df = df[df["close"].notna()].copy()
    df["oi"] = pd.array([pd.NA] * len(df), dtype="Int64")
    return normalize(df[BAR_COLUMNS])


def fetch_history(symbol: str, interval: str, start: datetime, end: datetime,
                  get: Callable[[str, dict], dict] | None = None,
                  sleep: Callable[[float], None] = time.sleep) -> FetchResult:
    get = get or _httpx_get
    step = YAHOO_INTERVALS[interval]
    url = YAHOO_CHART_URL.format(symbol=symbol)
    frames, failed, calls = [], [], 0
    cur = start
    while cur < end:
        nxt = end if step is None else min(cur + timedelta(days=step), end)
        params = {"period1": int(cur.timestamp()), "period2": int(nxt.timestamp()),
                  "interval": interval, "includePrePost": "false"}
        err = ""
        for attempt in range(TRIES):
            sleep(1)
            calls += 1
            try:
                frames.append(parse_chart(get(url, params)))
                err = ""
                break
            except Exception as exc:  # network, http, or chart.error
                err = f"{type(exc).__name__}: {exc}"
                if attempt < TRIES - 1:
                    sleep(2)
        if err:
            failed.append((cur.date(), nxt.date(), err))
        cur = nxt
    df = normalize(pd.concat(frames, ignore_index=True)) if frames else empty_bars()
    return FetchResult(df=df, failed=failed, calls=calls)
