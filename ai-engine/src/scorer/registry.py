"""Model registry: artifact files on disk + ``ai_models`` rows (at most one active per kind, GO only)."""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from src.scorer.train import MODEL_KIND, TrainResult

INSERT_SQL = """
INSERT INTO "ai_models" ("id", "kind", "featureSet", "trainedAt", "dataWindow", "nTrain", "nHoldout",
  "metrics", "gate", "gateReasons", "artifactPath", "active")
VALUES (%(id)s, %(kind)s, %(featureSet)s, %(trainedAt)s, %(dataWindow)s::jsonb, %(nTrain)s, %(nHoldout)s,
  %(metrics)s::jsonb, %(gate)s, %(gateReasons)s, %(artifactPath)s, false)
"""
DEACTIVATE_SQL = 'UPDATE "ai_models" SET "active" = false WHERE "kind" = %(kind)s AND "active"'
ACTIVATE_SQL = 'UPDATE "ai_models" SET "active" = true WHERE "id" = %(id)s'
ACTIVE_SQL = 'SELECT "id", "artifactPath" FROM "ai_models" WHERE "kind" = %(kind)s AND "active" LIMIT 1'


def save_artifact(artifact: dict, models_dir: Path, model_id: str) -> Path:
    models_dir = Path(models_dir)
    models_dir.mkdir(parents=True, exist_ok=True)
    path = models_dir / f"{model_id}.json"
    path.write_text(json.dumps(artifact), encoding="utf-8")
    return path


def load_artifact(path: Path) -> dict:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def register(conn, result: TrainResult, artifact_path: Path, activate: bool) -> None:
    """Insert the model row; with ``activate`` (GO only) make it the single active model of its kind.

    ``artifactPath`` stores the file name only; serving resolves it against its own MODELS_DIR.
    One transaction: rolled back on any error.
    """
    if activate and result.gate != "GO":
        raise ValueError(f"refusing to activate a {result.gate} model ({', '.join(result.gate_reasons)})")
    params = {
        "id": result.model_id, "kind": MODEL_KIND, "featureSet": result.feature_set,
        "trainedAt": datetime.now(timezone.utc), "dataWindow": json.dumps(result.data_window),
        "nTrain": result.n_train, "nHoldout": result.n_holdout, "metrics": json.dumps(result.metrics),
        "gate": result.gate, "gateReasons": list(result.gate_reasons), "artifactPath": Path(artifact_path).name,
    }
    try:
        with conn.cursor() as cur:
            cur.execute(INSERT_SQL, params)
            if activate:
                cur.execute(DEACTIVATE_SQL, {"kind": MODEL_KIND})
                cur.execute(ACTIVATE_SQL, {"id": result.model_id})
        conn.commit()
    except Exception:
        conn.rollback()
        raise


def load_active(conn, kind: str = MODEL_KIND) -> tuple[str, Path] | None:
    with conn.cursor() as cur:
        cur.execute(ACTIVE_SQL, {"kind": kind})
        row = cur.fetchone()
    if not row:
        return None
    return str(row["id"]), Path(row["artifactPath"])
