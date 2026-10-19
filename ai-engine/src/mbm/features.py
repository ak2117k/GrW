"""MBM causal feature pipeline (featureSet "mbm-fs2").

One implementation for training and (M2) serving. Features are computed on 5-minute bars
built from 1m bars and indexed by the bar's END time (UTC): the row at t uses only 1m bars
that started before t, i.e. data up to the close of the bar ending at t. Daily context uses
only completed prior sessions; global (Yahoo) daily bars use only bars whose trading date is
before the NSE session date (they all close before 09:15 IST of the next day).

Driver groups are named and togglable. Every driver column carries its group prefix so a
model can be ablated by dropping columns. A missing driver yields NaN columns, never errors.

fs2 adds the NIFTY expiry calendar (days to expiry, expiry day, monthly expiry). The exchange
holiday calendar is published in advance, so deriving expiry shifts from the session dates
is not look-ahead.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

from .store import IST, read_bars

FEATURE_SET = "mbm-fs2"
DRIVER_GROUPS: tuple[str, ...] = ("banknifty", "vix", "heavyweights", "global_daily")
GROUP_PREFIX = {"banknifty": "bn_", "vix": "vix_", "heavyweights": "hw_", "global_daily": "gd_"}
SESSION_OPEN_MIN = 9 * 60 + 15
SESSION_END_MIN = 15 * 60 + 30
# Approximate NIFTY index weights (renormalised over whichever stocks are present).
HEAVYWEIGHTS: dict[str, float] = {
    "EQ_HDFCBANK": 0.13, "EQ_RELIANCE": 0.09, "EQ_ICICIBANK": 0.09, "EQ_INFY": 0.05,
    "EQ_BHARTIARTL": 0.05, "EQ_LT": 0.04, "EQ_ITC": 0.035, "EQ_TCS": 0.03,
}
# name -> Yahoo daily series id
GLOBAL_DAILY: dict[str, str] = {
    "es": "YF_ES_F", "nq": "YF_NQ_F", "cl": "YF_CL_F", "dxy": "YF_DX_Y_NYB",
    "tnx": "YF__TNX", "inr": "YF_INR_X",
}
BANKNIFTY = "BANKNIFTY"
VIX = "INDIAVIX"
# NIFTY expiry regimes: monthly-only (last Thursday) before weekly options; weekly Thursday;
# weekly Tuesday from Sep 2025. A holiday moves the expiry to the previous session.
WEEKLY_EXPIRY_FROM = pd.Timestamp("2019-02-11")
TUESDAY_EXPIRY_FROM = pd.Timestamp("2025-09-01")


# ---------------------------------------------------------------- bars

def to_5m(df_1m: pd.DataFrame | None) -> pd.DataFrame:
    """1m → 5m session bars indexed by bar END (UTC), with IST `date` and end minute `mod`."""
    cols = ["open", "high", "low", "close", "volume"]
    if df_1m is None or len(df_1m) == 0:
        return pd.DataFrame(columns=cols, index=pd.DatetimeIndex([], tz="UTC", name="ts"), dtype="float64")
    d = df_1m.set_index("ts")[cols].astype("float64")
    local = d.index.tz_convert(IST)
    mins = local.hour * 60 + local.minute
    d = d[(mins >= SESSION_OPEN_MIN) & (mins < SESSION_END_MIN)]
    b = d.resample("5min", label="right", closed="left").agg(
        {"open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum"})
    return b.dropna(subset=["close"])


def _annotate(b: pd.DataFrame) -> pd.DataFrame:
    b = b.copy()
    local = b.index.tz_convert(IST)
    b["date"] = local.normalize().tz_localize(None)
    b["mod"] = local.hour * 60 + local.minute
    return b


def daily_context(b5: pd.DataFrame) -> pd.DataFrame:
    """Per IST session date: that day's OHLC plus PRIOR-day stats (shifted, so causal)."""
    g = b5.groupby("date")
    d = pd.DataFrame({"d_open": g["open"].first(), "d_high": g["high"].max(),
                      "d_low": g["low"].min(), "d_close": g["close"].last()})
    pc = d["d_close"].shift(1)
    tr = pd.concat([d["d_high"] - d["d_low"], (d["d_high"] - pc).abs(), (d["d_low"] - pc).abs()],
                   axis=1).max(axis=1)
    rng = d["d_high"] - d["d_low"]
    out = pd.DataFrame(index=d.index)
    out["p_high"], out["p_low"], out["p_close"] = d["d_high"].shift(1), d["d_low"].shift(1), pc
    out["p_range"] = rng.shift(1)
    out["p_ret"] = pc / d["d_close"].shift(2) - 1
    out["p_ret5"] = pc / d["d_close"].shift(6) - 1
    out["atr14"] = tr.rolling(14, min_periods=10).mean().shift(1)
    out["p_rng5_vs_20"] = rng.rolling(5).mean().shift(1) / rng.rolling(20).mean().shift(1)
    return out


def _ret(s: pd.Series, n: int, by) -> pd.Series:
    return s / s.groupby(by).shift(n) - 1


def _align(b: pd.DataFrame, idx: pd.DatetimeIndex, dates: pd.Series) -> pd.DataFrame:
    """Driver 5m bars on the instrument index; forward-fill at most 2 bars within a session."""
    a = b.reindex(idx)
    return a.groupby(dates.values).ffill(limit=2)


# ---------------------------------------------------------------- groups

def price_features(b: pd.DataFrame) -> pd.DataFrame:
    c, g, date = b["close"], b.groupby("date"), b["date"]
    ctx = daily_context(b).reindex(date.values)
    ctx.index = b.index
    atr = ctx["atr14"]
    f = pd.DataFrame(index=b.index)
    for n in (1, 3, 6, 12, 24):
        f[f"ret_{n}"] = _ret(c, n, date)
    d_open = g["open"].transform("first")
    f["ret_since_open"] = c / d_open - 1
    f["gap"] = d_open / ctx["p_close"] - 1
    hi, lo = g["high"].cummax(), g["low"].cummin()
    rng = (hi - lo).replace(0, np.nan)
    f["pos_in_day_range"] = (c - lo) / rng
    f["day_range_vs_atr"] = rng / atr
    f["day_range_bp"] = rng / c * 1e4
    f["vs_prev_high"] = (c - ctx["p_high"]) / atr
    f["vs_prev_low"] = (c - ctx["p_low"]) / atr
    f["vs_prev_close"] = (c - ctx["p_close"]) / atr
    f["prev_ret"] = ctx["p_ret"]
    f["prev_ret5"] = ctx["p_ret5"]
    f["prev_range_vs_atr"] = ctx["p_range"] / atr
    f["atr14_bp"] = atr / c * 1e4
    f["rng5_vs_20"] = ctx["p_rng5_vs_20"]
    r1 = c.pct_change(fill_method=None)
    f["vol_12"] = r1.rolling(12).std()
    f["vol_ratio"] = r1.rolling(6).std() / r1.rolling(48).std()
    f["vol_375"] = r1.rolling(375).std()
    f["hl_6_vs_atr"] = (b["high"].rolling(6).max() - b["low"].rolling(6).min()) / atr
    for span in (9, 21, 50):
        f[f"ema{span}_dist"] = c / c.ewm(span=span).mean() - 1
    delta = c.diff()
    up = delta.clip(lower=0).ewm(alpha=1 / 14).mean()
    dn = (-delta.clip(upper=0)).ewm(alpha=1 / 14).mean()
    f["rsi14"] = 100 - 100 / (1 + up / dn.replace(0, np.nan))
    span_ = (b["high"] - b["low"]).replace(0, np.nan)
    f["body_frac"] = (b["close"] - b["open"]) / span_
    f["upper_wick"] = (b["high"] - b[["open", "close"]].max(axis=1)) / span_
    f["lower_wick"] = (b[["open", "close"]].min(axis=1) - b["low"]) / span_
    f["minute_of_day"] = b["mod"]
    f["minutes_left"] = SESSION_END_MIN - b["mod"]
    f["dow"] = b.index.tz_convert(IST).dayofweek
    cal = expiry_calendar(b["date"])
    for col in cal.columns:
        f[col] = cal[col].to_numpy()
    in_or = b["mod"] <= SESSION_OPEN_MIN + 30          # bars ending by 09:45 form the opening range
    or_hi = b["high"].where(in_or).groupby(date).cummax().groupby(date).ffill()
    or_lo = b["low"].where(in_or).groupby(date).cummin().groupby(date).ffill()
    after = b["mod"] >= SESSION_OPEN_MIN + 30
    f["vs_or_hi"] = ((c - or_hi) / atr).where(after)
    f["vs_or_lo"] = ((c - or_lo) / atr).where(after)
    return f


def banknifty_features(b: pd.DataFrame, bn5: pd.DataFrame, price: pd.DataFrame) -> pd.DataFrame:
    date = b["date"]
    a = _align(bn5, b.index, date)
    c = a["close"]
    f = pd.DataFrame(index=b.index)
    f["bn_ret_3"] = _ret(c, 3, date)
    f["bn_ret_12"] = _ret(c, 12, date)
    d_open = a["open"].groupby(date.values).transform("first")
    f["bn_ret_since_open"] = c / d_open - 1
    f["bn_rs"] = f["bn_ret_since_open"] - price["ret_since_open"]
    f["bn_vol_12"] = c.pct_change(fill_method=None).rolling(12, min_periods=6).std()
    hi = a["high"].groupby(date.values).cummax()
    lo = a["low"].groupby(date.values).cummin()
    f["bn_day_range_bp"] = (hi - lo) / c * 1e4
    return f


def vix_features(b: pd.DataFrame, vx5: pd.DataFrame) -> pd.DataFrame:
    date = b["date"]
    a = _align(vx5, b.index, date)
    c = a["close"]
    day_close = c.groupby(date.values).last()       # complete days only used after shift(1)
    prev = day_close.shift(1).reindex(date.values).to_numpy()
    mean20 = day_close.rolling(20, min_periods=10).mean().shift(1).reindex(date.values).to_numpy()
    f = pd.DataFrame(index=b.index)
    f["vix_level"] = c
    f["vix_chg_day"] = c / prev - 1
    f["vix_ret_12"] = _ret(c, 12, date)
    f["vix_vs_20d"] = c / mean20
    return f


def heavyweight_features(b: pd.DataFrame, eq5: dict[str, pd.DataFrame]) -> pd.DataFrame:
    date = b["date"]
    names = list(HEAVYWEIGHTS)
    ro, r3, vr, gap = {}, {}, {}, {}
    for s in names:
        e = eq5.get(s)
        if e is None or len(e) == 0:
            continue
        a = _align(e, b.index, date)
        c = a["close"]
        d_open = a["open"].groupby(date.values).transform("first")
        pclose = c.groupby(date.values).last().shift(1).reindex(date.values).to_numpy()
        ro[s] = c / d_open - 1
        r3[s] = _ret(c, 3, date)
        gap[s] = d_open / pclose - 1
        v6 = a["volume"].rolling(6, min_periods=3).sum()
        vr[s] = v6 / v6.rolling(375, min_periods=75).mean()
    f = pd.DataFrame(index=b.index)
    if not ro:
        for col in ("hw_wret_open", "hw_wret_3", "hw_frac_up", "hw_disp", "hw_absret_3",
                    "hw_volratio", "hw_wgap", "hw_n"):
            f[col] = np.nan
        return f
    RO, R3, VR, GP = (pd.DataFrame(x) for x in (ro, r3, vr, gap))
    w = pd.Series({s: HEAVYWEIGHTS[s] for s in RO.columns})

    def wmean(m: pd.DataFrame) -> pd.Series:
        ww = m.notna() * w
        return (m.fillna(0) * w).sum(axis=1) / ww.sum(axis=1).replace(0, np.nan)

    f["hw_wret_open"] = wmean(RO)
    f["hw_wret_3"] = wmean(R3)
    f["hw_frac_up"] = (RO > 0).astype("float64").where(RO.notna()).mean(axis=1)
    f["hw_disp"] = RO.std(axis=1)
    f["hw_absret_3"] = R3.abs().mean(axis=1)
    f["hw_volratio"] = wmean(VR)
    f["hw_wgap"] = wmean(GP)
    f["hw_n"] = RO.notna().sum(axis=1).astype("float64").replace(0, np.nan)
    return f


def global_daily_features(b: pd.DataFrame, daily: dict[str, pd.DataFrame]) -> pd.DataFrame:
    """Previous-day moves of global cues. A Yahoo daily bar's trading date is (ts + 12h).date in
    UTC (ES/NQ/CL label at 04:00 UTC, FX at 23:00 UTC the day before, TNX 12:20 UTC). Only bars
    with trading date <= session date - 1 day are used: all of those close before 09:15 IST."""
    sess = pd.DataFrame({"date": pd.Series(b["date"].unique())}).sort_values("date")
    sess["key"] = sess["date"] - pd.Timedelta(days=1)
    out = sess[["date"]].copy()
    for name, _sid in GLOBAL_DAILY.items():
        cols = [f"gd_{name}_ret1", f"gd_{name}_ret5", f"gd_{name}_rng1"]
        d = daily.get(name)
        if d is None or len(d) == 0:
            for col in cols:
                out[col] = np.nan
            continue
        d = d.copy()
        d["tdate"] = (d["ts"] + pd.Timedelta(hours=12)).dt.tz_convert("UTC").dt.tz_localize(None).dt.normalize()
        d = d.sort_values("tdate").drop_duplicates("tdate", keep="last")
        cl = d["close"].astype("float64")
        if name == "tnx":                               # yield: change in level, not return
            r1, r5 = cl - cl.shift(1), cl - cl.shift(5)
        else:
            r1, r5 = cl / cl.shift(1) - 1, cl / cl.shift(5) - 1
        g = pd.DataFrame({"tdate": d["tdate"].values, cols[0]: r1.values, cols[1]: r5.values,
                          cols[2]: ((d["high"] - d["low"]) / cl).values})
        m = pd.merge_asof(sess[["key"]].reset_index(), g, left_on="key", right_on="tdate",
                          direction="backward", tolerance=pd.Timedelta(days=5)).set_index("index")
        for col in cols:
            out[col] = m[col].values
    f = out.set_index("date").reindex(b["date"].values)
    f.index = b.index
    return f


# ---------------------------------------------------------------- assembly

def expiry_dates(sessions: pd.DatetimeIndex) -> pd.DatetimeIndex:
    """NIFTY expiry sessions for the given trading sessions (naive IST dates, sorted).
    Sessions are padded 3 weeks past the data with plain weekdays so the live week has one."""
    pad = pd.bdate_range(sessions[-1] + pd.Timedelta(days=1), periods=15)
    s = sessions.append(pad)
    is_session = pd.Series(True, index=s)
    out = set()
    for d in s:
        if d < WEEKLY_EXPIRY_FROM:      # monthly: last Thursday of the month
            month_end = d + pd.offsets.MonthEnd(0)
            sched = month_end - pd.Timedelta(days=(month_end.weekday() - 3) % 7)
        else:
            wd = 1 if d >= TUESDAY_EXPIRY_FROM else 3
            sched = d - pd.Timedelta(days=d.weekday()) + pd.Timedelta(days=wd)
        # previous session on/before the scheduled day, within the same week (weekly) or month
        cands = is_session.loc[:sched].index
        floor = sched - pd.Timedelta(days=sched.weekday()) if d >= WEEKLY_EXPIRY_FROM else sched.replace(day=1)
        cands = cands[cands >= floor]
        if len(cands):
            out.add(cands[-1])
    return pd.DatetimeIndex(sorted(out))


def expiry_calendar(dates: pd.Series) -> pd.DataFrame:
    """Per-row: trading sessions until the next expiry (0 on expiry day), expiry-day flag and
    monthly-expiry flag (the last expiry of its calendar month)."""
    sessions = pd.DatetimeIndex(sorted(pd.to_datetime(dates.unique())))
    exp = expiry_dates(sessions)
    all_s = sessions.append(pd.bdate_range(sessions[-1] + pd.Timedelta(days=1), periods=15))
    pos = pd.Series(np.arange(len(all_s)), index=all_s)
    nxt = exp[np.minimum(exp.searchsorted(sessions), len(exp) - 1)]
    monthly = pd.Series(exp).groupby(exp.to_period("M")).transform("max").to_numpy() == exp.to_numpy()
    is_monthly = pd.Series(monthly, index=exp)
    per = pd.DataFrame({
        "days_to_expiry": pos.reindex(nxt).to_numpy() - pos.reindex(sessions).to_numpy(),
        "is_expiry_day": (nxt == sessions).astype(float),
        "is_monthly_expiry_week": is_monthly.reindex(nxt).to_numpy().astype(float),
    }, index=sessions)
    return per.reindex(pd.to_datetime(dates.to_numpy())).reset_index(drop=True)


def build_features(inputs: dict, groups: tuple[str, ...] = DRIVER_GROUPS) -> pd.DataFrame:
    """inputs: {"instrument": 1m bars, "banknifty": 1m, "vix": 1m, "heavyweights": {sid: 1m},
    "global_daily": {name: 1d}}. Missing entries → NaN driver columns. Returns one row per
    5m bar end (UTC index) with `date`, `mod`, `close` and all feature columns."""
    b = _annotate(to_5m(inputs.get("instrument")))
    price = price_features(b)
    parts = [b[["date", "mod", "close"]], price]
    if "banknifty" in groups:
        parts.append(banknifty_features(b, _annotate(to_5m(inputs.get("banknifty"))), price))
    if "vix" in groups:
        parts.append(vix_features(b, _annotate(to_5m(inputs.get("vix")))))
    if "heavyweights" in groups:
        eq = {s: to_5m(df) for s, df in (inputs.get("heavyweights") or {}).items()}
        parts.append(heavyweight_features(b, eq))
    if "global_daily" in groups:
        parts.append(global_daily_features(b, inputs.get("global_daily") or {}))
    out = pd.concat(parts, axis=1)
    feats = [c for c in out.columns if c != "date"]
    out[feats] = out[feats].astype("float64")
    return out


def feature_columns(df: pd.DataFrame, groups: tuple[str, ...] = DRIVER_GROUPS) -> list[str]:
    """Model columns for the given driver groups (price features always included)."""
    drop = {"date", "mod", "close"}
    excluded = tuple(p for g, p in GROUP_PREFIX.items() if g not in groups)
    return [c for c in df.columns if c not in drop and not (excluded and c.startswith(excluded))]


def load_inputs(root: Path, instrument: str = "NIFTY", start=None, end=None) -> dict:
    """Read every input from the parquet store. Absent series come back empty (→ NaN features)."""
    def m1(sid):
        return read_bars(root, sid, "1m", start, end)
    gstart = None if start is None else pd.Timestamp(start) - pd.Timedelta(days=30)
    return {
        "instrument": m1(instrument),
        "banknifty": m1(BANKNIFTY),
        "vix": m1(VIX),
        "heavyweights": {s: m1(s) for s in HEAVYWEIGHTS},
        "global_daily": {n: read_bars(root, sid, "1d", gstart, end) for n, sid in GLOBAL_DAILY.items()},
    }
