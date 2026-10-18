"""Resolve the per-instrument driver universe (universe.json) to concrete series."""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Literal

from .scrip_master import Contract, list_futures, resolve_equity, resolve_index

UNIVERSE_PATH = Path(__file__).with_name("universe.json")


@dataclass(frozen=True)
class SeriesSpec:
    id: str
    source: Literal["angel", "yahoo"]
    group: str
    exchange: str | None
    token: str | None
    symbol: str | None
    expiry: date | None


def load_universe(path: Path = UNIVERSE_PATH) -> dict:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def yahoo_series_id(symbol: str) -> str:
    return "YF_" + re.sub(r"[^A-Z0-9]", "_", symbol.upper())


def future_series_id(c: Contract, name: str) -> str:
    return f"FUT_{name}_{c.expiry:%Y%m%d}"


def _futures(master, f: dict, group: str, today: date) -> list[SeriesSpec]:
    return [SeriesSpec(future_series_id(c, f["name"]), "angel", group, c.exch_seg, c.token, c.symbol, c.expiry)
            for c in list_futures(master, f["name"], f["exch_seg"], f["instrumenttype"]) if c.expiry >= today]


def resolve_series(universe: dict, instrument: str, master: list[dict], today: date) -> list[SeriesSpec]:
    u = universe[instrument]
    d = u["drivers"]
    p = u["primary"]
    out = [SeriesSpec(p["id"], "angel", "primary", p["exchange"], p["token"], None, None)]
    bn = d["banknifty"]
    out.append(SeriesSpec(bn["id"], "angel", "banknifty", bn["exchange"], bn["token"], None, None))
    vix = d["vix"]
    out.append(SeriesSpec(vix["id"], "angel", "vix", "NSE", resolve_index(master, vix["index_name"]), None, None))
    for sym in d["heavyweights"]["equities"]:
        out.append(SeriesSpec(f"EQ_{sym}", "angel", "heavyweights", "NSE", resolve_equity(master, sym), f"{sym}-EQ", None))
    for f in u.get("futures", []):
        out += _futures(master, f, f.get("group", "futures"), today)
    out += _futures(master, d["usdinr"]["futures"], "usdinr", today)
    for sym in d["global"]["yahoo"]:
        out.append(SeriesSpec(yahoo_series_id(sym), "yahoo", "global", None, None, sym, None))
    return out
