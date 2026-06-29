# Anand Dual-Track Enhancements — Design Spec

**Date:** 2026-06-04
**Status:** Approved for planning
**Scope:** Four enhancements to the existing Anand dual-track (intraday `/intraday` + swing `/swing`) feature, plus one new page (`/reinvest`).

---

## 1. Context & Existing System

The Anand dual-track is driven by Chartink scanners tagged `ANAND_SWING`. When such a scanner fires and a symbol passes the scoring pipeline, `AnandDualTrackService.createEntries()` opens **two parallel simulated entries**:

| Track | Model | Target | Stop | Lifecycle end |
|-------|-------|--------|------|---------------|
| Intraday | `IntradayEntry` | +5% | −5% | also `EXPIRED` (mark-to-market at 15:15 IST) |
| Swing | `SwingEntry` | +10% | −10% | — |

**Key existing facts (do not break):**
- P&L is **simulated on a fixed notional `NOTIONAL = ₹200,000` per trade**. There is no real capital pool. `pnlRs = (pnlPct/100) × 200_000`.
- `AnandPriceMonitorService` runs a cron: polls every 30s during market hours (09:15–15:15 IST, Mon–Fri), every 10m overnight. It marks `TARGET_HIT` / `STOPPED` / `EXPIRED` and sets `exitPrice` + `exitedAt`.
- `createEntries()` already has an **independent per-track dup-guard**: it skips a track if an *active TRADED* entry (exitPrice == null) exists for that symbol+track. After an exit, the symbol is currently un-blocked.
- `getPnlSummary(track)` buckets exited rows by IST day into daily/weekly/monthly/yearly cards.
- Schema is evolved via **`prisma db push`** (NEVER `migrate dev` — it would reset the DB).

**Relevant files:**
- Backend: `apps/api/src/modules/anand-dual-track/{services/anand-dual-track.service.ts, services/anand-price-monitor.service.ts, repositories/anand-dual-track.repository.ts, controllers/anand-dual-track.controller.ts}`
- Trigger: `apps/api/src/modules/chartink/services/chartink-process.service.ts` (~line 398 calls `createEntries`)
- Frontend: `apps/web/src/pages/{swing/SwingPage.tsx, intraday/IntradayPage.tsx}`, hooks `apps/web/src/hooks/{useSwingEntries.ts, useIntradayEntries.ts}`, `apps/web/src/App.tsx`, `apps/web/src/components/layout/Sidebar.tsx`
- Schema: `prisma/schema.prisma` (`IntradayEntry` / `SwingEntry` ~lines 786–822)

---

## 2. Feature 1 — Swing Lead Counter

**Goal:** For each symbol, count how many times it has "led" (appeared as a swing lead) and record when, so a repeated symbol is visible on the Swing page.

### Data model
New model `SymbolLeadStat`:
```prisma
model SymbolLeadStat {
  id        String   @id @default(cuid())
  symbol    String
  track     String   // "swing" (intraday reserved for future)
  count     Int      @default(0)
  dates     Json     // string[] of ISO datetimes, one appended per fire (lossless log)
  lastLedAt DateTime
  @@unique([symbol, track])
  @@map("symbol_lead_stats")
}
```

### Behavior
- In `createEntries()`, on **every** swing scanner fire for the symbol (BEFORE the dup-guard / re-entry checks), upsert `SymbolLeadStat`: `count += 1`, append the current ISO timestamp to `dates`, set `lastLedAt`. This counts true lead frequency even when no new entry is created because a position is open.
- Repo method: `bumpLeadStat(track, symbol)` (upsert).
- Repo method: `getLeadStats(track, symbols[])` → map `symbol → { count, dates }` for enrichment.

### UI
- `SwingPage` gains a **"Leads"** column (placed after Scanner). Renders a count badge (e.g. `×3`).
- On hover, a tooltip lists the **distinct calendar days** (deduped from the timestamp log, most-recent first). The raw count reflects every fire; the tooltip is the human-readable day list.
- The swing entries response is enriched with `leadCount` and `leadDates` per row, joined by symbol.

---

## 3. Feature 2 — No Same-Day Re-Entry After Target Hit

**Goal:** Once a symbol hits its target today, do not open a new entry for that symbol again the same day. Applies to **both** intraday and swing. A stop-out does NOT block re-entry.

### Behavior
- New repo method `hasTargetHitTodayBySymbol(track, symbol): boolean` — true if any entry for that symbol+track has `status === 'TARGET_HIT'` and `exitedAt` falls within the current IST day.
- In `createEntries()`, extend each track's guard:
  - Skip creating the entry if `findActiveTradedBySymbol` returns an open position (existing behavior), **OR** if `hasTargetHitTodayBySymbol` is true (new).
- When skipped due to a same-day target hit, log a structured skip reason (`SKIP_TARGET_HIT_TODAY`) consistent with existing skip logging so it is auditable.
- The IST-day boundary helper already used in the repository (`getPnlSummary`) is reused for the "today" window.

### Edge cases
- A symbol that hit target intraday but not swing is blocked only on the intraday track (guards are independent per track), and vice-versa.
- Reinvestment lots (Feature 4) are NOT subject to this guard — they are opened by the swing target-hit event itself, not by `createEntries()`.

---

## 4. Feature 3 — Intraday Trailing Stop After +5%

**Goal:** Instead of booking the intraday trade at exactly +5%, once price *touches* +5% switch into a trailing mode and let the winner run, exiting via a Supertrend-based trailing line ("the next achievable TP").

### Data model
Add to `IntradayEntry`:
```prisma
trailing   Boolean  @default(false)
peakPrice  Float?   // highest LTP seen while trailing
exitReason String?  // "TARGET_5PCT" | "TRAIL_ST" | "TRAIL_GB" | "STOP" | "EXPIRE"
```

### Monitor logic (`AnandPriceMonitorService`)
For each open intraday entry on each poll:
1. **Before +5% is reached:** unchanged. `pnlPct ≤ −5%` → `STOPPED` (`exitReason='STOP'`).
2. **Crossing +5% the first time:** if `pnlPct ≥ 5%` and `trailing == false` → set `trailing = true`, initialize `peakPrice = ltp`. **Do not exit.**
3. **While trailing (`trailing == true`):**
   - Update `peakPrice = max(peakPrice, ltp)`.
   - Fetch **Supertrend(period 10, multiplier 3) on 15m candles** for the symbol via the existing rate-limited + TTL-cached candle API (reuse the Supertrend implementation already used by the scoring pipeline; do not reimplement).
   - **Exit** at `ltp` with `status='TARGET_HIT'`, `exitReason='TRAIL_ST'` when `ltp` falls below the current Supertrend line.
   - **Fallback** (candles unavailable / Supertrend null): exit when `ltp ≤ peakPrice × (1 − 0.02)` (2% give-back), `exitReason='TRAIL_GB'`.
   - The −5% stop no longer applies once trailing has started (price is already well above entry; the trail governs the downside).
4. **15:15 expiry:** unchanged — any still-open intraday entry (trailing or not) is marked `EXPIRED` (`exitReason='EXPIRE'`) at LTP.

### Notes
- A trailed exit is recorded as `TARGET_HIT` so the existing P&L summary counts it as a realized win-exit at the *actual* (higher) exit price; `exitReason` differentiates how it closed.
- Candle fetches are cached and rate-limited; only entries that are actively trailing fetch candles, keeping request volume low.
- The monitor must inject the market-data/candle service that exposes `getCandleData`.

### UI
- `IntradayPage`: show a **"trailing"** indicator chip on rows where `trailing == true` and still open; show `exitReason` (e.g. "trail" vs "5%") on closed rows. Header note updated from "5% target" to "5% → trailing (Supertrend 15m)".

---

## 5. Feature 4 — Swing Profit Reinvestment + Reinvestment Page

**Goal:** When a swing position hits +10%, the **capital returns to the pool** and **only the ₹20k profit is reinvested** into the *same symbol* as a separately-tracked lot. A new page shows the reinvestment dashboard and history.

### Money model (explicit)
- Swing trade notional = ₹200,000 (unchanged, simulated). A +10% target hit realizes profit `= 0.10 × 200_000 = ₹20,000`.
- "Capital returns to the pool" = the ₹200k is conceptually freed (no-op in the simulation; the original swing P&L cards are untouched).
- **Only the ₹20,000 profit is reinvested** → a new `ReinvestmentLot` sized at ₹20,000 in the same symbol, governed by the same +10% / −10% rules.
- A singleton `ReinvestmentPool` tracks the rupee flow of *reinvested profits only*.

### Data model
```prisma
model ReinvestmentLot {
  id                String    @id @default(cuid())
  symbol            String
  sourceSwingEntryId String   // the SwingEntry whose +10% funded this lot
  capital           Float     // = profit reinvested (₹20,000)
  entryPrice        Float     // symbol price when the lot opened (= swing exitPrice)
  enteredAt         DateTime  @default(now())
  targetPct         Float     @default(10.0)
  stopPct           Float     @default(10.0)
  status            String    @default("OPEN") // OPEN | TARGET_HIT | STOPPED
  exitPrice         Float?
  exitedAt          DateTime?
  exitReason        String?
  @@index([status, enteredAt])
  @@index([symbol])
  @@map("reinvestment_lots")
}

model ReinvestmentPool {
  id             String  @id @default("singleton")
  harvestedTotal Float   @default(0) // cumulative profit harvested into reinvestment
  deployedActive Float   @default(0) // capital currently in OPEN lots
  idleBalance    Float   @default(0) // returned lot proceeds not yet redeployed
  realizedPnl    Float   @default(0) // cumulative realized P&L from closed lots
  @@map("reinvestment_pool")
}
```

### Lifecycle
1. **Swing +10% hit** (in the monitor, where `SwingEntry` → `TARGET_HIT` is set): atomically also
   - create a `ReinvestmentLot` { symbol, sourceSwingEntryId, capital=20_000, entryPrice = swing exitPrice, OPEN };
   - pool: `harvestedTotal += 20_000`, `deployedActive += 20_000`.
   - Idempotency: only one lot per `sourceSwingEntryId` (unique-ish guard) so a re-poll cannot double-create.
2. **Lot monitored** (same cron, same Supertrend-free 10/10 rules as swing): compute `pnlPct` from `entryPrice` vs LTP.
   - `pnlPct ≥ 10%` → `TARGET_HIT`; `pnlPct ≤ −10%` → `STOPPED`. Set `exitPrice`, `exitedAt`, `exitReason`.
   - On close: `lotPnl = (pnlPct/100) × capital`; pool: `deployedActive -= 20_000`, `idleBalance += (20_000 + lotPnl)`, `realizedPnl += lotPnl`.
   - **No auto-redeploy** of idle balance (YAGNI) — it accumulates and is displayed.
3. Reinvestment lots are exempt from the Feature-2 same-day re-entry guard (they are event-driven, not scanner-driven).

### Backend API (new routes under existing `api/anand` controller, or a dedicated `ReinvestmentController`)
- `GET /api/anand/reinvest/lots?status=` → lots enriched with live price + current `pnlPct`/`pnlRs`.
- `GET /api/anand/reinvest/pool` → the singleton pool snapshot.

### New page `/reinvest` ("Reinvestment")
- Register route in `App.tsx`; add sidebar item in `Sidebar.tsx` (icon e.g. `Recycle` / `PiggyBank`).
- New hook `apps/web/src/hooks/useReinvestLots.ts` + API client methods.
- **Dashboard cards:** Harvested Total · Deployed (active) · Idle Balance · Realized P&L (₹, color-coded).
- **Open lots table:** Symbol · Source swing · Capital ₹ · Entry ₹ · Price/Δ% · P&L ₹/% · Target · Status.
- **Closed lots history table:** Symbol · Capital · Entry → Exit · P&L ₹/% · Exit reason · Dates.

---

## 6. Cross-Cutting Concerns

- **Schema migration:** all new models/fields applied via `npx prisma db push` then `prisma generate`. Never `migrate dev`.
- **Monitor symbol set:** `AnandPriceMonitorService` now also polls (a) open reinvestment lots and (b) trailing intraday entries' candles. Reuse the existing LTP batch path for lots; candles only for actively-trailing intraday entries.
- **Additive enums/strings:** new `status`/`exitReason` values are additive; no existing string contract breaks. P&L summaries already filter on `['TARGET_HIT','STOPPED','EXPIRED']` — trailed exits surface as `TARGET_HIT` so they are included.
- **IST correctness:** reuse the repository's existing IST-day boundary helper for Feature-2 "today" and any reinvestment day bucketing.

---

## 7. Testing Strategy

- **Unit (repo/service):**
  - `bumpLeadStat` increments count + appends date; upsert is idempotent per call.
  - `hasTargetHitTodayBySymbol` true only within the IST day; false for yesterday's hit and for stop-outs.
  - `createEntries` skips a track when same-day target hit exists; still bumps lead stat.
  - Reinvestment: swing target-hit creates exactly one lot + correct pool deltas; lot close updates pool correctly for both win and loss; double-poll does not double-create the lot.
- **Monitor logic:**
  - Intraday: crossing +5% sets `trailing` without exiting; Supertrend breach exits as `TRAIL_ST`; candle-unavailable path exits as `TRAIL_GB` at 2% give-back; 15:15 still expires.
- **Frontend:** Leads column renders count + day tooltip; Reinvestment page renders cards + both tables from mocked API.
- Run `tsc --noEmit` (ignore known spurious `@td/shared` standalone errors) and existing jest suites.

---

## 8. Out of Scope (YAGNI)

- Real capital-pool accounting for the base ₹200k notional (stays simulated).
- Auto-redeployment of idle reinvestment balance.
- Intraday lead counter (model supports `track` but only swing is wired now).
- Multi-level/compounding reinvestment lots (each lot is a discrete ₹20k; no lot-of-a-lot).
