"""
Training orchestration service — manages ML model training pipeline.
Handles bootstrapping training data, XGBoost/RL training, and model evaluation.
"""

import csv
import json
import logging
import os
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

_DATA_DIR = Path(__file__).resolve().parent.parent.parent / "data"
_TRAINING_DIR = _DATA_DIR / "training_data"
_ML_CONFIG_FILE = _DATA_DIR / "ml_config.json"
_BOOTSTRAP_FILE = _TRAINING_DIR / "bootstrap_trades.csv"


def _ensure_dirs() -> None:
    """Create data directories if they don't exist."""
    _DATA_DIR.mkdir(parents=True, exist_ok=True)
    _TRAINING_DIR.mkdir(parents=True, exist_ok=True)


def _load_ml_config() -> Dict[str, Any]:
    """Load ML configuration from disk."""
    _ensure_dirs()
    if _ML_CONFIG_FILE.exists():
        try:
            with open(_ML_CONFIG_FILE, "r") as f:
                return json.load(f)
        except (json.JSONDecodeError, IOError) as e:
            logger.error("Failed to load ML config: %s", e)

    return _default_ml_config()


def _save_ml_config(config: Dict[str, Any]) -> None:
    """Save ML configuration to disk."""
    _ensure_dirs()
    try:
        with open(_ML_CONFIG_FILE, "w") as f:
            json.dump(config, f, indent=2, default=str)
    except IOError as e:
        logger.error("Failed to save ML config: %s", e)


def _default_ml_config() -> Dict[str, Any]:
    """Return the default ML configuration."""
    return {
        "xgboost": {
            "enabled": True,
            "features": {
                "rsi": True,
                "emaGap": True,
                "vwap": True,
                "atr": True,
                "volume_ratio": True,
                "oi_change": True,
            },
            "minTrainingSamples": 200,
            "scoreThreshold": 40,
            "mlBlendRatio": 0.6,
        },
        "finbert": {
            "enabled": True,
            "newsCategories": ["indian", "global", "sector", "company"],
            "sentimentWeight": 20,
            "minConfidence": 0.6,
        },
        "rl": {
            "mode": "observe",
            "maxScoreAdjustment": 20,
            "positionSizeHints": True,
            "episodes": 1000,
            "learningRate": 0.001,
        },
        "training": {
            "schedule": "nightly",
            "dataSources": ["backtest", "paper", "live"],
            "testTrainSplit": 0.2,
        },
    }


def _compute_rsi(closes: List[float], period: int = 14) -> Optional[float]:
    """Compute RSI from a list of closing prices (simple implementation)."""
    if len(closes) < period + 1:
        return None

    gains = []
    losses = []
    for i in range(1, period + 1):
        change = closes[-period - 1 + i] - closes[-period - 1 + i - 1]
        if change > 0:
            gains.append(change)
            losses.append(0.0)
        else:
            gains.append(0.0)
            losses.append(abs(change))

    avg_gain = sum(gains) / period
    avg_loss = sum(losses) / period

    if avg_loss == 0:
        return 100.0
    rs = avg_gain / avg_loss
    return 100.0 - (100.0 / (1.0 + rs))


def _compute_ema(closes: List[float], period: int) -> Optional[float]:
    """Compute EMA of the last value from a list of closing prices."""
    if len(closes) < period:
        return None
    multiplier = 2.0 / (period + 1)
    ema = closes[0]
    for price in closes[1:]:
        ema = (price - ema) * multiplier + ema
    return ema


def _detect_entry_signal(
    closes: List[float], strategy: str
) -> Optional[str]:
    """Detect a simplified entry signal based on strategy type.

    Returns:
        'BUY', 'SELL', or None.
    """
    if strategy == "rsi_reversal":
        rsi = _compute_rsi(closes)
        if rsi is not None:
            if rsi < 30:
                return "BUY"
            elif rsi > 70:
                return "SELL"
    elif strategy == "ema_crossover":
        ema_short = _compute_ema(closes, 9)
        ema_long = _compute_ema(closes, 21)
        if ema_short is not None and ema_long is not None:
            if ema_short > ema_long:
                return "BUY"
            elif ema_short < ema_long:
                return "SELL"
    elif strategy == "vwap_bounce":
        # Simplified: if price is below average of last 20 candles, BUY
        if len(closes) >= 20:
            avg = sum(closes[-20:]) / 20
            if closes[-1] < avg * 0.99:
                return "BUY"
            elif closes[-1] > avg * 1.01:
                return "SELL"
    else:
        # Default: use RSI logic
        rsi = _compute_rsi(closes)
        if rsi is not None:
            if rsi < 30:
                return "BUY"
            elif rsi > 70:
                return "SELL"

    return None


def _extract_features(closes: List[float], volumes: List[float]) -> Dict[str, float]:
    """Extract features at a given point in time for training."""
    features: Dict[str, float] = {}

    rsi = _compute_rsi(closes)
    features["rsi"] = rsi if rsi is not None else 50.0

    ema9 = _compute_ema(closes, 9)
    ema21 = _compute_ema(closes, 21)
    if ema9 is not None and ema21 is not None:
        features["ema_gap"] = ((ema9 - ema21) / ema21) * 100
    else:
        features["ema_gap"] = 0.0

    if len(closes) >= 14:
        true_ranges = []
        for i in range(-13, 0):
            tr = closes[i] - closes[i - 1]
            true_ranges.append(abs(tr))
        features["atr"] = sum(true_ranges) / len(true_ranges) if true_ranges else 0.0
    else:
        features["atr"] = 0.0

    if len(volumes) >= 20:
        avg_vol = sum(volumes[-20:]) / 20
        features["volume_ratio"] = volumes[-1] / avg_vol if avg_vol > 0 else 1.0
    else:
        features["volume_ratio"] = 1.0

    features["close"] = closes[-1] if closes else 0.0

    return features


async def bootstrap_training_data(
    instruments: List[str],
    strategy_names: List[str],
    candle_data: Dict[str, List[Dict[str, Any]]],
) -> Dict[str, Any]:
    """Generate training data by simulating trades on historical candle data.

    For each instrument + strategy combo, walks through candles, detects entry
    signals, simulates trade outcome (target hit vs stoploss within 20 candles).

    Args:
        instruments: List of instrument symbols (e.g. ["NIFTY", "BANKNIFTY"]).
        strategy_names: List of strategy names to simulate.
        candle_data: Dict mapping symbol to list of candle dicts with
                     open, high, low, close, volume keys.

    Returns:
        Dict with total_trades, profitable, unprofitable, file_path.
    """
    _ensure_dirs()

    total_trades = 0
    profitable = 0
    unprofitable = 0
    rows: List[Dict[str, Any]] = []

    for instrument in instruments:
        candles = candle_data.get(instrument, [])
        if len(candles) < 30:
            logger.warning(
                "Insufficient candle data for %s (%d candles), skipping",
                instrument,
                len(candles),
            )
            continue

        closes = [c.get("close", 0.0) for c in candles]
        volumes = [c.get("volume", 0.0) for c in candles]

        for strategy in strategy_names:
            # Walk through candles starting from index 21 (need lookback)
            i = 21
            while i < len(candles) - 20:
                lookback_closes = closes[: i + 1]
                signal = _detect_entry_signal(lookback_closes, strategy)

                if signal is None:
                    i += 1
                    continue

                entry_price = closes[i]
                # Set target and stoploss based on ATR-like measure
                recent_range = max(closes[i - 5 : i + 1]) - min(closes[i - 5 : i + 1])
                if recent_range < 0.01:
                    recent_range = entry_price * 0.01

                if signal == "BUY":
                    target = entry_price + recent_range * 2
                    stoploss = entry_price - recent_range
                else:
                    target = entry_price - recent_range * 2
                    stoploss = entry_price + recent_range

                # Simulate: check next 20 candles for target/stoploss hit
                outcome = 0  # 0 = stoploss hit / no result
                for j in range(i + 1, min(i + 21, len(candles))):
                    if signal == "BUY":
                        if candles[j].get("high", closes[j]) >= target:
                            outcome = 1
                            break
                        if candles[j].get("low", closes[j]) <= stoploss:
                            outcome = 0
                            break
                    else:
                        if candles[j].get("low", closes[j]) <= target:
                            outcome = 1
                            break
                        if candles[j].get("high", closes[j]) >= stoploss:
                            outcome = 0
                            break

                features = _extract_features(
                    closes[: i + 1], volumes[: i + 1]
                )

                row = {
                    "instrument": instrument,
                    "strategy": strategy,
                    "side": signal,
                    "entry_price": entry_price,
                    "target": target,
                    "stoploss": stoploss,
                    "outcome": outcome,
                    "rsi": features["rsi"],
                    "ema_gap": features["ema_gap"],
                    "atr": features["atr"],
                    "volume_ratio": features["volume_ratio"],
                    "close": features["close"],
                }
                rows.append(row)

                total_trades += 1
                if outcome == 1:
                    profitable += 1
                else:
                    unprofitable += 1

                # Skip forward to avoid overlapping trades
                i += 5

    # Write to CSV
    file_path = str(_BOOTSTRAP_FILE)
    if rows:
        fieldnames = list(rows[0].keys())
        with open(file_path, "w", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(rows)

    logger.info(
        "Bootstrap complete: %d trades (%d profitable, %d unprofitable)",
        total_trades,
        profitable,
        unprofitable,
    )

    return {
        "total_trades": total_trades,
        "profitable": profitable,
        "unprofitable": unprofitable,
        "file_path": file_path,
    }


async def train_xgboost(
    data_sources: Optional[List[str]] = None,
    test_split: float = 0.2,
) -> Dict[str, Any]:
    """Train the XGBoost scoring model on available training data.

    Loads CSV files from the training data directory, prepares features
    via the feature engineer, trains the model, and evaluates on a test set.

    Args:
        data_sources: Which data sources to use (backtest, paper, live).
        test_split: Fraction of data to hold out for testing.

    Returns:
        Dict with accuracy, precision, recall, f1, samples_used, model_path.
    """
    if data_sources is None:
        data_sources = ["backtest", "paper", "live"]

    _ensure_dirs()

    # Collect training data from CSV files
    all_trades: List[Dict[str, Any]] = []

    csv_files = list(_TRAINING_DIR.glob("*.csv"))
    if not csv_files:
        logger.warning("No training CSV files found in %s", _TRAINING_DIR)
        return {
            "accuracy": 0.0,
            "precision": 0.0,
            "recall": 0.0,
            "f1": 0.0,
            "samples_used": 0,
            "model_path": "",
            "error": "No training data available",
        }

    for csv_file in csv_files:
        try:
            with open(csv_file, "r") as f:
                reader = csv.DictReader(f)
                for row in reader:
                    all_trades.append(row)
        except (IOError, csv.Error) as e:
            logger.error("Failed to read %s: %s", csv_file, e)

    if len(all_trades) < 10:
        logger.warning("Insufficient training data: %d samples", len(all_trades))
        return {
            "accuracy": 0.0,
            "precision": 0.0,
            "recall": 0.0,
            "f1": 0.0,
            "samples_used": len(all_trades),
            "model_path": "",
            "error": "Insufficient training data (minimum 10 samples required)",
        }

    # Try to use the feature engineer and XGBoost model
    try:
        from ..services.feature_engineer import prepare_training_features
        from ..models.xgboost_scorer import XGBoostScorer

        X, y = prepare_training_features(all_trades)

        split_idx = int(len(X) * (1 - test_split))
        X_train, X_test = X[:split_idx], X[split_idx:]
        y_train, y_test = y[:split_idx], y[split_idx:]

        model = XGBoostScorer()
        model.train(X_train, y_train)

        # Evaluate on test set
        predictions = model.predict(X_test)

        # Compute metrics
        tp = sum(1 for p, a in zip(predictions, y_test) if p == 1 and a == 1)
        fp = sum(1 for p, a in zip(predictions, y_test) if p == 1 and a == 0)
        fn = sum(1 for p, a in zip(predictions, y_test) if p == 0 and a == 1)
        tn = sum(1 for p, a in zip(predictions, y_test) if p == 0 and a == 0)

        total = tp + fp + fn + tn
        accuracy = (tp + tn) / total if total > 0 else 0.0
        precision = tp / (tp + fp) if (tp + fp) > 0 else 0.0
        recall = tp / (tp + fn) if (tp + fn) > 0 else 0.0
        f1 = (
            2 * precision * recall / (precision + recall)
            if (precision + recall) > 0
            else 0.0
        )

        model_path = str(_DATA_DIR / "models" / "xgboost_scorer.json")
        model.save(model_path)

        logger.info(
            "XGBoost training complete: accuracy=%.3f, f1=%.3f, samples=%d",
            accuracy,
            f1,
            len(all_trades),
        )

        return {
            "accuracy": round(accuracy, 4),
            "precision": round(precision, 4),
            "recall": round(recall, 4),
            "f1": round(f1, 4),
            "samples_used": len(all_trades),
            "model_path": model_path,
        }

    except ImportError as e:
        logger.warning(
            "XGBoost or feature engineer not available, using fallback: %s", e
        )

        # Fallback: simple accuracy estimate from training data
        outcomes = [int(t.get("outcome", 0)) for t in all_trades]
        positive_rate = sum(outcomes) / len(outcomes) if outcomes else 0.5

        return {
            "accuracy": round(positive_rate, 4),
            "precision": 0.0,
            "recall": 0.0,
            "f1": 0.0,
            "samples_used": len(all_trades),
            "model_path": "",
            "error": f"XGBoost not available ({e}), using fallback metrics",
        }

    except Exception as e:
        logger.exception("XGBoost training failed")
        return {
            "accuracy": 0.0,
            "precision": 0.0,
            "recall": 0.0,
            "f1": 0.0,
            "samples_used": len(all_trades),
            "model_path": "",
            "error": str(e),
        }


async def train_rl(
    episodes_data: Optional[List[Dict[str, Any]]] = None,
    total_timesteps: int = 10000,
) -> Dict[str, Any]:
    """Train the RL trading agent.

    Args:
        episodes_data: Pre-collected episode data. If None, generates from CSVs.
        total_timesteps: Total training timesteps for the RL agent.

    Returns:
        Dict with episodes_trained, mean_reward, model_path.
    """
    _ensure_dirs()

    # Load episode data from CSVs if not provided
    if episodes_data is None:
        episodes_data = []
        csv_files = list(_TRAINING_DIR.glob("*.csv"))
        for csv_file in csv_files:
            try:
                with open(csv_file, "r") as f:
                    reader = csv.DictReader(f)
                    for row in reader:
                        episodes_data.append(row)
            except (IOError, csv.Error) as e:
                logger.error("Failed to read %s: %s", csv_file, e)

    if not episodes_data:
        return {
            "episodes_trained": 0,
            "mean_reward": 0.0,
            "model_path": "",
            "error": "No episode data available for RL training",
        }

    try:
        from ..models.rl_agent import RLTradingAgent

        agent = RLTradingAgent()
        result = agent.train(episodes_data, total_timesteps=total_timesteps)

        model_path = str(_DATA_DIR / "models" / "rl_agent.zip")
        agent.save(model_path)

        episodes_trained = result.get("episodes_trained", len(episodes_data))
        mean_reward = result.get("mean_reward", 0.0)

        logger.info(
            "RL training complete: episodes=%d, mean_reward=%.2f",
            episodes_trained,
            mean_reward,
        )

        return {
            "episodes_trained": episodes_trained,
            "mean_reward": round(mean_reward, 4),
            "model_path": model_path,
        }

    except ImportError as e:
        logger.warning("RL agent not available: %s", e)
        return {
            "episodes_trained": 0,
            "mean_reward": 0.0,
            "model_path": "",
            "error": f"RL agent not available ({e})",
        }

    except Exception as e:
        logger.exception("RL training failed")
        return {
            "episodes_trained": 0,
            "mean_reward": 0.0,
            "model_path": "",
            "error": str(e),
        }


async def evaluate_models() -> Dict[str, Any]:
    """Evaluate ML models against rule-based scoring on held-out test data.

    Loads test data, runs both XGBoost and rule-based scoring, and compares.

    Returns:
        Dict with xgboost metrics, rule_based metrics, and improvement_pct.
    """
    _ensure_dirs()

    # Load test data
    all_trades: List[Dict[str, Any]] = []
    csv_files = list(_TRAINING_DIR.glob("*.csv"))
    for csv_file in csv_files:
        try:
            with open(csv_file, "r") as f:
                reader = csv.DictReader(f)
                for row in reader:
                    all_trades.append(row)
        except (IOError, csv.Error) as e:
            logger.error("Failed to read %s: %s", csv_file, e)

    if len(all_trades) < 10:
        return {
            "xgboost": {"accuracy": 0.0, "f1": 0.0},
            "rule_based": {"accuracy": 0.0, "f1": 0.0},
            "improvement_pct": 0.0,
            "error": "Insufficient test data for evaluation",
        }

    # Use last 20% as held-out test set
    split_idx = int(len(all_trades) * 0.8)
    test_trades = all_trades[split_idx:]

    actual_outcomes = [int(t.get("outcome", 0)) for t in test_trades]

    # Rule-based scoring: use RSI threshold as a simple rule
    rule_predictions = []
    for t in test_trades:
        rsi = float(t.get("rsi", 50))
        side = t.get("side", "BUY")
        if side == "BUY":
            rule_predictions.append(1 if rsi < 40 else 0)
        else:
            rule_predictions.append(1 if rsi > 60 else 0)

    # Compute rule-based metrics
    rb_tp = sum(1 for p, a in zip(rule_predictions, actual_outcomes) if p == 1 and a == 1)
    rb_fp = sum(1 for p, a in zip(rule_predictions, actual_outcomes) if p == 1 and a == 0)
    rb_fn = sum(1 for p, a in zip(rule_predictions, actual_outcomes) if p == 0 and a == 1)
    rb_tn = sum(1 for p, a in zip(rule_predictions, actual_outcomes) if p == 0 and a == 0)

    rb_total = rb_tp + rb_fp + rb_fn + rb_tn
    rb_accuracy = (rb_tp + rb_tn) / rb_total if rb_total > 0 else 0.0
    rb_precision = rb_tp / (rb_tp + rb_fp) if (rb_tp + rb_fp) > 0 else 0.0
    rb_recall = rb_tp / (rb_tp + rb_fn) if (rb_tp + rb_fn) > 0 else 0.0
    rb_f1 = (
        2 * rb_precision * rb_recall / (rb_precision + rb_recall)
        if (rb_precision + rb_recall) > 0
        else 0.0
    )

    # XGBoost scoring
    xgb_accuracy = 0.0
    xgb_f1 = 0.0

    try:
        from ..services.feature_engineer import prepare_training_features
        from ..models.xgboost_scorer import XGBoostScorer

        model_path = _DATA_DIR / "models" / "xgboost_scorer.json"
        if model_path.exists():
            model = XGBoostScorer()
            model.load(str(model_path))

            X_test, y_test = prepare_training_features(test_trades)
            predictions = model.predict(X_test)

            xgb_tp = sum(1 for p, a in zip(predictions, y_test) if p == 1 and a == 1)
            xgb_fp = sum(1 for p, a in zip(predictions, y_test) if p == 1 and a == 0)
            xgb_fn = sum(1 for p, a in zip(predictions, y_test) if p == 0 and a == 1)
            xgb_tn = sum(1 for p, a in zip(predictions, y_test) if p == 0 and a == 0)

            xgb_total = xgb_tp + xgb_fp + xgb_fn + xgb_tn
            xgb_accuracy = (xgb_tp + xgb_tn) / xgb_total if xgb_total > 0 else 0.0
            xgb_precision = xgb_tp / (xgb_tp + xgb_fp) if (xgb_tp + xgb_fp) > 0 else 0.0
            xgb_recall = xgb_tp / (xgb_tp + xgb_fn) if (xgb_tp + xgb_fn) > 0 else 0.0
            xgb_f1 = (
                2 * xgb_precision * xgb_recall / (xgb_precision + xgb_recall)
                if (xgb_precision + xgb_recall) > 0
                else 0.0
            )
        else:
            logger.warning("XGBoost model not found at %s", model_path)

    except ImportError as e:
        logger.warning("XGBoost not available for evaluation: %s", e)
    except Exception as e:
        logger.exception("XGBoost evaluation failed: %s", e)

    improvement_pct = (
        ((xgb_accuracy - rb_accuracy) / rb_accuracy * 100)
        if rb_accuracy > 0
        else 0.0
    )

    return {
        "xgboost": {
            "accuracy": round(xgb_accuracy, 4),
            "f1": round(xgb_f1, 4),
        },
        "rule_based": {
            "accuracy": round(rb_accuracy, 4),
            "f1": round(rb_f1, 4),
        },
        "improvement_pct": round(improvement_pct, 2),
    }


async def get_ml_status() -> Dict[str, Any]:
    """Check which ML models are loaded/trained and return their status.

    Returns:
        Dict with status for xgboost, finbert, and rl models.
    """
    _ensure_dirs()

    # XGBoost status
    xgboost_status: Dict[str, Any] = {
        "trained": False,
        "samples": 0,
        "accuracy": 0.0,
        "last_trained": None,
    }

    xgb_model_path = _DATA_DIR / "models" / "xgboost_scorer.json"
    if xgb_model_path.exists():
        xgboost_status["trained"] = True
        try:
            stat = xgb_model_path.stat()
            xgboost_status["last_trained"] = datetime.fromtimestamp(
                stat.st_mtime
            ).isoformat()

            with open(xgb_model_path, "r") as f:
                model_meta = json.load(f)
                xgboost_status["samples"] = model_meta.get("samples_trained", 0)
                xgboost_status["accuracy"] = model_meta.get("accuracy", 0.0)
        except (IOError, json.JSONDecodeError, OSError):
            pass

    # Count available training samples
    total_samples = 0
    csv_files = list(_TRAINING_DIR.glob("*.csv"))
    for csv_file in csv_files:
        try:
            with open(csv_file, "r") as f:
                reader = csv.reader(f)
                total_samples += max(0, sum(1 for _ in reader) - 1)  # subtract header
        except IOError:
            pass
    xgboost_status["samples"] = max(xgboost_status["samples"], total_samples)

    # FinBERT status
    finbert_status: Dict[str, Any] = {
        "loaded": False,
        "model_size": "0MB",
    }
    try:
        from ..models.finbert_sentiment import FinBERTSentiment

        finbert = FinBERTSentiment()
        finbert_status["loaded"] = finbert.is_loaded()
        finbert_status["model_size"] = finbert.model_size()
    except (ImportError, Exception):
        finbert_status["loaded"] = False
        finbert_status["model_size"] = "not installed"

    # RL agent status
    rl_status: Dict[str, Any] = {
        "trained": False,
        "episodes": 0,
        "mode": "observe",
        "mean_reward": 0.0,
    }

    rl_model_path = _DATA_DIR / "models" / "rl_agent.zip"
    if rl_model_path.exists():
        rl_status["trained"] = True
        try:
            stat = rl_model_path.stat()
            rl_status["last_trained"] = datetime.fromtimestamp(
                stat.st_mtime
            ).isoformat()
        except OSError:
            pass

    config = _load_ml_config()
    rl_status["mode"] = config.get("rl", {}).get("mode", "observe")

    return {
        "xgboost": xgboost_status,
        "finbert": finbert_status,
        "rl": rl_status,
    }
