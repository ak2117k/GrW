"""
Trade analysis and self-learning API routes.
"""

import logging
from typing import List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..services.trade_analysis_service import analyze_completed_trade
from ..services.self_learning_service import retrain

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


class TradeInput(BaseModel):
    """Completed trade details."""
    symbol: str
    side: str = Field(..., description="BUY or SELL")
    entry_price: float
    exit_price: float
    entry_time: str = ""
    exit_time: str = ""
    pnl: float = 0.0
    strategy: str = "unknown"
    stoploss_price: Optional[float] = None
    target_price: Optional[float] = None


class MarketContextInput(BaseModel):
    """Market context at the time of the trade."""
    candles_at_entry: List[CandleData] = Field(default_factory=list)
    market_regime: str = "unknown"
    volume_at_entry: float = 0.0


class AnalyzeTradeRequest(BaseModel):
    """Request body for POST /api/analyze-trade."""
    trade: TradeInput
    market_context: MarketContextInput


class TradeAnalysisDetail(BaseModel):
    """Detailed analysis of a trade."""
    outcome: str
    what_went_right: List[str]
    what_went_wrong: List[str]
    improvement_suggestions: List[str]


class AnalyzeTradeResponse(BaseModel):
    """Response body for POST /api/analyze-trade."""
    analysis: TradeAnalysisDetail
    score: float
    patterns_detected: List[str]


class TradeOutcome(BaseModel):
    """Single trade outcome for retraining."""
    symbol: str
    side: str
    strategy: str = "unknown"
    pnl: float = 0.0
    entry_time: str = ""
    exit_time: str = ""
    market_regime: str = "unknown"


class RetrainRequest(BaseModel):
    """Request body for POST /api/retrain."""
    trade_outcomes: List[TradeOutcome]


class RetrainResponse(BaseModel):
    """Response body for POST /api/retrain."""
    updated_weights: dict
    strategy_performance: dict
    time_of_day_patterns: dict
    suggestions: List[str]
    trades_processed: int


# --- Routes ---


@router.post("/analyze-trade", response_model=AnalyzeTradeResponse)
async def analyze_trade_endpoint(request: AnalyzeTradeRequest):
    """Analyze a completed trade for the self-learning feedback loop.

    Identifies what went right and wrong, detects patterns, and provides
    improvement suggestions per Section 3.8 of the platform spec.
    """
    try:
        trade_dict = request.trade.model_dump()
        market_context_dict = {
            "candles_at_entry": [c.model_dump() for c in request.market_context.candles_at_entry],
            "market_regime": request.market_context.market_regime,
            "volume_at_entry": request.market_context.volume_at_entry,
        }

        result = await analyze_completed_trade(trade_dict, market_context_dict)
        return AnalyzeTradeResponse(**result)

    except ValueError as e:
        logger.error("Validation error in analyze-trade: %s", e)
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        logger.exception("Unexpected error in analyze-trade")
        raise HTTPException(status_code=500, detail=f"Internal error: {str(e)}")


@router.post("/retrain", response_model=RetrainResponse)
async def retrain_endpoint(request: RetrainRequest):
    """Process a batch of trade outcomes and update strategy performance data.

    Implements the self-learning mechanism from Section 3.8:
    - Recomputes strategy win rates by market condition
    - Identifies time-of-day patterns
    - Generates suggestions for parameter optimization
    - Stores results locally (will be moved to DB later)
    """
    try:
        outcomes = [t.model_dump() for t in request.trade_outcomes]
        result = await retrain(outcomes)
        return RetrainResponse(**result)

    except Exception as e:
        logger.exception("Unexpected error in retrain")
        raise HTTPException(status_code=500, detail=f"Internal error: {str(e)}")
