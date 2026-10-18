import json
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import pandas as pd

from src.mbm import backfill
from src.mbm.angel import FetchResult
from src.mbm.store import empty_bars, load_manifest, read_bars, row_count
from src.mbm.yahoo import YAHOO_INTERVALS

IST = ZoneInfo("Asia/Kolkata")
SAT = datetime(2026, 10, 17, 10, 0, tzinfo=IST)
FIX = Path(__file__).parent.parent / "fixtures" / "mbm" / "scrip_master_mini.json"
FIRST = date(2026, 9, 1)


def universe(usdinr=False):
    d = {"heavyweights": {"equities": ["TCS"]},
         "banknifty": {"id": "BANKNIFTY", "exchange": "NSE", "token": "99926009"},
         "vix": {"id": "INDIAVIX", "index_name": "India VIX"},
         "usdinr": {"futures": {"name": "USDINR", "exch_seg": "CDS", "instrumenttype": "FUTCUR"},
                    "fallback_yahoo": "INR=X"},
         "global": {"yahoo": ["INR=X"] if usdinr else ["ES=F"]}}
    return {"NIFTY": {"primary": {"id": "NIFTY", "exchange": "NSE", "token": "99926000"},
                      "futures": [], "drivers": d}}


class FakeAngel:
    def __init__(self, fail_window=None, raise_token=None, empty_tokens=()):
        self.calls = []
        self.logins = 0
        self.fail_window = fail_window
        self.raise_token = raise_token
        self.empty_tokens = set(empty_tokens)

    def login(self):
        self.logins += 1

    def candles(self, exchange, token, interval, start, end):
        self.calls.append((token, start, end))
        if token == self.raise_token:
            raise RuntimeError("boom")
        if self.fail_window and start == self.fail_window:
            return FetchResult(empty_bars(), [(start, end, "AB2001 fail")], 4)
        rows = []
        d = max(start, FIRST)
        while d <= end and token not in self.empty_tokens:
            if d.weekday() < 5:
                for hh, mm in ((9, 15), (15, 29)):
                    rows.append(pd.Timestamp(datetime(d.year, d.month, d.day, hh, mm, tzinfo=IST)))
            d += timedelta(days=1)
        df = pd.DataFrame({"ts": pd.to_datetime(rows, utc=True) if rows else pd.to_datetime([], utc=True),
                           "open": 1.0, "high": 2.0, "low": 0.5, "close": 1.5,
                           "volume": 10, "oi": pd.NA})
        return FetchResult(df, [], 1)


def yahoo_get(url, params):
    t0, t1 = params["period1"], params["period2"]
    ts = [t for t in range(t0 - t0 % 86400 + 50400, t1, 86400) if t >= t0][-60:]
    return {"chart": {"result": [{"timestamp": ts, "indicators": {"quote": [{
        "open": [1.0] * len(ts), "high": [2.0] * len(ts), "low": [0.5] * len(ts),
        "close": [1.5] * len(ts), "volume": [5] * len(ts)}]}}], "error": None}}


def run(tmp_path, angel, now=SAT, uni=None, allow=False, vps=None, **kw):
    master = json.loads(FIX.read_text())
    return backfill.build(tmp_path, tmp_path / "none.env", "NIFTY", now, allow, vps, None,
                          angel_factory=lambda: angel, yahoo_get=yahoo_get,
                          master_fetch=lambda: master, universe=uni or universe(),
                          yahoo_sleep=lambda s: None, **kw)


def test_build_fresh_store(tmp_path, capsys):
    rc = run(tmp_path, FakeAngel())
    assert rc == 0
    for sid in ("NIFTY", "BANKNIFTY", "INDIAVIX", "EQ_TCS"):
        assert row_count(tmp_path, sid, "1m") > 0 and row_count(tmp_path, sid, "1d") > 0
    for iv in YAHOO_INTERVALS:
        assert row_count(tmp_path, "YF_ES_F", iv) > 0
    m = load_manifest(tmp_path)["NIFTY"]["1m"]
    assert m["rows"] > 0 and m["first"].startswith("2026-09-01") and m["last"].startswith("2026-10-16")
    assert m["depth_earliest"] == "2026-09-01"


def test_build_resumes_from_last_ts(tmp_path):
    run(tmp_path, FakeAngel())
    rows = row_count(tmp_path, "NIFTY", "1m")
    a2 = FakeAngel()
    assert run(tmp_path, a2, now=datetime(2026, 10, 19, 20, 0, tzinfo=IST)) == 0  # Monday evening
    assert all(start > date(2026, 10, 16) for _, start, _ in a2.calls)
    assert row_count(tmp_path, "NIFTY", "1m") == rows + 2  # Monday 10-19 added once
    df = read_bars(tmp_path, "NIFTY", "1m")
    assert df["ts"].is_unique


def test_failed_chunk_retried_next_run(tmp_path):
    run(tmp_path, FakeAngel())  # seeds depth + data up to 10-16
    a1 = FakeAngel(fail_window=date(2026, 10, 17))
    rc1 = run(tmp_path, a1, now=datetime(2026, 10, 24, 10, 0, tzinfo=IST))
    assert rc1 == 1
    fc = load_manifest(tmp_path)["NIFTY"]["1m"]["failed_chunks"]
    assert fc and fc[0][0] == "2026-10-17"
    a2 = FakeAngel()
    rc2 = run(tmp_path, a2, now=datetime(2026, 10, 24, 11, 0, tzinfo=IST))
    assert rc2 == 0
    assert ("99926000", date(2026, 10, 17), date(2026, 10, 23)) in a2.calls
    assert load_manifest(tmp_path)["NIFTY"]["1m"]["failed_chunks"] == []
    assert row_count(tmp_path, "NIFTY", "1m") == len(read_bars(tmp_path, "NIFTY", "1m"))


def test_one_series_failure_isolated(tmp_path, capsys):
    rc = run(tmp_path, FakeAngel(raise_token="11536"))
    assert rc == 1
    assert row_count(tmp_path, "NIFTY", "1m") > 0 and row_count(tmp_path, "YF_ES_F", "1d") > 0
    out = capsys.readouterr().out
    assert "EQ_TCS" in out and "boom" in out


def test_build_refuses_market_hours(tmp_path):
    a = FakeAngel()
    assert run(tmp_path, a, now=datetime(2026, 10, 14, 11, 0, tzinfo=IST)) == 2
    assert a.logins == 0


def test_usdinr_falls_back_when_no_angel_history(tmp_path):
    a = FakeAngel(empty_tokens={"3001", "3002"})
    rc = run(tmp_path, a, uni=universe(usdinr=True))
    assert rc == 0
    out = backfill.LAST_OUTCOMES
    usd = [o for o in out if o.series_id.startswith("FUT_USDINR")]
    assert usd and all("Yahoo INR=X" in o.skipped_reason for o in usd)
    assert row_count(tmp_path, "YF_INR_X", "1d") > 0


def test_build_without_vps_warns(tmp_path, capsys):
    assert run(tmp_path, FakeAngel()) == 0
    assert "--vps" in capsys.readouterr().out


def test_build_with_vps_pulls_and_imports(tmp_path):
    seen = {}

    def pull(vps, key, raw):
        seen["pull"] = (vps, raw)
        return []

    assert run(tmp_path, FakeAngel(), vps="root@h", pull=pull) == 0
    assert seen["pull"][0] == "root@h"
