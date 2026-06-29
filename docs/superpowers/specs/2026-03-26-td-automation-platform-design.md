# TD Automation — Automated Trading Platform Design

> Date: 2026-03-26
> Author: Aryan Kumar + Claude
> Status: Approved

---

## 1. Vision

A self-contained automated trading platform for the Indian market that consolidates live market data, trade execution, AI-powered signal generation, self-learning analytics, and portfolio management into a single deployable application. Designed for local-first development with cloud migration path.

## 2. Core Requirements

### 2.1 Market Data
- Live streaming prices for **watchlisted instruments** (not all stocks — see Section 3.6 for Angel One constraints)
- All major indices: Nifty 50, BankNifty, FinNifty, Sensex, Nifty Midcap, sector indices
- Configurable watchlists — user selects which stocks/commodities to stream (up to 50 at a time via WebSocket, with rotation support for scanning more)
- Full instrument master list (all NSE/BSE/MCX instruments) stored locally, refreshed daily from Angel One
- Live Open Interest (OI) data with change tracking
- Historical candle data (1min, 5min, 15min, 1hr, daily)
- Options chain with Greeks (Delta, Gamma, Theta, Vega, IV)
- Market breadth: advance/decline, sector heatmap, FII/DII data (via REST polling, not WebSocket)

### 2.2 Live Charts
- Candlestick charts via TradingView Lightweight Charts (open source)
- OI overlay on charts
- Multi-timeframe view (5min, 15min, 1hr, daily)
- Technical indicators (RSI, VWAP, EMA, Bollinger, custom)
- Drawing tools and annotations

### 2.3 Signal Generator
- Algorithmic scanning against live data
- Pluggable strategy system (Gamma Blast, RSI-based, VWAP, custom)
- Each signal includes: instrument, direction, entry, target, stoploss, expected profit, risk/reward, confidence score
- Multi-timeframe confirmation before signal emission — signal must be confirmed on at least 2 timeframes
- Ranked by AI confidence score (see Section 3.7 for scoring definition)

### 2.4 Auto-Trade Engine
- Executes highest-ranked signals that meet configured criteria
- Risk limits enforced as hard constraints (max daily loss, max position size, max concurrent trades)
- Configurable modes: fully automatic, approval-required, paper trading
- Kill switch — instant square-off of all positions via market orders
- Every decision logged for audit and self-learning
- **Order lifecycle management**: handles MARKET, LIMIT, SL, SL-M orders; tracks partial fills, rejections, modifications; supports AMO (After Market Orders)
- Automatic stoploss placement after entry fill
- Trailing stoploss support (configurable)

### 2.5 Portfolio & Dashboard
- Real-time P&L: daily, weekly, monthly, all-time
- Win rate, avg profit/loss, Sharpe ratio, max drawdown
- Equity curve visualization
- Segment-wise breakdown (options, equity, commodity, swing)
- Trade journal with full history, filters, export

### 2.6 News Aggregator
- RSS feeds from: Economic Times, MoneyControl, Reuters, LiveMint
- Categorized: Indian market, Global, Sector, Company-specific
- AI sentiment analysis (bullish/bearish/neutral)
- Alerts when news impacts open positions or watchlist

### 2.7 AI Advisor Bot
- Observes all trades (manual + automated)
- Pattern analysis: what works, what doesn't, time-of-day, segment performance
- Weekly performance reports with actionable suggestions
- Interactive: "Should I take this trade?", "Why did I lose this week?"
- Self-learning engine (see Section 3.8 for concrete mechanism)

### 2.8 Settings
- Algorithm selection and parameter tuning
- Risk/reward ratio, max loss/day, max loss/trade
- Auto-trade toggle, approval mode toggle
- Paper trading mode toggle
- Broker API credentials management (encrypted at rest with AES-256)
- Notification preferences (desktop notifications via Electron/browser notifications)

### 2.9 Backtesting Engine
- Run any strategy against historical data
- Performance metrics: total return, win rate, max drawdown, Sharpe
- Compare strategies side-by-side
- Visual equity curve for backtest results

### 2.10 Alerts System
- Price alerts (above/below threshold)
- OI spike alerts (configurable threshold, e.g., >5% change in 5 min)
- News alerts for watchlist stocks
- P&L threshold alerts (daily loss limit approaching — 80% and 100% of max)
- Desktop notifications via browser Notification API (push notifications when mobile comes)

## 3. Architecture

### 3.1 Approach
Monolith-first with a **persistent live-feed service** and Bull queue workers for batch background jobs. Python ML sidecar for AI engine. Designed for easy extraction into microservices when scaling to cloud.

### 3.2 Stack

| Layer | Technology | Port |
|-------|-----------|------|
| Frontend | React + Vite + TypeScript | 3000 |
| Backend | NestJS + TypeScript | 3001 |
| AI Engine | Python + FastAPI | 5000 |
| Database | PostgreSQL + TimescaleDB | 5432 |
| Cache/Queue | Redis + Bull | 6379 |
| Charts | TradingView Lightweight Charts | - |
| Broker | Angel One SmartAPI | - |

### 3.3 Module Architecture
Each NestJS module is self-contained with:
- Controller (REST endpoints)
- Gateway (WebSocket events where needed)
- Service (business logic)
- Repository (data access)
- DTOs (validation via class-validator)
- Strategy interfaces (pluggable algorithms)

### 3.4 Services & Workers

**Persistent Services** (long-running, not queue-based):
- `MarketFeedService` — maintains persistent WebSocket connection to Angel One, manages instrument subscriptions (max 50 tokens), handles reconnection on disconnect, publishes tick data to Redis pub/sub

**Bull Queue Workers** (job-based, for batch/periodic tasks):
- `signal-scan` — runs strategy algorithms against latest market snapshots (triggered on new candle close)
- `auto-trade` — evaluates and executes top signals (triggered when new signal generated)
- `oi-tracker` — periodic OI snapshot capture and spike detection (every 1 min during market hours)
- `news-fetch` — periodic news aggregation and sentiment analysis (every 5 min)
- `daily-housekeeping` — instrument master refresh, candle aggregation, data cleanup (daily at 6:00 AM IST)

### 3.5 Data Flow

```
Angel One WebSocket
    → MarketFeedService (persistent connection, manages subscriptions)
        → Redis Pub/Sub (real-time tick distribution)
            → Frontend (via Socket.IO gateway)
            → Candle Aggregator (builds 1m/5m/15m/1h candles in memory, flushes to DB)
            → OI Tracker Worker (captures OI snapshots)
        → On candle close:
            → Signal Scan Worker
                → TradingStrategy.analyze() for each active strategy
                → AI Engine /api/score-signal (HTTP) → confidence score
                → Signal stored in DB + published to frontend
                → If auto-trade enabled → Auto-Trade Worker
                    → Risk Manager validates (max loss, max positions, etc.)
                    → BrokerAdapter.placeOrder()
                    → Order tracked until filled/rejected
```

### 3.6 Angel One SmartAPI Constraints

**These constraints are architectural load-bearing — do not bypass them.**

| Constraint | Limit | Our approach |
|-----------|-------|-------------|
| WebSocket subscriptions | ~50 tokens simultaneously | Watchlist-based streaming; rotation for scanning |
| REST API rate limit | 10 requests/sec | Request queue with rate limiter |
| Session validity | Until midnight; requires daily TOTP login | Auto-login at 8:50 AM IST via TOTP secret |
| Token refresh | JWT expires periodically | Background refresh before expiry |
| Historical data | Max 2000 candles per request | Paginated backfill with chunking |
| Order rate | ~10 orders/sec | Queue orders if burst needed |

**Subscription Rotation**: For scanning more than 50 instruments (e.g., screening all F&O stocks for signals), the system uses a rotation strategy:
1. Primary slots (1-30): Always subscribed — user's watchlist + open positions
2. Scan slots (31-50): Rotate through instrument groups every 30 seconds
3. On signal detection, the instrument is promoted to primary slots

### 3.7 AI Confidence Scoring (Concrete Definition)

The confidence score (0-100) is computed by the Python AI engine using a weighted ensemble:

| Factor | Weight | Source | Score Range |
|--------|--------|--------|-------------|
| Strategy signal strength | 30% | Strategy's internal score | 0-100 |
| Multi-timeframe alignment | 20% | How many timeframes confirm | 0 (1 TF), 50 (2 TFs), 100 (3+ TFs) |
| Volume confirmation | 15% | Volume vs 20-day average | 0 (below avg) to 100 (>2x avg) |
| OI support | 10% | OI change direction aligns with trade | 0 or 100 |
| Historical strategy performance | 15% | Win rate of this strategy in last 30 days | 0-100 scaled |
| Market regime | 10% | Trending vs ranging (ATR-based) | 0-100 based on strategy fit |

**Thresholds:**
- < 40: Signal discarded (not shown to user)
- 40-60: LOW confidence — shown but not auto-traded
- 60-75: MEDIUM confidence — auto-traded only in FULLY_AUTOMATIC mode
- 75-90: HIGH confidence — auto-traded in APPROVAL_REQUIRED mode (with notification)
- 90+: VERY_HIGH confidence — auto-traded in all modes

**Initial phase (before ML model is trained)**: Uses the weighted ensemble above with fixed weights. No ML — just rules.
**After 100+ trades logged**: Trains a gradient boosting model (XGBoost) on trade outcomes to predict probability of profit. Model score blended 50/50 with rule-based score.
**After 500+ trades**: ML model weight increases to 70%, rule-based drops to 30%.

### 3.8 Self-Learning Mechanism (Concrete Definition)

Self-learning is NOT a vague concept — it is a specific feedback loop:

**What is learned:**
1. **Strategy performance by market condition** — which strategies work in trending vs ranging, high-vol vs low-vol markets
2. **Optimal parameters** — best RSI periods, VWAP deviations, etc., based on recent outcomes
3. **Time-of-day patterns** — which hours produce best results for each strategy
4. **Risk adjustment** — optimal position sizing based on recent drawdown/equity curve

**How it works:**
1. Every closed trade is sent to `POST /api/analyze-trade` on the Python engine
2. The engine logs: entry conditions, exit conditions, market regime at entry, time, strategy, outcome
3. Weekly batch job (`/api/retrain`) runs:
   - Recomputes strategy win rates by market condition
   - Updates confidence score weights if ML model exists
   - Generates parameter optimization suggestions (grid search on last 90 days of data)
   - Produces weekly report with insights
4. Updated weights and suggestions are stored in DB and applied to next trading session
5. User can accept or reject parameter suggestions via Settings page

**What is NOT self-learning:**
- It does NOT autonomously change risk limits (those are user-controlled hard constraints)
- It does NOT add/remove strategies without user approval
- It does NOT override the kill switch or safety mechanisms

### 3.9 Market Hours Awareness

| Session | Time (IST) | System behavior |
|---------|-----------|-----------------|
| Pre-boot | 08:45 | System starts, Angel One login via TOTP |
| Pre-market | 09:00 - 09:15 | Connect WebSocket, load instrument master, warm caches |
| Market open | 09:15 - 15:30 | Full operation: streaming, signals, auto-trade |
| Market close | 15:30 | Stop signal generation, cancel pending orders |
| Post-market | 15:30 - 16:00 | Final P&L snapshot, daily performance log |
| After hours | 16:00 - 23:30 | MCX commodities only (if enabled) |
| Night | 23:30 - 08:45 | Idle — daily housekeeping at 06:00 |
| Holidays | All day | No trading — detected via NSE holiday calendar (fetched annually) |

### 3.10 Authentication & Security

This is a **single-user local application** (not multi-tenant). Security focuses on:

- **Broker credentials**: Encrypted with AES-256 using a master password, stored in local DB. Decrypted in-memory only during active session.
- **API access**: Backend binds to `localhost` by default. If exposed on LAN, a configurable API key is required.
- **No user auth initially**: Single user, local machine. When deployed to cloud, add basic auth (username + password with bcrypt).
- **Audit log**: Immutable append-only log of all trade decisions and order executions.

## 4. Frontend Pages

| Page | Route | Purpose |
|------|-------|---------|
| Dashboard | `/` | P&L overview, equity curve, today's trades, active positions |
| Live Charts | `/charts` | Candlestick charts with OI, indicators, multi-timeframe |
| Market Overview | `/market` | All indices, stocks, commodities watchlist grid |
| Options Chain | `/options` | Live options chain with Greeks, IV, OI |
| Signals | `/signals` | Trade opportunities ranked by confidence |
| Auto-Trade | `/auto-trade` | Status, execution log, toggle, approval queue, kill switch |
| News | `/news` | Aggregated feed with sentiment tags |
| Trade Journal | `/journal` | Historical trades with filters and export |
| AI Advisor | `/advisor` | Chat interface, weekly insights, suggestions |
| Backtesting | `/backtest` | Run strategies against historical data |
| Settings | `/settings` | All configuration options |

## 5. Cost Structure

### Initial (₹0/month infrastructure)
- All services run locally
- PostgreSQL, Redis, Python — all free
- Angel One SmartAPI — free
- TradingView Lightweight Charts — open source
- News via RSS feeds — free
- **Note**: Angel One charges ₹20/executed F&O order as brokerage. Operational trading costs are separate from infrastructure costs.

### Cloud Migration (estimated)
- VPS: ₹500-800/mo (DigitalOcean/AWS Lightsail)
- Managed PostgreSQL: ₹500/mo
- Redis Cloud: Free tier or ₹300/mo
- Total infrastructure: ~₹1000-1600/mo

## 6. Design Principles

1. **Plugin Architecture** — every algorithm, data source, and broker is a pluggable adapter
2. **Configuration over Code** — behavior controlled via settings, not hardcoded
3. **Safety First** — hard risk limits that auto-trade cannot override, kill switch always accessible
4. **Paper Trading Default** — new strategies always start in paper mode
5. **Audit Everything** — every trade decision, every signal, every AI recommendation is logged with structured JSON logging
6. **Mobile-Ready** — responsive design, API-first so mobile app can be built later
7. **Agile Delivery** — stage-by-stage implementation, each stage is a usable increment
8. **Graceful Degradation** — if AI engine is down, signals still work (without ML scoring); if Redis is down, app falls back to REST polling; if DB is slow, live feed continues via in-memory buffer

## 7. Stage Plan (High Level)

| Stage | Focus | Outcome |
|-------|-------|---------|
| 1 | Project scaffold + Angel One integration + live data | See live prices flowing |
| 2 | Live charts + market overview + watchlist | Visual market monitoring |
| 3 | Signal generator + first algorithm | Trade recommendations appearing |
| 4 | Trade engine (order placement, position tracking) + paper trading | Simulated trade execution |
| 5 | Dashboard + trade journal | Performance tracking |
| 6 | Auto-trade engine (automated signal → order) + risk manager | Automated execution with safety |
| 7 | News aggregator + alerts | Information and notifications |
| 8 | AI advisor + self-learning | Intelligent trade coaching |
| 9 | Backtesting engine | Strategy validation |
| 10 | Options chain + advanced features | Full platform |

**Stage 4 vs Stage 6 clarification:**
- Stage 4 (Trade Engine) = the ability to place/modify/cancel orders, track positions, paper trade. This is the **plumbing**.
- Stage 6 (Auto-Trade) = the intelligence layer that automatically selects signals and triggers the trade engine. This is the **brain**.

## 8. Non-Functional Requirements

- **Market data latency**: Tick to UI < 500ms
- **Order execution latency**: Signal generated to order placed < 2 seconds (critical path)
- **Reliability**: MarketFeedService auto-reconnects within 5 seconds on disconnect; auto-trade worker recovers from crashes preserving open position state in Redis
- **Data Retention**: 1-minute candles retained for 1 year, then aggregated to 5-min; 5-min+ candles retained indefinitely; trade logs retained indefinitely
- **Storage management**: TimescaleDB compression enabled on candle data older than 7 days; estimated ~10GB/year for full watchlist candle data
- **Security**: Broker credentials encrypted at rest (AES-256), no credentials in logs
- **Extensibility**: New broker = new adapter, new algorithm = new strategy class
- **Observability**: Structured JSON logging via Winston/Pino; health check endpoints on all services (`/health`); log levels configurable via .env

## 9. Regulatory Acknowledgment

This platform is for **personal use** by an individual trader. SEBI's algorithmic trading regulations (circular SEBI/HO/MRD/DP/CIR/P/2016/127 and subsequent amendments) primarily apply to institutional algo trading through exchange-approved systems. Individual traders using personal automation tools are not currently required to register algos with SEBI, but this regulatory landscape may evolve. The system includes paper trading mode and manual approval gates to maintain human oversight over automated decisions.
