"""
ML API routes — model training, evaluation, configuration, and RL endpoints.
"""

import json
import logging
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..services.training_service import (
    bootstrap_training_data,
    evaluate_models,
    get_ml_status,
    train_rl,
    train_xgboost,
    _load_ml_config,
    _save_ml_config,
    _default_ml_config,
)

logger = logging.getLogger(__name__)

router = APIRouter()


# ---------------------------------------------------------------------------
# Request / Response Models
# ---------------------------------------------------------------------------


class MLStatusResponse(BaseModel):
    """Response for GET /api/ml/status."""
    xgboost: Dict[str, Any]
    finbert: Dict[str, Any]
    rl: Dict[str, Any]


class TrainRequest(BaseModel):
    """Request body for POST /api/ml/train."""
    components: List[str] = Field(
        default=["all"],
        description="Components to train: xgboost, rl, or all",
    )
    data_sources: List[str] = Field(
        default=["backtest", "paper", "live"],
        description="Data sources to use for training",
    )


class TrainResponse(BaseModel):
    """Response for POST /api/ml/train."""
    xgboost: Optional[Dict[str, Any]] = None
    rl: Optional[Dict[str, Any]] = None
    message: str = ""


class EvaluateResponse(BaseModel):
    """Response for GET /api/ml/evaluate."""
    xgboost: Dict[str, Any]
    rule_based: Dict[str, Any]
    improvement_pct: float


class CandleInput(BaseModel):
    """Single candle data point for bootstrap."""
    open: float = 0.0
    high: float = 0.0
    low: float = 0.0
    close: float = 0.0
    volume: float = 0.0


class BootstrapRequest(BaseModel):
    """Request body for POST /api/ml/bootstrap."""
    instruments: List[str] = Field(
        default=["NIFTY", "BANKNIFTY"],
        description="Instruments to generate training data for",
    )
    days: int = Field(default=365, ge=1, le=3650)
    candle_data: Optional[Dict[str, List[Dict[str, Any]]]] = Field(
        default=None,
        description="Historical candle data keyed by instrument symbol",
    )


class BootstrapResponse(BaseModel):
    """Response for POST /api/ml/bootstrap."""
    total_trades: int
    profitable: int
    unprofitable: int
    file_path: str


class XGBoostConfig(BaseModel):
    """XGBoost configuration."""
    enabled: bool = True
    features: Dict[str, bool] = Field(default_factory=lambda: {
        "rsi": True, "emaGap": True, "vwap": True,
        "atr": True, "volume_ratio": True, "oi_change": True,
    })
    minTrainingSamples: int = 200
    scoreThreshold: int = 40
    mlBlendRatio: float = 0.6


class FinBERTConfig(BaseModel):
    """FinBERT configuration."""
    enabled: bool = True
    newsCategories: List[str] = Field(
        default=["indian", "global", "sector", "company"]
    )
    sentimentWeight: int = 20
    minConfidence: float = 0.6


class RLConfig(BaseModel):
    """RL agent configuration."""
    mode: str = "observe"
    maxScoreAdjustment: int = 20
    positionSizeHints: bool = True
    episodes: int = 1000
    learningRate: float = 0.001


class TrainingScheduleConfig(BaseModel):
    """Training schedule configuration."""
    schedule: str = "nightly"
    dataSources: List[str] = Field(
        default=["backtest", "paper", "live"]
    )
    testTrainSplit: float = 0.2


class MLConfigSchema(BaseModel):
    """Full ML configuration schema."""
    xgboost: XGBoostConfig = Field(default_factory=XGBoostConfig)
    finbert: FinBERTConfig = Field(default_factory=FinBERTConfig)
    rl: RLConfig = Field(default_factory=RLConfig)
    training: TrainingScheduleConfig = Field(default_factory=TrainingScheduleConfig)


class RLActionRequest(BaseModel):
    """Request body for POST /api/rl/action."""
    observation: Dict[str, Any] = Field(
        ...,
        description="Current market observation (market_regime, current_positions, etc.)",
    )
    signal_id: str = Field(..., description="Signal ID to evaluate")


class RLActionResponse(BaseModel):
    """Response for POST /api/rl/action."""
    decision: str = Field(..., description="TAKE or SKIP")
    confidence_adjustment: int = 0
    position_size_hint: float = 1.0
    mode: str = "observe"


class RLRewardRequest(BaseModel):
    """Request body for POST /api/rl/reward."""
    signal_id: str = Field(..., description="Signal ID that was traded")
    reward: float = Field(..., description="Reward value for the RL agent")
    trade_pnl: float = Field(default=0.0, description="Actual P&L from the trade")


class RLRewardResponse(BaseModel):
    """Response for POST /api/rl/reward."""
    signal_id: str
    reward_recorded: bool
    message: str = ""


# ---------------------------------------------------------------------------
# ML Routes
# ---------------------------------------------------------------------------


@router.get("/ml/status", response_model=MLStatusResponse)
async def ml_status_endpoint():
    """Return current status of all ML models (XGBoost, FinBERT, RL)."""
    try:
        status = await get_ml_status()
        return MLStatusResponse(**status)
    except Exception as e:
        logger.exception("Error fetching ML status")
        raise HTTPException(status_code=500, detail=f"Internal error: {str(e)}")


@router.post("/ml/train", response_model=TrainResponse)
async def ml_train_endpoint(request: TrainRequest):
    """Trigger training for specified ML components.

    Trains XGBoost and/or RL models based on the requested components.
    """
    try:
        components = request.components
        train_all = "all" in components
        results: Dict[str, Any] = {}
        messages: List[str] = []

        if train_all or "xgboost" in components:
            xgb_result = await train_xgboost(
                data_sources=request.data_sources
            )
            results["xgboost"] = xgb_result
            messages.append(
                f"XGBoost: accuracy={xgb_result.get('accuracy', 0)}, "
                f"samples={xgb_result.get('samples_used', 0)}"
            )

        if train_all or "rl" in components:
            rl_result = await train_rl()
            results["rl"] = rl_result
            messages.append(
                f"RL: episodes={rl_result.get('episodes_trained', 0)}, "
                f"reward={rl_result.get('mean_reward', 0)}"
            )

        return TrainResponse(
            xgboost=results.get("xgboost"),
            rl=results.get("rl"),
            message="; ".join(messages) if messages else "No components trained",
        )

    except Exception as e:
        logger.exception("Error during ML training")
        raise HTTPException(status_code=500, detail=f"Training error: {str(e)}")


@router.get("/ml/evaluate", response_model=EvaluateResponse)
async def ml_evaluate_endpoint():
    """Compare ML model accuracy vs rule-based scoring on held-out test data."""
    try:
        result = await evaluate_models()
        return EvaluateResponse(**result)
    except Exception as e:
        logger.exception("Error during model evaluation")
        raise HTTPException(status_code=500, detail=f"Evaluation error: {str(e)}")


@router.post("/ml/bootstrap", response_model=BootstrapResponse)
async def ml_bootstrap_endpoint(request: BootstrapRequest):
    """Generate training data by simulating trades on historical candle data.

    If candle_data is not provided in the request body, returns an error
    since historical data is required for bootstrapping.
    """
    try:
        candle_data = request.candle_data
        if not candle_data:
            raise HTTPException(
                status_code=422,
                detail="candle_data is required for bootstrapping. "
                "Provide historical OHLCV data keyed by instrument symbol.",
            )

        strategy_names = ["rsi_reversal", "ema_crossover", "vwap_bounce"]

        result = await bootstrap_training_data(
            instruments=request.instruments,
            strategy_names=strategy_names,
            candle_data=candle_data,
        )

        return BootstrapResponse(**result)

    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Error during bootstrap")
        raise HTTPException(status_code=500, detail=f"Bootstrap error: {str(e)}")


@router.get("/ml/config", response_model=MLConfigSchema)
async def ml_config_get_endpoint():
    """Return the current ML configuration."""
    try:
        config = _load_ml_config()
        return MLConfigSchema(**config)
    except Exception as e:
        logger.exception("Error reading ML config")
        raise HTTPException(status_code=500, detail=f"Config error: {str(e)}")


@router.put("/ml/config", response_model=MLConfigSchema)
async def ml_config_put_endpoint(config: MLConfigSchema):
    """Update and persist the ML configuration."""
    try:
        config_dict = config.model_dump()
        _save_ml_config(config_dict)
        logger.info("ML config updated")
        return config
    except Exception as e:
        logger.exception("Error saving ML config")
        raise HTTPException(status_code=500, detail=f"Config error: {str(e)}")


# ---------------------------------------------------------------------------
# RL Routes
# ---------------------------------------------------------------------------


@router.post("/rl/action", response_model=RLActionResponse)
async def rl_action_endpoint(request: RLActionRequest):
    """Get the RL agent's action for a given market observation.

    Returns the agent's decision (TAKE or SKIP), confidence adjustment,
    and position size hint.
    """
    try:
        config = _load_ml_config()
        rl_mode = config.get("rl", {}).get("mode", "observe")
        max_adjustment = config.get("rl", {}).get("maxScoreAdjustment", 20)

        # Try to use the trained RL agent
        try:
            from ..models.rl_agent import RLTradingAgent
            from pathlib import Path

            _data_dir = Path(__file__).resolve().parent.parent.parent / "data"
            model_path = _data_dir / "models" / "rl_agent.zip"

            if model_path.exists():
                agent = RLTradingAgent()
                agent.load(str(model_path))

                action = agent.predict(request.observation)

                decision = "TAKE" if action.get("take", True) else "SKIP"
                raw_adjustment = action.get("confidence_adjustment", 0)
                confidence_adjustment = max(
                    -max_adjustment, min(max_adjustment, raw_adjustment)
                )
                position_size_hint = action.get("position_size_hint", 1.0)

                return RLActionResponse(
                    decision=decision,
                    confidence_adjustment=confidence_adjustment,
                    position_size_hint=round(position_size_hint, 2),
                    mode=rl_mode,
                )
            else:
                logger.info("RL model not found, returning default action")

        except ImportError:
            logger.info("RL agent module not available, returning default action")

        # Default: observe mode, always TAKE, no adjustment
        return RLActionResponse(
            decision="TAKE",
            confidence_adjustment=0,
            position_size_hint=1.0,
            mode=rl_mode,
        )

    except Exception as e:
        logger.exception("Error in RL action")
        raise HTTPException(status_code=500, detail=f"RL action error: {str(e)}")


@router.post("/rl/reward", response_model=RLRewardResponse)
async def rl_reward_endpoint(request: RLRewardRequest):
    """Feed reward back to the RL agent for a completed trade.

    Records the reward for learning and updates the agent's experience buffer.
    """
    try:
        try:
            from ..models.rl_agent import RLTradingAgent
            from pathlib import Path

            _data_dir = Path(__file__).resolve().parent.parent.parent / "data"
            model_path = _data_dir / "models" / "rl_agent.zip"

            if model_path.exists():
                agent = RLTradingAgent()
                agent.load(str(model_path))
                agent.record_reward(
                    signal_id=request.signal_id,
                    reward=request.reward,
                    trade_pnl=request.trade_pnl,
                )

                logger.info(
                    "RL reward recorded: signal=%s, reward=%.2f, pnl=%.2f",
                    request.signal_id,
                    request.reward,
                    request.trade_pnl,
                )

                return RLRewardResponse(
                    signal_id=request.signal_id,
                    reward_recorded=True,
                    message="Reward recorded and experience buffer updated",
                )

        except ImportError:
            logger.info("RL agent module not available")

        # Fallback: just log the reward
        logger.info(
            "RL reward logged (agent not loaded): signal=%s, reward=%.2f",
            request.signal_id,
            request.reward,
        )

        return RLRewardResponse(
            signal_id=request.signal_id,
            reward_recorded=False,
            message="Reward logged but RL agent not loaded",
        )

    except Exception as e:
        logger.exception("Error recording RL reward")
        raise HTTPException(status_code=500, detail=f"RL reward error: {str(e)}")
