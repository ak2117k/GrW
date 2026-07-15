# ML Pattern Quality — a build-along course

This folder is a **learning log**, same as `docs/learning/pattern-detection/`: as we
build the pattern-quality pipeline into GrW, each piece gets a lesson here (the
*why* + the *math* + a pointer to the code). Read these in order.

**Prerequisite:** the [`pattern-detection`](../pattern-detection/README.md) course.
That one built the detectors. This one asks which of their hits are worth
believing.

**Design spec:** `docs/superpowers/specs/2026-07-14-ml-pattern-quality-pipeline-design.md`

## The big idea (read this first)

The pattern-detection README ended on exactly this cliff:

```
   RULES              →     OUTCOMES            →     ML
 (deterministic         (label each detection      (train a model to SCORE /
  geometry on OHLC)      with what happened next)    FILTER the rule hits)
```

We have the rules. The overlay works — and it's **noisy** (~50–60 markers on a
typical window), because every geometric match fires whether or not that pattern
tends to *work* in its context. Every marker is correct. Only a handful matter.

So this course builds the second and third boxes: attach an **outcome** to every
detection, then learn a `P(follow-through)` score that ranks them. Detection stays
in TypeScript and stays deterministic; ML is a **layer on top** that never edits a
rule.

**Rules first, ML second** — because a supervised model cannot exist before its
answer key does, and the rule-based detector is what produces it.

## Phase 1 is data, not models

The order below is deliberate and the first phase is the unglamorous one:

| Phase | What ships | Lessons |
|---|---|---|
| **1 — Data capture** | `pattern_observations` table + detection→observation writer + ATR-follow-through resolver + backfill. *Produces the dataset. No ML.* | 01, 02 |
| 2 — Training | Python features + XGBoost → versioned artifact + `/api/score-patterns` | 03, 04, 05 |
| 3 — Serving & noise filter | batched/cached/fail-open scoring → overlay threshold filter | 06 |
| 4 — Learning loop | live outcome resolution → heartbeat retrain + drift check | 07 |

**There is no model yet.** No Python service, no features, no scores, no filtering
— those are Phases 2–4. When Phase 1 lands, the chart looks exactly the same and a
table starts filling with labeled truth. That's the deliverable.

## Roadmap & lessons

| # | Lesson | Code | Status |
|---|--------|------|--------|
| 01 | **What is a pattern-quality scorer?** (supervised framing; why detectors are noisy) | `ml/pattern-observation.types.ts` | ✅ |
| 02 | **Features & the ATR-follow-through label** (WIN/LOSS/TIMEOUT/PENDING; lookahead bias) | `ml/follow-through.ts`, `ml/observation-assembler.ts` | ✅ |
| 03 | The data pipeline; leakage / look-ahead traps | `ai-engine/` | ⏳ |
| 04 | XGBoost & training | `ai-engine/` | ⏳ |
| 05 | Evaluation: precision/recall, probability calibration | `ai-engine/` | ⏳ |
| 06 | Serving & fail-open | `PatternQualityService` | ⏳ |
| 07 | The learning loop: retraining & drift | `ai-engine/` | ⏳ |

## Vocabulary you'll meet

- **Feature** — a model input, computed **only** from bars ≤ the detection bar.
- **Label** — the answer key: what happened **after**. `1` = WIN, `0` = LOSS.
- **Anchor bar** — the detection bar (`PatternMarkerDto.time`); the line features
  and label are separated by.
- **Supervised learning** — fitting `features → label` on examples where we know
  the answer. No labels, no model.
- **ATR** — Average True Range: the average size of a bar. Our unit of "a normal
  move here, now" (`services/per-tf-atr.ts`).
- **Follow-through** — price reaching `k × ATR` in the pattern's direction before
  `m × ATR` against it, within `n` bars. Defaults `k=1.5, m=1.0, n=10`.
- **PENDING vs TIMEOUT** — "not enough bars yet, ask later" vs "watched the full
  horizon, nothing happened." Both unlabeled; only one is final.
- **Lookahead bias / leakage** — a feature that peeks past the anchor bar. Makes
  backtests glow and live trading fail.
- **Calibration** — whether a score of 0.7 actually wins ~70% of the time.
