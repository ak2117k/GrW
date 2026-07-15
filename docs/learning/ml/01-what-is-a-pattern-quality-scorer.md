# Lesson 01 — What is a pattern-quality scorer?

**Code:** `apps/api/src/modules/signal-generator/patterns/to-markers.ts` (what the
detectors emit) · `apps/api/src/modules/signal-generator/ml/pattern-observation.types.ts`
(what we learn from)
**Spec:** `docs/superpowers/specs/2026-07-14-ml-pattern-quality-pipeline-design.md`

Prerequisite: the `docs/learning/pattern-detection/` course. That one taught you to
*find* patterns. This one is about a harder question — **which of them are worth
believing?**

## The problem: the detector is correct, and useless

Open the chart. The overlay lights up with markers — roughly **50–60 on a typical
window** (design spec §1). Every one of them is *correct*: the geometry really does
match. `BULLISH_ENGULFING` really did engulf. And that is exactly the problem.

```
   price ────────────────────────────────────────────
     ▲ ▲   ▲ ▲ ▲     ▲   ▲ ▲ ▲ ▲    ▲ ▲   ▲ ▲ ▲ ▲ ▲
     └─────────── 55 markers, all "correct" ─────────┘
                   which three mattered?
```

Lesson 02 of the pattern-detection course already told you why, in its Gotcha 1:

> **A candle in isolation is a weak signal.** These predicates only describe
> *shape* — they know nothing about *where* the candle sits. A hammer only means
> "reversal" **after a downtrend**; the identical shape mid-rally is just a bar
> with a long lower wick.

The detectors answer **"is this the shape?"** — a yes/no question about geometry.
Traders need the answer to a different question: **"will this one work?"** Those
are not the same question, and no amount of extra `if` statements turns the first
into the second. The shape is the same either way; only the *context* differs.

You could try to hand-code the context ("hammer, but only if RSI < 30, and only if
it's near a support level, and only after 3 red bars, and..."). That's a guess, and
you'd be guessing at ten knobs at once. There is a better move: **stop guessing,
and go measure what actually happened.**

## The reframe: from geometry to a bet

Here's the mental shift the whole pipeline rests on.

| | Detector (rules) | Scorer (ML) |
|---|---|---|
| Question | "Is this the shape?" | "Will this one follow through?" |
| Answer | `true` / `false` | `0.0 … 1.0` — a probability |
| Where it comes from | You wrote the rule | Learned from what happened next |
| Can it be wrong? | Only if you coded it wrong | Yes, and it tells you how unsure it is |

A detector hit is a **fact**. A quality score is a **bet** — and a good bet comes
with odds. That's what "pattern quality" means here, precisely:

> **Pattern quality** = `P(follow-through)` — the probability that *this*
> detection, in *this* context, on *this* timeframe, gets where it was supposed to
> go before it gets stopped out.

Not "is this a good-looking hammer." Not a 1-to-5 star rating someone invented. A
number with a testable meaning: **out of 100 detections scored 0.7, roughly 70
should work out.** If they don't, the model is wrong and we can prove it.

## Supervised learning, in four boxes

That reframe *is* supervised learning. If ML is new to you, this is the whole
skeleton — everything else in this course is detail hung on it:

```
   FEATURES  ──►  MODEL  ──►  PROBABILITY
  (what we knew    (learned      (0.0 … 1.0)
   at the bar)      rule)             │
                       ▲              │
                       │              ▼
                    LABEL  ◄───  compare, correct, repeat
              (what actually
               happened next)
```

- **Features** — the inputs. Everything we knew *at the moment of detection*:
  which pattern, what the last 50 bars looked like, how volatile it was, what
  timeframe. Never anything from after that bar (Lesson 02 explains why that rule
  is load-bearing).
- **Label** — the answer key. Did it work? `1` = yes, `0` = no. We don't invent
  this; we read it off the chart *after the fact*, once enough bars have printed.
- **Model** — a function fitted to `(features → label)` over thousands of past
  examples. Nobody writes its rules; it finds them.
- **Probability** — what it emits on a *new*, unseen detection.

"Supervised" just means **we supply the answer key.** The model isn't discovering
truth from the void — it's doing curve-fitting against outcomes we measured. Which
means: *no labels, no model.* A supervised learner with no answer key is not a
model, it's a random number generator.

That's why this phase exists. **Phase 1 builds the answer key.** Nothing else.

## Where the model actually gets used: the threshold

Say the scorer works. How does a probability clean up the chart? One line:

```
keep the marker if score ≥ threshold
```

That's it. The threshold (config, default around **0.6** — spec §8) is a dial that
trades **how many** against **how good**:

```
  threshold 0.0 ──────────────────────────────────► 1.0
    ▲▲▲▲▲▲▲▲▲▲▲▲            ▲▲▲▲                ▲
    all 55 markers        the ~12 likely       the 1 near-certain
    (today's overlay)      to work             (and you'll wait weeks)
```

- **Low threshold** → keep almost everything. You see every opportunity, and you
  drown in noise. This is today's overlay, at `threshold = 0`.
- **High threshold** → keep only near-certainties. Clean chart, but you miss most
  real moves and the few survivors may be too rare to trade.

Note what the model did *not* do: it never deleted a detector rule or changed the
geometry. Detection stays exactly as deterministic and transparent as it is now —
`BULLISH_ENGULFING` is still `BULLISH_ENGULFING`. The scorer is a **ranking layer
on top**. If the model is unavailable, you drop the threshold to 0 and you're back
to the current behavior, nothing broken. (The spec calls this *fail-open*, §9 —
Lesson 06's problem, not ours.)

This is also the honest answer to "does ML replace my rules?" No. The rules find
candidates; the model sorts them. Neither does the other's job.

## Where this sits in GrW

The split (spec §3) is deliberate: **detection in TypeScript, ML in Python, one
implementation of each.**

```
  ┌─ NestJS / TypeScript ──────────────────────┐   ┌─ Python ─────┐
  │                                            │   │              │
  │  candles ─► detectors ─► buildPatternMarkers   │              │
  │             (patterns/)      │             │   │              │
  │                              ▼             │   │              │
  │                     PatternMarkerDto[]     │   │              │
  │                              │             │   │              │
  │                              ▼             │   │              │
  │              buildObservationInputs ───────┼──►│  features    │
  │                  (ml/, THIS PHASE)         │   │  training    │
  │                              │             │   │  scoring     │
  │                              ▼             │   │              │
  │                   pattern_observations     │   │  (Phase 2+)  │
  └────────────────────────────────────────────┘   └──────────────┘
```

Why this way? TypeScript already has the detectors and the live candle pipeline —
re-implementing them in Python would mean two detectors drifting apart forever.
Python already has the ML libraries. So TS owns candles→detections→**observations**,
and hands Python a candle window to compute features from. One detector, one
feature engineer, no duplication.

**Phase 1 — this phase — is the left box only, and only the bottom half of it.**
There is no Python service, no features, no model, no scoring, no threshold. Those
are Phases 2–4 (spec §11). We are building the dataset. That's genuinely all.

If that feels anticlimactic, sit with it: it's the part people skip, and it's the
part that determines whether any of the rest works. A model trained on a sloppy
answer key learns the sloppiness — confidently, and invisibly.

## The two shapes, in real code

Two type definitions carry this entire lesson. First, what a detector hit *is* —
the flat marker `buildPatternMarkers` emits, one per hit, from
`patterns/to-markers.ts`:

```ts
  for (const hit of findCandlestickPatterns(candles)) {
    markers.push({
      category: 'CANDLESTICK',
      name: hit.name,
      bias: hit.bias,
      time: candles[hit.index].time,
      points: [],
      necklinePrice: null,
      confirmed: null,
      confirmTime: null,
    });
  }
```

Read the `PatternMarkerDto` it builds (`dto/pattern-marker.dto.ts`) as an answer to
*"what did we see?"*:

```ts
export interface PatternMarkerDto {
  category: 'CANDLESTICK' | 'CHART';
  name: string; // e.g. 'BULLISH_ENGULFING' | 'DOUBLE_TOP'
  bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  /** epoch MS of the ANCHOR candle (candlestick: the signal candle; chart: the SECOND peak/trough). */
  time: number;
  ...
}
```

Every field is about the *shape*, and `time` marks the **anchor** — the bar the
pattern hangs on. Nothing here says whether it worked. It can't: at detection time,
nobody knows.

Now the new shape, `PatternObservationInput` from `ml/pattern-observation.types.ts`
— the same detection, plus the two things that make it *learnable*:

```ts
/** A row ready to persist to `pattern_observations`. */
export interface PatternObservationInput {
  token: string;
  exchange: string;
  timeframe: string;
  patternName: string;
  category: 'CANDLESTICK' | 'CHART';
  bias: 'BULLISH' | 'BEARISH';
  barTime: Date;
  candleWindow: OhlcvCandle[];
  atrAtDetection: number;
  outcome: PatternOutcomeName;
  label: 0 | 1 | null;
}
```

Map it straight onto the four boxes:

| Field | Role | Note |
|---|---|---|
| `patternName`, `category`, `bias`, `timeframe` | **features** (identity) | which pattern, on which timeframe |
| `candleWindow` | **features** (raw material) | Python derives context/geometry from this |
| `atrAtDetection` | **features** + label geometry | the volatility yardstick — Lesson 02 |
| `outcome` | **label** (readable) | `WIN`/`LOSS`/`TIMEOUT`/`PENDING` |
| `label` | **label** (trainable) | `1`/`0`, or `null` when there's no answer yet |

Three details in that type are worth pausing on, because each encodes a decision
you'd otherwise have to rediscover painfully:

1. **`bias` is `'BULLISH' | 'BEARISH'` — no `NEUTRAL`.** The DTO has three; the
   observation has two. A `NEUTRAL` pattern (`DOJI`) has no direction, so there's
   no such thing as "did it follow through." It cannot be labeled, so it cannot be
   trained on, so it never becomes a row. The *type* enforces it. (Lesson 02.)
2. **`label` is `0 | 1 | null`.** The `null` is not laziness — it's honesty. It
   means *"we do not know the answer to this one"*, which is a different statement
   from `0`. Rows with `label: null` are excluded from training rather than guessed
   at. Getting this wrong — coercing unknowns to `0` — would teach the model that
   "unresolved" means "failed", which is a lie.
3. **`candleWindow`, not pre-computed features.** We store the raw bars and let
   Python derive features later. Why? Because feature ideas change weekly and
   history doesn't. Store the raw material once; re-derive features as often as you
   like without re-running a six-month backfill.

## The table

Those rows land in `pattern_observations` (`prisma/schema.prisma`):

```prisma
model PatternObservation {
  id             String         @id @default(cuid())
  token          String
  exchange       String
  timeframe      String         // 1m, 3m, 5m, 10m, 15m, 30m, 1h, 1d
  patternName    String         // e.g. BULLISH_ENGULFING, DOUBLE_TOP
  category       String         // CANDLESTICK | CHART
  bias           String         // BULLISH | BEARISH
  barTime        DateTime       // anchor (signal) candle time, IST-correct instant
  candleWindow   Json           // OhlcvCandle[] up to & including the anchor bar
  atrAtDetection Float
  outcome        PatternOutcome @default(PENDING)
  label          Int?           // WIN=1, LOSS=0, null while PENDING/TIMEOUT
  resolvedAt     DateTime?
  modelScore     Float?         // filled by later phases
  modelVersion   String?
  createdAt      DateTime       @default(now())

  @@unique([token, exchange, timeframe, patternName, barTime])
  @@index([outcome])
  @@index([timeframe])
  @@map("pattern_observations")
}
```

Three things to notice:

- **`outcome` defaults to `PENDING`.** A row is born unlabeled. That's the normal
  state for a fresh live detection — the answer physically doesn't exist yet.
  Labels arrive later, when the bars do.
- **`modelScore` / `modelVersion` are nullable and unfilled.** The comment says
  *"filled by later phases"* — the columns are here, the thing that fills them is
  not. Don't read them as evidence a model exists.
- **`@@unique([token, exchange, timeframe, patternName, barTime])`** — re-running
  detection over the same history can't create duplicate rows. It makes capture
  **re-runnable**, which you want the first time you fix a bug and need to replay.

## Gotchas

1. **"Correct" and "useful" are different axes.** Every marker on the overlay is
   already correct. Adding rules makes it *more* correct and no more useful. The
   only thing that separates the 3 from the 55 is what happened *after* — which is
   information the detector, by construction, cannot have.

2. **A probability is a claim you can check.** If detections scored 0.9 work out
   40% of the time, the model isn't "a bit off" — it's *lying*, and a threshold
   built on it filters to confident garbage. This is why calibration gets its own
   lesson later. Treat any score you can't back-test as decoration.

3. **The answer key is the product, not the model.** Models are commodities —
   XGBoost is a library call. Labeled data that reflects *your* instruments, *your*
   timeframes, *your* detectors is not. If you only get one thing right in this
   pipeline, get the label right. Everything downstream inherits it.

4. **There is no model yet, and won't be for two phases.** When Phase 1 is done,
   nothing on the chart changes. No score, no filter, no Python. If you're waiting
   for a payoff you can see, it's Phase 3. What you get now is a table filling up
   with truth.

## Next

Lesson 02 gets specific about the two halves we just hand-waved: exactly **which
features** we capture, and exactly **how the label is measured** — the
ATR-follow-through rule, its `WIN`/`LOSS`/`TIMEOUT`/`PENDING` outcomes, and the
single most important line in the assembler: the one that makes sure a feature can
never see the future.
