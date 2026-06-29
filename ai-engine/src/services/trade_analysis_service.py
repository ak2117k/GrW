"""
Trade analysis service — orchestrates post-trade analysis.
"""

import logging
from typing import Dict, Any

from ..models.trade_analyzer import analyze_trade

logger = logging.getLogger(__name__)


async def analyze_completed_trade(
    trade: Dict[str, Any],
    market_context: Dict[str, Any],
) -> Dict[str, Any]:
    """Analyze a completed trade for the self-learning feedback loop.

    Args:
        trade: Trade details including symbol, side, entry/exit prices, pnl, strategy.
        market_context: Market context at time of trade.

    Returns:
        Analysis result with outcome details, score, and detected patterns.

    Raises:
        ValueError: If required trade fields are missing.
    """
    required_fields = ["symbol", "side", "entry_price", "exit_price", "pnl"]
    for field in required_fields:
        if field not in trade:
            raise ValueError(f"Missing required trade field: {field}")

    result = analyze_trade(trade, market_context)

    logger.info(
        "Trade analyzed via service: %s %s → outcome=%s score=%.1f",
        trade.get("symbol"),
        trade.get("strategy"),
        result["analysis"]["outcome"],
        result["score"],
    )

    return result
