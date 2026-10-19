"""MBM M4 Stream B: monthly report builder, candidate/promote SQL (dry-run), prod demotion rule,
the /health live block and the 15:45 IST schedule. No Postgres, no ssh: fakes only."""
import argparse
import importlib.util
import json
import subprocess
from datetime import date, datetime, timedelta
from pathlib import Path

import numpy as np
import pytest

from src.mbm.service import clock
from src.mbm.service.engine import (LIVE_MIN_N, Engine, LoadedModel, demotion_verdict, live_auc)
from src.mbm.service.repo import DEMOTE_SQL, LIVE_OUTCOMES_SQL

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"


def _load(name):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


M = _load("mbm_monthly")
S = M.S
IST = clock.IST


def ist(s):
    return datetime.fromisoformat(s).replace(tzinfo=IST)


# ---------------------------------------------------------------- AUC + verdict

def test_live_auc_matches_known_values():
    assert live_auc([0.1, 0.4, 0.35, 0.8], [False, False, True, True]) == pytest.approx(0.75)
    assert live_auc([0.5, 0.5], [False, True]) == pytest.approx(0.5)      # ties averaged
    assert live_auc([], []) is None
    assert live_auc([0.2, 0.9], [True, True]) is None                     # one class: undefined
    assert M.auc([0.1, 0.4, 0.35, 0.8], [False, False, True, True]) == pytest.approx(0.75)


def test_verdict_threshold_and_min_n():
    assert demotion_verdict(0.55, LIVE_MIN_N) == "demote"
    assert demotion_verdict(0.60, LIVE_MIN_N) == "keep"                   # floor itself is not below
    assert demotion_verdict(0.55, LIVE_MIN_N - 1) == "insufficient"
    assert demotion_verdict(None, 5000) == "insufficient"
    assert demotion_verdict(float("nan"), 5000) == "insufficient"
    assert demotion_verdict(0.1, None) == "insufficient"


# ---------------------------------------------------------------- engine demotion

class LiveRepo:
    def __init__(self, rows_by_h=None, fail_read=False, demote_ok=True):
        self.rows_by_h = rows_by_h or {}
        self.fail_read = fail_read
        self.demote_ok = demote_ok
        self.demoted: list[tuple[str, str]] = []
        self.reads: list[tuple] = []

    def live_outcomes(self, instrument, horizon, model_id, since):
        self.reads.append((instrument, horizon, model_id, since))
        if self.fail_read:
            raise RuntimeError("db down")
        return self.rows_by_h.get(horizon, [])

    def demote_model(self, model_id, reason):
        self.demoted.append((model_id, reason))
        return self.demote_ok


def _rows(n, informative, seed=0):
    rng = np.random.default_rng(seed)
    y = rng.random(n) < 0.5
    p = np.clip(y * 0.4 + rng.random(n) * 0.6, 0, 1) if informative else rng.random(n)
    return [{"p": float(a), "outcome_big": bool(b)} for a, b in zip(p, y)]


def _engine(repo, now="2026-11-06T15:45:00"):
    e = Engine(repo=repo, models_dir=Path("."), instruments=["NIFTY"], now=lambda: ist(now))
    e.models = {"NIFTY": {"30m": LoadedModel("m30", object()), "60m": LoadedModel("m60", object())}}
    return e


def test_demotes_bad_horizon_only_and_unloads_it():
    repo = LiveRepo({"30m": _rows(400, informative=False), "60m": _rows(400, informative=True)})
    e = _engine(repo)
    e.check_demotions()
    assert [d[0] for d in repo.demoted] == ["m30"]
    assert repo.demoted[0][1].startswith("DEMOTED 2026-11-06 live AUC 0.")
    assert repo.demoted[0][1].endswith(" over 400")
    assert sorted(e.models["NIFTY"]) == ["60m"]
    live = e.health()["live"]
    assert live["30m"]["n"] == 400 and live["30m"]["demoted"].startswith("DEMOTED")
    assert live["60m"]["auc"] > 0.6 and "demoted" not in live["60m"]
    # the window is 30 calendar days and the read is scoped to the served model id
    inst, h, mid, since = repo.reads[0]
    assert (inst, mid) == ("NIFTY", "m30") and ist("2026-11-06T15:45:00") - since == timedelta(days=30)


def test_never_demotes_on_insufficient_or_missing_data():
    for repo in (LiveRepo({"30m": _rows(LIVE_MIN_N - 1, informative=False)}),   # too few
                 LiveRepo({}),                                                   # no rows at all
                 LiveRepo({"30m": [{"p": 0.3, "outcome_big": True}] * 500}),     # one class
                 LiveRepo({"30m": [{"p": None, "outcome_big": False}] * 500}),   # unusable p
                 LiveRepo(fail_read=True)):                                      # DB unreadable
        e = _engine(repo)
        e.check_demotions()
        assert repo.demoted == [] and sorted(e.models["NIFTY"]) == ["30m", "60m"]


def test_check_runs_once_per_day_and_not_before_1545():
    repo = LiveRepo({"30m": _rows(400, informative=False)})
    e = _engine(repo, now="2026-11-06T15:44:00")
    e.check_demotions()
    assert repo.reads == []
    e.now = lambda: ist("2026-11-06T15:46:00")
    e.check_demotions()
    n_reads = len(repo.reads)
    e.check_demotions()
    assert len(repo.reads) == n_reads and len(repo.demoted) == 1


def test_failed_registry_update_keeps_serving():
    repo = LiveRepo({"30m": _rows(400, informative=False)}, demote_ok=False)
    e = _engine(repo)
    e.check_demotions()
    assert "30m" in e.models["NIFTY"]


def test_startup_stats_never_demote():
    repo = LiveRepo({"30m": _rows(400, informative=False)})
    e = _engine(repo)
    e.refresh_live(demote=False)
    assert repo.demoted == [] and e.health()["live"]["30m"]["n"] == 400


def test_health_live_block_shape_multi_instrument():
    e = _engine(LiveRepo())
    e.live = {"NIFTY": {"30m": {"auc": 0.7, "n": 310}}, "BANKNIFTY": {"30m": {"auc": None, "n": 0}}}
    assert set(e.health()["live"]) == {"NIFTY:30m", "BANKNIFTY:30m"}


def test_health_endpoint_has_live_block(monkeypatch):
    monkeypatch.setenv("MBM_LOOP", "off")
    try:
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        FastAPI()
    except (TypeError, ImportError) as exc:
        pytest.skip(f"fastapi unusable in this interpreter: {exc}")
    from src.mbm_main import create_app
    e = _engine(LiveRepo({"30m": _rows(320, informative=True)}))
    e.load_models = lambda *a, **k: e.refresh_live(demote=False)
    with TestClient(create_app(e)) as c:
        body = c.get("/health").json()
    assert body["live"]["30m"]["n"] == 320 and body["live"]["60m"] == {
        "auc": None, "n": 0, "modelId": "m60", "checkedAt": body["live"]["60m"]["checkedAt"]}


def test_repo_sql_is_scoped_and_guarded():
    assert "outcome_quality = 'ok'" in LIVE_OUTCOMES_SQL and "outcome_big IS NOT NULL" in LIVE_OUTCOMES_SQL
    assert "model_id = %(model_id)s" in LIVE_OUTCOMES_SQL
    assert 'AND "active"' in DEMOTE_SQL and "array_append" in DEMOTE_SQL and "RETURNING" in DEMOTE_SQL


def test_next_demotion_check_skips_weekends():
    assert clock.next_demotion_check(ist("2026-11-06T10:00:00")) == ist("2026-11-06T15:45:00")
    assert clock.next_demotion_check(ist("2026-11-06T15:45:00")) == ist("2026-11-09T15:45:00")  # Fri -> Mon


# ---------------------------------------------------------------- candidate + promote SQL

GATE = {"n_test": 500, "n_months": 12, "last_months": ["2026-10"], "pass": True, "auc_all": 0.74,
        "last_auc_pooled": 0.78, "checks": {"auc_pooled_last_months": True}}
METRICS = {"featureSet": "mbm-fs2", "instrument": "NIFTY", "built": "2026-11-07",
           "horizons": {"30m": GATE, "60m": {**GATE, "pass": False, "checks": {"auc_month_floor": False}},
                        "rest": {**GATE, "pass": False}}}
META = {"featureSet": "mbm-fs2", "n_train": 10, "trained_through": "2026-11-06"}


def test_candidate_sql_is_inactive_and_leaves_siblings_alone():
    sql = S.registry_sql([S.registry_row("NIFTY", "20261107-monthly", "30m", METRICS, META)], candidate=True)
    assert "UPDATE ai_models SET active = false" not in sql
    assert "'NIFTY', '30m')" in sql and ", false, 'NIFTY', '30m')" in sql
    assert "active = false" in sql and "WHERE NOT ai_models.active;" in sql
    assert "active = true" not in sql


def test_promote_sql_one_transaction_deactivate_then_activate():
    sql = M.promote_sql("mbm-move-nifty-30m-20261107")
    i_off, i_on = sql.index("SET active = false"), sql.index("SET active = true")
    assert sql.startswith("BEGIN;") and sql.rstrip().endswith("COMMIT;") and i_off < i_on
    assert "gate = 'GO'" in sql and "RAISE EXCEPTION" in sql
    assert "COALESCE(o.horizon, '') = COALESCE(c.horizon, '')" in sql


def _promote_args(**kw):
    base = dict(model_id="mbm-move-nifty-30m-20261107", dry_run=False, yes=False, restart=False,
                vps="root@vps", ssh_key=Path("k"))
    base.update(kw)
    return argparse.Namespace(**base)


def _fake_psql(preview_rows):
    calls = []

    def run(cmd, **k):
        calls.append((cmd, k.get("input")))
        out = "\n".join(json.dumps(r) for r in preview_rows) if "read_only" in (k.get("input") or "") else ""
        return subprocess.CompletedProcess(cmd, 0, out, "")
    return run, calls


CAND = {"role": "candidate", "id": "mbm-move-nifty-30m-20261107", "kind": "mbm-move", "instrument": "NIFTY",
        "horizon": "30m", "gate": "GO", "active": False, "artifactPath": "x", "auc_all": 0.74, "last_auc_pooled": 0.78}
OLD = {**CAND, "role": "replaces", "id": "mbm-move-nifty-30m-20261019", "active": True}


def test_promote_without_yes_only_previews(capsys):
    run, calls = _fake_psql([CAND, OLD])
    assert M.cmd_promote(_promote_args(), run=run) == 2
    assert len(calls) == 1 and "read_only" in calls[0][1]
    out = capsys.readouterr().out
    assert "deactivates mbm-move-nifty-30m-20261019" in out and "--yes" in out


def test_promote_with_yes_runs_the_transaction_and_restart():
    run, calls = _fake_psql([CAND, OLD])
    assert M.cmd_promote(_promote_args(yes=True, restart=True), run=run) == 0
    assert "BEGIN;" in calls[1][1] and calls[2][0][-1] == "docker restart grw-mbm"


def test_promote_refuses_missing_or_no_go_and_bad_ids():
    run, calls = _fake_psql([])
    assert M.cmd_promote(_promote_args(yes=True), run=run) == 2
    run, calls = _fake_psql([{**CAND, "gate": "NO_GO"}])
    assert M.cmd_promote(_promote_args(yes=True), run=run) == 2 and len(calls) == 1
    assert M.cmd_promote(_promote_args(model_id="x'; drop table ai_models; --")) == 2


def test_promote_dry_run_touches_nothing(capsys):
    def boom(*a, **k):
        raise AssertionError("dry-run must not run anything")
    assert M.cmd_promote(_promote_args(dry_run=True, yes=True), run=boom) == 0
    assert "BEGIN;" in capsys.readouterr().out


def test_ship_candidate_preflight_refuses_active_id(tmp_path):
    src = tmp_path / "m"
    (src / "30m").mkdir(parents=True)
    (src / "metrics.json").write_text(json.dumps(METRICS))
    for f in S.MODEL_FILES:
        (src / "30m" / f).write_text(json.dumps(META) if f == "meta.json" else "x")
    calls = []

    def run(cmd, **k):
        calls.append(cmd)
        return subprocess.CompletedProcess(cmd, 0, "mbm-move-nifty-30m-20261107\n", "")
    a = argparse.Namespace(version="20261107-monthly", instrument="NIFTY", horizons=["30m"], models_dir=src,
                           store=tmp_path, vps="root@vps", ssh_key=Path("k"), dry_run=False, candidate=True)
    assert S.cmd_ship(a, run=run) == 2
    assert len(calls) == 1 and not any(c[0] == "scp" for c in calls)


# ---------------------------------------------------------------- report builder + run

PROD_OUT = "\n".join(json.dumps(o) for o in [
    {"t": "R", "id": "mbm-move-nifty-30m-20261019", "horizon": "30m", "gate": "GO", "gateReasons": [],
     "metrics": {**GATE, "auc_all": 0.70}, "createdAt": "2026-10-19T10:00:00"},
    {"t": "D", "id": "mbm-move-nifty-60m-20261019", "horizon": "60m", "gate": "GO",
     "gateReasons": ["DEMOTED 2026-11-03 live AUC 0.551 over 412"], "metrics": GATE, "createdAt": "x"},
    {"t": "D", "id": "old", "horizon": "60m", "gate": "GO",
     "gateReasons": ["DEMOTED 2026-01-03 live AUC 0.5 over 300"], "metrics": GATE, "createdAt": "x"},
] + [{"t": "P", "horizon": "30m", "model": "mbm-move-nifty-30m-20261019", "p": r["p"], "big": r["outcome_big"]}
     for r in _rows(350, informative=True)]
  + [{"t": "P", "horizon": "30m", "model": "someone-else", "p": 0.5, "big": True}])


def test_parse_prod_state_and_live_stats():
    st = M.parse_prod_state("SET\n" + PROD_OUT, since=date(2026, 10, 1))
    assert list(st["active"]) == ["30m"] and [d["id"] for d in st["demoted"]] == ["mbm-move-nifty-60m-20261019"]
    ls = M.live_stats(st["preds"], "30m", "mbm-move-nifty-30m-20261019")
    assert ls["n"] == 350 and ls["auc"] > 0.6


def test_report_compares_new_gate_active_and_live(tmp_path):
    prod = M.parse_prod_state(PROD_OUT, since=date(2026, 10, 1))
    rep = M.build_report(month="2026-11", instrument="NIFTY", new_metrics=METRICS, prod=prod, patterns=None,
                         candidates={"30m": "mbm-move-nifty-30m-20261107"}, steps=["train-a: ok"])
    row30 = next(ln for ln in rep.splitlines() if ln.startswith("| 30m"))
    assert "GO · AUC all 0.740" in row30 and "GO · AUC all 0.700" in row30 and "over 350" in row30
    assert "replaces `mbm-move-nifty-30m-20261019`" in row30
    row60 = next(ln for ln in rep.splitlines() if ln.startswith("| 60m"))
    assert "NO_GO" in row60 and "failed: auc_month_floor" in row60 and "horizon stays off" in row60
    assert "not served" in next(ln for ln in rep.splitlines() if ln.startswith("| rest"))
    assert "DEMOTED 2026-11-03 live AUC 0.551 over 412" in rep
    assert "no library artefact" in rep


def test_report_without_prod_infers_nothing():
    rep = M.build_report(month="2026-11", instrument="NIFTY", new_metrics=METRICS, prod=None, patterns=None,
                         candidates={}, steps=[], prod_error="ssh failed")
    assert "UNAVAILABLE (ssh failed)" in rep and "unknown (prod not read)" in rep


def test_pattern_diff_new_and_retired(tmp_path):
    d = tmp_path / "models" / "m4" / "nifty"
    d.mkdir(parents=True)
    (d / "library-2026-10-19.json").write_text(json.dumps({"rules": [{"id": "a"}, {"id": "b"}], "meta": {}}))
    (d / "library-2026-11-07.json").write_text(json.dumps({"rules": [{"id": "b"}, {"id": "c"}],
                                                            "meta": {"significant": False}}))
    pd_ = M.pattern_diff(tmp_path, "NIFTY")
    assert (pd_["new"], pd_["retired"], pd_["significant"]) == (["c"], ["a"], False)
    rep = M.build_report(month="2026-11", instrument="NIFTY", new_metrics=METRICS, prod=None, patterns=pd_,
                         candidates={}, steps=[])
    assert "retired: a" in rep and "NOT significant" in rep
    assert M.pattern_diff(tmp_path / "nope", "NIFTY") is None


def _store(tmp_path):
    mdir = tmp_path / "models" / "m1" / "nifty"
    (mdir / "30m").mkdir(parents=True)
    (mdir / "metrics.json").write_text(json.dumps(METRICS))
    for f in S.MODEL_FILES:
        (mdir / "30m" / f).write_text(json.dumps(META) if f == "meta.json" else "x")
    return mdir


def _run_args(tmp_path, **kw):
    base = dict(store=tmp_path, instrument="NIFTY", vps="root@vps", ssh_key=Path("k"), dry_run=False,
                skip_data=False)
    base.update(kw)
    return argparse.Namespace(**base)


def test_run_dry_run_reads_prod_only_and_writes_report(tmp_path):
    mdir = _store(tmp_path)
    calls = []

    def run(cmd, **k):
        calls.append(cmd)
        assert cmd[0] == "ssh" and "read_only" in k.get("input", ""), "dry run may only READ prod"
        return subprocess.CompletedProcess(cmd, 0, PROD_OUT, "")
    assert M.cmd_run(_run_args(tmp_path, dry_run=True), run=run, today=date(2026, 11, 7)) == 0
    assert len(calls) == 1
    rep = (tmp_path / "reports" / "report-2026-11-dryrun.md").read_text(encoding="utf-8")
    assert "DRY RUN" in rep and "would ship mbm-move-nifty-30m-20261107" in rep


def test_run_aborts_when_training_fails(tmp_path):
    _store(tmp_path)

    def run(cmd, **k):
        return subprocess.CompletedProcess(cmd, 1 if "train-a" in cmd else 0, "", "")
    assert M.cmd_run(_run_args(tmp_path), run=run, today=date(2026, 11, 7)) == 1
    assert not (tmp_path / "reports").exists()


def test_run_ships_inactive_candidates_only_for_passing_served_horizons(tmp_path):
    mdir = _store(tmp_path)
    seen = []

    def run(cmd, **k):
        seen.append((cmd, k.get("input")))
        if cmd[0] == "ssh" and "sha256sum" in cmd[-1]:
            return subprocess.CompletedProcess(cmd, 0, "\n".join(
                f"{S.sha256(mdir / '30m' / f)}  {f}" for f in S.MODEL_FILES), "")
        if cmd[0] == "ssh" and "read_only" in (k.get("input") or "") and "json_build_object" in k["input"]:
            return subprocess.CompletedProcess(cmd, 0, PROD_OUT, "")
        return subprocess.CompletedProcess(cmd, 0, "", "")
    assert M.cmd_run(_run_args(tmp_path), run=run, today=date(2026, 11, 7)) == 0
    writes = [i for c, i in seen if i and "INSERT INTO ai_models" in i]
    assert len(writes) == 1 and "'30m')" in writes[0] and "'60m')" not in writes[0]
    assert ", false, 'NIFTY', '30m')" in writes[0] and "SET active = false WHERE kind" not in writes[0]
    assert all("SET active = true" not in (i or "") for _, i in seen)        # run never activates
    assert (tmp_path / "reports" / "report-2026-11.md").exists()


def test_run_does_not_ship_when_prod_unreadable(tmp_path):
    _store(tmp_path)
    seen = []

    def run(cmd, **k):
        seen.append(k.get("input"))
        rc = 255 if cmd[0] == "ssh" else 0
        return subprocess.CompletedProcess(cmd, rc, "", "unreachable")
    assert M.cmd_run(_run_args(tmp_path), run=run, today=date(2026, 11, 7)) == 1
    assert not any(i and "INSERT INTO ai_models" in i for i in seen)
    assert "NOT shipped" in (tmp_path / "reports" / "report-2026-11.md").read_text(encoding="utf-8")
