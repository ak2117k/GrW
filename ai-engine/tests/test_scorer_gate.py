"""The scorer never serves a model whose training gate was not GO (review follow-up to B6/B7)."""
import json
import logging

import pytest
from fastapi.testclient import TestClient

from src.scorer import registry, train
from src.scorer.serve import ScorerHolder
from src.scorer_main import create_app
from tests.fakes import FakeConn
from tests.synthetic import frame

BODY = {"featureSet": "fs1-legacy-checks", "breakdown": None,
        "context": {"decidedAt": "2026-06-01T04:00:00Z", "direction": "LONG", "strategyKey": "legacy.gated"}}


@pytest.fixture(scope="module")
def go():
    r = train.train(frame(2000, 40, signal=True), seed=7)
    assert r.gate == "GO", r.gate_reasons
    return r


@pytest.fixture(scope="module")
def no_go():
    r = train.train(frame(200, 40, signal=True), seed=7)
    assert r.gate == "NO_GO"
    return r


def _legacy(artifact: dict) -> dict:
    """An artifact as B6 first wrote them: no gate recorded."""
    return {k: v for k, v in artifact.items() if k not in ("gate", "gateReasons")}


def test_artifact_records_its_gate(go, no_go):
    assert go.artifact["gate"] == "GO" and go.artifact["gateReasons"] == []
    assert no_go.artifact["gate"] == "NO_GO" and no_go.artifact["gateReasons"] == no_go.gate_reasons


def test_go_artifact_is_served(go, tmp_path):
    registry.save_artifact(go.artifact, tmp_path, go.model_id)
    h = ScorerHolder(tmp_path)
    h.load(go.model_id)
    assert h.mode == f"model:{go.model_id}"


def test_no_go_artifact_is_refused_and_logged_once(no_go, tmp_path, caplog):
    registry.save_artifact(no_go.artifact, tmp_path, no_go.model_id)
    h = ScorerHolder(tmp_path)
    with caplog.at_level(logging.WARNING):
        h.load(no_go.model_id)
    assert h.mode == "rule"
    refusals = [r for r in caplog.records if "refusing" in r.getMessage()]
    assert len(refusals) == 1 and "NO_GO" in refusals[0].getMessage()
    body = TestClient(create_app(holder=h, from_env=False)).post("/score", json=BODY).json()
    assert body["source"] == "rule"


def test_no_go_artifact_is_refused_even_if_registry_says_go(no_go, tmp_path):
    registry.save_artifact(no_go.artifact, tmp_path, no_go.model_id)
    h = ScorerHolder(tmp_path)
    h.load(no_go.model_id, registry_gate="GO")
    assert h.mode == "rule"


def test_refusal_also_drops_the_artifacts_rule_calibrator(no_go, tmp_path):
    registry.save_artifact(no_go.artifact, tmp_path, no_go.model_id)
    h = ScorerHolder(tmp_path)
    h.load(no_go.model_id)
    assert h.rule_calibrator is None


def test_legacy_artifact_without_gate_needs_a_go_registry_row(go, tmp_path):
    registry.save_artifact(_legacy(go.artifact), tmp_path, go.model_id)
    h = ScorerHolder(tmp_path)
    h.load(go.model_id)
    assert h.mode == "rule"
    h.load(go.model_id, registry_gate="NO_GO")
    assert h.mode == "rule"
    h.load(go.model_id, registry_gate="GO")
    assert h.mode == f"model:{go.model_id}"


def test_gate_of_reads_the_registry_row():
    conn = FakeConn(tables={"ai_models": [{"gate": "NO_GO"}]})
    assert registry.gate_of(conn, "xgb-entry-x") == "NO_GO"
    sql, params = conn.executed[0]
    assert '"gate"' in sql and params == {"id": "xgb-entry-x"}
    assert registry.gate_of(FakeConn(tables={"ai_models": []}), "nope") is None


def test_startup_refuses_explicit_no_go_model(no_go, tmp_path, monkeypatch):
    registry.save_artifact(no_go.artifact, tmp_path, no_go.model_id)
    monkeypatch.setenv("MODELS_DIR", str(tmp_path))
    monkeypatch.setenv("SCORER_MODEL_ID", no_go.model_id)
    monkeypatch.delenv("AI_DB_URL", raising=False)
    with TestClient(create_app()) as c:
        assert c.get("/health").json()["scorer"] == "rule"


class _ClosableConn(FakeConn):
    def close(self):
        pass


def test_startup_serves_legacy_artifact_when_registry_row_is_go(go, tmp_path, monkeypatch):
    registry.save_artifact(_legacy(go.artifact), tmp_path, go.model_id)
    conn = _ClosableConn(tables={"ai_models": [{"id": go.model_id, "gate": "GO", "artifactPath": f"{go.model_id}.json"}]})
    import src.corpus.db as db
    monkeypatch.setattr(db, "connect", lambda url: conn)
    monkeypatch.setenv("MODELS_DIR", str(tmp_path))
    monkeypatch.setenv("SCORER_MODEL_ID", go.model_id)
    monkeypatch.setenv("AI_DB_URL", "postgresql://fake")
    with TestClient(create_app()) as c:
        assert c.get("/health").json()["scorer"] == f"model:{go.model_id}"
