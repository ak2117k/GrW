"""
Market regime detection for the TD Automation AI Engine.
Determines whether the market is trending or ranging using ATR and directional analysis.
"""

import logging
from typing import List, Dict

from .indicators import calculate_atr, _py_mean, _py_isnan

_logger = logging.getLogger(__name__)

try:
    import numpy as np

    _HAS_NUMPY = True
except ImportError:
    np = None  # type: ignore[assignment]
    _HAS_NUMPY = False
    _logger.warning("numpy is not available in market_regime — using pure-Python fallbacks")


def detect_regime(candles: List[dict]) -> Dict:
    """Detect the current market regime (trending vs ranging).

    Uses ATR-based volatility analysis and directional movement to classify
    the market state. High ATR with directional moves indicates trending;
    low ATR with oscillation indicates ranging.

    Args:
        candles: List of candle dicts with 'open', 'high', 'low', 'close', 'volume' keys.
                 Needs at least 20 candles for meaningful detection.

    Returns:
        Dict with keys:
            - regime: 'trending' or 'ranging'
            - strength: 0-100 indicating how strongly the regime is expressed
            - atr: current ATR value
    """
    if len(candles) < 20:
        return {"regime": "ranging", "strength": 50, "atr": 0.0}

    atr_values = calculate_atr(candles, period=14)
    # Get the latest valid ATR
    valid_atrs = [v for v in atr_values if not _py_isnan(v)]
    current_atr = valid_atrs[-1] if valid_atrs else 0.0

    closes = [c["close"] for c in candles]

    # Directional movement: measure net displacement vs total path length
    recent_closes = closes[-20:]
    net_displacement = abs(recent_closes[-1] - recent_closes[0])
    total_path = sum(abs(recent_closes[i] - recent_closes[i - 1]) for i in range(1, len(recent_closes)))

    if total_path == 0:
        efficiency_ratio = 0.0
    else:
        efficiency_ratio = net_displacement / total_path  # 0 = choppy, 1 = perfectly directional

    # ATR relative to price (normalized volatility)
    avg_price = _py_mean(recent_closes)
    if avg_price == 0:
        normalized_atr = 0.0
    else:
        normalized_atr = current_atr / avg_price

    # ADX-like directional strength using +DM/-DM concepts
    plus_dm_sum = 0.0
    minus_dm_sum = 0.0
    for i in range(max(len(candles) - 14, 1), len(candles)):
        up_move = candles[i]["high"] - candles[i - 1]["high"]
        down_move = candles[i - 1]["low"] - candles[i]["low"]
        if up_move > down_move and up_move > 0:
            plus_dm_sum += up_move
        if down_move > up_move and down_move > 0:
            minus_dm_sum += down_move

    dm_total = plus_dm_sum + minus_dm_sum
    if dm_total > 0:
        dx = abs(plus_dm_sum - minus_dm_sum) / dm_total * 100
    else:
        dx = 0.0

    # Combine signals: efficiency ratio + DX
    trending_score = (efficiency_ratio * 60) + (dx / 100 * 40)
    # Clamp to 0-100
    strength = min(100, max(0, int(trending_score * 100)))

    regime = "trending" if strength >= 50 else "ranging"

    return {
        "regime": regime,
        "strength": strength,
        "atr": round(current_atr, 4),
    }


# Strategy-regime compatibility mapping
_TREND_STRATEGIES = {
    "ema-crossover", "ema_crossover", "trend-following", "trend_following",
    "breakout", "momentum", "supertrend",
}
_MEAN_REVERSION_STRATEGIES = {
    "rsi-reversal", "rsi_reversal", "vwap-mean-reversion", "vwap_mean_reversion",
    "bollinger-bounce", "bollinger_bounce", "mean-reversion", "mean_reversion",
}


def regime_score_for_strategy(regime: Dict, strategy_name: str) -> int:
    """Score how well a strategy fits the current market regime.

    Trend-following strategies score higher in trending markets.
    Mean-reversion strategies score higher in ranging markets.

    Args:
        regime: Dict from detect_regime() with 'regime' and 'strength' keys.
        strategy_name: Name of the trading strategy.

    Returns:
        Score from 0 to 100 indicating regime-strategy compatibility.
    """
    regime_type = regime.get("regime", "ranging")
    regime_strength = regime.get("strength", 50)
    strategy_lower = strategy_name.lower().strip()

    is_trend_strategy = strategy_lower in _TREND_STRATEGIES
    is_mr_strategy = strategy_lower in _MEAN_REVERSION_STRATEGIES

    if is_trend_strategy:
        if regime_type == "trending":
            # Higher regime strength = better for trend strategies
            return min(100, 50 + regime_strength // 2)
        else:
            return max(0, 50 - regime_strength // 2)

    if is_mr_strategy:
        if regime_type == "ranging":
            return min(100, 50 + regime_strength // 2)
        else:
            return max(0, 50 - regime_strength // 2)

    # Unknown strategy type: neutral score based on mild regime bias
    return 50
