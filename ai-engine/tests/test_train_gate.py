import numpy as np
import pytest

from src.scorer import registry, train
from src.scorer.features_fs1 import feature_names
from tests.fakes import FakeConn
from tests.synthetic import frame


@pytest.fixture(scope="module")
def strong():
    return train.train(frame(2000, 40, signal=True), seed=7)


def test_signal_passes_gate(strong):
    assert strong.gate == "GO", strong.gate_reasons
    assert strong.metrics["rocAuc"] >= 0.6
    assert strong.metrics["brier"] < strong.metrics["baselineBrier"]
    assert strong.n_holdout >= 300
    assert strong.model_id.startswith("xgb-entry-fs1-legacy-checks-")
    assert set(strong.metrics["slices"]) == {"strategy_key", "direction", "vix_regime"}


def test_noise_fails_on_auc():
    r = train.train(frame(2000, 40, signal=False, seed=3), seed=7)
    assert r.gate == "NO_GO"
    assert "auc<0.60" in r.gate_reasons


def test_tiny_data_fails_on_holdout_size():
    r = train.train(frame(200, 40, signal=True), seed=7)
    assert r.gate == "NO_GO"
    assert "holdout<300" in r.gate_reasons


def test_deterministic_for_seed():
    df = frame(300, 10, signal=True, seed=9)
    a, b = train.train(df, seed=7), train.train(df, seed=7)
    assert a.metrics["rocAuc"] == b.metrics["rocAuc"]
    assert a.metrics["brier"] == b.metrics["brier"]


def test_artifact_round_trip_predictions(strong, tmp_path):
    df = frame(50, 5, signal=True, seed=11)
    X = df[feature_names()].astype(float).to_numpy()
    path = registry.save_artifact(strong.artifact, tmp_path, strong.model_id)
    art = registry.load_artifact(path)
    b1 = train.booster_from_json(strong.artifact["classifier"])
    b2 = train.booster_from_json(art["classifier"])
    p1, p2 = train.predict_raw(b1, X, feature_names()), train.predict_raw(b2, X, feature_names())
    np.testing.assert_allclose(p1, p2)
    assert ((p1 >= 0) & (p1 <= 1)).all()
    cal = train.apply_calibrator(art["calibrator"], p1)
    assert ((cal >= 0) & (cal <= 1)).all()
    assert art["feature_names"] == feature_names()
    assert art["regressor"] is not None


def test_register_refuses_activating_no_go(tmp_path):
    r = train.train(frame(200, 40, signal=True), seed=7)
    conn = FakeConn()
    with pytest.raises(ValueError):
        registry.register(conn, r, tmp_path / "x.json", activate=True)
    assert conn.executed == []


class RegistryConn(FakeConn):
    def __init__(self):
        super().__init__()
        self.models = {}

    def cursor(self):
        conn = self

        class Cur:
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def execute(self, sql, params=None):
                conn.executed.append((sql, params))
                if sql.lstrip().startswith("INSERT"):
                    conn.models[params["id"]] = {"id": params["id"], "kind": params["kind"], "active": False,
                                                 "gate": params["gate"], "artifactPath": params["artifactPath"]}
                elif "SET \"active\" = false" in sql:
                    for m in conn.models.values():
                        if m["kind"] == params["kind"]:
                            m["active"] = False
                elif "SET \"active\" = true" in sql:
                    conn.models[params["id"]]["active"] = True
                self._rows = [m for m in conn.models.values() if m["active"]] if sql.lstrip().startswith("SELECT") else []

            def fetchone(self):
                return self._rows[0] if self._rows else None
        return Cur()


def test_register_activates_single_go_model(strong, tmp_path):
    conn = RegistryConn()
    conn.models["old"] = {"id": "old", "kind": "xgb-entry", "active": True, "gate": "GO", "artifactPath": "old.json"}
    path = registry.save_artifact(strong.artifact, tmp_path, strong.model_id)
    registry.register(conn, strong, path, activate=True)
    assert [m["id"] for m in conn.models.values() if m["active"]] == [strong.model_id]
    assert conn.commits == 1
    mid, p = registry.load_active(conn)
    assert mid == strong.model_id and p.name == f"{strong.model_id}.json"


def test_cli_from_records_jsonl(tmp_path, capsys):
    import importlib.util
    import json
    from pathlib import Path

    spec = importlib.util.spec_from_file_location(
        "train_entry_scorer", Path(__file__).resolve().parents[1] / "scripts" / "train_entry_scorer.py")
    cli = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(cli)

    df = frame(300, 10, signal=True)
    rows = []
    for _, r in df.iterrows():
        feats = {n: (None if r[n] != r[n] else float(r[n])) for n in feature_names()}
        rows.append({"id": r["id"], "source": "synthetic", "sourceId": r["source_id"],
                     "decidedAt": r["decided_at"].isoformat(), "strategyKey": r["strategy_key"],
                     "direction": "LONG", "setupGroupKey": r["setup_group_key"], "features": feats,
                     "ruleScore": r["rule_score"], "decision": {"taken": True},
                     "outcome": {"win": bool(r["win"]), "rMultiple": r["r_multiple"]}})
    p = tmp_path / "recs.jsonl"
    p.write_text("\n".join(json.dumps(x) for x in rows), encoding="utf-8")
    assert cli.main(["--records-jsonl", str(p), "--models-dir", str(tmp_path / "m"),
                     "--report-dir", str(tmp_path / "r")]) == 0
    out = json.loads(capsys.readouterr().out)
    assert out["gate"] == "NO_GO" and "holdout<300" in out["gateReasons"]
    report = Path(out["report"]).read_text(encoding="utf-8")
    assert "## Gate verdict" in report and "**NO_GO**" in report and "holdout<300" in report
    assert Path(out["artifact"]).exists()
