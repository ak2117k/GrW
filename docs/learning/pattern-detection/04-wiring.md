# Lesson 04 — Wiring detections onto the chart (endpoint + markers)

**Code (backend):** `apps/api/src/modules/signal-generator/signal-generator.controller.ts`,
`.../patterns/pattern-marker.dto.ts`
**Code (frontend):** `apps/web/src/hooks/usePatterns.ts`,
`apps/web/src/components/charts/PatternOverlay.tsx`

Lessons 01–03 built *pure functions*: give them a `Candle[]`, get back detections.
Nothing was ever drawn. This lesson is the **wiring** — the plumbing that carries a
detection from a server-side function all the way to a coloured arrow on the live
chart. No new geometry; every hard part here is about **moving data across a
boundary without it losing meaning.**

## The full pipeline (lessons 01–04)

Here's how the four lessons compose into one flow:

```
  swing points (01)
        │
        ├──────────────┐
        ▼              ▼
  chart patterns   candlestick patterns
    (03)              (02)          ← both are pure detectors over Candle[]
        └──────┬───────┘
               ▼
        wiring / overlay (04)   ← endpoint → DTO → hook → translate → markers
               ▼
            pixels on the live chart
```

Lessons 01–03 answer *"what is a pattern?"*. Lesson 04 answers *"how does a pattern
become something the user can see?"* — and it turns out that innocent question hides
the single nastiest bug in the whole feature (see the Gotcha).

## Step 1 — The backend endpoint (why server-side?)

We add **one gated route** to the existing `SignalGeneratorController`:

```
GET /api/signals/patterns?token=&exchange=&timeframe=
```

What it does, in order:

1. **Gate access.** It calls the same `assertChartAccess(...)` plan-gate the other
   chart routes use. Patterns are a paid chart feature; gating lives in one place.
2. **Resolve the instrument.** `token` → symbol / exchange (the same token the chart
   is already streaming).
3. **Fetch candles.** `AngelOneAdapterService.getHistoricalData(...)` returns
   `{ timestamp, open, high, low, close, volume }[]` for the requested `timeframe`.
4. **Map to the pattern `Candle` shape.** The detectors from lessons 01–03 expect a
   `Candle` with a numeric `time`; Angel One gives a `Date` `timestamp`. So we map
   `time = timestamp.getTime()` (epoch **milliseconds**) and copy O/H/L/C across.
5. **Run the detectors.** `findCandlestickPatterns(candles)` +
   `findChartPatterns(candles)` — the exact entry points lessons 02 and 03 ended on.
6. **Return markers** as `PatternMarkerDto[]`.

**Why do this on the server and not in the browser?** Three reasons:

- **Reuse the gate.** `assertChartAccess` already lives here; re-implementing plan
  logic in the client would be both duplicated and trivially bypassable.
- **It's the ML hook point.** Lesson 05 hangs the labelling pipeline off *this exact
  endpoint* — every detection it computes gets logged server-side with what price did
  next. If detection ran in the browser, there'd be nothing to log.
- **One source of truth.** The candles the detector sees come straight from Angel
  One, not from whatever the chart happens to have buffered.

## Step 2 — The DTO contract (and why timestamps, not indices)

The detectors speak in **array indices** (`index: number`). The wire cannot. Here's
the contract that crosses it:

```ts
interface PatternMarkerDto {
  category:  'CANDLESTICK' | 'CHART';
  name:      string;          // 'BULLISH_ENGULFING' | 'DOUBLE_TOP' | ...
  bias:      'BULLISH' | 'BEARISH' | 'NEUTRAL';
  time:      number;          // epoch ms of the ANCHOR candle
  points:    number[];        // CHART only: [firstPeakMs, secondPeakMs]. else []
  necklinePrice: number | null;   // CHART double top/bottom only
  confirmed:     boolean | null;  // from lesson 03's confirmation; null for candles
  confirmTime:   number | null;   // epoch ms of the breakout candle, or null
}
```

Field by field:

- **`category`** — which detector family produced it. Drives *how* it's drawn
  (single arrow vs. two peaks + a neckline).
- **`name` / `bias`** — straight off the pattern object. `bias` picks the colour and
  arrow direction.
- **`time`** — the anchor. For a candlestick it's the pattern candle; for a chart
  pattern it's a representative candle (the second peak).
- **`points`** — for chart patterns, the two peak times so the overlay can mark
  *both* shoulders, not just one anchor.
- **`necklinePrice`** — the horizontal breakout level (lesson 03). `null` for
  candlesticks, which have no neckline.
- **`confirmed` / `confirmTime`** — lesson 03's confirmation verdict, carried across
  so the UI can draw confirmed patterns solid and forming ones dashed.

### The load-bearing conversion: `index → timestamp`

This is the teaching point of the whole DTO. Lesson 01's detector returns
`swing.index = 7`; lesson 03's returns `confirmIndex = 42`. **An index is only
meaningful paired with the exact array it indexes.** The backend's candle array and
the browser's candle array are *different arrays* — different lengths, different
start points, different amounts of history buffered. Index `7` on the server is not
index `7` in the browser.

So before anything leaves the server, we resolve every index against the candles it
was computed on:

```ts
time        = candles[pattern.index].time;        // ms
firstPeakMs = candles[pattern.first.index].time;
confirmTime = confirmIndex === null ? null : candles[confirmIndex].time;
```

**Indices are local; timestamps are universal.** A timestamp identifies a candle by
*when it happened*, which is true on any machine, in any array, forever. That's why
the contract is entirely in epoch-ms and carries not a single array index.

## Step 3 — THE GOTCHA: the compressed time axis ⚠️

You now have DTOs full of correct real-world timestamps. You'd think the overlay just
does `series.setMarkers([{ time: dto.time, ... }])` and you're done.

**It is not done. This is where a naive implementation silently misfires.**

Our TradingView Lightweight Charts wrapper does **not** plot candles on real time. To
avoid ugly blank gaps over nights, weekends, and holidays, it runs a `compressTimes()`
pass at load: it rewrites every candle's `time` to a **gap-collapsed synthetic
value** (bar 0, bar 1, bar 2, … with no holes) and stashes a lookup so it can still
label axes with the truth:

```ts
realTimeMap: Map<compressedTime, realUnixSeconds>
```

So the series lives in **compressed time**, but your DTO's `time` is in **real
time**. Hand a real timestamp to a chart that thinks in compressed time and the
marker lands wherever that real value happens to fall on the synthetic axis — which
is almost never where the candle is, and often in **blank space off the plotted
range**.

### Before / after — why real-time placement misfires

Say Friday is bar 100 and Monday is bar 101 (the weekend is collapsed to nothing).
Their real timestamps are ~3 days apart; their compressed times are adjacent.

```
REAL axis (what the DTO carries):
  Fri ●───────────────(empty weekend)───────────────● Mon
      t=1000                                          t=1259  (kiloseconds, say)

COMPRESSED axis (what the series is actually drawn on):
  Fri ●● Mon                     ← weekend gap removed, bars adjacent
     100 101

Naive: setMarkers(time = 1259)  → lands 158 units to the RIGHT of bar 101,
                                   in empty space. Marker invisible / wrong bar.
Fixed: 1259 → realTimeMap → compressed 101 → marker sits exactly on Monday. ✓
```

### The fix — translate before you place

The overlay **inverts** `realTimeMap` (build a `real → compressed` map once) and
translates *every* timestamp in the DTO — `time`, both `points`, and `confirmTime` —
into compressed time **before** calling `setMarkers` or `createPriceLine`. Any
pattern whose timestamp falls **outside the currently displayed window** (not in the
map) is simply **dropped** — you can't place a marker on a bar that isn't on screen.

Draw the analogy you've now seen twice:

> A swing high isn't real until `strength` bars **confirm** it (lesson 01). A double
> top isn't a signal until price **confirms** the neckline break (lesson 03). And a
> marker isn't placeable until its timestamp is **translated** onto the compressed
> axis (lesson 04). *In each case the raw thing exists, but it isn't usable until an
> extra step ratifies it.* Confirmation, confirmation, translation — same shape of
> idea.

## Step 4 — Drawing the overlay

Once every timestamp is translated, drawing is mechanical.

**Anchor arrows** (all candlestick patterns; the anchor of a chart pattern):

| bias      | marker            | position   | colour |
|-----------|-------------------|------------|--------|
| `BULLISH` | `arrowUp`         | `belowBar` | green  |
| `BEARISH` | `arrowDown`       | `aboveBar` | red    |
| `NEUTRAL` | neutral dot/arrow | `aboveBar` | grey   |

(A doji is `NEUTRAL` — indecision, no direction, so no green/red bet.)

**Double top / bottom** get more than one mark:

- A marker at **each** peak (that's what `points: [firstPeakMs, secondPeakMs]` is
  for — both translated).
- A dashed **price line** for the neckline:
  `series.createPriceLine({ price: necklinePrice, lineStyle: dashed, ... })`.
  This is a horizontal level, so it needs a *price*, not a time — it isn't affected
  by the compressed axis at all.

### Two lightweight-charts constraints the code must respect

1. **`setMarkers` REPLACES the entire marker set.** It is not additive. So you cannot
   loop and call it per pattern — the last call would wipe all the others. You
   **collect every marker into one array and call `setMarkers(all)` exactly once.**
2. **Markers must be SORTED by time ascending.** Lightweight Charts requires it and
   will misrender (or throw) otherwise. After translation, sort the combined array by
   compressed `time` before the single `setMarkers` call.

Price lines are **tracked** in a ref array as they're created, so cleanup (toggle
off, symbol change, unmount) can call `series.removePriceLine(line)` on each and
`setMarkers([])` to clear arrows. Leak these and old necklines pile up on the chart.

## Step 5 — Toggle + data flow

The feature is **off by default** — a **"Patterns"** toggle in the chart toolbar,
mirroring the existing zones control. Flipping it on enables a hook:

```ts
usePatterns(token, timeframe, exchange)   // mirrors useZones(...)
```

`usePatterns` fetches `GET /api/signals/patterns?...`, returns
`PatternMarkerDto[]`, and re-fetches when token / timeframe / exchange change. Its
output feeds `<PatternOverlay>`, which owns the translate → sort → `setMarkers` /
`createPriceLine` logic from Steps 3–4.

End to end, in one arrow chain:

```
Angel One candles
  → detectors (server, lessons 02+03)
  → PatternMarkerDto[]  (indices resolved to real timestamps)
  → usePatterns hook  (over the wire to the browser)
  → real→compressed translation  (the gotcha fix)
  → setMarkers([...]) / createPriceLine(...)   (one sorted batch)
  → pixels on the live chart
```

## Gotchas

1. **The compressed time axis (the star, above).** Placing a marker at its real
   timestamp puts it in the wrong place or in blank space. You **must** invert
   `realTimeMap` and translate `time` / `points` / `confirmTime` into compressed time
   first, and drop any pattern outside the displayed window. If markers appear
   shifted, clumped at the right edge, or missing, this translation is why.

2. **`getHistoricalData` returns `[]` on throttle.** Angel One rate-limits (the
   10 req/sec ceiling from the safety rules). When throttled the adapter yields an
   **empty array**, so the detectors run over zero candles and legitimately find
   nothing. A too-short candle array likewise yields no patterns — a double top needs
   enough bars to contain two swing highs plus the `strength` confirmation window
   (lesson 01). "No patterns" often means "not enough candles," not "detector broken."

3. **Markers must be time-sorted and set in one shot.** `setMarkers` replaces, not
   appends, and requires ascending time order. Collect all markers (candlestick +
   both chart peaks), translate them, sort by compressed time, then call `setMarkers`
   **once**. A per-pattern loop or an unsorted array is the second-most-common wiring
   bug after the compressed axis.

4. **Necklines are prices, not times.** `createPriceLine` takes a `price`, so the
   compressed-axis translation doesn't touch it — but it *does* need tracking and
   explicit removal on cleanup, or stale horizontal lines accumulate.

## Next

Lesson 05 turns this plumbing into a **training set**. Now that every detection flows
through one server endpoint, we log each one with **what price did next** — its
maximum favourable and adverse excursion (MFE / MAE from the vocabulary list). That
labels each rule hit as "worked" or "didn't," which is exactly the fuel the XGBoost
model in `ai-engine/` needs to *score* detections. Rules produced the labels; the ML
layer learns to rank them — the final step of the big-picture arc from the README.
