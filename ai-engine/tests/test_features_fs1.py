from datetime import datetime, timezone

import pytest

from src.scorer import features_fs1 as fs1

V15_NAMES = [
    "ADX trend strength", "ATR target feasibility", "EMA9 over EMA20", "Index aligned",
    "MACD on 1d", "MACD on 1m", "MACD on 5m", "Multi-day breakout confirmation",
    "Relative strength", "RSI on 5m", "Sector aligned", "S/R room", "SuperTrend match",
    "Volume confirmation", "VWAP relationship",
]
V10_NAMES = [
    "Index aligned", "MACD on 1d", "MACD on 1m", "MACD on 5m", "Price vs 20-EMA",
    "Relative strength", "Sector aligned", "S/R room", "SuperTrend match", "Volume confirmation",
]
V10_ONLY_ABSENT = {"adx", "atr_pct", "ema9_vs_ema20", "breakout_20d", "rsi_5m", "vwap_gap"}


def _check(name, passed=True, detail=None):
    return {"name": name, "passed": passed, "points": 5, "pointsPossible": 5, "detail": detail or {"value": 1.5}}


def _ctx(**over):
    ctx = {
        "decided_at": datetime(2026, 6, 1, 4, 0, tzinfo=timezone.utc),
        "direction": "LONG",
        "strategy": "gated",
        "initial_price": 100.0,
        "profit_target": 102.0,
        "profit_target_source": "fallback-2pct",
        "vix_at_entry": 14.2,
        "vix_regime": "NORMAL",
        "ad_ratio": 1.3,
    }
    ctx.update(over)
    return ctx


def test_15_check_breakdown_sets_all_v15_checks():
    feats, missing = fs1.extract({"checks": [_check(n) for n in V15_NAMES]}, _ctx())
    for name in V15_NAMES:
        key = fs1.CHECK_ALIASES[name]
        assert feats[f"{key}_passed"] == 1
        assert feats[f"{key}_missing"] == 0
    assert feats["scoring_v15"] == 1
    assert missing == ["price_vs_ema20"]


def test_10_check_breakdown_flags_absent_checks():
    feats, missing = fs1.extract({"checks": [_check(n) for n in V10_NAMES]}, _ctx())
    assert feats["scoring_v15"] == 0
    assert set(missing) == V10_ONLY_ABSENT
    for key in V10_ONLY_ABSENT:
        assert feats[f"{key}_missing"] == 1
        assert feats[f"{key}_passed"] is None
        assert feats[f"{key}_value"] is None
    assert feats["price_vs_ema20_missing"] == 0


def test_insufficient_detail_is_missing():
    bd = {"checks": [_check("SuperTrend match", passed=False, detail={"reason": "insufficient candles"})]}
    feats, missing = fs1.extract(bd, _ctx())
    assert feats["supertrend_missing"] == 1
    assert feats["supertrend_value"] is None
    assert "supertrend" in missing


def test_no_data_reasons_are_missing_but_full_room_is_not():
    bd = {"checks": [
        _check("Sector aligned", passed=False, detail={"reason": "no sector mapping"}),
        _check("S/R room", passed=True, detail={"reason": "no opposing S/R within snapshot — full room"}),
    ]}
    feats, _ = fs1.extract(bd, _ctx())
    assert feats["sector_trend_missing"] == 1
    assert feats["sr_room_missing"] == 0
    assert feats["sr_room_passed"] == 1
    assert feats["sr_room_value"] is None


def test_unknown_check_name_is_ignored():
    bd = {"checks": [_check("Some future check"), _check("RSI on 5m", detail={"rsi": 61.2})]}
    feats, _ = fs1.extract(bd, _ctx())
    assert list(feats.keys()) == fs1.feature_names()
    assert feats["rsi_5m_value"] == pytest.approx(61.2)


@pytest.mark.parametrize("bd", [None, {}, {"checks": None}, {"checks": "garbage"}, {"checks": [None, 3, {"x": 1}]}])
def test_null_or_malformed_breakdown_all_missing(bd):
    feats, missing = fs1.extract(bd, _ctx())
    assert set(missing) == set(fs1.CHECKS)
    assert all(feats[f"{k}_missing"] == 1 for k in fs1.CHECKS)


def test_feature_names_stable_and_match_extract_order():
    assert fs1.feature_names() == fs1.feature_names()
    feats, _ = fs1.extract({"checks": [_check(n) for n in V15_NAMES]}, _ctx())
    assert list(feats.keys()) == fs1.feature_names()


def test_leakage_in_context_raises():
    with pytest.raises(ValueError):
        fs1.extract(None, _ctx(maxFavorable=12.0))
    with pytest.raises(ValueError):
        fs1.extract(None, _ctx(currentPrice=101.0))


def test_minute_of_session_ist():
    feats, _ = fs1.extract(None, _ctx())
    assert feats["minute_of_session"] == 15
    assert feats["weekday"] == 0  # 2026-06-01 is a Monday
    feats2, _ = fs1.extract(None, _ctx(decided_at="2026-06-01T04:00:00Z"))
    assert feats2["minute_of_session"] == 15


def test_initial_score_never_a_feature():
    names = fs1.feature_names()
    assert not any("initialscore" in n.lower().replace("_", "") for n in names)
    assert not any(n.startswith("score") for n in names)


def test_value_parsing_variants():
    assert fs1.parse_value("RSI 61.2") == pytest.approx(61.2)
    assert fs1.parse_value(3) == 3.0
    assert fs1.parse_value({"value": "7.5"}) == pytest.approx(7.5)
    assert fs1.parse_value("no number") is None
    assert fs1.parse_value(None) is None


def test_real_detail_shapes_give_relative_values():
    bd = {"checks": [
        _check("MACD on 5m", detail={"macd": 0.6, "signal": 0.4, "aboveZero": True, "belowZero": False}),
        _check("VWAP relationship", detail={"vwap": 100.0, "entryPrice": 101.0, "sessionBars": 64}),
        _check("EMA9 over EMA20", detail={"ema9": 202.0, "ema20": 200.0}),
        _check("ATR target feasibility", detail={"atr": 3.4, "atrPct": 0.0102}),
        _check("Index aligned", detail={"emaNow": 101.0, "emaThen": 100.0, "closeLast": 101.5, "niftyTrend": "UP"}),
    ]}
    feats, _ = fs1.extract(bd, _ctx(initial_price=100.0))
    assert feats["macd_5m_value"] == pytest.approx(0.2)  # (macd-signal)/price*100
    assert feats["vwap_gap_value"] == pytest.approx(0.01)
    assert feats["ema9_vs_ema20_value"] == pytest.approx(0.01)
    assert feats["atr_pct_value"] == pytest.approx(0.0102)
    assert feats["nifty_trend_value"] == pytest.approx(0.01)


def test_context_one_hots_and_flags():
    feats, _ = fs1.extract(None, _ctx(vix_regime="ELEVATED", strategy="adaptive", direction="SHORT",
                                      profit_target_source="indicator-sr", vix_at_entry=None, ad_ratio=None))
    assert feats["vix_regime_elevated"] == 1 and feats["vix_regime_normal"] == 0
    assert feats["strategy_adaptive"] == 1 and feats["strategy_gated"] == 0
    assert feats["direction_long"] == 0
    assert feats["target_src_indicator_sr"] == 1 and feats["target_src_fallback"] == 0
    assert feats["vix_missing"] == 1 and feats["vix_at_entry"] is None
    assert feats["ad_missing"] == 1
    assert feats["target_pct"] == pytest.approx(0.02)
