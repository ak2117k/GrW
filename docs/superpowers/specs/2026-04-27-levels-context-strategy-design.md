# Levels + Context Strategy — Design Spec

> **Status:** Design — pending plan and implementation
> **Date:** 2026-04-27
> **Strategy class:** Intraday level-based scanner with breakout + reversal setups
> **Manual-mode fit:** Decision-support overlay; trader retains final discretion. Compatible with the manual-mode pivot. Per strategic review's validation gate (5y backtest + 2 vol regimes + realistic costs + 3mo paper + defined OFF conditions + documented failure mode), this strategy will be backtested and paper-validated **before any live use**.

---

## 1. Goal

A backend scanner that watches a wide F&O universe (NSE indices + MCX commodities + ~180 NSE F&O stocks ≈ 190 instruments total) intraday, detects when price interacts with high-probability technical levels, and emits structured **Signals** with entry / stop-loss / target / grade / level-context metadata. Signals appear on the existing `/signals` page; clicking one opens the chart with levels + setup marker drawn; one-click execution pre-fills `ExecuteTradeModal` with the signal's parameters and the M5 entry context.

The trader pulls the trigger or skips. The strategy never auto-executes.

### Why this strategy class

The user's stated style is a mix of **breakout + reversal + discretionary**. Both breakouts and reversals share one structural property: they activate at the same key levels (PDH, PDL, opening range, VWAP, round numbers). The difference is just what price *does* at the level. A "Levels + Context Scanner" automates the mechanical work (level identification, setup detection, R:R sizing) and leaves the binary "is this real?" call with the human — which is exactly the manual-mode philosophy.

Three reasons this fits the codebase and the trader:

1. **Encodes existing mental flow.** Experienced intraday traders watch for price interaction with key levels and read context. The strategy automates that watch.
2. **Defined OFF conditions and failure mode** built in by construction. The strategic review's gate requirements are met structurally, not retrofitted.
3. **Plugs into existing infrastructure** with one new strategy class + one new service. `universe-scanner.worker`, `signal-generator`, `SignalGateway`, `/signals` page, `ExecuteTradeModal` are all reused.

---

## 2. Architecture

```
┌─ BACKEND ────────────────────────────────────────────────────────┐
│                                                                  │
│  Angel One WS ticks                                              │
│       │                                                          │
│       ▼                                                          │
│  MarketFeedService → CandleAggregator (existing)                 │
│       │                                                          │
│       ▼                                                          │
│  LevelBookService (NEW)                                          │
│  ┌──────────────────┐         per-instrument level cache:        │
│  │ Map<token, Lvls> │ ◀───── PDH/PDL — refreshed 9:15 IST       │
│  └──────────────────┘         ORH/ORL — locked 9:30 IST          │
│       │                       VWAP — rolling                     │
│       │                       Today H/L — rolling                │
│       │                       Round numbers — derived from spot  │
│       │                       Top-vol option strikes (indices)   │
│       ▼                                                          │
│  UniverseScannerWorker (existing, scope expanded to 190)         │
│       │ runs every 30s, time-of-day-gated                        │
│       │                                                          │
│       ▼                                                          │
│  LevelsContextStrategy.analyze(candles, levelBook)               │
│       │ pure function: walks levels, checks confirmation candle, │
│       │ R:R math, time-of-day; returns Signal | null             │
│       │                                                          │
│       ▼                                                          │
│  SignalRepository (DB) + SignalGateway (WS broadcast)            │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─ FRONTEND ───────────────────────────────────────────────────────┐
│                                                                  │
│  wsService receives 'signal' event (existing, multi-namespace    │
│  routing fixed earlier today)                                    │
│       │                                                          │
│       ▼                                                          │
│  /signals page — extended SignalCard renders:                    │
│  • level type that fired (PDH/PDL/ORH/ORL/VWAP/ROUND/VOL_STRIKE) │
│  • setup type (Breakout / Reversal) + grade (A / B / C)          │
│  • entry, SL, target, R:R, time-of-day window                    │
│  • [📈 View Chart]  [⚡ Trade]                                   │
│       │                                                          │
│       ├── [📈] → /charts?token=…&signal=…                       │
│       │         level lines drawn, setup candle marked,          │
│       │         entry/SL/target zones shaded                     │
│       │                                                          │
│       └── [⚡] → ExecuteTradeModal pre-filled with               │
│                  entry/SL/target + entryReason + entryTags       │
│                  (M5 context auto-captured on confirm)           │
└──────────────────────────────────────────────────────────────────┘
```

### Key architectural decisions

- **`LevelsContextStrategy.analyze` is a pure function.** Inputs: candles + level book + ATR. Output: `Signal | null`. Same code path runs in three modes — live universe scanner, backtest replay against historical candles, ad-hoc diagnostic endpoint. No mode-specific logic to keep in sync. This is what makes the strategic review's "performance proven across 2 vol regimes" measurable.

- **`LevelBookService` is in-memory + lazy-rebuilt at session start.** No new DB tables. Pulls from `candles` (PDH/PDL/ATR), live ticks (VWAP, today H/L), and existing `option_chain_snapshots` (top-volume strikes). Restart-safe — rebuilds in <2 seconds from existing data.

- **Separation of facts vs interpretation.** The level book is *factual* (PDH = 24,180 — that's a number). The strategy is *interpretive* (what to do when price approaches PDH). Future strategies can reuse the same level book.

- **One new strategy class + one new service.** Everything else (universe scanner, signal repo, signal gateway, /signals page, ExecuteTradeModal pre-fill, chart overlay) is existing or a small extension.

---

## 3. Components

### 3.1 LevelBookService — the "factual" layer

```typescript
interface LevelBook {
  token: string; symbol: string; exchange: string; asOf: Date;

  // Static — locked once per session
  pdh: number;          // Previous Day High
  pdl: number;          // Previous Day Low
  prevClose: number;
  orh: number | null;   // Opening Range High (locked at 9:30 IST)
  orl: number | null;
  orLocked: boolean;

  // Dynamic — rolling on every tick
  spot: number;
  vwap: number;
  todayHigh: number; todayLow: number;
  atr14: number;        // 14-period DAILY ATR (computed from last 14 daily
                        // candles at session start). Daily-scale because the
                        // levels themselves are daily-scale (PDH/PDL etc.).
                        // Drives all distance gates and SL-buffer sizing.

  // Computed on demand
  roundNumbers: number[];     // nearest 50/100/500 step (instrument-aware)
  topVolStrikes?: number[];   // index-only, from option_chain_snapshots
  lastTickAt: Date;           // staleness tracking
}
```

**Service methods:**

| Method | Description |
|---|---|
| `seedSession(token)` | At 9:15 IST (NSE) / 9:00 IST (MCX). Pulls PDH/PDL/prevClose from `candles` table, computes ATR14 from last 14 daily candles. |
| `lockOpeningRange(token)` | At 9:30 IST. Freezes ORH/ORL from the first 15-min candle. Sets `orLocked = true`. |
| `updateFromTick(tick)` | Rolling VWAP, today H/L, spot, lastTickAt. |
| `getLevels(token)` | Read accessor. Returns null if not seeded. Returns null with `stale=true` flag if `lastTickAt` > 60s old. |
| `refreshOnInstrumentBoot(token)` | Full rebuild — used on api restart. |

The Map<token, LevelBook> is a service-level singleton. Memory cost: ~200 instruments × ~200 bytes = 40 KB. Trivial.

### 3.2 LevelsContextStrategy — the "interpretive" layer

`analyze(candles: Candle[], levelBook: LevelBook): Signal | null` — pure function.

Walks each level in the book, applies these gates in order; bails at first failure:

| # | Gate | Threshold |
|---|---|---|
| 1 | **Distance** | `|spot - level| ≤ 0.3 × ATR14` |
| 2 | **Confirmation** | All candle/volume references below are the **most-recent closed 5-min candle** (the strategy runs on the 5m timeframe). VMA20 is the trailing 20-period 5-min volume average.<br>**Breakout**: 5m close > level + 0.1·ATR (daily) AND 5m volume > 1.2 × VMA20.<br>**Reversal**: 5m pinbar (body < 30% of candle range, wick toward level) OR engulfing |
| 3 | **Time-of-day** | Within 9:45-11:00 IST OR 14:30-15:30 IST |
| 4 | **Stop-loss** | Just past level + `0.25 × ATR` buffer (asymmetric: tighter on breakouts, wider on reversals) |
| 5 | **Target** | Next opposing level *or* `2.0 × SL distance`, whichever is closer to current price |
| 6 | **R:R** | `target_dist / sl_dist ≥ 2.0` (strict mode) or `≥ 1.5` (balanced mode) |
| 7 | **Grade** | **A:** 2+ levels in confluence + volume > 1.5× + prime time-window. **B:** single level + volume OK. **C:** single level + marginal — emitted with `isActive=false` so it doesn't surface in the UI but is captured for analytics. |

Strict vs balanced is a single config flag (`SCANNER_THRESHOLD=strict|balanced`). All ATR-relative thresholds auto-scale with regime.

### 3.3 Signal payload — what `/signals` returns

The existing `Signal` Prisma model gains **one new column**: `setupContext: Json?`.

```typescript
{
  // existing fields: id, side, strategy, timeframe, riskRewardRatio,
  //                  confidence, confidenceScore, reason, expiresAt, isActive,
  //                  createdAt, ...
  
  // NEW JSON column: setupContext
  setupContext: {
    levelType: 'PDH' | 'PDL' | 'ORH' | 'ORL' | 'VWAP' | 'ROUND' | 'VOL_STRIKE',
    setupType: 'BREAKOUT' | 'REVERSAL',
    levelValue: number,
    grade: 'A' | 'B' | 'C',

    entry: number,
    stoploss: number,
    target: number,

    triggerCandle: { time: number; ohlc: [number, number, number, number] },
    levelBookSnapshot: {
      pdh: number; pdl: number;
      orh: number | null; orl: number | null;
      vwap: number; todayHigh: number; todayLow: number;
    },
    atr14: number,
    volumeRatio: number,                                    // current vol / VMA20
    timeOfDayWindow: 'morning-trend' | 'afternoon-trend',
    expiryDayWarning?: boolean,                             // index options expiry day
  }
}
```

The existing `reason` field becomes a *human-readable summary* generated from `setupContext`:

> *"NIFTY rejected PDH (24,180) at 14:45 IST. Pinbar with 68% upper wick. Volume 1.52× VMA20. ATR-aware stop at 24,200, target at VWAP (24,090). R:R = 2.7. Grade A."*

The frontend uses `setupContext` for the chart overlay (drawing levels at exact prices) and `reason` for the SignalCard text.

A JSON column is chosen over discrete columns so the `setupContext` shape can evolve as level types are added (fair-value gaps, supply/demand zones) without further migrations.

---

## 4. Data Flow

### 4.1 Lifecycle of a typical session

```
08:55 IST  ▼ pre-market boot
           api startup → for each universe instrument:
             • LevelBookService.seedSession(token)
             • pulls PDH / PDL / prevClose from `candles` table
             • computes atr14 from last 14 daily candles
             • level book ready, marked needsOpeningRange=true

09:15 IST  ▼ NSE open (MCX opens 09:00, similar pattern)
           first tick → updates spot + starts VWAP accumulator
           every tick → updateFromTick() rolls VWAP, today H/L

09:30 IST  ▼ opening range locks
           cron fires lockOpeningRange() for each NSE instrument
           ORH/ORL frozen from the single 15-min candle covering 09:15-09:30
           (NOT the highest of three 5-min candles — one 15-min bar pulled
           from the candles table or built by aggregating the period's ticks
           if the 15m bar hasn't closed in DB yet)

09:45 IST  ▼ scanner becomes active (time-of-day gate opens)
           every 30s during 09:45-11:00 + 14:30-15:30:
             for each instrument in universe:
               candles = fetch last 50× 5-min bars
               levelBook = LevelBookService.getLevels(token)
               signal = LevelsContextStrategy.analyze(candles, levelBook)
               if signal:
                 SignalRepository.create(signal)
                 SignalGateway.emit('signal', payload)

11:00-14:30  midday chop — strategy still runs but time-of-day gate
             filters everything out

14:30 IST  ▼ afternoon trending window opens — same as morning

15:30 IST  ▼ session close
           mark all isActive signals inactive
           freeze level book until next 08:55 boot
```

### 4.2 Signal-fired path

```
Strategy returns Signal
       │
       ▼
SignalRepository.create()
       │
       ▼
SignalGateway.emit('signal', payload)         ← existing
       │
       ▼
Frontend wsService receives 'signal'           ← existing, multi-namespace
       │
       ▼
/signals page prepends signal to active list
(plays sound + shows toast on first arrival)
       │
       ▼   ┌──────────────────────────────┐
           │                              │
[📈 View Chart]                  [⚡ Trade]
/charts?token=…&signal=…         ExecuteTradeModal pre-filled:
• level lines drawn               entry, SL, target,
• setup candle marked             entryReason="ORB break of PDH",
• entry/SL/target zones           entryTags=['BREAKOUT','PDH','GRADE_A']
                                          │
                                          ▼
                                User confirms → Trade table row,
                                M5 entry context captured,
                                signalId backref recorded
```

---

## 5. Error Handling

Per failure path. Principle: **graceful degradation > blocking.** Every failure drops the *quality* of signals (no top-vol strikes → less confluence) but never *kills* the scanner.

| Failure | Behavior |
|---|---|
| **DB unavailable when persisting a signal** | Log error, skip. No retry queue — signals are time-sensitive, a 30s-stale signal is useless. Next scan tick will catch the next setup. |
| **Broker WebSocket down** (no ticks) | After 60s of tick silence, level book marked **stale** → `analyze()` returns null. UI shows "Data Stale" badge on /signals header. |
| **Yesterday's daily candle missing** for an instrument | `seedSession()` logs warning, instrument flagged "no PDH/PDL" — strategy skips that instrument's PDH/PDL gates but VWAP/ORH/ORL still work. The 15:35 IST cron we deployed today fills the gap by tomorrow. |
| **Scanner overrun** (scan takes > 30s) | Bull queue's overlap protection drops the next tick. Scan-duration metric exposed at `/api/signals/scanner-stats`. |
| **Strategy throws runtime exception** | Try/catch at scanner level — log, continue with next instrument. One bad signal can't kill the whole scan. |
| **Invalid R:R math** (target ≤ entry, divide-by-zero) | `analyze()` returns null cleanly — never emits a malformed signal. |
| **Stale top-vol-strike data** (option_chain_snapshot > 5 min old) | Drop from level book temporarily; PDH/PDL/VWAP/ORH/ORL still active. |
| **Frontend WS disconnect during a signal fire** | Signal was persisted to DB; user sees it on next page refresh. The wsService reconnect logic (existing) handles re-attaching listeners. |
| **API mid-session restart** | LevelBook auto-rebuilds in <2s from candles + tick history. VWAP approximate (missed ticks during downtime), but PDH/PDL/ORH/ORL are exact. |
| **Expiry day theta risk** (index options) | `setupContext.expiryDayWarning=true` flag + time-to-expiry-hours included so the SignalCard can render a "⚠ Theta acceleration" badge. Doesn't block signal — your call. |

The 60s tick-silence stale-mark is the most important guard: without it, if Angel One's WS hiccups at 13:00, the scanner would keep emitting signals based on a frozen 13:00 spot price.

---

## 6. Testing Approach

The strategic review's validation gate is the bar. Each layer maps to a gate requirement.

### Layer 1 — Unit tests (run on every commit)

`LevelBookService`:
- `seedSession()` against fixture candles → assert PDH/PDL/prevClose/atr14 match expected
- `lockOpeningRange()` with first 15-min candle fixture → assert ORH/ORL freeze correctly
- `updateFromTick()` → VWAP/todayH/todayL roll forward correctly

`LevelsContextStrategy.analyze()` table-driven tests covering at minimum these scenarios (all using fixture candles + fixture level books):

| Scenario | Expected |
|---|---|
| PDH breakout: spot crosses PDH + volume 1.5× + 10:00 IST | Signal, BREAKOUT, grade A |
| PDH rejection: pinbar at PDH + body away + volume 1.2× | Signal, REVERSAL, grade B |
| Distance gate fails: spot 0.5·ATR below PDH | null |
| Time gate fails: identical setup at 12:00 IST (chop hour) | null |
| R:R fails: target only 1.2× SL | null |
| Confluence: PDH + round number within 0.1·ATR | Signal, grade A (boosted) |
| Volume gate fails: breakout but volume only 0.8× MA20 | null |
| Stale tick: lastTickAge > 60s | null |
| Gap-and-go: spot opens above PDH, never tags | null (correct silent behavior) |

### Layer 2 — Integration tests

- End-to-end signal flow: tick fixture → service updates → scanner fires → DB persists → WS emits
- Mid-session restart: level book rebuild from DB matches pre-restart state
- Concurrent instruments: scanner runs through 200 instruments, no instrument blocks others, total scan < 30s

### Layer 3 — Backtest harness — *this is the strategic-review validation gate*

`scripts/backtest-levels-context.mjs`:

1. Loads 10y of NIFTY + BANKNIFTY 5m/15m candles (data we backfilled today)
2. Replays them through `LevelsContextStrategy.analyze()` — *exactly the same code path* the live scanner runs
3. Simulates fills with **realistic cost model:**
   - Slippage: `0.05 × ATR` per fill (both legs)
   - Brokerage: `min(₹20, 0.03% × order_value)` per order (Angel One pricing)
   - STT: 0.025% on options sell, 0.1% on equities sell
   - GST: 18% on brokerage
   - Exchange + SEBI charges: 0.0006%
   - Stamp duty: 0.003% on buy
4. Outputs a structured report with:
   - Total signals, win rate, avg R:R realized, Sharpe ratio, max drawdown
   - Breakdown by **regime** (India VIX bands LOW/NORMAL/ELEVATED/HIGH)
   - Breakdown by **setup type** (Breakout / Reversal)
   - Breakdown by **level type** (PDH / PDL / ORH / ORL / VWAP / ROUND / VOL_STRIKE)
   - Breakdown by **grade** (A / B / C)

This single report **answers** five of the six gate requirements:
- 5y+ backtest ✓ (we have 10y)
- 2 vol regimes ✓ (LOW/NORMAL/ELEVATED/HIGH)
- Realistic costs ✓ (full Indian options cost stack)
- Defined OFF conditions ✓ (regime with Sharpe < 0.5 auto-disabled)
- Documented failure mode ✓ (gap-and-go silent days; HIGH-VIX overfit; midday chop excluded)

The remaining gate item — **3-month forward paper with <20% degradation** — is Layer 4.

### Layer 4 — Forward paper validation (3 months minimum)

- Strategy runs live during market hours
- Every signal auto-creates a paper trade (existing `PaperTradeService`)
- M5 entry-context snapshot captures market state at fire time
- Exit captured on SL hit / target hit / EOD time-exit
- Daily summary report comparable to backtest

After 3 months: compare paper win rate / Sharpe / max DD against the backtest baseline. If paper performance is within 20% of backtest, the strategy graduates to live-eligible. Otherwise the strategy stays in paper and we investigate.

### Layer 5 — Production observability

- **Scan-duration metric** — alert if 30s scan starts taking >25s consistently
- **Signal volume per day** — alert if signals drop to 0 for >2 hours during market hours (data pipeline broken) or jump to 100+ (bug or regime shift)
- **Live-vs-backtest divergence** — running 50-trade rolling Sharpe comparison; if it falls 30% below backtest baseline for 100 trades, automated kill-switch

---

## 7. Out of Scope

These are intentional non-goals for this spec:

- **Auto-execution.** Trader pulls the trigger. Per the manual-mode pivot, auto-trade is frozen.
- **Position sizing recommendations beyond R:R.** Lot size / capital % per trade is out of scope; the existing `UserSettings.maxCapitalPerTrade` governs that.
- **Multi-leg strategies** (iron condors, butterflies, straddles). Single-leg directional only.
- **Fair-value-gap and supply/demand zones.** The level book is extensible to these but they're not in v1.
- **Custom user-defined levels.** v1 ships with the 6 built-in level types; user-defined comes later.
- **Backtest UI.** Layer 3 reports go to stdout / a JSON file; no web UI for browsing backtest results in v1.
- **Options Greeks-aware sizing.** v1 treats option contracts as their underlying's price for entry/SL/target math; delta-aware sizing comes later.

---

## 8. Decision Log

Choices made during brainstorming, with reasoning, so future contributors can challenge them:

1. **ATR-relative thresholds, not fixed-point.** A fixed "30 points from level" threshold over-fires in volatile sessions and misses real setups in calm ones. ATR auto-scales.
2. **JSON column for `setupContext`, not discrete columns.** The shape will evolve as level types are added; a JSON column accepts that without migrations.
3. **Strict-mode default, not balanced.** User said "A or B is fine." Strict = grade A only at 1:3 R:R; can loosen via env var if signal volume is too low.
4. **Pure function for `analyze`.** Same code path runs in live scanner, backtest, and diagnostic endpoint. No mode-specific logic to keep in sync.
5. **In-memory level book, no new DB tables.** Memory cost is trivial; rebuild from DB on restart is <2s.
6. **No grid-search parameter optimization.** Strategic review explicitly warns against it (overfitting to historical data). Defensible-but-not-optimal thresholds; M5 journal data informs adjustments after real trades.
7. **Time-of-day gate excludes 11:00-14:30 IST.** Midday chop is well-documented to produce false breakouts in Indian indices. Not optional.
8. **OI fundamentally unavailable in v1** (Angel One paid product). Top-volume strikes substitute. Volume-based confluence has weaker signal than OI but is what's available at ₹0 infra cost.
9. **Stocks: cash market or stock-future, not stock options.** Stock options have variable lot sizes and lower liquidity — not suitable for a wide-universe scanner in v1.

---

## Pending — User Review

This spec needs your approval before it goes to implementation planning. Read it through. If anything is wrong, ambiguous, or missing, flag it and we'll revise.
