"""
XGBoost-based signal scorer for the TD Automation AI Engine.

Replaces rule-based scoring with a trained binary classifier that predicts
whether a trade signal will be profitable.
"""

import logging
import os
from pathlib import Path
from typing import Dict, List, Optional, Tuple

_logger = logging.getLogger(__name__)

# Default model path
_MODEL_DIR = Path(__file__).resolve().parent.parent.parent / "data" / "models"
_DEFAULT_MODEL_PATH = _MODEL_DIR / "xgboost_signal_model.joblib"

# Minimum samples required for training
_MIN_TRAINING_SAMPLES = 200


class XGBoostScorer:
    """XGBoost binary classifier for scoring trade signals.

    Predicts the probability that a given trade signal will be profitable
    based on a 14-feature vector extracted by the feature engineer.

    Attributes:
        model: The trained XGBoost classifier, or None if not yet trained.
        model_path: Path to the serialized model file.
        feature_names: List of feature names the model was trained on.
    """

    def __init__(self, model_path: Optional[str] = None):
        """Initialize the scorer, loading a saved model if available.

        Args:
            model_path: Optional path to a saved model file.
                        Defaults to data/models/xgboost_signal_model.joblib.
        """
        self.model_path = Path(model_path) if model_path else _DEFAULT_MODEL_PATH
        self.model = None
        self.feature_names: Optional[List[str]] = None
        self._metrics: Optional[Dict] = None

        if self.model_path.exists():
            self.load_model()

    def is_trained(self) -> bool:
        """Check whether a trained model is loaded.

        Returns:
            True if a model is loaded and ready for prediction.
        """
        return self.model is not None

    def train(
        self,
        X: List[List[float]],
        y: List[int],
        test_size: float = 0.2,
        feature_names: Optional[List[str]] = None,
    ) -> Dict:
        """Train the XGBoost classifier on labeled trade data.

        Args:
            X: Feature matrix — list of feature vectors.
            y: Target array — 1 for profitable, 0 for loss.
            test_size: Fraction of data to hold out for evaluation.
            feature_names: Optional list of feature names for importance tracking.

        Returns:
            Dict with training metrics: accuracy, precision, recall, f1,
            train_size, test_size_actual, and feature_importance.

        Raises:
            ValueError: If fewer than 200 samples are provided.
        """
        import xgboost as xgb
        from sklearn.model_selection import train_test_split
        from sklearn.metrics import accuracy_score, precision_score, recall_score, f1_score

        if len(X) < _MIN_TRAINING_SAMPLES:
            raise ValueError(
                f"Need at least {_MIN_TRAINING_SAMPLES} samples for training, "
                f"got {len(X)}"
            )

        self.feature_names = feature_names

        X_train, X_test, y_train, y_test = train_test_split(
            X, y, test_size=test_size, random_state=42, stratify=y
        )

        _logger.info(
            f"Training XGBoost scorer: {len(X_train)} train, {len(X_test)} test samples"
        )

        self.model = xgb.XGBClassifier(
            max_depth=6,
            n_estimators=100,
            learning_rate=0.1,
            objective="binary:logistic",
            eval_metric="logloss",
            use_label_encoder=False,
            random_state=42,
        )

        self.model.fit(
            X_train,
            y_train,
            eval_set=[(X_test, y_test)],
            verbose=False,
        )

        # Evaluate on test set
        metrics = self.evaluate(X_test, y_test)
        metrics["train_size"] = len(X_train)
        metrics["test_size_actual"] = len(X_test)

        if self.feature_names:
            metrics["feature_importance"] = self.get_feature_importance()

        self._metrics = metrics

        # Save the trained model
        self.save_model()

        _logger.info(
            f"XGBoost training complete — accuracy: {metrics['accuracy']:.4f}, "
            f"f1: {metrics['f1']:.4f}"
        )

        return metrics

    def predict(self, features: List[float]) -> Optional[Dict]:
        """Predict the score for a feature vector.

        Args:
            features: List of 14 float values from the feature engineer.

        Returns:
            Dict with:
                - score: 0-100 integer score
                - confidence: VERY_HIGH, HIGH, MEDIUM, or LOW
                - probability: raw probability float
            Returns None if the model is not trained (caller should
            fall back to rule-based scoring).
        """
        if not self.is_trained():
            return None

        import numpy as np

        X = np.array([features])
        probability = float(self.model.predict_proba(X)[0][1])

        score = int(round(probability * 100))
        score = max(0, min(100, score))

        confidence = self._map_confidence(probability)

        return {
            "score": score,
            "confidence": confidence,
            "probability": probability,
        }

    def evaluate(self, X_test: List[List[float]], y_test: List[int]) -> Dict:
        """Evaluate the model on a test set.

        Args:
            X_test: Test feature matrix.
            y_test: Test target array.

        Returns:
            Dict with accuracy, precision, recall, f1, and confusion_matrix.

        Raises:
            RuntimeError: If the model is not trained.
        """
        if not self.is_trained():
            raise RuntimeError("Model is not trained — call train() first")

        from sklearn.metrics import (
            accuracy_score,
            precision_score,
            recall_score,
            f1_score,
            confusion_matrix,
        )
        import numpy as np

        X = np.array(X_test) if not isinstance(X_test, np.ndarray) else X_test
        y_pred = self.model.predict(X)

        cm = confusion_matrix(y_test, y_pred)

        return {
            "accuracy": float(accuracy_score(y_test, y_pred)),
            "precision": float(precision_score(y_test, y_pred, zero_division=0)),
            "recall": float(recall_score(y_test, y_pred, zero_division=0)),
            "f1": float(f1_score(y_test, y_pred, zero_division=0)),
            "confusion_matrix": cm.tolist(),
        }

    def get_feature_importance(self) -> Dict[str, float]:
        """Get feature importance rankings from the trained model.

        Returns:
            Dict mapping feature name (or index) to importance score,
            sorted by importance descending.

        Raises:
            RuntimeError: If the model is not trained.
        """
        if not self.is_trained():
            raise RuntimeError("Model is not trained — call train() first")

        importances = self.model.feature_importances_
        names = self.feature_names or [f"feature_{i}" for i in range(len(importances))]

        importance_dict = {
            name: float(imp) for name, imp in zip(names, importances)
        }

        # Sort by importance descending
        return dict(
            sorted(importance_dict.items(), key=lambda x: x[1], reverse=True)
        )

    def save_model(self) -> None:
        """Save the trained model to disk using joblib.

        Creates the parent directory if it does not exist.
        """
        if not self.is_trained():
            _logger.warning("No trained model to save")
            return

        import joblib

        self.model_path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "model": self.model,
            "feature_names": self.feature_names,
            "metrics": self._metrics,
        }
        joblib.dump(payload, self.model_path)
        _logger.info(f"Model saved to {self.model_path}")

    def load_model(self) -> None:
        """Load a trained model from disk.

        Raises:
            FileNotFoundError: If the model file does not exist.
        """
        import joblib

        if not self.model_path.exists():
            raise FileNotFoundError(f"No model file at {self.model_path}")

        payload = joblib.load(self.model_path)
        self.model = payload.get("model")
        self.feature_names = payload.get("feature_names")
        self._metrics = payload.get("metrics")
        _logger.info(f"Model loaded from {self.model_path}")

    @staticmethod
    def _map_confidence(probability: float) -> str:
        """Map a probability to a confidence label.

        Args:
            probability: Float between 0 and 1.

        Returns:
            One of: VERY_HIGH, HIGH, MEDIUM, LOW.
        """
        if probability >= 0.9:
            return "VERY_HIGH"
        elif probability >= 0.75:
            return "HIGH"
        elif probability >= 0.6:
            return "MEDIUM"
        else:
            return "LOW"
