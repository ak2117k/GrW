# Ungated Shadow-Track A/B Experiment — Design

**Date:** 2026-05-20
**Status:** Approved — ready for implementation plan
**Author:** brainstormed via session

---

## 1. Problem & Goal

The platform currently filters incoming Chartink alerts through a strategy gate before opening a paper trade. The gate combines:

- **Score admission** (`evaluateTradePolicy`) — `score ≥ 60` outside 11:45–14:00 IST, `score ≥ 75` inside
- **MTF alignment** check inside `ChartinkScoringService`
- **No-direction filter** (alerts that can't infer BUY/SELL get rejected)

We do not currently have evidence that this gate adds net P&L. The hypothesis is "the gate filters out losing trades faster than it filters out winners." We need a parallel **ungated shadow track** that takes *every* scored alert and trades it under the same exit rules, so we can compare daily realised P&L between the two tracks.

**Success criterion:** after running both tracks for ≥ 2 weeks of trading days, we can answer "does the gate net-add value?" with a single number per day (`gated.net − ungated.net`).

---

## 2. Scope — What the Ungated Track Does and Doesn't Do

### Bypassed (the "strategy" gates)

- Score admission threshold (`≥ 60` / `≥ 75`)
- MTF alignment check
- No-direction filter

The score is still **computed and recorded** on every ungated entry's row (`initialScore`, `initialBreakdown`) — it is not gated on. This is the analytical pivot: after the experiment runs, you can slice ungated P&L by score band to see whether the score had any predictive power even when it wasn't enforcing admission.

### Retained (every operational rule)

- Entry-window cutoff (09:15–15:00 IST) — no new trade after 15:00
- Market-closed check
- Symbol dedup — no second open trade for the same symbol
- Cooldown after exit (R2 — separate cooldown map for the ungated track)
- Daily-loss circuit breaker (separate breaker on `ungated_paper_account`)
- Kill switch (separate flag on `ungated_paper_account`)
- Position cap (separate cap = **40 concurrent**, vs gated's 20)
- 40-slot capital pool (₹80,00,000 total / ₹2,00,000 per trade)

### Capital & sizing

- **Starting balance**: ₹80,00,000 (set at first boot, never changes after that).
- **Per-trade sizing**: flat ₹2,00,000 nominal. Quantity = `Math.max(1, Math.floor(2_00_000 / referencePrice))` — the `Math.max(1, ...)` floor guards the rare alert priced above ₹2,00,000 so the trade still opens with 1 share rather than being silently dropped (mirrors gated `WatchService.executeEntry`). Reference price is the live REST quote at admission time (same source the gated track's `executeEntry` uses).
- **Hard concurrent cap**: 40 open trades. New alerts when 40 are open are rejected with reason `position-cap`. The `capital-exhausted` rejection is a distinct case (cash < ₹2,00,000 even though slot count is below 40 — happens after losses eat into the pool).
- **Symbol dedup key**: same as gated — by `token`. `UngatedWatchRepository.findActiveByToken(token)` rejects when ANY non-terminal (`WATCHING` / `TRADED`) ungated entry already holds that token. Symbol-string is incidental; token is the broker-canonical identity.
- No score-tiered sizing, no `pendingProfit` deferred settlement, no `MAX_INVESTMENT_PER_TRADE` legacy fallback.

### Exits (identical to gated)

- Partial exit at +1.0% favorable (sells half).
- Trailing stop at 0.5% below high-water (post partial).
- Hard loss-cut at −0.4% of deployed capital (R5).
- Target hit at the persisted `profitTarget` (2% fallback if no `indicator-sr` value available).
- All exits forward the trigger price as `opts.exitPrice` to `closeTrade` so the Trade row records the actual trigger, not the cached LTP (the fix landed in commits `9fb5bcd` and `75a8559` — the ungated track's `UngatedTradeExecutionService.closeTrade` copy embeds the same correctness from day one).

---

## 3. Architecture Overview

```
                          ┌─ Chartink Webhook (existing) ─┐
                          │  /webhooks/chartink/:secret   │
                          └───────────────┬───────────────┘
                                          │
                          ┌───────────────▼───────────────┐
                          │   ChartinkIngestService       │  (existing — no change)
                          └───────────────┬───────────────┘
                                          │ BullMQ
                          ┌───────────────▼───────────────┐
                          │ ChartinkProcessService        │  (existing — minimal patch)
                          │  • parses scanner config      │
                          │  • dedup, entry-window,       │
                          │    market-closed checks       │
                          │  • runs ChartinkScoringService│
                          │      → { score, breakdown }   │  ← shared scoring output
                          └──────┬──────────────────┬─────┘
                                 │                  │
                          GATED path           UNGATED path     ← NEW fork
                  ┌──────────────▼──┐    ┌──────────▼──────────────┐
                  │ admission gate  │    │ admission gate SKIPPED  │
                  │ score ≥ 60 etc. │    │ trade every alert       │
                  └────────┬────────┘    └──────────┬──────────────┘
                           │                        │
                  ┌────────▼─────────┐    ┌─────────▼──────────────┐
                  │ WatchService     │    │ UngatedWatchService    │  ← NEW
                  │ (existing)       │    │ (full mirror)          │
                  └────────┬─────────┘    └─────────┬──────────────┘
                           │                        │
                  ┌────────▼────────┐    ┌──────────▼────────────┐
                  │ WatchRepository │    │ UngatedWatchRepository│  ← NEW
                  │ → watch_entries │    │ → ungated_watch_entries│
                  └────────┬────────┘    └──────────┬────────────┘
                           │                        │
                  ┌────────▼─────────┐    ┌─────────▼──────────────┐
                  │ TradeExecution + │    │ UngatedTradeExecution  │  ← NEW
                  │ PaperTrade       │    │ + UngatedPaperBalance  │
                  │ → trades         │    │ → ungated_trades       │
                  │ balance: ~₹20L   │    │ balance: ₹80L (₹2L/trade)
                  └──────────────────┘    └────────────────────────┘
```

Key invariant: the two tracks share **scoring output** (one `ChartinkScoringService.score()` call per alert) but diverge at the admission decision. Scoring runs once.

---

## 4. Data Model

Four new tables, all prefixed `ungated_*`. Three mirror existing tables column-for-column; the fourth is the persistent ledger.

### `ungated_watch_entries`

Identical schema to `watch_entries` (model `WatchEntry` in `prisma/schema.prisma:547`). Every column, every index, same `WatchStatus` enum.

Notable: `initialScore` is still populated and `initialBreakdown` (the 10-factor JSON) is recorded. This enables post-hoc analysis like *"did the ungated track win on low-score trades?"*.

### `ungated_trades`

Identical schema to `trades` (model `Trade` in `prisma/schema.prisma:137`). Same columns including `pnl`, `fees`, `exitPrice`, `entryReason`, `exitReasonTag`, `contextSnapshot`, every M5 context-capture field.

### `ungated_watch_events`

Identical schema to `watch_events` (model `WatchEvent` in `prisma/schema.prisma:607`). Foreign key points at `ungated_watch_entries.id`. Same `WatchEventType` enum.

### `ungated_paper_account` (single-row ledger)

```prisma
model UngatedPaperAccount {
  id               String   @id @default(cuid())
  startingBalance  Float    // ₹80,00,000 — set at first boot, immutable thereafter
  cash             Float    // current cash; decrements on entry, increments on exit
  realizedPnl      Float    // running sum of pnl across closed ungated_trades
  fees             Float    // cumulative fees paid
  deployedCapital  Float    // sum of entryPrice × remainingQty across OPEN trades
  killSwitchAt     DateTime?
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt
  @@map("ungated_paper_account")
}
```

One row, seeded by the first API boot if missing. Reconciled at boot from `ungated_trades` (see § 5.4).

### `ungated_rejections` (the experiment's audit log)

```prisma
model UngatedRejection {
  id          String   @id @default(cuid())
  alertId     String?  // FK-like reference to the source ChartinkAlert
  symbol      String
  // Exact closed enum of values, stored as String for migration simplicity:
  //   'capital-exhausted'  cash < ₹2,00,000
  //   'position-cap'       40 open trades already
  //   'symbol-dup'         token already has a non-terminal ungated entry
  //   'cooldown'           same symbol exited within the cooldown window
  //   'kill-switch'        killSwitchAt != null on the ungated_paper_account row
  // Rejections that happen BEFORE the fork in ChartinkProcessService (market-closed,
  // outside-window, dedup against in-flight ChartinkSetup) are not persisted here —
  // both tracks skip those alerts equally, so they're not part of the A/B delta.
  reason      String
  score       Int?     // the score the rejected alert had — for later "did we miss wins?" analysis
  hitPrice    Float?
  createdAt   DateTime @default(now())
  @@index([createdAt])
  @@index([reason])
  @@map("ungated_rejections")
}
```

Every ungated alert that scored but didn't open a trade gets one row. The `/api/ungated/comparison` endpoint counts these by reason per day.

---

## 5. Service Architecture

### 5.1 Fork point in `ChartinkProcessService.processOne`

The fork sits at `chartink-process.service.ts:273` (right after `evaluateTradePolicy`). The gated path stays exactly as-is; the ungated branch is appended unconditionally:

```typescript
// === 4. Persist + Stage 2 trigger ===

// --- GATED path (existing, untouched) ---
const policy = evaluateTradePolicy({ score: scoringResult.score, at: new Date() });
if (policy.admitted) {
  await this.repo.createAlertSetup({ ... kind: 'setup' ... });
  try { await this.watch.createFromAlert({ ... }); } catch (...) {}
} else {
  await this.rejectSetup({ ... kind: 'scored-low' ... });
}

// --- UNGATED path (NEW — runs unconditionally for every scored alert) ---
// Independent try/catch: a failure here MUST NOT affect the gated path,
// and the gated path's success/failure MUST NOT affect us.
try {
  await this.ungatedWatch.createFromAlert({
    alertId,
    setupId: null,
    symbol: hit.symbol,
    token: instrument.token,
    exchange: 'NSE',
    side,
    initialPrice: hit.hitPrice,
    initialScore: scoringResult.score,
    initialBreakdown: { checks: scoringResult.checks, lotCount: scoringResult.lotCount } as any,
  });
} catch (err) {
  // Each rejection logs AND persists one row to ungated_rejections.
  // The persistence is the source of truth for the daily comparison report.
  if (err instanceof UngatedCapitalExhaustedError) { ... persist ... }
  else if (err instanceof UngatedPositionCapError) { ... persist ... }
  else if (err instanceof UngatedSymbolDupError) { ... persist ... }
  else if (err instanceof UngatedCooldownError) { ... persist ... }
  else { this.logger.warn(`[ungated] unexpected: ${err}`); }
}
```

### 5.2 New module: `ungated-track/`

Mirrors the layout of `watch-monitor/`:

```
apps/api/src/modules/ungated-track/
├── controllers/
│   └── ungated-track.controller.ts       # GET /api/ungated/watch, /paper-account, /comparison
├── services/
│   ├── ungated-watch.service.ts          # MIRROR of watch.service.ts
│   ├── ungated-paper-account.service.ts  # NEW — persists balance + invariants
│   ├── ungated-trade-execution.service.ts# MIRROR of trade-execution.service.ts (paper-only branch)
│   └── ungated-comparison.service.ts     # NEW — daily comparison endpoint
├── repositories/
│   ├── ungated-watch.repository.ts       # MIRROR of watch.repository.ts
│   ├── ungated-trade.repository.ts       # MIRROR of trade.repository.ts (subset)
│   └── ungated-rejection.repository.ts   # NEW — single .create() + .countByDate()
└── ungated-track.module.ts
```

Every duplicated file gets a comment header:

```typescript
/**
 * MIRROR OF apps/api/src/modules/watch-monitor/services/watch.service.ts
 * Keep correctness changes (loss-cut, partial-exit, trailing-stop fixes)
 * in sync with the gated counterpart. See specs/2026-05-20-ungated-shadow-track-design.md.
 */
```

### 5.3 What the ungated copies *don't* replicate

To keep the experiment YAGNI:

- **No options-leg support.** `UngatedWatchService.createFromAlert` rejects any alert with options metadata. Equity-only. Simplifies sizing dramatically.
- **No deferred profit settlement.** `applyExitAccounting` credits cash immediately on every exit (gated track defers wins to 18:00 IST).
- **No manual execute endpoint.** Ungated auto-executes on admission or rejects — no manual retry path.
- **No live trading.** `isPaperTrade = true` is hardcoded. The experiment is paper-only.

### 5.4 Boot-time recovery (`UngatedPaperAccountService.onModuleInit`)

```
1. Load or seed the singleton row (₹80L starting balance if first run).
2. Recompute realizedPnl + fees from SUM(pnl), SUM(fees) WHERE status='CLOSED' on ungated_trades.
3. Recompute deployedCapital from open trades (SUM(entryPrice * remainingQty)).
4. Recompute cash = startingBalance + realizedPnl − fees − deployedCapital.
5. If recomputed `cash` differs from stored row by > ₹1, WARN and overwrite. Catches the "API crashed mid-trade" case.
```

Same shape as gated `PaperTradeService.recoverBalance()` but persisted instead of in-memory.

---

## 6. Capital Accounting

### Invariants (always true post-tick)

```
equity          = startingBalance + realizedPnl − fees + unrealizedPnl
cash            = startingBalance + realizedPnl − fees − deployedCapital
deployedCapital = Σ (entryPrice × remainingQty) for OPEN/PARTIALLY_FILLED ungated_trades
unrealizedPnl   = Σ ((currentPrice − entryPrice) × sideMul × remainingQty) for those same trades
```

### Per-event ledger updates

| Event | Δ cash | Δ deployed | Δ realized | Δ fees |
|---|---|---|---|---|
| Entry fill (BUY 100 @ ₹1500) | −₹1,50,000 | +₹1,50,000 | — | +entry charges |
| Tick (price moves) | — | — | — | — |
| Partial exit (50 @ ₹1525) | +₹76,250 | −₹75,000 | +₹1,250 | +charges |
| Final exit / loss-cut (50 @ ₹1545) | +₹77,250 | −₹75,000 | +₹2,250 | +charges |
| After full exit | net change | back to 0 | total pnl | total fees |

The asymmetry — entry price freezes deployed; exit price drives cash credit — is the bug-prone area. The canary test in § 8.A walks one trade through entry → partial → final and asserts all four fields end at the correct values.

### Admission check (the 40-slot cap)

Before `UngatedWatchService.createFromAlert` opens a new entry:

```typescript
if (account.killSwitchAt) throw new UngatedKillSwitchError();
if (account.cash < TRADE_CAPITAL) throw new UngatedCapitalExhaustedError(account.cash);  // TRADE_CAPITAL = ₹2,00,000
if (openTrades.length >= MAX_CONCURRENT) throw new UngatedPositionCapError(openTrades.length);  // MAX_CONCURRENT = 40
if (await openTradeExistsForSymbol(symbol)) throw new UngatedSymbolDupError(symbol);
if (await inCooldownForSymbol(symbol)) throw new UngatedCooldownError(symbol);
```

Each throw is caught at the fork in `ChartinkProcessService` (§ 5.1) and persists one row to `ungated_rejections`.

---

## 7. API Surface

### New endpoints

| Method + path | Returns |
|---|---|
| `GET /api/ungated/watch?date=YYYY-MM-DD&status=...` | `UngatedWatchEntry[]` enriched with `scannerName`, `realizedPnl`, `realizedFees` — identical shape to gated `/api/watch` |
| `GET /api/ungated/watch/:id` | Single entry + its `events[]` log |
| `GET /api/ungated/paper-account` | `{ startingBalance, equity, cash, deployedCapital, realizedPnl, unrealizedPnl, fees, openPositions, killSwitchAt }` |
| `GET /api/ungated/comparison?date=YYYY-MM-DD` | Daily side-by-side summary (see below) |

### Comparison endpoint payload

```json
GET /api/ungated/comparison?date=2026-05-20
{
  "date": "2026-05-20",
  "gated":   { "tradeCount": 16, "gross": -1621.54, "charges": 1692.35, "net": -3313.89 },
  "ungated": {
    "tradeCount": 42,
    "gross": 4180.22,
    "charges": 4321.10,
    "net": -140.88,
    "rejected": { "capitalExhausted": 3, "symbolDup": 2, "cooldown": 1, "positionCap": 0 }
  },
  "edge": {
    "netDiff": -3173.01,
    "verdict": "ungated outperformed today by ₹3,173 net",
    "winners": { "gated": 4, "ungated": 18 },
    "losers":  { "gated": 12, "ungated": 24 }
  }
}
```

`verdict` is computed server-side so the frontend strip is pure rendering.

---

## 8. UI

### `/ungated-watch` page

Direct mirror of `WatchPage.tsx`: toolbar with status filter tabs (All / Watching / Traded / Stopped / Target Hit), date picker, table, expandable detail panel, day-realised footer.

- **Reuse** the presentational components: `WatchTable`, `WatchDetailPanel`, `TrailingStopSection`, `FactorScoreCell`, `dayRealizedSummary`. These don't know about gating — they just render rows.
- **Duplicate** the data hooks: `useUngatedWatchEntries`, `useUngatedPaperAccount` — mirror `useWatchEntries` / `usePaperAccount` with different base URLs.
- **Duplicate** the page shell: `UngatedWatchPage.tsx` mirrors `WatchPage.tsx` with the hooks swapped.
- **Nav**: a "Ungated (Shadow)" link in the sidebar with a small `EXPERIMENT` badge.

### Comparison strip on `/watch`

Compact horizontal card placed above the existing "Real P/L" header in `WatchPage.tsx`. Date-aligned with the page's date picker.

```
┌──────────────────────────────────────────────────────────────────────────┐
│ A/B  GATED +₹1,234 · 16 trades   UNGATED −₹5,678 · 42t   EDGE +₹6,912 ↑ │
└──────────────────────────────────────────────────────────────────────────┘
```

- **Emerald** EDGE when `gated.net > ungated.net` (gate adds value)
- **Red** EDGE when `gated.net < ungated.net` (gate filtering out winners)
- **Grey** within ±₹100 (no meaningful edge today)
- Click → navigates to `/ungated-watch` with the same date pre-selected.
- Renders nothing when `ungated.tradeCount == 0` (avoids misleading "0 vs 0 edge" on idle dates).

---

## 9. Testing Strategy

### 9.A Ledger correctness (the canary)

One integration-style test in `ungated-paper-account.service.spec.ts` that walks one trade through entry → partial exit → final exit and asserts the four-field end-state matches the invariants in § 6. Catches the entire class of partial/final drift bugs.

### 9.B Fork isolation

Two new tests in `chartink-process.service.spec.ts`:

1. A scored-low alert (score 42) — gated path writes `'scored-low'` rejection, ungated path calls `ungatedWatch.createFromAlert` with `initialScore=42`.
2. A failure in the ungated path (`createFromAlert` throws) — gated path's success is unaffected, error logs with `[ungated]` prefix, error does not propagate.

These prove the fork is genuinely independent.

### 9.C Lifecycle parity

For each rule the ungated track inherits, mirror the gated test with `ungated_*` table names. Header comment on each mirrored file: `// MIRROR OF watch.service.spec.ts — keep in sync.`

| Rule | Test source |
|---|---|
| Hard loss-cut at 0.4% deployed | `watch.service.spec.ts` |
| Partial exit at +1% | `watch.service.partial-exit.spec.ts` |
| Trailing stop at +0.5% from high-water | same |
| Symbol dedup | `watch.service.spec.ts` |
| Cooldown after exit | same |
| Target-hit forwards exitPrice | `watch.service.spec.ts` (the fix from 9fb5bcd) |
| Partial-exit forwards exitPrice | `watch.service.partial-exit.spec.ts` (the fix from 75a8559) |
| **40-position cap** | NEW — ungated-specific |
| **Capital-exhausted rejection** | NEW — ungated-specific |
| **Rejections persisted to ungated_rejections** | NEW — assert one row per rejection |

### 9.D Comparison endpoint

`ungated-comparison.service.spec.ts` — stub a mix of gated + ungated closed trades + rejection rows for one day. Assert each block in the response payload (`gated`, `ungated`, `edge`, `rejected`) computes correctly. Plain-English verdict generation gets its own small test.

---

## 10. Out of Scope (Explicit)

- **Refactoring the gated `WatchService` to share a core with the ungated copy.** Approach A (full duplication) was explicitly chosen. See `2026-05-20-ungated-shadow-track-design.md` § 2.
- **Real / live trading.** Paper-only.
- **Options legs.** Equity-only. Any alert with options metadata is rejected by `UngatedWatchService.createFromAlert`.
- **A separate sidebar nav redesign.** Just one new link with a badge.
- **Tearing down the gated track.** This is *additive*. The gated track is unchanged except for the one fork point in `ChartinkProcessService.processOne`.

---

## 11. Open Questions for the Implementer (none)

All design decisions resolved during brainstorming (2026-05-20 session). Ready for `writing-plans`.

---

## 12. Related Commits & References

- `c2d89b0` — day-realised footer on `/watch` (the helper `dayRealizedSummary` will be reused on `/ungated-watch`)
- `75a8559` — partial-exit `exitPrice` plumbing (must be mirrored in `UngatedWatchService.checkPartialExitTrigger`)
- `9fb5bcd` — target/loss-cut/trailing-stop `exitPrice` plumbing (must be mirrored in all four transition methods)
- `6495e61` — one-shot historical correction script (used to fix 60 wrong Trade rows after 9fb5bcd landed; the ungated track starts clean, no equivalent needed)

---

*End of design.*
