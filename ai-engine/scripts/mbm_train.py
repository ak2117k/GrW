"""MBM Model A training CLI (M1, offline, PC only).

  py -3 ai-engine/scripts/mbm_train.py train-a --instrument NIFTY
  py -3 ai-engine/scripts/mbm_train.py train-a --instrument NIFTY --no-ablation --rebuild

Reads the parquet store (MBM_STORE or ~/grw-mbm), writes models + metrics under
<store>/models/m1/ and a markdown report to <store>/reports/m1-<instrument>-<date>.md.
Exit codes: 0 ran (gate results are in the report, PASS or FAIL) · 2 bad usage / no data.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

from src.mbm import model_a as A  # noqa: E402
from src.mbm.features import DRIVER_GROUPS, FEATURE_SET, load_inputs  # noqa: E402
from src.mbm.labels import HORIZONS  # noqa: E402
from src.mbm import patterns as PB  # noqa: E402
from src.mbm.store import default_root, read_bars  # noqa: E402


def _md_table(df: pd.DataFrame, floatfmt: str = "{:.4f}") -> str:
    cols = list(df.columns)
    lines = ["| " + " | ".join(map(str, cols)) + " |", "|" + "---|" * len(cols)]
    for _, r in df.iterrows():
        cells = [floatfmt.format(v) if isinstance(v, float) else str(v) for v in r]
        lines.append("| " + " | ".join(cells) + " |")
    return "\n".join(lines)


def _save_models(out: Path, h: str, final: dict) -> None:
    d = out / h
    d.mkdir(parents=True, exist_ok=True)
    final["classifier"].booster_.save_model(str(d / "classifier.txt"))
    for q, m in final["quantiles"].items():
        m.booster_.save_model(str(d / f"q{int(q * 100)}.txt"))
    meta = {k: v for k, v in final.items() if k not in ("classifier", "quantiles")}
    (d / "meta.json").write_text(json.dumps(meta, indent=1), encoding="utf-8")


def horizon_result(p: pd.DataFrame) -> dict:
    g = A.gate(p)
    g["monthly"] = A.monthly_metrics(p).round(5).to_dict("records")
    g["quantile_coverage"] = A.quantile_coverage(p)
    g["calibration"] = A.calibration_table(p).astype({"bucket": str}).round(4).to_dict("records")
    g["regimes"] = A.regime_table(p).round(4).to_dict("records")
    return g


def report_only(args) -> int:
    """Rebuild metrics.json + report from saved blind predictions (no retraining)."""
    root = Path(args.store) if args.store else default_root()
    inst = args.instrument.upper()
    out = root / "models" / "m1" / inst.lower()
    ds = pd.read_parquet(out / "dataset.parquet")
    old = json.loads((out / "metrics.json").read_text(encoding="utf-8")) if (out / "metrics.json").exists() else {}
    results = {h: horizon_result(pd.read_parquet(out / f"preds_{h}.parquet"))
               for h in HORIZONS if (out / f"preds_{h}.parquet").exists()}
    cols = A.model_columns(ds, DRIVER_GROUPS)
    metrics = {"featureSet": FEATURE_SET, "instrument": inst, "built": date.today().isoformat(),
               "decision_step_min": A.DECISION_STEP, "next_decision": "15:15 IST",
               "regime_bands": list(A.REGIME_BANDS), "columns": cols,
               "runtime_s": args.runtime or old.get("runtime_s"), "walk_forward_s": old.get("walk_forward_s"),
               "horizons": results, "ablation": old.get("ablation") or {}, "note": args.note}
    (out / "metrics.json").write_text(json.dumps(metrics, indent=1, default=str), encoding="utf-8")
    rpt = root / "reports" / f"m1-{inst.lower()}-{date.today().isoformat()}.md"
    rpt.write_text(render_report(metrics, ds), encoding="utf-8")
    print(f"report → {rpt}")
    return 0


def train_a(args) -> int:
    root = Path(args.store) if args.store else default_root()
    inst = args.instrument.upper()
    out = root / "models" / "m1" / inst.lower()
    out.mkdir(parents=True, exist_ok=True)
    (root / "reports").mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    cache = out / "dataset.parquet"
    if cache.exists() and not args.rebuild:
        ds = pd.read_parquet(cache)
        ds["month"] = ds["date"].dt.to_period("M")
    else:
        inputs = load_inputs(root, inst)
        if inputs["instrument"].empty:
            print(f"no 1m bars for {inst} in {root}", file=sys.stderr)
            return 2
        ds = A.build_dataset(inputs)
        ds.drop(columns=["month"]).to_parquet(cache)
    t_ds = time.time() - t0
    cols = A.model_columns(ds, DRIVER_GROUPS)
    print(f"dataset {len(ds)} rows x {len(cols)} features, {ds['date'].min().date()} → {ds['date'].max().date()} ({t_ds:.0f}s)", flush=True)

    horizons = args.horizons.split(",") if args.horizons else list(HORIZONS)
    cfg = A.WalkForward()
    results, preds_all = {}, {}
    for h in horizons:
        p = A.walk_forward(ds, h, cols, cfg)
        p.to_parquet(out / f"preds_{h}.parquet")
        preds_all[h] = p
        results[h] = g = horizon_result(p)
        print(f"{h}: gate {'PASS' if g['pass'] else 'FAIL'} last AUC {g['last_auc']} "
              f"brier {g['last_brier']:.4f} vs {g['last_brier_base']:.4f} ({cfg.timings[h]}s)", flush=True)
        _save_models(out, h, A.fit_final(ds, h, cols))

    abl = {}
    if not args.no_ablation:
        for h in horizons:
            ta = time.time()
            abl[h] = A.ablation(ds, h, args.ablation_months)
            print(f"ablation {h} done ({time.time() - ta:.0f}s)", flush=True)

    runtime = round(time.time() - t0)
    metrics = {"featureSet": FEATURE_SET, "instrument": inst, "built": date.today().isoformat(),
               "decision_step_min": A.DECISION_STEP, "next_decision": "15:15 IST",
               "regime_bands": list(A.REGIME_BANDS), "columns": cols, "runtime_s": runtime,
               "walk_forward_s": cfg.timings, "horizons": results, "ablation": abl}
    (out / "metrics.json").write_text(json.dumps(metrics, indent=1, default=str), encoding="utf-8")
    rpt = root / "reports" / f"m1-{inst.lower()}-{date.today().isoformat()}.md"
    rpt.write_text(render_report(metrics, ds), encoding="utf-8")
    print(f"metrics → {out / 'metrics.json'}\nreport → {rpt}\nruntime {runtime}s")
    return 0


def render_report(m: dict, ds: pd.DataFrame) -> str:
    L = [f"# MBM M1 — Model A, {m['instrument']} ({m['built']})", "",
         f"featureSet `{m['featureSet']}` · {len(m['columns'])} features · data "
         f"{ds['date'].min().date()} → {ds['date'].max().date()} · decision rows every "
         f"{m['decision_step_min']} min 09:30–15:15 IST (`next` horizon: 15:15 row only) · "
         f"walk-forward expanding window, ≥12 months train (last 2 months = isotonic calibration), "
         f"monthly retrain · runtime {m['runtime_s']} s.", "",
         "Gate per horizon: pooled AUC ≥ 0.65 over the last 3 blind months, no one of them below 0.55, "
         "Brier over those months below the trailing-median baseline (trailing 60-session share of big outcomes at the same "
         "minute), ≥ 300 blind observations in total.", ""] + ([f"> {m['note']}", ""] if m.get("note") else []) + [
         "## Gate", "",
         "| horizon | gate | last 3 months | AUC per month | pooled AUC | n | Brier | baseline | blind obs | AUC all months |",
         "|---|---|---|---|---|---|---|---|---|---|"]
    for h, g in m["horizons"].items():
        L.append(f"| {h} | **{'PASS' if g['pass'] else 'FAIL'}** | {', '.join(g['last_months'])} | "
                 f"{', '.join(f'{a:.3f}' for a in g['last_auc'])} | {g.get('last_auc_pooled', float('nan')):.3f} | {', '.join(map(str, g['last_n']))} | "
                 f"{g['last_brier']:.4f} | {g['last_brier_base']:.4f} | {g['n_test']} | {g['auc_all']:.3f} |")
    if not m["ablation"]:
        L += ["", "## Driver ablation", "", "Not available for this run (see note above)."]
    if m["ablation"]:
        L += ["", "## Driver ablation (last 12 blind months, classifier only)", ""]
        for h, rows in m["ablation"].items():
            L += [f"### {h}", "", _md_table(pd.DataFrame(rows)), ""]
    for h, g in m["horizons"].items():
        mm = pd.DataFrame(g["monthly"])
        L += ["", f"## {h}", "", f"Quantile coverage (share of realised range ≤ predicted): "
              + ", ".join(f"{k} {v:.2f}" for k, v in g["quantile_coverage"].items()), "",
              "### Calibration buckets (all blind months)", "", _md_table(pd.DataFrame(g["calibration"])), "",
              "### Regime distribution (all blind months)", "", _md_table(pd.DataFrame(g["regimes"])), "",
              "### Monthly blind AUC / Brier", "", _md_table(mm), ""]
    return "\n".join(L)


def predict_a(args) -> int:
    """Forward test: score one session with the SAVED models and compare with what happened."""
    from src.mbm.predict import HorizonModel, score_session

    root = Path(args.store) if args.store else default_root()
    inst = args.instrument.upper()
    out = root / "models" / "m1" / inst.lower()
    horizons = args.horizons.split(",") if args.horizons else ["30m", "60m"]
    models = {h: HorizonModel.load(out / h) for h in horizons if (out / h / "meta.json").exists()}
    day = pd.Timestamp(args.date)
    # ~2 years of history covers every rolling window (ATR, 60-session thresholds, 20d stats).
    inputs = load_inputs(root, inst, start=(day - pd.Timedelta(days=730)).tz_localize("Asia/Kolkata"))
    ds = A.build_dataset(inputs)
    if not (ds["date"] == day).any():
        print(f"no {inst} bars for {day.date()} in the store — run `mbm_data.py build` after the close")
        return 1
    s = score_session(ds, models, day)
    L = [f"# MBM forward test — {inst} {day.date()}", "",
         "Models trained through: " + ", ".join(f"{h} {m.trained_through} ({m.feature_set})" for h, m in models.items())
         + " — this session was never seen in training.", ""]
    for h, g in s.groupby("horizon", sort=False):
        known = g.dropna(subset=["big"])
        L += [f"## {h}", "", "| time | P(big) | regime | p25–p75 bp | actual bp | big? | hit |", "|---|---|---|---|---|---|---|"]
        for _, r in g.iterrows():
            t = f"{r['mod'] // 60:02d}:{r['mod'] % 60:02d}"
            if np.isnan(r["big"]):
                act, big, hit = "—", "pending", ""
            else:
                act, big = f"{r['actual_bp']:.1f}", "YES" if r["big"] == 1 else "no"
                hit = "✓" if (r["p"] >= 0.5) == (r["big"] == 1) else "✗"
            L.append(f"| {t} | {r['p']:.2f} | {r['regime']} | {r['q25_bp']:.0f}–{r['q75_bp']:.0f} | {act} | {big} | {hit} |")
        if len(known):
            acc = float(((known["p"] >= 0.5) == (known["big"] == 1)).mean())
            band = float(((known["actual_bp"] >= known["q25_bp"]) & (known["actual_bp"] <= known["q75_bp"])).mean())
            L += ["", f"{len(known)} outcomes known · direction-of-call accuracy {acc:.0%} · "
                  f"inside p25–p75 {band:.0%} (target 50%) · big moves {known['big'].mean():.0%}"]
        L.append("")
    rpt = root / "reports" / f"forward-{inst.lower()}-{day.date()}.md"
    rpt.write_text("\n".join(L), encoding="utf-8")
    print("\n".join(L))
    print(f"report → {rpt}")
    return 0


def render_patterns_report(lib: dict) -> str:
    c, nl, m = lib["meta"]["search"], lib["meta"]["null"], lib["meta"]
    sig = nl["significant"]
    n_rules = len(lib["rules"])
    if n_rules == 0:
        verdict = "**EMPTY LIBRARY.** No rule passed discovery + blind verification. This is a valid, honest result."
    elif sig:
        verdict = (f"**SIGNIFICANT.** {n_rules} verified rules; the real search beats the shuffled null "
                   f"({c['blind_survivors']} > null p95 {nl['p95']:.1f}).")
    else:
        verdict = (f"**NOT SIGNIFICANT.** {n_rules} rules passed every per-rule check, but the shuffled null finds "
                   f"as many by chance ({c['blind_survivors']} <= null p95 {nl['p95']:.1f}). Treat the whole "
                   "library as noise; rules are listed but flagged.")
    L = [f"# MBM M4 — Pattern Library (Model B) · {m['instrument']} · {m['verified_on']}", "",
         f"Feature set `{m['featureSet']}` · discovery {m['windows']['discovery'][0]} … {m['windows']['discovery'][1]} · "
         f"blind {m['windows']['blind'][0]} … {m['windows']['blind'][1]} · cost {m['cost_bp']} bp/trade · "
         f"runtime {m['runtime_s']:.0f} s", "", "## Verdict", "", verdict, "",
         "## Search counts", "",
         f"- Conditions (bins fitted on discovery only): {c['conditions']}",
         f"- Condition sets searched: singles {c['searched_sets']['singles']}, pairs {c['searched_sets']['pairs']}, "
         f"triples {c['searched_sets']['triples']} (extensions of the top {c['top_pairs']} discovery pairs"
         + (f", capped at {c['max_triples']} per search — cap HIT" if c["triples_capped"] else "") + ")",
         f"- Condition sets with >= {PB.MIN_N_DISC} discovery setups (evaluated): singles {c['evaluated_sets']['singles']}, "
         f"pairs {c['evaluated_sets']['pairs']}, triples {c['evaluated_sets']['triples']}",
         f"- Candidates searched (sets x 2 sides x 4 barriers): {c['candidates_searched']:,}; evaluated: {c['candidates_evaluated']:,}",
         f"- Discovery survivors (t >= {PB.MIN_T_DISC}, n >= {PB.MIN_N_DISC}): {c['discovery_survivors']:,}",
         f"- Blind survivors (all checks): {c['blind_survivors']:,}",
         f"- Rows {c['rows']:,} (discovery {c['discovery_rows']:,} over {c['discovery_days']} days; blind "
         f"{c['blind_rows']:,} over {c['blind_days']} days)", "",
         "## Shuffled null (whole days permuted within each window, identical search)", "",
         f"- Permutations: {nl['permutations']} (seed {nl['seed']})",
         f"- Discovery survivors per permutation: {nl['discovery_survivors_per_perm']}",
         f"- Blind survivors per permutation: {nl['survivors_per_perm']}",
         f"- Null 95th percentile: {nl['p95']:.1f} · real: {c['blind_survivors']} · significant: **{sig}**", ""]
    if n_rules:
        from collections import Counter
        sides = Counter(r["side"] for r in lib["rules"])
        feats = Counter(cd["feature"] for r in lib["rules"] for cd in r["conditions"])
        L += ["## Concentration (rules overlap heavily; they are not independent findings)", "",
              f"- By side: {dict(sides)}",
              f"- Most-used features: {', '.join(f'{f} ({n})' for f, n in feats.most_common(8))}",
              "- The day-shuffle null breaks serial (regime) dependence, so a library dominated by day-level "
              "features can partly reflect regime persistence rather than a tradable intraday pattern; "
              "forward-test before serving.", ""]
        L += [f"## Rules (top 25 of {n_rules} by blind t)", "",
              "| id | rule | side | stop/target ATR | disc n | disc hit | disc net bp | disc t | blind n | blind hit | blind net bp | blind t |",
              "|---|---|---|---|---|---|---|---|---|---|---|---|"]
        for r in lib["rules"][:25]:
            d, b = r["discovery"], r["blind"]
            L.append(f"| {r['id']} | {r['label']} | {r['side']} | {r['stop_atr']}/{r['target_atr']} | {d['n']} | "
                     f"{d['hit']:.3f} | {d['mean_net']:.2f} | {d['t']:.2f} | {b['n']} | {b['hit']:.3f} | "
                     f"{b['mean_net']:.2f} | {b['t']:.2f} |")
        L.append("")
    L += ["## Method", "",
          "Outcomes are trades from the decision-bar close on NIFTY 1m bars: long and short, stop/target in prior-day "
          "ATR14 units (0.25/0.25, 0.25/0.5, 0.5/0.5, 0.5/1.0), first touch wins, same-bar double touch = stop, no "
          "touch = exit at the session's last close. One setup per day (first trigger per rule per session). "
          "Verification: discovery t >= 3 and >= 40 setups; blind mean net > 0, >= 30 setups, blind hit rate inside the "
          "discovery 95 % CI; library significant only if real blind survivors exceed the null's 95th percentile.", ""]
    return "\n".join(L)


def mine_b(args) -> int:
    root = Path(args.store) if args.store else default_root()
    inst = args.instrument.upper()
    t0 = time.time()
    ds = pd.read_parquet(root / "models" / "m1" / inst.lower() / "dataset.parquet").sort_index()
    if "month" in ds.columns:
        ds = ds.drop(columns=["month"])
    cols = A.model_columns(ds)
    bars = read_bars(root, inst, "1m")
    if bars.empty:
        print(f"no 1m bars for {inst} in {root}", file=sys.stderr)
        return 2
    net, hit = PB.decision_outcomes(ds, bars, args.cost_bp)
    print(f"outcomes: {np.isfinite(net).sum(1).tolist()} valid per combo ({time.time() - t0:.0f}s)", flush=True)
    del bars
    res = PB.mine(ds[cols], ds["date"], ds["mod"].to_numpy(), net, hit, n_perms=args.perms, seed=args.seed,
                  top_pairs=args.top_pairs, max_triples=args.max_triples,
                  log=lambda s: print(s, flush=True))
    runtime = time.time() - t0
    today = args.date or date.today().isoformat()
    newest = pd.Timestamp(ds["date"].max()).date().isoformat()
    for r in res.library:
        r["verified_on"] = today
        r["significant"] = res.null["significant"]
    lib = {"meta": {
        "kind": "mbm-patterns", "instrument": inst, "featureSet": FEATURE_SET, "verified_on": today,
        "windows": {"discovery": [str(PB.DISCOVERY[0].date()), str(PB.DISCOVERY[1].date())],
                    "blind": [str(PB.BLIND_START.date()), newest]},
        "cost_bp": args.cost_bp, "barriers": [list(b) for b in PB.BARRIERS], "sides": list(PB.SIDES),
        "thresholds": {"min_t_disc": PB.MIN_T_DISC, "min_n_disc": PB.MIN_N_DISC, "min_n_blind": PB.MIN_N_BLIND,
                       "hit_ci_z": PB.CI_Z},
        "search": res.counts, "null": res.null, "significant": res.null["significant"],
        "runtime_s": round(runtime, 1), "timings": res.timings, "bin_edges": res.edges},
        "rules": res.library}
    out = root / "models" / "m4" / inst.lower()
    out.mkdir(parents=True, exist_ok=True)
    (root / "reports").mkdir(parents=True, exist_ok=True)
    jp = out / f"library-{today}.json"
    jp.write_text(json.dumps(lib, indent=1), encoding="utf-8")
    rp = root / "reports" / f"m4-{inst.lower()}-{today}.md"
    rp.write_text(render_patterns_report(lib), encoding="utf-8")
    c = res.counts
    print(f"library: {jp}\nreport: {rp}\nsearched {c['candidates_searched']:,} · disc survivors "
          f"{c['discovery_survivors']} · blind survivors {c['blind_survivors']} · null {res.null['survivors_per_perm']} "
          f"p95 {res.null['p95']:.1f} · significant {res.null['significant']} · {runtime:.0f}s")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    t = sub.add_parser("train-a", help="walk-forward train + gate + report for Model A")
    t.add_argument("--instrument", default="NIFTY")
    t.add_argument("--store", default=None)
    t.add_argument("--horizons", default=None, help="comma list, default 30m,60m,rest,next")
    t.add_argument("--ablation-months", type=int, default=12)
    t.add_argument("--no-ablation", action="store_true")
    t.add_argument("--rebuild", action="store_true", help="recompute the cached feature dataset")
    r = sub.add_parser("report", help="rebuild metrics + report from saved blind predictions")
    r.add_argument("--instrument", default="NIFTY")
    r.add_argument("--store", default=None)
    r.add_argument("--runtime", type=int, default=None, help="walk-forward runtime to record (s)")
    r.add_argument("--note", default=None)
    f = sub.add_parser("predict-a", help="forward test: score one session with the saved models")
    f.add_argument("--instrument", default="NIFTY")
    f.add_argument("--store", default=None)
    f.add_argument("--date", required=True, help="IST session date, YYYY-MM-DD")
    f.add_argument("--horizons", default=None, help="comma list, default 30m,60m (the horizons near the gate)")
    m = sub.add_parser("mine-b", help="Model B: discover + verify the pattern library (with shuffled null)")
    m.add_argument("--instrument", default="NIFTY")
    m.add_argument("--store", default=None)
    m.add_argument("--cost-bp", type=float, default=3.0, help="round-trip cost per trade in bp (futures-like 3)")
    m.add_argument("--perms", type=int, default=5, help="shuffled-null permutations (>= 5)")
    m.add_argument("--seed", type=int, default=7)
    m.add_argument("--top-pairs", type=int, default=200, help="discovery pairs extended to triples")
    m.add_argument("--max-triples", type=int, default=None, help="cap on triples searched per run (per null too)")
    m.add_argument("--date", default=None, help="artefact date stamp, default today")
    args = ap.parse_args(argv)
    if args.cmd == "train-a":
        return train_a(args)
    if args.cmd == "report":
        return report_only(args)
    if args.cmd == "predict-a":
        return predict_a(args)
    if args.cmd == "mine-b":
        return mine_b(args)
    return 2


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(main())
