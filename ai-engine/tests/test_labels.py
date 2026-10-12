from datetime import datetime, timedelta, timezone

import pytest

from src.scorer import labels

AFTER = labels.LOSS_CUT_FLAT_INR_BEFORE + timedelta(days=3)
BEFORE = labels.LOSS_CUT_FLAT_INR_BEFORE - timedelta(days=3)


def _label(**over):
    kw = dict(gross_pnl=100.0, fees=20.0, entry_price=500.0, qty=100, entered_at=AFTER,
              exited_at=AFTER + timedelta(minutes=90), stop_price=None, risk_amount=None)
    kw.update(over)
    return labels.label(**kw)


def test_change_date_is_tz_aware_utc():
    assert labels.LOSS_CUT_FLAT_INR_BEFORE.tzinfo is not None


def test_win_is_net_of_fees():
    o = _label(gross_pnl=100.0, fees=150.0)
    assert o.net_pnl == pytest.approx(-50.0)
    assert o.win is False
    assert _label(gross_pnl=200.0, fees=150.0).win is True


def test_stored_stop_gives_non_derived_r():
    o = _label(stop_price=495.0, gross_pnl=1000.0, fees=0.0)
    # risk = |500-495| * 100 = 500
    assert o.r_multiple == pytest.approx(2.0)
    assert o.r_derived is False


def test_adaptive_risk_amount_wins():
    o = _label(risk_amount=250.0, stop_price=495.0, gross_pnl=500.0, fees=0.0)
    assert o.r_multiple == pytest.approx(2.0)
    assert o.r_derived is False


def test_no_stop_after_change_uses_pct_of_notional():
    o = _label(gross_pnl=400.0, fees=0.0)
    # 0.4% of 500*100 = 200
    assert o.r_multiple == pytest.approx(2.0)
    assert o.r_derived is True


def test_no_stop_before_change_uses_flat_1000():
    o = _label(gross_pnl=500.0, fees=0.0, entered_at=BEFORE, exited_at=BEFORE + timedelta(hours=1))
    assert o.r_multiple == pytest.approx(0.5)
    assert o.r_derived is True


def test_zero_risk_gives_none():
    o = _label(stop_price=500.0)
    assert o.r_multiple is None
    o2 = _label(risk_amount=0.0)
    assert o2.r_multiple is None


def test_fees_none_treated_as_zero():
    o = _label(fees=None, gross_pnl=10.0)
    assert o.fees == 0.0 and o.net_pnl == 10.0 and o.win is True


def test_hold_and_excursions_carried():
    o = _label(mfe=12.0, mae=-3.0)
    assert o.hold_mins == pytest.approx(90.0)
    assert (o.mfe, o.mae) == (12.0, -3.0)
    assert _label(exited_at=None).hold_mins is None


def test_naive_datetimes_treated_as_utc():
    naive = AFTER.replace(tzinfo=None)
    o = _label(entered_at=naive, exited_at=naive + timedelta(minutes=5), gross_pnl=400.0, fees=0.0)
    assert o.r_multiple == pytest.approx(2.0)
    assert o.hold_mins == pytest.approx(5.0)
