"""
Signal scoring model implementing Section 3.7 (AI Confidence Scoring) from the platform spec.
Weighted ensemble calculation with 6 factors.
"""

import logging
from typing import Dict, Any, List, Optional

from ..utils.indicators import calculate_sma, _py_mean, _py_isnan
from ..utils.market_regime import detect_regime, regime_score_for_strategy

try:
    import numpy as np

    _HAS_NUMPY = True
except ImportError:
    np = None  # type: ignore[assignment]
    _HAS_NUMPY = False

logger = logging.getLogger(__name__)

# Scoring weights as defined in Section 3.7
WEIGHTS = {
    "strategy_strength": 0.30,
    "multi_timeframe": 0.20,
    "volume_confirmation": 0.15,
    "oi_support": 0.10,
    "historical_performance": 0.15,
    "market_regime": 0.10,
}

# Confidence level thresholds
CONFIDENCE_THRESHOLDS = [
    (90, "VERY_HIGH"),
    (75, "HIGH"),
    (60, "MEDIUM"),
    (40, "LOW"),
]


def _get_confidence_level(score: float) -> str:
    """Map a numeric confidence score to a confidence level string.

    Args:
        score: Confidence score 0-100.

    Returns:
        One of 'VERY_HIGH', 'HIGH', 'MEDIUM', 'LOW', or 'DISCARD'.
    """
    for threshold, level in CONFIDENCE_THRESHOLDS:
        if score >= threshold:
            return level
    return "DISCARD"


def _score_multi_timeframe(alignment: int) -> int:
    """Score multi-timeframe alignment.

    Args:
        alignment: Number of timeframes confirming the signal.

    Returns:
        Score: 0 (1 TF), 50 (2 TFs), 100 (3+ TFs).
    """
    if alignment >= 3:
        return 100
    elif alignment == 2:
        return 50
    else:
        return 0


def _score_volume_confirmation(candles: List[dict], current_volume: Optional[float] = None) -> int:
    """Score volume confirmation by comparing current volume to 20-candle moving average.

    Args:
        candles: List of candle dicts with 'volume' key.
        current_volume: Override for current volume (uses last candle if None).

    Returns:
        Score 0-100. 0 if below average, scales linearly up to 100 at 2x average.
    """
    if not candles or len(candles) < 2:
        return 50  # Neutral if insufficient data

    volumes = [c.get("volume", 0) for c in candles]
    period = min(20, len(volumes) - 1)
    if period < 1:
        return 50

    avg_volume = _py_mean(volumes[-period - 1:-1]) if len(volumes) > period else _py_mean(volumes[:-1])
    if avg_volume <= 0:
        return 50

    vol = current_volume if current_volume is not None else volumes[-1]
    ratio = vol / avg_volume

    if ratio < 1.0:
        return max(0, int(ratio * 50))
    else:
        # Linear scale: 1x avg = 50, 2x avg = 100
        return min(100, int(50 + (ratio - 1.0) * 50))


def _score_oi_support(side: str, oi_change: float) -> int:
    """Score OI support based on alignment with trade direction.

    For BUY: increasing OI (positive change) is supportive.
    For SELL: decreasing OI (negative change) is supportive.

    Args:
        side: 'BUY' or 'SELL'.
        oi_change: Change in open interest.

    Returns:
        100 if OI aligns with trade direction, 0 otherwise.
    """
    side_upper = side.upper()
    if side_upper == "BUY":
        return 100 if oi_change > 0 else 0
    elif side_upper == "SELL":
        return 100 if oi_change < 0 else 0
    return 50


def _get_historical_performance(strategy: str) -> int:
    """Get historical strategy performance score.

    Placeholder returning 65 until wired to database.

    Args:
        strategy: Strategy name.

    Returns:
        Performance score 0-100.
    """
    # TODO: Wire to database to look up actual win rate for this strategy
    return 65


def _generate_recommendation(breakdown: Dict[str, Dict[str, float]], confidence_level: str) -> str:
    """Generate a human-readable recommendation string based on the scoring breakdown.

    Args:
        breakdown: Scoring breakdown dict.
        confidence_level: The confidence level string.

    Returns:
        Human-readable recommendation.
    """
    parts = []

    # Find strong and weak factors
    strong_factors = []
    weak_factors = []
    for factor, data in breakdown.items():
        if data["score"] >= 75:
            strong_factors.append(factor)
        elif data["score"] < 50:
            weak_factors.append(factor)

    factor_labels = {
        "strategy_strength": "strategy signal",
        "multi_timeframe": "multi-timeframe alignment",
        "volume_confirmation": "volume confirmation",
        "oi_support": "OI confirmation",
        "historical_performance": "historical performance",
        "market_regime": "market regime fit",
    }

    if strong_factors:
        labels = [factor_labels.get(f, f) for f in strong_factors]
        parts.append(f"Signal has strong {' and '.join(labels)}.")

    if weak_factors:
        labels = [factor_labels.get(f, f) for f in weak_factors]
        parts.append(f"{' and '.join(labels).capitalize()} could be better.")

    if confidence_level == "DISCARD":
        parts.append("Signal does not meet minimum confidence threshold.")
    elif confidence_level == "VERY_HIGH":
        parts.append("Very high confidence - suitable for automated execution.")

    return " ".join(parts) if parts else "Signal meets baseline criteria."


def score_signal(
    signal: Dict[str, Any],
    market_data: Dict[str, Any],
    multi_tf_alignment: int,
    strategy_strength: float,
) -> Dict[str, Any]:
    """Score a trade signal using a weighted ensemble of 6 factors.

    Implements Section 3.7 of the TD Automation platform spec.

    Args:
        signal: Dict with 'symbol', 'side', 'entry_price', 'target_price',
                'stoploss_price', 'strategy', 'timeframe'.
        market_data: Dict with 'candles' (list of candle dicts), 'volume',
                     'oi', 'oi_change'.
        multi_tf_alignment: Number of timeframes confirming the signal (1-3+).
        strategy_strength: Strategy's internal signal strength score (0-100).

    Returns:
        Dict with:
            - confidence_score: int (0-100)
            - confidence_level: str
            - scoring_breakdown: dict of factor details
            - recommendation: str
    """
    candles = market_data.get("candles", [])
    oi_change = market_data.get("oi_change", 0)
    current_volume = market_data.get("volume")
    side = signal.get("side", "BUY")
    strategy = signal.get("strategy", "unknown")

    # Calculate individual factor scores
    strat_score = min(100, max(0, int(strategy_strength)))
    mtf_score = _score_multi_timeframe(multi_tf_alignment)
    vol_score = _score_volume_confirmation(candles, current_volume)
    oi_score = _score_oi_support(side, oi_change)
    hist_score = _get_historical_performance(strategy)

    # Market regime detection
    regime = detect_regime(candles)
    regime_fit_score = regime_score_for_strategy(regime, strategy)

    # Build breakdown
    scores = {
        "strategy_strength": strat_score,
        "multi_timeframe": mtf_score,
        "volume_confirmation": vol_score,
        "oi_support": oi_score,
        "historical_performance": hist_score,
        "market_regime": regime_fit_score,
    }

    breakdown = {}
    total_weighted = 0.0
    for factor, weight in WEIGHTS.items():
        score = scores[factor]
        weighted = round(weight * score, 2)
        total_weighted += weighted
        breakdown[factor] = {
            "weight": weight,
            "score": score,
            "weighted": weighted,
        }

    confidence_score = min(100, max(0, int(round(total_weighted))))
    confidence_level = _get_confidence_level(confidence_score)
    recommendation = _generate_recommendation(breakdown, confidence_level)

    logger.info(
        "Signal scored: symbol=%s side=%s strategy=%s score=%d level=%s",
        signal.get("symbol"),
        side,
        strategy,
        confidence_score,
        confidence_level,
    )

    return {
        "confidence_score": confidence_score,
        "confidence_level": confidence_level,
        "scoring_breakdown": breakdown,
        "recommendation": recommendation,
    }
