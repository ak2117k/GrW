import json
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd
import pytest

from src.mbm.yahoo import YahooError, fetch_history, parse_chart

FIX = Path(__file__).parent.parent / "fixtures" / "mbm" / "yahoo_chart_es.json"


def payload():
    return json.loads(FIX.read_text())


def test_parse_fixture():
    df = parse_chart(payload())
    assert len(df) == 2
    assert df["ts"].iloc[0] == pd.Timestamp(1760918400, unit="s", tz="UTC")
    assert df["close"].iloc[1] == 6702.0
    assert df["oi"].isna().all()


def test_error_payload_raises():
    with pytest.raises(YahooError, match="No data found"):
        parse_chart({"chart": {"result": None, "error": {"code": "Not Found", "description": "No data found, symbol may be delisted"}}})


def test_1m_chunks_7_days():
    calls, sleeps = [], []

    def get(url, params):
        calls.append(params)
        return payload()

    start = datetime(2026, 10, 1, tzinfo=timezone.utc)
    end = datetime(2026, 10, 21, tzinfo=timezone.utc)
    r = fetch_history("ES=F", "1m", start, end, get=get, sleep=sleeps.append)
    assert len(calls) == 3 and r.calls == 3 and r.failed == []
    assert calls[0]["interval"] == "1m" and calls[0]["includePrePost"] == "false"
    assert calls[0]["period1"] == int(start.timestamp()) and calls[-1]["period2"] == int(end.timestamp())
    assert len(r.df) == 2  # same fixture each chunk, deduped on ts
    assert all(s == 1 for s in sleeps)


def test_failed_chunk_listed():
    n = {"i": 0}

    def get(url, params):
        n["i"] += 1
        if params["period1"] == int(datetime(2026, 10, 8, tzinfo=timezone.utc).timestamp()):
            raise RuntimeError("http 429")
        return payload()

    r = fetch_history("ES=F", "1m", datetime(2026, 10, 1, tzinfo=timezone.utc),
                      datetime(2026, 10, 21, tzinfo=timezone.utc), get=get, sleep=lambda s: None)
    assert len(r.failed) == 1
    assert r.failed[0][0].isoformat() == "2026-10-08" and "429" in r.failed[0][2]
    assert r.calls == 5  # 1 + 3 tries + 1
