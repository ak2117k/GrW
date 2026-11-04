"""Noise-vs-real spike: build the event dataset. Throwaway research code (READ-ONLY on all data sources).

Sources
  NIFTY / BANKNIFTY 1m index bars 2016-10 .. 2026-10-19   C:\\Users\\AryanKumar\\grw-mbm\\bars\\1m\\<SYM>
  + prod candles_1m (data/prod_1m.csv) for the days after the store's last day (to 2026-11-04 13:40 IST)
  SENSEX (BSE 99919000) and MCX crude (573422): prod only (~4 weeks) -> out-of-sample sanity only
  INDIA VIX 1m from the store (prev close + intraday change); NaN after 2026-10-19
  NIFTY futures-OI / option-chain 5m grid (research/oi-pattern/data/grid.parquet, 2025-10 .. 2026-10)

Event design (adverse): hypothetical LONG and SHORT positions are opened at the close of every 15-min mark
09:30 .. 14:30 IST (exchange session-relative for MCX). For each position the running favourable extreme
("best", bar highs for a long) is tracked. An adverse event at level k fires on the FIRST minute close where
(best - close) >= k * N, N = mean true range of the last 14 1m bars (the app's atr14-1m). One event per
(position, k). Decision price = that close. Everything in the feature row uses bars <= t only.
Label (horizon H): NOISE = a later bar trades back to `best` before any bar trades m N beyond the event
close (REAL). Same bar touches both -> REAL (conservative). Neither by t+H -> TIMEOUT (marked to close).
Hold P&L (marginal vs exiting at the event close, in N): +dist-to-best on NOISE, -(m + stop slip) on REAL,
close(t+H)-close(t) on TIMEOUT, minus theta = THETA_N_PER_MIN * minutes held.

Favourable spike mirror: at minute t, close(t) - min(low[t-2..t]) >= 2.5 N(t-3) (or mirror down): a holder in
the spike direction can BANK at close(t) or HOLD 10 min with a stop at the 50 % retrace. SNAP = the 50 %
retrace trades within 10 min; else EXTEND. One spike per direction per 10 min.
"""
import glob, os, sys
import numpy as np, pandas as pd

ROOT = r"C:\Users\AryanKumar\grw-mbm"
HERE = os.path.dirname(os.path.abspath(__file__))
D = os.path.join(HERE, "data")
KS = (1.5, 2.0, 3.0)
M_FURTHER = 1.5          # REAL = m N further against from the event close
HS = (15, 30)
STOP_SLIP_N = 0.2        # stop fills worse than the level
THETA_N_PER_MIN = 0.01   # ~0.6 N/hour option decay proxy, in underlying-N units
SPIKE_N = 2.5
PROD_TOK = {"NIFTY": "99926000", "BANKNIFTY": "99926009", "SENSEX": "99919000", "CRUDE": "573422"}
SESS = {"NSE": (555, 930), "BSE": (555, 930), "MCX": (540, 1410)}  # IST minutes open, close (exclusive)


def load_1m(sym):
    prod = pd.read_csv(os.path.join(D, "prod_1m.csv"), dtype={"token": str})
    p = prod[prod.token == PROD_TOK[sym]].copy()
    p["ts"] = pd.to_datetime(p.ts, utc=True)
    p = p[["ts", "open", "high", "low", "close", "volume"]]
    if sym in ("NIFTY", "BANKNIFTY"):
        parts = [pd.read_parquet(f, columns=["ts", "open", "high", "low", "close", "volume"])
                 for f in sorted(glob.glob(os.path.join(ROOT, "bars", "1m", sym, "*.parquet")))]
        s = pd.concat(parts)
        s["ts"] = pd.to_datetime(s.ts, utc=True)
        last_day = s.ts.dt.tz_convert("Asia/Kolkata").dt.date.max()
        pd_ = p[p.ts.dt.tz_convert("Asia/Kolkata").dt.date > last_day]
        s = pd.concat([s, pd_])
    else:
        s = p
    s = s.drop_duplicates("ts").sort_values("ts")
    t = s.ts.dt.tz_convert("Asia/Kolkata").dt.tz_localize(None)
    s = s.assign(t=t.values, date=t.dt.normalize().values, mins=(t.dt.hour * 60 + t.dt.minute).values)
    for c in ["open", "high", "low", "close"]:
        s[c] = s[c].astype(float)
    return s.reset_index(drop=True)


def vix_daily_and_1m():
    parts = [pd.read_parquet(f, columns=["ts", "close"]) for f in sorted(glob.glob(os.path.join(ROOT, "bars", "1m", "INDIAVIX", "*.parquet")))]
    v = pd.concat(parts)
    t = pd.to_datetime(v.ts, utc=True).dt.tz_convert("Asia/Kolkata").dt.tz_localize(None)
    v = pd.Series(v.close.astype(float).values, index=t.values).sort_index()
    v = v[~v.index.duplicated()]
    daily_close = v.groupby(v.index.normalize()).last()
    return v, daily_close


def build(sym, exch):
    s = load_1m(sym)
    o_, c_ = SESS[exch]
    s = s[(s.mins >= o_) & (s.mins < c_)]
    days = []
    for d, g in s.groupby("date"):
        if len(g) < 0.8 * (c_ - o_) and not (d == s.date.max() and len(g) >= 0.5 * (c_ - o_)):
            continue
        days.append((d, g))
    # daily table for PDH/PDL/ATR14 (prior days only)
    daily = pd.DataFrame([{"date": d, "o": g.open.iloc[0], "h": g.high.max(), "l": g.low.min(), "c": g.close.iloc[-1]} for d, g in days]).set_index("date")
    pc = daily.c.shift(1)
    tr = np.maximum(daily.h - daily.l, np.maximum((daily.h - pc).abs(), (daily.l - pc).abs()))
    daily["atr14_prev"] = tr.rolling(14, min_periods=3).mean().shift(1)
    daily["pdh"], daily["pdl"], daily["pdc"] = daily.h.shift(1), daily.l.shift(1), pc
    vix1m, vixd = vix_daily_and_1m()
    vix_prev = vixd.shift(1)
    adv, spk = [], []
    for d, g in days:
        info = daily.loc[d]
        if not np.isfinite(info.atr14_prev):
            continue
        H = g.high.values; L = g.low.values; C = g.close.values; O = g.open.values; mins = g.mins.values
        n = len(C)
        prevc = np.r_[C[0], C[:-1]]
        trv = np.maximum(H - L, np.maximum(np.abs(H - prevc), np.abs(L - prevc)))
        trv[0] = H[0] - L[0]
        N = pd.Series(trv).rolling(14).mean().values
        N60 = pd.Series(trv).rolling(60, min_periods=20).mean().values
        twap = np.cumsum(C) / np.arange(1, n + 1)
        dh = np.maximum.accumulate(H); dl = np.minimum.accumulate(L)
        dopen = O[0]
        vp = vix_prev.get(d, np.nan)
        vday = vix1m[(vix1m.index >= d) & (vix1m.index < d + pd.Timedelta(days=1))]
        vopen = vday.iloc[0] if len(vday) else np.nan
        tvals = g.t.values
        atrd = info.atr14_prev

        def vix_at(i):
            if not len(vday):
                return np.nan
            j = vday.index.searchsorted(tvals[i], side="right") - 1
            return vday.iloc[j] if j >= 0 else np.nan

        common_day = dict(sym=sym, date=d, atrd=atrd, vix_prev=vp,
                          gap_atr=(dopen - info.pdc) / atrd)
        # ---------------- adverse events from hypothetical positions ----------------
        marks = [i for i in range(n) if (mins[i] - o_) >= 15 and (mins[i] - o_) % 15 == 0 and mins[i] <= c_ - 60]
        last_exit = n - 6  # flatten 5 min before close
        for i0 in marks:
            for side in (1, -1):
                fav = H if side == 1 else L
                best = fav[i0:].copy()
                best = np.maximum.accumulate(best) if side == 1 else np.minimum.accumulate(best)
                ar = np.arange(len(best))
                chg = np.r_[True, best[1:] != best[:-1]]
                ibest = np.maximum.accumulate(np.where(chg, ar, 0))
                dd = side * (best - C[i0:]) / N[i0:]
                for k in KS:
                    hit = np.nonzero((dd >= k) & (np.arange(len(dd)) > 0))[0]
                    if not len(hit):
                        continue
                    j = hit[0]; t = i0 + j
                    if t >= last_exit - 1 or not np.isfinite(N[t]):
                        continue
                    bst = best[j]; Nt = N[t]; ct = C[t]
                    stop = ct - side * M_FURTHER * Nt
                    row = dict(common_day, kind="adverse", k=k, side=side, t=tvals[t], tod=mins[t] - o_,
                               entry_min=mins[i0] - o_, held_min=t - i0, moveN=dd[j], N=Nt,
                               N_ratio=Nt / N60[t] if N60[t] > 0 else np.nan, N_atr=Nt / atrd,
                               speed_min=j - ibest[j], pnl_at_event=side * (ct - C[i0]) / Nt,
                               best_gainN=side * (bst - C[i0]) / Nt,
                               twapN=side * (ct - twap[t]) / Nt, openN=side * (ct - dopen) / Nt,
                               pdhN=side * (ct - info.pdh) / Nt, pdlN=side * (ct - info.pdl) / Nt,
                               dayrng_atr=(dh[t] - dl[t]) / atrd, trend_atr=side * (ct - dopen) / atrd,
                               ret30N=side * (ct - C[max(0, t - 30)]) / Nt, ret60N=side * (ct - C[max(0, t - 60)]) / Nt,
                               vix_chg=(vix_at(t) - vopen) if np.isfinite(vopen) else np.nan,
                               dow=pd.Timestamp(d).dayofweek)
                    # adverse-side day extreme & levels, and failed-break context during the leg
                    tb = i0 + ibest[j]
                    if side == 1:  # long: adverse is down
                        ext_before = dl[tb - 1] if tb > 0 else L[0]
                        leg_ext = L[tb:t + 1].min()
                        row["adv_extN"] = (ct - min(dl[t], leg_ext)) / Nt
                        row["fb_day"] = int(leg_ext < ext_before)
                        row["fb_pd"] = int(leg_ext < info.pdl <= bst)
                        row["lvl_beyondN"] = (info.pdl - ct) / Nt  # >0 = close below PDL
                        row["at_new_ext"] = int(L[t] <= dl[max(t - 1, 0)])
                    else:
                        ext_before = dh[tb - 1] if tb > 0 else H[0]
                        leg_ext = H[tb:t + 1].max()
                        row["adv_extN"] = (max(dh[t], leg_ext) - ct) / Nt
                        row["fb_day"] = int(leg_ext > ext_before)
                        row["fb_pd"] = int(leg_ext > info.pdh >= bst)
                        row["lvl_beyondN"] = (ct - info.pdh) / Nt
                        row["at_new_ext"] = int(H[t] >= dh[max(t - 1, 0)])
                    for Hh in HS:
                        end = min(t + Hh, last_exit)
                        lab, pnl, hold = "TIMEOUT", side * (C[end] - ct) / Nt, end - t
                        hh, ll = H[t + 1:end + 1], L[t + 1:end + 1]
                        tg = (hh >= bst) if side == 1 else (ll <= bst)
                        sp = (ll <= stop) if side == 1 else (hh >= stop)
                        ev = tg | sp
                        if ev.any():
                            q = int(np.argmax(ev))
                            if sp[q]:
                                lab, pnl, hold = "REAL", -(M_FURTHER + STOP_SLIP_N), q + 1
                            else:
                                lab, pnl, hold = "NOISE", side * (bst - ct) / Nt, q + 1
                        row[f"lab{Hh}"] = lab
                        row[f"hold{Hh}"] = pnl
                        row[f"holdnet{Hh}"] = pnl - THETA_N_PER_MIN * hold
                        row[f"fwd{Hh}"] = side * (C[end] - ct) / Nt  # mark-to-market at horizon, no brackets
                    adv.append(row)
        # ---------------- favourable spikes ----------------
        lastspk = {1: -99, -1: -99}
        for t in range(18, last_exit - 1):
            Np = N[t - 3]
            if not np.isfinite(Np) or Np <= 0:
                continue
            for side in (1, -1):
                if t - lastspk[side] < 10:
                    continue
                ext = L[t - 2:t + 1].min() if side == 1 else H[t - 2:t + 1].max()
                sz = side * (C[t] - ext)
                if sz < SPIKE_N * Np:
                    continue
                lastspk[side] = t
                ct = C[t]; half = ct - side * 0.5 * sz
                end = min(t + 10, last_exit)
                lab, pnl, hold = "EXTEND", side * (C[end] - ct) / Np, end - t
                for q in range(t + 1, end + 1):
                    if (L[q] <= half) if side == 1 else (H[q] >= half):
                        lab, pnl, hold = "SNAP", -(0.5 * sz / Np + STOP_SLIP_N), q - t; break
                spk.append(dict(common_day, kind="spike", side=side, t=tvals[t], tod=mins[t] - o_, sizeN=sz / Np,
                                N=Np, N_ratio=Np / N60[t - 3] if N60[t - 3] > 0 else np.nan, N_atr=Np / atrd,
                                twapN=side * (ct - twap[t]) / Np, openN=side * (ct - dopen) / Np,
                                pdhN=side * (ct - info.pdh) / Np, pdlN=side * (ct - info.pdl) / Np,
                                dayrng_atr=(dh[t] - dl[t]) / atrd, trend_atr=side * (ct - dopen) / atrd,
                                ret30N=side * (ct - C[max(0, t - 30)]) / Np, ret60N=side * (ct - C[max(0, t - 60)]) / Np,
                                at_new_ext=int((H[t] >= dh[t - 1]) if side == 1 else (L[t] <= dl[t - 1])),
                                vix_chg=(vix_at(t) - vopen) if np.isfinite(vopen) else np.nan,
                                lab=lab, hold=pnl, holdnet=pnl - THETA_N_PER_MIN * hold,
                                fwd10=side * (C[end] - ct) / Np, dow=pd.Timestamp(d).dayofweek))
    return pd.DataFrame(adv), pd.DataFrame(spk)


def main():
    syms = sys.argv[1:] or ["NIFTY", "BANKNIFTY", "SENSEX", "CRUDE"]
    exch = {"NIFTY": "NSE", "BANKNIFTY": "NSE", "SENSEX": "BSE", "CRUDE": "MCX"}
    for sym in syms:
        a, s = build(sym, exch[sym])
        a.to_parquet(os.path.join(D, f"adv_{sym}.parquet"))
        s.to_parquet(os.path.join(D, f"spk_{sym}.parquet"))
        print(sym, "adverse", a.shape, "spikes", s.shape, a.date.min() if len(a) else None, a.date.max() if len(a) else None, flush=True)


if __name__ == "__main__":
    main()
