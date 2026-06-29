"""
Strategy Fixer & PineScript Converter API routes.

Provides endpoints for:
- Converting PineScript code to the TD Automation DSL format
- Auto-fixing strategy code errors
- Suggesting improvements for valid strategies
"""

import logging
from typing import Any, Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..services.pinescript_converter import convert_pinescript
from ..services.strategy_fixer import fix_strategy, suggest_improvements

logger = logging.getLogger(__name__)

router = APIRouter()


# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------


class ConvertPineScriptRequest(BaseModel):
    """Request body for POST /api/convert-pinescript."""

    code: str = Field(..., description="The PineScript source code to convert")


class UnsupportedLine(BaseModel):
    """A line that could not be converted."""

    line: int
    original: str
    reason: str


class ConvertPineScriptResponse(BaseModel):
    """Response body for POST /api/convert-pinescript."""

    converted_code: str
    warnings: list[str] = Field(default_factory=list)
    unsupported_lines: list[UnsupportedLine] = Field(default_factory=list)


class StrategyErrorInput(BaseModel):
    """A validation error passed to the fixer."""

    line: int = 0
    message: str = ""
    suggestion: str = ""


class StrategyWarningInput(BaseModel):
    """A validation warning passed to the fixer."""

    line: int = 0
    message: str = ""


class FixStrategyRequest(BaseModel):
    """Request body for POST /api/fix-strategy."""

    code: str = Field(..., description="The strategy DSL source code to fix")
    errors: list[StrategyErrorInput] = Field(
        default_factory=list,
        description="Validation errors from the strategy validator",
    )
    warnings: list[StrategyWarningInput] = Field(
        default_factory=list,
        description="Validation warnings from the strategy validator",
    )


class FixChange(BaseModel):
    """A single fix applied to the strategy code."""

    line: int
    original: str
    fixed: str
    reason: str


class FixStrategyResponse(BaseModel):
    """Response body for POST /api/fix-strategy."""

    fixed_code: str
    changes: list[FixChange] = Field(default_factory=list)
    confidence: float = Field(ge=0.0, le=1.0)


class SuggestImprovementsRequest(BaseModel):
    """Request body for POST /api/suggest-improvements."""

    code: str = Field(..., description="The strategy DSL source code to analyze")


class Suggestion(BaseModel):
    """A single improvement suggestion."""

    suggestion: str
    priority: Literal["high", "medium", "low"]
    line: int | None = None


class SuggestImprovementsResponse(BaseModel):
    """Response body for POST /api/suggest-improvements."""

    suggestions: list[Suggestion] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.post("/convert-pinescript", response_model=ConvertPineScriptResponse)
async def convert_pinescript_endpoint(request: ConvertPineScriptRequest):
    """Convert TradingView PineScript code to the TD Automation DSL format.

    Parses PineScript indicator calls, entry/exit logic, and operators,
    converting them to the equivalent DSL syntax. Unsupported constructs
    are stripped and reported in the response.
    """
    try:
        result = await convert_pinescript(code=request.code)

        return ConvertPineScriptResponse(
            converted_code=result["converted_code"],
            warnings=result["warnings"],
            unsupported_lines=[
                UnsupportedLine(**ul) for ul in result["unsupported_lines"]
            ],
        )
    except Exception as e:
        logger.exception("Unexpected error in convert-pinescript")
        raise HTTPException(status_code=500, detail=f"Internal error: {str(e)}")


@router.post("/fix-strategy", response_model=FixStrategyResponse)
async def fix_strategy_endpoint(request: FixStrategyRequest):
    """Auto-fix common errors in strategy DSL code.

    Analyzes the code along with validation errors/warnings and applies
    intelligent fixes including typo correction, operator fixing,
    parameter range adjustments, and PineScript remnant conversion.
    """
    try:
        errors_dicts = [e.model_dump() for e in request.errors]
        warnings_dicts = [w.model_dump() for w in request.warnings]

        result = await fix_strategy(
            code=request.code,
            errors=errors_dicts,
            warnings=warnings_dicts,
        )

        return FixStrategyResponse(
            fixed_code=result["fixed_code"],
            changes=[FixChange(**c) for c in result["changes"]],
            confidence=result["confidence"],
        )
    except Exception as e:
        logger.exception("Unexpected error in fix-strategy")
        raise HTTPException(status_code=500, detail=f"Internal error: {str(e)}")


@router.post("/suggest-improvements", response_model=SuggestImprovementsResponse)
async def suggest_improvements_endpoint(request: SuggestImprovementsRequest):
    """Suggest improvements for valid strategy DSL code.

    Analyzes the strategy for common patterns that could be improved,
    such as missing volume confirmation, fixed stoploss values,
    single-indicator reliance, and missing trailing stops.
    """
    try:
        suggestions = await suggest_improvements(code=request.code)

        return SuggestImprovementsResponse(
            suggestions=[Suggestion(**s) for s in suggestions],
        )
    except Exception as e:
        logger.exception("Unexpected error in suggest-improvements")
        raise HTTPException(status_code=500, detail=f"Internal error: {str(e)}")
