import pandas as pd
import pytest

from src.mbm import store
from src.mbm.store import (BAR_COLUMNS, derive_daily, last_ts, load_manifest, read_bars,
                           update_manifest, write_bars)


def bars(ts_list, close=None):
    n = len(ts_list)
    close = close or [float(i + 1) for i in range(n)]
    return pd.DataFrame({
        "ts": pd.to_datetime(ts_list, utc=True),
        "open": close, "high": [c + 1 for c in close], "low": [c - 1 for c in close], "close": close,
        "volume": pd.array([10] * n, dtype="Int64"), "oi": pd.array([pd.NA] * n, dtype="Int64"),
    })


TS3 = ["2026-10-16T03:45Z", "2026-10-16T03:46Z", "2026-10-16T03:47Z"]


def test_write_then_read_roundtrip(tmp_path):
    assert write_bars(tmp_path, "NIFTY", "1m", bars(TS3)) == 3
    df = read_bars(tmp_path, "NIFTY", "1m")
    assert list(df.columns) == BAR_COLUMNS
    assert len(df) == 3
    assert str(df["ts"].dtype) == "datetime64[ns, UTC]"
    for c in ("open", "high", "low", "close"):
        assert df[c].dtype == "float64"
    assert str(df["volume"].dtype) == "Int64" and str(df["oi"].dtype) == "Int64"


def test_write_bars_idempotent(tmp_path):
    assert write_bars(tmp_path, "NIFTY", "1m", bars(TS3)) == 3
    assert write_bars(tmp_path, "NIFTY", "1m", bars(TS3)) == 0
    assert len(pd.read_parquet(tmp_path / "bars" / "1m" / "NIFTY" / "2026-10.parquet")) == 3


def test_new_row_wins(tmp_path):
    write_bars(tmp_path, "NIFTY", "1m", bars(TS3))
    write_bars(tmp_path, "NIFTY", "1m", bars(TS3[:1], close=[99.0]))
    assert read_bars(tmp_path, "NIFTY", "1m")["close"].iloc[0] == 99.0


def test_month_partition_uses_ist(tmp_path):
    write_bars(tmp_path, "NIFTY", "1m", bars(["2026-09-30T19:00Z"]))
    assert (tmp_path / "bars" / "1m" / "NIFTY" / "2026-10.parquet").exists()
    assert not (tmp_path / "bars" / "1m" / "NIFTY" / "2026-09.parquet").exists()


def test_bad_series_id_rejected(tmp_path):
    with pytest.raises(ValueError):
        write_bars(tmp_path, "NSE:NIFTY", "1m", bars(TS3))


def test_missing_columns_rejected(tmp_path):
    with pytest.raises(ValueError):
        write_bars(tmp_path, "NIFTY", "1m", bars(TS3).drop(columns=["close"]))


def test_last_ts(tmp_path):
    assert last_ts(tmp_path, "NIFTY", "1m") is None
    write_bars(tmp_path, "NIFTY", "1m", bars(["2026-09-10T04:00Z", "2026-10-02T04:00Z"]))
    assert last_ts(tmp_path, "NIFTY", "1m") == pd.Timestamp("2026-10-02T04:00Z")


def test_read_range(tmp_path):
    write_bars(tmp_path, "NIFTY", "1m", bars(TS3))
    df = read_bars(tmp_path, "NIFTY", "1m", start=pd.Timestamp("2026-10-16T03:46Z"))
    assert len(df) == 2
    assert read_bars(tmp_path, "X", "1m").empty


def test_derive_daily_ist_session(tmp_path):
    day = pd.date_range("2026-10-16 09:15", "2026-10-16 15:29", freq="1min", tz="Asia/Kolkata")
    ts = list(day) + [pd.Timestamp("2026-10-16 15:45", tz="Asia/Kolkata")]
    close = [float(i) for i in range(len(ts))]
    df = bars([t.tz_convert("UTC") for t in ts], close=close)
    d = derive_daily(df)
    assert len(d) == 1
    assert d["close"].iloc[0] == close[-2]
    assert d["open"].iloc[0] == 0.0
    assert d["volume"].iloc[0] == 10 * len(day)
    assert d["ts"].iloc[0] == pd.Timestamp("2026-10-16 09:15", tz="Asia/Kolkata").tz_convert("UTC")


def test_manifest_merge(tmp_path):
    update_manifest(tmp_path, "NIFTY", "1m", rows=5)
    update_manifest(tmp_path, "NIFTY", "1m", source="angel")
    m = load_manifest(tmp_path)["NIFTY"]["1m"]
    assert m["rows"] == 5 and m["source"] == "angel" and "updated" in m
