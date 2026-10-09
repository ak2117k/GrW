# SP2 · M1 — Strategy Catalogue, Versions, Selections, Dropdown and Seeds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Scope:** milestone **M1 only** of SP2: the strategy catalogue (`core_strategies`), immutable versions
(`core_strategy_versions`), per-user selections (`core_strategy_selections`), the building-block schemas
with a pure validator, seed rows for **Adaptive-Stop v1** and **Ungated v1**, tenant-scoped REST endpoints
with audit, and a web strategy picker. Out of scope: `core_strategy_docs` and `core_strategy_gaps` (M6),
the Risk Wall (M2), execution (M3), the lifecycle (M4), the Chartink fan-out that will read selections
(M5). Nothing in M1 places, simulates or evaluates a trade. The old silos and the old settings path are
not touched.

**Goal:** The owner opens **Core Strategies**, sees Adaptive-Stop and Ungated with their v1 blocks
(seeded from the silo code), approves each v1 into `PAPER`, and selects/enables a version with a capital
allocation. Every approval and selection change is audited, an approved version can never change (an edit
creates n+1), `LIVE` is refused, and one user's selections are invisible to every other user.

**Architecture:** A new NestJS module `apps/api/src/modules/trade-core/` with one part, `strategies/`
(controllers, services, repositories, dto, plus `blocks/` for the pure schema code). The block
vocabulary is a set of TypeScript discriminated unions with one pure function,
`validateBlocks(raw, { allowedVehicles }) → BlockError[]`, used on every save and again on approval (and
by M6 to check an AI draft). Status rules are one pure function, `checkTransition(from, to)`. Two thin
repositories wrap Prisma; two services hold the rules (catalogue: list, draft, edit-or-n+1, approve,
status; selection: get/set per user) and write `AuditService` entries. The catalogue is global
(owner-curated); selections are per user. The seed rows live in the migration SQL as data
(`INSERT … ON CONFLICT DO NOTHING`), and a spec parses that SQL to prove the seeds validate and match the
silo code. A database trigger makes approved versions immutable. The web page is a TanStack Query
consumer over two pure modules (`coreStrategies.ts` wire client, `core-strategy-picker.ts` logic).

**Tech Stack:** NestJS 11, TypeScript 5.7, Prisma 6 (PostgreSQL), class-validator, Jest 29 (`ts-jest`,
`isolatedModules`) for the API; React 19 + Vite 6 + Vitest 2 (node environment, no DOM renderer) +
TanStack Query 5 for the web app; pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-10-09-sp2-core-trade-lifecycle-design.md` (§2 D1–D4, §3 module
layout, naming and tenant scoping, §4.1 building blocks, §4.2 tables, §4.3 dropdown, §9, §10, §11 M1
row). Parent: `docs/superpowers/specs/2026-09-30-ai-trading-core-architecture-design.md` §6.2
(StrategyVersion immutable; budget and mode are **owner only**; the AI changes parameters, never code).

**Branch:** `feature/sp2-m1-strategy-catalogue`, from `main` (HEAD `321af45` when this plan was written).

**Test commands:**
- API: `pnpm --filter @td/api test -- <file-pattern>`. Jest `rootDir` is `apps/api/src`, `testRegex` is
  `.*\.spec\.ts$`. Example: `pnpm --filter @td/api test -- validate-blocks`.
- Web: `pnpm --filter @td/web test -- <file-pattern>` (`vitest run <filter>`, node environment).
  Example: `pnpm --filter @td/web test -- core-strategy-picker`.
- Opt-in database test (Task 3): `apps/api/test/sp2-m1/jest.config.js`, as M2's `test/sp1-m2`.

## Design decisions (planner rulings)

1. **The catalogue is global; selections are per user; "owner" means the `ADMIN` role.** Spec §3 says
   every `core_*` row carries `userId`, but §4.2 lists no `userId` on `core_strategies` or
   `core_strategy_versions`, and parent §6.2 gives mode and approval to the owner alone. M1 follows §4.2:
   strategies and versions are a platform catalogue the owner curates (`@AdminOnly()` on every write,
   and the service re-checks `role === 'ADMIN'` for any mode change); `core_strategy_selections` carries
   `userId`, is added to `TENANT_MODELS`, and every selection query filters by the caller's JWT
   `userId`. The owner confirmed this on 2026-10-09 (Owner answers, 2), and the spec's §3 now says so.
2. **Blocks are validated by one pure function, not nested class-validator DTOs.** Spec §4.1 says
   "class-validator DTOs". The blocks are discriminated unions (`kind` decides the fields), which
   class-validator expresses badly (`@ValidateNested` + `@Type` discriminators, and whitelisting would
   silently strip unknown fields instead of reporting them). `validateBlocks` is pure, reports every
   error with a path, rejects unknown fields (an AI draft cannot smuggle a rule in), and M6 reuses it for
   AI drafts. class-validator still guards each request envelope (`blocks` is an object, `notes` a
   string, `status` in the enum, `capitalAllocation` a finite number ≥ 0).
3. **Percent fields are percent of price** (`1.5` means 1.5 %). The silo code stores fractions in some
   places (`0.015`) and percents in others (`MIN_STOP_PCT = 0.8`); the seeds convert, and the seed spec
   checks each conversion against the code.
4. **Where the code needs more than the spec's block table, the code wins** (brief rule). The
   vocabulary grows by exactly what the two seeds need, nothing more:
   - `entry.chartink` gains `match: 'ANY' | 'EXACT' | 'CONTAINS'` (`scanName` is `null` for `ANY`) and
     `side: 'BUY' | 'SELL' | 'BOTH'`, because Ungated admits only scanners whose name **contains**
     "hull" (`ungated-scanner-filter.ts:13-16`, used at `ungated-watch.service.ts:105`), Adaptive-Stop
     takes any scan, and both are BUY-only (`adaptive-stop-watch.service.ts:168`,
     `ungated-watch.service.ts:110`). `entry.evaluator` gains `side` too.
   - `trail.atr` gains `minPct`, `maxPct` and `startsAfter: 'ENTRY' | 'PARTIAL'`: Adaptive-Stop's trail
     is `TRAIL_ATR_MULT × ATR`, clamped `TRAIL_MIN_PCT`–`TRAIL_MAX_PCT` of the high-water
     (`constants.ts:19-21`, `adaptive-stop-math.ts:28-38`), it starts only after the partial exit
     (`adaptive-stop-watch.service.ts:410-414`), and it reuses the ATR measured at entry
     (`adaptive-stop-watch.service.ts:480`, `entry.atrAtEntry`), so an ATR trail requires an ATR stop.
   - `partial.atTarget1` gains `atPct` (the target-1 level): Adaptive-Stop sells
     `PARTIAL_EXIT_FRACTION = 0.5` at `PARTIAL_EXIT_THRESHOLD_PCT = 0.01` (+1 %)
     (`adaptive-stop-watch.service.ts:330-331`, applied at `:473-477`).
   - `sizing` gains `notionalRupees { amount }`: Ungated sizes by notional,
     `qty = floor(TRADE_CAPITAL / price)` with `TRADE_CAPITAL = 2_00_000`
     (`ungated-paper-account.service.ts:7`, used at `ungated-watch.service.ts:212`), not by risk.
   - `vehicle.OPTIONS_BUY`'s "expiry: nearest with ≥ N days" is the field `minDaysToExpiry`.
   - **Silo entry rules become blocks (owner answer 3):** `entry.chartink.minScore` (gated admission,
     `null` = none) and a new required `filters` block with `staleEntry`, `cooldown`, `lastLoss` (each
     `null` = none) and `gates` (evaluator references; `[]` = none). Their meaning is pinned in
     `block-types.ts` so M4/M5 implement exactly what the silos do:
     - `minScore { base, windows[{ fromHhmm, toHhmm, score }] }`: the alert's existing Chartink score
       must reach `base`, or the window's `score` inside an IST window `[from, to)`. The trade policy is
       47 normally and 75 in 11:45–14:00 (`trade-policy.ts:7-8`, window `:29-32`, applied
       `chartink-process.service.ts:383-384`, Adaptive-Stop fed only inside that branch at `:429`).
     - `staleEntry { maxMovePct }`: skip when live price is already more than X % past the alert price in
       the trade direction (`moveFromAlert > 0.01`, `adaptive-stop-watch.service.ts:224-225`,
       `ungated-watch.service.ts:166-167`).
     - `cooldown { minutes }`: skip the same symbol for N minutes after this strategy last entered it
       (`TRADE_COOLDOWN_MS = 45 * 60_000`, `adaptive-stop-watch.service.ts:90`, `:179-182`;
       `ungated-watch.service.ts:84`, `:121-124`).
     - `lastLoss { window: 'SAME_IST_DAY' }`: skip when this strategy's last closed trade on the symbol
       today (IST) had P&L ≤ 0 (`adaptive-stop-watch.service.ts:187-191`, `ungated-watch.service.ts:129-133`).
     - `gates[]`: each `{ kind: 'evaluator', evaluatorKey, params }` must pass. Adaptive-Stop's decision gate
       is `adaptive-stop-decision-gate` with its real parameters (decision 5). M1 checks only the shape;
       M5 resolves the key to the existing `evaluateDecisionGate` (`adaptive-stop-decision-gate.ts:143`).
5. **Seed values (code wins over the spec's §4.1 summary):**

   | Seed | Block | Value | Source |
   |---|---|---|---|
   | Adaptive-Stop v1 | entry | chartink, any scan (`match: ANY`), BUY | `chartink-process.service.ts:429` (fed every admitted alert), `adaptive-stop-watch.service.ts:168` (BUY-only) |
   | | entry.minScore | base **47**; **75** in **11:45–14:00** IST | `trade-policy.ts:7` (`MIN_SCORE_NORMAL`), `:8` (`MIN_SCORE_STRICT`), `:29-32` (window); applied `chartink-process.service.ts:383-384` |
   | | filters.staleEntry | `maxMovePct` **1** | `adaptive-stop-watch.service.ts:224-225` (`moveFromAlert > 0.01`) |
   | | filters.cooldown | **45** minutes | `adaptive-stop-watch.service.ts:90` (`TRADE_COOLDOWN_MS = 45 * 60_000`), applied `:179-182` |
   | | filters.lastLoss | `SAME_IST_DAY` | `adaptive-stop-watch.service.ts:187-191` (`lastPnl !== null && lastPnl <= 0` since IST midnight) |
   | | filters.gates | `adaptive-stop-decision-gate`: nearSupportPct **0.6**, rsiHot **70**, vwapExtPct **1.5**, requireMacdBullish **true**, srLookbackDays **5**, minCandles **10**, minSameDayCandles **3**, failOpen **true** | `constants.ts:28` (enabled), `:29-32`, `:37`; `adaptive-stop-decision-gate.ts:157` (10 / 3), `:150-153` (skips pass, so it fails open); applied `adaptive-stop-watch.service.ts:241-249` |
   | | stop | `atr` period **14**, timeframe **5m**, multiple **1.2**, clamp **0.8–2.5 %** | `adaptive-stop-watch.service.ts:111` (`'5m'`), `:117` (`14`); `constants.ts:9-11` (`ATR_MULT`, `MIN_STOP_PCT`, `MAX_STOP_PCT`); applied `:260-261` |
   | | target | `fixedPct` **2** | `constants.ts:6` (`PROFIT_TARGET_PCT = 0.02`), applied `adaptive-stop-watch.service.ts:233` |
   | | trail | `atr` multiple **1.0**, clamp **0.6–1.5 %**, starts after the partial | `constants.ts:19-21`; `adaptive-stop-watch.service.ts:410-414`, `:480` |
   | | timeExit | `clock` **15:15** IST | `adaptive-stop-tick-poller.service.ts:95` (`@Cron('0 15 15 * * 1-5')`) |
   | | partial | `atTarget1` fraction **0.5** at **+1 %** | `adaptive-stop-watch.service.ts:330-331` |
   | | sizing | `riskRupees` **800** | `constants.ts:8` (`RISK_PER_TRADE`), applied `adaptive-stop-math.ts:41-44` |
   | | vehicle | `CASH_INTRADAY` | `adaptive-stop-tick-poller.service.ts:89-90` ("every adaptive-stop position is INTRADAY") |
   | Ungated v1 | entry | chartink, scan name **contains "hull"**, BUY | `ungated-scanner-filter.ts:13-16`, `ungated-watch.service.ts:105`, `:110` |
   | | entry.minScore | `null` (every scored alert) | `chartink-process.service.ts:458` ("runs unconditionally for every scored alert") |
   | | filters | staleEntry **1**, cooldown **45** min, lastLoss `SAME_IST_DAY`, gates `[]` | `ungated-watch.service.ts:166-167`, `:84` + `:121-124`, `:129-133` |
   | | stop | `fixedPct` **1.5** | `ungated-watch.service.ts:85` (`HARD_STOP_PCT = 0.015`), applied `:285-308` |
   | | target | `fixedPct` **3** | `ungated-watch.service.ts:83` (`PROFIT_TARGET_PCT = 0.03`), applied `:175` |
   | | trail / partial | `none` / `none` (pure hold) | `ungated-watch.service.ts:80-82`, `:324-325` |
   | | timeExit | `clock` **15:25** IST | `ungated-tick-poller.service.ts:94` (`@Cron('0 25 15 * * 1-5')`) |
   | | sizing | `notionalRupees` **2,00,000** | `ungated-paper-account.service.ts:7`, `ungated-watch.service.ts:212` |
   | | vehicle | `CASH_INTRADAY` | `ungated-tick-poller.service.ts:89` (EOD square-off) |

   The spec's original summary omitted Adaptive-Stop's partial and trail, Ungated's ₹2,00,000 notional
   sizing and Hull-only entry, and every entry filter; the spec's §4.1 has been corrected to match the
   code. The seed spec (Task 3) reads the silo source and fails if any seeded number differs from the
   code at M1.
6. **What is not a block is recorded in each seed's `notes`, with file:line.** Dropped by the owner
   (2026-10-09) as artifacts of 30-second polling: the two-strike stop confirmation (both silos) and
   Adaptive-Stop's 2-minute stop grace (`constants.ts:12`). Left to the Risk Wall (M2): one open position
   per symbol and 40 concurrent positions. Not carried: `UNGATED_HULL_ONLY` (the version itself is
   Hull-only), the decision gate's fetch retries (evaluator plumbing), and Ungated's at-least-1-share
   floor. Also noted: the ATR source window (3 days of 5m candles, at least 21,
   `adaptive-stop-watch.service.ts:110-112`).
7. **Seeds are data in the migration** (spec §4.1 "a migration seed"): fixed ids, `INSERT … ON CONFLICT
   DO NOTHING`, between `-- SEED BEGIN` / `-- SEED END` markers, so re-running them (or restoring a dump
   that carries `_prisma_migrations`) changes nothing. Seeds are inserted as **`DRAFT`** so the owner
   approves each one in the UI (owner answer 1). `allowedVehicles` for both is `['CASH_INTRADAY']`, the
   only vehicle either silo trades.
8. **Immutability is enforced twice.** The service only ever updates a version through
   `updateMany({ where: { id, status: 'DRAFT' } })`, and a `BEFORE UPDATE OR DELETE` trigger refuses any
   change to `blocks`, `strategyId`, `version`, `createdBy`, `sourceDocId`, `notes`, `approvedBy` or
   `approvedAt` once a row has left `DRAFT`, refuses a return to `DRAFT`, and refuses deleting a
   non-draft (positions will reference versions from M4). CHECK constraints pin `status`, `createdBy`,
   `allowedVehicles` and `capitalAllocation ≥ 0`. Prisma's diff ignores triggers and CHECKs, so the drift
   check still passes.
9. **"An edit creates n+1" is literal.** `PATCH /strategy-versions/:id` on a `DRAFT` edits it in place;
   on any other status (or a draft approved mid-edit) it creates the next version as a new `DRAFT` with
   the merged blocks and returns `{ version, created: true }`. A new version always starts `DRAFT`; only
   approval makes it `PAPER`.
10. **Status rules (SP2):** `DRAFT → PAPER` (approve), `DRAFT → RETIRED`, `PAPER → RETIRED`. `LIVE` is
    refused from every status with "LIVE is reserved until SP7" (409). Nothing returns to `DRAFT`;
    nothing leaves `RETIRED`. Approval re-validates the stored blocks (409/422 before any write).
11. **Selection rules:** only a `PAPER` version can be selected; an enabled selection needs
    `capitalAllocation > 0` (an enabled strategy with ₹0 would be inert and silent); the one exception
    is switching **off** a selection that already points at a now-retired version. Retiring a version
    does not rewrite other users' selections; the picker flags a stale selection, and M5's fan-out must
    treat any selection whose version is not `PAPER` as disabled (Notes for later milestones).
    `capitalAllocation` is rupees, stored exactly as `DECIMAL(14,2)` (≥ 0, at most 2 dp, below 10^12;
    the API returns it as a JSON number with ≤ 2 dp, the audit log as the 2-dp string); capping it
    against funds is the Risk Wall's job (M2/M3).
12. **`createdBy` never comes from the request.** REST drafts are `OWNER`; the service takes `createdBy`
    as a parameter so M6's AI path passes `AI`. The request DTOs have no `createdBy`, `status` or
    `userId` field, so the global `ValidationPipe({ whitelist: true })` strips them.
13. **No `@td/shared` import in new API code**, so the API `tsc` gains no TS2307 errors (decision for the
    ~169 existing `@td/shared` moduleResolution errors). The web keeps its own wire types in
    `apps/web/src/services/coreStrategies.ts`.
14. **Audit after the write, strictly.** `AuditService.append` is strict and runs its own SERIALIZABLE
    transaction, so it cannot share the write's transaction. Each service writes, then appends; a failed
    append surfaces as a 500 with the change made (the same order every existing caller uses). New
    actions live in a new `strategy` group in `audit-actions.ts`.
15. **The page is ADMIN-only for M1** (`/core-strategies`, `RequireRole role="ADMIN"`, nav badge `SP2`),
    like every other trading page; the API already serves any authenticated user's own selections, so
    opening it to users later is a one-line route and nav change. Because seeds start as `DRAFT`, the page
    has an **Approve** button on draft versions (owner only); drafts are created and edited through the
    API in M1 (the doc → draft editor is M6).
16. **No cron in M1.** Nothing is scheduled; the cron ratchet is untouched.

## Global Constraints

- **Approach A (D1):** no old table or service changes. No edit under `modules/adaptive-stop-track/`,
  `modules/ungated-track/`, `modules/chartink/`, `modules/settings/` (`VALID_STRATEGY_NAMES` in
  `settings.service.ts` stays as it is), or any other silo. The seed spec only **reads** silo source.
- **`LIVE_TRADING_ENABLED` stays `false`** and is not read or written by M1; status `LIVE` is refused.
- **No hard-coded risk values (D4):** every trading number lives in a version's `blocks` or a user's
  selection. The only numeric literals in new code are shape bounds (a percent is in (0, 100), counts are
  whole numbers ≥ 1, a fraction is in (0, 1)), never limits.
- **Tenant scoping:** `core_strategy_selections` carries `userId`; every selection read and write filters
  by the caller's JWT `userId` (never a body or path value); `CoreStrategySelection` is in
  `TENANT_MODELS`. The catalogue tables are global (decision 1).
- **Owner only:** draft, edit, approve and status routes carry `@AdminOnly()`; the service re-checks
  `actor.role === 'ADMIN'` before any mode change. The AI can never approve.
- **Immutable once approved:** an approved version's blocks never change (service guard + DB trigger).
- **Naming:** `Core` prefix for models (`CoreStrategy`, `CoreStrategyVersion`, `CoreStrategySelection`),
  `core_*` tables, kebab-case routes under `/api/trade-core/`.
- **Crons:** none added. Any future cron pins `timeZone: 'Asia/Kolkata'`
  (`common/schedule/cron-timezone.spec.ts` ratchet).
- **Typecheck:** new API code adds **no** `tsc` error (the ~169 existing errors are the `@td/shared`
  moduleResolution class); the web `tsc --noEmit` stays clean.
- **Audit:** every approval, status change and selection change appends an `AuditService` entry with an
  `AUDIT_ACTIONS.strategy.*` action.
- **Web tests:** Vitest in a node environment with no DOM (as SP1 M4 decision 3); every decision the page
  makes is a pure function with a spec; no new test infrastructure.
- **Commits:** explicit pathspecs (`git commit -m … -- <paths>`), never a bare `git commit` or `-a`. Every
  message ends with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Review Focus

1. **One user's selection must never reach another user.** A `PUT` names only a strategy; the user is the
   token's. (Task 4 test "selection queries always carry the caller's userId, and an update can never
   move a row to another user"; Task 6 test "writes only the caller's own selection, whatever the input
   carries"; Task 7 tests "selection routes take the user from the token, never from the path or body"
   and "SetSelectionDto strips a smuggled userId".)
2. **An approved version must not change under a running position.** Edits after approval create n+1;
   a draft approved mid-edit is not overwritten; the database refuses the change even if a bug tries it.
   (Task 5 tests "editing a PAPER version creates version n+1 and never touches the original" and "a
   draft approved while it was being edited becomes n+1, not an overwrite"; Task 3 integration test
   "refuses to change or delete an approved version, and refuses a return to DRAFT".)
3. **Nobody but the owner, and nothing but paper.** LIVE is refused from every status; a non-ADMIN actor
   cannot approve even if the route guard were bypassed; `createdBy`/`status` cannot be set by the
   client. (Task 2 test "refuses LIVE from every status"; Task 5 tests "a non-ADMIN actor cannot approve
   or change status, and nothing is written" and "createDraft is OWNER unless the caller says AI";
   Task 7 tests "every catalogue write route is @AdminOnly; reads and selections are not" and
   "CreateDraftDto strips createdBy and status".)
4. **A selection that cannot trade must not look like one that can** (the silent-absence shape). Enabled
   with ₹0, enabling a draft or retired version, and a saved version that was later retired. (Task 6
   tests "enabling needs a capital allocation above 0", "only a PAPER version can be selected" and "a
   selection already on a retired version can be switched off"; Task 8 test "pickerRow flags a saved
   selection whose version is no longer selectable".)
5. **Malformed blocks (hand-typed or AI-drafted) are refused with a path, never stored.** Strings for
   numbers, NaN, unknown fields, missing blocks, min > max, inconsistent combinations, a vehicle the
   strategy does not allow; and the seeds themselves must pass. (Task 1 tests "rejects unknown top-level
   and in-block fields", "rejects strings, NaN, Infinity, zero, negatives and 100 % where a percent is
   needed", the cross-block tests and "refuses a vehicle the strategy does not allow"; Task 3 test "every
   seed passes validateBlocks for its strategy"; Task 5 test "approval re-validates stored blocks and
   writes nothing when they fail".)

---

## File Structure

| Path | Responsibility |
|---|---|
| Create `apps/api/src/modules/trade-core/strategies/blocks/block-types.ts` | Block unions, `StrategyBlocks`, `VEHICLES`, `CANDLE_TIMEFRAMES`, `BLOCK_NAMES`, `BlockError` |
| Create `apps/api/src/modules/trade-core/strategies/blocks/validate-blocks.ts` | `validateBlocks`, `formatBlockErrors` (pure) |
| Create `apps/api/src/modules/trade-core/strategies/testing/block-fixtures.ts` | `adaptiveBlocks()`, `plainBlocks()` test data |
| Create `apps/api/src/modules/trade-core/strategies/version-status.ts` | `VERSION_STATUSES`, `VERSION_CREATORS`, `checkTransition`, `isSelectable`, `isEditable`, `SELECTABLE_STATUSES` (pure) |
| Modify `prisma/schema.prisma` | `CoreStrategy`, `CoreStrategyVersion`, `CoreStrategySelection`; `User.coreStrategySelections` |
| Create `prisma/migrations/20261009120000_sp2_m1_strategy_catalogue/migration.sql` | Tables, indexes, FKs, CHECKs, immutability trigger, seeds |
| Create `apps/api/src/modules/trade-core/strategies/core-strategy-seeds.spec.ts` | Seeds validate and equal the silo code |
| Create `apps/api/test/sp2-m1/jest.config.js`, `apps/api/test/sp2-m1/core-strategy-catalogue.int.spec.ts` | Opt-in real-database test: seeds idempotent, trigger, CHECKs |
| Modify `apps/api/src/common/tenant/tenant.constants.ts` | `CoreStrategySelection` is a tenant model |
| Create `apps/api/src/modules/trade-core/strategies/repositories/core-strategy.repository.ts` | Catalogue data access |
| Create `apps/api/src/modules/trade-core/strategies/repositories/core-strategy-selection.repository.ts` | Per-user selection data access |
| Modify `apps/api/src/common/audit/audit-actions.ts` | `strategy` action group |
| Create `apps/api/src/modules/trade-core/strategies/dto/core-strategy.dto.ts` | Request DTOs, response shapes, row → DTO mappers |
| Create `apps/api/src/modules/trade-core/strategies/services/core-strategy-catalogue.service.ts` | list, createDraft, editVersion, approve, setStatus |
| Create `apps/api/src/modules/trade-core/strategies/services/core-strategy-selection.service.ts` | list, set (per user) |
| Create `apps/api/src/modules/trade-core/strategies/controllers/core-strategies.controller.ts` | `/api/trade-core/*` routes |
| Create `apps/api/src/modules/trade-core/trade-core.module.ts`; modify `apps/api/src/app.module.ts` | Module wiring |
| Create `apps/web/src/services/coreStrategies.ts` | Wire types and API calls |
| Create `apps/web/src/pages/core-strategies/core-strategy-picker.ts` | Pure picker logic: options, stale flag, capital parsing, payload, block descriptions, error text |
| Create `apps/web/src/pages/core-strategies/CoreStrategiesPage.tsx` | The page |
| Modify `apps/web/src/App.tsx`, `apps/web/src/components/layout/navItems.ts` | Route and nav entry |

---

### Task 1: Building-block types and the pure `validateBlocks`

**Files:**
- Create: `apps/api/src/modules/trade-core/strategies/blocks/block-types.ts`
- Create: `apps/api/src/modules/trade-core/strategies/blocks/validate-blocks.ts`
- Create: `apps/api/src/modules/trade-core/strategies/testing/block-fixtures.ts`
- Test: `apps/api/src/modules/trade-core/strategies/blocks/validate-blocks.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:

```typescript
// block-types.ts
export const VEHICLES: readonly ['CASH_INTRADAY', 'MTF', 'OPTIONS_BUY'];
export type Vehicle = (typeof VEHICLES)[number];
export const CANDLE_TIMEFRAMES: readonly ['1m', '3m', '5m', '10m', '15m', '30m', '1h', '1d'];
export type CandleTimeframe = (typeof CANDLE_TIMEFRAMES)[number];
export type EntrySide = 'BUY' | 'SELL' | 'BOTH';
export type EvaluatorParams = Record<string, number | string | boolean>;
export interface MinScore { base: number; windows: Array<{ fromHhmm: string; toHhmm: string; score: number }> }
export interface GateRef { kind: 'evaluator'; evaluatorKey: string; params: EvaluatorParams }
export interface FiltersBlock { staleEntry: { maxMovePct } | null; cooldown: { minutes } | null; lastLoss: { window: 'SAME_IST_DAY' } | null; gates: GateRef[] }
export type EntryBlock | StopBlock | TargetBlock | TrailBlock | TimeExitBlock | PartialBlock | SizingBlock | VehicleBlock;
export interface StrategyBlocks { entry; filters; stop; target; trail; timeExit; partial; sizing; vehicle }
export const BLOCK_NAMES: readonly (keyof StrategyBlocks)[];
export interface BlockError { path: string; message: string }

// validate-blocks.ts
export function validateBlocks(raw: unknown, opts?: { allowedVehicles?: readonly string[] }): BlockError[];
export function formatBlockErrors(errors: readonly BlockError[]): string;   // "path: message; path: message"

// testing/block-fixtures.ts
export function adaptiveBlocks(): StrategyBlocks;   // ATR stop + partial + ATR trail (test data)
export function plainBlocks(): StrategyBlocks;      // fixed stop/target, pure hold (test data)
```

- [ ] **Step 1: Write the fixtures and the failing tests**

Create `apps/api/src/modules/trade-core/strategies/testing/block-fixtures.ts`:

```typescript
import type { StrategyBlocks } from '../blocks/block-types';

/**
 * Test data only, not seeds. Seeds are rows in the M1 migration
 * (core-strategy-seeds.spec.ts checks them).
 */

/** Adaptive-Stop-shaped: score gate, all filters, ATR stop, a partial at +1 %, then an ATR trail. */
export function adaptiveBlocks(): StrategyBlocks {
  return {
    entry: {
      kind: 'chartink', scanName: null, match: 'ANY', side: 'BUY',
      minScore: { base: 47, windows: [{ fromHhmm: '11:45', toHhmm: '14:00', score: 75 }] },
    },
    filters: {
      staleEntry: { maxMovePct: 1 },
      cooldown: { minutes: 45 },
      lastLoss: { window: 'SAME_IST_DAY' },
      gates: [{ kind: 'evaluator', evaluatorKey: 'adaptive-stop-decision-gate', params: { nearSupportPct: 0.6, rsiHot: 70 } }],
    },
    stop: { kind: 'atr', period: 14, timeframe: '5m', multiple: 1.2, minPct: 0.8, maxPct: 2.5 },
    target: { kind: 'fixedPct', pct: 2 },
    trail: { kind: 'atr', multiple: 1, minPct: 0.6, maxPct: 1.5, startsAfter: 'PARTIAL' },
    timeExit: { kind: 'clock', hhmm: '15:15' },
    partial: { kind: 'atTarget1', fraction: 0.5, atPct: 1 },
    sizing: { kind: 'riskRupees', amount: 800 },
    vehicle: { kind: 'CASH_INTRADAY' },
  };
}

/** Ungated-shaped: no score gate, no gates, fixed stop and target, pure hold. */
export function plainBlocks(): StrategyBlocks {
  return {
    entry: { kind: 'chartink', scanName: 'hull', match: 'CONTAINS', side: 'BUY', minScore: null },
    filters: { staleEntry: { maxMovePct: 1 }, cooldown: { minutes: 45 }, lastLoss: { window: 'SAME_IST_DAY' }, gates: [] },
    stop: { kind: 'fixedPct', pct: 1.5 },
    target: { kind: 'fixedPct', pct: 3 },
    trail: { kind: 'none' },
    timeExit: { kind: 'clock', hhmm: '15:25' },
    partial: { kind: 'none' },
    sizing: { kind: 'notionalRupees', amount: 200000 },
    vehicle: { kind: 'CASH_INTRADAY' },
  };
}
```

Create `apps/api/src/modules/trade-core/strategies/blocks/validate-blocks.spec.ts`:

```typescript
import { formatBlockErrors, validateBlocks } from './validate-blocks';
import { adaptiveBlocks, plainBlocks } from '../testing/block-fixtures';

const paths = (raw: unknown, opts?: { allowedVehicles?: readonly string[] }) =>
  validateBlocks(raw, opts).map((e) => e.path);

describe('validateBlocks', () => {
  it('accepts both reference shapes', () => {
    expect(validateBlocks(adaptiveBlocks())).toEqual([]);
    expect(validateBlocks(plainBlocks())).toEqual([]);
  });

  it('rejects anything that is not an object', () => {
    for (const raw of [null, undefined, 'blocks', 42, []]) expect(paths(raw)).toEqual(['blocks']);
  });

  it('names every missing block', () => {
    const { stop: _s, sizing: _z, ...rest } = plainBlocks();
    expect(paths(rest)).toEqual(['stop', 'sizing']);
  });

  it('rejects unknown top-level and in-block fields (an AI draft cannot smuggle rules in)', () => {
    expect(paths({ ...plainBlocks(), leverage: 5 })).toEqual(['blocks.leverage']);
    expect(paths({ ...plainBlocks(), stop: { kind: 'fixedPct', pct: 1, graceMs: 120000 } })).toEqual(['stop.graceMs']);
  });

  it('rejects strings, NaN, Infinity, zero, negatives and 100 % where a percent is needed', () => {
    for (const bad of ['1.5', NaN, Infinity, 0, -1, 100, null]) {
      expect(paths({ ...plainBlocks(), stop: { kind: 'fixedPct', pct: bad } })).toEqual(['stop.pct']);
    }
  });

  it('rejects an unknown kind', () => {
    expect(paths({ ...plainBlocks(), target: { kind: 'trailing', pct: 2 } })).toEqual(['target.kind']);
  });

  it('needs whole numbers where a count is meant', () => {
    const a = adaptiveBlocks();
    expect(paths({ ...a, stop: { ...a.stop, period: 14.5 } })).toEqual(['stop.period']);
    const mtf = { ...plainBlocks(), vehicle: { kind: 'MTF' } };
    expect(paths({ ...mtf, timeExit: { kind: 'holdDays', n: 0 } })).toEqual(['timeExit.n']);
    expect(paths({ ...mtf, timeExit: { kind: 'holdDays', n: 2.5 } })).toEqual(['timeExit.n']);
    expect(paths({ ...mtf, timeExit: { kind: 'holdDays', n: 5 } })).toEqual([]);
  });

  it('rejects an ATR clamp whose minimum exceeds its maximum', () => {
    const a = adaptiveBlocks();
    expect(paths({ ...a, stop: { ...a.stop, minPct: 3 } })).toEqual(['stop.minPct']);
    expect(paths({ ...a, trail: { ...a.trail, minPct: 2 } })).toEqual(['trail.minPct']);
  });

  it('checks the HH:MM clock format', () => {
    for (const bad of ['9:15', '24:00', '15:60', '1515', 1515]) {
      expect(paths({ ...plainBlocks(), timeExit: { kind: 'clock', hhmm: bad } })).toEqual(['timeExit.hhmm']);
    }
  });

  it('chartink: ANY needs a null scanName; EXACT and CONTAINS need a name', () => {
    const e = { kind: 'chartink', minScore: null };
    expect(paths({ ...plainBlocks(), entry: { ...e, scanName: 'hull', match: 'ANY', side: 'BUY' } })).toEqual(['entry.scanName']);
    expect(paths({ ...plainBlocks(), entry: { ...e, scanName: null, match: 'EXACT', side: 'BUY' } })).toEqual(['entry.scanName']);
    expect(paths({ ...plainBlocks(), entry: { ...e, scanName: 'x', match: 'REGEX', side: 'BUY' } })).toEqual(['entry.match']);
    expect(paths({ ...plainBlocks(), entry: { ...e, scanName: 'x', match: 'EXACT' } })).toEqual(['entry.side']);
  });

  it('chartink minScore: required (null = no score gate); a base with well-formed IST windows', () => {
    const { minScore: _m, ...noScore } = adaptiveBlocks().entry as Record<string, unknown>;
    expect(paths({ ...adaptiveBlocks(), entry: noScore })).toEqual(['entry.minScore']);
    const withScore = (minScore: unknown) => ({ ...adaptiveBlocks(), entry: { ...adaptiveBlocks().entry, minScore } });
    expect(paths(withScore({ base: 47, windows: [] }))).toEqual([]);
    expect(paths(withScore({ base: -1, windows: [] }))).toEqual(['entry.minScore.base']);
    expect(paths(withScore({ base: 47 }))).toEqual(['entry.minScore.windows']);
    expect(paths(withScore({ base: 47, windows: [{ fromHhmm: '14:00', toHhmm: '11:45', score: 75 }] }))).toEqual(['entry.minScore.windows.0.toHhmm']);
    expect(paths(withScore({ base: 47, windows: [{ fromHhmm: '11:45', toHhmm: '14:00', score: '75' }] }))).toEqual(['entry.minScore.windows.0.score']);
  });

  it('filters must name every rule (null, or [] for gates, means none)', () => {
    expect(paths({ ...plainBlocks(), filters: {} })).toEqual(['filters.staleEntry', 'filters.cooldown', 'filters.lastLoss', 'filters.gates']);
    expect(paths({ ...plainBlocks(), filters: { staleEntry: null, cooldown: null, lastLoss: null, gates: [] } })).toEqual([]);
  });

  it('filters: each rule is well-formed; gates are evaluator references with scalar params', () => {
    const f = plainBlocks().filters;
    expect(paths({ ...plainBlocks(), filters: { ...f, staleEntry: { maxMovePct: 0 } } })).toEqual(['filters.staleEntry.maxMovePct']);
    expect(paths({ ...plainBlocks(), filters: { ...f, cooldown: { minutes: 44.5 } } })).toEqual(['filters.cooldown.minutes']);
    expect(paths({ ...plainBlocks(), filters: { ...f, lastLoss: { window: 'EVER' } } })).toEqual(['filters.lastLoss.window']);
    expect(paths({ ...plainBlocks(), filters: { ...f, gates: {} } })).toEqual(['filters.gates']);
    expect(paths({ ...plainBlocks(), filters: { ...f, gates: [{ kind: 'evaluator', evaluatorKey: 'Decision Gate', params: { x: [1] } }] } }))
      .toEqual(['filters.gates.0.evaluatorKey', 'filters.gates.0.params.x']);
    expect(paths({ ...plainBlocks(), filters: { ...f, gates: [{ kind: 'llm', evaluatorKey: 'judge', params: {} }] } })).toEqual(['filters.gates.0.kind']);
    expect(paths({ ...plainBlocks(), filters: { ...f, maxTradesPerDay: 3 } })).toEqual(['filters.maxTradesPerDay']);
  });

  it('evaluator: a kebab-case key and scalar params only', () => {
    const entry = { kind: 'evaluator', evaluatorKey: 'zone-reversal', params: { lookback: 20, mode: 'fast', strict: true }, side: 'BUY' };
    expect(paths({ ...plainBlocks(), entry })).toEqual([]);
    expect(paths({ ...plainBlocks(), entry: { ...entry, params: { x: { nested: 1 } } } })).toEqual(['entry.params.x']);
    expect(paths({ ...plainBlocks(), entry: { ...entry, params: [] } })).toEqual(['entry.params']);
    expect(paths({ ...plainBlocks(), entry: { ...entry, evaluatorKey: 'Zone Reversal' } })).toEqual(['entry.evaluatorKey']);
  });

  it('CASH_INTRADAY needs a clock exit (an intraday position never holds overnight)', () => {
    expect(paths({ ...plainBlocks(), timeExit: { kind: 'holdDays', n: 2 } })).toEqual(['timeExit']);
  });

  it('MTF and OPTIONS_BUY are buy-only', () => {
    const mtf = { ...plainBlocks(), vehicle: { kind: 'MTF' }, timeExit: { kind: 'holdDays', n: 5 } };
    expect(paths({ ...mtf, entry: { ...plainBlocks().entry, side: 'BOTH' } })).toEqual(['entry.side']);
  });

  it('an ATR trail needs an ATR stop; a trail that starts after the partial needs a partial', () => {
    const atrTrail = { kind: 'atr', multiple: 1, minPct: 0.6, maxPct: 1.5, startsAfter: 'ENTRY' };
    expect(paths({ ...plainBlocks(), trail: atrTrail })).toEqual(['trail']);
    expect(paths({ ...adaptiveBlocks(), partial: { kind: 'none' } })).toEqual(['trail.startsAfter']);
  });

  it('the partial level must sit below a fixed target, and its fraction strictly between 0 and 1', () => {
    const a = adaptiveBlocks();
    expect(paths({ ...a, partial: { kind: 'atTarget1', fraction: 0.5, atPct: 2 } })).toEqual(['partial.atPct']);
    expect(paths({ ...a, partial: { kind: 'atTarget1', fraction: 1, atPct: 1 } })).toEqual(['partial.fraction']);
  });

  it('accepts a complete OPTIONS_BUY vehicle and reports its bad fields by path', () => {
    const vehicle = {
      kind: 'OPTIONS_BUY', strike: 'OTM2', minDaysToExpiry: 2, premiumStopPct: 30,
      thetaStop: { minMovePct: 10, withinMinutes: 20 }, expiryDayExitHhmm: '14:30',
    };
    expect(paths({ ...plainBlocks(), vehicle })).toEqual([]);
    expect(paths({ ...plainBlocks(), vehicle: { ...vehicle, strike: 'OTM' } })).toEqual(['vehicle.strike']);
    expect(paths({ ...plainBlocks(), vehicle: { ...vehicle, thetaStop: { minMovePct: 10 } } })).toEqual(['vehicle.thetaStop.withinMinutes']);
  });

  it('refuses a vehicle the strategy does not allow', () => {
    expect(paths(plainBlocks(), { allowedVehicles: ['MTF'] })).toEqual(['vehicle.kind']);
    expect(paths(plainBlocks(), { allowedVehicles: ['CASH_INTRADAY'] })).toEqual([]);
  });

  it('a sizing amount must be a positive number of rupees', () => {
    expect(paths({ ...plainBlocks(), sizing: { kind: 'riskRupees', amount: 0 } })).toEqual(['sizing.amount']);
  });
});

describe('formatBlockErrors', () => {
  it('joins path and message', () => {
    expect(formatBlockErrors([{ path: 'stop.pct', message: 'must be greater than 0' }, { path: 'sizing', message: 'is required' }]))
      .toBe('stop.pct: must be greater than 0; sizing: is required');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @td/api test -- validate-blocks`
Expected: FAIL with "Cannot find module './validate-blocks'".

- [ ] **Step 3: Write the types and the validator**

Create `apps/api/src/modules/trade-core/strategies/blocks/block-types.ts`:

```typescript
/**
 * SP2 building blocks (spec §4.1). A StrategyVersion is one value of
 * StrategyBlocks; validateBlocks() is the only gate a value passes before it is
 * stored or approved. Every *Pct field is a percent of price (1.5 = 1.5 %).
 *
 * Fields beyond the spec's original table (plan decision 4) exist because the
 * seeded silo code needs them: entry.match/side/minScore, the filters block,
 * trail.atr.{minPct,maxPct,startsAfter}, partial.atTarget1.atPct,
 * sizing.notionalRupees.
 */
export const VEHICLES = ['CASH_INTRADAY', 'MTF', 'OPTIONS_BUY'] as const;
export type Vehicle = (typeof VEHICLES)[number];

export const CANDLE_TIMEFRAMES = ['1m', '3m', '5m', '10m', '15m', '30m', '1h', '1d'] as const;
export type CandleTimeframe = (typeof CANDLE_TIMEFRAMES)[number];

export type EntrySide = 'BUY' | 'SELL' | 'BOTH';

export type EvaluatorParams = Record<string, number | string | boolean>;

/**
 * Gated admission: the alert's existing Chartink score (computed by the scoring
 * pipeline the silos share) must be at least `base`, or a window's `score` while
 * the alert time is inside that IST window [fromHhmm, toHhmm).
 */
export interface MinScore {
  base: number;
  windows: Array<{ fromHhmm: string; toHhmm: string; score: number }>;
}

export type EntryBlock =
  | { kind: 'chartink'; scanName: string | null; match: 'ANY' | 'EXACT' | 'CONTAINS'; side: EntrySide; minScore: MinScore | null }
  | { kind: 'evaluator'; evaluatorKey: string; params: EvaluatorParams; side: EntrySide };

/** A named code evaluator used as a pass/fail entry gate (e.g. Adaptive-Stop's decision gate). */
export interface GateRef {
  kind: 'evaluator';
  evaluatorKey: string;
  params: EvaluatorParams;
}

/**
 * Entry filters (owner answer 3, 2026-10-09). Every rule is present; `null` (or
 * `[]` for gates) means "no such filter". Applied by the core before the Risk Wall.
 */
export interface FiltersBlock {
  /** Skip when the live price has already moved more than this % past the alert price, in the trade direction. */
  staleEntry: { maxMovePct: number } | null;
  /** Skip the same symbol for this many minutes after this strategy last entered it. */
  cooldown: { minutes: number } | null;
  /** Skip when this strategy's last closed trade on the symbol, today (IST), was a loss (net P&L ≤ 0). */
  lastLoss: { window: 'SAME_IST_DAY' } | null;
  /** Every gate must pass. */
  gates: GateRef[];
}

export type StopBlock =
  | { kind: 'fixedPct'; pct: number }
  | { kind: 'atr'; period: number; timeframe: CandleTimeframe; multiple: number; minPct: number; maxPct: number };

export type TargetBlock = { kind: 'fixedPct'; pct: number } | { kind: 'rr'; ratio: number };

/** An ATR trail reuses the ATR the stop block measured at entry. */
export type TrailBlock =
  | { kind: 'none' }
  | { kind: 'breakeven'; atPct: number }
  | { kind: 'atr'; multiple: number; minPct: number; maxPct: number; startsAfter: 'ENTRY' | 'PARTIAL' };

/** `hhmm` is IST wall-clock time, "HH:MM". */
export type TimeExitBlock = { kind: 'clock'; hhmm: string } | { kind: 'holdDays'; n: number };

/** `atPct` is the target-1 level the partial sells at. */
export type PartialBlock = { kind: 'none' } | { kind: 'atTarget1'; fraction: number; atPct: number };

/** Always capped by the Risk Wall (M2). */
export type SizingBlock = { kind: 'riskRupees'; amount: number } | { kind: 'notionalRupees'; amount: number };

export type VehicleBlock =
  | { kind: 'CASH_INTRADAY' }
  | { kind: 'MTF' }
  | {
      kind: 'OPTIONS_BUY';
      /** ATM, ITM1..ITM99, OTM1..OTM99 */
      strike: string;
      /** nearest expiry with at least this many days left */
      minDaysToExpiry: number;
      premiumStopPct: number;
      thetaStop: { minMovePct: number; withinMinutes: number };
      expiryDayExitHhmm: string;
    };

export interface StrategyBlocks {
  entry: EntryBlock;
  filters: FiltersBlock;
  stop: StopBlock;
  target: TargetBlock;
  trail: TrailBlock;
  timeExit: TimeExitBlock;
  partial: PartialBlock;
  sizing: SizingBlock;
  vehicle: VehicleBlock;
}

export const BLOCK_NAMES: readonly (keyof StrategyBlocks)[] = [
  'entry', 'filters', 'stop', 'target', 'trail', 'timeExit', 'partial', 'sizing', 'vehicle',
];

export interface BlockError {
  /** e.g. "stop.minPct", "blocks.leverage", "sizing" */
  path: string;
  message: string;
}
```

Create `apps/api/src/modules/trade-core/strategies/blocks/validate-blocks.ts`:

```typescript
import { BLOCK_NAMES, CANDLE_TIMEFRAMES, VEHICLES, type BlockError, type EntrySide } from './block-types';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const STRIKE = /^(ATM|ITM[1-9]\d?|OTM[1-9]\d?)$/;
const KEBAB = /^[a-z0-9][a-z0-9-]*$/;

interface NumRule { gt?: number; gte?: number; lt?: number; integer?: boolean }
/** A percent of price: strictly between 0 and 100. A shape bound, not a risk limit. */
const PCT: NumRule = { gt: 0, lt: 100 };
/** A Chartink score: a finite number, 0 or more. */
const SCORE: NumRule = { gte: 0 };
const HHMM_STR = { maxLength: 5, pattern: HHMM, hint: 'HH:MM (IST, 24-hour)' };
const KEBAB_STR = { maxLength: 100, pattern: KEBAB, hint: 'a kebab-case key' };

class Collector {
  readonly errors: BlockError[] = [];

  add(path: string, message: string): void {
    this.errors.push({ path, message });
  }

  obj(v: unknown, path: string): Obj | undefined {
    if (!isObj(v)) {
      this.add(path, 'must be an object');
      return undefined;
    }
    return v;
  }

  onlyKeys(o: Obj, path: string, allowed: readonly string[]): void {
    for (const k of Object.keys(o)) if (!allowed.includes(k)) this.add(`${path}.${k}`, 'is not a field of this block');
  }

  num(o: Obj, key: string, path: string, rule: NumRule): number | undefined {
    const v = o[key];
    const p = `${path}.${key}`;
    if (typeof v !== 'number' || !Number.isFinite(v)) return this.fail(p, 'must be a finite number');
    if (rule.integer && !Number.isInteger(v)) return this.fail(p, 'must be a whole number');
    if (rule.gt !== undefined && !(v > rule.gt)) return this.fail(p, `must be greater than ${rule.gt}`);
    if (rule.gte !== undefined && !(v >= rule.gte)) return this.fail(p, `must be at least ${rule.gte}`);
    if (rule.lt !== undefined && !(v < rule.lt)) return this.fail(p, `must be less than ${rule.lt}`);
    return v;
  }

  oneOf<T extends string>(o: Obj, key: string, path: string, values: readonly T[]): T | undefined {
    const v = o[key];
    if (typeof v !== 'string' || !(values as readonly string[]).includes(v)) {
      return this.fail(`${path}.${key}`, `must be one of ${values.join(', ')}`);
    }
    return v as T;
  }

  str(o: Obj, key: string, path: string, opts: { maxLength: number; pattern?: RegExp; hint?: string }): string | undefined {
    const v = o[key];
    const p = `${path}.${key}`;
    if (typeof v !== 'string' || v.trim() === '') return this.fail(p, 'must be a non-empty string');
    if (v.length > opts.maxLength) return this.fail(p, `must be at most ${opts.maxLength} characters`);
    if (opts.pattern && !opts.pattern.test(v)) return this.fail(p, `must look like ${opts.hint}`);
    return v;
  }

  private fail(path: string, message: string): undefined {
    this.add(path, message);
    return undefined;
  }
}

/** Evaluator params: an object of scalars only. */
function checkParams(c: Collector, v: unknown, path: string): void {
  if (!isObj(v)) {
    c.add(path, 'must be an object');
    return;
  }
  for (const [k, pv] of Object.entries(v)) {
    const scalar = typeof pv === 'boolean' || typeof pv === 'string' || (typeof pv === 'number' && Number.isFinite(pv));
    if (!scalar) c.add(`${path}.${k}`, 'must be a number, string or boolean');
  }
}

function checkMinScore(c: Collector, v: unknown): void {
  if (v === null) return;
  const path = 'entry.minScore';
  const o = c.obj(v, path);
  if (!o) return;
  c.onlyKeys(o, path, ['base', 'windows']);
  c.num(o, 'base', path, SCORE);
  if (!Array.isArray(o.windows)) {
    c.add(`${path}.windows`, 'must be a list');
    return;
  }
  o.windows.forEach((w: unknown, i: number) => {
    const p = `${path}.windows.${i}`;
    const wo = c.obj(w, p);
    if (!wo) return;
    c.onlyKeys(wo, p, ['fromHhmm', 'toHhmm', 'score']);
    const from = c.str(wo, 'fromHhmm', p, HHMM_STR);
    const to = c.str(wo, 'toHhmm', p, HHMM_STR);
    c.num(wo, 'score', p, SCORE);
    if (from !== undefined && to !== undefined && from >= to) c.add(`${p}.toHhmm`, 'must be after fromHhmm');
  });
}

function checkEntry(c: Collector, v: unknown): { side?: EntrySide } {
  const o = c.obj(v, 'entry');
  if (!o) return {};
  const kind = c.oneOf(o, 'kind', 'entry', ['chartink', 'evaluator'] as const);
  if (kind === 'chartink') {
    c.onlyKeys(o, 'entry', ['kind', 'scanName', 'match', 'side', 'minScore']);
    const match = c.oneOf(o, 'match', 'entry', ['ANY', 'EXACT', 'CONTAINS'] as const);
    if (match === 'ANY') {
      if (o.scanName !== null) c.add('entry.scanName', 'must be null when match is ANY');
    } else if (match) {
      c.str(o, 'scanName', 'entry', { maxLength: 200 });
    }
    if (o.minScore === undefined) c.add('entry.minScore', 'is required (null for no score gate)');
    else checkMinScore(c, o.minScore);
  } else if (kind === 'evaluator') {
    c.onlyKeys(o, 'entry', ['kind', 'evaluatorKey', 'params', 'side']);
    c.str(o, 'evaluatorKey', 'entry', KEBAB_STR);
    checkParams(c, o.params, 'entry.params');
  }
  const side = c.oneOf(o, 'side', 'entry', ['BUY', 'SELL', 'BOTH'] as const);
  return { side };
}

const FILTER_RULES = ['staleEntry', 'cooldown', 'lastLoss', 'gates'] as const;

function checkFilters(c: Collector, v: unknown): void {
  const o = c.obj(v, 'filters');
  if (!o) return;
  c.onlyKeys(o, 'filters', FILTER_RULES);
  for (const k of FILTER_RULES) if (!(k in o)) c.add(`filters.${k}`, 'is required (null, or [] for gates, means none)');

  if (o.staleEntry != null) {
    const s = c.obj(o.staleEntry, 'filters.staleEntry');
    if (s) {
      c.onlyKeys(s, 'filters.staleEntry', ['maxMovePct']);
      c.num(s, 'maxMovePct', 'filters.staleEntry', PCT);
    }
  }
  if (o.cooldown != null) {
    const s = c.obj(o.cooldown, 'filters.cooldown');
    if (s) {
      c.onlyKeys(s, 'filters.cooldown', ['minutes']);
      c.num(s, 'minutes', 'filters.cooldown', { gte: 1, integer: true });
    }
  }
  if (o.lastLoss != null) {
    const s = c.obj(o.lastLoss, 'filters.lastLoss');
    if (s) {
      c.onlyKeys(s, 'filters.lastLoss', ['window']);
      c.oneOf(s, 'window', 'filters.lastLoss', ['SAME_IST_DAY'] as const);
    }
  }
  if ('gates' in o) {
    if (!Array.isArray(o.gates)) {
      c.add('filters.gates', 'must be a list');
      return;
    }
    o.gates.forEach((g: unknown, i: number) => {
      const p = `filters.gates.${i}`;
      const go = c.obj(g, p);
      if (!go) return;
      c.onlyKeys(go, p, ['kind', 'evaluatorKey', 'params']);
      c.oneOf(go, 'kind', p, ['evaluator'] as const);
      c.str(go, 'evaluatorKey', p, KEBAB_STR);
      checkParams(c, go.params, `${p}.params`);
    });
  }
}

function checkStop(c: Collector, v: unknown): 'fixedPct' | 'atr' | undefined {
  const o = c.obj(v, 'stop');
  if (!o) return undefined;
  const kind = c.oneOf(o, 'kind', 'stop', ['fixedPct', 'atr'] as const);
  if (kind === 'fixedPct') {
    c.onlyKeys(o, 'stop', ['kind', 'pct']);
    c.num(o, 'pct', 'stop', PCT);
  } else if (kind === 'atr') {
    c.onlyKeys(o, 'stop', ['kind', 'period', 'timeframe', 'multiple', 'minPct', 'maxPct']);
    c.num(o, 'period', 'stop', { gte: 1, integer: true });
    c.oneOf(o, 'timeframe', 'stop', CANDLE_TIMEFRAMES);
    c.num(o, 'multiple', 'stop', { gt: 0 });
    const min = c.num(o, 'minPct', 'stop', PCT);
    const max = c.num(o, 'maxPct', 'stop', PCT);
    if (min !== undefined && max !== undefined && min > max) c.add('stop.minPct', 'must not exceed stop.maxPct');
  }
  return kind;
}

function checkTarget(c: Collector, v: unknown): { kind?: 'fixedPct' | 'rr'; pct?: number } {
  const o = c.obj(v, 'target');
  if (!o) return {};
  const kind = c.oneOf(o, 'kind', 'target', ['fixedPct', 'rr'] as const);
  if (kind === 'fixedPct') {
    c.onlyKeys(o, 'target', ['kind', 'pct']);
    return { kind, pct: c.num(o, 'pct', 'target', PCT) };
  }
  if (kind === 'rr') {
    c.onlyKeys(o, 'target', ['kind', 'ratio']);
    c.num(o, 'ratio', 'target', { gt: 0 });
  }
  return { kind };
}

function checkTrail(c: Collector, v: unknown): { kind?: 'none' | 'breakeven' | 'atr'; startsAfter?: 'ENTRY' | 'PARTIAL' } {
  const o = c.obj(v, 'trail');
  if (!o) return {};
  const kind = c.oneOf(o, 'kind', 'trail', ['none', 'breakeven', 'atr'] as const);
  if (kind === 'none') c.onlyKeys(o, 'trail', ['kind']);
  if (kind === 'breakeven') {
    c.onlyKeys(o, 'trail', ['kind', 'atPct']);
    c.num(o, 'atPct', 'trail', PCT);
  }
  if (kind === 'atr') {
    c.onlyKeys(o, 'trail', ['kind', 'multiple', 'minPct', 'maxPct', 'startsAfter']);
    c.num(o, 'multiple', 'trail', { gt: 0 });
    const min = c.num(o, 'minPct', 'trail', PCT);
    const max = c.num(o, 'maxPct', 'trail', PCT);
    if (min !== undefined && max !== undefined && min > max) c.add('trail.minPct', 'must not exceed trail.maxPct');
    return { kind, startsAfter: c.oneOf(o, 'startsAfter', 'trail', ['ENTRY', 'PARTIAL'] as const) };
  }
  return { kind };
}

function checkTimeExit(c: Collector, v: unknown): 'clock' | 'holdDays' | undefined {
  const o = c.obj(v, 'timeExit');
  if (!o) return undefined;
  const kind = c.oneOf(o, 'kind', 'timeExit', ['clock', 'holdDays'] as const);
  if (kind === 'clock') {
    c.onlyKeys(o, 'timeExit', ['kind', 'hhmm']);
    c.str(o, 'hhmm', 'timeExit', HHMM_STR);
  }
  if (kind === 'holdDays') {
    c.onlyKeys(o, 'timeExit', ['kind', 'n']);
    c.num(o, 'n', 'timeExit', { gte: 1, integer: true });
  }
  return kind;
}

function checkPartial(c: Collector, v: unknown): { kind?: 'none' | 'atTarget1'; atPct?: number } {
  const o = c.obj(v, 'partial');
  if (!o) return {};
  const kind = c.oneOf(o, 'kind', 'partial', ['none', 'atTarget1'] as const);
  if (kind === 'none') c.onlyKeys(o, 'partial', ['kind']);
  if (kind === 'atTarget1') {
    c.onlyKeys(o, 'partial', ['kind', 'fraction', 'atPct']);
    c.num(o, 'fraction', 'partial', { gt: 0, lt: 1 });
    return { kind, atPct: c.num(o, 'atPct', 'partial', PCT) };
  }
  return { kind };
}

function checkSizing(c: Collector, v: unknown): void {
  const o = c.obj(v, 'sizing');
  if (!o) return;
  const kind = c.oneOf(o, 'kind', 'sizing', ['riskRupees', 'notionalRupees'] as const);
  if (kind) {
    c.onlyKeys(o, 'sizing', ['kind', 'amount']);
    c.num(o, 'amount', 'sizing', { gt: 0 });
  }
}

function checkVehicle(c: Collector, v: unknown): (typeof VEHICLES)[number] | undefined {
  const o = c.obj(v, 'vehicle');
  if (!o) return undefined;
  const kind = c.oneOf(o, 'kind', 'vehicle', VEHICLES);
  if (kind === 'CASH_INTRADAY' || kind === 'MTF') c.onlyKeys(o, 'vehicle', ['kind']);
  if (kind === 'OPTIONS_BUY') {
    c.onlyKeys(o, 'vehicle', ['kind', 'strike', 'minDaysToExpiry', 'premiumStopPct', 'thetaStop', 'expiryDayExitHhmm']);
    c.str(o, 'strike', 'vehicle', { maxLength: 5, pattern: STRIKE, hint: 'ATM, ITMn or OTMn' });
    c.num(o, 'minDaysToExpiry', 'vehicle', { gte: 0, integer: true });
    c.num(o, 'premiumStopPct', 'vehicle', PCT);
    const theta = c.obj(o.thetaStop, 'vehicle.thetaStop');
    if (theta) {
      c.onlyKeys(theta, 'vehicle.thetaStop', ['minMovePct', 'withinMinutes']);
      c.num(theta, 'minMovePct', 'vehicle.thetaStop', PCT);
      c.num(theta, 'withinMinutes', 'vehicle.thetaStop', { gte: 1, integer: true });
    }
    c.str(o, 'expiryDayExitHhmm', 'vehicle', HHMM_STR);
  }
  return kind;
}

/**
 * Every problem with a candidate `blocks` value, each with a path. `[]` means
 * valid. Pure: no I/O, no clock. Used on save, on approval and (M6) on AI drafts.
 */
export function validateBlocks(raw: unknown, opts: { allowedVehicles?: readonly string[] } = {}): BlockError[] {
  const c = new Collector();
  const top = c.obj(raw, 'blocks');
  if (!top) return c.errors;
  c.onlyKeys(top, 'blocks', BLOCK_NAMES);
  for (const name of BLOCK_NAMES) if (!(name in top)) c.add(name, 'is required');

  const entry = 'entry' in top ? checkEntry(c, top.entry) : {};
  if ('filters' in top) checkFilters(c, top.filters);
  const stop = 'stop' in top ? checkStop(c, top.stop) : undefined;
  const target = 'target' in top ? checkTarget(c, top.target) : {};
  const trail = 'trail' in top ? checkTrail(c, top.trail) : {};
  const timeExit = 'timeExit' in top ? checkTimeExit(c, top.timeExit) : undefined;
  const partial = 'partial' in top ? checkPartial(c, top.partial) : {};
  if ('sizing' in top) checkSizing(c, top.sizing);
  const vehicle = 'vehicle' in top ? checkVehicle(c, top.vehicle) : undefined;

  // Cross-block rules.
  if (vehicle === 'CASH_INTRADAY' && timeExit === 'holdDays') {
    c.add('timeExit', 'CASH_INTRADAY needs a clock exit (an intraday position never holds overnight)');
  }
  if ((vehicle === 'MTF' || vehicle === 'OPTIONS_BUY') && entry.side !== undefined && entry.side !== 'BUY') {
    c.add('entry.side', `${vehicle} is buy-only`);
  }
  if (trail.kind === 'atr' && stop !== undefined && stop !== 'atr') {
    c.add('trail', 'an ATR trail needs an ATR stop (it reuses the ATR measured at entry)');
  }
  if (trail.startsAfter === 'PARTIAL' && partial.kind !== undefined && partial.kind !== 'atTarget1') {
    c.add('trail.startsAfter', 'PARTIAL needs a partial block of kind atTarget1');
  }
  if (partial.atPct !== undefined && target.kind === 'fixedPct' && target.pct !== undefined && partial.atPct >= target.pct) {
    c.add('partial.atPct', 'must be below target.pct');
  }
  if (opts.allowedVehicles && vehicle && !opts.allowedVehicles.includes(vehicle)) {
    c.add('vehicle.kind', `this strategy allows only ${opts.allowedVehicles.join(', ')}`);
  }
  return c.errors;
}

export function formatBlockErrors(errors: readonly BlockError[]): string {
  return errors.map((e) => `${e.path}: ${e.message}`).join('; ');
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @td/api test -- validate-blocks`
Expected: PASS (22 tests). If one fails, fix `validate-blocks.ts`, not the test: each test pins one
path a person editing blocks will see.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/trade-core/strategies/blocks/block-types.ts apps/api/src/modules/trade-core/strategies/blocks/validate-blocks.ts apps/api/src/modules/trade-core/strategies/blocks/validate-blocks.spec.ts apps/api/src/modules/trade-core/strategies/testing/block-fixtures.ts
git commit -m "feat(trade-core): building-block types and a pure validateBlocks" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/api/src/modules/trade-core/strategies/blocks/block-types.ts apps/api/src/modules/trade-core/strategies/blocks/validate-blocks.ts apps/api/src/modules/trade-core/strategies/blocks/validate-blocks.spec.ts apps/api/src/modules/trade-core/strategies/testing/block-fixtures.ts
```

---

### Task 2: Version status rules (pure)

**Files:**
- Create: `apps/api/src/modules/trade-core/strategies/version-status.ts`
- Test: `apps/api/src/modules/trade-core/strategies/version-status.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:

```typescript
export const VERSION_STATUSES: readonly ['DRAFT', 'PAPER', 'LIVE', 'RETIRED'];
export type VersionStatus = (typeof VERSION_STATUSES)[number];
export const VERSION_CREATORS: readonly ['OWNER', 'AI'];
export type VersionCreator = (typeof VERSION_CREATORS)[number];
export type TransitionVerdict = { ok: true } | { ok: false; reason: string };
export function checkTransition(from: VersionStatus, to: VersionStatus): TransitionVerdict;
export const SELECTABLE_STATUSES: readonly VersionStatus[];   // ['PAPER'] in SP2
export function isSelectable(status: string): boolean;
export function isEditable(status: string): boolean;          // DRAFT only
```

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/modules/trade-core/strategies/version-status.spec.ts`:

```typescript
import { checkTransition, isEditable, isSelectable, SELECTABLE_STATUSES, VERSION_STATUSES } from './version-status';

describe('checkTransition', () => {
  it('approves a draft into PAPER', () => {
    expect(checkTransition('DRAFT', 'PAPER')).toEqual({ ok: true });
  });

  it('retires a draft or a paper version', () => {
    expect(checkTransition('DRAFT', 'RETIRED')).toEqual({ ok: true });
    expect(checkTransition('PAPER', 'RETIRED')).toEqual({ ok: true });
  });

  it('refuses LIVE from every status (reserved until SP7)', () => {
    for (const from of VERSION_STATUSES) {
      const verdict = checkTransition(from, 'LIVE');
      expect(verdict.ok).toBe(false);
      expect(verdict.ok ? '' : verdict.reason).toMatch(/LIVE is reserved until SP7/);
    }
  });

  it('never returns to DRAFT and never leaves RETIRED', () => {
    expect(checkTransition('PAPER', 'DRAFT').ok).toBe(false);
    expect(checkTransition('RETIRED', 'DRAFT').ok).toBe(false);
    expect(checkTransition('RETIRED', 'PAPER').ok).toBe(false);
  });

  it('refuses a no-op move with a reason', () => {
    expect(checkTransition('PAPER', 'PAPER')).toEqual({ ok: false, reason: 'already PAPER' });
    expect(checkTransition('DRAFT', 'DRAFT')).toEqual({ ok: false, reason: 'already DRAFT' });
  });
});

describe('isSelectable / isEditable', () => {
  it('only PAPER is selectable in SP2', () => {
    expect(SELECTABLE_STATUSES).toEqual(['PAPER']);
    expect(VERSION_STATUSES.filter(isSelectable)).toEqual(['PAPER']);
    expect(isSelectable('BOGUS')).toBe(false);
  });

  it('only DRAFT is editable in place', () => {
    expect(VERSION_STATUSES.filter(isEditable)).toEqual(['DRAFT']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @td/api test -- version-status`
Expected: FAIL with "Cannot find module './version-status'".

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/modules/trade-core/strategies/version-status.ts`:

```typescript
/**
 * StrategyVersion status rules (spec §4.2, plan decision 10). Pure.
 *
 * SP2 runs paper only: DRAFT → PAPER (owner approval), DRAFT|PAPER → RETIRED.
 * LIVE is a stored value from day one (so SP7 needs no migration) but no
 * transition may reach it until SP7. Nothing returns to DRAFT; RETIRED is final.
 */
export const VERSION_STATUSES = ['DRAFT', 'PAPER', 'LIVE', 'RETIRED'] as const;
export type VersionStatus = (typeof VERSION_STATUSES)[number];

export const VERSION_CREATORS = ['OWNER', 'AI'] as const;
export type VersionCreator = (typeof VERSION_CREATORS)[number];

export type TransitionVerdict = { ok: true } | { ok: false; reason: string };

const ALLOWED: Record<VersionStatus, readonly VersionStatus[]> = {
  DRAFT: ['PAPER', 'RETIRED'],
  PAPER: ['RETIRED'],
  LIVE: ['RETIRED'],
  RETIRED: [],
};

export function checkTransition(from: VersionStatus, to: VersionStatus): TransitionVerdict {
  if (to === 'LIVE') return { ok: false, reason: 'LIVE is reserved until SP7; SP2 runs paper only' };
  if (from === to) return { ok: false, reason: `already ${to}` };
  return ALLOWED[from].includes(to) ? { ok: true } : { ok: false, reason: `${from} → ${to} is not allowed` };
}

/** Versions a user may select and enable. LIVE joins this list at SP7. */
export const SELECTABLE_STATUSES: readonly VersionStatus[] = ['PAPER'];

export function isSelectable(status: string): boolean {
  return (SELECTABLE_STATUSES as readonly string[]).includes(status);
}

/** Only a draft changes in place; anything else is immutable (an edit becomes n+1). */
export function isEditable(status: string): boolean {
  return status === 'DRAFT';
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @td/api test -- version-status`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/trade-core/strategies/version-status.ts apps/api/src/modules/trade-core/strategies/version-status.spec.ts
git commit -m "feat(trade-core): version status rules; LIVE refused until SP7" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/api/src/modules/trade-core/strategies/version-status.ts apps/api/src/modules/trade-core/strategies/version-status.spec.ts
```

---

### Task 3: Tables, immutability trigger, seeds as data, and the tenant model

**Files:**
- Modify: `prisma/schema.prisma` (append three models; add one relation field to `model User`)
- Create: `prisma/migrations/20261009120000_sp2_m1_strategy_catalogue/migration.sql`
- Modify: `apps/api/src/common/tenant/tenant.constants.ts`
- Test: `apps/api/src/modules/trade-core/strategies/core-strategy-seeds.spec.ts`
- Test (opt-in, real database): `apps/api/test/sp2-m1/jest.config.js`, `apps/api/test/sp2-m1/core-strategy-catalogue.int.spec.ts`

**Interfaces:**
- Consumes: `validateBlocks` (Task 1), `VehicleBlock`/`StrategyBlocks` types (Task 1).
- Produces: Prisma models `CoreStrategy` (`core_strategies`), `CoreStrategyVersion`
  (`core_strategy_versions`, unique `strategyId_version`), `CoreStrategySelection`
  (`core_strategy_selections`, unique `userId_strategyId`); seed ids `cs_adaptive_stop`, `cs_ungated`,
  `csv_adaptive_stop_v1`, `csv_ungated_v1` (keys `adaptive-stop`, `ungated`);
  `TENANT_MODELS` contains `'CoreStrategySelection'`.

- [ ] **Step 1: Write the failing seed spec**

Create `apps/api/src/modules/trade-core/strategies/core-strategy-seeds.spec.ts`:

```typescript
import { readFileSync } from 'fs';
import { join } from 'path';
import { validateBlocks } from './blocks/validate-blocks';
import type { StrategyBlocks } from './blocks/block-types';
import * as adaptive from '../../adaptive-stop-track/constants';

/**
 * The M1 seeds are rows in the migration (data, not code). This spec proves
 * (1) they are valid blocks and (2) every number equals the silo code it was
 * copied from at M1 (plan decision 5). The silo is read, never imported for
 * behaviour. If a silo legitimately changes later, v1 does NOT change: replace
 * the source lookup here with the M1 literal and keep the seed as it is.
 */
const ROOT = join(__dirname, '..', '..', '..', '..', '..', '..');
const MIGRATION = join(ROOT, 'prisma', 'migrations', '20261009120000_sp2_m1_strategy_catalogue', 'migration.sql');
const sql = readFileSync(MIGRATION, 'utf8');
const silo = (rel: string) => readFileSync(join(ROOT, 'apps', 'api', 'src', 'modules', rel), 'utf8');

const ADAPTIVE_WATCH = 'adaptive-stop-track/services/adaptive-stop-watch.service.ts';
const ADAPTIVE_POLLER = 'adaptive-stop-track/services/adaptive-stop-tick-poller.service.ts';
const UNGATED_WATCH = 'ungated-track/services/ungated-watch.service.ts';
const UNGATED_POLLER = 'ungated-track/services/ungated-tick-poller.service.ts';
const UNGATED_ACCOUNT = 'ungated-track/services/ungated-paper-account.service.ts';
const TRADE_POLICY = 'watch-monitor/services/trade-policy.ts';
const DECISION_GATE = 'adaptive-stop-track/adaptive-stop-decision-gate.ts';
const CHARTINK_PROCESS = 'chartink/services/chartink-process.service.ts';

/** Minutes in `export const TRADE_COOLDOWN_MS = 45 * 60_000;`. */
function cooldownMinutes(file: string): number {
  const m = /TRADE_COOLDOWN_MS = (\d+) \* 60_000/.exec(silo(file));
  if (!m) throw new Error(`TRADE_COOLDOWN_MS not found in ${file}`);
  return Number(m[1]);
}

/** Seed version id → blocks, from the migration's single-line JSON literals. */
function seedBlocks(): Map<string, StrategyBlocks> {
  const out = new Map<string, StrategyBlocks>();
  const re = /SELECT '(csv_[a-z0-9_]+)', s\."id", 1, '(\{[^']*\})'::jsonb/g;
  for (const m of sql.matchAll(re)) out.set(m[1], JSON.parse(m[2]) as StrategyBlocks);
  return out;
}

/** The first numeric literal assigned to `name` in a silo file (underscores allowed). */
function constIn(file: string, name: string): number {
  const m = new RegExp(`${name}\\s*=\\s*([0-9_.]+)`).exec(silo(file));
  if (!m) throw new Error(`${name} not found in ${file}`);
  return Number(m[1].replace(/_/g, ''));
}

/** "HH:MM" of the `@Cron('0 M H * * 1-5')` EOD square-off in a tick poller. */
function eodClock(file: string): string {
  const m = /@Cron\('0 (\d{1,2}) (\d{1,2}) \* \* 1-5'/.exec(silo(file));
  if (!m) throw new Error(`no EOD cron in ${file}`);
  return `${m[2].padStart(2, '0')}:${m[1].padStart(2, '0')}`;
}

describe('M1 seed rows', () => {
  const seeds = seedBlocks();

  it('are exactly Adaptive-Stop v1 and Ungated v1, inserted idempotently as OWNER drafts', () => {
    expect([...seeds.keys()].sort()).toEqual(['csv_adaptive_stop_v1', 'csv_ungated_v1']);
    expect(sql).toContain('ON CONFLICT ("key") DO NOTHING');
    expect(sql).toContain('ON CONFLICT ("strategyId", "version") DO NOTHING');
    expect(sql.match(/'DRAFT', 'OWNER'/g)).toHaveLength(2);
  });

  it('every seed passes validateBlocks for its strategy', () => {
    for (const blocks of seeds.values()) {
      expect(validateBlocks(blocks, { allowedVehicles: ['CASH_INTRADAY'] })).toEqual([]);
    }
  });

  it('Adaptive-Stop v1 equals the adaptive-stop-track code', () => {
    const b = seeds.get('csv_adaptive_stop_v1')!;
    expect(b.entry).toEqual({
      kind: 'chartink', scanName: null, match: 'ANY', side: 'BUY',
      minScore: {
        base: constIn(TRADE_POLICY, 'MIN_SCORE_NORMAL'),
        windows: [{ fromHhmm: '11:45', toHhmm: '14:00', score: constIn(TRADE_POLICY, 'MIN_SCORE_STRICT') }],
      },
    });
    expect(silo(TRADE_POLICY)).toContain('minutesOfDay >= 11 * 60 + 45 && minutesOfDay < 14 * 60');
    expect(silo(ADAPTIVE_WATCH)).toMatch(/if \(input\.side !== 'BUY'\) throw new AdaptiveStopSellDirectionError/);

    expect(b.filters).toEqual({
      staleEntry: { maxMovePct: 1 },
      cooldown: { minutes: cooldownMinutes(ADAPTIVE_WATCH) },
      lastLoss: { window: 'SAME_IST_DAY' },
      gates: [{
        kind: 'evaluator',
        evaluatorKey: 'adaptive-stop-decision-gate',
        params: {
          nearSupportPct: adaptive.GATE_NEAR_SUPPORT_PCT,
          rsiHot: adaptive.GATE_RSI_HOT,
          vwapExtPct: adaptive.GATE_VWAP_EXT_PCT,
          requireMacdBullish: adaptive.GATE_REQUIRE_15M_MACD,
          srLookbackDays: adaptive.GATE_SR_LOOKBACK_DAYS,
          minCandles: 10,
          minSameDayCandles: 3,
          failOpen: true,
        },
      }],
    });
    expect(adaptive.DECISION_GATE_ENABLED).toBe(true);
    expect(silo(ADAPTIVE_WATCH)).toContain('if (moveFromAlert > 0.01)');
    expect(silo(ADAPTIVE_WATCH)).toContain('if (lastPnl !== null && lastPnl <= 0)');
    expect(silo(DECISION_GATE)).toContain('if (before.length < 10 || sameDay.length < 3) return skip(');
    expect(silo(DECISION_GATE)).toContain('pass: true, skipped: true');

    expect(b.stop).toEqual({
      kind: 'atr', period: 14, timeframe: '5m',
      multiple: adaptive.ATR_MULT, minPct: adaptive.MIN_STOP_PCT, maxPct: adaptive.MAX_STOP_PCT,
    });
    expect(silo(ADAPTIVE_WATCH)).toMatch(/getHistoricalData\(token, exchange, '5m', from, now\)/);
    expect(silo(ADAPTIVE_WATCH)).toMatch(/c\.map\(\(x: any\) => x\.close\),\s*14,/);

    expect(b.target).toEqual({ kind: 'fixedPct', pct: expect.closeTo(adaptive.PROFIT_TARGET_PCT * 100, 10) });
    expect(b.trail).toEqual({
      kind: 'atr', multiple: adaptive.TRAIL_ATR_MULT, minPct: adaptive.TRAIL_MIN_PCT, maxPct: adaptive.TRAIL_MAX_PCT,
      startsAfter: 'PARTIAL',
    });
    expect(b.partial).toEqual({
      kind: 'atTarget1',
      fraction: constIn(ADAPTIVE_WATCH, 'PARTIAL_EXIT_FRACTION'),
      atPct: expect.closeTo(constIn(ADAPTIVE_WATCH, 'PARTIAL_EXIT_THRESHOLD_PCT') * 100, 10),
    });
    expect(b.sizing).toEqual({ kind: 'riskRupees', amount: adaptive.RISK_PER_TRADE });
    expect(b.timeExit).toEqual({ kind: 'clock', hhmm: eodClock(ADAPTIVE_POLLER) });
    expect(b.timeExit).toEqual({ kind: 'clock', hhmm: '15:15' });
    expect(b.vehicle).toEqual({ kind: 'CASH_INTRADAY' });
  });

  it('Ungated v1 equals the ungated-track code', () => {
    const b = seeds.get('csv_ungated_v1')!;
    expect(b.entry).toEqual({ kind: 'chartink', scanName: 'hull', match: 'CONTAINS', side: 'BUY', minScore: null });
    expect(silo(CHARTINK_PROCESS)).toContain('UNGATED shadow track — runs unconditionally for every scored alert');
    expect(b.filters).toEqual({
      staleEntry: { maxMovePct: 1 },
      cooldown: { minutes: cooldownMinutes(UNGATED_WATCH) },
      lastLoss: { window: 'SAME_IST_DAY' },
      gates: [],
    });
    expect(silo(UNGATED_WATCH)).toContain('if (moveFromAlert > 0.01)');
    expect(silo(UNGATED_WATCH)).toContain('if (lastPnl !== null && lastPnl <= 0)');
    expect(silo('ungated-track/services/ungated-scanner-filter.ts')).toContain(".includes('hull')");
    expect(silo(UNGATED_WATCH)).toMatch(/if \(input\.side !== 'BUY'\) throw new UngatedSellDirectionError/);

    expect(b.stop).toEqual({ kind: 'fixedPct', pct: expect.closeTo(constIn(UNGATED_WATCH, 'HARD_STOP_PCT') * 100, 10) });
    expect(b.target).toEqual({ kind: 'fixedPct', pct: expect.closeTo(constIn(UNGATED_WATCH, 'PROFIT_TARGET_PCT') * 100, 10) });
    expect(b.trail).toEqual({ kind: 'none' });
    expect(b.partial).toEqual({ kind: 'none' });
    expect(silo(UNGATED_WATCH)).toContain('Pure-hold: partial-exit + trailing removed');
    expect(b.sizing).toEqual({ kind: 'notionalRupees', amount: constIn(UNGATED_ACCOUNT, 'TRADE_CAPITAL') });
    expect(b.timeExit).toEqual({ kind: 'clock', hhmm: eodClock(UNGATED_POLLER) });
    expect(b.timeExit).toEqual({ kind: 'clock', hhmm: '15:25' });
    expect(b.vehicle).toEqual({ kind: 'CASH_INTRADAY' });
  });
});
```

- [ ] **Step 2: Run the spec to verify it fails**

Run: `pnpm --filter @td/api test -- core-strategy-seeds`
Expected: FAIL with `ENOENT: no such file or directory … 20261009120000_sp2_m1_strategy_catalogue/migration.sql`.

- [ ] **Step 3: Add the models**

In `prisma/schema.prisma`, inside `model User { … }`, add one line after `stockMonitors      StockMonitor[]`:

```prisma
  coreStrategySelections CoreStrategySelection[]
```

Append at the end of `prisma/schema.prisma`:

```prisma
// ─── SP2 M1: trade-core strategy catalogue ───────────────────────────────────
// docs/superpowers/specs/2026-10-09-sp2-core-trade-lifecycle-design.md §4.2.
// The catalogue (strategies + versions) is global and owner-curated; selections
// are per user. A trigger in the 20261009120000 migration makes a version
// immutable once it leaves DRAFT; CHECK constraints pin the string enums.

/// One strategy in the catalogue (the dropdown's top level).
model CoreStrategy {
  id              String                  @id @default(cuid())
  key             String                  @unique
  name            String
  description     String
  allowedVehicles String[]
  createdAt       DateTime                @default(now())
  versions        CoreStrategyVersion[]
  selections      CoreStrategySelection[]

  @@map("core_strategies")
}

/// A block configuration. Immutable once approved: an edit creates version n+1.
model CoreStrategyVersion {
  id          String                  @id @default(cuid())
  strategyId  String
  strategy    CoreStrategy            @relation(fields: [strategyId], references: [id])
  version     Int
  blocks      Json
  status      String                  @default("DRAFT") // DRAFT | PAPER | LIVE (SP7) | RETIRED
  createdBy   String // OWNER | AI
  approvedBy  String?
  approvedAt  DateTime?
  sourceDocId String? // core_strategy_docs.id from M6 (FK added then)
  notes       String?
  createdAt   DateTime                @default(now())
  updatedAt   DateTime                @updatedAt
  selections  CoreStrategySelection[]

  @@unique([strategyId, version])
  @@index([strategyId, status])
  @@map("core_strategy_versions")
}

/// A user's choice for one strategy: which version, on or off, and its capital (₹).
model CoreStrategySelection {
  id                String              @id @default(cuid())
  userId            String
  user              User                @relation(fields: [userId], references: [id], onDelete: Cascade)
  strategyId        String
  strategy          CoreStrategy        @relation(fields: [strategyId], references: [id])
  strategyVersionId String
  strategyVersion   CoreStrategyVersion @relation(fields: [strategyVersionId], references: [id])
  enabled           Boolean             @default(false)
  capitalAllocation Float
  createdAt         DateTime            @default(now())
  updatedAt         DateTime            @updatedAt

  @@unique([userId, strategyId])
  @@index([strategyVersionId])
  @@map("core_strategy_selections")
}
```

- [ ] **Step 4: Write the migration**

Create `prisma/migrations/20261009120000_sp2_m1_strategy_catalogue/migration.sql`:

```sql
-- SP2 M1 — trade-core strategy catalogue
-- (docs/superpowers/specs/2026-10-09-sp2-core-trade-lifecycle-design.md §4.1–4.3).
--
-- Expand-only: creates three tables, CHECK constraints, an immutability trigger and
-- two seed rows. Drops and alters nothing that exists. core_strategy_docs and
-- core_strategy_gaps arrive with M6.

CREATE TABLE "core_strategies" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "allowedVehicles" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "core_strategies_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "core_strategy_versions" (
    "id" TEXT NOT NULL,
    "strategyId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "blocks" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "createdBy" TEXT NOT NULL,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "sourceDocId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "core_strategy_versions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "core_strategy_selections" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "strategyId" TEXT NOT NULL,
    "strategyVersionId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "capitalAllocation" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "core_strategy_selections_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "core_strategies_key_key" ON "core_strategies"("key");
CREATE INDEX "core_strategy_versions_strategyId_status_idx" ON "core_strategy_versions"("strategyId", "status");
CREATE UNIQUE INDEX "core_strategy_versions_strategyId_version_key" ON "core_strategy_versions"("strategyId", "version");
CREATE INDEX "core_strategy_selections_strategyVersionId_idx" ON "core_strategy_selections"("strategyVersionId");
CREATE UNIQUE INDEX "core_strategy_selections_userId_strategyId_key" ON "core_strategy_selections"("userId", "strategyId");

ALTER TABLE "core_strategy_versions" ADD CONSTRAINT "core_strategy_versions_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "core_strategies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "core_strategy_selections" ADD CONSTRAINT "core_strategy_selections_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "core_strategy_selections" ADD CONSTRAINT "core_strategy_selections_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "core_strategies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "core_strategy_selections" ADD CONSTRAINT "core_strategy_selections_strategyVersionId_fkey" FOREIGN KEY ("strategyVersionId") REFERENCES "core_strategy_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- String enums are pinned here (Prisma models them as String; its diff ignores CHECKs).
ALTER TABLE "core_strategies" ADD CONSTRAINT "core_strategies_allowedVehicles_check"
    CHECK (cardinality("allowedVehicles") > 0 AND "allowedVehicles" <@ ARRAY['CASH_INTRADAY', 'MTF', 'OPTIONS_BUY']::TEXT[]);
ALTER TABLE "core_strategy_versions" ADD CONSTRAINT "core_strategy_versions_status_check"
    CHECK ("status" IN ('DRAFT', 'PAPER', 'LIVE', 'RETIRED'));
ALTER TABLE "core_strategy_versions" ADD CONSTRAINT "core_strategy_versions_createdBy_check"
    CHECK ("createdBy" IN ('OWNER', 'AI'));
ALTER TABLE "core_strategy_versions" ADD CONSTRAINT "core_strategy_versions_version_check"
    CHECK ("version" >= 1);
ALTER TABLE "core_strategy_selections" ADD CONSTRAINT "core_strategy_selections_capitalAllocation_check"
    CHECK ("capitalAllocation" >= 0);

-- Immutable once approved (plan decision 8). A version that has left DRAFT keeps its
-- content forever; only its status may move on (PAPER → RETIRED). It is never
-- deleted, because positions reference the version they entered under (M4).
CREATE OR REPLACE FUNCTION core_strategy_versions_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'core_strategy_versions %: an approved version cannot be deleted', OLD."id";
    END IF;
    RETURN OLD;
  END IF;
  IF OLD."status" <> 'DRAFT' THEN
    IF NEW."blocks" IS DISTINCT FROM OLD."blocks"
       OR NEW."strategyId" IS DISTINCT FROM OLD."strategyId"
       OR NEW."version" IS DISTINCT FROM OLD."version"
       OR NEW."createdBy" IS DISTINCT FROM OLD."createdBy"
       OR NEW."sourceDocId" IS DISTINCT FROM OLD."sourceDocId"
       OR NEW."notes" IS DISTINCT FROM OLD."notes"
       OR NEW."approvedBy" IS DISTINCT FROM OLD."approvedBy"
       OR NEW."approvedAt" IS DISTINCT FROM OLD."approvedAt" THEN
      RAISE EXCEPTION 'core_strategy_versions %: an approved version is immutable; create version n+1', OLD."id";
    END IF;
    IF NEW."status" = 'DRAFT' THEN
      RAISE EXCEPTION 'core_strategy_versions %: an approved version cannot return to DRAFT', OLD."id";
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "core_strategy_versions_guard"
    BEFORE UPDATE OR DELETE ON "core_strategy_versions"
    FOR EACH ROW EXECUTE FUNCTION core_strategy_versions_guard();

-- SEED BEGIN
-- Seeds are data (spec §4.1), idempotent (ON CONFLICT DO NOTHING), inserted as DRAFT so
-- the owner approves each in the UI. Values are copied from the silo code at commit
-- 321af45; every number is cited in docs/superpowers/plans/2026-10-09-sp2-m1-strategy-catalogue.md
-- (decision 5) and checked against the silo source by core-strategy-seeds.spec.ts.
-- Each blocks literal stays on ONE line (the spec parses it). No statement contains a
-- semicolon followed by a newline inside a string (the opt-in test splits on that).
INSERT INTO "core_strategies" ("id", "key", "name", "description", "allowedVehicles", "createdAt") VALUES
    ('cs_adaptive_stop', 'adaptive-stop', 'Adaptive-Stop', 'Chartink alerts that pass the gated score and the decision gate, with an ATR volatility stop, risk-first sizing, a 50 percent partial at +1 percent and an ATR trail on the rest. Seeded from the adaptive-stop-track silo.', ARRAY['CASH_INTRADAY']::TEXT[], CURRENT_TIMESTAMP),
    ('cs_ungated', 'ungated', 'Ungated', 'Hull-scanner Chartink alerts with a fixed 1.5 percent stop and a 3 percent target, held to target, stop or close. Seeded from the ungated-track silo.', ARRAY['CASH_INTRADAY']::TEXT[], CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "core_strategy_versions" ("id", "strategyId", "version", "blocks", "status", "createdBy", "notes", "createdAt", "updatedAt")
SELECT 'csv_adaptive_stop_v1', s."id", 1, '{"entry":{"kind":"chartink","scanName":null,"match":"ANY","side":"BUY","minScore":{"base":47,"windows":[{"fromHhmm":"11:45","toHhmm":"14:00","score":75}]}},"filters":{"staleEntry":{"maxMovePct":1},"cooldown":{"minutes":45},"lastLoss":{"window":"SAME_IST_DAY"},"gates":[{"kind":"evaluator","evaluatorKey":"adaptive-stop-decision-gate","params":{"nearSupportPct":0.6,"rsiHot":70,"vwapExtPct":1.5,"requireMacdBullish":true,"srLookbackDays":5,"minCandles":10,"minSameDayCandles":3,"failOpen":true}}]},"stop":{"kind":"atr","period":14,"timeframe":"5m","multiple":1.2,"minPct":0.8,"maxPct":2.5},"target":{"kind":"fixedPct","pct":2},"trail":{"kind":"atr","multiple":1,"minPct":0.6,"maxPct":1.5,"startsAfter":"PARTIAL"},"timeExit":{"kind":"clock","hhmm":"15:15"},"partial":{"kind":"atTarget1","fraction":0.5,"atPct":1},"sizing":{"kind":"riskRupees","amount":800},"vehicle":{"kind":"CASH_INTRADAY"}}'::jsonb, 'DRAFT', 'OWNER', 'Seeded 2026-10-09 from the adaptive-stop-track silo (commit 321af45). Dropped by owner decision 2026-10-09 (artifacts of 30-second polling, not carried into the core): two-strike stop confirmation (adaptive-stop-watch.service.ts:383-397) and the 2-minute stop grace (constants.ts:12). Left to the Risk Wall (M2): one open position per symbol (adaptive-stop-watch.service.ts:171-172) and 40 concurrent positions (constants.ts:4). Evaluator plumbing, not a rule: decision-gate 15m fetch retries (constants.ts:41-42). ATR source: 3 days of 5m candles, at least 21 (adaptive-stop-watch.service.ts:110-112).', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "core_strategies" s WHERE s."key" = 'adaptive-stop'
ON CONFLICT ("strategyId", "version") DO NOTHING;

INSERT INTO "core_strategy_versions" ("id", "strategyId", "version", "blocks", "status", "createdBy", "notes", "createdAt", "updatedAt")
SELECT 'csv_ungated_v1', s."id", 1, '{"entry":{"kind":"chartink","scanName":"hull","match":"CONTAINS","side":"BUY","minScore":null},"filters":{"staleEntry":{"maxMovePct":1},"cooldown":{"minutes":45},"lastLoss":{"window":"SAME_IST_DAY"},"gates":[]},"stop":{"kind":"fixedPct","pct":1.5},"target":{"kind":"fixedPct","pct":3},"trail":{"kind":"none"},"timeExit":{"kind":"clock","hhmm":"15:25"},"partial":{"kind":"none"},"sizing":{"kind":"notionalRupees","amount":200000},"vehicle":{"kind":"CASH_INTRADAY"}}'::jsonb, 'DRAFT', 'OWNER', 'Seeded 2026-10-09 from the ungated-track silo (commit 321af45). Dropped by owner decision 2026-10-09 (an artifact of 30-second polling): two-strike stop confirmation (ungated-watch.service.ts:288-296). Left to the Risk Wall (M2): one open position per symbol (ungated-watch.service.ts:113-114) and 40 concurrent positions (ungated-paper-account.service.ts:8). Not carried: the UNGATED_HULL_ONLY env switch (ungated-watch.service.ts:105; the version itself now says Hull-only) and the at-least-1-share floor (ungated-watch.service.ts:212; sizing below one share is a Risk Wall reject).', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "core_strategies" s WHERE s."key" = 'ungated'
ON CONFLICT ("strategyId", "version") DO NOTHING;
-- SEED END
```

- [ ] **Step 5: Generate the client, validate the schema, run the seed spec**

```bash
cd apps/api && npx prisma validate --schema ../../prisma/schema.prisma && npx prisma generate --schema ../../prisma/schema.prisma
```

Expected: `The schema at ../../prisma/schema.prisma is valid`, then `Generated Prisma Client`.

Run: `pnpm --filter @td/api test -- core-strategy-seeds`
Expected: PASS (4 tests). A failure in the "equals the … code" tests means a seed number differs from the
silo: fix the **migration** (the code wins), never the silo.

- [ ] **Step 6: Make the selection a tenant model**

In `apps/api/src/common/tenant/tenant.constants.ts`, add `'CoreStrategySelection',` as the last entry of
the `TENANT_MODELS` set (after `'VerificationToken',`), with this comment line above it:

```typescript
  // SP2 M1: per-user strategy selections. The catalogue (CoreStrategy,
  // CoreStrategyVersion) is global and deliberately absent.
  'CoreStrategySelection',
```

(Task 4's repository spec asserts this membership.)

- [ ] **Step 7: Write the opt-in database test**

Create `apps/api/test/sp2-m1/jest.config.js`:

```javascript
const path = require('path');

/**
 * Opt-in SQL tests for the SP2 M1 catalogue (seeds, immutability trigger, CHECKs)
 * against a real Postgres with every migration applied. The default apps/api Jest
 * config (rootDir: src) never discovers these.
 *
 * Run from apps/api:
 *   DATABASE_URL_TEST=postgresql://postgres:password@127.0.0.1:5432/grw_sp2m1_test \
 *     npx jest --config test/sp2-m1/jest.config.js -i
 */
module.exports = {
  rootDir: path.resolve(__dirname, '../..'),
  roots: ['<rootDir>/test/sp2-m1'],
  moduleFileExtensions: ['js', 'json', 'ts'],
  testRegex: '.*\\.spec\\.ts$',
  transform: { '^.+\\.(t|j)s$': ['ts-jest', { isolatedModules: true }] },
  testEnvironment: 'node',
};
```

Create `apps/api/test/sp2-m1/core-strategy-catalogue.int.spec.ts`:

```typescript
import { readFileSync } from 'fs';
import { join } from 'path';
import { PrismaClient } from '@prisma/client';

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error('DATABASE_URL_TEST must point at a throw-away database with all migrations applied');

const db = new PrismaClient({ datasources: { db: { url } } });
const MIGRATION = join(__dirname, '..', '..', '..', '..', 'prisma', 'migrations', '20261009120000_sp2_m1_strategy_catalogue', 'migration.sql');
const sql = readFileSync(MIGRATION, 'utf8');
const seedStatements = sql
  .slice(sql.indexOf('-- SEED BEGIN'), sql.indexOf('-- SEED END'))
  .split(';\n')
  .map((s) => s.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n').trim())
  .filter((s) => s.length > 0);

const run = `it${Date.now()}`;
const BLOCKS = '{"entry":{"kind":"chartink","scanName":null,"match":"ANY","side":"BUY"}}';

async function draftVersion(): Promise<string> {
  const strategyId = `cs_${run}_${Math.random().toString(36).slice(2, 8)}`;
  await db.$executeRawUnsafe(
    `INSERT INTO "core_strategies" ("id","key","name","description","allowedVehicles") VALUES ($1, $1, 'IT', 'IT', ARRAY['CASH_INTRADAY']::TEXT[])`,
    strategyId,
  );
  const id = `${strategyId}_v1`;
  await db.$executeRawUnsafe(
    `INSERT INTO "core_strategy_versions" ("id","strategyId","version","blocks","status","createdBy","updatedAt") VALUES ($1, $2, 1, $3::jsonb, 'DRAFT', 'OWNER', CURRENT_TIMESTAMP)`,
    id, strategyId, BLOCKS,
  );
  return id;
}

afterAll(() => db.$disconnect());

describe('core strategy catalogue (real database)', () => {
  it('has the two seeds as DRAFT v1, and re-running the seed block changes nothing', async () => {
    const count = async () =>
      db.$queryRawUnsafe<Array<{ s: number; v: number }>>(
        `SELECT (SELECT count(*)::int FROM "core_strategies" WHERE "key" IN ('adaptive-stop','ungated')) AS s,
                (SELECT count(*)::int FROM "core_strategy_versions" WHERE "id" IN ('csv_adaptive_stop_v1','csv_ungated_v1') AND "status" = 'DRAFT' AND "version" = 1) AS v`,
      );
    expect(await count()).toEqual([{ s: 2, v: 2 }]);
    expect(seedStatements).toHaveLength(3);
    for (const stmt of seedStatements) await db.$executeRawUnsafe(stmt);
    expect(await count()).toEqual([{ s: 2, v: 2 }]);
  });

  it('lets a draft change, then refuses to change or delete an approved version, and refuses a return to DRAFT', async () => {
    const id = await draftVersion();
    await db.$executeRawUnsafe(`UPDATE "core_strategy_versions" SET "notes" = 'edited' WHERE "id" = $1`, id);
    await db.$executeRawUnsafe(
      `UPDATE "core_strategy_versions" SET "status" = 'PAPER', "approvedBy" = 'usr_it', "approvedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`, id,
    );
    await expect(
      db.$executeRawUnsafe(`UPDATE "core_strategy_versions" SET "blocks" = '{}'::jsonb WHERE "id" = $1`, id),
    ).rejects.toThrow(/immutable/);
    await expect(
      db.$executeRawUnsafe(`UPDATE "core_strategy_versions" SET "status" = 'DRAFT' WHERE "id" = $1`, id),
    ).rejects.toThrow(/cannot return to DRAFT/);
    await expect(db.$executeRawUnsafe(`DELETE FROM "core_strategy_versions" WHERE "id" = $1`, id)).rejects.toThrow(/cannot be deleted/);
    await db.$executeRawUnsafe(`UPDATE "core_strategy_versions" SET "status" = 'RETIRED' WHERE "id" = $1`, id);
  });

  it('refuses an unknown status, an unknown creator and an unknown vehicle', async () => {
    const id = await draftVersion();
    await expect(db.$executeRawUnsafe(`UPDATE "core_strategy_versions" SET "status" = 'BOGUS' WHERE "id" = $1`, id)).rejects.toThrow(/status_check/);
    await expect(db.$executeRawUnsafe(`UPDATE "core_strategy_versions" SET "createdBy" = 'ROBOT' WHERE "id" = $1`, id)).rejects.toThrow(/createdBy_check/);
    await expect(
      db.$executeRawUnsafe(`INSERT INTO "core_strategies" ("id","key","name","description","allowedVehicles") VALUES ($1, $1, 'x', 'x', ARRAY['FUTURES']::TEXT[])`, `cs_${run}_bad`),
    ).rejects.toThrow(/allowedVehicles_check/);
  });
});
```

- [ ] **Step 8: Run the opt-in test and prove there is no schema drift**

Start Docker Desktop first if it is not running (the disk is low: reuse the existing `td-postgres`
container, do not pull a new image). From the repo root:

```bash
docker compose up -d postgres
docker exec td-postgres psql -U postgres -c "DROP DATABASE IF EXISTS grw_sp2m1_test" -c "CREATE DATABASE grw_sp2m1_test"
DATABASE_URL=postgresql://postgres:password@127.0.0.1:5432/grw_sp2m1_test DIRECT_URL=postgresql://postgres:password@127.0.0.1:5432/grw_sp2m1_test npx prisma migrate deploy --schema prisma/schema.prisma
cd apps/api && DATABASE_URL_TEST=postgresql://postgres:password@127.0.0.1:5432/grw_sp2m1_test npx jest --config test/sp2-m1/jest.config.js -i
```

Expected: `migrate deploy` lists `20261009120000_sp2_m1_strategy_catalogue` as applied; the suite PASSES
(3 tests). If the migration fails on `20261008120000_sp1_m2_candle_store`'s TimescaleDB step, that is the
M2 deploy SQL, not this migration; plain Postgres applies it as a no-op.

```bash
docker exec td-postgres psql -U postgres -c "DROP DATABASE IF EXISTS grw_sp2m1_shadow" -c "CREATE DATABASE grw_sp2m1_shadow"
npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url postgresql://postgres:password@127.0.0.1:5432/grw_sp2m1_shadow --exit-code
docker exec td-postgres psql -U postgres -c "DROP DATABASE grw_sp2m1_test" -c "DROP DATABASE grw_sp2m1_shadow"
```

Expected: exit code 0 (`No difference detected.`). A non-zero exit means the models and the SQL
disagree; make the table/index/FK SQL match what Prisma expects (the CHECKs, the function and the
trigger are invisible to the diff and stay).

- [ ] **Step 9: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20261009120000_sp2_m1_strategy_catalogue/migration.sql apps/api/src/common/tenant/tenant.constants.ts apps/api/src/modules/trade-core/strategies/core-strategy-seeds.spec.ts apps/api/test/sp2-m1/jest.config.js apps/api/test/sp2-m1/core-strategy-catalogue.int.spec.ts
git commit -m "feat(trade-core): core strategy tables, immutability trigger, Adaptive-Stop v1 and Ungated v1 seeds" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- prisma/schema.prisma prisma/migrations/20261009120000_sp2_m1_strategy_catalogue/migration.sql apps/api/src/common/tenant/tenant.constants.ts apps/api/src/modules/trade-core/strategies/core-strategy-seeds.spec.ts apps/api/test/sp2-m1/jest.config.js apps/api/test/sp2-m1/core-strategy-catalogue.int.spec.ts
```

---

### Task 4: Repositories (catalogue global, selections per user)

**Files:**
- Create: `apps/api/src/modules/trade-core/strategies/repositories/core-strategy.repository.ts`
- Create: `apps/api/src/modules/trade-core/strategies/repositories/core-strategy-selection.repository.ts`
- Test: `apps/api/src/modules/trade-core/strategies/repositories/core-strategy.repository.spec.ts`

**Interfaces:**
- Consumes: Prisma models (Task 3), `VersionStatus`/`VersionCreator` (Task 2), `PrismaService`
  (`common/prisma/prisma.service.ts`, global module).
- Produces:

```typescript
export type StrategyWithVersions = CoreStrategy & { versions: CoreStrategyVersion[] };
export type VersionWithStrategy = CoreStrategyVersion & { strategy: CoreStrategy };
export interface NewVersion { strategyId: string; version: number; blocks: Prisma.InputJsonValue; createdBy: VersionCreator; notes: string | null }

class CoreStrategyRepository {
  listWithVersions(statuses?: readonly VersionStatus[]): Promise<StrategyWithVersions[]>;   // versions newest first
  findStrategy(id: string): Promise<CoreStrategy | null>;
  findVersion(id: string): Promise<VersionWithStrategy | null>;
  nextVersionNumber(strategyId: string): Promise<number>;
  createVersion(data: NewVersion): Promise<CoreStrategyVersion>;                            // always DRAFT
  updateDraft(id: string, data: { blocks: Prisma.InputJsonValue; notes: string | null }): Promise<boolean>;   // false = no longer a draft
  transition(id: string, from: VersionStatus, data: { status: VersionStatus; approvedBy?: string; approvedAt?: Date }): Promise<boolean>;
}

export interface SelectionWrite { strategyVersionId: string; enabled: boolean; capitalAllocation: number }
class CoreStrategySelectionRepository {
  listForUser(userId: string): Promise<CoreStrategySelection[]>;
  findForUser(userId: string, strategyId: string): Promise<CoreStrategySelection | null>;
  upsert(userId: string, strategyId: string, data: SelectionWrite): Promise<CoreStrategySelection>;
}
```

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/modules/trade-core/strategies/repositories/core-strategy.repository.spec.ts`:

```typescript
import type { PrismaService } from '../../../../common/prisma/prisma.service';
import { TENANT_MODELS } from '../../../../common/tenant/tenant.constants';
import { CoreStrategyRepository } from './core-strategy.repository';
import { CoreStrategySelectionRepository } from './core-strategy-selection.repository';

function fakePrisma() {
  return {
    coreStrategy: { findMany: jest.fn().mockResolvedValue([]), findUnique: jest.fn().mockResolvedValue(null) },
    coreStrategyVersion: {
      findUnique: jest.fn().mockResolvedValue(null),
      aggregate: jest.fn(),
      create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'v_new', ...data })),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    coreStrategySelection: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockImplementation(({ create }) => Promise.resolve({ id: 'sel_1', ...create })),
    },
  };
}

describe('CoreStrategyRepository', () => {
  it('lists strategies with only the asked-for version statuses, newest version first', async () => {
    const prisma = fakePrisma();
    const repo = new CoreStrategyRepository(prisma as unknown as PrismaService);
    await repo.listWithVersions(['PAPER']);
    expect(prisma.coreStrategy.findMany).toHaveBeenCalledWith({
      orderBy: { name: 'asc' },
      include: { versions: { where: { status: { in: ['PAPER'] } }, orderBy: { version: 'desc' } } },
    });
    await repo.listWithVersions();
    expect(prisma.coreStrategy.findMany).toHaveBeenLastCalledWith({
      orderBy: { name: 'asc' },
      include: { versions: { where: undefined, orderBy: { version: 'desc' } } },
    });
  });

  it('numbers the next version from the highest one, starting at 1', async () => {
    const prisma = fakePrisma();
    const repo = new CoreStrategyRepository(prisma as unknown as PrismaService);
    prisma.coreStrategyVersion.aggregate.mockResolvedValueOnce({ _max: { version: null } });
    expect(await repo.nextVersionNumber('s1')).toBe(1);
    prisma.coreStrategyVersion.aggregate.mockResolvedValueOnce({ _max: { version: 3 } });
    expect(await repo.nextVersionNumber('s1')).toBe(4);
    expect(prisma.coreStrategyVersion.aggregate).toHaveBeenCalledWith({ where: { strategyId: 's1' }, _max: { version: true } });
  });

  it('creates every version as a DRAFT', async () => {
    const prisma = fakePrisma();
    const repo = new CoreStrategyRepository(prisma as unknown as PrismaService);
    await repo.createVersion({ strategyId: 's1', version: 2, blocks: {}, createdBy: 'AI', notes: null });
    expect(prisma.coreStrategyVersion.create).toHaveBeenCalledWith({
      data: { strategyId: 's1', version: 2, blocks: {}, createdBy: 'AI', notes: null, status: 'DRAFT' },
    });
  });

  it('updates a version only while it is still a DRAFT, and says when it was not', async () => {
    const prisma = fakePrisma();
    const repo = new CoreStrategyRepository(prisma as unknown as PrismaService);
    expect(await repo.updateDraft('v1', { blocks: { a: 1 }, notes: 'n' })).toBe(true);
    expect(prisma.coreStrategyVersion.updateMany).toHaveBeenCalledWith({ where: { id: 'v1', status: 'DRAFT' }, data: { blocks: { a: 1 }, notes: 'n' } });
    prisma.coreStrategyVersion.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await repo.updateDraft('v1', { blocks: {}, notes: null })).toBe(false);
  });

  it('moves status only from the status the caller read (no lost update)', async () => {
    const prisma = fakePrisma();
    const repo = new CoreStrategyRepository(prisma as unknown as PrismaService);
    const at = new Date('2026-10-09T05:00:00Z');
    expect(await repo.transition('v1', 'DRAFT', { status: 'PAPER', approvedBy: 'usr_owner', approvedAt: at })).toBe(true);
    expect(prisma.coreStrategyVersion.updateMany).toHaveBeenCalledWith({
      where: { id: 'v1', status: 'DRAFT' }, data: { status: 'PAPER', approvedBy: 'usr_owner', approvedAt: at },
    });
  });

  it('finds a version together with its strategy', async () => {
    const prisma = fakePrisma();
    const repo = new CoreStrategyRepository(prisma as unknown as PrismaService);
    await repo.findVersion('v1');
    expect(prisma.coreStrategyVersion.findUnique).toHaveBeenCalledWith({ where: { id: 'v1' }, include: { strategy: true } });
  });
});

describe('CoreStrategySelectionRepository', () => {
  it("selection queries always carry the caller's userId, and an update can never move a row to another user", async () => {
    const prisma = fakePrisma();
    const repo = new CoreStrategySelectionRepository(prisma as unknown as PrismaService);
    await repo.listForUser('user_A');
    expect(prisma.coreStrategySelection.findMany).toHaveBeenCalledWith({ where: { userId: 'user_A' }, orderBy: { createdAt: 'asc' } });
    await repo.findForUser('user_A', 's1');
    expect(prisma.coreStrategySelection.findUnique).toHaveBeenCalledWith({ where: { userId_strategyId: { userId: 'user_A', strategyId: 's1' } } });
    await repo.upsert('user_A', 's1', { strategyVersionId: 'v1', enabled: true, capitalAllocation: 100000 });
    expect(prisma.coreStrategySelection.upsert).toHaveBeenCalledWith({
      where: { userId_strategyId: { userId: 'user_A', strategyId: 's1' } },
      create: { userId: 'user_A', strategyId: 's1', strategyVersionId: 'v1', enabled: true, capitalAllocation: 100000 },
      update: { strategyVersionId: 'v1', enabled: true, capitalAllocation: 100000 },
    });
  });

  it('CoreStrategySelection is a tenant model; the global catalogue is not', () => {
    expect(TENANT_MODELS.has('CoreStrategySelection')).toBe(true);
    expect(TENANT_MODELS.has('CoreStrategy')).toBe(false);
    expect(TENANT_MODELS.has('CoreStrategyVersion')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @td/api test -- core-strategy.repository`
Expected: FAIL with "Cannot find module './core-strategy.repository'".

- [ ] **Step 3: Write the repositories**

Create `apps/api/src/modules/trade-core/strategies/repositories/core-strategy.repository.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import type { CoreStrategy, CoreStrategyVersion, Prisma } from '@prisma/client';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import type { VersionCreator, VersionStatus } from '../version-status';

export type StrategyWithVersions = CoreStrategy & { versions: CoreStrategyVersion[] };
export type VersionWithStrategy = CoreStrategyVersion & { strategy: CoreStrategy };

export interface NewVersion {
  strategyId: string;
  version: number;
  blocks: Prisma.InputJsonValue;
  createdBy: VersionCreator;
  notes: string | null;
}

/**
 * The global, owner-curated catalogue (plan decision 1). Versions change only
 * through `updateDraft` (DRAFT rows) and `transition` (compare-and-set on the
 * status the caller read); the database trigger refuses anything else.
 */
@Injectable()
export class CoreStrategyRepository {
  constructor(private readonly prisma: PrismaService) {}

  listWithVersions(statuses?: readonly VersionStatus[]): Promise<StrategyWithVersions[]> {
    return this.prisma.coreStrategy.findMany({
      orderBy: { name: 'asc' },
      include: {
        versions: {
          where: statuses ? { status: { in: [...statuses] } } : undefined,
          orderBy: { version: 'desc' },
        },
      },
    });
  }

  findStrategy(id: string): Promise<CoreStrategy | null> {
    return this.prisma.coreStrategy.findUnique({ where: { id } });
  }

  findVersion(id: string): Promise<VersionWithStrategy | null> {
    return this.prisma.coreStrategyVersion.findUnique({ where: { id }, include: { strategy: true } });
  }

  async nextVersionNumber(strategyId: string): Promise<number> {
    const agg = await this.prisma.coreStrategyVersion.aggregate({ where: { strategyId }, _max: { version: true } });
    return (agg._max.version ?? 0) + 1;
  }

  createVersion(data: NewVersion): Promise<CoreStrategyVersion> {
    return this.prisma.coreStrategyVersion.create({ data: { ...data, status: 'DRAFT' } });
  }

  async updateDraft(id: string, data: { blocks: Prisma.InputJsonValue; notes: string | null }): Promise<boolean> {
    const r = await this.prisma.coreStrategyVersion.updateMany({ where: { id, status: 'DRAFT' }, data });
    return r.count === 1;
  }

  async transition(
    id: string,
    from: VersionStatus,
    data: { status: VersionStatus; approvedBy?: string; approvedAt?: Date },
  ): Promise<boolean> {
    const r = await this.prisma.coreStrategyVersion.updateMany({ where: { id, status: from }, data });
    return r.count === 1;
  }
}
```

Create `apps/api/src/modules/trade-core/strategies/repositories/core-strategy-selection.repository.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import type { CoreStrategySelection } from '@prisma/client';
import { PrismaService } from '../../../../common/prisma/prisma.service';

export interface SelectionWrite {
  strategyVersionId: string;
  enabled: boolean;
  capitalAllocation: number;
}

/**
 * Per-user selections (spec §4.2, one row per user per strategy). Every query
 * names the caller's userId explicitly; the Prisma tenant extension adds the same
 * filter again for non-admin requests (TENANT_MODELS). `update` never carries
 * userId or strategyId, so a row cannot move to another user or strategy.
 */
@Injectable()
export class CoreStrategySelectionRepository {
  constructor(private readonly prisma: PrismaService) {}

  listForUser(userId: string): Promise<CoreStrategySelection[]> {
    return this.prisma.coreStrategySelection.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
  }

  findForUser(userId: string, strategyId: string): Promise<CoreStrategySelection | null> {
    return this.prisma.coreStrategySelection.findUnique({ where: { userId_strategyId: { userId, strategyId } } });
  }

  upsert(userId: string, strategyId: string, data: SelectionWrite): Promise<CoreStrategySelection> {
    return this.prisma.coreStrategySelection.upsert({
      where: { userId_strategyId: { userId, strategyId } },
      create: { userId, strategyId, ...data },
      update: { ...data },
    });
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @td/api test -- core-strategy.repository`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/trade-core/strategies/repositories/core-strategy.repository.ts apps/api/src/modules/trade-core/strategies/repositories/core-strategy-selection.repository.ts apps/api/src/modules/trade-core/strategies/repositories/core-strategy.repository.spec.ts
git commit -m "feat(trade-core): catalogue and per-user selection repositories" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/api/src/modules/trade-core/strategies/repositories/core-strategy.repository.ts apps/api/src/modules/trade-core/strategies/repositories/core-strategy-selection.repository.ts apps/api/src/modules/trade-core/strategies/repositories/core-strategy.repository.spec.ts
```

---

### Task 5: Catalogue service (list, draft, edit-or-n+1, approve, status) with audit

**Files:**
- Modify: `apps/api/src/common/audit/audit-actions.ts` (add the `strategy` group)
- Create: `apps/api/src/modules/trade-core/strategies/dto/core-strategy.dto.ts`
- Create: `apps/api/src/modules/trade-core/strategies/services/core-strategy-catalogue.service.ts`
- Test: `apps/api/src/modules/trade-core/strategies/services/core-strategy-catalogue.service.spec.ts`

**Interfaces:**
- Consumes: `CoreStrategyRepository`, `VersionWithStrategy` (Task 4); `validateBlocks`,
  `formatBlockErrors` (Task 1); `checkTransition`, `isEditable`, `SELECTABLE_STATUSES`,
  `VERSION_STATUSES`, `VersionStatus`, `VersionCreator` (Task 2); `AuditService.append(event)`
  (`common/audit/audit.service.ts`, global `AuditModule`).
- Produces:

```typescript
// audit-actions.ts
AUDIT_ACTIONS.strategy = {
  CORE_STRATEGY_VERSION_APPROVED, CORE_STRATEGY_VERSION_STATUS_CHANGED, CORE_STRATEGY_SELECTION_CHANGED,
}

// dto/core-strategy.dto.ts
export class CreateDraftDto { blocks: Record<string, unknown>; notes?: string | null }
export class EditVersionDto { blocks?: Record<string, unknown>; notes?: string | null }
export class SetVersionStatusDto { status: VersionStatus }
export class SetSelectionDto { strategyVersionId: string; enabled: boolean; capitalAllocation: number }
export interface CoreStrategyVersionDto { id; strategyId; version; status: VersionStatus; blocks: unknown; createdBy: VersionCreator; approvedBy: string | null; approvedAt: string | null; sourceDocId: string | null; notes: string | null; createdAt: string }
export interface CoreStrategyDto { id; key; name; description; allowedVehicles: string[]; createdAt: string; versions: CoreStrategyVersionDto[] }
export interface CoreSelectionDto { id; strategyId; strategyVersionId; enabled: boolean; capitalAllocation: number; updatedAt: string }
export function toVersionDto(v: CoreStrategyVersion): CoreStrategyVersionDto;
export function toStrategyDto(s: CoreStrategy & { versions: CoreStrategyVersion[] }): CoreStrategyDto;
export function toSelectionDto(s: CoreStrategySelection): CoreSelectionDto;

// services/core-strategy-catalogue.service.ts
export interface Actor { userId: string; role: string }
export interface DraftInput { blocks: unknown; notes: string | null }
export interface EditVersionResult { version: CoreStrategyVersionDto; created: boolean }
class CoreStrategyCatalogueService {
  list(actor: Actor): Promise<CoreStrategyDto[]>;                       // non-ADMIN: PAPER versions only
  createDraft(strategyId: string, input: DraftInput, createdBy?: VersionCreator): Promise<CoreStrategyVersionDto>;  // default OWNER
  editVersion(versionId: string, patch: { blocks?: unknown; notes?: string | null }): Promise<EditVersionResult>;
  approve(versionId: string, actor: Actor): Promise<CoreStrategyVersionDto>;            // DRAFT → PAPER
  setStatus(versionId: string, to: VersionStatus, actor: Actor): Promise<CoreStrategyVersionDto>;
}
// Errors: NotFoundException 404, UnprocessableEntityException 422 (invalid blocks),
// ConflictException 409 (refused transition, LIVE, lost race), ForbiddenException 403 (non-owner).
```

- [ ] **Step 1: Add the audit actions**

In `apps/api/src/common/audit/audit-actions.ts`, add this group after the `billing` group (inside
`AUDIT_ACTIONS`, before `} as const;`):

```typescript
  strategy: {
    CORE_STRATEGY_VERSION_APPROVED: 'CORE_STRATEGY_VERSION_APPROVED',
    CORE_STRATEGY_VERSION_STATUS_CHANGED: 'CORE_STRATEGY_VERSION_STATUS_CHANGED',
    CORE_STRATEGY_SELECTION_CHANGED: 'CORE_STRATEGY_SELECTION_CHANGED',
  },
```

- [ ] **Step 2: Write the failing test**

Create `apps/api/src/modules/trade-core/strategies/services/core-strategy-catalogue.service.spec.ts`:

```typescript
import { ConflictException, ForbiddenException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma, type CoreStrategy } from '@prisma/client';
import type { AuditService } from '../../../../common/audit/audit.service';
import type { CoreStrategyRepository, VersionWithStrategy } from '../repositories/core-strategy.repository';
import { adaptiveBlocks, plainBlocks } from '../testing/block-fixtures';
import { CoreStrategyCatalogueService, type Actor } from './core-strategy-catalogue.service';

const OWNER: Actor = { userId: 'usr_owner', role: 'ADMIN' };
const USER: Actor = { userId: 'usr_a', role: 'USER' };
const T0 = new Date('2026-10-09T04:00:00.000Z');

function strategy(over: Partial<CoreStrategy> = {}): CoreStrategy {
  return { id: 's1', key: 'ungated', name: 'Ungated', description: 'd', allowedVehicles: ['CASH_INTRADAY'], createdAt: T0, ...over };
}

function version(over: Partial<VersionWithStrategy> = {}): VersionWithStrategy {
  return {
    id: 'v1', strategyId: 's1', version: 1, blocks: plainBlocks() as unknown as Prisma.JsonValue, status: 'DRAFT',
    createdBy: 'OWNER', approvedBy: null, approvedAt: null, sourceDocId: null, notes: null,
    createdAt: T0, updatedAt: T0, strategy: strategy(), ...over,
  };
}

function setup() {
  const repo = {
    listWithVersions: jest.fn().mockResolvedValue([]),
    findStrategy: jest.fn().mockResolvedValue(strategy()),
    findVersion: jest.fn().mockResolvedValue(version()),
    nextVersionNumber: jest.fn().mockResolvedValue(2),
    createVersion: jest.fn().mockImplementation((d) => Promise.resolve({ ...version(), ...d, id: 'v_new', status: 'DRAFT', strategy: undefined })),
    updateDraft: jest.fn().mockResolvedValue(true),
    transition: jest.fn().mockResolvedValue(true),
  };
  const audit = { append: jest.fn().mockResolvedValue({ seq: 1n, hash: 'h' }) };
  const service = new CoreStrategyCatalogueService(repo as unknown as CoreStrategyRepository, audit as unknown as AuditService);
  return { repo, audit, service };
}

describe('CoreStrategyCatalogueService.list', () => {
  it('shows a user only approved (PAPER) versions and the owner every version', async () => {
    const { repo, service } = setup();
    repo.listWithVersions.mockResolvedValue([{ ...strategy(), versions: [version({ status: 'PAPER', approvedAt: T0, approvedBy: 'usr_owner' })] }]);
    const out = await service.list(USER);
    expect(repo.listWithVersions).toHaveBeenCalledWith(['PAPER']);
    expect(out[0].versions[0]).toMatchObject({ id: 'v1', status: 'PAPER', approvedAt: T0.toISOString(), createdAt: T0.toISOString() });
    await service.list(OWNER);
    expect(repo.listWithVersions).toHaveBeenLastCalledWith(undefined);
  });
});

describe('CoreStrategyCatalogueService.createDraft', () => {
  it('creates the next version number as an OWNER draft', async () => {
    const { repo, service } = setup();
    const out = await service.createDraft('s1', { blocks: plainBlocks(), notes: 'try 2' });
    expect(repo.createVersion).toHaveBeenCalledWith({ strategyId: 's1', version: 2, blocks: plainBlocks(), createdBy: 'OWNER', notes: 'try 2' });
    expect(out).toMatchObject({ id: 'v_new', version: 2, status: 'DRAFT', createdBy: 'OWNER' });
  });

  it('createDraft is OWNER unless the caller says AI', async () => {
    const { repo, service } = setup();
    await service.createDraft('s1', { blocks: plainBlocks(), notes: null }, 'AI');
    expect(repo.createVersion).toHaveBeenCalledWith(expect.objectContaining({ createdBy: 'AI' }));
  });

  it('refuses an unknown strategy (404) and invalid blocks (422, naming the path), writing nothing', async () => {
    const { repo, service } = setup();
    repo.findStrategy.mockResolvedValueOnce(null);
    await expect(service.createDraft('nope', { blocks: plainBlocks(), notes: null })).rejects.toBeInstanceOf(NotFoundException);
    const bad = { ...plainBlocks(), stop: { kind: 'fixedPct', pct: -1 } };
    await expect(service.createDraft('s1', { blocks: bad, notes: null })).rejects.toThrow(/stop\.pct/);
    await expect(service.createDraft('s1', { blocks: bad, notes: null })).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(service.createDraft('s1', { blocks: adaptiveBlocks(), notes: null })).resolves.toBeDefined();
    repo.findStrategy.mockResolvedValueOnce(strategy({ allowedVehicles: ['MTF'] }));
    await expect(service.createDraft('s1', { blocks: plainBlocks(), notes: null })).rejects.toThrow(/vehicle\.kind/);
    expect(repo.createVersion).toHaveBeenCalledTimes(1);
  });

  it('reports a concurrent create of the same version number as 409', async () => {
    const { repo, service } = setup();
    repo.createVersion.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test' }));
    await expect(service.createDraft('s1', { blocks: plainBlocks(), notes: null })).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('CoreStrategyCatalogueService.editVersion', () => {
  it('edits a DRAFT in place and keeps unspecified fields', async () => {
    const { repo, service } = setup();
    repo.findVersion.mockResolvedValueOnce(version({ notes: 'keep' })).mockResolvedValueOnce(version({ notes: 'keep', blocks: adaptiveBlocks() as unknown as Prisma.JsonValue }));
    const out = await service.editVersion('v1', { blocks: adaptiveBlocks() });
    expect(repo.updateDraft).toHaveBeenCalledWith('v1', { blocks: adaptiveBlocks(), notes: 'keep' });
    expect(repo.createVersion).not.toHaveBeenCalled();
    expect(out.created).toBe(false);
  });

  it('editing a PAPER version creates version n+1 and never touches the original', async () => {
    const { repo, service } = setup();
    repo.findVersion.mockResolvedValueOnce(version({ status: 'PAPER', notes: 'v1 notes' }));
    const out = await service.editVersion('v1', { notes: 'v2 notes' });
    expect(repo.updateDraft).not.toHaveBeenCalled();
    expect(repo.transition).not.toHaveBeenCalled();
    expect(repo.createVersion).toHaveBeenCalledWith({ strategyId: 's1', version: 2, blocks: plainBlocks(), createdBy: 'OWNER', notes: 'v2 notes' });
    expect(out).toMatchObject({ created: true, version: { id: 'v_new', version: 2, status: 'DRAFT' } });
  });

  it('a draft approved while it was being edited becomes n+1, not an overwrite', async () => {
    const { repo, service } = setup();
    repo.updateDraft.mockResolvedValueOnce(false);
    const out = await service.editVersion('v1', { notes: 'late edit' });
    expect(repo.createVersion).toHaveBeenCalledWith(expect.objectContaining({ version: 2, notes: 'late edit' }));
    expect(out.created).toBe(true);
  });

  it('refuses invalid merged blocks with 422 and writes nothing; 404 for an unknown version', async () => {
    const { repo, service } = setup();
    await expect(service.editVersion('v1', { blocks: { entry: {} } })).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(repo.updateDraft).not.toHaveBeenCalled();
    repo.findVersion.mockResolvedValueOnce(null);
    await expect(service.editVersion('nope', { notes: 'x' })).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('CoreStrategyCatalogueService.approve / setStatus', () => {
  it('approves a DRAFT into PAPER, stamps the approver, and audits it', async () => {
    const { repo, audit, service } = setup();
    const out = await service.approve('v1', OWNER);
    expect(repo.transition).toHaveBeenCalledWith('v1', 'DRAFT', { status: 'PAPER', approvedBy: 'usr_owner', approvedAt: expect.any(Date) });
    expect(audit.append).toHaveBeenCalledWith({
      action: 'CORE_STRATEGY_VERSION_APPROVED',
      userId: 'usr_owner',
      target: 'core_strategy_version:v1',
      meta: { strategyKey: 'ungated', version: 1, from: 'DRAFT', to: 'PAPER' },
    });
    expect(out).toMatchObject({ status: 'PAPER', approvedBy: 'usr_owner' });
  });

  it('a non-ADMIN actor cannot approve or change status, and nothing is written', async () => {
    const { repo, audit, service } = setup();
    await expect(service.approve('v1', USER)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.setStatus('v1', 'RETIRED', USER)).rejects.toBeInstanceOf(ForbiddenException);
    expect(repo.findVersion).not.toHaveBeenCalled();
    expect(repo.transition).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
  });

  it('refuses LIVE with 409 and writes nothing', async () => {
    const { repo, audit, service } = setup();
    repo.findVersion.mockResolvedValue(version({ status: 'PAPER' }));
    await expect(service.setStatus('v1', 'LIVE', OWNER)).rejects.toThrow(/LIVE is reserved until SP7/);
    await expect(service.setStatus('v1', 'LIVE', OWNER)).rejects.toBeInstanceOf(ConflictException);
    expect(repo.transition).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
  });

  it('refuses approving an already-approved version (409, no audit)', async () => {
    const { repo, audit, service } = setup();
    repo.findVersion.mockResolvedValue(version({ status: 'PAPER' }));
    await expect(service.approve('v1', OWNER)).rejects.toBeInstanceOf(ConflictException);
    expect(audit.append).not.toHaveBeenCalled();
  });

  it('approval re-validates stored blocks and writes nothing when they fail', async () => {
    const { repo, audit, service } = setup();
    repo.findVersion.mockResolvedValue(version({ blocks: { entry: {} } as unknown as Prisma.JsonValue }));
    await expect(service.approve('v1', OWNER)).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(repo.transition).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
  });

  it('a lost race (the row moved since it was read) is 409 and not audited', async () => {
    const { repo, audit, service } = setup();
    repo.transition.mockResolvedValueOnce(false);
    await expect(service.approve('v1', OWNER)).rejects.toBeInstanceOf(ConflictException);
    expect(audit.append).not.toHaveBeenCalled();
  });

  it('retires a PAPER version and audits a status change', async () => {
    const { repo, audit, service } = setup();
    repo.findVersion.mockResolvedValue(version({ status: 'PAPER' }));
    await service.setStatus('v1', 'RETIRED', OWNER);
    expect(repo.transition).toHaveBeenCalledWith('v1', 'PAPER', { status: 'RETIRED' });
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({
      action: 'CORE_STRATEGY_VERSION_STATUS_CHANGED', meta: { strategyKey: 'ungated', version: 1, from: 'PAPER', to: 'RETIRED' },
    }));
  });

  it('setStatus PAPER on a draft is an approval', async () => {
    const { audit, service } = setup();
    await service.setStatus('v1', 'PAPER', OWNER);
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({ action: 'CORE_STRATEGY_VERSION_APPROVED' }));
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @td/api test -- core-strategy-catalogue.service`
Expected: FAIL with "Cannot find module './core-strategy-catalogue.service'".

- [ ] **Step 4: Write the DTOs and the service**

Create `apps/api/src/modules/trade-core/strategies/dto/core-strategy.dto.ts`:

```typescript
import type { CoreStrategy, CoreStrategySelection, CoreStrategyVersion } from '@prisma/client';
import { IsBoolean, IsIn, IsNumber, IsObject, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { VERSION_STATUSES, type VersionCreator, type VersionStatus } from '../version-status';

/**
 * Request bodies. None carries createdBy, status (except SetVersionStatusDto) or
 * userId: the global ValidationPipe({ whitelist: true }) strips anything else.
 * `blocks` is checked by validateBlocks in the service (plan decision 2).
 */
export class CreateDraftDto {
  @IsObject()
  blocks!: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  notes?: string | null;
}

export class EditVersionDto {
  @IsOptional()
  @IsObject()
  blocks?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  notes?: string | null;
}

export class SetVersionStatusDto {
  @IsIn([...VERSION_STATUSES])
  status!: VersionStatus;
}

export class SetSelectionDto {
  @IsString()
  @MaxLength(64)
  strategyVersionId!: string;

  @IsBoolean()
  enabled!: boolean;

  /** Rupees. Capped against funds by the Risk Wall (M2/M3), not here. */
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  capitalAllocation!: number;
}

/** Wire shapes. Dates are ISO strings; nullable columns are `null`, never undefined. */
export interface CoreStrategyVersionDto {
  id: string;
  strategyId: string;
  version: number;
  status: VersionStatus;
  blocks: unknown;
  createdBy: VersionCreator;
  approvedBy: string | null;
  approvedAt: string | null;
  sourceDocId: string | null;
  notes: string | null;
  createdAt: string;
}

export interface CoreStrategyDto {
  id: string;
  key: string;
  name: string;
  description: string;
  allowedVehicles: string[];
  createdAt: string;
  versions: CoreStrategyVersionDto[];
}

export interface CoreSelectionDto {
  id: string;
  strategyId: string;
  strategyVersionId: string;
  enabled: boolean;
  capitalAllocation: number;
  updatedAt: string;
}

export function toVersionDto(v: CoreStrategyVersion): CoreStrategyVersionDto {
  return {
    id: v.id,
    strategyId: v.strategyId,
    version: v.version,
    status: v.status as VersionStatus,
    blocks: v.blocks,
    createdBy: v.createdBy as VersionCreator,
    approvedBy: v.approvedBy ?? null,
    approvedAt: v.approvedAt ? v.approvedAt.toISOString() : null,
    sourceDocId: v.sourceDocId ?? null,
    notes: v.notes ?? null,
    createdAt: v.createdAt.toISOString(),
  };
}

export function toStrategyDto(s: CoreStrategy & { versions: CoreStrategyVersion[] }): CoreStrategyDto {
  return {
    id: s.id,
    key: s.key,
    name: s.name,
    description: s.description,
    allowedVehicles: [...s.allowedVehicles],
    createdAt: s.createdAt.toISOString(),
    versions: s.versions.map(toVersionDto),
  };
}

export function toSelectionDto(s: CoreStrategySelection): CoreSelectionDto {
  return {
    id: s.id,
    strategyId: s.strategyId,
    strategyVersionId: s.strategyVersionId,
    enabled: s.enabled,
    capitalAllocation: s.capitalAllocation,
    updatedAt: s.updatedAt.toISOString(),
  };
}
```

Create `apps/api/src/modules/trade-core/strategies/services/core-strategy-catalogue.service.ts`:

```typescript
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../../../../common/audit/audit.service';
import { AUDIT_ACTIONS } from '../../../../common/audit/audit-actions';
import { formatBlockErrors, validateBlocks } from '../blocks/validate-blocks';
import { checkTransition, isEditable, SELECTABLE_STATUSES, type VersionCreator, type VersionStatus } from '../version-status';
import { CoreStrategyRepository } from '../repositories/core-strategy.repository';
import { toStrategyDto, toVersionDto, type CoreStrategyDto, type CoreStrategyVersionDto } from '../dto/core-strategy.dto';

export interface Actor {
  userId: string;
  role: string;
}

export interface DraftInput {
  blocks: unknown;
  notes: string | null;
}

export interface EditVersionResult {
  version: CoreStrategyVersionDto;
  /** true when the edit had to become version n+1 (the target was not a draft). */
  created: boolean;
}

const isUniqueViolation = (err: unknown): boolean =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

function assertValidBlocks(blocks: unknown, allowedVehicles: readonly string[]): void {
  const errors = validateBlocks(blocks, { allowedVehicles });
  if (errors.length > 0) throw new UnprocessableEntityException(`blocks are invalid: ${formatBlockErrors(errors)}`);
}

/**
 * The strategy catalogue (spec §4.2–4.3). Versions are immutable once they leave
 * DRAFT; only the owner (ADMIN) changes a version's mode; LIVE is refused in SP2.
 */
@Injectable()
export class CoreStrategyCatalogueService {
  constructor(
    private readonly repo: CoreStrategyRepository,
    private readonly audit: AuditService,
  ) {}

  async list(actor: Actor): Promise<CoreStrategyDto[]> {
    const rows = await this.repo.listWithVersions(actor.role === 'ADMIN' ? undefined : SELECTABLE_STATUSES);
    return rows.map(toStrategyDto);
  }

  async createDraft(strategyId: string, input: DraftInput, createdBy: VersionCreator = 'OWNER'): Promise<CoreStrategyVersionDto> {
    const strategy = await this.repo.findStrategy(strategyId);
    if (!strategy) throw new NotFoundException(`strategy ${strategyId} not found`);
    assertValidBlocks(input.blocks, strategy.allowedVehicles);
    const version = await this.repo.nextVersionNumber(strategyId);
    try {
      const row = await this.repo.createVersion({
        strategyId,
        version,
        blocks: input.blocks as Prisma.InputJsonValue,
        createdBy,
        notes: input.notes,
      });
      return toVersionDto(row);
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictException(`${strategy.key} v${version} was created at the same time; retry`);
      throw err;
    }
  }

  async editVersion(versionId: string, patch: { blocks?: unknown; notes?: string | null }): Promise<EditVersionResult> {
    const current = await this.repo.findVersion(versionId);
    if (!current) throw new NotFoundException(`strategy version ${versionId} not found`);
    const blocks = patch.blocks !== undefined ? patch.blocks : current.blocks;
    const notes = patch.notes !== undefined ? patch.notes : current.notes;
    assertValidBlocks(blocks, current.strategy.allowedVehicles);

    if (isEditable(current.status)) {
      const updated = await this.repo.updateDraft(versionId, { blocks: blocks as Prisma.InputJsonValue, notes });
      if (updated) {
        const fresh = await this.repo.findVersion(versionId);
        if (!fresh) throw new NotFoundException(`strategy version ${versionId} not found`);
        return { version: toVersionDto(fresh), created: false };
      }
    }
    // Not a draft (or approved while this edit was in flight): immutable, so the
    // edit becomes the next version, a new DRAFT (plan decision 9).
    const created = await this.createDraft(current.strategyId, { blocks, notes }, 'OWNER');
    return { version: created, created: true };
  }

  approve(versionId: string, actor: Actor): Promise<CoreStrategyVersionDto> {
    return this.moveTo(versionId, 'PAPER', actor);
  }

  setStatus(versionId: string, to: VersionStatus, actor: Actor): Promise<CoreStrategyVersionDto> {
    return this.moveTo(versionId, to, actor);
  }

  private async moveTo(versionId: string, to: VersionStatus, actor: Actor): Promise<CoreStrategyVersionDto> {
    if (actor.role !== 'ADMIN') throw new ForbiddenException('only the owner changes a strategy version mode');
    const current = await this.repo.findVersion(versionId);
    if (!current) throw new NotFoundException(`strategy version ${versionId} not found`);
    const from = current.status as VersionStatus;
    const verdict = checkTransition(from, to);
    if (!verdict.ok) throw new ConflictException(verdict.reason);

    const approving = from === 'DRAFT' && to === 'PAPER';
    if (approving) assertValidBlocks(current.blocks, current.strategy.allowedVehicles);
    const data = approving ? { status: to, approvedBy: actor.userId, approvedAt: new Date() } : { status: to };

    const moved = await this.repo.transition(versionId, from, data);
    if (!moved) throw new ConflictException(`strategy version ${versionId} changed while updating; reload and retry`);

    await this.audit.append({
      action: approving
        ? AUDIT_ACTIONS.strategy.CORE_STRATEGY_VERSION_APPROVED
        : AUDIT_ACTIONS.strategy.CORE_STRATEGY_VERSION_STATUS_CHANGED,
      userId: actor.userId,
      target: `core_strategy_version:${versionId}`,
      meta: { strategyKey: current.strategy.key, version: current.version, from, to },
    });
    return toVersionDto({ ...current, ...data });
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @td/api test -- core-strategy-catalogue.service`
Expected: PASS (17 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/common/audit/audit-actions.ts apps/api/src/modules/trade-core/strategies/dto/core-strategy.dto.ts apps/api/src/modules/trade-core/strategies/services/core-strategy-catalogue.service.ts apps/api/src/modules/trade-core/strategies/services/core-strategy-catalogue.service.spec.ts
git commit -m "feat(trade-core): strategy catalogue service: drafts, edit-or-n+1, owner approval, audited" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/api/src/common/audit/audit-actions.ts apps/api/src/modules/trade-core/strategies/dto/core-strategy.dto.ts apps/api/src/modules/trade-core/strategies/services/core-strategy-catalogue.service.ts apps/api/src/modules/trade-core/strategies/services/core-strategy-catalogue.service.spec.ts
```

---

### Task 6: Selection service (per user: version, enabled, capital)

**Files:**
- Create: `apps/api/src/modules/trade-core/strategies/services/core-strategy-selection.service.ts`
- Test: `apps/api/src/modules/trade-core/strategies/services/core-strategy-selection.service.spec.ts`

**Interfaces:**
- Consumes: `CoreStrategySelectionRepository`, `CoreStrategyRepository.findVersion` (Task 4);
  `isSelectable` (Task 2); `toSelectionDto`, `CoreSelectionDto` (Task 5); `AUDIT_ACTIONS.strategy`
  (Task 5); `AuditService.append`.
- Produces:

```typescript
export interface SelectionInput { strategyVersionId: string; enabled: boolean; capitalAllocation: number }
class CoreStrategySelectionService {
  list(userId: string): Promise<CoreSelectionDto[]>;
  set(userId: string, strategyId: string, input: SelectionInput): Promise<CoreSelectionDto>;
}
// Errors: 404 (version unknown or not of this strategy), 409 (version not selectable),
// 422 (capital not finite / negative, or enabled with capital 0).
```

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/modules/trade-core/strategies/services/core-strategy-selection.service.spec.ts`:

```typescript
import { ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { CoreStrategySelection, Prisma } from '@prisma/client';
import type { AuditService } from '../../../../common/audit/audit.service';
import type { CoreStrategyRepository, VersionWithStrategy } from '../repositories/core-strategy.repository';
import type { CoreStrategySelectionRepository } from '../repositories/core-strategy-selection.repository';
import { plainBlocks } from '../testing/block-fixtures';
import { CoreStrategySelectionService } from './core-strategy-selection.service';

const T0 = new Date('2026-10-09T04:00:00.000Z');

function version(over: Partial<VersionWithStrategy> = {}): VersionWithStrategy {
  return {
    id: 'v1', strategyId: 's1', version: 1, blocks: plainBlocks() as unknown as Prisma.JsonValue, status: 'PAPER',
    createdBy: 'OWNER', approvedBy: 'usr_owner', approvedAt: T0, sourceDocId: null, notes: null, createdAt: T0, updatedAt: T0,
    strategy: { id: 's1', key: 'ungated', name: 'Ungated', description: 'd', allowedVehicles: ['CASH_INTRADAY'], createdAt: T0 },
    ...over,
  };
}

function selection(over: Partial<CoreStrategySelection> = {}): CoreStrategySelection {
  return { id: 'sel_1', userId: 'user_A', strategyId: 's1', strategyVersionId: 'v1', enabled: true, capitalAllocation: 100000, createdAt: T0, updatedAt: T0, ...over };
}

function setup() {
  const selections = {
    listForUser: jest.fn().mockResolvedValue([selection()]),
    findForUser: jest.fn().mockResolvedValue(null),
    upsert: jest.fn().mockImplementation((userId, strategyId, data) => Promise.resolve(selection({ userId, strategyId, ...data }))),
  };
  const catalogue = { findVersion: jest.fn().mockResolvedValue(version()) };
  const audit = { append: jest.fn().mockResolvedValue({ seq: 1n, hash: 'h' }) };
  const service = new CoreStrategySelectionService(
    selections as unknown as CoreStrategySelectionRepository,
    catalogue as unknown as CoreStrategyRepository,
    audit as unknown as AuditService,
  );
  return { selections, catalogue, audit, service };
}

describe('CoreStrategySelectionService', () => {
  it("lists only the caller's selections, as wire DTOs", async () => {
    const { selections, service } = setup();
    expect(await service.list('user_A')).toEqual([
      { id: 'sel_1', strategyId: 's1', strategyVersionId: 'v1', enabled: true, capitalAllocation: 100000, updatedAt: T0.toISOString() },
    ]);
    expect(selections.listForUser).toHaveBeenCalledWith('user_A');
  });

  it('writes only the caller’s own selection, whatever the input carries, and audits before/after', async () => {
    const { selections, audit, service } = setup();
    selections.findForUser.mockResolvedValueOnce(selection({ enabled: false, capitalAllocation: 0 }));
    const smuggled = { strategyVersionId: 'v1', enabled: true, capitalAllocation: 250000, userId: 'user_B' } as never;
    const out = await service.set('user_A', 's1', smuggled);
    expect(selections.findForUser).toHaveBeenCalledWith('user_A', 's1');
    expect(selections.upsert).toHaveBeenCalledWith('user_A', 's1', { strategyVersionId: 'v1', enabled: true, capitalAllocation: 250000 });
    expect(out).toMatchObject({ strategyVersionId: 'v1', enabled: true, capitalAllocation: 250000 });
    expect(audit.append).toHaveBeenCalledWith({
      action: 'CORE_STRATEGY_SELECTION_CHANGED',
      userId: 'user_A',
      target: 'core_strategy_selection:sel_1',
      meta: {
        strategyKey: 'ungated',
        version: 1,
        before: { strategyVersionId: 'v1', enabled: false, capitalAllocation: 0 },
        after: { strategyVersionId: 'v1', enabled: true, capitalAllocation: 250000 },
      },
    });
  });

  it('refuses a version that does not exist or belongs to another strategy (404)', async () => {
    const { catalogue, selections, service } = setup();
    catalogue.findVersion.mockResolvedValueOnce(null);
    await expect(service.set('user_A', 's1', { strategyVersionId: 'nope', enabled: false, capitalAllocation: 0 })).rejects.toBeInstanceOf(NotFoundException);
    catalogue.findVersion.mockResolvedValueOnce(version({ strategyId: 's2' }));
    await expect(service.set('user_A', 's1', { strategyVersionId: 'v1', enabled: false, capitalAllocation: 0 })).rejects.toBeInstanceOf(NotFoundException);
    expect(selections.upsert).not.toHaveBeenCalled();
  });

  it('only a PAPER version can be selected', async () => {
    const { catalogue, selections, audit, service } = setup();
    for (const status of ['DRAFT', 'RETIRED', 'LIVE']) {
      catalogue.findVersion.mockResolvedValueOnce(version({ status }));
      await expect(service.set('user_A', 's1', { strategyVersionId: 'v1', enabled: true, capitalAllocation: 1000 })).rejects.toBeInstanceOf(ConflictException);
    }
    catalogue.findVersion.mockResolvedValueOnce(version({ status: 'DRAFT' }));
    await expect(service.set('user_A', 's1', { strategyVersionId: 'v1', enabled: false, capitalAllocation: 1000 })).rejects.toBeInstanceOf(ConflictException);
    expect(selections.upsert).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
  });

  it('a selection already on a retired version can be switched off', async () => {
    const { catalogue, selections, service } = setup();
    catalogue.findVersion.mockResolvedValueOnce(version({ status: 'RETIRED' }));
    selections.findForUser.mockResolvedValueOnce(selection({ strategyVersionId: 'v1', enabled: true }));
    await service.set('user_A', 's1', { strategyVersionId: 'v1', enabled: false, capitalAllocation: 100000 });
    expect(selections.upsert).toHaveBeenCalledWith('user_A', 's1', { strategyVersionId: 'v1', enabled: false, capitalAllocation: 100000 });
  });

  it('enabling needs a capital allocation above 0; any capital must be a finite number ≥ 0', async () => {
    const { selections, service } = setup();
    await expect(service.set('user_A', 's1', { strategyVersionId: 'v1', enabled: true, capitalAllocation: 0 })).rejects.toBeInstanceOf(UnprocessableEntityException);
    for (const bad of [-1, NaN, Infinity]) {
      await expect(service.set('user_A', 's1', { strategyVersionId: 'v1', enabled: false, capitalAllocation: bad })).rejects.toBeInstanceOf(UnprocessableEntityException);
    }
    await service.set('user_A', 's1', { strategyVersionId: 'v1', enabled: false, capitalAllocation: 0 });
    expect(selections.upsert).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @td/api test -- core-strategy-selection.service`
Expected: FAIL with "Cannot find module './core-strategy-selection.service'".

- [ ] **Step 3: Write the service**

Create `apps/api/src/modules/trade-core/strategies/services/core-strategy-selection.service.ts`:

```typescript
import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { CoreStrategySelection } from '@prisma/client';
import { AuditService } from '../../../../common/audit/audit.service';
import { AUDIT_ACTIONS } from '../../../../common/audit/audit-actions';
import { isSelectable } from '../version-status';
import { CoreStrategyRepository } from '../repositories/core-strategy.repository';
import { CoreStrategySelectionRepository } from '../repositories/core-strategy-selection.repository';
import { toSelectionDto, type CoreSelectionDto } from '../dto/core-strategy.dto';

export interface SelectionInput {
  strategyVersionId: string;
  enabled: boolean;
  capitalAllocation: number;
}

const snapshot = (s: CoreStrategySelection) => ({
  strategyVersionId: s.strategyVersionId,
  enabled: s.enabled,
  capitalAllocation: s.capitalAllocation,
});

/**
 * A user's dropdown choice per strategy (spec §4.3). The user is always the
 * caller (from the JWT); nothing in the input can name another user. Rules:
 * plan decision 11.
 */
@Injectable()
export class CoreStrategySelectionService {
  constructor(
    private readonly selections: CoreStrategySelectionRepository,
    private readonly catalogue: CoreStrategyRepository,
    private readonly audit: AuditService,
  ) {}

  async list(userId: string): Promise<CoreSelectionDto[]> {
    return (await this.selections.listForUser(userId)).map(toSelectionDto);
  }

  async set(userId: string, strategyId: string, input: SelectionInput): Promise<CoreSelectionDto> {
    const version = await this.catalogue.findVersion(input.strategyVersionId);
    if (!version || version.strategyId !== strategyId) {
      throw new NotFoundException(`version ${input.strategyVersionId} is not a version of strategy ${strategyId}`);
    }
    if (!Number.isFinite(input.capitalAllocation) || input.capitalAllocation < 0) {
      throw new UnprocessableEntityException('capitalAllocation must be a number of rupees, 0 or more');
    }

    const before = await this.selections.findForUser(userId, strategyId);
    const switchingOffSameVersion = !input.enabled && before?.strategyVersionId === version.id;
    if (!isSelectable(version.status) && !switchingOffSameVersion) {
      throw new ConflictException(
        `${version.strategy.name} v${version.version} is ${version.status}; only an approved (PAPER) version can be selected`,
      );
    }
    if (input.enabled && !(input.capitalAllocation > 0)) {
      throw new UnprocessableEntityException('an enabled strategy needs a capital allocation above ₹0');
    }

    const row = await this.selections.upsert(userId, strategyId, {
      strategyVersionId: version.id,
      enabled: input.enabled,
      capitalAllocation: input.capitalAllocation,
    });
    await this.audit.append({
      action: AUDIT_ACTIONS.strategy.CORE_STRATEGY_SELECTION_CHANGED,
      userId,
      target: `core_strategy_selection:${row.id}`,
      meta: {
        strategyKey: version.strategy.key,
        version: version.version,
        before: before ? snapshot(before) : null,
        after: snapshot(row),
      },
    });
    return toSelectionDto(row);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @td/api test -- core-strategy-selection.service`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/trade-core/strategies/services/core-strategy-selection.service.ts apps/api/src/modules/trade-core/strategies/services/core-strategy-selection.service.spec.ts
git commit -m "feat(trade-core): per-user strategy selections; only PAPER versions, enabled needs capital" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/api/src/modules/trade-core/strategies/services/core-strategy-selection.service.ts apps/api/src/modules/trade-core/strategies/services/core-strategy-selection.service.spec.ts
```

---

### Task 7: REST controller, `TradeCoreModule`, app wiring

**Files:**
- Create: `apps/api/src/modules/trade-core/strategies/controllers/core-strategies.controller.ts`
- Create: `apps/api/src/modules/trade-core/trade-core.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Test: `apps/api/src/modules/trade-core/strategies/controllers/core-strategies.controller.spec.ts`
- Test: `apps/api/src/modules/trade-core/trade-core.module.spec.ts`

**Interfaces:**
- Consumes: both services (Tasks 5–6), the DTO classes (Task 5), `AdminOnly`, `CurrentUser`,
  `AuthenticatedUser`, `ROLES_KEY` (`common/decorators`).
- Produces (all behind the global `JwtAuthGuard`; `RolesGuard` enforces `@AdminOnly()`):

| Method | Route | Who | Returns |
|---|---|---|---|
| GET | `/api/trade-core/strategies` | any user | `{ strategies: CoreStrategyDto[] }` (users: PAPER versions only) |
| POST | `/api/trade-core/strategies/:strategyId/versions` | owner | `CoreStrategyVersionDto` (201) |
| PATCH | `/api/trade-core/strategy-versions/:versionId` | owner | `EditVersionResult` |
| POST | `/api/trade-core/strategy-versions/:versionId/approve` | owner | `CoreStrategyVersionDto` (200) |
| POST | `/api/trade-core/strategy-versions/:versionId/status` | owner | `CoreStrategyVersionDto` (200) |
| GET | `/api/trade-core/strategy-selections` | any user | `{ selections: CoreSelectionDto[] }` (own) |
| PUT | `/api/trade-core/strategy-selections/:strategyId` | any user | `CoreSelectionDto` (own) |

```typescript
export class TradeCoreModule {}   // exports CoreStrategyCatalogueService, CoreStrategySelectionService (M5 reads selections)
```

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/modules/trade-core/strategies/controllers/core-strategies.controller.spec.ts`:

```typescript
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ROLES_KEY, type AuthenticatedUser } from '../../../../common/decorators';
import type { CoreStrategyCatalogueService } from '../services/core-strategy-catalogue.service';
import type { CoreStrategySelectionService } from '../services/core-strategy-selection.service';
import { CreateDraftDto, SetSelectionDto, SetVersionStatusDto } from '../dto/core-strategy.dto';
import { CoreStrategiesController } from './core-strategies.controller';

const OWNER: AuthenticatedUser = { userId: 'usr_owner', role: 'ADMIN', email: 'o@x' };
const USER_A: AuthenticatedUser = { userId: 'user_A', role: 'USER', email: 'a@x' };

function setup() {
  const catalogue = {
    list: jest.fn().mockResolvedValue([]),
    createDraft: jest.fn().mockResolvedValue({ id: 'v2' }),
    editVersion: jest.fn().mockResolvedValue({ version: { id: 'v1' }, created: false }),
    approve: jest.fn().mockResolvedValue({ id: 'v1', status: 'PAPER' }),
    setStatus: jest.fn().mockResolvedValue({ id: 'v1', status: 'RETIRED' }),
  };
  const selections = { list: jest.fn().mockResolvedValue([]), set: jest.fn().mockResolvedValue({ id: 'sel_1' }) };
  const controller = new CoreStrategiesController(
    catalogue as unknown as CoreStrategyCatalogueService,
    selections as unknown as CoreStrategySelectionService,
  );
  return { catalogue, selections, controller };
}

const rolesOf = (method: keyof CoreStrategiesController) =>
  Reflect.getMetadata(ROLES_KEY, CoreStrategiesController.prototype[method]) as string[] | undefined;

describe('CoreStrategiesController', () => {
  it('every catalogue write route is @AdminOnly; reads and selections are not', () => {
    for (const m of ['createDraft', 'edit', 'approve', 'setStatus'] as const) expect(rolesOf(m)).toEqual(['ADMIN']);
    for (const m of ['list', 'listSelections', 'setSelection'] as const) expect(rolesOf(m)).toBeUndefined();
  });

  it('passes the caller as the actor for listing and mode changes', async () => {
    const { catalogue, controller } = setup();
    await controller.list(USER_A);
    expect(catalogue.list).toHaveBeenCalledWith({ userId: 'user_A', role: 'USER' });
    await controller.approve(OWNER, 'v1');
    expect(catalogue.approve).toHaveBeenCalledWith('v1', { userId: 'usr_owner', role: 'ADMIN' });
    await controller.setStatus(OWNER, 'v1', { status: 'RETIRED' });
    expect(catalogue.setStatus).toHaveBeenCalledWith('v1', 'RETIRED', { userId: 'usr_owner', role: 'ADMIN' });
  });

  it('a REST draft is always created by OWNER, with notes defaulting to null', async () => {
    const { catalogue, controller } = setup();
    await controller.createDraft('s1', { blocks: { a: 1 } });
    expect(catalogue.createDraft).toHaveBeenCalledWith('s1', { blocks: { a: 1 }, notes: null }, 'OWNER');
    await controller.edit('v1', { notes: 'n' });
    expect(catalogue.editVersion).toHaveBeenCalledWith('v1', { blocks: undefined, notes: 'n' });
  });

  it('selection routes take the user from the token, never from the path or body', async () => {
    const { selections, controller } = setup();
    await controller.listSelections('user_A');
    expect(selections.list).toHaveBeenCalledWith('user_A');
    const body = { strategyVersionId: 'v1', enabled: true, capitalAllocation: 1000 };
    await controller.setSelection('user_A', 's1', body);
    expect(selections.set).toHaveBeenCalledWith('user_A', 's1', body);
  });
});

describe('request DTOs', () => {
  it('SetSelectionDto strips a smuggled userId and refuses strings, NaN and negatives for capital', async () => {
    const dto = plainToInstance(SetSelectionDto, { strategyVersionId: 'v1', enabled: true, capitalAllocation: 1000, userId: 'user_B' });
    expect(await validate(dto, { whitelist: true })).toEqual([]);
    expect((dto as unknown as Record<string, unknown>).userId).toBeUndefined();
    for (const bad of ['1000', NaN, -1]) {
      const errs = await validate(plainToInstance(SetSelectionDto, { strategyVersionId: 'v1', enabled: true, capitalAllocation: bad }));
      expect(errs.map((e) => e.property)).toEqual(['capitalAllocation']);
    }
  });

  it('CreateDraftDto strips createdBy and status', async () => {
    const dto = plainToInstance(CreateDraftDto, { blocks: { entry: {} }, createdBy: 'AI', status: 'PAPER' });
    expect(await validate(dto, { whitelist: true })).toEqual([]);
    expect(dto).toEqual({ blocks: { entry: {} } });
  });

  it('SetVersionStatusDto accepts only the four statuses', async () => {
    expect(await validate(plainToInstance(SetVersionStatusDto, { status: 'RETIRED' }))).toEqual([]);
    expect(await validate(plainToInstance(SetVersionStatusDto, { status: 'ARCHIVED' }))).toHaveLength(1);
  });
});
```

Create `apps/api/src/modules/trade-core/trade-core.module.spec.ts`:

```typescript
import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TradeCoreModule } from './trade-core.module';
import { CoreStrategiesController } from './strategies/controllers/core-strategies.controller';
import { CoreStrategyCatalogueService } from './strategies/services/core-strategy-catalogue.service';
import { CoreStrategySelectionService } from './strategies/services/core-strategy-selection.service';

/** Stands in for the real @Global AuditModule, which AppModule provides. */
@Global()
@Module({ providers: [{ provide: AuditService, useValue: { append: jest.fn() } }], exports: [AuditService] })
class FakeAuditModule {}

describe('TradeCoreModule', () => {
  it('resolves the controller and both services', async () => {
    const mod = await Test.createTestingModule({ imports: [FakeAuditModule, TradeCoreModule] })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();
    expect(mod.get(CoreStrategiesController)).toBeInstanceOf(CoreStrategiesController);
    expect(mod.get(CoreStrategyCatalogueService)).toBeInstanceOf(CoreStrategyCatalogueService);
    expect(mod.get(CoreStrategySelectionService)).toBeInstanceOf(CoreStrategySelectionService);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @td/api test -- core-strategies.controller trade-core.module`
Expected: FAIL with "Cannot find module './core-strategies.controller'" and "Cannot find module
'./trade-core.module'".

- [ ] **Step 3: Write the controller and the module**

Create `apps/api/src/modules/trade-core/strategies/controllers/core-strategies.controller.ts`:

```typescript
import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AdminOnly, CurrentUser, type AuthenticatedUser } from '../../../../common/decorators';
import {
  CoreStrategyCatalogueService,
  type Actor,
  type EditVersionResult,
} from '../services/core-strategy-catalogue.service';
import { CoreStrategySelectionService } from '../services/core-strategy-selection.service';
import {
  CreateDraftDto,
  EditVersionDto,
  SetSelectionDto,
  SetVersionStatusDto,
  type CoreSelectionDto,
  type CoreStrategyDto,
  type CoreStrategyVersionDto,
} from '../dto/core-strategy.dto';

const actorOf = (u: AuthenticatedUser): Actor => ({ userId: u.userId, role: u.role });

/**
 * SP2 strategy catalogue and per-user selections (spec §4.2–4.3). Every route is
 * authenticated by the global JwtAuthGuard. Catalogue writes are owner-only
 * (@AdminOnly, and the service re-checks for mode changes). Selection routes act
 * on the caller only: the user comes from the token, never the path or body.
 */
@ApiTags('Trade core: strategies')
@Controller('api/trade-core')
export class CoreStrategiesController {
  constructor(
    private readonly catalogue: CoreStrategyCatalogueService,
    private readonly selections: CoreStrategySelectionService,
  ) {}

  @Get('strategies')
  async list(@CurrentUser() user: AuthenticatedUser): Promise<{ strategies: CoreStrategyDto[] }> {
    return { strategies: await this.catalogue.list(actorOf(user)) };
  }

  @AdminOnly()
  @Post('strategies/:strategyId/versions')
  createDraft(@Param('strategyId') strategyId: string, @Body() dto: CreateDraftDto): Promise<CoreStrategyVersionDto> {
    return this.catalogue.createDraft(strategyId, { blocks: dto.blocks, notes: dto.notes ?? null }, 'OWNER');
  }

  @AdminOnly()
  @Patch('strategy-versions/:versionId')
  edit(@Param('versionId') versionId: string, @Body() dto: EditVersionDto): Promise<EditVersionResult> {
    return this.catalogue.editVersion(versionId, { blocks: dto.blocks, notes: dto.notes });
  }

  @AdminOnly()
  @Post('strategy-versions/:versionId/approve')
  @HttpCode(HttpStatus.OK)
  approve(@CurrentUser() user: AuthenticatedUser, @Param('versionId') versionId: string): Promise<CoreStrategyVersionDto> {
    return this.catalogue.approve(versionId, actorOf(user));
  }

  @AdminOnly()
  @Post('strategy-versions/:versionId/status')
  @HttpCode(HttpStatus.OK)
  setStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Param('versionId') versionId: string,
    @Body() dto: SetVersionStatusDto,
  ): Promise<CoreStrategyVersionDto> {
    return this.catalogue.setStatus(versionId, dto.status, actorOf(user));
  }

  @Get('strategy-selections')
  async listSelections(@CurrentUser('userId') userId: string): Promise<{ selections: CoreSelectionDto[] }> {
    return { selections: await this.selections.list(userId) };
  }

  @Put('strategy-selections/:strategyId')
  setSelection(
    @CurrentUser('userId') userId: string,
    @Param('strategyId') strategyId: string,
    @Body() dto: SetSelectionDto,
  ): Promise<CoreSelectionDto> {
    return this.selections.set(userId, strategyId, dto);
  }
}
```

Create `apps/api/src/modules/trade-core/trade-core.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { CoreStrategiesController } from './strategies/controllers/core-strategies.controller';
import { CoreStrategyRepository } from './strategies/repositories/core-strategy.repository';
import { CoreStrategySelectionRepository } from './strategies/repositories/core-strategy-selection.repository';
import { CoreStrategyCatalogueService } from './strategies/services/core-strategy-catalogue.service';
import { CoreStrategySelectionService } from './strategies/services/core-strategy-selection.service';

/**
 * SP2 trade core (docs/superpowers/specs/2026-10-09-sp2-core-trade-lifecycle-design.md).
 * M1 ships the `strategies/` part only: the catalogue, immutable versions and
 * per-user selections. Later milestones add risk-wall/, execution/, lifecycle/
 * and journal/ here. Nothing in M1 trades; AuditService comes from the @Global
 * AuditModule. Imports no silo module (approach A).
 */
@Module({
  imports: [PrismaModule],
  controllers: [CoreStrategiesController],
  providers: [
    CoreStrategyRepository,
    CoreStrategySelectionRepository,
    CoreStrategyCatalogueService,
    CoreStrategySelectionService,
  ],
  exports: [CoreStrategyCatalogueService, CoreStrategySelectionService],
})
export class TradeCoreModule {}
```

In `apps/api/src/app.module.ts`:
- add the import after `import { HealthModule } from './modules/health/health.module';`:

```typescript
import { TradeCoreModule } from './modules/trade-core/trade-core.module';
```

- add to `imports`, directly before the `HealthModule,` entry (after `TelegramModule,`):

```typescript
    // SP2 trade core — M1: strategy catalogue, immutable versions, per-user
    // selections (the dropdown). Paper only; nothing trades until M5.
    TradeCoreModule,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @td/api test -- core-strategies.controller trade-core.module`
Expected: PASS (8 tests).

Run: `pnpm --filter @td/api test -- trade-core cron-timezone`
Expected: PASS (every trade-core suite plus the cron ratchet, which is unchanged because M1 adds no cron).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/trade-core/strategies/controllers/core-strategies.controller.ts apps/api/src/modules/trade-core/strategies/controllers/core-strategies.controller.spec.ts apps/api/src/modules/trade-core/trade-core.module.ts apps/api/src/modules/trade-core/trade-core.module.spec.ts apps/api/src/app.module.ts
git commit -m "feat(trade-core): /api/trade-core strategy and selection endpoints; wire TradeCoreModule" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/api/src/modules/trade-core/strategies/controllers/core-strategies.controller.ts apps/api/src/modules/trade-core/strategies/controllers/core-strategies.controller.spec.ts apps/api/src/modules/trade-core/trade-core.module.ts apps/api/src/modules/trade-core/trade-core.module.spec.ts apps/api/src/app.module.ts
```

---

### Task 8: Web wire client and pure picker logic

**Files:**
- Create: `apps/web/src/services/coreStrategies.ts`
- Test: `apps/web/src/services/coreStrategies.spec.ts`
- Create: `apps/web/src/pages/core-strategies/core-strategy-picker.ts`
- Test: `apps/web/src/pages/core-strategies/core-strategy-picker.spec.ts`

**Interfaces:**
- Consumes: the routes and wire shapes of Task 7 (mirrored, not imported; decision 13); `api`
  (`apps/web/src/services/api.ts`, baseURL `/api`).
- Produces:

```typescript
// services/coreStrategies.ts
export type CoreVersionStatus = 'DRAFT' | 'PAPER' | 'LIVE' | 'RETIRED';
export interface CoreStrategyVersionView { id; strategyId; version: number; status: CoreVersionStatus; blocks: unknown; createdBy: 'OWNER' | 'AI'; approvedBy: string | null; approvedAt: string | null; sourceDocId: string | null; notes: string | null; createdAt: string }
export interface CoreStrategyView { id; key; name; description; allowedVehicles: string[]; createdAt: string; versions: CoreStrategyVersionView[] }
export interface CoreSelectionView { id; strategyId; strategyVersionId; enabled: boolean; capitalAllocation: number; updatedAt: string }
export interface SetCoreSelectionBody { strategyVersionId: string; enabled: boolean; capitalAllocation: number }
export function listCoreStrategies(): Promise<CoreStrategyView[]>;
export function listCoreSelections(): Promise<CoreSelectionView[]>;
export function setCoreSelection(strategyId: string, body: SetCoreSelectionBody): Promise<CoreSelectionView>;
export function approveCoreVersion(versionId: string): Promise<CoreStrategyVersionView>;

// pages/core-strategies/core-strategy-picker.ts
export const SELECTABLE_STATUSES: ReadonlySet<CoreVersionStatus>;   // {'PAPER'}
export function versionLabel(v: CoreStrategyVersionView): string;    // "v1 · paper", "v2 · draft · AI-drafted"
export function selectableVersions(s: CoreStrategyView): CoreStrategyVersionView[];   // newest first
export interface PickerRow { strategyId: string; options: { value: string; label: string }[]; versionId: string | null; enabled: boolean; capitalText: string; staleSelection: boolean }
export function pickerRow(s: CoreStrategyView, selection: CoreSelectionView | undefined): PickerRow;
export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };
export function parseCapital(text: string): Parsed<number>;
export function selectionPayload(form: { versionId: string | null; enabled: boolean; capitalText: string }): Parsed<SetCoreSelectionBody>;
export interface BlockLine { label: string; value: string }
export function describeBlocks(blocks: unknown): BlockLine[];
export function apiErrorMessage(err: unknown, fallback: string): string;
```

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/services/coreStrategies.spec.ts`:

```typescript
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('./api', () => ({ default: { get: vi.fn(), put: vi.fn(), post: vi.fn() } }));

import api from './api';
import { approveCoreVersion, listCoreSelections, listCoreStrategies, setCoreSelection } from './coreStrategies';

describe('coreStrategies wire client', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reads the catalogue and the caller’s selections from the kebab-case routes', async () => {
    (api.get as Mock).mockResolvedValueOnce({ data: { strategies: [{ id: 's1' }] } });
    expect(await listCoreStrategies()).toEqual([{ id: 's1' }]);
    expect(api.get).toHaveBeenLastCalledWith('/trade-core/strategies');
    (api.get as Mock).mockResolvedValueOnce({ data: { selections: [{ id: 'sel_1' }] } });
    expect(await listCoreSelections()).toEqual([{ id: 'sel_1' }]);
    expect(api.get).toHaveBeenLastCalledWith('/trade-core/strategy-selections');
  });

  it('PUTs a selection by strategy id (encoded) and POSTs an approval', async () => {
    (api.put as Mock).mockResolvedValueOnce({ data: { id: 'sel_1' } });
    const body = { strategyVersionId: 'v1', enabled: true, capitalAllocation: 1000 };
    await setCoreSelection('s/1', body);
    expect(api.put).toHaveBeenCalledWith('/trade-core/strategy-selections/s%2F1', body);
    (api.post as Mock).mockResolvedValueOnce({ data: { id: 'v1', status: 'PAPER' } });
    expect(await approveCoreVersion('v1')).toEqual({ id: 'v1', status: 'PAPER' });
    expect(api.post).toHaveBeenCalledWith('/trade-core/strategy-versions/v1/approve');
  });
});
```

Create `apps/web/src/pages/core-strategies/core-strategy-picker.spec.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import type { CoreSelectionView, CoreStrategyVersionView, CoreStrategyView } from '@/services/coreStrategies';
import {
  apiErrorMessage,
  describeBlocks,
  parseCapital,
  pickerRow,
  selectableVersions,
  selectionPayload,
  versionLabel,
} from './core-strategy-picker';

const ISO = '2026-10-09T04:00:00.000Z';

function v(id: string, version: number, status: CoreStrategyVersionView['status'], over: Partial<CoreStrategyVersionView> = {}): CoreStrategyVersionView {
  return { id, strategyId: 's1', version, status, blocks: {}, createdBy: 'OWNER', approvedBy: null, approvedAt: null, sourceDocId: null, notes: null, createdAt: ISO, ...over };
}

function strategy(versions: CoreStrategyVersionView[]): CoreStrategyView {
  return { id: 's1', key: 'ungated', name: 'Ungated', description: 'd', allowedVehicles: ['CASH_INTRADAY'], createdAt: ISO, versions };
}

function sel(over: Partial<CoreSelectionView> = {}): CoreSelectionView {
  return { id: 'sel_1', strategyId: 's1', strategyVersionId: 'v1', enabled: true, capitalAllocation: 200000, updatedAt: ISO, ...over };
}

describe('versions', () => {
  it('labels a version with its number, status and AI origin', () => {
    expect(versionLabel(v('v1', 1, 'PAPER'))).toBe('v1 · paper');
    expect(versionLabel(v('v2', 2, 'DRAFT', { createdBy: 'AI' }))).toBe('v2 · draft · AI-drafted');
  });

  it('offers only PAPER versions, newest first', () => {
    const s = strategy([v('v1', 1, 'PAPER'), v('v3', 3, 'DRAFT'), v('v2', 2, 'PAPER'), v('v0', 4, 'RETIRED')]);
    expect(selectableVersions(s).map((x) => x.id)).toEqual(['v2', 'v1']);
  });
});

describe('pickerRow', () => {
  it('starts a strategy with no selection on its newest approved version, off, with no capital', () => {
    const row = pickerRow(strategy([v('v1', 1, 'PAPER'), v('v2', 2, 'PAPER')]), undefined);
    expect(row).toEqual({
      strategyId: 's1',
      options: [{ value: 'v2', label: 'v2 · paper' }, { value: 'v1', label: 'v1 · paper' }],
      versionId: 'v2', enabled: false, capitalText: '', staleSelection: false,
    });
  });

  it('shows the saved selection', () => {
    const row = pickerRow(strategy([v('v1', 1, 'PAPER'), v('v2', 2, 'PAPER')]), sel({ strategyVersionId: 'v1' }));
    expect(row).toMatchObject({ versionId: 'v1', enabled: true, capitalText: '200000', staleSelection: false });
  });

  it('pickerRow flags a saved selection whose version is no longer selectable', () => {
    const retired = pickerRow(strategy([v('v1', 1, 'RETIRED'), v('v2', 2, 'PAPER')]), sel({ strategyVersionId: 'v1' }));
    expect(retired).toMatchObject({ versionId: 'v2', staleSelection: true, enabled: true });
    const hidden = pickerRow(strategy([v('v2', 2, 'PAPER')]), sel({ strategyVersionId: 'v1' }));
    expect(hidden.staleSelection).toBe(true);
  });

  it('has no version to pick while nothing is approved', () => {
    expect(pickerRow(strategy([v('v1', 1, 'DRAFT')]), undefined)).toMatchObject({ options: [], versionId: null });
  });
});

describe('capital and payload', () => {
  it('parses rupee amounts with Indian grouping, ₹ and spaces', () => {
    expect(parseCapital('2,00,000')).toEqual({ ok: true, value: 200000 });
    expect(parseCapital(' ₹ 50000.50 ')).toEqual({ ok: true, value: 50000.5 });
    expect(parseCapital('0')).toEqual({ ok: true, value: 0 });
  });

  it('refuses empty, negative, non-numeric and over-precise amounts', () => {
    for (const bad of ['', '   ', '-100', 'abc', '1e5', '10.123']) expect(parseCapital(bad).ok).toBe(false);
  });

  it('builds the PUT body, and refuses enabling with ₹0 or without a version', () => {
    expect(selectionPayload({ versionId: 'v1', enabled: true, capitalText: '1,000' })).toEqual({
      ok: true, value: { strategyVersionId: 'v1', enabled: true, capitalAllocation: 1000 },
    });
    expect(selectionPayload({ versionId: 'v1', enabled: false, capitalText: '0' }).ok).toBe(true);
    expect(selectionPayload({ versionId: 'v1', enabled: true, capitalText: '0' })).toEqual({ ok: false, error: 'An enabled strategy needs capital above ₹0' });
    expect(selectionPayload({ versionId: null, enabled: false, capitalText: '10' })).toEqual({ ok: false, error: 'No approved version to select yet' });
  });
});

describe('describeBlocks', () => {
  it('describes the Adaptive-Stop v1 shape in words', () => {
    const lines = describeBlocks({
      entry: {
        kind: 'chartink', scanName: null, match: 'ANY', side: 'BUY',
        minScore: { base: 47, windows: [{ fromHhmm: '11:45', toHhmm: '14:00', score: 75 }] },
      },
      filters: {
        staleEntry: { maxMovePct: 1 }, cooldown: { minutes: 45 }, lastLoss: { window: 'SAME_IST_DAY' },
        gates: [{ kind: 'evaluator', evaluatorKey: 'adaptive-stop-decision-gate', params: {} }],
      },
      stop: { kind: 'atr', period: 14, timeframe: '5m', multiple: 1.2, minPct: 0.8, maxPct: 2.5 },
      target: { kind: 'fixedPct', pct: 2 },
      trail: { kind: 'atr', multiple: 1, minPct: 0.6, maxPct: 1.5, startsAfter: 'PARTIAL' },
      timeExit: { kind: 'clock', hhmm: '15:15' },
      partial: { kind: 'atTarget1', fraction: 0.5, atPct: 1 },
      sizing: { kind: 'riskRupees', amount: 800 },
      vehicle: { kind: 'CASH_INTRADAY' },
    });
    expect(lines).toEqual([
      { label: 'Entry', value: 'Chartink · any scan · BUY · score ≥ 47 (≥ 75 11:45–14:00 IST)' },
      {
        label: 'Filters',
        value: 'skip if price ran > 1% from the alert · 45-min cooldown per symbol · skip after a same-day loss on the symbol · gate adaptive-stop-decision-gate',
      },
      { label: 'Stop', value: 'ATR(14, 5m) × 1.2, clamped 0.8%–2.5%' },
      { label: 'Target', value: '+2% from entry' },
      { label: 'Trail', value: 'ATR at entry × 1, clamped 0.6%–1.5%, after the partial exit' },
      { label: 'Time exit', value: 'Exit at 15:15 IST' },
      { label: 'Partial', value: 'Sell 50% at +1%' },
      { label: 'Sizing', value: 'Risk ₹800 per trade' },
      { label: 'Vehicle', value: 'Cash intraday' },
    ]);
  });

  it('describes the Ungated v1 shape, and never throws on unknown or broken blocks', () => {
    const lines = describeBlocks({
      entry: { kind: 'chartink', scanName: 'hull', match: 'CONTAINS', side: 'BUY', minScore: null },
      filters: { staleEntry: null, cooldown: null, lastLoss: null, gates: [] },
      stop: { kind: 'fixedPct', pct: 1.5 },
      sizing: { kind: 'notionalRupees', amount: 200000 },
      vehicle: { kind: 'SPACESHIP' },
    });
    expect(lines.find((l) => l.label === 'Entry')?.value).toBe('Chartink · scan contains "hull" · BUY');
    expect(lines.find((l) => l.label === 'Filters')?.value).toBe('None');
    expect(lines.find((l) => l.label === 'Stop')?.value).toBe('Fixed 1.5% from entry');
    expect(lines.find((l) => l.label === 'Sizing')?.value).toBe('₹2,00,000 notional per trade');
    expect(lines.find((l) => l.label === 'Vehicle')?.value).toBe('{"kind":"SPACESHIP"}');
    expect(lines.find((l) => l.label === 'Target')?.value).toBe('—');
    expect(describeBlocks(null)).toEqual([{ label: 'Blocks', value: 'not readable' }]);
  });
});

describe('apiErrorMessage', () => {
  it('prefers the server message, then the error message, then the fallback', () => {
    expect(apiErrorMessage({ response: { data: { message: 'v1 is RETIRED' } } }, 'x')).toBe('v1 is RETIRED');
    expect(apiErrorMessage({ response: { data: { message: ['a', 'b'] } } }, 'x')).toBe('a; b');
    expect(apiErrorMessage(new Error('Network Error'), 'x')).toBe('Network Error');
    expect(apiErrorMessage(undefined, 'Could not save')).toBe('Could not save');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @td/web test -- coreStrategies core-strategy-picker`
Expected: FAIL with "Failed to resolve import './coreStrategies'" and "'./core-strategy-picker'".

- [ ] **Step 3: Write the client and the picker logic**

Create `apps/web/src/services/coreStrategies.ts`:

```typescript
import api from './api';

/**
 * SP2 trade-core strategy catalogue and the caller's selections. Mirrors the API's
 * wire shapes in apps/api/src/modules/trade-core/strategies/dto/core-strategy.dto.ts
 * (the API does not import @td/shared; see the M1 plan, decision 13).
 */
export type CoreVersionStatus = 'DRAFT' | 'PAPER' | 'LIVE' | 'RETIRED';

export interface CoreStrategyVersionView {
  id: string;
  strategyId: string;
  version: number;
  status: CoreVersionStatus;
  blocks: unknown;
  createdBy: 'OWNER' | 'AI';
  approvedBy: string | null;
  approvedAt: string | null;
  sourceDocId: string | null;
  notes: string | null;
  createdAt: string;
}

export interface CoreStrategyView {
  id: string;
  key: string;
  name: string;
  description: string;
  allowedVehicles: string[];
  createdAt: string;
  versions: CoreStrategyVersionView[];
}

export interface CoreSelectionView {
  id: string;
  strategyId: string;
  strategyVersionId: string;
  enabled: boolean;
  capitalAllocation: number;
  updatedAt: string;
}

export interface SetCoreSelectionBody {
  strategyVersionId: string;
  enabled: boolean;
  capitalAllocation: number;
}

export async function listCoreStrategies(): Promise<CoreStrategyView[]> {
  const r = await api.get<{ strategies: CoreStrategyView[] }>('/trade-core/strategies');
  return r.data.strategies;
}

export async function listCoreSelections(): Promise<CoreSelectionView[]> {
  const r = await api.get<{ selections: CoreSelectionView[] }>('/trade-core/strategy-selections');
  return r.data.selections;
}

export async function setCoreSelection(strategyId: string, body: SetCoreSelectionBody): Promise<CoreSelectionView> {
  const r = await api.put<CoreSelectionView>(`/trade-core/strategy-selections/${encodeURIComponent(strategyId)}`, body);
  return r.data;
}

/** Owner only (the API answers 403 to anyone else). */
export async function approveCoreVersion(versionId: string): Promise<CoreStrategyVersionView> {
  const r = await api.post<CoreStrategyVersionView>(`/trade-core/strategy-versions/${encodeURIComponent(versionId)}/approve`);
  return r.data;
}
```

Create `apps/web/src/pages/core-strategies/core-strategy-picker.ts`:

```typescript
import type {
  CoreSelectionView,
  CoreStrategyVersionView,
  CoreStrategyView,
  CoreVersionStatus,
  SetCoreSelectionBody,
} from '@/services/coreStrategies';

/** Versions a user may select. Mirrors SELECTABLE_STATUSES in the API; LIVE joins at SP7. */
export const SELECTABLE_STATUSES: ReadonlySet<CoreVersionStatus> = new Set<CoreVersionStatus>(['PAPER']);

const STATUS_LABEL: Record<CoreVersionStatus, string> = { DRAFT: 'draft', PAPER: 'paper', LIVE: 'live', RETIRED: 'retired' };

export function versionLabel(v: CoreStrategyVersionView): string {
  return `v${v.version} · ${STATUS_LABEL[v.status] ?? v.status}${v.createdBy === 'AI' ? ' · AI-drafted' : ''}`;
}

export function selectableVersions(s: CoreStrategyView): CoreStrategyVersionView[] {
  return s.versions.filter((v) => SELECTABLE_STATUSES.has(v.status)).sort((a, b) => b.version - a.version);
}

export interface PickerRow {
  strategyId: string;
  options: { value: string; label: string }[];
  /** The version the form starts on: the saved one if still selectable, else the newest approved. */
  versionId: string | null;
  enabled: boolean;
  capitalText: string;
  /** A saved selection points at a version that can no longer trade (retired or hidden). */
  staleSelection: boolean;
}

export function pickerRow(s: CoreStrategyView, selection: CoreSelectionView | undefined): PickerRow {
  const selectable = selectableVersions(s);
  const chosen = selection ? selectable.find((v) => v.id === selection.strategyVersionId) : undefined;
  return {
    strategyId: s.id,
    options: selectable.map((v) => ({ value: v.id, label: versionLabel(v) })),
    versionId: chosen?.id ?? selectable[0]?.id ?? null,
    enabled: selection?.enabled ?? false,
    capitalText: selection ? String(selection.capitalAllocation) : '',
    staleSelection: selection !== undefined && chosen === undefined,
  };
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** Rupees: digits with optional Indian/Western grouping, ₹ and spaces, up to 2 decimals. */
export function parseCapital(text: string): Parsed<number> {
  const cleaned = text.replace(/[₹,\s]/g, '');
  if (cleaned === '') return { ok: false, error: 'Enter a capital allocation in ₹' };
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return { ok: false, error: 'Capital must be a rupee amount like 200000 or 2,00,000' };
  return { ok: true, value: Number(cleaned) };
}

export function selectionPayload(form: { versionId: string | null; enabled: boolean; capitalText: string }): Parsed<SetCoreSelectionBody> {
  if (!form.versionId) return { ok: false, error: 'No approved version to select yet' };
  const capital = parseCapital(form.capitalText);
  if (!capital.ok) return capital;
  if (form.enabled && capital.value <= 0) return { ok: false, error: 'An enabled strategy needs capital above ₹0' };
  return { ok: true, value: { strategyVersionId: form.versionId, enabled: form.enabled, capitalAllocation: capital.value } };
}

export interface BlockLine {
  label: string;
  value: string;
}

type Obj = Record<string, unknown>;
const asObj = (v: unknown): Obj | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : null);
const pct = (n: unknown): string => (typeof n === 'number' ? `${n}%` : '?');
const rupees = (n: unknown): string => (typeof n === 'number' ? `₹${n.toLocaleString('en-IN')}` : '?');

const BLOCK_ORDER: ReadonlyArray<readonly [string, string]> = [
  ['entry', 'Entry'], ['filters', 'Filters'], ['stop', 'Stop'], ['target', 'Target'], ['trail', 'Trail'],
  ['timeExit', 'Time exit'], ['partial', 'Partial'], ['sizing', 'Sizing'], ['vehicle', 'Vehicle'],
];

/** " · score ≥ 47 (≥ 75 11:45–14:00 IST)", or "" when there is no score gate. */
function scoreText(m: unknown): string {
  const o = asObj(m);
  if (!o) return '';
  const windows = (Array.isArray(o.windows) ? o.windows : [])
    .map(asObj)
    .filter((w): w is Obj => w !== null)
    .map((w) => `≥ ${String(w.score)} ${String(w.fromHhmm)}–${String(w.toHhmm)} IST`);
  return ` · score ≥ ${String(o.base)}${windows.length > 0 ? ` (${windows.join(', ')})` : ''}`;
}

function describeFilters(o: Obj): string {
  const parts: string[] = [];
  const stale = asObj(o.staleEntry);
  if (stale) parts.push(`skip if price ran > ${pct(stale.maxMovePct)} from the alert`);
  const cooldown = asObj(o.cooldown);
  if (cooldown) parts.push(`${String(cooldown.minutes)}-min cooldown per symbol`);
  if (asObj(o.lastLoss)) parts.push('skip after a same-day loss on the symbol');
  for (const g of Array.isArray(o.gates) ? o.gates : []) {
    const go = asObj(g);
    if (go) parts.push(`gate ${String(go.evaluatorKey)}`);
  }
  return parts.length > 0 ? parts.join(' · ') : 'None';
}

function describeOne(key: string, o: Obj | null): string {
  if (!o) return '—';
  if (key === 'filters') return describeFilters(o);
  switch (`${key}:${String(o.kind)}`) {
    case 'entry:chartink': {
      const scan = o.match === 'ANY' ? 'any scan' : o.match === 'CONTAINS' ? `scan contains "${String(o.scanName)}"` : `scan "${String(o.scanName)}"`;
      return `Chartink · ${scan} · ${String(o.side)}${scoreText(o.minScore)}`;
    }
    case 'entry:evaluator':
      return `Evaluator ${String(o.evaluatorKey)} · ${String(o.side)}`;
    case 'stop:fixedPct':
      return `Fixed ${pct(o.pct)} from entry`;
    case 'stop:atr':
      return `ATR(${String(o.period)}, ${String(o.timeframe)}) × ${String(o.multiple)}, clamped ${pct(o.minPct)}–${pct(o.maxPct)}`;
    case 'target:fixedPct':
      return `+${pct(o.pct)} from entry`;
    case 'target:rr':
      return `${String(o.ratio)} × the initial risk`;
    case 'trail:none':
    case 'partial:none':
      return 'None';
    case 'trail:breakeven':
      return `Stop to entry at +${pct(o.atPct)}`;
    case 'trail:atr':
      return `ATR at entry × ${String(o.multiple)}, clamped ${pct(o.minPct)}–${pct(o.maxPct)}, ${o.startsAfter === 'PARTIAL' ? 'after the partial exit' : 'from entry'}`;
    case 'timeExit:clock':
      return `Exit at ${String(o.hhmm)} IST`;
    case 'timeExit:holdDays':
      return `Exit after ${String(o.n)} day(s)`;
    case 'partial:atTarget1':
      return `Sell ${typeof o.fraction === 'number' ? Math.round(o.fraction * 100) : '?'}% at +${pct(o.atPct)}`;
    case 'sizing:riskRupees':
      return `Risk ${rupees(o.amount)} per trade`;
    case 'sizing:notionalRupees':
      return `${rupees(o.amount)} notional per trade`;
    case 'vehicle:CASH_INTRADAY':
      return 'Cash intraday';
    case 'vehicle:MTF':
      return 'MTF';
    case 'vehicle:OPTIONS_BUY': {
      const theta = asObj(o.thetaStop);
      return `Options buy · ${String(o.strike)} · expiry ≥ ${String(o.minDaysToExpiry)} days · premium stop ${pct(o.premiumStopPct)}` +
        ` · theta stop ${theta ? `${pct(theta.minMovePct)} in ${String(theta.withinMinutes)} min` : '?'}` +
        ` · expiry-day exit ${String(o.expiryDayExitHhmm)}`;
    }
    default:
      return JSON.stringify(o);
  }
}

/** Read-only, human wording of a version's blocks. Never throws on odd data. */
export function describeBlocks(blocks: unknown): BlockLine[] {
  const b = asObj(blocks);
  if (!b) return [{ label: 'Blocks', value: 'not readable' }];
  return BLOCK_ORDER.map(([key, label]) => ({ label, value: describeOne(key, asObj(b[key])) }));
}

/** The text to toast for a failed call (the axios interceptor toasts only 401/429/5xx). */
export function apiErrorMessage(err: unknown, fallback: string): string {
  const m = (err as { response?: { data?: { message?: unknown } } } | undefined)?.response?.data?.message;
  if (typeof m === 'string' && m.trim() !== '') return m;
  if (Array.isArray(m) && m.length > 0) return m.join('; ');
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @td/web test -- coreStrategies core-strategy-picker`
Expected: PASS (2 files, 14 tests). (`'₹2,00,000'` relies on Node's built-in full ICU for `en-IN`, which
Node ships by default; if the runner's Node lacks it, the test prints `₹200,000` and the Node build is the
problem, not the code.)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/services/coreStrategies.ts apps/web/src/services/coreStrategies.spec.ts apps/web/src/pages/core-strategies/core-strategy-picker.ts apps/web/src/pages/core-strategies/core-strategy-picker.spec.ts
git commit -m "feat(web): trade-core strategy client and pure picker logic" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/web/src/services/coreStrategies.ts apps/web/src/services/coreStrategies.spec.ts apps/web/src/pages/core-strategies/core-strategy-picker.ts apps/web/src/pages/core-strategies/core-strategy-picker.spec.ts
```

---

### Task 9: The Core Strategies page, route and nav entry

**Files:**
- Create: `apps/web/src/pages/core-strategies/CoreStrategiesPage.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/components/layout/navItems.ts`
- Test: existing `apps/web/src/components/layout/navItems.spec.ts` (must still pass unchanged)

**Interfaces:**
- Consumes: everything Task 8 produces; `Toggle`, `LoadingSkeleton` (`@/components/common`);
  `useQuery`, `useMutation`, `useQueryClient` (`@tanstack/react-query`, provider in `main.tsx`);
  `toast` (`react-hot-toast`); `useAuthStore` (role, as `App.tsx` uses it).
- Produces: route `/core-strategies` (ADMIN), nav item "Core Strategies" (badge `SP2`).

The page holds no logic of its own beyond wiring: every decision (options, stale flag, payload, wording,
error text) is a Task 8 function with a spec. There is no DOM test (decision 15, Global Constraints).

- [ ] **Step 1: Write the page**

Create `apps/web/src/pages/core-strategies/CoreStrategiesPage.tsx`:

```tsx
import { Fragment, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Layers } from 'lucide-react';
import { LoadingSkeleton, Toggle } from '@/components/common';
import { useAuthStore } from '@/stores/auth-store';
import {
  approveCoreVersion,
  listCoreSelections,
  listCoreStrategies,
  setCoreSelection,
  type SetCoreSelectionBody,
} from '@/services/coreStrategies';
import { apiErrorMessage, describeBlocks, pickerRow, selectionPayload, versionLabel } from './core-strategy-picker';

const STRATEGIES_KEY = ['trade-core', 'strategies'] as const;
const SELECTIONS_KEY = ['trade-core', 'strategy-selections'] as const;

const CARD = 'space-y-3 rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-card)] p-4';
const LABEL = 'flex flex-col gap-1 text-xs font-medium text-[var(--color-text-muted)]';
const FIELD = 'rounded border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] px-2 py-1.5 text-sm text-[var(--color-text-primary)]';
const BUTTON = 'rounded bg-[var(--color-accent-blue)] px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50';

interface FormState {
  /** pickerRow identity the form was started from; a new server row resets the form. */
  key: string;
  versionId: string | null;
  enabled: boolean;
  capitalText: string;
}

/**
 * SP2 strategy picker (spec §4.3): choose a strategy and an approved version,
 * switch it on (paper) with a capital allocation, read its blocks. The owner can
 * approve a draft here. Logic lives in core-strategy-picker.ts.
 */
export default function CoreStrategiesPage() {
  const qc = useQueryClient();
  const isOwner = useAuthStore((s) => s.user?.role) === 'ADMIN';
  const strategiesQ = useQuery({ queryKey: STRATEGIES_KEY, queryFn: listCoreStrategies });
  const selectionsQ = useQuery({ queryKey: SELECTIONS_KEY, queryFn: listCoreSelections });
  const [pickedId, setPickedId] = useState('');
  const [viewId, setViewId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);

  const save = useMutation({
    mutationFn: (args: { strategyId: string; body: SetCoreSelectionBody }) => setCoreSelection(args.strategyId, args.body),
    onSuccess: () => {
      toast.success('Selection saved (paper)');
      void qc.invalidateQueries({ queryKey: SELECTIONS_KEY });
    },
    onError: (err: unknown) => toast.error(apiErrorMessage(err, 'Could not save the selection')),
  });

  const approve = useMutation({
    mutationFn: (versionId: string) => approveCoreVersion(versionId),
    onSuccess: (v) => {
      toast.success(`v${v.version} approved: selectable in paper`);
      void qc.invalidateQueries({ queryKey: STRATEGIES_KEY });
    },
    onError: (err: unknown) => toast.error(apiErrorMessage(err, 'Could not approve the version')),
  });

  if (strategiesQ.isLoading || selectionsQ.isLoading) {
    return <div className="p-4"><LoadingSkeleton variant="card" /></div>;
  }
  if (strategiesQ.isError || selectionsQ.isError) {
    return (
      <div className="p-4 text-sm text-[var(--color-accent-red)]">
        Could not load the strategy catalogue: {apiErrorMessage(strategiesQ.error ?? selectionsQ.error, 'unknown error')}
      </div>
    );
  }

  const strategies = strategiesQ.data ?? [];
  const strategy = strategies.find((s) => s.id === pickedId) ?? strategies[0];
  if (!strategy) {
    return <div className="p-4 text-sm text-[var(--color-text-muted)]">No strategies in the catalogue yet.</div>;
  }
  const selection = (selectionsQ.data ?? []).find((x) => x.strategyId === strategy.id);
  const row = pickerRow(strategy, selection);
  const rowKey = [row.strategyId, row.versionId, row.enabled, row.capitalText, selection?.updatedAt ?? ''].join('|');
  const current: FormState =
    form && form.key === rowKey
      ? form
      : { key: rowKey, versionId: row.versionId, enabled: row.enabled, capitalText: row.capitalText };
  const shown = strategy.versions.find((v) => v.id === (viewId ?? current.versionId)) ?? strategy.versions[0];

  const onSave = () => {
    const payload = selectionPayload(current);
    if (!payload.ok) {
      toast.error(payload.error);
      return;
    }
    save.mutate({ strategyId: strategy.id, body: payload.value });
  };

  return (
    <div className="space-y-4 p-4">
      <header className="flex items-center gap-2">
        <Layers size={18} className="text-[var(--color-accent-blue)]" />
        <h1 className="text-lg font-semibold text-[var(--color-text-primary)]">Core Strategies</h1>
        <span className="rounded bg-[var(--color-bg-tertiary)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
          Paper only
        </span>
      </header>

      <section className={CARD}>
        <label className={LABEL}>
          Strategy
          <select
            className={FIELD}
            value={strategy.id}
            onChange={(e) => {
              setPickedId(e.target.value);
              setViewId(null);
              setForm(null);
            }}
          >
            {strategies.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </label>
        <p className="text-xs text-[var(--color-text-secondary)]">{strategy.description}</p>

        <label className={LABEL}>
          Version
          <select
            className={FIELD}
            value={current.versionId ?? ''}
            disabled={row.options.length === 0}
            onChange={(e) => {
              setForm({ ...current, versionId: e.target.value });
              setViewId(null);
            }}
          >
            {row.options.length === 0 && <option value="">No approved version yet</option>}
            {row.options.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
        {row.staleSelection && (
          <p className="text-xs text-[var(--color-accent-yellow)]">
            Your saved version is no longer approved, so the core will not trade it. Pick a version and save, or switch it off.
          </p>
        )}

        <div className="flex flex-wrap items-end gap-4">
          <Toggle checked={current.enabled} onChange={(on) => setForm({ ...current, enabled: on })} label="Enabled (paper)" />
          <label className={LABEL}>
            Capital allocation (₹)
            <input
              className={FIELD}
              inputMode="decimal"
              placeholder="e.g. 2,00,000"
              value={current.capitalText}
              onChange={(e) => setForm({ ...current, capitalText: e.target.value })}
            />
          </label>
          <button type="button" className={BUTTON} disabled={save.isPending || !current.versionId} onClick={onSave}>
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </section>

      <section className={CARD}>
        <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">
          Blocks{shown ? ` · ${versionLabel(shown)}` : ''}
        </h2>
        {shown ? (
          <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1 text-sm">
            {describeBlocks(shown.blocks).map((line) => (
              <Fragment key={line.label}>
                <dt className="text-[var(--color-text-muted)]">{line.label}</dt>
                <dd className="text-[var(--color-text-secondary)]">{line.value}</dd>
              </Fragment>
            ))}
          </dl>
        ) : (
          <p className="text-xs text-[var(--color-text-muted)]">This strategy has no versions yet.</p>
        )}
        {shown?.notes && <p className="whitespace-pre-wrap text-xs text-[var(--color-text-muted)]">{shown.notes}</p>}
      </section>

      <section className={CARD}>
        <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">All versions</h2>
        <ul className="space-y-1 text-sm">
          {strategy.versions.map((v) => (
            <li key={v.id} className="flex flex-wrap items-center gap-3">
              <button type="button" className="text-[var(--color-accent-blue)] underline" onClick={() => setViewId(v.id)}>
                {versionLabel(v)}
              </button>
              <span className="text-xs text-[var(--color-text-muted)]">
                {v.approvedAt ? `approved ${new Date(v.approvedAt).toLocaleString('en-IN')}` : 'not approved'}
              </span>
              {isOwner && v.status === 'DRAFT' && (
                <button type="button" className={BUTTON} disabled={approve.isPending} onClick={() => approve.mutate(v.id)}>
                  Approve into paper
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
```

(`useAuthStore` is imported from `@/stores/auth-store`, the same path `App.tsx` uses.)

- [ ] **Step 2: Add the route and the nav entry**

In `apps/web/src/App.tsx`:
- add next to the other page imports (after `import StrategyBuilderPage from '@/pages/strategy-builder/StrategyBuilderPage';`):

```tsx
import CoreStrategiesPage from '@/pages/core-strategies/CoreStrategiesPage';
```

- add after the `strategy-review` route:

```tsx
        <Route path="core-strategies" element={<RequireRole role="ADMIN"><CoreStrategiesPage /></RequireRole>} />
```

In `apps/web/src/components/layout/navItems.ts`:
- add `Layers,` to the `lucide-react` import list (after `Target,`);
- add after the `/strategy-review` entry:

```typescript
  { path: '/core-strategies', label: 'Core Strategies', icon: Layers, badge: 'SP2' },
```

`USER_VISIBLE` is not changed (decision 15), so `navItems.spec.ts` keeps passing: a user sees the same
items, an admin sees every item.

- [ ] **Step 3: Run the web tests, typecheck and lint**

Run: `pnpm --filter @td/web test -- navItems core-strategy-picker coreStrategies`
Expected: PASS.
Run: `pnpm --filter @td/web exec tsc --noEmit -p tsconfig.json`
Expected: no errors.
Run: `pnpm --filter @td/web exec eslint src/pages/core-strategies src/services/coreStrategies.ts src/components/layout/navItems.ts src/App.tsx`
Expected: no finding on a line this plan added (compare with `main` if `App.tsx` already has findings).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/pages/core-strategies/CoreStrategiesPage.tsx apps/web/src/App.tsx apps/web/src/components/layout/navItems.ts
git commit -m "feat(web): Core Strategies page: strategy and version dropdown, enable toggle, capital, read-only blocks" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/web/src/pages/core-strategies/CoreStrategiesPage.tsx apps/web/src/App.tsx apps/web/src/components/layout/navItems.ts
```

---

### Task 10: Verification and production gate

**Files:**
- Modify: `docs/superpowers/plans/2026-10-09-sp2-m1-strategy-catalogue.md` (record results in the ledger)

- [ ] **Step 1: Whole API suite**

Run: `pnpm --filter @td/api test 2>&1 | tail -15`
Expected: every suite passes. M1 adds 7 API suites (`validate-blocks.spec`, `version-status.spec`,
`core-strategy-seeds.spec`, `core-strategy.repository.spec`, `core-strategy-catalogue.service.spec`,
`core-strategy-selection.service.spec`, `core-strategies.controller.spec`) plus `trade-core.module.spec`
(8 in all). Record the totals. The M4 ledger had 245 suites / 3081 tests.

- [ ] **Step 2: Whole web suite**

Run: `pnpm --filter @td/web test 2>&1 | tail -15`
Expected: every file passes. M1 adds 2 web spec files (`coreStrategies.spec`, `core-strategy-picker.spec`).
Record the totals (M4: 64 files / 591 tests).

- [ ] **Step 3: The old paths are untouched**

Run: `git diff main --stat -- apps/api/src/modules/adaptive-stop-track apps/api/src/modules/ungated-track apps/api/src/modules/chartink apps/api/src/modules/settings`
Expected: empty (approach A; `VALID_STRATEGY_NAMES` unchanged).
Run: `git diff main -- apps/api/src/common/schedule/cron-timezone.spec.ts` and
`grep -rn "@Cron\|@Interval" apps/api/src/modules/trade-core || echo "no schedules in trade-core"`
Expected: empty diff and `no schedules in trade-core`.
Run: `grep -rn "LIVE_TRADING_ENABLED\|@td/shared" apps/api/src/modules/trade-core || echo "clean"`
Expected: `clean`.

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @td/api exec tsc --noEmit -p tsconfig.json 2>&1 | grep -E "trade-core|audit-actions|tenant.constants|app.module" || echo "no errors in M1 API files"`
Expected: `no errors in M1 API files`. Also record the total:
`pnpm --filter @td/api exec tsc --noEmit -p tsconfig.json 2>&1 | grep -c "error TS"` must equal the
count on `main` (about 169, all the `@td/shared` moduleResolution class); M1 adds none.
Run: `pnpm --filter @td/web exec tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 5: Record and commit**

Fill in the ledger row below (date, totals, typecheck, the Task 3 opt-in test and drift result), then:

```bash
git commit -m "docs(plans): SP2 M1 verification results" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- docs/superpowers/plans/2026-10-09-sp2-m1-strategy-catalogue.md
```

---

## M1 production gate (after deploy, owner-run)

Production is the Vyom VPS: Postgres runs in the `grw-postgres` container (deploy/docker-compose.prod.yml).
The API deploy's existing `prisma migrate deploy` against that database applies
`20261009120000_sp2_m1_strategy_catalogue` (expand-only: three new tables, no existing table touched).
No env var is added. After the deploy:

**Database (Vyom VPS, `grw-postgres`):** run on the server. User and database are `grw`/`grw`
(`PG_USER`/`PG_DB` in deploy/env/ops.env.example; use `/opt/grw/env/ops.env` if it differs). The SQL
goes in through a quoted heredoc so the shell leaves the double-quoted identifiers alone; psql reads no
password inside the container (local socket).

```bash
docker exec -i grw-postgres psql -U grw -d grw <<'SQL'
SELECT "key", "name", "allowedVehicles" FROM core_strategies ORDER BY "key";
-- want: adaptive-stop | Adaptive-Stop | {CASH_INTRADAY}   and   ungated | Ungated | {CASH_INTRADAY}
SELECT s."key", v."version", v."status", v."createdBy" FROM core_strategy_versions v JOIN core_strategies s ON s."id" = v."strategyId" ORDER BY s."key";
-- want: both v1, DRAFT, OWNER
SELECT tgname FROM pg_trigger WHERE tgname = 'core_strategy_versions_guard';
-- want: one row
SELECT format_type(a.atttypid, a.atttypmod) AS capital_type FROM pg_attribute a WHERE a.attrelid = 'core_strategy_selections'::regclass AND a.attname = 'capitalAllocation';
-- want: numeric(14,2)
SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'core_strategy_selections_capitalAllocation_check';
-- want: CHECK ((("capitalAllocation" >= (0)::numeric) AND ("capitalAllocation" <> 'NaN'::numeric)))
SQL
```

**Browser (your ADMIN account), `/core-strategies`:**
- Both strategies are in the Strategy dropdown; each shows "No approved version yet" and its v1 under
  **All versions** as `v1 · draft`.
- Click `v1 · draft` for each and compare the **Blocks** list with decision 5's table (and read the notes:
  what was dropped or left to the Risk Wall). Then **Approve into paper** for each; the label becomes
  `v1 · paper` and the version dropdown offers it.
- Select Adaptive-Stop v1, switch **Enabled (paper)** on, enter a capital allocation, **Save**: a
  "Selection saved (paper)" toast; reload and it is still there.
- Try **Save** with Enabled on and capital `0`: the toast says an enabled strategy needs capital above ₹0
  and nothing is sent.

**Audit** (same container, on the server):

```bash
docker exec -i grw-postgres psql -U grw -d grw <<'SQL'
SELECT action, target, meta FROM audit_logs WHERE action LIKE 'CORE_STRATEGY_%' ORDER BY seq;
-- want: two CORE_STRATEGY_VERSION_APPROVED, then CORE_STRATEGY_SELECTION_CHANGED with before: null
-- and after.capitalAllocation the exact 2-dp string you saved (e.g. "200000.00")
SELECT "capitalAllocation"::text FROM core_strategy_selections;
-- want: the same amount, 2 dp (DECIMAL(14,2))
SQL
```

**Another account, if one exists:** `GET /api/trade-core/strategy-selections` returns only its own rows
(empty at first), `GET /api/trade-core/strategies` shows only `PAPER` versions, and
`POST /api/trade-core/strategy-versions/csv_ungated_v1/approve` answers **403**.

**Nothing trades:** M1 has no consumer of selections (M5 adds the Chartink fan-out); the old silos keep
running exactly as before; `LIVE_TRADING_ENABLED` is still `false`.

**Revert path:** revert the code commits. The three tables, the trigger and the seed rows stay
(expand-only, harmless with no code reading them); dropping them would be a new migration.

M1 is complete when this gate is observed in production, not when the tests pass (parent spec rule).

## Notes for later milestones (not in this plan)

- **M5 fan-out must treat a selection as live only when `enabled` AND its version's status is `PAPER`**
  (decision 11): a retired version's selection is not rewritten, and acting on it would be a silent
  divergence. Add that test to M5's tenant/silo-isolation suite.
- **M6** adds `core_strategy_docs` and `core_strategy_gaps`, the FK from `core_strategy_versions.sourceDocId`,
  and the AI draft path: it calls `createDraft(strategyId, input, 'AI')` and runs `validateBlocks` on the
  draft before it is shown as approvable. The seed notes (decision 6) record what M1 left out.
- **Creating a new strategy** (a catalogue row) has no endpoint in M1: the seeds are the catalogue. M6's
  doc flow or an owner endpoint adds one; `allowedVehicles` widening goes with it.
- **Evaluator keys** in `entry.evaluator` and `filters.gates` are shape-checked only; M5 checks them
  against the registered evaluators and wraps `evaluateDecisionGate` as `adaptive-stop-decision-gate`
  (honouring `failOpen`, and recording when it fails open, as the silo does).
- **M5 applies `entry.minScore` and `filters`** before the Risk Wall, using the alert's existing Chartink
  score and alert price, and journals each skip as `INTENT_SKIPPED` with the rule's name. `cooldown` and
  `lastLoss` look at this strategy's own core positions for the same user and symbol.
- **New block variants later** are a change to `block-types.ts` + `validate-blocks.ts` + a new version,
  never an edit of v1.
- **Opening the page to users:** add `/core-strategies` to `USER_VISIBLE` and drop the `RequireRole` wrap;
  the API is already per user.

## Self-review

- **Spec coverage:** §3 module layout and `Core` naming (Tasks 3, 7), tenant scoping (Tasks 3, 4, 6, 7;
  decision 1 on the catalogue), §4.1 blocks and validation (Task 1), seeds as data with cited sources
  (Task 3, decision 5), §4.2 three M1 tables with immutability and status set (Tasks 2, 3, 5), §4.3
  dropdown, PAPER-only selection, owner-only mode (Tasks 5, 6, 8, 9), audit (Tasks 5, 6), §9 error
  handling (404/409/422/403 paths), §10 pure-function unit tests (Tasks 1, 2, 8) and the tenant test
  (Review Focus 1), §11 M1 row (whole plan). `core_strategy_docs`/`core_strategy_gaps` are M6 (scope).
- **Placeholder scan:** no TBD/TODO; every code step has full code; every test step names its command
  and expected result.
- **Type consistency:** `Actor`, `DraftInput`, `EditVersionResult`, `SelectionInput`, `VersionWithStrategy`,
  `NewVersion`, `SelectionWrite`, the DTO names and the web `*View` names match across Tasks 4–9;
  `createDraft(strategyId, input, createdBy)` has the same signature in the service, the controller call
  and the M6 note.

## Owner answers (2026-10-09)

1. **Seeds start as `DRAFT`**; the owner approves each in the UI (decision 7, Task 3 seed rows, the
   page's "Approve into paper" button, the production gate).
2. **One shared, global catalogue**; selections stay per user (decision 1). The spec's §3 tenant-scoping
   line now says so.
3. **Silo-only entry rules become blocks**: `filters.staleEntry`, `filters.cooldown`,
   `filters.lastLoss`, gated admission as `entry.chartink.minScore`, and the decision gate as a
   `filters.gates` evaluator reference (decision 4; Task 1 types, validator and tests; Task 3 seeds and
   seed spec; Task 8 wording). The two-strike stop and the 2-minute grace are **dropped** and recorded in
   the seed notes (decision 6). M5's core-vs-silo comparison will show the difference those two make.

## Verification ledger

| Date | Whole suite (API / web) | Typecheck (M1 files) | Opt-in DB test + drift | Notes |
|---|---|---|---|---|
| 2026-10-10 (branch `feature/sp2-m1-strategy-catalogue` @ 03dbd59, base 13ddd52) | API: `Test Suites: 1 failed, 252 passed, 253 total` / `Tests: 1 failed, 3159 passed, 3160 total` (M4's 245/3081 plus the 8 M1 suites `validate-blocks.spec`, `version-status.spec`, `core-strategy-seeds.spec`, `core-strategy.repository.spec`, `core-strategy-catalogue.service.spec`, `core-strategy-selection.service.spec`, `core-strategies.controller.spec`, `trade-core.module.spec`, all PASS). The one failure is pre-existing and depends on the time of day: `adaptive-stop-watch.service.spec.ts:168` ("decision gate REJECTS an extended / no-support entry") builds 16 15m candles ending 15 min before the real now; `evaluateDecisionGate` skips (fails open) when fewer than 3 of them are on today's IST date (`adaptive-stop-decision-gate.ts:157`), which is true from 00:00 to about 00:45 IST. The whole run reached it at about 00:39 IST; rerun alone at 00:45 IST: 1 suite / 17 tests PASS. Silo file, untouched by M1 (approach A). Web: `Test Files 66 passed (66)` / `Tests 605 passed (605)` (incl. `coreStrategies.spec` 2 tests and `core-strategy-picker.spec` 12 tests; vitest exited 1 only on the ENOTDIR results-cache write into the `apps/web/node_modules` junction, ruling P1). Old paths: `git diff 13ddd52 --stat` on adaptive-stop-track / ungated-track / chartink / settings is empty; the `cron-timezone.spec.ts` diff is empty; no `@Cron`/`@Interval` decorator in trade-core (the only grep hits are `core-strategy-seeds.spec.ts:50,52`, a comment and a regex that read silo source); the `LIVE_TRADING_ENABLED`/`@td/shared` grep in trade-core is clean. | API: no error in trade-core / audit-actions / tenant.constants / app.module. The sorted `error TS` list has 169 lines, the same as the baseline's 169; the only line difference is `setup-tracker.service.ts(572,7)` TS2367, the same error with the same six union members printed in a different order (not an M1 file; signal-generator untouched). `asymmetric-scanner.service.ts(316,13)` is identical. Web: `tsc --noEmit` clean (exit 0). | Run in Task 3 against a throwaway local container (127.0.0.1:55432, ruling P12): opt-in DB test 3/3 PASS. `migrate diff` exited 2 only because of two pre-existing DESC indexes from migration 20260818130000 (`candles_timestamp_idx`, `sentinel_verdicts_createdAt_idx`), identical without the M1 migration; M1 objects have zero drift. Not re-run. | ESLint has no flat config in the repo (pre-existing), so it was not run. Spec §4.3 corrected in this commit (ruling P4): a new version starts in `DRAFT` and only the owner's approval moves it to `PAPER`. The production gate above is owner-run and still outstanding. |
