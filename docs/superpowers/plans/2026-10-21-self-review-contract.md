# Self-review loop — build contract (2026-10-21)

Owner decision: the application verifies every call it made against what happened next session, diagnoses the
misses, feeds **lessons** to the agent automatically, and raises **bounded rule/weight proposals that the owner
approves in the app**. Hard risk limits are never self-modified.

## Data (already in `prisma/schema.prisma`, migration `20261021200000_self_review`)

`verification_results`, `self_review_runs`, `agent_lessons`, `tuning_proposals`, `tuning_overrides` — see the
models' comments. Do not change these models without updating this file.

## What gets verified (nightly, per closed NSE session `S`)

| kind | source rows | "correct" means |
|---|---|---|
| `SCORECARD_TOTAL` | `analysis_scorecards` with `move_bp` filled, latest per (window, symbol) for S | band SUPPORTS/STRONG_SUPPORTS → move in `side`'s direction; AGAINST/STRONG_AGAINST → move against it; NEUTRAL → `correct=null`. `score` = move_bp signed by the call |
| `SCORECARD_FACTOR` | each factor in those scorecards, `refId = <scorecardId>:<factorName>` | factor points > 0 → move in side's direction; < 0 → against; 0/unavailable → null |
| `OVERNIGHT_VERDICT` | `sentinel_verdicts` from OVERNIGHT_REVIEW / PRE_OPEN_* windows (latest per tracker per night, re-runs included but flagged) | EXIT_AT_OPEN right if holding open→close of S lost premium; HOLD_OVERNIGHT right if it gained; TIGHTEN_AT_OPEN → null unless the move was large. `score` = ₹ saved (+) or missed (−) by following the verdict, from the option's own prices (candles_1m / tracker exit price / chain snapshot ltp), else underlying-move proxy flagged in `details` |
| `LIVE_EXIT` | `ai_exit_executions` FILLED + `ai_exit_outcomes` | right if the option was lower (for a long) 60 min after the fill (use the existing outcome rows) |
| `NEWS_IDEA` | `news_ideas` with outcome filled | CE_IDEA/PE_IDEA → move in the idea's direction; NO_TRADE → right when |move| < 1×ATR-equivalent OR the scorecard total was ≤ 0 and the move went against the headline sentiment; record but treat `NO_TRADE` as `correct=null` if unsure |
| `MBM_PREDICTION` | `mbm_predictions` with outcome | `(p ≥ 0.5) == outcome_big` |

Idempotent: `@@unique([kind, refId])` — re-runs upsert.

`summary` JSON of a run: `{ session, byKind: {kind: {n, right, wrong, nullCount, hitRate}}, byFactor: {name:
{n, right, wrong, hitRate, rolling5, rolling20}}, notable: [{kind, refId, symbol, why}] }`.

## Diagnose (one batched LLM call per run, after verify)

Input: the wrong calls of S (cap 15), each with its stored inputs (scorecard factors / verdict packet excerpt /
idea text) and the outcome; plus the active lessons. Output JSON:
`{ misses: [{refIds:[…], cause, category, lessonKey?, lessonText?, scope?, proposalTarget?, proposedValue?}] }`.
Use the existing sentinel judge transport (`SENTINEL_JUDGE=cli|api`, same model routing as the overnight review),
record the call in `ai_calls` if the recorder exists. Token cap: input ≤ ~30k, output ≤ ~3k.

## Lessons (automatic)

- Upsert `agent_lessons` by `key`; bump `wrongCount`/`rightCount` on each run where the lesson's pattern recurs
  (the diagnosis names the key) — `rightCount` = cases where following the lesson would have been right.
- A lesson is **injected** into the sentinel packet's `memory` block (and the news-ideas prompt for scope
  NEWS_IDEAS) only when `status=ACTIVE` and `rightCount ≥ 2`. Max 8 lessons, highest `rightCount − wrongCount`
  first, ≤ 400 chars each. Flag `SELF_REVIEW_LESSONS=off|observe|on` (default `on`; observe = log only).
- Auto-retire when `wrongCount > rightCount` after ≥ 5 cases.

## Proposals (owner approves in the app)

Only these **allow-listed targets**, each with hard bounds; anything else is rejected at creation:

| target | default (code) | bounds | consumer |
|---|---|---|---|
| `scorecard.factor.<name>.weight` for name ∈ oi, fii_dii, vix, expiry, news, indicators, mood | 1.0 | 0 – 1.5 | scorecard engine multiplies the factor's points, then rounds and clamps to −2..+2 |
| `scorecard.factor.news.requireConfirmation` | false | bool | news factor's positive points need indicators or oi ≥ 0 in the same direction |
| `exit.openingGuardMin` | 15 (env) | 0 – 30 | exit-discipline config (override wins over env) |
| `exit.persistMinSec` | 120 (env) | 60 – 600 | exit-discipline config |

Creation rules (deterministic, in code — the LLM may suggest, code decides):
- evidence ≥ 5 judged cases over the rolling window; e.g. a factor with rolling-20 hitRate < 0.45 → propose
  weight × 0.5; > 0.65 with n ≥ 20 → propose weight × 1.25 (bounded).
- one PENDING per `key`; PENDING older than 14 days → EXPIRED.
- **Never** a target touching max daily loss, max position size, kill switch, hold switch, daily exit cap, auto-exit
  enable/mode, broker or credentials.

Apply: `POST approve` → status APPROVED → write/replace `tuning_overrides(target)` → APPLIED. Reject → REJECTED.
Consumers read overrides through one cached `TuningService.get(target, default)` (refresh ≤ 60 s; DB failure →
code default). Every apply/reject is logged.

## API (`apps/api/src/modules/self-review/`, all `@AdminOnly()` except GET for the owner)

- `GET  /api/self-review/latest` → `{ run, summary, misses, lessonsAdded, proposalsPending }`
- `GET  /api/self-review/runs?limit=`
- `GET  /api/self-review/results?session=YYYY-MM-DD&kind=`
- `GET  /api/self-review/lessons` · `POST /api/self-review/lessons/:id/retire`
- `GET  /api/self-review/proposals?status=` · `POST /api/self-review/proposals/:id/approve` · `POST …/reject`
- `POST /api/self-review/run` (admin: re-run for the last closed session, background, returns `{started}`)

Night report: add a `selfReview` section (latest run summary + pending proposal count + lessons added) — fail-soft.

## Schedule

Cron 17:05 IST on NSE trading days (outcomes for S are filled by then — verify by reading the fill jobs; adjust if
not) + 09:00 IST catch-up for anything still unfilled. Flag `SELF_REVIEW_ENABLED` (default `true`).

## Web

- Night Report: "Self-review" section — yesterday's hits/misses per kind, top 3 misses with cause, lessons added.
- New page `/self-review`: tabs **Proposals** (Approve / Reject buttons, rationale, evidence counts + example
  links, current → proposed value), **Lessons** (text, right/wrong counts, Retire), **History** (runs, hit rates).
  Pending proposals show a badge in the nav.

## Streams

- **A (API core):** module skeleton, verification scorers for every kind, run orchestration + cron, summary,
  deterministic proposal engine, TuningService + overrides consumers (scorecard weights, news confirmation,
  exit-discipline), REST endpoints, night-report `selfReview` section. Owns `apps/api/src/modules/self-review/**`
  except `diagnose/` and `lessons/`.
- **B (diagnose + lessons):** `apps/api/src/modules/self-review/diagnose/**` and `lessons/**`, the batched LLM
  diagnosis call, lesson upsert/retire, injection into the sentinel packet `memory` block and the news-ideas prompt.
  Exposes `DiagnosisService.diagnose(runId, misses)` and `LessonsService.activeFor(scope)` for A to call.
- **C (web):** night-report section + `/self-review` page + API client + types, against the API shapes above.

Each stream: specs for its domain logic, jest/vitest green, `tsc` API ≤ 174 errors, commits with explicit
pathspecs, no push.
