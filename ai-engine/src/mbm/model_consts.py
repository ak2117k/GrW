"""Model A constants shared by training (`model_a`) and serving (`predict`).

Kept free of sklearn so the serving image (`Dockerfile.mbm`) can load models without it.
"""
from __future__ import annotations

import numpy as np

NEXT_DECISION_MIN = 15 * 60 + 15
QUANTILES = (0.25, 0.5, 0.75)
REGIME_BANDS = (0.35, 0.65)    # P(big) < 0.35 QUIET, > 0.65 ACTIVE


def regime(p: np.ndarray) -> np.ndarray:
    lo, hi = REGIME_BANDS
    return np.where(p < lo, "QUIET", np.where(p > hi, "ACTIVE", "NORMAL"))
