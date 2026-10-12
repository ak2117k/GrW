"""Tabular view of ``ai_decision_records`` for training, retrieval and CSV export (no parquet: disk budget).

One row per record: the feature-set columns in ``feature_names()`` order, then ``META_COLUMNS``.
By default only taken setups with a known win/loss label are kept (the training population);
``taken_only=False, require_label=False`` gives every record (the retrieval index).
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from src.scorer import features_fs1

FEATURE_SETS = {features_fs1.FEATURE_SET: features_fs1}

META_COLUMNS = [
    "id", "source", "source_id", "setup_group_key", "decided_at", "strategy_key", "direction", "vix_regime",
    "rule_score", "taken", "win", "r_multiple", "r_derived", "decision_json", "outcome_json",
]

FRAME_SQL = (
    'SELECT "id", "source", "sourceId", "decidedAt", "strategyKey", "direction", "setupGroupKey", '
    '"features", "ruleScore", "decision", "outcome" FROM "ai_decision_records" '
    'WHERE "featureSet" = %(featureSet)s AND "kind" = %(kind)s ORDER BY "decidedAt", "id"'
)


def _obj(v: Any) -> Any:
    if isinstance(v, str):
        try:
            return json.loads(v)
        except ValueError:
            return None
    return v


def _utc(v: Any) -> datetime:
    if isinstance(v, str):
        v = datetime.fromisoformat(v.replace("Z", "+00:00"))
    return v if v.tzinfo else v.replace(tzinfo=timezone.utc)


def _vix_regime(feats: dict) -> str | None:
    for r in features_fs1.VIX_REGIMES:
        if feats.get(f"vix_regime_{r}") == 1:
            return r
    return None


def _f(v: Any) -> float:
    return np.nan if v is None else float(v)


def load_frame_from_records(records: list[dict], feature_set: str = features_fs1.FEATURE_SET,
                            taken_only: bool = True, require_label: bool = True) -> pd.DataFrame:
    names = FEATURE_SETS[feature_set].feature_names()
    rows = []
    for r in records:
        feats = _obj(r.get("features")) or {}
        outcome = _obj(r.get("outcome"))
        decision = _obj(r.get("decision")) or {}
        taken = bool(decision.get("taken", True))
        win = outcome.get("win") if isinstance(outcome, dict) else None
        if taken_only and not taken:
            continue
        if require_label and win is None:
            continue
        row = {n: _f(feats.get(n)) for n in names}
        row.update({
            "id": str(r["id"]),
            "source": r.get("source"),
            "source_id": str(r.get("sourceId")),
            "setup_group_key": r.get("setupGroupKey"),
            "decided_at": _utc(r["decidedAt"]),
            "strategy_key": r.get("strategyKey"),
            "direction": r.get("direction"),
            "vix_regime": _vix_regime(feats),
            "rule_score": _f(r.get("ruleScore")),
            "taken": int(taken),
            "win": np.nan if win is None else int(bool(win)),
            "r_multiple": _f(outcome.get("rMultiple")) if isinstance(outcome, dict) else np.nan,
            "r_derived": (outcome.get("rDerived") if isinstance(outcome, dict) else None),
            "decision_json": json.dumps(decision, sort_keys=True, default=str),
            "outcome_json": json.dumps(outcome, sort_keys=True, default=str) if outcome is not None else None,
        })
        rows.append(row)
    df = pd.DataFrame(rows, columns=names + META_COLUMNS)
    if len(df):
        df["decided_at"] = pd.to_datetime(df["decided_at"], utc=True)
    return df.reset_index(drop=True)


def load_frame(conn, feature_set: str, kind: str = "ENTRY_SETUP", taken_only: bool = True,
               require_label: bool = True) -> pd.DataFrame:
    with conn.cursor() as cur:
        cur.execute(FRAME_SQL, {"featureSet": feature_set, "kind": kind})
        records = cur.fetchall()
    return load_frame_from_records(records, feature_set, taken_only=taken_only, require_label=require_label)


def export_csv(df: pd.DataFrame, path: Path) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    out = df.copy()
    out["decided_at"] = out["decided_at"].map(lambda d: d.isoformat())
    out.to_csv(path, index=False)


def read_csv(path: Path) -> pd.DataFrame:
    df = pd.read_csv(path, dtype={"id": str, "source_id": str, "setup_group_key": str})
    df["decided_at"] = pd.to_datetime(df["decided_at"], utc=True, format="ISO8601")
    return df
