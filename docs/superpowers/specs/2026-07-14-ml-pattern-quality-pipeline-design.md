# ML Pattern-Quality Pipeline — Design Spec

**Date:** 2026-07-14
**Status:** Approved (design) — pending implementation plan
**Owner:** GrW / signal-generator + ai-engine

---

## 1. Problem & Goal

Today the chart pattern detectors (`apps/api/src/modules/signal-generator/patterns/`:
`candlestick.ts`, `chart-patterns.ts`, `swing-points.ts`, `to-markers.ts`) are wired
**only** to the `/api/signals/patterns` endpoint that paints the chart overlay. They
influence no trading decision, and the overlay is **noisy** (~50–60 markers on a
typical window) because every geometric match fires regardless of whether that
pattern actually tends to *work* in its context.

Separately, the Python `ai-engine` (`xgboost_scorer`, `feature_engineer`,
`self_learning_service`, `training_service`, `market_regime`) is **disabled in
production** — `render.yaml` sets `AI_ENGINE_URL: https://ai-engine.invalid` and
`signal-scoring.service.ts` hardcodes `http://localhost:5000`. All ML calls
fail-open to non-ML scoring, so the Python code is dead weight in prod.

**Goal (two halves, one model):**
1. **Reduce noise / confirm quality** — score each detected pattern with a
   `P(follow-through)` probability so the overlay (and, optionally, signals) can
   keep only patterns likely to work.
2. **Learn from findings** — capture every detection + its realized outcome and
   continuously retrain the scorer.

Both halves collapse into a single **pattern-quality scorer** plus the data,
training, and serving pipeline around it.

## 2. Constraints

- **₹0 free-tier.** The Python ai-engine runs as a **second Render free service
  that sleeps**. Serving must tolerate cold starts (~30–60s) — see §7.
- **Never break the chart or signals.** Every Python call fail-opens to a
  heuristic prior. ai-engine being asleep/down must be invisible to users.
- **One detector implementation.** Detection stays in TS (NestJS already has it);
  Python does ML only. No re-implementing detectors in Python.
- **Free-tier `@Cron` is unreliable** (Render sleeps) — scheduled retrain uses the
  external-heartbeat trigger pattern already used for `commodity-roll`.

## 3. Division of Labor (boundaries)

| Concern | Owner | Why |
|---|---|---|
| Pattern detection | **NestJS (TS)** | Detectors already exist here; has live + historical candles |
| Observation capture + label resolution | **NestJS (TS)** | Owns candles → can compute ATR-follow-through labels |
| Feature engineering | **Python** | Reuse `feature_engineer.py`; keeps feature logic with the model |
| Model training / scoring | **Python** | Reuse `xgboost_scorer.py`, `self_learning_service.py` |
| Serving orchestration (batch, cache, fail-open) | **NestJS (TS)** | Owns the scan + overlay endpoints |

NestJS sends Python a **candle window** (fixed lookback up to the detection bar)
plus pattern metadata; Python computes features from the window. This keeps the
feature implementation in one place (Python) and the detector implementation in
one place (TS).

## 4. The ML Core

### 4.1 Label — ATR follow-through
At detection bar *t* with `close_t`, `ATR_t`, and pattern bias direction `dir`
(+1 bullish, −1 bearish), scan bars *t+1 … t+N*:

- **WIN (label 1):** price reaches `close_t + dir·k·ATR_t` **before** reaching
  `close_t − dir·m·ATR_t`.
- **LOSS (label 0):** the adverse level `close_t − dir·m·ATR_t` is hit first.
- **TIMEOUT:** neither within N bars → **excluded from v1 training** (ambiguous),
  still logged for analysis.

**Defaults:** `k = 1.5`, `m = 1.0`, `N = 10 bars`. All are config, tunable
without code changes. Path-aware (checks order of touches, not just the
endpoint) and ATR-normalized so labels are comparable across instruments and
volatility regimes.

**Timeframe-relative by construction.** `N` is measured in **bars** and `ATR` is
computed **per timeframe**, so the same label definition applies unchanged to
every timeframe — `N=10` bars is 10 minutes on 1m and 10 days on 1d, each with
its own ATR scale. We do NOT need per-timeframe label params; the label
self-normalizes. (Per-tf `k/m/N` overrides remain possible via config if a
timeframe later warrants it.)

### 4.2 Features (computed in Python from the candle window)
- **Identity:** patternName (one-hot), category (CANDLESTICK/CHART), bias,
  **`timeframe` (first-class categorical feature)**.
- **Context:** ATR and ATR percentile, EMA-trend / MTF alignment, RSI,
  volume-vs-average, distance to nearest SR level, position-in-range,
  time-of-day bucket, volatility regime (`market_regime.py`).
- **Geometry:** body/range ratio, upper/lower wick ratios, engulfing size,
  gap presence.

**Timeframe as a first-class feature.** Because different patterns work on
different timeframes (a hammer may follow through far more reliably on 1h than on
1m), `timeframe` is an explicit input to the model. The scorer therefore learns a
**per-(pattern, timeframe)** notion of quality rather than one global rule. A
single model conditioned on `timeframe` is preferred over N separate per-tf
models: it shares signal across timeframes where behaviour is similar and still
specialises where it differs, and it degrades gracefully for timeframes with
fewer samples. Evaluation reports precision/recall **broken down by
(pattern, timeframe)** so we can see, e.g., "double-bottom on 1h" vs
"double-bottom on 5m" quality separately.

### 4.3 Model
XGBoost binary classifier → **calibrated** probability (reuse `xgboost_scorer.py`;
add probability calibration). Output per detection: `score ∈ [0,1]` = `P(follow-through)`.

## 5. Data Model

New Prisma table `pattern_observations`:

| Column | Notes |
|---|---|
| id | pk |
| token, exchange, timeframe | instrument + tf |
| patternName, category, bias | detection identity |
| barTime | detection bar timestamp (IST-correct) |
| candleWindow | JSON: fixed lookback OHLCV up to detection (feature input) |
| atrAtDetection | for label geometry — written once at detection and **reused verbatim** by the resolver; never recomputed (see §6) |
| label | nullable: 1 / 0 |
| outcome | WIN / LOSS / TIMEOUT / PENDING |
| resolvedAt | when the label was filled |
| modelScore, modelVersion | nullable: last score + model that produced it |
| createdAt | audit |

Indexes on (token, timeframe, barTime) and (outcome) for the training pull.

## 6. Data Flow

```
DETECT (NestJS TS) ─► pattern_observations ─► RESOLVE label (+N bars, NestJS)
      │                      │                          │
   score live            backfill job               resolved rows
      ▼                 (6–12mo history)                 ▼
Python /api/score-patterns ◄─ model artifact ◄── TRAIN (Python, scheduled)
      │                                                  ▲
  cache + fail-open ─► filter overlay / gate signals ─ live outcomes feed back
```

- **Detection → observation:** every detector hit writes a `PENDING` row with its
  candle window + ATR.
- **Resolution:** a NestJS job fills `label`/`outcome` once N bars exist past
  `barTime` (immediate for backfill; +N-bars-later for live). The job scales the
  favorable/adverse levels with the row's **stored `atrAtDetection`** — it must
  never recompute an ATR from the bars it re-fetched. Wilder ATR is recursive off
  an SMA seed, so an ATR recomputed from the resolver's (shorter, differently
  aligned) lookback would not equal the value the row carries as a feature, and
  rows in the same training table would end up labeled against different
  yardsticks. Reusing the stored number keeps each row's features and its label on
  one scale by construction.
- **Backfill:** a re-runnable NestJS job replays 6–12 months of history for a
  seed instrument set (NIFTY, BANKNIFTY, CRUDEOIL, top liquid stocks) **across
  ALL supported timeframes** (1m, 3m, 5m, 10m, 15m, 30m, 1h, 1d — the Angel-native
  set; 4h/1w join later once timeframe aggregation lands). Each (instrument ×
  timeframe) replay produces labeled rows tagged with their `timeframe`, so the
  dataset spans every timeframe from day one. Note the per-tf data-volume skew
  (1m yields far more bars/patterns than 1d over the same window); training
  accounts for this (class/timeframe weighting) so sparse timeframes aren't
  drowned out.
- **Training:** Python `self_learning_service` reads resolved rows (via a NestJS
  internal endpoint or direct read-only DB — decided in the plan), trains,
  writes a versioned model artifact + metrics.
- **Serving:** NestJS `PatternQualityService.scoreBatch(detections)` POSTs a batch
  to Python `/api/score-patterns`, caches by (token, tf, patternName, barTime),
  fail-opens to a heuristic prior.

## 7. Free-Tier Serving Shape

- ai-engine = **second Render free service**, sleeps when idle.
- NestJS calls it **only in batch during the signal scan** — never per-tick.
- First call after idle eats a cold start; `PatternQualityService` uses a generous
  timeout, **caches every score**, and **fail-opens** to a heuristic prior while
  the service warms. The chart's live render never waits on it (it stays on the
  REST candle polls).
- Retrain runs inside the same Python service, triggered by an **external
  heartbeat** (cron-job.org / UptimeRobot hitting a trigger endpoint), because
  free-tier `@Cron` is unreliable.

## 8. Serving Integration (noise reduction)

- **Overlay:** `/api/signals/patterns` filters (or colors/sizes) markers by
  `score ≥ threshold` (config, default e.g. 0.6). Turns ~50–60 markers into the
  high-probability few. Fail-open → show all (current behavior) if unscored.
- **Signals (optional, Phase 3):** expose a `pattern_quality` factor to the
  existing `context-scoring` service so high-quality patterns can boost/gate
  signal generation.

## 9. Error Handling

- Every Python call fail-opens to a heuristic prior; chart & signals never break.
- **Model versioning:** keep the last-good artifact; a failed/again-worse retrain
  cannot brick scoring (guard on validation metric before promoting a new model).
- Cache is best-effort; a cache miss just re-scores (or fail-opens).

## 10. Testing

- **TS:** observation capture on detection; ATR-follow-through label resolver
  (golden fixtures: WIN/LOSS/TIMEOUT ordering); `PatternQualityService` batching,
  caching, and fail-open; overlay threshold filtering.
- **Python:** feature engineering shape & determinism; label/dataset integrity
  (no look-ahead leakage — features use only bars ≤ t); training smoke test;
  scoring endpoint contract; model-promotion guard.
- **Leakage guard test:** assert no feature reads a bar > detection bar.

## 11. Rollout Phases (each independently useful; each ships a lesson)

- **Phase 1 — Data capture:** `pattern_observations` table + detection→observation
  writer + ATR-follow-through resolver + backfill job. *Produces the dataset; no
  ML yet.* → Lessons `01`, `02`.
- **Phase 2 — Training:** Python feature engineering + XGBoost training from the
  dataset → versioned artifact + metrics + `/api/score-patterns`. → Lessons
  `03`, `04`, `05`.
- **Phase 3 — Serving & noise filter:** `PatternQualityService` (batch/cached/
  fail-open) → overlay threshold filter; optional `pattern_quality` context
  factor. → Lesson `06`.
- **Phase 4 — Learning loop:** live outcome resolution → heartbeat-triggered
  retrain + model versioning + drift check (precision on recent window). → Lesson
  `07`.

## 12. Teaching Track — `docs/learning/ml/`

Lesson-per-concept, tied to the code we write (mirrors `docs/learning/pattern-detection/`):

- `01` — supervised-learning framing of "pattern quality"
- `02` — features & the ATR-follow-through label
- `03` — the data pipeline; leakage / look-ahead traps
- `04` — XGBoost & training
- `05` — evaluation: precision/recall, probability calibration
- `06` — serving & fail-open
- `07` — the learning loop: retraining & drift

## 13. Success Criteria

- Overlay markers reduced to high-probability set; each carries a `P(follow-through)`.
- `pattern_observations` accumulating labeled rows (backfill seed + live) **across
  all supported timeframes**, each row tagged with its `timeframe`.
- Python ai-engine deployed (free tier) and reachable; scoring fail-opens cleanly
  when asleep.
- A versioned model with reported validation precision/recall **broken down by
  (pattern, timeframe)** — so timeframe-specific quality is visible.
- Seven ML lessons written and committed.

## 14. Out of Scope (this spec)

- Reviving the ML path for the *existing* signal scorer (`/api/score-signal`) —
  separate concern; may reuse the deployed ai-engine later.
- 4H/1W timeframe aggregation (tracked separately).
- RL agent / FinBERT sentiment integration.
