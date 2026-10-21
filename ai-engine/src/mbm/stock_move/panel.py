"""One code path from prices + calendar to model rows, for training (all dates) and serving (one date).

`build_panel` reads one symbol at a time through `read_prices` and, when `keep_dates` is given, keeps only
those rows before moving on — so serving holds one stock's history at a time plus one row per stock.
"""
from __future__ import annotations

from typing import Callable, Iterable

import numpy as np
import pandas as pd

from . import calendar as C
from . import features as F

PriceReader = Callable[[str], pd.DataFrame]


class NoSession(Exception):
    """The index has no bar for the requested date (holiday / data not in yet)."""


def build_panel(names: Iterable[str], read_prices: PriceReader, R: pd.DataFrame, B: pd.DataFrame,
                sectors: dict[str, str], cutoff: pd.Timestamp, keep_dates=None,
                fallback: int = 0) -> tuple[pd.DataFrame, dict]:
    """Panel rows (features + targets + er_* + results_date) for prices dated < `cutoff`.

    Mirrors build.py + earnings_feats.py (+ the run_er.py left merge). `cutoff` is the research CUTOFF: the
    first excluded date; sessions from it onwards are business days (future holidays unknown)."""
    cutoff = pd.Timestamp(cutoff).normalize()
    nidx = read_prices("NIFTYIDX")
    vix = read_prices("INDIAVIX")
    nidx, vix = nidx[nidx.date < cutoff], vix[vix.date < cutoff]
    keep = None if keep_dates is None else pd.DatetimeIndex(pd.to_datetime(list(keep_dates))).normalize()
    if keep is not None and not keep.isin(pd.DatetimeIndex(nidx.date)).all():
        raise NoSession(f"no NIFTY bar for {[str(d.date()) for d in keep]}")
    nf = F.index_feats(nidx, vix)
    names = [n for n in dict.fromkeys(names) if n not in F.INDEX_NAMES]
    R = R[R.sym.isin(names)]
    B = B[B.sym.isin(names)]
    ev, Bf = C.build_events(R, B, today=cutoff)
    ev_by = {s: g for s, g in ev.groupby("sym")}
    b_by = {s: g for s, g in Bf.groupby("sym")}
    sess = C.sessions(nidx.date, cutoff)
    frames, er_parts = {}, []
    stats = {"names": len(names), "priced": 0, "stale": [], "no_events": 0, "close": {}}
    for n in names:
        d = read_prices(n)
        d = d[d.date < cutoff]
        if d.empty or (keep is not None and not keep.isin(pd.DatetimeIndex(d.date)).any()):
            stats["stale"].append(n)
            continue
        stats["priced"] += 1
        stats["close"][n] = float(d.sort_values("date").close.iloc[-1])
        f = F.stock_feats(d, nf)
        frames[n] = f if keep is None else f[f.index.isin(keep)]
        g = ev_by.get(n)
        if g is None:
            stats["no_events"] += 1
            continue
        e = C.er_features(n, g, b_by.get(n, Bf.iloc[0:0]), d, sess, fallback=fallback)
        er_parts.append(e if keep is None else e[e.date.isin(keep)])
    if not frames:
        return pd.DataFrame(), stats
    p = F.assemble(frames, nf, sectors, dates=keep)
    if er_parts:
        er = C.with_season(er_parts)
        p = p.merge(er, on=["date", "sym"], how="left")
    else:
        for c in C.ER_COLS + [C.MEET_COL]:
            p[c] = np.nan
    return p, stats


def frame_reader(frames: dict[str, pd.DataFrame]) -> PriceReader:
    empty = pd.DataFrame(columns=["date", "open", "high", "low", "close", "volume"])
    return lambda n: frames.get(n, empty)
