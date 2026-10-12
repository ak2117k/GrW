"""
API route modules for the TD Automation AI Engine.

Routers are resolved lazily (PEP 562) so importing one route module — e.g. the
scorer container importing ``src.routes.scorer`` — does not import every other
router and its heavy dependencies. ``from src.routes import scoring_router``
still works and yields None when that router's dependencies are missing.
"""

import importlib
import logging

_logger = logging.getLogger(__name__)

_ROUTERS = {
    "scoring_router": "scoring",
    "sentiment_router": "sentiment",
    "analysis_router": "analysis",
    "strategy_validator_router": "strategy_validator",
}

__all__ = list(_ROUTERS)


def __getattr__(name):
    module = _ROUTERS.get(name)
    if module is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    try:
        router = importlib.import_module(f".{module}", __name__).router
    except ImportError as exc:
        _logger.warning("%s routes could not be imported: %s", module, exc)
        router = None
    globals()[name] = router
    return router
