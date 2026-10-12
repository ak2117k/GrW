from fastapi.testclient import TestClient

from src.corpus.export import load_frame_from_records
from src.corpus.similar import SimilarIndex
from src.scorer.features_fs1 import feature_names
from src.scorer.serve import ScorerHolder
from src.scorer_main import create_app
from tests.synthetic import T0


def _rec(i, rsi, strategy="legacy.gated", direction="LONG", taken=True):
    feats = {n: None for n in feature_names()}
    feats.update({"rsi_5m_value": rsi, "rsi_5m_missing": 0, "adx_value": 20.0})
    return {"id": f"r{i}", "source": "t", "sourceId": f"s{i}", "decidedAt": T0, "strategyKey": strategy,
            "direction": direction, "setupGroupKey": f"g{i}", "features": feats, "ruleScore": 0.5,
            "decision": {"taken": taken}, "outcome": {"win": i % 2 == 0} if taken else {"win": None, "mfe": 1.0}}


def _index():
    recs = [_rec(0, 30.0), _rec(1, 50.0), _rec(2, 52.0), _rec(3, 70.0), _rec(4, 50.0, strategy="legacy.ungated"),
            _rec(5, 51.0, taken=False), _rec(6, 50.0, direction="SHORT")]
    return SimilarIndex(load_frame_from_records(recs, taken_only=False, require_label=False))


def _q(rsi):
    f = {n: None for n in feature_names()}
    f.update({"rsi_5m_value": rsi, "rsi_5m_missing": 0, "adx_value": 20.0})
    return f


def test_k_nearest_deterministic_order():
    idx = _index()
    items = idx.query(_q(50.0), 3, {})
    # r1, r4 and r6 all sit at distance 0; the tie is broken by id
    assert [i["id"] for i in items] == ["r1", "r4", "r6"]
    assert items[0]["distance"] == 0.0
    assert idx.query(_q(50.0), 3, {}) == items


def test_filters_respected():
    idx = _index()
    items = idx.query(_q(50.0), 10, {"strategyKey": "legacy.gated", "direction": "LONG"})
    assert {i["strategyKey"] for i in items} == {"legacy.gated"}
    assert "r6" not in {i["id"] for i in items} and "r4" not in {i["id"] for i in items}
    assert [i["id"] for i in items][:3] == ["r1", "r5", "r2"]


def test_skipped_setups_returned_with_decision():
    items = _index().query(_q(51.0), 1, {})
    assert items[0]["id"] == "r5" and items[0]["decision"] == {"taken": False}
    assert items[0]["outcome"]["win"] is None


def test_empty_index_returns_empty():
    idx = SimilarIndex(load_frame_from_records([]))
    assert idx.query(_q(50.0), 5, {}) == []


def test_route_with_features_and_with_breakdown(tmp_path):
    app = create_app(holder=ScorerHolder(tmp_path), similar=_index(), from_env=False)
    c = TestClient(app)
    res = c.post("/corpus/similar", json={"features": _q(50.0), "k": 2, "filters": {"direction": "LONG"}})
    assert res.status_code == 200
    assert [i["id"] for i in res.json()["items"]] == ["r1", "r4"]
    res2 = c.post("/corpus/similar", json={
        "features": None, "k": 2, "context": {"decidedAt": "2026-06-01T04:00:00Z"},
        "breakdown": {"checks": [{"name": "RSI on 5m", "passed": True, "detail": {"rsi": 50.0}}]}})
    assert res2.status_code == 200 and len(res2.json()["items"]) == 2
    assert c.post("/corpus/similar", json={"features": None}).status_code == 422
    assert c.post("/corpus/similar", json={"features": _q(1), "k": 0}).status_code == 422


def test_route_empty_index(tmp_path):
    c = TestClient(create_app(holder=ScorerHolder(tmp_path), similar=None, from_env=False))
    assert c.post("/corpus/similar", json={"features": _q(50.0)}).json() == {"items": []}
