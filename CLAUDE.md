# CLAUDE.md - TD Automation Development Guide

> Trade smarter, not harder. Every algorithm is a bet — make it a calculated one.

---

## Quick Reference

| Resource | Location |
|----------|----------|
| **Project Structure** | See Section 5 below |
| **Design Spec** | `docs/superpowers/specs/2026-03-26-td-automation-platform-design.md` |
| **Architecture Guide** | `docs/architecture/SYSTEM_ARCHITECTURE.md` |
| **API Documentation** | `docs/api/` |
| **Stage Plan** | See Section 8 below |

> **IMPORTANT**: All application code lives in `apps/`, shared types in `packages/shared`, AI engine in `ai-engine/`.

---

## 1. Project Overview

TD Automation is an automated trading platform for the Indian market. It integrates with Angel One SmartAPI for live data and trade execution, uses AI/ML for signal generation and self-learning, and provides a comprehensive dashboard for monitoring and analysis.

### Primary Focus
- **Options Trading** (Nifty, BankNifty, FinNifty)
- **Swing Trading** (multi-day positions)
- **Supporting**: Equity intraday, Commodities (MCX)

### Design Principles
1. **Plugin Architecture** — algorithms, data sources, brokers are pluggable adapters
2. **Configuration over Code** — behavior via settings, not hardcoded
3. **Safety First** — hard risk limits, kill switch, paper trading default
4. **Audit Everything** — every decision logged
5. **Mobile-Ready** — responsive, API-first
6. **Agile Delivery** — stage-by-stage, each stage is usable

---

## 2. Core Constraints

| Constraint | Requirement |
|------------|-------------|
| Safety | Hard risk limits that auto-trade CANNOT override |
| Paper trading | New strategies MUST start in paper mode |
| Latency | Market data to UI < 500ms |
| Security | Broker credentials encrypted at rest, never logged |
| Cost | Local-first, ₹0 initial infrastructure cost |
| Extensibility | New broker = new adapter, new algo = new strategy class |

---

## 3. Tech Stack

| Layer | Technology | Port |
|-------|-----------|------|
| Frontend | React + Vite + TypeScript | 3000 |
| Backend | NestJS + TypeScript | 3001 |
| AI Engine | Python + FastAPI | 5000 |
| Database | PostgreSQL + TimescaleDB | 5432 |
| Cache/Queue | Redis + Bull | 6379 |
| Charts | TradingView Lightweight Charts | - |
| Broker | Angel One SmartAPI | - |

---

## 4. Architecture

### Monolith + Persistent Feed Service + Bull Queue Workers + Python AI Sidecar

```
Frontend (React) ←→ Backend (NestJS) ←→ AI Engine (Python)
                         ↕
                   MarketFeedService (persistent WebSocket, max 50 tokens)
                         ↕
                   Bull Queues (Redis)
                   ┌─────────────────────┐
                   │ signal-scan         │ → Algorithm execution
                   │ auto-trade          │ → Order execution
                   │ oi-tracker          │ → OI change detection
                   │ news-fetch          │ → News aggregation
                   │ daily-housekeeping  │ → Data cleanup & refresh
                   └─────────────────────┘
                         ↕
              PostgreSQL + TimescaleDB
```

**Note**: MarketFeedService is a persistent long-lived WebSocket connection, NOT a Bull queue worker. Angel One limits WebSocket to ~50 tokens simultaneously — we use subscription rotation for scanning.

### Module Pattern (NestJS)
Every module follows:
```
module-name/
├── controllers/    # REST endpoints
├── gateways/       # WebSocket events (where needed)
├── services/       # Business logic
├── repositories/   # Data access
├── dto/            # Validation schemas
├── strategies/     # Pluggable algorithm interfaces
└── workers/        # Bull queue processors (where needed)
```

### Strategy Pattern (Algorithms)
```typescript
interface TradingStrategy {
  name: string;
  analyze(data: MarketData): Signal | null;
  backtest(historicalData: MarketData[]): BacktestResult;
}
```
Add new algorithms by implementing this interface. No existing code changes needed.

### Broker Adapter Pattern
```typescript
interface BrokerAdapter {
  connect(): Promise<void>;
  placeOrder(order: OrderRequest): Promise<OrderResponse>;
  getPositions(): Promise<Position[]>;
  getLiveQuote(symbol: string): Promise<Quote>;
  subscribeToFeed(symbols: string[], callback: FeedCallback): void;
}
```
Switch brokers by implementing this interface.

---

## 5. Project Structure

```
td-automation/
├── apps/
│   ├── web/                          # Frontend (React + Vite)
│   │   ├── src/
│   │   │   ├── pages/                # Route pages
│   │   │   │   ├── dashboard/
│   │   │   │   ├── charts/
│   │   │   │   ├── market/
│   │   │   │   ├── options/
│   │   │   │   ├── signals/
│   │   │   │   ├── auto-trade/
│   │   │   │   ├── news/
│   │   │   │   ├── journal/
│   │   │   │   ├── advisor/
│   │   │   │   ├── backtest/
│   │   │   │   └── settings/
│   │   │   ├── components/           # Reusable UI components
│   │   │   │   ├── common/
│   │   │   │   ├── charts/
│   │   │   │   ├── trading/
│   │   │   │   ├── layout/
│   │   │   │   ├── news/
│   │   │   │   └── ai/
│   │   │   ├── hooks/                # Custom React hooks
│   │   │   ├── services/             # API client services
│   │   │   ├── stores/               # State management (Zustand)
│   │   │   ├── types/                # TypeScript types
│   │   │   ├── utils/                # Utility functions
│   │   │   └── assets/               # Static assets
│   │   └── public/
│   │
│   └── api/                          # Backend (NestJS)
│       ├── src/
│       │   ├── common/               # Shared utilities
│       │   │   ├── decorators/
│       │   │   ├── filters/
│       │   │   ├── guards/
│       │   │   ├── interceptors/
│       │   │   ├── interfaces/
│       │   │   └── utils/
│       │   ├── config/               # App configuration
│       │   └── modules/
│       │       ├── auth/             # Authentication
│       │       ├── market-data/      # Live prices, candles, OI
│       │       ├── trade-engine/     # Order execution
│       │       ├── signal-generator/ # Algorithm signals
│       │       ├── auto-trade/       # Automated execution
│       │       ├── portfolio/        # P&L, positions, journal
│       │       ├── news/             # News aggregation
│       │       ├── ai-advisor/       # AI bot interface
│       │       ├── settings/         # Configuration management
│       │       ├── alerts/           # Price/OI/news alerts
│       │       ├── backtest/         # Strategy backtesting
│       │       └── options-chain/    # Options chain + Greeks
│       └── test/
│
├── packages/
│   └── shared/                       # Shared types, constants
│       └── src/
│           ├── types/
│           ├── constants/
│           └── utils/
│
├── ai-engine/                        # Python AI/ML service
│   ├── src/
│   │   ├── models/                   # ML models
│   │   ├── services/                 # Business logic
│   │   ├── strategies/               # AI strategies
│   │   └── utils/                    # Utilities
│   └── tests/
│
├── prisma/                           # Database schema
│   └── migrations/
│
├── scripts/                          # Dev/deployment scripts
├── config/                           # Environment configs
├── docs/                             # Documentation
│   ├── guides/
│   ├── api/
│   ├── architecture/
│   └── superpowers/specs/
│
├── .claude/                          # Claude Code config
├── .github/                          # GitHub Actions
└── .husky/                           # Git hooks
```

---

## 6. Naming Conventions

| Type | Convention | Example |
|------|------------|---------|
| Files | kebab-case | `market-data.service.ts` |
| Classes | PascalCase | `MarketDataService` |
| Functions | camelCase | `getLiveQuote()` |
| Constants | SCREAMING_SNAKE | `MAX_DAILY_LOSS` |
| Interfaces | PascalCase | `TradingStrategy` |
| Enums | PascalCase + SCREAMING_SNAKE values | `OrderType.MARKET` |
| DB Tables | snake_case | `trade_signals` |
| API Routes | kebab-case | `/api/market-data/live-quotes` |

---

## 7. Git Workflow

### Branch Naming
```bash
feature/stage-1-angel-one-integration
feature/stage-2-live-charts
bugfix/websocket-reconnection
hotfix/kill-switch-fix
```

### Commit Messages (Conventional Commits)
```bash
feat(market-data): integrate Angel One WebSocket feed
fix(auto-trade): prevent duplicate order execution
docs(architecture): add data flow diagram
test(signal-generator): add RSI strategy unit tests
refactor(trade-engine): extract broker adapter interface
```

---

## 8. Stage Plan

| Stage | Focus | Key Deliverable |
|-------|-------|----------------|
| 1 | Scaffold + Angel One + Live Data | Live prices flowing |
| 2 | Charts + Market Overview | Visual market monitoring |
| 3 | Signal Generator + First Algorithm | Trade recommendations |
| 4 | Trade Engine + Paper Trading | Simulated execution |
| 5 | Dashboard + Trade Journal | Performance tracking |
| 6 | Auto-Trade + Risk Manager | Automated execution |
| 7 | News + Alerts | Information layer |
| 8 | AI Advisor + Self-Learning | Intelligent coaching |
| 9 | Backtesting Engine | Strategy validation |
| 10 | Options Chain + Advanced | Full platform |

---

## 9. Safety Rules (NON-NEGOTIABLE)

| Rule | Implementation |
|------|----------------|
| Kill switch | Always accessible, squares off ALL positions instantly |
| Max daily loss | Hard limit, auto-trade stops when reached |
| Max position size | Enforced at order placement |
| Paper trading default | New strategies start simulated |
| Credential security | Encrypted at rest, never in logs or git |
| Rate limiting | Respect Angel One API limits (max 10 req/sec) |
| Graceful recovery | Workers resume from last known state after crash |

---

## 10. Development Commands

```bash
# Install dependencies
npm install

# Start all services (development)
npm run dev

# Start individual services
npm run dev:web          # Frontend on :3000
npm run dev:api          # Backend on :3001
npm run dev:ai           # AI engine on :5000

# Database
npm run db:migrate       # Run migrations
npm run db:seed          # Seed data
npm run db:studio        # Open Prisma Studio

# Testing
npm test                 # Run all tests
npm run test:cov         # With coverage
npm run test:e2e         # End-to-end

# Build
npm run build            # Build all apps
```

---

*Version 1.0 | March 26, 2026 | Initial architecture*
