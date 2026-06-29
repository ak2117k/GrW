# Watch Monitor & Lifecycle Tracking — Design Spec

**Date:** 2026-05-13
**Status:** Draft
**Author:** Aryan Kumar
**Stage:** Chartink Stage 2 (continues from `2026-05-12-chartink-scoring-and-lot-sizing-design.md`)

---

## 1. Problem Statement

Stage 1 of the Chartink pipeline gates incoming hits through a **sector-alignment hard gate** then runs a **9-check scoring engine** producing a score (0–100) and lot count. Today this is a one-shot evaluation — once the score is computed, the alert just sits on the `/chartink` page. There is no continuous monitoring, no trade lifecycle, and no record of how a setup evolved between when it was scored and when it was acted on (or expired).

We need to:

1. **Continuously watch** every stock that passes the scoring gate, tracking price and score evolution in real time.
2. **Persist a forensic audit trail** of every price-tick and score-change event so that the post-trade journal can answer "did the thesis actually hold up?"
3. **Pick the best F&O contract** (CE/PE options strike) for stocks that have options, weighted by gamma, theta, and volume.
4. **Trigger a score-decay stop-loss** when the live score drops below 60 — independently of the price-based stop. This is the unique value-add: exit when probability collapses, not just when price moves against us.
5. **Compute a profit target** from level book (closest S/R) with a 10% fallback when no level fits.
6. **Provide a UI** showing all WATCHING / TRADED / EXITED entries with a manual "Execute" button that places the order via the existing TradeEngine.

---

## 2. Scope

### In scope

- Two new Prisma models: `WatchEntry`, `WatchEvent`.
- New NestJS module: `watch-monitor` with controller, services, repository, gateway, and Bull worker.
- WebSocket subscription rotation through `MarketFeedService` for live ticks.
- Hybrid trigger model: WebSocket for price, 60-second Bull repeating job for rescore.
- Strike selection from existing `options-chain` module.
- Profit-target computation from existing `LevelBook` (PDH/PDL/ORH/ORL/VWAP).
- Score-decay SL enforcement (`currentScore < 60` → STOPPED).
- New `/watch` page on web app — list + detail + Execute button.
- Integration with existing `ChartinkProcessService` (call `watchSvc.create()` post-scoring).
- Manual trade execution through existing `TradeEngine` (paper / live) — NOT auto-execution.

### Out of scope

- Auto-trade execution (per `project_manual_mode_pivot` memory — automation frozen).
- Mobile-app push notifications (will reuse existing alerts module if added later).
- Backtesting the watch lifecycle (separate Stage 3 / backtest spec).
- Sentiment-feed integration (news-driven score adjustments).
- Multi-broker support — Angel One only.
- Hedge-leg automation (BOTH-side options) — see § 13 open question.

---

## 3. Background — Stage 1 Pipeline Recap

Stage 1 (already shipped, see `2026-05-12-chartink-scoring-and-lot-sizing-design.md`) produces, for every Chartink webhook hit:

```
Webhook → Auth → Persist alert → Worker dequeue → Resolve symbol →
  MTF gate (4-TF directional check) →
  Sector gate (sector trend direction via classifyTrend) →
    misaligned → persist 'sector-misaligned', stop
    aligned    → side := (sectorTrend === UP ? 'BUY' : 'SELL') →
  Scoring service (9 checks summing to 100) →
    score < 50 → persist 'scored-low'
    score ≥ 50 → persist 'setup' with score + lotCount + breakdown
```

Stage 2 picks up at the **`score ≥ 50` branch** and adds continuous monitoring.

---

## 4. Architecture

### High-level

```
ChartinkProcessService (existing)
   │
   │ after scoring success
   ↓
WatchService.create(alertId, symbol, side, score, breakdown, ...)
   │
   ├─ creates WatchEntry (status=WATCHING)
   ├─ writes INITIAL WatchEvent
   ├─ TargetCalculatorService → profitTarget + source
   ├─ StrikeSelectorService (if F&O) → optionsToken + expiry + strike
   └─ MarketFeedService.subscribe([underlyingToken, optionsToken])

WatchMonitorService (Bull repeating job, 60s)
   │
   for each WATCHING/TRADED entry:
     │
     ├─ recompute score via ChartinkScoringService.score(...)
     ├─ compare to prior score → write SCORE_CHANGE if delta ≠ 0
     ├─ if currentScore < stopLossScore → SL_HIT → status=STOPPED
     └─ if priceHit profitTarget → TARGET_HIT → status=EXITED

MarketFeedService (existing — extended)
   │
   on tick for subscribed token:
     │
     └─ WatchService.onTick(token, ltp)
         │
         ├─ update currentPrice, maxFavorable, maxAdverse on entry
         ├─ if |Δprice from last logged event| ≥ 0.25% → write PRICE_CHANGE
         ├─ if priceHit profitTarget → TARGET_HIT → status=EXITED
         └─ WatchGateway.push(entryId, latest)

WatchController (REST)
   │
   GET /api/watch                    → list (filter by status)
   GET /api/watch/:id                → detail with events
   POST /api/watch/:id/execute       → place trade via TradeEngine
   POST /api/watch/:id/dismiss       → user-removes entry
   POST /api/watch/:id/close         → manual close of TRADED entry
```

### Module structure

```
apps/api/src/modules/watch-monitor/
├── controllers/
│   └── watch.controller.ts            # REST endpoints
├── services/
│   ├── watch.service.ts               # state machine + CRUD facade
│   ├── watch-monitor.service.ts       # Bull cron — 60s rescore tick
│   ├── strike-selector.service.ts     # CE/PE picker
│   └── target-calculator.service.ts   # S/R-based PT computation
├── repositories/
│   └── watch.repository.ts            # Prisma data access
├── workers/
│   └── watch-rescore.worker.ts        # Bull processor for 'watch-rescore' queue
├── gateways/
│   └── watch.gateway.ts               # WebSocket push to UI
├── dto/
│   ├── create-watch.dto.ts
│   ├── execute-watch.dto.ts
│   └── watch-event.dto.ts
└── watch-monitor.module.ts
```

### Integration points

| Existing module | Role |
|---|---|
| `chartink/services/chartink-process.service.ts` | Calls `watchSvc.create()` after `score ≥ 50` branch |
| `market-data/services/market-feed.service.ts` | Adds `subscribeForWatch(token, callback)` API |
| `options-chain/services/options-chain.service.ts` | Provides chain data with Greeks for strike selector |
| `signal-generator/services/level-book.service.ts` | Provides PDH/PDL/ORH/ORL/VWAP for target calculator |
| `chartink/services/chartink-scoring.service.ts` | Reused as-is for rescore |
| `trade-engine/services/trade-execution.service.ts` | Invoked on POST /watch/:id/execute |

---

## 5. Data Model

### Prisma schema additions

```prisma
model WatchEntry {
  id                  String   @id @default(cuid())

  // Provenance
  alertId             String?
  alert               ChartinkAlert? @relation(fields: [alertId], references: [id])
  setupId             String?  @unique
  setup               ChartinkAlertSetup? @relation(fields: [setupId], references: [id])

  // Identity
  symbol              String
  token               String
  exchange            String
  side                String   // 'BUY' | 'SELL'

  // Initial snapshot (frozen at create)
  initialPrice        Float
  initialScore        Int
  initialBreakdown    Json     // full check-by-check breakdown
  initialAt           DateTime @default(now())

  // Lifecycle targets
  profitTarget        Float
  profitTargetSource  String   // 'indicator-sr' | 'fallback-10pct'
  stopLossScore       Int      @default(60)

  // Status
  status              WatchStatus @default(WATCHING)

  // Live state (mutated by monitor loop)
  currentPrice        Float?
  currentScore        Int?
  maxFavorable        Float?
  maxAdverse          Float?
  lastTickAt          DateTime?
  lastRescoreAt       DateTime?

  // F&O selection (nullable — only set if stock is options-eligible)
  optionsToken        String?
  optionsType         String?  // 'CE' | 'PE'
  optionsExpiry       DateTime?
  optionsStrike       Float?
  optionsLotSize      Int?
  optionsSelectionScore Float? // gamma * volume / theta — for audit

  // Trade reference (nullable — only set after Execute)
  paperTradeId        String?
  liveTradeId         String?
  executedAt          DateTime?
  executedPrice       Float?
  closedAt            DateTime?
  closedReason        String?  // 'target-hit' | 'sl-score-decay' | 'sl-price' | 'manual' | 'eod'

  // Audit
  createdAt           DateTime @default(now())
  updatedAt           DateTime @updatedAt
  dismissedAt         DateTime?

  events              WatchEvent[]

  @@index([status])
  @@index([token])
  @@index([symbol])
  @@index([createdAt])
}

model WatchEvent {
  id            String     @id @default(cuid())
  watchEntryId  String
  watchEntry    WatchEntry @relation(fields: [watchEntryId], references: [id], onDelete: Cascade)

  eventType     WatchEventType

  // Snapshots (nullable depending on event type)
  price         Float?
  score         Int?
  breakdown     Json?
  priceDelta    Float?     // % from last logged event
  scoreDelta    Int?       // from previous score
  notes         String?

  createdAt     DateTime   @default(now())

  @@index([watchEntryId, createdAt])
  @@index([eventType])
}

enum WatchStatus {
  WATCHING
  TRADED
  TARGET_HIT
  STOPPED
  EXITED
  DISMISSED
}

enum WatchEventType {
  INITIAL         // first row, frozen entry snapshot
  PRICE_CHANGE    // material price tick (|Δ| ≥ 0.25%)
  SCORE_CHANGE    // 60s rescore yielded different score
  TARGET_HIT      // price crossed profitTarget
  SL_HIT_SCORE    // currentScore dropped below stopLossScore
  SL_HIT_PRICE    // price-based stop (reserved — not implemented in Stage 2)
  TRADE_OPENED    // manual Execute placed a trade
  TRADE_CLOSED    // trade close confirmed by broker
  DISMISSED       // user manually removed from watch
}
```

### Migration name

`add_watch_monitor_lifecycle`

### TimescaleDB

`WatchEvent` is **NOT** converted to a hypertable in Stage 2 — estimated ~20k rows/day across 50 entries is manageable on plain PostgreSQL. We will revisit if event volume crosses 100k/day or query latency on the audit view exceeds 500ms.

---

## 6. State Machine

```
                ┌──────────────────────────────────────────────┐
                │                                              │
                ↓                                              │
[from Stage 1]                                                 │
score ≥ 50 → WATCHING ──────────────────┐                      │
                │                       │                      │
                │ user clicks Execute   │ score < 60           │
                ↓                       ↓                      │
              TRADED                 STOPPED                   │
                │                       │                      │
                ├─ price hit PT ────────┼──→ TARGET_HIT        │
                │                       │                      │
                ├─ score < 60 ──────────┼──→ STOPPED           │
                │                       │                      │
                ├─ user closes manually ┼──→ EXITED            │
                │                       │                      │
                └─ EOD square-off ──────┴──→ EXITED            │
                                                               │
WATCHING / TRADED ── user dismisses ──────→ DISMISSED ─────────┘
```

### Transition rules

| From | To | Trigger | Side effects |
|---|---|---|---|
| (none) | WATCHING | Stage 1 scoring ≥ 50 | Create entry, write INITIAL, subscribe WS, pick strike, compute PT |
| WATCHING | TRADED | POST /watch/:id/execute | Place order, write TRADE_OPENED, store paper/liveTradeId |
| WATCHING | STOPPED | currentScore < 60 | Write SL_HIT_SCORE, unsubscribe WS |
| WATCHING | TARGET_HIT | currentPrice crosses profitTarget | Write TARGET_HIT, unsubscribe WS |
| WATCHING | DISMISSED | POST /watch/:id/dismiss | Write DISMISSED, unsubscribe WS |
| TRADED | STOPPED | currentScore < 60 | Write SL_HIT_SCORE, close trade via TradeEngine, write TRADE_CLOSED |
| TRADED | TARGET_HIT | price hit profitTarget | Write TARGET_HIT, close trade, write TRADE_CLOSED |
| TRADED | EXITED | manual close or EOD | Close trade, write TRADE_CLOSED |
| Any | (terminal) | — | Terminal states do not transition further |

### Idempotency

- Same `(alertId, token)` already has a non-terminal WatchEntry → **return existing** instead of creating a new one. Stage 1's worker may retry on transient failures; we must not duplicate.
- WebSocket reconnect re-emits ticks for already-processed timestamps → tick handler keys on `lastTickAt`; drops stale ticks.

---

## 7. Component Behaviors

### 7.1 WatchService.create(input)

**Input:**
```typescript
{
  alertId: string;
  setupId: string;
  symbol: string;
  token: string;
  exchange: string;
  side: 'BUY' | 'SELL';
  initialPrice: number;
  initialScore: number;
  initialBreakdown: Json;
}
```

**Algorithm:**
1. Dedup check: `repo.findActiveBySetupId(setupId)` where "active" means `status IN (WATCHING, TRADED)` → if exists, return it. (One `ChartinkAlertSetup` row per stock-hit guarantees this is the right uniqueness key.)
2. Enforce 50-entry cap: `repo.countActive()` → if ≥ 50, throw `WatchCapExceededError`. (Stage 1 will catch this and persist alert with `kind='watch-cap-exceeded'`.)
3. Compute profit target via `TargetCalculatorService.compute(side, initialPrice, levelBookSnapshot)`.
4. If `exchange === 'NSE'` and symbol is in F&O eligible list, call `StrikeSelectorService.pick(symbol, side, initialPrice)` → returns nullable options descriptor.
5. Create `WatchEntry` with all fields populated; status = WATCHING.
6. Create `WatchEvent` with `eventType=INITIAL, price=initialPrice, score=initialScore, breakdown=initialBreakdown`.
7. Subscribe `[token, optionsToken?].filter(Boolean)` to MarketFeedService via `subscribeForWatch`.
8. Push WS event `watch:created` via `WatchGateway`.
9. Return the entry.

### 7.2 WatchMonitorService — 60s rescore tick

**Trigger:** Bull repeating job `watch-rescore` running every 60s. Skipped outside market hours (09:15–15:30 IST, Mon–Fri).

**Per active entry (`status IN (WATCHING, TRADED)`):**

1. Call `ChartinkScoringService.score({token, symbol, exchange, side, entryPrice: currentPrice ?? initialPrice})`.
2. Compare `result.score` to `entry.currentScore`:
   - First rescore: write `SCORE_CHANGE` with full breakdown; set `currentScore`.
   - Δ ≠ 0: write `SCORE_CHANGE` with breakdown and `scoreDelta`; update `currentScore`.
   - Δ = 0: no-op.
3. If `result.score < entry.stopLossScore` → emit `SL_HIT_SCORE`, transition.
4. Update `lastRescoreAt = now`.

**Rate-limit handling:**

- Score computation makes 3–4 Angel One historical calls (sector, index, stock 15m). At 50 entries × 60s, that's ~3.5 calls/sec — at the Angel One historical limit of 3 req/sec.
- Mitigation: sector and index candles are **shared across all entries** in the same sector — fetch each sector once per minute, distribute. Implemented via a request-coalescing cache in `ChartinkScoringService` (5-second TTL is enough since we rescore on minute boundary).
- If Angel One returns rate-limit error → write `notes='rescore-throttled'` on the entry, skip the cycle; next minute retries.

### 7.3 MarketFeedService — onTick handler

**Existing signature:**
```typescript
subscribeToFeed(symbols: string[], callback: FeedCallback): void
```

**Added:**
```typescript
subscribeForWatch(token: string, watchEntryId: string): void
unsubscribeForWatch(token: string, watchEntryId: string): void
```

**On tick (token, ltp, timestamp):**
1. Lookup all WatchEntries subscribed to this token (`Map<token, Set<entryId>>`).
2. For each entry:
   - If `timestamp < entry.lastTickAt` → drop (stale).
   - Update `currentPrice = ltp`, `lastTickAt = timestamp`.
   - Update `maxFavorable / maxAdverse` (BUY: max ↑, min ↓; SELL: mirrored).
   - Check material-change: `|ltp - lastEvent.price| / lastEvent.price ≥ 0.0025` → write PRICE_CHANGE.
   - Check target-hit:
     - BUY: `ltp ≥ profitTarget` → TARGET_HIT.
     - SELL: `ltp ≤ profitTarget` → TARGET_HIT.
3. Push WS event `watch:tick` with minimal payload `(entryId, price, currentScore)`.

### 7.4 StrikeSelectorService.pick(symbol, side, underlyingPrice)

**Returns:** `{ token, type, strike, expiry, lotSize, selectionScore } | null`

**Algorithm:**
1. Check F&O eligibility: query `Instrument` table for `(symbol, instrumentType='OPTSTK')` rows; if none → return null.
2. Pick expiry: current-month if today < 7 days before expiry, else next-month (avoid last-week theta blow-up).
3. Fetch chain via `OptionsChainService.getChain(symbol, expiry)`.
4. Filter to leg side: `side='BUY' → CE`, `side='SELL' → PE`.
5. Filter to strikes within **±5 strikes of ATM** (i.e., 11 candidates total: ATM, ATM±1, ATM±2, ..., ATM±5 strike-steps), where ATM = nearest strike to `underlyingPrice`.
6. For each candidate, compute `selectionScore = gamma * volume / max(theta, 0.001)`.
7. Reject strikes with `volume < 1000` (illiquid).
8. Return highest `selectionScore` strike.
9. If no strike passes filters → return null (entry watches underlying only).

### 7.5 TargetCalculatorService.compute(side, entryPrice, levelBookSnapshot)

**Returns:** `{ target: number, source: 'indicator-sr' | 'fallback-10pct' }`

**Algorithm:**

For `side='BUY'`:
- Candidates: `[PDH, ORH, VWAP + 1*stddev]` where each is > entryPrice and within `[entryPrice * 1.02, entryPrice * 1.10]`.
- If candidates non-empty → `target = min(candidates), source = 'indicator-sr'`.
- Else → `target = entryPrice * 1.10, source = 'fallback-10pct'`.

For `side='SELL'`:
- Mirror with `[PDL, ORL, VWAP - 1*stddev]` and `[entryPrice * 0.90, entryPrice * 0.98]`.
- `target = max(candidates)` if non-empty; else `entryPrice * 0.90`.

**Edge case:** `levelBookSnapshot` may be null (e.g., stock has never had a level book entry). In that case → directly use fallback.

### 7.6 WatchController endpoints

| Verb | Path | Body | Action |
|---|---|---|---|
| GET | `/api/watch` | `?status=&limit=` | List entries (default: limit=50, status=any active) |
| GET | `/api/watch/:id` | — | Detail with all events |
| POST | `/api/watch/:id/execute` | `{ mode: 'paper'\|'live', quantity?: number }` | Place order via TradeEngine, transition to TRADED |
| POST | `/api/watch/:id/dismiss` | — | Mark DISMISSED, unsubscribe |
| POST | `/api/watch/:id/close` | `{ reason: string }` | Manual close of TRADED entry |

`POST /execute` quantity defaults to `lotCount × lotSize` (from initialBreakdown).

---

## 8. UI Surface

### New top-level route: `/watch`

**Layout:**

```
┌────────────────────────────────────────────────────────────────────────┐
│ Watch Monitor                                            [40 / 50 used]│
├────────────────────────────────────────────────────────────────────────┤
│ Filters: [All] [Watching] [Traded] [Stopped] [Target Hit]              │
├────┬─────────┬──────┬────────┬───────┬──────┬─────────┬──────┬────────┤
│ #  │ Symbol  │ Side │ Score  │ Price │ Δ%   │ Target  │ SL   │ Action │
├────┼─────────┼──────┼────────┼───────┼──────┼─────────┼──────┼────────┤
│ 1  │ TCS     │ BUY  │ 72→78▲ │ 4012  │+0.8% │ 4150    │ <60  │ [Exec] │
│ 2  │ INFY    │ BUY  │ 68→65▼ │ 1502  │-0.3% │ 1545    │ <60  │ [Exec] │
│ 3  │ RELIANC │ SELL │ 55→52▼ │ 2890  │+0.2% │ 2780    │ <60  │ [Exec] │
└────┴─────────┴──────┴────────┴───────┴──────┴─────────┴──────┴────────┘
```

**Detail panel (clicking a row):**

```
┌─ TCS-EQ ─ BUY ─ #1 ────────────────────────────────────────────────┐
│ Initial: ₹3978 @ 10:32:14   Score: 72                              │
│ Current: ₹4012 (+0.85%)     Score: 78  ▲ +6                        │
│ Target:  ₹4150 (PDH)        SL:   <60                              │
│ Max Fav: ₹4018              Max Adv: ₹3970                         │
│                                                                    │
│ Options leg: TCS25MAY4000CE @ ₹85.40 (γ=0.054 θ=-2.1 vol=12k)       │
│                                                                    │
│ ┌─ Event log ───────────────────────────────────────────────────┐  │
│ │ 10:42:01 SCORE_CHANGE  72→78  +6   (sector+RS+MACD strengthen)│  │
│ │ 10:41:32 PRICE_CHANGE  3990→4012   +0.55%                     │  │
│ │ 10:38:14 PRICE_CHANGE  3978→3990   +0.30%                     │  │
│ │ 10:32:14 INITIAL       3978       score=72                    │  │
│ └───────────────────────────────────────────────────────────────┘  │
│                                                                    │
│ [Execute Paper Trade]  [Execute Live Trade]  [Dismiss]             │
└────────────────────────────────────────────────────────────────────┘
```

### Frontend files

```
apps/web/src/pages/watch/
├── WatchPage.tsx                # main route component
├── WatchTable.tsx               # filterable list
├── WatchDetailPanel.tsx         # detail view
└── WatchEventLog.tsx            # event audit trail
apps/web/src/hooks/
└── useWatchEntries.ts           # react-query + WS subscription
apps/web/src/services/
└── watch.service.ts             # REST client
```

Navigation: add "Watch" link to main nav between "Signals" and "Auto-Trade".

---

## 9. Reused Existing Components

| Reused | What we depend on |
|---|---|
| `ChartinkScoringService.score()` | Stage 1 — full 9-check rescore on cadence |
| `LevelBookService.getSnapshot(token)` | PDH/PDL/ORH/ORL/VWAP for target calc |
| `OptionsChainService.getChain(symbol, expiry)` | strike data with Greeks |
| `MarketFeedService` (extended) | live WebSocket ticks |
| `TradeExecutionService.placeOrder()` | manual order placement on Execute |
| `AngelOneAdapterService.getCandleData()` | 15m candles for rescore (shared cache) |
| `ChartinkAlertSetup` (existing model) | one-to-one via `setupId` linking watch → originating setup |
| Bull queue infrastructure | repeating job for rescore |

---

## 10. Performance & Capacity

### Numbers

- **Watch cap:** 50 entries (matches Angel One WebSocket token limit).
- **Tick volume:** ~3,000 ticks/min during high activity across 50 tokens (50 × ~60 ticks/min for liquid stocks).
- **Material-change events:** estimated 5–15 per stock per day × 50 = 250–750 PRICE_CHANGE events/day.
- **Score events:** rescored every 60s × 6.5h × 50 = ~19,500 SCORE_CHANGE checks/day, of which only those with non-zero delta are persisted (estimated 10–20% = ~2,000–4,000 events/day).
- **Total events/day:** ~3,000–5,000 across all WatchEntries.

### Throughput budget

- Angel One historical: 3 req/sec hard limit. Per-rescore needs 3–4 fetches. With request coalescing (sector/index shared per minute), ~50 entries × ~2 fetches/entry / 60s = ~1.7 req/sec average — fits.
- Score recomputation latency: ~150–300ms per entry sequentially → 50 entries = 7–15s. We pace rescores across the 60s window using `setInterval(rescore, 60000 / 50)` to avoid bursts.

### Database load

- WatchEvent INSERT rate: peak ~10 events/sec. Standard PostgreSQL handles this trivially.
- Audit-view query (per-entry event log): indexed by `(watchEntryId, createdAt DESC LIMIT 100)` — should be <50ms even at 100k total rows.

---

## 11. Error Handling

| Failure mode | Behavior |
|---|---|
| Rescore Angel One rate-limit | Skip cycle, log warning, retry next minute. Entry's `notes` field surfaces last failure in UI. |
| Rescore throws unexpectedly | Catch, log, mark entry's lastRescoreAt to "stuck since X" — don't crash the cron. |
| MarketFeed WS disconnect | MarketFeedService auto-reconnects (existing behavior). On reconnect, resubscribe all WatchEntry tokens. |
| Strike selector returns null | Entry watches underlying only (`optionsToken=null`). UI shows "no F&O leg". |
| Target calculator gets null level book | Use fallback-10pct, log notes="no-level-book". |
| TradeEngine rejects order on Execute | WatchEntry stays in WATCHING, error surfaced to UI. No state transition. |
| Score drops below 60 while trade is open (TRADED) | Auto-close trade via TradeEngine, write TRADE_CLOSED with `closedReason='sl-score-decay'`. If close fails → entry stays TRADED, write event `notes='auto-close-failed'`, alert user. |

---

## 12. Testing Strategy

### Unit tests

| File | Coverage |
|---|---|
| `target-calculator.service.spec.ts` | BUY/SELL paths, in-range S/R, fallback, null levelBook |
| `strike-selector.service.spec.ts` | F&O eligible/not, ATM range, illiquid rejection, score ranking |
| `watch.service.spec.ts` | Dedup, cap enforcement, all state transitions, idempotent dismiss |
| `watch-monitor.service.spec.ts` | Score delta detection, SL_HIT_SCORE trigger, rate-limit handling |

### Integration tests

| Scenario | Setup |
|---|---|
| Full WATCHING → TRADED → TARGET_HIT | Mock Angel One ticks, verify event log correctness |
| Full WATCHING → STOPPED via score-decay | Mock score returning <60, verify auto-close behavior |
| 50-entry cap reached | Insert 50 entries, attempt 51st → expect rejection |
| WS reconnect re-subscribes | Disconnect feed, reconnect, verify token list restored |

### Manual UAT

- Place a Chartink hit through to scoring ≥50 → verify entry appears on /watch.
- Watch live ticks update the UI within 1s.
- Wait 60s, observe a score recompute event (if any change).
- Click Execute on a paper trade, verify TRADED state and trade visible in /paper.
- Manually drop a stock's score in DB (`UPDATE WatchEntry SET currentScore = 55`) — trigger rescore → expect transition to STOPPED (only if real score is also < 60).

---

## 13. Open Questions for Plan Stage

| # | Question | Default if unresolved |
|---|---|---|
| 1 | Indices (NIFTY/BANKNIFTY) — no sector to gate by. Apply special-case: gate by NIFTY vs its 200-EMA market-regime? | Defer — Stage 1 will continue to skip indices. Re-add support in Stage 3. |
| 2 | Material price change threshold — should it be tunable per stock based on ATR%? | Fixed 0.25% for v1; introduce `priceMaterialityPct` column in v2. |
| 3 | EOD square-off — at 15:25 IST, force-exit all TRADED entries? | Not in Stage 2. User closes manually or trade carries overnight (paper). Live-mode square-off is Stage 3. |
| 4 | Dismiss vs Stop — if user dismisses a WATCHING entry, are events preserved? | YES — DISMISSED is a state, not a delete. Audit trail intact. |
| 5 | Hedge leg (BOTH-side options) — buy CE and PE for a BUY-side stock for IV-crush protection? | Out of scope for Stage 2 — single leg only. |
| 6 | Re-entry after STOPPED — if Chartink fires the same stock again 2 hours after a stop, create a new WatchEntry? | YES — terminal states don't block new entries. Cooldown can be added later if churn becomes a problem. |
| 7 | Display SL_HIT_SCORE events on /chartink alert page too? | Wire it as a link on the /chartink alert detail to the /watch entry. |

---

## 14. Acceptance Criteria

- [ ] Prisma migration `add_watch_monitor_lifecycle` applies cleanly.
- [ ] Stage 1 → Stage 2 wire: any Chartink scoring ≥ 50 creates a WatchEntry.
- [ ] WatchEntry cap at 50 enforced; 51st returns explicit error.
- [ ] WebSocket ticks update `currentPrice` and `maxFavorable / maxAdverse` within 1 second.
- [ ] PRICE_CHANGE events written only when |Δ| ≥ 0.25% from last event.
- [ ] 60s rescore loop runs during market hours (verified by timestamp on `lastRescoreAt`).
- [ ] SCORE_CHANGE events written only when score delta ≠ 0; breakdown included.
- [ ] SL_HIT_SCORE fires when `currentScore < 60` within one rescore cycle.
- [ ] TARGET_HIT fires when price crosses `profitTarget` within one tick cycle.
- [ ] StrikeSelector picks a valid ATM±5 strike for known F&O symbols (verified for TCS, RELIANCE, INFY).
- [ ] TargetCalculator returns indicator-sr source when levels are within 2–10%, fallback otherwise.
- [ ] Manual Execute places a paper trade and transitions to TRADED.
- [ ] Manual Execute on TRADED entry rejected.
- [ ] Auto-close on TRADED + score-decay calls TradeEngine.closeTrade and writes TRADE_CLOSED.
- [ ] /watch page renders all entries with live updates.
- [ ] WatchEvent log shows chronological order for any entry.
- [ ] All unit and integration tests pass.

---

## 15. Future Work (post-Stage 2)

- **Stage 3:** Backtest the watch lifecycle. For each historical Chartink hit, simulate the WATCHING window, count SL-by-score vs SL-by-price triggers, measure trade efficiency (`exit / maxFavorable`).
- **Trailing stop:** Move SL upward (BUY) when score sustains > 75 for >10 minutes.
- **Multi-leg options:** Buy hedge PE on BUY-side high-IV stocks; auto-close hedge with main leg.
- **Alerts:** SMS/push when an entry transitions to STOPPED or TARGET_HIT.
- **Per-stock priceMaterialityPct:** ATR-derived per-stock threshold instead of global 0.25%.
- **EOD square-off cron:** 15:25 IST force-close on live-mode TRADED entries.

---

*End of spec.*
