"""MBM M4 stream A — Pattern Library discovery engine (synthetic data only)."""
import numpy as np
import pandas as pd

from src.mbm import patterns as PB

N = PB.SESSION_MINUTES


def _day(hi=None, lo=None, cl=None, base=100.0):
    h = np.full((1, N), base + 0.1)
    lo_ = np.full((1, N), base - 0.1)
    c = np.full((1, N), base)
    for arr, upd in ((h, hi), (lo_, lo), (c, cl)):
        for k, v in (upd or {}).items():
            arr[0, k] = v
    return h, lo_, c


def _one(h, lo, c, start=0, combos=PB.COMBOS, cost=3.0):
    net, hit = PB.trade_outcomes(np.array([100.0]), np.array([0]), np.array([start]), np.array([4.0]),
                                 h, lo, c, cost, combos=combos)
    return net[:, 0], hit[:, 0]


LONG = (("long", 0.25, 0.5),)
SHORT = (("short", 0.25, 0.5),)


def test_target_first_long():
    h, lo, c = _day(hi={5: 102.5})                    # target 102, stop 99
    net, hit = _one(h, lo, c, combos=LONG)
    assert hit[0] == 1 and np.isclose(net[0], 200 - 3)


def test_stop_first_long_and_short_mirror():
    h, lo, c = _day(lo={3: 98.9}, hi={5: 102.5})
    net, hit = _one(h, lo, c, combos=LONG)
    assert hit[0] == 0 and np.isclose(net[0], -100 - 3)
    # short: target 98, stop 101 -> stop at bar 5 (low 98.9 does not reach 98)
    net, hit = _one(h, lo, c, combos=SHORT)
    assert hit[0] == 0 and np.isclose(net[0], -100 - 3)


def test_same_bar_double_touch_is_stop():
    h, lo, c = _day(hi={4: 103.0}, lo={4: 98.0})
    for combos in (LONG, SHORT):
        net, hit = _one(h, lo, c, combos=combos)
        assert hit[0] == 0 and np.isclose(net[0], -100 - 3)


def test_session_end_exits_at_last_close_and_window_starts_at_entry():
    h, lo, c = _day(cl={N - 1: 100.5}, hi={2: 105.0})
    net, hit = _one(h, lo, c, start=10, combos=LONG)  # the bar at col 2 is before the window
    assert hit[0] == 0 and np.isclose(net[0], 50 - 3)
    c[0, N - 3:] = np.nan                               # missing tail bars -> last available close
    c[0, N - 4] = 100.2
    net, _ = _one(h, lo, c, start=N - 5, combos=SHORT)
    assert np.isclose(net[0], -20 - 3)


def test_nan_atr_gives_nan_outcome():
    h, lo, c = _day()
    net, hit = PB.trade_outcomes(np.array([100.0]), np.array([0]), np.array([0]), np.array([np.nan]),
                                 h, lo, c, 3.0)
    assert np.isnan(net).all() and np.isnan(hit).all()


def test_session_matrices_columns_and_session_end():
    ts = pd.date_range("2024-01-02 03:45", periods=N + 5, freq="1min", tz="UTC")  # 09:15 IST ..
    bars = pd.DataFrame({"ts": ts, "open": 1.0, "high": np.arange(N + 5) + 1.0, "low": 0.5,
                         "close": np.arange(N + 5) + 0.5, "volume": 1})
    days, hi, lo, cl = PB.session_matrices(bars)
    assert len(days) == 1 and str(days[0].date()) == "2024-01-02"
    assert hi[0, 0] == 1.0 and hi[0, N - 1] == N   # 15:29 bar kept, 15:30+ dropped


def test_first_per_day():
    day = np.array([0, 0, 0, 1, 1, 2, 2, 2])
    m = np.array([0, 1, 1, 0, 0, 1, 0, 1], bool)
    assert PB.first_per_day(m, day).tolist() == [1, 5]
    assert PB.first_per_day(np.zeros(8, bool), day).tolist() == []


def test_bins_fitted_on_discovery_only():
    x = np.r_[np.arange(100.0), np.full(100, 1e6)]
    disc = np.r_[np.ones(100, bool), np.zeros(100, bool)]
    X = pd.DataFrame({"f": x})
    conds, masks, edges = PB.build_conditions(X, disc)
    assert np.allclose(edges["f"], np.quantile(np.arange(100.0), [0.2, 0.4, 0.6, 0.8]))
    top = [i for i, c in enumerate(conds) if c.kind == "eq" and c.k == 4][0]
    assert masks[top][:100].sum() == 20 and masks[top][100:].all()
    assert len(conds) == 7  # 5 bins + <=1 + >=3


def test_null_permutation_keeps_day_structure():
    n_days, slots = 30, 4
    day = np.repeat(np.arange(n_days), slots)
    slot = np.tile(np.arange(slots) * 15 + 570, n_days)
    window = (day >= 20).astype(int)
    src = PB.day_permutation_index(day, slot, window, np.random.default_rng(1))
    assert (src >= 0).all()
    assert (slot[src] == slot).all()                               # same intraday slot
    for d in range(n_days):
        srcd = np.unique(day[src[day == d]])
        assert len(srcd) == 1 and window[src[day == d]][0] == window[day == d][0]
    mapped = [int(day[src[day == d]][0]) for d in range(n_days)]
    assert sorted(mapped) == list(range(n_days)) and mapped != list(range(n_days))
    # a missing slot on the source day -> -1 -> NaN outcome
    keep = ~((day == 3) & (slot == 570))
    src2 = PB.day_permutation_index(pd.factorize(day[keep])[0], slot[keep], window[keep], np.random.default_rng(1))
    out = PB.permute_outcomes(np.arange(keep.sum(), dtype=float)[None, :], src2)
    assert np.isnan(out).sum() == (src2 < 0).sum() == 1


def test_mine_finds_planted_rule_and_null_does_not():
    rng = np.random.default_rng(0)
    dates = pd.date_range("2016-10-03", "2025-06-30", freq="B")[::4]   # ~550 days spanning both windows
    slots = np.array([570, 600, 630])
    D = np.repeat(dates, len(slots))
    slot = np.tile(slots, len(dates))
    n = len(D)
    sig = rng.normal(size=n)
    X = pd.DataFrame({"sig": sig, "noise": rng.normal(size=n)})
    K = len(PB.COMBOS)
    net = rng.normal(0, 30, size=(K, n))
    hit = (rng.random((K, n)) < 0.4).astype(float)
    planted = sig > np.quantile(sig, 0.8)
    net[0, planted] += 40                                              # long 0.25/0.25 edge when sig is top bin
    net[0] -= net[0].mean()                    # zero base rate: an edge only the rule (not the day) carries
    res = PB.mine(X, pd.Series(D), slot, net, hit, n_perms=5, seed=3, top_pairs=5, log=lambda s: None)
    labels = [(r["label"], r["side"], r["stop_atr"], r["target_atr"]) for r in res.library]
    assert any("sig >=" in lab and side == "long" and st == 0.25 and tg == 0.25 for lab, side, st, tg in labels)
    assert res.counts["blind_survivors"] == len(res.library) > 0
    assert len(res.null["survivors_per_perm"]) == 5
    assert res.counts["blind_survivors"] > res.null["p95"] and res.null["significant"]
    r = res.library[0]
    assert set(r) >= {"id", "conditions", "side", "stop_atr", "target_atr", "discovery", "blind"}
    assert {"feature", "op", "value"} <= set(r["conditions"][0])
