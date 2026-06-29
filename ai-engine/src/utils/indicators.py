"""
Technical indicator calculations for the TD Automation AI Engine.
Uses numpy/pandas for efficient computation when available,
falls back to pure-Python implementations otherwise.
"""

import logging
import math
from typing import List, Dict, Optional

_logger = logging.getLogger(__name__)

try:
    import numpy as np

    _HAS_NUMPY = True
except ImportError:
    np = None  # type: ignore[assignment]
    _HAS_NUMPY = False
    _logger.warning("numpy is not available — using pure-Python fallbacks for indicators")

try:
    import pandas as pd

    _HAS_PANDAS = True
except ImportError:
    pd = None  # type: ignore[assignment]
    _HAS_PANDAS = False
    _logger.warning("pandas is not available — using pure-Python fallbacks for indicators")


# ---------------------------------------------------------------------------
# Pure-Python helpers (used when numpy/pandas are missing)
# ---------------------------------------------------------------------------

def _py_mean(values: List[float]) -> float:
    """Pure-Python mean."""
    if not values:
        return 0.0
    return sum(values) / len(values)


def _py_isnan(v: float) -> bool:
    """Pure-Python isnan."""
    return math.isnan(v)


# ---------------------------------------------------------------------------
# Public indicator functions
# ---------------------------------------------------------------------------


def calculate_rsi(closes: List[float], period: int = 14) -> List[float]:
    """Calculate Relative Strength Index.

    Args:
        closes: List of closing prices.
        period: RSI lookback period (default 14).

    Returns:
        List of RSI values. First `period` values will be NaN.
    """
    if len(closes) < period + 1:
        return [float("nan")] * len(closes)

    if _HAS_NUMPY:
        prices = np.array(closes, dtype=float)
        deltas = np.diff(prices)
        gains = np.where(deltas > 0, deltas, 0.0)
        losses = np.where(deltas < 0, -deltas, 0.0)
        avg_gain = float(np.mean(gains[:period]))
        avg_loss = float(np.mean(losses[:period]))
    else:
        deltas = [closes[i + 1] - closes[i] for i in range(len(closes) - 1)]
        gains = [d if d > 0 else 0.0 for d in deltas]
        losses = [-d if d < 0 else 0.0 for d in deltas]
        avg_gain = _py_mean(gains[:period])
        avg_loss = _py_mean(losses[:period])

    rsi_values: List[float] = [float("nan")] * period
    if avg_loss == 0:
        rsi_values.append(100.0)
    else:
        rs = avg_gain / avg_loss
        rsi_values.append(100.0 - 100.0 / (1.0 + rs))

    for i in range(period, len(deltas)):
        avg_gain = (avg_gain * (period - 1) + gains[i]) / period
        avg_loss = (avg_loss * (period - 1) + losses[i]) / period
        if avg_loss == 0:
            rsi_values.append(100.0)
        else:
            rs = avg_gain / avg_loss
            rsi_values.append(100.0 - 100.0 / (1.0 + rs))

    return rsi_values


def calculate_ema(values: List[float], period: int) -> List[float]:
    """Calculate Exponential Moving Average.

    Args:
        values: List of price values.
        period: EMA period.

    Returns:
        List of EMA values. First `period - 1` values will be NaN.
    """
    if len(values) < period:
        return [float("nan")] * len(values)

    if _HAS_PANDAS:
        series = pd.Series(values, dtype=float)
        ema = series.ewm(span=period, adjust=False).mean()
        result = ema.tolist()
    else:
        # Pure-Python EMA
        multiplier = 2.0 / (period + 1)
        result: List[float] = list(values)  # copy
        # Seed with SMA of first `period` values
        sma_seed = _py_mean(values[:period])
        result[period - 1] = sma_seed
        for i in range(period, len(values)):
            result[i] = (values[i] - result[i - 1]) * multiplier + result[i - 1]

    # Mark initial values as NaN for consistency
    for i in range(period - 1):
        result[i] = float("nan")
    return result


def calculate_sma(values: List[float], period: int) -> List[float]:
    """Calculate Simple Moving Average.

    Args:
        values: List of price values.
        period: SMA period.

    Returns:
        List of SMA values. First `period - 1` values will be NaN.
    """
    if len(values) < period:
        return [float("nan")] * len(values)

    if _HAS_PANDAS:
        series = pd.Series(values, dtype=float)
        sma = series.rolling(window=period).mean()
        return sma.tolist()
    else:
        result: List[float] = [float("nan")] * (period - 1)
        for i in range(period - 1, len(values)):
            window = values[i - period + 1 : i + 1]
            result.append(_py_mean(window))
        return result


def calculate_atr(candles: List[dict], period: int = 14) -> List[float]:
    """Calculate Average True Range.

    Args:
        candles: List of candle dicts with 'high', 'low', 'close' keys.
        period: ATR lookback period (default 14).

    Returns:
        List of ATR values. First `period` values will be NaN.
    """
    if len(candles) < 2:
        return [float("nan")] * len(candles)

    highs = [c["high"] for c in candles]
    lows = [c["low"] for c in candles]
    closes = [c["close"] for c in candles]

    true_ranges: List[float] = [float("nan")]  # First candle has no previous close
    for i in range(1, len(candles)):
        tr = max(
            highs[i] - lows[i],
            abs(highs[i] - closes[i - 1]),
            abs(lows[i] - closes[i - 1]),
        )
        true_ranges.append(tr)

    atr_values: List[float] = [float("nan")] * period
    if len(candles) > period:
        # Initial ATR is SMA of true ranges
        valid_trs = [tr for tr in true_ranges[1 : period + 1] if not _py_isnan(tr)]
        if valid_trs:
            current_atr = _py_mean(valid_trs)
            atr_values.append(current_atr)

            for i in range(period + 1, len(candles)):
                current_atr = (current_atr * (period - 1) + true_ranges[i]) / period
                atr_values.append(current_atr)

    # Pad if needed
    while len(atr_values) < len(candles):
        atr_values.append(float("nan"))

    return atr_values


def calculate_vwap(candles: List[dict]) -> float:
    """Calculate Volume Weighted Average Price for the given candles.

    Args:
        candles: List of candle dicts with 'high', 'low', 'close', 'volume' keys.

    Returns:
        VWAP value as a float. Returns NaN if no volume data.
    """
    if not candles:
        return float("nan")

    total_volume = 0.0
    cumulative_tp_volume = 0.0

    for c in candles:
        typical_price = (c["high"] + c["low"] + c["close"]) / 3.0
        volume = c.get("volume", 0)
        cumulative_tp_volume += typical_price * volume
        total_volume += volume

    if total_volume == 0:
        return float("nan")

    return cumulative_tp_volume / total_volume


def calculate_bollinger_bands(
    closes: List[float], period: int = 20, std_dev: float = 2.0
) -> Dict[str, List[float]]:
    """Calculate Bollinger Bands.

    Args:
        closes: List of closing prices.
        period: SMA period for the middle band (default 20).
        std_dev: Number of standard deviations for upper/lower bands (default 2.0).

    Returns:
        Dict with 'upper', 'middle', 'lower' lists of float values.
    """
    middle = calculate_sma(closes, period)

    if _HAS_PANDAS:
        series = pd.Series(closes, dtype=float)
        rolling_std = series.rolling(window=period).std().tolist()
    else:
        # Pure-Python rolling standard deviation
        rolling_std: List[float] = [float("nan")] * (period - 1)
        for i in range(period - 1, len(closes)):
            window = closes[i - period + 1 : i + 1]
            mean = _py_mean(window)
            variance = sum((x - mean) ** 2 for x in window) / (len(window) - 1) if len(window) > 1 else 0.0
            rolling_std.append(math.sqrt(variance))

    upper: List[float] = []
    lower: List[float] = []
    for i in range(len(closes)):
        m = middle[i]
        s = rolling_std[i] if i < len(rolling_std) else float("nan")
        if _py_isnan(m) or _py_isnan(s):
            upper.append(float("nan"))
            lower.append(float("nan"))
        else:
            upper.append(m + std_dev * s)
            lower.append(m - std_dev * s)

    return {"upper": upper, "middle": middle, "lower": lower}
