# SP3 M0–M2 — AI Gateway and ML Scorer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One AI Gateway (Node) through which the live trade sentinel's LLM calls run with provably unchanged behaviour, plus a provider-neutral decision corpus and a gated XGBoost entry scorer served by `ai-engine` (Python).

**Architecture:** M0 adds one Prisma migration (`ai_calls`, `ai_decision_records`, `ai_models`) on `feature/sp3-ai-decision`. Then two parallel streams in separate worktrees: **Stream A** (Node) builds `apps/api/src/modules/ai-gateway/` and moves the sentinel onto it behind `AI_GATEWAY_SENTINEL` (default `false`); **Stream B** (Python) builds `ai-engine/src/corpus/` and `ai-engine/src/scorer/`, the legacy importer, training with a go/no-go gate, `/score` and `/corpus/similar`, and the container.

**Tech Stack:** NestJS 10 + TypeScript + Jest + Prisma (Postgres); Python 3.14 (local) / 3.12 (container), FastAPI, pandas, numpy, xgboost, scikit-learn, psycopg 3, pytest.

**Spec:** `docs/superpowers/specs/2026-10-11-sp3-ai-decision-layer-design.md`

## Global Constraints

- Do not modify anything under `apps/api/src/modules/trade-core/`, `apps/api/src/modules/market-hub/`, `apps/api/src/modules/options-chain/`.
- Sentinel prompt files (`trade-sentinel/prompts/*`), `sentinel-agent.service.ts`, `thesis.service.ts`, `sentinel-overnight.service.ts`, `sentinel-cycle.service.ts` are **not edited** (zero-diff). Only `trade-sentinel.module.ts`, `services/llm-transport.ts` (re-exports) and `adapters/claude-cli.transport.ts` (re-export) may change in that module.
- `AI_GATEWAY_SENTINEL` defaults to `false`; `false` must bind exactly today's factory (`SENTINEL_JUDGE=cli` → `ClaudeCliTransport`, else `new Anthropic({ apiKey })`).
- Sentinel routes have **no fallback**.
- API daily cap env `AI_API_DAILY_CAP_INR`, default `100`. Reserve for review jobs: 25% of the cap.
- Prices/routes live in JSON config files, never as constants in code.
- Python never runs Prisma migrations and writes only `ai_decision_records` and `ai_models`.
- Gate: GO only if holdout ROC-AUC ≥ 0.60 AND Brier < baseline Brier AND holdout setups ≥ 300.
- Excluded from import: `sell_futures_*`, anand tables (`intraday_entries`, `swing_entries`, `breakout_swing_entries`), `ungated_rejections`, `signals`.
- No parquet/pyarrow (disk budget: C: has < 2 GB free). Exports are CSV.
- Model artifacts never in git (`ai-engine/data/models/*.json` produced by training are gitignored except the pre-existing `pattern_quality_v1*`).
- Commits: Conventional Commits, explicit pathspecs (`git add <paths>`; never `git add -A` / `commit -a`), end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Node tests: `cd apps/api && npx jest <path>`; type check `cd apps/api && npx tsc --noEmit -p tsconfig.json`.
- Python tests: `cd ai-engine && .venv/Scripts/python -m pytest tests/<file> -q` (venv created in B1).

## Review Focus

1. **Audit row for a request containing a 100 KB packet** — the audit write must not slow or fail the call; `request` stored in full. Test in A5 (large payload, slow repository → caller resolves before audit completes).
2. **Two concurrent API calls racing the budget cap** — must never jointly exceed it. Property test in A3/A5 (reservation is taken synchronously before `await`).
3. **CLI envelope without usage fields** — tokens recorded as `null`, cost ₹0, never invented. Test in A2.
4. **Legacy rows whose `initialBreakdown` is null or has unknown check names** — skipped with a counted reason / unknown checks ignored (not crash). Tests in B2 and B4.
5. **ai-engine down or slow while Node calls `/score`** — `{ source: 'unavailable' }` within 1.5 s, never throws. Test in A7.

---

## File Structure

```
prisma/schema.prisma                                   (M0) + AiCall, AiDecisionRecord, AiModel
prisma/migrations/20261011120000_sp3_m0_ai_corpus/migration.sql   (M0)
deploy/sql/grw-ai-role.sql                             (M0) DB role for ai-engine

apps/api/src/modules/ai-gateway/
  ai-gateway.module.ts            module; exports AI_GATEWAY, ScorerClient
  transport.types.ts              TransportRequest/Message/ContentBlock, MessagesTransport (moved)
  ai-job.ts                       AiJob union, REVIEW_JOBS, priority rank
  providers/provider.types.ts     ProviderAdapter, ProviderResult, CallMeta
  providers/anthropic-api.provider.ts
  providers/claude-cli.provider.ts  (ClaudeCliTransport moved here, + meta)
  routes/route-config.ts          load/validate ai-routes.json + env overrides
  budget/model-prices.ts          load ai-model-prices.json; cost/worst-case
  budget/budget-meter.ts          daily cap, reserve, reservations
  scheduler/priority-scheduler.ts per-provider concurrency, priority queue, maxWait
  audit/ai-call.repository.ts     insert ai_calls (fail-open caller)
  ai-gateway.service.ts           call(job, request, ctx)
  sentinel/sentinel-gateway.transport.ts  MessagesTransport → gateway, job by schema identity
  scorer/scorer.client.ts         HTTP client to ai-engine /score, fail-open
config/ai-routes.json
config/ai-model-prices.json

apps/api/src/modules/trade-sentinel/
  golden/sentinel-golden.spec.ts  (A1) characterisation suite
  golden/golden-fixtures.ts       (A1)
  golden/__snapshots__/…          (A1, jest snapshots, committed)
  services/llm-transport.ts       (A2) re-export moved types
  adapters/claude-cli.transport.ts (A2) re-export moved class
  trade-sentinel.module.ts        (A6) flag binding

ai-engine/
  requirements-scorer.txt         (B1) minimal deps for scorer/container
  pytest.ini                      (B1)
  src/corpus/__init__.py
  src/corpus/db.py                (B4) psycopg connection helpers
  src/corpus/legacy_mapping.py    (B4) pure row → record mapping
  src/corpus/importer.py          (B4) idempotent upsert
  src/corpus/sentinel_records.py  (B4) ai_calls → POSITION_REVIEW records
  src/corpus/export.py            (B5) tabular CSV export
  src/corpus/split.py             (B5) grouped time-ordered split
  src/corpus/similar.py           (B7) kNN retrieval
  src/scorer/__init__.py
  src/scorer/features_fs1.py      (B2)
  src/scorer/labels.py            (B3)
  src/scorer/train.py             (B6) train + baseline + gate
  src/scorer/registry.py          (B6) ai_models rows, artifact paths
  src/scorer/serve.py             (B7) model holder + rule fallback
  src/routes/scorer.py            (B7) /score, /corpus/similar
  scripts/import_legacy.py        (B4 CLI)
  scripts/train_entry_scorer.py   (B6 CLI)
  Dockerfile                      (B8)
  tests/test_*.py
deploy/docker-compose.prod.yml    (B8) ai-engine service
apps/api/src/common/config/validate-boot-config.ts (B8) allow http://ai-engine
docs/sp3/training-report-<date>.md (B9)
```

---

## M0 — shared schema (on `feature/sp3-ai-decision`, before the streams fork)

### Task 0: Prisma models, migration, DB role, spec amendments

**Files:**
- Modify: `prisma/schema.prisma` (append three models at the end)
- Create: `prisma/migrations/20261011120000_sp3_m0_ai_corpus/migration.sql`
- Create: `deploy/sql/grw-ai-role.sql`
- Modify: `docs/superpowers/specs/2026-10-11-sp3-ai-decision-layer-design.md` §4.7 step 2 and §5.3

**Interfaces — Produces:** Prisma delegates `prisma.aiCall`, `prisma.aiDecisionRecord`, `prisma.aiModel`; tables `ai_calls`, `ai_decision_records`, `ai_models` with the exact column names below (Python uses them verbatim, camelCase, quoted).

- [ ] **Step 1: Append models to `prisma/schema.prisma`**

```prisma
/// SP3 — one row per LLM call attempt through the AI Gateway (spec §4.6). Append-only.
model AiCall {
  id               String   @id @default(cuid())
  job              String
  provider         String
  model            String
  effort           String?
  priority         Int
  userId           String?
  positionId       String?
  setupId          String?
  decisionRecordId String?
  requestHash      String
  request          Json
  response         Json?
  errorClass       String?
  errorMessage     String?
  stopReason       String?
  inputTokens      Int?
  outputTokens     Int?
  costInr          Decimal  @default(0) @db.Decimal(12, 4)
  latencyMs        Int
  queuedMs         Int      @default(0)
  fallbackFrom     String?
  createdAt        DateTime @default(now())

  @@index([job, createdAt])
  @@index([createdAt])
  @@map("ai_calls")
}

/// SP3 — provider-neutral decision corpus (spec §5.1). Written by Node (core, later) and Python (importer).
model AiDecisionRecord {
  id                String    @id @default(cuid())
  userId            String?
  source            String    // core | sentinel | legacy:td_automation | legacy:grw_prod
  sourceId          String    // idempotency key within source
  kind              String    // ENTRY_SETUP | POSITION_REVIEW | OVERNIGHT_REVIEW | HOLDINGS_REVIEW
  decidedAt         DateTime
  symbol            String
  exchange          String?
  instrumentType    String?
  direction         String?   // LONG | SHORT
  vehicle           String?
  strategyKey       String
  strategyVersionId String?
  setupGroupKey     String
  evidence          Json
  featureSet        String?
  features          Json?
  ruleScore         Float?
  mlScore           Float?
  mlModelId         String?
  decision          Json
  aiCallIds         String[]  @default([])
  outcome           Json?
  outcomeAt         DateTime?
  createdAt         DateTime  @default(now())

  @@unique([source, sourceId])
  @@index([kind, decidedAt])
  @@index([setupGroupKey])
  @@map("ai_decision_records")
}

/// SP3 — trained model registry (spec §5.1). At most one active row per kind (partial unique index in SQL).
model AiModel {
  id           String   @id
  kind         String   // xgb-entry
  featureSet   String
  trainedAt    DateTime
  dataWindow   Json
  nTrain       Int
  nHoldout     Int
  metrics      Json
  gate         String   // GO | NO_GO
  gateReasons  String[] @default([])
  artifactPath String
  active       Boolean  @default(false)
  createdAt    DateTime @default(now())

  @@index([kind, active])
  @@map("ai_models")
}
```

- [ ] **Step 2: Write the migration SQL by hand** (no shadow DB locally; style follows `prisma/migrations/20261010120000_sp2_m2_risk_wall/migration.sql`). Exact content:

```sql
-- SP3 M0 — AI call audit, decision corpus, model registry
-- (docs/superpowers/specs/2026-10-11-sp3-ai-decision-layer-design.md §4.6, §5.1). Expand-only.

CREATE TABLE "ai_calls" (
    "id" TEXT NOT NULL,
    "job" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "effort" TEXT,
    "priority" INTEGER NOT NULL,
    "userId" TEXT,
    "positionId" TEXT,
    "setupId" TEXT,
    "decisionRecordId" TEXT,
    "requestHash" TEXT NOT NULL,
    "request" JSONB NOT NULL,
    "response" JSONB,
    "errorClass" TEXT,
    "errorMessage" TEXT,
    "stopReason" TEXT,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "costInr" DECIMAL(12,4) NOT NULL DEFAULT 0,
    "latencyMs" INTEGER NOT NULL,
    "queuedMs" INTEGER NOT NULL DEFAULT 0,
    "fallbackFrom" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ai_calls_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ai_calls_job_createdAt_idx" ON "ai_calls"("job", "createdAt");
CREATE INDEX "ai_calls_createdAt_idx" ON "ai_calls"("createdAt");

CREATE TABLE "ai_decision_records" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "source" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL,
    "symbol" TEXT NOT NULL,
    "exchange" TEXT,
    "instrumentType" TEXT,
    "direction" TEXT,
    "vehicle" TEXT,
    "strategyKey" TEXT NOT NULL,
    "strategyVersionId" TEXT,
    "setupGroupKey" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "featureSet" TEXT,
    "features" JSONB,
    "ruleScore" DOUBLE PRECISION,
    "mlScore" DOUBLE PRECISION,
    "mlModelId" TEXT,
    "decision" JSONB NOT NULL,
    "aiCallIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "outcome" JSONB,
    "outcomeAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ai_decision_records_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ai_decision_records_source_sourceId_key" ON "ai_decision_records"("source", "sourceId");
CREATE INDEX "ai_decision_records_kind_decidedAt_idx" ON "ai_decision_records"("kind", "decidedAt");
CREATE INDEX "ai_decision_records_setupGroupKey_idx" ON "ai_decision_records"("setupGroupKey");

CREATE TABLE "ai_models" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "featureSet" TEXT NOT NULL,
    "trainedAt" TIMESTAMP(3) NOT NULL,
    "dataWindow" JSONB NOT NULL,
    "nTrain" INTEGER NOT NULL,
    "nHoldout" INTEGER NOT NULL,
    "metrics" JSONB NOT NULL,
    "gate" TEXT NOT NULL,
    "gateReasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "artifactPath" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ai_models_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ai_models_kind_active_idx" ON "ai_models"("kind", "active");
-- At most one active model per kind; only a GO model may be active.
CREATE UNIQUE INDEX "ai_models_one_active_per_kind" ON "ai_models"("kind") WHERE "active";
ALTER TABLE "ai_models" ADD CONSTRAINT "ai_models_active_requires_go" CHECK (NOT "active" OR "gate" = 'GO');

-- ai_calls is append-only (spec §4.6).
CREATE OR REPLACE FUNCTION ai_calls_append_only() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'ai_calls is append-only'; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER ai_calls_no_update_delete BEFORE UPDATE OR DELETE ON "ai_calls"
  FOR EACH ROW EXECUTE FUNCTION ai_calls_append_only();
```

- [ ] **Step 3: Create `deploy/sql/grw-ai-role.sql`** (owner runs once on the VPS; idempotent)

```sql
-- SP3: the ai-engine's database login (spec §5.1). Run as the DB owner:
--   docker exec -i grw-postgres psql -U "$PG_USER" -d "$PG_DB" -v ai_password='<secret>' -f - < grw-ai-role.sql
-- psql variables are NOT substituted inside $$ … $$ bodies, so the conditional CREATE uses \gexec.
SELECT format('CREATE ROLE grw_ai LOGIN PASSWORD %L', :'ai_password')
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grw_ai') \gexec
SELECT format('ALTER ROLE grw_ai PASSWORD %L', :'ai_password') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO grw_ai', current_database()) \gexec
GRANT USAGE ON SCHEMA public TO grw_ai;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO grw_ai;
GRANT INSERT, UPDATE ON "ai_decision_records", "ai_models" TO grw_ai;
```
(Users/credentials tables are readable by this role; acceptable for a single-owner box, listed in spec §13 for the SaaS review. Tables created later need a re-run — documented in the file header.)

- [ ] **Step 4: Amend the spec** — §4.7 step 2 becomes: "`ANTHROPIC_CLIENT` is rebound to a `SentinelGatewayTransport` whose `messages.create(params)` calls `gateway.call(job, params)`; the job is inferred from the request's schema **object identity** (`VERDICT_SCHEMA` → `sentinel.judge`, `OVERNIGHT_VERDICT_SCHEMA` → `sentinel.overnight`, `THESIS_SCHEMA` → `sentinel.thesis`, anything else → `sentinel.unknown`), so no sentinel service file changes at all." §5.3: replace "parquet" with "CSV". §13: add "`grw_ai` can read every table (incl. users); narrow before SaaS."

- [ ] **Step 5: Validate and generate client**

Run: `npx prisma validate && npx prisma generate`
Expected: "The schema at prisma/schema.prisma is valid", client generated. (Note: `prisma generate` writes the shared client in the main checkout's node_modules; re-run from main after merge.)

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20261011120000_sp3_m0_ai_corpus/migration.sql deploy/sql/grw-ai-role.sql docs/superpowers/specs/2026-10-11-sp3-ai-decision-layer-design.md
git commit -m "feat(ai-corpus): ai_calls, ai_decision_records, ai_models schema and grw_ai role"
```

---

## Stream A — AI Gateway (Node). Worktree `.claude/worktrees/sp3-a-gateway`, branch `feature/sp3-m1-gateway` from `feature/sp3-ai-decision` after Task 0.

### Task A1: Golden characterisation suite (against UNCHANGED code)

**Files:**
- Create: `apps/api/src/modules/trade-sentinel/golden/golden-fixtures.ts`
- Create: `apps/api/src/modules/trade-sentinel/golden/sentinel-golden.spec.ts`
- Snapshots created by jest: `apps/api/src/modules/trade-sentinel/golden/__snapshots__/sentinel-golden.spec.ts.snap`

**Interfaces — Produces:** `export function runGoldenScenarios(makeClient: (rec: Recorder) => MessagesTransport): Promise<GoldenRecord[]>` in `golden-fixtures.ts`, where
```ts
export interface Recorder { requests: unknown[]; reply: (req: unknown) => { content: {type:string;text?:string}[]; stop_reason: string|null } }
export interface GoldenRecord { scenario: string; request: unknown; result: unknown; logs: string[] }
```
A6 re-runs the same scenarios through the gateway-backed client and compares against the same snapshots.

Scenarios (each builds the REAL service with fakes for config/repos, exactly as existing specs do — copy the `base: ContextPacket` fixture style from `services/sentinel-agent.service.spec.ts`, and the thesis fixture from `services/thesis.service.spec.ts`; the overnight packet from `services/sentinel-agent.overnight.spec.ts`):

1. `judge-fire-cues-on` — `SentinelAgentService.judge(packet, 'FIRE')` with `MARKET_CUES_ENABLED=true`, reply = valid HOLD verdict JSON citing real packet paths.
2. `judge-heartbeat-cues-off` — trigger `'HEARTBEAT'` (routine tier), cues off.
3. `judge-env-overrides` — `SENTINEL_MODEL_TRIGGERED=x-model`, `SENTINEL_EFFORT_TRIGGERED=low`.
4. `judge-fenced-json` — reply text wrapped in ```json fences (API path does not strip; record the outcome, whatever it is).
5. `judge-refusal`, `judge-max-tokens`, `judge-context-exceeded` — stop reasons; record thrown error message.
6. `overnight` — `judgeOvernight(packet)` valid HOLD_OVERNIGHT reply.
7. `thesis` — `ThesisService` build for one tick (reply valid thesis JSON).
8. `transport-throws` — client rejects with `new RateLimitError(...)` (as the existing spec does); record the error class and the logger.error line.

For every scenario record: the exact request object passed to `messages.create` (deep, via `JSON.parse(JSON.stringify(req))` after asserting `arguments.length === 1`), the resolved verdict / thrown `{name,message}`, and logger lines (spy on `Logger.prototype.error/warn/log`).

CLI scenarios (on `ClaudeCliTransport` directly, mocking `node:child_process.spawn` with `jest.mock`):

9. `cli-argv-and-env` — call `create(request from scenario 1)`; record the command line string passed to spawn, `shell`/`windowsHide` options, the env keys minus volatile ones (assert `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` absent even when set on `process.env` before the call), stdin text, and the system-prompt file CONTENT (read the path from the argv). Replace the temp dir path with `<TMP>` before snapshotting.
10. `cli-envelope-ok` / `cli-envelope-fenced` / `cli-envelope-is-error-401` / `cli-envelope-empty-result` / `cli-nonzero-exit` / `cli-timeout` (use jest fake timers, `CLI_TIMEOUT_MS`) — record resolved message or error message.

- [ ] **Step 1: Write `golden-fixtures.ts`** with the scenario table above and the recorder; **Step 2:** write `sentinel-golden.spec.ts`:

```ts
import { runGoldenScenarios, recordingClient } from './golden-fixtures';

describe('sentinel golden characterisation (pre-gateway baseline)', () => {
  it('matches the recorded baseline for every scenario', async () => {
    const records = await runGoldenScenarios((rec) => recordingClient(rec));
    for (const r of records) expect(r).toMatchSnapshot(r.scenario);
  });
  it('covers every scenario name exactly once', async () => {
    const records = await runGoldenScenarios((rec) => recordingClient(rec));
    expect(records.map((r) => r.scenario).sort()).toEqual([...SCENARIO_NAMES].sort());
  });
});
```
(`SCENARIO_NAMES` exported from fixtures; the CLI scenarios live in a second `describe` in the same file.)

- [ ] **Step 3: Run** `cd apps/api && npx jest src/modules/trade-sentinel/golden` — Expected: PASS, snapshot file written (`N snapshots written`).
- [ ] **Step 4: Run again** — Expected: PASS with `N passed` snapshots, 0 written (deterministic). If a value is non-deterministic (timestamps, cuid, tmp path), normalise it in the fixture, never in the service.
- [ ] **Step 5: Verify zero production diff:** `git diff --stat main -- apps/api/src/modules/trade-sentinel ':!apps/api/src/modules/trade-sentinel/golden'` — Expected: empty.
- [ ] **Step 6: Commit** `git add apps/api/src/modules/trade-sentinel/golden && git commit -m "test(trade-sentinel): golden characterisation of LLM requests, CLI transport and verdict parsing"`

### Task A2: Transport types and providers moved into ai-gateway

**Files:**
- Create: `apps/api/src/modules/ai-gateway/transport.types.ts` — move the four interfaces (`TransportContentBlock`, `TransportMessage`, `TransportRequest`, `MessagesTransport`) verbatim with their doc comments from `trade-sentinel/services/llm-transport.ts`.
- Modify: `trade-sentinel/services/llm-transport.ts` — replace the moved declarations with `export type { TransportContentBlock, TransportMessage, TransportRequest, MessagesTransport } from '../../ai-gateway/transport.types';` (keep `judgeTransportFrom`, `JudgeTransportName`, `bedrockModelId` where they are).
- Create: `apps/api/src/modules/ai-gateway/providers/provider.types.ts`
- Create: `apps/api/src/modules/ai-gateway/providers/claude-cli.provider.ts` — `git mv` `trade-sentinel/adapters/claude-cli.transport.ts` here (keep class name `ClaudeCliTransport` and all exports), then add `ClaudeCliProvider`.
- Modify: `trade-sentinel/adapters/claude-cli.transport.ts` — recreate as `export * from '../../ai-gateway/providers/claude-cli.provider';`
- Move test: `trade-sentinel/adapters/claude-cli.transport.spec.ts` stays (imports via the re-export) — must pass unchanged.
- Create: `apps/api/src/modules/ai-gateway/providers/anthropic-api.provider.ts`
- Test: `apps/api/src/modules/ai-gateway/providers/providers.spec.ts`

**Interfaces — Produces:**
```ts
// provider.types.ts
import type { TransportMessage, TransportRequest } from '../transport.types';
export type ProviderName = 'anthropic-api' | 'claude-cli';
export interface CallMeta { inputTokens: number | null; outputTokens: number | null; billed: boolean }
export interface ProviderResult { message: TransportMessage; meta: CallMeta }
export interface ProviderAdapter { readonly name: ProviderName; send(request: TransportRequest): Promise<ProviderResult> }
```
- `ClaudeCliTransport` gains a public method `createWithMeta(params): Promise<ProviderResult>`; `messages.create` remains `createWithMeta(params).then(r => r.message)` — identical message. Meta from envelope `usage.input_tokens` / `usage.output_tokens` when numbers, else `null`; `billed: false`. Add `usage?: { input_tokens?: unknown; output_tokens?: unknown }` to `CliEnvelope`.
- `ClaudeCliProvider implements ProviderAdapter { name = 'claude-cli'; constructor(cli: ClaudeCliTransport); send = (r) => cli.createWithMeta(r) }`.
- `AnthropicApiProvider implements ProviderAdapter { name = 'anthropic-api'; constructor(client: { messages: { create(p: TransportRequest): Promise<TransportMessage & { usage?: { input_tokens?: number; output_tokens?: number } }> } }) }` — calls `client.messages.create(request)` with **exactly one argument**, returns `{ message: { content, stop_reason }, meta: { inputTokens, outputTokens, billed: true } }`. The message passed back must be the SDK object itself (same reference) so downstream sees exactly what it saw before.

- [ ] **Step 1: Failing tests** in `providers.spec.ts`:
  - API provider: `create` called with one arg deep-equal to request; returned `message` is the same reference as the SDK reply; meta tokens from `usage`; `billed: true`; SDK rejection propagates the same error instance.
  - CLI provider: with mocked spawn emitting `{"result":"{}","stop_reason":"end_turn","usage":{"input_tokens":12,"output_tokens":3}}` → meta `{12,3,false}`; envelope without `usage` → `{null,null,false}` (Review Focus 3); `messages.create` on the same envelope returns a message deep-equal to `createWithMeta(...).message`.
- [ ] **Step 2:** `npx jest src/modules/ai-gateway/providers` → FAIL (modules missing).
- [ ] **Step 3:** Implement the moves and providers as specified.
- [ ] **Step 4:** Run `npx jest src/modules/ai-gateway src/modules/trade-sentinel` → all PASS, golden snapshots unchanged (0 written, 0 updated). `npx tsc --noEmit -p tsconfig.json` → no errors.
- [ ] **Step 5: Commit** `git add apps/api/src/modules/ai-gateway apps/api/src/modules/trade-sentinel/services/llm-transport.ts apps/api/src/modules/trade-sentinel/adapters/claude-cli.transport.ts && git commit -m "refactor(ai-gateway): move transport types and CLI transport into ai-gateway providers"`

### Task A3: Jobs, routes, model prices, budget meter

**Files:**
- Create: `apps/api/src/modules/ai-gateway/ai-job.ts`
- Create: `apps/api/src/modules/ai-gateway/routes/route-config.ts`
- Create: `apps/api/src/modules/ai-gateway/budget/model-prices.ts`
- Create: `apps/api/src/modules/ai-gateway/budget/budget-meter.ts`
- Create: `config/ai-routes.json`, `config/ai-model-prices.json`
- Test: `routes/route-config.spec.ts`, `budget/budget-meter.spec.ts`, `budget/model-prices.spec.ts`

**Interfaces — Produces:**
```ts
// ai-job.ts
export const AI_JOBS = ['sentinel.judge','sentinel.overnight','sentinel.thesis','sentinel.unknown',
  'decision.judge','review.overnight','review.holdings','news.impact','picks.next-day',
  'picks.pre-market','learning.nightly','strategy.draft'] as const;
export type AiJob = (typeof AI_JOBS)[number];
/** Lower = more urgent. Spec §4.4. */
export function priorityOf(job: AiJob): number; // sentinel.* & review.* → 0, decision.judge → 1, news.impact → 2, picks.* → 3, learning.*/strategy.draft → 4
export function isReviewJob(job: AiJob): boolean; // priorityOf(job) === 0

// route-config.ts
export interface AiRoute { provider: ProviderName; model: string | null; fallback: ProviderName[]; maxWaitMs: number }
export function loadRoutes(json: unknown, env: NodeJS.ProcessEnv): Record<AiJob, AiRoute>;
// - sentinel.* routes: provider = judgeTransportFrom(env.SENTINEL_JUDGE) === 'cli' ? 'claude-cli' : 'anthropic-api';
//   model = null (use the request's model untouched); fallback = []; ignores json and AI_ROUTE_* for sentinel.* (spec §4.3).
// - other jobs: from json, overridden by AI_ROUTE_<JOB_UPPER_SNAKE>_PROVIDER / _MODEL (e.g. AI_ROUTE_DECISION_JUDGE_MODEL).
// - throws Error('ai-routes: …') on unknown job key, unknown provider, missing job.

// model-prices.ts
export interface ModelPrice { inputPerMTokInr: number; outputPerMTokInr: number }
export function loadPrices(json: unknown): Map<string, ModelPrice>; // keys = model ids
export function costInr(p: ModelPrice, inTok: number, outTok: number): number;
export function worstCaseInr(p: ModelPrice, request: TransportRequest): number; // input estimate = ceil(JSON chars/3) tokens; output = max_tokens

// budget-meter.ts
export class AiBudgetExceeded extends Error {}
export class BudgetMeter {
  constructor(opts: { capInr: number; reserveShare: number; spentToday: () => Promise<number>; now: () => Date });
  /** Synchronous reservation; throws AiBudgetExceeded. Review jobs may use the full cap; others only cap*(1-reserveShare). */
  reserve(job: AiJob, worstCaseInr: number): { settle(actualInr: number): void; release(): void };
  /** Loads today's spend (IST day) once per day boundary; call before reserve on first use. */
  refresh(): Promise<void>;
}
```
Config contents:
```json
// config/ai-routes.json
{ "decision.judge": { "provider": "claude-cli", "model": "claude-sonnet-5", "fallback": ["anthropic-api"], "maxWaitMs": 20000 },
  "review.overnight": { "provider": "claude-cli", "model": "claude-sonnet-5", "fallback": ["anthropic-api"], "maxWaitMs": 120000 },
  "review.holdings": { "provider": "claude-cli", "model": "claude-sonnet-5", "fallback": ["anthropic-api"], "maxWaitMs": 120000 },
  "news.impact": { "provider": "claude-cli", "model": "claude-haiku-4-5", "fallback": [], "maxWaitMs": 60000 },
  "picks.next-day": { "provider": "claude-cli", "model": "claude-opus-5", "fallback": [], "maxWaitMs": 600000 },
  "picks.pre-market": { "provider": "claude-cli", "model": "claude-sonnet-5", "fallback": [], "maxWaitMs": 300000 },
  "learning.nightly": { "provider": "claude-cli", "model": "claude-opus-5", "fallback": [], "maxWaitMs": 1800000 },
  "strategy.draft": { "provider": "claude-cli", "model": "claude-opus-5", "fallback": [], "maxWaitMs": 600000 } }
```
```json
// config/ai-model-prices.json — INR per million tokens. SEEDED, OWNER TO REVIEW (spec §13).
{ "_note": "Seed values at ~₹88/USD from published USD list prices; owner confirms.",
  "claude-opus-5":   { "inputPerMTokInr": 440, "outputPerMTokInr": 2200 },
  "claude-sonnet-5": { "inputPerMTokInr": 264, "outputPerMTokInr": 1320 },
  "claude-haiku-4-5": { "inputPerMTokInr": 88, "outputPerMTokInr": 440 } }
```
(Before writing the prices, the implementer loads the `claude-api` skill to read current list prices and uses them; the `_note` records the date and FX rate used.)

- [ ] **Step 1: Failing tests:**
  - routes: sentinel jobs ignore json + `AI_ROUTE_SENTINEL_JUDGE_PROVIDER`; `SENTINEL_JUDGE=cli` → claude-cli, unset/garbage → anthropic-api, fallback `[]`, model `null`; env override `AI_ROUTE_DECISION_JUDGE_MODEL=x` applied; unknown provider throws; the shipped `config/ai-routes.json` loads.
  - prices: cost arithmetic; worst case uses `max_tokens`; unknown model → `loadPrices(...).get()` undefined.
  - budget: non-review job refused at `cap*0.75`; review job allowed up to `cap`; `settle` replaces the reservation with actual; `release` frees it; **property test** (loop 500 random interleavings of reserve/settle/release with random amounts using a seeded PRNG): committed+reserved never exceeds cap at any step (Review Focus 2); day rollover at 00:00 IST resets (use `now` injection, `Asia/Kolkata` day key via `Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata'})`).
- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** run → PASS; tsc clean.
- [ ] **Step 5: Commit** `git add apps/api/src/modules/ai-gateway/ai-job.ts apps/api/src/modules/ai-gateway/routes apps/api/src/modules/ai-gateway/budget config/ai-routes.json config/ai-model-prices.json && git commit -m "feat(ai-gateway): job routes, model prices and daily API budget meter"`

### Task A4: Priority scheduler

**Files:** Create `apps/api/src/modules/ai-gateway/scheduler/priority-scheduler.ts`, test `priority-scheduler.spec.ts`.

**Interfaces — Produces:**
```ts
export class AiQueueTimeout extends Error {}
export class PriorityScheduler {
  constructor(limits: Partial<Record<ProviderName, number>>); // default claude-cli: 2, anthropic-api: 8
  /** Runs fn when a slot for `provider` is free; higher priority (lower number) first, FIFO within a priority.
   *  Rejects with AiQueueTimeout if not started within maxWaitMs. Resolves {result, queuedMs}. */
  run<T>(provider: ProviderName, priority: number, maxWaitMs: number, fn: () => Promise<T>): Promise<{ result: T; queuedMs: number }>;
}
```
Limit for `claude-cli` read in the module from `AI_CLI_CONCURRENCY` (default 2).

- [ ] **Step 1: Failing tests** (jest fake timers): with limit 1, a running call blocks; queued priority-4 then priority-0 → priority-0 starts first; FIFO within equal priority; timeout rejects with `AiQueueTimeout` and the queued fn never runs; a slot is freed when fn rejects; with free slots, `queuedMs === 0` and fn starts synchronously in the same tick (pass-through for today's single caller).
- [ ] **Steps 2–4:** fail → implement → pass.
- [ ] **Step 5: Commit** `git add apps/api/src/modules/ai-gateway/scheduler && git commit -m "feat(ai-gateway): per-provider priority scheduler with queue timeout"`

### Task A5: Audit repository and `AiGatewayService`

**Files:**
- Create: `apps/api/src/modules/ai-gateway/audit/ai-call.repository.ts`
- Create: `apps/api/src/modules/ai-gateway/ai-gateway.service.ts`
- Create: `apps/api/src/modules/ai-gateway/ai-gateway.module.ts`
- Test: `audit/ai-call.repository.spec.ts`, `ai-gateway.service.spec.ts`

**Interfaces — Consumes:** A2 `ProviderAdapter`, A3 `loadRoutes/BudgetMeter/loadPrices/costInr/worstCaseInr/priorityOf`, A4 `PriorityScheduler`. **Produces:**
```ts
export const AI_GATEWAY = 'AI_GATEWAY';
export interface AiCallContext { userId?: string; positionId?: string; setupId?: string; decisionRecordId?: string }
export interface AiGateway { call(job: AiJob, request: TransportRequest, ctx?: AiCallContext): Promise<TransportMessage> }
export interface AiGatewayStats { auditWriteFailures: number; budgetRefusals: number; queueTimeouts: number }
export class AiGatewayService implements AiGateway { stats(): AiGatewayStats; /* … */ }
export interface AiCallRow { /* exactly the AiCall columns minus id/createdAt */ }
export class AiCallRepository { constructor(prisma: PrismaService); insert(row: AiCallRow): Promise<void> }
```
`AiGatewayService.call` algorithm:
1. `route = routes[job]`; `chain = [route.provider, ...route.fallback]`.
2. For each provider in chain: `req = route.model ? { ...request, model: route.model } : request` (sentinel: `model === null` → the SAME object reference is passed on).
3. If provider is billed (`anthropic-api`): price = prices.get(req.model); if missing → record audit with `errorClass: 'AiBudgetExceeded'`, message `unknown price for <model>`, throw `AiBudgetExceeded`; else `reservation = meter.reserve(job, worstCaseInr(price, req))` (throws → audit + rethrow).
4. `{result, queuedMs} = await scheduler.run(provider, priorityOf(job), route.maxWaitMs, () => adapter.send(req))`, timing `latencyMs`.
5. On success: settle reservation with `costInr(price, in ?? 0, out ?? 0)` (CLI: 0); **fire-and-forget** audit (`void this.audit(row)` where `audit` catches, logs `ai-gateway: audit write failed (<job>): <msg>` and increments `auditWriteFailures`); return `result.message`.
6. On error: release reservation; fire-and-forget audit with `errorClass = err.constructor.name`, `errorMessage = String(err.message).slice(0, 2000)`; if another provider remains in chain → continue with `fallbackFrom = previous provider`; else rethrow **the original error instance**.
`requestHash` = sha256 hex of `JSON.stringify(req)`. `request` stored is `req` as JSON. `response` = `result.message` as JSON.
Module: providers `ClaudeCliTransport`, `ClaudeCliProvider`, `AnthropicApiProvider` (factory `new Anthropic({ apiKey: config.get('ANTHROPIC_API_KEY') })`), routes from `config/ai-routes.json` and prices from `config/ai-model-prices.json`, located by `export function resolveAiConfig(file: string): string` in `ai-gateway/routes/route-config.ts`: `process.env.AI_CONFIG_DIR` if set, else walk up from `__dirname` until a directory containing `config/<file>` is found (works for jest cwd `apps/api`, `apps/api/dist` at runtime, and the image where the repo is copied to `/app` by `COPY . .`); not found → throw at module init (boot fails loudly — test it), `BudgetMeter` with `spentToday` = `SUM(costInr)` of today's IST `ai_calls`, `AI_API_DAILY_CAP_INR` (default 100), reserve 0.25; exports `AI_GATEWAY`, `ClaudeCliTransport`, `AiGatewayService`. Imports `PrismaModule` (or whatever provides `PrismaService` — follow `trade-sentinel.module.ts`).

- [ ] **Step 1: Failing tests** (`ai-gateway.service.spec.ts`, fakes for adapters/repo/meter):
  - sentinel route (`model: null`): adapter receives the identical object reference; returned message is the adapter's message reference.
  - exactly one `insert` per attempt; row fields (job, provider, model, priority 0, requestHash, latencyMs ≥ 0, tokens, costInr 0 for CLI).
  - repository `insert` that rejects → `call` still resolves the same message; `stats().auditWriteFailures === 1`; logger.error called once.
  - repository `insert` that never resolves (pending promise) and a 100 KB request → `call` resolves anyway (Review Focus 1).
  - adapter throws `RateLimitError` instance with no fallback → the same instance rethrown; audit row has `errorClass: 'RateLimitError'`.
  - fallback chain `[claude-cli → anthropic-api]` for `decision.judge`: first throws, second answers; second audit row has `fallbackFrom: 'claude-cli'`.
  - unknown price on API provider → `AiBudgetExceeded`, adapter never called, audit row written.
  - two concurrent API calls whose worst cases each fit but jointly exceed the cap → exactly one reaches the adapter (Review Focus 2).
  - `ai-call.repository.spec.ts`: `insert` calls `prisma.aiCall.create({ data: row })` with Decimal-safe `costInr` (number accepted).
- [ ] **Steps 2–4:** fail → implement → pass; tsc clean.
- [ ] **Step 5: Commit** `git add apps/api/src/modules/ai-gateway && git commit -m "feat(ai-gateway): gateway service with routing, fallback, budget and fail-open audit"`

### Task A6: Sentinel behind `AI_GATEWAY_SENTINEL`

**Files:**
- Create: `apps/api/src/modules/ai-gateway/sentinel/sentinel-gateway.transport.ts` (+ spec)
- Modify: `apps/api/src/modules/trade-sentinel/trade-sentinel.module.ts` (import `AiGatewayModule`; `ANTHROPIC_CLIENT` factory)
- Modify: `apps/api/src/modules/trade-sentinel/trade-sentinel.module.spec.ts` (token checks only if needed)
- Modify: `apps/api/src/modules/trade-sentinel/golden/sentinel-golden.spec.ts` (add the gateway run)
- Modify: `deploy/env/api.env.example` (document `AI_GATEWAY_SENTINEL=false`, `AI_API_DAILY_CAP_INR=100`, `AI_CLI_CONCURRENCY=2`)

**Interfaces — Produces:**
```ts
export class SentinelGatewayTransport implements MessagesTransport {
  constructor(gateway: AiGateway);
  readonly messages: { create(params: TransportRequest): Promise<TransportMessage> }; // → gateway.call(jobFor(params), params)
}
export function jobFor(params: TransportRequest): AiJob; // identity of params.output_config.format.schema:
// === VERDICT_SCHEMA → 'sentinel.judge'; === OVERNIGHT_VERDICT_SCHEMA → 'sentinel.overnight'; === THESIS_SCHEMA → 'sentinel.thesis'; else 'sentinel.unknown'
```
Import the three schema constants from the sentinel files (read-only import; no edit to those files). Note the sentinel passes `VERDICT_SCHEMA as unknown as Record<string, unknown>` — a cast, same reference, so identity holds; the spec test proves it.

Module factory:
```ts
useFactory: (config: ConfigService, cli: ClaudeCliTransport, gateway: AiGateway): MessagesTransport =>
  config.get<string>('AI_GATEWAY_SENTINEL')?.trim().toLowerCase() === 'true'
    ? new SentinelGatewayTransport(gateway)
    : judgeTransportFrom(config.get<string>('SENTINEL_JUDGE')) === 'cli'
      ? cli
      : new Anthropic({ apiKey: config.get<string>('ANTHROPIC_API_KEY') }),
inject: [ConfigService, ClaudeCliTransport, AI_GATEWAY],
```
`ClaudeCliTransport` must be ONE instance shared by the gateway's `ClaudeCliProvider` and this factory: provide it in `AiGatewayModule`, export it, and remove it from `TradeSentinelModule.providers`. Keep the existing long doc comment on the factory and add a paragraph on the flag.

- [ ] **Step 1: Failing tests:**
  - `sentinel-gateway.transport.spec.ts`: `jobFor` mapping for the three real schema constants and a foreign schema; `create` passes the same params reference and returns the gateway's message.
  - Golden: add `describe('through the gateway (AI_GATEWAY_SENTINEL=true)')` that runs `runGoldenScenarios` with a client = `new SentinelGatewayTransport(realAiGatewayService)` where the gateway is built with the real routes (`SENTINEL_JUDGE=api`), real scheduler, a fake `anthropic-api` adapter that delegates to the recorder, and an audit repository fake. It must match the **same snapshots** (use `toMatchSnapshot(r.scenario)` with identical names — jest compares against the baseline written in A1; do not run with `-u`). Additionally assert one audit insert per scenario with job equal to the expected `sentinel.*` value, and a variant where the audit repository throws produces identical records once log lines starting with `ai-gateway:` (the gateway's own audit-failure line, expected by design) are filtered out — assert that exactly one such line per scenario exists.
  - Module boot test: build the module with `AI_GATEWAY_SENTINEL` unset → `ANTHROPIC_CLIENT` is an `Anthropic` instance (or the CLI transport when `SENTINEL_JUDGE=cli`, and it is the same instance the gateway holds); `=true` → `SentinelGatewayTransport`. Follow the existing module spec's style (metadata checks) or a `Test.createTestingModule` with overridden Prisma.
- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** run the full sentinel + gateway suites: `npx jest src/modules/trade-sentinel src/modules/ai-gateway` → PASS with **0 snapshots written, 0 updated, 0 obsolete**. Then `npx jest` (whole API) → green; `npx tsc --noEmit -p tsconfig.json` → clean.
- [ ] **Step 5: Zero-diff check:** `git diff --stat main -- apps/api/src/modules/trade-sentinel/services apps/api/src/modules/trade-sentinel/prompts` → only `services/llm-transport.ts` (re-export from A2).
- [ ] **Step 6: Commit** `git add apps/api/src/modules/ai-gateway/sentinel apps/api/src/modules/trade-sentinel/trade-sentinel.module.ts apps/api/src/modules/trade-sentinel/trade-sentinel.module.spec.ts apps/api/src/modules/trade-sentinel/golden deploy/env/api.env.example && git commit -m "feat(trade-sentinel): route LLM calls through the AI gateway behind AI_GATEWAY_SENTINEL (default off)"`

### Task A7: `ScorerClient` (Node → ai-engine `/score`)

**Files:** Create `apps/api/src/modules/ai-gateway/scorer/scorer.client.ts` (+ spec); register/export in `ai-gateway.module.ts`.

**Interfaces — Produces** (contract shared with Task B7 — keep field names identical):
```ts
export interface ScoreRequest { featureSet: 'fs1-legacy-checks'; breakdown: unknown; context: { vixAtEntry?: number|null; vixRegime?: string|null; adRatio?: number|null; decidedAt: string; direction: 'LONG'|'SHORT'; strategyKey: string; profitTargetSource?: string|null } }
export type ScoreResult =
  | { source: 'model'; pWin: number; expectedR: number; modelId: string; featureSet: string; missing: string[] }
  | { source: 'rule'; pWin: number; expectedR: null; featureSet: string; missing: string[] }
  | { source: 'unavailable'; reason: string };
export class ScorerClient { constructor(config: ConfigService); score(req: ScoreRequest): Promise<ScoreResult> }
```
Uses global `fetch` with `AbortSignal.timeout(1500)` against `${AI_ENGINE_URL}/score`; any network error, timeout, non-2xx, or body failing a shape check → `{ source: 'unavailable', reason }`, logged at warn **at most once per minute** (rate-limited) to avoid log floods. Never throws.

- [ ] **Step 1: Failing tests** (mock `global.fetch`): model reply passes through; rule reply passes through; 500 → unavailable; malformed body (`pWin: "x"`) → unavailable; fetch never resolving → resolves `unavailable` after 1500 ms (fake timers / AbortSignal mock) (Review Focus 5); `AI_ENGINE_URL` unset → unavailable without calling fetch.
- [ ] **Steps 2–4:** fail → implement → pass.
- [ ] **Step 5: Commit** `git add apps/api/src/modules/ai-gateway/scorer apps/api/src/modules/ai-gateway/ai-gateway.module.ts && git commit -m "feat(ai-gateway): fail-open ScorerClient for the ai-engine /score endpoint"`

---

## Stream B — Corpus and scorer (Python). Worktree `.claude/worktrees/sp3-b-scorer`, branch `feature/sp3-m2-scorer` from `feature/sp3-ai-decision` after Task 0.

Legacy source facts (from the 2026-10-11 data profile; the implementer of B4 MUST confirm column names by reading `C:\Users\AryanKumar\Desktop\TD_Automation\prisma\schema.prisma` before writing the mapping):
- TD_Automation Postgres runs in Docker container `td-postgres` (start with `docker start td-postgres`, stop it again afterwards); URL in `TD_Automation/.env` `DATABASE_URL`.
- Gated: `watch_entries` → `trades` (796 closed); MISSED/DISMISSED `watch_entries` have MFE/MAE. Ungated: `ungated_watch_entries` → `ungated_trades`. Adaptive: `adaptive_stop_*`.
- Entry-time features: `initialBreakdown.checks[]` (each `{ name, passed, points, detail }`), `initialScore`, `initialPrice`, `profitTarget`, `profitTargetSource`, `vixAtEntry`, `vixRegime`, `adRatio` (gated), `atrAtEntry`/`stopPct`/`riskAmount` (adaptive).
- Labels: `pnl` (gross), `fees`; net = pnl − fees. Loss-cut 0.4% of deployed capital (earlier flat ₹1,000 — B3 implementer finds the change date in TD_Automation git log / code: `git -C ../TD_Automation log -S "0.004" --oneline` and records it as a constant in `labels.py` with a source comment).
- Leakage columns: any `current*`, `maxFavorable`, `maxAdverse`, `closedReason`, events tables.

### Task B1: venv, dependencies, test scaffolding

**Files:** Create `ai-engine/requirements-scorer.txt`, `ai-engine/pytest.ini`, `ai-engine/src/corpus/__init__.py`, `ai-engine/src/scorer/__init__.py`, `ai-engine/tests/test_smoke_scorer.py`; modify `.gitignore` (add `ai-engine/data/models/xgb-*.json`, `ai-engine/data/exports/`).

```
# requirements-scorer.txt — the scorer/corpus container and local training. Keep minimal (disk + 384 MB container).
fastapi==0.115.0
uvicorn[standard]==0.32.0
pydantic>=2.10.0
numpy>=2.0
pandas>=2.2
xgboost>=2.1
scikit-learn>=1.5
psycopg[binary]>=3.2
pytest>=8.0
httpx==0.28.0
```
```ini
# pytest.ini
[pytest]
testpaths = tests
pythonpath = .
```
- [ ] **Step 1:** `cd ai-engine && py -3 -m venv .venv && .venv/Scripts/python -m pip install --no-cache-dir -r requirements-scorer.txt` (`--no-cache-dir`: disk). If a wheel is missing for 3.14, report it and STOP (do not build from source).
- [ ] **Step 2:** smoke test `def test_imports(): import xgboost, sklearn, pandas, psycopg, fastapi` → `.venv/Scripts/python -m pytest tests/test_smoke_scorer.py -q` PASS. Existing tests `tests/test_telegram_parser.py` are not required to run in this venv.
- [ ] **Step 3: Commit** `git add ai-engine/requirements-scorer.txt ai-engine/pytest.ini ai-engine/src/corpus/__init__.py ai-engine/src/scorer/__init__.py ai-engine/tests/test_smoke_scorer.py .gitignore && git commit -m "chore(ai-engine): scorer requirements and pytest scaffolding"`

### Task B2: `fs1-legacy-checks` feature extractor

**Files:** Create `ai-engine/src/scorer/features_fs1.py`, test `ai-engine/tests/test_features_fs1.py`.

**Interfaces — Produces:**
```python
FEATURE_SET = "fs1-legacy-checks"
CHECKS: tuple[str, ...]  # canonical check keys, e.g. ("macd_1d","macd_1m","macd_5m","ema9_vs_ema20","vwap_gap","adx","rsi_5m","atr_pct","volume_ratio","breakout_20d","sr_room","nifty_trend","sector_trend","relative_strength","supertrend")
CHECK_ALIASES: dict[str, str]  # raw legacy check names → canonical key (built by reading real names in B4's data; start from the profile list)
LEAKAGE_FIELDS: frozenset[str]  # {"currentPrice","currentPnl","maxFavorable","maxAdverse","closedReason", ...}
def feature_names() -> list[str]  # deterministic order
def extract(breakdown: dict | None, context: dict) -> tuple[dict[str, float | None], list[str]]
    # returns (features keyed by feature_names(), missing check keys)
    # per check: f"{k}_passed" (0/1/None), f"{k}_value" (float/None), f"{k}_missing" (0/1)
    # missing when absent, or detail contains "insufficient" (case-insensitive)
    # plus scoring_version (number of checks present in raw breakdown: 10 or 15 → 0/1 flag "scoring_v15"),
    # vix_at_entry, vix_missing, vix_regime_<low|normal|elevated|high> one-hot, ad_ratio, ad_missing,
    # minute_of_session (IST, 09:15 → 0), weekday (0–4), direction_long (0/1),
    # strategy_<gated|ungated|adaptive> one-hot, target_src_<fallback|indicator_sr|other> one-hot
    # raises ValueError if any key of context is in LEAKAGE_FIELDS
```
Value parsing: `detail` may be a number, a dict with `value`, or a string like `"RSI 61.2"` — take the first float in it; else None.

- [ ] **Step 1: Failing tests:** a 15-check breakdown → all `_passed` set, `scoring_v15 == 1`; a 10-check breakdown → missing flags for the 5 absent checks, `scoring_v15 == 0`; `"insufficient candles"` detail → `_missing = 1`, `_value None`; unknown check name ignored (Review Focus 4); `breakdown=None` → all checks missing, no exception; `feature_names()` stable and equal to `extract(...)[0].keys()` order; context containing `maxFavorable` → `ValueError`; minute_of_session for `2026-06-01T04:00:00Z` (09:30 IST) == 15; `initialScore` never appears in `feature_names()`.
- [ ] **Steps 2–4:** run `.venv/Scripts/python -m pytest tests/test_features_fs1.py -q` FAIL → implement → PASS.
- [ ] **Step 5: Commit** `git add ai-engine/src/scorer/features_fs1.py ai-engine/tests/test_features_fs1.py && git commit -m "feat(ai-engine): fs1 entry-time feature extractor with leakage guard"`

### Task B3: Labels

**Files:** Create `ai-engine/src/scorer/labels.py`, test `ai-engine/tests/test_labels.py`.

**Interfaces — Produces:**
```python
LOSS_CUT_PCT = 0.004
LOSS_CUT_FLAT_INR_BEFORE: datetime  # change date found from TD_Automation history; doc comment cites the commit
LOSS_CUT_FLAT_INR = 1000.0
@dataclass(frozen=True)
class Outcome: gross_pnl: float; fees: float; net_pnl: float; win: bool; r_multiple: float | None; r_derived: bool; mfe: float | None; mae: float | None; hold_mins: float | None
def label(*, gross_pnl: float, fees: float | None, entry_price: float, qty: float, entered_at: datetime, exited_at: datetime | None,
          stop_price: float | None, risk_amount: float | None, mfe: float | None = None, mae: float | None = None) -> Outcome
# risk: risk_amount if given; else |entry-stop|*qty if stop given; else derived loss-cut (r_derived=True):
#   entered_at < LOSS_CUT_FLAT_INR_BEFORE → 1000.0 else entry_price*qty*LOSS_CUT_PCT
# fees None → 0 and r computed on gross (documented); win = net_pnl > 0
```
- [ ] **Step 1: Failing tests:** win/loss on net (gross +100, fees 150 → loss); stored stop → `r_derived False`; adaptive `risk_amount` used; no stop after change date → risk = 0.4% of notional, `r_derived True`; before change date → ₹1000; zero risk → `r_multiple None`.
- [ ] **Steps 2–4**, **Step 5: Commit** `git add ai-engine/src/scorer/labels.py ai-engine/tests/test_labels.py && git commit -m "feat(ai-engine): net-of-fees win and R-multiple labels with derived loss-cut risk"`

### Task B4: Legacy importer and sentinel-derived records

**Files:** Create `ai-engine/src/corpus/db.py`, `ai-engine/src/corpus/legacy_mapping.py`, `ai-engine/src/corpus/importer.py`, `ai-engine/src/corpus/sentinel_records.py`, `ai-engine/scripts/import_legacy.py`; tests `ai-engine/tests/test_legacy_mapping.py`, `ai-engine/tests/test_importer.py`, `ai-engine/tests/test_sentinel_records.py`.

**Interfaces — Produces:**
```python
# db.py
def connect(url: str) -> "psycopg.Connection"   # autocommit False; row_factory=dict_row
# legacy_mapping.py
@dataclass
class Record:  # mirrors ai_decision_records columns (snake → camel done in importer)
    source: str; source_id: str; kind: str; decided_at: datetime; symbol: str; exchange: str | None
    instrument_type: str | None; direction: str | None; vehicle: str | None; strategy_key: str
    setup_group_key: str; evidence: dict; feature_set: str; features: dict; rule_score: float | None
    decision: dict; outcome: dict | None; outcome_at: datetime | None
class Skip(Exception): reason: str
def map_gated_trade(row: dict, source: str) -> Record          # taken
def map_gated_missed(row: dict, source: str) -> Record         # skipped; outcome from MFE/MAE only (win None)
def map_ungated_trade(row: dict, source: str) -> Record
def map_adaptive_trade(row: dict, source: str) -> Record
# setup_group_key = f"{alertId or 'noalert'}|{symbol}|{IST date}"; strategy_key in {"legacy.gated","legacy.ungated","legacy.adaptive"}
# evidence = the raw entry-time columns (no leakage fields), features via features_fs1.extract, rule_score = passed-check count / checks present
# decision = {"taken": True|False, "reason": ...}; outcome = asdict(labels.label(...)) for closed trades
# raises Skip("no-breakdown" | "not-closed" | "bad-price" | ...) for unusable rows
# importer.py
SOURCE_QUERIES: dict[str, str]   # SQL per legacy table (SELECT only; columns quoted)
def import_source(src_conn, dst_conn, source: str, tables: list[str]) -> dict[str, int]
    # upsert by (source, sourceId): INSERT ... ON CONFLICT ("source","sourceId") DO UPDATE SET outcome=EXCLUDED.outcome, "outcomeAt"=EXCLUDED."outcomeAt"
    # returns counts {"inserted":…, "updated":…, "skip:<reason>":…}; commits once at end
# sentinel_records.py
def build_from_ai_calls(conn) -> dict[str, int]   # ai_calls job LIKE 'sentinel.%' with response not null → POSITION_REVIEW / OVERNIGHT_REVIEW, sourceId = ai_calls.id, source "sentinel"; joins sentinel_verdicts by (trackerId from request packet, nearest createdAt within 60 s) for the parsed verdict; outcome left null
```
CLI: `scripts/import_legacy.py --source td_automation|grw_prod --src-url <url> --dst-url <url> [--dry-run]` prints the counts as JSON. `--dry-run` maps everything and prints counts without writing.

- [ ] **Step 0:** `docker start td-postgres`; read TD_Automation `prisma/schema.prisma`; list distinct raw check names: `SELECT DISTINCT jsonb_array_elements("initialBreakdown"->'checks')->>'name' FROM watch_entries` (and ungated) — update `CHECK_ALIASES` in B2's file if names differ (amend with a test for each alias). Save 5 anonymised sample rows per table as JSON fixtures under `ai-engine/tests/fixtures/legacy/` (replace symbol with `SYM1…`, drop user ids).
- [ ] **Step 1: Failing tests** on the fixtures: each mapper yields the expected `kind/strategy_key/setup_group_key/direction`; no leakage key appears in `evidence`; a row with null breakdown → `Skip("no-breakdown")` (Review Focus 4); open trade → `Skip("not-closed")`; missed entry → `decision.taken False`, outcome has mfe/mae and `win None`. Importer against a fake connection object (records executed SQL + params): second run of the same rows yields `updated`, not `inserted` (idempotency via ON CONFLICT); counts include skip reasons; `sell_futures` is not in `SOURCE_QUERIES`. Sentinel builder: two `ai_calls` rows → two records with `sourceId` = call ids; rerun → no duplicates.
- [ ] **Steps 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Dry run against the real legacy DB:** `.venv/Scripts/python scripts/import_legacy.py --source td_automation --src-url "<TD_Automation DATABASE_URL>" --dst-url none --dry-run` → counts printed; expected order of magnitude ≈ 2,300 taken + ~280 skipped records, skip reasons listed. Paste the counts into the commit message body. `docker stop td-postgres` afterwards.
- [ ] **Step 6: Commit** `git add ai-engine/src/corpus ai-engine/scripts/import_legacy.py ai-engine/tests/test_legacy_mapping.py ai-engine/tests/test_importer.py ai-engine/tests/test_sentinel_records.py ai-engine/tests/fixtures/legacy ai-engine/src/scorer/features_fs1.py ai-engine/tests/test_features_fs1.py && git commit -m "feat(ai-engine): idempotent legacy importer and sentinel-derived corpus records"`

### Task B5: Tabular export and grouped time-ordered split

**Files:** Create `ai-engine/src/corpus/export.py`, `ai-engine/src/corpus/split.py`; tests `ai-engine/tests/test_export_split.py`.

**Interfaces — Produces:**
```python
# export.py
def load_frame(conn, feature_set: str, kind: str = "ENTRY_SETUP", taken_only: bool = True) -> pd.DataFrame
    # columns: feature_names() + ["setup_group_key","decided_at","strategy_key","direction","vix_regime","win","r_multiple","r_derived","source"]
    # rows without outcome or with win None excluded
def export_csv(df: pd.DataFrame, path: Path) -> None
def load_frame_from_records(records: list[dict]) -> pd.DataFrame  # same shape, for tests and dry runs
# split.py
def dedupe_groups(df) -> pd.DataFrame   # one row per setup_group_key: keep the earliest decided_at; tie → lowest source_id
def time_group_split(df, holdout_frac: float = 0.2) -> tuple[pd.DataFrame, pd.DataFrame]
    # holdout = rows whose IST trading day is in the last ceil(holdout_frac * n_days) days; no group on both sides
def group_kfold(df, k: int = 5) -> list[tuple[np.ndarray, np.ndarray]]   # sklearn GroupKFold on setup_group_key, train part only
```
- [ ] **Step 1: Failing tests** on synthetic records: dedupe keeps one per group; split holdout days are strictly after all train days; **no `setup_group_key` appears on both sides** (property loop over 50 random synthetic frames); group_kfold folds disjoint by group; `export_csv` round-trips.
- [ ] **Steps 2–4**, **Step 5: Commit** `git add ai-engine/src/corpus/export.py ai-engine/src/corpus/split.py ai-engine/tests/test_export_split.py && git commit -m "feat(ai-engine): corpus tabular export and grouped time-ordered split"`

### Task B6: Training, baseline, go/no-go gate, registry

**Files:** Create `ai-engine/src/scorer/train.py`, `ai-engine/src/scorer/registry.py`, `ai-engine/scripts/train_entry_scorer.py`; test `ai-engine/tests/test_train_gate.py`.

**Interfaces — Produces:**
```python
# train.py
GATE_MIN_AUC = 0.60; GATE_MIN_HOLDOUT = 300
@dataclass
class TrainResult: model_id: str; gate: str; gate_reasons: list[str]; metrics: dict; n_train: int; n_holdout: int; data_window: dict; artifact: dict
def baseline_scores(train_df, apply_df) -> np.ndarray   # isotonic(rule_score → win) fit on train, applied to apply_df
def train(df: pd.DataFrame, *, seed: int = 7) -> TrainResult
    # dedupe → time_group_split → XGBClassifier(n_estimators=300, max_depth=3, learning_rate=0.05, subsample=0.8,
    #   colsample_bytree=0.8, eval_metric="logloss", random_state=seed, missing=np.nan)
    # calibration: CalibratedClassifierCV(method="isotonic", cv=GroupKFold folds) — or fit isotonic on out-of-fold preds
    # XGBRegressor (same params) for expected R on rows with r_multiple not None
    # metrics: holdout roc_auc, brier, baseline_brier, base_win_rate, and per-slice (strategy_key, direction, vix_regime) auc/n
    # gate reasons: "auc<0.60", "brier>=baseline", "holdout<300"; GO iff none
    # model_id = f"xgb-entry-{feature_set}-{YYYYMMDDHHmm}"
    # artifact = {"classifier": booster JSON (get_booster().save_raw("json") decoded), "calibrator": {"x":[...],"y":[...]},
    #             "regressor": booster JSON, "feature_names": [...], "feature_set": FEATURE_SET}
# registry.py
def save_artifact(artifact: dict, models_dir: Path, model_id: str) -> Path  # writes <models_dir>/<model_id>.json
def register(conn, result: TrainResult, artifact_path: Path, activate: bool) -> None
    # INSERT ai_models; if activate and gate == "GO": UPDATE others of kind SET active=false, then this active=true (one tx)
    # activate with NO_GO → ValueError (DB CHECK would also refuse)
def load_active(conn, kind: str = "xgb-entry") -> tuple[str, Path] | None
```
CLI `scripts/train_entry_scorer.py --db-url <url> | --records-jsonl <path>, --models-dir <dir>, [--activate]` prints the result JSON and writes `docs/sp3/training-report-<YYYY-MM-DD>.md` (sections: data window, counts after dedupe, holdout metrics vs baseline, per-slice table, gate verdict + reasons, caveats from the data profile: single regime, long-only equity, fee-dominated labels).

- [ ] **Step 1: Failing tests:** synthetic data where `win` depends strongly on one feature (n=2,000 groups over 40 days) → `gate == "GO"`, AUC ≥ 0.6; pure-noise labels → `NO_GO` with `"auc<0.60"`; tiny data (200 groups) → `"holdout<300"`; train is deterministic for a fixed seed (same AUC twice); `register(activate=True)` on NO_GO raises; artifact JSON loads back into a `Booster` and yields the same predictions.
- [ ] **Steps 2–4**, **Step 5: Commit** `git add ai-engine/src/scorer/train.py ai-engine/src/scorer/registry.py ai-engine/scripts/train_entry_scorer.py ai-engine/tests/test_train_gate.py && git commit -m "feat(ai-engine): XGBoost entry scorer training with calibrated baseline and go/no-go gate"`

### Task B7: `/score` and `/corpus/similar`

**Files:** Create `ai-engine/src/scorer/serve.py`, `ai-engine/src/corpus/similar.py`, `ai-engine/src/routes/scorer.py`; modify `ai-engine/src/main.py` (include router) and `ai-engine/src/routes/__init__.py` if it aggregates routers; tests `ai-engine/tests/test_score_route.py`, `ai-engine/tests/test_similar.py`.

**Interfaces — Consumes** B2 `extract`, B6 artifact format. **Produces** (contract = Task A7):
```python
# serve.py
class ScorerHolder:
    def __init__(self, models_dir: Path, rule_calibrator: dict | None)
    def load(self, model_id: str | None) -> None    # None → rule only
    def score(self, feature_set: str, breakdown: dict | None, context: dict) -> dict
      # unknown feature_set → raises UnknownFeatureSet
      # model loaded → {"source":"model","pWin":…, "expectedR":…, "modelId":…, "featureSet":…, "missing":[…]}
      # else → {"source":"rule","pWin": calibrated(rule_score) or rule_score, "expectedR": None, "featureSet":…, "missing":[…]}
# active model chosen at startup from env SCORER_MODEL_ID (explicit) else registry.load_active via env AI_DB_URL; failure → rule only, logged
# routes/scorer.py
POST /score            body {featureSet, breakdown, context}; 422 on unknown featureSet or bad body
POST /corpus/similar   body {features: {...} | null, breakdown?, context?, k: int=5, filters: {strategyKey?, direction?}} → {"items":[{id, decidedAt, strategyKey, decision, outcome, distance}]}
GET  /health           → {"status":"ok","scorer": "model:<id>" | "rule"}
# similar.py
class SimilarIndex: def __init__(self, df: pd.DataFrame); def query(self, features: dict, k: int, filters: dict) -> list[dict]
  # standardise numeric features (mean/std from index, NaN → column mean), Euclidean; deterministic tie-break by id
  # index built at startup from load_frame(..., taken_only=False) when AI_DB_URL set; else empty → items []
```
- [ ] **Step 1: Failing tests** with FastAPI `TestClient`: rule mode response shape; model mode with an artifact produced by a tiny `train()` on synthetic data → `source: "model"`, `0 ≤ pWin ≤ 1`; unknown featureSet → 422; malformed body → 422; `/health` reports mode; similar returns k nearest in deterministic order, respects filters, empty index → `[]`.
- [ ] **Steps 2–4**, **Step 5: Commit** `git add ai-engine/src/scorer/serve.py ai-engine/src/corpus/similar.py ai-engine/src/routes/scorer.py ai-engine/src/main.py ai-engine/src/routes/__init__.py ai-engine/tests/test_score_route.py ai-engine/tests/test_similar.py && git commit -m "feat(ai-engine): /score and /corpus/similar endpoints with rule fallback"`

Note: `src/main.py` imports other routers that need heavy deps (FinBERT, telethon, claude-agent-sdk). The scorer container must not import them: add `ai-engine/src/scorer_main.py` — a minimal FastAPI app that includes only `routes/scorer.py` — and use it in the Dockerfile. Leave `main.py` untouched if including the router there would pull heavy deps into tests.

### Task B8: Container, compose service, boot validator

**Files:** Create `ai-engine/Dockerfile`, `ai-engine/.dockerignore`; modify `deploy/docker-compose.prod.yml`, `apps/api/src/common/config/validate-boot-config.ts` (+ its spec), `deploy/env/api.env.example` (`AI_ENGINE_URL=http://ai-engine:5000`).

```dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY requirements-scorer.txt .
RUN pip install --no-cache-dir -r requirements-scorer.txt
COPY src ./src
ENV PYTHONUNBUFFERED=1 MODELS_DIR=/models
EXPOSE 5000
CMD ["uvicorn", "src.scorer_main:app", "--host", "0.0.0.0", "--port", "5000", "--workers", "1"]
```
Compose service (internal only — no `ports:` to the host, no Caddy route):
```yaml
  ai-engine:
    logging: *logging
    image: grw-ai-engine:${GRW_AI_TAG:-current}
    container_name: grw-ai-engine
    restart: unless-stopped
    mem_limit: 384m
    environment:
      MODELS_DIR: /models
      AI_DB_URL: postgresql://grw_ai:${AI_DB_PASSWORD}@postgres:5432/${PG_DB}
    volumes:
      - /opt/grw/models:/models:ro
    depends_on:
      postgres:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:5000/health', timeout=3)"]
      interval: 30s
      timeout: 5s
      retries: 3
    profiles: ["ai"]   # off until the owner enables it after measuring headroom (spec §6.5)
```
Boot validator: accept `AI_ENGINE_URL` that is `https://…` OR exactly matches `^http://ai-engine(:\d+)?$`.

- [ ] **Step 1: Failing test** in the validator spec: production + `AI_ENGINE_URL=http://ai-engine:5000` → no failure; `http://evil.example` → failure; `https://x` → ok.
- [ ] **Step 2–4:** fail → implement → pass (`cd apps/api && npx jest src/common/config`). `docker compose -f deploy/docker-compose.prod.yml config -q` with dummy env vars → exits 0 (if Docker CLI is available locally; otherwise skip and say so). Do NOT build the image locally (disk).
- [ ] **Step 5: Commit** `git add ai-engine/Dockerfile ai-engine/.dockerignore ai-engine/src/scorer_main.py deploy/docker-compose.prod.yml deploy/env/api.env.example apps/api/src/common/config/validate-boot-config.ts apps/api/src/common/config/validate-boot-config.spec.ts && git commit -m "feat(deploy): ai-engine scorer container (internal, 384 MB, opt-in profile)"`

### Task B9: Real training run on legacy data and report

**Files:** Create `docs/sp3/training-report-2026-10-11.md` (generated), possibly fixes in earlier B files.

- [ ] **Step 1:** `docker start td-postgres`. Run the importer for real into a **local scratch database** — not production: create one with `docker exec td-postgres createdb -U <user> grw_ai_scratch`, apply only the M0 migration SQL to it via `psql -f prisma/migrations/20261011120000_sp3_m0_ai_corpus/migration.sql`, then `import_legacy.py --source td_automation --src-url <td url> --dst-url <scratch url>`.
- [ ] **Step 2:** `train_entry_scorer.py --db-url <scratch url> --models-dir ai-engine/data/models` → result JSON + report. Do not pass `--activate`.
- [ ] **Step 3:** Read the report; confirm the gate verdict is stated plainly with reasons. A NO-GO is an acceptable outcome — do not tune features or thresholds to force a GO; if you believe a bug (not data) caused a poor score, report it instead.
- [ ] **Step 4:** Drop the scratch DB (`dropdb grw_ai_scratch`), `docker stop td-postgres`.
- [ ] **Step 5: Commit** `git add docs/sp3/training-report-2026-10-11.md && git commit -m "docs(sp3): first entry-scorer training report on legacy data"`

---

## Integration (after both streams)

- Merge `feature/sp3-m1-gateway` and `feature/sp3-m2-scorer` into `feature/sp3-ai-decision` (`--no-ff`); they share only `deploy/env/api.env.example` (resolve by keeping both blocks).
- Full verification on the integrated branch: `cd apps/api && npx jest` (whole suite) and `npx tsc --noEmit -p tsconfig.json`; `cd ai-engine && .venv/Scripts/python -m pytest -q tests/test_smoke_scorer.py tests/test_features_fs1.py tests/test_labels.py tests/test_legacy_mapping.py tests/test_importer.py tests/test_sentinel_records.py tests/test_export_split.py tests/test_train_gate.py tests/test_score_route.py tests/test_similar.py`.
- Whole-branch review (opus), fixes, then owner decides merge to main.
- **Owner-run after merge (not in this plan):** apply migration (auto on deploy), run `grw-ai-role.sql`, measure `free -m`, enable `--profile ai` if ≥ 600 MB free, GrW-prod import over SSH tunnel, flip `AI_GATEWAY_SENTINEL=true` for one shadow session and compare.
