# Lesson 03 — Chart patterns (Double Top / Double Bottom)

**Code:** `apps/api/src/modules/signal-generator/patterns/chart-patterns.ts`
**Tests:** `chart-patterns.spec.ts`

This is the payoff lesson. Lesson 01 built swing points but never *used* them for a
pattern; lesson 02 read raw candles but stayed blind to the trend. Here the two
threads join: a **chart pattern** is a geometric relationship between swing points,
plus one genuinely new idea — **confirmation**, the moment the market agrees the
shape is real.

## Why this needs swing points

A double top is not a vague "M shape you eyeball." It has a precise definition, and
that definition is written entirely in the vocabulary of [[swing-points]]:

> two swing **HIGHs** at ~equal price, with a swing **LOW** (the *neckline*)
> between them.

```
        ●              ●          ← two swing HIGHs (first, second) at ~equal price
       / \            / \
      /   \          /   \
     /     \        /     \
    /       \      /       \
   /         \    /         \
  /           ●──●           \    ← the neckline = lowest swing LOW between the peaks
 /            necklinePrice   \
                               ▼
                         breakdown: a candle CLOSES below necklinePrice → confirmed
```

Every ingredient — `first`, `second`, `neckline` — is a `SwingPoint` straight out
of lesson 01. Without a reliable swing list you cannot even *state* the pattern; with
one, detection collapses to "compare a few numbers." That's why swing points were the
keystone: this lesson is downstream of it.

## The detection rule, precisely

`findDoubleTops(candles, opts)` walks the swing list the same way lesson 01's
detector walks candles:

1. Compute `swingHighs(candles, strength)` and `swingLows(candles, strength)`.
2. For each **consecutive pair** of swing highs `(first, second)`:
   - The **neckline** is the *lowest* swing low whose index sits strictly between
     `first.index` and `second.index`. (No swing low in the gap → no pattern; the two
     peaks aren't separated by a real valley.)
   - Then run **two tolerance tests**. Both must pass.

### Test 1 — Equal-height

The two peaks must be at roughly the same price:

```
|first.price − second.price| / first.price  <=  priceTolerance   (default 0.02)
```

Worked example: peaks **101** and **99.5** → `|101 − 99.5| / 101 = 1.5 / 101 =
0.0149` ≈ **1.5%** ≤ 2% → **passes**. Peaks **101** and **96** → `5 / 101 = 0.0495`
≈ **4.95%** > 2% → **fails** (that's not a double top, the second peak is a lower
high — a different pattern entirely).

### Test 2 — Depth

The dip to the neckline must be deep enough to be tradeable — a double top that's
barely a wiggle is just noise:

```
(min(first.price, second.price) − neckline.price) / neckline.price  >=  minDepthRatio
                                                                         (default 0.03)
```

Worked example: peaks **101 / 99.5**, neckline **96** → `(min(101,99.5) − 96) / 96 =
(99.5 − 96) / 96 = 3.5 / 96 = 0.0365` ≈ **3.65%** ≥ 3% → **passes**. If the neckline
were **98** instead → `(99.5 − 98) / 98 = 1.5 / 98 = 0.0153` ≈ **1.53%** < 3% →
**fails**: the peaks are equal, but the valley between them is too shallow to trade.

Note we measure depth from the **lower** of the two peaks (`min`), so a pattern only
counts as deep if *both* shoulders clear the neckline by the required margin.

## Confirmation — the new concept

A shape passing both tests is a *candidate*, not yet a *signal*. The pattern becomes
**actionable** only when price **closes beyond the neckline after the second peak** —
for a double top, a candle whose `close < necklinePrice` (a **breakdown**):

```
for i from (second.index + 1) to end:
    if candles[i].close < necklinePrice:
        confirmed = true; confirmIndex = i; break
```

`ChartPattern` carries both the geometry and this verdict:

- `confirmed: boolean` — did a post-peak candle close through the neckline?
- `confirmIndex: number | null` — the index of that breakout candle (or `null`).

This is the exact same idea as lesson 01's **confirmation lag**: there, a swing high
wasn't *real* until `strength` more candles closed after it; here, a double top isn't
a *trigger* until a candle closes through the neckline. In both cases the shape exists
before the market ratifies it — **a shape is not a signal until price agrees.**

Crucially, an **unconfirmed** double top is still returned (`confirmed: false`,
`confirmIndex: null`). It's a *forming* pattern — something to watch and pre-stage an
order against, not yet a fill. The UI (lesson 04) will draw confirmed patterns solid
and forming ones dashed. Detection reports the shape; confirmation reports the timing.

## Double Bottom — the vertical mirror

Flip every comparison and you have `findDoubleBottoms`:

```
        ●──●           necklinePrice          ← neckline = HIGHEST swing HIGH between
       /    \                                    the two lows
      /      \        /      \
     /        \      /        \
    /          \    /          \
   ●            \  /            ●   ← two swing LOWs at ~equal price
   first         \/          second
                                    ▲
                        breakout: a candle CLOSES ABOVE necklinePrice → confirmed
```

- Two swing **LOWs** at ~equal price; neckline is the **highest** swing high between.
- **Equal-height:** `|first.price − second.price| / first.price <= priceTolerance`.
- **Depth:** `(neckline.price − max(first.price, second.price)) / neckline.price >=
  minDepthRatio` — measured from the *higher* of the two troughs up to the neckline.
- **Confirmation:** a candle with `close > necklinePrice` (a breakout upward).
- `bias: 'BULLISH'` (a double top is `'BEARISH'`).

`findChartPatterns(candles, opts)` simply runs both detectors and concatenates the
results — the one entry point lesson 04 calls.

## The API surface

```ts
type ChartPatternName = 'DOUBLE_TOP' | 'DOUBLE_BOTTOM';
type ChartBias        = 'BULLISH' | 'BEARISH';

interface ChartPattern {
  name: ChartPatternName;
  bias: ChartBias;
  first: SwingPoint;         // the first peak (top) or trough (bottom)  — from lesson 01
  second: SwingPoint;        // the second peak / trough
  neckline: SwingPoint;      // the swing between them (low for tops, high for bottoms)
  necklinePrice: number;     // = neckline.price, the breakout level to watch
  confirmed: boolean;        // has price closed through the neckline?
  confirmIndex: number | null; // index of the breakout candle, or null
}

interface ChartPatternOptions {
  strength?: number;        // swing lookback (lesson 01). default 3
  priceTolerance?: number;  // equal-height test. default 0.02  (2%)
  minDepthRatio?: number;   // depth test.        default 0.03  (3%)
}
```

`findDoubleTops`, `findDoubleBottoms`, and `findChartPatterns` all take
`(candles, opts?)` and return `ChartPattern[]`.

## Tolerances = the knobs (again)

Same theme as lessons 01–02: `strength = 3`, `priceTolerance = 0.02`,
`minDepthRatio = 0.03` are **defaults, not laws**. Tighten `priceTolerance` to `0.01`
and only near-identical peaks qualify; loosen `minDepthRatio` to `0.02` and shallower
Ms count. We ship sensible values so the detector works today, and in **Phase 3** the
ML layer (lesson 05) *learns* them from labeled outcomes — "double tops confirmed with
a neckline break ≥ 3.5% deep fell another 4% within five bars 71% of the time" —
instead of us guessing. The rule engine's job is to expose the knobs; the model tunes them.

## Gotchas

1. **The two tolerances are in tension.** `priceTolerance` controls *how equal* the
   peaks must be; `minDepthRatio` controls *how deep* the valley is. Loosen
   `priceTolerance` and you catch more "tops," but many are ragged noise; tighten it
   and you miss real tops whose peaks differ by, say, 2.5%. There's no single right
   value — it's the sensitivity-vs-precision trade you've now met three times.

2. **`strength` silently controls how many patterns even exist.** A double top is
   built from swing highs, and [[swing-points]]' `strength` decides how many swing
   highs there *are*. Too small (`strength = 1`) and every micro-wiggle is a "peak", so
   the detector invents double-tops out of noise; too large (`strength = 6`) and you
   have too few pivots to ever form a pair, so real tops go unfound. `strength` isn't a
   detail of lesson 01 you can forget — it upstream-gates everything here.

3. **Head-and-shoulders and triple tops are the same machinery with more peaks.** A
   double top pairs two consecutive swing highs; head-and-shoulders is *three* swing
   highs with the middle one tallest (high – higher high – high); a triple top is three
   at ~equal price. Same swing list, same neckline-and-confirmation logic, one more
   peak in the window. Once double top clicks, those are incremental — a tease for the
   lesson roadmap.

## Next

Lesson 04 wires **all** the detections — candlestick (lesson 02) *and* chart patterns
(this lesson) — onto the live chart: a new API endpoint that runs the detectors on the
current candle series and returns markers, rendered as TradingView annotations on the
front end.
