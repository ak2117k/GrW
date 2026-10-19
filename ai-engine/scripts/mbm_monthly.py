"""MBM M4 self-learning loop, PC side: the monthly run and the human promotion step.

  py -3 scripts/mbm_monthly.py run [--dry-run] [--skip-data] --vps root@<ip> --ssh-key ~/.ssh/grw_oracle
  py -3 scripts/mbm_monthly.py promote --model-id mbm-move-nifty-30m-20261107 [--restart] --yes --vps … --ssh-key …

`run` (scheduled monthly, 1st Saturday 11:00): `mbm_data.py build` -> `mbm_train.py train-a --rebuild`
(all horizons) -> `mbm_train.py mine-b` (only if src/mbm/patterns.py exists; failures tolerated) ->
read the ACTIVE prod registry + 30 days of live outcomes READ-ONLY over ssh -> write
<store>/reports/report-YYYY-MM.md -> ship every served horizon whose new gate passed as an INACTIVE
candidate (`mbm_ship.py ship --candidate`). It never activates anything.

`--dry-run`: runs none of the build/train/mine steps (prints them), reads prod read-only, writes the
report from the models already in the store (marked DRY RUN) and prints the candidate ship plan.

`promote` (the human approval for cycles 1-3; never scheduled): prints the candidate and the row it
replaces, and only with `--yes` activates it and deactivates the old active row of the same
kind x instrument x horizon in one transaction. `--restart` then restarts grw-mbm so it is served.

Contract: docs/superpowers/plans/2026-10-19-mbm-m4-patterns-loop.md §Stream B; design §5.9.
Exit codes: 0 ok · 1 a step / remote call failed · 2 refused or bad usage.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import subprocess
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def _load_ship():
    spec = importlib.util.spec_from_file_location("mbm_ship", SCRIPTS / "mbm_ship.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


S = _load_ship()
lit, KIND, SERVED = S.lit, S.KIND, S.HORIZONS

LIVE_DAYS = 30
LIVE_MIN_N = 300          # mirrors src/mbm/service/engine.py LIVE_MIN_N
LIVE_AUC_FLOOR = 0.60     # mirrors LIVE_AUC_FLOOR
MODEL_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{2,80}$")
VERSION_TAG = "monthly"

Runner = Callable[..., subprocess.CompletedProcess]


# ── prod reads (read-only SQL; one JSON object per output line) ────────────────

def prod_state_sql(instrument: str, days: int = LIVE_DAYS) -> str:
    return (
        "SET default_transaction_read_only = on;\n\\pset tuples_only on\n\\pset format unaligned\n"
        # R: the active rows; D: rows demoted in the window (they appear in the next report)
        "SELECT json_build_object('t', CASE WHEN active THEN 'R' ELSE 'D' END, 'id', id, 'horizon', horizon, "
        "'gate', gate, 'gateReasons', \"gateReasons\", 'metrics', metrics, 'createdAt', \"createdAt\")::text "
        f"FROM ai_models WHERE kind = {lit(KIND)} AND instrument = {lit(instrument)} AND (active OR EXISTS "
        "(SELECT 1 FROM unnest(\"gateReasons\") g WHERE g LIKE 'DEMOTED%')) "
        "ORDER BY horizon, \"createdAt\";\n"
        "SELECT json_build_object('t', 'P', 'horizon', horizon, 'model', model_id, 'p', p, "
        "'big', outcome_big)::text FROM mbm_predictions "
        f"WHERE instrument = {lit(instrument)} AND as_of >= now() - interval '{int(days)} days' "
        "AND outcome_quality = 'ok' AND outcome_big IS NOT NULL ORDER BY as_of;\n")


def _demoted_on(reason: str) -> date | None:
    m = re.match(r"DEMOTED (\d{4}-\d{2}-\d{2})", str(reason))
    return date.fromisoformat(m.group(1)) if m else None


def parse_prod_state(out: str, since: date | None = None) -> dict[str, Any]:
    """`since`: keep only demotions dated on/after it (the ones the last report did not show)."""
    active: dict[str, dict] = {}
    demoted: list[dict] = []
    preds: list[dict] = []
    for ln in out.splitlines():
        ln = ln.strip()
        if not ln.startswith("{"):
            continue
        o = json.loads(ln)
        t = o.pop("t", None)
        if t == "R":
            active[o["horizon"]] = o
        elif t == "D":
            when = [d for d in map(_demoted_on, o.get("gateReasons") or []) if d is not None]
            if when and (since is None or max(when) >= since):
                demoted.append(o)
        elif t == "P":
            preds.append(o)
    return {"active": active, "demoted": demoted, "preds": preds}


def auc(p: list[float], y: list[bool]) -> float | None:
    """Rank AUC with averaged ties; None if undefined. Same maths as the service's live_auc."""
    pos = sum(1 for v in y if v)
    neg = len(y) - pos
    if not p or pos == 0 or neg == 0:
        return None
    order = sorted(range(len(p)), key=lambda i: p[i])
    ranks = [0.0] * len(p)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and p[order[j + 1]] == p[order[i]]:
            j += 1
        for k in range(i, j + 1):
            ranks[order[k]] = (i + j) / 2 + 1
        i = j + 1
    rpos = sum(r for r, v in zip(ranks, y) if v)
    return (rpos - pos * (pos + 1) / 2) / (pos * neg)


def live_stats(preds: list[dict], horizon: str, model: str | None) -> dict[str, Any]:
    rows = [r for r in preds if r.get("horizon") == horizon and r.get("p") is not None
            and r.get("big") is not None and (model is None or r.get("model") == model)]
    p = [float(r["p"]) for r in rows]
    y = [bool(r["big"]) for r in rows]
    a = auc(p, y)
    return {"n": len(rows), "auc": None if a is None else round(a, 4),
            "base": None if not rows else round(sum(y) / len(y), 4)}


# ── patterns (Stream A artefacts; absence is fine) ─────────────────────────────

def _rules(lib: Any) -> list[dict]:
    if isinstance(lib, list):
        return lib
    if isinstance(lib, dict):
        for k in ("rules", "library", "verified"):
            if isinstance(lib.get(k), list):
                return lib[k]
    return []


def pattern_diff(store: Path, instrument: str) -> dict[str, Any] | None:
    files = sorted((store / "models" / "m4" / instrument.lower()).glob("library-*.json"))
    if not files:
        return None
    cur = json.loads(files[-1].read_text(encoding="utf-8"))
    prev = json.loads(files[-2].read_text(encoding="utf-8")) if len(files) > 1 else None
    ids = lambda lib: {str(r.get("id")) for r in _rules(lib)}  # noqa: E731
    now_ids, old_ids = ids(cur), ids(prev) if prev is not None else set()
    meta = cur.get("meta", {}) if isinstance(cur, dict) else {}
    return {"file": files[-1].name, "prev": files[-2].name if prev is not None else None,
            "n": len(now_ids), "new": sorted(now_ids - old_ids), "retired": sorted(old_ids - now_ids),
            "significant": meta.get("significant")}


# ── report ─────────────────────────────────────────────────────────────────────

def _f(x, nd=3) -> str:
    return "—" if x is None else f"{float(x):.{nd}f}"


def _gate_line(g: dict | None) -> str:
    if not g:
        return "—"
    failed = sorted(k for k, ok in (g.get("checks") or {}).items() if not ok)
    verdict = "GO" if g.get("pass") else "NO_GO"
    return (f"{verdict} · AUC all {_f(g.get('auc_all'))} · last-months pooled {_f(g.get('last_auc_pooled'))}"
            + (f" · failed: {', '.join(failed)}" if failed else ""))


def build_report(*, month: str, instrument: str, new_metrics: dict, prod: dict | None,
                 patterns: dict | None, candidates: dict[str, str], steps: list[str],
                 dry_run: bool = False, prod_error: str | None = None) -> str:
    """Pure: everything the monthly report says, from already-gathered inputs."""
    L = [f"# MBM monthly report {month} · {instrument}" + (" · DRY RUN (nothing built or shipped)" if dry_run else ""),
         "", f"Generated {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M')}Z · feature set "
         f"{new_metrics.get('featureSet', '—')} · trained {new_metrics.get('built', '—')}", "", "## Steps", ""]
    L += [f"- {s}" for s in steps] or ["- (none)"]
    L += ["", "## Model A per horizon", ""]
    if prod is None:
        L += [f"Prod registry and live outcomes UNAVAILABLE ({prod_error or 'not read'}): the comparison "
              "below shows the new run only. Nothing about the live model is inferred.", ""]
    active = (prod or {}).get("active", {})
    preds = (prod or {}).get("preds", [])
    L += ["| horizon | new gate | active model | active stored gate | live AUC (30 d, active model) | "
          "what would change |", "|---|---|---|---|---|---|"]
    for h, g in (new_metrics.get("horizons") or {}).items():
        act = active.get(h)
        served = h in SERVED
        live = live_stats(preds, h, act["id"]) if (act and prod is not None) else None
        if live is None:
            live_s = "—" if prod is None else "no active model"
        elif live["n"] < LIVE_MIN_N or live["auc"] is None:
            live_s = f"{_f(live['auc'])} over {live['n']} (insufficient: < {LIVE_MIN_N} or one class)"
        else:
            flag = " **below floor**" if live["auc"] < LIVE_AUC_FLOOR else ""
            live_s = f"{_f(live['auc'])} over {live['n']}{flag}"
        if not served:
            change = "not served (offline horizon)"
        elif h in candidates and act and candidates[h] == act["id"]:
            change = (f"candidate id `{candidates[h]}` IS the active row (same version date): a real run "
                      "refuses it — nothing would change")
        elif h in candidates:
            change = (f"candidate `{candidates[h]}` registered INACTIVE; `promote --model-id {candidates[h]}` "
                      + (f"replaces `{act['id']}`" if act else "activates it (no active model)"))
        elif g.get("pass"):
            change = "gate passed; candidate NOT shipped (see steps)"
        else:
            change = "gate failed: no candidate; " + (f"`{act['id']}` stays" if act else "horizon stays off")
        L.append(f"| {h} | {_gate_line(g)} | {act['id'] if act else '—'} | "
                 f"{_gate_line(act.get('metrics')) if act else '—'} | {live_s} | {change} |")
    L += ["", "## Demotions since last report", ""]
    dem = (prod or {}).get("demoted", [])
    if prod is None:
        L.append("- unknown (prod not read)")
    elif not dem:
        L.append("- none")
    for d in dem:
        why = [g for g in (d.get("gateReasons") or []) if str(g).startswith("DEMOTED")]
        L.append(f"- `{d['id']}` ({d.get('horizon')}): {'; '.join(why)}")
    L += ["", "## Pattern library (Model B)", ""]
    if patterns is None:
        L.append("- no library artefact (`mine-b` absent or produced nothing). Pattern demotion is out of scope.")
    else:
        sig = patterns.get("significant")
        L.append(f"- `{patterns['file']}`: {patterns['n']} verified rules"
                 + ("" if patterns["n"] else " — **the library is empty**, a valid result")
                 + (" · flagged NOT significant vs shuffled null" if sig is False else ""))
        L.append(f"- new vs `{patterns['prev']}`: {', '.join(patterns['new']) or 'none'}" if patterns["prev"]
                 else f"- first library: all {patterns['n']} rules are new")
        if patterns["prev"]:
            L.append(f"- retired: {', '.join(patterns['retired']) or 'none'}")
    L += ["", "## Promotion", "",
          "Cycles 1-3 need a human: review this report, then per horizon "
          "`py -3 scripts/mbm_monthly.py promote --model-id <id> --restart --yes --vps … --ssh-key …`.", ""]
    return "\n".join(L)


# ── promote ────────────────────────────────────────────────────────────────────

def promote_sql(model_id: str) -> str:
    """One transaction: deactivate the active sibling (same kind x instrument x horizon), activate the
    candidate (GO only, enforced by the CHECK constraint too), and fail loudly if it did not take."""
    m = lit(model_id)
    return (
        "BEGIN;\n"
        "UPDATE ai_models o SET active = false FROM ai_models c "
        f"WHERE c.id = {m} AND c.gate = 'GO' AND o.kind = c.kind "
        "AND COALESCE(o.instrument, '') = COALESCE(c.instrument, '') "
        "AND COALESCE(o.horizon, '') = COALESCE(c.horizon, '') AND o.active AND o.id <> c.id;\n"
        f"UPDATE ai_models SET active = true WHERE id = {m} AND kind = {lit(KIND)} AND gate = 'GO';\n"
        f"DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM ai_models WHERE id = {m} AND active) THEN "
        f"RAISE EXCEPTION 'promote: % not activated (missing, not GO or wrong kind)', {m}; END IF; END $$;\n"
        "COMMIT;\n")


def promote_preview_sql(model_id: str) -> str:
    m = lit(model_id)
    return (
        "SET default_transaction_read_only = on;\n\\pset tuples_only on\n\\pset format unaligned\n"
        "SELECT json_build_object('role', CASE WHEN o.id = c.id THEN 'candidate' ELSE 'replaces' END, "
        "'id', o.id, 'kind', o.kind, 'instrument', o.instrument, 'horizon', o.horizon, 'gate', o.gate, "
        "'active', o.active, 'artifactPath', o.\"artifactPath\", 'auc_all', o.metrics->'auc_all', "
        "'last_auc_pooled', o.metrics->'last_auc_pooled')::text "
        f"FROM ai_models c JOIN ai_models o ON o.id = c.id OR (o.kind = c.kind AND o.active "
        "AND COALESCE(o.instrument, '') = COALESCE(c.instrument, '') "
        f"AND COALESCE(o.horizon, '') = COALESCE(c.horizon, '')) WHERE c.id = {m};\n")


def cmd_promote(a, run: Runner = subprocess.run) -> int:
    if not MODEL_ID_RE.match(a.model_id or "") or not a.model_id.startswith(KIND + "-"):
        print(f"bad --model-id {a.model_id!r} (want {KIND}-<instrument>-<horizon>-<date>)")
        return 2
    sql = promote_sql(a.model_id)
    if a.dry_run:
        print("-- preview SQL (read-only) --")
        print(promote_preview_sql(a.model_id))
        print("-- promote SQL (stdin to psql on the VPS) --")
        print(sql)
        if a.restart:
            print("-- then: docker restart grw-mbm")
        return 0
    if not S._need_remote(a):
        return 2
    try:
        out = S.psql(a, promote_preview_sql(a.model_id), run=run)
    except RuntimeError as exc:
        print(f"promote FAILED (preview): {exc}")
        return 1
    rows = [json.loads(ln) for ln in out.splitlines() if ln.strip().startswith("{")]
    cand = next((r for r in rows if r["role"] == "candidate"), None)
    if cand is None:
        print(f"{a.model_id}: no such ai_models row; nothing to do")
        return 2
    if cand["gate"] != "GO" or cand["kind"] != KIND:
        print(f"{a.model_id}: gate {cand['gate']} kind {cand['kind']}: cannot be activated")
        return 2
    if cand["active"]:
        print(f"{a.model_id} is already active; nothing to do")
        return 0
    old = [r for r in rows if r["role"] == "replaces"]
    print(f"PROMOTE {cand['id']} ({cand['instrument']} {cand['horizon']}, AUC all {cand['auc_all']}, "
          f"last pooled {cand['last_auc_pooled']}, {cand['artifactPath']})")
    for r in old:
        print(f"  deactivates {r['id']} (AUC all {r['auc_all']}, last pooled {r['last_auc_pooled']})")
    if not old:
        print("  no active model of this kind x instrument x horizon today")
    if a.restart:
        print("  then restarts grw-mbm so the service loads it")
    if not a.yes:
        print("re-run with --yes to do it")
        return 2
    try:
        S.psql(a, sql, run=run)
        print(f"promoted {a.model_id}")
        if a.restart:
            S.ssh(a, "docker restart grw-mbm", run=run)
            print("grw-mbm restarted")
        else:
            print("the service picks it up on its next restart (`docker restart grw-mbm`)")
    except RuntimeError as exc:
        print(f"promote FAILED: {exc}")
        return 1
    return 0


# ── run ────────────────────────────────────────────────────────────────────────

def step_commands(a) -> list[tuple[str, list[str], bool]]:
    """(name, argv, tolerated) for the local steps, in order."""
    py, store = sys.executable, str(a.store)
    remote = ["--vps", a.vps or "<vps>", "--ssh-key", str(a.ssh_key or "<key>")]
    out = []
    if not a.skip_data:
        out.append(("data build", [py, str(SCRIPTS / "mbm_data.py"), "build", "--store", store,
                                   "--instrument", a.instrument, *remote], False))
    out.append(("train-a", [py, str(SCRIPTS / "mbm_train.py"), "train-a", "--instrument", a.instrument,
                            "--store", store, "--rebuild"], False))
    if (ROOT / "src" / "mbm" / "patterns.py").exists():
        out.append(("mine-b", [py, str(SCRIPTS / "mbm_train.py"), "mine-b", "--instrument", a.instrument,
                               "--store", store], True))
    return out


def run_version(today: date) -> str:
    return f"{today:%Y%m%d}-{VERSION_TAG}"


def cmd_run(a, run: Runner = subprocess.run, today: date | None = None) -> int:
    today = today or date.today()
    month = f"{today:%Y-%m}"
    steps: list[str] = []
    for name, argv, tolerated in step_commands(a):
        if a.dry_run:
            steps.append(f"{name}: skipped (dry run) — would run `{' '.join(argv[1:])}`")
            continue
        print(f"[monthly] {name}: {' '.join(argv[1:])}", flush=True)
        res = run(argv, cwd=str(ROOT))
        rc = res.returncode
        if rc == 0:
            steps.append(f"{name}: ok")
        elif name == "data build" and rc == 1:
            steps.append(f"{name}: PARTIAL (exit 1; failed chunks are retried next build) — continuing")
        elif tolerated:
            steps.append(f"{name}: FAILED (exit {rc}) — tolerated, patterns not refreshed")
        else:
            print(f"[monthly] {name} failed (exit {rc}); stopping before report/ship")
            return 1 if rc != 2 else 2
    if "mine-b" not in [n for n, _, _ in step_commands(a)]:
        steps.append("mine-b: skipped (src/mbm/patterns.py not present)")

    mdir = a.store / "models" / "m1" / a.instrument.lower()
    try:
        metrics = json.loads((mdir / "metrics.json").read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        print(f"[monthly] cannot read {mdir / 'metrics.json'}: {exc}")
        return 1

    prod, prod_error = None, None
    if a.vps and a.ssh_key:
        try:
            prod = parse_prod_state(S.psql(a, prod_state_sql(a.instrument), run=run),
                                    since=today - timedelta(days=45))
        except (RuntimeError, ValueError) as exc:
            prod_error = str(exc).splitlines()[0][:200]
    else:
        prod_error = "no --vps/--ssh-key"
    steps.append("prod read (read-only): " + ("ok" if prod is not None else f"FAILED — {prod_error}"))

    version = run_version(today)
    go = [h for h in SERVED if (metrics.get("horizons", {}).get(h) or {}).get("pass")]
    candidates: dict[str, str] = {}
    if not go:
        steps.append("candidates: none (no served horizon passed its gate)")
    elif prod is None and not a.dry_run:
        steps.append("candidates: NOT shipped (prod state unknown; re-run when the VPS is reachable)")
    else:
        ship_args = argparse.Namespace(version=version, instrument=a.instrument, horizons=go, models_dir=mdir,
                                       store=a.store, vps=a.vps, ssh_key=a.ssh_key, dry_run=a.dry_run,
                                       candidate=True)
        rc = S.cmd_ship(ship_args, run=run)
        if rc == 0:
            candidates = {h: S.model_id(a.instrument, h, version) for h in go}
            steps.append(f"candidates: {'would ship' if a.dry_run else 'shipped INACTIVE'} "
                         f"{', '.join(candidates.values())} (version {version})")
        else:
            steps.append(f"candidates: ship FAILED or refused (exit {rc})")

    report = build_report(month=month, instrument=a.instrument, new_metrics=metrics, prod=prod,
                          patterns=pattern_diff(a.store, a.instrument), candidates=candidates, steps=steps,
                          dry_run=a.dry_run, prod_error=prod_error)
    out = a.store / "reports" / (f"report-{month}" + ("-dryrun" if a.dry_run else "") + ".md")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(report, encoding="utf-8")
    print(f"[monthly] report: {out}")
    return 0 if all("FAILED" not in s for s in steps) else 1


def main(argv: list[str] | None = None) -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass
    from src.mbm.store import default_root
    p = argparse.ArgumentParser(prog="mbm_monthly", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--store", type=Path, default=default_root())
    common.add_argument("--instrument", default="NIFTY")
    common.add_argument("--vps", default=os.environ.get("MBM_VPS"))
    common.add_argument("--ssh-key", type=Path, default=os.environ.get("MBM_SSH_KEY"))
    common.add_argument("--dry-run", action="store_true")
    r = sub.add_parser("run", parents=[common], help="build, retrain, mine, report, ship INACTIVE candidates")
    r.add_argument("--skip-data", action="store_true", help="skip `mbm_data.py build` (store already fresh)")
    pr = sub.add_parser("promote", parents=[common], help="activate one candidate (human approval step)")
    pr.add_argument("--model-id", required=True)
    pr.add_argument("--yes", action="store_true", help="actually do it (otherwise print the plan)")
    pr.add_argument("--restart", action="store_true", help="docker restart grw-mbm afterwards")
    a = p.parse_args(argv)
    if a.ssh_key:
        a.ssh_key = Path(os.path.expanduser(str(a.ssh_key)))
    if a.cmd == "run" and not S.INSTRUMENT_RE.match(a.instrument):
        print(f"bad --instrument {a.instrument!r}")
        return 2
    return {"run": cmd_run, "promote": cmd_promote}[a.cmd](a)


if __name__ == "__main__":
    sys.exit(main())
