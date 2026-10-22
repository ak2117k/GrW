"""The nightly stock-move job (SHADOW): prices -> NSE calendar -> features -> score -> upsert -> outcomes.

Runs inside grw-mbm on its own asyncio task (mbm_main.stock_move_loop): weekdays 20:15 IST plus a catch-up on
boot when the latest expected session has no rows. It never touches the 5-minute Model A loop.

Flag STOCK_MOVE_ENABLED = observe (default: compute + store) | off. Without an ACTIVE GO `stock-move` row in
ai_models the job only fills outcomes of rows already written (if any) and otherwise does nothing.

Memory: one symbol's daily history at a time (~2.5k rows), one scored row per symbol, the calendar tables
(~30k + 20k small rows) and one LightGBM booster — tens of MB, well inside the container limit.
Fail-soft everywhere: a Yahoo / NSE / DB failure degrades (stale calendar, fewer names, no run) and is
logged; the job never raises into the loop. Exactly one summary line per run (`[stock-move] …`).
"""
from __future__ import annotations

import logging
import math
import time as _time
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Callable

import numpy as np
import pandas as pd

from . import HORIZON_DAYS, THRESHOLD_ATR
from . import calendar as C
from . import nse as N
from . import nse_eod as E
from . import prices as P
from .model import StockMoveModel
from .panel import NoSession, build_panel
from .sessions import SessionCalendar

log = logging.getLogger("mbm.stock_move")

MODES = ("observe", "off")
JUMP = 0.35                 # corporate-action guard (features.JUMP): no outcome judged across such a jump
GIVE_UP_DAYS = 30           # a pending row with no price data this long after as_of is closed with nulls


def mode_from(env) -> str:
    m = (env.get("STOCK_MOVE_ENABLED") or "observe").strip().lower()
    return m if m in MODES else "off"


def _f(x) -> float | None:
    try:
        x = float(x)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(x) or math.isinf(x) else x


def score_rows(panel: pd.DataFrame, scores: pd.DataFrame, model: StockMoveModel, as_of: date,
               closes: dict[str, float], quality: str) -> list[dict[str, Any]]:
    """`stock_move_scores` rows for one day's book."""
    out = []
    for i, r in panel.iterrows():
        s = scores.loc[i]
        rd = r.get(C.MEET_COL)
        known = _f(r.get("er_known")) == 1.0
        out.append({
            "as_of": as_of, "symbol": str(r["sym"]), "horizon_days": HORIZON_DAYS, "threshold_atr": THRESHOLD_ATR,
            "p_big": float(s["p_big"]), "rank_pct": float(s["rank_pct"]), "bucket": str(s["bucket"]),
            "results_date": pd.Timestamp(rd).date() if known and pd.notna(rd) else None,
            "results_in_window": _f(r.get("er_in5")) == 1.0,
            "atr_pct": _f(r.get("atr_pct")), "close": _f(closes.get(str(r["sym"]))),
            "features": {"drivers": s["drivers"], "sector": str(r.get("sector")),
                         "erDaysNext": _f(r.get("er_days_next")), "atrPct": _f(r.get("atr_pct")),
                         "pRaw": round(float(s["raw"]), 6)},
            "model_id": model.model_id, "data_quality": quality,
        })
    return out


def outcome_rows(pending: list[dict[str, Any]], read_prices: Callable[[str], pd.DataFrame], now: datetime,
                 horizon: int = HORIZON_DAYS, k: float = THRESHOLD_ATR,
                 cal: SessionCalendar | None = None) -> list[dict[str, Any]]:
    """Outcomes for rows whose window has closed. The window ends on the `horizon`-th NSE trading session
    after as_of (weekends + NSE holidays skipped: `sessions.SessionCalendar`, the same count the API's
    self-review judge uses); it is filled once that session's bar is in the cache (the cache holds final
    bars only). Label = training label: |close_T/close_t - 1| > k x ATR%_t x sqrt(h), closes from the
    split-adjusted cache, not the stored close. A |log return| > 0.35 inside the window (unadjusted corporate
    action) ⇒ outcome NULL. Rows still unfillable GIVE_UP_DAYS after as_of are closed with NULLs."""
    if cal is None:
        nidx = read_prices("NIFTYIDX")
        cal = SessionCalendar(nidx["date"] if nidx is not None and len(nidx) else [])
    at = pd.Timestamp(now).tz_convert("UTC").to_pydatetime()
    today = now.astimezone(P.IST).date()
    out = []
    by_sym: dict[str, list[dict]] = {}
    for r in pending:
        by_sym.setdefault(str(r["symbol"]), []).append(r)
    for sym, rows in by_sym.items():
        d = read_prices(sym)
        if d is None:
            d = pd.DataFrame(columns=P.COLS)
        dates = [pd.Timestamp(x).date() for x in pd.to_datetime(d["date"])] if len(d) else []
        idx = {x: i for i, x in enumerate(dates)}
        closes = d["close"].to_numpy(dtype="float64") if len(d) else np.array([])
        for r in rows:
            a = pd.Timestamp(r["as_of"]).date()
            end = cal.add_sessions(a, horizon)
            i, j = idx.get(a), idx.get(end)
            if i is None or j is None or j <= i:
                if (today - a).days > GIVE_UP_DAYS:
                    out.append({"id": r["id"], "ret_bp": None, "big": None, "at": at})
                continue
            w = closes[i:j + 1]
            ret = w[-1] / w[0] - 1
            jumped = bool((np.abs(np.diff(np.log(w))) > JUMP).any())
            atr = _f(r.get("atr_pct"))
            big = None if jumped or atr is None else bool(abs(ret) > k * atr * math.sqrt(horizon))
            out.append({"id": r["id"], "ret_bp": None if jumped else round(abs(ret) * 1e4, 2), "big": big, "at": at})
    return out


@dataclass
class StockMoveJob:
    repo: Any                                   # StockMoveRepo | None
    models_dir: Path
    cache_dir: Path
    now: Callable[[], datetime]
    mode: str = "observe"
    yahoo_get: Callable | None = None           # injected in tests (prices.Getter)
    nse_fetch: Callable | None = None           # injected in tests (nse.Fetcher)
    eod_get: Callable | None = None             # injected in tests (nse_eod.EodGetter)
    sleep: Callable[[float], None] = _time.sleep
    model: StockMoveModel | None = None
    model_path: Path | None = None
    last_summary: dict = field(default_factory=dict)

    @property
    def prices(self) -> P.PriceCache:
        return P.PriceCache(self.cache_dir / "prices")

    # ------------------------------------------------------------ model / universe

    def load_model(self) -> StockMoveModel | None:
        row = self.repo.active_model()
        if not row:
            self.model = self.model_path = None
            return None
        if self.model is not None and self.model.model_id == str(row["id"]):
            return self.model
        d = (self.models_dir / str(row["artifactPath"])).resolve()
        if self.models_dir.resolve() not in d.parents:
            raise ValueError(f"artifactPath escapes models dir: {row['artifactPath']}")
        self.model = StockMoveModel.load(d, model_id=str(row["id"]))
        self.model_path = d
        log.info("[stock-move] loaded %s from %s", self.model.model_id, d)
        return self.model

    def universe(self, model: StockMoveModel) -> tuple[list[str], str]:
        try:
            names = self.repo.universe()
        except Exception as exc:
            log.warning("[stock-move] universe query failed: %s (using the model's training universe)", exc)
            names = []
        if names:
            return sorted(set(names)), "db"
        return sorted(model.universe), "model"

    def needs_catch_up(self) -> bool:
        """True when a model is active and the latest expected session has no rows."""
        from ..service import clock
        if self.mode == "off" or self.repo is None:
            return False
        try:
            if not self.repo.active_model():
                return False
            last = self.repo.latest_as_of()
        except Exception as exc:
            log.warning("[stock-move] catch-up check failed: %s", exc)
            return False
        exp = clock.expected_stock_move_session(self.now())
        return last is None or pd.Timestamp(last).date() < exp

    # ------------------------------------------------------------ the run

    def run(self, as_of: date | None = None, force: bool = False) -> dict[str, Any]:
        t0 = _time.monotonic()
        s: dict[str, Any] = {"mode": self.mode, "status": "skipped"}
        try:
            self._run(s, as_of, force)
        except Exception as exc:     # never raise into the loop
            s.update(status="failed", error=f"{type(exc).__name__}: {exc}"[:300])
            log.exception("[stock-move] run failed: %s", exc)
        s["seconds"] = round(_time.monotonic() - t0, 1)
        self.last_summary = s
        log.info("[stock-move] %s", " ".join(f"{k}={v}" for k, v in s.items() if k != "stale"))
        return s

    def _run(self, s: dict, as_of: date | None, force: bool) -> None:
        if self.mode == "off":
            s["status"] = "off"
            return
        if self.repo is None:
            s["status"] = "no_db"
            return
        now = self.now()
        model = self.load_model()
        pending = self.repo.pending_outcomes()
        if model is None and not pending:
            s["status"] = "no_active_model"
            return
        names, src = self.universe(model) if model else (sorted({str(r["symbol"]) for r in pending}), "pending")
        s.update(model=model.model_id if model else None, universe=f"{len(names)}({src})")
        get = self.yahoo_get or P._httpx_get
        st = P.refresh_all(self.prices, [*P.INDEX_YAHOO, *names], now, get=get, sleep=self.sleep)
        s.update(prices_ok=st["ok"], prices_failed=len(st["failed"]))
        if st["readjusted"]:
            s["readjusted"] = ",".join(st["readjusted"][:10])
        g = E.fill_gaps(self.prices, [*P.INDEX_YAHOO, *names], now, get=self.eod_get or E.http_get, sleep=self.sleep)
        if g["days"] or g["failed"]:
            s["gap_filled"] = f"{','.join(g['days']) or '-'}({g['rows']})"
            if g["failed"]:
                s["gap_failed"] = ",".join(g["failed"])
        if model is not None:
            self._score(s, model, names, now, as_of, force)
        filled = outcome_rows(pending, self.prices.read, now)
        if filled:
            self.repo.write_outcomes(filled)
        s["outcomes"] = len(filled)
        s["outcomes_big"] = sum(1 for r in filled if r["big"])

    def _score(self, s: dict, model: StockMoveModel, names: list[str], now: datetime, as_of: date | None,
               force: bool) -> None:
        nidx = self.prices.read("NIFTYIDX")
        if nidx.empty:
            s["status"] = "no_index_bars"
            return
        day = pd.Timestamp(as_of) if as_of else pd.Timestamp(nidx["date"].iloc[-1])
        s["as_of"] = str(day.date())
        if not force and self.repo.count_scores(day.date()) > 0:
            s["status"] = "already_scored"
            return
        cal = N.CalendarCache(self.cache_dir / "calendar", seed_dir=self.model_path)
        fetch = self.nse_fetch or N.fetch_bulk
        c = N.refresh(cal, names, now, fetch=fetch)
        s["calendar"] = "ok" if c["ok"] else "stale"
        R, B = cal.load()
        try:
            panel, st = build_panel(names, self.prices.read, R, B, model.sectors,
                                    cutoff=day + pd.Timedelta(days=1), keep_dates=[day])
        except NoSession as exc:
            s["status"] = "no_session"
            s["error"] = str(exc)[:120]
            return
        s["stale"] = len(st["stale"])
        if panel.empty:
            s["status"] = "nothing_to_score"
            return
        panel = panel.reset_index(drop=True)
        scores = model.score(panel)
        rows = score_rows(panel, scores, model, day.date(), st["close"], "ok" if c["ok"] else "calendar_stale")
        self.repo.upsert_scores(rows)
        s.update(status="scored", scored=len(rows), top20=sum(r["bucket"] == "TOP20" for r in rows),
                 results_in_window=sum(r["results_in_window"] for r in rows),
                 p_med=round(float(np.median(scores["p_big"])), 4))


def dry_run(model_dir: Path, prices_dir: Path, as_of: date, universe: list[str] | None = None,
            calendar_dir: Path | None = None) -> tuple[list[dict[str, Any]], dict]:
    """Score one date locally (no DB, no network): model artefact + a price cache (+ optional calendar cache)."""
    model = StockMoveModel.load(Path(model_dir))
    cache = P.PriceCache(Path(prices_dir))
    cal = N.CalendarCache(Path(calendar_dir) if calendar_dir else Path(model_dir) / "__none__", seed_dir=Path(model_dir))
    R, B = cal.load()
    day = pd.Timestamp(as_of)
    names = universe or model.universe
    panel, st = build_panel(names, cache.read, R, B, model.sectors, cutoff=day + timedelta(days=1), keep_dates=[day])
    if panel.empty:
        return [], st
    panel = panel.reset_index(drop=True)
    return score_rows(panel, model.score(panel), model, day.date(), st["close"], "ok"), st
