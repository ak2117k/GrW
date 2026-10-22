"""MBM P(big) never reaches 0 or 1, even where the isotonic map does (2026-10-21: 20 rows at p = 1.00)."""
from __future__ import annotations

import lightgbm as lgb
import numpy as np
import pandas as pd

from src.mbm.predict import P_BOUNDS, HorizonModel


def test_probability_is_capped_and_regime_unchanged():
    rng = np.random.default_rng(0)
    X = pd.DataFrame({"f": rng.normal(size=400)})
    y = (X["f"] > 0).astype(int)
    clf = lgb.train({"objective": "binary", "verbose": -1, "num_leaves": 4}, lgb.Dataset(X, y), num_boost_round=20)
    q = lgb.train({"objective": "quantile", "alpha": 0.5, "verbose": -1, "num_leaves": 4}, lgb.Dataset(X, y), 5)
    m = HorizonModel(horizon="30m", columns=["f"], classifier=clf,
                     iso_x=np.array([0.0, 0.3, 0.7, 1.0]), iso_y=np.array([0.0, 0.0, 1.0, 1.0]),
                     quantiles={0.5: q}, trained_through="2026-10-01", feature_set="t")
    out = m.predict(pd.DataFrame({"f": [-5.0, 0.0, 5.0]}))
    assert out["p"].min() == P_BOUNDS[0] and out["p"].max() == P_BOUNDS[1]
    assert list(out["regime"]) == ["QUIET", out["regime"].iloc[1], "ACTIVE"]
