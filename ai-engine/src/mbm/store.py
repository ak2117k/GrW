"""Parquet bar store for the Market Behaviour Model training data.

Layout: <root>/bars/<interval>/<series_id>/<YYYY-MM>.parquet (month = IST calendar
month of the bar), plus <root>/_meta/manifest.json. The store lives outside the repo
(default ~/grw-mbm) and is never committed.
"""
from __future__ import annotations

import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

BAR_COLUMNS: list[str] = ["ts", "open", "high", "low", "close", "volume", "oi"]
SERIES_ID_RE = re.compile(r"^[A-Z0-9_-]+$")
IST = "Asia/Kolkata"


def default_root() -> Path:
    return Path(os.environ.get("MBM_STORE") or (Path.home() / "grw-mbm"))


def _series_dir(root: Path, series_id: str, interval: str) -> Path:
    if not SERIES_ID_RE.match(series_id):
        raise ValueError(f"bad series id {series_id!r}")
    if not re.match(r"^[0-9a-z]+$", interval):
        raise ValueError(f"bad interval {interval!r}")
    return Path(root) / "bars" / interval / series_id


def empty_bars() -> pd.DataFrame:
    return normalize(pd.DataFrame({c: [] for c in BAR_COLUMNS}))


def normalize(df: pd.DataFrame) -> pd.DataFrame:
    missing = [c for c in BAR_COLUMNS if c not in df.columns]
    if missing:
        raise ValueError(f"missing bar columns: {missing}")
    out = df[BAR_COLUMNS].copy()
    ts = pd.to_datetime(out["ts"], utc=True)
    out["ts"] = ts.dt.tz_convert("UTC").astype("datetime64[ns, UTC]")
    for c in ("open", "high", "low", "close"):
        out[c] = pd.to_numeric(out[c]).astype("float64")
    for c in ("volume", "oi"):
        out[c] = pd.to_numeric(out[c]).astype("Int64")
    return out.sort_values("ts").drop_duplicates("ts", keep="last").reset_index(drop=True)


def _month_key(ts: pd.Series) -> pd.Series:
    return ts.dt.tz_convert(IST).dt.strftime("%Y-%m")


def write_bars(root: Path, series_id: str, interval: str, df: pd.DataFrame) -> int:
    """Merge bars into month files (new row wins on equal ts). Returns rows newly added."""
    d = _series_dir(root, series_id, interval)
    new = normalize(df)
    if new.empty:
        return 0
    added = 0
    for month, part in new.groupby(_month_key(new["ts"])):
        path = d / f"{month}.parquet"
        if path.exists():
            old = pd.read_parquet(path)
            merged = pd.concat([old, part], ignore_index=True)
            merged = merged.drop_duplicates("ts", keep="last").sort_values("ts")
            added += len(merged) - len(old)
        else:
            merged = part
            added += len(part)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + ".tmp")
        normalize(merged).to_parquet(tmp, index=False)
        os.replace(tmp, path)
    return added


def _month_files(root: Path, series_id: str, interval: str) -> list[Path]:
    d = _series_dir(root, series_id, interval)
    return sorted(d.glob("*.parquet")) if d.exists() else []


def read_bars(root: Path, series_id: str, interval: str,
              start: pd.Timestamp | None = None, end: pd.Timestamp | None = None) -> pd.DataFrame:
    files = _month_files(root, series_id, interval)
    if start is not None:
        lo = pd.Timestamp(start).tz_convert(IST).strftime("%Y-%m")
        files = [f for f in files if f.stem >= lo]
    if end is not None:
        hi = pd.Timestamp(end).tz_convert(IST).strftime("%Y-%m")
        files = [f for f in files if f.stem <= hi]
    if not files:
        return empty_bars()
    df = normalize(pd.concat([pd.read_parquet(f) for f in files], ignore_index=True))
    if start is not None:
        df = df[df["ts"] >= pd.Timestamp(start)]
    if end is not None:
        df = df[df["ts"] <= pd.Timestamp(end)]
    return df.reset_index(drop=True)


def row_count(root: Path, series_id: str, interval: str) -> int:
    import pyarrow.parquet as pq
    return sum(pq.ParquetFile(f).metadata.num_rows for f in _month_files(root, series_id, interval))


def first_ts(root: Path, series_id: str, interval: str) -> pd.Timestamp | None:
    files = _month_files(root, series_id, interval)
    return None if not files else pd.read_parquet(files[0])["ts"].min()


def last_ts(root: Path, series_id: str, interval: str) -> pd.Timestamp | None:
    files = _month_files(root, series_id, interval)
    if not files:
        return None
    ts = pd.read_parquet(files[-1], columns=["ts"])["ts"]
    return None if ts.empty else pd.Timestamp(ts.max())


def derive_daily(df_1m: pd.DataFrame) -> pd.DataFrame:
    """1m → 1d over the 09:15–15:29 IST cash session, grouped by IST date."""
    df = normalize(df_1m)
    if df.empty:
        return empty_bars()
    local = df["ts"].dt.tz_convert(IST)
    mins = local.dt.hour * 60 + local.dt.minute
    df = df[(mins >= 9 * 60 + 15) & (mins <= 15 * 60 + 29)]
    if df.empty:
        return empty_bars()
    day = df["ts"].dt.tz_convert(IST).dt.normalize()
    g = df.groupby(day)
    out = pd.DataFrame({
        "open": g["open"].first(), "high": g["high"].max(), "low": g["low"].min(),
        "close": g["close"].last(), "volume": g["volume"].sum(min_count=1), "oi": g["oi"].last(),
    })
    out["ts"] = (out.index + pd.Timedelta(hours=9, minutes=15)).tz_convert("UTC")
    return normalize(out.reset_index(drop=True))


def _manifest_path(root: Path) -> Path:
    return Path(root) / "_meta" / "manifest.json"


def load_manifest(root: Path) -> dict:
    p = _manifest_path(root)
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}


def update_manifest(root: Path, series_id: str, interval: str, **fields) -> None:
    m = load_manifest(root)
    entry = m.setdefault(series_id, {}).setdefault(interval, {})
    entry.update(fields)
    entry["updated"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    p = _manifest_path(root)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(p.name + ".tmp")
    tmp.write_text(json.dumps(m, indent=2, sort_keys=True, default=str), encoding="utf-8")
    os.replace(tmp, p)
