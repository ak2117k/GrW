"""Nightly NSE results-calendar refresh (bulk endpoints, 3 requests a night).

  corporate-board-meetings?index=equities&from_date=..&to_date=..   (filters on the meeting date)
  corporates-financial-results?index=equities&period=Quarterly      (each company's latest filings)
Parsed with the research rules (`calendar.nse_rows`), filtered to the universe and merged into a small
CSV cache. Events are rebuilt from seed (the artefact's NSE+BSE history) ∪ cache, so the seed never needs
rewriting and a failed night only means the cached calendar is one day older.
"""
from __future__ import annotations

import logging
import time
from datetime import datetime, timedelta
from pathlib import Path
from typing import Callable

import pandas as pd

from . import calendar as C

log = logging.getLogger("mbm.stock_move")

HOME = "https://www.nseindia.com/"
BM_URL = "https://www.nseindia.com/api/corporate-board-meetings"
RES_URL = "https://www.nseindia.com/api/corporates-financial-results"
HEADERS = {"User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
                          "Chrome/124.0 Safari/537.36"),
           "Accept": "application/json, text/plain, */*", "Accept-Language": "en-US,en;q=0.9",
           "Referer": "https://www.nseindia.com/companies-listing/corporate-filings-board-meetings"}
BM_BACK_DAYS, BM_AHEAD_DAYS = 30, 90
PACE_S = 1.5

Fetcher = Callable[[datetime], tuple[list, list]]


def fetch_bulk(now: datetime, sleep: Callable[[float], None] = time.sleep) -> tuple[list, list]:
    """(board-meeting rows, financial-results rows) from NSE. Raises on any failure."""
    import httpx
    d0, d1 = (now - timedelta(days=BM_BACK_DAYS)).strftime("%d-%m-%Y"), (now + timedelta(days=BM_AHEAD_DAYS)).strftime("%d-%m-%Y")
    with httpx.Client(headers=HEADERS, timeout=60, follow_redirects=True) as c:
        c.get(HOME)
        sleep(PACE_S)
        bm = c.get(BM_URL, params={"index": "equities", "from_date": d0, "to_date": d1}).json()
        sleep(PACE_S)
        res = c.get(RES_URL, params={"index": "equities", "period": "Quarterly"}).json()
    if not isinstance(bm, list) or not isinstance(res, list):
        raise RuntimeError("unexpected NSE payload shape")
    return bm, res


def parse_bulk(bm: list, res: list, universe: set[str]) -> tuple[pd.DataFrame, pd.DataFrame]:
    by_bm: dict[str, list] = {}
    for x in bm:
        s = str(x.get("bm_symbol") or "").strip()
        if s in universe:
            by_bm.setdefault(s, []).append(x)
    by_res: dict[str, list] = {}
    for x in res:
        s = str(x.get("symbol") or "").strip()
        if s in universe:
            by_res.setdefault(s, []).append(x)
    R, B = [], []
    for s in sorted(set(by_bm) | set(by_res)):
        r, b = C.nse_rows(s, by_res.get(s, []), by_bm.get(s, []))
        R += r
        B += b
    return C.frames(R, B)


class CalendarCache:
    def __init__(self, cache_dir: Path, seed_dir: Path | None):
        self.dir = Path(cache_dir)
        self.seed_dir = Path(seed_dir) if seed_dir else None

    def _read(self, path: Path, cols: list[str], dates: list[str]) -> pd.DataFrame:
        if not path.is_file():
            return pd.DataFrame(columns=cols)
        d = pd.read_csv(path, parse_dates=dates)
        return d[cols]

    def load(self) -> tuple[pd.DataFrame, pd.DataFrame]:
        parts_r, parts_b = [], []
        for d in [x for x in (self.seed_dir, self.dir) if x is not None]:
            parts_r.append(self._read(d / "calendar_R.csv.gz", C.R_COLS, ["t"]))
            parts_b.append(self._read(d / "calendar_B.csv.gz", C.B_COLS, ["meet_date", "known_at"]))
        return C.frames(_concat(parts_r, C.R_COLS), _concat(parts_b, C.B_COLS))

    def merge(self, R_new: pd.DataFrame, B_new: pd.DataFrame) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)
        R_old = self._read(self.dir / "calendar_R.csv.gz", C.R_COLS, ["t"])
        B_old = self._read(self.dir / "calendar_B.csv.gz", C.B_COLS, ["meet_date", "known_at"])
        R, B = C.frames(_concat([R_old, R_new], C.R_COLS), _concat([B_old, B_new], C.B_COLS))
        write_csv(R, self.dir / "calendar_R.csv.gz")
        write_csv(B, self.dir / "calendar_B.csv.gz")


def _concat(parts: list[pd.DataFrame], cols: list[str]) -> pd.DataFrame:
    parts = [p for p in parts if len(p)]
    return pd.concat(parts, ignore_index=True) if parts else pd.DataFrame(columns=cols)


def write_csv(df: pd.DataFrame, path: Path) -> None:
    tmp = path.with_name(path.name + ".tmp")
    df.to_csv(tmp, index=False, compression="gzip", date_format="%Y-%m-%d %H:%M:%S.%f")
    tmp.replace(path)


def refresh(cache: CalendarCache, universe: list[str], now: datetime, fetch: Fetcher = fetch_bulk) -> dict:
    """Fail-soft: returns {"ok": bool, "bm": n, "res": n, "error": str|None}; the cache is untouched on error."""
    try:
        bm, res = fetch(now)
        R, B = parse_bulk(bm, res, set(universe))
        cache.merge(R, B)
        return {"ok": True, "bm": len(B), "res": len(R), "error": None}
    except Exception as exc:
        log.warning("[stock-move] NSE calendar refresh failed: %s", exc)
        return {"ok": False, "bm": 0, "res": 0, "error": f"{type(exc).__name__}: {exc}"[:200]}
