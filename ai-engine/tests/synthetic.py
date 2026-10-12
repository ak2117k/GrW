"""Synthetic corpus frames for training/serving tests."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import numpy as np

from src.corpus.export import load_frame_from_records
from src.scorer import features_fs1

T0 = datetime(2026, 5, 4, 4, 0, tzinfo=timezone.utc)


def frame(n_groups: int, days: int, *, signal: bool, seed: int = 1):
    rng = np.random.default_rng(seed)
    names = features_fs1.feature_names()
    recs = []
    for i in range(n_groups):
        day = i % days
        at = T0 + timedelta(days=day, minutes=int(rng.integers(0, 360)))
        rsi = float(rng.uniform(20, 80))
        feats = {n: None for n in names}
        feats.update({"rsi_5m_value": rsi, "rsi_5m_passed": int(rsi > 50), "rsi_5m_missing": 0,
                      "adx_value": float(rng.uniform(10, 50)), "adx_missing": 0,
                      "minute_of_session": float(rng.integers(0, 360)), "direction_long": 1,
                      "strategy_gated": 1, "vix_regime_normal": 1})
        if signal:
            win = bool(rng.random() < (0.85 if rsi > 50 else 0.15))
        else:
            win = bool(rng.random() < 0.4)
        recs.append({
            "id": f"r{i}", "source": "synthetic", "sourceId": f"s{i:06d}", "decidedAt": at,
            "strategyKey": "legacy.gated", "direction": "LONG", "setupGroupKey": f"g{i}",
            "features": feats, "ruleScore": float(rng.uniform(0, 1)), "decision": {"taken": True},
            "outcome": {"win": win, "rMultiple": (1.5 if win else -1.0) + float(rng.normal(0, .1)), "rDerived": True},
        })
    return load_frame_from_records(recs)
