"""
Post-trade analysis model for the TD Automation AI Engine.
Analyzes completed trades to identify what went right, what went wrong,
and patterns for the self-learning feedback loop.
"""

import logging
from datetime import datetime
from typing import Dict, Any, List

logger = logging.getLogger(__name__)

# Known pattern definitions
PATTERNS = {
    "morning_reversal": {
        "description": "Reversal trade in the first hour of market open",
        "time_range": (9, 10),  # 9:00 - 10:00 IST
    },
    "afternoon_momentum": {
        "description": "Momentum trade in the afternoon session",
        "time_range": (13, 15),
    },
    "opening_range_breakout": {
        "description": "Breakout from the first 15-minute range",
        "time_range": (9, 10),
    },
    "volume_spike_entry": {
        "description": "Entry coincided with a volume spike",
    },
    "gap_fill": {
        "description": "Trade captured a gap fill move",
    },
    "late_day_reversal": {
        "description": "Reversal in the last hour of trading",
        "time_range": (14, 15),
    },
}

# Strategy-specific analysis hints
STRATEGY_HINTS = {
    "rsi-reversal": {
        "good_indicators": ["RSI was in oversold/overbought zone at entry"],
        "trailing_suggestion": "Consider trailing stoploss for trending markets",
    },
    "ema-crossover": {
        "good_indicators": ["EMA crossover confirmed direction"],
        "trailing_suggestion": "Use EMA as trailing stoploss level",
    },
    "vwap-mean-reversion": {
        "good_indicators": ["Price was far from VWAP at entry"],
        "trailing_suggestion": "Target VWAP as primary exit point",
    },
}


def _detect_patterns(
    trade: Dict[str, Any],
    market_context: Dict[str, Any],
) -> List[str]:
    """Detect trading patterns from a completed trade.

    Args:
        trade: Trade details dict.
        market_context: Market context at the time of the trade.

    Returns:
        List of detected pattern names.
    """
    patterns = []

    # Parse entry time
    entry_time_str = trade.get("entry_time", "")
    try:
        if isinstance(entry_time_str, str):
            entry_time = datetime.fromisoformat(entry_time_str)
        else:
            entry_time = entry_time_str
        entry_hour = entry_time.hour
    except (ValueError, AttributeError):
        entry_hour = None

    strategy = trade.get("strategy", "").lower()
    side = trade.get("side", "BUY").upper()

    # Time-based patterns
    if entry_hour is not None:
        if 9 <= entry_hour < 10:
            if "reversal" in strategy or "rsi" in strategy:
                patterns.append("morning_reversal")
            else:
                patterns.append("opening_range_breakout")
        elif 13 <= entry_hour < 15:
            if trade.get("pnl", 0) > 0:
                patterns.append("afternoon_momentum")
        elif 14 <= entry_hour < 16:
            patterns.append("late_day_reversal")

    # Volume-based patterns
    volume_at_entry = market_context.get("volume_at_entry", 0)
    candles = market_context.get("candles_at_entry", [])
    if candles and len(candles) >= 5:
        avg_vol = sum(c.get("volume", 0) for c in candles[-5:]) / 5
        if avg_vol > 0 and volume_at_entry > avg_vol * 1.5:
            patterns.append("volume_spike_entry")

    return patterns


def _analyze_outcome(
    trade: Dict[str, Any],
    market_context: Dict[str, Any],
) -> Dict[str, Any]:
    """Analyze what went right and wrong in a trade.

    Args:
        trade: Trade details dict.
        market_context: Market context at time of trade.

    Returns:
        Dict with outcome, what_went_right, what_went_wrong, improvement_suggestions.
    """
    pnl = trade.get("pnl", 0)
    entry_price = trade.get("entry_price", 0)
    exit_price = trade.get("exit_price", 0)
    side = trade.get("side", "BUY").upper()
    strategy = trade.get("strategy", "unknown")
    market_regime = market_context.get("market_regime", "unknown")

    outcome = "profit" if pnl > 0 else ("breakeven" if pnl == 0 else "loss")

    what_went_right = []
    what_went_wrong = []
    improvement_suggestions = []

    # Analyze based on strategy
    hints = STRATEGY_HINTS.get(strategy, {})

    if outcome == "profit":
        what_went_right.append(f"Entry timing was good — {strategy} signal was confirmed")
        if hints.get("good_indicators"):
            what_went_right.extend(hints["good_indicators"])

        # Check if trade captured only a portion of the move
        candles = market_context.get("candles_at_entry", [])
        if candles:
            highs = [c["high"] for c in candles]
            lows = [c["low"] for c in candles]
            if side == "BUY":
                max_possible = max(highs) if highs else exit_price
                if max_possible > exit_price * 1.002:  # More than 0.2% beyond exit
                    what_went_wrong.append(
                        f"Could have held longer — price continued to {max_possible:.0f}"
                    )
            else:
                min_possible = min(lows) if lows else exit_price
                if min_possible < exit_price * 0.998:
                    what_went_wrong.append(
                        f"Could have held longer — price continued to {min_possible:.0f}"
                    )

        # Volume confirmation check
        volume_at_entry = market_context.get("volume_at_entry", 0)
        if volume_at_entry > 0:
            what_went_right.append("Volume confirmed the reversal")

    else:
        what_went_wrong.append(f"Signal from {strategy} did not play out as expected")

        if market_regime == "trending" and ("reversal" in strategy or "mean" in strategy):
            what_went_wrong.append(
                "Mean-reversion strategy used in a trending market — regime mismatch"
            )
            improvement_suggestions.append(
                "Avoid mean-reversion entries when market regime is trending"
            )
        elif market_regime == "ranging" and ("crossover" in strategy or "trend" in strategy):
            what_went_wrong.append(
                "Trend-following strategy used in a ranging market — regime mismatch"
            )
            improvement_suggestions.append(
                "Avoid trend-following entries when market regime is ranging"
            )

    # General improvement suggestions
    if market_regime == "trending":
        improvement_suggestions.append("Consider trailing stoploss for trending markets")
    if hints.get("trailing_suggestion"):
        improvement_suggestions.append(hints["trailing_suggestion"])

    if not what_went_right:
        what_went_right.append("No specific positive factors identified")
    if not what_went_wrong:
        what_went_wrong.append("No obvious issues detected")
    if not improvement_suggestions:
        improvement_suggestions.append("Continue monitoring strategy performance")

    return {
        "outcome": outcome,
        "what_went_right": what_went_right,
        "what_went_wrong": what_went_wrong,
        "improvement_suggestions": improvement_suggestions,
    }


def _calculate_trade_score(
    trade: Dict[str, Any],
    analysis: Dict[str, Any],
) -> float:
    """Calculate an overall trade quality score (0-10).

    Args:
        trade: Trade details dict.
        analysis: Analysis result dict.

    Returns:
        Score from 0.0 to 10.0.
    """
    score = 5.0  # Baseline

    pnl = trade.get("pnl", 0)
    entry_price = trade.get("entry_price", 1)
    pnl_pct = (pnl / entry_price) * 100 if entry_price else 0

    # P&L contribution (+/- up to 2 points)
    if pnl > 0:
        score += min(2.0, pnl_pct * 2)
    else:
        score += max(-2.0, pnl_pct * 2)

    # What went right/wrong balance (+/- up to 1.5 points)
    right_count = len(analysis.get("what_went_right", []))
    wrong_count = len(analysis.get("what_went_wrong", []))
    if right_count > wrong_count:
        score += min(1.5, (right_count - wrong_count) * 0.5)
    elif wrong_count > right_count:
        score -= min(1.5, (wrong_count - right_count) * 0.5)

    # Risk management (+/- up to 1.5 points)
    entry = trade.get("entry_price", 0)
    exit_p = trade.get("exit_price", 0)
    stoploss = trade.get("stoploss_price")
    target = trade.get("target_price")

    if stoploss and target and entry:
        # Did the trade respect stoploss?
        side = trade.get("side", "BUY").upper()
        if side == "BUY" and exit_p < stoploss:
            score -= 1.0  # Exited below stoploss (slippage or no SL)
        elif side == "SELL" and exit_p > stoploss:
            score -= 1.0

    return round(max(0.0, min(10.0, score)), 1)


def analyze_trade(
    trade: Dict[str, Any],
    market_context: Dict[str, Any],
) -> Dict[str, Any]:
    """Perform post-trade analysis on a completed trade.

    Identifies what went right and wrong, detects patterns,
    and provides improvement suggestions for the self-learning loop.

    Args:
        trade: Dict with 'symbol', 'side', 'entry_price', 'exit_price',
               'entry_time', 'exit_time', 'pnl', 'strategy'.
        market_context: Dict with 'candles_at_entry', 'market_regime',
                        'volume_at_entry'.

    Returns:
        Dict with:
            - analysis: dict with outcome, what_went_right, what_went_wrong, improvement_suggestions
            - score: float 0-10 trade quality score
            - patterns_detected: list of pattern name strings
    """
    analysis = _analyze_outcome(trade, market_context)
    patterns = _detect_patterns(trade, market_context)
    score = _calculate_trade_score(trade, analysis)

    logger.info(
        "Trade analyzed: symbol=%s strategy=%s outcome=%s score=%.1f patterns=%s",
        trade.get("symbol"),
        trade.get("strategy"),
        analysis["outcome"],
        score,
        patterns,
    )

    return {
        "analysis": analysis,
        "score": score,
        "patterns_detected": patterns,
    }
