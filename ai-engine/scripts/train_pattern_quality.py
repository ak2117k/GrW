"""
Train + evaluate the pattern-quality XGBoost classifier (ML Phase 2, go/no-go).

Loads the exported labeled observations, feature-engineers each row with the
SAME ``pattern_feature_engineer`` used at serve time, does a TEMPORAL split on
``barTime`` (never random — prevents future->past leakage), trains an XGBoost
binary classifier with class-imbalance handling, and reports HONEST validation
metrics: overall ROC-AUC / precision / recall / F1, a majority-class baseline,
and a per-(patternName, timeframe) breakdown.

Run inside Docker (Python is not installed natively):

    docker run --rm -v "/c/Users/AryanKumar/Desktop/GrW/ai-engine:/app" -w /app \
      python:3.11-slim bash -c \
      "pip install --quiet xgboost scikit-learn pandas numpy && \
       python scripts/train_pattern_quality.py"
"""

import json
import os
import sys
from pathlib import Path

# Make ``src`` importable so the feature engineer (and its indicator imports)
# resolve when running as a standalone script.
_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_ROOT / "src"))

import numpy as np
import pandas as pd

from services.pattern_feature_engineer import extract_features, FEATURE_NAMES

DATA_PATH = _ROOT / "data" / "pattern_observations_train.json"
MODEL_DIR = _ROOT / "data" / "models"
MODEL_PATH = MODEL_DIR / "pattern_quality_v1.json"
METRICS_PATH = MODEL_DIR / "pattern_quality_v1_metrics.json"

MIN_USABLE_ROWS = 200
MIN_SEGMENT_VAL = 15  # skip per-(pattern,tf) segments with fewer val samples


def _load_rows(path: Path) -> list:
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    if not isinstance(data, list):
        raise ValueError(f"Expected a JSON array, got {type(data).__name__}")
    return data


def _build_frame(rows: list):
    """Feature-engineer every row -> (X DataFrame, y Series, meta DataFrame)."""
    feat_records = []
    labels = []
    meta_records = []
    skipped = 0
    for r in rows:
        label = r.get("label")
        if label is None:  # exclude TIMEOUT/PENDING defensively
            skipped += 1
            continue
        bar_time = r.get("barTime")
        if bar_time is None:
            skipped += 1
            continue
        feats = extract_features(r)
        feat_records.append({name: feats.get(name, float("nan")) for name in FEATURE_NAMES})
        labels.append(int(label))
        meta_records.append(
            {
                "barTime": bar_time,
                "patternName": r.get("patternName"),
                "timeframe": r.get("timeframe"),
            }
        )

    X = pd.DataFrame(feat_records, columns=FEATURE_NAMES).astype(float)
    y = pd.Series(labels, name="label", dtype=int)
    meta = pd.DataFrame(meta_records)
    meta["barTime"] = pd.to_datetime(meta["barTime"], errors="coerce")
    return X, y, meta, skipped


def main() -> int:
    print("=" * 78)
    print("PATTERN-QUALITY CLASSIFIER — TRAIN + HONEST EVALUATION (ML Phase 2)")
    print("=" * 78)

    if not DATA_PATH.exists():
        print(f"ERROR: training data not found at {DATA_PATH}")
        return 1

    rows = _load_rows(DATA_PATH)
    print(f"Loaded {len(rows)} raw observations from {DATA_PATH.name}")

    X, y, meta, skipped = _build_frame(rows)
    n = len(y)
    print(f"Usable labeled rows: {n}  (skipped {skipped} with null label/barTime)")

    # ---- Guards ---------------------------------------------------------- #
    if n < MIN_USABLE_ROWS:
        print(f"REFUSING: only {n} usable rows (< {MIN_USABLE_ROWS} floor). "
              "Will not train a degenerate model.")
        return 1
    n_pos = int((y == 1).sum())
    n_neg = int((y == 0).sum())
    if n_pos == 0 or n_neg == 0:
        print(f"REFUSING: a class is absent (WIN={n_pos}, LOSS={n_neg}). "
              "Cannot train a binary classifier.")
        return 1

    base_rate = n_pos / n
    print(f"Class balance overall: LOSS={n_neg}  WIN={n_pos}  "
          f"(base WIN rate = {base_rate:.3f})")

    # ---- Temporal split on barTime (critical: NOT random) ---------------- #
    if meta["barTime"].isna().any():
        bad = int(meta["barTime"].isna().sum())
        print(f"WARNING: {bad} rows have unparseable barTime; they sort first.")
    order = meta["barTime"].sort_values(kind="mergesort").index  # stable
    X = X.loc[order].reset_index(drop=True)
    y = y.loc[order].reset_index(drop=True)
    meta = meta.loc[order].reset_index(drop=True)

    split_idx = int(n * 0.8)
    X_train, X_val = X.iloc[:split_idx], X.iloc[split_idx:]
    y_train, y_val = y.iloc[:split_idx], y.iloc[split_idx:]
    meta_val = meta.iloc[split_idx:].reset_index(drop=True)

    n_train, n_val = len(y_train), len(y_val)
    tr_pos, tr_neg = int((y_train == 1).sum()), int((y_train == 0).sum())
    va_pos = int((y_val == 1).sum())
    print(f"Temporal split @ barTime: train={n_train} rows "
          f"[{meta['barTime'].iloc[0]} .. {meta['barTime'].iloc[split_idx-1]}], "
          f"val={n_val} rows "
          f"[{meta['barTime'].iloc[split_idx]} .. {meta['barTime'].iloc[-1]}]")

    if tr_pos == 0 or tr_neg == 0:
        print(f"REFUSING: a class is absent in the TRAIN split "
              f"(WIN={tr_pos}, LOSS={tr_neg}).")
        return 1
    if va_pos == 0 or va_pos == n_val:
        print("WARNING: validation split is single-class; AUC is undefined.")

    # ---- Train XGBoost --------------------------------------------------- #
    import xgboost as xgb
    from sklearn.metrics import (
        roc_auc_score, precision_score, recall_score, f1_score,
        accuracy_score, confusion_matrix,
    )

    scale_pos_weight = tr_neg / tr_pos  # from TRAIN split only
    print(f"scale_pos_weight (train n_neg/n_pos) = {scale_pos_weight:.3f}")

    model = xgb.XGBClassifier(
        max_depth=4,
        n_estimators=200,
        learning_rate=0.05,
        subsample=0.9,
        colsample_bytree=0.9,
        min_child_weight=5,
        objective="binary:logistic",
        eval_metric="auc",
        scale_pos_weight=scale_pos_weight,
        random_state=42,
        n_jobs=4,
    )
    model.fit(X_train, y_train, eval_set=[(X_val, y_val)], verbose=False)

    # ---- Evaluate on validation ----------------------------------------- #
    proba = model.predict_proba(X_val)[:, 1]
    pred = (proba >= 0.5).astype(int)

    val_single_class = va_pos == 0 or va_pos == n_val
    auc = float("nan") if val_single_class else float(roc_auc_score(y_val, proba))
    prec = float(precision_score(y_val, pred, zero_division=0))
    rec = float(recall_score(y_val, pred, zero_division=0))
    f1 = float(f1_score(y_val, pred, zero_division=0))
    acc = float(accuracy_score(y_val, pred))
    cm = confusion_matrix(y_val, pred).tolist()

    # Majority-class baseline on the validation split.
    val_base_rate = va_pos / n_val if n_val else float("nan")
    majority_class = 1 if val_base_rate >= 0.5 else 0
    majority_acc = max(val_base_rate, 1 - val_base_rate)

    # ---- Per-(pattern, timeframe) breakdown ------------------------------ #
    seg_df = meta_val.copy()
    seg_df["y"] = y_val.reset_index(drop=True)
    seg_df["p"] = proba
    segments = []
    small_segments = []
    for (pat, tf), grp in seg_df.groupby(["patternName", "timeframe"], dropna=False):
        support = len(grp)
        pos = int((grp["y"] == 1).sum())
        row = {
            "patternName": pat, "timeframe": tf, "support": support,
            "win_rate": round(pos / support, 3) if support else None,
        }
        if support < MIN_SEGMENT_VAL:
            row["note"] = "SKIPPED (support < %d)" % MIN_SEGMENT_VAL
            small_segments.append(row)
            continue
        if pos == 0 or pos == support:
            row["auc"] = None
            row["note"] = "single-class val segment (AUC undefined)"
        else:
            row["auc"] = round(float(roc_auc_score(grp["y"], grp["p"])), 3)
        segments.append(row)

    # ---- Feature importances -------------------------------------------- #
    importances = model.feature_importances_
    imp_pairs = sorted(
        zip(FEATURE_NAMES, [float(i) for i in importances]),
        key=lambda x: x[1], reverse=True,
    )
    top_importances = imp_pairs[:10]

    # ---- Persist artifacts ---------------------------------------------- #
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    model.get_booster().save_model(str(MODEL_PATH))

    beats_baseline = (not np.isnan(auc)) and (acc > majority_acc)
    has_signal = (not np.isnan(auc)) and (auc > 0.5)
    strong_signal = (not np.isnan(auc)) and (auc >= 0.60)
    predictive_segments = [s for s in segments if s.get("auc") not in (None,) and s["auc"] >= 0.58]

    metrics = {
        "model": "pattern_quality_v1",
        "n_total_usable": n,
        "n_train": n_train,
        "n_val": n_val,
        "base_win_rate_overall": round(base_rate, 4),
        "val_base_win_rate": round(val_base_rate, 4),
        "feature_names": FEATURE_NAMES,
        "scale_pos_weight": round(scale_pos_weight, 4),
        "overall_val": {
            "roc_auc": None if np.isnan(auc) else round(auc, 4),
            "precision": round(prec, 4),
            "recall": round(rec, 4),
            "f1": round(f1, 4),
            "accuracy": round(acc, 4),
            "confusion_matrix": cm,
        },
        "baseline": {
            "majority_class": majority_class,
            "majority_accuracy": round(majority_acc, 4),
            "auc": 0.5,
        },
        "by_pattern_timeframe": segments,
        "skipped_segments": small_segments,
        "top_feature_importances": [
            {"feature": f, "importance": round(i, 5)} for f, i in top_importances
        ],
        "verdict": {
            "beats_baseline": bool(beats_baseline),
            "auc_above_0_5": bool(has_signal),
            "auc_at_least_0_60": bool(strong_signal),
            "predictive_segments": predictive_segments,
        },
    }
    with open(METRICS_PATH, "w", encoding="utf-8") as fh:
        json.dump(metrics, fh, indent=2, default=str)

    # ---- Report ---------------------------------------------------------- #
    print("\n" + "=" * 78)
    print("FINAL REPORT")
    print("=" * 78)
    print(f"n_train = {n_train}   n_val = {n_val}   (temporal 80/20 on barTime)")
    print(f"overall base WIN rate = {base_rate:.3f}   "
          f"val-split WIN rate = {val_base_rate:.3f}")
    print("-" * 78)
    print("OVERALL VALIDATION METRICS")
    auc_str = "undefined (single-class val)" if np.isnan(auc) else f"{auc:.4f}"
    print(f"  ROC-AUC   : {auc_str}")
    print(f"  precision : {prec:.4f}")
    print(f"  recall    : {rec:.4f}")
    print(f"  F1        : {f1:.4f}")
    print(f"  accuracy  : {acc:.4f}")
    print(f"  confusion : {cm}  (rows=true [LOSS,WIN], cols=pred [LOSS,WIN])")
    print("-" * 78)
    print("MAJORITY-CLASS BASELINE (honest comparison)")
    print(f"  predict-all-{majority_class}: accuracy = {majority_acc:.4f}, AUC = 0.500")
    print("-" * 78)
    print("BY (patternName, timeframe) — validation, support >= %d" % MIN_SEGMENT_VAL)
    hdr = f"  {'pattern':<20}{'tf':<6}{'support':>8}{'win_rate':>10}{'AUC':>8}"
    print(hdr)
    if not segments:
        print("  (no segment met the support threshold)")
    for s in sorted(segments, key=lambda x: (str(x['patternName']), str(x['timeframe']))):
        auc_v = "n/a" if s.get("auc") is None else f"{s['auc']:.3f}"
        print(f"  {str(s['patternName']):<20}{str(s['timeframe']):<6}"
              f"{s['support']:>8}{s['win_rate']:>10.3f}{auc_v:>8}")
    if small_segments:
        print(f"  -- skipped {len(small_segments)} segment(s) with support < {MIN_SEGMENT_VAL}:")
        for s in sorted(small_segments, key=lambda x: (str(x['patternName']), str(x['timeframe']))):
            print(f"     {str(s['patternName']):<20}{str(s['timeframe']):<6} support={s['support']}")
    print("-" * 78)
    print("TOP FEATURE IMPORTANCES")
    for f, imp in top_importances:
        print(f"  {f:<24}{imp:.5f}")
    print("-" * 78)
    print("VERDICT")
    if np.isnan(auc):
        print("  INDETERMINATE — validation split is single-class; AUC undefined.")
    else:
        beat = "BEATS" if beats_baseline else "does NOT beat"
        signal = ("clear signal (AUC >= 0.60)" if strong_signal
                  else "weak/marginal signal (0.5 < AUC < 0.60)" if has_signal
                  else "NO signal (AUC <= 0.5 — coin flip)")
        print(f"  Overall AUC {auc:.4f} — {signal}.")
        print(f"  Model {beat} the majority-class baseline on accuracy "
              f"({acc:.4f} vs {majority_acc:.4f}).")
        print(f"  Predictive (pattern,tf) segments (AUC >= 0.58): "
              f"{len(predictive_segments)}")
        go = strong_signal and len(predictive_segments) >= 1
        weak_go = has_signal and not strong_signal
        if go:
            print("  ==> GO: real signal, meets the >=0.60 gate with >=1 predictive segment.")
        elif weak_go:
            print("  ==> BORDERLINE: beats coin flip but below the 0.60 deploy gate.")
        else:
            print("  ==> NO-GO: does not clear the gate; do NOT ship a coin-flip scorer.")
    print("=" * 78)
    print(f"\nArtifacts written:\n  model   -> {MODEL_PATH}\n  metrics -> {METRICS_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
