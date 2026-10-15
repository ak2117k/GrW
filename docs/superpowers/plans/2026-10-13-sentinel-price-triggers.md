# Sentinel Price Triggers & Tick-Driven Sensors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The sentinel's LLM states, in every HOLD / EXIT_ARMED verdict, a machine-readable price level at which the trade is wrong; a tick-level watcher in `sentinel-executor` closes the position through the existing guarded executor within ~2 s of that level being crossed (confirmed), with no LLM in the loop. Separately, the price-only tripwires (level break, giveback) run on hub ticks so the LLM is woken within ~1 s instead of ≤ 30 s.

**Architecture:** `trade-sentinel` only *proposes*: the verdict schema gains a nullable `exitTrigger`, the prompt (v6 / v2.3) asks for it, and the cycle persists the proposal — plus the resolved watch instrument it already knows — on a new nullable `sentinel_verdicts.exitTrigger` JSONB column. `sentinel-executor` *disposes*: a `TriggerWatchService` (setInterval, off by default) reads new proposals with one indexed anti-join, validates them server-side against the hub's live price (side, distance, tighten-only, freshness), records every outcome in a new `sentinel_exit_triggers` table, holds ARMED triggers in an in-memory `TriggerBook` keyed by `EXCHANGE:token`, and listens to the market hub's `onPrice` stream. A confirmed cross (2 ticks + ≥ 1 s) claims the row `ARMED → FIRED` atomically and hands a synthetic verdict (`trg_<triggerId>`) to the existing `SentinelExitExecutor.execute(…, 'PRICE_TRIGGER')`. Part B adds a pure `TickSensorBook` fed by the cycle and a `TickTripwireService` that, on a rising-edge level-break/giveback fire seen on a hub tick, runs the existing sensor pass for that user immediately. The two modules still never import each other.

**Tech Stack:** NestJS 11 + TypeScript, Prisma 6 (PostgreSQL), Jest (api), React + Vite + Vitest (web). Market hub (`apps/api/src/modules/market-hub`) for ticks.

**Spec:** `docs/superpowers/specs/2026-10-13-sentinel-price-triggers-design.md` (owner-approved; ALL defaults D1–D5 accepted: both instruments; 2 ticks + ≥ 1 s; HOLD may carry a trigger; tighten-only; no profit-take triggers). Read it before any task. The auto-exit plan `docs/superpowers/plans/2026-10-12-sentinel-auto-exit.md` is the background for every executor guard named here.

---

## Preconditions (sequence after these — state of `main` before Stream B Task 10 starts)

| # | Work | Branch / flag | Why this plan waits | Overlap with this plan |
|---|---|---|---|---|
| P1 | Manual Exit button: executor trigger `MANUAL`, `ExitTrigger` type + `triggerOf()` in `sentinel-executor/domain/manual-exit.ts`, `SentinelExitExecutor.execute(id, v, aiCfg, now, trigger)`, ordertag prefix `am` + `EXIT_TAG_PREFIXES`, `POST /api/sentinel-executor/exit/:trackerId`, Portfolio Exit button, `trigger` on `AiExitExecutionDto` | `feature/manual-exit-button` (uncommitted work in `.claude/worktrees/manual-exit` on 2026-10-13) | Task 10 extends exactly those seams (`ExitTrigger`, `aiExitOrderTag(…, trigger)`, `execute`). Designing them twice would conflict. | `manual-exit.ts` (one union member + one prefix), `exit-order.ts` (prefix map), executor spec, controller (new GET only), DTO (one field), `useAiExits.ts` (one union member). |
| P2 | Cancel protective SL then exit, behind `AI_AUTO_EXIT_CANCEL_PROTECTIVE` (default false) | queued | It changes `preOrderCheck`'s `OPEN_ORDER_EXISTS` path. A trigger fire must take the SAME branch as an AI verdict there. | `sentinel-exit-executor.service.ts` — this plan adds no line to `preOrderCheck`; Task 10 adds one compatibility test. |
| P3 | Live broker sync (order-update stream + 60 s adaptive reconcile in trade-tracker) | `feature/live-broker-sync` | Merges touch `market-data/user-feed-*` and `market-hub.service.spec.ts`. This plan touches neither, but merging P3 first keeps the gate's "tracker closes promptly → trigger EXPIRED: TRACKER_CLOSED" observation meaningful. | none |

Streams A, C (trade-sentinel only) and the pure/DB tasks of Stream B (7, 8, 9, 11, 12) do **not** depend on P1–P3 and may start immediately on top of `main` 90eec9d + the spec commit b573d2e. Tasks 10, 13, 14, 15 and Stream D start only after P1 and P2 are merged to `main` and this branch is rebased (`git rebase main` in the stream's worktree; no merge commits, no force-push of shared branches).

## Global Constraints

- Owner decisions (spec §7, all defaults accepted): **D1** UNDERLYING and PREMIUM both allowed · **D2** confirmation = `SENTINEL_TRIGGER_CONFIRM_TICKS` (2) consecutive ticks **and** ≥ `SENTINEL_TRIGGER_CONFIRM_MS` (1000) · **D3** HOLD verdicts may carry a trigger · **D4** tighten-only (`SENTINEL_TRIGGER_TIGHTEN_ONLY=true`) · **D5** no profit-take triggers in v1.
- Real orders: every exit goes through `SentinelExitExecutor` (claim row → fresh positions + order book → all guards → MARKET (+ one LIMIT fallback) → settle by ordertag → confirm). `placeOrderClassified` keeps exactly ONE call site (`sentinel-executor/services/sentinel-exit-executor.service.ts`, the structure spec pins it).
- Execution needs `AI_AUTO_EXIT_ENABLED=true` and an allow-listed user; mode (dry-run/live) is `AI_AUTO_EXIT_MODE`; trigger fires count toward `AI_AUTO_EXIT_DAILY_CAP` in the same mode.
- Env (in `api.env`, safe defaults, spec §5): `SENTINEL_TRIGGERS_ENABLED=false`, `SENTINEL_TRIGGER_CONFIRM_TICKS=2`, `SENTINEL_TRIGGER_CONFIRM_MS=1000`, `SENTINEL_TRIGGER_MAX_AGE_MIN=240`, `SENTINEL_TRIGGER_MAX_DISTANCE_PCT=UNDERLYING:10,PREMIUM:60`, `SENTINEL_TRIGGER_TIGHTEN_ONLY=true`, `SENTINEL_TICK_TRIPWIRES=true`. A typo never widens behaviour: it falls back to the default and is reported once.
- **Disabled = inert.** With `SENTINEL_TRIGGERS_ENABLED` ≠ `true` (or auto-exit off / no users / `BOOT_JOBS=false`): no timer, no hub listener, no `hub.watch`, no query, no broker call from the trigger code. (The sentinel still writes the `exitTrigger` column on its own verdict INSERT — data only, no extra read.)
- Tick path = `TriggerBook.onTick` and `TickTripwireService.onTick`: synchronous, O(1) `Map` lookups, no `await`, no Prisma, never throws. The ONLY database statement a tick can cause is the single conditional `UPDATE … WHERE status='ARMED'` fire claim (followed by the executor's own pipeline).
- Migration: expand-only, timestamp `20261013150000` (after `20261013120000_sp2_m5_journal`), auto-applied on deploy: one new table + one nullable column on `sentinel_verdicts`. No FK, no change to any existing column/index.
- No new `@Cron`. Background work is `setInterval` gated by `bootJobsEnabled()` (`apps/api/src/common/utils/boot-jobs.ts`), `.unref()`'d, cleared in `onModuleDestroy`.
- Isolation: no file under `sentinel-executor/` imports a specifier containing `trade-sentinel`; no file under `trade-sentinel/` imports `sentinel-executor`; the cycle reachability walk in `trade-sentinel/services/sentinel-cycle.service.spec.ts` (FORBIDDEN `/execution|order|broker|angel|smart-?api|trade-engine|auto-trade/i`) stays green with the new entry point added to `ENTRIES`. `SentinelController` stays exit-free.
- 1 vCPU / 2 GB VPS. When enabled with nothing to do, one 5 s pass = one indexed SELECT; maintenance (every 30 s) = at most one indexed SELECT on `trade_trackers` by primary key.
- Prompt: `SENTINEL_PROMPT_VERSION` `v5 → v6`, `SENTINEL_PROMPT_VERSION_NO_CUES` `v2.2 → v2.3`; golden snapshot regenerated in the same commit with every changed line attributed (Task 4 Step 6).
- Logs: trigger lines prefixed `[ai-trigger]`; executor lines keep `[ai-exit]`; Part B lines `[sentinel-tick]`. Credentials never logged.
- Angel `ordertag` ≤ 20 chars, alphanumeric: `at` + leg (`M`/`L`) + last 17 alphanumerics of `trg_<cuid>` = 20.
- Commits: Conventional Commits, `git add <explicit paths>`; never `git add -A`, `git commit -a`, `git stash`. Every message ends with a blank line and `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. No merge, no push from a stream.
- Worktrees: `node_modules` are junctions with ABSOLUTE targets to the main tree (`cmd /c mklink /J "<wt>\apps\api\node_modules" "C:\Users\AryanKumar\Desktop\GrW\apps\api\node_modules"`, same for `node_modules`, `apps\web\node_modules`, `packages\shared\node_modules`). Never `npm install`, never delete a junction (`rmdir` the junctions before `git worktree remove`). `npx prisma generate` writes through the junction (additive) — acceptable; never `prisma migrate dev/reset` against a shared DB.
- Tests: API `cd apps/api && npx jest <path>`; web `cd apps/web && npx vitest run <path>`; typecheck `cd apps/api && npx tsc --noEmit -p tsconfig.json` and `cd apps/web && npx tsc --noEmit -p tsconfig.json`.

## Planner Rulings

- **R1 — Who arms.** `trade-sentinel` never validates or arms. It parses the LLM's `exitTrigger` *shape* (Task 2/3), and persists `{v:1, instrument, op, price, watch, seen}` (or `{v:1, problem}`) on `sentinel_verdicts.exitTrigger` (Task 6). Every semantic check (side, distance, tighten-only, freshness, hub, tracker state) runs in `sentinel-executor` at arming time against the hub's live price — the price the watcher will fire on. *Why:* the CLI judge returns minutes after the packet was built; validating against the packet's price would validate against a stale world; and keeping arming in the executor keeps the "sentinel cannot reach order placement" property untouched.
- **R2 — Watch target resolution.** The underlying's resolution (index map / NSE cash row / MCX nearest future of the option's own month) lives in `trade-sentinel/adapters/tick-source.adapter.ts`, which the executor may not import. Task 5 adds `underlyingRef` (and `contractRef`) to `TickSnapshot`; Task 6 copies `underlyingRef` into the persisted proposal as `watch`. PREMIUM watches the tracker's own `exchange/token`, read by the executor from `trade_trackers`. `underlyingRef`/`contractRef` are never rendered into the packet (pinned by a test).
- **R3 — Hub access from the executor.** Through `lookupHubPrices(moduleRef)?.hubFor(userId, 'positions')` (`market-hub/hub-prices.ts`, type-only imports, no module import cycle). No new consumer flag: triggers price positions, so they ride `HUB_PRICES_POSITIONS`. No hub for the user ⇒ `REJECTED: NO_HUB`. UNDERLYING watches are registered at priority **1** under owner `sentinel-triggers` and ref-counted; PREMIUM needs no watch (the hub already holds every owner position at P0).
- **R4 — Protective only, by exposure, not by "long".** `adverseOp(instrument, qty, kind)`: PREMIUM → long `BELOW`, short `ABOVE`; UNDERLYING → the direction that hurts the position's delta: long CE/FUT or short PE `BELOW`; long PE or short CE/FUT `ABOVE`. Any other `op` is `NOT_PROTECTIVE` (D5). Kind comes from the tradingsymbol suffix (`/\d(CE|PE|FUT)$/`); unknown kind ⇒ UNDERLYING `UNKNOWN_CONTRACT_KIND`.
- **R5 — Tighten-only semantics.** Same instrument only (`INSTRUMENT_SWITCH` otherwise, while an ARMED one exists); `BELOW` level may only rise, `ABOVE` only fall; an equal level is a renewal (new row, old one SUPERSEDED, `armedAt` reset). `exitTrigger: null`, a missing key, a malformed trigger, an EXIT_NOW/ESCALATE verdict and a REJECTED proposal never disarm an ARMED trigger. With `SENTINEL_TRIGGER_TIGHTEN_ONLY=false` a valid newer trigger supersedes regardless of direction/instrument; null still never disarms.
- **R6 — Confirmation and bad ticks.** Pure state machine (Task 9): a tick is *beyond* when `price < level` (BELOW) / `price > level` (ABOVE), strictly. Fire when `count ≥ confirmTicks` AND `tick.at − firstBeyondAt ≥ confirmMs`. Reset to empty on a not-beyond tick, on a gap > 5 s between consecutive accepted ticks, or on an out-of-order tick. Ticks that are not *accepted* leave the state untouched: `source === 'db'`, non-finite/≤ 0 price, receipt time > 5 s from now, exchange closed (`SessionClock.isOpen`).
- **R7 — One fire per trigger, three layers.** (1) `TriggerBook.onTick` removes a firing trigger from both maps before returning — no second tick in this process can see it; (2) `UPDATE sentinel_exit_triggers SET status='FIRED' … WHERE id=$1 AND status='ARMED'` must report 1 row or nothing is executed; (3) the execution row's `verdictId = 'trg_<triggerId>'` is UNIQUE in `ai_exit_executions`, so even a second claim attempt is `DUPLICATE`.
- **R8 — Claim DB error.** If the fire claim throws, the trigger is re-added to the book with an empty confirmation state and nothing is executed; a later confirmed cross retries the claim. Never execute without a won claim.
- **R9 — Slot exhaustion.** The hub allocator never refuses a P1 watch: an over-cap P0/P1 ref becomes `criticalOverflow` and is polled every 2 s on the Critical lane (`quote-poller.ts CRITICAL_EVERY_MS = 2000`), which still satisfies 2 ticks + 1 s with gaps < 5 s. So: no conversion to PREMIUM (impossible without a delta). A trigger is refused only when its instrument has no fresh (≤ 15 s) price 30 s after the watch was registered (`REJECTED: NO_FRESH_PRICE`, watch released). While ARMED, a watched key with no price for 60 s during its session logs one `[ai-trigger] STARVED` warning per trigger.
- **R10 — Expiry.** Maintenance every 30 s (and at boot rebuild): `MAX_AGE` (armedAt older than `SENTINEL_TRIGGER_MAX_AGE_MIN`), `EXCHANGE_CLOSED` (the tracker's exchange is not open now — exchange close, weekend, holiday), `TRACKER_CLOSED` (tracker status ≠ OPEN). Expiry removes from memory first (safe direction), then one `updateMany`.
- **R11 — Inert when disabled.** The watcher starts only when `SENTINEL_TRIGGERS_ENABLED=true` AND `AI_AUTO_EXIT_ENABLED=true` AND `AI_AUTO_EXIT_USER_IDS` non-empty AND `bootJobsEnabled()`. It reads both configs once at init (like the poller).
- **R12 — Malformed triggers never cost a verdict.** The CLI judge cannot enforce the JSON schema (`schemaInstruction` only describes it), so `exitTrigger` is shape-checked in code. A bad shape keeps the verdict, sets `exitTrigger: null` + `exitTriggerProblem`, logs one warning, and is persisted as `{v:1, problem}` so the executor records `REJECTED: MALFORMED: …`. A reply with NO `exitTrigger` key (every pre-v6 reply, every golden fixture) is left exactly as it was — the golden `result` records do not change.
- **R13 — Synthetic verdict for the executor.** Following P1's convention (no `ai_exit_executions` schema change): `verdictId = 'trg_' + triggerId`, `trigger = 'PRICE_TRIGGER'`, ordertag prefix `at`, `verdictReason` = `PRICE_TRIGGER: <watchSymbol> < 8930 — fired at 8927.5 (2 ticks over 1200 ms); armed 22:33 IST by verdict <id>`. `PRICE_TRIGGER` takes the AI branch everywhere P1 branches (`enabled`, allow-list, verdict age measured from the fire, daily cap, `AI_AUTO_EXIT_MODE`); `hasPriorAiExit` treats `ax`/`am`/`at` alike.
- **R14 — Part B wake.** A rising-edge fire of `levelBreak` or `givebackOffPeak` on a hub tick (evaluated at most once per second per tracker) calls `SentinelRunnerService.wakeForTick(userId, …)`, which runs the ordinary sensor pass (`runForUser`) for that user — every existing cap applies (runner in-flight guard, one judgement per position, `JUDGE_CONCURRENCY`, backoff). Per-user wake cooldown 15 s. Gated `SENTINEL_SHADOW_ENABLED=true` AND `SENTINEL_TICK_TRIPWIRES` ≠ `false` AND `bootJobsEnabled()`. The hub is reached through a new port `TICK_STREAM` bound in the module (composition root) so the reachability walk never reaches market-hub.
- **R15 — Arming cadence.** Arming lookback 180 s, deferral 30 s, ≤ 10 proposals per 5 s pass. A proposal older than 180 s when first seen (e.g. after downtime) is ignored without a row — the next verdict re-proposes.
- **R16 — UI source of truth.** Armed levels come from the executor's table via `GET /api/sentinel-executor/triggers` (same authz as `/executions`), not from the sentinel's verdict — the panel shows what will actually fire.
- **R17 — Wire contract duplication.** The persisted proposal shape is declared twice (sentinel writer `exit-trigger-proposal.ts`, executor reader `domain/stored-trigger.ts`) because the modules may not import each other. Both specs use the byte-identical fixture `STORED_TRIGGER_FIXTURE` (Task 6 and Task 11).
- **R18 — Dry-run consumes the trigger.** A dry-run fire marks the trigger FIRED and records `DRY_RUN`; it is not re-armed automatically. The next verdict may propose again.

## Where the Code Differs from the Spec

1. **Spec §3.2 "long + BELOW"** is the premium rule only. On UNDERLYING a long PUT (or short call) is hurt by a RISE; R4 derives the protective direction from the option type. A literal reading would arm profit-takes on puts and reject real stops.
2. **Spec §3.4 "one extra feed slot per position with an UNDERLYING trigger".** `MarketHubService.refreshPositions` already watches every owner derivative's underlying at P1 — but `underlyingOf` passes no `future` lookup to `resolveUnderlying`, so **MCX** underlyings resolve to no ref and are NOT watched. Net: +0 slots for NSE/BSE underlyings, +1 slot per distinct MCX future under an UNDERLYING trigger.
3. **Spec §3.4 slot-exhaustion fallback** ("falls back to PREMIUM-only or is not armed"): see R9 — no PREMIUM conversion; the hub degrades to 2-s critical-lane quotes, which still fire; not armed only on `NO_FRESH_PRICE`.
4. **"Ignore ticks older than 5 s".** Hub `Price.at` is the hub's RECEIPT time; there is no exchange timestamp. Freshness is measured on receipt and `source: 'db'` prices are ignored (R6).
5. **Spec §3.3 columns.** `firedTick (price, at)` → `firedPrice`, `firedTickAt`; added `symbol`, `watchSymbol`, `refPrice` (price at arming), `endedAt`, `createdAt`, `updatedAt`. `instrument/op/price/watch*` are nullable so a MALFORMED proposal can still be recorded (a CHECK forces them non-null when ARMED).
6. **Spec §3.5 "the row links triggerId + verdictId".** `ai_exit_executions` has no `triggerId` column and P1 chose synthetic ids over a schema change; the execution row carries `verdictId = trg_<triggerId>` and the trigger row carries the arming `verdictId` (R13).
7. **Spec §8 "the watcher … reading triggers from the DB/table".** Arming also lives in the executor (R1); `trade-sentinel` writes only the proposal, on a new nullable `sentinel_verdicts.exitTrigger` column.
8. **Prompt.** Two live prompts exist (cues on/off) — both bump. The current ownership line says "EXIT_ARMED, HOLD and ESCALATE never are" executed; with triggers that is false and must change in v6 / v2.3.
9. **CLI transport.** `ClaudeCliTransport` embeds the schema in the prompt (`schemaInstruction(schema)`), so the `VERDICT_SCHEMA` change also changes every CLI golden scenario's prompt text.
10. **Hub prerequisite.** Triggers need `MARKET_HUB_ENABLED=true`, `HUB_OWNER_USER_ID` = the allow-listed owner and `HUB_PRICES_POSITIONS=true`; the spec is silent. Otherwise `NO_HUB`.
11. **Broker stop-loss interplay.** With a resting broker SL on the contract, every fire ends `SKIPPED: OPEN_ORDER_EXISTS` unless P2's `AI_AUTO_EXIT_CANCEL_PROTECTIVE=true` (spec §3.5 mentions it; the production gate makes it an explicit owner decision).
12. **Part B on MCX options.** Tick-driven level-break needs underlying ticks; the hub does not watch MCX underlyings (item 2), so for an MCX option it works only while an UNDERLYING trigger holds the future's watch. The 30-s cron is unchanged and still covers it.

## Review Focus

Each line names the condition and the expected behaviour; the pinning test lives in the named task.

1. **One fire per trigger under concurrent ticks** — further ticks arriving while the first fire's claim is in flight produce exactly one claim call and one executor call; a second process losing the `ARMED→FIRED` update executes nothing; a claim that throws re-arms and sends nothing. *Task 12 Step 1 (`fires ONCE`), Task 11 Step 1 (`claimFire`), Task 13 Step 1 (`fires ONCE under concurrent ticks`, `a lost claim`, `a claim that THROWS`).*
2. **Bad-tick resistance** — one print beyond the level never fires; a zero/negative/NaN price, a `db`-sourced price, a receipt time > 5 s old, or a 6-s gap never contributes to confirmation; flapping resets. *Task 9 Step 1, Task 12 Step 1.*
3. **Tighten-only** — a later proposal further from price, or on the other instrument, is REJECTED and the ARMED one stays; equal is renewal; null never disarms. *Task 8 Step 1, Task 11 Step 1 (arming query never returns a null proposal), Task 13 Step 1 (`tighten-only: a looser later proposal is REJECTED and the armed level still fires`).*
4. **Stale / closed exchange no-fire** — ticks while `isOpen` is false change nothing; maintenance expires ARMED triggers when the tracker's exchange closes or the tracker closes; boot rebuild expires those already past close/max-age. *Task 12 Step 1, Task 13 Step 1 (`ticks while the exchange is closed`, `maintenance`, `boot expires`).*
5. **Slot exhaustion fallback** — an UNDERLYING proposal whose instrument has no fresh price is deferred, then REJECTED `NO_FRESH_PRICE` after 30 s with its watch released; a critical-lane `quote` price is accepted for confirmation. *Task 13 Step 1 (`slot exhaustion: … deferred, then REJECTED`), Task 12 Step 1 (`a critical-lane quote counts`).*
6. **Disabled = inert** — any of the four switches off ⇒ no `setInterval`, no `moduleRef.get`, no repository call, no `onPrice` subscription. *Task 14 Step 1.*
7. **Sentinel isolation** — no cross-imports; the cycle walk includes `tick-tripwire.service.ts`; `trade-sentinel` never references `sentinelExitTrigger`; `placeOrderClassified` still has one call site. *Task 15 Step 1, Task 17 Step 1.*

## File Structure

```
prisma/
  schema.prisma                                              (M) SentinelExitTrigger model; SentinelVerdict.exitTrigger Json?
  migrations/20261013150000_sentinel_exit_triggers/migration.sql   (C)

apps/api/src/modules/trade-sentinel/
  services/exit-trigger-proposal.ts          (C) shape parse of the LLM field + persisted record builder (pure)
  services/exit-trigger-proposal.spec.ts     (C)
  services/sentinel-agent.service.ts         (M) VERDICT_SCHEMA.exitTrigger, Verdict fields, validate()
  services/sentinel-agent.service.spec.ts    (M)
  prompts/sentinel-system-prompt.ts          (M) v6 / v2.3, EXIT_TRIGGER_RULES, ownership line
  golden/__snapshots__/sentinel-golden.spec.ts.snap  (M) regenerated, attributed
  services/context-packet.service.ts         (M) TickSnapshot.underlyingRef/contractRef (type + doc only)
  services/context-packet.service.spec.ts    (M) packet never renders them
  adapters/tick-source.adapter.ts            (M) sets underlyingRef/contractRef
  adapters/tick-source.adapter.spec.ts       (M)
  repositories/sentinel-verdict.repository.ts      (M) optional exitTrigger on record()
  repositories/sentinel-verdict.repository.spec.ts (M)
  services/sentinel-cycle.service.ts         (M) persist proposal; publish TickSensorBook context
  services/sentinel-cycle.service.spec.ts    (M) + reachability ENTRY
  services/tick-sensor-book.ts               (C) Part B per-tracker context (pure)
  services/tick-sensor-book.spec.ts          (C)
  services/tick-tripwire.service.ts          (C) Part B tick handler
  services/tick-tripwire.service.spec.ts     (C)
  ports/tick-stream.port.ts                  (C) TICK_STREAM port
  adapters/hub-tick-stream.adapter.ts        (C) port → hub onPrice
  adapters/hub-tick-stream.adapter.spec.ts   (C)
  services/sentinel-runner.service.ts        (M) wakeForTick()
  services/sentinel-runner.service.spec.ts   (M)
  trade-sentinel.module.ts                   (M) providers

apps/api/src/modules/sentinel-executor/
  domain/trigger-config.ts (+spec)           (C) SENTINEL_TRIGGER_* parse
  domain/trigger-rules.ts (+spec)            (C) contractKindOf, adverseOp, validateTrigger
  domain/confirmation.ts (+spec)             (C) stepConfirm
  domain/trigger-book.ts (+spec)             (C) in-memory ARMED set + THE tick path
  domain/stored-trigger.ts (+spec)           (C) reader of sentinel_verdicts.exitTrigger
  domain/manual-exit.ts                      (M, after P1) ExitTrigger += 'PRICE_TRIGGER', trg_ prefix
  domain/exit-order.ts                       (M, after P1) 'at' prefix
  domain/guards.spec.ts, domain/exit-order.spec.ts   (M)
  repositories/sentinel-exit-trigger.repository.ts (+spec)  (C)
  services/trigger-watch.service.ts (+spec)  (C) arm / watch / fire / expire / boot
  services/sentinel-exit-executor.service.spec.ts  (M) PRICE_TRIGGER cases
  dto/sentinel-exit-trigger.dto.ts           (C)
  dto/ai-exit-execution.dto.ts               (M) triggerId
  controllers/sentinel-executor.controller.ts (+spec)  (M) GET triggers
  sentinel-executor.module.ts (+spec)        (M)
  sentinel-executor.structure.spec.ts        (M)

deploy/env/api.env.example                   (M)

apps/web/src/
  hooks/useSentinelTriggers.ts (+spec)       (C)
  components/charts/triggerView.ts (+test)   (C)
  components/charts/SentinelPanel.tsx        (M) armed level line
  components/charts/aiExitView.ts (+test)    (M) PRICE_TRIGGER badge
  components/charts/AiExitsList.tsx          (M)
  hooks/useAiExits.ts                        (M) trigger union / triggerId
  pages/charts/ChartsPage.tsx                (M) pass triggers to panel
```

## Parallel Streams

| Stream | Worktree / branch | Tasks | Starts | Touches |
|---|---|---|---|---|
| S | `.claude/worktrees/trg-schema` · `feature/trg-schema` | 1 | now | `prisma/` only |
| A | `.claude/worktrees/trg-sentinel` · `feature/trg-sentinel` | 2, 3, 4, 5 now; 6 after S (rebase A onto `feature/trg-schema` once Task 1 is committed) | now | `trade-sentinel/` |
| B | `.claude/worktrees/trg-executor` · `feature/trg-executor` | 7, 8, 9, 12 now; 11 after S (rebase onto `feature/trg-schema`); 10, 13, 14, 15 after P1 + P2 are on `main` (rebase onto `main`, then onto S's tip) | now | `sentinel-executor/`, `deploy/env/api.env.example` |
| C | `.claude/worktrees/trg-ticks` · `feature/trg-ticks` | 16, 17 | after A's Task 5 (branch C from A at that commit) | `trade-sentinel/` (cycle, runner, module, new files) |
| D | `.claude/worktrees/trg-web` · `feature/trg-web` | 18 | after P1 merged (needs `trigger` on `AiExitRow`); uses the Task 15 DTO contract copied verbatim | `apps/web/` |
| — | integration `feature/sentinel-price-triggers` | 19 | all streams done | — |

A and C both edit `sentinel-cycle.service.ts`, `trade-sentinel.module.ts` and `sentinel-cycle.service.spec.ts`; C is branched from A after Task 5 and rebased onto A's tip before Task 16's commit, so the integration merge is A → C → B → D with no conflicts expected beyond P1's files. The coordinator creates each worktree with the junctions from Global Constraints.

---

## Task 1: `sentinel_exit_triggers` table + `sentinel_verdicts.exitTrigger` (Stream S)

**Files:**
- Modify: `prisma/schema.prisma` (add `exitTrigger Json?` to `model SentinelVerdict` after `greenFloor`; append `model SentinelExitTrigger` after `model AiExitExecution`)
- Create: `prisma/migrations/20261013150000_sentinel_exit_triggers/migration.sql`

**Interfaces:**
- Produces: `prisma.sentinelExitTrigger` delegate and `SentinelExitTrigger` type; `SentinelVerdict.exitTrigger: Prisma.JsonValue | null`.

- [ ] **Step 1: Add the column and the model**

In `model SentinelVerdict`, directly after `greenFloor     Float?`:

```prisma
  /// The judge's machine-readable exit level as the cycle persisted it
  /// ({v:1, instrument, op, price, watch, seen} or {v:1, problem}); NULL when the
  /// verdict carried none. Read only by sentinel-executor's TriggerWatchService.
  exitTrigger    Json?
```

After the closing brace of `model AiExitExecution`:

```prisma
/// One row per exitTrigger proposal the executor looked at
/// (docs/superpowers/specs/2026-10-13-sentinel-price-triggers-design.md §3.3).
/// verdictId is UNIQUE: a proposal is armed or rejected exactly once. At most one
/// ARMED row per tracker — a partial unique index in the migration SQL (Prisma
/// cannot express it). No FK, like sentinel_verdicts and ai_exit_executions.
model SentinelExitTrigger {
  id            String    @id @default(cuid())
  userId        String
  trackerId     String
  verdictId     String    @unique
  symbol        String
  instrument    String?   // 'UNDERLYING' | 'PREMIUM' (null only for MALFORMED)
  op            String?   // 'BELOW' | 'ABOVE'
  price         Float?
  watchExchange String?
  watchToken    String?
  watchSymbol   String?
  refPrice      Float?    // the watched instrument's price when armed
  status        String    // 'ARMED' | 'FIRED' | 'SUPERSEDED' | 'REJECTED' | 'EXPIRED'
  reason        String?
  armedAt       DateTime?
  endedAt       DateTime? // SUPERSEDED / EXPIRED
  firedAt       DateTime?
  firedPrice    Float?
  firedTickAt   DateTime?
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt

  @@index([userId, createdAt])
  @@index([status])
  @@index([trackerId, createdAt])
  @@map("sentinel_exit_triggers")
}
```

- [ ] **Step 2: Write the migration**

Create `prisma/migrations/20261013150000_sentinel_exit_triggers/migration.sql`:

```sql
-- Sentinel price triggers (docs/superpowers/plans/2026-10-13-sentinel-price-triggers.md).
--
-- Expand-only: one nullable column on sentinel_verdicts (metadata-only ALTER in
-- PostgreSQL: no default, no rewrite) and one new table with its indexes and
-- CHECKs. No existing column, index or function is changed. No FK.

ALTER TABLE "sentinel_verdicts" ADD COLUMN "exitTrigger" JSONB;

CREATE TABLE "sentinel_exit_triggers" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "trackerId" TEXT NOT NULL,
    "verdictId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "instrument" TEXT,
    "op" TEXT,
    "price" DOUBLE PRECISION,
    "watchExchange" TEXT,
    "watchToken" TEXT,
    "watchSymbol" TEXT,
    "refPrice" DOUBLE PRECISION,
    "status" TEXT NOT NULL,
    "reason" TEXT,
    "armedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "firedAt" TIMESTAMP(3),
    "firedPrice" DOUBLE PRECISION,
    "firedTickAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sentinel_exit_triggers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "sentinel_exit_triggers_verdictId_key" ON "sentinel_exit_triggers"("verdictId");
CREATE INDEX "sentinel_exit_triggers_userId_createdAt_idx" ON "sentinel_exit_triggers"("userId", "createdAt");
CREATE INDEX "sentinel_exit_triggers_status_idx" ON "sentinel_exit_triggers"("status");
CREATE INDEX "sentinel_exit_triggers_trackerId_createdAt_idx" ON "sentinel_exit_triggers"("trackerId", "createdAt");

-- At most ONE armed trigger per tracker (spec §3.3). Partial: history rows are unlimited.
CREATE UNIQUE INDEX "sentinel_exit_triggers_one_armed_per_tracker"
    ON "sentinel_exit_triggers"("trackerId") WHERE "status" = 'ARMED';

ALTER TABLE "sentinel_exit_triggers" ADD CONSTRAINT "sentinel_exit_triggers_vocab_check" CHECK (
    "status" IN ('ARMED', 'FIRED', 'SUPERSEDED', 'REJECTED', 'EXPIRED')
    AND ("instrument" IS NULL OR "instrument" IN ('UNDERLYING', 'PREMIUM'))
    AND ("op" IS NULL OR "op" IN ('BELOW', 'ABOVE'))
);

-- A row that can fire, or did, must be complete.
ALTER TABLE "sentinel_exit_triggers" ADD CONSTRAINT "sentinel_exit_triggers_armed_complete_check" CHECK (
    "status" NOT IN ('ARMED', 'FIRED')
    OR ("instrument" IS NOT NULL AND "op" IS NOT NULL AND "price" > 0
        AND "watchExchange" IS NOT NULL AND "watchToken" IS NOT NULL AND "armedAt" IS NOT NULL)
);
```

- [ ] **Step 3: Validate and generate**

Run (repo root): `npx prisma validate --schema prisma/schema.prisma`
Expected: `The schema at prisma/schema.prisma is valid`.

Run: `npx prisma generate --schema prisma/schema.prisma` → `Generated Prisma Client`; then `cd apps/api && npx tsc --noEmit -p tsconfig.json` → exit 0.

- [ ] **Step 4: Expand-only check**

Run: `grep -nE "DROP|RENAME|ALTER COLUMN|SET NOT NULL|SET DEFAULT" prisma/migrations/20261013150000_sentinel_exit_triggers/migration.sql`
Expected: no output. Compare model and SQL by eye: 21 columns (types, nullability) and the four plain indexes; the partial unique index and the CHECKs are migration-only, as in `20261012140000_sentinel_auto_exit`.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20261013150000_sentinel_exit_triggers/migration.sql
git commit -m "feat(sentinel-executor): sentinel_exit_triggers table and sentinel_verdicts.exitTrigger (expand-only)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Exit-trigger proposal shape + persisted record (Stream A, pure)

**Files:**
- Create: `apps/api/src/modules/trade-sentinel/services/exit-trigger-proposal.ts`
- Test: `apps/api/src/modules/trade-sentinel/services/exit-trigger-proposal.spec.ts`

**Interfaces:**
- Produces:
  - `type TriggerInstrument = 'UNDERLYING' | 'PREMIUM'`, `type TriggerOp = 'BELOW' | 'ABOVE'`
  - `interface ExitTriggerProposal { instrument: TriggerInstrument; op: TriggerOp; price: number }`
  - `type ProposalParse = {kind:'absent'} | {kind:'none'} | {kind:'proposal'; proposal: ExitTriggerProposal} | {kind:'malformed'; problem: string}`
  - `parseExitTriggerProposal(raw: Record<string, unknown>): ProposalParse`
  - `interface WatchRef { exchange: string; token: string; symbol: string }`
  - `interface StoredExitTriggerV1 { v: 1; instrument?; op?; price?; watch?: WatchRef | null; seen?: { price: number | null; at: string | null }; problem?: string }`
  - `exitTriggerRecord(verdict: { verdict: string; exitTrigger?: ExitTriggerProposal | null; exitTriggerProblem?: string }, tick: { ltp: number; underlyingLtp: number | null; underlyingLtpAt: string | null; underlyingRef?: WatchRef | null }): StoredExitTriggerV1 | null`
  - `STORED_TRIGGER_FIXTURE: StoredExitTriggerV1` (the R17 contract fixture)

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/modules/trade-sentinel/services/exit-trigger-proposal.spec.ts
import {
  STORED_TRIGGER_FIXTURE,
  exitTriggerRecord,
  parseExitTriggerProposal,
} from './exit-trigger-proposal';

describe('parseExitTriggerProposal', () => {
  it('absent key = a pre-v6 reply, left untouched', () => {
    expect(parseExitTriggerProposal({ verdict: 'HOLD' })).toEqual({ kind: 'absent' });
  });

  it('explicit null = no defensible level', () => {
    expect(parseExitTriggerProposal({ exitTrigger: null })).toEqual({ kind: 'none' });
  });

  it('accepts the exact shape', () => {
    expect(parseExitTriggerProposal({ exitTrigger: { instrument: 'UNDERLYING', op: 'BELOW', price: 8930 } })).toEqual({
      kind: 'proposal',
      proposal: { instrument: 'UNDERLYING', op: 'BELOW', price: 8930 },
    });
  });

  it.each([
    ['a string', 'BELOW 8930', /not an object/],
    ['an array', [8930], /not an object/],
    ['an unknown instrument', { instrument: 'SPOT', op: 'BELOW', price: 1 }, /instrument/],
    ['a lowercase op', { instrument: 'PREMIUM', op: 'below', price: 1 }, /op/],
    ['a string price (the CLI cannot enforce the schema)', { instrument: 'PREMIUM', op: 'BELOW', price: '120' }, /price/],
    ['a zero price', { instrument: 'PREMIUM', op: 'BELOW', price: 0 }, /price/],
    ['a NaN price', { instrument: 'PREMIUM', op: 'BELOW', price: Number.NaN }, /price/],
    ['an extra field', { instrument: 'PREMIUM', op: 'BELOW', price: 1, note: 'x' }, /unexpected field/],
  ])('rejects %s as malformed, never throws', (_label, value, problem) => {
    const r = parseExitTriggerProposal({ exitTrigger: value });
    expect(r.kind).toBe('malformed');
    expect((r as { problem: string }).problem).toMatch(problem);
  });
});

describe('exitTriggerRecord', () => {
  const tick = {
    ltp: 212.5,
    underlyingLtp: 8951,
    underlyingLtpAt: '2026-10-13T16:59:58.000Z',
    underlyingRef: { exchange: 'MCX', token: '472789', symbol: 'CRUDEOIL19NOV26FUT' },
  };

  it('UNDERLYING: carries the resolved watch instrument and what the judge saw', () => {
    const rec = exitTriggerRecord(
      { verdict: 'EXIT_ARMED', exitTrigger: { instrument: 'UNDERLYING', op: 'BELOW', price: 8930 } },
      tick,
    );
    expect(rec).toEqual(STORED_TRIGGER_FIXTURE);
  });

  it('PREMIUM: no watch (the executor uses the tracker contract), seen = the premium', () => {
    expect(
      exitTriggerRecord({ verdict: 'HOLD', exitTrigger: { instrument: 'PREMIUM', op: 'BELOW', price: 180 } }, tick),
    ).toEqual({ v: 1, instrument: 'PREMIUM', op: 'BELOW', price: 180, watch: null, seen: { price: 212.5, at: null } });
  });

  it('UNDERLYING with no resolved underlying keeps watch null (the executor rejects NO_WATCH_TARGET)', () => {
    const rec = exitTriggerRecord(
      { verdict: 'HOLD', exitTrigger: { instrument: 'UNDERLYING', op: 'BELOW', price: 8930 } },
      { ...tick, underlyingRef: null, underlyingLtp: null, underlyingLtpAt: null },
    );
    expect(rec?.watch).toBeNull();
  });

  it('a malformed proposal is persisted as a problem so it is recorded, not lost', () => {
    expect(exitTriggerRecord({ verdict: 'HOLD', exitTrigger: null, exitTriggerProblem: 'price is not a positive number' }, tick))
      .toEqual({ v: 1, problem: 'price is not a positive number' });
  });

  it.each(['EXIT_NOW', 'ESCALATE'])('%s never carries a trigger (spec §3.1: ignored)', (verdict) => {
    expect(exitTriggerRecord({ verdict, exitTrigger: { instrument: 'PREMIUM', op: 'BELOW', price: 1 } }, tick)).toBeNull();
  });

  it('null / absent proposal persists nothing', () => {
    expect(exitTriggerRecord({ verdict: 'HOLD', exitTrigger: null }, tick)).toBeNull();
    expect(exitTriggerRecord({ verdict: 'HOLD' }, tick)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx jest src/modules/trade-sentinel/services/exit-trigger-proposal.spec.ts`
Expected: FAIL — `Cannot find module './exit-trigger-proposal'`.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/modules/trade-sentinel/services/exit-trigger-proposal.ts
/**
 * The judge's machine-readable exit level (docs/superpowers/specs/2026-10-13-sentinel-price-triggers-design.md §3.1).
 *
 * SHAPE ONLY. Whether a level is protective, close enough, tighter than the one
 * already armed, or priced at all is decided by sentinel-executor at arming time,
 * against the live hub price (plan ruling R1). This module never validates
 * semantics and never arms anything — it cannot: nothing here reaches an order.
 *
 * Checked in code because the CLI judge cannot enforce VERDICT_SCHEMA (the
 * schema only travels as prompt text there). A malformed trigger never costs the
 * verdict it rides on (ruling R12).
 */
export type TriggerInstrument = 'UNDERLYING' | 'PREMIUM';
export type TriggerOp = 'BELOW' | 'ABOVE';

export interface ExitTriggerProposal {
  instrument: TriggerInstrument;
  op: TriggerOp;
  price: number;
}

export type ProposalParse =
  | { kind: 'absent' }
  | { kind: 'none' }
  | { kind: 'proposal'; proposal: ExitTriggerProposal }
  | { kind: 'malformed'; problem: string };

const FIELDS = ['instrument', 'op', 'price'];
const malformed = (problem: string): ProposalParse => ({ kind: 'malformed', problem });

export function parseExitTriggerProposal(raw: Record<string, unknown>): ProposalParse {
  if (!Object.prototype.hasOwnProperty.call(raw, 'exitTrigger')) return { kind: 'absent' };
  const t = raw.exitTrigger;
  if (t === null) return { kind: 'none' };
  if (typeof t !== 'object' || Array.isArray(t)) return malformed('exitTrigger is not an object or null');
  const o = t as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => !FIELDS.includes(k));
  if (extra.length > 0) return malformed(`unexpected field(s) ${extra.join(', ')}`);
  if (o.instrument !== 'UNDERLYING' && o.instrument !== 'PREMIUM') {
    return malformed(`instrument ${JSON.stringify(o.instrument)} is not UNDERLYING|PREMIUM`);
  }
  if (o.op !== 'BELOW' && o.op !== 'ABOVE') return malformed(`op ${JSON.stringify(o.op)} is not BELOW|ABOVE`);
  if (typeof o.price !== 'number' || !Number.isFinite(o.price) || o.price <= 0) {
    return malformed(`price ${JSON.stringify(o.price)} is not a positive number`);
  }
  return { kind: 'proposal', proposal: { instrument: o.instrument, op: o.op, price: o.price } };
}

export interface WatchRef {
  exchange: string;
  token: string;
  symbol: string;
}

/**
 * WIRE CONTRACT with sentinel-executor/domain/stored-trigger.ts (ruling R17): the
 * two modules may not import each other, so this shape is declared on both sides
 * and pinned by the identical STORED_TRIGGER_FIXTURE in both specs.
 */
export interface StoredExitTriggerV1 {
  v: 1;
  instrument?: TriggerInstrument;
  op?: TriggerOp;
  price?: number;
  /** UNDERLYING: where underlyingLtp was read (index / NSE cash / MCX future). PREMIUM: null. */
  watch?: WatchRef | null;
  /** What the judge saw on that instrument when it set the level (audit only). */
  seen?: { price: number | null; at: string | null };
  /** Set instead of the fields above when the judge's trigger was malformed. */
  problem?: string;
}

export const STORED_TRIGGER_FIXTURE: StoredExitTriggerV1 = {
  v: 1,
  instrument: 'UNDERLYING',
  op: 'BELOW',
  price: 8930,
  watch: { exchange: 'MCX', token: '472789', symbol: 'CRUDEOIL19NOV26FUT' },
  seen: { price: 8951, at: '2026-10-13T16:59:58.000Z' },
};

/** What the cycle persists on sentinel_verdicts.exitTrigger, or null for nothing. */
export function exitTriggerRecord(
  verdict: { verdict: string; exitTrigger?: ExitTriggerProposal | null; exitTriggerProblem?: string },
  tick: { ltp: number; underlyingLtp: number | null; underlyingLtpAt: string | null; underlyingRef?: WatchRef | null },
): StoredExitTriggerV1 | null {
  if (verdict.verdict !== 'HOLD' && verdict.verdict !== 'EXIT_ARMED') return null;
  if (verdict.exitTriggerProblem) return { v: 1, problem: verdict.exitTriggerProblem };
  const p = verdict.exitTrigger;
  if (!p) return null;
  if (p.instrument === 'UNDERLYING') {
    return {
      v: 1, instrument: p.instrument, op: p.op, price: p.price,
      watch: tick.underlyingRef ?? null,
      seen: { price: tick.underlyingLtp, at: tick.underlyingLtpAt },
    };
  }
  return { v: 1, instrument: p.instrument, op: p.op, price: p.price, watch: null, seen: { price: tick.ltp, at: null } };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && npx jest src/modules/trade-sentinel/services/exit-trigger-proposal.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/trade-sentinel/services/exit-trigger-proposal.ts apps/api/src/modules/trade-sentinel/services/exit-trigger-proposal.spec.ts
git commit -m "feat(trade-sentinel): exitTrigger proposal shape parse and persisted record

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `VERDICT_SCHEMA.exitTrigger` + agent validation (Stream A)

**Files:**
- Modify: `apps/api/src/modules/trade-sentinel/services/sentinel-agent.service.ts` (`Verdict` ~line 38, `VERDICT_SCHEMA` ~line 50, `validate()` ~line 425)
- Test: `apps/api/src/modules/trade-sentinel/services/sentinel-agent.service.spec.ts`

**Interfaces:**
- Consumes: `parseExitTriggerProposal`, `ExitTriggerProposal` (Task 2).
- Produces: `Verdict.exitTrigger?: ExitTriggerProposal | null`, `Verdict.exitTriggerProblem?: string`; `VERDICT_SCHEMA.properties.exitTrigger` (nullable via `anyOf`), `'exitTrigger'` LAST in `required`.

- [ ] **Step 1: Write the failing tests** (append to `sentinel-agent.service.spec.ts`)

```ts
describe('exitTrigger (price triggers, plan Task 3)', () => {
  const base = {
    verdict: 'HOLD', confidence: 'medium', thesisStatus: 'INTACT', recoveryAvailable: true,
    reason: 'holding above demand', evidence: ['money.netPnl'], invalidationPoint: 'loses 8930', reviewIn: 300,
  };
  const PACKET = { money: { netPnl: 10 } } as never;
  const agentReplying = (obj: unknown) =>
    new SentinelAgentService({
      messages: {
        create: jest.fn().mockResolvedValue({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(obj) }] }),
      },
    } as never);

  it('the schema requires exitTrigger (last) and allows null through anyOf, not a type array', () => {
    expect(VERDICT_SCHEMA.required[VERDICT_SCHEMA.required.length - 1]).toBe('exitTrigger');
    const p = VERDICT_SCHEMA.properties.exitTrigger as unknown as { anyOf: Array<{ type: string }> };
    expect(p.anyOf.map((s) => s.type)).toEqual(['null', 'object']);
  });

  it('keeps a valid trigger', async () => {
    const v = await agentReplying({ ...base, exitTrigger: { instrument: 'UNDERLYING', op: 'BELOW', price: 8930 } }).judge(PACKET);
    expect(v.exitTrigger).toEqual({ instrument: 'UNDERLYING', op: 'BELOW', price: 8930 });
    expect(v.exitTriggerProblem).toBeUndefined();
  });

  it('keeps an explicit null', async () => {
    const v = await agentReplying({ ...base, exitTrigger: null }).judge(PACKET);
    expect(v.exitTrigger).toBeNull();
  });

  it('a pre-v6 reply with no exitTrigger key gains no key (golden results do not move)', async () => {
    const v = await agentReplying(base).judge(PACKET);
    expect(Object.prototype.hasOwnProperty.call(v, 'exitTrigger')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(v, 'exitTriggerProblem')).toBe(false);
  });

  it('a malformed trigger keeps the verdict, nulls the trigger and states the problem', async () => {
    const v = await agentReplying({ ...base, exitTrigger: { instrument: 'UNDERLYING', op: 'BELOW', price: '8930' } }).judge(PACKET);
    expect(v.verdict).toBe('HOLD');
    expect(v.exitTrigger).toBeNull();
    expect(v.exitTriggerProblem).toMatch(/price/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx jest src/modules/trade-sentinel/services/sentinel-agent.service.spec.ts -t "exitTrigger"`
Expected: FAIL — `VERDICT_SCHEMA.properties.exitTrigger` undefined.

- [ ] **Step 3: Implement**

In `sentinel-agent.service.ts` add `import { parseExitTriggerProposal, type ExitTriggerProposal } from './exit-trigger-proposal';`.

`Verdict` gains, after `reviewIn: number;`:

```ts
  /**
   * The level at which this trade is wrong, machine-readable (v6). Optional on
   * the TYPE because pre-v6 replies and stored verdicts have no such key; the
   * schema requires it, so a live v6 reply carries it (possibly null).
   */
  exitTrigger?: ExitTriggerProposal | null;
  /** Set when the reply's exitTrigger was malformed; exitTrigger is then null. */
  exitTriggerProblem?: string;
```

Above `VERDICT_SCHEMA`:

```ts
/**
 * Nullable via `anyOf`, NOT `type: [...]` — see NULLABLE_PRICE in thesis.service.ts:
 * type arrays are outside the structured-outputs subset.
 */
const EXIT_TRIGGER_SCHEMA = {
  anyOf: [
    { type: 'null' },
    {
      type: 'object',
      properties: {
        instrument: { type: 'string', enum: ['UNDERLYING', 'PREMIUM'] },
        op: { type: 'string', enum: ['BELOW', 'ABOVE'] },
        price: { type: 'number' },
      },
      required: ['instrument', 'op', 'price'],
      additionalProperties: false,
    },
  ],
} as const;
```

In `VERDICT_SCHEMA.properties` after `reviewIn: { type: 'integer' },` add `exitTrigger: EXIT_TRIGGER_SCHEMA,`; in `required` after `'reviewIn',` add `'exitTrigger',`.

At the end of `validate()`, replace `return v;` with:

```ts
    // Ruling R12: shape-checked here (the CLI cannot enforce the schema); a bad
    // trigger never costs the verdict. An ABSENT key (pre-v6 reply) is left
    // exactly as it was — no key is added.
    const parsed = parseExitTriggerProposal(raw as Record<string, unknown>);
    if (parsed.kind === 'proposal') v.exitTrigger = parsed.proposal;
    else if (parsed.kind === 'none') v.exitTrigger = null;
    else if (parsed.kind === 'malformed') {
      v.exitTrigger = null;
      v.exitTriggerProblem = parsed.problem;
      this.logger.warn(`sentinel agent: exitTrigger ignored (${parsed.problem}) — verdict kept`);
    }
    return v;
```

- [ ] **Step 4: Run the agent specs (existing tests must stay green)**

Run: `cd apps/api && npx jest src/modules/trade-sentinel/services/sentinel-agent.service.spec.ts src/modules/trade-sentinel/services/sentinel-agent.overnight.spec.ts`
Expected: PASS. (The golden spec now fails on the request schema — expected; Task 4 regenerates it. Do not run `-u` here.)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/trade-sentinel/services/sentinel-agent.service.ts apps/api/src/modules/trade-sentinel/services/sentinel-agent.service.spec.ts
git commit -m "feat(trade-sentinel): verdict schema carries a nullable exitTrigger; a malformed one never costs the verdict

The golden snapshot is regenerated in the next commit together with the prompt
bump, so both request changes are attributed in one diff.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Prompt v6 / v2.3 + golden regeneration, attributed line by line (Stream A)

**Files:**
- Modify: `apps/api/src/modules/trade-sentinel/prompts/sentinel-system-prompt.ts`
- Modify: `apps/api/src/modules/trade-sentinel/services/sentinel-agent.service.spec.ts` (version + hash tests)
- Modify: `apps/api/src/modules/trade-sentinel/golden/__snapshots__/sentinel-golden.spec.ts.snap` (regenerated)

**Interfaces:**
- Produces: `SENTINEL_PROMPT_VERSION = 'v6'`, `SENTINEL_PROMPT_VERSION_NO_CUES = 'v2.3'`, exported `EXIT_TRIGGER_RULES: string` (the inserted block, ends with `\n`), exported `V5_OWNERSHIP_LINE: string`.

- [ ] **Step 1: Pin the v5 text before touching it**

Add a throwaway test file `apps/api/src/modules/trade-sentinel/prompts/v5-hash.tmp.spec.ts`:

```ts
import { createHash } from 'crypto';
import { SENTINEL_SYSTEM_PROMPT } from './sentinel-system-prompt';
it('prints the v5 hash', () => {
  console.log(createHash('sha256').update(SENTINEL_SYSTEM_PROMPT, 'utf8').digest('hex'), SENTINEL_SYSTEM_PROMPT.length);
});
```

Run: `cd apps/api && npx jest src/modules/trade-sentinel/prompts/v5-hash.tmp.spec.ts` → note the hex and length; delete the file (it is never committed).

- [ ] **Step 2: Write the failing tests** (in `sentinel-agent.service.spec.ts`)

Change `expect(svc.promptVersion).toBe('v2.2/t1');` to `'v2.3/t1'`. In the existing v2 hash test, import `EXIT_TRIGGER_RULES` and change the restore to:

```ts
    const restored = SENTINEL_SYSTEM_PROMPT_NO_CUES
      .replace(EXIT_TRIGGER_RULES, '')
      .replace(line as string, OLD_MTC_LINE)
      .replace(own as string, OLD_OWNERSHIP_LINE);
```

(length 5562 and hash `084d0a1422f2bdba2f10c1d19bd70dde7c18459461fb0122b7f055c01a3c16ad` unchanged; update the comment to "v2 -> v2.3: those two corrections plus the v2.3 exitTrigger block"). Add:

```ts
describe('prompt v6 / v2.3 (price triggers)', () => {
  /** SENTINEL_SYSTEM_PROMPT at v5 (<length> chars), recorded in Task 4 Step 1. */
  const V5_SHA256 = '<hex from Step 1>';

  it.each([
    ['cues on', SENTINEL_SYSTEM_PROMPT],
    ['cues off', SENTINEL_SYSTEM_PROMPT_NO_CUES],
  ])('%s: carries the exitTrigger rules exactly once and the corrected ownership line', (_l, prompt) => {
    expect(prompt.split(EXIT_TRIGGER_RULES)).toHaveLength(2);
    expect(prompt).not.toContain(V5_OWNERSHIP_LINE);
    const own = prompt.split('\n').find((l) => l.startsWith('- position.ownership')) ?? '';
    expect(own).toMatch(/exitTrigger/);
    expect(own).toMatch(/ESCALATE never is/);
  });

  it('v6 differs from v5 ONLY by the rules block and the ownership line', () => {
    const own = SENTINEL_SYSTEM_PROMPT.split('\n').find((l) => l.startsWith('- position.ownership')) as string;
    const v5 = SENTINEL_SYSTEM_PROMPT.replace(EXIT_TRIGGER_RULES, '').replace(own, V5_OWNERSHIP_LINE);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createHash } = require('crypto') as typeof import('crypto');
    expect(createHash('sha256').update(v5, 'utf8').digest('hex')).toBe(V5_SHA256);
  });

  it('the stamps moved', () => {
    expect(SENTINEL_PROMPT_VERSION).toBe('v6');
    expect(SENTINEL_PROMPT_VERSION_NO_CUES).toBe('v2.3');
  });
});
```

Run: `cd apps/api && npx jest src/modules/trade-sentinel/services/sentinel-agent.service.spec.ts`
Expected: FAIL — `EXIT_TRIGGER_RULES` not exported; version `v2.2`.

- [ ] **Step 3: Implement the prompt change**

In `sentinel-system-prompt.ts`:

1. Extend the version doc and bump:

```ts
 * v6 (from v5): price triggers. Every verdict carries "exitTrigger" — on HOLD and
 * EXIT_ARMED the machine-readable level its invalidationPoint describes, which a
 * tick watcher may execute without asking again — and the position.ownership
 * line says so. The schema gained the exitTrigger property. No other line moves.
 */
export const SENTINEL_PROMPT_VERSION = 'v6';
```

and `export const SENTINEL_PROMPT_VERSION_NO_CUES = 'v2.3';` (doc: "…and the v2.3 exitTrigger rules and ownership line, shared with v6").

2. Above `SENTINEL_SYSTEM_PROMPT`:

```ts
/** The v5 ownership line, kept so tests can prove v6 changed nothing else. */
export const V5_OWNERSHIP_LINE =
  '- position.ownership is "SENTINEL" when this trade is yours to judge alone, or "OBSERVE_ONLY" when it is a long-term holding or is already managed by another engine. It is stated so your verdict can be attributed to the right kind of trade. Judge the trade the same way either way. Depending on the owner\'s settings, an EXIT_NOW may be executed automatically as a market exit of the whole position; EXIT_ARMED, HOLD and ESCALATE never are.';

/** The v6 rules block, inserted after the "reviewIn" rule. Ends with a newline. */
export const EXIT_TRIGGER_RULES = [
  '- "exitTrigger" turns your invalidationPoint into a level a machine can watch. On HOLD and EXIT_ARMED give {"instrument", "op", "price"} for the price at which this trade is wrong — the same level your invalidationPoint describes — or null when there is no defensible level. On EXIT_NOW and ESCALATE give null; it is ignored.',
  '- exitTrigger.instrument "UNDERLYING" compares price against position.underlyingLtp, the scale of structure and flow levels; "PREMIUM" compares it against position.ltp. Never put an underlying-scale level on PREMIUM or a premium on UNDERLYING. If position.underlyingLtp is unavailable, use PREMIUM or null.',
  '- exitTrigger.op is the direction of the cross that proves the trade wrong: "BELOW" when price falling through the level hurts this position, "ABOVE" when price rising through it hurts. The level must not already be crossed, and it must protect the position — never a profit target.',
  '- A later exitTrigger may only move the level closer to the current price; one that moves it further away is ignored, and null leaves an existing level in place.',
].join('\n') + '\n';
```

3. In the `SENTINEL_SYSTEM_PROMPT` template literal, the ownership line becomes:

```
- position.ownership is "SENTINEL" when this trade is yours to judge alone, or "OBSERVE_ONLY" when it is a long-term holding or is already managed by another engine. It is stated so your verdict can be attributed to the right kind of trade. Judge the trade the same way either way. Depending on the owner's settings, an EXIT_NOW may be executed automatically as a market exit of the whole position, and so may the exitTrigger of a HOLD or EXIT_ARMED verdict once price crosses it; ESCALATE never is.
```

and directly after the line `- "reviewIn" is how many seconds until you should be asked again.` (i.e. at the start of the next line, before `- Keep "reason" …`) insert `${EXIT_TRIGGER_RULES}` so the block is followed by the Keep-reason line. `V3_MACRO_LINES` and the `_NO_CUES` derivation are untouched; the new text lies outside the macro slice, so the cues-off prompt carries it too.

- [ ] **Step 4: Run the prompt/agent tests**

Run: `cd apps/api && npx jest src/modules/trade-sentinel/services/sentinel-agent.service.spec.ts`
Expected: PASS (v2 hash unchanged, v5 hash matches, `v2.3/t1`).

- [ ] **Step 5: Regenerate the golden snapshot**

Run: `cd apps/api && npx jest src/modules/trade-sentinel/golden -u`
Expected: `N snapshots updated`, PASS. Run again WITHOUT `-u` → PASS, 0 updated.

- [ ] **Step 6: Attribute every changed word**

Save to the scratchpad (never committed) as `golden-attrib.js`:

```js
// Classify every added/removed word chunk of the golden snapshot diff into the
// intended changes. Any other chunk is printed as UNATTRIBUTED.
const { execSync } = require('child_process');
const snap = 'apps/api/src/modules/trade-sentinel/golden/__snapshots__/sentinel-golden.spec.ts.snap';
const git = (args) => execSync(`git ${args} -- ${snap}`, { encoding: 'utf8', maxBuffer: 1 << 26 });
const RULES = [
  ['VERSION stamp', /^(v6|v5|v2\.3|v2\.2)(\/t\d+)?[",]*$/],
  ['PROMPT ownership sentence', /owner|EXIT_NOW|EXIT_ARMED|HOLD|ESCALATE|executed|automatically|market exit|whole position|never (is|are)|so may|once price crosses|exitTrigger of/],
  ['PROMPT exitTrigger rules', /exitTrigger|invalidationPoint|underlyingLtp|position\.ltp|defensible|profit target|closer to the current price|UNDERLYING|PREMIUM|BELOW|ABOVE/],
  ['SCHEMA exitTrigger property / required entry', /anyOf|"(null|object|number|string|instrument|op|price|exitTrigger|reviewIn|type|enum|required|properties|additionalProperties)"|^[\s\[\]{},:\\n"]*$|false|true/],
];
const counts = {};
const bad = [];
for (const line of git('diff --word-diff=porcelain').split('\n')) {
  if (!/^[+-]/.test(line) || /^(\+\+\+|---)/.test(line)) continue;
  const word = line.slice(1).trim();
  const hit = RULES.find(([, re]) => re.test(word));
  if (hit) counts[hit[0]] = (counts[hit[0]] || 0) + 1;
  else bad.push(line.slice(0, 200));
}
console.log(counts);
console.log(`UNATTRIBUTED: ${bad.length}`);
for (const b of bad) console.log('  ' + b);
// R12: pre-v6 fixture replies have no exitTrigger key, so no recorded RESULT or LOG may move.
const changed = git('diff -U0').split('\n').filter((l) => /^[+-](?![+-])/.test(l));
console.log(`result/logs lines touched: ${changed.filter((l) => /"(result|logs)"|"verdict": "|"message":/.test(l)).length}`);
```

Run (repo root): `node <scratchpad>/golden-attrib.js`
Expected: `UNATTRIBUTED: 0`, `result/logs lines touched: 0`. Then READ `git diff -- <snap>` hunk by hunk and confirm each hunk is one of: (a) the `exitTrigger` property block + `"exitTrigger"` required entry in each API-path request's `output_config.format.schema`; (b) the same inside each CLI scenario's prompt text (`schemaInstruction`); (c) the ownership line; (d) the four rule lines; (e) a version stamp. Write the printed counts into the commit message.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/trade-sentinel/prompts/sentinel-system-prompt.ts apps/api/src/modules/trade-sentinel/services/sentinel-agent.service.spec.ts apps/api/src/modules/trade-sentinel/golden/__snapshots__/sentinel-golden.spec.ts.snap
git commit -m "feat(trade-sentinel): prompt v6 / v2.3 asks for a machine-readable exitTrigger

Both live prompts gain four exitTrigger rules after the reviewIn rule, and the
position.ownership line now says a HOLD/EXIT_ARMED exitTrigger may be executed
once price crosses it (ESCALATE never is). SENTINEL_PROMPT_VERSION v5 -> v6,
SENTINEL_PROMPT_VERSION_NO_CUES v2.2 -> v2.3. The v2 hash test strips the rules
block and restores both old lines; a new v5 hash test proves v6 changed nothing
else.

Golden snapshot regenerated; every changed word attributed (golden-attrib.js):
<paste counts>, UNATTRIBUTED 0, result/logs lines touched 0.
- request schema: exitTrigger property + required entry (API and CLI scenarios)
- ownership sentence
- exitTrigger rules block
- version stamps

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: `underlyingRef` / `contractRef` on the tick (Stream A)

**Files:**
- Modify: `apps/api/src/modules/trade-sentinel/services/context-packet.service.ts` (`TickSnapshot`, after `underlyingLtpReason`)
- Modify: `apps/api/src/modules/trade-sentinel/adapters/tick-source.adapter.ts` (`tickFor` return object, ~line 400)
- Test: `apps/api/src/modules/trade-sentinel/adapters/tick-source.adapter.spec.ts`, `apps/api/src/modules/trade-sentinel/services/context-packet.service.spec.ts`

**Interfaces:**
- Produces: `TickSnapshot.underlyingRef?: { exchange: string; token: string; symbol: string } | null`, `TickSnapshot.contractRef?: { exchange: string; token: string; symbol: string } | null` (hence on `TickReading`).

- [ ] **Step 1: Write the failing tests**

`tick-source.adapter.spec.ts`, inside `describe('MCX commodity options …')`:

```ts
      it('names the future it priced as underlyingRef (the executor watches exactly this)', async () => {
        const t = make();
        t.findUnique.mockResolvedValue(crudeOption());
        t.getInstrumentByToken.mockResolvedValue({ name: 'CRUDEOIL', expiry: null });
        t.getNearestFuture.mockResolvedValue({ token: '472789', symbol: 'CRUDEOIL19OCT26FUT', exchange: 'MCX' });
        t.fetchQuote.mockResolvedValue({ ltp: 8875 });

        const tick = await t.svc.tickFor('t1');

        expect(tick.underlyingRef).toEqual({ exchange: 'MCX', token: '472789', symbol: 'CRUDEOIL19OCT26FUT' });
        expect(tick.contractRef).toEqual({ exchange: 'MCX', token: '5001', symbol: 'CRUDEOIL15OCT268850PE' });
      });
```

inside `describe('derivatives')`:

```ts
    it('an index option names the index as underlyingRef', async () => {
      const t = make();
      t.findUnique.mockResolvedValue(option());
      t.getInstrumentByToken.mockResolvedValue({ name: 'NIFTY', expiry: null });
      t.getLevels.mockReturnValue({ spot: 24010, lastTickAt: NOW });

      const tick = await t.svc.tickFor('t1');

      expect(tick.underlyingRef).toEqual({ exchange: 'NSE', token: '99926000', symbol: 'NIFTY' });
    });

    it('an unresolvable underlying gives underlyingRef null, never the contract', async () => {
      const t = make();
      t.findUnique.mockResolvedValue(option());
      t.getInstrumentByToken.mockResolvedValue(null);

      const tick = await t.svc.tickFor('t1');

      expect(tick.underlyingRef).toBeNull();
    });
```

top level of `describe('SentinelTickSource')`:

```ts
  it('cash: underlyingRef is null (the contract IS the underlying); contractRef is the row', async () => {
    const t = make();
    const tick = await t.svc.tickFor('t1');
    const r = row();
    expect(tick.underlyingRef).toBeNull();
    expect(tick.contractRef).toEqual({ exchange: String(r.exchange).toUpperCase(), token: String(r.token), symbol: r.symbol });
  });
```

`context-packet.service.spec.ts` — next to the existing tests that call `build(entry, tick, thesis, fires)` (reuse that file's entry/tick/thesis fixtures by their names in the file):

```ts
  it('never renders underlyingRef or contractRef into the packet (executor plumbing only)', async () => {
    const packet = await service.build(
      entry,
      { ...tickSnapshot, underlyingRef: { exchange: 'MCX', token: '1', symbol: 'X' }, contractRef: { exchange: 'MCX', token: '2', symbol: 'Y' } },
      thesis,
      [],
    );
    const text = JSON.stringify(packet);
    expect(text).not.toContain('underlyingRef');
    expect(text).not.toContain('contractRef');
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx jest src/modules/trade-sentinel/adapters/tick-source.adapter.spec.ts -t "underlyingRef|contractRef"`
Expected: FAIL — `underlyingRef` is `undefined`.

- [ ] **Step 3: Implement**

`context-packet.service.ts`, `TickSnapshot`, after `underlyingLtpReason`:

```ts
  /**
   * WHERE `underlyingLtp` was read: the index, the NSE cash row, or the MCX
   * future of the option's own month — exactly what the spot tiers priced. Null
   * for cash (the contract IS the underlying) and when unresolved. NEVER rendered
   * into the packet: the cycle copies it into a persisted exitTrigger so
   * sentinel-executor knows which instrument an UNDERLYING level watches.
   */
  underlyingRef?: { exchange: string; token: string; symbol: string } | null;
  /** The position's own contract (tracker exchange/token/symbol). Same rule: never in the packet. */
  contractRef?: { exchange: string; token: string; symbol: string } | null;
```

`tick-source.adapter.ts`, in the returned object after `underlyingLtpReason: spot.reason,`:

```ts
      underlyingRef:
        !isCash && underlying.token && underlying.exchange
          ? { exchange: underlying.exchange, token: underlying.token, symbol: underlying.contract ?? underlying.name ?? underlying.token }
          : null,
      contractRef: { exchange: String(row.exchange ?? '').toUpperCase(), token: String(row.token), symbol: row.symbol },
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && npx jest src/modules/trade-sentinel/adapters/tick-source.adapter.spec.ts src/modules/trade-sentinel/services/context-packet.service.spec.ts src/modules/trade-sentinel/golden`
Expected: PASS (golden unchanged — the packet does not carry the refs).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/trade-sentinel/services/context-packet.service.ts apps/api/src/modules/trade-sentinel/adapters/tick-source.adapter.ts apps/api/src/modules/trade-sentinel/adapters/tick-source.adapter.spec.ts apps/api/src/modules/trade-sentinel/services/context-packet.service.spec.ts
git commit -m "feat(trade-sentinel): the tick names the underlying and contract it priced (never rendered in the packet)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Cycle persists the proposal on the verdict row (Stream A, after Task 1)

**Files:**
- Modify: `apps/api/src/modules/trade-sentinel/repositories/sentinel-verdict.repository.ts` (`RecordVerdictInput`, `record`)
- Modify: `apps/api/src/modules/trade-sentinel/services/sentinel-cycle.service.ts` (`judgeAndRecord`, the `this.verdicts.record({...})` call ~line 855)
- Test: `apps/api/src/modules/trade-sentinel/repositories/sentinel-verdict.repository.spec.ts`, `apps/api/src/modules/trade-sentinel/services/sentinel-cycle.service.spec.ts`

**Interfaces:**
- Consumes: `exitTriggerRecord`, `STORED_TRIGGER_FIXTURE` (Task 2); `TickReading.underlyingRef` (Task 5); `SentinelVerdict.exitTrigger` column (Task 1).
- Produces: `RecordVerdictInput.exitTrigger?: Prisma.InputJsonValue` — omitted ⇒ column NULL.

- [ ] **Step 1: Write the failing tests**

`sentinel-verdict.repository.spec.ts` (reuse the file's existing valid input builder; named `input()` below):

```ts
  it('writes exitTrigger only when given (omitted = SQL NULL; existing callers unchanged)', async () => {
    const create = jest.fn().mockResolvedValue({});
    const repo = new SentinelVerdictRepository({ sentinelVerdict: { create } } as never);
    await repo.record({ ...input(), exitTrigger: { v: 1, problem: 'x' } });
    expect(create.mock.calls[0][0].data.exitTrigger).toEqual({ v: 1, problem: 'x' });
    await repo.record(input());
    expect('exitTrigger' in create.mock.calls[1][0].data).toBe(false);
  });
```

`sentinel-cycle.service.spec.ts` (new describe using `makeSvc()`; import `STORED_TRIGGER_FIXTURE` from `./exit-trigger-proposal`):

```ts
describe('SentinelCycleService — exitTrigger persistence (price triggers)', () => {
  it('persists the proposal with the underlying the tick priced', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([watched('t1')]);
    t.tickFor.mockResolvedValue(tick({
      ltp: 212.5, underlyingLtp: 8951, underlyingLtpAt: '2026-10-13T16:59:58.000Z',
      underlyingRef: { exchange: 'MCX', token: '472789', symbol: 'CRUDEOIL19NOV26FUT' },
    }));
    t.judge.mockResolvedValue({
      verdict: 'EXIT_ARMED', confidence: 'medium', thesisStatus: 'WEAKENING', recoveryAvailable: true,
      reason: 'r', evidence: ['money.netPnl'], invalidationPoint: 'loses 8930', reviewIn: 120,
      exitTrigger: { instrument: 'UNDERLYING', op: 'BELOW', price: 8930 },
    });

    await t.svc.runForUser(USER);

    expect(t.record.mock.calls[0][0].exitTrigger).toEqual(STORED_TRIGGER_FIXTURE);
  });

  it('a verdict without a trigger writes no exitTrigger key', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([watched('t1')]);
    await t.svc.runForUser(USER);
    expect('exitTrigger' in t.record.mock.calls[0][0]).toBe(false);
  });

  it('EXIT_NOW never persists a trigger', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([watched('t1')]);
    t.judge.mockResolvedValue({
      verdict: 'EXIT_NOW', confidence: 'high', thesisStatus: 'BROKEN', recoveryAvailable: false,
      reason: 'r', evidence: ['money.netPnl'], invalidationPoint: 'x', reviewIn: 60,
      exitTrigger: { instrument: 'PREMIUM', op: 'BELOW', price: 1 },
    });
    await t.svc.runForUser(USER);
    expect('exitTrigger' in t.record.mock.calls[0][0]).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx jest src/modules/trade-sentinel/services/sentinel-cycle.service.spec.ts src/modules/trade-sentinel/repositories/sentinel-verdict.repository.spec.ts -t "exitTrigger"`
Expected: FAIL.

- [ ] **Step 3: Implement**

`sentinel-verdict.repository.ts` — `RecordVerdictInput`, after `greenFloor`:

```ts
  /** The persisted exitTrigger proposal (price triggers). Omitted = NULL. */
  exitTrigger?: Prisma.InputJsonValue;
```

and in `record()`'s `data`, after `greenFloor: input.greenFloor,`:

```ts
        ...(input.exitTrigger !== undefined ? { exitTrigger: input.exitTrigger } : {}),
```

`sentinel-cycle.service.ts` — `import { exitTriggerRecord } from './exit-trigger-proposal';` (and `import type { Prisma } from '@prisma/client';` if absent). In `judgeAndRecord`, before `progress.stage = 'verdict write';`:

```ts
    // Price triggers: the judge's level and the instrument it watches. DATA ONLY —
    // arming, validation and execution all live in sentinel-executor (ruling R1).
    const exitTrigger = exitTriggerRecord(verdict, tick);
```

and in the `this.verdicts.record({ … })` object after `greenFloor: packet.money.greenFloorPrice,`:

```ts
      ...(exitTrigger ? { exitTrigger: exitTrigger as unknown as Prisma.InputJsonValue } : {}),
```

- [ ] **Step 4: Run the whole sentinel suite**

Run: `cd apps/api && npx jest src/modules/trade-sentinel`
Expected: PASS (the reachability walk is unchanged: `exit-trigger-proposal.ts` imports nothing).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/trade-sentinel/repositories/sentinel-verdict.repository.ts apps/api/src/modules/trade-sentinel/repositories/sentinel-verdict.repository.spec.ts apps/api/src/modules/trade-sentinel/services/sentinel-cycle.service.ts apps/api/src/modules/trade-sentinel/services/sentinel-cycle.service.spec.ts
git commit -m "feat(trade-sentinel): persist the judge's exitTrigger proposal on the verdict row

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Trigger config + shared trigger types (Stream B, pure)

**Files:**
- Create: `apps/api/src/modules/sentinel-executor/domain/trigger.types.ts`
- Create: `apps/api/src/modules/sentinel-executor/domain/trigger-config.ts`
- Test: `apps/api/src/modules/sentinel-executor/domain/trigger-config.spec.ts`

**Interfaces:**
- Produces:
  - `trigger.types.ts`: `type TriggerInstrument = 'UNDERLYING' | 'PREMIUM'`, `type TriggerOp = 'BELOW' | 'ABOVE'`, `interface WatchRef { exchange: string; token: string; symbol: string }`, `TRIGGER_TIMING = { tickMaxAgeMs: 5000, tickGapResetMs: 5000, armPriceMaxAgeMs: 15000, armDeferMs: 30000, armLookbackMs: 180000, passMs: 5000, maintenanceMs: 30000, starvedMs: 60000, perPass: 10 } as const`, `TRIGGER_WATCH_OWNER = 'sentinel-triggers'`.
  - `trigger-config.ts`: `interface TriggerConfig { enabled: boolean; confirmTicks: number; confirmMs: number; maxAgeMin: number; maxDistancePct: Record<TriggerInstrument, number>; tightenOnly: boolean; problems: string[] }`, `parseTriggerConfig(env: Record<string, string | undefined>): TriggerConfig`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/modules/sentinel-executor/domain/trigger-config.spec.ts
import { parseTriggerConfig } from './trigger-config';

describe('parseTriggerConfig (spec §5)', () => {
  it('defaults are the owner-approved ones, and OFF', () => {
    expect(parseTriggerConfig({})).toEqual({
      enabled: false, confirmTicks: 2, confirmMs: 1000, maxAgeMin: 240,
      maxDistancePct: { UNDERLYING: 10, PREMIUM: 60 }, tightenOnly: true, problems: [],
    });
  });

  it('only the exact string true enables', () => {
    expect(parseTriggerConfig({ SENTINEL_TRIGGERS_ENABLED: 'true' }).enabled).toBe(true);
    expect(parseTriggerConfig({ SENTINEL_TRIGGERS_ENABLED: 'TRUE' }).enabled).toBe(false);
    expect(parseTriggerConfig({ SENTINEL_TRIGGERS_ENABLED: '1' }).enabled).toBe(false);
  });

  it('tighten-only can only be switched off by the exact string false (D4 fails safe)', () => {
    expect(parseTriggerConfig({ SENTINEL_TRIGGER_TIGHTEN_ONLY: 'false' }).tightenOnly).toBe(false);
    expect(parseTriggerConfig({ SENTINEL_TRIGGER_TIGHTEN_ONLY: 'no' }).tightenOnly).toBe(true);
  });

  it.each([
    ['SENTINEL_TRIGGER_CONFIRM_TICKS', '0', 'confirmTicks', 2],
    ['SENTINEL_TRIGGER_CONFIRM_TICKS', '1.5', 'confirmTicks', 2],
    ['SENTINEL_TRIGGER_CONFIRM_TICKS', '11', 'confirmTicks', 2],
    ['SENTINEL_TRIGGER_CONFIRM_MS', '-1', 'confirmMs', 1000],
    ['SENTINEL_TRIGGER_CONFIRM_MS', '10001', 'confirmMs', 1000],
    ['SENTINEL_TRIGGER_MAX_AGE_MIN', '4', 'maxAgeMin', 240],
    ['SENTINEL_TRIGGER_MAX_AGE_MIN', 'abc', 'maxAgeMin', 240],
  ])('%s=%s is out of range → default, reported', (key, raw, field, fallback) => {
    const c = parseTriggerConfig({ [key]: raw });
    expect((c as unknown as Record<string, unknown>)[field]).toBe(fallback);
    expect(c.problems.join(' ')).toContain(key);
  });

  it('accepts in-range values', () => {
    const c = parseTriggerConfig({
      SENTINEL_TRIGGER_CONFIRM_TICKS: '3', SENTINEL_TRIGGER_CONFIRM_MS: '0', SENTINEL_TRIGGER_MAX_AGE_MIN: '60',
      SENTINEL_TRIGGER_MAX_DISTANCE_PCT: 'UNDERLYING:5,PREMIUM:40',
    });
    expect(c).toMatchObject({ confirmTicks: 3, confirmMs: 0, maxAgeMin: 60, maxDistancePct: { UNDERLYING: 5, PREMIUM: 40 } });
    expect(c.problems).toEqual([]);
  });

  it.each([
    ['UNDERLYING:30', 'UNDERLYING'],     // > 25 cap
    ['PREMIUM:0', 'PREMIUM'],
    ['SPOT:5', 'SPOT'],
    ['UNDERLYING', 'UNDERLYING'],
  ])('a bad distance entry %s keeps that instrument at its default', (raw, named) => {
    const c = parseTriggerConfig({ SENTINEL_TRIGGER_MAX_DISTANCE_PCT: raw });
    expect(c.maxDistancePct).toEqual({ UNDERLYING: 10, PREMIUM: 60 });
    expect(c.problems.join(' ')).toContain(named);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx jest src/modules/sentinel-executor/domain/trigger-config.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/modules/sentinel-executor/domain/trigger.types.ts
/** Price triggers (docs/superpowers/specs/2026-10-13-sentinel-price-triggers-design.md). */
export type TriggerInstrument = 'UNDERLYING' | 'PREMIUM';
export type TriggerOp = 'BELOW' | 'ABOVE';

export interface WatchRef {
  exchange: string;
  token: string;
  symbol: string;
}

/** Fixed timings (plan rulings R6, R9, R10, R15). Not configuration: changing them changes safety. */
export const TRIGGER_TIMING = {
  /** A tick whose receipt time is further than this from now is ignored. */
  tickMaxAgeMs: 5_000,
  /** A gap longer than this between two accepted ticks restarts confirmation. */
  tickGapResetMs: 5_000,
  /** Arming needs the watched instrument priced at most this long ago. */
  armPriceMaxAgeMs: 15_000,
  /** How long an unpriced proposal waits for its (new) watch to price. */
  armDeferMs: 30_000,
  /** Proposals older than this when first seen are ignored (the next verdict re-proposes). */
  armLookbackMs: 180_000,
  passMs: 5_000,
  maintenanceMs: 30_000,
  /** An armed key unpriced this long during its session logs STARVED once. */
  starvedMs: 60_000,
  perPass: 10,
} as const;

/** Hub watch owner for UNDERLYING instruments the executor subscribes (priority 1). */
export const TRIGGER_WATCH_OWNER = 'sentinel-triggers';
```

```ts
// apps/api/src/modules/sentinel-executor/domain/trigger-config.ts
import type { TriggerInstrument } from './trigger.types';

export interface TriggerConfig {
  enabled: boolean;
  confirmTicks: number;
  confirmMs: number;
  maxAgeMin: number;
  maxDistancePct: Record<TriggerInstrument, number>;
  tightenOnly: boolean;
  problems: string[];
}

const DEFAULTS = { confirmTicks: 2, confirmMs: 1000, maxAgeMin: 240 } as const;
const DISTANCE_DEFAULTS: Record<TriggerInstrument, number> = { UNDERLYING: 10, PREMIUM: 60 };
const DISTANCE_MAX: Record<TriggerInstrument, number> = { UNDERLYING: 25, PREMIUM: 90 };

function num(raw: string | undefined, name: string, fallback: number, ok: (n: number) => boolean, problems: string[]): number {
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (Number.isFinite(n) && ok(n)) return n;
  problems.push(`${name}=${raw} is out of range — using ${fallback}`);
  return fallback;
}

function distances(raw: string | undefined, problems: string[]): Record<TriggerInstrument, number> {
  const out = { ...DISTANCE_DEFAULTS };
  for (const entry of String(raw ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const [k, v, ...rest] = entry.split(':');
    const key = String(k ?? '').trim().toUpperCase();
    if (key !== 'UNDERLYING' && key !== 'PREMIUM') {
      problems.push(`SENTINEL_TRIGGER_MAX_DISTANCE_PCT entry ${entry} names ${key || 'nothing'}, not UNDERLYING|PREMIUM — ignored`);
      continue;
    }
    const n = Number(v);
    if (rest.length > 0 || v === undefined || !Number.isFinite(n) || n <= 0 || n > DISTANCE_MAX[key]) {
      problems.push(`SENTINEL_TRIGGER_MAX_DISTANCE_PCT entry ${entry} is not ${key}:(0,${DISTANCE_MAX[key]}] — ${key} stays ${DISTANCE_DEFAULTS[key]}`);
      continue;
    }
    out[key] = n;
  }
  return out;
}

/**
 * Pure parse of SENTINEL_TRIGGER* (spec §5). Never throws; a bad value falls back
 * to the default and is reported, so a typo can neither stop boot nor widen what
 * a trigger may do.
 */
export function parseTriggerConfig(env: Record<string, string | undefined>): TriggerConfig {
  const problems: string[] = [];
  return {
    enabled: env.SENTINEL_TRIGGERS_ENABLED === 'true',
    confirmTicks: num(env.SENTINEL_TRIGGER_CONFIRM_TICKS, 'SENTINEL_TRIGGER_CONFIRM_TICKS', DEFAULTS.confirmTicks,
      (n) => Number.isInteger(n) && n >= 1 && n <= 10, problems),
    confirmMs: num(env.SENTINEL_TRIGGER_CONFIRM_MS, 'SENTINEL_TRIGGER_CONFIRM_MS', DEFAULTS.confirmMs,
      (n) => Number.isInteger(n) && n >= 0 && n <= 10_000, problems),
    maxAgeMin: num(env.SENTINEL_TRIGGER_MAX_AGE_MIN, 'SENTINEL_TRIGGER_MAX_AGE_MIN', DEFAULTS.maxAgeMin,
      (n) => Number.isInteger(n) && n >= 5 && n <= 1440, problems),
    maxDistancePct: distances(env.SENTINEL_TRIGGER_MAX_DISTANCE_PCT, problems),
    tightenOnly: env.SENTINEL_TRIGGER_TIGHTEN_ONLY !== 'false',
    problems,
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && npx jest src/modules/sentinel-executor/domain/trigger-config.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/sentinel-executor/domain/trigger.types.ts apps/api/src/modules/sentinel-executor/domain/trigger-config.ts apps/api/src/modules/sentinel-executor/domain/trigger-config.spec.ts
git commit -m "feat(sentinel-executor): SENTINEL_TRIGGER_* config parse and fixed trigger timings

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Trigger rules — protective direction, validation, tighten-only (Stream B, pure)

**Files:**
- Create: `apps/api/src/modules/sentinel-executor/domain/trigger-rules.ts`
- Test: `apps/api/src/modules/sentinel-executor/domain/trigger-rules.spec.ts`

**Interfaces:**
- Consumes: `TriggerInstrument`, `TriggerOp`, `TRIGGER_TIMING` (Task 7); `TriggerConfig` (Task 7).
- Produces:
  - `type ContractKind = 'CE' | 'PE' | 'FUT'`; `contractKindOf(symbol: string): ContractKind | null`
  - `adverseOp(instrument: TriggerInstrument, qty: number, kind: ContractKind | null): TriggerOp | null`
  - `interface TriggerLevel { instrument: TriggerInstrument; op: TriggerOp; price: number }`
  - `validateTrigger(i: { proposal: TriggerLevel; qty: number; kind: ContractKind | null; current: { price: number; ageMs: number } | null; armed: TriggerLevel | null; cfg: Pick<TriggerConfig, 'maxDistancePct' | 'tightenOnly'> }): { ok: true } | { ok: false; reason: string }`

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/modules/sentinel-executor/domain/trigger-rules.spec.ts
import { adverseOp, contractKindOf, validateTrigger, type TriggerLevel } from './trigger-rules';

const CFG = { maxDistancePct: { UNDERLYING: 10, PREMIUM: 60 }, tightenOnly: true };
const at = (price: number, ageMs = 1000) => ({ price, ageMs });
const lvl = (instrument: 'UNDERLYING' | 'PREMIUM', op: 'BELOW' | 'ABOVE', price: number): TriggerLevel => ({ instrument, op, price });
const run = (o: Partial<Parameters<typeof validateTrigger>[0]>) =>
  validateTrigger({ proposal: lvl('UNDERLYING', 'BELOW', 8930), qty: 100, kind: 'CE', current: at(8951), armed: null, cfg: CFG, ...o });

describe('contractKindOf', () => {
  it.each([
    ['CRUDEOIL19NOV268950CE', 'CE'], ['NIFTY28OCT2624000PE', 'PE'], ['CRUDEOIL19NOV26FUT', 'FUT'],
    ['RELIANCE', null], ['RELIANCE-EQ', null], ['nifty28oct2624000pe', 'PE'],
  ])('%s → %s', (s, k) => expect(contractKindOf(s)).toBe(k));
});

describe('adverseOp — the cross that HURTS the position (ruling R4, D5)', () => {
  it.each([
    ['PREMIUM', 100, 'CE', 'BELOW'], ['PREMIUM', -100, 'CE', 'ABOVE'],
    ['PREMIUM', 100, 'PE', 'BELOW'], ['PREMIUM', -100, 'PE', 'ABOVE'],
    ['UNDERLYING', 100, 'CE', 'BELOW'], ['UNDERLYING', -100, 'CE', 'ABOVE'],
    ['UNDERLYING', 100, 'PE', 'ABOVE'], ['UNDERLYING', -100, 'PE', 'BELOW'],
    ['UNDERLYING', 100, 'FUT', 'BELOW'], ['UNDERLYING', -100, 'FUT', 'ABOVE'],
    ['UNDERLYING', 100, null, null], ['PREMIUM', 0, 'CE', null],
  ] as const)('%s qty %d %s → %s', (instrument, qty, kind, op) => expect(adverseOp(instrument, qty, kind)).toBe(op));
});

describe('validateTrigger', () => {
  it('a protective, fresh, in-range level arms', () => expect(run({})).toEqual({ ok: true }));

  it('a long PUT protects with UNDERLYING ABOVE; BELOW would be a profit-take (NOT_PROTECTIVE)', () => {
    expect(run({ kind: 'PE', proposal: lvl('UNDERLYING', 'ABOVE', 8970) })).toEqual({ ok: true });
    expect(run({ kind: 'PE', proposal: lvl('UNDERLYING', 'BELOW', 8930) })).toEqual({ ok: false, reason: 'NOT_PROTECTIVE' });
  });

  it('a long with ABOVE on PREMIUM is a profit-take (D5) → NOT_PROTECTIVE', () => {
    expect(run({ proposal: lvl('PREMIUM', 'ABOVE', 250), current: at(212) })).toEqual({ ok: false, reason: 'NOT_PROTECTIVE' });
  });

  it('unknown contract kind on UNDERLYING → UNKNOWN_CONTRACT_KIND', () => {
    expect(run({ kind: null })).toEqual({ ok: false, reason: 'UNKNOWN_CONTRACT_KIND' });
  });

  it.each([
    ['no price', null],
    ['a 16 s old price', at(8951, 16_000)],
    ['a zero price', at(0)],
  ])('%s → NO_FRESH_PRICE', (_l, current) => {
    expect(run({ current })).toEqual({ ok: false, reason: 'NO_FRESH_PRICE' });
  });

  it('a level already crossed (or equal to current) → ALREADY_CROSSED', () => {
    expect(run({ current: at(8925) })).toEqual({ ok: false, reason: 'ALREADY_CROSSED' });
    expect(run({ current: at(8930) })).toEqual({ ok: false, reason: 'ALREADY_CROSSED' });
  });

  it('distance bounds per instrument → TOO_FAR with the numbers', () => {
    const r = run({ proposal: lvl('UNDERLYING', 'BELOW', 7900), current: at(8951) });
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toMatch(/^TOO_FAR \(11\.7\d?% > 10%\)$/);
    expect(run({ proposal: lvl('PREMIUM', 'BELOW', 90), current: at(212) })).toEqual({ ok: true }); // 57.5 %
  });

  it('a non-finite or non-positive level → BAD_PRICE', () => {
    expect(run({ proposal: lvl('UNDERLYING', 'BELOW', Number.NaN) })).toEqual({ ok: false, reason: 'BAD_PRICE' });
  });

  describe('tighten-only (D4, ruling R5)', () => {
    const armed = lvl('UNDERLYING', 'BELOW', 8930);
    it('a BELOW level may rise (tighten) or stay (renewal)', () => {
      expect(run({ armed, proposal: lvl('UNDERLYING', 'BELOW', 8940) })).toEqual({ ok: true });
      expect(run({ armed, proposal: lvl('UNDERLYING', 'BELOW', 8930) })).toEqual({ ok: true });
    });
    it('a BELOW level may never fall → LOOSENS', () => {
      expect(run({ armed, proposal: lvl('UNDERLYING', 'BELOW', 8900) })).toEqual({ ok: false, reason: 'LOOSENS' });
    });
    it('an ABOVE level may only fall', () => {
      const a = lvl('UNDERLYING', 'ABOVE', 8990);
      expect(run({ kind: 'PE', armed: a, proposal: lvl('UNDERLYING', 'ABOVE', 8980) })).toEqual({ ok: true });
      expect(run({ kind: 'PE', armed: a, proposal: lvl('UNDERLYING', 'ABOVE', 9000) })).toEqual({ ok: false, reason: 'LOOSENS' });
    });
    it('switching instrument while one is armed → INSTRUMENT_SWITCH', () => {
      expect(run({ armed, proposal: lvl('PREMIUM', 'BELOW', 180), current: at(212) })).toEqual({ ok: false, reason: 'INSTRUMENT_SWITCH' });
    });
    it('with tighten-only off, both are allowed', () => {
      const cfg = { ...CFG, tightenOnly: false };
      expect(run({ cfg, armed, proposal: lvl('UNDERLYING', 'BELOW', 8900) })).toEqual({ ok: true });
      expect(run({ cfg, armed, proposal: lvl('PREMIUM', 'BELOW', 180), current: at(212) })).toEqual({ ok: true });
    });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx jest src/modules/sentinel-executor/domain/trigger-rules.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/modules/sentinel-executor/domain/trigger-rules.ts
import type { TriggerConfig } from './trigger-config';
import { TRIGGER_TIMING, type TriggerInstrument, type TriggerOp } from './trigger.types';

export type ContractKind = 'CE' | 'PE' | 'FUT';

export interface TriggerLevel {
  instrument: TriggerInstrument;
  op: TriggerOp;
  price: number;
}

const SUFFIX = /\d(CE|PE|FUT)$/;

/** CE / PE / FUT from the tradingsymbol suffix (same rule as market-hub/underlying.ts). */
export function contractKindOf(symbol: string): ContractKind | null {
  const m = SUFFIX.exec(String(symbol ?? '').trim().toUpperCase());
  return m ? (m[1] as ContractKind) : null;
}

/**
 * Ruling R4 (D5): the cross direction that HURTS this position on this
 * instrument. PREMIUM is the contract's own price: a long loses when it falls.
 * UNDERLYING depends on the delta's sign: long CE/FUT and short PE gain when the
 * underlying rises (so BELOW hurts); long PE and short CE/FUT the reverse.
 */
export function adverseOp(instrument: TriggerInstrument, qty: number, kind: ContractKind | null): TriggerOp | null {
  if (!Number.isFinite(qty) || qty === 0) return null;
  const long = qty > 0;
  if (instrument === 'PREMIUM') return long ? 'BELOW' : 'ABOVE';
  if (kind === null) return null;
  const gainsWhenUnderlyingRises = kind === 'PE' ? !long : long;
  return gainsWhenUnderlyingRises ? 'BELOW' : 'ABOVE';
}

const no = (reason: string) => ({ ok: false as const, reason });

/**
 * Spec §3.2, in order. Pure; every input that needs I/O is resolved by the caller.
 * The first failing rule names the REJECTED reason.
 */
export function validateTrigger(i: {
  proposal: TriggerLevel;
  qty: number;
  kind: ContractKind | null;
  current: { price: number; ageMs: number } | null;
  armed: TriggerLevel | null;
  cfg: Pick<TriggerConfig, 'maxDistancePct' | 'tightenOnly'>;
}): { ok: true } | { ok: false; reason: string } {
  const p = i.proposal;
  if (!Number.isFinite(p.price) || p.price <= 0) return no('BAD_PRICE');
  const adverse = adverseOp(p.instrument, i.qty, i.kind);
  if (adverse === null) return no(p.instrument === 'UNDERLYING' ? 'UNKNOWN_CONTRACT_KIND' : 'NO_POSITION');
  if (p.op !== adverse) return no('NOT_PROTECTIVE');
  const c = i.current;
  if (!c || !Number.isFinite(c.price) || c.price <= 0 || c.ageMs > TRIGGER_TIMING.armPriceMaxAgeMs) return no('NO_FRESH_PRICE');
  const notYetCrossed = p.op === 'BELOW' ? p.price < c.price : p.price > c.price;
  if (!notYetCrossed) return no('ALREADY_CROSSED');
  const pct = (Math.abs(c.price - p.price) / c.price) * 100;
  const max = i.cfg.maxDistancePct[p.instrument];
  if (pct > max) return no(`TOO_FAR (${pct.toFixed(2)}% > ${max}%)`);
  if (i.armed && i.cfg.tightenOnly) {
    if (i.armed.instrument !== p.instrument) return no('INSTRUMENT_SWITCH');
    const loosens = p.op === 'BELOW' ? p.price < i.armed.price : p.price > i.armed.price;
    if (loosens) return no('LOOSENS');
  }
  return { ok: true };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && npx jest src/modules/sentinel-executor/domain/trigger-rules.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/sentinel-executor/domain/trigger-rules.ts apps/api/src/modules/sentinel-executor/domain/trigger-rules.spec.ts
git commit -m "feat(sentinel-executor): trigger rules — protective direction by delta, distance, freshness, tighten-only

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Confirmation state machine (Stream B, pure)

**Files:**
- Create: `apps/api/src/modules/sentinel-executor/domain/confirmation.ts`
- Test: `apps/api/src/modules/sentinel-executor/domain/confirmation.spec.ts`

**Interfaces:**
- Consumes: `TriggerOp` (Task 7).
- Produces: `interface ConfirmState { count: number; firstAt: number | null; lastAt: number | null }`, `EMPTY_CONFIRM: ConfirmState`, `stepConfirm(s: ConfirmState, tick: { price: number; at: number }, level: { op: TriggerOp; price: number }, cfg: { ticks: number; ms: number; gapResetMs: number }): { state: ConfirmState; fire: boolean }`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/modules/sentinel-executor/domain/confirmation.spec.ts
import { EMPTY_CONFIRM, stepConfirm, type ConfirmState } from './confirmation';

const CFG = { ticks: 2, ms: 1000, gapResetMs: 5000 };
const BELOW = { op: 'BELOW' as const, price: 8930 };
/** Feed [price, at] ticks; return the fire flags. */
function feed(ticks: Array<[number, number]>, level = BELOW, cfg = CFG): boolean[] {
  let s: ConfirmState = EMPTY_CONFIRM;
  return ticks.map(([price, at]) => {
    const r = stepConfirm(s, { price, at }, level, cfg);
    s = r.state;
    return r.fire;
  });
}

describe('stepConfirm (D2: 2 ticks AND ≥ 1 s)', () => {
  it('one tick beyond never fires (one bad print never sells)', () => {
    expect(feed([[8920, 0]])).toEqual([false]);
  });

  it('two ticks inside 1 s do not fire; the next one beyond after 1 s does', () => {
    expect(feed([[8920, 0], [8921, 300], [8919, 1000]])).toEqual([false, false, true]);
  });

  it('two ticks ≥ 1 s apart fire on the second', () => {
    expect(feed([[8920, 0], [8925, 1200]])).toEqual([false, true]);
  });

  it('touching the level is not crossing it (strict)', () => {
    expect(feed([[8930, 0], [8930, 2000]])).toEqual([false, false]);
  });

  it('flapping resets: beyond, back, beyond — the clock restarts', () => {
    expect(feed([[8920, 0], [8935, 600], [8920, 1100], [8920, 1500], [8920, 2200]])).toEqual([false, false, false, false, true]);
  });

  it('a gap > 5 s between accepted ticks restarts confirmation (feed reconnect)', () => {
    expect(feed([[8920, 0], [8920, 6000]])).toEqual([false, false]);
    expect(feed([[8920, 0], [8920, 6000], [8920, 7100]])).toEqual([false, false, true]);
  });

  it('an out-of-order tick restarts confirmation', () => {
    expect(feed([[8920, 2000], [8920, 1000], [8920, 3000]])).toEqual([false, false, true]);
  });

  it('ABOVE mirrors BELOW', () => {
    expect(feed([[9001, 0], [9002, 1000]], { op: 'ABOVE', price: 9000 })).toEqual([false, true]);
    expect(feed([[8999, 0], [8999, 1000]], { op: 'ABOVE', price: 9000 })).toEqual([false, false]);
  });

  it('confirmTicks 1 with ms 0 fires on the first tick (owner may configure it)', () => {
    expect(feed([[8920, 0]], BELOW, { ticks: 1, ms: 0, gapResetMs: 5000 })).toEqual([true]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx jest src/modules/sentinel-executor/domain/confirmation.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/modules/sentinel-executor/domain/confirmation.ts
import type { TriggerOp } from './trigger.types';

export interface ConfirmState {
  count: number;
  firstAt: number | null;
  lastAt: number | null;
}

export const EMPTY_CONFIRM: ConfirmState = Object.freeze({ count: 0, firstAt: null, lastAt: null }) as ConfirmState;

/**
 * Ruling R6 / spec §3.4 D2. Fire once the level has been crossed on `ticks`
 * consecutive accepted ticks AND for at least `ms` (first beyond-tick → this one).
 * A not-beyond tick, a gap longer than `gapResetMs`, or an out-of-order tick
 * restarts the count. Strict inequality: touching the level is not crossing it.
 * Pure and allocation-light: it runs on every tick of a watched instrument.
 */
export function stepConfirm(
  s: ConfirmState,
  tick: { price: number; at: number },
  level: { op: TriggerOp; price: number },
  cfg: { ticks: number; ms: number; gapResetMs: number },
): { state: ConfirmState; fire: boolean } {
  const beyond = level.op === 'BELOW' ? tick.price < level.price : tick.price > level.price;
  if (!beyond) return { state: EMPTY_CONFIRM, fire: false };
  const continuous = s.lastAt !== null && tick.at >= s.lastAt && tick.at - s.lastAt <= cfg.gapResetMs;
  const count = (continuous ? s.count : 0) + 1;
  const firstAt = continuous && s.firstAt !== null ? s.firstAt : tick.at;
  const state: ConfirmState = { count, firstAt, lastAt: tick.at };
  return { state, fire: count >= cfg.ticks && tick.at - firstAt >= cfg.ms };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && npx jest src/modules/sentinel-executor/domain/confirmation.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/sentinel-executor/domain/confirmation.ts apps/api/src/modules/sentinel-executor/domain/confirmation.spec.ts
git commit -m "feat(sentinel-executor): trigger confirmation — N consecutive ticks for at least M ms, gap and flap resets

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Executor trigger `PRICE_TRIGGER` + ordertag `at` (Stream B, after P1 and P2 are on `main`)

**Files:**
- Modify: `apps/api/src/modules/sentinel-executor/domain/manual-exit.ts` (P1's file: `ExitTrigger`, `triggerOf`)
- Modify: `apps/api/src/modules/sentinel-executor/domain/exit-order.ts` (prefix map, `EXIT_TAG_PREFIXES`)
- Test: `apps/api/src/modules/sentinel-executor/domain/manual-exit.spec.ts`, `domain/exit-order.spec.ts`, `domain/guards.spec.ts`, `services/sentinel-exit-executor.service.spec.ts`, `repositories/ai-exit-execution.repository.spec.ts`

**Interfaces:**
- Consumes (from P1): `type ExitTrigger = 'AI' | 'MANUAL'`, `triggerOf(verdictId)`, `MANUAL_VERDICT_PREFIX = 'man_'`, `aiExitOrderTag(verdictId, leg, trigger = 'AI')`, `EXIT_TAG_PREFIXES`, `SentinelExitExecutor.execute(id, v, aiCfg, now, trigger)`; guards' `const ai = i.trigger !== 'MANUAL'`; `countCountedSince` excluding only `man_`.
- Produces: `ExitTrigger = 'AI' | 'MANUAL' | 'PRICE_TRIGGER'`; `PRICE_TRIGGER_VERDICT_PREFIX = 'trg_'`; `triggerVerdictId(triggerId: string): string`; `triggerIdOf(verdictId: string | null | undefined): string | null`; `PRICE_TRIGGER_TAG_PREFIX = 'at'`.

**Before starting:** `git log --oneline main -5` must show the P1 merge and the P2 merge; `git rebase main`; then read the P1 versions of the five files above. If P1's names differ from those listed under *Consumes*, adapt the snippets below to P1's names — the behaviour required is unchanged.

- [ ] **Step 1: Write the failing tests**

`manual-exit.spec.ts`:

```ts
describe('price-trigger synthetic ids (ruling R13)', () => {
  it('trg_<id> round-trips and is recognised as PRICE_TRIGGER', () => {
    const v = triggerVerdictId('cm9trigger0000000000000001');
    expect(v).toBe('trg_cm9trigger0000000000000001');
    expect(triggerOf(v)).toBe('PRICE_TRIGGER');
    expect(triggerIdOf(v)).toBe('cm9trigger0000000000000001');
    expect(triggerIdOf('man_t1_1')).toBeNull();
    expect(triggerOf('man_t1_1')).toBe('MANUAL');
    expect(triggerOf('cm9verdict')).toBe('AI');
  });
});
```

`exit-order.spec.ts`:

```ts
describe('PRICE_TRIGGER ordertag (ruling R13)', () => {
  it("is 'at' + leg + last 17 alphanumerics, ≤ 20 chars, alphanumeric", () => {
    const tag = aiExitOrderTag('trg_cm9trigger0000000000000001', 'M', 'PRICE_TRIGGER');
    expect(tag.startsWith('atM')).toBe(true);
    expect(tag.length).toBeLessThanOrEqual(20);
    expect(tag).toMatch(/^[A-Za-z0-9]+$/);
  });

  it('an at-tagged live order counts as a prior exit; a rejected one does not', () => {
    const row = (status: string) => ({ symboltoken: '445566', exchange: 'MCX', ordertag: 'atMtrigger0000000001', status });
    expect(hasPriorAiExit([row('complete')], 'MCX', '445566')).toBe(true);
    expect(hasPriorAiExit([row('rejected')], 'MCX', '445566')).toBe(false);
  });
});
```

`guards.spec.ts` (reuse the file's existing base `GuardInput` builder; named `input()` below):

```ts
describe('PRICE_TRIGGER takes every AI guard (ruling R13)', () => {
  const t = { trigger: 'PRICE_TRIGGER' as const };
  it.each([
    ['disabled', { config: { ...input().config, enabled: false } }, 'DISABLED'],
    ['not allow-listed', { verdict: { ...input().verdict, userId: 'stranger' } }, 'NOT_ALLOWED_USER'],
    ['fired 91 s ago', { verdict: { ...input().verdict, createdAt: new Date(input().now.getTime() - 91_000) } }, 'STALE_VERDICT'],
    ['cap reached', { countedToday: input().config.dailyCap }, 'DAILY_CAP'],
  ])('%s → %s', (_l, over, reason) => {
    expect(evaluateGuards({ ...input(), ...over, ...t } as never)).toEqual({ ok: false, reason });
  });
});
```

`sentinel-exit-executor.service.spec.ts` (new describe at the end; uses the file's `harness`, `env`, `posRow`, `LIVE`, `DRY_MCX_UNITS`, `V`, `NOW`):

```ts
describe('SentinelExitExecutor — PRICE_TRIGGER (sentinel price triggers)', () => {
  const TV: PendingVerdict = {
    id: 'trg_cm9trigger0000000000000001', userId: 'owner', trackerId: 't1',
    symbol: 'CRUDEOIL15OCT268950CE', reason: 'PRICE_TRIGGER: CRUDEOIL19NOV26FUT < 8930 — fired at 8927', createdAt: NOW,
  };

  it('live: exactly one MARKET with the at-tag, then FILLED', async () => {
    const h = harness({ positions: [env([posRow('100')]), env([posRow('0')])] });
    await expect(h.ex.execute('row1', TV, LIVE, NOW, 'PRICE_TRIGGER')).resolves.toEqual({ status: 'FILLED' });
    expect(h.session.placeOrderClassified).toHaveBeenCalledTimes(1);
    expect(h.session.placeOrderClassified.mock.calls[0][1]).toBe(aiExitOrderTag(TV.id, 'M', 'PRICE_TRIGGER'));
  });

  it('follows AI_AUTO_EXIT_MODE: dry-run records the order and sends nothing', async () => {
    const h = harness();
    const r = await h.ex.execute('row1', TV, DRY_MCX_UNITS, NOW, 'PRICE_TRIGGER');
    expect(r.status).toBe('DRY_RUN');
    expect(h.session.placeOrderClassified).not.toHaveBeenCalled();
  });

  it('counts toward (and is stopped by) the AI daily cap', async () => {
    const h = harness({ counted: LIVE.dailyCap });
    await expect(h.ex.execute('row1', TV, LIVE, NOW, 'PRICE_TRIGGER')).resolves.toEqual({ status: 'SKIPPED', reason: 'DAILY_CAP' });
    expect(h.repo.countCountedSince).toHaveBeenCalled();
  });

  it("a resting order (the owner's broker SL) → SKIPPED: OPEN_ORDER_EXISTS, like an AI verdict (cancel-protective off)", async () => {
    const h = harness({ books: [env([{ symboltoken: '445566', exchange: 'MCX', status: 'trigger pending', ordertag: '' }])] });
    await expect(h.ex.execute('row1', TV, LIVE, NOW, 'PRICE_TRIGGER')).resolves.toEqual({ status: 'SKIPPED', reason: 'OPEN_ORDER_EXISTS' });
  });

  it('an at-tagged exit already in the book blocks a later AI verdict on the contract', async () => {
    const h = harness({ books: [env([{ symboltoken: '445566', exchange: 'MCX', status: 'complete', ordertag: 'atMtrigger0000000001' }])] });
    await expect(h.ex.process(V, LIVE, NOW)).resolves.toEqual({ status: 'SKIPPED', reason: 'PRIOR_AI_EXIT_TODAY' });
  });
});
```

P2 compatibility: for every P2 test in this spec whose title mentions `CANCEL_PROTECTIVE`, add a copy in this describe that calls `h.ex.execute('row1', TV, <same cfg>, NOW, 'PRICE_TRIGGER')` instead of `h.ex.process(V, <same cfg>, NOW)`, with the SAME expectations (a trigger fire takes exactly the AI branch).

`ai-exit-execution.repository.spec.ts`:

```ts
  it('price-trigger rows count toward the AI cap (only man_ is excluded)', async () => {
    const count = jest.fn().mockResolvedValue(0);
    const repo = new AiExitExecutionRepository({ aiExitExecution: { count } } as never);
    await repo.countCountedSince('owner', new Date(0), 'live');
    const where = count.mock.calls[0][0].where;
    expect(JSON.stringify(where)).not.toContain('trg_');
    expect(where.NOT).toEqual({ verdictId: { startsWith: 'man_' } });
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx jest src/modules/sentinel-executor`
Expected: FAIL — `triggerVerdictId` not exported; `'PRICE_TRIGGER'` not assignable to `ExitTrigger`.

- [ ] **Step 3: Implement**

`manual-exit.ts`:

```ts
export type ExitTrigger = 'AI' | 'MANUAL' | 'PRICE_TRIGGER';

/** Synthetic verdictId of a price-trigger fire: `trg_<sentinel_exit_triggers.id>` (price-triggers plan R13). */
export const PRICE_TRIGGER_VERDICT_PREFIX = 'trg_';

export function triggerVerdictId(triggerId: string): string {
  return `${PRICE_TRIGGER_VERDICT_PREFIX}${triggerId}`;
}

export function triggerIdOf(verdictId: string | null | undefined): string | null {
  const v = String(verdictId ?? '');
  return v.startsWith(PRICE_TRIGGER_VERDICT_PREFIX) ? v.slice(PRICE_TRIGGER_VERDICT_PREFIX.length) : null;
}

export function triggerOf(verdictId: string | null | undefined): ExitTrigger {
  if (isManualVerdictId(verdictId)) return 'MANUAL';
  return triggerIdOf(verdictId) !== null ? 'PRICE_TRIGGER' : 'AI';
}
```

`exit-order.ts`:

```ts
/** Prefix of a price-trigger fire's ordertags (price-triggers plan R13). */
export const PRICE_TRIGGER_TAG_PREFIX = 'at';
const EXIT_TAG_PREFIXES = [AI_EXIT_TAG_PREFIX, MANUAL_EXIT_TAG_PREFIX, PRICE_TRIGGER_TAG_PREFIX];
const TAG_PREFIX: Record<ExitTrigger, string> = {
  AI: AI_EXIT_TAG_PREFIX,
  MANUAL: MANUAL_EXIT_TAG_PREFIX,
  PRICE_TRIGGER: PRICE_TRIGGER_TAG_PREFIX,
};

export function aiExitOrderTag(verdictId: string, leg: 'M' | 'L', trigger: ExitTrigger = 'AI'): string {
  const clean = String(verdictId).replace(/[^A-Za-z0-9]/g, '');
  return `${TAG_PREFIX[trigger]}${leg}${clean.slice(-17)}`;
}
```

`guards.ts`, the executor and the repository need NO change: P1's `ai = i.trigger !== 'MANUAL'`, `trigger === 'MANUAL' ? live : aiCfg` and the `man_`-only cap exclusion already put `PRICE_TRIGGER` on the AI branch — the tests above pin that. Update the doc comment above `evaluateGuards`'s `trigger` field to read: "'AI' (default) and 'PRICE_TRIGGER' (a pre-agreed sentinel level crossed): every guard. 'MANUAL': …".

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && npx jest src/modules/sentinel-executor`
Expected: PASS (all existing AI and MANUAL tests unchanged).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/sentinel-executor/domain/manual-exit.ts apps/api/src/modules/sentinel-executor/domain/manual-exit.spec.ts apps/api/src/modules/sentinel-executor/domain/exit-order.ts apps/api/src/modules/sentinel-executor/domain/exit-order.spec.ts apps/api/src/modules/sentinel-executor/domain/guards.ts apps/api/src/modules/sentinel-executor/domain/guards.spec.ts apps/api/src/modules/sentinel-executor/services/sentinel-exit-executor.service.spec.ts apps/api/src/modules/sentinel-executor/repositories/ai-exit-execution.repository.spec.ts
git commit -m "feat(sentinel-executor): PRICE_TRIGGER exits — trg_ synthetic verdicts, at ordertags, AI guards and cap

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: Stored-proposal reader + trigger repository (Stream B, after Task 1)

**Files:**
- Create: `apps/api/src/modules/sentinel-executor/domain/stored-trigger.ts`
- Create: `apps/api/src/modules/sentinel-executor/repositories/sentinel-exit-trigger.repository.ts`
- Test: `apps/api/src/modules/sentinel-executor/domain/stored-trigger.spec.ts`, `apps/api/src/modules/sentinel-executor/repositories/sentinel-exit-trigger.repository.spec.ts`

**Interfaces:**
- Consumes: Task 1 model; `TriggerInstrument`, `TriggerOp`, `WatchRef` (Task 7).
- Produces:
  - `parseStoredTrigger(json: unknown): { kind: 'trigger'; trigger: { instrument; op; price; watch: WatchRef | null } } | { kind: 'problem'; problem: string }`
  - `interface ProposalRow { id: string; userId: string; trackerId: string; symbol: string; verdict: string; exitTrigger: unknown; createdAt: Date }`
  - `interface TrackerLite { id; userId; symbol; exchange; token; qty: number; status; kind }`
  - `interface TriggerFields { instrument?; op?; price?; watchExchange?; watchToken?; watchSymbol?; refPrice? }`
  - `SentinelExitTriggerRepository` with: `pendingProposals(userIds: string[], since: Date, limit: number): Promise<ProposalRow[]>`, `trackerFor(id: string): Promise<TrackerLite | null>`, `reject(p: ProposalRow, f: TriggerFields, reason: string): Promise<boolean>`, `arm(p: ProposalRow, f: Required<TriggerFields>, now: Date): Promise<{ id: string; superseded: string[] } | null>`, `claimFire(id: string, tick: { price: number; at: Date }, now: Date): Promise<boolean>`, `expire(ids: string[], reason: string, now: Date): Promise<number>`, `loadArmed(userIds: string[]): Promise<SentinelExitTrigger[]>`, `trackerExchanges(ids: string[]): Promise<Map<string, string>>`, `closedTrackerIds(ids: string[]): Promise<string[]>`, `listForUser(userId: string, limit: number): Promise<SentinelExitTrigger[]>`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/modules/sentinel-executor/domain/stored-trigger.spec.ts
import { parseStoredTrigger } from './stored-trigger';

/** Byte-identical to trade-sentinel's STORED_TRIGGER_FIXTURE (ruling R17 — keep the two in sync). */
const STORED_TRIGGER_FIXTURE = {
  v: 1,
  instrument: 'UNDERLYING',
  op: 'BELOW',
  price: 8930,
  watch: { exchange: 'MCX', token: '472789', symbol: 'CRUDEOIL19NOV26FUT' },
  seen: { price: 8951, at: '2026-10-13T16:59:58.000Z' },
};

describe('parseStoredTrigger (wire contract with trade-sentinel)', () => {
  it('reads the contract fixture', () => {
    expect(parseStoredTrigger(STORED_TRIGGER_FIXTURE)).toEqual({
      kind: 'trigger',
      trigger: { instrument: 'UNDERLYING', op: 'BELOW', price: 8930, watch: { exchange: 'MCX', token: '472789', symbol: 'CRUDEOIL19NOV26FUT' } },
    });
  });

  it('PREMIUM with watch null', () => {
    expect(parseStoredTrigger({ v: 1, instrument: 'PREMIUM', op: 'BELOW', price: 180, watch: null })).toMatchObject({
      kind: 'trigger', trigger: { watch: null },
    });
  });

  it('carries the sentinel-side problem through', () => {
    expect(parseStoredTrigger({ v: 1, problem: 'price is not a positive number' })).toEqual({ kind: 'problem', problem: 'price is not a positive number' });
  });

  it.each([
    [null], ['x'], [[1]], [{ v: 2, instrument: 'PREMIUM', op: 'BELOW', price: 1 }],
    [{ v: 1, instrument: 'SPOT', op: 'BELOW', price: 1 }], [{ v: 1, instrument: 'PREMIUM', op: 'DOWN', price: 1 }],
    [{ v: 1, instrument: 'PREMIUM', op: 'BELOW', price: -1 }], [{ v: 1, instrument: 'UNDERLYING', op: 'BELOW', price: 1, watch: { token: 5 } }],
  ])('%j is a problem, never a throw', (json) => {
    expect(parseStoredTrigger(json).kind).toBe('problem');
  });
});
```

```ts
// apps/api/src/modules/sentinel-executor/repositories/sentinel-exit-trigger.repository.spec.ts
import { Prisma } from '@prisma/client';
import { SentinelExitTriggerRepository, type ProposalRow } from './sentinel-exit-trigger.repository';

const P: ProposalRow = { id: 'v1', userId: 'owner', trackerId: 't1', symbol: 'CRUDEOIL19NOV268950CE', verdict: 'HOLD', exitTrigger: {}, createdAt: new Date(0) };
const NOW = new Date('2026-10-13T17:00:00Z');
const p2002 = () => new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'x' });

describe('SentinelExitTriggerRepository', () => {
  it('the arming query: HOLD/EXIT_ARMED with a non-null exitTrigger and no trigger row yet (null never disarms)', async () => {
    const $queryRaw = jest.fn().mockResolvedValue([]);
    const repo = new SentinelExitTriggerRepository({ $queryRaw } as never);
    await repo.pendingProposals(['owner'], NOW, 10);
    const sql = ($queryRaw.mock.calls[0][0] as Prisma.Sql).sql;
    expect(sql).toMatch(/"verdict" IN \('HOLD', 'EXIT_ARMED'\)/);
    expect(sql).toMatch(/"exitTrigger" IS NOT NULL/);
    expect(sql).toMatch(/NOT EXISTS \(SELECT 1 FROM "sentinel_exit_triggers" t WHERE t\."verdictId" = v\."id"\)/);
    expect(await repo.pendingProposals([], NOW, 10)).toEqual([]);
    expect($queryRaw).toHaveBeenCalledTimes(1);
  });

  it('reject: one REJECTED row; a duplicate verdict is false, not a throw', async () => {
    const create = jest.fn().mockResolvedValueOnce({}).mockRejectedValueOnce(p2002());
    const repo = new SentinelExitTriggerRepository({ sentinelExitTrigger: { create } } as never);
    await expect(repo.reject(P, { instrument: 'PREMIUM' }, 'NOT_PROTECTIVE')).resolves.toBe(true);
    expect(create.mock.calls[0][0].data).toMatchObject({ verdictId: 'v1', status: 'REJECTED', reason: 'NOT_PROTECTIVE', instrument: 'PREMIUM' });
    await expect(repo.reject(P, {}, 'X')).resolves.toBe(false);
  });

  it('arm: supersedes the tracker’s ARMED row and inserts the new one in ONE transaction', async () => {
    const tx = {
      sentinelExitTrigger: {
        findMany: jest.fn().mockResolvedValue([{ id: 'old' }]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        create: jest.fn().mockResolvedValue({ id: 'new' }),
      },
    };
    const $transaction = jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx));
    const repo = new SentinelExitTriggerRepository({ $transaction } as never);
    const f = { instrument: 'UNDERLYING', op: 'BELOW', price: 8930, watchExchange: 'MCX', watchToken: '472789', watchSymbol: 'F', refPrice: 8951 } as const;
    await expect(repo.arm(P, f, NOW)).resolves.toEqual({ id: 'new', superseded: ['old'] });
    expect(tx.sentinelExitTrigger.updateMany.mock.calls[0][0]).toEqual({
      where: { id: { in: ['old'] }, status: 'ARMED' },
      data: { status: 'SUPERSEDED', endedAt: NOW, reason: 'SUPERSEDED_BY:v1' },
    });
    expect(tx.sentinelExitTrigger.create.mock.calls[0][0].data).toMatchObject({ ...f, status: 'ARMED', armedAt: NOW, verdictId: 'v1' });
  });

  it('arm: a unique violation (verdict handled, or a second ARMED row raced in) is null', async () => {
    const $transaction = jest.fn().mockRejectedValue(p2002());
    const repo = new SentinelExitTriggerRepository({ $transaction } as never);
    await expect(repo.arm(P, {} as never, NOW)).resolves.toBeNull();
  });

  it('claimFire is the conditional ARMED → FIRED update (R7 layer 2)', async () => {
    const updateMany = jest.fn().mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    const repo = new SentinelExitTriggerRepository({ sentinelExitTrigger: { updateMany } } as never);
    const tick = { price: 8927.5, at: new Date(NOW.getTime() - 100) };
    await expect(repo.claimFire('trg1', tick, NOW)).resolves.toBe(true);
    await expect(repo.claimFire('trg1', tick, NOW)).resolves.toBe(false);
    expect(updateMany.mock.calls[0][0]).toEqual({
      where: { id: 'trg1', status: 'ARMED' },
      data: { status: 'FIRED', firedAt: NOW, firedPrice: 8927.5, firedTickAt: tick.at },
    });
  });

  it('expire only touches ARMED rows; nothing to expire = no query', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 2 });
    const repo = new SentinelExitTriggerRepository({ sentinelExitTrigger: { updateMany } } as never);
    await expect(repo.expire([], 'MAX_AGE', NOW)).resolves.toBe(0);
    expect(updateMany).not.toHaveBeenCalled();
    await repo.expire(['a', 'b'], 'MAX_AGE', NOW);
    expect(updateMany.mock.calls[0][0]).toEqual({
      where: { id: { in: ['a', 'b'] }, status: 'ARMED' },
      data: { status: 'EXPIRED', endedAt: NOW, reason: 'MAX_AGE' },
    });
  });

  it('trackerExchanges: the POSITION exchange by tracker id, upper-cased; nothing asked = no query', async () => {
    const findMany = jest.fn().mockResolvedValue([{ id: 't1', exchange: 'nfo' }]);
    const repo = new SentinelExitTriggerRepository({ tradeTracker: { findMany } } as never);
    await expect(repo.trackerExchanges(['t1'])).resolves.toEqual(new Map([['t1', 'NFO']]));
    await expect(repo.trackerExchanges([])).resolves.toEqual(new Map());
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it('closedTrackerIds: not OPEN, or gone', async () => {
    const findMany = jest.fn().mockResolvedValue([{ id: 't1', status: 'OPEN' }, { id: 't2', status: 'CLOSED' }]);
    const repo = new SentinelExitTriggerRepository({ tradeTracker: { findMany } } as never);
    await expect(repo.closedTrackerIds(['t1', 't2', 't3'])).resolves.toEqual(['t2', 't3']);
    await expect(repo.closedTrackerIds([])).resolves.toEqual([]);
    expect(findMany).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx jest src/modules/sentinel-executor/domain/stored-trigger.spec.ts src/modules/sentinel-executor/repositories/sentinel-exit-trigger.repository.spec.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/modules/sentinel-executor/domain/stored-trigger.ts
import type { TriggerInstrument, TriggerOp, WatchRef } from './trigger.types';

/**
 * READER of sentinel_verdicts.exitTrigger. WIRE CONTRACT with
 * trade-sentinel/services/exit-trigger-proposal.ts (ruling R17): declared on both
 * sides because the modules may not import each other; both specs pin the same
 * fixture. Never throws — a bad row becomes a REJECTED trigger with a reason.
 */
export type StoredTrigger =
  | { kind: 'trigger'; trigger: { instrument: TriggerInstrument; op: TriggerOp; price: number; watch: WatchRef | null } }
  | { kind: 'problem'; problem: string };

const problem = (p: string): StoredTrigger => ({ kind: 'problem', problem: p });

export function parseStoredTrigger(json: unknown): StoredTrigger {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) return problem('stored exitTrigger is not an object');
  const o = json as Record<string, unknown>;
  if (o.v !== 1) return problem(`stored exitTrigger version ${JSON.stringify(o.v)} is not 1`);
  if (typeof o.problem === 'string') return problem(o.problem);
  if (o.instrument !== 'UNDERLYING' && o.instrument !== 'PREMIUM') return problem(`instrument ${JSON.stringify(o.instrument)}`);
  if (o.op !== 'BELOW' && o.op !== 'ABOVE') return problem(`op ${JSON.stringify(o.op)}`);
  if (typeof o.price !== 'number' || !Number.isFinite(o.price) || o.price <= 0) return problem(`price ${JSON.stringify(o.price)}`);
  let watch: WatchRef | null = null;
  if (o.watch !== null && o.watch !== undefined) {
    const w = o.watch as Record<string, unknown>;
    if (typeof w !== 'object' || typeof w.exchange !== 'string' || typeof w.token !== 'string' || typeof w.symbol !== 'string') {
      return problem('watch is malformed');
    }
    watch = { exchange: w.exchange, token: w.token, symbol: w.symbol };
  }
  return { kind: 'trigger', trigger: { instrument: o.instrument, op: o.op, price: o.price, watch } };
}
```

```ts
// apps/api/src/modules/sentinel-executor/repositories/sentinel-exit-trigger.repository.ts
import { Injectable } from '@nestjs/common';
import { Prisma, type SentinelExitTrigger } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { TriggerInstrument, TriggerOp } from '../domain/trigger.types';

export interface ProposalRow {
  id: string;
  userId: string;
  trackerId: string;
  symbol: string;
  verdict: string;
  exitTrigger: unknown;
  createdAt: Date;
}

export interface TrackerLite {
  id: string;
  userId: string;
  symbol: string;
  exchange: string;
  token: string;
  qty: number;
  status: string;
  kind: string;
}

export interface TriggerFields {
  instrument?: TriggerInstrument;
  op?: TriggerOp;
  price?: number;
  watchExchange?: string;
  watchToken?: string;
  watchSymbol?: string;
  refPrice?: number;
}

const isUnique = (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

@Injectable()
export class SentinelExitTriggerRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * THE 5-SECOND ARMING QUERY (ruling R15). Served by sentinel_verdicts(userId,
   * createdAt) and the unique sentinel_exit_triggers(verdictId). A verdict with a
   * NULL exitTrigger is never returned — which is why null never disarms (R5).
   */
  pendingProposals(userIds: string[], since: Date, limit: number): Promise<ProposalRow[]> {
    if (userIds.length === 0) return Promise.resolve([]);
    return this.prisma.$queryRaw<ProposalRow[]>(Prisma.sql`
      SELECT v."id", v."userId", v."trackerId", v."symbol", v."verdict", v."exitTrigger", v."createdAt"
      FROM "sentinel_verdicts" v
      WHERE v."userId" IN (${Prisma.join(userIds)})
        AND v."createdAt" >= ${since}
        AND v."verdict" IN ('HOLD', 'EXIT_ARMED')
        AND v."exitTrigger" IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM "sentinel_exit_triggers" t WHERE t."verdictId" = v."id")
      ORDER BY v."createdAt" ASC
      LIMIT ${limit}`);
  }

  trackerFor(id: string): Promise<TrackerLite | null> {
    return this.prisma.tradeTracker.findUnique({
      where: { id },
      select: { id: true, userId: true, symbol: true, exchange: true, token: true, qty: true, status: true, kind: true },
    }) as Promise<TrackerLite | null>;
  }

  /** One REJECTED row per proposal. false = the verdict was already handled. */
  async reject(p: ProposalRow, f: TriggerFields, reason: string): Promise<boolean> {
    try {
      await this.prisma.sentinelExitTrigger.create({
        data: { userId: p.userId, trackerId: p.trackerId, verdictId: p.id, symbol: p.symbol, status: 'REJECTED', reason, ...f },
      });
      return true;
    } catch (err) {
      if (isUnique(err)) return false;
      throw err;
    }
  }

  /** Supersede + insert, atomically. null = lost a unique race (retried next pass, or already handled). */
  async arm(p: ProposalRow, f: Required<TriggerFields>, now: Date): Promise<{ id: string; superseded: string[] } | null> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const old = await tx.sentinelExitTrigger.findMany({ where: { trackerId: p.trackerId, status: 'ARMED' }, select: { id: true } });
        const superseded = old.map((o) => o.id);
        if (superseded.length > 0) {
          await tx.sentinelExitTrigger.updateMany({
            where: { id: { in: superseded }, status: 'ARMED' },
            data: { status: 'SUPERSEDED', endedAt: now, reason: `SUPERSEDED_BY:${p.id}` },
          });
        }
        const row = await tx.sentinelExitTrigger.create({
          data: { userId: p.userId, trackerId: p.trackerId, verdictId: p.id, symbol: p.symbol, status: 'ARMED', armedAt: now, ...f },
          select: { id: true },
        });
        return { id: row.id, superseded };
      });
    } catch (err) {
      if (isUnique(err)) return null;
      throw err;
    }
  }

  /** Ruling R7 layer 2: exactly one caller can move a trigger ARMED → FIRED. */
  async claimFire(id: string, tick: { price: number; at: Date }, now: Date): Promise<boolean> {
    const r = await this.prisma.sentinelExitTrigger.updateMany({
      where: { id, status: 'ARMED' },
      data: { status: 'FIRED', firedAt: now, firedPrice: tick.price, firedTickAt: tick.at },
    });
    return r.count === 1;
  }

  async expire(ids: string[], reason: string, now: Date): Promise<number> {
    if (ids.length === 0) return 0;
    const r = await this.prisma.sentinelExitTrigger.updateMany({
      where: { id: { in: ids }, status: 'ARMED' },
      data: { status: 'EXPIRED', endedAt: now, reason },
    });
    return r.count;
  }

  loadArmed(userIds: string[]): Promise<SentinelExitTrigger[]> {
    if (userIds.length === 0) return Promise.resolve([]);
    return this.prisma.sentinelExitTrigger.findMany({ where: { status: 'ARMED', userId: { in: userIds } } });
  }

  /** tracker id → its exchange (upper-cased). One PK query; used by the boot rebuild. */
  async trackerExchanges(ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await this.prisma.tradeTracker.findMany({ where: { id: { in: ids } }, select: { id: true, exchange: true } });
    return new Map(rows.map((r) => [r.id, String(r.exchange ?? '').toUpperCase()]));
  }

  /** Trackers among `ids` that are no longer OPEN, or no longer exist. One PK query. */
  async closedTrackerIds(ids: string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const rows = await this.prisma.tradeTracker.findMany({ where: { id: { in: ids } }, select: { id: true, status: true } });
    const open = new Set(rows.filter((r) => r.status === 'OPEN').map((r) => r.id));
    return ids.filter((id) => !open.has(id));
  }

  /** ARMED first, then the newest `limit` rows — the caller's own only. */
  async listForUser(userId: string, limit: number): Promise<SentinelExitTrigger[]> {
    const [armed, recent] = await Promise.all([
      this.prisma.sentinelExitTrigger.findMany({ where: { userId, status: 'ARMED' }, orderBy: { armedAt: 'desc' } }),
      this.prisma.sentinelExitTrigger.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: limit }),
    ]);
    const seen = new Set(armed.map((r) => r.id));
    return [...armed, ...recent.filter((r) => !seen.has(r.id))];
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && npx jest src/modules/sentinel-executor/domain/stored-trigger.spec.ts src/modules/sentinel-executor/repositories/sentinel-exit-trigger.repository.spec.ts && npx tsc --noEmit -p tsconfig.json`
Expected: PASS; tsc exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/sentinel-executor/domain/stored-trigger.ts apps/api/src/modules/sentinel-executor/domain/stored-trigger.spec.ts apps/api/src/modules/sentinel-executor/repositories/sentinel-exit-trigger.repository.ts apps/api/src/modules/sentinel-executor/repositories/sentinel-exit-trigger.repository.spec.ts
git commit -m "feat(sentinel-executor): read stored exitTrigger proposals; trigger repository (arm, reject, claim fire, expire)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: `TriggerBook` — the in-memory ARMED set and THE tick path (Stream B, pure)

**Files:**
- Create: `apps/api/src/modules/sentinel-executor/domain/trigger-book.ts`
- Test: `apps/api/src/modules/sentinel-executor/domain/trigger-book.spec.ts`

**Interfaces:**
- Consumes: `stepConfirm`, `EMPTY_CONFIRM`, `ConfirmState` (Task 9); `TRIGGER_TIMING`, types (Task 7).
- Produces:
  - `interface ArmedTrigger { id; userId; trackerId; symbol; verdictId; instrument: TriggerInstrument; op: TriggerOp; price: number; watch: { key: string; exchange: string; token: string; symbol: string }; trackerExchange: string; armedAt: number; confirm: ConfirmState }`
  - `interface BookTick { key: string; exchange: string; ltp: number; at: number; source: string }`
  - `interface Fire { trigger: ArmedTrigger; tick: { price: number; at: number; count: number; heldMs: number } }`
  - `class TriggerBook { constructor(cfg: { ticks: number; ms: number }, isOpen: (exchange: string, at: Date) => boolean); add(t): ArmedTrigger | null; remove(id): ArmedTrigger | null; get(id); byTracker(trackerId); all(): ArmedTrigger[]; hasKey(key): boolean; lastSeen(key): number | undefined; size(): number; onTick(t: BookTick, now: number): Fire[] }`

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/modules/sentinel-executor/domain/trigger-book.spec.ts
import { EMPTY_CONFIRM } from './confirmation';
import { TriggerBook, type ArmedTrigger } from './trigger-book';

const T0 = 1_760_000_000_000;
const KEY = 'MCX:472789';
const trig = (over: Partial<ArmedTrigger> = {}): ArmedTrigger => ({
  id: 'trg1', userId: 'owner', trackerId: 't1', symbol: 'CRUDEOIL19NOV268950CE', verdictId: 'v1',
  instrument: 'UNDERLYING', op: 'BELOW', price: 8930,
  watch: { key: KEY, exchange: 'MCX', token: '472789', symbol: 'CRUDEOIL19NOV26FUT' },
  trackerExchange: 'MCX', armedAt: T0, confirm: EMPTY_CONFIRM, ...over,
});
const tick = (ltp: number, at: number, source = 'ws', key = KEY) => ({ key, exchange: 'MCX', ltp, at, source });

function book(open = true) {
  const isOpen = jest.fn(() => open);
  return { b: new TriggerBook({ ticks: 2, ms: 1000 }, isOpen), isOpen };
}

describe('TriggerBook', () => {
  it('a confirmed cross fires ONCE and removes the trigger before returning (R7 layer 1)', () => {
    const { b } = book();
    b.add(trig());
    expect(b.onTick(tick(8920, T0), T0)).toEqual([]);
    const fires = b.onTick(tick(8919, T0 + 1100), T0 + 1100);
    expect(fires).toHaveLength(1);
    expect(fires[0].tick).toEqual({ price: 8919, at: T0 + 1100, count: 2, heldMs: 1100 });
    expect(b.size()).toBe(0);
    expect(b.onTick(tick(8918, T0 + 1200), T0 + 1200)).toEqual([]);   // the concurrent next tick
  });

  it('a tick for an unwatched key does nothing (and touches no state)', () => {
    const { b, isOpen } = book();
    b.add(trig());
    expect(b.onTick(tick(1, T0, 'ws', 'NSE:26000'), T0)).toEqual([]);
    expect(isOpen).not.toHaveBeenCalled();
  });

  it.each([
    ['a db-sourced price', tick(8920, T0 + 1100, 'db')],
    ['a zero price', tick(0, T0 + 1100)],
    ['a NaN price', tick(Number.NaN, T0 + 1100)],
    ['a tick received 6 s ago', tick(8920, T0 + 1100 - 6000)],
    ['a tick stamped 6 s in the future', tick(8920, T0 + 1100 + 6000)],
  ])('bad ticks are ignored and leave confirmation untouched: %s', (_l, bad) => {
    const { b } = book();
    b.add(trig());
    b.onTick(tick(8920, T0), T0);
    expect(b.onTick(bad, T0 + 1100)).toEqual([]);
    expect(b.get('trg1')?.confirm.count).toBe(1);
  });

  it('ticks while the exchange is closed never fire', () => {
    const { b } = book(false);
    b.add(trig());
    b.onTick(tick(8920, T0), T0);
    expect(b.onTick(tick(8920, T0 + 2000), T0 + 2000)).toEqual([]);
    expect(b.size()).toBe(1);
  });

  it('a critical-lane quote counts like a live tick (slot exhaustion still fires, R9)', () => {
    const { b } = book();
    b.add(trig());
    b.onTick(tick(8920, T0, 'quote'), T0);
    expect(b.onTick(tick(8920, T0 + 2000, 'quote'), T0 + 2000)).toHaveLength(1);
  });

  it('one armed trigger per tracker: add replaces and returns the old one', () => {
    const { b } = book();
    b.add(trig());
    const replaced = b.add(trig({ id: 'trg2', price: 8940 }));
    expect(replaced?.id).toBe('trg1');
    expect(b.byTracker('t1')?.id).toBe('trg2');
    expect(b.size()).toBe(1);
  });

  it('remove drops the key when its last trigger goes; lastSeen tracks accepted ticks only', () => {
    const { b } = book();
    b.add(trig());
    b.onTick(tick(8950, T0), T0);
    expect(b.lastSeen(KEY)).toBe(T0);
    b.remove('trg1');
    expect(b.hasKey(KEY)).toBe(false);
    expect(b.lastSeen(KEY)).toBeUndefined();
  });

  it('two trackers on one key are judged independently', () => {
    const { b } = book();
    b.add(trig());
    b.add(trig({ id: 'trg2', trackerId: 't2', price: 8900 }));
    b.onTick(tick(8920, T0), T0);
    const fires = b.onTick(tick(8920, T0 + 1000), T0 + 1000);
    expect(fires.map((f) => f.trigger.id)).toEqual(['trg1']);
    expect(b.byTracker('t2')?.id).toBe('trg2');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx jest src/modules/sentinel-executor/domain/trigger-book.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/modules/sentinel-executor/domain/trigger-book.ts
import { EMPTY_CONFIRM, stepConfirm, type ConfirmState } from './confirmation';
import { TRIGGER_TIMING, type TriggerInstrument, type TriggerOp } from './trigger.types';

export interface ArmedTrigger {
  id: string;
  userId: string;
  trackerId: string;
  symbol: string;
  verdictId: string;
  instrument: TriggerInstrument;
  op: TriggerOp;
  price: number;
  watch: { key: string; exchange: string; token: string; symbol: string };
  /** The POSITION's exchange — what expiry at close is judged on. */
  trackerExchange: string;
  armedAt: number;
  confirm: ConfirmState;
}

export interface BookTick {
  key: string;
  exchange: string;
  ltp: number;
  /** Receipt time (hub Price.at), ms epoch. */
  at: number;
  source: string;
}

export interface Fire {
  trigger: ArmedTrigger;
  tick: { price: number; at: number; count: number; heldMs: number };
}

const NONE: Fire[] = [];

/**
 * The ARMED triggers, in memory, keyed by EXCHANGE:token. `onTick` is THE tick
 * path: synchronous, no I/O, O(triggers on this key) — 0 for almost every tick,
 * 1 in practice otherwise. A firing trigger is removed before `onTick` returns
 * (ruling R7 layer 1), so no later tick in this process can fire it again.
 */
export class TriggerBook {
  private readonly byKey = new Map<string, Map<string, ArmedTrigger>>();
  private readonly byId = new Map<string, ArmedTrigger>();
  private readonly trackerToId = new Map<string, string>();
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly cfg: { ticks: number; ms: number },
    private readonly isOpen: (exchange: string, at: Date) => boolean,
  ) {}

  /** Arm `t` (fresh confirmation). Returns the trigger it replaced on the same tracker, if any. */
  add(t: ArmedTrigger): ArmedTrigger | null {
    const prev = this.byTracker(t.trackerId);
    if (prev) this.remove(prev.id);
    const armed = { ...t, confirm: EMPTY_CONFIRM };
    this.byId.set(armed.id, armed);
    this.trackerToId.set(armed.trackerId, armed.id);
    let bucket = this.byKey.get(armed.watch.key);
    if (!bucket) {
      bucket = new Map();
      this.byKey.set(armed.watch.key, bucket);
    }
    bucket.set(armed.id, armed);
    return prev ?? null;
  }

  remove(id: string): ArmedTrigger | null {
    const t = this.byId.get(id);
    if (!t) return null;
    this.byId.delete(id);
    if (this.trackerToId.get(t.trackerId) === id) this.trackerToId.delete(t.trackerId);
    const bucket = this.byKey.get(t.watch.key);
    bucket?.delete(id);
    if (bucket && bucket.size === 0) {
      this.byKey.delete(t.watch.key);
      this.seen.delete(t.watch.key);
    }
    return t;
  }

  get(id: string): ArmedTrigger | undefined {
    return this.byId.get(id);
  }

  byTracker(trackerId: string): ArmedTrigger | undefined {
    const id = this.trackerToId.get(trackerId);
    return id === undefined ? undefined : this.byId.get(id);
  }

  all(): ArmedTrigger[] {
    return [...this.byId.values()];
  }

  hasKey(key: string): boolean {
    return this.byKey.has(key);
  }

  lastSeen(key: string): number | undefined {
    return this.seen.get(key);
  }

  size(): number {
    return this.byId.size;
  }

  onTick(t: BookTick, now: number): Fire[] {
    const bucket = this.byKey.get(t.key);
    if (bucket === undefined) return NONE;
    if (t.source === 'db' || !Number.isFinite(t.ltp) || t.ltp <= 0) return NONE;
    if (Math.abs(now - t.at) > TRIGGER_TIMING.tickMaxAgeMs) return NONE;
    if (!this.isOpen(t.exchange, new Date(t.at))) return NONE;
    this.seen.set(t.key, t.at);
    let fires: Fire[] | null = null;
    for (const trig of bucket.values()) {
      const r = stepConfirm(trig.confirm, { price: t.ltp, at: t.at }, trig, {
        ticks: this.cfg.ticks, ms: this.cfg.ms, gapResetMs: TRIGGER_TIMING.tickGapResetMs,
      });
      trig.confirm = r.state;
      if (r.fire) {
        (fires ??= []).push({
          trigger: trig,
          tick: { price: t.ltp, at: t.at, count: r.state.count, heldMs: t.at - (r.state.firstAt ?? t.at) },
        });
      }
    }
    if (fires === null) return NONE;
    for (const f of fires) this.remove(f.trigger.id);
    return fires;
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && npx jest src/modules/sentinel-executor/domain/trigger-book.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/sentinel-executor/domain/trigger-book.ts apps/api/src/modules/sentinel-executor/domain/trigger-book.spec.ts
git commit -m "feat(sentinel-executor): TriggerBook — in-memory armed triggers and the O(1) tick path

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Task 13: `TriggerWatchService` — arm, watch, fire, expire, rebuild (Stream B, after Tasks 10–12)

**Files:**
- Create: `apps/api/src/modules/sentinel-executor/services/trigger-watch.service.ts`
- Test: `apps/api/src/modules/sentinel-executor/services/trigger-watch.service.spec.ts`

**Interfaces:**
- Consumes: Tasks 7–12; `SentinelExitExecutor.execute(id, v, cfg, now, 'PRICE_TRIGGER')`, `AiExitExecutionRepository.claim(v, mode)`, `PendingVerdict` (P1/auto-exit); `parseAutoExitConfig`, `AUTO_EXIT_EXCHANGES`; `lookupHubPrices`, `HubPrices` (`market-hub/hub-prices.ts`); `refKey`, `isHubExchange`, `InstrumentRef`, `Price`, `HubExchange` (`market-hub/hub.types.ts`); `AI_EXIT_SESSION_CLOCK`.
- Produces: `TriggerWatchService` with `start(env): boolean`, `onPrice(p: Price): void`, `pass(now?: Date): Promise<void>`, `onModuleInit()`, `onModuleDestroy()`; `firedReason(t: ArmedTrigger, tick: Fire['tick'], armedAtIst: string): string`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/modules/sentinel-executor/services/trigger-watch.service.spec.ts
import type { Price, PriceResult } from '../../market-hub/hub.types';
import { TriggerWatchService } from './trigger-watch.service';

const ENV = {
  SENTINEL_TRIGGERS_ENABLED: 'true', AI_AUTO_EXIT_ENABLED: 'true', AI_AUTO_EXIT_USER_IDS: 'owner', AI_AUTO_EXIT_QTY_UNITS: 'MCX:units',
};
const T0 = new Date('2026-10-13T17:00:00Z');
const ms = (d: Date, plus: number) => new Date(d.getTime() + plus);
const STORED = {
  v: 1, instrument: 'UNDERLYING', op: 'BELOW', price: 8930,
  watch: { exchange: 'MCX', token: '472789', symbol: 'CRUDEOIL19NOV26FUT' }, seen: { price: 8951, at: T0.toISOString() },
};
const TRACKER = { id: 't1', userId: 'owner', symbol: 'CRUDEOIL19NOV268950CE', exchange: 'MCX', token: '5001', qty: 100, status: 'OPEN', kind: 'POSITION' };
const proposal = (over: Record<string, unknown> = {}) => ({
  id: 'v1', userId: 'owner', trackerId: 't1', symbol: TRACKER.symbol, verdict: 'EXIT_ARMED', exitTrigger: STORED, createdAt: T0, ...over,
});
const fresh = (ltp: number, at = T0.getTime()): PriceResult => ({
  kind: 'fresh', price: { ref: { exchange: 'MCX', token: '472789', symbol: 'F' }, ltp, at, source: 'ws' },
});

function harness(o: {
  proposals?: unknown[][]; tracker?: unknown; price?: PriceResult; hub?: boolean;
  claimFire?: () => Promise<boolean>; armed?: unknown[]; closed?: string[];
} = {}) {
  const listeners: Array<(p: Price) => void> = [];
  const hub = {
    price: jest.fn(() => o.price ?? fresh(8951)),
    prices: jest.fn(),
    watch: jest.fn(async () => undefined),
    unwatch: jest.fn(async () => undefined),
    onPrice: jest.fn((fn: (p: Price) => void) => { listeners.push(fn); return () => undefined; }),
  };
  const source = { hubFor: jest.fn(() => (o.hub === false ? null : hub)), record: jest.fn() };
  const moduleRef = { get: jest.fn(() => source) };
  const batches = [...(o.proposals ?? [[]])];
  const repo = {
    pendingProposals: jest.fn(async () => (batches.length > 1 ? batches.shift() : batches[0]) ?? []),
    trackerFor: jest.fn(async (..._a: any[]) => (o.tracker === undefined ? TRACKER : o.tracker)),
    reject: jest.fn(async (..._a: any[]) => true),
    arm: jest.fn(async (..._a: any[]) => ({ id: 'trg1', superseded: [] as string[] })),
    claimFire: jest.fn(o.claimFire ?? (async (..._a: any[]) => true)),
    expire: jest.fn(async (ids: string[], ..._a: any[]) => ids.length),
    loadArmed: jest.fn(async () => o.armed ?? []),
    trackerExchanges: jest.fn(async () => new Map([['t1', 'MCX']])),
    closedTrackerIds: jest.fn(async (..._a: any[]) => o.closed ?? ([] as string[])),
  };
  const execRepo = { claim: jest.fn(async (..._a: any[]) => 'exec1') };
  const executor = { execute: jest.fn(async (..._a: any[]) => ({ status: 'DRY_RUN' })) };
  const clock = { isOpen: jest.fn(() => true) };
  const svc = new TriggerWatchService(repo as never, execRepo as never, executor as never, moduleRef as never, clock as never);
  const emit = (ltp: number, at: Date, source: Price['source'] = 'ws') => {
    jest.spyOn(Date, 'now').mockReturnValue(at.getTime());
    for (const fn of listeners) fn({ ref: { exchange: 'MCX', token: '472789', symbol: 'F' }, ltp, at: at.getTime(), source });
  };
  return { svc, hub, source, moduleRef, repo, execRepo, executor, clock, emit, listeners };
}

let intervalSpy: jest.SpyInstance;
beforeEach(() => {
  intervalSpy = jest.spyOn(global, 'setInterval').mockReturnValue({ unref: () => undefined } as never);
});
afterEach(() => jest.restoreAllMocks());

/** Start, then one pass that arms proposal v1 at T0. */
async function armed(h: ReturnType<typeof harness>) {
  expect(h.svc.start(ENV)).toBe(true);
  await h.svc.pass(T0);
  expect(h.repo.arm).toHaveBeenCalledTimes(1);
}

describe('TriggerWatchService — arming', () => {
  it('arms a valid UNDERLYING proposal and watches the MCX future at priority 1', async () => {
    const h = harness({ proposals: [[proposal()]] });
    await armed(h);
    expect(h.hub.watch).toHaveBeenCalledWith([{ exchange: 'MCX', token: '472789', symbol: 'CRUDEOIL19NOV26FUT' }], 1, 'sentinel-triggers');
    expect(h.repo.arm.mock.calls[0][1]).toEqual({
      instrument: 'UNDERLYING', op: 'BELOW', price: 8930, watchExchange: 'MCX', watchToken: '472789',
      watchSymbol: 'CRUDEOIL19NOV26FUT', refPrice: 8951,
    });
  });

  it('PREMIUM watches the tracker contract and adds no hub watch', async () => {
    const h = harness({
      proposals: [[proposal({ exitTrigger: { v: 1, instrument: 'PREMIUM', op: 'BELOW', price: 180, watch: null } })]],
      price: { kind: 'fresh', price: { ref: { exchange: 'MCX', token: '5001', symbol: 'C' }, ltp: 212, at: T0.getTime(), source: 'ws' } },
    });
    await armed(h);
    expect(h.hub.watch).not.toHaveBeenCalled();
    expect(h.repo.arm.mock.calls[0][1]).toMatchObject({ watchExchange: 'MCX', watchToken: '5001', watchSymbol: TRACKER.symbol });
  });

  it.each([
    ['malformed', { exitTrigger: { v: 1, problem: 'price is not a positive number' } }, undefined, /^MALFORMED: price/],
    ['not protective (long CE, UNDERLYING ABOVE)', { exitTrigger: { ...STORED, op: 'ABOVE', price: 8970 } }, undefined, /^NOT_PROTECTIVE$/],
    ['tracker closed', {}, { ...TRACKER, status: 'CLOSED' }, /^TRACKER_NOT_OPEN$/],
    ['cash equity', {}, { ...TRACKER, exchange: 'NSE' }, /^EXCHANGE_NOT_FNO$/],
    ['no watch target', { exitTrigger: { ...STORED, watch: null } }, undefined, /^NO_WATCH_TARGET$/],
  ])('rejects %s, recorded, never armed', async (_l, over, tracker, reason) => {
    const h = harness({ proposals: [[proposal(over as never)]], tracker });
    h.svc.start(ENV);
    await h.svc.pass(T0);
    expect(h.repo.arm).not.toHaveBeenCalled();
    expect(h.repo.reject.mock.calls[0][2]).toMatch(reason);
  });

  it('no hub for the user → REJECTED: NO_HUB', async () => {
    const h = harness({ proposals: [[proposal()]], hub: false });
    h.svc.start(ENV);
    await h.svc.pass(T0);
    expect(h.repo.reject.mock.calls[0][2]).toBe('NO_HUB');
  });

  it('slot exhaustion: an unpriced instrument is deferred, then REJECTED NO_FRESH_PRICE after 30 s and its watch released', async () => {
    const h = harness({ proposals: [[proposal()]], price: { kind: 'unavailable', reason: 'never-priced' } });
    h.svc.start(ENV);
    await h.svc.pass(T0);
    expect(h.repo.reject).not.toHaveBeenCalled();
    expect(h.hub.watch).toHaveBeenCalledTimes(1);
    await h.svc.pass(ms(T0, 10_000));
    expect(h.repo.reject).not.toHaveBeenCalled();
    expect(h.hub.watch).toHaveBeenCalledTimes(1);           // not re-registered every pass
    await h.svc.pass(ms(T0, 31_000));
    expect(h.repo.reject.mock.calls[0][2]).toMatch(/^NO_FRESH_PRICE/);
    expect(h.hub.unwatch).toHaveBeenCalledWith([{ exchange: 'MCX', token: '472789', symbol: 'CRUDEOIL19NOV26FUT' }], 'sentinel-triggers');
  });

  it('market closed at arming → REJECTED: EXCHANGE_CLOSED', async () => {
    const h = harness({
      proposals: [[proposal()]],
      price: { kind: 'market-closed', price: { ref: { exchange: 'MCX', token: '472789', symbol: 'F' }, ltp: 8951, at: T0.getTime(), source: 'ws' } },
    });
    h.svc.start(ENV);
    await h.svc.pass(T0);
    expect(h.repo.reject.mock.calls[0][2]).toBe('EXCHANGE_CLOSED');
  });

  it('tighten-only: a looser later proposal is REJECTED and the armed level still fires', async () => {
    const h = harness({ proposals: [[proposal()], [proposal({ id: 'v2', exitTrigger: { ...STORED, price: 8900 } })], []] });
    await armed(h);
    await h.svc.pass(ms(T0, 5000));
    expect(h.repo.reject.mock.calls[0][2]).toBe('LOOSENS');
    h.emit(8925, ms(T0, 6000));
    h.emit(8924, ms(T0, 7100));
    await new Promise((r) => setImmediate(r));
    expect(h.repo.claimFire).toHaveBeenCalledWith('trg1', expect.objectContaining({ price: 8924 }), expect.any(Date));
  });
});

describe('TriggerWatchService — firing', () => {
  it('fires ONCE under concurrent ticks while the claim is in flight (R7)', async () => {
    let release!: (v: boolean) => void;
    const h = harness({ proposals: [[proposal()], []], claimFire: () => new Promise<boolean>((r) => { release = r; }) });
    await armed(h);
    h.emit(8925, ms(T0, 1000));
    h.emit(8924, ms(T0, 2100));   // fires
    h.emit(8920, ms(T0, 2200));   // concurrent
    h.emit(8919, ms(T0, 3400));   // concurrent
    expect(h.repo.claimFire).toHaveBeenCalledTimes(1);
    release(true);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(h.execRepo.claim).toHaveBeenCalledTimes(1);
    expect(h.execRepo.claim.mock.calls[0][0]).toMatchObject({ id: 'trg_trg1', userId: 'owner', trackerId: 't1' });
    expect(h.execRepo.claim.mock.calls[0][1]).toBe('dry-run');
    expect(h.executor.execute).toHaveBeenCalledTimes(1);
    expect(h.executor.execute.mock.calls[0][0]).toBe('exec1');
    expect(h.executor.execute.mock.calls[0][4]).toBe('PRICE_TRIGGER');
    expect(h.executor.execute.mock.calls[0][1].reason).toMatch(/^PRICE_TRIGGER: CRUDEOIL19NOV26FUT < 8930 — fired at 8924 \(2 ticks over 1100 ms\)/);
  });

  it('a lost claim (another process fired, or it expired) executes nothing', async () => {
    const h = harness({ proposals: [[proposal()], []], claimFire: async () => false });
    await armed(h);
    h.emit(8925, ms(T0, 1000));
    h.emit(8924, ms(T0, 2100));
    await new Promise((r) => setImmediate(r));
    expect(h.execRepo.claim).not.toHaveBeenCalled();
    expect(h.executor.execute).not.toHaveBeenCalled();
  });

  it('a claim that THROWS re-arms in memory and sends nothing (R8); a later cross retries', async () => {
    const claimFire = jest.fn().mockRejectedValueOnce(new Error('db down')).mockResolvedValueOnce(true);
    const h = harness({ proposals: [[proposal()], []], claimFire });
    await armed(h);
    h.emit(8925, ms(T0, 1000));
    h.emit(8924, ms(T0, 2100));
    await new Promise((r) => setImmediate(r));
    expect(h.executor.execute).not.toHaveBeenCalled();
    h.emit(8923, ms(T0, 3000));
    h.emit(8922, ms(T0, 4100));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(claimFire).toHaveBeenCalledTimes(2);
    expect(h.executor.execute).toHaveBeenCalledTimes(1);
  });

  it('one bad print never sells', async () => {
    const h = harness({ proposals: [[proposal()], []] });
    await armed(h);
    h.emit(8000, ms(T0, 1000));
    h.emit(8950, ms(T0, 2100));
    expect(h.repo.claimFire).not.toHaveBeenCalled();
  });

  it('ticks while the exchange is closed never fire', async () => {
    const h = harness({ proposals: [[proposal()], []] });
    await armed(h);
    h.clock.isOpen.mockReturnValue(false);
    h.emit(8925, ms(T0, 1000));
    h.emit(8924, ms(T0, 2100));
    expect(h.repo.claimFire).not.toHaveBeenCalled();
  });
});

describe('TriggerWatchService — expiry and rebuild', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: 'trg9', userId: 'owner', trackerId: 't1', verdictId: 'v9', symbol: TRACKER.symbol, instrument: 'UNDERLYING', op: 'BELOW',
    price: 8930, watchExchange: 'MCX', watchToken: '472789', watchSymbol: 'CRUDEOIL19NOV26FUT', status: 'ARMED',
    armedAt: ms(T0, -60_000), ...over,
  });

  it('boot rebuilds ARMED rows into memory and watches their underlyings; they fire', async () => {
    const h = harness({ armed: [row()] });
    h.svc.start(ENV);
    await h.svc.pass(T0);
    expect(h.hub.watch).toHaveBeenCalledWith([{ exchange: 'MCX', token: '472789', symbol: 'CRUDEOIL19NOV26FUT' }], 1, 'sentinel-triggers');
    h.emit(8925, ms(T0, 1000));
    h.emit(8924, ms(T0, 2100));
    expect(h.repo.claimFire).toHaveBeenCalledWith('trg9', expect.anything(), expect.any(Date));
  });

  it('boot expires rows past max age, and rows whose exchange is closed', async () => {
    const h = harness({ armed: [row({ armedAt: ms(T0, -241 * 60_000) })] });
    h.svc.start(ENV);
    await h.svc.pass(T0);
    expect(h.repo.expire).toHaveBeenCalledWith(['trg9'], 'MAX_AGE', T0);

    const c = harness({ armed: [row()] });
    c.clock.isOpen.mockReturnValue(false);
    c.svc.start(ENV);
    await c.svc.pass(T0);
    expect(c.repo.expire).toHaveBeenCalledWith(['trg9'], 'EXCHANGE_CLOSED', T0);
  });

  it('maintenance (every 30 s) expires triggers whose tracker closed, and they no longer fire', async () => {
    const h = harness({ proposals: [[proposal()], []] });
    await armed(h);
    h.repo.closedTrackerIds.mockResolvedValue(['t1']);
    await h.svc.pass(ms(T0, 31_000));
    expect(h.repo.expire).toHaveBeenCalledWith(['trg1'], 'TRACKER_CLOSED', ms(T0, 31_000));
    h.emit(8925, ms(T0, 32_000));
    h.emit(8924, ms(T0, 33_100));
    expect(h.repo.claimFire).not.toHaveBeenCalled();
    expect(h.hub.unwatch).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx jest src/modules/sentinel-executor/services/trigger-watch.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/modules/sentinel-executor/services/trigger-watch.service.ts
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { BOOT_JOBS_DISABLED, bootJobsEnabled } from '../../../common/utils/boot-jobs';
import { lookupHubPrices, type HubPrices } from '../../market-hub/hub-prices';
import { isHubExchange, refKey, type HubExchange, type InstrumentRef, type Price } from '../../market-hub/hub.types';
import type { SessionClock } from '../../market-hub/session-clock';
import { parseAutoExitConfig } from '../domain/auto-exit.config';
import { AUTO_EXIT_EXCHANGES, type AutoExitConfig } from '../domain/auto-exit.types';
import { triggerVerdictId } from '../domain/manual-exit';
import { parseStoredTrigger } from '../domain/stored-trigger';
import { TriggerBook, type ArmedTrigger, type Fire } from '../domain/trigger-book';
import { parseTriggerConfig, type TriggerConfig } from '../domain/trigger-config';
import { contractKindOf, validateTrigger } from '../domain/trigger-rules';
import { TRIGGER_TIMING, TRIGGER_WATCH_OWNER } from '../domain/trigger.types';
import { EMPTY_CONFIRM } from '../domain/confirmation';
import { AiExitExecutionRepository, type PendingVerdict } from '../repositories/ai-exit-execution.repository';
import {
  SentinelExitTriggerRepository,
  type ProposalRow,
  type TriggerFields,
} from '../repositories/sentinel-exit-trigger.repository';
import { AI_EXIT_SESSION_CLOCK, SentinelExitExecutor } from './sentinel-exit-executor.service';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const IST_HM = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const sign = (op: 'BELOW' | 'ABOVE') => (op === 'BELOW' ? '<' : '>');

/** The executor row's verdictReason for a fire (ruling R13). */
export function firedReason(t: ArmedTrigger, tick: Fire['tick'], armedAtIst: string): string {
  return `PRICE_TRIGGER: ${t.watch.symbol} ${sign(t.op)} ${t.price} — fired at ${tick.price} ` +
    `(${tick.count} ticks over ${tick.heldMs} ms); armed ${armedAtIst} IST by verdict ${t.verdictId}`;
}

/**
 * Sentinel price triggers (docs/superpowers/specs/2026-10-13-sentinel-price-triggers-design.md §3).
 *
 * OFF unless SENTINEL_TRIGGERS_ENABLED=true AND the AI auto-exit is enabled with
 * an allow-list AND boot jobs run (ruling R11): then nothing — no timer, no hub
 * listener, no watch, no query. On: every 5 s one arming query (+ maintenance
 * every 30 s); the hub's onPrice stream feeds `TriggerBook.onTick`, the only tick
 * path, which does no I/O. A confirmed cross claims ARMED → FIRED and hands a
 * synthetic `trg_` verdict to the SAME guarded executor as an AI verdict.
 */
@Injectable()
export class TriggerWatchService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TriggerWatchService.name);
  private tcfg: TriggerConfig | null = null;
  private acfg: AutoExitConfig | null = null;
  private book: TriggerBook | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private booted = false;
  private lastMaintenance = 0;
  private readonly hubs = new Map<string, HubPrices>();
  private readonly subscribed = new Set<HubPrices>();
  private readonly unsubs: Array<() => void> = [];
  /** UNDERLYING refs this service registered on a hub, by key. */
  private readonly held = new Map<string, { ref: InstrumentRef; hub: HubPrices }>();
  /** Proposals waiting for their instrument to price (R9): verdictId → first seen + key. */
  private readonly deferred = new Map<string, { firstSeen: number; key: string | null }>();
  private readonly warned = new Set<string>();

  constructor(
    private readonly repo: SentinelExitTriggerRepository,
    private readonly execRepo: AiExitExecutionRepository,
    private readonly executor: SentinelExitExecutor,
    private readonly moduleRef: ModuleRef,
    @Inject(AI_EXIT_SESSION_CLOCK) private readonly clock: Pick<SessionClock, 'isOpen'>,
  ) {}

  onModuleInit(): void {
    this.start(process.env);
  }

  /** The switch logic, env-injected for tests. true = started. */
  start(env: Record<string, string | undefined>): boolean {
    const tcfg = parseTriggerConfig(env);
    const acfg = parseAutoExitConfig(env);
    for (const p of tcfg.problems) this.logger.warn(`[ai-trigger] ${p}`);
    if (!bootJobsEnabled()) {
      this.logger.log(BOOT_JOBS_DISABLED);
      return false;
    }
    if (!tcfg.enabled) {
      this.logger.log('[ai-trigger] disabled (SENTINEL_TRIGGERS_ENABLED is not true)');
      return false;
    }
    if (!acfg.enabled || acfg.userIds.length === 0) {
      this.logger.error('[ai-trigger] SENTINEL_TRIGGERS_ENABLED=true but the AI auto-exit is off or has no allow-listed user — not starting');
      return false;
    }
    this.tcfg = tcfg;
    this.acfg = acfg;
    this.book = new TriggerBook({ ticks: tcfg.confirmTicks, ms: tcfg.confirmMs }, (ex, at) => this.clock.isOpen(ex, at));
    this.logger.warn(
      `[ai-trigger] ENABLED mode=${acfg.mode} confirm=${tcfg.confirmTicks} ticks/${tcfg.confirmMs} ms ` +
        `maxAge=${tcfg.maxAgeMin} min distance=U${tcfg.maxDistancePct.UNDERLYING}%/P${tcfg.maxDistancePct.PREMIUM}% ` +
        `tightenOnly=${tcfg.tightenOnly}`,
    );
    this.timer = setInterval(() => void this.pass(), TRIGGER_TIMING.passMs);
    this.timer.unref?.();
    return true;
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const off of this.unsubs.splice(0)) off();
    this.subscribed.clear();
    this.book = null;
  }

  /** THE tick path (hub listener). Synchronous; no I/O; never throws. */
  onPrice(p: Price): void {
    const book = this.book;
    if (!book) return;
    const fires = book.onTick({ key: refKey(p.ref), exchange: p.ref.exchange, ltp: p.ltp, at: p.at, source: p.source }, Date.now());
    for (const f of fires) void this.fire(f);
  }

  /** One background pass. Single-flight; a no-op unless started. */
  async pass(now: Date = new Date()): Promise<void> {
    if (!this.book || this.running) return;
    this.running = true;
    try {
      this.attachHubs();
      if (!this.booted) {
        await this.boot(now);
        this.booted = true;
      }
      await this.armPass(now);
      if (now.getTime() - this.lastMaintenance >= TRIGGER_TIMING.maintenanceMs) {
        this.lastMaintenance = now.getTime();
        await this.maintain(now);
      }
    } catch (err) {
      this.logger.warn(`[ai-trigger] pass failed: ${errText(err)}`);
    } finally {
      this.running = false;
    }
  }

  private attachHubs(): void {
    for (const userId of this.acfg?.userIds ?? []) {
      if (this.hubs.has(userId)) continue;
      const hub = lookupHubPrices(this.moduleRef)?.hubFor(userId, 'positions') ?? null;
      if (!hub) {
        this.warnOnce(`nohub:${userId}`, `[ai-trigger] no market hub serves ${userId} (MARKET_HUB_ENABLED / HUB_OWNER_USER_ID / HUB_PRICES_POSITIONS) — its triggers cannot arm`);
        continue;
      }
      this.hubs.set(userId, hub);
      if (!this.subscribed.has(hub)) {
        this.subscribed.add(hub);
        this.unsubs.push(hub.onPrice((p) => this.onPrice(p)));
      }
    }
  }

  private async boot(now: Date): Promise<void> {
    const rows = await this.repo.loadArmed(this.acfg!.userIds);
    // The POSITION's exchange (NFO for a NIFTY option whose watch is NSE) — one PK query.
    const exchanges = await this.repo.trackerExchanges([...new Set(rows.map((r) => r.trackerId))]);
    for (const r of rows) {
      if (!r.instrument || !r.op || !r.price || !r.watchExchange || !r.watchToken || !r.armedAt) continue;
      const ref: InstrumentRef = { exchange: r.watchExchange as HubExchange, token: r.watchToken, symbol: r.watchSymbol ?? r.watchToken };
      this.book!.add({
        id: r.id, userId: r.userId, trackerId: r.trackerId, symbol: r.symbol, verdictId: r.verdictId,
        instrument: r.instrument as ArmedTrigger['instrument'], op: r.op as ArmedTrigger['op'], price: r.price,
        watch: { key: refKey(ref), exchange: ref.exchange, token: ref.token, symbol: ref.symbol },
        // A tracker that no longer exists keeps the watch exchange here; maintenance expires it as TRACKER_CLOSED.
        trackerExchange: exchanges.get(r.trackerId) ?? r.watchExchange,
        armedAt: r.armedAt.getTime(), confirm: EMPTY_CONFIRM,
      });
      const hub = this.hubs.get(r.userId);
      if (r.instrument === 'UNDERLYING' && hub) this.hold(ref, hub);
    }
    if (rows.length > 0) this.logger.warn(`[ai-trigger] rebuilt ${rows.length} armed trigger(s) from the table`);
    this.lastMaintenance = now.getTime();
    await this.maintain(now);
  }

  private async armPass(now: Date): Promise<void> {
    const since = new Date(now.getTime() - TRIGGER_TIMING.armLookbackMs);
    const rows = await this.repo.pendingProposals(this.acfg!.userIds, since, TRIGGER_TIMING.perPass);
    for (const row of rows) {
      try {
        await this.armOne(row, now);
      } catch (err) {
        this.logger.warn(`[ai-trigger] arming verdict ${row.id} failed: ${errText(err)} — retried next pass`);
      }
    }
  }

  private async armOne(row: ProposalRow, now: Date): Promise<void> {
    const stored = parseStoredTrigger(row.exitTrigger);
    if (stored.kind === 'problem') return this.reject(row, {}, `MALFORMED: ${stored.problem}`);
    const p = stored.trigger;
    const fields: TriggerFields = { instrument: p.instrument, op: p.op, price: p.price };

    const tracker = await this.repo.trackerFor(row.trackerId);
    if (!tracker || tracker.userId !== row.userId || tracker.status !== 'OPEN' || tracker.kind !== 'POSITION') {
      return this.reject(row, fields, 'TRACKER_NOT_OPEN');
    }
    const trackerExchange = String(tracker.exchange ?? '').toUpperCase();
    if (!AUTO_EXIT_EXCHANGES.includes(trackerExchange)) return this.reject(row, fields, 'EXCHANGE_NOT_FNO');

    const w = p.instrument === 'PREMIUM'
      ? { exchange: trackerExchange, token: String(tracker.token), symbol: tracker.symbol }
      : p.watch;
    const wex = String(w?.exchange ?? '').toUpperCase();
    if (!w || !w.token || !isHubExchange(wex)) return this.reject(row, fields, 'NO_WATCH_TARGET');
    const ref: InstrumentRef = { exchange: wex, token: String(w.token), symbol: w.symbol };
    const key = refKey(ref);
    const wfields: TriggerFields = { ...fields, watchExchange: ref.exchange, watchToken: ref.token, watchSymbol: ref.symbol };

    const hub = this.hubs.get(row.userId);
    if (!hub) return this.reject(row, wfields, 'NO_HUB');
    if (p.instrument === 'UNDERLYING') this.hold(ref, hub);

    const r = hub.price(ref, { maxAgeMs: TRIGGER_TIMING.armPriceMaxAgeMs });
    if (r.kind === 'market-closed') {
      this.deferred.delete(row.id);
      await this.reject(row, wfields, 'EXCHANGE_CLOSED');
      return this.releaseIfUnused(key);
    }
    if (r.kind !== 'fresh') {
      const first = this.deferred.get(row.id)?.firstSeen ?? now.getTime();
      if (now.getTime() - first < TRIGGER_TIMING.armDeferMs) {
        this.deferred.set(row.id, { firstSeen: first, key: p.instrument === 'UNDERLYING' ? key : null });
        return;
      }
      this.deferred.delete(row.id);
      const why = r.kind === 'stale' ? `stale ${Math.round(r.ageMs / 1000)} s` : r.reason;
      await this.reject(row, wfields, `NO_FRESH_PRICE (${why})`);
      return this.releaseIfUnused(key);
    }
    this.deferred.delete(row.id);

    const current = { price: r.price.ltp, ageMs: Math.max(0, now.getTime() - r.price.at) };
    const armed = this.book!.byTracker(row.trackerId);
    const v = validateTrigger({
      proposal: p, qty: Number(tracker.qty), kind: contractKindOf(tracker.symbol), current,
      armed: armed ? { instrument: armed.instrument, op: armed.op, price: armed.price } : null,
      cfg: this.tcfg!,
    });
    if (!v.ok) {
      await this.reject(row, { ...wfields, refPrice: current.price }, v.reason);
      return this.releaseIfUnused(key);
    }

    const res = await this.repo.arm(row, { ...wfields, refPrice: current.price } as Required<TriggerFields>, now);
    if (!res) {
      this.logger.warn(`[ai-trigger] arming verdict ${row.id} lost a race — retried next pass if still pending`);
      return this.releaseIfUnused(key);
    }
    const replaced = this.book!.add({
      id: res.id, userId: row.userId, trackerId: row.trackerId, symbol: row.symbol, verdictId: row.id,
      instrument: p.instrument, op: p.op, price: p.price,
      watch: { key, exchange: ref.exchange, token: ref.token, symbol: ref.symbol },
      trackerExchange, armedAt: now.getTime(), confirm: EMPTY_CONFIRM,
    });
    if (replaced && replaced.watch.key !== key) this.releaseIfUnused(replaced.watch.key);
    this.logger.warn(
      `[ai-trigger] ARMED auto-exit if ${ref.symbol} ${sign(p.op)} ${p.price} (now ${current.price}) — ` +
        `${row.symbol} verdict ${row.id}${res.superseded.length ? `; supersedes ${res.superseded.join(',')}` : ''}`,
    );
  }

  private async reject(row: ProposalRow, f: TriggerFields, reason: string): Promise<void> {
    const recorded = await this.repo.reject(row, f, reason);
    if (recorded) this.logger.log(`[ai-trigger] REJECTED ${reason} — ${row.symbol} verdict ${row.id}`);
  }

  private async fire(f: Fire): Promise<void> {
    const t = f.trigger;
    const acfg = this.acfg;
    if (!acfg) return;
    const now = new Date();
    let won: boolean;
    try {
      won = await this.repo.claimFire(t.id, { price: f.tick.price, at: new Date(f.tick.at) }, now);
    } catch (err) {
      // R8: never execute without a won claim. Re-arm in memory; a later cross retries.
      this.logger.error(`[ai-trigger] fire claim failed for ${t.symbol} trigger ${t.id}: ${errText(err)} — re-armed, nothing sent`);
      this.book?.add({ ...t, confirm: EMPTY_CONFIRM });
      return;
    }
    if (!won) {
      this.logger.warn(`[ai-trigger] trigger ${t.id} was no longer ARMED — nothing sent`);
      this.releaseIfUnused(t.watch.key);
      return;
    }
    const reason = firedReason(t, f.tick, IST_HM.format(t.armedAt));
    this.logger.warn(`[ai-trigger] FIRED ${reason}`);
    this.releaseIfUnused(t.watch.key);
    const v: PendingVerdict = {
      id: triggerVerdictId(t.id), userId: t.userId, trackerId: t.trackerId, symbol: t.symbol, reason, createdAt: now,
    };
    try {
      const id = await this.execRepo.claim(v, acfg.mode);
      if (!id) {
        this.logger.warn(`[ai-trigger] execution for trigger ${t.id} already claimed — nothing more sent`);
        return;
      }
      await this.executor.execute(id, v, acfg, now, 'PRICE_TRIGGER');
    } catch (err) {
      this.logger.error(`[ai-trigger] executor errored for trigger ${t.id}: ${errText(err)}`);
    }
  }

  private async maintain(now: Date): Promise<void> {
    const book = this.book!;
    const tcfg = this.tcfg!;
    const due = new Map<string, string[]>();
    const add = (reason: string, id: string) => due.set(reason, [...(due.get(reason) ?? []), id]);
    const rest: ArmedTrigger[] = [];
    for (const t of book.all()) {
      if (now.getTime() - t.armedAt > tcfg.maxAgeMin * 60_000) add('MAX_AGE', t.id);
      else if (!this.clock.isOpen(t.trackerExchange, now)) add('EXCHANGE_CLOSED', t.id);
      else rest.push(t);
    }
    const closed = new Set(await this.repo.closedTrackerIds([...new Set(rest.map((t) => t.trackerId))]));
    for (const t of rest) if (closed.has(t.trackerId)) add('TRACKER_CLOSED', t.id);
    for (const [reason, ids] of due) await this.expire(ids, reason, now);

    for (const t of book.all()) {
      const seen = book.lastSeen(t.watch.key) ?? t.armedAt;
      if (this.clock.isOpen(t.watch.exchange, now) && now.getTime() - seen > TRIGGER_TIMING.starvedMs) {
        this.warnOnce(`starved:${t.id}`, `[ai-trigger] STARVED: no price for ${t.watch.symbol} in ${Math.round((now.getTime() - seen) / 1000)} s — trigger ${t.id} cannot fire until prices return`);
      }
    }
  }

  /** Memory first (the safe direction), then the table. */
  private async expire(ids: string[], reason: string, now: Date): Promise<void> {
    const keys = new Set<string>();
    for (const id of ids) {
      const t = this.book?.remove(id);
      if (t) keys.add(t.watch.key);
    }
    for (const k of keys) this.releaseIfUnused(k);
    try {
      const n = await this.repo.expire(ids, reason, now);
      if (n > 0) this.logger.log(`[ai-trigger] EXPIRED ${n} trigger(s): ${reason}`);
    } catch (err) {
      this.logger.warn(`[ai-trigger] expiring ${ids.join(',')} failed: ${errText(err)} — already disarmed in memory`);
    }
  }

  private hold(ref: InstrumentRef, hub: HubPrices): void {
    const key = refKey(ref);
    if (this.held.has(key)) return;
    this.held.set(key, { ref, hub });
    void hub.watch([ref], 1, TRIGGER_WATCH_OWNER);
  }

  private releaseIfUnused(key: string): void {
    const h = this.held.get(key);
    if (!h) return;
    if (this.book?.hasKey(key)) return;
    for (const d of this.deferred.values()) if (d.key === key) return;
    this.held.delete(key);
    void h.hub.unwatch([h.ref], TRIGGER_WATCH_OWNER);
  }

  private warnOnce(key: string, line: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.logger.warn(line);
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && npx jest src/modules/sentinel-executor/services/trigger-watch.service.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/sentinel-executor/services/trigger-watch.service.ts apps/api/src/modules/sentinel-executor/services/trigger-watch.service.spec.ts
git commit -m "feat(sentinel-executor): TriggerWatchService — arm against the live hub price, fire once through the guarded executor, expire, rebuild

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Task 14: Module wiring, inertness, env example (Stream B)

**Files:**
- Modify: `apps/api/src/modules/sentinel-executor/sentinel-executor.module.ts`
- Modify: `apps/api/src/modules/sentinel-executor/sentinel-executor.module.spec.ts`
- Modify: `apps/api/src/modules/sentinel-executor/services/trigger-watch.service.spec.ts` (inert cases)
- Modify: `deploy/env/api.env.example`

**Interfaces:**
- Consumes: `TriggerWatchService`, `SentinelExitTriggerRepository`.
- Produces: both registered as providers of `SentinelExecutorModule`.

- [ ] **Step 1: Write the failing tests**

Append to `trigger-watch.service.spec.ts`:

```ts
describe('TriggerWatchService — disabled is inert (R11, Review Focus 6)', () => {
  it.each([
    ['flag unset', {}],
    ['flag not exactly true', { ...ENV, SENTINEL_TRIGGERS_ENABLED: 'TRUE' }],
    ['auto-exit off', { ...ENV, AI_AUTO_EXIT_ENABLED: 'false' }],
    ['no allow-listed user', { ...ENV, AI_AUTO_EXIT_USER_IDS: '' }],
  ])('%s: no timer, no hub lookup, no query, no listener', async (_l, env) => {
    const h = harness({ proposals: [[proposal()]] });
    expect(h.svc.start(env)).toBe(false);
    await h.svc.pass(T0);
    h.svc.onPrice({ ref: { exchange: 'MCX', token: '472789', symbol: 'F' }, ltp: 1, at: T0.getTime(), source: 'ws' });
    expect(intervalSpy).not.toHaveBeenCalled();
    expect(h.moduleRef.get).not.toHaveBeenCalled();
    expect(h.hub.onPrice).not.toHaveBeenCalled();
    expect(h.hub.watch).not.toHaveBeenCalled();
    for (const fn of Object.values(h.repo)) expect(fn).not.toHaveBeenCalled();
  });

  it('BOOT_JOBS=false: inert even when everything is enabled', async () => {
    const prev = process.env.BOOT_JOBS;
    process.env.BOOT_JOBS = 'false';
    try {
      const h = harness();
      expect(h.svc.start(ENV)).toBe(false);
      expect(intervalSpy).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.BOOT_JOBS; else process.env.BOOT_JOBS = prev;
    }
  });
});
```

In `sentinel-executor.module.spec.ts`, extend the existing provider-list assertion to include `TriggerWatchService` and `SentinelExitTriggerRepository` (the spec reads module metadata; add both class names to its expected array).

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx jest src/modules/sentinel-executor/sentinel-executor.module.spec.ts src/modules/sentinel-executor/services/trigger-watch.service.spec.ts`
Expected: the module spec FAILS (providers missing); the inert cases PASS already (they pin Task 13's behaviour) — that is fine, they are regression guards.

- [ ] **Step 3: Implement**

`sentinel-executor.module.ts`: import and add to `providers` (after `SentinelExitPoller`):

```ts
import { SentinelExitTriggerRepository } from './repositories/sentinel-exit-trigger.repository';
import { TriggerWatchService } from './services/trigger-watch.service';
…
    SentinelExitTriggerRepository,
    // Price triggers (docs/superpowers/plans/2026-10-13-sentinel-price-triggers.md).
    // Inert unless SENTINEL_TRIGGERS_ENABLED=true and the AI auto-exit is on.
    TriggerWatchService,
```

`ModuleRef` is injected by Nest globally; no import needed.

`deploy/env/api.env.example`, directly after the `AI_AUTO_EXIT_QTY_UNITS=` block:

```bash
# --- Sentinel price triggers (docs/superpowers/specs/2026-10-13-sentinel-price-triggers-design.md) ---
# The judge's machine-readable exit level, armed and executed by a tick watcher
# through the SAME guarded executor (needs AI_AUTO_EXIT_ENABLED=true and an
# allow-listed user; dry-run/live = AI_AUTO_EXIT_MODE; counts toward the daily cap).
# Needs the market hub for that user: MARKET_HUB_ENABLED, HUB_OWNER_USER_ID, HUB_PRICES_POSITIONS=true.
# Off = no timer, no watch, no query. Turn off: SENTINEL_TRIGGERS_ENABLED=false + restart.
SENTINEL_TRIGGERS_ENABLED=false
# Confirmation: this many consecutive ticks beyond the level AND for at least this long (owner D2).
SENTINEL_TRIGGER_CONFIRM_TICKS=2
SENTINEL_TRIGGER_CONFIRM_MS=1000
# An armed level not renewed by a newer verdict expires after this many minutes.
SENTINEL_TRIGGER_MAX_AGE_MIN=240
# A level further than this from the live price is refused (per instrument).
SENTINEL_TRIGGER_MAX_DISTANCE_PCT=UNDERLYING:10,PREMIUM:60
# D4: a later level may only move toward the price. Only the exact string false disables.
SENTINEL_TRIGGER_TIGHTEN_ONLY=true
# Part B: level-break / giveback also evaluated on hub ticks (wakes the judge in ~1 s).
# Only when SENTINEL_SHADOW_ENABLED=true. Off: SENTINEL_TICK_TRIPWIRES=false.
SENTINEL_TICK_TRIPWIRES=true
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && npx jest src/modules/sentinel-executor && npx tsc --noEmit -p tsconfig.json`
Expected: PASS; tsc exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/sentinel-executor/sentinel-executor.module.ts apps/api/src/modules/sentinel-executor/sentinel-executor.module.spec.ts apps/api/src/modules/sentinel-executor/services/trigger-watch.service.spec.ts deploy/env/api.env.example
git commit -m "feat(sentinel-executor): wire the trigger watcher (inert by default); document SENTINEL_TRIGGER_* in api.env.example

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Task 15: `GET /api/sentinel-executor/triggers`, DTOs, structural isolation (Stream B, after P1)

**Files:**
- Create: `apps/api/src/modules/sentinel-executor/dto/sentinel-exit-trigger.dto.ts`
- Modify: `apps/api/src/modules/sentinel-executor/dto/ai-exit-execution.dto.ts` (add `triggerId`)
- Modify: `apps/api/src/modules/sentinel-executor/controllers/sentinel-executor.controller.ts` (+spec)
- Modify: `apps/api/src/modules/sentinel-executor/sentinel-executor.structure.spec.ts`

**Interfaces:**
- Consumes: `SentinelExitTriggerRepository.listForUser` (Task 11); `triggerIdOf` (Task 10).
- Produces (wire contract, copied verbatim into the web in Task 18):

```ts
export interface SentinelExitTriggerDto {
  id: string;
  trackerId: string;
  verdictId: string;
  symbol: string;
  instrument: 'UNDERLYING' | 'PREMIUM' | null;
  op: 'BELOW' | 'ABOVE' | null;
  price: number | null;
  watchSymbol: string | null;
  refPrice: number | null;
  status: 'ARMED' | 'FIRED' | 'SUPERSEDED' | 'REJECTED' | 'EXPIRED';
  reason: string | null;
  armedAt: string | null;
  endedAt: string | null;
  firedAt: string | null;
  firedPrice: number | null;
  firedTickAt: string | null;
  createdAt: string;
}
```

and `AiExitExecutionDto.triggerId: string | null` (non-null only when `trigger === 'PRICE_TRIGGER'`).

- [ ] **Step 1: Write the failing tests**

Controller spec (mirror the file's existing `executions` tests; the controller now also takes the trigger repository as its second constructor argument — update the existing `new SentinelExecutorController(...)` calls accordingly):

```ts
describe('GET triggers', () => {
  const row = { id: 'trg1', userId: 'owner', trackerId: 't1', verdictId: 'v1', symbol: 'S', instrument: 'UNDERLYING', op: 'BELOW',
    price: 8930, watchExchange: 'MCX', watchToken: '472789', watchSymbol: 'CRUDEOIL19NOV26FUT', refPrice: 8951, status: 'ARMED',
    reason: null, armedAt: new Date('2026-10-13T17:03:00Z'), endedAt: null, firedAt: null, firedPrice: null, firedTickAt: null,
    createdAt: new Date('2026-10-13T17:03:00Z'), updatedAt: new Date('2026-10-13T17:03:00Z') };

  it('the caller’s own rows only, as DTOs, limit clamped to 100', async () => {
    const listForUser = jest.fn().mockResolvedValue([row]);
    const c = new SentinelExecutorController({} as never, { listForUser } as never /* , P1's other deps */);
    process.env.AI_AUTO_EXIT_USER_IDS = 'owner';
    const out = await c.triggers({ userId: 'owner', role: 'USER' } as never, '500');
    expect(listForUser).toHaveBeenCalledWith('owner', 100);
    expect(out[0]).toEqual(expect.objectContaining({ id: 'trg1', status: 'ARMED', watchSymbol: 'CRUDEOIL19NOV26FUT', armedAt: '2026-10-13T17:03:00.000Z' }));
    expect(out[0]).not.toHaveProperty('userId');
    expect(out[0]).not.toHaveProperty('watchToken');
  });

  it('403 for a non-admin outside the allow-list, before any query', async () => {
    const listForUser = jest.fn();
    const c = new SentinelExecutorController({} as never, { listForUser } as never);
    process.env.AI_AUTO_EXIT_USER_IDS = 'owner';
    await expect(c.triggers({ userId: 'x', role: 'USER' } as never)).rejects.toThrow('not enabled');
    expect(listForUser).not.toHaveBeenCalled();
  });
});
```

DTO test (in the controller spec or a new `dto/ai-exit-execution.dto.spec.ts`):

```ts
it('triggerId is the trigger row id for trg_ executions, null otherwise', () => {
  const base = { verdictId: 'trg_trg1', createdAt: new Date(0), updatedAt: new Date(0) } as never;
  expect(toAiExitExecutionDto({ ...(base as object), verdictId: 'trg_trg1' } as never)).toMatchObject({ trigger: 'PRICE_TRIGGER', triggerId: 'trg1' });
  expect(toAiExitExecutionDto({ ...(base as object), verdictId: 'cm9v' } as never)).toMatchObject({ trigger: 'AI', triggerId: null });
});
```

`sentinel-executor.structure.spec.ts`, new describe:

```ts
describe('price triggers stay inside the executor (price-triggers plan, Review Focus 7)', () => {
  const all = () => files(MODULES).filter((f) => !f.endsWith('.spec.ts'));

  it('only sentinel-executor names sentinel_exit_triggers — trade-sentinel never reads or writes it', () => {
    const offenders = all()
      .filter((f) => !f.includes(join('modules', 'sentinel-executor')))
      .filter((f) => /sentinelExitTrigger|sentinel_exit_triggers/.test(code(f)))
      .map((f) => relative(MODULES, f).replace(/\\/g, '/'));
    expect(offenders).toEqual([]);
  });

  it('the tick path (trigger-book, confirmation) imports nothing but its own domain files', () => {
    for (const name of ['trigger-book.ts', 'confirmation.ts']) {
      const specs = specifiers(join(__dirname, 'domain', name));
      expect(specs.every((s) => s.startsWith('./'))).toBe(true);
    }
  });

  it('the trigger watcher reaches orders only through the executor (no placeOrder of its own)', () => {
    const w = code(join(__dirname, 'services', 'trigger-watch.service.ts'));
    expect(w).not.toMatch(/placeOrder|getPositionsEnvelope|getOrderBookEnvelope|withOwnerSession/);
    expect(w).toMatch(/bootJobsEnabled\(\)/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx jest src/modules/sentinel-executor/controllers src/modules/sentinel-executor/sentinel-executor.structure.spec.ts`
Expected: FAIL — `c.triggers` is not a function; `triggerId` missing.

- [ ] **Step 3: Implement**

`dto/sentinel-exit-trigger.dto.ts`: the interface above plus

```ts
import type { SentinelExitTrigger } from '@prisma/client';

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function toSentinelExitTriggerDto(r: SentinelExitTrigger): SentinelExitTriggerDto {
  return {
    id: r.id, trackerId: r.trackerId, verdictId: r.verdictId, symbol: r.symbol,
    instrument: r.instrument as SentinelExitTriggerDto['instrument'], op: r.op as SentinelExitTriggerDto['op'],
    price: r.price, watchSymbol: r.watchSymbol, refPrice: r.refPrice,
    status: r.status as SentinelExitTriggerDto['status'], reason: r.reason,
    armedAt: iso(r.armedAt), endedAt: iso(r.endedAt), firedAt: iso(r.firedAt),
    firedPrice: r.firedPrice, firedTickAt: iso(r.firedTickAt), createdAt: r.createdAt.toISOString(),
  };
}
```

`ai-exit-execution.dto.ts`: add `triggerId: string | null;` to the interface (doc: "the sentinel_exit_triggers row behind a PRICE_TRIGGER execution") and `triggerId: triggerIdOf(r.verdictId),` in the mapper (import `triggerIdOf` from `../domain/manual-exit`).

Controller: inject `SentinelExitTriggerRepository` (second constructor parameter, after the executions repository; keep P1's other parameters after it) and add, reusing the existing authz lines verbatim (extract them into a private `assertAllowed(user)` used by both endpoints):

```ts
  @Get('triggers')
  async triggers(
    @CurrentUser() user: AuthenticatedUser,
    @Query('limit') limit?: string,
  ): Promise<SentinelExitTriggerDto[]> {
    this.assertAllowed(user);
    const n = Number.parseInt(String(limit ?? ''), 10);
    const take = Number.isFinite(n) && n > 0 ? Math.min(n, MAX_LIMIT) : DEFAULT_LIMIT;
    const rows = await this.triggerRepo.listForUser(user.userId, take);
    return rows.map(toSentinelExitTriggerDto);
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && npx jest src/modules/sentinel-executor && npx tsc --noEmit -p tsconfig.json`
Expected: PASS; tsc exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/sentinel-executor/dto/sentinel-exit-trigger.dto.ts apps/api/src/modules/sentinel-executor/dto/ai-exit-execution.dto.ts apps/api/src/modules/sentinel-executor/controllers/sentinel-executor.controller.ts apps/api/src/modules/sentinel-executor/controllers/sentinel-executor.controller.spec.ts apps/api/src/modules/sentinel-executor/sentinel-executor.structure.spec.ts
git commit -m "feat(sentinel-executor): GET /api/sentinel-executor/triggers; triggerId on executions; structural isolation of price triggers

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Task 16: `TickSensorBook` + the cycle publishes per-tracker context (Stream C, after Task 5)

**Files:**
- Create: `apps/api/src/modules/trade-sentinel/services/tick-sensor-book.ts`
- Test: `apps/api/src/modules/trade-sentinel/services/tick-sensor-book.spec.ts`
- Modify: `apps/api/src/modules/trade-sentinel/services/sentinel-cycle.service.ts` (constructor: optional 9th parameter; `evaluateOne` after the tick is read; `prune`)
- Modify: `apps/api/src/modules/trade-sentinel/services/sentinel-cycle.service.spec.ts`

**Interfaces:**
- Consumes: `TickReading.contractRef/underlyingRef` (Task 5); `Side`, `Segment` (`../charges`).
- Produces:
  - `keyOf(r: { exchange: string; token: string }): string` (`EXCHANGE:token`, upper-cased exchange)
  - `interface TickSensorContext { userId; trackerId; symbol; segment: Segment; side: Side; entryPrice: number; contractKey: string; underlyingKey: string | null; nearestSupport: number | null; nearestResistance: number | null; holdingHigh: number | null; holdingLow: number | null; ltp: number; underlyingLtp: number | null; lastEvalAt: number; firing: boolean }`
  - `type SensorSeed = Omit<TickSensorContext, 'lastEvalAt' | 'firing'>`
  - `class TickSensorBook { upsert(seed: SensorSeed): void; prune(userId: string, live: Set<string>): void; forKey(key: string): TickSensorContext[]; users(): string[]; size(): number }`
  - `type SeedTick = Pick<TickSnapshot, 'segment' | 'side' | 'entryPrice' | 'ltp' | 'underlyingLtp' | 'nearestSupport' | 'nearestResistance' | 'holdingHigh' | 'holdingLow' | 'contractRef' | 'underlyingRef'>`; `sensorSeed(entry: { userId: string; trackerId: string; symbol: string }, tick: SeedTick): SensorSeed | null`

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/modules/trade-sentinel/services/tick-sensor-book.spec.ts
import { TickSensorBook, keyOf, sensorSeed, type SensorSeed } from './tick-sensor-book';

const seed = (over: Partial<SensorSeed> = {}): SensorSeed => ({
  userId: 'u1', trackerId: 't1', symbol: 'NIFTY28OCT2624000CE', segment: 'OPT', side: 'LONG', entryPrice: 100,
  contractKey: 'NFO:1', underlyingKey: 'NSE:99926000', nearestSupport: 24000, nearestResistance: 24200,
  holdingHigh: 130, holdingLow: 95, ltp: 120, underlyingLtp: 24050, ...over,
});

describe('TickSensorBook', () => {
  it('indexes a tracker under its contract AND underlying keys', () => {
    const b = new TickSensorBook();
    b.upsert(seed());
    expect(b.forKey('NFO:1').map((c) => c.trackerId)).toEqual(['t1']);
    expect(b.forKey('NSE:99926000').map((c) => c.trackerId)).toEqual(['t1']);
    expect(b.forKey('NSE:1')).toEqual([]);
  });

  it('an upsert refreshes levels but keeps the tick bookkeeping (lastEvalAt, firing)', () => {
    const b = new TickSensorBook();
    b.upsert(seed());
    const c = b.forKey('NFO:1')[0];
    c.lastEvalAt = 5;
    c.firing = true;
    b.upsert(seed({ nearestSupport: 24010, underlyingKey: null }));
    const d = b.forKey('NFO:1')[0];
    expect(d).toMatchObject({ nearestSupport: 24010, lastEvalAt: 5, firing: true });
    expect(b.forKey('NSE:99926000')).toEqual([]);   // old key unindexed
  });

  it('prune drops a user’s trackers that left the roster', () => {
    const b = new TickSensorBook();
    b.upsert(seed());
    b.upsert(seed({ trackerId: 't2', contractKey: 'NFO:2' }));
    b.prune('u1', new Set(['t2']));
    expect(b.forKey('NFO:1')).toEqual([]);
    expect(b.users()).toEqual(['u1']);
    b.prune('u1', new Set());
    expect(b.users()).toEqual([]);
  });

  it('keyOf upper-cases the exchange', () => expect(keyOf({ exchange: 'nfo', token: '1' })).toBe('NFO:1'));
});

describe('sensorSeed', () => {
  const tickBase = {
    segment: 'OPT', side: 'LONG', entryPrice: 100, qty: 50, ltp: 120, underlyingLtp: 24050,
    nearestSupport: 24000, nearestResistance: 24200, holdingHigh: 130, holdingLow: 95,
    contractRef: { exchange: 'NFO', token: '1', symbol: 'S' }, underlyingRef: { exchange: 'NSE', token: '99926000', symbol: 'NIFTY' },
  } as never;
  const entry = { userId: 'u1', trackerId: 't1', symbol: 'S' };

  it('derivative: contract + underlying keys', () => {
    expect(sensorSeed(entry, tickBase)).toMatchObject({ contractKey: 'NFO:1', underlyingKey: 'NSE:99926000' });
  });

  it('cash: the contract IS the underlying (both keys the same)', () => {
    const cash = { ...(tickBase as object), segment: 'EQ_INTRADAY', underlyingRef: null, contractRef: { exchange: 'NSE', token: '2885', symbol: 'RELIANCE-EQ' } } as never;
    expect(sensorSeed(entry, cash)).toMatchObject({ contractKey: 'NSE:2885', underlyingKey: 'NSE:2885' });
  });

  it('no contractRef → nothing to watch', () => {
    expect(sensorSeed(entry, { ...(tickBase as object), contractRef: null } as never)).toBeNull();
  });
});
```

In `sentinel-cycle.service.spec.ts`, construct a second service with a real book (9th argument) and assert publication:

```ts
describe('SentinelCycleService — publishes tick-sensor context (Part B)', () => {
  it('every evaluated position is published to the TickSensorBook; a closed one is pruned', async () => {
    const t = makeSvc();
    const book = new TickSensorBook();
    const svc = new SentinelCycleService(
      { build: t.build } as never, { evaluate: t.evaluate } as never, { build: t.buildPacket } as never,
      { ensureFor: t.ensureFor } as never, { judge: t.judge, promptVersion: 'v' } as never,
      { record: t.record, recentForTracker: t.recentForTracker } as never, { captureAndCompare: t.captureAndCompare } as never,
      { tickFor: t.tickFor } as never, book,
    );
    t.build.mockResolvedValue([watched('t1')]);
    t.tickFor.mockResolvedValue(tick({ contractRef: { exchange: 'NFO', token: '1', symbol: 'S' }, underlyingRef: { exchange: 'NSE', token: '99926000', symbol: 'NIFTY' } }));
    await svc.runForUser(USER);
    expect(book.forKey('NFO:1').map((c) => c.trackerId)).toEqual(['t1']);
    t.build.mockResolvedValue([]);
    await svc.runForUser(USER);
    expect(book.forKey('NFO:1')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx jest src/modules/trade-sentinel/services/tick-sensor-book.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/modules/trade-sentinel/services/tick-sensor-book.ts
import type { Segment, Side } from '../charges';
import type { TickSnapshot } from './context-packet.service';

/** The tick fields a seed needs (a TickReading satisfies it). */
export type SeedTick = Pick<
  TickSnapshot,
  'segment' | 'side' | 'entryPrice' | 'ltp' | 'underlyingLtp' | 'nearestSupport' | 'nearestResistance'
  | 'holdingHigh' | 'holdingLow' | 'contractRef' | 'underlyingRef'
>;

/**
 * Part B (price-triggers plan R14). What the price-only sensors need between two
 * 30-second passes, per tracker, keyed by the instruments whose ticks move them.
 * Filled by the cycle after every tick read; read by TickTripwireService on hub
 * ticks. Pure in-memory: no I/O, no imports beyond types.
 */
export interface TickSensorContext {
  userId: string;
  trackerId: string;
  symbol: string;
  segment: Segment;
  side: Side;
  entryPrice: number;
  contractKey: string;
  underlyingKey: string | null;
  nearestSupport: number | null;
  nearestResistance: number | null;
  holdingHigh: number | null;
  holdingLow: number | null;
  ltp: number;
  underlyingLtp: number | null;
  /** Tick bookkeeping, preserved across upserts. */
  lastEvalAt: number;
  firing: boolean;
}

export type SensorSeed = Omit<TickSensorContext, 'lastEvalAt' | 'firing'>;

const EMPTY: TickSensorContext[] = [];

export function keyOf(r: { exchange: string; token: string }): string {
  return `${String(r.exchange ?? '').toUpperCase()}:${r.token}`;
}

export function sensorSeed(entry: { userId: string; trackerId: string; symbol: string }, tick: SeedTick): SensorSeed | null {
  if (!tick.contractRef) return null;
  const contractKey = keyOf(tick.contractRef);
  const isCash = tick.segment === 'EQ_DELIVERY' || tick.segment === 'EQ_INTRADAY';
  return {
    userId: entry.userId, trackerId: entry.trackerId, symbol: entry.symbol,
    segment: tick.segment, side: tick.side, entryPrice: tick.entryPrice,
    contractKey,
    underlyingKey: isCash ? contractKey : tick.underlyingRef ? keyOf(tick.underlyingRef) : null,
    nearestSupport: tick.nearestSupport, nearestResistance: tick.nearestResistance,
    holdingHigh: tick.holdingHigh, holdingLow: tick.holdingLow,
    ltp: tick.ltp, underlyingLtp: tick.underlyingLtp,
  };
}

export class TickSensorBook {
  private readonly byTracker = new Map<string, TickSensorContext>();
  private readonly byKey = new Map<string, Set<string>>();

  upsert(seed: SensorSeed): void {
    const prev = this.byTracker.get(seed.trackerId);
    if (prev) this.unindex(prev);
    const next: TickSensorContext = { ...seed, lastEvalAt: prev?.lastEvalAt ?? 0, firing: prev?.firing ?? false };
    this.byTracker.set(seed.trackerId, next);
    this.index(next.contractKey, next.trackerId);
    if (next.underlyingKey && next.underlyingKey !== next.contractKey) this.index(next.underlyingKey, next.trackerId);
  }

  prune(userId: string, live: Set<string>): void {
    for (const c of [...this.byTracker.values()]) {
      if (c.userId === userId && !live.has(c.trackerId)) {
        this.unindex(c);
        this.byTracker.delete(c.trackerId);
      }
    }
  }

  forKey(key: string): TickSensorContext[] {
    const ids = this.byKey.get(key);
    if (!ids) return EMPTY;
    const out: TickSensorContext[] = [];
    for (const id of ids) {
      const c = this.byTracker.get(id);
      if (c) out.push(c);
    }
    return out;
  }

  users(): string[] {
    return [...new Set([...this.byTracker.values()].map((c) => c.userId))];
  }

  size(): number {
    return this.byTracker.size;
  }

  private index(key: string, id: string): void {
    let s = this.byKey.get(key);
    if (!s) {
      s = new Set();
      this.byKey.set(key, s);
    }
    s.add(id);
  }

  private unindex(c: TickSensorContext): void {
    for (const key of [c.contractKey, c.underlyingKey]) {
      if (!key) continue;
      const s = this.byKey.get(key);
      s?.delete(c.trackerId);
      if (s && s.size === 0) this.byKey.delete(key);
    }
  }
}
```

`sentinel-cycle.service.ts`:
- import `{ Optional }` from `@nestjs/common` (with the existing imports) and `{ TickSensorBook, sensorSeed } from './tick-sensor-book'`;
- constructor: add a 9th parameter `@Optional() private readonly sensorBook?: TickSensorBook,` after `@Inject(TICK_SOURCE) private readonly ticks: TickSource,`;
- in `evaluateOne`, right after `if (tick !== raw) this.warnMissingUnderlying(entry);`:

```ts
    // Part B: the price-only sensors' context for hub ticks between passes. Memory only.
    const seed = this.sensorBook ? sensorSeed(entry, tick) : null;
    if (seed) this.sensorBook!.upsert(seed);
```

- in `prune(owners, live)`, at its end: `for (const u of owners) this.sensorBook?.prune(u, live);`

`tick-sensor-book.ts` imports only types (from `../charges` and `./context-packet.service`, which the cycle already imports), so the reachability walk gains no new edge.

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && npx jest src/modules/trade-sentinel`
Expected: PASS (the existing `makeSvc()` constructs with 8 arguments and is unaffected).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/trade-sentinel/services/tick-sensor-book.ts apps/api/src/modules/trade-sentinel/services/tick-sensor-book.spec.ts apps/api/src/modules/trade-sentinel/services/sentinel-cycle.service.ts apps/api/src/modules/trade-sentinel/services/sentinel-cycle.service.spec.ts
git commit -m "feat(trade-sentinel): TickSensorBook — per-tracker context for price sensors between passes

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Task 17: Tick-driven tripwires — port, hub adapter, wake, reachability (Stream C)

**Files:**
- Create: `apps/api/src/modules/trade-sentinel/ports/tick-stream.port.ts`
- Create: `apps/api/src/modules/trade-sentinel/adapters/hub-tick-stream.adapter.ts` (+ `.spec.ts`)
- Create: `apps/api/src/modules/trade-sentinel/services/tick-tripwire.service.ts` (+ `.spec.ts`)
- Modify: `apps/api/src/modules/trade-sentinel/services/sentinel-runner.service.ts` (+ spec) — `wakeForTick`
- Modify: `apps/api/src/modules/trade-sentinel/trade-sentinel.module.ts` — providers
- Modify: `apps/api/src/modules/trade-sentinel/services/sentinel-cycle.service.spec.ts` — `ENTRIES`

**Interfaces:**
- Consumes: `TickSensorBook`, `keyOf` (Task 16); `levelBreak`, `givebackOffPeak` (`../tripwires/*`); `lookupHubPrices` (`market-hub/hub-prices.ts`) and `refKey` — adapter only.
- Produces:
  - `TICK_STREAM = 'SENTINEL_TICK_STREAM'`; `interface StreamTick { key: string; ltp: number; at: number }`; `interface TickStream { subscribe(userId: string, fn: (t: StreamTick) => void): (() => void) | null }`
  - `HubTickStream implements TickStream`
  - `TickTripwireService` with `start(cfg: { shadow: boolean; tickTripwires: boolean }): boolean`, `subscribeNew(): void`, `onTick(userId: string, t: StreamTick, now?: number): void`; constants `TICK_EVAL_MIN_MS = 1000`, `WAKE_COOLDOWN_MS = 15000`, `SUBSCRIBE_EVERY_MS = 10000`; pure `tickFires(ctx: TickSensorContext): TripwireFire[]`
  - `SentinelRunnerService.wakeForTick(userId: string, why: string): void`

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/modules/trade-sentinel/services/tick-tripwire.service.spec.ts
import { TickSensorBook, type SensorSeed } from './tick-sensor-book';
import { TickTripwireService, tickFires } from './tick-tripwire.service';

const seed = (over: Partial<SensorSeed> = {}): SensorSeed => ({
  userId: 'u1', trackerId: 't1', symbol: 'NIFTY28OCT2624000CE', segment: 'OPT', side: 'LONG', entryPrice: 100,
  contractKey: 'NFO:1', underlyingKey: 'NSE:99926000', nearestSupport: 24000, nearestResistance: 24200,
  holdingHigh: 130, holdingLow: 95, ltp: 120, underlyingLtp: 24050, ...over,
});

function harness(book = new TickSensorBook()) {
  const runner = { wakeForTick: jest.fn() };
  const subs = new Map<string, (t: { key: string; ltp: number; at: number }) => void>();
  const stream = { subscribe: jest.fn((u: string, fn: never) => { subs.set(u, fn); return () => subs.delete(u); }) };
  const svc = new TickTripwireService(book, runner as never, stream as never);
  return { svc, book, runner, stream, subs };
}

let intervalSpy: jest.SpyInstance;
beforeEach(() => { intervalSpy = jest.spyOn(global, 'setInterval').mockReturnValue({ unref: () => undefined } as never); });
afterEach(() => jest.restoreAllMocks());

describe('tickFires', () => {
  it('level break on the underlying (scale-safe)', () => {
    expect(tickFires({ ...seed(), underlyingLtp: 23990, lastEvalAt: 0, firing: false }).map((f) => f.name)).toEqual(['level-break']);
  });
  it('giveback on the premium', () => {
    expect(tickFires({ ...seed(), ltp: 105, lastEvalAt: 0, firing: false }).map((f) => f.name)).toEqual(['giveback-off-peak']);
  });
  it('quiet', () => expect(tickFires({ ...seed(), lastEvalAt: 0, firing: false })).toEqual([]));
});

describe('TickTripwireService', () => {
  it('a rising-edge level break wakes the user’s cycle once; staying broken does not re-wake', () => {
    const h = harness();
    h.book.upsert(seed());
    h.svc.onTick('u1', { key: 'NSE:99926000', ltp: 23990, at: 1 }, 10_000);
    expect(h.runner.wakeForTick).toHaveBeenCalledWith('u1', 'level-break on NIFTY28OCT2624000CE');
    h.svc.onTick('u1', { key: 'NSE:99926000', ltp: 23980, at: 2 }, 11_500);
    expect(h.runner.wakeForTick).toHaveBeenCalledTimes(1);
  });

  it('evaluates at most once per second per tracker', () => {
    const h = harness();
    h.book.upsert(seed());
    h.svc.onTick('u1', { key: 'NSE:99926000', ltp: 24050, at: 1 }, 10_000);  // quiet, evaluated
    h.svc.onTick('u1', { key: 'NSE:99926000', ltp: 23990, at: 2 }, 10_400);  // within 1 s: price recorded, not evaluated
    expect(h.runner.wakeForTick).not.toHaveBeenCalled();
    h.svc.onTick('u1', { key: 'NSE:99926000', ltp: 23990, at: 3 }, 11_100);
    expect(h.runner.wakeForTick).toHaveBeenCalledTimes(1);
  });

  it('per-user wake cooldown 15 s across trackers', () => {
    const h = harness();
    h.book.upsert(seed());
    h.book.upsert(seed({ trackerId: 't2', contractKey: 'NFO:2' }));
    h.svc.onTick('u1', { key: 'NSE:99926000', ltp: 23990, at: 1 }, 10_000);
    expect(h.runner.wakeForTick).toHaveBeenCalledTimes(1);
    h.svc.onTick('u1', { key: 'NFO:2', ltp: 105, at: 2 }, 12_000);   // t2 gives back — inside the cooldown
    expect(h.runner.wakeForTick).toHaveBeenCalledTimes(1);
  });

  it('a premium tick raises the running peak used by giveback', () => {
    const h = harness();
    h.book.upsert(seed({ holdingHigh: 120 }));
    h.svc.onTick('u1', { key: 'NFO:1', ltp: 140, at: 1 }, 10_000);
    expect(h.book.forKey('NFO:1')[0].holdingHigh).toBe(140);
  });

  it('another user’s tick never touches this user’s trackers', () => {
    const h = harness();
    h.book.upsert(seed());
    h.svc.onTick('u2', { key: 'NSE:99926000', ltp: 23990, at: 1 }, 10_000);
    expect(h.runner.wakeForTick).not.toHaveBeenCalled();
  });

  it.each([
    ['shadow off', { shadow: false, tickTripwires: true }],
    ['tick tripwires off', { shadow: true, tickTripwires: false }],
  ])('%s: inert — no timer, no subscription', (_l, cfg) => {
    const h = harness();
    h.book.upsert(seed());
    expect(h.svc.start(cfg)).toBe(false);
    h.svc.subscribeNew();
    expect(intervalSpy).not.toHaveBeenCalled();
    expect(h.stream.subscribe).not.toHaveBeenCalled();
  });

  it('on: subscribes each user in the book once', () => {
    const h = harness();
    h.book.upsert(seed());
    expect(h.svc.start({ shadow: true, tickTripwires: true })).toBe(true);
    h.svc.subscribeNew();
    h.svc.subscribeNew();
    expect(h.stream.subscribe).toHaveBeenCalledTimes(1);
    h.subs.get('u1')!({ key: 'NSE:99926000', ltp: 23990, at: Date.now() });
    expect(h.runner.wakeForTick).toHaveBeenCalledTimes(1);
  });
});
```

```ts
// apps/api/src/modules/trade-sentinel/adapters/hub-tick-stream.adapter.spec.ts
import { HubTickStream } from './hub-tick-stream.adapter';

describe('HubTickStream', () => {
  it('forwards hub prices as keyed ticks, drops db-sourced and non-positive ones', () => {
    let listener!: (p: unknown) => void;
    const hub = { onPrice: jest.fn((fn) => { listener = fn; return () => undefined; }) };
    const source = { hubFor: jest.fn(() => hub), record: jest.fn() };
    const s = new HubTickStream({ get: () => source } as never);
    const got: unknown[] = [];
    expect(s.subscribe('u1', (t) => got.push(t))).toBeInstanceOf(Function);
    expect(source.hubFor).toHaveBeenCalledWith('u1', 'positions');
    listener({ ref: { exchange: 'NSE', token: '1', symbol: 'X' }, ltp: 10, at: 5, source: 'ws' });
    listener({ ref: { exchange: 'NSE', token: '1', symbol: 'X' }, ltp: 10, at: 6, source: 'db' });
    listener({ ref: { exchange: 'NSE', token: '1', symbol: 'X' }, ltp: 0, at: 7, source: 'ws' });
    expect(got).toEqual([{ key: 'NSE:1', ltp: 10, at: 5 }]);
  });

  it('no hub for the user → null (nothing subscribed)', () => {
    const s = new HubTickStream({ get: () => ({ hubFor: () => null, record: jest.fn() }) } as never);
    expect(s.subscribe('u1', () => undefined)).toBeNull();
  });
});
```

`sentinel-runner.service.spec.ts` (reuse the file's runner construction; named `make()` below):

```ts
describe('wakeForTick (Part B)', () => {
  it('runs the ordinary sensor pass for that user when enabled', async () => {
    const { runner, startForUser } = make({ enabled: true });
    runner.wakeForTick('u1', 'level-break on X');
    await new Promise((r) => setImmediate(r));
    expect(startForUser).toHaveBeenCalledWith('u1');
  });
  it('disabled → nothing', () => {
    const { runner, startForUser } = make({ enabled: false });
    runner.wakeForTick('u1', 'x');
    expect(startForUser).not.toHaveBeenCalled();
  });
  it('a pass already in flight for the user → no second pass, no warning spam', async () => {
    const { runner, startForUser, settle } = make({ enabled: true, hang: true });
    void runner.runForUser('u1');
    runner.wakeForTick('u1', 'x');
    expect(startForUser).toHaveBeenCalledTimes(1);
    settle();
  });
});
```

(If the runner spec has no `make()` with `enabled`/`hang`, build it: `const startForUser = jest.fn(() => hang ? new Promise(r => settle = () => r({ report: {evaluated:0,skipped:0,failed:0,unwatched:0}, pending: 0, settled: Promise.resolve({…}) })) : Promise.resolve({ report: {…}, pending: 0, settled: Promise.resolve({…}) }))`; `new SentinelRunnerService({ startForUser } as never, {} as never, { get: (k: string) => (k === 'SENTINEL_SHADOW_ENABLED' ? String(enabled) : undefined) } as never)`.)

In `sentinel-cycle.service.spec.ts`, add to `ENTRIES`:

```ts
    // Part B: hub ticks wake the runner. A production entry point, so it is walked.
    join(__dirname, 'tick-tripwire.service.ts'),
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx jest src/modules/trade-sentinel/services/tick-tripwire.service.spec.ts src/modules/trade-sentinel/adapters/hub-tick-stream.adapter.spec.ts src/modules/trade-sentinel/services/sentinel-runner.service.spec.ts`
Expected: FAIL — modules / `wakeForTick` missing; the reachability test FAILS because the new entry file does not exist.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/modules/trade-sentinel/ports/tick-stream.port.ts
/**
 * Part B: live prices for the tick-driven sensors, as a PORT — so the cycle's
 * reachability walk (shadow mode is structural) never reaches market-hub. Bound
 * to HubTickStream in trade-sentinel.module.ts, the composition root.
 */
export const TICK_STREAM = 'SENTINEL_TICK_STREAM';

export interface StreamTick {
  /** EXCHANGE:token */
  key: string;
  ltp: number;
  /** Receipt time, ms epoch. */
  at: number;
}

export interface TickStream {
  /** Subscribe to every price the hub learns for this user. null = no hub serves the user. */
  subscribe(userId: string, fn: (t: StreamTick) => void): (() => void) | null;
}
```

```ts
// apps/api/src/modules/trade-sentinel/adapters/hub-tick-stream.adapter.ts
import { Injectable, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { lookupHubPrices } from '../../market-hub/hub-prices';
import { refKey } from '../../market-hub/hub.types';
import type { StreamTick, TickStream } from '../ports/tick-stream.port';

/** TickStream over the market hub's onPrice (consumer 'positions', the owner's hub). */
@Injectable()
export class HubTickStream implements TickStream {
  constructor(@Optional() private readonly moduleRef?: ModuleRef) {}

  subscribe(userId: string, fn: (t: StreamTick) => void): (() => void) | null {
    const hub = lookupHubPrices(this.moduleRef)?.hubFor(userId, 'positions') ?? null;
    if (!hub) return null;
    return hub.onPrice((p) => {
      if (p.source === 'db' || !Number.isFinite(p.ltp) || p.ltp <= 0) return;
      fn({ key: refKey(p.ref), ltp: p.ltp, at: p.at });
    });
  }
}
```

```ts
// apps/api/src/modules/trade-sentinel/services/tick-tripwire.service.ts
import { Inject, Injectable, Logger, Optional, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { bootJobsEnabled } from '../../../common/utils/boot-jobs';
import { TICK_STREAM, type StreamTick, type TickStream } from '../ports/tick-stream.port';
import { givebackOffPeak } from '../tripwires/giveback-off-peak.tripwire';
import { levelBreak } from '../tripwires/level-break.tripwire';
import type { TripwireFire, TripwireInput } from '../tripwires/types';
import { SentinelRunnerService } from './sentinel-runner.service';
import { TickSensorBook, type TickSensorContext } from './tick-sensor-book';

export const TICK_EVAL_MIN_MS = 1_000;
export const WAKE_COOLDOWN_MS = 15_000;
export const SUBSCRIBE_EVERY_MS = 10_000;

/** The two price-only sensors over a context. Pure; a throwing sensor is silent. */
export function tickFires(ctx: TickSensorContext): TripwireFire[] {
  const input: TripwireInput = {
    trackerId: ctx.trackerId, symbol: ctx.symbol, segment: ctx.segment, side: ctx.side, entryPrice: ctx.entryPrice,
    qty: 0, ltp: ctx.ltp, underlyingLtp: ctx.underlyingLtp, holdingHigh: ctx.holdingHigh, holdingLow: ctx.holdingLow,
    nearestSupport: ctx.nearestSupport, nearestResistance: ctx.nearestResistance, volumeRatio: null,
    oiWallNow: null, oiWallPrev: null, freshNewsCount: null, factorValues: {}, prevFactorValues: {},
  };
  const out: TripwireFire[] = [];
  for (const t of [levelBreak, givebackOffPeak]) {
    try {
      const f = t.check(input);
      if (f) out.push(f);
    } catch {
      // A broken sensor degrades to silence; the 30-s cron still runs it with logging.
    }
  }
  return out;
}

/**
 * Part B (spec §4, plan R14). Level break and giveback, evaluated on hub ticks
 * (≤ 1/s per tracker). A RISING-EDGE fire wakes the user's ordinary sensor pass —
 * every existing cap applies there. The cron stays the fallback and runs the
 * other four sensors. Tick path: synchronous, O(contexts on the key), no I/O.
 */
@Injectable()
export class TickTripwireService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TickTripwireService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private on = false;
  private readonly unsubs = new Map<string, () => void>();
  private readonly lastWake = new Map<string, number>();

  constructor(
    private readonly book: TickSensorBook,
    private readonly runner: SentinelRunnerService,
    @Inject(TICK_STREAM) private readonly stream: TickStream,
    @Optional() private readonly config?: ConfigService,
  ) {}

  onModuleInit(): void {
    this.start({
      shadow: this.config?.get<string>('SENTINEL_SHADOW_ENABLED') === 'true',
      tickTripwires: this.config?.get<string>('SENTINEL_TICK_TRIPWIRES') !== 'false',
    });
  }

  start(cfg: { shadow: boolean; tickTripwires: boolean }): boolean {
    if (!bootJobsEnabled() || !cfg.shadow || !cfg.tickTripwires) {
      if (cfg.shadow && !cfg.tickTripwires) this.logger.log('[sentinel-tick] tick tripwires off (SENTINEL_TICK_TRIPWIRES=false)');
      return false;
    }
    this.on = true;
    this.timer = setInterval(() => this.subscribeNew(), SUBSCRIBE_EVERY_MS);
    this.timer.unref?.();
    this.logger.log('[sentinel-tick] level-break and giveback also run on hub ticks (≤ 1/s per position)');
    return true;
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const off of this.unsubs.values()) off();
    this.unsubs.clear();
    this.on = false;
  }

  /** Subscribe users the cycle has published and we have not subscribed yet. */
  subscribeNew(): void {
    if (!this.on) return;
    for (const u of this.book.users()) {
      if (this.unsubs.has(u)) continue;
      const off = this.stream.subscribe(u, (t) => this.onTick(u, t));
      if (off) this.unsubs.set(u, off);
    }
  }

  onTick(userId: string, t: StreamTick, now: number = Date.now()): void {
    for (const ctx of this.book.forKey(t.key)) {
      if (ctx.userId !== userId) continue;
      if (t.key === ctx.contractKey) {
        ctx.ltp = t.ltp;
        if (ctx.side === 'LONG') ctx.holdingHigh = Math.max(ctx.holdingHigh ?? t.ltp, t.ltp);
        else ctx.holdingLow = Math.min(ctx.holdingLow ?? t.ltp, t.ltp);
      }
      if (t.key === ctx.underlyingKey) ctx.underlyingLtp = t.ltp;
      if (now - ctx.lastEvalAt < TICK_EVAL_MIN_MS) continue;
      ctx.lastEvalAt = now;
      const fires = tickFires(ctx);
      const was = ctx.firing;
      ctx.firing = fires.length > 0;
      if (!ctx.firing || was) continue;
      if (now - (this.lastWake.get(userId) ?? -Infinity) < WAKE_COOLDOWN_MS) continue;
      this.lastWake.set(userId, now);
      this.runner.wakeForTick(userId, `${fires.map((f) => f.name).join(', ')} on ${ctx.symbol}`);
    }
  }
}
```

(Constructor order in the spec harness: `new TickTripwireService(book, runner, stream)` — `config` is the optional 4th; `onModuleInit` is not used by the tests, `start` is.)

`sentinel-runner.service.ts`, after `runForUser`:

```ts
  /**
   * Part B (price-triggers plan R14): a hub tick fired a price sensor, so run
   * this user's ordinary sensor pass now instead of at the next 30-s tick. All
   * the usual caps apply inside the pass. Never throws; a pass already in
   * flight will see the move itself (or the next tick will).
   */
  wakeForTick(userId: string, why: string): void {
    if (!this.enabled) return;
    if (this.inFlight.has(userId)) return;
    this.logger.log(`[sentinel-tick] waking ${userId}: ${why}`);
    void this.runForUser(userId);
  }
```

`trade-sentinel.module.ts`: import `TickSensorBook`, `TickTripwireService`, `HubTickStream`, `TICK_STREAM`; add to `providers` (after `SentinelRunnerService`):

```ts
    // Part B — tick-driven price sensors. The hub is reached ONLY through this
    // port binding (composition root), so the cycle's walk never reaches it.
    TickSensorBook,
    { provide: TICK_STREAM, useClass: HubTickStream },
    TickTripwireService,
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && npx jest src/modules/trade-sentinel && npx tsc --noEmit -p tsconfig.json`
Expected: PASS — including "shadow mode is structural" with the new entry walked (its imports: runner, tick-sensor-book, tripwires, the port, boot-jobs, @nestjs/* — none matches FORBIDDEN); tsc exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/trade-sentinel/ports/tick-stream.port.ts apps/api/src/modules/trade-sentinel/adapters/hub-tick-stream.adapter.ts apps/api/src/modules/trade-sentinel/adapters/hub-tick-stream.adapter.spec.ts apps/api/src/modules/trade-sentinel/services/tick-tripwire.service.ts apps/api/src/modules/trade-sentinel/services/tick-tripwire.service.spec.ts apps/api/src/modules/trade-sentinel/services/sentinel-runner.service.ts apps/api/src/modules/trade-sentinel/services/sentinel-runner.service.spec.ts apps/api/src/modules/trade-sentinel/trade-sentinel.module.ts apps/api/src/modules/trade-sentinel/services/sentinel-cycle.service.spec.ts
git commit -m "feat(trade-sentinel): level-break and giveback on hub ticks wake the sensor pass in ~1 s (Part B)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Task 18: Charts page — armed level on the sentinel panel; PRICE_TRIGGER in AI exits (Stream D, after P1)

**Files:**
- Modify: `apps/web/src/hooks/useAiExits.ts` (generic quiet poller; `trigger`/`triggerId` on `AiExitRow`)
- Create: `apps/web/src/hooks/useSentinelTriggers.ts`
- Create: `apps/web/src/components/charts/triggerView.ts` + `triggerView.test.ts`
- Modify: `apps/web/src/components/charts/SentinelPanel.tsx` (optional `triggers` prop)
- Modify: `apps/web/src/components/charts/aiExitView.ts` + `aiExitView.test.ts`, `AiExitsList.tsx`
- Modify: `apps/web/src/pages/charts/ChartsPage.tsx` (~line 127 and ~line 709)
- Test: `apps/web/src/hooks/useAiExits.spec.ts`

**Interfaces:**
- Consumes: `SentinelExitTriggerDto` (Task 15, copied verbatim as `SentinelTriggerRow`); `AiExitExecutionDto.trigger` (P1) + `triggerId` (Task 15).
- Produces: `startQuietPolling<T>(opts)`; `useSentinelTriggers(): { rows: SentinelTriggerRow[] }`; `armedTriggerLine(row, now?): string | null`; `triggerHistoryLine(row): string`; `AiExitRowView.source: 'AI' | 'MANUAL' | 'PRICE_TRIGGER'`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/web/src/components/charts/triggerView.test.ts
import { describe, expect, it } from 'vitest';
import { armedForTracker, armedTriggerLine, triggerHistoryLine } from './triggerView';
import type { SentinelTriggerRow } from '@/hooks/useSentinelTriggers';

const row = (over: Partial<SentinelTriggerRow> = {}): SentinelTriggerRow => ({
  id: 'trg1', trackerId: 't1', verdictId: 'v1', symbol: 'CRUDEOIL19NOV268950CE', instrument: 'UNDERLYING', op: 'BELOW',
  price: 8930, watchSymbol: 'CRUDEOIL19NOV26FUT', refPrice: 8951, status: 'ARMED', reason: null,
  armedAt: '2026-10-13T17:03:00.000Z', endedAt: null, firedAt: null, firedPrice: null, firedTickAt: null,
  createdAt: '2026-10-13T17:03:00.000Z', ...over,
});

describe('triggerView', () => {
  it('the armed line the owner reads (spec §6)', () => {
    expect(armedTriggerLine(row())).toBe('auto-exit if CRUDEOIL19NOV26FUT < 8930, armed 22:33 IST');
    expect(armedTriggerLine(row({ op: 'ABOVE', price: 9000 }))).toBe('auto-exit if CRUDEOIL19NOV26FUT > 9000, armed 22:33 IST');
    expect(armedTriggerLine(row({ status: 'FIRED' }))).toBeNull();
  });

  it('armedForTracker picks the ARMED row of that tracker only', () => {
    expect(armedForTracker([row({ status: 'SUPERSEDED' }), row({ id: 'trg2' }), row({ id: 'x', trackerId: 't2' })], 't1')?.id).toBe('trg2');
    expect(armedForTracker([], 't1')).toBeNull();
  });

  it('history lines name the outcome', () => {
    expect(triggerHistoryLine(row({ status: 'FIRED', firedPrice: 8927.5, firedAt: '2026-10-13T17:11:07.000Z' })))
      .toBe('FIRED at 8927.5 (22:41 IST) — < 8930 on CRUDEOIL19NOV26FUT');
    expect(triggerHistoryLine(row({ status: 'REJECTED', reason: 'LOOSENS' }))).toBe('REJECTED: LOOSENS — < 8930 on CRUDEOIL19NOV26FUT');
    expect(triggerHistoryLine(row({ status: 'REJECTED', reason: 'MALFORMED: x', instrument: null, op: null, price: null, watchSymbol: null })))
      .toBe('REJECTED: MALFORMED: x');
  });
});
```

`aiExitView.test.ts` — add:

```ts
  it('a PRICE_TRIGGER row is labelled as such and carries the level and tick from verdictReason', () => {
    const v = aiExitRowView({ ...base(), trigger: 'PRICE_TRIGGER', triggerId: 'trg1',
      verdictReason: 'PRICE_TRIGGER: CRUDEOIL19NOV26FUT < 8930 — fired at 8927.5 (2 ticks over 1200 ms); armed 22:33 IST by verdict v1' });
    expect(v.source).toBe('PRICE_TRIGGER');
    expect(v.detail).toContain('< 8930 — fired at 8927.5');
  });
  it('rows without trigger (older API) are AI', () => {
    expect(aiExitRowView(base()).source).toBe('AI');
  });
```

(`base()` = the test file's existing `AiExitRow` builder.)

`useAiExits.spec.ts` — add:

```ts
describe('startQuietPolling (generic)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it('delivers whatever rows the endpoint returns and stops quietly on 403', async () => {
    const get = vi.fn().mockResolvedValueOnce([{ id: 'x' }]).mockRejectedValueOnce(httpErr(403));
    const onData = vi.fn();
    const { doc } = fakeDoc();
    const p = startQuietPolling<{ id: string }>({ get, onData, doc, intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(onData).toHaveBeenLastCalledWith([{ id: 'x' }]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(onData).toHaveBeenLastCalledWith([]);
    p.stop();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/web && npx vitest run src/components/charts/triggerView.test.ts src/components/charts/aiExitView.test.ts src/hooks/useAiExits.spec.ts`
Expected: FAIL — modules/exports missing.

- [ ] **Step 3: Implement**

`useAiExits.ts`: rename the body of `startAiExitPolling` into

```ts
export function startQuietPolling<T>(opts: {
  get: () => Promise<unknown>;
  onData: (rows: T[]) => void;
  doc?: VisibilityDoc | null;
  intervalMs: number;
}): { stop: () => void } {
  /* the existing startAiExitPolling body, with AiExitRow → T and AI_EXITS_POLL_MS → opts.intervalMs */
}

export function startAiExitPolling(opts: {
  get: () => Promise<unknown>;
  onData: (rows: AiExitRow[]) => void;
  doc?: VisibilityDoc | null;
  intervalMs?: number;
}): { stop: () => void } {
  return startQuietPolling<AiExitRow>({ ...opts, intervalMs: opts.intervalMs ?? AI_EXITS_POLL_MS });
}
```

and in `AiExitRow` set `trigger?: 'AI' | 'MANUAL' | 'PRICE_TRIGGER';` (extend P1's union) and add `triggerId?: string | null;`.

```ts
// apps/web/src/hooks/useSentinelTriggers.ts
import { useEffect, useState } from 'react';
import api from '@/services/api';
import { startQuietPolling } from './useAiExits';

/** Wire shape of GET /api/sentinel-executor/triggers (api: SentinelExitTriggerDto). */
export interface SentinelTriggerRow {
  id: string;
  trackerId: string;
  verdictId: string;
  symbol: string;
  instrument: 'UNDERLYING' | 'PREMIUM' | null;
  op: 'BELOW' | 'ABOVE' | null;
  price: number | null;
  watchSymbol: string | null;
  refPrice: number | null;
  status: 'ARMED' | 'FIRED' | 'SUPERSEDED' | 'REJECTED' | 'EXPIRED';
  reason: string | null;
  armedAt: string | null;
  endedAt: string | null;
  firedAt: string | null;
  firedPrice: number | null;
  firedTickAt: string | null;
  createdAt: string;
}

/** An armed level changes at most once per verdict; 15 s while visible is plenty. */
export const TRIGGERS_POLL_MS = 15_000;

/** Fails quiet (403/404/cold API): no rows, the panel looks exactly as before. */
export function useSentinelTriggers(): { rows: SentinelTriggerRow[] } {
  const [rows, setRows] = useState<SentinelTriggerRow[]>([]);
  useEffect(() => {
    const p = startQuietPolling<SentinelTriggerRow>({
      get: async () => (await api.get<SentinelTriggerRow[]>('/sentinel-executor/triggers', { params: { limit: 20 } })).data,
      onData: setRows,
      intervalMs: TRIGGERS_POLL_MS,
    });
    return () => p.stop();
  }, []);
  return { rows };
}
```

```ts
// apps/web/src/components/charts/triggerView.ts
import type { SentinelTriggerRow } from '@/hooks/useSentinelTriggers';
import { istTime } from './aiExitView';

const sign = (op: SentinelTriggerRow['op']) => (op === 'ABOVE' ? '>' : '<');

export function armedForTracker(rows: SentinelTriggerRow[], trackerId: string): SentinelTriggerRow | null {
  return rows.find((r) => r.trackerId === trackerId && r.status === 'ARMED') ?? null;
}

/** "auto-exit if CRUDEOIL19NOV26FUT < 8930, armed 22:33 IST" — null unless ARMED. */
export function armedTriggerLine(r: SentinelTriggerRow): string | null {
  if (r.status !== 'ARMED' || r.price == null || !r.op) return null;
  const at = r.armedAt ? `, armed ${istTime(r.armedAt)}` : '';
  return `auto-exit if ${r.watchSymbol ?? r.symbol} ${sign(r.op)} ${r.price}${at}`;
}

export function triggerHistoryLine(r: SentinelTriggerRow): string {
  const level = r.price != null && r.op ? ` — ${sign(r.op)} ${r.price} on ${r.watchSymbol ?? r.symbol}` : '';
  if (r.status === 'FIRED') {
    const when = r.firedAt ? ` (${istTime(r.firedAt)})` : '';
    return `FIRED at ${r.firedPrice ?? '?'}${when}${level}`;
  }
  return `${r.status}${r.reason ? `: ${r.reason}` : ''}${level}`;
}
```

`aiExitView.ts`: add `source: 'AI' | 'MANUAL' | 'PRICE_TRIGGER'` to `AiExitRowView` and `source: r.trigger ?? 'AI',` in the returned object. `AiExitsList.tsx`: after the status badge render

```tsx
              {v.source !== 'AI' && (
                <span className="rounded border border-[var(--color-border-subtle)] px-1 py-0.5 text-[10px] text-[var(--color-text-secondary)]">
                  {v.source === 'PRICE_TRIGGER' ? 'price trigger' : 'manual'}
                </span>
              )}
```

(if P1 already renders a MANUAL badge, extend that element instead of adding a second one).

`SentinelPanel.tsx`: add an optional prop `triggers?: SentinelTriggerRow[]` (default `[]`); inside the card, directly after the `Invalidation:` paragraph:

```tsx
                {(() => {
                  const armed = armedForTracker(triggers, p.trackerId);
                  const line = armed ? armedTriggerLine(armed) : null;
                  return line ? (
                    <p className="mt-1 text-[11px] font-medium text-amber-400" title={armed?.verdictId}>
                      {line}
                    </p>
                  ) : null;
                })()}
```

`ChartsPage.tsx`: `const { rows: sentinelTriggers } = useSentinelTriggers();` next to `useSentinelPositions()` (~line 127), and `<SentinelPanel positions={sentinelHere} triggers={sentinelTriggers} />` (~line 709).

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/web && npx vitest run src/components/charts src/hooks && npx tsc --noEmit -p tsconfig.json`
Expected: PASS; tsc exit 0. (Visual check is the owner's — no browser driving.)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/hooks/useAiExits.ts apps/web/src/hooks/useAiExits.spec.ts apps/web/src/hooks/useSentinelTriggers.ts apps/web/src/components/charts/triggerView.ts apps/web/src/components/charts/triggerView.test.ts apps/web/src/components/charts/SentinelPanel.tsx apps/web/src/components/charts/aiExitView.ts apps/web/src/components/charts/aiExitView.test.ts apps/web/src/components/charts/AiExitsList.tsx apps/web/src/pages/charts/ChartsPage.tsx
git commit -m "feat(web): armed auto-exit level on the sentinel panel; price-trigger exits labelled in AI exits

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Task 19: Whole-branch verification (integration branch, after all streams)

**Files:** none new.

- [ ] **Step 1: Integrate**

On `feature/sentinel-price-triggers` (branched from `main` after P1–P3): merge S, A, C, B, D in that order (`git merge --no-ff feature/trg-…`), resolving only P1-file conflicts by keeping both sides' additions.

- [ ] **Step 2: Full test + typecheck**

Run: `cd apps/api && npx jest src/modules/trade-sentinel src/modules/sentinel-executor src/modules/market-hub src/modules/trade-tracker src/common/schedule && npx tsc --noEmit -p tsconfig.json`
Run: `cd apps/web && npx vitest run && npx tsc --noEmit -p tsconfig.json`
Expected: all PASS, tsc exit 0; `cron-timezone.spec.ts` untouched and green; golden suite green without `-u`.

- [ ] **Step 3: Structural greps (each must print nothing)**

```bash
grep -rn "trade-sentinel" apps/api/src/modules/sentinel-executor --include=*.ts | grep -v "\.spec\.ts" | grep "from '"
grep -rn "sentinel-executor" apps/api/src/modules/trade-sentinel --include=*.ts | grep "from '"
grep -rn "@Cron(" apps/api/src/modules/sentinel-executor apps/api/src/modules/trade-sentinel/services/tick-tripwire.service.ts
grep -rln "placeOrderClassified(" apps/api/src/modules/sentinel-executor --include=*.ts | grep -v "\.spec\.ts" | grep -v "services/sentinel-exit-executor.service.ts"
```

- [ ] **Step 4: Boot-inert smoke (local, all flags off)**

Run the API locally with `SENTINEL_TRIGGERS_ENABLED` unset against a disposable DB and confirm the log has `[ai-trigger] disabled (SENTINEL_TRIGGERS_ENABLED is not true)` and NO other `[ai-trigger]` line; `/healthz/detail` `hub.slots.live` unchanged from `main`.

- [ ] **Step 5: Request review**

Use superpowers:requesting-code-review on the integration branch with the Review Focus list as the brief. No merge to `main`, no push, until the owner says so.

---

## Production Gate

Deploy is the owner's (no SSH from this plan). Migration `20261013150000_sentinel_exit_triggers` auto-applies on deploy.

**Gate 0 — deployed, everything off (same day).**
- [ ] `\d sentinel_exit_triggers` shows the table, the partial unique index `sentinel_exit_triggers_one_armed_per_tracker`, both CHECKs; `\d sentinel_verdicts` shows `exitTrigger jsonb`.
- [ ] API log: `[ai-trigger] disabled …`; no `[ai-trigger] ENABLED`. Sentinel verdict rows written after deploy carry `promptVersion` `v6/t1` (or `v2.3/t1` with cues off) and, on HOLD/EXIT_ARMED, a non-null `exitTrigger` most of the time: `SELECT verdict, exitTrigger IS NOT NULL AS has, count(*) FROM sentinel_verdicts WHERE "createdAt" > now() - interval '1 day' GROUP BY 1,2;`
- [ ] Any `exitTrigger ->> 'problem'` rows: read them; >10 % malformed means the prompt needs work before Gate 1.
- [ ] CPU/memory on the VPS unchanged (`top`, `/healthz/detail`).

**Gate 1 — dry-run session (one NSE session + one MCX evening, owner present).** Set `SENTINEL_TRIGGERS_ENABLED=true`, keep `AI_AUTO_EXIT_ENABLED=true`, `AI_AUTO_EXIT_MODE=dry-run`, `MARKET_HUB_ENABLED=true`, `HUB_PRICES_POSITIONS=true`; restart.
- [ ] Log `[ai-trigger] ENABLED mode=dry-run confirm=2 ticks/1000 ms …`.
- [ ] Every new HOLD/EXIT_ARMED verdict with a trigger yields exactly one `sentinel_exit_triggers` row within ~5 s (`ARMED` or `REJECTED` with a reason). `SELECT status, reason, count(*) FROM sentinel_exit_triggers GROUP BY 1,2;` — reasons are plausible (no flood of `NO_HUB`, `NO_WATCH_TARGET`, `NO_FRESH_PRICE`).
- [ ] Charts → sentinel panel shows "auto-exit if … < …, armed HH:MM IST" for the armed position and it matches the table.
- [ ] At most one `ARMED` per tracker at all times: `SELECT "trackerId", count(*) FROM sentinel_exit_triggers WHERE status='ARMED' GROUP BY 1 HAVING count(*) > 1;` → 0 rows.
- [ ] `/healthz/detail` hub: `slots.live/cap` rose by at most the number of distinct MCX futures under UNDERLYING triggers; `criticalOverflow` noted.
- [ ] If a level is crossed: one `[ai-trigger] FIRED …` line, one `ai_exit_executions` row `verdictId = 'trg_…'`, status `DRY_RUN` (or a SKIPPED reason), and the `AI exits` list shows it as *price trigger*. Latency: `firedTickAt` → executions `createdAt` → the `DRY_RUN` update's `updatedAt` ≤ 2 s + broker reads (record the numbers in the ledger). No second row for that trigger.
- [ ] After the NSE close (15:30) and MCX close: armed rows become `EXPIRED: EXCHANGE_CLOSED` within 30 s.
- [ ] Part B: `[sentinel-tick] waking …` lines appear on level breaks, followed by a verdict whose `triggeredBy` contains `level-break` within the judge's latency; count of verdicts per position per hour not materially higher than Gate 0.
- [ ] Restart once mid-session: `[ai-trigger] rebuilt N armed trigger(s)` and the panel still shows them.

**Gate 2 — live (owner sign-off required).**
- [ ] Owner decides the broker stop-loss interplay: with a resting SL, fires end `SKIPPED: OPEN_ORDER_EXISTS` unless P2's `AI_AUTO_EXIT_CANCEL_PROTECTIVE=true`. Record the decision.
- [ ] `AI_AUTO_EXIT_MODE=live`; restart; first live fire watched by the owner: one `atM…` order in the Angel order book, row `PLACED` → `FILLED`, position flat, no second order.
- [ ] Rollback at any point: `SENTINEL_TRIGGERS_ENABLED=false` + restart → inert (ARMED rows stay in the table, harmless; on re-enable the boot rebuild expires stale ones).

## Verification Ledger

Filled during execution; every claim cites its evidence.

| # | Claim | Evidence (command / file) | Result |
|---|---|---|---|
| 1 | Migration is expand-only | Task 1 Step 4 grep | |
| 2 | Golden diff fully attributed, results unchanged | Task 4 Step 6 `golden-attrib.js` output | |
| 3 | v6 = v5 + rules + ownership only | Task 4 v5 hash test | |
| 4 | Packet never carries underlyingRef/contractRef | Task 5 packet test | |
| 5 | One fire per trigger (3 layers) | Task 12 `fires ONCE`, Task 11 `claimFire`, Task 13 `concurrent ticks` | |
| 6 | Bad ticks never fire | Task 9, Task 12 bad-tick table | |
| 7 | Tighten-only incl. instrument switch; null never disarms | Task 8, Task 11 SQL test, Task 13 LOOSENS test | |
| 8 | Closed exchange / stale → no fire; expiry at close | Task 12, Task 13 maintenance/boot | |
| 9 | Slot exhaustion: deferral → NO_FRESH_PRICE; quote ticks fire | Task 13, Task 12 | |
| 10 | Disabled = inert (4 switches + BOOT_JOBS) | Task 14 | |
| 11 | Sentinel isolation + walk includes tick-tripwire | Task 15 structure spec, Task 17 ENTRIES, Task 19 greps | |
| 12 | PRICE_TRIGGER takes AI guards, cap, mode; `at` tag; prefixes alike | Task 10 | |
| 13 | No new @Cron; timers gated | Task 19 Step 3 | |
| 14 | Gate 0 / 1 / 2 observations (latency numbers, slot delta) | production logs + SQL above | |

## Open Questions for the Owner

None block implementation (D1–D5 settle the design). One decision is needed before Gate 2, not before coding: whether live trigger exits should run with `AI_AUTO_EXIT_CANCEL_PROTECTIVE=true` (P2) — without it, a position that also has a resting broker SL will log `SKIPPED: OPEN_ORDER_EXISTS` on every fire and the broker SL remains the only exit.
