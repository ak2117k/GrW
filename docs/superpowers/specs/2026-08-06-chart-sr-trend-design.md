# Chart S/R + Trend — Always Present, Timeframe-Correct

**Date:** 2026-08-06
**Status:** Approved, ready for implementation

---

## 1. Problem

The charts page shows support/resistance only intermittently, and never on higher
timeframes. Investigation found three independent causes, only one of which is
missing computation.

### 1.1 Higher timeframes are gated off

`apps/web/src/pages/charts/ChartsPage.tsx:257`

```ts
const SR_INTRADAY = new Set(['1m', '3m', '5m', '15m', '30m', '1h']);
const showSR = SR_INTRADAY.has(timeframe);
```

`SrEvidenceService` already computes full evidence-weighted S/R for `1d`, `1w`
and `1mo` (`POSITIONAL_INTERVALS` in `timeframe-lookback.ts`), with tuned
lookbacks (900 / 1825 / 5475 days) and per-timeframe level caps (5 for
daily/weekly, 6 for monthly). The backend does the work; the frontend discards
it. This is a one-line gate, not a missing feature.

### 1.2 Loading and failure are rendered as fact

`ChartsPage.tsx:261-266` destructures only the data from its hooks:

```ts
const { zones } = useZones(...);
const { evidence } = useSrEvidence(...);
```

Both hooks expose `isLoading` and `error`; both are discarded. On failure the
hooks deliberately return `[]` and swallow the `Error`. So three states —
*still loading*, *request failed*, and *genuinely no levels* — all collapse into
an empty array, and the chip renders the same definitive-sounding
`S/R: no levels` for all three. Three independent 60s polls (`/analyze`,
`/zones`, `/sr-evidence`) with different cadences and caches means partial
arrival is the normal case on chart open.

### 1.3 The timeframe rosters disagree

The toolbar offers `1m, 5m, 15m, 1H, 4H, 1D, 1W`. The engine supports
`1m, 3m, 5m, 15m, 30m, 1h` + `1d, 1w, 1mo`. So **4H has no engine support at
all** (`isSupportedInterval('4h') === false`, and `lookbackDaysFor('4h')`
silently falls back to the 15m window), while **1mo is fully supported and not
offered**. Two hand-maintained lists drifted.

### 1.4 4H and 1W have no candle source

`TIMEFRAME_MAP` (`user-historical.util.ts:28-37`) maps only `1m…1h` and `1d`.
`getCandles` resolves `TIMEFRAME_MAP[timeframe] ?? timeframe`, so selecting `1w`
sends the literal string `"1w"` to Angel as an interval. It is not a valid Angel
interval; the call comes back `data: null`. There is no client-side aggregation.

**4H and 1W charts therefore render no candles at all.** Until the 2026-08-05
throttle fix (`487d1c9`), that `data: null` was swallowed as "no candles" with no
log, which is a large part of the reported "shows only sometimes". Angel's
maximum interval is `ONE_DAY`, so weekly and monthly can only come from
aggregation (or Yahoo, which `SrEvidenceService` already uses for its own
weekly/monthly candles).

S/R coverage on 1W/1M is worthless without candles underneath it, so this is a
prerequisite, not a follow-up.

### 1.5 Trend does not exist

There is no trend feature in the chart path. This is the only genuinely new work.

---

## 2. Goals

1. S/R is present on every timeframe the toolbar offers.
2. The chart never claims "no levels" when it is loading or broken.
3. Levels stay *analysed* — driven by the existing multi-source evidence engine,
   not by generic swing detection over visible candles.
4. A trend line, drawn from the same pivots that feed the levels.
5. The roster mismatch becomes structurally impossible, not merely fixed.

### Non-goals

- Rewriting or retuning `SrEvidenceService`'s scoring. It is good; it is simply
  not being displayed.
- A client-side candle-derived fallback layer. Explicitly rejected: it is the
  commodity behaviour every charting app has, and it would sit underneath a
  better engine.
- Changing `/analyze`, `/zones` or `/sr-evidence`. They keep their contracts for
  their other consumers.

---

## 3. Design

### 3.1 Composite endpoint

`GET /api/signals/chart-context?token=&exchange=&interval=`

Composes the three existing services behind one cache and one status.

```ts
type SourceState = 'ok' | 'empty' | 'failed';

interface ChartContextDto {
  interval: string;
  levels:   LevelBook | null;      // anchored: PDH/PDL/ORH/ORL/VWAP
  zones:    StrongZone[];
  evidence: EvidenceLevel[];
  trend:    TrendLine | null;
  status:   'ready' | 'partial' | 'unavailable';
  sources:  {
    levels:   SourceState;
    zones:    SourceState;
    evidence: SourceState;
    trend:    SourceState;
  };
}
```

`status` derivation (pure function, unit-tested):

| Condition | status |
|---|---|
| every source `failed` | `unavailable` |
| any source `failed`, at least one not | `partial` |
| no failures | `ready` |

`ready` with all sources `empty` is a legitimate "this symbol genuinely has no
levels right now" — and is now distinguishable from the other two.

Each source is composed independently and a failure in one never fails the
response. This is the property that makes "always shows something" true: an OI
wall outage degrades the evidence set, it does not blank the chart.

**Why the frontend is safe to migrate:** the charts page is the *only* frontend
consumer of all three routes (`SetupContextCard` references the `AnalysisDto`
*type* only). Backend internal consumers call the services directly, not the HTTP
routes, so this addition touches none of them.

**Caching:** one entry keyed `token:exchange:interval`. `SrEvidenceService`
already caches internally for 15 min; the composite cache is short (60s) and
exists to collapse the chart's poll, not to replace the inner caches.

### 3.2 Single-sourced timeframe roster

New in `packages/shared`:

```ts
/** Intervals the S/R engine can analyse. */
export const SR_SUPPORTED_INTERVALS = [
  '1m', '3m', '5m', '15m', '30m', '1h', '1d', '1w', '1mo',
] as const;

/** Intervals the chart toolbar offers. MUST be a subset of the above. */
export const CHART_TIMEFRAMES = [
  '1m', '5m', '15m', '1h', '1d', '1w', '1mo',
] as const;
```

`timeframe-lookback.ts` derives its sets from `SR_SUPPORTED_INTERVALS`; the
toolbar renders `CHART_TIMEFRAMES`. A test asserts the subset invariant, so a
timeframe can never again be offered without engine support.

Net roster change: **4H is dropped** (no engine support, per decision) and
**1M is added** (full engine support, previously unreachable). `3m`/`30m` remain
engine-supported but unoffered — no reason to add them now.

### 3.3 Trend line

Computed server-side, reusing `detectWeightedPivots` over the candles
`SrEvidenceService` has already fetched for this interval. No extra broker
calls, and the line is derived from the same swings as the levels, so the two
cannot disagree.

```ts
interface TrendLine {
  kind: 'uptrend' | 'downtrend';
  slope: number;          // price per second
  intercept: number;      // price at fromTime
  fromTime: number;       // unix seconds, first anchoring pivot
  touches: number;        // qualifying pivots on the line
  r2: number;             // fit quality, 0..1
}
```

Algorithm:

1. Take weighted pivots for the interval. Uptrend candidates are swing **lows**;
   downtrend candidates are swing **highs**.
2. Require at least `MIN_TOUCHES = 3` pivots.
3. Least-squares fit over `(time, price)`.
4. Reject if `r2 < MIN_R2` (0.75) — return `trend: null`.
5. Reject if the slope sign contradicts the pivot sequence.
6. If both an uptrend and a downtrend line qualify, keep the higher `r2`.

`trend: null` is a first-class, honest outcome rendered as "no clear trend".
Drawing a line through noise is worse than drawing none.

Frontend draws it as a lightweight-charts line series from `fromTime` to the
right edge, on the **compressed** time axis — it must map real times through the
chart's `realTimeMap`, exactly as candles do.

### 3.4 Frontend

- New `useChartContext(token, exchange, interval)` replaces `useChartAnalysis` +
  `useZones` + `useSrEvidence` **on the charts page only**. The three hooks stay
  for any other consumer.
- `SR_INTRADAY` is deleted. The gate becomes membership of the shared roster.
- The S/R chip renders four states:

| status | chip |
|---|---|
| loading (no response yet) | `S/R: loading…` |
| `unavailable` | `S/R: unavailable` |
| `ready`/`partial`, levels found | `▲ UPTREND · R 24,680 (+0.4%) · S 24,510 (-0.3%)` |
| `ready`, no levels | `S/R: none in range` |

`partial` appends a marker (`·  ⚠`) with the failed sources in the tooltip.
- `buildSRView` is unchanged — it already merges anchored + pivot + evidence
  candidates correctly. It gains only the trend for display.

---

## 4. Error handling

- Any single source failing yields `SourceState = 'failed'` and a `partial`
  response, never a 5xx.
- All sources failing yields `unavailable` with HTTP 200 — the chart needs to
  render the state, not catch an exception.
- The composite endpoint never throws to the client; it logs per-source failures
  server-side so a persistent outage is visible in logs rather than silently
  degrading every chart.
- Frontend: a network failure sets the hook's error and the chip shows
  `unavailable`. Stale data from a previous interval is discarded on switch (the
  existing AbortController pattern).

---

## 5. Testing

Pure functions carry the logic, so most tests need no Nest container and no DOM:

| Unit | Tests |
|---|---|
| `deriveChartContextStatus` | the full source-state truth table |
| `fitTrendLine` | slope/r² on clean data; rejection below `MIN_R2`; too few pivots; contradictory slope; uptrend-vs-downtrend tiebreak |
| roster constants | `CHART_TIMEFRAMES ⊆ SR_SUPPORTED_INTERVALS` |
| `chart-context` controller | composition, per-source degradation, one failure ≠ whole failure |
| chip state | the four states, especially never "no levels" while loading |

---

## 6. Weekly / monthly candles

Prerequisite for 1W and 1M (cause 1.4). Angel's maximum interval is `ONE_DAY`, so
weekly and monthly bars are aggregated from daily bars server-side.

New pure function in `user-historical.util.ts`:

```ts
export function aggregateCandles(daily: Candle[], bucket: 'week' | 'month'): Candle[];
```

- Bucket boundaries are **IST calendar** weeks (Monday-start) and months, not
  UTC — the same `IST_OFFSET_MS` convention `formatAngelDateTime` already uses.
- Each bucket: `open` = first bar's open, `high` = max, `low` = min,
  `close` = last bar's close, `volume` = sum, `timestamp` = bucket start.
- A partial trailing bucket (the current, unfinished week/month) IS emitted —
  the chart must show the forming bar.
- Empty input yields `[]`; buckets with no trading days are absent, not zero-filled.

`getCandles` routes `1w`/`1mo` to `ONE_DAY` with a widened lookback, then
aggregates. `TIMEFRAME_MAX_RANGE_DAYS` gains entries so the chunker sizes the
daily fetch correctly.

`4h` is **not** aggregated — it is being removed from the toolbar.

---

## 7. Delivery slices

Landed and reviewed separately:

**Slice 0 — weekly/monthly candles.** `aggregateCandles` + `getCandles` routing.
Without this, 1W and 1M charts are empty and any S/R drawn on them floats over
nothing. Fixes cause 1.4.

**Slice 1 — coverage and honest state.** Shared roster, composite endpoint
(without trend), `useChartContext`, chip states, `SR_INTRADAY` removed, toolbar
drops 4H and adds 1M. Fixes causes 1.1, 1.2 and 1.3.

**Slice 2 — trend.** `fitTrendLine`, `trend` on the DTO, the chart line series,
trend in the chip. Fixes cause 1.5.

Slices 0 and 1 are the bug fixes and must not be blocked on tuning a fitting
algorithm.
