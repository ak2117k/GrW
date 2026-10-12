"""Feature set ``fs1-legacy-checks``: entry-time features from the legacy rule scorer's breakdown.

Input is the ``initialBreakdown`` JSON stored on TD_Automation watch entries
(``{"checks": [{name, passed, points, pointsPossible, detail}, ...]}``) plus an
entry-time context dict. Nothing observed after the decision may be passed in:
``extract`` raises on any key in ``LEAKAGE_FIELDS``.

The legacy scorer ran in two versions: a 10-check one (with "Price vs 20-EMA")
and a 15-check one. The union of both is 16 canonical checks; a check absent
from a row's breakdown is flagged ``<key>_missing = 1`` with ``passed``/``value``
left as None, never imputed here (XGBoost handles NaN natively).

Malformed input (null breakdown, non-list checks, unknown check names) never
raises: unknown names are ignored, anything unusable counts as missing.
"""
from __future__ import annotations

import math
import re
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

FEATURE_SET = "fs1-legacy-checks"

# Canonical check keys. The first 15 are the v15 scorer; price_vs_ema20 only exists in v10 rows.
CHECKS: tuple[str, ...] = (
    "macd_1d", "macd_1m", "macd_5m", "ema9_vs_ema20", "vwap_gap", "adx", "rsi_5m", "atr_pct",
    "volume_ratio", "breakout_20d", "sr_room", "nifty_trend", "sector_trend", "relative_strength",
    "supertrend", "price_vs_ema20",
)

# Raw legacy check names (confirmed against TD_Automation watch_entries / ungated / adaptive,
# 2026-10-12: SELECT DISTINCT jsonb_array_elements("initialBreakdown"->'checks')->>'name').
CHECK_ALIASES: dict[str, str] = {
    "MACD on 1d": "macd_1d",
    "MACD on 1m": "macd_1m",
    "MACD on 5m": "macd_5m",
    "EMA9 over EMA20": "ema9_vs_ema20",
    "VWAP relationship": "vwap_gap",
    "ADX trend strength": "adx",
    "RSI on 5m": "rsi_5m",
    "ATR target feasibility": "atr_pct",
    "Volume confirmation": "volume_ratio",
    "Multi-day breakout confirmation": "breakout_20d",
    "S/R room": "sr_room",
    "Index aligned": "nifty_trend",
    "Sector aligned": "sector_trend",
    "Relative strength": "relative_strength",
    "SuperTrend match": "supertrend",
    "Price vs 20-EMA": "price_vs_ema20",
}

# Post-decision columns: never allowed into features or evidence.
LEAKAGE_FIELDS: frozenset[str] = frozenset({
    "currentPrice", "currentScore", "currentBreakdown", "currentPnl", "maxFavorable", "maxAdverse",
    "closedReason", "closedAt", "exitPrice", "exitTime", "exitReasonTag", "exitNotes", "pnl",
    "pnlPercent", "fees", "status", "lastTickAt", "lastRescoreAt", "lastEventPrice",
    "partialExitedAt", "partialExitPrice", "partialQty", "remainingQty", "trailingHighWater",
    "trailingStopPrice", "slBreachCount", "dismissedAt", "events",
    "current_price", "current_score", "current_breakdown", "current_pnl", "max_favorable",
    "max_adverse", "closed_reason", "closed_at", "exit_price", "exit_time", "pnl_percent",
})

# A check whose detail carries one of these markers had no data to evaluate on.
_MISSING_MARKERS = ("insufficient", "no sector mapping", "no level book", "no session candles")

VIX_REGIMES = ("low", "normal", "elevated", "high")
STRATEGIES = ("gated", "ungated", "adaptive")
TARGET_SOURCES = ("fallback", "indicator_sr", "other")
IST = timezone(timedelta(hours=5, minutes=30))
_FLOAT_RE = re.compile(r"[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?")


def feature_names() -> list[str]:
    names: list[str] = []
    for k in CHECKS:
        names += [f"{k}_passed", f"{k}_value", f"{k}_missing"]
    names += ["scoring_v15", "vix_at_entry", "vix_missing"]
    names += [f"vix_regime_{r}" for r in VIX_REGIMES]
    names += ["ad_ratio", "ad_missing", "minute_of_session", "weekday", "direction_long"]
    names += [f"strategy_{s}" for s in STRATEGIES]
    names += [f"target_src_{t}" for t in TARGET_SOURCES]
    names += ["target_pct"]
    return names


def _num(v: Any) -> float | None:
    if isinstance(v, bool) or v is None:
        return None
    if isinstance(v, (int, float)):
        f = float(v)
        return f if math.isfinite(f) else None
    if isinstance(v, str):
        m = _FLOAT_RE.search(v)
        if m:
            f = float(m.group(0))
            return f if math.isfinite(f) else None
    return None


def parse_value(detail: Any) -> float | None:
    """Generic parse: a number, a dict with ``value``, or the first float in a string."""
    if isinstance(detail, dict):
        return _num(detail.get("value"))
    return _num(detail)


def _rel(a: Any, b: Any) -> float | None:
    a, b = _num(a), _num(b)
    if a is None or b is None or b == 0:
        return None
    return a / b - 1.0


def _macd(d: dict, price: float | None) -> float | None:
    m, s = _num(d.get("macd")), _num(d.get("signal"))
    if m is None or s is None:
        return None
    hist = m - s
    return hist / price * 100.0 if price else hist


def _price_vs_ema20(d: dict, price: float | None) -> float | None:
    if "closeLast" in d:
        return _rel(d.get("closeLast"), d.get("emaNow"))
    return _rel(d.get("ema9"), d.get("ema20"))


def _supertrend(d: dict, price: float | None) -> float | None:
    v = _num(d.get("value"))
    return _rel(price, v) if (v and price) else None


# Per-check extractors for the real legacy detail dicts; values are scale-free where the raw is a price.
_VALUE_EXTRACTORS: dict[str, Callable[[dict, float | None], float | None]] = {
    "macd_1d": _macd,
    "macd_1m": _macd,
    "macd_5m": _macd,
    "ema9_vs_ema20": lambda d, p: _rel(d.get("ema9"), d.get("ema20")),
    "vwap_gap": lambda d, p: _rel(d.get("entryPrice"), d.get("vwap")),
    "adx": lambda d, p: _num(d.get("adx")),
    "rsi_5m": lambda d, p: _num(d.get("rsi")),
    "atr_pct": lambda d, p: _num(d.get("atrPct")),
    "volume_ratio": lambda d, p: _num(d.get("ratio")),
    "breakout_20d": lambda d, p: _num(d.get("ratio")),
    "sr_room": lambda d, p: _num(d.get("ratio")),
    "nifty_trend": lambda d, p: _rel(d.get("emaNow"), d.get("emaThen")),
    "sector_trend": lambda d, p: _rel(d.get("emaNow"), d.get("emaThen")),
    "relative_strength": lambda d, p: _num(d.get("rs")),
    "supertrend": _supertrend,
    "price_vs_ema20": _price_vs_ema20,
}


def _check_value(key: str, detail: Any, price: float | None) -> float | None:
    if isinstance(detail, dict):
        if "value" in detail and key != "supertrend":
            return parse_value(detail)
        try:
            return _VALUE_EXTRACTORS[key](detail, price)
        except (TypeError, ValueError, ZeroDivisionError):
            return None
    return parse_value(detail)


def _is_missing_detail(detail: Any) -> bool:
    text = str(detail).lower() if detail is not None else ""
    return any(m in text for m in _MISSING_MARKERS)


def _to_datetime(v: Any) -> datetime | None:
    if isinstance(v, datetime):
        return v if v.tzinfo else v.replace(tzinfo=timezone.utc)
    if isinstance(v, str):
        try:
            d = datetime.fromisoformat(v.replace("Z", "+00:00"))
        except ValueError:
            return None
        return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
    return None


def _bool01(v: Any) -> int | None:
    if isinstance(v, bool):
        return int(v)
    return None


def _target_src(raw: Any) -> str:
    s = str(raw or "").lower()
    if s.startswith("fallback"):
        return "fallback"
    if s.startswith("indicator"):
        return "indicator_sr"
    return "other"


def extract(breakdown: dict | None, context: dict) -> tuple[dict[str, float | None], list[str]]:
    """Return (features in ``feature_names()`` order, missing canonical check keys)."""
    leaked = sorted(set(context) & LEAKAGE_FIELDS)
    if leaked:
        raise ValueError(f"leakage fields in context: {leaked}")

    price = _num(context.get("initial_price"))
    raw_checks = breakdown.get("checks") if isinstance(breakdown, dict) else None
    if not isinstance(raw_checks, list):
        raw_checks = []
    named = [c for c in raw_checks if isinstance(c, dict) and isinstance(c.get("name"), str)]

    by_key: dict[str, dict] = {}
    for c in named:
        key = CHECK_ALIASES.get(c["name"].strip())
        if key is not None and key not in by_key:
            by_key[key] = c

    out: dict[str, float | None] = {}
    missing: list[str] = []
    for key in CHECKS:
        c = by_key.get(key)
        if c is None or _is_missing_detail(c.get("detail")):
            out[f"{key}_passed"] = None
            out[f"{key}_value"] = None
            out[f"{key}_missing"] = 1
            missing.append(key)
        else:
            out[f"{key}_passed"] = _bool01(c.get("passed"))
            out[f"{key}_value"] = _check_value(key, c.get("detail"), price)
            out[f"{key}_missing"] = 0

    out["scoring_v15"] = 1 if len(named) >= 15 else 0

    vix = _num(context.get("vix_at_entry"))
    out["vix_at_entry"] = vix
    out["vix_missing"] = 1 if vix is None else 0
    regime = str(context.get("vix_regime") or "").lower()
    for r in VIX_REGIMES:
        out[f"vix_regime_{r}"] = 1 if regime == r else 0

    ad = _num(context.get("ad_ratio"))
    out["ad_ratio"] = ad
    out["ad_missing"] = 1 if ad is None else 0

    at = _to_datetime(context.get("decided_at"))
    if at is not None:
        ist = at.astimezone(IST)
        out["minute_of_session"] = float((ist.hour * 60 + ist.minute) - (9 * 60 + 15))
        out["weekday"] = float(ist.weekday())
    else:
        out["minute_of_session"] = None
        out["weekday"] = None

    direction = str(context.get("direction") or "").upper()
    out["direction_long"] = 1 if direction in ("LONG", "BUY") else 0 if direction in ("SHORT", "SELL") else None

    strategy = str(context.get("strategy") or "").lower()
    for s in STRATEGIES:
        out[f"strategy_{s}"] = 1 if strategy == s else 0

    src = _target_src(context.get("profit_target_source"))
    for t in TARGET_SOURCES:
        out[f"target_src_{t}"] = 1 if src == t else 0

    target = _num(context.get("profit_target"))
    out["target_pct"] = abs(target / price - 1.0) if (target is not None and price) else None

    return out, missing
