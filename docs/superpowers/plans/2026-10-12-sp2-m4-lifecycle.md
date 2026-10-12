# SP2 M4 Lifecycle (Position Manager) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Owner decisions needed (before execution starts)

M4 has **no design spec of its own** (M3 had `2026-10-11-sp2-m3-execution-design.md`); this plan argues directly
from the parent SP2 spec §7 and the merged M1–M3 code. Where the spec is silent or ambiguous, the plan picks the
safe default shown below and every one of them is a single, named place in the code, so a different answer is a
small change. Execution may start on the defaults; anything the owner changes is folded in before Task 8.

| # | Question | Default in this plan | Where it lives |
|---|---|---|---|
| O1 | Approve this plan's rulings (L1–L19) as the M4 design, or ask for a separate M4 spec first? | Approve the plan as the design | — |
| O2 | Are `OPTIONS_BUY` positions **intraday** (squared off every day at `squareOffTime@OPTIONS_BUY`) or may they be held overnight until the expiry-day exit? | **Intraday**: squared off daily, and the expiry rules still apply | `exit-decision.ts` `INTRADAY_VEHICLES` |
| O3 | For `OPTIONS_BUY`, do the version's `stop` / `target` / `trail` blocks act on the **premium** or on the **underlying**? | **Premium.** The initial stop is the tighter of `stop` and `vehicle.premiumStopPct`; a stop on the underlying is used only when the opener supplies an explicit `underlyingStopPrice` (watched at priority 1) | `exit-plan.ts` `buildExitPlan` |
| O4 | When the owner **tightens** `squareOffTime` or `mtfMaxHoldDays` intraday, do already-open positions follow? | **Yes**: the effective value is the tighter of the value frozen at entry and the value in force now; a loosening never extends an open position | `exit-decision.ts` `effectiveSquareOff` / `effectiveHoldDays` |
| O5 | How are `timeExit.holdDays n` and `mtfMaxHoldDays` counted? | Trading days (exchange calendar) **after** the entry day; the exit happens on the n-th one at the vehicle's `squareOffTime` | `exit-decision.ts` `tradingDaysHeld` |
| O6 | Lifecycle journal before M5: a port with a logging default (M5 rebinds it to `core_journal`), or pull `core_journal` into M4? | **Port + logging default** (same pattern as M2's `RISK_VERDICT_SINK`); the durable state needed for recovery lives on `core_positions` | `lifecycle/lifecycle-events.ts` |
| O7 | Blind-position threshold `blindAfterMs` | **30,000 ms**, seeded in `core_paper_defaults` as "default — please review", owner-editable through the existing M3 PUT route | M4 migration seed |
| O8 | Exit order type for stops, targets, trails, time and square-off exits | **MARKET** through the paper adapter (depth walk, then LTP ± slippage); no resting target LIMIT and no resting SL in paper (SP7 adds the broker-side disaster stop) | `core-lifecycle.service.ts` `placeExit` |

## Goal, architecture, stack

**Goal:** Build the Position Manager of the SP2 core: a persisted per-user `core_positions` state machine
(`PENDING_ENTRY → OPEN → PARTIAL → EXITING → CLOSED`, `→ CANCELLED`), the exit rules frozen at entry (stop,
target, partial, breakeven/ATR trail, clock and hold-day time exits, vehicle square-off, the options premium,
theta and expiry rules, the MTF gap and hold-limit rules), the tighten-only stop invariant, blind-position
detection, crash recovery with `RECOVERY_STOP`, and the M2 ports rebound to real positions:
`RISK_STATE_PROVIDER` (marks, open P&L, per-strategy P&L) and `CORE_SQUARE_OFF` (kill switch / daily loss exit
every core position). Done when, in memory and against the opt-in database, a position opened through
`CoreLifecycleService.openPosition` fills through M3's paper adapter, is watched at P0, exits by each rule with the
right reason and priority, survives a restart (including a stop crossed while down), and is exited by the kill
switch and by the daily-loss monitor; user A never affects user B. **Nothing opens a position in production
until M5** (ships dark, like M3).

**Architecture:** A fourth part of `apps/api/src/modules/trade-core/`, `lifecycle/`. Four pure modules carry the
rules: `position-state.ts` (status from the position's orders, allowed moves), `exit-plan.ts` (blocks → a frozen
`ExitPlan`, levels armed from the entry fill), `stop-rules.ts` (`tightenStop`, breakeven/ATR trail, the
target→trail guard), `exit-decision.ts` (`decideExit` in spec §7.3 priority, effective limits, trading days held).
`CorePositionRepository` persists positions (guarded by a `version` column; one active position per user and
instrument under an advisory lock). `CoreLifecycleService` holds active positions in memory, watches each at P0
through `hubFor(userId, 'positions')` with owner `core:<positionId>`, evaluates on hub pushes and a 1 s sweep,
places every exit as a MARKET order through `ExecutionAdapter` (idempotency `<intentId>:exit:<seq>`), learns of
fills through a new `ExecutionAdapter.onOrderUpdate` stream (emitted by `PaperLedgerService` after each commit) and
re-reads each position's orders every 5 s as the safety net, and reloads every active position on boot.
`CoreRiskStateProvider` and `CoreSquareOff` rebind the M2 ports; `DailyLossMonitor` runs `decideDailyLoss` every
5 s for users with active positions. Approach A: no old silo, table or service changes.

**Tech Stack:** NestJS 11, TypeScript 5.7, Prisma 6 (PostgreSQL) with `Prisma.Decimal` for stored prices, Jest 29
(`ts-jest`, `isolatedModules`); pnpm workspaces. The web app is not touched in M4.

**Spec:** `docs/superpowers/specs/2026-10-09-sp2-core-trade-lifecycle-design.md` (§3 layout and tenant scoping,
§4.1 blocks, §5.1/§5.3/§5.4 the ports, §6.5 vehicles, **§7 Position Manager**, §9 errors, §10 testing, §11 M4 row);
parent `docs/superpowers/specs/2026-09-30-ai-trading-core-architecture-design.md` §7.3; SP3
`docs/superpowers/specs/2026-10-11-sp3-ai-decision-layer-design.md` §5.2 (corpus writers) and §9 (guard rails).
Format and conventions: `docs/superpowers/plans/2026-10-10-sp2-m2-risk-wall.md`,
`docs/superpowers/plans/2026-10-11-sp2-m3-execution.md`.

**Branch:** `feature/sp2-m4-lifecycle` (worktree `.claude/worktrees/sp2-m4-lifecycle`), from `main` at `c0818a3`
(SP2 M3 + SP3 M0–M2 merged). Stream worktrees: see "Parallel streams".

**Test commands:** API Jest runs from `apps/api` (`rootDir` is `src`, `testRegex` `.*\.spec\.ts$`):
`cd apps/api && npx jest <path-or-pattern>`, e.g. `npx jest src/modules/trade-core/lifecycle/position-state.spec.ts`.
The opt-in database test (Task 5) has its own config under `apps/api/test/sp2-m4/`.

## Global Constraints

- **Safety first, fail closed:** an entry the lifecycle cannot plan (missing `squareOffTime`/`mtfMaxHoldDays` in the verdict's limits, vehicle mismatch, missing option contract, symbol mismatch) is refused before any order exists; a decision is never made on a price older than `PRICE_MAX_AGE_MS = 15_000` (spec §6.3) except clock rules at square-off; **exits are never blocked** (not by the kill switch, not by the Risk Wall, not by a flag).
- **Paper only:** the only adapter is M3's `PaperExecutionAdapter`; `LIVE_TRADING_ENABLED` stays `false` and is neither read nor written; `openPosition` refuses a strategy version whose status is not `PAPER`.
- **Kill switch:** exit priority 1. The cascade (`CORE_SQUARE_OFF`) cancels pending core **entry** orders and exits every active core position; the 1 s sweep also exits a user's positions when `CoreKillSwitchReader.isOn` says on (safety net if the cascade failed). An unreadable switch is never a reason to exit (positions keep their stops) and is logged.
- **Tighten-only invariant (spec §7.4):** every stop change goes through `tightenStop(current, proposed, side)`; there is no other writer of `stopPrice` after arming.
- **No hard-coded money or risk values (SP2 D4):** values come from the version's blocks, the verdict's limits snapshot, live limits, or `core_paper_defaults` (`blindAfterMs`). The only literals in new logic are `PRICE_MAX_AGE_MS` (imported from M3), the 1 s sweep, the 5 s re-read / limits cache / daily-loss cadence, and shape bounds.
- **Approach A:** no old silo, table or service changes; outside `apps/api/src/modules/trade-core/` only `prisma/schema.prisma` + the new migration, `common/tenant/tenant.constants.ts` (one tenant model) and `common/audit/audit-actions.ts` (one `lifecycle` group) change.
- **Per-user scoping:** every `core_positions` read and write names the userId taken from the caller (never a body); the only cross-user reads are the system scans `listActive()` (boot recovery) and `listActiveUserIds()` (daily-loss monitor), which then act per user. `CorePosition` joins `TENANT_MODELS`.
- **No new `@Cron`.** Timers are `setInterval` gated by `bootJobsEnabled()` like M3's matcher. `common/schedule/cron-timezone.spec.ts` stays green and untouched. All clock rules compute IST explicitly (`istMinutesOf`, `istDate`).
- **Migrations are expand-only and auto-applied** (`grw-deploy.timer` runs `prisma migrate deploy`): one new table, one nullable column with an index and FK on an empty table, two widened CHECKs (drop + add, same table, same transaction), one seed row `ON CONFLICT DO NOTHING`. Reverting the code leaves them inert.
- **No feature flag in M4** (ruling L16): nothing in production calls `openPosition` until M5, whose fan-out flag gates entries; management of positions that exist is never behind a flag.
- **Money/price types:** stored prices `Decimal(14,4)`; numbers in the domain type, rounded to 2 dp when armed (`round2`); P&L for the Risk Wall in rupees (numbers) like M3's provider.
- **Commits:** conventional commits with explicit pathspecs only (`git commit -m … -- <paths>`), never `git add -A`, `git commit -a`, a bare commit or `git stash` (other agents share the tree; `node_modules` are junctions — never delete them); every message ends with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. No merge, push or SSH from a stream.
- **Typecheck:** new code adds no `tsc` error; compare sorted error lists with `main` (Task 14), not counts.

## Review Focus

1. **An exit that is rejected (no fresh price, or out of session) must never be silently abandoned, nor spammed.**
   The position stays `EXITING`; the sweep re-places it with the next sequence only while the session is open, at
   most once per 5 s, and never while another exit order is open. (Task 9 tests "a rejected exit is re-placed with
   the next sequence once the session is open, never twice at once" and "nothing is placed while the session is
   closed".)
2. **Restart between "exit decided" and "exit order exists".** The decision (`EXITING`, `exitSeq`) is persisted
   before the order is placed, so recovery re-places with the **same** key and the adapter returns the existing
   order if it was created — never a second order. (Task 10 test "recovery re-places a decided exit with the same
   idempotency key, once".)
3. **Kill switch while the entry is partly filled.** The entry remainder is cancelled first, then exactly the
   filled quantity is exited; with nothing filled the position ends `CANCELLED`, not `CLOSED`, and no exit order is
   placed. (Task 10 tests "kill switch on a partly filled entry cancels the remainder and exits the filled part" and
   "kill switch on an unfilled entry cancels it and the position is CANCELLED".)
4. **Overnight MTF and the morning gap.** Nothing is decided while NSE is closed (no orders, no blind flag); the
   first fresh price of the next session past the stop exits with `GAP_STOP` at market. (Task 4 test "the first
   price of a session past the stop is a GAP_STOP"; Task 9 test "a closed session decides nothing and flags no
   blind position".)
5. **A hub push and the sweep evaluating the same position at once place one exit.** Per-position serialisation
   plus the `version`-guarded `EXITING` write. (Task 9 test "a push and a sweep at once place one exit".)

## Planner rulings (where the code shaped the design)

- **L1 Exits are MARKET orders** placed through `CORE_EXECUTION_ADAPTER` (O8). Stop, target and trail levels live
  on the position and are evaluated by the lifecycle on prices, as spec §7.2 describes; nothing rests at the
  paper "broker". The M3 fill model already fills a market order at the first fresh price **after** submission, so
  a gap fills at the gap price (spec §6.3) without an SL order.
- **L2 `core_positions` is new, and `core_orders` gains a nullable `positionId`.** M3 derives a per-(vehicle,
  token) view from fills (`PaperLedgerService.positions`); that stays the ledger's view. A lifecycle position's
  status is computed from **its own orders** by the pure `reducePosition` (entry filled, exits filled, open
  orders), so the order table remains the single source of truth for quantities.
- **L3 Order updates reach the lifecycle through `ExecutionAdapter.onOrderUpdate`** (new on the interface; the
  paper adapter delegates to a `CoreOrderEvents` emitter that `PaperLedgerService` fires after every committed
  write) and `ExecutionAdapter.listPositionOrders(userId, positionId)` (new). Because an in-process event can be
  missed (restart, a listener error), the sweep re-reads each active position's orders every 5 s.
- **L4 Levels are armed at the first entry fill from the fill's average.** Later entry fills re-arm target and
  partial from the new average; the stop moves only through `tightenStop`. `initialStopPrice` keeps the first
  armed stop (it classifies a stop hit as `STOP` vs `TRAIL`).
- **L5 One stop price.** Breakeven and ATR trail produce candidate stops; `tightenStop` keeps the closer one. A
  crossed stop is `TRAIL` when the trail is active or the stop has moved from `initialStopPrice`, `STOP`
  otherwise; `RECOVERY_STOP` on the first fresh price after a restart; `GAP_STOP` on the first fresh price of an
  IST day.
- **L6 Options act on the premium** (O3); `stopPct = min(stop block %, premiumStopPct)`; an underlying stop needs an
  explicit `underlyingStopPrice` and its ref is watched at priority 1 under the same owner.
- **L7 Effective square-off and hold limits are the tighter of frozen and live** (O4). Live limits are read through
  `CoreRiskLimitService.inForce` with a 5 s per-user cache; an unreadable read falls back to the frozen values.
- **L8 Intraday vehicles** (O2): `CASH_INTRADAY` and `OPTIONS_BUY` square off daily at the effective
  `squareOffTime`; a position of an intraday vehicle that is still open on a later IST day squares off at the first
  in-session sweep. `MTF` uses `squareOffTime@MTF` only as the time of its hold-day and hold-limit exits (O5).
- **L9 No decision while the position's exchange is closed** (`CORE_SESSION_CLOCK.isOpen`): no exit, no partial, no
  blind flag, no re-placement. The adapter would reject such orders anyway; deciding them would spam rejects.
- **L10 `blindAfterMs` is an optional paper default** (O7). It is added to the `core_paper_defaults` vocabulary but
  **not** to `REQUIRED_PAPER_PAIRS` (a missing row must not reject every order, and the M3 seed spec stays
  untouched). Missing → the lifecycle uses `PRICE_MAX_AGE_MS` (stricter).
- **L11 Persistence.** Status, exit decisions, partials, blind flags and guard-rail stop moves are written at once;
  trailing marks (`stopPrice`, `highWater`, `lowWater`) are coalesced and flushed by the 1 s sweep. Every write is
  guarded by `version`; a lost race reloads the row and stops.
- **L12 Journal port** (O6): `LIFECYCLE_EVENT_SINK` with `LoggingLifecycleEventSink` as the M4 binding; event types
  are spec §8.1's `POSITION_STATE`, `STOP_MOVED`, `EXIT_DECIDED`, `BLIND`, `RECOVERY_STOP`, each with `priceUsed`
  and `priceAgeMs`. A sink failure is logged and never stops a decision.
- **L13 SP3 corpus: M4 writes nothing to `ai_decision_records`.** `core_positions.intentId` is unique and equals the
  corpus `sourceId` for `source = 'core'` (SP3 spec §5.2: "DecisionPipeline writes one record per setup; SP2's
  journal outcome fills it"). M5's closed-trade summary fills `outcome` (netPnl, grossPnl, fees, win, rMultiple,
  mfe, mae, holdMins) by `(source, sourceId) = ('core', position.intentId)`; M4 keeps what that needs on the row
  (`highWater`, `lowWater`, `initialStopPrice`, `entryAvgPrice`, `openedAt`, `closedAt`, `exitReason`). SP3 M6's
  guard rails call `proposeStop` / `requestExit` (Task 10), never the adapter.
- **L14 Cycles.** `PaperExecutionAdapter → CoreKillSwitchService → CORE_SQUARE_OFF`, so `CoreSquareOff` reaches the
  lifecycle lazily through `ModuleRef` (token `CORE_POSITION_EXITS`), and the risk provider reads marks through the
  `LIFECYCLE_MARKS` token. M3's `PaperOrderSquareOff` now cancels **entry** orders only; cancelling exit orders
  would undo the square-off it is part of.
- **L15 Daily loss** (M2 notes): `DailyLossMonitor` runs `decideDailyLoss(limits, liveState)` every 5 s for users
  with active positions and, when `squareOffCore`, calls `CORE_SQUARE_OFF` with cause `DAILY_LOSS` once per user per
  IST day per process (a repeat after a restart is harmless: it exits what is open). The persisted latch
  (`dailyLossLatched`) stays M5's (journal-derived).
- **L16 No feature flag** (see Global Constraints).
- **L17 A partial exit that is rejected is not retried**; it is journaled, the trail stays armed and the stop still
  protects the whole remaining quantity.
- **L18 Read-only positions API + manual exit:** `GET /api/trade-core/positions` (own) and
  `POST /api/trade-core/positions/:id/exit` (own, reason required, audited `CORE_POSITION_EXIT_REQUESTED`). The M5
  journal page reads the GET.
- **L19 `openPosition` requires `intent.symbol === instrument.symbol`** (case-insensitive) and stores
  `intent.underlying` as the position's exposure underlying, so the Risk Wall's conflict rules compare like with
  like (drift D12).

## Spec-vs-code drift found (and how this plan handles it)

| # | Spec says | Code is | This plan |
|---|---|---|---|
| D1 | §7.1 a `core_positions` state machine | M3 has no position table; `CorePositionView` is an aggregate per (vehicle, token) derived from fills | New `core_positions`; `core_orders.positionId` (L2) |
| D2 | §6.1 `ExecutionAdapter` (place/cancel/modify/getOrder/getPositions/getFunds) | No way to learn of fills or list a position's orders | Adds `onOrderUpdate` and `listPositionOrders` (L3); a live adapter (SP7) implements them from broker updates |
| D3 | §6.1 `cancel(orderId)` | `cancel(userId, orderId)` etc. (M3 ruling 1) | Lifecycle uses the M3 signatures |
| D4 | §5.4 kill switch "cancels pending core orders, exits all core positions" | M3 `PaperOrderSquareOff` cancels **every** open order, exits included | Entries only; exits via the lifecycle (L14) |
| D5 | §3 flow "lifecycle → ExecutionAdapter" | Adapter → kill switch → `CORE_SQUARE_OFF` makes a DI cycle once the square-off calls the lifecycle | Lazy `ModuleRef` tokens (L14) |
| D6 | §5.3 daily loss "blocked for the rest of the session" | `dailyLossLatched` is hard `false` (M3 says M5); nothing acts on `squareOffCore` | `DailyLossMonitor` acts on `squareOffCore`; latch stays M5 (L15) |
| D7 | §7.2 per-user `hubFor(userId, 'positions')` | `MarketHubService.hubFor` serves only `HUB_OWNER_USER_ID`, and only with `HUB_PRICES_POSITIONS` on | Another user's positions stay unpriced → blind → the Risk Wall rejects that user's entries (`UNPRICED_POSITION`); fail closed |
| D8 | §4.1 `vehicle.OPTIONS_BUY.premiumStopPct` and a generic `stop` block | Which price the `stop`/`target`/`trail` blocks apply to for options is undefined | O3 / L6 |
| D9 | §4.1 `timeExit.holdDays { n }` | No counting rule | O5 |
| D10 | §6.5 "strike and expiry chosen by the version's vehicle block" | M3: "picker is M4/M5"; the in-memory master is token-lookup only | The opener (M5) passes a resolved contract + expiry; M4 does not pick strikes |
| D11 | §4.1 `stop.atr` "ATR 14 / 5m" | Needs candles at entry (historical lane) | The opener passes `atr`; `resolveStopPct` is exported so M5's intent and M4's plan agree |
| D12 | §5.1 conflict rule by symbol/underlying | M3 provider reports `underlying = instrument.underlying ?? instrument.symbol` (e.g. `RELIANCE-EQ`), which never equals an intent's `RELIANCE` | Positions store `intent.underlying`; L19 |
| D13 | §7.2 owner `core:<positionId>` | Matcher uses `core-order:<id>` | Both owners coexist; the hub registry is keyed by ref, one slot per ref |
| D14 | §8.1 journal rows for every transition | `core_journal` is M5 | Port with logging default (O6, L12) |
| D15 | §7.4 "turning a hit target into a trailing stop" | No block expresses it | Only the guard `canConvertTargetToTrail` ships, for SP3/SP4 |

## Load on the production VPS (1 vCPU / 2 GB, ~30 feed slots, 350 ms historical pacing)

- **Feed slots:** +1 P0 slot per open core position (shared with the matcher's watch on the same ref; the hub
  registry is per ref) and +1 P1 per option position with an underlying stop. Bounded by `maxOpenPositions`
  (seeded 5 overall). P0 beyond the live cap is priced by the hub's REST QuotePoller under the Governor
  (`criticalOverflow`), which competes with the silos' P0 positions — watch `/healthz/detail → hub.slots`.
- **Historical lane:** none in M4 (ATR is passed in; M5 measures it).
- **CPU:** a 1 s sweep and per-push evaluation are O(active positions), in memory; the daily-loss monitor runs
  every 5 s per user with active positions.
- **DB:** per active position, one order re-read every 5 s, at most one coalesced mark write per second while
  trailing, and a handful of writes per exit. The daily-loss monitor reads the user's ledger and orders (full
  history, as M3's `funds`/`dayStats` do) every 5 s: fine at paper volume; M5 should add a day-bounded query if a
  user's ledger grows past a few thousand rows (noted for M5).
- **RAM:** one small object per active position. With nothing open in production (dark until M5) the cost is two
  idle timers.

## Parallel streams (worktrees)

| Stream | Tasks | Worktree / branch | Depends on | Files it owns |
|---|---|---|---|---|
| **A — rules (pure)** | 1, 2, 3, 4 | `.claude/worktrees/sp2-m4-rules` / `feature/sp2-m4-rules` | `main` | `trade-core/lifecycle/{lifecycle.types,position-state,exit-plan,stop-rules,exit-decision}.ts` + specs, `lifecycle/testing/lifecycle-fixtures.ts` |
| **B — store + execution seams** | 5, 6, 7 | `.claude/worktrees/sp2-m4-store` / `feature/sp2-m4-store` | `main` (Tasks 5 and 7 import `lifecycle.types.ts`, and Task 7's spec the `cashPlan` fixture: B copies Task 1's Step 1 file verbatim and starts Task 7 after A's Task 2 is merged, or runs A first — A is four small pure tasks) | `prisma/*`, `test/sp2-m4/*`, `tenant.constants.ts`, `trade-core/execution/*`, one provider line in `trade-core.module.ts` (Task 6), `lifecycle/lifecycle-defaults.spec.ts`, `lifecycle/repositories/*`, `lifecycle/testing/memory-position-store.ts` |
| join | — | `feature/sp2-m4-lifecycle` | A + B | merge A and B (no shared files except `lifecycle.types.ts`, identical) |
| **C — lifecycle service** | 8, 9, 10 | `.claude/worktrees/sp2-m4-service` | join | `lifecycle/core-lifecycle.service.ts`, `lifecycle/lifecycle-events.ts`, `lifecycle/testing/lifecycle-harness.ts` + specs |
| **D — risk seams** | 11, 12 | `.claude/worktrees/sp2-m4-risk` | join | `lifecycle/core-risk-state.provider.ts`, `lifecycle/core-square-off.ts`, `lifecycle/daily-loss.monitor.ts`, `lifecycle/lifecycle-ports.ts`, `common/audit/audit-actions.ts` + specs (D codes against the `LIFECYCLE_MARKS` / `CORE_POSITION_EXITS` ports with fakes) |
| **E — wiring + proof** | 13, 14 | `feature/sp2-m4-lifecycle` | C + D | `trade-core.module.ts`(+spec), controller + DTO, deletion of the M3 `paper-risk-state.provider.ts`, end-to-end specs, this plan's ledger |

C and D share no file. `lifecycle-ports.ts` (Task 11 Step 1) defines the two tokens; the lifecycle satisfies them
structurally and is bound to them in Task 13, so C never imports it. Suggested order: A ∥ B (B's Task 7 after A's
Task 2) → join → C ∥ D → E. Each stream commits with explicit pathspecs on its own branch; the controller merges.
Critical path: A (4 small tasks) → B Task 7 → C (3 tasks) → E (2 tasks).

## File Structure

| Path | Responsibility |
|---|---|
| Create `apps/api/src/modules/trade-core/lifecycle/lifecycle.types.ts` | Position status, exit reasons + priority, `ExitPlan`, `CorePosition`, rows, events |
| Create `apps/api/src/modules/trade-core/lifecycle/position-state.ts` | `reducePosition`, `canMove` (pure) |
| Create `apps/api/src/modules/trade-core/lifecycle/exit-plan.ts` | `resolveStopPct`, `resolveTargetPct`, `buildExitPlan`, `armLevels`, `round2` (pure) |
| Create `apps/api/src/modules/trade-core/lifecycle/stop-rules.ts` | `tightenStop`, `trailDistance`, `advanceMarks`, `canConvertTargetToTrail` (pure) |
| Create `apps/api/src/modules/trade-core/lifecycle/exit-decision.ts` | `decideExit`, `effectiveSquareOff`, `effectiveHoldDays`, `tradingDaysHeld` (pure) |
| Create `apps/api/src/modules/trade-core/lifecycle/testing/lifecycle-fixtures.ts` | Orders, plans, positions for the pure specs |
| Modify `prisma/schema.prisma` | `CorePosition`; `CoreOrder.positionId` + relation; `User.corePositions` |
| Create `prisma/migrations/20261012120000_sp2_m4_lifecycle/migration.sql` | Table, column, CHECKs, widened paper-default CHECKs, `blindAfterMs` seed |
| Modify `apps/api/src/common/tenant/tenant.constants.ts` | `'CorePosition'` |
| Create `apps/api/test/sp2-m4/jest.config.js`, `apps/api/test/sp2-m4/core-lifecycle.int.spec.ts` | Opt-in real-database test |
| Modify `apps/api/src/modules/trade-core/execution/paper-settings.ts` (+ spec) | Optional `blindAfterMs@ALL` |
| Create `apps/api/src/modules/trade-core/lifecycle/lifecycle-defaults.spec.ts` | The M4 seed row and widened CHECKs |
| Modify `apps/api/src/modules/trade-core/execution/execution.types.ts` | `positionId`; `onOrderUpdate`, `listPositionOrders` |
| Create `apps/api/src/modules/trade-core/execution/order-events.ts` (+ spec) | `CoreOrderEvents` emitter |
| Modify `apps/api/src/modules/trade-core/execution/repositories/core-order.repository.ts` | `positionId` mapping, `listForPositionId` |
| Modify `apps/api/src/modules/trade-core/execution/paper-ledger.service.ts` | Persist `positionId`, emit after commit, `listPositionOrders`, `netPnlTodayByPosition` |
| Modify `apps/api/src/modules/trade-core/execution/paper-execution.adapter.ts` | Delegate the two new interface methods |
| Modify `apps/api/src/modules/trade-core/execution/paper-order-square-off.ts` | Entry orders only |
| Modify `apps/api/src/modules/trade-core/execution/testing/memory-paper-store.ts` | `positionId`, `listForPositionId` |
| Modify `apps/api/src/modules/trade-core/execution/execution-ports.spec.ts` | Entries-only square-off expectations |
| Create `apps/api/src/modules/trade-core/execution/paper-ledger.events.spec.ts` | Emission, position orders, per-position P&L |
| Create `apps/api/src/modules/trade-core/lifecycle/repositories/core-position.repository.ts` | Positions (guarded updates, one active per instrument) |
| Create `apps/api/src/modules/trade-core/lifecycle/testing/memory-position-store.ts` (+ spec) | In-memory repository for service tests |
| Create `apps/api/src/modules/trade-core/lifecycle/lifecycle-events.ts` | `LIFECYCLE_EVENT_SINK`, logging sink |
| Create `apps/api/src/modules/trade-core/lifecycle/core-lifecycle.service.ts` | Open, order updates, prices, sweep, exits, blind, recovery, guard rails |
| Create `apps/api/src/modules/trade-core/lifecycle/testing/lifecycle-harness.ts` | Real ledger + matcher + adapter + lifecycle over memory stores and a fake hub |
| Create `apps/api/src/modules/trade-core/lifecycle/core-lifecycle.open.spec.ts`, `.exits.spec.ts`, `.recovery.spec.ts` | Service tests |
| Create `apps/api/src/modules/trade-core/lifecycle/lifecycle-ports.ts` | `LIFECYCLE_MARKS`, `CORE_POSITION_EXITS` |
| Create `apps/api/src/modules/trade-core/lifecycle/core-risk-state.provider.ts` (+ spec) | `RISK_STATE_PROVIDER` binding |
| Create `apps/api/src/modules/trade-core/lifecycle/core-square-off.ts`, `daily-loss.monitor.ts` (+ specs) | `CORE_SQUARE_OFF` binding; daily-loss exits |
| Create `apps/api/src/modules/trade-core/lifecycle/controllers/core-positions.controller.ts` (+ spec), `lifecycle/dto/core-position.dto.ts` | GET positions, POST manual exit |
| Modify `apps/api/src/common/audit/audit-actions.ts` | `lifecycle` group |
| Modify `apps/api/src/modules/trade-core/trade-core.module.ts`, `trade-core.module.spec.ts` | Wiring; ports rebound |
| Delete `apps/api/src/modules/trade-core/execution/paper-risk-state.provider.ts` | Superseded by `CoreRiskStateProvider` (its describe block in `execution-ports.spec.ts` goes too) |
| Create `apps/api/src/modules/trade-core/lifecycle/lifecycle-e2e.spec.ts`, `lifecycle-tenant.spec.ts` | Replay, kill switch, daily loss, tenant isolation |

---

## Stream A — the rules (pure)

### Task 1: Lifecycle types and the position state machine

**Files:**
- Create: `apps/api/src/modules/trade-core/lifecycle/lifecycle.types.ts`
- Create: `apps/api/src/modules/trade-core/lifecycle/position-state.ts`
- Create: `apps/api/src/modules/trade-core/lifecycle/testing/lifecycle-fixtures.ts`
- Test: `apps/api/src/modules/trade-core/lifecycle/position-state.spec.ts`

**Interfaces:**
- Consumes: `CoreOrder`, `CoreInstrument`, `OrderSide` (`execution/execution.types.ts`); `isOpenState` (`execution/order-state.ts`); `CorePositionState`, `Direction` (`risk-wall/risk-wall.types.ts`); `TrailBlock`, `PartialBlock`, `TimeExitBlock`, `Vehicle` (`strategies/blocks/block-types.ts`); `HubExchange` (`market-hub/hub.types.ts`).
- Produces: `CorePositionStatus`, `ACTIVE_STATUSES`, `isActiveStatus(s)`, `ExitReason`, `EXIT_REASONS`, `EXIT_PRIORITY`, `outranks(next, current)`, `entryKey(intentId)`, `exitKey(intentId, seq)`, `UnderlyingRef`, `OptionPlan`, `ExitPlan`, `CorePosition`, `NewPositionRow`, `PositionPatch`, `LifecycleEventType`, `LifecycleEvent`; `reducePosition(current, orders): PositionFacts`, `canMove(from, to)`; fixtures `NOW`, `order(over)`.

- [ ] **Step 1: Create the types file**

Create `apps/api/src/modules/trade-core/lifecycle/lifecycle.types.ts`:

```typescript
import type { HubExchange } from '../../market-hub/hub.types';
import type { CoreInstrument, OrderSide } from '../execution/execution.types';
import type { CorePositionState, Direction } from '../risk-wall/risk-wall.types';
import type { PartialBlock, TimeExitBlock, TrailBlock, Vehicle } from '../strategies/blocks/block-types';

/**
 * SP2 M4 lifecycle contracts (spec §7). A core position is one entry intent's life:
 * PENDING_ENTRY → OPEN → PARTIAL → EXITING → CLOSED, or → CANCELLED when nothing of the
 * entry filled. Quantities come from the position's own core_orders (reducePosition);
 * the row keeps the plan frozen at entry and the marks the rules need.
 */
export type CorePositionStatus = CorePositionState | 'CLOSED' | 'CANCELLED';

export const POSITION_STATUSES: readonly CorePositionStatus[] = ['PENDING_ENTRY', 'OPEN', 'PARTIAL', 'EXITING', 'CLOSED', 'CANCELLED'];
export const ACTIVE_STATUSES: readonly CorePositionState[] = ['PENDING_ENTRY', 'OPEN', 'PARTIAL', 'EXITING'];

export function isActiveStatus(s: string): s is CorePositionState {
  return (ACTIVE_STATUSES as readonly string[]).includes(s);
}

export const EXIT_REASONS = [
  'KILL_SWITCH',
  'DAILY_LOSS',
  'STOP',
  'GAP_STOP',
  'RECOVERY_STOP',
  'UNDERLYING_STOP',
  'GUARD_RAIL',
  'MANUAL',
  'TARGET',
  'TRAIL',
  'TIME_EXIT',
  'THETA_STOP',
  'EXPIRY_DAY',
  'HOLD_LIMIT',
  'SQUARE_OFF',
] as const;
export type ExitReason = (typeof EXIT_REASONS)[number];

/** Spec §7.3: lower runs first. GUARD_RAIL and MANUAL are explicit requests ranked with the stop. */
export const EXIT_PRIORITY: Readonly<Record<ExitReason, number>> = {
  KILL_SWITCH: 1,
  DAILY_LOSS: 2,
  STOP: 3,
  GAP_STOP: 3,
  RECOVERY_STOP: 3,
  UNDERLYING_STOP: 3,
  GUARD_RAIL: 3,
  MANUAL: 3,
  TARGET: 4,
  TRAIL: 5,
  TIME_EXIT: 6,
  THETA_STOP: 6,
  EXPIRY_DAY: 6,
  HOLD_LIMIT: 6,
  SQUARE_OFF: 7,
};

/** A later decision replaces the recorded reason only when it ranks strictly higher. */
export function outranks(next: ExitReason, current: ExitReason | null): boolean {
  return current === null || EXIT_PRIORITY[next] < EXIT_PRIORITY[current];
}

/** Order idempotency keys (M3 notes: entries are `${intentId}:entry`). */
export const entryKey = (intentId: string): string => `${intentId}:entry`;
export const exitKey = (intentId: string, seq: number): string => `${intentId}:exit:${seq}`;

export interface UnderlyingRef {
  exchange: HubExchange;
  token: string;
  symbol: string;
}

/** OPTIONS_BUY rules frozen at entry (spec §7.5; owner decision O3: premium-based). */
export interface OptionPlan {
  optionType: 'CE' | 'PE';
  /** IST date, YYYY-MM-DD. */
  expiry: string;
  premiumStopPct: number;
  thetaStop: { minMovePct: number; withinMinutes: number };
  expiryDayExitHhmm: string;
  /** Present only with underlyingStopPrice: the underlying is watched at priority 1. */
  underlyingRef: UnderlyingRef | null;
  underlyingStopPrice: number | null;
}

/** The exit rules frozen at entry (spec §7.1). Percent fields are percent of price. */
export interface ExitPlan {
  version: 1;
  vehicle: Vehicle;
  /** The entry side; exits use the opposite side. */
  side: OrderSide;
  /** Initial stop distance from the entry average, %. */
  stopPct: number;
  /** Target distance from the entry average, %. */
  targetPct: number;
  trail: TrailBlock;
  partial: PartialBlock;
  timeExit: TimeExitBlock;
  /** ATR measured at entry, in price units (the stop and the ATR trail use it); null when none. */
  atr: number | null;
  /** squareOffTime@vehicle from the verdict's limits snapshot (HH:MM IST). */
  squareOffHhmm: string;
  /** mtfMaxHoldDays from the snapshot; null for other vehicles. */
  mtfMaxHoldDays: number | null;
  /** IST date the position was opened. */
  entryDay: string;
  option: OptionPlan | null;
}

export interface CorePosition {
  id: string;
  userId: string;
  /** Unique; the corpus sourceId for source 'core' (ruling L13). */
  intentId: string;
  strategyId: string;
  strategyVersionId: string;
  vehicle: Vehicle;
  instrument: CoreInstrument;
  /** The exposure underlying the Risk Wall compares (the intent's underlying). */
  underlying: string;
  side: OrderSide;
  direction: Direction;
  status: CorePositionStatus;
  requestedQty: number;
  entryFilledQty: number;
  exitFilledQty: number;
  /** entryFilledQty − exitFilledQty. */
  openQty: number;
  entryAvgPrice: number | null;
  plan: ExitPlan;
  initialStopPrice: number | null;
  stopPrice: number | null;
  targetPrice: number | null;
  partialPrice: number | null;
  partialQty: number;
  trailActive: boolean;
  partialDone: boolean;
  /** Best and worst traded price seen while open (MFE / MAE for M5). */
  highWater: number | null;
  lowWater: number | null;
  /** The last exit sequence claimed (0 = none). */
  exitSeq: number;
  exitReason: ExitReason | null;
  blindSince: Date | null;
  openedAt: Date | null;
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

export interface NewPositionRow {
  userId: string;
  intentId: string;
  strategyId: string;
  strategyVersionId: string;
  vehicle: Vehicle;
  instrument: CoreInstrument;
  underlying: string;
  side: OrderSide;
  direction: Direction;
  requestedQty: number;
  plan: ExitPlan;
}

export type PositionPatch = Partial<
  Pick<
    CorePosition,
    | 'status'
    | 'entryFilledQty'
    | 'exitFilledQty'
    | 'entryAvgPrice'
    | 'initialStopPrice'
    | 'stopPrice'
    | 'targetPrice'
    | 'partialPrice'
    | 'partialQty'
    | 'trailActive'
    | 'partialDone'
    | 'highWater'
    | 'lowWater'
    | 'exitSeq'
    | 'exitReason'
    | 'blindSince'
    | 'openedAt'
    | 'closedAt'
  >
>;

/** Spec §8.1 journal types the lifecycle produces (M5 persists them; ruling L12). */
export const LIFECYCLE_EVENT_TYPES = ['POSITION_STATE', 'STOP_MOVED', 'EXIT_DECIDED', 'BLIND', 'RECOVERY_STOP'] as const;
export type LifecycleEventType = (typeof LIFECYCLE_EVENT_TYPES)[number];

export interface LifecycleEvent {
  type: LifecycleEventType;
  userId: string;
  positionId: string;
  strategyVersionId: string;
  payload: Record<string, unknown>;
  priceUsed: number | null;
  priceAgeMs: number | null;
  at: Date;
}
```

- [ ] **Step 2: Write the failing test and its fixture**

Create `apps/api/src/modules/trade-core/lifecycle/testing/lifecycle-fixtures.ts`:

```typescript
import type { CoreOrder } from '../../execution/execution.types';

/** Test data only. Mon 2026-10-12 10:30 IST (the M2/M3 fixtures' NOW). */
export const NOW = new Date('2026-10-12T05:00:00.000Z');

let seq = 0;

/** A cash BUY entry order of position pos_1, open and unfilled unless overridden. */
export function order(over: Partial<CoreOrder> = {}): CoreOrder {
  seq += 1;
  return {
    id: `ord_${seq}`,
    userId: 'user_A',
    idempotencyKey: `int_1:k${seq}`,
    vehicle: 'CASH_INTRADAY',
    instrument: { exchange: 'NSE', token: '2885', symbol: 'RELIANCE-EQ', lotSize: 1, underlying: null },
    side: 'BUY',
    qty: 100,
    filledQty: 0,
    avgFillPrice: null,
    type: 'MARKET',
    limitPrice: null,
    triggerPrice: null,
    refPrice: 500,
    purpose: 'ENTRY',
    strategyVersionId: 'csv_ungated_v1',
    state: 'OPEN',
    rejectReason: null,
    submittedAt: NOW,
    triggeredAt: null,
    updatedAt: NOW,
    positionId: 'pos_1',
    ...over,
  };
}
```

(`positionId` joins `CoreOrder` in Task 6. Stream A runs under `ts-jest` `isolatedModules`, which does not typecheck; the joined branch typechecks it in Task 14.)

Create `apps/api/src/modules/trade-core/lifecycle/position-state.spec.ts`:

```typescript
import { canMove, reducePosition } from './position-state';
import { order } from './testing/lifecycle-fixtures';

const exitOrder = (over: Parameters<typeof order>[0] = {}) => order({ purpose: 'EXIT', side: 'SELL', ...over });

describe('reducePosition (spec §7.1)', () => {
  it('an entry not yet filled is PENDING_ENTRY', () => {
    const f = reducePosition('PENDING_ENTRY', [order()]);
    expect(f).toMatchObject({ status: 'PENDING_ENTRY', entryFilledQty: 0, openQty: 0, entryAvgPrice: null });
    expect(f.openEntry?.purpose).toBe('ENTRY');
  });

  it('a filled entry is OPEN with its average price', () => {
    expect(reducePosition('PENDING_ENTRY', [order({ state: 'FILLED', filledQty: 100, avgFillPrice: 500.25 })])).toMatchObject({
      status: 'OPEN',
      entryFilledQty: 100,
      openQty: 100,
      entryAvgPrice: 500.25,
      openEntry: null,
    });
  });

  it('a partly filled entry that is still open is OPEN for the filled part', () => {
    const f = reducePosition('PENDING_ENTRY', [order({ state: 'PARTIAL', filledQty: 40, avgFillPrice: 500 })]);
    expect(f).toMatchObject({ status: 'OPEN', openQty: 40 });
    expect(f.openEntry?.filledQty).toBe(40);
  });

  it('an entry rejected or cancelled with nothing filled is CANCELLED', () => {
    expect(reducePosition('PENDING_ENTRY', [order({ state: 'REJECTED', rejectReason: 'no fresh price' })]).status).toBe('CANCELLED');
    expect(reducePosition('PENDING_ENTRY', [order({ state: 'CANCELLED' })]).status).toBe('CANCELLED');
  });

  it('a partly filled exit makes it PARTIAL; all exits filled and nothing open is CLOSED', () => {
    const entry = order({ state: 'FILLED', filledQty: 100, avgFillPrice: 500 });
    const half = exitOrder({ qty: 50, state: 'FILLED', filledQty: 50, avgFillPrice: 505 });
    expect(reducePosition('OPEN', [entry, half])).toMatchObject({ status: 'PARTIAL', openQty: 50, exitFilledQty: 50, pendingExitQty: 0 });
    const rest = exitOrder({ qty: 50, state: 'FILLED', filledQty: 50, avgFillPrice: 503 });
    expect(reducePosition('PARTIAL', [entry, half, rest])).toMatchObject({ status: 'CLOSED', openQty: 0 });
  });

  it('counts the unfilled quantity of open exit orders as pending', () => {
    const entry = order({ state: 'FILLED', filledQty: 100, avgFillPrice: 500 });
    const f = reducePosition('EXITING', [entry, exitOrder({ qty: 100, state: 'PARTIAL', filledQty: 30 })]);
    expect(f).toMatchObject({ status: 'EXITING', openQty: 70, pendingExitQty: 70 });
    expect(f.openExits).toHaveLength(1);
  });

  it('EXITING stays EXITING until flat, then CLOSED; an EXITING position whose entry never filled becomes CANCELLED', () => {
    const entry = order({ state: 'FILLED', filledQty: 100, avgFillPrice: 500 });
    expect(reducePosition('EXITING', [entry]).status).toBe('EXITING');
    expect(reducePosition('EXITING', [entry, exitOrder({ state: 'FILLED', filledQty: 100 })]).status).toBe('CLOSED');
    expect(reducePosition('EXITING', [order()]).status).toBe('EXITING');
    expect(reducePosition('EXITING', [order({ state: 'CANCELLED' })]).status).toBe('CANCELLED');
  });

  it('is not flat while the entry remainder is still open', () => {
    const entry = order({ state: 'PARTIAL', filledQty: 40, avgFillPrice: 500 });
    expect(reducePosition('EXITING', [entry, exitOrder({ qty: 40, state: 'FILLED', filledQty: 40 })]).status).toBe('EXITING');
  });

  it('a closed or cancelled position never moves', () => {
    expect(reducePosition('CLOSED', [order({ state: 'OPEN' })]).status).toBe('CLOSED');
    expect(reducePosition('CANCELLED', [order({ state: 'FILLED', filledQty: 100, avgFillPrice: 500 })]).status).toBe('CANCELLED');
  });

  it('exits filled beyond the entry are an error', () => {
    expect(() =>
      reducePosition('OPEN', [order({ state: 'FILLED', filledQty: 10, avgFillPrice: 500 }), exitOrder({ state: 'FILLED', filledQty: 20 })]),
    ).toThrow('exits filled 20 > entry filled 10');
  });
});

describe('canMove', () => {
  it('follows spec §7.1 and never leaves a terminal status', () => {
    expect(canMove('PENDING_ENTRY', 'OPEN')).toBe(true);
    expect(canMove('PENDING_ENTRY', 'CANCELLED')).toBe(true);
    expect(canMove('OPEN', 'PARTIAL')).toBe(true);
    expect(canMove('PARTIAL', 'EXITING')).toBe(true);
    expect(canMove('EXITING', 'CLOSED')).toBe(true);
    expect(canMove('OPEN', 'PENDING_ENTRY')).toBe(false);
    expect(canMove('PARTIAL', 'OPEN')).toBe(false);
    expect(canMove('CLOSED', 'OPEN')).toBe(false);
    expect(canMove('CANCELLED', 'OPEN')).toBe(false);
    expect(canMove('OPEN', 'OPEN')).toBe(true);
  });
});
```

- [ ] **Step 3: Run it to see it fail**

Run (from `apps/api`): `npx jest src/modules/trade-core/lifecycle/position-state.spec.ts`
Expected: FAIL, "Cannot find module './position-state'".

- [ ] **Step 4: Implement**

Create `apps/api/src/modules/trade-core/lifecycle/position-state.ts`:

```typescript
import type { CoreOrder } from '../execution/execution.types';
import { isOpenState } from '../execution/order-state';
import type { CorePositionStatus } from './lifecycle.types';

/** Spec §7.1. PENDING_ENTRY may jump ahead (a fill and an exit can land between two re-reads). */
const NEXT: Readonly<Record<CorePositionStatus, readonly CorePositionStatus[]>> = {
  PENDING_ENTRY: ['OPEN', 'PARTIAL', 'EXITING', 'CLOSED', 'CANCELLED'],
  OPEN: ['PARTIAL', 'EXITING', 'CLOSED'],
  PARTIAL: ['EXITING', 'CLOSED'],
  EXITING: ['CLOSED', 'CANCELLED'],
  CLOSED: [],
  CANCELLED: [],
};

export function canMove(from: CorePositionStatus, to: CorePositionStatus): boolean {
  return from === to || NEXT[from].includes(to);
}

export interface PositionFacts {
  status: CorePositionStatus;
  entryFilledQty: number;
  exitFilledQty: number;
  openQty: number;
  entryAvgPrice: number | null;
  /** The entry order while it can still fill. */
  openEntry: CoreOrder | null;
  openExits: CoreOrder[];
  /** The unfilled quantity of the open exit orders. */
  pendingExitQty: number;
}

/**
 * The position's quantities and status from its own orders (ruling L2): the order table
 * is the only source of quantities. EXITING is sticky (a decision, not a quantity) until
 * the position is flat with nothing open; terminal statuses never move.
 */
export function reducePosition(current: CorePositionStatus, orders: readonly CoreOrder[]): PositionFacts {
  const entry = orders.find((o) => o.purpose === 'ENTRY') ?? null;
  const exits = orders.filter((o) => o.purpose === 'EXIT');
  const entryFilledQty = entry?.filledQty ?? 0;
  const exitFilledQty = exits.reduce((n, o) => n + o.filledQty, 0);
  const openQty = entryFilledQty - exitFilledQty;
  if (openQty < 0) throw new Error(`exits filled ${exitFilledQty} > entry filled ${entryFilledQty}`);
  const openEntry = entry && isOpenState(entry.state) ? entry : null;
  const openExits = exits.filter((o) => isOpenState(o.state));
  const pendingExitQty = openExits.reduce((n, o) => n + o.qty - o.filledQty, 0);
  const facts = { entryFilledQty, exitFilledQty, openQty, entryAvgPrice: entry?.avgFillPrice ?? null, openEntry, openExits, pendingExitQty };
  return { ...facts, status: nextStatus(current, entry, facts) };
}

function nextStatus(
  current: CorePositionStatus,
  entry: CoreOrder | null,
  f: Pick<PositionFacts, 'entryFilledQty' | 'exitFilledQty' | 'openQty' | 'openEntry' | 'openExits'>,
): CorePositionStatus {
  if (current === 'CLOSED' || current === 'CANCELLED') return current;
  if (f.entryFilledQty === 0) return entry && !f.openEntry ? 'CANCELLED' : current;
  if (f.openQty === 0 && !f.openEntry && f.openExits.length === 0) return 'CLOSED';
  if (current === 'EXITING') return 'EXITING';
  return f.exitFilledQty > 0 ? 'PARTIAL' : 'OPEN';
}
```

- [ ] **Step 5: Run it to see it pass**

Run: `npx jest src/modules/trade-core/lifecycle/position-state.spec.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -- apps/api/src/modules/trade-core/lifecycle/lifecycle.types.ts apps/api/src/modules/trade-core/lifecycle/position-state.ts apps/api/src/modules/trade-core/lifecycle/position-state.spec.ts apps/api/src/modules/trade-core/lifecycle/testing/lifecycle-fixtures.ts
git commit -m "feat(trade-core): lifecycle types and the core position state machine" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/api/src/modules/trade-core/lifecycle/lifecycle.types.ts apps/api/src/modules/trade-core/lifecycle/position-state.ts apps/api/src/modules/trade-core/lifecycle/position-state.spec.ts apps/api/src/modules/trade-core/lifecycle/testing/lifecycle-fixtures.ts
```

---

### Task 2: The exit plan frozen at entry, and the levels armed from the fill

**Files:**
- Create: `apps/api/src/modules/trade-core/lifecycle/exit-plan.ts`
- Modify: `apps/api/src/modules/trade-core/lifecycle/testing/lifecycle-fixtures.ts` (append)
- Test: `apps/api/src/modules/trade-core/lifecycle/exit-plan.spec.ts`

**Interfaces:**
- Consumes: `ExitPlan`, `OptionPlan`, `UnderlyingRef` (Task 1); `StrategyBlocks`, `StopBlock`, `TargetBlock`, `Vehicle`; `LimitInForce`; `istDate` (`execution/ledger-math.ts`); test fixtures `adaptiveBlocks()`, `plainBlocks()` (`strategies/testing/block-fixtures.ts`), `limitsFixture()` (`risk-wall/testing/risk-fixtures.ts`, squareOffTime CASH 15:15 / MTF 15:20 / OPTIONS 15:15, mtfMaxHoldDays 10).
- Produces: `round2(n)`; `resolveStopPct(stop, refPrice, atr): number` (exported for M5's intent builder, drift D11); `resolveTargetPct(target, stopPct): number`; `OptionOpen`; `PlanInput`; `PlanResult`; `buildExitPlan(input): PlanResult`; `ArmedLevels`; `armLevels(plan, entryAvg, entryQty, lotSize): ArmedLevels`; fixtures `mtfBlocks()`, `optionBlocks()`, `cashPlan(over)`, `adaptivePlan(over)`, `mtfPlan(over)`, `optionPlan(over)`.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/modules/trade-core/lifecycle/testing/lifecycle-fixtures.ts` (move the imports to the top of the file):

```typescript
import { limitsFixture } from '../../risk-wall/testing/risk-fixtures';
import type { StrategyBlocks } from '../../strategies/blocks/block-types';
import { adaptiveBlocks, plainBlocks } from '../../strategies/testing/block-fixtures';
import { buildExitPlan, type PlanInput } from '../exit-plan';
import type { ExitPlan } from '../lifecycle.types';

export function mtfBlocks(): StrategyBlocks {
  return { ...plainBlocks(), vehicle: { kind: 'MTF' }, timeExit: { kind: 'holdDays', n: 3 } };
}

/** A NIFTY CE buyer: 30 % stop on the premium, capped by the 25 % premium stop; 50 % target. */
export function optionBlocks(): StrategyBlocks {
  return {
    ...plainBlocks(),
    stop: { kind: 'fixedPct', pct: 30 },
    target: { kind: 'fixedPct', pct: 50 },
    timeExit: { kind: 'clock', hhmm: '15:00' },
    vehicle: {
      kind: 'OPTIONS_BUY',
      strike: 'ATM',
      minDaysToExpiry: 2,
      premiumStopPct: 25,
      thetaStop: { minMovePct: 10, withinMinutes: 30 },
      expiryDayExitHhmm: '14:30',
    },
  };
}

function planOf(input: Partial<PlanInput> & Pick<PlanInput, 'blocks' | 'vehicle'>, over: Partial<ExitPlan>): ExitPlan {
  const r = buildExitPlan({ side: 'BUY', refPrice: 500, atr: null, limits: limitsFixture(), option: null, now: NOW, ...input });
  if (!r.ok) throw new Error(r.error);
  return { ...r.plan, ...over };
}

/** Ungated-shaped cash plan: stop 1.5 %, target 3 %, no trail, clock exit 15:25, square-off 15:15. */
export const cashPlan = (over: Partial<ExitPlan> = {}): ExitPlan => planOf({ blocks: plainBlocks(), vehicle: 'CASH_INTRADAY' }, over);
/** Adaptive-shaped cash plan with ATR 5 at a 500 reference: stop 1.2 %, target 2 %, half at +1 %, ATR trail after it. */
export const adaptivePlan = (over: Partial<ExitPlan> = {}): ExitPlan => planOf({ blocks: adaptiveBlocks(), vehicle: 'CASH_INTRADAY', atr: 5 }, over);
/** MTF: stop 1.5 %, target 3 %, time exit after 3 trading days, hold limit 10, square-off 15:20. */
export const mtfPlan = (over: Partial<ExitPlan> = {}): ExitPlan => planOf({ blocks: mtfBlocks(), vehicle: 'MTF' }, over);
/** CE at a 100 premium expiring Thu 2026-10-15: stop 25 %, target 50 %, theta 10 % in 30 min, out by 14:30 on expiry day. */
export const optionPlan = (over: Partial<ExitPlan> = {}): ExitPlan =>
  planOf(
    {
      blocks: optionBlocks(),
      vehicle: 'OPTIONS_BUY',
      refPrice: 100,
      option: { optionType: 'CE', expiry: '2026-10-15', underlyingRef: null, underlyingStopPrice: null },
    },
    over,
  );
```

Create `apps/api/src/modules/trade-core/lifecycle/exit-plan.spec.ts`:

```typescript
import { limitsFixture } from '../risk-wall/testing/risk-fixtures';
import { adaptiveBlocks, plainBlocks } from '../strategies/testing/block-fixtures';
import { armLevels, buildExitPlan, resolveStopPct, resolveTargetPct, type PlanInput } from './exit-plan';
import { adaptivePlan, cashPlan, mtfBlocks, NOW, optionBlocks, optionPlan } from './testing/lifecycle-fixtures';

const atrStop = { kind: 'atr', period: 14, timeframe: '5m', multiple: 1.2, minPct: 0.8, maxPct: 2.5 } as const;

function input(over: Partial<PlanInput> = {}): PlanInput {
  return { blocks: plainBlocks(), vehicle: 'CASH_INTRADAY', side: 'BUY', refPrice: 500, atr: null, limits: limitsFixture(), option: null, now: NOW, ...over };
}

describe('resolveStopPct / resolveTargetPct (spec §4.1)', () => {
  it('a fixed stop is its percent', () => {
    expect(resolveStopPct({ kind: 'fixedPct', pct: 1.5 }, 500, null)).toBe(1.5);
  });

  it('an ATR stop is multiple × ATR as a percent of the reference, clamped to [minPct, maxPct]', () => {
    expect(resolveStopPct(atrStop, 500, 5)).toBeCloseTo(1.2, 10);
    expect(resolveStopPct(atrStop, 500, 3)).toBe(0.8);
    expect(resolveStopPct(atrStop, 500, 20)).toBe(2.5);
  });

  it('an ATR stop without a usable ATR is the floor (the silo rule, adaptive-stop-math.ts resolveStop)', () => {
    expect(resolveStopPct(atrStop, 500, null)).toBe(0.8);
    expect(resolveStopPct(atrStop, 500, 0)).toBe(0.8);
  });

  it('a target is a percent, or a reward:risk multiple of the stop', () => {
    expect(resolveTargetPct({ kind: 'fixedPct', pct: 2 }, 1.5)).toBe(2);
    expect(resolveTargetPct({ kind: 'rr', ratio: 2 }, 1.5)).toBe(3);
  });
});

describe('buildExitPlan', () => {
  it('freezes the blocks, the ATR and the snapshot limits', () => {
    const r = buildExitPlan(input({ blocks: adaptiveBlocks(), atr: 5 }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan).toMatchObject({
      version: 1,
      vehicle: 'CASH_INTRADAY',
      side: 'BUY',
      targetPct: 2,
      trail: { kind: 'atr', multiple: 1, minPct: 0.6, maxPct: 1.5, startsAfter: 'PARTIAL' },
      partial: { kind: 'atTarget1', fraction: 0.5, atPct: 1 },
      timeExit: { kind: 'clock', hhmm: '15:15' },
      atr: 5,
      squareOffHhmm: '15:15',
      mtfMaxHoldDays: null,
      entryDay: '2026-10-12',
      option: null,
    });
    expect(r.plan.stopPct).toBeCloseTo(1.2, 10);
  });

  it('MTF freezes mtfMaxHoldDays and its square-off time', () => {
    const r = buildExitPlan(input({ blocks: mtfBlocks(), vehicle: 'MTF' }));
    expect(r.ok && r.plan).toMatchObject({ squareOffHhmm: '15:20', mtfMaxHoldDays: 10, timeExit: { kind: 'holdDays', n: 3 } });
  });

  it('options: the stop is the tighter of the stop block and the premium stop (O3), and the contract is frozen', () => {
    const p = optionPlan();
    expect(p.stopPct).toBe(25);
    expect(p.targetPct).toBe(50);
    expect(p.option).toEqual({
      optionType: 'CE',
      expiry: '2026-10-15',
      premiumStopPct: 25,
      thetaStop: { minMovePct: 10, withinMinutes: 30 },
      expiryDayExitHhmm: '14:30',
      underlyingRef: null,
      underlyingStopPrice: null,
    });
  });

  it('fails closed on what it cannot plan', () => {
    const err = (over: Partial<PlanInput>) => {
      const r = buildExitPlan(input(over));
      return r.ok ? null : r.error;
    };
    const ce = { optionType: 'CE' as const, expiry: '2026-10-15', underlyingRef: null, underlyingStopPrice: null };
    expect(err({ vehicle: 'MTF' })).toBe('the version trades CASH_INTRADAY, not MTF');
    expect(err({ limits: limitsFixture({ 'squareOffTime@CASH_INTRADAY': null }) })).toBe('squareOffTime@CASH_INTRADAY is missing from the limits snapshot');
    expect(err({ blocks: mtfBlocks(), vehicle: 'MTF', limits: limitsFixture({ 'mtfMaxHoldDays@MTF': null }) })).toBe('mtfMaxHoldDays@MTF is missing from the limits snapshot');
    expect(err({ blocks: optionBlocks(), vehicle: 'OPTIONS_BUY' })).toBe('an OPTIONS_BUY position needs its contract (optionType, expiry)');
    expect(err({ option: ce })).toBe('only OPTIONS_BUY takes an option contract');
    expect(err({ blocks: optionBlocks(), vehicle: 'OPTIONS_BUY', option: { ...ce, underlyingStopPrice: 24900 } })).toBe(
      'an underlying stop needs both underlyingRef and underlyingStopPrice',
    );
    expect(err({ blocks: optionBlocks(), vehicle: 'OPTIONS_BUY', side: 'SELL', option: ce })).toBe('options are bought only');
    expect(err({ refPrice: 0 })).toBe('refPrice must be above 0');
    expect(err({ atr: -1 })).toBe('atr must be a number of 0 or more, or null');
  });
});

describe('armLevels (ruling L4)', () => {
  it('BUY: stop below, target and partial above the entry average; the partial quantity in whole lots', () => {
    expect(armLevels(adaptivePlan(), 500, 100, 1)).toEqual({ stopPrice: 494, targetPrice: 510, partialPrice: 505, partialQty: 50 });
  });

  it('SELL mirrors it', () => {
    expect(armLevels(cashPlan({ side: 'SELL' }), 500, 100, 1)).toEqual({ stopPrice: 507.5, targetPrice: 485, partialPrice: null, partialQty: 0 });
  });

  it('a partial that rounds to zero lots, or to everything, keeps its level but sells nothing', () => {
    expect(armLevels(adaptivePlan(), 500, 1, 1)).toMatchObject({ partialPrice: 505, partialQty: 0 });
    expect(armLevels(adaptivePlan(), 100, 75, 75)).toMatchObject({ partialQty: 0 });
  });

  it('options arm on the premium', () => {
    expect(armLevels(optionPlan(), 100, 75, 75)).toEqual({ stopPrice: 75, targetPrice: 150, partialPrice: null, partialQty: 0 });
  });

  it('rounds to the paisa', () => {
    expect(armLevels(cashPlan(), 333.33, 10, 1).stopPrice).toBe(328.33);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx jest src/modules/trade-core/lifecycle/exit-plan.spec.ts`
Expected: FAIL, "Cannot find module '../exit-plan'" (from the fixture) or "'./exit-plan'".

- [ ] **Step 3: Implement**

Create `apps/api/src/modules/trade-core/lifecycle/exit-plan.ts`:

```typescript
import type { OrderSide } from '../execution/execution.types';
import { istDate } from '../execution/ledger-math';
import type { LimitInForce } from '../risk-wall/risk-wall.types';
import type { StopBlock, StrategyBlocks, TargetBlock, Vehicle } from '../strategies/blocks/block-types';
import type { ExitPlan, OptionPlan, UnderlyingRef } from './lifecycle.types';

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Half-up to the paisa. */
export const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * The initial stop distance, % of the reference price (spec §4.1). The ATR form is the
 * silo's rule (adaptive-stop-math.ts resolveStop): multiple × ATR, floored at minPct (also
 * when there is no usable ATR) and capped at maxPct. Exported so M5's
 * CoreEntryIntent.stopPrice and this plan agree (drift D11).
 */
export function resolveStopPct(stop: StopBlock, refPrice: number, atr: number | null): number {
  if (stop.kind === 'fixedPct') return stop.pct;
  const dist = finite(atr) && atr > 0 ? stop.multiple * atr : 0;
  const pct = refPrice > 0 ? (dist / refPrice) * 100 : 0;
  if (!(pct > 0) || pct < stop.minPct) return stop.minPct;
  return pct > stop.maxPct ? stop.maxPct : pct;
}

export function resolveTargetPct(target: TargetBlock, stopPct: number): number {
  return target.kind === 'fixedPct' ? target.pct : target.ratio * stopPct;
}

/** The contract M5 resolved (drift D10): M4 never picks strikes. */
export interface OptionOpen {
  optionType: 'CE' | 'PE';
  /** IST date, YYYY-MM-DD. */
  expiry: string;
  underlyingRef: UnderlyingRef | null;
  underlyingStopPrice: number | null;
}

export interface PlanInput {
  blocks: StrategyBlocks;
  vehicle: Vehicle;
  side: OrderSide;
  refPrice: number;
  atr: number | null;
  /** The verdict's limits snapshot. */
  limits: readonly LimitInForce[];
  option: OptionOpen | null;
  now: Date;
}

export type PlanResult = { ok: true; plan: ExitPlan } | { ok: false; error: string };

const fail = (error: string): PlanResult => ({ ok: false, error });
const limitValue = (limits: readonly LimitInForce[], key: string, scope: string): string | null =>
  limits.find((l) => l.key === key && l.scope === scope)?.value ?? null;

/** Spec §7.1: the exit rules, frozen at entry. Fails closed on anything it cannot plan. */
export function buildExitPlan(i: PlanInput): PlanResult {
  const b = i.blocks;
  if (b.vehicle.kind !== i.vehicle) return fail(`the version trades ${b.vehicle.kind}, not ${i.vehicle}`);
  if (!finite(i.refPrice) || i.refPrice <= 0) return fail('refPrice must be above 0');
  if (i.atr !== null && (!finite(i.atr) || i.atr < 0)) return fail('atr must be a number of 0 or more, or null');
  const squareOffHhmm = limitValue(i.limits, 'squareOffTime', i.vehicle);
  if (squareOffHhmm === null || !HHMM.test(squareOffHhmm)) return fail(`squareOffTime@${i.vehicle} is missing from the limits snapshot`);
  let mtfMaxHoldDays: number | null = null;
  if (i.vehicle === 'MTF') {
    const n = Number(limitValue(i.limits, 'mtfMaxHoldDays', 'MTF') ?? Number.NaN);
    if (!Number.isSafeInteger(n) || n < 1) return fail('mtfMaxHoldDays@MTF is missing from the limits snapshot');
    mtfMaxHoldDays = n;
  }
  let stopPct = resolveStopPct(b.stop, i.refPrice, i.atr);
  let option: OptionPlan | null = null;
  if (b.vehicle.kind === 'OPTIONS_BUY') {
    const o = i.option;
    if (!o) return fail('an OPTIONS_BUY position needs its contract (optionType, expiry)');
    if (i.side !== 'BUY') return fail('options are bought only');
    if (o.optionType !== 'CE' && o.optionType !== 'PE') return fail('optionType must be CE or PE');
    if (!DAY.test(o.expiry)) return fail('option expiry must be YYYY-MM-DD');
    if ((o.underlyingRef === null) !== (o.underlyingStopPrice === null)) return fail('an underlying stop needs both underlyingRef and underlyingStopPrice');
    if (o.underlyingStopPrice !== null && !(finite(o.underlyingStopPrice) && o.underlyingStopPrice > 0)) return fail('underlyingStopPrice must be above 0');
    stopPct = Math.min(stopPct, b.vehicle.premiumStopPct);
    option = {
      optionType: o.optionType,
      expiry: o.expiry,
      premiumStopPct: b.vehicle.premiumStopPct,
      thetaStop: { ...b.vehicle.thetaStop },
      expiryDayExitHhmm: b.vehicle.expiryDayExitHhmm,
      underlyingRef: o.underlyingRef ? { ...o.underlyingRef } : null,
      underlyingStopPrice: o.underlyingStopPrice,
    };
  } else if (i.option) {
    return fail('only OPTIONS_BUY takes an option contract');
  }
  if (!(stopPct > 0)) return fail('the stop distance must be above 0');
  return {
    ok: true,
    plan: {
      version: 1,
      vehicle: i.vehicle,
      side: i.side,
      stopPct,
      targetPct: resolveTargetPct(b.target, stopPct),
      trail: b.trail,
      partial: b.partial,
      timeExit: b.timeExit,
      atr: i.atr,
      squareOffHhmm,
      mtfMaxHoldDays,
      entryDay: istDate(i.now),
      option,
    },
  };
}

export interface ArmedLevels {
  stopPrice: number;
  targetPrice: number;
  /** The target-1 level (it also starts a trail that waits for the partial); null without a partial block. */
  partialPrice: number | null;
  /** Whole lots to sell at the partial; 0 when that would be nothing or everything. */
  partialQty: number;
}

/** Ruling L4: the levels from the entry average. */
export function armLevels(plan: ExitPlan, entryAvg: number, entryQty: number, lotSize: number): ArmedLevels {
  const dir = plan.side === 'BUY' ? 1 : -1;
  const at = (pct: number) => round2(entryAvg * (1 + (dir * pct) / 100));
  const stopPrice = round2(entryAvg * (1 - (dir * plan.stopPct) / 100));
  const targetPrice = at(plan.targetPct);
  if (plan.partial.kind === 'none') return { stopPrice, targetPrice, partialPrice: null, partialQty: 0 };
  const lots = Math.floor((entryQty * plan.partial.fraction) / lotSize) * lotSize;
  return { stopPrice, targetPrice, partialPrice: at(plan.partial.atPct), partialQty: lots > 0 && lots < entryQty ? lots : 0 };
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `npx jest src/modules/trade-core/lifecycle/exit-plan.spec.ts`
Expected: PASS. (`333.33 × 0.985 = 328.33005 → 328.33`; adaptive stop `500 × (1 − 0.012) = 494`.)

- [ ] **Step 5: Commit**

```bash
git add -- apps/api/src/modules/trade-core/lifecycle/exit-plan.ts apps/api/src/modules/trade-core/lifecycle/exit-plan.spec.ts apps/api/src/modules/trade-core/lifecycle/testing/lifecycle-fixtures.ts
git commit -m "feat(trade-core): exit plan frozen at entry and levels armed from the fill" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/api/src/modules/trade-core/lifecycle/exit-plan.ts apps/api/src/modules/trade-core/lifecycle/exit-plan.spec.ts apps/api/src/modules/trade-core/lifecycle/testing/lifecycle-fixtures.ts
```

---

### Task 3: Tighten-only stops, the breakeven and ATR trails, the target→trail guard

**Files:**
- Create: `apps/api/src/modules/trade-core/lifecycle/stop-rules.ts`
- Test: `apps/api/src/modules/trade-core/lifecycle/stop-rules.spec.ts`

**Interfaces:**
- Consumes: `ExitPlan` (Task 1); `round2` (Task 2); fixtures `adaptivePlan`, `cashPlan` (Task 2).
- Produces: `tightenStop(current: number | null, proposed: number, side: OrderSide): { accepted: boolean; stop: number | null }`; `trailDistance(trail, extreme, atr): number`; `MarkInput`; `Marks`; `advanceMarks(m: MarkInput, ltp: number): Marks`; `canConvertTargetToTrail(p): boolean`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/modules/trade-core/lifecycle/stop-rules.spec.ts`:

```typescript
import { advanceMarks, canConvertTargetToTrail, tightenStop, trailDistance, type MarkInput } from './stop-rules';
import { adaptivePlan, cashPlan } from './testing/lifecycle-fixtures';

describe('tightenStop (spec §7.4: the one place a stop changes)', () => {
  it('a long accepts only a higher stop; a short only a lower one', () => {
    expect(tightenStop(494, 495, 'BUY')).toEqual({ accepted: true, stop: 495 });
    expect(tightenStop(494, 493, 'BUY')).toEqual({ accepted: false, stop: 494 });
    expect(tightenStop(494, 494, 'BUY')).toEqual({ accepted: false, stop: 494 });
    expect(tightenStop(507.5, 506, 'SELL')).toEqual({ accepted: true, stop: 506 });
    expect(tightenStop(507.5, 508, 'SELL')).toEqual({ accepted: false, stop: 507.5 });
  });

  it('the first stop is accepted; a non-price never is', () => {
    expect(tightenStop(null, 494, 'BUY')).toEqual({ accepted: true, stop: 494 });
    expect(tightenStop(494, Number.NaN, 'BUY')).toEqual({ accepted: false, stop: 494 });
    expect(tightenStop(494, 0, 'BUY')).toEqual({ accepted: false, stop: 494 });
  });
});

describe('trailDistance', () => {
  const trail = { kind: 'atr', multiple: 1, minPct: 0.6, maxPct: 1.5, startsAfter: 'PARTIAL' } as const;
  it('multiple × ATR clamped to [minPct, maxPct] of the extreme (silo resolveTrail)', () => {
    expect(trailDistance(trail, 500, 5)).toBe(5);
    expect(trailDistance(trail, 500, 1)).toBeCloseTo(3, 10);
    expect(trailDistance(trail, 500, 10)).toBeCloseTo(7.5, 10);
    expect(trailDistance(trail, 500, null)).toBeCloseTo(3, 10);
  });
});

function marks(over: Partial<MarkInput> = {}): MarkInput {
  return { side: 'BUY', plan: adaptivePlan(), entryAvgPrice: 500, stopPrice: 494, trailActive: false, partialDone: false, highWater: 500, lowWater: 500, ...over };
}

describe('advanceMarks', () => {
  it('tracks the best and worst price seen', () => {
    expect(advanceMarks(marks(), 503)).toMatchObject({ highWater: 503, lowWater: 500, stopPrice: 494, stopMoved: null });
    expect(advanceMarks(marks({ highWater: 503 }), 497)).toMatchObject({ highWater: 503, lowWater: 497 });
  });

  it('an ATR trail that starts after the partial waits for it, then trails the high-water and never loosens', () => {
    expect(advanceMarks(marks(), 506)).toMatchObject({ trailActive: false, stopPrice: 494 });
    expect(advanceMarks(marks({ partialDone: true, highWater: 505 }), 506)).toMatchObject({ trailActive: true, stopPrice: 501, stopMoved: 'TRAIL', highWater: 506 });
    const trailing = marks({ partialDone: true, trailActive: true, stopPrice: 501, highWater: 506 });
    expect(advanceMarks(trailing, 504)).toMatchObject({ stopPrice: 501, stopMoved: null });
    expect(advanceMarks(trailing, 508)).toMatchObject({ stopPrice: 503, stopMoved: 'TRAIL' });
  });

  it('a short trails the low-water', () => {
    const plan = cashPlan({ side: 'SELL', trail: { kind: 'atr', multiple: 1, minPct: 0.6, maxPct: 1.5, startsAfter: 'ENTRY' }, atr: 5 });
    expect(advanceMarks(marks({ side: 'SELL', plan, stopPrice: 507.5 }), 495)).toMatchObject({ lowWater: 495, stopPrice: 500, trailActive: true, stopMoved: 'TRAIL' });
  });

  it('breakeven moves the stop to the entry once the move reaches atPct, once', () => {
    const plan = cashPlan({ trail: { kind: 'breakeven', atPct: 1 } });
    expect(advanceMarks(marks({ plan, stopPrice: 492.5 }), 504)).toMatchObject({ stopPrice: 492.5, stopMoved: null });
    expect(advanceMarks(marks({ plan, stopPrice: 492.5 }), 505)).toMatchObject({ stopPrice: 500, stopMoved: 'BREAKEVEN' });
    expect(advanceMarks(marks({ plan, stopPrice: 500, highWater: 505 }), 502)).toMatchObject({ stopPrice: 500, stopMoved: null });
  });

  it('no trail never moves the stop', () => {
    expect(advanceMarks(marks({ plan: cashPlan(), stopPrice: 492.5 }), 520)).toMatchObject({ stopPrice: 492.5, stopMoved: null, trailActive: false });
  });
});

describe('canConvertTargetToTrail (parent §7.3, spec §7.4)', () => {
  it('only once the stop locks in at least the target', () => {
    expect(canConvertTargetToTrail({ side: 'BUY', stopPrice: 509, targetPrice: 510 })).toBe(false);
    expect(canConvertTargetToTrail({ side: 'BUY', stopPrice: 510, targetPrice: 510 })).toBe(true);
    expect(canConvertTargetToTrail({ side: 'SELL', stopPrice: 486, targetPrice: 485 })).toBe(false);
    expect(canConvertTargetToTrail({ side: 'SELL', stopPrice: 484, targetPrice: 485 })).toBe(true);
    expect(canConvertTargetToTrail({ side: 'BUY', stopPrice: null, targetPrice: 510 })).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx jest src/modules/trade-core/lifecycle/stop-rules.spec.ts`
Expected: FAIL, "Cannot find module './stop-rules'".

- [ ] **Step 3: Implement**

Create `apps/api/src/modules/trade-core/lifecycle/stop-rules.ts`:

```typescript
import type { OrderSide } from '../execution/execution.types';
import type { TrailBlock } from '../strategies/blocks/block-types';
import { round2 } from './exit-plan';
import type { ExitPlan } from './lifecycle.types';

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/**
 * Spec §7.4, the tighten-only invariant: a new stop is accepted only if it is closer to
 * the price (higher for a long, lower for a short). The first stop is accepted. Nothing
 * else in the core writes a stop after it is armed; SP3/SP4 guard rails go through this.
 */
export function tightenStop(current: number | null, proposed: number, side: OrderSide): { accepted: boolean; stop: number | null } {
  if (!finite(proposed) || proposed <= 0) return { accepted: false, stop: current };
  if (current === null) return { accepted: true, stop: proposed };
  const closer = side === 'BUY' ? proposed > current : proposed < current;
  return closer ? { accepted: true, stop: proposed } : { accepted: false, stop: current };
}

/** The ATR give-back from the extreme (silo resolveTrail): multiple × ATR within [minPct, maxPct] of the extreme. */
export function trailDistance(trail: Extract<TrailBlock, { kind: 'atr' }>, extreme: number, atr: number | null): number {
  const min = (trail.minPct / 100) * extreme;
  const max = (trail.maxPct / 100) * extreme;
  const dist = finite(atr) && atr > 0 ? trail.multiple * atr : 0;
  if (!(dist > 0) || dist < min) return min;
  return dist > max ? max : dist;
}

export interface MarkInput {
  side: OrderSide;
  plan: ExitPlan;
  entryAvgPrice: number;
  stopPrice: number | null;
  trailActive: boolean;
  partialDone: boolean;
  highWater: number | null;
  lowWater: number | null;
}

export interface Marks {
  highWater: number;
  lowWater: number;
  stopPrice: number | null;
  trailActive: boolean;
  /** Why the stop moved on this price, or null. */
  stopMoved: 'BREAKEVEN' | 'TRAIL' | null;
}

/** One fresh price: water marks, then the trail's candidate stop through tightenStop (ruling L5). */
export function advanceMarks(m: MarkInput, ltp: number): Marks {
  const highWater = Math.max(m.highWater ?? ltp, ltp);
  const lowWater = Math.min(m.lowWater ?? ltp, ltp);
  const buy = m.side === 'BUY';
  const extreme = buy ? highWater : lowWater;
  const trail = m.plan.trail;
  let stopPrice = m.stopPrice;
  let trailActive = m.trailActive;
  let stopMoved: Marks['stopMoved'] = null;
  if (trail.kind === 'breakeven') {
    const movePct = ((extreme - m.entryAvgPrice) / m.entryAvgPrice) * 100 * (buy ? 1 : -1);
    if (movePct >= trail.atPct) {
      const t = tightenStop(stopPrice, round2(m.entryAvgPrice), m.side);
      if (t.accepted) {
        stopPrice = t.stop;
        stopMoved = 'BREAKEVEN';
      }
    }
  } else if (trail.kind === 'atr') {
    if (!trailActive && (trail.startsAfter === 'ENTRY' || m.partialDone)) trailActive = true;
    if (trailActive) {
      const d = trailDistance(trail, extreme, m.plan.atr);
      const t = tightenStop(stopPrice, round2(buy ? extreme - d : extreme + d), m.side);
      if (t.accepted) {
        stopPrice = t.stop;
        stopMoved = 'TRAIL';
      }
    }
  }
  return { highWater, lowWater, stopPrice, trailActive, stopMoved };
}

/**
 * Parent §7.3: a hit target may become a trailing stop only after the stop has moved to
 * lock in at least the target's profit. No block uses it yet (drift D15); SP3/SP4 will.
 */
export function canConvertTargetToTrail(p: { side: OrderSide; stopPrice: number | null; targetPrice: number | null }): boolean {
  if (p.stopPrice === null || p.targetPrice === null) return false;
  return p.side === 'BUY' ? p.stopPrice >= p.targetPrice : p.stopPrice <= p.targetPrice;
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `npx jest src/modules/trade-core/lifecycle/stop-rules.spec.ts`
Expected: PASS. (Adaptive trail at high-water 506 with ATR 5: give-back 5 is inside [3.036, 7.59] → 501; at 508 → 503. Short at low-water 495 → 500.)

- [ ] **Step 5: Commit**

```bash
git add -- apps/api/src/modules/trade-core/lifecycle/stop-rules.ts apps/api/src/modules/trade-core/lifecycle/stop-rules.spec.ts
git commit -m "feat(trade-core): tighten-only stop, breakeven and ATR trails, target-to-trail guard" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/api/src/modules/trade-core/lifecycle/stop-rules.ts apps/api/src/modules/trade-core/lifecycle/stop-rules.spec.ts
```

---

### Task 4: The exit decision in spec §7.3 priority, with the options and MTF rules

**Files:**
- Create: `apps/api/src/modules/trade-core/lifecycle/exit-decision.ts`
- Modify: `apps/api/src/modules/trade-core/lifecycle/testing/lifecycle-fixtures.ts` (append `positionFor`)
- Test: `apps/api/src/modules/trade-core/lifecycle/exit-decision.spec.ts`

**Interfaces:**
- Consumes: `CorePosition`, `ExitReason` (Task 1); `armLevels` (Task 2); `istDate`, `nextDate` (`execution/ledger-math.ts`); `istMinutesOf` (`risk-wall/session-open.ts`); `hhmmToMinutes` (`risk-wall/limits/limit-keys.ts`); `SessionClock` (type).
- Produces: `INTRADAY_VEHICLES`; `effectiveSquareOff(frozen: string, live: string | null): string`; `effectiveHoldDays(frozen: number | null, live: number | null): number | null`; `tradingDaysHeld(clock, exchange, entryDay, now): number`; `ExitView`; `ExitInputs`; `ExitDecision`; `decideExit(i: ExitInputs): ExitDecision`; fixture `positionFor(plan, over)`.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/modules/trade-core/lifecycle/testing/lifecycle-fixtures.ts` (imports to the top):

```typescript
import { armLevels } from '../exit-plan';
import type { CorePosition } from '../lifecycle.types';

/** An OPEN position under `plan`: cash 100 @ 500, or options 75 (one lot) @ 100; opened 10 minutes before NOW. */
export function positionFor(plan: ExitPlan, over: Partial<CorePosition> = {}): CorePosition {
  const option = plan.vehicle === 'OPTIONS_BUY';
  const entry = option ? 100 : 500;
  const qty = option ? 75 : 100;
  const lv = armLevels(plan, entry, qty, option ? 75 : 1);
  return {
    id: 'pos_1',
    userId: 'user_A',
    intentId: 'int_1',
    strategyId: 'cs_ungated',
    strategyVersionId: 'csv_ungated_v1',
    vehicle: plan.vehicle,
    instrument: option
      ? { exchange: 'NFO', token: '43210', symbol: 'NIFTY26OCT25000CE', lotSize: 75, underlying: 'NIFTY' }
      : { exchange: 'NSE', token: '2885', symbol: 'RELIANCE-EQ', lotSize: 1, underlying: null },
    underlying: option ? 'NIFTY' : 'RELIANCE',
    side: plan.side,
    direction: plan.side === 'BUY' ? 'LONG' : 'SHORT',
    status: 'OPEN',
    requestedQty: qty,
    entryFilledQty: qty,
    exitFilledQty: 0,
    openQty: qty,
    entryAvgPrice: entry,
    plan,
    initialStopPrice: lv.stopPrice,
    stopPrice: lv.stopPrice,
    targetPrice: lv.targetPrice,
    partialPrice: lv.partialPrice,
    partialQty: lv.partialQty,
    trailActive: false,
    partialDone: false,
    highWater: entry,
    lowWater: entry,
    exitSeq: 0,
    exitReason: null,
    blindSince: null,
    openedAt: new Date(NOW.getTime() - 10 * 60_000),
    closedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    version: 1,
    ...over,
  };
}
```

Create `apps/api/src/modules/trade-core/lifecycle/exit-decision.spec.ts`:

```typescript
import { decideExit, effectiveHoldDays, effectiveSquareOff, tradingDaysHeld, type ExitInputs } from './exit-decision';
import type { CorePosition } from './lifecycle.types';
import { adaptivePlan, cashPlan, mtfPlan, NOW, optionPlan, positionFor } from './testing/lifecycle-fixtures';

/** IST wall-clock on an IST date. */
const ist = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00.000+05:30`);
const px = (ltp: number, now: Date = NOW) => ({ ltp, at: now.getTime() });

function inputs(position: CorePosition, over: Partial<ExitInputs> = {}): ExitInputs {
  const now = over.now ?? NOW;
  return {
    position,
    price: px(position.entryAvgPrice ?? 500, now),
    underlyingLtp: null,
    now,
    sessionOpen: true,
    killSwitchActive: false,
    squareOffHhmm: position.plan.squareOffHhmm,
    mtfMaxHoldDays: position.plan.mtfMaxHoldDays,
    tradingDaysHeld: 0,
    recovering: false,
    firstPriceOfDay: false,
    ...over,
  };
}

describe('decideExit (spec §7.3)', () => {
  const cash = positionFor(cashPlan()); // stop 492.5, target 515, clock exit 15:25, square-off 15:15

  it('decides nothing while the session is closed, even with the kill switch on (ruling L9)', () => {
    expect(decideExit(inputs(cash, { sessionOpen: false, killSwitchActive: true, price: px(400) }))).toEqual({ kind: 'NONE' });
  });

  it('decides nothing for a position with nothing open', () => {
    expect(decideExit(inputs({ ...cash, openQty: 0, status: 'PENDING_ENTRY' }, { killSwitchActive: true }))).toEqual({ kind: 'NONE' });
  });

  it('the kill switch outranks a crossed stop (priority 1)', () => {
    expect(decideExit(inputs(cash, { killSwitchActive: true, price: px(400) }))).toMatchObject({ kind: 'EXIT', reason: 'KILL_SWITCH' });
  });

  it('a crossed stop is STOP; once the stop has moved or the trail is active it is TRAIL', () => {
    expect(decideExit(inputs(cash, { price: px(492.5) }))).toMatchObject({ kind: 'EXIT', reason: 'STOP' });
    expect(decideExit(inputs(cash, { price: px(492.6) }))).toEqual({ kind: 'NONE' });
    expect(decideExit(inputs({ ...cash, stopPrice: 500 }, { price: px(499) }))).toMatchObject({ reason: 'TRAIL' });
    expect(decideExit(inputs({ ...cash, trailActive: true }, { price: px(490) }))).toMatchObject({ reason: 'TRAIL' });
    expect(decideExit(inputs(positionFor(cashPlan({ side: 'SELL' })), { price: px(507.5) }))).toMatchObject({ reason: 'STOP' });
  });

  it('the first price after a restart is a RECOVERY_STOP; the first price of an IST day is a GAP_STOP', () => {
    expect(decideExit(inputs(cash, { price: px(480), recovering: true, firstPriceOfDay: true }))).toMatchObject({ reason: 'RECOVERY_STOP' });
    expect(decideExit(inputs(cash, { price: px(480), firstPriceOfDay: true }))).toMatchObject({ reason: 'GAP_STOP' });
  });

  it('without a fresh price no price rule fires', () => {
    expect(decideExit(inputs(cash, { price: null }))).toEqual({ kind: 'NONE' });
  });

  it('target exits everything; the partial level sells the partial quantity once; zero when nothing would remain', () => {
    expect(decideExit(inputs(cash, { price: px(515) }))).toMatchObject({ kind: 'EXIT', reason: 'TARGET' });
    const adaptive = positionFor(adaptivePlan()); // stop 494, partial 505 × 50, target 510
    expect(decideExit(inputs(adaptive, { price: px(505) }))).toMatchObject({ kind: 'PARTIAL', qty: 50 });
    expect(decideExit(inputs({ ...adaptive, partialDone: true }, { price: px(506) }))).toEqual({ kind: 'NONE' });
    expect(decideExit(inputs({ ...adaptive, openQty: 50, partialQty: 50 }, { price: px(505) }))).toMatchObject({ kind: 'PARTIAL', qty: 0 });
    expect(decideExit(inputs(adaptive, { price: px(510) }))).toMatchObject({ kind: 'EXIT', reason: 'TARGET' });
  });

  it('the clock time exit fires at its IST minute, price or not', () => {
    const p = positionFor(cashPlan({ timeExit: { kind: 'clock', hhmm: '14:00' } }));
    expect(decideExit(inputs(p, { now: ist('2026-10-12', '13:59'), price: null }))).toEqual({ kind: 'NONE' });
    expect(decideExit(inputs(p, { now: ist('2026-10-12', '14:00'), price: null }))).toMatchObject({ reason: 'TIME_EXIT' });
  });

  it('intraday vehicles square off at the effective time, and at once on a later IST day (rulings L7, L8)', () => {
    expect(decideExit(inputs(cash, { now: ist('2026-10-12', '15:14'), price: null }))).toEqual({ kind: 'NONE' });
    expect(decideExit(inputs(cash, { now: ist('2026-10-12', '15:15'), price: null }))).toMatchObject({ reason: 'SQUARE_OFF' });
    expect(decideExit(inputs(cash, { now: ist('2026-10-12', '14:00'), squareOffHhmm: '14:00', price: null }))).toMatchObject({ reason: 'SQUARE_OFF' });
    expect(decideExit(inputs(cash, { now: ist('2026-10-13', '09:16'), price: null }))).toMatchObject({ reason: 'SQUARE_OFF' });
  });

  it('MTF holds overnight; holdDays and the hold limit exit at squareOffTime on the n-th trading day (O5)', () => {
    const mtf = positionFor(mtfPlan()); // holdDays 3, mtfMaxHoldDays 10, square-off 15:20
    expect(decideExit(inputs(mtf, { now: ist('2026-10-13', '15:30'), tradingDaysHeld: 1, price: null }))).toEqual({ kind: 'NONE' });
    expect(decideExit(inputs(mtf, { now: ist('2026-10-15', '15:19'), tradingDaysHeld: 3, price: null }))).toEqual({ kind: 'NONE' });
    expect(decideExit(inputs(mtf, { now: ist('2026-10-15', '15:20'), tradingDaysHeld: 3, price: null }))).toMatchObject({ reason: 'TIME_EXIT' });
    const long = positionFor(mtfPlan({ timeExit: { kind: 'holdDays', n: 30 } }));
    expect(decideExit(inputs(long, { now: ist('2026-10-26', '15:20'), tradingDaysHeld: 10, price: null }))).toMatchObject({ reason: 'HOLD_LIMIT' });
    expect(decideExit(inputs(long, { now: ist('2026-10-20', '15:20'), tradingDaysHeld: 6, mtfMaxHoldDays: 5, price: null }))).toMatchObject({ reason: 'HOLD_LIMIT' });
  });

  it('options: out by the expiry-day cutoff, at once after expiry, and the theta stop after its window', () => {
    const onExpiryDay = positionFor(optionPlan({ entryDay: '2026-10-15' }), { openedAt: ist('2026-10-15', '14:00'), highWater: 120 });
    expect(decideExit(inputs(onExpiryDay, { now: ist('2026-10-15', '14:29'), price: null }))).toEqual({ kind: 'NONE' });
    expect(decideExit(inputs(onExpiryDay, { now: ist('2026-10-15', '14:30'), price: null }))).toMatchObject({ reason: 'EXPIRY_DAY' });
    expect(decideExit(inputs(onExpiryDay, { now: ist('2026-10-16', '09:20'), price: null }))).toMatchObject({ reason: 'EXPIRY_DAY' });
    const opt = positionFor(optionPlan()); // opened 10:20 IST: theta needs +10 % by 10:50
    expect(decideExit(inputs(opt, { now: ist('2026-10-12', '10:49'), price: null }))).toEqual({ kind: 'NONE' });
    expect(decideExit(inputs(opt, { now: ist('2026-10-12', '10:50'), price: null }))).toMatchObject({ reason: 'THETA_STOP' });
    expect(decideExit(inputs({ ...opt, highWater: 110 }, { now: ist('2026-10-12', '10:50'), price: null }))).toEqual({ kind: 'NONE' });
  });

  it('options: the premium stop, and an explicit underlying stop (CE below, PE above)', () => {
    expect(decideExit(inputs(positionFor(optionPlan()), { price: px(75) }))).toMatchObject({ reason: 'STOP' });
    const ref = { exchange: 'NSE' as const, token: '26000', symbol: 'NIFTY' };
    const base = optionPlan().option!;
    const ce = positionFor(optionPlan({ option: { ...base, underlyingRef: ref, underlyingStopPrice: 24900 } }));
    expect(decideExit(inputs(ce, { underlyingLtp: 24901 }))).toEqual({ kind: 'NONE' });
    expect(decideExit(inputs(ce, { underlyingLtp: 24900 }))).toMatchObject({ reason: 'UNDERLYING_STOP' });
    const pe = positionFor(optionPlan({ option: { ...base, optionType: 'PE', underlyingRef: ref, underlyingStopPrice: 25100 } }));
    expect(decideExit(inputs(pe, { underlyingLtp: 25100 }))).toMatchObject({ reason: 'UNDERLYING_STOP' });
  });
});

describe('effective limits (O4) and trading days held (O5)', () => {
  it('the square-off is the earlier of frozen and live; a loosening never extends', () => {
    expect(effectiveSquareOff('15:15', '14:00')).toBe('14:00');
    expect(effectiveSquareOff('15:15', '15:25')).toBe('15:15');
    expect(effectiveSquareOff('15:15', null)).toBe('15:15');
    expect(effectiveSquareOff('15:15', 'garbage')).toBe('15:15');
  });

  it('the hold limit is the lower of frozen and live; null for non-MTF', () => {
    expect(effectiveHoldDays(10, 5)).toBe(5);
    expect(effectiveHoldDays(10, 20)).toBe(10);
    expect(effectiveHoldDays(10, null)).toBe(10);
    expect(effectiveHoldDays(null, 5)).toBeNull();
  });

  it('counts exchange trading days after the entry day, skipping weekends and holidays', () => {
    const holiday = '2026-10-20';
    const clock = {
      isTradingDay: (_exchange: string, d: Date) => {
        const local = new Date(d.getTime() + 5.5 * 3600_000);
        return local.getUTCDay() !== 0 && local.getUTCDay() !== 6 && local.toISOString().slice(0, 10) !== holiday;
      },
    };
    expect(tradingDaysHeld(clock, 'NSE', '2026-10-12', ist('2026-10-12', '15:00'))).toBe(0);
    expect(tradingDaysHeld(clock, 'NSE', '2026-10-16', ist('2026-10-19', '10:00'))).toBe(1);
    expect(tradingDaysHeld(clock, 'NSE', '2026-10-16', ist('2026-10-21', '10:00'))).toBe(2);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx jest src/modules/trade-core/lifecycle/exit-decision.spec.ts`
Expected: FAIL, "Cannot find module './exit-decision'".

- [ ] **Step 3: Implement**

Create `apps/api/src/modules/trade-core/lifecycle/exit-decision.ts`:

```typescript
import type { SessionClock } from '../../market-hub/session-clock';
import { istDate, nextDate } from '../execution/ledger-math';
import { hhmmToMinutes } from '../risk-wall/limits/limit-keys';
import { istMinutesOf } from '../risk-wall/session-open';
import type { Vehicle } from '../strategies/blocks/block-types';
import type { CorePosition, ExitReason } from './lifecycle.types';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Owner decision O2: these vehicles square off every day. */
export const INTRADAY_VEHICLES: readonly Vehicle[] = ['CASH_INTRADAY', 'OPTIONS_BUY'];

/** O4: the earlier of the frozen and the live square-off time; a loosening never extends. */
export function effectiveSquareOff(frozen: string, live: string | null): string {
  if (live === null || !HHMM.test(live)) return frozen;
  return hhmmToMinutes(live) < hhmmToMinutes(frozen) ? live : frozen;
}

/** O4: the lower of the frozen and the live MTF hold limit; null for non-MTF positions. */
export function effectiveHoldDays(frozen: number | null, live: number | null): number | null {
  if (frozen === null) return null;
  return live !== null && Number.isSafeInteger(live) && live >= 1 && live < frozen ? live : frozen;
}

/** Bounds the calendar scan; every hold limit forces an exit far sooner. */
const MAX_DAYS_SCANNED = 60;

/** O5: exchange trading days strictly after the entry day, up to and including today (IST). */
export function tradingDaysHeld(clock: Pick<SessionClock, 'isTradingDay'>, exchange: string, entryDay: string, now: Date): number {
  const today = istDate(now);
  let day = entryDay;
  let n = 0;
  for (let i = 0; i < MAX_DAYS_SCANNED && day < today; i += 1) {
    day = nextDate(day);
    // 10:00 IST on that date: the clock judges the date, not the minute.
    if (clock.isTradingDay(exchange, new Date(`${day}T04:30:00.000Z`))) n += 1;
  }
  return n;
}

export type ExitView = Pick<
  CorePosition,
  | 'vehicle'
  | 'side'
  | 'plan'
  | 'openQty'
  | 'entryAvgPrice'
  | 'stopPrice'
  | 'initialStopPrice'
  | 'targetPrice'
  | 'partialPrice'
  | 'partialQty'
  | 'partialDone'
  | 'trailActive'
  | 'highWater'
  | 'openedAt'
>;

export interface ExitInputs {
  position: ExitView;
  /** A fresh (≤ PRICE_MAX_AGE_MS) price of the traded instrument, or null. */
  price: { ltp: number; at: number } | null;
  /** A fresh price of the option's underlying, or null. */
  underlyingLtp: number | null;
  now: Date;
  sessionOpen: boolean;
  killSwitchActive: boolean;
  /** effectiveSquareOff(plan.squareOffHhmm, live). */
  squareOffHhmm: string;
  /** effectiveHoldDays(plan.mtfMaxHoldDays, live). */
  mtfMaxHoldDays: number | null;
  tradingDaysHeld: number;
  /** The first fresh price since this process reloaded the position. */
  recovering: boolean;
  /** The first fresh price of this IST day for the position. */
  firstPriceOfDay: boolean;
}

export type ExitDecision =
  | { kind: 'NONE' }
  | { kind: 'EXIT'; reason: ExitReason; detail: string }
  | { kind: 'PARTIAL'; qty: number; detail: string };

const NONE: ExitDecision = { kind: 'NONE' };
const exit = (reason: ExitReason, detail: string): ExitDecision => ({ kind: 'EXIT', reason, detail });

/**
 * One position at one instant (spec §7.3, highest priority first): kill switch; the stop
 * (recovery, gap, trail or plain) and the underlying stop; target, then the partial; time
 * exit, expiry day, theta stop, hold limit; vehicle square-off. Daily loss (priority 2)
 * reaches positions through CORE_SQUARE_OFF (ruling L15). Price rules need a fresh price;
 * clock rules do not, so a blind position still squares off. Nothing while the session is
 * closed (ruling L9).
 */
export function decideExit(i: ExitInputs): ExitDecision {
  const p = i.position;
  if (!i.sessionOpen || p.openQty <= 0 || p.entryAvgPrice === null) return NONE;
  if (i.killSwitchActive) return exit('KILL_SWITCH', 'the kill switch is on');
  const buy = p.side === 'BUY';
  const ltp = i.price?.ltp ?? null;

  if (ltp !== null && p.stopPrice !== null && (buy ? ltp <= p.stopPrice : ltp >= p.stopPrice)) {
    const moved = p.trailActive || p.stopPrice !== p.initialStopPrice;
    const reason: ExitReason = i.recovering ? 'RECOVERY_STOP' : i.firstPriceOfDay ? 'GAP_STOP' : moved ? 'TRAIL' : 'STOP';
    return exit(reason, `${ltp} crossed the stop ${p.stopPrice}`);
  }
  const opt = p.plan.option;
  if (opt && opt.underlyingStopPrice !== null && i.underlyingLtp !== null) {
    const hit = opt.optionType === 'CE' ? i.underlyingLtp <= opt.underlyingStopPrice : i.underlyingLtp >= opt.underlyingStopPrice;
    if (hit) return exit('UNDERLYING_STOP', `the underlying at ${i.underlyingLtp} crossed ${opt.underlyingStopPrice}`);
  }
  if (ltp !== null && p.targetPrice !== null && (buy ? ltp >= p.targetPrice : ltp <= p.targetPrice)) {
    return exit('TARGET', `${ltp} reached the target ${p.targetPrice}`);
  }
  if (ltp !== null && !p.partialDone && p.partialPrice !== null && (buy ? ltp >= p.partialPrice : ltp <= p.partialPrice)) {
    const qty = p.partialQty > 0 && p.partialQty < p.openQty ? p.partialQty : 0;
    return { kind: 'PARTIAL', qty, detail: `${ltp} reached target 1 at ${p.partialPrice}` };
  }

  const minutes = istMinutesOf(i.now);
  const today = istDate(i.now);
  const atSquareOff = minutes >= hhmmToMinutes(i.squareOffHhmm);
  const te = p.plan.timeExit;
  if (te.kind === 'clock' && minutes >= hhmmToMinutes(te.hhmm)) return exit('TIME_EXIT', `time exit at ${te.hhmm} IST`);
  if (te.kind === 'holdDays' && i.tradingDaysHeld >= te.n && atSquareOff) {
    return exit('TIME_EXIT', `held ${i.tradingDaysHeld} trading days (time exit after ${te.n})`);
  }
  if (opt) {
    if (today > opt.expiry || (today === opt.expiry && minutes >= hhmmToMinutes(opt.expiryDayExitHhmm))) {
      return exit('EXPIRY_DAY', `expiry ${opt.expiry}: out by ${opt.expiryDayExitHhmm} IST, never held into expiry`);
    }
    if (p.openedAt) {
      const elapsedMin = (i.now.getTime() - p.openedAt.getTime()) / 60_000;
      const best = p.highWater ?? p.entryAvgPrice;
      const movePct = ((best - p.entryAvgPrice) / p.entryAvgPrice) * 100;
      if (elapsedMin >= opt.thetaStop.withinMinutes && movePct < opt.thetaStop.minMovePct) {
        return exit('THETA_STOP', `best premium move ${movePct.toFixed(2)} % < ${opt.thetaStop.minMovePct} % within ${opt.thetaStop.withinMinutes} min`);
      }
    }
  }
  if (i.mtfMaxHoldDays !== null && i.tradingDaysHeld >= i.mtfMaxHoldDays && atSquareOff) {
    return exit('HOLD_LIMIT', `held ${i.tradingDaysHeld} trading days; the MTF limit is ${i.mtfMaxHoldDays}`);
  }
  if (INTRADAY_VEHICLES.includes(p.vehicle) && (atSquareOff || today > p.plan.entryDay)) {
    return exit('SQUARE_OFF', today > p.plan.entryDay ? `an intraday position opened ${p.plan.entryDay} is still open` : `${p.vehicle} squares off at ${i.squareOffHhmm} IST`);
  }
  return NONE;
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `npx jest src/modules/trade-core/lifecycle/exit-decision.spec.ts`
Expected: PASS.

- [ ] **Step 5: Run the stream's suites and commit**

Run: `npx jest src/modules/trade-core/lifecycle`
Expected: PASS (4 suites).

```bash
git add -- apps/api/src/modules/trade-core/lifecycle/exit-decision.ts apps/api/src/modules/trade-core/lifecycle/exit-decision.spec.ts apps/api/src/modules/trade-core/lifecycle/testing/lifecycle-fixtures.ts
git commit -m "feat(trade-core): exit decision in spec priority with options and MTF rules" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/api/src/modules/trade-core/lifecycle/exit-decision.ts apps/api/src/modules/trade-core/lifecycle/exit-decision.spec.ts apps/api/src/modules/trade-core/lifecycle/testing/lifecycle-fixtures.ts
```

---

## Stream B — the store and the execution seams

### Task 5: `core_positions`, `core_orders.positionId`, the `blindAfterMs` paper default

**Files:**
- Modify: `prisma/schema.prisma` (new `CorePosition`; `CoreOrder.positionId` + relation + index; `User.corePositions`)
- Create: `prisma/migrations/20261012120000_sp2_m4_lifecycle/migration.sql`
- Modify: `apps/api/src/common/tenant/tenant.constants.ts`
- Modify: `apps/api/src/modules/trade-core/execution/paper-settings.ts`, `apps/api/src/modules/trade-core/execution/paper-settings.spec.ts`
- Create: `apps/api/src/modules/trade-core/lifecycle/lifecycle-defaults.spec.ts`
- Create: `apps/api/test/sp2-m4/jest.config.js`, `apps/api/test/sp2-m4/core-lifecycle.int.spec.ts`

**Interfaces:**
- Consumes: M2's `core_append_only_guard()` is **not** used (positions are updated by design, guarded by `version`).
- Produces: Prisma model `CorePosition` (`prisma.corePosition`), `CoreOrder.positionId: String?`; `PaperSettings.blindAfterMs: number | null`; `OPTIONAL_PAPER_PAIRS`.

- [ ] **Step 1: Write the failing seed/vocabulary tests**

Create `apps/api/src/modules/trade-core/lifecycle/lifecycle-defaults.spec.ts`:

```typescript
import { readFileSync } from 'fs';
import { join } from 'path';
import { isPaperPair, OPTIONAL_PAPER_PAIRS, paperPairId, parsePaperValue, REQUIRED_PAPER_PAIRS, type PaperKey } from '../execution/paper-settings';
import { EXIT_REASONS, POSITION_STATUSES } from './lifecycle.types';

/** The M4 migration: expand-only, one optional paper default, the position vocabularies mirrored in CHECKs. */
const ROOT = join(__dirname, '..', '..', '..', '..', '..', '..');
const sql = readFileSync(join(ROOT, 'prisma', 'migrations', '20261012120000_sp2_m4_lifecycle', 'migration.sql'), 'utf8');

describe('M4 migration', () => {
  it('seeds blindAfterMs@ALL = 30000 as "default — please review", idempotently', () => {
    const seed = sql.slice(sql.indexOf('-- SEED BEGIN'), sql.indexOf('-- SEED END'));
    const rows = [...seed.matchAll(/\('([A-Za-z]+)', '([A-Z_]+)', (\d+(?:\.\d+)?), '([^']*)'\)/g)].map((m) => ({ key: m[1], scope: m[2], value: m[3], note: m[4] }));
    expect(rows.map((r) => paperPairId(r.key, r.scope))).toEqual([...OPTIONAL_PAPER_PAIRS]);
    expect(rows[0].value).toBe('30000');
    expect(rows[0].note.startsWith('default — please review')).toBe(true);
    expect(isPaperPair(rows[0].key, rows[0].scope)).toBe(true);
    expect(parsePaperValue(rows[0].key as PaperKey, rows[0].value).ok).toBe(true);
    expect(seed).toContain('ON CONFLICT ("key", "scope") DO NOTHING');
  });

  it('the widened pair CHECK names the required pairs plus the optional ones, exactly', () => {
    const check = sql.slice(sql.indexOf('ADD CONSTRAINT "core_paper_defaults_pair_check"'), sql.indexOf('ADD CONSTRAINT "core_paper_defaults_value_check"'));
    const pairs = [...check.matchAll(/\('([A-Za-z]+)', '([A-Z_]+)'\)/g)].map((m) => paperPairId(m[1], m[2]));
    expect(pairs).toEqual([...REQUIRED_PAPER_PAIRS, ...OPTIONAL_PAPER_PAIRS]);
    expect(sql).toContain(`WHEN 'blindAfterMs' THEN "numValue" >= 1000 AND "numValue" = trunc("numValue")`);
  });

  it('mirrors the status and exit-reason vocabularies in CHECKs', () => {
    for (const s of POSITION_STATUSES) expect(sql).toContain(`'${s}'`);
    const reasons = sql.slice(sql.indexOf('"exitReason" IN ('), sql.indexOf('))', sql.indexOf('"exitReason" IN (')));
    expect([...reasons.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1])).toEqual([...EXIT_REASONS]);
  });

  it('is expand-only: drops no table or column and redefines no function', () => {
    expect(sql).not.toMatch(/DROP TABLE|DROP COLUMN|CREATE OR REPLACE FUNCTION/);
    expect(sql.match(/DROP CONSTRAINT/g)).toHaveLength(2); // the two widened paper-default CHECKs, re-added below
  });
});
```

Append to `apps/api/src/modules/trade-core/execution/paper-settings.spec.ts` (inside the file, as a new `describe`; add `OPTIONAL_PAPER_PAIRS` to its import):

```typescript
describe('blindAfterMs (SP2 M4, ruling L10: optional)', () => {
  it('is a pair at ALL only, a whole number of ms of at least 1000', () => {
    expect(isPaperPair('blindAfterMs', 'ALL')).toBe(true);
    expect(isPaperPair('blindAfterMs', 'CASH_INTRADAY')).toBe(false);
    expect(parsePaperValue('blindAfterMs', 30000).ok).toBe(true);
    expect(parsePaperValue('blindAfterMs', 999).ok).toBe(false);
    expect(parsePaperValue('blindAfterMs', '1500.5').ok).toBe(false);
  });

  it('is not required: absent resolves to null, present to its number', () => {
    expect(REQUIRED_PAPER_PAIRS).not.toContain('blindAfterMs@ALL');
    expect(OPTIONAL_PAPER_PAIRS).toEqual(['blindAfterMs@ALL']);
    const base = resolvePaperSettings(SEED_ROWS);
    expect(base.ok && base.settings.blindAfterMs).toBeNull();
    const withBlind = resolvePaperSettings([...SEED_ROWS, { key: 'blindAfterMs', scope: 'ALL', numValue: new Prisma.Decimal('30000') }]);
    expect(withBlind.ok && withBlind.settings.blindAfterMs).toBe(30000);
  });
});
```

(Add `import { Prisma } from '@prisma/client';` and `import { SEED_ROWS } from './testing/paper-fixtures';` to its imports if absent.)

- [ ] **Step 2: Run them to see them fail**

Run: `npx jest src/modules/trade-core/lifecycle/lifecycle-defaults.spec.ts src/modules/trade-core/execution/paper-settings.spec.ts`
Expected: FAIL (`ENOENT … 20261012120000_sp2_m4_lifecycle/migration.sql`; `OPTIONAL_PAPER_PAIRS` undefined).

- [ ] **Step 3: Extend the paper-settings vocabulary**

In `apps/api/src/modules/trade-core/execution/paper-settings.ts`:

1. Add `'blindAfterMs'` as the last entry of `PAPER_KEYS`.
2. Change the type of `PAPER_KEY_SCOPES` to `Readonly<Record<Exclude<PaperKey, 'maxLotsPerOrder' | 'blindAfterMs'>, readonly string[]>>` (its value is unchanged, so `REQUIRED_PAPER_PAIRS` is unchanged).
3. Below `REQUIRED_PAPER_PAIRS`, add:

```typescript
/**
 * SP2 M4 (ruling L10): pairs that may be absent without rejecting orders. The lifecycle
 * reads blindAfterMs and falls back to PRICE_MAX_AGE_MS (stricter) when it is missing.
 */
export const OPTIONAL_PAPER_PAIRS: readonly string[] = ['blindAfterMs@ALL'];
```

4. In `isPaperPair`, before `return PAPER_KEY_SCOPES[key].includes(scope);`, add `if (key === 'blindAfterMs') return scope === 'ALL';`.
5. In `parsePaperValue`'s `switch`, add:

```typescript
    case 'blindAfterMs':
      return v.isInteger() && v.gte(1000) ? okValue(v) : fail('must be a whole number of milliseconds, at least 1000');
```

6. In `PaperSettings`, add after `maxLotsPerOrder`:

```typescript
  /** SP2 M4: no fresh price for this long marks an open position blind; null when the optional row is absent. */
  blindAfterMs: number | null;
```

7. In `resolvePaperSettings`'s returned `settings`, add `blindAfterMs: valid.has('blindAfterMs@ALL') ? get('blindAfterMs', 'ALL').toNumber() : null,`.

- [ ] **Step 4: Prisma schema**

In `prisma/schema.prisma`:

In `model User`, below `coreOrders             CoreOrder[]`, add `corePositions          CorePosition[]`.

In `model CoreOrder`, below `strategyVersionId String?`, add:

```prisma
  /// SP2 M4: the core position this order belongs to (null for orders placed outside the lifecycle).
  positionId        String?
  position          CorePosition?    @relation(fields: [positionId], references: [id], onDelete: SetNull)
```

and below `@@index([userId, vehicle, token])` add `@@index([userId, positionId])`.

After `model CorePaperDefault { … }`, add:

```prisma
/// SP2 M4 — one core position per entry intent (spec §7.1). Status is derived from its
/// orders; the exit plan is frozen at entry; updates are guarded by `version`.
model CorePosition {
  id                String      @id @default(cuid())
  userId            String
  user              User        @relation(fields: [userId], references: [id], onDelete: Cascade)
  /// The corpus sourceId for ai_decision_records.source = 'core' (ruling L13).
  intentId          String      @unique
  strategyId        String
  strategyVersionId String
  vehicle           String // CASH_INTRADAY | MTF | OPTIONS_BUY
  exchange          String
  token             String
  symbol            String
  lotSize           Int
  underlying        String
  side              String // BUY | SELL
  direction         String // LONG | SHORT
  status            String // PENDING_ENTRY | OPEN | PARTIAL | EXITING | CLOSED | CANCELLED
  requestedQty      Int
  entryFilledQty    Int         @default(0)
  exitFilledQty     Int         @default(0)
  entryAvgPrice     Decimal?    @db.Decimal(14, 4)
  plan              Json
  initialStopPrice  Decimal?    @db.Decimal(14, 4)
  stopPrice         Decimal?    @db.Decimal(14, 4)
  targetPrice       Decimal?    @db.Decimal(14, 4)
  partialPrice      Decimal?    @db.Decimal(14, 4)
  partialQty        Int         @default(0)
  trailActive       Boolean     @default(false)
  partialDone       Boolean     @default(false)
  highWater         Decimal?    @db.Decimal(14, 4)
  lowWater          Decimal?    @db.Decimal(14, 4)
  exitSeq           Int         @default(0)
  exitReason        String?
  blindSince        DateTime?
  openedAt          DateTime?
  closedAt          DateTime?
  version           Int         @default(0)
  createdAt         DateTime    @default(now())
  updatedAt         DateTime    @updatedAt
  orders            CoreOrder[]

  @@index([userId, status])
  @@index([status])
  @@index([userId, vehicle, token])
  @@map("core_positions")
}
```

Run (from the repo root): `npx prisma format --schema prisma/schema.prisma && npx prisma validate --schema prisma/schema.prisma`
Expected: "The schema at prisma/schema.prisma is valid".

- [ ] **Step 5: The migration**

Create `prisma/migrations/20261012120000_sp2_m4_lifecycle/migration.sql`:

```sql
-- SP2 M4 — lifecycle: core positions (docs/superpowers/plans/2026-10-12-sp2-m4-lifecycle.md).
--
-- Expand-only: one new table, one nullable column (+ index, FK) on core_orders (empty in
-- production: nothing places core orders before M5), the two core_paper_defaults CHECKs
-- widened by one optional pair (dropped and re-added in this transaction), and one seed
-- row. No table, column or function is dropped or redefined.

CREATE TABLE "core_positions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "intentId" TEXT NOT NULL,
    "strategyId" TEXT NOT NULL,
    "strategyVersionId" TEXT NOT NULL,
    "vehicle" TEXT NOT NULL,
    "exchange" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "lotSize" INTEGER NOT NULL,
    "underlying" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "requestedQty" INTEGER NOT NULL,
    "entryFilledQty" INTEGER NOT NULL DEFAULT 0,
    "exitFilledQty" INTEGER NOT NULL DEFAULT 0,
    "entryAvgPrice" DECIMAL(14,4),
    "plan" JSONB NOT NULL,
    "initialStopPrice" DECIMAL(14,4),
    "stopPrice" DECIMAL(14,4),
    "targetPrice" DECIMAL(14,4),
    "partialPrice" DECIMAL(14,4),
    "partialQty" INTEGER NOT NULL DEFAULT 0,
    "trailActive" BOOLEAN NOT NULL DEFAULT false,
    "partialDone" BOOLEAN NOT NULL DEFAULT false,
    "highWater" DECIMAL(14,4),
    "lowWater" DECIMAL(14,4),
    "exitSeq" INTEGER NOT NULL DEFAULT 0,
    "exitReason" TEXT,
    "blindSince" TIMESTAMP(3),
    "openedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "core_positions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "core_positions_intentId_key" ON "core_positions"("intentId");
CREATE INDEX "core_positions_userId_status_idx" ON "core_positions"("userId", "status");
CREATE INDEX "core_positions_status_idx" ON "core_positions"("status");
CREATE INDEX "core_positions_userId_vehicle_token_idx" ON "core_positions"("userId", "vehicle", "token");
ALTER TABLE "core_positions" ADD CONSTRAINT "core_positions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "core_orders" ADD COLUMN "positionId" TEXT;
CREATE INDEX "core_orders_userId_positionId_idx" ON "core_orders"("userId", "positionId");
ALTER TABLE "core_orders" ADD CONSTRAINT "core_orders_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "core_positions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Vocabularies and shapes (lifecycle.types.ts; lifecycle-defaults.spec.ts checks the lists).
ALTER TABLE "core_positions" ADD CONSTRAINT "core_positions_vocab_check" CHECK (
    "vehicle" IN ('CASH_INTRADAY', 'MTF', 'OPTIONS_BUY')
    AND "side" IN ('BUY', 'SELL')
    AND "direction" IN ('LONG', 'SHORT')
    AND "status" IN ('PENDING_ENTRY', 'OPEN', 'PARTIAL', 'EXITING', 'CLOSED', 'CANCELLED')
    AND ("exitReason" IS NULL OR "exitReason" IN ('KILL_SWITCH', 'DAILY_LOSS', 'STOP', 'GAP_STOP', 'RECOVERY_STOP', 'UNDERLYING_STOP', 'GUARD_RAIL', 'MANUAL', 'TARGET', 'TRAIL', 'TIME_EXIT', 'THETA_STOP', 'EXPIRY_DAY', 'HOLD_LIMIT', 'SQUARE_OFF')));
ALTER TABLE "core_positions" ADD CONSTRAINT "core_positions_shape_check" CHECK (
    "requestedQty" > 0 AND "lotSize" > 0 AND "requestedQty" % "lotSize" = 0
    AND "entryFilledQty" >= 0 AND "entryFilledQty" <= "requestedQty"
    AND "exitFilledQty" >= 0 AND "exitFilledQty" <= "entryFilledQty"
    AND "partialQty" >= 0 AND "exitSeq" >= 0 AND "version" >= 0
    AND (("status" IN ('CLOSED', 'CANCELLED')) = ("closedAt" IS NOT NULL)));

-- core_paper_defaults: one optional pair, blindAfterMs@ALL (ruling L10). The fixed pairs are
-- copied unchanged from 20261011120000_sp2_m3_execution.
ALTER TABLE "core_paper_defaults" DROP CONSTRAINT "core_paper_defaults_pair_check";
ALTER TABLE "core_paper_defaults" ADD CONSTRAINT "core_paper_defaults_pair_check" CHECK (
    ("key", "scope") IN (
      ('startingCapital', 'ALL'), ('intradayLeverage', 'CASH_INTRADAY'),
      ('slippageBps', 'CASH_INTRADAY'), ('slippageBps', 'MTF'), ('slippageBps', 'OPTIONS_BUY'),
      ('noPriceRejectMs', 'ALL'), ('mtfFundedShare', 'MTF'), ('mtfAnnualRatePct', 'MTF'), ('mtfPledgeFee', 'MTF'),
      ('blindAfterMs', 'ALL'))
    OR ("key" = 'maxLotsPerOrder' AND "scope" ~ '^[A-Z0-9&-]{1,30}$' AND "scope" NOT IN ('ALL', 'CASH_INTRADAY', 'MTF', 'OPTIONS_BUY')));
ALTER TABLE "core_paper_defaults" DROP CONSTRAINT "core_paper_defaults_value_check";
ALTER TABLE "core_paper_defaults" ADD CONSTRAINT "core_paper_defaults_value_check" CHECK (
    "numValue" >= 0 AND "numValue" <> 'NaN'::numeric AND
    CASE "key"
      WHEN 'startingCapital' THEN "numValue" > 0
      WHEN 'intradayLeverage' THEN "numValue" >= 1
      WHEN 'slippageBps' THEN "numValue" <= 10000
      WHEN 'noPriceRejectMs' THEN "numValue" >= 1000 AND "numValue" = trunc("numValue")
      WHEN 'mtfFundedShare' THEN "numValue" < 1
      WHEN 'mtfAnnualRatePct' THEN "numValue" <= 100
      WHEN 'mtfPledgeFee' THEN true
      WHEN 'maxLotsPerOrder' THEN "numValue" >= 1 AND "numValue" = trunc("numValue")
      WHEN 'blindAfterMs' THEN "numValue" >= 1000 AND "numValue" = trunc("numValue")
      ELSE false
    END);

-- SEED BEGIN
-- Owner-editable (PUT /api/trade-core/paper/defaults/blindAfterMs/ALL). Listed for review in the M4 plan (O7).
INSERT INTO "core_paper_defaults" ("key", "scope", "numValue", "note") VALUES
    ('blindAfterMs', 'ALL', 30000, 'default — please review: an open core position with no fresh price this long is marked blind (O7)')
ON CONFLICT ("key", "scope") DO NOTHING;
-- SEED END
```

- [ ] **Step 6: Tenant model**

In `apps/api/src/common/tenant/tenant.constants.ts`, after `'CoreCashLedger',` add:

```typescript
  // SP2 M4: per-user core positions.
  'CorePosition',
```

- [ ] **Step 7: Regenerate the client and run the specs**

Run (from the repo root): `npx prisma generate --schema prisma/schema.prisma`
Run (from `apps/api`): `npx jest src/modules/trade-core/lifecycle/lifecycle-defaults.spec.ts src/modules/trade-core/execution/paper-settings.spec.ts src/modules/trade-core/execution/core-paper-defaults.spec.ts src/common/tenant`
Expected: PASS (the M3 seed spec is untouched and still green: `REQUIRED_PAPER_PAIRS` did not change).

- [ ] **Step 8: The opt-in database test**

Create `apps/api/test/sp2-m4/jest.config.js`:

```javascript
const path = require('path');

/**
 * Opt-in SQL tests for the SP2 M4 lifecycle table (CHECKs, the widened paper-default CHECKs,
 * the seed, cascades, and the CorePositionRepository) against a THROWAWAY local Postgres on
 * 127.0.0.1 with every migration applied. The default apps/api Jest config (rootDir: src)
 * never finds these.
 *
 * Run from apps/api:
 *   DATABASE_URL_TEST=postgresql://postgres:password@127.0.0.1:55434/grw_sp2m4_test \
 *     npx jest --config test/sp2-m4/jest.config.js -i
 */
module.exports = {
  rootDir: path.resolve(__dirname, '../..'),
  roots: ['<rootDir>/test/sp2-m4'],
  moduleFileExtensions: ['js', 'json', 'ts'],
  testRegex: '.*\\.spec\\.ts$',
  transform: { '^.+\\.(t|j)s$': ['ts-jest', { isolatedModules: true }] },
  testEnvironment: 'node',
};
```

Create `apps/api/test/sp2-m4/core-lifecycle.int.spec.ts`:

```typescript
import { PrismaClient } from '@prisma/client';

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error('DATABASE_URL_TEST must point at a throwaway database with all migrations applied');
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(url)) throw new Error('refusing to run against a database that is not on 127.0.0.1');

const db = new PrismaClient({ datasources: { db: { url } } });
const run = `it${Date.now()}`;
const rid = () => Math.random().toString(36).slice(2, 10);

async function newUser(): Promise<string> {
  const id = `usr_${run}_${rid()}`;
  await db.$executeRawUnsafe(`INSERT INTO "users" ("id", "email", "passwordHash", "updatedAt") VALUES ($1, $1 || '@it.local', 'x', CURRENT_TIMESTAMP)`, id);
  return id;
}

interface PositionOver {
  status?: string;
  requestedQty?: number;
  lotSize?: number;
  entryFilledQty?: number;
  exitFilledQty?: number;
  closedAt?: string | null;
  exitReason?: string | null;
}

async function insertPosition(userId: string, o: PositionOver = {}): Promise<string> {
  const id = `pos_${rid()}`;
  await db.$executeRawUnsafe(
    `INSERT INTO "core_positions" ("id", "userId", "intentId", "strategyId", "strategyVersionId", "vehicle", "exchange", "token", "symbol", "lotSize", "underlying", "side", "direction", "status", "requestedQty", "entryFilledQty", "exitFilledQty", "plan", "exitReason", "closedAt", "updatedAt")
     VALUES ($1, $2, $1, 'cs_x', 'csv_x', 'CASH_INTRADAY', 'NSE', '2885', 'RELIANCE-EQ', $3, 'RELIANCE', 'BUY', 'LONG', $4, $5, $6, $7, '{}'::jsonb, $8, $9::timestamp, CURRENT_TIMESTAMP)`,
    id, userId, o.lotSize ?? 1, o.status ?? 'OPEN', o.requestedQty ?? 100, o.entryFilledQty ?? 100, o.exitFilledQty ?? 0, o.exitReason ?? null, o.closedAt ?? null,
  );
  return id;
}

afterAll(async () => {
  await db.$executeRawUnsafe(`DELETE FROM "users" WHERE "id" LIKE $1`, `usr_${run}_%`);
  await db.$disconnect();
});

describe('core_positions (SP2 M4 migration)', () => {
  it('accepts a valid row and refuses an unknown status or exit reason', async () => {
    const u = await newUser();
    await expect(insertPosition(u)).resolves.toMatch(/^pos_/);
    await expect(insertPosition(u, { status: 'HALF_OPEN' })).rejects.toThrow(/core_positions_vocab_check/);
    await expect(insertPosition(u, { status: 'EXITING', exitReason: 'BORED' })).rejects.toThrow(/core_positions_vocab_check/);
  });

  it('refuses quantities that do not add up, and a terminal status without closedAt (and the reverse)', async () => {
    const u = await newUser();
    await expect(insertPosition(u, { exitFilledQty: 101 })).rejects.toThrow(/core_positions_shape_check/);
    await expect(insertPosition(u, { entryFilledQty: 101 })).rejects.toThrow(/core_positions_shape_check/);
    await expect(insertPosition(u, { lotSize: 75, requestedQty: 100 })).rejects.toThrow(/core_positions_shape_check/);
    await expect(insertPosition(u, { status: 'CLOSED' })).rejects.toThrow(/core_positions_shape_check/);
    await expect(insertPosition(u, { status: 'OPEN', closedAt: '2026-10-12 10:00:00' })).rejects.toThrow(/core_positions_shape_check/);
    await expect(insertPosition(u, { status: 'CLOSED', exitFilledQty: 100, closedAt: '2026-10-12 10:00:00', exitReason: 'STOP' })).resolves.toMatch(/^pos_/);
  });

  it('the intent id is unique', async () => {
    const u = await newUser();
    const id = await insertPosition(u);
    await expect(
      db.$executeRawUnsafe(
        `INSERT INTO "core_positions" ("id", "userId", "intentId", "strategyId", "strategyVersionId", "vehicle", "exchange", "token", "symbol", "lotSize", "underlying", "side", "direction", "status", "requestedQty", "plan", "updatedAt")
         VALUES ($1, $2, $3, 'cs_x', 'csv_x', 'CASH_INTRADAY', 'NSE', '2885', 'RELIANCE-EQ', 1, 'RELIANCE', 'BUY', 'LONG', 'PENDING_ENTRY', 100, '{}'::jsonb, CURRENT_TIMESTAMP)`,
        `pos_${rid()}`, u, id,
      ),
    ).rejects.toThrow(/core_positions_intentId_key/);
  });

  it('core_orders.positionId is nullable and set to null when its position is deleted; deleting the user cascades', async () => {
    const u = await newUser();
    const pos = await insertPosition(u);
    const ord = `ord_${rid()}`;
    await db.$executeRawUnsafe(
      `INSERT INTO "core_orders" ("id", "userId", "idempotencyKey", "vehicle", "exchange", "token", "symbol", "lotSize", "side", "qty", "type", "refPrice", "purpose", "state", "submittedAt", "updatedAt", "positionId")
       VALUES ($1, $2, $1, 'CASH_INTRADAY', 'NSE', '2885', 'RELIANCE-EQ', 1, 'BUY', 100, 'MARKET', 500, 'ENTRY', 'OPEN', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, $3)`,
      ord, u, pos,
    );
    await db.$executeRawUnsafe(`DELETE FROM "core_positions" WHERE "id" = $1`, pos);
    const [row] = await db.$queryRawUnsafe<Array<{ positionId: string | null }>>(`SELECT "positionId" FROM "core_orders" WHERE "id" = $1`, ord);
    expect(row.positionId).toBeNull();
    const kept = await insertPosition(u);
    await db.$executeRawUnsafe(`DELETE FROM "users" WHERE "id" = $1`, u);
    const left = await db.$queryRawUnsafe<unknown[]>(`SELECT 1 FROM "core_positions" WHERE "id" = $1`, kept);
    expect(left).toHaveLength(0);
  });
});

describe('core_paper_defaults (widened by M4)', () => {
  it('holds the blindAfterMs seed and refuses a value below 1000 ms or another scope', async () => {
    const [row] = await db.$queryRawUnsafe<Array<{ numValue: string }>>(`SELECT "numValue"::text AS "numValue" FROM "core_paper_defaults" WHERE "key" = 'blindAfterMs' AND "scope" = 'ALL'`);
    expect(Number(row.numValue)).toBe(30000);
    await expect(db.$executeRawUnsafe(`UPDATE "core_paper_defaults" SET "numValue" = 999 WHERE "key" = 'blindAfterMs' AND "scope" = 'ALL'`)).rejects.toThrow(/core_paper_defaults_value_check/);
    await expect(
      db.$executeRawUnsafe(`INSERT INTO "core_paper_defaults" ("key", "scope", "numValue", "note") VALUES ('blindAfterMs', 'MTF', 30000, 'x')`),
    ).rejects.toThrow(/core_paper_defaults_pair_check/);
  });
});
```

Run (throwaway database, from the repo root, PowerShell):

```powershell
docker run -d --name grw-sp2m4-test -e POSTGRES_PASSWORD=password -e POSTGRES_DB=grw_sp2m4_test -p 127.0.0.1:55434:5432 postgres:16
$env:DATABASE_URL = 'postgresql://postgres:password@127.0.0.1:55434/grw_sp2m4_test'
npx prisma migrate deploy --schema prisma/schema.prisma
Push-Location apps/api; $env:DATABASE_URL_TEST = $env:DATABASE_URL; npx jest --config test/sp2-m4/jest.config.js -i; Pop-Location
npx prisma migrate diff --from-url $env:DATABASE_URL --to-schema-datamodel prisma/schema.prisma --exit-code
```

Expected: every migration applies; the opt-in suite PASSES; `migrate diff` exits 0 with "No difference detected" (the CHECKs are invisible to Prisma, as in M2/M3). Leave the container for Task 7, then `docker rm -f grw-sp2m4-test`.

- [ ] **Step 9: Commit**

```bash
git add -- prisma/schema.prisma prisma/migrations/20261012120000_sp2_m4_lifecycle/migration.sql apps/api/src/common/tenant/tenant.constants.ts apps/api/src/modules/trade-core/execution/paper-settings.ts apps/api/src/modules/trade-core/execution/paper-settings.spec.ts apps/api/src/modules/trade-core/lifecycle/lifecycle-defaults.spec.ts apps/api/test/sp2-m4/jest.config.js apps/api/test/sp2-m4/core-lifecycle.int.spec.ts
git commit -m "feat(trade-core): core_positions table, order positionId and the blindAfterMs paper default" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- prisma/schema.prisma prisma/migrations/20261012120000_sp2_m4_lifecycle/migration.sql apps/api/src/common/tenant/tenant.constants.ts apps/api/src/modules/trade-core/execution/paper-settings.ts apps/api/src/modules/trade-core/execution/paper-settings.spec.ts apps/api/src/modules/trade-core/lifecycle/lifecycle-defaults.spec.ts apps/api/test/sp2-m4/jest.config.js apps/api/test/sp2-m4/core-lifecycle.int.spec.ts
```

(Stream B without Task 1 merged: copy Task 1 Step 1's `lifecycle.types.ts` verbatim before Step 1 of this task, and leave it out of this commit; the join takes Stream A's copy.)

---

### Task 6: Execution seams — `positionId`, order updates, position orders, per-position P&L, entries-only square-off

**Files:**
- Create: `apps/api/src/modules/trade-core/execution/order-events.ts`
- Modify: `apps/api/src/modules/trade-core/execution/execution.types.ts`
- Modify: `apps/api/src/modules/trade-core/execution/repositories/core-order.repository.ts`
- Modify: `apps/api/src/modules/trade-core/execution/paper-ledger.service.ts`
- Modify: `apps/api/src/modules/trade-core/execution/paper-execution.adapter.ts`
- Modify: `apps/api/src/modules/trade-core/execution/paper-order-square-off.ts`
- Modify: `apps/api/src/modules/trade-core/execution/testing/memory-paper-store.ts`
- Modify: `apps/api/src/modules/trade-core/trade-core.module.ts` (one provider)
- Modify: `apps/api/src/modules/trade-core/execution/execution-ports.spec.ts`
- Test: `apps/api/src/modules/trade-core/execution/paper-ledger.events.spec.ts`

**Interfaces:**
- Consumes: M3's `PaperLedgerService`, `CoreOrderRepository`, `MemoryPaperStore`, fixtures `cashBuy`, `NOW`, `depth`.
- Produces: `CoreOrderRequest.positionId?: string | null`; `CoreOrder.positionId?: string | null`; `ExecutionAdapter.onOrderUpdate(listener: (order: CoreOrder) => void): () => void`; `ExecutionAdapter.listPositionOrders(userId: string, positionId: string): Promise<CoreOrder[]>`; `CoreOrderEvents` (`subscribe`, `emit`, `listenerCount`); `PaperLedgerService.onOrderUpdate(fn)`, `.listPositionOrders(userId, positionId)`, `.netPnlTodayByPosition(userId, now): Promise<Map<string, Prisma.Decimal>>`; `CoreOrderRepository.listForPositionId(userId, positionId, db?)`; `PaperOrderSquareOff` cancels ENTRY orders only.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/modules/trade-core/execution/paper-ledger.events.spec.ts`:

```typescript
import type { ModuleRef } from '@nestjs/core';
import { Prisma } from '@prisma/client';
import type { CoreKillSwitchService } from '../risk-wall/services/core-kill-switch.service';
import type { CoreOrder } from './execution.types';
import { CoreOrderEvents } from './order-events';
import { PaperExecutionAdapter } from './paper-execution.adapter';
import { PaperLedgerService, type PlaceContext } from './paper-ledger.service';
import { PaperMatcherService } from './paper-matcher.service';
import { FakeHub, fakeHubSource, fakeModuleRef } from './testing/fake-hub';
import { fakeDefaults, MemoryPaperStore } from './testing/memory-paper-store';
import { cashBuy, NOW } from './testing/paper-fixtures';

const OPEN: PlaceContext = { sessionOpen: true, killSwitchActive: false };
const D = (s: string) => new Prisma.Decimal(s);

function setup() {
  const store = new MemoryPaperStore(() => NOW);
  const events = new CoreOrderEvents();
  const defaults = fakeDefaults();
  const ledger = new PaperLedgerService(store.tx, store.orderRepo, store.fillRepo, store.ledgerRepo, defaults, events);
  const seen: CoreOrder[] = [];
  events.subscribe((o) => seen.push(o));
  return { store, events, ledger, defaults, seen };
}

describe('order updates (ruling L3)', () => {
  it('emits once per committed placement, fill and cancel, carrying the positionId', async () => {
    const { ledger, seen } = setup();
    const placed = (await ledger.place(cashBuy({ positionId: 'pos_1' }), OPEN, NOW)).order;
    expect(placed.positionId).toBe('pos_1');
    const filled = await ledger.applyFill('user_A', placed.id, placed, { qty: 40, price: D('500'), priceAt: new Date(NOW.getTime() + 5) }, NOW);
    expect(filled?.state).toBe('PARTIAL');
    await ledger.close('user_A', placed.id, 'CANCEL', 'test');
    expect(seen.map((o) => [o.state, o.filledQty, o.positionId])).toEqual([
      ['OPEN', 0, 'pos_1'],
      ['PARTIAL', 40, 'pos_1'],
      ['CANCELLED', 40, 'pos_1'],
    ]);
  });

  it('a placement replay and a refused fill emit nothing', async () => {
    const { ledger, seen } = setup();
    const placed = (await ledger.place(cashBuy(), OPEN, NOW)).order;
    await ledger.place(cashBuy(), OPEN, NOW);
    expect(await ledger.applyFill('user_A', placed.id, { ...placed, filledQty: 7 }, { qty: 10, price: D('500'), priceAt: NOW }, NOW)).toBeNull();
    expect(seen).toHaveLength(1);
  });

  it('a throwing listener never fails the write', async () => {
    const { ledger, events, seen } = setup();
    events.subscribe(() => {
      throw new Error('listener bug');
    });
    await expect(ledger.place(cashBuy(), OPEN, NOW)).resolves.toMatchObject({ created: true });
    expect(seen).toHaveLength(1);
  });

  it('the adapter exposes the stream and the position orders; unsubscribe stops delivery', async () => {
    const { ledger, defaults } = setup();
    const matcher = new PaperMatcherService(ledger, defaults, fakeModuleRef(fakeHubSource({ user_A: new FakeHub() })) as unknown as ModuleRef, { isOpen: () => true });
    const adapter = new PaperExecutionAdapter(ledger, matcher, { isActive: async () => false } as unknown as CoreKillSwitchService, { isOpen: () => true });
    const got: string[] = [];
    const off = adapter.onOrderUpdate((o) => got.push(o.idempotencyKey));
    await adapter.placeOrder(cashBuy({ positionId: 'pos_1' }));
    off();
    await adapter.placeOrder(cashBuy({ idempotencyKey: 'other:entry', instrument: { exchange: 'NSE', token: '1594', symbol: 'INFY-EQ', lotSize: 1, underlying: null } }));
    expect(got).toEqual(['intent_cash_1:entry']);
    expect((await adapter.listPositionOrders('user_A', 'pos_1')).map((o) => o.idempotencyKey)).toEqual(['intent_cash_1:entry']);
    expect(await adapter.listPositionOrders('user_B', 'pos_1')).toEqual([]);
  });
});

describe('netPnlTodayByPosition', () => {
  it("sums today's realised P&L and charges of each position's orders", async () => {
    const { ledger } = setup();
    const entry = (await ledger.place(cashBuy({ positionId: 'pos_1' }), OPEN, NOW)).order;
    await ledger.applyFill('user_A', entry.id, entry, { qty: 100, price: D('500'), priceAt: NOW }, NOW);
    const exit = (await ledger.place(cashBuy({ idempotencyKey: 'intent_cash_1:exit:1', purpose: 'EXIT', side: 'SELL', positionId: 'pos_1', refPrice: 510 }), OPEN, NOW)).order;
    await ledger.applyFill('user_A', exit.id, exit, { qty: 100, price: D('510'), priceAt: NOW }, NOW);
    const byPos = await ledger.netPnlTodayByPosition('user_A', NOW);
    const funds = await ledger.funds('user_A');
    expect([...byPos.keys()]).toEqual(['pos_1']);
    // gross 1000.00 minus both legs' charges = the user's realised minus charges
    expect(byPos.get('pos_1')?.toFixed(2)).toBe(D(funds.realisedPnl).minus(D(funds.charges)).toFixed(2));
    expect(await ledger.netPnlTodayByPosition('user_A', new Date(NOW.getTime() + 86_400_000))).toEqual(new Map());
  });
});
```

Add to `apps/api/src/modules/trade-core/execution/execution-ports.spec.ts`, in `describe('CORE_SQUARE_OFF (paper)')`:

```typescript
  it('leaves exit orders alone: they are the square-off of open positions (ruling L14)', async () => {
    const { store, ledger, squareOff } = setup();
    const entry = (await ledger.place(cashBuy(), OPEN, NOW)).order;
    await ledger.applyFill('user_A', entry.id, entry, { qty: 100, price: D('500'), priceAt: NOW }, NOW);
    const exit = (await ledger.place(cashBuy({ idempotencyKey: 'intent_cash_1:exit:1', purpose: 'EXIT', side: 'SELL', type: 'LIMIT', limitPrice: 600 }), OPEN, NOW)).order;
    const pending = (await ledger.place(optionBuy(), OPEN, NOW)).order;
    expect(await squareOff.squareOffAll('user_A', 'KILL_SWITCH', 'stop')).toEqual({ cancelledOrders: 1, exitsRequested: 0, detail: '1 pending core entry order(s) cancelled' });
    expect(store.orders.find((o) => o.id === exit.id)?.state).toBe('OPEN');
    expect(store.orders.find((o) => o.id === pending.id)?.state).toBe('CANCELLED');
  });
```

and update the three existing expectations in that file:
- `detail: '2 pending core order(s) cancelled; open core positions are exited by the lifecycle (M4), none in M3'` → `detail: '2 pending core entry order(s) cancelled'`
- `.rejects.toThrow('cancelled 1 of 2 pending core orders; failed: ')` → `.rejects.toThrow('cancelled 1 of 2 pending core entry orders; failed: ')`
- the kill-switch cascade `detail: '2 pending core order(s) cancelled; open core positions are exited by the lifecycle (M4), none in M3 (cancelled 2 orders, requested 0 exits)'` → `detail: '2 pending core entry order(s) cancelled (cancelled 2 orders, requested 0 exits)'`

- [ ] **Step 2: Run them to see them fail**

Run: `npx jest src/modules/trade-core/execution/paper-ledger.events.spec.ts src/modules/trade-core/execution/execution-ports.spec.ts`
Expected: FAIL ("Cannot find module './order-events'"; the detail strings differ).

- [ ] **Step 3: The emitter**

Create `apps/api/src/modules/trade-core/execution/order-events.ts`:

```typescript
import { Injectable, Logger } from '@nestjs/common';
import type { CoreOrder } from './execution.types';

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * SP2 M4 ruling L3: every committed core order change, in process. PaperLedgerService
 * emits after its transaction commits; the lifecycle listens. A listener that throws is
 * logged and never reaches the writer. Delivery is best effort: the lifecycle also
 * re-reads its positions' orders every 5 s.
 */
@Injectable()
export class CoreOrderEvents {
  private readonly logger = new Logger(CoreOrderEvents.name);
  private readonly listeners = new Set<(order: CoreOrder) => void>();

  subscribe(fn: (order: CoreOrder) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  emit(order: CoreOrder): void {
    for (const fn of [...this.listeners]) {
      try {
        fn(order);
      } catch (err) {
        this.logger.error(`core order ${order.id}: an update listener failed: ${errorText(err)}`);
      }
    }
  }

  listenerCount(): number {
    return this.listeners.size;
  }
}
```

- [ ] **Step 4: Types, repository and memory store**

In `apps/api/src/modules/trade-core/execution/execution.types.ts`:
- in `CoreOrderRequest`, after `strategyVersionId: string | null;` add:

```typescript
  /** SP2 M4: the core position this order belongs to; absent or null outside the lifecycle. */
  positionId?: string | null;
```

- in `CoreOrder`, after `strategyVersionId: string | null;` add the same field with the doc `/** SP2 M4: the owning core position, or null. */`.
- in `ExecutionAdapter`, after `getFunds`, add:

```typescript
  /**
   * SP2 M4 (drift D2): every committed change of any core order (placement, fill, trigger,
   * modify, cancel, reject). Returns the unsubscribe. A live adapter (SP7) feeds it from
   * broker order updates.
   */
  onOrderUpdate(listener: (order: CoreOrder) => void): () => void;
  /** SP2 M4: the user's orders of one core position, oldest first. */
  listPositionOrders(userId: string, positionId: string): Promise<CoreOrder[]>;
```

In `apps/api/src/modules/trade-core/execution/repositories/core-order.repository.ts`:
- add `positionId?: string | null;` as the last field of `NewOrderRow`;
- in `toCoreOrder`, after `strategyVersionId: r.strategyVersionId,` add `positionId: r.positionId,`;
- after `listForPosition`, add:

```typescript
  /** SP2 M4: one core position's orders. */
  async listForPositionId(userId: string, positionId: string, db: PaperDb = this.prisma): Promise<CoreOrder[]> {
    return (await db.coreOrder.findMany({ where: { userId, positionId }, orderBy: OLDEST_FIRST })).map(toCoreOrder);
  }
```

In `apps/api/src/modules/trade-core/execution/testing/memory-paper-store.ts`:
- in `orderRepo.create`, after `strategyVersionId: data.strategyVersionId,` add `positionId: data.positionId ?? null,`;
- after `listForPosition`, add:

```typescript
    listForPositionId: async (userId: string, positionId: string, db?: PaperDb) => {
      this.read('listForPositionId', db);
      return this.orders.filter((o) => o.userId === userId && o.positionId === positionId).map(copy);
    },
```

- [ ] **Step 5: The ledger emits, lists and attributes**

In `apps/api/src/modules/trade-core/execution/paper-ledger.service.ts`:

1. Imports: add `Optional` to the `@nestjs/common` import and `import { CoreOrderEvents } from './order-events';`.
2. Constructor: add a last parameter `@Optional() private readonly events: CoreOrderEvents = new CoreOrderEvents(),` (M3's specs construct the service with five arguments and keep working).
3. In `place`, inside the `try`, change `return await this.tx.run(req.userId, async (db) => {` to `const r = await this.tx.run(req.userId, async (db) => {`, and immediately after that call's closing `});` (just before `} catch (err) {`) add:

```typescript
      if (r.created) this.events.emit(r.order);
      return r;
```

4. In `place`'s `this.orders.create({ … })` object, after `strategyVersionId: req.strategyVersionId,` add `positionId: req.positionId ?? null,`.
5. In `close`, `applyFill`, `markTriggered` and `modify`, wrap the returned transaction: `return this.tx.run(userId, async (db) => {` becomes `return this.emitted(this.tx.run(userId, async (db) => {`, and that call's closing `});` becomes `}));`.
6. Add these members to the class (after `openOrdersForUser`):

```typescript
  /** SP2 M4 (ruling L3): every committed order change; returns the unsubscribe. */
  onOrderUpdate(fn: (order: CoreOrder) => void): () => void {
    return this.events.subscribe(fn);
  }

  /** SP2 M4: one core position's orders, oldest first. */
  listPositionOrders(userId: string, positionId: string): Promise<CoreOrder[]> {
    return this.orders.listForPositionId(userId, positionId);
  }

  /**
   * SP2 M4: today's (IST) net realised P&L per core position: REALISED_PNL plus CHARGES rows
   * of the position's orders. MTF interest is per holding (token), not per position, so it
   * counts in dayStats' user total only.
   */
  async netPnlTodayByPosition(userId: string, now: Date): Promise<Map<string, Dec>> {
    const day = istDate(now);
    const [rows, orders] = await Promise.all([this.ledger.listForUser(userId), this.orders.listForUser(userId)]);
    const positionOf = new Map(orders.filter((o) => o.positionId).map((o) => [o.id, o.positionId as string]));
    const out = new Map<string, Dec>();
    for (const r of rows) {
      if ((r.type !== 'REALISED_PNL' && r.type !== 'CHARGES') || r.orderId === null || istDate(r.createdAt) !== day) continue;
      const pid = positionOf.get(r.orderId);
      if (pid) out.set(pid, (out.get(pid) ?? ZERO).plus(r.amount));
    }
    return out;
  }

  /** Emit a committed order (null: nothing was written). */
  private async emitted<T extends CoreOrder | null>(write: Promise<T>): Promise<T> {
    const o = await write;
    if (o) this.events.emit(o);
    return o;
  }
```

7. In `apps/api/src/modules/trade-core/execution/paper-execution.adapter.ts`, after `getFunds`, add:

```typescript
  onOrderUpdate(listener: (order: CoreOrder) => void): () => void {
    return this.ledger.onOrderUpdate(listener);
  }

  listPositionOrders(userId: string, positionId: string): Promise<CoreOrder[]> {
    return this.ledger.listPositionOrders(userId, positionId);
  }
```

8. In `apps/api/src/modules/trade-core/trade-core.module.ts`, import `CoreOrderEvents` from `./execution/order-events` and add it to `providers` before `PaperLedgerService` (so the ledger and the lifecycle share one emitter).

- [ ] **Step 6: Entries-only square-off**

Replace the body of `squareOffAll` in `apps/api/src/modules/trade-core/execution/paper-order-square-off.ts`, and its class comment's last sentences, with:

```typescript
  async squareOffAll(userId: string, cause: CoreSquareOffCause, reason: string): Promise<CoreSquareOffResult> {
    // SP2 M4 (ruling L14): EXIT orders are the square-off of open positions; cancelling them would undo it.
    const open = (await this.ledger.openOrdersForUser(userId)).filter((o) => o.purpose === 'ENTRY');
    const failures: string[] = [];
    let cancelled = 0;
    for (const o of open) {
      try {
        const c = await this.ledger.close(userId, o.id, 'CANCEL', `${cause}: ${reason}`);
        // A closed copy untracks and releases the P0 watch; an open one replaces the held copy.
        this.matcher.refresh(c);
        if (c.state === 'CANCELLED') cancelled += 1;
      } catch (err) {
        failures.push(`${o.id}: ${errorText(err)}`);
      }
    }
    if (failures.length > 0) {
      throw new Error(`cancelled ${cancelled} of ${open.length} pending core entry orders; failed: ${failures.join('; ')}`);
    }
    return { cancelledOrders: cancelled, exitsRequested: 0, detail: `${cancelled} pending core entry order(s) cancelled` };
  }
```

(Class comment: "CORE_SQUARE_OFF's entry half: cancels every pending core ENTRY order of the user … SP2 M4's `CoreSquareOff` composes it with the lifecycle's exits.")

- [ ] **Step 7: Run the execution suites**

Run: `npx jest src/modules/trade-core/execution src/modules/trade-core/trade-core.module.spec.ts`
Expected: PASS — the new spec, the updated ports spec, and every M3 suite unchanged (M3 specs build `CoreOrder` literals without `positionId`, which is optional).

- [ ] **Step 8: Commit**

```bash
git add -- apps/api/src/modules/trade-core/execution/order-events.ts apps/api/src/modules/trade-core/execution/execution.types.ts apps/api/src/modules/trade-core/execution/repositories/core-order.repository.ts apps/api/src/modules/trade-core/execution/paper-ledger.service.ts apps/api/src/modules/trade-core/execution/paper-execution.adapter.ts apps/api/src/modules/trade-core/execution/paper-order-square-off.ts apps/api/src/modules/trade-core/execution/testing/memory-paper-store.ts apps/api/src/modules/trade-core/execution/execution-ports.spec.ts apps/api/src/modules/trade-core/execution/paper-ledger.events.spec.ts apps/api/src/modules/trade-core/trade-core.module.ts
git commit -m "feat(trade-core): order update stream, position orders and entries-only square-off for the lifecycle" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/api/src/modules/trade-core/execution/order-events.ts apps/api/src/modules/trade-core/execution/execution.types.ts apps/api/src/modules/trade-core/execution/repositories/core-order.repository.ts apps/api/src/modules/trade-core/execution/paper-ledger.service.ts apps/api/src/modules/trade-core/execution/paper-execution.adapter.ts apps/api/src/modules/trade-core/execution/paper-order-square-off.ts apps/api/src/modules/trade-core/execution/testing/memory-paper-store.ts apps/api/src/modules/trade-core/execution/execution-ports.spec.ts apps/api/src/modules/trade-core/execution/paper-ledger.events.spec.ts apps/api/src/modules/trade-core/trade-core.module.ts
```

---

### Task 7: `CorePositionRepository` and its in-memory twin

**Files:**
- Create: `apps/api/src/modules/trade-core/lifecycle/repositories/core-position.repository.ts`
- Create: `apps/api/src/modules/trade-core/lifecycle/testing/memory-position-store.ts`
- Test: `apps/api/src/modules/trade-core/lifecycle/testing/memory-position-store.spec.ts`
- Modify: `apps/api/test/sp2-m4/core-lifecycle.int.spec.ts` (append the repository block)

**Interfaces:**
- Consumes: `CorePosition`, `NewPositionRow`, `PositionPatch`, `ACTIVE_STATUSES`, `ExitPlan`, `ExitReason`, `CorePositionStatus` (Task 1); Prisma `CorePosition` (Task 5).
- Produces: `ActivePositionExistsError` (`existingId`); `toCorePosition(row)`; `CorePositionRepository` with `createIfNoActive(row): Promise<CorePosition>`, `findByIntent(intentId)`, `findForUser(userId, id)`, `listActive()`, `listActiveUserIds()`, `listForUser(userId, since: Date | null)`, `update(userId, id, expectVersion, patch): Promise<CorePosition | null>`; `MemoryPositionStore` (`rows`, `repo`) with the same contract.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/modules/trade-core/lifecycle/testing/memory-position-store.spec.ts`:

```typescript
import { ActivePositionExistsError } from '../repositories/core-position.repository';
import { cashPlan, NOW } from './lifecycle-fixtures';
import { MemoryPositionStore } from './memory-position-store';
import type { NewPositionRow } from '../lifecycle.types';

const row = (over: Partial<NewPositionRow> = {}): NewPositionRow => ({
  userId: 'user_A',
  intentId: 'int_1',
  strategyId: 'cs_ungated',
  strategyVersionId: 'csv_ungated_v1',
  vehicle: 'CASH_INTRADAY',
  instrument: { exchange: 'NSE', token: '2885', symbol: 'RELIANCE-EQ', lotSize: 1, underlying: null },
  underlying: 'RELIANCE',
  side: 'BUY',
  direction: 'LONG',
  requestedQty: 100,
  plan: cashPlan(),
  ...over,
});

describe('MemoryPositionStore (the CorePositionRepository contract)', () => {
  it('creates PENDING_ENTRY with version 0 and nothing filled', async () => {
    const s = new MemoryPositionStore(() => NOW);
    const p = await s.repo.createIfNoActive(row());
    expect(p).toMatchObject({ status: 'PENDING_ENTRY', version: 0, entryFilledQty: 0, exitFilledQty: 0, openQty: 0, exitSeq: 0, underlying: 'RELIANCE' });
    expect(await s.repo.findByIntent('int_1')).toEqual(p);
  });

  it('refuses a second active position on the same instrument, and allows one after it closes', async () => {
    const s = new MemoryPositionStore(() => NOW);
    const p = await s.repo.createIfNoActive(row());
    await expect(s.repo.createIfNoActive(row({ intentId: 'int_2' }))).rejects.toBeInstanceOf(ActivePositionExistsError);
    await expect(s.repo.createIfNoActive(row({ intentId: 'int_3', userId: 'user_B' }))).resolves.toMatchObject({ userId: 'user_B' });
    await s.repo.update('user_A', p.id, 0, { status: 'CANCELLED', closedAt: NOW });
    await expect(s.repo.createIfNoActive(row({ intentId: 'int_4' }))).resolves.toMatchObject({ intentId: 'int_4' });
  });

  it('updates only at the expected version, bumps it, and recomputes openQty', async () => {
    const s = new MemoryPositionStore(() => NOW);
    const p = await s.repo.createIfNoActive(row());
    const u = await s.repo.update('user_A', p.id, 0, { status: 'OPEN', entryFilledQty: 100, entryAvgPrice: 500 });
    expect(u).toMatchObject({ version: 1, openQty: 100, status: 'OPEN' });
    expect(await s.repo.update('user_A', p.id, 0, { status: 'EXITING' })).toBeNull();
    expect(await s.repo.update('user_B', p.id, 1, { status: 'EXITING' })).toBeNull();
  });

  it("scopes reads to the user; system scans see every user's active positions", async () => {
    const s = new MemoryPositionStore(() => NOW);
    const a = await s.repo.createIfNoActive(row());
    await s.repo.createIfNoActive(row({ intentId: 'int_b', userId: 'user_B' }));
    expect(await s.repo.findForUser('user_B', a.id)).toBeNull();
    expect((await s.repo.listActive()).map((p) => p.userId)).toEqual(['user_A', 'user_B']);
    expect(await s.repo.listActiveUserIds()).toEqual(['user_A', 'user_B']);
    await s.repo.update('user_A', a.id, 0, { status: 'CANCELLED', closedAt: NOW });
    expect(await s.repo.listActiveUserIds()).toEqual(['user_B']);
    expect((await s.repo.listForUser('user_A', new Date(NOW.getTime() - 1000))).map((p) => p.id)).toEqual([a.id]);
    expect(await s.repo.listForUser('user_A', new Date(NOW.getTime() + 1000))).toEqual([]);
  });

  it('returns copies', async () => {
    const s = new MemoryPositionStore(() => NOW);
    const p = await s.repo.createIfNoActive(row());
    p.plan.stopPct = 99;
    expect((await s.repo.findForUser('user_A', p.id))?.plan.stopPct).toBe(1.5);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx jest src/modules/trade-core/lifecycle/testing/memory-position-store.spec.ts`
Expected: FAIL, "Cannot find module '../repositories/core-position.repository'".

- [ ] **Step 3: The repository**

Create `apps/api/src/modules/trade-core/lifecycle/repositories/core-position.repository.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { Prisma, type CorePosition as CorePositionRow } from '@prisma/client';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import type { OrderSide } from '../../execution/execution.types';
import type { Direction } from '../../risk-wall/risk-wall.types';
import type { Vehicle } from '../../strategies/blocks/block-types';
import { ACTIVE_STATUSES, type CorePosition, type CorePositionStatus, type ExitPlan, type ExitReason, type NewPositionRow, type PositionPatch } from '../lifecycle.types';

export class ActivePositionExistsError extends Error {
  constructor(readonly existingId: string) {
    super(`an active core position (${existingId}) already exists on this instrument for this user`);
    this.name = 'ActivePositionExistsError';
  }
}

const num = (d: Prisma.Decimal | null): number | null => (d === null ? null : d.toNumber());
const PRICE_FIELDS = ['entryAvgPrice', 'initialStopPrice', 'stopPrice', 'targetPrice', 'partialPrice', 'highWater', 'lowWater'] as const;

export function toCorePosition(r: CorePositionRow): CorePosition {
  const vehicle = r.vehicle as Vehicle;
  return {
    id: r.id,
    userId: r.userId,
    intentId: r.intentId,
    strategyId: r.strategyId,
    strategyVersionId: r.strategyVersionId,
    vehicle,
    instrument: { exchange: r.exchange, token: r.token, symbol: r.symbol, lotSize: r.lotSize, underlying: vehicle === 'OPTIONS_BUY' ? r.underlying : null },
    underlying: r.underlying,
    side: r.side as OrderSide,
    direction: r.direction as Direction,
    status: r.status as CorePositionStatus,
    requestedQty: r.requestedQty,
    entryFilledQty: r.entryFilledQty,
    exitFilledQty: r.exitFilledQty,
    openQty: r.entryFilledQty - r.exitFilledQty,
    entryAvgPrice: num(r.entryAvgPrice),
    plan: r.plan as unknown as ExitPlan,
    initialStopPrice: num(r.initialStopPrice),
    stopPrice: num(r.stopPrice),
    targetPrice: num(r.targetPrice),
    partialPrice: num(r.partialPrice),
    partialQty: r.partialQty,
    trailActive: r.trailActive,
    partialDone: r.partialDone,
    highWater: num(r.highWater),
    lowWater: num(r.lowWater),
    exitSeq: r.exitSeq,
    exitReason: r.exitReason as ExitReason | null,
    blindSince: r.blindSince,
    openedAt: r.openedAt,
    closedAt: r.closedAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    version: r.version,
  };
}

function patchData(p: PositionPatch): Prisma.CorePositionUpdateManyMutationInput {
  const data: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) {
    if (v === undefined) continue;
    data[k] = (PRICE_FIELDS as readonly string[]).includes(k) && v !== null ? new Prisma.Decimal(v as number) : v;
  }
  return data as Prisma.CorePositionUpdateManyMutationInput;
}

/**
 * core_positions (spec §7.1). Every per-user query names the userId; listActive and
 * listActiveUserIds are the two system scans (boot recovery, the daily-loss monitor).
 * Updates are guarded by `version` (ruling L11); creation holds the user's position lock so
 * two intents can never open two active positions on one instrument.
 */
@Injectable()
export class CorePositionRepository {
  constructor(private readonly prisma: PrismaService) {}

  async createIfNoActive(row: NewPositionRow): Promise<CorePosition> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`core_position:${row.userId}`}, 0))`;
      const active = await tx.corePosition.findFirst({
        where: { userId: row.userId, exchange: row.instrument.exchange.toUpperCase(), token: row.instrument.token, status: { in: [...ACTIVE_STATUSES] } },
        select: { id: true },
      });
      if (active) throw new ActivePositionExistsError(active.id);
      const created = await tx.corePosition.create({
        data: {
          userId: row.userId,
          intentId: row.intentId,
          strategyId: row.strategyId,
          strategyVersionId: row.strategyVersionId,
          vehicle: row.vehicle,
          exchange: row.instrument.exchange.toUpperCase(),
          token: row.instrument.token,
          symbol: row.instrument.symbol,
          lotSize: row.instrument.lotSize,
          underlying: row.underlying,
          side: row.side,
          direction: row.direction,
          status: 'PENDING_ENTRY',
          requestedQty: row.requestedQty,
          plan: row.plan as unknown as Prisma.InputJsonValue,
        },
      });
      return toCorePosition(created);
    });
  }

  /** The intent id is globally unique; the caller refuses another user's row. */
  async findByIntent(intentId: string): Promise<CorePosition | null> {
    const r = await this.prisma.corePosition.findUnique({ where: { intentId } });
    return r ? toCorePosition(r) : null;
  }

  async findForUser(userId: string, id: string): Promise<CorePosition | null> {
    const r = await this.prisma.corePosition.findFirst({ where: { id, userId } });
    return r ? toCorePosition(r) : null;
  }

  /** System scan (boot recovery): every user's active positions, oldest first. */
  async listActive(): Promise<CorePosition[]> {
    const rows = await this.prisma.corePosition.findMany({ where: { status: { in: [...ACTIVE_STATUSES] } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    return rows.map(toCorePosition);
  }

  /** System scan (daily-loss monitor). */
  async listActiveUserIds(): Promise<string[]> {
    const rows = await this.prisma.corePosition.findMany({ where: { status: { in: [...ACTIVE_STATUSES] } }, select: { userId: true }, distinct: ['userId'], orderBy: { userId: 'asc' } });
    return rows.map((r) => r.userId);
  }

  /** The user's active positions plus those closed at or after `since` (all when null), oldest first. */
  async listForUser(userId: string, since: Date | null): Promise<CorePosition[]> {
    const rows = await this.prisma.corePosition.findMany({
      where: since ? { userId, OR: [{ status: { in: [...ACTIVE_STATUSES] } }, { closedAt: { gte: since } }] } : { userId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map(toCorePosition);
  }

  /** Applies `patch` only at `expectVersion`; null when another writer got there first. */
  async update(userId: string, id: string, expectVersion: number, patch: PositionPatch): Promise<CorePosition | null> {
    const { count } = await this.prisma.corePosition.updateMany({
      where: { id, userId, version: expectVersion },
      data: { ...patchData(patch), version: { increment: 1 } },
    });
    if (count !== 1) return null;
    return this.findForUser(userId, id);
  }
}
```

- [ ] **Step 4: The in-memory twin**

Create `apps/api/src/modules/trade-core/lifecycle/testing/memory-position-store.ts`:

```typescript
import { ActivePositionExistsError, type CorePositionRepository } from '../repositories/core-position.repository';
import { isActiveStatus, type CorePosition, type NewPositionRow, type PositionPatch } from '../lifecycle.types';

const copy = (p: CorePosition): CorePosition => structuredClone(p);
const oldestFirst = (a: CorePosition, b: CorePosition) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id);

/** CorePositionRepository in memory, with the same contract (memory-position-store.spec.ts; the opt-in DB test checks the real one). */
export class MemoryPositionStore {
  rows: CorePosition[] = [];
  private seq = 0;

  constructor(private readonly clock: () => Date = () => new Date()) {}

  readonly repo = {
    createIfNoActive: async (row: NewPositionRow): Promise<CorePosition> => {
      const exchange = row.instrument.exchange.toUpperCase();
      const active = this.rows.find(
        (p) => p.userId === row.userId && p.instrument.exchange === exchange && p.instrument.token === row.instrument.token && isActiveStatus(p.status),
      );
      if (active) throw new ActivePositionExistsError(active.id);
      if (this.rows.some((p) => p.intentId === row.intentId)) throw new Error('unique violation: core_positions.intentId');
      this.seq += 1;
      const now = this.clock();
      const p: CorePosition = {
        id: `pos_${this.seq}`,
        userId: row.userId,
        intentId: row.intentId,
        strategyId: row.strategyId,
        strategyVersionId: row.strategyVersionId,
        vehicle: row.vehicle,
        instrument: { ...row.instrument, exchange, underlying: row.vehicle === 'OPTIONS_BUY' ? row.underlying : null },
        underlying: row.underlying,
        side: row.side,
        direction: row.direction,
        status: 'PENDING_ENTRY',
        requestedQty: row.requestedQty,
        entryFilledQty: 0,
        exitFilledQty: 0,
        openQty: 0,
        entryAvgPrice: null,
        plan: structuredClone(row.plan),
        initialStopPrice: null,
        stopPrice: null,
        targetPrice: null,
        partialPrice: null,
        partialQty: 0,
        trailActive: false,
        partialDone: false,
        highWater: null,
        lowWater: null,
        exitSeq: 0,
        exitReason: null,
        blindSince: null,
        openedAt: null,
        closedAt: null,
        createdAt: now,
        updatedAt: now,
        version: 0,
      };
      this.rows.push(p);
      return copy(p);
    },
    findByIntent: async (intentId: string) => {
      const p = this.rows.find((x) => x.intentId === intentId);
      return p ? copy(p) : null;
    },
    findForUser: async (userId: string, id: string) => {
      const p = this.rows.find((x) => x.id === id && x.userId === userId);
      return p ? copy(p) : null;
    },
    listActive: async () => this.rows.filter((p) => isActiveStatus(p.status)).sort(oldestFirst).map(copy),
    listActiveUserIds: async () => [...new Set(this.rows.filter((p) => isActiveStatus(p.status)).map((p) => p.userId))].sort(),
    listForUser: async (userId: string, since: Date | null) =>
      this.rows
        .filter((p) => p.userId === userId && (since === null || isActiveStatus(p.status) || (p.closedAt !== null && p.closedAt.getTime() >= since.getTime())))
        .sort(oldestFirst)
        .map(copy),
    update: async (userId: string, id: string, expectVersion: number, patch: PositionPatch) => {
      const p = this.rows.find((x) => x.id === id && x.userId === userId && x.version === expectVersion);
      if (!p) return null;
      for (const [k, v] of Object.entries(patch)) if (v !== undefined) (p as unknown as Record<string, unknown>)[k] = v;
      p.openQty = p.entryFilledQty - p.exitFilledQty;
      p.version += 1;
      p.updatedAt = this.clock();
      return copy(p);
    },
  } as unknown as CorePositionRepository;
}
```

- [ ] **Step 5: Run it to see it pass**

Run: `npx jest src/modules/trade-core/lifecycle/testing/memory-position-store.spec.ts`
Expected: PASS.

- [ ] **Step 6: The real repository against the throwaway database**

Append to `apps/api/test/sp2-m4/core-lifecycle.int.spec.ts`:

```typescript
import type { PrismaService } from '../../src/common/prisma/prisma.service';
import { ActivePositionExistsError, CorePositionRepository } from '../../src/modules/trade-core/lifecycle/repositories/core-position.repository';

describe('CorePositionRepository (real database)', () => {
  const repo = new CorePositionRepository(db as unknown as PrismaService);
  const plan = { version: 1, vehicle: 'CASH_INTRADAY', side: 'BUY', stopPct: 1.5, targetPct: 3, trail: { kind: 'none' }, partial: { kind: 'none' }, timeExit: { kind: 'clock', hhmm: '15:25' }, atr: null, squareOffHhmm: '15:15', mtfMaxHoldDays: null, entryDay: '2026-10-12', option: null } as const;
  const row = (userId: string, intentId: string) => ({
    userId, intentId, strategyId: 'cs_x', strategyVersionId: 'csv_x', vehicle: 'CASH_INTRADAY' as const,
    instrument: { exchange: 'NSE', token: '2885', symbol: 'RELIANCE-EQ', lotSize: 1, underlying: null },
    underlying: 'RELIANCE', side: 'BUY' as const, direction: 'LONG' as const, requestedQty: 100, plan: plan as never,
  });

  it('two concurrent opens on one instrument: exactly one succeeds', async () => {
    const u = await newUser();
    const results = await Promise.allSettled([repo.createIfNoActive(row(u, `${u}:a`)), repo.createIfNoActive(row(u, `${u}:b`))]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(failed.reason).toBeInstanceOf(ActivePositionExistsError);
  });

  it('a version-guarded update applies once, maps prices back to numbers and bumps the version', async () => {
    const u = await newUser();
    const p = await repo.createIfNoActive(row(u, `${u}:c`));
    const a = await repo.update(u, p.id, 0, { status: 'OPEN', entryFilledQty: 100, entryAvgPrice: 500.1234, stopPrice: 492.5, openedAt: new Date() });
    expect(a).toMatchObject({ version: 1, status: 'OPEN', openQty: 100, entryAvgPrice: 500.1234, stopPrice: 492.5 });
    expect(await repo.update(u, p.id, 0, { status: 'EXITING' })).toBeNull();
    expect((await repo.listActiveUserIds()).includes(u)).toBe(true);
  });
});
```

Run (container from Task 5 still up): `npx jest --config test/sp2-m4/jest.config.js -i` (from `apps/api`, with `DATABASE_URL_TEST` set)
Expected: PASS. Then `docker rm -f grw-sp2m4-test`.

- [ ] **Step 7: Commit**

```bash
git add -- apps/api/src/modules/trade-core/lifecycle/repositories/core-position.repository.ts apps/api/src/modules/trade-core/lifecycle/testing/memory-position-store.ts apps/api/src/modules/trade-core/lifecycle/testing/memory-position-store.spec.ts apps/api/test/sp2-m4/core-lifecycle.int.spec.ts
git commit -m "feat(trade-core): core position repository with one active position per instrument" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/api/src/modules/trade-core/lifecycle/repositories/core-position.repository.ts apps/api/src/modules/trade-core/lifecycle/testing/memory-position-store.ts apps/api/src/modules/trade-core/lifecycle/testing/memory-position-store.spec.ts apps/api/test/sp2-m4/core-lifecycle.int.spec.ts
```

---

## Stream C — the lifecycle service

All three tasks drive the **real** M3 ledger, matcher and paper adapter over the in-memory stores, with a fake hub,
under Jest fake timers (`Date.now()` is controlled, so the adapter's `submittedAt` and the prices agree).

### Task 8: `CoreLifecycleService` part 1 — open a position, follow its orders, watch it

**Files:**
- Create: `apps/api/src/modules/trade-core/lifecycle/lifecycle-events.ts`
- Create: `apps/api/src/modules/trade-core/lifecycle/core-lifecycle.service.ts`
- Create: `apps/api/src/modules/trade-core/lifecycle/testing/lifecycle-harness.ts`
- Test: `apps/api/src/modules/trade-core/lifecycle/core-lifecycle.open.spec.ts`

**Interfaces:**
- Consumes: Tasks 1–7; `ExecutionAdapter` + `CORE_EXECUTION_ADAPTER` (M3, extended in Task 6); `CoreStrategyRepository.findVersion(id)` (M1: returns the version with `status`, `strategyId`, `blocks`); `CorePaperDefaultsService.settings(now)`; `CoreRiskLimitService.inForce(userId, now)`; `CoreKillSwitchReader.isOn(userId)` (M2, cached ≤ 5 s); `lookupHubPrices`, `HubPrices`; `CORE_SESSION_CLOCK`; `exposureOf` (M2).
- Produces: `LIFECYCLE_EVENT_SINK`, `LifecycleEventSink`, `LoggingLifecycleEventSink`; `corePositionOwner(id) = 'core:' + id`; `CoreOpenRequest { intent, qty, instrument, atr, limits, option }`; `LifecycleMark { ltp; at }`; `CoreLifecycleService` with `subscribe()`, `onModuleInit()`, `onModuleDestroy()`, `openPosition(req, now?): Promise<CorePosition>`, `onOrderUpdate(order): Promise<void>`, `sweep(now?)`, `idle()`, `activeCount()`, `mark(positionId): LifecycleMark | null`, `positionsFor(userId, since): Promise<CorePosition[]>`; harness `lifecycleHarness(opts)`, `openRequest(over, intent)`, `MemoryEventSink`, `VERSIONS`.

- [ ] **Step 1: The event port**

Create `apps/api/src/modules/trade-core/lifecycle/lifecycle-events.ts`:

```typescript
import { Injectable, Logger } from '@nestjs/common';
import type { LifecycleEvent } from './lifecycle.types';

/** Ruling L12 / O6: where lifecycle events go. M4 logs them; M5 rebinds this to core_journal. */
export const LIFECYCLE_EVENT_SINK = Symbol('LIFECYCLE_EVENT_SINK');

export interface LifecycleEventSink {
  record(e: LifecycleEvent): Promise<void>;
}

@Injectable()
export class LoggingLifecycleEventSink implements LifecycleEventSink {
  private readonly logger = new Logger('CoreLifecycle');

  async record(e: LifecycleEvent): Promise<void> {
    this.logger.log(
      JSON.stringify({ type: e.type, userId: e.userId, positionId: e.positionId, payload: e.payload, priceUsed: e.priceUsed, priceAgeMs: e.priceAgeMs, at: e.at.toISOString() }),
    );
  }
}
```

- [ ] **Step 2: The harness and the failing test**

Create `apps/api/src/modules/trade-core/lifecycle/testing/lifecycle-harness.ts`:

```typescript
import type { ModuleRef } from '@nestjs/core';
import type { HubExchange, Price } from '../../../market-hub/hub.types';
import type { CoreOrder } from '../../execution/execution.types';
import { CoreOrderEvents } from '../../execution/order-events';
import { PaperExecutionAdapter } from '../../execution/paper-execution.adapter';
import { PaperLedgerService } from '../../execution/paper-ledger.service';
import { PaperMatcherService } from '../../execution/paper-matcher.service';
import { FakeHub, fakeHubSource, fakeModuleRef } from '../../execution/testing/fake-hub';
import { fakeDefaults, MemoryPaperStore } from '../../execution/testing/memory-paper-store';
import { depth, paperSettings } from '../../execution/testing/paper-fixtures';
import type { CoreEntryIntent, LimitInForce } from '../../risk-wall/risk-wall.types';
import type { CoreKillSwitchReader } from '../../risk-wall/services/core-kill-switch.reader';
import type { CoreKillSwitchService } from '../../risk-wall/services/core-kill-switch.service';
import type { CoreRiskLimitService } from '../../risk-wall/services/core-risk-limit.service';
import { intentFixture, limitsFixture } from '../../risk-wall/testing/risk-fixtures';
import type { StrategyBlocks } from '../../strategies/blocks/block-types';
import type { CoreStrategyRepository } from '../../strategies/repositories/core-strategy.repository';
import { adaptiveBlocks, plainBlocks } from '../../strategies/testing/block-fixtures';
import { CoreLifecycleService, type CoreOpenRequest } from '../core-lifecycle.service';
import type { LifecycleEventSink } from '../lifecycle-events';
import type { LifecycleEvent } from '../lifecycle.types';
import { mtfBlocks, optionBlocks } from './lifecycle-fixtures';
import { MemoryPositionStore } from './memory-position-store';

const IST_MS = 5.5 * 3600_000;

export class MemoryEventSink implements LifecycleEventSink {
  readonly events: LifecycleEvent[] = [];

  async record(e: LifecycleEvent): Promise<void> {
    this.events.push(e);
  }

  types(positionId?: string): string[] {
    return this.events.filter((e) => !positionId || e.positionId === positionId).map((e) => e.type);
  }
}

/** The catalogue the harness answers (test data only). */
export const VERSIONS: Record<string, { strategyId: string; status: string; blocks: StrategyBlocks }> = {
  csv_ungated_v1: { strategyId: 'cs_ungated', status: 'PAPER', blocks: plainBlocks() },
  csv_adaptive_v1: { strategyId: 'cs_adaptive', status: 'PAPER', blocks: adaptiveBlocks() },
  csv_mtf_v1: { strategyId: 'cs_mtf', status: 'PAPER', blocks: mtfBlocks() },
  csv_option_v1: { strategyId: 'cs_option', status: 'PAPER', blocks: optionBlocks() },
  csv_draft: { strategyId: 'cs_ungated', status: 'DRAFT', blocks: plainBlocks() },
};

export interface HarnessOptions {
  /** Users the fake hub serves (default A and B). */
  served?: string[];
  /** The live limits CoreRiskLimitService answers (default the fixture limits). */
  liveLimits?: () => LimitInForce[];
  /** core_paper_defaults blindAfterMs (default 30 000; null = row absent). */
  blindAfterMs?: number | null;
  /** Subscribe the service to order updates (default true). */
  subscribe?: boolean;
}

/**
 * The real M3 ledger, matcher and paper adapter over memory stores and one fake hub, plus a
 * CoreLifecycleService. Use with jest.useFakeTimers({ now: NOW }): every time is Date.now().
 */
export function lifecycleHarness(opts: HarnessOptions = {}) {
  const paper = new MemoryPaperStore(() => new Date());
  const positions = new MemoryPositionStore(() => new Date());
  const defaults = fakeDefaults(paperSettings({ blindAfterMs: opts.blindAfterMs === undefined ? 30_000 : opts.blindAfterMs }));
  const events = new CoreOrderEvents();
  const ledger = new PaperLedgerService(paper.tx, paper.orderRepo, paper.fillRepo, paper.ledgerRepo, defaults, events);
  const hub = new FakeHub();
  const moduleRef = fakeModuleRef(fakeHubSource(Object.fromEntries((opts.served ?? ['user_A', 'user_B']).map((u) => [u, hub])))) as unknown as ModuleRef;
  const session = { open: true };
  const clock = {
    isOpen: () => session.open,
    isTradingDay: (_exchange: string, at: Date) => {
      const d = new Date(at.getTime() + IST_MS).getUTCDay();
      return d !== 0 && d !== 6;
    },
  };
  const killOn = new Set<string>();
  const matcher = new PaperMatcherService(ledger, defaults, moduleRef, clock);
  const adapter = new PaperExecutionAdapter(ledger, matcher, { isActive: async (u: string) => killOn.has(u) } as unknown as CoreKillSwitchService, clock);
  const strategies = { findVersion: async (id: string) => (VERSIONS[id] ? { id, ...VERSIONS[id] } : null) } as unknown as CoreStrategyRepository;
  const limits = { inForce: async () => (opts.liveLimits ? opts.liveLimits() : limitsFixture()) } as unknown as CoreRiskLimitService;
  const killReader = { isOn: async (u: string) => killOn.has(u) } as unknown as CoreKillSwitchReader;
  const sink = new MemoryEventSink();
  const make = () => new CoreLifecycleService(positions.repo, adapter, strategies, defaults, limits, killReader, moduleRef, clock, sink);
  let lifecycle = make();
  if (opts.subscribe !== false) lifecycle.subscribe();

  const advance = (ms: number) => jest.setSystemTime(Date.now() + ms);
  const settle = async () => {
    for (let i = 0; i < 5; i += 1) await lifecycle.idle();
  };

  /** One market price (default RELIANCE-EQ, deep book): the matcher sees it first, then the lifecycle. */
  async function price(ltp: number, o: { exchange?: HubExchange; token?: string; symbol?: string; qty?: number } = {}): Promise<Price> {
    advance(10);
    const book = o.qty ?? 1_000_000;
    const p: Price = {
      ref: { exchange: o.exchange ?? 'NSE', token: o.token ?? '2885', symbol: o.symbol ?? 'RELIANCE-EQ' },
      ltp,
      at: Date.now(),
      source: 'ws',
      depth: depth([[ltp, book]], [[ltp, book]]),
    };
    hub.setFresh(p);
    advance(1);
    await matcher.onPrice(hub, p, Date.now());
    await settle();
    await lifecycle.onPrice(hub, p, Date.now());
    await settle();
    return p;
  }

  async function sweep(): Promise<void> {
    await matcher.sweep(Date.now());
    await settle();
    await lifecycle.sweep(Date.now());
    await settle();
  }

  /** A restart: the old service is torn down and a new one is built over the same stores. */
  function restart(): CoreLifecycleService {
    lifecycle.onModuleDestroy();
    lifecycle = make();
    lifecycle.subscribe();
    return lifecycle;
  }

  const ordersOf = (positionId: string): CoreOrder[] => paper.orders.filter((x) => x.positionId === positionId);

  return {
    paper,
    positions,
    ledger,
    matcher,
    adapter,
    hub,
    session,
    killOn,
    sink,
    get lifecycle() {
      return lifecycle;
    },
    advance,
    settle,
    price,
    sweep,
    restart,
    ordersOf,
  };
}

/** Ungated-shaped cash BUY of 100 RELIANCE-EQ at a 500 reference. */
export function openRequest(over: Partial<CoreOpenRequest> = {}, intent: Partial<CoreEntryIntent> = {}): CoreOpenRequest {
  const i = intentFixture({ intentId: 'int_1', symbol: 'RELIANCE-EQ', underlying: 'RELIANCE', qty: 100, refPrice: 500, stopPrice: 492.5, capitalPerUnit: 100, ...intent });
  return {
    intent: i,
    qty: i.qty,
    instrument: { exchange: 'NSE', token: '2885', symbol: 'RELIANCE-EQ', lotSize: 1, underlying: null },
    atr: null,
    limits: limitsFixture(),
    option: null,
    ...over,
  };
}
```

Create `apps/api/src/modules/trade-core/lifecycle/core-lifecycle.open.spec.ts`:

```typescript
import { BadRequestException, ConflictException } from '@nestjs/common';
import { corePositionOwner } from './core-lifecycle.service';
import { NOW } from './testing/lifecycle-fixtures';
import { lifecycleHarness, openRequest } from './testing/lifecycle-harness';

beforeEach(() => jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] }));
afterEach(() => jest.useRealTimers());

describe('CoreLifecycleService: opening and following the orders (spec §7.1)', () => {
  it('opens PENDING_ENTRY with one MARKET entry keyed <intentId>:entry; the same intent again returns the same position', async () => {
    const h = lifecycleHarness();
    const p = await h.lifecycle.openPosition(openRequest());
    expect(p).toMatchObject({ status: 'PENDING_ENTRY', requestedQty: 100, underlying: 'RELIANCE', direction: 'LONG', strategyId: 'cs_ungated' });
    expect(h.ordersOf(p.id).map((o) => [o.idempotencyKey, o.type, o.side, o.qty, o.purpose])).toEqual([['int_1:entry', 'MARKET', 'BUY', 100, 'ENTRY']]);
    expect((await h.lifecycle.openPosition(openRequest())).id).toBe(p.id);
    expect(h.paper.orders).toHaveLength(1);
    expect(h.sink.types(p.id)).toEqual(['POSITION_STATE']);
  });

  it('the entry fill makes it OPEN, arms its levels from the fill and watches the instrument at P0', async () => {
    const h = lifecycleHarness();
    const p = await h.lifecycle.openPosition(openRequest());
    await h.price(500);
    const open = h.positions.rows.find((x) => x.id === p.id);
    expect(open).toMatchObject({ status: 'OPEN', entryFilledQty: 100, openQty: 100, entryAvgPrice: 500, initialStopPrice: 492.5, stopPrice: 492.5, targetPrice: 515, highWater: 500, lowWater: 500 });
    expect(open?.openedAt).not.toBeNull();
    expect(h.hub.watches).toEqual(expect.arrayContaining([{ key: 'NSE:2885', priority: 0, owner: corePositionOwner(p.id) }]));
    expect(h.sink.events.filter((e) => e.type === 'POSITION_STATE').map((e) => e.payload.to)).toEqual(['PENDING_ENTRY', 'OPEN']);
    expect(h.lifecycle.mark(p.id)).toMatchObject({ ltp: 500 });
  });

  it('refuses what it cannot open, before any order or row exists', async () => {
    const h = lifecycleHarness();
    await expect(h.lifecycle.openPosition(openRequest({}, { strategyVersionId: 'csv_draft' }))).rejects.toThrow('is DRAFT; only PAPER versions trade in SP2');
    await expect(h.lifecycle.openPosition(openRequest({}, { strategyVersionId: 'csv_missing' }))).rejects.toBeInstanceOf(BadRequestException);
    await expect(h.lifecycle.openPosition(openRequest({}, { symbol: 'RELIANCE' }))).rejects.toThrow('instrument RELIANCE-EQ is not the intent');
    await expect(h.lifecycle.openPosition(openRequest({ qty: 101 }))).rejects.toThrow('the verdict may only reduce');
    await expect(h.lifecycle.openPosition(openRequest({ limits: [] }))).rejects.toThrow('squareOffTime@CASH_INTRADAY is missing');
    expect(h.paper.orders).toHaveLength(0);
    expect(h.positions.rows).toHaveLength(0);
  });

  it('a second active position on the same instrument is a 409; another user is unaffected', async () => {
    const h = lifecycleHarness();
    await h.lifecycle.openPosition(openRequest());
    await expect(h.lifecycle.openPosition(openRequest({}, { intentId: 'int_2' }))).rejects.toBeInstanceOf(ConflictException);
    await expect(h.lifecycle.openPosition(openRequest({}, { intentId: 'int_b', userId: 'user_B' }))).resolves.toMatchObject({ userId: 'user_B' });
  });

  it("another user's intent id is a 409, never that user's position", async () => {
    const h = lifecycleHarness();
    await h.lifecycle.openPosition(openRequest());
    await expect(h.lifecycle.openPosition(openRequest({}, { userId: 'user_B' }))).rejects.toBeInstanceOf(ConflictException);
  });

  it('an entry rejected for want of a price ends CANCELLED and the position is let go', async () => {
    const h = lifecycleHarness();
    const p = await h.lifecycle.openPosition(openRequest());
    h.advance(30_001);
    await h.sweep();
    expect(h.positions.rows[0]).toMatchObject({ id: p.id, status: 'CANCELLED' });
    expect(h.positions.rows[0].closedAt).not.toBeNull();
    expect(h.lifecycle.activeCount()).toBe(0);
  });

  it('a missed order update is caught by the 5 s re-read (ruling L3)', async () => {
    const h = lifecycleHarness({ subscribe: false });
    const p = await h.lifecycle.openPosition(openRequest());
    await h.price(500);
    expect(h.positions.rows[0].status).toBe('PENDING_ENTRY');
    h.advance(5_000);
    await h.lifecycle.sweep(Date.now());
    await h.settle();
    expect(h.positions.rows[0]).toMatchObject({ id: p.id, status: 'OPEN', entryAvgPrice: 500 });
  });

  it('an entry that cannot be placed leaves no PENDING ghost: the position is CANCELLED and the error surfaces', async () => {
    const h = lifecycleHarness();
    jest.spyOn(h.adapter, 'placeOrder').mockRejectedValueOnce(new Error('ledger down'));
    await expect(h.lifecycle.openPosition(openRequest())).rejects.toThrow('ledger down');
    expect(h.positions.rows[0]).toMatchObject({ status: 'CANCELLED' });
    expect(h.lifecycle.activeCount()).toBe(0);
  });
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `npx jest src/modules/trade-core/lifecycle/core-lifecycle.open.spec.ts`
Expected: FAIL, "Cannot find module '../core-lifecycle.service'".

- [ ] **Step 4: Implement part 1**

Create `apps/api/src/modules/trade-core/lifecycle/core-lifecycle.service.ts`:

```typescript
import { BadRequestException, ConflictException, Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { BOOT_JOBS_DISABLED, bootJobsEnabled } from '../../../common/utils/boot-jobs';
import { lookupHubPrices, type HubPriceSource, type HubPrices } from '../../market-hub/hub-prices';
import { isHubExchange, refKey, type InstrumentRef } from '../../market-hub/hub.types';
import type { SessionClock } from '../../market-hub/session-clock';
import type { CoreInstrument, CoreOrder, ExecutionAdapter } from '../execution/execution.types';
import { istDate } from '../execution/ledger-math';
import { CORE_EXECUTION_ADAPTER } from '../execution/paper-execution.adapter';
import { CorePaperDefaultsService } from '../execution/services/core-paper-defaults.service';
import { CORE_SESSION_CLOCK } from '../risk-wall/ports';
import { exposureOf } from '../risk-wall/risk-wall';
import type { CoreEntryIntent, LimitInForce } from '../risk-wall/risk-wall.types';
import { CoreKillSwitchReader } from '../risk-wall/services/core-kill-switch.reader';
import { CoreRiskLimitService } from '../risk-wall/services/core-risk-limit.service';
import type { StrategyBlocks } from '../strategies/blocks/block-types';
import { CoreStrategyRepository } from '../strategies/repositories/core-strategy.repository';
import { armLevels, buildExitPlan, type OptionOpen } from './exit-plan';
import { LIFECYCLE_EVENT_SINK, type LifecycleEventSink } from './lifecycle-events';
import { entryKey, isActiveStatus, type CorePosition, type LifecycleEvent, type LifecycleEventType, type PositionPatch } from './lifecycle.types';
import { reducePosition } from './position-state';
import { ActivePositionExistsError, CorePositionRepository } from './repositories/core-position.repository';
import { tightenStop } from './stop-rules';

/** Spec §7.2: the clock-rule sweep. */
export const LIFECYCLE_SWEEP_MS = 1_000;
/** Ruling L3: how often each held position's orders are re-read (missed updates). */
export const ORDERS_REREAD_MS = 5_000;

/** Spec §7.2: the hub watch owner of one core position. */
export const corePositionOwner = (positionId: string): string => `core:${positionId}`;

/** What M5 hands the lifecycle after an ALLOW/RESIZE verdict. */
export interface CoreOpenRequest {
  intent: CoreEntryIntent;
  /** The verdict's quantity (≤ intent.qty, whole lots). */
  qty: number;
  /** The resolved contract; its symbol must equal intent.symbol (ruling L19). */
  instrument: CoreInstrument;
  /** ATR at entry in price units (stop.atr and trail.atr use it), or null. */
  atr: number | null;
  /** The verdict's limits snapshot (squareOffTime, mtfMaxHoldDays are frozen from it). */
  limits: readonly LimitInForce[];
  /** OPTIONS_BUY only. */
  option: OptionOpen | null;
}

export interface LifecycleMark {
  ltp: number;
  /** Receipt time, ms epoch. */
  at: number;
}

interface Held {
  pos: CorePosition;
  ref: InstrumentRef | null;
  underlyingRef: InstrumentRef | null;
  hub: HubPrices | null;
  lastPrice: LifecycleMark | null;
  underlyingPrice: LifecycleMark | null;
  /** Marks changed in memory and not yet written (ruling L11). */
  dirty: boolean;
  /** Reloaded on boot: a stop crossed on the first fresh price is a RECOVERY_STOP. */
  recovering: boolean;
  /** The IST day of the last fresh price evaluated (GAP_STOP). */
  lastPricedDay: string | null;
  /** When this process began holding it (the blind clock never starts earlier). */
  since: number;
  /** When this process last saw the session open for it (the blind clock restarts at each open). */
  sessionSince: number | null;
  lastReread: number;
  lastExitAttempt: number;
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function refOf(exchange: string, token: string, symbol: string): InstrumentRef | null {
  const ex = exchange.toUpperCase();
  return isHubExchange(ex) ? { exchange: ex, token, symbol } : null;
}

function addTo(index: Map<string, Set<string>>, key: string, id: string): void {
  const ids = index.get(key) ?? new Set<string>();
  ids.add(id);
  index.set(key, ids);
}

function removeFrom(index: Map<string, Set<string>>, key: string, id: string): void {
  const ids = index.get(key);
  ids?.delete(id);
  if (ids && ids.size === 0) index.delete(key);
}

/** What openPosition refuses before anything is written. */
function openProblem(r: CoreOpenRequest): string | null {
  const i = r.intent;
  if (i.kind !== 'ENTRY') return 'not an entry intent';
  if (!Number.isSafeInteger(r.qty) || r.qty < 1 || r.qty > i.qty) return `qty must be a whole number from 1 to the intent's ${i.qty} (the verdict may only reduce)`;
  if (r.instrument.lotSize !== i.lotSize || r.qty % r.instrument.lotSize !== 0) return `qty must be whole lots of ${i.lotSize}`;
  if (r.instrument.exchange.toUpperCase() !== i.exchange.toUpperCase()) return `the instrument trades on ${r.instrument.exchange}, the intent on ${i.exchange}`;
  if (r.instrument.symbol.toUpperCase() !== i.symbol.toUpperCase()) return `instrument ${r.instrument.symbol} is not the intent's ${i.symbol}`;
  if ((i.vehicle === 'OPTIONS_BUY') !== (r.option !== null)) return 'an option contract is required for OPTIONS_BUY, and only for it';
  if (r.option && r.option.optionType !== i.optionType) return `the contract is ${r.option.optionType}, the intent ${String(i.optionType)}`;
  return null;
}

/**
 * The Position Manager (spec §7). Holds every active core position in memory, watches
 * each at P0 on its user's hub, follows its orders (update stream + 5 s re-read), decides
 * exits on prices and on a 1 s sweep, and places every exit as a MARKET order through the
 * ExecutionAdapter. The database is the source of truth: every decision is persisted
 * (version-guarded) before its order is placed, and boot reloads every active position.
 * One position's work is serialised (run); one position's failure never stops the others.
 */
@Injectable()
export class CoreLifecycleService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CoreLifecycleService.name);
  private readonly held = new Map<string, Held>();
  private readonly byRef = new Map<string, Set<string>>();
  private readonly byUnderlying = new Map<string, Set<string>>();
  private readonly subscriptions = new Map<HubPrices, () => void>();
  private readonly inflight = new Map<string, Promise<void>>();
  private unsubscribeOrders: (() => void) | null = null;
  private hubSourceRef: HubPriceSource | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private sweeping = false;

  constructor(
    private readonly repo: CorePositionRepository,
    @Inject(CORE_EXECUTION_ADAPTER) private readonly adapter: ExecutionAdapter,
    private readonly strategies: CoreStrategyRepository,
    private readonly defaults: CorePaperDefaultsService,
    private readonly limits: CoreRiskLimitService,
    private readonly killSwitch: CoreKillSwitchReader,
    private readonly moduleRef: ModuleRef,
    @Inject(CORE_SESSION_CLOCK) private readonly clock: Pick<SessionClock, 'isOpen' | 'isTradingDay'>,
    @Inject(LIFECYCLE_EVENT_SINK) private readonly sink: LifecycleEventSink,
  ) {}

  /** Order updates always flow; the sweep (which writes and places exits) only in a serving process. */
  onModuleInit(): void {
    this.subscribe();
    if (!bootJobsEnabled()) {
      this.logger.log(BOOT_JOBS_DISABLED);
      return;
    }
    this.timer = setInterval(() => void this.sweep(), LIFECYCLE_SWEEP_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribeOrders?.();
    this.unsubscribeOrders = null;
    for (const off of this.subscriptions.values()) off();
    this.subscriptions.clear();
  }

  subscribe(): void {
    if (!this.unsubscribeOrders) this.unsubscribeOrders = this.adapter.onOrderUpdate((o) => void this.onOrderUpdate(o));
  }

  activeCount(): number {
    return this.held.size;
  }

  /** The newest price this process has for the position (the risk provider checks its age). */
  mark(positionId: string): LifecycleMark | null {
    return this.held.get(positionId)?.lastPrice ?? null;
  }

  /** Resolves when no position has work in flight (tests, shutdown). */
  async idle(): Promise<void> {
    await Promise.all([...this.inflight.values()]);
  }

  positionsFor(userId: string, since: Date | null): Promise<CorePosition[]> {
    return this.repo.listForUser(userId, since);
  }

  /**
   * Spec §3/§7.1: an ALLOWed (or RESIZEd) intent becomes a PENDING_ENTRY position and one
   * MARKET entry order keyed `${intentId}:entry`. Idempotent on the intent id. Refuses,
   * before writing anything, what it cannot plan; a version that is not PAPER (SP2 is paper
   * only); a second active position on the instrument (409).
   */
  async openPosition(req: CoreOpenRequest, now: Date = new Date()): Promise<CorePosition> {
    const i = req.intent;
    const prior = await this.repo.findByIntent(i.intentId);
    if (prior) {
      if (prior.userId !== i.userId) throw new ConflictException('this intent id belongs to another position');
      return prior;
    }
    const problem = openProblem(req);
    if (problem) throw new BadRequestException(`cannot open a core position: ${problem}`);
    const version = await this.strategies.findVersion(i.strategyVersionId);
    if (!version || version.strategyId !== i.strategyId) throw new BadRequestException(`strategy version ${i.strategyVersionId} of ${i.strategyId} not found`);
    if (version.status !== 'PAPER') throw new BadRequestException(`strategy version ${i.strategyVersionId} is ${version.status}; only PAPER versions trade in SP2`);
    const planned = buildExitPlan({
      blocks: version.blocks as unknown as StrategyBlocks,
      vehicle: i.vehicle,
      side: i.side,
      refPrice: i.refPrice,
      atr: req.atr,
      limits: req.limits,
      option: req.option,
      now,
    });
    if (!planned.ok) throw new BadRequestException(`cannot open a core position: ${planned.error}`);

    let pos: CorePosition;
    try {
      pos = await this.repo.createIfNoActive({
        userId: i.userId,
        intentId: i.intentId,
        strategyId: i.strategyId,
        strategyVersionId: i.strategyVersionId,
        vehicle: i.vehicle,
        instrument: req.instrument,
        underlying: i.underlying.trim().toUpperCase(),
        side: i.side,
        direction: exposureOf(i.vehicle, i.side, i.optionType),
        requestedQty: req.qty,
        plan: planned.plan,
      });
    } catch (err) {
      if (err instanceof ActivePositionExistsError) throw new ConflictException(err.message);
      throw err;
    }
    const h = this.hold(pos, now.getTime(), false);
    h.lastPricedDay = istDate(now);
    this.record('POSITION_STATE', h, { from: null, to: 'PENDING_ENTRY', qty: req.qty }, now);
    await this.run(pos.id, async () => {
      try {
        await this.adapter.placeOrder({
          userId: i.userId,
          idempotencyKey: entryKey(i.intentId),
          vehicle: i.vehicle,
          instrument: req.instrument,
          side: i.side,
          qty: req.qty,
          type: 'MARKET',
          limitPrice: null,
          triggerPrice: null,
          refPrice: i.refPrice,
          purpose: 'ENTRY',
          strategyVersionId: i.strategyVersionId,
          positionId: pos.id,
        });
      } catch (err) {
        // Never leave a PENDING_ENTRY ghost that blocks the instrument and counts as open risk.
        await this.persist(h, { status: 'CANCELLED', closedAt: new Date() });
        this.record('POSITION_STATE', h, { from: 'PENDING_ENTRY', to: 'CANCELLED', reason: `entry not placed: ${errorText(err)}` }, new Date());
        this.release(h);
        throw err;
      }
      await this.applyOrders(h, new Date());
    });
    return h.pos;
  }

  /** The adapter's update stream (ruling L3): re-reduce the owning position. */
  async onOrderUpdate(order: CoreOrder): Promise<void> {
    if (!order.positionId) return;
    let h = this.held.get(order.positionId);
    if (!h) {
      const pos = await this.repo.findForUser(order.userId, order.positionId);
      if (!pos || !isActiveStatus(pos.status)) return;
      h = this.hold(pos, Date.now(), false);
    }
    const held = h;
    await this.run(held.pos.id, () => this.applyOrders(held, new Date())).catch((err) =>
      this.logger.error(`core position ${held.pos.id}: order update failed: ${errorText(err)}`),
    );
  }

  /** Every second (spec §7.2). Task 9 adds prices, blind detection and decisions; Task 10 the boot reload. */
  async sweep(now: number = Date.now()): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      for (const h of [...this.held.values()]) {
        if (this.inflight.has(h.pos.id)) continue;
        await this.run(h.pos.id, () => this.sweepOne(h, now)).catch((err) => this.logger.error(`core position ${h.pos.id}: sweep failed: ${errorText(err)}`));
      }
    } finally {
      this.sweeping = false;
    }
  }

  private async sweepOne(h: Held, now: number): Promise<void> {
    if (h.pos.openQty > 0) this.attachHub(h);
    if (now - h.lastReread >= ORDERS_REREAD_MS) await this.applyOrders(h, new Date(now));
  }

  /**
   * Re-reduce the position from its orders (ruling L2) and persist what changed: quantities,
   * the entry average, the levels armed at the first entry fill (L4), the status, closedAt.
   */
  private async applyOrders(h: Held, now: Date): Promise<void> {
    h.lastReread = now.getTime();
    const pos = h.pos;
    if (!isActiveStatus(pos.status)) return;
    const orders = await this.adapter.listPositionOrders(pos.userId, pos.id);
    if (orders.length === 0 && pos.status === 'PENDING_ENTRY' && h.recovering) {
      // Created but never given its entry (a crash in between): never enter late.
      await this.persist(h, { status: 'CANCELLED', closedAt: now });
      this.record('POSITION_STATE', h, { from: 'PENDING_ENTRY', to: 'CANCELLED', reason: 'no entry order was placed before the restart' }, now);
      this.release(h);
      return;
    }
    const f = reducePosition(pos.status, orders);
    const patch: PositionPatch = {};
    if (f.entryFilledQty !== pos.entryFilledQty) patch.entryFilledQty = f.entryFilledQty;
    if (f.exitFilledQty !== pos.exitFilledQty) patch.exitFilledQty = f.exitFilledQty;
    if (f.entryAvgPrice !== pos.entryAvgPrice) patch.entryAvgPrice = f.entryAvgPrice;
    if (f.entryAvgPrice !== null && (pos.entryAvgPrice === null || patch.entryFilledQty !== undefined)) {
      const lv = armLevels(pos.plan, f.entryAvgPrice, f.entryFilledQty, pos.instrument.lotSize);
      Object.assign(patch, { targetPrice: lv.targetPrice, partialPrice: lv.partialPrice, partialQty: lv.partialQty });
      if (pos.stopPrice === null) {
        const trail = pos.plan.trail;
        Object.assign(patch, {
          initialStopPrice: lv.stopPrice,
          stopPrice: lv.stopPrice,
          highWater: f.entryAvgPrice,
          lowWater: f.entryAvgPrice,
          openedAt: pos.openedAt ?? now,
          trailActive: trail.kind === 'atr' && trail.startsAfter === 'ENTRY',
        });
      } else {
        const t = tightenStop(pos.stopPrice, lv.stopPrice, pos.side);
        if (t.accepted) patch.stopPrice = t.stop;
      }
    }
    if (f.status !== pos.status) {
      patch.status = f.status;
      if (f.status === 'CLOSED' || f.status === 'CANCELLED') patch.closedAt = now;
    }
    if (Object.keys(patch).length === 0) return;
    const updated = await this.persist(h, { ...this.pendingMarks(h), ...patch });
    if (!updated) return;
    if (updated.status !== pos.status) {
      this.record(
        'POSITION_STATE',
        h,
        { from: pos.status, to: updated.status, entryFilledQty: updated.entryFilledQty, exitFilledQty: updated.exitFilledQty, exitReason: updated.exitReason },
        now,
      );
    }
    if (!isActiveStatus(updated.status)) this.release(h);
    else if (updated.openQty > 0) this.attachHub(h);
  }

  /** Version-guarded write (ruling L11). A lost race reloads the row and returns null. */
  private async persist(h: Held, patch: PositionPatch): Promise<CorePosition | null> {
    const updated = await this.repo.update(h.pos.userId, h.pos.id, h.pos.version, patch);
    if (!updated) {
      const fresh = await this.repo.findForUser(h.pos.userId, h.pos.id);
      this.logger.warn(`core position ${h.pos.id}: a concurrent write won; reloaded`);
      if (fresh) h.pos = fresh;
      h.dirty = false;
      return null;
    }
    h.pos = updated;
    h.dirty = false;
    return updated;
  }

  /** The in-memory marks not yet written (ruling L11); empty when nothing is dirty. */
  private pendingMarks(h: Held): PositionPatch {
    return h.dirty ? { stopPrice: h.pos.stopPrice, highWater: h.pos.highWater, lowWater: h.pos.lowWater, trailActive: h.pos.trailActive } : {};
  }

  private hold(pos: CorePosition, now: number, recovering: boolean): Held {
    // Already held (a reload or a late update): keep the in-memory copy, which may carry unflushed marks.
    const existing = this.held.get(pos.id);
    if (existing) return existing;
    const u = pos.plan.option?.underlyingRef ?? null;
    const h: Held = {
      pos,
      ref: refOf(pos.instrument.exchange, pos.instrument.token, pos.instrument.symbol),
      underlyingRef: u ? { exchange: u.exchange, token: u.token, symbol: u.symbol } : null,
      hub: null,
      lastPrice: null,
      underlyingPrice: null,
      dirty: false,
      recovering,
      lastPricedDay: null,
      since: now,
      sessionSince: null,
      lastReread: now,
      lastExitAttempt: 0,
    };
    this.held.set(pos.id, h);
    if (h.ref) addTo(this.byRef, refKey(h.ref), pos.id);
    if (h.underlyingRef) addTo(this.byUnderlying, refKey(h.underlyingRef), pos.id);
    if (pos.openQty > 0) this.attachHub(h);
    return h;
  }

  /** A terminal position: stop holding it and drop its watches. */
  private release(h: Held): void {
    if (this.held.get(h.pos.id) !== h) return;
    this.held.delete(h.pos.id);
    if (h.ref) removeFrom(this.byRef, refKey(h.ref), h.pos.id);
    if (h.underlyingRef) removeFrom(this.byUnderlying, refKey(h.underlyingRef), h.pos.id);
    if (h.hub) {
      const refs = [h.ref, h.underlyingRef].filter((r): r is InstrumentRef => r !== null);
      void h.hub.unwatch(refs, corePositionOwner(h.pos.id));
    }
  }

  private hubSource(): HubPriceSource | null {
    if (!this.hubSourceRef) this.hubSourceRef = lookupHubPrices(this.moduleRef);
    return this.hubSourceRef;
  }

  /** Spec §7.2: P0 for the instrument, P1 for an option's underlying stop; one subscription per hub. */
  private attachHub(h: Held): void {
    if (h.hub || !h.ref) return;
    const hub = this.hubSource()?.hubFor(h.pos.userId, 'positions') ?? null;
    if (!hub) return;
    h.hub = hub;
    if (!this.subscriptions.has(hub)) this.subscriptions.set(hub, hub.onPrice((p) => void this.onPrice(hub, p)));
    void hub.watch([h.ref], 0, corePositionOwner(h.pos.id));
    if (h.underlyingRef) void hub.watch([h.underlyingRef], 1, corePositionOwner(h.pos.id));
  }

  /** Ruling L12: never awaited, never thrown into a decision. */
  private record(type: LifecycleEventType, h: Held, payload: Record<string, unknown>, at: Date, price: LifecycleMark | null = null): void {
    const e: LifecycleEvent = {
      type,
      userId: h.pos.userId,
      positionId: h.pos.id,
      strategyVersionId: h.pos.strategyVersionId,
      payload,
      priceUsed: price?.ltp ?? null,
      priceAgeMs: price ? at.getTime() - price.at : null,
      at,
    };
    void this.sink.record(e).catch((err) => this.logger.error(`lifecycle event ${type} for ${h.pos.id} not recorded: ${errorText(err)}`));
  }

  /**
   * One position's work, in order; the returned promise carries fn's result or error. The
   * in-flight mark is cleared in `finally`, before any awaiter of the result resumes, so a
   * caller that awaited run() never sees its own finished work as still in flight.
   */
  private run<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.inflight.get(id) ?? Promise.resolve();
    let tail: Promise<void> | null = null;
    const result = prev.then(fn).finally(() => {
      if (this.inflight.get(id) === tail) this.inflight.delete(id);
    });
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.inflight.set(id, tail);
    return result;
  }
}
```

Task 9 adds `onPrice`, which `attachHub` already subscribes; until then add this placeholder method so Task 8 compiles, and Task 9 replaces it:

```typescript
  onPrice(_hub: HubPrices, _p: import('../../market-hub/hub.types').Price, _now: number = Date.now()): Promise<void> {
    return Promise.resolve();
  }
```

- [ ] **Step 5: Run it to see it pass**

Run: `npx jest src/modules/trade-core/lifecycle/core-lifecycle.open.spec.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -- apps/api/src/modules/trade-core/lifecycle/lifecycle-events.ts apps/api/src/modules/trade-core/lifecycle/core-lifecycle.service.ts apps/api/src/modules/trade-core/lifecycle/testing/lifecycle-harness.ts apps/api/src/modules/trade-core/lifecycle/core-lifecycle.open.spec.ts
git commit -m "feat(trade-core): lifecycle opens core positions and follows their orders" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/api/src/modules/trade-core/lifecycle/lifecycle-events.ts apps/api/src/modules/trade-core/lifecycle/core-lifecycle.service.ts apps/api/src/modules/trade-core/lifecycle/testing/lifecycle-harness.ts apps/api/src/modules/trade-core/lifecycle/core-lifecycle.open.spec.ts
```

---

### Task 9: `CoreLifecycleService` part 2 — prices, decisions, exits, blind positions

**Files:**
- Modify: `apps/api/src/modules/trade-core/lifecycle/core-lifecycle.service.ts`
- Test: `apps/api/src/modules/trade-core/lifecycle/core-lifecycle.exits.spec.ts`

**Interfaces:**
- Consumes: Task 8's class; `decideExit`, `effectiveSquareOff`, `effectiveHoldDays`, `tradingDaysHeld` (Task 4); `advanceMarks` (Task 3); `round2` (Task 2); `exitKey`, `outranks`, `ExitReason` (Task 1); `PRICE_MAX_AGE_MS` (M3 `fill-model.ts`).
- Produces: `onPrice(hub, p, now?)` (real); private `evaluate`, `decide`, `exit(h, reason, detail, now, price)`, `partial`, `placeExit`, `claimSeq`, `ensureExit`, `checkBlind`, `liveRules`, `killSwitchOn`, `blindAfterMs`; `LIVE_LIMITS_CACHE_MS = 5_000`. Task 10 calls `exit` and `fresh`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/modules/trade-core/lifecycle/core-lifecycle.exits.spec.ts`:

```typescript
import type { Price } from '../../market-hub/hub.types';
import { limitsFixture } from '../risk-wall/testing/risk-fixtures';
import { NOW } from './testing/lifecycle-fixtures';
import { lifecycleHarness, openRequest } from './testing/lifecycle-harness';

beforeEach(() => jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] }));
afterEach(() => jest.useRealTimers());

const exitsOf = (h: ReturnType<typeof lifecycleHarness>, id: string) => h.ordersOf(id).filter((o) => o.purpose === 'EXIT');
const ist = (local: string) => new Date(`${local}+05:30`);

describe('CoreLifecycleService: exits (spec §7.2–§7.4)', () => {
  it('stop: one MARKET exit keyed <intentId>:exit:1; the next price closes it as STOP and lets it go', async () => {
    const h = lifecycleHarness();
    const p = await h.lifecycle.openPosition(openRequest());
    await h.price(500);
    await h.price(492);
    expect(exitsOf(h, p.id).map((o) => [o.idempotencyKey, o.type, o.side, o.qty, o.state])).toEqual([['int_1:exit:1', 'MARKET', 'SELL', 100, 'OPEN']]);
    expect(h.positions.rows[0]).toMatchObject({ status: 'EXITING', exitReason: 'STOP', exitSeq: 1 });
    await h.price(491.5);
    expect(h.positions.rows[0]).toMatchObject({ status: 'CLOSED', exitFilledQty: 100, openQty: 0, exitReason: 'STOP', lowWater: 492 });
    expect(h.lifecycle.activeCount()).toBe(0);
    expect(h.hub.unwatches.map((u) => u.owner)).toContain(`core:${p.id}`);
    expect(h.sink.types(p.id)).toEqual(['POSITION_STATE', 'POSITION_STATE', 'EXIT_DECIDED', 'POSITION_STATE', 'POSITION_STATE']);
  });

  it('target: the target price exits everything as TARGET', async () => {
    const h = lifecycleHarness();
    await h.lifecycle.openPosition(openRequest());
    await h.price(500);
    await h.price(515);
    await h.price(515);
    expect(h.positions.rows[0]).toMatchObject({ status: 'CLOSED', exitReason: 'TARGET', highWater: 515 });
  });

  it('Adaptive-shaped: half at +1 %, then the ATR trail exits the rest as TRAIL', async () => {
    const h = lifecycleHarness();
    const p = await h.lifecycle.openPosition(openRequest({ atr: 5 }, { strategyId: 'cs_adaptive', strategyVersionId: 'csv_adaptive_v1', stopPrice: 494 }));
    await h.price(500); // OPEN: stop 494, partial 505 × 50, target 510
    await h.price(505); // partial decided: SELL 50 (exit:1); the trail arms
    await h.price(505); // the partial fills; trail from 505 with ATR 5 → stop 500
    await h.lifecycle.sweep(Date.now()); // flushes the coalesced marks (ruling L11)
    await h.settle();
    expect(h.positions.rows[0]).toMatchObject({ status: 'PARTIAL', openQty: 50, partialDone: true, trailActive: true, stopPrice: 500 });
    await h.price(508); // stop 503
    await h.price(502.5); // crosses 503: TRAIL, exit:2 for the 50 left
    await h.price(502.5);
    expect(h.positions.rows[0]).toMatchObject({ status: 'CLOSED', exitReason: 'TRAIL', exitFilledQty: 100 });
    expect(exitsOf(h, p.id).map((o) => [o.idempotencyKey, o.qty])).toEqual([
      ['int_1:exit:1', 50],
      ['int_1:exit:2', 50],
    ]);
    expect(h.sink.events.filter((e) => e.type === 'STOP_MOVED').map((e) => e.payload.to)).toEqual([500, 503]);
  });

  it('square-off: at the effective time the position exits even with no fresh price', async () => {
    const h = lifecycleHarness();
    const p = await h.lifecycle.openPosition(openRequest());
    await h.price(500);
    jest.setSystemTime(ist('2026-10-12T15:15:00.000'));
    await h.lifecycle.sweep(Date.now());
    await h.settle();
    expect(h.positions.rows[0]).toMatchObject({ status: 'EXITING', exitReason: 'SQUARE_OFF' });
    expect(exitsOf(h, p.id)[0].refPrice).toBe(500);
    await h.price(499);
    expect(h.positions.rows[0].status).toBe('CLOSED');
  });

  it('a live squareOffTime tightened after entry applies to the open position (O4)', async () => {
    const h = lifecycleHarness({ liveLimits: () => limitsFixture({ 'squareOffTime@CASH_INTRADAY': '14:00' }) });
    await h.lifecycle.openPosition(openRequest());
    await h.price(500);
    jest.setSystemTime(ist('2026-10-12T14:00:00.000'));
    await h.lifecycle.sweep(Date.now());
    await h.settle();
    expect(h.positions.rows[0]).toMatchObject({ status: 'EXITING', exitReason: 'SQUARE_OFF' });
  });

  it('a rejected exit is re-placed with the next sequence once the session is open, never twice at once (Review Focus 1)', async () => {
    const h = lifecycleHarness();
    const p = await h.lifecycle.openPosition(openRequest());
    await h.price(500);
    await h.price(492); // STOP → exit:1, waiting for a price
    h.advance(30_001);
    await h.matcher.sweep(Date.now()); // no price for 30 s: exit:1 is REJECTED
    await h.settle();
    expect(h.positions.rows[0].status).toBe('EXITING');
    await h.lifecycle.sweep(Date.now());
    await h.settle();
    await h.lifecycle.sweep(Date.now());
    await h.settle();
    expect(exitsOf(h, p.id).map((o) => [o.idempotencyKey, o.state])).toEqual([
      ['int_1:exit:1', 'REJECTED'],
      ['int_1:exit:2', 'OPEN'],
    ]);
    await h.price(491);
    expect(h.positions.rows[0]).toMatchObject({ status: 'CLOSED', exitReason: 'STOP' });
  });

  it('a closed session decides nothing and flags no blind position (Review Focus 4, ruling L9)', async () => {
    const h = lifecycleHarness();
    const p = await h.lifecycle.openPosition(openRequest());
    await h.price(500);
    h.session.open = false;
    h.killOn.add('user_A');
    h.advance(120_000);
    await h.price(480);
    await h.lifecycle.sweep(Date.now());
    await h.settle();
    expect(exitsOf(h, p.id)).toEqual([]);
    expect(h.positions.rows[0]).toMatchObject({ status: 'OPEN', blindSince: null });
  });

  it('blind: no fresh price for blindAfterMs flags BLIND once; a fresh price clears it', async () => {
    const h = lifecycleHarness({ blindAfterMs: 30_000 });
    await h.lifecycle.openPosition(openRequest());
    await h.price(500);
    await h.lifecycle.sweep(Date.now());
    h.advance(30_001);
    await h.lifecycle.sweep(Date.now());
    h.advance(1_000);
    await h.lifecycle.sweep(Date.now());
    await h.settle();
    expect(h.positions.rows[0].blindSince).not.toBeNull();
    await h.price(501);
    await h.lifecycle.sweep(Date.now());
    await h.settle();
    expect(h.positions.rows[0].blindSince).toBeNull();
    expect(h.sink.events.filter((e) => e.type === 'BLIND').map((e) => e.payload.blind)).toEqual([true, false]);
  });

  it('a push and a sweep at once place one exit (Review Focus 5)', async () => {
    const h = lifecycleHarness();
    const p = await h.lifecycle.openPosition(openRequest());
    await h.price(500);
    h.advance(10);
    const crash: Price = { ref: { exchange: 'NSE', token: '2885', symbol: 'RELIANCE-EQ' }, ltp: 490, at: Date.now(), source: 'ws' };
    h.hub.setFresh(crash);
    await Promise.all([h.lifecycle.onPrice(h.hub, crash, Date.now()), h.lifecycle.sweep(Date.now())]);
    await h.settle();
    expect(exitsOf(h, p.id)).toHaveLength(1);
  });

  it('the kill switch (reader) exits at priority 1 from the sweep, the safety net behind the cascade', async () => {
    const h = lifecycleHarness();
    const p = await h.lifecycle.openPosition(openRequest());
    await h.price(500);
    h.killOn.add('user_A');
    await h.lifecycle.sweep(Date.now());
    await h.settle();
    expect(h.positions.rows[0]).toMatchObject({ status: 'EXITING', exitReason: 'KILL_SWITCH' });
    expect(exitsOf(h, p.id)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx jest src/modules/trade-core/lifecycle/core-lifecycle.exits.spec.ts`
Expected: FAIL (no exit orders are ever placed: `onPrice` is the Task 8 placeholder).

- [ ] **Step 3: Implement part 2**

In `apps/api/src/modules/trade-core/lifecycle/core-lifecycle.service.ts`:

1. Extend the imports:

```typescript
import { isHubExchange, refKey, type InstrumentRef, type Price } from '../../market-hub/hub.types';
import type { CoreInstrument, CoreOrder, ExecutionAdapter, OrderSide } from '../execution/execution.types';
import { PRICE_MAX_AGE_MS } from '../execution/fill-model';
import { armLevels, buildExitPlan, round2, type OptionOpen } from './exit-plan';
import { decideExit, effectiveHoldDays, effectiveSquareOff, tradingDaysHeld } from './exit-decision';
import { entryKey, exitKey, isActiveStatus, outranks, type CorePosition, type ExitReason, type LifecycleEvent, type LifecycleEventType, type PositionPatch } from './lifecycle.types';
import { advanceMarks, tightenStop } from './stop-rules';
```

2. Below `ORDERS_REREAD_MS`, add:

```typescript
/** Ruling L7: live limits are re-read at most this often per user. */
export const LIVE_LIMITS_CACHE_MS = 5_000;

/** A price this process may act on: fresh (spec §6.3) and not from the future. */
export function fresh(p: LifecycleMark | null, now: number): LifecycleMark | null {
  return p && p.at <= now && now - p.at <= PRICE_MAX_AGE_MS ? p : null;
}

const opposite = (side: OrderSide): OrderSide => (side === 'BUY' ? 'SELL' : 'BUY');
```

3. Add a field to the class: `private readonly liveLimitCache = new Map<string, { at: number; squareOff: ReadonlyMap<string, string>; mtfMaxHoldDays: number | null }>();`

4. Replace the Task 8 placeholder `onPrice`, and `sweep` / `sweepOne`, with:

```typescript
  /** A hub push (spec §7.2, the main path): evaluate the positions this ref prices, at once. */
  onPrice(hub: HubPrices, p: Price, now: number = Date.now()): Promise<void> {
    const key = refKey(p.ref);
    const runs: Array<Promise<void>> = [];
    for (const id of this.byRef.get(key) ?? []) {
      const h = this.held.get(id);
      if (!h || h.hub !== hub) continue;
      if (!h.lastPrice || p.at > h.lastPrice.at) h.lastPrice = { ltp: p.ltp, at: p.at };
      runs.push(this.evaluate(h, now));
    }
    for (const id of this.byUnderlying.get(key) ?? []) {
      const h = this.held.get(id);
      if (!h || h.hub !== hub) continue;
      if (!h.underlyingPrice || p.at > h.underlyingPrice.at) h.underlyingPrice = { ltp: p.ltp, at: p.at };
      runs.push(this.evaluate(h, now));
    }
    return Promise.all(runs).then(() => undefined);
  }

  /** Every second (spec §7.2): prices from the hub's book, re-reads, blind detection, clock rules, exit re-placement, mark flush. */
  async sweep(now: number = Date.now()): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const blindAfterMs = await this.blindAfterMs(now);
      for (const h of [...this.held.values()]) {
        if (this.inflight.has(h.pos.id)) continue;
        await this.run(h.pos.id, () => this.sweepOne(h, now, blindAfterMs)).catch((err) => this.logger.error(`core position ${h.pos.id}: sweep failed: ${errorText(err)}`));
      }
    } catch (err) {
      this.logger.error(`lifecycle sweep failed: ${errorText(err)}`);
    } finally {
      this.sweeping = false;
    }
  }

  private async sweepOne(h: Held, now: number, blindAfterMs: number): Promise<void> {
    if (h.pos.openQty > 0) this.attachHub(h);
    if (h.hub && h.ref) {
      const r = h.hub.price(h.ref, { maxAgeMs: PRICE_MAX_AGE_MS });
      if (r.kind === 'fresh' && (!h.lastPrice || r.price.at > h.lastPrice.at)) h.lastPrice = { ltp: r.price.ltp, at: r.price.at };
    }
    if (h.hub && h.underlyingRef) {
      const r = h.hub.price(h.underlyingRef, { maxAgeMs: PRICE_MAX_AGE_MS });
      if (r.kind === 'fresh' && (!h.underlyingPrice || r.price.at > h.underlyingPrice.at)) h.underlyingPrice = { ltp: r.price.ltp, at: r.price.at };
    }
    const open = this.clock.isOpen(h.pos.instrument.exchange, new Date(now));
    h.sessionSince = open ? (h.sessionSince ?? now) : null;
    if (now - h.lastReread >= ORDERS_REREAD_MS) await this.applyOrders(h, new Date(now));
    if (this.held.get(h.pos.id) !== h) return;
    await this.checkBlind(h, now, blindAfterMs);
    await this.decide(h, now);
    await this.ensureExit(h, now);
    if (h.dirty && this.held.get(h.pos.id) === h) await this.persist(h, this.pendingMarks(h));
  }

  /** Skip when this position already has work in flight: a push and the sweep never both decide. */
  private evaluate(h: Held, now: number): Promise<void> {
    if (this.inflight.has(h.pos.id)) return Promise.resolve();
    return this.run(h.pos.id, () => this.decide(h, now)).catch((err) => this.logger.error(`core position ${h.pos.id}: evaluation failed: ${errorText(err)}`));
  }

  /** One position, one instant: marks and trail on a fresh price, then decideExit (spec §7.3). Runs inside run(). */
  private async decide(h: Held, now: number): Promise<void> {
    const pos = h.pos;
    if (!isActiveStatus(pos.status) || pos.openQty <= 0 || pos.entryAvgPrice === null) return;
    const at = new Date(now);
    if (!this.clock.isOpen(pos.instrument.exchange, at)) return; // ruling L9
    const price = fresh(h.lastPrice, now);
    const today = istDate(at);
    const firstPriceOfDay = price !== null && h.lastPricedDay !== today;
    if (price) {
      const m = advanceMarks(
        { side: pos.side, plan: pos.plan, entryAvgPrice: pos.entryAvgPrice, stopPrice: pos.stopPrice, trailActive: pos.trailActive, partialDone: pos.partialDone, highWater: pos.highWater, lowWater: pos.lowWater },
        price.ltp,
      );
      if (m.highWater !== pos.highWater || m.lowWater !== pos.lowWater || m.stopPrice !== pos.stopPrice || m.trailActive !== pos.trailActive) {
        h.pos = { ...pos, highWater: m.highWater, lowWater: m.lowWater, stopPrice: m.stopPrice, trailActive: m.trailActive };
        h.dirty = true;
        if (m.stopMoved) this.record('STOP_MOVED', h, { from: pos.stopPrice, to: m.stopPrice, why: m.stopMoved }, at, price);
      }
    }
    if (h.pos.status !== 'EXITING') {
      const rules = await this.liveRules(pos.userId, now);
      const d = decideExit({
        position: h.pos,
        price,
        underlyingLtp: fresh(h.underlyingPrice, now)?.ltp ?? null,
        now: at,
        sessionOpen: true,
        killSwitchActive: await this.killSwitchOn(pos.userId),
        squareOffHhmm: effectiveSquareOff(pos.plan.squareOffHhmm, rules.squareOff.get(pos.vehicle) ?? null),
        mtfMaxHoldDays: effectiveHoldDays(pos.plan.mtfMaxHoldDays, rules.mtfMaxHoldDays),
        tradingDaysHeld: tradingDaysHeld(this.clock, pos.instrument.exchange, pos.plan.entryDay, at),
        recovering: h.recovering,
        firstPriceOfDay,
      });
      if (d.kind === 'EXIT') {
        if (d.reason === 'RECOVERY_STOP') this.record('RECOVERY_STOP', h, { stop: h.pos.stopPrice, detail: d.detail }, at, price);
        await this.exit(h, d.reason, d.detail, now, price);
      } else if (d.kind === 'PARTIAL') {
        await this.partial(h, d.qty, d.detail, now, price);
      }
    }
    if (price) {
      h.lastPricedDay = today;
      h.recovering = false;
    }
  }

  /**
   * Decide a full exit (spec §7.3): persist EXITING and the reason first (Review Focus 2), then
   * place. A position already exiting keeps its order; a higher-priority reason replaces the
   * recorded one. Runs inside run(). Returns the quantity sent.
   */
  private async exit(h: Held, reason: ExitReason, detail: string, now: number, price: LifecycleMark | null): Promise<number> {
    const pos = h.pos;
    if (!isActiveStatus(pos.status)) return 0;
    if (pos.status !== 'EXITING' || outranks(reason, pos.exitReason)) {
      const updated = await this.persist(h, { ...this.pendingMarks(h), status: 'EXITING', exitReason: reason });
      if (!updated) return 0;
      this.record('EXIT_DECIDED', h, { reason, detail, from: pos.status, stop: pos.stopPrice, target: pos.targetPrice }, new Date(now), price);
      if (pos.status !== 'EXITING') this.record('POSITION_STATE', h, { from: pos.status, to: 'EXITING', exitReason: reason }, new Date(now));
    }
    return this.placeExit(h, now);
  }

  /** Target 1 (spec §7.5): sell the partial quantity once; a trail that waits for it starts now. */
  private async partial(h: Held, qty: number, detail: string, now: number, price: LifecycleMark | null): Promise<void> {
    const pos = h.pos;
    const startsTrail = pos.plan.trail.kind === 'atr' && pos.plan.trail.startsAfter === 'PARTIAL';
    const updated = await this.persist(h, { ...this.pendingMarks(h), partialDone: true, trailActive: pos.trailActive || startsTrail });
    if (!updated) return;
    this.record('EXIT_DECIDED', h, { reason: 'PARTIAL_TARGET', partial: true, qty, detail }, new Date(now), price);
    if (qty <= 0) return;
    const orders = await this.adapter.listPositionOrders(pos.userId, pos.id);
    const f = reducePosition(h.pos.status, orders);
    const send = Math.min(qty, f.openQty - f.pendingExitQty);
    if (send <= 0) return;
    const seq = await this.claimSeq(h, orders);
    if (seq === null) return;
    const o = await this.adapter.placeOrder(this.exitRequest(h, seq, send, price?.ltp ?? h.pos.entryAvgPrice));
    if (o.state === 'REJECTED') this.logger.warn(`core position ${pos.id}: partial ${o.idempotencyKey} rejected (${o.rejectReason}); not retried (ruling L17)`);
    await this.applyOrders(h, new Date(now));
  }

  /**
   * Rulings L1/L3: one MARKET exit for what is open and not already being exited. An open
   * entry remainder is cancelled first, so nothing more is bought while exiting.
   */
  private async placeExit(h: Held, now: number): Promise<number> {
    h.lastExitAttempt = now;
    const pos = h.pos;
    let orders = await this.adapter.listPositionOrders(pos.userId, pos.id);
    let f = reducePosition(pos.status, orders);
    if (f.openEntry) {
      await this.adapter.cancel(pos.userId, f.openEntry.id);
      orders = await this.adapter.listPositionOrders(pos.userId, pos.id);
      f = reducePosition(pos.status, orders);
    }
    const qty = f.openQty - f.pendingExitQty;
    if (qty > 0) {
      const seq = await this.claimSeq(h, orders);
      if (seq === null) return 0;
      const o = await this.adapter.placeOrder(this.exitRequest(h, seq, qty, h.lastPrice?.ltp ?? f.entryAvgPrice));
      if (o.state === 'REJECTED') this.logger.warn(`core position ${pos.id}: exit ${o.idempotencyKey} rejected (${o.rejectReason}); the sweep re-places it`);
    }
    await this.applyOrders(h, new Date(now));
    return Math.max(qty, 0);
  }

  /**
   * The exit sequence to use, persisted BEFORE the order is placed (Review Focus 2): the
   * current one if no order has used its key yet (recovery re-places the same key), else the next.
   */
  private async claimSeq(h: Held, orders: readonly CoreOrder[]): Promise<number | null> {
    const cur = h.pos.exitSeq;
    if (cur > 0 && !orders.some((o) => o.idempotencyKey === exitKey(h.pos.intentId, cur))) return cur;
    const next = cur + 1;
    return (await this.persist(h, { ...this.pendingMarks(h), exitSeq: next })) ? next : null;
  }

  private exitRequest(h: Held, seq: number, qty: number, ref: number | null) {
    const pos = h.pos;
    return {
      userId: pos.userId,
      idempotencyKey: exitKey(pos.intentId, seq),
      vehicle: pos.vehicle,
      instrument: pos.instrument,
      side: opposite(pos.side),
      qty,
      type: 'MARKET' as const,
      limitPrice: null,
      triggerPrice: null,
      refPrice: round2(ref ?? pos.entryAvgPrice ?? 0),
      purpose: 'EXIT' as const,
      strategyVersionId: pos.strategyVersionId,
      positionId: pos.id,
    };
  }

  /** Review Focus 1: an EXITING position with nothing being exited is re-placed, in session, at most every 5 s. Runs inside run(). */
  private async ensureExit(h: Held, now: number): Promise<void> {
    if (h.pos.status !== 'EXITING' || now - h.lastExitAttempt < ORDERS_REREAD_MS) return;
    if (!this.clock.isOpen(h.pos.instrument.exchange, new Date(now))) return;
    await this.placeExit(h, now);
  }

  /** Spec §7.2: no fresh price for blindAfterMs while the session is open → BLIND (journaled, warned); a fresh price clears it. */
  private async checkBlind(h: Held, now: number, blindAfterMs: number): Promise<void> {
    const pos = h.pos;
    if (!isActiveStatus(pos.status) || pos.openQty <= 0 || h.sessionSince === null) return;
    const noPriceForMs = now - Math.max(h.lastPrice?.at ?? 0, h.since, h.sessionSince);
    const blind = noPriceForMs > blindAfterMs;
    if (blind && !pos.blindSince) {
      if (await this.persist(h, { ...this.pendingMarks(h), blindSince: new Date(now) })) {
        this.record('BLIND', h, { blind: true, noPriceForMs }, new Date(now));
        this.logger.warn(`core position ${pos.id} (${pos.instrument.symbol}) is BLIND: no fresh price for ${noPriceForMs} ms`);
      }
    } else if (!blind && pos.blindSince) {
      if (await this.persist(h, { ...this.pendingMarks(h), blindSince: null })) this.record('BLIND', h, { blind: false }, new Date(now));
    }
  }

  /** Ruling L7: the user's live squareOffTime per vehicle and mtfMaxHoldDays, cached 5 s; unreadable → frozen values only. */
  private async liveRules(userId: string, now: number): Promise<{ squareOff: ReadonlyMap<string, string>; mtfMaxHoldDays: number | null }> {
    const c = this.liveLimitCache.get(userId);
    if (c && now - c.at < LIVE_LIMITS_CACHE_MS) return c;
    let limits: LimitInForce[] = [];
    try {
      limits = await this.limits.inForce(userId, new Date(now));
    } catch (err) {
      this.logger.warn(`live limits unreadable for ${userId}; the frozen values apply: ${errorText(err)}`);
    }
    const n = Number(limits.find((l) => l.key === 'mtfMaxHoldDays' && l.scope === 'MTF')?.value ?? Number.NaN);
    const entry = {
      at: now,
      squareOff: new Map(limits.filter((l) => l.key === 'squareOffTime').map((l) => [l.scope as string, l.value] as const)),
      mtfMaxHoldDays: Number.isSafeInteger(n) ? n : null,
    };
    this.liveLimitCache.set(userId, entry);
    return entry;
  }

  /** An unreadable switch is never a reason to exit: positions keep their stops (Global Constraints). */
  private async killSwitchOn(userId: string): Promise<boolean> {
    try {
      return await this.killSwitch.isOn(userId);
    } catch (err) {
      this.logger.error(`core kill switch unreadable for ${userId}; positions keep their stops: ${errorText(err)}`);
      return false;
    }
  }

  /** Ruling L10: the optional paper default, or PRICE_MAX_AGE_MS (stricter) when absent or unreadable. */
  private async blindAfterMs(now: number): Promise<number> {
    try {
      const r = await this.defaults.settings(now);
      if (r.ok && r.settings.blindAfterMs !== null) return r.settings.blindAfterMs;
    } catch (err) {
      this.logger.warn(`paper settings unreadable; blind after ${PRICE_MAX_AGE_MS} ms: ${errorText(err)}`);
    }
    return PRICE_MAX_AGE_MS;
  }
```

- [ ] **Step 4: Run it to see it pass**

Run: `npx jest src/modules/trade-core/lifecycle/core-lifecycle.exits.spec.ts src/modules/trade-core/lifecycle/core-lifecycle.open.spec.ts`
Expected: PASS. If the event-order assertion of the first test differs only because an `EXIT_DECIDED` lands before its `POSITION_STATE` (both are recorded in `exit`), fix the code to record in the order shown, not the test.

- [ ] **Step 5: Commit**

```bash
git add -- apps/api/src/modules/trade-core/lifecycle/core-lifecycle.service.ts apps/api/src/modules/trade-core/lifecycle/core-lifecycle.exits.spec.ts
git commit -m "feat(trade-core): lifecycle decides exits on prices and the sweep, re-places rejected exits, flags blind positions" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/api/src/modules/trade-core/lifecycle/core-lifecycle.service.ts apps/api/src/modules/trade-core/lifecycle/core-lifecycle.exits.spec.ts
```

---

### Task 10: `CoreLifecycleService` part 3 — crash recovery, exit-all, guard rails

**Files:**
- Modify: `apps/api/src/modules/trade-core/lifecycle/core-lifecycle.service.ts`
- Test: `apps/api/src/modules/trade-core/lifecycle/core-lifecycle.recovery.spec.ts`

**Interfaces:**
- Consumes: Tasks 8–9.
- Produces: `recover(now?): Promise<number>`; `exitAll(userId, cause: 'KILL_SWITCH' | 'DAILY_LOSS', reason): Promise<{ exitsRequested: number }>` (the `CORE_POSITION_EXITS` port, Task 11); `proposeStop(userId, positionId, proposed, source, now?): Promise<{ accepted: boolean; stopPrice: number | null }>` and `requestExit(userId, positionId, reason: 'GUARD_RAIL' | 'MANUAL', note, now?): Promise<CorePosition>` (SP3 M6 guard rails, the Task 13 controller).

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/modules/trade-core/lifecycle/core-lifecycle.recovery.spec.ts`:

```typescript
import { NotFoundException } from '@nestjs/common';
import { cashPlan, NOW } from './testing/lifecycle-fixtures';
import { lifecycleHarness, openRequest } from './testing/lifecycle-harness';

beforeEach(() => jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] }));
afterEach(() => jest.useRealTimers());

const exitsOf = (h: ReturnType<typeof lifecycleHarness>, id: string) => h.ordersOf(id).filter((o) => o.purpose === 'EXIT');
const ist = (local: string) => new Date(`${local}+05:30`);

describe('CoreLifecycleService: recovery (spec §7.6)', () => {
  it('a recreated service reloads active positions, re-watches them, and a stop crossed while down exits as RECOVERY_STOP', async () => {
    const h = lifecycleHarness();
    const p = await h.lifecycle.openPosition(openRequest());
    await h.price(500);
    const svc = h.restart();
    h.advance(10);
    h.hub.setFresh({ ref: { exchange: 'NSE', token: '2885', symbol: 'RELIANCE-EQ' }, ltp: 480, at: Date.now(), source: 'quote' }); // moved while down
    await svc.sweep(Date.now());
    await h.settle();
    expect(svc.activeCount()).toBe(1);
    expect(h.hub.watches.filter((w) => w.owner === `core:${p.id}`)).toHaveLength(2);
    expect(h.positions.rows[0]).toMatchObject({ status: 'EXITING', exitReason: 'RECOVERY_STOP' });
    expect(h.sink.types(p.id)).toContain('RECOVERY_STOP');
    await h.price(479);
    expect(h.positions.rows[0].status).toBe('CLOSED');
  });

  it('recovery re-places a decided exit with the same idempotency key, once (Review Focus 2)', async () => {
    const h = lifecycleHarness();
    const p = await h.lifecycle.openPosition(openRequest());
    await h.price(500);
    // The crash: the decision and its sequence are persisted, the order never placed.
    await h.positions.repo.update('user_A', p.id, h.positions.rows[0].version, { status: 'EXITING', exitReason: 'STOP', exitSeq: 1 });
    const svc = h.restart();
    await svc.sweep(Date.now());
    await h.settle();
    await svc.sweep(Date.now());
    h.advance(6_000);
    await svc.sweep(Date.now());
    await h.settle();
    expect(exitsOf(h, p.id).map((o) => o.idempotencyKey)).toEqual(['int_1:exit:1']);
    await h.price(499);
    expect(h.positions.rows[0]).toMatchObject({ status: 'CLOSED', exitReason: 'STOP' });
  });

  it('a position whose entry was never placed (crash in between) is CANCELLED on recovery, never entered late', async () => {
    const h = lifecycleHarness();
    await h.positions.repo.createIfNoActive({
      userId: 'user_A', intentId: 'int_ghost', strategyId: 'cs_ungated', strategyVersionId: 'csv_ungated_v1', vehicle: 'CASH_INTRADAY',
      instrument: openRequest().instrument, underlying: 'RELIANCE', side: 'BUY', direction: 'LONG', requestedQty: 100, plan: cashPlan(),
    });
    const svc = h.restart();
    await svc.sweep(Date.now());
    await h.settle();
    expect(h.positions.rows.find((x) => x.intentId === 'int_ghost')).toMatchObject({ status: 'CANCELLED' });
    expect(h.paper.orders).toEqual([]);
  });
});

describe('CoreLifecycleService: exitAll (kill switch / daily loss) and guard rails', () => {
  it('kill switch on a partly filled entry cancels the remainder and exits the filled part (Review Focus 3)', async () => {
    const h = lifecycleHarness();
    const p = await h.lifecycle.openPosition(openRequest());
    await h.price(500, { qty: 40 }); // a book of 40: the entry fills 40 of 100
    expect(h.positions.rows[0]).toMatchObject({ status: 'OPEN', entryFilledQty: 40 });
    expect(await h.lifecycle.exitAll('user_A', 'KILL_SWITCH', 'stop everything')).toEqual({ exitsRequested: 1 });
    await h.settle();
    const orders = h.ordersOf(p.id);
    expect(orders.find((o) => o.purpose === 'ENTRY')).toMatchObject({ state: 'CANCELLED', filledQty: 40 });
    expect(exitsOf(h, p.id).map((o) => o.qty)).toEqual([40]);
    await h.price(499);
    expect(h.positions.rows[0]).toMatchObject({ status: 'CLOSED', exitReason: 'KILL_SWITCH', entryFilledQty: 40, exitFilledQty: 40 });
  });

  it('kill switch on an unfilled entry cancels it and the position is CANCELLED, with no exit order', async () => {
    const h = lifecycleHarness();
    const p = await h.lifecycle.openPosition(openRequest());
    await h.lifecycle.exitAll('user_A', 'KILL_SWITCH', 'stop');
    await h.settle();
    expect(h.positions.rows[0]).toMatchObject({ status: 'CANCELLED' });
    expect(h.ordersOf(p.id).map((o) => [o.purpose, o.state])).toEqual([['ENTRY', 'CANCELLED']]);
  });

  it('a kill switch while a target exit is pending re-labels the reason and adds no order', async () => {
    const h = lifecycleHarness();
    const p = await h.lifecycle.openPosition(openRequest());
    await h.price(500);
    await h.price(515); // TARGET: exit:1 pending
    await h.lifecycle.exitAll('user_A', 'KILL_SWITCH', 'stop');
    await h.settle();
    expect(h.positions.rows[0]).toMatchObject({ status: 'EXITING', exitReason: 'KILL_SWITCH' });
    expect(exitsOf(h, p.id)).toHaveLength(1);
  });

  it("exitAll touches only the user's own positions", async () => {
    const h = lifecycleHarness();
    await h.lifecycle.openPosition(openRequest());
    await h.lifecycle.openPosition(openRequest({}, { intentId: 'int_b', userId: 'user_B' }));
    await h.price(500);
    await h.lifecycle.exitAll('user_A', 'DAILY_LOSS', 'limit reached');
    await h.settle();
    expect(h.positions.rows.map((x) => [x.userId, x.status, x.exitReason])).toEqual([
      ['user_A', 'EXITING', 'DAILY_LOSS'],
      ['user_B', 'OPEN', null],
    ]);
  });

  it('MTF overnight: nothing while closed; the first price of the next session past the stop is a GAP_STOP (Review Focus 4)', async () => {
    const h = lifecycleHarness();
    await h.lifecycle.openPosition(openRequest({}, { strategyId: 'cs_mtf', strategyVersionId: 'csv_mtf_v1', vehicle: 'MTF', mtfLeverage: 2 }));
    await h.price(500); // OPEN, stop 492.5
    h.session.open = false;
    jest.setSystemTime(ist('2026-10-12T20:00:00.000'));
    await h.lifecycle.sweep(Date.now());
    await h.settle();
    expect(h.positions.rows[0]).toMatchObject({ status: 'OPEN', blindSince: null });
    jest.setSystemTime(ist('2026-10-13T09:15:05.000'));
    h.session.open = true;
    await h.price(480);
    expect(h.positions.rows[0]).toMatchObject({ status: 'EXITING', exitReason: 'GAP_STOP' });
    await h.price(481);
    expect(h.positions.rows[0].status).toBe('CLOSED');
  });

  it('guard rails: proposeStop accepts only a tighter stop; requestExit exits as GUARD_RAIL; another user gets a 404', async () => {
    const h = lifecycleHarness();
    const p = await h.lifecycle.openPosition(openRequest());
    await h.price(500);
    expect(await h.lifecycle.proposeStop('user_A', p.id, 490, 'sentinel')).toEqual({ accepted: false, stopPrice: 492.5 });
    expect(await h.lifecycle.proposeStop('user_A', p.id, 495, 'sentinel')).toEqual({ accepted: true, stopPrice: 495 });
    expect(h.positions.rows[0].stopPrice).toBe(495);
    await expect(h.lifecycle.proposeStop('user_B', p.id, 498, 'x')).rejects.toBeInstanceOf(NotFoundException);
    await expect(h.lifecycle.requestExit('user_B', p.id, 'MANUAL', 'x')).rejects.toBeInstanceOf(NotFoundException);
    await h.lifecycle.requestExit('user_A', p.id, 'GUARD_RAIL', 'thesis invalidated');
    expect(h.positions.rows[0]).toMatchObject({ status: 'EXITING', exitReason: 'GUARD_RAIL' });
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx jest src/modules/trade-core/lifecycle/core-lifecycle.recovery.spec.ts`
Expected: FAIL (`exitAll`, `proposeStop`, `requestExit` are not functions; a recreated service holds nothing).

- [ ] **Step 3: Implement part 3**

In `apps/api/src/modules/trade-core/lifecycle/core-lifecycle.service.ts`:

1. Add `NotFoundException` to the `@nestjs/common` import.
2. Add a field `private loaded = false;`.
3. In `sweep`, as the first statement inside `try`, add `if (!this.loaded) await this.recover(now);`.
4. Add these methods:

```typescript
  /**
   * Spec §7.6, on boot (the first sweep): load every user's active positions, re-watch them at
   * P0, re-read their orders. An EXITING position is re-placed by ensureExit with the same key
   * (claimSeq); the first fresh price past the stop exits as RECOVERY_STOP.
   */
  async recover(now: number = Date.now()): Promise<number> {
    const active = await this.repo.listActive();
    for (const pos of active) {
      const h = this.hold(pos, now, true);
      await this.run(pos.id, () => this.applyOrders(h, new Date(now))).catch((err) => this.logger.error(`core position ${pos.id}: recovery failed: ${errorText(err)}`));
    }
    this.loaded = true;
    this.logger.log(`lifecycle: recovered ${active.length} active core position(s)`);
    return active.length;
  }

  /**
   * CORE_POSITION_EXITS (Task 11): exit every active core position of the user, kill switch
   * (priority 1) or daily loss (priority 2). Exits are never blocked; outside the session they
   * are re-placed at the next open by ensureExit. Throws after trying all, so the cascade
   * reports FAILED rather than a partial OK.
   */
  async exitAll(userId: string, cause: 'KILL_SWITCH' | 'DAILY_LOSS', reason: string): Promise<{ exitsRequested: number }> {
    if (!this.loaded) await this.recover();
    const mine = [...this.held.values()].filter((h) => h.pos.userId === userId && isActiveStatus(h.pos.status));
    const failures: string[] = [];
    let requested = 0;
    for (const h of mine) {
      try {
        await this.run(h.pos.id, async () => {
          const now = Date.now();
          await this.exit(h, cause, reason, now, fresh(h.lastPrice, now));
        });
        requested += 1;
      } catch (err) {
        failures.push(`${h.pos.id}: ${errorText(err)}`);
      }
    }
    if (failures.length > 0) throw new Error(`requested ${requested} of ${mine.length} core position exits; failed: ${failures.join('; ')}`);
    return { exitsRequested: requested };
  }

  /** SP3/SP4 guard rails (SP3 spec §9): a stop may only tighten (spec §7.4). */
  async proposeStop(userId: string, positionId: string, proposed: number, source: string, now: number = Date.now()): Promise<{ accepted: boolean; stopPrice: number | null }> {
    const h = this.mine(userId, positionId);
    return this.run(positionId, async () => {
      const pos = h.pos;
      if (!isActiveStatus(pos.status) || pos.status === 'EXITING' || pos.entryAvgPrice === null) return { accepted: false, stopPrice: pos.stopPrice };
      const t = tightenStop(pos.stopPrice, proposed, pos.side);
      if (!t.accepted) {
        this.record('STOP_MOVED', h, { source, proposed, accepted: false, stop: pos.stopPrice }, new Date(now));
        return { accepted: false, stopPrice: pos.stopPrice };
      }
      const updated = await this.persist(h, { ...this.pendingMarks(h), stopPrice: t.stop });
      if (!updated) return { accepted: false, stopPrice: h.pos.stopPrice };
      this.record('STOP_MOVED', h, { source, from: pos.stopPrice, to: t.stop, why: 'GUARD_RAIL', accepted: true }, new Date(now));
      return { accepted: true, stopPrice: t.stop };
    });
  }

  /** A guard rail or the owner asks for an exit (ranked with the stop, priority 3). */
  async requestExit(userId: string, positionId: string, reason: 'GUARD_RAIL' | 'MANUAL', note: string, now: number = Date.now()): Promise<CorePosition> {
    const h = this.mine(userId, positionId);
    await this.run(positionId, async () => {
      await this.exit(h, reason, note, now, fresh(h.lastPrice, now));
    });
    return h.pos;
  }

  private mine(userId: string, positionId: string): Held {
    const h = this.held.get(positionId);
    if (!h || h.pos.userId !== userId) throw new NotFoundException(`active core position ${positionId} not found`);
    return h;
  }
```

- [ ] **Step 4: Run the lifecycle suites**

Run: `npx jest src/modules/trade-core/lifecycle`
Expected: PASS (every suite, including Tasks 8 and 9; their sweeps now start with the boot reload, which finds the positions they opened already held).

- [ ] **Step 5: Commit**

```bash
git add -- apps/api/src/modules/trade-core/lifecycle/core-lifecycle.service.ts apps/api/src/modules/trade-core/lifecycle/core-lifecycle.recovery.spec.ts
git commit -m "feat(trade-core): lifecycle crash recovery, exit-all and tighten-only guard-rail entry points" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/api/src/modules/trade-core/lifecycle/core-lifecycle.service.ts apps/api/src/modules/trade-core/lifecycle/core-lifecycle.recovery.spec.ts
```

---

## Stream D — the M2 ports, rebound to real positions

Stream D codes against two small ports (Task 11 Step 1) and fakes the lifecycle, so it never waits for Stream C.

### Task 11: `RISK_STATE_PROVIDER` from core positions and their marks

**Files:**
- Create: `apps/api/src/modules/trade-core/lifecycle/lifecycle-ports.ts`
- Create: `apps/api/src/modules/trade-core/lifecycle/core-risk-state.provider.ts`
- Test: `apps/api/src/modules/trade-core/lifecycle/core-risk-state.provider.spec.ts`

**Interfaces:**
- Consumes: `RiskStateProvider`, `RiskLiveState`, `RiskOpenPosition` (M2); `PaperLedgerService.funds/dayStats/netPnlTodayByPosition` (M3 + Task 6); `SEGMENT_BY_VEHICLE` (M3 `paper-ledger.service.ts`); `chargesForLeg` (`trade-sentinel/charges.ts`); `PRICE_MAX_AGE_MS`; `CorePositionRepository.listForUser` (Task 7); `isActiveStatus`, `CorePosition` (Task 1); `round2` (Task 2); `istDate`.
- Produces: `LIFECYCLE_MARKS` + `LifecycleMarks { mark(positionId): { ltp; at } | null }`; `CORE_POSITION_EXITS` + `CorePositionExits { exitAll(userId, cause, reason): Promise<{ exitsRequested: number }> }` (both bound to `CoreLifecycleService` in Task 13); `markToMarket(p, ltp): number`; `CoreRiskStateProvider`.

- [ ] **Step 1: The ports**

Create `apps/api/src/modules/trade-core/lifecycle/lifecycle-ports.ts`:

```typescript
import type { CoreSquareOffCause } from '../risk-wall/ports';

/**
 * Ruling L14: what the risk seams need from the lifecycle, as tokens. Both are bound to
 * CoreLifecycleService with useExisting (Task 13). CORE_SQUARE_OFF resolves
 * CORE_POSITION_EXITS lazily through ModuleRef, because the adapter the lifecycle uses
 * injects the kill switch, which injects CORE_SQUARE_OFF.
 */
export const LIFECYCLE_MARKS = Symbol('LIFECYCLE_MARKS');
export const CORE_POSITION_EXITS = Symbol('CORE_POSITION_EXITS');

export interface LifecycleMarks {
  /** The newest price the lifecycle holds for the position (receipt time `at`, ms), or null. */
  mark(positionId: string): { ltp: number; at: number } | null;
}

export interface CorePositionExits {
  exitAll(userId: string, cause: CoreSquareOffCause, reason: string): Promise<{ exitsRequested: number }>;
}
```

- [ ] **Step 2: Write the failing test**

Create `apps/api/src/modules/trade-core/lifecycle/core-risk-state.provider.spec.ts`:

```typescript
import { Prisma } from '@prisma/client';
import { chargesForLeg } from '../../trade-sentinel/charges';
import { PaperLedgerService, type PlaceContext } from '../execution/paper-ledger.service';
import { fakeDefaults, MemoryPaperStore } from '../execution/testing/memory-paper-store';
import { cashBuy } from '../execution/testing/paper-fixtures';
import { checkRisk } from '../risk-wall/risk-wall';
import { ctxFixture, intentFixture } from '../risk-wall/testing/risk-fixtures';
import { CoreRiskStateProvider, markToMarket } from './core-risk-state.provider';
import { cashPlan, NOW } from './testing/lifecycle-fixtures';
import { MemoryPositionStore } from './testing/memory-position-store';

const OPEN: PlaceContext = { sessionOpen: true, killSwitchActive: false };
const D = (s: string) => new Prisma.Decimal(s);

function setup() {
  const store = new MemoryPaperStore(() => NOW);
  const ledger = new PaperLedgerService(store.tx, store.orderRepo, store.fillRepo, store.ledgerRepo, fakeDefaults());
  const positions = new MemoryPositionStore(() => NOW);
  const marks = new Map<string, { ltp: number; at: number }>();
  const provider = new CoreRiskStateProvider(ledger, positions.repo, { mark: (id) => marks.get(id) ?? null });
  return { store, ledger, positions, marks, provider };
}

/** A filled cash BUY of 100 @ 500 under a core position (the ledger and the position agree). */
async function openCash(s: ReturnType<typeof setup>, userId = 'user_A', intentId = 'int_1', fill = true) {
  const p = await s.positions.repo.createIfNoActive({
    userId, intentId, strategyId: 'cs_ungated', strategyVersionId: 'csv_ungated_v1', vehicle: 'CASH_INTRADAY',
    instrument: { exchange: 'NSE', token: '2885', symbol: 'RELIANCE-EQ', lotSize: 1, underlying: null },
    underlying: 'RELIANCE', side: 'BUY', direction: 'LONG', requestedQty: 100, plan: cashPlan(),
  });
  const entry = (await s.ledger.place(cashBuy({ userId, idempotencyKey: `${intentId}:entry`, positionId: p.id }), OPEN, NOW)).order;
  if (!fill) return p;
  await s.ledger.applyFill(userId, entry.id, entry, { qty: 100, price: D('500'), priceAt: NOW }, NOW);
  const opened = await s.positions.repo.update(userId, p.id, 0, { status: 'OPEN', entryFilledQty: 100, entryAvgPrice: 500, openedAt: NOW });
  if (!opened) throw new Error('fixture update lost');
  return opened;
}

describe('CoreRiskStateProvider (RISK_STATE_PROVIDER, M2 notes for M4)', () => {
  it('reports each active position with its strategy, exposure underlying and state; priced only with a fresh mark', async () => {
    const s = setup();
    const p = await openCash(s);
    s.marks.set(p.id, { ltp: 510, at: NOW.getTime() - 1_000 });
    expect((await s.provider.liveState('user_A', NOW)).openPositions).toEqual([
      { positionId: p.id, strategyId: 'cs_ungated', vehicle: 'CASH_INTRADAY', symbol: 'RELIANCE-EQ', underlying: 'RELIANCE', direction: 'LONG', state: 'OPEN', priced: true },
    ]);
    s.marks.set(p.id, { ltp: 510, at: NOW.getTime() - 16_000 });
    const stale = await s.provider.liveState('user_A', NOW);
    expect(stale.openPositions[0].priced).toBe(false);
    expect(stale.openPnl).toBeNull();
    s.marks.delete(p.id);
    expect((await s.provider.liveState('user_A', NOW)).openPositions[0].priced).toBe(false);
  });

  it("openPnl is the mark net of the exit leg's charges; the strategy's P&L adds today's realised (net) of its positions", async () => {
    const s = setup();
    const p = await openCash(s);
    s.marks.set(p.id, { ltp: 510, at: NOW.getTime() });
    const exitLeg = chargesForLeg({ segment: 'EQ_INTRADAY', leg: 'SELL', price: 510, qty: 100 }).total;
    const expected = Math.round((1000 - exitLeg) * 100) / 100;
    expect(markToMarket(p, 510)).toBe(expected);
    const state = await s.provider.liveState('user_A', NOW);
    expect(state.openPnl).toBe(expected);
    const entryNet = (await s.ledger.netPnlTodayByPosition('user_A', NOW)).get(p.id)?.toNumber() ?? 0;
    expect(entryNet).toBeLessThan(0); // the entry's charges
    expect(state.pnlTodayByStrategy).toEqual({ cs_ungated: Math.round((entryNet + expected) * 100) / 100 });
    expect(state.tradesToday).toBe(1);
    expect(state.deployedCapital.CASH_INTRADAY).toBe(10000);
    expect(state.dailyLossLatched).toBe(false);
  });

  it('a pending entry with nothing filled is priced, with no open P&L', async () => {
    const s = setup();
    await openCash(s, 'user_A', 'int_1', false);
    const state = await s.provider.liveState('user_A', NOW);
    expect(state.openPositions.map((x) => [x.state, x.priced])).toEqual([['PENDING_ENTRY', true]]);
    expect(state.openPnl).toBe(0);
  });

  it("reports only the caller's positions", async () => {
    const s = setup();
    await openCash(s, 'user_A', 'int_a');
    const b = await openCash(s, 'user_B', 'int_b');
    s.marks.set(b.id, { ltp: 500, at: NOW.getTime() });
    expect((await s.provider.liveState('user_B', NOW)).openPositions.map((x) => x.positionId)).toEqual([b.id]);
  });

  it('with fresh marks the Risk Wall can ALLOW an entry; an unpriced position makes it reject', async () => {
    const s = setup();
    const p = await openCash(s);
    const tcs = intentFixture({ intentId: 'int_tcs', symbol: 'TCS', underlying: 'TCS' });
    expect(checkRisk(tcs, ctxFixture({ state: await s.provider.liveState('user_A', NOW) })).reasons.map((r) => r.code)).toContain('UNPRICED_POSITION');
    s.marks.set(p.id, { ltp: 501, at: NOW.getTime() });
    expect(checkRisk(tcs, ctxFixture({ state: await s.provider.liveState('user_A', NOW) })).verdict).toBe('ALLOW');
  });

  it('a ledger read that fails throws (RiskWallService turns it into CONTEXT_UNAVAILABLE)', async () => {
    const s = setup();
    jest.spyOn(s.ledger, 'funds').mockRejectedValueOnce(new Error('db down'));
    await expect(s.provider.liveState('user_A', NOW)).rejects.toThrow('db down');
  });
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `npx jest src/modules/trade-core/lifecycle/core-risk-state.provider.spec.ts`
Expected: FAIL, "Cannot find module './core-risk-state.provider'".

- [ ] **Step 4: Implement**

Create `apps/api/src/modules/trade-core/lifecycle/core-risk-state.provider.ts`:

```typescript
import { Inject, Injectable } from '@nestjs/common';
import { chargesForLeg } from '../../trade-sentinel/charges';
import { PRICE_MAX_AGE_MS } from '../execution/fill-model';
import { istDate } from '../execution/ledger-math';
import { PaperLedgerService, SEGMENT_BY_VEHICLE } from '../execution/paper-ledger.service';
import type { RiskStateProvider } from '../risk-wall/ports';
import type { RiskLiveState, RiskOpenPosition } from '../risk-wall/risk-wall.types';
import { VEHICLES, type Vehicle } from '../strategies/blocks/block-types';
import { round2 } from './exit-plan';
import { LIFECYCLE_MARKS, type LifecycleMarks } from './lifecycle-ports';
import { isActiveStatus, type CorePosition } from './lifecycle.types';
import { CorePositionRepository } from './repositories/core-position.repository';

/** A ledger amount string as rupees; anything unparseable is unknown (null), which the wall rejects. */
function rupees(s: string): number | null {
  const n = Number(s);
  return s.trim() !== '' && Number.isFinite(n) ? n : null;
}

/** Open P&L at `ltp`, net of the exit leg's charges (Risk Wall rupees are net of charges). */
export function markToMarket(p: Pick<CorePosition, 'vehicle' | 'side' | 'openQty' | 'entryAvgPrice'>, ltp: number): number {
  const dir = p.side === 'BUY' ? 1 : -1;
  const gross = (ltp - (p.entryAvgPrice ?? ltp)) * p.openQty * dir;
  const exitLeg = chargesForLeg({ segment: SEGMENT_BY_VEHICLE[p.vehicle], leg: p.side === 'BUY' ? 'SELL' : 'BUY', price: ltp, qty: p.openQty }).total;
  return round2(gross - exitLeg);
}

/**
 * RISK_STATE_PROVIDER (spec §5.1; M2 notes for M4): open positions from core_positions with
 * their strategy and exposure underlying, `priced` from a lifecycle mark no older than
 * PRICE_MAX_AGE_MS, open P&L from those marks (null when any open position is unpriced: the
 * wall then rejects), today's realised P&L, per-strategy P&L, entries and deployed capital
 * from the ledger. The daily-loss latch stays M5's (ruling L15). A read failure throws.
 */
@Injectable()
export class CoreRiskStateProvider implements RiskStateProvider {
  constructor(
    private readonly ledger: PaperLedgerService,
    private readonly positions: CorePositionRepository,
    @Inject(LIFECYCLE_MARKS) private readonly marks: LifecycleMarks,
  ) {}

  async liveState(userId: string, at: Date): Promise<RiskLiveState> {
    const dayStart = new Date(`${istDate(at)}T00:00:00.000+05:30`);
    const [funds, day, rows, realisedByPosition] = await Promise.all([
      this.ledger.funds(userId),
      this.ledger.dayStats(userId, at),
      this.positions.listForUser(userId, dayStart),
      this.ledger.netPnlTodayByPosition(userId, at),
    ]);
    const byStrategy: Record<string, number> = {};
    const add = (strategyId: string, v: number) => {
      byStrategy[strategyId] = round2((byStrategy[strategyId] ?? 0) + v);
    };
    let openPnl: number | null = 0;
    const openPositions: RiskOpenPosition[] = [];
    for (const p of rows) {
      const realised = realisedByPosition.get(p.id);
      if (realised) add(p.strategyId, realised.toNumber());
      if (!isActiveStatus(p.status)) continue;
      let priced = true;
      if (p.openQty > 0) {
        const m = this.marks.mark(p.id);
        if (m === null || p.entryAvgPrice === null || m.at > at.getTime() || at.getTime() - m.at > PRICE_MAX_AGE_MS) {
          priced = false;
          openPnl = null;
        } else {
          const u = markToMarket(p, m.ltp);
          add(p.strategyId, u);
          if (openPnl !== null) openPnl = round2(openPnl + u);
        }
      }
      openPositions.push({
        positionId: p.id,
        strategyId: p.strategyId,
        vehicle: p.vehicle,
        symbol: p.instrument.symbol,
        underlying: p.underlying,
        direction: p.direction,
        state: p.status,
        priced,
      });
    }
    return {
      asOf: at,
      openPositions,
      realisedPnlToday: day.netPnlToday.toNumber(),
      openPnl,
      pnlTodayByStrategy: byStrategy,
      tradesToday: day.entriesToday,
      deployedCapital: Object.fromEntries(VEHICLES.map((v) => [v, rupees(funds.deployedByVehicle[v])])) as Record<Vehicle, number | null>,
      dailyLossLatched: false,
    };
  }
}
```

- [ ] **Step 5: Run it to see it pass**

Run: `npx jest src/modules/trade-core/lifecycle/core-risk-state.provider.spec.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -- apps/api/src/modules/trade-core/lifecycle/lifecycle-ports.ts apps/api/src/modules/trade-core/lifecycle/core-risk-state.provider.ts apps/api/src/modules/trade-core/lifecycle/core-risk-state.provider.spec.ts
git commit -m "feat(trade-core): risk state from core positions, marks and per-strategy P&L" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/api/src/modules/trade-core/lifecycle/lifecycle-ports.ts apps/api/src/modules/trade-core/lifecycle/core-risk-state.provider.ts apps/api/src/modules/trade-core/lifecycle/core-risk-state.provider.spec.ts
```

---

### Task 12: `CORE_SQUARE_OFF` that exits positions, and the daily-loss monitor

**Files:**
- Create: `apps/api/src/modules/trade-core/lifecycle/core-square-off.ts`
- Create: `apps/api/src/modules/trade-core/lifecycle/daily-loss.monitor.ts`
- Modify: `apps/api/src/common/audit/audit-actions.ts` (a `lifecycle` group)
- Test: `apps/api/src/modules/trade-core/lifecycle/core-square-off.spec.ts`, `apps/api/src/modules/trade-core/lifecycle/daily-loss.monitor.spec.ts`

**Interfaces:**
- Consumes: `CoreSquareOffPort`, `CoreSquareOffCause`, `CORE_SQUARE_OFF`, `RISK_STATE_PROVIDER`, `RiskStateProvider` (M2 `ports.ts`); `decideDailyLoss` (M2 `risk-wall.ts`); `CoreRiskLimitService.inForce`; `PaperOrderSquareOff` (entries only, Task 6); `CORE_POSITION_EXITS`, `CorePositionExits` (Task 11); `CorePositionRepository.listActiveUserIds` (Task 7); `AuditService`; `bootJobsEnabled`.
- Produces: `CoreSquareOff` (the `CORE_SQUARE_OFF` binding); `DAILY_LOSS_CHECK_MS = 5_000`; `DailyLossMonitor` with `runOnce(now?)`, `checkUser(userId, now)`; `AUDIT_ACTIONS.lifecycle.CORE_POSITION_EXIT_REQUESTED`, `AUDIT_ACTIONS.lifecycle.CORE_DAILY_LOSS_SQUARE_OFF`.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/modules/trade-core/lifecycle/core-square-off.spec.ts`:

```typescript
import type { ModuleRef } from '@nestjs/core';
import type { PaperOrderSquareOff } from '../execution/paper-order-square-off';
import { CoreSquareOff } from './core-square-off';
import { CORE_POSITION_EXITS } from './lifecycle-ports';

function setup(opts: { entriesFail?: boolean; exitsFail?: boolean } = {}) {
  const entries = {
    squareOffAll: opts.entriesFail
      ? jest.fn().mockRejectedValue(new Error('db down'))
      : jest.fn().mockResolvedValue({ cancelledOrders: 2, exitsRequested: 0, detail: '2 pending core entry order(s) cancelled' }),
  };
  const exits = { exitAll: opts.exitsFail ? jest.fn().mockRejectedValue(new Error('requested 0 of 1 core position exits')) : jest.fn().mockResolvedValue({ exitsRequested: 3 }) };
  const moduleRef = { get: jest.fn().mockReturnValue(exits) };
  const sq = new CoreSquareOff(entries as unknown as PaperOrderSquareOff, moduleRef as unknown as ModuleRef);
  return { entries, exits, moduleRef, sq };
}

describe('CoreSquareOff (CORE_SQUARE_OFF, spec §5.3/§5.4)', () => {
  it('cancels pending entry orders first, then exits every position, and reports both', async () => {
    const { entries, exits, sq } = setup();
    expect(await sq.squareOffAll('user_A', 'KILL_SWITCH', 'stop')).toEqual({
      cancelledOrders: 2,
      exitsRequested: 3,
      detail: '2 pending core entry order(s) cancelled; 3 core position exit(s) requested',
    });
    expect(entries.squareOffAll).toHaveBeenCalledWith('user_A', 'KILL_SWITCH', 'stop');
    expect(exits.exitAll).toHaveBeenCalledWith('user_A', 'KILL_SWITCH', 'stop');
    expect(entries.squareOffAll.mock.invocationCallOrder[0]).toBeLessThan(exits.exitAll.mock.invocationCallOrder[0]);
  });

  it('resolves the lifecycle lazily, at call time (ruling L14)', async () => {
    const { moduleRef, sq } = setup();
    expect(moduleRef.get).not.toHaveBeenCalled();
    await sq.squareOffAll('user_A', 'DAILY_LOSS', 'limit');
    expect(moduleRef.get).toHaveBeenCalledWith(CORE_POSITION_EXITS, { strict: false });
  });

  it('a failed cancellation still requests the exits, then fails the step (never a silent partial OK)', async () => {
    const { exits, sq } = setup({ entriesFail: true });
    await expect(sq.squareOffAll('user_A', 'KILL_SWITCH', 'stop')).rejects.toThrow('entry orders: db down');
    expect(exits.exitAll).toHaveBeenCalled();
  });

  it('a failed exit fails the step', async () => {
    const { sq } = setup({ exitsFail: true });
    await expect(sq.squareOffAll('user_A', 'KILL_SWITCH', 'stop')).rejects.toThrow('positions: requested 0 of 1 core position exits');
  });
});
```

Create `apps/api/src/modules/trade-core/lifecycle/daily-loss.monitor.spec.ts`:

```typescript
import type { AuditService } from '../../../common/audit/audit.service';
import { AUDIT_ACTIONS } from '../../../common/audit/audit-actions';
import type { CoreSquareOffPort, RiskStateProvider } from '../risk-wall/ports';
import type { CoreRiskLimitService } from '../risk-wall/services/core-risk-limit.service';
import { limitsFixture, NOW, stateFixture } from '../risk-wall/testing/risk-fixtures';
import { DailyLossMonitor } from './daily-loss.monitor';
import type { CorePositionRepository } from './repositories/core-position.repository';

function setup(o: { action?: string; realised?: number; openPnl?: number | null; users?: string[]; stateFails?: boolean; squareOffFailsOnce?: boolean } = {}) {
  const positions = { listActiveUserIds: jest.fn().mockResolvedValue(o.users ?? ['user_A']) };
  const state = {
    liveState: o.stateFails
      ? jest.fn().mockRejectedValue(new Error('ledger down'))
      : jest.fn().mockResolvedValue(stateFixture({ realisedPnlToday: o.realised ?? -4000, openPnl: o.openPnl === undefined ? -1500 : o.openPnl })),
  };
  const limits = { inForce: jest.fn().mockResolvedValue(limitsFixture({ 'dailyLossAction@ALL': o.action ?? 'BLOCK_AND_SQUARE_OFF' })) };
  const squareOff = { squareOffAll: jest.fn().mockResolvedValue({ cancelledOrders: 0, exitsRequested: 1, detail: '0 pending core entry order(s) cancelled; 1 core position exit(s) requested' }) };
  if (o.squareOffFailsOnce) squareOff.squareOffAll.mockRejectedValueOnce(new Error('exit failed'));
  const audit = { append: jest.fn().mockResolvedValue({ seq: 1n, hash: 'h' }) };
  const monitor = new DailyLossMonitor(
    positions as unknown as CorePositionRepository,
    state as unknown as RiskStateProvider,
    limits as unknown as CoreRiskLimitService,
    squareOff as unknown as CoreSquareOffPort,
    audit as unknown as AuditService,
  );
  return { positions, state, limits, squareOff, audit, monitor };
}

describe('DailyLossMonitor (spec §5.3, ruling L15)', () => {
  it("BLOCK_AND_SQUARE_OFF: a breach squares off the user's core once per IST day, audited", async () => {
    const s = setup(); // loss 4000 + 1500 = 5500 ≥ the 5000 limit
    await s.monitor.runOnce(NOW);
    await s.monitor.runOnce(NOW);
    expect(s.squareOff.squareOffAll).toHaveBeenCalledTimes(1);
    expect(s.squareOff.squareOffAll).toHaveBeenCalledWith('user_A', 'DAILY_LOSS', "today's loss ₹5500.00 reached the ₹5000.00 daily limit");
    expect(s.audit.append).toHaveBeenCalledWith(expect.objectContaining({ action: AUDIT_ACTIONS.lifecycle.CORE_DAILY_LOSS_SQUARE_OFF, userId: 'user_A' }));
    await s.monitor.runOnce(new Date(NOW.getTime() + 86_400_000));
    expect(s.squareOff.squareOffAll).toHaveBeenCalledTimes(2);
  });

  it('BLOCK_ENTRIES never squares off (the Risk Wall blocks entries)', async () => {
    const s = setup({ action: 'BLOCK_ENTRIES' });
    await s.monitor.runOnce(NOW);
    expect(s.squareOff.squareOffAll).not.toHaveBeenCalled();
  });

  it('within the limit, or with the P&L unknown, nothing happens', async () => {
    const within = setup({ realised: -100 });
    await within.monitor.runOnce(NOW);
    const unknown = setup({ openPnl: null });
    await unknown.monitor.runOnce(NOW);
    expect(within.squareOff.squareOffAll).not.toHaveBeenCalled();
    expect(unknown.squareOff.squareOffAll).not.toHaveBeenCalled();
  });

  it('an unreadable state skips the user and never exits', async () => {
    const s = setup({ stateFails: true });
    await expect(s.monitor.runOnce(NOW)).resolves.toBeUndefined();
    expect(s.squareOff.squareOffAll).not.toHaveBeenCalled();
  });

  it('a failed square-off is retried on the next check', async () => {
    const s = setup({ squareOffFailsOnce: true });
    await s.monitor.runOnce(NOW);
    await s.monitor.runOnce(NOW);
    expect(s.squareOff.squareOffAll).toHaveBeenCalledTimes(2);
  });

  it('only users with active positions are checked', async () => {
    const s = setup({ users: [] });
    await s.monitor.runOnce(NOW);
    expect(s.state.liveState).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx jest src/modules/trade-core/lifecycle/core-square-off.spec.ts src/modules/trade-core/lifecycle/daily-loss.monitor.spec.ts`
Expected: FAIL (modules not found).

- [ ] **Step 3: The audit vocabulary**

In `apps/api/src/common/audit/audit-actions.ts`, after the `paper` group, add:

```typescript
  lifecycle: {
    CORE_POSITION_EXIT_REQUESTED: 'CORE_POSITION_EXIT_REQUESTED',
    CORE_DAILY_LOSS_SQUARE_OFF: 'CORE_DAILY_LOSS_SQUARE_OFF',
  },
```

- [ ] **Step 4: Implement**

Create `apps/api/src/modules/trade-core/lifecycle/core-square-off.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { PaperOrderSquareOff } from '../execution/paper-order-square-off';
import type { CoreSquareOffCause, CoreSquareOffPort, CoreSquareOffResult } from '../risk-wall/ports';
import { CORE_POSITION_EXITS, type CorePositionExits } from './lifecycle-ports';

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * CORE_SQUARE_OFF (spec §5.3, §5.4): cancel the user's pending core ENTRY orders, then exit
 * every active core position (kill switch = priority 1, daily loss = priority 2). Both halves
 * always run; any failure is thrown after both, so the kill-switch cascade reports FAILED,
 * never a partial OK. The lifecycle is resolved at call time (ruling L14).
 */
@Injectable()
export class CoreSquareOff implements CoreSquareOffPort {
  constructor(
    private readonly entries: PaperOrderSquareOff,
    private readonly moduleRef: ModuleRef,
  ) {}

  async squareOffAll(userId: string, cause: CoreSquareOffCause, reason: string): Promise<CoreSquareOffResult> {
    const failures: string[] = [];
    let cancelledOrders = 0;
    try {
      cancelledOrders = (await this.entries.squareOffAll(userId, cause, reason)).cancelledOrders;
    } catch (err) {
      failures.push(`entry orders: ${errorText(err)}`);
    }
    let exitsRequested = 0;
    try {
      exitsRequested = (await this.exits().exitAll(userId, cause, reason)).exitsRequested;
    } catch (err) {
      failures.push(`positions: ${errorText(err)}`);
    }
    if (failures.length > 0) {
      throw new Error(`core square-off incomplete (${cancelledOrders} entry order(s) cancelled, ${exitsRequested} exit(s) requested): ${failures.join('; ')}`);
    }
    return { cancelledOrders, exitsRequested, detail: `${cancelledOrders} pending core entry order(s) cancelled; ${exitsRequested} core position exit(s) requested` };
  }

  private exits(): CorePositionExits {
    return this.moduleRef.get<CorePositionExits>(CORE_POSITION_EXITS, { strict: false });
  }
}
```

Create `apps/api/src/modules/trade-core/lifecycle/daily-loss.monitor.ts`:

```typescript
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { AUDIT_ACTIONS } from '../../../common/audit/audit-actions';
import { AuditService } from '../../../common/audit/audit.service';
import { BOOT_JOBS_DISABLED, bootJobsEnabled } from '../../../common/utils/boot-jobs';
import { istDate } from '../execution/ledger-math';
import { CORE_SQUARE_OFF, RISK_STATE_PROVIDER, type CoreSquareOffPort, type RiskStateProvider } from '../risk-wall/ports';
import { decideDailyLoss } from '../risk-wall/risk-wall';
import type { DailyLossDecision } from '../risk-wall/risk-wall.types';
import { CoreRiskLimitService } from '../risk-wall/services/core-risk-limit.service';
import { CorePositionRepository } from './repositories/core-position.repository';

/** Ruling L15: the cadence of the daily-loss check. */
export const DAILY_LOSS_CHECK_MS = 5_000;

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Spec §5.3 (M2 notes for M4): for every user with active core positions, decideDailyLoss on
 * the limits in force and the live state; when the action is BLOCK_AND_SQUARE_OFF and the loss
 * is reached, CORE_SQUARE_OFF with cause DAILY_LOSS, once per user per IST day in this process
 * (a repeat after a restart only exits what is still open). A state that cannot be read is
 * never a reason to exit (positions keep their stops; the wall already rejects entries).
 */
@Injectable()
export class DailyLossMonitor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DailyLossMonitor.name);
  private readonly firedOn = new Map<string, string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly positions: CorePositionRepository,
    @Inject(RISK_STATE_PROVIDER) private readonly state: RiskStateProvider,
    private readonly limits: CoreRiskLimitService,
    @Inject(CORE_SQUARE_OFF) private readonly squareOff: CoreSquareOffPort,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    if (!bootJobsEnabled()) {
      this.logger.log(BOOT_JOBS_DISABLED);
      return;
    }
    this.timer = setInterval(() => void this.runOnce(), DAILY_LOSS_CHECK_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runOnce(now: Date = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const userId of await this.positions.listActiveUserIds()) await this.checkUser(userId, now);
    } catch (err) {
      this.logger.error(`daily-loss check failed: ${errorText(err)}`);
    } finally {
      this.running = false;
    }
  }

  async checkUser(userId: string, now: Date): Promise<DailyLossDecision | null> {
    const day = istDate(now);
    if (this.firedOn.get(userId) === day) return null;
    let d: DailyLossDecision;
    try {
      d = decideDailyLoss(await this.limits.inForce(userId, now), await this.state.liveState(userId, now));
    } catch (err) {
      this.logger.warn(`daily-loss check for ${userId} skipped (state unreadable; positions keep their stops): ${errorText(err)}`);
      return null;
    }
    if (d.status !== 'BREACHED' || !d.squareOffCore) return d;
    this.firedOn.set(userId, day);
    const reason = `today's loss ₹${d.lossRupees} reached the ₹${d.limitRupees} daily limit`;
    try {
      const r = await this.squareOff.squareOffAll(userId, 'DAILY_LOSS', reason);
      this.logger.warn(`daily loss for ${userId}: ${r.detail}`);
      await this.audit
        .append({ action: AUDIT_ACTIONS.lifecycle.CORE_DAILY_LOSS_SQUARE_OFF, userId, target: `core_daily_loss:${userId}:${day}`, meta: { reason, result: r.detail } })
        .catch((err: unknown) => this.logger.error(`daily-loss audit for ${userId} failed (the square-off ran): ${errorText(err)}`));
    } catch (err) {
      this.firedOn.delete(userId);
      this.logger.error(`daily-loss square-off for ${userId} failed; retried on the next check: ${errorText(err)}`);
    }
    return d;
  }
}
```

- [ ] **Step 5: Run them to see them pass**

Run: `npx jest src/modules/trade-core/lifecycle/core-square-off.spec.ts src/modules/trade-core/lifecycle/daily-loss.monitor.spec.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -- apps/api/src/modules/trade-core/lifecycle/core-square-off.ts apps/api/src/modules/trade-core/lifecycle/daily-loss.monitor.ts apps/api/src/modules/trade-core/lifecycle/core-square-off.spec.ts apps/api/src/modules/trade-core/lifecycle/daily-loss.monitor.spec.ts apps/api/src/common/audit/audit-actions.ts
git commit -m "feat(trade-core): core square-off exits positions; daily-loss monitor squares off on breach" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/api/src/modules/trade-core/lifecycle/core-square-off.ts apps/api/src/modules/trade-core/lifecycle/daily-loss.monitor.ts apps/api/src/modules/trade-core/lifecycle/core-square-off.spec.ts apps/api/src/modules/trade-core/lifecycle/daily-loss.monitor.spec.ts apps/api/src/common/audit/audit-actions.ts
```

---

## Stream E — wiring and proof

### Task 13: Positions API, module wiring, the ports rebound

**Files:**
- Create: `apps/api/src/modules/trade-core/lifecycle/dto/core-position.dto.ts`
- Create: `apps/api/src/modules/trade-core/lifecycle/controllers/core-positions.controller.ts`
- Test: `apps/api/src/modules/trade-core/lifecycle/controllers/core-positions.controller.spec.ts`
- Modify: `apps/api/src/modules/trade-core/trade-core.module.ts`, `apps/api/src/modules/trade-core/trade-core.module.spec.ts`
- Delete: `apps/api/src/modules/trade-core/execution/paper-risk-state.provider.ts`; Modify: `apps/api/src/modules/trade-core/execution/execution-ports.spec.ts` (drop its `RISK_STATE_PROVIDER (paper)` describe block and the import)

**Interfaces:**
- Consumes: everything above; `CurrentUser` (`common/decorators`); `isReason` (M2 `risk-wall/dto/core-risk.dto.ts`); `AuditService`; `AUDIT_ACTIONS.lifecycle` (Task 12).
- Produces: `GET /api/trade-core/positions` → `{ positions: CorePosition[] }`; `POST /api/trade-core/positions/:id/exit` `{ reason }` → `{ position }`; the module providers and exports below.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/modules/trade-core/lifecycle/controllers/core-positions.controller.spec.ts`:

```typescript
import { NotFoundException } from '@nestjs/common';
import { validate } from 'class-validator';
import type { AuditService } from '../../../../common/audit/audit.service';
import { AUDIT_ACTIONS } from '../../../../common/audit/audit-actions';
import type { CoreLifecycleService } from '../core-lifecycle.service';
import { ExitPositionDto } from '../dto/core-position.dto';
import { CorePositionsController } from './core-positions.controller';

function setup() {
  const lifecycle = {
    positionsFor: jest.fn().mockResolvedValue([{ id: 'pos_1' }]),
    requestExit: jest.fn().mockResolvedValue({ id: 'pos_1', status: 'EXITING' }),
  };
  const audit = { append: jest.fn().mockResolvedValue({ seq: 1n, hash: 'h' }) };
  const c = new CorePositionsController(lifecycle as unknown as CoreLifecycleService, audit as unknown as AuditService);
  return { lifecycle, audit, c };
}

describe('CorePositionsController (ruling L18)', () => {
  it("lists the caller's active positions and those closed in the last 7 days", async () => {
    const { lifecycle, c } = setup();
    const before = Date.now();
    expect(await c.list('user_A')).toEqual({ positions: [{ id: 'pos_1' }] });
    const [userId, since] = lifecycle.positionsFor.mock.calls[0] as [string, Date];
    expect(userId).toBe('user_A');
    expect(before - since.getTime()).toBeGreaterThanOrEqual(7 * 86_400_000 - 1000);
  });

  it("a manual exit is the caller's own, with the trimmed reason, and audited", async () => {
    const { lifecycle, audit, c } = setup();
    expect(await c.exit('user_A', 'pos_1', { reason: '  too risky  ' })).toEqual({ position: { id: 'pos_1', status: 'EXITING' } });
    expect(lifecycle.requestExit).toHaveBeenCalledWith('user_A', 'pos_1', 'MANUAL', 'too risky');
    expect(audit.append).toHaveBeenCalledWith({
      action: AUDIT_ACTIONS.lifecycle.CORE_POSITION_EXIT_REQUESTED,
      userId: 'user_A',
      target: 'core_positions:pos_1',
      meta: { reason: 'too risky', status: 'EXITING' },
    });
  });

  it('an audit failure never fails the exit', async () => {
    const { audit, c } = setup();
    audit.append.mockRejectedValueOnce(new Error('audit down'));
    await expect(c.exit('user_A', 'pos_1', { reason: 'too risky' })).resolves.toMatchObject({ position: { id: 'pos_1' } });
  });

  it("another user's position is the service's 404", async () => {
    const { lifecycle, c } = setup();
    lifecycle.requestExit.mockRejectedValueOnce(new NotFoundException('active core position pos_1 not found'));
    await expect(c.exit('user_B', 'pos_1', { reason: 'not mine' })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('the body must say why', async () => {
    expect(await validate(Object.assign(new ExitPositionDto(), { reason: '  ' }))).toHaveLength(1);
    expect(await validate(Object.assign(new ExitPositionDto(), { reason: 'thesis broken' }))).toHaveLength(0);
  });
});
```

In `apps/api/src/modules/trade-core/trade-core.module.spec.ts`:
- replace the imports of `PaperRiskStateProvider` with `CoreRiskStateProvider` (`./lifecycle/core-risk-state.provider`) and add imports of `CoreSquareOff`, `CoreLifecycleService`, `CorePositionRepository`, `DailyLossMonitor`, `CorePositionsController`, `CoreOrderEvents`, `LIFECYCLE_EVENT_SINK`, `LoggingLifecycleEventSink`, `LIFECYCLE_MARKS`, `CORE_POSITION_EXITS`;
- in `'resolves the M3 execution parts and rebinds the M2 ports to them'`, change the two port expectations to `expect(mod.get(RISK_STATE_PROVIDER)).toBeInstanceOf(CoreRiskStateProvider);` and `expect(mod.get(CORE_SQUARE_OFF)).toBeInstanceOf(CoreSquareOff);`;
- in `'one process, one matcher …'`, replace `const squareOff = mod.get<PaperOrderSquareOff>(CORE_SQUARE_OFF);` with `const squareOff = mod.get(PaperOrderSquareOff);`;
- add:

```typescript
  it('resolves the M4 lifecycle parts: one lifecycle behind both ports, one order-event stream', async () => {
    const mod = await compile();
    const lifecycle = mod.get(CoreLifecycleService);
    expect(lifecycle).toBeInstanceOf(CoreLifecycleService);
    expect(mod.get(LIFECYCLE_MARKS)).toBe(lifecycle);
    expect(mod.get(CORE_POSITION_EXITS)).toBe(lifecycle);
    expect(mod.get(LIFECYCLE_EVENT_SINK)).toBeInstanceOf(LoggingLifecycleEventSink);
    expect(mod.get(DailyLossMonitor)).toBeInstanceOf(DailyLossMonitor);
    expect(mod.get(CorePositionRepository)).toBeInstanceOf(CorePositionRepository);
    expect((mod.get(PaperLedgerService) as unknown as { events: unknown }).events).toBe(mod.get(CoreOrderEvents));
    expect(Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, TradeCoreModule)).toContain(CorePositionsController);
    expect(Reflect.getMetadata(MODULE_METADATA.EXPORTS, TradeCoreModule)).toEqual(expect.arrayContaining([CoreLifecycleService]));
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx jest src/modules/trade-core/lifecycle/controllers src/modules/trade-core/trade-core.module.spec.ts`
Expected: FAIL (controller missing; the module still binds the M3 ports).

- [ ] **Step 3: DTO and controller**

Create `apps/api/src/modules/trade-core/lifecycle/dto/core-position.dto.ts`:

```typescript
import { ValidateBy } from 'class-validator';
import { isReason } from '../../risk-wall/dto/core-risk.dto';

/** No userId: the global ValidationPipe({ whitelist: true }) strips it; the user comes from the token. */
export class ExitPositionDto {
  @ValidateBy({ name: 'isReason', validator: { validate: (v: unknown) => isReason(v), defaultMessage: () => '$property must say why, in 3 to 500 characters' } })
  reason!: string;
}
```

Create `apps/api/src/modules/trade-core/lifecycle/controllers/core-positions.controller.ts`:

```typescript
import { Body, Controller, Get, HttpCode, HttpStatus, Logger, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { AUDIT_ACTIONS } from '../../../../common/audit/audit-actions';
import { AuditService } from '../../../../common/audit/audit.service';
import { CurrentUser } from '../../../../common/decorators';
import { CoreLifecycleService } from '../core-lifecycle.service';
import { ExitPositionDto } from '../dto/core-position.dto';
import type { CorePosition } from '../lifecycle.types';

/** How far back closed positions are listed: a display window, not a risk value. */
const RECENT_CLOSED_MS = 7 * 86_400_000;

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * The caller's own core positions (ruling L18). Authenticated by the global JwtAuthGuard;
 * the user always comes from the token. A manual exit is never refused for rate (a safety
 * action, like the kill switch) and is audited; an audit failure never fails the exit.
 */
@ApiTags('Trade core: positions')
@Controller('api/trade-core/positions')
export class CorePositionsController {
  private readonly logger = new Logger(CorePositionsController.name);

  constructor(
    private readonly lifecycle: CoreLifecycleService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async list(@CurrentUser('userId') userId: string): Promise<{ positions: CorePosition[] }> {
    return { positions: await this.lifecycle.positionsFor(userId, new Date(Date.now() - RECENT_CLOSED_MS)) };
  }

  @Post(':id/exit')
  @HttpCode(HttpStatus.OK)
  @SkipThrottle()
  async exit(@CurrentUser('userId') userId: string, @Param('id') id: string, @Body() dto: ExitPositionDto): Promise<{ position: CorePosition }> {
    const reason = dto.reason.trim();
    const position = await this.lifecycle.requestExit(userId, id, 'MANUAL', reason);
    try {
      await this.audit.append({ action: AUDIT_ACTIONS.lifecycle.CORE_POSITION_EXIT_REQUESTED, userId, target: `core_positions:${id}`, meta: { reason, status: position.status } });
    } catch (err) {
      this.logger.error(`CORE_POSITION_EXIT_REQUESTED audit failed for ${id} (the exit was requested): ${errorText(err)}`);
    }
    return { position };
  }
}
```

- [ ] **Step 4: Wire the module**

In `apps/api/src/modules/trade-core/trade-core.module.ts`:
- remove the `PaperRiskStateProvider` import; add imports for `CoreLifecycleService`, `CorePositionRepository`, `CoreRiskStateProvider`, `CoreSquareOff`, `DailyLossMonitor`, `CorePositionsController`, `LIFECYCLE_EVENT_SINK`, `LoggingLifecycleEventSink`, `LIFECYCLE_MARKS`, `CORE_POSITION_EXITS`;
- `controllers`: append `CorePositionsController`;
- `providers`: add `PaperOrderSquareOff` (as a plain class), `CorePositionRepository`, `CoreLifecycleService`, `CoreSquareOff`, `DailyLossMonitor`, `{ provide: LIFECYCLE_EVENT_SINK, useClass: LoggingLifecycleEventSink }`, `{ provide: LIFECYCLE_MARKS, useExisting: CoreLifecycleService }`, `{ provide: CORE_POSITION_EXITS, useExisting: CoreLifecycleService }`; change `{ provide: RISK_STATE_PROVIDER, useClass: PaperRiskStateProvider }` to `{ provide: RISK_STATE_PROVIDER, useClass: CoreRiskStateProvider }` and `{ provide: CORE_SQUARE_OFF, useClass: PaperOrderSquareOff }` to `{ provide: CORE_SQUARE_OFF, useExisting: CoreSquareOff }`;
- `exports`: append `CoreLifecycleService`;
- the class comment gains: "M4: `lifecycle/` (core positions, exits by rule and priority, blind detection, crash recovery). M4 rebinds RISK_STATE_PROVIDER to CoreRiskStateProvider (marks, open and per-strategy P&L) and CORE_SQUARE_OFF to CoreSquareOff (entry orders cancelled, every position exited; the lifecycle is reached lazily through CORE_POSITION_EXITS). DailyLossMonitor runs every 5 s. Nothing opens a position before M5."

Delete `apps/api/src/modules/trade-core/execution/paper-risk-state.provider.ts` and remove, from `execution-ports.spec.ts`, its import and the whole `describe('RISK_STATE_PROVIDER (paper)', …)` block (the provider it tests no longer exists; Task 11 covers the replacement). In that file's `setup()`, drop `provider: new PaperRiskStateProvider(ledger),`.

- [ ] **Step 5: Run the trade-core suites**

Run: `npx jest src/modules/trade-core`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git rm -q -- apps/api/src/modules/trade-core/execution/paper-risk-state.provider.ts
git add -- apps/api/src/modules/trade-core/lifecycle/dto/core-position.dto.ts apps/api/src/modules/trade-core/lifecycle/controllers/core-positions.controller.ts apps/api/src/modules/trade-core/lifecycle/controllers/core-positions.controller.spec.ts apps/api/src/modules/trade-core/trade-core.module.ts apps/api/src/modules/trade-core/trade-core.module.spec.ts apps/api/src/modules/trade-core/execution/execution-ports.spec.ts
git commit -m "feat(trade-core): positions API and lifecycle wiring; risk state and square-off ports rebound to positions" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/api/src/modules/trade-core/lifecycle/dto/core-position.dto.ts apps/api/src/modules/trade-core/lifecycle/controllers/core-positions.controller.ts apps/api/src/modules/trade-core/lifecycle/controllers/core-positions.controller.spec.ts apps/api/src/modules/trade-core/trade-core.module.ts apps/api/src/modules/trade-core/trade-core.module.spec.ts apps/api/src/modules/trade-core/execution/execution-ports.spec.ts apps/api/src/modules/trade-core/execution/paper-risk-state.provider.ts
```

---

### Task 14: End to end — replay, kill switch, daily loss, tenants; then whole-suite verification

**Files:**
- Test: `apps/api/src/modules/trade-core/lifecycle/lifecycle-e2e.spec.ts`, `apps/api/src/modules/trade-core/lifecycle/lifecycle-tenant.spec.ts`
- Modify: `docs/superpowers/plans/2026-10-12-sp2-m4-lifecycle.md` (verification ledger)

**Interfaces:**
- Consumes: everything above. Produces: nothing new.

- [ ] **Step 1: The end-to-end spec**

Create `apps/api/src/modules/trade-core/lifecycle/lifecycle-e2e.spec.ts`:

```typescript
import type { ModuleRef } from '@nestjs/core';
import type { CoreKillSwitch } from '@prisma/client';
import type { AuditService } from '../../../common/audit/audit.service';
import { PaperOrderSquareOff } from '../execution/paper-order-square-off';
import { createCoreSessionClock } from '../risk-wall/ports';
import type { CoreKillSwitchRepository, NewKillSwitchRow } from '../risk-wall/repositories/core-kill-switch.repository';
import { CoreKillSwitchService } from '../risk-wall/services/core-kill-switch.service';
import type { CoreRiskLimitService } from '../risk-wall/services/core-risk-limit.service';
import type { SiloSquareOffAdapter } from '../risk-wall/services/silo-square-off.adapter';
import { limitsFixture } from '../risk-wall/testing/risk-fixtures';
import { CoreRiskStateProvider } from './core-risk-state.provider';
import { CoreSquareOff } from './core-square-off';
import { DailyLossMonitor } from './daily-loss.monitor';
import { NOW } from './testing/lifecycle-fixtures';
import { lifecycleHarness, openRequest } from './testing/lifecycle-harness';

beforeEach(() => jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] }));
afterEach(() => jest.useRealTimers());

class MemoryKillRepo {
  rows: CoreKillSwitch[] = [];
  async listForUser(userId: string) {
    return this.rows.filter((r) => r.userId === userId);
  }
  async append(userId: string, row: NewKillSwitchRow, now: Date) {
    const r = { id: `ks_${this.rows.length + 1}`, userId, ...row, createdAt: now } as CoreKillSwitch;
    this.rows.push(r);
    return r;
  }
}

function seams(h: ReturnType<typeof lifecycleHarness>) {
  const moduleRef = { get: () => h.lifecycle } as unknown as ModuleRef;
  const squareOff = new CoreSquareOff(new PaperOrderSquareOff(h.ledger, h.matcher), moduleRef);
  const audit = { append: jest.fn().mockResolvedValue({ seq: 1n, hash: 'h' }) } as unknown as AuditService;
  return { squareOff, audit, provider: new CoreRiskStateProvider(h.ledger, h.positions.repo, h.lifecycle) };
}

const INFY = { exchange: 'NSE', token: '1594', symbol: 'INFY-EQ', lotSize: 1, underlying: null };

describe('M4 end to end (spec §10)', () => {
  it('replay: an Adaptive-shaped trade from entry to a closed position whose ledger reconciles', async () => {
    const h = lifecycleHarness();
    const p = await h.lifecycle.openPosition(openRequest({ atr: 5 }, { strategyId: 'cs_adaptive', strategyVersionId: 'csv_adaptive_v1', stopPrice: 494 }));
    for (const ltp of [500, 505, 505, 508, 502.5, 502.5]) await h.price(ltp);
    expect(h.positions.rows[0]).toMatchObject({ status: 'CLOSED', exitReason: 'TRAIL', entryFilledQty: 100, exitFilledQty: 100, highWater: 508 });
    const funds = await h.ledger.funds('user_A');
    expect(funds.realisedPnl).toBe('375.00'); // 50 × +5.00 + 50 × +2.50
    expect(funds.blockedMargin).toBe('0.00');
    const net = (await h.ledger.netPnlTodayByPosition('user_A', new Date()))?.get(p.id)?.toFixed(2);
    expect(net).toBe((375 - Number(funds.charges)).toFixed(2));
    expect(h.sink.types(p.id).filter((t) => t === 'EXIT_DECIDED')).toHaveLength(2);
  });

  it('kill switch ON: the cascade cancels pending entries and exits every core position, then runs the silos', async () => {
    const h = lifecycleHarness();
    const { squareOff, audit } = seams(h);
    const filled = await h.lifecycle.openPosition(openRequest());
    await h.price(500);
    const pending = await h.lifecycle.openPosition(openRequest({ instrument: INFY }, { intentId: 'int_2', symbol: 'INFY-EQ', underlying: 'INFY' }));
    const silos = { squareOffAll: jest.fn().mockResolvedValue([{ target: 'auto-execution', status: 'OK', detail: 'set' }]) };
    const kill = new CoreKillSwitchService(new MemoryKillRepo() as unknown as CoreKillSwitchRepository, audit, createCoreSessionClock(), squareOff, silos as unknown as SiloSquareOffAdapter);
    const r = await kill.set({ userId: 'user_A', role: 'ADMIN' }, { active: true, reason: 'stop everything' }, new Date());
    await h.settle();
    expect(r.cascade?.core.status).toBe('OK');
    expect(r.cascade?.core.detail).toMatch(/^1 pending core entry order\(s\) cancelled; \d core position exit\(s\) requested/);
    expect(silos.squareOffAll).toHaveBeenCalledTimes(1);
    expect(h.positions.rows.find((x) => x.id === pending.id)).toMatchObject({ status: 'CANCELLED' });
    expect(h.positions.rows.find((x) => x.id === filled.id)).toMatchObject({ status: 'EXITING', exitReason: 'KILL_SWITCH' });
    await h.price(499);
    expect(h.positions.rows.find((x) => x.id === filled.id)).toMatchObject({ status: 'CLOSED', exitReason: 'KILL_SWITCH' });
  });

  it('daily loss: with BLOCK_AND_SQUARE_OFF a breach on marked P&L exits the user through the real provider', async () => {
    const h = lifecycleHarness();
    const { squareOff, audit, provider } = seams(h);
    const limits = { inForce: async () => limitsFixture({ 'maxDailyLoss@ALL': '500.00', 'dailyLossAction@ALL': 'BLOCK_AND_SQUARE_OFF' }) } as unknown as CoreRiskLimitService;
    const monitor = new DailyLossMonitor(h.positions.repo, provider, limits, squareOff, audit);
    const p = await h.lifecycle.openPosition(openRequest());
    await h.price(500);
    await h.price(494); // −600 gross, above the 492.5 stop
    await monitor.runOnce(new Date());
    await h.settle();
    expect(h.positions.rows.find((x) => x.id === p.id)).toMatchObject({ status: 'EXITING', exitReason: 'DAILY_LOSS' });
  });
});
```

Create `apps/api/src/modules/trade-core/lifecycle/lifecycle-tenant.spec.ts`:

```typescript
import { NotFoundException } from '@nestjs/common';
import { CoreRiskStateProvider } from './core-risk-state.provider';
import { NOW } from './testing/lifecycle-fixtures';
import { lifecycleHarness, openRequest } from './testing/lifecycle-harness';

beforeEach(() => jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] }));
afterEach(() => jest.useRealTimers());

describe("tenant isolation (spec §10: user A's alerts, limits, kill switch and positions never affect user B)", () => {
  it("A's stop, A's exit-all and A's kill switch never touch B's position on the same instrument", async () => {
    const h = lifecycleHarness();
    const a = await h.lifecycle.openPosition(openRequest());
    const b = await h.lifecycle.openPosition(openRequest({}, { intentId: 'int_b', userId: 'user_B', stopPrice: 480 }));
    await h.price(500);
    await h.lifecycle.exitAll('user_A', 'KILL_SWITCH', 'A only');
    h.killOn.add('user_A');
    await h.sweep();
    await h.price(499);
    expect(h.positions.rows.find((x) => x.id === a.id)).toMatchObject({ status: 'CLOSED' });
    expect(h.positions.rows.find((x) => x.id === b.id)).toMatchObject({ status: 'OPEN', exitReason: null });
    expect(h.ordersOf(b.id).map((o) => o.purpose)).toEqual(['ENTRY']);
    const provider = new CoreRiskStateProvider(h.ledger, h.positions.repo, h.lifecycle);
    expect((await provider.liveState('user_B', new Date())).openPositions.map((x) => x.positionId)).toEqual([b.id]);
    expect((await h.lifecycle.positionsFor('user_B', null)).map((x) => x.id)).toEqual([b.id]);
    await expect(h.lifecycle.requestExit('user_B', a.id, 'MANUAL', 'not mine')).rejects.toBeInstanceOf(NotFoundException);
    await expect(h.lifecycle.proposeStop('user_A', b.id, 499, 'x')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('a user the hub does not serve: the entry never fills and the position is CANCELLED; the served user fills (drift D7)', async () => {
    const h = lifecycleHarness({ served: ['user_A'] });
    const a = await h.lifecycle.openPosition(openRequest());
    const b = await h.lifecycle.openPosition(openRequest({}, { intentId: 'int_b', userId: 'user_B' }));
    await h.price(500);
    h.advance(30_001);
    await h.sweep();
    expect(h.positions.rows.find((x) => x.id === a.id)?.status).toBe('OPEN');
    expect(h.positions.rows.find((x) => x.id === b.id)?.status).toBe('CANCELLED');
  });
});
```

Run: `npx jest src/modules/trade-core/lifecycle/lifecycle-e2e.spec.ts src/modules/trade-core/lifecycle/lifecycle-tenant.spec.ts`
Expected: PASS. A failure here is a real gap in Tasks 8–13: fix the code, not the test. (Replay arithmetic: the partial sells 50 at 505 → +250.00; the trail sells 50 at 502.50 → +125.00.)

- [ ] **Step 2: Commit the end-to-end specs**

```bash
git add -- apps/api/src/modules/trade-core/lifecycle/lifecycle-e2e.spec.ts apps/api/src/modules/trade-core/lifecycle/lifecycle-tenant.spec.ts
git commit -m "test(trade-core): lifecycle replay, kill switch and daily-loss cascades, tenant isolation end to end" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/api/src/modules/trade-core/lifecycle/lifecycle-e2e.spec.ts apps/api/src/modules/trade-core/lifecycle/lifecycle-tenant.spec.ts
```

- [ ] **Step 3: Whole API suite**

Run (from `apps/api`): `npx jest 2>&1 | tail -15` (bash) or `npx jest 2>&1 | Select-Object -Last 15` (PowerShell).
Expected: every suite passes. M4 adds 16 API suites (`position-state`, `exit-plan`, `stop-rules`, `exit-decision`, `lifecycle-defaults`, `paper-ledger.events`, `memory-position-store`, `core-lifecycle.open`, `core-lifecycle.exits`, `core-lifecycle.recovery`, `core-risk-state.provider`, `core-square-off`, `daily-loss.monitor`, `core-positions.controller`, `lifecycle-e2e`, `lifecycle-tenant`); `paper-settings`, `execution-ports` and `trade-core.module` specs change. Record the totals. Known pre-existing flakes: `adaptive-stop-watch.service.spec.ts:168` (00:00–00:45 IST) and the Windows path case in `sentinel-cycle.service.spec.ts`: rerun alone and note.

- [ ] **Step 4: Isolation, schedule and literals**

Run: `git diff main --name-only -- apps/api/src ':!apps/api/src/modules/trade-core'`
Expected exactly: `apps/api/src/common/audit/audit-actions.ts`, `apps/api/src/common/tenant/tenant.constants.ts`.

Run: `git diff main --name-only -- apps/web packages apps/api/test ':!apps/api/test/sp2-m4'`
Expected: empty.

Run: `git diff main --name-only -- prisma`
Expected exactly: `prisma/migrations/20261012120000_sp2_m4_lifecycle/migration.sql`, `prisma/schema.prisma`.

Run: `git diff main -- apps/api/src/common/schedule/cron-timezone.spec.ts`
Expected: empty.

PowerShell, from the repo root:

```powershell
Get-ChildItem -Recurse apps/api/src/modules/trade-core -Filter *.ts | Where-Object { $_.Name -notlike '*.spec.ts' } | Select-String -Pattern '@Cron\(|@Interval\(' | ForEach-Object { "$($_.Path):$($_.LineNumber)" }
```

Expected: exactly one line, `…\trade-core\execution\mtf-interest.cron.ts:<n>` (M4 adds no cron; its timers are `setInterval` behind `bootJobsEnabled()`).

```powershell
Get-ChildItem -Recurse apps/api/src/modules/trade-core -Filter *.ts | Select-String -Pattern 'LIVE_TRADING_ENABLED|@td/shared'
```

Expected: no output.

```powershell
Get-ChildItem -Recurse apps/api/src/modules/trade-core/lifecycle -Filter *.ts | Where-Object { $_.Name -notlike '*.spec.ts' -and $_.FullName -notlike '*\testing\*' } | Select-String -Pattern "\b30_?000\b|'1[45]:[0-5]\d'|\b(5000|2500|800)\b"
```

Expected: no output (D4: blindAfterMs, square-off times and loss limits are data).

- [ ] **Step 5: Typecheck (compare lists, not counts)**

Never check `main` out over the branch. From the repo root, in PowerShell:

```powershell
$base = Join-Path $env:TEMP 'grw-m4-base'
git worktree add $base main
Push-Location apps/api; npx tsc --noEmit -p tsconfig.json 2>&1 | Select-String 'error TS' | ForEach-Object { $_.Line } | Sort-Object | Set-Content -Encoding utf8 (Join-Path $env:TEMP 'tsc-m4.txt'); Pop-Location
Push-Location $base; pnpm install --frozen-lockfile | Out-Null; Push-Location apps/api; npx prisma generate --schema ../../prisma/schema.prisma | Out-Null; npx tsc --noEmit -p tsconfig.json 2>&1 | Select-String 'error TS' | ForEach-Object { $_.Line } | Sort-Object | Set-Content -Encoding utf8 (Join-Path $env:TEMP 'tsc-main-m4.txt'); Pop-Location; Pop-Location
Compare-Object (Get-Content (Join-Path $env:TEMP 'tsc-main-m4.txt')) (Get-Content (Join-Path $env:TEMP 'tsc-m4.txt'))
git worktree remove --force $base
```

Expected: `Compare-Object` prints nothing. No line may name a `trade-core`, `audit-actions` or `tenant.constants` file. (The shared Prisma client must be regenerated with the M4 schema before the branch's `tsc`; the worktree's `node_modules` are junctions into the main checkout, so coordinate that window with any other running stream.)

- [ ] **Step 6: Record and commit**

Fill in the verification ledger row (date, suite totals, typecheck, the Task 5/7 opt-in DB run and drift), then:

```bash
git add -- docs/superpowers/plans/2026-10-12-sp2-m4-lifecycle.md
git commit -m "docs(plans): SP2 M4 verification results" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- docs/superpowers/plans/2026-10-12-sp2-m4-lifecycle.md
```

---

## M4 production gate (after deploy, owner-run)

Production is the Vyom VPS (Postgres in `grw-postgres`, API in `grw-api`). `grw-deploy.timer` runs
`prisma migrate deploy`, which applies `20261012120000_sp2_m4_lifecycle` (expand-only: one table, one nullable
column on the empty `core_orders`, two widened CHECKs, one seed row). No env var is added. Nothing opens a
position: no production code calls `openPosition` before M5.

**Database:**

```bash
docker exec -i grw-postgres psql -U grw -d grw <<'SQL'
SELECT count(*) FROM core_positions;                         -- want 0 (ships dark)
SELECT "numValue"::text, "note" FROM core_paper_defaults WHERE "key" = 'blindAfterMs';  -- want 30000, "default — please review…"
SELECT count(*) FROM core_paper_defaults;                    -- want 15 (14 from M3 + 1)
SELECT conname FROM pg_constraint WHERE conname LIKE 'core_positions_%_check' ORDER BY 1;  -- want shape + vocab
SQL
```

**API (owner token):** `GET /api/trade-core/positions` answers `{ "positions": [] }`; `POST
/api/trade-core/positions/nope/exit` with `{ "reason": "gate check" }` answers 404.

**Logs:** `docker logs grw-api 2>&1 | grep 'lifecycle: recovered'` shows `lifecycle: recovered 0 active core
position(s)` once after boot; no `lifecycle sweep failed` and no `daily-loss check failed` lines.

**Kill switch:** pressing it (then releasing at the next open as usual) shows the core step as `0 pending core entry
order(s) cancelled; 0 core position exit(s) requested (cancelled 0 orders, requested 0 exits)`.

**Load:** `/healthz/detail → hub.slots` unchanged (no positions, no watches); API RSS within a few MB of the day before.

**Revert path:** revert the code commits. The table, column, CHECKs and the seed row stay (expand-only; inert with
no code reading them; the reverted M3 vocabulary ignores the unknown `blindAfterMs` row).

M4 is complete when this gate is observed in production, not when the tests pass (parent spec rule).

## Deviations from the spec

1. **`core_orders.positionId`** and two new `ExecutionAdapter` methods (`onOrderUpdate`, `listPositionOrders`) —
   spec §6.1 has neither (D2); the lifecycle needs both to follow its orders.
2. **Exits are MARKET orders decided by the lifecycle**, not resting SL/target orders (O8, L1).
3. **`PaperOrderSquareOff` cancels entry orders only** (D4); positions are exited by the lifecycle.
4. **Journal rows go to a port with a logging binding** until M5's `core_journal` (O6, L12; D14).
5. **The daily-loss latch stays with M5**; M4 acts on `squareOffCore` from a 5 s monitor (L15; D6).
6. **Options rules act on the premium** with the stop the tighter of `stop` and `premiumStopPct` (O3, L6).
7. **Open positions follow a tightened `squareOffTime` / `mtfMaxHoldDays`** (O4, L7): spec §7.1 says the exit rules
   are frozen; the risk limits are the wall's and D5's "tighten now" reaches open positions.
8. **`blindAfterMs` lives in `core_paper_defaults` as an optional pair** (L10) rather than a lifecycle table.
9. **`openPosition` refuses a non-`PAPER` version** and requires `intent.symbol === instrument.symbol` (L19, D12).
10. **"Isolation: no file outside `trade-core/` changes except wiring"** is read, as in M2/M3, to include
    `schema.prisma`, the migration, `tenant.constants.ts` and `audit-actions.ts`; Task 14 Step 4 lists them exactly.

## Notes for later milestones (not in this plan)

- **M5 builds the entry:** Chartink fan-out → filters → `CoreEntryIntent` (with `stopPrice` from `resolveStopPct`,
  ATR measured from the candle store, mind the 350 ms historical lane) → `RiskWallService.check` → for ALLOW/RESIZE,
  `CoreLifecycleService.openPosition({ intent, qty: verdict.qty, instrument, atr, limits: verdict.limits, option })`
  behind its fan-out flag. The options strike/expiry picker (vehicle block) is M5's (D10).
- **M5 journal:** rebind `LIFECYCLE_EVENT_SINK` (and M2's `RISK_VERDICT_SINK`) to `core_journal`; derive
  `dailyLossLatched` from it; the closed-trade summary (`core_trade_summaries`) reads a CLOSED position's fills,
  `highWater`/`lowWater` (MFE/MAE), `initialStopPrice` (R) and `exitReason`; reconciliation adds "fills sum to the
  position quantity" over `core_orders.positionId`, and an alert for EXITING positions older than N minutes.
- **SP3 corpus:** the `DecisionPipeline` writes `ai_decision_records` with `source = 'core'`, `sourceId = intentId`;
  M5's summary writer fills `outcome`/`outcomeAt` on that row when the position closes (L13).
- **SP3 M6 guard rails:** the sentinel calls `proposeStop` / `requestExit` with `GUARD_RAIL`; never the adapter.
- **Health:** M5 adds lifecycle counts (active, blind, exiting > N min) to `/healthz/detail` (outside `trade-core/`).
- **Multi-tenant hub:** when `hubFor` serves other users, nothing in M4 changes (D7).
- **SP7:** a live adapter implements `onOrderUpdate` from broker order updates and `listPositionOrders` from
  `core_orders`; the broker-side disaster stop is placed on the entry fill.

## Self-review

- **Spec coverage (§7, §11 M4 row):** §7.1 state machine and frozen exit rules (Tasks 1, 2, 5, 7, 8); §7.2 price
  pushes at P0 with owner `core:<id>` (Tasks 8, 9), the 1 s sweep for clock rules (Task 9), feed stall via the hub's
  QuotePoller (unchanged; the sweep reads `hub.price`), blind positions journaled and alerted, square-off at market
  anyway (Task 9); §7.3 exit priority (Task 4; kill switch Task 9/10, daily loss Task 12); §7.4 `tightenStop`, "hold
  never ignores a stop" (only `decideExit` decides, Task 4), target→trail guard (Task 3); §7.5 options premium,
  underlying, theta and expiry rules (Task 4), MTF overnight, gap rule, hold limit (Tasks 4, 10), partial then trail
  (Tasks 3, 9); §7.6 recovery: reload, re-watch, resume exits with the same keys, RECOVERY_STOP (Task 10); §5.3/§5.4
  via the ports (Tasks 11, 12); §9 fail closed, idempotent across restarts (Tasks 8–10); §10 pure tests (Tasks 1–4),
  restart test (Task 10), tenant test (Task 14), replay (Task 14); M2/M3 notes for M4 (Tasks 6, 11, 12).
- **Placeholder scan:** every code step carries its code; every test step names its command and expected result.
  The Task 8 `onPrice` stub is explicit and replaced in Task 9.
- **Type consistency:** `CorePosition`, `CorePositionStatus`, `ExitPlan`, `OptionPlan`, `NewPositionRow`,
  `PositionPatch`, `ExitReason`, `LifecycleEvent`, `CoreOpenRequest`, `LifecycleMark`, `ExitInputs`, `ExitDecision`,
  `MarkInput`, `Marks`, `ArmedLevels`, `PlanInput`, `OptionOpen`, `LifecycleMarks`, `CorePositionExits` are named the
  same in every task; `reducePosition(current, orders)`, `buildExitPlan(input)`, `armLevels(plan, avg, qty, lot)`,
  `tightenStop(current, proposed, side)`, `advanceMarks(m, ltp)`, `decideExit(i)`, `exitAll(userId, cause, reason)`,
  `proposeStop(userId, id, price, source)`, `requestExit(userId, id, reason, note)`, `listPositionOrders(userId,
  positionId)`, `netPnlTodayByPosition(userId, now)`, `createIfNoActive(row)`, `update(userId, id, version, patch)`
  match between producers and consumers.
- **Review Focus tests are in their owning tasks:** 1 → Task 9; 2 → Task 10; 3 → Task 10; 4 → Tasks 4 and 10; 5 → Task 9.

## Verification ledger

| Date | Whole suite (API) | Typecheck (error lists) | Opt-in DB test + drift | Notes |
|---|---|---|---|---|
| 2026-10-12 (Stream E, `feature/sp2-m4-lifecycle` after Task 14, Windows) | `npx jest --ci`: **343 suites / 4297 tests, all pass** (trade-core alone: 61 suites / 642 tests). The known Windows-only `SentinelCycleService — shadow mode is structural` failure did **not** occur (it also passes on `main` `dd8c956`); no `adaptive-stop-watch` flake. | `apps/api` `npx tsc --noEmit -p tsconfig.json`, error lines with positions stripped and sorted: **identical** to `main` `dd8c956` (174 = 174, empty diff); none names a `trade-core`, `audit-actions` or `tenant.constants` file. Baseline from a temporary detached `main` worktree with `node_modules` junctions to the main checkout (no install, no `prisma generate`; the shared client already has `core_positions`), removed afterwards. | **Not run in Stream E** (`apps/api/test/sp2-m4` needs a database with the M4 migration; none was provisioned for this stream). Run before the production gate. Step 4 drift checks: outside `trade-core/` only `audit-actions.ts` and `tenant.constants.ts` change; `prisma` only `schema.prisma` + `20261012120000_sp2_m4_lifecycle`; `apps/web`, `packages`, `apps/api/test` (except `sp2-m4`) and `cron-timezone.spec.ts` unchanged; the only `@Cron` in trade-core is `mtf-interest.cron.ts`; no D4 literals in `lifecycle/`; the only `openPosition` call site is its definition (ships dark). | Deviation: `execution/execution-tenant.spec.ts` also used the deleted `PaperRiskStateProvider` (the plan named only `execution-ports.spec.ts`); its one risk-state case was removed. `CoreRiskStateProvider` "reports only the caller's positions" and `lifecycle-tenant.spec.ts` cover it. The Step 4 `LIVE_TRADING_ENABLED` grep hits `risk-wall/silo-entry-recheck.spec.ts`, which comes unchanged from `main` (52d4933) and is outside M4. |
