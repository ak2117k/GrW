"""k-nearest past decisions on the standardised fs1 feature vector (served as POST /corpus/similar)."""
from __future__ import annotations

import json

import numpy as np
import pandas as pd

from src.scorer import features_fs1

_FILTER_COLUMNS = {"strategyKey": "strategy_key", "direction": "direction"}


class SimilarIndex:
    def __init__(self, df: pd.DataFrame, feature_names: list[str] | None = None):
        self.names = feature_names or features_fs1.feature_names()
        self.df = df.reset_index(drop=True)
        if len(self.df):
            X = self.df[self.names].astype(float).to_numpy()
            present = ~np.isnan(X)
            counts = present.sum(axis=0)
            sums = np.where(present, X, 0.0).sum(axis=0)
            mean = np.divide(sums, counts, out=np.zeros(len(self.names)), where=counts > 0)  # all-NaN column → 0
            X = np.where(np.isnan(X), mean, X)
            std = X.std(axis=0)
            std = np.where(std > 0, std, 1.0)
            self.mean, self.std = mean, std
            self.Z = (X - mean) / std
        else:
            self.mean = np.zeros(len(self.names))
            self.std = np.ones(len(self.names))
            self.Z = np.zeros((0, len(self.names)))

    def __len__(self) -> int:
        return len(self.df)

    def _vector(self, features: dict) -> np.ndarray:
        x = np.array([np.nan if features.get(n) is None else float(features[n]) for n in self.names])
        x = np.where(np.isnan(x), self.mean, x)
        return (x - self.mean) / self.std

    def query(self, features: dict, k: int, filters: dict | None = None) -> list[dict]:
        if not len(self.df) or k <= 0:
            return []
        mask = np.ones(len(self.df), dtype=bool)
        for key, col in _FILTER_COLUMNS.items():
            val = (filters or {}).get(key)
            if val is not None:
                mask &= (self.df[col] == val).to_numpy()
        idx = np.flatnonzero(mask)
        if not len(idx):
            return []
        dist = np.sqrt(((self.Z[idx] - self._vector(features)) ** 2).sum(axis=1))
        ids = self.df["id"].to_numpy()[idx]
        order = sorted(range(len(idx)), key=lambda i: (round(float(dist[i]), 12), str(ids[i])))[:k]
        out = []
        for i in order:
            row = self.df.iloc[idx[i]]
            out.append({
                "id": str(row["id"]),
                "decidedAt": row["decided_at"].isoformat(),
                "strategyKey": row["strategy_key"],
                "decision": json.loads(row["decision_json"]) if isinstance(row["decision_json"], str) else None,
                "outcome": json.loads(row["outcome_json"]) if isinstance(row["outcome_json"], str) else None,
                "distance": float(dist[i]),
            })
        return out
