"""
Feature engineering service for the TD Automation AI Engine.

Extracts a 14-feature vector from a trade signal and market snapshot
for XGBoost training and inference.
"""

import logging
import math
from datetime import datetime, timezone, timedelta
from typing import List, Dict, Optional, Tuple

from ..utils.indicators import (
    calculate_rsi,
    calculate_ema,
    calculate_atr,
    calculate_vwap,
    _py_isnan,
)
from ..utils.market_regime import detect_regime

_logger = logging.getLogger(__name__)

# IST offset from UTC
_IST = timedelta(hours=5, minutes=30)

# Strategy one-hot encoding order
_STRATEGY_NAMES = ["rsi-reversal", "ema-crossover", "vwap-deviation"]

# All 14 feature names in order
FEATURE_NAMES = [
    "rsi",
    "ema_gap_pct",
    "vwap_deviation_pct",
    "volume_ratio",
    "atr_ratio",
    "oi_alignment",
    "hour_of_day",
    "day_of_week",
    "strategy_rsi_reversal",
    "strategy_ema_crossover",
    "strategy_vwap_deviation",
    "market_regime",
    "risk_reward_ratio",
    "candle_pattern",
    "spread_from_hl_pct",
    "signal_agreement_count",
]

# Default feature config — all features enabled
_DEFAULT_CONFIG: Dict[str, bool] = {name: True for name in FEATURE_NAMES}


def _safe_float(value, default: float = 0.0) -> float:
    """Convert a value to float, returning default if None, NaN, or invalid."""
    if value is None:
        return default
    try:
        v = float(value)
        return default if math.isnan(v) else v
    except (TypeError, ValueError):
        return default


def _get_closes(candles: List[dict]) -> List[float]:
    """Extract close prices from candle dicts."""
    return [float(c.get("close", 0)) for c in candles]


def _compute_rsi(candles: List[dict], period: int = 14) -> float:
    """Compute the latest RSI value from candles."""
    closes = _get_closes(candles)
    if len(closes) < period + 1:
        return 50.0  # neutral default
    rsi_values = calculate_rsi(closes, period)
    # Return last valid RSI
    for v in reversed(rsi_values):
        if not _py_isnan(v):
            return v
    return 50.0


def _compute_ema_gap_pct(candles: List[dict], fast: int = 9, slow: int = 21) -> float:
    """Compute EMA gap (fast - slow) as a percentage of price."""
    closes = _get_closes(candles)
    if len(closes) < slow:
        return 0.0
    ema_fast = calculate_ema(closes, fast)
    ema_slow = calculate_ema(closes, slow)
    fast_val = _safe_float(ema_fast[-1])
    slow_val = _safe_float(ema_slow[-1])
    if slow_val == 0:
        return 0.0
    return ((fast_val - slow_val) / slow_val) * 100.0


def _compute_vwap_deviation_pct(candles: List[dict], ltp: float) -> float:
    """Compute how far the last traded price is from VWAP as a percentage."""
    vwap = calculate_vwap(candles)
    vwap = _safe_float(vwap)
    if vwap == 0:
        return 0.0
    return ((ltp - vwap) / vwap) * 100.0


def _compute_volume_ratio(candles: List[dict], lookback: int = 20) -> float:
    """Compute current volume relative to the 20-bar average volume."""
    volumes = [float(c.get("volume", 0)) for c in candles]
    if not volumes:
        return 1.0
    current_vol = volumes[-1]
    avg_window = volumes[-lookback:] if len(volumes) >= lookback else volumes
    avg_vol = sum(avg_window) / len(avg_window) if avg_window else 1.0
    if avg_vol == 0:
        return 1.0
    return current_vol / avg_vol


def _compute_atr_ratio(candles: List[dict], short_period: int = 7, long_period: int = 14) -> float:
    """Compute ratio of short-period ATR to long-period ATR."""
    if len(candles) < long_period + 1:
        return 1.0
    atr_short = calculate_atr(candles, short_period)
    atr_long = calculate_atr(candles, long_period)
    short_val = _safe_float(atr_short[-1], 0.0)
    long_val = _safe_float(atr_long[-1], 0.0)
    if long_val == 0:
        return 1.0
    return short_val / long_val


def _compute_oi_alignment(signal: dict, oi: float, oi_change: float) -> float:
    """Compute OI change direction alignment with trade side.

    Returns:
        1.0 if aligned (bullish signal + rising OI, bearish signal + falling OI),
       -1.0 if conflicting,
        0.0 if no OI data.
    """
    if oi is None and oi_change is None:
        return 0.0
    oi_change = _safe_float(oi_change, 0.0)
    if oi_change == 0:
        return 0.0

    side = signal.get("side", signal.get("action", "")).upper()
    is_bullish = side in ("BUY", "LONG", "CE")
    is_bearish = side in ("SELL", "SHORT", "PE")

    if is_bullish:
        return 1.0 if oi_change > 0 else -1.0
    elif is_bearish:
        return 1.0 if oi_change < 0 else -1.0
    return 0.0


def _get_time_features(signal: dict) -> Tuple[float, float]:
    """Extract hour of day (IST) and day of week from signal timestamp."""
    ts = signal.get("timestamp") or signal.get("created_at")
    if ts is None:
        now_ist = datetime.now(timezone.utc) + _IST
        return float(now_ist.hour), float(now_ist.weekday())

    if isinstance(ts, str):
        try:
            dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        except ValueError:
            now_ist = datetime.now(timezone.utc) + _IST
            return float(now_ist.hour), float(now_ist.weekday())
    elif isinstance(ts, (int, float)):
        dt = datetime.fromtimestamp(ts, tz=timezone.utc)
    elif isinstance(ts, datetime):
        dt = ts
    else:
        now_ist = datetime.now(timezone.utc) + _IST
        return float(now_ist.hour), float(now_ist.weekday())

    # Convert to IST
    ist_dt = dt + _IST if dt.tzinfo is None else dt.astimezone(timezone(offset=_IST))
    return float(ist_dt.hour), float(ist_dt.weekday())


def _encode_strategy(signal: dict) -> List[float]:
    """One-hot encode the strategy name. Returns 3 floats."""
    strategy = (signal.get("strategy") or signal.get("strategy_name") or "").lower().strip()
    # Normalize underscores to hyphens
    strategy = strategy.replace("_", "-")
    return [1.0 if strategy == name else 0.0 for name in _STRATEGY_NAMES]


def _compute_market_regime(candles: List[dict]) -> float:
    """Detect market regime: 1.0 = trending, 0.0 = ranging."""
    regime = detect_regime(candles)
    return 1.0 if regime.get("regime") == "trending" else 0.0


def _compute_risk_reward(signal: dict) -> float:
    """Compute risk-reward ratio from signal's target and stoploss."""
    entry = _safe_float(signal.get("entry") or signal.get("entry_price"))
    target = _safe_float(signal.get("target") or signal.get("target_price"))
    stoploss = _safe_float(signal.get("stoploss") or signal.get("stop_loss"))

    if entry == 0 or stoploss == 0 or target == 0:
        return 1.0  # default neutral RR

    risk = abs(entry - stoploss)
    reward = abs(target - entry)
    if risk == 0:
        return 1.0
    return reward / risk


def _compute_candle_pattern(candles: List[dict], lookback: int = 3) -> float:
    """Encode the last `lookback` candles' pattern.

    Returns:
        1.0 if all green (close > open),
       -1.0 if all red (close < open),
        0.0 if mixed.
    """
    if len(candles) < lookback:
        return 0.0
    recent = candles[-lookback:]
    greens = sum(1 for c in recent if c.get("close", 0) > c.get("open", 0))
    reds = sum(1 for c in recent if c.get("close", 0) < c.get("open", 0))
    if greens == lookback:
        return 1.0
    if reds == lookback:
        return -1.0
    return 0.0


def _compute_spread_from_hl_pct(candles: List[dict], ltp: float) -> float:
    """Compute how close the LTP is to the day's high/low as a percentage.

    Uses the min(spread from high, spread from low) / range * 100.
    Returns 0 at mid-range, positive near extremes.
    """
    if not candles:
        return 0.0
    day_high = max(c.get("high", 0) for c in candles)
    day_low = min(c.get("low", float("inf")) for c in candles)
    price_range = day_high - day_low
    if price_range == 0:
        return 0.0
    mid = (day_high + day_low) / 2.0
    return ((ltp - mid) / price_range) * 100.0


def extract_features(
    signal: dict,
    market_data: dict,
    config: Optional[Dict[str, bool]] = None,
) -> Dict:
    """Extract a 14-feature vector from a signal and market snapshot.

    Args:
        signal: Trade signal dict with keys like strategy, side, entry, target,
                stoploss, timestamp, agreement_count.
        market_data: Market data dict with keys:
            - candles: List of candle dicts (OHLCV)
            - volume: Current volume (optional, derived from candles if missing)
            - oi: Open interest value (optional)
            - oi_change: OI change value (optional)
            - ltp: Last traded price
        config: Optional dict of feature toggles. Keys are feature names,
                values are booleans. Missing keys default to True (enabled).

    Returns:
        Dict with:
            - features: list of floats (14 values)
            - feature_names: list of strings
            - feature_dict: dict mapping feature name -> value
    """
    cfg = {**_DEFAULT_CONFIG, **(config or {})}

    candles = market_data.get("candles", [])
    ltp = _safe_float(market_data.get("ltp"), 0.0)
    oi = market_data.get("oi")
    oi_change = market_data.get("oi_change")

    # If LTP not provided, use last candle close
    if ltp == 0.0 and candles:
        ltp = _safe_float(candles[-1].get("close"), 0.0)

    # Compute each feature
    rsi = _compute_rsi(candles) if cfg.get("rsi", True) else 0.0
    ema_gap = _compute_ema_gap_pct(candles) if cfg.get("ema_gap_pct", True) else 0.0
    vwap_dev = _compute_vwap_deviation_pct(candles, ltp) if cfg.get("vwap_deviation_pct", True) else 0.0
    vol_ratio = _compute_volume_ratio(candles) if cfg.get("volume_ratio", True) else 0.0
    atr_ratio = _compute_atr_ratio(candles) if cfg.get("atr_ratio", True) else 0.0
    oi_align = _compute_oi_alignment(signal, oi, oi_change) if cfg.get("oi_alignment", True) else 0.0
    hour, day = _get_time_features(signal)
    if not cfg.get("hour_of_day", True):
        hour = 0.0
    if not cfg.get("day_of_week", True):
        day = 0.0
    strategy_enc = _encode_strategy(signal)
    if not cfg.get("strategy_rsi_reversal", True):
        strategy_enc[0] = 0.0
    if not cfg.get("strategy_ema_crossover", True):
        strategy_enc[1] = 0.0
    if not cfg.get("strategy_vwap_deviation", True):
        strategy_enc[2] = 0.0
    regime = _compute_market_regime(candles) if cfg.get("market_regime", True) else 0.0
    rr_ratio = _compute_risk_reward(signal) if cfg.get("risk_reward_ratio", True) else 0.0
    candle_pat = _compute_candle_pattern(candles) if cfg.get("candle_pattern", True) else 0.0
    spread_hl = _compute_spread_from_hl_pct(candles, ltp) if cfg.get("spread_from_hl_pct", True) else 0.0
    agreement = _safe_float(
        signal.get("agreement_count") or signal.get("signal_agreement", 0)
    ) if cfg.get("signal_agreement_count", True) else 0.0

    features = [
        rsi,
        ema_gap,
        vwap_dev,
        vol_ratio,
        atr_ratio,
        oi_align,
        hour,
        day,
        strategy_enc[0],
        strategy_enc[1],
        strategy_enc[2],
        regime,
        rr_ratio,
        candle_pat,
        spread_hl,
        agreement,
    ]

    feature_dict = dict(zip(FEATURE_NAMES, features))

    return {
        "features": features,
        "feature_names": list(FEATURE_NAMES),
        "feature_dict": feature_dict,
    }


def prepare_training_features(
    trades_with_outcomes: List[dict],
) -> Tuple[List[List[float]], List[int]]:
    """Convert a list of completed trades into a feature matrix and target array.

    Each trade dict should contain:
        - signal: the original signal dict
        - market_data: the market snapshot at signal time
        - outcome: 1 (profitable) or 0 (loss)

    Args:
        trades_with_outcomes: List of trade dicts with signal, market_data, and outcome.

    Returns:
        Tuple of (X, y) where:
            X is a list of feature vectors (list of list of floats)
            y is a list of binary outcomes (list of ints)
    """
    X: List[List[float]] = []
    y: List[int] = []

    for i, trade in enumerate(trades_with_outcomes):
        try:
            signal = trade.get("signal", {})
            market_data = trade.get("market_data", {})
            outcome = int(trade.get("outcome", 0))

            result = extract_features(signal, market_data)
            X.append(result["features"])
            y.append(outcome)
        except Exception as e:
            _logger.warning(f"Skipping trade {i} during feature extraction: {e}")
            continue

    _logger.info(f"Prepared {len(X)} training samples from {len(trades_with_outcomes)} trades")
    return X, y
