# Unified S/R Decision Read — Design Spec

**Date:** 2026-06-08
**Scope:** Make the immediate/major S/R read draw from BOTH the always-present anchored levels (PDH/PDL/ORH/ORL/VWAP) AND the pivot zones, so a *moving* stock always shows a clear "nearest wall above / nearest wall below" for the trade decision — instead of "no zones". Plus stop hiding freshly-flipped (forming) pivot levels, which are the breakout-origin levels that matter most in a moving market. Frontend-only; no backend changes.

---

## Problem

The strong-zone pivot detector works for range-bound stocks (many retested swing highs/lows) but goes quiet exactly when a stock is *breaking out* — the swings got blown through, and the one surviving level is a freshly-flipped zone the detector demotes to WEAK (one-tier "freshness demotion" until 3+ retests). The frontend filters WEAK, so a momentum stock like GUFICBIO (+3.88%) shows "S/R: no zones (insufficient data)" — even though the chart already displays the reliable moving-market levels (PDH 378, ORH 390, VWAP 386, ORL 367.80, PDL 358) via the separate `LevelOverlay`.

The two overlays don't talk to each other. The pivot detector and the anchored levels have opposite strengths; the trade-decision use-case ("is there room above? where does a pullback hold?") is precisely where anchored levels win. The fix is to **synthesize one S/R read from both sources.**

## Current state (verified)

- `ChartsPage` has `analysis.levels` (the level book) from `useChartAnalysis`: fields `pdh, pdl, orh (nullable), orl (nullable), prevOrh, prevOrl, vwap` (already consumed by the `analysisOverlayLevels` memo that feeds `LevelOverlay`).
- `ChartsPage` has `zones: StrongZone[]` from `useZones`, and `ltp` (currentPrice/last close).
- `classifyZoneTiers(zones, ltp)` tiers pivot zones only; `ChartZoneOverlay` draws them and skips WEAK; the chip reads `classifyZoneTiers(...).length`.
- `LevelOverlay` draws PDH/PDL/ORH/ORL/VWAP as labeled price lines (kept, unchanged).

## Design

### 1. Unified S/R model + builder (pure, tested)
New `apps/web/src/components/charts/buildSRView.ts`:

```ts
export type SRSource = 'PDH' | 'PDL' | 'ORH' | 'ORL' | 'VWAP' | 'PIVOT';
export type SRTier = 'immediate' | 'major' | 'context';

export interface SRLevel {
  price: number;                 // reference price (pivot: reachable edge)
  side: 'resistance' | 'support';// vs ltp: above = resistance, below = support
  source: SRSource;
  label: string;                 // native label: 'PDH','VWAP', or pivot 'S<strength>'
  tier: SRTier;
  distancePct: number;           // signed % from ltp (+ above, − below)
  classification?: 'STRONG' | 'MEDIUM' | 'WEAK'; // pivots only
}

export interface SRView {
  immediateResistance: SRLevel | null; // nearest above
  immediateSupport: SRLevel | null;    // nearest below
  levels: SRLevel[];                    // all, tiered
}

export interface LevelBookLite {
  pdh: number | null; pdl: number | null;
  orh: number | null; orl: number | null;
  prevOrh: number | null; prevOrl: number | null;
  vwap: number; // 0 when unavailable
}

export function buildSRView(
  book: LevelBookLite | null,
  zones: StrongZone[],
  ltp: number,
): SRView;
```

**Candidate collection (when ltp > 0):**
- Anchored, each a single-price level when present and > 0: PDH, PDL, VWAP; ORH/ORL when locked, else fall back to prevOrh/prevOrl (labelled `ORH`/`ORL` still — they are the active OR reference). Skip any null/≤0.
- Pivot zones: reuse the existing reachable-edge rule (resistance → lower edge, support → upper edge; line → upper). Include flipped/forming zones; exclude only **non-flipped WEAK** zones (mirrors the backend's own keep rule). Each carries its `classification` and `strength`-based label `S<strength>`.

**Sided + de-duplicated:** `side` from price vs ltp. Drop anchored levels whose price is within a tiny epsilon (e.g. 0.05%) of an already-collected level on the same side (avoid PDH==pivot-edge double entries) — keep the anchored one (more meaningful label).

**Tiering:**
- `immediate` = the single nearest level above ltp, and the single nearest below (across the whole union). These populate `immediateResistance` / `immediateSupport`.
- `major` = structurally significant non-immediate levels: STRONG pivot zones + PDH + PDL (daily structure).
- `context` = everything else (MEDIUM/forming pivots, ORH/ORL/VWAP that aren't the nearest).

Returns `{ immediateResistance: null, immediateSupport: null, levels: [] }` when `ltp ≤ 0`. Pure, fully unit-tested. (Supersedes `classifyZoneTiers` as the chip/decision source; `classifyZoneTiers` may remain for `ChartZoneOverlay`'s pivot rendering, or be retired if the unified overlay absorbs it — see §3.)

### 2. Chip becomes the decision readout
In `ChartsPage`, replace the count chip with a nearest-wall readout driven by `buildSRView`:
- Both sides present: `R 390.0 (+1.5%) · S 378.0 (−1.6%)`
- One side only: show that side; other side `—`
- `ltp ≤ 0` or no candles: `S/R: insufficient data` (the ONLY case that says "insufficient data")
- Levels exist but somehow no immediate either side: `S/R: no levels`

This directly answers "room above / support below" for the trade decision, and works on every stock because anchored levels are always present.

### 3. Show forming (flipped) pivot levels
`ChartZoneOverlay` (pivot lines): stop skipping flipped zones. Draw a freshly-flipped zone as a distinct **forming** style — dotted, with an `S→R FORMING` / `R→S FORMING` tag — so a breakout's just-flipped level (e.g. GUFICBIO's flipped support) is visible. Non-flipped WEAK zones stay skipped (genuine noise). The existing immediate/major/context pivot styling is unchanged; "forming" is an added style for `flippedAt != null` zones.

## Out of scope (deferred)
- Visual emphasis (bolding) of the immediate anchored lines themselves — they're already drawn by `LevelOverlay`; coordinating cross-overlay emphasis is a follow-up. v1 delivers the synthesis via the chip + forming pivots.
- Round-number levels in the union (available in the book but not currently drawn).
- Any backend/detector change to the freshness-demotion rule.

## Testing
- Unit (`buildSRView.test.ts`): immediate nearest-each-side across mixed sources; anchored-only (no zones) still yields immediate R/S; pivot+anchored dedup; major = STRONG+PDH/PDL; forming pivot included, non-flipped WEAK excluded; sided distancePct signs; ltp≤0 → empty; missing OR falls back to prevOR; one-sided cases.
- Manual: GUFICBIO 15m at market open → chip shows `R …· S …` (not "no zones"); the flipped support draws as a dotted FORMING line; RELIANCE (range-bound) still shows its MEDIUM pivot zones + a sensible readout; switching off 15m hides the S/R layer.

## Success criteria
On any 15m stock chart in a moving market, the trader sees an at-a-glance "nearest resistance above (+%) / nearest support below (−%)" synthesized from all available levels, and the breakout's flipped level is visibly marked — enough to judge "is there room, where's my stop" before taking the trade. "Insufficient data" appears only when there genuinely are no candles.
