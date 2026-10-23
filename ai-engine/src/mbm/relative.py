"""MBM relative reading (2026-10-23): an OUTPUT-layer view, the model and its label are unchanged.

The training label calls a window "big" when its range beats the median of the same minute over the
previous 60 sessions. In a high-volatility regime nearly every window beats that (2026-10-21/22: 117 of
120), so p sits at its 0.97 cap all day and cannot tell a quiet drift from a spike. The relative reading
compares the model's own median range forecast (q50_bp) with what the market actually did at the same
minute of day over the last 10 sessions:

    ref_range_bp = median realised range_bp of the same horizon, same IST decision minute, previous
                   REL_SESSIONS sessions (strictly before the decision's session: causal)
    rel_ratio    = q50_bp / ref_range_bp
    rel_label    = QUIETER (< 0.8) | NORMAL (0.8–1.25) | BUSIER (1.25–1.75) | MUCH_BUSIER (> 1.75)

The realised ranges come from `labels.compute_labels` on the same 5m decision grid the outcome filler
uses, so the reference and the later outcome are measured identically.
"""
from __future__ import annotations

import math
from datetime import datetime

import pandas as pd

from . import labels as L
from .features import _annotate, to_5m
from .store import IST

REL_SESSIONS = 10
#: Fewer realised windows than this in the lookback → no reference (nothing is said).
REL_MIN_SESSIONS = 5
QUIETER_BELOW = 0.8
NORMAL_UPTO = 1.25
BUSIER_UPTO = 1.75
REL_LABELS = ("QUIETER", "NORMAL", "BUSIER", "MUCH_BUSIER")


def rel_label(ratio: float | None) -> str | None:
    if ratio is None or not math.isfinite(ratio) or ratio <= 0:
        return None
    if ratio < QUIETER_BELOW:
        return "QUIETER"
    if ratio <= NORMAL_UPTO:
        return "NORMAL"
    if ratio <= BUSIER_UPTO:
        return "BUSIER"
    return "MUCH_BUSIER"


def relative(q50_bp: float | None, ref_bp: float | None) -> tuple[float | None, str | None]:
    """(rel_ratio, rel_label); (None, None) when either side is missing or non-positive."""
    if q50_bp is None or ref_bp is None or not math.isfinite(q50_bp) or not math.isfinite(ref_bp) or ref_bp <= 0:
        return None, None
    ratio = q50_bp / ref_bp
    return ratio, rel_label(ratio)


def ref_range_bp(df_1m: pd.DataFrame, as_of: datetime, horizon: str,
                 sessions: int = REL_SESSIONS, min_sessions: int = REL_MIN_SESSIONS) -> float | None:
    """Median realised range (bp) of `horizon` at `as_of`'s IST minute over the previous `sessions`
    sessions found in `df_1m` (only sessions before as_of's date are used). None when fewer than
    `min_sessions` of them have a complete window (e.g. a 30m window that would cross 15:30)."""
    if df_1m is None or len(df_1m) == 0 or horizon not in L.HORIZONS:
        return None
    a = pd.Timestamp(as_of).tz_convert(IST)
    mod = a.hour * 60 + a.minute
    today = a.normalize().tz_localize(None)
    b = _annotate(to_5m(df_1m))
    decisions = b[(b["mod"] == mod) & (b["date"] < today)][["date", "mod", "close"]].tail(sessions)
    if len(decisions) < min_sessions:
        return None
    lab = L.compute_labels(df_1m, decisions, pd.Series(dtype="float64"))
    rng = lab[f"range_bp_{horizon}"].dropna()
    if len(rng) < min_sessions:
        return None
    return float(rng.median())


def points(bp: float | None, spot: float | None) -> float | None:
    """A basis-point range as index points at `spot`."""
    if bp is None or spot is None or not math.isfinite(bp) or not math.isfinite(spot):
        return None
    return bp * spot / 1e4
