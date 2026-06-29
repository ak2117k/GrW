"""
API route modules for the TD Automation AI Engine.
"""

import logging

_logger = logging.getLogger(__name__)

_all_routers = []

try:
    from .scoring import router as scoring_router
    _all_routers.append("scoring_router")
except ImportError as exc:
    scoring_router = None  # type: ignore[assignment]
    _logger.warning("scoring routes could not be imported: %s", exc)

try:
    from .sentiment import router as sentiment_router
    _all_routers.append("sentiment_router")
except ImportError as exc:
    sentiment_router = None  # type: ignore[assignment]
    _logger.warning("sentiment routes could not be imported: %s", exc)

try:
    from .analysis import router as analysis_router
    _all_routers.append("analysis_router")
except ImportError as exc:
    analysis_router = None  # type: ignore[assignment]
    _logger.warning("analysis routes could not be imported: %s", exc)

try:
    from .strategy_validator import router as strategy_validator_router
    _all_routers.append("strategy_validator_router")
except ImportError as exc:
    strategy_validator_router = None  # type: ignore[assignment]
    _logger.warning("strategy_validator routes could not be imported: %s", exc)

__all__ = _all_routers
