"""
Signal scoring service — orchestrates the signal scoring pipeline.
"""

import logging
from typing import Dict, Any

from ..models.signal_scorer import score_signal

logger = logging.getLogger(__name__)


async def score_trade_signal(
    signal: Dict[str, Any],
    market_data: Dict[str, Any],
    multi_timeframe_alignment: int,
    strategy_signal_strength: float,
) -> Dict[str, Any]:
    """Score a trade signal and return confidence metrics.

    Delegates to the signal_scorer model for the weighted ensemble calculation.

    Args:
        signal: Trade signal details.
        market_data: Market data including candles, volume, OI.
        multi_timeframe_alignment: Number of confirming timeframes.
        strategy_signal_strength: Strategy's internal signal strength (0-100).

    Returns:
        Scoring result with confidence_score, confidence_level, breakdown, recommendation.

    Raises:
        ValueError: If required fields are missing from signal or market_data.
    """
    # Validate required fields
    required_signal_fields = ["symbol", "side"]
    for field in required_signal_fields:
        if field not in signal:
            raise ValueError(f"Missing required signal field: {field}")

    if not market_data.get("candles") and market_data.get("volume") is None:
        logger.warning("Scoring signal with no market data — results may be inaccurate")

    result = score_signal(
        signal=signal,
        market_data=market_data,
        multi_tf_alignment=multi_timeframe_alignment,
        strategy_strength=strategy_signal_strength,
    )

    logger.info(
        "Signal scored via service: %s %s → %d (%s)",
        signal.get("symbol"),
        signal.get("side"),
        result["confidence_score"],
        result["confidence_level"],
    )

    return result
