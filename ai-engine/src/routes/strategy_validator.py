"""
Strategy Validator API routes — validate user-written trading strategy code.
"""

import logging
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..services.strategy_validator_service import validate_strategy

logger = logging.getLogger(__name__)

router = APIRouter()


# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------


class ValidateStrategyRequest(BaseModel):
    """Request body for POST /api/validate-strategy."""

    code: str = Field(..., description="The strategy DSL source code to validate")
    type: Literal["script", "visual"] = Field(
        default="script",
        description="Strategy format type",
    )


class StrategyError(BaseModel):
    """A single validation error."""

    line: int
    message: str
    suggestion: str = ""


class StrategyWarning(BaseModel):
    """A single validation warning."""

    line: int
    message: str


class StrategyAnalysis(BaseModel):
    """Semantic analysis summary of the strategy."""

    indicators_used: list[str] = Field(default_factory=list)
    has_entry_rules: bool = False
    has_exit_rules: bool = False
    has_risk_management: bool = False
    complexity_score: int = Field(default=1, ge=1, le=10)


class ValidateStrategyResponse(BaseModel):
    """Response body for POST /api/validate-strategy."""

    valid: bool
    errors: list[StrategyError] = Field(default_factory=list)
    warnings: list[StrategyWarning] = Field(default_factory=list)
    analysis: StrategyAnalysis


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.post("/validate-strategy", response_model=ValidateStrategyResponse)
async def validate_strategy_endpoint(request: ValidateStrategyRequest):
    """Validate a user-written trading strategy and suggest fixes.

    Performs syntax validation, semantic analysis, and provides actionable
    fix suggestions for common mistakes in strategy DSL code.
    """
    try:
        result = validate_strategy(code=request.code, strategy_type=request.type)

        return ValidateStrategyResponse(
            valid=result["valid"],
            errors=[StrategyError(**e) for e in result["errors"]],
            warnings=[StrategyWarning(**w) for w in result["warnings"]],
            analysis=StrategyAnalysis(**result["analysis"]),
        )
    except Exception as e:
        logger.exception("Unexpected error in validate-strategy")
        raise HTTPException(status_code=500, detail=f"Internal error: {str(e)}")
