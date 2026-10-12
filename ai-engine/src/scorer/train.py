"""Entry-scorer training: XGBoost P(win) + isotonic calibration, expected-R regressor, baseline, gate.

Pipeline: ``dedupe_groups`` → ``time_group_split`` (last 20% of IST trading days held out, no setup
group on both sides) → classifier fit on train → isotonic calibrator fit on grouped out-of-fold
predictions of the train part → holdout metrics vs a baseline that is the legacy rule score
isotonically calibrated on the same train part.

Gate (spec §6, plan Global Constraints): GO only if holdout ROC-AUC ≥ 0.60 AND calibrated Brier <
baseline Brier AND holdout setups ≥ 300. The gate is never tuned to pass.
"""
from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from datetime import datetime, timezone

import numpy as np
import pandas as pd
import xgboost as xgb
from sklearn.isotonic import IsotonicRegression
from sklearn.metrics import brier_score_loss, roc_auc_score

from src.corpus.split import dedupe_groups, group_kfold, ist_days, time_group_split
from src.scorer import features_fs1

GATE_MIN_AUC = 0.60
GATE_MIN_HOLDOUT = 300
MODEL_KIND = "xgb-entry"
SLICE_COLUMNS = ("strategy_key", "direction", "vix_regime")


def xgb_params(seed: int) -> dict:
    return dict(n_estimators=300, max_depth=3, learning_rate=0.05, subsample=0.8, colsample_bytree=0.8,
                random_state=seed, missing=np.nan, tree_method="hist", n_jobs=1)


@dataclass
class TrainResult:
    model_id: str
    gate: str
    gate_reasons: list[str]
    metrics: dict
    n_train: int
    n_holdout: int
    data_window: dict
    artifact: dict = field(repr=False)
    feature_set: str = features_fs1.FEATURE_SET


def _x(df: pd.DataFrame, names: list[str]) -> np.ndarray:
    return df[names].astype(float).to_numpy()


def _auc(y: np.ndarray, p: np.ndarray) -> float | None:
    if len(y) == 0 or len(np.unique(y)) < 2:
        return None
    return float(roc_auc_score(y, p))


def _clean(v):
    if isinstance(v, float) and not math.isfinite(v):
        return None
    if isinstance(v, (np.floating,)):
        return _clean(float(v))
    if isinstance(v, (np.integer,)):
        return int(v)
    if isinstance(v, dict):
        return {str(k): _clean(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_clean(x) for x in v]
    return v


def _isotonic(x: np.ndarray, y: np.ndarray) -> IsotonicRegression:
    iso = IsotonicRegression(y_min=0.0, y_max=1.0, out_of_bounds="clip")
    iso.fit(x, y)
    return iso


def apply_calibrator(cal: dict, p: np.ndarray) -> np.ndarray:
    """Piecewise-linear isotonic map stored as ``{"x": [...], "y": [...]}`` (np.interp clips at the ends)."""
    xs, ys = np.asarray(cal["x"], float), np.asarray(cal["y"], float)
    if len(xs) == 0:
        return np.asarray(p, float)
    if len(xs) == 1:
        return np.full(len(p), ys[0])
    return np.interp(np.asarray(p, float), xs, ys)


def _rule(df: pd.DataFrame, fill: float) -> np.ndarray:
    return df["rule_score"].astype(float).fillna(fill).to_numpy()


def _baseline_iso(train_df: pd.DataFrame) -> tuple[IsotonicRegression, float]:
    fill = float(train_df["rule_score"].astype(float).mean()) if train_df["rule_score"].notna().any() else 0.5
    return _isotonic(_rule(train_df, fill), train_df["win"].astype(int).to_numpy()), fill


def baseline_scores(train_df: pd.DataFrame, apply_df: pd.DataFrame) -> np.ndarray:
    """Isotonic(rule_score → win) fit on ``train_df`` and applied to ``apply_df``."""
    iso, fill = _baseline_iso(train_df)
    return iso.predict(_rule(apply_df, fill))


def rule_calibrator(train_df: pd.DataFrame) -> dict:
    """The baseline map as ``{"x", "y"}`` — served as the calibrated rule fallback."""
    iso, _ = _baseline_iso(train_df)
    return {"x": [float(v) for v in iso.X_thresholds_], "y": [float(v) for v in iso.y_thresholds_]}


def booster_to_json(model) -> str:
    return bytes(model.get_booster().save_raw("json")).decode("utf-8")


def booster_from_json(s: str) -> xgb.Booster:
    b = xgb.Booster()
    b.load_model(bytearray(s.encode("utf-8")))
    return b


def predict_raw(booster: xgb.Booster, X: np.ndarray, names: list[str]) -> np.ndarray:
    return booster.predict(xgb.DMatrix(X, feature_names=names, missing=np.nan))


def _slices(hold: pd.DataFrame, p: np.ndarray) -> dict:
    out: dict = {}
    y = hold["win"].astype(int).to_numpy()
    for col in SLICE_COLUMNS:
        vals = hold[col].fillna("unknown").astype(str).to_numpy()
        out[col] = {}
        for v in sorted(set(vals)):
            m = vals == v
            out[col][v] = {"n": int(m.sum()), "auc": _auc(y[m], p[m]), "winRate": float(y[m].mean())}
    return out


def _window(df: pd.DataFrame, hold: pd.DataFrame) -> dict:
    if df.empty:
        return {}
    days = ist_days(df)
    return {
        "from": df["decided_at"].min().isoformat(), "to": df["decided_at"].max().isoformat(),
        "holdoutFrom": hold["decided_at"].min().isoformat() if len(hold) else None,
        "nDays": int(days.nunique()), "nHoldoutDays": int(ist_days(hold).nunique()) if len(hold) else 0,
    }


def train(df: pd.DataFrame, *, seed: int = 7, feature_set: str = features_fs1.FEATURE_SET,
          now: datetime | None = None) -> TrainResult:
    names = features_fs1.feature_names()
    n_raw = len(df)
    df = dedupe_groups(df[df["win"].notna()])
    tr, ho = time_group_split(df)
    if len(tr) == 0 or tr["win"].nunique() < 2:
        raise ValueError("training split needs both outcomes")
    Xtr, ytr = _x(tr, names), tr["win"].astype(int).to_numpy()
    Xho, yho = _x(ho, names), ho["win"].astype(int).to_numpy()

    params = xgb_params(seed)

    # Calibrator on grouped out-of-fold predictions of the train part (no holdout data touched).
    oof = np.full(len(tr), np.nan)
    for fit_idx, val_idx in group_kfold(tr, k=5):
        if len(np.unique(ytr[fit_idx])) < 2:
            continue
        m = xgb.XGBClassifier(eval_metric="logloss", **params)
        m.fit(Xtr[fit_idx], ytr[fit_idx])
        oof[val_idx] = m.predict_proba(Xtr[val_idx])[:, 1]
    ok = ~np.isnan(oof)
    iso = _isotonic(oof[ok], ytr[ok]) if ok.sum() > 1 else _isotonic(np.array([0.0, 1.0]), np.array([0, 1]))
    calibrator = {"x": [float(v) for v in iso.X_thresholds_], "y": [float(v) for v in iso.y_thresholds_]}

    clf = xgb.XGBClassifier(eval_metric="logloss", **params)
    clf.fit(Xtr, ytr)

    reg_json = None
    r_mask = tr["r_multiple"].notna().to_numpy()
    if r_mask.sum() >= 10:
        reg = xgb.XGBRegressor(**params)
        reg.fit(Xtr[r_mask], tr["r_multiple"].astype(float).to_numpy()[r_mask])
        reg_json = booster_to_json(reg)

    metrics: dict = {"nRawRows": n_raw, "nAfterDedupe": len(df), "trainWinRate": float(ytr.mean())}
    if len(ho):
        p_raw = clf.predict_proba(Xho)[:, 1]
        p_cal = apply_calibrator(calibrator, p_raw)
        p_base = baseline_scores(tr, ho)
        metrics.update({
            "rocAuc": _auc(yho, p_raw),
            "rocAucCalibrated": _auc(yho, p_cal),
            "brier": float(brier_score_loss(yho, p_cal)),
            "brierUncalibrated": float(brier_score_loss(yho, p_raw)),
            "baselineBrier": float(brier_score_loss(yho, p_base)),
            "baselineAuc": _auc(yho, p_base),
            "constantBrier": float(brier_score_loss(yho, np.full(len(yho), ytr.mean()))),
            "baseWinRate": float(yho.mean()),
            "slices": _slices(ho, p_raw),
        })
    else:
        metrics.update({"rocAuc": None, "brier": None, "baselineBrier": None, "baseWinRate": None, "slices": {}})

    reasons: list[str] = []
    if metrics["rocAuc"] is None or metrics["rocAuc"] < GATE_MIN_AUC:
        reasons.append("auc<0.60")
    if metrics["brier"] is None or metrics["baselineBrier"] is None or metrics["brier"] >= metrics["baselineBrier"]:
        reasons.append("brier>=baseline")
    if len(ho) < GATE_MIN_HOLDOUT:
        reasons.append("holdout<300")

    stamp = (now or datetime.now(timezone.utc)).strftime("%Y%m%d%H%M")
    model_id = f"xgb-entry-{feature_set}-{stamp}"
    gate = "NO_GO" if reasons else "GO"
    artifact = {
        "modelId": model_id,
        # Recorded so serving can refuse a NO_GO file without a database (serve.ScorerHolder.load).
        "gate": gate,
        "gateReasons": list(reasons),
        "classifier": booster_to_json(clf),
        "calibrator": calibrator,
        "rule_calibrator": rule_calibrator(tr),
        "regressor": reg_json,
        "feature_names": names,
        "feature_set": feature_set,
    }
    return TrainResult(model_id=model_id, gate=gate, gate_reasons=reasons,
                       metrics=_clean(metrics), n_train=len(tr), n_holdout=len(ho),
                       data_window=_window(df, ho), artifact=artifact, feature_set=feature_set)


def result_json(result: TrainResult) -> dict:
    return {"modelId": result.model_id, "gate": result.gate, "gateReasons": result.gate_reasons,
            "nTrain": result.n_train, "nHoldout": result.n_holdout, "dataWindow": result.data_window,
            "metrics": result.metrics, "featureSet": result.feature_set}


def dumps(result: TrainResult) -> str:
    return json.dumps(result_json(result), indent=2, sort_keys=True)


CAVEATS = (
    "Single market regime: the legacy data covers about two months of one market phase (see the data "
    "window); the VIX-regime slices show how little regime variety there is.",
    "Long-only cash equity in practice (gated SELL entries are about 1%); nothing here speaks for options, "
    "futures or shorts.",
    "Labels are fee-dominated: small gross moves on paper position sizes mean fees often turn a gross win "
    "into a net loss, so `win` is partly a fee-hurdle label.",
    "Derived R: most legacy trades stored no stop, so R uses the legacy loss-cut (flat Rs 1,000 before "
    "2026-05-19, 0.4% of deployed capital after) and is marked rDerived.",
    "The three legacy tracks traded the same Chartink alerts; setups are de-duplicated by alert|symbol|IST "
    "date before the split, so one alert counts once (the earliest track's record is kept).",
)


def _fmt(v) -> str:
    if v is None:
        return "n/a"
    if isinstance(v, float):
        return f"{v:.4f}"
    return str(v)


def render_report(result: TrainResult, *, source: str, counts: dict | None = None) -> str:
    m = result.metrics
    verdict = f"**{result.gate}**" + (
        f" — failed: {', '.join(result.gate_reasons)}" if result.gate_reasons else " — all gate conditions met.")
    lines = [
        f"# Entry-scorer training report — {result.model_id}",
        "",
        f"Source: {source}. Feature set `{result.feature_set}`. Generated by `ai-engine/scripts/train_entry_scorer.py`.",
        "",
        "## Gate verdict",
        "",
        verdict,
        "",
        f"Gate: holdout ROC-AUC >= {GATE_MIN_AUC:.2f} AND calibrated Brier < baseline Brier AND holdout "
        f"setups >= {GATE_MIN_HOLDOUT}.",
        "",
        "## Data window",
        "",
        "| | |",
        "|---|---|",
    ]
    lines += [f"| {k} | {_fmt(v)} |" for k, v in result.data_window.items()]
    lines += [
        "", "## Counts", "", "| | |", "|---|---|",
        f"| labelled taken rows loaded | {_fmt(m.get('nRawRows'))} |",
        f"| after setup-group dedupe | {_fmt(m.get('nAfterDedupe'))} |",
        f"| train | {result.n_train} |",
        f"| holdout | {result.n_holdout} |",
    ]
    lines += [f"| {k} | {_fmt(v)} |" for k, v in sorted((counts or {}).items())]
    lines += [
        "", "## Holdout metrics vs baseline", "",
        "Baseline = legacy rule score (passed checks / present checks), isotonic-calibrated on the train part.",
        "",
        "| metric | model | baseline |",
        "|---|---|---|",
        f"| ROC-AUC | {_fmt(m.get('rocAuc'))} | {_fmt(m.get('baselineAuc'))} |",
        f"| Brier (calibrated) | {_fmt(m.get('brier'))} | {_fmt(m.get('baselineBrier'))} |",
        f"| Brier (uncalibrated) | {_fmt(m.get('brierUncalibrated'))} | |",
        f"| Brier (constant = train win rate) | {_fmt(m.get('constantBrier'))} | |",
        f"| holdout win rate | {_fmt(m.get('baseWinRate'))} | |",
        f"| train win rate | {_fmt(m.get('trainWinRate'))} | |",
        "", "## Per-slice holdout", "",
        "| slice | value | n | AUC | win rate |",
        "|---|---|---|---|---|",
    ]
    for col, vals in (m.get("slices") or {}).items():
        lines += [f"| {col} | {v} | {s['n']} | {_fmt(s['auc'])} | {_fmt(s['winRate'])} |" for v, s in vals.items()]
    lines += ["", "## Caveats", ""] + [f"- {c}" for c in CAVEATS] + [""]
    return "\n".join(lines)
