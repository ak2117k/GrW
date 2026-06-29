"""
Sentiment analysis service — orchestrates news sentiment analysis.
"""

import logging
from typing import Dict, Any

from ..models.sentiment_analyzer import analyze_sentiment

logger = logging.getLogger(__name__)


async def analyze_text_sentiment(text: str) -> Dict[str, Any]:
    """Analyze sentiment of the provided text.

    Args:
        text: News or market commentary text.

    Returns:
        Dict with sentiment, score, entities, and summary.

    Raises:
        ValueError: If text is empty or None.
    """
    if not text or not text.strip():
        raise ValueError("Text cannot be empty")

    result = analyze_sentiment(text)

    logger.info(
        "Sentiment analyzed via service: score=%.2f sentiment=%s",
        result["score"],
        result["sentiment"],
    )

    return result
