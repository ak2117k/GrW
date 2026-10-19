"""MBM indicator driver group (featureSet "mbm-fs5"): classic chart indicators as model inputs.

Offline test 2026-10-19 (walk-forward, 107 blind months): adding these to fs2 improved Model A in
58/107 months at 30m (+0.0015 AUC) and 59/107 at 60m (+0.006), with better Brier on both. As stand-alone
trade rules the same indicators had no edge after costs — the model weighs them in context instead.

Computed on 15-minute bars built from the 5-minute feature bars (bar END labels, continuous across
sessions) and aligned to each 5m row as the LATEST COMPLETED 15m bar, so a row at t never sees data
after t. Every column carries the `ind_` prefix so the group can be ablated like the other drivers.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

PREFIX = "ind_"


def _ema(s: pd.Series, n: int) -> pd.Series:
    return s.ewm(span=n, adjust=False).mean()


def _rma(s: pd.Series, n: int) -> pd.Series:
    return s.ewm(alpha=1 / n, adjust=False).mean()


def _supertrend(h, l, c, tr, n, m):
    atr = _rma(tr, n)
    hl2 = (h + l) / 2
    up, dn, cc = (hl2 + m * atr).to_numpy(), (hl2 - m * atr).to_numpy(), c.to_numpy()
    fu, fd, d = up.copy(), dn.copy(), np.ones(len(cc))
    for i in range(1, len(cc)):
        fu[i] = up[i] if (up[i] < fu[i - 1] or cc[i - 1] > fu[i - 1]) else fu[i - 1]
        fd[i] = dn[i] if (dn[i] > fd[i - 1] or cc[i - 1] < fd[i - 1]) else fd[i - 1]
        d[i] = 1 if cc[i] > fu[i - 1] else (-1 if cc[i] < fd[i - 1] else d[i - 1])
    line = np.where(d > 0, fd, fu)
    return pd.Series(d * (cc - line) / cc, index=c.index)


def _psar(h, l, af0=0.02, afmax=0.2):
    hh, ll = h.to_numpy(), l.to_numpy()
    s = np.zeros(len(hh))
    if len(hh) == 0:
        return pd.Series(s, index=h.index)
    up, ep, af, s[0] = True, hh[0], af0, ll[0]
    for i in range(1, len(hh)):
        s[i] = s[i - 1] + af * (ep - s[i - 1])
        if up:
            if ll[i] < s[i]:
                up, s[i], ep, af = False, ep, ll[i], af0
            elif hh[i] > ep:
                ep, af = hh[i], min(af + af0, afmax)
        else:
            if hh[i] > s[i]:
                up, s[i], ep, af = True, ep, hh[i], af0
            elif ll[i] < ep:
                ep, af = ll[i], min(af + af0, afmax)
    return pd.Series(s, index=h.index)


def indicator_features(b5: pd.DataFrame) -> pd.DataFrame:
    """`b5`: 5m bars indexed by bar END (UTC) with open/high/low/close and an IST `date` column.
    Returns the ind_* columns on `b5`'s index (NaN where history is too short)."""
    out = pd.DataFrame(index=b5.index)
    if b5.empty:
        return out
    b = b5[["open", "high", "low", "close"]].resample("15min", label="right", closed="right").agg(
        {"open": "first", "high": "max", "low": "min", "close": "last"}).dropna()
    o, h, l, c = b.open, b.high, b.low, b.close
    tr = pd.concat([h - l, (h - c.shift()).abs(), (l - c.shift()).abs()], axis=1).max(axis=1)
    f = pd.DataFrame(index=b.index)
    d = c.diff()
    for n in (7, 21):
        up, dn = _rma(d.clip(lower=0), n), _rma((-d).clip(lower=0), n)
        f[f"{PREFIX}rsi{n}"] = 100 - 100 / (1 + up / dn.replace(0, np.nan))
    for fa, sl, sg in ((12, 26, 9), (8, 21, 5)):
        m = _ema(c, fa) - _ema(c, sl)
        f[f"{PREFIX}macdh_{fa}_{sl}"] = (m - _ema(m, sg)) / c
    mid, sd = c.rolling(20).mean(), c.rolling(20).std()
    for k in (2.0, 2.5):
        f[f"{PREFIX}bb_pctb_{k}"] = (c - (mid - k * sd)) / (2 * k * sd)
    f[f"{PREFIX}bb_width"] = 4 * sd / mid
    for n, m in ((10, 3), (7, 2), (10, 2)):
        f[f"{PREFIX}st_{n}_{m}"] = _supertrend(h, l, c, tr, n, m)
    for n in (20, 55):
        hi, lo = h.rolling(n).max().shift(), l.rolling(n).min().shift()
        f[f"{PREFIX}donch_pos_{n}"] = (c - lo) / (hi - lo)
    f[f"{PREFIX}stochk"] = (100 * (c - l.rolling(14).min()) / (h.rolling(14).max() - l.rolling(14).min())).rolling(3).mean()
    tp = (h + l + c) / 3
    f[f"{PREFIX}cci20"] = (tp - tp.rolling(20).mean()) / (0.015 * tp.rolling(20).apply(lambda v: np.abs(v - v.mean()).mean(), raw=True))
    f[f"{PREFIX}wr14"] = -100 * (h.rolling(14).max() - c) / (h.rolling(14).max() - l.rolling(14).min())
    upm, dnm = h.diff(), -l.diff()
    pdm = pd.Series(np.where((upm > dnm) & (upm > 0), upm, 0.0), index=c.index)
    ndm = pd.Series(np.where((dnm > upm) & (dnm > 0), dnm, 0.0), index=c.index)
    atr = _rma(tr, 14)
    pdi, ndi = 100 * _rma(pdm, 14) / atr, 100 * _rma(ndm, 14) / atr
    f[f"{PREFIX}adx14"] = _rma(100 * (pdi - ndi).abs() / (pdi + ndi), 14)
    f[f"{PREFIX}di_diff"] = pdi - ndi
    f[f"{PREFIX}kelt_pos"] = (c - _ema(c, 20)) / (2 * _rma(tr, 20))
    f[f"{PREFIX}roc12"] = c.pct_change(12)
    f[f"{PREFIX}sar_dist"] = (c - _psar(h, l)) / c
    hac = ((o + h + l + c) / 4).to_numpy()
    hao = ((o + c) / 2).to_numpy().copy()
    for i in range(1, len(hao)):
        hao[i] = (hao[i - 1] + hac[i - 1]) / 2
    f[f"{PREFIX}ha_up"] = (hac > hao).astype(float)
    tenkan = (h.rolling(9).max() + l.rolling(9).min()) / 2
    kijun = (h.rolling(26).max() + l.rolling(26).min()) / 2
    f[f"{PREFIX}ichi_tk"] = (tenkan - kijun) / c
    if "date" in b5.columns:
        day = b5["date"].reindex(b.index, method="ffill")
        twap = c.groupby(day.to_numpy()).expanding().mean().reset_index(level=0, drop=True)
        f[f"{PREFIX}twap_dev"] = (c - twap.reindex(c.index)) / c
    f = f.replace([np.inf, -np.inf], np.nan)
    # latest COMPLETED 15m bar at each 5m row (bar end <= row time)
    return f.reindex(f.index.union(b5.index)).ffill().reindex(b5.index)
