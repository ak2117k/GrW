import gzip
import subprocess
from pathlib import Path

import pandas as pd
import pytest

from src.mbm.exports import import_exports, pull_exports

OI_CSV = (
    "id,ts_utc,symbol,exchange,token,segment,expiry_utc,strike,option_type,oi,oi_change,volume\n"
    "a1,2026-10-19 04:00:00,NIFTY27OCT2625000CE,NFO,111,NFO,2026-10-27 00:00:00,25000,CE,100,5,7\n"
    "a2,2026-10-19 04:01:00.5,NIFTY27OCT2625000PE,NFO,112,NFO,2026-10-27 00:00:00,25000,PE,90,,3\n"
)
CHAIN_CSV = (
    "id,captured_at_utc,underlying,expiry_date,spot_price,source,strike_count,chain_json\n"
    'c1,2026-10-19 05:00:00,NIFTY,2026-10-27,25010.5,NSE,2,"[{""strike"": 25000}]"\n'
)


def _write_gz(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(path, "wt", encoding="utf-8") as f:
        f.write(text)


def _raw(tmp_path: Path) -> Path:
    raw = tmp_path / "raw"
    _write_gz(raw / "oi_snapshots" / "oi_snapshots-2026-10-19.csv.gz", OI_CSV)
    _write_gz(raw / "option_chain_snapshots" / "option_chain_snapshots-2026-10-19.csv.gz", CHAIN_CSV)
    return raw


class FakeRun:
    def __init__(self, listing: list[str], payload: bytes | None = None):
        self.listing = listing
        self.payload = payload
        self.calls: list[list[str]] = []

    def __call__(self, args, **kw):
        self.calls.append(list(args))
        if args[0] == "ssh":
            return subprocess.CompletedProcess(args, 0, stdout="\n".join(self.listing) + "\n", stderr="")
        if args[0] == "scp":
            dest = Path(args[-1])
            data = self.payload if self.payload is not None else gzip.compress(b"id\n1\n")
            dest.write_bytes(data)
            return subprocess.CompletedProcess(args, 0, stdout="", stderr="")
        raise AssertionError(args)


def test_pull_skips_existing_and_partials(tmp_path):
    raw = tmp_path / "raw"
    _write_gz(raw / "oi_snapshots" / "oi_snapshots-2026-10-18.csv.gz", "id\n")
    run = FakeRun([
        "/opt/grw/exports/oi_snapshots/oi_snapshots-2026-10-18.csv.gz",
        "/opt/grw/exports/oi_snapshots/oi_snapshots-2026-10-19.csv.gz",
        "/opt/grw/exports/option_chain_snapshots/option_chain_snapshots-2026-10-19.csv.gz",
        "/opt/grw/exports/oi_wall_snapshots/oi_wall_snapshots-2026-10-19.csv.gz.partial",
    ])
    key = tmp_path / "key"
    got = pull_exports("root@vps", key, raw, run=run)
    scps = [c for c in run.calls if c[0] == "scp"]
    assert len(scps) == 2
    for c in run.calls:
        assert "BatchMode=yes" in c and str(key) in c
    assert sorted(p.name for p in got) == [
        "oi_snapshots-2026-10-19.csv.gz", "option_chain_snapshots-2026-10-19.csv.gz"]
    assert all(p.exists() for p in got)
    assert not list(raw.rglob("*.part"))


def test_pull_rejects_corrupt_gzip(tmp_path):
    raw = tmp_path / "raw"
    run = FakeRun(["/opt/grw/exports/oi_snapshots/oi_snapshots-2026-10-19.csv.gz"], payload=b"garbage")
    with pytest.raises(RuntimeError, match="oi_snapshots-2026-10-19.csv.gz"):
        pull_exports("root@vps", tmp_path / "key", raw, run=run)
    assert not (raw / "oi_snapshots" / "oi_snapshots-2026-10-19.csv.gz").exists()
    assert not list(raw.rglob("*.part"))


def test_import_parses_utc(tmp_path):
    raw = _raw(tmp_path)
    root = tmp_path / "store"
    added = import_exports(raw, root)
    assert added == {"oi_snapshots": 2, "option_chain_snapshots": 1}
    df = pd.read_parquet(root / "exports" / "oi_snapshots" / "2026-10.parquet")
    assert df.loc[df.id == "a1", "ts_utc"].iloc[0] == pd.Timestamp("2026-10-19T04:00Z")
    assert str(df["ts_utc"].dtype) == "datetime64[ns, UTC]"
    ch = pd.read_parquet(root / "exports" / "option_chain_snapshots" / "2026-10.parquet")
    assert ch["chain_json"].iloc[0] == '[{"strike": 25000}]'


def test_import_idempotent(tmp_path):
    raw = _raw(tmp_path)
    root = tmp_path / "store"
    assert sum(import_exports(raw, root).values()) == 3
    assert sum(import_exports(raw, root).values()) == 0
    df = pd.read_parquet(root / "exports" / "oi_snapshots" / "2026-10.parquet")
    assert len(df) == 2


def test_import_skips_header_only_files(tmp_path):
    raw = tmp_path / "raw"
    _write_gz(raw / "oi_wall_snapshots" / "oi_wall_snapshots-2026-10-18.csv.gz",
              "id,captured_at_utc,symbol,expiry,call_wall,put_wall,call_wall_oi,put_wall_oi\n")
    assert import_exports(raw, tmp_path / "store") == {"oi_wall_snapshots": 0}
