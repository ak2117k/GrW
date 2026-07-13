# Lesson 02 — Candlestick patterns (single & double bars)

**Code:** `apps/api/src/modules/signal-generator/patterns/candlestick.ts`
**Tests:** `candlestick.spec.ts`

Lesson 01 was about the *shape of the trend* (swing points across many bars). This
lesson zooms all the way in: candlestick patterns read **1–2 candles** of raw OHLC.
No swings needed — just the geometry of the bars themselves.

## The building blocks

Every predicate below is written in terms of four numbers we derive from one
candle. Learn these first; the whole lesson is just combinations of them.

```
        high ─┬─        │  ← upperWick = high − max(open, close)
              │         │
            ┌─┴─┐  ─┬─  │
            │   │   │   │  ← body  = |close − open|   (the thick part)
            │   │   │   │
            └─┬─┘  ─┴─  │  ← range = high − low       (full extent)
              │         │
         low ─┴─        │  ← lowerWick = min(open, close) − low
```

In the code these are tiny helpers over a `Candle` (same shape as lesson 01):

```ts
body      = Math.abs(c.close - c.open);
range     = c.high - c.low;
upperWick = c.high - Math.max(c.open, c.close);
lowerWick = Math.min(c.open, c.close) - c.low;
isBullish = c.close > c.open;   // green: closed up
isBearish = c.close < c.open;   // red: closed down
```

Note `body + upperWick + lowerWick === range` always — the three pieces tile the
whole bar. Every pattern is a statement about their *relative sizes* or the
relationship between two neighbouring candles.

## Pattern family 1 — Engulfing (2 candles)

```
   bearish then bullish        bullish then bearish
        │                           ┌─┐
      ┌─┴┐   ┌───┐                  │ │   ┌─┴┐
      │  │   │   │   ← curr         └─┬┘   │  │  ← curr swallows prev
      └──┘   │   │                    │    │  │
        prev └─┬─┘                  prev   └──┘
      BULLISH_ENGULFING           BEARISH_ENGULFING
```

**Intuition:** the second candle completely *swallows* the first and closes the
opposite way with a **bigger** body. The prior move got overwhelmed in a single
bar — momentum flipped.

**BULLISH_ENGULFING** — `prev` is bearish, `curr` is bullish, and `curr`'s body
covers `prev`'s body:

```ts
prev is bearish  &&  curr is bullish
&& curr.close >= prev.open   // curr top   ≥ prev body top
&& curr.open  <= prev.close  // curr bottom ≤ prev body bottom
&& body(curr) > body(prev)   // and it's genuinely bigger
```

Worked example: `prev = O 102 / C 100` (bearish, body 2). `curr = O 99.5 /
C 103` (bullish, body 3.5). Check: `103 ≥ 102` ✓, `99.5 ≤ 100` ✓, `3.5 > 2` ✓ →
**BULLISH_ENGULFING**, bias `BULLISH`.

**BEARISH_ENGULFING** is the exact mirror: `prev` bullish, `curr` bearish,
`curr.open ≥ prev.close`, `curr.close ≤ prev.open`, `body(curr) > body(prev)`.

Both live in `detectEngulfing(prev, curr, index)`, which returns a
`CandlestickPattern` or `null`. No tolerance knob here — engulfing is defined by
strict body-covering, so it's the one pattern that's purely comparative.

## Pattern family 2 — Hammer & Shooting star (1 candle)

```
      ┌─┐          long upper wick
      │ │  body        │
      └─┘          ┌─┐ │
       │           │ │ body
       │  long     └─┘
       │  lower      HAMMER      SHOOTING_STAR
      wick        (bullish)      (bearish)
```

**Intuition:** a small real body sitting at one end of the range, with ONE long
wick. A **hammer** has a long *lower* wick — price sold off hard, then buyers
dragged it back up by the close: lower prices were *rejected*. A **shooting star**
is the mirror with a long *upper* wick — a rally was rejected by sellers.

**HAMMER** (bias `BULLISH`):

```ts
lowerWick >= wickBodyRatio         * body   // long lower wick (default 2× body)
&& upperWick <= oppositeWickBodyRatio * body // short upper wick (default 1× body)
```

Worked example: `O 100 / H 100.5 / L 96 / C 101` → body `1`, lowerWick
`min(100,101) − 96 = 4`, upperWick `101 → 100.5`... wait, `high` must be the max, so
take `H 101.3`: upperWick `101.3 − 101 = 0.3`. Check: `4 ≥ 2×1` ✓ and
`0.3 ≤ 1×1` ✓ → **HAMMER**.

**SHOOTING_STAR** (bias `BEARISH`) is the mirror — swap the roles of the wicks:

```ts
upperWick >= wickBodyRatio         * body   // long upper wick
&& lowerWick <= oppositeWickBodyRatio * body // short lower wick
```

Both live in `detectHammerOrStar(c, index, opts)`. Two knobs:
`wickBodyRatio` (default **2**) sets how long the signature wick must be relative
to the body; `oppositeWickBodyRatio` (default **1**) caps the *other* wick so the
body really is pinned to one end.

## Pattern family 3 — Doji (1 candle)

```
        │
      ──┼──   open ≈ close  → almost no body
        │
      DOJI (neutral)
```

**Intuition:** open and close are almost equal — the bar is nearly all wick. The
session opened and closed at the same place: **indecision**, a tug-of-war with no
winner.

**DOJI** (bias `NEUTRAL`):

```ts
body <= dojiBodyRatio * range   // body is a tiny fraction of the full range
```

Worked example: `O 200 / H 203 / L 197 / C 200.2` → body `0.2`, range `6`.
`0.2 ≤ 0.1 × 6 = 0.6` ✓ → **DOJI**. If instead `C 201` (body `1`), then
`1 ≤ 0.6` ✗ → not a doji, it has a real body.

Lives in `detectDoji(c, index, opts)`. One knob: `dojiBodyRatio` (default **0.1**
= body must be ≤ 10% of range).

## The API surface

```ts
type Bias = 'BULLISH' | 'BEARISH' | 'NEUTRAL';

interface CandlestickPattern {
  name: string;    // 'BULLISH_ENGULFING' | 'HAMMER' | 'DOJI' | ...
  index: number;   // index of the (last) candle in the pattern
  time: number;    // that candle's time
  bias: Bias;
}

interface CandlestickOptions {
  dojiBodyRatio?: number;         // default 0.1
  wickBodyRatio?: number;         // default 2
  oppositeWickBodyRatio?: number; // default 1
}
```

The three `detect*` functions each check one family and return
`CandlestickPattern | null`. The orchestrator `findCandlestickPatterns(candles,
opts)` walks the array once, calling `detectEngulfing(prev, curr, i)` from `i = 1`
and the two single-candle detectors on each `c`, and collects every hit.

## Tolerances = the knobs

Notice the pattern: `0.1`, `2`, `1` are not laws of nature — they're **defaults**,
exactly like the [[strength]] knob from lesson 01. Tighten `dojiBodyRatio` to
`0.05` and only near-perfect crosses count; loosen `wickBodyRatio` to `1.5` and
stubbier hammers qualify. Each knob trades *sensitivity vs precision*.

We ship sensible defaults so the detector works today, but we don't pretend they're
optimal. In **Phase 3**, the ML layer (lesson 05) will *learn* these thresholds
from labeled outcomes — "hammers with `wickBodyRatio ≥ 2.4` after a downtrend
actually reversed 68% of the time" — instead of us guessing. The rule engine's job
is to expose the knobs; the model's job is to tune them.

## Gotchas

1. **A candle in isolation is a weak signal.** These predicates only describe
   *shape* — they know nothing about *where* the candle sits. A hammer only means
   "reversal" **after a downtrend**; the identical shape mid-rally is just a bar
   with a long lower wick. The trend context comes from lesson 01's swing points —
   lesson 03 onward we combine them (e.g. "hammer *at* a swing low"). Treat a bare
   candlestick hit as a hint, never a trade.

2. **Doji and hammer are near-mutually-exclusive.** A hammer *requires* a real body
   (the wick is measured as a multiple of `body`), while a doji requires an almost
   *absent* body. As `body → 0`, `wickBodyRatio × body → 0` too, so the hammer test
   degenerates and the doji test fires instead. A bar is one or the other, not both
   — which is correct: a body-less bar is indecision, not rejection.

3. **`body = 0` edge case.** A four-price-equal bar (`O=H=L=C`) has `body 0` and
   `range 0`; the doji test `0 ≤ 0.1 × 0` is `0 ≤ 0` → true (a valid doji), while
   the wick ratios are `0 ≥ 0` — the `oppositeWickBodyRatio` cap keeps these from
   masquerading as hammers. Worth knowing the detectors don't divide by `body`, so
   there's no NaN.

## Next
Lesson 03 comes back to the swing points from lesson 01 and uses them to build the
first real *chart* pattern: **Double Top / Double Bottom** — two swings at ~equal
price with a pivot between them.
