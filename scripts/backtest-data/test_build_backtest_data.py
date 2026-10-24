"""Normalisation tests on tiny in-memory fixtures (no research files needed).

Run:  py -3 -m pytest scripts/backtest-data/test_build_backtest_data.py -q
"""
import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_backtest_data as b  # noqa: E402


def _bars(utc_times, start=100.0):
    ts = pd.to_datetime(utc_times, utc=True)
    n = len(ts)
    px = start + np.arange(n, dtype=float)
    return pd.DataFrame({"ts": ts, "open": px, "high": px + 0.5, "low": px - 0.5, "close": px + 0.25,
                         "volume": np.full(n, 10, dtype="int64"), "oi": pd.array([pd.NA] * n, dtype="Int64")})


def test_intraday_1m_keeps_only_regular_session_and_utc_start():
    # 03:44Z = 09:14 IST (pre-open, dropped); 03:45Z = 09:15 IST (kept); 09:59Z = 15:29 IST (kept);
    # 10:00Z = 15:30 IST (closing session, dropped); 12:30Z = 18:00 IST muhurat (dropped).
    df = _bars(["2024-01-02T03:44:00Z", "2024-01-02T03:45:00Z", "2024-01-02T09:59:00Z",
                "2024-01-02T10:00:00Z", "2024-01-02T12:30:00Z"])
    out = b.normalise_intraday(df, 1)
    assert list(b.fmt_ts(out.ts)) == ["2024-01-02T03:45:00Z", "2024-01-02T09:59:00Z"]
    assert out.oi.isna().all()
    assert out.volume.tolist() == [10.0, 10.0]


def test_intraday_15m_rollup_anchored_at_0915_ist():
    # 09:15..09:31 IST: 17 one-minute bars -> buckets 09:15 (15 bars) and 09:30 (2 bars).
    times = pd.date_range("2024-01-02T03:45:00Z", periods=17, freq="1min")
    df = _bars(times)
    out = b.normalise_intraday(df, 15)
    assert list(b.fmt_ts(out.ts)) == ["2024-01-02T03:45:00Z", "2024-01-02T04:00:00Z"]
    first = out.iloc[0]
    assert first.open == 100.0 and first.close == 114.25
    assert first.high == 114.5 and first.low == 99.5
    assert first.volume == 150.0
    assert out.iloc[1].open == 115.0


def test_intraday_duplicate_minutes_keep_last():
    df = _bars(["2024-01-02T03:45:00Z", "2024-01-02T03:45:00Z"])
    out = b.normalise_intraday(df, 1)
    assert len(out) == 1 and out.iloc[0].open == 101.0


def test_daily_stamped_at_ist_session_open_in_utc():
    df = pd.DataFrame({"date": pd.to_datetime(["2024-01-02", "2024-01-03", "2024-01-04"]),
                       "open": [1.0, 2.0, np.nan], "high": [1.5, 2.5, 3.5], "low": [0.5, 1.5, 2.5],
                       "close": [1.2, 2.2, 3.2], "volume": [5, 6, 7]})
    out = b.normalise_daily(df)
    assert list(b.fmt_ts(out.ts)) == ["2024-01-02T03:45:00Z", "2024-01-03T03:45:00Z"]  # NaN open dropped
    assert out.volume.tolist() == [5.0, 6.0]


def test_front_month_continuous_rolls_after_expiry_day():
    d = pd.to_datetime
    fut = pd.DataFrame({
        "date": d(["2024-01-25", "2024-01-25", "2024-01-26", "2024-01-26"]),
        "expiry": d(["2024-01-25", "2024-02-29", "2024-02-29", "2024-03-28"]),
        "open": [1.0, 2.0, 3.0, 4.0], "high": [1.0, 2.0, 3.0, 4.0], "low": [1.0, 2.0, 3.0, 4.0],
        "close": [1.0, 2.0, 3.0, 4.0], "contracts": [10, 20, 30, 40], "oi": [100, 200, 300, 400],
    })
    out = b.front_month_continuous(fut)
    assert out.close.tolist() == [1.0, 3.0]  # expiring contract on its expiry day, then the next
    assert out.oi.tolist() == [100, 300]


def test_option_band_filter_strikes_expiries_and_oi():
    d = pd.to_datetime
    day = d("2024-01-02")
    rows = []
    for exp in ["2024-01-04", "2024-01-11", "2024-01-18", "2024-01-25"]:
        for strike in [17000, 19000, 21000, 23500]:
            rows.append({"date": day, "expiry": d(exp), "strike": float(strike), "oi": 5})
    rows.append({"date": day, "expiry": d("2024-01-04"), "strike": 21050.0, "oi": 0})  # no OI
    opt = pd.DataFrame(rows)
    out = b.option_band_filter(opt, pd.Series({day: 21000.0}))
    # +-10 % of 21000 = 18900..23100: 19000 and 21000 kept; nearest 3 expiries only; OI 0 dropped.
    assert sorted(out.strike.unique().tolist()) == [19000.0, 21000.0]
    assert out.expiry.nunique() == 3
    assert len(out) == 6


def test_interval_labels():
    assert [b.interval_label(m) for m in (1, 5, 15, 60, 1440)] == ["1m", "5m", "15m", "1h", "1d"]
