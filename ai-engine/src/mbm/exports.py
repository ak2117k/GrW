"""PC side of the nightly prod export (scripts/ops/mbm-export.sh).

pull_exports copies new `<table>/<table>-<YYYY-MM-DD>.csv.gz` files from the VPS over
ssh/scp (BatchMode, the owner's existing root key). The raw files on the PC are kept
forever: the VPS keeps only 30 days, so the PC is the archive.

import_exports folds every raw file into `<root>/exports/<table>/<YYYY-MM>.parquet`
(month = the file's IST session date), `*_utc` columns parsed as UTC, deduped on `id`.
"""
from __future__ import annotations

import gzip
import os
import re
import subprocess
from pathlib import Path
from typing import Callable

import pandas as pd

REMOTE_DIR = "/opt/grw/exports"
FILE_RE = re.compile(r"^(?P<table>[a-z_]+)-(?P<day>\d{4}-\d{2}-\d{2})\.csv\.gz$")

# Explicit dtypes keep month files schema-stable whatever a given day's values look like.
INT_COLS = {"oi", "oi_change", "volume", "strike_count"}
FLOAT_COLS = {"strike", "spot_price", "call_wall", "put_wall", "call_wall_oi", "put_wall_oi"}


def _ssh_opts(ssh_key: Path) -> list[str]:
    return ["-i", str(ssh_key), "-o", "BatchMode=yes"]


def pull_exports(vps: str, ssh_key: Path, raw_dir: Path,
                 run: Callable[..., subprocess.CompletedProcess] = subprocess.run) -> list[Path]:
    """Copy export files not yet in raw_dir/<table>/. Returns the new local paths."""
    listing = run(["ssh", *_ssh_opts(ssh_key), vps, f"find {REMOTE_DIR} -name '*.csv.gz'"],
                  capture_output=True, text=True, check=True)
    pulled: list[Path] = []
    for line in sorted(listing.stdout.splitlines()):
        remote = line.strip()
        m = FILE_RE.match(remote.rsplit("/", 1)[-1]) if remote else None
        if not m:
            continue  # *.partial or anything unexpected
        dest = raw_dir / m["table"] / remote.rsplit("/", 1)[-1]
        if dest.exists():
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        part = dest.with_name(dest.name + ".part")
        run(["scp", *_ssh_opts(ssh_key), f"{vps}:{remote}", str(part)],
            capture_output=True, text=True, check=True)
        try:
            with gzip.open(part, "rb") as f:
                while f.read(1 << 20):
                    pass
        except Exception as exc:  # corrupt or truncated transfer
            part.unlink(missing_ok=True)
            raise RuntimeError(f"corrupt export download: {dest.name}: {exc}") from exc
        os.replace(part, dest)
        pulled.append(dest)
    return pulled


def _read_export(path: Path) -> pd.DataFrame:
    df = pd.read_csv(path, dtype=str, keep_default_na=False, na_values=[""])
    for c in df.columns:
        if c.endswith("_utc"):
            df[c] = pd.to_datetime(df[c], format="ISO8601").dt.tz_localize("UTC")
        elif c in INT_COLS:
            df[c] = pd.to_numeric(df[c]).astype("Int64")
        elif c in FLOAT_COLS:
            df[c] = pd.to_numeric(df[c]).astype("float64")
    return df


def import_exports(raw_dir: Path, root: Path) -> dict[str, int]:
    """Import every raw export into the parquet store. Returns rows added per table."""
    added: dict[str, int] = {}
    groups: dict[tuple[str, str], list[Path]] = {}
    for p in sorted(raw_dir.glob("*/*.csv.gz")):
        m = FILE_RE.match(p.name)
        if m:
            groups.setdefault((m["table"], m["day"][:7]), []).append(p)
    for (table, month), paths in groups.items():
        added.setdefault(table, 0)
        frames = [f for f in (_read_export(p) for p in paths) if len(f)]
        if not frames:
            continue
        new = pd.concat(frames, ignore_index=True)
        out = root / "exports" / table / f"{month}.parquet"
        if out.exists():
            old = pd.read_parquet(out)
            merged = pd.concat([old, new], ignore_index=True).drop_duplicates("id", keep="first")
            n = len(merged) - len(old)
        else:
            merged = new.drop_duplicates("id", keep="first")
            n = len(merged)
        if n:
            out.parent.mkdir(parents=True, exist_ok=True)
            tmp = out.with_name(out.name + ".tmp")
            merged.reset_index(drop=True).to_parquet(tmp, index=False)
            os.replace(tmp, out)
        added[table] += n
    return added
