"""
AI Advisor chat and Q&A API routes.
"""

import logging
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..services.advisor_service import process_question

logger = logging.getLogger(__name__)

router = APIRouter()


# --- Request/Response Models ---


class TradeContext(BaseModel):
    """Single trade in the context payload."""
    symbol: str = ""
    side: str = ""
    strategy: str = "unknown"
    pnl: float = 0.0
    status: str = ""
    entry_price: float = 0.0
    exit_price: float = 0.0
    entry_time: str = ""
    exit_time: str = ""


class StatsContext(BaseModel):
    """Aggregated stats from the NestJS backend."""
    total_trades: int = 0
    win_rate: float = 0.0
    total_pnl: float = 0.0
    open_positions: int = 0


class DailyPerfContext(BaseModel):
    """Single daily performance entry."""
    date: str = ""
    pnl: float = 0.0
    trades: int = 0
    wins: int = 0
    losses: int = 0


class TradingContext(BaseModel):
    """Full trading context sent along with the question."""
    recent_trades: List[TradeContext] = Field(default_factory=list)
    stats: StatsContext = Field(default_factory=StatsContext)
    active_strategies: List[str] = Field(default_factory=list)
    daily_performance: List[DailyPerfContext] = Field(default_factory=list)


class AskAdvisorRequest(BaseModel):
    """Request body for POST /api/ask-advisor."""
    question: str = Field(..., min_length=1, max_length=2000)
    context: TradingContext = Field(default_factory=TradingContext)


class AskAdvisorResponse(BaseModel):
    """Response body for POST /api/ask-advisor."""
    answer: str
    confidence: float
    relatedInsights: List[str]
    suggestedActions: List[str]


# --- Routes ---


@router.post("/ask-advisor", response_model=AskAdvisorResponse)
async def ask_advisor_endpoint(request: AskAdvisorRequest):
    """Answer a trading question using the user's trading context.

    Supports question types:
    - Trade assessment: "Should I take this trade?"
    - Loss analysis: "Why did I lose?"
    - Performance summary: "How am I doing?"
    - Improvement suggestions: "What should I improve?"
    - General trading Q&A
    """
    try:
        context_dict = request.context.model_dump()
        result = process_question(request.question, context_dict)
        return AskAdvisorResponse(**result)

    except ValueError as e:
        logger.error("Validation error in ask-advisor: %s", e)
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        logger.exception("Unexpected error in ask-advisor")
        raise HTTPException(status_code=500, detail=f"Internal error: {str(e)}")
