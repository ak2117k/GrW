# SP2 · M2 — Risk Wall, Editable Limits, Persistent Kill Switch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Scope:** milestone **M2 only** of SP2: the pure Risk Wall check (`ALLOW | REJECT | RESIZE` with reasons
and a limits snapshot), per-user append-only limits (`core_risk_limits`) with the tighten-now /
loosen-next-session rule, seed defaults as data (`core_risk_limit_defaults`), the persistent per-user kill
switch (`core_kill_switch`) whose "on" also calls the old silos' existing square-off and kill entry
points through one adapter, REST under `/api/trade-core/risk/*`, and a web **Core Risk** page. Out of
scope: execution, orders, fills and the cash ledger (M3), positions and exits (M4), the journal table, the
Chartink fan-out that will build intents and the comparison view (M5), docs → drafts (M6). Nothing in M2
places, simulates or exits a trade of the core. Amended after the owner's answers (2026-10-10, see the
end of this plan): owner-only editing of the global seed defaults (Task 11, 16), and a minimal kill check
at every silo's new-entry point and the auto-execution/auto-trade entry paths (Tasks 12, 13). Apart from
those guard lines, the old silos are not edited; M2 only **calls** their existing square-off entry points.

**Goal:** The owner opens **Core Risk** and sees every limit of spec §5.2 for their account, seeded from
their settings where an equivalent exists and otherwise marked "default — please review". Tightening a
limit takes effect at once; loosening shows a "pending" badge with the next session open from
`SessionClock`. The kill switch survives restarts; turning it on blocks every core entry immediately and
calls each silo's square-off/kill path, reporting each result; turning it off is scheduled for the next
session open; while it is on, no silo opens a new position. The owner can also change the seed defaults
that new users start from. Every change is audited. `RiskWallService.check(intent)` returns a fail-closed,
reduce-only verdict that M3–M5 consume.

**Architecture:** A second part of the existing `apps/api/src/modules/trade-core/` module, `risk-wall/`.
Four pure modules carry all the rules: `limits/limit-keys.ts` (the vocabulary: kind, tighter direction,
scopes, parsing, comparison), `limits/append-only.ts` (which row is in force and which is pending),
`session-open.ts` (vehicle → exchange, next session open), and `risk-wall.ts` (`checkRisk`,
`decideDailyLoss`). Two thin repositories wrap Prisma with a per-user advisory lock and strictly
increasing `createdAt`. Three services hold the I/O: `CoreRiskLimitService` (lazy seed, list, change),
`CoreKillSwitchService` (get, set, cascade) and `RiskWallService` (gathers context, calls `checkRisk`,
records the verdict). What M3–M5 own is reached through four injection tokens with fail-closed M2
defaults: `RISK_STATE_PROVIDER` (throws, so every entry is rejected), `RISK_VERDICT_SINK` (logs),
`CORE_SQUARE_OFF` (reports that no core positions exist yet) and `CORE_SESSION_CLOCK`. The silo cascade
is one adapter, `SiloSquareOffAdapter`, which resolves each silo's existing service with
`ModuleRef.get(token, { strict: false })` so no silo module's exports change. The reverse direction is
one small gate, `kill-gate.ts` (`coreEntryAllowed` / `assertCoreEntryAllowed`), backed by the injectable,
5-second-cached `CoreKillSwitchReader`; each silo's entry point calls it in one or two lines. The web page is a TanStack
Query consumer over two pure modules (`coreRisk.ts` wire client, `core-risk.ts` logic).

**Tech Stack:** NestJS 11, TypeScript 5.7, Prisma 6 (PostgreSQL), class-validator, Jest 29 (`ts-jest`,
`isolatedModules`) for the API; React 19 + Vite 6 + Vitest 2 (node environment, no DOM renderer) +
TanStack Query 5 for the web app; pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-10-09-sp2-core-trade-lifecycle-design.md` (§2 D1, D4, D5, D6; §3
module layout, naming and tenant scoping; §5.1–5.4; §9; the M2 parts of §10; the §11 M2 row). Parent:
`docs/superpowers/specs/2026-09-30-ai-trading-core-architecture-design.md` §7.1 (fails closed, kill switch
cancels and exits and halts, limits changed only by the owner and audited; D5 refines "outside market
hours" to "loosen next session"). Format and patterns: `docs/superpowers/plans/2026-10-09-sp2-m1-strategy-catalogue.md`.

**Branch:** `feature/sp2-m2-risk-wall`, from `main` (HEAD `c1d5933` when this plan was written).

**Test commands:**
- API: `pnpm --filter @td/api test -- <file-pattern>`. Jest `rootDir` is `apps/api/src`, `testRegex` is
  `.*\.spec\.ts$`. Example: `pnpm --filter @td/api test -- limit-keys`.
- Web: `pnpm --filter @td/web test -- <file-pattern>` (`vitest run <filter>`, node environment).
- Opt-in database test (Task 4): `apps/api/test/sp2-m2/jest.config.js`, against a throwaway local
  container on 127.0.0.1 only.

## Design decisions (planner rulings)

1. **Layout and names.** Everything lives in `apps/api/src/modules/trade-core/risk-wall/` (spec §3):
   `limits/` (pure vocabulary, resolution, seed values), `repositories/`, `services/`, `controllers/`,
   `dto/`, `testing/`, plus `risk-wall.types.ts`, `risk-wall.ts`, `session-open.ts` and `ports.ts`.
   Models `CoreRiskLimit`, `CoreRiskLimitDefault`, `CoreKillSwitch`; tables `core_risk_limits`,
   `core_risk_limit_defaults`, `core_kill_switch` (spec §3 naming). The module stays `TradeCoreModule`.
2. **`RiskWall.check` is the pure `checkRisk(intent, ctx)`.** It collects **every** failing reason (not
   the first) so the M5 journal shows all causes, then sizes. It never throws: any input it cannot
   evaluate (a malformed limit value, an invalid date) becomes `REJECT` with `CONTEXT_UNAVAILABLE`.
   `RiskWallService.check(intent)` gathers the context and is also fail-closed: a throwing provider or
   repository becomes a `REJECT`, and a verdict that cannot be recorded is turned into `REJECT`
   (`JOURNAL_UNAVAILABLE`) unless it was already a reject. Exits return `ALLOW` with `EXIT_NOT_CHECKED`
   without loading any context, and a recording failure never blocks an exit (spec §5.1).
3. **M2 defines the contracts M3/M4/M5 must meet; it builds none of them.** `CoreEntryIntent`,
   `CoreExitIntent`, `RiskOpenPosition`, `RiskLiveState`, `RiskVerdict` and `DailyLossDecision` live in
   `risk-wall.types.ts`. The live state comes through `RISK_STATE_PROVIDER`, whose M2 binding
   (`UnavailableRiskStateProvider`) throws, so until M3/M4 rebind it **every entry is rejected**
   (fail-closed and visible: reason `CONTEXT_UNAVAILABLE`). The intent carries the producer's own
   freshness verdict (`refPriceFresh`) and capital model (`capitalPerUnit`, `lotSize`): the wall owns no
   staleness threshold or margin rule (those are §6.3/§6.5, M3). "Notes for later milestones" says
   exactly how M3/M4/M5 provide each field.
4. **No verdict table in M2.** The journal (`core_journal`, `RISK_VERDICT` rows with the limits snapshot)
   is M5 (spec §8.1, §11). M2 returns everything the journal needs (`RiskVerdict`: verdict, quantities,
   reasons, the full limits snapshot with row ids, a state snapshot, the daily-loss decision, the kill
   switch state, the time) and hands it to `RISK_VERDICT_SINK`, which logs it in M2 and which M5 rebinds
   to the journal. No code path in M2 produces an entry intent, so no verdict is produced in production
   before M5; a table now would be an inert, silent store. The spec's "blocked for the rest of the
   session" (§5.3) is the state field `dailyLossLatched`, which M4/M5 derive from the journal.
5. **Limits are append-only rows; one pure function says which is in force.** A row is
   `(userId, key, scope, numValue DECIMAL(14,2) | textValue, effectiveFrom, source, setBy, reason, createdAt)`.
   The row **in force** is the most recently *created* row whose `effectiveFrom ≤ now` (spec §5.2); the
   **pending** change is the newest row when it is not yet effective. Consequences, all tested: a
   tightening made after a pending loosening supersedes it for good; re-entering the value in force is
   `SAME`, takes effect now and so cancels a pending loosening; the direction is judged against the value
   **in force**, never the pending one; a pair with no usable row counts as loosest, so setting it is a
   loosening. The repositories take a per-user advisory lock and give every new row a `createdAt`
   strictly after the user's newest row, so "most recently created" is never a tie.
6. **"Next session open" is `SessionClock.nextOpen` for the scope's exchanges.** Vehicles map to venues
   in one constant (`CASH_INTRADAY`, `MTF` → NSE; `OPTIONS_BUY` → NFO). A per-vehicle scope uses its
   venue; `ALL` (and the kill switch) uses the **latest** next open across NSE and NFO, so a loosening
   never lands inside any vehicle's session. If no open is found within the clock's 14-day search the
   change is refused with 409 and nothing is written. The core builds its own `SessionClock` from
   `MARKET_HOLIDAYS` (the hub's source, `market-holidays.service.ts:79`); MCX late close is not
   configured because no core vehicle trades MCX. No cron is needed: the time rule is evaluated on read.
7. **Seeding is lazy, idempotent and data-driven (D4).** `CoreRiskLimitService.ensureSeeded(userId)`
   inserts, under the user lock, a row for every `(key, scope)` the user has none for: the `UserSettings`
   equivalent when one exists (source `USER_SETTINGS`), else the row in `core_risk_limit_defaults`
   (source `DEFAULT`, reason "default — please review (…)"). It runs on the first `GET /risk/limits`, on
   every `PUT`, and inside `RiskWallService.check`, so a new user never trades on missing limits and
   existing users need no migration-time copy (one code path, unit-tested). The defaults are rows in the
   M2 migration, never constants in code. Equivalents (each enforced today by the old risk manager):

   | Core limit | `UserSettings` field | Schema | Old enforcement |
   |---|---|---|---|
   | `maxDailyLoss` @ ALL | `maxDailyLoss` | `prisma/schema.prisma:405` | `risk-manager.service.ts:73-78`, rule at `:196-218` (`totalDailyPnl < 0 && abs ≥ max`, `:204`) |
   | `maxOpenPositions` @ ALL | `maxConcurrentPositions` | `prisma/schema.prisma:407` | `risk-manager.service.ts:80-85`, rule at `:220-240` |
   | `optionsMaxPremiumPerTrade` @ OPTIONS_BUY | `maxCapitalPerTrade` (order value per trade; an option buy's order value is its premium) | `prisma/schema.prisma:406` | `risk-manager.service.ts:87-92`, rule at `:242-263` |

   Not equivalents: `defaultRiskReward` (`:408`, a target ratio), `tradingHoursOnly` (`:411`, the wall
   always checks the session), `paperTrading`/`autoTradeMode` (`:403-404`, modes). An `ADMIN` with no
   settings row of their own seeds from the platform row stamped `SYSTEM_USER_ID`, which is the row the
   Settings page edits (`settings.service.ts:38-48` reads `findFirst` and creates it for
   `SYSTEM_USER_ID`). `GET /risk/limits` may therefore write the seed once (audited
   `CORE_RISK_LIMITS_SEEDED`); the spec's "GET is read-only" rule is about the kill switch (§5.4), whose
   GET never writes. The owner accepted all three equivalents and the platform-row fallback, and the schema
   column defaults for users with no settings row (Owner answers 1). The defaults themselves are editable
   at any time by the owner (decision 20), and every user can change every one of their own 21 limits at
   any time on the Risk page (tighter now, looser at the next open).
8. **The kill switch is append-only rows too** (`active`, `effectiveFrom`, `setBy`, `reason`). On:
   `effectiveFrom = now`, written **without** the concurrency check (a safety press is never refused
   with 409), then the cascade runs, and pressing it again runs the cascade again. Off while on: a
   loosening (D5), `effectiveFrom` = next session open across NSE/NFO; the view keeps `active: true` and
   shows `pendingRelease`. Off while off: effective now. On after a pending release cancels the release
   (decision 5's rule). Persistence is the table, so a restart changes nothing.
9. **One adapter calls the silos' existing entry points, in this order, each isolated:**

   | # | Target | Entry point called (unchanged) | Who | Why this order |
   |---|---|---|---|---|
   | 1 | `auto-execution` | `AutoExecSettingsService.update(userId, seg, { killSwitch: true })` for `INTRADAY` and `SWING` (`auto-exec-settings.service.ts:91`; the same per-user flag the UI's auto-exec kill switch sets) | every user, for themself | blocks new auto entries first |
   | 2 | `watch-monitor` | `WatchService.squareOffAll('manual')` (`watch.service.ts:1083`; the UI kill button's `POST /api/watch/square-off-all`, `watch.controller.ts:111-120`) | owner only | |
   | 3 | `adaptive-stop-track` | `AdaptiveStopTickPoller.eodSquareOff()` (`adaptive-stop-tick-poller.service.ts:96`; the manual `POST /api/adaptive-stop/square-off`, `adaptive-stop.controller.ts:25-34`) | owner only | |
   | 4 | `ungated-track` | `UngatedTickPoller.eodSquareOff()` (`ungated-tick-poller.service.ts:95`; the manual `POST /api/ungated/square-off`, `ungated-track.controller.ts:35-52`, whose before/after TRADED count the adapter repeats with `UngatedWatchRepository.findAllActive()`) | owner only | |
   | 5 | `sell-futures-track` | `SellFuturesService.squareOffOpenPositions()` (`sell-futures.service.ts:429`, the 15:15 cron's body) | owner only | |
   | 6 | `trade-engine` | `TradeExecutionService.closeAllPositions(reason)` (`trade-execution.service.ts:620`; `POST /api/trades/close-all`): sets the in-memory `RiskManagerService` kill switch (`risk-manager.service.ts:130-137`), sets `autoTradeMode` OFF (`settings.service.ts:117-131`), closes open trades | owner only | last: closing every open `Trade` first would make the silo square-offs above fail on already-closed paper trades |

   The silo tables carry no `userId` and the silo controllers are `@AdminOnly` (e.g.
   `ungated-track.controller.ts:21`), so these are platform-wide owner tracks: a non-owner's kill switch
   reports them `SKIPPED` ("owner only") and never touches them. `TradeExecutionService.closeAllPositions`
   flips a **process-global** in-memory flag that has no caller to clear it
   (`deactivateKillSwitch`, `risk-manager.service.ts:142`, is never called), so a non-owner must not
   reach it. Several services are not exported by their modules (`AdaptiveStopTickPoller`,
   `UngatedTickPoller`, `UngatedWatchRepository`), so the adapter resolves every target with
   `ModuleRef.get(Class, { strict: false })`; no silo module, export or file changes. Each step reports
   `OK | FAILED | SKIPPED | UNAVAILABLE` with a detail line; a partial result (errors, skipped
   no-price exits, positions still open) is `FAILED`, never `OK`. One step's failure never stops the
   next. The results go back in the response and into a `CORE_KILL_SWITCH_CASCADE` audit entry.
   **Square-off gaps (no square-off entry point exists, none is added):** `breakout-swing-track` has only
   a per-entry cancel for resting `QUEUED` entries (`breakout-swing.controller.ts:21-28`) and its exits are
   private (`breakout-swing-poller.service.ts:173`); `anand-dual-track` has no square-off path
   (`expireIntradayAtClose`, `anand-price-monitor.service.ts:38`, is an end-of-day mark-to-market expiry,
   not a kill); `trade-sentinel` is shadow-only with no close authority (by design). Their **open**
   positions keep running to their own exits. **Re-entry is now closed** (owner answer 2, decision 21):
   every silo's new-entry point refuses while the switch is on, so no silo opens anything after the
   press. The silos' own unwritten `killSwitchAt` fields (`adaptive-stop-account.service.ts:98`,
   `ungated-paper-account.service.ts:99`, `sell-futures-paper-account.service.ts:103`) stay untouched.
   The core's own orders and positions are cancelled and exited through `CORE_SQUARE_OFF`, which M3/M4
   implement. The owner confirmed step 6 (trade-engine) on 2026-10-10; clearing its in-memory flag needs
   an API restart (production gate).
10. **Limits and the kill switch are the caller's own** (spec §3 tenant scoping, §5.2 "per user").
    No route is `@AdminOnly`; every query names the token's `userId`; both models join `TENANT_MODELS`.
    Nobody can read or change another user's limits in M2 (no admin override). The **page** is
    ADMIN-only like the M1 page (`RequireRole`, nav badge `SP2`); opening it to users later is the same
    one-line change M1 noted.
11. **Money is `DECIMAL(14,2)`** (owner decision, M1). Rupee limits, counts and the leverage ratio share
    `numValue DECIMAL(14,2)`; CHECKs pin whole numbers for counts, ≥ 1 for leverage, ≥ 0 and not NaN for
    all. Times (`HH:MM` IST) and the action enum use `textValue`. The wire carries numbers for numeric
    kinds (M1's serialisation decision, `toSelectionDto`) and strings for the others; the audit log
    carries the canonical strings (`"5000.00"`, `"15:00"`).
12. **Append-only is enforced twice.** The repositories have no update or delete method, and a
    `BEFORE UPDATE` trigger on both tables refuses any update. `DELETE` stays possible only so deleting
    a user cascades; no code issues one.
13. **Daily loss (spec §5.3).** A loss "reaches" the limit when it is a real loss (> ₹0) and at least
    the limit, the rule the old manager uses (`risk-manager.service.ts:204`). `decideDailyLoss` returns
    `OK | BREACHED | UNKNOWN`; `squareOffCore` is true only for `BREACHED` with
    `BLOCK_AND_SQUARE_OFF`, never for `UNKNOWN` (squaring off on missing data would be a drastic act on
    no evidence; entries are rejected either way). M4 calls `CORE_SQUARE_OFF` with cause `DAILY_LOSS`
    when it sees `squareOffCore`.
14. **Conflict rule (parent §6.3).** One open or pending core position per symbol per user, and never
    long and short on one underlying. Exposure is `exposureOf(vehicle, side, optionType)`: a bought PE
    is SHORT the underlying, a bought CE is LONG. `PENDING_ENTRY` positions count for the conflict rule
    and for the position limits.
15. **Sizing reduces only.** Caps: risk per trade (`|refPrice − stopPrice|` per unit), the vehicle's
    capital headroom (`maxCapitalDeployed − deployed`, divided by `capitalPerUnit`), and for options the
    premium per trade. Each cap is rounded **down** to whole lots. `qty = min(requested, caps)`; equal →
    `ALLOW`; smaller but ≥ one lot → `RESIZE` naming the binding cap(s); below one lot → `REJECT`. An
    intent with no stop is rejected (`RISK_UNKNOWN`): its risk cannot be computed.
16. **Time limits.** Entries are rejected at or after the vehicle's `lastEntryTime` and at or after its
    `squareOffTime` (IST). `squareOffTime` and `mtfMaxHoldDays` are also in the snapshot for M4 to freeze
    into the position (spec §6.5, §7.1).
17. **Audit after the write, strictly** (M1 decision 14). New actions in a new `risk` group:
    `CORE_RISK_LIMITS_SEEDED`, `CORE_RISK_LIMIT_CHANGED`, `CORE_KILL_SWITCH_SET`,
    `CORE_KILL_SWITCH_CASCADE`, `CORE_RISK_DEFAULT_CHANGED`. For "on", the order is persist → cascade →
    audit, so a failing audit can never stop the square-off (it surfaces as a 500 after everything has
    happened).
18. **No `@td/shared` import, no cron, `LIVE_TRADING_ENABLED` untouched.** The adapter imports silo
    classes only as injection tokens; the ratchet spec `common/schedule/cron-timezone.spec.ts` is
    untouched because M2 adds no schedule.
19. **Cash intraday squares off at 15:25 by default** (owner answer 1), Ungated's own EOD
    (`ungated-tick-poller.service.ts:94`), so Ungated v1's 15:25 time exit is never cut short; Adaptive-Stop
    v1 keeps its own 15:15 time exit inside that limit. All other proposed defaults are accepted as
    starting values.
20. **The seed defaults are owner-editable data** (owner answer 1: "keep all the values dynamic and a
    place from where I can configure them anytime"). `core_risk_limit_defaults` gains `updatedBy` and
    `updatedAt`; `GET/PUT /api/trade-core/risk/defaults[/:key/:scope]` are `@AdminOnly` and the service
    re-checks `role === 'ADMIN'`. A change is immediate (no user has a default "in force"; it only feeds
    future seeds), its reason replaces the row's `note`, it is audited `CORE_RISK_DEFAULT_CHANGED`, and it
    never reads, rewrites or appends any `core_risk_limits` row (tested). The table is not append-only;
    its CHECKs still pin the vocabulary and shapes.
21. **A kill check at every silo's new-entry point** (owner answer 2). One gate, `kill-gate.ts`, behind
    one injectable reader, `CoreKillSwitchReader` (cache ≤ 5 s, cleared on every switch change, errors
    never cached). Platform silos and auto-trade ask "is any ADMIN's switch on" (they have no user);
    auto-execution asks about its own user. The gate fails closed: an unreadable state or an unwired reader
    refuses the entry and logs it. Each silo gets an import and one or two guard lines at the point where
    it opens a position (Task 13 cites each file:line); exits, stops, trails and square-offs never reach
    the gate. The gate is a module-level function rather than a constructor dependency so no silo
    constructor or existing silo spec changes; the reader registers itself on module init, and unit tests
    get an "off" reader from a Jest setup file (production has no default).

## Global Constraints

- **Approach A (D1), as amended by the owner (2026-10-10):** the only silo edits are the entry guards of
  Task 13: one import plus one or two guard lines each in the nine files listed there (insertions only,
  `0` deletions). Nothing else changes under `modules/watch-monitor/`, `modules/adaptive-stop-track/`,
  `modules/ungated-track/`, `modules/sell-futures-track/`, `modules/breakout-swing-track/`,
  `modules/anand-dual-track/`, `modules/auto-execution/`, `modules/auto-trade/`, and nothing at all under
  `modules/trade-engine/`, `modules/settings/`, `modules/chartink/` or any other module. Exits, stops,
  trails and square-offs are never blocked. M2 otherwise only **calls** existing silo entry points (decision 9).
- **`LIVE_TRADING_ENABLED` stays `false`** and is not read or written by M2.
- **No hard-coded risk values (D4):** every limit value is a row (`core_risk_limits` per user, seed rows
  in `core_risk_limit_defaults`). The only literals in new code are shape bounds (money fits
  DECIMAL(14,2), a count is a whole number ≥ 0, leverage ≥ 1, a time is `HH:MM`, a reason is 3–500
  characters), the vehicle → exchange venue map and the reader's ≤ 5 s cache bound. Every seed default
  is editable by the owner at any time (decision 20).
- **Tighten now, loosen next session (D5):** the only `effectiveFrom` values are `now` (tighter or same)
  and `SessionClock` next open (looser, and kill switch off).
- **Tenant scoping:** `core_risk_limits` and `core_kill_switch` carry `userId`; every read and write
  filters by the caller's JWT `userId`, never a body or path value; `CoreRiskLimit` and `CoreKillSwitch`
  are in `TENANT_MODELS`; `core_risk_limit_defaults` is global.
- **Fail closed:** anything the wall cannot compute is a `REJECT` with the reason; exits are never
  checked or blocked.
- **Naming:** `Core` prefix for models and services, `core_*` tables, kebab-case routes under
  `/api/trade-core/risk/`.
- **Crons:** none added. Any future cron pins `timeZone: 'Asia/Kolkata'`
  (`common/schedule/cron-timezone.spec.ts` ratchet).
- **Money:** `Decimal(14,2)` in the database; exact 2-dp strings in audit meta.
- **Typecheck:** new API code adds **no** `tsc` error; compare the sorted error **lists** with `main`
  (169 lines, the `@td/shared` moduleResolution class), not the counts. The web `tsc --noEmit` stays clean.
- **Audit:** every seed, limit change, kill switch change and cascade appends an
  `AUDIT_ACTIONS.risk.*` entry.
- **Web tests:** Vitest in a node environment with no DOM; every decision the page makes is a pure
  function with a spec; no new test infrastructure.
- **Real-database tests** only against a throwaway local container on 127.0.0.1.
- **Commits:** explicit pathspecs (`git commit -m … -- <paths>`), never a bare `git commit` or `-a`. Every
  message ends with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Review Focus

1. **One user's limits or kill switch must never touch another user, and a non-owner must never touch
   the platform silos.** (Task 5 test "every read filters by the caller's userId"; Task 8 test "user B
   is never affected by user A's switch"; Task 7 test "a non-owner sets only their own auto-execution
   kill flag and never resolves a platform silo"; Task 10 test "routes take the user from the token".)
2. **A loosening must never take effect inside the current session, and a later tightening must
   cancel a pending loosening.** (Task 2 tests "a tightening made after a pending loosening supersedes
   it for good" and "picks the latest open across exchanges"; Task 6 tests "a looser change waits for
   the next session open", "re-entering the value in force cancels a pending loosening" and "no known
   session open: 409, nothing written".)
3. **Anything the wall cannot compute must reject, including the M2 defaults that stand in for M3/M4.**
   Missing limits, unknown P&L, a malformed stored value, the default state provider, a failing
   recorder. (Task 3 tests "fails closed on every limit the vehicle needs", "a malformed limit value
   rejects instead of throwing" and "unknown P&L rejects but never squares off"; Task 9 tests "the M2
   default state provider rejects every entry" and "a recording failure turns ALLOW into REJECT"; Task 12
  test "fails closed when the state cannot be read, or no reader is wired"; Task 13's "fails closed when
  the switch cannot be read" case for every silo entry point.)
4. **The kill switch press must never be refused and never silently partial.** (Task 8 tests "turning
   on skips the concurrency check" and "a core failure is reported and the silos still run"; Task 7
   tests "one failing silo does not stop the rest" and "partial results are FAILED, not OK".)
5. **Sizing only ever reduces, in whole lots, and exits always pass.** (Task 3 tests "never returns more
   than was asked", "rounds options down to whole lots", "rejects when a cap leaves less than one lot"
   and "exits pass even with the kill switch on"; Task 9 test "exits pass without loading context, even
   when recording fails".)

---

## File Structure

| Path | Responsibility |
|---|---|
| Create `apps/api/src/modules/trade-core/risk-wall/limits/limit-keys.ts` | Limit vocabulary, parsing, storage mapping, direction (pure) |
| Create `apps/api/src/modules/trade-core/risk-wall/limits/append-only.ts` | `resolveAppendOnly` (pure) |
| Create `apps/api/src/modules/trade-core/risk-wall/session-open.ts` | `VEHICLE_EXCHANGES`, `exchangesForScope`, `nextSessionOpen`, `istMinutesOf` (pure) |
| Create `apps/api/src/modules/trade-core/risk-wall/risk-wall.types.ts` | Intent, live state, verdict types |
| Create `apps/api/src/modules/trade-core/risk-wall/risk-wall.ts` | `checkRisk`, `decideDailyLoss`, `exposureOf`, `requiredLimitPairs`, `exitVerdict`, `rejectVerdict` (pure) |
| Create `apps/api/src/modules/trade-core/risk-wall/testing/risk-fixtures.ts` | Test data |
| Modify `prisma/schema.prisma` | `CoreRiskLimit`, `CoreRiskLimitDefault`, `CoreKillSwitch`; two `User` relation fields |
| Create `prisma/migrations/20261010120000_sp2_m2_risk_wall/migration.sql` | Tables, CHECKs, append-only trigger, seed defaults |
| Modify `apps/api/src/common/tenant/tenant.constants.ts` | Two tenant models |
| Create `apps/api/src/modules/trade-core/risk-wall/core-risk-defaults.spec.ts` | Seed defaults cover every pair and match their sources |
| Create `apps/api/test/sp2-m2/jest.config.js`, `apps/api/test/sp2-m2/core-risk.int.spec.ts` | Opt-in real-database test |
| Modify `apps/api/src/common/audit/audit-actions.ts` | `risk` action group |
| Create `apps/api/src/modules/trade-core/risk-wall/repositories/core-risk-limit.repository.ts` | Limit rows, defaults, settings for the seed |
| Create `apps/api/src/modules/trade-core/risk-wall/repositories/core-kill-switch.repository.ts` | Kill switch rows |
| Create `apps/api/src/modules/trade-core/risk-wall/limits/seed-values.ts` | `SETTINGS_EQUIVALENTS`, `seedValueFor` (pure) |
| Create `apps/api/src/modules/trade-core/risk-wall/ports.ts` | Tokens, port interfaces, M2 default bindings, `createCoreSessionClock` |
| Create `apps/api/src/modules/trade-core/risk-wall/services/core-risk-limit.service.ts` | ensureSeeded, list, inForce, change |
| Create `apps/api/src/modules/trade-core/risk-wall/services/silo-square-off.adapter.ts` | The one adapter to the silos |
| Create `apps/api/src/modules/trade-core/risk-wall/services/core-kill-switch.service.ts` | get, isActive, set, cascade |
| Create `apps/api/src/modules/trade-core/risk-wall/services/risk-wall.service.ts` | Context assembly around `checkRisk` |
| Create `apps/api/src/modules/trade-core/risk-wall/dto/core-risk.dto.ts` | Request DTOs |
| Create `apps/api/src/modules/trade-core/risk-wall/controllers/core-risk.controller.ts` | `/api/trade-core/risk/*` |
| Modify `apps/api/src/modules/trade-core/trade-core.module.ts`, `trade-core.module.spec.ts`, `apps/api/src/app.module.ts` (comment) | Wiring |
| Create `apps/api/src/modules/trade-core/risk-wall/services/core-risk-defaults.service.ts`, `controllers/core-risk-defaults.controller.ts` | Owner-only seed defaults (decision 20) |
| Create `apps/api/src/modules/trade-core/risk-wall/kill-gate.ts` | The silo entry gate (decision 21) |
| Create `apps/api/src/modules/trade-core/risk-wall/services/core-kill-switch.reader.ts` | Cached, fail-closed kill switch reader |
| Create `apps/api/test/setup/core-kill-gate.ts`; modify `apps/api/package.json` (`jest.setupFiles`) | "Off" reader for unit tests only |
| Modify 9 silo files (Task 13) | One import + guard lines each |
| Create `apps/api/src/modules/trade-core/risk-wall/silo-entry-guards.spec.ts` | Every silo guard, by file:line |
| Create `apps/web/src/services/coreRisk.ts` | Wire types and calls |
| Create `apps/web/src/pages/core-risk/core-risk.ts` | Pure page logic |
| Create `apps/web/src/pages/core-risk/CoreRiskPage.tsx` | The page |
| Create `apps/web/src/services/coreRiskDefaults.ts`, `apps/web/src/pages/core-risk/core-risk-defaults.ts`, `RiskDefaultsSection.tsx` | Owner seed defaults section |
| Modify `apps/web/src/App.tsx`, `apps/web/src/components/layout/navItems.ts` | Route and nav entry |

---

### Task 1: Limit vocabulary, parsing and tighter direction (pure)

**Files:**
- Create: `apps/api/src/modules/trade-core/risk-wall/limits/limit-keys.ts`
- Test: `apps/api/src/modules/trade-core/risk-wall/limits/limit-keys.spec.ts`

**Interfaces:**
- Consumes: `VEHICLES` (`strategies/blocks/block-types.ts:11`), `toCapitalDecimal` (`strategies/dto/core-strategy.dto.ts`).
- Produces:

```typescript
export const LIMIT_SCOPES: readonly ['ALL', 'CASH_INTRADAY', 'MTF', 'OPTIONS_BUY'];
export type LimitScope = (typeof LIMIT_SCOPES)[number];
export const DAILY_LOSS_ACTIONS: readonly ['BLOCK_ENTRIES', 'BLOCK_AND_SQUARE_OFF'];
export type DailyLossAction = (typeof DAILY_LOSS_ACTIONS)[number];
export type LimitKind = 'rupees' | 'count' | 'ratio' | 'hhmm' | 'enum';
export type TighterDirection = 'lower' | 'earlier' | 'stricter';
export const LIMIT_KEYS: { [key]: { kind; tighter; scopes } };   // 12 keys, spec §5.2
export type LimitKey = keyof typeof LIMIT_KEYS;
export const LIMIT_KEY_NAMES: LimitKey[];
export interface LimitPair { key: LimitKey; scope: LimitScope }
export const LIMIT_PAIRS: readonly LimitPair[];                  // 21 pairs, display order
export function pairId(p: { key: string; scope: string }): string;   // "maxOpenPositions@MTF"
export function isLimitKey(s: string): s is LimitKey;
export function isLimitPair(key: string, scope: string): boolean;
export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };
export function parseLimitValue(key: LimitKey, raw: unknown): Parsed<string>;  // canonical string
export interface StoredLimitValue { numValue: Prisma.Decimal | null; textValue: string | null }
export function toStorage(key: LimitKey, canonical: string): StoredLimitValue;
export function fromStorage(key: LimitKey, numValue: Prisma.Decimal | null, textValue: string | null): string | null;
export function wireValue(key: LimitKey, canonical: string): number | string;
export type ChangeDirection = 'TIGHTER' | 'SAME' | 'LOOSER';
export function compareLimit(key: LimitKey, current: string, proposed: string): ChangeDirection;
export function hhmmToMinutes(hhmm: string): number;
```

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/modules/trade-core/risk-wall/limits/limit-keys.spec.ts`:

```typescript
import { Prisma } from '@prisma/client';
import {
  compareLimit,
  fromStorage,
  hhmmToMinutes,
  isLimitKey,
  isLimitPair,
  LIMIT_KEY_NAMES,
  LIMIT_KEYS,
  LIMIT_PAIRS,
  pairId,
  parseLimitValue,
  toStorage,
  wireValue,
} from './limit-keys';

const D = (s: string) => new Prisma.Decimal(s);

describe('limit vocabulary (spec §5.2)', () => {
  it('declares every key with its tighter direction', () => {
    expect(Object.fromEntries(LIMIT_KEY_NAMES.map((k) => [k, LIMIT_KEYS[k].tighter]))).toEqual({
      maxDailyLoss: 'lower',
      maxDailyLossPerStrategy: 'lower',
      maxTradesPerDay: 'lower',
      maxOpenPositions: 'lower',
      maxRiskPerTrade: 'lower',
      maxCapitalDeployed: 'lower',
      mtfMaxLeverage: 'lower',
      mtfMaxHoldDays: 'lower',
      optionsMaxPremiumPerTrade: 'lower',
      lastEntryTime: 'earlier',
      squareOffTime: 'earlier',
      dailyLossAction: 'stricter',
    });
  });

  it('has 21 (key, scope) pairs: totals, and per vehicle where the spec says so', () => {
    expect(LIMIT_PAIRS.map(pairId)).toEqual([
      'maxDailyLoss@ALL', 'maxDailyLossPerStrategy@ALL', 'maxTradesPerDay@ALL',
      'maxOpenPositions@ALL', 'maxOpenPositions@CASH_INTRADAY', 'maxOpenPositions@MTF', 'maxOpenPositions@OPTIONS_BUY',
      'maxRiskPerTrade@ALL',
      'maxCapitalDeployed@CASH_INTRADAY', 'maxCapitalDeployed@MTF', 'maxCapitalDeployed@OPTIONS_BUY',
      'mtfMaxLeverage@MTF', 'mtfMaxHoldDays@MTF', 'optionsMaxPremiumPerTrade@OPTIONS_BUY',
      'lastEntryTime@CASH_INTRADAY', 'lastEntryTime@MTF', 'lastEntryTime@OPTIONS_BUY',
      'squareOffTime@CASH_INTRADAY', 'squareOffTime@MTF', 'squareOffTime@OPTIONS_BUY',
      'dailyLossAction@ALL',
    ]);
  });

  it('knows which keys and scopes exist, and refuses prototype names', () => {
    expect(isLimitKey('maxDailyLoss')).toBe(true);
    for (const bad of ['toString', 'constructor', '__proto__', 'hasOwnProperty', 'MAXDAILYLOSS', '']) {
      expect(isLimitKey(bad)).toBe(false);
    }
    expect(isLimitPair('maxOpenPositions', 'MTF')).toBe(true);
    expect(isLimitPair('maxDailyLoss', 'MTF')).toBe(false);
    expect(isLimitPair('mtfMaxLeverage', 'ALL')).toBe(false);
    expect(isLimitPair('nope', 'ALL')).toBe(false);
  });
});

describe('parseLimitValue', () => {
  it('rupees: a JSON number with at most 2 dp, 0 or more, below 10^12, kept as a 2-dp string', () => {
    expect(parseLimitValue('maxDailyLoss', 5000)).toEqual({ ok: true, value: '5000.00' });
    expect(parseLimitValue('maxDailyLoss', 0)).toEqual({ ok: true, value: '0.00' });
    expect(parseLimitValue('maxRiskPerTrade', 1234.5)).toEqual({ ok: true, value: '1234.50' });
    for (const bad of ['5000', NaN, Infinity, -1, 1.234, 1e12, null, undefined, true]) {
      expect(parseLimitValue('maxDailyLoss', bad).ok).toBe(false);
    }
  });

  it('count: a whole number, 0 or more', () => {
    expect(parseLimitValue('maxTradesPerDay', 20)).toEqual({ ok: true, value: '20' });
    expect(parseLimitValue('maxOpenPositions', 0)).toEqual({ ok: true, value: '0' });
    for (const bad of [1.5, -1, '3', NaN, 1e12]) expect(parseLimitValue('mtfMaxHoldDays', bad).ok).toBe(false);
  });

  it('ratio: 1 or more with at most 2 dp', () => {
    expect(parseLimitValue('mtfMaxLeverage', 2)).toEqual({ ok: true, value: '2.00' });
    expect(parseLimitValue('mtfMaxLeverage', 1)).toEqual({ ok: true, value: '1.00' });
    for (const bad of [0.5, 0, -2, 2.555, '2']) expect(parseLimitValue('mtfMaxLeverage', bad).ok).toBe(false);
  });

  it('hhmm: a 24-hour IST time', () => {
    expect(parseLimitValue('lastEntryTime', '15:00')).toEqual({ ok: true, value: '15:00' });
    expect(parseLimitValue('squareOffTime', '09:05')).toEqual({ ok: true, value: '09:05' });
    for (const bad of ['9:05', '24:00', '15:60', '1500', 1500, '']) expect(parseLimitValue('lastEntryTime', bad).ok).toBe(false);
  });

  it('enum: one of the daily-loss actions', () => {
    expect(parseLimitValue('dailyLossAction', 'BLOCK_AND_SQUARE_OFF')).toEqual({ ok: true, value: 'BLOCK_AND_SQUARE_OFF' });
    for (const bad of ['block_entries', 'SQUARE_OFF', 1, null]) expect(parseLimitValue('dailyLossAction', bad).ok).toBe(false);
  });
});

describe('storage', () => {
  it('numeric kinds go to numValue, times and the action to textValue, and back unchanged', () => {
    expect(toStorage('maxDailyLoss', '5000.00')).toEqual({ numValue: D('5000.00'), textValue: null });
    expect(toStorage('lastEntryTime', '15:00')).toEqual({ numValue: null, textValue: '15:00' });
    expect(fromStorage('maxDailyLoss', D('5000'), null)).toBe('5000.00');
    expect(fromStorage('maxOpenPositions', D('5.00'), null)).toBe('5');
    expect(fromStorage('mtfMaxLeverage', D('2'), null)).toBe('2.00');
    expect(fromStorage('lastEntryTime', null, '15:00')).toBe('15:00');
    expect(fromStorage('dailyLossAction', null, 'BLOCK_ENTRIES')).toBe('BLOCK_ENTRIES');
  });

  it('a stored row that does not fit its key reads as null (the wall then fails closed)', () => {
    expect(fromStorage('maxDailyLoss', null, '5000')).toBeNull();
    expect(fromStorage('maxDailyLoss', null, null)).toBeNull();
    expect(fromStorage('maxOpenPositions', D('2.5'), null)).toBeNull();
    expect(fromStorage('lastEntryTime', D('900'), null)).toBeNull();
    expect(fromStorage('lastEntryTime', null, '9am')).toBeNull();
    expect(fromStorage('dailyLossAction', null, 'PANIC')).toBeNull();
  });

  it('the wire carries numbers for numeric kinds and strings otherwise', () => {
    expect(wireValue('maxDailyLoss', '5000.00')).toBe(5000);
    expect(wireValue('maxOpenPositions', '5')).toBe(5);
    expect(wireValue('squareOffTime', '15:15')).toBe('15:15');
    expect(wireValue('dailyLossAction', 'BLOCK_ENTRIES')).toBe('BLOCK_ENTRIES');
  });
});

describe('compareLimit (D5 direction)', () => {
  it('lower is tighter for money, counts and leverage', () => {
    expect(compareLimit('maxDailyLoss', '5000.00', '4000.00')).toBe('TIGHTER');
    expect(compareLimit('maxDailyLoss', '5000.00', '5000.00')).toBe('SAME');
    expect(compareLimit('maxDailyLoss', '5000.00', '5000.01')).toBe('LOOSER');
    expect(compareLimit('maxOpenPositions', '5', '10')).toBe('LOOSER');
    expect(compareLimit('mtfMaxLeverage', '2.00', '1.50')).toBe('TIGHTER');
  });

  it('earlier is tighter for times', () => {
    expect(compareLimit('lastEntryTime', '15:00', '14:30')).toBe('TIGHTER');
    expect(compareLimit('squareOffTime', '15:15', '15:20')).toBe('LOOSER');
    expect(compareLimit('squareOffTime', '15:15', '15:15')).toBe('SAME');
  });

  it('BLOCK_AND_SQUARE_OFF is tighter than BLOCK_ENTRIES', () => {
    expect(compareLimit('dailyLossAction', 'BLOCK_ENTRIES', 'BLOCK_AND_SQUARE_OFF')).toBe('TIGHTER');
    expect(compareLimit('dailyLossAction', 'BLOCK_AND_SQUARE_OFF', 'BLOCK_ENTRIES')).toBe('LOOSER');
    expect(compareLimit('dailyLossAction', 'BLOCK_ENTRIES', 'BLOCK_ENTRIES')).toBe('SAME');
  });

  it('hhmmToMinutes counts minutes since IST midnight', () => {
    expect(hhmmToMinutes('00:00')).toBe(0);
    expect(hhmmToMinutes('15:15')).toBe(915);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @td/api test -- limit-keys`
Expected: FAIL with `Cannot find module './limit-keys'`.

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/modules/trade-core/risk-wall/limits/limit-keys.ts`:

```typescript
import { Prisma } from '@prisma/client';
import { VEHICLES } from '../../strategies/blocks/block-types';
import { toCapitalDecimal } from '../../strategies/dto/core-strategy.dto';

/**
 * The Risk Wall's limit vocabulary (spec §5.2). Each key declares its kind, the
 * direction that makes it tighter (D5) and the scopes it exists at. There are NO
 * limit values here (D4): values live in core_risk_limits (per user) and the seed
 * defaults in core_risk_limit_defaults (data). The only literals are shape bounds.
 */
export const LIMIT_SCOPES = ['ALL', ...VEHICLES] as const;
export type LimitScope = (typeof LIMIT_SCOPES)[number];

/** Ordered loosest → tightest (spec §5.2: BLOCK_ENTRIES < BLOCK_AND_SQUARE_OFF). */
export const DAILY_LOSS_ACTIONS = ['BLOCK_ENTRIES', 'BLOCK_AND_SQUARE_OFF'] as const;
export type DailyLossAction = (typeof DAILY_LOSS_ACTIONS)[number];

export type LimitKind = 'rupees' | 'count' | 'ratio' | 'hhmm' | 'enum';
export type TighterDirection = 'lower' | 'earlier' | 'stricter';

interface LimitKeySpec {
  kind: LimitKind;
  tighter: TighterDirection;
  scopes: readonly LimitScope[];
}

const PER_VEHICLE = ['CASH_INTRADAY', 'MTF', 'OPTIONS_BUY'] as const;

export const LIMIT_KEYS = {
  maxDailyLoss: { kind: 'rupees', tighter: 'lower', scopes: ['ALL'] },
  maxDailyLossPerStrategy: { kind: 'rupees', tighter: 'lower', scopes: ['ALL'] },
  maxTradesPerDay: { kind: 'count', tighter: 'lower', scopes: ['ALL'] },
  maxOpenPositions: { kind: 'count', tighter: 'lower', scopes: ['ALL', ...PER_VEHICLE] },
  maxRiskPerTrade: { kind: 'rupees', tighter: 'lower', scopes: ['ALL'] },
  maxCapitalDeployed: { kind: 'rupees', tighter: 'lower', scopes: PER_VEHICLE },
  mtfMaxLeverage: { kind: 'ratio', tighter: 'lower', scopes: ['MTF'] },
  mtfMaxHoldDays: { kind: 'count', tighter: 'lower', scopes: ['MTF'] },
  optionsMaxPremiumPerTrade: { kind: 'rupees', tighter: 'lower', scopes: ['OPTIONS_BUY'] },
  lastEntryTime: { kind: 'hhmm', tighter: 'earlier', scopes: PER_VEHICLE },
  squareOffTime: { kind: 'hhmm', tighter: 'earlier', scopes: PER_VEHICLE },
  dailyLossAction: { kind: 'enum', tighter: 'stricter', scopes: ['ALL'] },
} as const satisfies Record<string, LimitKeySpec>;

export type LimitKey = keyof typeof LIMIT_KEYS;
export const LIMIT_KEY_NAMES = Object.keys(LIMIT_KEYS) as LimitKey[];

export interface LimitPair {
  key: LimitKey;
  scope: LimitScope;
}

/** Every (key, scope) a user has; the wall rejects when one it needs is missing. Display order. */
export const LIMIT_PAIRS: readonly LimitPair[] = LIMIT_KEY_NAMES.flatMap((key) =>
  (LIMIT_KEYS[key].scopes as readonly LimitScope[]).map((scope) => ({ key, scope })),
);

export const pairId = (p: { key: string; scope: string }): string => `${p.key}@${p.scope}`;

export function isLimitKey(s: string): s is LimitKey {
  return Object.prototype.hasOwnProperty.call(LIMIT_KEYS, s);
}

export function isLimitPair(key: string, scope: string): boolean {
  return isLimitKey(key) && (LIMIT_KEYS[key].scopes as readonly string[]).includes(scope);
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const isTextKind = (kind: LimitKind): boolean => kind === 'hhmm' || kind === 'enum';

/** A request value (JSON number or string) → the canonical stored string, or why not. */
export function parseLimitValue(key: LimitKey, raw: unknown): Parsed<string> {
  switch (LIMIT_KEYS[key].kind) {
    case 'rupees': {
      const d = toCapitalDecimal(raw);
      return d
        ? { ok: true, value: d.toFixed(2) }
        : { ok: false, error: 'must be a rupee amount: 0 or more, at most 2 decimal places, below 10^12' };
    }
    case 'count':
      return typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 && raw < 1e12
        ? { ok: true, value: String(raw) }
        : { ok: false, error: 'must be a whole number, 0 or more' };
    case 'ratio': {
      const d = toCapitalDecimal(raw);
      return d && d.gte(1)
        ? { ok: true, value: d.toFixed(2) }
        : { ok: false, error: 'must be a number of 1 or more with at most 2 decimal places' };
    }
    case 'hhmm':
      return typeof raw === 'string' && HHMM.test(raw)
        ? { ok: true, value: raw }
        : { ok: false, error: 'must be an IST time as HH:MM (24-hour)' };
    case 'enum':
      return typeof raw === 'string' && (DAILY_LOSS_ACTIONS as readonly string[]).includes(raw)
        ? { ok: true, value: raw }
        : { ok: false, error: `must be one of ${DAILY_LOSS_ACTIONS.join(', ')}` };
  }
}

export interface StoredLimitValue {
  numValue: Prisma.Decimal | null;
  textValue: string | null;
}

export function toStorage(key: LimitKey, canonical: string): StoredLimitValue {
  return isTextKind(LIMIT_KEYS[key].kind)
    ? { numValue: null, textValue: canonical }
    : { numValue: new Prisma.Decimal(canonical), textValue: null };
}

/** The canonical value of a stored row, or null when the row does not fit its key (treated as missing). */
export function fromStorage(key: LimitKey, numValue: Prisma.Decimal | null, textValue: string | null): string | null {
  const kind = LIMIT_KEYS[key].kind;
  if (isTextKind(kind)) {
    if (numValue !== null || textValue === null) return null;
    const p = parseLimitValue(key, textValue);
    return p.ok ? p.value : null;
  }
  if (textValue !== null || numValue === null) return null;
  const n = kind === 'count' ? (numValue.isInteger() ? numValue.toNumber() : NaN) : numValue.toNumber();
  const p = parseLimitValue(key, n);
  return p.ok ? p.value : null;
}

export function wireValue(key: LimitKey, canonical: string): number | string {
  return isTextKind(LIMIT_KEYS[key].kind) ? canonical : Number(canonical);
}

export function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

export type ChangeDirection = 'TIGHTER' | 'SAME' | 'LOOSER';

/** D5: is `proposed` tighter than, equal to, or looser than `current` for this key? */
export function compareLimit(key: LimitKey, current: string, proposed: string): ChangeDirection {
  const kind = LIMIT_KEYS[key].kind;
  let diff: number;
  if (kind === 'hhmm') {
    diff = hhmmToMinutes(proposed) - hhmmToMinutes(current);
  } else if (kind === 'enum') {
    const rank = (v: string) => (DAILY_LOSS_ACTIONS as readonly string[]).indexOf(v);
    diff = rank(current) - rank(proposed);
  } else {
    diff = new Prisma.Decimal(proposed).comparedTo(current);
  }
  return diff < 0 ? 'TIGHTER' : diff === 0 ? 'SAME' : 'LOOSER';
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @td/api test -- limit-keys`
Expected: PASS (15 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/trade-core/risk-wall/limits/limit-keys.ts apps/api/src/modules/trade-core/risk-wall/limits/limit-keys.spec.ts
git commit -m "feat(trade-core): risk limit vocabulary with tighter directions (pure)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/api/src/modules/trade-core/risk-wall/limits/limit-keys.ts apps/api/src/modules/trade-core/risk-wall/limits/limit-keys.spec.ts
```

---

### Task 2: Which row is in force, and the next session open (pure)

**Files:**
- Create: `apps/api/src/modules/trade-core/risk-wall/limits/append-only.ts`
- Create: `apps/api/src/modules/trade-core/risk-wall/session-open.ts`
- Test: `apps/api/src/modules/trade-core/risk-wall/limits/append-only.spec.ts`
- Test: `apps/api/src/modules/trade-core/risk-wall/session-open.spec.ts`

**Interfaces:**
- Consumes: `LimitScope` (Task 1), `VEHICLES`/`Vehicle` (M1), `SessionClock` (`market-hub/session-clock.ts`), `MARKET_HOLIDAYS` (`market-data/services/market-holidays.service.ts:79`, tests only).
- Produces:

```typescript
// limits/append-only.ts
export interface AppendOnlyRow { id: string; effectiveFrom: Date; createdAt: Date }
export interface Resolved<T> { inForce: T | null; pending: T | null; newest: T | null }
export function resolveAppendOnly<T extends AppendOnlyRow>(rows: readonly T[], now: Date): Resolved<T>;

// session-open.ts
export const VEHICLE_EXCHANGES: Readonly<Record<Vehicle, readonly string[]>>;   // CASH_INTRADAY/MTF → NSE, OPTIONS_BUY → NFO
export function exchangesForScope(scope: LimitScope): string[];
export const ALL_CORE_EXCHANGES: readonly string[];                              // ['NSE', 'NFO']
export function nextSessionOpen(clock: Pick<SessionClock, 'nextOpen'>, exchanges: readonly string[], now: Date): Date | null;
export function istMinutesOf(at: Date): number;
```

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/modules/trade-core/risk-wall/limits/append-only.spec.ts`:

```typescript
import { resolveAppendOnly, type AppendOnlyRow } from './append-only';

const T = (iso: string) => new Date(iso);
const row = (id: string, createdAt: string, effectiveFrom: string = createdAt): AppendOnlyRow => ({
  id,
  createdAt: T(createdAt),
  effectiveFrom: T(effectiveFrom),
});

// Mon 2026-10-12 10:30 IST; the next session open is Tue 2026-10-13 09:15 IST (03:45Z).
const NOW = T('2026-10-12T05:00:00.000Z');
const NEXT_OPEN = '2026-10-13T03:45:00.000Z';

describe('resolveAppendOnly (spec §5.2: the latest row whose effectiveFrom ≤ now)', () => {
  it('no rows: nothing in force, nothing pending', () => {
    expect(resolveAppendOnly([], NOW)).toEqual({ inForce: null, pending: null, newest: null });
  });

  it('a row effective exactly now is in force', () => {
    const r = row('a', '2026-10-12T05:00:00.000Z');
    expect(resolveAppendOnly([r], NOW)).toEqual({ inForce: r, pending: null, newest: r });
  });

  it('a loosening waits: the old row stays in force and the new one is pending until its time', () => {
    const old = row('a', '2026-10-09T03:00:00.000Z');
    const loosen = row('b', '2026-10-12T04:00:00.000Z', NEXT_OPEN);
    expect(resolveAppendOnly([old, loosen], NOW)).toEqual({ inForce: old, pending: loosen, newest: loosen });
    expect(resolveAppendOnly([old, loosen], T(NEXT_OPEN))).toEqual({ inForce: loosen, pending: null, newest: loosen });
  });

  it('a tightening made after a pending loosening supersedes it for good', () => {
    const old = row('a', '2026-10-09T03:00:00.000Z');
    const loosen = row('b', '2026-10-12T04:00:00.000Z', NEXT_OPEN);
    const tighten = row('c', '2026-10-12T04:30:00.000Z');
    const at = (iso: string) => resolveAppendOnly([old, loosen, tighten], T(iso));
    expect(at('2026-10-12T05:00:00.000Z')).toEqual({ inForce: tighten, pending: null, newest: tighten });
    expect(at(NEXT_OPEN).inForce).toBe(tighten);
    expect(at('2026-10-20T05:00:00.000Z').inForce).toBe(tighten);
  });

  it('two loosenings before the open: the newer one is pending and is the one that takes effect', () => {
    const old = row('a', '2026-10-09T03:00:00.000Z');
    const first = row('b', '2026-10-12T04:00:00.000Z', NEXT_OPEN);
    const second = row('c', '2026-10-12T04:10:00.000Z', NEXT_OPEN);
    expect(resolveAppendOnly([second, old, first], NOW)).toEqual({ inForce: old, pending: second, newest: second });
    expect(resolveAppendOnly([second, old, first], T(NEXT_OPEN)).inForce).toBe(second);
  });

  it('does not depend on input order', () => {
    const a = row('a', '2026-10-09T03:00:00.000Z');
    const b = row('b', '2026-10-10T03:00:00.000Z');
    expect(resolveAppendOnly([b, a], NOW).inForce).toBe(b);
    expect(resolveAppendOnly([a, b], NOW).inForce).toBe(b);
  });
});
```

Create `apps/api/src/modules/trade-core/risk-wall/session-open.spec.ts`:

```typescript
import { MARKET_HOLIDAYS } from '../../market-data/services/market-holidays.service';
import { SessionClock } from '../../market-hub/session-clock';
import { ALL_CORE_EXCHANGES, exchangesForScope, istMinutesOf, nextSessionOpen, VEHICLE_EXCHANGES } from './session-open';

const clock = new SessionClock({ holidays: MARKET_HOLIDAYS });
const T = (iso: string) => new Date(iso);

describe('vehicle venues', () => {
  it('cash and MTF trade on NSE, option buying on NFO', () => {
    expect(VEHICLE_EXCHANGES).toEqual({ CASH_INTRADAY: ['NSE'], MTF: ['NSE'], OPTIONS_BUY: ['NFO'] });
    expect(exchangesForScope('OPTIONS_BUY')).toEqual(['NFO']);
    expect(exchangesForScope('MTF')).toEqual(['NSE']);
    expect(exchangesForScope('ALL')).toEqual(['NSE', 'NFO']);
    expect(ALL_CORE_EXCHANGES).toEqual(['NSE', 'NFO']);
  });
});

describe('nextSessionOpen (D5: a looser change waits for this)', () => {
  it('Friday 11:00 IST → Monday 09:15 IST', () => {
    expect(nextSessionOpen(clock, ['NSE'], T('2026-10-09T05:30:00.000Z'))).toEqual(T('2026-10-12T03:45:00.000Z'));
  });

  it('before today’s open → today’s open', () => {
    expect(nextSessionOpen(clock, ['NSE'], T('2026-10-12T02:30:00.000Z'))).toEqual(T('2026-10-12T03:45:00.000Z'));
  });

  it('during the session → tomorrow’s open, never later today', () => {
    expect(nextSessionOpen(clock, ALL_CORE_EXCHANGES, T('2026-10-12T05:00:00.000Z'))).toEqual(T('2026-10-13T03:45:00.000Z'));
  });

  it('skips an exchange holiday (Dussehra, Tue 2026-10-20)', () => {
    expect(nextSessionOpen(clock, ['NFO'], T('2026-10-19T10:30:00.000Z'))).toEqual(T('2026-10-21T03:45:00.000Z'));
  });

  it('picks the latest open across exchanges', () => {
    const fake = { nextOpen: (ex: string) => (ex === 'NSE' ? T('2026-10-13T03:45:00.000Z') : T('2026-10-14T03:45:00.000Z')) };
    expect(nextSessionOpen(fake, ['NSE', 'NFO'], T('2026-10-12T05:00:00.000Z'))).toEqual(T('2026-10-14T03:45:00.000Z'));
  });

  it('null when any exchange has no known open, or no exchange is given', () => {
    const fake = { nextOpen: (ex: string) => (ex === 'NSE' ? T('2026-10-13T03:45:00.000Z') : null) };
    expect(nextSessionOpen(fake, ['NSE', 'NFO'], T('2026-10-12T05:00:00.000Z'))).toBeNull();
    expect(nextSessionOpen(clock, [], T('2026-10-12T05:00:00.000Z'))).toBeNull();
  });
});

describe('istMinutesOf', () => {
  it('converts an instant to minutes since IST midnight', () => {
    expect(istMinutesOf(T('2026-10-12T05:00:00.000Z'))).toBe(10 * 60 + 30);
    expect(istMinutesOf(T('2026-10-12T18:29:00.000Z'))).toBe(23 * 60 + 59);
    expect(istMinutesOf(T('2026-10-12T18:30:00.000Z'))).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @td/api test -- append-only session-open`
Expected: FAIL with `Cannot find module './append-only'` and `Cannot find module './session-open'`.

- [ ] **Step 3: Write the implementations**

Create `apps/api/src/modules/trade-core/risk-wall/limits/append-only.ts`:

```typescript
/**
 * Append-only rows with a future effectiveFrom (limits and the kill switch, spec
 * §5.2 and §5.4). The row in force is the most recently CREATED row whose
 * effectiveFrom ≤ now; the pending change is the newest row while it is not yet
 * effective. So a later row that is already effective (a tightening, or the same
 * value again) supersedes an earlier pending loosening for good. Repositories make
 * createdAt strictly increasing per user; id breaks a tie deterministically.
 */
export interface AppendOnlyRow {
  id: string;
  effectiveFrom: Date;
  createdAt: Date;
}

export interface Resolved<T> {
  inForce: T | null;
  pending: T | null;
  newest: T | null;
}

const newestFirst = (a: AppendOnlyRow, b: AppendOnlyRow): number =>
  b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

export function resolveAppendOnly<T extends AppendOnlyRow>(rows: readonly T[], now: Date): Resolved<T> {
  const sorted = [...rows].sort(newestFirst);
  const newest = sorted[0] ?? null;
  const inForce = sorted.find((r) => r.effectiveFrom.getTime() <= now.getTime()) ?? null;
  const pending = newest && newest.effectiveFrom.getTime() > now.getTime() ? newest : null;
  return { inForce, pending, newest };
}
```

Create `apps/api/src/modules/trade-core/risk-wall/session-open.ts`:

```typescript
import type { SessionClock } from '../../market-hub/session-clock';
import { VEHICLES, type Vehicle } from '../strategies/blocks/block-types';
import type { LimitScope } from './limits/limit-keys';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** Where each core vehicle trades (a venue map, not a risk value). */
export const VEHICLE_EXCHANGES: Readonly<Record<Vehicle, readonly string[]>> = {
  CASH_INTRADAY: ['NSE'],
  MTF: ['NSE'],
  OPTIONS_BUY: ['NFO'],
};

export function exchangesForScope(scope: LimitScope): string[] {
  const vehicles: readonly Vehicle[] = scope === 'ALL' ? VEHICLES : [scope];
  return [...new Set(vehicles.flatMap((v) => VEHICLE_EXCHANGES[v]))];
}

export const ALL_CORE_EXCHANGES: readonly string[] = exchangesForScope('ALL');

/**
 * D5: when a looser change may take effect. The LATEST next open across the given
 * exchanges, so it never lands inside any of their sessions; null when any exchange
 * has no open within the clock's 14-day search (the caller refuses the change).
 */
export function nextSessionOpen(
  clock: Pick<SessionClock, 'nextOpen'>,
  exchanges: readonly string[],
  now: Date,
): Date | null {
  if (exchanges.length === 0) return null;
  let latest: Date | null = null;
  for (const exchange of exchanges) {
    const open = clock.nextOpen(exchange, now);
    if (!open) return null;
    if (!latest || open.getTime() > latest.getTime()) latest = open;
  }
  return latest;
}

/** Minutes since IST midnight. */
export function istMinutesOf(at: Date): number {
  const d = new Date(at.getTime() + IST_OFFSET_MS);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @td/api test -- append-only session-open`
Expected: PASS (6 + 8 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/trade-core/risk-wall/limits/append-only.ts apps/api/src/modules/trade-core/risk-wall/limits/append-only.spec.ts apps/api/src/modules/trade-core/risk-wall/session-open.ts apps/api/src/modules/trade-core/risk-wall/session-open.spec.ts
git commit -m "feat(trade-core): append-only resolution and next-session-open for risk changes (pure)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/api/src/modules/trade-core/risk-wall/limits/append-only.ts apps/api/src/modules/trade-core/risk-wall/limits/append-only.spec.ts apps/api/src/modules/trade-core/risk-wall/session-open.ts apps/api/src/modules/trade-core/risk-wall/session-open.spec.ts
```

---

### Task 3: The Risk Wall check (pure): `checkRisk`, `decideDailyLoss`

**Files:**
- Create: `apps/api/src/modules/trade-core/risk-wall/risk-wall.types.ts`
- Create: `apps/api/src/modules/trade-core/risk-wall/risk-wall.ts`
- Create: `apps/api/src/modules/trade-core/risk-wall/testing/risk-fixtures.ts`
- Test: `apps/api/src/modules/trade-core/risk-wall/risk-wall.spec.ts`

**Interfaces:**
- Consumes: `LIMIT_PAIRS`, `hhmmToMinutes`, `LimitKey`, `LimitScope`, `LimitPair`, `DailyLossAction`, `pairId` (Task 1); `istMinutesOf`, `VEHICLE_EXCHANGES` (Task 2); `VEHICLES`, `Vehicle` (M1).
- Produces (types file, consumed by every later task and by M3–M5):

```typescript
export type Direction = 'LONG' | 'SHORT';
export type LimitSource = 'USER' | 'USER_SETTINGS' | 'DEFAULT';
export interface CoreEntryIntent { kind: 'ENTRY'; intentId; userId; strategyId; strategyVersionId; vehicle: Vehicle; exchange; symbol; underlying; side: 'BUY' | 'SELL'; optionType: 'CE' | 'PE' | null; qty; lotSize; refPrice; refPriceFresh: boolean; stopPrice: number | null; capitalPerUnit; mtfLeverage: number | null }
export interface CoreExitIntent { kind: 'EXIT'; intentId; userId; positionId; qty }
export type CoreIntent = CoreEntryIntent | CoreExitIntent;
export type CorePositionState = 'PENDING_ENTRY' | 'OPEN' | 'PARTIAL' | 'EXITING';
export interface RiskOpenPosition { positionId; strategyId; vehicle; symbol; underlying; direction: Direction; state: CorePositionState; priced: boolean }
export interface RiskLiveState { asOf: Date; openPositions; realisedPnlToday: number; openPnl: number | null; pnlTodayByStrategy: Record<string, number>; tradesToday: number; deployedCapital: Record<Vehicle, number | null>; dailyLossLatched: boolean }
export interface LimitInForce { key: LimitKey; scope: LimitScope; value: string; rowId: string; effectiveFrom: string; source: LimitSource }
export interface RiskContext { now: Date; limits: readonly LimitInForce[]; killSwitchActive: boolean; sessionOpen: boolean; state: RiskLiveState }
export const RISK_REASON_CODES: readonly [...];  export type RiskReasonCode;  export interface RiskReason { code; message }
export type RiskVerdictKind = 'ALLOW' | 'REJECT' | 'RESIZE';
export interface DailyLossDecision { status: 'OK' | 'BREACHED' | 'UNKNOWN'; lossRupees: string | null; limitRupees: string | null; action: DailyLossAction | null; squareOffCore: boolean }
export interface RiskStateSnapshot { asOf; realisedPnlToday: string | null; openPnl: string | null; tradesToday; openPositions; openPositionsByVehicle; deployedCapital; dailyLossLatched }
export interface RiskVerdict { intentId; userId; intentKind: 'ENTRY' | 'EXIT'; verdict: RiskVerdictKind; requestedQty; qty; reasons: RiskReason[]; limits: LimitInForce[]; state: RiskStateSnapshot | null; dailyLoss: DailyLossDecision | null; killSwitchActive: boolean | null; checkedAt: string }
```

and (logic file):

```typescript
export function exposureOf(vehicle: Vehicle, side: 'BUY' | 'SELL', optionType: 'CE' | 'PE' | null): Direction;
export function requiredLimitPairs(vehicle: Vehicle): LimitPair[];
export function decideDailyLoss(limits: readonly LimitInForce[], state: RiskLiveState): DailyLossDecision;
export function checkRisk(intent: CoreIntent, ctx: RiskContext): RiskVerdict;
export function exitVerdict(intent: CoreExitIntent, now: Date): RiskVerdict;
export function rejectVerdict(intent: CoreEntryIntent, now: Date, code: RiskReasonCode, message: string, prior?: Partial<Pick<RiskVerdict, 'limits' | 'state' | 'dailyLoss' | 'killSwitchActive'>>): RiskVerdict;
```

- [ ] **Step 1: Write the types and the fixtures**

Create `apps/api/src/modules/trade-core/risk-wall/risk-wall.types.ts`:

```typescript
import type { Vehicle } from '../strategies/blocks/block-types';
import type { DailyLossAction, LimitKey, LimitScope } from './limits/limit-keys';

export type Direction = 'LONG' | 'SHORT';
export type LimitSource = 'USER' | 'USER_SETTINGS' | 'DEFAULT';

/**
 * An entry the core wants to make (spec §3: alert/evaluator → CoreEntryIntent →
 * RiskWall.check). M2 fixes the fields the wall reads; M5 builds the intent (Chartink
 * fan-out and evaluators) using M3's vehicle model for capitalPerUnit and lotSize.
 */
export interface CoreEntryIntent {
  kind: 'ENTRY';
  /** Unique per intent: the M5 journal key and the root of M3's order idempotency key. */
  intentId: string;
  userId: string;
  strategyId: string;
  strategyVersionId: string;
  vehicle: Vehicle;
  /** NSE for CASH_INTRADAY and MTF, NFO for OPTIONS_BUY (VEHICLE_EXCHANGES). */
  exchange: string;
  /** The traded symbol: the equity, or the option contract. */
  symbol: string;
  /** The equity the exposure is on (equal to symbol for cash and MTF). */
  underlying: string;
  side: 'BUY' | 'SELL';
  /** CE or PE for OPTIONS_BUY, else null. A bought PE is SHORT the underlying. */
  optionType: 'CE' | 'PE' | null;
  /** Requested quantity in units (shares, or option units), a whole multiple of lotSize. */
  qty: number;
  /** 1 for cash and MTF; the contract lot size for options. */
  lotSize: number;
  /** ₹ per unit the size was computed from (the premium for options). */
  refPrice: number;
  /** The producer's freshness verdict for refPrice (hub / execution threshold, spec §6.3). */
  refPriceFresh: boolean;
  /** The initial stop in refPrice units; null when the strategy has none (rejected: risk unknown). */
  stopPrice: number | null;
  /** ₹ of capital one unit blocks under M3's vehicle model: cash = price ÷ leverage, MTF = own share, options = premium. */
  capitalPerUnit: number;
  /** MTF only: notional ÷ own funds. Null for the other vehicles. */
  mtfLeverage: number | null;
}

/** Exits are never checked (spec §5.1); the type exists so an exit that reaches the wall passes visibly. */
export interface CoreExitIntent {
  kind: 'EXIT';
  intentId: string;
  userId: string;
  positionId: string;
  qty: number;
}

export type CoreIntent = CoreEntryIntent | CoreExitIntent;

export type CorePositionState = 'PENDING_ENTRY' | 'OPEN' | 'PARTIAL' | 'EXITING';

/** One open or pending core position as M4's lifecycle reports it. */
export interface RiskOpenPosition {
  positionId: string;
  strategyId: string;
  vehicle: Vehicle;
  symbol: string;
  underlying: string;
  direction: Direction;
  state: CorePositionState;
  /** Has a fresh price now (M4/hub rule). Any unpriced position blocks entries (parent §7.1). */
  priced: boolean;
}

/**
 * The user's live state (spec §5.1), provided through RISK_STATE_PROVIDER by M3 (cash
 * ledger, deployed capital) and M4 (positions, P&L). Rupees are net of charges; a
 * null means "cannot compute" and the wall rejects.
 */
export interface RiskLiveState {
  asOf: Date;
  /** Every core position of the user in PENDING_ENTRY | OPEN | PARTIAL | EXITING. */
  openPositions: readonly RiskOpenPosition[];
  /** Today's (IST) realised P&L, ₹. */
  realisedPnlToday: number;
  /** Mark-to-market P&L of the open positions, ₹; null when it cannot be computed. */
  openPnl: number | null;
  /** Today's realised + open P&L per strategyId, ₹; a strategy absent here has 0 today. */
  pnlTodayByStrategy: Readonly<Record<string, number>>;
  /** Entries placed today (IST). */
  tradesToday: number;
  /** ₹ of capital blocked per vehicle (open positions + pending entries); null = unknown. */
  deployedCapital: Readonly<Record<Vehicle, number | null>>;
  /** The daily loss limit was reached earlier this session (spec §5.3: blocked for the rest of it). */
  dailyLossLatched: boolean;
}

/** One limit in force as the wall used it: the journal's limits snapshot. */
export interface LimitInForce {
  key: LimitKey;
  scope: LimitScope;
  /** Canonical value: "5000.00", "10", "2.00", "15:00", "BLOCK_ENTRIES". */
  value: string;
  rowId: string;
  effectiveFrom: string;
  source: LimitSource;
}

export interface RiskContext {
  now: Date;
  limits: readonly LimitInForce[];
  killSwitchActive: boolean;
  /** SessionClock.isOpen(intent.exchange, now). */
  sessionOpen: boolean;
  state: RiskLiveState;
}

export const RISK_REASON_CODES = [
  'WITHIN_LIMITS',
  'EXIT_NOT_CHECKED',
  'INVALID_INTENT',
  'KILL_SWITCH',
  'LIMIT_MISSING',
  'SESSION_CLOSED',
  'STALE_PRICE',
  'UNPRICED_POSITION',
  'PNL_UNKNOWN',
  'STATE_UNKNOWN',
  'DAILY_LOSS',
  'STRATEGY_DAILY_LOSS',
  'MAX_TRADES',
  'MAX_OPEN_POSITIONS',
  'MAX_OPEN_POSITIONS_VEHICLE',
  'CONFLICT_SAME_SYMBOL',
  'CONFLICT_OPPOSITE_DIRECTION',
  'AFTER_LAST_ENTRY',
  'AFTER_SQUARE_OFF',
  'VEHICLE_SIDE',
  'MTF_LEVERAGE',
  'RISK_UNKNOWN',
  'CAP_RISK_PER_TRADE',
  'CAP_CAPITAL_DEPLOYED',
  'CAP_OPTIONS_PREMIUM',
  'CONTEXT_UNAVAILABLE',
  'JOURNAL_UNAVAILABLE',
] as const;
export type RiskReasonCode = (typeof RISK_REASON_CODES)[number];

export interface RiskReason {
  code: RiskReasonCode;
  message: string;
}

export type RiskVerdictKind = 'ALLOW' | 'REJECT' | 'RESIZE';

/** Spec §5.3. squareOffCore tells M4 to exit every core position (CORE_SQUARE_OFF, cause DAILY_LOSS). */
export interface DailyLossDecision {
  status: 'OK' | 'BREACHED' | 'UNKNOWN';
  /** 2 dp; positive = loss, negative = profit. Null when P&L is unknown. */
  lossRupees: string | null;
  limitRupees: string | null;
  action: DailyLossAction | null;
  squareOffCore: boolean;
}

export interface RiskStateSnapshot {
  asOf: string;
  realisedPnlToday: string | null;
  openPnl: string | null;
  tradesToday: number;
  openPositions: number;
  openPositionsByVehicle: Record<Vehicle, number>;
  deployedCapital: Record<Vehicle, string | null>;
  dailyLossLatched: boolean;
}

/** Everything M5's RISK_VERDICT journal row needs (spec §5.1, §8.1). */
export interface RiskVerdict {
  intentId: string;
  userId: string;
  intentKind: 'ENTRY' | 'EXIT';
  verdict: RiskVerdictKind;
  requestedQty: number;
  /** ALLOW = requested; RESIZE = less than requested and at least one lot; REJECT = 0. */
  qty: number;
  reasons: RiskReason[];
  /** The limits snapshot used (empty when the context could not be loaded, and for exits). */
  limits: LimitInForce[];
  state: RiskStateSnapshot | null;
  dailyLoss: DailyLossDecision | null;
  killSwitchActive: boolean | null;
  checkedAt: string;
}
```

Create `apps/api/src/modules/trade-core/risk-wall/testing/risk-fixtures.ts`:

```typescript
import type { LimitKey, LimitScope } from '../limits/limit-keys';
import type { CoreEntryIntent, LimitInForce, RiskContext, RiskLiveState, RiskOpenPosition } from '../risk-wall.types';

/**
 * Test data only. These numbers are fixtures, not defaults: the seed defaults are
 * rows in the M2 migration (core-risk-defaults.spec.ts checks them).
 */
const VALUES: ReadonlyArray<readonly [LimitKey, LimitScope, string]> = [
  ['maxDailyLoss', 'ALL', '5000.00'],
  ['maxDailyLossPerStrategy', 'ALL', '2500.00'],
  ['maxTradesPerDay', 'ALL', '20'],
  ['maxOpenPositions', 'ALL', '5'],
  ['maxOpenPositions', 'CASH_INTRADAY', '5'],
  ['maxOpenPositions', 'MTF', '3'],
  ['maxOpenPositions', 'OPTIONS_BUY', '2'],
  ['maxRiskPerTrade', 'ALL', '3000.00'],
  ['maxCapitalDeployed', 'CASH_INTRADAY', '1000000.00'],
  ['maxCapitalDeployed', 'MTF', '200000.00'],
  ['maxCapitalDeployed', 'OPTIONS_BUY', '100000.00'],
  ['mtfMaxLeverage', 'MTF', '2.00'],
  ['mtfMaxHoldDays', 'MTF', '10'],
  ['optionsMaxPremiumPerTrade', 'OPTIONS_BUY', '50000.00'],
  ['lastEntryTime', 'CASH_INTRADAY', '15:00'],
  ['lastEntryTime', 'MTF', '15:00'],
  ['lastEntryTime', 'OPTIONS_BUY', '14:30'],
  ['squareOffTime', 'CASH_INTRADAY', '15:15'],
  ['squareOffTime', 'MTF', '15:20'],
  ['squareOffTime', 'OPTIONS_BUY', '15:15'],
  ['dailyLossAction', 'ALL', 'BLOCK_ENTRIES'],
];

/** Mon 2026-10-12 10:30 IST, inside the NSE/NFO session. */
export const NOW = new Date('2026-10-12T05:00:00.000Z');

/** Every pair, with overrides by "key@scope"; null removes the pair. */
export function limitsFixture(over: Record<string, string | null> = {}): LimitInForce[] {
  return VALUES.flatMap(([key, scope, value]) => {
    const id = `${key}@${scope}`;
    const v = Object.prototype.hasOwnProperty.call(over, id) ? over[id] : value;
    return v === null
      ? []
      : [{ key, scope, value: v, rowId: `lim_${id}`, effectiveFrom: '2026-10-09T03:45:00.000Z', source: 'USER' as const }];
  });
}

/** Cash intraday BUY 50 RELIANCE @ 2500, stop 2462.5 (risk 37.5/unit), 5x intraday margin (500/unit). */
export function intentFixture(over: Partial<CoreEntryIntent> = {}): CoreEntryIntent {
  return {
    kind: 'ENTRY',
    intentId: 'int_1',
    userId: 'user_A',
    strategyId: 'cs_ungated',
    strategyVersionId: 'csv_ungated_v1',
    vehicle: 'CASH_INTRADAY',
    exchange: 'NSE',
    symbol: 'RELIANCE',
    underlying: 'RELIANCE',
    side: 'BUY',
    optionType: null,
    qty: 50,
    lotSize: 1,
    refPrice: 2500,
    refPriceFresh: true,
    stopPrice: 2462.5,
    capitalPerUnit: 500,
    mtfLeverage: null,
    ...over,
  };
}

/** One lot (75) of a NIFTY CE @ 120 premium, premium stop 90. */
export function optionIntent(over: Partial<CoreEntryIntent> = {}): CoreEntryIntent {
  return intentFixture({
    vehicle: 'OPTIONS_BUY',
    exchange: 'NFO',
    symbol: 'NIFTY26OCT25000CE',
    underlying: 'NIFTY',
    optionType: 'CE',
    qty: 75,
    lotSize: 75,
    refPrice: 120,
    stopPrice: 90,
    capitalPerUnit: 120,
    ...over,
  });
}

/** MTF BUY 10 TCS @ 4000, stop 3880, 2x leverage (2000/unit own funds). */
export function mtfIntent(over: Partial<CoreEntryIntent> = {}): CoreEntryIntent {
  return intentFixture({
    vehicle: 'MTF',
    symbol: 'TCS',
    underlying: 'TCS',
    qty: 10,
    refPrice: 4000,
    stopPrice: 3880,
    capitalPerUnit: 2000,
    mtfLeverage: 2,
    ...over,
  });
}

export function positionFixture(over: Partial<RiskOpenPosition> = {}): RiskOpenPosition {
  return {
    positionId: 'pos_1',
    strategyId: 'cs_adaptive_stop',
    vehicle: 'CASH_INTRADAY',
    symbol: 'INFY',
    underlying: 'INFY',
    direction: 'LONG',
    state: 'OPEN',
    priced: true,
    ...over,
  };
}

export function stateFixture(over: Partial<RiskLiveState> = {}): RiskLiveState {
  return {
    asOf: NOW,
    openPositions: [],
    realisedPnlToday: 0,
    openPnl: 0,
    pnlTodayByStrategy: {},
    tradesToday: 0,
    deployedCapital: { CASH_INTRADAY: 0, MTF: 0, OPTIONS_BUY: 0 },
    dailyLossLatched: false,
    ...over,
  };
}

export function ctxFixture(over: Partial<RiskContext> = {}): RiskContext {
  return { now: NOW, limits: limitsFixture(), killSwitchActive: false, sessionOpen: true, state: stateFixture(), ...over };
}
```

- [ ] **Step 2: Write the failing test**

Create `apps/api/src/modules/trade-core/risk-wall/risk-wall.spec.ts`:

```typescript
import { pairId } from './limits/limit-keys';
import { checkRisk, decideDailyLoss, exposureOf, requiredLimitPairs } from './risk-wall';
import type { RiskVerdict } from './risk-wall.types';
import {
  ctxFixture,
  intentFixture,
  limitsFixture,
  mtfIntent,
  NOW,
  optionIntent,
  positionFixture,
  stateFixture,
} from './testing/risk-fixtures';

const codes = (v: RiskVerdict) => v.reasons.map((r) => r.code);
const at = (istHhmm: string) => {
  const [h, m] = istHhmm.split(':').map(Number);
  return new Date(Date.UTC(2026, 9, 12, h, m) - 5.5 * 3600_000);
};
const deployed = (cash: number | null, mtf: number | null = 0, opt: number | null = 0) =>
  stateFixture({ deployedCapital: { CASH_INTRADAY: cash, MTF: mtf, OPTIONS_BUY: opt } });

describe('checkRisk: allow, snapshot, exits', () => {
  it('allows an entry within every limit and returns the limits, state and daily-loss decision it used', () => {
    const v = checkRisk(intentFixture(), ctxFixture());
    expect(v).toMatchObject({
      intentId: 'int_1', userId: 'user_A', intentKind: 'ENTRY', verdict: 'ALLOW',
      requestedQty: 50, qty: 50, killSwitchActive: false, checkedAt: NOW.toISOString(),
    });
    expect(codes(v)).toEqual(['WITHIN_LIMITS']);
    expect(v.limits).toHaveLength(21);
    expect(v.limits[0]).toEqual({ key: 'maxDailyLoss', scope: 'ALL', value: '5000.00', rowId: 'lim_maxDailyLoss@ALL', effectiveFrom: '2026-10-09T03:45:00.000Z', source: 'USER' });
    expect(v.state).toEqual({
      asOf: NOW.toISOString(), realisedPnlToday: '0.00', openPnl: '0.00', tradesToday: 0, openPositions: 0,
      openPositionsByVehicle: { CASH_INTRADAY: 0, MTF: 0, OPTIONS_BUY: 0 },
      deployedCapital: { CASH_INTRADAY: '0.00', MTF: '0.00', OPTIONS_BUY: '0.00' },
      dailyLossLatched: false,
    });
    expect(v.dailyLoss).toEqual({ status: 'OK', lossRupees: '0.00', limitRupees: '5000.00', action: 'BLOCK_ENTRIES', squareOffCore: false });
  });

  it('allows MTF and option entries within their limits', () => {
    expect(checkRisk(mtfIntent(), ctxFixture())).toMatchObject({ verdict: 'ALLOW', qty: 10 });
    expect(checkRisk(optionIntent(), ctxFixture())).toMatchObject({ verdict: 'ALLOW', qty: 75 });
  });

  it('exits pass even with the kill switch on, no limits, a closed session and unknown P&L', () => {
    const v = checkRisk(
      { kind: 'EXIT', intentId: 'x_1', userId: 'user_A', positionId: 'pos_1', qty: 30 },
      ctxFixture({ killSwitchActive: true, limits: [], sessionOpen: false, state: stateFixture({ openPnl: null }) }),
    );
    expect(v).toMatchObject({ verdict: 'ALLOW', qty: 30, requestedQty: 30, intentKind: 'EXIT', limits: [], state: null });
    expect(codes(v)).toEqual(['EXIT_NOT_CHECKED']);
  });
});

describe('checkRisk: fails closed', () => {
  it('the kill switch rejects every entry', () => {
    const v = checkRisk(intentFixture(), ctxFixture({ killSwitchActive: true }));
    expect(v).toMatchObject({ verdict: 'REJECT', qty: 0, killSwitchActive: true });
    expect(codes(v)).toEqual(['KILL_SWITCH']);
  });

  it('fails closed on every limit the vehicle needs, and only those', () => {
    expect(requiredLimitPairs('CASH_INTRADAY')).toHaveLength(10);
    expect(requiredLimitPairs('MTF')).toHaveLength(12);
    expect(requiredLimitPairs('OPTIONS_BUY')).toHaveLength(11);
    for (const p of requiredLimitPairs('CASH_INTRADAY')) {
      const v = checkRisk(intentFixture(), ctxFixture({ limits: limitsFixture({ [pairId(p)]: null }) }));
      expect(v.verdict).toBe('REJECT');
      expect(v.reasons).toContainEqual({ code: 'LIMIT_MISSING', message: `no ${p.key} limit is in force for ${p.scope}` });
    }
    const others = limitsFixture({ 'mtfMaxLeverage@MTF': null, 'optionsMaxPremiumPerTrade@OPTIONS_BUY': null, 'maxCapitalDeployed@MTF': null });
    expect(checkRisk(intentFixture(), ctxFixture({ limits: others })).verdict).toBe('ALLOW');
  });

  it('rejects on a stale price, an unpriced open position or a closed session', () => {
    expect(codes(checkRisk(intentFixture({ refPriceFresh: false }), ctxFixture()))).toEqual(['STALE_PRICE']);
    const unpriced = stateFixture({ openPositions: [positionFixture({ priced: false })] });
    expect(codes(checkRisk(intentFixture(), ctxFixture({ state: unpriced })))).toEqual(['UNPRICED_POSITION']);
    expect(codes(checkRisk(intentFixture(), ctxFixture({ sessionOpen: false })))).toEqual(['SESSION_CLOSED']);
  });

  it('unknown P&L rejects but never squares off', () => {
    const v = checkRisk(intentFixture(), ctxFixture({ state: stateFixture({ openPnl: null }) }));
    expect(v.verdict).toBe('REJECT');
    expect(codes(v)).toEqual(['PNL_UNKNOWN']);
    expect(v.dailyLoss).toEqual({ status: 'UNKNOWN', lossRupees: null, limitRupees: '5000.00', action: 'BLOCK_ENTRIES', squareOffCore: false });
    const bso = limitsFixture({ 'dailyLossAction@ALL': 'BLOCK_AND_SQUARE_OFF' });
    expect(decideDailyLoss(bso, stateFixture({ realisedPnlToday: NaN })).squareOffCore).toBe(false);
  });

  it('a malformed limit value rejects instead of throwing', () => {
    const v = checkRisk(intentFixture(), ctxFixture({ limits: limitsFixture({ 'maxDailyLoss@ALL': 'lots' }) }));
    expect(v).toMatchObject({ verdict: 'REJECT', qty: 0 });
    expect(codes(v)).toEqual(['CONTEXT_UNAVAILABLE']);
  });

  it('rejects an entry with no stop (risk unknown) or unknown deployed capital', () => {
    expect(codes(checkRisk(intentFixture({ stopPrice: null }), ctxFixture()))).toEqual(['RISK_UNKNOWN']);
    expect(codes(checkRisk(intentFixture(), ctxFixture({ state: deployed(null) })))).toEqual(['STATE_UNKNOWN']);
    expect(codes(checkRisk(intentFixture(), ctxFixture({ state: stateFixture({ tradesToday: NaN }) })))).toEqual(['STATE_UNKNOWN']);
  });

  it('rejects a malformed intent and never resizes it', () => {
    const bad = [
      intentFixture({ qty: NaN }),
      intentFixture({ qty: 0 }),
      optionIntent({ qty: 100 }),
      intentFixture({ stopPrice: 2600 }),
      intentFixture({ exchange: 'NFO' }),
      intentFixture({ optionType: 'CE' }),
      optionIntent({ optionType: null }),
      mtfIntent({ mtfLeverage: null }),
      intentFixture({ capitalPerUnit: 0 }),
      intentFixture({ symbol: ' ' }),
    ];
    for (const intent of bad) {
      const v = checkRisk(intent, ctxFixture());
      expect(v.verdict).toBe('REJECT');
      expect(codes(v)).toContain('INVALID_INTENT');
    }
  });

  it('collects every failing reason, not just the first', () => {
    const v = checkRisk(intentFixture({ refPriceFresh: false }), ctxFixture({ killSwitchActive: true, sessionOpen: false }));
    expect(codes(v)).toEqual(['KILL_SWITCH', 'SESSION_CLOSED', 'STALE_PRICE']);
  });
});

describe('checkRisk: daily loss (spec §5.3)', () => {
  const withPnl = (realised: number, open: number) =>
    checkRisk(intentFixture(), ctxFixture({ state: stateFixture({ realisedPnlToday: realised, openPnl: open }) }));

  it('rejects once realised + open loss reaches maxDailyLoss, not before', () => {
    expect(withPnl(-3000, -1999.99).verdict).toBe('ALLOW');
    const v = withPnl(-3000, -2000);
    expect(v.verdict).toBe('REJECT');
    expect(codes(v)).toEqual(['DAILY_LOSS']);
    expect(v.dailyLoss).toEqual({ status: 'BREACHED', lossRupees: '5000.00', limitRupees: '5000.00', action: 'BLOCK_ENTRIES', squareOffCore: false });
  });

  it('stays blocked for the rest of the session once latched, even after P&L recovers', () => {
    const v = checkRisk(intentFixture(), ctxFixture({ state: stateFixture({ realisedPnlToday: 1000, dailyLossLatched: true }) }));
    expect(codes(v)).toEqual(['DAILY_LOSS']);
    expect(v.dailyLoss?.status).toBe('BREACHED');
  });

  it('only BLOCK_AND_SQUARE_OFF asks M4 to exit every core position', () => {
    const lossState = stateFixture({ realisedPnlToday: -6000 });
    expect(decideDailyLoss(limitsFixture(), lossState).squareOffCore).toBe(false);
    expect(decideDailyLoss(limitsFixture({ 'dailyLossAction@ALL': 'BLOCK_AND_SQUARE_OFF' }), lossState)).toEqual({
      status: 'BREACHED', lossRupees: '6000.00', limitRupees: '5000.00', action: 'BLOCK_AND_SQUARE_OFF', squareOffCore: true,
    });
    expect(decideDailyLoss(limitsFixture({ 'dailyLossAction@ALL': 'BLOCK_AND_SQUARE_OFF' }), stateFixture()).squareOffCore).toBe(false);
  });

  it('a profit or a flat day never breaches, even with a ₹0 limit; any loss does', () => {
    const zero = limitsFixture({ 'maxDailyLoss@ALL': '0.00' });
    expect(decideDailyLoss(zero, stateFixture()).status).toBe('OK');
    expect(decideDailyLoss(zero, stateFixture({ realisedPnlToday: 500 })).status).toBe('OK');
    expect(decideDailyLoss(zero, stateFixture({ openPnl: -0.01 })).status).toBe('BREACHED');
  });

  it('a strategy at its own daily loss limit is blocked; another strategy is not', () => {
    const v = checkRisk(intentFixture(), ctxFixture({ state: stateFixture({ pnlTodayByStrategy: { cs_ungated: -2500 } }) }));
    expect(codes(v)).toEqual(['STRATEGY_DAILY_LOSS']);
    const other = checkRisk(intentFixture(), ctxFixture({ state: stateFixture({ pnlTodayByStrategy: { cs_adaptive_stop: -2500 } }) }));
    expect(other.verdict).toBe('ALLOW');
    const unknown = checkRisk(intentFixture(), ctxFixture({ state: stateFixture({ pnlTodayByStrategy: { cs_ungated: NaN } }) }));
    expect(codes(unknown)).toEqual(['PNL_UNKNOWN']);
  });
});

describe('checkRisk: counts, conflicts, time, vehicle rules', () => {
  it('rejects at maxTradesPerDay, not before', () => {
    expect(checkRisk(intentFixture(), ctxFixture({ state: stateFixture({ tradesToday: 19 }) })).verdict).toBe('ALLOW');
    expect(codes(checkRisk(intentFixture(), ctxFixture({ state: stateFixture({ tradesToday: 20 }) })))).toEqual(['MAX_TRADES']);
  });

  it('counts open and pending positions against the total and the vehicle limits', () => {
    const five = ['A', 'B', 'C', 'D', 'E'].map((s, i) =>
      positionFixture({ positionId: `p${i}`, symbol: s, underlying: s, state: i === 0 ? 'PENDING_ENTRY' : 'OPEN' }),
    );
    expect(codes(checkRisk(intentFixture(), ctxFixture({ state: stateFixture({ openPositions: five }) })))).toEqual([
      'MAX_OPEN_POSITIONS', 'MAX_OPEN_POSITIONS_VEHICLE',
    ]);
    const threeMtf = ['A', 'B', 'C'].map((s, i) => positionFixture({ positionId: `m${i}`, vehicle: 'MTF', symbol: s, underlying: s }));
    expect(codes(checkRisk(mtfIntent(), ctxFixture({ state: stateFixture({ openPositions: threeMtf }) })))).toEqual(['MAX_OPEN_POSITIONS_VEHICLE']);
    expect(checkRisk(intentFixture(), ctxFixture({ state: stateFixture({ openPositions: threeMtf }) })).verdict).toBe('ALLOW');
  });

  it('one core position per symbol per user', () => {
    const open = stateFixture({ openPositions: [positionFixture({ symbol: 'RELIANCE', underlying: 'RELIANCE', state: 'PENDING_ENTRY' })] });
    expect(codes(checkRisk(intentFixture(), ctxFixture({ state: open })))).toEqual(['CONFLICT_SAME_SYMBOL']);
  });

  it('never long and short on one underlying: a bought PE is short, a bought CE is long', () => {
    expect(exposureOf('OPTIONS_BUY', 'BUY', 'PE')).toBe('SHORT');
    expect(exposureOf('OPTIONS_BUY', 'BUY', 'CE')).toBe('LONG');
    expect(exposureOf('CASH_INTRADAY', 'SELL', null)).toBe('SHORT');
    const pe = positionFixture({ vehicle: 'OPTIONS_BUY', symbol: 'RELIANCE26OCT2500PE', underlying: 'RELIANCE', direction: 'SHORT' });
    expect(codes(checkRisk(intentFixture(), ctxFixture({ state: stateFixture({ openPositions: [pe] }) })))).toEqual(['CONFLICT_OPPOSITE_DIRECTION']);
    const ce = positionFixture({ vehicle: 'OPTIONS_BUY', symbol: 'RELIANCE26OCT2500CE', underlying: 'RELIANCE', direction: 'LONG' });
    expect(checkRisk(intentFixture(), ctxFixture({ state: stateFixture({ openPositions: [ce] }) })).verdict).toBe('ALLOW');
  });

  it('rejects at or after the vehicle’s lastEntryTime and squareOffTime (IST)', () => {
    expect(checkRisk(intentFixture(), ctxFixture({ now: at('14:59') })).verdict).toBe('ALLOW');
    expect(codes(checkRisk(intentFixture(), ctxFixture({ now: at('15:00') })))).toEqual(['AFTER_LAST_ENTRY']);
    expect(codes(checkRisk(optionIntent(), ctxFixture({ now: at('14:30') })))).toEqual(['AFTER_LAST_ENTRY']);
    const late = limitsFixture({ 'lastEntryTime@CASH_INTRADAY': '15:29' });
    expect(codes(checkRisk(intentFixture(), ctxFixture({ now: at('15:15'), limits: late })))).toEqual(['AFTER_SQUARE_OFF']);
  });

  it('MTF is long only and capped by mtfMaxLeverage; options are buy only', () => {
    expect(codes(checkRisk(mtfIntent({ side: 'SELL', stopPrice: 4120 }), ctxFixture()))).toEqual(['VEHICLE_SIDE']);
    expect(codes(checkRisk(mtfIntent({ mtfLeverage: 2.5 }), ctxFixture()))).toEqual(['MTF_LEVERAGE']);
    expect(codes(checkRisk(optionIntent({ side: 'SELL', stopPrice: 150 }), ctxFixture()))).toEqual(['VEHICLE_SIDE']);
  });
});

describe('checkRisk: sizing reduces only', () => {
  it('resizes down to the risk cap, and leaves a smaller request alone', () => {
    const v = checkRisk(intentFixture({ qty: 100 }), ctxFixture()); // 3000 / 37.5 = 80
    expect(v).toMatchObject({ verdict: 'RESIZE', qty: 80, requestedQty: 100 });
    expect(codes(v)).toEqual(['CAP_RISK_PER_TRADE']);
    expect(checkRisk(intentFixture({ qty: 10 }), ctxFixture())).toMatchObject({ verdict: 'ALLOW', qty: 10 });
  });

  it('resizes to the vehicle’s remaining capital', () => {
    const v = checkRisk(intentFixture(), ctxFixture({ state: deployed(990000) })); // 10,000 / 500 = 20
    expect(v).toMatchObject({ verdict: 'RESIZE', qty: 20 });
    expect(codes(v)).toEqual(['CAP_CAPITAL_DEPLOYED']);
  });

  it('rounds options down to whole lots and applies the premium cap', () => {
    // premium: 50,000 / 120 = 416 units → 5 lots = 375; risk: 3000 / 1 = 3000; capital: 100,000 / 120 = 833 → 11 lots
    const v = checkRisk(optionIntent({ qty: 750, stopPrice: 119 }), ctxFixture());
    expect(v).toMatchObject({ verdict: 'RESIZE', qty: 375 });
    expect(codes(v)).toEqual(['CAP_OPTIONS_PREMIUM']);
  });

  it('rejects when a cap leaves less than one lot, or no capital is left', () => {
    const tooRisky = checkRisk(optionIntent({ stopPrice: 50 }), ctxFixture()); // 3000 / 70 = 42 units < 75
    expect(tooRisky).toMatchObject({ verdict: 'REJECT', qty: 0 });
    expect(codes(tooRisky)).toEqual(['CAP_RISK_PER_TRADE']);
    expect(codes(checkRisk(intentFixture(), ctxFixture({ state: deployed(1_000_000) })))).toEqual(['CAP_CAPITAL_DEPLOYED']);
    expect(codes(checkRisk(intentFixture(), ctxFixture({ state: deployed(1_200_000) })))).toEqual(['CAP_CAPITAL_DEPLOYED']);
  });

  it('never returns more than was asked, whatever the caps', () => {
    for (const qty of [1, 7, 80, 81, 5000]) {
      for (const cash of [0, 999_500, 2_000_000]) {
        const v = checkRisk(intentFixture({ qty }), ctxFixture({ state: deployed(cash) }));
        expect(v.qty).toBeLessThanOrEqual(qty);
        if (v.verdict === 'REJECT') expect(v.qty).toBe(0);
        if (v.verdict === 'RESIZE') expect(v.qty).toBeLessThan(qty);
        if (v.verdict === 'ALLOW') expect(v.qty).toBe(qty);
      }
    }
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @td/api test -- risk-wall.spec`
Expected: FAIL with `Cannot find module './risk-wall'`.

- [ ] **Step 4: Write the implementation**

Create `apps/api/src/modules/trade-core/risk-wall/risk-wall.ts`:

```typescript
import { Prisma } from '@prisma/client';
import { VEHICLES, type Vehicle } from '../strategies/blocks/block-types';
import { hhmmToMinutes, LIMIT_PAIRS, type DailyLossAction, type LimitKey, type LimitPair, type LimitScope } from './limits/limit-keys';
import { istMinutesOf, VEHICLE_EXCHANGES } from './session-open';
import type {
  CoreEntryIntent,
  CoreExitIntent,
  CoreIntent,
  DailyLossDecision,
  Direction,
  LimitInForce,
  RiskContext,
  RiskLiveState,
  RiskReason,
  RiskReasonCode,
  RiskStateSnapshot,
  RiskVerdict,
} from './risk-wall.types';

/**
 * The Risk Wall (spec §5.1): a pure function of the intent, the limits in force and
 * the user's live state. It may only allow, reject or REDUCE quantity; exits are never
 * checked; anything it cannot compute is a REJECT with the reason. It holds no limit
 * value of its own (D4): every number comes from ctx.limits.
 */
const D = Prisma.Decimal;
type Dec = Prisma.Decimal;

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const isVehicle = (v: unknown): v is Vehicle => (VEHICLES as readonly unknown[]).includes(v);

export function exposureOf(vehicle: Vehicle, side: 'BUY' | 'SELL', optionType: 'CE' | 'PE' | null): Direction {
  if (vehicle === 'OPTIONS_BUY') return optionType === 'PE' ? 'SHORT' : 'LONG';
  return side === 'BUY' ? 'LONG' : 'SHORT';
}

/** The limits an entry in this vehicle needs: every ALL-scope pair plus the vehicle's own. */
export function requiredLimitPairs(vehicle: Vehicle): LimitPair[] {
  return LIMIT_PAIRS.filter((p) => p.scope === 'ALL' || p.scope === vehicle);
}

class LimitReader {
  private readonly byPair = new Map<string, string>();

  constructor(limits: readonly LimitInForce[]) {
    for (const l of limits) this.byPair.set(`${l.key}@${l.scope}`, l.value);
  }

  raw(key: LimitKey, scope: LimitScope): string | null {
    return this.byPair.get(`${key}@${scope}`) ?? null;
  }

  /** Throws on a malformed value; checkRisk turns that into a REJECT. */
  dec(key: LimitKey, scope: LimitScope): Dec | null {
    const v = this.raw(key, scope);
    if (v === null) return null;
    const d = new D(v);
    if (!d.isFinite()) throw new Error(`${key}@${scope} is not a number: ${v}`);
    return d;
  }

  minutes(key: LimitKey, scope: LimitScope): number | null {
    const v = this.raw(key, scope);
    if (v === null) return null;
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) throw new Error(`${key}@${scope} is not HH:MM: ${v}`);
    return hhmmToMinutes(v);
  }
}

/** A real loss (> ₹0) at or beyond the limit: the rule risk-manager.service.ts:204 uses. */
const lossReaches = (loss: Dec, limit: Dec): boolean => loss.gt(0) && loss.gte(limit);

export function decideDailyLoss(limits: readonly LimitInForce[], state: RiskLiveState): DailyLossDecision {
  const lim = new LimitReader(limits);
  const limit = lim.dec('maxDailyLoss', 'ALL');
  const action = lim.raw('dailyLossAction', 'ALL') as DailyLossAction | null;
  const limitRupees = limit ? limit.toFixed(2) : null;
  if (!limit || !action) return { status: 'UNKNOWN', lossRupees: null, limitRupees, action, squareOffCore: false };
  const loss = finite(state.realisedPnlToday) && finite(state.openPnl)
    ? new D(0).minus(state.realisedPnlToday).minus(state.openPnl)
    : null;
  if (state.dailyLossLatched || (loss && lossReaches(loss, limit))) {
    return { status: 'BREACHED', lossRupees: loss ? loss.toFixed(2) : null, limitRupees, action, squareOffCore: action === 'BLOCK_AND_SQUARE_OFF' };
  }
  if (!loss) return { status: 'UNKNOWN', lossRupees: null, limitRupees, action, squareOffCore: false };
  return { status: 'OK', lossRupees: loss.toFixed(2), limitRupees, action, squareOffCore: false };
}

function snapshotState(state: RiskLiveState): RiskStateSnapshot {
  const money = (n: number | null): string | null => (finite(n) ? new D(n).toFixed(2) : null);
  const perVehicle = <T>(f: (v: Vehicle) => T) => Object.fromEntries(VEHICLES.map((v) => [v, f(v)])) as Record<Vehicle, T>;
  return {
    asOf: state.asOf.toISOString(),
    realisedPnlToday: money(state.realisedPnlToday),
    openPnl: money(state.openPnl),
    tradesToday: state.tradesToday,
    openPositions: state.openPositions.length,
    openPositionsByVehicle: perVehicle((v) => state.openPositions.filter((p) => p.vehicle === v).length),
    deployedCapital: perVehicle((v) => money(state.deployedCapital[v])),
    dailyLossLatched: state.dailyLossLatched,
  };
}

function intentProblems(i: CoreEntryIntent): string[] {
  if (!isVehicle(i.vehicle)) return [`unknown vehicle ${String(i.vehicle)}`];
  const out: string[] = [];
  for (const f of ['intentId', 'userId', 'strategyId', 'strategyVersionId', 'symbol', 'underlying'] as const) {
    if (typeof i[f] !== 'string' || i[f].trim() === '') out.push(`${f} is required`);
  }
  const venues = VEHICLE_EXCHANGES[i.vehicle];
  if (!venues.includes(String(i.exchange).toUpperCase())) out.push(`${i.vehicle} trades on ${venues.join('/')}, not ${String(i.exchange)}`);
  if (i.side !== 'BUY' && i.side !== 'SELL') out.push('side must be BUY or SELL');
  if (!Number.isSafeInteger(i.lotSize) || i.lotSize < 1) out.push('lotSize must be a whole number of 1 or more');
  else if (!Number.isSafeInteger(i.qty) || i.qty < 1 || i.qty % i.lotSize !== 0) out.push(`qty must be a positive whole multiple of the lot size ${i.lotSize}`);
  if (!finite(i.refPrice) || i.refPrice <= 0) out.push('refPrice must be a price above 0');
  if (!finite(i.capitalPerUnit) || i.capitalPerUnit <= 0) out.push('capitalPerUnit must be above 0');
  if (i.stopPrice !== null) {
    if (!finite(i.stopPrice) || i.stopPrice <= 0) out.push('stopPrice must be a price above 0, or null');
    else if (finite(i.refPrice) && (i.side === 'BUY' ? i.stopPrice >= i.refPrice : i.stopPrice <= i.refPrice)) {
      out.push(`a ${i.side} stop must be on the losing side of refPrice`);
    }
  }
  if (i.vehicle === 'OPTIONS_BUY') {
    if (i.optionType !== 'CE' && i.optionType !== 'PE') out.push('an option entry needs optionType CE or PE');
  } else if (i.optionType !== null) {
    out.push('optionType is only for OPTIONS_BUY');
  }
  if (i.vehicle === 'MTF') {
    if (!finite(i.mtfLeverage) || i.mtfLeverage < 1) out.push('an MTF entry needs mtfLeverage of 1 or more');
  } else if (i.mtfLeverage !== null) {
    out.push('mtfLeverage is only for MTF');
  }
  return out;
}

interface Cap {
  code: RiskReasonCode;
  qty: number;
  message: string;
}

function sizeCaps(i: CoreEntryIntent, vehicle: Vehicle, lim: LimitReader, deployedNow: number): Cap[] {
  const toLots = (units: Dec): number => {
    const whole = units.isNegative() ? new D(0) : units.floor();
    return whole.div(i.lotSize).floor().mul(i.lotSize).toNumber();
  };
  const caps: Cap[] = [];
  const maxRisk = lim.dec('maxRiskPerTrade', 'ALL') as Dec;
  const riskPerUnit = new D(i.refPrice).minus(i.stopPrice as number).abs();
  const byRisk = toLots(maxRisk.div(riskPerUnit));
  caps.push({ code: 'CAP_RISK_PER_TRADE', qty: byRisk, message: `risk ₹${riskPerUnit.toFixed(2)} per unit allows ${byRisk} units within ₹${maxRisk.toFixed(2)} per trade` });
  const maxCapital = lim.dec('maxCapitalDeployed', vehicle) as Dec;
  const headroom = maxCapital.minus(deployedNow);
  const byCapital = toLots(headroom.div(i.capitalPerUnit));
  caps.push({ code: 'CAP_CAPITAL_DEPLOYED', qty: byCapital, message: `₹${headroom.isNegative() ? '0.00' : headroom.toFixed(2)} of ${vehicle} capital left (limit ₹${maxCapital.toFixed(2)}) allows ${byCapital} units` });
  if (vehicle === 'OPTIONS_BUY') {
    const maxPremium = lim.dec('optionsMaxPremiumPerTrade', 'OPTIONS_BUY') as Dec;
    const byPremium = toLots(maxPremium.div(i.refPrice));
    caps.push({ code: 'CAP_OPTIONS_PREMIUM', qty: byPremium, message: `premium ₹${new D(i.refPrice).toFixed(2)} per unit allows ${byPremium} units within ₹${maxPremium.toFixed(2)} per trade` });
  }
  return caps;
}

function evaluateEntry(intent: CoreEntryIntent, ctx: RiskContext): RiskVerdict {
  const reasons: RiskReason[] = [];
  const add = (code: RiskReasonCode, message: string) => reasons.push({ code, message });
  const lim = new LimitReader(ctx.limits);
  const { state } = ctx;
  const vehicle = isVehicle(intent.vehicle) ? intent.vehicle : null;
  const problems = intentProblems(intent);
  for (const m of problems) add('INVALID_INTENT', m);

  if (ctx.killSwitchActive) add('KILL_SWITCH', 'the kill switch is on: no new entries');
  if (vehicle) {
    for (const p of requiredLimitPairs(vehicle)) {
      if (lim.raw(p.key, p.scope) === null) add('LIMIT_MISSING', `no ${p.key} limit is in force for ${p.scope}`);
    }
  }
  if (!ctx.sessionOpen) add('SESSION_CLOSED', `${String(intent.exchange)} is not in session`);
  if (intent.refPriceFresh !== true) add('STALE_PRICE', `no fresh price for ${String(intent.symbol)}`);
  const unpriced = state.openPositions.filter((p) => p.priced !== true);
  if (unpriced.length > 0) add('UNPRICED_POSITION', `open position(s) without a fresh price: ${unpriced.map((p) => p.symbol).join(', ')}`);

  const dailyLoss = decideDailyLoss(ctx.limits, state);
  if (dailyLoss.status === 'BREACHED') {
    add('DAILY_LOSS', `today's loss${dailyLoss.lossRupees ? ` ₹${dailyLoss.lossRupees}` : ''} has reached the ₹${dailyLoss.limitRupees} daily limit${state.dailyLossLatched ? ' (blocked for the rest of the session)' : ''}`);
  } else if (dailyLoss.status === 'UNKNOWN' && dailyLoss.limitRupees !== null && dailyLoss.action !== null) {
    add('PNL_UNKNOWN', "today's P&L cannot be computed");
  }

  const perStrategy = lim.dec('maxDailyLossPerStrategy', 'ALL');
  const byStrategy = state.pnlTodayByStrategy;
  const strategyPnl = Object.prototype.hasOwnProperty.call(byStrategy, intent.strategyId) ? byStrategy[intent.strategyId] : 0;
  if (!finite(strategyPnl)) {
    add('PNL_UNKNOWN', `today's P&L for strategy ${intent.strategyId} cannot be computed`);
  } else if (perStrategy) {
    const loss = new D(0).minus(strategyPnl);
    if (lossReaches(loss, perStrategy)) add('STRATEGY_DAILY_LOSS', `this strategy's loss today ₹${loss.toFixed(2)} has reached the ₹${perStrategy.toFixed(2)} per-strategy limit`);
  }

  const maxTrades = lim.dec('maxTradesPerDay', 'ALL');
  if (!Number.isSafeInteger(state.tradesToday) || state.tradesToday < 0) add('STATE_UNKNOWN', "today's entry count is unknown");
  else if (maxTrades && maxTrades.lte(state.tradesToday)) add('MAX_TRADES', `${state.tradesToday} entries today; the limit is ${maxTrades.toFixed(0)}`);

  const maxOpen = lim.dec('maxOpenPositions', 'ALL');
  if (maxOpen && maxOpen.lte(state.openPositions.length)) add('MAX_OPEN_POSITIONS', `${state.openPositions.length} open or pending positions; the limit is ${maxOpen.toFixed(0)}`);
  if (vehicle) {
    const maxOpenVehicle = lim.dec('maxOpenPositions', vehicle);
    const inVehicle = state.openPositions.filter((p) => p.vehicle === vehicle).length;
    if (maxOpenVehicle && maxOpenVehicle.lte(inVehicle)) add('MAX_OPEN_POSITIONS_VEHICLE', `${inVehicle} open or pending ${vehicle} positions; the limit is ${maxOpenVehicle.toFixed(0)}`);
  }

  // Conflict rule (parent §6.3).
  const symbol = String(intent.symbol).toUpperCase();
  const underlying = String(intent.underlying).toUpperCase();
  const sameSymbol = state.openPositions.find((p) => p.symbol.toUpperCase() === symbol);
  if (sameSymbol) add('CONFLICT_SAME_SYMBOL', `a core position in ${intent.symbol} is already ${sameSymbol.state}`);
  const direction = vehicle ? exposureOf(vehicle, intent.side, intent.optionType) : null;
  const opposite = direction
    ? state.openPositions.find((p) => p.underlying.toUpperCase() === underlying && p.direction !== direction)
    : undefined;
  if (opposite) add('CONFLICT_OPPOSITE_DIRECTION', `already ${opposite.direction} on ${intent.underlying} (${opposite.symbol}): never long and short on one underlying`);

  if (vehicle) {
    const nowMin = istMinutesOf(ctx.now);
    const lastEntry = lim.minutes('lastEntryTime', vehicle);
    if (lastEntry !== null && nowMin >= lastEntry) add('AFTER_LAST_ENTRY', `${vehicle} entries stop at ${lim.raw('lastEntryTime', vehicle)} IST`);
    const squareOff = lim.minutes('squareOffTime', vehicle);
    if (squareOff !== null && nowMin >= squareOff) add('AFTER_SQUARE_OFF', `${vehicle} squares off at ${lim.raw('squareOffTime', vehicle)} IST`);
  }
  if (vehicle === 'MTF' && intent.side !== 'BUY') add('VEHICLE_SIDE', 'MTF is long only');
  if (vehicle === 'OPTIONS_BUY' && intent.side !== 'BUY') add('VEHICLE_SIDE', 'options are buy only (OPTIONS_BUY)');
  const maxLeverage = lim.dec('mtfMaxLeverage', 'MTF');
  if (vehicle === 'MTF' && maxLeverage && finite(intent.mtfLeverage) && maxLeverage.lt(intent.mtfLeverage)) {
    add('MTF_LEVERAGE', `leverage ${intent.mtfLeverage} is above the ${maxLeverage.toFixed(2)} MTF limit`);
  }
  if (intent.stopPrice === null) add('RISK_UNKNOWN', 'the intent has no stop, so its risk cannot be computed');
  const deployedNow = vehicle ? state.deployedCapital[vehicle] : null;
  if (vehicle && !finite(deployedNow)) add('STATE_UNKNOWN', `capital deployed in ${vehicle} is unknown`);

  const base = {
    intentId: intent.intentId,
    userId: intent.userId,
    intentKind: 'ENTRY' as const,
    requestedQty: intent.qty,
    limits: [...ctx.limits],
    state: snapshotState(state),
    dailyLoss,
    killSwitchActive: ctx.killSwitchActive,
    checkedAt: ctx.now.toISOString(),
  };
  if (reasons.length > 0 || !vehicle || !finite(deployedNow)) return { ...base, verdict: 'REJECT', qty: 0, reasons };

  const caps = sizeCaps(intent, vehicle, lim, deployedNow);
  const qty = Math.min(intent.qty, ...caps.map((c) => c.qty));
  if (qty >= intent.qty) {
    return { ...base, verdict: 'ALLOW', qty: intent.qty, reasons: [{ code: 'WITHIN_LIMITS', message: 'within every limit' }] };
  }
  const binding = caps.filter((c) => c.qty === qty).map(({ code, message }) => ({ code, message }));
  return qty <= 0 ? { ...base, verdict: 'REJECT', qty: 0, reasons: binding } : { ...base, verdict: 'RESIZE', qty, reasons: binding };
}

/** RiskWall.check (spec §5.1). Never throws. */
export function checkRisk(intent: CoreIntent, ctx: RiskContext): RiskVerdict {
  if (intent.kind === 'EXIT') return exitVerdict(intent, ctx.now);
  try {
    return evaluateEntry(intent, ctx);
  } catch (err) {
    return rejectVerdict(intent, ctx.now, 'CONTEXT_UNAVAILABLE', `the risk check could not evaluate its inputs: ${errorText(err)}`, {
      limits: [...ctx.limits],
      killSwitchActive: ctx.killSwitchActive,
    });
  }
}

/** Exits are never checked or blocked (spec §5.1). */
export function exitVerdict(intent: CoreExitIntent, now: Date): RiskVerdict {
  return {
    intentId: intent.intentId,
    userId: intent.userId,
    intentKind: 'EXIT',
    verdict: 'ALLOW',
    requestedQty: intent.qty,
    qty: intent.qty,
    reasons: [{ code: 'EXIT_NOT_CHECKED', message: 'exits are never checked or blocked' }],
    limits: [],
    state: null,
    dailyLoss: null,
    killSwitchActive: null,
    checkedAt: now.toISOString(),
  };
}

/** A fail-closed REJECT, keeping whatever snapshot was already known. */
export function rejectVerdict(
  intent: CoreEntryIntent,
  now: Date,
  code: RiskReasonCode,
  message: string,
  prior: Partial<Pick<RiskVerdict, 'limits' | 'state' | 'dailyLoss' | 'killSwitchActive'>> = {},
): RiskVerdict {
  return {
    intentId: intent.intentId,
    userId: intent.userId,
    intentKind: 'ENTRY',
    verdict: 'REJECT',
    requestedQty: intent.qty,
    qty: 0,
    reasons: [{ code, message }],
    limits: prior.limits ? [...prior.limits] : [],
    state: prior.state ?? null,
    dailyLoss: prior.dailyLoss ?? null,
    killSwitchActive: prior.killSwitchActive ?? null,
    checkedAt: now.toISOString(),
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @td/api test -- risk-wall.spec`
Expected: PASS (27 tests). If a reason list differs only in order, fix the implementation's check order to
the order the test lists (kill switch, limits, session, price, positions, daily loss, strategy loss,
trades, counts, conflicts, time, vehicle rules, stop, capital), not the test.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/trade-core/risk-wall/risk-wall.types.ts apps/api/src/modules/trade-core/risk-wall/risk-wall.ts apps/api/src/modules/trade-core/risk-wall/testing/risk-fixtures.ts apps/api/src/modules/trade-core/risk-wall/risk-wall.spec.ts
git commit -m "feat(trade-core): pure Risk Wall check: fail-closed, reduce-only, exits pass" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/api/src/modules/trade-core/risk-wall/risk-wall.types.ts apps/api/src/modules/trade-core/risk-wall/risk-wall.ts apps/api/src/modules/trade-core/risk-wall/testing/risk-fixtures.ts apps/api/src/modules/trade-core/risk-wall/risk-wall.spec.ts
```

---

### Task 4: Tables, append-only trigger, seed defaults as data, tenant models

**Files:**
- Modify: `prisma/schema.prisma` (two relation fields in `model User`; three models appended)
- Create: `prisma/migrations/20261010120000_sp2_m2_risk_wall/migration.sql`
- Modify: `apps/api/src/common/tenant/tenant.constants.ts`
- Test: `apps/api/src/modules/trade-core/risk-wall/core-risk-defaults.spec.ts`
- Test (opt-in, real database): `apps/api/test/sp2-m2/jest.config.js`, `apps/api/test/sp2-m2/core-risk.int.spec.ts`

**Interfaces:**
- Consumes: `LIMIT_PAIRS`, `pairId`, `isLimitPair`, `fromStorage`, `LimitKey` (Task 1).
- Produces: Prisma models `CoreRiskLimit` (`core_risk_limits`), `CoreRiskLimitDefault`
  (`core_risk_limit_defaults`, id `key_scope`), `CoreKillSwitch` (`core_kill_switch`); `TENANT_MODELS`
  contains `'CoreRiskLimit'` and `'CoreKillSwitch'`; 21 default rows.

- [ ] **Step 1: Write the failing defaults spec**

Create `apps/api/src/modules/trade-core/risk-wall/core-risk-defaults.spec.ts`:

```typescript
import { readFileSync } from 'fs';
import { join } from 'path';
import { Prisma } from '@prisma/client';
import { ENTRY_WINDOW_CLOSE_MIN } from '../../../common/utils/market-hours';
import { fromStorage, isLimitPair, LIMIT_PAIRS, pairId, type LimitKey } from './limits/limit-keys';

/**
 * The seed defaults are rows in the M2 migration (data, not code, D4). This spec
 * proves (1) there is exactly one valid row per (key, scope), (2) the defaults that
 * stand in for a UserSettings field equal that field's column default, and (3) the
 * cash cutoff and square-off defaults equal the silo code they were taken from.
 * Silo files are read, never imported for behaviour.
 */
const ROOT = join(__dirname, '..', '..', '..', '..', '..', '..');
const sql = readFileSync(join(ROOT, 'prisma', 'migrations', '20261010120000_sp2_m2_risk_wall', 'migration.sql'), 'utf8');
const schema = readFileSync(join(ROOT, 'prisma', 'schema.prisma'), 'utf8');
const silo = (rel: string) => readFileSync(join(ROOT, 'apps', 'api', 'src', 'modules', rel), 'utf8');

interface DefaultRow {
  key: string;
  scope: string;
  value: string | null;
  note: string;
}

function defaults(): DefaultRow[] {
  const seed = sql.slice(sql.indexOf('-- SEED BEGIN'), sql.indexOf('-- SEED END'));
  const re = /\('([A-Za-z]+)', '([A-Z_]+)', (NULL|\d+(?:\.\d+)?), (NULL|'[^']*'), '([^']*)'\)/g;
  return [...seed.matchAll(re)].map((m) => {
    const num = m[3] === 'NULL' ? null : new Prisma.Decimal(m[3]);
    const text = m[4] === 'NULL' ? null : m[4].slice(1, -1);
    const value = isLimitPair(m[1], m[2]) ? fromStorage(m[1] as LimitKey, num, text) : null;
    return { key: m[1], scope: m[2], value, note: m[5] };
  });
}

/** `<field>  Float|Int  @default(n)` inside `model UserSettings { … }`. */
function settingsDefault(field: string): number {
  const start = schema.indexOf('model UserSettings {');
  const block = schema.slice(start, schema.indexOf('\n}', start));
  const m = new RegExp(`\\n\\s+${field}\\s+(?:Float|Int)\\s+@default\\(([0-9.]+)\\)`).exec(block);
  if (!m) throw new Error(`UserSettings.${field} default not found`);
  return Number(m[1]);
}

describe('M2 seed defaults (core_risk_limit_defaults)', () => {
  const rows = defaults();
  const valueOf = (id: string) => rows.find((r) => pairId(r) === id)?.value;

  it('has exactly one valid row per (key, scope), with a note, inserted idempotently', () => {
    expect(rows.map(pairId)).toEqual(LIMIT_PAIRS.map(pairId));
    for (const r of rows) {
      expect(r.value).not.toBeNull();
      expect(r.note.trim().length).toBeGreaterThan(0);
    }
    expect(sql).toContain('ON CONFLICT ("key", "scope") DO NOTHING');
  });

  it('the UserSettings-equivalent defaults equal the user_settings column defaults', () => {
    expect(valueOf('maxDailyLoss@ALL')).toBe(new Prisma.Decimal(settingsDefault('maxDailyLoss')).toFixed(2));
    expect(valueOf('maxOpenPositions@ALL')).toBe(String(settingsDefault('maxConcurrentPositions')));
    expect(valueOf('optionsMaxPremiumPerTrade@OPTIONS_BUY')).toBe(new Prisma.Decimal(settingsDefault('maxCapitalPerTrade')).toFixed(2));
  });

  it('the cash entry cutoff and square-off defaults equal the silo code (owner answer 1: cash squares off at Ungated’s 15:25)', () => {
    const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
    expect(valueOf('lastEntryTime@CASH_INTRADAY')).toBe(hhmm(ENTRY_WINDOW_CLOSE_MIN));
    expect(silo('ungated-track/services/ungated-tick-poller.service.ts')).toContain("@Cron('0 25 15 * * 1-5'");
    expect(valueOf('squareOffTime@CASH_INTRADAY')).toBe('15:25');
  });

  it('the pair CHECK names exactly the 21 pairs the code knows', () => {
    const check = sql.slice(sql.indexOf('"core_risk_limits_pair_check"'), sql.indexOf('"core_risk_limits_value_check"'));
    const pairs = [...check.matchAll(/\('([A-Za-z]+)', '([A-Z_]+)'\)/g)].map((m) => `${m[1]}@${m[2]}`);
    expect(pairs).toEqual(LIMIT_PAIRS.map(pairId));
  });
});
```

- [ ] **Step 2: Run the spec to verify it fails**

Run: `pnpm --filter @td/api test -- core-risk-defaults`
Expected: FAIL with `ENOENT: no such file or directory … 20261010120000_sp2_m2_risk_wall/migration.sql`.

- [ ] **Step 3: Add the models**

In `prisma/schema.prisma`, inside `model User { … }`, add two lines after `coreStrategySelections CoreStrategySelection[]`:

```prisma
  coreRiskLimits         CoreRiskLimit[]
  coreKillSwitches       CoreKillSwitch[]
```

Append at the end of `prisma/schema.prisma`:

```prisma
// ─── SP2 M2: Risk Wall limits and the persistent kill switch ────────────────
// docs/superpowers/specs/2026-10-09-sp2-core-trade-lifecycle-design.md §5.2, §5.4.
// Both per-user tables are append-only (a trigger in the 20261010120000 migration
// refuses UPDATE); the row in force is the newest row whose effectiveFrom ≤ now.
// CHECK constraints pin the (key, scope) vocabulary and value shapes.

/// One limit change for one user: tighter = effective now, looser = next session open.
model CoreRiskLimit {
  id            String   @id @default(cuid())
  userId        String
  user          User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  key           String
  scope         String // ALL | CASH_INTRADAY | MTF | OPTIONS_BUY
  numValue      Decimal? @db.Decimal(14, 2) // rupees, counts, leverage
  textValue     String? // HH:MM IST, or the daily-loss action
  effectiveFrom DateTime
  source        String // USER | USER_SETTINGS | DEFAULT
  setBy         String // the actor's userId, or SEED
  reason        String
  createdAt     DateTime @default(now())

  @@index([userId, key, scope, createdAt])
  @@map("core_risk_limits")
}

/// Seed values for limits with no UserSettings equivalent (data, owner-reviewed; D4).
model CoreRiskLimitDefault {
  key       String
  scope     String
  numValue  Decimal? @db.Decimal(14, 2)
  textValue String?
  note      String
  updatedBy String? // the admin who last edited it (null = migration seed)
  updatedAt DateTime @default(now())

  @@id([key, scope])
  @@map("core_risk_limit_defaults")
}

/// One kill switch change for one user: on = effective now, off = next session open.
model CoreKillSwitch {
  id            String   @id @default(cuid())
  userId        String
  user          User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  active        Boolean
  effectiveFrom DateTime
  setBy         String
  reason        String
  createdAt     DateTime @default(now())

  @@index([userId, createdAt])
  @@map("core_kill_switch")
}
```

- [ ] **Step 4: Write the migration**

Create `prisma/migrations/20261010120000_sp2_m2_risk_wall/migration.sql`:

```sql
-- SP2 M2 — Risk Wall limits and the persistent kill switch
-- (docs/superpowers/specs/2026-10-09-sp2-core-trade-lifecycle-design.md §5.2, §5.4).
--
-- Expand-only: creates three tables, CHECK constraints, an append-only trigger and
-- 21 seed default rows. Drops and alters nothing that exists. Per-user limit rows are
-- not copied here: the API seeds each user lazily from user_settings and these
-- defaults (plan decision 7).

CREATE TABLE "core_risk_limits" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "numValue" DECIMAL(14,2),
    "textValue" TEXT,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL,
    "setBy" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "core_risk_limits_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "core_risk_limit_defaults" (
    "key" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "numValue" DECIMAL(14,2),
    "textValue" TEXT,
    "note" TEXT NOT NULL,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "core_risk_limit_defaults_pkey" PRIMARY KEY ("key","scope")
);

CREATE TABLE "core_kill_switch" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "setBy" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "core_kill_switch_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "core_risk_limits_userId_key_scope_createdAt_idx" ON "core_risk_limits"("userId", "key", "scope", "createdAt");
CREATE INDEX "core_kill_switch_userId_createdAt_idx" ON "core_kill_switch"("userId", "createdAt");

ALTER TABLE "core_risk_limits" ADD CONSTRAINT "core_risk_limits_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "core_kill_switch" ADD CONSTRAINT "core_kill_switch_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Vocabulary and value shapes (Prisma models them as String/Decimal; its diff ignores CHECKs).
-- The pair list must equal LIMIT_PAIRS in limit-keys.ts (core-risk-defaults.spec.ts checks it).
ALTER TABLE "core_risk_limits" ADD CONSTRAINT "core_risk_limits_pair_check" CHECK (("key", "scope") IN (
    ('maxDailyLoss', 'ALL'), ('maxDailyLossPerStrategy', 'ALL'), ('maxTradesPerDay', 'ALL'),
    ('maxOpenPositions', 'ALL'), ('maxOpenPositions', 'CASH_INTRADAY'), ('maxOpenPositions', 'MTF'), ('maxOpenPositions', 'OPTIONS_BUY'),
    ('maxRiskPerTrade', 'ALL'),
    ('maxCapitalDeployed', 'CASH_INTRADAY'), ('maxCapitalDeployed', 'MTF'), ('maxCapitalDeployed', 'OPTIONS_BUY'),
    ('mtfMaxLeverage', 'MTF'), ('mtfMaxHoldDays', 'MTF'), ('optionsMaxPremiumPerTrade', 'OPTIONS_BUY'),
    ('lastEntryTime', 'CASH_INTRADAY'), ('lastEntryTime', 'MTF'), ('lastEntryTime', 'OPTIONS_BUY'),
    ('squareOffTime', 'CASH_INTRADAY'), ('squareOffTime', 'MTF'), ('squareOffTime', 'OPTIONS_BUY'),
    ('dailyLossAction', 'ALL')));
ALTER TABLE "core_risk_limits" ADD CONSTRAINT "core_risk_limits_value_check" CHECK (
    CASE
      WHEN "key" IN ('lastEntryTime', 'squareOffTime') THEN "numValue" IS NULL AND "textValue" IS NOT NULL AND "textValue" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
      WHEN "key" = 'dailyLossAction' THEN "numValue" IS NULL AND "textValue" IS NOT NULL AND "textValue" IN ('BLOCK_ENTRIES', 'BLOCK_AND_SQUARE_OFF')
      ELSE "textValue" IS NULL AND "numValue" IS NOT NULL AND "numValue" >= 0 AND "numValue" <> 'NaN'::numeric
           AND ("key" NOT IN ('maxTradesPerDay', 'maxOpenPositions', 'mtfMaxHoldDays') OR "numValue" = trunc("numValue"))
           AND ("key" <> 'mtfMaxLeverage' OR "numValue" >= 1)
    END);
ALTER TABLE "core_risk_limits" ADD CONSTRAINT "core_risk_limits_source_check"
    CHECK ("source" IN ('USER', 'USER_SETTINGS', 'DEFAULT'));
ALTER TABLE "core_risk_limits" ADD CONSTRAINT "core_risk_limits_reason_check"
    CHECK (length(btrim("reason")) > 0);

ALTER TABLE "core_risk_limit_defaults" ADD CONSTRAINT "core_risk_limit_defaults_pair_check" CHECK (("key", "scope") IN (
    ('maxDailyLoss', 'ALL'), ('maxDailyLossPerStrategy', 'ALL'), ('maxTradesPerDay', 'ALL'),
    ('maxOpenPositions', 'ALL'), ('maxOpenPositions', 'CASH_INTRADAY'), ('maxOpenPositions', 'MTF'), ('maxOpenPositions', 'OPTIONS_BUY'),
    ('maxRiskPerTrade', 'ALL'),
    ('maxCapitalDeployed', 'CASH_INTRADAY'), ('maxCapitalDeployed', 'MTF'), ('maxCapitalDeployed', 'OPTIONS_BUY'),
    ('mtfMaxLeverage', 'MTF'), ('mtfMaxHoldDays', 'MTF'), ('optionsMaxPremiumPerTrade', 'OPTIONS_BUY'),
    ('lastEntryTime', 'CASH_INTRADAY'), ('lastEntryTime', 'MTF'), ('lastEntryTime', 'OPTIONS_BUY'),
    ('squareOffTime', 'CASH_INTRADAY'), ('squareOffTime', 'MTF'), ('squareOffTime', 'OPTIONS_BUY'),
    ('dailyLossAction', 'ALL')));
ALTER TABLE "core_risk_limit_defaults" ADD CONSTRAINT "core_risk_limit_defaults_value_check" CHECK (
    CASE
      WHEN "key" IN ('lastEntryTime', 'squareOffTime') THEN "numValue" IS NULL AND "textValue" IS NOT NULL AND "textValue" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
      WHEN "key" = 'dailyLossAction' THEN "numValue" IS NULL AND "textValue" IS NOT NULL AND "textValue" IN ('BLOCK_ENTRIES', 'BLOCK_AND_SQUARE_OFF')
      ELSE "textValue" IS NULL AND "numValue" IS NOT NULL AND "numValue" >= 0 AND "numValue" <> 'NaN'::numeric
           AND ("key" NOT IN ('maxTradesPerDay', 'maxOpenPositions', 'mtfMaxHoldDays') OR "numValue" = trunc("numValue"))
           AND ("key" <> 'mtfMaxLeverage' OR "numValue" >= 1)
    END);

ALTER TABLE "core_kill_switch" ADD CONSTRAINT "core_kill_switch_reason_check"
    CHECK (length(btrim("reason")) > 0);

-- Append-only (plan decision 12). UPDATE is refused; DELETE stays possible only so
-- deleting a user cascades. No repository has an update or delete method. M5's
-- core_journal can reuse this function.
CREATE OR REPLACE FUNCTION core_append_only_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '%: rows are append-only; insert a new row instead', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER "core_risk_limits_append_only"
    BEFORE UPDATE ON "core_risk_limits"
    FOR EACH ROW EXECUTE FUNCTION core_append_only_guard();

CREATE TRIGGER "core_kill_switch_append_only"
    BEFORE UPDATE ON "core_kill_switch"
    FOR EACH ROW EXECUTE FUNCTION core_append_only_guard();

-- SEED BEGIN
-- Seed defaults are data (D4), idempotent (ON CONFLICT DO NOTHING). A user's limit is
-- seeded from user_settings where an equivalent exists, otherwise from this table and
-- shown as "default — please review". Values are proposals listed for the owner in
-- docs/superpowers/plans/2026-10-10-sp2-m2-risk-wall.md (Owner answers 2026-10-10; the owner edits them on the Core Risk page); sources are
-- checked by core-risk-defaults.spec.ts. Notes contain no apostrophes or semicolons.
INSERT INTO "core_risk_limit_defaults" ("key", "scope", "numValue", "textValue", "note") VALUES
    ('maxDailyLoss', 'ALL', 5000.00, NULL, 'user_settings.maxDailyLoss column default (schema.prisma:405), used when the user has no settings row'),
    ('maxDailyLossPerStrategy', 'ALL', 2500.00, NULL, 'half of the maxDailyLoss default, no existing equivalent'),
    ('maxTradesPerDay', 'ALL', 20, NULL, 'no existing equivalent'),
    ('maxOpenPositions', 'ALL', 5, NULL, 'user_settings.maxConcurrentPositions column default (schema.prisma:407), used when the user has no settings row'),
    ('maxOpenPositions', 'CASH_INTRADAY', 5, NULL, 'equal to the total default, no existing equivalent'),
    ('maxOpenPositions', 'MTF', 3, NULL, 'no existing equivalent'),
    ('maxOpenPositions', 'OPTIONS_BUY', 2, NULL, 'no existing equivalent'),
    ('maxRiskPerTrade', 'ALL', 3000.00, NULL, 'Ungated v1 risks 200000 x 1.5 percent = 3000 per trade, Adaptive-Stop v1 risks 800'),
    ('maxCapitalDeployed', 'CASH_INTRADAY', 1000000.00, NULL, 'five Ungated-sized positions of 200000, no existing equivalent'),
    ('maxCapitalDeployed', 'MTF', 200000.00, NULL, 'no existing equivalent'),
    ('maxCapitalDeployed', 'OPTIONS_BUY', 100000.00, NULL, 'no existing equivalent'),
    ('mtfMaxLeverage', 'MTF', 2.00, NULL, 'no existing equivalent'),
    ('mtfMaxHoldDays', 'MTF', 10, NULL, 'no existing equivalent'),
    ('optionsMaxPremiumPerTrade', 'OPTIONS_BUY', 50000.00, NULL, 'user_settings.maxCapitalPerTrade column default (schema.prisma:406), used when the user has no settings row'),
    ('lastEntryTime', 'CASH_INTRADAY', NULL, '15:00', 'the 15:00 IST entry cutoff of the silos (common/utils/market-hours.ts:22)'),
    ('lastEntryTime', 'MTF', NULL, '15:00', 'the 15:00 IST entry cutoff of the silos (common/utils/market-hours.ts:22)'),
    ('lastEntryTime', 'OPTIONS_BUY', NULL, '14:30', 'no existing equivalent'),
    ('squareOffTime', 'CASH_INTRADAY', NULL, '15:25', 'the Ungated EOD square-off (ungated-tick-poller.service.ts:94), so Ungated v1 keeps its own 15:25 exit and Adaptive-Stop its 15:15'),
    ('squareOffTime', 'MTF', NULL, '15:20', 'no existing equivalent, applies to MTF forced exits'),
    ('squareOffTime', 'OPTIONS_BUY', NULL, '15:15', 'no existing equivalent'),
    ('dailyLossAction', 'ALL', NULL, 'BLOCK_ENTRIES', 'spec 5.3 base behaviour: entries blocked, open positions keep their stops')
ON CONFLICT ("key", "scope") DO NOTHING;
-- SEED END
```

- [ ] **Step 5: Generate the client, validate the schema, run the defaults spec**

```bash
cd apps/api && npx prisma validate --schema ../../prisma/schema.prisma && npx prisma generate --schema ../../prisma/schema.prisma
```

Expected: `The schema at ../../prisma/schema.prisma is valid`, then `Generated Prisma Client`.

Run: `pnpm --filter @td/api test -- core-risk-defaults`
Expected: PASS (4 tests). A failure in "equal the user_settings column defaults" or "equal the silo code"
means the seed row differs from its source: fix the **migration**, never the source.

- [ ] **Step 6: Make the two per-user models tenant models**

In `apps/api/src/common/tenant/tenant.constants.ts`, add after `'CoreStrategySelection',` (the last entry of
`TENANT_MODELS`):

```typescript
  // SP2 M2: per-user risk limits and kill switch. CoreRiskLimitDefault is global
  // seed data and deliberately absent.
  'CoreRiskLimit',
  'CoreKillSwitch',
```

(Task 5's repository spec asserts this membership.)

- [ ] **Step 7: Write the opt-in database test**

Create `apps/api/test/sp2-m2/jest.config.js`:

```javascript
const path = require('path');

/**
 * Opt-in SQL tests for the SP2 M2 risk tables (seed defaults, append-only trigger,
 * CHECKs, user cascade) against a THROWAWAY local Postgres on 127.0.0.1 with every
 * migration applied. The default apps/api Jest config (rootDir: src) never finds these.
 *
 * Run from apps/api:
 *   DATABASE_URL_TEST=postgresql://postgres:password@127.0.0.1:55432/grw_sp2m2_test \
 *     npx jest --config test/sp2-m2/jest.config.js -i
 */
module.exports = {
  rootDir: path.resolve(__dirname, '../..'),
  roots: ['<rootDir>/test/sp2-m2'],
  moduleFileExtensions: ['js', 'json', 'ts'],
  testRegex: '.*\\.spec\\.ts$',
  transform: { '^.+\\.(t|j)s$': ['ts-jest', { isolatedModules: true }] },
  testEnvironment: 'node',
};
```

Create `apps/api/test/sp2-m2/core-risk.int.spec.ts`:

```typescript
import { readFileSync } from 'fs';
import { join } from 'path';
import { PrismaClient } from '@prisma/client';

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error('DATABASE_URL_TEST must point at a throwaway database with all migrations applied');
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(url)) throw new Error('refusing to run against a database that is not on 127.0.0.1');

const db = new PrismaClient({ datasources: { db: { url } } });
const MIGRATION = join(__dirname, '..', '..', '..', '..', 'prisma', 'migrations', '20261010120000_sp2_m2_risk_wall', 'migration.sql');
const sql = readFileSync(MIGRATION, 'utf8');
const seedStatements = sql
  .slice(sql.indexOf('-- SEED BEGIN'), sql.indexOf('-- SEED END'))
  .split(';\n')
  .map((s) => s.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n').trim())
  .filter((s) => s.length > 0);

const run = `it${Date.now()}`;
const rid = () => Math.random().toString(36).slice(2, 10);

async function newUser(): Promise<string> {
  const id = `usr_${run}_${rid()}`;
  await db.$executeRawUnsafe(
    `INSERT INTO "users" ("id", "email", "passwordHash", "updatedAt") VALUES ($1, $1 || '@it.local', 'x', CURRENT_TIMESTAMP)`,
    id,
  );
  return id;
}

function insertLimit(userId: string, key: string, scope: string, num: string | null, text: string | null, source = 'USER', reason = 'it') {
  return db.$executeRawUnsafe(
    `INSERT INTO "core_risk_limits" ("id", "userId", "key", "scope", "numValue", "textValue", "effectiveFrom", "source", "setBy", "reason")
     VALUES ($1, $2, $3, $4, $5::numeric, $6, CURRENT_TIMESTAMP, $7, $2, $8)`,
    `lim_${rid()}`, userId, key, scope, num, text, source, reason,
  );
}

function insertKill(userId: string, active: boolean, reason = 'it') {
  return db.$executeRawUnsafe(
    `INSERT INTO "core_kill_switch" ("id", "userId", "active", "effectiveFrom", "setBy", "reason") VALUES ($1, $2, $3, CURRENT_TIMESTAMP, $2, $4)`,
    `ks_${rid()}`, userId, active, reason,
  );
}

afterAll(() => db.$disconnect());

describe('core risk tables (real database)', () => {
  it('has the 21 seed defaults, and re-running the seed block changes nothing', async () => {
    const count = async () => (await db.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM "core_risk_limit_defaults"`))[0].n;
    expect(await count()).toBe(21);
    expect(seedStatements).toHaveLength(1);
    await db.$executeRawUnsafe(seedStatements[0]);
    expect(await count()).toBe(21);
  });

  it('refuses to update a limit row or a kill switch row (append-only)', async () => {
    const u = await newUser();
    await insertLimit(u, 'maxDailyLoss', 'ALL', '5000', null);
    await insertKill(u, true);
    await expect(db.$executeRawUnsafe(`UPDATE "core_risk_limits" SET "numValue" = 9999 WHERE "userId" = $1`, u)).rejects.toThrow(/append-only/);
    await expect(db.$executeRawUnsafe(`UPDATE "core_kill_switch" SET "active" = false WHERE "userId" = $1`, u)).rejects.toThrow(/append-only/);
  });

  it('refuses an unknown pair, a wrong value shape, an unknown source and a blank reason', async () => {
    const u = await newUser();
    await expect(insertLimit(u, 'maxDailyLoss', 'MTF', '1', null)).rejects.toThrow(/core_risk_limits_pair_check/);
    await expect(insertLimit(u, 'maxDailyLoss', 'ALL', null, '5000')).rejects.toThrow(/core_risk_limits_value_check/);
    await expect(insertLimit(u, 'maxDailyLoss', 'ALL', '-1', null)).rejects.toThrow(/core_risk_limits_value_check/);
    await expect(insertLimit(u, 'maxOpenPositions', 'ALL', '2.5', null)).rejects.toThrow(/core_risk_limits_value_check/);
    await expect(insertLimit(u, 'mtfMaxLeverage', 'MTF', '0.5', null)).rejects.toThrow(/core_risk_limits_value_check/);
    await expect(insertLimit(u, 'lastEntryTime', 'MTF', null, '9:5')).rejects.toThrow(/core_risk_limits_value_check/);
    await expect(insertLimit(u, 'dailyLossAction', 'ALL', null, 'PANIC')).rejects.toThrow(/core_risk_limits_value_check/);
    await expect(insertLimit(u, 'lastEntryTime', 'MTF', null, null)).rejects.toThrow(/core_risk_limits_value_check/);
    await expect(insertLimit(u, 'dailyLossAction', 'ALL', null, null)).rejects.toThrow(/core_risk_limits_value_check/);
    await expect(insertLimit(u, 'maxDailyLoss', 'ALL', '1', null, 'ROBOT')).rejects.toThrow(/core_risk_limits_source_check/);
    await expect(insertLimit(u, 'maxDailyLoss', 'ALL', '1', null, 'USER', '  ')).rejects.toThrow(/core_risk_limits_reason_check/);
    await expect(insertKill(u, true, ' ')).rejects.toThrow(/core_kill_switch_reason_check/);
    await insertLimit(u, 'lastEntryTime', 'MTF', null, '14:45');
    await insertLimit(u, 'mtfMaxLeverage', 'MTF', '1', null);
  });

  it('the admin may update a default (not append-only), but its CHECKs still hold', async () => {
    await db.$executeRawUnsafe(
      `UPDATE "core_risk_limit_defaults" SET "numValue" = 21, "note" = 'it edit', "updatedBy" = 'usr_it', "updatedAt" = CURRENT_TIMESTAMP WHERE "key" = 'maxTradesPerDay' AND "scope" = 'ALL'`,
    );
    await expect(
      db.$executeRawUnsafe(`UPDATE "core_risk_limit_defaults" SET "numValue" = 2.5 WHERE "key" = 'maxTradesPerDay' AND "scope" = 'ALL'`),
    ).rejects.toThrow(/core_risk_limit_defaults_value_check/);
    await db.$executeRawUnsafe(`UPDATE "core_risk_limit_defaults" SET "numValue" = 20, "note" = 'no existing equivalent', "updatedBy" = NULL WHERE "key" = 'maxTradesPerDay' AND "scope" = 'ALL'`);
  });

  it('deleting a user removes their limit and kill switch rows', async () => {
    const u = await newUser();
    await insertLimit(u, 'maxTradesPerDay', 'ALL', '20', null);
    await insertKill(u, false);
    await db.$executeRawUnsafe(`DELETE FROM "users" WHERE "id" = $1`, u);
    const left = await db.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT ((SELECT count(*) FROM "core_risk_limits" WHERE "userId" = $1) + (SELECT count(*) FROM "core_kill_switch" WHERE "userId" = $1))::int AS n`,
      u,
    );
    expect(left[0].n).toBe(0);
  });
});
```

- [ ] **Step 8: Run the opt-in test in a throwaway container, and check drift**

Start Docker Desktop if it is not running. Use a postgres image that is already present (`docker images
postgres`; do not pull if the disk is low), bound to 127.0.0.1 only, and remove it afterwards. From the
repo root:

```bash
docker run -d --rm --name grw-sp2m2-it -e POSTGRES_PASSWORD=password -p 127.0.0.1:55432:5432 postgres:16-alpine
docker exec grw-sp2m2-it sh -c 'until pg_isready -U postgres; do sleep 1; done'
docker exec grw-sp2m2-it psql -U postgres -c "CREATE DATABASE grw_sp2m2_test" -c "CREATE DATABASE grw_sp2m2_shadow"
DATABASE_URL=postgresql://postgres:password@127.0.0.1:55432/grw_sp2m2_test DIRECT_URL=postgresql://postgres:password@127.0.0.1:55432/grw_sp2m2_test npx prisma migrate deploy --schema prisma/schema.prisma
cd apps/api && DATABASE_URL_TEST=postgresql://postgres:password@127.0.0.1:55432/grw_sp2m2_test npx jest --config test/sp2-m2/jest.config.js -i
```

Expected: `migrate deploy` lists `20261010120000_sp2_m2_risk_wall` as applied; the suite PASSES (5
tests). If `20261008120000_sp1_m2_candle_store` stops on its TimescaleDB step, that is the SP1 deploy SQL,
not this migration (plain Postgres applies it as a no-op).

```bash
cd ../.. && npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url postgresql://postgres:password@127.0.0.1:55432/grw_sp2m2_shadow
docker stop grw-sp2m2-it
```

Expected: the only differences are the two pre-existing DESC indexes the M1 ledger recorded
(`candles_timestamp_idx`, `sentinel_verdicts_createdAt_idx`); nothing mentions `core_risk_limits`,
`core_risk_limit_defaults` or `core_kill_switch`. If an M2 object appears, make its table/index/FK SQL
match what Prisma expects (the CHECKs, the function and the triggers are invisible to the diff and stay).

- [ ] **Step 9: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20261010120000_sp2_m2_risk_wall/migration.sql apps/api/src/common/tenant/tenant.constants.ts apps/api/src/modules/trade-core/risk-wall/core-risk-defaults.spec.ts apps/api/test/sp2-m2/jest.config.js apps/api/test/sp2-m2/core-risk.int.spec.ts
git commit -m "feat(trade-core): core risk limit and kill switch tables, append-only trigger, seed defaults" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- prisma/schema.prisma prisma/migrations/20261010120000_sp2_m2_risk_wall/migration.sql apps/api/src/common/tenant/tenant.constants.ts apps/api/src/modules/trade-core/risk-wall/core-risk-defaults.spec.ts apps/api/test/sp2-m2/jest.config.js apps/api/test/sp2-m2/core-risk.int.spec.ts
```

---

### Task 5: Repositories (per-user, locked, strictly ordered) and the `risk` audit group

**Files:**
- Create: `apps/api/src/modules/trade-core/risk-wall/repositories/core-risk-limit.repository.ts`
- Create: `apps/api/src/modules/trade-core/risk-wall/repositories/core-kill-switch.repository.ts`
- Modify: `apps/api/src/common/audit/audit-actions.ts`
- Test: `apps/api/src/modules/trade-core/risk-wall/repositories/core-risk.repository.spec.ts`

**Interfaces:**
- Consumes: Prisma models (Task 4), `PrismaService` (`common/prisma/prisma.service.ts`, global),
  `SYSTEM_USER_ID` (`common/tenant/tenant.constants.ts`), `LimitSource` (Task 3).
- Produces:

```typescript
// core-risk-limit.repository.ts
export interface NewLimitRow { key: string; scope: string; numValue: Prisma.Decimal | null; textValue: string | null; effectiveFrom: Date; source: LimitSource; setBy: string; reason: string }
export interface SeedSettings { maxDailyLoss: number; maxCapitalPerTrade: number; maxConcurrentPositions: number }
export interface SettingsForSeed { settings: SeedSettings | null; from: 'OWN' | 'PLATFORM' | null }
export class ConcurrentRiskChangeError extends Error {}
export function nextCreatedAt(newest: Date | null, now: Date): Date;
class CoreRiskLimitRepository {
  listForUser(userId: string): Promise<CoreRiskLimit[]>;
  listForPair(userId: string, key: string, scope: string): Promise<CoreRiskLimit[]>;
  pairsForUser(userId: string): Promise<Set<string>>;            // "key@scope"
  listDefaults(): Promise<CoreRiskLimitDefault[]>;
  settingsForSeed(userId: string): Promise<SettingsForSeed>;
  append(userId: string, row: NewLimitRow, now: Date, expectNewestId: string | null): Promise<CoreRiskLimit>;
  appendIfMissing(userId: string, rows: NewLimitRow[], now: Date): Promise<CoreRiskLimit[]>;
}
// core-kill-switch.repository.ts
export interface NewKillSwitchRow { active: boolean; effectiveFrom: Date; setBy: string; reason: string }
class CoreKillSwitchRepository {
  listForUser(userId: string): Promise<CoreKillSwitch[]>;
  append(userId: string, row: NewKillSwitchRow, now: Date, expectNewestId?: string | null): Promise<CoreKillSwitch>;  // undefined = no check
}
// audit-actions.ts
AUDIT_ACTIONS.risk = { CORE_RISK_LIMITS_SEEDED, CORE_RISK_LIMIT_CHANGED, CORE_KILL_SWITCH_SET, CORE_KILL_SWITCH_CASCADE, CORE_RISK_DEFAULT_CHANGED }
```

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/modules/trade-core/risk-wall/repositories/core-risk.repository.spec.ts`:

```typescript
import { Prisma } from '@prisma/client';
import { AUDIT_ACTIONS } from '../../../../common/audit/audit-actions';
import type { PrismaService } from '../../../../common/prisma/prisma.service';
import { SYSTEM_USER_ID, TENANT_MODELS } from '../../../../common/tenant/tenant.constants';
import { CoreKillSwitchRepository } from './core-kill-switch.repository';
import { ConcurrentRiskChangeError, CoreRiskLimitRepository, nextCreatedAt, type NewLimitRow } from './core-risk-limit.repository';

const NOW = new Date('2026-10-12T05:00:00.000Z');
const ms = (n: number) => new Date(NOW.getTime() + n);

function fakeTx() {
  return {
    $executeRaw: jest.fn().mockResolvedValue(1),
    coreRiskLimit: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'lim_new', ...data })),
    },
    coreKillSwitch: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'ks_new', ...data })),
    },
  };
}

function fakePrisma() {
  const tx = fakeTx();
  return {
    tx,
    $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
    coreRiskLimit: { findMany: jest.fn().mockResolvedValue([]) },
    coreRiskLimitDefault: { findMany: jest.fn().mockResolvedValue([]) },
    coreKillSwitch: { findMany: jest.fn().mockResolvedValue([]) },
    user: { findUnique: jest.fn().mockResolvedValue(null) },
    userSettings: { findUnique: jest.fn().mockResolvedValue(null) },
  };
}

const row = (over: Partial<NewLimitRow> = {}): NewLimitRow => ({
  key: 'maxDailyLoss', scope: 'ALL', numValue: new Prisma.Decimal('4000'), textValue: null,
  effectiveFrom: NOW, source: 'USER', setBy: 'user_A', reason: 'tighter', ...over,
});

describe('CoreRiskLimitRepository', () => {
  it('every read filters by the caller’s userId', async () => {
    const prisma = fakePrisma();
    const repo = new CoreRiskLimitRepository(prisma as unknown as PrismaService);
    await repo.listForUser('user_A');
    expect(prisma.coreRiskLimit.findMany).toHaveBeenLastCalledWith({ where: { userId: 'user_A' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    await repo.listForPair('user_A', 'maxDailyLoss', 'ALL');
    expect(prisma.coreRiskLimit.findMany).toHaveBeenLastCalledWith({ where: { userId: 'user_A', key: 'maxDailyLoss', scope: 'ALL' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    prisma.coreRiskLimit.findMany.mockResolvedValueOnce([{ key: 'maxDailyLoss', scope: 'ALL' }]);
    expect(await repo.pairsForUser('user_A')).toEqual(new Set(['maxDailyLoss@ALL']));
    expect(prisma.coreRiskLimit.findMany).toHaveBeenLastCalledWith({ where: { userId: 'user_A' }, select: { key: true, scope: true }, distinct: ['key', 'scope'] });
  });

  it('append takes the per-user lock, refuses a stale expectation, and orders createdAt after the newest row', async () => {
    const prisma = fakePrisma();
    const repo = new CoreRiskLimitRepository(prisma as unknown as PrismaService);
    prisma.tx.coreRiskLimit.findFirst.mockResolvedValueOnce({ id: 'lim_9' }).mockResolvedValueOnce({ createdAt: ms(5) });
    const out = await repo.append('user_A', row(), NOW, 'lim_9');
    const [strings, lockKey] = prisma.tx.$executeRaw.mock.calls[0];
    expect((strings as string[]).join('?')).toContain('pg_advisory_xact_lock');
    expect(lockKey).toBe('core_risk_limits:user_A');
    expect(prisma.tx.coreRiskLimit.findFirst).toHaveBeenNthCalledWith(1, {
      where: { userId: 'user_A', key: 'maxDailyLoss', scope: 'ALL' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true },
    });
    expect(prisma.tx.coreRiskLimit.create).toHaveBeenCalledWith({ data: { ...row(), userId: 'user_A', createdAt: ms(6) } });
    expect(out.id).toBe('lim_new');

    const again = fakePrisma();
    again.tx.coreRiskLimit.findFirst.mockResolvedValueOnce({ id: 'lim_10' });
    const repo2 = new CoreRiskLimitRepository(again as unknown as PrismaService);
    await expect(repo2.append('user_A', row(), NOW, 'lim_9')).rejects.toBeInstanceOf(ConcurrentRiskChangeError);
    expect(again.tx.coreRiskLimit.create).not.toHaveBeenCalled();
  });

  it('appendIfMissing inserts only the pairs the user has no row for, each a millisecond apart', async () => {
    const prisma = fakePrisma();
    const repo = new CoreRiskLimitRepository(prisma as unknown as PrismaService);
    prisma.tx.coreRiskLimit.findMany.mockResolvedValueOnce([{ key: 'maxDailyLoss', scope: 'ALL' }]);
    const rows = [row({ source: 'DEFAULT' }), row({ key: 'maxTradesPerDay', source: 'DEFAULT' }), row({ key: 'maxRiskPerTrade', source: 'DEFAULT' })];
    const out = await repo.appendIfMissing('user_A', rows, NOW);
    expect(out).toHaveLength(2);
    expect(prisma.tx.coreRiskLimit.create.mock.calls.map((c) => [c[0].data.key, c[0].data.userId, c[0].data.createdAt])).toEqual([
      ['maxTradesPerDay', 'user_A', NOW],
      ['maxRiskPerTrade', 'user_A', ms(1)],
    ]);
    const idle = fakePrisma();
    expect(await new CoreRiskLimitRepository(idle as unknown as PrismaService).appendIfMissing('user_A', [], NOW)).toEqual([]);
    expect(idle.$transaction).not.toHaveBeenCalled();
  });

  it('seeds from the user’s own settings; an ADMIN without one uses the platform row; a USER without one gets none', async () => {
    const own = { maxDailyLoss: 7500, maxCapitalPerTrade: 40000, maxConcurrentPositions: 8 };
    const prisma = fakePrisma();
    const repo = new CoreRiskLimitRepository(prisma as unknown as PrismaService);
    prisma.user.findUnique.mockResolvedValueOnce({ role: 'USER', settings: own });
    expect(await repo.settingsForSeed('user_A')).toEqual({ settings: own, from: 'OWN' });
    expect(prisma.user.findUnique).toHaveBeenLastCalledWith({
      where: { id: 'user_A' },
      select: { role: true, settings: { select: { maxDailyLoss: true, maxCapitalPerTrade: true, maxConcurrentPositions: true } } },
    });

    prisma.user.findUnique.mockResolvedValueOnce({ role: 'ADMIN', settings: null });
    prisma.userSettings.findUnique.mockResolvedValueOnce(own);
    expect(await repo.settingsForSeed('usr_owner')).toEqual({ settings: own, from: 'PLATFORM' });
    expect(prisma.userSettings.findUnique).toHaveBeenLastCalledWith({
      where: { userId: SYSTEM_USER_ID }, select: { maxDailyLoss: true, maxCapitalPerTrade: true, maxConcurrentPositions: true },
    });

    prisma.userSettings.findUnique.mockClear();
    prisma.user.findUnique.mockResolvedValueOnce({ role: 'USER', settings: null });
    expect(await repo.settingsForSeed('user_B')).toEqual({ settings: null, from: null });
    expect(prisma.userSettings.findUnique).not.toHaveBeenCalled();
  });

  it('nextCreatedAt is never before now and always after the newest row', () => {
    expect(nextCreatedAt(null, NOW)).toEqual(NOW);
    expect(nextCreatedAt(ms(-10), NOW)).toEqual(NOW);
    expect(nextCreatedAt(NOW, NOW)).toEqual(ms(1));
    expect(nextCreatedAt(ms(40), NOW)).toEqual(ms(41));
  });
});

describe('CoreKillSwitchRepository', () => {
  it('reads only the caller’s rows', async () => {
    const prisma = fakePrisma();
    await new CoreKillSwitchRepository(prisma as unknown as PrismaService).listForUser('user_A');
    expect(prisma.coreKillSwitch.findMany).toHaveBeenCalledWith({ where: { userId: 'user_A' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  });

  it('turning on appends without a concurrency check; a release with a stale expectation is refused', async () => {
    const on = { active: true, effectiveFrom: NOW, setBy: 'user_A', reason: 'stop' };
    const prisma = fakePrisma();
    prisma.tx.coreKillSwitch.findFirst.mockResolvedValueOnce({ id: 'ks_other', createdAt: ms(3) });
    const repo = new CoreKillSwitchRepository(prisma as unknown as PrismaService);
    await repo.append('user_A', on, NOW);
    expect(prisma.tx.$executeRaw.mock.calls[0][1]).toBe('core_kill_switch:user_A');
    expect(prisma.tx.coreKillSwitch.create).toHaveBeenCalledWith({ data: { ...on, userId: 'user_A', createdAt: ms(4) } });

    const stale = fakePrisma();
    stale.tx.coreKillSwitch.findFirst.mockResolvedValueOnce({ id: 'ks_other', createdAt: ms(3) });
    await expect(
      new CoreKillSwitchRepository(stale as unknown as PrismaService).append('user_A', { ...on, active: false }, NOW, 'ks_mine'),
    ).rejects.toBeInstanceOf(ConcurrentRiskChangeError);
    expect(stale.tx.coreKillSwitch.create).not.toHaveBeenCalled();
  });
});

describe('wiring constants', () => {
  it('the per-user risk models are tenant models; the global defaults are not', () => {
    expect(TENANT_MODELS.has('CoreRiskLimit')).toBe(true);
    expect(TENANT_MODELS.has('CoreKillSwitch')).toBe(true);
    expect(TENANT_MODELS.has('CoreRiskLimitDefault')).toBe(false);
  });

  it('the risk audit actions exist', () => {
    expect(AUDIT_ACTIONS.risk).toEqual({
      CORE_RISK_LIMITS_SEEDED: 'CORE_RISK_LIMITS_SEEDED',
      CORE_RISK_LIMIT_CHANGED: 'CORE_RISK_LIMIT_CHANGED',
      CORE_KILL_SWITCH_SET: 'CORE_KILL_SWITCH_SET',
      CORE_KILL_SWITCH_CASCADE: 'CORE_KILL_SWITCH_CASCADE',
      CORE_RISK_DEFAULT_CHANGED: 'CORE_RISK_DEFAULT_CHANGED',
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @td/api test -- core-risk.repository`
Expected: FAIL with `Cannot find module './core-kill-switch.repository'`.

- [ ] **Step 3: Add the audit actions**

In `apps/api/src/common/audit/audit-actions.ts`, add a `risk` group after the `strategy` group (inside
`AUDIT_ACTIONS`, before `} as const;`):

```typescript
  risk: {
    CORE_RISK_LIMITS_SEEDED: 'CORE_RISK_LIMITS_SEEDED',
    CORE_RISK_LIMIT_CHANGED: 'CORE_RISK_LIMIT_CHANGED',
    CORE_KILL_SWITCH_SET: 'CORE_KILL_SWITCH_SET',
    CORE_KILL_SWITCH_CASCADE: 'CORE_KILL_SWITCH_CASCADE',
    CORE_RISK_DEFAULT_CHANGED: 'CORE_RISK_DEFAULT_CHANGED',
  },
```

- [ ] **Step 4: Write the repositories**

Create `apps/api/src/modules/trade-core/risk-wall/repositories/core-risk-limit.repository.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import type { CoreRiskLimit, CoreRiskLimitDefault, Prisma } from '@prisma/client';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { SYSTEM_USER_ID } from '../../../../common/tenant/tenant.constants';
import type { LimitSource } from '../risk-wall.types';

export interface NewLimitRow {
  key: string;
  scope: string;
  numValue: Prisma.Decimal | null;
  textValue: string | null;
  effectiveFrom: Date;
  source: LimitSource;
  setBy: string;
  reason: string;
}

/** The UserSettings fields that have a core-limit equivalent (plan decision 7). */
export interface SeedSettings {
  maxDailyLoss: number;
  maxCapitalPerTrade: number;
  maxConcurrentPositions: number;
}

export interface SettingsForSeed {
  settings: SeedSettings | null;
  from: 'OWN' | 'PLATFORM' | null;
}

/** Another change to the same row set landed between the caller's read and this write. */
export class ConcurrentRiskChangeError extends Error {
  constructor(what: string) {
    super(`${what} changed at the same time`);
    this.name = 'ConcurrentRiskChangeError';
  }
}

/** Strictly after the user's newest row, and never before now (plan decision 5). */
export function nextCreatedAt(newest: Date | null, now: Date): Date {
  return new Date(Math.max(now.getTime(), newest ? newest.getTime() + 1 : 0));
}

const SETTINGS_SELECT = { maxDailyLoss: true, maxCapitalPerTrade: true, maxConcurrentPositions: true } as const;
const OLDEST_FIRST = [{ createdAt: 'asc' as const }, { id: 'asc' as const }];

/**
 * Per-user, append-only limit rows (spec §5.2). Every query names the caller's
 * userId; the tenant extension adds the same filter for non-admin requests. There
 * is no update or delete method (a trigger refuses UPDATE as well). Writes take a
 * per-user advisory lock so "newest row" and createdAt order are exact.
 */
@Injectable()
export class CoreRiskLimitRepository {
  constructor(private readonly prisma: PrismaService) {}

  listForUser(userId: string): Promise<CoreRiskLimit[]> {
    return this.prisma.coreRiskLimit.findMany({ where: { userId }, orderBy: OLDEST_FIRST });
  }

  listForPair(userId: string, key: string, scope: string): Promise<CoreRiskLimit[]> {
    return this.prisma.coreRiskLimit.findMany({ where: { userId, key, scope }, orderBy: OLDEST_FIRST });
  }

  async pairsForUser(userId: string): Promise<Set<string>> {
    const rows = await this.prisma.coreRiskLimit.findMany({
      where: { userId },
      select: { key: true, scope: true },
      distinct: ['key', 'scope'],
    });
    return new Set(rows.map((r) => `${r.key}@${r.scope}`));
  }

  listDefaults(): Promise<CoreRiskLimitDefault[]> {
    return this.prisma.coreRiskLimitDefault.findMany();
  }

  /**
   * The user's own settings row; for an ADMIN without one, the platform row stamped
   * SYSTEM_USER_ID, which is the row the Settings page edits (settings.service.ts:38-48).
   */
  async settingsForSeed(userId: string): Promise<SettingsForSeed> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true, settings: { select: SETTINGS_SELECT } },
    });
    if (user?.settings) return { settings: user.settings, from: 'OWN' };
    if (user?.role === 'ADMIN') {
      const platform = await this.prisma.userSettings.findUnique({ where: { userId: SYSTEM_USER_ID }, select: SETTINGS_SELECT });
      if (platform) return { settings: platform, from: 'PLATFORM' };
    }
    return { settings: null, from: null };
  }

  /** One change. `expectNewestId` must still be the newest row of the pair, else ConcurrentRiskChangeError. */
  append(userId: string, row: NewLimitRow, now: Date, expectNewestId: string | null): Promise<CoreRiskLimit> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`core_risk_limits:${userId}`}, 0))`;
      const newest = await tx.coreRiskLimit.findFirst({
        where: { userId, key: row.key, scope: row.scope },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true },
      });
      if ((newest?.id ?? null) !== expectNewestId) throw new ConcurrentRiskChangeError(`${row.key} (${row.scope})`);
      const last = await tx.coreRiskLimit.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
      return tx.coreRiskLimit.create({ data: { ...row, userId, createdAt: nextCreatedAt(last?.createdAt ?? null, now) } });
    });
  }

  /** The seed: inserts only the pairs the user has no row for yet, and returns what it inserted. */
  appendIfMissing(userId: string, rows: NewLimitRow[], now: Date): Promise<CoreRiskLimit[]> {
    if (rows.length === 0) return Promise.resolve([]);
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`core_risk_limits:${userId}`}, 0))`;
      const present = new Set(
        (await tx.coreRiskLimit.findMany({ where: { userId }, select: { key: true, scope: true } })).map((r) => `${r.key}@${r.scope}`),
      );
      const last = await tx.coreRiskLimit.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
      let at = nextCreatedAt(last?.createdAt ?? null, now);
      const out: CoreRiskLimit[] = [];
      for (const row of rows) {
        if (present.has(`${row.key}@${row.scope}`)) continue;
        out.push(await tx.coreRiskLimit.create({ data: { ...row, userId, createdAt: at } }));
        at = new Date(at.getTime() + 1);
      }
      return out;
    });
  }
}
```

Create `apps/api/src/modules/trade-core/risk-wall/repositories/core-kill-switch.repository.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import type { CoreKillSwitch } from '@prisma/client';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { ConcurrentRiskChangeError, nextCreatedAt } from './core-risk-limit.repository';

export interface NewKillSwitchRow {
  active: boolean;
  effectiveFrom: Date;
  setBy: string;
  reason: string;
}

/** Per-user, append-only kill switch rows (spec §5.4). No update or delete method. */
@Injectable()
export class CoreKillSwitchRepository {
  constructor(private readonly prisma: PrismaService) {}

  listForUser(userId: string): Promise<CoreKillSwitch[]> {
    return this.prisma.coreKillSwitch.findMany({ where: { userId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  }

  /**
   * `expectNewestId` undefined = no check: turning the switch ON is never refused
   * (plan decision 8). A release passes the newest id it read.
   */
  append(userId: string, row: NewKillSwitchRow, now: Date, expectNewestId?: string | null): Promise<CoreKillSwitch> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`core_kill_switch:${userId}`}, 0))`;
      const newest = await tx.coreKillSwitch.findFirst({
        where: { userId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true, createdAt: true },
      });
      if (expectNewestId !== undefined && (newest?.id ?? null) !== expectNewestId) {
        throw new ConcurrentRiskChangeError('the kill switch');
      }
      return tx.coreKillSwitch.create({ data: { ...row, userId, createdAt: nextCreatedAt(newest?.createdAt ?? null, now) } });
    });
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @td/api test -- core-risk.repository`
Expected: PASS (9 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/trade-core/risk-wall/repositories/core-risk-limit.repository.ts apps/api/src/modules/trade-core/risk-wall/repositories/core-kill-switch.repository.ts apps/api/src/modules/trade-core/risk-wall/repositories/core-risk.repository.spec.ts apps/api/src/common/audit/audit-actions.ts
git commit -m "feat(trade-core): per-user append-only risk repositories and the risk audit group" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/api/src/modules/trade-core/risk-wall/repositories/core-risk-limit.repository.ts apps/api/src/modules/trade-core/risk-wall/repositories/core-kill-switch.repository.ts apps/api/src/modules/trade-core/risk-wall/repositories/core-risk.repository.spec.ts apps/api/src/common/audit/audit-actions.ts
```

---

### Task 6: Ports, seed values and `CoreRiskLimitService` (seed, list, change with D5)

**Files:**
- Create: `apps/api/src/modules/trade-core/risk-wall/ports.ts`
- Create: `apps/api/src/modules/trade-core/risk-wall/limits/seed-values.ts`
- Create: `apps/api/src/modules/trade-core/risk-wall/services/core-risk-limit.service.ts`
- Test: `apps/api/src/modules/trade-core/risk-wall/ports.spec.ts`
- Test: `apps/api/src/modules/trade-core/risk-wall/services/core-risk-limit.service.spec.ts`

**Interfaces:**
- Consumes: Tasks 1–5 (`LIMIT_PAIRS`, `parseLimitValue`, `toStorage`, `fromStorage`, `compareLimit`,
  `wireValue`, `resolveAppendOnly`, `nextSessionOpen`, `exchangesForScope`, `LimitInForce`,
  `RiskLiveState`, `RiskVerdict`, `CoreRiskLimitRepository`, `ConcurrentRiskChangeError`,
  `SeedSettings`, `SettingsForSeed`, `AUDIT_ACTIONS.risk`); `AuditService`; `SessionClock`,
  `MARKET_HOLIDAYS`.
- Produces:

```typescript
// ports.ts
export const CORE_SESSION_CLOCK: unique symbol;  export const RISK_STATE_PROVIDER: unique symbol;
export const RISK_VERDICT_SINK: unique symbol;   export const CORE_SQUARE_OFF: unique symbol;
export function createCoreSessionClock(): SessionClock;
export interface RiskStateProvider { liveState(userId: string, at: Date): Promise<RiskLiveState> }
export class RiskStateUnavailableError extends Error {}
export class UnavailableRiskStateProvider implements RiskStateProvider {}      // M2 default: throws
export interface RiskVerdictSink { record(verdict: RiskVerdict): Promise<void> }
export class LoggingRiskVerdictSink implements RiskVerdictSink {}             // M2 default: logs
export type CoreSquareOffCause = 'KILL_SWITCH' | 'DAILY_LOSS';
export interface CoreSquareOffResult { cancelledOrders: number; exitsRequested: number; detail: string }
export interface CoreSquareOffPort { squareOffAll(userId: string, cause: CoreSquareOffCause, reason: string): Promise<CoreSquareOffResult> }
export class NoCorePositionsSquareOff implements CoreSquareOffPort {}         // M2 default: none exist yet

// limits/seed-values.ts
export const SETTINGS_EQUIVALENTS: ReadonlyArray<{ key: LimitKey; scope: LimitScope; field: keyof SeedSettings }>;
export interface SeedValue { key: LimitKey; scope: LimitScope; value: string; source: 'USER_SETTINGS' | 'DEFAULT'; reason: string }
export function seedValueFor(pair: LimitPair, settings: SettingsForSeed, defaults: readonly CoreRiskLimitDefault[]): SeedValue | null;

// services/core-risk-limit.service.ts
export interface PendingLimitView { value: number | string; effectiveFrom: string; setAt: string; reason: string }
export interface CoreRiskLimitView { key; scope; kind; tighter; value: number | string | null; source: LimitSource | null; needsReview: boolean; effectiveFrom: string | null; setAt: string | null; setBy: string | null; reason: string | null; pending: PendingLimitView | null }
export interface LimitChangeInput { key: string; scope: string; value: unknown; reason: string }
export interface LimitChangeResult { limit: CoreRiskLimitView; direction: ChangeDirection; effectiveFrom: string }
class CoreRiskLimitService {
  ensureSeeded(userId: string, now?: Date): Promise<number>;
  list(userId: string, now?: Date): Promise<CoreRiskLimitView[]>;
  inForce(userId: string, now?: Date): Promise<LimitInForce[]>;
  change(userId: string, input: LimitChangeInput, now?: Date): Promise<LimitChangeResult>;
}
```

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/modules/trade-core/risk-wall/ports.spec.ts`:

```typescript
import { Logger } from '@nestjs/common';
import { SessionClock } from '../../market-hub/session-clock';
import {
  createCoreSessionClock,
  LoggingRiskVerdictSink,
  NoCorePositionsSquareOff,
  RiskStateUnavailableError,
  UnavailableRiskStateProvider,
} from './ports';
import { exitVerdict } from './risk-wall';

describe('M2 default port bindings (fail closed, never silent)', () => {
  it('the core clock knows the exchange holidays', () => {
    const clock = createCoreSessionClock();
    expect(clock).toBeInstanceOf(SessionClock);
    expect(clock.isTradingDay('NSE', new Date('2026-10-20T05:00:00.000Z'))).toBe(false); // Dussehra
    expect(clock.nextOpen('NFO', new Date('2026-10-09T05:30:00.000Z'))).toEqual(new Date('2026-10-12T03:45:00.000Z'));
  });

  it('the live-state provider refuses until M3/M4 bind a real one', async () => {
    await expect(new UnavailableRiskStateProvider().liveState('user_A', new Date())).rejects.toBeInstanceOf(RiskStateUnavailableError);
    await expect(new UnavailableRiskStateProvider().liveState('user_A', new Date())).rejects.toThrow(/M3\/M4/);
  });

  it('the core square-off reports that no core orders or positions exist yet', async () => {
    expect(await new NoCorePositionsSquareOff().squareOffAll('user_A', 'KILL_SWITCH', 'test')).toEqual({
      cancelledOrders: 0,
      exitsRequested: 0,
      detail: 'no core orders or positions exist yet (M3/M4 add them)',
    });
  });

  it('the verdict sink logs one line per verdict', async () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    await new LoggingRiskVerdictSink().record(exitVerdict({ kind: 'EXIT', intentId: 'x1', userId: 'user_A', positionId: 'p1', qty: 5 }, new Date()));
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).toContain('"intentId":"x1"');
    log.mockRestore();
  });
});
```

Create `apps/api/src/modules/trade-core/risk-wall/services/core-risk-limit.service.spec.ts`:

```typescript
import { ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { CoreRiskLimit, CoreRiskLimitDefault } from '@prisma/client';
import type { AuditService } from '../../../../common/audit/audit.service';
import type { SessionClock } from '../../../market-hub/session-clock';
import { toStorage } from '../limits/limit-keys';
import { createCoreSessionClock } from '../ports';
import {
  ConcurrentRiskChangeError,
  type CoreRiskLimitRepository,
  type NewLimitRow,
  type SettingsForSeed,
} from '../repositories/core-risk-limit.repository';
import { limitsFixture, NOW } from '../testing/risk-fixtures';
import { CoreRiskLimitService, type CoreRiskLimitView } from './core-risk-limit.service';

const NEXT_OPEN = new Date('2026-10-13T03:45:00.000Z'); // Tue 09:15 IST, the open after NOW (Mon 10:30 IST)
const DEFAULTS: CoreRiskLimitDefault[] = limitsFixture().map((l) => ({ key: l.key, scope: l.scope, ...toStorage(l.key, l.value), note: 'test default', updatedBy: null, updatedAt: NOW }));

/** In-memory stand-in for CoreRiskLimitRepository with the same contract (filters by userId, strict createdAt). */
class FakeRepo {
  rows: CoreRiskLimit[] = [];
  defaults: CoreRiskLimitDefault[] = DEFAULTS;
  settings: SettingsForSeed = { settings: null, from: null };
  failAppendWith: Error | null = null;
  private seq = 0;

  async listForUser(userId: string) { return this.rows.filter((r) => r.userId === userId); }
  async listForPair(userId: string, key: string, scope: string) { return this.rows.filter((r) => r.userId === userId && r.key === key && r.scope === scope); }
  async pairsForUser(userId: string) { return new Set((await this.listForUser(userId)).map((r) => `${r.key}@${r.scope}`)); }
  async listDefaults() { return this.defaults; }
  async settingsForSeed() { return this.settings; }

  async append(userId: string, row: NewLimitRow, now: Date, expectNewestId: string | null) {
    if (this.failAppendWith) throw this.failAppendWith;
    const pair = await this.listForPair(userId, row.key, row.scope);
    const newest = [...pair].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    if ((newest?.id ?? null) !== expectNewestId) throw new ConcurrentRiskChangeError(row.key);
    return this.insert(userId, row, now);
  }

  async appendIfMissing(userId: string, rows: NewLimitRow[], now: Date) {
    const present = await this.pairsForUser(userId);
    return rows.filter((r) => !present.has(`${r.key}@${r.scope}`)).map((r) => this.insert(userId, r, now));
  }

  private insert(userId: string, row: NewLimitRow, now: Date): CoreRiskLimit {
    this.seq += 1;
    const r = { id: `lim_${this.seq}`, userId, ...row, createdAt: new Date(now.getTime() + this.seq) } as CoreRiskLimit;
    this.rows.push(r);
    return r;
  }
}

function setup(opts: { settings?: SettingsForSeed; defaults?: CoreRiskLimitDefault[]; clock?: Pick<SessionClock, 'nextOpen'> } = {}) {
  const repo = new FakeRepo();
  if (opts.settings) repo.settings = opts.settings;
  if (opts.defaults) repo.defaults = opts.defaults;
  const audit = { append: jest.fn().mockResolvedValue({ seq: 1n, hash: 'h' }) };
  const service = new CoreRiskLimitService(
    repo as unknown as CoreRiskLimitRepository,
    audit as unknown as AuditService,
    (opts.clock ?? createCoreSessionClock()) as SessionClock,
  );
  return { repo, audit, service };
}

const find = (views: CoreRiskLimitView[], id: string) => views.find((v) => `${v.key}@${v.scope}` === id)!;
const OWN = { settings: { maxDailyLoss: 7500, maxCapitalPerTrade: 40000, maxConcurrentPositions: 8 }, from: 'OWN' as const };

describe('CoreRiskLimitService: seeding (plan decision 7)', () => {
  it('seeds every pair once: settings equivalents from the user’s settings, the rest from defaults marked for review', async () => {
    const { repo, audit, service } = setup({ settings: OWN });
    const views = await service.list('user_A', NOW);
    expect(views).toHaveLength(21);
    expect(find(views, 'maxDailyLoss@ALL')).toMatchObject({
      value: 7500, source: 'USER_SETTINGS', needsReview: false, setBy: 'SEED',
      reason: 'copied from your settings (user_settings.maxDailyLoss)', effectiveFrom: NOW.toISOString(), pending: null,
    });
    expect(find(views, 'maxOpenPositions@ALL')).toMatchObject({ value: 8, source: 'USER_SETTINGS' });
    expect(find(views, 'optionsMaxPremiumPerTrade@OPTIONS_BUY')).toMatchObject({ value: 40000, source: 'USER_SETTINGS' });
    expect(find(views, 'maxTradesPerDay@ALL')).toMatchObject({
      kind: 'count', tighter: 'lower', value: 20, source: 'DEFAULT', needsReview: true, reason: 'default — please review (test default)',
    });
    expect(find(views, 'lastEntryTime@OPTIONS_BUY')).toMatchObject({ kind: 'hhmm', tighter: 'earlier', value: '14:30' });
    expect(audit.append).toHaveBeenCalledTimes(1);
    expect(audit.append.mock.calls[0][0]).toMatchObject({
      action: 'CORE_RISK_LIMITS_SEEDED', userId: 'user_A', target: 'core_risk_limits:user_A', meta: { count: 21, unseeded: [] },
    });
    await service.list('user_A', NOW);
    expect(repo.rows).toHaveLength(21);
    expect(audit.append).toHaveBeenCalledTimes(1);
  });

  it('with no settings row every pair comes from the defaults; the platform row is named when used', async () => {
    const none = setup();
    expect(find(await none.service.list('user_B', NOW), 'maxDailyLoss@ALL')).toMatchObject({ value: 5000, source: 'DEFAULT', needsReview: true });
    const platform = setup({ settings: { ...OWN, from: 'PLATFORM' } });
    expect(find(await platform.service.list('usr_owner', NOW), 'maxDailyLoss@ALL').reason).toBe(
      'copied from the platform settings row (user_settings.maxDailyLoss)',
    );
  });

  it('a settings value that does not fit its limit falls back to the default; money rounds to 2 dp', async () => {
    const { service } = setup({ settings: { settings: { maxDailyLoss: 1234.567, maxCapitalPerTrade: -5, maxConcurrentPositions: 2.5 }, from: 'OWN' } });
    const views = await service.list('user_A', NOW);
    expect(find(views, 'maxDailyLoss@ALL')).toMatchObject({ value: 1234.57, source: 'USER_SETTINGS' });
    expect(find(views, 'maxOpenPositions@ALL')).toMatchObject({ value: 5, source: 'DEFAULT' });
    expect(find(views, 'optionsMaxPremiumPerTrade@OPTIONS_BUY')).toMatchObject({ value: 50000, source: 'DEFAULT' });
  });

  it('a pair with neither a setting nor a default stays unset and is reported in the audit', async () => {
    const { audit, service } = setup({ defaults: DEFAULTS.filter((d) => d.key !== 'maxTradesPerDay') });
    const views = await service.list('user_A', NOW);
    expect(find(views, 'maxTradesPerDay@ALL')).toMatchObject({ value: null, source: null, needsReview: false, pending: null });
    expect(audit.append.mock.calls[0][0].meta).toMatchObject({ count: 20, unseeded: ['maxTradesPerDay@ALL'] });
  });
});

describe('CoreRiskLimitService: change (D5)', () => {
  it('a tighter change takes effect now and is audited with from, to, direction and reason', async () => {
    const { audit, service } = setup();
    const r = await service.change('user_A', { key: 'maxDailyLoss', scope: 'ALL', value: 4000, reason: '  bad week  ' }, NOW);
    expect(r).toMatchObject({ direction: 'TIGHTER', effectiveFrom: NOW.toISOString() });
    expect(r.limit).toMatchObject({ value: 4000, source: 'USER', setBy: 'user_A', reason: 'bad week', pending: null, needsReview: false });
    expect(audit.append).toHaveBeenLastCalledWith({
      action: 'CORE_RISK_LIMIT_CHANGED',
      userId: 'user_A',
      target: expect.stringMatching(/^core_risk_limit:lim_\d+$/),
      meta: { key: 'maxDailyLoss', scope: 'ALL', from: '5000.00', to: '4000.00', direction: 'TIGHTER', effectiveFrom: NOW.toISOString(), reason: 'bad week', supersedes: null },
    });
  });

  it('a looser change waits for the next session open, shown as pending until then', async () => {
    const { service } = setup();
    const r = await service.change('user_A', { key: 'maxDailyLoss', scope: 'ALL', value: 8000, reason: 'more room' }, NOW);
    expect(r).toMatchObject({ direction: 'LOOSER', effectiveFrom: NEXT_OPEN.toISOString() });
    expect(r.limit).toMatchObject({ value: 5000, pending: { value: 8000, effectiveFrom: NEXT_OPEN.toISOString(), reason: 'more room' } });
    expect(find(await service.list('user_A', new Date(NEXT_OPEN.getTime() - 1)), 'maxDailyLoss@ALL').value).toBe(5000);
    expect(find(await service.list('user_A', NEXT_OPEN), 'maxDailyLoss@ALL')).toMatchObject({ value: 8000, pending: null });
  });

  it('re-entering the value in force cancels a pending loosening', async () => {
    const { audit, service } = setup();
    const loosen = await service.change('user_A', { key: 'maxDailyLoss', scope: 'ALL', value: 8000, reason: 'more room' }, NOW);
    expect(loosen.limit.pending).not.toBeNull();
    const same = await service.change('user_A', { key: 'maxDailyLoss', scope: 'ALL', value: 5000, reason: 'changed my mind' }, NOW);
    expect(same).toMatchObject({ direction: 'SAME', effectiveFrom: NOW.toISOString() });
    expect(same.limit).toMatchObject({ value: 5000, pending: null });
    expect(audit.append.mock.calls[audit.append.mock.calls.length - 1][0].meta.supersedes).toMatch(/^lim_\d+$/);
    expect(find(await service.list('user_A', NEXT_OPEN), 'maxDailyLoss@ALL').value).toBe(5000);
  });

  it('a tightening after a pending loosening supersedes it for good', async () => {
    const { service } = setup();
    await service.change('user_A', { key: 'maxDailyLoss', scope: 'ALL', value: 8000, reason: 'more room' }, NOW);
    expect((await service.change('user_A', { key: 'maxDailyLoss', scope: 'ALL', value: 3000, reason: 'no' }, NOW)).direction).toBe('TIGHTER');
    expect(find(await service.list('user_A', NEXT_OPEN), 'maxDailyLoss@ALL').value).toBe(3000);
  });

  it('a per-vehicle loosening waits for that vehicle’s exchange; an ALL loosening for every core exchange', async () => {
    const nextOpen = jest.fn().mockReturnValue(NEXT_OPEN);
    const { service } = setup({ clock: { nextOpen } });
    await service.change('user_A', { key: 'optionsMaxPremiumPerTrade', scope: 'OPTIONS_BUY', value: 60000, reason: 'r1' }, NOW);
    expect(nextOpen.mock.calls.map((c) => c[0])).toEqual(['NFO']);
    nextOpen.mockClear();
    await service.change('user_A', { key: 'maxDailyLoss', scope: 'ALL', value: 6000, reason: 'r2' }, NOW);
    expect(nextOpen.mock.calls.map((c) => c[0])).toEqual(['NSE', 'NFO']);
    nextOpen.mockClear();
    await service.change('user_A', { key: 'squareOffTime', scope: 'CASH_INTRADAY', value: '15:10', reason: 'earlier' }, NOW);
    expect(nextOpen).not.toHaveBeenCalled();
  });

  it('no known session open: 409, nothing written', async () => {
    const { repo, audit, service } = setup({ clock: { nextOpen: () => null } });
    await expect(service.change('user_A', { key: 'maxDailyLoss', scope: 'ALL', value: 9000, reason: 'r' }, NOW)).rejects.toBeInstanceOf(ConflictException);
    expect(repo.rows).toHaveLength(21);
    expect(audit.append).toHaveBeenCalledTimes(1);
  });

  it('an unknown key or scope is 404 and a bad value is 422, before anything is written', async () => {
    const { repo, service } = setup();
    await expect(service.change('user_A', { key: 'nope', scope: 'ALL', value: 1, reason: 'r' }, NOW)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.change('user_A', { key: 'maxDailyLoss', scope: 'MTF', value: 1, reason: 'r' }, NOW)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.change('user_A', { key: 'maxDailyLoss', scope: 'ALL', value: '5000', reason: 'r' }, NOW)).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(service.change('user_A', { key: 'lastEntryTime', scope: 'CASH_INTRADAY', value: '3pm', reason: 'r' }, NOW)).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(repo.rows).toHaveLength(0);
  });

  it('a concurrent change to the same limit is 409', async () => {
    const { repo, service } = setup();
    await service.list('user_A', NOW);
    repo.failAppendWith = new ConcurrentRiskChangeError('maxDailyLoss');
    await expect(service.change('user_A', { key: 'maxDailyLoss', scope: 'ALL', value: 1000, reason: 'r' }, NOW)).rejects.toBeInstanceOf(ConflictException);
  });

  it('setting a limit that has no usable row is a loosening', async () => {
    const { service } = setup({ defaults: DEFAULTS.filter((d) => d.key !== 'maxTradesPerDay') });
    const r = await service.change('user_A', { key: 'maxTradesPerDay', scope: 'ALL', value: 10, reason: 'set it' }, NOW);
    expect(r).toMatchObject({ direction: 'LOOSER', effectiveFrom: NEXT_OPEN.toISOString() });
    expect(r.limit).toMatchObject({ value: null, pending: { value: 10 } });
  });

  it('one user’s change never shows for another user', async () => {
    const { service } = setup();
    await service.change('user_A', { key: 'maxDailyLoss', scope: 'ALL', value: 4000, reason: 'mine' }, NOW);
    expect(find(await service.list('user_B', NOW), 'maxDailyLoss@ALL').value).toBe(5000);
  });
});

describe('CoreRiskLimitService: inForce (what the Risk Wall reads)', () => {
  it('returns the canonical value, row id and source of every pair in force, seeding first', async () => {
    const { service } = setup({ settings: OWN });
    const limits = await service.inForce('user_A', NOW);
    expect(limits).toHaveLength(21);
    expect(limits.find((l) => l.key === 'maxDailyLoss')).toEqual({
      key: 'maxDailyLoss', scope: 'ALL', value: '7500.00', rowId: expect.stringMatching(/^lim_/), effectiveFrom: NOW.toISOString(), source: 'USER_SETTINGS',
    });
  });

  it('a malformed newest row in force leaves the pair out (the wall then rejects: fail closed)', async () => {
    const { repo, service } = setup();
    await service.list('user_A', NOW);
    repo.rows.push({
      id: 'lim_bad', userId: 'user_A', key: 'maxDailyLoss', scope: 'ALL', numValue: null, textValue: 'oops',
      effectiveFrom: NOW, source: 'USER', setBy: 'user_A', reason: 'corrupt', createdAt: new Date(NOW.getTime() + 999),
    } as CoreRiskLimit);
    const limits = await service.inForce('user_A', NOW);
    expect(limits.map((l) => l.key)).not.toContain('maxDailyLoss');
    expect(limits).toHaveLength(20);
  });
});

```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @td/api test -- ports.spec core-risk-limit.service`
Expected: FAIL with `Cannot find module './ports'` and `Cannot find module './core-risk-limit.service'`.

- [ ] **Step 3: Write the ports**

Create `apps/api/src/modules/trade-core/risk-wall/ports.ts`:

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { MARKET_HOLIDAYS } from '../../market-data/services/market-holidays.service';
import { SessionClock } from '../../market-hub/session-clock';
import type { RiskLiveState, RiskVerdict } from './risk-wall.types';

/**
 * What M2 needs from later milestones, as injection tokens with fail-closed M2
 * defaults (plan decision 3). M3/M4/M5 rebind them in TradeCoreModule; see the plan's
 * "Notes for later milestones".
 */
export const CORE_SESSION_CLOCK = Symbol('CORE_SESSION_CLOCK');
export const RISK_STATE_PROVIDER = Symbol('RISK_STATE_PROVIDER');
export const RISK_VERDICT_SINK = Symbol('RISK_VERDICT_SINK');
export const CORE_SQUARE_OFF = Symbol('CORE_SQUARE_OFF');

/** The core's clock: the hub's holiday list. MCX late close is left out: no core vehicle trades MCX. */
export function createCoreSessionClock(): SessionClock {
  return new SessionClock({ holidays: MARKET_HOLIDAYS });
}

export interface RiskStateProvider {
  liveState(userId: string, at: Date): Promise<RiskLiveState>;
}

export class RiskStateUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RiskStateUnavailableError';
  }
}

/** M2 default: there are no core positions or P&L yet, so every entry is rejected. */
@Injectable()
export class UnavailableRiskStateProvider implements RiskStateProvider {
  async liveState(): Promise<RiskLiveState> {
    throw new RiskStateUnavailableError('core positions and P&L are not available until M3/M4 bind RISK_STATE_PROVIDER');
  }
}

export interface RiskVerdictSink {
  record(verdict: RiskVerdict): Promise<void>;
}

/** M2 default: one log line per verdict. M5 rebinds this to core_journal (RISK_VERDICT rows). */
@Injectable()
export class LoggingRiskVerdictSink implements RiskVerdictSink {
  private readonly logger = new Logger('RiskVerdict');

  async record(v: RiskVerdict): Promise<void> {
    this.logger.log(
      JSON.stringify({ intentId: v.intentId, userId: v.userId, verdict: v.verdict, qty: v.qty, requestedQty: v.requestedQty, reasons: v.reasons.map((r) => r.code) }),
    );
  }
}

export type CoreSquareOffCause = 'KILL_SWITCH' | 'DAILY_LOSS';

export interface CoreSquareOffResult {
  cancelledOrders: number;
  exitsRequested: number;
  detail: string;
}

/** Cancels the user's pending core orders and exits all core positions (spec §5.3, §5.4). M3/M4 implement it. */
export interface CoreSquareOffPort {
  squareOffAll(userId: string, cause: CoreSquareOffCause, reason: string): Promise<CoreSquareOffResult>;
}

/** M2 default: truthful, because core_orders and core_positions do not exist before M3/M4. */
@Injectable()
export class NoCorePositionsSquareOff implements CoreSquareOffPort {
  async squareOffAll(): Promise<CoreSquareOffResult> {
    return { cancelledOrders: 0, exitsRequested: 0, detail: 'no core orders or positions exist yet (M3/M4 add them)' };
  }
}
```

- [ ] **Step 4: Write the seed values and the service**

Create `apps/api/src/modules/trade-core/risk-wall/limits/seed-values.ts`:

```typescript
import { Prisma, type CoreRiskLimitDefault } from '@prisma/client';
import type { SeedSettings, SettingsForSeed } from '../repositories/core-risk-limit.repository';
import { fromStorage, LIMIT_KEYS, parseLimitValue, type LimitKey, type LimitPair, type LimitScope } from './limit-keys';

/**
 * UserSettings fields with the same meaning as a core limit (plan decision 7; each
 * is enforced today by trade-engine/services/risk-manager.service.ts).
 */
export const SETTINGS_EQUIVALENTS: ReadonlyArray<{ key: LimitKey; scope: LimitScope; field: keyof SeedSettings }> = [
  { key: 'maxDailyLoss', scope: 'ALL', field: 'maxDailyLoss' },
  { key: 'maxOpenPositions', scope: 'ALL', field: 'maxConcurrentPositions' },
  { key: 'optionsMaxPremiumPerTrade', scope: 'OPTIONS_BUY', field: 'maxCapitalPerTrade' },
];

export interface SeedValue {
  key: LimitKey;
  scope: LimitScope;
  value: string;
  source: 'USER_SETTINGS' | 'DEFAULT';
  reason: string;
}

/** A Float settings value as the limit's canonical string, or null when it does not fit. */
function fromSetting(key: LimitKey, raw: unknown): string | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  const n = LIMIT_KEYS[key].kind === 'rupees' ? Number(new Prisma.Decimal(raw).toFixed(2)) : raw;
  const p = parseLimitValue(key, n);
  return p.ok ? p.value : null;
}

/** The seed for one pair: the settings equivalent when usable, else the default row, else null (left unset). */
export function seedValueFor(pair: LimitPair, seed: SettingsForSeed, defaults: readonly CoreRiskLimitDefault[]): SeedValue | null {
  const eq = SETTINGS_EQUIVALENTS.find((e) => e.key === pair.key && e.scope === pair.scope);
  if (eq && seed.settings) {
    const value = fromSetting(pair.key, seed.settings[eq.field]);
    if (value !== null) {
      const reason = seed.from === 'PLATFORM'
        ? `copied from the platform settings row (user_settings.${eq.field})`
        : `copied from your settings (user_settings.${eq.field})`;
      return { key: pair.key, scope: pair.scope, value, source: 'USER_SETTINGS', reason };
    }
  }
  const d = defaults.find((x) => x.key === pair.key && x.scope === pair.scope);
  const value = d ? fromStorage(pair.key, d.numValue, d.textValue) : null;
  if (!d || value === null) return null;
  return { key: pair.key, scope: pair.scope, value, source: 'DEFAULT', reason: `default — please review (${d.note})` };
}
```

Create `apps/api/src/modules/trade-core/risk-wall/services/core-risk-limit.service.ts`:

```typescript
import { ConflictException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { CoreRiskLimit } from '@prisma/client';
import { AuditService } from '../../../../common/audit/audit.service';
import { AUDIT_ACTIONS } from '../../../../common/audit/audit-actions';
import type { SessionClock } from '../../../market-hub/session-clock';
import { resolveAppendOnly } from '../limits/append-only';
import {
  compareLimit,
  fromStorage,
  isLimitKey,
  isLimitPair,
  LIMIT_KEYS,
  LIMIT_PAIRS,
  pairId,
  parseLimitValue,
  toStorage,
  wireValue,
  type ChangeDirection,
  type LimitKey,
  type LimitKind,
  type LimitScope,
  type TighterDirection,
} from '../limits/limit-keys';
import { seedValueFor, type SeedValue } from '../limits/seed-values';
import { CORE_SESSION_CLOCK } from '../ports';
import { ConcurrentRiskChangeError, CoreRiskLimitRepository } from '../repositories/core-risk-limit.repository';
import type { LimitInForce, LimitSource } from '../risk-wall.types';
import { exchangesForScope, nextSessionOpen } from '../session-open';

export interface PendingLimitView {
  value: number | string;
  effectiveFrom: string;
  setAt: string;
  reason: string;
}

/** One limit as the Risk page shows it (spec §8.4: limits with pending-loosen indicators). */
export interface CoreRiskLimitView {
  key: LimitKey;
  scope: LimitScope;
  kind: LimitKind;
  tighter: TighterDirection;
  /** In force now; null when the pair has no usable row (the wall rejects entries that need it). */
  value: number | string | null;
  source: LimitSource | null;
  /** In force from a seed default: "default — please review". */
  needsReview: boolean;
  effectiveFrom: string | null;
  setAt: string | null;
  setBy: string | null;
  reason: string | null;
  /** The newest change while it is not yet effective (a loosening waiting for the next open). */
  pending: PendingLimitView | null;
}

export interface LimitChangeInput {
  key: string;
  scope: string;
  value: unknown;
  reason: string;
}

export interface LimitChangeResult {
  limit: CoreRiskLimitView;
  direction: ChangeDirection;
  effectiveFrom: string;
}

function viewOf(key: LimitKey, scope: LimitScope, rows: readonly CoreRiskLimit[], now: Date): CoreRiskLimitView {
  const { inForce, pending } = resolveAppendOnly(rows, now);
  const value = inForce ? fromStorage(key, inForce.numValue, inForce.textValue) : null;
  const pendingValue = pending ? fromStorage(key, pending.numValue, pending.textValue) : null;
  const usable = inForce !== null && value !== null;
  return {
    key,
    scope,
    kind: LIMIT_KEYS[key].kind,
    tighter: LIMIT_KEYS[key].tighter,
    value: usable ? wireValue(key, value) : null,
    source: usable ? (inForce.source as LimitSource) : null,
    needsReview: usable && inForce.source === 'DEFAULT',
    effectiveFrom: usable ? inForce.effectiveFrom.toISOString() : null,
    setAt: usable ? inForce.createdAt.toISOString() : null,
    setBy: usable ? inForce.setBy : null,
    reason: usable ? inForce.reason : null,
    pending:
      pending && pendingValue !== null
        ? { value: wireValue(key, pendingValue), effectiveFrom: pending.effectiveFrom.toISOString(), setAt: pending.createdAt.toISOString(), reason: pending.reason }
        : null,
  };
}

const rowsFor = (rows: readonly CoreRiskLimit[], key: string, scope: string) => rows.filter((r) => r.key === key && r.scope === scope);

/**
 * A user's own limits (spec §5.2): lazy seed (plan decision 7), the Risk page view,
 * the values in force for the wall, and changes under D5 (tighter or same = now,
 * looser = next session open for the scope's exchanges). Every write is audited.
 */
@Injectable()
export class CoreRiskLimitService {
  constructor(
    private readonly repo: CoreRiskLimitRepository,
    private readonly audit: AuditService,
    @Inject(CORE_SESSION_CLOCK) private readonly clock: SessionClock,
  ) {}

  async ensureSeeded(userId: string, now: Date = new Date()): Promise<number> {
    const present = await this.repo.pairsForUser(userId);
    const missing = LIMIT_PAIRS.filter((p) => !present.has(pairId(p)));
    if (missing.length === 0) return 0;
    const [seed, defaults] = await Promise.all([this.repo.settingsForSeed(userId), this.repo.listDefaults()]);
    const values = missing.map((p) => seedValueFor(p, seed, defaults)).filter((s): s is SeedValue => s !== null);
    const inserted = await this.repo.appendIfMissing(
      userId,
      values.map((s) => ({ key: s.key, scope: s.scope, ...toStorage(s.key, s.value), effectiveFrom: now, source: s.source, setBy: 'SEED', reason: s.reason })),
      now,
    );
    if (inserted.length > 0) {
      await this.audit.append({
        action: AUDIT_ACTIONS.risk.CORE_RISK_LIMITS_SEEDED,
        userId,
        target: `core_risk_limits:${userId}`,
        meta: {
          count: inserted.length,
          limits: inserted.map((r) => ({ key: r.key, scope: r.scope, value: isLimitKey(r.key) ? fromStorage(r.key, r.numValue, r.textValue) : null, source: r.source })),
          unseeded: missing.filter((p) => !values.some((s) => s.key === p.key && s.scope === p.scope)).map(pairId),
        },
      });
    }
    return inserted.length;
  }

  async list(userId: string, now: Date = new Date()): Promise<CoreRiskLimitView[]> {
    await this.ensureSeeded(userId, now);
    const rows = await this.repo.listForUser(userId);
    return LIMIT_PAIRS.map((p) => viewOf(p.key, p.scope, rowsFor(rows, p.key, p.scope), now));
  }

  async inForce(userId: string, now: Date = new Date()): Promise<LimitInForce[]> {
    await this.ensureSeeded(userId, now);
    const rows = await this.repo.listForUser(userId);
    return LIMIT_PAIRS.flatMap((p) => {
      const { inForce } = resolveAppendOnly(rowsFor(rows, p.key, p.scope), now);
      const value = inForce ? fromStorage(p.key, inForce.numValue, inForce.textValue) : null;
      return inForce && value !== null
        ? [{ key: p.key, scope: p.scope, value, rowId: inForce.id, effectiveFrom: inForce.effectiveFrom.toISOString(), source: inForce.source as LimitSource }]
        : [];
    });
  }

  async change(userId: string, input: LimitChangeInput, now: Date = new Date()): Promise<LimitChangeResult> {
    if (!isLimitKey(input.key)) throw new NotFoundException(`unknown limit ${input.key}`);
    if (!isLimitPair(input.key, input.scope)) {
      throw new NotFoundException(`${input.key} has no ${input.scope} scope (it has ${LIMIT_KEYS[input.key].scopes.join(', ')})`);
    }
    const key = input.key;
    const scope = input.scope as LimitScope;
    const parsed = parseLimitValue(key, input.value);
    if (!parsed.ok) throw new UnprocessableEntityException(`${key} ${parsed.error}`);
    const reason = input.reason.trim();

    await this.ensureSeeded(userId, now);
    const rows = await this.repo.listForPair(userId, key, scope);
    const { inForce, pending, newest } = resolveAppendOnly(rows, now);
    const current = inForce ? fromStorage(key, inForce.numValue, inForce.textValue) : null;
    const direction: ChangeDirection = current === null ? 'LOOSER' : compareLimit(key, current, parsed.value);

    let effectiveFrom = now;
    if (direction === 'LOOSER') {
      const exchanges = exchangesForScope(scope);
      const open = nextSessionOpen(this.clock, exchanges, now);
      if (!open) {
        throw new ConflictException(`no session open is known in the next 14 days for ${exchanges.join('/')}, so a looser ${key} cannot be scheduled`);
      }
      effectiveFrom = open;
    }

    let row: CoreRiskLimit;
    try {
      row = await this.repo.append(
        userId,
        { key, scope, ...toStorage(key, parsed.value), effectiveFrom, source: 'USER', setBy: userId, reason },
        now,
        newest?.id ?? null,
      );
    } catch (err) {
      if (err instanceof ConcurrentRiskChangeError) throw new ConflictException(`${key} (${scope}) changed at the same time; reload and retry`);
      throw err;
    }
    await this.audit.append({
      action: AUDIT_ACTIONS.risk.CORE_RISK_LIMIT_CHANGED,
      userId,
      target: `core_risk_limit:${row.id}`,
      meta: { key, scope, from: current, to: parsed.value, direction, effectiveFrom: effectiveFrom.toISOString(), reason, supersedes: pending?.id ?? null },
    });
    return { limit: viewOf(key, scope, [...rows, row], now), direction, effectiveFrom: effectiveFrom.toISOString() };
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @td/api test -- ports.spec core-risk-limit.service`
Expected: PASS (4 + 16 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/trade-core/risk-wall/ports.ts apps/api/src/modules/trade-core/risk-wall/ports.spec.ts apps/api/src/modules/trade-core/risk-wall/limits/seed-values.ts apps/api/src/modules/trade-core/risk-wall/services/core-risk-limit.service.ts apps/api/src/modules/trade-core/risk-wall/services/core-risk-limit.service.spec.ts
git commit -m "feat(trade-core): risk limits service: lazy seed from settings and defaults, tighten now, loosen next session" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/api/src/modules/trade-core/risk-wall/ports.ts apps/api/src/modules/trade-core/risk-wall/ports.spec.ts apps/api/src/modules/trade-core/risk-wall/limits/seed-values.ts apps/api/src/modules/trade-core/risk-wall/services/core-risk-limit.service.ts apps/api/src/modules/trade-core/risk-wall/services/core-risk-limit.service.spec.ts
```

---

### Task 7: `SiloSquareOffAdapter` — the one adapter to the silos' existing entry points

**Files:**
- Create: `apps/api/src/modules/trade-core/risk-wall/services/silo-square-off.adapter.ts`
- Test: `apps/api/src/modules/trade-core/risk-wall/services/silo-square-off.adapter.spec.ts`

**Interfaces:**
- Consumes (existing, unchanged; imported only as injection tokens): `AutoExecSettingsService.update`,
  `AUTO_EXEC_SEGMENTS` (`auto-execution/services/auto-exec-settings.service.ts:7,91`);
  `WatchService.squareOffAll('manual')` (`watch-monitor/services/watch.service.ts:1083`);
  `AdaptiveStopTickPoller.eodSquareOff(): Promise<SquareOffSummary>` (`adaptive-stop-track/services/adaptive-stop-tick-poller.service.ts:96,148`);
  `UngatedTickPoller.eodSquareOff(): Promise<void>` (`ungated-track/services/ungated-tick-poller.service.ts:95`);
  `UngatedWatchRepository.findAllActive()` (`ungated-track/repositories/ungated-watch.repository.ts:104`);
  `SellFuturesService.squareOffOpenPositions()` (`sell-futures-track/services/sell-futures.service.ts:429`);
  `TradeExecutionService.closeAllPositions(reason)` (`trade-engine/services/trade-execution.service.ts:620`);
  `ModuleRef` (`@nestjs/core`); `Actor` (`strategies/services/core-strategy-catalogue.service.ts:16`).
- Produces:

```typescript
export const SILO_TARGETS: readonly ['auto-execution', 'watch-monitor', 'adaptive-stop-track', 'ungated-track', 'sell-futures-track', 'trade-engine'];
export type SiloTarget = (typeof SILO_TARGETS)[number];
export type SiloStatus = 'OK' | 'FAILED' | 'SKIPPED' | 'UNAVAILABLE';
export interface SiloSquareOffResult { target: SiloTarget; status: SiloStatus; detail: string }
class SiloSquareOffAdapter { squareOffAll(actor: Actor, reason: string): Promise<SiloSquareOffResult[]> }   // never throws
```

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/modules/trade-core/risk-wall/services/silo-square-off.adapter.spec.ts`:

```typescript
// The silo modules are replaced by bare token classes: this spec never loads silo code.
jest.mock('../../../auto-execution/services/auto-exec-settings.service', () => ({
  AutoExecSettingsService: class AutoExecSettingsService {},
  AUTO_EXEC_SEGMENTS: ['INTRADAY', 'SWING'],
}));
jest.mock('../../../watch-monitor/services/watch.service', () => ({ WatchService: class WatchService {} }));
jest.mock('../../../adaptive-stop-track/services/adaptive-stop-tick-poller.service', () => ({ AdaptiveStopTickPoller: class AdaptiveStopTickPoller {} }));
jest.mock('../../../ungated-track/services/ungated-tick-poller.service', () => ({ UngatedTickPoller: class UngatedTickPoller {} }));
jest.mock('../../../ungated-track/repositories/ungated-watch.repository', () => ({ UngatedWatchRepository: class UngatedWatchRepository {} }));
jest.mock('../../../sell-futures-track/services/sell-futures.service', () => ({ SellFuturesService: class SellFuturesService {} }));
jest.mock('../../../trade-engine/services/trade-execution.service', () => ({ TradeExecutionService: class TradeExecutionService {} }));

import type { ModuleRef } from '@nestjs/core';
import { AdaptiveStopTickPoller } from '../../../adaptive-stop-track/services/adaptive-stop-tick-poller.service';
import { AutoExecSettingsService } from '../../../auto-execution/services/auto-exec-settings.service';
import { SellFuturesService } from '../../../sell-futures-track/services/sell-futures.service';
import { TradeExecutionService } from '../../../trade-engine/services/trade-execution.service';
import { UngatedWatchRepository } from '../../../ungated-track/repositories/ungated-watch.repository';
import { UngatedTickPoller } from '../../../ungated-track/services/ungated-tick-poller.service';
import { WatchService } from '../../../watch-monitor/services/watch.service';
import { SILO_TARGETS, SiloSquareOffAdapter } from './silo-square-off.adapter';

const OWNER = { userId: 'usr_owner', role: 'ADMIN' };
const USER = { userId: 'user_A', role: 'USER' };

function setup() {
  const calls: string[] = [];
  let ungatedTraded = 2;
  const watch = { squareOffAll: jest.fn(async (_reason: string) => { calls.push('watch'); return { watchingClosed: 2, tradedClosed: 3, errors: 0 }; }) };
  const adaptive = { eodSquareOff: jest.fn(async () => { calls.push('adaptive'); return { attempted: 1, closed: 1, skipped: 0, errors: 0 }; }) };
  const ungatedPoller = { eodSquareOff: jest.fn(async () => { calls.push('ungated'); ungatedTraded = 0; }) };
  const ungatedRepo = {
    findAllActive: jest.fn(async () => [...Array.from({ length: ungatedTraded }, () => ({ status: 'TRADED' })), { status: 'WATCHING' }]),
  };
  const sellFutures = { squareOffOpenPositions: jest.fn(async () => { calls.push('sell-futures'); return { closed: 1, errors: 0 }; }) };
  const tradeEngine = { closeAllPositions: jest.fn(async (reason: string) => { calls.push(`trade-engine:${reason}`); return { closed: 4 }; }) };
  const autoExec = { update: jest.fn(async (userId: string, segment: string) => { calls.push(`auto-exec:${userId}:${segment}`); return {}; }) };
  const services = new Map<unknown, unknown>([
    [AutoExecSettingsService, autoExec],
    [WatchService, watch],
    [AdaptiveStopTickPoller, adaptive],
    [UngatedTickPoller, ungatedPoller],
    [UngatedWatchRepository, ungatedRepo],
    [SellFuturesService, sellFutures],
    [TradeExecutionService, tradeEngine],
  ]);
  const moduleRef = {
    get: jest.fn((token: { name: string }) => {
      if (!services.has(token)) throw new Error(`Nest could not find ${token.name} element`);
      return services.get(token);
    }),
  };
  const adapter = new SiloSquareOffAdapter(moduleRef as unknown as ModuleRef);
  return { calls, services, moduleRef, adapter, watch, adaptive, ungatedPoller, sellFutures, tradeEngine, autoExec };
}

describe('SiloSquareOffAdapter', () => {
  it('for the owner, calls every silo entry point once, in order, auto-execution first and trade-engine last', async () => {
    const { calls, moduleRef, adapter, watch, autoExec } = setup();
    const results = await adapter.squareOffAll(OWNER, 'panic');
    expect(results.map((r) => r.target)).toEqual([...SILO_TARGETS]);
    expect(results.map((r) => r.status)).toEqual(['OK', 'OK', 'OK', 'OK', 'OK', 'OK']);
    expect(calls).toEqual([
      'auto-exec:usr_owner:INTRADAY', 'auto-exec:usr_owner:SWING',
      'watch', 'adaptive', 'ungated', 'sell-futures',
      'trade-engine:core kill switch: panic',
    ]);
    expect(autoExec.update).toHaveBeenCalledWith('usr_owner', 'INTRADAY', { killSwitch: true });
    expect(watch.squareOffAll).toHaveBeenCalledWith('manual');
    expect(moduleRef.get).toHaveBeenCalledWith(WatchService, { strict: false });
    expect(results.find((r) => r.target === 'ungated-track')?.detail).toBe('closed 2 of 2; 0 still open');
    expect(results.find((r) => r.target === 'trade-engine')?.detail).toContain('closed 4 open trades');
  });

  it('a non-owner sets only their own auto-execution kill flag and never resolves a platform silo', async () => {
    const { calls, moduleRef, adapter } = setup();
    const results = await adapter.squareOffAll(USER, 'stop');
    expect(results.map((r) => [r.target, r.status])).toEqual([
      ['auto-execution', 'OK'],
      ['watch-monitor', 'SKIPPED'],
      ['adaptive-stop-track', 'SKIPPED'],
      ['ungated-track', 'SKIPPED'],
      ['sell-futures-track', 'SKIPPED'],
      ['trade-engine', 'SKIPPED'],
    ]);
    expect(calls).toEqual(['auto-exec:user_A:INTRADAY', 'auto-exec:user_A:SWING']);
    expect(moduleRef.get.mock.calls.map((c) => c[0])).toEqual([AutoExecSettingsService]);
  });

  it('one failing silo does not stop the rest', async () => {
    const { calls, adapter, watch } = setup();
    watch.squareOffAll.mockRejectedValueOnce(new Error('broker timeout'));
    const results = await adapter.squareOffAll(OWNER, 'panic');
    expect(results.find((r) => r.target === 'watch-monitor')).toEqual({ target: 'watch-monitor', status: 'FAILED', detail: 'broker timeout' });
    expect(calls).toEqual(expect.arrayContaining(['adaptive', 'ungated', 'sell-futures', 'trade-engine:core kill switch: panic']));
  });

  it('partial results are FAILED, not OK', async () => {
    const { adapter, watch, adaptive, ungatedPoller, sellFutures } = setup();
    watch.squareOffAll.mockResolvedValueOnce({ watchingClosed: 0, tradedClosed: 2, errors: 1 });
    adaptive.eodSquareOff.mockResolvedValueOnce({ attempted: 3, closed: 2, skipped: 1, errors: 0 });
    ungatedPoller.eodSquareOff.mockImplementationOnce(async () => undefined); // nothing closes
    sellFutures.squareOffOpenPositions.mockResolvedValueOnce({ closed: 0, errors: 2 });
    const byTarget = Object.fromEntries((await adapter.squareOffAll(OWNER, 'panic')).map((r) => [r.target, r]));
    expect(byTarget['watch-monitor']).toMatchObject({ status: 'FAILED', detail: 'closed 2 traded, dismissed 0 watching, 1 errors' });
    expect(byTarget['adaptive-stop-track']).toMatchObject({ status: 'FAILED', detail: 'closed 2 of 3, 1 skipped (no exit price), 0 errors' });
    expect(byTarget['ungated-track']).toMatchObject({ status: 'FAILED', detail: 'closed 0 of 2; 2 still open' });
    expect(byTarget['sell-futures-track']).toMatchObject({ status: 'FAILED', detail: 'closed 0, 2 errors' });
    expect(byTarget['trade-engine'].status).toBe('OK');
  });

  it('a silo that is not loaded in this process is UNAVAILABLE and the rest still run', async () => {
    const { calls, services, adapter } = setup();
    services.delete(SellFuturesService);
    const results = await adapter.squareOffAll(OWNER, 'panic');
    expect(results.find((r) => r.target === 'sell-futures-track')).toEqual({
      target: 'sell-futures-track', status: 'UNAVAILABLE', detail: 'SellFuturesService is not loaded in this process',
    });
    expect(calls).toContain('trade-engine:core kill switch: panic');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @td/api test -- silo-square-off.adapter`
Expected: FAIL with `Cannot find module './silo-square-off.adapter'`.

- [ ] **Step 3: Write the adapter**

Create `apps/api/src/modules/trade-core/risk-wall/services/silo-square-off.adapter.ts`:

```typescript
import { Injectable, Logger, type Type } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { WatchStatus } from '@prisma/client';
import { AdaptiveStopTickPoller } from '../../../adaptive-stop-track/services/adaptive-stop-tick-poller.service';
import { AUTO_EXEC_SEGMENTS, AutoExecSettingsService } from '../../../auto-execution/services/auto-exec-settings.service';
import { SellFuturesService } from '../../../sell-futures-track/services/sell-futures.service';
import { TradeExecutionService } from '../../../trade-engine/services/trade-execution.service';
import { UngatedWatchRepository } from '../../../ungated-track/repositories/ungated-watch.repository';
import { UngatedTickPoller } from '../../../ungated-track/services/ungated-tick-poller.service';
import { WatchService } from '../../../watch-monitor/services/watch.service';
import type { Actor } from '../../strategies/services/core-strategy-catalogue.service';

/**
 * Spec §5.4: turning the core kill switch on "also calls the old silos' square-off
 * paths, so one button stops everything". Approach A: no silo is edited. This adapter
 * only CALLS entry points that already exist (plan decision 9 lists each, and the
 * gaps where none exists). Several are not exported by their modules, so each is
 * resolved with ModuleRef.get(token, { strict: false }); the silo classes are imported
 * as tokens only.
 *
 * The silo tables have no userId and their controllers are @AdminOnly: they are the
 * owner's platform-wide tracks. Only auto-execution is per user. trade-engine's
 * closeAllPositions also flips a process-global in-memory kill switch, so it is
 * owner-only and runs LAST (closing every open Trade first would make the silo
 * square-offs above fail on already-closed paper trades).
 */
export const SILO_TARGETS = [
  'auto-execution',
  'watch-monitor',
  'adaptive-stop-track',
  'ungated-track',
  'sell-futures-track',
  'trade-engine',
] as const;
export type SiloTarget = (typeof SILO_TARGETS)[number];
export type SiloStatus = 'OK' | 'FAILED' | 'SKIPPED' | 'UNAVAILABLE';

export interface SiloSquareOffResult {
  target: SiloTarget;
  status: SiloStatus;
  detail: string;
}

type Resolve = <T>(token: Type<T>) => T;

interface StepOutcome {
  ok: boolean;
  detail: string;
}

interface SiloStep {
  target: SiloTarget;
  ownerOnly: boolean;
  run(resolve: Resolve, actor: Actor, reason: string): Promise<StepOutcome>;
}

class SiloUnavailableError extends Error {}

const STEPS: readonly SiloStep[] = [
  {
    target: 'auto-execution',
    ownerOnly: false,
    async run(resolve, actor) {
      const svc = resolve(AutoExecSettingsService);
      for (const segment of AUTO_EXEC_SEGMENTS) await svc.update(actor.userId, segment, { killSwitch: true });
      return { ok: true, detail: `kill switch set for ${AUTO_EXEC_SEGMENTS.join(' and ')} auto-execution (blocks new auto entries, closes nothing)` };
    },
  },
  {
    target: 'watch-monitor',
    ownerOnly: true,
    async run(resolve) {
      const r = await resolve(WatchService).squareOffAll('manual');
      return { ok: r.errors === 0, detail: `closed ${r.tradedClosed} traded, dismissed ${r.watchingClosed} watching, ${r.errors} errors` };
    },
  },
  {
    target: 'adaptive-stop-track',
    ownerOnly: true,
    async run(resolve) {
      const r = await resolve(AdaptiveStopTickPoller).eodSquareOff();
      return { ok: r.errors === 0 && r.skipped === 0, detail: `closed ${r.closed} of ${r.attempted}, ${r.skipped} skipped (no exit price), ${r.errors} errors` };
    },
  },
  {
    target: 'ungated-track',
    ownerOnly: true,
    async run(resolve) {
      // eodSquareOff returns nothing; count TRADED before and after, as POST /api/ungated/square-off does.
      const repo = resolve(UngatedWatchRepository);
      const traded = async () => (await repo.findAllActive()).filter((e) => e.status === WatchStatus.TRADED).length;
      const before = await traded();
      await resolve(UngatedTickPoller).eodSquareOff();
      const after = await traded();
      return { ok: after === 0, detail: `closed ${before - after} of ${before}; ${after} still open` };
    },
  },
  {
    target: 'sell-futures-track',
    ownerOnly: true,
    async run(resolve) {
      const r = await resolve(SellFuturesService).squareOffOpenPositions();
      return { ok: r.errors === 0, detail: `closed ${r.closed}, ${r.errors} errors` };
    },
  },
  {
    target: 'trade-engine',
    ownerOnly: true,
    async run(resolve, _actor, reason) {
      const r = await resolve(TradeExecutionService).closeAllPositions(`core kill switch: ${reason}`);
      return {
        ok: true,
        detail: `closed ${r.closed} open trades; the trade-engine kill switch is now on in memory for every user until the API restarts, and auto-trade mode is OFF`,
      };
    },
  },
];

@Injectable()
export class SiloSquareOffAdapter {
  private readonly logger = new Logger(SiloSquareOffAdapter.name);

  constructor(private readonly moduleRef: ModuleRef) {}

  /** Never throws: each step reports OK, FAILED, SKIPPED or UNAVAILABLE. */
  async squareOffAll(actor: Actor, reason: string): Promise<SiloSquareOffResult[]> {
    const resolve: Resolve = <T>(token: Type<T>): T => {
      try {
        return this.moduleRef.get<T>(token, { strict: false });
      } catch {
        throw new SiloUnavailableError(`${token.name} is not loaded in this process`);
      }
    };
    const results: SiloSquareOffResult[] = [];
    for (const step of STEPS) {
      if (step.ownerOnly && actor.role !== 'ADMIN') {
        results.push({ target: step.target, status: 'SKIPPED', detail: 'owner only: this silo is platform-wide, not yours alone' });
        continue;
      }
      try {
        const out = await step.run(resolve, actor, reason);
        results.push({ target: step.target, status: out.ok ? 'OK' : 'FAILED', detail: out.detail });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        results.push({ target: step.target, status: err instanceof SiloUnavailableError ? 'UNAVAILABLE' : 'FAILED', detail });
      }
    }
    for (const r of results) {
      if (r.status === 'FAILED' || r.status === 'UNAVAILABLE') this.logger.error(`kill switch cascade ${r.target}: ${r.status}: ${r.detail}`);
    }
    return results;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @td/api test -- silo-square-off.adapter`
Expected: PASS (5 tests).

- [ ] **Step 5: Confirm no silo file changed, then commit**

Run: `git status --short apps/api/src/modules | grep -v "modules/trade-core/" || echo "no silo change"`
Expected: `no silo change`.

```bash
git add apps/api/src/modules/trade-core/risk-wall/services/silo-square-off.adapter.ts apps/api/src/modules/trade-core/risk-wall/services/silo-square-off.adapter.spec.ts
git commit -m "feat(trade-core): one adapter that calls the silos' existing square-off and kill entry points" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/api/src/modules/trade-core/risk-wall/services/silo-square-off.adapter.ts apps/api/src/modules/trade-core/risk-wall/services/silo-square-off.adapter.spec.ts
```

---

### Task 8: `CoreKillSwitchService` — persistent, on now, off next session, cascade

**Files:**
- Create: `apps/api/src/modules/trade-core/risk-wall/services/core-kill-switch.service.ts`
- Test: `apps/api/src/modules/trade-core/risk-wall/services/core-kill-switch.service.spec.ts`

**Interfaces:**
- Consumes: `CoreKillSwitchRepository`, `ConcurrentRiskChangeError` (Task 5); `resolveAppendOnly`,
  `nextSessionOpen`, `ALL_CORE_EXCHANGES` (Task 2); `CORE_SESSION_CLOCK`, `CORE_SQUARE_OFF`,
  `CoreSquareOffPort`, `createCoreSessionClock` (Task 6); `SiloSquareOffAdapter`, `SILO_TARGETS`,
  `SiloSquareOffResult` (Task 7); `AuditService`, `AUDIT_ACTIONS.risk`; `Actor` (M1).
- Produces:

```typescript
export interface KillSwitchView { active: boolean; since: string | null; reason: string | null; setBy: string | null; pendingRelease: { effectiveFrom: string; reason: string; setAt: string } | null }
export interface CascadeStep { status: 'OK' | 'FAILED'; detail: string }
export interface KillSwitchCascade { core: CascadeStep; silos: SiloSquareOffResult[] }
export interface KillSwitchSetResult { state: KillSwitchView; effectiveFrom: string; cascade: KillSwitchCascade | null }
class CoreKillSwitchService {
  get(userId: string, now?: Date): Promise<KillSwitchView>;          // read-only
  isActive(userId: string, now?: Date): Promise<boolean>;
  set(actor: Actor, input: { active: boolean; reason: string }, now?: Date): Promise<KillSwitchSetResult>;
}
```

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/modules/trade-core/risk-wall/services/core-kill-switch.service.spec.ts`:

```typescript
import { ConflictException } from '@nestjs/common';
import type { CoreKillSwitch } from '@prisma/client';
import type { AuditService } from '../../../../common/audit/audit.service';
import type { SessionClock } from '../../../market-hub/session-clock';
import { createCoreSessionClock, type CoreSquareOffPort } from '../ports';
import type { CoreKillSwitchRepository, NewKillSwitchRow } from '../repositories/core-kill-switch.repository';
import { ConcurrentRiskChangeError } from '../repositories/core-risk-limit.repository';
import { NOW } from '../testing/risk-fixtures';
import { CoreKillSwitchService } from './core-kill-switch.service';
import type { SiloSquareOffAdapter } from './silo-square-off.adapter';

const NEXT_OPEN = new Date('2026-10-13T03:45:00.000Z');
const OWNER = { userId: 'usr_owner', role: 'ADMIN' };
const A = { userId: 'user_A', role: 'USER' };
const B = { userId: 'user_B', role: 'USER' };

/** In-memory stand-in for CoreKillSwitchRepository with the same contract. */
class FakeKillRepo {
  rows: CoreKillSwitch[] = [];
  expectations: Array<string | null | undefined> = [];
  private seq = 0;

  async listForUser(userId: string) {
    return this.rows.filter((r) => r.userId === userId);
  }

  async append(userId: string, row: NewKillSwitchRow, now: Date, expectNewestId?: string | null) {
    this.expectations.push(expectNewestId);
    const newest = (await this.listForUser(userId)).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    if (expectNewestId !== undefined && (newest?.id ?? null) !== expectNewestId) throw new ConcurrentRiskChangeError('the kill switch');
    this.seq += 1;
    const r = { id: `ks_${this.seq}`, userId, ...row, createdAt: new Date(now.getTime() + this.seq) } as CoreKillSwitch;
    this.rows.push(r);
    return r;
  }
}

function setup(opts: { repo?: FakeKillRepo; clock?: Pick<SessionClock, 'nextOpen'> } = {}) {
  const repo = opts.repo ?? new FakeKillRepo();
  const audit = { append: jest.fn().mockResolvedValue({ seq: 1n, hash: 'h' }) };
  const core = { squareOffAll: jest.fn().mockResolvedValue({ cancelledOrders: 0, exitsRequested: 0, detail: 'no core orders or positions exist yet (M3/M4 add them)' }) };
  const silos = { squareOffAll: jest.fn().mockResolvedValue([{ target: 'auto-execution', status: 'OK', detail: 'set' }]) };
  const service = new CoreKillSwitchService(
    repo as unknown as CoreKillSwitchRepository,
    audit as unknown as AuditService,
    (opts.clock ?? createCoreSessionClock()) as SessionClock,
    core as CoreSquareOffPort,
    silos as unknown as SiloSquareOffAdapter,
  );
  return { repo, audit, core, silos, service };
}

describe('CoreKillSwitchService', () => {
  it('GET is read-only and starts off', async () => {
    const { repo, audit, core, silos, service } = setup();
    expect(await service.get('user_A', NOW)).toEqual({ active: false, since: null, reason: null, setBy: null, pendingRelease: null });
    expect(repo.expectations).toEqual([]);
    expect(audit.append).not.toHaveBeenCalled();
    expect(core.squareOffAll).not.toHaveBeenCalled();
    expect(silos.squareOffAll).not.toHaveBeenCalled();
  });

  it('turning on takes effect now, keeps the reason, runs the cascade and audits both', async () => {
    const { audit, core, silos, service } = setup();
    const r = await service.set(A, { active: true, reason: '  market crash  ' }, NOW);
    expect(r.effectiveFrom).toBe(NOW.toISOString());
    expect(r.state).toEqual({ active: true, since: NOW.toISOString(), reason: 'market crash', setBy: 'user_A', pendingRelease: null });
    expect(r.cascade).toEqual({
      core: { status: 'OK', detail: 'no core orders or positions exist yet (M3/M4 add them) (cancelled 0 orders, requested 0 exits)' },
      silos: [{ target: 'auto-execution', status: 'OK', detail: 'set' }],
    });
    expect(core.squareOffAll).toHaveBeenCalledWith('user_A', 'KILL_SWITCH', 'market crash');
    expect(silos.squareOffAll).toHaveBeenCalledWith(A, 'market crash');
    expect(audit.append.mock.calls.map((c) => c[0].action)).toEqual(['CORE_KILL_SWITCH_SET', 'CORE_KILL_SWITCH_CASCADE']);
    expect(audit.append.mock.calls[0][0]).toEqual({
      action: 'CORE_KILL_SWITCH_SET', userId: 'user_A', target: 'core_kill_switch:ks_1',
      meta: { active: true, wasActive: false, effectiveFrom: NOW.toISOString(), reason: 'market crash' },
    });
    expect(audit.append.mock.calls[1][0].meta).toEqual(r.cascade);
    expect(await service.isActive('user_A', NOW)).toBe(true);
  });

  it('turning on skips the concurrency check, so a press is never refused', async () => {
    const { repo, service } = setup();
    repo.rows.push({ id: 'ks_other', userId: 'user_A', active: false, effectiveFrom: NOW, setBy: 'user_A', reason: 'x', createdAt: NOW } as CoreKillSwitch);
    await service.set(A, { active: true, reason: 'stop now' }, NOW);
    expect(repo.expectations).toEqual([undefined]);
  });

  it('a core failure is reported and the silos still run; a throwing adapter marks every silo FAILED', async () => {
    const { core, silos, service } = setup();
    core.squareOffAll.mockRejectedValueOnce(new Error('core down'));
    const r = await service.set(OWNER, { active: true, reason: 'stop' }, NOW);
    expect(r.cascade?.core).toEqual({ status: 'FAILED', detail: 'core down' });
    expect(silos.squareOffAll).toHaveBeenCalledTimes(1);
    silos.squareOffAll.mockRejectedValueOnce(new Error('adapter broke'));
    const again = await service.set(OWNER, { active: true, reason: 'stop again' }, NOW);
    expect(again.cascade?.silos).toHaveLength(6);
    expect(again.cascade?.silos.every((s) => s.status === 'FAILED' && s.detail === 'adapter broke')).toBe(true);
  });

  it('pressing on again runs the cascade again', async () => {
    const { core, silos, service } = setup();
    await service.set(OWNER, { active: true, reason: 'one' }, NOW);
    await service.set(OWNER, { active: true, reason: 'two' }, NOW);
    expect(core.squareOffAll).toHaveBeenCalledTimes(2);
    expect(silos.squareOffAll).toHaveBeenCalledTimes(2);
  });

  it('turning off while on waits for the next session open; the switch stays on until then', async () => {
    const { repo, audit, core, service } = setup();
    await service.set(A, { active: true, reason: 'stop' }, NOW);
    const off = await service.set(A, { active: false, reason: 'calm again' }, NOW);
    expect(off.effectiveFrom).toBe(NEXT_OPEN.toISOString());
    expect(off.cascade).toBeNull();
    expect(off.state).toMatchObject({ active: true, reason: 'stop', pendingRelease: { effectiveFrom: NEXT_OPEN.toISOString(), reason: 'calm again' } });
    expect(repo.expectations).toEqual([undefined, 'ks_1']);
    expect(core.squareOffAll).toHaveBeenCalledTimes(1);
    expect(audit.append.mock.calls[audit.append.mock.calls.length - 1][0].meta).toEqual({
      active: false, wasActive: true, effectiveFrom: NEXT_OPEN.toISOString(), reason: 'calm again',
    });
    expect(await service.isActive('user_A', new Date(NEXT_OPEN.getTime() - 1))).toBe(true);
    expect(await service.get('user_A', NEXT_OPEN)).toMatchObject({ active: false, pendingRelease: null, reason: 'calm again' });
  });

  it('turning off while off takes effect now', async () => {
    const { service } = setup();
    const r = await service.set(A, { active: false, reason: 'just checking' }, NOW);
    expect(r).toMatchObject({ effectiveFrom: NOW.toISOString(), cascade: null, state: { active: false, pendingRelease: null } });
  });

  it('turning on after a scheduled release cancels the release', async () => {
    const { service } = setup();
    await service.set(A, { active: true, reason: 'stop' }, NOW);
    await service.set(A, { active: false, reason: 'calm' }, NOW);
    const on = await service.set(A, { active: true, reason: 'not calm' }, NOW);
    expect(on.state.pendingRelease).toBeNull();
    expect(await service.isActive('user_A', NEXT_OPEN)).toBe(true);
  });

  it('survives a restart: a new service over the same store still reads on', async () => {
    const first = setup();
    await first.service.set(A, { active: true, reason: 'stop' }, NOW);
    const second = setup({ repo: first.repo });
    expect(await second.service.isActive('user_A', NOW)).toBe(true);
  });

  it('no known session open: the release is refused (409) and the switch stays on', async () => {
    const { repo, service } = setup({ clock: { nextOpen: () => null } });
    await service.set(A, { active: true, reason: 'stop' }, NOW);
    await expect(service.set(A, { active: false, reason: 'calm' }, NOW)).rejects.toBeInstanceOf(ConflictException);
    expect(repo.rows).toHaveLength(1);
    expect(await service.isActive('user_A', NOW)).toBe(true);
  });

  it('a concurrent release is 409', async () => {
    const { repo, service } = setup();
    await service.set(A, { active: true, reason: 'stop' }, NOW);
    jest.spyOn(repo, 'append').mockRejectedValueOnce(new ConcurrentRiskChangeError('the kill switch'));
    await expect(service.set(A, { active: false, reason: 'calm' }, NOW)).rejects.toBeInstanceOf(ConflictException);
  });

  it('user B is never affected by user A’s switch', async () => {
    const { service } = setup();
    await service.set(A, { active: true, reason: 'stop' }, NOW);
    expect(await service.isActive('user_B', NOW)).toBe(false);
    expect((await service.set(B, { active: false, reason: 'mine' }, NOW)).effectiveFrom).toBe(NOW.toISOString());
    expect(await service.isActive('user_A', NOW)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @td/api test -- core-kill-switch.service`
Expected: FAIL with `Cannot find module './core-kill-switch.service'`.

- [ ] **Step 3: Write the service**

Create `apps/api/src/modules/trade-core/risk-wall/services/core-kill-switch.service.ts`:

```typescript
import { ConflictException, Inject, Injectable } from '@nestjs/common';
import type { CoreKillSwitch } from '@prisma/client';
import { AuditService } from '../../../../common/audit/audit.service';
import { AUDIT_ACTIONS } from '../../../../common/audit/audit-actions';
import type { SessionClock } from '../../../market-hub/session-clock';
import type { Actor } from '../../strategies/services/core-strategy-catalogue.service';
import { resolveAppendOnly } from '../limits/append-only';
import { CORE_SESSION_CLOCK, CORE_SQUARE_OFF, type CoreSquareOffPort } from '../ports';
import { CoreKillSwitchRepository } from '../repositories/core-kill-switch.repository';
import { ConcurrentRiskChangeError } from '../repositories/core-risk-limit.repository';
import { ALL_CORE_EXCHANGES, nextSessionOpen } from '../session-open';
import { SILO_TARGETS, SiloSquareOffAdapter, type SiloSquareOffResult } from './silo-square-off.adapter';

export interface KillSwitchView {
  active: boolean;
  since: string | null;
  reason: string | null;
  setBy: string | null;
  /** A release waiting for the next session open (D5). */
  pendingRelease: { effectiveFrom: string; reason: string; setAt: string } | null;
}

export interface CascadeStep {
  status: 'OK' | 'FAILED';
  detail: string;
}

export interface KillSwitchCascade {
  core: CascadeStep;
  silos: SiloSquareOffResult[];
}

export interface KillSwitchSetResult {
  state: KillSwitchView;
  effectiveFrom: string;
  cascade: KillSwitchCascade | null;
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function viewOf(rows: readonly CoreKillSwitch[], now: Date): KillSwitchView {
  const { inForce, pending } = resolveAppendOnly(rows, now);
  return {
    active: inForce?.active ?? false,
    since: inForce ? inForce.effectiveFrom.toISOString() : null,
    reason: inForce?.reason ?? null,
    setBy: inForce?.setBy ?? null,
    pendingRelease:
      pending && !pending.active
        ? { effectiveFrom: pending.effectiveFrom.toISOString(), reason: pending.reason, setAt: pending.createdAt.toISOString() }
        : null,
  };
}

/**
 * The persistent per-user kill switch (spec §5.4). On: immediate, never refused, then
 * the cascade (core square-off port + every silo entry point). Off: a loosening, so it
 * takes effect at the next session open. GET never writes. Audited both ways.
 */
@Injectable()
export class CoreKillSwitchService {
  constructor(
    private readonly repo: CoreKillSwitchRepository,
    private readonly audit: AuditService,
    @Inject(CORE_SESSION_CLOCK) private readonly clock: SessionClock,
    @Inject(CORE_SQUARE_OFF) private readonly coreSquareOff: CoreSquareOffPort,
    private readonly silos: SiloSquareOffAdapter,
  ) {}

  async get(userId: string, now: Date = new Date()): Promise<KillSwitchView> {
    return viewOf(await this.repo.listForUser(userId), now);
  }

  async isActive(userId: string, now: Date = new Date()): Promise<boolean> {
    return (await this.get(userId, now)).active;
  }

  async set(actor: Actor, input: { active: boolean; reason: string }, now: Date = new Date()): Promise<KillSwitchSetResult> {
    const reason = input.reason.trim();
    const rows = await this.repo.listForUser(actor.userId);
    const { inForce, newest } = resolveAppendOnly(rows, now);
    const wasActive = inForce?.active ?? false;

    let effectiveFrom = now;
    if (!input.active && wasActive) {
      const open = nextSessionOpen(this.clock, ALL_CORE_EXCHANGES, now);
      if (!open) throw new ConflictException('no session open is known in the next 14 days, so the release cannot be scheduled; the kill switch stays on');
      effectiveFrom = open;
    }

    let row: CoreKillSwitch;
    try {
      row = await this.repo.append(
        actor.userId,
        { active: input.active, effectiveFrom, setBy: actor.userId, reason },
        now,
        input.active ? undefined : (newest?.id ?? null),
      );
    } catch (err) {
      if (err instanceof ConcurrentRiskChangeError) throw new ConflictException('the kill switch changed at the same time; reload and retry');
      throw err;
    }

    // Persist → cascade → audit: a failing audit can never stop the square-off (plan decision 17).
    const cascade = input.active ? await this.cascade(actor, reason) : null;
    const target = `core_kill_switch:${row.id}`;
    await this.audit.append({
      action: AUDIT_ACTIONS.risk.CORE_KILL_SWITCH_SET,
      userId: actor.userId,
      target,
      meta: { active: input.active, wasActive, effectiveFrom: effectiveFrom.toISOString(), reason },
    });
    if (cascade) {
      await this.audit.append({
        action: AUDIT_ACTIONS.risk.CORE_KILL_SWITCH_CASCADE,
        userId: actor.userId,
        target,
        meta: { core: cascade.core, silos: cascade.silos },
      });
    }
    return { state: viewOf([...rows, row], now), effectiveFrom: effectiveFrom.toISOString(), cascade };
  }

  private async cascade(actor: Actor, reason: string): Promise<KillSwitchCascade> {
    let core: CascadeStep;
    try {
      const r = await this.coreSquareOff.squareOffAll(actor.userId, 'KILL_SWITCH', reason);
      core = { status: 'OK', detail: `${r.detail} (cancelled ${r.cancelledOrders} orders, requested ${r.exitsRequested} exits)` };
    } catch (err) {
      core = { status: 'FAILED', detail: errorText(err) };
    }
    let silos: SiloSquareOffResult[];
    try {
      silos = await this.silos.squareOffAll(actor, reason);
    } catch (err) {
      silos = SILO_TARGETS.map((target) => ({ target, status: 'FAILED' as const, detail: errorText(err) }));
    }
    return { core, silos };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @td/api test -- core-kill-switch.service`
Expected: PASS (12 tests). The service imports the adapter, which imports the silo services as tokens; if
loading one of them fails in Jest, add the same `jest.mock(...)` token stubs as Task 7's spec at the top
of this spec (never change the silo).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/trade-core/risk-wall/services/core-kill-switch.service.ts apps/api/src/modules/trade-core/risk-wall/services/core-kill-switch.service.spec.ts
git commit -m "feat(trade-core): persistent per-user kill switch: on now with silo cascade, off at next session open" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/api/src/modules/trade-core/risk-wall/services/core-kill-switch.service.ts apps/api/src/modules/trade-core/risk-wall/services/core-kill-switch.service.spec.ts
```

---

### Task 9: `RiskWallService` — gathers the context, fails closed, records every verdict

**Files:**
- Create: `apps/api/src/modules/trade-core/risk-wall/services/risk-wall.service.ts`
- Test: `apps/api/src/modules/trade-core/risk-wall/services/risk-wall.service.spec.ts`

**Interfaces:**
- Consumes: `checkRisk`, `exitVerdict`, `rejectVerdict` (Task 3); `CoreRiskLimitService.inForce` (Task 6);
  `CoreKillSwitchService.isActive` (Task 8); `RISK_STATE_PROVIDER`, `RISK_VERDICT_SINK`,
  `CORE_SESSION_CLOCK`, `RiskStateProvider`, `RiskVerdictSink`, `UnavailableRiskStateProvider` (Task 6).
- Produces: `class RiskWallService { check(intent: CoreIntent, now?: Date): Promise<RiskVerdict> }` — the
  one entry M5's fan-out calls before `ExecutionAdapter.placeOrder` (spec §3 flow).

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/modules/trade-core/risk-wall/services/risk-wall.service.spec.ts`:

```typescript
import type { SessionClock } from '../../../market-hub/session-clock';
import { UnavailableRiskStateProvider, type RiskStateProvider, type RiskVerdictSink } from '../ports';
import type { RiskVerdict } from '../risk-wall.types';
import { intentFixture, limitsFixture, NOW, optionIntent, stateFixture } from '../testing/risk-fixtures';
import type { CoreKillSwitchService } from './core-kill-switch.service';
import type { CoreRiskLimitService } from './core-risk-limit.service';
import { RiskWallService } from './risk-wall.service';

const codes = (v: RiskVerdict) => v.reasons.map((r) => r.code);

function setup(state: RiskStateProvider = { liveState: jest.fn().mockResolvedValue(stateFixture()) }) {
  const limits = { inForce: jest.fn().mockResolvedValue(limitsFixture()) };
  const kill = { isActive: jest.fn().mockResolvedValue(false) };
  const sink = { record: jest.fn().mockResolvedValue(undefined) };
  const clock = { isOpen: jest.fn().mockReturnValue(true) };
  const service = new RiskWallService(
    limits as unknown as CoreRiskLimitService,
    kill as unknown as CoreKillSwitchService,
    state,
    sink as RiskVerdictSink,
    clock as unknown as SessionClock,
  );
  return { limits, kill, sink, clock, state, service };
}

describe('RiskWallService', () => {
  it('reads only the intent user’s limits, kill switch and live state, and records the verdict', async () => {
    const { limits, kill, state, clock, sink, service } = setup();
    const v = await service.check(intentFixture(), NOW);
    expect(v).toMatchObject({ verdict: 'ALLOW', qty: 50 });
    expect(limits.inForce).toHaveBeenCalledWith('user_A', NOW);
    expect(kill.isActive).toHaveBeenCalledWith('user_A', NOW);
    expect(state.liveState).toHaveBeenCalledWith('user_A', NOW);
    expect(clock.isOpen).toHaveBeenCalledWith('NSE', NOW);
    expect(sink.record).toHaveBeenCalledWith(v);
  });

  it('asks the clock about the intent’s own exchange', async () => {
    const { clock, service } = setup();
    clock.isOpen.mockReturnValue(false);
    const v = await service.check(optionIntent(), NOW);
    expect(clock.isOpen).toHaveBeenCalledWith('NFO', NOW);
    expect(codes(v)).toEqual(['SESSION_CLOSED']);
  });

  it('the kill switch rejects', async () => {
    const { kill, service } = setup();
    kill.isActive.mockResolvedValue(true);
    expect(codes(await service.check(intentFixture(), NOW))).toEqual(['KILL_SWITCH']);
  });

  it('the M2 default state provider rejects every entry, keeping the limits it had loaded', async () => {
    const { sink, service } = setup(new UnavailableRiskStateProvider());
    const v = await service.check(intentFixture(), NOW);
    expect(v).toMatchObject({ verdict: 'REJECT', qty: 0, killSwitchActive: false });
    expect(codes(v)).toEqual(['CONTEXT_UNAVAILABLE']);
    expect(v.reasons[0].message).toContain('M3/M4');
    expect(v.limits).toHaveLength(21);
    expect(sink.record).toHaveBeenCalledWith(v);
  });

  it('a failing limit load rejects and never throws', async () => {
    const { limits, service } = setup();
    limits.inForce.mockRejectedValue(new Error('db down'));
    const v = await service.check(intentFixture(), NOW);
    expect(codes(v)).toEqual(['CONTEXT_UNAVAILABLE']);
    expect(v.reasons[0].message).toContain('db down');
  });

  it('a recording failure turns ALLOW into REJECT and keeps the snapshot', async () => {
    const { sink, service } = setup();
    sink.record.mockRejectedValue(new Error('journal down'));
    const v = await service.check(intentFixture(), NOW);
    expect(v).toMatchObject({ verdict: 'REJECT', qty: 0, requestedQty: 50 });
    expect(codes(v)).toEqual(['JOURNAL_UNAVAILABLE']);
    expect(v.limits).toHaveLength(21);
    expect(v.state).not.toBeNull();
  });

  it('a REJECT stays the same REJECT when recording fails', async () => {
    const { kill, sink, service } = setup();
    kill.isActive.mockResolvedValue(true);
    sink.record.mockRejectedValue(new Error('journal down'));
    expect(codes(await service.check(intentFixture(), NOW))).toEqual(['KILL_SWITCH']);
  });

  it('exits pass without loading context, even when recording fails', async () => {
    const { limits, kill, state, sink, service } = setup();
    sink.record.mockRejectedValue(new Error('journal down'));
    const v = await service.check({ kind: 'EXIT', intentId: 'x1', userId: 'user_A', positionId: 'p1', qty: 10 }, NOW);
    expect(v).toMatchObject({ verdict: 'ALLOW', qty: 10 });
    expect(codes(v)).toEqual(['EXIT_NOT_CHECKED']);
    expect(limits.inForce).not.toHaveBeenCalled();
    expect(kill.isActive).not.toHaveBeenCalled();
    expect(state.liveState).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @td/api test -- risk-wall.service`
Expected: FAIL with `Cannot find module './risk-wall.service'`.

- [ ] **Step 3: Write the service**

Create `apps/api/src/modules/trade-core/risk-wall/services/risk-wall.service.ts`:

```typescript
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { SessionClock } from '../../../market-hub/session-clock';
import { CORE_SESSION_CLOCK, RISK_STATE_PROVIDER, RISK_VERDICT_SINK, type RiskStateProvider, type RiskVerdictSink } from '../ports';
import { checkRisk, exitVerdict, rejectVerdict } from '../risk-wall';
import type { CoreIntent, LimitInForce, RiskVerdict } from '../risk-wall.types';
import { CoreKillSwitchService } from './core-kill-switch.service';
import { CoreRiskLimitService } from './core-risk-limit.service';

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * RiskWall.check with its inputs (spec §5.1): the intent user's limits in force, kill
 * switch and live state, plus the session for the intent's exchange. Fails closed at
 * every step and records every verdict (plan decisions 2 and 4). Exits are never
 * checked and never blocked, not even by a recording failure.
 */
@Injectable()
export class RiskWallService {
  private readonly logger = new Logger(RiskWallService.name);

  constructor(
    private readonly limits: CoreRiskLimitService,
    private readonly killSwitch: CoreKillSwitchService,
    @Inject(RISK_STATE_PROVIDER) private readonly stateProvider: RiskStateProvider,
    @Inject(RISK_VERDICT_SINK) private readonly sink: RiskVerdictSink,
    @Inject(CORE_SESSION_CLOCK) private readonly clock: SessionClock,
  ) {}

  async check(intent: CoreIntent, now: Date = new Date()): Promise<RiskVerdict> {
    if (intent.kind === 'EXIT') {
      const v = exitVerdict(intent, now);
      try {
        await this.sink.record(v);
      } catch (err) {
        this.logger.error(`could not record exit verdict ${intent.intentId}: ${errorText(err)}`);
      }
      return v;
    }

    let verdict: RiskVerdict;
    let limits: LimitInForce[] = [];
    let killSwitchActive: boolean | null = null;
    try {
      limits = await this.limits.inForce(intent.userId, now);
      killSwitchActive = await this.killSwitch.isActive(intent.userId, now);
      const state = await this.stateProvider.liveState(intent.userId, now);
      verdict = checkRisk(intent, { now, limits, killSwitchActive, sessionOpen: this.clock.isOpen(intent.exchange, now), state });
    } catch (err) {
      verdict = rejectVerdict(intent, now, 'CONTEXT_UNAVAILABLE', `risk context unavailable: ${errorText(err)}`, { limits, killSwitchActive });
    }

    try {
      await this.sink.record(verdict);
    } catch (err) {
      this.logger.error(`could not record risk verdict ${intent.intentId}: ${errorText(err)}`);
      if (verdict.verdict !== 'REJECT') {
        verdict = rejectVerdict(intent, now, 'JOURNAL_UNAVAILABLE', `the verdict could not be recorded: ${errorText(err)}`, verdict);
      }
    }
    return verdict;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @td/api test -- risk-wall.service`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/trade-core/risk-wall/services/risk-wall.service.ts apps/api/src/modules/trade-core/risk-wall/services/risk-wall.service.spec.ts
git commit -m "feat(trade-core): RiskWallService: assembles context, fails closed, records every verdict" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/api/src/modules/trade-core/risk-wall/services/risk-wall.service.ts apps/api/src/modules/trade-core/risk-wall/services/risk-wall.service.spec.ts
```

---

### Task 10: REST under `/api/trade-core/risk/*`, DTOs and module wiring

**Files:**
- Create: `apps/api/src/modules/trade-core/risk-wall/dto/core-risk.dto.ts`
- Create: `apps/api/src/modules/trade-core/risk-wall/controllers/core-risk.controller.ts`
- Modify: `apps/api/src/modules/trade-core/trade-core.module.ts`
- Modify: `apps/api/src/modules/trade-core/trade-core.module.spec.ts`
- Modify: `apps/api/src/app.module.ts:250-252` (comment only)
- Test: `apps/api/src/modules/trade-core/risk-wall/controllers/core-risk.controller.spec.ts`

**Interfaces:**
- Consumes: `CoreRiskLimitService.list/change` (Task 6), `CoreKillSwitchService.get/set` (Task 8), every
  provider and token of Tasks 5–9; `CurrentUser`, `AuthenticatedUser`, `ROLES_KEY` (`common/decorators`).
- Produces the routes (all authenticated by the global JwtAuthGuard, none `@AdminOnly`, the user always
  from the token):

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/trade-core/risk/limits` | — | `{ limits: CoreRiskLimitView[] }` (seeds once, decision 7) |
| PUT | `/api/trade-core/risk/limits/:key/:scope` | `{ value: number \| string, reason: string }` | `LimitChangeResult` |
| GET | `/api/trade-core/risk/kill-switch` | — | `KillSwitchView` (never writes) |
| POST | `/api/trade-core/risk/kill-switch` | `{ active: boolean, reason: string }` | `KillSwitchSetResult` (200) |

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/modules/trade-core/risk-wall/controllers/core-risk.controller.spec.ts`:

```typescript
import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ROLES_KEY, type AuthenticatedUser } from '../../../../common/decorators';
import { ChangeLimitDto, SetKillSwitchDto } from '../dto/core-risk.dto';
import type { CoreKillSwitchService } from '../services/core-kill-switch.service';
import type { CoreRiskLimitService } from '../services/core-risk-limit.service';
import { CoreRiskController } from './core-risk.controller';

const USER_A: AuthenticatedUser = { userId: 'user_A', role: 'USER', email: 'a@x' };

function setup() {
  const limits = { list: jest.fn().mockResolvedValue([]), change: jest.fn().mockResolvedValue({ direction: 'TIGHTER' }) };
  const killSwitch = { get: jest.fn().mockResolvedValue({ active: false }), set: jest.fn().mockResolvedValue({ cascade: null }) };
  const controller = new CoreRiskController(limits as unknown as CoreRiskLimitService, killSwitch as unknown as CoreKillSwitchService);
  return { limits, killSwitch, controller };
}

const route = (m: keyof CoreRiskController) => ({
  path: Reflect.getMetadata(PATH_METADATA, CoreRiskController.prototype[m]) as string,
  method: Reflect.getMetadata(METHOD_METADATA, CoreRiskController.prototype[m]) as RequestMethod,
  roles: Reflect.getMetadata(ROLES_KEY, CoreRiskController.prototype[m]) as string[] | undefined,
});

describe('CoreRiskController', () => {
  it('serves /api/trade-core/risk; GET kill-switch reads and POST writes; no route is @AdminOnly', () => {
    expect(Reflect.getMetadata(PATH_METADATA, CoreRiskController)).toBe('api/trade-core/risk');
    expect(Reflect.getMetadata(ROLES_KEY, CoreRiskController)).toBeUndefined();
    expect(route('listLimits')).toEqual({ path: 'limits', method: RequestMethod.GET, roles: undefined });
    expect(route('changeLimit')).toEqual({ path: 'limits/:key/:scope', method: RequestMethod.PUT, roles: undefined });
    expect(route('getKillSwitch')).toEqual({ path: 'kill-switch', method: RequestMethod.GET, roles: undefined });
    expect(route('setKillSwitch')).toEqual({ path: 'kill-switch', method: RequestMethod.POST, roles: undefined });
  });

  it('routes take the user from the token, never from the path or body', async () => {
    const { limits, killSwitch, controller } = setup();
    await controller.listLimits('user_A');
    expect(limits.list).toHaveBeenCalledWith('user_A');
    await controller.changeLimit('user_A', 'maxDailyLoss', 'ALL', { value: 4000, reason: 'tighter', userId: 'user_B' } as unknown as ChangeLimitDto);
    expect(limits.change).toHaveBeenCalledWith('user_A', { key: 'maxDailyLoss', scope: 'ALL', value: 4000, reason: 'tighter' });
    await controller.setKillSwitch(USER_A, { active: true, reason: 'stop' });
    expect(killSwitch.set).toHaveBeenCalledWith({ userId: 'user_A', role: 'USER' }, { active: true, reason: 'stop' });
  });

  it('GET kill-switch only reads', async () => {
    const { killSwitch, controller } = setup();
    expect(await controller.getKillSwitch('user_A')).toEqual({ active: false });
    expect(killSwitch.get).toHaveBeenCalledWith('user_A');
    expect(killSwitch.set).not.toHaveBeenCalled();
  });
});

describe('request DTOs', () => {
  it('ChangeLimitDto takes a number or a short string, and a 3–500 character reason; it strips userId', async () => {
    const dto = plainToInstance(ChangeLimitDto, { value: 4000, reason: 'tighter', userId: 'user_B' });
    expect(await validate(dto, { whitelist: true })).toEqual([]);
    expect((dto as unknown as Record<string, unknown>).userId).toBeUndefined();
    for (const value of [4000, 0, 2.5, '15:00', 'BLOCK_ENTRIES']) {
      expect(await validate(plainToInstance(ChangeLimitDto, { value, reason: 'why not' }))).toEqual([]);
    }
    for (const value of [undefined, null, NaN, Infinity, true, {}, [], 'x'.repeat(33)]) {
      expect((await validate(plainToInstance(ChangeLimitDto, { value, reason: 'why not' }))).map((e) => e.property)).toEqual(['value']);
    }
    for (const reason of [undefined, '', '   ', 'ab', '  ab  ', 'x'.repeat(501), 42]) {
      expect((await validate(plainToInstance(ChangeLimitDto, { value: 1, reason }))).map((e) => e.property)).toEqual(['reason']);
    }
  });

  it('SetKillSwitchDto needs a real boolean and a reason', async () => {
    expect(await validate(plainToInstance(SetKillSwitchDto, { active: true, reason: 'stop now' }))).toEqual([]);
    expect((await validate(plainToInstance(SetKillSwitchDto, { active: 'true', reason: 'stop now' }))).map((e) => e.property)).toEqual(['active']);
    expect((await validate(plainToInstance(SetKillSwitchDto, { active: false }))).map((e) => e.property)).toEqual(['reason']);
  });
});
```

Replace the contents of `apps/api/src/modules/trade-core/trade-core.module.spec.ts` with:

```typescript
import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { SessionClock } from '../market-hub/session-clock';
import { TradeCoreModule } from './trade-core.module';
import { CoreStrategiesController } from './strategies/controllers/core-strategies.controller';
import { CoreStrategyCatalogueService } from './strategies/services/core-strategy-catalogue.service';
import { CoreStrategySelectionService } from './strategies/services/core-strategy-selection.service';
import { CoreRiskController } from './risk-wall/controllers/core-risk.controller';
import {
  CORE_SESSION_CLOCK,
  CORE_SQUARE_OFF,
  LoggingRiskVerdictSink,
  NoCorePositionsSquareOff,
  RISK_STATE_PROVIDER,
  RISK_VERDICT_SINK,
  UnavailableRiskStateProvider,
} from './risk-wall/ports';
import { CoreKillSwitchService } from './risk-wall/services/core-kill-switch.service';
import { CoreRiskLimitService } from './risk-wall/services/core-risk-limit.service';
import { RiskWallService } from './risk-wall/services/risk-wall.service';
import { SiloSquareOffAdapter } from './risk-wall/services/silo-square-off.adapter';

/** Stands in for the real @Global AuditModule, which AppModule provides. */
@Global()
@Module({ providers: [{ provide: AuditService, useValue: { append: jest.fn() } }], exports: [AuditService] })
class FakeAuditModule {}

async function compile() {
  return Test.createTestingModule({ imports: [FakeAuditModule, TradeCoreModule] })
    .overrideProvider(PrismaService)
    .useValue({})
    .compile();
}

describe('TradeCoreModule', () => {
  it('resolves the controller and both services', async () => {
    const mod = await compile();
    expect(mod.get(CoreStrategiesController)).toBeInstanceOf(CoreStrategiesController);
    expect(mod.get(CoreStrategyCatalogueService)).toBeInstanceOf(CoreStrategyCatalogueService);
    expect(mod.get(CoreStrategySelectionService)).toBeInstanceOf(CoreStrategySelectionService);
  });

  it('resolves the M2 risk parts with their fail-closed default ports', async () => {
    const mod = await compile();
    expect(mod.get(CoreRiskController)).toBeInstanceOf(CoreRiskController);
    expect(mod.get(RiskWallService)).toBeInstanceOf(RiskWallService);
    expect(mod.get(CoreRiskLimitService)).toBeInstanceOf(CoreRiskLimitService);
    expect(mod.get(CoreKillSwitchService)).toBeInstanceOf(CoreKillSwitchService);
    expect(mod.get(SiloSquareOffAdapter)).toBeInstanceOf(SiloSquareOffAdapter);
    expect(mod.get(CORE_SESSION_CLOCK)).toBeInstanceOf(SessionClock);
    expect(mod.get(RISK_STATE_PROVIDER)).toBeInstanceOf(UnavailableRiskStateProvider);
    expect(mod.get(RISK_VERDICT_SINK)).toBeInstanceOf(LoggingRiskVerdictSink);
    expect(mod.get(CORE_SQUARE_OFF)).toBeInstanceOf(NoCorePositionsSquareOff);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @td/api test -- core-risk.controller trade-core.module`
Expected: FAIL with `Cannot find module '../dto/core-risk.dto'` (controller spec) and
`Cannot find module './risk-wall/controllers/core-risk.controller'` (module spec).

- [ ] **Step 3: Write the DTOs and the controller**

Create `apps/api/src/modules/trade-core/risk-wall/dto/core-risk.dto.ts`:

```typescript
import { IsBoolean, ValidateBy } from 'class-validator';

/**
 * Request bodies. Neither carries userId: the global ValidationPipe({ whitelist: true })
 * strips anything else, and the controller takes the user from the token. The value's
 * meaning depends on the limit, so the service parses it per key (parseLimitValue).
 * The bounds below are shapes, not risk values.
 */
export function isReason(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length >= 3 && v.length <= 500;
}

function IsReason(): PropertyDecorator {
  return ValidateBy({
    name: 'isReason',
    validator: { validate: (v: unknown) => isReason(v), defaultMessage: () => '$property must say why, in 3 to 500 characters' },
  });
}

function IsLimitValueShape(): PropertyDecorator {
  return ValidateBy({
    name: 'isLimitValueShape',
    validator: {
      validate: (v: unknown) => (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.length <= 32),
      defaultMessage: () => '$property must be a number or a short string (the limit decides which)',
    },
  });
}

export class ChangeLimitDto {
  @IsLimitValueShape()
  value!: number | string;

  @IsReason()
  reason!: string;
}

export class SetKillSwitchDto {
  @IsBoolean()
  active!: boolean;

  @IsReason()
  reason!: string;
}
```

Create `apps/api/src/modules/trade-core/risk-wall/controllers/core-risk.controller.ts`:

```typescript
import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../../../common/decorators';
import { ChangeLimitDto, SetKillSwitchDto } from '../dto/core-risk.dto';
import { CoreKillSwitchService, type KillSwitchSetResult, type KillSwitchView } from '../services/core-kill-switch.service';
import { CoreRiskLimitService, type CoreRiskLimitView, type LimitChangeResult } from '../services/core-risk-limit.service';

/**
 * The caller's own Risk Wall limits and kill switch (spec §5.2, §5.4, §8.4). Every
 * route is authenticated by the global JwtAuthGuard; none is @AdminOnly because
 * these are the user's own controls (plan decision 10). The user always comes from
 * the token. GET kill-switch never writes; only POST changes it.
 */
@ApiTags('Trade core: risk')
@Controller('api/trade-core/risk')
export class CoreRiskController {
  constructor(
    private readonly limits: CoreRiskLimitService,
    private readonly killSwitch: CoreKillSwitchService,
  ) {}

  @Get('limits')
  async listLimits(@CurrentUser('userId') userId: string): Promise<{ limits: CoreRiskLimitView[] }> {
    return { limits: await this.limits.list(userId) };
  }

  @Put('limits/:key/:scope')
  changeLimit(
    @CurrentUser('userId') userId: string,
    @Param('key') key: string,
    @Param('scope') scope: string,
    @Body() dto: ChangeLimitDto,
  ): Promise<LimitChangeResult> {
    return this.limits.change(userId, { key, scope, value: dto.value, reason: dto.reason });
  }

  @Get('kill-switch')
  getKillSwitch(@CurrentUser('userId') userId: string): Promise<KillSwitchView> {
    return this.killSwitch.get(userId);
  }

  @Post('kill-switch')
  @HttpCode(HttpStatus.OK)
  setKillSwitch(@CurrentUser() user: AuthenticatedUser, @Body() dto: SetKillSwitchDto): Promise<KillSwitchSetResult> {
    return this.killSwitch.set({ userId: user.userId, role: user.role }, { active: dto.active, reason: dto.reason });
  }
}
```

- [ ] **Step 4: Wire the module**

Replace the contents of `apps/api/src/modules/trade-core/trade-core.module.ts` with:

```typescript
import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { CoreStrategiesController } from './strategies/controllers/core-strategies.controller';
import { CoreStrategyRepository } from './strategies/repositories/core-strategy.repository';
import { CoreStrategySelectionRepository } from './strategies/repositories/core-strategy-selection.repository';
import { CoreStrategyCatalogueService } from './strategies/services/core-strategy-catalogue.service';
import { CoreStrategySelectionService } from './strategies/services/core-strategy-selection.service';
import { CoreRiskController } from './risk-wall/controllers/core-risk.controller';
import {
  CORE_SESSION_CLOCK,
  CORE_SQUARE_OFF,
  createCoreSessionClock,
  LoggingRiskVerdictSink,
  NoCorePositionsSquareOff,
  RISK_STATE_PROVIDER,
  RISK_VERDICT_SINK,
  UnavailableRiskStateProvider,
} from './risk-wall/ports';
import { CoreKillSwitchRepository } from './risk-wall/repositories/core-kill-switch.repository';
import { CoreRiskLimitRepository } from './risk-wall/repositories/core-risk-limit.repository';
import { CoreKillSwitchService } from './risk-wall/services/core-kill-switch.service';
import { CoreRiskLimitService } from './risk-wall/services/core-risk-limit.service';
import { RiskWallService } from './risk-wall/services/risk-wall.service';
import { SiloSquareOffAdapter } from './risk-wall/services/silo-square-off.adapter';

/**
 * SP2 trade core (docs/superpowers/specs/2026-10-09-sp2-core-trade-lifecycle-design.md).
 * M1: `strategies/` (catalogue, immutable versions, per-user selections).
 * M2: `risk-wall/` (the pure Risk Wall check, per-user limits with tighten-now /
 * loosen-next-session, the persistent kill switch and its silo cascade). The four
 * port tokens carry fail-closed M2 defaults that M3/M4/M5 rebind here. Nothing in M2
 * trades. AuditService comes from the @Global AuditModule. No silo module is imported
 * (approach A): SiloSquareOffAdapter reaches the silos' existing entry points through
 * ModuleRef at call time.
 */
@Module({
  imports: [PrismaModule],
  controllers: [CoreStrategiesController, CoreRiskController],
  providers: [
    CoreStrategyRepository,
    CoreStrategySelectionRepository,
    CoreStrategyCatalogueService,
    CoreStrategySelectionService,
    CoreRiskLimitRepository,
    CoreKillSwitchRepository,
    CoreRiskLimitService,
    CoreKillSwitchService,
    SiloSquareOffAdapter,
    RiskWallService,
    { provide: CORE_SESSION_CLOCK, useFactory: createCoreSessionClock },
    { provide: RISK_STATE_PROVIDER, useClass: UnavailableRiskStateProvider },
    { provide: RISK_VERDICT_SINK, useClass: LoggingRiskVerdictSink },
    { provide: CORE_SQUARE_OFF, useClass: NoCorePositionsSquareOff },
  ],
  exports: [CoreStrategyCatalogueService, CoreStrategySelectionService, RiskWallService, CoreRiskLimitService, CoreKillSwitchService],
})
export class TradeCoreModule {}
```

In `apps/api/src/app.module.ts`, replace the two comment lines above `TradeCoreModule,` (currently
"SP2 trade core — M1: strategy catalogue, immutable versions, per-user / selections (the dropdown). Paper
only; nothing trades until M5.") with:

```typescript
    // SP2 trade core — M1: strategy catalogue, immutable versions, per-user
    // selections. M2: Risk Wall, per-user limits, persistent kill switch (its
    // "on" also calls the silos' square-off paths). Paper only; nothing trades until M5.
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @td/api test -- core-risk.controller trade-core.module`
Expected: PASS (5 + 2 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/trade-core/risk-wall/dto/core-risk.dto.ts apps/api/src/modules/trade-core/risk-wall/controllers/core-risk.controller.ts apps/api/src/modules/trade-core/risk-wall/controllers/core-risk.controller.spec.ts apps/api/src/modules/trade-core/trade-core.module.ts apps/api/src/modules/trade-core/trade-core.module.spec.ts apps/api/src/app.module.ts
git commit -m "feat(trade-core): /api/trade-core/risk routes for limits and the kill switch; module wiring" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/api/src/modules/trade-core/risk-wall/dto/core-risk.dto.ts apps/api/src/modules/trade-core/risk-wall/controllers/core-risk.controller.ts apps/api/src/modules/trade-core/risk-wall/controllers/core-risk.controller.spec.ts apps/api/src/modules/trade-core/trade-core.module.ts apps/api/src/modules/trade-core/trade-core.module.spec.ts apps/api/src/app.module.ts
```

---

### Task 11: Admin editing of the global seed defaults (API)

**Files:**
- Modify: `apps/api/src/modules/trade-core/risk-wall/repositories/core-risk-limit.repository.ts` (add `upsertDefault`)
- Create: `apps/api/src/modules/trade-core/risk-wall/services/core-risk-defaults.service.ts`
- Create: `apps/api/src/modules/trade-core/risk-wall/controllers/core-risk-defaults.controller.ts`
- Modify: `apps/api/src/modules/trade-core/trade-core.module.ts`, `apps/api/src/modules/trade-core/trade-core.module.spec.ts`
- Test: `apps/api/src/modules/trade-core/risk-wall/services/core-risk-defaults.service.spec.ts`
- Test: `apps/api/src/modules/trade-core/risk-wall/controllers/core-risk-defaults.controller.spec.ts`

**Interfaces:**
- Consumes: `CoreRiskLimitRepository.listDefaults` (Task 5), `CoreRiskLimitService` (Task 6, in the
  "future seeds" test), `ChangeLimitDto` (Task 10), `parseLimitValue`/`toStorage`/`fromStorage`/`wireValue`
  (Task 1), `AUDIT_ACTIONS.risk.CORE_RISK_DEFAULT_CHANGED` (Task 5), `AdminOnly`, `CurrentUser`.
- Produces:

```typescript
// repository
upsertDefault(key: string, scope: string, value: StoredLimitValue, note: string, updatedBy: string, now: Date): Promise<CoreRiskLimitDefault>;
// service
export interface CoreRiskDefaultView { key: LimitKey; scope: LimitScope; kind: LimitKind; tighter: TighterDirection; value: number | string | null; note: string | null; updatedBy: string | null; updatedAt: string | null }
export interface DefaultChangeInput { key: string; scope: string; value: unknown; reason: string }
class CoreRiskDefaultsService { list(): Promise<CoreRiskDefaultView[]>; change(actor: Actor, input: DefaultChangeInput, now?: Date): Promise<CoreRiskDefaultView> }
// routes (class-level @AdminOnly)
GET  /api/trade-core/risk/defaults               → { defaults: CoreRiskDefaultView[] }
PUT  /api/trade-core/risk/defaults/:key/:scope   { value, reason } → CoreRiskDefaultView
```

Rules (decision 20): owner only (route guard **and** a service re-check); the new value takes effect for
every seed from now on (no D5 delay: a default is not in force for anyone); the admin's reason replaces
the row's `note`, so the next seed reads "default — please review (<reason>)"; existing
`core_risk_limits` rows are never read, rewritten or appended by this path.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/modules/trade-core/risk-wall/services/core-risk-defaults.service.spec.ts`:

```typescript
import { ForbiddenException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma, type CoreRiskLimit, type CoreRiskLimitDefault } from '@prisma/client';
import type { AuditService } from '../../../../common/audit/audit.service';
import type { SessionClock } from '../../../market-hub/session-clock';
import { toStorage, type StoredLimitValue } from '../limits/limit-keys';
import { createCoreSessionClock } from '../ports';
import type { CoreRiskLimitRepository, NewLimitRow } from '../repositories/core-risk-limit.repository';
import { limitsFixture, NOW } from '../testing/risk-fixtures';
import { CoreRiskDefaultsService } from './core-risk-defaults.service';
import { CoreRiskLimitService } from './core-risk-limit.service';

const OWNER = { userId: 'usr_owner', role: 'ADMIN' };
const USER = { userId: 'user_A', role: 'USER' };

/** One in-memory store behind both services, so "future seeds" can be observed. */
class Store {
  limits: CoreRiskLimit[] = [];
  defaults: CoreRiskLimitDefault[] = limitsFixture().map((l) => ({
    key: l.key, scope: l.scope, ...toStorage(l.key, l.value), note: 'seed', updatedBy: null, updatedAt: NOW,
  }));
  appendCalls = 0;
  private seq = 0;

  async listDefaults() { return this.defaults; }
  async upsertDefault(key: string, scope: string, value: StoredLimitValue, note: string, updatedBy: string, now: Date) {
    const row = { key, scope, ...value, note, updatedBy, updatedAt: now };
    this.defaults = [...this.defaults.filter((d) => !(d.key === key && d.scope === scope)), row];
    return row;
  }
  async listForUser(userId: string) { return this.limits.filter((r) => r.userId === userId); }
  async listForPair(userId: string, key: string, scope: string) { return this.limits.filter((r) => r.userId === userId && r.key === key && r.scope === scope); }
  async pairsForUser(userId: string) { return new Set((await this.listForUser(userId)).map((r) => `${r.key}@${r.scope}`)); }
  async settingsForSeed() { return { settings: null, from: null }; }
  async append(): Promise<CoreRiskLimit> { this.appendCalls += 1; throw new Error('not used here'); }
  async appendIfMissing(userId: string, rows: NewLimitRow[], now: Date) {
    const present = await this.pairsForUser(userId);
    return rows.filter((r) => !present.has(`${r.key}@${r.scope}`)).map((r) => {
      this.seq += 1;
      const row = { id: `lim_${this.seq}`, userId, ...r, createdAt: new Date(now.getTime() + this.seq) } as CoreRiskLimit;
      this.limits.push(row);
      return row;
    });
  }
}

function setup() {
  const store = new Store();
  const audit = { append: jest.fn().mockResolvedValue({ seq: 1n, hash: 'h' }) };
  const repo = store as unknown as CoreRiskLimitRepository;
  const defaults = new CoreRiskDefaultsService(repo, audit as unknown as AuditService);
  const limits = new CoreRiskLimitService(repo, audit as unknown as AuditService, createCoreSessionClock() as SessionClock);
  return { store, audit, defaults, limits };
}

describe('CoreRiskDefaultsService (decision 20)', () => {
  it('lists every (key, scope) in display order, with null for a missing row', async () => {
    const { store, defaults } = setup();
    store.defaults = store.defaults.filter((d) => d.key !== 'maxTradesPerDay');
    const views = await defaults.list();
    expect(views).toHaveLength(21);
    expect(views[0]).toEqual({ key: 'maxDailyLoss', scope: 'ALL', kind: 'rupees', tighter: 'lower', value: 5000, note: 'seed', updatedBy: null, updatedAt: NOW.toISOString() });
    expect(views.find((v) => v.key === 'maxTradesPerDay')).toMatchObject({ value: null, note: null, updatedAt: null });
  });

  it('the owner changes a default at once; the reason becomes its note; it is audited', async () => {
    const { audit, defaults } = setup();
    const v = await defaults.change(OWNER, { key: 'squareOffTime', scope: 'CASH_INTRADAY', value: '15:20', reason: '  earlier exit  ' }, NOW);
    expect(v).toEqual({ key: 'squareOffTime', scope: 'CASH_INTRADAY', kind: 'hhmm', tighter: 'earlier', value: '15:20', note: 'earlier exit', updatedBy: 'usr_owner', updatedAt: NOW.toISOString() });
    expect(audit.append).toHaveBeenCalledWith({
      action: 'CORE_RISK_DEFAULT_CHANGED',
      userId: 'usr_owner',
      target: 'core_risk_limit_default:squareOffTime@CASH_INTRADAY',
      meta: { key: 'squareOffTime', scope: 'CASH_INTRADAY', from: '15:15', to: '15:20', reason: 'earlier exit' },
    });
  });

  it('a changed default seeds future users only; existing user rows are never rewritten', async () => {
    const { store, defaults, limits } = setup();
    const before = await limits.list('user_A', NOW);
    expect(before.find((l) => l.key === 'maxTradesPerDay')?.value).toBe(20);
    const rowsBefore = JSON.stringify(store.limits);
    await defaults.change(OWNER, { key: 'maxTradesPerDay', scope: 'ALL', value: 12, reason: 'fewer trades' }, NOW);
    expect(JSON.stringify(store.limits)).toBe(rowsBefore);
    expect(store.appendCalls).toBe(0);
    expect((await limits.list('user_A', NOW)).find((l) => l.key === 'maxTradesPerDay')?.value).toBe(20);
    expect((await limits.list('user_B', NOW)).find((l) => l.key === 'maxTradesPerDay')).toMatchObject({
      value: 12, source: 'DEFAULT', reason: 'default — please review (fewer trades)',
    });
  });

  it('only the owner may change a default, even if the route guard were bypassed; nothing is written', async () => {
    const { store, audit, defaults } = setup();
    const snapshot = JSON.stringify(store.defaults);
    await expect(defaults.change(USER, { key: 'maxTradesPerDay', scope: 'ALL', value: 99, reason: 'mine' }, NOW)).rejects.toBeInstanceOf(ForbiddenException);
    expect(JSON.stringify(store.defaults)).toBe(snapshot);
    expect(audit.append).not.toHaveBeenCalled();
  });

  it('an unknown pair is 404 and a bad value is 422', async () => {
    const { defaults } = setup();
    await expect(defaults.change(OWNER, { key: 'nope', scope: 'ALL', value: 1, reason: 'why not' }, NOW)).rejects.toBeInstanceOf(NotFoundException);
    await expect(defaults.change(OWNER, { key: 'maxDailyLoss', scope: 'MTF', value: 1, reason: 'why not' }, NOW)).rejects.toBeInstanceOf(NotFoundException);
    await expect(defaults.change(OWNER, { key: 'mtfMaxLeverage', scope: 'MTF', value: 0.5, reason: 'why not' }, NOW)).rejects.toBeInstanceOf(UnprocessableEntityException);
  });
});

describe('CoreRiskLimitRepository.upsertDefault', () => {
  it('touches only core_risk_limit_defaults, keyed by (key, scope)', async () => {
    const { CoreRiskLimitRepository } = await import('../repositories/core-risk-limit.repository');
    const prisma = {
      coreRiskLimitDefault: { upsert: jest.fn().mockResolvedValue({}) },
      coreRiskLimit: new Proxy({}, { get: () => { throw new Error('core_risk_limits must not be touched'); } }),
    };
    const value = { numValue: new Prisma.Decimal('12'), textValue: null };
    await new CoreRiskLimitRepository(prisma as never).upsertDefault('maxTradesPerDay', 'ALL', value, 'fewer', 'usr_owner', NOW);
    expect(prisma.coreRiskLimitDefault.upsert).toHaveBeenCalledWith({
      where: { key_scope: { key: 'maxTradesPerDay', scope: 'ALL' } },
      create: { key: 'maxTradesPerDay', scope: 'ALL', ...value, note: 'fewer', updatedBy: 'usr_owner', updatedAt: NOW },
      update: { ...value, note: 'fewer', updatedBy: 'usr_owner', updatedAt: NOW },
    });
  });
});
```

Create `apps/api/src/modules/trade-core/risk-wall/controllers/core-risk-defaults.controller.spec.ts`:

```typescript
import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ROLES_KEY, type AuthenticatedUser } from '../../../../common/decorators';
import type { CoreRiskDefaultsService } from '../services/core-risk-defaults.service';
import { CoreRiskDefaultsController } from './core-risk-defaults.controller';

const OWNER: AuthenticatedUser = { userId: 'usr_owner', role: 'ADMIN', email: 'o@x' };

describe('CoreRiskDefaultsController', () => {
  it('serves /api/trade-core/risk/defaults, the whole controller @AdminOnly', () => {
    expect(Reflect.getMetadata(PATH_METADATA, CoreRiskDefaultsController)).toBe('api/trade-core/risk/defaults');
    expect(Reflect.getMetadata(ROLES_KEY, CoreRiskDefaultsController)).toEqual(['ADMIN']);
    expect(Reflect.getMetadata(METHOD_METADATA, CoreRiskDefaultsController.prototype.list)).toBe(RequestMethod.GET);
    expect(Reflect.getMetadata(METHOD_METADATA, CoreRiskDefaultsController.prototype.change)).toBe(RequestMethod.PUT);
    expect(Reflect.getMetadata(PATH_METADATA, CoreRiskDefaultsController.prototype.change)).toBe(':key/:scope');
  });

  it('passes the token user as the actor', async () => {
    const svc = { list: jest.fn().mockResolvedValue([]), change: jest.fn().mockResolvedValue({}) };
    const controller = new CoreRiskDefaultsController(svc as unknown as CoreRiskDefaultsService);
    expect(await controller.list()).toEqual({ defaults: [] });
    await controller.change(OWNER, 'maxTradesPerDay', 'ALL', { value: 12, reason: 'fewer trades' });
    expect(svc.change).toHaveBeenCalledWith({ userId: 'usr_owner', role: 'ADMIN' }, { key: 'maxTradesPerDay', scope: 'ALL', value: 12, reason: 'fewer trades' });
  });
});
```

In `apps/api/src/modules/trade-core/trade-core.module.spec.ts`, add to the imports:

```typescript
import { CoreRiskDefaultsController } from './risk-wall/controllers/core-risk-defaults.controller';
import { CoreRiskDefaultsService } from './risk-wall/services/core-risk-defaults.service';
```

and inside the test "resolves the M2 risk parts with their fail-closed default ports", add:

```typescript
    expect(mod.get(CoreRiskDefaultsController)).toBeInstanceOf(CoreRiskDefaultsController);
    expect(mod.get(CoreRiskDefaultsService)).toBeInstanceOf(CoreRiskDefaultsService);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @td/api test -- core-risk-defaults trade-core.module`
Expected: FAIL with `Cannot find module './core-risk-defaults.service'` and
`Cannot find module './core-risk-defaults.controller'`.

- [ ] **Step 3: Write the repository method, the service and the controller**

In `apps/api/src/modules/trade-core/risk-wall/repositories/core-risk-limit.repository.ts`, add after
`listDefaults()`:

```typescript
  /** Admin edit of one global seed default (decision 20). Touches only core_risk_limit_defaults. */
  upsertDefault(
    key: string,
    scope: string,
    value: { numValue: Prisma.Decimal | null; textValue: string | null },
    note: string,
    updatedBy: string,
    now: Date,
  ): Promise<CoreRiskLimitDefault> {
    return this.prisma.coreRiskLimitDefault.upsert({
      where: { key_scope: { key, scope } },
      create: { key, scope, ...value, note, updatedBy, updatedAt: now },
      update: { ...value, note, updatedBy, updatedAt: now },
    });
  }
```

Create `apps/api/src/modules/trade-core/risk-wall/services/core-risk-defaults.service.ts`:

```typescript
import { ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { CoreRiskLimitDefault } from '@prisma/client';
import { AuditService } from '../../../../common/audit/audit.service';
import { AUDIT_ACTIONS } from '../../../../common/audit/audit-actions';
import type { Actor } from '../../strategies/services/core-strategy-catalogue.service';
import {
  fromStorage,
  isLimitKey,
  isLimitPair,
  LIMIT_KEYS,
  LIMIT_PAIRS,
  parseLimitValue,
  toStorage,
  wireValue,
  type LimitKey,
  type LimitKind,
  type LimitScope,
  type TighterDirection,
} from '../limits/limit-keys';
import { CoreRiskLimitRepository } from '../repositories/core-risk-limit.repository';

export interface CoreRiskDefaultView {
  key: LimitKey;
  scope: LimitScope;
  kind: LimitKind;
  tighter: TighterDirection;
  value: number | string | null;
  note: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
}

export interface DefaultChangeInput {
  key: string;
  scope: string;
  value: unknown;
  reason: string;
}

function viewOf(key: LimitKey, scope: LimitScope, row: CoreRiskLimitDefault | undefined): CoreRiskDefaultView {
  const value = row ? fromStorage(key, row.numValue, row.textValue) : null;
  return {
    key,
    scope,
    kind: LIMIT_KEYS[key].kind,
    tighter: LIMIT_KEYS[key].tighter,
    value: value === null ? null : wireValue(key, value),
    note: row?.note ?? null,
    updatedBy: row?.updatedBy ?? null,
    updatedAt: row ? row.updatedAt.toISOString() : null,
  };
}

/**
 * The global seed defaults (owner answer 1, decision 20): what a user's limit starts
 * at when no UserSettings equivalent exists. Owner only. A change applies to every
 * seed from now on and never touches any user's core_risk_limits rows; each user
 * changes their own limits on the Risk page under D5.
 */
@Injectable()
export class CoreRiskDefaultsService {
  constructor(
    private readonly repo: CoreRiskLimitRepository,
    private readonly audit: AuditService,
  ) {}

  async list(): Promise<CoreRiskDefaultView[]> {
    const rows = await this.repo.listDefaults();
    return LIMIT_PAIRS.map((p) => viewOf(p.key, p.scope, rows.find((r) => r.key === p.key && r.scope === p.scope)));
  }

  async change(actor: Actor, input: DefaultChangeInput, now: Date = new Date()): Promise<CoreRiskDefaultView> {
    if (actor.role !== 'ADMIN') throw new ForbiddenException('only the owner edits the seed defaults');
    if (!isLimitKey(input.key)) throw new NotFoundException(`unknown limit ${input.key}`);
    if (!isLimitPair(input.key, input.scope)) throw new NotFoundException(`${input.key} has no ${input.scope} scope`);
    const key = input.key;
    const scope = input.scope as LimitScope;
    const parsed = parseLimitValue(key, input.value);
    if (!parsed.ok) throw new UnprocessableEntityException(`${key} ${parsed.error}`);
    const reason = input.reason.trim();

    const before = (await this.repo.listDefaults()).find((d) => d.key === key && d.scope === scope);
    const from = before ? fromStorage(key, before.numValue, before.textValue) : null;
    const row = await this.repo.upsertDefault(key, scope, toStorage(key, parsed.value), reason, actor.userId, now);
    await this.audit.append({
      action: AUDIT_ACTIONS.risk.CORE_RISK_DEFAULT_CHANGED,
      userId: actor.userId,
      target: `core_risk_limit_default:${key}@${scope}`,
      meta: { key, scope, from, to: parsed.value, reason },
    });
    return viewOf(key, scope, row);
  }
}
```

Create `apps/api/src/modules/trade-core/risk-wall/controllers/core-risk-defaults.controller.ts`:

```typescript
import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AdminOnly, CurrentUser, type AuthenticatedUser } from '../../../../common/decorators';
import { ChangeLimitDto } from '../dto/core-risk.dto';
import { CoreRiskDefaultsService, type CoreRiskDefaultView } from '../services/core-risk-defaults.service';

/** Owner-only editing of the global seed defaults (decision 20). The service re-checks the role. */
@ApiTags('Trade core: risk defaults')
@AdminOnly()
@Controller('api/trade-core/risk/defaults')
export class CoreRiskDefaultsController {
  constructor(private readonly defaults: CoreRiskDefaultsService) {}

  @Get()
  async list(): Promise<{ defaults: CoreRiskDefaultView[] }> {
    return { defaults: await this.defaults.list() };
  }

  @Put(':key/:scope')
  change(
    @CurrentUser() user: AuthenticatedUser,
    @Param('key') key: string,
    @Param('scope') scope: string,
    @Body() dto: ChangeLimitDto,
  ): Promise<CoreRiskDefaultView> {
    return this.defaults.change({ userId: user.userId, role: user.role }, { key, scope, value: dto.value, reason: dto.reason });
  }
}
```

In `apps/api/src/modules/trade-core/trade-core.module.ts`, add the imports

```typescript
import { CoreRiskDefaultsController } from './risk-wall/controllers/core-risk-defaults.controller';
import { CoreRiskDefaultsService } from './risk-wall/services/core-risk-defaults.service';
```

change `controllers: [CoreStrategiesController, CoreRiskController],` to
`controllers: [CoreStrategiesController, CoreRiskController, CoreRiskDefaultsController],`, and add
`CoreRiskDefaultsService,` after `CoreRiskLimitService,` in `providers`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @td/api test -- core-risk-defaults trade-core.module`
Expected: PASS (6 + 2 + 2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/trade-core/risk-wall/repositories/core-risk-limit.repository.ts apps/api/src/modules/trade-core/risk-wall/services/core-risk-defaults.service.ts apps/api/src/modules/trade-core/risk-wall/services/core-risk-defaults.service.spec.ts apps/api/src/modules/trade-core/risk-wall/controllers/core-risk-defaults.controller.ts apps/api/src/modules/trade-core/risk-wall/controllers/core-risk-defaults.controller.spec.ts apps/api/src/modules/trade-core/trade-core.module.ts apps/api/src/modules/trade-core/trade-core.module.spec.ts
git commit -m "feat(trade-core): owner-only editing of the global risk seed defaults, audited" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/api/src/modules/trade-core/risk-wall/repositories/core-risk-limit.repository.ts apps/api/src/modules/trade-core/risk-wall/services/core-risk-defaults.service.ts apps/api/src/modules/trade-core/risk-wall/services/core-risk-defaults.service.spec.ts apps/api/src/modules/trade-core/risk-wall/controllers/core-risk-defaults.controller.ts apps/api/src/modules/trade-core/risk-wall/controllers/core-risk-defaults.controller.spec.ts apps/api/src/modules/trade-core/trade-core.module.ts apps/api/src/modules/trade-core/trade-core.module.spec.ts
```

---

### Task 12: `CoreKillSwitchReader` and the entry gate (`kill-gate.ts`)

**Files:**
- Create: `apps/api/src/modules/trade-core/risk-wall/kill-gate.ts`
- Create: `apps/api/src/modules/trade-core/risk-wall/services/core-kill-switch.reader.ts`
- Create: `apps/api/test/setup/core-kill-gate.ts`
- Modify: `apps/api/package.json` (`jest.setupFiles`)
- Modify: `apps/api/src/modules/trade-core/risk-wall/services/core-kill-switch.service.ts` (invalidate the cache after a change)
- Modify: `apps/api/src/modules/trade-core/trade-core.module.ts`, `trade-core.module.spec.ts`
- Test: `apps/api/src/modules/trade-core/risk-wall/kill-gate.spec.ts`
- Test: `apps/api/src/modules/trade-core/risk-wall/services/core-kill-switch.reader.spec.ts`

**Interfaces:**
- Consumes: `resolveAppendOnly` (Task 2), `PrismaService`, `TenantContextService.runWithoutTenant`
  (`common/tenant/tenant-context.service.ts`), `CoreKillSwitchService` (Task 8).
- Produces:

```typescript
// kill-gate.ts (no Nest dependency beyond Logger; silo code imports only this file)
export type GuardedEntry = 'watch-monitor' | 'adaptive-stop-track' | 'ungated-track' | 'sell-futures-track'
  | 'breakout-swing-track' | 'anand-dual-track' | 'auto-execution' | 'auto-trade';
export interface KillSwitchReadPort { isOn(userId: string): Promise<boolean>; isOnForPlatform(): Promise<boolean>; invalidate(): void }
export class CoreKillSwitchEntryBlockedError extends Error { readonly entry: GuardedEntry; readonly ref: string | null }
export function setCoreKillSwitchReader(reader: KillSwitchReadPort | null): void;
export function invalidateCoreKillSwitchCache(): void;
export function coreEntryAllowed(entry: GuardedEntry, ctx?: { userId?: string | null; ref?: string | null }): Promise<boolean>;  // never throws
export function assertCoreEntryAllowed(entry: GuardedEntry, ctx?: { userId?: string | null; ref?: string | null }): Promise<void>; // throws the error above
// services/core-kill-switch.reader.ts
class CoreKillSwitchReader implements KillSwitchReadPort, OnModuleInit, OnModuleDestroy { static readonly CACHE_MS = 5_000 }
```

**Design (decision 21):**
- **Whose switch.** A per-user path (auto-execution) asks `isOn(userId)`. The platform-wide silos and
  auto-trade have no `userId` (decision 9), so they ask `isOnForPlatform()`: true when **any ADMIN's** core
  kill switch is in force on. That is "the owner's switch stops the silos".
- **Fails closed.** A read that throws, or a gate with no reader wired, refuses the entry and logs why.
- **Cache ≤ 5 s.** Each answer is kept for `CACHE_MS` (a staleness bound for hot paths, not a risk value);
  errors are never cached; `CoreKillSwitchService.set` clears the cache at once, so the owner's own press
  is seen immediately in this process.
- **Why a module-level gate and not constructor injection.** Silo constructors stay exactly as they are
  (the owner asked for "nothing else" in silo logic; every existing silo spec builds its service with
  `new X(...)`). The reader is still an injectable provider: on module init it registers itself with the
  gate. Unit tests get an "off" reader from `test/setup/core-kill-gate.ts` (Jest `setupFiles`); production
  has no such default and fails closed until the reader registers.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/modules/trade-core/risk-wall/kill-gate.spec.ts`:

```typescript
import { Logger } from '@nestjs/common';
import {
  assertCoreEntryAllowed,
  coreEntryAllowed,
  CoreKillSwitchEntryBlockedError,
  invalidateCoreKillSwitchCache,
  setCoreKillSwitchReader,
  type KillSwitchReadPort,
} from './kill-gate';

const reader = (over: Partial<KillSwitchReadPort> = {}): KillSwitchReadPort & { [k: string]: jest.Mock } =>
  ({ isOn: jest.fn(async () => false), isOnForPlatform: jest.fn(async () => false), invalidate: jest.fn(), ...over }) as never;
const OFF = reader();

let warn: jest.SpyInstance;
beforeEach(() => { warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined); });
afterEach(() => { warn.mockRestore(); setCoreKillSwitchReader(OFF); });

describe('kill-gate', () => {
  it('allows an entry while the switch is off, without logging', async () => {
    const r = reader();
    setCoreKillSwitchReader(r);
    expect(await coreEntryAllowed('ungated-track', { ref: 'RELIANCE' })).toBe(true);
    expect(r.isOnForPlatform).toHaveBeenCalledTimes(1);
    expect(r.isOn).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('refuses while the owner switch is on, and logs it', async () => {
    setCoreKillSwitchReader(reader({ isOnForPlatform: jest.fn(async () => true) }));
    expect(await coreEntryAllowed('breakout-swing-track', { ref: 'TCS' })).toBe(false);
    expect(String(warn.mock.calls[0][0])).toBe('[breakout-swing-track] new entry TCS refused: the core kill switch is on');
  });

  it('a per-user entry asks about that user only', async () => {
    const r = reader({ isOn: jest.fn(async (u: string) => u === 'user_A') });
    setCoreKillSwitchReader(r);
    expect(await coreEntryAllowed('auto-execution', { userId: 'user_A', ref: 'NIFTY' })).toBe(false);
    expect(await coreEntryAllowed('auto-execution', { userId: 'user_B', ref: 'NIFTY' })).toBe(true);
    expect(r.isOnForPlatform).not.toHaveBeenCalled();
  });

  it('fails closed when the state cannot be read, or no reader is wired', async () => {
    setCoreKillSwitchReader(reader({ isOnForPlatform: jest.fn(async () => { throw new Error('db down'); }) }));
    expect(await coreEntryAllowed('sell-futures-track')).toBe(false);
    expect(String(warn.mock.calls[0][0])).toContain('cannot be read (db down); failing closed');
    setCoreKillSwitchReader(null);
    expect(await coreEntryAllowed('watch-monitor')).toBe(false);
    expect(String(warn.mock.calls[1][0])).toContain('reader is not wired');
  });

  it('assertCoreEntryAllowed throws a named error only when refused', async () => {
    setCoreKillSwitchReader(reader({ isOnForPlatform: jest.fn(async () => true) }));
    const err = await assertCoreEntryAllowed('adaptive-stop-track', { ref: 'INFY' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CoreKillSwitchEntryBlockedError);
    expect(err).toMatchObject({ entry: 'adaptive-stop-track', ref: 'INFY', message: 'adaptive-stop-track: new entry INFY refused (core kill switch)' });
    setCoreKillSwitchReader(OFF);
    await expect(assertCoreEntryAllowed('adaptive-stop-track', { ref: 'INFY' })).resolves.toBeUndefined();
  });

  it('invalidate reaches the registered reader, and is safe with none', () => {
    const r = reader();
    setCoreKillSwitchReader(r);
    invalidateCoreKillSwitchCache();
    expect(r.invalidate).toHaveBeenCalledTimes(1);
    setCoreKillSwitchReader(null);
    expect(() => invalidateCoreKillSwitchCache()).not.toThrow();
  });
});
```

Create `apps/api/src/modules/trade-core/risk-wall/services/core-kill-switch.reader.spec.ts`:

```typescript
import type { PrismaService } from '../../../../common/prisma/prisma.service';
import type { TenantContextService } from '../../../../common/tenant/tenant-context.service';
import { coreEntryAllowed, setCoreKillSwitchReader } from '../kill-gate';
import { CoreKillSwitchReader } from './core-kill-switch.reader';

const T0 = new Date('2026-10-12T05:00:00.000Z');
const NEXT_OPEN = new Date('2026-10-13T03:45:00.000Z');
const row = (userId: string, id: string, active: boolean, createdAt: Date, effectiveFrom: Date = createdAt) => ({ id, userId, active, createdAt, effectiveFrom });

function setup(rows: ReturnType<typeof row>[] = []) {
  const findMany = jest.fn(async ({ where }: { where: { userId?: string } }) => (where.userId ? rows.filter((r) => r.userId === where.userId) : rows));
  const prisma = { coreKillSwitch: { findMany } };
  const tenant = { runWithoutTenant: jest.fn(<T>(fn: () => T) => fn()) };
  const reader = new CoreKillSwitchReader(prisma as unknown as PrismaService, tenant as unknown as TenantContextService);
  return { findMany, tenant, reader };
}

beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(T0); });
afterEach(() => { jest.useRealTimers(); setCoreKillSwitchReader({ isOn: async () => false, isOnForPlatform: async () => false, invalidate: () => undefined }); });

describe('CoreKillSwitchReader', () => {
  it('reads one user’s switch with the append-only rule', async () => {
    const { reader } = setup([row('user_A', 'k1', true, new Date(T0.getTime() - 60_000)), row('user_A', 'k2', false, new Date(T0.getTime() - 1000), NEXT_OPEN)]);
    expect(await reader.isOn('user_A')).toBe(true); // the release waits for the next open
    expect(await reader.isOn('user_B')).toBe(false);
  });

  it('the platform answer is any ADMIN’s switch, read without tenant scoping', async () => {
    const { findMany, tenant, reader } = setup([row('usr_owner', 'k1', true, new Date(T0.getTime() - 1000)), row('usr_admin2', 'k2', false, new Date(T0.getTime() - 1000))]);
    expect(await reader.isOnForPlatform()).toBe(true);
    expect(findMany).toHaveBeenCalledWith({ where: { user: { role: 'ADMIN' } }, select: { id: true, userId: true, active: true, effectiveFrom: true, createdAt: true } });
    expect(tenant.runWithoutTenant).toHaveBeenCalled();
  });

  it('caches each answer for at most 5 s, and invalidate drops the cache at once', async () => {
    const { findMany, reader } = setup();
    await reader.isOnForPlatform();
    await reader.isOnForPlatform();
    expect(findMany).toHaveBeenCalledTimes(1);
    jest.setSystemTime(new Date(T0.getTime() + CoreKillSwitchReader.CACHE_MS));
    await reader.isOnForPlatform();
    expect(findMany).toHaveBeenCalledTimes(2);
    reader.invalidate();
    await reader.isOnForPlatform();
    expect(findMany).toHaveBeenCalledTimes(3);
    expect(CoreKillSwitchReader.CACHE_MS).toBeLessThanOrEqual(5_000);
  });

  it('a failed read is not cached and reaches the gate as a refusal', async () => {
    const { findMany, reader } = setup();
    findMany.mockRejectedValueOnce(new Error('db down'));
    await expect(reader.isOnForPlatform()).rejects.toThrow('db down');
    reader.onModuleInit();
    findMany.mockRejectedValueOnce(new Error('db down'));
    expect(await coreEntryAllowed('ungated-track')).toBe(false);
    expect(await coreEntryAllowed('ungated-track')).toBe(true);
  });

  it('registers with the gate on module init and unregisters on destroy', async () => {
    const { reader } = setup([row('usr_owner', 'k1', true, new Date(T0.getTime() - 1000))]);
    reader.onModuleInit();
    expect(await coreEntryAllowed('watch-monitor')).toBe(false);
    reader.onModuleDestroy();
    expect(await coreEntryAllowed('watch-monitor')).toBe(false); // no reader: fail closed
  });
});

describe('CoreKillSwitchService clears the reader cache on every change', () => {
  it('turning the switch on invalidates the cache before the cascade runs', async () => {
    const { CoreKillSwitchService } = await import('./core-kill-switch.service');
    const order: string[] = [];
    setCoreKillSwitchReader({ isOn: async () => false, isOnForPlatform: async () => false, invalidate: () => order.push('invalidate') });
    const repo = {
      listForUser: async () => [],
      append: async (userId: string, r: { active: boolean; effectiveFrom: Date; setBy: string; reason: string }) => ({ id: 'ks_1', userId, ...r, createdAt: T0 }),
    };
    const core = { squareOffAll: async () => { order.push('core'); return { cancelledOrders: 0, exitsRequested: 0, detail: 'none' }; } };
    const silos = { squareOffAll: async () => { order.push('silos'); return []; } };
    const audit = { append: jest.fn().mockResolvedValue({}) };
    const svc = new CoreKillSwitchService(repo as never, audit as never, { nextOpen: () => NEXT_OPEN } as never, core as never, silos as never);
    await svc.set({ userId: 'usr_owner', role: 'ADMIN' }, { active: true, reason: 'stop' }, T0);
    expect(order).toEqual(['invalidate', 'core', 'silos']);
  });
});
```

In `apps/api/src/modules/trade-core/trade-core.module.spec.ts`, add the import
`import { CoreKillSwitchReader } from './risk-wall/services/core-kill-switch.reader';` and, in the M2 test,
`expect(mod.get(CoreKillSwitchReader)).toBeInstanceOf(CoreKillSwitchReader);`. Add a `TenantContextService`
stand-in to `FakeAuditModule` (the real one comes from the @Global TenantModule):

```typescript
import { TenantContextService } from '../../common/tenant/tenant-context.service';

@Global()
@Module({
  providers: [
    { provide: AuditService, useValue: { append: jest.fn() } },
    { provide: TenantContextService, useValue: { runWithoutTenant: (fn: () => unknown) => fn() } },
  ],
  exports: [AuditService, TenantContextService],
})
class FakeAuditModule {}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @td/api test -- kill-gate core-kill-switch.reader`
Expected: FAIL with `Cannot find module './kill-gate'` and `Cannot find module './core-kill-switch.reader'`.

- [ ] **Step 3: Write the gate, the reader and the test setup**

Create `apps/api/src/modules/trade-core/risk-wall/kill-gate.ts`:

```typescript
import { Logger } from '@nestjs/common';

/**
 * The entry gate the old silos call before opening a new position (owner answer 2,
 * decision 21). It never blocks exits, stops or square-offs: only new-entry points
 * call it. Fails closed: an unreadable state, or no reader wired, refuses the entry.
 */
export type GuardedEntry =
  | 'watch-monitor'
  | 'adaptive-stop-track'
  | 'ungated-track'
  | 'sell-futures-track'
  | 'breakout-swing-track'
  | 'anand-dual-track'
  | 'auto-execution'
  | 'auto-trade';

export interface KillSwitchReadPort {
  /** This user's core kill switch is in force on. */
  isOn(userId: string): Promise<boolean>;
  /** Any ADMIN's core kill switch is in force on (the platform-wide silos have no userId). */
  isOnForPlatform(): Promise<boolean>;
  invalidate(): void;
}

export class CoreKillSwitchEntryBlockedError extends Error {
  constructor(
    public readonly entry: GuardedEntry,
    public readonly ref: string | null,
  ) {
    super(`${entry}: new entry${ref ? ` ${ref}` : ''} refused (core kill switch)`);
    this.name = 'CoreKillSwitchEntryBlockedError';
  }
}

const logger = new Logger('CoreKillGate');
let reader: KillSwitchReadPort | null = null;

export function setCoreKillSwitchReader(next: KillSwitchReadPort | null): void {
  reader = next;
}

export function invalidateCoreKillSwitchCache(): void {
  reader?.invalidate();
}

export async function coreEntryAllowed(
  entry: GuardedEntry,
  ctx: { userId?: string | null; ref?: string | null } = {},
): Promise<boolean> {
  let why: string;
  try {
    if (!reader) throw new Error('the kill switch reader is not wired');
    const on = ctx.userId ? await reader.isOn(ctx.userId) : await reader.isOnForPlatform();
    if (!on) return true;
    why = 'the core kill switch is on';
  } catch (err) {
    why = `the core kill switch state cannot be read (${err instanceof Error ? err.message : String(err)}); failing closed`;
  }
  logger.warn(`[${entry}] new entry${ctx.ref ? ` ${ctx.ref}` : ''} refused: ${why}`);
  return false;
}

export async function assertCoreEntryAllowed(
  entry: GuardedEntry,
  ctx: { userId?: string | null; ref?: string | null } = {},
): Promise<void> {
  if (!(await coreEntryAllowed(entry, ctx))) throw new CoreKillSwitchEntryBlockedError(entry, ctx.ref ?? null);
}
```

Note the "not wired" message: `coreEntryAllowed` reports it through the catch, so the log reads
"…cannot be read (the kill switch reader is not wired); failing closed", which the spec matches on
"reader is not wired".

Create `apps/api/src/modules/trade-core/risk-wall/services/core-kill-switch.reader.ts`:

```typescript
import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { TenantContextService } from '../../../../common/tenant/tenant-context.service';
import { setCoreKillSwitchReader, type KillSwitchReadPort } from '../kill-gate';
import { resolveAppendOnly } from '../limits/append-only';

interface SwitchRow {
  id: string;
  userId: string;
  active: boolean;
  effectiveFrom: Date;
  createdAt: Date;
}

/**
 * Cached, read-only view of core kill switches for the silo entry gate (decision 21).
 * Each answer lives at most CACHE_MS; errors are never cached (the gate then refuses).
 */
@Injectable()
export class CoreKillSwitchReader implements KillSwitchReadPort, OnModuleInit, OnModuleDestroy {
  /** Staleness bound for hot paths (owner: ≤ 5 s). Not a risk value. */
  static readonly CACHE_MS = 5_000;

  private readonly cache = new Map<string, { on: boolean; at: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
  ) {}

  onModuleInit(): void {
    setCoreKillSwitchReader(this);
  }

  onModuleDestroy(): void {
    setCoreKillSwitchReader(null);
  }

  invalidate(): void {
    this.cache.clear();
  }

  isOn(userId: string): Promise<boolean> {
    return this.cached(`user:${userId}`, async (now) => {
      const rows = await this.prisma.coreKillSwitch.findMany({
        where: { userId },
        select: { id: true, userId: true, active: true, effectiveFrom: true, createdAt: true },
      });
      return resolveAppendOnly(rows, now).inForce?.active ?? false;
    });
  }

  isOnForPlatform(): Promise<boolean> {
    return this.cached('platform', async (now) => {
      const rows: SwitchRow[] = await this.tenant.runWithoutTenant(() =>
        this.prisma.coreKillSwitch.findMany({
          where: { user: { role: 'ADMIN' } },
          select: { id: true, userId: true, active: true, effectiveFrom: true, createdAt: true },
        }),
      );
      const byUser = new Map<string, SwitchRow[]>();
      for (const r of rows) byUser.set(r.userId, [...(byUser.get(r.userId) ?? []), r]);
      return [...byUser.values()].some((list) => resolveAppendOnly(list, now).inForce?.active === true);
    });
  }

  private async cached(key: string, load: (now: Date) => Promise<boolean>): Promise<boolean> {
    const nowMs = Date.now();
    const hit = this.cache.get(key);
    if (hit && nowMs - hit.at < CoreKillSwitchReader.CACHE_MS) return hit.on;
    const on = await load(new Date(nowMs));
    this.cache.set(key, { on, at: nowMs });
    return on;
  }
}
```

Create `apps/api/test/setup/core-kill-gate.ts`:

```typescript
import { setCoreKillSwitchReader } from '../../src/modules/trade-core/risk-wall/kill-gate';

/**
 * Jest only (apps/api package.json "setupFiles"). Unit tests that do not install their
 * own reader see every core kill switch as OFF, so existing silo specs keep their
 * behaviour. Production has no default: until CoreKillSwitchReader registers on
 * module init, every guarded silo entry is refused (fail closed).
 */
setCoreKillSwitchReader({ isOn: async () => false, isOnForPlatform: async () => false, invalidate: () => undefined });
```

In `apps/api/package.json`, inside `"jest"`, add after `"testEnvironment": "node"` (with a comma on the
line before):

```json
    "setupFiles": ["<rootDir>/../test/setup/core-kill-gate.ts"]
```

In `apps/api/src/modules/trade-core/risk-wall/services/core-kill-switch.service.ts`, add
`import { invalidateCoreKillSwitchCache } from '../kill-gate';` and, directly after the `try { row = … } catch { … }`
block in `set`, before the cascade:

```typescript
    // The silo entry gate caches for ≤ 5 s; a change must be seen at once (decision 21).
    invalidateCoreKillSwitchCache();
```

In `apps/api/src/modules/trade-core/trade-core.module.ts`, add
`import { CoreKillSwitchReader } from './risk-wall/services/core-kill-switch.reader';` and
`CoreKillSwitchReader,` after `CoreKillSwitchService,` in `providers`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @td/api test -- kill-gate core-kill-switch trade-core.module`
Expected: PASS (`kill-gate.spec` 6, `core-kill-switch.reader.spec` 6, `core-kill-switch.service.spec` 12,
`trade-core.module.spec` 2).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/trade-core/risk-wall/kill-gate.ts apps/api/src/modules/trade-core/risk-wall/kill-gate.spec.ts apps/api/src/modules/trade-core/risk-wall/services/core-kill-switch.reader.ts apps/api/src/modules/trade-core/risk-wall/services/core-kill-switch.reader.spec.ts apps/api/src/modules/trade-core/risk-wall/services/core-kill-switch.service.ts apps/api/src/modules/trade-core/trade-core.module.ts apps/api/src/modules/trade-core/trade-core.module.spec.ts apps/api/test/setup/core-kill-gate.ts apps/api/package.json
git commit -m "feat(trade-core): cached, fail-closed kill switch reader and the silo entry gate" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/api/src/modules/trade-core/risk-wall/kill-gate.ts apps/api/src/modules/trade-core/risk-wall/kill-gate.spec.ts apps/api/src/modules/trade-core/risk-wall/services/core-kill-switch.reader.ts apps/api/src/modules/trade-core/risk-wall/services/core-kill-switch.reader.spec.ts apps/api/src/modules/trade-core/risk-wall/services/core-kill-switch.service.ts apps/api/src/modules/trade-core/trade-core.module.ts apps/api/src/modules/trade-core/trade-core.module.spec.ts apps/api/test/setup/core-kill-gate.ts apps/api/package.json
```

---

### Task 13: A kill check at every silo's new-entry point

**Files (each change is an import plus the guard lines shown; nothing else in the silo changes):**
- Modify: `apps/api/src/modules/watch-monitor/services/watch.service.ts` (gated + options watch; `executeEntry`, line 420)
- Modify: `apps/api/src/modules/ungated-track/services/ungated-watch.service.ts` (`createFromAlert`, line 100)
- Modify: `apps/api/src/modules/adaptive-stop-track/services/adaptive-stop-watch.service.ts` (`createFromAlert`, line 166)
- Modify: `apps/api/src/modules/sell-futures-track/services/sell-futures.service.ts` (`createFromAlert`, line 88)
- Modify: `apps/api/src/modules/breakout-swing-track/services/breakout-swing.service.ts` (`createFromAlert`, line 92)
- Modify: `apps/api/src/modules/breakout-swing-track/services/breakout-swing-poller.service.ts` (the fill branch in `fillQueued`, line 125)
- Modify: `apps/api/src/modules/anand-dual-track/services/anand-dual-track.service.ts` (`createEntries`, line 25, after the lead stat at 35-37)
- Modify: `apps/api/src/modules/auto-execution/services/auto-execution.service.ts` (`execute`, line 70)
- Modify: `apps/api/src/modules/auto-trade/services/auto-trade.service.ts` (`processActiveSignals` before the `switch` at line 157; `approveSignal` before `try` at 269; `forceExecuteSignal` before `try` at 347)
- Test: `apps/api/src/modules/trade-core/risk-wall/silo-entry-guards.spec.ts`

**Interfaces:**
- Consumes: `coreEntryAllowed`, `assertCoreEntryAllowed`, `CoreKillSwitchEntryBlockedError`,
  `setCoreKillSwitchReader` (Task 12).
- Produces: no new API. Each guarded path refuses a **new** position while the relevant kill switch is on
  or unreadable, in the way that path already refuses entries: the three `createFromAlert` silos and
  breakout-swing's `createFromAlert` throw (`chartink-process.service.ts` already wraps each silo call in
  its own try/catch and logs it); `executeEntry` and `approveSignal`/`forceExecuteSignal` return `null`
  (their existing "not traded" result); the breakout-swing fill and auto-trade's scan `continue` to the
  next item; anand returns before creating rows; auto-execution uses its existing terminal reject with
  `USER_KILL_SWITCH`.

The seven silos of parent §1 and their guard: gated and options watch (one entry, `WatchService.executeEntry`,
which places both the equity and the F&O leg), ungated, adaptive-stop, sell-futures, breakout-swing (alert
→ resting order, and resting order → fill), anand-dual. Plus the two order paths: auto-execution (per
user) and auto-trade (platform). Exits, stops, trails, EOD square-offs and `closeAllPositions` never call
the gate.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/modules/trade-core/risk-wall/silo-entry-guards.spec.ts`:

```typescript
import { AdaptiveStopWatchService } from '../../adaptive-stop-track/services/adaptive-stop-watch.service';
import { AnandDualTrackService } from '../../anand-dual-track/services/anand-dual-track.service';
import { AutoExecutionService } from '../../auto-execution/services/auto-execution.service';
import { AutoTradeService } from '../../auto-trade/services/auto-trade.service';
import { BreakoutSwingPollerService } from '../../breakout-swing-track/services/breakout-swing-poller.service';
import { BreakoutSwingService } from '../../breakout-swing-track/services/breakout-swing.service';
import { SellFuturesService } from '../../sell-futures-track/services/sell-futures.service';
import { UngatedWatchService } from '../../ungated-track/services/ungated-watch.service';
import { WatchService } from '../../watch-monitor/services/watch.service';
import { CoreKillSwitchEntryBlockedError, setCoreKillSwitchReader, type KillSwitchReadPort } from './kill-gate';

/**
 * Owner answer 2: every silo's new-entry point refuses while the core kill switch is on,
 * and fails closed when it cannot be read. Each block names the entry point it guards.
 * Dependencies are tripwires: touching one past a refusal fails the test, and touching
 * one when the switch is off proves the call went past the guard into unchanged silo code.
 */
const make = (platformOn: boolean | Error, userOn: (u: string) => boolean = () => false) => {
  const r: KillSwitchReadPort & { isOn: jest.Mock; isOnForPlatform: jest.Mock } = {
    isOn: jest.fn(async (u: string) => userOn(u)),
    isOnForPlatform: jest.fn(async () => { if (platformOn instanceof Error) throw platformOn; return platformOn; }),
    invalidate: jest.fn(),
  };
  setCoreKillSwitchReader(r);
  return r;
};
const ON = () => make(true);
const OFF = () => make(false);
const BROKEN = () => make(new Error('db down'));
afterEach(() => { OFF(); });

/** A dependency that fails loudly if touched (except the members given). */
function tripwire(name: string, allowed: Record<string, unknown> = {}): any {
  return new Proxy(allowed, {
    get(target, prop) {
      if (prop in target) return (target as Record<string | symbol, unknown>)[prop];
      if (prop === 'then') return undefined;
      throw new Error(`tripwire: ${name}.${String(prop)} touched`);
    },
  });
}
const deps = (n: number) => Array.from({ length: n }, (_, i) => tripwire(`dep${i}`));
const construct = <T>(C: new (...a: any[]) => T, args: unknown[]): T => new C(...args);

/** The call went past the guard (it may fail later on a tripwire; it was not refused). */
async function pastGuard(p: Promise<unknown>) {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).not.toBeInstanceOf(CoreKillSwitchEntryBlockedError);
}

const alert = { symbol: 'RELIANCE', token: '2885', exchange: 'NSE', side: 'BUY', scannerName: 'Anand 100Hull >200 hull', initialPrice: 2500 } as never;

describe('watch-monitor, gated + options watch: WatchService.executeEntry (watch.service.ts:420)', () => {
  const svc = () => construct(WatchService, deps(8));
  it('refuses while the owner switch is on, touching nothing', async () => {
    const r = ON();
    expect(await svc().executeEntry('we_1')).toBeNull();
    expect(r.isOnForPlatform).toHaveBeenCalled();
  });
  it('fails closed when the switch cannot be read', async () => {
    BROKEN();
    expect(await svc().executeEntry('we_1')).toBeNull();
  });
  it('passes through when off', async () => {
    OFF();
    await expect(svc().executeEntry('we_1')).rejects.toThrow('tripwire: dep0.findById touched');
  });
});

describe.each([
  ['ungated-track: UngatedWatchService.createFromAlert (ungated-watch.service.ts:100)', () => construct(UngatedWatchService, deps(8))],
  ['adaptive-stop-track: AdaptiveStopWatchService.createFromAlert (adaptive-stop-watch.service.ts:166)', () => construct(AdaptiveStopWatchService, deps(8))],
  ['sell-futures-track: SellFuturesService.createFromAlert (sell-futures.service.ts:88)', () => construct(SellFuturesService, deps(8))],
  ['breakout-swing-track: BreakoutSwingService.createFromAlert (breakout-swing.service.ts:92)', () => construct(BreakoutSwingService, deps(4))],
])('%s', (_name, svc) => {
  it('refuses while the owner switch is on, before any silo rule runs', async () => {
    ON();
    await expect((svc() as { createFromAlert(i: never): Promise<unknown> }).createFromAlert(alert)).rejects.toBeInstanceOf(CoreKillSwitchEntryBlockedError);
  });
  it('fails closed when the switch cannot be read', async () => {
    BROKEN();
    await expect((svc() as { createFromAlert(i: never): Promise<unknown> }).createFromAlert(alert)).rejects.toBeInstanceOf(CoreKillSwitchEntryBlockedError);
  });
  it('passes through when off', async () => {
    OFF();
    await pastGuard((svc() as { createFromAlert(i: never): Promise<unknown> }).createFromAlert(alert));
  });
});

describe('breakout-swing-track: the resting-order fill in BreakoutSwingPollerService.fillQueued (breakout-swing-poller.service.ts:125)', () => {
  function poller() {
    const repo = {
      listQueued: jest.fn(async () => [{ id: 'b1', symbol: 'TCS', token: '11536', limitPrice: 100 }]),
      recordTick: jest.fn(async () => undefined),
      fill: jest.fn(async () => undefined),
    };
    const exitPrice = { resolveExitPrices: jest.fn(async () => new Map([['11536', { price: 101, fresh: true }]])) };
    const p = construct(BreakoutSwingPollerService, [repo, exitPrice]);
    const fillQueued = () => (p as unknown as { fillQueued(): Promise<void> }).fillQueued();
    return { repo, fillQueued };
  }
  it('does not fill while the owner switch is on, but still records the price', async () => {
    ON();
    const { repo, fillQueued } = poller();
    await fillQueued();
    expect(repo.fill).not.toHaveBeenCalled();
    expect(repo.recordTick).toHaveBeenCalled();
  });
  it('fails closed when the switch cannot be read', async () => {
    BROKEN();
    const { repo, fillQueued } = poller();
    await fillQueued();
    expect(repo.fill).not.toHaveBeenCalled();
  });
  it('fills as before when off', async () => {
    OFF();
    const { repo, fillQueued } = poller();
    await fillQueued();
    expect(repo.fill).toHaveBeenCalledTimes(1);
  });
});

describe('anand-dual-track: AnandDualTrackService.createEntries (anand-dual-track.service.ts:25)', () => {
  const input = { symbol: 'INFY', token: '1594', hitPrice: 1500, alertId: 'a1', scoreBreakdown: {} } as never;
  const svc = () => {
    const bumpLeadStat = jest.fn(async () => undefined);
    return { bumpLeadStat, s: construct(AnandDualTrackService, [tripwire('repo', { bumpLeadStat })]) };
  };
  it('records the lead stat, then creates no entry while the owner switch is on', async () => {
    ON();
    const { s, bumpLeadStat } = svc();
    await expect(s.createEntries(input)).resolves.toBeUndefined();
    expect(bumpLeadStat).toHaveBeenCalledWith('swing', 'INFY');
  });
  it('fails closed when the switch cannot be read', async () => {
    BROKEN();
    await expect(svc().s.createEntries(input)).resolves.toBeUndefined();
  });
  it('passes through when off', async () => {
    OFF();
    await expect(svc().s.createEntries(input)).rejects.toThrow('tripwire: repo.findActiveTradedBySymbol touched');
  });
});

describe('auto-execution: AutoExecutionService.execute (auto-execution.service.ts:70), per user', () => {
  const job = { userId: 'user_A', signal: { symbol: 'NIFTY', segment: 'INTRADAY' }, idempotencyKey: 'k1' } as never;
  let reject: jest.SpyInstance;
  beforeEach(() => {
    reject = jest.spyOn(AutoExecutionService.prototype as never, 'rejectTerminal' as never).mockResolvedValue(undefined as never);
  });
  afterEach(() => reject.mockRestore());
  const svc = () => construct(AutoExecutionService, deps(12));
  it('refuses with the existing USER_KILL_SWITCH terminal reject while that user’s switch is on', async () => {
    const r = make(false, (u) => u === 'user_A');
    await svc().execute(job);
    expect(r.isOn).toHaveBeenCalledWith('user_A');
    expect(r.isOnForPlatform).not.toHaveBeenCalled();
    expect(reject).toHaveBeenCalledWith('user_A', { symbol: 'NIFTY', segment: 'INTRADAY' }, 'k1', 'USER_KILL_SWITCH');
  });
  it('fails closed when the switch cannot be read', async () => {
    setCoreKillSwitchReader({ isOn: async () => { throw new Error('db down'); }, isOnForPlatform: async () => false, invalidate: () => undefined });
    await svc().execute(job);
    expect(reject).toHaveBeenCalledWith('user_A', expect.anything(), 'k1', 'USER_KILL_SWITCH');
  });
  it('another user’s switch does not block this user', async () => {
    make(true, (u) => u === 'user_B');
    await expect(svc().execute(job)).rejects.toThrow('tripwire: dep0.hasActive touched');
    expect(reject).not.toHaveBeenCalled();
  });
});

describe('auto-trade: AutoTradeService (auto-trade.service.ts:157, :269, :347)', () => {
  const signal = {
    id: 's1', confidenceScore: 80, side: 'BUY', entryPrice: 100, stoplossPrice: 95, targetPrice: 110, strategy: 'x',
    instrument: { symbol: 'RELIANCE', token: '2885', exchange: 'NSE' },
  };
  function svc() {
    const signalRepository = tripwire('signalRepository', {
      getActiveSignals: jest.fn(async () => [signal]),
      getSignalById: jest.fn(async () => ({ ...signal, trades: [] })),
    });
    const settingsService = tripwire('settingsService', { getSettings: jest.fn(async () => ({ autoTradeMode: 'FULLY_AUTOMATIC', maxCapitalPerTrade: 50000 })) });
    const tradeExecutionService = tripwire('tradeExecutionService');
    const s = construct(AutoTradeService, [tripwire('signalGenerator'), signalRepository, tradeExecutionService, tripwire('risk'), settingsService, tripwire('gateway'), tripwire('feed')]);
    return s;
  }
  it('the scan skips every signal while the owner switch is on', async () => {
    ON();
    const stats = await svc().processActiveSignals();
    expect(stats).toMatchObject({ processed: 1, executed: 0, skipped: 1, errors: 0 });
  });
  it('the scan fails closed when the switch cannot be read', async () => {
    BROKEN();
    expect(await svc().processActiveSignals()).toMatchObject({ executed: 0, skipped: 1, errors: 0 });
  });
  it('approval and force-execute return null and keep the approval pending while on', async () => {
    ON();
    const s = svc();
    (s as unknown as { pendingApprovals: Map<string, unknown> }).pendingApprovals.set('s1', { signal, tradeRequest: { symbol: 'RELIANCE' }, timestamp: new Date() });
    expect(await s.approveSignal('s1')).toBeNull();
    expect(s.getPendingApprovals()).toHaveLength(1);
    expect(await s.forceExecuteSignal('s1')).toBeNull();
  });
  it('passes through when off (reaches the trade engine)', async () => {
    OFF();
    const stats = await svc().processActiveSignals();
    expect(stats).toMatchObject({ executed: 0, errors: 1 }); // tradeExecutionService tripwire, caught by the scan loop
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @td/api test -- silo-entry-guards`
Expected: FAIL: the "refuses" and "fails closed" cases fail (no guard yet; the calls run into the
tripwires), the "passes through" cases pass.

- [ ] **Step 3: Insert the guards (exactly these lines; nothing else in the silos)**

`apps/api/src/modules/watch-monitor/services/watch.service.ts` — add to the imports
`import { coreEntryAllowed } from '../../trade-core/risk-wall/kill-gate';` and make these the first lines of
`executeEntry` (before `const mode = options.mode ?? 'paper';`, line 424):

```typescript
    // SP2 M2 (owner answer 2): no new position while the owner's core kill switch is on.
    // Fails closed. Exits, stops and square-offs never pass through here.
    if (!(await coreEntryAllowed('watch-monitor', { ref: entryId }))) return null;
```

`apps/api/src/modules/ungated-track/services/ungated-watch.service.ts` — add
`import { assertCoreEntryAllowed } from '../../trade-core/risk-wall/kill-gate';` and make this the first
line of `createFromAlert` (line 100, before the Hull gate):

```typescript
    // SP2 M2 (owner answer 2): no new entry while the owner's core kill switch is on (fails closed).
    await assertCoreEntryAllowed('ungated-track', { ref: input.symbol });
```

`apps/api/src/modules/adaptive-stop-track/services/adaptive-stop-watch.service.ts` — same import; first line
of `createFromAlert` (line 166, before the BUY-only gate):

```typescript
    // SP2 M2 (owner answer 2): no new entry while the owner's core kill switch is on (fails closed).
    await assertCoreEntryAllowed('adaptive-stop-track', { ref: input.symbol });
```

`apps/api/src/modules/sell-futures-track/services/sell-futures.service.ts` — same import; first line of
`createFromAlert` (line 88, before Gate 1):

```typescript
    // SP2 M2 (owner answer 2): no new entry while the owner's core kill switch is on (fails closed).
    await assertCoreEntryAllowed('sell-futures-track', { ref: input.symbol });
```

`apps/api/src/modules/breakout-swing-track/services/breakout-swing.service.ts` — same import; first line of
`createFromAlert` (line 92, before `const { symbol } = input;`):

```typescript
    // SP2 M2 (owner answer 2): no new resting order while the owner's core kill switch is on (fails closed).
    await assertCoreEntryAllowed('breakout-swing-track', { ref: input.symbol });
```

`apps/api/src/modules/breakout-swing-track/services/breakout-swing-poller.service.ts` — add
`import { coreEntryAllowed } from '../../trade-core/risk-wall/kill-gate';` and make this the first line inside
`if (ltp >= entry.limitPrice) {` (line 125):

```typescript
        // SP2 M2 (owner answer 2): a resting order does not fill while the owner's core kill switch is on.
        if (!(await coreEntryAllowed('breakout-swing-track', { ref: entry.symbol }))) continue;
```

`apps/api/src/modules/anand-dual-track/services/anand-dual-track.service.ts` — add
`import { coreEntryAllowed } from '../../trade-core/risk-wall/kill-gate';` and, directly after the
`bumpLeadStat(...).catch(...)` statement (lines 35-37):

```typescript
    // SP2 M2 (owner answer 2): no new entry (and so no fan-out) while the owner's core kill switch is on.
    if (!(await coreEntryAllowed('anand-dual-track', { ref: input.symbol }))) return;
```

`apps/api/src/modules/auto-execution/services/auto-execution.service.ts` — add
`import { coreEntryAllowed } from '../../trade-core/risk-wall/kill-gate';` and, directly after
`const { userId, signal, idempotencyKey } = job;` (line 71):

```typescript
    // SP2 M2 (owner answer 2): this user's core kill switch blocks new auto entries (fails closed).
    if (!(await coreEntryAllowed('auto-execution', { userId, ref: signal.symbol }))) {
      return this.rejectTerminal(userId, signal, idempotencyKey, 'USER_KILL_SWITCH');
    }
```

`apps/api/src/modules/auto-trade/services/auto-trade.service.ts` — add
`import { coreEntryAllowed } from '../../trade-core/risk-wall/kill-gate';`; in `processActiveSignals`, directly
before `switch (settings.autoTradeMode) {` (line 157):

```typescript
        // SP2 M2 (owner answer 2): no new entry while the owner's core kill switch is on (fails closed).
        if (!(await coreEntryAllowed('auto-trade', { ref: tradeRequest.symbol }))) {
          stats.skipped++;
          continue;
        }
```

in `approveSignal`, directly before its `try {` (line 269):

```typescript
    if (!(await coreEntryAllowed('auto-trade', { ref: entry.tradeRequest.symbol }))) return null;
```

and in `forceExecuteSignal`, directly before its `try {` (line 347):

```typescript
    if (!(await coreEntryAllowed('auto-trade', { ref: tradeRequest.symbol }))) return null;
```

- [ ] **Step 4: Run the guard spec and every touched silo's own specs**

Run: `pnpm --filter @td/api test -- silo-entry-guards`
Expected: PASS (28 tests).
Run: `pnpm --filter @td/api test -- watch-monitor ungated-track adaptive-stop-track sell-futures-track breakout-swing-track anand-dual-track auto-execution auto-trade chartink`
Expected: PASS with the same counts as on `main` (the Jest setup file gives every existing spec an "off"
reader). A failing silo spec here means a guard changed behaviour beyond refusing entries: fix the guard
placement, never the silo spec.

- [ ] **Step 5: Confirm the silo diffs are insertions only, then commit**

Run: `git diff --numstat -- apps/api/src/modules/watch-monitor apps/api/src/modules/ungated-track apps/api/src/modules/adaptive-stop-track apps/api/src/modules/sell-futures-track apps/api/src/modules/breakout-swing-track apps/api/src/modules/anand-dual-track apps/api/src/modules/auto-execution apps/api/src/modules/auto-trade`
Expected: exactly the 9 files above, each with `0` in the deletions column.

```bash
git add apps/api/src/modules/watch-monitor/services/watch.service.ts apps/api/src/modules/ungated-track/services/ungated-watch.service.ts apps/api/src/modules/adaptive-stop-track/services/adaptive-stop-watch.service.ts apps/api/src/modules/sell-futures-track/services/sell-futures.service.ts apps/api/src/modules/breakout-swing-track/services/breakout-swing.service.ts apps/api/src/modules/breakout-swing-track/services/breakout-swing-poller.service.ts apps/api/src/modules/anand-dual-track/services/anand-dual-track.service.ts apps/api/src/modules/auto-execution/services/auto-execution.service.ts apps/api/src/modules/auto-trade/services/auto-trade.service.ts apps/api/src/modules/trade-core/risk-wall/silo-entry-guards.spec.ts
git commit -m "feat(silos): refuse new entries while the core kill switch is on (fail closed)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/api/src/modules/watch-monitor/services/watch.service.ts apps/api/src/modules/ungated-track/services/ungated-watch.service.ts apps/api/src/modules/adaptive-stop-track/services/adaptive-stop-watch.service.ts apps/api/src/modules/sell-futures-track/services/sell-futures.service.ts apps/api/src/modules/breakout-swing-track/services/breakout-swing.service.ts apps/api/src/modules/breakout-swing-track/services/breakout-swing-poller.service.ts apps/api/src/modules/anand-dual-track/services/anand-dual-track.service.ts apps/api/src/modules/auto-execution/services/auto-execution.service.ts apps/api/src/modules/auto-trade/services/auto-trade.service.ts apps/api/src/modules/trade-core/risk-wall/silo-entry-guards.spec.ts
```

---

### Task 14: Web wire client and pure Risk page logic

**Files:**
- Create: `apps/web/src/services/coreRisk.ts`
- Create: `apps/web/src/pages/core-risk/core-risk.ts`
- Test: `apps/web/src/services/coreRisk.spec.ts`
- Test: `apps/web/src/pages/core-risk/core-risk.spec.ts`

**Interfaces:**
- Consumes: `api` (`apps/web/src/services/api.ts`, baseURL `/api`, timeout 30 s); the wire shapes of
  Tasks 6, 8 and 10.
- Produces:

```typescript
// services/coreRisk.ts
export type CoreLimitKind = 'rupees' | 'count' | 'ratio' | 'hhmm' | 'enum';
export interface CoreRiskLimitView { key; scope; kind; tighter; value: number | string | null; source; needsReview; effectiveFrom; setAt; setBy; reason; pending: CorePendingLimitView | null }
export interface CoreLimitChangeResult { limit: CoreRiskLimitView; direction: 'TIGHTER' | 'SAME' | 'LOOSER'; effectiveFrom: string }
export interface CoreKillSwitchView { active; since; reason; setBy; pendingRelease }
export interface CoreKillSwitchCascade { core: { status; detail }; silos: CoreSiloResult[] }
export interface CoreKillSwitchSetResult { state: CoreKillSwitchView; effectiveFrom: string; cascade: CoreKillSwitchCascade | null }
export function listCoreRiskLimits(): Promise<CoreRiskLimitView[]>;
export function changeCoreRiskLimit(key: string, scope: string, body: { value: number | string; reason: string }): Promise<CoreLimitChangeResult>;
export function getCoreKillSwitch(): Promise<CoreKillSwitchView>;
export function setCoreKillSwitch(body: { active: boolean; reason: string }): Promise<CoreKillSwitchSetResult>;   // 120 s timeout

// pages/core-risk/core-risk.ts
export type Parsed<T>;  export const DAILY_LOSS_ACTION_OPTIONS;  export const KILL_CONFIRM_WORD = 'KILL';
export function limitLabel(key: string): string;  export function scopeLabel(scope: string): string;
export function formatIst(iso: string): string;   // "Tue 13 Oct, 09:15 IST"
export function formatLimitValue(kind: CoreLimitKind, value: number | string | null): string;
export interface LimitRow { id; key; scope; label; scopeLabel; valueText; badge: 'missing' | 'pending' | 'review' | null; pendingText: string | null; note: string | null }
export function limitRows(views: readonly CoreRiskLimitView[]): LimitRow[];
export function editText(view: CoreRiskLimitView): string;
export function parseLimitInput(kind: CoreLimitKind, text: string): Parsed<number | string>;
export function previewDirection(view: CoreRiskLimitView, value: number | string): 'TIGHTER' | 'SAME' | 'LOOSER';
export function changeHint(view: CoreRiskLimitView, value: number | string): string;
export function validReason(reason: string): Parsed<string>;
export function limitChangePayload(view: CoreRiskLimitView, text: string, reason: string): Parsed<{ value: number | string; reason: string }>;
export function changeResultMessage(r: CoreLimitChangeResult): string;
export function killSwitchSummary(k: CoreKillSwitchView): { headline: string; tone: 'danger' | 'ok'; detail: string | null; releaseText: string | null };
export function killSwitchPayload(turnOn: boolean, reason: string, confirmText: string): Parsed<{ active: boolean; reason: string }>;
export function cascadeLines(c: CoreKillSwitchCascade | null): Array<{ text: string; tone: 'ok' | 'warn' | 'danger' | 'muted' }>;
```

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/services/coreRisk.spec.ts`:

```typescript
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('./api', () => ({ default: { get: vi.fn(), put: vi.fn(), post: vi.fn() } }));

import api from './api';
import { changeCoreRiskLimit, getCoreKillSwitch, listCoreRiskLimits, setCoreKillSwitch } from './coreRisk';

describe('coreRisk wire client', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reads the caller’s limits and kill switch from the kebab-case routes', async () => {
    (api.get as Mock).mockResolvedValueOnce({ data: { limits: [{ key: 'maxDailyLoss' }] } });
    expect(await listCoreRiskLimits()).toEqual([{ key: 'maxDailyLoss' }]);
    expect(api.get).toHaveBeenLastCalledWith('/trade-core/risk/limits');
    (api.get as Mock).mockResolvedValueOnce({ data: { active: false } });
    expect(await getCoreKillSwitch()).toEqual({ active: false });
    expect(api.get).toHaveBeenLastCalledWith('/trade-core/risk/kill-switch');
  });

  it('PUTs a limit change by key and scope (encoded) and POSTs the kill switch with a long timeout', async () => {
    (api.put as Mock).mockResolvedValueOnce({ data: { direction: 'TIGHTER' } });
    await changeCoreRiskLimit('maxOpenPositions', 'OPTIONS/BUY', { value: 2, reason: 'fewer' });
    expect(api.put).toHaveBeenCalledWith('/trade-core/risk/limits/maxOpenPositions/OPTIONS%2FBUY', { value: 2, reason: 'fewer' });
    (api.post as Mock).mockResolvedValueOnce({ data: { cascade: null } });
    await setCoreKillSwitch({ active: true, reason: 'stop' });
    expect(api.post).toHaveBeenCalledWith('/trade-core/risk/kill-switch', { active: true, reason: 'stop' }, { timeout: 120_000 });
  });
});
```

Create `apps/web/src/pages/core-risk/core-risk.spec.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import type { CoreKillSwitchView, CoreLimitChangeResult, CoreRiskLimitView } from '@/services/coreRisk';
import {
  cascadeLines,
  changeHint,
  changeResultMessage,
  editText,
  formatIst,
  formatLimitValue,
  killSwitchPayload,
  killSwitchSummary,
  limitChangePayload,
  limitRows,
  parseLimitInput,
  previewDirection,
  validReason,
} from './core-risk';

const NEXT_OPEN = '2026-10-13T03:45:00.000Z';

function view(over: Partial<CoreRiskLimitView> = {}): CoreRiskLimitView {
  return {
    key: 'maxDailyLoss', scope: 'ALL', kind: 'rupees', tighter: 'lower', value: 5000, source: 'USER', needsReview: false,
    effectiveFrom: '2026-10-09T03:45:00.000Z', setAt: '2026-10-09T03:45:00.000Z', setBy: 'user_A', reason: 'mine', pending: null, ...over,
  };
}

function ks(over: Partial<CoreKillSwitchView> = {}): CoreKillSwitchView {
  return { active: false, since: null, reason: null, setBy: null, pendingRelease: null, ...over };
}

describe('formatting', () => {
  it('shows times in IST and values by kind', () => {
    expect(formatIst(NEXT_OPEN)).toBe('Tue 13 Oct, 09:15 IST');
    expect(formatLimitValue('rupees', 1000000)).toBe('₹10,00,000');
    expect(formatLimitValue('rupees', 2500.5)).toBe('₹2,500.5');
    expect(formatLimitValue('count', 5)).toBe('5');
    expect(formatLimitValue('ratio', 2)).toBe('2×');
    expect(formatLimitValue('hhmm', '15:00')).toBe('15:00 IST');
    expect(formatLimitValue('enum', 'BLOCK_AND_SQUARE_OFF')).toBe('Block entries and square off');
    expect(formatLimitValue('rupees', null)).toBe('not set');
  });
});

describe('limitRows', () => {
  it('badges a pending loosening with its effective time, a default for review, and a missing limit', () => {
    const rows = limitRows([
      view({ pending: { value: 8000, effectiveFrom: NEXT_OPEN, setAt: NEXT_OPEN, reason: 'more room' } }),
      view({ key: 'maxTradesPerDay', kind: 'count', value: 20, source: 'DEFAULT', needsReview: true, reason: 'default — please review (x)' }),
      view({ key: 'maxOpenPositions', scope: 'MTF', kind: 'count', value: null, source: null }),
      view({ key: 'maxOpenPositions', scope: 'ALL', kind: 'count', value: 8, source: 'USER_SETTINGS' }),
    ]);
    expect(rows.map((r) => [r.id, r.label, r.scopeLabel, r.valueText, r.badge])).toEqual([
      ['maxDailyLoss@ALL', 'Max daily loss (realised + open)', 'All vehicles', '₹5,000', 'pending'],
      ['maxTradesPerDay@ALL', 'Max entries per day', 'All vehicles', '20', 'review'],
      ['maxOpenPositions@MTF', 'Max open positions', 'MTF', 'not set', 'missing'],
      ['maxOpenPositions@ALL', 'Max open positions', 'All vehicles', '8', null],
    ]);
    expect(rows[0].pendingText).toBe('→ ₹8,000 from Tue 13 Oct, 09:15 IST');
    expect(rows[1].note).toBe('Default — please review');
    expect(rows[2].note).toBe('Not set: entries that need it are rejected');
    expect(rows[3].note).toBe('Copied from settings');
  });

  it('a default that is also pending shows the pending badge', () => {
    const [row] = limitRows([view({ source: 'DEFAULT', needsReview: true, pending: { value: 6000, effectiveFrom: NEXT_OPEN, setAt: NEXT_OPEN, reason: 'r' } })]);
    expect(row.badge).toBe('pending');
  });
});

describe('editing a limit', () => {
  it('starts from the value in force', () => {
    expect(editText(view())).toBe('5000');
    expect(editText(view({ kind: 'hhmm', value: '15:00' }))).toBe('15:00');
    expect(editText(view({ value: null }))).toBe('');
  });

  it('parses input per kind', () => {
    expect(parseLimitInput('rupees', '₹ 5,000.50')).toEqual({ ok: true, value: 5000.5 });
    expect(parseLimitInput('rupees', '10,00,000')).toEqual({ ok: true, value: 1000000 });
    expect(parseLimitInput('rupees', '5000.123').ok).toBe(false);
    expect(parseLimitInput('rupees', '').ok).toBe(false);
    expect(parseLimitInput('count', '12')).toEqual({ ok: true, value: 12 });
    expect(parseLimitInput('count', '1.5').ok).toBe(false);
    expect(parseLimitInput('ratio', '2.5')).toEqual({ ok: true, value: 2.5 });
    expect(parseLimitInput('ratio', '0.5').ok).toBe(false);
    expect(parseLimitInput('hhmm', '14:45')).toEqual({ ok: true, value: '14:45' });
    expect(parseLimitInput('hhmm', '2:45pm').ok).toBe(false);
    expect(parseLimitInput('enum', 'BLOCK_AND_SQUARE_OFF')).toEqual({ ok: true, value: 'BLOCK_AND_SQUARE_OFF' });
    expect(parseLimitInput('enum', 'PANIC').ok).toBe(false);
  });

  it('previews the direction the server will apply (D5)', () => {
    expect(previewDirection(view(), 4000)).toBe('TIGHTER');
    expect(previewDirection(view(), 5000)).toBe('SAME');
    expect(previewDirection(view(), 6000)).toBe('LOOSER');
    expect(previewDirection(view({ kind: 'hhmm', tighter: 'earlier', value: '15:00' }), '14:30')).toBe('TIGHTER');
    expect(previewDirection(view({ kind: 'enum', tighter: 'stricter', value: 'BLOCK_ENTRIES' }), 'BLOCK_AND_SQUARE_OFF')).toBe('TIGHTER');
    expect(previewDirection(view({ value: null }), 1)).toBe('LOOSER');
    expect(changeHint(view(), 4000)).toBe('Tighter: takes effect immediately.');
    expect(changeHint(view(), 5000)).toBe('Same as now: takes effect immediately and cancels any pending change.');
    expect(changeHint(view(), 6000)).toBe('Looser: takes effect at the next session open.');
  });

  it('needs a valid value and a 3–500 character reason before sending', () => {
    expect(validReason('  ok  ')).toEqual({ ok: false, error: 'Give a reason (3 to 500 characters)' });
    expect(validReason(' fine ')).toEqual({ ok: true, value: 'fine' });
    expect(limitChangePayload(view(), '4,000', ' bad week ')).toEqual({ ok: true, value: { value: 4000, reason: 'bad week' } });
    expect(limitChangePayload(view(), 'four', 'bad week').ok).toBe(false);
    expect(limitChangePayload(view(), '4000', 'no').ok).toBe(false);
  });

  it('words the result: now for tighter or same, the effective time for looser', () => {
    const tighter: CoreLimitChangeResult = { limit: view({ value: 4000 }), direction: 'TIGHTER', effectiveFrom: '2026-10-12T05:00:00.000Z' };
    expect(changeResultMessage(tighter)).toBe('Max daily loss (realised + open) (All vehicles) is now ₹4,000');
    const looser: CoreLimitChangeResult = {
      limit: view({ pending: { value: 8000, effectiveFrom: NEXT_OPEN, setAt: NEXT_OPEN, reason: 'r' } }), direction: 'LOOSER', effectiveFrom: NEXT_OPEN,
    };
    expect(changeResultMessage(looser)).toBe('Max daily loss (realised + open) (All vehicles) becomes ₹8,000 at Tue 13 Oct, 09:15 IST');
  });
});

describe('kill switch', () => {
  it('summarises on, off and a scheduled release', () => {
    expect(killSwitchSummary(ks())).toEqual({ headline: 'Kill switch off', tone: 'ok', detail: null, releaseText: null });
    expect(killSwitchSummary(ks({ active: true, since: '2026-10-12T05:00:00.000Z', reason: 'crash' }))).toEqual({
      headline: 'Kill switch ON: every core entry is blocked', tone: 'danger', detail: 'since Mon 12 Oct, 10:30 IST · crash', releaseText: null,
    });
    expect(killSwitchSummary(ks({ active: true, since: '2026-10-12T05:00:00.000Z', reason: 'crash', pendingRelease: { effectiveFrom: NEXT_OPEN, reason: 'calm', setAt: NEXT_OPEN } })).releaseText).toBe(
      'Release scheduled for Tue 13 Oct, 09:15 IST (calm)',
    );
  });

  it('turning on needs a reason and the typed confirmation; turning off needs only a reason', () => {
    expect(killSwitchPayload(true, 'market crash', 'kill')).toEqual({ ok: true, value: { active: true, reason: 'market crash' } });
    expect(killSwitchPayload(true, 'market crash', 'yes')).toEqual({ ok: false, error: 'Type KILL to confirm' });
    expect(killSwitchPayload(true, 'no', 'KILL').ok).toBe(false);
    expect(killSwitchPayload(false, 'calm again', '')).toEqual({ ok: true, value: { active: false, reason: 'calm again' } });
  });

  it('lists each cascade step with a tone that never hides a failure', () => {
    expect(cascadeLines(null)).toEqual([]);
    expect(
      cascadeLines({
        core: { status: 'OK', detail: 'no core orders or positions exist yet' },
        silos: [
          { target: 'auto-execution', status: 'OK', detail: 'set' },
          { target: 'watch-monitor', status: 'FAILED', detail: '1 errors' },
          { target: 'sell-futures-track', status: 'UNAVAILABLE', detail: 'not loaded' },
          { target: 'trade-engine', status: 'SKIPPED', detail: 'owner only' },
        ],
      }),
    ).toEqual([
      { text: 'Core: no core orders or positions exist yet', tone: 'ok' },
      { text: 'Auto-execution: OK · set', tone: 'ok' },
      { text: 'Watch monitor: FAILED · 1 errors', tone: 'danger' },
      { text: 'Sell-futures silo: UNAVAILABLE · not loaded', tone: 'warn' },
      { text: 'Trade engine: SKIPPED · owner only', tone: 'muted' },
    ]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @td/web test -- coreRisk core-risk`
Expected: FAIL with `Failed to resolve import "./coreRisk"` and `Failed to resolve import "./core-risk"`.

- [ ] **Step 3: Write the wire client and the logic**

Create `apps/web/src/services/coreRisk.ts`:

```typescript
import api from './api';

/**
 * SP2 M2: the caller's Risk Wall limits and kill switch. Mirrors the API's wire shapes in
 * apps/api/src/modules/trade-core/risk-wall/services/{core-risk-limit,core-kill-switch}.service.ts
 * (the API does not import @td/shared; M1 plan decision 13).
 */
export type CoreLimitScope = 'ALL' | 'CASH_INTRADAY' | 'MTF' | 'OPTIONS_BUY';
export type CoreLimitKind = 'rupees' | 'count' | 'ratio' | 'hhmm' | 'enum';
export type CoreLimitSource = 'USER' | 'USER_SETTINGS' | 'DEFAULT';

export interface CorePendingLimitView {
  value: number | string;
  effectiveFrom: string;
  setAt: string;
  reason: string;
}

export interface CoreRiskLimitView {
  key: string;
  scope: CoreLimitScope;
  kind: CoreLimitKind;
  tighter: 'lower' | 'earlier' | 'stricter';
  value: number | string | null;
  source: CoreLimitSource | null;
  needsReview: boolean;
  effectiveFrom: string | null;
  setAt: string | null;
  setBy: string | null;
  reason: string | null;
  pending: CorePendingLimitView | null;
}

export interface CoreLimitChangeResult {
  limit: CoreRiskLimitView;
  direction: 'TIGHTER' | 'SAME' | 'LOOSER';
  effectiveFrom: string;
}

export interface CoreKillSwitchView {
  active: boolean;
  since: string | null;
  reason: string | null;
  setBy: string | null;
  pendingRelease: { effectiveFrom: string; reason: string; setAt: string } | null;
}

export interface CoreSiloResult {
  target: string;
  status: 'OK' | 'FAILED' | 'SKIPPED' | 'UNAVAILABLE';
  detail: string;
}

export interface CoreKillSwitchCascade {
  core: { status: 'OK' | 'FAILED'; detail: string };
  silos: CoreSiloResult[];
}

export interface CoreKillSwitchSetResult {
  state: CoreKillSwitchView;
  effectiveFrom: string;
  cascade: CoreKillSwitchCascade | null;
}

/** The silo square-offs can take longer than the client's default 30 s. */
const KILL_SWITCH_TIMEOUT_MS = 120_000;

export async function listCoreRiskLimits(): Promise<CoreRiskLimitView[]> {
  const r = await api.get<{ limits: CoreRiskLimitView[] }>('/trade-core/risk/limits');
  return r.data.limits;
}

export async function changeCoreRiskLimit(key: string, scope: string, body: { value: number | string; reason: string }): Promise<CoreLimitChangeResult> {
  const r = await api.put<CoreLimitChangeResult>(`/trade-core/risk/limits/${encodeURIComponent(key)}/${encodeURIComponent(scope)}`, body);
  return r.data;
}

export async function getCoreKillSwitch(): Promise<CoreKillSwitchView> {
  const r = await api.get<CoreKillSwitchView>('/trade-core/risk/kill-switch');
  return r.data;
}

export async function setCoreKillSwitch(body: { active: boolean; reason: string }): Promise<CoreKillSwitchSetResult> {
  const r = await api.post<CoreKillSwitchSetResult>('/trade-core/risk/kill-switch', body, { timeout: KILL_SWITCH_TIMEOUT_MS });
  return r.data;
}
```

Create `apps/web/src/pages/core-risk/core-risk.ts`:

```typescript
import type {
  CoreKillSwitchCascade,
  CoreKillSwitchView,
  CoreLimitChangeResult,
  CoreLimitKind,
  CoreRiskLimitView,
} from '@/services/coreRisk';

/** Pure logic for the Core Risk page (spec §8.4). The server decides; these functions only parse, preview and word. */
export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const LIMIT_LABELS: Record<string, string> = {
  maxDailyLoss: 'Max daily loss (realised + open)',
  maxDailyLossPerStrategy: 'Max daily loss per strategy',
  maxTradesPerDay: 'Max entries per day',
  maxOpenPositions: 'Max open positions',
  maxRiskPerTrade: 'Max risk per trade',
  maxCapitalDeployed: 'Max capital deployed',
  mtfMaxLeverage: 'MTF max leverage',
  mtfMaxHoldDays: 'MTF max hold days',
  optionsMaxPremiumPerTrade: 'Max option premium per trade',
  lastEntryTime: 'Last entry time',
  squareOffTime: 'Square-off time',
  dailyLossAction: 'When the daily loss is hit',
};

const SCOPE_LABELS: Record<string, string> = {
  ALL: 'All vehicles',
  CASH_INTRADAY: 'Cash intraday',
  MTF: 'MTF',
  OPTIONS_BUY: 'Options buying',
};

const SILO_LABELS: Record<string, string> = {
  'auto-execution': 'Auto-execution',
  'watch-monitor': 'Watch monitor',
  'adaptive-stop-track': 'Adaptive-Stop silo',
  'ungated-track': 'Ungated silo',
  'sell-futures-track': 'Sell-futures silo',
  'trade-engine': 'Trade engine',
};

/** Loosest first, as the API orders them. */
export const DAILY_LOSS_ACTION_OPTIONS = [
  { value: 'BLOCK_ENTRIES', label: 'Block new entries' },
  { value: 'BLOCK_AND_SQUARE_OFF', label: 'Block entries and square off' },
] as const;

export const KILL_CONFIRM_WORD = 'KILL';

export const limitLabel = (key: string): string => LIMIT_LABELS[key] ?? key;
export const scopeLabel = (scope: string): string => SCOPE_LABELS[scope] ?? scope;

const pad = (n: number) => String(n).padStart(2, '0');
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Tue 13 Oct, 09:15 IST", whatever the browser's time zone. */
export function formatIst(iso: string): string {
  const d = new Date(new Date(iso).getTime() + 5.5 * 60 * 60 * 1000);
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} IST`;
}

export function formatLimitValue(kind: CoreLimitKind, value: number | string | null): string {
  if (value === null) return 'not set';
  switch (kind) {
    case 'rupees':
      return typeof value === 'number' ? `₹${value.toLocaleString('en-IN', { maximumFractionDigits: 2 })}` : String(value);
    case 'count':
      return String(value);
    case 'ratio':
      return `${value}×`;
    case 'hhmm':
      return `${value} IST`;
    case 'enum':
      return DAILY_LOSS_ACTION_OPTIONS.find((o) => o.value === value)?.label ?? String(value);
  }
}

export type LimitBadge = 'missing' | 'pending' | 'review' | null;

export interface LimitRow {
  id: string;
  key: string;
  scope: string;
  label: string;
  scopeLabel: string;
  valueText: string;
  badge: LimitBadge;
  /** "→ ₹8,000 from Tue 13 Oct, 09:15 IST" for a pending loosening. */
  pendingText: string | null;
  note: string | null;
}

export function limitRows(views: readonly CoreRiskLimitView[]): LimitRow[] {
  return views.map((v) => ({
    id: `${v.key}@${v.scope}`,
    key: v.key,
    scope: v.scope,
    label: limitLabel(v.key),
    scopeLabel: scopeLabel(v.scope),
    valueText: formatLimitValue(v.kind, v.value),
    badge: v.value === null ? 'missing' : v.pending ? 'pending' : v.needsReview ? 'review' : null,
    pendingText: v.pending ? `→ ${formatLimitValue(v.kind, v.pending.value)} from ${formatIst(v.pending.effectiveFrom)}` : null,
    note:
      v.value === null
        ? 'Not set: entries that need it are rejected'
        : v.needsReview
          ? 'Default — please review'
          : v.source === 'USER_SETTINGS'
            ? 'Copied from settings'
            : v.reason,
  }));
}

export function editText(view: CoreRiskLimitView): string {
  return view.value === null ? '' : String(view.value);
}

export function parseLimitInput(kind: CoreLimitKind, text: string): Parsed<number | string> {
  const t = text.trim();
  switch (kind) {
    case 'rupees': {
      const c = t.replace(/[₹,\s]/g, '');
      if (!/^\d+(\.\d{1,2})?$/.test(c)) return { ok: false, error: 'Enter a rupee amount like 5000 or 5,000.50' };
      if (c.split('.')[0].replace(/^0+(?=\d)/, '').length > 12) return { ok: false, error: 'The amount must be below ₹10,00,00,00,00,000' };
      return { ok: true, value: Number(c) };
    }
    case 'count':
      return /^\d{1,12}$/.test(t) ? { ok: true, value: Number(t) } : { ok: false, error: 'Enter a whole number' };
    case 'ratio':
      return /^\d+(\.\d{1,2})?$/.test(t) && Number(t) >= 1 ? { ok: true, value: Number(t) } : { ok: false, error: 'Enter a leverage of 1 or more, like 2 or 2.5' };
    case 'hhmm':
      return /^([01]\d|2[0-3]):[0-5]\d$/.test(t) ? { ok: true, value: t } : { ok: false, error: 'Enter an IST time as HH:MM, like 15:00' };
    case 'enum':
      return DAILY_LOSS_ACTION_OPTIONS.some((o) => o.value === t) ? { ok: true, value: t } : { ok: false, error: 'Pick an action' };
  }
}

const minutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};
const actionRank = (v: string) => DAILY_LOSS_ACTION_OPTIONS.findIndex((o) => o.value === v);

/** A preview of the API's compareLimit (D5). The server decides; this only words the hint. */
export function previewDirection(view: CoreRiskLimitView, value: number | string): 'TIGHTER' | 'SAME' | 'LOOSER' {
  if (view.value === null) return 'LOOSER';
  let diff: number;
  if (view.kind === 'hhmm') diff = minutes(String(value)) - minutes(String(view.value));
  else if (view.kind === 'enum') diff = actionRank(String(view.value)) - actionRank(String(value));
  else diff = Number(value) - Number(view.value);
  return diff < 0 ? 'TIGHTER' : diff === 0 ? 'SAME' : 'LOOSER';
}

export function changeHint(view: CoreRiskLimitView, value: number | string): string {
  switch (previewDirection(view, value)) {
    case 'TIGHTER':
      return 'Tighter: takes effect immediately.';
    case 'SAME':
      return 'Same as now: takes effect immediately and cancels any pending change.';
    default:
      return 'Looser: takes effect at the next session open.';
  }
}

/** Mirrors the API's isReason: 3+ characters after trimming, at most 500 as typed. */
export function validReason(reason: string): Parsed<string> {
  const r = reason.trim();
  return r.length >= 3 && reason.length <= 500 ? { ok: true, value: r } : { ok: false, error: 'Give a reason (3 to 500 characters)' };
}

export function limitChangePayload(view: CoreRiskLimitView, text: string, reason: string): Parsed<{ value: number | string; reason: string }> {
  const v = parseLimitInput(view.kind, text);
  if (!v.ok) return v;
  const r = validReason(reason);
  if (!r.ok) return r;
  return { ok: true, value: { value: v.value, reason: r.value } };
}

export function changeResultMessage(r: CoreLimitChangeResult): string {
  const name = `${limitLabel(r.limit.key)} (${scopeLabel(r.limit.scope)})`;
  if (r.direction === 'LOOSER' && r.limit.pending) {
    return `${name} becomes ${formatLimitValue(r.limit.kind, r.limit.pending.value)} at ${formatIst(r.effectiveFrom)}`;
  }
  return `${name} is now ${formatLimitValue(r.limit.kind, r.limit.value)}`;
}

export interface KillSwitchSummary {
  headline: string;
  tone: 'danger' | 'ok';
  detail: string | null;
  releaseText: string | null;
}

export function killSwitchSummary(k: CoreKillSwitchView): KillSwitchSummary {
  if (!k.active) return { headline: 'Kill switch off', tone: 'ok', detail: k.reason ? `last change: ${k.reason}` : null, releaseText: null };
  const detail = [k.since ? `since ${formatIst(k.since)}` : null, k.reason].filter((x): x is string => !!x).join(' · ');
  return {
    headline: 'Kill switch ON: every core entry is blocked',
    tone: 'danger',
    detail: detail || null,
    releaseText: k.pendingRelease ? `Release scheduled for ${formatIst(k.pendingRelease.effectiveFrom)} (${k.pendingRelease.reason})` : null,
  };
}

export function killSwitchPayload(turnOn: boolean, reason: string, confirmText: string): Parsed<{ active: boolean; reason: string }> {
  const r = validReason(reason);
  if (!r.ok) return r;
  if (turnOn && confirmText.trim().toUpperCase() !== KILL_CONFIRM_WORD) return { ok: false, error: `Type ${KILL_CONFIRM_WORD} to confirm` };
  return { ok: true, value: { active: turnOn, reason: r.value } };
}

export interface CascadeLine {
  text: string;
  tone: 'ok' | 'warn' | 'danger' | 'muted';
}

const SILO_TONE = { OK: 'ok', FAILED: 'danger', UNAVAILABLE: 'warn', SKIPPED: 'muted' } as const;

export function cascadeLines(c: CoreKillSwitchCascade | null): CascadeLine[] {
  if (!c) return [];
  return [
    { text: `Core: ${c.core.detail}`, tone: c.core.status === 'OK' ? 'ok' : 'danger' },
    ...c.silos.map((s) => ({ text: `${SILO_LABELS[s.target] ?? s.target}: ${s.status} · ${s.detail}`, tone: SILO_TONE[s.status] })),
  ];
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @td/web test -- coreRisk core-risk`
Expected: PASS (2 + 11 tests). If `formatLimitValue('rupees', …)` prints Western grouping, the Node
running Vitest lacks full ICU; M1's `rupees()` in `core-strategy-picker.ts` uses the same
`toLocaleString('en-IN')`, so check how its spec passes there before changing anything.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/services/coreRisk.ts apps/web/src/services/coreRisk.spec.ts apps/web/src/pages/core-risk/core-risk.ts apps/web/src/pages/core-risk/core-risk.spec.ts
git commit -m "feat(web): core risk wire client and pure page logic" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/web/src/services/coreRisk.ts apps/web/src/services/coreRisk.spec.ts apps/web/src/pages/core-risk/core-risk.ts apps/web/src/pages/core-risk/core-risk.spec.ts
```

---

### Task 15: The Core Risk page, route and nav entry

**Files:**
- Create: `apps/web/src/pages/core-risk/CoreRiskPage.tsx`
- Modify: `apps/web/src/App.tsx` (import after line 26; route after line 183)
- Modify: `apps/web/src/components/layout/navItems.ts` (icon import; entry after `/core-strategies`)

**Interfaces:**
- Consumes: everything Task 14 produces; `apiErrorMessage` (`pages/core-strategies/core-strategy-picker.ts:210`);
  `LoadingSkeleton` (`@/components/common`); TanStack Query; `react-hot-toast`.
- Produces: route `/core-risk` (ADMIN-only like `/core-strategies`, decision 10), nav item "Core Risk".

- [ ] **Step 1: Write the page**

Create `apps/web/src/pages/core-risk/CoreRiskPage.tsx`:

```tsx
import { Fragment, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { ShieldAlert } from 'lucide-react';
import { LoadingSkeleton } from '@/components/common';
import {
  changeCoreRiskLimit,
  getCoreKillSwitch,
  listCoreRiskLimits,
  setCoreKillSwitch,
  type CoreKillSwitchCascade,
  type CoreRiskLimitView,
} from '@/services/coreRisk';
import { apiErrorMessage } from '@/pages/core-strategies/core-strategy-picker';
import {
  cascadeLines,
  changeHint,
  changeResultMessage,
  DAILY_LOSS_ACTION_OPTIONS,
  editText,
  KILL_CONFIRM_WORD,
  killSwitchPayload,
  killSwitchSummary,
  limitChangePayload,
  limitRows,
  parseLimitInput,
} from './core-risk';

const LIMITS_KEY = ['trade-core', 'risk', 'limits'] as const;
const KILL_KEY = ['trade-core', 'risk', 'kill-switch'] as const;

const CARD = 'space-y-3 rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-card)] p-4';
const LABEL = 'flex flex-col gap-1 text-xs font-medium text-[var(--color-text-muted)]';
const FIELD = 'rounded border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] px-2 py-1.5 text-sm text-[var(--color-text-primary)]';
const BUTTON = 'rounded bg-[var(--color-accent-blue)] px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50';
const DANGER = 'rounded bg-[var(--color-accent-red)] px-4 py-2 text-sm font-bold uppercase tracking-wide text-white disabled:opacity-50';
const QUIET = 'rounded border border-[var(--color-border-default)] px-3 py-1.5 text-sm text-[var(--color-text-secondary)]';
const TONE = {
  ok: 'text-[var(--color-accent-green)]',
  warn: 'text-[var(--color-accent-yellow)]',
  danger: 'text-[var(--color-accent-red)]',
  muted: 'text-[var(--color-text-muted)]',
} as const;
const BADGE = {
  missing: { text: 'Not set', cls: 'bg-[var(--color-accent-red)] text-white' },
  pending: { text: 'Pending', cls: 'bg-[var(--color-accent-yellow)] text-black' },
  review: { text: 'Default — please review', cls: 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)]' },
} as const;

interface EditState {
  id: string;
  text: string;
  reason: string;
}

/**
 * SP2 Core Risk (spec §8.4): the caller's limits with pending-loosen badges and an edit
 * form with a reason, and the kill switch with a typed confirmation. Logic lives in
 * core-risk.ts; the server applies D5 (tighten now, loosen at the next session open).
 */
export default function CoreRiskPage() {
  const qc = useQueryClient();
  const limitsQ = useQuery({ queryKey: LIMITS_KEY, queryFn: listCoreRiskLimits });
  const killQ = useQuery({ queryKey: KILL_KEY, queryFn: getCoreKillSwitch });
  const [edit, setEdit] = useState<EditState | null>(null);
  const [mode, setMode] = useState<'on' | 'off' | null>(null);
  const [killReason, setKillReason] = useState('');
  const [confirmText, setConfirmText] = useState('');
  const [lastCascade, setLastCascade] = useState<CoreKillSwitchCascade | null>(null);

  const change = useMutation({
    mutationFn: (a: { view: CoreRiskLimitView; body: { value: number | string; reason: string } }) =>
      changeCoreRiskLimit(a.view.key, a.view.scope, a.body),
    onSuccess: (r) => {
      toast.success(changeResultMessage(r));
      setEdit(null);
      void qc.invalidateQueries({ queryKey: LIMITS_KEY });
    },
    onError: (err: unknown) => toast.error(apiErrorMessage(err, 'Could not change the limit')),
  });

  const kill = useMutation({
    mutationFn: (body: { active: boolean; reason: string }) => setCoreKillSwitch(body),
    onSuccess: (r) => {
      setLastCascade(r.cascade);
      setMode(null);
      setKillReason('');
      setConfirmText('');
      toast.success(!r.state.active ? 'Kill switch is off' : r.state.pendingRelease ? 'Release scheduled for the next session open' : 'Kill switch is ON');
      void qc.invalidateQueries({ queryKey: KILL_KEY });
    },
    onError: (err: unknown) => toast.error(apiErrorMessage(err, 'Could not change the kill switch')),
  });

  if (limitsQ.isLoading || killQ.isLoading) {
    return <div className="p-4"><LoadingSkeleton variant="card" /></div>;
  }
  if (limitsQ.isError || killQ.isError || !limitsQ.data || !killQ.data) {
    return (
      <div className="p-4 text-sm text-[var(--color-accent-red)]">
        Could not load your risk settings: {apiErrorMessage(limitsQ.error ?? killQ.error, 'unknown error')}
      </div>
    );
  }

  const views = limitsQ.data;
  const rows = limitRows(views);
  const ks = killQ.data;
  const summary = killSwitchSummary(ks);
  const lines = cascadeLines(lastCascade);

  const submitKill = () => {
    const p = killSwitchPayload(mode === 'on', killReason, confirmText);
    if (!p.ok) {
      toast.error(p.error);
      return;
    }
    kill.mutate(p.value);
  };

  return (
    <div className="space-y-4 p-4">
      <header className="flex items-center gap-2">
        <ShieldAlert size={18} className="text-[var(--color-accent-red)]" />
        <h1 className="text-lg font-semibold text-[var(--color-text-primary)]">Core Risk</h1>
        <span className="rounded bg-[var(--color-bg-tertiary)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
          Paper only
        </span>
      </header>

      <section className={`${CARD} border-2 ${summary.tone === 'danger' ? 'border-[var(--color-accent-red)]' : ''}`}>
        <h2 className={`text-base font-bold ${TONE[summary.tone === 'danger' ? 'danger' : 'ok']}`}>{summary.headline}</h2>
        {summary.detail && <p className="text-xs text-[var(--color-text-secondary)]">{summary.detail}</p>}
        {summary.releaseText && <p className="text-xs text-[var(--color-accent-yellow)]">{summary.releaseText}</p>}

        {mode === null ? (
          <div className="flex flex-wrap gap-2">
            {!ks.active && (
              <button type="button" className={DANGER} onClick={() => setMode('on')}>Stop everything…</button>
            )}
            {ks.active && (
              <button type="button" className={QUIET} onClick={() => setMode('off')}>Release at next session open…</button>
            )}
            {ks.active && ks.pendingRelease && (
              <button type="button" className={DANGER} onClick={() => setMode('on')}>Keep it on (cancel the release)…</button>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-xs text-[var(--color-text-secondary)]">
              {mode === 'on'
                ? 'This blocks every core entry now, exits core positions, and calls the old tracks’ square-off paths. For the owner that closes every silo position and every trade-engine trade, and trade-engine orders stay blocked until the API restarts.'
                : 'Releasing is a loosening: it takes effect at the next session open, not now.'}
            </p>
            <label className={LABEL}>
              Reason
              <input className={FIELD} value={killReason} onChange={(e) => setKillReason(e.target.value)} placeholder="Why?" />
            </label>
            {mode === 'on' && (
              <label className={LABEL}>
                Type {KILL_CONFIRM_WORD} to confirm
                <input className={FIELD} value={confirmText} onChange={(e) => setConfirmText(e.target.value)} />
              </label>
            )}
            <div className="flex gap-2">
              <button type="button" className={mode === 'on' ? DANGER : BUTTON} disabled={kill.isPending} onClick={submitKill}>
                {kill.isPending ? 'Working…' : mode === 'on' ? 'Turn the kill switch on' : 'Schedule the release'}
              </button>
              <button type="button" className={QUIET} disabled={kill.isPending} onClick={() => setMode(null)}>Cancel</button>
            </div>
          </div>
        )}

        {lines.length > 0 && (
          <ul className="space-y-0.5 text-xs">
            {lines.map((l) => (
              <li key={l.text} className={TONE[l.tone]}>{l.text}</li>
            ))}
          </ul>
        )}
      </section>

      <section className={CARD}>
        <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">Limits</h2>
        <p className="text-xs text-[var(--color-text-muted)]">Tighter changes take effect now. Looser changes take effect at the next session open.</p>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-[var(--color-text-muted)]">
              <th className="py-1">Limit</th>
              <th className="py-1">Applies to</th>
              <th className="py-1">In force</th>
              <th className="py-1">Status</th>
              <th className="py-1" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const view = views[i];
              const editing = edit !== null && edit.id === row.id;
              const parsed = editing ? parseLimitInput(view.kind, edit.text) : null;
              return (
                <Fragment key={row.id}>
                  <tr className="border-t border-[var(--color-border-default)] align-top">
                    <td className="py-1.5 text-[var(--color-text-primary)]">{row.label}</td>
                    <td className="py-1.5 text-[var(--color-text-secondary)]">{row.scopeLabel}</td>
                    <td className="py-1.5 text-[var(--color-text-primary)]">
                      {row.valueText}
                      {row.pendingText && <div className="text-xs text-[var(--color-accent-yellow)]">{row.pendingText}</div>}
                    </td>
                    <td className="py-1.5">
                      {row.badge && (
                        <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${BADGE[row.badge].cls}`}>{BADGE[row.badge].text}</span>
                      )}
                      {row.note && <div className="text-xs text-[var(--color-text-muted)]">{row.note}</div>}
                    </td>
                    <td className="py-1.5 text-right">
                      <button
                        type="button"
                        className="text-[var(--color-accent-blue)] underline"
                        onClick={() => setEdit(editing ? null : { id: row.id, text: editText(view), reason: '' })}
                      >
                        {editing ? 'Close' : 'Change'}
                      </button>
                    </td>
                  </tr>
                  {editing && (
                    <tr>
                      <td colSpan={5} className="pb-3">
                        <div className="flex flex-wrap items-end gap-3">
                          <label className={LABEL}>
                            New value
                            {view.kind === 'enum' ? (
                              <select className={FIELD} value={edit.text} onChange={(e) => setEdit({ ...edit, text: e.target.value })}>
                                {DAILY_LOSS_ACTION_OPTIONS.map((o) => (
                                  <option key={o.value} value={o.value}>{o.label}</option>
                                ))}
                              </select>
                            ) : (
                              <input
                                className={FIELD}
                                inputMode={view.kind === 'hhmm' ? 'text' : 'decimal'}
                                placeholder={view.kind === 'hhmm' ? 'HH:MM (IST)' : ''}
                                value={edit.text}
                                onChange={(e) => setEdit({ ...edit, text: e.target.value })}
                              />
                            )}
                          </label>
                          <label className={LABEL}>
                            Reason
                            <input className={FIELD} value={edit.reason} onChange={(e) => setEdit({ ...edit, reason: e.target.value })} placeholder="Why?" />
                          </label>
                          <button
                            type="button"
                            className={BUTTON}
                            disabled={change.isPending}
                            onClick={() => {
                              const p = limitChangePayload(view, edit.text, edit.reason);
                              if (!p.ok) {
                                toast.error(p.error);
                                return;
                              }
                              change.mutate({ view, body: p.value });
                            }}
                          >
                            {change.isPending ? 'Saving…' : 'Save'}
                          </button>
                        </div>
                        {parsed?.ok && <p className="mt-1 text-xs text-[var(--color-text-muted)]">{changeHint(view, parsed.value)}</p>}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </section>
    </div>
  );
}
```

- [ ] **Step 2: Add the route and the nav entry**

In `apps/web/src/App.tsx`, add after the `CoreStrategiesPage` import (line 26):

```tsx
import CoreRiskPage from '@/pages/core-risk/CoreRiskPage';
```

and after the `core-strategies` route (line 183):

```tsx
        <Route path="core-risk" element={<RequireRole role="ADMIN"><CoreRiskPage /></RequireRole>} />
```

In `apps/web/src/components/layout/navItems.ts`, add `ShieldAlert,` after `Layers,` in the `lucide-react`
import, and after the `/core-strategies` entry:

```typescript
  { path: '/core-risk', label: 'Core Risk', icon: ShieldAlert, badge: 'SP2' },
```

(`/core-risk` stays out of `USER_VISIBLE`, so a non-ADMIN never sees it; decision 10.)

- [ ] **Step 3: Typecheck and run the web suite for the touched files**

Run: `pnpm --filter @td/web exec tsc --noEmit -p tsconfig.json`
Expected: no errors.
Run: `pnpm --filter @td/web test -- navItems core-risk coreRisk`
Expected: PASS (`navItems.spec` counts `visibleNavItems('ADMIN')` against `navItems`, so the new entry
passes unchanged).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/pages/core-risk/CoreRiskPage.tsx apps/web/src/App.tsx apps/web/src/components/layout/navItems.ts
git commit -m "feat(web): Core Risk page: limits with pending-loosen badges, edit with reason, kill switch with confirmation" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/web/src/pages/core-risk/CoreRiskPage.tsx apps/web/src/App.tsx apps/web/src/components/layout/navItems.ts
```

---

### Task 16: Admin "Seed defaults" section on the Core Risk page

**Files:**
- Create: `apps/web/src/services/coreRiskDefaults.ts`
- Create: `apps/web/src/pages/core-risk/core-risk-defaults.ts`
- Create: `apps/web/src/pages/core-risk/RiskDefaultsSection.tsx`
- Modify: `apps/web/src/pages/core-risk/CoreRiskPage.tsx` (owner check and one render line)
- Test: `apps/web/src/services/coreRiskDefaults.spec.ts`
- Test: `apps/web/src/pages/core-risk/core-risk-defaults.spec.ts`

**Interfaces:**
- Consumes: the routes of Task 11; `formatIst`, `formatLimitValue`, `limitLabel`, `scopeLabel`,
  `parseLimitInput`, `validReason`, `limitRows`, `DAILY_LOSS_ACTION_OPTIONS`, `Parsed` (Task 14);
  `useAuthStore` (`@/stores/auth-store`, as the M1 page uses it).
- Produces:

```typescript
// services/coreRiskDefaults.ts
export interface CoreRiskDefaultView { key: string; scope: CoreLimitScope; kind: CoreLimitKind; tighter: 'lower' | 'earlier' | 'stricter'; value: number | string | null; note: string | null; updatedBy: string | null; updatedAt: string | null }
export function listCoreRiskDefaults(): Promise<CoreRiskDefaultView[]>;
export function changeCoreRiskDefault(key: string, scope: string, body: { value: number | string; reason: string }): Promise<CoreRiskDefaultView>;
// pages/core-risk/core-risk-defaults.ts
export interface DefaultRow { id; key; scope; kind; label; scopeLabel; valueText; note: string; updatedText: string }
export function defaultRows(views: readonly CoreRiskDefaultView[]): DefaultRow[];
export function defaultChangePayload(kind: CoreLimitKind, text: string, reason: string): Parsed<{ value: number | string; reason: string }>;
export function defaultSavedMessage(v: CoreRiskDefaultView): string;
```

The page then shows two editable tables: **Limits** (the user's own, every key and scope, each with
Change; D5 applies) and, for the owner only, **Seed defaults** (what a new user's limit starts at; a
change applies to future seeds at once and never rewrites anyone's limits).

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/services/coreRiskDefaults.spec.ts`:

```typescript
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('./api', () => ({ default: { get: vi.fn(), put: vi.fn() } }));

import api from './api';
import { changeCoreRiskDefault, listCoreRiskDefaults } from './coreRiskDefaults';

describe('coreRiskDefaults wire client', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reads and changes the seed defaults on the admin routes', async () => {
    (api.get as Mock).mockResolvedValueOnce({ data: { defaults: [{ key: 'maxTradesPerDay' }] } });
    expect(await listCoreRiskDefaults()).toEqual([{ key: 'maxTradesPerDay' }]);
    expect(api.get).toHaveBeenLastCalledWith('/trade-core/risk/defaults');
    (api.put as Mock).mockResolvedValueOnce({ data: { key: 'maxTradesPerDay', value: 12 } });
    await changeCoreRiskDefault('maxTradesPerDay', 'ALL', { value: 12, reason: 'fewer trades' });
    expect(api.put).toHaveBeenCalledWith('/trade-core/risk/defaults/maxTradesPerDay/ALL', { value: 12, reason: 'fewer trades' });
  });
});
```

Create `apps/web/src/pages/core-risk/core-risk-defaults.spec.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import type { CoreRiskLimitView } from '@/services/coreRisk';
import type { CoreRiskDefaultView } from '@/services/coreRiskDefaults';
import { limitRows } from './core-risk';
import { defaultChangePayload, defaultRows, defaultSavedMessage } from './core-risk-defaults';

const KEYS: Array<[string, CoreRiskLimitView['scope'], CoreRiskLimitView['kind']]> = [
  ['maxDailyLoss', 'ALL', 'rupees'], ['maxDailyLossPerStrategy', 'ALL', 'rupees'], ['maxTradesPerDay', 'ALL', 'count'],
  ['maxOpenPositions', 'ALL', 'count'], ['maxOpenPositions', 'CASH_INTRADAY', 'count'], ['maxOpenPositions', 'MTF', 'count'], ['maxOpenPositions', 'OPTIONS_BUY', 'count'],
  ['maxRiskPerTrade', 'ALL', 'rupees'],
  ['maxCapitalDeployed', 'CASH_INTRADAY', 'rupees'], ['maxCapitalDeployed', 'MTF', 'rupees'], ['maxCapitalDeployed', 'OPTIONS_BUY', 'rupees'],
  ['mtfMaxLeverage', 'MTF', 'ratio'], ['mtfMaxHoldDays', 'MTF', 'count'], ['optionsMaxPremiumPerTrade', 'OPTIONS_BUY', 'rupees'],
  ['lastEntryTime', 'CASH_INTRADAY', 'hhmm'], ['lastEntryTime', 'MTF', 'hhmm'], ['lastEntryTime', 'OPTIONS_BUY', 'hhmm'],
  ['squareOffTime', 'CASH_INTRADAY', 'hhmm'], ['squareOffTime', 'MTF', 'hhmm'], ['squareOffTime', 'OPTIONS_BUY', 'hhmm'],
  ['dailyLossAction', 'ALL', 'enum'],
];

function dv(over: Partial<CoreRiskDefaultView> = {}): CoreRiskDefaultView {
  return { key: 'maxTradesPerDay', scope: 'ALL', kind: 'count', tighter: 'lower', value: 20, note: 'no existing equivalent', updatedBy: null, updatedAt: '2026-10-10T06:30:00.000Z', ...over };
}

describe('every limit is editable (owner answer 1)', () => {
  it('the Limits table gets one row per (key, scope): all 21, each with its own id', () => {
    const views: CoreRiskLimitView[] = KEYS.map(([key, scope, kind]) => ({
      key, scope, kind, tighter: kind === 'hhmm' ? 'earlier' : kind === 'enum' ? 'stricter' : 'lower', value: null, source: null,
      needsReview: false, effectiveFrom: null, setAt: null, setBy: null, reason: null, pending: null,
    }));
    const rows = limitRows(views);
    expect(rows).toHaveLength(21);
    expect(new Set(rows.map((r) => r.id)).size).toBe(21);
  });
});

describe('seed defaults', () => {
  it('shows each default with its basis and who last edited it', () => {
    const rows = defaultRows([
      dv(),
      dv({ key: 'squareOffTime', scope: 'CASH_INTRADAY', kind: 'hhmm', tighter: 'earlier', value: '15:25', note: 'Ungated exit', updatedBy: 'usr_owner', updatedAt: '2026-10-13T03:45:00.000Z' }),
      dv({ key: 'mtfMaxLeverage', scope: 'MTF', kind: 'ratio', value: null, note: null, updatedAt: null }),
    ]);
    expect(rows.map((r) => [r.id, r.label, r.scopeLabel, r.valueText, r.note, r.updatedText])).toEqual([
      ['maxTradesPerDay@ALL', 'Max entries per day', 'All vehicles', '20', 'no existing equivalent', 'seeded by the M2 migration'],
      ['squareOffTime@CASH_INTRADAY', 'Square-off time', 'Cash intraday', '15:25 IST', 'Ungated exit', 'edited Tue 13 Oct, 09:15 IST by usr_owner'],
      ['mtfMaxLeverage@MTF', 'MTF max leverage', 'MTF', 'not set', 'no default: new users start without this limit', 'seeded by the M2 migration'],
    ]);
  });

  it('needs a valid value and a reason (the reason becomes the default’s note)', () => {
    expect(defaultChangePayload('count', '12', ' fewer trades ')).toEqual({ ok: true, value: { value: 12, reason: 'fewer trades' } });
    expect(defaultChangePayload('hhmm', '3:25', 'later').ok).toBe(false);
    expect(defaultChangePayload('count', '12', 'no').ok).toBe(false);
  });

  it('says the change applies to future seeds only', () => {
    expect(defaultSavedMessage(dv({ value: 12 }))).toBe(
      'Default for Max entries per day (All vehicles) is now 12. It applies to limits seeded from now on; nobody’s current limits change.',
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @td/web test -- coreRiskDefaults core-risk-defaults`
Expected: FAIL with `Failed to resolve import "./coreRiskDefaults"` and `"./core-risk-defaults"`.

- [ ] **Step 3: Write the client, the logic and the section**

Create `apps/web/src/services/coreRiskDefaults.ts`:

```typescript
import api from './api';
import type { CoreLimitKind, CoreLimitScope } from './coreRisk';

/** SP2 M2 owner-only seed defaults. Mirrors core-risk-defaults.service.ts in the API. */
export interface CoreRiskDefaultView {
  key: string;
  scope: CoreLimitScope;
  kind: CoreLimitKind;
  tighter: 'lower' | 'earlier' | 'stricter';
  value: number | string | null;
  note: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
}

export async function listCoreRiskDefaults(): Promise<CoreRiskDefaultView[]> {
  const r = await api.get<{ defaults: CoreRiskDefaultView[] }>('/trade-core/risk/defaults');
  return r.data.defaults;
}

export async function changeCoreRiskDefault(key: string, scope: string, body: { value: number | string; reason: string }): Promise<CoreRiskDefaultView> {
  const r = await api.put<CoreRiskDefaultView>(`/trade-core/risk/defaults/${encodeURIComponent(key)}/${encodeURIComponent(scope)}`, body);
  return r.data;
}
```

Create `apps/web/src/pages/core-risk/core-risk-defaults.ts`:

```typescript
import type { CoreLimitKind } from '@/services/coreRisk';
import type { CoreRiskDefaultView } from '@/services/coreRiskDefaults';
import { formatIst, formatLimitValue, limitLabel, parseLimitInput, scopeLabel, validReason, type Parsed } from './core-risk';

export interface DefaultRow {
  id: string;
  key: string;
  scope: string;
  kind: CoreLimitKind;
  label: string;
  scopeLabel: string;
  valueText: string;
  note: string;
  updatedText: string;
}

export function defaultRows(views: readonly CoreRiskDefaultView[]): DefaultRow[] {
  return views.map((v) => ({
    id: `${v.key}@${v.scope}`,
    key: v.key,
    scope: v.scope,
    kind: v.kind,
    label: limitLabel(v.key),
    scopeLabel: scopeLabel(v.scope),
    valueText: formatLimitValue(v.kind, v.value),
    note: v.note ?? 'no default: new users start without this limit',
    updatedText: v.updatedBy && v.updatedAt ? `edited ${formatIst(v.updatedAt)} by ${v.updatedBy}` : 'seeded by the M2 migration',
  }));
}

export function defaultChangePayload(kind: CoreLimitKind, text: string, reason: string): Parsed<{ value: number | string; reason: string }> {
  const v = parseLimitInput(kind, text);
  if (!v.ok) return v;
  const r = validReason(reason);
  if (!r.ok) return r;
  return { ok: true, value: { value: v.value, reason: r.value } };
}

export function defaultSavedMessage(v: CoreRiskDefaultView): string {
  return `Default for ${limitLabel(v.key)} (${scopeLabel(v.scope)}) is now ${formatLimitValue(v.kind, v.value)}. It applies to limits seeded from now on; nobody’s current limits change.`;
}
```

Create `apps/web/src/pages/core-risk/RiskDefaultsSection.tsx`:

```tsx
import { Fragment, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { changeCoreRiskDefault, listCoreRiskDefaults } from '@/services/coreRiskDefaults';
import { apiErrorMessage } from '@/pages/core-strategies/core-strategy-picker';
import { DAILY_LOSS_ACTION_OPTIONS } from './core-risk';
import { defaultChangePayload, defaultRows, defaultSavedMessage } from './core-risk-defaults';

const DEFAULTS_KEY = ['trade-core', 'risk', 'defaults'] as const;
const CARD = 'space-y-3 rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-card)] p-4';
const LABEL = 'flex flex-col gap-1 text-xs font-medium text-[var(--color-text-muted)]';
const FIELD = 'rounded border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] px-2 py-1.5 text-sm text-[var(--color-text-primary)]';
const BUTTON = 'rounded bg-[var(--color-accent-blue)] px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50';

/** Owner only (decision 20): the values new users' limits start at. Logic in core-risk-defaults.ts. */
export default function RiskDefaultsSection() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: DEFAULTS_KEY, queryFn: listCoreRiskDefaults });
  const [edit, setEdit] = useState<{ id: string; text: string; reason: string } | null>(null);
  const save = useMutation({
    mutationFn: (a: { key: string; scope: string; body: { value: number | string; reason: string } }) => changeCoreRiskDefault(a.key, a.scope, a.body),
    onSuccess: (v) => {
      toast.success(defaultSavedMessage(v));
      setEdit(null);
      void qc.invalidateQueries({ queryKey: DEFAULTS_KEY });
    },
    onError: (err: unknown) => toast.error(apiErrorMessage(err, 'Could not change the default')),
  });

  if (q.isLoading) return <section className={CARD}><p className="text-xs text-[var(--color-text-muted)]">Loading seed defaults…</p></section>;
  if (q.isError || !q.data) {
    return <section className={CARD}><p className="text-xs text-[var(--color-accent-red)]">Could not load the seed defaults: {apiErrorMessage(q.error, 'unknown error')}</p></section>;
  }
  const rows = defaultRows(q.data);

  return (
    <section className={CARD}>
      <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">Seed defaults (owner)</h2>
      <p className="text-xs text-[var(--color-text-muted)]">
        What a user’s limit starts at when their settings have no equivalent. A change applies to limits seeded from now on and never changes anyone’s current limits.
      </p>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-[var(--color-text-muted)]">
            <th className="py-1">Limit</th>
            <th className="py-1">Applies to</th>
            <th className="py-1">Default</th>
            <th className="py-1">Basis</th>
            <th className="py-1" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const editing = edit !== null && edit.id === row.id;
            return (
              <Fragment key={row.id}>
                <tr className="border-t border-[var(--color-border-default)] align-top">
                  <td className="py-1.5 text-[var(--color-text-primary)]">{row.label}</td>
                  <td className="py-1.5 text-[var(--color-text-secondary)]">{row.scopeLabel}</td>
                  <td className="py-1.5 text-[var(--color-text-primary)]">{row.valueText}</td>
                  <td className="py-1.5 text-xs text-[var(--color-text-muted)]">
                    {row.note}
                    <div>{row.updatedText}</div>
                  </td>
                  <td className="py-1.5 text-right">
                    <button
                      type="button"
                      className="text-[var(--color-accent-blue)] underline"
                      onClick={() => setEdit(editing ? null : { id: row.id, text: row.valueText === 'not set' ? '' : String(q.data.find((d) => `${d.key}@${d.scope}` === row.id)?.value ?? ''), reason: '' })}
                    >
                      {editing ? 'Close' : 'Change'}
                    </button>
                  </td>
                </tr>
                {editing && (
                  <tr>
                    <td colSpan={5} className="pb-3">
                      <div className="flex flex-wrap items-end gap-3">
                        <label className={LABEL}>
                          New default
                          {row.kind === 'enum' ? (
                            <select className={FIELD} value={edit.text} onChange={(e) => setEdit({ ...edit, text: e.target.value })}>
                              {DAILY_LOSS_ACTION_OPTIONS.map((o) => (
                                <option key={o.value} value={o.value}>{o.label}</option>
                              ))}
                            </select>
                          ) : (
                            <input className={FIELD} value={edit.text} placeholder={row.kind === 'hhmm' ? 'HH:MM (IST)' : ''} onChange={(e) => setEdit({ ...edit, text: e.target.value })} />
                          )}
                        </label>
                        <label className={LABEL}>
                          Reason (becomes the basis)
                          <input className={FIELD} value={edit.reason} onChange={(e) => setEdit({ ...edit, reason: e.target.value })} />
                        </label>
                        <button
                          type="button"
                          className={BUTTON}
                          disabled={save.isPending}
                          onClick={() => {
                            const p = defaultChangePayload(row.kind, edit.text, edit.reason);
                            if (!p.ok) {
                              toast.error(p.error);
                              return;
                            }
                            save.mutate({ key: row.key, scope: row.scope, body: p.value });
                          }}
                        >
                          {save.isPending ? 'Saving…' : 'Save default'}
                        </button>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
```

In `apps/web/src/pages/core-risk/CoreRiskPage.tsx`:
- add the imports `import { useAuthStore } from '@/stores/auth-store';` and
  `import RiskDefaultsSection from './RiskDefaultsSection';`;
- add `const isOwner = useAuthStore((s) => s.user?.role) === 'ADMIN';` directly after
  `const qc = useQueryClient();` (before any early return, so the hook order never changes);
- add `{isOwner && <RiskDefaultsSection />}` directly after the closing `</section>` of the Limits card,
  before the page's final `</div>`.

- [ ] **Step 4: Run the tests and the typecheck**

Run: `pnpm --filter @td/web test -- coreRiskDefaults core-risk-defaults core-risk coreRisk`
Expected: PASS (`coreRiskDefaults.spec` 1, `core-risk-defaults.spec` 4, plus Task 14's 2 + 11).
Run: `pnpm --filter @td/web exec tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/services/coreRiskDefaults.ts apps/web/src/services/coreRiskDefaults.spec.ts apps/web/src/pages/core-risk/core-risk-defaults.ts apps/web/src/pages/core-risk/core-risk-defaults.spec.ts apps/web/src/pages/core-risk/RiskDefaultsSection.tsx apps/web/src/pages/core-risk/CoreRiskPage.tsx
git commit -m "feat(web): owner-only seed defaults section on the Core Risk page" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/web/src/services/coreRiskDefaults.ts apps/web/src/services/coreRiskDefaults.spec.ts apps/web/src/pages/core-risk/core-risk-defaults.ts apps/web/src/pages/core-risk/core-risk-defaults.spec.ts apps/web/src/pages/core-risk/RiskDefaultsSection.tsx apps/web/src/pages/core-risk/CoreRiskPage.tsx
```

---

### Task 17: Verification and production gate

**Files:**
- Modify: `docs/superpowers/plans/2026-10-10-sp2-m2-risk-wall.md` (record results in the ledger)

- [ ] **Step 1: Whole API suite**

Run: `pnpm --filter @td/api test 2>&1 | tail -15`
Expected: every suite passes. M2 adds 17 API suites (`limit-keys.spec`, `append-only.spec`,
`session-open.spec`, `risk-wall.spec`, `core-risk-defaults.spec`, `core-risk.repository.spec`,
`ports.spec`, `core-risk-limit.service.spec`, `silo-square-off.adapter.spec`,
`core-kill-switch.service.spec`, `risk-wall.service.spec`, `core-risk.controller.spec`,
`core-risk-defaults.service.spec`, `core-risk-defaults.controller.spec`, `kill-gate.spec`,
`core-kill-switch.reader.spec`, `silo-entry-guards.spec`, and `trade-core.module.spec` grows by one
test). Every existing silo spec passes unchanged (the Jest setup file gives them an "off" reader). Record the totals. The M1 ledger had 253 suites / 3160 tests (one
time-of-day-dependent silo failure, `adaptive-stop-watch.service.spec.ts:168`, between 00:00 and about
00:45 IST: rerun it alone if it shows).

- [ ] **Step 2: Whole web suite**

Run: `pnpm --filter @td/web test 2>&1 | tail -15`
Expected: every file passes. M2 adds 4 web spec files (`coreRisk.spec`, `core-risk.spec`,
`coreRiskDefaults.spec`, `core-risk-defaults.spec`). Record the totals (M1: 66 files / 605 tests).

- [ ] **Step 3: The old paths changed only by the entry guards; no schedule; no live flag**

Run: `git diff main --numstat -- apps/api/src/modules/watch-monitor apps/api/src/modules/adaptive-stop-track apps/api/src/modules/ungated-track apps/api/src/modules/sell-futures-track apps/api/src/modules/breakout-swing-track apps/api/src/modules/anand-dual-track apps/api/src/modules/auto-execution apps/api/src/modules/auto-trade`
Expected: exactly the nine files of Task 13, each with `0` deletions; read the diff once and confirm every
added line is the import, a comment, or a guard shown in Task 13.
Run: `git diff main --stat -- apps/api/src/modules/trade-engine apps/api/src/modules/settings apps/api/src/modules/chartink`
Expected: empty.
Run: `git diff main -- apps/api/src/common/schedule/cron-timezone.spec.ts` and
`grep -rn "@Cron\|@Interval" apps/api/src/modules/trade-core/risk-wall || echo "no schedules in risk-wall"`
Expected: empty diff and `no schedules in risk-wall`.
Run: `grep -rn "LIVE_TRADING_ENABLED\|@td/shared" apps/api/src/modules/trade-core || echo "clean"`
Expected: `clean`.
Run: `grep -rnE "\b(5000|2500|3000|60_000|60000|15:15|15:25|15:00|14:30)\b" apps/api/src/modules/trade-core/risk-wall --include=*.ts | grep -v "\.spec\.ts" | grep -v "testing/" | grep -vE ':[0-9]+:\s*(\*|//|/\*\*)' || echo "no limit literals in logic"`
Expected: `no limit literals in logic` (D4: values live in rows).

- [ ] **Step 4: Typecheck (compare lists, not counts)**

Never check `main` out over the branch. Record the branch's sorted error list, build the same list in a
temporary worktree of `main`, compare, and remove the worktree:

```bash
git worktree add ../GrW-m2-base main
pnpm --filter @td/api exec tsc --noEmit -p tsconfig.json 2>&1 | grep "error TS" | sort > "$TMPDIR/tsc-m2.txt"
(cd ../GrW-m2-base && pnpm install --frozen-lockfile >/dev/null && pnpm --filter @td/api exec tsc --noEmit -p tsconfig.json 2>&1 | grep "error TS" | sort > "$TMPDIR/tsc-main.txt")
diff "$TMPDIR/tsc-main.txt" "$TMPDIR/tsc-m2.txt" && echo "same error list"
git worktree remove ../GrW-m2-base
```

Expected: `same error list` (169 lines, the `@td/shared` moduleResolution class). A line that differs
only in the order of union members printed in a message (M1 saw `setup-tracker.service.ts(572,7)`) is
the same error. No line may name a `trade-core`, `audit-actions`, `tenant.constants` or `app.module` file.
Run: `pnpm --filter @td/web exec tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 5: Record and commit**

Fill in the ledger row below (date, totals, typecheck, the Task 4 opt-in test and drift result), then:

```bash
git commit -m "docs(plans): SP2 M2 verification results" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- docs/superpowers/plans/2026-10-10-sp2-m2-risk-wall.md
```

---

## M2 production gate (after deploy, owner-run)

Production is the Vyom VPS: Postgres runs in `grw-postgres`, the API in `grw-api`
(deploy/docker-compose.prod.yml). The API deploy's existing `prisma migrate deploy` applies
`20261010120000_sp2_m2_risk_wall` (expand-only: three new tables, no existing table touched). No env var
is added. User and database are `grw`/`grw` (`PG_USER`/`PG_DB` in `/opt/grw/env/compose.env`; check
that file if it differs).

**Database (on the server):**

```bash
docker exec -i grw-postgres psql -U grw -d grw <<'SQL'
SELECT count(*) FROM core_risk_limit_defaults;
-- want: 21
SELECT tgname FROM pg_trigger WHERE tgname IN ('core_risk_limits_append_only', 'core_kill_switch_append_only') ORDER BY tgname;
-- want: two rows
SELECT conname FROM pg_constraint WHERE conname LIKE 'core_risk_limit%_check' OR conname LIKE 'core_kill_switch%_check' ORDER BY conname;
-- want: core_kill_switch_reason_check, core_risk_limit_defaults_pair_check, core_risk_limit_defaults_value_check,
--       core_risk_limits_pair_check, core_risk_limits_reason_check, core_risk_limits_source_check, core_risk_limits_value_check
SQL
```

**Browser (your ADMIN account), `/core-risk`:**
- 21 limits are listed. `Max daily loss`, `Max open positions` (all vehicles) and `Max option premium per
  trade` say "Copied from settings" (your settings row, or the platform row; decision 7); the rest carry
  the "Default — please review" badge. `Square-off time` for cash intraday is 15:25 (Owner answers 1).
  Every one of the 21 rows has **Change**.
- **Seed defaults (owner section, below Limits):** change `Max entries per day` with a reason: the toast
  says it applies to limits seeded from now on; your own Limits row does **not** change; the Basis column
  shows your reason and "edited … by <you>". Another account opened for the first time afterwards seeds
  the new value.
- **Tighten:** change `Max entries per day` to a lower number with a reason: the toast says "is now …"
  and the row shows it at once.
- **Loosen:** change it back up: the toast says "becomes … at <next session open> IST", the row keeps
  the old value and shows the yellow **Pending** badge with that time.
- **Cancel the pending loosening:** enter the value in force again: the badge disappears.
- **Refusals:** a value like `abc`, or a reason of two letters, is refused before anything is sent.

**Kill switch (do this after 15:30 IST on a trading day, when the silos are flat; check the Watch,
Adaptive-Stop, Ungated and Sell-Futures pages first).** It is a real action for the owner: it closes every
open silo paper position and every open trade-engine trade, sets your auto-execution kill flags, sets
`autoTradeMode` to OFF, and blocks every trade-engine order in memory until the API restarts.
1. Press **Stop everything…**, enter a reason, type `KILL`, confirm. The card turns red ("Kill switch ON")
   and lists each step: `Core: no core orders or positions exist yet …`, then each silo with `OK` and
   what it closed. Any `FAILED` or `UNAVAILABLE` line is a finding: record it.
   While it is on, the silo entry guards refuse new entries: the next Chartink alert (or a manual Watch
   execute) logs `[CoreKillGate] [<silo>] new entry <symbol> refused: the core kill switch is on`
   (`docker logs grw-api 2>&1 | grep CoreKillGate`), and no silo page shows a new TRADED or QUEUED fill.
2. Restart the API: `docker restart grw-api`. **This restart is required:** the old trade engine's
   kill switch, set by `closeAllPositions` in step 6 of the cascade, lives only in memory
   (`risk-manager.service.ts:33-35`) and nothing else clears it; until the restart every trade-engine
   order (watch-monitor executes, auto-trade, manual trades) is refused. Reload `/core-risk`: the core
   switch is **still ON** (persisted), and `GET /api/trade-core/risk/kill-switch` changed nothing (reload
   twice; the audit below shows no extra entry). The silo guards still refuse entries after the restart,
   because they read the persisted core switch.
3. Press **Release at next session open…** with a reason: the card stays red and shows "Release
   scheduled for <next open> IST".
4. Afterwards: switch auto-trade mode back on in Settings and clear the auto-execution kill flags if you
   use them (the cascade set both; decision 9).
5. The next morning after 09:15 IST, `/core-risk` shows "Kill switch off".

**Audit (on the server):**

```bash
docker exec -i grw-postgres psql -U grw -d grw <<'SQL'
SELECT action, target, meta FROM audit_logs WHERE action LIKE 'CORE_RISK_%' OR action LIKE 'CORE_KILL_SWITCH_%' ORDER BY seq;
-- want: one CORE_RISK_LIMITS_SEEDED (count 21 unless a default is missing), a CORE_RISK_LIMIT_CHANGED
-- per change with direction TIGHTER / LOOSER / SAME, CORE_KILL_SWITCH_SET (active true) followed by
-- CORE_KILL_SWITCH_CASCADE, then CORE_KILL_SWITCH_SET (active false, effectiveFrom = the next open),
-- and one CORE_RISK_DEFAULT_CHANGED for the seed-default edit
SELECT "key", "scope", "numValue"::text, "textValue", "source", "effectiveFrom" FROM core_risk_limits ORDER BY "createdAt";
SELECT "active", "effectiveFrom", "reason" FROM core_kill_switch ORDER BY "createdAt";
SQL
```

**Another account, if one exists:** its `GET /api/trade-core/risk/limits` shows its own 21 rows (seeded
on first read), your changes are not visible, and its kill switch "on" reports every silo as `SKIPPED`
("owner only") and sets only its own auto-execution flags.

**Nothing trades:** M2 has no producer of entry intents (M5), so `RiskWallService.check` is not called
in production yet; the old silos keep running as before except that they open nothing while an
admin's core kill switch is on; `LIVE_TRADING_ENABLED` is still `false`.

**Revert path:** revert the code commits. The three tables, the trigger and the default rows stay
(expand-only, harmless with no code reading them); dropping them would be a new migration.

M2 is complete when this gate is observed in production, not when the tests pass (parent spec rule).

## Deviations from the spec

1. **Verdicts are not persisted in M2** (spec §5.1 "every verdict is journaled"). The journal is M5
   (§8.1, §11). M2 returns the full journal payload and hands it to `RISK_VERDICT_SINK` (a logger now);
   no entry intent exists before M5, so no verdict goes unjournaled in production (decision 4).
2. **One extra table, `core_risk_limit_defaults`.** Not in the spec. D4 forbids hard-coded risk values,
   and new users need limits, so the seed defaults must be data; a global table is the smallest place
   (decision 7).
3. **`GET /risk/limits` may write once** (the lazy seed, audited). The spec's read-only GET rule is about
   the kill switch (§5.4), whose GET never writes (decision 7).
4. **The silo cascade is owner-only for the platform-wide silos.** The spec says one button stops
   everything; the silos are the owner's global tracks with no `userId`, so a non-owner's switch stops
   their own core and their own auto-execution only (decision 9).
5. **Approach A is relaxed by the owner for one purpose:** a guard line at each silo's new-entry point
   (decision 21, Task 13). Breakout-swing and anand-dual still have no square-off path, so their open
   positions run to their own exits; they open nothing new while the switch is on.
6. **"Cancels pending core orders, exits all core positions" is a port** (`CORE_SQUARE_OFF`) that M3/M4
   implement; in M2 it truthfully reports that none exist.
7. **The vocabulary grew by what the spec implies but does not name:** limit scopes `ALL` and per
   vehicle as a column, a `source` column for "default — please review", and `setBy = 'SEED'` for seeded
   rows. Spec §5.2's row fields (key, scope, value, effectiveFrom, setBy, reason, createdAt) are all
   present; `value` is split into `numValue`/`textValue` to keep money in `DECIMAL(14,2)`.
8. **The silos follow the admins' switches.** The spec makes the switch per user; the silos have no user,
   so their guard asks whether any ADMIN's switch is on. Auto-execution follows its own user's switch.
9. **Owner-editable seed defaults** (decision 20) are an addition the spec does not name; they serve D4
   and the owner's "configure them anytime".

## Notes for later milestones (not in this plan)

- **M3 binds `CORE_SQUARE_OFF`'s order half and provides deployed capital.** `RiskLiveState.deployedCapital`
  per vehicle = margin blocked by open positions plus pending entry orders, from `core_cash_ledger`
  (`MARGIN_BLOCK − MARGIN_RELEASE`). M3 also computes `CoreEntryIntent.capitalPerUnit` and `lotSize` with
  its vehicle model (cash = price ÷ configured leverage, MTF = own funded share, options = premium) and
  sets `refPriceFresh` with the same freshness rule as the paper fill (§6.3).
- **M4 binds `RISK_STATE_PROVIDER`** (with M3) in `TradeCoreModule`: `openPositions` from `core_positions`
  in `PENDING_ENTRY | OPEN | PARTIAL | EXITING` with `direction = exposureOf(...)` and `priced` from the
  hub; `openPnl` (null when any position is unpriced); `realisedPnlToday`, `pnlTodayByStrategy`,
  `tradesToday` for the IST day; and **M4 implements `CORE_SQUARE_OFF`** (cancel pending core orders,
  exit every core position with exit priority 1 or 2, spec §7.3). On every price push or sweep M4 calls
  `decideDailyLoss(limits, state)` and, when `squareOffCore` is true, calls `CORE_SQUARE_OFF` with cause
  `DAILY_LOSS` once per session. M4 freezes `squareOffTime` and `mtfMaxHoldDays` from the verdict's
  limits snapshot into the position (spec §7.1) and treats a kill switch that is on as exit priority 1.
- **M5 rebinds `RISK_VERDICT_SINK` to `core_journal`** (`RISK_VERDICT` rows with the verdict as payload;
  the row ids in `limits` are the snapshot) and derives `dailyLossLatched` from today's journal
  (`RISK_VERDICT` with `DAILY_LOSS`). M5 builds `CoreEntryIntent` in the Chartink fan-out after the
  strategy's `entry.minScore` and `filters` pass, calls `RiskWallService.check`, and places the order
  only for `ALLOW` (requested qty) or `RESIZE` (the verdict's qty). M5 journals `LIMIT_CHANGED` and
  `KILL_SWITCH` from the audit events M2 writes, and its reconciliation block ("new entries for the
  affected strategy are blocked until acknowledged", §8.3) becomes one more input to `RiskContext`.
  M5's journal table can reuse `core_append_only_guard()`.
- **Telegram `/kill`** (parent §7.1) calls `CoreKillSwitchService.set` with the owner as actor when
  Telegram alerts exist (not SP2).
- **Parent §7.1 items not in SP2's §5** (sector caps, broker margin, F&O ban list, circuit limits, order
  rate) are new limit keys plus new `checkRisk` reasons later; adding a key is a change to `LIMIT_KEYS`,
  the two CHECK lists, a default row and the web labels.
- **Opening the page to users:** add `/core-risk` to `USER_VISIBLE` and drop the `RequireRole` wrap; the
  API is already per user.
- **SP6 removes the silo guards with the silos.** Until then any new silo entry path must call
  `coreEntryAllowed` / `assertCoreEntryAllowed` (`trade-core/risk-wall/kill-gate.ts`), and
  `silo-entry-guards.spec.ts` gains a block for it.

## Self-review

- **Spec coverage:** §5.1 contract, reduce-only, exits pass, fail closed, snapshot, conflict rule (Task 3;
  Task 9 for the service-level fail-closed and recording); §5.2 every key with its tighter direction
  (Task 1), append-only storage and "latest row whose effectiveFrom ≤ now" (Tasks 2, 4, 5), D5 change
  rule with `SessionClock` for the vehicle's exchange (Tasks 2, 6), audit (Tasks 5, 6), seeding from
  `UserSettings` with citations and reviewed defaults (decision 7, Tasks 4, 6); §5.3 daily-loss decision
  and the square-off port (Tasks 3, 6); §5.4 persistent switch, POST-only change with reason, read-only
  GET, on immediate, off next session, cascade including the silos, audit both ways (Tasks 7, 8, 10);
  §3 module layout, `Core` naming, tenant scoping (Tasks 4, 5, 10); §8.4 Risk page (Tasks 14, 15, 16);
  owner answers: editable defaults (Tasks 4, 11, 16), cash square-off 15:25 (Task 4), silo entry guards
  (Tasks 12, 13), trade-engine in the cascade (Task 7, gate step 2); §9
  fail-closed and IST crons (none added); §10 pure tests for `RiskWall.check` and the direction /
  `effectiveFrom` rules, plus the tenant test for limits and kill switch (Review Focus 1); §11 M2 row
  (whole plan). Not in M2 by the spec's own split: journal (M5), execution (M3), lifecycle (M4).
- **Placeholder scan:** no TBD/TODO; every code step has full code; every test step names its command
  and expected result.
- **Type consistency:** `LimitKey`, `LimitScope`, `LimitPair`, `LimitInForce`, `LimitSource`,
  `RiskLiveState`, `RiskVerdict`, `CoreEntryIntent`, `NewLimitRow`, `NewKillSwitchRow`, `SettingsForSeed`,
  `SeedSettings`, `CoreRiskLimitView`, `LimitChangeResult`, `KillSwitchView`, `KillSwitchSetResult`,
  `SiloSquareOffResult` and the four tokens are named the same in every task; `checkRisk(intent, ctx)`,
  `rejectVerdict(intent, now, code, message, prior)`, `seedValueFor(pair, seed, defaults)`,
  `append(userId, row, now, expectNewestId)` match between their producer and consumers; the web `Core*`
  wire types mirror the API views field for field.

## Verification ledger

| Date | Whole suite (API / web) | Typecheck (M2 files, error lists) | Opt-in DB test + drift | Notes |
|---|---|---|---|---|
| 2026-10-11 | API 284 suites / 3654 tests, all pass (at 7ae7100; an earlier run that straddled the merge: 270 / 3380, all pass); after 5e567e6 the trade-core + trade-engine suites were re-run: 35 suites / 372 tests, all pass. Web 71 files / 638 tests, all pass. No adaptive-stop flake seen. | API at 5e567e6: 169 lines, same list as tsc-base-postgen.txt (only setup-tracker differs, in union-member order alone); no line names trade-core, audit-actions, tenant.constants, app.module or universe-scanner; no new line from main's files (market-cues, trade-sentinel, options-chain, market-data). Web tsc clean. | Task 4 opt-in DB test: 5/5 on a throwaway 127.0.0.1 container (since removed); `prisma migrate diff` empty (no drift). Not re-run. Opt-in test/tda010 (emission) and test/tda011int (pipeline) pass without a DB under the setupFiles ruling (Task 13). | Branch merged with main 3cf3034 at 7ae7100 by another process; verified at 7ae7100. Commit 5e567e6 (kill-switch reader generation counter + core kill-gate on POST /api/trades/execute) also came from another process. main later absorbed the branch (17058f1), so the Step 3 diffs use the old main: `git diff 3cf3034...HEAD`. Silo guard set: 10 files, insertions only, 0 deletions (the 9 from Task 13 + signal-generator/workers/universe-scanner.worker.ts, +5); every added line is the kill-gate import, a comment or a guard. settings and chartink: empty. trade-engine is not empty because of 5e567e6: trade-engine.controller.ts +7/-0 (ForbiddenException import, kill-gate import, 2 comment lines, 3-line guard) and trade-engine.controller.spec.ts +45/-0. cron-timezone.spec.ts: no diff. risk-wall @Cron/@Interval: the only hit is a string in core-risk-defaults.spec.ts:68 that asserts the ungated silo's existing cron; there is no schedule. trade-core LIVE_TRADING_ENABLED/@td/shared: clean. Limit literals: none in logic. |

## Owner answers (2026-10-10)

1. **Limits: "keep all the values dynamic and a place from where I can configure them anytime."**
   - The proposed defaults are the starting values (rows in `core_risk_limit_defaults`, Task 4), with one
     change: `squareOffTime` CASH_INTRADAY = **15:25**, Ungated's own EOD (`ungated-tick-poller.service.ts:94`),
     so Ungated v1's 15:25 exit is not cut short; Adaptive-Stop v1 keeps its own 15:15 time exit
     (decision 19). The starting values:

     | Limit | Starting default |
     |---|---|
     | `maxDailyLoss` / `maxOpenPositions` (ALL) / `optionsMaxPremiumPerTrade` | ₹5,000 / 5 / ₹50,000 (schema column defaults; used only without a settings row) |
     | `maxDailyLossPerStrategy` | ₹2,500 |
     | `maxTradesPerDay` | 20 |
     | `maxOpenPositions` CASH_INTRADAY / MTF / OPTIONS_BUY | 5 / 3 / 2 |
     | `maxRiskPerTrade` | ₹3,000 |
     | `maxCapitalDeployed` CASH_INTRADAY / MTF / OPTIONS_BUY | ₹10,00,000 / ₹2,00,000 / ₹1,00,000 |
     | `mtfMaxLeverage` / `mtfMaxHoldDays` | 2.00 / 10 |
     | `lastEntryTime` CASH_INTRADAY / MTF / OPTIONS_BUY | 15:00 / 15:00 / 14:30 |
     | `squareOffTime` CASH_INTRADAY / MTF / OPTIONS_BUY | **15:25** / 15:20 / 15:15 |
     | `dailyLossAction` | `BLOCK_ENTRIES` |

   - Every limit key and scope is editable on the Risk page at any time: tighter applies now, looser at the
     next session open (Tasks 6, 14, 15; Task 16's test "the Limits table gets one row per (key, scope)").
   - The owner edits the global defaults in an admin-only, audited section of the Core Risk page; a change
     affects future seeds only and never rewrites existing user rows (decision 20, Tasks 11 and 16).
   - No risk value is hard-coded in logic (Global Constraints; Task 17's literal grep).
   - Questions 2, 3 and 5 accepted as recommended: the options premium seeds from `maxCapitalPerTrade`;
     users with no settings row use the schema column defaults; an ADMIN without a settings row falls back
     to the platform row (decision 7).
2. **Silo gaps: "add a kill check to silo entries."** Every silo's new-entry point (all seven, including
   breakout-swing and anand-dual) and the auto-execution and auto-trade entry paths refuse new positions
   while the core kill switch is on, log it, and fail closed when the state cannot be read. They read
   through one injectable reader with a ≤ 5 s cache; nothing else in the silos changes; exits, stops and
   square-offs are never blocked (decision 21, Tasks 12 and 13, each entry point cited by file:line).
3. **Trade engine:** `TradeExecutionService.closeAllPositions` stays in the owner's cascade (decision 9,
   step 6). Clearing the old engine's in-memory flag needs an API restart (production gate, kill switch
   step 2).
