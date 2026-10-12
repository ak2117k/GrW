"""Scorer routes: POST /score, POST /corpus/similar, GET /health.

State lives on ``app.state.scorer`` (ScorerHolder) and ``app.state.similar`` (SimilarIndex | None),
set up by ``src.scorer_main``. Contract for /score is shared with the Node ScorerClient (Task A7).
"""
from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from src.scorer.serve import UnknownFeatureSet

router = APIRouter()


class ScoreBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    featureSet: str
    breakdown: Any = None
    context: dict[str, Any]


class SimilarFilters(BaseModel):
    strategyKey: Optional[str] = None
    direction: Optional[str] = None


class SimilarBody(BaseModel):
    features: Optional[dict[str, Optional[float]]] = None
    featureSet: str = "fs1-legacy-checks"
    breakdown: Any = None
    context: Optional[dict[str, Any]] = None
    k: int = Field(default=5, ge=1, le=50)
    filters: SimilarFilters = SimilarFilters()


@router.post("/score")
def score(body: ScoreBody, request: Request) -> dict:
    try:
        return request.app.state.scorer.score(body.featureSet, body.breakdown, body.context)
    except UnknownFeatureSet as exc:
        raise HTTPException(status_code=422, detail=f"unknown featureSet: {exc}") from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.post("/corpus/similar")
def similar(body: SimilarBody, request: Request) -> dict:
    index = getattr(request.app.state, "similar", None)
    features = body.features
    if features is None:
        if body.context is None:
            raise HTTPException(status_code=422, detail="features or context is required")
        try:
            features, _ = request.app.state.scorer.features(body.featureSet, body.breakdown, body.context)
        except (UnknownFeatureSet, ValueError) as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
    if index is None:
        return {"items": []}
    return {"items": index.query(features, body.k, body.filters.model_dump(exclude_none=True))}


@router.get("/health")
def health(request: Request) -> dict:
    index = getattr(request.app.state, "similar", None)
    return {"status": "ok", "scorer": request.app.state.scorer.mode, "similarIndex": len(index) if index else 0}
