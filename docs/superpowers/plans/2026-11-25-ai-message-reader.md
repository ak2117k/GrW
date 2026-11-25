# AI Message Reader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every Telegram post is read by AI within seconds, its claims are checked against our live market data, and the checked notes reach the signal judge, the night review and the owner.

**Architecture:** A new NestJS module `message-reader` listens to `telegram.message` (and to a new `signal.vision.done` event for image posts) outside the intake's serial chain. Per post it builds a time-boxed data packet in parallel, makes one strict-JSON AI call (job `signal.read`, reading agent, concurrency 8), validates the reply and stores a `message_readings` row. The signal judge's `channelViews` block gains `verifiedNotes`; a nightly scorer grades claims; a 5-minute health check alerts on silent failure.

**Tech Stack:** NestJS 10, Prisma (PostgreSQL), Jest, `@nestjs/event-emitter`, `@nestjs/schedule`, Vertex Claude via the existing `directRecordedTransport` + `runInSharedSlot` agent routing, React + Vite (web).

**Spec:** `docs/superpowers/specs/2026-11-25-ai-message-reader-design.md`

## Global Constraints

- Switch `MESSAGE_READER=off | shadow | on`, default `off`. `shadow`: read + store + UI, judge does not see notes, no owner alerts. `on`: judge sees `verifiedNotes`, owner alerts sent.
- Reader runs only when `agentsOn()` (`AI_AGENTS=on` AND `SENTINEL_JUDGE=vertex`); otherwise it stays off and logs why once at boot.
- Model `MESSAGE_READER_MODEL`, default `claude-sonnet-5`; effort `low`; job label `signal.read`.
- `config/ai-agents.json`: `"signal.read": { "agent": "reading", "concurrency": 8, "timeoutMs": 60000, ... }`. Prod env `AGENTS_GLOBAL_CONCURRENCY=24`; `AGENTS_TRADING_RESERVE` stays 6.
- Packet time box `MESSAGE_READER_PACKET_MS` 3000; AI timeout `MESSAGE_READER_TIMEOUT_MS` 25000; one retry while post < 5 min old; skip (`STALE`) if older than `MESSAGE_READER_MAX_AGE_MIN` 30 at dequeue.
- Targets: p50 ≤ 15 s, p95 ≤ 30 s from `receivedAt` (image posts: from vision done) to stored verdict.
- Verdict = present-state check of our data at post time: `CONFIRMED | CONTRADICTED | UNCLEAR | NOT_CHECKABLE`. CONFIRMED/CONTRADICTED with empty evidence is stored as UNCLEAR with `evidenceMissing: true`.
- The reader never creates signals, never emits `signal.ready`, never places or blocks an order, and never waits in the intake's serial chain.
- No decision or measurement on 1m bars; 15m is the smallest timeframe passed to the AI.
- Every AI call recorded in `ai_calls` (via `directRecordedTransport`, `record: aiCallsRecordingOn(...)`).
- Push to `main` = prod deploy; push only after 15:35 IST, and with no open-position decision pending. Work on branch `feature/ai-message-reader` from `main`; never push the branch itself (Cloudflare deploys every branch).
- Commits use explicit pathspecs (`git add <files>`), never `git commit -a`.

## Review Focus

1. **A burst of 10+ posts in one second** → all are read in parallel up to 8, the rest queue; none is dropped or read twice. (Task 5 test `reads a burst of 10 with at most 8 in flight`.)
2. **A data source hangs (breadth quote, chain)** → the packet still goes to the AI within 3 s with that block `unavailable` and its reason. (Task 3 test `time-boxes a hanging source`.)
3. **An edited post** → the reading is re-done and the row is replaced (upsert), not duplicated. (Task 5 test `re-reads an edited post into the same row`.)
4. **The model returns malformed JSON or a refusal** → row stored `FAILED` with the error, one retry if fresh, never throws into the event loop. (Task 4 test `malformed reply becomes FAILED`.)
5. **Reader silently dead during market hours** (Vertex auth, agent down) → health check raises an ops alert within 5–10 min. (Task 7 test `alerts when posts arrive and nothing is read`.)

---

### Task 1: Storage, config and the reply contract

**Files:**
- Modify: `prisma/schema.prisma` (add `MessageReading` model after `ChannelInfo`)
- Create: `prisma/migrations/202611251600_message_readings/migration.sql`
- Create: `apps/api/src/modules/message-reader/message-reader.config.ts`
- Create: `apps/api/src/modules/message-reader/domain/reading.types.ts`
- Create: `apps/api/src/modules/message-reader/domain/reading-validate.ts`
- Test: `apps/api/src/modules/message-reader/domain/reading-validate.spec.ts`, `apps/api/src/modules/message-reader/message-reader.config.spec.ts`

**Interfaces:**
- Produces:
  - Prisma model `MessageReading` → table `message_readings`: `messageId String @id @map("message_id")`, `channelId`, `postedAt Timestamptz`, `sessionDate String` (IST YYYY-MM-DD), `readAt Timestamptz?`, `status String` (READ|FAILED|STALE|CACHED), `kind String?`, `scope String?`, `claims Json`, `call Json?`, `parseAgrees Boolean?`, `missedByRules Boolean @default(false)`, `summary String?`, `model String?`, `packet Json?`, `queuedMs Int?`, `packetMs Int?`, `aiMs Int?`, `textHash String`, `outcomes Json?`, `outcomeFilledAt Timestamptz?`, `error String?`, `createdAt`, `updatedAt`. Indexes `[postedAt]`, `[scope, postedAt]`, `[textHash]`, `[outcomeFilledAt]`.
  - `type ReaderMode = 'off' | 'shadow' | 'on'`; `interface MessageReaderConfig { mode; model; packetMs; timeoutMs; maxAgeMin; retryMaxAgeMin: 5 }`; `parseMessageReaderConfig(env): MessageReaderConfig`; token `MESSAGE_READER_CONFIG`.
  - `type ReadKind = 'CALL'|'UPDATE'|'INFO'|'RECAP'|'NOISE'`, `type ReadScope = 'MARKET'|'SECTOR'|'INSTRUMENT'`, `type ClaimBias = 'BULL'|'BEAR'|'NEUTRAL'|'CAUTION'`, `type ClaimVerdict = 'CONFIRMED'|'CONTRADICTED'|'UNCLEAR'|'NOT_CHECKABLE'`.
  - `interface Evidence { fact: string; value: string; source: string }`, `interface Claim { text; subject: string; bias; horizon: 'INTRADAY'|'DAYS'|'WEEKS'; verdict; evidence: Evidence[]; evidenceMissing?: boolean; claimType: 'DIRECTION'|'CAUTION'|'RELATIVE_BREADTH'|'SECTOR'|'FLOW'|'GAP'|'OTHER' }`.
  - `interface ReaderCall { underlying: string; side: 'BUY'|'SELL'; optionType: 'CE'|'PE'|null; strike: number|null; entryLow: number|null; entryHigh: number|null; stopLoss: number|null; targets: number[] }`.
  - `interface ReaderReply { kind; scope; claims: Claim[]; call: ReaderCall|null; summary: string }`.
  - `READER_REPLY_SCHEMA` (JSON schema object for `output_config.format`).
  - `validateReading(raw: unknown): { ok: true; reply: ReaderReply } | { ok: false; reason: string }`.

- [ ] **Step 1: Write failing tests** in `reading-validate.spec.ts`:
  - `downgrades a CONFIRMED claim with no evidence to UNCLEAR` → input claim `{verdict:'CONFIRMED', evidence:[]}` gives `verdict 'UNCLEAR'`, `evidenceMissing true`.
  - `keeps NOT_CHECKABLE with empty evidence` → unchanged, no `evidenceMissing`.
  - `rejects an unknown kind` → `{ok:false, reason: /kind/}`.
  - `rejects a reply that is not an object` (string `"hello"`) → `ok false`.
  - `accepts the 2026-11-25 Stock Gainers reading` → `{kind:'INFO', scope:'MARKET', claims:[{text:'stocks weak, index strong', subject:'MARKET', bias:'CAUTION', claimType:'RELATIVE_BREADTH', verdict:'CONFIRMED', evidence:[{fact:'NIFTY change', value:'+0.4%', source:'quotes'},{fact:'A/D', value:'0.8', source:'breadth'}]}], call:null, summary:'…'}` → `ok true`, claim unchanged.
  In `message-reader.config.spec.ts`: `defaults to off`; `reads MESSAGE_READER=shadow`; `an unknown value is off`; defaults `packetMs 3000, timeoutMs 25000, maxAgeMin 30, model 'claude-sonnet-5'`.
- [ ] **Step 2: Run** `npx jest apps/api/src/modules/message-reader -t "validate|config"` — Expected: FAIL (modules not found).
- [ ] **Step 3: Implement** the types, schema, `validateReading`, `parseMessageReaderConfig`; add the Prisma model and hand-written `migration.sql` (CREATE TABLE + indexes, matching the model; follow `202611241100_news_ai/migration.sql` style).
- [ ] **Step 4: Run** the same jest command — Expected: PASS. Run `npx prisma validate` — Expected: "The schema is valid".
- [ ] **Step 5: Commit** — `git add prisma/schema.prisma prisma/migrations/202611251600_message_readings apps/api/src/modules/message-reader` ; `git commit -m "feat(message-reader): readings table, config and reply contract"`

### Task 2: Rule-parse comparison and judge-note selection (pure)

**Files:**
- Create: `apps/api/src/modules/message-reader/domain/parse-compare.ts`
- Create: `apps/api/src/modules/message-reader/domain/notes-for-judge.ts`
- Test: matching `.spec.ts` files

**Interfaces:**
- Consumes: `ReaderCall`, `Claim`, `ReadScope` (Task 1).
- Produces:
  - `parseAgrees(ai: ReaderCall, rule: { underlying: string; side: string; optionType: string|null; strike: number|null; entryLow: number|null; entryHigh: number|null; stopLoss: number|null; targets: number[] }): { agrees: boolean; diffs: string[] }` — fields compared: underlying, side, optionType, strike exactly; entry band, SL and first target within 0.5% (null vs null agrees; null vs value is a diff).
  - `interface ReadingRow { messageId; channelId; channelTitle: string; postedAt: Date; scope: ReadScope; claims: Claim[]; summary: string|null }`.
  - `interface VerifiedNote { channel: string; at: string /*HH:MM IST*/; scope; subject: string; claim: string; bias; verdict: 'CONFIRMED'|'CONTRADICTED'; evidence: Evidence[] }`.
  - `selectVerifiedNotes(rows: ReadingRow[], q: { underlying: string; sector: string|null; now: Date }): VerifiedNote[]` — only today's (IST session of `now`) rows posted ≤ `now`; only claims with verdict CONFIRMED/CONTRADICTED; keep MARKET scope, SECTOR where `subject === q.sector`, INSTRUMENT where `subject === q.underlying`; newest first; max 10.

- [ ] **Step 1: Write failing tests:**
  - `agrees on the same call with SL 0.3% apart`; `differs on strike` → `diffs ['strike']`; `null SL vs 245 is a diff`.
  - `keeps MARKET notes and drops UNCLEAR`; `keeps INSTRUMENT notes only for the call's underlying` (SENSEX note kept for SENSEX, dropped for NIFTY); `drops yesterday's notes`; `drops notes posted after now`; `caps at 10 newest first`.
- [ ] **Step 2: Run** `npx jest apps/api/src/modules/message-reader/domain -t "agrees|differs|notes"` — Expected: FAIL.
- [ ] **Step 3: Implement** both pure functions.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** — `git add apps/api/src/modules/message-reader/domain` ; `git commit -m "feat(message-reader): rule-parse comparison and judge note selection"`

### Task 3: The data packet (parallel, time-boxed, cached market pulse)

**Files:**
- Create: `apps/api/src/modules/message-reader/services/reader-packet.service.ts`
- Modify: `apps/api/src/modules/market-data/market-data.module.ts` (export `BreadthSectorService`)
- Modify: `apps/api/src/modules/signal-trader/signal-trader.module.ts` (add `exports: [SignalContextService, SIGNAL_TRADER_CONFIG]`)
- Test: `apps/api/src/modules/message-reader/services/reader-packet.service.spec.ts`

**Interfaces:**
- Consumes: `BreadthSectorService.getBreadth(userId)`, `.getSectorPerformance(userId)`; `MarketQuoteResolver.resolveQuotes(userId, refs)` (token `MARKET_QUOTE_RESOLVER`) for NIFTY `99926000`/NSE, BANKNIFTY `99926009`/NSE, SENSEX `99919000`/BSE (tokens from `UNDERLYING_TOKEN_MAP` in `market-context.service.ts`); `SignalContextService.build({underlying, kind, exchange, ownerUserId, now})` for each named instrument; owner id from `SIGNAL_TRADER_CONFIG.ownerUserId`.
- Produces:
  - `type PacketBlock = { status: 'present'; source: string; value: unknown } | { status: 'unavailable'; source: string; reason: string }`.
  - `interface ReaderPacket { at: string; marketPulse: { indices: PacketBlock; breadth: PacketBlock; sectors: PacketBlock }; instruments: Record<string, Record<string, unknown>>; channelRecent: PacketBlock; todayNotes: PacketBlock }`.
  - `ReaderPacketService.build(i: { text: string; channelId: string; underlyings: string[]; now: Date }): Promise<{ packet: ReaderPacket; ms: number }>`.
  - Market pulse (indices + breadth + sectors) cached 60 s and shared across concurrent builds (one in-flight promise, not one per post) — breadth costs a quote batch on the owner's session (Angel limit 10 req/s).
  - `underlyings` come from `prefilter(text, vocab).underlyings` (signal-intake vocabulary) — max 3 instruments built.
  - `channelRecent` = that channel's last 30 min of posts (raw text, ≤ 10). `todayNotes` = today's READ rows with CONFIRMED/CONTRADICTED MARKET claims (≤ 10).

- [ ] **Step 1: Write failing tests** (fakes for every dependency, fake timers):
  - `time-boxes a hanging source` → breadth never resolves; `build` resolves by 3000 ms with `marketPulse.breadth = {status:'unavailable', reason: /timed out after 3000/}`, other blocks present.
  - `shares one market-pulse fetch across 5 concurrent builds` → `getBreadth` called once.
  - `refetches the market pulse after 60 s`.
  - `builds at most 3 named instruments` (4 underlyings → 3 `SignalContextService.build` calls).
  - `a failing instrument build is unavailable, not a throw`.
- [ ] **Step 2: Run** `npx jest reader-packet` — Expected: FAIL.
- [ ] **Step 3: Implement** `ReaderPacketService`; wrap each source in a `race` with the time box; add the two module exports.
- [ ] **Step 4: Run** `npx jest reader-packet` — Expected: PASS. Run `npx tsc -p apps/api --noEmit` — Expected: no errors.
- [ ] **Step 5: Commit** — `git add apps/api/src/modules/message-reader/services/reader-packet.service.ts apps/api/src/modules/message-reader/services/reader-packet.service.spec.ts apps/api/src/modules/market-data/market-data.module.ts apps/api/src/modules/signal-trader/signal-trader.module.ts` ; `git commit -m "feat(message-reader): parallel time-boxed data packet with shared market pulse"`

### Task 4: The AI read (prompt, transport, agent registry)

**Files:**
- Create: `apps/api/src/modules/message-reader/domain/reader-prompt.ts`
- Create: `apps/api/src/modules/message-reader/services/message-reader-llm.service.ts`
- Modify: `config/ai-agents.json` (add `signal.read` entry, see Global Constraints)
- Test: `apps/api/src/modules/message-reader/services/message-reader-llm.service.spec.ts`

**Interfaces:**
- Consumes: `READER_REPLY_SCHEMA`, `validateReading` (Task 1); `ReaderPacket` (Task 3); `runInSharedSlot` (`ai-assist/assist-slot.ts`), `directRecordedTransport`, `judgeTransportFrom`, `aiCallsRecordingOn` — copy the wiring in `signal-intake/services/signal-parse-llm.service.ts` (`recorded(job)`).
- Produces:
  - `READER_PROMPT_VERSION = 'message-reader-v1'`; `READER_SYSTEM: string`.
  - `READER_JOB = 'signal.read'`.
  - `MessageReaderLlm.read(i: { text: string; channelTitle: string; postedAtIst: string; packet: ReaderPacket; imageReading?: unknown }): Promise<{ reply: ReaderReply; ms: number; model: string }>` — throws on refusal, invalid reply, timeout or busy.
- Prompt must state (exact rules, wording is the builder's):
  1. Read the post (Hinglish allowed); classify kind and scope; split into claims.
  2. A verdict says whether **our data at this moment** agrees with what the channel says is happening — not a forecast. Forward-looking claims with nothing present to check are `NOT_CHECKABLE`.
  3. Every CONFIRMED/CONTRADICTED claim cites packet numbers in `evidence` with the packet block name as `source`; never invent a number; an `unavailable` block cannot be evidence.
  4. Never reason from 1-minute data; the packet's smallest bar is 15m.
  5. For CALL/UPDATE fill `call`; otherwise `call: null`.
  6. `summary`: one plain line for the owner.

- [ ] **Step 1: Write failing tests** (fake transport):
  - `sends job signal.read with the reader schema and effort low` → captured request has `output_config.format.schema === READER_REPLY_SCHEMA`, `effort 'low'`, model from config.
  - `malformed reply becomes an error` → transport returns text `"not json"` → `read` rejects with `/schema/`.
  - `a refusal is an error` → `stop_reason 'refusal'` → rejects `/declined/`.
  - `packet unavailable blocks are passed through, not dropped` → the user message JSON contains `"status":"unavailable"`.
- [ ] **Step 2: Run** `npx jest message-reader-llm` — Expected: FAIL.
- [ ] **Step 3: Implement** the prompt, the service and the `ai-agents.json` entry.
- [ ] **Step 4: Run** `npx jest message-reader-llm` and `npx jest ai-gateway/agents` (registry parse tests) — Expected: PASS.
- [ ] **Step 5: Commit** — `git add apps/api/src/modules/message-reader/domain/reader-prompt.ts apps/api/src/modules/message-reader/services/message-reader-llm.service.ts apps/api/src/modules/message-reader/services/message-reader-llm.service.spec.ts config/ai-agents.json` ; `git commit -m "feat(message-reader): AI read on the reading agent (signal.read, strict JSON)"`

### Task 5: The reader service, repository and module (queue, events, storage)

**Files:**
- Create: `apps/api/src/modules/message-reader/repositories/message-reader.repository.ts`
- Create: `apps/api/src/modules/message-reader/services/message-reader.service.ts`
- Create: `apps/api/src/modules/message-reader/message-reader.module.ts`
- Modify: `apps/api/src/app.module.ts` (import `MessageReaderModule`)
- Modify: `apps/api/src/modules/signal-intake/domain/types.ts` (add `SIGNAL_VISION_DONE_EVENT = 'signal.vision.done'` and `interface VisionDoneEvent { messageId: string; channelId: string; postedAt: Date; text: string; reading: unknown }`)
- Modify: `apps/api/src/modules/signal-intake/services/signal-intake.service.ts` — at every exit of `applyVision` after `save`/`createFromParsed`, emit `SIGNAL_VISION_DONE_EVENT` via `this.emitter?.emit(...)` with `reading: stored`
- Test: `apps/api/src/modules/message-reader/services/message-reader.service.spec.ts`; extend `signal-intake.service.spec.ts` with `emits signal.vision.done after an image is read`

**Interfaces:**
- Consumes: Tasks 1–4; `TELEGRAM_MESSAGE_EVENT`; `textHash` from signal-intake domain; `agentsOn()`.
- Produces:
  - `MessageReaderRepository`: `upsertReading(row)`, `cachedByHash(textHash: string, since: Date)`, `ruleClassOf(messageId)` (reads `signal_message_classes.status` + linked `telegram_signals` fields for the comparison), `readingsForSession(sessionDate: string): Promise<ReadingRow[]>`, `countsSince(since: Date): Promise<{ posts: number; byStatus: Record<string, number>; p50Ms: number|null; p95Ms: number|null; lastReadAt: Date|null }>`, `unscored(since: Date)`, `fillOutcome(messageId, outcomes, now)`.
  - `MessageReaderService.enqueue(job: { messageId; channelId; postedAt: Date; receivedAt: Date; text: string; imageReading?: unknown }): void` — no await by callers.
  - `@OnEvent(TELEGRAM_MESSAGE_EVENT)` → enqueue text posts (posts with media wait for `SIGNAL_VISION_DONE_EVENT` instead). `@OnEvent(SIGNAL_VISION_DONE_EVENT)` → enqueue with `imageReading`.
  - In-process queue: at most 8 reads in flight (matches the agent limit; the agent is the hard gate, this avoids queuing busy errors); FIFO; dedupe by `messageId` while queued/in flight; an edit (same `messageId`, new text) re-reads into the same row.
  - Flow per job: age check → STALE; cache hit by `textHash` within 15 min → copy as CACHED; else packet → AI → `validateReading` → for CALL/UPDATE compute `parseAgrees` (or `missedByRules = true` when the rule class is NOISE/INFO) → upsert READ with latencies. Failure → upsert FAILED with `error`; one retry if post < 5 min old.
  - Mode `off` or `!agentsOn()` → listeners return immediately.

- [ ] **Step 1: Write failing tests** (fake repo, fake LLM, fake packet, fake clock):
  - `reads a burst of 10 with at most 8 in flight` → LLM fake records max concurrent = 8; all 10 rows READ.
  - `the same messageId twice while queued is read once`.
  - `re-reads an edited post into the same row` → second event with new text → `upsertReading` called twice with same `messageId`, second has new summary.
  - `a post older than 30 min at dequeue is STALE and not read`.
  - `a forwarded duplicate within 15 min is CACHED, no AI call`.
  - `an AI failure stores FAILED and retries once while fresh` / `does not retry a post older than 5 min`.
  - `a CALL the rules dropped as NOISE is missedByRules`; `a CALL matching the rule parse has parseAgrees true`.
  - `image posts are read only after vision done` → TELEGRAM event with `media` does not enqueue; VISION_DONE does.
  - `off mode reads nothing`; `agents off reads nothing`.
  - `never emits signal.ready` → emitter fake sees no `signal.ready`.
- [ ] **Step 2: Run** `npx jest message-reader.service signal-intake.service` — Expected: new tests FAIL.
- [ ] **Step 3: Implement** repository, service, module (`imports: [PrismaModule, AiGatewayModule, TradeSentinelModule, MarketDataModule, SignalTraderModule]`), the event emit in `applyVision`, and register the module in `app.module.ts`.
- [ ] **Step 4: Run** `npx jest apps/api/src/modules/message-reader apps/api/src/modules/signal-intake` — Expected: PASS. Run `npx tsc -p apps/api --noEmit` — Expected: clean.
- [ ] **Step 5: Commit** — `git add apps/api/src/modules/message-reader apps/api/src/app.module.ts apps/api/src/modules/signal-intake/domain/types.ts apps/api/src/modules/signal-intake/services/signal-intake.service.ts apps/api/src/modules/signal-intake/services/signal-intake.service.spec.ts` ; `git commit -m "feat(message-reader): concurrent reader over telegram and vision events"`

### Task 6: Judge sees verified notes (mode `on` only)

**Files:**
- Modify: `apps/api/src/modules/signal-trader/repositories/signal-trader.repository.ts` (`channelViews` gains `verifiedNotes`)
- Modify: `apps/api/src/modules/signal-trader/domain/judge.ts` (prompt line for `verifiedNotes`; bump `SIGNAL_JUDGE_PROMPT_VERSION` → `signal-judge-v7`, `SIGNAL_JUDGE_PROMPT_VERSION_TAKE` → `signal-judge-v9-take`)
- Test: `signal-trader.repository.spec.ts` (or the existing channelViews spec), `judge.spec.ts`

**Interfaces:**
- Consumes: `selectVerifiedNotes` (Task 2); reads `message_readings` + `telegram_channels.title` through Prisma directly (no module import of message-reader — avoids a cycle); `parseMessageReaderConfig(process.env).mode`.
- Produces: `channelViews(underlying, now, sector?: string|null)` returns, when mode is `on`, an extra `verifiedNotes: VerifiedNote[]` (empty array when none) plus `verifiedNotesSource: 'message_readings (AI present-state check), today'`. In `off`/`shadow` the key is absent and the prompt version is unchanged (version bump applies only when notes are present: `signalJudgePromptVersion` reads the mode).
- Prompt line (judge.ts, alongside the existing `channelViews` line): verifiedNotes are channel claims checked against our data at post time — context weighted by verdict and by the channel's information accuracy; never a trigger to take or skip on their own; a CONTRADICTED note counts against the channel's claim, not for the opposite trade.

- [ ] **Step 1: Write failing tests:**
  - `channelViews has no verifiedNotes in shadow mode`.
  - `channelViews includes today's MARKET CONFIRMED note in on mode` (seed the 09:31 Stock Gainers reading; query SENSEX at 09:32 → one note, `channel 'Stock Gainers (SEBI Registered)'`, `at '09:31'`).
  - `prompt version is signal-judge-v9-take only when notes are on`.
- [ ] **Step 2: Run** `npx jest signal-trader -t "verifiedNotes|prompt version"` — Expected: FAIL.
- [ ] **Step 3: Implement.** Pass `sector` from the existing sector lookup if one is available in `runJudge`; otherwise `null` (SECTOR notes then only reach the judge via MARKET scope).
- [ ] **Step 4: Run** `npx jest apps/api/src/modules/signal-trader` — Expected: PASS (all existing judge tests too).
- [ ] **Step 5: Commit** — `git add apps/api/src/modules/signal-trader/repositories/signal-trader.repository.ts apps/api/src/modules/signal-trader/domain/judge.ts <their spec files>` ; `git commit -m "feat(signal-trader): judge reads AI-verified channel notes when MESSAGE_READER=on"`

### Task 7: Health check, owner alerts and the endpoints

**Files:**
- Create: `apps/api/src/modules/message-reader/domain/reader-health.ts`
- Create: `apps/api/src/modules/message-reader/services/message-reader.cron.ts`
- Create: `apps/api/src/modules/message-reader/controllers/message-reader.controller.ts`
- Modify: `apps/api/src/modules/message-reader/services/message-reader.service.ts` (owner alert after a READ)
- Test: `reader-health.spec.ts`, `message-reader.cron.spec.ts`, `message-reader.controller.spec.ts`, extend `message-reader.service.spec.ts`

**Interfaces:**
- Consumes: `MessageReaderRepository.countsSince`, `readingsForSession`; `sendOpsAlert(key, text)` from `common/utils/ops-alert.ts`; market-hours clock as used by `signal-intake.cron.ts` (`isTradingDay('NSE', now)` + 09:15–15:30 IST); `CronLeaseService.runExclusiveFailClosed`; `bootJobsEnabled()`.
- Produces:
  - `readerUnhealthy(c: { posts15m: number; read15m: number; marketOpen: boolean }): boolean` → `marketOpen && posts15m >= 3 && read15m === 0`.
  - Cron every 5 min (`*/5 9-15 * * 1-5`, Asia/Kolkata): when unhealthy → `sendOpsAlert('message-reader-dead', '…posts N, read 0 in 15 min; last read HH:MM IST; last error …')`.
  - Owner alert (mode `on` only): after a READ with a MARKET claim CONFIRMED and bias CAUTION/BEAR/BULL → `sendOpsAlert('market-note:<channelId>', '<channel> HH:MM — <claim> → CONFIRMED (<evidence values>)')`; at most one per channel per 30 min (key cooldown is in `sendOpsAlert`; verify its `OPS_ALERT_COOLDOWN_MS` ≥ 30 min or keep a local 30-min map).
  - `GET /api/message-reader/health` → `{ mode, agentsOn, lastReadAt, lastHour: { posts, byStatus, p50Ms, p95Ms } }`.
  - `GET /api/message-reader/notes?date=YYYY-MM-DD` → readings for that IST session, newest first, with channel title, kind, scope, claims, summary, latency, status. Both guarded like `signal-trader.controller.ts` (owner/JWT guard used there).

- [ ] **Step 1: Write failing tests:**
  - `alerts when posts arrive and nothing is read` (posts 3, read 0, open) → `sendOpsAlert` called with key `message-reader-dead`.
  - `quiet when the market is closed`; `quiet with 2 posts`.
  - `sends a market note alert in on mode` / `no market note alert in shadow mode` / `no alert for an UNCLEAR claim`.
  - controller: `health returns p95` ; `notes returns the day's readings newest first`.
- [ ] **Step 2: Run** `npx jest message-reader -t "alert|health|notes"` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx jest apps/api/src/modules/message-reader` — Expected: PASS.
- [ ] **Step 5: Commit** — `git add apps/api/src/modules/message-reader` ; `git commit -m "feat(message-reader): health check, market-note alerts, health and notes endpoints"`

### Task 8: Night scoring of claims

**Files:**
- Create: `apps/api/src/modules/message-reader/domain/claim-outcome.ts`
- Modify: `apps/api/src/modules/message-reader/services/message-reader.cron.ts` (nightly job)
- Test: `claim-outcome.spec.ts`

**Interfaces:**
- Consumes: daily and 15m bars via the same `InfoBars` provider signal-intake uses (`signal-intake.module.ts` `InfoBars` factory — reuse the shape `DailyBar` from `signal-intake/domain/info-outcome.ts`); session A/D close from `BreadthSectorService` snapshot stored at read time is **not** enough — store the 15:25 IST breadth in the cron's own read (`getBreadth(owner)` at the 15:25 run) into the outcome.
- Produces: `scoreClaim(c: Claim, ctx: { niftyDaily: DailyBar[]; subjectDaily: DailyBar[] | null; postSession: string; postClose: number|null /*NIFTY 15m close at post*/; sessionClose: number|null; sessionRange: number|null; medianRange20: number|null; atr14: number|null; adAtClose: number|null }): { status: 'RIGHT'|'WRONG'|'NOT_SCORED'; why: string }` with the spec's rules:
  - INSTRUMENT BULL/BEAR → `judgeInfoItem` (existing).
  - MARKET BULL/BEAR → NIFTY close-to-close vs ±0.3×ATR14 (inside band = NOT_SCORED "flat").
  - CAUTION → RIGHT if `sessionRange ≥ medianRange20` or NIFTY fell ≥ 0.3×ATR14 from post to close; else WRONG.
  - RELATIVE_BREADTH ("index strong, stocks weak") → RIGHT if NIFTY return from post to close > 0 and `adAtClose < 1`; WRONG otherwise.
  - SECTOR → the sector index daily close vs ±0.3×ATR14.
  - FLOW, GAP, OTHER, NOT_CHECKABLE-only → NOT_SCORED.
  - Two crons: `25 15 * * 1-5` stores `adAtClose` for today's rows; `30 18 * * 1-5` scores rows whose session is complete and fills `outcomes` + `outcomeFilledAt`.

- [ ] **Step 1: Write failing tests:** one per rule above, including `Stock Gainers 2026-11-25 RELATIVE_BREADTH is RIGHT when NIFTY +0.4% and A/D 0.8 at close`, `CAUTION is RIGHT on a wide-range day`, `FLOW is NOT_SCORED`.
- [ ] **Step 2: Run** `npx jest claim-outcome` — Expected: FAIL.
- [ ] **Step 3: Implement** `scoreClaim` and the two cron jobs (lease + `bootJobsEnabled()` like `signal-intake.cron.ts`).
- [ ] **Step 4: Run** `npx jest apps/api/src/modules/message-reader` — Expected: PASS.
- [ ] **Step 5: Commit** — `git add apps/api/src/modules/message-reader` ; `git commit -m "feat(message-reader): nightly scoring of channel claims"`

### Task 9: "Market notes" list on the Telegram signals page

**Files:**
- Modify: `apps/web/src/pages/signals-telegram/signalsTelegram.ts` (API calls)
- Create: `apps/web/src/pages/signals-telegram/MarketNotes.tsx`
- Modify: `apps/web/src/pages/signals-telegram/SignalsTelegramView.tsx` (render `MarketNotes` above the signal list)
- Test: `apps/web/src/pages/signals-telegram/marketNotes.test.tsx`

**Interfaces:**
- Consumes: `GET /api/message-reader/notes?date=`, `GET /api/message-reader/health` (Task 7).
- Produces: `fetchMarketNotes(date: string)`, `fetchReaderHealth()`; `<MarketNotes date={string} />` — one row per reading: time IST, channel, summary, each claim with a verdict chip (CONFIRMED green, CONTRADICTED red, UNCLEAR grey, NOT_CHECKABLE outline) and its evidence values on expand; header shows mode and p95 latency; a red badge "Reader not reading" when health has posts in the last hour and `lastReadAt` older than 15 min. Polls every 30 s. Hidden when mode is `off`.

- [ ] **Step 1: Write failing tests:** `renders a CONFIRMED chip with evidence`; `shows the red badge when nothing was read for 15 min`; `renders nothing when mode is off`.
- [ ] **Step 2: Run** `npx vitest run apps/web/src/pages/signals-telegram/marketNotes.test.tsx` — Expected: FAIL.
- [ ] **Step 3: Implement** with the page's existing components and styles.
- [ ] **Step 4: Run** the same — Expected: PASS. Run `npm run build -w apps/web` — Expected: success.
- [ ] **Step 5: Commit** — `git add apps/web/src/pages/signals-telegram` ; `git commit -m "feat(web): market notes list with verdicts on the Telegram signals page"`

### Task 10: Judge replay with and without notes (gate for `on`)

**Files:**
- Create: `apps/api/scripts/sql/export-notes-replay.sql`
- Create: `apps/api/scripts/notes-judge-replay.ts`
- Test: `apps/api/scripts/notes-judge-replay.spec.ts`

**Interfaces:**
- Consumes: `signal_decisions.judge->'packet'` for one session (the stored judge packet); that session's `message_readings`; `selectVerifiedNotes` (Task 2); the judge system prompt builder in `signal-trader/domain/judge.ts`; grading via `rescore-judge.ts`'s fair-score path (`domain/fair-inputs` → `domain/fair-score`).
- Produces: `npx tsx apps/api/scripts/notes-judge-replay.ts <fixture.json> --session YYYY-MM-DD > notes-replay.md` — for each decision: verdict without notes (stored), verdict re-run with `verifiedNotes` injected as of the decision time (Vertex, same model/effort as prod judge), the graded 1-lot outcome of each verdict, and a total: `with-notes net vs without-notes net`, flips listed. Verdict line `GO` only if with-notes net ≥ without-notes net.
- The export SQL is read-only (`default_transaction_read_only=on`, as `pull-fix-queue.sh` runs psql).

- [ ] **Step 1: Write failing tests** (fake transport + tiny fixture): `injects only notes posted before the decision`; `GO when with-notes net is not worse`; `NO-GO when worse`.
- [ ] **Step 2: Run** `npx jest notes-judge-replay` — Expected: FAIL.
- [ ] **Step 3: Implement** the SQL and the script.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** — `git add apps/api/scripts/sql/export-notes-replay.sql apps/api/scripts/notes-judge-replay.ts apps/api/scripts/notes-judge-replay.spec.ts` ; `git commit -m "feat(message-reader): judge replay with and without verified notes"`

### Task 11: Rollout

- [ ] **Step 1:** Full suite: `npm test -w apps/api` and `npm test -w apps/web` — Expected: all PASS (record counts).
- [ ] **Step 2:** After 15:35 IST (check `ssh … "TZ=Asia/Kolkata date"`), with no open-position decision pending: merge `feature/ai-message-reader` into `main` locally, push `main`. Verify the deploy: containers run the new SHA (`docker ps --format '{{.Image}}'`), migration applied (`\d message_readings`).
- [ ] **Step 3:** Set prod env `MESSAGE_READER=shadow`, `AGENTS_GLOBAL_CONCURRENCY=24` in the server `.env`; recreate `grw-api` and `grw-agents-*` with `GRW_API_TAG=<current sha>` (memory: signal-judge-effort). Confirm `GET /api/message-reader/health` shows `mode: shadow, agentsOn: true`.
- [ ] **Step 4:** Next session: check `message_readings` — p50/p95 latency vs 15 s/30 s, FAILED count, verdict quality on 10 hand-checked rows (including any market-wide posts), `missedByRules` rows. Report to owner.
- [ ] **Step 5:** Export the session fixture, run Task 10's replay, report GO/NO-GO to the owner. Only on GO and owner OK: set `MESSAGE_READER=on`, recreate, confirm judge packets carry `verifiedNotes` (`signal_decisions.judge->'packet'->'channelViews'->'verifiedNotes'`).
- [ ] **Step 6:** Remind the owner that `TELEGRAM_ALERT_BOT_TOKEN` / `TELEGRAM_ALERT_CHAT_ID` are empty on prod, so health and market-note alerts reach no one until set; the UI list and badge work regardless.
- [ ] **Step 7:** Update memory (`MEMORY.md` pointer + a `message-reader-status.md` file) with mode, dates and results.
