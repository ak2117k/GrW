# Evidence-Weighted Support/Resistance — Design Spec

**Date:** 2026-06-08
**Scope:** Add **volume profile**, **adaptive round numbers**, and **OI walls** as scored S/R candidates, so a price level is only marked resistance/support when corroborated by evidence (volume traded there, prior rejection, OI concentration). Directly fixes the blue-sky breakout case (CUPID) where the pivot/anchored levels are all below price and the chip shows `R —`. Backend-computed (data lives there), frontend renders.

---

## Motivation

The current S/R read (`buildSRView`) uses anchored levels (PDH/PDL/ORH/ORL/VWAP) + pivot zones. On a stock making new highs, all of those sit *below* price → no resistance candidate → `R —`. That is honest but unhelpful when the trade decision is "how far can it run." The fix is to add evidence-based levels — but marked accurately: not every round number is S/R; a level matters only when volume, history, or OI says so.

## Current state (verified inventory)

- **Round numbers:** `LevelBookService.computeRoundNumbers` uses a flat step of **50** for any non-index symbol → for CUPID (₹140) yields 100/150/200/250 (useless). Round numbers are computed but **dropped from the `/signals/analyze` levels payload** (`snapshotFromBook` omits them).
- **Volume profile:** does not exist anywhere. Candle volume (BigInt) is available per 1m/5m/15m bar; live fetch via `angelOneAdapter.getHistoricalData`.
- **OI:** `oi_snapshots` (per-instrument OI/oiChange/volume, 1-min, **F&O segment only**) + `option_chain_snapshots` (full chain JSON per underlying/expiry). `OptionsChainService.getExpiries(symbol)` returns `[]` for non-F&O symbols (the F&O membership test). No max-OI-wall logic exists yet. Cash stocks (CUPID) have **no OI**.
- **Pivots:** `StrongZoneDetectorService` (touch/reversal/volume-scored zones) — the "history" evidence, already built.
- **Frontend synthesis:** `buildSRView(levelBook, zones, ltp)` merges anchored + pivots into immediate/major/context + nearest R/S; drives the chip. `ChartZoneOverlay` draws pivots; `LevelOverlay` draws anchored.

## Architecture (Approach A)

A new backend **`SrEvidenceService`** computes scored evidence levels and exposes them on `GET /signals/sr-evidence`. The frontend `buildSRView` folds these into its existing candidate pool. Each evidence source is its own testable unit. (Rejected: bolting onto StrongZoneDetector — tangles pivot logic; frontend-only — no candle/OI access.)

```
SrEvidenceService.levelsFor(token, exchange, symbol)
  ├─ VolumeProfileService.nodes(candles5m, atr, ltp)      // volume-by-price HVNs
  ├─ adaptiveRoundNumbers(spot)                            // price-tiered grid
  ├─ OiWallService.walls(symbol)                           // F&O only, else []
  └─ scoreAndCluster(candidates, pivots, atr, ltp)         // 0–100, floor, sided
        → EvidenceLevel[]
GET /signals/sr-evidence?token=&exchange=&symbol=  → EvidenceLevel[]
Frontend: useSrEvidence(token, exchange) → buildSRView(levelBook, zones, evidence, ltp)
```

## Evidence sources

### 1. Volume profile (`VolumeProfileService`) — universal
- Input: last **10 trading days of 5m candles** (live via adapter, DB fallback), ATR14, ltp.
- Bucket size: `max(0.1 × ATR14, 0.25% × ltp)`.
- Sum volume per price bucket (distribute each candle's volume across the buckets its high–low spans, or assign to the bucket of its typical price — assign to typical-price bucket for simplicity v1).
- Surface the **top 5 high-volume nodes** (bucket center price + volume).
- Volume score per node: `40 × clamp(nodeVolume / avgBucketVolume / 3, 0, 1)` (≥3× average → full 40).

### 2. Adaptive round numbers (`adaptiveRoundNumbers` helper) — universal
- Price-tiered step (replaces the flat-50 default for equities; indices keep their existing NIFTY=50/BANKNIFTY=100 map):
  `ltp<50→1, <200→5, <500→10, <2000→25, <5000→50, else 100`.
- Generate ±3 steps around spot.
- Round score: **12** for grid membership, **15** if it is a "major" round (a multiple of `5×step`, e.g. a century/half-century). Round numbers are otherwise gated by the floor (see scoring) — a naked round number scores ≤15 and is dropped.

### 3. OI walls (`OiWallService`) — F&O underlyings only
- `getExpiries(symbol)` → if `[]`, return `[]` (cash stock, no OI). Else use the **nearest expiry** chain snapshot.
- Resistance walls: top-2 **call** strikes by OI. Support walls: top-2 **put** strikes by OI. Strike → price level directly.
- OI score: top strike **30**, second **20**.

## Scoring & marking model

Candidate prices come from all sources (volume nodes, round numbers, OI strikes) plus the existing pivot zones (history). They are **clustered** within `max(0.3 × ATR14, 0.3% × ltp)` so confluence sums:

- Each cluster's **score** = volume(≤40) + history(≤25) + OI(≤30) + round(≤15), capped at 100. History = `25 × (nearestPivotStrength/100)` when a pivot zone falls within the cluster tolerance, else 0. `kinds[]` records which evidences contributed (VOLUME/HISTORY/OI_CALL/OI_PUT/ROUND).
- **Side** = cluster price vs ltp (above → resistance, below → support).
- **Representative price** = volume-weighted center of the cluster, or the strongest contributor's price.
- **Floor (strict):** keep clusters with score **≥ 35**. This is the "mark accurately" gate — a naked round number (≤15) is dropped; a round number on a volume shelf (12+30) or a standalone high-volume node (≥35) is kept.
- **Soft fallback for empty sides:** if a side has **zero** kept clusters (e.g. blue-sky above), surface the nearest **1 adaptive round number** on that side as a `soft` level (score below floor, flagged `soft: true`) so a breakout still shows a "how far can it run" reference (CUPID → `R 145`), clearly rendered as faint/dotted.

Output `EvidenceLevel`: `{ price, side: 'resistance'|'support', score, kinds: string[], soft: boolean, distancePct }`.

## Frontend integration

- `useSrEvidence(token, exchange)` hook — polls `/signals/sr-evidence` every 60s (mirrors `useZones`), returns `{ evidence, isLoading, error }`.
- `buildSRView` extended signature: `buildSRView(book, zones, evidence, ltp)`. Evidence levels join the candidate pool with their backend score; anchored levels get a high structural score, pivots use strength. Tiering: nearest each side = `immediate`; high score (≥60) or structural = `major`; kept-but-lower = `context`; `soft` = its own faint tier. The chip's nearest-R/S now populates from the richest available evidence.
- Overlay: add line styles per kind — volume node (e.g. teal shelf), OI wall (e.g. magenta, F&O charts), round/projected (faint dotted for `soft`). Reuse the existing `safeCreatePriceLine` machinery.

## Caching & cost
- `SrEvidenceService` caches per token for 15 min (like the zone cache). Volume profile reuses the adapter's TTL-cached 5m candles (the chart warms them). OI walls read the latest `option_chain_snapshots` row (already captured by the OI tracker). Zone-cache-first short-circuit keeps Angel/DB load low.

## Out of scope (deferred)
- Value-area (VAH/VAL/POC) bands — start with discrete HVN nodes.
- Per-candle volume distribution across the full high–low range (v1 assigns to typical-price bucket).
- Multi-expiry OI aggregation — nearest expiry only.
- Backtesting whether evidence-weighted levels improve trade outcomes.

## Testing
- Unit: `VolumeProfileService` (bucketing, top-N nodes, score scaling, empty/insufficient candles); `adaptiveRoundNumbers` (step per price tier, grid, major-round flag); `OiWallService` (top call/put by OI, `[]` for non-F&O); `scoreAndCluster` (confluence summing, floor gate, sided, soft fallback when a side empty); extended `buildSRView` (evidence folded in, soft tier, tiering).
- Manual: CUPID 15m at new highs → chip shows `R <round/volume> (+x%)` (soft if blue-sky) instead of `R —`; a naked round number with no volume does NOT draw; NIFTY 15m → OI walls appear (magenta) at max call/put strikes; RELIANCE → volume nodes corroborate/raise its pivot levels.

## Success criteria
A level is drawn as S/R only when volume, history, or OI corroborates it; a stock at new highs shows a meaningful overhead reference (volume node or soft round number) rather than `R —`; index/F&O charts surface OI walls; naked round numbers never clutter the chart.
