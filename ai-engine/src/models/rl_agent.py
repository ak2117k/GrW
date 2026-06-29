"""
Reinforcement Learning trading agent using PPO (Proximal Policy Optimization).

Implements a custom Gymnasium trading environment and a Stable-Baselines3 PPO agent
that learns to filter trade signals — deciding whether to TAKE or SKIP each signal,
adjusting confidence, and hinting position sizes.

Mode progression:
  - observe  (0–500 episodes):   suggestions only, no influence on execution
  - shadow   (500–1000 episodes): suggestions logged alongside live decisions
  - active   (1000+ episodes):    suggestions fed into the decision pipeline
"""

import logging
import os
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Graceful import for optional heavy dependencies
# ---------------------------------------------------------------------------
try:
    import numpy as np

    _HAS_NUMPY = True
except ImportError:
    np = None  # type: ignore[assignment]
    _HAS_NUMPY = False

try:
    import gymnasium
    from gymnasium import spaces

    _HAS_GYMNASIUM = True
except ImportError:
    gymnasium = None  # type: ignore[assignment]
    spaces = None  # type: ignore[assignment]
    _HAS_GYMNASIUM = False

try:
    from stable_baselines3 import PPO
    from stable_baselines3.common.vec_env import DummyVecEnv

    _HAS_SB3 = True
except ImportError:
    PPO = None  # type: ignore[assignment]
    DummyVecEnv = None  # type: ignore[assignment]
    _HAS_SB3 = False


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
OBS_DIM = 20
MAX_POSITIONS = 5
DAILY_LOSS_LIMIT = 10_000.0  # default daily loss limit in currency units

# Action decoding tables
CONFIDENCE_ADJUSTMENTS = [-20, -10, 0, 10, 20]
POSITION_SIZE_HINTS = [0.5, 1.0, 1.5, 2.0]

# Observation field order — must match between env and agent wrapper
OBS_FIELDS = [
    "market_regime",
    "regime_strength",
    "current_positions",
    "daily_pnl_normalized",
    "strategy_win_rate_rsi",
    "strategy_win_rate_ema",
    "strategy_win_rate_vwap",
    "volatility_level",
    "hour_of_day",
    "day_of_week",
    "news_sentiment",
    "signal_confidence_raw",
    "volume_ratio",
    "rsi_value",
    "ema_gap",
    "vwap_deviation",
    "risk_reward_ratio",
    "signal_agreement_count",
    "spread_from_high",
    "spread_from_low",
]

# Mode thresholds
MODE_OBSERVE_MAX = 500
MODE_SHADOW_MAX = 1000


# ============================================================================
# Part 1 — Custom Gymnasium Environment
# ============================================================================

def _build_trading_env_class():
    """Build and return the TradingEnv class.

    Wrapped in a factory so the module can be imported even when gymnasium
    is not installed.
    """
    if not _HAS_GYMNASIUM or not _HAS_NUMPY:
        return None

    class TradingEnv(gymnasium.Env):
        """A Gymnasium environment that replays one trading day of signals.

        Each *step* corresponds to one trade signal arriving. The agent
        decides whether to TAKE or SKIP it, with confidence and sizing hints.
        The reward is based on the trade outcome (or opportunity cost of
        skipping).
        """

        metadata = {"render_modes": []}

        def __init__(
            self,
            daily_loss_limit: float = DAILY_LOSS_LIMIT,
            max_positions: int = MAX_POSITIONS,
        ):
            super().__init__()

            self.daily_loss_limit = daily_loss_limit
            self.max_positions = max_positions

            # Observation: 20-dim box, each dimension normalised to [-1, 1]
            # (some fields like daily_pnl_normalized and sentiment use the
            #  full -1..1 range; others use 0..1)
            self.observation_space = spaces.Box(
                low=-1.0, high=1.0, shape=(OBS_DIM,), dtype=np.float32
            )

            # Action: MultiDiscrete — [decision(2), confidence_adj(5), size_hint(4)]
            self.action_space = spaces.MultiDiscrete([2, 5, 4])

            # Internal state
            self._signals: List[Dict[str, Any]] = []
            self._cursor: int = 0
            self._daily_pnl: float = 0.0
            self._current_positions: int = 0

        # ------------------------------------------------------------------ #
        # Gymnasium API
        # ------------------------------------------------------------------ #

        def reset(
            self,
            *,
            seed: Optional[int] = None,
            options: Optional[Dict[str, Any]] = None,
        ):
            super().reset(seed=seed)

            day_data = (options or {}).get("day_data")
            if day_data and len(day_data) > 0:
                self._signals = list(day_data)
            else:
                # Generate a minimal random day for self-play / testing
                self._signals = self._random_day()

            self._cursor = 0
            self._daily_pnl = 0.0
            self._current_positions = 0

            obs = self._build_obs(self._signals[self._cursor])
            return obs, {}

        def step(self, action):
            if self._cursor >= len(self._signals):
                # Should not happen, but guard anyway
                obs = np.zeros(OBS_DIM, dtype=np.float32)
                return obs, 0.0, True, False, {}

            signal = self._signals[self._cursor]
            reward = self._calculate_reward(action, signal)

            # Advance cursor
            self._cursor += 1
            terminated = self._cursor >= len(self._signals)
            truncated = False

            if terminated:
                obs = np.zeros(OBS_DIM, dtype=np.float32)
            else:
                obs = self._build_obs(self._signals[self._cursor])

            info = {
                "signal_index": self._cursor - 1,
                "daily_pnl": self._daily_pnl,
                "positions": self._current_positions,
                "action_decoded": self._decode_action(action),
            }

            return obs, reward, terminated, truncated, info

        # ------------------------------------------------------------------ #
        # Internals
        # ------------------------------------------------------------------ #

        def _build_obs(self, signal: Dict[str, Any]) -> np.ndarray:
            """Convert a signal dict into a numpy observation vector."""
            obs = np.zeros(OBS_DIM, dtype=np.float32)
            for i, field in enumerate(OBS_FIELDS):
                val = signal.get(field, 0.0)
                obs[i] = np.clip(float(val), -1.0, 1.0)

            # Override dynamic fields that depend on env state
            obs[2] = min(self._current_positions / self.max_positions, 1.0)
            if self.daily_loss_limit > 0:
                obs[3] = np.clip(
                    self._daily_pnl / self.daily_loss_limit, -1.0, 1.0
                )
            return obs

        def _calculate_reward(self, action, signal: Dict[str, Any]) -> float:
            """Compute reward for (action, signal) pair.

            Expected signal keys:
              - outcome_pnl: actual P&L if the trade had been taken
              - daily_loss_limit: (optional) override
            """
            decision = int(action[0])  # 0=SKIP, 1=TAKE
            outcome_pnl = float(signal.get("outcome_pnl", 0.0))
            limit = float(signal.get("daily_loss_limit", self.daily_loss_limit))
            if limit <= 0:
                limit = DAILY_LOSS_LIMIT

            normalized_pnl = outcome_pnl / limit  # scale into ~ -1..1

            reward = 0.0

            if decision == 1:  # TAKE
                self._daily_pnl += outcome_pnl
                self._current_positions = min(
                    self._current_positions + 1, self.max_positions
                )
                reward = normalized_pnl  # positive or negative
            else:  # SKIP
                if outcome_pnl > 0:
                    # Missed a profitable trade — opportunity cost
                    reward = -0.3 * abs(normalized_pnl)
                else:
                    # Correctly avoided a losing trade
                    reward = 0.1

            # Drawdown penalty
            if self._daily_pnl < -0.8 * limit:
                reward -= 2.0

            return float(reward)

        @staticmethod
        def _decode_action(action) -> Dict[str, Any]:
            decision = "TAKE" if int(action[0]) == 1 else "SKIP"
            confidence_adj = CONFIDENCE_ADJUSTMENTS[int(action[1])]
            size_hint = POSITION_SIZE_HINTS[int(action[2])]
            return {
                "decision": decision,
                "confidence_adjustment": confidence_adj,
                "position_size_hint": size_hint,
            }

        def _random_day(self, n_signals: int = 15) -> List[Dict[str, Any]]:
            """Generate a random day of synthetic signals for self-play."""
            rng = self.np_random if hasattr(self, "np_random") else np.random.default_rng()
            signals = []
            for _ in range(n_signals):
                sig: Dict[str, Any] = {}
                for field in OBS_FIELDS:
                    if field in (
                        "daily_pnl_normalized",
                        "news_sentiment",
                        "ema_gap",
                        "vwap_deviation",
                    ):
                        sig[field] = float(rng.uniform(-1.0, 1.0))
                    else:
                        sig[field] = float(rng.uniform(0.0, 1.0))
                # Synthetic outcome: slight negative skew to mimic real markets
                sig["outcome_pnl"] = float(rng.normal(loc=-50, scale=500))
                signals.append(sig)
            return signals

    return TradingEnv


# Build the class at module level (or None if deps missing)
TradingEnv = _build_trading_env_class()


# ============================================================================
# Part 2 — RL Agent Wrapper
# ============================================================================

class RLTradingAgent:
    """High-level wrapper around a PPO agent and the TradingEnv.

    Provides train / predict / reward-feedback APIs consumed by the
    AI-engine FastAPI service.
    """

    def __init__(
        self,
        model_path: str = "ai-engine/data/models/rl_agent.zip",
        max_adjustment: int = 20,
        daily_loss_limit: float = DAILY_LOSS_LIMIT,
    ):
        self.model_path = model_path
        self.max_adjustment = max_adjustment
        self.daily_loss_limit = daily_loss_limit

        self._model: Any = None
        self._episode_count: int = 0
        self._training_history: List[Dict[str, Any]] = []
        self._reward_buffer: Dict[str, float] = {}  # signal_id -> reward

        # Attempt to load a previously-saved model
        self.load_model()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def train(
        self,
        episodes_data: List[List[Dict[str, Any]]],
        total_timesteps: int = 10_000,
    ) -> Dict[str, Any]:
        """Train (or continue training) the PPO agent on historical day data.

        Args:
            episodes_data: List of day-data, where each day is a list of
                signal dicts containing observation fields + ``outcome_pnl``.
            total_timesteps: Total environment steps for this training run.

        Returns:
            Dict with training metrics.
        """
        if not self._deps_available():
            logger.warning("RL dependencies not installed — skipping training")
            return {"error": "missing_dependencies"}

        # Build a vectorised env that cycles through provided day data
        day_iter = iter(episodes_data) if episodes_data else iter([])
        remaining_days = list(day_iter)

        def _make_env():
            env = TradingEnv(daily_loss_limit=self.daily_loss_limit)
            env._training_days = list(remaining_days)  # attach for reset hook
            return env

        vec_env = DummyVecEnv([_make_env])

        if self._model is None:
            self._model = PPO(
                "MlpPolicy",
                vec_env,
                learning_rate=3e-4,
                n_steps=256,
                batch_size=64,
                n_epochs=10,
                gamma=0.99,
                gae_lambda=0.95,
                clip_range=0.2,
                verbose=0,
            )
        else:
            # Continue training on new env
            self._model.set_env(vec_env)

        self._model.learn(total_timesteps=total_timesteps)

        # Update bookkeeping
        episodes_trained = len(episodes_data) if episodes_data else 0
        self._episode_count += max(episodes_trained, 1)

        metrics = {
            "episodes_trained": episodes_trained,
            "total_episodes": self._episode_count,
            "total_timesteps": total_timesteps,
            "mode": self._current_mode(),
        }
        self._training_history.append(metrics)

        self.save_model()
        logger.info(
            "RL training complete: episodes=%d total=%d mode=%s",
            episodes_trained,
            self._episode_count,
            metrics["mode"],
        )
        return metrics

    def predict(self, observation: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Get the agent's action for a single observation.

        Args:
            observation: Dict with the 20 observation fields.

        Returns:
            Dict with decision, adjustments, and metadata — or ``None``
            when dependencies are missing or model is untrained.
        """
        if not self._deps_available() or self._model is None:
            return None

        obs_array = self._obs_dict_to_array(observation)
        action, _states = self._model.predict(obs_array, deterministic=True)

        decoded = TradingEnv._decode_action(action)

        # Clamp confidence adjustment to configured max
        adj = decoded["confidence_adjustment"]
        decoded["confidence_adjustment"] = int(
            np.clip(adj, -self.max_adjustment, self.max_adjustment)
        )

        return {
            "decision": decoded["decision"],
            "confidence_adjustment": decoded["confidence_adjustment"],
            "position_size_hint": decoded["position_size_hint"],
            "raw_action": [int(a) for a in action],
            "mode": self._current_mode(),
        }

    def feed_reward(self, signal_id: str, reward: float) -> None:
        """Store a reward for a completed trade for later offline training.

        Args:
            signal_id: Unique identifier of the trade signal.
            reward: Observed reward value.
        """
        self._reward_buffer[signal_id] = reward
        logger.debug("Stored reward for signal %s: %.4f", signal_id, reward)

    def is_trained(self) -> bool:
        """Return True if the agent has a loaded / trained model."""
        return self._model is not None

    def get_stats(self) -> Dict[str, Any]:
        """Return agent statistics and training history summary."""
        mean_reward = 0.0
        if self._reward_buffer:
            rewards = list(self._reward_buffer.values())
            mean_reward = sum(rewards) / len(rewards)

        return {
            "is_trained": self.is_trained(),
            "episode_count": self._episode_count,
            "mode": self._current_mode(),
            "mean_reward": round(mean_reward, 4),
            "reward_buffer_size": len(self._reward_buffer),
            "training_history": self._training_history[-10:],  # last 10
        }

    def save_model(self) -> None:
        """Persist the PPO model to disk."""
        if self._model is None:
            return
        model_dir = os.path.dirname(self.model_path)
        if model_dir:
            Path(model_dir).mkdir(parents=True, exist_ok=True)
        self._model.save(self.model_path)
        logger.info("RL model saved to %s", self.model_path)

    def load_model(self) -> None:
        """Load a previously saved PPO model from disk."""
        if not self._deps_available():
            return
        zip_path = self.model_path
        if not zip_path.endswith(".zip"):
            zip_path += ".zip"
        if os.path.isfile(zip_path) or os.path.isfile(self.model_path):
            try:
                env = TradingEnv(daily_loss_limit=self.daily_loss_limit)
                self._model = PPO.load(self.model_path, env=env)
                logger.info("RL model loaded from %s", self.model_path)
            except Exception as exc:
                logger.warning("Failed to load RL model: %s", exc)
                self._model = None

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _deps_available() -> bool:
        return _HAS_NUMPY and _HAS_GYMNASIUM and _HAS_SB3

    def _current_mode(self) -> str:
        if self._episode_count < MODE_OBSERVE_MAX:
            return "observe"
        if self._episode_count < MODE_SHADOW_MAX:
            return "shadow"
        return "active"

    @staticmethod
    def _obs_dict_to_array(obs: Dict[str, Any]) -> "np.ndarray":
        """Convert an observation dict to a (OBS_DIM,) float32 numpy array."""
        arr = np.zeros(OBS_DIM, dtype=np.float32)
        for i, field in enumerate(OBS_FIELDS):
            val = obs.get(field, 0.0)
            arr[i] = np.clip(float(val), -1.0, 1.0)
        return arr
