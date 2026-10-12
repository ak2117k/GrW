"""Serving-side scorer: the active model if one is loaded, else the (calibrated) legacy rule score.

Request context uses the Node ``ScoreRequest`` field names (Task A7): ``decidedAt``, ``direction``,
``strategyKey``, ``vixAtEntry``, ``vixRegime``, ``adRatio``, ``profitTargetSource`` (+ optional
``initialPrice``, ``profitTarget``). Post-decision keys (``LEAKAGE_FIELDS``) are rejected.
"""
from __future__ import annotations

import logging
import math
from pathlib import Path

import numpy as np

from src.corpus.legacy_mapping import rule_score_from
from src.scorer import features_fs1
from src.scorer.registry import load_artifact
from src.scorer.train import apply_calibrator, booster_from_json, predict_raw

logger = logging.getLogger(__name__)

FEATURE_SETS = {features_fs1.FEATURE_SET: features_fs1}
_STRATEGY_PREFIX = "legacy."


class UnknownFeatureSet(ValueError):
    pass


def to_extract_context(ctx: dict) -> dict:
    """Node camelCase context → ``features_fs1.extract`` context. Raises ValueError on leakage keys."""
    leaked = sorted(set(ctx) & features_fs1.LEAKAGE_FIELDS)
    if leaked:
        raise ValueError(f"post-decision fields not allowed in context: {leaked}")
    strategy_key = str(ctx.get("strategyKey") or "")
    strategy = strategy_key[len(_STRATEGY_PREFIX):] if strategy_key.startswith(_STRATEGY_PREFIX) else strategy_key
    return {
        "decided_at": ctx.get("decidedAt"),
        "direction": ctx.get("direction"),
        "strategy": strategy,
        "initial_price": ctx.get("initialPrice"),
        "profit_target": ctx.get("profitTarget"),
        "profit_target_source": ctx.get("profitTargetSource"),
        "vix_at_entry": ctx.get("vixAtEntry"),
        "vix_regime": ctx.get("vixRegime"),
        "ad_ratio": ctx.get("adRatio"),
    }


def _finite(v) -> float | None:
    return float(v) if v is not None and math.isfinite(float(v)) else None


class ScorerHolder:
    def __init__(self, models_dir: Path, rule_calibrator: dict | None = None):
        self.models_dir = Path(models_dir)
        self.rule_calibrator = rule_calibrator
        self.model_id: str | None = None
        self._clf = None
        self._reg = None
        self._cal: dict | None = None
        self._names: list[str] = []
        self._feature_set: str | None = None

    @property
    def mode(self) -> str:
        return f"model:{self.model_id}" if self.model_id else "rule"

    def load(self, model_id: str | None, registry_gate: str | None = None) -> None:
        """Load ``<models_dir>/<model_id>.json``; None → rule-only. Raises on a missing/bad artifact.

        GO ONLY. A model is served only if its training gate was ``GO``: the artifact's own ``gate``
        (written by training since this check), else — for artifacts written before it — the
        ``ai_models`` row's gate passed in as ``registry_gate``. An artifact that says ``NO_GO`` is
        refused whatever the registry says. A refused model leaves the holder rule-only (its
        ``rule_calibrator`` is not adopted either) and logs one warning.
        """
        if model_id is None:
            self.model_id, self._clf, self._reg, self._cal = None, None, None, None
            return
        stem = Path(model_id).stem
        art = load_artifact(self.models_dir / f"{stem}.json")
        gate = art.get("gate") or registry_gate
        if gate != "GO":
            logger.warning("scorer: refusing model %s: training gate is %s, not GO (reasons: %s); "
                           "serving rule scores", stem, gate or "unrecorded",
                           ", ".join(art.get("gateReasons") or []) or "n/a")
            self.load(None)
            return
        clf = booster_from_json(art["classifier"])
        reg = booster_from_json(art["regressor"]) if art.get("regressor") else None
        self._clf, self._reg, self._cal = clf, reg, art.get("calibrator")
        self._names = list(art["feature_names"])
        self._feature_set = art["feature_set"]
        if art.get("rule_calibrator"):
            self.rule_calibrator = art["rule_calibrator"]
        self.model_id = art.get("modelId") or Path(model_id).stem

    def features(self, feature_set: str, breakdown, context: dict) -> tuple[dict, list[str]]:
        module = FEATURE_SETS.get(feature_set)
        if module is None:
            raise UnknownFeatureSet(feature_set)
        return module.extract(breakdown, to_extract_context(context or {}))

    def score(self, feature_set: str, breakdown, context: dict) -> dict:
        feats, missing = self.features(feature_set, breakdown, context)
        if self._clf is not None and feature_set == self._feature_set:
            X = np.array([[np.nan if feats.get(n) is None else float(feats[n]) for n in self._names]])
            p = predict_raw(self._clf, X, self._names)
            if self._cal:
                p = apply_calibrator(self._cal, p)
            expected_r = _finite(predict_raw(self._reg, X, self._names)[0]) if self._reg is not None else None
            return {"source": "model", "pWin": float(np.clip(p[0], 0.0, 1.0)), "expectedR": expected_r,
                    "modelId": self.model_id, "featureSet": feature_set, "missing": missing}
        rule = rule_score_from(feats)
        if rule is None:
            p_win = 0.5  # no check evaluable: uninformative prior, `missing` lists every check
        elif self.rule_calibrator:
            p_win = float(apply_calibrator(self.rule_calibrator, np.array([rule]))[0])
        else:
            p_win = float(rule)
        return {"source": "rule", "pWin": p_win, "expectedR": None, "featureSet": feature_set, "missing": missing}
