"""Angel scrip master: dated snapshots + token / contract lookup.

Dated snapshots (<meta>/scrip_master/<YYYY-MM-DD>.json.gz) are kept forever: they are
the grow-forward record of contract tokens that expire out of the live master.
"""
from __future__ import annotations

import gzip
import json
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path
from typing import Callable

SCRIP_MASTER_URL = "https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json"


def _fetch_master() -> list[dict]:
    import httpx
    r = httpx.get(SCRIP_MASTER_URL, timeout=60)
    r.raise_for_status()
    return r.json()


def snapshot_dir(meta_dir: Path) -> Path:
    return Path(meta_dir) / "scrip_master"


def load_master(meta_dir: Path, today: date, fetch: Callable[[], list[dict]] | None = None) -> list[dict]:
    path = snapshot_dir(meta_dir) / f"{today:%Y-%m-%d}.json.gz"
    if path.exists():
        with gzip.open(path, "rt", encoding="utf-8") as f:
            return json.load(f)
    rows = (fetch or _fetch_master)()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    with gzip.open(tmp, "wt", encoding="utf-8") as f:
        json.dump(rows, f)
    tmp.replace(path)
    return rows


def load_snapshot(path: Path) -> list[dict]:
    with gzip.open(path, "rt", encoding="utf-8") as f:
        return json.load(f)


def _one(rows: list[dict], what: str) -> str:
    if len(rows) != 1:
        raise LookupError(f"{what}: {len(rows)} matches in scrip master")
    return str(rows[0]["token"])


def resolve_equity(master: list[dict], symbol: str) -> str:
    return _one([r for r in master if r.get("symbol") == f"{symbol}-EQ" and r.get("exch_seg") == "NSE"],
                f"equity {symbol}")


def resolve_index(master: list[dict], name: str) -> str:
    n = name.lower()
    return _one([r for r in master if r.get("exch_seg") == "NSE" and r.get("instrumenttype") == "AMXIDX"
                 and (str(r.get("name", "")).lower() == n or str(r.get("symbol", "")).lower() == n)],
                f"index {name}")


@dataclass(frozen=True)
class Contract:
    token: str
    symbol: str
    exch_seg: str
    expiry: date


def parse_expiry(s: str) -> date | None:
    try:
        return datetime.strptime(s.strip().upper(), "%d%b%Y").date()
    except (ValueError, AttributeError):
        return None


def list_futures(master: list[dict], name: str, exch_seg: str, instrumenttype: str) -> list[Contract]:
    out = {}
    for r in master:
        if r.get("name") == name and r.get("exch_seg") == exch_seg and r.get("instrumenttype") == instrumenttype:
            exp = parse_expiry(str(r.get("expiry", "")))
            if exp:
                out[str(r["token"])] = Contract(str(r["token"]), str(r["symbol"]), exch_seg, exp)
    return sorted(out.values(), key=lambda c: (c.expiry, c.token))
