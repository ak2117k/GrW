"""The MBM serving engine: model loading, one prediction run, the outcome filler, `/behaviour`.

Synchronous and clock-injected so tests drive it directly; `mbm_main` runs it on a thread.
"""
from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Callable

import pandas as pd

from .. import labels as L
from ..features import (BANKNIFTY, FEATURE_SET, HEAVYWEIGHTS, VIX, _annotate, build_features, to_5m)
from ..predict import HorizonModel
from ..store import BAR_COLUMNS, empty_bars, normalize
from . import clock, setups
from .repo import Repo

log = logging.getLogger("mbm.engine")

SERVED_HORIZONS: dict[str, int] = {"30m": 30, "60m": 60}
FEATURE_LOOKBACK = timedelta(days=45)      # calendar days of 1m bars the features need
OUTCOME_LOOKBACK = timedelta(days=100)     # ≥ 60 prior sessions for the trailing-median threshold
GAP_WINDOW = timedelta(minutes=30)
MAX_GAP = timedelta(minutes=2)
FRESH = timedelta(minutes=10)
ONE_MIN = timedelta(minutes=1)


def universe(instrument: str) -> list[str]:
    """Series the features read: the instrument + drivers (same constants as training)."""
    return list(dict.fromkeys([instrument, BANKNIFTY, VIX, *HEAVYWEIGHTS]))


def frames_from_rows(bars: pd.DataFrame) -> dict[str, pd.DataFrame]:
    """`mbm_bars_1m` rows → {series: 1m frame} in the parquet store's exact shape/dtypes."""
    out: dict[str, pd.DataFrame] = {}
    if bars is None or bars.empty:
        return out
    for sid, g in bars.groupby("series", sort=False):
        d = g.drop(columns="series").copy()
        d["volume"] = pd.to_numeric(d["volume"]).fillna(0).round()
        d["oi"] = pd.NA
        out[str(sid)] = normalize(d[BAR_COLUMNS])
    return out


def build_inputs(bars: pd.DataFrame, instrument: str, global_daily: dict[str, pd.DataFrame]) -> dict:
    """Same dict shape as `features.load_inputs` returns, so training and serving share one path."""
    f = frames_from_rows(bars)
    return {
        "instrument": f.get(instrument, empty_bars()),
        "banknifty": f.get(BANKNIFTY, empty_bars()),
        "vix": f.get(VIX, empty_bars()),
        "heavyweights": {s: f[s] for s in HEAVYWEIGHTS if s in f},
        "global_daily": dict(global_daily or {}),
    }


def has_gap(df_1m: pd.DataFrame | None, as_of: datetime) -> bool:
    """True if the 1m bars of the last 30 min before `as_of` (inside the session) miss > 2 min."""
    lo = max(pd.Timestamp(as_of) - GAP_WINDOW, pd.Timestamp(clock.session_open(as_of)))
    hi = pd.Timestamp(as_of)
    ts = pd.Series(dtype="datetime64[ns, UTC]") if df_1m is None or df_1m.empty else df_1m["ts"]
    ts = ts[(ts >= lo) & (ts < hi)].sort_values()
    # A bar starting at x covers [x, x+1m): edges are the window start and `as_of` itself.
    points = [lo - ONE_MIN, *ts.tolist(), hi]
    return any(b - a > MAX_GAP + ONE_MIN for a, b in zip(points, points[1:]))


def _drivers_missing(inputs: dict, as_of: datetime) -> bool:
    lo = pd.Timestamp(as_of) - GAP_WINDOW

    def recent(df):
        return df is not None and len(df) > 0 and bool((df["ts"] >= lo).any())
    hw = inputs["heavyweights"]
    return (not recent(inputs["banknifty"]) or not recent(inputs["vix"])
            or not any(recent(d) for d in hw.values()) or not inputs["global_daily"])


def _num(x) -> float | None:
    if x is None:
        return None
    x = float(x)
    return None if math.isnan(x) else x


def _iso(ts) -> str:
    return pd.Timestamp(ts).tz_convert("UTC").strftime("%Y-%m-%dT%H:%M:%SZ")


@dataclass
class LoadedModel:
    model_id: str
    model: HorizonModel


@dataclass
class Engine:
    repo: Repo | None
    models_dir: Path
    instruments: list[str]
    now: Callable[[], datetime]
    fetch_daily: Callable[[datetime], dict[str, pd.DataFrame]] | None = None
    fetch_index_daily: Callable[[datetime], pd.DataFrame] | None = None
    models: dict[str, dict[str, LoadedModel]] = field(default_factory=dict)
    global_daily: dict[str, pd.DataFrame] = field(default_factory=dict)
    daily_loaded_on: Any = None
    last_run: datetime | None = None

    # ------------------------------------------------------------ startup

    def load_models(self, loader: Callable[[Path], HorizonModel] = HorizonModel.load) -> None:
        self.models = {}
        for inst in self.instruments:
            self.models[inst] = {}
            if self.repo is None:
                log.warning("[mbm] no AI DB configured: %s has no models", inst)
                continue
            try:
                rows = self.repo.active_models(inst)
            except Exception as exc:
                log.error("[mbm] reading ai_models for %s failed: %s", inst, exc)
                continue
            for r in rows:
                h = r["horizon"]
                if h not in SERVED_HORIZONS or h in self.models[inst]:
                    continue
                d = (self.models_dir / str(r["artifactPath"])).resolve()
                try:
                    if self.models_dir.resolve() not in d.parents:
                        raise ValueError(f"artifactPath escapes models dir: {r['artifactPath']}")
                    self.models[inst][h] = LoadedModel(str(r["id"]), loader(d))
                    log.info("[mbm] loaded %s %s from %s", inst, h, d)
                except Exception as exc:
                    log.error("[mbm] %s %s absent: cannot load %s (%s)", inst, h, d, exc)
            missing = sorted(set(SERVED_HORIZONS) - set(self.models[inst]))
            if missing:
                log.warning("[mbm] %s horizons absent (no GO model): %s", inst, missing)

    def model_summary(self) -> dict[str, list[str]]:
        return {inst: sorted(ms) for inst, ms in self.models.items()}

    def refresh_daily(self) -> None:
        if self.fetch_daily is None:
            return
        now = self.now()
        try:
            self.global_daily = self.fetch_daily(now)
        except Exception as exc:
            log.warning("[mbm] global daily refresh failed: %s", exc)
            self.global_daily = {}
        self.daily_loaded_on = clock.to_ist(now).date()

    # ------------------------------------------------------------ prediction

    def predict_once(self, instrument: str, as_of: datetime) -> list[dict[str, Any]]:
        """Build features up to `as_of` and return the prediction rows (empty if stale/no models)."""
        models = self.models.get(instrument) or {}
        if not models or self.repo is None:
            return []
        as_of_ts = pd.Timestamp(as_of).tz_convert("UTC")
        bars = self.repo.bars(universe(instrument), (as_of_ts - FEATURE_LOOKBACK).to_pydatetime(),
                              as_of_ts.to_pydatetime())   # ts < as_of: never a bar still forming
        inputs = build_inputs(bars, instrument, self.global_daily)
        inst = inputs["instrument"]
        if inst.empty or inst["ts"].iloc[-1] != as_of_ts - ONE_MIN:
            log.info("[mbm] %s %s stale: newest 1m bar %s", instrument, _iso(as_of_ts),
                     None if inst.empty else _iso(inst["ts"].iloc[-1]))
            return []
        feats = build_features(inputs)
        if feats.empty or feats.index[-1] != as_of_ts:
            log.info("[mbm] %s %s stale: newest feature row %s", instrument, _iso(as_of_ts),
                     None if feats.empty else _iso(feats.index[-1]))
            return []
        row = feats.iloc[[-1]]
        quality = "gap" if has_gap(inst, as_of_ts) else ("drivers_missing" if _drivers_missing(inputs, as_of_ts) else "ok")
        out = []
        for h, lm in sorted(models.items()):
            pr = lm.model.predict(row).iloc[0]
            out.append({
                "instrument": instrument, "horizon": h, "as_of": as_of_ts.to_pydatetime(),
                "p": float(pr["p"]), "regime": str(pr["regime"]),
                "q25_bp": _num(pr.get("q25_bp")), "q50_bp": _num(pr.get("q50_bp")), "q75_bp": _num(pr.get("q75_bp")),
                "model_id": lm.model_id, "feature_set": lm.model.feature_set or FEATURE_SET,
                "data_quality": quality,
            })
        return out

    def run_once(self) -> dict[str, int]:
        """One loop tick: predict for the current decision time, then fill closed outcomes."""
        now = self.now()
        n = clock.to_ist(now)
        if self.fetch_daily and self.daily_loaded_on != n.date() and n.time() >= clock.DAILY_REFRESH:
            self.refresh_daily()
        as_of = clock.as_of_for(now)
        written = filled = 0
        for inst in self.instruments:
            if as_of is not None:
                try:
                    rows = self.predict_once(inst, as_of)
                    if rows:
                        self.repo.upsert_predictions(rows)
                        written += len(rows)
                except Exception as exc:
                    log.exception("[mbm] predict %s failed: %s", inst, exc)
            try:
                filled += self.fill_outcomes(inst)
            except Exception as exc:
                log.exception("[mbm] outcome filler %s failed: %s", inst, exc)
        self.last_run = now
        return {"predictions": written, "outcomes": filled}

    # ------------------------------------------------------------ outcomes

    def fill_outcomes(self, instrument: str) -> int:
        """Fill outcome_* for rows whose window has closed. Range/threshold/big reuse
        `labels.compute_labels` + `labels.big_labels` (the training label, unchanged)."""
        if self.repo is None:
            return 0
        pending = [r for r in self.repo.pending_outcomes(instrument) if r["horizon"] in SERVED_HORIZONS]
        if not pending:
            return 0
        newest = self.repo.newest_bar_ts(instrument)
        if newest is None:
            return 0
        newest_end = pd.Timestamp(newest).tz_convert("UTC") + ONE_MIN
        ready = []
        for r in pending:
            a = pd.Timestamp(r["as_of"]).tz_convert("UTC")
            end = min(a + timedelta(minutes=SERVED_HORIZONS[r["horizon"]]), pd.Timestamp(clock.session_end(a)))
            if end <= newest_end:
                ready.append((r, a))
        if not ready:
            return 0
        start = min(a for _, a in ready) - OUTCOME_LOOKBACK
        bars = self.repo.bars([instrument], start.to_pydatetime(), newest_end.to_pydatetime())
        df = frames_from_rows(bars).get(instrument, empty_bars())
        b = _annotate(to_5m(df))
        mods = {int(clock.to_ist(a).hour * 60 + clock.to_ist(a).minute) for _, a in ready}
        decisions = b[b["mod"].isin(mods)][["date", "mod", "close"]]
        labels = L.compute_labels(df, decisions, pd.Series(dtype="float64"))
        big = {h: L.big_labels(decisions, labels, h) for h in {r["horizon"] for r, _ in ready}}
        at = pd.Timestamp(self.now()).tz_convert("UTC").to_pydatetime()
        out = []
        for r, a in ready:
            h, mins = r["horizon"], SERVED_HORIZONS[r["horizon"]]
            rng = thr = None
            if a in decisions.index:
                rng = _num(labels.at[a, f"range_bp_{h}"])
                thr = _num(big[h].at[a, "threshold_bp"])
            n_bars = int(((df["ts"] >= a) & (df["ts"] < a + timedelta(minutes=mins))).sum())
            quality = "ok" if rng is not None and n_bars == mins else "gap"
            out.append({"id": r["id"], "range_bp": rng, "threshold_bp": thr,
                        "big": None if rng is None or thr is None else bool(rng > thr),
                        "quality": quality, "at": at})
        self.repo.write_outcomes(out)
        return len(out)

    # ------------------------------------------------------------ daily setups (observe only)

    def run_daily_setups(self) -> dict[str, int]:
        """15:50 IST job: detect today's NIFTY daily-chart setups, then fill matured outcomes.
        Holiday skip as elsewhere in the service: no NIFTY 1m bars for today ⇒ no session ⇒ no detection."""
        inst = setups.INSTRUMENT
        if self.repo is None or self.fetch_index_daily is None or inst not in self.instruments:
            return {"signals": 0, "outcomes": 0}
        now = self.now()
        today = clock.to_ist(now).date()
        try:
            yahoo = self.fetch_index_daily(now)
        except Exception as exc:
            log.warning("[mbm] %s daily history failed: %s", setups.NSEI, exc)
            yahoo = None
        bars = self.repo.bars([inst], clock.day_start(now), now)
        session_today = setups.session_from_1m(bars, today) is not None
        d = setups.build_daily(yahoo, bars, today)
        written = 0
        if not session_today:
            log.info("[mbm] daily setups %s: no session bars today (holiday?): skipped", today)
        elif d.empty or d.index[-1] != today:
            log.warning("[mbm] daily setups %s: no daily row for today: skipped", today)
        else:
            rows = [{"instrument": inst, "signal_date": today, **sig} for sig in setups.detect(d)]
            if rows:
                self.repo.upsert_daily_signals(rows)
            written = len(rows)
            log.info("[mbm] daily setups %s: %s", today, [r["setup"] for r in rows])
        filled = 0
        if not d.empty:
            at = pd.Timestamp(now).tz_convert("UTC").to_pydatetime()
            out = setups.fill_rows(self.repo.pending_daily_outcomes(inst), d, at)
            if out:
                self.repo.write_daily_outcomes(out)
            filled = len(out)
        return {"signals": written, "outcomes": filled}

    def daily_signals(self, instrument: str) -> list[dict[str, Any]]:
        """Signals of the last 5 sessions for `/behaviour`. Fail-open: any error ⇒ []."""
        if self.repo is None:
            return []
        try:
            since = setups.last_sessions_since(clock.to_ist(self.now()).date())
            rows = self.repo.recent_daily_signals(instrument, since)
            return [{"setup": r["setup"], "action": r["action"],
                     "date": pd.Timestamp(r["signal_date"]).strftime("%Y-%m-%d")} for r in rows]
        except Exception as exc:
            log.error("[mbm] daily signals %s read failed: %s", instrument, exc)
            return []

    # ------------------------------------------------------------ endpoint

    def behaviour(self, instrument: str) -> dict[str, Any]:
        inst = instrument.upper()
        now = self.now()
        daily = self.daily_signals(inst)
        absent = {"instrument": inst, "status": "absent", "asOf": None, "horizons": {},
                  "modelIds": {}, "featureSet": FEATURE_SET, "dataQuality": None, "dailySignals": daily}
        n = clock.to_ist(now)
        in_session = (clock.is_weekday(n) and clock.SESSION_OPEN <= n.time()
                      and n <= clock.session_end(n) + FRESH)
        if self.repo is None or not in_session:
            return absent
        try:
            rows = self.repo.latest_predictions(inst, clock.day_start(now))
        except Exception as exc:
            log.error("[mbm] behaviour %s read failed: %s", inst, exc)
            return absent
        if not rows:
            return absent
        as_of = pd.Timestamp(rows[0]["as_of"]).tz_convert("UTC")
        status = "ok" if pd.Timestamp(now).tz_convert("UTC") - as_of <= FRESH else "stale"
        quality = {r["data_quality"] for r in rows}
        rank = ["gap", "drivers_missing", "ok"]
        return {
            "instrument": inst, "status": status, "asOf": _iso(as_of),
            "horizons": {r["horizon"]: {
                "p": round(float(r["p"]), 4), "regime": r["regime"],
                "q25Bp": _round(r["q25_bp"]), "q50Bp": _round(r["q50_bp"]), "q75Bp": _round(r["q75_bp"]),
            } for r in rows},
            "modelIds": {r["horizon"]: r["model_id"] for r in rows},
            "featureSet": rows[0]["feature_set"],
            "dataQuality": next((q for q in rank if q in quality), "ok"),
            "dailySignals": daily,
        }

    def health(self) -> dict[str, Any]:
        return {"ok": True, "models": self.model_summary(),
                "lastRun": None if self.last_run is None else _iso(self.last_run)}


def _round(x) -> float | None:
    v = _num(x)
    return None if v is None else round(v, 1)
