"""MBM relative reading (q50 vs the last 10 sessions' realised range at the same minute) and the
stale-bar retry. No Postgres: the engine runs on `FakeRepo` from test_mbm_service."""
from datetime import timedelta

import numpy as np
import pandas as pd
import pytest

from src.mbm import relative as R
from src.mbm.service import engine as E
from src.mbm.service.repo import UPSERT_PREDICTION_SQL, PgRepo
from tests.test_mbm_service import (AS_OF, DAYS, IST, FakeRepo, StubModel, _engine, _expected_range_bp, _loaded,
                                    _nifty_only, gdaily, table)  # noqa: F401  (fixtures)


# ---------------------------------------------------------------- ratio / label maths

@pytest.mark.parametrize("ratio,label", [
    (0.5, "QUIETER"), (0.79, "QUIETER"), (0.8, "NORMAL"), (1.0, "NORMAL"), (1.25, "NORMAL"),
    (1.26, "BUSIER"), (1.75, "BUSIER"), (1.76, "MUCH_BUSIER"), (4.0, "MUCH_BUSIER"),
    (None, None), (0.0, None), (-1.0, None), (float("nan"), None),
])
def test_rel_label_bands(ratio, label):
    assert R.rel_label(ratio) == label


def test_relative_ratio_and_missing_sides():
    assert R.relative(80.0, 40.0) == (2.0, "MUCH_BUSIER")
    assert R.relative(20.0, 25.0) == (0.8, "NORMAL")
    assert R.relative(None, 40.0) == (None, None)
    assert R.relative(40.0, None) == (None, None)
    assert R.relative(40.0, 0.0) == (None, None)


def test_points_from_bp():
    assert R.points(40.0, 25_000.0) == pytest.approx(100.0)
    assert R.points(None, 25_000.0) is None and R.points(40.0, None) is None


# ---------------------------------------------------------------- reference range

def test_ref_range_is_the_median_of_the_previous_10_sessions_same_minute(table):
    nifty = _nifty_only(table)
    a = pd.Timestamp(AS_OF)
    prior = [d for d in DAYS if d.date() < a.tz_convert(IST).date()][-10:]
    exp = np.median([_expected_range_bp(nifty, pd.Timestamp(d.date().isoformat() + " 11:00", tz=IST), 30) for d in prior])
    seen = nifty[nifty["ts"] < a]          # what predict_once passes: ts < as_of
    assert R.ref_range_bp(seen, AS_OF, "30m") == pytest.approx(exp)
    # Causal: bars at/after as_of (today's window) never change it.
    assert R.ref_range_bp(nifty, AS_OF, "30m") == pytest.approx(exp)


def test_ref_range_none_with_too_few_sessions_or_a_window_past_the_close(table):
    nifty = _nifty_only(table)
    few = nifty[nifty["ts"] >= pd.Timestamp("2026-10-09", tz=IST)]   # 3 prior sessions < 5
    assert R.ref_range_bp(few[few["ts"] < pd.Timestamp(AS_OF)], AS_OF, "30m") is None
    late = pd.Timestamp("2026-10-14 15:15", tz=IST)                    # 30m would cross 15:30
    assert R.ref_range_bp(nifty[nifty["ts"] < late], late, "30m") is None
    assert R.ref_range_bp(nifty, AS_OF, "bogus") is None


def test_predict_once_writes_the_relative_reading(table, gdaily):
    e = _engine(FakeRepo(table), AS_OF + timedelta(seconds=45), _loaded(**{"30m": StubModel()}), gdaily)
    [row] = e.predict_once("NIFTY", AS_OF)
    nifty = _nifty_only(table)
    ref = R.ref_range_bp(nifty[nifty["ts"] < pd.Timestamp(AS_OF)], AS_OF, "30m")
    assert row["ref_range_bp"] == pytest.approx(ref, abs=0.01)
    assert row["rel_ratio"] == pytest.approx(40.0 / ref, abs=1e-4)
    assert row["rel_label"] == R.rel_label(40.0 / ref)


def test_reference_failure_never_costs_the_prediction(table, gdaily, monkeypatch):
    monkeypatch.setattr(R, "ref_range_bp", lambda *a, **k: (_ for _ in ()).throw(ValueError("boom")))
    e = _engine(FakeRepo(table), AS_OF, _loaded(**{"30m": StubModel()}), gdaily)
    [row] = e.predict_once("NIFTY", AS_OF)
    assert row["p"] == 0.8 and row["rel_ratio"] is None and row["rel_label"] is None and row["ref_range_bp"] is None


# ---------------------------------------------------------------- persistence

def test_upsert_sql_persists_the_relative_columns(monkeypatch):
    for col in ("rel_ratio", "rel_label", "ref_range_bp"):
        assert f"%({col})s" in UPSERT_PREDICTION_SQL and f"{col} = EXCLUDED.{col}" in UPSERT_PREDICTION_SQL
    seen = []
    repo = PgRepo("postgresql://unused")
    monkeypatch.setattr(repo, "_execmany", lambda sql, rows: seen.extend(rows))
    repo.upsert_predictions([{"instrument": "NIFTY", "rel_label": "BUSIER"}, {"instrument": "NIFTY"}])
    assert seen[0]["rel_label"] == "BUSIER" and seen[0]["rel_ratio"] is None
    assert seen[1] == {"instrument": "NIFTY", "rel_ratio": None, "rel_label": None, "ref_range_bp": None}


def test_behaviour_carries_relative_reading_and_points(table):
    nifty = _nifty_only(table)
    repo = FakeRepo(nifty)
    repo.upsert_predictions([{"instrument": "NIFTY", "horizon": "30m", "as_of": AS_OF, "p": 0.97, "regime": "ACTIVE",
                              "q25_bp": 24.0, "q50_bp": 32.0, "q75_bp": 42.0, "model_id": "m", "feature_set": "fs",
                              "data_quality": "ok", "rel_ratio": 1.52345, "rel_label": "BUSIER", "ref_range_bp": 21.04}])
    e = _engine(repo, AS_OF + timedelta(minutes=2))
    body = e.behaviour("NIFTY")
    spot = float(nifty.loc[nifty["ts"] < pd.Timestamp(AS_OF), "close"].iloc[-1])
    h = body["horizons"]["30m"]
    assert body["spot"] == round(spot, 2)
    assert h["relRatio"] == 1.52 and h["relLabel"] == "BUSIER" and h["refRangeBp"] == 21.0
    assert h["rangePts"] == [round(24 * spot / 1e4), round(32 * spot / 1e4), round(42 * spot / 1e4)]


# ---------------------------------------------------------------- stale-bar retry

class LateBars(FakeRepo):
    """The newest NIFTY minute arrives only after the engine has waited (`arrive()`)."""

    def __init__(self, full, missing_from):
        super().__init__(full[~((full["series"] == "NIFTY") & (full["ts"] >= missing_from))])
        self.full = full

    def arrive(self):
        self.df = self.full


def test_stale_by_a_few_minutes_waits_once_then_predicts(table, gdaily):
    a = pd.Timestamp(AS_OF)
    repo = LateBars(table, a - timedelta(minutes=3))
    e = _engine(repo, AS_OF, _loaded(**{"30m": StubModel()}), gdaily)
    slept = []
    e.sleep = lambda s: (slept.append(s), repo.arrive())
    rows = e.predict_once("NIFTY", AS_OF)
    assert slept == [E.STALE_RETRY_WAIT_S] and len(rows) == 1 and rows[0]["data_quality"] == "ok"


def test_still_stale_after_the_retry_is_skipped_and_logged(table, gdaily, caplog):
    a = pd.Timestamp(AS_OF)
    repo = LateBars(table, a - timedelta(minutes=3))
    e = _engine(repo, AS_OF, _loaded(**{"30m": StubModel()}), gdaily)
    slept = []
    e.sleep = slept.append
    with caplog.at_level("INFO", logger="mbm.engine"):
        assert e.predict_once("NIFTY", AS_OF) == []
    assert slept == [E.STALE_RETRY_WAIT_S]
    assert "stale after a 30 s retry: newest 1m bar 2026-10-14T05:26:00Z: skipped" in caplog.text


def test_far_behind_is_skipped_without_waiting(table, gdaily, caplog):
    a = pd.Timestamp(AS_OF)
    repo = LateBars(table, a - timedelta(minutes=20))
    e = _engine(repo, AS_OF, _loaded(**{"30m": StubModel()}), gdaily)
    slept = []
    e.sleep = slept.append
    with caplog.at_level("INFO", logger="mbm.engine"):
        assert e.predict_once("NIFTY", AS_OF) == []
    assert slept == []
    assert "newest 1m bar 2026-10-14T05:09:00Z (20 min behind, > 10: no retry): skipped" in caplog.text
