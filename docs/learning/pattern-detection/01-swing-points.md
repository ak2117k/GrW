# Lesson 01 — Swing points (the keystone)

**Code:** `apps/api/src/modules/signal-generator/patterns/swing-points.ts`
**Tests:** `swing-points.spec.ts`

## What is a swing point?

Look at any chart. Price doesn't move in a straight line — it makes little peaks
and valleys. A **swing high** is a peak: a candle that stuck out *above* its
neighbours. A **swing low** is a valley: a candle that dipped *below* its
neighbours.

```
        ●  ← swing high (index 2)
       / \
   ●  /   \   ●
    \/     \ / \
     ●      ●   ...
     ↑
  swing low
```

That's it. Humans spot these instantly. Our job is to define "stuck out" precisely
enough for a computer.

## The precise rule

A candle at index `i` is a **swing high** when its `high` is **strictly greater**
than the `high` of the `strength` candles on **each** side:

```
for every neighbour j in [i-strength, i+strength], j ≠ i:
      candles[j].high  <  candles[i].high
```

Swing low is the mirror (lows, `>`). Three design choices worth understanding:

1. **`strength` (a.k.a. lookback / left-right bars).** How many candles on each
   side the pivot must beat.
   - `strength = 1` → tons of tiny pivots (noisy).
   - `strength = 5` → only big, significant peaks (but you find them *late*, since
     you must wait 5 candles after the peak to confirm it).
   - It's the single knob that trades **sensitivity vs significance**. (Test:
     *"bigger strength ⇒ fewer, more significant pivots"* — strength 1 finds 3
     peaks, strength 2 finds 1.)

2. **Strict `<` (not `≤`).** If several candles share the same high (a flat top),
   *none* of them qualifies. Why? Otherwise a plateau would register a pivot on
   every bar. Strict comparison means "must be the *unique* highest." (Test:
   *"a flat top produces NO pivot"*.)

3. **Edges are skipped.** The first and last `strength` candles don't have a full
   window on one side, so they can never be confirmed. (Test: *"never marks the
   first/last `strength` candles"* — tall bars at the very edges are ignored.)

## Why this is the keystone

Candlestick patterns look at 1–3 bars, so they don't need this. But **every**
*chart* pattern is just a geometric relationship between swing points:

| Pattern | In terms of swings |
|---|---|
| Double top | two swing **highs** at ~equal price, with a swing low between |
| Double bottom | two swing **lows** at ~equal price, with a swing high between |
| Head & shoulders | high – higher high – high (three swing highs, middle tallest) |
| Higher-high/higher-low uptrend | successive swing highs and lows both rising |
| Trend line | a straight line through 2+ swing lows (or highs) |

So once you have a reliable list of swings, those patterns become "compare a few
numbers." Learn this one primitive and most of chart-pattern detection is
downstream of it.

## The algorithm (walk the code)

```ts
for (let i = strength; i < candles.length - strength; i++) {   // skip the edges
  let isHigh = true, isLow = true;
  for (let j = i - strength; j <= i + strength; j++) {          // scan the window
    if (j === i) continue;
    if (candles[j].high >= c.high) isHigh = false;              // any ≥ kills HIGH
    if (candles[j].low  <= c.low)  isLow  = false;              // any ≤ kills LOW
    if (!isHigh && !isLow) break;                               // early exit
  }
  if (isHigh) push HIGH; if (isLow) push LOW;
}
```

- It's **O(n · strength)** — one pass, a small window each step. Fast enough to run
  on every candle update.
- A candle can be **both** a swing high and a swing low — an "outside bar" that has
  the highest high *and* the lowest low of its window. (Test:
  *"BOTH the highest high and lowest low"*.) That's not a bug; it's real.

## The one gotcha: confirmation lag

A swing high at index `i` can only be *confirmed* once `strength` more candles have
closed after it. So on a **live** chart, the most recent `strength` candles are
always "unconfirmed" — a peak might still be forming. When we draw pivots live,
we'll mark the last `strength` bars as provisional. This lag is the price of
`strength`: more significance, later confirmation.

## Next
Lesson 02 uses raw candle geometry (no swings needed) for candlestick patterns,
then Lesson 03 comes back to these swings to build double top/bottom.
