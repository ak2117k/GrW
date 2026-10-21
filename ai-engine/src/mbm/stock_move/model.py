"""Stock-move artefact: load, design matrix, calibrated score, the daily book (rank + bucket).

Artefact dir `models/stock-move/<YYYYMMDD>/` (written by scripts/stock_move_ship.py train):
  model.txt          LightGBM text model (binary, y_big5_1.5)
  meta.json          columns, sector categories + symbol->sector map, isotonic x/y, training universe, …
  metrics.json       walk-forward gate metrics (the GO evidence)
  calendar_R.csv.gz  results-filing seed (NSE+BSE history) for the nightly calendar
  calendar_B.csv.gz  board-meeting intimation seed
Serving needs no sklearn: the isotonic map is np.interp over its thresholds (out-of-bounds clip).
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd

MODEL_FILES = ("model.txt", "meta.json", "metrics.json", "calendar_R.csv.gz", "calendar_B.csv.gz")
TOP, BOTTOM = "TOP20", "BOTTOM20"
TOP_Q, BOTTOM_Q = 0.8, 0.2
N_DRIVERS = 3


def design(rows: pd.DataFrame, columns: list[str], sector_categories: list[str]) -> pd.DataFrame:
    """Model input in training's exact form: float32-rounded floats (training cast float64 -> float32) and
    the sector as its category code (unknown sector -> NaN, which LightGBM routes like a missing value)."""
    X = rows.reindex(columns=columns).copy()
    if "sector" in X.columns:
        codes = {c: i for i, c in enumerate(sector_categories)}
        X["sector"] = rows["sector"].map(codes).astype("float64") if "sector" in rows else np.nan
    num = [c for c in X.columns if c != "sector"]
    X[num] = X[num].apply(pd.to_numeric, errors="coerce").astype("float32").astype("float64")
    return X


def book(raw: np.ndarray) -> tuple[np.ndarray, list[str]]:
    """(rank_pct, bucket) within one day's scored book. rank_pct = average rank / n in (0, 1] on the RAW
    score (the isotonic map has flat steps; the raw score keeps the full ordering). TOP20: rank_pct > 0.8;
    BOTTOM20: rank_pct <= 0.2; else MID."""
    raw = np.asarray(raw, dtype="float64")
    if raw.size == 0:
        return np.array([]), []
    r = pd.Series(raw).rank(method="average", pct=True).to_numpy()
    buckets = [TOP if x > TOP_Q else BOTTOM if x <= BOTTOM_Q else "MID" for x in r]
    return r, buckets


@dataclass
class StockMoveModel:
    booster: lgb.Booster
    columns: list[str]
    sector_categories: list[str]
    sectors: dict[str, str]
    iso_x: np.ndarray
    iso_y: np.ndarray
    trained_through: str
    feature_set: str
    universe: list[str] = field(default_factory=list)
    model_id: str = ""

    @classmethod
    def load(cls, d: Path, model_id: str = "") -> "StockMoveModel":
        d = Path(d)
        meta = json.loads((d / "meta.json").read_text(encoding="utf-8"))
        return cls(booster=lgb.Booster(model_file=str(d / "model.txt")), columns=list(meta["columns"]),
                   sector_categories=list(meta["sectorCategories"]), sectors=dict(meta["sectors"]),
                   iso_x=np.asarray(meta["isotonic"]["x"], dtype="float64"),
                   iso_y=np.asarray(meta["isotonic"]["y"], dtype="float64"),
                   trained_through=meta["trainedThrough"], feature_set=meta["featureSet"],
                   universe=list(meta.get("universe") or []), model_id=model_id or meta.get("modelId", ""))

    def matrix(self, rows: pd.DataFrame) -> pd.DataFrame:
        return design(rows, self.columns, self.sector_categories)

    def calibrate(self, raw: np.ndarray) -> np.ndarray:
        return np.clip(np.interp(raw, self.iso_x, self.iso_y), 0.0, 1.0)

    def score(self, rows: pd.DataFrame) -> pd.DataFrame:
        """raw, p_big, rank_pct, bucket and the top drivers (LightGBM SHAP contributions) per row."""
        X = self.matrix(rows)
        raw = self.booster.predict(X)
        rank, buckets = book(raw)
        contrib = self.booster.predict(X, pred_contrib=True)[:, :-1]
        drivers = []
        for i in range(len(X)):
            top = np.argsort(-np.abs(contrib[i]))[:N_DRIVERS]
            drivers.append([{"f": self.columns[j], "v": _num(X.iat[i, j]), "c": round(float(contrib[i, j]), 4)}
                            for j in top])
        return pd.DataFrame({"raw": raw, "p_big": self.calibrate(raw), "rank_pct": rank, "bucket": buckets,
                             "drivers": drivers}, index=rows.index)


def _num(x):
    try:
        x = float(x)
    except (TypeError, ValueError):
        return None
    return None if x != x else round(x, 6)
