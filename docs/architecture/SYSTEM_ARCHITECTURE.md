# System Architecture

## Overview

TD Automation follows a **Monolith + Persistent Feed Service + Bull Queue Workers + Python AI Sidecar** architecture.

```
┌─────────────────────────────────────────────────────────────┐
│                     FRONTEND (React + Vite)                  │
│                        Port 3000                             │
├─────────────────────────────────────────────────────────────┤
│                     BACKEND (NestJS)                         │
│                        Port 3001                             │
│                                                              │
│  Modules: market-data | trade-engine | signal-generator      │
│           auto-trade | portfolio | news | ai-advisor         │
│           settings | alerts | backtest | options-chain       │
│                                                              │
│  Persistent Service:                                         │
│    MarketFeedService (Angel One WebSocket, max 50 tokens)    │
│                                                              │
│  Bull Queue Workers:                                         │
│    signal-scan | auto-trade | oi-tracker | news-fetch         │
│    daily-housekeeping                                        │
├─────────────────────────────────────────────────────────────┤
│                   AI ENGINE (Python + FastAPI)                │
│                        Port 5000                             │
│                                                              │
│  Services: signal-scorer | trade-analyzer | advisor-bot      │
│            sentiment-analyzer | self-learning-engine          │
├─────────────────────────────────────────────────────────────┤
│  PostgreSQL + TimescaleDB     │     Redis (Cache + Queues)   │
│       Port 5432               │         Port 6379            │
└─────────────────────────────────────────────────────────────┘
```

## Key Architectural Decision: MarketFeedService is NOT a Bull Worker

Angel One's SmartAPI provides a persistent WebSocket connection for live price data. This is fundamentally different from a job queue — it's a long-lived connection that must:
- Stay connected throughout market hours (09:15 - 15:30 IST)
- Auto-reconnect within 5 seconds on disconnect
- Manage subscriptions (max 50 tokens via WebSocket at once)
- Publish ticks to Redis pub/sub for other services to consume

Bull queue workers are for **batch/periodic tasks** — not persistent connections.

## Angel One Subscription Management

```
50 WebSocket slots total:
┌─────────────────────────────────────────┐
│ Primary Slots (1-30)                     │
│ User watchlist + open position symbols   │
│ Always subscribed                        │
├─────────────────────────────────────────┤
│ Scan Slots (31-50)                       │
│ Rotated every 30 sec for signal scanning │
│ Promoted to primary on signal detection  │
└─────────────────────────────────────────┘
```

## Data Flow

### Live Market Data
```
Angel One WebSocket
    → MarketFeedService (persistent, manages 50-token subscriptions)
        → Redis Pub/Sub (real-time tick distribution)
            → Frontend (via Socket.IO gateway)
            → Candle Aggregator (1m/5m/15m/1h in memory, flush to DB)
            → OI Tracker Worker (snapshots every 1 min)
        → On candle close → Signal Scan Worker triggered
```

### Signal Generation & Scoring
```
Signal Scan Worker (Bull queue, triggered on candle close)
    → Runs active TradingStrategy.analyze() against market snapshot
    → Calls AI Engine POST /api/score-signal → confidence 0-100
    → Signal stored in DB
    → Published to Frontend via WebSocket
    → If auto-trade enabled → Auto-Trade Worker triggered
```

### AI Confidence Scoring
```
Weighted ensemble (0-100):
  Strategy signal strength   → 30%
  Multi-timeframe alignment  → 20%
  Volume confirmation        → 15%
  OI support                 → 10%
  Historical performance     → 15%
  Market regime fit          → 10%

After 100+ trades: blended with XGBoost ML model (50/50)
After 500+ trades: ML model weight increases to 70%
```

### Auto Trade Execution
```
Auto-Trade Worker (Bull queue, triggered by new signal)
    → Risk Manager validates:
        ├── Max daily loss not breached?
        ├── Max concurrent positions not reached?
        ├── Max capital per trade respected?
        └── Within market hours?
    → If FULLY_AUTOMATIC + confidence >= 60 → BrokerAdapter.placeOrder()
    → If APPROVAL_REQUIRED + confidence >= 75 → notify user, await approval
    → If PAPER_TRADING → simulate execution in DB
    → Track order: pending → filled/partial/rejected
    → Auto-place stoploss after entry fill
    → Log everything for AI self-learning
```

## Plugin Points

| Interface | Purpose | How to extend |
|-----------|---------|---------------|
| `BrokerAdapter` | Broker integration | New class implementing the interface |
| `TradingStrategy` | Trading algorithms | New class implementing the interface |
| News sources | Data feeds | Add new RSS/API source in news module config |

## Graceful Degradation

| Component down | System behavior |
|---------------|-----------------|
| AI Engine (Python) | Signals still generated, scored by rules only (no ML) |
| Redis | App falls back to REST polling, no real-time push |
| Database | Live feed continues via in-memory buffer, trades queued |
| Angel One WebSocket | Auto-reconnect in 5s; REST polling as fallback |

## Scaling Path (Local → Cloud)

1. **Local**: All services on one machine (current)
2. **Single VPS**: Same architecture, just on a cloud server
3. **Split services**: MarketFeedService + workers as separate processes
4. **Full microservices**: Each module becomes its own service (if ever needed)
