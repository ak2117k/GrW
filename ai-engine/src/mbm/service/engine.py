"""The MBM serving engine: model loading, one prediction run, the outcome filler, `/behaviour`.

Synchronous and clock-injected so tests drive it directly; `mbm_main` runs it on a thread.
"""
from __future__ import annotations

import logging
import math
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Callable

import pandas as pd

from .. import labels as L
from .. import relative as R
from ..features import (BANKNIFTY, FEATURE_SET, HEAVYWEIGHTS, VIX, _annotate, build_features, to_5m)
from ..predict import HorizonModel
from ..store import BAR_COLUMNS, empty_bars, normalize
from . import clock, setups
from .repo import Repo

log = logging.getLogger("mbm.engine")

SERVED_HORIZONS: dict[str, int] = {"30m": 30, "60m": 60}

# M4 automatic demotion (design §5.9.5, plan M4 §B.2): judged on the served model's own outcomes.
LIVE_WINDOW = timedelta(days=30)   # calendar days
LIVE_MIN_N = 300                   # fewer usable outcomes -> no action, ever
LIVE_AUC_FLOOR = 0.60


def live_auc(p: list[float], y: list[bool]) -> float | None:
    """Rank AUC (Mann-Whitney, ties averaged). None when it is undefined (empty / one class)."""
    if not p:
        return None
    s = pd.DataFrame({"p": p, "y": [bool(v) for v in y]})
    n_pos = int(s["y"].sum())
    n_neg = len(s) - n_pos
    if n_pos == 0 or n_neg == 0:
        return None
    ranks = s["p"].rank(method="average")
    return float((ranks[s["y"]].sum() - n_pos * (n_pos + 1) / 2) / (n_pos * n_neg))


def demotion_verdict(auc: float | None, n: int | None) -> str:
    """'demote' only on enough data AND a defined AUC below the floor; anything else is 'keep'
    or 'insufficient'. Missing data can never demote."""
    if n is None or auc is None or n < LIVE_MIN_N or not math.isfinite(auc):
        return "insufficient"
    return "demote" if auc < LIVE_AUC_FLOOR else "keep"
FEATURE_LOOKBACK = timedelta(days=45)      # calendar days of 1m bars the features need
OUTCOME_LOOKBACK = timedelta(days=100)     # ≥ 60 prior sessions for the trailing-median threshold
GAP_WINDOW = timedelta(minutes=30)
MAX_GAP = timedelta(minutes=2)
FRESH = timedelta(minutes=10)
ONE_MIN = timedelta(minutes=1)
# Stale-bar retry (prod 2026-10-23: the API's 1m refresh was throttled and 8 runs were skipped, two
# during a 180-point spike). A run whose newest bar is at most this far behind waits once and re-reads.
STALE_RETRY_WITHIN = timedelta(minutes=10)
STALE_RETRY_WAIT_S = 30.0


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
    live: dict[str, dict[str, dict[str, Any]]] = field(default_factory=dict)
    demotion_checked_on: Any = None
    sleep: Callable[[float], None] = time.sleep

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
        self.refresh_live(demote=False)

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

    # ------------------------------------------------------------ live tracking + demotion

    def refresh_live(self, demote: bool) -> dict[str, dict[str, dict[str, Any]]]:
        """Live AUC per loaded (instrument, horizon) over the last LIVE_WINDOW. With `demote`,
        a horizon with >= LIVE_MIN_N usable outcomes and AUC < LIVE_AUC_FLOOR is switched off in
        the registry and unloaded. A read failure records no stats and never demotes."""
        now = self.now()
        since = now - LIVE_WINDOW
        day = clock.to_ist(now).date()
        live: dict[str, dict[str, dict[str, Any]]] = {}
        for inst, models in self.models.items():
            live[inst] = {}
            for h, lm in list(models.items()):
                entry: dict[str, Any] = {"auc": None, "n": None, "modelId": lm.model_id,
                                         "checkedAt": _iso(now)}
                live[inst][h] = entry
                if self.repo is None:
                    continue
                try:
                    rows = self.repo.live_outcomes(inst, h, lm.model_id, since)
                except Exception as exc:
                    log.error("[mbm] live outcomes %s %s unreadable: %s (no action)", inst, h, exc)
                    entry["error"] = "unreadable"
                    continue
                p, y = [], []
                for r in rows:
                    pv = _num(r.get("p"))
                    if pv is None or r.get("outcome_big") is None:
                        continue
                    p.append(pv)
                    y.append(bool(r["outcome_big"]))
                auc = live_auc(p, y)
                entry.update({"auc": None if auc is None else round(auc, 4), "n": len(p)})
                verdict = demotion_verdict(auc, len(p))
                if not demote:
                    continue
                if verdict == "insufficient":
                    log.info("[mbm] live %s %s: n=%d auc=%s < %d usable rows or undefined: no action",
                             inst, h, len(p), entry["auc"], LIVE_MIN_N)
                    continue
                if verdict == "keep":
                    log.info("[mbm] live %s %s: auc %.3f over %d: keep", inst, h, auc, len(p))
                    continue
                reason = f"DEMOTED {day.isoformat()} live AUC {auc:.3f} over {len(p)}"
                try:
                    done = self.repo.demote_model(lm.model_id, reason)
                except Exception as exc:
                    log.error("[mbm] demote %s %s (%s) failed: %s (still served)", inst, h, lm.model_id, exc)
                    continue
                if not done:
                    log.warning("[mbm] demote %s %s: %s was no longer active in ai_models (still loaded; "
                                "restart to pick up the registry)", inst, h, lm.model_id)
                    continue
                models.pop(h, None)
                entry["demoted"] = reason
                log.warning("[mbm] %s: %s %s %s unloaded", reason, inst, h, lm.model_id)
        self.live = live
        return live

    def check_demotions(self) -> None:
        """The once-a-day (after 15:45 IST) demotion pass; idempotent per IST date."""
        n = clock.to_ist(self.now())
        if self.demotion_checked_on == n.date() or n.time() < clock.DEMOTION_CHECK:
            return
        self.refresh_live(demote=True)
        self.demotion_checked_on = n.date()

    # ------------------------------------------------------------ prediction

    def predict_once(self, instrument: str, as_of: datetime) -> list[dict[str, Any]]:
        """Build features up to `as_of` and return the prediction rows (empty if stale/no models).
        When the newest 1m bar is behind by at most STALE_RETRY_WITHIN, waits STALE_RETRY_WAIT_S once
        and re-reads (the API's bar refresh retries a throttled fetch within seconds) before skipping."""
        models = self.models.get(instrument) or {}
        if not models or self.repo is None:
            return []
        as_of_ts = pd.Timestamp(as_of).tz_convert("UTC")
        rows, newest = self._predict_attempt(instrument, as_of_ts, models)
        if rows is not None:
            return rows
        lag = None if newest is None else (as_of_ts - ONE_MIN) - newest
        if lag is None or lag > STALE_RETRY_WITHIN:
            log.info("[mbm] %s %s stale: newest 1m bar %s (%s): skipped", instrument, _iso(as_of_ts),
                     None if newest is None else _iso(newest),
                     "no bars" if newest is None else f"{int(lag.total_seconds() // 60)} min behind, > "
                     f"{int(STALE_RETRY_WITHIN.total_seconds() // 60)}: no retry")
            return []
        log.info("[mbm] %s %s stale: newest 1m bar %s: retrying once in %.0f s", instrument, _iso(as_of_ts),
                 _iso(newest), STALE_RETRY_WAIT_S)
        self.sleep(STALE_RETRY_WAIT_S)
        rows, newest2 = self._predict_attempt(instrument, as_of_ts, models)
        if rows is not None:
            log.info("[mbm] %s %s: fresh after the retry", instrument, _iso(as_of_ts))
            return rows
        log.info("[mbm] %s %s stale after a %.0f s retry: newest 1m bar %s: skipped", instrument,
                 _iso(as_of_ts), STALE_RETRY_WAIT_S, None if newest2 is None else _iso(newest2))
        return []

    def _predict_attempt(self, instrument: str, as_of_ts: pd.Timestamp,
                         models: dict[str, LoadedModel]) -> tuple[list[dict[str, Any]] | None, pd.Timestamp | None]:
        """(rows, newest bar ts). rows is None when the instrument's 1m bars are stale (retryable);
        [] when the bars are fresh but no feature row could be built."""
        bars = self.repo.bars(universe(instrument), (as_of_ts - FEATURE_LOOKBACK).to_pydatetime(),
                              as_of_ts.to_pydatetime())   # ts < as_of: never a bar still forming
        inputs = build_inputs(bars, instrument, self.global_daily)
        inst = inputs["instrument"]
        newest = None if inst.empty else pd.Timestamp(inst["ts"].iloc[-1]).tz_convert("UTC")
        if newest is None or newest != as_of_ts - ONE_MIN:
            return None, newest
        feats = build_features(inputs)
        if feats.empty or feats.index[-1] != as_of_ts:
            log.info("[mbm] %s %s stale: newest feature row %s", instrument, _iso(as_of_ts),
                     None if feats.empty else _iso(feats.index[-1]))
            return [], newest
        row = feats.iloc[[-1]]
        quality = "gap" if has_gap(inst, as_of_ts) else ("drivers_missing" if _drivers_missing(inputs, as_of_ts) else "ok")
        out = []
        for h, lm in sorted(models.items()):
            pr = lm.model.predict(row).iloc[0]
            q50 = _num(pr.get("q50_bp"))
            try:
                ref = R.ref_range_bp(inst, as_of_ts, h)
            except Exception as exc:   # the relative reading is an add-on: never costs the prediction
                log.warning("[mbm] %s %s %s reference range failed: %s", instrument, _iso(as_of_ts), h, exc)
                ref = None
            ratio, label = R.relative(q50, ref)
            out.append({
                "instrument": instrument, "horizon": h, "as_of": as_of_ts.to_pydatetime(),
                "p": float(pr["p"]), "regime": str(pr["regime"]),
                "q25_bp": _num(pr.get("q25_bp")), "q50_bp": q50, "q75_bp": _num(pr.get("q75_bp")),
                "model_id": lm.model_id, "feature_set": lm.model.feature_set or FEATURE_SET,
                "data_quality": quality,
                "rel_ratio": None if ratio is None else round(ratio, 4), "rel_label": label,
                "ref_range_bp": None if ref is None else round(ref, 2),
            })
        return out, newest

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
        spot = self._spot(inst, as_of)

        def pts(bp):
            v = R.points(_num(bp), spot)
            return None if v is None else round(v)
        return {
            "instrument": inst, "status": status, "asOf": _iso(as_of),
            "horizons": {r["horizon"]: {
                "p": round(float(r["p"]), 4), "regime": r["regime"],
                "q25Bp": _round(r["q25_bp"]), "q50Bp": _round(r["q50_bp"]), "q75Bp": _round(r["q75_bp"]),
                # Relative reading (vs the last 10 sessions at this minute) and the range in index points.
                "relRatio": _round2(r.get("rel_ratio")), "relLabel": r.get("rel_label"),
                "refRangeBp": _round(r.get("ref_range_bp")),
                "rangePts": [pts(r["q25_bp"]), pts(r["q50_bp"]), pts(r["q75_bp"])],
            } for r in rows},
            "spot": None if spot is None else round(spot, 2),
            "modelIds": {r["horizon"]: r["model_id"] for r in rows},
            "featureSet": rows[0]["feature_set"],
            "dataQuality": next((q for q in rank if q in quality), "ok"),
            "dailySignals": daily,
        }

    def _spot(self, instrument: str, as_of: pd.Timestamp) -> float | None:
        """The instrument's close of the 1m bar just before `as_of` (the spot the prediction saw)."""
        try:
            bars = self.repo.bars([instrument], (as_of - FRESH).to_pydatetime(), as_of.to_pydatetime())
            if bars is None or bars.empty:
                return None
            return _num(bars.sort_values("ts")["close"].iloc[-1])
        except Exception as exc:
            log.warning("[mbm] behaviour %s spot read failed: %s", instrument, exc)
            return None

    def health(self) -> dict[str, Any]:
        return {"ok": True, "models": self.model_summary(),
                "lastRun": None if self.last_run is None else _iso(self.last_run),
                "live": self.live_summary()}

    def live_summary(self) -> dict[str, dict[str, Any]]:
        """`{"30m": {"auc", "n", ...}}` per the M4 contract; with several instruments the keys
        become `"<INSTRUMENT>:<horizon>"`."""
        multi = len(self.live) > 1
        return {(f"{inst}:{h}" if multi else h): dict(v)
                for inst, hs in self.live.items() for h, v in sorted(hs.items())}


def _round(x) -> float | None:
    v = _num(x)
    return None if v is None else round(v, 1)


def _round2(x) -> float | None:
    v = _num(x)
    return None if v is None else round(v, 2)
