"""MBM move-size labels (Model A targets).

For a decision at time t (a 5m bar end, UTC) and horizon h the window is the 1m bars that
START in [t, t+h) — strictly after the data the features saw. Horizons:
  30m, 60m  — full window must lie inside the session (else NaN)
  rest      — t → 15:30 IST
  next      — the whole next trading session

Targets: realised range (max high − min low) and absolute move |close_end − close_t|, in
points, bp of close_t and daily-ATR14 units (ATR from prior completed sessions only).
"Big" = range_bp above the trailing median of the same horizon at the same time of day over
the previous `window` sessions whose labels were already realised (causal).
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .features import SESSION_END_MIN, SESSION_OPEN_MIN
from .store import IST

HORIZONS: dict[str, int | str] = {"30m": 30, "60m": 60, "rest": "rest", "next": "next"}
TRAIL_SESSIONS = 60


def _session_1m(df_1m: pd.DataFrame) -> pd.DataFrame:
    d = df_1m[["ts", "high", "low", "close"]].copy()
    local = d["ts"].dt.tz_convert(IST)
    d["mod"] = local.dt.hour * 60 + local.dt.minute
    d["date"] = local.dt.normalize().dt.tz_localize(None)
    return d[(d["mod"] >= SESSION_OPEN_MIN) & (d["mod"] < SESSION_END_MIN)]


def compute_labels(df_1m: pd.DataFrame, decisions: pd.DataFrame, atr: pd.Series) -> pd.DataFrame:
    """decisions: index = decision ts (UTC) with columns `date`, `mod`, `close` (close at t).
    atr: daily ATR14 in points indexed by session date (prior-day, causal). Returns, per
    horizon h, columns range_pts_h, range_bp_h, range_atr_h, absmove_bp_h."""
    m = _session_1m(df_1m)
    days = {dt: (g["mod"].to_numpy(), g["high"].to_numpy(), g["low"].to_numpy(), g["close"].to_numpy())
            for dt, g in m.groupby("date")}
    order = sorted(days)
    nxt = {d: order[i + 1] for i, d in enumerate(order[:-1])}
    out = {f"{k}_{h}": np.full(len(decisions), np.nan) for h in HORIZONS
           for k in ("range_pts", "absmove_pts")}
    dates, mods = decisions["date"].to_numpy(), decisions["mod"].to_numpy()
    closes = decisions["close"].to_numpy(dtype="float64")
    for i in range(len(decisions)):
        dt = pd.Timestamp(dates[i])
        if dt not in days:
            continue
        mo, hi, lo, cl = days[dt]
        t, c0 = mods[i], closes[i]
        for h, spec in HORIZONS.items():
            if spec == "next":
                n = nxt.get(dt)
                if n is None:
                    continue
                _, h2, l2, c2 = days[n]
                rng, end = h2.max() - l2.min(), c2[-1]
            else:
                stop = SESSION_END_MIN if spec == "rest" else t + spec
                if stop > SESSION_END_MIN:
                    continue
                sel = (mo >= t) & (mo < stop)
                if not sel.any():
                    continue
                rng, end = hi[sel].max() - lo[sel].min(), cl[sel][-1]
            out[f"range_pts_{h}"][i] = rng
            out[f"absmove_pts_{h}"][i] = abs(end - c0)
    res = pd.DataFrame(out, index=decisions.index)
    a = atr.reindex(decisions["date"].values).to_numpy()
    for h in HORIZONS:
        res[f"range_bp_{h}"] = res[f"range_pts_{h}"] / closes * 1e4
        res[f"absmove_bp_{h}"] = res[f"absmove_pts_{h}"] / closes * 1e4
        res[f"range_atr_{h}"] = res[f"range_pts_{h}"] / a
    return res


def big_labels(decisions: pd.DataFrame, labels: pd.DataFrame, horizon: str,
               window: int = TRAIL_SESSIONS) -> pd.DataFrame:
    """Causal threshold + binary label + baseline probability for one horizon.
    threshold = median range_bp at the same decision minute over the previous `window` sessions
    (for `next`, sessions whose next session has already closed: shift 2). baseline = trailing
    share of big outcomes over the same window (the "trailing median" baseline forecast)."""
    y = labels[f"range_bp_{horizon}"]
    piv = pd.DataFrame({"date": decisions["date"].values, "mod": decisions["mod"].values,
                        "y": y.values}).pivot_table(index="date", columns="mod", values="y")
    lag = 2 if horizon == "next" else 1
    thr = piv.rolling(window, min_periods=20).median().shift(lag)
    big_hist = (piv > thr).where(piv.notna() & thr.notna())
    base = big_hist.rolling(window, min_periods=20).mean().shift(lag)
    key = pd.MultiIndex.from_arrays([decisions["date"].values, decisions["mod"].values])
    t = thr.stack(future_stack=True).reindex(key).to_numpy()
    p0 = base.stack(future_stack=True).reindex(key).to_numpy()
    big = np.where(np.isnan(y.values) | np.isnan(t), np.nan, (y.values > t).astype(float))
    return pd.DataFrame({"threshold_bp": t, "big": big, "baseline_p": p0}, index=decisions.index)
