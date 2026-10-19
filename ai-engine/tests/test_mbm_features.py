import numpy as np
import pandas as pd
import pytest

from src.mbm import features as F
from src.mbm import labels as L


def _bars_1m(days, seed, base=100.0, vol=True):
    rng = np.random.default_rng(seed)
    rows = []
    px = base
    for d in days:
        start = pd.Timestamp(d).tz_localize("Asia/Kolkata") + pd.Timedelta(hours=9, minutes=15)
        ts = pd.date_range(start, periods=375, freq="1min").tz_convert("UTC")
        steps = rng.normal(0, 0.0008, 375)
        close = px * np.exp(np.cumsum(steps))
        open_ = np.r_[px, close[:-1]]
        hi = np.maximum(open_, close) * (1 + rng.uniform(0, 0.0004, 375))
        lo = np.minimum(open_, close) * (1 - rng.uniform(0, 0.0004, 375))
        v = rng.integers(1000, 5000, 375) if vol else np.zeros(375, dtype=int)
        rows.append(pd.DataFrame({"ts": ts, "open": open_, "high": hi, "low": lo, "close": close,
                                  "volume": v, "oi": pd.NA}))
        px = close[-1] * (1 + rng.normal(0, 0.003))
    return pd.concat(rows, ignore_index=True)


def _daily(days, seed, label_hour=4):
    rng = np.random.default_rng(seed)
    cal = pd.date_range(pd.Timestamp(days[0]) - pd.Timedelta(days=10), pd.Timestamp(days[-1]), freq="D")
    c = 100 * np.exp(np.cumsum(rng.normal(0, 0.01, len(cal))))
    return pd.DataFrame({"ts": (cal + pd.Timedelta(hours=label_hour)).tz_localize("UTC"),
                         "open": c, "high": c * 1.01, "low": c * 0.99, "close": c, "volume": 0, "oi": pd.NA})


DAYS = list(pd.bdate_range("2024-01-01", periods=40))


def _inputs():
    return {
        "instrument": _bars_1m(DAYS, 1, 20000, vol=False),
        "banknifty": _bars_1m(DAYS, 2, 45000, vol=False),
        "vix": _bars_1m(DAYS, 3, 14, vol=False),
        "heavyweights": {s: _bars_1m(DAYS, 10 + i, 1000) for i, s in enumerate(F.HEAVYWEIGHTS)},
        "global_daily": {n: _daily(DAYS, 30 + i, 23 if n == "inr" else 4)
                         for i, n in enumerate(F.GLOBAL_DAILY)},
    }


def _perturb_after(inputs, cut):
    rng = np.random.default_rng(99)
    out = {}
    for k, v in inputs.items():
        if isinstance(v, dict):
            out[k] = _perturb_after(v, cut)
            continue
        v = v.copy()
        if k in F.GLOBAL_DAILY:     # a daily bar is "after t" if its trading date >= session date
            tdate = (v["ts"] + pd.Timedelta(hours=12)).dt.tz_localize(None).dt.normalize()
            sel = tdate >= cut.tz_convert("Asia/Kolkata").tz_localize(None).normalize()
        else:
            sel = v["ts"] >= cut
        k_ = rng.uniform(0.5, 1.5, int(sel.sum()))
        for c in ("open", "high", "low", "close"):
            v.loc[sel, c] = v.loc[sel, c] * k_
        if "volume" in v:
            v.loc[sel, "volume"] = (v.loc[sel, "volume"] * 3).astype(v["volume"].dtype)
        out[k] = v
    return out


@pytest.mark.parametrize("cut_local", ["2024-02-07 11:00", "2024-02-12 09:20", "2024-02-20 15:30"])
def test_features_at_t_ignore_data_after_t(cut_local):
    inp = _inputs()
    cut = pd.Timestamp(cut_local, tz="Asia/Kolkata").tz_convert("UTC")
    a = F.build_features(inp)
    b = F.build_features(_perturb_after(inp, cut))
    cols = F.feature_columns(a)
    pa, pb = a.loc[a.index <= cut, cols], b.loc[b.index <= cut, cols]
    pd.testing.assert_frame_equal(pa, pb, check_exact=False, rtol=1e-12)
    # and the perturbation really did change later rows (the test has teeth)
    later = a.index > cut
    if later.any():
        assert not a.loc[later, cols].equals(b.loc[later, cols])


def test_feature_set_and_groups_present():
    df = F.build_features(_inputs())
    cols = F.feature_columns(df)
    for prefix in F.GROUP_PREFIX.values():
        assert any(c.startswith(prefix) for c in cols)
    assert F.FEATURE_SET == "mbm-fs2"
    price_only = F.feature_columns(df, groups=())
    assert not any(c.startswith(tuple(F.GROUP_PREFIX.values())) for c in price_only)
    # late in the sample every group has real values
    tail = df.iloc[-10:]
    for prefix in F.GROUP_PREFIX.values():
        assert tail[[c for c in cols if c.startswith(prefix)]].notna().any().any(), prefix


def test_missing_drivers_give_nulls_not_errors():
    inp = _inputs()
    full = F.build_features(inp)
    bare = F.build_features({"instrument": inp["instrument"]})
    assert list(bare.columns) == list(full.columns)
    for prefix in F.GROUP_PREFIX.values():
        assert bare[[c for c in bare.columns if c.startswith(prefix)]].isna().all().all()
    # partial heavyweights still work
    inp["heavyweights"] = {"EQ_TCS": inp["heavyweights"]["EQ_TCS"]}
    part = F.build_features(inp)
    assert part["hw_wret_open"].notna().any()


def test_labels_window_and_trailing_threshold():
    inp = _inputs()
    f = F.build_features(inp)
    dec = f[f["mod"] % 15 == 0]
    atr = F.daily_context(F._annotate(F.to_5m(inp["instrument"])))["atr14"]
    lab = L.compute_labels(inp["instrument"], dec, atr)
    # 30m window at 15:15 would cross the close → NaN; rest at 15:15 = 15 minutes
    late = dec["mod"] == 15 * 60 + 15
    assert lab.loc[late, "range_pts_30m"].isna().all()
    assert lab.loc[late, "range_pts_rest"].notna().all()
    # hand-check one 30m label: window = 1m bars starting in [t, t+30)
    t = dec.index[dec["mod"] == 10 * 60][5]
    m = inp["instrument"]
    w = m[(m["ts"] >= t) & (m["ts"] < t + pd.Timedelta(minutes=30))]
    assert lab.loc[t, "range_pts_30m"] == pytest.approx(w["high"].max() - w["low"].min())
    # the last day has no next session
    last = dec["date"] == dec["date"].max()
    assert lab.loc[last, "range_pts_next"].isna().all()
    bl = L.big_labels(dec, lab, "30m", window=20)
    # threshold for day d only uses days < d: changing day d's own labels leaves it unchanged
    lab2 = lab.copy()
    d = dec["date"].unique()[30]
    lab2.loc[(dec["date"] >= d).values, "range_bp_30m"] *= 5
    bl2 = L.big_labels(dec, lab2, "30m", window=20)
    sel = (dec["date"] <= d).values
    np.testing.assert_array_equal(bl.loc[sel, "threshold_bp"].to_numpy(), bl2.loc[sel, "threshold_bp"].to_numpy())
    assert set(np.unique(bl["big"].dropna())) <= {0.0, 1.0}


def test_expiry_calendar_regimes_and_holiday_shift():
    sessions = pd.bdate_range("2018-01-01", "2026-10-30")
    sessions = sessions[sessions != pd.Timestamp("2023-03-30")]      # Ram Navami (Thursday)
    e = F.expiry_dates(sessions)
    assert pd.Timestamp("2018-01-25") in e and pd.Timestamp("2018-01-18") not in e   # monthly only
    assert pd.Timestamp("2023-03-29") in e and pd.Timestamp("2023-03-30") not in e   # holiday → prior session
    assert pd.Timestamp("2025-08-28") in e and pd.Timestamp("2025-09-02") in e       # Thu → Tue switch
    oct26 = pd.Series(pd.bdate_range("2026-10-01", "2026-10-30"))
    cal = F.expiry_calendar(oct26).set_index(oct26.dt.strftime("%m-%d"))
    assert cal.loc[["10-12", "10-13", "10-14", "10-27"], "days_to_expiry"].tolist() == [1, 0, 4, 0]
    assert cal.loc[["10-13", "10-27"], "is_monthly_expiry_week"].tolist() == [0.0, 1.0]
