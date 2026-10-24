"""Build the backtest data store's load files from the PC's research downloads.

Reads (never writes) the local research data and writes gzipped CSV chunks ready for `\\copy`
into the server's backtest_bars / backtest_fo_eod tables (migration 20261024130000_backtest_data).
The server side is scripts/backtest-data/load-backtest-data.sh (idempotent, run by the coordinator
at deploy time). Nothing here talks to any database.

Datasets (symbol, exchange, interval, source):
  research-1m : NIFTY, BANKNIFTY 1m 2016-10 ->   grw-mbm/bars/1m/<S>/*.parquet (Angel broker bars)
                RELIANCE, TCS, HDFCBANK, INFY, ICICIBANK, BHARTIARTL, LT, ITC  -> rolled up to 15m
  daily       : NIFTY 1d 2012 ->  research/nse-oi/data/spot.parquet (NSE) + grw-mbm/bars/1d/NIFTY
                BANKNIFTY, INDIAVIX 1d 2016-10 -> grw-mbm/bars/1d/<S>
  yahoo       : ~213 F&O stocks 1d, 10 y -> research/stock-daily/data/raw/<SYM>.parquet
                (split-adjusted OHLC, as Yahoo serves them; NIFTYIDX/INDIAVIX skipped: covered above)
  nse-bhav    : NIFTY-FUT1 / BANKNIFTY-FUT1 1d (front-month continuous, OI)  -> backtest_bars
                every index future contract + options within +-10 % of spot on the nearest
                3 expiries with OI > 0, 2016-10 ->                             -> backtest_fo_eod

Normalisation: ts = bar START in UTC. Intraday bars keep the regular NSE session only
(09:15 <= IST < 15:30) and roll-ups are anchored at 09:15 IST like the broker's candles.
Daily bars are stamped with their IST session date at 09:15 IST (= 03:45Z), the same stamp the
Angel ONE_DAY candles and the MBM 1d store use.

Usage:  py -3 scripts/backtest-data/build_backtest_data.py [--out DIR] [--only NAME,...] [--dry-run]
        NAME in: research1m, daily, yahoo, futcont, foeod
"""
from __future__ import annotations

import argparse
import glob
import gzip
import io
import json
import os
import sys
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

MBM_ROOT = r"C:\Users\AryanKumar\grw-mbm"
DEFAULT_OUT = os.path.join(MBM_ROOT, "exports", "backtest-data")

SESSION_OPEN_MIN = 9 * 60 + 15
SESSION_CLOSE_MIN = 15 * 60 + 30
IST = "Asia/Kolkata"
CHUNK_ROWS = 250_000
FO_SINCE = "2016-10-01"
FO_STRIKE_BAND = 0.10
FO_MAX_EXPIRIES = 3

# Estimated on-disk bytes per row in Postgres (heap tuple + PK index entry), uncompressed.
# backtest_bars: 24 B tuple header + 4 B item id + 4 dataset_id + 8 ts + 6 x 8 floats (+ oi) = ~92 B,
# PK btree (int4, timestamptz) entry ~31 B at the default fill factor -> ~125 B/row.
# backtest_fo_eod: 28 + ~8 text + 3 dates/real x 4 + 6 real + 3 int4 = ~82 B, wide 5-column PK ~38 B.
BYTES_PER_BAR_ROW = 125
BYTES_PER_FO_ROW = 120

INTRADAY_SERIES = {  # mbm store series -> (symbol, interval minutes)
    "NIFTY": ("NIFTY", 1),
    "BANKNIFTY": ("BANKNIFTY", 1),
    "EQ_RELIANCE": ("RELIANCE", 15),
    "EQ_TCS": ("TCS", 15),
    "EQ_HDFCBANK": ("HDFCBANK", 15),
    "EQ_INFY": ("INFY", 15),
    "EQ_ICICIBANK": ("ICICIBANK", 15),
    "EQ_BHARTIARTL": ("BHARTIARTL", 15),
    "EQ_LT": ("LT", 15),
    "EQ_ITC": ("ITC", 15),
}
YAHOO_SKIP = {"NIFTYIDX", "INDIAVIX"}

BAR_COLUMNS = ["symbol", "exchange", "interval", "source", "ts", "open", "high", "low", "close", "volume", "oi"]
FO_COLUMNS = ["underlying", "date", "expiry", "kind", "strike", "open", "high", "low", "close", "settle",
              "contracts", "oi", "chg_oi", "undl"]


def interval_label(minutes: int) -> str:
    if minutes == 1440:
        return "1d"
    if minutes % 60 == 0:
        return f"{minutes // 60}h"
    return f"{minutes}m"


# ── normalisation (pure; covered by test_build_backtest_data.py) ─────────────────────────────


def normalise_intraday(df: pd.DataFrame, minutes: int) -> pd.DataFrame:
    """1m broker bars (ts = bar start, tz-aware UTC) -> regular-session bars of `minutes`.

    Drops anything outside 09:15 <= IST < 15:30 (muhurat / pre-open / stray ticks). Buckets are
    anchored at 09:15 IST; a bucket's ts is its START. Returns columns ts(UTC), open, high, low,
    close, volume, oi (oi = last non-null in the bucket, else NaN).
    """
    if df.empty:
        return pd.DataFrame(columns=["ts", "open", "high", "low", "close", "volume", "oi"])
    ts = pd.to_datetime(df["ts"], utc=True)
    local = ts.dt.tz_convert(IST)
    mins = local.dt.hour * 60 + local.dt.minute
    keep = (mins >= SESSION_OPEN_MIN) & (mins < SESSION_CLOSE_MIN)
    d = df.loc[keep].copy()
    local = local[keep]
    mins = mins[keep] - SESSION_OPEN_MIN
    if "oi" not in d.columns:
        d["oi"] = np.nan
    d["oi"] = pd.to_numeric(d["oi"], errors="coerce").astype("float64")
    d["volume"] = pd.to_numeric(d.get("volume", 0), errors="coerce").fillna(0).astype("float64")
    if minutes == 1:
        out = d.assign(ts=ts[keep].dt.floor("min"))[["ts", "open", "high", "low", "close", "volume", "oi"]]
        return out.drop_duplicates("ts", keep="last").sort_values("ts").reset_index(drop=True)
    bucket = (mins // minutes) * minutes + SESSION_OPEN_MIN
    start_local = local.dt.normalize() + pd.to_timedelta(bucket, unit="m")
    d["bucket"] = start_local.dt.tz_convert("UTC").values
    d = d.sort_values("ts")
    g = d.groupby("bucket", sort=True)
    out = pd.DataFrame({
        "open": g["open"].first(), "high": g["high"].max(), "low": g["low"].min(),
        "close": g["close"].last(), "volume": g["volume"].sum(), "oi": g["oi"].last(),
    })
    out.index.name = "ts"
    out = out.reset_index()
    out["ts"] = pd.to_datetime(out["ts"], utc=True)
    return out


def session_ts(dates) -> pd.Series:
    """IST session dates (naive dates / datetimes) -> 09:15 IST of that date, in UTC."""
    d = pd.to_datetime(pd.Series(dates)).dt.tz_localize(None).dt.normalize()
    return (d + pd.Timedelta(minutes=SESSION_OPEN_MIN)).dt.tz_localize(IST).dt.tz_convert("UTC")


def normalise_daily(df: pd.DataFrame, date_col: str = "date") -> pd.DataFrame:
    """Daily OHLCV keyed by IST session date -> ts at 09:15 IST in UTC; drops rows missing OHLC."""
    d = df.dropna(subset=["open", "high", "low", "close"]).copy()
    d["ts"] = session_ts(d[date_col]).values
    d["volume"] = pd.to_numeric(d["volume"], errors="coerce").fillna(0).astype("float64") if "volume" in d else 0.0
    if "oi" not in d.columns:
        d["oi"] = np.nan
    out = d[["ts", "open", "high", "low", "close", "volume", "oi"]]
    out = out[(out.high >= out.low) & (out.close > 0)]
    return out.drop_duplicates("ts", keep="last").sort_values("ts").reset_index(drop=True)


def front_month_continuous(fut: pd.DataFrame) -> pd.DataFrame:
    """Per date, the nearest unexpired contract (expiry >= date): a front-month continuous series.

    Rolls on the day after expiry (the expiring contract is still front on its expiry day).
    `fut` columns: date, expiry, open, high, low, close, contracts, oi.
    """
    f = fut[fut.expiry >= fut.date].sort_values(["date", "expiry"])
    first = f.groupby("date", sort=True).head(1)
    return first.rename(columns={"contracts": "volume"})[["date", "open", "high", "low", "close", "volume", "oi"]]


def option_band_filter(opt: pd.DataFrame, spot: pd.Series, band: float = FO_STRIKE_BAND,
                       max_expiries: int = FO_MAX_EXPIRIES) -> pd.DataFrame:
    """Options within +-band of spot on the nearest `max_expiries` expiries, OI > 0.

    `opt` columns: date, expiry, strike, oi (+ the rest); `spot` indexed by date (that day's
    underlying close). Rows with no spot that day are dropped.
    """
    s = opt["date"].map(spot)
    o = opt.assign(_s=s)
    o = o[o._s.notna() & (o.oi > 0) & (o.expiry >= o.date)]
    o = o[(o.strike - o._s).abs() <= band * o._s]
    rank = o.groupby("date")["expiry"].rank(method="dense")
    return o[rank <= max_expiries].drop(columns="_s")


def fmt_ts(ts: pd.Series) -> pd.Series:
    return pd.to_datetime(ts, utc=True).dt.strftime("%Y-%m-%dT%H:%M:%SZ")


# ── output ───────────────────────────────────────────────────────────────────────────────────


@dataclass
class DatasetStat:
    symbol: str
    exchange: str
    interval: str
    source: str
    rows: int = 0
    first: str | None = None
    last: str | None = None


@dataclass
class ChunkWriter:
    """Appends frames to <out>/<sub>/<prefix>-NNNN.csv.gz, rolling at CHUNK_ROWS rows."""
    out: str
    sub: str
    prefix: str
    columns: list
    dry_run: bool = False
    files: list = field(default_factory=list)
    _buf: list = field(default_factory=list)
    _n: int = 0
    rows: int = 0
    gz_bytes: int = 0

    def add(self, frame: pd.DataFrame) -> None:
        if frame.empty:
            return
        self._buf.append(frame[self.columns])
        self._n += len(frame)
        self.rows += len(frame)
        if self._n >= CHUNK_ROWS:
            self.flush()

    def flush(self) -> None:
        if not self._buf:
            return
        frame = pd.concat(self._buf, ignore_index=True)
        self._buf, self._n = [], 0
        if self.dry_run:
            return
        os.makedirs(os.path.join(self.out, self.sub), exist_ok=True)
        path = os.path.join(self.out, self.sub, f"{self.prefix}-{len(self.files) + 1:04d}.csv.gz")
        text = io.StringIO()
        frame.to_csv(text, index=False, float_format="%.10g", na_rep="")
        with gzip.open(path + ".partial", "wt", encoding="utf-8", newline="") as fh:
            fh.write(text.getvalue())
        os.replace(path + ".partial", path)
        self.files.append(os.path.relpath(path, self.out).replace("\\", "/"))
        self.gz_bytes += os.path.getsize(path)


def bars_frame(norm: pd.DataFrame, symbol: str, exchange: str, interval: str, source: str) -> pd.DataFrame:
    f = norm.copy()
    f[["open", "high", "low", "close"]] = f[["open", "high", "low", "close"]].astype("float64").round(4)
    f["ts"] = fmt_ts(f["ts"])
    f.insert(0, "source", source)
    f.insert(0, "interval", interval)
    f.insert(0, "exchange", exchange)
    f.insert(0, "symbol", symbol)
    return f


def track(stats: dict, key: tuple, norm: pd.DataFrame) -> None:
    st = stats[key]
    if norm.empty:
        return
    st.rows += len(norm)
    first, last = norm["ts"].min().isoformat(), norm["ts"].max().isoformat()
    st.first = first if st.first is None or first < st.first else st.first
    st.last = last if st.last is None or last > st.last else st.last


# ── dataset builders ─────────────────────────────────────────────────────────────────────────


def build_research_1m(w: ChunkWriter, stats: dict) -> None:
    for series, (symbol, minutes) in INTRADAY_SERIES.items():
        files = sorted(glob.glob(os.path.join(MBM_ROOT, "bars", "1m", series, "*.parquet")))
        if not files:
            print(f"  research-1m {series}: no files, skipped")
            continue
        key = (symbol, "NSE", interval_label(minutes), "research-1m")
        stats.setdefault(key, DatasetStat(*key))
        for f in files:  # one month at a time: bounded memory
            norm = normalise_intraday(pd.read_parquet(f), minutes)
            track(stats, key, norm)
            w.add(bars_frame(norm, *key))
        print(f"  research-1m {series} -> {symbol} {key[2]}: {stats[key].rows} rows")


def read_mbm_daily(series: str) -> pd.DataFrame:
    files = sorted(glob.glob(os.path.join(MBM_ROOT, "bars", "1d", series, "*.parquet")))
    if not files:
        return pd.DataFrame(columns=["date", "open", "high", "low", "close", "volume"])
    d = pd.concat([pd.read_parquet(f) for f in files], ignore_index=True)
    d["date"] = pd.to_datetime(d["ts"], utc=True).dt.tz_convert(IST).dt.tz_localize(None).dt.normalize()
    return d[["date", "open", "high", "low", "close", "volume"]]


def build_daily(w: ChunkWriter, stats: dict) -> None:
    spot = pd.read_parquet(os.path.join(MBM_ROOT, "research", "nse-oi", "data", "spot.parquet"))
    spot = spot.reset_index() if "date" not in spot.columns else spot
    spot["date"] = pd.to_datetime(spot["date"]).dt.normalize()
    spot["volume"] = 0.0
    mbm = read_mbm_daily("NIFTY")
    nifty = pd.concat([spot[["date", "open", "high", "low", "close", "volume"]],
                       mbm[mbm.date > spot.date.max()]], ignore_index=True)
    for symbol, frame, source in [("NIFTY", nifty, "nse-bhav,research-1m"),
                                  ("BANKNIFTY", read_mbm_daily("BANKNIFTY"), "research-1m"),
                                  ("INDIAVIX", read_mbm_daily("INDIAVIX"), "research-1m")]:
        key = (symbol, "NSE", "1d", source)
        stats.setdefault(key, DatasetStat(*key))
        norm = normalise_daily(frame)
        track(stats, key, norm)
        w.add(bars_frame(norm, *key))
        print(f"  daily {symbol}: {len(norm)} rows")


def build_yahoo(w: ChunkWriter, stats: dict) -> None:
    files = sorted(glob.glob(os.path.join(MBM_ROOT, "research", "stock-daily", "data", "raw", "*.parquet")))
    n = 0
    for f in files:
        symbol = os.path.splitext(os.path.basename(f))[0].upper()
        if symbol in YAHOO_SKIP:
            continue
        key = (symbol, "NSE", "1d", "yahoo")
        stats.setdefault(key, DatasetStat(*key))
        norm = normalise_daily(pd.read_parquet(f, columns=["date", "open", "high", "low", "close", "volume"]))
        track(stats, key, norm)
        w.add(bars_frame(norm, *key))
        n += 1
    print(f"  yahoo: {n} symbols")


def read_fo(columns: list, since: str | None = None, until: str | None = None) -> pd.DataFrame:
    import pyarrow.parquet as pq
    path = os.path.join(MBM_ROOT, "research", "nse-oi", "data", "fo_index.parquet")
    filters = ([("date", ">=", pd.Timestamp(since))] if since else []) + ([("date", "<", pd.Timestamp(until))] if until else [])
    filters = filters or None
    t = pq.read_table(path, columns=columns, filters=filters)
    d = t.to_pandas()
    for c in ("instr", "sym", "opt"):
        if c in d.columns:
            d[c] = d[c].astype(str)
    return d


def build_fut_continuous(w: ChunkWriter, stats: dict) -> pd.DataFrame:
    fut = read_fo(["date", "instr", "sym", "expiry", "open", "high", "low", "close", "settle", "contracts", "oi",
                   "chg_oi", "undl"])
    fut = fut[fut.instr == "FUTIDX"].copy()
    for sym in ("NIFTY", "BANKNIFTY"):
        key = (f"{sym}-FUT1", "NFO", "1d", "nse-bhav")
        stats.setdefault(key, DatasetStat(*key))
        cont = front_month_continuous(fut[fut.sym == sym])
        norm = normalise_daily(cont)
        track(stats, key, norm)
        w.add(bars_frame(norm, *key))
        print(f"  {key[0]}: {len(norm)} rows")
    return fut


def build_fo_eod(w: ChunkWriter, fut: pd.DataFrame) -> dict:
    """Futures (all contracts) + band-filtered options into backtest_fo_eod rows."""
    counts = {}
    spot_n = pd.read_parquet(os.path.join(MBM_ROOT, "research", "nse-oi", "data", "spot.parquet"))
    spot_n = spot_n.reset_index() if "date" not in spot_n.columns else spot_n
    spot_n = spot_n.set_index(pd.to_datetime(spot_n["date"]).dt.normalize())["close"]
    fut = fut[fut.date >= FO_SINCE]
    front = fut[fut.expiry >= fut.date].sort_values(["date", "expiry"]).groupby(["sym", "date"]).close.first()
    f_rows = fut.assign(kind="FUT", strike=0.0, underlying=fut.sym)
    w.add(fo_frame(f_rows))
    counts["FUT"] = len(f_rows)
    for year in range(int(FO_SINCE[:4]), pd.Timestamp.now().year + 1):  # one year at a time
        opt = read_fo(["date", "instr", "sym", "expiry", "strike", "opt", "open", "high", "low", "close", "settle",
                       "contracts", "oi", "chg_oi", "undl"], since=max(FO_SINCE, f"{year}-01-01"), until=f"{year + 1}-01-01")
        opt = opt[opt.instr == "OPTIDX"]
        for sym in ("NIFTY", "BANKNIFTY"):
            o = opt[opt.sym == sym]
            if o.empty:
                continue
            # spot: NSE index close for NIFTY, the bhavcopy's underlying value, else the front future.
            fb = front.xs(sym, level="sym") if sym in front.index.get_level_values("sym") else pd.Series(dtype=float)
            undl = o.groupby("date").undl.max()
            spot = (spot_n if sym == "NIFTY" else pd.Series(dtype=float)).reindex(undl.index)
            spot = spot.fillna(undl).fillna(fb.reindex(undl.index))
            kept = option_band_filter(o, spot)
            kept = kept.assign(kind=kept.opt, underlying=sym)
            w.add(fo_frame(kept))
            counts[f"{sym}-{year}"] = len(kept)
        print(f"  fo-eod {year}: {sum(v for k, v in counts.items() if k.endswith(str(year)))} option rows")
        del opt
    return counts


def fo_frame(d: pd.DataFrame) -> pd.DataFrame:
    f = d.copy()
    f["date"] = pd.to_datetime(f["date"]).dt.strftime("%Y-%m-%d")
    f["expiry"] = pd.to_datetime(f["expiry"]).dt.strftime("%Y-%m-%d")
    # float32 in the bhavcopy parquet: back to the exchange's 2-decimal prices.
    for c in ("strike", "open", "high", "low", "close", "settle", "undl"):
        f[c] = pd.to_numeric(f[c], errors="coerce").astype("float64").round(2)
    for c in ("contracts", "oi", "chg_oi"):
        f[c] = pd.to_numeric(f[c], errors="coerce").fillna(0).astype("int64").clip(-2**31 + 1, 2**31 - 1)
    return f[FO_COLUMNS]


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--only", default="research1m,daily,yahoo,futcont,foeod")
    ap.add_argument("--dry-run", action="store_true", help="count rows and estimate sizes; write nothing")
    a = ap.parse_args(argv)
    only = set(a.only.split(","))
    os.makedirs(a.out, exist_ok=True)
    stats: dict = {}
    bars = ChunkWriter(a.out, "bars", "bars", BAR_COLUMNS, a.dry_run)
    fo = ChunkWriter(a.out, "fo", "fo-eod", FO_COLUMNS, a.dry_run)
    if "research1m" in only:
        build_research_1m(bars, stats)
    if "daily" in only:
        build_daily(bars, stats)
    if "yahoo" in only:
        build_yahoo(bars, stats)
    fut = build_fut_continuous(bars, stats) if ({"futcont", "foeod"} & only) else None
    fo_counts = build_fo_eod(fo, fut) if "foeod" in only else {}
    bars.flush()
    fo.flush()

    by_group: dict = {}
    for st in stats.values():
        g = "yahoo-1d" if st.source == "yahoo" else f"{st.symbol}-{st.interval}"
        by_group[g] = by_group.get(g, 0) + st.rows
    manifest = {
        "generated": pd.Timestamp.now(tz="UTC").isoformat(),
        "datasets": [st.__dict__ for st in stats.values()],
        "bars": {"rows": bars.rows, "files": bars.files, "gz_bytes": bars.gz_bytes,
                 "est_pg_bytes": bars.rows * BYTES_PER_BAR_ROW},
        "fo_eod": {"rows": fo.rows, "files": fo.files, "gz_bytes": fo.gz_bytes,
                   "est_pg_bytes": fo.rows * BYTES_PER_FO_ROW, "counts": fo_counts},
        "est_pg_mb_by_group": {k: round(v * BYTES_PER_BAR_ROW / 1e6, 1) for k, v in sorted(by_group.items())},
    }
    manifest["est_pg_mb_total"] = round((manifest["bars"]["est_pg_bytes"] + manifest["fo_eod"]["est_pg_bytes"]) / 1e6, 1)
    if not a.dry_run:
        with open(os.path.join(a.out, "manifest.json"), "w", encoding="utf-8") as fh:
            json.dump(manifest, fh, indent=1)
    print(json.dumps({k: manifest[k] for k in ("est_pg_mb_by_group", "est_pg_mb_total")}, indent=1))
    print(f"bars {bars.rows} rows / {bars.gz_bytes / 1e6:.1f} MB gz; fo_eod {fo.rows} rows / {fo.gz_bytes / 1e6:.1f} MB gz")
    return 0


if __name__ == "__main__":
    sys.exit(main())
