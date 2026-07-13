# Chart Pattern Detection — a build-along course

This folder is a **learning log**: as we build pattern detection into GrW, each
piece gets a lesson here (the *why* + the *math* + a pointer to the code). Read
these in order; they mirror the code in
`apps/api/src/modules/signal-generator/patterns/`.

## The big idea (read this first)

"Detecting patterns" and "ML" are **two different things**, and the order matters:

```
   RULES              →     OUTCOMES            →     ML
 (deterministic         (label each detection      (train a model to SCORE /
  geometry on OHLC)      with what happened next)    FILTER the rule hits)
```

- **Rules come first.** You cannot train a model until you have labeled examples
  ("this was a double-top, and price fell 4% after"). The rule-based detector is
  what *produces* those labels.
- **ML comes on top.** Once we have detections + outcomes, a model (e.g. XGBoost,
  already scaffolded in `ai-engine/`) learns to rank them — "this engulfing is
  high-quality, that one is noise."

So Phases 1–2 are **pure rules** (no training, fully transparent). Phase 3 is the
real ML. Doing it in this order is what actually teaches you the domain.

## Why TypeScript first

The detector lives in the existing NestJS `signal-generator` module. No new infra
(the Python `ai-engine` isn't deployed), it reuses the live candle pipeline, and —
most importantly for learning — we **code each pattern explicitly** so when the
chart lights up, you know *exactly* why. We move to Python/TA-Lib only when we add
ML (Phase 3).

## Roadmap & lessons

| # | Lesson | Code | Status |
|---|--------|------|--------|
| 01 | **Swing points** (the keystone — every chart pattern needs these) | `patterns/swing-points.ts` | ✅ |
| 02 | Candlestick patterns (engulfing, hammer, doji) | `patterns/candlestick.ts` | ✅ |
| 03 | Chart patterns (double top/bottom) — built on swing points | `patterns/chart-patterns.ts` | ✅ |
| 04 | Wiring detections onto the chart (endpoint + markers) | — | ⏳ |
| 05 | Labeling outcomes → the ML layer (XGBoost) | `ai-engine/` | ⏳ |

## Vocabulary you'll meet
- **OHLC / candle** — one bar: open, high, low, close (+ time).
- **Body** — |open − close|. **Wick / shadow** — the thin bits above/below the body.
- **Swing high / low (pivot)** — a bar that's higher (or lower) than N bars on each side.
- **Strength / lookback (N)** — how many bars on each side a pivot must beat.
- **MFE / MAE** — max favorable / adverse excursion: the best/worst a trade reached.
