# ML/AI Engine — Real Machine Learning for TD Automation

**Date**: 2026-04-03  
**Status**: Approved  
**Scope**: Replace rule-based AI engine with real ML models (XGBoost, FinBERT, RL)

---

## Overview

The current "AI Engine" is entirely rule-based — keyword sentiment, hardcoded scoring weights, templated responses. This spec designs real ML capabilities:

1. **Signal Success Predictor** — XGBoost trained on trade outcomes
2. **FinBERT News Sentiment** — Finance-tuned BERT for news analysis
3. **RL Trading Agent** — PPO agent that learns from trade outcomes
4. **ML Control Panel** — User-configurable feature toggles and model behavior

All models run locally on CPU (₹0 infrastructure cost). Rule-based fallbacks preserved.

---

## Training Pipeline

### Phase 1: Bootstrap via Backtesting
- Run RSI, EMA, VWAP strategies across 1-2 years of historical data
- Instruments: NIFTY, BANKNIFTY, RELIANCE, HDFCBANK, TCS
- Generates ~1500-2000 simulated trades with known outcomes
- This is the initial training dataset

### Phase 2: Paper Trading Validation
- ML model runs in shadow mode alongside rule-based scoring
- Every paper trade outcome feeds back into training set
- After 200+ paper trades, compare ML accuracy vs rule-based
- Only promote to live when ML consistently outperforms

### Phase 3: Live Learning (Reinforcement Learning)
- Each real trade outcome = reward signal for RL agent
- Nightly retrain on full dataset (backtest + paper + live)
- RL agent adjusts strategy weights and signal confidence

---

## Component A: Signal Success Predictor (XGBoost)

**Replaces**: Hardcoded 6-factor weighted ensemble (30/20/15/10/15/10)

**Model**: XGBoost binary classifier → P(signal profitable) as 0-100%

### Feature Vector (14 features)

| # | Feature | Source | Type |
|---|---------|--------|------|
| 1 | RSI value at signal time | Strategy | Float |
| 2 | EMA gap (fast-slow) as % | Strategy | Float |
| 3 | VWAP deviation % | Strategy | Float |
| 4 | Volume ratio (current/20-bar avg) | Snapshot | Float |
| 5 | ATR ratio (short/long) | Snapshot | Float |
| 6 | OI change direction × trade side | Snapshot | Categorical→Int |
| 7 | Hour of day (IST) | Timestamp | Int (0-23) |
| 8 | Day of week | Timestamp | Int (0-6) |
| 9 | Strategy name | Signal | One-hot encoded |
| 10 | Market regime | ATR-based | Binary (0=ranging, 1=trending) |
| 11 | Risk-reward ratio | Signal | Float |
| 12 | Candle pattern (last 3) | Candles | Encoded Int |
| 13 | Spread from day high/low % | Snapshot | Float |
| 14 | Signal agreement count | Multi-strategy | Int |

**Target**: Binary — 1 if trade hit target, 0 if hit stoploss/expired at loss

**Training**: Nightly via cron or manual `/api/ml/train`. Minimum 200 samples before activation.

**Integration**: `signal-scoring.service.ts` calls `/api/score-signal` → Python returns XGBoost probability. Blend ratio configurable (default 60% ML / 40% rule-based).

---

## Component B: FinBERT News Sentiment

**Replaces**: 35 bullish + 21 bearish keyword matching

**Model**: `ProsusAI/finbert` — BERT fine-tuned on financial text. ~500MB, CPU inference ~200ms/article.

### Pipeline
1. News title + summary → FinBERT tokenizer → model inference
2. Output: `{positive: 0.82, negative: 0.05, neutral: 0.13}`
3. Sentiment score = `positive - negative` (range -1 to 1)
4. Confidence = `max(positive, negative, neutral)`
5. Entity extraction via spaCy `en_core_web_sm` for company/sector tagging

### Integration
- `/api/sentiment` endpoint — FinBERT replaces keyword logic
- News ingestion pipeline — score on ingest, not on-demand
- Calendar profit probability — uses FinBERT scores
- Signal scoring — sentiment feeds into XGBoost feature vector
- Fallback: keyword matching if FinBERT fails to load

---

## Component C: Reinforcement Learning Agent (PPO)

**Framework**: Stable-Baselines3 + Gymnasium custom environment

### Environment Design

**State (observation space)** — ~20 dimensional vector:
- Market regime (trending/ranging)
- Current open positions count
- Daily P&L so far (normalized)
- Strategy win rates (last 50 trades, per strategy)
- Current volatility level (ATR-based)
- Hour of day (IST)
- Day of week
- News sentiment (rolling 3-day mood)
- Signal agreement count
- Distance from day high/low

**Action space** — Discrete MultiAction:
- Signal decision: `[TAKE, SKIP]`
- Confidence adjustment: `[-20, -10, 0, +10, +20]`
- Position size hint: `[0.5x, 1x, 1.5x, 2x]`

**Reward function**:
- Trade taken and profitable: `+realized_pnl` (normalized)
- Trade taken and loss: `realized_pnl` (negative)
- Signal skipped, would have been profitable: `-0.3 × missed_pnl` (opportunity cost)
- Signal skipped, would have lost: `+0.1` (small reward for avoiding loss)
- Drawdown penalty: `-2.0` if daily loss > 80% of limit

**Episode**: One trading day (9:15 AM to 3:30 PM). Resets daily.

### Training
1. Bootstrap: Replay backtest trades as offline episodes (~500 episodes)
2. Paper mode: Agent suggests, doesn't execute — logged for comparison
3. Live mode: Blends with XGBoost: `final = 0.5 × XGBoost + 0.5 × RL_adjusted`
4. Nightly retrain on all episodes

### Safety Rails
- RL can only adjust scores ±20 points (configurable)
- Cannot override kill switch or risk limits from UserSettings
- Starts in observe-only mode
- Minimum 500 episodes before promotion to shadow mode
- Minimum 1000 episodes before promotion to active mode

---

## Component D: ML Control Panel

**Storage**: `mlConfig` JSON column in `UserSettings` model

### Configuration Schema
```json
{
  "xgboost": {
    "enabled": true,
    "features": {
      "rsi": true,
      "emaGap": true,
      "vwapDeviation": true,
      "volumeRatio": true,
      "atrRegime": true,
      "oiDirection": true,
      "hourOfDay": true,
      "dayOfWeek": true,
      "candlePattern": true,
      "strategyName": true,
      "marketRegime": true,
      "riskReward": true,
      "spreadFromHighLow": true,
      "signalAgreement": true
    },
    "minTrainingSamples": 200,
    "scoreThreshold": 40,
    "mlBlendRatio": 0.6
  },
  "finbert": {
    "enabled": true,
    "newsCategories": ["indian", "global", "sector", "company"],
    "sentimentWeight": 20,
    "minConfidence": 0.6
  },
  "rl": {
    "mode": "observe",
    "maxScoreAdjustment": 20,
    "positionSizeHints": true,
    "observationFeatures": {
      "currentPositions": true,
      "dailyPnl": true,
      "strategyWinRates": true,
      "marketVolatility": true,
      "newsSentiment": true,
      "timeOfDay": true,
      "sectorCorrelation": false
    },
    "minEpisodesForShadow": 500,
    "minEpisodesForActive": 1000
  },
  "training": {
    "schedule": "nightly",
    "dataSources": ["backtest", "paper", "live"],
    "testTrainSplit": 0.2
  }
}
```

### Frontend
- New "ML Settings" tab in Settings page
- Feature toggles with explanatory tooltips
- Model status dashboard (trained/untrained, accuracy, sample count)
- Manual train/retrain button

---

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/score-signal` | POST | Modified — XGBoost prediction with rule-based fallback |
| `/api/sentiment` | POST | Modified — FinBERT with keyword fallback |
| `/api/retrain` | POST | Modified — trains XGBoost + RL on all data |
| `/api/ml/status` | GET | Model status, sample count, accuracy, last trained |
| `/api/ml/train` | POST | Manual training trigger |
| `/api/ml/evaluate` | GET | ML vs rule-based accuracy comparison |
| `/api/ml/bootstrap` | POST | Run backtests to generate training data |
| `/api/ml/config` | GET/PUT | Read/update ML configuration |
| `/api/rl/action` | POST | RL agent evaluates signal → take/skip + adjustments |
| `/api/rl/reward` | POST | Feed trade outcome as reward |

---

## File Structure

```
ai-engine/
├── requirements.txt          # + xgboost, scikit-learn, transformers, torch,
│                              #   stable-baselines3, gymnasium, spacy
├── src/
│   ├── main.py               # Add new routes
│   ├── models/
│   │   ├── signal_scorer.py  # Keep as fallback
│   │   ├── xgboost_scorer.py # XGBoost signal predictor
│   │   ├── finbert_sentiment.py # FinBERT wrapper
│   │   └── rl_agent.py       # PPO agent + Gymnasium env
│   ├── services/
│   │   ├── training_service.py    # Orchestrates backtest→train→evaluate
│   │   ├── feature_engineer.py    # Feature vector extraction
│   │   ├── self_learning_service.py # Enhanced with real model updates
│   │   └── sentiment_service.py   # Swap to FinBERT
│   ├── data/
│   │   ├── models/            # Saved .joblib, .pt artifacts
│   │   └── training_data/     # Trade CSVs
│   └── utils/
│       ├── indicators.py      # Existing
│       └── market_regime.py   # Existing
```

## Dependencies

```
xgboost>=2.0
scikit-learn>=1.5
transformers>=4.40
torch>=2.2  # CPU-only
stable-baselines3>=2.3
gymnasium>=0.29
spacy>=3.7
```

- Disk: ~2GB (PyTorch CPU + FinBERT weights)
- RAM: ~1.5GB when all models loaded
- Training: XGBoost ~5s/2000 samples, RL ~2min/500 episodes

---

## Constraints
- All models run locally on CPU (₹0 cost)
- Rule-based fallbacks preserved for every ML component
- Safety limits from UserSettings are never overridden by ML
- Kill switch always accessible regardless of ML state
- Paper trading default for new models — must prove accuracy before live
