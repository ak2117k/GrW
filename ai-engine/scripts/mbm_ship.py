"""MBM M2 ops: ship Model A artefacts + registry rows, seed broker 1m bars, verify.

  py -3 scripts/mbm_ship.py ship --instrument NIFTY --version 20261019-fs2 --vps root@<ip> --ssh-key ~/.ssh/grw_oracle
  py -3 scripts/mbm_ship.py seed-bars --days 60 --vps root@<ip> --ssh-key ~/.ssh/grw_oracle
  py -3 scripts/mbm_ship.py verify --vps root@<ip> --ssh-key ~/.ssh/grw_oracle
  add --dry-run to any of them: prints the SQL and the scp plan, touches nothing.
  ship --candidate (M4): same files, but the ai_models rows land active=false; activation is
  `mbm_monthly.py promote --model-id <id> --yes` (the human approval step).

Contract: docs/superpowers/plans/2026-10-19-mbm-m2-serving.md §2 (registry rows) and §5 (ops).
SQL goes to the VPS over ssh on stdin into `docker exec -i grw-postgres psql`, with the
credentials sourced from /opt/grw/env/compose.env ON the VPS (never copied to the PC).

Exit codes: 0 ok · 1 a remote step failed · 2 refused (gate not passed, files missing, bad usage).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.mbm.exports import _ssh_opts  # noqa: E402
from src.mbm.store import default_root, load_manifest, read_bars  # noqa: E402

KIND = "mbm-move"
HORIZONS = ("30m", "60m")
MODEL_FILES = ("classifier.txt", "q25.txt", "q50.txt", "q75.txt", "meta.json")
REMOTE_MODELS = "/opt/grw/models"
REMOTE_PSQL = ("cd /opt/grw && set -a; . env/compose.env; set +a; "
               'docker exec -i grw-postgres psql -U "$PG_USER" -d "$PG_DB" -v ON_ERROR_STOP=1 -X -q')
VERSION_RE = re.compile(r"^(?P<date>\d{8})-[a-z0-9]+$")
INSTRUMENT_RE = re.compile(r"^[A-Z0-9]+$")
FIXED_SERIES = ("NIFTY", "BANKNIFTY", "INDIAVIX")
BAR_COLS = ("series", "ts", "open", "high", "low", "close", "volume")

Runner = Callable[..., subprocess.CompletedProcess]


# ── SQL helpers (pure: tested in tests/test_mbm_ship.py) ───────────────────────


def _json(v) -> str:
    """JSON for a jsonb literal: NaN/inf (e.g. a month whose outcomes were all one class) → null."""
    def clean(x):
        if isinstance(x, float) and (x != x or x in (float("inf"), float("-inf"))):
            return None
        if isinstance(x, dict):
            return {k: clean(w) for k, w in x.items()}
        if isinstance(x, (list, tuple)):
            return [clean(w) for w in x]
        return x
    return json.dumps(clean(v), allow_nan=False)

def lit(v) -> str:
    """SQL literal. Strings are single-quote escaped; standard_conforming_strings is on."""
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return repr(v)
    return "'" + str(v).replace("'", "''") + "'"


def model_id(instrument: str, horizon: str, version: str) -> str:
    return f"{KIND}-{instrument.lower()}-{horizon}-{VERSION_RE.match(version)['date']}"


def artifact_path(instrument: str, version: str, horizon: str) -> str:
    """Relative to /models inside the container (= /opt/grw/models on the host)."""
    return f"mbm/{instrument.lower()}/{version}/{horizon}"


def registry_row(instrument: str, version: str, horizon: str, metrics: dict, meta: dict) -> dict:
    gate = metrics["horizons"][horizon]
    checks = gate.get("checks") or {}
    return {
        "id": model_id(instrument, horizon, version),
        "kind": KIND,
        "featureSet": meta.get("featureSet") or metrics["featureSet"],
        "trainedAt": f"{metrics['built']}T00:00:00Z",
        "dataWindow": {"trainedThrough": meta.get("trained_through"), "nMonths": gate.get("n_months"),
                       "lastMonths": gate.get("last_months")},
        "nTrain": int(meta.get("n_train") or 0),
        "nHoldout": int(gate.get("n_test") or 0),
        "metrics": gate,
        "gate": "GO" if gate.get("pass") else "NO_GO",
        "gateReasons": sorted(k for k, ok in checks.items() if not ok),
        "artifactPath": artifact_path(instrument, version, horizon),
        "instrument": instrument,
        "horizon": horizon,
    }


def registry_sql(rows: list[dict], candidate: bool = False) -> str:
    """One transaction: per horizon, deactivate other rows of kind x instrument x horizon, then upsert
    this row active. Deactivate-then-activate keeps 'one active row' true at every statement.

    `candidate` (M4): upsert the row INACTIVE and leave every other row alone; the conflict branch
    never touches a row that is currently active. Activation is `mbm_monthly.py promote`."""
    out = ["BEGIN;"]
    active = "false" if candidate else "true"
    for r in rows:
        if r["gate"] != "GO":
            raise ValueError(f"{r['id']}: gate {r['gate']} cannot be active")
        if not candidate:
            out.append(
                f"UPDATE ai_models SET active = false WHERE kind = {lit(r['kind'])} "
                f"AND instrument = {lit(r['instrument'])} AND horizon = {lit(r['horizon'])} "
                f"AND active AND id <> {lit(r['id'])};")
        reasons = "ARRAY[" + ", ".join(lit(x) for x in r["gateReasons"]) + "]::text[]"
        out.append(
            'INSERT INTO ai_models (id, kind, "featureSet", "trainedAt", "dataWindow", "nTrain", "nHoldout", '
            'metrics, gate, "gateReasons", "artifactPath", active, instrument, horizon)\n'
            f"VALUES ({lit(r['id'])}, {lit(r['kind'])}, {lit(r['featureSet'])}, {lit(r['trainedAt'])}::timestamptz, "
            f"{lit(_json(r['dataWindow']))}::jsonb, {r['nTrain']}, {r['nHoldout']}, "
            f"{lit(_json(r['metrics']))}::jsonb, {lit(r['gate'])}, {reasons}, {lit(r['artifactPath'])}, "
            f"{active}, {lit(r['instrument'])}, {lit(r['horizon'])})\n"
            'ON CONFLICT (id) DO UPDATE SET kind = EXCLUDED.kind, "featureSet" = EXCLUDED."featureSet", '
            '"trainedAt" = EXCLUDED."trainedAt", "dataWindow" = EXCLUDED."dataWindow", "nTrain" = EXCLUDED."nTrain", '
            '"nHoldout" = EXCLUDED."nHoldout", metrics = EXCLUDED.metrics, gate = EXCLUDED.gate, '
            f'"gateReasons" = EXCLUDED."gateReasons", "artifactPath" = EXCLUDED."artifactPath", active = {active}, '
            "instrument = EXCLUDED.instrument, horizon = EXCLUDED.horizon"
            + (" WHERE NOT ai_models.active;" if candidate else ";"))
    out.append("COMMIT;")
    return "\n".join(out) + "\n"


def bars_csv(series: str, df) -> list[str]:
    """CSV lines (no header) in mbm_bars_1m column order; ts = bar START in UTC ISO-8601."""
    lines = []
    vols = df["volume"].astype("Float64").fillna(0)
    for ts, o, h, l, c, v in zip(df["ts"], df["open"], df["high"], df["low"], df["close"], vols):
        lines.append(f"{series},{ts.tz_convert('UTC').strftime('%Y-%m-%dT%H:%M:%SZ')},"
                     f"{float(o)!r},{float(h)!r},{float(l)!r},{float(c)!r},{float(v)!r}")
    return lines


def seed_sql(series: str, csv_lines: list[str]) -> str:
    """Stage via COPY into a temp table, then upsert. Idempotent: re-running rewrites the same rows."""
    cols = ", ".join(BAR_COLS)
    return (
        "BEGIN;\n"
        "CREATE TEMP TABLE mbm_bars_stage (LIKE mbm_bars_1m INCLUDING DEFAULTS) ON COMMIT DROP;\n"
        f"COPY mbm_bars_stage ({cols}) FROM STDIN WITH (FORMAT csv);\n"
        + "".join(line + "\n" for line in csv_lines)
        + "\\.\n"
        f"INSERT INTO mbm_bars_1m ({cols}) SELECT {cols} FROM mbm_bars_stage\n"
        "ON CONFLICT (series, ts) DO UPDATE SET open = EXCLUDED.open, high = EXCLUDED.high, "
        "low = EXCLUDED.low, close = EXCLUDED.close, volume = EXCLUDED.volume;\n"
        f"SELECT {lit(series)} AS series, count(*) AS staged FROM mbm_bars_stage;\n"
        "COMMIT;\n")


def verify_sql() -> str:
    return (
        "SET default_transaction_read_only = on;\n"
        "\\echo '== ai_models (mbm-move)'\n"
        'SELECT id, instrument, horizon, gate, active, "artifactPath", "createdAt" FROM ai_models '
        f"WHERE kind = {lit(KIND)} ORDER BY instrument, horizon, \"createdAt\" DESC;\n"
        "\\echo '== mbm_bars_1m'\n"
        "SELECT series, count(*) AS rows, min(ts) AS first, max(ts) AS last FROM mbm_bars_1m "
        "GROUP BY series ORDER BY series;\n"
        "\\echo '== mbm_predictions'\n"
        "SELECT instrument, horizon, count(*) AS rows, max(as_of) AS last_as_of, "
        "count(outcome_at) AS with_outcome FROM mbm_predictions GROUP BY 1, 2 ORDER BY 1, 2;\n")


def universe_series(manifest: dict) -> list[str]:
    """NIFTY universe = NIFTY, BANKNIFTY, INDIAVIX + EQ_* heavyweights that have 1m bars."""
    return sorted(s for s, iv in manifest.items()
                  if "1m" in iv and (s in FIXED_SERIES or s.startswith("EQ_")))


def active_ids_sql(ids: list[str]) -> str:
    """Read-only: which of `ids` are active right now (one id per output line)."""
    return ("SET default_transaction_read_only = on;\n\\pset tuples_only on\n\\pset format unaligned\n"
            f"SELECT id FROM ai_models WHERE id IN ({', '.join(lit(i) for i in ids)}) AND active;\n")


def ship_plan(instrument: str, version: str, horizon: str) -> tuple[str, str]:
    """(remote final dir, remote staging dir) for one horizon."""
    final = f"{REMOTE_MODELS}/{artifact_path(instrument, version, horizon)}"
    return final, final + ".partial"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


# ── remote execution ───────────────────────────────────────────────────────────

def ssh(a, remote_cmd: str, stdin: str | None = None, run: Runner = subprocess.run) -> str:
    res = run(["ssh", "-C", *_ssh_opts(a.ssh_key), a.vps, remote_cmd], input=stdin,
              capture_output=True, text=True, encoding="utf-8")
    if res.returncode != 0:
        raise RuntimeError(f"ssh failed ({res.returncode}): {remote_cmd[:80]}…\n{res.stderr.strip()}")
    return res.stdout


def psql(a, sql: str, run: Runner = subprocess.run) -> str:
    return ssh(a, REMOTE_PSQL, stdin=sql, run=run)


def _need_remote(a) -> bool:
    if a.dry_run:
        return True
    if not a.vps or not a.ssh_key:
        print("needs --vps and --ssh-key (or MBM_VPS / MBM_SSH_KEY), or --dry-run")
        return False
    return True


# ── commands ───────────────────────────────────────────────────────────────────

def cmd_ship(a, run: Runner = subprocess.run) -> int:
    if not VERSION_RE.match(a.version) or not INSTRUMENT_RE.match(a.instrument):
        print(f"bad --version {a.version!r} (want YYYYMMDD-tag) or --instrument {a.instrument!r}")
        return 2
    src = a.models_dir or (a.store / "models" / "m1" / a.instrument.lower())
    metrics = json.loads((src / "metrics.json").read_text(encoding="utf-8"))
    if metrics.get("instrument") != a.instrument:
        print(f"{src / 'metrics.json'} is for {metrics.get('instrument')}, not {a.instrument}")
        return 2
    rows, plans = [], []
    for h in a.horizons:
        hdir = src / h
        missing = [f for f in MODEL_FILES if not (hdir / f).is_file()]
        if missing:
            print(f"{hdir}: missing {missing}")
            return 2
        meta = json.loads((hdir / "meta.json").read_text(encoding="utf-8"))
        row = registry_row(a.instrument, a.version, h, metrics, meta)
        if row["gate"] != "GO":
            print(f"{h}: gate NO_GO ({row['gateReasons']}); refusing to ship")
            return 2
        rows.append(row)
        plans.append((h, hdir, *ship_plan(a.instrument, a.version, h)))
    candidate = bool(getattr(a, "candidate", False))
    sql = registry_sql(rows, candidate=candidate)

    print(f"ship {a.instrument} {a.version} -> {a.vps or '<vps>'}" + (" (CANDIDATE: inactive)" if candidate else ""))
    if candidate:
        print("  -- pre-flight (read-only): refuse if any target id is active (its files are live) --")
    for h, hdir, final, stage in plans:
        print(f"  [{h}] scp {hdir}/{{{','.join(MODEL_FILES)}}} -> {stage}/ ; sha256 check ; mv -> {final}/")
    if a.dry_run:
        print("-- SQL (stdin to psql on the VPS) --")
        print(sql)
        return 0
    if not _need_remote(a):
        return 2
    if candidate:
        try:
            live = [ln.strip() for ln in psql(a, active_ids_sql([r["id"] for r in rows]), run=run).splitlines()
                    if ln.strip()]
        except RuntimeError as exc:
            print(f"ship FAILED (pre-flight): {exc}")
            return 1
        if live:
            print(f"refusing candidate: {live} already active (would overwrite served files); use a new version")
            return 2
    try:
        for h, hdir, final, stage in plans:  # files first: an active row must never point at nothing
            ssh(a, f"rm -rf '{stage}' && mkdir -p '{stage}'", run=run)
            run(["scp", *_ssh_opts(a.ssh_key), *[str(hdir / f) for f in MODEL_FILES], f"{a.vps}:{stage}/"],
                capture_output=True, text=True, check=True)
            remote = ssh(a, f"cd '{stage}' && sha256sum {' '.join(MODEL_FILES)}", run=run)
            got = {ln.split()[1]: ln.split()[0] for ln in remote.splitlines() if ln.strip()}
            bad = [f for f in MODEL_FILES if got.get(f) != sha256(hdir / f)]
            if bad:
                raise RuntimeError(f"{h}: checksum mismatch after scp: {bad}")
            ssh(a, f"rm -rf '{final}' && mv '{stage}' '{final}'", run=run)
            print(f"  [{h}] files in place: {final}")
        psql(a, sql, run=run)
    except (RuntimeError, subprocess.CalledProcessError) as exc:
        print(f"ship FAILED: {exc}")
        return 1
    state = "INACTIVE candidates (activate with mbm_monthly.py promote)" if candidate else "active"
    print(f"registry: {', '.join(r['id'] for r in rows)} {state}")
    return 0


def cmd_seed(a, run: Runner = subprocess.run) -> int:
    if a.days < 1:
        print("--days must be >= 1")
        return 2
    series = a.series or universe_series(load_manifest(a.store))
    if not series:
        print(f"no universe series with 1m bars in {a.store}")
        return 2
    start = datetime.now(timezone.utc) - timedelta(days=a.days)
    if not _need_remote(a):
        return 2
    failed = []
    for s in series:
        df = read_bars(a.store, s, "1m", start=start)
        lines = bars_csv(s, df)
        sql = seed_sql(s, lines)
        if a.dry_run:
            head = seed_sql(s, lines[:3])
            print(f"-- {s}: {len(lines)} rows since {start:%Y-%m-%d} (showing 3)")
            print(head)
            continue
        if not lines:
            print(f"  {s}: 0 rows in store window; skipped")
            continue
        try:
            psql(a, sql, run=run)
            print(f"  {s}: {len(lines)} rows upserted")
        except RuntimeError as exc:
            print(f"  {s}: FAILED {exc}")
            failed.append(s)
    if failed:
        print(f"seed-bars failed for: {', '.join(failed)}")
        return 1
    return 0


def cmd_verify(a, run: Runner = subprocess.run) -> int:
    sql = verify_sql()
    ls_cmd = f"ls -l {REMOTE_MODELS}/mbm/*/*/* 2>/dev/null || echo 'no mbm model dirs'"
    if a.dry_run:
        print(f"-- ssh {a.vps or '<vps>'} {ls_cmd}")
        print("-- SQL (read-only) --")
        print(sql)
        return 0
    if not _need_remote(a):
        return 2
    try:
        print(ssh(a, ls_cmd, run=run))
        print(psql(a, sql, run=run))
    except RuntimeError as exc:
        print(f"verify FAILED: {exc}")
        return 1
    return 0


def main(argv: list[str] | None = None) -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass
    p = argparse.ArgumentParser(prog="mbm_ship", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--store", type=Path, default=default_root())
    common.add_argument("--vps", default=os.environ.get("MBM_VPS"))
    common.add_argument("--ssh-key", type=Path, default=os.environ.get("MBM_SSH_KEY"))
    common.add_argument("--dry-run", action="store_true", help="print SQL + scp plan; touch nothing")
    sh = sub.add_parser("ship", parents=[common], help="scp Model A artefacts + upsert ai_models rows")
    sh.add_argument("--instrument", default="NIFTY")
    sh.add_argument("--version", required=True, help="YYYYMMDD-tag, e.g. 20261019-fs2")
    sh.add_argument("--horizons", nargs="+", default=list(HORIZONS), choices=HORIZONS)
    sh.add_argument("--models-dir", type=Path, help="default <store>/models/m1/<instrument>")
    sh.add_argument("--candidate", action="store_true",
                    help="M4: register the rows INACTIVE (no sibling deactivation); promote activates")
    sd = sub.add_parser("seed-bars", parents=[common], help="upload last N days of universe 1m bars")
    sd.add_argument("--days", type=int, default=60)
    sd.add_argument("--series", nargs="+", help="default: NIFTY, BANKNIFTY, INDIAVIX, EQ_* from the manifest")
    sub.add_parser("verify", parents=[common], help="read-only: model dirs, registry rows, bar/prediction counts")
    a = p.parse_args(argv)
    if a.ssh_key:
        a.ssh_key = Path(os.path.expanduser(str(a.ssh_key)))
    return {"ship": cmd_ship, "seed-bars": cmd_seed, "verify": cmd_verify}[a.cmd](a)


if __name__ == "__main__":
    sys.exit(main())
