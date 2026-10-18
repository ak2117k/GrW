"""Incremental backfill per series and the one-command `build`.

A re-run fetches only from the last stored bar, adds no duplicate rows, and re-requests
every chunk that failed last time (recorded in the manifest as `failed_chunks`).
An error chunk is never an empty month: it keeps `build` at exit 1, naming the chunk.
"""
from __future__ import annotations

import traceback
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Callable
from zoneinfo import ZoneInfo

import pandas as pd

from . import exports as exports_mod
from .angel import AngelError, AngelHistory, MarketHoursError, assert_off_market_hours, load_angel_env
from .probe import probe_depth
from .scrip_master import load_master
from .store import (derive_daily, first_ts, last_ts, load_manifest, read_bars, row_count,
                    update_manifest, write_bars)
from .universe import SeriesSpec, load_universe, resolve_series
from .yahoo import YAHOO_INTERVALS, YAHOO_LOOKBACK, YahooError, fetch_history

IST = ZoneInfo("Asia/Kolkata")
FUTURES_DEFAULT_DAYS = 120
YAHOO_DAILY_FROM = datetime(2000, 1, 1, tzinfo=timezone.utc)
USDINR_DEPTH_KEY = "USDINR_ANGEL"
USDINR_SKIP = "no Angel history; Yahoo INR=X used"
LAST_OUTCOMES: list["SeriesOutcome"] = []


@dataclass
class SeriesOutcome:
    series_id: str
    interval: str
    added: int
    failed: list[tuple] = field(default_factory=list)
    skipped_reason: str = ""


def last_completed_session(now: datetime) -> date:
    local = now.astimezone(IST)
    d = local.date()
    if local.weekday() >= 5 or (local.hour * 60 + local.minute) < 15 * 60 + 45:
        d -= timedelta(days=1)
    while d.weekday() >= 5:
        d -= timedelta(days=1)
    return d


def _ist_date(ts: pd.Timestamp) -> date:
    return ts.tz_convert(IST).date()


def _chunks_to_json(failed) -> list[list[str]]:
    return [[str(s), str(e), str(m)] for s, e, m in failed]


def _angel_has_data(angel, spec: SeriesSpec) -> Callable[[date], bool | None]:
    def has(d: date) -> bool | None:
        r = angel.candles(spec.exchange, spec.token, "ONE_MINUTE", d, d + timedelta(days=4))
        return None if r.failed else len(r.df) > 0
    return has


def _yahoo_has_data(symbol: str, interval: str, get, sleep) -> Callable[[date], bool | None]:
    def has(d: date) -> bool | None:
        start = datetime(d.year, d.month, d.day, tzinfo=timezone.utc)
        r = fetch_history(symbol, interval, start, start + timedelta(days=5), get=get, sleep=sleep)
        if r.failed:
            msg = r.failed[0][2].lower()
            # Yahoo's explicit "outside the served range" answer is authoritative no-data.
            return False if ("not available" in msg or "data doesn" in msg) else None
        return len(r.df) > 0
    return has


def _write_angel(root: Path, sid: str, df: pd.DataFrame) -> int:
    added = write_bars(root, sid, "1m", df)
    if len(df):
        lo = df["ts"].min().tz_convert(IST).normalize().replace(day=1).tz_convert("UTC")
        write_bars(root, sid, "1d", derive_daily(read_bars(root, sid, "1m", start=lo)))
    return added


def _record(root: Path, sid: str, interval: str, source: str, failed) -> None:
    f, l = first_ts(root, sid, interval), last_ts(root, sid, interval)
    update_manifest(root, sid, interval, source=source, rows=row_count(root, sid, interval),
                    first=str(f) if f is not None else None, last=str(l) if l is not None else None,
                    failed_chunks=_chunks_to_json(failed))


def _backfill_angel(spec: SeriesSpec, root: Path, angel, now: datetime) -> list[SeriesOutcome]:
    sid = spec.id
    entry = load_manifest(root).get(sid, {}).get("1m", {})
    end = last_completed_session(now)
    if spec.expiry:
        end = min(end, spec.expiry)
    lt = last_ts(root, sid, "1m")
    if lt is not None:
        start = _ist_date(lt) + timedelta(days=1)
    elif entry.get("depth_earliest"):
        start = date.fromisoformat(entry["depth_earliest"])
    elif spec.group in ("futures", "usdinr"):
        start = now.astimezone(IST).date() - timedelta(days=FUTURES_DEFAULT_DAYS)
    elif entry.get("depth_status") == "none":
        return [SeriesOutcome(sid, "1m", 0, [], "depth probe: no Angel history")]
    else:
        return [SeriesOutcome(sid, "1m", 0, [(None, None, "history depth unknown; re-run build/probe")])]
    windows = [(date.fromisoformat(s), date.fromisoformat(e)) for s, e, _ in entry.get("failed_chunks", [])]
    failed, added = [], 0
    for s, e in windows + ([(start, end)] if start <= end else []):
        r = angel.candles(spec.exchange, spec.token, "ONE_MINUTE", s, e)
        failed += r.failed
        added += _write_angel(root, sid, r.df)
    _record(root, sid, "1m", "angel", failed)
    if row_count(root, sid, "1d"):
        _record(root, sid, "1d", "angel-derived", [])
    return [SeriesOutcome(sid, "1m", added, failed)]


def _backfill_yahoo(spec: SeriesSpec, root: Path, get, now: datetime, sleep) -> list[SeriesOutcome]:
    out = []
    now_utc = now.astimezone(timezone.utc)
    for iv in YAHOO_INTERVALS:
        sid = spec.id
        entry = load_manifest(root).get(sid, {}).get(iv, {})
        lb = YAHOO_LOOKBACK[iv]
        floor = YAHOO_DAILY_FROM if lb is None else now_utc - timedelta(days=lb)
        lt = last_ts(root, sid, iv)
        start = max(floor, lt.to_pydatetime() + timedelta(seconds=1)) if lt is not None else floor
        windows = []
        for s, e, _ in entry.get("failed_chunks", []):
            ws = datetime.fromisoformat(s).replace(tzinfo=timezone.utc)
            we = datetime.fromisoformat(e).replace(tzinfo=timezone.utc) + timedelta(days=1)
            if we > floor:
                windows.append((max(ws, floor), we))
        failed, added = [], 0
        for s, e in windows + ([(start, now_utc)] if start < now_utc else []):
            r = fetch_history(spec.symbol, iv, s, e, get=get, sleep=sleep)
            failed += r.failed
            added += write_bars(root, sid, iv, r.df)
        _record(root, sid, iv, "yahoo", failed)
        out.append(SeriesOutcome(sid, iv, added, failed))
    return out


def backfill_series(spec: SeriesSpec, root: Path, angel, yahoo_get, now: datetime,
                    yahoo_sleep=None) -> list[SeriesOutcome]:
    if spec.source == "yahoo":
        import time
        return _backfill_yahoo(spec, root, yahoo_get, now, yahoo_sleep or time.sleep)
    return _backfill_angel(spec, root, angel, now)


def _summary(root: Path, outcomes: list[SeriesOutcome]) -> None:
    print(f"{'series':<22} {'iv':<4} {'added':>8} {'first':<26} {'last':<26} failed")
    for o in outcomes:
        m = load_manifest(root).get(o.series_id, {}).get(o.interval, {})
        tail = o.skipped_reason or ("; ".join(f"{s}..{e}: {msg}" for s, e, msg in o.failed) or "-")
        print(f"{o.series_id:<22} {o.interval:<4} {o.added:>8} {str(m.get('first') or '-'):<26} "
              f"{str(m.get('last') or '-'):<26} {tail}")


def run_depth_probes(root: Path, specs: list[SeriesSpec], angel, today: date, force: bool = False) -> list:
    """Depth-probe Angel non-futures series (and the USDINR front contract) lacking a depth."""
    results = []
    manifest = load_manifest(root)
    targets = [s for s in specs if s.source == "angel" and s.group not in ("futures", "usdinr")]
    usd = [s for s in specs if s.group == "usdinr"]
    if usd:
        front = usd[0]
        targets.append(SeriesSpec(USDINR_DEPTH_KEY, "angel", "usdinr", front.exchange, front.token,
                                  front.symbol, front.expiry))
    for s in targets:
        e = manifest.get(s.id, {}).get("1m", {})
        if not force and (e.get("depth_earliest") or e.get("depth_status") == "none"):
            continue
        try:
            r = probe_depth(s.id, "1m", _angel_has_data(angel, s), today)
        except Exception as exc:  # treated as unknown: the series reports it and retries next run
            print(f"depth probe {s.id} failed: {type(exc).__name__}: {exc}")
            continue
        fields = {"depth_status": r.status, "depth_probed": str(today)}
        if r.status == "ok" and r.earliest:
            fields["depth_earliest"] = str(r.earliest)
        update_manifest(root, s.id, "1m", **fields)
        results.append(r)
    return results


def build(root: Path, env_path: Path, instrument: str, now: datetime, allow_market_hours: bool,
          vps: str | None, ssh_key: Path | None, run_probes: bool = True, *,
          angel_factory: Callable[[], object] | None = None, yahoo_get=None,
          master_fetch=None, universe: dict | None = None, yahoo_sleep=None, pull=None) -> int:
    global LAST_OUTCOMES
    root = Path(root)
    try:
        assert_off_market_hours(now, allow_market_hours)
    except MarketHoursError as exc:
        print(f"refused: {exc}")
        return 2
    try:
        angel = angel_factory() if angel_factory else AngelHistory(load_angel_env(env_path))
        angel.login()
    except AngelError as exc:
        print(f"Angel login failed: {exc}")
        return 1
    today = now.astimezone(IST).date()
    master = load_master(root / "_meta", today, fetch=master_fetch)
    specs = resolve_series(universe or load_universe(), instrument, master, today)
    if run_probes:
        run_depth_probes(root, specs, angel, today)
    usd_none = load_manifest(root).get(USDINR_DEPTH_KEY, {}).get("1m", {}).get("depth_status") == "none"
    outcomes: list[SeriesOutcome] = []
    for spec in specs:
        if spec.group == "usdinr" and usd_none:
            outcomes.append(SeriesOutcome(spec.id, "1m", 0, [], USDINR_SKIP))
            continue
        try:
            outcomes += backfill_series(spec, root, angel, yahoo_get, now, yahoo_sleep)
        except Exception as exc:  # one series never stops the others
            traceback.print_exc()
            outcomes.append(SeriesOutcome(spec.id, "1m", 0, [(None, None, f"{type(exc).__name__}: {exc}")]))
    if vps and (ssh_key or pull):
        raw = root / "exports_raw"
        try:
            got = (pull or exports_mod.pull_exports)(vps, ssh_key, raw)
            added = exports_mod.import_exports(raw, root)
            print(f"exports: pulled {len(got)} new files; rows added {added}")
        except Exception as exc:
            outcomes.append(SeriesOutcome("EXPORTS", "-", 0, [(None, None, f"{type(exc).__name__}: {exc}")]))
    else:
        print("WARNING: prod OI/chain exports not pulled — pass --vps root@<ip> --ssh-key <key> "
              "(or set MBM_VPS / MBM_SSH_KEY)")
    LAST_OUTCOMES = outcomes
    _summary(root, outcomes)
    return 1 if any(o.failed for o in outcomes) else 0
