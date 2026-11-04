"""Noise-vs-real spike: base rates, feature lift, model, holdout AUC/calibration and exit-policy P&L.
Throwaway research code. Reads data/adv_*.parquet, data/spk_*.parquet written by build.py.
Train: dates < 2025-01-01 (NIFTY + BANKNIFTY pooled). Holdout: 2025-01-01 .. 2026-11-04.
All CIs: day-cluster bootstrap (resample trading days), 1000 draws, 95 %.
"""
import os, sys, json
import numpy as np, pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier, HistGradientBoostingRegressor
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import make_pipeline
from sklearn.impute import SimpleImputer

HERE = os.path.dirname(os.path.abspath(__file__))
D = os.path.join(HERE, "data")
OUT = os.path.join(HERE, "results")
os.makedirs(OUT, exist_ok=True)
SPLIT = pd.Timestamp("2025-01-01")
RNG = np.random.default_rng(7)
M = 1.5
GRID = r"C:\Users\AryanKumar\grw-mbm\research\oi-pattern\data\grid.parquet"
LOG = []


def out(*a):
    s = " ".join(str(x) for x in a)
    print(s, flush=True)
    LOG.append(s)


ADV_F = ["moveN", "speed_min", "held_min", "pnl_at_event", "best_gainN", "N_ratio", "N_atr", "tod", "twapN", "openN",
         "pdhN", "pdlN", "dayrng_atr", "trend_atr", "ret30N", "ret60N", "adv_extN", "fb_day", "fb_pd", "lvl_beyondN",
         "at_new_ext", "gap_atr", "vix_prev", "vix_chg", "dow", "side", "is_bn"]
SPK_F = ["sizeN", "N_ratio", "N_atr", "tod", "twapN", "openN", "pdhN", "pdlN", "dayrng_atr", "trend_atr", "ret30N",
         "ret60N", "at_new_ext", "gap_atr", "vix_prev", "vix_chg", "dow", "side", "is_bn"]
OI_F = ["doi15_z", "s_dp15_z", "doi60_z", "s_net_write_60", "s_pcr_chg60"]


def load(kind):
    fr = []
    for sym in ["NIFTY", "BANKNIFTY", "SENSEX", "CRUDE"]:
        f = os.path.join(D, f"{kind}_{sym}.parquet")
        if os.path.exists(f):
            x = pd.read_parquet(f)
            if len(x):
                fr.append(x)
    x = pd.concat(fr, ignore_index=True)
    x["date"] = pd.to_datetime(x.date)
    x["is_bn"] = (x.sym == "BANKNIFTY").astype(int)
    n0 = len(x)
    # stale/flat data: N = 0 or absurdly small vs the daily ATR -> junk events
    x = x[(x.N > 0) & (x.N_atr >= 0.01) & np.isfinite(x["moveN" if kind == "adv" else "sizeN"])]
    out(f"[{kind}] dropped {n0 - len(x)} of {n0} rows with stale/zero N")
    return x.reset_index(drop=True)


def add_oi(x):
    g = pd.read_parquet(GRID)[["asof", "doi15_z", "dp15_z", "doi60_z", "o_net_write_60", "o_pcr_chg60"]].dropna(subset=["asof"])
    g["asof"] = pd.to_datetime(g["asof"])
    g = g.sort_values("asof")
    x = x.sort_values("t").reset_index(drop=True)
    x["t"] = pd.to_datetime(x.t)
    nif = x.sym == "NIFTY"
    m = pd.merge_asof(x.loc[nif, ["t"]].reset_index(), g, left_on="t", right_on="asof", direction="backward",
                      tolerance=pd.Timedelta(minutes=10)).set_index("index")
    for c in ["doi15_z", "dp15_z", "doi60_z", "o_net_write_60", "o_pcr_chg60"]:
        x[c] = np.nan
        x.loc[m.index, c] = m[c]
    x["s_dp15_z"] = x.side * x.dp15_z
    x["s_net_write_60"] = x.side * x.o_net_write_60
    x["s_pcr_chg60"] = x.side * x.o_pcr_chg60
    return x


def boot_mean(v, dates, n=1000):
    """Day-cluster bootstrap CI of the per-event mean."""
    df = pd.DataFrame({"v": v, "d": dates})
    a = df.groupby("d").v.agg(["sum", "count"])
    s, c = a["sum"].values, a["count"].values
    k = len(s)
    if k < 3:
        return (np.nan, np.nan)
    idx = RNG.integers(0, k, size=(n, k))
    ms = s[idx].sum(1) / c[idx].sum(1)
    return tuple(np.percentile(ms, [2.5, 97.5]))


def boot_auc(y, p, dates, n=300):
    y, p = np.asarray(y), np.asarray(p)
    codes, uniq = pd.factorize(pd.Series(dates))
    order = np.argsort(codes, kind="stable")
    bounds = np.r_[0, np.cumsum(np.bincount(codes))]
    groups = [order[bounds[i]:bounds[i + 1]] for i in range(len(uniq))]
    k = len(groups)
    res = []
    for _ in range(n):
        idx = np.concatenate([groups[i] for i in RNG.integers(0, k, k)])
        if len(np.unique(y[idx])) == 2:
            res.append(roc_auc_score(y[idx], p[idx]))
    return tuple(np.percentile(res, [2.5, 97.5]))


def fmt_ci(m, ci):
    return f"{m:+.3f} [{ci[0]:+.3f}, {ci[1]:+.3f}]"


def models(tr, te, feats, ycol, pcol):
    Xtr, Xte = tr[feats].astype(float), te[feats].astype(float)
    ytr = tr[ycol].values
    gb = HistGradientBoostingClassifier(max_iter=300, learning_rate=0.05, max_leaf_nodes=15, min_samples_leaf=400,
                                        l2_regularization=1.0, random_state=0).fit(Xtr, ytr)
    lr = make_pipeline(SimpleImputer(strategy="median"), StandardScaler(), LogisticRegression(C=0.1, max_iter=2000)).fit(Xtr, ytr)
    rg = HistGradientBoostingRegressor(max_iter=300, learning_rate=0.05, max_leaf_nodes=15, min_samples_leaf=400,
                                       l2_regularization=1.0, random_state=0).fit(Xtr, tr[pcol].values)
    return gb, lr, rg


def policy_eval(tr, te, gb, rg, feats, pcol, tag):
    """Hold/exit decision at the event. Marginal P&L vs exiting now (exit-always = 0)."""
    ptr = gb.predict_proba(tr[feats].astype(float))[:, 1]
    pte = gb.predict_proba(te[feats].astype(float))[:, 1]
    # threshold picked on TRAIN only: maximise train mean marginal P&L
    thr_grid = np.quantile(ptr, np.linspace(0.05, 0.95, 19))
    best_thr = max(thr_grid, key=lambda th: np.mean(np.where(ptr > th, tr[pcol].values, 0)))
    rte = rg.predict(te[feats].astype(float))
    res = {}
    for name, held in [("hold_always", np.ones(len(te), bool)),
                       ("clf_p>thr", pte > best_thr),
                       ("reg_E>0", rte > 0)]:
        v = np.where(held, te[pcol].values, 0.0)
        res[name] = (v, held.mean())
    hold_all = res["hold_always"][0]
    best_fixed = hold_all if hold_all.mean() > 0 else np.zeros(len(te))
    best_fixed_name = "hold_always" if hold_all.mean() > 0 else "exit_always"
    out(f"  [{tag}] thr(train)={best_thr:.3f}  best fixed = {best_fixed_name}")
    rows = []
    for name, (v, frac) in res.items():
        ci = boot_mean(v, te.date.values)
        dv = v - best_fixed
        dci = boot_mean(dv, te.date.values)
        out(f"  [{tag}] {name:12s} held {frac:5.1%}  mean marginal {fmt_ci(v.mean(), ci)} N/event   vs best fixed {fmt_ci(dv.mean(), dci)}")
        rows.append(dict(tag=tag, policy=name, held=frac, mean=v.mean(), lo=ci[0], hi=ci[1], d_vs_fixed=dv.mean(), d_lo=dci[0], d_hi=dci[1], n=len(v)))
    return rows, pte


def feature_lift(tr, te, feats, ycol, tag):
    rows = []
    for f in feats:
        a, b = tr[[f, ycol]].dropna(), te[[f, ycol]].dropna()
        if a[f].nunique() < 2 or len(b) < 200 or b[ycol].nunique() < 2:
            continue
        atr = roc_auc_score(a[ycol], a[f])
        sgn = 1 if atr >= 0.5 else -1
        ate = roc_auc_score(b[ycol], sgn * b[f])
        rows.append(dict(feature=f, auc_train=max(atr, 1 - atr), auc_test=ate, sign=sgn))
    r = pd.DataFrame(rows).sort_values("auc_test", ascending=False)
    out(f"  [{tag}] per-feature AUC (direction fixed on train), top 12:")
    for _, z in r.head(12).iterrows():
        out(f"     {z.feature:14s} train {z.auc_train:.3f}  test {z.auc_test:.3f}  ({'+' if z.sign > 0 else '-'})")
    return r


def calib(y, p, tag):
    q = pd.qcut(p, 10, duplicates="drop")
    t = pd.DataFrame({"y": y, "p": p, "q": q}).groupby("q", observed=True).agg(pred=("p", "mean"), obs=("y", "mean"), n=("y", "size"))
    out(f"  [{tag}] calibration deciles (pred -> obs): " + "  ".join(f"{a:.2f}->{b:.2f}" for a, b in zip(t.pred, t.obs)))


def adverse(H=30):
    x = add_oi(load("adv"))
    lab, pcol = f"lab{H}", f"holdnet{H}"
    x["y"] = (x[lab] == "NOISE").astype(int)
    x["p_null"] = M / (x.moveN + M)  # gambler's-ruin chance of touching best before m N further
    out(f"\n==================== ADVERSE EXCURSIONS, horizon {H} min, REAL = {M} N further ====================")
    out(f"events: " + ", ".join(f"{s} {len(g)} ({g.date.nunique()} days, {g.date.min().date()}..{g.date.max().date()})" for s, g in x.groupby("sym")))
    summary = []
    for (sym, k), g in x.groupby(["sym", "k"]):
        for part, gg in [("train", g[g.date < SPLIT]), ("test", g[g.date >= SPLIT])]:
            if len(gg) < 30:
                continue
            vc = gg[lab].value_counts(normalize=True)
            res = gg[gg[lab] != "TIMEOUT"]
            ci = boot_mean(gg[pcol].values, gg.date.values)
            cig = boot_mean(gg[f"hold{H}"].values, gg.date.values)
            summary.append(dict(sym=sym, k=k, part=part, n=len(gg), days=gg.date.nunique(), noise=vc.get("NOISE", 0), real=vc.get("REAL", 0),
                                timeout=vc.get("TIMEOUT", 0), noise_resolved=(res[lab] == "NOISE").mean() if len(res) else np.nan,
                                null_resolved=res.p_null.mean() if len(res) else np.nan,
                                hold_gross=gg[f"hold{H}"].mean(), hold_gross_lo=cig[0], hold_gross_hi=cig[1],
                                hold_net=gg[pcol].mean(), hold_net_lo=ci[0], hold_net_hi=ci[1], fwd=gg[f"fwd{H}"].mean()))
    sm = pd.DataFrame(summary)
    out("base rates (NOISE/REAL/TIMEOUT share; among resolved: observed NOISE vs random-walk null m/(move+m)); hold-always marginal P&L in N (gross, net of theta) with day-bootstrap CI")
    for _, r in sm.iterrows():
        out(f"  {r.sym:9s} k={r.k} {r.part:5s} n={r.n:6d} d={r.days:4d}  N/R/T {r.noise:.2f}/{r.real:.2f}/{r.timeout:.2f}  "
            f"resolved NOISE {r.noise_resolved:.3f} vs null {r.null_resolved:.3f}  hold gross {r.hold_gross:+.3f} [{r.hold_gross_lo:+.3f},{r.hold_gross_hi:+.3f}]  "
            f"net {r.hold_net:+.3f} [{r.hold_net_lo:+.3f},{r.hold_net_hi:+.3f}]  fwd{H} {r.fwd:+.3f}")
    sm.to_csv(os.path.join(OUT, f"adverse_base_rates_H{H}.csv"), index=False)

    core = x[x.sym.isin(["NIFTY", "BANKNIFTY"])]
    tr, te = core[core.date < SPLIT], core[core.date >= SPLIT]
    out(f"\nmodel: train {len(tr)} events ({tr.date.nunique()} days)  test {len(te)} events ({te.date.nunique()} days)")
    feats = ADV_F + ["k"]
    fl = feature_lift(tr, te, feats + ["p_null"], "y", f"adv H{H}")
    fl.to_csv(os.path.join(OUT, f"adverse_feature_auc_H{H}.csv"), index=False)
    gb, lr, rg = models(tr, te, feats, "y", pcol)
    pg = gb.predict_proba(te[feats].astype(float))[:, 1]
    pl = lr.predict_proba(te[feats].astype(float))[:, 1]
    for nm, p in [("GBM", pg), ("logistic", pl), ("null m/(move+m)", te.p_null.values)]:
        ci = boot_auc(te.y.values, p, te.date.values)
        out(f"  holdout AUC (NOISE) {nm:16s} {roc_auc_score(te.y, p):.3f}  CI [{ci[0]:.3f}, {ci[1]:.3f}]")
    # AUC within each k (removes the trivial k effect) and vs P&L rank
    for k, g in te.assign(pg=pg).groupby("k"):
        out(f"    k={k}: AUC GBM {roc_auc_score(g.y, g.pg):.3f}  null {roc_auc_score(g.y, g.p_null):.3f}  n={len(g)}")
    out(f"  spearman(pred P(NOISE), realised hold P&L) holdout = {pd.Series(pg).corr(pd.Series(te[pcol].values), method='spearman'):+.3f}")
    calib(te.y.values, pg, f"adv H{H} GBM")
    pol_rows = []
    for sym in ["NIFTY", "BANKNIFTY"]:
        for k in sorted(core.k.unique()):
            a = tr[(tr.k == k)]
            b = te[(te.sym == sym) & (te.k == k)]
            r, _ = policy_eval(a, b, gb, rg, feats, pcol, f"{sym} k={k} H{H}")
            pol_rows += [dict(z, sym=sym, k=k, H=H) for z in r]
    r, _ = policy_eval(tr, te, gb, rg, feats, pcol, f"POOLED H{H}")
    pol_rows += [dict(z, sym="POOLED", k="all", H=H) for z in r]
    # walk-forward AUC by year
    wf = []
    for yr in range(2020, 2027):
        a = core[core.date < pd.Timestamp(f"{yr}-01-01")]
        b = core[(core.date >= pd.Timestamp(f"{yr}-01-01")) & (core.date < pd.Timestamp(f"{yr + 1}-01-01"))]
        if len(b) < 500:
            continue
        m = HistGradientBoostingClassifier(max_iter=300, learning_rate=0.05, max_leaf_nodes=15, min_samples_leaf=400,
                                           l2_regularization=1.0, random_state=0).fit(a[feats].astype(float), a.y)
        p = m.predict_proba(b[feats].astype(float))[:, 1]
        wf.append(f"{yr}: {roc_auc_score(b.y, p):.3f} (null {roc_auc_score(b.y, b.p_null):.3f})")
    out("  walk-forward AUC by test year (expanding train): " + "  ".join(wf))
    # does adding OI help? NIFTY rows with OI only, time split inside the OI window
    oi = core[(core.sym == "NIFTY") & core.doi15_z.notna()]
    if len(oi) > 2000:
        cut = oi.date.quantile(0.6)
        a, b = oi[oi.date < cut], oi[oi.date >= cut]
        out(f"\n  OI subset NIFTY {oi.date.min().date()}..{oi.date.max().date()}: train {len(a)} test {len(b)} (split {cut.date()})")
        for nm, fs in [("base feats", feats), ("base + OI", feats + OI_F), ("OI only + moveN,k", OI_F + ["moveN", "k"])]:
            m = HistGradientBoostingClassifier(max_iter=200, learning_rate=0.05, max_leaf_nodes=15, min_samples_leaf=200,
                                               l2_regularization=1.0, random_state=0).fit(a[fs].astype(float), a.y)
            p = m.predict_proba(b[fs].astype(float))[:, 1]
            ci = boot_auc(b.y.values, p, b.date.values, n=200)
            out(f"    {nm:20s} AUC {roc_auc_score(b.y, p):.3f} [{ci[0]:.3f},{ci[1]:.3f}]")
        feature_lift(a, b, OI_F, "y", "OI subset")
    # failed-break context alone
    out("\n  FAILED-BREAK context (adverse leg crossed PDH/PDL [fb_pd] or the day's prior extreme [fb_day]) -- hold-always P&L net, NOISE rate, holdout + full")
    fb_rows = []
    for part, g in [("full", core), ("test", te)]:
        for col in ["fb_pd", "fb_day"]:
            for k in sorted(core.k.unique()):
                for val in [1, 0]:
                    gg = g[(g[col] == val) & (g.k == k)]
                    if len(gg) < 50:
                        continue
                    ci = boot_mean(gg[pcol].values, gg.date.values)
                    out(f"    {part:4s} {col:6s}={val} k={k}: n={len(gg):6d} NOISE {gg.y.mean():.3f} (null {gg.p_null.mean():.3f})  hold net {fmt_ci(gg[pcol].mean(), ci)}")
                    fb_rows.append(dict(part=part, ctx=col, val=val, k=k, n=len(gg), noise=gg.y.mean(), null=gg.p_null.mean(), hold=gg[pcol].mean(), lo=ci[0], hi=ci[1]))
    pd.DataFrame(fb_rows).to_csv(os.path.join(OUT, f"failed_break_H{H}.csv"), index=False)
    # time-of-day + vol regime: does hold-always P&L depend on them (simple, robust rules)?
    out("\n  hold-always net P&L by time-of-day bucket and N_ratio tercile (holdout)")
    te2 = te.assign(todb=pd.cut(te.tod, [0, 60, 120, 240, 300, 400], labels=["09:15-10:15", "10:15-11:15", "11:15-13:15", "13:15-14:15", "14:15+"]),
                    nr=pd.qcut(te.N_ratio, 3, labels=["N calm", "N mid", "N expanding"]))
    for col in ["todb", "nr"]:
        for v, gg in te2.groupby(col, observed=True):
            ci = boot_mean(gg[pcol].values, gg.date.values)
            out(f"    {str(v):12s} n={len(gg):6d} NOISE {gg.y.mean():.3f} hold net {fmt_ci(gg[pcol].mean(), ci)}")
    # out-of-sample sanity on SENSEX / CRUDE
    for sym in ["SENSEX", "CRUDE"]:
        g = x[x.sym == sym]
        if len(g) < 50:
            continue
        p = gb.predict_proba(g[feats].astype(float))[:, 1]
        ci = boot_mean(g[pcol].values, g.date.values)
        auc = roc_auc_score(g.y, p) if g.y.nunique() == 2 else np.nan
        out(f"  {sym} (prod, {g.date.nunique()} days, n={len(g)}): NOISE {g.y.mean():.3f}  null {g.p_null.mean():.3f}  hold net {fmt_ci(g[pcol].mean(), ci)}  model AUC {auc:.3f}  (sessions/tod differ for CRUDE)")
    # today's examples
    td = x[(x.sym == "NIFTY") & (x.date == pd.Timestamp("2026-11-04"))]
    if len(td):
        td = td.assign(p=gb.predict_proba(td[feats].astype(float))[:, 1])
        out("\n  NIFTY 2026-11-04 short-side events (hypothetical shorts = long puts) entered 11:00-12:30:")
        sel = td[(td.side == -1) & (td.entry_min.between(105, 195))]
        for _, r in sel.sort_values(["entry_min", "k"]).iterrows():
            out(f"    entry +{r.entry_min}m  k={r.k} at {pd.Timestamp(r.t).strftime('%H:%M')} move {r.moveN:.2f}N fb_pd={r.fb_pd} fb_day={r.fb_day} "
                f"P(NOISE)={r.p:.2f}  outcome {r[lab]} hold net {r[pcol]:+.2f}N")
    pd.DataFrame(pol_rows).to_csv(os.path.join(OUT, f"adverse_policy_H{H}.csv"), index=False)
    return gb, feats


def spikes():
    x = load("spk")
    x["y"] = (x.lab == "SNAP").astype(int)
    out("\n==================== FAVOURABLE SPIKES (>= 2.5 N in <= 3 min; SNAP = 50 % retrace within 10 min) ====================")
    for (sym, part), g in x.assign(part=np.where(x.date < SPLIT, "train", "test")).groupby(["sym", "part"]):
        ci = boot_mean(g.holdnet.values, g.date.values)
        out(f"  {sym:9s} {part:5s} n={len(g):6d} SNAP {g.y.mean():.3f}  hold-10m net (vs bank now) {fmt_ci(g.holdnet.mean(), ci)}  gross {g.hold.mean():+.3f}  fwd10 {g.fwd10.mean():+.3f}")
    core = x[x.sym.isin(["NIFTY", "BANKNIFTY"])]
    tr, te = core[core.date < SPLIT], core[core.date >= SPLIT]
    fl = feature_lift(tr, te, SPK_F, "y", "spike")
    fl.to_csv(os.path.join(OUT, "spike_feature_auc.csv"), index=False)
    gb, lr, rg = models(tr, te, SPK_F, "y", "holdnet")
    p = gb.predict_proba(te[SPK_F].astype(float))[:, 1]
    ci = boot_auc(te.y.values, p, te.date.values)
    out(f"  holdout AUC (SNAP) GBM {roc_auc_score(te.y, p):.3f} [{ci[0]:.3f},{ci[1]:.3f}]  logistic {roc_auc_score(te.y, lr.predict_proba(te[SPK_F].astype(float))[:, 1]):.3f}")
    calib(te.y.values, p, "spike GBM")
    rows = []
    # here the classifier output is P(SNAP): hold when P(SNAP) is LOW -> flip the target for policy_eval
    tr2, te2 = tr.assign(y=1 - tr.y), te.assign(y=1 - te.y)
    gb2, _, rg2 = models(tr2, te2, SPK_F, "y", "holdnet")
    for sym in ["NIFTY", "BANKNIFTY"]:
        r, _ = policy_eval(tr2, te2[te2.sym == sym], gb2, rg2, SPK_F, "holdnet", f"spike {sym}")
        rows += [dict(z, sym=sym) for z in r]
    pd.DataFrame(rows).to_csv(os.path.join(OUT, "spike_policy.csv"), index=False)


if __name__ == "__main__":
    which = sys.argv[1:] or ["adv30", "adv15", "spk"]
    if "adv30" in which:
        adverse(30)
    if "adv15" in which:
        adverse(15)
    if "spk" in which:
        spikes()
    with open(os.path.join(OUT, "report_" + "_".join(which) + ".txt"), "w", encoding="utf8") as f:
        f.write("\n".join(LOG))
