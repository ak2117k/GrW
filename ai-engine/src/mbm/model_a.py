"""MBM Model A — move & mood. Per horizon: calibrated P(big move), range quantiles, regime.

LightGBM classifier + isotonic calibration (fitted on the last `cal_months` of each training
window, which the classifier does not see), LightGBM quantile regressors for p25/p50/p75 of the
range in bp. Walk-forward: every blind month is scored by models trained strictly before it
(expanding window, ≥ `min_train_months`). Decision rows are 5m bar ends sampled every
DECISION_STEP minutes; the `next` horizon uses only the 15:15 IST row (the carry decision).
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field

import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.isotonic import IsotonicRegression
from sklearn.metrics import roc_auc_score

from . import labels as L
from .model_consts import NEXT_DECISION_MIN, QUANTILES, REGIME_BANDS, regime  # noqa: F401 (re-exported)
from .features import DRIVER_GROUPS, FEATURE_SET, _annotate, build_features, daily_context, feature_columns, to_5m

DECISION_STEP = 15
FIRST_DECISION_MIN = 9 * 60 + 30
LAST_DECISION_MIN = 15 * 60 + 15
MIN_BARS_PER_DAY = 60          # 5m bars; drops muhurat/special short sessions
CLS_PARAMS = dict(objective="binary", n_estimators=300, learning_rate=0.03, num_leaves=31,
                  min_child_samples=200, subsample=0.8, subsample_freq=1, colsample_bytree=0.8,
                  reg_lambda=1.0, n_jobs=4, verbose=-1)
Q_PARAMS = dict(objective="quantile", n_estimators=200, learning_rate=0.05, num_leaves=31,
                min_child_samples=200, subsample=0.8, subsample_freq=1, colsample_bytree=0.8,
                n_jobs=4, verbose=-1)


@dataclass
class WalkForward:
    min_train_months: int = 12
    cal_months: int = 2
    q_every: int = 3                  # quantile models refit every N test months
    quantiles: bool = True
    last_n_months: int | None = None  # score only the last N months (ablation)
    timings: dict = field(default_factory=dict)


# ---------------------------------------------------------------- dataset

def build_dataset(inputs: dict) -> pd.DataFrame:
    """Features at decision rows + labels, thresholds and baseline for every horizon."""
    f = build_features(inputs)
    n = f.groupby("date")["close"].transform("size")
    f = f[n >= MIN_BARS_PER_DAY]
    dec = f[(f["mod"] % DECISION_STEP == 0) & (f["mod"] >= FIRST_DECISION_MIN)
            & (f["mod"] <= LAST_DECISION_MIN)]
    atr = daily_context(_annotate(to_5m(inputs["instrument"])))["atr14"]
    lab = L.compute_labels(inputs["instrument"], dec, atr)
    parts = [dec, lab]
    for h in L.HORIZONS:
        parts.append(L.big_labels(dec, lab, h).add_suffix(f"_{h}"))
    ds = pd.concat(parts, axis=1)
    ds["month"] = ds["date"].dt.to_period("M")
    return ds


LABEL_PREFIXES = ("range_pts_", "range_bp_", "range_atr_", "absmove_pts_", "absmove_bp_",
                  "threshold_bp_", "big_", "baseline_p_")


def model_columns(ds: pd.DataFrame, groups: tuple[str, ...] = DRIVER_GROUPS) -> list[str]:
    """Feature columns of a dataset (labels and bookkeeping excluded)."""
    return [c for c in feature_columns(ds, groups) if c != "month" and not c.startswith(LABEL_PREFIXES)]


def horizon_frame(ds: pd.DataFrame, h: str) -> pd.DataFrame:
    hf = ds[ds["mod"] == NEXT_DECISION_MIN] if h == "next" else ds
    return hf[hf[f"big_{h}"].notna() & hf[f"baseline_p_{h}"].notna()]


# ---------------------------------------------------------------- models

def fit_classifier(X: pd.DataFrame, y: np.ndarray, Xc: pd.DataFrame, yc: np.ndarray):
    clf = lgb.LGBMClassifier(**CLS_PARAMS).fit(X, y)
    iso = IsotonicRegression(y_min=0.0, y_max=1.0, out_of_bounds="clip")
    iso.fit(clf.predict_proba(Xc)[:, 1], yc)
    return clf, iso


def fit_quantiles(X: pd.DataFrame, y: np.ndarray) -> dict:
    return {q: lgb.LGBMRegressor(alpha=q, **Q_PARAMS).fit(X, y) for q in QUANTILES}


def walk_forward(ds: pd.DataFrame, h: str, cols: list[str], cfg: WalkForward | None = None) -> pd.DataFrame:
    cfg = cfg or WalkForward()
    hf = horizon_frame(ds, h)
    months = sorted(hf["month"].unique())
    test_months = months[cfg.min_train_months:]
    if cfg.last_n_months:
        test_months = test_months[-cfg.last_n_months:]
    out, qmodels, since_q = [], None, None
    t0 = time.time()
    for m in test_months:
        start = m.start_time
        train = hf[hf["date"] < start]
        if h == "next":   # embargo: the last session's label is realised inside the test month
            train = train[train["date"] < train["date"].max()]
        cal_start = (m - cfg.cal_months).start_time
        fit, cal = train[train["date"] < cal_start], train[train["date"] >= cal_start]
        test = hf[hf["month"] == m]
        if len(test) == 0 or fit[f"big_{h}"].nunique() < 2 or cal[f"big_{h}"].nunique() < 2:
            continue
        clf, iso = fit_classifier(fit[cols], fit[f"big_{h}"].to_numpy(), cal[cols], cal[f"big_{h}"].to_numpy())
        raw = clf.predict_proba(test[cols])[:, 1]
        r = pd.DataFrame({"date": test["date"], "mod": test["mod"], "month": test["month"].astype(str),
                          "y": test[f"big_{h}"], "p_raw": raw, "p": iso.predict(raw),
                          "base": test[f"baseline_p_{h}"], "range_bp": test[f"range_bp_{h}"],
                          "atr14_bp": test["atr14_bp"]}, index=test.index)
        if cfg.quantiles:
            if qmodels is None or since_q >= cfg.q_every:
                qmodels, since_q = fit_quantiles(train[cols], train[f"range_bp_{h}"].to_numpy()), 0
            since_q += 1
            for q, mdl in qmodels.items():
                r[f"q{int(q * 100)}_bp"] = mdl.predict(test[cols])
        out.append(r)
    cfg.timings[h] = round(time.time() - t0, 1)
    return pd.concat(out) if out else pd.DataFrame()


# ---------------------------------------------------------------- metrics

def _brier(y, p) -> float:
    return float(np.mean((np.asarray(p) - np.asarray(y)) ** 2))


def monthly_metrics(preds: pd.DataFrame) -> pd.DataFrame:
    rows = []
    for m, g in preds.groupby("month"):
        auc = roc_auc_score(g["y"], g["p"]) if g["y"].nunique() == 2 else np.nan
        rows.append({"month": m, "n": len(g), "auc": auc, "brier": _brier(g["y"], g["p"]),
                     "brier_base": _brier(g["y"], g["base"]), "big_rate": g["y"].mean()})
    return pd.DataFrame(rows)


def summary(preds: pd.DataFrame, last: int = 3) -> dict:
    mm = monthly_metrics(preds)
    tail = mm.tail(last)
    lastp = preds[preds["month"].isin(tail["month"])]
    return {
        "n_test": int(len(preds)), "n_months": int(len(mm)),
        "auc_all": float(roc_auc_score(preds["y"], preds["p"])),
        "brier_all": _brier(preds["y"], preds["p"]), "brier_base_all": _brier(preds["y"], preds["base"]),
        "last_months": tail["month"].tolist(), "last_auc": [round(float(a), 4) for a in tail["auc"]],
        "last_n": [int(n) for n in tail["n"]],
        "last_brier": _brier(lastp["y"], lastp["p"]), "last_brier_base": _brier(lastp["y"], lastp["base"]),
        "last_auc_pooled": round(float(roc_auc_score(lastp["y"], lastp["p"])), 4) if lastp["y"].nunique() > 1 else float("nan"),
    }


def gate(preds: pd.DataFrame, min_auc: float = 0.65, last: int = 3, min_obs: int = 300,
         month_floor: float = 0.55) -> dict:
    """PASS iff the POOLED AUC over the last `last` blind months >= min_auc, no single one of
    those months below `month_floor`, Brier over them below the trailing-median baseline, and
    >= min_obs blind observations in total.

    Owner decision 2026-10-19: one month is ~21 trading days, so a single month's AUC has a
    90% interval of about +/-0.07; "each of the last 3 >= 0.65" passed a steady AUC-0.74 model
    only ~57% of the time historically. The per-month floor keeps a within-month check."""
    s = summary(preds, last)
    checks = {
        "auc_pooled_last_months": len(s["last_auc"]) == last and s["last_auc_pooled"] >= min_auc,
        "auc_month_floor": len(s["last_auc"]) == last and all(a >= month_floor for a in s["last_auc"]),
        "brier_below_baseline": s["last_brier"] < s["last_brier_base"],
        "min_obs": s["n_test"] >= min_obs,
    }
    return {**s, "checks": checks, "pass": all(checks.values())}


def calibration_table(preds: pd.DataFrame, bins: int = 10) -> pd.DataFrame:
    edges = np.linspace(0, 1, bins + 1)
    b = pd.cut(preds["p"], edges, include_lowest=True)
    g = preds.groupby(b, observed=True)
    return pd.DataFrame({"n": g.size(), "mean_p": g["p"].mean(), "big_rate": g["y"].mean()}).reset_index(names="bucket")


def regime_table(preds: pd.DataFrame) -> pd.DataFrame:
    r = pd.Series(regime(preds["p"].to_numpy()), index=preds.index)
    g = preds.assign(regime=r).groupby("regime")
    t = pd.DataFrame({"n": g.size(), "share": g.size() / len(preds), "big_rate": g["y"].mean(),
                      "median_range_bp": g["range_bp"].median()})
    return t.reindex(["QUIET", "NORMAL", "ACTIVE"]).reset_index()


def quantile_coverage(preds: pd.DataFrame) -> dict:
    out = {}
    for q in QUANTILES:
        c = f"q{int(q * 100)}_bp"
        if c in preds:
            out[c] = float((preds["range_bp"] <= preds[c]).mean())
    return out


def ablation(ds: pd.DataFrame, h: str, last_n_months: int = 12) -> list[dict]:
    """Gate metric with all drivers, price-only, and without each driver group."""
    full = model_columns(ds, DRIVER_GROUPS)
    configs = {"all": DRIVER_GROUPS, "price_only": ()}
    configs |= {f"-{g}": tuple(x for x in DRIVER_GROUPS if x != g) for g in DRIVER_GROUPS}
    rows = []
    for name, groups in configs.items():
        cols = full if name == "all" else model_columns(ds, groups)
        p = walk_forward(ds, h, cols, WalkForward(quantiles=False, last_n_months=last_n_months))
        s = summary(p, 3)
        rows.append({"config": name, "auc_last12": round(s["auc_all"], 4),
                     "auc_last3_mean": round(float(np.mean(s["last_auc"])), 4),
                     "auc_last3_min": round(float(np.min(s["last_auc"])), 4),
                     "brier_last12": round(s["brier_all"], 5), "brier_base_last12": round(s["brier_base_all"], 5)})
    return rows


# ---------------------------------------------------------------- final models

def fit_final(ds: pd.DataFrame, h: str, cols: list[str], cal_months: int = 2) -> dict:
    """Production candidate trained on all labelled rows (calibrated on the last cal_months)."""
    hf = horizon_frame(ds, h)
    last_m = hf["month"].max()
    cal_start = (last_m - (cal_months - 1)).start_time
    fit, cal = hf[hf["date"] < cal_start], hf[hf["date"] >= cal_start]
    clf, iso = fit_classifier(fit[cols], fit[f"big_{h}"].to_numpy(), cal[cols], cal[f"big_{h}"].to_numpy())
    q = fit_quantiles(hf[cols], hf[f"range_bp_{h}"].to_numpy())
    return {"featureSet": FEATURE_SET, "horizon": h, "columns": cols, "classifier": clf,
            "isotonic": {"x": iso.X_thresholds_.tolist(), "y": iso.y_thresholds_.tolist()},
            "quantiles": q, "regime_bands": list(REGIME_BANDS),
            "trained_through": str(hf["date"].max().date()), "n_train": int(len(hf))}
