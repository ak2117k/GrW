"""History-depth and expired-futures probes.

An error answer is never treated as "no data": it stops the search with status
"unknown" and the last confirmed date in the note.
"""
from __future__ import annotations

import csv
import json
import re
from dataclasses import asdict, dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Callable, Literal

from .scrip_master import Contract, load_snapshot, parse_expiry, snapshot_dir
from .store import update_manifest

WINDOW_DAYS = 5


@dataclass
class DepthResult:
    series_id: str
    interval: str
    earliest: date | None
    status: Literal["ok", "none", "unknown"]
    calls: int
    note: str = ""


@dataclass
class ExpiredResult:
    symbol: str
    exch_seg: str
    expiry: date
    token: str
    bars: int
    status: Literal["served", "empty", "error"]
    message: str = ""


def _years_back(d: date, k: int) -> date:
    try:
        return d.replace(year=d.year - k)
    except ValueError:  # 29 Feb
        return d.replace(year=d.year - k, day=28)


def _month_start(d: date) -> date:
    return d.replace(day=1)


def _next_month(d: date) -> date:
    return date(d.year + (d.month == 12), d.month % 12 + 1, 1)


def probe_depth(series_id: str, interval: str, has_data: Callable[[date], bool | None],
                today: date, max_years: int = 10) -> DepthResult:
    calls = 0

    def ask(d: date) -> bool | None:
        nonlocal calls
        calls += 1
        return has_data(d)

    last_yes: date | None = None  # latest-probed date confirmed to have data
    no_date: date | None = None
    for k in range(1, max_years + 1):
        d = _years_back(today, k)
        a = ask(d)
        if a is None:
            return DepthResult(series_id, interval, None, "unknown", calls,
                               f"error at {d}; last confirmed {last_yes or 'none'}")
        if a:
            last_yes = d
        else:
            no_date = d
            break
    if no_date is None:
        return DepthResult(series_id, interval, _month_start(last_yes), "ok", calls,
                           f"capped at {max_years}y")
    upper = last_yes or today
    candidates = []
    m = _next_month(no_date)
    while m <= upper:
        candidates.append(m)
        m = _next_month(m)
    lo, hi, first = 0, len(candidates) - 1, None
    while lo <= hi:
        mid = (lo + hi) // 2
        a = ask(candidates[mid])
        if a is None:
            return DepthResult(series_id, interval, None, "unknown", calls,
                               f"error at {candidates[mid]}; last confirmed {last_yes or 'none'}")
        if a:
            first, hi = candidates[mid], mid - 1
        else:
            lo = mid + 1
    if first is None:
        if last_yes is None:
            return DepthResult(series_id, interval, None, "none", calls, "no data in the last year")
        first = _month_start(last_yes)
    return DepthResult(series_id, interval, first, "ok", calls)


def probe_expired(client, contracts: list[Contract]) -> list[ExpiredResult]:
    out = []
    for c in contracts:
        r = client.candles(c.exch_seg, c.token, "ONE_MINUTE", c.expiry - timedelta(days=10), c.expiry)
        if r.failed:
            out.append(ExpiredResult(c.symbol, c.exch_seg, c.expiry, c.token, 0, "error", r.failed[0][2]))
        else:
            n = len(r.df)
            out.append(ExpiredResult(c.symbol, c.exch_seg, c.expiry, c.token, n, "served" if n else "empty"))
    return out


def _fut_symbol_re(name: str) -> re.Pattern:
    return re.compile(rf"^{re.escape(name)}\d{{2}}[A-Z]{{3}}\d{{2}}FUT$")


def _db_contracts(db_url: str, names: list[str]) -> list[Contract]:
    import psycopg
    out = []
    with psycopg.connect(db_url) as conn:
        conn.read_only = True
        with conn.cursor() as cur:
            for n in names:
                cur.execute("SELECT symbol, token, exchange, expiry FROM instruments "
                            "WHERE expiry < now() AND symbol LIKE %s ORDER BY expiry DESC LIMIT 50",
                            (f"{n}%FUT",))
                for sym, tok, exch, exp in cur.fetchall():
                    if exp is not None:
                        e = exp.date() if isinstance(exp, datetime) else exp
                        out.append(Contract(str(tok), str(sym), str(exch), e))
    return out


def expired_candidates(meta_dir: Path, names: list[str], today: date, extra_csv: Path | None = None,
                       db_url: str | None = None) -> list[Contract]:
    pool: list[Contract] = []
    sd = snapshot_dir(meta_dir)
    for snap in sorted(sd.glob("*.json.gz")) if sd.exists() else []:
        for r in load_snapshot(snap):
            if r.get("name") in names and str(r.get("instrumenttype", "")).startswith("FUT"):
                e = parse_expiry(str(r.get("expiry", "")))
                if e:
                    pool.append(Contract(str(r["token"]), str(r["symbol"]), str(r["exch_seg"]), e))
    if extra_csv:
        with open(extra_csv, newline="", encoding="utf-8") as f:
            for row in csv.DictReader(f):
                pool.append(Contract(row["token"].strip(), row["symbol"].strip(), row["exch_seg"].strip(),
                                     date.fromisoformat(row["expiry"].strip()[:10])))
    if db_url:
        pool += _db_contracts(db_url, names)
    out = []
    for n in names:
        rx = _fut_symbol_re(n)
        seen, picked = set(), []
        for c in sorted(pool, key=lambda c: c.expiry, reverse=True):
            if c.expiry < today and rx.match(c.symbol) and c.token not in seen:
                seen.add(c.token)
                picked.append(c)
        out += picked[:3]
    return out


def write_probe_report(meta_dir: Path, depth: list[DepthResult], expired: list[ExpiredResult],
                       run_date: date) -> Path:
    meta_dir = Path(meta_dir)
    meta_dir.mkdir(parents=True, exist_ok=True)
    (meta_dir / f"probes-{run_date}.json").write_text(json.dumps(
        {"run_date": str(run_date), "generated_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
         "depth": [asdict(d) for d in depth], "expired": [asdict(e) for e in expired]},
        indent=2, default=str), encoding="utf-8")
    lines = [f"# MBM probes — {run_date}", "", "## History depth", "",
             "| series | interval | earliest | status | calls | note |", "|---|---|---|---|---|---|"]
    lines += [f"| {d.series_id} | {d.interval} | {d.earliest or '—'} | {d.status} | {d.calls} | {d.note} |"
              for d in depth]
    lines += ["", "## Expired futures (1m, expiry−10d … expiry)", "",
              "| symbol | exch | expiry | token | bars | status | message |", "|---|---|---|---|---|---|---|"]
    lines += [f"| {e.symbol} | {e.exch_seg} | {e.expiry} | {e.token} | {e.bars} | {e.status} | {e.message} |"
              for e in expired]
    md = meta_dir / f"probes-{run_date}.md"
    md.write_text("\n".join(lines) + "\n", encoding="utf-8")
    for d in depth:
        fields = {"depth_status": d.status, "depth_probed": str(run_date)}
        if d.status == "ok" and d.earliest:
            fields["depth_earliest"] = str(d.earliest)
        update_manifest(meta_dir.parent, d.series_id, d.interval, **fields)
    return md
