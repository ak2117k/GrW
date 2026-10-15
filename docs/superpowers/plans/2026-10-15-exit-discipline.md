# Exit Discipline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the live AI auto-exit from selling on premium noise while the thesis is intact: floors and giveback scaled to the instrument's own 1-minute noise, a code gate in the executor that lets an AI `EXIT_NOW` sell only on a broken thesis, hard risk or confirmed weakness, a persistence rule against flip-flop sells, and post-exit scoring (plus execution-quality capture and a replay tuning harness) so the multipliers get tuned on evidence.

**Architecture:** A new pure, framework-free folder `apps/api/src/modules/exit-discipline/` holds every rule (config, noise unit, noise-aware floor, giveback, gate clauses, persistence, packet reader, outcome maths, scorecard, replay engine). `trade-sentinel` uses it to measure `N` (DB read of hub tick-built 1-minute bars, no broker call), to put `flow.noiseUnit` and the noise-aware `money.greenFloorPrice/greenFloorArmed/floorBasis` into the packet, to scale the giveback sensor and to request a confirming look after an `EXIT_NOW`. `sentinel-executor` uses it to gate AI `EXIT_NOW` verdicts (only `trigger === 'AI'`; MANUAL and PRICE_TRIGGER never reach the gate), records every gate evaluation as JSON on the `ai_exit_executions` row, captures fills, and scores decisions into a new `ai_exit_outcomes` table. The two modules still never import each other; both import `exit-discipline`, which imports nothing outside itself.

**Tech Stack:** NestJS 11 + TypeScript, Prisma 6 (PostgreSQL/TimescaleDB), Jest (api), React + Vite + Vitest (web), ts-node scripts.

**Spec:** `docs/superpowers/specs/2026-10-14-exit-discipline-design.md` (owner-approved; defaults E1–E4 accepted). Read it before any task. Background for every executor guard: `docs/superpowers/plans/2026-10-12-sentinel-auto-exit.md`. Parallel work: `docs/superpowers/plans/2026-10-13-sentinel-price-triggers.md` (branch `feature/price-triggers`, worktree `.claude/worktrees/pt-main`).

**Base:** `main` @ 2aa9ee2 (+ the spec commit c34a1bd on `docs/exit-discipline`).

---

## Owner Decisions

| # | Decision | Default | Status |
|---|---|---|---|
| E1 | Multipliers as in spec §10 | `FLOOR_ARM_N=1.5 FLOOR_TRAIL_N=2.0 GIVEBACK_N=1.5 GATE_CLOSE_MIN=10 GATE_UNDERLYING_N=1.0 PERSIST_WINDOW_SEC=300 PERSIST_MIN_SEC=120 EXIT_OUTCOME_WINDOW_MIN=60` | approved |
| E2 | Gate bypass for MANUAL and PRICE_TRIGGER | bypass = any trigger other than `'AI'` | approved |
| E3 | Close-of-session hard exit for intraday products at ≤ 10 min; carry-forward exempt | product read from the broker position at gate time | approved |
| E4 | Score skipped (gated / awaiting) decisions too | yes | approved |
| **E5** | **Addition — execution quality capture:** decision LTP, order LTP, order-sent time, fill price/qty/time (exchange timestamp from the order book), slippage = fill − decision LTP, latency = fill time − decision time, on `ai_exit_executions`; fix the row that stays PLACED after a fill | on, not behind a flag (bug fix + observation only) | **owner may veto** |
| **E6** | **Addition — replay tuning harness:** `apps/api/scripts/exit-replay.ts` replays exported verdict packets + bars through the pure rules over a grid of multipliers and prints which exits would have executed and the resulting P&L | script only, never runs in the API | **owner may veto** |
| **E7** | **Addition — gate decisions as data:** every gate evaluation (pass, skip, bypass) stores which clause passed/failed with the measured numbers (`ai_exit_executions.gate` JSON); the daily scorecard reports "gate blocked N exits, helped ₹X / cost ₹Y" | on whenever the gate runs | **owner may veto** |

## Global Constraints

- **Real money.** `AI_AUTO_EXIT_MODE=live` for one user. The gate and persistence can only **PREVENT** an AI sell. They never place, cancel or modify an order, never run for `trigger !== 'AI'` (MANUAL, PRICE_TRIGGER), never block a hard-risk justification, never add a broker call, and never delay any exit by more than the overlap of their DB reads with the executor's existing pre-order broker reads (gate context is loaded concurrently with the session lease and bounded by `GATE_LOAD_TIMEOUT_MS = 2000`). A gate that cannot read its facts **fails open** (records `BYPASS: FACTS_UNREADABLE`, behaves as today) — see Open Question 1.
- `placeOrderClassified` and `cancelOrderClassified` keep exactly ONE call site each (`sentinel-exit-executor.service.ts`; `sentinel-executor.structure.spec.ts` pins it). No new file under `exit-discipline/` or `sentinel-executor/` calls a broker write.
- The gate runs **before** `cancelProtective` (a gated verdict never strips a stop-loss) and **before** the dry-run branch (dry-run rehearses the gate too).
- Config (`api.env`), parsed by one pure function used by both modules; a typo never widens AI selling: an out-of-range value falls back to its default and is reported once; `EXIT_DISCIPLINE_ENABLED` is ON unless it is exactly `false`. Off = today's behaviour for floor, giveback, gate and persistence (E5 fill capture and outcome scoring still run — they only observe).
- Isolation: no file under `sentinel-executor/` imports a specifier containing `trade-sentinel`; no file under `trade-sentinel/` imports `sentinel-executor`; no non-spec file under `exit-discipline/` imports anything outside `exit-discipline/` (pinned by Task 1). The cycle reachability walk in `trade-sentinel/services/sentinel-cycle.service.spec.ts` (FORBIDDEN `/execution|order|broker|angel|smart-?api|trade-engine|auto-trade/i`) stays green.
- `N` is read from the database (`candles_1m`, hub tick-built bars) — **no new broker historical call on the sentinel path.** Outcome scoring reads `candles_1m` first and falls back only to the hub's governed `HubCandleSource` (paced, no new Angel login).
- Migration: expand-only, `prisma/migrations/20261015120000_exit_discipline/` (after price-triggers' `20261013150000`): ten nullable columns on `ai_exit_executions`, one new table `ai_exit_outcomes`. No FK, no change to an existing column, index or CHECK.
- No `@Cron`. Background work = `setInterval` started from `SentinelExitPoller.onModuleInit` behind the poller's own gates (`bootJobsEnabled()`, `AI_AUTO_EXIT_ENABLED`, non-empty user list), `.unref()`'d, cleared in `onModuleDestroy`, single-flight, on timers SEPARATE from the 5-second exit poll (scoring must never delay an exit).
- Prompt: `SENTINEL_PROMPT_VERSION` and `SENTINEL_PROMPT_VERSION_NO_CUES` bump by one; golden snapshot regenerated in the same commit with every changed word attributed (Task 12). Numbering depends on merge order with price triggers — see "Merge points".
- Logs: gate lines `[exit-gate]`, fill settling `[exit-fill]`, scoring `[exit-outcome]`, daily scorecard `[exit-score]`, boot `[exit-discipline]`; executor lines keep `[ai-exit]`. Credentials never logged.
- Tests: `cd apps/api && npx jest <path> --ci --maxWorkers=2`; full suite **only** `cd apps/api && npx jest --ci --maxWorkers=2` (never default workers — OOM); web `cd apps/web && npx vitest run <path>`; typecheck `cd apps/api && npx tsc --noEmit -p tsconfig.json` and `cd apps/web && npx tsc --noEmit -p tsconfig.json`.
- Commits: Conventional Commits; `git add <explicit paths>` only — never `git add -A`, `git commit -a`, `git stash`. Every message ends with a blank line and `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. No push, no merge from a stream.
- Worktrees: `node_modules` junctions with ABSOLUTE targets (`cmd /c mklink /J "<wt>\apps\api\node_modules" "C:\Users\AryanKumar\Desktop\GrW\apps\api\node_modules"`, same for root `node_modules`, `apps\web\node_modules`, `packages\shared\node_modules`). Never `npm install`; `rmdir` the junctions before `git worktree remove`. `npx prisma generate` is fine; never `prisma migrate dev/reset` against a shared DB.

## Where the Code Differs from the Spec

1. **§6.1 "beyond `structure.nearestSupport`" can never be true as written.** `nearestSupport` is computed per packet as the nearest level *strictly below the current underlying* (`chart-context.adapter.ts` `levelCandidates` + strict nearest). The gate therefore uses the support/resistance recorded in the packet of the **last HOLD verdict** on the tracker (the level the trade was being held against): long exposure is broken when the underlying is below that HOLD's `nearestSupport`; short exposure when above that HOLD's `nearestResistance`.
2. **§6.3 VWAP and `N_underlying` are not packet fields.** VWAP exists as `structure.levelBook.value.vwap` (the underlying's 15m level book, `LevelsSnapshot.vwap`). The underlying's 1-minute ATR exists only when the hub has tick bars for it — and the hub does **not** watch MCX underlying futures (price-trigger plan, "Where the Code Differs" item 2). Fallback: `structure.levelBook.value.atr14` (15m ATR14) ÷ √15, method `atr14-15m-scaled`. Both now appear in `flow.noiseUnit.value.underlying`.
3. **§6 "computed from the verdict's own packet (no new reads)".** Four facts are not in the packet: the product type (E3 needs INTRADAY vs CARRYFORWARD; `trade_trackers` has no product column), the per-trade max loss (`core_risk_limits` `maxRiskPerTrade@ALL`), the daily-loss latch (`core_journal` row `dedupeKey = latch:<userId>:<istDate>`) and the verdict history (persistence, last HOLD). Product type and a FRESH contract LTP come from the executor's existing positions read (no new broker call); the other three are DB reads started concurrently with the session lease. The underlying side stays the packet's.
4. **§6.2 daily loss** has no tracker-level implementation: the only daily-loss state is trade-core's latch for the core engine's own ledger. The clause reads that latch; the owner's manual (tracker) losses do not feed it (Open Question 3).
5. **§5 excursion basis.** The floor (§4) arms off breakeven-after-charges; the giveback sensor's input (`TripwireInput`) carries no charges, so §5's excursion is measured from `entryPrice`, as the sensor does today.
6. **§7 persistence needs a second verdict, and nothing guarantees one soon.** The next verdict comes only when a sensor fires or the heartbeat (15 min) is due. Added: an `exit-confirm` wake in the sentinel cycle — while the latest live verdict on an open position is `EXIT_NOW`, re-judge after `PERSIST_MIN_SEC`, at most 3 consecutive times (Task 11). Persistence streak: `EXIT_ARMED` and `ESCALATE` do not break a streak, only `HOLD` does; the streak looks back at most 60 min.
7. **§3 "hub candle store / the live tick aggregator".** Tick bars are written only when `MARKET_HUB_ENABLED=true` and `HUB_CANDLES_ENABLED=true`, and only for instruments on a LIVE feed slot (critical-lane polled quotes do not build bars, `hub-engine.ts` feeds `CandleBuilder` from `LiveFeed.onPrice` only). Without bars `N` is unknown and the spec's fallbacks apply (fixed floor, 40 % giveback; the thesis gate still runs). Production Gate checks bars exist for the open contract.
8. **§8 "one paced historical call per exit".** Executor-side direct Angel calls risk a second login (`OwnerBrokerSessionProvider` refuses that on purpose). Outcomes read `candles_1m` first (tick bars, replaced by broker bars by the hub's nightly fix-up), then at most one `HubCandleSource.candles(ref,'1m',…)` (governor-paced) per outcome, retried until 24 h after the window, then `NO_DATA`.
9. **§9 "Prompt v7".** `main` is at `v5` / `v2.2`; price triggers takes `v6` / `v2.3`. This plan writes `v7` / `v2.4` assuming price triggers merges first; see Merge points.
10. **Spec names.** `givebackOffPeak` is a tripwire (`tripwires/giveback-off-peak.tripwire.ts`), not a packet field. `floorBasis` lands at `money.floorBasis`. `GIVEBACK_FRACTION` stays as the unknown-N fallback.
11. **§8 "written to the SP3 corpus outcome of the verdict".** Sentinel corpus rows are written by the Python importer with `sourceId = ai_calls.id`; the verdict id is `decision->>'verdictId'`. The outcome is merged into `outcome.exitOutcome` by that key; the importer's upsert already preserves an existing `outcome` (`importer.py` `COALESCE(EXCLUDED."outcome", …)`). A record imported after scoring is caught by a retry (Task 15).
12. **PLACED-not-FILLED bug (E5).** `confirm()` marks FILLED only when the positions read is already flat; Angel's positions lag the order book, so a `complete` order is left PLACED. Fix: a `complete` order is FILLED (with its fill), and a 30-s settle sweep resolves PLACED rows from the order book.
13. **Price-trigger rule R13 says PRICE_TRIGGER "takes the AI branch everywhere".** The gate deliberately does NOT: it runs on `trigger === 'AI'` only (E2).

## Merge points (price triggers in parallel)

| Point | What | Rule |
|---|---|---|
| M1 | `ExitTrigger` gains `'PRICE_TRIGGER'` (PT Task 10) | The gate condition is `trigger === 'AI'` (positive match) so it is correct before and after. Task 7's bypass test passes `'PRICE_TRIGGER' as never` on `main`; after PT merges, drop the cast. If PT's code introduces `const ai = trigger !== 'MANUAL'`, the gate MUST NOT reuse that variable. |
| M2 | Prompt numbering | Whichever of PT Task 4 / this Task 12 merges SECOND takes the next number and redoes its golden regeneration + attribution on top of the first. Planned here: `v7` / `v2.4` (PT first). If this merges first: `v6` / `v2.3`, and PT renumbers to `v7` / `v2.4`. The v2-hash test must restore BOTH changes' lines (each side exports its own "old line" constants). |
| M3 | Migrations | PT `20261013150000`, this `20261015120000`. Independent tables/columns; order-safe. |
| M4 | Outcome scoring of `trg_` rows | Included (`verdictId NOT LIKE 'man\_%'`); corpus write only for plain AI verdict ids (neither `man_` nor `trg_`). |
| M5 | `sentinel-exit-executor.service.spec.ts` | PT adds a `PRICE_TRIGGER` describe; this plan adds `exit gate` and `fill capture` describes. Both extend `harness()`: keep both option sets. |

## Planner Rulings

- **R1 — Where the rules live.** All decision maths is pure in `exit-discipline/`, with table-driven specs. Services only gather inputs and persist outputs. The replay engine and the tuning script call the same functions the API calls.
- **R2 — `N` contract.** `noiseFromBars(bars)`: valid bars (finite, > 0, high ≥ low), sorted, from the last `NOISE_LOOKBACK_MIN = 120` minutes of the same IST day; ≥ 14 bars → simple mean of the last 14 true ranges (`TR = max(h−l, |h−prevClose|, |l−prevClose|)`, the first bar's TR is `h−l`), method `atr14-1m`; 1–13 bars → `(maxHigh − minLow)/√bars`, method `range-sqrt-1m`; none, or `n ≤ 0` → `null` (a zero noise unit would put the floor on the peak).
- **R3 — `N` underlying.** 1-minute bars of the underlying when ≥ 1 bar exists (same rule); else `levelBook.value.atr14 / √15` (`atr14-15m-scaled`); else `null`.
- **R4 — Noise-aware floor** (pure `noiseAwareFloor`, spec §4). `dir = LONG ? 1 : −1`; `armPrice = breakeven + dir·armN·N`; armed when `(peak − breakeven)·dir ≥ armN·N` OR the NOISE latch is already armed (the fixed ₹150 latch does NOT arm the noise floor); unarmed level = `armPrice` (a target, as today); armed level = `dir>0 ? max(breakeven, peak − trailN·N) : min(breakeven, peak + trailN·N)`, then tighten-only against the previous armed noise level (durable via the last live packet when `money.floorBasis === 'noise'` and the entry price is unchanged). Rounded to 2 decimals. Breakeven = `breakevenPrice()` in `charges.ts` (the existing floor solve with margin 0).
- **R5 — Gate clauses** (pure `evaluateExitGate`, spec §6). Exposure from the tradingsymbol: `CE`+LONG, `PE`+SHORT, FUT/cash LONG = BULLISH; the rest BEARISH. `THESIS_INVALIDATION`: BULLISH `u < inv`, BEARISH `u > inv`; not measurable when `|inv−u|/u > 0.2` (scale sanity — an option-premium invalidation must never decide). `THESIS_LEVEL`: last HOLD's support/resistance (item 1 above). `HARD_MAX_LOSS`: `netPnlNow ≤ −maxRiskPerTrade`, `netPnlNow = min(packet netPnl, (ltpNow−entry)·qty·dir − packet charges)`. `HARD_SESSION_CLOSE`: product `INTRADAY` and minutes-to-close ≤ `GATE_CLOSE_MIN`. `HARD_EXPIRY`: packet `position.expiry` equals today's IST date and minutes-to-close ≤ 30. `HARD_DAILY_LOSS`: latch row exists. `FLOOR_BREACH_UNDERLYING_MOVE`: armed floor breached by `ltpNow` AND adverse underlying move since the last HOLD ≥ `GATE_UNDERLYING_N · N_u`. `FLOOR_BREACH_VWAP`: armed floor breached AND BULLISH `u < vwap` / BEARISH `u > vwap`. Each clause reports `pass: true | false | null` (null = not measurable) and its numbers.
- **R6 — Persistence** (pure `evaluatePersistence`, spec §7). History = live verdicts on the tracker in the 60 min before the current one, newest first (overnight-review rows excluded: `promptVersion !~ '^o[0-9]+/'`). Confirmed when the immediately previous verdict is `EXIT_NOW` within `PERSIST_WINDOW_SEC` (`CONSECUTIVE`), or the first `EXIT_NOW` after the most recent `HOLD` is ≥ `PERSIST_MIN_SEC` before the current one (`SUSTAINED`). Bypass (`BYPASS`) when any HARD_* clause passed, or `THESIS_INVALIDATION` passed with `|u−inv| ≥ 0.5·N_u`.
- **R7 — Gate outcome.** No justification → `SKIPPED: GATED_THESIS_INTACT`; justified but unconfirmed → `SKIPPED: AWAITING_CONFIRMATION`; else PASS (the sell proceeds through every existing guard). Disabled → `BYPASS: DISABLED`; unreadable facts → `BYPASS: FACTS_UNREADABLE` + one WARN. The record is written in the SAME `repo.update` as the planned order (zero extra writes on the PASS path).
- **R8 — Gate placement.** `gate.load(v, now)` starts right after the guards pass and before `withOwnerSession` (concurrent with the lease and the positions/order-book reads); `gate.decide(ctx, {ltpNow: first.ltp, productType: first.order.positionType, exchange, now})` runs after the FIRST `preOrderCheck` returns `ok`/`protective`, before `recordPlan`, the dry-run branch, `cancelProtective` and `place`.
- **R9 — E5 capture.** `recordPlan` writes `orderLtp` (positions LTP at pre-check). The two `status: 'PLACED'` updates and the post-send `finish` carry `orderSentAt`. `confirm()` treats book status `complete` as FILLED and stores `fillPrice` (`averageprice`), `fillQty` (`filledshares`), `fillAt` (`exchorderupdatetime` → `exchtime` → `updatetime`, IST `dd-MMM-yyyy HH:mm:ss`, else the observation time). The outcome job backfills `decisionLtp/decisionAt` (AI: packet `position.ltp` / `session.nowUtc`; MANUAL/trigger: `orderLtp` / row `createdAt`), `slippage = fillPrice − decisionLtp`, `latencyMs = fillAt − decisionAt`.
- **R10 — Outcome kinds.** `EXECUTED` (FILLED, or PLACED older than the window), `DRY_RUN`, `GATED` (`GATED_THESIS_INTACT`), `AWAITING` (`AWAITING_CONFIRMATION`). Decision price: EXECUTED `fillPrice ?? orderLtp`; others `orderLtp ?? decisionLtp`. Position side: exit SELL ⇒ LONG. Quantity in units: AI → packet `position.qty`; otherwise row `quantity`. MANUAL rows are never scored or written to the corpus.
- **R11 — Scheduling.** Settle sweep every 30 s, outcome pass every 60 s, each single-flight on its own timer; neither shares the exit poll's `running` flag.

## Review Focus

1. **MANUAL / PRICE_TRIGGER / hard-risk are never blocked or delayed** — a gate stub that blocks everything leaves MANUAL and `'PRICE_TRIGGER'` exits FILLED with zero gate calls; a hard-risk PASS sells on the FIRST `EXIT_NOW`; the gate load starts before the positions read. *Task 7 Step 1.*
2. **A gated verdict never strips a stop-loss** — `AI_AUTO_EXIT_CANCEL_PROTECTIVE=true` + a protective SL + a blocking gate ⇒ no cancel call, no place call. *Task 7 Step 1.*
3. **Puts and shorts** — every gate clause and the floor/giveback/outcome maths for BEARISH exposure (long PE, short CE, short FUT) and SHORT positions. *Tasks 3, 8, 14 Step 1.*
4. **Garbage packets** — old packets (no `flow.noiseUnit`, no `floorBasis`), unavailable blocks, a premium-scale invalidation, a non-numeric JSON value, a missing verdict row ⇒ defined behaviour (null clause / fixed basis / fail-open BYPASS), never a throw. *Tasks 5, 6 Step 1.*
5. **The evidence case** — the CRUDEOIL 16:31 sequence is GATED with the package on and passes immediately on a break below the invalidation; the real export, when present, is replayed by the same test and a failure is reported to the owner rather than tuned away. *Task 18 Step 1.*

## File Structure

```
prisma/
  schema.prisma                                            (M) AiExitExecution + 10 columns; model AiExitOutcome
  migrations/20261015120000_exit_discipline/migration.sql  (C)

apps/api/src/modules/exit-discipline/                      (C) pure, imports nothing outside itself
  config.ts (+spec)            EXIT_DISCIPLINE_* parse, fixed constants, DI token
  types.ts                     shared shapes (NoiseReading, NoiseUnitValue, GateRecordV1, MinuteBar…)
  exposure.ts (+spec)          contractKindOf, exposureOf
  noise.ts (+spec)             noiseFromBars, scaledUnderlyingNoise
  floor.ts (+spec)             noiseAwareFloor
  giveback.ts (+spec)          noiseGiveback
  packet-facts.ts (+spec)      readPacketFacts (stored packet → typed facts)
  gate.ts (+spec)              evaluateExitGate (clauses)
  persistence.ts (+spec)       evaluatePersistence
  decision.ts (+spec)          buildGateFacts, lastHoldRef, decideExit, bypassRecord, gateSummary, istDate
  outcome.ts (+spec)           computeExitOutcome, isWindowCovered, outcomeWindowEnd
  scorecard.ts (+spec)         scorecard, scorecardLine
  exit-discipline.structure.spec.ts                        import isolation
  replay/fixture.ts (+spec)    ExitFixtureV1 + validateFixture
  replay/synthetic-crude.ts    deterministic CRUDEOIL 2026-10-14 fixture builder
  replay/replay-exits.ts       replay engine
  replay/replay-exits.spec.ts  spec §12 replay (synthetic always; *.real.json when present)
  replay/fixtures/.gitignore   *.real.json

apps/api/src/modules/trade-sentinel/
  charges.ts (+spec)                     (M) breakevenPrice
  adapters/minute-bars.reader.ts (+spec) (C) candles_1m read, 20 s cache
  adapters/tick-source.adapter.ts (+spec)(M) tick.noise
  services/context-packet.service.ts (+spec) (M) TickSnapshot.noise/noiseFloor; money.floorBasis; flow.noiseUnit
  services/cycle-floor.ts (+spec)        (C) solveCycleFloor (pure)
  services/sentinel-cycle.service.ts (+spec) (M) noise floor latch, giveback noise input, exit-confirm wake
  tripwires/types.ts                     (M) TripwireInput.noise
  tripwires/giveback-off-peak.tripwire.ts (+spec) (M) noise rule
  tripwires/exit-confirm.ts (+spec)      (C) exitConfirmFire, withExitConfirm
  prompts/sentinel-system-prompt.ts      (M) v7 / v2.4
  services/sentinel-agent.service.spec.ts (M) version + hash tests
  golden/golden-fixtures.ts              (M) packet literals gain floorBasis + flow.noiseUnit
  golden/__snapshots__/sentinel-golden.spec.ts.snap (M) regenerated, attributed
  trade-sentinel.module.ts (+spec)       (M) EXIT_DISCIPLINE_CONFIG, MinuteBarsReader

apps/api/src/modules/sentinel-executor/
  domain/exit-fill.ts (+spec)            (C) parseAngelIstTimestamp, findOrderFill
  repositories/exit-gate.repository.ts (+spec)     (C) packet, history, limit, latch reads
  repositories/ai-exit-outcome.repository.ts (+spec) (C)
  repositories/ai-exit-execution.repository.ts (+spec) (M) AiExitPatch columns, placedAwaitingFill, scoringCandidates
  services/exit-gate.service.ts (+spec)  (C) load (bounded) + decide
  services/exit-fill-settler.service.ts (+spec) (C) PLACED → FILLED/REJECTED from the book
  services/exit-outcome.service.ts (+spec) (C) outcomes, E5 backfill, corpus, scorecard log
  services/sentinel-exit-executor.service.ts (+spec) (M) gate, orderLtp/orderSentAt, complete ⇒ FILLED
  services/sentinel-exit-poller.service.ts (+spec) (M) boot log, starts settler + outcomes timers
  dto/ai-exit-execution.dto.ts           (M) gate / quality / outcome
  controllers/sentinel-executor.controller.ts (+spec) (M) outcomes join, GET scorecard
  sentinel-executor.module.ts (+spec)    (M) providers
  sentinel-executor.structure.spec.ts    (M) gate is AI-only, no broker writes in new files

apps/api/scripts/
  export-exit-fixture.ts                 (C) DB → ExitFixtureV1 JSON
  sql/export-exit-fixture.sql            (C) psql-only alternative
  exit-replay.ts                         (C) E6 tuning harness

apps/web/src/
  hooks/useAiExits.ts                    (M) optional gate/quality/outcome fields
  components/charts/aiExitView.ts (+test)(M) gate / quality / outcome lines
  components/charts/AiExitsList.tsx      (M) render them

deploy/env/api.env.example               (M) EXIT_DISCIPLINE_* block
```

## Parallel Streams

| Stream | Worktree · branch | Tasks | Starts | Touches |
|---|---|---|---|---|
| F | `.claude/worktrees/ed-foundation` · `feature/ed-foundation` | 1 | now | `exit-discipline/{config,types,exposure}` |
| S | `.claude/worktrees/ed-schema` · `feature/ed-schema` | 2 | now | `prisma/` |
| A | `.claude/worktrees/ed-gate` · `feature/ed-gate` | 3, 4, 5, 6 after F; 7 after S (rebase onto S) | after Task 1 | `exit-discipline/{gate,persistence,decision,packet-facts}`, `sentinel-executor/` |
| B | `.claude/worktrees/ed-sentinel` · `feature/ed-sentinel` | 8, 9, 10, 11, 12 | after Task 1 | `exit-discipline/{noise,floor,giveback}`, `trade-sentinel/` |
| C | `.claude/worktrees/ed-outcomes` · `feature/ed-outcomes` | 14 after F; 13, 15 after S; 16 after 15 (+ web) | after Task 1 | `exit-discipline/{outcome,scorecard}`, `sentinel-executor/` (fill, settler, outcomes, DTO, controller), `apps/web/` |
| D | `.claude/worktrees/ed-replay` · `feature/ed-replay` | 17 after F; 18 after A's Task 5 and B's Tasks 8–9 (merge those commits in); 19 after 18 + 14 | after Task 1 | `exit-discipline/replay/`, `apps/api/scripts/` |
| — | integration `feature/exit-discipline` | 20 | all done | — |

Dependency summary: 1 → {3,4,5,8,14,17}; 2 → {7,13,15}; 3+4+5 → 6 → 7; 8 → 9 → 10 → 11 → 12; 14 → 15 → 16; 13 before 15 in C; {5,8,9} → 18 → 19; all → 20.

Conflict map: A (Task 7) and C (Tasks 13, 15) both edit `sentinel-exit-executor.service.ts`, its spec, the poller and the module — different hunks (A: `execute()` after the first pre-check; C: `place()`, `confirm()`, `recordPlan`, `finish` extras). Integration merges S → F → A → B → C → D; C rebases onto A before Task 16's commit. Each stream's coordinator creates the worktree with the junctions from Global Constraints.

---

## Task 1: Shared foundation — config, types, exposure (Stream F)

**Files:**
- Create: `apps/api/src/modules/exit-discipline/config.ts`, `config.spec.ts`
- Create: `apps/api/src/modules/exit-discipline/types.ts`
- Create: `apps/api/src/modules/exit-discipline/exposure.ts`, `exposure.spec.ts`
- Create: `apps/api/src/modules/exit-discipline/exit-discipline.structure.spec.ts`
- Modify: `deploy/env/api.env.example`

**Interfaces:**
- Produces: `EXIT_DISCIPLINE_CONFIG = 'EXIT_DISCIPLINE_CONFIG'`; `interface ExitDisciplineConfig { enabled; floorArmN; floorTrailN; givebackN; gateCloseMin; gateUnderlyingN; persistWindowSec; persistMinSec; outcomeWindowMin; problems: string[] }`; `EXIT_DISCIPLINE_DEFAULTS`; constants `EXPIRY_CLOSE_MIN=30`, `CLEAR_MARGIN_N=0.5`, `INVALIDATION_SCALE_TOLERANCE=0.2`, `STREAK_LOOKBACK_MIN=60`, `NOISE_LOOKBACK_MIN=120`, `ATR_PERIOD=14`, `EXIT_CONFIRM_MAX_RELOOKS=3`, `GATE_LOAD_TIMEOUT_MS=2000`; `parseExitDisciplineConfig(env): ExitDisciplineConfig`; `describeExitDiscipline(cfg): string`.
- Produces (types.ts): `PositionSide`, `Exposure`, `MinuteBar`, `NoiseMethod`, `NoiseReading`, `NoiseUnitValue`, `FloorBasis`, `NoiseFloor`, `ClauseId`, `ClauseResult`, `PersistenceResult`, `GateOutcome`, `Justification`, `GateFactsSnapshot`, `GateRecordV1`, `OutcomeKind`.
- Produces (exposure.ts): `type ContractKind = 'CE'|'PE'|'FUT'|'CASH'`; `contractKindOf(symbol): ContractKind`; `exposureOf(symbol, side): Exposure`.

- [ ] **Step 1: Write the failing tests**

`config.spec.ts`:

```ts
import { EXIT_DISCIPLINE_DEFAULTS, describeExitDiscipline, parseExitDisciplineConfig } from './config';

describe('parseExitDisciplineConfig', () => {
  it('empty env = spec §10 defaults, ON', () => {
    const c = parseExitDisciplineConfig({});
    expect(c).toEqual({ enabled: true, ...EXIT_DISCIPLINE_DEFAULTS, problems: [] });
    expect(EXIT_DISCIPLINE_DEFAULTS).toEqual({
      floorArmN: 1.5, floorTrailN: 2.0, givebackN: 1.5, gateCloseMin: 10, gateUnderlyingN: 1.0,
      persistWindowSec: 300, persistMinSec: 120, outcomeWindowMin: 60,
    });
  });

  it('only the exact word false turns it off; a typo stays ON (the narrower behaviour) and is reported', () => {
    expect(parseExitDisciplineConfig({ EXIT_DISCIPLINE_ENABLED: 'false' }).enabled).toBe(false);
    expect(parseExitDisciplineConfig({ EXIT_DISCIPLINE_ENABLED: 'true' }).enabled).toBe(true);
    const typo = parseExitDisciplineConfig({ EXIT_DISCIPLINE_ENABLED: 'flase' });
    expect(typo.enabled).toBe(true);
    expect(typo.problems).toEqual([expect.stringMatching(/EXIT_DISCIPLINE_ENABLED=flase/)]);
  });

  it.each([
    ['FLOOR_ARM_N', '2.5', 'floorArmN', 2.5],
    ['FLOOR_TRAIL_N', '3', 'floorTrailN', 3],
    ['GIVEBACK_N', '1', 'givebackN', 1],
    ['GATE_CLOSE_MIN', '15', 'gateCloseMin', 15],
    ['GATE_UNDERLYING_N', '0.5', 'gateUnderlyingN', 0.5],
    ['PERSIST_WINDOW_SEC', '600', 'persistWindowSec', 600],
    ['PERSIST_MIN_SEC', '60', 'persistMinSec', 60],
    ['EXIT_OUTCOME_WINDOW_MIN', '90', 'outcomeWindowMin', 90],
  ])('%s=%s is accepted', (key, raw, field, value) => {
    const c = parseExitDisciplineConfig({ [key]: raw });
    expect((c as unknown as Record<string, number>)[field]).toBe(value);
    expect(c.problems).toEqual([]);
  });

  it.each([
    ['FLOOR_ARM_N', '0'], ['FLOOR_ARM_N', '9'], ['FLOOR_TRAIL_N', 'abc'], ['GIVEBACK_N', '-1'],
    ['GATE_CLOSE_MIN', '1.5'], ['GATE_CLOSE_MIN', '120'], ['GATE_UNDERLYING_N', '10'],
    ['PERSIST_WINDOW_SEC', '5'], ['PERSIST_MIN_SEC', '2000'], ['EXIT_OUTCOME_WINDOW_MIN', '5'],
  ])('%s=%s is out of range → default + one problem', (key, raw) => {
    const c = parseExitDisciplineConfig({ [key]: raw });
    expect(c.problems).toEqual([expect.stringContaining(`${key}=${raw}`)]);
    expect(c).toMatchObject({ ...EXIT_DISCIPLINE_DEFAULTS });
  });

  it('PERSIST_MIN_SEC larger than PERSIST_WINDOW_SEC is allowed (independent rules) but blank values are defaults', () => {
    expect(parseExitDisciplineConfig({ PERSIST_MIN_SEC: ' ' }).persistMinSec).toBe(120);
  });

  it('describeExitDiscipline names every multiplier (the boot log)', () => {
    expect(describeExitDiscipline(parseExitDisciplineConfig({}))).toBe(
      'ON floorArmN=1.5 floorTrailN=2 givebackN=1.5 gateCloseMin=10 gateUnderlyingN=1 persist=300s/120s outcomeWindow=60m',
    );
    expect(describeExitDiscipline(parseExitDisciplineConfig({ EXIT_DISCIPLINE_ENABLED: 'false' }))).toMatch(/^OFF /);
  });
});
```

`exposure.spec.ts`:

```ts
import { contractKindOf, exposureOf } from './exposure';

describe('contractKindOf', () => {
  it.each([
    ['CRUDEOIL17NOV269000CE', 'CE'], ['NIFTY28OCT2624000PE', 'PE'], ['CRUDEOIL19NOV26FUT', 'FUT'],
    ['NIFTY28OCT26FUT', 'FUT'], ['RELIANCE-EQ', 'CASH'], ['RELIANCE', 'CASH'], ['', 'CASH'],
  ])('%s → %s', (s, k) => expect(contractKindOf(s)).toBe(k));
});

describe('exposureOf — direction the UNDERLYING must move to help the position', () => {
  it.each([
    ['CRUDEOIL17NOV269000CE', 'LONG', 'BULLISH'], ['CRUDEOIL17NOV269000CE', 'SHORT', 'BEARISH'],
    ['NIFTY28OCT2624000PE', 'LONG', 'BEARISH'], ['NIFTY28OCT2624000PE', 'SHORT', 'BULLISH'],
    ['CRUDEOIL19NOV26FUT', 'LONG', 'BULLISH'], ['CRUDEOIL19NOV26FUT', 'SHORT', 'BEARISH'],
    ['RELIANCE-EQ', 'LONG', 'BULLISH'], ['RELIANCE-EQ', 'SHORT', 'BEARISH'],
  ] as const)('%s %s → %s', (s, side, e) => expect(exposureOf(s, side)).toBe(e));
});
```

`exit-discipline.structure.spec.ts`:

```ts
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, resolve } from 'path';

const IMPORT = /from\s+['"]([^'"]+)['"]/g;
function files(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) files(p, out);
    else if (p.endsWith('.ts') && !p.endsWith('.spec.ts')) out.push(p);
  }
  return out;
}

describe('exit-discipline is pure and self-contained', () => {
  it('no source file imports anything outside exit-discipline (type-only @prisma/client excepted)', () => {
    const root = __dirname;
    const offenders: string[] = [];
    for (const f of files(root)) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(IMPORT)) {
        const spec = m[1];
        if (spec.startsWith('.')) {
          if (!resolve(join(f, '..'), spec).startsWith(root)) offenders.push(`${f}: ${spec}`);
        } else if (!(spec === '@prisma/client' && /import\s+type/.test(text.slice(Math.max(0, m.index! - 200), m.index)))) {
          offenders.push(`${f}: ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no source file touches Nest, Prisma at runtime, timers or the broker', () => {
    const bad = files(__dirname).filter((f) =>
      /@nestjs|new PrismaClient|setInterval|setTimeout|placeOrder|cancelOrder|getCandles/.test(readFileSync(f, 'utf8')));
    expect(bad).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && npx jest src/modules/exit-discipline --ci --maxWorkers=2`
Expected: FAIL — `Cannot find module './config'` / `'./exposure'` (the structure spec passes vacuously until files exist; that is fine).

- [ ] **Step 3: Implement**

`config.ts`:

```ts
/**
 * Exit discipline (docs/superpowers/specs/2026-10-14-exit-discipline-design.md §10).
 * One pure parse shared by trade-sentinel and sentinel-executor. A typo never
 * widens AI selling: unknown/out-of-range values fall back to the default and
 * are reported; the master switch is OFF only for the exact word `false`.
 */
export const EXIT_DISCIPLINE_CONFIG = 'EXIT_DISCIPLINE_CONFIG';

export const EXIT_DISCIPLINE_DEFAULTS = {
  floorArmN: 1.5,
  floorTrailN: 2.0,
  givebackN: 1.5,
  gateCloseMin: 10,
  gateUnderlyingN: 1.0,
  persistWindowSec: 300,
  persistMinSec: 120,
  outcomeWindowMin: 60,
} as const;

/** Spec text, not tunables. */
export const EXPIRY_CLOSE_MIN = 30;
export const CLEAR_MARGIN_N = 0.5;
export const INVALIDATION_SCALE_TOLERANCE = 0.2;
export const STREAK_LOOKBACK_MIN = 60;
export const NOISE_LOOKBACK_MIN = 120;
export const ATR_PERIOD = 14;
export const EXIT_CONFIRM_MAX_RELOOKS = 3;
export const GATE_LOAD_TIMEOUT_MS = 2000;

export interface ExitDisciplineConfig {
  enabled: boolean;
  floorArmN: number;
  floorTrailN: number;
  givebackN: number;
  gateCloseMin: number;
  gateUnderlyingN: number;
  persistWindowSec: number;
  persistMinSec: number;
  outcomeWindowMin: number;
  problems: string[];
}

type Env = Record<string, string | undefined>;

function num(env: Env, key: string, fallback: number, ok: (n: number) => boolean, problems: string[]): number {
  const raw = env[key];
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (Number.isFinite(n) && ok(n)) return n;
  problems.push(`${key}=${raw} is out of range — using ${fallback}`);
  return fallback;
}
const int = (lo: number, hi: number) => (n: number) => Number.isInteger(n) && n >= lo && n <= hi;
const real = (lo: number, hi: number) => (n: number) => n >= lo && n <= hi;

export function parseExitDisciplineConfig(env: Env): ExitDisciplineConfig {
  const problems: string[] = [];
  const raw = (env.EXIT_DISCIPLINE_ENABLED ?? '').trim();
  if (raw !== '' && raw !== 'true' && raw !== 'false') {
    problems.push(`EXIT_DISCIPLINE_ENABLED=${raw} is not true|false — keeping exit discipline ON`);
  }
  const d = EXIT_DISCIPLINE_DEFAULTS;
  return {
    enabled: raw !== 'false',
    floorArmN: num(env, 'FLOOR_ARM_N', d.floorArmN, real(0.5, 5), problems),
    floorTrailN: num(env, 'FLOOR_TRAIL_N', d.floorTrailN, real(0.5, 6), problems),
    givebackN: num(env, 'GIVEBACK_N', d.givebackN, real(0.5, 6), problems),
    gateCloseMin: num(env, 'GATE_CLOSE_MIN', d.gateCloseMin, int(0, 60), problems),
    gateUnderlyingN: num(env, 'GATE_UNDERLYING_N', d.gateUnderlyingN, real(0.25, 4), problems),
    persistWindowSec: num(env, 'PERSIST_WINDOW_SEC', d.persistWindowSec, int(30, 1800), problems),
    persistMinSec: num(env, 'PERSIST_MIN_SEC', d.persistMinSec, int(0, 900), problems),
    outcomeWindowMin: num(env, 'EXIT_OUTCOME_WINDOW_MIN', d.outcomeWindowMin, int(15, 240), problems),
    problems,
  };
}

export function describeExitDiscipline(c: ExitDisciplineConfig): string {
  return `${c.enabled ? 'ON' : 'OFF'} floorArmN=${c.floorArmN} floorTrailN=${c.floorTrailN} givebackN=${c.givebackN} ` +
    `gateCloseMin=${c.gateCloseMin} gateUnderlyingN=${c.gateUnderlyingN} ` +
    `persist=${c.persistWindowSec}s/${c.persistMinSec}s outcomeWindow=${c.outcomeWindowMin}m`;
}
```

`types.ts`:

```ts
export type PositionSide = 'LONG' | 'SHORT';
/** The direction the UNDERLYING must move to help the position. */
export type Exposure = 'BULLISH' | 'BEARISH';

/** One 1-minute bar; `ts` = bar start, ms epoch (HubCandle without volume/oi). */
export interface MinuteBar { ts: number; open: number; high: number; low: number; close: number }

export type NoiseMethod = 'atr14-1m' | 'range-sqrt-1m' | 'atr14-15m-scaled';
export interface NoiseReading { n: number; method: NoiseMethod; bars: number; at: string }

/**
 * `flow.noiseUnit.value` in the sentinel packet. WIRE CONTRACT: written by
 * trade-sentinel, read by sentinel-executor and the replay engine.
 * `contract` is on the contract's own scale (premium); `underlying` on the underlying's.
 */
export interface NoiseUnitValue { contract: NoiseReading | null; underlying: NoiseReading | null }

/** `money.floorBasis`: how money.greenFloorPrice was set. Missing in pre-v7 packets ⇒ 'fixed'. */
export type FloorBasis = 'noise' | 'fixed';
export interface NoiseFloor { basis: 'noise'; armed: boolean; level: number; armPrice: number; n: number }

export type ClauseId =
  | 'THESIS_INVALIDATION' | 'THESIS_LEVEL'
  | 'HARD_MAX_LOSS' | 'HARD_SESSION_CLOSE' | 'HARD_EXPIRY' | 'HARD_DAILY_LOSS'
  | 'FLOOR_BREACH_UNDERLYING_MOVE' | 'FLOOR_BREACH_VWAP';
/** `pass: null` = could not be measured (an input was missing). */
export interface ClauseResult {
  id: ClauseId;
  pass: boolean | null;
  measured: Record<string, number | string | boolean | null>;
  note: string;
}

export interface PersistenceResult {
  confirmed: boolean;
  rule: 'BYPASS' | 'CONSECUTIVE' | 'SUSTAINED' | null;
  previous: { id: string; verdict: string; ageSec: number } | null;
  streakStart: { id: string; ageSec: number } | null;
}

export type GateOutcome = 'PASS' | 'GATED_THESIS_INTACT' | 'AWAITING_CONFIRMATION' | 'BYPASS';
export type Justification = 'THESIS_BROKEN' | 'HARD_RISK' | 'CONFIRMED_FLOOR_BREACH';

/** The numbers the gate judged, copied onto the row (E7). */
export interface GateFactsSnapshot {
  exposure: Exposure | null;
  positionSide: PositionSide;
  ltpNow: number;
  underlying: number | null;
  invalidation: number | null;
  holdRef: { id: string; underlying: number | null; support: number | null; resistance: number | null; at: string } | null;
  vwap: number | null;
  nContract: number | null;
  nUnderlying: number | null;
  floor: { price: number | null; armed: boolean; basis: FloorBasis };
  netPnlNow: number | null;
  maxLossPerTrade: number | null;
  minutesToClose: number | null;
  productType: string | null;
  isExpiryDay: boolean;
  dailyLossLatched: boolean;
}

/** `ai_exit_executions.gate` (E7). */
export interface GateRecordV1 {
  v: 1;
  outcome: GateOutcome;
  bypassReason?: 'DISABLED' | 'FACTS_UNREADABLE';
  error?: string;
  justification: Justification | null;
  clauses: ClauseResult[];
  persistence: PersistenceResult | null;
  facts: GateFactsSnapshot | null;
  cfg: { floorArmN: number; floorTrailN: number; gateCloseMin: number; gateUnderlyingN: number; persistWindowSec: number; persistMinSec: number };
  evaluatedAt: string;
}

export type OutcomeKind = 'EXECUTED' | 'DRY_RUN' | 'GATED' | 'AWAITING';
```

`exposure.ts`:

```ts
import type { Exposure, PositionSide } from './types';

export type ContractKind = 'CE' | 'PE' | 'FUT' | 'CASH';

/** From the broker tradingsymbol: `…9000CE`, `…24000PE`, `…FUT`; anything else is cash. */
export function contractKindOf(symbol: string): ContractKind {
  const s = String(symbol ?? '').toUpperCase().trim();
  if (/\d(CE)$/.test(s)) return 'CE';
  if (/\d(PE)$/.test(s)) return 'PE';
  if (/FUT$/.test(s)) return 'FUT';
  return 'CASH';
}

/** A put flips the direction: long PE / short CE are hurt by a RISING underlying. */
export function exposureOf(symbol: string, side: PositionSide): Exposure {
  const put = contractKindOf(symbol) === 'PE';
  const long = side === 'LONG';
  return long !== put ? 'BULLISH' : 'BEARISH';
}
```

`deploy/env/api.env.example` — append after the `AI_AUTO_EXIT_*` block:

```
# Exit discipline (docs/superpowers/specs/2026-10-14-exit-discipline-design.md). ON unless exactly false.
# Off = today's floor/giveback and no AI exit gate/persistence (fill capture + outcome scoring still run).
EXIT_DISCIPLINE_ENABLED=true
# Floor arms when the best excursion is >= FLOOR_ARM_N noise units beyond breakeven-after-charges,
# then trails the peak by FLOOR_TRAIL_N units (tighten-only).
FLOOR_ARM_N=1.5
FLOOR_TRAIL_N=2.0
# Giveback sensor fires only on a pullback >= GIVEBACK_N units after an excursion >= FLOOR_ARM_N units.
GIVEBACK_N=1.5
# Gate: intraday positions may be exited by the AI in the last GATE_CLOSE_MIN minutes (hard risk).
GATE_CLOSE_MIN=10
# Gate: a floor breach counts only if the underlying moved >= GATE_UNDERLYING_N of its noise units against the position.
GATE_UNDERLYING_N=1.0
# Persistence: a second EXIT_NOW within PERSIST_WINDOW_SEC, or EXIT_NOW sustained >= PERSIST_MIN_SEC without a HOLD.
PERSIST_WINDOW_SEC=300
PERSIST_MIN_SEC=120
# Post-exit scoring window (minutes after the decision, capped at the exchange close).
EXIT_OUTCOME_WINDOW_MIN=60
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd apps/api && npx jest src/modules/exit-discipline --ci --maxWorkers=2`
Expected: PASS (config 30+ cases, exposure 15, structure 2).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/exit-discipline/config.ts apps/api/src/modules/exit-discipline/config.spec.ts apps/api/src/modules/exit-discipline/types.ts apps/api/src/modules/exit-discipline/exposure.ts apps/api/src/modules/exit-discipline/exposure.spec.ts apps/api/src/modules/exit-discipline/exit-discipline.structure.spec.ts deploy/env/api.env.example
git commit -m "feat(exit-discipline): shared config, wire types and exposure rules

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Schema — gate/quality columns + `ai_exit_outcomes` (Stream S)

**Files:**
- Modify: `prisma/schema.prisma` (`model AiExitExecution`; append `model AiExitOutcome` after it)
- Create: `prisma/migrations/20261015120000_exit_discipline/migration.sql`

**Interfaces:**
- Produces: `AiExitExecution.{gate Json?, decisionLtp Float?, decisionAt DateTime?, orderLtp Float?, orderSentAt DateTime?, fillPrice Float?, fillQty Int?, fillAt DateTime?, slippage Float?, latencyMs Int?}`; `prisma.aiExitOutcome` delegate and `AiExitOutcome` type.

- [ ] **Step 1: Edit the schema**

In `model AiExitExecution`, after `verdictReason String`:

```prisma
  /// Exit discipline E7: the gate's evaluation (GateRecordV1), AI rows only.
  gate          Json?
  /// E5 execution quality. decision* = what the decision saw; order* = at send; fill* = the broker's fill.
  decisionLtp   Float?
  decisionAt    DateTime?
  orderLtp      Float?
  orderSentAt   DateTime?
  fillPrice     Float?
  fillQty       Int?
  fillAt        DateTime?
  /// fillPrice − decisionLtp (raw, contract scale)
  slippage      Float?
  /// fillAt − decisionAt, ms
  latencyMs     Int?
```

After `model AiExitExecution { … }`:

```prisma
/// Exit discipline §8: what the price did after an AI exit decision (executed or skipped).
/// One row per ai_exit_executions row scored. No FK (mirrors ai_exit_executions).
model AiExitOutcome {
  id            String    @id @default(cuid())
  executionId   String    @unique
  userId        String
  verdictId     String
  trackerId     String
  symbol        String
  exchange      String
  token         String
  kind          String    // EXECUTED | DRY_RUN | GATED | AWAITING
  positionSide  String    // LONG | SHORT
  qty           Float
  decisionPrice Float
  decisionAt    DateTime
  windowEnd     DateTime
  status        String    // PENDING | DONE | NO_DATA
  attempts      Int       @default(0)
  barsUsed      Int?
  maxAfter      Float?
  minAfter      Float?
  closeAt15     Float?
  closeAt30     Float?
  closeAt60     Float?
  closeAtEnd    Float?
  missedPnl     Float?
  savedPnl      Float?
  netAtEnd      Float?
  dataSource    String?   // candles_1m | hub-fill
  note          String?
  computedAt    DateTime?
  corpusAt      DateTime?
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt

  @@index([userId, decisionAt])
  @@index([status, windowEnd])
  @@map("ai_exit_outcomes")
}
```

- [ ] **Step 2: Write the migration**

`prisma/migrations/20261015120000_exit_discipline/migration.sql`:

```sql
-- Exit discipline (docs/superpowers/plans/2026-10-15-exit-discipline.md Task 2).
-- Expand-only: ten nullable columns on ai_exit_executions, one new table.
-- No existing column, index, CHECK or function is touched. No FK.

ALTER TABLE "ai_exit_executions"
  ADD COLUMN "gate" JSONB,
  ADD COLUMN "decisionLtp" DOUBLE PRECISION,
  ADD COLUMN "decisionAt" TIMESTAMP(3),
  ADD COLUMN "orderLtp" DOUBLE PRECISION,
  ADD COLUMN "orderSentAt" TIMESTAMP(3),
  ADD COLUMN "fillPrice" DOUBLE PRECISION,
  ADD COLUMN "fillQty" INTEGER,
  ADD COLUMN "fillAt" TIMESTAMP(3),
  ADD COLUMN "slippage" DOUBLE PRECISION,
  ADD COLUMN "latencyMs" INTEGER;

CREATE TABLE "ai_exit_outcomes" (
    "id" TEXT NOT NULL,
    "executionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "verdictId" TEXT NOT NULL,
    "trackerId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "exchange" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "positionSide" TEXT NOT NULL,
    "qty" DOUBLE PRECISION NOT NULL,
    "decisionPrice" DOUBLE PRECISION NOT NULL,
    "decisionAt" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "barsUsed" INTEGER,
    "maxAfter" DOUBLE PRECISION,
    "minAfter" DOUBLE PRECISION,
    "closeAt15" DOUBLE PRECISION,
    "closeAt30" DOUBLE PRECISION,
    "closeAt60" DOUBLE PRECISION,
    "closeAtEnd" DOUBLE PRECISION,
    "missedPnl" DOUBLE PRECISION,
    "savedPnl" DOUBLE PRECISION,
    "netAtEnd" DOUBLE PRECISION,
    "dataSource" TEXT,
    "note" TEXT,
    "computedAt" TIMESTAMP(3),
    "corpusAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_exit_outcomes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ai_exit_outcomes_executionId_key" ON "ai_exit_outcomes"("executionId");
CREATE INDEX "ai_exit_outcomes_userId_decisionAt_idx" ON "ai_exit_outcomes"("userId", "decisionAt");
CREATE INDEX "ai_exit_outcomes_status_windowEnd_idx" ON "ai_exit_outcomes"("status", "windowEnd");

ALTER TABLE "ai_exit_outcomes" ADD CONSTRAINT "ai_exit_outcomes_vocab_check" CHECK (
    "kind" IN ('EXECUTED', 'DRY_RUN', 'GATED', 'AWAITING')
    AND "positionSide" IN ('LONG', 'SHORT')
    AND "status" IN ('PENDING', 'DONE', 'NO_DATA')
);
```

- [ ] **Step 3: Verify schema and migration agree**

Run: `npx prisma validate && npx prisma generate`
Expected: "The schema … is valid", client generated.
Run (against a THROWAWAY database only, e.g. a local scratch DB in `SHADOW_URL`): `npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url "$SHADOW_URL"`
Expected: empty diff (`-- This is an empty migration.`) apart from the CHECK (Prisma does not model CHECKs). If no scratch DB is available, read the generated client types (`node_modules/.prisma/client/index.d.ts`, search `AiExitOutcome`) and record that the diff was not run in the commit body.

- [ ] **Step 4: Typecheck**

Run: `cd apps/api && npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20261015120000_exit_discipline/migration.sql
git commit -m "feat(db): exit discipline — gate/quality columns on ai_exit_executions, ai_exit_outcomes table

Expand-only: ten nullable columns, one new table with a vocabulary CHECK. No FK.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Gate clauses (Stream A, pure)

**Files:**
- Create: `apps/api/src/modules/exit-discipline/gate.ts`, `gate.spec.ts`

**Interfaces:**
- Consumes: `ExitDisciplineConfig`, `EXPIRY_CLOSE_MIN`, `CLEAR_MARGIN_N`, `INVALIDATION_SCALE_TOLERANCE` (Task 1); `GateFactsSnapshot`, `ClauseResult`, `Justification` (Task 1 types).
- Produces: `type GateFacts = GateFactsSnapshot`; `interface GateEvaluation { justified: boolean; justification: Justification | null; hardRisk: boolean; thesisClearMargin: boolean; clauses: ClauseResult[] }`; `evaluateExitGate(f: GateFacts, cfg: ExitDisciplineConfig): GateEvaluation`. Clause order in `clauses` is fixed: THESIS_INVALIDATION, THESIS_LEVEL, HARD_MAX_LOSS, HARD_SESSION_CLOSE, HARD_EXPIRY, HARD_DAILY_LOSS, FLOOR_BREACH_UNDERLYING_MOVE, FLOOR_BREACH_VWAP. Justification precedence: HARD_RISK > THESIS_BROKEN > CONFIRMED_FLOOR_BREACH.

- [ ] **Step 1: Write the failing test**

```ts
import { parseExitDisciplineConfig } from './config';
import { evaluateExitGate, type GateFacts } from './gate';

const CFG = parseExitDisciplineConfig({});
/** The 2026-10-14 16:31 evidence case: long CRUDEOIL 9000 CE, underlying rising, thesis intact. */
const BASE: GateFacts = {
  exposure: 'BULLISH', positionSide: 'LONG', ltpNow: 527.1, underlying: 9003, invalidation: 8932,
  holdRef: { id: 'vh', underlying: 8998, support: 8946, resistance: 9020, at: '2026-10-14T10:50:00.000Z' },
  vwap: 9000, nContract: 4.5, nUnderlying: 3.1,
  floor: { price: 530.5, armed: true, basis: 'noise' },
  netPnlNow: 420, maxLossPerTrade: 2000, minutesToClose: 419, productType: 'CARRYFORWARD',
  isExpiryDay: false, dailyLossLatched: false,
};
const clause = (r: ReturnType<typeof evaluateExitGate>, id: string) => r.clauses.find((c) => c.id === id)!;

describe('evaluateExitGate', () => {
  it('evidence case: floor breached by premium noise, underlying above VWAP and up since the HOLD ⇒ NOT justified', () => {
    const r = evaluateExitGate(BASE, CFG);
    expect(r).toMatchObject({ justified: false, justification: null, hardRisk: false });
    expect(r.clauses.map((c) => c.id)).toEqual([
      'THESIS_INVALIDATION', 'THESIS_LEVEL', 'HARD_MAX_LOSS', 'HARD_SESSION_CLOSE', 'HARD_EXPIRY',
      'HARD_DAILY_LOSS', 'FLOOR_BREACH_UNDERLYING_MOVE', 'FLOOR_BREACH_VWAP',
    ]);
    expect(clause(r, 'FLOOR_BREACH_UNDERLYING_MOVE')).toMatchObject({ pass: false, measured: expect.objectContaining({ floorBreached: true, adverseMove: -5 }) });
    expect(clause(r, 'FLOOR_BREACH_VWAP')).toMatchObject({ pass: false, measured: expect.objectContaining({ vwap: 9000, underlying: 9003 }) });
  });

  it.each([
    // [label, patch, justification, hardRisk, clearMargin, passing clause]
    ['below invalidation by a clear margin', { underlying: 8930 }, 'THESIS_BROKEN', false, true, 'THESIS_INVALIDATION'],
    ['below invalidation by a hair', { underlying: 8931.5 }, 'THESIS_BROKEN', false, false, 'THESIS_INVALIDATION'],
    ['below the support the trade was HELD against', { underlying: 8940 }, 'THESIS_BROKEN', false, false, 'THESIS_LEVEL'],
    ['net loss at the per-trade max', { netPnlNow: -2000 }, 'HARD_RISK', true, false, 'HARD_MAX_LOSS'],
    ['intraday product 9 min before close', { productType: 'INTRADAY', minutesToClose: 9 }, 'HARD_RISK', true, false, 'HARD_SESSION_CLOSE'],
    ['expiry day 25 min before close', { isExpiryDay: true, minutesToClose: 25 }, 'HARD_RISK', true, false, 'HARD_EXPIRY'],
    ['daily loss latched', { dailyLossLatched: true }, 'HARD_RISK', true, false, 'HARD_DAILY_LOSS'],
    ['floor breached + underlying 3.5 against since HOLD', { holdRef: { ...BASE.holdRef!, underlying: 9006.5 } }, 'CONFIRMED_FLOOR_BREACH', false, false, 'FLOOR_BREACH_UNDERLYING_MOVE'],
    ['floor breached + underlying below VWAP', { underlying: 8999, vwap: 9000 }, 'CONFIRMED_FLOOR_BREACH', false, false, 'FLOOR_BREACH_VWAP'],
  ] as const)('%s', (_l, patch, justification, hardRisk, clear, passing) => {
    const r = evaluateExitGate({ ...BASE, ...(patch as Partial<GateFacts>) }, CFG);
    expect(r).toMatchObject({ justified: true, justification, hardRisk, thesisClearMargin: clear });
    expect(clause(r, passing).pass).toBe(true);
  });

  it('hard risk outranks a broken thesis in the justification', () => {
    expect(evaluateExitGate({ ...BASE, underlying: 8900, dailyLossLatched: true }, CFG).justification).toBe('HARD_RISK');
  });

  it('carry-forward 9 min before close is NOT hard risk (E3)', () => {
    expect(clause(evaluateExitGate({ ...BASE, minutesToClose: 9 }, CFG), 'HARD_SESSION_CLOSE').pass).toBe(false);
  });

  it('an unarmed floor never confirms a breach, even below VWAP', () => {
    const r = evaluateExitGate({ ...BASE, underlying: 8990, floor: { price: 529.65, armed: false, basis: 'noise' } }, CFG);
    expect(clause(r, 'FLOOR_BREACH_VWAP').pass).toBe(false);
    expect(r.justified).toBe(false);
  });

  it('unknown N_underlying: the move clause is unmeasurable (null) but VWAP still decides', () => {
    const r = evaluateExitGate({ ...BASE, nUnderlying: null, underlying: 8999 }, CFG);
    expect(clause(r, 'FLOOR_BREACH_UNDERLYING_MOVE').pass).toBeNull();
    expect(r.justification).toBe('CONFIRMED_FLOOR_BREACH');
  });

  it('a premium-scale invalidation is never used (scale sanity)', () => {
    const r = evaluateExitGate({ ...BASE, invalidation: 500 }, CFG);
    expect(clause(r, 'THESIS_INVALIDATION')).toMatchObject({ pass: null, note: expect.stringMatching(/scale/) });
  });

  it('unknown exposure or underlying: thesis and underlying clauses null, hard risk still works', () => {
    const r = evaluateExitGate({ ...BASE, exposure: null, underlying: null, dailyLossLatched: true }, CFG);
    expect(clause(r, 'THESIS_INVALIDATION').pass).toBeNull();
    expect(clause(r, 'THESIS_LEVEL').pass).toBeNull();
    expect(clause(r, 'FLOOR_BREACH_VWAP').pass).toBeNull();
    expect(r.justification).toBe('HARD_RISK');
  });

  describe('BEARISH exposure (long PE / short CE / short FUT)', () => {
    const PUT: GateFacts = {
      ...BASE, exposure: 'BEARISH', invalidation: 9050, underlying: 9010, vwap: 9020,
      holdRef: { id: 'vh', underlying: 9012, support: 8980, resistance: 9040, at: '2026-10-14T10:50:00.000Z' },
    };
    it('intact: underlying under the invalidation, under the held resistance, below VWAP', () => {
      expect(evaluateExitGate(PUT, CFG).justified).toBe(false);
    });
    it('broken: underlying ABOVE the invalidation', () => {
      expect(evaluateExitGate({ ...PUT, underlying: 9060 }, CFG)).toMatchObject({ justification: 'THESIS_BROKEN', thesisClearMargin: true });
    });
    it('broken: underlying above the HELD resistance', () => {
      expect(clause(evaluateExitGate({ ...PUT, underlying: 9045 }, CFG), 'THESIS_LEVEL').pass).toBe(true);
    });
    it('floor breach confirmed by the underlying rising above VWAP', () => {
      expect(evaluateExitGate({ ...PUT, underlying: 9025 }, CFG).justification).toBe('CONFIRMED_FLOOR_BREACH');
    });
  });

  it('SHORT position: the floor is breached when ltpNow is ABOVE it', () => {
    const SHORT_FUT: GateFacts = {
      ...BASE, exposure: 'BEARISH', positionSide: 'SHORT', ltpNow: 98.5, underlying: 98.5, invalidation: 104,
      holdRef: { id: 'vh', underlying: 97, support: 95, resistance: 102, at: '2026-10-14T10:50:00.000Z' },
      vwap: 98, nUnderlying: 1, floor: { price: 98, armed: true, basis: 'noise' },
    };
    const r = evaluateExitGate(SHORT_FUT, CFG);
    expect(clause(r, 'FLOOR_BREACH_UNDERLYING_MOVE')).toMatchObject({ pass: true, measured: expect.objectContaining({ adverseMove: 1.5 }) });
    expect(r.justification).toBe('CONFIRMED_FLOOR_BREACH');
  });

  it('every clause carries its numbers', () => {
    for (const c of evaluateExitGate(BASE, CFG).clauses) {
      expect(Object.keys(c.measured).length).toBeGreaterThan(0);
      expect(c.note).not.toBe('');
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx jest src/modules/exit-discipline/gate.spec.ts --ci --maxWorkers=2`
Expected: FAIL — `Cannot find module './gate'`.

- [ ] **Step 3: Implement `gate.ts`**

```ts
import { CLEAR_MARGIN_N, EXPIRY_CLOSE_MIN, INVALIDATION_SCALE_TOLERANCE, type ExitDisciplineConfig } from './config';
import type { ClauseId, ClauseResult, GateFactsSnapshot, Justification } from './types';

export type GateFacts = GateFactsSnapshot;

export interface GateEvaluation {
  justified: boolean;
  justification: Justification | null;
  hardRisk: boolean;
  /** THESIS_INVALIDATION passed by >= CLEAR_MARGIN_N noise units (persistence bypass, spec §7). */
  thesisClearMargin: boolean;
  clauses: ClauseResult[];
}

const fin = (x: number | null | undefined): x is number => typeof x === 'number' && Number.isFinite(x);
const r2 = (x: number) => Math.round(x * 100) / 100;
const res = (id: ClauseId, pass: boolean | null, measured: ClauseResult['measured'], note: string): ClauseResult =>
  ({ id, pass, measured, note });

/**
 * Spec §6, pure. Never throws; a missing input makes a clause `pass: null`
 * (unmeasurable), which never justifies an exit.
 */
export function evaluateExitGate(f: GateFacts, cfg: ExitDisciplineConfig): GateEvaluation {
  const bull = f.exposure === 'BULLISH';
  const u = fin(f.underlying) ? f.underlying : null;
  const known = f.exposure !== null && u !== null;
  const nU = fin(f.nUnderlying) && f.nUnderlying > 0 ? f.nUnderlying : null;

  // 1a. invalidation
  let inv: ClauseResult;
  let clear = false;
  if (!known || !fin(f.invalidation)) {
    inv = res('THESIS_INVALIDATION', null, { underlying: u, invalidation: f.invalidation ?? null }, 'no underlying, exposure or invalidation to compare');
  } else if (Math.abs(f.invalidation - (u as number)) / (u as number) > INVALIDATION_SCALE_TOLERANCE) {
    inv = res('THESIS_INVALIDATION', null, { underlying: u, invalidation: f.invalidation },
      `invalidation is more than ${INVALIDATION_SCALE_TOLERANCE * 100}% from the underlying — wrong scale, not used`);
  } else {
    const beyond = bull ? (u as number) < f.invalidation : (u as number) > f.invalidation;
    const margin = r2(Math.abs((u as number) - f.invalidation));
    clear = beyond && nU !== null && margin >= CLEAR_MARGIN_N * nU;
    inv = res('THESIS_INVALIDATION', beyond, { underlying: u, invalidation: f.invalidation, margin, nUnderlying: nU, clearMargin: clear },
      beyond ? `underlying beyond the thesis invalidation by ${margin}` : 'underlying on the thesis side of the invalidation');
  }

  // 1b. the level the trade was HELD against (last HOLD's packet)
  const held = f.holdRef ? (bull ? f.holdRef.support : f.holdRef.resistance) : null;
  const lvl = !known || !fin(held)
    ? res('THESIS_LEVEL', null, { underlying: u, heldLevel: held ?? null }, 'no HOLD-time support/resistance to compare')
    : res('THESIS_LEVEL', bull ? (u as number) < held : (u as number) > held, { underlying: u, heldLevel: held, holdId: f.holdRef!.id },
      bull ? 'underlying vs the support held at the last HOLD' : 'underlying vs the resistance held at the last HOLD');

  // 2. hard risk
  const maxLoss = fin(f.maxLossPerTrade) && f.maxLossPerTrade > 0 ? f.maxLossPerTrade : null;
  const loss = maxLoss === null || !fin(f.netPnlNow)
    ? res('HARD_MAX_LOSS', null, { netPnlNow: f.netPnlNow ?? null, maxLossPerTrade: maxLoss }, 'no per-trade max loss or P&L')
    : res('HARD_MAX_LOSS', f.netPnlNow <= -maxLoss, { netPnlNow: r2(f.netPnlNow), maxLossPerTrade: maxLoss }, 'net loss vs maxRiskPerTrade');
  const mtc = fin(f.minutesToClose) ? f.minutesToClose : null;
  const close = res('HARD_SESSION_CLOSE', mtc === null ? null : f.productType === 'INTRADAY' && mtc <= cfg.gateCloseMin,
    { productType: f.productType, minutesToClose: mtc, gateCloseMin: cfg.gateCloseMin }, 'intraday product near the close (E3)');
  const expiry = res('HARD_EXPIRY', mtc === null ? null : f.isExpiryDay && mtc <= EXPIRY_CLOSE_MIN,
    { isExpiryDay: f.isExpiryDay, minutesToClose: mtc }, `expiry day, <= ${EXPIRY_CLOSE_MIN} min to close`);
  const daily = res('HARD_DAILY_LOSS', f.dailyLossLatched, { dailyLossLatched: f.dailyLossLatched }, 'core daily-loss latch for today');

  // 3. confirmed floor breach
  const fp = f.floor.price;
  const breached = f.floor.armed && fin(fp) && fin(f.ltpNow)
    ? (f.positionSide === 'LONG' ? f.ltpNow < fp : f.ltpNow > fp) : false;
  const holdU = f.holdRef && fin(f.holdRef.underlying) ? f.holdRef.underlying : null;
  let move: ClauseResult;
  if (!known || holdU === null || nU === null) {
    move = res('FLOOR_BREACH_UNDERLYING_MOVE', null, { floorBreached: breached, underlying: u, holdUnderlying: holdU, nUnderlying: nU },
      'no HOLD-time underlying or no underlying noise unit');
  } else {
    const adverse = r2(bull ? holdU - (u as number) : (u as number) - holdU);
    move = res('FLOOR_BREACH_UNDERLYING_MOVE', breached && adverse >= cfg.gateUnderlyingN * nU,
      { floorBreached: breached, floor: fp ?? null, ltpNow: f.ltpNow, underlying: u, holdUnderlying: holdU, adverseMove: adverse, nUnderlying: nU, needN: cfg.gateUnderlyingN },
      'armed floor breached AND the underlying moved against the position since the last HOLD');
  }
  const vw = !known || !fin(f.vwap)
    ? res('FLOOR_BREACH_VWAP', null, { floorBreached: breached, underlying: u, vwap: f.vwap ?? null }, 'no underlying VWAP')
    : res('FLOOR_BREACH_VWAP', breached && (bull ? (u as number) < f.vwap : (u as number) > f.vwap),
      { floorBreached: breached, floor: fp ?? null, ltpNow: f.ltpNow, underlying: u, vwap: f.vwap },
      'armed floor breached AND the underlying is on the wrong side of VWAP');

  const clauses = [inv, lvl, loss, close, expiry, daily, move, vw];
  const ok = (c: ClauseResult) => c.pass === true;
  const hardRisk = [loss, close, expiry, daily].some(ok);
  const thesis = [inv, lvl].some(ok);
  const floorOk = [move, vw].some(ok);
  const justification: Justification | null = hardRisk ? 'HARD_RISK' : thesis ? 'THESIS_BROKEN' : floorOk ? 'CONFIRMED_FLOOR_BREACH' : null;
  return { justified: justification !== null, justification, hardRisk, thesisClearMargin: clear, clauses };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && npx jest src/modules/exit-discipline/gate.spec.ts --ci --maxWorkers=2`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/exit-discipline/gate.ts apps/api/src/modules/exit-discipline/gate.spec.ts
git commit -m "feat(exit-discipline): thesis gate clauses (spec §6), puts/shorts, measured numbers per clause

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Persistence + the gate decision record (Stream A, pure)

**Files:**
- Create: `apps/api/src/modules/exit-discipline/persistence.ts`, `persistence.spec.ts`
- Create: `apps/api/src/modules/exit-discipline/decision.ts`, `decision.spec.ts`

**Interfaces:**
- Consumes: Task 3 `evaluateExitGate`, `GateFacts`; Task 1 types/config.
- Produces (persistence.ts): `interface HistoryVerdict { id: string; verdict: string; createdAt: Date; underlying: number | null; support: number | null; resistance: number | null }`; `evaluatePersistence(i: { current: { id: string; createdAt: Date }; history: HistoryVerdict[]; bypass: boolean; cfg: ExitDisciplineConfig }): PersistenceResult` (history newest first, strictly before current).
- Produces (decision.ts): `istDate(at: Date): string` (`YYYY-MM-DD` Asia/Kolkata); `lastHoldRef(history: HistoryVerdict[]): GateFactsSnapshot['holdRef']`; `decideExit(i: { facts: GateFacts; current: { id: string; createdAt: Date }; history: HistoryVerdict[]; cfg: ExitDisciplineConfig; now: Date }): GateRecordV1`; `bypassRecord(reason: 'DISABLED' | 'FACTS_UNREADABLE', cfg: ExitDisciplineConfig, now: Date, error?: string): GateRecordV1`; `isBlocking(r: GateRecordV1 | null): boolean` (true for GATED_THESIS_INTACT / AWAITING_CONFIRMATION); `gateSummary(r: GateRecordV1): string` (≤ 300 chars).

- [ ] **Step 1: Write the failing tests**

`persistence.spec.ts`:

```ts
import { parseExitDisciplineConfig } from './config';
import { evaluatePersistence, type HistoryVerdict } from './persistence';

const CFG = parseExitDisciplineConfig({});
const T = new Date('2026-10-14T11:01:00Z');
const ago = (s: number) => new Date(T.getTime() - s * 1000);
const h = (verdict: string, s: number, id = `${verdict}-${s}`): HistoryVerdict =>
  ({ id, verdict, createdAt: ago(s), underlying: null, support: null, resistance: null });
const run = (history: HistoryVerdict[], bypass = false) =>
  evaluatePersistence({ current: { id: 'cur', createdAt: T }, history, bypass, cfg: CFG });

describe('evaluatePersistence (spec §7)', () => {
  it('bypass confirms at once', () => {
    expect(run([], true)).toMatchObject({ confirmed: true, rule: 'BYPASS' });
  });
  it('first EXIT_NOW after a HOLD is not confirmed', () => {
    expect(run([h('HOLD', 60)])).toMatchObject({ confirmed: false, rule: null, streakStart: { id: 'cur', ageSec: 0 } });
  });
  it('previous verdict EXIT_NOW within the window ⇒ CONSECUTIVE', () => {
    expect(run([h('EXIT_NOW', 90), h('HOLD', 400)])).toMatchObject({ confirmed: true, rule: 'CONSECUTIVE', previous: { verdict: 'EXIT_NOW', ageSec: 90 } });
  });
  it('previous EXIT_NOW outside the window but streak >= PERSIST_MIN_SEC ⇒ SUSTAINED', () => {
    expect(run([h('EXIT_NOW', 400)])).toMatchObject({ confirmed: true, rule: 'SUSTAINED', streakStart: { ageSec: 400 } });
  });
  it('EXIT_ARMED and ESCALATE do not break a streak', () => {
    expect(run([h('EXIT_ARMED', 60), h('ESCALATE', 100), h('EXIT_NOW', 150), h('HOLD', 200)]))
      .toMatchObject({ confirmed: true, rule: 'SUSTAINED', streakStart: { id: 'EXIT_NOW-150', ageSec: 150 } });
  });
  it('streak younger than PERSIST_MIN_SEC with a non-EXIT_NOW previous ⇒ not confirmed', () => {
    expect(run([h('EXIT_ARMED', 60), h('EXIT_NOW', 100), h('HOLD', 300)])).toMatchObject({ confirmed: false, rule: null });
  });
  it('a HOLD in between resets the streak (the six flip-flops of 2026-10-14 need a fresh confirmation)', () => {
    expect(run([h('HOLD', 100), h('EXIT_NOW', 500)])).toMatchObject({ confirmed: false, streakStart: { id: 'cur' } });
  });
  it('empty history ⇒ the current verdict starts the streak', () => {
    expect(run([])).toMatchObject({ confirmed: false, previous: null, streakStart: { id: 'cur', ageSec: 0 } });
  });
  it('history is filtered to strictly-before-current (a row at the same instant is ignored)', () => {
    expect(run([{ ...h('EXIT_NOW', 0), id: 'same' }])).toMatchObject({ confirmed: false });
  });
});
```

`decision.spec.ts`:

```ts
import { parseExitDisciplineConfig } from './config';
import { bypassRecord, decideExit, gateSummary, isBlocking, istDate, lastHoldRef } from './decision';
import type { GateFacts } from './gate';
import type { HistoryVerdict } from './persistence';

const CFG = parseExitDisciplineConfig({});
const NOW = new Date('2026-10-14T11:01:30Z');
const CUR = { id: 'cur', createdAt: new Date('2026-10-14T11:01:00Z') };
const hv = (verdict: string, iso: string, underlying: number | null = null, support: number | null = null): HistoryVerdict =>
  ({ id: `${verdict}@${iso}`, verdict, createdAt: new Date(iso), underlying, support, resistance: 9020 });
const HIST = [hv('EXIT_ARMED', '2026-10-14T11:00:00Z'), hv('HOLD', '2026-10-14T10:50:00Z', 8998, 8946)];
const FACTS: GateFacts = {
  exposure: 'BULLISH', positionSide: 'LONG', ltpNow: 527.1, underlying: 9003, invalidation: 8932,
  holdRef: lastHoldRef(HIST), vwap: 9000, nContract: 4.5, nUnderlying: 3.1,
  floor: { price: 530.5, armed: true, basis: 'noise' }, netPnlNow: 420, maxLossPerTrade: 2000,
  minutesToClose: 419, productType: 'CARRYFORWARD', isExpiryDay: false, dailyLossLatched: false,
};

describe('istDate', () => {
  it('is the Asia/Kolkata calendar date', () => {
    expect(istDate(new Date('2026-10-14T18:29:59Z'))).toBe('2026-10-14');
    expect(istDate(new Date('2026-10-14T18:30:00Z'))).toBe('2026-10-15');
  });
});

describe('lastHoldRef', () => {
  it('picks the newest HOLD and copies its underlying and levels', () => {
    expect(lastHoldRef(HIST)).toEqual({ id: 'HOLD@2026-10-14T10:50:00Z', underlying: 8998, support: 8946, resistance: 9020, at: '2026-10-14T10:50:00.000Z' });
    expect(lastHoldRef([hv('EXIT_NOW', '2026-10-14T10:00:00Z')])).toBeNull();
  });
});

describe('decideExit', () => {
  it('thesis intact ⇒ GATED_THESIS_INTACT with every clause and the facts recorded', () => {
    const r = decideExit({ facts: FACTS, current: CUR, history: HIST, cfg: CFG, now: NOW });
    expect(r).toMatchObject({ v: 1, outcome: 'GATED_THESIS_INTACT', justification: null, persistence: null, facts: FACTS });
    expect(r.clauses).toHaveLength(8);
    expect(r.cfg).toEqual({ floorArmN: 1.5, floorTrailN: 2, gateCloseMin: 10, gateUnderlyingN: 1, persistWindowSec: 300, persistMinSec: 120 });
    expect(r.evaluatedAt).toBe(NOW.toISOString());
    expect(isBlocking(r)).toBe(true);
  });
  it('justified (level break) but first EXIT_NOW ⇒ AWAITING_CONFIRMATION', () => {
    const r = decideExit({ facts: { ...FACTS, underlying: 8940 }, current: CUR, history: HIST, cfg: CFG, now: NOW });
    expect(r).toMatchObject({ outcome: 'AWAITING_CONFIRMATION', justification: 'THESIS_BROKEN', persistence: { confirmed: false } });
    expect(isBlocking(r)).toBe(true);
  });
  it('justified and confirmed ⇒ PASS', () => {
    const hist = [hv('EXIT_NOW', '2026-10-14T10:59:30Z'), ...HIST];
    const r = decideExit({ facts: { ...FACTS, underlying: 8940 }, current: CUR, history: hist, cfg: CFG, now: NOW });
    expect(r).toMatchObject({ outcome: 'PASS', persistence: { rule: 'CONSECUTIVE' } });
    expect(isBlocking(r)).toBe(false);
  });
  it('hard risk on the FIRST EXIT_NOW ⇒ PASS (persistence bypassed)', () => {
    const r = decideExit({ facts: { ...FACTS, dailyLossLatched: true }, current: CUR, history: HIST, cfg: CFG, now: NOW });
    expect(r).toMatchObject({ outcome: 'PASS', justification: 'HARD_RISK', persistence: { rule: 'BYPASS' } });
  });
  it('clear invalidation break on the FIRST EXIT_NOW ⇒ PASS', () => {
    const r = decideExit({ facts: { ...FACTS, underlying: 8925 }, current: CUR, history: HIST, cfg: CFG, now: NOW });
    expect(r).toMatchObject({ outcome: 'PASS', justification: 'THESIS_BROKEN', persistence: { rule: 'BYPASS' } });
  });
  it('disabled config ⇒ BYPASS DISABLED, nothing evaluated', () => {
    const off = parseExitDisciplineConfig({ EXIT_DISCIPLINE_ENABLED: 'false' });
    const r = decideExit({ facts: FACTS, current: CUR, history: HIST, cfg: off, now: NOW });
    expect(r).toMatchObject({ outcome: 'BYPASS', bypassReason: 'DISABLED', clauses: [], facts: null });
    expect(isBlocking(r)).toBe(false);
  });
});

describe('bypassRecord / isBlocking / gateSummary', () => {
  it('FACTS_UNREADABLE never blocks and keeps the error', () => {
    const r = bypassRecord('FACTS_UNREADABLE', CFG, NOW, 'verdict row not found');
    expect(r).toMatchObject({ outcome: 'BYPASS', bypassReason: 'FACTS_UNREADABLE', error: 'verdict row not found' });
    expect(isBlocking(r)).toBe(false);
    expect(isBlocking(null)).toBe(false);
  });
  it('summary names the outcome and the failing numbers in one line', () => {
    const s = gateSummary(decideExit({ facts: FACTS, current: CUR, history: HIST, cfg: CFG, now: NOW }));
    expect(s).toMatch(/^GATED_THESIS_INTACT: /);
    expect(s).toContain('u 9003');
    expect(s).toContain('inv 8932');
    expect(s).toContain('floor 530.5');
    expect(s.length).toBeLessThanOrEqual(300);
    expect(s).not.toContain('\n');
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && npx jest src/modules/exit-discipline/persistence.spec.ts src/modules/exit-discipline/decision.spec.ts --ci --maxWorkers=2`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`persistence.ts`:

```ts
import type { ExitDisciplineConfig } from './config';
import type { PersistenceResult } from './types';

/** One prior live verdict on the tracker (newest first), with the HOLD-time facts the gate reads. */
export interface HistoryVerdict {
  id: string;
  verdict: string;
  createdAt: Date;
  underlying: number | null;
  support: number | null;
  resistance: number | null;
}

const secs = (a: Date, b: Date) => Math.round((a.getTime() - b.getTime()) / 1000);

/** Spec §7, pure. Only HOLD breaks a streak; EXIT_ARMED / ESCALATE do not. */
export function evaluatePersistence(i: {
  current: { id: string; createdAt: Date };
  history: HistoryVerdict[];
  bypass: boolean;
  cfg: ExitDisciplineConfig;
}): PersistenceResult {
  const before = i.history
    .filter((h) => h.id !== i.current.id && h.createdAt.getTime() < i.current.createdAt.getTime())
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const prev = before[0] ?? null;
  const previous = prev ? { id: prev.id, verdict: prev.verdict, ageSec: secs(i.current.createdAt, prev.createdAt) } : null;

  let start: { id: string; at: Date } = { id: i.current.id, at: i.current.createdAt };
  for (const h of before) {
    if (h.verdict === 'HOLD') break;
    if (h.verdict === 'EXIT_NOW') start = { id: h.id, at: h.createdAt };
  }
  const streakStart = { id: start.id, ageSec: secs(i.current.createdAt, start.at) };

  if (i.bypass) return { confirmed: true, rule: 'BYPASS', previous, streakStart };
  if (previous && previous.verdict === 'EXIT_NOW' && previous.ageSec <= i.cfg.persistWindowSec) {
    return { confirmed: true, rule: 'CONSECUTIVE', previous, streakStart };
  }
  if (start.id !== i.current.id && streakStart.ageSec >= i.cfg.persistMinSec) {
    return { confirmed: true, rule: 'SUSTAINED', previous, streakStart };
  }
  return { confirmed: false, rule: null, previous, streakStart };
}
```

`decision.ts`:

```ts
import type { ExitDisciplineConfig } from './config';
import { evaluateExitGate, type GateFacts } from './gate';
import { evaluatePersistence, type HistoryVerdict } from './persistence';
import type { GateFactsSnapshot, GateRecordV1 } from './types';

const IST_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' });
/** `YYYY-MM-DD` in Asia/Kolkata. */
export function istDate(at: Date): string {
  return IST_DATE.format(at);
}

export function lastHoldRef(history: HistoryVerdict[]): GateFactsSnapshot['holdRef'] {
  const hold = [...history].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).find((h) => h.verdict === 'HOLD');
  return hold
    ? { id: hold.id, underlying: hold.underlying, support: hold.support, resistance: hold.resistance, at: hold.createdAt.toISOString() }
    : null;
}

const cfgOf = (c: ExitDisciplineConfig): GateRecordV1['cfg'] => ({
  floorArmN: c.floorArmN, floorTrailN: c.floorTrailN, gateCloseMin: c.gateCloseMin,
  gateUnderlyingN: c.gateUnderlyingN, persistWindowSec: c.persistWindowSec, persistMinSec: c.persistMinSec,
});

export function bypassRecord(reason: 'DISABLED' | 'FACTS_UNREADABLE', cfg: ExitDisciplineConfig, now: Date, error?: string): GateRecordV1 {
  return {
    v: 1, outcome: 'BYPASS', bypassReason: reason, ...(error ? { error: error.slice(0, 300) } : {}),
    justification: null, clauses: [], persistence: null, facts: null, cfg: cfgOf(cfg), evaluatedAt: now.toISOString(),
  };
}

/** Spec §6 + §7 composed (R7). */
export function decideExit(i: {
  facts: GateFacts; current: { id: string; createdAt: Date }; history: HistoryVerdict[]; cfg: ExitDisciplineConfig; now: Date;
}): GateRecordV1 {
  if (!i.cfg.enabled) return bypassRecord('DISABLED', i.cfg, i.now);
  const g = evaluateExitGate(i.facts, i.cfg);
  const base = { v: 1 as const, justification: g.justification, clauses: g.clauses, facts: i.facts, cfg: cfgOf(i.cfg), evaluatedAt: i.now.toISOString() };
  if (!g.justified) return { ...base, outcome: 'GATED_THESIS_INTACT', persistence: null };
  const p = evaluatePersistence({ current: i.current, history: i.history, bypass: g.hardRisk || g.thesisClearMargin, cfg: i.cfg });
  return { ...base, outcome: p.confirmed ? 'PASS' : 'AWAITING_CONFIRMATION', persistence: p };
}

export function isBlocking(r: GateRecordV1 | null | undefined): boolean {
  return r?.outcome === 'GATED_THESIS_INTACT' || r?.outcome === 'AWAITING_CONFIRMATION';
}

/** One log/UI line: outcome + the numbers that decided it. */
export function gateSummary(r: GateRecordV1): string {
  if (r.outcome === 'BYPASS') return `BYPASS: ${r.bypassReason}${r.error ? ` (${r.error})` : ''}`.slice(0, 300);
  const f = r.facts;
  const parts: string[] = [];
  if (f) {
    parts.push(`u ${f.underlying ?? '?'}`, `inv ${f.invalidation ?? '?'}`);
    if (f.holdRef) parts.push(`held ${f.exposure === 'BEARISH' ? f.holdRef.resistance : f.holdRef.support} @HOLD u ${f.holdRef.underlying ?? '?'}`);
    parts.push(`vwap ${f.vwap ?? '?'}`, `floor ${f.floor.price ?? '?'}${f.floor.armed ? '' : ' (unarmed)'} ltp ${f.ltpNow}`,
      `N ${f.nContract ?? '?'}/${f.nUnderlying ?? '?'}`);
  }
  const passed = r.clauses.filter((c) => c.pass === true).map((c) => c.id);
  const head = r.outcome === 'PASS' || r.outcome === 'AWAITING_CONFIRMATION'
    ? `${r.outcome}: ${r.justification} via ${passed.join('+')}${r.persistence ? ` persist=${r.persistence.rule ?? 'pending'}` : ''}`
    : `${r.outcome}: `;
  return `${head}${r.outcome === 'GATED_THESIS_INTACT' ? '' : '; '}${parts.join(', ')}`.slice(0, 300);
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd apps/api && npx jest src/modules/exit-discipline --ci --maxWorkers=2`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/exit-discipline/persistence.ts apps/api/src/modules/exit-discipline/persistence.spec.ts apps/api/src/modules/exit-discipline/decision.ts apps/api/src/modules/exit-discipline/decision.spec.ts
git commit -m "feat(exit-discipline): persistence (spec §7) and the gate decision record (E7)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Stored-packet reader (Stream A, pure)

**Files:**
- Create: `apps/api/src/modules/exit-discipline/packet-facts.ts`, `packet-facts.spec.ts`
- Modify: `apps/api/src/modules/exit-discipline/decision.ts` (add `buildGateFacts`), `decision.spec.ts`

**Interfaces:**
- Consumes: Task 1 types, `exposureOf`; Task 4 `istDate`, `lastHoldRef`, `HistoryVerdict`.
- Produces: `interface PacketFacts { symbol: string; side: PositionSide; qty: number; entryPrice: number; ltp: number; underlying: number | null; invalidation: number | null; vwap: number | null; levelBookAtr15m: number | null; noise: NoiseUnitValue | null; floor: { price: number | null; armed: boolean; basis: FloorBasis }; netPnl: number | null; charges: number | null; expiry: string | null; builtAt: string | null; minutesToClose: number | null; support: number | null; resistance: number | null }`; `readPacketFacts(packet: unknown): PacketFacts | { unreadable: string }`.
- Produces (decision.ts): `buildGateFacts(p: PacketFacts, ctx: { ltpNow: number; productType: string | null; minutesToClose: number | null; maxLossPerTrade: number | null; dailyLossLatched: boolean; history: HistoryVerdict[]; now: Date; nContractOverride?: number | null; nUnderlyingOverride?: number | null; floorOverride?: { price: number | null; armed: boolean; basis: FloorBasis } }): GateFacts`. `netPnlNow = min(p.netPnl, (ltpNow − entry)·qty·dir − charges)` (either side null ⇒ the other); `isExpiryDay = p.expiry === istDate(now)`; `nUnderlying = override ?? p.noise?.underlying?.n ?? (p.levelBookAtr15m / √15) ?? null`.

- [ ] **Step 1: Write the failing tests**

`packet-facts.spec.ts`:

```ts
import { readPacketFacts } from './packet-facts';

const P = (patch: Record<string, unknown> = {}) => ({
  position: { symbol: 'CRUDEOIL17NOV269000CE', side: 'LONG', qty: 100, entryPrice: 521.9, ltp: 527.6, expiry: '2026-11-17',
    underlyingLtp: { available: true, value: 9003, source: 's', at: 'a' } },
  money: { grossPnl: 570, charges: 61, netPnl: 509, greenFloorPrice: 524.85, greenFloorArmed: true, mfe: 539.5, mae: 518 },
  thesis: { available: true, value: { direction: 'LONG', reason: 'r', levelPrice: 8960, targetPrice: 9100, invalidation: 8932, source: 'AGENT' }, source: 's', at: 'a' },
  structure: {
    levelBook: { available: true, value: { vwap: 9000, atr14: 13.5, interval: '15m' }, source: 's', at: 'a' },
    nearestSupport: { available: true, value: 8946, source: 's', at: 'a' },
    nearestResistance: { available: true, value: 9020, source: 's', at: 'a' },
  },
  flow: { volumeRatio: { available: false, reason: 'n/a' }, oiWalls: { available: false, reason: 'n/a' } },
  session: { nowUtc: '2026-10-14T11:00:30.000Z', minutesToClose: { available: true, value: 419, source: 's', at: 'a' } },
  ...patch,
});

describe('readPacketFacts', () => {
  it('reads a pre-v7 packet (no noiseUnit, no floorBasis ⇒ fixed)', () => {
    expect(readPacketFacts(P())).toEqual({
      symbol: 'CRUDEOIL17NOV269000CE', side: 'LONG', qty: 100, entryPrice: 521.9, ltp: 527.6, underlying: 9003,
      invalidation: 8932, vwap: 9000, levelBookAtr15m: 13.5, noise: null,
      floor: { price: 524.85, armed: true, basis: 'fixed' }, netPnl: 509, charges: 61, expiry: '2026-11-17',
      builtAt: '2026-10-14T11:00:30.000Z', minutesToClose: 419, support: 8946, resistance: 9020,
    });
  });

  it('reads a v7 packet: noise unit and noise floor basis', () => {
    const noise = { contract: { n: 4.5, method: 'atr14-1m', bars: 14, at: 'x' }, underlying: { n: 3.49, method: 'atr14-15m-scaled', bars: 0, at: 'y' } };
    const f = readPacketFacts(P({
      flow: { volumeRatio: { available: false, reason: 'n/a' }, oiWalls: { available: false, reason: 'n/a' }, noiseUnit: { available: true, value: noise, source: 's', at: 'a' } },
      money: { charges: 61, netPnl: 509, greenFloorPrice: 530.5, greenFloorArmed: true, floorBasis: 'noise' },
    }));
    expect(f).toMatchObject({ noise, floor: { price: 530.5, armed: true, basis: 'noise' } });
  });

  it.each([
    ['unavailable underlying', { position: { ...P().position, underlyingLtp: { available: false, reason: 'x' } } }, 'underlying', null],
    ['no thesis', { thesis: { available: false, reason: 'none' } }, 'invalidation', null],
    ['string where a number belongs', { structure: { ...P().structure, levelBook: { available: true, value: { vwap: 'n/a' } } } }, 'vwap', null],
    ['NaN-ish invalidation', { thesis: { available: true, value: { invalidation: null } } }, 'invalidation', null],
    ['minutesToClose absent', { session: { nowUtc: 'x', minutesToClose: { available: false, reason: 'closed' } } }, 'minutesToClose', null],
  ])('%s → null, never a throw', (_l, patch, key, value) => {
    expect((readPacketFacts(P(patch)) as Record<string, unknown>)[key]).toBe(value);
  });

  it.each([
    ['null', null], ['a string', 'packet'], ['no position', { money: {} }], ['side not LONG/SHORT', P({ position: { ...P().position, side: 'BUY' } })],
    ['non-finite ltp', P({ position: { ...P().position, ltp: 'x' } })], ['no money', P({ money: undefined })],
  ])('%s → unreadable', (_l, p) => {
    expect(readPacketFacts(p)).toEqual({ unreadable: expect.any(String) });
  });
});
```

Add to `decision.spec.ts`:

```ts
import { readPacketFacts, type PacketFacts } from './packet-facts';

describe('buildGateFacts', () => {
  const PF = { symbol: 'CRUDEOIL17NOV269000CE', side: 'LONG', qty: 100, entryPrice: 521.9, ltp: 527.6, underlying: 9003,
    invalidation: 8932, vwap: 9000, levelBookAtr15m: 13.5, noise: null, floor: { price: 524.85, armed: true, basis: 'fixed' },
    netPnl: 509, charges: 61, expiry: '2026-10-14', builtAt: null, minutesToClose: 419, support: 8946, resistance: 9020 } as PacketFacts;
  const ctx = { ltpNow: 527.1, productType: 'CARRYFORWARD', minutesToClose: 418, maxLossPerTrade: 2000, dailyLossLatched: false, history: HIST, now: NOW };

  it('assembles facts: exposure, fresh ltp, worse-of P&L, expiry day, scaled N_u, last HOLD', () => {
    const f = buildGateFacts(PF, ctx);
    expect(f).toMatchObject({
      exposure: 'BULLISH', positionSide: 'LONG', ltpNow: 527.1, underlying: 9003, invalidation: 8932, vwap: 9000,
      nContract: null, floor: { price: 524.85, armed: true, basis: 'fixed' }, minutesToClose: 418,
      productType: 'CARRYFORWARD', isExpiryDay: true, dailyLossLatched: false, maxLossPerTrade: 2000,
      holdRef: { underlying: 8998, support: 8946 },
    });
    expect(f.nUnderlying).toBeCloseTo(13.5 / Math.sqrt(15), 6);
    expect(f.netPnlNow).toBeCloseTo(Math.min(509, (527.1 - 521.9) * 100 - 61), 6);
  });

  it('overrides win (replay re-measures N and the floor)', () => {
    const f = buildGateFacts(PF, { ...ctx, nContractOverride: 5, nUnderlyingOverride: 3, floorOverride: { price: 531, armed: true, basis: 'noise' } });
    expect(f).toMatchObject({ nContract: 5, nUnderlying: 3, floor: { price: 531, basis: 'noise' } });
  });

  it('a packet minutesToClose is the fallback when the clock has none', () => {
    expect(buildGateFacts(PF, { ...ctx, minutesToClose: null }).minutesToClose).toBe(419);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && npx jest src/modules/exit-discipline/packet-facts.spec.ts src/modules/exit-discipline/decision.spec.ts --ci --maxWorkers=2`
Expected: FAIL — `packet-facts` not found; `buildGateFacts` not exported.

- [ ] **Step 3: Implement**

`packet-facts.ts`:

```ts
import type { FloorBasis, NoiseUnitValue, PositionSide } from './types';

/** What the gate and the replay read from a stored `sentinel_verdicts.packet`. Defensive: the packet is JSON from the DB. */
export interface PacketFacts {
  symbol: string; side: PositionSide; qty: number; entryPrice: number; ltp: number;
  underlying: number | null; invalidation: number | null; vwap: number | null; levelBookAtr15m: number | null;
  noise: NoiseUnitValue | null;
  floor: { price: number | null; armed: boolean; basis: FloorBasis };
  netPnl: number | null; charges: number | null; expiry: string | null; builtAt: string | null;
  minutesToClose: number | null; support: number | null; resistance: number | null;
}

type Obj = Record<string, unknown>;
const obj = (x: unknown): Obj | null => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Obj) : null);
const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const str = (x: unknown): string | null => (typeof x === 'string' && x !== '' ? x : null);
/** A packet Block: its value when `available === true`, else null. */
const blockValue = (x: unknown): unknown => { const b = obj(x); return b && b.available === true ? b.value : null; };

function noiseReading(x: unknown) {
  const r = obj(x);
  const n = num(r?.n);
  return r && n !== null && n > 0 ? { n, method: String(r.method) as never, bars: num(r.bars) ?? 0, at: String(r.at ?? '') } : null;
}

export function readPacketFacts(packet: unknown): PacketFacts | { unreadable: string } {
  const p = obj(packet);
  const pos = obj(p?.position);
  const money = obj(p?.money);
  if (!p || !pos) return { unreadable: 'packet has no position' };
  if (!money) return { unreadable: 'packet has no money block' };
  const side = pos.side === 'LONG' || pos.side === 'SHORT' ? (pos.side as PositionSide) : null;
  const qty = num(pos.qty), entryPrice = num(pos.entryPrice), ltp = num(pos.ltp);
  if (!side || qty === null || entryPrice === null || ltp === null) return { unreadable: 'position side/qty/entryPrice/ltp not readable' };

  const structure = obj(p.structure);
  const book = obj(blockValue(structure?.levelBook));
  const thesis = obj(blockValue(p.thesis));
  const flow = obj(p.flow);
  const noiseRaw = obj(blockValue(flow?.noiseUnit));
  const noise = noiseRaw ? { contract: noiseReading(noiseRaw.contract), underlying: noiseReading(noiseRaw.underlying) } : null;
  const session = obj(p.session);

  return {
    symbol: String(pos.symbol ?? ''), side, qty, entryPrice, ltp,
    underlying: num(blockValue(pos.underlyingLtp)),
    invalidation: num(thesis?.invalidation),
    vwap: num(book?.vwap),
    levelBookAtr15m: num(book?.atr14),
    noise: noise && (noise.contract || noise.underlying) ? noise : null,
    floor: { price: num(money.greenFloorPrice), armed: money.greenFloorArmed === true, basis: money.floorBasis === 'noise' ? 'noise' : 'fixed' },
    netPnl: num(money.netPnl), charges: num(money.charges),
    expiry: str(pos.expiry), builtAt: str(session?.nowUtc),
    minutesToClose: num(blockValue(session?.minutesToClose)),
    support: num(blockValue(structure?.nearestSupport)),
    resistance: num(blockValue(structure?.nearestResistance)),
  };
}
```

Append to `decision.ts`:

```ts
import { exposureOf } from './exposure';
import type { PacketFacts } from './packet-facts';
import type { FloorBasis } from './types';

export function buildGateFacts(p: PacketFacts, ctx: {
  ltpNow: number; productType: string | null; minutesToClose: number | null; maxLossPerTrade: number | null;
  dailyLossLatched: boolean; history: HistoryVerdict[]; now: Date;
  nContractOverride?: number | null; nUnderlyingOverride?: number | null;
  floorOverride?: { price: number | null; armed: boolean; basis: FloorBasis };
}): GateFacts {
  const dir = p.side === 'LONG' ? 1 : -1;
  const fresh = Number.isFinite(ctx.ltpNow) && p.charges !== null ? (ctx.ltpNow - p.entryPrice) * p.qty * dir - p.charges : null;
  const netPnlNow = p.netPnl === null ? fresh : fresh === null ? p.netPnl : Math.min(p.netPnl, fresh);
  const scaled = p.levelBookAtr15m !== null && p.levelBookAtr15m > 0 ? p.levelBookAtr15m / Math.sqrt(15) : null;
  return {
    exposure: p.symbol ? exposureOf(p.symbol, p.side) : null,
    positionSide: p.side,
    ltpNow: ctx.ltpNow,
    underlying: p.underlying,
    invalidation: p.invalidation,
    holdRef: lastHoldRef(ctx.history),
    vwap: p.vwap,
    nContract: ctx.nContractOverride !== undefined ? ctx.nContractOverride : p.noise?.contract?.n ?? null,
    nUnderlying: ctx.nUnderlyingOverride !== undefined ? ctx.nUnderlyingOverride : p.noise?.underlying?.n ?? scaled,
    floor: ctx.floorOverride ?? p.floor,
    netPnlNow,
    maxLossPerTrade: ctx.maxLossPerTrade,
    minutesToClose: ctx.minutesToClose ?? p.minutesToClose,
    productType: ctx.productType,
    isExpiryDay: p.expiry !== null && p.expiry === istDate(ctx.now),
    dailyLossLatched: ctx.dailyLossLatched,
  };
}
```

(Move the new imports to the top of `decision.ts`.)

- [ ] **Step 4: Run to verify they pass**

Run: `cd apps/api && npx jest src/modules/exit-discipline --ci --maxWorkers=2`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/exit-discipline/packet-facts.ts apps/api/src/modules/exit-discipline/packet-facts.spec.ts apps/api/src/modules/exit-discipline/decision.ts apps/api/src/modules/exit-discipline/decision.spec.ts
git commit -m "feat(exit-discipline): defensive stored-packet reader and gate fact assembly

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Gate repository + `ExitGateService` (Stream A)

**Files:**
- Create: `apps/api/src/modules/sentinel-executor/repositories/exit-gate.repository.ts`, `exit-gate.repository.spec.ts`
- Create: `apps/api/src/modules/sentinel-executor/services/exit-gate.service.ts`, `exit-gate.service.spec.ts`

**Interfaces:**
- Consumes: Tasks 1, 4, 5 (`readPacketFacts`, `buildGateFacts`, `decideExit`, `bypassRecord`, `HistoryVerdict`, `istDate`, `STREAK_LOOKBACK_MIN`, `GATE_LOAD_TIMEOUT_MS`, `EXIT_DISCIPLINE_CONFIG`); `PendingVerdict` (existing); `SessionClock` (`minutesToClose`).
- Produces (repository): `ExitGateRepository` with `verdictPacket(verdictId): Promise<unknown | null>`; `recentVerdicts(trackerId, excludeId, before: Date, since: Date): Promise<HistoryVerdict[]>`; `maxRiskPerTrade(userId, now): Promise<number | null>`; `dailyLossLatched(userId, istDay: string): Promise<boolean>`.
- Produces (service): `type GateContext = { kind: 'ready'; verdict: { id: string; createdAt: Date }; packet: PacketFacts; history: HistoryVerdict[]; maxLossPerTrade: number | null; dailyLossLatched: boolean } | { kind: 'unreadable'; reason: string }`; `ExitGateService` with `enabled(): boolean`, `load(v: PendingVerdict, now: Date): Promise<GateContext>` (never rejects, bounded by `GATE_LOAD_TIMEOUT_MS`), `decide(ctx: GateContext, live: { ltpNow: number; productType: string | null; exchange: string; now: Date }): GateRecordV1` (never throws: an exception ⇒ `bypassRecord('FACTS_UNREADABLE', …)`). DI token for the clock: reuse `AI_EXIT_SESSION_CLOCK`.

- [ ] **Step 1: Write the failing tests**

`exit-gate.repository.spec.ts` (Prisma fake; asserts the SQL contract):

```ts
import { ExitGateRepository } from './exit-gate.repository';

describe('ExitGateRepository', () => {
  const prisma = {
    $queryRaw: jest.fn(),
    sentinelVerdict: { findUnique: jest.fn() },
    coreRiskLimit: { findFirst: jest.fn() },
    coreJournal: { findUnique: jest.fn() },
  };
  const repo = new ExitGateRepository(prisma as never);
  beforeEach(() => jest.clearAllMocks());

  it('verdictPacket selects only the packet', async () => {
    prisma.sentinelVerdict.findUnique.mockResolvedValue({ packet: { a: 1 } });
    await expect(repo.verdictPacket('v1')).resolves.toEqual({ a: 1 });
    expect(prisma.sentinelVerdict.findUnique).toHaveBeenCalledWith({ where: { id: 'v1' }, select: { packet: true } });
    prisma.sentinelVerdict.findUnique.mockResolvedValue(null);
    await expect(repo.verdictPacket('v1')).resolves.toBeNull();
  });

  it('recentVerdicts: live rows only, before the current, numeric JSON extraction, newest first', async () => {
    prisma.$queryRaw.mockResolvedValue([
      { id: 'a', verdict: 'HOLD', createdAt: new Date('2026-10-14T10:50:00Z'), underlying: 8998, support: 8946, resistance: null },
    ]);
    const rows = await repo.recentVerdicts('t1', 'cur', new Date('2026-10-14T11:01:00Z'), new Date('2026-10-14T10:01:00Z'));
    expect(rows).toEqual([{ id: 'a', verdict: 'HOLD', createdAt: new Date('2026-10-14T10:50:00Z'), underlying: 8998, support: 8946, resistance: null }]);
    const sql = (prisma.$queryRaw.mock.calls[0][0] as { strings: string[] }).strings.join('?');
    expect(sql).toMatch(/"promptVersion" !~ '\^o\[0-9\]\+\/'/);
    expect(sql).toMatch(/jsonb_typeof/);
    expect(sql).toMatch(/ORDER BY v\."createdAt" DESC/);
    expect(sql).toMatch(/"id" <> /);
  });

  it('maxRiskPerTrade: the effective ALL-scope row, as a number', async () => {
    prisma.coreRiskLimit.findFirst.mockResolvedValue({ numValue: { toString: () => '2000.00' } });
    await expect(repo.maxRiskPerTrade('u', new Date('2026-10-14T11:00:00Z'))).resolves.toBe(2000);
    expect(prisma.coreRiskLimit.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ userId: 'u', key: 'maxRiskPerTrade', scope: 'ALL' }),
    }));
    prisma.coreRiskLimit.findFirst.mockResolvedValue(null);
    await expect(repo.maxRiskPerTrade('u', new Date())).resolves.toBeNull();
  });

  it('dailyLossLatched: the daily-loss monitor dedupeKey for the IST day', async () => {
    prisma.coreJournal.findUnique.mockResolvedValue({ id: 'j' });
    await expect(repo.dailyLossLatched('u', '2026-10-14')).resolves.toBe(true);
    expect(prisma.coreJournal.findUnique).toHaveBeenCalledWith({ where: { dedupeKey: 'latch:u:2026-10-14' }, select: { id: true } });
  });
});
```

`exit-gate.service.spec.ts`:

```ts
import { parseExitDisciplineConfig } from '../../exit-discipline/config';
import { ExitGateService } from './exit-gate.service';

const V = { id: 'cur', userId: 'owner', trackerId: 't1', symbol: 'CRUDEOIL17NOV269000CE', reason: 'r', createdAt: new Date('2026-10-14T11:01:00Z') };
const NOW = new Date('2026-10-14T11:01:20Z');
const PACKET = {
  position: { symbol: 'CRUDEOIL17NOV269000CE', side: 'LONG', qty: 100, entryPrice: 521.9, ltp: 527.6, expiry: '2026-11-17',
    underlyingLtp: { available: true, value: 9003 } },
  money: { charges: 61, netPnl: 509, greenFloorPrice: 530.5, greenFloorArmed: true, floorBasis: 'noise' },
  thesis: { available: true, value: { invalidation: 8932 } },
  structure: { levelBook: { available: true, value: { vwap: 9000, atr14: 13.5 } } },
  flow: { noiseUnit: { available: true, value: { contract: { n: 4.5, method: 'atr14-1m', bars: 14, at: 'x' }, underlying: null } } },
  session: { nowUtc: '2026-10-14T11:00:30Z' },
};
function make(o: { packet?: unknown; history?: unknown[]; slow?: boolean; throws?: boolean; env?: Record<string, string> } = {}) {
  const repo = {
    verdictPacket: jest.fn(async () => {
      if (o.throws) throw new Error('db down');
      if (o.slow) await new Promise((r) => setTimeout(r, 5_000));
      return o.packet === undefined ? PACKET : o.packet;
    }),
    recentVerdicts: jest.fn(async () => o.history ?? [
      { id: 'h', verdict: 'HOLD', createdAt: new Date('2026-10-14T10:50:00Z'), underlying: 8998, support: 8946, resistance: 9020 },
    ]),
    maxRiskPerTrade: jest.fn(async () => 2000),
    dailyLossLatched: jest.fn(async () => false),
  };
  const clock = { minutesToClose: jest.fn(() => 418) };
  const svc = new ExitGateService(repo as never, clock as never, parseExitDisciplineConfig(o.env ?? {}));
  return { svc, repo, clock };
}

describe('ExitGateService', () => {
  afterEach(() => jest.useRealTimers());

  it('evidence-like verdict ⇒ GATED_THESIS_INTACT with facts from packet + live ltp/product', async () => {
    const { svc, repo } = make();
    const ctx = await svc.load(V as never, NOW);
    const r = svc.decide(ctx, { ltpNow: 527.1, productType: 'CARRYFORWARD', exchange: 'MCX', now: NOW });
    expect(r).toMatchObject({ outcome: 'GATED_THESIS_INTACT', facts: { ltpNow: 527.1, productType: 'CARRYFORWARD', minutesToClose: 418, nContract: 4.5 } });
    expect(repo.recentVerdicts).toHaveBeenCalledWith('t1', 'cur', V.createdAt, new Date(V.createdAt.getTime() - 60 * 60_000));
  });

  it('missing verdict row ⇒ BYPASS FACTS_UNREADABLE (fail-open), never throws', async () => {
    const { svc } = make({ packet: null });
    const r = svc.decide(await svc.load(V as never, NOW), { ltpNow: 527.1, productType: null, exchange: 'MCX', now: NOW });
    expect(r).toMatchObject({ outcome: 'BYPASS', bypassReason: 'FACTS_UNREADABLE' });
  });

  it('DB error ⇒ unreadable', async () => {
    const { svc } = make({ throws: true });
    await expect(svc.load(V as never, NOW)).resolves.toEqual({ kind: 'unreadable', reason: expect.stringContaining('db down') });
  });

  it('load is bounded by GATE_LOAD_TIMEOUT_MS', async () => {
    jest.useFakeTimers();
    const { svc } = make({ slow: true });
    const p = svc.load(V as never, NOW);
    await jest.advanceTimersByTimeAsync(2_001);
    await expect(p).resolves.toEqual({ kind: 'unreadable', reason: expect.stringMatching(/timed out/) });
  });

  it('disabled ⇒ enabled() false and decide returns BYPASS DISABLED without reading anything', () => {
    const { svc, repo } = make({ env: { EXIT_DISCIPLINE_ENABLED: 'false' } });
    expect(svc.enabled()).toBe(false);
    expect(svc.decide({ kind: 'unreadable', reason: 'x' }, { ltpNow: 1, productType: null, exchange: 'MCX', now: NOW }))
      .toMatchObject({ outcome: 'BYPASS', bypassReason: 'DISABLED' });
    expect(repo.verdictPacket).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && npx jest src/modules/sentinel-executor/repositories/exit-gate.repository.spec.ts src/modules/sentinel-executor/services/exit-gate.service.spec.ts --ci --maxWorkers=2`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

Before writing `maxRiskPerTrade`, open `apps/api/src/modules/trade-core/risk-wall/` and find how the wall picks a user's effective row (`grep -rn effectiveFrom apps/api/src/modules/trade-core/risk-wall`); match that rule exactly (below is the expected shape — if the wall differs, use its rule and say so in the commit body). Before writing `dailyLossLatched`, confirm in `trade-core/lifecycle/daily-loss.monitor.ts` that `day = istDate(now)` is `YYYY-MM-DD` (line ~69) and the key is `latch:${userId}:${day}`.

`exit-gate.repository.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { HistoryVerdict } from '../../exit-discipline/persistence';

/** Reads for the exit gate (exit discipline §6/§7). Read-only; never writes anything. */
@Injectable()
export class ExitGateRepository {
  constructor(private readonly prisma: PrismaService) {}

  async verdictPacket(verdictId: string): Promise<unknown | null> {
    const row = await this.prisma.sentinelVerdict.findUnique({ where: { id: verdictId }, select: { packet: true } });
    return row ? row.packet : null;
  }

  /** Live verdicts on the tracker in [since, before), newest first; overnight-review rows excluded. */
  recentVerdicts(trackerId: string, excludeId: string, before: Date, since: Date): Promise<HistoryVerdict[]> {
    return this.prisma.$queryRaw<HistoryVerdict[]>(Prisma.sql`
      SELECT v."id", v."verdict", v."createdAt",
        CASE WHEN jsonb_typeof(v."packet" #> '{position,underlyingLtp,value}') = 'number'
             THEN (v."packet" #>> '{position,underlyingLtp,value}')::float8 END AS "underlying",
        CASE WHEN jsonb_typeof(v."packet" #> '{structure,nearestSupport,value}') = 'number'
             THEN (v."packet" #>> '{structure,nearestSupport,value}')::float8 END AS "support",
        CASE WHEN jsonb_typeof(v."packet" #> '{structure,nearestResistance,value}') = 'number'
             THEN (v."packet" #>> '{structure,nearestResistance,value}')::float8 END AS "resistance"
      FROM "sentinel_verdicts" v
      WHERE v."trackerId" = ${trackerId}
        AND v."id" <> ${excludeId}
        AND v."createdAt" < ${before} AND v."createdAt" >= ${since}
        AND v."promptVersion" !~ '^o[0-9]+/'
      ORDER BY v."createdAt" DESC
      LIMIT 60`);
  }

  async maxRiskPerTrade(userId: string, now: Date): Promise<number | null> {
    const row = await this.prisma.coreRiskLimit.findFirst({
      where: { userId, key: 'maxRiskPerTrade', scope: 'ALL', effectiveFrom: { lte: now } },
      orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
      select: { numValue: true },
    });
    const n = row?.numValue != null ? Number(row.numValue.toString()) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  async dailyLossLatched(userId: string, istDay: string): Promise<boolean> {
    const row = await this.prisma.coreJournal.findUnique({ where: { dedupeKey: `latch:${userId}:${istDay}` }, select: { id: true } });
    return row !== null;
  }
}
```

`exit-gate.service.ts`:

```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { EXIT_DISCIPLINE_CONFIG, GATE_LOAD_TIMEOUT_MS, STREAK_LOOKBACK_MIN, type ExitDisciplineConfig } from '../../exit-discipline/config';
import { buildGateFacts, bypassRecord, decideExit, istDate } from '../../exit-discipline/decision';
import { readPacketFacts, type PacketFacts } from '../../exit-discipline/packet-facts';
import type { HistoryVerdict } from '../../exit-discipline/persistence';
import type { GateRecordV1 } from '../../exit-discipline/types';
import type { SessionClock } from '../../market-hub/session-clock';
import type { PendingVerdict } from '../repositories/ai-exit-execution.repository';
import { ExitGateRepository } from '../repositories/exit-gate.repository';
import { AI_EXIT_SESSION_CLOCK } from './sentinel-exit-executor.service';

export type GateContext =
  | { kind: 'ready'; verdict: { id: string; createdAt: Date }; packet: PacketFacts; history: HistoryVerdict[]; maxLossPerTrade: number | null; dailyLossLatched: boolean }
  | { kind: 'unreadable'; reason: string };

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Exit discipline §6/§7 for AI EXIT_NOW verdicts ONLY. Reads, never writes, never
 * touches the broker. The executor calls `load` concurrently with its session
 * lease and `decide` after its first pre-order check (plan R8).
 */
@Injectable()
export class ExitGateService {
  private readonly logger = new Logger(ExitGateService.name);

  constructor(
    private readonly repo: ExitGateRepository,
    @Inject(AI_EXIT_SESSION_CLOCK) private readonly clock: Pick<SessionClock, 'minutesToClose'>,
    @Inject(EXIT_DISCIPLINE_CONFIG) private readonly cfg: ExitDisciplineConfig,
  ) {}

  enabled(): boolean {
    return this.cfg.enabled;
  }

  async load(v: PendingVerdict, now: Date): Promise<GateContext> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<GateContext>((resolve) => {
      timer = setTimeout(() => resolve({ kind: 'unreadable', reason: `gate facts timed out after ${GATE_LOAD_TIMEOUT_MS} ms` }), GATE_LOAD_TIMEOUT_MS);
      timer.unref?.();
    });
    try {
      return await Promise.race([this.read(v, now), timeout]);
    } catch (err) {
      return { kind: 'unreadable', reason: errText(err) };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async read(v: PendingVerdict, now: Date): Promise<GateContext> {
    const packet = await this.repo.verdictPacket(v.id);
    if (packet == null) return { kind: 'unreadable', reason: 'verdict row not found' };
    const facts = readPacketFacts(packet);
    if ('unreadable' in facts) return { kind: 'unreadable', reason: facts.unreadable };
    const since = new Date(v.createdAt.getTime() - STREAK_LOOKBACK_MIN * 60_000);
    const [history, maxLossPerTrade, dailyLossLatched] = await Promise.all([
      this.repo.recentVerdicts(v.trackerId, v.id, v.createdAt, since),
      this.repo.maxRiskPerTrade(v.userId, now),
      this.repo.dailyLossLatched(v.userId, istDate(now)),
    ]);
    return { kind: 'ready', verdict: { id: v.id, createdAt: v.createdAt }, packet: facts, history, maxLossPerTrade, dailyLossLatched };
  }

  decide(ctx: GateContext, live: { ltpNow: number; productType: string | null; exchange: string; now: Date }): GateRecordV1 {
    if (!this.cfg.enabled) return bypassRecord('DISABLED', this.cfg, live.now);
    if (ctx.kind === 'unreadable') {
      this.logger.warn(`[exit-gate] facts unreadable — failing OPEN (today's behaviour): ${ctx.reason}`);
      return bypassRecord('FACTS_UNREADABLE', this.cfg, live.now, ctx.reason);
    }
    try {
      const facts = buildGateFacts(ctx.packet, {
        ltpNow: live.ltpNow, productType: live.productType,
        minutesToClose: this.clock.minutesToClose(live.exchange, live.now),
        maxLossPerTrade: ctx.maxLossPerTrade, dailyLossLatched: ctx.dailyLossLatched, history: ctx.history, now: live.now,
      });
      return decideExit({ facts, current: ctx.verdict, history: ctx.history, cfg: this.cfg, now: live.now });
    } catch (err) {
      this.logger.warn(`[exit-gate] evaluation threw — failing OPEN: ${errText(err)}`);
      return bypassRecord('FACTS_UNREADABLE', this.cfg, live.now, errText(err));
    }
  }
}
```

Check `SessionClock.minutesToClose(exchange, now)` returns `number | null` (`market-hub/session-clock.ts`); if its signature differs, adapt the call, not the test's meaning.

- [ ] **Step 4: Run to verify they pass**

Run: `cd apps/api && npx jest src/modules/sentinel-executor/repositories/exit-gate.repository.spec.ts src/modules/sentinel-executor/services/exit-gate.service.spec.ts --ci --maxWorkers=2`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/sentinel-executor/repositories/exit-gate.repository.ts apps/api/src/modules/sentinel-executor/repositories/exit-gate.repository.spec.ts apps/api/src/modules/sentinel-executor/services/exit-gate.service.ts apps/api/src/modules/sentinel-executor/services/exit-gate.service.spec.ts
git commit -m "feat(sentinel-executor): exit gate facts (bounded, fail-open) and decision service

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Wire the gate into the executor — AI only (Stream A, after Task 2)

**Files:**
- Modify: `apps/api/src/modules/sentinel-executor/services/sentinel-exit-executor.service.ts`
- Modify: `apps/api/src/modules/sentinel-executor/services/sentinel-exit-executor.service.spec.ts`
- Modify: `apps/api/src/modules/sentinel-executor/repositories/ai-exit-execution.repository.ts` (`AiExitPatch` gains every Task 2 column)
- Modify: `apps/api/src/modules/sentinel-executor/services/sentinel-exit-poller.service.ts` (+spec) — boot log
- Modify: `apps/api/src/modules/sentinel-executor/sentinel-executor.module.ts` (+spec)
- Modify: `apps/api/src/modules/sentinel-executor/sentinel-executor.structure.spec.ts`

**Interfaces:**
- Consumes: Task 6 `ExitGateService` (`enabled`, `load`, `decide`), Task 4 `isBlocking`, `gateSummary`, `bypassRecord`; Task 1 `EXIT_DISCIPLINE_CONFIG`, `parseExitDisciplineConfig`, `describeExitDiscipline`.
- Produces: `SentinelExitExecutor` constructor gains a 6th parameter `gate: ExitGateService`; `AI_EXIT_SESSION_CLOCK` type becomes `Pick<SessionClock, 'isOpen' | 'minutesToClose' | 'tradingWindow'>`; `AiExitPatch` = `Partial<Pick<AiExitExecution, …existing… | 'decisionLtp' | 'decisionAt' | 'orderLtp' | 'orderSentAt' | 'fillPrice' | 'fillQty' | 'fillAt' | 'slippage' | 'latencyMs'>> & { status?; sessionSource?; gate?: GateRecordV1 }` (cast `gate` to `Prisma.InputJsonValue` inside `update`). New SKIPPED reasons: `GATED_THESIS_INTACT`, `AWAITING_CONFIRMATION`.

- [ ] **Step 1: Write the failing tests**

In the executor spec, extend `harness()`:

```ts
  gate?: { enabled: () => boolean; load: jest.Mock; decide: jest.Mock };
```

and inside it:

```ts
  const gate = opts.gate ?? { enabled: () => false, load: jest.fn(), decide: jest.fn() };
  const clock = { isOpen: jest.fn(() => opts.open ?? true), minutesToClose: jest.fn(() => 419), tradingWindow: jest.fn(() => null) };
  const ex = new SentinelExitExecutor(repo as never, prisma as never, sessions as never, clock as never, sleep, gate as never);
  // calls[] logging: wrap gate.load so its START is visible in the call order
```

(Replace the existing `clock` and `ex` lines; return `gate` from the harness.) Add helpers and a describe:

```ts
import { bypassRecord } from '../../exit-discipline/decision';
import { parseExitDisciplineConfig } from '../../exit-discipline/config';
import type { GateRecordV1 } from '../../exit-discipline/types';

const DCFG = parseExitDisciplineConfig({});
const rec = (outcome: GateRecordV1['outcome'], justification: GateRecordV1['justification'] = null): GateRecordV1 =>
  ({ ...bypassRecord('DISABLED', DCFG, NOW), outcome, bypassReason: undefined, justification });
function gateStub(record: GateRecordV1, calls?: string[]) {
  return {
    enabled: () => true,
    load: jest.fn(async () => { calls?.push('gate-load'); return { kind: 'ready' } as never; }),
    decide: jest.fn(() => record),
  };
}
const FILLED_BOOK = env([{ orderid: 'O1', status: 'complete', averageprice: '527.10', filledshares: '100', exchorderupdatetime: '12-Oct-2026 15:30:04' }]);

describe('SentinelExitExecutor — exit gate (exit discipline §6/§7, Review Focus 1–2)', () => {
  it('GATED_THESIS_INTACT: SKIPPED, gate JSON on the row, no place, no cancel', async () => {
    const gate = gateStub(rec('GATED_THESIS_INTACT'));
    const h = harness({ gate });
    await expect(h.ex.process(V, LIVE, NOW)).resolves.toEqual({ status: 'SKIPPED', reason: 'GATED_THESIS_INTACT' });
    expect(h.session.placeOrderClassified).not.toHaveBeenCalled();
    expect(h.session.cancelOrderClassified).not.toHaveBeenCalled();
    expect(h.patches()).toEqual(expect.arrayContaining([
      expect.objectContaining({ side: 'SELL', quantity: 100, orderLtp: 50.25, gate: expect.objectContaining({ outcome: 'GATED_THESIS_INTACT' }) }),
    ]));
    expect(h.lastPatch()).toEqual(expect.objectContaining({ status: 'SKIPPED', reason: 'GATED_THESIS_INTACT' }));
    expect(gate.decide).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ ltpNow: 50.25, productType: 'CARRYFORWARD', exchange: 'MCX' }));
  });

  it('AWAITING_CONFIRMATION: SKIPPED, nothing sent', async () => {
    const h = harness({ gate: gateStub(rec('AWAITING_CONFIRMATION', 'THESIS_BROKEN')) });
    await expect(h.ex.process(V, LIVE, NOW)).resolves.toEqual({ status: 'SKIPPED', reason: 'AWAITING_CONFIRMATION' });
    expect(h.session.placeOrderClassified).not.toHaveBeenCalled();
  });

  it('dry-run is gated too (a blocked verdict never records DRY_RUN)', async () => {
    const h = harness({ gate: gateStub(rec('GATED_THESIS_INTACT')) });
    await expect(h.ex.process(V, DRY_MCX_UNITS, NOW)).resolves.toEqual({ status: 'SKIPPED', reason: 'GATED_THESIS_INTACT' });
  });

  it('a gated verdict never cancels a protective stop-loss (gate runs before cancelProtective)', async () => {
    const cfg = parseAutoExitConfig({ AI_AUTO_EXIT_ENABLED: 'true', AI_AUTO_EXIT_MODE: 'live', AI_AUTO_EXIT_USER_IDS: 'owner',
      AI_AUTO_EXIT_QTY_UNITS: 'MCX:units', AI_AUTO_EXIT_CANCEL_PROTECTIVE: 'true' });
    const sl = { orderid: 'SL1', symboltoken: '445566', exchange: 'MCX', status: 'trigger pending', transactiontype: 'SELL',
      ordertype: 'STOPLOSS_MARKET', quantity: '100', producttype: 'CARRYFORWARD', variety: 'STOPLOSS' };
    const h = harness({ gate: gateStub(rec('GATED_THESIS_INTACT')), books: [env([sl])] });
    await expect(h.ex.process(V, cfg, NOW)).resolves.toEqual({ status: 'SKIPPED', reason: 'GATED_THESIS_INTACT' });
    expect(h.session.cancelOrderClassified).not.toHaveBeenCalled();
    expect(h.session.placeOrderClassified).not.toHaveBeenCalled();
  });

  it('PASS (hard risk, first EXIT_NOW): sells; the gate load started BEFORE the positions read', async () => {
    const gate = gateStub(rec('PASS', 'HARD_RISK'));
    const h = harness({ gate, positions: [env([posRow('100')]), env([posRow('0')])], books: [env([]), FILLED_BOOK] });
    gate.load.mockImplementation(async () => { h.calls.push('gate-load'); return { kind: 'ready' }; });
    await expect(h.ex.process(V, LIVE, NOW)).resolves.toEqual({ status: 'FILLED' });
    expect(h.calls.indexOf('gate-load')).toBeGreaterThan(-1);
    expect(h.calls.indexOf('gate-load')).toBeLessThan(h.calls.indexOf('positions'));
    expect(h.session.placeOrderClassified).toHaveBeenCalledTimes(1);
  });

  it('BYPASS FACTS_UNREADABLE fails open: the exit proceeds as today', async () => {
    const h = harness({ gate: gateStub(bypassRecord('FACTS_UNREADABLE', DCFG, NOW, 'x')), positions: [env([posRow('100')]), env([posRow('0')])] });
    await h.ex.process(V, LIVE, NOW);
    expect(h.session.placeOrderClassified).toHaveBeenCalledTimes(1);
  });

  it('disabled: no load, no decide, the row records BYPASS DISABLED, behaviour unchanged', async () => {
    const gate = { enabled: () => false, load: jest.fn(), decide: jest.fn() };
    const h = harness({ gate, positions: [env([posRow('100')]), env([posRow('0')])] });
    await h.ex.process(V, LIVE, NOW);
    expect(gate.load).not.toHaveBeenCalled();
    expect(gate.decide).not.toHaveBeenCalled();
    expect(h.patches()).toEqual(expect.arrayContaining([expect.objectContaining({ gate: expect.objectContaining({ outcome: 'BYPASS', bypassReason: 'DISABLED' }) })]));
    expect(h.session.placeOrderClassified).toHaveBeenCalledTimes(1);
  });

  it('MANUAL never consults the gate — a gate that blocks everything changes nothing (E2)', async () => {
    const gate = gateStub(rec('GATED_THESIS_INTACT'));
    const h = harness({ gate, positions: [env([posRow('100')]), env([posRow('0')])] });
    await h.ex.execute('row1', V, LIVE, NOW, 'MANUAL');
    expect(gate.load).not.toHaveBeenCalled();
    expect(gate.decide).not.toHaveBeenCalled();
    expect(h.session.placeOrderClassified).toHaveBeenCalledTimes(1);
    expect(h.patches().some((p: any) => 'gate' in p)).toBe(false);
  });

  it('PRICE_TRIGGER never consults the gate (E2; cast until price triggers merges — Merge point M1)', async () => {
    const gate = gateStub(rec('GATED_THESIS_INTACT'));
    const h = harness({ gate, positions: [env([posRow('100')]), env([posRow('0')])] });
    await h.ex.execute('row1', { ...V, id: 'trg_cm9trigger0000000000000001' }, LIVE, NOW, 'PRICE_TRIGGER' as never);
    expect(gate.load).not.toHaveBeenCalled();
    expect(gate.decide).not.toHaveBeenCalled();
    expect(h.session.placeOrderClassified).toHaveBeenCalledTimes(1);
  });

  it('a guard failure (e.g. stale verdict) never starts the gate load', async () => {
    const gate = gateStub(rec('PASS', 'HARD_RISK'));
    const h = harness({ gate });
    await h.ex.process({ ...V, createdAt: new Date(NOW.getTime() - 10 * 60_000) }, LIVE, NOW);
    expect(gate.load).not.toHaveBeenCalled();
  });
});
```

(The protective-order row shape must match what `protectiveOrdersFor` in `domain/exit-order.ts` recognises — copy it from the existing `CANCEL_PROTECTIVE` tests in this spec rather than from above if they differ.)

In `sentinel-executor.structure.spec.ts` add:

```ts
describe('exit gate shape (exit discipline, Review Focus 1)', () => {
  it('the executor consults the gate only on trigger === \'AI\' (positive match, never !== MANUAL)', () => {
    const src = code(join(__dirname, 'services', 'sentinel-exit-executor.service.ts'));
    const sites = [...src.matchAll(/this\.gate\.(load|decide|enabled)\(/g)];
    expect(sites.length).toBeGreaterThanOrEqual(2);
    expect(src).toMatch(/const gated = trigger === 'AI'/);
  });
  it('no new exit-discipline file in this module writes to the broker', () => {
    for (const f of ['services/exit-gate.service.ts', 'repositories/exit-gate.repository.ts']) {
      expect(code(join(__dirname, f))).not.toMatch(/placeOrder|cancelOrder|modifyOrder|withOwnerSession/);
    }
  });
});
```

Poller spec: add a test that `onModuleInit` with auto-exit enabled logs `[exit-discipline] ON floorArmN=1.5 …` (spy on the logger as the existing ENABLED-line test does) and warns each config problem.

Module spec: assert `ExitGateService`, `ExitGateRepository` and `EXIT_DISCIPLINE_CONFIG` are providers.

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && npx jest src/modules/sentinel-executor --ci --maxWorkers=2`
Expected: FAIL — constructor arity / gate not consulted / `orderLtp` missing.

- [ ] **Step 3: Implement**

`ai-exit-execution.repository.ts`: extend `AiExitPatch` as in Interfaces; in `update`:

```ts
  async update(id: string, patch: AiExitPatch): Promise<void> {
    const { gate, ...rest } = patch;
    await this.prisma.aiExitExecution.update({
      where: { id },
      data: gate === undefined ? rest : { ...rest, gate: gate as unknown as Prisma.InputJsonValue },
    });
  }
```

`sentinel-exit-executor.service.ts`:

1. Imports: `ExitGateService`, `type GateContext` from `./exit-gate.service`; `bypassRecord, gateSummary, isBlocking` from `../../exit-discipline/decision`; `parseExitDisciplineConfig` is NOT needed here.
2. Clock type: `@Inject(AI_EXIT_SESSION_CLOCK) private readonly clock: Pick<SessionClock, 'isOpen' | 'minutesToClose' | 'tradingWindow'>`.
3. Constructor: add `private readonly gate: ExitGateService,` as the last parameter. (`ExitGateService` imports `AI_EXIT_SESSION_CLOCK` from this file; to avoid a runtime import cycle, MOVE `AI_EXIT_SESSION_CLOCK` and `AI_EXIT_SLEEP` to a new `services/executor.tokens.ts` and re-export them from this file: `export { AI_EXIT_SESSION_CLOCK, AI_EXIT_SLEEP } from './executor.tokens';`. Update `exit-gate.service.ts` to import from `./executor.tokens`.)
4. In `execute()`, after the guard block (after `const t = tracker as Tracker;` and the instrument read), before `const run: Run = …`:

```ts
    // Exit discipline (plan R8): AI verdicts only — MANUAL and PRICE_TRIGGER never reach the gate (E2).
    // Started now so its DB reads overlap the session lease and the broker reads below.
    const gated = trigger === 'AI';
    const gateLoad: Promise<GateContext> | null = gated && this.gate.enabled() ? this.gate.load(v, now) : null;
```

5. `recordPlan` gains extras:

```ts
  private recordPlan(id: string, o: OrderRequest, extra: AiExitPatch = {}): Promise<void> {
    return this.repo.update(id, {
      exchange: o.exchange, token: o.token, side: o.side, quantity: o.quantity,
      productType: o.positionType, orderType: 'MARKET', ...extra,
    });
  }
```

6. Inside the lease, replace `await this.recordPlan(id, first.order);` with:

```ts
        let gate: GateRecordV1 | null = null;
        if (gated) {
          gate = gateLoad
            ? this.gate.decide(await gateLoad, { ltpNow: first.ltp, productType: first.order.positionType ?? null, exchange: t.exchange, now })
            : bypassRecord('DISABLED', DISABLED_CFG, now);
        }
        await this.recordPlan(id, first.order, { orderLtp: first.ltp, ...(gate ? { gate } : {}) });
        if (isBlocking(gate)) {
          this.logger.log(`[exit-gate] ${gateSummary(gate as GateRecordV1)} — ${v.symbol} verdict ${v.id}`);
          return this.finish(id, v, 'SKIPPED', (gate as GateRecordV1).outcome);
        }
        if (gate && gate.outcome === 'PASS') {
          this.logger.log(`[exit-gate] ${gateSummary(gate)} — ${v.symbol} verdict ${v.id}`);
        }
```

   where at module level: `const DISABLED_CFG = parseExitDisciplineConfig({ EXIT_DISCIPLINE_ENABLED: 'false' });` (import `parseExitDisciplineConfig` after all — only to stamp the DISABLED record's cfg; the real cfg lives in the gate service). Simpler alternative that is equally acceptable: give `ExitGateService` a `disabledRecord(now)` method and call `this.gate.disabledRecord(now)`; pick one, keep the test expectation (`outcome: 'BYPASS', bypassReason: 'DISABLED'`).

7. After a protective cancel, keep the LTP on the second plan write: `await this.recordPlan(id, pre.order, { orderLtp: pre.ltp });`.

`sentinel-exit-poller.service.ts` `onModuleInit`, right after the `[ai-exit] ENABLED …` warn:

```ts
    const d = parseExitDisciplineConfig(process.env);
    for (const p of d.problems) this.logger.warn(`[exit-discipline] ${p}`);
    this.logger.warn(`[exit-discipline] ${describeExitDiscipline(d)}`);
```

`sentinel-executor.module.ts` providers: `ExitGateRepository`, `ExitGateService`, `{ provide: EXIT_DISCIPLINE_CONFIG, useFactory: () => { const c = parseExitDisciplineConfig(process.env); return c; } }`.

- [ ] **Step 4: Run to verify they pass**

Run: `cd apps/api && npx jest src/modules/sentinel-executor --ci --maxWorkers=2`
Expected: PASS (every pre-existing executor test unchanged in meaning; adjust only constructor/clock fakes).
Run: `cd apps/api && npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/sentinel-executor/services/sentinel-exit-executor.service.ts apps/api/src/modules/sentinel-executor/services/sentinel-exit-executor.service.spec.ts apps/api/src/modules/sentinel-executor/services/executor.tokens.ts apps/api/src/modules/sentinel-executor/services/exit-gate.service.ts apps/api/src/modules/sentinel-executor/repositories/ai-exit-execution.repository.ts apps/api/src/modules/sentinel-executor/services/sentinel-exit-poller.service.ts apps/api/src/modules/sentinel-executor/services/sentinel-exit-poller.service.spec.ts apps/api/src/modules/sentinel-executor/sentinel-executor.module.ts apps/api/src/modules/sentinel-executor/sentinel-executor.module.spec.ts apps/api/src/modules/sentinel-executor/sentinel-executor.structure.spec.ts
git commit -m "feat(sentinel-executor): exit gate on AI EXIT_NOW — gated/awaiting verdicts never sell

The gate runs only for trigger === 'AI', after the first pre-order check and
before recordPlan, dry-run, cancelProtective and place. Its facts load
concurrently with the session lease (bounded 2 s, fail-open). MANUAL and
PRICE_TRIGGER never reach it. Every evaluation is stored on the row (E7).

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Noise unit, noise-aware floor and giveback (Stream B, pure)

**Files:**
- Create: `apps/api/src/modules/exit-discipline/noise.ts`, `noise.spec.ts`
- Create: `apps/api/src/modules/exit-discipline/floor.ts`, `floor.spec.ts`
- Create: `apps/api/src/modules/exit-discipline/giveback.ts`, `giveback.spec.ts`

**Interfaces:**
- Produces: `noiseFromBars(bars: MinuteBar[]): NoiseReading | null`; `scaledUnderlyingNoise(atr15m: number | null | undefined, at: string): NoiseReading | null`; `noiseAwareFloor(i: { side: PositionSide; breakeven: number; peak: number | null; n: number; armN: number; trailN: number; prevArmedLevel: number | null; latchedArmed: boolean }): NoiseFloor`; `noiseGiveback(i: { side: PositionSide; entryPrice: number; ltp: number; peak: number | null; n: number; armN: number; givebackN: number }): { fire: boolean; excursion: number; pullback: number } | null` (null = an input not finite / peak null).

- [ ] **Step 1: Write the failing tests**

`noise.spec.ts`:

```ts
import { noiseFromBars, scaledUnderlyingNoise } from './noise';
import type { MinuteBar } from './types';

const T0 = Date.parse('2026-10-14T10:09:00Z');
/** n bars, each high-low = w, closes continuous (no gaps). */
const flatBars = (n: number, w = 4, base = 100): MinuteBar[] =>
  Array.from({ length: n }, (_, i) => ({ ts: T0 + i * 60_000, open: base, high: base + w / 2, low: base - w / 2, close: base }));

describe('noiseFromBars (R2)', () => {
  it('>= 14 bars: mean of the last 14 true ranges', () => {
    expect(noiseFromBars(flatBars(20))).toEqual({ n: 4, method: 'atr14-1m', bars: 20, at: new Date(T0 + 20 * 60_000).toISOString() });
  });
  it('true range includes the gap from the previous close', () => {
    const bars = flatBars(14);
    bars[13] = { ts: bars[13].ts, open: 105, high: 106, low: 104, close: 105 }; // prev close 100 ⇒ TR = 6
    expect(noiseFromBars(bars)!.n).toBeCloseTo((13 * 4 + 6) / 14, 9);
  });
  it('1–13 bars: (max high − min low)/√bars', () => {
    const bars = [100, 102, 104, 106, 110].map((c, i) => ({ ts: T0 + i * 60_000, open: c, high: c, low: c, close: c }));
    expect(noiseFromBars(bars)).toMatchObject({ method: 'range-sqrt-1m', bars: 5 });
    expect(noiseFromBars(bars)!.n).toBeCloseTo(10 / Math.sqrt(5), 9);
  });
  it('no bars, invalid bars, or zero range ⇒ null', () => {
    expect(noiseFromBars([])).toBeNull();
    expect(noiseFromBars([{ ts: T0, open: NaN, high: 1, low: 0.5, close: 1 }])).toBeNull();
    expect(noiseFromBars([{ ts: T0, open: 1, high: 0.5, low: 1, close: 1 }])).toBeNull(); // high < low
    expect(noiseFromBars(flatBars(20, 0))).toBeNull();
  });
  it('sorts by ts (input order does not matter)', () => {
    expect(noiseFromBars(flatBars(20).reverse())!.n).toBe(4);
  });
});

describe('scaledUnderlyingNoise (R3)', () => {
  it('15m ATR14 / √15', () => {
    expect(scaledUnderlyingNoise(13.5, 'x')).toEqual({ n: 13.5 / Math.sqrt(15), method: 'atr14-15m-scaled', bars: 0, at: 'x' });
  });
  it.each([null, undefined, 0, -1, NaN])('%s ⇒ null', (v) => expect(scaledUnderlyingNoise(v as never, 'x')).toBeNull());
});
```

`floor.spec.ts`:

```ts
import { noiseAwareFloor } from './floor';

const L = { side: 'LONG' as const, breakeven: 522.9, n: 4.5, armN: 1.5, trailN: 2, prevArmedLevel: null, latchedArmed: false };
const S = { side: 'SHORT' as const, breakeven: 100, n: 2, armN: 1.5, trailN: 2, prevArmedLevel: null, latchedArmed: false };

describe('noiseAwareFloor (R4, spec §4)', () => {
  it.each([
    ['LONG unarmed: excursion 5.1 < 6.75 ⇒ target = breakeven + 1.5N', { ...L, peak: 528 }, false, 529.65],
    ['LONG armed: trails the peak by 2N', { ...L, peak: 539.5 }, true, 530.5],
    ['LONG armed, trail below breakeven ⇒ breakeven', { ...L, peak: 530, latchedArmed: true }, true, 522.9],
    ['LONG tighten-only: previous 531 beats 530.5', { ...L, peak: 539.5, prevArmedLevel: 531 }, true, 531],
    ['LONG tighten-only: a looser previous never loosens', { ...L, peak: 539.5, prevArmedLevel: 529 }, true, 530.5],
    ['LONG no peak, not latched ⇒ unarmed target', { ...L, peak: null }, false, 529.65],
    ['LONG no peak, latched ⇒ breakeven', { ...L, peak: null, latchedArmed: true }, true, 522.9],
    ['SHORT armed: low 94 ⇒ 94 + 4 = 98', { ...S, peak: 94 }, true, 98],
    ['SHORT tighten-only: previous 97.5 beats 98', { ...S, peak: 94, prevArmedLevel: 97.5 }, true, 97.5],
    ['SHORT unarmed: target = breakeven − 1.5N', { ...S, peak: 98 }, false, 97],
  ])('%s', (_l, input, armed, level) => {
    const f = noiseAwareFloor(input);
    expect(f).toMatchObject({ basis: 'noise', armed, level, n: input.n });
  });
  it('armPrice is always breakeven ± armN·N', () => {
    expect(noiseAwareFloor({ ...L, peak: 539.5 }).armPrice).toBe(529.65);
    expect(noiseAwareFloor({ ...S, peak: 94 }).armPrice).toBe(97);
  });
});
```

`giveback.spec.ts`:

```ts
import { noiseGiveback } from './giveback';

const L = { side: 'LONG' as const, entryPrice: 521.9, n: 4.5, armN: 1.5, givebackN: 1.5 };
describe('noiseGiveback (spec §5)', () => {
  it.each([
    ['excursion 12.7, pullback 9.0 ⇒ fires', { ...L, peak: 534.6, ltp: 525.6 }, true],
    ['pullback 6.6 < 6.75 ⇒ quiet (ordinary chop)', { ...L, peak: 534.6, ltp: 528 }, false],
    ['excursion 5.1 < 6.75 ⇒ quiet even on a deep pullback', { ...L, peak: 527, ltp: 518 }, false],
    ['SHORT: low 90 from 100, back to 94 ⇒ fires', { side: 'SHORT' as const, entryPrice: 100, n: 2, armN: 1.5, givebackN: 1.5, peak: 90, ltp: 94 }, true],
  ])('%s', (_l, input, fire) => expect(noiseGiveback(input)!.fire).toBe(fire));
  it('non-finite inputs or no peak ⇒ null', () => {
    expect(noiseGiveback({ ...L, peak: null, ltp: 1 })).toBeNull();
    expect(noiseGiveback({ ...L, peak: 530, ltp: NaN })).toBeNull();
    expect(noiseGiveback({ ...L, peak: 530, ltp: 525, n: 0 })).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && npx jest src/modules/exit-discipline/noise.spec.ts src/modules/exit-discipline/floor.spec.ts src/modules/exit-discipline/giveback.spec.ts --ci --maxWorkers=2`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`noise.ts`:

```ts
import { ATR_PERIOD } from './config';
import type { MinuteBar, NoiseReading } from './types';

const ok = (b: MinuteBar) =>
  [b.ts, b.open, b.high, b.low, b.close].every((x) => Number.isFinite(x)) && b.low > 0 && b.high >= b.low;

/** R2. The caller chooses the window (last NOISE_LOOKBACK_MIN minutes of the IST day). */
export function noiseFromBars(input: MinuteBar[]): NoiseReading | null {
  const bars = input.filter(ok).sort((a, b) => a.ts - b.ts);
  if (bars.length === 0) return null;
  const at = new Date(bars[bars.length - 1].ts + 60_000).toISOString();
  if (bars.length >= ATR_PERIOD) {
    const tr = bars.map((b, i) => (i === 0 ? b.high - b.low
      : Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close))));
    const last = tr.slice(-ATR_PERIOD);
    const n = last.reduce((s, x) => s + x, 0) / ATR_PERIOD;
    return n > 0 ? { n, method: 'atr14-1m', bars: bars.length, at } : null;
  }
  const n = (Math.max(...bars.map((b) => b.high)) - Math.min(...bars.map((b) => b.low))) / Math.sqrt(bars.length);
  return n > 0 ? { n, method: 'range-sqrt-1m', bars: bars.length, at } : null;
}

/** R3 fallback: the underlying's 15m level-book ATR14 scaled to one minute. */
export function scaledUnderlyingNoise(atr15m: number | null | undefined, at: string): NoiseReading | null {
  return typeof atr15m === 'number' && Number.isFinite(atr15m) && atr15m > 0
    ? { n: atr15m / Math.sqrt(15), method: 'atr14-15m-scaled', bars: 0, at }
    : null;
}
```

`floor.ts`:

```ts
import type { NoiseFloor, PositionSide } from './types';

const r2 = (x: number) => Math.round(x * 100) / 100;

/** R4 / spec §4. Pure; the caller owns both latches (armed, previous level). */
export function noiseAwareFloor(i: {
  side: PositionSide; breakeven: number; peak: number | null; n: number;
  armN: number; trailN: number; prevArmedLevel: number | null; latchedArmed: boolean;
}): NoiseFloor {
  const dir = i.side === 'LONG' ? 1 : -1;
  const armPrice = r2(i.breakeven + dir * i.armN * i.n);
  const peak = i.peak !== null && Number.isFinite(i.peak) ? i.peak : null;
  const excursion = peak === null ? -Infinity : (peak - i.breakeven) * dir;
  const armed = i.latchedArmed || excursion >= i.armN * i.n - 1e-9;
  if (!armed) return { basis: 'noise', armed: false, level: armPrice, armPrice, n: i.n };
  const trail = peak === null ? i.breakeven : peak - dir * i.trailN * i.n;
  let level = dir > 0 ? Math.max(i.breakeven, trail) : Math.min(i.breakeven, trail);
  if (i.prevArmedLevel !== null && Number.isFinite(i.prevArmedLevel)) {
    level = dir > 0 ? Math.max(i.prevArmedLevel, level) : Math.min(i.prevArmedLevel, level);
  }
  return { basis: 'noise', armed: true, level: r2(level), armPrice, n: i.n };
}
```

`giveback.ts`:

```ts
import type { PositionSide } from './types';

/** Spec §5: fires only when the excursion >= armN·N AND the pullback from the peak >= givebackN·N. */
export function noiseGiveback(i: {
  side: PositionSide; entryPrice: number; ltp: number; peak: number | null; n: number; armN: number; givebackN: number;
}): { fire: boolean; excursion: number; pullback: number } | null {
  if (i.peak === null || ![i.peak, i.ltp, i.entryPrice, i.n].every(Number.isFinite) || i.n <= 0) return null;
  const dir = i.side === 'LONG' ? 1 : -1;
  const excursion = (i.peak - i.entryPrice) * dir;
  const pullback = (i.peak - i.ltp) * dir;
  return { fire: excursion >= i.armN * i.n && pullback >= i.givebackN * i.n, excursion, pullback };
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd apps/api && npx jest src/modules/exit-discipline --ci --maxWorkers=2`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/exit-discipline/noise.ts apps/api/src/modules/exit-discipline/noise.spec.ts apps/api/src/modules/exit-discipline/floor.ts apps/api/src/modules/exit-discipline/floor.spec.ts apps/api/src/modules/exit-discipline/giveback.ts apps/api/src/modules/exit-discipline/giveback.spec.ts
git commit -m "feat(exit-discipline): noise unit (ATR14 of 1m bars), noise-aware floor and giveback

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Breakeven + measuring `N` on the tick (Stream B)

**Files:**
- Modify: `apps/api/src/modules/trade-sentinel/charges.ts`, `charges.spec.ts`
- Create: `apps/api/src/modules/trade-sentinel/adapters/minute-bars.reader.ts`, `minute-bars.reader.spec.ts`
- Modify: `apps/api/src/modules/trade-sentinel/services/context-packet.service.ts` (TickSnapshot type only, this task)
- Modify: `apps/api/src/modules/trade-sentinel/adapters/tick-source.adapter.ts`, `tick-source.adapter.spec.ts`
- Modify: `apps/api/src/modules/trade-sentinel/trade-sentinel.module.ts`, `trade-sentinel.module.spec.ts`

**Interfaces:**
- Consumes: Task 8 `noiseFromBars`; Task 1 `NOISE_LOOKBACK_MIN`, `EXIT_DISCIPLINE_CONFIG`, `parseExitDisciplineConfig`, `MinuteBar`, `NoiseReading`; `PrismaCandleRepo` (`market-hub/candles/candle-repository.ts`, `read('1m', ref, from, to)`).
- Produces: `breakevenPrice(i: { segment: Segment; entryPrice: number; qty: number; side: Side }): number | null` (the existing floor solve with margin 0; `null` for qty 0); `MinuteBarsReader.recent(ref: { exchange: string; token: string; symbol: string }, now: Date): Promise<MinuteBar[]>` (never throws ⇒ `[]`; 20 s cache per ref; window `max(now − 120 min, IST midnight)` → `now`); `TickSnapshot.noise?: { contract: NoiseReading | null; underlying1m: NoiseReading | null; reason: string | null } | null`; `TickSnapshot.noiseFloor?: NoiseFloor | null` (set by the cycle only, Task 10).

- [ ] **Step 1: Write the failing tests**

`charges.spec.ts` add:

```ts
describe('breakevenPrice', () => {
  it('is the green floor solved with a zero margin (LONG above entry, SHORT below)', () => {
    const long = breakevenPrice({ segment: 'OPT', entryPrice: 521.9, qty: 100, side: 'LONG' })!;
    const floor = computeGreenFloor({ segment: 'OPT', entryPrice: 521.9, ltp: 521.9, qty: 100, side: 'LONG' }).floorPrice!;
    expect(long).toBeGreaterThan(521.9);
    expect(floor - long).toBeCloseTo(GREEN_FLOOR_MARGIN_RUPEES / 100, 1);
    expect(breakevenPrice({ segment: 'OPT', entryPrice: 100, qty: 50, side: 'SHORT' })!).toBeLessThan(100);
  });
  it('qty 0 ⇒ null', () => {
    expect(breakevenPrice({ segment: 'OPT', entryPrice: 100, qty: 0, side: 'LONG' })).toBeNull();
  });
  it('computeGreenFloor is unchanged (same outputs as before the refactor)', () => {
    expect(computeGreenFloor({ segment: 'OPT', entryPrice: 100, ltp: 103, qty: 100, side: 'LONG' })).toMatchSnapshot();
  });
});
```

(Run the last test ONCE on the unmodified `charges.ts` to record the snapshot, commit nothing yet, then refactor — the snapshot proves the refactor changed nothing.)

`minute-bars.reader.spec.ts`:

```ts
import { MinuteBarsReader } from './minute-bars.reader';

describe('MinuteBarsReader', () => {
  const REF = { exchange: 'MCX', token: '582930', symbol: 'CRUDEOIL17NOV269000CE' };
  const NOW = new Date('2026-10-14T11:01:20Z'); // 16:31:20 IST
  it('reads candles_1m for the last 120 minutes of the IST day and caches 20 s', async () => {
    const read = jest.fn(async () => [{ ts: 1, open: 1, high: 2, low: 1, close: 2, volume: 0 }]);
    const r = new MinuteBarsReader({ read } as never);
    await expect(r.recent(REF, NOW)).resolves.toEqual([{ ts: 1, open: 1, high: 2, low: 1, close: 2 }]);
    expect(read).toHaveBeenCalledWith('1m', REF, NOW.getTime() - 120 * 60_000, NOW.getTime());
    await r.recent(REF, new Date(NOW.getTime() + 19_000));
    expect(read).toHaveBeenCalledTimes(1);
    await r.recent(REF, new Date(NOW.getTime() + 21_000));
    expect(read).toHaveBeenCalledTimes(2);
  });
  it('never reaches before IST midnight', async () => {
    const read = jest.fn(async () => []);
    const early = new Date('2026-10-13T19:00:00Z'); // 00:30 IST
    await new MinuteBarsReader({ read } as never).recent(REF, early);
    expect(read).toHaveBeenCalledWith('1m', REF, Date.parse('2026-10-13T18:30:00Z'), early.getTime());
  });
  it('a DB error is an empty read, never a throw', async () => {
    const r = new MinuteBarsReader({ read: jest.fn(async () => { throw new Error('db'); }) } as never);
    await expect(r.recent(REF, NOW)).resolves.toEqual([]);
  });
});
```

`tick-source.adapter.spec.ts` — add a case in the existing derivative-tick describe (use its existing harness/fakes; give the adapter a `MinuteBarsReader` fake and an enabled `ExitDisciplineConfig`): the tick for an MCX option carries `noise.contract` from the contract's bars (`exchange/token` of the tracker row) and `noise.underlying1m` from the resolved underlying's bars; with discipline disabled `tick.noise` is `null` and the reader is NOT called; with no reader wired `tick.noise` is `null`.

Module spec: `EXIT_DISCIPLINE_CONFIG` and `MinuteBarsReader` are providers of `TradeSentinelModule`.

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && npx jest src/modules/trade-sentinel/charges.spec.ts src/modules/trade-sentinel/adapters --ci --maxWorkers=2`
Expected: FAIL — `breakevenPrice` / `MinuteBarsReader` missing.

- [ ] **Step 3: Implement**

`charges.ts`: extract the solve loop of `computeGreenFloor` into

```ts
function solveFloorPrice({ segment, entryPrice, qty, side }: Omit<GreenFloorInput, 'ltp'>, marginRupees: number, charges: number): number {
  const dir = side === 'LONG' ? 1 : -1;
  let floorPrice = entryPrice + ((charges + marginRupees) / qty) * dir;
  for (let i = 0; i < FLOOR_MAX_ITERATIONS; i += 1) {
    const chargesAtFloor = estimateCharges({ segment, entryPrice, exitPrice: floorPrice, qty, side });
    const next = entryPrice + ((chargesAtFloor + marginRupees) / qty) * dir;
    const converged = Math.abs(next - floorPrice) < FLOOR_TOLERANCE_RUPEES;
    floorPrice = next;
    if (converged) break;
  }
  return roundToTickConservative(floorPrice, dir);
}
```

use it in `computeGreenFloor` (`const rounded = solveFloorPrice({segment, entryPrice, qty, side}, GREEN_FLOOR_MARGIN_RUPEES, charges);`), and add:

```ts
/** Exit discipline §4: breakeven after charges — the green-floor solve with no margin. */
export function breakevenPrice(i: { segment: Segment; entryPrice: number; qty: number; side: Side }): number | null {
  if (i.qty === 0 || !Number.isFinite(i.entryPrice)) return null;
  const charges = estimateCharges({ segment: i.segment, entryPrice: i.entryPrice, exitPrice: i.entryPrice, qty: i.qty, side: i.side });
  const p = solveFloorPrice(i, 0, charges);
  return p > 0 ? p : null;
}
```

`minute-bars.reader.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { NOISE_LOOKBACK_MIN } from '../../exit-discipline/config';
import type { MinuteBar } from '../../exit-discipline/types';
import type { CandleRepo } from '../../market-hub/candles/candle-repository';

type Ref = { exchange: string; token: string; symbol: string };
const CACHE_MS = 20_000;
const IST_OFFSET_MS = 5.5 * 3_600_000;
const istMidnightUtc = (now: Date) => {
  const ist = now.getTime() + IST_OFFSET_MS;
  return ist - (ist % 86_400_000) - IST_OFFSET_MS;
};

/**
 * Exit discipline §3: the hub's tick-built 1-minute bars, read from candles_1m.
 * A DATABASE read only — never a broker call (no getCandles, no fill).
 */
@Injectable()
export class MinuteBarsReader {
  private readonly cache = new Map<string, { at: number; bars: MinuteBar[] }>();
  constructor(private readonly repo: Pick<CandleRepo, 'read'>) {}

  async recent(ref: Ref, now: Date): Promise<MinuteBar[]> {
    const key = `${ref.exchange}:${ref.token}`;
    const hit = this.cache.get(key);
    if (hit && now.getTime() - hit.at < CACHE_MS) return hit.bars;
    const from = Math.max(now.getTime() - NOISE_LOOKBACK_MIN * 60_000, istMidnightUtc(now));
    let bars: MinuteBar[] = [];
    try {
      bars = (await this.repo.read('1m', ref, from, now.getTime())).map((c) => ({ ts: c.ts, open: c.open, high: c.high, low: c.low, close: c.close }));
    } catch {
      bars = [];
    }
    this.cache.set(key, { at: now.getTime(), bars });
    if (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value as string);
    return bars;
  }
}
```

Module provider: `{ provide: MinuteBarsReader, useFactory: (prisma: PrismaService) => new MinuteBarsReader(new PrismaCandleRepo(prisma as never)), inject: [PrismaService] }` and `{ provide: EXIT_DISCIPLINE_CONFIG, useFactory: () => parseExitDisciplineConfig(process.env) }`.

`context-packet.service.ts` — in `TickSnapshot` add (doc comments required, matching the file's style):

```ts
  /**
   * Exit discipline §3: the contract's and the underlying's 1-minute noise unit,
   * from the hub's tick bars (DB only). Null/absent ⇒ discipline off or nothing
   * read; the packet then states `flow.noiseUnit` absent with this reason.
   */
  noise?: { contract: NoiseReading | null; underlying1m: NoiseReading | null; reason: string | null } | null;
  /** Exit discipline §4: set by the CYCLE only (like the latch); a tick source never sets it. */
  noiseFloor?: NoiseFloor | null;
```

`tick-source.adapter.ts`: inject `@Optional() private readonly minuteBars?: MinuteBarsReader` and `@Optional() @Inject(EXIT_DISCIPLINE_CONFIG) private readonly discipline?: ExitDisciplineConfig`. At the end of the live tick build (where the returned object is assembled, ~line 400–440), when `this.discipline?.enabled && this.minuteBars` and NOT `opts.closedSession`:

```ts
    const now = new Date();
    const [cBars, uBars] = await Promise.all([
      this.minuteBars.recent({ exchange: row.exchange, token: row.token, symbol: row.symbol }, now),
      !isCash && underlying.token && underlying.exchange
        ? this.minuteBars.recent({ exchange: underlying.exchange, token: underlying.token, symbol: underlying.name ?? underlying.token }, now)
        : Promise.resolve([]),
    ]);
    const contract = noiseFromBars(cBars);
    const underlying1m = isCash ? contract : noiseFromBars(uBars);
    noise = { contract, underlying1m,
      reason: contract ? null : 'no hub 1-minute bars for this contract in the last 120 minutes (needs MARKET_HUB_ENABLED + HUB_CANDLES_ENABLED and a live feed slot)' };
```

(Use the real local names for the resolved underlying in that function — `underlying` is resolved at ~line 344; for cash the contract IS the underlying.) Otherwise `noise = null`.

- [ ] **Step 4: Run to verify they pass**

Run: `cd apps/api && npx jest src/modules/trade-sentinel --ci --maxWorkers=2`
Expected: PASS (including the unchanged cycle reachability walk — the reader is reached only through the tick-source adapter, not from the cycle).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/trade-sentinel/charges.ts apps/api/src/modules/trade-sentinel/charges.spec.ts apps/api/src/modules/trade-sentinel/__snapshots__ apps/api/src/modules/trade-sentinel/adapters/minute-bars.reader.ts apps/api/src/modules/trade-sentinel/adapters/minute-bars.reader.spec.ts apps/api/src/modules/trade-sentinel/services/context-packet.service.ts apps/api/src/modules/trade-sentinel/adapters/tick-source.adapter.ts apps/api/src/modules/trade-sentinel/adapters/tick-source.adapter.spec.ts apps/api/src/modules/trade-sentinel/trade-sentinel.module.ts apps/api/src/modules/trade-sentinel/trade-sentinel.module.spec.ts
git commit -m "feat(trade-sentinel): breakeven-after-charges and the 1-minute noise unit on the tick (DB read only)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

(If the snapshot landed elsewhere, `git status` shows its path — add exactly that path.)

---

## Task 10: Packet — `flow.noiseUnit`, `money.floorBasis`, noise floor latch (Stream B)

**Files:**
- Create: `apps/api/src/modules/trade-sentinel/services/cycle-floor.ts`, `cycle-floor.spec.ts`
- Modify: `apps/api/src/modules/trade-sentinel/services/context-packet.service.ts`, `context-packet.service.spec.ts`
- Modify: `apps/api/src/modules/trade-sentinel/services/sentinel-cycle.service.ts`, `sentinel-cycle.service.spec.ts`
- Modify: `apps/api/src/modules/trade-sentinel/golden/golden-fixtures.ts` (packet literals only — snapshot regenerated in Task 12)

**Interfaces:**
- Consumes: Task 8 `noiseAwareFloor`, `scaledUnderlyingNoise`; Task 9 `breakevenPrice`, `TickSnapshot.noise/noiseFloor`.
- Produces: `ContextPacket.money.floorBasis: FloorBasis`; `ContextPacket.flow.noiseUnit: Block<Prisma.InputJsonValue>` whose value is a `NoiseUnitValue`; `storedNoiseFloor(last: { packet?: unknown } | undefined | null, entryPrice: number): { armed: boolean; level: number | null }`; `solveCycleFloor(i: { cfg: ExitDisciplineConfig; segment: Segment; side: Side; entryPrice: number; qty: number; holdingHigh: number | null; holdingLow: number | null; nContract: number | null; memory: { armed: boolean; level: number | null; entry: number | null }; last: { packet?: unknown } | undefined }): { noiseFloor: NoiseFloor | null; memory: { armed: boolean; level: number | null; entry: number | null } }`.

- [ ] **Step 1: Write the failing tests**

`cycle-floor.spec.ts`:

```ts
import { parseExitDisciplineConfig } from '../../exit-discipline/config';
import { solveCycleFloor, storedNoiseFloor } from './cycle-floor';

const CFG = parseExitDisciplineConfig({});
const BASE = { cfg: CFG, segment: 'OPT' as const, side: 'LONG' as const, entryPrice: 521.9, qty: 100,
  holdingHigh: 539.5, holdingLow: 518, nContract: 4.5, memory: { armed: false, level: null, entry: null }, last: undefined };

describe('storedNoiseFloor (durable half of the latch)', () => {
  it('reads an armed noise floor from the last live packet with the same entry', () => {
    const last = { packet: { position: { entryPrice: 521.9 }, money: { floorBasis: 'noise', greenFloorArmed: true, greenFloorPrice: 531 } } };
    expect(storedNoiseFloor(last, 521.9)).toEqual({ armed: true, level: 531 });
  });
  it.each([
    ['a fixed-basis packet', { position: { entryPrice: 521.9 }, money: { floorBasis: 'fixed', greenFloorArmed: true, greenFloorPrice: 524.85 } }],
    ['another entry price', { position: { entryPrice: 500 }, money: { floorBasis: 'noise', greenFloorArmed: true, greenFloorPrice: 531 } }],
    ['garbage', 'x'],
  ])('%s is no evidence', (_l, packet) => expect(storedNoiseFloor({ packet }, 521.9)).toEqual({ armed: false, level: null }));
});

describe('solveCycleFloor', () => {
  it('discipline off or N unknown ⇒ no noise floor (the fixed floor stays in charge), memory cleared', () => {
    expect(solveCycleFloor({ ...BASE, cfg: parseExitDisciplineConfig({ EXIT_DISCIPLINE_ENABLED: 'false' }) }).noiseFloor).toBeNull();
    expect(solveCycleFloor({ ...BASE, nContract: null })).toEqual({ noiseFloor: null, memory: { armed: false, level: null, entry: null } });
  });
  it('arms off the peak and trails it; memory keeps the armed level', () => {
    const r = solveCycleFloor(BASE);
    expect(r.noiseFloor).toMatchObject({ basis: 'noise', armed: true });
    expect(r.noiseFloor!.level).toBeCloseTo(539.5 - 9, 2);
    expect(r.memory).toEqual({ armed: true, level: r.noiseFloor!.level, entry: 521.9 });
  });
  it('tighten-only across ticks: a larger N later never lowers the level', () => {
    const first = solveCycleFloor(BASE);
    const later = solveCycleFloor({ ...BASE, nContract: 6, memory: first.memory });
    expect(later.noiseFloor!.level).toBe(first.noiseFloor!.level);
  });
  it('restart: the stored packet re-arms the latch', () => {
    const last = { packet: { position: { entryPrice: 521.9 }, money: { floorBasis: 'noise', greenFloorArmed: true, greenFloorPrice: 533 } } };
    expect(solveCycleFloor({ ...BASE, holdingHigh: 530, last }).noiseFloor).toMatchObject({ armed: true, level: 533 });
  });
  it('a changed entry price voids the memory', () => {
    const r = solveCycleFloor({ ...BASE, holdingHigh: 527, memory: { armed: true, level: 531, entry: 500 } });
    expect(r.noiseFloor).toMatchObject({ armed: false });
  });
  it('SHORT reads holdingLow as the peak', () => {
    const r = solveCycleFloor({ ...BASE, side: 'SHORT', entryPrice: 100, holdingHigh: 103, holdingLow: 94, nContract: 2 });
    expect(r.noiseFloor).toMatchObject({ armed: true });
    expect(r.noiseFloor!.level).toBeLessThan(100);
  });
});
```

`context-packet.service.spec.ts` add (use the file's existing `build` harness/tick fixture):

```ts
describe('exit discipline fields', () => {
  it('no tick.noise ⇒ flow.noiseUnit absent with a reason, floorBasis fixed, money as before', async () => {
    const p = await build(tickFixture());
    expect(p.flow.noiseUnit).toEqual({ available: false, reason: expect.stringMatching(/noise/) });
    expect(p.money.floorBasis).toBe('fixed');
  });
  it('tick.noise ⇒ present NoiseUnitValue; the underlying falls back to the level book atr14/√15', async () => {
    const contract = { n: 4.5, method: 'atr14-1m', bars: 20, at: '2026-10-14T11:00:00.000Z' };
    const p = await build(tickFixture({ noise: { contract, underlying1m: null, reason: null } }), { levelBook: { atr14: 13.5, vwap: 9000 } });
    expect(p.flow.noiseUnit).toMatchObject({ available: true, value: { contract, underlying: { method: 'atr14-15m-scaled' } } });
  });
  it('tick.noiseFloor ⇒ the packet floor IS the noise floor', async () => {
    const p = await build(tickFixture({ noiseFloor: { basis: 'noise', armed: true, level: 530.5, armPrice: 529.65, n: 4.5 } }));
    expect(p.money).toMatchObject({ greenFloorPrice: 530.5, greenFloorArmed: true, floorBasis: 'noise' });
  });
});
```

(Adapt `build`/`tickFixture` to the helpers the spec already has; the level-book shim fake must return a value carrying `atr14`.)

`sentinel-cycle.service.spec.ts`: one integration case — a tick with `noise.contract` and a peak beyond the arm threshold produces a packet with `money.floorBasis === 'noise'` and the heartbeat context receives `greenFloorArmed: true`; with `EXIT_DISCIPLINE_CONFIG` absent from the cycle (constructor optional param omitted) the packet is identical to today's (`floorBasis: 'fixed'`).

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && npx jest src/modules/trade-sentinel/services/cycle-floor.spec.ts src/modules/trade-sentinel/services/context-packet.service.spec.ts src/modules/trade-sentinel/services/sentinel-cycle.service.spec.ts --ci --maxWorkers=2`
Expected: FAIL.

- [ ] **Step 3: Implement**

`cycle-floor.ts`:

```ts
import type { ExitDisciplineConfig } from '../../exit-discipline/config';
import { noiseAwareFloor } from '../../exit-discipline/floor';
import type { NoiseFloor } from '../../exit-discipline/types';
import { breakevenPrice, type Segment, type Side } from '../charges';

type Memory = { armed: boolean; level: number | null; entry: number | null };
const EMPTY: Memory = { armed: false, level: null, entry: null };

export function storedNoiseFloor(last: { packet?: unknown } | undefined | null, entryPrice: number): { armed: boolean; level: number | null } {
  const p = last?.packet as { position?: { entryPrice?: unknown }; money?: { floorBasis?: unknown; greenFloorArmed?: unknown; greenFloorPrice?: unknown } } | undefined;
  if (!p || typeof p !== 'object' || p.money?.floorBasis !== 'noise' || p.position?.entryPrice !== entryPrice) return { armed: false, level: null };
  const level = typeof p.money.greenFloorPrice === 'number' && Number.isFinite(p.money.greenFloorPrice) ? p.money.greenFloorPrice : null;
  return p.money.greenFloorArmed === true ? { armed: true, level } : { armed: false, level: null };
}

/** The cycle's noise-floor ratchet (spec §4, plan R4): in-process memory + the last live packet. */
export function solveCycleFloor(i: {
  cfg: ExitDisciplineConfig; segment: Segment; side: Side; entryPrice: number; qty: number;
  holdingHigh: number | null; holdingLow: number | null; nContract: number | null;
  memory: Memory; last: { packet?: unknown } | undefined;
}): { noiseFloor: NoiseFloor | null; memory: Memory } {
  if (!i.cfg.enabled || i.nContract === null || !(i.nContract > 0)) return { noiseFloor: null, memory: EMPTY };
  const breakeven = breakevenPrice({ segment: i.segment, entryPrice: i.entryPrice, qty: i.qty, side: i.side });
  if (breakeven === null) return { noiseFloor: null, memory: EMPTY };
  const mem = i.memory.entry === i.entryPrice ? i.memory : EMPTY;
  const stored = storedNoiseFloor(i.last, i.entryPrice);
  const prevLevel = mem.level ?? stored.level;
  const nf = noiseAwareFloor({
    side: i.side, breakeven, peak: i.side === 'LONG' ? i.holdingHigh : i.holdingLow, n: i.nContract,
    armN: i.cfg.floorArmN, trailN: i.cfg.floorTrailN, prevArmedLevel: prevLevel, latchedArmed: mem.armed || stored.armed,
  });
  return { noiseFloor: nf, memory: nf.armed ? { armed: true, level: nf.level, entry: i.entryPrice } : { ...EMPTY, entry: i.entryPrice } };
}
```

`context-packet.service.ts`:
- `ContextPacket.money` gains `floorBasis: FloorBasis;` (doc: "'noise' — trails the peak by FLOOR_TRAIL_N noise units; 'fixed' — breakeven + ₹150"). `ContextPacket.flow` gains `noiseUnit: Block<Prisma.InputJsonValue>;`.
- In `build`, money:

```ts
        greenFloorPrice: tick.noiseFloor ? tick.noiseFloor.level : clampFloorTowardLtp(floor.floorPrice, tick.ltp, tick.side),
        greenFloorArmed: tick.noiseFloor ? tick.noiseFloor.armed : tick.greenFloorArmedLatched || floor.armed,
        floorBasis: tick.noiseFloor ? 'noise' : 'fixed',
```

  (keep the existing comments; place `floorBasis` after `greenFloorArmed`).
- flow: `noiseUnit: noiseUnitBlock(tick, levelBook, at),` with

```ts
/** Exit discipline §3: `flow.noiseUnit`. Present when either noise reading exists; absent WITH the reason otherwise. */
function noiseUnitBlock(tick: TickSnapshot, levelBook: Block<Prisma.InputJsonValue>, at: string): Block<Prisma.InputJsonValue> {
  if (!tick.noise) return absent('no noise unit measured — exit discipline is off, or the tick source read no 1-minute bars');
  const book = levelBook.available ? (levelBook.value as { atr14?: unknown }) : null;
  const scaled = levelBook.available ? scaledUnderlyingNoise(typeof book?.atr14 === 'number' ? book.atr14 : null, levelBook.at) : null;
  const value: NoiseUnitValue = { contract: tick.noise.contract, underlying: tick.noise.underlying1m ?? scaled };
  if (!value.contract && !value.underlying) {
    return absent(tick.noise.reason ?? 'no 1-minute bars for the contract and no 15m ATR on the level book');
  }
  const stamps = [value.contract?.at, value.underlying?.at].filter((s): s is string => !!s).sort();
  return present(value as unknown as Prisma.InputJsonValue,
    'exit-discipline noise unit (ATR14 of hub 1-minute bars; underlying falls back to the 15m level-book ATR14 / √15)',
    stamps[stamps.length - 1] ?? at);
}
```

`sentinel-cycle.service.ts`:
- Constructor: add `@Optional() @Inject(EXIT_DISCIPLINE_CONFIG) private readonly discipline?: ExitDisciplineConfig` (last parameter).
- `TrackerState` gains `noiseFloor: { armed: boolean; level: number | null; entry: number | null }` (initialise to `{ armed: false, level: null, entry: null }` where state is created).
- In `evaluateOne`, after `const greenFloorArmedLatched = this.armedLatch(entry, tick, last);`:

```ts
    const floorSolve = solveCycleFloor({
      cfg: this.discipline ?? DISCIPLINE_OFF, segment: tick.segment, side: tick.side, entryPrice: tick.entryPrice, qty: tick.qty,
      holdingHigh: tick.holdingHigh, holdingLow: tick.holdingLow, nContract: tick.noise?.contract?.n ?? null,
      memory: this.stateFor(entry).noiseFloor, last,
    });
    this.stateFor(entry).noiseFloor = floorSolve.memory;
    const tickF: TickReading = { ...tick, noiseFloor: floorSolve.noiseFloor };
    const armedForCadence = floorSolve.noiseFloor ? floorSolve.noiseFloor.armed : greenFloorArmedLatched;
```

  with module-level `const DISCIPLINE_OFF = parseExitDisciplineConfig({ EXIT_DISCIPLINE_ENABLED: 'false' });`. Use `armedForCadence` in the heartbeat context (`greenFloorArmed` and `current.greenFloorArmed`) and return `tick: tickF` in the candidate (so the packet receives `noiseFloor`).

`golden-fixtures.ts` — and every other `ContextPacket` literal `npx tsc --noEmit -p tsconfig.json` flags (at least `services/sentinel-agent.service.spec.ts` `base`; add those files to this task's commit): every `ContextPacket` literal gains `floorBasis: 'fixed'` in `money` and `noiseUnit: absent('no noise unit measured — exit discipline is off, or the tick source read no 1-minute bars')` in `flow` (TypeScript will list each literal). Do NOT regenerate the snapshot here.

- [ ] **Step 4: Run to verify they pass**

Run: `cd apps/api && npx jest src/modules/trade-sentinel --ci --maxWorkers=2 --testPathIgnorePatterns golden`
Expected: PASS. (The golden spec now FAILS on the packet change — expected; Task 12 regenerates and attributes it.)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/trade-sentinel/services/cycle-floor.ts apps/api/src/modules/trade-sentinel/services/cycle-floor.spec.ts apps/api/src/modules/trade-sentinel/services/context-packet.service.ts apps/api/src/modules/trade-sentinel/services/context-packet.service.spec.ts apps/api/src/modules/trade-sentinel/services/sentinel-cycle.service.ts apps/api/src/modules/trade-sentinel/services/sentinel-cycle.service.spec.ts apps/api/src/modules/trade-sentinel/golden/golden-fixtures.ts
git commit -m "feat(trade-sentinel): noise-aware green floor and flow.noiseUnit in the packet

Golden snapshot intentionally stale until the prompt v7 commit (Task 12).

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: Noise-scaled giveback + exit-confirm wake (Stream B)

**Files:**
- Modify: `apps/api/src/modules/trade-sentinel/tripwires/types.ts`
- Modify: `apps/api/src/modules/trade-sentinel/tripwires/giveback-off-peak.tripwire.ts`, `giveback-off-peak.tripwire.spec.ts`
- Create: `apps/api/src/modules/trade-sentinel/tripwires/exit-confirm.ts`, `exit-confirm.spec.ts`
- Modify: `apps/api/src/modules/trade-sentinel/services/sentinel-cycle.service.ts`, `sentinel-cycle.service.spec.ts`

**Interfaces:**
- Consumes: Task 8 `noiseGiveback`; Task 1 `EXIT_CONFIRM_MAX_RELOOKS`.
- Produces: `TripwireInput.noise?: { n: number; armN: number; givebackN: number } | null`; `exitConfirmFire(i: { recent: Array<{ verdict: string; createdAt: Date }>; now: Date; relookMs: number; maxRelooks: number }): TripwireFire | null`; `withExitConfirm(decision: TripwireResult, fire: TripwireFire | null): TripwireResult`.

- [ ] **Step 1: Write the failing tests**

`giveback-off-peak.tripwire.spec.ts` add:

```ts
describe('noise-scaled (exit discipline §5)', () => {
  const base = { ...input(), side: 'LONG' as const, entryPrice: 521.9, holdingHigh: 534.6 };
  it('a 9.0 pullback after a 12.7 excursion fires when N = 4.5', () => {
    expect(givebackOffPeak.check({ ...base, ltp: 525.6, noise: { n: 4.5, armN: 1.5, givebackN: 1.5 } })).toMatchObject({
      name: 'giveback-off-peak', detail: expect.stringMatching(/2\.0 N/),
    });
  });
  it('a 6.6 pullback is chop with N = 4.5 — but the 40 % rule (no noise) still fires on it', () => {
    expect(givebackOffPeak.check({ ...base, ltp: 528, noise: { n: 4.5, armN: 1.5, givebackN: 1.5 } })).toBeNull();
    expect(givebackOffPeak.check({ ...base, ltp: 528 })).not.toBeNull();
  });
  it('noise: null keeps the 40 % rule', () => {
    expect(givebackOffPeak.check({ ...base, ltp: 528, noise: null })).not.toBeNull();
  });
});
```

(`input()` = the spec's existing input builder; use its real name.)

`exit-confirm.spec.ts`:

```ts
import { exitConfirmFire, withExitConfirm } from './exit-confirm';

const NOW = new Date('2026-10-14T11:03:00Z');
const v = (verdict: string, secAgo: number) => ({ verdict, createdAt: new Date(NOW.getTime() - secAgo * 1000) });
const run = (recent: ReturnType<typeof v>[]) => exitConfirmFire({ recent, now: NOW, relookMs: 120_000, maxRelooks: 3 });

describe('exitConfirmFire', () => {
  it('latest EXIT_NOW, >= relook ago ⇒ fires with the count', () => {
    expect(run([v('EXIT_NOW', 130), v('HOLD', 600)])).toEqual({
      name: 'exit-confirm', detail: expect.stringMatching(/EXIT_NOW.*1 in a row.*judge it again/),
    });
  });
  it('too soon ⇒ null', () => expect(run([v('EXIT_NOW', 60)])).toBeNull());
  it('latest is not EXIT_NOW ⇒ null', () => expect(run([v('EXIT_ARMED', 300), v('EXIT_NOW', 400)])).toBeNull());
  it('stops after 3 consecutive EXIT_NOWs (cost cap)', () => {
    expect(run([v('EXIT_NOW', 130), v('EXIT_NOW', 260), v('EXIT_NOW', 390)])).not.toBeNull();
    expect(run([v('EXIT_NOW', 130), v('EXIT_NOW', 260), v('EXIT_NOW', 390), v('EXIT_NOW', 520)])).toBeNull();
  });
  it('no history ⇒ null', () => expect(run([])).toBeNull());
});

describe('withExitConfirm', () => {
  const quiet = { fires: [], heartbeat: false, shouldEvaluate: false, trigger: null } as never;
  it('adds the fire and wakes the agent as a FIRE', () => {
    expect(withExitConfirm(quiet, { name: 'exit-confirm', detail: 'd' })).toEqual({
      fires: [{ name: 'exit-confirm', detail: 'd' }], heartbeat: false, shouldEvaluate: true, trigger: 'FIRE',
    });
  });
  it('null fire ⇒ unchanged object', () => expect(withExitConfirm(quiet, null)).toBe(quiet));
});
```

`sentinel-cycle.service.spec.ts`: (a) with discipline enabled and a tick carrying `noise.contract`, `tripwires.evaluate` receives `noise: { n, armN: 1.5, givebackN: 1.5 }`; (b) when the latest live verdict is `EXIT_NOW` from 130 s ago and nothing else fires, the position is judged with an `exit-confirm` fire in the packet's `trigger` block; (c) with discipline off neither happens. Use the spec's existing fake repository for `recentForTracker` (it must now be asked for `EXIT_CONFIRM_MAX_RELOOKS + 1` rows with `{ liveOnly: true }`).

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && npx jest src/modules/trade-sentinel/tripwires src/modules/trade-sentinel/services/sentinel-cycle.service.spec.ts --ci --maxWorkers=2`
Expected: FAIL.

- [ ] **Step 3: Implement**

`tripwires/types.ts` — in `TripwireInput`:

```ts
  /**
   * Exit discipline §5: the contract's noise unit and multipliers. Present ⇒ the
   * giveback sensor uses the noise rule; absent/null ⇒ the 40 % rule.
   */
  noise?: { n: number; armN: number; givebackN: number } | null;
```

`giveback-off-peak.tripwire.ts` — at the top of `check`, after the finiteness guards:

```ts
    if (input.noise) {
      const g = noiseGiveback({ side, entryPrice, ltp, peak, n: input.noise.n, armN: input.noise.armN, givebackN: input.noise.givebackN });
      if (!g || !g.fire) return null;
      const n = input.noise.n;
      return {
        name: 'giveback-off-peak',
        detail: `gave back ${g.pullback.toFixed(1)} (${(g.pullback / n).toFixed(1)} N) from peak ${peak} after a ` +
          `${g.excursion.toFixed(1)} (${(g.excursion / n).toFixed(1)} N) excursion; now ${ltp}, entry ${entryPrice}, N=${n.toFixed(2)}`,
      };
    }
```

`exit-confirm.ts`:

```ts
import type { TripwireResult } from '../services/tripwire.service';
import type { TripwireFire } from './types';

const IST = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/**
 * Exit discipline §7 needs a SECOND verdict to confirm an EXIT_NOW. While the
 * latest live verdict on an open position is EXIT_NOW, ask again after
 * `relookMs` — at most `maxRelooks` times in a row (cost cap).
 */
export function exitConfirmFire(i: { recent: Array<{ verdict: string; createdAt: Date }>; now: Date; relookMs: number; maxRelooks: number }): TripwireFire | null {
  let run = 0;
  for (const r of i.recent) { if (r.verdict !== 'EXIT_NOW') break; run += 1; }
  if (run === 0 || run > i.maxRelooks) return null;
  const last = i.recent[0];
  if (i.now.getTime() - last.createdAt.getTime() < i.relookMs) return null;
  return {
    name: 'exit-confirm',
    detail: `your last verdict was EXIT_NOW at ${IST.format(last.createdAt)} IST (${run} in a row since the last HOLD) and the ` +
      'position is still open — an exit executes only when a justification holds and a second EXIT_NOW confirms it; judge it again',
  };
}

export function withExitConfirm(d: TripwireResult, fire: TripwireFire | null): TripwireResult {
  if (!fire || d.fires.some((f) => f.name === fire.name)) return d;
  return { ...d, fires: [...d.fires, fire], heartbeat: false, shouldEvaluate: true, trigger: 'FIRE' };
}
```

(Check `TripwireResult` is exported from `tripwire.service.ts` and its `trigger` union contains `'FIRE'`; this file is reached from the cycle — keep it import-clean for the reachability walk.)

`sentinel-cycle.service.ts` in `evaluateOne`:
- Replace `const [last] = await this.verdicts.recentForTracker(entry.trackerId, 1, { liveOnly: true });` with
  `const recent = await this.verdicts.recentForTracker(entry.trackerId, this.discipline?.enabled ? EXIT_CONFIRM_MAX_RELOOKS + 1 : 1, { liveOnly: true }); const last = recent[0];`
- Add `noise: this.discipline?.enabled && tick.noise?.contract ? { n: tick.noise.contract.n, armN: this.discipline.floorArmN, givebackN: this.discipline.givebackN } : null,` to the `tripwires.evaluate` input.
- Wrap: `const confirm = this.discipline?.enabled ? exitConfirmFire({ recent, now, relookMs: this.discipline.persistMinSec * 1000, maxRelooks: EXIT_CONFIRM_MAX_RELOOKS }) : null;` and change `const decision = withCarriedFires(…)` to `const decision = withExitConfirm(withCarriedFires(…), confirm);`.
- Add `services/../tripwires/exit-confirm.ts` to the reachability walk's `ENTRIES` in `sentinel-cycle.service.spec.ts`.

- [ ] **Step 4: Run to verify they pass**

Run: `cd apps/api && npx jest src/modules/trade-sentinel --ci --maxWorkers=2 --testPathIgnorePatterns golden`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/trade-sentinel/tripwires/types.ts apps/api/src/modules/trade-sentinel/tripwires/giveback-off-peak.tripwire.ts apps/api/src/modules/trade-sentinel/tripwires/giveback-off-peak.tripwire.spec.ts apps/api/src/modules/trade-sentinel/tripwires/exit-confirm.ts apps/api/src/modules/trade-sentinel/tripwires/exit-confirm.spec.ts apps/api/src/modules/trade-sentinel/services/sentinel-cycle.service.ts apps/api/src/modules/trade-sentinel/services/sentinel-cycle.service.spec.ts
git commit -m "feat(trade-sentinel): noise-scaled giveback sensor and an exit-confirm re-look after EXIT_NOW

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: Prompt v7 / v2.4 + golden regeneration, attributed (Stream B)

**Files:**
- Modify: `apps/api/src/modules/trade-sentinel/prompts/sentinel-system-prompt.ts`
- Modify: `apps/api/src/modules/trade-sentinel/services/sentinel-agent.service.spec.ts`
- Modify: `apps/api/src/modules/trade-sentinel/golden/__snapshots__/sentinel-golden.spec.ts.snap` (regenerated)

**Interfaces:**
- Produces: `SENTINEL_PROMPT_VERSION = 'v7'`, `SENTINEL_PROMPT_VERSION_NO_CUES = 'v2.4'` (see Merge point M2 — `v6`/`v2.3` if this merges before price triggers); exported constants `PRE_V7_MANDATE_LINE`, `V7_MANDATE_LINES` (ends with `\n`), `PRE_V7_MONEY_FIELDS`, `PRE_V7_FLOW_FIELDS`, `PRE_V7_BLOCKS_LINE`, `V7_READING_LINES` (ends with `\n`).

- [ ] **Step 1: Pin the current text**

Throwaway (never committed) `apps/api/src/modules/trade-sentinel/prompts/pre-v7-hash.tmp.spec.ts`:

```ts
import { createHash } from 'crypto';
import { SENTINEL_SYSTEM_PROMPT } from './sentinel-system-prompt';
it('prints the pre-v7 hash', () => {
  console.log(createHash('sha256').update(SENTINEL_SYSTEM_PROMPT, 'utf8').digest('hex'), SENTINEL_SYSTEM_PROMPT.length);
});
```

Run: `cd apps/api && npx jest src/modules/trade-sentinel/prompts/pre-v7-hash.tmp.spec.ts` → note hex + length; delete the file.

- [ ] **Step 2: Write the failing tests** (in `sentinel-agent.service.spec.ts`)

- Change the expected stamps `'v2.2/t1'` → `'v2.4/t1'` and `'v5/t1'` → `'v7/t1'` (or the M2 numbering).
- In the existing v2 hash test, extend `restored` so it first undoes the v7 change (then the existing restores):

```ts
    const undoV7 = (p: string) => p
      .replace(V7_READING_LINES, '')
      .replace(V7_MANDATE_LINES, `${PRE_V7_MANDATE_LINE}\n`)
      .replace(/^- money: .*$/m, PRE_V7_MONEY_FIELDS)
      .replace(/^- flow: .*$/m, PRE_V7_FLOW_FIELDS)
      .replace(/^- Blocks are .*$/m, PRE_V7_BLOCKS_LINE);
    const restored = undoV7(SENTINEL_SYSTEM_PROMPT_NO_CUES).replace(line as string, OLD_MTC_LINE).replace(own as string, OLD_OWNERSHIP_LINE);
```

  (length 5562 and hash `084d0a14…` unchanged; if price triggers merged first, also strip its `EXIT_TRIGGER_RULES` and restore its `V5_OWNERSHIP_LINE` as its test does.)
- Add:

```ts
describe('prompt v7 / v2.4 (exit discipline)', () => {
  /** SENTINEL_SYSTEM_PROMPT before this change (<length> chars), recorded in Task 12 Step 1. */
  const PRE_V7_SHA256 = '<hex from Step 1>';

  it.each([['cues on', SENTINEL_SYSTEM_PROMPT], ['cues off', SENTINEL_SYSTEM_PROMPT_NO_CUES]])(
    '%s: carries the v7 mandate and reading lines exactly once, and the old mandate not at all', (_l, prompt) => {
      expect(prompt.split(V7_MANDATE_LINES)).toHaveLength(2);
      expect(prompt.split(V7_READING_LINES)).toHaveLength(2);
      expect(prompt).not.toContain(PRE_V7_MANDATE_LINE);
      expect(prompt).toMatch(/^- money: .*floorBasis/m);
      expect(prompt).toMatch(/^- flow: volumeRatio, oiWalls, noiseUnit\.$/m);
      expect(prompt).toMatch(/^- Blocks are .*flow\.noiseUnit/m);
    });

  it('v7 differs from its predecessor ONLY by those five edits', () => {
    const back = SENTINEL_SYSTEM_PROMPT
      .replace(V7_READING_LINES, '')
      .replace(V7_MANDATE_LINES, `${PRE_V7_MANDATE_LINE}\n`)
      .replace(/^- money: .*$/m, PRE_V7_MONEY_FIELDS)
      .replace(/^- flow: .*$/m, PRE_V7_FLOW_FIELDS)
      .replace(/^- Blocks are .*$/m, PRE_V7_BLOCKS_LINE);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createHash } = require('crypto') as typeof import('crypto');
    expect(createHash('sha256').update(back, 'utf8').digest('hex')).toBe(PRE_V7_SHA256);
  });

  it('a verdict citing flow.noiseUnit and money.floorBasis validates; an invented child of money is still rejected', async () => {
    const create = jest.fn();
    const agent = new SentinelAgentService({ messages: { create } } as never);
    const p = packet({
      money: { ...base.money, floorBasis: 'noise' },
      flow: { ...base.flow, noiseUnit: present({ contract: { n: 4.5, method: 'atr14-1m', bars: 20, at: AT }, underlying: null }, 'exit-discipline noise unit', AT) },
    });
    create.mockResolvedValue(reply({ ...validVerdict, evidence: ['flow.noiseUnit', 'money.floorBasis'] }));
    await expect(agent.judge(p)).resolves.toMatchObject({ evidence: ['flow.noiseUnit', 'money.floorBasis'] });
    create.mockResolvedValue(reply({ ...validVerdict, evidence: ['money.noiseFloor'] }));
    await expect(agent.judge(p)).rejects.toThrow(/money\.noiseFloor/);
  });

  it('the stamps moved', () => {
    expect(SENTINEL_PROMPT_VERSION).toBe('v7');
    expect(SENTINEL_PROMPT_VERSION_NO_CUES).toBe('v2.4');
  });
});
```

  (`base`, `packet()`, `present`, `AT`, `validVerdict` and `reply` are this spec's existing fixtures. Task 10 already added `floorBasis: 'fixed'` and `noiseUnit: absent(…)` to `base` — the `ContextPacket` type requires them.)

Run: `cd apps/api && npx jest src/modules/trade-sentinel/services/sentinel-agent.service.spec.ts --ci --maxWorkers=2`
Expected: FAIL — constants not exported; stamps old.

- [ ] **Step 3: Implement the prompt change**

In `sentinel-system-prompt.ts`:

1. Version doc + bump:

```ts
 * v7 (from v6): exit discipline. The mandate protects MEANINGFUL profit, measured
 * in noise units (flow.noiseUnit), and says a code gate executes EXIT_NOW only on
 * a broken thesis, hard risk or confirmed weakness. The packet gained
 * flow.noiseUnit and money.floorBasis; the field lists name them. No other line moves.
 */
export const SENTINEL_PROMPT_VERSION = 'v7';
```

and `SENTINEL_PROMPT_VERSION_NO_CUES = 'v2.4'` (doc: "…and the v2.4 exit-discipline lines, shared with v7").

2. Above `SENTINEL_SYSTEM_PROMPT`:

```ts
/** The pre-v7 lines, kept so tests can prove v7 changed nothing else. */
export const PRE_V7_MANDATE_LINE = '- When the trade is in profit beyond charges, protect that profit. Say EXIT when the read has turned against it.';
export const PRE_V7_MONEY_FIELDS = '- money: grossPnl, charges, netPnl, greenFloorPrice, greenFloorArmed, mfe, mae.';
export const PRE_V7_FLOW_FIELDS = '- flow: volumeRatio, oiWalls.';
export const PRE_V7_BLOCKS_LINE =
  '- Blocks are position.underlyingLtp, thesis, structure.levelBook, structure.nearestSupport, structure.nearestResistance, flow.volumeRatio, flow.oiWalls, macro.fiiDii, macro.sector, macro.globalCues, macro.realFactors, news.headlines, news.freshCount, session.minutesToClose, trigger and memory. Everything else listed above is a plain value.';

/** v7 mandate: replaces PRE_V7_MANDATE_LINE. Ends with a newline. */
export const V7_MANDATE_LINES = [
  '- When the trade is in profit beyond charges, protect MEANINGFUL profit — measured in noise units (flow.noiseUnit), not in rupees. A pullback smaller than the instrument\'s normal swing while the underlying thesis holds is noise: do not call EXIT_NOW on it. EXIT_NOW is for a broken thesis, hard risk, or weakness confirmed on the underlying.',
  '- A code gate checks every EXIT_NOW before it is executed. It executes only when the underlying is beyond the thesis invalidation or beyond the support/resistance the trade was held against at your last HOLD, when hard risk applies (the per-trade max loss, the last minutes of an intraday session or of expiry day, the daily loss limit), or when the price is below an armed money.greenFloorPrice (above it for a short) AND the underlying confirms it — it has moved against the position by at least one of its own noise units since your last HOLD, or it is on the wrong side of the level book\'s VWAP. Name in "reason" which of these holds. An EXIT_NOW none of them supports is recorded and not executed, and a single EXIT_NOW may wait for a second one to confirm it.',
].join('\n') + '\n';

/** v7 reading lines, inserted after the money.greenFloorPrice line. Ends with a newline. */
export const V7_READING_LINES = [
  '- money.floorBasis says how money.greenFloorPrice was set. "noise": it arms only once the best price has moved well clear of breakeven after charges, then trails that best price by a multiple of flow.noiseUnit — it never sits inside one ordinary swing of the price. "fixed": breakeven after charges plus ₹150, used when the noise unit is unknown.',
  '- flow.noiseUnit is the instrument\'s normal one-minute swing. value.contract is on the contract\'s own scale (the premium, for an option — compare it with position.ltp and the money prices); value.underlying is on the underlying\'s scale (compare it with position.underlyingLtp and the structure levels). Each carries n (one unit), method and bars, and either may be null when it could not be measured — then say you cannot size the swing rather than guessing it.',
].join('\n') + '\n';
```

3. In the template literal: replace the mandate line with `${V7_MANDATE_LINES}` (no extra newline — the constant ends with one; make sure the following "When the trade is not in profit" line still starts on its own line); change the money and flow field lines to `- money: grossPnl, charges, netPnl, greenFloorPrice, greenFloorArmed, floorBasis, mfe, mae.` and `- flow: volumeRatio, oiWalls, noiseUnit.`; insert `flow.noiseUnit, ` after `flow.oiWalls, ` in the Blocks line; insert `${V7_READING_LINES}` immediately after the line beginning `- money.greenFloorPrice is a PRICE` (before `- money.mfe and money.mae are PRICES`). `V3_MACRO_LINES` and the `_NO_CUES` derivation are untouched (all edits lie outside the macro slice).

- [ ] **Step 4: Run the prompt tests**

Run: `cd apps/api && npx jest src/modules/trade-sentinel/services/sentinel-agent.service.spec.ts --ci --maxWorkers=2`
Expected: PASS.

- [ ] **Step 5: Regenerate the golden snapshot**

Run: `cd apps/api && npx jest src/modules/trade-sentinel/golden -u --ci --maxWorkers=2` → `N snapshots updated`, PASS; then again WITHOUT `-u` → PASS, 0 updated.

- [ ] **Step 6: Attribute every changed word**

Save to the scratchpad (never committed) as `golden-attrib-v7.js`:

```js
const { execSync } = require('child_process');
const snap = 'apps/api/src/modules/trade-sentinel/golden/__snapshots__/sentinel-golden.spec.ts.snap';
const git = (args) => execSync(`git ${args} -- ${snap}`, { encoding: 'utf8', maxBuffer: 1 << 26 });
const RULES = [
  ['VERSION stamp', /^(v7|v6|v5|v2\.4|v2\.3|v2\.2)(\/t\d+)?[",\\n]*$/],
  ['PACKET money.floorBasis', /floorBasis|"fixed"|^fixed[",]*$/],
  ['PACKET flow.noiseUnit', /noiseUnit|noise unit|exit discipline is off|tick source read no|1-minute bars|"available"|false,?|"reason"/],
  ['PROMPT mandate', /MEANINGFUL|noise units?|pullback|swing|thesis|EXIT_NOW|hard risk|weakness|gate|executed|executes|invalidation|support\/resistance|HOLD|max loss|intraday|expiry|daily loss|greenFloorPrice|short|underlying|VWAP|confirm|reason|recorded|wait/i],
  ['PROMPT reading lines', /floorBasis|"noise"|"fixed"|arms|trails|breakeven|charges|₹150|value\.contract|value\.underlying|premium|option|position\.ltp|money prices|structure levels|method|bars|null|measured|size the swing/i],
  ['PROMPT field lists', /^(mfe|mae|greenFloorArmed|oiWalls|noiseUnit|flow\.noiseUnit|flow\.oiWalls)[,.]*$/],
];
const counts = {}; const bad = [];
for (const line of git('diff --word-diff=porcelain').split('\n')) {
  if (!/^[+-]/.test(line) || /^(\+\+\+|---)/.test(line)) continue;
  const word = line.slice(1).trim();
  if (word === '') continue;
  const hit = RULES.find(([, re]) => re.test(word));
  if (hit) counts[hit[0]] = (counts[hit[0]] || 0) + 1; else bad.push(line.slice(0, 200));
}
console.log(counts); console.log(`UNATTRIBUTED: ${bad.length}`); for (const b of bad) console.log('  ' + b);
const changed = git('diff -U0').split('\n').filter((l) => /^[+-](?![+-])/.test(l));
console.log(`result/logs lines touched: ${changed.filter((l) => /"(result|logs)"|"verdict": "|"message":/.test(l)).length}`);
```

Run (repo root): `node <scratchpad>/golden-attrib-v7.js`
Expected: `UNATTRIBUTED: 0`, `result/logs lines touched: 0`. The word rules are deliberately broad; therefore ALSO read `git diff -- <snap>` hunk by hunk and confirm each hunk is one of: (a) the mandate lines; (b) the two reading lines; (c) the three field-list lines; (d) a request packet's `money.floorBasis: "fixed"` and `flow.noiseUnit` absent block; (e) a version stamp. Any other hunk = stop and investigate. Paste the counts into the commit message.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/trade-sentinel/prompts/sentinel-system-prompt.ts apps/api/src/modules/trade-sentinel/services/sentinel-agent.service.spec.ts apps/api/src/modules/trade-sentinel/golden/__snapshots__/sentinel-golden.spec.ts.snap
git commit -m "feat(trade-sentinel): prompt v7 / v2.4 — protect meaningful profit, state the gate's justification

Mandate: profit measured in noise units; EXIT_NOW only for a broken thesis, hard
risk or weakness confirmed on the underlying; a code gate enforces it. Field
lists name flow.noiseUnit and money.floorBasis; two reading lines describe them.
SENTINEL_PROMPT_VERSION -> v7, SENTINEL_PROMPT_VERSION_NO_CUES -> v2.4.

Golden snapshot regenerated; every changed word attributed (golden-attrib-v7.js):
<paste counts>, UNATTRIBUTED 0, result/logs lines touched 0.
- request packets: money.floorBasis \"fixed\", flow.noiseUnit absent block
- mandate lines, reading lines, field lists
- version stamps

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Task 13: E5 — fill capture and the PLACED→FILLED fix (Stream C, after Task 2)

**Files:**
- Create: `apps/api/src/modules/sentinel-executor/domain/exit-fill.ts`, `exit-fill.spec.ts`
- Modify: `apps/api/src/modules/sentinel-executor/services/sentinel-exit-executor.service.ts`, `.spec.ts`
- Create: `apps/api/src/modules/sentinel-executor/services/exit-fill-settler.service.ts`, `.spec.ts`
- Modify: `apps/api/src/modules/sentinel-executor/repositories/ai-exit-execution.repository.ts`, `.spec.ts` (`AiExitPatch` columns if Task 7 has not landed in this branch yet — identical definition; `placedAwaitingFill`)
- Modify: `apps/api/src/modules/sentinel-executor/services/sentinel-exit-poller.service.ts`, `.spec.ts`; `sentinel-executor.module.ts`, `.spec.ts`

**Interfaces:**
- Produces: `parseAngelIstTimestamp(raw: unknown): Date | null` (accepts `dd-MMM-yyyy HH:mm:ss` and `yyyy-MM-dd HH:mm:ss`, IST); `interface OrderFill { status: string; text: string; averagePrice: number | null; filledQty: number | null; fillAt: Date | null }`; `findOrderFill(rows: unknown[], orderId: string): OrderFill | null`; repository `placedAwaitingFill(since: Date, limit = 20): Promise<Array<Pick<AiExitExecution, 'id' | 'userId' | 'verdictId' | 'symbol' | 'brokerOrderId' | 'createdAt'>>>` (status PLACED, mode live, createdAt ≥ since, brokerOrderId not null); `ExitFillSettler.runOnce(now = new Date()): Promise<void>` (single-flight; per row at most every 30 s; never logs in).

- [ ] **Step 1: Write the failing tests**

`exit-fill.spec.ts`:

```ts
import { findOrderFill, parseAngelIstTimestamp } from './exit-fill';

describe('parseAngelIstTimestamp', () => {
  it.each([
    ['14-Oct-2026 16:31:05', '2026-10-14T11:01:05.000Z'],
    ['14-OCT-2026 16:31:05', '2026-10-14T11:01:05.000Z'],
    ['2026-10-14 16:31:05', '2026-10-14T11:01:05.000Z'],
  ])('%s → %s', (raw, iso) => expect(parseAngelIstTimestamp(raw)!.toISOString()).toBe(iso));
  it.each(['', null, undefined, 'garbage', '32-Oct-2026 16:31:05', '14-Xyz-2026 16:31:05', 12])('%s → null', (raw) =>
    expect(parseAngelIstTimestamp(raw)).toBeNull());
});

describe('findOrderFill', () => {
  const row = { orderid: 'O1', status: 'complete', text: '', averageprice: '527.10', filledshares: '100',
    exchorderupdatetime: '14-Oct-2026 16:31:05', exchtime: '14-Oct-2026 16:31:04', updatetime: '14-Oct-2026 16:31:06' };
  it('reads price, qty and the EXCHANGE update time first', () => {
    expect(findOrderFill([row], 'O1')).toEqual({ status: 'complete', text: '', averagePrice: 527.1, filledQty: 100, fillAt: new Date('2026-10-14T11:01:05Z') });
  });
  it('falls back exchtime → updatetime; zero/blank price ⇒ null', () => {
    expect(findOrderFill([{ ...row, exchorderupdatetime: '' }], 'O1')!.fillAt).toEqual(new Date('2026-10-14T11:01:04Z'));
    expect(findOrderFill([{ ...row, exchorderupdatetime: '', exchtime: '' }], 'O1')!.fillAt).toEqual(new Date('2026-10-14T11:01:06Z'));
    expect(findOrderFill([{ ...row, averageprice: '0' }], 'O1')!.averagePrice).toBeNull();
  });
  it('unknown order ⇒ null', () => expect(findOrderFill([row], 'O2')).toBeNull());
});
```

Executor spec — add:

```ts
describe('SentinelExitExecutor — fill capture (E5)', () => {
  const COMPLETE = env([{ orderid: 'O1', status: 'complete', averageprice: '50.10', filledshares: '100', exchorderupdatetime: '12-Oct-2026 15:30:04' }]);
  it('a complete order is FILLED even while the positions read still lags (the PLACED-forever bug)', async () => {
    const h = harness({ books: [env([]), COMPLETE], positions: [env([posRow('100')]), env([posRow('100')])] });
    await expect(h.ex.process(V, LIVE, NOW)).resolves.toEqual({ status: 'FILLED' });
    expect(h.lastPatch()).toEqual(expect.objectContaining({
      status: 'FILLED', orderStatus: 'complete', fillPrice: 50.1, fillQty: 100, fillAt: new Date('2026-10-12T10:00:04Z'),
    }));
  });
  it('records orderLtp with the plan and orderSentAt with PLACED', async () => {
    const h = harness({ books: [env([]), COMPLETE] });
    await h.ex.process(V, LIVE, NOW);
    expect(h.patches()).toEqual(expect.arrayContaining([
      expect.objectContaining({ quantity: 100, orderLtp: 50.25 }),
      expect.objectContaining({ status: 'PLACED', orderSentAt: expect.any(Date) }),
    ]));
  });
  it('still open after 10 s ⇒ left PLACED (the settle sweep finishes it)', async () => {
    const h = harness({ books: [env([]), env([{ orderid: 'O1', status: 'open' }])], positions: [env([posRow('100')]), env([posRow('100')])] });
    await expect(h.ex.process(V, LIVE, NOW)).resolves.toEqual({ status: 'PLACED' });
  });
});
```

`exit-fill-settler.service.spec.ts`:

```ts
import { ExitFillSettler } from './exit-fill-settler.service';

const NOW = new Date('2026-10-14T11:05:00Z');
function make(book: unknown, rows = [{ id: 'r1', userId: 'owner', verdictId: 'v1', symbol: 'X', brokerOrderId: 'O1', createdAt: new Date('2026-10-14T11:01:00Z') }]) {
  const repo = { placedAwaitingFill: jest.fn(async () => rows), update: jest.fn(async () => undefined) };
  const session = { getOrderBookEnvelope: jest.fn(async () => book) };
  const sessions = { withOwnerSession: jest.fn(async (_u: string, fn: any, opts: any) => { expect(opts).toEqual({ allowEphemeralLogin: false }); return fn(session, 'user-feed'); }) };
  return { s: new ExitFillSettler(repo as never, sessions as never), repo, sessions };
}

describe('ExitFillSettler', () => {
  it('complete ⇒ FILLED with the fill', async () => {
    const { s, repo } = make({ status: true, data: [{ orderid: 'O1', status: 'complete', averageprice: '527.1', filledshares: '100', exchorderupdatetime: '14-Oct-2026 16:31:05' }] });
    await s.runOnce(NOW);
    expect(repo.update).toHaveBeenCalledWith('r1', expect.objectContaining({ status: 'FILLED', fillPrice: 527.1, fillQty: 100, orderStatus: 'complete' }));
  });
  it('rejected / cancelled ⇒ REJECTED', async () => {
    const { s, repo } = make({ status: true, data: [{ orderid: 'O1', status: 'rejected', text: 'RMS' }] });
    await s.runOnce(NOW);
    expect(repo.update).toHaveBeenCalledWith('r1', expect.objectContaining({ status: 'REJECTED', reason: 'BROKER_REJECTED', orderStatus: 'rejected' }));
  });
  it('open / unanswered book / no session ⇒ untouched', async () => {
    for (const book of [{ status: true, data: [{ orderid: 'O1', status: 'open' }] }, {}, { status: false }]) {
      const { s, repo } = make(book);
      await s.runOnce(NOW);
      expect(repo.update).not.toHaveBeenCalled();
    }
    const { s, repo, sessions } = make({});
    sessions.withOwnerSession.mockRejectedValueOnce(new Error('NO_FEED_SESSION'));
    await expect(s.runOnce(NOW)).resolves.toBeUndefined();
    expect(repo.update).not.toHaveBeenCalled();
  });
  it('checks a row at most every 30 s and is single-flight', async () => {
    const { s, sessions } = make({ status: true, data: [{ orderid: 'O1', status: 'open' }] });
    await Promise.all([s.runOnce(NOW), s.runOnce(NOW)]);
    await s.runOnce(new Date(NOW.getTime() + 10_000));
    expect(sessions.withOwnerSession).toHaveBeenCalledTimes(1);
    await s.runOnce(new Date(NOW.getTime() + 31_000));
    expect(sessions.withOwnerSession).toHaveBeenCalledTimes(2);
  });
});
```

Repository spec: `placedAwaitingFill` queries `{ status: 'PLACED', mode: 'live', createdAt: { gte: since }, brokerOrderId: { not: null } }` ordered by `createdAt asc`, `take: limit`.

Poller spec: when enabled, `onModuleInit` starts a 30 s `setInterval` for the settler (spy `setInterval`, assert a 30_000 interval and that `onModuleDestroy` clears it); disabled ⇒ not started.

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && npx jest src/modules/sentinel-executor --ci --maxWorkers=2`
Expected: FAIL.

- [ ] **Step 3: Implement**

`exit-fill.ts`:

```ts
const MONTHS: Record<string, number> = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
const IST_OFFSET_MS = 5.5 * 3_600_000;

/** Angel order-book time (IST wall clock) → instant. Null for anything unparseable. */
export function parseAngelIstTimestamp(raw: unknown): Date | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  let y: number, mo: number, d: number, h: number, mi: number, se: number;
  let m = /^(\d{2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2})$/.exec(s);
  if (m) {
    const mon = MONTHS[m[2].toUpperCase()];
    if (mon === undefined) return null;
    [d, mo, y, h, mi, se] = [Number(m[1]), mon, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])];
  } else {
    m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(s);
    if (!m) return null;
    [y, mo, d, h, mi, se] = [Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])];
  }
  const utc = Date.UTC(y, mo, d, h, mi, se) - IST_OFFSET_MS;
  const back = new Date(utc + IST_OFFSET_MS);
  if (back.getUTCDate() !== d || back.getUTCMonth() !== mo || h > 23 || mi > 59 || se > 59) return null;
  return new Date(utc);
}

export interface OrderFill { status: string; text: string; averagePrice: number | null; filledQty: number | null; fillAt: Date | null }

type Row = Record<string, unknown>;
const pos = (x: unknown) => { const n = Number(x); return Number.isFinite(n) && n > 0 ? n : null; };

export function findOrderFill(rows: unknown[], orderId: string): OrderFill | null {
  const r = (rows as Row[]).find((o) => String(o?.orderid ?? '') === orderId);
  if (!r) return null;
  return {
    status: String(r.status ?? r.orderstatus ?? '').toLowerCase(),
    text: String(r.text ?? ''),
    averagePrice: pos(r.averageprice),
    filledQty: pos(r.filledshares),
    fillAt: parseAngelIstTimestamp(r.exchorderupdatetime) ?? parseAngelIstTimestamp(r.exchtime) ?? parseAngelIstTimestamp(r.updatetime),
  };
}
```

Executor:
- `Run` gains `sentAt: Date | null` (init `null`); `place()` sets `run.sentAt = new Date()` immediately before `placeOrderClassified`.
- Both `status: 'PLACED'` updates add `orderSentAt: run.sentAt ?? undefined`. `settleUnplaced`'s `finish(...)` calls pass `orderSentAt: run.sentAt ?? undefined` in `extra`. Extend `finish`'s `extra` type to `Pick<AiExitPatch, 'brokerMessage' | 'orderStatus' | 'marketOrderId' | 'orderSentAt' | 'fillPrice' | 'fillQty' | 'fillAt' | 'gate'>`.
- `confirm()`: keep `last: OrderFill | null`, reading `findOrderFill(book, orderId) ?? last`. After the loop and the rejected/cancelled branches:

```ts
    if (last?.status === 'complete') {
      const rows = await this.rows(() => s.getPositionsEnvelope());
      const lagging = !(rows && isFlat(rows, o.exchange, o.token));
      if (lagging) this.logger.log(`[exit-fill] ${o.symbol} order ${orderId} complete; positions not flat yet (broker lag) — FILLED from the order book`);
      return this.finish(id, v, 'FILLED', undefined, {
        orderStatus: 'complete', fillPrice: last.averagePrice, fillQty: last.filledQty, fillAt: last.fillAt ?? new Date(),
      });
    }
```

  then the existing flat-positions → FILLED (also with `fillPrice/fillQty/fillAt` from `last` when present) and the PLACED fallthrough.

`exit-fill-settler.service.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { answeredPositions } from '../../trade-tracker/services/trade-tracker.service';
import { findOrderFill } from '../domain/exit-fill';
import { istDayStartUtc } from '../domain/exit-order';
import { AiExitExecutionRepository } from '../repositories/ai-exit-execution.repository';
import { OwnerBrokerSessionProvider } from './owner-broker-session.provider';

const RECHECK_MS = 30_000;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** E5: PLACED rows (order resting past the 10 s confirm) settled from the ORDER BOOK. Reads only; never logs in. */
@Injectable()
export class ExitFillSettler {
  private readonly logger = new Logger(ExitFillSettler.name);
  private readonly checkedAt = new Map<string, number>();
  private running = false;

  constructor(private readonly repo: AiExitExecutionRepository, private readonly sessions: OwnerBrokerSessionProvider) {}

  async runOnce(now: Date = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const rows = await this.repo.placedAwaitingFill(istDayStartUtc(now));
      for (const r of rows) {
        if (now.getTime() - (this.checkedAt.get(r.id) ?? 0) < RECHECK_MS) continue;
        this.checkedAt.set(r.id, now.getTime());
        try {
          await this.sessions.withOwnerSession(r.userId, async (s) => {
            const book = answeredPositions(await s.getOrderBookEnvelope());
            const f = book ? findOrderFill(book, String(r.brokerOrderId)) : null;
            if (!f) return;
            if (f.status === 'complete') {
              await this.repo.update(r.id, { status: 'FILLED', orderStatus: 'complete', fillPrice: f.averagePrice, fillQty: f.filledQty, fillAt: f.fillAt ?? now });
              this.logger.log(`[exit-fill] ${r.symbol} order ${r.brokerOrderId} FILLED @ ${f.averagePrice ?? '?'} (settled late) — verdict ${r.verdictId}`);
            } else if (f.status === 'rejected' || f.status === 'cancelled') {
              await this.repo.update(r.id, { status: 'REJECTED', reason: f.status === 'cancelled' ? 'CANCELLED' : 'BROKER_REJECTED', orderStatus: f.status, brokerMessage: f.text || null });
              this.logger.warn(`[exit-fill] ${r.symbol} order ${r.brokerOrderId} ${f.status} after PLACED — verdict ${r.verdictId}`);
            }
          }, { allowEphemeralLogin: false });
        } catch (err) {
          this.logger.debug?.(`[exit-fill] ${r.symbol}: ${errText(err)}`);
        }
      }
      for (const [id, at] of this.checkedAt) if (now.getTime() - at > 86_400_000) this.checkedAt.delete(id);
    } catch (err) {
      this.logger.warn(`[exit-fill] sweep failed: ${errText(err)}`);
    } finally {
      this.running = false;
    }
  }
}
```

(Verify `withOwnerSession`'s third parameter name/shape in `owner-broker-session.provider.ts` and match it.)

Poller: inject `ExitFillSettler`; in `onModuleInit` after the exit timer: `this.settleTimer = setInterval(() => void this.settler.runOnce(), 30_000); this.settleTimer.unref?.();`; clear in `onModuleDestroy`. Module: provide `ExitFillSettler`.

- [ ] **Step 4: Run to verify they pass**

Run: `cd apps/api && npx jest src/modules/sentinel-executor --ci --maxWorkers=2`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/sentinel-executor/domain/exit-fill.ts apps/api/src/modules/sentinel-executor/domain/exit-fill.spec.ts apps/api/src/modules/sentinel-executor/services/sentinel-exit-executor.service.ts apps/api/src/modules/sentinel-executor/services/sentinel-exit-executor.service.spec.ts apps/api/src/modules/sentinel-executor/services/exit-fill-settler.service.ts apps/api/src/modules/sentinel-executor/services/exit-fill-settler.service.spec.ts apps/api/src/modules/sentinel-executor/repositories/ai-exit-execution.repository.ts apps/api/src/modules/sentinel-executor/repositories/ai-exit-execution.repository.spec.ts apps/api/src/modules/sentinel-executor/services/sentinel-exit-poller.service.ts apps/api/src/modules/sentinel-executor/services/sentinel-exit-poller.service.spec.ts apps/api/src/modules/sentinel-executor/sentinel-executor.module.ts apps/api/src/modules/sentinel-executor/sentinel-executor.module.spec.ts
git commit -m "fix(sentinel-executor): a complete exit order is FILLED with its fill; settle resting PLACED rows (E5)

confirm() no longer waits for the lagging positions read once the order book
says complete. Fill price/qty/exchange time, the order LTP and the send time are
recorded. A 30 s sweep settles PLACED rows from the order book (never logs in).

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Task 14: Outcome maths + scorecard (Stream C, pure)

**Files:**
- Create: `apps/api/src/modules/exit-discipline/outcome.ts`, `outcome.spec.ts`
- Create: `apps/api/src/modules/exit-discipline/scorecard.ts`, `scorecard.spec.ts`

**Interfaces:**
- Produces: `interface ExitOutcomeValues { barsUsed: number; maxAfter: number; minAfter: number; closeAt15: number | null; closeAt30: number | null; closeAt60: number | null; closeAtEnd: number; missedPnl: number; savedPnl: number; netAtEnd: number }`; `computeExitOutcome(i: { positionSide: PositionSide; qty: number; decisionPrice: number; decisionAt: Date; windowEnd: Date; bars: MinuteBar[] }): ExitOutcomeValues | null`; `isWindowCovered(bars: MinuteBar[], from: Date, to: Date): boolean` (≥ 1 bar starting at or after `to − 3 min` AND count ≥ 50 % of whole minutes in the window); `outcomeWindowEnd(decisionAt: Date, windowMin: number, closeAt: Date | null): Date` (= min(decisionAt + window, closeAt)).
- Produces: `interface ScoredDecision { kind: OutcomeKind; missedPnl: number; savedPnl: number; netAtEnd: number }`; `interface Scorecard { day: string; executed: { n: number; missed: number; saved: number }; dryRun: { n: number; missed: number; saved: number }; gate: { blocked: number; gated: number; awaiting: number; helped: number; cost: number; net: number } }`; `scorecard(day: string, rows: ScoredDecision[]): Scorecard`; `scorecardLine(s: Scorecard): string`.

Semantics (R10): LONG `missed = max(0, maxAfter − dp)·qty`, `saved = max(0, dp − minAfter)·qty`; SHORT mirrored; `netAtEnd = (closeAtEnd − dp)·qty·dir` (positive = holding would have been better). Bars used: start ≥ the decision's minute start + 60 s and start < `windowEnd`. `closeAtK` = close of the last used bar whose END ≤ `decisionAt + K min`, else null. Gate: `helped = Σ max(0, netAtEnd)` over GATED+AWAITING, `cost = Σ max(0, −netAtEnd)`.

- [ ] **Step 1: Write the failing tests**

`outcome.spec.ts`:

```ts
import { computeExitOutcome, isWindowCovered, outcomeWindowEnd } from './outcome';
import type { MinuteBar } from './types';

const D = new Date('2026-10-14T11:01:20Z'); // 16:31:20 IST
const M = Date.parse('2026-10-14T11:01:00Z');
const bar = (minAfter: number, low: number, high: number, close: number): MinuteBar => ({ ts: M + minAfter * 60_000, open: close, high, low, close });
const BARS = [
  bar(0, 520, 530, 527),       // the decision's own minute — ignored
  bar(1, 523, 529, 528), bar(10, 526, 533, 532), bar(14, 529, 535, 534),
  bar(29, 531, 538, 537), bar(45, 535, 542, 540), bar(59, 536, 541, 539),
];

describe('computeExitOutcome', () => {
  it('LONG: missed = best after − exit, saved = exit − worst after; closes at +15/+30/+60', () => {
    const r = computeExitOutcome({ positionSide: 'LONG', qty: 100, decisionPrice: 527.1, decisionAt: D, windowEnd: new Date(D.getTime() + 3_600_000), bars: BARS })!;
    expect(r).toMatchObject({ barsUsed: 6, maxAfter: 542, minAfter: 523, closeAt15: 534, closeAt30: 537, closeAt60: 539, closeAtEnd: 539 });
    expect(r.missedPnl).toBeCloseTo(1490, 6);
    expect(r.savedPnl).toBeCloseTo(410, 6);
    expect(r.netAtEnd).toBeCloseTo(1190, 6);
  });
  it('SHORT is mirrored', () => {
    const r = computeExitOutcome({ positionSide: 'SHORT', qty: 100, decisionPrice: 527.1, decisionAt: D, windowEnd: new Date(D.getTime() + 3_600_000), bars: BARS })!;
    expect(r.missedPnl).toBeCloseTo(410, 6);
    expect(r.savedPnl).toBeCloseTo(1490, 6);
    expect(r.netAtEnd).toBeCloseTo(-1190, 6);
  });
  it('window end at the exchange close cuts later bars', () => {
    const r = computeExitOutcome({ positionSide: 'LONG', qty: 100, decisionPrice: 527.1, decisionAt: D, windowEnd: new Date(M + 20 * 60_000), bars: BARS })!;
    expect(r).toMatchObject({ barsUsed: 3, maxAfter: 535, closeAt30: null, closeAt60: null, closeAtEnd: 534 });
  });
  it('no bar after the decision ⇒ null; never negative missed/saved', () => {
    expect(computeExitOutcome({ positionSide: 'LONG', qty: 100, decisionPrice: 527.1, decisionAt: D, windowEnd: new Date(D.getTime() + 3_600_000), bars: [BARS[0]] })).toBeNull();
    const up = computeExitOutcome({ positionSide: 'LONG', qty: 1, decisionPrice: 500, decisionAt: D, windowEnd: new Date(D.getTime() + 3_600_000), bars: BARS })!;
    expect(up.savedPnl).toBe(0);
  });
});

describe('isWindowCovered / outcomeWindowEnd', () => {
  it('needs a bar near the end and >= 50 % of minutes', () => {
    const full = Array.from({ length: 60 }, (_, i) => bar(i + 1, 1, 2, 1.5));
    expect(isWindowCovered(full, D, new Date(M + 61 * 60_000))).toBe(true);
    expect(isWindowCovered(full.slice(0, 40), D, new Date(M + 61 * 60_000))).toBe(false);
    expect(isWindowCovered(full.filter((_, i) => i % 3 === 0 || i > 55), D, new Date(M + 61 * 60_000))).toBe(false);
  });
  it('window end = min(decision + window, close)', () => {
    expect(outcomeWindowEnd(D, 60, null)).toEqual(new Date(D.getTime() + 3_600_000));
    expect(outcomeWindowEnd(D, 60, new Date(D.getTime() + 600_000))).toEqual(new Date(D.getTime() + 600_000));
  });
});
```

`scorecard.spec.ts`:

```ts
import { scorecard, scorecardLine } from './scorecard';

describe('scorecard', () => {
  const s = scorecard('2026-10-14', [
    { kind: 'EXECUTED', missedPnl: 1490, savedPnl: 410, netAtEnd: 1190 },
    { kind: 'GATED', missedPnl: 900, savedPnl: 300, netAtEnd: 600 },
    { kind: 'GATED', missedPnl: 100, savedPnl: 800, netAtEnd: -500 },
    { kind: 'AWAITING', missedPnl: 50, savedPnl: 20, netAtEnd: 30 },
    { kind: 'DRY_RUN', missedPnl: 10, savedPnl: 5, netAtEnd: 1 },
  ]);
  it('aggregates by kind; the gate is credited with net moves it held through', () => {
    expect(s).toEqual({
      day: '2026-10-14',
      executed: { n: 1, missed: 1490, saved: 410 },
      dryRun: { n: 1, missed: 10, saved: 5 },
      gate: { blocked: 3, gated: 2, awaiting: 1, helped: 630, cost: 500, net: 130 },
    });
  });
  it('one log line', () => {
    expect(scorecardLine(s)).toBe(
      '[exit-score] 2026-10-14 executed=1 missed=₹1490 saved=₹410 | gate blocked=3 (gated 2, awaiting 1) helped=₹630 cost=₹500 net=₹130 | dry-run=1',
    );
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && npx jest src/modules/exit-discipline/outcome.spec.ts src/modules/exit-discipline/scorecard.spec.ts --ci --maxWorkers=2`
Expected: FAIL.

- [ ] **Step 3: Implement**

`outcome.ts`:

```ts
import type { MinuteBar, PositionSide } from './types';

export interface ExitOutcomeValues {
  barsUsed: number; maxAfter: number; minAfter: number;
  closeAt15: number | null; closeAt30: number | null; closeAt60: number | null; closeAtEnd: number;
  missedPnl: number; savedPnl: number; netAtEnd: number;
}
const MIN = 60_000;

export function outcomeWindowEnd(decisionAt: Date, windowMin: number, closeAt: Date | null): Date {
  const end = decisionAt.getTime() + windowMin * MIN;
  return new Date(closeAt ? Math.min(end, closeAt.getTime()) : end);
}

function used(bars: MinuteBar[], decisionAt: Date, windowEnd: Date): MinuteBar[] {
  const first = Math.floor(decisionAt.getTime() / MIN) * MIN + MIN;
  return bars
    .filter((b) => [b.high, b.low, b.close].every(Number.isFinite) && b.ts >= first && b.ts < windowEnd.getTime())
    .sort((a, b) => a.ts - b.ts);
}

export function isWindowCovered(bars: MinuteBar[], from: Date, to: Date): boolean {
  const u = used(bars, from, to);
  const minutes = Math.max(1, Math.floor((to.getTime() - from.getTime()) / MIN));
  return u.length > 0 && u[u.length - 1].ts >= to.getTime() - 3 * MIN && u.length >= 0.5 * minutes;
}

export function computeExitOutcome(i: {
  positionSide: PositionSide; qty: number; decisionPrice: number; decisionAt: Date; windowEnd: Date; bars: MinuteBar[];
}): ExitOutcomeValues | null {
  const u = used(i.bars, i.decisionAt, i.windowEnd);
  if (u.length === 0 || !Number.isFinite(i.decisionPrice) || !Number.isFinite(i.qty)) return null;
  const maxAfter = Math.max(...u.map((b) => b.high));
  const minAfter = Math.min(...u.map((b) => b.low));
  const closeBy = (k: number) => {
    const limit = i.decisionAt.getTime() + k * MIN;
    if (limit > i.windowEnd.getTime()) return null; // the window (exchange close) ended first
    const hit = u.filter((b) => b.ts + MIN <= limit);
    return hit.length ? hit[hit.length - 1].close : null;
  };
  const closeAtEnd = u[u.length - 1].close;
  const dp = i.decisionPrice;
  const long = i.positionSide === 'LONG';
  const missed = Math.max(0, long ? maxAfter - dp : dp - minAfter) * i.qty;
  const saved = Math.max(0, long ? dp - minAfter : maxAfter - dp) * i.qty;
  return {
    barsUsed: u.length, maxAfter, minAfter,
    closeAt15: closeBy(15), closeAt30: closeBy(30), closeAt60: closeBy(60), closeAtEnd,
    missedPnl: missed, savedPnl: saved, netAtEnd: (closeAtEnd - dp) * i.qty * (long ? 1 : -1),
  };
}
```

`scorecard.ts`:

```ts
import type { OutcomeKind } from './types';

export interface ScoredDecision { kind: OutcomeKind; missedPnl: number; savedPnl: number; netAtEnd: number }
export interface Scorecard {
  day: string;
  executed: { n: number; missed: number; saved: number };
  dryRun: { n: number; missed: number; saved: number };
  gate: { blocked: number; gated: number; awaiting: number; helped: number; cost: number; net: number };
}
const rnd = (x: number) => Math.round(x);

export function scorecard(day: string, rows: ScoredDecision[]): Scorecard {
  const sum = (k: OutcomeKind) => {
    const r = rows.filter((x) => x.kind === k);
    return { n: r.length, missed: rnd(r.reduce((s, x) => s + x.missedPnl, 0)), saved: rnd(r.reduce((s, x) => s + x.savedPnl, 0)) };
  };
  const blocked = rows.filter((x) => x.kind === 'GATED' || x.kind === 'AWAITING');
  const helped = rnd(blocked.reduce((s, x) => s + Math.max(0, x.netAtEnd), 0));
  const cost = rnd(blocked.reduce((s, x) => s + Math.max(0, -x.netAtEnd), 0));
  return {
    day, executed: sum('EXECUTED'), dryRun: sum('DRY_RUN'),
    gate: { blocked: blocked.length, gated: rows.filter((x) => x.kind === 'GATED').length,
      awaiting: rows.filter((x) => x.kind === 'AWAITING').length, helped, cost, net: helped - cost },
  };
}

export function scorecardLine(s: Scorecard): string {
  return `[exit-score] ${s.day} executed=${s.executed.n} missed=₹${s.executed.missed} saved=₹${s.executed.saved} | ` +
    `gate blocked=${s.gate.blocked} (gated ${s.gate.gated}, awaiting ${s.gate.awaiting}) helped=₹${s.gate.helped} cost=₹${s.gate.cost} net=₹${s.gate.net} | ` +
    `dry-run=${s.dryRun.n}`;
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd apps/api && npx jest src/modules/exit-discipline --ci --maxWorkers=2`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/exit-discipline/outcome.ts apps/api/src/modules/exit-discipline/outcome.spec.ts apps/api/src/modules/exit-discipline/scorecard.ts apps/api/src/modules/exit-discipline/scorecard.spec.ts
git commit -m "feat(exit-discipline): post-exit outcome maths (missed/saved, long/short) and the daily scorecard

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Task 15: Outcome job — scoring, E5 backfill, corpus, scorecard log (Stream C)

**Files:**
- Create: `apps/api/src/modules/sentinel-executor/repositories/ai-exit-outcome.repository.ts`, `.spec.ts`
- Create: `apps/api/src/modules/sentinel-executor/services/exit-outcome.service.ts`, `.spec.ts`
- Modify: `apps/api/src/modules/sentinel-executor/repositories/ai-exit-execution.repository.ts`, `.spec.ts` (`scoringCandidates`, `qualityBackfillCandidates`)
- Modify: `apps/api/src/modules/sentinel-executor/services/sentinel-exit-poller.service.ts`, `.spec.ts`; `sentinel-executor.module.ts`, `.spec.ts`

**Interfaces:**
- Consumes: Task 14 (`computeExitOutcome`, `isWindowCovered`, `outcomeWindowEnd`, `scorecard`, `scorecardLine`); Task 5 `readPacketFacts`; Task 4 `istDate`; `PrismaCandleRepo` (`read('1m', …)`); `HUB_CANDLE_SOURCE` / `HubCandleSource` (`market-hub/hub-candle-source.ts`, via `ModuleRef.get(…, { strict: false })`); `AI_EXIT_SESSION_CLOCK` (`tradingWindow(exchange, at)`); `EXIT_DISCIPLINE_CONFIG`.
- Produces: `AiExitOutcomeRepository` with `createPending(row)`, `due(now, limit)`, `markDone(id, values, dataSource)`, `markRetry(id, note)`, `markNoData(id, note)`, `corpusPending(limit)`, `markCorpus(id, at)`, `forDay(userId, day)`, `byExecutionIds(ids)`; `ExitOutcomeService.runOnce(now = new Date())` (single-flight; steps: (1) create PENDING rows for new candidates, (2) E5 backfill, (3) score due rows, (4) corpus writes, (5) scorecard line once per IST day).

Rules:
- Candidates (`scoringCandidates(now, since = now − 48 h, windowMin)`): `createdAt ≥ since`, `verdictId NOT LIKE 'man\_%'`, `exchange` and `token` not null, no outcome row, and (`status IN ('FILLED','DRY_RUN')` OR (`status = 'PLACED'` AND `createdAt < now − window`) OR (`status = 'SKIPPED'` AND `reason IN ('GATED_THESIS_INTACT','AWAITING_CONFIRMATION')`)). Kind per R10.
- decisionAt: AI (plain verdict id) → packet `session.nowUtc` else row `createdAt`; others → row `createdAt`. windowEnd = `outcomeWindowEnd(decisionAt, cfg.outcomeWindowMin, closeOf(exchange, decisionAt))` where `closeOf` uses `clock.tradingWindow(exchange, decisionAt)` (`closeMin` IST minutes → Date of that IST day).
- Due: `status = 'PENDING' AND windowEnd + 2 min ≤ now`. Bars: `candles_1m` for `[decisionAt, windowEnd)`; covered ⇒ compute, `dataSource 'candles_1m'`; not covered and the hub source `servesCharts()` ⇒ ONE `hub.candles({exchange, token, symbol}, '1m', from, to)` call ⇒ compute on whatever it returns if covered (`'hub-fill'`); else `attempts += 1`, `markRetry`. `windowEnd + 24 h < now` and still not computable ⇒ compute on partial bars if `computeExitOutcome` returns non-null (note `partial`), else `NO_DATA`.
- E5 backfill (`qualityBackfillCandidates`): rows with `fillPrice` not null and `slippage` null: AI → `decisionLtp = packet.position.ltp`, `decisionAt = packet.session.nowUtc`; otherwise `decisionLtp = orderLtp`, `decisionAt = createdAt`; `slippage = fillPrice − decisionLtp`; `latencyMs = fillAt − decisionAt`.
- Corpus: DONE outcomes whose verdictId is a plain AI id (not `man_`, not `trg_`) and `corpusAt` null, `decisionAt ≥ now − 7 d`: `UPDATE "ai_decision_records" SET "outcome" = COALESCE("outcome", '{}'::jsonb) || jsonb_build_object('exitOutcome', ${json}::jsonb), "outcomeAt" = ${now} WHERE "source" = 'sentinel' AND "decision"->>'verdictId' = ${verdictId}`; affected rows ≥ 1 ⇒ `markCorpus`; 0 ⇒ retry next pass (importer may not have run yet).
- Scorecard: on the first pass at or after 00:05 IST, for the previous IST day, for each allowed user: `forDay` DONE rows → `scorecard` → `this.logger.log(scorecardLine(…))` (in-memory guard, one line per user per day).

- [ ] **Step 1: Write the failing tests**

`exit-outcome.service.spec.ts` (fakes for both repositories, the candle repo, the hub source, the clock and `$executeRaw`):

```ts
import { parseExitDisciplineConfig } from '../../exit-discipline/config';
import { ExitOutcomeService } from './exit-outcome.service';

const NOW = new Date('2026-10-14T12:10:00Z');
const EXEC = { id: 'e1', userId: 'owner', verdictId: 'cm9verdict1', trackerId: 't1', symbol: 'CRUDEOIL17NOV269000CE', exchange: 'MCX', token: '582930',
  side: 'SELL', quantity: 100, status: 'FILLED', reason: null, createdAt: new Date('2026-10-14T11:01:10Z'), fillPrice: 527.1, orderLtp: 527.4, decisionLtp: null };
const PACKET = { position: { symbol: 'CRUDEOIL17NOV269000CE', side: 'LONG', qty: 100, entryPrice: 521.9, ltp: 527.6 }, money: {}, session: { nowUtc: '2026-10-14T11:00:30.000Z' } };

function make(o: { bars?: unknown[]; hubBars?: unknown[]; serves?: boolean; due?: unknown[]; corpusRows?: number } = {}) {
  const execRepo = { scoringCandidates: jest.fn(async () => [EXEC]), qualityBackfillCandidates: jest.fn(async () => []), update: jest.fn() };
  const outRepo = {
    createPending: jest.fn(async () => undefined), due: jest.fn(async () => o.due ?? []), markDone: jest.fn(), markRetry: jest.fn(), markNoData: jest.fn(),
    corpusPending: jest.fn(async () => []), markCorpus: jest.fn(), forDay: jest.fn(async () => []),
  };
  const prisma = { sentinelVerdict: { findUnique: jest.fn(async () => ({ packet: PACKET })) }, $executeRaw: jest.fn(async () => o.corpusRows ?? 1) };
  const candles = { read: jest.fn(async () => o.bars ?? []) };
  const hub = { servesCharts: () => o.serves ?? false, candles: jest.fn(async () => ({ candles: o.hubBars ?? [], incomplete: [] })) };
  const clock = { tradingWindow: jest.fn(() => ({ openMin: 540, closeMin: 1410 })) };
  const svc = new ExitOutcomeService(execRepo as never, outRepo as never, prisma as never, candles as never,
    { get: () => hub } as never, clock as never, parseExitDisciplineConfig({}), ['owner']);
  return { svc, execRepo, outRepo, prisma, candles, hub };
}

describe('ExitOutcomeService', () => {
  it('creates a PENDING EXECUTED outcome: decision price = fill, side from SELL, qty and decisionAt from the packet', async () => {
    const { svc, outRepo } = make();
    await svc.runOnce(NOW);
    expect(outRepo.createPending).toHaveBeenCalledWith(expect.objectContaining({
      executionId: 'e1', kind: 'EXECUTED', positionSide: 'LONG', qty: 100, decisionPrice: 527.1,
      decisionAt: new Date('2026-10-14T11:00:30.000Z'), windowEnd: new Date('2026-10-14T12:00:30.000Z'), status: 'PENDING',
    }));
  });
  it('a gated skip is scored at the order LTP', async () => {
    const { svc, execRepo, outRepo } = make();
    execRepo.scoringCandidates.mockResolvedValueOnce([{ ...EXEC, status: 'SKIPPED', reason: 'GATED_THESIS_INTACT', fillPrice: null }]);
    await svc.runOnce(NOW);
    expect(outRepo.createPending).toHaveBeenCalledWith(expect.objectContaining({ kind: 'GATED', decisionPrice: 527.4 }));
  });
  it('MANUAL rows are never scored (filtered by the query) and never reach the corpus', async () => {
    const { svc, execRepo } = make();
    await svc.runOnce(NOW);
    expect(execRepo.scoringCandidates).toHaveBeenCalledWith(expect.any(Date), expect.any(Date), expect.any(Number));
  });
  it('covered DB bars ⇒ DONE from candles_1m, no hub call', async () => {
    const bars = Array.from({ length: 60 }, (_, i) => ({ ts: Date.parse('2026-10-14T11:01:00Z') + i * 60_000, open: 530, high: 531, low: 529, close: 530, volume: 0 }));
    const due = [{ id: 'o1', executionId: 'e1', exchange: 'MCX', token: '582930', symbol: 'X', positionSide: 'LONG', qty: 100, decisionPrice: 527.1,
      decisionAt: new Date('2026-10-14T11:00:30Z'), windowEnd: new Date('2026-10-14T12:00:30Z'), attempts: 0 }];
    const { svc, outRepo, hub } = make({ bars, due, serves: true });
    await svc.runOnce(NOW);
    expect(outRepo.markDone).toHaveBeenCalledWith('o1', expect.objectContaining({ maxAfter: 531 }), 'candles_1m');
    expect(hub.candles).not.toHaveBeenCalled();
  });
  it('uncovered DB bars ⇒ one hub fill; still uncovered ⇒ retry, never NO_DATA within 24 h', async () => {
    const due = [{ id: 'o1', executionId: 'e1', exchange: 'MCX', token: '582930', symbol: 'X', positionSide: 'LONG', qty: 100, decisionPrice: 527.1,
      decisionAt: new Date('2026-10-14T11:00:30Z'), windowEnd: new Date('2026-10-14T12:00:30Z'), attempts: 0 }];
    const { svc, outRepo, hub } = make({ due, serves: true });
    await svc.runOnce(NOW);
    expect(hub.candles).toHaveBeenCalledTimes(1);
    expect(outRepo.markRetry).toHaveBeenCalledWith('o1', expect.any(String));
    expect(outRepo.markNoData).not.toHaveBeenCalled();
  });
  it('corpus write targets the sentinel record by decision->>verdictId; 0 rows ⇒ retried later', async () => {
    const { svc, outRepo, prisma } = make({ corpusRows: 0 });
    outRepo.corpusPending.mockResolvedValueOnce([{ id: 'o1', verdictId: 'cm9verdict1', kind: 'EXECUTED', missedPnl: 1490, savedPnl: 410, netAtEnd: 1190 }]);
    await svc.runOnce(NOW);
    const sql = (prisma.$executeRaw.mock.calls[0][0] as { strings: string[] }).strings.join('?');
    expect(sql).toMatch(/"decision"->>'verdictId'/);
    expect(outRepo.markCorpus).not.toHaveBeenCalled();
  });
  it('a trg_ or man_ outcome is never written to the corpus', async () => {
    const { svc, outRepo, prisma } = make();
    outRepo.corpusPending.mockResolvedValueOnce([{ id: 'o2', verdictId: 'trg_x' }, { id: 'o3', verdictId: 'man_t1_1' }]);
    await svc.runOnce(NOW);
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });
  it('E5 backfill: AI ⇒ packet ltp/time; slippage and latency computed', async () => {
    const { svc, execRepo } = make();
    execRepo.qualityBackfillCandidates.mockResolvedValueOnce([{ ...EXEC, fillAt: new Date('2026-10-14T11:01:15Z') }]);
    await svc.runOnce(NOW);
    expect(execRepo.update).toHaveBeenCalledWith('e1', {
      decisionLtp: 527.6, decisionAt: new Date('2026-10-14T11:00:30.000Z'), slippage: expect.closeTo(-0.5, 6), latencyMs: 45_000,
    });
  });
  it('one scorecard line per user per IST day after 00:05 IST', async () => {
    const { svc, outRepo } = make();
    const after = new Date('2026-10-14T18:36:00Z'); // 00:06 IST 15-Oct
    await svc.runOnce(after);
    await svc.runOnce(new Date(after.getTime() + 60_000));
    expect(outRepo.forDay).toHaveBeenCalledTimes(1);
    expect(outRepo.forDay).toHaveBeenCalledWith('owner', '2026-10-14');
  });
});
```

`ai-exit-outcome.repository.spec.ts`: each method's Prisma call shape (`createPending` uses `create` and swallows P2002 → no-op; `due` = `findMany({ where: { status: 'PENDING', windowEnd: { lte: now − 2 min } }, orderBy: { windowEnd: 'asc' }, take })`; `markRetry` increments `attempts`; `forDay` filters `decisionAt` in the IST day `[istMidnight, +24 h)` and `status: 'DONE'`).

Execution repository spec: `scoringCandidates(now, since, windowMin)` builds the R10 `where` (assert `verdictId: { not: { startsWith: 'man_' } }` via `NOT: { verdictId: { startsWith: MANUAL_VERDICT_PREFIX } }`, the three status branches, and the outcome anti-join — implement the anti-join with a raw query or by excluding `executionId`s present in `ai_exit_outcomes`; pick raw SQL with `NOT EXISTS` and assert its text).

Poller spec: enabled ⇒ a 60 s outcome timer is started and cleared on destroy.

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && npx jest src/modules/sentinel-executor --ci --maxWorkers=2`
Expected: FAIL.

- [ ] **Step 3: Implement**

Write `AiExitOutcomeRepository` and the two execution-repository methods to the shapes above. `ExitOutcomeService` constructor (Nest wiring in the module): `(execRepo: AiExitExecutionRepository, outRepo: AiExitOutcomeRepository, prisma: PrismaService, @Inject(EXIT_OUTCOME_CANDLES) candles: Pick<CandleRepo,'read'>, moduleRef: ModuleRef, @Inject(AI_EXIT_SESSION_CLOCK) clock, @Inject(EXIT_DISCIPLINE_CONFIG) cfg, @Inject(EXIT_OUTCOME_USERS) userIds: string[])`; provide `EXIT_OUTCOME_CANDLES` as `new PrismaCandleRepo(prisma)` and `EXIT_OUTCOME_USERS` as `parseAutoExitConfig(process.env).userIds`. Hub source: `try { return moduleRef.get<HubCandleSource>(HUB_CANDLE_SOURCE, { strict: false }) ?? null } catch { return null }`, resolved lazily per pass. Every step is wrapped in its own try/catch with a `[exit-outcome]` WARN; nothing throws out of `runOnce`; at most 10 due rows scored per pass (one hub call each at most). Log one `[exit-outcome] <symbol> <kind> missed=₹… saved=₹… net=₹… (<dataSource>)` line per DONE row.

Poller: inject `ExitOutcomeService`; start `setInterval(() => void this.outcomes.runOnce(), 60_000)` (unref'd) in `onModuleInit` after the settle timer; clear on destroy.

- [ ] **Step 4: Run to verify they pass**

Run: `cd apps/api && npx jest src/modules/sentinel-executor src/modules/exit-discipline --ci --maxWorkers=2`
Expected: PASS. Also `npx tsc --noEmit -p tsconfig.json`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/sentinel-executor/repositories/ai-exit-outcome.repository.ts apps/api/src/modules/sentinel-executor/repositories/ai-exit-outcome.repository.spec.ts apps/api/src/modules/sentinel-executor/services/exit-outcome.service.ts apps/api/src/modules/sentinel-executor/services/exit-outcome.service.spec.ts apps/api/src/modules/sentinel-executor/repositories/ai-exit-execution.repository.ts apps/api/src/modules/sentinel-executor/repositories/ai-exit-execution.repository.spec.ts apps/api/src/modules/sentinel-executor/services/sentinel-exit-poller.service.ts apps/api/src/modules/sentinel-executor/services/sentinel-exit-poller.service.spec.ts apps/api/src/modules/sentinel-executor/sentinel-executor.module.ts apps/api/src/modules/sentinel-executor/sentinel-executor.module.spec.ts
git commit -m "feat(sentinel-executor): score every AI exit decision after the fact (spec §8, E4/E5/E7)

Executed, dry-run, gated and awaiting decisions get an ai_exit_outcomes row:
max/min after, closes at +15/+30/+60, missed and saved rupees. Bars come from
candles_1m, then one governed hub fill; never a direct broker call. Fill
quality is backfilled; AI outcomes are merged into the SP3 corpus record; one
[exit-score] line per user per IST day.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Task 16: API + UI — gate, quality and outcome on the AI exits list (Stream C)

**Files:**
- Modify: `apps/api/src/modules/sentinel-executor/dto/ai-exit-execution.dto.ts`
- Modify: `apps/api/src/modules/sentinel-executor/controllers/sentinel-executor.controller.ts`, `.spec.ts`
- Modify: `apps/web/src/hooks/useAiExits.ts`
- Modify: `apps/web/src/components/charts/aiExitView.ts`, `aiExitView.test.ts`
- Modify: `apps/web/src/components/charts/AiExitsList.tsx`

**Interfaces:**
- Produces (DTO, all optional on the web side so an older API still renders):
  - `gate: { outcome: GateOutcome; justification: string | null; summary: string } | null` (`summary = gateSummary(record)`);
  - `quality: { decisionLtp: number | null; orderLtp: number | null; fillPrice: number | null; fillAt: string | null; slippage: number | null; costPerUnit: number | null; latencyMs: number | null } | null` (`costPerUnit`: SELL `decisionLtp − fillPrice`, BUY `fillPrice − decisionLtp`; positive = cost);
  - `outcome: { kind: OutcomeKind; status: 'PENDING' | 'DONE' | 'NO_DATA'; missedPnl: number | null; savedPnl: number | null; netAtEnd: number | null; windowEnd: string } | null`.
- `toAiExitExecutionDto(r, outcome?: AiExitOutcome | null)`.
- `GET /api/sentinel-executor/scorecard?day=YYYY-MM-DD` → `Scorecard` (same authorisation as `executions`; default day = yesterday IST; rows are the caller's own).
- Web: `aiExitRowView` gains `gateLine: string | null`, `qualityLine: string | null`, `outcomeLine: string | null`.

- [ ] **Step 1: Write the failing tests**

Controller spec: `executions` returns `gate.summary`, `quality.costPerUnit` and `outcome` joined by `executionId` (one `byExecutionIds` call for the page); `scorecard` returns the computed object for the caller only, 403 for a non-allowed non-admin, 400 for a malformed `day`.

`aiExitView.test.ts`:

```ts
it('gate line: GATED reads as "held — thesis intact" with the numbers', () => {
  const v = aiExitRowView({ ...row(), status: 'SKIPPED', reason: 'GATED_THESIS_INTACT',
    gate: { outcome: 'GATED_THESIS_INTACT', justification: null, summary: 'GATED_THESIS_INTACT: u 9003, inv 8932, vwap 9000, floor 530.5 ltp 527.1, N 4.5/3.1' } });
  expect(v.gateLine).toBe('Held — thesis intact: u 9003, inv 8932, vwap 9000, floor 530.5 ltp 527.1, N 4.5/3.1');
});
it('quality line: fill, slippage cost and latency', () => {
  const v = aiExitRowView({ ...row(), status: 'FILLED', quality: { decisionLtp: 527.6, orderLtp: 527.4, fillPrice: 527.1, fillAt: '2026-10-14T11:01:05Z', slippage: -0.5, costPerUnit: 0.5, latencyMs: 35_000 } });
  expect(v.qualityLine).toBe('Filled 527.1 · cost 0.5/unit vs decision 527.6 · 35 s');
});
it('outcome line: missed / saved after the window; pending says so', () => {
  expect(aiExitRowView({ ...row(), outcome: { kind: 'EXECUTED', status: 'DONE', missedPnl: 1490, savedPnl: 410, netAtEnd: 1190, windowEnd: 'x' } }).outcomeLine)
    .toBe('Next 60 min: missed ₹1,490 · saved ₹410');
  expect(aiExitRowView({ ...row(), outcome: { kind: 'GATED', status: 'PENDING', missedPnl: null, savedPnl: null, netAtEnd: null, windowEnd: '2026-10-14T12:00:30Z' } }).outcomeLine)
    .toMatch(/^Scoring after /);
  expect(aiExitRowView(row()).outcomeLine).toBeNull();
});
```

(`row()` = the test file's existing row factory; the window label reads the minutes from the configured default 60 — pass it as a constant `OUTCOME_WINDOW_LABEL = 'Next 60 min'` in `aiExitView.ts`.)

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && npx jest src/modules/sentinel-executor/controllers --ci --maxWorkers=2` and `cd apps/web && npx vitest run src/components/charts/aiExitView.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** the DTO fields, the controller join and endpoint, the web type (optional fields), the three view lines (en-IN number formatting for rupees, `Held — thesis intact` / `Held — awaiting a confirming EXIT_NOW` for the two skip outcomes, `Gate passed — <justification>` for PASS), and render them in `AiExitsList.tsx` as muted secondary lines under the existing row text (no new component).

- [ ] **Step 4: Run to verify they pass**

Run: `cd apps/api && npx jest src/modules/sentinel-executor --ci --maxWorkers=2`; `cd apps/web && npx vitest run src/components/charts && npx tsc --noEmit -p tsconfig.json`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/sentinel-executor/dto/ai-exit-execution.dto.ts apps/api/src/modules/sentinel-executor/controllers/sentinel-executor.controller.ts apps/api/src/modules/sentinel-executor/controllers/sentinel-executor.controller.spec.ts apps/web/src/hooks/useAiExits.ts apps/web/src/components/charts/aiExitView.ts apps/web/src/components/charts/aiExitView.test.ts apps/web/src/components/charts/AiExitsList.tsx
git commit -m "feat(sentinel-executor,web): show the gate's reason, fill quality and post-exit outcome on AI exits

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Task 17: Replay fixture format, exporter and synthetic CRUDEOIL fixture (Stream D)

**Files:**
- Create: `apps/api/src/modules/exit-discipline/replay/fixture.ts`, `fixture.spec.ts`
- Create: `apps/api/src/modules/exit-discipline/replay/synthetic-crude.ts`
- Create: `apps/api/src/modules/exit-discipline/replay/fixtures/.gitignore` (content: `*.real.json`)
- Create: `apps/api/scripts/export-exit-fixture.ts`
- Create: `apps/api/scripts/sql/export-exit-fixture.sql`

**Interfaces:**
- Produces:

```ts
export interface FixtureVerdict { id: string; verdict: string; createdAt: string; packet: unknown; promptVersion: string; reason: string }
export interface ExitFixtureV1 {
  v: 1;
  name: string;
  meta: {
    symbol: string; exchange: string; token: string; underlyingExchange: string | null; underlyingToken: string | null;
    side: PositionSide; qty: number; entryPrice: number; entryAt: string; segment: 'OPT' | 'FUT' | 'EQ_DELIVERY' | 'EQ_INTRADAY';
    productType: string | null; maxLossPerTrade: number | null;
    actualExit: { verdictId: string; price: number; at: string } | null;
    finalMark: { price: number; at: string };
    source: 'prod-export' | 'synthetic'; exportedAt: string;
  };
  verdicts: FixtureVerdict[];            // oldest first, live verdicts only
  contractBars: MinuteBar[];
  underlyingBars: MinuteBar[];
  executions: Array<{ verdictId: string; status: string; reason: string | null; createdAt: string; fillPrice: number | null; orderLtp: number | null }>;
  outcomes?: Array<{ verdictId: string; kind: string; missedPnl: number | null; savedPnl: number | null; netAtEnd: number | null }>;
}
export function validateFixture(x: unknown): ExitFixtureV1;  // throws Error naming the first bad field
export function buildSyntheticCrudeFixture(opts?: { breakAt?: string /* 'HH:mm' IST */; breakTo?: number }): ExitFixtureV1;
```

Synthetic fixture (deterministic, from spec §1 numbers): entry 521.9 at 15:39 IST, qty 100, LONG `CRUDEOIL17NOV269000CE` (MCX token `582930`), product `CARRYFORWARD`, `maxLossPerTrade` 2000. Contract bars 15:39–17:45 interpolated through (IST → premium) `15:39 521.9, 15:50 530, 16:00 536, 16:10 539.5, 16:18 526, 16:25 533, 16:31 527.1, 16:40 531, 16:50 535, 17:05 538, 17:20 542, 17:45 540`, each bar `open = previous close, close = interpolated, high = max(open, close) + 2.25, low = min(open, close) − 2.25`. Underlying bars through `15:39 9000, 16:00 9012, 16:10 9018, 16:20 8998, 16:31 9003, 17:00 9010, 17:45 9015` with ±1.5 wicks. Verdicts (IST): `15:40 HOLD, 16:00 HOLD, 16:05 EXIT_NOW, 16:12 EXIT_ARMED, 16:20 HOLD, 16:24 EXIT_NOW, 16:26 EXIT_ARMED, 16:28 EXIT_NOW, 16:29 EXIT_ARMED, 16:31 EXIT_NOW (id 'v-1631', the one that sold), 16:40 HOLD, 17:00 HOLD`. Each packet: position (ltp = contract close of that minute, `underlyingLtp` present = underlying close), money (`charges` 61, `netPnl` computed, `greenFloorPrice` 524.85, `greenFloorArmed` true — the fixed floor of that day), thesis (`invalidation` 8932, `levelPrice` 8960, `targetPrice` 9100), structure (`levelBook` value `{ vwap: 8995, atr14: 13.5, interval: '15m' }` — 8995 keeps every synthetic underlying close above VWAP, so only the HOLD-anchored move can confirm a floor breach, `nearestSupport` 8946, `nearestResistance` 9020), flow without `noiseUnit` (pre-v7), session (`nowUtc` = verdict time − 30 s, `minutesToClose` = minutes to 23:30 IST). `actualExit` = `{ verdictId: 'v-1631', price: 527.1, at: 16:31 }`, `finalMark` = `{ price: 542, at: 17:20 }`. With `breakAt`/`breakTo`: from that minute on the underlying bars are pinned at `breakTo` and an `EXIT_NOW` verdict (id `v-break`) is appended at `breakAt` with `underlyingLtp = breakTo` (and later verdicts are dropped).

- [ ] **Step 1: Write the failing test** (`fixture.spec.ts`)

```ts
import { buildSyntheticCrudeFixture } from './synthetic-crude';
import { validateFixture } from './fixture';
import { noiseFromBars } from '../noise';

describe('ExitFixtureV1', () => {
  const fx = buildSyntheticCrudeFixture();
  it('the synthetic fixture validates and is deterministic', () => {
    expect(validateFixture(JSON.parse(JSON.stringify(fx)))).toEqual(fx);
    expect(buildSyntheticCrudeFixture()).toEqual(fx);
  });
  it('encodes the evidence: six flip-flops, the 16:31 sale at 527.1, a later 542', () => {
    expect(fx.verdicts.filter((v) => v.verdict === 'EXIT_NOW')).toHaveLength(4);
    expect(fx.meta.actualExit).toEqual({ verdictId: 'v-1631', price: 527.1, at: '2026-10-14T11:01:00.000Z' });
    expect(fx.meta.finalMark.price).toBe(542);
  });
  it('the contract noise unit is in the spec range (N ≈ 4–7)', () => {
    const n = noiseFromBars(fx.contractBars.filter((b) => b.ts <= Date.parse('2026-10-14T11:01:00Z')))!.n;
    expect(n).toBeGreaterThan(4);
    expect(n).toBeLessThan(7);
  });
  it('breakAt pins the underlying and appends the breaking EXIT_NOW', () => {
    const b = buildSyntheticCrudeFixture({ breakAt: '16:45', breakTo: 8925 });
    expect(b.verdicts.at(-1)).toMatchObject({ id: 'v-break', verdict: 'EXIT_NOW' });
    expect(b.underlyingBars.at(-1)!.close).toBe(8925);
  });
  it.each([
    ['wrong version', { ...fx, v: 2 }], ['no verdicts', { ...fx, verdicts: 'x' }], ['bad side', { ...fx, meta: { ...fx.meta, side: 'BUY' } }],
  ])('rejects %s', (_l, bad) => expect(() => validateFixture(bad)).toThrow());
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx jest src/modules/exit-discipline/replay/fixture.spec.ts --ci --maxWorkers=2`
Expected: FAIL.

- [ ] **Step 3: Implement** `fixture.ts`, `synthetic-crude.ts` (pure, no Date.now — `exportedAt` fixed `'2026-10-15T00:00:00.000Z'`), and the exporters:

`apps/api/scripts/export-exit-fixture.ts` (ts-node; owner/lead runs it on the server or through a tunnel with `DATABASE_URL` set):

```
Usage: npx ts-node apps/api/scripts/export-exit-fixture.ts --tracker <trackerId> --underlying-token <token> [--underlying-exchange MCX]
         [--from <ISO>] [--to <ISO>] [--final-price <n> --final-at <ISO>] --out <file.real.json>
```

It reads (read-only): the tracker row (`trade_trackers`), live `sentinel_verdicts` for the tracker in `[from, to]` (default: tracker `entryTime` → +8 h), `ai_exit_executions` and `ai_exit_outcomes` for those verdict ids, `candles_1m` for the contract and the underlying over the same window, the effective `maxRiskPerTrade`; fills `meta` (side from `qty` sign, segment via `segmentFor` from `trade-sentinel/charges.ts`, `actualExit` from the FILLED/PLACED execution if any, `finalMark` from `--final-*` or the last contract bar); validates with `validateFixture`; writes pretty JSON. Never writes to the DB. It prints the counts (verdicts, bars, executions) and warns when `contractBars` is empty ("N will be unknown in the replay — the floor falls back to fixed; the thesis gate still runs").

`apps/api/scripts/sql/export-exit-fixture.sql` — psql-only alternative producing the same JSON (owner can run it with no Node on the box):

```sql
-- psql "$DATABASE_URL" -At -v tracker="'<trackerId>'" -v utoken="'<underlyingToken>'" -v uex="'MCX'" \
--      -v t0="'2026-10-14T10:00:00Z'" -v t1="'2026-10-14T13:00:00Z'" -f export-exit-fixture.sql > crude-2026-10-14.real.json
-- Then fill meta.finalMark / meta.actualExit by hand if needed; the replay validates the file.
SELECT json_build_object(
  'v', 1,
  'name', 'export ' || :tracker,
  'meta', (SELECT json_build_object(
      'symbol', t."symbol", 'exchange', t."exchange", 'token', t."token",
      'underlyingExchange', :uex, 'underlyingToken', :utoken,
      'side', CASE WHEN t."qty" < 0 THEN 'SHORT' ELSE 'LONG' END, 'qty', abs(t."qty"),
      'entryPrice', t."entryPrice", 'entryAt', t."entryTime", 'segment', 'OPT',
      'productType', NULL, 'maxLossPerTrade', NULL, 'actualExit', NULL,
      'finalMark', json_build_object('price', 0, 'at', :t1), 'source', 'prod-export', 'exportedAt', now())
    FROM "trade_trackers" t WHERE t."id" = :tracker),
  'verdicts', COALESCE((SELECT json_agg(json_build_object('id', v."id", 'verdict', v."verdict", 'createdAt', v."createdAt",
      'packet', v."packet", 'promptVersion', v."promptVersion", 'reason', v."reason") ORDER BY v."createdAt")
    FROM "sentinel_verdicts" v WHERE v."trackerId" = :tracker AND v."createdAt" BETWEEN :t0::timestamptz AND :t1::timestamptz
      AND v."promptVersion" !~ '^o[0-9]+/'), '[]'::json),
  'contractBars', COALESCE((SELECT json_agg(json_build_object('ts', (extract(epoch FROM c.ts) * 1000)::bigint,
      'open', c.open, 'high', c.high, 'low', c.low, 'close', c.close) ORDER BY c.ts)
    FROM "candles_1m" c JOIN "trade_trackers" t ON t."id" = :tracker
    WHERE c.exchange = t."exchange" AND c.token = t."token" AND c.ts BETWEEN :t0::timestamptz AND :t1::timestamptz), '[]'::json),
  'underlyingBars', COALESCE((SELECT json_agg(json_build_object('ts', (extract(epoch FROM c.ts) * 1000)::bigint,
      'open', c.open, 'high', c.high, 'low', c.low, 'close', c.close) ORDER BY c.ts)
    FROM "candles_1m" c WHERE c.exchange = :uex AND c.token = :utoken AND c.ts BETWEEN :t0::timestamptz AND :t1::timestamptz), '[]'::json),
  'executions', COALESCE((SELECT json_agg(json_build_object('verdictId', e."verdictId", 'status', e."status", 'reason', e."reason",
      'createdAt', e."createdAt", 'fillPrice', e."fillPrice", 'orderLtp', e."orderLtp") ORDER BY e."createdAt")
    FROM "ai_exit_executions" e WHERE e."trackerId" = :tracker), '[]'::json)
);
```

(Before the Task 2 migration is deployed, drop `fillPrice`/`orderLtp` from the executions object — they do not exist yet; the replay treats missing as null. Verify the `candles_1m` column names against `candle-repository.ts` `read()` before first use.)

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && npx jest src/modules/exit-discipline/replay/fixture.spec.ts --ci --maxWorkers=2`
Expected: PASS. Run `npx ts-node apps/api/scripts/export-exit-fixture.ts --help` → prints usage, exit 0 (no DB needed for `--help`).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/exit-discipline/replay/fixture.ts apps/api/src/modules/exit-discipline/replay/fixture.spec.ts apps/api/src/modules/exit-discipline/replay/synthetic-crude.ts apps/api/src/modules/exit-discipline/replay/fixtures/.gitignore apps/api/scripts/export-exit-fixture.ts apps/api/scripts/sql/export-exit-fixture.sql
git commit -m "feat(exit-discipline): replay fixture format, prod exporter (ts-node + psql) and the synthetic CRUDEOIL day

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Task 18: Replay engine + the spec §12 replay (Stream D, after Tasks 5, 8, 9)

**Files:**
- Create: `apps/api/src/modules/exit-discipline/replay/replay-exits.ts`
- Create: `apps/api/src/modules/exit-discipline/replay/replay-exits.spec.ts`

**Interfaces:**
- Consumes: Tasks 4, 5, 8, 17 (`decideExit`, `buildGateFacts`, `readPacketFacts`, `noiseFromBars`, `scaledUnderlyingNoise`, `noiseAwareFloor`, `ExitFixtureV1`).
- Produces:

```ts
export interface ReplayOptions { cfg: ExitDisciplineConfig; breakeven: (m: ExitFixtureV1['meta']) => number }
export interface ReplayDecision { verdictId: string; at: string; record: GateRecordV1; ltpNow: number; nContract: number | null; floor: { price: number | null; armed: boolean } }
export interface ReplayResult {
  decisions: ReplayDecision[];                    // one per EXIT_NOW evaluated (stops after the first PASS/BYPASS)
  executed: ReplayDecision | null;
  pnl: { exitPrice: number; exitAt: string; grossRupees: number; basis: 'executed' | 'final-mark' };
  counts: { gated: number; awaiting: number; passed: number };
}
export function replayExits(fx: ExitFixtureV1, o: ReplayOptions): ReplayResult;
```

Engine (pure, deterministic): walk verdicts oldest first, keeping the noise-floor latch (`prevArmedLevel`, `latchedArmed`) updated at EVERY verdict time; for each verdict: CLOSED bars only (bar end `ts + 60 s` ≤ verdict time); `N = noiseFromBars(contractBars in the last 120 min)`; `N_u = noiseFromBars(underlying window) ?? scaledUnderlyingNoise(packet levelBook atr14)`; `peak = max(packet mfe, max contract high since entry)` (LONG; min for SHORT); floor = `noiseAwareFloor` when `N` known else the packet's fixed floor; for `EXIT_NOW` only: `ltpNow` = close of the bar containing the verdict time (else packet ltp), facts = `buildGateFacts(readPacketFacts(packet), { ltpNow, productType: meta.productType, minutesToClose: null, maxLossPerTrade: meta.maxLossPerTrade, dailyLossLatched: false, history: prior verdicts mapped to HistoryVerdict (underlying/support/resistance read from their packets), now: verdict time, nContractOverride: N?.n ?? null, nUnderlyingOverride: N_u?.n ?? null, floorOverride })`, record = `decideExit(…)`; the first `PASS` or `BYPASS` is the executed exit (stop). P&L: executed ⇒ `(ltpNow − entry)·qty·dir`; none ⇒ `(finalMark − entry)·qty·dir`.

- [ ] **Step 1: Write the failing test**

```ts
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { breakevenPrice } from '../../trade-sentinel/charges';
import { parseExitDisciplineConfig } from '../config';
import { validateFixture } from './fixture';
import { replayExits } from './replay-exits';
import { buildSyntheticCrudeFixture } from './synthetic-crude';

const ON = parseExitDisciplineConfig({});
const OFF = parseExitDisciplineConfig({ EXIT_DISCIPLINE_ENABLED: 'false' });
const be = (m: { segment: any; entryPrice: number; qty: number; side: any }) =>
  breakevenPrice({ segment: m.segment, entryPrice: m.entryPrice, qty: m.qty, side: m.side })!;

describe('spec §12 replay — synthetic CRUDEOIL17NOV269000CE, 2026-10-14', () => {
  const fx = buildSyntheticCrudeFixture();

  it('package ON: no EXIT_NOW executes — every one is gated with its numbers; the 16:31 sale is held', () => {
    const r = replayExits(fx, { cfg: ON, breakeven: be });
    expect(r.executed).toBeNull();
    expect(r.decisions.map((d) => d.record.outcome)).toEqual(['GATED_THESIS_INTACT', 'GATED_THESIS_INTACT', 'GATED_THESIS_INTACT', 'GATED_THESIS_INTACT']);
    const at1631 = r.decisions.find((d) => d.verdictId === 'v-1631')!;
    expect(at1631.record.clauses.find((c) => c.id === 'THESIS_INVALIDATION')).toMatchObject({ pass: false });
    expect(at1631.nContract).toBeGreaterThan(4);
    expect(r.pnl).toMatchObject({ basis: 'final-mark', exitPrice: 542 });
    expect(r.pnl.grossRupees).toBeCloseTo((542 - 521.9) * 100, 6);
  });

  it('package ON + a break below 8932 at 16:45: the breaking EXIT_NOW executes IMMEDIATELY (no confirmation wait)', () => {
    const r = replayExits(buildSyntheticCrudeFixture({ breakAt: '16:45', breakTo: 8925 }), { cfg: ON, breakeven: be });
    expect(r.executed).toMatchObject({ verdictId: 'v-break', record: { outcome: 'PASS', justification: 'THESIS_BROKEN', persistence: { rule: 'BYPASS' } } });
  });

  it('package OFF reproduces today: the first EXIT_NOW executes', () => {
    const r = replayExits(fx, { cfg: OFF, breakeven: be });
    expect(r.executed).toMatchObject({ record: { outcome: 'BYPASS', bypassReason: 'DISABLED' } });
  });
});

/** Real exports (git-ignored *.real.json, produced by scripts/export-exit-fixture.ts). */
const dir = join(__dirname, 'fixtures');
const real = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.real.json')) : [];
(real.length ? describe : describe.skip)('spec §12 replay — real exports', () => {
  it.each(real)('%s: the AI exit that actually sold is not PASS unless a justification clause passed with numbers', (file) => {
    const fx = validateFixture(JSON.parse(readFileSync(join(dir, file), 'utf8')));
    const r = replayExits(fx, { cfg: ON, breakeven: be });
    for (const d of r.decisions) {
      if (d.record.outcome === 'PASS') expect(d.record.clauses.some((c) => c.pass === true)).toBe(true);
    }
    if (fx.meta.actualExit) {
      const sold = r.decisions.find((d) => d.verdictId === fx.meta.actualExit!.verdictId);
      // If this fails on the CRUDEOIL export: STOP and report the clause numbers to the owner — do not tune to pass.
      expect(sold?.record.outcome).not.toBe('PASS');
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx jest src/modules/exit-discipline/replay --ci --maxWorkers=2`
Expected: FAIL — `replay-exits` not found.

- [ ] **Step 3: Implement `replay-exits.ts`** per the engine description (imports only from `exit-discipline/`; `breakeven` injected — the structure spec from Task 1 must stay green).

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && npx jest src/modules/exit-discipline --ci --maxWorkers=2`
Expected: PASS (real-export block skipped when no file). If the lead has placed `crude-2026-10-14.real.json` in `replay/fixtures/`, it runs too; a failure there is a finding for the owner (Review Focus 5), reported with `gateSummary` of the decision.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/exit-discipline/replay/replay-exits.ts apps/api/src/modules/exit-discipline/replay/replay-exits.spec.ts
git commit -m "test(exit-discipline): spec §12 replay — the 16:31 CRUDEOIL sale is gated; a thesis break exits at once

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Task 19: E6 — replay tuning harness (Stream D)

**Files:**
- Create: `apps/api/scripts/exit-replay.ts`
- Modify: `apps/api/src/modules/exit-discipline/replay/replay-exits.ts` (+spec) — add `gridConfigs`

**Interfaces:**
- Produces: `gridConfigs(base: ExitDisciplineConfig, grid: Partial<Record<'floorArmN' | 'floorTrailN' | 'gateUnderlyingN' | 'persistWindowSec' | 'persistMinSec', number[]>>): ExitDisciplineConfig[]` (cartesian product, base values where a key is absent, stable order).

CLI:

```
npx ts-node apps/api/scripts/exit-replay.ts <fixture.json>... [--floorArmN 1,1.5,2] [--floorTrailN 1.5,2,2.5]
    [--gateUnderlyingN 0.5,1,1.5] [--persistWindowSec 300] [--persistMinSec 60,120,180] [--verbose]
```

Output (one table per fixture, then a total row per setting across fixtures):

```
crude-2026-10-14.real.json  entry 521.9 x100 LONG  actual exit 527.1 @16:31 (+₹520)  final mark 542
armN trailN uN  persist   | exit           P&L ₹    vs actual | gated awaiting passed
1.5  2.0    1.0 300/120   | held→542       +2010    +1490     |   4      0       0
1.5  2.0    0.5 300/120   | 16:31 @527.1   +520     0         |   3      0       1
...
--verbose: one line per EXIT_NOW with gateSummary(record)
If the fixture carries ai_exit_outcomes, they are printed under the table (kind, missed, saved, net).
```

- [ ] **Step 1: Write the failing test** (in `replay-exits.spec.ts`)

```ts
import { gridConfigs } from './replay-exits';
describe('gridConfigs', () => {
  it('cartesian product over the given keys, base elsewhere', () => {
    const g = gridConfigs(ON, { floorTrailN: [1.5, 2], gateUnderlyingN: [0.5, 1] });
    expect(g.map((c) => [c.floorTrailN, c.gateUnderlyingN])).toEqual([[1.5, 0.5], [1.5, 1], [2, 0.5], [2, 1]]);
    expect(g.every((c) => c.floorArmN === 1.5 && c.enabled)).toBe(true);
  });
  it('no grid ⇒ just the base', () => expect(gridConfigs(ON, {})).toEqual([ON]));
  it('a lower gateUnderlyingN can only add executions on the synthetic day (monotone sanity)', () => {
    const fx = buildSyntheticCrudeFixture();
    const passed = (n: number) => replayExits(fx, { cfg: { ...ON, gateUnderlyingN: n }, breakeven: be }).counts.passed;
    expect(passed(0.25)).toBeGreaterThanOrEqual(passed(1));
  });
});
```

- [ ] **Step 2: Run to verify it fails**, **Step 3: implement** `gridConfigs` and the script (argument parsing by hand — no new dependency; reads files with `fs`, validates with `validateFixture`, `breakeven` from `trade-sentinel/charges.ts`, prints with `padEnd`; exit code 1 on an invalid fixture), **Step 4: verify**:

Run: `cd apps/api && npx jest src/modules/exit-discipline/replay --ci --maxWorkers=2` → PASS.
Run: write the synthetic fixture to the scratchpad (`npx ts-node -e "process.stdout.write(JSON.stringify(require('./apps/api/src/modules/exit-discipline/replay/synthetic-crude').buildSyntheticCrudeFixture()))" > <scratchpad>/crude.synthetic.json`) and `npx ts-node apps/api/scripts/exit-replay.ts <scratchpad>/crude.synthetic.json --gateUnderlyingN 0.5,1,1.5 --verbose` → a 3-row table; the default row shows `held→542`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/scripts/exit-replay.ts apps/api/src/modules/exit-discipline/replay/replay-exits.ts apps/api/src/modules/exit-discipline/replay/replay-exits.spec.ts
git commit -m "feat(exit-discipline): E6 replay tuning harness — which exits each multiplier set would have executed, and the P&L

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Task 20: Integration, full suite, release notes (integration branch)

- [ ] **Step 1:** Create `feature/exit-discipline` from `main`; merge in order S, F, A, B, C, D (`git merge --no-ff feature/ed-<x>`); resolve only the expected overlaps (Conflict map). If price triggers is already on `main`, apply Merge points M1 (drop the `as never` cast), M2 (renumber + redo Task 12 Steps 1–6 on top) and M5.
- [ ] **Step 2:** `cd apps/api && npx prisma generate && npx tsc --noEmit -p tsconfig.json` → clean. `cd apps/web && npx tsc --noEmit -p tsconfig.json` → clean.
- [ ] **Step 3:** `cd apps/api && npx jest --ci --maxWorkers=2` → all green (note the suite count before/after in the merge commit). `cd apps/web && npx vitest run` → green.
- [ ] **Step 4:** Re-read Review Focus 1–5 and point at each pinning test by name in the merge commit body.
- [ ] **Step 5:** Hand the lead the export commands (Task 17) for the 2026-10-14 tracker so the real replay (Task 18) and the harness (Task 19) can be run before the production deploy.

---

## Production Gate

**Before deploy (lead + owner):**
1. Export the 2026-10-14 CRUDEOIL day (`scripts/sql/export-exit-fixture.sql` on the server, tracker id of `CRUDEOIL17NOV269000CE`, underlying = the CRUDEOIL NOV future token, `t0 = 2026-10-14T10:00Z`, `t1 = 2026-10-14T13:00Z`), drop it into `apps/api/src/modules/exit-discipline/replay/fixtures/crude-2026-10-14.real.json`, run `npx jest src/modules/exit-discipline/replay --ci --maxWorkers=2` and `npx ts-node apps/api/scripts/exit-replay.ts <file> --gateUnderlyingN 0.5,1,1.5 --floorTrailN 1.5,2,2.5 --verbose`. Owner reviews the table; E1 defaults stay unless the evidence says otherwise.
2. On the server: `SELECT count(*), max(ts) FROM candles_1m WHERE token = '<open contract token>' AND ts > now() - interval '1 day';` — zero rows ⇒ `N` will be unknown (fixed floor, 40 % giveback; the thesis gate still runs). To get bars: `MARKET_HUB_ENABLED=true`, `HUB_CANDLES_ENABLED=true`, and the contract must hold a LIVE feed slot.
3. `SELECT key, scope, "numValue", "effectiveFrom" FROM core_risk_limits WHERE "userId" = '<owner>' AND key = 'maxRiskPerTrade' ORDER BY "effectiveFrom" DESC LIMIT 3;` — confirm the value is the per-trade max loss the owner wants the gate to treat as hard risk (Open Question 2).

**Add to `/opt/grw/env/api.env`** (explicit, even though they equal the defaults — the boot line must show what the owner approved):

```
EXIT_DISCIPLINE_ENABLED=true
FLOOR_ARM_N=1.5
FLOOR_TRAIL_N=2.0
GIVEBACK_N=1.5
GATE_CLOSE_MIN=10
GATE_UNDERLYING_N=1.0
PERSIST_WINDOW_SEC=300
PERSIST_MIN_SEC=120
EXIT_OUTCOME_WINDOW_MIN=60
```

**Deploy:** the migration `20261015120000_exit_discipline` is applied by the normal deploy (`prisma migrate deploy`). Verify: `SELECT column_name FROM information_schema.columns WHERE table_name = 'ai_exit_executions' AND column_name IN ('gate','fillPrice','orderLtp');` → 3 rows; `SELECT to_regclass('ai_exit_outcomes');` → not null.

**Boot log lines to see** (`docker logs` / journal of the API):
- `[ai-exit] ENABLED mode=live users=1 …` (unchanged)
- `[exit-discipline] ON floorArmN=1.5 floorTrailN=2 givebackN=1.5 gateCloseMin=10 gateUnderlyingN=1 persist=300s/120s outcomeWindow=60m`
- NO `[exit-discipline] … is out of range` warnings.

**During the first session:**
- `SELECT packet->'flow'->'noiseUnit'->'available', packet->'money'->>'floorBasis', "promptVersion" FROM sentinel_verdicts ORDER BY "createdAt" DESC LIMIT 5;` → `true` / `noise` / `v7/t1` (or `v2.4/t1` with cues off) once bars exist.
- Every AI `EXIT_NOW` produces exactly one of: `[exit-gate] GATED_THESIS_INTACT: …`, `[exit-gate] AWAITING_CONFIRMATION: …`, `[exit-gate] PASS: <justification> via <clauses> …` followed by the usual `[ai-exit] LIVE MARKET …`, or `[exit-gate] facts unreadable — failing OPEN` (investigate any of the last).
- `[exit-fill] … FILLED @ …` for any exit that rested past 10 s; no row stays PLACED after a fill (`SELECT id FROM ai_exit_executions WHERE status = 'PLACED' AND "createdAt" < now() - interval '15 minutes';` → none).
- About 62 minutes after the first scored decision: `[exit-outcome] <symbol> <kind> missed=₹… saved=₹… net=₹…`.
- After 00:05 IST: `[exit-score] <day> executed=… | gate blocked=… helped=₹… cost=₹… net=₹… | dry-run=…`.

**Rollback:** `EXIT_DISCIPLINE_ENABLED=false` + restart ⇒ fixed floor, 40 % giveback, no gate, no persistence, no exit-confirm wake (prompt v7 text stays; `flow.noiseUnit` becomes an absent block). Fill capture and scoring keep running (observation only). The migration is expand-only and needs no rollback.

## Open Questions (defaults stated; owner may override)

1. **Unreadable gate facts fail OPEN** (sell as today, WARN, row `BYPASS: FACTS_UNREADABLE`). The alternative — fail closed — would let a DB hiccup block a genuine exit; the broker stop-loss is the backstop either way. *Default: fail open.*
2. **Hard-risk "per-trade max loss" = `core_risk_limits` `maxRiskPerTrade@ALL`.** It was set for the core engine's own entries; the owner's manual positions may deserve a different number. *Default: use it; if it is missing, that clause is simply unmeasurable.*
3. **Hard-risk "daily loss limit" = trade-core's daily-loss latch,** which the owner's manual (tracker) losses do not feed. *Default: accept; a tracker-level daily-loss rule is a separate change.*
4. **Anchor for "underlying moved against since the last HOLD".** If the last HOLD sat at an intraday high (e.g. 9018 on 2026-10-14), a normal retrace to 9003 is ~4 N_u "against" and would confirm a floor breach. The real export decides whether this bites; the harness can compare `GATE_UNDERLYING_N` values. *Default: spec as written; revisit with the replay.*
5. **Prompt numbering** follows merge order with price triggers (Merge point M2). *Default: v7 / v2.4.*
