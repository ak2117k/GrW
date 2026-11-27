# Trade Agent Exit Authority Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** With `TRADE_AGENT_AUTHORITY=live`, no code rule sells a live trade. Every rule becomes an alarm that wakes that trade's sentinel agent. The agent's EXIT/BOOK is confirmed by the supreme (desk manager). AI outages fail over and escalate to the owner on Telegram. There are only two code sells left: the hard-loss backstop, when everyone is unreachable, and the broker deadline.

**Architecture:** There is a new leaf module `exit-authority` (config, alarm store, ports, escalation runner, Telegram bot). Existing sellers keep computing their rule. When authority is live they call `TradeAlarms.raise(...)` instead of writing a rule EXIT_NOW or firing an order. The sentinel cycle force-judges any tracker with an open alarm, and puts the alarm and the supreme's brief in the packet. The exit poller sends rule-stamped verdicts to alarms, and LLM EXIT_NOW verdicts to the supreme's confirm before the executor. `off` is exactly today's behaviour.

**Tech Stack:** NestJS 10, Prisma (PostgreSQL), Jest, Telegram Bot HTTP API (fetch), existing `MessagesTransport` (Vertex / CLI).

**Spec:** `docs/superpowers/specs/2026-11-27-trade-agent-exit-authority-design.md`

## Global Constraints

- Flag `TRADE_AGENT_AUTHORITY=off|live`. The default is `off`, and anything unrecognised means `off`. `off` must change nothing in today's behaviour, and every task's tests include an `off` case.
- `live` takes effect only after the boot check: `TELEGRAM_ALERT_BOT_TOKEN` and `TELEGRAM_ALERT_CHAT_ID` are set **and** a test `sendMessage` returned ok. Otherwise the effective mode is `off`, with ERROR log `[exit-authority] TRADE_AGENT_AUTHORITY=live refused: <why>`.
- Applies to LIVE trackers only. `isPaperTracker(id)` trackers keep today's rules. Trackers on the owner hold list (`AI_AUTO_EXIT_HOLD`) are untouched, as today.
- Timings (constants in `exit-authority/domain/timings.ts`; no env):
  - `CONFIRM_TIMEOUT_MS=30_000`
  - `ESCALATE_AFTER_MS=120_000`
  - `ESCALATE_URGENT_AFTER_MS=60_000`
  - `DEADLINE_WARN_MS=600_000`
  - `DEADLINE_EXIT_LEAD_MS=120_000`
  - `BACKSTOP_OWNER_SILENT_MS=600_000`
  - `OWNER_HOLD_SNOOZE_MS=900_000`
  - `REALERT_EVERY_MS=300_000`
  - `REALARM_EVERY_MS=300_000`
  - `REALARM_URGENT_EVERY_MS=120_000`
  - `TRACKER_WAKE_MIN_GAP_MS=20_000`
  - `SUPREME_EXIT_AGENT_LOOK_MS=60_000`
- Never log or commit tokens. Telegram tokens come from env only.
- Commit with explicit pathspecs only (parallel agents share one tree). Never `git commit -a`. Never push. Push = prod deploy, and only the lead pushes after owner OK.
- Run only your own specs: `npx jest <paths>` from `apps/api`. Do not run the whole suite in parallel. The disk is nearly full, so check with `df -h /c` and stop if under 700 MB.
- Type check: `npx tsc --noEmit -p apps/api/tsconfig.json`. The error count must not rise above the baseline **181**.
- 15m is the smallest analysis unit, so the alarm chart read uses closed 5m/15m bars and N15 (the existing `readChart`).

## Review Focus

1. **The same rule re-firing every pass** (for example the hard loss, which stays past its limit). Expect one open alarm per (tracker, rule). Re-raise only at ≥1 N15 worse, or every 5 min (2 min urgent). This is tested in Task 1 (`shouldReRaise`).
2. **An alarm raised and the agent's look failing, timing out or being suppressed.** Expect a forced look on the next pass and escalation at 2 min (60 s urgent). It must never be silent. This is tested in Task 3 (forced look ignores suppression) and Task 6 (escalation due).
3. **The supreme confirm timing out or returning junk.** Expect the agent's EXIT to stand, logged as `TIMEOUT` or `ERROR`. This is tested in Task 5 (`parseConfirmReply` junk → ERROR) and Task 4 (TIMEOUT → execute).
4. **A Telegram button tap from a different chat, or a replayed or old callback.** Expect it to be ignored, with only the configured chat id and open alarms acted on. This is tested in Task 6.
5. **The process restarting with open alarms.** Expect everything to be DB-backed, so escalation and the backstop resume and no alarm is lost. This is tested in Task 6 (runner reads state only from the repo).

---

## File Structure

```
apps/api/src/modules/exit-authority/                (NEW leaf module — Task 1, 6)
  exit-authority.module.ts                          providers + exports (Task 1; Task 7 wires consumers)
  exit-authority.config.ts                          parseAuthorityMode(env) (Task 1)
  exit-authority.tokens.ts                          DI tokens + port interfaces (Task 1)
  domain/timings.ts                                 constants above (Task 1)
  domain/alarm.ts                                   pure lifecycle rules (Task 1)
  repositories/trade-alarm.repository.ts            Prisma store (Task 1)
  services/trade-alarms.service.ts                  raise/resolve + wake (Task 1)
  services/authority-state.service.ts               boot check, isLive() (Task 6)
  services/escalation-runner.service.ts             15 s pass: resolve, escalate, backstop (Task 6)
  telegram/telegram-bot.client.ts                   sendMessage/edit/getUpdates/answerCallback (Task 6)
  telegram/owner-buttons.service.ts                 long-poll callbacks → Exit/Hold (Task 6)
prisma/schema.prisma + prisma/migrations/202611272000_trade_agent_authority/  (Task 1)
apps/api/src/modules/ai-gateway/audit/failover-transport.ts   (Task 2)
apps/api/src/modules/trade-sentinel/**  + intraday-carry/**   (Task 3)
apps/api/src/modules/sentinel-executor/**                    (Task 4)
apps/api/src/modules/desk-manager/**                         (Task 5)
```

Parallel waves: **Task 1** first (alone). Then **Tasks 2, 3, 4, 5, 6** in parallel; each owns only its directories above. Then **Task 7** (wiring + legacy + full verification).

---

### Task 1: Foundations — schema, config, ports, alarm lifecycle, alarm service

**Files:**
- Modify: `prisma/schema.prisma` (append two models)
- Create: `prisma/migrations/202611272000_trade_agent_authority/migration.sql`
- Create: all `exit-authority/` files marked Task 1 above
- Test: `exit-authority/domain/alarm.spec.ts`, `exit-authority/services/trade-alarms.service.spec.ts`, `exit-authority/exit-authority.config.spec.ts`

**Interfaces — Produces (everyone codes against these):**
```ts
// exit-authority.config.ts
export type AuthorityMode = 'off' | 'live';
export function parseAuthorityMode(env: Record<string, string | undefined>): AuthorityMode;

// exit-authority.tokens.ts
export type AlarmUrgency = 'normal' | 'urgent' | 'deadline';
export type AlarmRule = 'HARD_LOSS' | 'HARD_LOSS_FAST' | 'FLOOR' | 'LADDER' | 'PRICE_TRIGGER' | 'CARRY' | 'TARGET_LOCK' | 'SUPREME_EXIT';
export interface RaiseAlarm {
  userId: string; trackerId: string; symbol: string; rule: AlarmRule; urgency: AlarmUrgency;
  reason: string;                     // ≤500 chars, shown to the agent and owner
  wouldHave: string;                  // what the old rule would have done, e.g. "EXIT_NOW FLOOR_HARD_EXIT GREEN_TO_RED"
  deadline?: Date | null;             // required when urgency === 'deadline'
  severityN?: number | null;          // how far past the rule in N15 (for re-raise); null if unknown
  sourceRef?: string | null;          // verdictId / trigger id / decision id that raised it
  payload?: Record<string, unknown>;  // free facts (netPnl, limit, level…)
}
export interface AlarmRow extends RaiseAlarm {
  id: string; status: 'OPEN' | 'ANSWERED' | 'SNOOZED' | 'BACKSTOPPED' | 'CLOSED';
  raisedAt: Date; lastRaisedAt: Date; answeredAt: Date | null; answerVerdictId: string | null; answer: string | null;
  alertedAt: Date | null; alertCount: number; telegramMessageId: number | null; snoozedUntil: Date | null;
}
export const TRADE_ALARMS = Symbol('TRADE_ALARMS');
export interface TradeAlarmsPort {
  /** Persists (or re-raises per shouldReRaise) and wakes the tracker's agent. null = deduped (an open alarm already covers it). */
  raise(a: RaiseAlarm, now?: Date): Promise<AlarmRow | null>;
  openFor(trackerId: string): Promise<AlarmRow[]>;
  /** One read per sentinel user pass. */
  openForTrackers(trackerIds: string[]): Promise<AlarmRow[]>;
  answer(alarmId: string, verdictId: string, answer: string, now?: Date): Promise<void>;
}
export const AUTHORITY_STATE = Symbol('AUTHORITY_STATE');
export interface AuthorityStatePort { isLive(): boolean }
export const TRACKER_WAKE = Symbol('TRACKER_WAKE');
export interface TrackerWakePort { wakeTracker(userId: string, trackerId: string, why: string): void }
export const SUPREME_CONFIRM = Symbol('SUPREME_CONFIRM');
export interface ConfirmRequest {
  userId: string; trackerId: string; symbol: string; agentDecision: 'EXIT' | 'BOOK';
  agentReason: string; alarm: AlarmRow | null; brief: string | null; packetSummary: string;
  /** SUPREME_EXIT round-trip: the agent disagreed with the supreme's own request. */
  agentDisagrees?: boolean;
}
export interface ConfirmResult { decision: 'CONFIRM' | 'OVERRIDE_HOLD' | 'TIMEOUT' | 'ERROR'; reason: string; briefNote?: string | null; latencyMs: number }
export interface SupremeConfirmPort { confirm(req: ConfirmRequest): Promise<ConfirmResult> }
export const TRADE_BRIEFS = Symbol('TRADE_BRIEFS');
export interface TradeBriefsPort { briefFor(trackerId: string): Promise<string | null>; write(trackerId: string, userId: string, text: string, by: 'OPEN' | 'MANAGER' | 'CONFIRM'): Promise<void> }
export const OWNER_ESCALATION = Symbol('OWNER_ESCALATION');
export interface OwnerEscalationPort { blockedExit(input: { userId: string; trackerId: string; symbol: string; reason: string; detail: string }): Promise<void> }
```
Prisma models (snake_case tables, `@map` like `DeskManagerPendingEntry`):
- `TradeAlarm` → `trade_alarms` (all `AlarmRow` fields; `payload Json?`; indexes `[status, trackerId]`, `[trackerId, rule, status]`)
- `TradeBrief` → `trade_briefs` (`trackerId @id`, `userId`, `text`, `by`, `createdAt`, `updatedAt`)

- [ ] **Step 1: Write failing tests** in `domain/alarm.spec.ts` for the pure functions (signatures in Step 3):
  - `shouldReRaise(open, next, now)`:
    - false when the open alarm was raised 30 s ago and `next.severityN - open.severityN < 1`;
    - true at ≥1 N15 worse;
    - true after `REALARM_EVERY_MS` (normal) or `REALARM_URGENT_EVERY_MS` (urgent);
    - false when `open.status==='SNOOZED' && snoozedUntil > now`.
  - `escalationDue(a, now)`:
    - `'ALERT'` when OPEN, unanswered and `now - raisedAt ≥ ESCALATE_AFTER_MS` (60 s for urgent) and no alert yet;
    - `'REALERT'` when alerted ≥ `REALERT_EVERY_MS` ago;
    - `'DEADLINE_WARN'` when `deadline - now ≤ DEADLINE_WARN_MS` and no alert yet;
    - `null` when ANSWERED.
  - `backstopDue(a, ctx, now)` with `ctx = { aiDown: boolean; stillPastLimit: boolean }`:
    - `'DEADLINE'` when `urgency==='deadline'`, unanswered and `now ≥ deadline - DEADLINE_EXIT_LEAD_MS`;
    - `'HARD_LOSS'` only when `rule ∈ {HARD_LOSS, HARD_LOSS_FAST}`, `(ctx.aiDown || unanswered ≥ ESCALATE_URGENT_AFTER_MS)`, `alertedAt` ≤ now − `BACKSTOP_OWNER_SILENT_MS`, and `ctx.stillPastLimit`;
    - `null` if any of these is missing, or SNOOZED.
- [ ] **Step 2:** `npx jest src/modules/exit-authority/domain` → FAIL (module not found).
- [ ] **Step 3:** In `domain/alarm.ts`, implement:
  - `shouldReRaise(open: AlarmRow, next: RaiseAlarm, now: Date): boolean`
  - `escalationDue(a: AlarmRow, now: Date): 'ALERT' | 'REALERT' | 'DEADLINE_WARN' | null`
  - `backstopDue(a: AlarmRow, ctx: { aiDown: boolean; stillPastLimit: boolean }, now: Date): 'DEADLINE' | 'HARD_LOSS' | null`
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Write `exit-authority.config.spec.ts`: `parseAuthorityMode({})==='off'`, `({TRADE_AGENT_AUTHORITY:' LIVE '})==='live'`, `('shadow')==='off'`. Implement. PASS.
- [ ] **Step 6:** Add the Prisma models and a hand-written migration SQL (CREATE TABLE + indexes; follow the `202611262300_desk_manager` style). Run `npx prisma validate` and `npx prisma generate`. Expect no errors.
- [ ] **Step 7:** Write `trade-alarms.service.spec.ts` (fake repo + fake `TRACKER_WAKE`):
  - `raise` creates an OPEN row and calls `wakeTracker(userId, trackerId, 'alarm FLOOR')` once;
  - a second `raise` for the same (tracker, rule) within 30 s, not worse → returns null, no new row, no wake;
  - a worse one → updates `lastRaisedAt`/`severityN` and wakes;
  - `raise` for a paper tracker id → returns null;
  - `answer` sets ANSWERED, `answeredAt`, `answerVerdictId`.
- [ ] **Step 8:** Implement `TradeAlarmsService implements TradeAlarmsPort` and `TradeAlarmRepository` (`create`, `findOpen(trackerId)`, `findOpenForTrackers(ids)`, `findOpenAll()`, `update(id, patch)`, `latestAgentVerdict(trackerId, since): Promise<{id, verdict, createdAt} | null>` — newest `sentinel_verdicts` row for the tracker after `since` whose `promptVersion` is not a rule stamp, i.e. not starting with `rule:`). Also provide `TradeBriefRepository implements TradeBriefsPort` (upsert). Register in `exit-authority.module.ts` and export the tokens `TRADE_ALARMS` and `TRADE_BRIEFS`. `TRACKER_WAKE` is optional (`@Optional()`); when absent, log one WARN.
- [ ] **Step 9:** Run the jest specs for the module → PASS. Run tsc and check the count is ≤ 181.
- [ ] **Step 10:** Commit with pathspecs `prisma/schema.prisma prisma/migrations/202611272000_trade_agent_authority apps/api/src/modules/exit-authority`, message `feat(exit-authority): alarm store, lifecycle rules, ports (Task 1)`.

---

### Task 2: AI route failover transport

**Files:** Create `ai-gateway/audit/failover-transport.ts` and its `.spec.ts`. Modify `trade-sentinel/trade-sentinel.module.ts` (the transport factory, ~line 199) and `desk-manager/services/manager-llm.service.ts:80`.

**Interfaces — Produces:**
```ts
export interface RouteHealth { failures: number; skipUntil: number }
export function failoverTransport(routes: Array<{ name: string; transport: MessagesTransport }>, opts?: { failuresToSkip?: number; skipMs?: number; clock?: () => number; onAllFailed?: (errors: string[]) => void }): MessagesTransport & { allDownSince(): number | null };
export function failoverChainFrom(env: Record<string, string | undefined>): JudgeTransportName[]; // AI_FAILOVER_CHAIN, default 'vertex,cli' (+ 'api' appended when ANTHROPIC_API_KEY is set and not listed)
export const AI_HEALTH = Symbol('AI_HEALTH'); export interface AiHealthPort { allDownSince(): number | null }
```
- [ ] **Step 1: Failing tests:**
  - the first route answers → the second is never called;
  - the first throws → the second answers, and its reply is returned;
  - a `stop_reason: 'refusal'` reply is **returned, not failed over** (a refusal is an answer);
  - after `failuresToSkip` (default 3) consecutive failures the route is skipped for `skipMs` (default 180 000), then tried again;
  - all routes throw → it throws `AllRoutesFailedError` listing each route's error, `onAllFailed` is called, and `allDownSince()` returns the first all-fail time until any success resets it to null;
  - `failoverChainFrom({})` → `['vertex','cli']`; `failoverChainFrom({ANTHROPIC_API_KEY:'x'})` → `['vertex','cli','api']`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. Each route's transport is built by the existing `directRecordedTransport({ judge: name, ... })`, so recording and agent containers are unchanged. The CLI route needs the CLI model aliases (it already handles `claude-opus-5`; Vertex maps them).
- [ ] **Step 4:** Wire it in only when `AI_FAILOVER=on` (default **on** when `TRADE_AGENT_AUTHORITY=live`, else off). With it off, both factories return exactly what they return today. Export `AI_HEALTH` from the trade-sentinel module, bound to the sentinel's failover instance (or a stub returning null when off).
- [ ] **Step 5:** Run the specs and tsc. Commit with pathspecs: `feat(ai-gateway): route failover for sentinel + desk manager (Task 2)`.

---

### Task 3: Sentinel side — rule sellers become alarms; forced look; alarm + brief in packet

**Files (owns):** `trade-sentinel/services/sentinel-cycle.service.ts` (`recordHardFloorExit` ~1566, `rescueHardLoss` ~1445, `recordLadderExit` ~1785, the rule block ~1285-1306, `deadlineLookFor` ~1905), `trade-sentinel/services/sentinel-runner.service.ts` (add `wakeTracker`), the packet builder (wherever `this.packets.build` lives) and the prompt, `intraday-carry/intraday-carry.service.ts` (`recordExit` ~380). Tests are added beside each.

**Interfaces — Consumes:** `TRADE_ALARMS`, `AUTHORITY_STATE`, `TRADE_BRIEFS` (Task 1). **Produces:** `SentinelRunnerService implements TrackerWakePort` (`wakeTracker`); a new tripwire fire kind `'alarm'` (`{ kind: 'alarm', alarmId, rule, reason }`); packet fields `alarm: { rule, reason, urgency, deadline, raisedAt } | null` and `brief: string | null`.

- [ ] **Step 1: Failing tests (cycle spec, with fakes):**
  - authority `live` + `hardLossFor` trips → `alarms.raise` is called with `rule:'HARD_LOSS', urgency:'urgent'`, and `verdicts.record` is **not** called with `verdict:'EXIT_NOW'`;
  - the same for `hardFloorFor` → `rule:'FLOOR'` (normal) and `ladderExitFor` → `rule:'LADDER'`;
  - `rescueHardLoss` → `rule:'HARD_LOSS_FAST'` (urgent), with `payload.limit` and `payload.netPnl` set;
  - authority `off` → exactly today's behaviour (EXIT_NOW recorded);
  - a paper tracker under `live` → today's behaviour.
  - `wouldHave` contains the old reason prefix and rule (e.g. `FLOOR_HARD_EXIT GREEN_TO_RED`).
- [ ] **Step 2:** Run → FAIL. Implement a single private helper, `private async ruleExit(entry, kind, recordToday: () => Promise<...>, alarm: RaiseAlarm)`. It calls `recordToday()` when `!live || paper`, else `alarms.raise(alarm)`. Use it at the four sites. Keep every confirmation and exec-confirm check before it, unchanged. → PASS.
- [ ] **Step 3: Failing test (forced look):** with an OPEN alarm for tracker T whose `raisedAt` is after T's last LLM verdict, a pass with `decision.shouldEvaluate=false` (suppressed / heartbeat not due) still judges T, with fires containing `{kind:'alarm'}`. The judgement bypasses the rate cap, re-judge suppression and futile suppression (same bypass as `deadlineLookFor`). A tracker with no open alarm is unchanged. Two passes 5 s apart judge T once (in-flight lock and `TRACKER_WAKE_MIN_GAP_MS`).
- [ ] **Step 4:** Implement: one `alarms.openForTrackers(ids)` read per user pass. Inject the fire, and pass `alarm` into the packet. → PASS.
- [ ] **Step 5: Failing test (packet/prompt):** the packet includes `alarm` and `brief`. The system prompt gains a section "ALARMS AND BRIEF". It says: an alarm is a code rule that would have sold this trade; verify it on the 5m/15m chart (`readChart` facts are already in the packet) and answer HOLD, TIGHTEN (EXIT_ARMED with a level) or EXIT_NOW, with the reason addressing the alarm. The brief is the supreme's plan and skills for this trade. Golden snapshot updated deliberately: `npx jest -u` on the golden spec only, and review the diff.
- [ ] **Step 6:** Implement `wakeTracker(userId, trackerId, why)` in the runner. It marks the tracker for the forced look and calls the existing `runForUser` path, unless that user is in flight. Venue-closed guard as in `wakeForTick`.
- [ ] **Step 7: Carry:** a test that under `live`, `recordExit` with a code reason (`EXPIRY_DAY`, `NO_JUDGEMENT`, `CARRY not confirmed`) raises `rule:'CARRY', urgency:'deadline', deadline:<the venue square-off / expiry close for that tracker>` and writes no EXIT_NOW. A judge-made non-HOLD (an LLM verdict) is unchanged. Implement it. → PASS.
- [ ] **Step 8:** Run the specs (trade-sentinel and intraday-carry folders only) and tsc. Commit with pathspecs: `feat(trade-sentinel): rule exits raise alarms; forced alarm look; brief in packet (Task 3)`.

---

### Task 4: Executor side — triggers alarm, poller routes via supreme confirm, gate as facts

**Files (owns):** `sentinel-executor/services/trigger-watch.service.ts` (fire ~441), `sentinel-exit-poller.service.ts` (`runOnce` ~136), `sentinel-exit-executor.service.ts` (`gated` ~311, the OPEN_ORDER_EXISTS finish), plus a new `sentinel-executor/services/exit-authority-router.service.ts` and its spec.

**Interfaces — Consumes:** `TRADE_ALARMS`, `AUTHORITY_STATE`, `SUPREME_CONFIRM`, `TRADE_BRIEFS`, `OWNER_ESCALATION` (Task 1). **Produces:**
```ts
export type RouteOutcome = { kind: 'EXECUTE' } | { kind: 'ALARM'; alarmId: string | null } | { kind: 'HELD_BY_SUPREME'; reason: string };
export class ExitAuthorityRouter { route(v: PendingVerdict & { promptVersion: string | null }): Promise<RouteOutcome> }
export const RULE_STAMPS: readonly string[]; // FLOOR_HARD_EXIT_STAMP, TARGET_LADDER_STAMP, CARRY_EXIT_STAMP (import, don't copy)
```
- [ ] **Step 1: Failing router tests:**
  - `off` → `EXECUTE` for everything;
  - `live` + a rule stamp → `ALARM` (rule from the stamp; `wouldHave` = verdict reason) **and** an `ai_exit_executions` row is claimed with status `SKIPPED`, reason `AUTHORITY_ALARM` (so the poller never re-reads it);
  - `live` + an LLM EXIT_NOW → `confirm()` is called; `CONFIRM`/`TIMEOUT`/`ERROR` → `EXECUTE`; `OVERRIDE_HOLD` → `HELD_BY_SUPREME`, with a row SKIPPED `SUPREME_HOLD:<reason>`, the open alarm answered, and `briefNote` written via `TRADE_BRIEFS` when present;
  - `confirm` is raced against `CONFIRM_TIMEOUT_MS`, so a never-resolving fake gives `TIMEOUT` at 30 s (use jest fake timers);
  - a live paper tracker → `EXECUTE`.
  - an LLM EXIT_NOW while the tracker has an OPEN `SUPREME_EXIT` alarm → `EXECUTE` **without** calling `confirm()` (the supreme asked for it), and the alarm is answered.
- [ ] **Step 2:** Implement. `pendingVerdicts` must also select `v."promptVersion"` (and the `PendingVerdict` type gains it as optional). The poller calls `router.route(v)` before `executor.process` and processes only `EXECUTE`. → PASS.
- [ ] **Step 3: Failing trigger test:** `live` + a confirmed cross → `alarms.raise({rule:'PRICE_TRIGGER', urgency:'normal', reason: firedReason(...), sourceRef: t.id})`, the trigger is marked FIRED as today, and `executor.execute` is **not** called. `off` → as today.
- [ ] **Step 4:** Implement at the fire site. → PASS.
- [ ] **Step 5: Failing executor tests:**
  - under `live` the exit gate is not applied (`gated=false`), but its facts are still computed and stored on the row as `gateFacts` (observe), so the AI's confirmed EXIT is not blocked;
  - a finish with `OPEN_ORDER_EXISTS` under `live` calls `OWNER_ESCALATION.blockedExit(...)` once per execution row;
  - `off` → unchanged.
- [ ] **Step 6:** Implement. → PASS.
- [ ] **Step 7:** Run the sentinel-executor specs and tsc. Commit with pathspecs: `feat(sentinel-executor): authority router, trigger alarms, gate as facts (Task 4)`.

---

### Task 5: Desk manager — supreme confirm, briefs, supreme exits as instruction alarms, target-lock alarm

**Files (owns):** create `desk-manager/services/supreme-confirm.service.ts` and `desk-manager/domain/confirm-prompt.ts` (+ specs). Modify:
- `desk-manager/services/desk-exit-actions.service.ts` (`exit` ~73)
- `desk-manager/services/target-watch.service.ts` (`lock` call ~181)
- `desk-manager/services/desk-actions.service.ts` (OPEN success → write brief)
- `desk-manager/domain/{manager-schema,manager-prompt,decision-validate}.ts` (new action `BRIEF`)
- the packet positions view (`brief: string | null`, `hasBrief`)

**Interfaces — Consumes:** `TRADE_ALARMS`, `TRADE_BRIEFS`, `AUTHORITY_STATE` (Task 1). **Produces:** `SupremeConfirmService implements SupremeConfirmPort`, bound to `SUPREME_CONFIRM` and exported from `DeskManagerModule`.

- [ ] **Step 1: Failing tests for `parseConfirmReply(text)`:**
  - `{"decision":"CONFIRM","reason":"…"}` → CONFIRM;
  - `{"decision":"OVERRIDE_HOLD","reason":"…","briefNote":"…"}` → OVERRIDE_HOLD with the note;
  - prose-wrapped JSON → parsed (the same first-`{`…last-`}` fallback as `manager-schema` toJson);
  - an unknown decision or junk → `{decision:'ERROR'}`.
- [ ] **Step 2: Failing service tests:**
  - `confirm()` sends one request: model = the manager's model, `effort:'medium'`, `max_tokens` ≤ 800, the system prompt = `confirmSystemPrompt(cfg)`;
  - the user content includes the agent decision, reason, alarm, brief, `packetSummary`, and the desk's memory block (reuse how the manager packet's `memory` is built);
  - a transport throw → `ERROR`, with the reason containing the message;
  - `agentDisagrees:true` → the prompt says the agent disagreed with the supreme's own exit request, and that this answer is final.
- [ ] **Step 3:** Implement. Use the manager's transport (Task 2 failover applies). Record each call as a `deskManagerDecision` row with `action:'CONFIRM'` and `runId:'supreme-confirm'` for the audit. → PASS.
- [ ] **Step 4: Failing tests:**
  - under `live`, `DeskExitActions.exit` on a live tracker raises `rule:'SUPREME_EXIT', urgency:'normal', reason:'supreme asks <EXIT|BOOK>: <reason>'` and returns `{status:'PENDING', detail:'asked the trade agent'}` **without** calling `manual.request`;
  - `off` → as today;
  - `target-watch` under `live`, when a target was crossed and the manager was silent for 60 s → raises `rule:'TARGET_LOCK'` with `payload.level` instead of `lock()`.
- [ ] **Step 5:** Implement. → PASS.
- [ ] **Step 6: Failing tests (briefs):**
  - a DONE live OPEN writes a brief composed deterministically from the decision: underlying, side, entry type and levels, stop, targets, reason, evidence, proposalRef/lead;
  - the manager schema accepts `{action:'BRIEF', trackerId, text}` (text 20–1500 chars), and validation refuses an unknown or closed tracker;
  - the BRIEF action writes via `TRADE_BRIEFS` with `by:'MANAGER'`;
  - the prompt lists positions with `hasBrief:false` and asks for a BRIEF for each.
- [ ] **Step 7:** Implement. → PASS.
- [ ] **Step 8:** Run the desk-manager specs and tsc. Commit with pathspecs: `feat(desk-manager): supreme confirm, trade briefs, supreme exits ask the agent (Task 5)`.

---

### Task 6: Owner escalation — Telegram buttons, escalation runner, backstop, boot check

**Files (owns):** `exit-authority/services/{authority-state,escalation-runner}.service.ts`, `exit-authority/telegram/*` and their specs.

**Interfaces — Consumes:**
- Task 1 ports and repo;
- `AI_HEALTH` (Task 2, optional; absent ⇒ `aiDown=false`);
- `ManualExitService.request(caller, trackerId, {now, reason})` (existing, `sentinel-executor/services/manual-exit.service.ts:118`), via a local port `OWNER_EXIT` `{ exitAsOwner(userId, trackerId, reason): Promise<string> }` that Task 7 binds;
- `SUPREME_CONFIRM` (Task 1 port);
- a `HardLossProbe` `{ stillPastLimit(trackerId): Promise<boolean> }`. Task 7 binds it to the sentinel's hard-loss reading; here it is an injected port, `HARD_LOSS_PROBE`, declared in your own file.

**Produces:** `AuthorityStateService implements AuthorityStatePort` (bound to `AUTHORITY_STATE`); `EscalationRunner`; `OwnerButtonsService implements OwnerEscalationPort` (bound to `OWNER_ESCALATION`).

- [ ] **Step 1: Failing `TelegramBotClient` tests (fetch mocked):**
  - `sendMessage(text, buttons)` posts to `https://api.telegram.org/bot<token>/sendMessage` with `reply_markup.inline_keyboard`, returns `message_id`, and never includes the token in a thrown error or log;
  - `editMessage` and `answerCallback` work;
  - `getUpdates(offset, 25)` returns callback queries.
- [ ] **Step 2:** Implement. → PASS.
- [ ] **Step 3: Failing `AuthorityStateService` tests:**
  - `live` + both env vars + a successful test send → `isLive()` true;
  - a missing token → false, and the ERROR text matches `TRADE_AGENT_AUTHORITY=live refused: TELEGRAM_ALERT_BOT_TOKEN missing`;
  - a send failure → false;
  - `off` → false, and no send is attempted.
- [ ] **Step 4:** Implement: the boot check runs in `onModuleInit`, and `isLive()` is false until it completes. → PASS.
- [ ] **Step 5: Failing `EscalationRunner.pass(now)` tests (fake repo, clock, telegram, manual exit):**
  - **Resolve:** an OPEN alarm with an LLM verdict for its tracker after `raisedAt` (read via a repo method `latestAgentVerdict(trackerId, since)`, which excludes rule stamps) → `answer()` is called.
  - **Escalate:**
    - `escalationDue==='ALERT'` → one Telegram message with the trade, the alarm reason, the agent's last view and P&L from the payload, and buttons `Exit` (`x:<alarmId>`) / `Hold` (`h:<alarmId>`); the message id and `alertedAt` are stored;
    - `'REALERT'` → the message is edited (not a new one) and `alertCount++`.
  - **Backstop:**
    - `backstopDue==='DEADLINE'` → `manual.request(owner, trackerId, {reason:'BACKSTOP DEADLINE: …'})`, status `BACKSTOPPED`, and Telegram is told;
    - `'HARD_LOSS'` → the same with `'BACKSTOP HARD_LOSS: …'`;
    - not due → no exit.
  - All state is read from the repo, so a fresh runner instance with the same repo behaves identically (restart).
  - **SUPREME_EXIT (design §4.4):**
    - an OPEN `SUPREME_EXIT` alarm unanswered ≥ `SUPREME_EXIT_AGENT_LOOK_MS` → `manual.request(owner, trackerId, {reason:'SUPREME_EXIT (agent silent): …'})`, status CLOSED;
    - answered by an agent verdict that is not an exit (HOLD/EXIT_ARMED) → one `SUPREME_CONFIRM.confirm({..., agentDisagrees:true})` → `CONFIRM`/`TIMEOUT`/`ERROR` → `manual.request(... 'SUPREME_EXIT (final): …')`; `OVERRIDE_HOLD` → no exit;
    - either way, the call is made exactly once per alarm, which is marked in `payload.roundTrip=true`.
- [ ] **Step 6:** Implement. The `@Interval(15_000)` pass runs only when `bootJobsEnabled()` and `isLive()`. → PASS.
- [ ] **Step 7: Failing `OwnerButtonsService` tests:**
  - a callback from a different `chat.id` → ignored and answered "not allowed";
  - `x:<id>` on an OPEN alarm → `manual.request(owner, trackerId, {reason:'OWNER via Telegram'})`, status CLOSED, and the message is edited to "Exit sent";
  - `h:<id>` → SNOOZED with `snoozedUntil = now + OWNER_HOLD_SNOOZE_MS`;
  - a callback for a non-OPEN or unknown alarm → answered "already handled", no action;
  - `blockedExit(...)` sends a message with Exit / Hold buttons, keyed by tracker, at most once per execution row.
- [ ] **Step 8:** Implement long-polling `getUpdates` in a loop with offset; it runs only in the boot-jobs container while `isLive()`. → PASS.
- [ ] **Step 9:** Run the exit-authority specs and tsc. Commit with pathspecs: `feat(exit-authority): Telegram escalation, owner buttons, backstop, boot check (Task 6)`.

---

### Task 7: Wiring, legacy silos, full verification (lead, after 2–6 merge)

**Files:** the module files that import `ExitAuthorityModule`: `trade-sentinel.module.ts`, `sentinel-executor.module.ts`, `desk-manager.module.ts`, `intraday-carry` module, `app.module.ts`. Also the legacy `trade-engine/services/{trade-execution,order-tracker}.service.ts` and `watch-monitor/services/watch.service.ts`. The runbook goes in `docs/superpowers/specs/2026-11-27-trade-agent-exit-authority-design.md` §9.

- [ ] **Step 1:**
  - bind `TRACKER_WAKE` → the `SentinelRunnerService` instance (`useExisting`);
  - bind `SUPREME_CONFIRM` → `SupremeConfirmService`;
  - bind `HARD_LOSS_PROBE` → a small adapter over the sentinel's hard-loss reading (`hardLossConfig` + `computeGreenFloor` on a quick price, as `rescueHardLoss` does);
  - bind `AI_HEALTH`;
  - bind `OWNER_EXIT` → an adapter over `ManualExitService.request({userId, role:'ADMIN', email:'exit-authority@grw'}, trackerId, {now, reason})`.

  Avoid circular imports: `ExitAuthorityModule` exports tokens. Consumers import it, and the providers that live in other modules are bound in those modules with `{ provide: TOKEN, useExisting: ... }` and exported. Check with `nest build`, then start the API locally with `TRADE_AGENT_AUTHORITY=off` and confirm it boots, with no DI errors in the log.
- [ ] **Step 2:** Write a failing test, then make legacy live sells impossible under `live`: `closeTrade` on a non-paper trade from watch-monitor / signal-review → refused with log `[exit-authority] legacy live close refused`. The order-tracker auto STOPLOSS at entry is not placed for live under `live`. The kill switch and the owner's controller close stay allowed (owner actions).
- [ ] **Step 3:** Write an end-to-end spec (in-memory fakes across modules), `exit-authority.e2e.spec.ts`:
  - floor rule trips → an alarm → a forced look → the LLM fake says EXIT_NOW → the poller → supreme fake CONFIRM → the executor fake receives an `execute` with trigger `'AI'`;
  - the same with supreme OVERRIDE_HOLD → no execute, alarm answered;
  - the LLM fake throws on all routes for 10 min while past the hard loss and the owner is silent → a backstop `manual.request`.
- [ ] **Step 4:** Run the full API jest suite once (`npx jest` in `apps/api`, after checking disk). The only failures allowed are ones that also fail on `main` (`git stash`-free check: run the same failing spec on a clean `main` worktree). Run tsc ≤ 181 and `nest build` OK.
- [ ] **Step 5:** Write the runbook into the spec §9:
  - env to set: `TRADE_AGENT_AUTHORITY=live`, `TELEGRAM_ALERT_BOT_TOKEN`, `TELEGRAM_ALERT_CHAT_ID`, optional `ANTHROPIC_API_KEY`;
  - how to verify on prod: boot log `authority live`, Telegram test message received, `trade_alarms` rows appear;
  - rollback: `TRADE_AGENT_AUTHORITY=off` + recreate the containers.
- [ ] **Step 6:** Commit with pathspecs. The lead reports to the owner. **No push** until the owner says so and no open-position decision is pending.
