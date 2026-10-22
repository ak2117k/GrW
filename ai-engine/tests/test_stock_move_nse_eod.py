"""Gap fill from NSE end-of-day files when Yahoo skips a session (2026-10-21). No network."""
from __future__ import annotations

import io
import zipfile
from datetime import date, datetime

import pandas as pd
import pytest

from src.mbm.service import clock
from src.mbm.stock_move import nse_eod as E
from src.mbm.stock_move import prices as P

CM_HEAD = ("TradDt,BizDt,Sgmt,Src,FinInstrmTp,FinInstrmId,ISIN,TckrSymb,SctySrs,XpryDt,FininstrmActlXpryDt,StrkPric,"
           "OptnTp,FinInstrmNm,OpnPric,HghPric,LwPric,ClsPric,LastPric,PrvsClsgPric,UndrlygPric,SttlmPric,OpnIntrst,"
           "ChngInOpnIntrst,TtlTradgVol,TtlTrfVal,TtlNbOfTxsExctd,SsnId,NewBrdLotQty,Rmks,Rsvd1,Rsvd2,Rsvd3,Rsvd4")
CM_ROWS = [
    "2026-10-21,2026-10-21,CM,NSE,STK,2885,INE002A01018,RELIANCE,EQ,,,,,RELIANCE INDUSTRIES LTD,1212.00,1234.30,"
    "1199.30,1209.00,1209.00,1202.00,,1208.99,,,17607823,21423587298.80,316700,F1,1,,,,,",
    "2026-10-21,2026-10-21,CM,NSE,STK,9999,INE002A01019,RELIANCE,BE,,,,,RELIANCE BE,1.00,1.00,1.00,1.00,1.00,1.00,"
    ",1.00,,,1,1.0,1,F1,1,,,,,",
]
IDX = ("Index Name,Index Date,Open Index Value,High Index Value,Low Index Value,Closing Index Value,Points Change,"
       "Change(%),Volume,Turnover (Rs. Cr.),P/E,P/B,Div Yield\n"
       "Nifty 50,21-10-2026,23016,23120.9,22649.9,22811.35,-77.6,-.34,324842141,28920.19,19.26,2.8,1.49\n"
       "India VIX,21-10-2026,14.7725,16.1725,14.1825,15.68,0.9,6.11,-,-,-,-,-\n")


def ist(s: str) -> datetime:
    return datetime.fromisoformat(s).replace(tzinfo=clock.IST)


def zipped(text: str) -> bytes:
    b = io.BytesIO()
    with zipfile.ZipFile(b, "w") as z:
        z.writestr("BhavCopy.csv", text)
    return b.getvalue()


def bars(dates, close=100.0):
    d = pd.to_datetime(dates)
    return pd.DataFrame({"date": d, "open": close, "high": close, "low": close, "close": close, "volume": 1.0})


class FakeNse:
    def __init__(self, published: dict[str, bytes]):
        self.published, self.calls = published, []

    def __call__(self, url: str):
        self.calls.append(url)
        return self.published.get(url)


YAHOO_DAYS = ["2026-10-14", "2026-10-15", "2026-10-16", "2026-10-19", "2026-10-22"]   # 10-20 holiday, 10-21 missing


def seeded(tmp_path):
    cache = P.PriceCache(tmp_path)
    for n in ("NIFTYIDX", "INDIAVIX", "RELIANCE", "NEWCO"):
        cache.write(n, bars(YAHOO_DAYS))
    cache.write("NEWCO", bars(["2026-10-22"]))          # listed after the hole: never back-filled
    return cache


def nse_for_1021():
    d = date(2026, 10, 21)
    return FakeNse({E.CM_URL.format(d=d): zipped("\n".join([CM_HEAD, *CM_ROWS]) + "\n"),
                    E.IDX_URL.format(d=d): IDX.encode()})


def test_parsers_read_the_real_nse_formats():
    cm = E.parse_cm(zipped("\n".join([CM_HEAD, *CM_ROWS]) + "\n"))
    assert cm["RELIANCE"] == {"open": 1212.0, "high": 1234.3, "low": 1199.3, "close": 1209.0, "volume": 17607823.0}
    ix = E.parse_index(IDX.encode())
    assert ix["NIFTYIDX"]["close"] == pytest.approx(22811.35) and ix["INDIAVIX"]["open"] == pytest.approx(14.7725)


def test_missing_session_is_filled_for_index_and_stocks_only(tmp_path):
    cache = seeded(tmp_path)
    nse = nse_for_1021()
    st = E.fill_gaps(cache, ["NIFTYIDX", "INDIAVIX", "RELIANCE", "NEWCO"], ist("2026-10-22T20:15"), get=nse,
                     sleep=lambda s: None)
    assert st == {"days": ["2026-10-21"], "rows": 3, "failed": []}
    n = cache.read("NIFTYIDX").set_index("date")
    assert list(n.index.strftime("%Y-%m-%d")) == sorted([*YAHOO_DAYS, "2026-10-21"])
    assert n.loc["2026-10-21", "close"] == pytest.approx(22811.35)
    assert cache.read("RELIANCE").set_index("date").loc["2026-10-21", "close"] == 1209.0
    assert len(cache.read("NEWCO")) == 1
    assert not any("20261020" in u or "20102026" in u for u in nse.calls)       # listed holiday never asked
    # second run: nothing missing any more, no requests
    nse.calls.clear()
    assert E.fill_gaps(cache, ["NIFTYIDX", "RELIANCE"], ist("2026-10-22T20:15"), get=nse, sleep=lambda s: None)["rows"] == 0
    assert nse.calls == []


def test_unpublished_or_failing_days_are_skipped_without_raising(tmp_path):
    cache = seeded(tmp_path)
    st = E.fill_gaps(cache, ["NIFTYIDX", "RELIANCE"], ist("2026-10-22T20:15"), get=FakeNse({}), sleep=lambda s: None)
    assert st["rows"] == 0 and st["failed"] == []

    def boom(url):
        raise ConnectionError("nse down")
    st = E.fill_gaps(cache, ["NIFTYIDX", "RELIANCE"], ist("2026-10-22T20:15"), get=boom, sleep=lambda s: None)
    assert st["rows"] == 0 and "2026-10-21" in st["failed"]
    assert "2026-10-21" not in set(cache.read("NIFTYIDX")["date"].dt.strftime("%Y-%m-%d"))


def test_todays_bar_is_not_asked_for_before_the_session_is_final():
    assert date(2026, 10, 22) not in E.candidate_days(ist("2026-10-22T11:00"))
    assert date(2026, 10, 22) in E.candidate_days(ist("2026-10-22T20:15"))
    assert date(2026, 10, 20) not in E.candidate_days(ist("2026-10-22T20:15"))   # NSE holiday
