# Lesson 02 — Features & the ATR-follow-through label

**Code:** `apps/api/src/modules/signal-generator/ml/follow-through.ts` ·
`ml/observation-assembler.ts` · `ml/pattern-observation.types.ts`
**Tests:** `follow-through.spec.ts` · `observation-assembler.spec.ts`

Lesson 01 said a supervised model needs **features** (what we knew) and a **label**
(what happened). This lesson makes both concrete, because both are decisions —
and both are places where a plausible-looking choice quietly ruins the dataset.

## Features vs label — the only distinction that matters

Everything in an observation is one or the other, and the difference is **time**:

```
              ANCHOR BAR (detection)
                     │
   ◄─── FEATURES ────┤──── LABEL ────►
      bars ≤ t       │     bars > t
   "what we knew"    │  "what happened"
                     │
   the model SEES ───┘└─── the model must PREDICT
```

- **Features** — computed from bars **up to and including** the anchor. This is the
  model's input at score time, so it can only contain things that were knowable
  *then*.
- **Label** — computed from bars **after** the anchor. This is the answer key. It
  deliberately reads the future, because measuring what happened *is* reading the
  future — from the anchor's point of view.

Both halves touch the same candle array. The whole trick is that they touch
**disjoint slices** of it. Hold that thought; the section on lookahead is where it
gets teeth.

## Choosing a label: three bad answers first

We have to turn "did the pattern work?" into a number. The obvious candidates all
break, and seeing *how* is what motivates the real one.

**Bad answer 1 — "was close[t+10] higher than close[t]?"** Endpoint-only. It can't
tell the difference between a clean +3% run and a −5% crash that limped back to
+0.1% by bar 10. Those are opposite trades with the same label. You'd be teaching
the model that getting stopped out and then recovering is a *win*.

**Bad answer 2 — "did price move +1%?"** Fixed percentages ignore volatility. On a
sleepy 5m NIFTY bar, 1% is a moonshot; on CRUDEOIL mid-news, it's noise. The same
threshold means "extraordinary" on one instrument and "nothing happened" on
another. Labels stop being comparable, and the model learns the instrument rather
than the pattern.

**Bad answer 3 — "did it move +1% within 30 minutes?"** Wall-clock horizons don't
survive timeframes. Thirty minutes is 30 bars on 1m and *less than one bar* on 1h.
The same rule is a hair-trigger on one timeframe and a no-op on another.

Each failure points at a fix, and stacking all three gives the label we use.

## The ATR-follow-through label

> From the anchor bar's close, does price reach **`k × ATR` in the pattern's
> direction** *before* it drops **`m × ATR` against it**, within **`n` bars**?

```
   favorable = entry + dir·k·ATR   ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─   ← hit first → WIN (1)
                                        ╱╲    ╱
   entry = close[anchor] ══════════════╱══╲══╱══════════
                                      ╱    ╲╱
   adverse   = entry − dir·m·ATR  ─ ─╱─ ─ ─ ─ ─ ─ ─ ─ ─   ← hit first → LOSS (0)

                     └────────── n bars ──────────┘
                            neither → TIMEOUT
```

It fixes all three failures at once:

| Property | What it buys | Kills bad answer |
|---|---|---|
| **Path-aware** | checks *which level is touched first*, bar by bar — not the endpoint | 1 |
| **ATR-normalized** | distances in volatility units, not rupees or percent | 2 |
| **Horizon in bars** | `n` counts bars, so it scales with the timeframe | 3 |

The defaults are real, and they're in `pattern-observation.types.ts`:

```ts
/** ATR-follow-through label parameters. */
export interface FollowThroughParams {
  /** favorable move required, in ATR multiples. */
  k: number;
  /** adverse move that fails the pattern, in ATR multiples. */
  m: number;
  /** horizon in bars. */
  n: number;
}

export const DEFAULT_FT_PARAMS: FollowThroughParams = { k: 1.5, m: 1.0, n: 10 };
```

`k = 1.5`, `m = 1.0`, `n = 10`. Note `k > m` — this is a **1.5:1 reward:risk**
question, not "which way did it drift." We're not asking whether price wandered
favorably; we're asking whether it delivered a move worth taking, before it took
back a move worth respecting. And like the `strength` and `wickBodyRatio` knobs
from the pattern-detection course, these are **defaults, not laws** — the same
`FollowThroughParams` can be passed explicitly.

### Why ATR is the right yardstick

ATR (Average True Range) is the average size of a bar, so it's the natural unit of
"a normal move *here, now*." `computeAtrFromCandles` (`services/per-tf-atr.ts`,
reused — not reinvented) gives us Wilder-smoothed ATR from a candle array.

Expressing targets in ATR multiples makes labels **comparable across instruments
and volatility regimes**: `1.5 × ATR` means the same *thing* — "one and a half
times a normal move" — on quiet NIFTY 5m and on frantic CRUDEOIL 1m, even though
the rupee distances differ by orders of magnitude. That's what lets one model learn
from all of them at once.

### Why the horizon self-normalizes

`n = 10` is ten **bars**, which is 10 minutes on 1m and 10 *days* on 1d. Combined
with per-timeframe ATR, the label definition needs **no per-timeframe tuning** — it
rescales itself in both axes (spec §4.1):

| Timeframe | `n = 10` means | `k × ATR` scaled by |
|---|---|---|
| 1m | 10 minutes | that timeframe's ATR |
| 15m | 2.5 hours | that timeframe's ATR |
| 1d | 10 trading days | that timeframe's ATR |

Supported timeframes are the Angel-native set — **`1m, 3m, 5m, 10m, 15m, 30m, 1h,
1d`** (see the `timeframe` comment in the `PatternObservation` model). 4h and 1w
need timeframe aggregation that doesn't exist yet; they join later.

## The resolver, line by line

Here is `resolveFollowThrough` in full (`ml/follow-through.ts`) — it's short enough
to read whole, and every line is a decision:

```ts
export function resolveFollowThrough(
  candles: OhlcvCandle[],
  index: number,
  dir: 1 | -1,
  atrAtDetection: number,
  params: FollowThroughParams = DEFAULT_FT_PARAMS,
): FollowThroughResult {
  const entry = candles[index].close;
  const favorable = entry + dir * params.k * atrAtDetection;
  const adverse = entry - dir * params.m * atrAtDetection;

  const last = candles.length - 1;
  const horizonEnd = index + params.n;
  const scanEnd = Math.min(horizonEnd, last);

  for (let i = index + 1; i <= scanEnd; i++) {
    const c = candles[i];
    const hitFav = dir === 1 ? c.high >= favorable : c.low <= favorable;
    const hitAdv = dir === 1 ? c.low <= adverse : c.high >= adverse;
    if (hitFav && hitAdv) return { outcome: 'LOSS', label: 0, resolvedIndex: i };
    if (hitFav) return { outcome: 'WIN', label: 1, resolvedIndex: i };
    if (hitAdv) return { outcome: 'LOSS', label: 0, resolvedIndex: i };
  }

  // Nothing hit. Distinguish "full horizon seen" (TIMEOUT) from "need more bars" (PENDING).
  const haveFullHorizon = horizonEnd <= last;
  return haveFullHorizon
    ? { outcome: 'TIMEOUT', label: null, resolvedIndex: null }
    : { outcome: 'PENDING', label: null, resolvedIndex: null };
}
```

**`dir` does the mirroring.** One `1 | -1` flips both level formulas *and* both hit
tests, so bearish is the exact mirror of bullish with no duplicated branch. Work it
through with `entry = 100`, `ATR = 2`:

- **Bullish** (`dir = 1`): favorable `100 + 1·1.5·2 = 103`, adverse `100 − 1·1·2 = 98`.
  Price must go **up** to 103 before **down** to 98. Hit test: `high >= 103` /
  `low <= 98`.
- **Bearish** (`dir = -1`): favorable `100 + (−1)·1.5·2 = 97`, adverse
  `100 − (−1)·1·2 = 102`. Price must go **down** to 97 before **up** to 102. Hit
  test flips to `low <= 97` / `high >= 102`.

**Why `high`/`low` and not `close`.** We ask whether price *touched* the level
intrabar, not whether it closed beyond it. A real stop or target triggers on the
touch. Using `close` would miss a spike that ran your target and came back — which
in reality would have filled you.

**The scan starts at `index + 1`.** The anchor bar itself is never examined for a
hit. Entry *is* its close; the pattern can't resolve on the bar that created it.

**`scanEnd = Math.min(horizonEnd, last)`** — scan the horizon, but never past the
end of the data we have. That single `Math.min` is what makes PENDING possible.

## Worked example — walking the four outcomes

All four come straight from `follow-through.spec.ts`, which uses a `bar()` helper
building flat candles (`open = close`, `high/low` straddling by `spread`),
`params = { k: 1.5, m: 1.0, n: 10 }` and `atr = 2`. So for a bullish anchor closing
at 100: **favorable = 103, adverse = 98.**

**WIN.** `[bar(0, 100), bar(1, 101), bar(2, 103.5)]`, anchor index 0, `dir = 1`:

| bar | high | low | `hitFav` (≥103) | `hitAdv` (≤98) | → |
|---|---|---|---|---|---|
| 1 | 101 | 101 | ✗ | ✗ | keep scanning |
| 2 | 103.5 | 103.5 | ✓ | ✗ | **WIN**, `label 1`, `resolvedIndex 2` |

**LOSS.** `[bar(0, 100), bar(1, 97.5)]` → bar 1 has `low 97.5 <= 98` ✓ → **LOSS**,
`label 0`, `resolvedIndex 1`. Adverse first, so the pattern failed — regardless of
what price did afterwards. That's path-awareness doing its job: a recovery on bar 4
doesn't retroactively un-stop you.

**LOSS (the same-bar tie).** One wide bar `{ open: 100, high: 104, low: 97 }` hits
**both** 103 and 98:

```ts
if (hitFav && hitAdv) return { outcome: 'LOSS', label: 0, resolvedIndex: i };
```

Checked **first**, before either single-hit branch, and it resolves to **LOSS**.
Why? Because a candle is an aggregate — `high` and `low` carry no ordering. Within
that bar, price may have run to 104 then collapsed to 97, or dived to 97 then
ripped to 104. **The data cannot tell us**, and no amount of cleverness recovers
it. So we take the pessimistic reading. If we guessed WIN, we'd be crediting the
model for a coin-flip it never won — and the price of that optimism is paid live,
with real money, where the ambiguity resolves the way it actually resolves. When a
label is genuinely unknowable, **bias against yourself.**

**TIMEOUT vs PENDING** — the distinction that's easy to miss and expensive to get
wrong. Both mean "no level was hit." They are *not* the same fact:

```ts
const haveFullHorizon = horizonEnd <= last;
```

| | Meaning | Bars available | The right response |
|---|---|---|---|
| **TIMEOUT** | We watched all `n` bars. Nothing happened. | full horizon | **Final.** The pattern fizzled — a real, complete observation. |
| **PENDING** | We ran out of chart. | fewer than `n` | **Provisional.** Ask again when more bars print. |

From `follow-through.spec.ts`: 11 flat candles at 100, anchor 0, `n = 10` →
`horizonEnd = 10`, `last = 10`, so `10 <= 10` ✓ → **TIMEOUT**. Three flat candles
→ `last = 2`, `10 <= 2` ✗ → **PENDING**.

Collapsing these would be a genuine bug in either direction. Call a PENDING a
TIMEOUT and you've permanently written off every fresh live detection as "fizzled"
before it had a chance — and they'd *never* be re-checked. Call a TIMEOUT a PENDING
and you re-scan it forever, waiting for bars that already came and went. Both carry
`label: null` and neither trains, but only one of them is done.

This is the same confirmation-lag idea from pattern-detection Lesson 01 — a swing
high needs `strength` bars after it before you can confirm it — one level up: a
**label** needs up to `n` bars after the anchor before you can confirm *it*. Live
detections are born PENDING and it can't be otherwise. The future hasn't happened.

## The assembler: where features and label are kept apart

`buildObservationInputs` (`ml/observation-assembler.ts`) turns markers into rows.
This is the loop:

```ts
  for (const marker of markers) {
    if (marker.bias !== 'BULLISH' && marker.bias !== 'BEARISH') continue;
    const anchor = indexByTime.get(marker.time);
    if (anchor === undefined) continue;

    const dir: 1 | -1 = marker.bias === 'BULLISH' ? 1 : -1;
    const atr = computeAtrFromCandles(candles.slice(0, anchor + 1), atrPeriod);
    if (atr <= 0) continue; // can't scale a follow-through target without ATR

    const ft = resolveFollowThrough(candles, anchor, dir, atr, params);
    const window = candles.slice(Math.max(0, anchor - windowBars + 1), anchor + 1);
    ...
  }
```

**Read those three lines against each other. This is the most important thing in
the lesson.** Pulled out of the loop above and annotated (the `←` comments are
mine; in the file the lines aren't adjacent):

```text
const atr = computeAtrFromCandles(candles.slice(0, anchor + 1), atrPeriod);
                                            └── bars ≤ anchor ──┘

const ft = resolveFollowThrough(candles, anchor, dir, atr, params);
                                └── the FULL array — reads FORWARD ──┘

const window = candles.slice(Math.max(0, anchor - windowBars + 1), anchor + 1);
                                    └────────── bars ≤ anchor ──────────┘
```

- **ATR** gets `candles.slice(0, anchor + 1)` — history up to and including the
  anchor. Never a bar beyond it.
- **The feature window** gets `candles.slice(anchor - windowBars + 1, anchor + 1)`
  — the last `windowBars` (default 50) bars ending *at* the anchor. Also never
  beyond.
- **The label** gets the **full `candles` array** — because reading forward is
  precisely its job.

That asymmetry is not incidental; it *is* the design. Everything the model will
ever see is truncated at the anchor. Only the answer key sees past it.

### Why it matters: lookahead bias

Suppose ATR were computed over the whole array instead — one character's
difference, `candles` instead of `candles.slice(0, anchor + 1)`. ATR would then
include the volatility of the very bars the label is measured over. A detection
followed by a huge move would get a fatter ATR, computed *from* that move. The
feature would encode the answer.

Here's the cruel part. The model would **look brilliant** — accuracy climbing,
validation metrics glowing, every chart green. Because at training time the answer
is sitting right there in the input, and gradient descent is not too proud to read
it. Then you deploy. Live, at the anchor bar, those future bars **do not exist** —
they physically cannot be fetched — and the feature that carried all the signal is
suddenly noise. The model degrades to a coin flip on the one day it's spending your
money.

That failure mode is called **lookahead bias** (or leakage), and it's the classic
way a quant pipeline dies:

> **The louder your backtest cheers, the harder you should look for the leak.**

It's insidious because nothing errors. No exception, no test failure, no red. Just
an optimistic number that means nothing — and every incentive to believe it. The
defense is structural, not vigilance: features slice `0 … anchor`, the label reads
everything, and the two never mix. That's why the ATR slice is written the way it
is. (The spec, §10, calls for an explicit leakage-guard test asserting no feature
reads a bar > anchor. Worth knowing that's the standard, not a nicety.)

### Why NEUTRAL is excluded

The first line of the loop:

```ts
if (marker.bias !== 'BULLISH' && marker.bias !== 'BEARISH') continue;
```

`PatternMarkerDto.bias` has three values — `'BULLISH' | 'BEARISH' | 'NEUTRAL'`. A
`DOJI` is `NEUTRAL` (pattern-detection Lesson 02: "indecision, a tug-of-war with no
winner").

Now try to label one. `dir` must be `1` or `-1`. Which? A doji points *nowhere*.
There is no favorable level, so there's no "follow-through" to resolve. The
question the label asks is **undefined** for a directionless pattern — so we don't
ask it. `continue`. (Test: *"skips NEUTRAL-bias markers (no follow-through
direction)"*.)

This is exclusion, not a judgment. Dojis may well be *informative* — "indecision
right before a bullish engulfing" is plausibly a great feature. Nothing stops a
later phase feeding that to the model as **context** derived from the
`candleWindow`. What a doji cannot be is a **labeled training example**, because it
has no outcome to be right or wrong about.

And notice the type enforces it. `PatternMarkerDto.bias` allows three values;
`PatternObservationInput.bias` allows two:

```ts
bias: 'BULLISH' | 'BEARISH';
```

After the `continue` guard, TypeScript has narrowed `marker.bias` to exactly those
two, so `bias: marker.bias` compiles. Skip the guard and it won't. The rule isn't
merely documented — it's **unrepresentable** to break.

### Why `timeframe` is a feature, not a filter

Every row carries its `timeframe`, and it's a **first-class categorical feature**
(spec §4.2) — an input the model trains on, exactly like `patternName`.

Why does that matter? Because **the same pattern is not the same bet on different
timeframes.** A hammer on 1h may follow through far more reliably than a hammer on
1m, where it's frequently just microstructure noise wearing a hammer costume. If
you dropped `timeframe`, you'd force the model to learn one average "hammer
quality" — a blend of a good 1h signal and a bad 1m one, that describes neither.

Feed it in, and the model learns a **per-(pattern, timeframe)** notion of quality
instead: "hammer on 1h: 0.71. Hammer on 1m: 0.48." Same detector, same geometry,
different bets — which is the truth.

The alternative would be eight separate per-timeframe models. One model conditioned
on `timeframe` wins (spec §4.2): it **shares** signal across timeframes that behave
alike, still **specialises** where they don't, and **degrades gracefully** for
timeframes with few samples — a per-1d model would starve on its own, but a shared
model conditioned on `1d` borrows structure from its better-fed neighbours.

## Gotchas

1. **`atr <= 0` silently drops the observation.** `computeAtrFromCandles` returns
   `0` when there aren't enough candles (it needs more than `period` bars — default
   14 — to form `period` true ranges). So a pattern detected in the first ~15 bars
   of a series has no ATR, both label levels would collapse onto `entry`, and the
   row is skipped: `if (atr <= 0) continue;`. Early-history detections just don't
   become observations. Correct, but don't be surprised by the count.

2. **`TIMEOUT` is real data, not a failure.** It carries `label: null` and is
   excluded from v1 training (spec §4.1: ambiguous), but it's still logged. "This
   pattern fizzles 40% of the time" is a *finding*. A row you didn't train on is
   not a row you learned nothing from.

3. **The label is a bet definition, not a strategy.** `k = 1.5 / m = 1.0 / n = 10`
   encodes one specific bet: 1.5 ATR target, 1 ATR stop, 10-bar patience. Change
   the params and `P(follow-through)` means something *else* — the same detection
   can be WIN under one and LOSS under another, with neither wrong. A model is
   always answering the exact question its label asked. Change the label, retrain.

4. **Marker time must match a candle time exactly.** `indexByTime` is keyed on
   `candles[i].time` (epoch ms) and a marker whose `time` has no match is dropped
   (`if (anchor === undefined) continue;`). Markers come from `buildPatternMarkers`,
   which maps detector indices straight back to `candles[i].time`, so they align by
   construction — as long as both sides are the **same array**. Feed markers from
   one candle set and candles from another and everything silently vanishes. (Test:
   *"drops a marker whose time has no matching candle"*.)

5. **Same-bar ties are more common on high timeframes.** A 1d bar spans a whole
   session, so "hit both 1.5 ATR up and 1 ATR down" happens far more often than on
   1m. Since ties resolve to LOSS, expect the daily dataset to be somewhat
   pessimistically labeled. That's the conservative choice compounding — worth
   remembering when you compare win rates *across* timeframes, since it's a
   property of the label, not of the patterns.

## Next

That's Phase 1's core: markers in, labeled observations out. What's left in this
phase is plumbing — persisting rows, replaying history to seed the dataset, and
re-resolving PENDING rows once their bars arrive.

Lesson 03 picks up in **Phase 2**, where Python finally enters: turning
`candleWindow` blobs into a feature matrix, and the pipeline-level traps that come
with it — leakage that survives a correct assembler (train/test splits that
straddle time, normalization fitted on the whole dataset), and why the fix is
always the same shape as the one you just read: **draw the line at the anchor bar,
and never let anything cross it.**
