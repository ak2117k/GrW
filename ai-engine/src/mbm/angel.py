"""Angel One SmartAPI historical client for the MBM store.

Credentials come from apps/api/.env (process env overrides) and are never printed,
logged, put in exception text, or written to the store.
"""
from __future__ import annotations

import os
import time
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Callable, Mapping
from zoneinfo import ZoneInfo

import pandas as pd

from .store import BAR_COLUMNS, empty_bars, normalize

IST = ZoneInfo("Asia/Kolkata")
BASE = "https://apiconnect.angelone.in"
LOGIN_URL = f"{BASE}/rest/auth/angelbroking/user/v1/loginByPassword"
CANDLE_URL = f"{BASE}/rest/secure/angelbroking/historical/v1/getCandleData"
CHUNK_DAYS = {"ONE_MINUTE": 29, "FIVE_MINUTE": 99, "ONE_DAY": 1999}
RETRY_SLEEPS = (2, 4, 6)
ENV_KEYS = ("ANGEL_ONE_API_KEY", "ANGEL_ONE_CLIENT_ID", "ANGEL_ONE_PASSWORD", "ANGEL_ONE_TOTP_SECRET")


class AngelError(Exception):
    pass


class MarketHoursError(AngelError):
    pass


@dataclass(frozen=True)
class AngelCreds:
    api_key: str = field(repr=False)
    client_id: str = field(repr=False)
    password: str = field(repr=False)
    totp_secret: str = field(repr=False)

    def __repr__(self) -> str:
        return "AngelCreds(<redacted>)"

    __str__ = __repr__

    def scrub(self, text: str) -> str:
        for v in (self.api_key, self.client_id, self.password, self.totp_secret):
            if v:
                text = text.replace(v, "<redacted>")
        return text


def load_angel_env(env_path: Path, environ: Mapping[str, str] = os.environ) -> AngelCreds:
    vals: dict[str, str] = {}
    p = Path(env_path)
    if p.exists():
        for line in p.read_text(encoding="utf-8").splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                vals[k.strip()] = v.strip().strip('"').strip("'")
    for k in ENV_KEYS:
        if environ.get(k):
            vals[k] = environ[k]
    for k in ENV_KEYS:
        if not vals.get(k):
            raise AngelError(f"missing {k}")
    return AngelCreds(*(vals[k] for k in ENV_KEYS))


def assert_off_market_hours(now: datetime, allow: bool) -> None:
    if allow:
        return
    local = now.astimezone(IST)
    mins = local.hour * 60 + local.minute
    if local.weekday() < 5 and 9 * 60 <= mins < 15 * 60 + 45:
        raise MarketHoursError(
            "refusing Angel pulls Mon-Fri 09:00-15:45 IST (same Angel user as prod); "
            "pass --allow-market-hours to override")


@dataclass
class FetchResult:
    df: pd.DataFrame
    failed: list[tuple[date, date, str]]
    calls: int


def _httpx_post(url: str, headers: dict, body: dict) -> dict:
    import httpx
    try:
        r = httpx.post(url, headers=headers, json=body, timeout=30)
    except httpx.HTTPError as exc:
        return {"status": False, "message": f"network {type(exc).__name__}"}
    try:
        return r.json()
    except ValueError:
        return {"status": False, "message": f"http {r.status_code}"}


def parse_candles(rows: list) -> pd.DataFrame:
    if not rows:
        return empty_bars()
    df = pd.DataFrame([r[:6] for r in rows], columns=["ts", "open", "high", "low", "close", "volume"])
    df["ts"] = pd.to_datetime(df["ts"], utc=True)
    df["oi"] = pd.array([pd.NA] * len(df), dtype="Int64")
    return normalize(df[BAR_COLUMNS])


class AngelHistory:
    def __init__(self, creds: AngelCreds, post: Callable[[str, dict, dict], dict] | None = None,
                 sleep: Callable[[float], None] = time.sleep, gap_s: float = 0.5):
        self.creds = creds
        self.post = post or _httpx_post
        self.sleep = sleep
        self.gap_s = gap_s
        self.headers = {
            "Content-Type": "application/json", "Accept": "application/json",
            "X-UserType": "USER", "X-SourceID": "WEB", "X-ClientLocalIP": "127.0.0.1",
            "X-ClientPublicIP": "127.0.0.1", "X-MACAddress": "00:00:00:00:00:00",
            "X-PrivateKey": creds.api_key,
        }
        self.logged_in = False

    def login(self) -> None:
        import pyotp
        try:
            totp = pyotp.TOTP(self.creds.totp_secret).now()
        except Exception:
            raise AngelError("login failed: TOTP secret is not valid base32") from None
        j = self.post(LOGIN_URL, dict(self.headers), {
            "clientcode": self.creds.client_id, "password": self.creds.password, "totp": totp})
        if not j.get("status") or not (j.get("data") or {}).get("jwtToken"):
            msg = self.creds.scrub(f"{j.get('message')} {j.get('errorcode') or ''}".strip())
            raise AngelError(f"login failed: {msg}")
        self.headers["Authorization"] = "Bearer " + j["data"]["jwtToken"]
        self.logged_in = True

    def candles(self, exchange: str, token: str, interval: str, start: date, end: date) -> FetchResult:
        step = CHUNK_DAYS[interval]
        frm, to = ("00:00", "23:59") if exchange == "MCX" else ("09:15", "15:30")
        frames, failed, calls = [], [], 0
        cur = start
        while cur <= end:
            nxt = min(cur + timedelta(days=step), end)
            body = {"exchange": exchange, "symboltoken": token, "interval": interval,
                    "fromdate": f"{cur:%Y-%m-%d} {frm}", "todate": f"{nxt:%Y-%m-%d} {to}"}
            reply: dict = {}
            for attempt in range(len(RETRY_SLEEPS) + 1):
                self.sleep(self.gap_s)
                calls += 1
                reply = self.post(CANDLE_URL, self.headers, body)
                if reply.get("status"):
                    break
                if attempt < len(RETRY_SLEEPS):
                    self.sleep(RETRY_SLEEPS[attempt])
            if reply.get("status"):
                frames.append(parse_candles(reply.get("data") or []))
            else:
                msg = self.creds.scrub(f"{reply.get('message')} {reply.get('errorcode') or ''}".strip())
                failed.append((cur, nxt, msg))
            cur = nxt + timedelta(days=1)
        df = normalize(pd.concat(frames, ignore_index=True)) if frames else empty_bars()
        return FetchResult(df=df, failed=failed, calls=calls)
