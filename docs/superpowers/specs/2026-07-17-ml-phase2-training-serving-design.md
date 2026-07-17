# ML Phase 2 — Training & Serving Design Spec

**Date:** 2026-07-17
**Depends on:** `2026-07-14-ml-pattern-quality-pipeline-design.md` (§4.2/4.3/§11 Phase 2),
`2026-07-17-ml-detection-context-enrichment-design.md` (the context features).
**Prereq state:** ~2,651 labeled `pattern_observations` in prod (backfill-seeded,
`detectionContext = null`); scan-produced rich rows accrue later via the heartbeat.

## 1. Goal

Turn the labeled dataset into a **calibrated pattern-quality scorer** —
`P(follow-through) ∈ [0,1]` per detection — trained, evaluated, and served. Full
scope: train + deploy the ai-engine + a reachable `/score-patterns` endpoint that
NestJS can call fail-open.

## 2. Build order & the go/no-go gate

```
1. Data export      NestJS secret-authed endpoint → labeled observations (JSON)
2. Feature engineer Python: features from candleWindow (+ detectionContext when present)
3. Train + evaluate XGBoost → artifact + metrics broken down by (pattern, timeframe)
   ─────────────  GO / NO-GO GATE  ─────────────
   Deploy ONLY if there is real signal: overall validation AUC clearly > 0.5
   (target ≥ 0.60) AND ≥1 (pattern,timeframe) segment clearly predictive.
   If not: stop, report, and revisit features/data — do NOT ship a coin-flip.
4. Serve            ai-engine /score-patterns (batch, calibrated probability)
5. Deploy           ai-engine as a Render free service; real AI_ENGINE_URL
6. Integrate        NestJS client calls /score-patterns, fail-open (sidecar sleeps)
```

Pieces 1–3 are the cheap experiment; 4–6 (the deploy investment) are gated on 3.

## 3. Architecture (data access)

The ai-engine stays a **pure compute sidecar with no DB access** (matches the
platform architecture). NestJS owns the database and exposes the training set:

- **NestJS:** `POST /webhooks/ml/observations` (or GET), `X-ML-Trigger-Secret`
  header auth (reuse the existing ML trigger auth), paginated JSON of labeled
  rows: `{ token, exchange, timeframe, patternName, category, bias, candleWindow,
  atrAtDetection, detectionContext, label }` WHERE `label IS NOT NULL` (exclude
  TIMEOUT/PENDING — ambiguous, per the label spec). Pagination by `createdAt`
  cursor so large sets stream in batches.
- **ai-engine:** fetches all pages via `httpx` (already a dep), assembles the
  training frame, feature-engineers, trains.

## 4. Feature engineering (Python, pattern-quality specific)

New module `ai-engine/src/services/pattern_feature_engineer.py` — DISTINCT from
the existing signal `feature_engineer.py`. Per observation:

- **Identity:** `patternName` (one-hot), `category`, `bias`, `timeframe` (one-hot
  — a first-class feature; the scorer learns per-(pattern,timeframe) quality).
- **Bucket B (from `candleWindow`):** RSI, EMA gap/trend, volume-vs-average, ATR
  percentile, body/range ratio, upper/lower wick ratios, position-in-range, gap
  presence. Pure functions of the stored window (reuse `utils/indicators.py`,
  `market_regime.py` where possible).
- **Bucket A (from `detectionContext`, when present):** `mtf.aligned`,
  `mtf.direction`, `sr.distanceAtr`, `sr.atLevel`, `sector.trend`,
  `sector.alignment`. **Null → NaN**; XGBoost handles missing natively, so
  backfill rows (context-null) and scan rows (context-rich) train together and
  the model sharpens as rich rows arrive. No imputation, no waiting.

## 5. Training & evaluation

- **Label:** `label` (WIN=1, LOSS=0). TIMEOUT/PENDING already excluded at export.
- **Split:** TIME-BASED (train on older `createdAt`, validate on newer) — never
  random — so evaluation can't leak future rows into training.
- **Model:** XGBoost binary classifier + **probability calibration** (isotonic or
  Platt) so the output is a trustworthy probability, not just a ranking. Reuse
  `models/xgboost_scorer.py` patterns; add a pattern-quality variant + calibrator.
- **Metrics:** overall AUC / precision / recall AND **broken down by
  (pattern, timeframe)** (spec success criterion) — so "double-bottom 1d" vs
  "hammer 5m" quality is visible. Persist a versioned artifact
  (`models/pattern_quality_<version>.json`) + a metrics JSON.
- **Endpoints:** `POST /ml/train-patterns` (fetch → train → evaluate → persist),
  `GET /ml/pattern-metrics` (last run's metrics). Mirror the existing `/ml/train`.

## 6. Serving

- `POST /score-patterns` (ai-engine): body = a batch of detections, each carrying
  the **raw inputs** (`candleWindow` + optional `detectionContext`) — NOT
  pre-computed features. The endpoint runs the **same `pattern_feature_engineer`**
  as training, then scores. Reusing one feature module for both train and serve is
  what guarantees no train/serve skew — the recurring failure mode we've guarded
  against throughout. Returns `[{ score }]`, `score = P(follow-through)`. Batch by
  design (one call scores a whole overlay). Loads the versioned model once at
  startup; 503/empty if no model.
- Calibrated probability out, so downstream thresholds mean what they say.

## 7. Deployment (free tier)

- Add the ai-engine as a second Render **free** web service (uvicorn), its own
  entry in `render.yaml`. It sleeps when idle — same as the API.
- Set `AI_ENGINE_URL` on grw-api to the real ai-engine URL (replacing the
  `https://ai-engine.invalid` placeholder).
- Model artifact ships in the image (committed) or is trained via `/ml/train-
  patterns` post-deploy; v1 ships the trained artifact so scoring works on boot.

## 8. NestJS integration (fail-open)

- A thin client calls `/score-patterns`. **Fail-open**: if the ai-engine is
  asleep/down/slow, return no scores and move on — never block or break a
  user-facing path (the sidecar is optional infra). Timeboxed, cached.
- Wiring scores INTO the overlay (threshold filter / `pattern_quality` factor) is
  **Phase 3** — out of scope here. Phase 2 delivers: model trained + deployed +
  `/score-patterns` reachable + a NestJS client that can call it fail-open.

## 9. Error handling

- Export endpoint: secret-authed, fail-closed (like the other ML triggers).
- Training: if too few labeled rows (< a floor, e.g. 200) or one class absent,
  refuse with a clear message rather than train a degenerate model.
- Serving: no model / asleep / malformed input → fail-open (no score), never 500
  the caller.

## 10. Testing

- Feature engineer (Python): pure-function tests per feature; null-context → NaN;
  known window → known feature values.
- Training: on a synthetic labeled frame, asserts a model + metrics are produced;
  the < floor / single-class guards refuse.
- Serving: `/score-patterns` returns calibrated scores for a batch; no-model →
  fail-open.
- NestJS client: fail-open when the sidecar 503s / times out (unit test with a
  stubbed httpx).
- Export endpoint: auth (mirror ML trigger tests), pagination, excludes
  TIMEOUT/PENDING.

## 11. Out of scope

- Phase 3 overlay filtering / `pattern_quality` context factor.
- Phase 4 heartbeat-triggered retrain / drift monitoring.
- The scan heartbeat (separate, already-designed, deferred).
