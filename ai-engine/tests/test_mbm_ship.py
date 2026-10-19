import argparse
import importlib.util
import json
import subprocess
from pathlib import Path

import pandas as pd
import pytest

spec = importlib.util.spec_from_file_location(
    "mbm_ship", Path(__file__).resolve().parents[1] / "scripts" / "mbm_ship.py")
S = importlib.util.module_from_spec(spec)
spec.loader.exec_module(S)

GATE = {"n_test": 500, "n_months": 12, "last_months": ["2026-09", "2026-10"], "pass": True,
        "checks": {"auc_pooled_last_months": True, "min_obs": True}}
METRICS = {"featureSet": "mbm-fs2", "instrument": "NIFTY", "built": "2026-10-19",
           "horizons": {"30m": GATE, "60m": {**GATE, "pass": False, "checks": {"auc_month_floor": False}}}}
META = {"featureSet": "mbm-fs2", "n_train": 1234, "trained_through": "2026-10-16"}


def test_registry_row_follows_contract():
    r = S.registry_row("NIFTY", "20261019-fs2", "30m", METRICS, META)
    assert r["id"] == "mbm-move-nifty-30m-20261019"
    assert r["kind"] == "mbm-move" and r["gate"] == "GO" and r["gateReasons"] == []
    assert r["artifactPath"] == "mbm/nifty/20261019-fs2/30m"
    assert (r["instrument"], r["horizon"], r["nTrain"], r["nHoldout"]) == ("NIFTY", "30m", 1234, 500)
    assert r["metrics"] is GATE


def test_failed_gate_is_no_go_and_never_activated():
    r = S.registry_row("NIFTY", "20261019-fs2", "60m", METRICS, META)
    assert r["gate"] == "NO_GO" and r["gateReasons"] == ["auc_month_floor"]
    with pytest.raises(ValueError):
        S.registry_sql([r])


def test_registry_sql_deactivates_siblings_before_upsert_in_one_transaction():
    sql = S.registry_sql([S.registry_row("NIFTY", "20261019-fs2", "30m", METRICS, META)])
    assert sql.startswith("BEGIN;") and sql.rstrip().endswith("COMMIT;")
    upd = sql.index("UPDATE ai_models SET active = false")
    ins = sql.index("INSERT INTO ai_models")
    assert upd < ins
    assert "kind = 'mbm-move' AND instrument = 'NIFTY' AND horizon = '30m'" in sql[upd:ins]
    assert "id <> 'mbm-move-nifty-30m-20261019'" in sql[upd:ins]
    assert "ON CONFLICT (id) DO UPDATE" in sql and "active = true" in sql
    assert "ARRAY[]::text[]" in sql


def test_literals_escape_quotes():
    assert S.lit("it's") == "'it''s'"
    assert S.lit(None) == "NULL" and S.lit(True) == "true" and S.lit(3) == "3"
    gate = {**GATE, "note": "owner's call"}
    sql = S.registry_sql([S.registry_row("NIFTY", "20261019-fs2", "30m", {**METRICS, "horizons": {"30m": gate}}, META)])
    assert "owner''s call" in sql


def test_seed_sql_stages_then_upserts_utc_bar_starts():
    df = pd.DataFrame({"ts": pd.to_datetime(["2026-10-19 09:15", "2026-10-19 09:16"]).tz_localize("Asia/Kolkata"),
                       "open": [1.0, 2.0], "high": [1.5, 2.5], "low": [0.5, 1.5], "close": [1.2, 2.2],
                       "volume": pd.array([None, 7], dtype="Int64")})
    lines = S.bars_csv("NIFTY", df)
    assert lines == ["NIFTY,2026-10-19T03:45:00Z,1.0,1.5,0.5,1.2,0.0",
                     "NIFTY,2026-10-19T03:46:00Z,2.0,2.5,1.5,2.2,7.0"]
    sql = S.seed_sql("NIFTY", lines)
    copy = sql.index("COPY mbm_bars_stage")
    end = sql.index("\\.\n")
    assert sql.index("CREATE TEMP TABLE mbm_bars_stage") < copy < sql.index(lines[0]) < end
    assert sql.index("INSERT INTO mbm_bars_1m") > end
    assert "ON CONFLICT (series, ts) DO UPDATE" in sql and "ON COMMIT DROP" in sql


def test_universe_is_indices_vix_and_heavyweights_only():
    manifest = {"NIFTY": {"1m": {}}, "BANKNIFTY": {"1m": {}}, "INDIAVIX": {"1m": {}}, "EQ_TCS": {"1m": {}},
                "FUT_NIFTY_20261027": {"1m": {}}, "YF_ES_F": {"1m": {}}, "USDINR_ANGEL": {"1m": {}},
                "EQ_DAILYONLY": {"1d": {}}}
    assert S.universe_series(manifest) == ["BANKNIFTY", "EQ_TCS", "INDIAVIX", "NIFTY"]


def test_verify_sql_is_read_only():
    sql = S.verify_sql()
    assert sql.startswith("SET default_transaction_read_only = on;")
    for word in ("INSERT", "UPDATE", "DELETE", "DROP", "ALTER"):
        assert word not in sql


def _models(tmp_path, metrics=METRICS):
    src = tmp_path / "models"
    (src).mkdir()
    (src / "metrics.json").write_text(json.dumps(metrics))
    for h in ("30m", "60m"):
        (src / h).mkdir()
        for f in S.MODEL_FILES:
            (src / h / f).write_text(json.dumps(META) if f == "meta.json" else f"{h}-{f}")
    return src


def test_ship_dry_run_touches_nothing(tmp_path, capsys):
    src = _models(tmp_path)

    def boom(*a, **k):
        raise AssertionError("dry-run must not run anything")
    a = argparse.Namespace(
        version="20261019-fs2", instrument="NIFTY", horizons=["30m"], models_dir=src, store=tmp_path,
        vps=None, ssh_key=None, dry_run=True)
    assert S.cmd_ship(a, run=boom) == 0
    out = capsys.readouterr().out
    assert "/opt/grw/models/mbm/nifty/20261019-fs2/30m.partial/" in out and "INSERT INTO ai_models" in out


def test_ship_refuses_no_go_horizon(tmp_path):
    src = _models(tmp_path)
    a = argparse.Namespace(
        version="20261019-fs2", instrument="NIFTY", horizons=["30m", "60m"], models_dir=src, store=tmp_path,
        vps=None, ssh_key=None, dry_run=True)
    assert S.cmd_ship(a) == 2


def test_ship_copies_files_before_registry_and_checks_sha(tmp_path):
    src = _models(tmp_path)
    calls = []

    def fake(cmd, **k):
        calls.append(cmd)
        out = ""
        if "sha256sum" in cmd[-1]:
            out = "\n".join(f"{S.sha256(src / '30m' / f)}  {f}" for f in S.MODEL_FILES)
        return subprocess.CompletedProcess(cmd, 0, out, "")
    a = argparse.Namespace(
        version="20261019-fs2", instrument="NIFTY", horizons=["30m"], models_dir=src, store=tmp_path,
        vps="root@vps", ssh_key=Path("k"), dry_run=False)
    assert S.cmd_ship(a, run=fake) == 0
    kinds = [c[0] if c[0] == "scp" else c[-1].split()[0] for c in calls]
    assert kinds == ["rm", "scp", "cd", "rm", "cd"]  # stage, copy, checksum, swap, psql
    assert "BatchMode=yes" in calls[1] and calls[-1][-1] == S.REMOTE_PSQL
