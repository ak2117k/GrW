"""MBM Model A inference from saved artefacts (the M1 `fit_final` models).

Loads one horizon's booster + isotonic map + quantile boosters from
`<store>/models/m1/<instrument>/<horizon>/` and scores decision rows built by the SAME
feature pipeline as training. Used for the forward test now and by M2 serving later.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd

from .model_a import NEXT_DECISION_MIN, QUANTILES, regime


@dataclass
class HorizonModel:
    horizon: str
    columns: list[str]
    classifier: lgb.Booster
    iso_x: np.ndarray
    iso_y: np.ndarray
    quantiles: dict[float, lgb.Booster]
    trained_through: str
    feature_set: str

    @classmethod
    def load(cls, d: Path) -> "HorizonModel":
        meta = json.loads((d / "meta.json").read_text(encoding="utf-8"))
        return cls(
            horizon=meta["horizon"], columns=meta["columns"],
            classifier=lgb.Booster(model_file=str(d / "classifier.txt")),
            iso_x=np.asarray(meta["isotonic"]["x"]), iso_y=np.asarray(meta["isotonic"]["y"]),
            quantiles={q: lgb.Booster(model_file=str(d / f"q{int(q * 100)}.txt")) for q in QUANTILES},
            trained_through=meta["trained_through"], feature_set=meta["featureSet"],
        )

    def predict(self, rows: pd.DataFrame) -> pd.DataFrame:
        """Calibrated P(big), regime and range quantiles (bp) for each row. Missing feature
        columns are NaN (LightGBM routes them like training-time nulls), never an error."""
        X = rows.reindex(columns=self.columns).astype("float64")
        p = np.interp(self.classifier.predict(X), self.iso_x, self.iso_y)
        out = pd.DataFrame({"p": p, "regime": regime(p)}, index=rows.index)
        for q, b in self.quantiles.items():
            out[f"q{int(q * 100)}_bp"] = b.predict(X)
        return out


def score_session(ds: pd.DataFrame, models: dict[str, HorizonModel], day: pd.Timestamp) -> pd.DataFrame:
    """One row per (decision time, horizon) for `day`, with the actual outcome when it is known."""
    rows = ds[ds["date"] == day]
    parts = []
    for h, m in models.items():
        r = rows[rows["mod"] == NEXT_DECISION_MIN] if h == "next" else rows
        if r.empty:
            continue
        pr = m.predict(r)
        pr.insert(0, "horizon", h)
        pr.insert(0, "mod", r["mod"].astype(int).to_numpy())
        pr["threshold_bp"] = r.get(f"threshold_bp_{h}")
        pr["actual_bp"] = r.get(f"range_bp_{h}")
        pr["big"] = r.get(f"big_{h}")
        parts.append(pr)
    return pd.concat(parts) if parts else pd.DataFrame()
