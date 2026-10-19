"""MBM Model B — Pattern Library discovery engine (design §5.4, M4 contract stream A).

Candidate rules are conjunctions of binned conditions over the fs2 feature columns of the cached
decision-row dataset. Bins are quintile edges fitted on the DISCOVERY window only. Outcomes are
trades from the decision bar close using the NIFTY 1m bars after it: long/short, stop/target barriers
in prior-day ATR14 units, first touch wins, a same-bar double touch is a stop, no touch = exit at the
session's last close. One setup per day: the first trigger of a rule in each session.

Everything outcome-related is precomputed once as a [combo, row] matrix (combo = side x barrier, and
for the shuffled null also x permutation), so a rule is a boolean row mask -> first-True-per-day row
indices -> a column gather. The shuffled null permutes whole days within each window (a row keeps its
intraday slot and takes the outcome of the same slot on another day), then reruns the identical search.
"""
from __future__ import annotations

import itertools
import time
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from .features import IST, SESSION_END_MIN, SESSION_OPEN_MIN, _annotate, daily_context, to_5m

SIDES = ("long", "short")
BARRIERS = ((0.25, 0.25), (0.25, 0.5), (0.5, 0.5), (0.5, 1.0))  # (stop_atr, target_atr)
COMBOS = tuple((s, st, tg) for s in SIDES for st, tg in BARRIERS)
DISCOVERY = (pd.Timestamp("2016-10-03"), pd.Timestamp("2022-12-31"))
BLIND_START = pd.Timestamp("2023-01-01")
N_BINS = 5
SESSION_MINUTES = SESSION_END_MIN - SESSION_OPEN_MIN  # 375 one-minute bars, 09:15..15:29 starts

# Verification thresholds (contract).
MIN_T_DISC = 3.0
MIN_N_DISC = 40
MIN_N_BLIND = 30
CI_Z = 1.96


# ---------------------------------------------------------------- outcomes

def session_matrices(bars_1m: pd.DataFrame) -> tuple[pd.DatetimeIndex, np.ndarray, np.ndarray, np.ndarray]:
    """1m bars (`ts` = bar START, UTC) -> (session dates, high, low, close) as [day, minute] arrays.

    Column j is the bar starting j minutes after 09:15 IST; missing bars are NaN."""
    d = bars_1m[["ts", "high", "low", "close"]].copy()
    local = pd.DatetimeIndex(d["ts"]).tz_convert(IST)
    col = (local.hour * 60 + local.minute - SESSION_OPEN_MIN).to_numpy()
    keep = (col >= 0) & (col < SESSION_MINUTES)
    d, col, local = d[keep], col[keep], local[keep]
    dates = local.normalize().tz_localize(None)
    days = pd.DatetimeIndex(np.unique(dates.to_numpy()))
    di = days.get_indexer(dates)
    shape = (len(days), SESSION_MINUTES)
    hi, lo, cl = (np.full(shape, np.nan) for _ in range(3))
    hi[di, col] = d["high"].to_numpy(float)
    lo[di, col] = d["low"].to_numpy(float)
    cl[di, col] = d["close"].to_numpy(float)
    return days, hi, lo, cl


def _last_close(cl: np.ndarray) -> np.ndarray:
    """Last non-NaN close of each session row."""
    ok = ~np.isnan(cl)
    last = np.where(ok.any(1), SESSION_MINUTES - 1 - ok[:, ::-1].argmax(1), 0)
    return cl[np.arange(len(cl)), last]


def trade_outcomes(entry: np.ndarray, day_idx: np.ndarray, start_col: np.ndarray, atr: np.ndarray,
                   hi: np.ndarray, lo: np.ndarray, cl: np.ndarray, cost_bp: float,
                   combos=COMBOS, chunk: int = 4000) -> tuple[np.ndarray, np.ndarray]:
    """Net bp and hit (target reached = 1) per combo x decision row. NaN where not computable.

    The trade window is bars starting at `start_col` .. session end of day `day_idx`."""
    n = len(entry)
    net = np.full((len(combos), n), np.nan)
    hit = np.full((len(combos), n), np.nan)
    last = _last_close(cl)
    j = np.arange(SESSION_MINUTES)
    big = SESSION_MINUTES + 1
    for a in range(0, n, chunk):
        sl = slice(a, min(n, a + chunk))
        e, dix, sc, at = entry[sl], day_idx[sl], start_col[sl], atr[sl]
        ok = (dix >= 0) & np.isfinite(at) & (at > 0) & np.isfinite(e) & (sc >= 0) & (sc < SESSION_MINUTES)
        cols = sc[:, None] + j[None, :]
        inwin = cols < SESSION_MINUTES
        cc = np.clip(cols, 0, SESSION_MINUTES - 1)
        dd = np.clip(dix, 0, None)[:, None]
        H = np.where(inwin, hi[dd, cc], np.nan)
        Lw = np.where(inwin, lo[dd, cc], np.nan)
        lc = last[np.clip(dix, 0, None)]
        ok &= np.isfinite(lc)
        for k, (side, st, tg) in enumerate(combos):
            if side == "long":
                t_hit = H >= (e + tg * at)[:, None]
                s_hit = Lw <= (e - st * at)[:, None]
                end_g = lc - e
            else:
                t_hit = Lw <= (e - tg * at)[:, None]
                s_hit = H >= (e + st * at)[:, None]
                end_g = e - lc
            ft = np.where(t_hit.any(1), t_hit.argmax(1), big)
            fs = np.where(s_hit.any(1), s_hit.argmax(1), big)
            stop = (fs < big) & (fs <= ft)          # same-bar double touch = stop
            targ = (ft < big) & ~stop
            gross = np.where(stop, -st * at, np.where(targ, tg * at, end_g))
            nb = gross / e * 1e4 - cost_bp
            net[k, sl] = np.where(ok, nb, np.nan)
            hit[k, sl] = np.where(ok, targ.astype(float), np.nan)
    return net, hit


def decision_outcomes(ds: pd.DataFrame, bars_1m: pd.DataFrame, cost_bp: float) -> tuple[np.ndarray, np.ndarray]:
    """Outcomes for every dataset row (index = decision bar END, UTC; `close` = entry)."""
    days, hi, lo, cl = session_matrices(bars_1m)
    ctx = daily_context(_annotate(to_5m(bars_1m)))
    local = pd.DatetimeIndex(ds.index).tz_convert(IST)
    dates = local.normalize().tz_localize(None)
    day_idx = days.get_indexer(dates)
    start_col = (local.hour * 60 + local.minute - SESSION_OPEN_MIN).to_numpy()
    atr = ctx["atr14"].reindex(dates).to_numpy(float)
    return trade_outcomes(ds["close"].to_numpy(float), day_idx, start_col, atr, hi, lo, cl, cost_bp)


# ---------------------------------------------------------------- bins + conditions

def fit_edges(x_disc: np.ndarray, n_bins: int = N_BINS) -> np.ndarray:
    """Interior quintile cut points from discovery values only (unique, NaN-free)."""
    v = x_disc[np.isfinite(x_disc)]
    if len(v) == 0:
        return np.array([])
    q = np.quantile(v, np.linspace(0, 1, n_bins + 1)[1:-1])
    q = np.unique(q)
    return q[(q > v.min())]  # an edge at the minimum would leave bin 0 empty


def apply_bins(x: np.ndarray, edges: np.ndarray) -> np.ndarray:
    """bin = number of edges <= x; NaN -> -1."""
    b = np.searchsorted(edges, x, side="right").astype(np.int16)
    b[~np.isfinite(x)] = -1
    return b


@dataclass
class Condition:
    feature: str
    kind: str          # "eq" | "le" | "ge" (on bins)
    k: int
    lo: float | None   # numeric form: lo <= x < hi
    hi: float | None

    def to_json(self) -> dict:
        if self.lo is None:
            return {"feature": self.feature, "op": "lt", "value": self.hi, "bin": f"<= {self.k}" if self.kind != "eq" else f"== {self.k}"}
        if self.hi is None:
            return {"feature": self.feature, "op": "ge", "value": self.lo, "bin": f">= {self.k}" if self.kind != "eq" else f"== {self.k}"}
        return {"feature": self.feature, "op": "between", "value": [self.lo, self.hi], "bin": f"== {self.k}"}

    def label(self) -> str:
        if self.lo is None:
            return f"{self.feature} < {self.hi:.4g}"
        if self.hi is None:
            return f"{self.feature} >= {self.lo:.4g}"
        return f"{self.lo:.4g} <= {self.feature} < {self.hi:.4g}"


def build_conditions(X: pd.DataFrame, disc: np.ndarray) -> tuple[list[Condition], np.ndarray, dict]:
    """Conditions (bin == k, bin <= 1, bin >= 3) with masks [cond, row]. Edges from `disc` rows only."""
    conds, masks, edges_all = [], [], {}
    for f in X.columns:
        x = X[f].to_numpy(float)
        edges = fit_edges(x[disc])
        edges_all[f] = edges.tolist()
        nb = len(edges) + 1
        if nb < 2:
            continue
        b = apply_bins(x, edges)
        e = [None] + edges.tolist() + [None]
        for k in range(nb):
            conds.append(Condition(f, "eq", k, e[k], e[k + 1]))
            masks.append(b == k)
        if nb >= 4:  # bin <= 1 differs from every single bin
            conds.append(Condition(f, "le", 1, None, e[2]))
            masks.append((b >= 0) & (b <= 1))
        if nb >= 5:
            conds.append(Condition(f, "ge", 3, e[3], None))
            masks.append(b >= 3)
    return conds, np.array(masks, dtype=bool), edges_all


# ---------------------------------------------------------------- selection + stats

def first_per_day(mask: np.ndarray, day_id: np.ndarray) -> np.ndarray:
    """Row indices of the first True per session (rows sorted by time)."""
    idx = np.flatnonzero(mask)
    if len(idx) == 0:
        return idx
    d = day_id[idx]
    keep = np.empty(len(idx), dtype=bool)
    keep[0] = True
    keep[1:] = d[1:] != d[:-1]
    return idx[keep]


def window_stats(net: np.ndarray, hit: np.ndarray, idx: np.ndarray):
    """Per combo row: n, mean net bp, t-stat, hit rate over the selected columns."""
    if len(idx) == 0:
        z = np.zeros(net.shape[0])
        return z, z.copy(), z.copy(), z.copy()
    A, Hh = net[:, idx], hit[:, idx]
    v = np.isfinite(A)
    n = v.sum(1)
    A0 = np.where(v, A, 0.0)
    s, s2 = A0.sum(1), (A0 * A0).sum(1)
    with np.errstate(invalid="ignore", divide="ignore"):
        mean = s / n
        var = (s2 - n * mean * mean) / (n - 1)
        t = mean / np.sqrt(var / n)
        hr = np.where(v, Hh, 0.0).sum(1) / n
    t = np.where((n > 1) & (var > 0), t, 0.0)
    return n, np.nan_to_num(mean), t, np.nan_to_num(hr)


def passes(dn, dm, dt, dh, bn, bm, bh) -> np.ndarray:
    """All contract verification checks except the null (vectorised over combos)."""
    with np.errstate(invalid="ignore", divide="ignore"):
        half = CI_Z * np.sqrt(dh * (1 - dh) / np.maximum(dn, 1))
    return ((dt >= MIN_T_DISC) & (dn >= MIN_N_DISC) & (bm > 0) & (bn >= MIN_N_BLIND)
            & (bh >= dh - half) & (bh <= dh + half))


def disc_pass(dn, dt) -> np.ndarray:
    return (dt >= MIN_T_DISC) & (dn >= MIN_N_DISC)


# ---------------------------------------------------------------- shuffled null

def day_permutation_index(day_id: np.ndarray, slot: np.ndarray, window: np.ndarray, rng) -> np.ndarray:
    """Row -> source row under a day shuffle within each window (-1 = no such slot on the source day).

    Rows keep their intraday `slot`; whole days are permuted, so day structure is preserved."""
    n_days = int(day_id.max()) + 1
    slots, slot_i = np.unique(slot, return_inverse=True)
    grid = np.full((n_days, len(slots)), -1, dtype=np.int64)
    grid[day_id, slot_i] = np.arange(len(day_id))
    perm = np.arange(n_days)
    day_win = np.full(n_days, -1)
    day_win[day_id] = window
    for w in np.unique(window):
        ds_ = np.flatnonzero(day_win == w)
        perm[ds_] = rng.permutation(ds_)
    return grid[perm[day_id], slot_i]


def permute_outcomes(arr: np.ndarray, src: np.ndarray) -> np.ndarray:
    out = arr[:, np.clip(src, 0, None)]
    out[:, src < 0] = np.nan
    return out


# ---------------------------------------------------------------- search

@dataclass
class MineResult:
    library: list[dict]
    counts: dict
    null: dict
    timings: dict = field(default_factory=dict)
    edges: dict = field(default_factory=dict)


def mine(X: pd.DataFrame, dates: pd.Series, slot: np.ndarray, net: np.ndarray, hit: np.ndarray,
         n_perms: int = 5, seed: int = 7, top_pairs: int = 200, max_triples: int | None = None,
         log=print) -> MineResult:
    """Run the bounded search on the real outcomes and on `n_perms` day-shuffled nulls."""
    t0 = time.time()
    dates = pd.to_datetime(pd.Series(dates).reset_index(drop=True))
    disc = ((dates >= DISCOVERY[0]) & (dates <= DISCOVERY[1])).to_numpy()
    blind = (dates >= BLIND_START).to_numpy()
    day_id = pd.factorize(dates)[0]
    nd = int(disc.sum())
    if not (disc[:nd].all() and not disc[nd:].any()):
        raise ValueError("rows must be time-sorted with the discovery window first")
    b0 = int(np.argmax(blind)) if blind.any() else len(dates)

    conds, cmask, edges = build_conditions(X, disc)
    feat_of = np.array([c.feature for c in conds])
    n_c = len(conds)
    log(f"conditions: {n_c} over {X.shape[1]} features")

    # Outcome stacks: block p (0 = real, 1..P = null) occupies rows p*K .. p*K+K-1.
    K = net.shape[0]
    rng = np.random.default_rng(seed)
    window = np.where(disc, 0, np.where(blind, 1, 2))
    nets, hits = [net], [hit]
    for _ in range(n_perms):
        src = day_permutation_index(day_id, slot, window, rng)
        nets.append(permute_outcomes(net, src))
        hits.append(permute_outcomes(hit, src))
    NET, HIT = np.vstack(nets), np.vstack(hits)
    P = n_perms + 1
    t_out = time.time()

    surv = np.zeros(P, dtype=np.int64)        # full-verification survivors per block
    dsurv = np.zeros(P, dtype=np.int64)       # discovery-only survivors per block
    real_rules: list[dict] = []
    searched = {"singles": 0, "pairs": 0, "triples": 0}
    evaluated = {"singles": 0, "pairs": 0, "triples": 0}

    def evaluate(cset, mask, rows: slice | None = None):
        """Evaluate one condition set; returns the per-block best discovery t (for ranking)."""
        idx = first_per_day(mask, day_id)
        di, bi = idx[idx < nd], idx[idx >= b0]
        Nn = NET if rows is None else NET[rows]
        Hh = HIT if rows is None else HIT[rows]
        dn, dm, dt, dh = window_stats(Nn, Hh, di)
        bn, bm, _bt, bh = window_stats(Nn, Hh, bi)
        ok = passes(dn, dm, dt, dh, bn, bm, bh)
        dok = disc_pass(dn, dt)
        nb = ok.shape[0] // K
        surv_blocks = ok.reshape(nb, K).sum(1)
        dsurv_blocks = dok.reshape(nb, K).sum(1)
        if rows is None:
            surv[:] += surv_blocks
            dsurv[:] += dsurv_blocks
            real_ok = np.flatnonzero(ok[:K])
        else:
            p = rows.start // K
            surv[p] += surv_blocks[0]
            dsurv[p] += dsurv_blocks[0]
            real_ok = np.flatnonzero(ok[:K]) if p == 0 else []
        for k in real_ok:
            _, _, bt, _ = window_stats(NET[k:k + 1], HIT[k:k + 1], bi)
            side, st, tg = COMBOS[k]
            real_rules.append({
                "conditions": [conds[c] for c in cset], "side": side, "stop_atr": st, "target_atr": tg,
                "discovery": {"n": int(dn[k]), "hit": float(dh[k]), "mean_net": float(dm[k]), "t": float(dt[k])},
                "blind": {"n": int(bn[k]), "hit": float(bh[k]), "mean_net": float(bm[k]), "t": float(bt[0])},
            })
        tt = np.where(dn >= MIN_N_DISC, dt, -np.inf)
        return tt.reshape(nb, K).max(1)

    def enough(mask) -> bool:
        return len(first_per_day(mask[:nd], day_id[:nd])) >= MIN_N_DISC

    # singles
    for c in range(n_c):
        searched["singles"] += 1
        if enough(cmask[c]):
            evaluated["singles"] += 1
            evaluate((c,), cmask[c])
    log(f"singles done ({time.time() - t0:.0f}s)")

    # pairs (different features)
    pair_keys, pair_t = [], []
    for a, b in itertools.combinations(range(n_c), 2):
        if feat_of[a] == feat_of[b]:
            continue
        searched["pairs"] += 1
        m = cmask[a] & cmask[b]
        if not enough(m):
            continue
        evaluated["pairs"] += 1
        pair_keys.append((a, b))
        pair_t.append(evaluate((a, b), m))
    pair_t = np.array(pair_t) if pair_t else np.zeros((0, P))
    log(f"pairs done: {evaluated['pairs']} evaluated ({time.time() - t0:.0f}s)")

    # triples: extensions of each block's own top-N discovery pairs
    trip_capped = False
    for p in range(P):
        rows = slice(p * K, (p + 1) * K)
        order = np.argsort(-pair_t[:, p])[:top_pairs] if len(pair_t) else []
        seen, n_p = set(), 0
        for i in order:
            a, b = pair_keys[i]
            base = cmask[a] & cmask[b]
            for c in range(n_c):
                if feat_of[c] in (feat_of[a], feat_of[b]):
                    continue
                key = tuple(sorted((a, b, c)))
                if key in seen:
                    continue
                if max_triples is not None and n_p >= max_triples:
                    trip_capped = True
                    break
                seen.add(key)
                n_p += 1
                if p == 0:
                    searched["triples"] += 1
                m = base & cmask[c]
                if not enough(m):
                    continue
                if p == 0:
                    evaluated["triples"] += 1
                evaluate(key, m, rows)
        log(f"triples block {p} done: {n_p} searched ({time.time() - t0:.0f}s)")

    lib = list(real_rules)
    lib.sort(key=lambda r: (-r["blind"]["t"], -r["discovery"]["t"]))
    for i, r in enumerate(lib):
        r["id"] = f"B{i + 1:04d}"
        r["label"] = " AND ".join(c.label() for c in r["conditions"])
        r["conditions"] = [c.to_json() for c in r["conditions"]]

    null_counts = surv[1:].tolist()
    null_p95 = float(np.percentile(surv[1:], 95)) if n_perms else float("nan")
    significant = bool(n_perms) and int(surv[0]) > null_p95
    counts = {
        "conditions": n_c, "searched_sets": searched, "evaluated_sets": evaluated,
        "candidates_searched": int(sum(searched.values()) * K),
        "candidates_evaluated": int(sum(evaluated.values()) * K),
        "discovery_survivors": int(dsurv[0]), "blind_survivors": int(surv[0]),
        "triples_capped": trip_capped, "top_pairs": top_pairs, "max_triples": max_triples,
        "rows": int(len(dates)), "discovery_rows": nd, "blind_rows": int(blind.sum()),
        "discovery_days": int(len(np.unique(day_id[:nd]))), "blind_days": int(len(np.unique(day_id[blind]))),
    }
    null = {"permutations": n_perms, "seed": seed, "survivors_per_perm": null_counts,
            "discovery_survivors_per_perm": dsurv[1:].tolist(), "p95": null_p95, "significant": significant}
    return MineResult(lib, counts, null, {"outcome_prep_s": round(t_out - t0, 1), "search_s": round(time.time() - t_out, 1)},
                      edges)
