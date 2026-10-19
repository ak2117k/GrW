import numpy as np
import pandas as pd
import pytest

from src.mbm import model_a as A
from tests.test_mbm_features import _bars_1m


@pytest.fixture(scope="module")
def ds():
    days = list(pd.bdate_range("2024-01-01", periods=130))
    return A.build_dataset({"instrument": _bars_1m(days, 7, 20000, vol=False)})


def test_walk_forward_trains_strictly_before_each_test_month(ds, monkeypatch):
    seen = []
    real = A.fit_classifier

    def spy(X, y, Xc, yc):
        seen.append(max(X.index.max(), Xc.index.max()))
        return real(X, y, Xc, yc)

    monkeypatch.setattr(A, "fit_classifier", spy)
    cols = A.model_columns(ds, ())
    cfg = A.WalkForward(min_train_months=3, cal_months=1, q_every=1)
    for h in ("30m", "next"):
        seen.clear()
        p = A.walk_forward(ds, h, cols, cfg)
        assert len(p) > 0 and {"p", "q25_bp", "q50_bp", "q75_bp"} <= set(p.columns)
        months = sorted(p["month"].unique())
        assert len(seen) == len(months)
        for m, last_train in zip(months, seen):
            assert last_train < pd.Period(m, "M").start_time.tz_localize("Asia/Kolkata")
        assert p["p"].between(0, 1).all()


def test_gate_and_tables(ds):
    cols = A.model_columns(ds, ())
    p = A.walk_forward(ds, "60m", cols, A.WalkForward(min_train_months=3, cal_months=1))
    g = A.gate(p, last=2)
    assert set(g["checks"]) == {"auc_pooled_last_months", "auc_month_floor", "brier_below_baseline", "min_obs"}
    assert isinstance(g["pass"], bool)
    assert A.regime_table(p)["regime"].tolist() == ["QUIET", "NORMAL", "ACTIVE"]
    assert A.calibration_table(p)["n"].sum() == len(p)


def test_regime_bands():
    assert A.regime(np.array([0.1, 0.5, 0.9])).tolist() == ["QUIET", "NORMAL", "ACTIVE"]
