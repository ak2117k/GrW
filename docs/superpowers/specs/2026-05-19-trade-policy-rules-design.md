# Trade Policy & Charges — Design Spec

**Date:** 2026-05-19
**Status:** Approved (design)
**Branch:** `feature/trade-policy-rules`

## Problem

The watch-monitor cockpit auto-executes Chartink-alert trades using MVP
placeholders: a flat ₹2,00,000 capital, a flat ₹1,000 hard stop, a flat ₹100
exit fee, no re-entry cooldown, no time-of-day gating, and a same-symbol guard
that reads-then-creates (not atomic). Result observed on 2026-05-19:
ZYDUSLIFE traded 8×, COFORGE 5×, POLICYBZR/GESHIP/CAPLIPOINT/GLAND/ANGELONE 4×
each — the scanners keep re-listing the same names and every close immediately
re-arms the symbol.

One latent bug (R1, the racy guard) plus five never-built features (R2–R6).

## Requirements

**R1 — No concurrent duplicate.** At most one *active* (`WATCHING` or
`TRADED`) watch entry may exist per symbol. The existing
`WatchService.createFromAlert` → `findActiveByToken` guard expresses this but
is read-then-create, not atomic.

**R2 — 30-minute cooldown.** Once a symbol's trade has been *executed*, no new
trade for that symbol may be initiated for 30 minutes, measured from
`executedAt`.

**R3 — 11:45–14:00 IST stricter admission.** A trade is admitted only if
`score ≥ minScore`, where `minScore = 75` when the decision moment falls in
the half-open IST window `[11:45, 14:00)`, otherwise `60`.

**R4 — Score-tiered capital.** Capital deployed per trade:
- Inside `[11:45, 14:00)` IST: **₹1,00,000** (flat).
- Outside that window, by score: `[60,65) → ₹1,00,000`,
  `[65,75) → ₹1,50,000`, `[75,∞) → ₹2,00,000`.

Quantity = `floor(capital / executionPrice)`.

**R5 — Stop-loss = 0.4% of capital used.** The hard *price* loss-cut threshold
for a trade = `0.004 × (quantity × executedPrice)` — i.e. 0.4% of the actual
deployed capital. Replaces the flat ₹1,000. The score-decay stop and the
trailing stop are unchanged.

**R6 — Real SEBI charges on both legs.** Per order (Indian equity intraday):
- Brokerage = `min(0.03% × turnover, ₹20)`.
- STT = `0.025% × turnover` — **sell side only**.
- Exchange transaction = `0.00297% × turnover` (NSE) / `0.00375%` (BSE).
- SEBI fee = `₹10 per crore` = `0.0001% × turnover`.
- Stamp duty = `0.003% × turnover` — **buy side only**.
- GST = `18% × (brokerage + exchange transaction)`.
- Order total = sum of the applicable items.

Applied to **both** the entry (BUY) and the exit (SELL) order. Replaces the
flat ₹100 exit fee; the entry is no longer free.

## Design

Two new **pure modules** plus targeted wiring — one source of truth each, no
rules scattered across services.

### `trade-policy.ts` (new — watch-monitor module)

```
evaluateTradePolicy({ score: number; at: Date }):
  { admitted: boolean; minScore: number; capital: number; reason?: string }
```

- `isStrictWindow(at)` — true when the IST time-of-day is in `[11:45, 14:00)`.
- `minScore` = strict ? 75 : 60.
- `admitted` = `score ≥ minScore`; on false, `reason` explains
  (e.g. `score 70 below 75 (11:45-14:00 IST window)`).
- `capital` = strict ? 100000 : `score < 65 ? 100000 : score < 75 ? 150000 : 200000`.

Covers R3 (admission) and R4 (capital).

### `trade-charges.ts` (new — trade-engine module)

```
computeOrderCharges({ side: 'BUY'|'SELL'; price: number;
                      quantity: number; exchange: string }):
  { brokerage; stt; exchangeTxn; sebiFee; stampDuty; gst; total }
```

`turnover = price × quantity`; items per R6. Covers R6.

### Wiring

| Rule | Call site | Change |
|------|-----------|--------|
| R3 | `ChartinkProcessService.processOne` | `score >= 60` → `evaluateTradePolicy({ score, at: now }).admitted`; rejected → `scored-low` with the policy reason |
| R4 | `WatchService.executeEntry` | qty = `floor(evaluateTradePolicy({ score: entry.initialScore, at: now }).capital / referencePrice)` instead of `floor(MAX_INVESTMENT_PER_TRADE / …)` |
| R5 | `applyTick` loss-cut, `transitionLossCut` confirm, `WatchMonitorService.checkOpenLoss` | threshold = `hardLossCutRupees(entry)` = `0.004 × quantity × executedPrice`, replacing `HARD_LOSS_CUT_RUPEES` |
| R2 | `WatchService.createFromAlert` | new repo query `wasTokenExecutedSince(token, now − 30m)`; if true → reject + log, no create |
| R1 | `ChartinkProcessWorker` | verify Bull concurrency — if 1 (serial), the existing guard + R2 suffice; if >1, add a per-token in-flight lock in `createFromAlert` |
| R6 | `PaperTradeService` / `TradeExecutionService` | charge the entry order at fill and the exit order in `applyExitAccounting`, both via `computeOrderCharges`; `Trade.fees` accumulates both |

## Decisions / edge cases

- Score-tier boundaries are half-open: exactly 65 → ₹1.5L tier, exactly 75 → ₹2L tier.
- The 11:45–14:00 window is IST, half-open `[11:45, 14:00)`.
- R3 evaluates at `processOne` time, R4 at `executeEntry` time; they run within
  ~1s of each other, both with `now` — consistent.
- "Capital used" for R5 is the **actual** `quantity × executedPrice`, not the
  decided tier capital (which differs by the `floor()` remainder).
- `MAX_INVESTMENT_PER_TRADE` / `DEFAULT_MAX_CAPITAL_PER_TRADE` stay only as the
  legacy fallback inside the P&L formulas (entries persisted before `quantity`
  existed). `executeEntry` stops using them for sizing. All tiers ≤ ₹2L, so the
  RiskManager per-trade cap still holds.
- No schema migration required — `quantity` and `executedPrice` already exist
  on `WatchEntry`.

## Risk

- **R6 changes paper-account economics.** The startup balance-replay reads
  `fees` per trade row — it stays correct (reads whatever each row recorded).
  New trades show realistic round-trip costs; pre-existing rows keep ₹100.
- **R5 tightens the stop** vs today for the ₹1L/₹1.5L tiers (₹400/₹600 vs
  ₹1,000) and slightly for ₹2L (₹800). More trades will hit the hard stop —
  intended.

## Testing

- `trade-policy.ts` and `trade-charges.ts` — pure functions, full unit
  coverage: tier boundaries, the window edges (11:44/11:45/13:59/14:00),
  buy-vs-sell charge differences, the brokerage `min(…,₹20)` cap.
- Wiring — extend the existing `watch.service`, `chartink-process`,
  `paper-trade`, `trade-execution` specs, TDD (a failing test per change).

## Out of scope

- Options charges (these are equity-intraday formulas; the watch flow is equity).
- DP charges (delivery only).
- A DB-level atomic uniqueness index — only added if the worker concurrency
  check (R1) shows it is needed.
