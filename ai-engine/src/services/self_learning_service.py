"""
Self-learning service — implements the feedback loop from Section 3.8.
Calculates win rates per strategy, time-of-day patterns, and updates scoring weights.
Stores results in a local JSON file (will be moved to DB later).
"""

import json
import logging
import os
from datetime import datetime
from typing import Dict, Any, List, Optional
from pathlib import Path

logger = logging.getLogger(__name__)

# Local storage path for learning data
_DATA_DIR = Path(__file__).resolve().parent.parent.parent / "data"
_LEARNING_FILE = _DATA_DIR / "learning_state.json"


def _ensure_data_dir() -> None:
    """Create the data directory if it doesn't exist."""
    _DATA_DIR.mkdir(parents=True, exist_ok=True)


def _load_state() -> Dict[str, Any]:
    """Load the current learning state from disk.

    Returns:
        Learning state dict, or empty default if file doesn't exist.
    """
    _ensure_data_dir()
    if _LEARNING_FILE.exists():
        try:
            with open(_LEARNING_FILE, "r") as f:
                return json.load(f)
        except (json.JSONDecodeError, IOError) as e:
            logger.error("Failed to load learning state: %s", e)

    return {
        "strategy_stats": {},
        "time_of_day_stats": {},
        "updated_weights": {},
        "last_retrain": None,
        "total_trades_processed": 0,
    }


def _save_state(state: Dict[str, Any]) -> None:
    """Save the learning state to disk.

    Args:
        state: Learning state dict to persist.
    """
    _ensure_data_dir()
    try:
        with open(_LEARNING_FILE, "w") as f:
            json.dump(state, f, indent=2, default=str)
    except IOError as e:
        logger.error("Failed to save learning state: %s", e)


async def retrain(trade_outcomes: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Process a batch of trade outcomes and update strategy performance data.

    Implements the self-learning mechanism from Section 3.8:
    - Recomputes strategy win rates by market condition
    - Identifies time-of-day patterns
    - Generates suggestions for parameter optimization

    Args:
        trade_outcomes: List of dicts, each with:
            - symbol: str
            - side: 'BUY' or 'SELL'
            - strategy: str
            - pnl: float
            - entry_time: str (ISO format)
            - exit_time: str (ISO format)
            - market_regime: str ('trending' or 'ranging')

    Returns:
        Dict with:
            - updated_weights: dict of strategy-level weight adjustments
            - strategy_performance: dict of per-strategy win rate stats
            - time_of_day_patterns: dict of per-hour performance
            - suggestions: list of improvement suggestion strings
            - trades_processed: int
    """
    if not trade_outcomes:
        return {
            "updated_weights": {},
            "strategy_performance": {},
            "time_of_day_patterns": {},
            "suggestions": ["No trades provided for retraining."],
            "trades_processed": 0,
        }

    state = _load_state()

    strategy_stats: Dict[str, Dict[str, Any]] = state.get("strategy_stats", {})
    tod_stats: Dict[str, Dict[str, int]] = state.get("time_of_day_stats", {})

    for trade in trade_outcomes:
        strategy = trade.get("strategy", "unknown")
        pnl = trade.get("pnl", 0)
        is_win = pnl > 0
        market_regime = trade.get("market_regime", "unknown")

        # Strategy stats
        if strategy not in strategy_stats:
            strategy_stats[strategy] = {
                "total": 0,
                "wins": 0,
                "losses": 0,
                "total_pnl": 0.0,
                "by_regime": {},
            }
        stats = strategy_stats[strategy]
        stats["total"] += 1
        stats["wins"] += 1 if is_win else 0
        stats["losses"] += 0 if is_win else 1
        stats["total_pnl"] += pnl

        # By regime breakdown
        if market_regime not in stats["by_regime"]:
            stats["by_regime"][market_regime] = {"total": 0, "wins": 0}
        stats["by_regime"][market_regime]["total"] += 1
        if is_win:
            stats["by_regime"][market_regime]["wins"] += 1

        # Time-of-day stats
        entry_time_str = trade.get("entry_time", "")
        try:
            if isinstance(entry_time_str, str) and entry_time_str:
                entry_time = datetime.fromisoformat(entry_time_str)
                hour_key = str(entry_time.hour)
                if hour_key not in tod_stats:
                    tod_stats[hour_key] = {"total": 0, "wins": 0}
                tod_stats[hour_key]["total"] += 1
                if is_win:
                    tod_stats[hour_key]["wins"] += 1
        except (ValueError, AttributeError):
            pass

    # Compute win rates
    strategy_performance = {}
    for strategy, stats in strategy_stats.items():
        total = stats["total"]
        win_rate = (stats["wins"] / total * 100) if total > 0 else 0
        strategy_performance[strategy] = {
            "total_trades": total,
            "win_rate": round(win_rate, 1),
            "total_pnl": round(stats["total_pnl"], 2),
            "by_regime": {
                regime: {
                    "total": rd["total"],
                    "win_rate": round(rd["wins"] / rd["total"] * 100, 1) if rd["total"] > 0 else 0,
                }
                for regime, rd in stats.get("by_regime", {}).items()
            },
        }

    # Time-of-day patterns
    time_of_day_patterns = {}
    for hour, hstats in tod_stats.items():
        total = hstats["total"]
        win_rate = (hstats["wins"] / total * 100) if total > 0 else 0
        time_of_day_patterns[f"{hour}:00"] = {
            "total_trades": total,
            "win_rate": round(win_rate, 1),
        }

    # Generate suggestions
    suggestions = []
    for strategy, perf in strategy_performance.items():
        if perf["total_trades"] >= 5:
            if perf["win_rate"] < 40:
                suggestions.append(
                    f"Strategy '{strategy}' has a low win rate ({perf['win_rate']}%). "
                    "Consider reducing its weight or reviewing parameters."
                )
            elif perf["win_rate"] > 70:
                suggestions.append(
                    f"Strategy '{strategy}' is performing well ({perf['win_rate']}% win rate). "
                    "Consider increasing its allocation."
                )

            # Regime-specific suggestions
            for regime, rd in perf.get("by_regime", {}).items():
                if rd["total"] >= 3 and rd["win_rate"] < 30:
                    suggestions.append(
                        f"Strategy '{strategy}' performs poorly in {regime} markets "
                        f"({rd['win_rate']}% win rate). Consider disabling in this regime."
                    )

    # Best/worst trading hours
    best_hour = None
    worst_hour = None
    best_wr = -1
    worst_wr = 101
    for hour, pattern in time_of_day_patterns.items():
        if pattern["total_trades"] >= 3:
            if pattern["win_rate"] > best_wr:
                best_wr = pattern["win_rate"]
                best_hour = hour
            if pattern["win_rate"] < worst_wr:
                worst_wr = pattern["win_rate"]
                worst_hour = hour

    if best_hour:
        suggestions.append(
            f"Best trading hour: {best_hour} with {best_wr}% win rate."
        )
    if worst_hour and worst_hour != best_hour:
        suggestions.append(
            f"Worst trading hour: {worst_hour} with {worst_wr}% win rate. "
            "Consider reducing activity during this period."
        )

    if not suggestions:
        suggestions.append("Insufficient data for actionable suggestions. Keep logging trades.")

    # Compute updated weights (simple: boost strategies with high win rates)
    updated_weights = {}
    for strategy, perf in strategy_performance.items():
        if perf["total_trades"] >= 10:
            # Scale historical_performance weight based on actual win rate
            updated_weights[strategy] = {
                "historical_performance_score": min(100, int(perf["win_rate"] * 1.2)),
            }

    # Save state
    state["strategy_stats"] = strategy_stats
    state["time_of_day_stats"] = tod_stats
    state["updated_weights"] = updated_weights
    state["last_retrain"] = datetime.now().isoformat()
    state["total_trades_processed"] = state.get("total_trades_processed", 0) + len(trade_outcomes)
    _save_state(state)

    logger.info(
        "Retrain complete: %d trades processed, %d strategies updated",
        len(trade_outcomes),
        len(strategy_performance),
    )

    return {
        "updated_weights": updated_weights,
        "strategy_performance": strategy_performance,
        "time_of_day_patterns": time_of_day_patterns,
        "suggestions": suggestions,
        "trades_processed": len(trade_outcomes),
    }
