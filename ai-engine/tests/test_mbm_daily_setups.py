"""MBM daily setups monitor: each detector on a hand-built daily series, no look-ahead, the outcome
filler, the 15:50 schedule + holiday skip, and the fail-open `dailySignals` on `/behaviour`."""
from datetime import date, datetime, timedelta

import numpy as np
import pandas as pd
import pytest

from src.mbm.service import clock, setups as S
from src.mbm.service.engine import Engine

IST = clock.IST


def ist(s: str) -> datetime:
    return datetime.fromisoformat(s).replace(tzinfo=IST)


def daily(rows, start="2025-01-01") -> pd.DataFrame:
    """rows: list of (open, high, low, close) → daily frame indexed by consecutive business dates."""
    idx = pd.Index([d.date() for d in pd.bdate_range(start, periods=len(rows))], name="date")
    return pd.DataFrame(rows, columns=S.DAILY_COLUMNS, index=idx, dtype="float64")


def flat(n, px=100.0, rng=1.0):
    return [(px, px + rng, px - rng, px)] * n


def fired(d, i=-1) -> set[str]:
    return {s["setup"] for s in S.detect(d, i)}


def actions(d, i=-1) -> dict[str, str]:
    return {s["setup"]: s["action"] for s in S.detect(d, i)}


# ------------------------------------------------------------------ detectors

def test_ribbon_up_macd_green_and_trend_and_breakout_on_first_up_day():
    # Flat at 100 ⇒ every EMA = 100. One close at 101: EMA10 > EMA30 and EMA12 > EMA26 for the
    # first time, MACD hist = 0.8·MACD > 0, close > EMA200 (≈100), close > SMA20 + 2·std20 (≈100.5).
    # Wide flat ranges (ATR ≈ 5.7) keep the up day's low 3.5 away from the 20-day low ⇒ no retest.
    d = daily(flat(250, rng=3.0) + [(100.6, 101.2, 100.5, 101.0)])
    assert fired(d, -2) == set()
    got = actions(d)
    assert got == {
        "RIBBON_UP_MACD_GREEN_10_30": S.LONG, "RIBBON_UP_MACD_GREEN_12_26": S.LONG,
        "RIBBON_UP_TREND_10_30": S.LONG, "RIBBON_UP_TREND_12_26": S.LONG,
        "BB_BREAKOUT_UP": S.LONG,
    }
    det = {s["setup"]: s["details"] for s in S.detect(d)}["RIBBON_UP_MACD_GREEN_10_30"]
    assert det["ema10"] > det["ema30"] and det["prev_ema10"] == det["prev_ema30"] and det["hist"] > 0


def test_detectors_match_a_vectorised_oracle():
    """Every setup on every day of a random series equals the definition written out in pandas."""
    d = _random_daily(600, seed=3)
    o, h, l, c = (d[k] for k in S.DAILY_COLUMNS)
    e = {n: c.ewm(span=n, adjust=False).mean() for n in (10, 12, 26, 30, 200)}
    macd = e[12] - e[26]
    hist = macd - macd.ewm(span=9, adjust=False).mean()
    pc = c.shift(1)
    tr = pd.concat([h - l, (h - pc).abs(), (l - pc).abs()], axis=1).max(axis=1)
    atr = tr.rolling(14).mean()
    ref = l.rolling(20).min().shift(3)
    sma, sd = c.rolling(20).mean(), c.rolling(20).std()
    want = {}
    for f, s_ in ((10, 30), (12, 26)):
        up = (e[f] > e[s_]) & (e[f].shift(1) <= e[s_].shift(1))
        dn = (e[f] < e[s_]) & (e[f].shift(1) >= e[s_].shift(1))
        want[f"RIBBON_UP_MACD_GREEN_{f}_{s_}"] = up & (hist > 0)
        want[f"RIBBON_UP_TREND_{f}_{s_}"] = up & (c > e[200])
        want[f"RIBBON_DOWN_MACD_RED_{f}_{s_}"] = dn & (hist < 0)
    want["RETEST_20D_LOW_REBOUND"] = ((l - ref).abs() <= 0.5 * atr) & (c > o) & (c > pc) & (c > ref)
    want["BB_LOWER_TOUCH_UPTREND"] = (l < sma - 2 * sd) & (c > e[200])
    want["BB_BREAKOUT_UP"] = c > sma + 2 * sd
    want["GAP_DOWN_REVERSAL"] = (o / pc - 1 < -0.004) & (c > o)
    for i in range(1, len(d)):
        exp = {k for k, v in want.items() if bool(v.iloc[i])}
        assert fired(d, i) == exp, d.index[i]
    assert all(v.sum() > 0 for v in want.values()), {k: int(v.sum()) for k, v in want.items()}


def test_ribbon_down_macd_red_is_exit_never_short():
    d = daily(flat(250) + [(100.0, 100.1, 98.8, 99.0)])
    got = actions(d)
    assert got == {"RIBBON_DOWN_MACD_RED_10_30": S.EXIT, "RIBBON_DOWN_MACD_RED_12_26": S.EXIT}
    assert all(a in (S.LONG, S.EXIT) for a in got.values())


def test_retest_20d_low_rebound():
    # ATR = 2 (H−L = 2 daily). Lowest low 95 sits 10 sessions back (inside the 20 sessions ending t−3).
    rows = flat(40) + [(97, 98, 95, 97)] + flat(9)
    up = (96.0, 97.5, 95.5, 97.2)            # near the low and green, but below the previous close
    d = daily(rows + [up])
    assert "RETEST_20D_LOW_REBOUND" not in fired(d)     # close 97.2 < previous close 100
    rows2 = flat(40, 100) + [(97, 98, 95, 97)] + flat(9, 96)
    good = (96.0, 97.5, 95.5, 97.2)                     # > open 96, > prev close 96, > 95
    d2 = daily(rows2 + [good])
    det = {s["setup"]: s for s in S.detect(d2)}
    assert "RETEST_20D_LOW_REBOUND" in det and det["RETEST_20D_LOW_REBOUND"]["action"] == S.LONG
    assert det["RETEST_20D_LOW_REBOUND"]["details"]["ref_low20"] == 95
    red = (97.3, 97.5, 95.5, 97.2)                      # close < open ⇒ no
    assert "RETEST_20D_LOW_REBOUND" not in fired(daily(rows2 + [red]))
    far = (96.0, 97.5, 96.5, 97.2)                      # low 1.5 above 95 > 0.5·ATR ⇒ no
    assert "RETEST_20D_LOW_REBOUND" not in fired(daily(rows2 + [far]))


def test_retest_reference_is_the_20_sessions_ending_3_sessions_earlier():
    dip = (97.0, 98.0, 95.0, 97.0)
    today = (100.0, 100.5, 99.5, 100.2)
    three_back = daily(flat(40) + [dip] + flat(2) + [today])     # dip at t−3: inside the window
    two_back = daily(flat(40) + [dip] + flat(1) + [today])       # dip at t−2: excluded
    old = daily(flat(40) + [dip] + flat(20) + [today])           # dip at t−21: inside (t−22..t−3)
    too_old = daily(flat(40) + [dip] + flat(22) + [today])       # dip at t−23: outside
    ref = lambda d: S.indicators(d).iloc[-1]["ref_low20"]
    assert (ref(three_back), ref(two_back), ref(old), ref(too_old)) == (95.0, 99.0, 95.0, 99.0)


def test_bb_lower_touch_needs_uptrend():
    up = [(100 + i * 0.4 - 0.2, 100 + i * 0.4 + 0.5, 100 + i * 0.4 - 0.5, 100 + i * 0.4) for i in range(250)]
    c = up[-1][3] + 0.4
    spike = (c, c + 0.5, c - 10, c)                      # wick far below the lower band, close in trend
    d = daily(up + [spike])
    x = S.indicators(d).iloc[-1]
    assert spike[2] < x["sma20"] - 2 * x["std20"] and c > x["ema200"]
    assert actions(d).get("BB_LOWER_TOUCH_UPTREND") == S.LONG
    down = [(o, h, l, cl) for (o, h, l, cl) in [(200 - i * 0.4 + 0.2, 200 - i * 0.4 + 0.5, 200 - i * 0.4 - 0.5,
                                                  200 - i * 0.4) for i in range(250)]]
    c = down[-1][3] - 0.4
    d2 = daily(down + [(c, c + 0.5, c - 10, c)])
    assert "BB_LOWER_TOUCH_UPTREND" not in fired(d2)     # close < EMA200


def test_bb_breakout_up_only_above_upper_band():
    d = daily(flat(30) + [(100.0, 100.5, 99.9, 100.3)])  # upper ≈ 100.05 + 2·0.067 ≈ 100.18 → fires
    x = S.indicators(d).iloc[-1]
    assert 100.3 > x["sma20"] + 2 * x["std20"]
    assert "BB_BREAKOUT_UP" in fired(d)
    d2 = daily(flat(19) + [(100, 103, 99, 102)] * 1 + flat(10) + [(100.0, 100.5, 99.9, 100.3)])
    x2 = S.indicators(d2).iloc[-1]
    assert 100.3 < x2["sma20"] + 2 * x2["std20"]
    assert "BB_BREAKOUT_UP" not in fired(d2)


def test_bb_std_is_pandas_rolling_std():
    d = daily(flat(19) + [(100, 103, 99, 102)])
    assert S.indicators(d).iloc[-1]["std20"] == pytest.approx(d["close"].std())   # ddof=1


def test_gap_down_reversal():
    d = daily(flat(5) + [(99.5, 100.0, 99.4, 99.8)])     # −0.5 % gap, green
    assert actions(d).get("GAP_DOWN_REVERSAL") == S.LONG
    assert "GAP_DOWN_REVERSAL" not in fired(daily(flat(5) + [(99.7, 100.0, 99.6, 99.9)]))   # −0.3 %
    assert "GAP_DOWN_REVERSAL" not in fired(daily(flat(5) + [(99.5, 99.6, 99.0, 99.2)]))    # red


# ------------------------------------------------------------------ no look-ahead

def _random_daily(n=320, seed=7):
    r = np.random.default_rng(seed)
    c = 100 * np.exp(np.cumsum(r.normal(0, 0.012, n)))
    o = np.r_[c[0], c[:-1]] * (1 + r.normal(0, 0.004, n))
    h = np.maximum(o, c) * (1 + np.abs(r.normal(0, 0.004, n)))
    l = np.minimum(o, c) * (1 - np.abs(r.normal(0, 0.004, n)))
    return daily(list(zip(o, h, l, c)))


def test_signal_on_day_t_uses_rows_up_to_t_only():
    d = _random_daily()
    seen = 0
    for i in range(60, len(d) - 5):
        full = S.detect(d, i)
        assert full == S.detect(d.iloc[: i + 1])
        future = d.copy()
        future.iloc[i + 1:, :] = future.iloc[i + 1:, :] * 3.0   # wreck the future
        assert full == S.detect(future, i)
        seen += len(full)
    assert seen > 0


# ------------------------------------------------------------------ outcomes

def test_outcome_returns_next_open_to_close_n_sessions_later():
    rows = [(100 + i, 101 + i, 99 + i, 100.5 + i) for i in range(30)]
    d = daily(rows)
    sd = d.index[2]
    r = S.outcome_returns(d, sd)
    entry = d["open"].iloc[3]
    assert r == {n: round((d["close"].iloc[2 + n] / entry - 1) * 1e4, 2) for n in (5, 10, 20)}
    assert S.outcome_returns(d, d.index[-1]) == {}
    assert set(S.outcome_returns(d, d.index[-8])) == {5}


def test_fill_rows_partial_then_complete():
    rows = [(100 + i, 101 + i, 99 + i, 100.5 + i) for i in range(32)]
    d = daily(rows)
    at = ist("2025-02-20T15:50:00")
    pend = [{"id": 1, "signal_date": d.index[10], "ret_5d_bp": None, "ret_10d_bp": None, "ret_20d_bp": None}]
    part = S.fill_rows(pend, d.iloc[:22], at)            # t+10 = idx 20 present, t+20 not
    assert part[0]["ret_5d_bp"] is not None and part[0]["ret_10d_bp"] is not None
    assert part[0]["ret_20d_bp"] is None and part[0]["at"] is None
    pend[0].update({k: part[0][k] for k in ("ret_5d_bp", "ret_10d_bp")})
    assert S.fill_rows(pend, d.iloc[:22], at) == []       # nothing new ⇒ no write
    full = S.fill_rows(pend, d, at)
    assert full[0]["ret_20d_bp"] is not None and full[0]["at"] == at
    assert full[0]["ret_5d_bp"] == part[0]["ret_5d_bp"]


# ------------------------------------------------------------------ daily series + schedule

def _bars_1m(day: str, px=100.0, n=375, series="NIFTY"):
    ts = pd.date_range(ist(f"{day}T09:15:00"), periods=n, freq="1min").tz_convert("UTC")
    c = px + np.arange(n) * 0.01
    return pd.DataFrame({"series": series, "ts": ts, "open": c - 0.005, "high": c + 0.05,
                         "low": c - 0.05, "close": c, "volume": 0.0})


def test_session_from_1m_and_build_daily_prefers_yahoo():
    b = _bars_1m("2026-10-20")
    s = S.session_from_1m(b, date(2026, 10, 20))
    assert s["open"] == b["open"].iloc[0] and s["close"] == b["close"].iloc[-1]
    assert s["high"] == b["high"].max() and s["low"] == b["low"].min()
    y = pd.DataFrame({"ts": pd.to_datetime(["2026-10-19T03:45:00Z"]), "open": [1.0], "high": [2.0],
                      "low": [0.5], "close": [1.5], "volume": [0]})
    d = S.build_daily(y, b, date(2026, 10, 20))
    assert list(d.index) == [date(2026, 10, 19), date(2026, 10, 20)] and d["close"].iloc[-1] == s["close"]
    y2 = pd.concat([y, y.assign(ts=pd.to_datetime(["2026-10-20T03:45:00Z"]), close=[9.0])])
    assert S.build_daily(y2, b, date(2026, 10, 20))["close"].iloc[-1] == 9.0


def test_next_daily_setups_is_1550_weekdays():
    assert clock.next_daily_setups(ist("2026-10-20T10:00:00")) == ist("2026-10-20T15:50:00")
    assert clock.next_daily_setups(ist("2026-10-20T15:50:00")) == ist("2026-10-21T15:50:00")
    assert clock.next_daily_setups(ist("2026-10-23T16:00:00")) == ist("2026-10-26T15:50:00")  # Fri → Mon


class DailyRepo:
    def __init__(self, bars):
        self.df, self.signals, self.next_id, self.fail_read = bars, {}, 1, False

    def bars(self, series, start, end):
        d = self.df
        m = d["series"].isin(series) & (d["ts"] >= pd.Timestamp(start)) & (d["ts"] < pd.Timestamp(end))
        return d[m].reset_index(drop=True)

    def upsert_daily_signals(self, rows):
        for r in rows:
            k = (r["instrument"], r["signal_date"], r["setup"])
            if k not in self.signals:
                self.signals[k] = {"id": self.next_id, "ret_5d_bp": None, "ret_10d_bp": None,
                                   "ret_20d_bp": None, "outcome_at": None}
                self.next_id += 1
            self.signals[k].update(r)

    def pending_daily_outcomes(self, instrument):
        return [dict(v) for k, v in self.signals.items() if k[0] == instrument and v["outcome_at"] is None]

    def write_daily_outcomes(self, rows):
        by_id = {v["id"]: v for v in self.signals.values()}
        for r in rows:
            v = by_id[r["id"]]
            for n in (5, 10, 20):
                if v[f"ret_{n}d_bp"] is None:
                    v[f"ret_{n}d_bp"] = r[f"ret_{n}d_bp"]
            v["outcome_at"] = r["at"]

    def recent_daily_signals(self, instrument, since):
        if self.fail_read:
            raise RuntimeError("db down")
        return sorted([{"signal_date": k[1], "setup": k[2], "action": v["action"]}
                       for k, v in self.signals.items() if k[0] == instrument and k[1] >= since],
                      key=lambda r: (r["signal_date"], r["setup"]), reverse=True)


def _yahoo_history(end: str, n=260):
    """n flat sessions at 100 before `end` (exclusive), Yahoo-shaped (ts 09:15 IST in UTC)."""
    days = pd.bdate_range(end=pd.Timestamp(end) - pd.Timedelta(days=1), periods=n)
    ts = [pd.Timestamp(f"{d.date()}T03:45:00Z") for d in days]
    return pd.DataFrame({"ts": ts, "open": 100.0, "high": 101.0, "low": 99.0, "close": 100.0, "volume": 0})


def _setups_engine(repo, now, yahoo):
    return Engine(repo=repo, models_dir=None, instruments=["NIFTY"], now=lambda: now,
                  fetch_index_daily=lambda _n: yahoo)


def test_run_daily_setups_detects_today_from_1m_bars():
    b = _bars_1m("2026-10-20", px=100.5, n=375)            # closes ≈ 104.24 vs flat 100 ⇒ up-cross
    repo = DailyRepo(b)
    res = _setups_engine(repo, ist("2026-10-20T15:50:00"), _yahoo_history("2026-10-20")).run_daily_setups()
    got = {k[2] for k in repo.signals}
    assert res["signals"] == len(got) and "RIBBON_UP_MACD_GREEN_10_30" in got
    assert all(k[1] == date(2026, 10, 20) for k in repo.signals)


def test_run_daily_setups_skips_holiday():
    repo = DailyRepo(_bars_1m("2026-10-19", px=100.5))      # bars only for yesterday; today is a holiday
    res = _setups_engine(repo, ist("2026-10-20T15:50:00"), _yahoo_history("2026-10-20")).run_daily_setups()
    assert res["signals"] == 0 and repo.signals == {}


def test_run_daily_setups_fills_outcomes():
    y = _yahoo_history("2026-10-20", n=260)
    repo = DailyRepo(_bars_1m("2026-10-20", px=100.0))
    sd = pd.Timestamp(y["ts"].iloc[-25]).tz_convert(IST).date()
    repo.upsert_daily_signals([{"instrument": "NIFTY", "signal_date": sd, "setup": "BB_BREAKOUT_UP",
                                "action": S.LONG, "close": 100.0, "details": {}}])
    res = _setups_engine(repo, ist("2026-10-20T15:50:00"), y).run_daily_setups()
    row = next(iter(repo.signals.values()))
    assert res["outcomes"] == 1 and row["ret_5d_bp"] == 0.0 and row["outcome_at"] is not None


def test_behaviour_daily_signals_fail_open():
    repo = DailyRepo(_bars_1m("2026-10-20"))
    repo.upsert_daily_signals([
        {"instrument": "NIFTY", "signal_date": date(2026, 10, 19), "setup": "GAP_DOWN_REVERSAL",
         "action": S.LONG, "close": 1.0, "details": {}},
        {"instrument": "NIFTY", "signal_date": date(2026, 10, 1), "setup": "BB_BREAKOUT_UP",
         "action": S.LONG, "close": 1.0, "details": {}}])
    e = _setups_engine(repo, ist("2026-10-20T20:00:00"), None)
    out = e.behaviour("nifty")
    assert out["status"] == "absent"
    assert out["dailySignals"] == [{"setup": "GAP_DOWN_REVERSAL", "action": S.LONG, "date": "2026-10-19"}]
    repo.fail_read = True
    assert e.behaviour("NIFTY")["dailySignals"] == []
    assert Engine(repo=None, models_dir=None, instruments=["NIFTY"], now=lambda: ist("2026-10-20T20:00:00")
                  ).behaviour("NIFTY")["dailySignals"] == []


def test_last_sessions_since_counts_weekdays():
    assert S.last_sessions_since(date(2026, 10, 20)) == date(2026, 10, 14)   # Tue → previous Wed
