"""Minimal FastAPI app for the scorer container: only /score, /corpus/similar and /health.

Deliberately does not import ``src.main`` (FinBERT, telethon, agent SDK...). Startup, from env:
- MODELS_DIR (default ai-engine/data/models) — artifact directory;
- SCORER_MODEL_ID — explicit model to serve, else the active ``xgb-entry`` row via AI_DB_URL;
  either way it is served only if its training gate was GO (artifact ``gate``, else the
  ``ai_models`` row when AI_DB_URL is set) — a NO_GO model falls back to rule scoring;
- AI_DB_URL — registry lookup and the /corpus/similar index (all ENTRY_SETUP records).
Any failure degrades to rule-only scoring / an empty index, logged; the app always starts.
"""
from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager, suppress
from pathlib import Path

from fastapi import FastAPI

from src.routes.scorer import router
from src.scorer.serve import ScorerHolder

logger = logging.getLogger("scorer")
DEFAULT_MODELS_DIR = Path(__file__).resolve().parents[1] / "data" / "models"


def _registry_gate(conn, model_id: str | None) -> str | None:
    """The ``ai_models`` gate for ``model_id`` (only consulted when the artifact predates gate
    recording); None without a DB or on a lookup failure, which keeps such a model refused."""
    if conn is None or not model_id:
        return None
    try:
        from src.scorer.registry import gate_of
        return gate_of(conn, model_id)
    except Exception as exc:  # noqa: BLE001
        logger.error("scorer: registry gate lookup failed for %s: %s", model_id, exc)
        with suppress(Exception):
            conn.rollback()  # leave the connection usable for the similar index
        return None


def _startup(app: FastAPI) -> None:
    models_dir = Path(os.environ.get("MODELS_DIR") or DEFAULT_MODELS_DIR)
    holder = ScorerHolder(models_dir)
    app.state.scorer, app.state.similar = holder, None
    db_url = os.environ.get("AI_DB_URL")
    model_id = os.environ.get("SCORER_MODEL_ID") or None
    conn = None
    try:
        if db_url:
            from src.corpus.db import connect
            conn = connect(db_url)
        registry_id = Path(model_id).stem if model_id else None
        if model_id is None and conn is not None:
            from src.scorer.registry import load_active
            active = load_active(conn)
            registry_id, model_id = (active[0], active[1].stem) if active else (None, None)
        holder.load(model_id, registry_gate=_registry_gate(conn, registry_id))
    except Exception as exc:  # noqa: BLE001 — never fail startup; rule scoring is the fallback
        logger.error("scorer: model load failed, serving rule scores only: %s", exc)
        holder.load(None)
    try:
        if conn is not None:
            from src.corpus.export import load_frame
            from src.corpus.similar import SimilarIndex
            from src.scorer.features_fs1 import FEATURE_SET
            app.state.similar = SimilarIndex(load_frame(conn, FEATURE_SET, taken_only=False, require_label=False))
    except Exception as exc:  # noqa: BLE001
        logger.error("scorer: similar index unavailable: %s", exc)
    finally:
        if conn is not None:
            conn.close()
    logger.info("scorer ready: %s, similar index %d rows", holder.mode,
                len(app.state.similar) if app.state.similar else 0)


def create_app(*, holder: ScorerHolder | None = None, similar=None, from_env: bool = True) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        if holder is None and from_env:
            _startup(app)
        yield

    app = FastAPI(title="GrW ai-engine scorer", lifespan=lifespan)
    app.state.scorer = holder or ScorerHolder(DEFAULT_MODELS_DIR)
    app.state.similar = similar
    app.include_router(router)
    return app


logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
app = create_app()
