import gzip
import json
from datetime import date, timedelta

import pandas as pd

from src.mbm.angel import FetchResult
from src.mbm.probe import (DepthResult, ExpiredResult, expired_candidates, probe_depth,
                           probe_expired, write_probe_report)
from src.mbm.scrip_master import Contract
from src.mbm.store import empty_bars, load_manifest

TODAY = date(2026, 10, 18)


def since(first: date):
    calls = []

    def has(d):
        calls.append(d)
        return d + timedelta(days=5) > first
    return has, calls


def test_depth_finds_first_month():
    has, calls = since(date(2023, 7, 1))
    r = probe_depth("NIFTY", "1m", has, TODAY)
    assert r.status == "ok" and r.earliest == date(2023, 7, 1)
    assert len(calls) <= 12 and r.calls == len(calls)


def test_depth_mid_month_start_rounds_to_month():
    has, _ = since(date(2024, 3, 20))
    # month precision: the first month whose opening window has data
    assert probe_depth("NIFTY", "1m", has, TODAY).earliest == date(2024, 4, 1)


def test_depth_none_when_no_data():
    r = probe_depth("X", "1m", lambda d: False, TODAY)
    assert r.status == "none" and r.earliest is None


def test_probe_error_is_unknown_not_empty():
    def has(d):
        return None if d == date(2023, 10, 18) else True
    r = probe_depth("NIFTY", "1m", has, TODAY)
    assert r.status == "unknown"
    assert "2024-10-18" in r.note


def test_depth_capped_at_max_years():
    r = probe_depth("NIFTY", "1m", lambda d: True, TODAY, max_years=3)
    assert r.status == "ok" and r.earliest == date(2023, 10, 1) and "capped" in r.note


class FakeClient:
    def candles(self, exchange, token, interval, start, end):
        if token == "1":
            return FetchResult(pd.DataFrame({"ts": [1, 2]}), [], 1)
        if token == "2":
            return FetchResult(empty_bars(), [], 1)
        return FetchResult(empty_bars(), [(start, end, "AB2001 boom")], 4)


def test_expired_classification():
    cs = [Contract(t, f"S{t}", "NFO", date(2026, 9, 29)) for t in ("1", "2", "3")]
    r = probe_expired(FakeClient(), cs)
    assert [x.status for x in r] == ["served", "empty", "error"]
    assert r[0].bars == 2 and "boom" in r[2].message


def test_candidates_from_old_snapshot_and_csv(tmp_path):
    snap = tmp_path / "scrip_master"
    snap.mkdir()
    rows = [{"token": str(10 + i), "symbol": f"NIFTY{e[:5]}{e[7:]}FUT", "name": "NIFTY", "expiry": e,
             "exch_seg": "NFO", "instrumenttype": "FUTIDX"}
            for i, e in enumerate(["26MAY2026", "30JUN2026", "28JUL2026", "25AUG2026", "27OCT2026"])]
    with gzip.open(snap / "2026-08-01.json.gz", "wt") as f:
        json.dump(rows, f)
    csv = tmp_path / "x.csv"
    csv.write_text("symbol,token,exch_seg,expiry\nNIFTY29SEP26FUT,99,NFO,2026-09-29\n"
                   "NIFTY25AUG26FUT,13,NFO,2026-08-25\nCRUDEOIL18SEP26FUT,77,MCX,2026-09-18\n")
    got = expired_candidates(tmp_path, ["NIFTY", "CRUDEOIL"], TODAY, extra_csv=csv)
    nifty = [c for c in got if c.symbol.startswith("NIFTY")]
    assert [c.token for c in nifty] == ["99", "13", "12"]  # newest 3, deduped on token
    assert [c.token for c in got if c.symbol.startswith("CRUDEOIL")] == ["77"]


def test_report_files_written(tmp_path):
    depth = [DepthResult("NIFTY", "1m", date(2024, 10, 1), "ok", 8),
             DepthResult("EQ_TCS", "1m", None, "unknown", 2, "last confirmed 2025-10-18")]
    exp = [ExpiredResult("NIFTY29SEP26FUT", "NFO", date(2026, 9, 29), "99", 3000, "served")]
    p = write_probe_report(tmp_path, depth, exp, TODAY)
    md = p.read_text()
    assert p.name == "probes-2026-10-18.md" and (tmp_path / "probes-2026-10-18.json").exists()
    for s in ("NIFTY", "EQ_TCS", "NIFTY29SEP26FUT"):
        assert s in md
    assert load_manifest(tmp_path.parent)["NIFTY"]["1m"]["depth_earliest"] == "2024-10-01"
