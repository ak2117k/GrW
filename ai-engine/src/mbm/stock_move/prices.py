"""Yahoo daily OHLCV for the stock-move universe, with an incremental per-symbol CSV cache.

Same source and parsing as research/stock-daily/fetch.py (v8 chart, `SYMBOL.NS`, split-adjusted OHLC, dates =
IST session date). The serving image has no pyarrow, so the cache is CSV (floats round-trip exactly).

Incremental: a cached symbol re-fetches only the last ~2 weeks. If an overlapping close moved by > 0.5%
Yahoo has re-adjusted the history (split/bonus): the symbol is re-fetched in full. A bar for `today` is kept
only once the session is final (>= 16:00 IST) — the research also excluded the run day's partial bar.
"""
from __future__ import annotations

import logging
import re
import time
from datetime import datetime
from pathlib import Path
from typing import Callable
from urllib.parse import quote
from zoneinfo import ZoneInfo

import pandas as pd

log = logging.getLogger("mbm.stock_move")

IST = ZoneInfo("Asia/Kolkata")
CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/124.0 Safari/537.36")
INDEX_YAHOO = {"NIFTYIDX": "^NSEI", "INDIAVIX": "^INDIAVIX"}
COLS = ["date", "open", "high", "low", "close", "volume"]
OVERLAP_DAYS = 14
READJUST_TOL = 0.005
FINAL_AFTER = (16, 0)
PACE_S = 1.0
TRIES = 3
NAME_RE = re.compile(r"^[A-Z0-9&_-]{1,30}$")

Getter = Callable[[str, dict], dict]


def yahoo_symbol(name: str) -> str:
    return INDEX_YAHOO.get(name, f"{name}.NS")


def _httpx_get(url: str, params: dict) -> dict:
    import httpx
    r = httpx.get(url, params=params, headers={"User-Agent": UA}, timeout=30)
    if r.status_code == 429:
        raise RuntimeError("http 429")
    return r.json()


def parse_daily(payload: dict) -> pd.DataFrame:
    chart = (payload or {}).get("chart") or {}
    if chart.get("error"):
        raise RuntimeError(str(chart["error"].get("code") or chart["error"]))
    res = (chart.get("result") or [None])[0]
    if not res or not res.get("timestamp"):
        return pd.DataFrame(columns=COLS)
    q = res["indicators"]["quote"][0]
    df = pd.DataFrame({"date": pd.to_datetime(res["timestamp"], unit="s", utc=True)
                       .tz_convert("Asia/Kolkata").normalize().tz_localize(None),
                       "open": q["open"], "high": q["high"], "low": q["low"], "close": q["close"],
                       "volume": q["volume"]})
    df = df.dropna(subset=["close"]).drop_duplicates("date", keep="last")
    return df[COLS].reset_index(drop=True)


def final_cutoff(now: datetime) -> pd.Timestamp:
    """Bars dated on/after this are excluded (today's bar until the session is final)."""
    n = now.astimezone(IST)
    d = pd.Timestamp(n.date())
    return d + pd.Timedelta(days=1) if (n.hour, n.minute) >= FINAL_AFTER else d


class PriceCache:
    def __init__(self, root: Path):
        self.root = Path(root)

    def path(self, name: str) -> Path:
        if not NAME_RE.match(name):
            raise ValueError(f"bad symbol {name!r}")
        return self.root / f"{name.replace('&', '_and_')}.csv"

    def read(self, name: str) -> pd.DataFrame:
        p = self.path(name)
        if not p.is_file():
            return pd.DataFrame(columns=COLS)
        d = pd.read_csv(p, parse_dates=["date"], float_precision="round_trip")
        return d[COLS].sort_values("date").reset_index(drop=True)

    def write(self, name: str, df: pd.DataFrame) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        p = self.path(name)
        tmp = p.with_suffix(".tmp")
        df[COLS].to_csv(tmp, index=False, date_format="%Y-%m-%d")
        tmp.replace(p)


def _fetch(name: str, params: dict, get: Getter, sleep: Callable[[float], None]) -> pd.DataFrame:
    url = CHART_URL.format(symbol=quote(yahoo_symbol(name), safe="^.=-"))
    err = None
    for attempt in range(TRIES):
        sleep(PACE_S if attempt == 0 else 5.0 * attempt)
        try:
            return parse_daily(get(url, params))
        except Exception as exc:  # network / http / chart.error
            err = exc
    raise RuntimeError(f"{name}: {type(err).__name__}: {err}")


def refresh_symbol(cache: PriceCache, name: str, now: datetime, get: Getter = _httpx_get,
                   sleep: Callable[[float], None] = time.sleep) -> str:
    """Update one symbol's cache. Returns 'full' | 'incremental' | 'readjusted'. Raises on fetch failure."""
    old = cache.read(name)
    cutoff = final_cutoff(now)
    base = {"interval": "1d", "includePrePost": "false", "events": "div,split"}
    how = "full"
    if old.empty:
        new = _fetch(name, {**base, "range": "10y"}, get, sleep)
    else:
        start = pd.Timestamp(old["date"].iloc[-1]) - pd.Timedelta(days=OVERLAP_DAYS)
        p1 = int(datetime(start.year, start.month, start.day, tzinfo=IST).timestamp())
        new = _fetch(name, {**base, "period1": p1, "period2": int(now.timestamp()) + 86400}, get, sleep)
        how = "incremental"
        both = old.merge(new, on="date", suffixes=("_o", "_n"))
        if len(both) and ((both.close_n / both.close_o - 1).abs() > READJUST_TOL).any():
            new = _fetch(name, {**base, "range": "10y"}, get, sleep)
            old, how = old.iloc[0:0], "readjusted"
    out = new if old.empty else old if new.empty else pd.concat([old, new], ignore_index=True)
    out = out.drop_duplicates("date", keep="last")
    out = out[out["date"] < cutoff].sort_values("date").reset_index(drop=True)
    if out.empty:
        raise RuntimeError(f"{name}: no bars")
    cache.write(name, out)
    return how


def refresh_all(cache: PriceCache, names: list[str], now: datetime, get: Getter = _httpx_get,
                sleep: Callable[[float], None] = time.sleep) -> dict:
    stats = {"ok": 0, "failed": [], "readjusted": []}
    for n in names:
        try:
            how = refresh_symbol(cache, n, now, get, sleep)
            stats["ok"] += 1
            if how == "readjusted":
                stats["readjusted"].append(n)
        except Exception as exc:
            stats["failed"].append(n)
            log.warning("[stock-move] yahoo %s failed: %s", n, exc)
    return stats


def seed_from_frames(cache: PriceCache, frames: dict[str, pd.DataFrame]) -> int:
    """PC helper: write research parquet frames into a CSV cache (skips symbols already cached)."""
    n = 0
    for name, df in frames.items():
        if cache.path(name).is_file():
            continue
        cache.write(name, df[COLS].sort_values("date"))
        n += 1
    return n


def last_bar_date(cache: PriceCache, name: str) -> pd.Timestamp | None:
    d = cache.read(name)
    return None if d.empty else pd.Timestamp(d["date"].iloc[-1])

