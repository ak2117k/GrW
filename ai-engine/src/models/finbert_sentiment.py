"""
FinBERT-based sentiment analyzer for financial news text.

Uses the ProsusAI/finbert model from HuggingFace to classify text as
positive (bullish), negative (bearish), or neutral. Falls back to keyword-based
analysis from sentiment_analyzer.py when the model cannot be loaded or inference
fails.
"""

import logging
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


class FinBERTAnalyzer:
    """Financial sentiment analyzer powered by FinBERT.

    The model is loaded lazily on first inference and cached as class-level
    state so that subsequent calls reuse the same weights. If loading or
    inference fails for any reason the analyzer transparently delegates to the
    keyword-based ``analyze_sentiment`` in ``sentiment_analyzer.py``.
    """

    _model = None
    _tokenizer = None
    _load_failed: bool = False
    _label_map = {"positive": "bullish", "negative": "bearish", "neutral": "neutral"}

    # ------------------------------------------------------------------
    # Model lifecycle
    # ------------------------------------------------------------------

    @classmethod
    def _load_model(cls) -> bool:
        """Attempt to load the FinBERT model and tokenizer.

        Returns:
            True if the model is ready for inference, False otherwise.
        """
        if cls._model is not None:
            return True
        if cls._load_failed:
            return False

        try:
            import torch
            from transformers import AutoModelForSequenceClassification, AutoTokenizer

            logger.info("Loading FinBERT model (ProsusAI/finbert) ...")

            cls._tokenizer = AutoTokenizer.from_pretrained("ProsusAI/finbert")
            cls._model = AutoModelForSequenceClassification.from_pretrained(
                "ProsusAI/finbert"
            )
            cls._model.to("cpu")
            cls._model.eval()

            logger.info("FinBERT model loaded successfully.")
            return True

        except Exception as exc:
            logger.warning(
                "Failed to load FinBERT model, will use keyword fallback: %s", exc
            )
            cls._load_failed = True
            return False

    # ------------------------------------------------------------------
    # Public helpers
    # ------------------------------------------------------------------

    @classmethod
    def is_loaded(cls) -> bool:
        """Return True if the FinBERT model is currently in memory."""
        return cls._model is not None

    @classmethod
    def unload(cls) -> None:
        """Free the model and tokenizer from memory."""
        cls._model = None
        cls._tokenizer = None
        cls._load_failed = False
        logger.info("FinBERT model unloaded.")

    @classmethod
    def model_info(cls) -> Dict[str, Any]:
        """Return metadata about the model's current state."""
        mem_estimate_mb: Optional[float] = None
        if cls._model is not None:
            try:
                param_bytes = sum(
                    p.nelement() * p.element_size() for p in cls._model.parameters()
                )
                mem_estimate_mb = round(param_bytes / (1024 * 1024), 1)
            except Exception:
                pass

        return {
            "model_name": "ProsusAI/finbert",
            "loaded": cls.is_loaded(),
            "load_failed": cls._load_failed,
            "memory_mb": mem_estimate_mb,
        }

    # ------------------------------------------------------------------
    # Fallback
    # ------------------------------------------------------------------

    @staticmethod
    def _keyword_fallback(text: str) -> Dict[str, Any]:
        """Run keyword-based sentiment analysis and tag the result."""
        from .sentiment_analyzer import analyze_sentiment

        result = analyze_sentiment(text)
        result["model"] = "keyword-fallback"
        if "confidence" not in result:
            result["confidence"] = abs(result.get("score", 0.0))
        return result

    # ------------------------------------------------------------------
    # Single-text inference
    # ------------------------------------------------------------------

    @classmethod
    def analyze(cls, text: str) -> Dict[str, Any]:
        """Analyze the sentiment of a single text.

        Args:
            text: Financial news or market commentary.

        Returns:
            Dict with keys: sentiment, score, confidence, entities, summary, model.
        """
        if not text or not text.strip():
            return {
                "sentiment": "neutral",
                "score": 0.0,
                "confidence": 0.0,
                "entities": [],
                "summary": "No text provided for analysis.",
                "model": "finbert",
            }

        if not cls._load_model():
            return cls._keyword_fallback(text)

        try:
            return cls._infer_single(text)
        except Exception as exc:
            logger.warning(
                "FinBERT inference failed, falling back to keywords: %s", exc
            )
            return cls._keyword_fallback(text)

    @classmethod
    def _infer_single(cls, text: str) -> Dict[str, Any]:
        """Run FinBERT inference on a single text string."""
        import torch

        from .sentiment_analyzer import _extract_entities

        inputs = cls._tokenizer(
            text,
            return_tensors="pt",
            truncation=True,
            max_length=512,
            padding=True,
        )

        with torch.no_grad():
            outputs = cls._model(**inputs)
            probs = torch.nn.functional.softmax(outputs.logits, dim=-1)[0]

        # ProsusAI/finbert label order: positive, negative, neutral
        pos, neg, neu = probs[0].item(), probs[1].item(), probs[2].item()

        score = round(pos - neg, 4)
        confidence = round(max(pos, neg, neu), 4)

        if score > 0.15:
            sentiment = "bullish"
        elif score < -0.15:
            sentiment = "bearish"
        else:
            sentiment = "neutral"

        entities = _extract_entities(text)
        summary = cls._build_summary(sentiment, confidence)

        return {
            "sentiment": sentiment,
            "score": round(score, 2),
            "confidence": round(confidence, 2),
            "entities": entities,
            "summary": summary,
            "model": "finbert",
        }

    # ------------------------------------------------------------------
    # Batch inference
    # ------------------------------------------------------------------

    @classmethod
    def analyze_batch(cls, texts: List[str]) -> List[Dict[str, Any]]:
        """Analyze sentiment for a batch of texts.

        Processes up to 16 texts at a time through the model for efficiency.
        Falls back to keyword matching per-text if the model is unavailable.

        Args:
            texts: List of news/commentary strings.

        Returns:
            List of result dicts (same format as ``analyze``).
        """
        if not texts:
            return []

        if not cls._load_model():
            return [cls._keyword_fallback(t) for t in texts]

        try:
            return cls._infer_batch(texts)
        except Exception as exc:
            logger.warning("FinBERT batch inference failed, falling back: %s", exc)
            return [cls._keyword_fallback(t) for t in texts]

    @classmethod
    def _infer_batch(cls, texts: List[str]) -> List[Dict[str, Any]]:
        """Run FinBERT on a batch of texts (max 16 per chunk)."""
        import torch

        from .sentiment_analyzer import _extract_entities

        batch_size = 16
        results: List[Dict[str, Any]] = []

        for start in range(0, len(texts), batch_size):
            chunk = texts[start : start + batch_size]

            inputs = cls._tokenizer(
                chunk,
                return_tensors="pt",
                truncation=True,
                max_length=512,
                padding=True,
            )

            with torch.no_grad():
                outputs = cls._model(**inputs)
                probs = torch.nn.functional.softmax(outputs.logits, dim=-1)

            for i, text in enumerate(chunk):
                pos = probs[i][0].item()
                neg = probs[i][1].item()
                neu = probs[i][2].item()

                score = round(pos - neg, 4)
                confidence = round(max(pos, neg, neu), 4)

                if score > 0.15:
                    sentiment = "bullish"
                elif score < -0.15:
                    sentiment = "bearish"
                else:
                    sentiment = "neutral"

                entities = _extract_entities(text)
                summary = cls._build_summary(sentiment, confidence)

                results.append(
                    {
                        "sentiment": sentiment,
                        "score": round(score, 2),
                        "confidence": round(confidence, 2),
                        "entities": entities,
                        "summary": summary,
                        "model": "finbert",
                    }
                )

        return results

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _build_summary(sentiment: str, confidence: float) -> str:
        """Generate a one-line human-readable summary."""
        if confidence >= 0.75:
            strength = "high"
        elif confidence >= 0.50:
            strength = "moderate"
        else:
            strength = "low"

        if sentiment == "bullish":
            return f"Bullish signal detected ({strength} confidence)."
        elif sentiment == "bearish":
            return f"Bearish signal detected ({strength} confidence)."
        return f"Neutral sentiment ({strength} confidence)."
