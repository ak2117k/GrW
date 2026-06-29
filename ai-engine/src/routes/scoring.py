"""
Scoring API routes — signal confidence scoring endpoint.
"""

import logging
from typing import List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..services.scoring_service import score_trade_signal

logger = logging.getLogger(__name__)

router = APIRouter()


# --- Request/Response Models ---


class CandleData(BaseModel):
    """Single candle data point."""
    timestamp: str = ""
    open: float = 0.0
    high: float = 0.0
    low: float = 0.0
    close: float = 0.0
    volume: float = 0.0


class SignalInput(BaseModel):
    """Trade signal input."""
    symbol: str
    side: str = Field(..., description="BUY or SELL")
    entry_price: float = 0.0
    target_price: float = 0.0
    stoploss_price: float = 0.0
    strategy: str = "unknown"
    timeframe: str = "15m"


class MarketDataInput(BaseModel):
    """Market data accompanying the signal."""
    candles: List[CandleData] = Field(default_factory=list)
    volume: Optional[float] = None
    oi: Optional[float] = None
    oi_change: Optional[float] = 0.0


class ScoreSignalRequest(BaseModel):
    """Request body for POST /api/score-signal."""
    signal: SignalInput
    market_data: MarketDataInput
    multi_timeframe_alignment: int = Field(default=1, ge=0)
    strategy_signal_strength: float = Field(default=50.0, ge=0, le=100)


class ScoringFactor(BaseModel):
    """Individual scoring factor breakdown."""
    weight: float
    score: int
    weighted: float


class ScoreSignalResponse(BaseModel):
    """Response body for POST /api/score-signal."""
    confidence_score: int
    confidence_level: str
    scoring_breakdown: dict
    recommendation: str


# --- Routes ---


@router.post("/score-signal", response_model=ScoreSignalResponse)
async def score_signal_endpoint(request: ScoreSignalRequest):
    """Score a trade signal and return confidence metrics.

    Implements Section 3.7 (AI Confidence Scoring) from the platform spec.
    Uses a weighted ensemble of 6 factors to produce a confidence score 0-100.
    """
    try:
        signal_dict = request.signal.model_dump()
        market_data_dict = {
            "candles": [c.model_dump() for c in request.market_data.candles],
            "volume": request.market_data.volume,
            "oi": request.market_data.oi,
            "oi_change": request.market_data.oi_change or 0.0,
        }

        result = await score_trade_signal(
            signal=signal_dict,
            market_data=market_data_dict,
            multi_timeframe_alignment=request.multi_timeframe_alignment,
            strategy_signal_strength=request.strategy_signal_strength,
        )

        return ScoreSignalResponse(**result)

    except ValueError as e:
        logger.error("Validation error in score-signal: %s", e)
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        logger.exception("Unexpected error in score-signal")
        raise HTTPException(status_code=500, detail=f"Internal error: {str(e)}")
