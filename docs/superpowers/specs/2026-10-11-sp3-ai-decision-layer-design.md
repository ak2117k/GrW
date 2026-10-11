# SP3 — AI Decision Layer — Design

**Date:** 2026-10-11 · **Status:** brainstormed in conversation; pending written-spec review
**Parent:** `docs/superpowers/specs/2026-09-30-ai-trading-core-architecture-design.md` (§4, §6.3, §9.2–9.4, §11 SP3 row)
**Depends on:** SP2 (`2026-10-09-sp2-core-trade-lifecycle-design.md`) — M1/M2 merged; M3–M5 in progress.
SP1 M5 in progress. SP4 (news, FII/DII, events) for the overnight/holdings inputs.

## 1. Purpose and success

SP3 turns the AI from a single shadow exit-monitor into the decision layer of the core:
every setup is scored, priced across vehicles and judged before it becomes a `TradeIntent`, and
every LLM call in the system runs through one gateway that routes, budgets and records it. Every
decision — taken or skipped — lands in one provider-neutral **decision corpus** from which any model
(XGBoost today; another LLM, a fine-tuned model or an agent tomorrow) can be trained or prompted.

**Done when (parent §11):** AI decisions and skipped setups are journaled with outcomes, in paper,
end to end.

**Built in this branch (does not depend on SP2 M3–M5):**
- **M1 — AI Gateway** (Node), with the trade sentinel moved onto it, behaviour proved unchanged.
- **M2 — Decision corpus + ML scorer** (Python `ai-engine`), trained on legacy silo history.

**Specified here, built later:** vehicle pricer, LLM judge and `DecisionPipeline` → `TradeIntent`,
pre-judged fast path, overnight & holdings review, sentinel → Position Manager guard rails (§12).

**Out of scope:** news funnel, event calendar, picks (SP4); nightly learning and proposals (SP5);
live adapter (SP7). No file under `apps/api/src/modules/trade-core/`, `market-hub/` or
`options-chain/` is touched by this branch.

## 2. Owner decisions (2026-10-11)

| # | Decision |
|---|---|
| D1 | ML scorer: build serving + pipeline now; bootstrap-train on legacy silo trades; a model ships only if it passes the go/no-go gate (option A) |
| D2 | **Strategies are one input to the LLM's decision, not the decider.** The judge sees the setup, its rule score and the fired rules alongside ML score, context and vehicle prices. Authority order is unchanged: Risk Wall > strategy rules > AI — the AI may skip or shrink, never add risk |
| D3 | **Any model can be trained from the same data** — retrieval (in-context) for any LLM/agent, tabular export for classical models, fine-tune exports per provider (option C). Retrieval + tabular now; fine-tune exporters specified, built later |
| D4 | **Overnight positions and holdings are reviewed differently** — news since close, OI chain, FII/DII, global cues, VIX, sector. Holdings are now in scope (reverses the 2026-10-10 F&O-only scope for *review*; still no execution authority) |
| D5 | Sentinel on the gateway: **same requests and verdicts, plus fail-open audit rows**; its route is pinned to its current transport; no fallback until the owner enables one |
| D6 | **Language split:** gateway in Node (it sits on the live call paths, all in NestJS); scorer, corpus exporters, retrieval and training in Python |
| D7 | The legacy importer also reads GrW production's silo history (owner-run SSH tunnel) |
| D8 | Implementation by a team of agents (opus), two parallel streams in separate worktrees |

## 3. Architecture and module layout

```
NODE (NestJS)                                                   PYTHON (ai-engine)
 Strategies ─▶ Setup + rule score ─┐
 Context    ─▶ EvidenceSnapshot ───┼─▶ DecisionPipeline (later)
                                   │    1 conflicts
                                   │    2 ML score ───────── HTTP ─────▶ /score
                                   │    3 vehicle pricer (charges.ts)
                                   │    4 LLM judge ─┐
                                   │    5 TradeIntent → Risk Wall (SP2)
 Sentinel (live/overnight/thesis) ─┼─────────────────┤
 Overnight & holdings review ──────┘ (later)         ▼
                                    AI Gateway: routes · priority · budget · audit
                                    providers: anthropic-api | claude-cli | bedrock | (openai-compat, agents)
                                         │ fail-open
                                         ▼
                              ai_calls ──▶ ai_decision_records ◀── legacy importer, exporters,
                                     (Postgres, Prisma-owned)      retrieval, training (read/write ai_* only)
```

| Unit | Location | Built |
|---|---|---|
| AI Gateway | `apps/api/src/modules/ai-gateway/` | M1 |
| Decision corpus (schema) | `prisma/schema.prisma` (`ai_calls`, `ai_decision_records`, `ai_models`) | M1 (`ai_calls`), M2 (rest) |
| Scorer client (Node) | `apps/api/src/modules/ai-gateway/scorer/` — typed HTTP client, fail-open | M2 |
| Scorer, corpus, retrieval, training | `ai-engine/src/scorer/`, `ai-engine/src/corpus/`, `ai-engine/scripts/` | M2 |
| DecisionPipeline, vehicle pricer, judge | `apps/api/src/modules/ai-decision/` (new; beside trade-core, not inside it) | later |
| Overnight & holdings review | `ai-decision/overnight/` reusing the sentinel's overnight packet | later |

**Single-owner rules carried from the parent:** the gateway is the only code that talks to an LLM
provider; Prisma is the only schema owner (Python never migrates); only `DecisionPipeline` hands a
`TradeIntent` to the Risk Wall.

## 4. AI Gateway (M1)

### 4.1 Interface

```ts
interface AiGateway {
  call(job: AiJob, request: TransportRequest, ctx?: AiCallContext): Promise<TransportMessage>;
}
type AiJob =
  | 'sentinel.judge' | 'sentinel.overnight' | 'sentinel.thesis'          // live now
  | 'decision.judge' | 'review.overnight' | 'review.holdings'            // later
  | 'news.impact' | 'picks.next-day' | 'picks.pre-market'
  | 'learning.nightly' | 'strategy.draft';
interface AiCallContext { userId?: string; positionId?: string; setupId?: string; decisionRecordId?: string }
```

`TransportRequest` / `TransportMessage` are the existing types from
`trade-sentinel/services/llm-transport.ts`, moved to `ai-gateway/transport.types.ts` and
re-exported from the old path so no sentinel import changes meaning. The return value is exactly the
provider's `TransportMessage`; usage, cost and latency travel on a separate `ProviderResult.meta`
that only the gateway sees — the interface callers read is **not widened** (the transport note's rule).

### 4.2 Providers

`ProviderAdapter { name; send(request): Promise<{ message: TransportMessage; meta: CallMeta }> }`

| Provider | Source | Notes |
|---|---|---|
| `anthropic-api` | `new Anthropic({ apiKey })` from the sentinel module factory | schema-enforced; usage from the response |
| `claude-cli` | `ClaudeCliTransport`, **moved verbatim** | usage/cost read from the CLI envelope when present; never invented |
| `bedrock` | the existing Bedrock path + `bedrockModelId` | |
| later | `openai-compat`, agent SDKs | one adapter file + route config each |

### 4.3 Routes

One route per job: `{ provider, model, effort?, fallback: ProviderRef[], priority, maxTokens? }`.
Loaded from `config/ai-routes.json` with env overrides (`AI_ROUTE_<JOB>_PROVIDER`, `_MODEL`).

**Sentinel routes are derived, not configured.** `sentinel.*` take their provider from
`SENTINEL_JUDGE` (via `judgeTransportFrom`, unchanged) and their model/effort from the request the
sentinel already builds; their `fallback` is `[]`. The gateway never rewrites a sentinel request.
Enabling a fallback for the sentinel is a later, explicit owner change.

Defaults for later jobs follow parent §9.4 (Opus for picks/learning, Sonnet for pre-market/judge/
review with Opus on trigger, Haiku for news; CLI first, API fallback for the judge and reviews).

### 4.4 Priority

A single in-process scheduler with a concurrency limit per provider (`claude-cli`: 2 by default —
it shares the owner's subscription window). Order when saturated:
position review (`sentinel.*`, `review.*`) > `decision.judge` > `news.impact` > picks > `learning.*`.
A queued call that cannot start within its job's `maxWaitMs` fails with `AiQueueTimeout`
(callers already treat any failure as "no verdict"). Sentinel calls are never queued behind lower
priorities; with today's single caller the scheduler is a pass-through.

### 4.5 Budget meter

- Applies to **API-billed** providers only (`anthropic-api`, `bedrock`, later `openai-compat`); CLI
  calls record tokens with cost ₹0.
- Daily cap `AI_API_DAILY_CAP_INR` (initial ₹100, parent §9.4), per IST trading day, counted from
  `ai_calls.costInr`. Prices per model come from `config/ai-model-prices.json` (owner-maintained;
  seeded and marked for review — never constants in code).
- Pre-check: a call whose **worst-case** cost (`max_tokens` × output price + input estimate) would
  cross the cap is refused with `AiBudgetExceeded` before it is sent. Position-review jobs may use a
  reserved 25% of the cap that other jobs cannot touch.
- Unknown model price ⇒ the call is refused on API providers (fail closed on spend).

### 4.6 Audit (`ai_calls`)

One row per attempt: id, job, provider, model, effort, priority, userId?, positionId?, setupId?,
decisionRecordId?, requestHash (sha256 of the canonical request JSON), request (JSON),
response (JSON) or error class + message, stopReason, inputTokens?, outputTokens?, costInr, latencyMs,
queuedMs, fallbackFrom?, createdAt.

**Fail-open:** the write happens after the provider returns, in a `try/catch` that logs and
increments a health counter (`ai_audit_write_failures`). An audit failure never delays, changes or
fails the caller's result. Prompts are stored in full (they are the corpus); no credentials ever
enter a request object, and the CLI env scrub is unchanged.

### 4.7 Moving the sentinel (behaviour-preservation contract)

1. **Characterisation first.** Before any code moves, a golden test is committed against the
   *current* code: for fixed packets it captures, through fake providers,
   - the exact `TransportRequest` objects for `judge` (both tiers, cues on/off), `judgeOvernight`
     and the thesis call;
   - the CLI argv, the system-prompt-file text (prompt + `schemaInstruction`), stdin, and the child
     env (no `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`);
   - the parsed verdict / thesis for fixed replies, including `refusal`, `max_tokens` and
     `model_context_window_exceeded` stop reasons and fenced JSON;
   - the rows written to `sentinel_verdicts` / `sentinel_theses` and the log lines.
2. **Move.** `ANTHROPIC_CLIENT` is rebound to a `GatewayTransport` (`messages.create(params)` →
   `gateway.call(job, params)`). The job is supplied by three tiny job-bound instances
   (`SENTINEL_JUDGE_CLIENT`, …) so the services' call sites change only their injection token, not
   their request-building code.
3. **Prove.** The same golden test must pass unchanged, plus: deep-equality between the request the
   sentinel builds and the request the provider receives; the Anthropic SDK is called with exactly
   one argument; exactly one `ai_calls` row per call; a throwing audit repository leaves verdicts,
   rows and logs identical.
4. **Switch.** `AI_GATEWAY_SENTINEL=true|false` (default **false** at merge). `false` binds the
   pre-gateway factory exactly as today — the instant rollback. Flipped in prod by the owner after
   one shadow session compares verdict-for-verdict.

## 5. Decision corpus (M2)

### 5.1 Tables (Prisma-owned; Python writes via a scoped DB role)

**`ai_decision_records`** — one per decision point, provider-neutral:

| Field | Meaning |
|---|---|
| id, userId?, source | `core` · `sentinel` · `legacy:td_automation` · `legacy:grw_prod` |
| kind | `ENTRY_SETUP` · `POSITION_REVIEW` · `OVERNIGHT_REVIEW` · `HOLDINGS_REVIEW` |
| decidedAt, symbol, exchange, instrumentType, direction, vehicle?, strategyKey, strategyVersionId? | |
| setupGroupKey | dedup key (`alertId|symbol|date` for legacy) — the train/test split groups on it |
| evidence (JSON) | the EvidenceSnapshot / context packet as given to the decider |
| features (JSON) + featureSet | versioned vector, e.g. `fs1-legacy-checks` |
| ruleScore?, mlScore?, mlModelId? | |
| decision (JSON) | taken/skipped, verdict, confidence, thesis, invalidation, reason |
| aiCallIds (text[]) | links to `ai_calls` |
| outcome (JSON)? + outcomeAt? | netPnl, grossPnl, fees, win, rMultiple, mfe, mae, holdMins, priceAfter30m, priceAfterClose |

**`ai_models`** — registry: id, kind (`xgb-entry`), featureSet, trainedAt, dataWindow, nTrain,
nHoldout, metrics (JSON), gate (`GO`/`NO_GO` + reasons), artifactPath, active (bool, at most one
per kind).

DB role `grw_ai`: `SELECT` on journal/silo/candle tables, `INSERT/UPDATE` on
`ai_decision_records` and `ai_models` only. Created by deploy SQL, not by Prisma.

### 5.2 Writers

- **Sentinel (now, M1+M2):** after a verdict is persisted, a `POSITION_REVIEW`/`OVERNIGHT_REVIEW`
  record is written fail-open with the packet as evidence; outcome is filled when the watched
  position closes.
- **Legacy importer (M2, Python, one-shot, idempotent by `source+sourceId`):**
  - `TD_Automation` local DB: gated `trades`(+`watch_entries`), `ungated_*`, `adaptive_stop_*`;
    gated MISSED/DISMISSED entries as **skipped** records with MFE/MAE outcome.
  - GrW production silo tables, same mapping, over an owner-run SSH tunnel.
  - **Excluded:** `sell_futures_*` (P&L/lot-size integrity unverified), anand tables (too few rows),
    `ungated_rejections` (no follow-up prices), `signals` (no outcomes).
- **Core (later):** `DecisionPipeline` writes one record per setup, taken or skipped; SP2's journal
  outcome fills it.

### 5.3 Exporters and retrieval (Python)

- `export_tabular(featureSet, filters) → parquet` — features, labels, `setupGroupKey`, `decidedAt`.
- `similar(record, k, filters)` — k-nearest records on the standardised feature vector, filtered by
  strategy/vehicle/direction; returns their decisions and outcomes. Served as
  `POST /corpus/similar` for in-context prompts of any LLM or agent.
- **Later:** `export_finetune(provider, kind)` → provider chat JSONL (evidence → decision, filtered to
  good outcomes per a stated rule); spec'd here, built when a provider is chosen.

## 6. ML scorer (M2)

### 6.1 Features — `fs1-legacy-checks`

From the entry-time scoring breakdown (`initialBreakdown.checks[]`, present on ~2,460 legacy rows):
for each known check — MACD (1d/1m/5m), EMA9 vs EMA20, VWAP gap, ADX, RSI 5m, ATR%, volume ratio,
20-day breakout ratio, S/R room ratio, Nifty trend, sector trend, relative strength, SuperTrend —
three columns: `passed` (0/1), the raw indicator value, and `missing` (1 when absent or "insufficient
candles"). Plus `scoringVersion` (10- vs 15-check), `vixAtEntry`/`vixRegime`/`adRatio` (with missing
flags), minute-of-session, weekday, direction, strategy one-hot, profit-target source.
`initialScore` is **not** a feature (its weights changed mid-period). Leakage list enforced by test:
no `current*`, `maxFavorable/Adverse`, `closedReason` or event-table field.

**Train/serve parity:** one Python extractor (`features/fs1.py`) is used by both training and
`/score`; the Node client sends the same raw breakdown JSON, never pre-computed features.

### 6.2 Labels

- `win` = net P&L (gross − the record's own fees) > 0.
- `rMultiple` = net return ÷ initial risk; where no stop was stored (gated/ungated) the risk is the
  loss-cut in force at the time (0.4% of deployed capital; flat ₹1,000 before its change date) and
  the record is flagged `rDerived`.

### 6.3 Training and the go/no-go gate (`scripts/train_entry_scorer.py`)

- Dedup by `setupGroupKey` (2,285 legacy rows ≈ 1,755 setups); **grouped, time-ordered split** — the
  last 20% of trading days is the holdout; no group spans both sides.
- XGBoost classifier for P(win) (+ isotonic calibration on a grouped CV fold) and an XGBoost
  regressor for expected R.
- **Baseline:** the strategy's own pass-count, calibrated to win rate on the same folds.
- **GO only if, on the holdout:** ROC-AUC ≥ 0.60, AND Brier score better than the baseline, AND
  ≥ 300 holdout setups. Otherwise **NO-GO**: the model is registered with its reasons and not
  activated. A NO-GO is a normal, expected outcome (the July pattern model scored 0.49) and the
  report says so plainly.
- Metrics broken down by strategy, direction and VIX regime in the registry row.

### 6.4 Serving

- `POST /score` `{ featureSet, breakdown, context }` →
  `{ pWin, expectedR, source: 'model'|'rule', modelId?, featureSet, missing[] }`.
  With no active GO model, `source: 'rule'` (the calibrated baseline). Never a fabricated number:
  an unknown featureSet is a 422.
- Node `ScorerClient`: 1.5 s timeout, fail-open to `{ source: 'unavailable' }`. The pipeline (later)
  treats `unavailable` as "no ML score" — paper continues on rules; live entries obey `llm_required`.
- Retraining: weekly job (parent §9.2) once core-journal records exist; same gate.

### 6.5 Deployment

- `ai-engine/Dockerfile` (python slim + only scorer deps: fastapi, uvicorn, pandas, numpy,
  xgboost, scikit-learn, psycopg); compose service `ai-engine` on the internal network only
  (no Caddy route), `mem_limit: 384m`, healthcheck `/health`.
- `AI_ENGINE_URL=http://ai-engine:5000` (relax the boot validator's https rule for an internal
  `http://ai-engine` host only).
- **Before deploy:** owner measures VPS headroom (`free -m` with the API at steady state); if
  < 600 MB free, the container stays off and `/score` stays `unavailable` until resized.
- Artifacts: `/opt/grw/models/<modelId>.json` on a volume; never in git.

## 7. Decision pipeline (later — after SP2 M3–M5)

Per 1-minute close (parent §6.3): setups → conflicts (one per symbol, never both sides) → ML score →
**vehicle pricer** (plain code over `charges.ts`: cash, MTF interest, option theta over the horizon,
spread, liquidity; expected P&L after costs; best or none) → **LLM judge** (top few; job
`decision.judge`) → `TradeIntent` → Risk Wall.

**Judge packet** carries the strategy as evidence (D2): setup, rule score, which rules fired and
which failed, ML score with its source, vehicle comparison, EvidenceSnapshot, and the `k` most similar
past decisions with outcomes from `/corpus/similar`. Reply: take/skip, confidence, thesis,
invalidation conditions, size multiplier ∈ (0, 1] — it can shrink, never enlarge.

**Pre-judged path** (picks judged overnight carry zone/stop/target/vehicle/thesis) and the
**discovered** path (setup carries entry zone + expiry; skipped if price left the zone) as parent
§6.3. `llm_required` per StrategyVersion (default true for live). Every setup, taken or skipped,
writes an `ai_decision_records` row.

## 8. Overnight & holdings review (later — inputs from SP4)

Two jobs, one schedule (after close 15:45 NSE / 23:45 MCX; pre-open 08:50):

- `review.overnight` — F&O positions; the sentinel's existing overnight verdicts
  (HOLD_OVERNIGHT / EXIT_AT_OPEN / TIGHTEN_AT_OPEN + open plan), generalised onto core positions.
- `review.holdings` — delivery holdings; verdicts **HOLD / TRIM / EXIT_AT_OPEN / ADD_ALERT** with
  thesis and a change-my-mind level. **Advisory only:** holdings sit outside the core lifecycle, so
  the output is a notification and a corpus record, never an order.

Evidence packet: news since close (SP4 funnel), OI build-up / PCR / max pain, FII/DII cash and
derivatives flows (SP4), global cues (Nasdaq, crude, gold, US futures, GIFT Nifty), VIX, sector,
greeks for options, results/events calendar (SP4).

## 9. Sentinel → guard rails (later)

When the Position Manager (SP2 M4) owns positions, the sentinel's verdicts become a guard rail on
core positions: may tighten or exit, never widen or add (parent tighten-only invariant), through the
Position Manager's exit intent — never by calling Execution itself.

## 10. Error handling

| Failure | Behaviour |
|---|---|
| Provider error / timeout | Rethrown to caller unchanged (sentinel: "no verdict this tick"); audited |
| Fallback configured | Next provider tried; `fallbackFrom` recorded. Sentinel: none |
| Budget exceeded / unknown price | Refused before sending (`AiBudgetExceeded`); audited |
| Queue saturation | `AiQueueTimeout` after `maxWaitMs`; audited |
| Audit write fails | Logged + health counter; caller unaffected |
| Scorer down / slow | `source: 'unavailable'`; never blocks; health counter |
| No GO model | `source: 'rule'` |
| Importer row malformed | Skipped with a counted reason; import report lists counts per reason |

Entries fail closed; exits fail safe; no LLM → rules only (parent §12).

## 11. Testing

- **Node:** the §4.7 golden characterisation suite (written first, against unchanged code); route
  resolution; priority ordering; budget pre-check and reserve (property test: total API spend never
  exceeds the cap under any interleaving); audit fail-open; flag-off binding identical to today.
- **Python (pytest):** feature extractor with leakage guard; label derivation incl. `rDerived`;
  grouped split never leaks a group; gate logic on synthetic GO and NO-GO data; `/score` contract
  (model, rule, 422); importer idempotency on a fixture DB; `similar()` determinism.
- **Production evidence:** one shadow session with `AI_GATEWAY_SENTINEL=true` — verdict count and
  content match the previous session's behaviour profile; `ai_calls` rows present; zero audit
  failures. Training report committed to `docs/` with GO/NO-GO.

## 12. Milestones

| M | Deliverable | Depends on | Stream |
|---|---|---|---|
| **M1** | AI Gateway, providers moved, routes, priority, budget, `ai_calls`, sentinel behind `AI_GATEWAY_SENTINEL` with golden proof | — | A (now) |
| **M2** | `ai_decision_records`/`ai_models`, legacy importer, fs1 features, training + gate, `/score`, `/corpus/similar`, Node `ScorerClient`, ai-engine container | — | B (now) |
| M3 | Vehicle pricer | SP2 M3 | later |
| M4 | `DecisionPipeline` + judge → `TradeIntent`, pre-judged path, skipped-setup records | SP2 M4–M5 | later |
| M5 | Overnight & holdings review | SP4 inputs | later |
| M6 | Sentinel → guard rails on core positions; fine-tune exporters | SP2 M4 | later |

M1 and M2 run in parallel (separate worktrees branched from `feature/sp3-ai-decision`, merged back
in order M2 schema → M1 → M2 rest to keep one migration sequence). **SP3 done** after M4 in prod.

## 13. Open items

- Model prices in `config/ai-model-prices.json` — owner to confirm the INR figures.
- VPS memory headroom for the ai-engine container (owner measurement before deploy).
- SSH tunnel window for the GrW-production import (owner).
- Whether `sell_futures_*` P&L is repairable (lot-size check) — until then excluded.
- When to enable an API fallback for the sentinel — owner, after the shadow comparison.
