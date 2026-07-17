"""
Pattern-quality feature engineering for the TD Automation AI Engine.

DISTINCT from the signal ``feature_engineer.py``. Turns a single labeled
``pattern_observation`` (as exported by NestJS) into a FLAT dict of numeric
features suitable for the pattern-quality XGBoost scorer.

The SAME ``extract_features`` runs at train time and at serve time — this is
what guarantees no train/serve skew (the recurring failure mode the design
spec guards against). It is a pure function of the raw inputs:

  * ``candleWindow`` — Bucket B features (RSI, EMA gap, volume, ATR, wicks,
    body/range, position-in-range, gap presence).
  * ``detectionContext`` — Bucket A features (mtf / sr / sector). ``null`` in
    the backfill dataset → every Bucket A feature is ``NaN``. We do NOT impute;
    XGBoost handles missing natively, so context-null (backfill) and
    context-rich (scan) rows train together and the model sharpens as rich
    rows arrive.

Identity fields (patternName / category / bias / timeframe) are integer-encoded
via FIXED module-level maps so the encoding is identical at train and serve
time. Unknown values encode to ``-1``.
"""

import math
from typing import Any, Dict, List, Optional

# Reuse the shared indicator library. Support both package import (when the
# ai-engine package is importable) and flat import (when ``src`` is on sys.path,
# e.g. the standalone training script).
try:  # pragma: no cover - import shim
    from ..utils.indicators import calculate_rsi, calculate_ema, calculate_atr
except ImportError:  # pragma: no cover - import shim
    from utils.indicators import calculate_rsi, calculate_ema, calculate_atr


_NAN = float("nan")

# --------------------------------------------------------------------------- #
# Fixed identity encodings (train/serve consistent). Unknown -> -1.
# --------------------------------------------------------------------------- #
_PATTERN_MAP: Dict[str, int] = {
    "BULLISH_ENGULFING": 0,
    "BEARISH_ENGULFING": 1,
    "HAMMER": 2,
    "SHOOTING_STAR": 3,
    "DOJI": 4,
    "DOUBLE_TOP": 5,
    "DOUBLE_BOTTOM": 6,
}
_CATEGORY_MAP: Dict[str, int] = {"CANDLESTICK": 0, "CHART": 1}
_BIAS_MAP: Dict[str, int] = {"BEARISH": -1, "NEUTRAL": 0, "BULLISH": 1}
_TIMEFRAME_MAP: Dict[str, int] = {
    "1m": 0,
    "3m": 1,
    "5m": 2,
    "15m": 3,
    "30m": 4,
    "1h": 5,
    "4h": 6,
    "1d": 7,
    "1w": 8,
}


def _encode(value: Optional[str], mapping: Dict[str, int]) -> int:
    """Integer-encode a categorical against a fixed map; unknown -> -1."""
    if value is None:
        return -1
    return mapping.get(str(value), -1)


def _f(value: Any) -> float:
    """Coerce to float, returning NaN on None / bad values."""
    if value is None:
        return _NAN
    try:
        f = float(value)
    except (TypeError, ValueError):
        return _NAN
    return f


def _safe_div(num: float, den: float) -> float:
    """Divide, returning NaN when the denominator is ~0 or inputs are NaN."""
    if den is None or num is None:
        return _NAN
    if math.isnan(num) or math.isnan(den) or den == 0:
        return _NAN
    return num / den


def _last_valid(values: List[float]) -> float:
    """Return the last non-NaN value, or NaN if none exist."""
    for v in reversed(values):
        if v is not None and not (isinstance(v, float) and math.isnan(v)):
            return float(v)
    return _NAN


# --------------------------------------------------------------------------- #
# Bucket B — pure functions of the candle window
# --------------------------------------------------------------------------- #
def _bucket_b(window: List[Dict[str, Any]]) -> Dict[str, float]:
    """Compute Bucket B (candle-window) features. NaN for anything undefined."""
    feats: Dict[str, float] = {
        "b_rsi14": _NAN,
        "b_ema_gap_pct": _NAN,
        "b_volume_ratio": _NAN,
        "b_atr_pct_of_price": _NAN,
        "b_atr_percentile": _NAN,
        "b_body_range_ratio": _NAN,
        "b_upper_wick_ratio": _NAN,
        "b_lower_wick_ratio": _NAN,
        "b_position_in_range": _NAN,
        "b_gap_pct": _NAN,
        "b_window_len": _NAN,
    }
    if not window:
        return feats

    # Normalise candle dicts.
    candles = [
        {
            "open": _f(c.get("open")),
            "high": _f(c.get("high")),
            "low": _f(c.get("low")),
            "close": _f(c.get("close")),
            "volume": _f(c.get("volume")),
        }
        for c in window
    ]
    n = len(candles)
    feats["b_window_len"] = float(n)
    closes = [c["close"] for c in candles]
    highs = [c["high"] for c in candles]
    lows = [c["low"] for c in candles]
    volumes = [c["volume"] for c in candles]
    anchor = candles[-1]

    # RSI(14) — last value.
    feats["b_rsi14"] = _last_valid(calculate_rsi(closes, period=14))

    # EMA gap %: (EMA9 - EMA21) / EMA21 * 100  (last values).
    ema9 = _last_valid(calculate_ema(closes, period=9))
    ema21 = _last_valid(calculate_ema(closes, period=21))
    gap = _safe_div(ema9 - ema21, ema21)
    feats["b_ema_gap_pct"] = gap * 100.0 if not math.isnan(gap) else _NAN

    # Volume ratio: anchor volume / mean window volume.
    valid_vols = [v for v in volumes if not math.isnan(v)]
    if valid_vols:
        mean_vol = sum(valid_vols) / len(valid_vols)
        feats["b_volume_ratio"] = _safe_div(anchor["volume"], mean_vol)

    # ATR(14): normalise by anchor close, and percentile of the last ATR
    # within the window's ATR series.
    atr_series = calculate_atr(candles, period=14)
    valid_atrs = [a for a in atr_series if not math.isnan(a)]
    last_atr = _last_valid(atr_series)
    if not math.isnan(last_atr):
        feats["b_atr_pct_of_price"] = _safe_div(last_atr, anchor["close"]) * 100.0
        if len(valid_atrs) >= 2:
            below = sum(1 for a in valid_atrs if a <= last_atr)
            feats["b_atr_percentile"] = below / len(valid_atrs)

    # Anchor candle geometry.
    a_range = anchor["high"] - anchor["low"]
    if not math.isnan(a_range) and a_range > 0:
        body = abs(anchor["close"] - anchor["open"])
        upper_wick = anchor["high"] - max(anchor["open"], anchor["close"])
        lower_wick = min(anchor["open"], anchor["close"]) - anchor["low"]
        feats["b_body_range_ratio"] = body / a_range
        feats["b_upper_wick_ratio"] = max(0.0, upper_wick) / a_range
        feats["b_lower_wick_ratio"] = max(0.0, lower_wick) / a_range

    # Position-in-range: anchor close within window hi/lo, 0..1.
    valid_h = [h for h in highs if not math.isnan(h)]
    valid_l = [l for l in lows if not math.isnan(l)]
    if valid_h and valid_l:
        win_hi = max(valid_h)
        win_lo = min(valid_l)
        span = win_hi - win_lo
        if span > 0 and not math.isnan(anchor["close"]):
            feats["b_position_in_range"] = (anchor["close"] - win_lo) / span

    # Gap presence: anchor open vs previous close, as signed %.
    if n >= 2:
        prev_close = candles[-2]["close"]
        feats["b_gap_pct"] = _safe_div(anchor["open"] - prev_close, prev_close) * 100.0

    return feats


# --------------------------------------------------------------------------- #
# Bucket A — from detectionContext (NaN when absent)
# --------------------------------------------------------------------------- #
def _dir_to_num(value: Any) -> float:
    """Map a direction-ish value to +1 / -1 / 0, else NaN."""
    if value is None:
        return _NAN
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if value > 0:
            return 1.0
        if value < 0:
            return -1.0
        return 0.0
    s = str(value).strip().upper()
    if s in ("UP", "BULLISH", "LONG", "POSITIVE", "+1", "1"):
        return 1.0
    if s in ("DOWN", "BEARISH", "SHORT", "NEGATIVE", "-1"):
        return -1.0
    if s in ("FLAT", "NEUTRAL", "NONE", "0"):
        return 0.0
    return _NAN


def _bool_to_num(value: Any) -> float:
    """Map a boolean-ish value to 1.0 / 0.0, else NaN."""
    if value is None:
        return _NAN
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    if isinstance(value, (int, float)):
        return 1.0 if value else 0.0
    s = str(value).strip().upper()
    if s in ("TRUE", "YES", "1"):
        return 1.0
    if s in ("FALSE", "NO", "0"):
        return 0.0
    return _NAN


def _bucket_a(ctx: Optional[Dict[str, Any]]) -> Dict[str, float]:
    """Compute Bucket A (detectionContext) features. All NaN when ctx is None.

    Wired to work whenever a context object is present, tolerating both nested
    ({"mtf": {"aligned": ...}}) and flat ("mtf_aligned") shapes.
    """
    feats: Dict[str, float] = {
        "a_mtf_aligned": _NAN,
        "a_mtf_direction": _NAN,
        "a_sr_distance_atr": _NAN,
        "a_sr_at_level": _NAN,
        "a_sector_alignment": _NAN,
    }
    if not ctx or not isinstance(ctx, dict):
        return feats

    def nested(section: str, key: str, flat: str) -> Any:
        sec = ctx.get(section)
        if isinstance(sec, dict) and key in sec:
            return sec.get(key)
        return ctx.get(flat)

    feats["a_mtf_aligned"] = _bool_to_num(nested("mtf", "aligned", "mtf_aligned"))
    feats["a_mtf_direction"] = _dir_to_num(nested("mtf", "direction", "mtf_direction"))
    feats["a_sr_distance_atr"] = _f(nested("sr", "distanceAtr", "sr_distanceAtr"))
    feats["a_sr_at_level"] = _bool_to_num(nested("sr", "atLevel", "sr_atLevel"))

    # Sector alignment can arrive as sector.alignment or be derived from
    # sector.trend; prefer an explicit alignment value.
    sector_align = nested("sector", "alignment", "sector_alignment")
    if sector_align is None:
        sector_align = nested("sector", "trend", "sector_trend")
    feats["a_sector_alignment"] = _dir_to_num(sector_align)

    return feats


# --------------------------------------------------------------------------- #
# Public entry point
# --------------------------------------------------------------------------- #
def extract_features(obs: Dict[str, Any]) -> Dict[str, float]:
    """Extract a FLAT dict of numeric features from one observation.

    Args:
        obs: A pattern observation dict with keys ``patternName``, ``category``,
             ``bias``, ``timeframe``, ``atrAtDetection``, ``candleWindow`` and
             optional ``detectionContext``.

    Returns:
        Flat ``dict[str, float]`` of features. NaN is used for any feature that
        is undefined for this row (e.g. all Bucket A features when
        ``detectionContext`` is null). Not imputed — XGBoost handles missing.
    """
    feats: Dict[str, float] = {}

    # Identity (fixed integer encodings).
    feats["id_pattern"] = float(_encode(obs.get("patternName"), _PATTERN_MAP))
    feats["id_category"] = float(_encode(obs.get("category"), _CATEGORY_MAP))
    feats["id_bias"] = float(_encode(obs.get("bias"), _BIAS_MAP))
    feats["id_timeframe"] = float(_encode(obs.get("timeframe"), _TIMEFRAME_MAP))

    # ATR captured at detection time (stored on the observation).
    feats["atr_at_detection"] = _f(obs.get("atrAtDetection"))

    # Bucket B (candle window) + Bucket A (detection context).
    feats.update(_bucket_b(obs.get("candleWindow") or []))
    feats.update(_bucket_a(obs.get("detectionContext")))

    return feats


# Ordered feature name list (stable column order for train/serve).
FEATURE_NAMES: List[str] = [
    "id_pattern",
    "id_category",
    "id_bias",
    "id_timeframe",
    "atr_at_detection",
    "b_rsi14",
    "b_ema_gap_pct",
    "b_volume_ratio",
    "b_atr_pct_of_price",
    "b_atr_percentile",
    "b_body_range_ratio",
    "b_upper_wick_ratio",
    "b_lower_wick_ratio",
    "b_position_in_range",
    "b_gap_pct",
    "b_window_len",
    "a_mtf_aligned",
    "a_mtf_direction",
    "a_sr_distance_atr",
    "a_sr_at_level",
    "a_sector_alignment",
]
