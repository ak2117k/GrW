"""Results calendar: port of research/stock-daily/parse_earnings.py (filings -> events) and earnings_feats.py
(strict announced-only features, FALLBACK=0 = the `er0` GO configuration).

Raw inputs (no price/volume used to locate events):
  R  results filings      sym, t (filing timestamp IST, naive), src (nse|bse)
  B  board-meeting intims sym, meet_date, known_at (intimation timestamp IST, naive), src
Training seeds R/B from the research NSE+BSE JSON; the nightly job merges NSE bulk filings into the same
two tables (BSE is not refreshed live: its rows only refine the timing of past events).

Timing rules (no look-ahead), verbatim from earnings_feats.py:
- reaction session = the filing day if the earliest results filing is before 15:30, else the next session;
  an event is pending at t while t < reaction session.
- a pending event is KNOWN at t only if a matched board-meeting intimation was filed by t 15:30; days-until
  uses the meeting date of the latest such intimation (reschedules handled without peeking).
- past results moves |close_s/close_{s-1}-1| / ATR%_{s-1} enter the per-stock median only once s <= t.
"""
from __future__ import annotations

import re

import numpy as np
import pandas as pd

RES_RX = re.compile(r"result", re.I)
BAD_RX = re.compile(r"newspaper|publication|trading window|clarification|investor presentation|earnings call", re.I)
CAP_NEXT, CAP_SINCE = 30, 90
CLOSE_MIN = 15 * 60 + 30
R_COLS = ["sym", "t", "src"]
B_COLS = ["sym", "meet_date", "known_at", "src"]
MEET_COL = "results_date"   # not a model input: dropped before training / scoring
ER_COLS = ["er_days_next", "er_fallback", "er_days_since", "er_move_med", "er_move_last", "er_n_past",
           "er_known", "er_in5", "er_in10", "er_exp5", "er_season5"]


def _ts(x, fmt=None):
    return pd.to_datetime(x, format=fmt, errors="coerce")


# ── filings -> R / B rows ──────────────────────────────────────────────────────

def nse_rows(sym: str, res_list, bm_list) -> tuple[list[dict], list[dict]]:
    """NSE `corporates-financial-results` + `corporate-board-meetings` JSON lists (per-symbol or bulk rows
    already filtered to `sym`)."""
    res, bm = [], []
    for x in (res_list if isinstance(res_list, list) else []):
        t = _ts(x.get("broadCastDate") or x.get("filingDate"), "mixed")
        q = _ts(x.get("toDate"), "%d-%b-%Y")
        if pd.notna(t) and pd.notna(q) and q <= t <= q + pd.Timedelta(days=100):
            res.append(dict(sym=sym, t=t, src="nse"))
    for x in (bm_list if isinstance(bm_list, list) else []):
        txt = f"{x.get('bm_purpose') or ''} {x.get('bm_desc') or ''}"
        if not RES_RX.search(txt):
            continue
        md, ka = _ts(x.get("bm_date"), "%d-%b-%Y"), _ts(x.get("bm_timestamp"), "%d-%b-%Y %H:%M:%S")
        if pd.notna(md) and pd.notna(ka):
            bm.append(dict(sym=sym, meet_date=md, known_at=ka, src="nse"))
    return res, bm


def bse_rows(sym: str, res_tables, bm_tables) -> tuple[list[dict], list[dict]]:
    """BSE AnnSubCategoryGetData `Table` lists ('Result' and 'Board Meeting' categories)."""
    res, bm = [], []
    for x in res_tables or []:
        sub = x.get("NEWSSUB") or ""
        if x.get("SUBCATNAME") != "Financial Results" or BAD_RX.search(sub):
            continue
        t = _ts(x.get("NEWS_DT"))
        if pd.notna(t):
            res.append(dict(sym=sym, t=t, src="bse"))
    for x in bm_tables or []:
        more = x.get("MORE") or ""
        txt = f"{x.get('NEWSSUB') or ''} {more}"
        g = re.search(r"revised to (\d{2}/\d{2}/\d{4})", more) or re.search(
            r"scheduled (?:to be held )?on (\d{2}/\d{2}/\d{4})", more)
        if not g or not RES_RX.search(txt):
            continue
        md, ka = _ts(g.group(1), "%d/%m/%Y"), _ts(x.get("NEWS_DT"))
        if pd.notna(md) and pd.notna(ka):
            bm.append(dict(sym=sym, meet_date=md, known_at=ka, src="bse"))
    return res, bm


def frames(R: list[dict] | pd.DataFrame, B: list[dict] | pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    R = pd.DataFrame(R, columns=R_COLS) if not isinstance(R, pd.DataFrame) else R[R_COLS]
    B = pd.DataFrame(B, columns=B_COLS) if not isinstance(B, pd.DataFrame) else B[B_COLS]
    R = R.astype({"t": "datetime64[ns]"})
    B = B.astype({"meet_date": "datetime64[ns]", "known_at": "datetime64[ns]"})
    return R.drop_duplicates().reset_index(drop=True), B.drop_duplicates().reset_index(drop=True)


def cluster(times, gap=20):
    out, start, cur = [], None, []
    for t in times:
        if start is None or (t - start).days > gap:
            if cur:
                out.append(cur)
            start, cur = t, []
        cur.append(t)
    if cur:
        out.append(cur)
    return out


def build_events(R: pd.DataFrame, B: pd.DataFrame, today: pd.Timestamp) -> tuple[pd.DataFrame, pd.DataFrame]:
    """parse_earnings.main() without the I/O: (events, intimations). `today`: meetings on/after it with no
    filing are 'upcoming' pending events; earlier ones without a filing become 'bm_only' events."""
    today = pd.Timestamp(today).normalize()
    R, B = frames(R, B)
    B = B[B.known_at <= B.meet_date + pd.Timedelta(days=1)]
    rows = []
    for sym, g in R.sort_values("t").groupby("sym"):
        for cl in cluster(list(g.t)):
            c = g[g.t.isin(cl)]
            nse_t, bse_t = c.loc[c.src == "nse", "t"].min(), c.loc[c.src == "bse", "t"].min()
            rows.append(dict(sym=sym, ev_time=min(x for x in (nse_t, bse_t) if pd.notna(x)),
                             ev_src="+".join(sorted(c.src.unique())), nse_time=nse_t, bse_time=bse_t))
    ev = pd.DataFrame(rows, columns=["sym", "ev_time", "ev_src", "nse_time", "bse_time"])
    ev = ev.astype({"ev_time": "datetime64[ns]", "nse_time": "datetime64[ns]", "bse_time": "datetime64[ns]"})
    extra = []
    for sym, g in B[B.meet_date < today].groupby("sym"):
        have = ev.loc[ev.sym == sym, "ev_time"].dt.normalize()
        for cl in cluster(sorted(g.meet_date.unique())):
            md = pd.Timestamp(cl[-1])
            if len(have) == 0 or (have - md).abs().dt.days.min() > 20:
                extra.append(dict(sym=sym, ev_time=md + pd.Timedelta(hours=16), ev_src="bm_only"))
    if extra:
        ev = pd.concat([ev, pd.DataFrame(extra)], ignore_index=True)
    ka, md = [], []
    Bg = {s: g for s, g in B.groupby("sym")}
    for r in ev.itertuples():
        g = Bg.get(r.sym)
        if g is not None:
            d0 = r.ev_time.normalize()
            g = g[(g.known_at < r.ev_time) & (g.meet_date >= d0 - pd.Timedelta(days=5)) &
                  (g.meet_date <= d0 + pd.Timedelta(days=2))].sort_values("known_at")
        if g is not None and len(g):
            ka.append(g.known_at.iloc[0])
            md.append(g.meet_date.iloc[-1])
        else:
            ka.append(pd.NaT)
            md.append(pd.NaT)
    ev["known_at"] = pd.Series(ka, index=ev.index, dtype="datetime64[ns]")
    ev["meet_date"] = pd.Series(md, index=ev.index, dtype="datetime64[ns]")
    # BSE filing time > announced meeting day 16:00 (when the NSE XBRL time lags it) > NSE time.
    bse_ok = ev.bse_time.notna()
    lag = ~bse_ok & ev.meet_date.notna() & ev.nse_time.notna() & (ev.nse_time.dt.normalize() > ev.meet_date)
    ev.loc[bse_ok, "ev_time"] = ev.loc[bse_ok, "bse_time"]
    ev.loc[lag, "ev_time"] = ev.loc[lag, "meet_date"] + pd.Timedelta(hours=16)
    ev.loc[lag, "ev_src"] = "nse_lag->meet"
    ev.loc[ev.known_at >= ev.ev_time, ["known_at", "meet_date"]] = pd.NaT
    while True:   # unannounced clusters < 50 d after the previous event are re-filings of a reported quarter
        ev = ev.sort_values(["sym", "ev_time"]).reset_index(drop=True)
        gap = ev.groupby("sym").ev_time.diff().dt.days
        late = ev.known_at.isna() & (gap < 50)
        if not late.any():
            break
        ev = ev[~late]
    up = B[B.meet_date >= today].sort_values("known_at").groupby(["sym", "meet_date"]).first().reset_index()
    up = up.assign(ev_time=up.meet_date + pd.Timedelta(hours=16), ev_src="upcoming")[
        ["sym", "ev_time", "ev_src", "known_at", "meet_date"]]
    ev = pd.concat([ev, up], ignore_index=True).sort_values(["sym", "ev_time"]).reset_index(drop=True)
    return ev, B.reset_index(drop=True)


# ── events -> per-(sym, session) features ──────────────────────────────────────

def sessions(index_dates, cutoff: pd.Timestamp, until: str | pd.Timestamp | None = None) -> np.ndarray:
    """Real sessions before `cutoff`, then business days from `cutoff` (future holidays are unknown)."""
    cutoff = pd.Timestamp(cutoff)
    past = np.sort(pd.DatetimeIndex(index_dates)[pd.DatetimeIndex(index_dates) < cutoff].unique().to_numpy())
    until = pd.Timestamp(until) if until is not None else cutoff + pd.Timedelta(days=250)
    return np.concatenate([past, pd.bdate_range(cutoff, until).to_numpy()]).astype("datetime64[ns]")


def er_features(sym: str, g: pd.DataFrame, Bs: pd.DataFrame, raw: pd.DataFrame, sess: np.ndarray,
                fallback: int = 0) -> pd.DataFrame:
    """earnings_feats.py loop body for one symbol. `g`: its events; `Bs`: its intimations; `raw`: its daily
    prices (date < cutoff) — only for the past-move median. Returns rows for the dates in `raw`."""
    def i_ge(d):
        return np.searchsorted(sess, np.datetime64(pd.Timestamp(d).normalize(), "ns"), "left")

    def i_after(t):
        t = pd.Timestamp(t)
        d = t.normalize()
        return i_ge(d) if (t.hour * 60 + t.minute) <= CLOSE_MIN else np.searchsorted(sess, np.datetime64(d, "ns"), "right")

    raw = raw.sort_values("date").set_index("date")
    c, h, l = raw.close, raw.high, raw.low
    tr = pd.concat([h - l, (h - c.shift()).abs(), (l - c.shift()).abs()], axis=1).max(axis=1)
    atrp = tr.ewm(alpha=1 / 14, adjust=False).mean() / c
    ret = c.pct_change()
    n = len(sess)
    nxt = np.full(n, np.nan)
    fb = np.zeros(n, bool)
    meet = np.full(n, np.datetime64("NaT"), dtype="datetime64[ns]")   # display only, never a feature
    g = g.sort_values("ev_time")
    react = np.array([i_after(t) for t in g.ev_time])
    for k in range(len(g) - 1, -1, -1):  # reverse: earlier events overwrite later ones -> 'next' event
        r = g.iloc[k]
        ri = react[k]
        d0 = r.ev_time.normalize()
        m = Bs[(Bs.known_at < r.ev_time) & (Bs.meet_date >= d0 - pd.Timedelta(days=5)) &
               (Bs.meet_date <= d0 + pd.Timedelta(days=2))].sort_values("known_at")
        if len(m):
            for _, x in m.iterrows():
                a = i_after(x.known_at)
                if a < ri:
                    idx = np.arange(a, ri)
                    nxt[idx] = np.maximum(i_ge(x.meet_date) - idx, 0)
                    fb[idx] = False
                    meet[idx] = np.datetime64(pd.Timestamp(x.meet_date), "ns")
        elif fallback > 0:
            a = max(i_ge(d0) - fallback, 0)
            if a < ri:
                idx = np.arange(a, ri)
                nxt[idx] = np.maximum(i_ge(d0) - idx, 0)
                fb[idx] = True
                meet[idx] = np.datetime64(d0, "ns")
    past = g[g.ev_src != "upcoming"].copy()
    past["ri"] = [i_after(t) for t in past.ev_time]
    past = past[past.ri < n].drop_duplicates("ri")
    rdates = pd.DatetimeIndex(sess[past.ri.to_numpy()])
    prev_atr = atrp.shift().reindex(rdates).to_numpy()
    with np.errstate(divide="ignore", invalid="ignore"):
        mv = np.abs(ret.reindex(rdates).to_numpy()) / prev_atr
    ri_sorted = past.ri.to_numpy()
    allidx = np.arange(n)
    cnt = np.searchsorted(ri_sorted, allidx, "right")
    since = np.where(cnt > 0, allidx - ri_sorted[np.maximum(cnt - 1, 0)], np.nan)
    med = np.full(len(mv) + 1, np.nan)
    last = np.full(len(mv) + 1, np.nan)
    for j in range(1, len(mv) + 1):
        v = mv[:j][~np.isnan(mv[:j])]
        if len(v) >= 2:
            med[j] = np.median(v)
        if len(v):
            last[j] = v[-1]
    f = pd.DataFrame({"date": sess, "er_days_next": np.minimum(nxt, CAP_NEXT), "er_fallback": fb.astype(float),
                      "er_days_since": np.minimum(since, CAP_SINCE), "er_move_med": med[cnt],
                      "er_move_last": last[cnt], "er_n_past": cnt.astype(float), MEET_COL: meet})
    f = f[f.date.isin(raw.index)].copy()
    f["er_known"] = f.er_days_next.notna().astype(float)
    f["er_in5"] = (f.er_days_next <= 5).astype(float)
    f["er_in10"] = (f.er_days_next <= 10).astype(float)
    f["er_days_next"] = f.er_days_next.fillna(CAP_NEXT + 1)
    f["er_exp5"] = f.er_in5 * f.er_move_med
    f["sym"] = sym
    return f


def with_season(parts: list[pd.DataFrame]) -> pd.DataFrame:
    out = pd.concat(parts, ignore_index=True)
    out["er_season5"] = out.groupby("date").er_in5.transform("mean")
    return out
