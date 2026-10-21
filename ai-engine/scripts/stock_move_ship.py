"""Stock big-move model (SHADOW), PC side: refresh prices, train the GO model, ship it INACTIVE, promote.

  py -3 scripts/stock_move_ship.py fetch-prices                 # seed the PC CSV cache from research + Yahoo update
  py -3 scripts/stock_move_ship.py train [--version 20261022]   # walk-forward gate + final fit -> artefact dir
  py -3 scripts/stock_move_ship.py ship --version 20261022 --vps root@<ip> --ssh-key ~/.ssh/grw_oracle [--dry-run]
  py -3 scripts/stock_move_ship.py promote --model-id stock-move-20261022 --yes --vps … --ssh-key … [--dry-run]
  py -3 scripts/stock_move_ship.py verify --vps … --ssh-key …

train: the research GO configuration (research/stock-daily `run_er.py wf er0`): build.py features + strict
announced-only earnings features, LightGBM (run_er PARAMS), tree count from the static early stop (train <= 2022,
validate 2023), quarterly expanding walk-forward 2024-01.. as the gate (evalkit 'big': last-3-month AUC >= 0.65
and every month >= 0.55), isotonic fitted on those out-of-sample walk-forward scores, final booster on every
labelled row through the latest session. Writes <store>/models/stock-move/<version>/ (stock_move.model.MODEL_FILES).

ship: like `mbm_ship.py ship --candidate`: scp to /opt/grw/models/stock-move/<version>/ via a .partial dir with
sha256 checks, then upsert the ai_models row (kind stock-move) INACTIVE. Never activates; `promote` does, after
the owner approves. The service reads the registry at every nightly run: no restart needed.

Exit codes: 0 ok · 1 a step / remote call failed · 2 refused (gate not passed, files missing, bad usage).
"""
from __future__ import annotations

import argparse
import gc
import glob
import importlib.util
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

from src.mbm.stock_move import FEATURE_SET, HORIZON_DAYS, KIND, TARGET, THRESHOLD_ATR  # noqa: E402
from src.mbm.stock_move import calendar as C  # noqa: E402
from src.mbm.stock_move import features as F  # noqa: E402
from src.mbm.stock_move.model import MODEL_FILES, design  # noqa: E402
from src.mbm.stock_move.panel import build_panel, frame_reader  # noqa: E402
from src.mbm.stock_move.prices import PriceCache, final_cutoff, refresh_all, seed_from_frames  # noqa: E402
from src.mbm.store import default_root  # noqa: E402

_spec = importlib.util.spec_from_file_location("mbm_ship", ROOT / "scripts" / "mbm_ship.py")
S = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(S)
lit, _json = S.lit, S._json

RESEARCH = Path(os.environ.get("STOCK_MOVE_RESEARCH") or (Path.home() / "grw-mbm" / "research" / "stock-daily"))
SECTORS_CSV = Path(os.environ.get("STOCK_MOVE_SECTORS")
                   or (Path.home() / "Desktop" / "TD_Automation" / "stock_sectors-db-2026-05-20.csv"))
REMOTE_MODELS = S.REMOTE_MODELS
VERSION_RE = re.compile(r"^\d{8}$")
MODEL_ID_RE = re.compile(r"^stock-move-\d{8}$")
PARAMS = dict(objective="binary", learning_rate=0.03, num_leaves=31, min_child_samples=1000,
              feature_fraction=0.7, bagging_fraction=0.7, bagging_freq=1, lambda_l2=10.0,
              n_jobs=3, verbose=-1, seed=7)
EMB = 10
WF_START = "2024-01-01"
GATE_LAST3, GATE_MON_MIN = 0.65, 0.55
HORIZON = f"{HORIZON_DAYS}d"


# ── data (PC: research caches) ─────────────────────────────────────────────────

def store_dir() -> Path:
    return default_root() / "stock-move"


def load_research_prices(raw_dir: Path) -> dict[str, pd.DataFrame]:
    out = {}
    for p in sorted(glob.glob(str(raw_dir / "*.parquet"))):
        d = pd.read_parquet(p)
        out[Path(p).stem] = d[["date", "open", "high", "low", "close", "volume"]].sort_values("date").reset_index(drop=True)
    return out


def load_research_calendar(earn_dir: Path, names: list[str]) -> tuple[pd.DataFrame, pd.DataFrame]:
    """parse_earnings.py's nse_rows/bse_rows over the cached raw JSON (via the ported parsers)."""
    def js(p):
        with open(p, encoding="utf-8") as fh:
            return json.load(fh)
    R, B = [], []
    for s in names:
        nr = earn_dir / "nse" / "res" / f"{s}.json"
        nb = earn_dir / "nse" / "bm" / f"{s}.json"
        r, b = C.nse_rows(s, js(nr) if nr.is_file() else [], js(nb) if nb.is_file() else [])
        R += r
        B += b
        rt = [x for f in glob.glob(str(earn_dir / "bse" / "res" / f"{s}_*.json")) for x in (js(f).get("Table") or [])]
        bt = [x for f in glob.glob(str(earn_dir / "bse" / "bm" / f"{s}_*.json")) for x in (js(f).get("Table") or [])]
        r, b = C.bse_rows(s, rt, bt)
        R += r
        B += b
    return C.frames(R, B)


def load_sectors(path: Path) -> dict[str, str]:
    s = pd.read_csv(path)
    return dict(zip(s["symbol"].astype(str), s["industry"].astype(str)))


def research_universe(raw_dir: Path) -> list[str]:
    return sorted(p.stem for p in raw_dir.glob("*.parquet") if p.stem not in F.INDEX_NAMES)


# ── metrics (evalkit 'big' gate, Mann-Whitney AUC) ─────────────────────────────

def auc(y, p) -> float:
    y = np.asarray(y, dtype="float64")
    p = np.asarray(p, dtype="float64")
    n1 = y.sum()
    n0 = len(y) - n1
    if n1 == 0 or n0 == 0:
        return float("nan")
    r = pd.Series(p).rank(method="average").to_numpy()
    return float((r[y == 1].sum() - n1 * (n1 + 1) / 2) / (n1 * n0))


def gate_metrics(dates, y, p) -> dict:
    m = pd.DatetimeIndex(dates).strftime("%Y-%m").to_numpy()
    y, p = np.asarray(y, float), np.asarray(p, float)
    months = sorted(set(m))
    mon = {k: auc(y[m == k], p[m == k]) for k in months}
    mvals = np.array([v for v in mon.values() if v == v])
    last3 = months[-3:]
    sel = np.isin(m, last3)
    q80, q20 = np.quantile(p, [0.8, 0.2])
    out = {"n": int(len(y)), "months": len(months), "base_rate": float(y.mean()), "auc": auc(y, p),
           "auc_last3": auc(y[sel], p[sel]), "last3": f"{last3[0]}..{last3[-1]}",
           "mon_min": float(mvals.min()), "mon_med": float(np.median(mvals)),
           "hit_top20": float(y[p > q80].mean()), "hit_bottom20": float(y[p <= q20].mean()),
           "monthly": {k: (None if v != v else round(v, 4)) for k, v in mon.items()}}
    checks = {"auc_last3": out["auc_last3"] >= GATE_LAST3, "mon_min": out["mon_min"] >= GATE_MON_MIN}
    out.update(checks=checks, gate="GO" if all(checks.values()) else "NO_GO")
    return out


def cut_before(dates: np.ndarray, boundary, emb: int = EMB):
    prior = dates[dates < np.datetime64(pd.Timestamp(boundary))]
    return prior[-emb - 1] if len(prior) > emb else prior[0]


# ── train ──────────────────────────────────────────────────────────────────────

def make_panel(a) -> tuple[pd.DataFrame, list[str], dict, pd.Timestamp]:
    raw_dir = a.research / "data" / "raw"
    frames = load_research_prices(raw_dir)
    cache = PriceCache(a.prices_dir)
    if a.prices_dir.is_dir():      # the fetch-prices cache: research history + the Yahoo update
        for n in list(frames):
            d = cache.read(n)
            if len(d):
                frames[n] = d
    names = research_universe(raw_dir)
    R, B = load_research_calendar(a.research / "data" / "earnings", names)
    sectors = load_sectors(a.sectors)
    cutoff = final_cutoff(datetime.now(timezone.utc)) if a.cutoff is None else pd.Timestamp(a.cutoff)
    p, stats = build_panel(names, frame_reader(frames), R, B, sectors, cutoff)
    print(f"panel rows {len(p)} syms {p.sym.nunique()} {p.date.min().date()}..{p.date.max().date()} "
          f"(priced {stats['priced']}, no events {stats['no_events']}); R {len(R)} B {len(B)}", flush=True)
    return p, names, {"R": R, "B": B, "sectors": sectors}, cutoff


def fit(X, y, rounds, valid=None):
    import lightgbm as lgb
    ds = lgb.Dataset(X, y, categorical_feature=["sector"] if "sector" in X.columns else "auto", free_raw_data=True)
    if valid is None:
        return lgb.train(PARAMS, ds, num_boost_round=rounds)
    vs = lgb.Dataset(valid[0], valid[1], reference=ds)
    return lgb.train(PARAMS, ds, num_boost_round=rounds, valid_sets=[vs],
                     callbacks=[lgb.early_stopping(100, verbose=False)])


def cmd_train(a) -> int:
    from sklearn.isotonic import IsotonicRegression
    p, names, cal, cutoff = make_panel(a)
    p = p.drop(columns=[C.MEET_COL])
    cols = F.feature_columns(p.columns)
    cats = sorted(p["sector"].astype(str).unique())
    X = design(p, cols, cats)
    y = p[TARGET].to_numpy()
    dates = np.sort(p["date"].unique())
    dts = p["date"].to_numpy()
    lab = ~np.isnan(y)
    # 1) tree count: static early stop (train <= 2022, validate 2023), as run_er.py static
    tr_end, va_end = cut_before(dates, "2023-01-01"), cut_before(dates, "2024-01-01")
    mtr = lab & (dts <= tr_end)
    mva = lab & (dts >= np.datetime64("2023-01-01")) & (dts <= va_end)
    m = fit(X[mtr], y[mtr], 1500, valid=(X[mva], y[mva]))
    best = int(m.best_iteration or 100)
    if best < 50:
        best = 300
    print(f"best_iter {best} (research er0: 89)", flush=True)
    del m
    gc.collect()
    # 2) walk-forward gate: quarterly expanding refits from 2024-01
    te = lab & (dts >= np.datetime64(WF_START))
    pt = np.full(len(p), np.nan)
    for q0 in pd.date_range(WF_START, pd.Timestamp(dates.max()), freq="QS"):
        q1 = q0 + pd.offsets.QuarterBegin(startingMonth=1)
        lim = cut_before(dates, q0)
        trm = lab & (dts <= lim)
        mq = fit(X[trm], y[trm], max(best, 50))
        sel = te & (dts >= np.datetime64(q0)) & (dts < np.datetime64(q1))
        if sel.any():
            pt[sel] = mq.predict(X[sel])
        print(f"  wf {q0.date()}: train {int(trm.sum())} -> scored {int(sel.sum())}", flush=True)
        del mq
        gc.collect()
    g = gate_metrics(dts[te], y[te], pt[te])
    print(f"walk-forward AUC {g['auc']:.4f} last3 {g['auc_last3']:.4f} ({g['last3']}) month min {g['mon_min']:.3f} "
          f"top20 hit {g['hit_top20']:.3f} bottom20 {g['hit_bottom20']:.3f} -> {g['gate']}", flush=True)
    iso = IsotonicRegression(out_of_bounds="clip", y_min=0.0, y_max=1.0).fit(pt[te], y[te])
    # 3) final model on every labelled row
    final = fit(X[lab], y[lab], best)
    last_lab = pd.Timestamp(dts[lab].max())
    version = a.version or datetime.now().strftime("%Y%m%d")
    out = a.out / version
    out.mkdir(parents=True, exist_ok=True)
    final.save_model(str(out / "model.txt"))
    universe = sorted(p["sym"].unique())
    meta = {
        "modelId": f"{KIND}-{version}", "kind": KIND, "featureSet": FEATURE_SET, "target": TARGET,
        "horizonDays": HORIZON_DAYS, "thresholdAtr": THRESHOLD_ATR, "columns": cols, "sectorCategories": cats,
        "sectors": {s: cal["sectors"][s] for s in sorted(cal["sectors"])},
        "isotonic": {"x": [float(v) for v in iso.X_thresholds_], "y": [float(v) for v in iso.y_thresholds_]},
        "bestIter": best, "params": PARAMS, "trainedThrough": str(pd.Timestamp(dates.max()).date()),
        "lastLabelled": str(last_lab.date()), "cutoff": str(cutoff.date()), "nTrain": int(lab.sum()),
        "universe": universe, "erFallback": 0,
        "source": "research/stock-daily run_er.py wf er0 (ported: ai-engine/src/mbm/stock_move)",
    }
    (out / "meta.json").write_text(json.dumps(meta, indent=1), encoding="utf-8")
    metrics = {"kind": KIND, "featureSet": FEATURE_SET, "built": datetime.now().strftime("%Y-%m-%d"),
               "target": TARGET, "walkForward": g, "bestIter": best, "nTrain": int(lab.sum()),
               "nHoldout": int(te.sum()), "trainedThrough": meta["trainedThrough"]}
    (out / "metrics.json").write_text(_json(metrics), encoding="utf-8")
    from src.mbm.stock_move.nse import write_csv
    write_csv(cal["R"], out / "calendar_R.csv.gz")
    write_csv(cal["B"], out / "calendar_B.csv.gz")
    imp = pd.Series(final.feature_importance("gain"), index=cols)
    print("top gain:", (imp / imp.sum()).sort_values(ascending=False).head(8).round(3).to_dict())
    print(f"artefact {out} gate {g['gate']} trained through {meta['trainedThrough']} n_train {meta['nTrain']}")
    return 0 if g["gate"] == "GO" else 2


def cmd_fetch_prices(a) -> int:
    cache = PriceCache(a.prices_dir)
    n = seed_from_frames(cache, load_research_prices(a.research / "data" / "raw"))
    names = ["NIFTYIDX", "INDIAVIX", *research_universe(a.research / "data" / "raw")]
    print(f"seeded {n} symbols into {a.prices_dir}; refreshing {len(names)} from Yahoo (~1 s each)", flush=True)
    st = refresh_all(cache, names, datetime.now(timezone.utc))
    print(f"yahoo ok {st['ok']} failed {st['failed']} readjusted {st['readjusted']}")
    return 0 if not st["failed"] else 1


# ── registry / ship ────────────────────────────────────────────────────────────

def model_id(version: str) -> str:
    return f"{KIND}-{version}"


def artifact_path(version: str) -> str:
    return f"stock-move/{version}"


def registry_row(version: str, metrics: dict, meta: dict) -> dict:
    g = metrics["walkForward"]
    return {
        "id": model_id(version), "kind": KIND, "featureSet": meta["featureSet"],
        "trainedAt": f"{metrics['built']}T00:00:00Z",
        "dataWindow": {"trainedThrough": meta["trainedThrough"], "lastLabelled": meta.get("lastLabelled"),
                       "walkForwardFrom": WF_START, "last3": g.get("last3")},
        "nTrain": int(metrics.get("nTrain") or 0), "nHoldout": int(metrics.get("nHoldout") or 0),
        "metrics": {k: v for k, v in g.items()}, "gate": g["gate"],
        "gateReasons": sorted(k for k, ok in (g.get("checks") or {}).items() if not ok),
        "artifactPath": artifact_path(version), "instrument": None, "horizon": HORIZON,
    }


def registry_sql(row: dict) -> str:
    """Upsert the row INACTIVE; never touches a row that is currently active (its files are live)."""
    if row["gate"] != "GO":
        raise ValueError(f"{row['id']}: gate {row['gate']} cannot be shipped")
    reasons = "ARRAY[" + ", ".join(lit(x) for x in row["gateReasons"]) + "]::text[]"
    return (
        "BEGIN;\n"
        'INSERT INTO ai_models (id, kind, "featureSet", "trainedAt", "dataWindow", "nTrain", "nHoldout", '
        'metrics, gate, "gateReasons", "artifactPath", active, instrument, horizon)\n'
        f"VALUES ({lit(row['id'])}, {lit(row['kind'])}, {lit(row['featureSet'])}, {lit(row['trainedAt'])}::timestamptz, "
        f"{lit(_json(row['dataWindow']))}::jsonb, {row['nTrain']}, {row['nHoldout']}, {lit(_json(row['metrics']))}::jsonb, "
        f"{lit(row['gate'])}, {reasons}, {lit(row['artifactPath'])}, false, {lit(row['instrument'])}, {lit(row['horizon'])})\n"
        'ON CONFLICT (id) DO UPDATE SET "featureSet" = EXCLUDED."featureSet", "trainedAt" = EXCLUDED."trainedAt", '
        '"dataWindow" = EXCLUDED."dataWindow", "nTrain" = EXCLUDED."nTrain", "nHoldout" = EXCLUDED."nHoldout", '
        'metrics = EXCLUDED.metrics, gate = EXCLUDED.gate, "gateReasons" = EXCLUDED."gateReasons", '
        '"artifactPath" = EXCLUDED."artifactPath", horizon = EXCLUDED.horizon WHERE NOT ai_models.active;\n'
        "COMMIT;\n")


def promote_sql(mid: str) -> str:
    m = lit(mid)
    return (
        "BEGIN;\n"
        f"UPDATE ai_models SET active = false WHERE kind = {lit(KIND)} AND active AND id <> {m};\n"
        f"UPDATE ai_models SET active = true WHERE id = {m} AND kind = {lit(KIND)} AND gate = 'GO';\n"
        f"DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM ai_models WHERE id = {m} AND active) THEN "
        f"RAISE EXCEPTION 'promote: % not activated (missing, not GO or wrong kind)', {m}; END IF; END $$;\n"
        "COMMIT;\n")


def verify_sql() -> str:
    return ("SET default_transaction_read_only = on;\n"
            "\\echo '== ai_models (stock-move)'\n"
            'SELECT id, gate, active, "artifactPath", "createdAt" FROM ai_models '
            f"WHERE kind = {lit(KIND)} ORDER BY \"createdAt\" DESC;\n"
            "\\echo '== stock_move_scores'\n"
            "SELECT as_of, count(*) AS rows, count(*) FILTER (WHERE bucket = 'TOP20') AS top20, "
            "count(outcome_at) AS with_outcome, min(model_id) AS model FROM stock_move_scores "
            "GROUP BY as_of ORDER BY as_of DESC LIMIT 10;\n")


def cmd_ship(a, run=subprocess.run) -> int:
    if not VERSION_RE.match(a.version or ""):
        print(f"bad --version {a.version!r} (want YYYYMMDD)")
        return 2
    src = a.out / a.version
    missing = [f for f in MODEL_FILES if not (src / f).is_file()]
    if missing:
        print(f"{src}: missing {missing}")
        return 2
    metrics = json.loads((src / "metrics.json").read_text(encoding="utf-8"))
    meta = json.loads((src / "meta.json").read_text(encoding="utf-8"))
    row = registry_row(a.version, metrics, meta)
    if row["gate"] != "GO":
        print(f"gate NO_GO ({row['gateReasons']}); refusing to ship")
        return 2
    sql = registry_sql(row)
    final = f"{REMOTE_MODELS}/{artifact_path(a.version)}"
    stage = final + ".partial"
    print(f"ship {row['id']} -> {a.vps or '<vps>'} (INACTIVE; promote activates)")
    print(f"  scp {src}/{{{','.join(MODEL_FILES)}}} -> {stage}/ ; sha256 check ; mv -> {final}/")
    if a.dry_run:
        print("-- SQL (stdin to psql on the VPS) --")
        print(sql)
        return 0
    if not S._need_remote(a):
        return 2
    try:
        live = [ln.strip() for ln in S.psql(a, S.active_ids_sql([row["id"]]), run=run).splitlines() if ln.strip()]
        if live:
            print(f"refusing: {live} is active (would overwrite served files); use a new version")
            return 2
        S.ssh(a, f"rm -rf '{stage}' && mkdir -p '{stage}'", run=run)
        run(["scp", *S._ssh_opts(a.ssh_key), *[str(src / f) for f in MODEL_FILES], f"{a.vps}:{stage}/"],
            capture_output=True, text=True, check=True)
        remote = S.ssh(a, f"cd '{stage}' && sha256sum {' '.join(MODEL_FILES)}", run=run)
        got = {ln.split()[1]: ln.split()[0] for ln in remote.splitlines() if ln.strip()}
        bad = [f for f in MODEL_FILES if got.get(f) != S.sha256(src / f)]
        if bad:
            raise RuntimeError(f"checksum mismatch after scp: {bad}")
        S.ssh(a, f"rm -rf '{final}' && mv '{stage}' '{final}'", run=run)
        S.psql(a, sql, run=run)
    except (RuntimeError, subprocess.CalledProcessError) as exc:
        print(f"ship FAILED: {exc}")
        return 1
    print(f"registry: {row['id']} INACTIVE. Activate after approval: "
          f"py -3 scripts/stock_move_ship.py promote --model-id {row['id']} --yes --vps … --ssh-key …")
    return 0


def cmd_promote(a, run=subprocess.run) -> int:
    if not MODEL_ID_RE.match(a.model_id or ""):
        print(f"bad --model-id {a.model_id!r} (want stock-move-YYYYMMDD)")
        return 2
    sql = promote_sql(a.model_id)
    if a.dry_run or not a.yes:
        print("-- promote SQL (stdin to psql on the VPS); pass --yes to run --")
        print(sql)
        return 0 if a.dry_run else 2
    if not S._need_remote(a):
        return 2
    try:
        S.psql(a, sql, run=run)
    except RuntimeError as exc:
        print(f"promote FAILED: {exc}")
        return 1
    print(f"promoted {a.model_id}; the grw-mbm nightly stock-move run picks it up (no restart needed)")
    return 0


def cmd_verify(a, run=subprocess.run) -> int:
    sql = verify_sql()
    if a.dry_run:
        print(sql)
        return 0
    if not S._need_remote(a):
        return 2
    try:
        print(S.ssh(a, f"ls -l {REMOTE_MODELS}/stock-move/* 2>/dev/null || echo 'no stock-move dirs'", run=run))
        print(S.psql(a, sql, run=run))
    except RuntimeError as exc:
        print(f"verify FAILED: {exc}")
        return 1
    return 0


def main(argv: list[str] | None = None) -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass
    p = argparse.ArgumentParser(prog="stock_move_ship", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--research", type=Path, default=RESEARCH)
    common.add_argument("--sectors", type=Path, default=SECTORS_CSV)
    common.add_argument("--prices-dir", type=Path, default=store_dir() / "prices")
    common.add_argument("--out", type=Path, default=default_root() / "models" / "stock-move")
    common.add_argument("--vps", default=os.environ.get("MBM_VPS"))
    common.add_argument("--ssh-key", type=Path, default=os.environ.get("MBM_SSH_KEY"))
    common.add_argument("--dry-run", action="store_true")
    sub.add_parser("fetch-prices", parents=[common], help="seed + Yahoo-refresh the PC price cache")
    t = sub.add_parser("train", parents=[common], help="walk-forward gate + final fit -> artefact dir")
    t.add_argument("--version", help="YYYYMMDD (default today)")
    t.add_argument("--cutoff", help="first excluded date (default: today, or tomorrow after 16:00 IST)")
    s = sub.add_parser("ship", parents=[common], help="scp the artefact + register it INACTIVE")
    s.add_argument("--version", required=True)
    pr = sub.add_parser("promote", parents=[common], help="activate one shipped model (owner approval)")
    pr.add_argument("--model-id", required=True)
    pr.add_argument("--yes", action="store_true")
    sub.add_parser("verify", parents=[common], help="read-only: artefact dirs + registry + score counts")
    a = p.parse_args(argv)
    if a.ssh_key:
        a.ssh_key = Path(os.path.expanduser(str(a.ssh_key)))
    return {"fetch-prices": cmd_fetch_prices, "train": cmd_train, "ship": cmd_ship,
            "promote": cmd_promote, "verify": cmd_verify}[a.cmd](a)


if __name__ == "__main__":
    sys.exit(main())
