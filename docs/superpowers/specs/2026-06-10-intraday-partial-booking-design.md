# Intraday Semi (Partial) Profit Booking — Design

> Date: 2026-06-10 · Status: approved · Area: `apps/api` anand-dual-track (intraday only)

## Problem
Intraday winners give back gains: profit protection only arms at +5%, and the Supertrend(10,3) 15m trail then sits ~3×ATR (~7%) below the peak — so PANAMAPET ran +6.7% and round-tripped to **0%** before the trail fired. There is **no partial booking and no breakeven lock** between entry and the trail. (Swing is out of scope — it already exits at +10% target and reinvests the gain.)

## Rule
Once an intraday position reaches **+3%** (`PARTIAL_TRIGGER_PCT`):
1. **Book 50%** (`PARTIAL_FRACTION`) of the position at the current **fresh** price (via `ExitPriceService`) — gain locked.
2. **Move the remaining 50%'s stop to breakeven** (entry price) — the runner can no longer turn the trade into a loss.
3. The runner continues on the **existing** logic unchanged: arm the Supertrend trail at +5%, else trail / breakeven-stop / EOD-expire.
Realized P&L on close **blends both legs**: `0.5×(partialExitPrice−entry) + 0.5×(finalExit−entry)`.

*PANAMAPET re-run:* +3% → book 50% (+3% locked); peak +6.7%; reverses; runner exits ~breakeven → net ≈ **+1.5%** vs the actual **0%** (and more if the runner trails higher).

## Changes

**1. Prisma (`intraday_entries`)** — add (intraday is %-based, no quantity, so these are the partial-leg fields):
```prisma
  partialBookedAt  DateTime?
  partialExitPrice Float?
  partialFraction  Float?    // 0.5 when booked
  stopMovedToBE    Boolean   @default(false)
```
`prisma db push` (never migrate dev). Repo: add `recordIntradayPartial(id, {partialExitPrice, partialFraction, stopMovedToBE, partialBookedAt})` + include the new fields in `listWatchingIntraday` selects.

**2. `anand-price-monitor.service.ts`**
- Constants: `PARTIAL_TRIGGER_PCT = 3`, `PARTIAL_FRACTION = 0.5`.
- `checkIntraday`: per entry, after resolving the fresh `ltp` (already via `ExitPriceService` from the prior fix), compute `pnlPct`. **Before** the trail decision: if `!entry.partialBookedAt && pnlPct >= PARTIAL_TRIGGER_PCT` → `recordIntradayPartial(...)` (partialExitPrice=ltp, fraction=0.5, stopMovedToBE=true), log `[anand-intraday] <id> partial 50% booked at +X%`, set a local `stopMovedToBE=true`, and **continue** (do not terminate).
- `decideIntradayTrail`: add `stopMovedToBE: boolean` to the input. The non-trailing **STOP threshold becomes breakeven** when set: `if (pnlPct <= (stopMovedToBE ? 0 : -stopPct)) return STOP`. In the trailing branch, also floor at breakeven: if `stopMovedToBE && ltp <= entryPrice` → STOP. Everything else (ARM_TRAIL at +target, Supertrend EXIT, 2% give-back) unchanged.

**3. P&L blending** — a shared helper `realizedIntradayPnlPct(entry)`:
```
if (partialExitPrice != null && partialFraction != null && exitPrice != null)
  return partialFraction*(partialExitPrice-entry)/entry*100 + (1-partialFraction)*(exitPrice-entry)/entry*100;
else return (exitPrice-entry)/entry*100;   // legacy / no partial
```
Apply it wherever **closed** intraday realized P&L is summed (find via grep: the anand P&L summary in `anand-dual-track.service.ts` / controller). `price-fields.ts` (live/open display) stays as-is for the open runner, but surface that a partial was booked (e.g. include `partialBookedAt`/`partialExitPrice` in the row so the UI can show "50% booked @ +X%").

## Testing (TDD)
- `decideIntradayTrail`: with `stopMovedToBE=true`, STOP fires at breakeven (pnl ≤ 0), not −5%; with false, still −5%. ARM_TRAIL/Supertrend unchanged.
- `checkIntraday`: a position crossing +3% books the partial exactly once (idempotent — not re-booked on later ticks); sets stopMovedToBE; does not terminate the entry.
- `realizedIntradayPnlPct`: blends 50/50 correctly; falls back to plain when no partial.

## Out of scope
Swing (already exits+reinvests at +10%); the watch/ungated/adaptive tracks (they have their own +1% partial); changing the +5% arm, Supertrend params, or EOD expiry.
