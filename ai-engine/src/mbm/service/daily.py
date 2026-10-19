"""Global daily cues (Yahoo ES/NQ/CL/DXY/TNX/INR) for the `global_daily` feature group.

Fetched with the M0 Yahoo client; kept in memory. Any failure leaves that name out of the
dict, which `features.global_daily_features` turns into NaN columns (the model tolerates nulls).
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta
from typing import Callable

import pandas as pd

from ..yahoo import fetch_history

log = logging.getLogger("mbm.daily")

# features.GLOBAL_DAILY name -> Yahoo symbol (series id = universe.yahoo_series_id(symbol)).
YAHOO_SYMBOLS: dict[str, str] = {
    "es": "ES=F", "nq": "NQ=F", "cl": "CL=F", "dxy": "DX-Y.NYB", "tnx": "^TNX", "inr": "INR=X",
}
LOOKBACK_DAYS = 45


def fetch_global_daily(now: datetime, fetch: Callable = fetch_history) -> dict[str, pd.DataFrame]:
    start = now - timedelta(days=LOOKBACK_DAYS)
    out: dict[str, pd.DataFrame] = {}
    for name, sym in YAHOO_SYMBOLS.items():
        try:
            res = fetch(sym, "1d", start, now)
        except Exception as exc:  # never let a cue take the service down
            log.warning("[mbm] yahoo %s failed: %s", sym, exc)
            continue
        if res.failed:
            log.warning("[mbm] yahoo %s partial failure: %s", sym, res.failed[:1])
        if len(res.df):
            out[name] = res.df
    log.info("[mbm] global daily loaded: %s", sorted(out))
    return out
