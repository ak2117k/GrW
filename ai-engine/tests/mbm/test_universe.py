import copy
import json
import re
from datetime import date
from pathlib import Path

import pytest

from src.mbm.scrip_master import list_futures, load_master, resolve_equity, resolve_index
from src.mbm.universe import load_universe, resolve_series

FIX = Path(__file__).parent.parent / "fixtures" / "mbm" / "scrip_master_mini.json"
TODAY = date(2026, 10, 18)


def master():
    return json.loads(FIX.read_text())


def test_resolve_nifty_universe():
    specs = resolve_series(load_universe(), "NIFTY", master(), TODAY)
    ids = [s.id for s in specs]
    assert ids == [
        "NIFTY", "BANKNIFTY", "INDIAVIX",
        "EQ_RELIANCE", "EQ_HDFCBANK", "EQ_ICICIBANK", "EQ_INFY", "EQ_TCS", "EQ_BHARTIARTL", "EQ_LT", "EQ_ITC",
        "FUT_NIFTY_20261027", "FUT_NIFTY_20261124", "FUT_NIFTY_20261229",
        "FUT_USDINR_20261028", "FUT_USDINR_20261126",
        "YF_ES_F", "YF_NQ_F", "YF_CL_F", "YF_BZ_F", "YF_DX_Y_NYB", "YF__TNX", "YF_INR_X",
    ]
    groups = {s.group for s in specs}
    assert groups == {"primary", "banknifty", "vix", "heavyweights", "futures", "usdinr", "global"}
    by = {s.id: s for s in specs}
    assert by["INDIAVIX"].token == "99926017" and by["EQ_RELIANCE"].token == "2885"
    assert by["FUT_NIFTY_20261027"].exchange == "NFO" and by["FUT_USDINR_20261028"].exchange == "CDS"
    assert by["YF__TNX"].source == "yahoo" and by["YF__TNX"].symbol == "^TNX"
    assert not any("CRUDEOIL" in i for i in ids)


def test_expired_contracts_excluded():
    specs = resolve_series(load_universe(), "NIFTY", master(), TODAY)
    assert "FUT_NIFTY_20260929" not in [s.id for s in specs]
    assert [c.token for c in list_futures(master(), "NIFTY", "NFO", "FUTIDX")] == ["2000", "2001", "2002", "2003"]


def test_resolve_equity_ambiguous_raises():
    m = master()
    m.append(copy.deepcopy(next(r for r in m if r["symbol"] == "RELIANCE-EQ")))
    with pytest.raises(LookupError):
        resolve_equity(m, "RELIANCE")
    with pytest.raises(LookupError):
        resolve_equity(master(), "NOPE")
    assert resolve_index(master(), "india vix") == "99926017"


def test_master_snapshot_reused(tmp_path):
    calls = []

    def fetch():
        calls.append(1)
        return master()

    assert len(load_master(tmp_path, TODAY, fetch=fetch)) == len(master())
    load_master(tmp_path, TODAY, fetch=fetch)
    assert len(calls) == 1
    load_master(tmp_path, date(2026, 10, 19), fetch=fetch)
    assert len(calls) == 2
    assert len(list((tmp_path / "scrip_master").glob("*.json.gz"))) == 2


def test_series_ids_store_safe():
    for s in resolve_series(load_universe(), "NIFTY", master(), TODAY):
        assert re.match(r"^[A-Z0-9_-]+$", s.id), s.id
