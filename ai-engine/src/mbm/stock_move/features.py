"""Daily stock-day features: a line-for-line port of research/stock-daily/build.py.

Every feature at row (stock, t) uses bars with date <= t; targets use closes t+1..t+h (training only).
Indicator definitions: EMA span, Wilder RMA for RSI/ATR, MACD 12/26/9 / close. Corporate-action guard: any
stock-day whose window (t-70, t+10] holds a |log return| > 0.35 is dropped (unadjusted event suspected); at
serving time only the backward half can fire (nothing after t exists yet), exactly as at the research tail.

Training and serving share these functions; `tests/test_stock_move_features.py` pins them to the research
output on a fixture. Price frames: columns date (naive, IST session date), open, high, low, close, volume.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

JUMP = 0.35
MIN_HIST = 200
INDEX_NAMES = ("NIFTYIDX", "INDIAVIX")
# Columns that are never model inputs (run_er.py DROP + the y_* targets).
DROP = {"date", "sym", "n_hist", "fwd5", "fwd10", "results_date"}
CS_COLS = ("ret_5", "ret_20", "ret_60", "atr_pct", "rv_ratio", "vol_z20", "rsi14")


def _ema(s, n):
    return s.ewm(span=n, adjust=False).mean()


def _rma(s, n):
    return s.ewm(alpha=1 / n, adjust=False).mean()


def index_feats(nidx: pd.DataFrame, vix: pd.DataFrame) -> pd.DataFrame:
    n = nidx.sort_values("date").set_index("date")
    v = vix.sort_values("date").set_index("date")["close"]
    c = n["close"]
    lr = np.log(c).diff()
    f = pd.DataFrame(index=n.index)
    f["n_close"] = c
    for k in (1, 5, 20, 60):
        f[f"n_ret{k}"] = c / c.shift(k) - 1
    f["n_d_ema20"], f["n_d_ema50"], f["n_d_ema200"] = c / _ema(c, 20) - 1, c / _ema(c, 50) - 1, c / _ema(c, 200) - 1
    f["n_rv20"] = lr.rolling(20).std()
    f["n_rv_ratio"] = lr.rolling(5).std() / f["n_rv20"]
    d = c.diff()
    f["n_rsi14"] = 100 - 100 / (1 + _rma(d.clip(lower=0), 14) / _rma((-d).clip(lower=0), 14))
    v = v.reindex(f.index).ffill(limit=3)
    f["vix"] = v
    f["vix_chg1"], f["vix_chg5"] = v / v.shift() - 1, v / v.shift(5) - 1
    f["vix_z100"] = (v - v.rolling(100).mean()) / v.rolling(100).std()
    f["vix_over_rv"] = (v / 100) / (f["n_rv20"] * np.sqrt(252))
    for h in (5, 10):
        f[f"n_fwd{h}"] = c.shift(-h) / c - 1
    return f


def stock_feats(d: pd.DataFrame, nf: pd.DataFrame, hist_offset: int = 0) -> pd.DataFrame:
    """`hist_offset`: bars of this stock's history that precede `d` (serving reads only a lookback tail)."""
    d = d.sort_values("date").set_index("date")
    o, h, l, c, vol = d["open"], d["high"], d["low"], d["close"], d["volume"].astype(float)
    lr = np.log(c).diff()
    f = pd.DataFrame(index=d.index)
    for k in (1, 2, 3, 5, 10, 20, 60, 120):
        f[f"ret_{k}"] = c / c.shift(k) - 1
    for w in (5, 10, 20, 60):
        f[f"rv{w}"] = lr.rolling(w).std()
    f["rv_ratio"] = f["rv5"] / f["rv20"]
    f["rv20_60"] = f["rv20"] / f["rv60"]
    tr = pd.concat([h - l, (h - c.shift()).abs(), (l - c.shift()).abs()], axis=1).max(axis=1)
    atr = _rma(tr, 14)
    f["atr_pct"] = atr / c
    f["atr_ratio"] = atr / _rma(tr, 50)
    f["range_atr"] = (h - l) / atr
    e9, e20, e50, e200 = _ema(c, 9), _ema(c, 20), _ema(c, 50), _ema(c, 200)
    f["d_ema9"], f["d_ema20"], f["d_ema50"], f["d_ema200"] = c / e9 - 1, c / e20 - 1, c / e50 - 1, c / e200 - 1
    f["ema9_20"], f["ema20_50"] = e9 / e20 - 1, e20 / e50 - 1
    f["ribbon"] = np.where((e9 > e20) & (e20 > e50), 1, np.where((e9 < e20) & (e20 < e50), -1, 0))
    x = np.sign(e9 - e20)
    cross = (x != x.shift()).astype(float) * x
    f["cross_9_20_now"] = cross
    f["bars_since_cross"] = cross.ne(0).cumsum().pipe(lambda g: g.groupby(g).cumcount()).clip(upper=100)
    m = _ema(c, 12) - _ema(c, 26)
    sig = _ema(m, 9)
    f["macd"], f["macd_hist"] = m / c, (m - sig) / c
    f["macd_hist_chg"] = f["macd_hist"].diff()
    dd = c.diff()
    for n in (7, 14):
        up, dn = _rma(dd.clip(lower=0), n), _rma((-dd).clip(lower=0), n)
        f[f"rsi{n}"] = 100 - 100 / (1 + up / dn.replace(0, np.nan))
    hi250, lo250 = h.rolling(250, min_periods=120).max(), l.rolling(250, min_periods=120).min()
    f["d_hi250"], f["pos250"] = c / hi250 - 1, (c - lo250) / (hi250 - lo250)
    hi20, lo20 = h.rolling(20).max(), l.rolling(20).min()
    f["pos20"] = (c - lo20) / (hi20 - lo20)
    lv = np.log(vol.where(vol > 0))
    f["vol_z20"] = (lv - lv.rolling(20).mean()) / lv.rolling(20).std()
    f["vol_z5"] = lv.rolling(5).mean().sub(lv.rolling(60).mean()) / lv.rolling(60).std()
    gap = o / c.shift() - 1
    f["gap"] = gap
    f["gap_abs20"] = gap.abs().rolling(20).mean()
    f["gap_share20"] = gap.abs().rolling(20).sum() / lr.abs().rolling(20).sum()
    f["gap_atr"] = gap / f["atr_pct"]
    rng = (h - l).replace(0, np.nan)
    f["body0"] = (c - o) / rng
    f["clv0"] = (c - l) / rng
    nf = nf.reindex(f.index)
    nlr = np.log(nf["n_close"]).diff()
    f["beta60"] = lr.rolling(60).cov(nlr) / nlr.rolling(60).var()
    f["corr60"] = lr.rolling(60).corr(nlr)
    f["rs5"] = f["ret_5"] - nf["n_ret5"]
    f["rs20"] = f["ret_20"] - nf["n_ret20"]
    f["rs60"] = f["ret_60"] - nf["n_ret60"]
    f["idio_vol60"] = (lr - f["beta60"] * nlr).rolling(60).std()
    past5 = (c / c.shift(5) - 1).abs()
    thr_then = f["atr_pct"].shift(5) * np.sqrt(5)
    f["big_rate250"] = (past5 > thr_then).astype(float).where(thr_then.notna()).rolling(250, min_periods=60).mean()
    f["dow"] = f.index.dayofweek
    # ---- targets (closes t+1..t+h only); NaN at the serving tail
    for hz in (5, 10):
        fwd = c.shift(-hz) / c - 1
        f[f"fwd{hz}"] = fwd
        f[f"y_up{hz}"] = (fwd > 0).astype(float).where(fwd.notna())
        nfw = nf[f"n_fwd{hz}"]
        f[f"y_rel{hz}"] = ((fwd - nfw) > 0).astype(float).where(fwd.notna() & nfw.notna())
    thr5 = f["atr_pct"] * np.sqrt(5)
    for k in (1.0, 1.5):
        f[f"y_big5_{k}"] = (f["fwd5"].abs() > k * thr5).astype(float).where(f["fwd5"].notna() & thr5.notna())
    f["y_hurdle5"] = (f["fwd5"].abs() > f["atr_pct"]).astype(float).where(f["fwd5"].notna())
    jump = (lr.abs() > JUMP).astype(int)
    back = jump.rolling(70, min_periods=1).max()
    fwdj = jump[::-1].rolling(10, min_periods=1).max()[::-1].shift(-1).fillna(0)
    f["ca_flag"] = ((back + fwdj) > 0).astype(int)
    f["n_hist"] = np.arange(len(f)) + int(hist_offset)
    return f


def assemble(stock_frames: dict[str, pd.DataFrame], nf: pd.DataFrame, sectors: dict[str, str],
             dates=None) -> pd.DataFrame:
    """build.py main() after the per-stock loop: sector + NIFTY context + cross-sectional features, then the
    warm-up / corporate-action filter. `dates` (serving): keep only those dates — the cross-sectional
    features are computed on every stock present on a date BEFORE the filter, as in the research."""
    parts = []
    for n in sorted(stock_frames):
        f = stock_frames[n]
        if dates is not None:
            f = f[f.index.isin(dates)]
        f = f.copy()
        f["sym"] = n
        f["sector"] = sectors.get(n, "Unknown")
        parts.append(f)
    p = pd.concat(parts)
    p.index.name = "date"
    p = p.reset_index()
    nfx = nf.drop(columns=["n_close", "n_fwd5", "n_fwd10"])
    nfx.index.name = "date"
    p = p.merge(nfx.reset_index(), on="date", how="left")
    for k in (5, 20, 60):
        sm = p.groupby(["date", "sector"])[f"ret_{k}"].transform("mean")
        p[f"sec_ret{k}"] = sm
        p[f"sec_rs{k}"] = p[f"ret_{k}"] - sm
        p[f"secidx_rs{k}"] = sm - p[f"n_ret{k}"]
    for col in CS_COLS:
        p[f"cs_{col}"] = p.groupby("date")[col].rank(pct=True)
    p = p[(p.ca_flag == 0) & (p.n_hist >= MIN_HIST)].drop(columns=["ca_flag"])
    return p.replace([np.inf, -np.inf], np.nan).reset_index(drop=True)


def feature_columns(columns) -> list[str]:
    return [c for c in columns if c not in DROP and not c.startswith("y_")]
