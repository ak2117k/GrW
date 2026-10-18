from datetime import date, datetime
from zoneinfo import ZoneInfo

import pandas as pd
import pytest

from src.mbm.angel import (AngelCreds, AngelError, AngelHistory, MarketHoursError,
                           assert_off_market_hours, load_angel_env)

IST = ZoneInfo("Asia/Kolkata")
CREDS = AngelCreds("KEYVAL123", "CLIENTX9", "PASSW0RDZ", "TOTPSECRETBASE32")
LOGIN_OK = {"status": True, "data": {"jwtToken": "jwt"}}
ROW = ["2026-10-16T09:15:00+05:30", 1, 2, 0.5, 1.5, 10]


class FakePost:
    def __init__(self, responder):
        self.responder = responder
        self.calls = []

    def __call__(self, url, headers, body):
        self.calls.append((url, body))
        if url.endswith("loginByPassword"):
            return LOGIN_OK
        return self.responder(body, len([c for c in self.calls if "getCandleData" in c[0]]))

    def data_calls(self):
        return [b for u, b in self.calls if u.endswith("getCandleData")]


def client(responder, sleeps=None):
    sleeps = [] if sleeps is None else sleeps
    c = AngelHistory(CREDS, post=FakePost(responder), sleep=sleeps.append)
    c.login()
    return c, sleeps


def test_creds_never_in_repr_or_errors(tmp_path):
    assert repr(CREDS) == "AngelCreds(<redacted>)"
    for v in (CREDS.api_key, CREDS.client_id, CREDS.password, CREDS.totp_secret):
        assert v not in repr(CREDS) and v not in str(CREDS)
    c = AngelHistory(CREDS, post=lambda u, h, b: {"status": False, "message": "Invalid totp"},
                     sleep=lambda s: None)
    with pytest.raises(AngelError) as ei:
        c.login()
    for v in (CREDS.api_key, CREDS.client_id, CREDS.password, CREDS.totp_secret):
        assert v not in str(ei.value)


def test_load_env_missing_key_names_only_key(tmp_path):
    p = tmp_path / ".env"
    p.write_text('ANGEL_ONE_API_KEY="KEYVAL123"\n# c\nANGEL_ONE_CLIENT_ID=CLIENTX9\nANGEL_ONE_PASSWORD=\'PASSW0RDZ\'\n')
    with pytest.raises(AngelError, match="missing ANGEL_ONE_TOTP_SECRET") as ei:
        load_angel_env(p, environ={})
    assert "KEYVAL123" not in str(ei.value)
    c = load_angel_env(p, environ={"ANGEL_ONE_TOTP_SECRET": "T"})
    assert c.api_key == "KEYVAL123" and c.password == "PASSW0RDZ" and c.totp_secret == "T"


def test_chunks_29_days():
    c, _ = client(lambda body, n: {"status": True, "data": []})
    r = c.candles("NSE", "99926000", "ONE_MINUTE", date(2026, 1, 1), date(2026, 3, 31))
    windows = [(b["fromdate"], b["todate"]) for b in c.post.data_calls()]
    assert windows == [
        ("2026-01-01 09:15", "2026-01-30 15:30"),
        ("2026-01-31 09:15", "2026-03-01 15:30"),
        ("2026-03-02 09:15", "2026-03-31 15:30"),
    ]
    assert r.calls == 3


def test_mcx_window_is_full_day():
    c, _ = client(lambda body, n: {"status": True, "data": []})
    c.candles("MCX", "1", "ONE_MINUTE", date(2026, 1, 1), date(2026, 1, 2))
    b = c.post.data_calls()[0]
    assert (b["fromdate"], b["todate"]) == ("2026-01-01 00:00", "2026-01-02 23:59")


def test_parses_ist_to_utc():
    c, _ = client(lambda body, n: {"status": True, "data": [ROW]})
    df = c.candles("NSE", "99926000", "ONE_MINUTE", date(2026, 10, 16), date(2026, 10, 16)).df
    assert df["ts"].iloc[0] == pd.Timestamp("2026-10-16T03:45Z")
    assert pd.isna(df["oi"].iloc[0])
    assert df["close"].iloc[0] == 1.5


def test_retry_then_success():
    def resp(body, n):
        return {"status": False, "message": "rate", "errorcode": "AB1004"} if n <= 2 else {"status": True, "data": [ROW]}
    c, sleeps = client(resp)
    r = c.candles("NSE", "99926000", "ONE_MINUTE", date(2026, 10, 16), date(2026, 10, 16))
    assert r.calls == 3 and r.failed == [] and len(r.df) == 1
    assert 2 in sleeps and 4 in sleeps


def test_error_chunk_reported_not_empty():
    def resp(body, n):
        if body["fromdate"].startswith("2026-01-31"):
            return {"status": False, "message": "Something went wrong", "errorcode": "AB2001"}
        d = body["fromdate"][:10]
        return {"status": True, "data": [[f"{d}T09:15:00+05:30", 1, 2, 0.5, 1.5, 10]]}
    c, _ = client(resp)
    r = c.candles("NSE", "99926000", "ONE_MINUTE", date(2026, 1, 1), date(2026, 3, 31))
    assert len(r.failed) == 1
    s, e, msg = r.failed[0]
    assert (s, e) == (date(2026, 1, 31), date(2026, 3, 1)) and "Something went wrong" in msg
    assert len(r.df) == 2


def test_empty_chunk_is_not_failure():
    c, _ = client(lambda body, n: {"status": True, "data": []})
    r = c.candles("NSE", "99926000", "ONE_MINUTE", date(2026, 10, 16), date(2026, 10, 16))
    assert r.df.empty and r.failed == []


def test_gap_between_calls():
    c, sleeps = client(lambda body, n: {"status": True, "data": []})
    c.candles("NSE", "99926000", "ONE_MINUTE", date(2026, 1, 1), date(2026, 3, 31))
    assert sleeps == [0.5, 0.5, 0.5]


def test_market_hours_guard():
    with pytest.raises(MarketHoursError):
        assert_off_market_hours(datetime(2026, 10, 14, 10, 0, tzinfo=IST), allow=False)
    assert_off_market_hours(datetime(2026, 10, 14, 16, 0, tzinfo=IST), allow=False)
    assert_off_market_hours(datetime(2026, 10, 17, 10, 0, tzinfo=IST), allow=False)
    assert_off_market_hours(datetime(2026, 10, 14, 10, 0, tzinfo=IST), allow=True)
