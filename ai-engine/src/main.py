"""
TD Automation - AI Engine
Self-learning trade analysis, signal scoring, and advisory bot.
"""

import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

# Configure logging early so import warnings are visible
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)

logger = logging.getLogger(__name__)

# Import route modules with graceful degradation.
# Scoring routes depend on numpy/pandas (via signal_scorer -> indicators).
# Sentiment, analysis, and advisor routes do NOT need numpy/pandas and must
# always be available.

_failed_modules: list[str] = []

try:
    from .routes.scoring import router as scoring_router
except ImportError as exc:
    scoring_router = None  # type: ignore[assignment]
    _failed_modules.append("scoring")
    logger.warning("Scoring routes unavailable (missing dependency: %s)", exc)

try:
    from .routes.sentiment import router as sentiment_router
except ImportError as exc:
    sentiment_router = None  # type: ignore[assignment]
    _failed_modules.append("sentiment")
    logger.warning("Sentiment routes unavailable (missing dependency: %s)", exc)

try:
    from .routes.analysis import router as analysis_router
except ImportError as exc:
    analysis_router = None  # type: ignore[assignment]
    _failed_modules.append("analysis")
    logger.warning("Analysis routes unavailable (missing dependency: %s)", exc)

try:
    from .routes.advisor import router as advisor_router
except ImportError as exc:
    advisor_router = None  # type: ignore[assignment]
    _failed_modules.append("advisor")
    logger.warning("Advisor routes unavailable (missing dependency: %s)", exc)

try:
    from .routes.strategy_validator import router as strategy_validator_router
except ImportError as exc:
    strategy_validator_router = None  # type: ignore[assignment]
    _failed_modules.append("strategy_validator")
    logger.warning("Strategy validator routes unavailable (missing dependency: %s)", exc)

app = FastAPI(
    title="TD Automation AI Engine",
    description="AI-powered trade analysis, scoring, and self-learning engine",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://localhost:3001"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include API route modules (only those that loaded successfully)
if scoring_router is not None:
    app.include_router(scoring_router, prefix="/api", tags=["scoring"])
if sentiment_router is not None:
    app.include_router(sentiment_router, prefix="/api", tags=["sentiment"])
if analysis_router is not None:
    app.include_router(analysis_router, prefix="/api", tags=["analysis"])
if advisor_router is not None:
    app.include_router(advisor_router, prefix="/api", tags=["advisor"])
if strategy_validator_router is not None:
    app.include_router(strategy_validator_router, prefix="/api", tags=["strategy-validator"])


@app.get("/health")
async def health_check():
    """Health check endpoint."""
    response = {"status": "healthy", "service": "ai-engine"}
    if _failed_modules:
        response["status"] = "degraded"
        response["unavailable_modules"] = _failed_modules
    return response


# Remaining route modules (to be added in future stages):
# - /api/weekly-report   → Generate weekly performance report
# - /api/backtest        → Run strategy backtest
