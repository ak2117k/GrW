"""
Sentiment API routes — news sentiment analysis endpoint.
"""

import logging
from typing import List

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..services.sentiment_service import analyze_text_sentiment

logger = logging.getLogger(__name__)

router = APIRouter()


# --- Request/Response Models ---


class SentimentRequest(BaseModel):
    """Request body for POST /api/sentiment."""
    text: str = Field(..., min_length=1, description="News or market commentary text to analyze")


class SentimentResponse(BaseModel):
    """Response body for POST /api/sentiment."""
    sentiment: str = Field(..., description="bullish, bearish, or neutral")
    score: float = Field(..., description="Score from -1.0 (very bearish) to 1.0 (very bullish)")
    entities: List[str] = Field(default_factory=list, description="Detected entity names")
    summary: str = Field(..., description="Brief summary of the sentiment signal")


# --- Routes ---


@router.post("/sentiment", response_model=SentimentResponse)
async def sentiment_endpoint(request: SentimentRequest):
    """Analyze the sentiment of news or market commentary text.

    Uses rule-based keyword matching and scoring to classify text as
    bullish, bearish, or neutral with a score from -1.0 to 1.0.
    """
    try:
        result = await analyze_text_sentiment(request.text)
        return SentimentResponse(**result)

    except ValueError as e:
        logger.error("Validation error in sentiment: %s", e)
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        logger.exception("Unexpected error in sentiment")
        raise HTTPException(status_code=500, detail=f"Internal error: {str(e)}")
