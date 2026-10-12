import pytest
from fastapi.testclient import TestClient

from src.scorer import registry, train
from src.scorer.serve import ScorerHolder
from src.scorer_main import create_app
from tests.synthetic import frame

BREAKDOWN = {"checks": [
    {"name": "RSI on 5m", "passed": True, "points": 10, "detail": {"rsi": 61.2}},
    {"name": "ADX trend strength", "passed": False, "points": 0, "detail": {"adx": 14.0}},
    {"name": "SuperTrend match", "passed": False, "detail": {"reason": "insufficient candles"}},
]}
CONTEXT = {"decidedAt": "2026-06-01T04:00:00Z", "direction": "LONG", "strategyKey": "legacy.gated",
           "vixAtEntry": 13.2, "vixRegime": "NORMAL", "adRatio": None, "profitTargetSource": "fallback-2pct"}


def _client(holder):
    return TestClient(create_app(holder=holder, from_env=False))


@pytest.fixture(scope="module")
def models_dir(tmp_path_factory):
    d = tmp_path_factory.mktemp("models")
    r = train.train(frame(400, 10, signal=True), seed=7)
    registry.save_artifact(r.artifact, d, r.model_id)
    return d, r.model_id


def test_rule_mode_shape(tmp_path):
    c = _client(ScorerHolder(tmp_path))
    res = c.post("/score", json={"featureSet": "fs1-legacy-checks", "breakdown": BREAKDOWN, "context": CONTEXT})
    assert res.status_code == 200
    body = res.json()
    assert body["source"] == "rule" and body["expectedR"] is None
    assert body["pWin"] == pytest.approx(0.5)  # 1 passed of 2 evaluable checks
    assert body["featureSet"] == "fs1-legacy-checks"
    assert "supertrend" in body["missing"]


def test_rule_mode_null_breakdown(tmp_path):
    c = _client(ScorerHolder(tmp_path))
    body = c.post("/score", json={"featureSet": "fs1-legacy-checks", "breakdown": None, "context": CONTEXT}).json()
    assert body["source"] == "rule" and 0 <= body["pWin"] <= 1


def test_model_mode(models_dir):
    d, mid = models_dir
    h = ScorerHolder(d)
    h.load(mid)
    c = _client(h)
    body = c.post("/score", json={"featureSet": "fs1-legacy-checks", "breakdown": BREAKDOWN, "context": CONTEXT}).json()
    assert body["source"] == "model" and body["modelId"] == mid
    assert 0.0 <= body["pWin"] <= 1.0
    assert isinstance(body["expectedR"], float)
    assert c.get("/health").json()["scorer"] == f"model:{mid}"


def test_unknown_feature_set_422(tmp_path):
    c = _client(ScorerHolder(tmp_path))
    res = c.post("/score", json={"featureSet": "fs9", "breakdown": None, "context": CONTEXT})
    assert res.status_code == 422


@pytest.mark.parametrize("body", [{}, {"featureSet": "fs1-legacy-checks"}, {"featureSet": 3, "context": "x"},
                                  {"featureSet": "fs1-legacy-checks", "context": {}, "extra": 1}])
def test_malformed_body_422(tmp_path, body):
    assert _client(ScorerHolder(tmp_path)).post("/score", json=body).status_code == 422


def test_leakage_context_422(tmp_path):
    c = _client(ScorerHolder(tmp_path))
    res = c.post("/score", json={"featureSet": "fs1-legacy-checks", "breakdown": None,
                                 "context": {**CONTEXT, "maxFavorable": 3.0}})
    assert res.status_code == 422


def test_health_rule_mode(tmp_path):
    body = _client(ScorerHolder(tmp_path)).get("/health").json()
    assert body["status"] == "ok" and body["scorer"] == "rule"


def test_missing_artifact_raises_and_startup_degrades(tmp_path, monkeypatch):
    with pytest.raises(FileNotFoundError):
        ScorerHolder(tmp_path).load("xgb-entry-nope")
    monkeypatch.setenv("MODELS_DIR", str(tmp_path))
    monkeypatch.setenv("SCORER_MODEL_ID", "xgb-entry-nope")
    monkeypatch.delenv("AI_DB_URL", raising=False)
    with TestClient(create_app()) as c:
        assert c.get("/health").json()["scorer"] == "rule"


def test_startup_loads_explicit_model(models_dir, monkeypatch):
    d, mid = models_dir
    monkeypatch.setenv("MODELS_DIR", str(d))
    monkeypatch.setenv("SCORER_MODEL_ID", mid)
    monkeypatch.delenv("AI_DB_URL", raising=False)
    with TestClient(create_app()) as c:
        assert c.get("/health").json()["scorer"] == f"model:{mid}"
