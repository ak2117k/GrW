"""Fill sessions Yahoo skipped, from NSE's own end-of-day files.

Yahoo sometimes drops a whole NSE session for every symbol (2026-10-21: no bar for ^NSEI or any `.NS` name,
while 10-19 and 10-22 are there). The scored day is the index's last bar, so one missing day silently
scored a stale `as_of` and left a hole in every lookback. After the Yahoo refresh, each recent weekday
that is not a listed NSE holiday and is missing from a cached series is filled from:

  CM bhavcopy (UDiFF)   content/cm/BhavCopy_NSE_CM_0_0_0_YYYYMMDD_F_0000.csv.zip   → stocks (series EQ)
  ind_close_all         content/indices/ind_close_all_DDMMYYYY.csv                → NIFTYIDX, INDIAVIX

Two requests per missing day cover the whole universe. A 404 means "no session / not published yet": the
day is skipped and retried next run. Yahoo's own bar wins when it appears later (the incremental merge
keeps the newest fetch). Prices are raw exchange prices; Yahoo's are split-adjusted, so a corporate action
inside the overlap window shows up as a > 0.5 % close diff and re-fetches that symbol in full, as before.
"""
from __future__ import annotations

import io
import logging
import time
import zipfile
from datetime import date, datetime, timedelta
from typing import Callable

import pandas as pd

from .prices import COLS, IST, UA, PriceCache, final_cutoff
from .sessions import NSE_HOLIDAYS

log = logging.getLogger("mbm.stock_move")

CM_URL = "https://nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_{d:%Y%m%d}_F_0000.csv.zip"
IDX_URL = "https://nsearchives.nseindia.com/content/indices/ind_close_all_{d:%d%m%Y}.csv"
INDEX_ROWS = {"NIFTYIDX": "Nifty 50", "INDIAVIX": "India VIX"}
LOOKBACK_DAYS = 21          # calendar days behind the cutoff that are checked for holes
PACE_S = 1.0

EodGetter = Callable[[str], "bytes | None"]   # body, or None for 404 (no session / not yet published)


def http_get(url: str) -> bytes | None:
    import httpx
    r = httpx.get(url, headers={"User-Agent": UA}, timeout=30, follow_redirects=True)
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.content


def candidate_days(now: datetime) -> list[date]:
    """Weekdays in the lookback that NSE has not listed as holidays and whose bar is final."""
    cutoff = final_cutoff(now).date()
    out = []
    for k in range(LOOKBACK_DAYS, 0, -1):
        d = cutoff - timedelta(days=k)
        if d.weekday() < 5 and d.isoformat() not in NSE_HOLIDAYS.get(d.year, frozenset()):
            out.append(d)
    return out


def parse_cm(blob: bytes) -> dict[str, dict]:
    """TckrSymb → OHLCV for series EQ rows of a UDiFF CM bhavcopy (zip or plain csv)."""
    if blob[:2] == b"PK":
        with zipfile.ZipFile(io.BytesIO(blob)) as z:
            blob = z.read(z.namelist()[0])
    df = pd.read_csv(io.BytesIO(blob), dtype={"TckrSymb": str, "SctySrs": str})
    df = df[df["SctySrs"].str.strip() == "EQ"]
    return {str(r.TckrSymb).strip(): {"open": float(r.OpnPric), "high": float(r.HghPric), "low": float(r.LwPric),
                                      "close": float(r.ClsPric), "volume": float(r.TtlTradgVol)}
            for r in df.itertuples(index=False)}


def parse_index(blob: bytes) -> dict[str, dict]:
    """Our index name → OHLC from ind_close_all (volume 0: the features never read index volume)."""
    df = pd.read_csv(io.BytesIO(blob), dtype=str)
    df["Index Name"] = df["Index Name"].str.strip()
    out = {}
    for ours, theirs in INDEX_ROWS.items():
        hit = df[df["Index Name"] == theirs]
        if hit.empty:
            continue
        row = hit.iloc[0]
        out[ours] = {"open": float(row["Open Index Value"]), "high": float(row["High Index Value"]),
                     "low": float(row["Low Index Value"]), "close": float(row["Closing Index Value"]), "volume": 0.0}
    return out


def fill_gaps(cache: PriceCache, names: list[str], now: datetime, get: EodGetter = http_get,
              sleep: Callable[[float], None] = time.sleep) -> dict:
    """Insert bars for recent sessions missing from cached series. Never raises; returns stats."""
    stats: dict = {"days": [], "rows": 0, "failed": []}
    frames = {n: cache.read(n) for n in names}
    have = {n: set(pd.DatetimeIndex(f["date"]).date) for n, f in frames.items() if not f.empty}
    for d in candidate_days(now):
        need = [n for n, ds in have.items() if d not in ds and min(ds) < d]
        if not need:
            continue
        try:
            bars = {}
            if any(n in INDEX_ROWS for n in need):
                sleep(PACE_S)
                b = get(IDX_URL.format(d=d))
                if b is None:
                    continue          # no session that day (or not published yet)
                bars.update(parse_index(b))
            if any(n not in INDEX_ROWS for n in need):
                sleep(PACE_S)
                b = get(CM_URL.format(d=d))
                if b is None:
                    continue
                bars.update(parse_cm(b))
        except Exception as exc:
            stats["failed"].append(d.isoformat())
            log.warning("[stock-move] nse eod %s failed: %s", d, exc)
            continue
        n_rows = 0
        for n in need:
            bar = bars.get(n)
            if bar is None:
                continue
            f = frames[n]
            row = pd.DataFrame([{"date": pd.Timestamp(d), **bar}])
            f = pd.concat([f, row], ignore_index=True).drop_duplicates("date", keep="first")
            frames[n] = f.sort_values("date").reset_index(drop=True)[COLS]
            cache.write(n, frames[n])
            have[n].add(d)
            n_rows += 1
        if n_rows:
            stats["days"].append(d.isoformat())
            stats["rows"] += n_rows
    return stats
