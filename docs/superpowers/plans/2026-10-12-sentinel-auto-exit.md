# Sentinel Auto-Exit (live) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the trade sentinel writes an `EXIT_NOW` verdict on one of the owner's open Angel One F&O positions, GrW closes that whole position on Angel One by itself, inside hard guards (allow-list, freshness, session, daily cap, dry-run gate, no-open-order, never more than the broker's net quantity), with one row per verdict in `ai_exit_executions`.

**Architecture:** A new NestJS module `apps/api/src/modules/sentinel-executor/` polls `sentinel_verdicts` every 5 s with one indexed anti-join query (only when `AI_AUTO_EXIT_ENABLED=true`), claims each new `EXIT_NOW` verdict by inserting a unique `ai_exit_executions` row **before** any broker call, evaluates pure guards, reads the broker book through the owner's **already-logged-in per-user session** (the market hub's `UserFeedManager` session; ephemeral vault login only when no warm session exists), and places exactly one MARKET order (or, when Angel refuses MARKET, exactly one LIMIT at LTP ∓ 2 %). The executor and `trade-sentinel` never import each other; they meet only in the database.

**Tech Stack:** NestJS 11 + TypeScript, Prisma 6 (PostgreSQL), Jest (api), React + Vite + Vitest (web), `smartapi-javascript@1.0.27`.

**Spec:** `docs/superpowers/specs/2026-10-12-sentinel-auto-exit-design.md` (owner-approved 2026-10-12). Read it before any task.

## Global Constraints

- Owner decisions (verbatim from the spec): authority "Live, fully automatic (no per-trade confirmation)"; rollout "`dry-run` first (everything except the order), then `live`"; daily cap "at most **5** AI exits per user per IST day (config)"; MARKET refused → "one fallback: aggressive LIMIT at LTP − 2% (sell) / + 2% (buy-to-cover), rounded to tick size"; static IP 157.10.98.70 registered as app "GrWW".
- Scope: `trade_trackers.kind = 'POSITION'`, exchanges **NFO, BFO, MCX**, allow-listed users only, verdict `EXIT_NOW` only. Never holdings, cash equity, opening/adding/reversing, `EXIT_ARMED`/`HOLD`/`ESCALATE`, overnight verdicts, core paper positions.
- Env (in `api.env`, defaults safe): `AI_AUTO_EXIT_ENABLED=false`, `AI_AUTO_EXIT_MODE=dry-run`, `AI_AUTO_EXIT_USER_IDS=` (empty), `AI_AUTO_EXIT_DAILY_CAP=5`, `AI_AUTO_EXIT_MAX_VERDICT_AGE_SEC=90`, `AI_AUTO_EXIT_LIMIT_FALLBACK_PCT=2`, `AI_AUTO_EXIT_QTY_UNITS=` (empty → NFO/BFO `units`, MCX unconfigured = never live; ruling R16).
- Daily cap counts rows with `status ∈ {PLACED, FILLED, DRY_RUN}` created since IST midnight.
- The core kill switch does **not** block these exits (CLAUDE.md §9: exits are never blocked). Do not call `coreEntryAllowed`.
- `trade-sentinel` is **not modified**. `apps/api/src/modules/trade-sentinel/services/sentinel-cycle.service.spec.ts` ("shadow mode is structural") and `controllers/sentinel.controller.spec.ts` stay unchanged and green. No file under `sentinel-executor/` imports a specifier containing `trade-sentinel`; no file under `trade-sentinel/` imports `sentinel-executor`.
- Migrations are **expand-only** and auto-applied on deploy: one new table, no FK to existing tables, no change to any existing table/column.
- **No new `@Cron`.** Background work is `setInterval`/`setTimeout` gated by `bootJobsEnabled()` (`apps/api/src/common/utils/boot-jobs.ts`), timers `.unref()`'d and cleared in `onModuleDestroy`. `apps/api/src/common/schedule/cron-timezone.spec.ts` is untouched.
- 1 vCPU VPS: when disabled the executor starts **no timer, runs no query, makes no broker call**. When enabled, one 5 s pass = exactly one indexed SELECT when there is nothing to do.
- Credentials never logged. Log lines are prefixed `[ai-exit]`. Broker messages are stored/logged; plaintext creds, JWTs, TOTP are never.
- Angel `ordertag`: ≤ 20 characters, alphanumeric only (ruling R4).
- Commits: Conventional Commits, **explicit pathspecs** in `git add <paths>`; never `git add -A`, `git commit -a`, or `git stash` (parallel streams share nothing, but the habit is the rule). Every commit message ends with a blank line and `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Worktrees: `node_modules` are junctions to the main tree. Never `npm install`, never delete a junction. `npx prisma generate` writes the generated client through the junction into the main tree's `node_modules/.prisma` — acceptable (additive model), but do not run `prisma migrate dev`/`reset` against any shared database.
- Tests: API `cd apps/api && npx jest <path>`; web `cd apps/web && npx vitest run <path>`; API typecheck `cd apps/api && npx tsc --noEmit -p tsconfig.json`; web typecheck `cd apps/web && npx tsc --noEmit -p tsconfig.json`.

## Planner Rulings

- **R1 — Which broker session the executor uses (owner = feed/hub account).** Tier 1: the owner's **warm per-user session** held by `UserFeedManager` (the session the market hub pins via `ManagerHubBroker`; it was logged in with the owner's own vault credentials). The executor borrows its authenticated SmartAPI client through a new read-only accessor (`UserFeedSession.restClient()` → `UserFeedManager.warmRestClient(userId)`), wraps it in the existing `AngelOneUserBrokerSession` via a new `PerUserBrokerSessionFactory.borrow()` (no login, no logout), and so reuses the one order mapper (`ORDER_TYPE_MAP`/`PRODUCT_TYPE_MAP`). Tier 2 (only if no warm session exists): ephemeral `CREDENTIAL_DECRYPTOR.withDecryptedCredentials(userId, { reason: 'ORDER' })` → `PerUserBrokerSessionFactory.withSession` — the spec's original path. **Why:** `hub-broker.ts`, `user-feed-manager.service.ts` (`pin`) and `trade-tracker.service.ts` (`snapshotBook`) all state that a second Angel login on the same client code kills the live stream, and `withSession` also calls `logout(clientId)` on exit; borrowing adds zero logins. **`AngelOneAuthService` is never used for orders**: `FeedCredentialProvider` is env-first, so that session can belong to a different Angel account than the `isFeedAccount` user — an order through it could land on the wrong account. Tier selection happens once, before any broker call; a failure inside a tier is never retried on another tier (no double placement). The tier used is stored in `ai_exit_executions.sessionSource` and checked in the production gate.
- **R2 — Rejections can be asynchronous.** Angel's `placeOrder` usually returns an `orderid` even for orders the RMS/exchange rejects a moment later; the reason appears in the order book (`getOrderBook`, row `status: 'rejected'`, `text`). So "MARKET refused" is detected **either** synchronously (`placeOrder` → `REJECTED` with a matching message) **or** in the confirm step (order-book row for our `orderid` is `rejected` with a matching `text`). Both lead to the same single LIMIT fallback. `UserSmartApiLike` gains `getOrderBook()` and `UserBrokerSession` gains `getOrderBookEnvelope()`.
- **R3 — Never exceed / never reverse.** Every order (MARKET and the LIMIT fallback) is preceded, inside the same session lease, by a fresh `getPositionsEnvelope()` **and** `getOrderBookEnvelope()`: quantity = `|netqty|` of the single matching broker row; no order if the book is unanswered, the row is missing/flat, more than one non-flat row matches (`AMBIGUOUS_POSITION_ROWS`), the broker side disagrees with the tracker side (`SIDE_MISMATCH`), or any non-terminal order exists on that exchange+token (`OPEN_ORDER_EXISTS`). Plus a DB in-flight guard (another `CLAIMED` row for the tracker, or a `PLACED` row for it in the last 60 s). The fallback quantity must equal the first plan's quantity or it aborts (`POSITION_CHANGED`).
- **R4 — ordertag.** Angel's documented `ordertag` limit is 20 characters (alphanumeric); the repo has no in-tree constant (the SDK test fixture only shows `"ordertag": ""`). Tag = `ax` + leg (`M` market / `L` limit) + the last 17 characters of the verdict cuid with non-alphanumerics stripped → ≤ 20 chars. The DB unique claim, not the tag, is the idempotency anchor.
- **R5 — Tick size.** The instrument master's `tick_size` is stored unconverted in `instruments.tickSize` (`master-contract.ts` / `instrument-master-refresh.cron.ts` parse the raw string; Angel publishes it in **paise**, e.g. `"5.000000"` = ₹0.05) while the column default is `0.05` (rupees). Rule: `raw ≥ 1` → `raw / 100` rupees; `0 < raw < 1` → `raw` rupees (legacy default); missing → ₹0.05 for NFO/BFO, ₹1.00 for MCX (every MCX tick in scope divides ₹1). SELL price floors to the tick, BUY ceils; a SELL that would be ≤ 0 or an LTP ≤ 0 → no fallback (`REJECTED: NO_LTP_FOR_LIMIT`). A wrong tick only produces a broker rejection, never a fill at a bad price.
- **R6 — MARKET-refusal classifier.** `isMarketRefusal(text)` = text mentions "market" and one of "not allowed / not permitted / blocked / disallowed / not available / only limit" (case-insensitive). Angel's exact wording is not in the repo; every broker message is stored so the classifier can be tightened after the first real one.
- **R7 — Polling window.** The poll looks back `2 × AI_AUTO_EXIT_MAX_VERDICT_AGE_SEC`, so a verdict that aged out while queued gets a visible `SKIPPED: STALE_VERDICT` row instead of vanishing; older verdicts (e.g. from before a restart) are ignored. At most 5 verdicts per pass, oldest first, processed sequentially; the pass is single-flight.
- **R8 — Crash sweep.** On start (when enabled) and once more 65 s later, `CLAIMED` rows older than 60 s become `FAILED: INTERRUPTED`. Never re-sent.
- **R9 — Timeouts are uncertain, not failures to retry.** `placeOrder` returning `FAILED` (thrown/timeout) → row `FAILED: ORDER_UNCERTAIN`, no retry, no fallback.
- **R10 — Confirm step.** After a `PLACED`, inside the same lease, read the order book at +2 s, +5 s, +10 s (stop at a terminal status). `complete`/still-open → one positions read: flat → `FILLED`, else stays `PLACED` with `orderStatus`. `rejected` → fallback (MARKET leg + refusal) or `REJECTED`. `cancelled` → `REJECTED` with reason `CANCELLED`. The confirm step never places anything except the single R2 fallback.
- **R11 — Table shape.** Spec §6 columns plus `sessionSource`, `orderStatus` (last broker order-book status), `marketOrderId` (the refused MARKET order's id when the fallback ran). Order columns are nullable (a `SKIPPED` row before planning has none). No FK (same as `sentinel_verdicts`). CHECK constraints on `status`, `mode`, `side`.
- **R12 — Session clock.** The executor builds its own `SessionClock({ holidays: MARKET_HOLIDAYS, mcxLateClose: parseLateClose(config 'hub.mcxLateClose') })` — the same inputs as `MarketHubService`, so MCX's 23:55 late-close window is honoured. "In session" = `phase === 'open'` (pre-open excluded).
- **R13 — Endpoint access.** `GET /api/sentinel-executor/executions` is authenticated by the global JWT guard; the caller must be `role === 'ADMIN'` or in `AI_AUTO_EXIT_USER_IDS` (else 403), and rows are always scoped to the caller's own `userId` (an admin does not see other users' rows). Lives in the executor module, never in `SentinelController` (whose spec forbids exit-ish routes and pins its constructor to 3 deps).
- **R14 — Structural import rule.** "Imports nothing from trade-sentinel" is enforced first-hop (no import specifier in `sentinel-executor/**` contains `trade-sentinel`). `SessionClock` itself imports the pure `trade-sentinel/market-sessions.ts`; that transitive edge points away from the shadow guarantee and is allowed.
- **R15 — Web placement.** `SentinelPanel` renders nothing when the charted instrument has no open position — and after an AI exit the tracker closes. So "AI exits" is a sibling component `AiExitsList` rendered on the Charts page right under `SentinelPanel`, showing the newest 10 rows of the last 24 h, rendering nothing when there are none or the endpoint answers 403/404.
- **R16 — Order quantity unit per exchange (owner addition, 2026-10-12).** The MCX unit is unverified (positions `netqty` may be units while orders may need lots). `planExitOrder` therefore takes the instrument's lot size and an explicit per-exchange unit, `AI_AUTO_EXIT_QTY_UNITS` (`EXCHANGE:units|lots`, comma separated; parsed into `AutoExitConfig.qtyUnits`). Defaults: `NFO:units`, `BFO:units` (the repo's existing order paths already send NFO quantity as `lots × lotSize`); **MCX has no default**. `netqty` is taken as units; `lots` → quantity = `|netqty| / lotSize`. Refusals: unit not configured for the exchange in **live** → `QTY_UNIT_UNCONFIGURED:<EX>` (in **dry-run** the computed `|netqty|` is still returned with `unitVerified: false`, `qtyUnit: null`, so the row is recorded but flagged); caller lot size ≠ broker row `lotsize` → `LOT_SIZE_MISMATCH`; `|netqty|` not a whole number of lots (when a lot size is known) → `QTY_NOT_LOT_MULTIPLE`; `lots` with no lot size → `NO_LOT_SIZE`; `lots` with a lot of 1 that the broker row does not confirm → `LOT_SIZE_UNCONFIRMED` (every master parser in the repo coerces a missing `lotsize` to 1, and dividing by it would send `|netqty|` lots). The config parser fails closed: a malformed or contradictory entry for NFO/BFO/MCX removes that exchange's unit; an out-of-scope exchange is ignored. Both with a `problems` line.

## Where the Code Differs from the Spec

- Spec §4 says orders go through the per-user session factory + vault lease. Its `withSession` logs in and also logs out at the end, which the code itself says kills the live stream on the owner's account. R1 makes the owner's warm hub session the first choice and keeps the spec's path only as the fallback.
- Spec §5.7 treats a "MARKET not allowed" rejection as part of the `placeOrder` response. Angel usually reports that rejection later, in the order book. R2 checks both places, which needs a new `getOrderBook` read.
- Spec §5.7 names `'aix-' + verdictId`. That is 29 characters with a hyphen, and Angel's tag limit is 20 alphanumeric characters (R4).
- Spec §6 columns for the order are written as if they are always filled. A row skipped before planning has no order, so those columns are nullable. The plan also adds `sessionSource`, `orderStatus` and `marketOrderId` (R11).
- Spec §5.3 says "the exchange is in session (market-hub SessionClock)". The hub builds its clock with the `HUB_MCX_LATE_CLOSE` windows. A clock built without them would refuse MCX exits after 23:30 during the late-close months (R12).
- Spec §9 says "the executor module imports nothing from trade-sentinel". That holds for direct imports only, because `SessionClock` imports the pure `trade-sentinel/market-sessions.ts` (R14).
- Spec §5 does not guard a second `EXIT_NOW` that arrives while the first exit order is still open. A fresh read would still show the full position and a second order would reverse it. R3 adds the open-order check and the in-flight check.

### Stream A deviations (Tasks 1–5, recorded during implementation)

- **R16 changes Task 2 and Task 3 interfaces.** `AutoExitConfig` gains `qtyUnits: Partial<Record<string, QtyUnit>>`; `auto-exit.types.ts` gains `type QtyUnit = 'units' | 'lots'` and `DEFAULT_QTY_UNITS`. `planExitOrder(rows, target: { exchange; token; trackerQty; lotSize?: number | null }, policy: QtyPolicy)` with `QtyPolicy = { mode: AutoExitMode; qtyUnit: QtyUnit | null | undefined }`; `ExitPlan` ok-branch gains `qtyUnit: QtyUnit | null` and `unitVerified: boolean`.
- **What Task 9 (Stream D) must do differently from the code block below:** `preOrderCheck` needs the config and the instrument's lot size. Read `instrument.findFirst({ where: { exchange, token }, select: { tickSize: true, lotSize: true } })` once (the fallback already reads `tickSize` there), and call `planExitOrder(rows, { exchange: t.exchange, token: t.token, trackerQty: t.qty, lotSize: inst?.lotSize ?? null }, { mode: cfg.mode, qtyUnit: cfg.qtyUnits[t.exchange.toUpperCase()] })`. In dry-run, when `plan.unitVerified === false`, the `DRY_RUN` row's `reason` must say so (e.g. prefix `UNIT_UNVERIFIED: `) — the table has no flag column. The fallback's POSITION_CHANGED comparison stays valid (both plans go through the same conversion). The fallback's synthetic tracker uses `first.quantity` only for its sign, which is unit-independent. Add `AI_AUTO_EXIT_QTY_UNITS=` to the Task 10 env example and `qty-units=…` to the ENABLED log line.
- **Task 3 tests:** the plan's `planExitOrder` cases now pass `{ mode: 'live', qtyUnit: 'units' }` and their `toEqual` objects include `qtyUnit`/`unitVerified`; 13 R16 cases added (MCX 100 units / lot 100 → 1 lot with `lots`, 100 with `units`, refused live when unconfigured, dry-run flagged). One extra `limitFallbackPrice` case pins on-tick prices against float error.
- **Task 2 tests:** the defaults case includes `qtyUnits: { NFO: 'units', BFO: 'units' }`; 5 `AI_AUTO_EXIT_QTY_UNITS` cases added.
- **Task 1:** verified on a throwaway `postgres:16` (port 55437, removed): all migrations apply, `prisma migrate diff --from-migrations … --to-schema-datamodel` is empty, and the unique + CHECK constraints reject a duplicate verdict, `mode='LIVE'` and `side='buy'`. The repository's raw anti-join, P2002 claim, in-flight, count and sweep were exercised against the same container.

### Stream D deviations (Tasks 9–11, recorded during implementation)

- **Task 9 — R16 applied.** The instrument (`tickSize` + `lotSize`) is read once per verdict after the guards, outside the broker lease; a failed read ends `FAILED: INSTRUMENT_READ` before any broker call. `planExitOrder` gets `lotSize` and `{ mode: cfg.mode, qtyUnit: cfg.qtyUnits[EXCHANGE] }`; a dry-run plan with `unitVerified === false` writes reason `UNIT_UNVERIFIED: would …`. The spec's live fixtures set `AI_AUTO_EXIT_QTY_UNITS=MCX:units` (MCX has no default, so the plan's original live MCX tests would otherwise be `SKIPPED: QTY_UNIT_UNCONFIGURED:MCX`), and the harness instrument has no lot size by default so the "position changed 100 → 50" case still reaches `POSITION_CHANGED`.
- **Task 9 — `FeedSessionNotReadyError` (Stream B, owner decision: refuse rather than log in).** Recorded as `SKIPPED: FEED_SESSION_NOT_READY` (warn log, broker message kept), no retry and no vault login. SKIPPED, not FAILED: no broker contact happened and it does not count toward the cap.
- **Task 9 — fail-closed hardening beyond the plan's code block.** (a) A broker read that THROWS (timeout, disposed session) is treated as "not answered": before an order it is `FAILED: BROKER_READ` / `ORDER_BOOK_READ` (was `FAILED: SESSION`); in the confirm step it leaves the row `PLACED` instead of overwriting it with `FAILED`. (b) Any fault after `placeOrder` has been invoked is `FAILED: ORDER_UNCERTAIN`, never `SESSION`. (c) `placeOrder` has one call site (`place()`), which flips the run's `sent` flag before calling; the structure spec pins that. (d) Belt-and-braces: a live plan with an unverified unit is refused even though `planExitOrder` never returns one. (e) In confirm, an order-book read that does not contain our order keeps the last seen status.
- **Task 9 — `SessionSource`.** `owner-broker-session.provider.ts` now imports it from `../domain/auto-exit.types` (Stream B's temporary local type removed).
- **Task 10 — ENABLED line** ends `qty-units=NFO:units,BFO:units[,MCX:…]`. `onModuleDestroy` also clears the cached config so a stray `runOnce` after shutdown is a no-op. Added `sentinel-executor.module.spec.ts`: compiles the module's providers/controllers against faked imports (proves DI wiring) and asserts a default boot makes no query and no broker call.
- **Task 11 — structure spec** additionally pins: exactly one `.placeOrder(` call site in executor source; no `coreEntryAllowed` / `KillSwitch` / `AngelOneAuthService` reference; no `@Cron(`; the poller calls `bootJobsEnabled()`. The controller also 403s a request with no user.

### Review fixes (2026-10-13, after the branch review)

The review found a real path to a second exit order that reverses the owner's position. Root cause: `smartapi-javascript@1.0.27` (`lib/smartapi-connect.js`, axios response-error interceptor) **resolves instead of rejecting**: a network error or its own 7 s axios timeout (`config/api.js`) → `{}`; an HTTP error → `{ status: <http>, message: <statusText> }`; an interceptor fault → `[]`. Our 15 s `withTimeout` never fires first. The legacy `placeOrder` mapping turns any answer without `data.orderid` into `REJECTED`, so the executor recorded `REJECTED: BROKER_REJECTED` for an order that may exist, R9's `FAILED → ORDER_UNCERTAIN` was unreachable in practice, and the next `EXIT_NOW` (with only a 60 s `PLACED` in-flight window and FAILED rows ignored) could send a second exit.

1. **Placement outcome is classified (supersedes R9's trigger).** New `UserBrokerSession.placeOrderClassified(order, tag)` → `{ status: 'PLACED' | 'REJECTED' | 'UNCERTAIN' }` via the pure `classifyPlaceOrderResponse`. `REJECTED` only when Angel itself answered `status: false` / `success: false` with its own `message` or `errorcode`; `{}`, `{status:<http>}`, `[]`, `undefined`, a non-object, `status:false` with no message/code, `status:true` without an orderid, and any throw/timeout are `UNCERTAIN`. The legacy `placeOrder` is unchanged (auto-execution keeps its contract; the structure spec now forbids the legacy call in executor source). In the executor every placement that is not PLACED-with-an-id is settled from the **order book by our own `ordertag`** (`settleUnplaced`, after a 2 s grace for non-definitive answers): book not answered → `FAILED: ORDER_UNCERTAIN`; our tag live/complete → `PLACED` with the book's order id, then the R10 confirm; our tag rejected/cancelled → `REJECTED` (MARKET refusal → the one fallback); no tag + definitive Angel rejection → `REJECTED` (MARKET refusal → fallback); no tag otherwise → `FAILED: ORDER_UNCERTAIN`. A MARKET refusal inside an HTTP-error shape never triggers the fallback. The LIMIT leg settles the same way and never falls back. Tests drive the SDK shapes through the **real** `AngelOneUserBrokerSession` (`factory.borrow` over a fake client) into the executor.
2. **Unknown-fate orders block later verdicts (supersedes R3's DB in-flight rule).** `hasInFlight(trackerId, excludeId, now, { userId, exchange, token })` blocks on any other row that is `CLAIMED`, or — created since the current IST midnight — `PLACED` (any age; `FILLED` is settled) or `FAILED` with reason `ORDER_UNCERTAIN` / `INTERRUPTED` (`UNKNOWN_FATE_REASONS`), matched on the tracker **or** the same user + exchange + token (rows carry the planned contract before the order is sent). Skip reason stays `EXIT_IN_FLIGHT`. The daily cap counts `PLACED`, `FILLED`, `DRY_RUN` and `FAILED` with an unknown-fate reason. `preOrderCheck` (so also before the LIMIT fallback) refuses `PRIOR_AI_EXIT_TODAY` when today's order book has any order on the contract whose `ordertag` starts with `ax` (`AI_EXIT_TAG_PREFIX`) and whose status is not rejected/cancelled; it runs before `OPEN_ORDER_EXISTS`. Consequence: at most one AI exit per contract per IST day unless every earlier one was rejected/cancelled. (auto-execution tags are sha256 hex and can never start with `ax`.)
3. **Dry-run never logs in.** `OwnerBrokerSessionProvider.withOwnerSession(userId, fn, { allowEphemeralLogin })` — default `false`; the executor passes `cfg.mode === 'live'`. With no feed session and no permission it throws `NoFeedSessionError` before any decrypt/login → row `SKIPPED: NO_FEED_SESSION`. A warm feed session is still borrowed in dry-run.
4. **Cap is counted per mode.** `countCountedSince(userId, since, mode)`: dry-run rows never use up the live cap and vice versa.
5. **The borrowed feed session is leased.** `UserFeedManager.leaseRestClient(userId)` returns the warm client plus an idempotent `release()`; while held it counts as live interest, so the idle timer and LRU eviction cannot dispose the session mid-order. The provider releases in `finally`. (It does not stop the session's own re-login after a socket drop.)
6. **Documented behaviour: any resting order blocks.** A position with ANY non-terminal order on its exchange+token — including the owner's own stop-loss or target order — is never auto-exited (`OPEN_ORDER_EXISTS`); the executor never cancels or modifies the owner's orders. To let the AI exit such a position the owner must cancel the resting order first.

Production gate impact: in the dry-run session `SKIPPED: NO_FEED_SESSION` means the hub's owner feed was down (not an executor fault), and `PRIOR_AI_EXIT_TODAY` / `EXIT_IN_FLIGHT` after an `ORDER_UNCERTAIN` row is the intended block — reconcile that row against the Angel order book by its `axM…`/`axL…` tag.

**Not changed here — the existing auto-execution pipeline has the same misclassification.** `auto-execution.service.ts` places real entry orders through the legacy `session.placeOrder(order, idempotencyKey)`. On an SDK network error/timeout (`{}`) or HTTP error (`{status:5xx}`) that returns `REJECTED`, which the service treats as a terminal broker rejection: `claims.markFailed`, audit `ORDER_REJECTED{BROKER_REJECT}`, swallowed. If Angel had in fact accepted the order, a real position exists with no `ORDER_PLACED` audit and no placed claim (breaking its own "an order must never exist without its audit row" rule). It cannot double-place (the idempotency claim is held and a Bull retry re-hits it), so the risk is an untracked live entry rather than a reversal. The shared `AngelOneAdapterService.placeOrder` (used by the trade-engine's live entries, SL orders and closes when a broker adapter is wired) uses the same `!response?.data?.orderid → REJECTED` mapping. Suggested follow-up: switch auto-execution to `placeOrderClassified`, treat `UNCERTAIN` as "reconcile by `ordertag` in the order book" before settling the claim.

## Review Focus

1. **Duplicate order impossibility** — two passes, a restart, or two `EXIT_NOW` verdicts 30 s apart for the same tracker must yield at most one live order per position at a time. Owners: Task 5 (unique claim → `null` on P2002, in-flight query), Task 9 (`second verdict while first order is open → OPEN_ORDER_EXISTS`, `claim lost → no broker call`), Task 10 (single-flight pass).
2. **Never exceed or reverse a position** — quantity is always `|netqty|` of a fresh read; long → SELL, short → BUY; ambiguous rows, side mismatch, open orders, or a changed quantity before the fallback all stop the order. Owners: Task 3 (`planExitOrder` table), Task 9 (`fallback aborts when quantity changed`).
3. **Claim before call + crash semantics** — the row exists (status `CLAIMED`, then planned order fields) before `placeOrder`; a crash leaves `CLAIMED` and the sweep turns it into `FAILED: INTERRUPTED`, never a resend; a `placeOrder` timeout is `FAILED: ORDER_UNCERTAIN`, never retried. Owners: Task 5 (sweep), Task 9 (`claim precedes placeOrder` ordering assertion, `timeout → ORDER_UNCERTAIN, one call`).
4. **Dry-run sends nothing** — in `dry-run` the session's `placeOrder` is never invoked, yet the row carries the exact order and counts toward the cap. Owner: Task 9.
5. **Disabled = zero broker calls and zero queries** — `AI_AUTO_EXIT_ENABLED` unset/false, `BOOT_JOBS=false`, or an empty allow-list ⇒ no interval, no sweep, no repository or session call. Owner: Task 10.

---

## File Structure

**Create (api):**
- `prisma/migrations/20261012140000_sentinel_auto_exit/migration.sql` — the `ai_exit_executions` table.
- `apps/api/src/modules/sentinel-executor/sentinel-executor.module.ts` — wiring.
- `apps/api/src/modules/sentinel-executor/domain/auto-exit.types.ts` — shared types/constants.
- `apps/api/src/modules/sentinel-executor/domain/auto-exit.config.ts` (+ `.spec.ts`) — pure env parser.
- `apps/api/src/modules/sentinel-executor/domain/exit-order.ts` (+ `.spec.ts`) — pure order planning, tick/limit math, tag, refusal classifier, order-book helpers, IST day start.
- `apps/api/src/modules/sentinel-executor/domain/guards.ts` (+ `.spec.ts`) — pure guard table.
- `apps/api/src/modules/sentinel-executor/repositories/ai-exit-execution.repository.ts` (+ `.spec.ts`) — claim, patch, counts, in-flight, sweep, poll query, list.
- `apps/api/src/modules/sentinel-executor/services/owner-broker-session.provider.ts` (+ `.spec.ts`) — R1 tier selection.
- `apps/api/src/modules/sentinel-executor/services/sentinel-exit-executor.service.ts` (+ `.spec.ts`) — one verdict's flow.
- `apps/api/src/modules/sentinel-executor/services/sentinel-exit-poller.service.ts` (+ `.spec.ts`) — interval, gating, sweep.
- `apps/api/src/modules/sentinel-executor/controllers/sentinel-executor.controller.ts` (+ `.spec.ts`) — GET executions.
- `apps/api/src/modules/sentinel-executor/dto/ai-exit-execution.dto.ts` — wire DTO.
- `apps/api/src/modules/sentinel-executor/sentinel-executor.structure.spec.ts` — import isolation.
- `apps/api/src/modules/auto-execution/services/per-user-broker-session.factory.spec.ts` — new spec for `borrow` + order book.

**Modify (api):**
- `prisma/schema.prisma` — add `model AiExitExecution`.
- `apps/api/src/modules/auto-execution/services/per-user-broker-session.factory.ts` — `getOrderBook` on `UserSmartApiLike`, `getOrderBookEnvelope` on `UserBrokerSession`, `borrow()`.
- `apps/api/src/modules/market-data/services/user-feed.types.ts` — optional `restClient?()` on `UserFeedSessionLike`.
- `apps/api/src/modules/market-data/services/user-feed-session.ts` (+ spec) — `restReady` flag + `restClient()`.
- `apps/api/src/modules/market-data/services/user-feed-manager.service.ts` (+ spec) — `warmRestClient(userId)` (never creates a session).
- `apps/api/src/app.module.ts` — import `SentinelExecutorModule`.
- `deploy/env/api.env.example` — the six `AI_AUTO_EXIT_*` vars.

**Create (web):**
- `apps/web/src/components/charts/aiExitView.ts` (+ `aiExitView.test.ts`) — pure row view.
- `apps/web/src/hooks/useAiExits.ts` — fail-quiet poller.
- `apps/web/src/components/charts/AiExitsList.tsx` — the list.

**Modify (web):** `apps/web/src/pages/charts/ChartsPage.tsx` — render `<AiExitsList />` under `SentinelPanel`.

## Parallel Streams

Owner prefers parallel worktree streams. Three streams can start at once from `docs/sentinel-auto-exit` (each in its own worktree with absolute-target `node_modules` junctions); the integration stream starts when A and B are merged back.

| Stream | Tasks | Depends on |
|---|---|---|
| A — data + pure domain | 1, 2, 3, 4, 5 | — (5 after 1) |
| B — broker seam | 6, 7, 8 | — (8 after 6, 7) |
| C — web | 12 | only the DTO contract in Task 11 (copied into Task 12) |
| D — integration (sequential) | 9, 10, 11, 13 | A + B merged |

Merge order: A → B → D (9, 10, 11) → C → 13. Streams touch disjoint files except `prisma/schema.prisma` (A only) and `app.module.ts` (D only).

---

## Task 1: `ai_exit_executions` table (Stream A)

**Files:**
- Modify: `prisma/schema.prisma` (append after `model SentinelVerdict`, ~line 1649)
- Create: `prisma/migrations/20261012140000_sentinel_auto_exit/migration.sql`

**Interfaces:**
- Produces: Prisma delegate `prisma.aiExitExecution` and type `AiExitExecution` from `@prisma/client` with the fields below.

- [ ] **Step 1: Add the model**

Append to `prisma/schema.prisma` directly after the closing brace of `model SentinelVerdict`:

```prisma
/// One row per sentinel EXIT_NOW verdict the auto-exit executor picked up
/// (docs/superpowers/specs/2026-10-12-sentinel-auto-exit-design.md §6).
/// Inserted (status CLAIMED) BEFORE any broker call: the unique verdictId is the
/// idempotency anchor. No FK, like sentinel_verdicts.
model AiExitExecution {
  id            String   @id @default(cuid())
  userId        String
  verdictId     String   @unique
  trackerId     String
  symbol        String
  exchange      String?
  token         String?
  side          String?  // 'BUY' | 'SELL'
  quantity      Int?
  productType   String?  // 'INTRADAY' | 'CARRYFORWARD' | 'DELIVERY'
  orderType     String?  // 'MARKET' | 'LIMIT'
  limitPrice    Float?
  mode          String   // 'dry-run' | 'live'
  status        String   // 'CLAIMED' | 'SKIPPED' | 'DRY_RUN' | 'PLACED' | 'FILLED' | 'REJECTED' | 'FAILED'
  reason        String?
  sessionSource String?  // 'user-feed' | 'ephemeral'
  brokerOrderId String?
  brokerMessage String?
  orderStatus   String?  // last broker order-book status seen
  marketOrderId String?  // the refused MARKET order when the LIMIT fallback ran
  verdictReason String
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  @@index([userId, createdAt])
  @@index([status, createdAt])
  @@index([trackerId, createdAt])
  @@map("ai_exit_executions")
}
```

- [ ] **Step 2: Write the migration**

Create `prisma/migrations/20261012140000_sentinel_auto_exit/migration.sql`:

```sql
-- Sentinel auto-exit (docs/superpowers/plans/2026-10-12-sentinel-auto-exit.md).
--
-- Expand-only: one new table with its indexes and CHECKs. No existing table,
-- column, index or function is touched. No FK (mirrors sentinel_verdicts).

CREATE TABLE "ai_exit_executions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "verdictId" TEXT NOT NULL,
    "trackerId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "exchange" TEXT,
    "token" TEXT,
    "side" TEXT,
    "quantity" INTEGER,
    "productType" TEXT,
    "orderType" TEXT,
    "limitPrice" DOUBLE PRECISION,
    "mode" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reason" TEXT,
    "sessionSource" TEXT,
    "brokerOrderId" TEXT,
    "brokerMessage" TEXT,
    "orderStatus" TEXT,
    "marketOrderId" TEXT,
    "verdictReason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_exit_executions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ai_exit_executions_verdictId_key" ON "ai_exit_executions"("verdictId");
CREATE INDEX "ai_exit_executions_userId_createdAt_idx" ON "ai_exit_executions"("userId", "createdAt");
CREATE INDEX "ai_exit_executions_status_createdAt_idx" ON "ai_exit_executions"("status", "createdAt");
CREATE INDEX "ai_exit_executions_trackerId_createdAt_idx" ON "ai_exit_executions"("trackerId", "createdAt");

ALTER TABLE "ai_exit_executions" ADD CONSTRAINT "ai_exit_executions_vocab_check" CHECK (
    "status" IN ('CLAIMED', 'SKIPPED', 'DRY_RUN', 'PLACED', 'FILLED', 'REJECTED', 'FAILED')
    AND "mode" IN ('dry-run', 'live')
    AND ("side" IS NULL OR "side" IN ('BUY', 'SELL'))
);
```

- [ ] **Step 3: Validate and generate**

Run (repo root): `npx prisma validate --schema prisma/schema.prisma`
Expected: `The schema at prisma/schema.prisma is valid`.

Run: `npx prisma generate --schema prisma/schema.prisma`
Expected: `Generated Prisma Client`. Then `cd apps/api && npx tsc --noEmit -p tsconfig.json` → exit 0.

- [ ] **Step 4: Check the migration matches the model**

Run: `npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url "$SHADOW_DATABASE_URL" --script` only if a disposable local Postgres is available; otherwise compare by eye: every column, type, nullability and the four indexes above must match the model. (The CHECK is migration-only, as in `20261012120000_sp2_m4_lifecycle`.)

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20261012140000_sentinel_auto_exit/migration.sql
git commit -m "feat(sentinel-executor): ai_exit_executions table (expand-only)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Config parser (Stream A)

**Files:**
- Create: `apps/api/src/modules/sentinel-executor/domain/auto-exit.types.ts`
- Create: `apps/api/src/modules/sentinel-executor/domain/auto-exit.config.ts`
- Test: `apps/api/src/modules/sentinel-executor/domain/auto-exit.config.spec.ts`

**Interfaces:**
- Produces:
  - `type AutoExitMode = 'dry-run' | 'live'`
  - `type AiExitStatus = 'CLAIMED' | 'SKIPPED' | 'DRY_RUN' | 'PLACED' | 'FILLED' | 'REJECTED' | 'FAILED'`
  - `type SessionSource = 'user-feed' | 'ephemeral'`
  - `const COUNTED_STATUSES: readonly AiExitStatus[]` = `['PLACED','FILLED','DRY_RUN']`
  - `const AUTO_EXIT_EXCHANGES: readonly string[]` = `['NFO','BFO','MCX']`
  - `interface AutoExitConfig { enabled: boolean; mode: AutoExitMode; userIds: string[]; dailyCap: number; maxVerdictAgeSec: number; limitFallbackPct: number; problems: string[] }`
  - `function parseAutoExitConfig(env: Record<string, string | undefined>): AutoExitConfig`

- [ ] **Step 1: Write the types file**

```ts
// apps/api/src/modules/sentinel-executor/domain/auto-exit.types.ts
export type AutoExitMode = 'dry-run' | 'live';

export type AiExitStatus =
  | 'CLAIMED'
  | 'SKIPPED'
  | 'DRY_RUN'
  | 'PLACED'
  | 'FILLED'
  | 'REJECTED'
  | 'FAILED';

/** Which broker session served the attempt (plan ruling R1). */
export type SessionSource = 'user-feed' | 'ephemeral';

/** Statuses that count toward the per-user IST-day cap (spec §5.3). */
export const COUNTED_STATUSES: readonly AiExitStatus[] = ['PLACED', 'FILLED', 'DRY_RUN'];

/** Only derivative venues are in scope (spec §3). */
export const AUTO_EXIT_EXCHANGES: readonly string[] = ['NFO', 'BFO', 'MCX'];

export interface AutoExitConfig {
  enabled: boolean;
  mode: AutoExitMode;
  userIds: string[];
  dailyCap: number;
  maxVerdictAgeSec: number;
  limitFallbackPct: number;
  /** Human-readable notes about values that were ignored in favour of a safe default. */
  problems: string[];
}
```

- [ ] **Step 2: Write the failing test**

```ts
// apps/api/src/modules/sentinel-executor/domain/auto-exit.config.spec.ts
import { parseAutoExitConfig } from './auto-exit.config';

describe('parseAutoExitConfig', () => {
  it('defaults are safe: disabled, dry-run, nobody, cap 5, 90 s, 2 %', () => {
    expect(parseAutoExitConfig({})).toEqual({
      enabled: false,
      mode: 'dry-run',
      userIds: [],
      dailyCap: 5,
      maxVerdictAgeSec: 90,
      limitFallbackPct: 2,
      problems: [],
    });
  });

  it('enabled only on the exact string "true"', () => {
    expect(parseAutoExitConfig({ AI_AUTO_EXIT_ENABLED: 'true' }).enabled).toBe(true);
    expect(parseAutoExitConfig({ AI_AUTO_EXIT_ENABLED: 'TRUE' }).enabled).toBe(false);
    expect(parseAutoExitConfig({ AI_AUTO_EXIT_ENABLED: '1' }).enabled).toBe(false);
  });

  it('live only on the exact string "live"; anything unknown falls back to dry-run with a problem', () => {
    expect(parseAutoExitConfig({ AI_AUTO_EXIT_MODE: 'live' }).mode).toBe('live');
    expect(parseAutoExitConfig({ AI_AUTO_EXIT_MODE: 'dry-run' }).mode).toBe('dry-run');
    const c = parseAutoExitConfig({ AI_AUTO_EXIT_MODE: 'LIVE' });
    expect(c.mode).toBe('dry-run');
    expect(c.problems).toEqual([expect.stringContaining('AI_AUTO_EXIT_MODE')]);
  });

  it('allow-list is trimmed, de-duplicated, blanks dropped', () => {
    expect(parseAutoExitConfig({ AI_AUTO_EXIT_USER_IDS: ' u1, ,u2,u1 ' }).userIds).toEqual(['u1', 'u2']);
  });

  it('out-of-range numbers fall back to defaults with a problem each', () => {
    const c = parseAutoExitConfig({
      AI_AUTO_EXIT_DAILY_CAP: '-1',
      AI_AUTO_EXIT_MAX_VERDICT_AGE_SEC: '5',
      AI_AUTO_EXIT_LIMIT_FALLBACK_PCT: '25',
    });
    expect([c.dailyCap, c.maxVerdictAgeSec, c.limitFallbackPct]).toEqual([5, 90, 2]);
    expect(c.problems).toHaveLength(3);
  });

  it('accepts in-range values, including a cap of 0 (every exit skipped)', () => {
    const c = parseAutoExitConfig({
      AI_AUTO_EXIT_DAILY_CAP: '0',
      AI_AUTO_EXIT_MAX_VERDICT_AGE_SEC: '120',
      AI_AUTO_EXIT_LIMIT_FALLBACK_PCT: '1.5',
    });
    expect([c.dailyCap, c.maxVerdictAgeSec, c.limitFallbackPct, c.problems]).toEqual([0, 120, 1.5, []]);
  });

  it('a non-integer cap is rejected', () => {
    expect(parseAutoExitConfig({ AI_AUTO_EXIT_DAILY_CAP: '2.5' }).dailyCap).toBe(5);
  });
});
```

- [ ] **Step 3: Run it — expect FAIL**

Run: `cd apps/api && npx jest src/modules/sentinel-executor/domain/auto-exit.config.spec.ts`
Expected: FAIL — `Cannot find module './auto-exit.config'`.

- [ ] **Step 4: Implement**

```ts
// apps/api/src/modules/sentinel-executor/domain/auto-exit.config.ts
import type { AutoExitConfig, AutoExitMode } from './auto-exit.types';

const DEFAULTS = { dailyCap: 5, maxVerdictAgeSec: 90, limitFallbackPct: 2 } as const;

function num(
  raw: string | undefined,
  name: string,
  fallback: number,
  ok: (n: number) => boolean,
  problems: string[],
): number {
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (Number.isFinite(n) && ok(n)) return n;
  problems.push(`${name}=${raw} is out of range — using ${fallback}`);
  return fallback;
}

/**
 * Pure parse of the AI_AUTO_EXIT_* env (spec §7). Every unknown or out-of-range
 * value falls back to the SAFE default and is reported in `problems`, never thrown:
 * a typo must not stop the API from booting, and must not widen what the executor does.
 */
export function parseAutoExitConfig(env: Record<string, string | undefined>): AutoExitConfig {
  const problems: string[] = [];

  const rawMode = (env.AI_AUTO_EXIT_MODE ?? '').trim();
  let mode: AutoExitMode = 'dry-run';
  if (rawMode === 'live') mode = 'live';
  else if (rawMode !== '' && rawMode !== 'dry-run') {
    problems.push(`AI_AUTO_EXIT_MODE=${rawMode} is not dry-run|live — using dry-run`);
  }

  const userIds = [
    ...new Set(
      String(env.AI_AUTO_EXIT_USER_IDS ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];

  return {
    enabled: env.AI_AUTO_EXIT_ENABLED === 'true',
    mode,
    userIds,
    dailyCap: num(env.AI_AUTO_EXIT_DAILY_CAP, 'AI_AUTO_EXIT_DAILY_CAP', DEFAULTS.dailyCap,
      (n) => Number.isInteger(n) && n >= 0 && n <= 50, problems),
    maxVerdictAgeSec: num(env.AI_AUTO_EXIT_MAX_VERDICT_AGE_SEC, 'AI_AUTO_EXIT_MAX_VERDICT_AGE_SEC',
      DEFAULTS.maxVerdictAgeSec, (n) => Number.isInteger(n) && n >= 10 && n <= 600, problems),
    limitFallbackPct: num(env.AI_AUTO_EXIT_LIMIT_FALLBACK_PCT, 'AI_AUTO_EXIT_LIMIT_FALLBACK_PCT',
      DEFAULTS.limitFallbackPct, (n) => n >= 0.5 && n <= 10, problems),
    problems,
  };
}
```

- [ ] **Step 5: Run it — expect PASS**

Run: `cd apps/api && npx jest src/modules/sentinel-executor/domain/auto-exit.config.spec.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/sentinel-executor/domain/auto-exit.types.ts apps/api/src/modules/sentinel-executor/domain/auto-exit.config.ts apps/api/src/modules/sentinel-executor/domain/auto-exit.config.spec.ts
git commit -m "feat(sentinel-executor): safe-default AI_AUTO_EXIT_* config parser

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Exit-order domain — sizing, side, product, tick, LIMIT, tag, refusal, order book (Stream A)

**Files:**
- Create: `apps/api/src/modules/sentinel-executor/domain/exit-order.ts`
- Test: `apps/api/src/modules/sentinel-executor/domain/exit-order.spec.ts`

**Interfaces:**
- Consumes: `OrderRequest` from `apps/api/src/common/interfaces/broker-adapter.interface.ts`.
- Produces:
  - `type ExitPlan = { ok: true; order: OrderRequest; netQty: number; ltp: number } | { ok: false; reason: string }`
  - `function planExitOrder(rows: unknown[], target: { exchange: string; token: string; trackerQty: number }): ExitPlan`
  - `function tickRupees(raw: number | null | undefined, exchange: string): number`
  - `function limitFallbackPrice(side: 'BUY' | 'SELL', ltp: number, pct: number, tick: number): number | null`
  - `function aiExitOrderTag(verdictId: string, leg: 'M' | 'L'): string`
  - `function isMarketRefusal(text: string | null | undefined): boolean`
  - `interface OrderBookEntry { status: string; text: string }`
  - `function findOrder(rows: unknown[], orderId: string): OrderBookEntry | null`
  - `function isTerminalOrderStatus(status: string): boolean`
  - `function hasOpenOrderFor(rows: unknown[], exchange: string, token: string): boolean`
  - `function isFlat(rows: unknown[], exchange: string, token: string): boolean`
  - `function istDayStartUtc(now: Date): Date`

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/modules/sentinel-executor/domain/exit-order.spec.ts
import {
  aiExitOrderTag,
  findOrder,
  hasOpenOrderFor,
  isFlat,
  isMarketRefusal,
  isTerminalOrderStatus,
  istDayStartUtc,
  limitFallbackPrice,
  planExitOrder,
  tickRupees,
} from './exit-order';

const row = (over: Record<string, unknown> = {}) => ({
  tradingsymbol: 'CRUDEOIL15OCT268950CE',
  symboltoken: '445566',
  exchange: 'MCX',
  producttype: 'CARRYFORWARD',
  netqty: '100',
  ltp: '50.25',
  ...over,
});
const target = { exchange: 'MCX', token: '445566', trackerQty: 100 };

describe('planExitOrder', () => {
  it('long → SELL the whole |netqty| at MARKET, identity from the broker row', () => {
    const p = planExitOrder([row()], target);
    expect(p).toEqual({
      ok: true,
      netQty: 100,
      ltp: 50.25,
      order: {
        symbol: 'CRUDEOIL15OCT268950CE',
        token: '445566',
        exchange: 'MCX',
        side: 'SELL',
        orderType: 'MARKET',
        quantity: 100,
        positionType: 'CARRYFORWARD',
      },
    });
  });

  it('short → BUY to cover |netqty|', () => {
    const p = planExitOrder([row({ netqty: '-75', exchange: 'NFO', producttype: 'INTRADAY' })], {
      exchange: 'NFO', token: '445566', trackerQty: -75,
    });
    expect(p.ok && [p.order.side, p.order.quantity, p.order.positionType]).toEqual(['BUY', 75, 'INTRADAY']);
  });

  it('netqty 0 or no row → ALREADY_FLAT', () => {
    expect(planExitOrder([row({ netqty: '0' })], target)).toEqual({ ok: false, reason: 'ALREADY_FLAT' });
    expect(planExitOrder([], target)).toEqual({ ok: false, reason: 'ALREADY_FLAT' });
  });

  it('a row on another exchange with the same token is not ours', () => {
    expect(planExitOrder([row({ exchange: 'NSE' })], target)).toEqual({ ok: false, reason: 'ALREADY_FLAT' });
  });

  it('two non-flat rows for one contract (intraday + carry) → AMBIGUOUS_POSITION_ROWS, never guess', () => {
    const p = planExitOrder([row(), row({ producttype: 'INTRADAY', netqty: '50' })], target);
    expect(p).toEqual({ ok: false, reason: 'AMBIGUOUS_POSITION_ROWS' });
  });

  it('broker side opposite to the tracker side → SIDE_MISMATCH (would reverse)', () => {
    expect(planExitOrder([row({ netqty: '-100' })], target)).toEqual({ ok: false, reason: 'SIDE_MISMATCH' });
  });

  it('unknown product → UNKNOWN_PRODUCT', () => {
    expect(planExitOrder([row({ producttype: 'BO' })], target)).toEqual({
      ok: false, reason: 'UNKNOWN_PRODUCT:BO',
    });
  });

  it('non-integer quantity → BAD_QTY', () => {
    expect(planExitOrder([row({ netqty: '1.5' })], target)).toEqual({ ok: false, reason: 'BAD_QTY' });
  });

  it('missing tradingsymbol → NO_SYMBOL', () => {
    expect(planExitOrder([row({ tradingsymbol: '' })], target)).toEqual({ ok: false, reason: 'NO_SYMBOL' });
  });
});

describe('tickRupees (ruling R5)', () => {
  it('master paise → rupees', () => {
    expect(tickRupees(5, 'NFO')).toBe(0.05);
    expect(tickRupees(10, 'MCX')).toBe(0.1);
    expect(tickRupees(100, 'MCX')).toBe(1);
  });
  it('a sub-1 value is already rupees (column default)', () => {
    expect(tickRupees(0.05, 'NFO')).toBe(0.05);
  });
  it('missing → 0.05 for NFO/BFO, 1.00 for MCX', () => {
    expect(tickRupees(null, 'NFO')).toBe(0.05);
    expect(tickRupees(undefined, 'BFO')).toBe(0.05);
    expect(tickRupees(0, 'MCX')).toBe(1);
  });
});

describe('limitFallbackPrice', () => {
  it('SELL: LTP − pct, floored to the tick', () => {
    expect(limitFallbackPrice('SELL', 50.25, 2, 0.05)).toBe(49.2); // 49.245 → 49.20
  });
  it('BUY: LTP + pct, ceiled to the tick', () => {
    expect(limitFallbackPrice('BUY', 50.25, 2, 0.05)).toBe(51.3); // 51.255 → 51.30
  });
  it('MCX ₹1 tick', () => {
    expect(limitFallbackPrice('SELL', 6123.4, 2, 1)).toBe(6000);
  });
  it('no LTP or a non-positive SELL price → null', () => {
    expect(limitFallbackPrice('SELL', 0, 2, 0.05)).toBeNull();
    expect(limitFallbackPrice('SELL', 0.04, 2, 0.05)).toBeNull();
  });
  it('is free of float dust', () => {
    expect(String(limitFallbackPrice('SELL', 10.1, 2, 0.05))).toBe('9.85');
  });
});

describe('aiExitOrderTag (ruling R4)', () => {
  it('≤ 20 alphanumeric chars, leg-distinguished, deterministic', () => {
    const id = 'cm9x1abcde0001fghijklmnop';
    const m = aiExitOrderTag(id, 'M');
    const l = aiExitOrderTag(id, 'L');
    expect(m).toMatch(/^[A-Za-z0-9]{1,20}$/);
    expect(m).toBe('axMde0001fghijklmnop'); // 'ax' + leg + last 17 of the 25-char cuid
    expect(m).not.toBe(l);
    expect(aiExitOrderTag(id, 'M')).toBe(m);
  });
  it('strips non-alphanumerics', () => {
    expect(aiExitOrderTag('a-b_c', 'L')).toBe('axLabc');
  });
});

describe('isMarketRefusal (ruling R6)', () => {
  it.each([
    'Market orders are not allowed for this instrument',
    'MARKET order blocked in stock options, place a LIMIT order',
    'market price orders not permitted',
  ])('true for %s', (t) => expect(isMarketRefusal(t)).toBe(true));
  it.each([
    'Insufficient funds',
    'Order not allowed: RMS margin exceeds',
    '',
    null,
  ])('false for %s', (t) => expect(isMarketRefusal(t as string | null)).toBe(false));
});

describe('order book helpers', () => {
  const book = [
    { orderid: 'A1', status: 'rejected', text: 'Market orders are not allowed', symboltoken: '445566', exchange: 'MCX' },
    { orderid: 'A2', status: 'open', text: '', symboltoken: '999', exchange: 'NFO' },
    { orderid: 'A3', status: 'complete', text: '', symboltoken: '445566', exchange: 'MCX' },
  ];
  it('findOrder', () => {
    expect(findOrder(book, 'A1')).toEqual({ status: 'rejected', text: 'Market orders are not allowed' });
    expect(findOrder(book, 'ZZ')).toBeNull();
  });
  it('terminal statuses', () => {
    expect(['complete', 'rejected', 'cancelled'].every(isTerminalOrderStatus)).toBe(true);
    expect(['open', 'trigger pending', 'validation pending', ''].some(isTerminalOrderStatus)).toBe(false);
  });
  it('hasOpenOrderFor: any non-terminal order on exchange+token (unknown status counts as open)', () => {
    expect(hasOpenOrderFor(book, 'MCX', '445566')).toBe(false);
    expect(hasOpenOrderFor(book, 'NFO', '999')).toBe(true);
    expect(hasOpenOrderFor([{ orderid: 'X', status: 'weird', symboltoken: '1', exchange: 'NFO' }], 'NFO', '1')).toBe(true);
  });
  it('isFlat', () => {
    expect(isFlat([row({ netqty: '0' })], 'MCX', '445566')).toBe(true);
    expect(isFlat([row()], 'MCX', '445566')).toBe(false);
    expect(isFlat([], 'MCX', '445566')).toBe(true);
  });
});

describe('istDayStartUtc', () => {
  it('23:59 IST and 00:01 IST next day fall on different days', () => {
    // 2026-10-12 23:59 IST = 18:29Z; 2026-10-13 00:01 IST = 18:31Z
    expect(istDayStartUtc(new Date('2026-10-12T18:29:00Z')).toISOString()).toBe('2026-10-11T18:30:00.000Z');
    expect(istDayStartUtc(new Date('2026-10-12T18:31:00Z')).toISOString()).toBe('2026-10-12T18:30:00.000Z');
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `cd apps/api && npx jest src/modules/sentinel-executor/domain/exit-order.spec.ts`
Expected: FAIL — `Cannot find module './exit-order'`.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/modules/sentinel-executor/domain/exit-order.ts
import type { OrderRequest } from '../../../common/interfaces/broker-adapter.interface';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const PRODUCTS = new Set(['INTRADAY', 'CARRYFORWARD', 'DELIVERY']);
const TERMINAL = new Set(['complete', 'rejected', 'cancelled']);

type Row = Record<string, unknown>;

function toNum(v: unknown): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : 0;
}
const up = (v: unknown) => String(v ?? '').trim().toUpperCase();
const matches = (r: Row, exchange: string, token: string) =>
  String(r?.symboltoken ?? '') === token && up(r?.exchange) === up(exchange);

export type ExitPlan =
  | { ok: true; order: OrderRequest; netQty: number; ltp: number }
  | { ok: false; reason: string };

/**
 * The closing order for ONE contract, from a fresh broker positions array
 * (spec §5.4–5.5, plan ruling R3). Whole position only: quantity = |netqty|.
 * Identity (symbol, token, exchange, product) comes from the broker row, never the tracker.
 */
export function planExitOrder(
  rows: unknown[],
  target: { exchange: string; token: string; trackerQty: number },
): ExitPlan {
  const live = (rows as Row[]).filter((r) => matches(r, target.exchange, target.token) && toNum(r?.netqty) !== 0);
  if (live.length === 0) return { ok: false, reason: 'ALREADY_FLAT' };
  if (live.length > 1) return { ok: false, reason: 'AMBIGUOUS_POSITION_ROWS' };
  const r = live[0];
  const netQty = toNum(r.netqty);
  if (!Number.isInteger(netQty)) return { ok: false, reason: 'BAD_QTY' };
  if (target.trackerQty !== 0 && Math.sign(target.trackerQty) !== Math.sign(netQty)) {
    return { ok: false, reason: 'SIDE_MISMATCH' };
  }
  const product = up(r.producttype);
  if (!PRODUCTS.has(product)) return { ok: false, reason: `UNKNOWN_PRODUCT:${product || 'NONE'}` };
  const symbol = String(r.tradingsymbol ?? '').trim();
  if (!symbol) return { ok: false, reason: 'NO_SYMBOL' };
  return {
    ok: true,
    netQty,
    ltp: toNum(r.ltp),
    order: {
      symbol,
      token: String(r.symboltoken),
      exchange: up(r.exchange),
      side: netQty > 0 ? 'SELL' : 'BUY',
      orderType: 'MARKET',
      quantity: Math.abs(netQty),
      positionType: product as OrderRequest['positionType'],
    },
  };
}

/** Contract tick in RUPEES (plan ruling R5: the master stores paise). */
export function tickRupees(raw: number | null | undefined, exchange: string): number {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
  if (n >= 1) return n / 100;
  if (n > 0) return n;
  return up(exchange) === 'MCX' ? 1 : 0.05;
}

/** Aggressive LIMIT for the single fallback: SELL floors, BUY ceils, to the tick. */
export function limitFallbackPrice(
  side: 'BUY' | 'SELL',
  ltp: number,
  pct: number,
  tick: number,
): number | null {
  if (!(ltp > 0) || !(tick > 0)) return null;
  const raw = side === 'SELL' ? ltp * (1 - pct / 100) : ltp * (1 + pct / 100);
  const ticks = raw / tick;
  // 1e-9 guards against 49.2/0.05 = 983.9999999 flooring a whole tick away.
  const n = side === 'SELL' ? Math.floor(ticks + 1e-9) : Math.ceil(ticks - 1e-9);
  const price = Number((n * tick).toFixed(4));
  return price > 0 ? price : null;
}

/** Angel `ordertag` (plan ruling R4): 'ax' + leg + last 17 alphanumerics of the verdict id. */
export function aiExitOrderTag(verdictId: string, leg: 'M' | 'L'): string {
  const clean = String(verdictId).replace(/[^A-Za-z0-9]/g, '');
  return `ax${leg}${clean.slice(-17)}`;
}

/** Does this broker text say MARKET orders are refused for the instrument? (ruling R6) */
export function isMarketRefusal(text: string | null | undefined): boolean {
  const t = String(text ?? '').toLowerCase();
  if (!t.includes('market')) return false;
  return /(not\s+allowed|not\s+permitted|blocked|disallowed|not\s+available|only\s+limit|place\s+a?\s*limit)/.test(t);
}

export interface OrderBookEntry {
  status: string;
  text: string;
}

export function findOrder(rows: unknown[], orderId: string): OrderBookEntry | null {
  const r = (rows as Row[]).find((o) => String(o?.orderid ?? '') === orderId);
  if (!r) return null;
  return { status: String(r.status ?? r.orderstatus ?? '').toLowerCase(), text: String(r.text ?? '') };
}

export function isTerminalOrderStatus(status: string): boolean {
  return TERMINAL.has(String(status).toLowerCase());
}

/** Any order on this contract that is not complete/rejected/cancelled (unknown counts as open). */
export function hasOpenOrderFor(rows: unknown[], exchange: string, token: string): boolean {
  return (rows as Row[]).some(
    (o) => matches(o, exchange, token) && !isTerminalOrderStatus(String(o?.status ?? o?.orderstatus ?? '')),
  );
}

/** True when no broker row for the contract has a non-zero net quantity. */
export function isFlat(rows: unknown[], exchange: string, token: string): boolean {
  return !(rows as Row[]).some((r) => matches(r, exchange, token) && toNum(r?.netqty) !== 0);
}

/** UTC instant of the IST midnight that starts `now`'s IST day. */
export function istDayStartUtc(now: Date): Date {
  const d = new Date(now.getTime() + IST_OFFSET_MS);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - IST_OFFSET_MS);
}
```

- [ ] **Step 4: Run it — expect PASS**

Run: `cd apps/api && npx jest src/modules/sentinel-executor/domain/exit-order.spec.ts`
Expected: PASS (all). If `limitFallbackPrice('BUY', 50.25, 2, 0.05)` fails by one tick, inspect the epsilon, do not loosen the assertion.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/sentinel-executor/domain/exit-order.ts apps/api/src/modules/sentinel-executor/domain/exit-order.spec.ts
git commit -m "feat(sentinel-executor): pure exit-order planning, tick/LIMIT math, ordertag, refusal classifier

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Guard table (Stream A)

**Files:**
- Create: `apps/api/src/modules/sentinel-executor/domain/guards.ts`
- Test: `apps/api/src/modules/sentinel-executor/domain/guards.spec.ts`

**Interfaces:**
- Consumes: `AutoExitConfig`, `AUTO_EXIT_EXCHANGES` (Task 2).
- Produces:
  - `interface GuardInput { config: AutoExitConfig; now: Date; verdict: { userId: string; createdAt: Date }; tracker: { userId: string; status: string; kind: string; exchange: string } | null; isOpen: (exchange: string, at: Date) => boolean; countedToday: number; inFlight: boolean }`
  - `type GuardResult = { ok: true } | { ok: false; reason: string }`
  - `function evaluateGuards(i: GuardInput): GuardResult`
  - Reasons (exact strings): `DISABLED`, `NOT_ALLOWED_USER`, `STALE_VERDICT`, `TRACKER_MISSING`, `TRACKER_USER_MISMATCH`, `TRACKER_CLOSED`, `NOT_POSITION`, `EXCHANGE_NOT_FNO`, `EXCHANGE_CLOSED`, `EXIT_IN_FLIGHT`, `DAILY_CAP`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/modules/sentinel-executor/domain/guards.spec.ts
import { evaluateGuards, type GuardInput } from './guards';
import { parseAutoExitConfig } from './auto-exit.config';

const NOW = new Date('2026-10-12T10:00:00Z');
function input(over: Partial<GuardInput> = {}): GuardInput {
  return {
    config: parseAutoExitConfig({ AI_AUTO_EXIT_ENABLED: 'true', AI_AUTO_EXIT_USER_IDS: 'owner' }),
    now: NOW,
    verdict: { userId: 'owner', createdAt: new Date(NOW.getTime() - 10_000) },
    tracker: { userId: 'owner', status: 'OPEN', kind: 'POSITION', exchange: 'MCX' },
    isOpen: () => true,
    countedToday: 0,
    inFlight: false,
    ...over,
  };
}

describe('evaluateGuards', () => {
  it('all clear', () => expect(evaluateGuards(input())).toEqual({ ok: true }));

  it.each<[string, Partial<GuardInput>]>([
    ['DISABLED', { config: parseAutoExitConfig({ AI_AUTO_EXIT_USER_IDS: 'owner' }) }],
    ['NOT_ALLOWED_USER', { verdict: { userId: 'other', createdAt: NOW } }],
    ['STALE_VERDICT', { verdict: { userId: 'owner', createdAt: new Date(NOW.getTime() - 91_000) } }],
    ['TRACKER_MISSING', { tracker: null }],
    ['TRACKER_USER_MISMATCH', { tracker: { userId: 'other', status: 'OPEN', kind: 'POSITION', exchange: 'MCX' } }],
    ['TRACKER_CLOSED', { tracker: { userId: 'owner', status: 'CLOSED', kind: 'POSITION', exchange: 'MCX' } }],
    ['NOT_POSITION', { tracker: { userId: 'owner', status: 'OPEN', kind: 'HOLDING', exchange: 'NSE' } }],
    ['EXCHANGE_NOT_FNO', { tracker: { userId: 'owner', status: 'OPEN', kind: 'POSITION', exchange: 'NSE' } }],
    ['EXCHANGE_CLOSED', { isOpen: () => false }],
    ['EXIT_IN_FLIGHT', { inFlight: true }],
    ['DAILY_CAP', { countedToday: 5 }],
  ])('%s', (reason, over) => {
    expect(evaluateGuards(input(over))).toEqual({ ok: false, reason });
  });

  it('a verdict exactly at the age limit still passes', () => {
    const at = new Date(NOW.getTime() - 90_000);
    expect(evaluateGuards(input({ verdict: { userId: 'owner', createdAt: at } }))).toEqual({ ok: true });
  });

  it('exchange match is case-insensitive and asks the clock with the tracker exchange', () => {
    const isOpen = jest.fn().mockReturnValue(true);
    evaluateGuards(input({ isOpen, tracker: { userId: 'owner', status: 'OPEN', kind: 'POSITION', exchange: 'nfo' } }));
    expect(isOpen).toHaveBeenCalledWith('NFO', NOW);
  });

  it('cap 0 skips everything', () => {
    const config = parseAutoExitConfig({ AI_AUTO_EXIT_ENABLED: 'true', AI_AUTO_EXIT_USER_IDS: 'owner', AI_AUTO_EXIT_DAILY_CAP: '0' });
    expect(evaluateGuards(input({ config }))).toEqual({ ok: false, reason: 'DAILY_CAP' });
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `cd apps/api && npx jest src/modules/sentinel-executor/domain/guards.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/modules/sentinel-executor/domain/guards.ts
import { AUTO_EXIT_EXCHANGES, type AutoExitConfig } from './auto-exit.types';

export interface GuardInput {
  config: AutoExitConfig;
  now: Date;
  verdict: { userId: string; createdAt: Date };
  tracker: { userId: string; status: string; kind: string; exchange: string } | null;
  isOpen: (exchange: string, at: Date) => boolean;
  countedToday: number;
  inFlight: boolean;
}

export type GuardResult = { ok: true } | { ok: false; reason: string };

const no = (reason: string): GuardResult => ({ ok: false, reason });

/**
 * Spec §5.3, in order. Pure: every input that needs I/O is resolved by the caller.
 * The first failing guard names the SKIPPED reason; nothing is sent on any failure.
 */
export function evaluateGuards(i: GuardInput): GuardResult {
  if (!i.config.enabled) return no('DISABLED');
  if (!i.config.userIds.includes(i.verdict.userId)) return no('NOT_ALLOWED_USER');
  if (i.now.getTime() - i.verdict.createdAt.getTime() > i.config.maxVerdictAgeSec * 1000) {
    return no('STALE_VERDICT');
  }
  const t = i.tracker;
  if (!t) return no('TRACKER_MISSING');
  if (t.userId !== i.verdict.userId) return no('TRACKER_USER_MISMATCH');
  if (t.status !== 'OPEN') return no('TRACKER_CLOSED');
  if (t.kind !== 'POSITION') return no('NOT_POSITION');
  const exchange = String(t.exchange ?? '').toUpperCase();
  if (!AUTO_EXIT_EXCHANGES.includes(exchange)) return no('EXCHANGE_NOT_FNO');
  if (!i.isOpen(exchange, i.now)) return no('EXCHANGE_CLOSED');
  if (i.inFlight) return no('EXIT_IN_FLIGHT');
  if (i.countedToday >= i.config.dailyCap) return no('DAILY_CAP');
  return { ok: true };
}
```

- [ ] **Step 4: Run it — expect PASS**

Run: `cd apps/api && npx jest src/modules/sentinel-executor/domain/guards.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/sentinel-executor/domain/guards.ts apps/api/src/modules/sentinel-executor/domain/guards.spec.ts
git commit -m "feat(sentinel-executor): pure guard table for auto-exit verdicts

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Repository — claim, patch, counts, in-flight, sweep, poll query (Stream A, after Task 1)

**Files:**
- Create: `apps/api/src/modules/sentinel-executor/repositories/ai-exit-execution.repository.ts`
- Test: `apps/api/src/modules/sentinel-executor/repositories/ai-exit-execution.repository.spec.ts`

**Interfaces:**
- Consumes: `PrismaService` (`apps/api/src/common/prisma/prisma.service.ts`), `AiExitExecution` (Task 1), `COUNTED_STATUSES`, `AutoExitMode`, `AiExitStatus`, `SessionSource` (Task 2).
- Produces (class `AiExitExecutionRepository`, `@Injectable()`):
  - `interface PendingVerdict { id: string; userId: string; trackerId: string; symbol: string; reason: string; createdAt: Date }`
  - `type AiExitPatch = Partial<Pick<AiExitExecution, 'exchange'|'token'|'side'|'quantity'|'productType'|'orderType'|'limitPrice'|'reason'|'brokerOrderId'|'brokerMessage'|'orderStatus'|'marketOrderId'>> & { status?: AiExitStatus; sessionSource?: SessionSource }`
  - `pendingVerdicts(userIds: string[], since: Date, limit?: number): Promise<PendingVerdict[]>`
  - `claim(v: PendingVerdict, mode: AutoExitMode): Promise<string | null>` — row id, or `null` when the verdict is already claimed (P2002).
  - `update(id: string, patch: AiExitPatch): Promise<void>`
  - `countCountedSince(userId: string, since: Date): Promise<number>`
  - `hasInFlight(trackerId: string, excludeId: string, now: Date): Promise<boolean>`
  - `sweepInterrupted(olderThan: Date): Promise<number>`
  - `listForUser(userId: string, limit: number): Promise<AiExitExecution[]>`

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/modules/sentinel-executor/repositories/ai-exit-execution.repository.spec.ts
import { Prisma } from '@prisma/client';
import { AiExitExecutionRepository, type PendingVerdict } from './ai-exit-execution.repository';

function fakePrisma() {
  return {
    $queryRaw: jest.fn().mockResolvedValue([]),
    aiExitExecution: {
      create: jest.fn().mockResolvedValue({ id: 'row1' }),
      update: jest.fn().mockResolvedValue({}),
      count: jest.fn().mockResolvedValue(0),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
}
const V: PendingVerdict = {
  id: 'v1', userId: 'owner', trackerId: 't1', symbol: 'CRUDEOIL15OCT268950CE',
  reason: 'thesis broken', createdAt: new Date('2026-10-12T10:00:00Z'),
};

describe('AiExitExecutionRepository', () => {
  it('claim inserts a CLAIMED row carrying the verdict reason and mode', async () => {
    const p = fakePrisma();
    const repo = new AiExitExecutionRepository(p as never);
    await expect(repo.claim(V, 'dry-run')).resolves.toBe('row1');
    expect(p.aiExitExecution.create).toHaveBeenCalledWith({
      data: {
        userId: 'owner', verdictId: 'v1', trackerId: 't1', symbol: 'CRUDEOIL15OCT268950CE',
        mode: 'dry-run', status: 'CLAIMED', verdictReason: 'thesis broken',
      },
      select: { id: true },
    });
  });

  it('claim returns null on a unique violation (someone else has it) and rethrows anything else', async () => {
    const p = fakePrisma();
    const repo = new AiExitExecutionRepository(p as never);
    p.aiExitExecution.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' }),
    );
    await expect(repo.claim(V, 'live')).resolves.toBeNull();
    p.aiExitExecution.create.mockRejectedValueOnce(new Error('db down'));
    await expect(repo.claim(V, 'live')).rejects.toThrow('db down');
  });

  it('countCountedSince counts PLACED/FILLED/DRY_RUN since the instant', async () => {
    const p = fakePrisma();
    const since = new Date('2026-10-11T18:30:00Z');
    await new AiExitExecutionRepository(p as never).countCountedSince('owner', since);
    expect(p.aiExitExecution.count).toHaveBeenCalledWith({
      where: { userId: 'owner', createdAt: { gte: since }, status: { in: ['PLACED', 'FILLED', 'DRY_RUN'] } },
    });
  });

  it('hasInFlight: another CLAIMED row, or a PLACED row in the last 60 s, for the same tracker', async () => {
    const p = fakePrisma();
    const now = new Date('2026-10-12T10:00:00Z');
    p.aiExitExecution.count.mockResolvedValueOnce(1);
    await expect(new AiExitExecutionRepository(p as never).hasInFlight('t1', 'row1', now)).resolves.toBe(true);
    expect(p.aiExitExecution.count).toHaveBeenCalledWith({
      where: {
        trackerId: 't1',
        id: { not: 'row1' },
        OR: [
          { status: 'CLAIMED' },
          { status: 'PLACED', createdAt: { gte: new Date('2026-10-12T09:59:00Z') } },
        ],
      },
    });
  });

  it('sweepInterrupted turns old CLAIMED rows into FAILED: INTERRUPTED', async () => {
    const p = fakePrisma();
    p.aiExitExecution.updateMany.mockResolvedValueOnce({ count: 2 });
    const cutoff = new Date('2026-10-12T09:59:00Z');
    await expect(new AiExitExecutionRepository(p as never).sweepInterrupted(cutoff)).resolves.toBe(2);
    expect(p.aiExitExecution.updateMany).toHaveBeenCalledWith({
      where: { status: 'CLAIMED', createdAt: { lt: cutoff } },
      data: { status: 'FAILED', reason: 'INTERRUPTED' },
    });
  });

  it('pendingVerdicts is ONE raw anti-join query; an empty allow-list makes no query', async () => {
    const p = fakePrisma();
    const repo = new AiExitExecutionRepository(p as never);
    await expect(repo.pendingVerdicts([], new Date())).resolves.toEqual([]);
    expect(p.$queryRaw).not.toHaveBeenCalled();
    await repo.pendingVerdicts(['owner'], new Date('2026-10-12T09:57:00Z'));
    expect(p.$queryRaw).toHaveBeenCalledTimes(1);
    const sql = (p.$queryRaw.mock.calls[0][0] as Prisma.Sql).sql;
    expect(sql).toContain('"sentinel_verdicts"');
    expect(sql).toContain(`"verdict" = 'EXIT_NOW'`);
    expect(sql).toContain('NOT EXISTS');
    expect(sql).toContain('"ai_exit_executions"');
    expect(sql).toContain('ORDER BY v."createdAt" ASC');
  });

  it('listForUser is scoped and newest first', async () => {
    const p = fakePrisma();
    await new AiExitExecutionRepository(p as never).listForUser('owner', 20);
    expect(p.aiExitExecution.findMany).toHaveBeenCalledWith({
      where: { userId: 'owner' }, orderBy: { createdAt: 'desc' }, take: 20,
    });
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `cd apps/api && npx jest src/modules/sentinel-executor/repositories/ai-exit-execution.repository.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/modules/sentinel-executor/repositories/ai-exit-execution.repository.ts
import { Injectable } from '@nestjs/common';
import { Prisma, type AiExitExecution } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  COUNTED_STATUSES,
  type AiExitStatus,
  type AutoExitMode,
  type SessionSource,
} from '../domain/auto-exit.types';

export interface PendingVerdict {
  id: string;
  userId: string;
  trackerId: string;
  symbol: string;
  reason: string;
  createdAt: Date;
}

export type AiExitPatch = Partial<
  Pick<
    AiExitExecution,
    | 'exchange' | 'token' | 'side' | 'quantity' | 'productType' | 'orderType' | 'limitPrice'
    | 'reason' | 'brokerOrderId' | 'brokerMessage' | 'orderStatus' | 'marketOrderId'
  >
> & { status?: AiExitStatus; sessionSource?: SessionSource };

const IN_FLIGHT_PLACED_MS = 60_000;

@Injectable()
export class AiExitExecutionRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * THE 5-SECOND QUERY (spec §5.1, plan R7). One statement, served by
   * sentinel_verdicts(userId, createdAt) and the unique ai_exit_executions(verdictId).
   */
  async pendingVerdicts(userIds: string[], since: Date, limit = 5): Promise<PendingVerdict[]> {
    if (userIds.length === 0) return [];
    return this.prisma.$queryRaw<PendingVerdict[]>(Prisma.sql`
      SELECT v."id", v."userId", v."trackerId", v."symbol", v."reason", v."createdAt"
      FROM "sentinel_verdicts" v
      WHERE v."userId" IN (${Prisma.join(userIds)})
        AND v."createdAt" >= ${since}
        AND v."verdict" = 'EXIT_NOW'
        AND NOT EXISTS (SELECT 1 FROM "ai_exit_executions" e WHERE e."verdictId" = v."id")
      ORDER BY v."createdAt" ASC
      LIMIT ${limit}`);
  }

  /** Insert the CLAIMED row BEFORE any broker call. null = already claimed elsewhere. */
  async claim(v: PendingVerdict, mode: AutoExitMode): Promise<string | null> {
    try {
      const row = await this.prisma.aiExitExecution.create({
        data: {
          userId: v.userId,
          verdictId: v.id,
          trackerId: v.trackerId,
          symbol: v.symbol,
          mode,
          status: 'CLAIMED',
          verdictReason: v.reason,
        },
        select: { id: true },
      });
      return row.id;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return null;
      throw err;
    }
  }

  async update(id: string, patch: AiExitPatch): Promise<void> {
    await this.prisma.aiExitExecution.update({ where: { id }, data: patch });
  }

  countCountedSince(userId: string, since: Date): Promise<number> {
    return this.prisma.aiExitExecution.count({
      where: { userId, createdAt: { gte: since }, status: { in: [...COUNTED_STATUSES] } },
    });
  }

  async hasInFlight(trackerId: string, excludeId: string, now: Date): Promise<boolean> {
    const n = await this.prisma.aiExitExecution.count({
      where: {
        trackerId,
        id: { not: excludeId },
        OR: [
          { status: 'CLAIMED' },
          { status: 'PLACED', createdAt: { gte: new Date(now.getTime() - IN_FLIGHT_PLACED_MS) } },
        ],
      },
    });
    return n > 0;
  }

  /** Plan R8: a CLAIMED row this old was cut off mid-flight. Never re-sent. */
  async sweepInterrupted(olderThan: Date): Promise<number> {
    const r = await this.prisma.aiExitExecution.updateMany({
      where: { status: 'CLAIMED', createdAt: { lt: olderThan } },
      data: { status: 'FAILED', reason: 'INTERRUPTED' },
    });
    return r.count;
  }

  listForUser(userId: string, limit: number): Promise<AiExitExecution[]> {
    return this.prisma.aiExitExecution.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }
}
```

- [ ] **Step 4: Run it — expect PASS**

Run: `cd apps/api && npx jest src/modules/sentinel-executor/repositories/ai-exit-execution.repository.spec.ts`
Expected: PASS. (Requires Task 1's generated client for `AiExitExecution` and `prisma.aiExitExecution` types.)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/sentinel-executor/repositories/ai-exit-execution.repository.ts apps/api/src/modules/sentinel-executor/repositories/ai-exit-execution.repository.spec.ts
git commit -m "feat(sentinel-executor): ai_exit_executions repository (claim, counts, sweep, poll query)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Broker session — order book read + `borrow()` (Stream B)

**Files:**
- Modify: `apps/api/src/modules/auto-execution/services/per-user-broker-session.factory.ts`
- Test (new): `apps/api/src/modules/auto-execution/services/per-user-broker-session.factory.spec.ts`

**Interfaces:**
- Produces:
  - `UserSmartApiLike.getOrderBook(): Promise<any>` (SDK method `getOrderBook`, smartapi-javascript `lib/smartapi-connect.js:310`).
  - `UserBrokerSession.getOrderBookEnvelope(): Promise<any>` — raw `{ status, message, data }`.
  - `PerUserBrokerSessionFactory.borrow<T>(client: UserSmartApiLike, clientId: string, fn: (s: UserBrokerSession) => Promise<T>): Promise<T>` — wraps an ALREADY-authenticated client; never calls `generateSession` or `logout`; disposes the wrapper in `finally`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/modules/auto-execution/services/per-user-broker-session.factory.spec.ts
import { PerUserBrokerSessionFactory, type UserSmartApiLike } from './per-user-broker-session.factory';

function fakeClient(): jest.Mocked<UserSmartApiLike> {
  return {
    generateSession: jest.fn().mockResolvedValue({ data: { jwtToken: 'jwt' } }),
    placeOrder: jest.fn().mockResolvedValue({ status: true, message: 'SUCCESS', data: { orderid: 'O1' } }),
    logout: jest.fn().mockResolvedValue({}),
    getRMS: jest.fn(),
    getProfile: jest.fn(),
    getPosition: jest.fn().mockResolvedValue({ status: true, data: [] }),
    getAllHolding: jest.fn(),
    getTradeBook: jest.fn(),
    getOrderBook: jest.fn().mockResolvedValue({ status: true, data: [{ orderid: 'O1', status: 'open' }] }),
  };
}
const CREDS = { apiKey: 'k', apiSecret: 's', clientId: 'C1', password: 'p', totpSecret: 'JBSWY3DPEHPK3PXP' };

describe('PerUserBrokerSessionFactory.borrow', () => {
  it('uses the given client without logging in or out', async () => {
    const client = fakeClient();
    const f = new PerUserBrokerSessionFactory(() => { throw new Error('must not build a client'); });
    const r = await f.borrow(client, 'C1', (s) =>
      s.placeOrder(
        { symbol: 'X', token: '1', exchange: 'NFO', side: 'SELL', orderType: 'MARKET', quantity: 75, positionType: 'CARRYFORWARD' },
        'axMabc',
      ),
    );
    expect(r).toEqual({ orderId: 'O1', status: 'PLACED', message: 'SUCCESS' });
    expect(client.generateSession).not.toHaveBeenCalled();
    expect(client.logout).not.toHaveBeenCalled();
    expect(client.placeOrder).toHaveBeenCalledWith(expect.objectContaining({
      variety: 'NORMAL', tradingsymbol: 'X', symboltoken: '1', transactiontype: 'SELL', exchange: 'NFO',
      ordertype: 'MARKET', producttype: 'CARRYFORWARD', duration: 'DAY', quantity: '75', price: '0',
      ordertag: 'axMabc',
    }));
  });

  it('the borrowed wrapper is unusable after the callback', async () => {
    const f = new PerUserBrokerSessionFactory();
    let leaked: any;
    await f.borrow(fakeClient(), 'C1', async (s) => { leaked = s; });
    await expect(leaked.getOrderBookEnvelope()).rejects.toThrow(/disposed/);
  });

  it('getOrderBookEnvelope returns the raw envelope', async () => {
    const f = new PerUserBrokerSessionFactory();
    const env = await f.borrow(fakeClient(), 'C1', (s) => s.getOrderBookEnvelope());
    expect(env).toEqual({ status: true, data: [{ orderid: 'O1', status: 'open' }] });
  });
});

describe('PerUserBrokerSessionFactory.withSession (unchanged contract)', () => {
  it('logs in, runs, logs out', async () => {
    const client = fakeClient();
    const f = new PerUserBrokerSessionFactory(() => client);
    await f.withSession(CREDS, (s) => s.getPositionsEnvelope());
    expect(client.generateSession).toHaveBeenCalledTimes(1);
    expect(client.logout).toHaveBeenCalledWith('C1');
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `cd apps/api && npx jest src/modules/auto-execution/services/per-user-broker-session.factory.spec.ts`
Expected: FAIL — `getOrderBook` not in type / `borrow is not a function`.

- [ ] **Step 3: Implement** — three edits in `per-user-broker-session.factory.ts`:

(a) In `interface UserSmartApiLike`, after `getTradeBook(): Promise<any>;` add:

```ts
  /** Today's order book (smartapi-javascript `getOrderBook`). Read-only. */
  getOrderBook(): Promise<any>;
```

(b) In `interface UserBrokerSession`, after `getHoldingsEnvelope(): Promise<any>;` add:

```ts
  /**
   * The RAW order-book envelope. Angel can accept an order (orderid returned) and
   * reject it a moment later in the RMS/exchange; the reason only appears here
   * (`status: 'rejected'`, `text`). Same disposed-guard + timeout as every read.
   */
  getOrderBookEnvelope(): Promise<any>;
```

and in `class AngelOneUserBrokerSession`, after `getHoldingsEnvelope()`:

```ts
  /** Order book read, whole envelope (see the interface). */
  async getOrderBookEnvelope(): Promise<any> {
    return this.readEnvelope(() => this.client.getOrderBook(), 'Angel One getOrderBook');
  }
```

(c) In `class PerUserBrokerSessionFactory`, after `withSession(...)`:

```ts
  /**
   * Run `fn` against an ALREADY-AUTHENTICATED client that someone else owns — the
   * owner's warm per-user feed session (sentinel auto-exit, plan ruling R1). A
   * second Angel login on the same client code kills that session's live stream,
   * so this never logs in and never logs out; it only lends the one order mapper
   * above. The wrapper is disposed in `finally` so it cannot outlive the callback.
   */
  async borrow<T>(
    client: UserSmartApiLike,
    clientId: string,
    fn: (session: UserBrokerSession) => Promise<T>,
  ): Promise<T> {
    const session = new AngelOneUserBrokerSession(client, clientId, this.logger);
    try {
      return await fn(session);
    } finally {
      session.dispose();
    }
  }
```

- [ ] **Step 4: Run it and the callers — expect PASS**

Run: `cd apps/api && npx jest src/modules/auto-execution src/modules/credential-vault src/modules/trade-tracker`
Expected: PASS (new spec + existing callers unaffected).
Run: `cd apps/api && npx tsc --noEmit -p tsconfig.json` → exit 0 (any fake typed as `UserSmartApiLike` that now lacks `getOrderBook` must get `getOrderBook: jest.fn()`).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/auto-execution/services/per-user-broker-session.factory.ts apps/api/src/modules/auto-execution/services/per-user-broker-session.factory.spec.ts
git commit -m "feat(auto-execution): order-book envelope read and borrow() over a warm session

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Warm REST client from the owner's per-user feed session (Stream B)

**Files:**
- Modify: `apps/api/src/modules/market-data/services/user-feed.types.ts`
- Modify: `apps/api/src/modules/market-data/services/user-feed-session.ts`
- Modify: `apps/api/src/modules/market-data/services/user-feed-manager.service.ts`
- Test: `apps/api/src/modules/market-data/services/user-feed-session.spec.ts`, `apps/api/src/modules/market-data/services/user-feed-manager.service.spec.ts`

**Interfaces:**
- Produces:
  - `interface WarmRestClient { client: unknown; clientId: string }` (exported from `user-feed.types.ts`)
  - `UserFeedSessionLike.restClient?(): WarmRestClient | null` (optional — existing fakes stay valid)
  - `UserFeedSession.restClient(): WarmRestClient | null` — non-null only after a successful `generateSession` in the current connect, until `dispose()` or the next connect attempt begins.
  - `UserFeedManager.warmRestClient(userId: string): WarmRestClient | null` — **never creates a session** (does not call `getOrCreateEntry`).

Note: these files are on the market-hub "only door" list (`market-hub/only-door.spec.ts`); the regex there matches `getCandleData|marketData|searchScrip|optionGreek|new WebSocketV2(` only, so this change does not affect it. The sentinel's structural walk does not reach these files (verified by walking its imports while planning).

- [ ] **Step 1: Write the failing tests**

Append to `user-feed-session.spec.ts` (uses the file's existing `makeDeps`/`makeSession` helpers):

```ts
describe('restClient (sentinel auto-exit borrows the warm client)', () => {
  it('is null before connect, the authenticated client after, null after dispose', async () => {
    const { s, d } = makeSession();
    expect(s.restClient()).toBeNull();
    await s.ensureConnected();
    expect(s.restClient()).toEqual({ client: d.smartApi, clientId: 'C1' });
    await s.dispose();
    expect(s.restClient()).toBeNull();
  });

  it('is null when the login failed (client built but never authenticated)', async () => {
    const d = makeDeps();
    d.smartApi.generateSession.mockResolvedValue({ data: {} });
    const { s } = makeSession(d);
    await expect(s.ensureConnected()).rejects.toThrow();
    expect(s.restClient()).toBeNull();
  });
});
```

Append to `user-feed-manager.service.spec.ts`:

```ts
it('warmRestClient never creates a session, and returns the live session client', async () => {
  const sessions: any[] = [];
  const factory = jest.fn(() => {
    const s: any = fakeSession();
    s.restClient = jest.fn(() => ({ client: { tag: 'warm' }, clientId: 'C1' }));
    sessions.push(s);
    return s;
  });
  const mgr = new UserFeedManager(factory as any, { idleMs: 120000, maxSessions: 40 });
  expect(mgr.warmRestClient('u1')).toBeNull();
  expect(factory).not.toHaveBeenCalled();
  await mgr.pin('u1', []);
  expect(mgr.warmRestClient('u1')).toEqual({ client: { tag: 'warm' }, clientId: 'C1' });
});

it('warmRestClient is null for a session without restClient support', async () => {
  const mgr = new UserFeedManager(jest.fn(() => fakeSession()) as any, { idleMs: 120000, maxSessions: 40 });
  await mgr.pin('u1', []);
  expect(mgr.warmRestClient('u1')).toBeNull();
});
```

- [ ] **Step 2: Run them — expect FAIL**

Run: `cd apps/api && npx jest src/modules/market-data/services/user-feed-session.spec.ts src/modules/market-data/services/user-feed-manager.service.spec.ts`
Expected: FAIL — `s.restClient is not a function` / `mgr.warmRestClient is not a function`.

- [ ] **Step 3: Implement**

`user-feed.types.ts` — add above `UserFeedSessionLike`, and the optional member inside it:

```ts
/** An already-authenticated SmartAPI REST client lent out by a live session (never a login). */
export interface WarmRestClient {
  client: unknown;
  clientId: string;
}
```

```ts
  /**
   * The session's authenticated REST client, or null. Lets the sentinel
   * auto-exit place an order on the owner's account without a second Angel
   * login (which would kill this session's stream). Optional: fakes omit it.
   */
  restClient?(): WarmRestClient | null;
```

`user-feed-session.ts`:
1. Import `WarmRestClient` alongside the other types from `./user-feed.types`.
2. Add a field next to `private connected = false;`:

```ts
  /** True only between a successful generateSession and the next connect attempt / dispose. */
  private restReady = false;
```

3. In `doConnect`, as the first statement inside `await this.deps.withDecryptedCreds(this.userId, async (creds) => {`, add `this.restReady = false;`, and immediately after `this.clientId = creds.clientId;` add `this.restReady = true;`.
4. In `dispose()`, next to `this.connected = false;`, add `this.restReady = false;`.
5. Add the public method after `activeTokenCount()`:

```ts
  /** See UserFeedSessionLike.restClient. Never logs in. */
  restClient(): WarmRestClient | null {
    if (this.disposed || !this.restReady || !this.smartApi || !this.clientId) return null;
    return { client: this.smartApi, clientId: this.clientId };
  }
```

`user-feed-manager.service.ts` — import `WarmRestClient` from `./user-feed.types` and add after `fetchOptionGreeks`:

```ts
  /**
   * The user's LIVE session's authenticated REST client, or null. Unlike every
   * fetch above this NEVER creates a session: a caller that finds none must
   * decide for itself whether a fresh login is acceptable (sentinel auto-exit).
   */
  warmRestClient(userId: string): WarmRestClient | null {
    return this.registry.get(userId)?.session.restClient?.() ?? null;
  }
```

- [ ] **Step 4: Run them — expect PASS**

Run: `cd apps/api && npx jest src/modules/market-data/services/user-feed-session.spec.ts src/modules/market-data/services/user-feed-manager.service.spec.ts src/modules/market-hub`
Expected: PASS (including `only-door.spec.ts`).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/market-data/services/user-feed.types.ts apps/api/src/modules/market-data/services/user-feed-session.ts apps/api/src/modules/market-data/services/user-feed-manager.service.ts apps/api/src/modules/market-data/services/user-feed-session.spec.ts apps/api/src/modules/market-data/services/user-feed-manager.service.spec.ts
git commit -m "feat(market-data): lend the live per-user session's REST client without a login

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: `OwnerBrokerSessionProvider` — ruling R1 (Stream B, after 6 and 7)

**Files:**
- Create: `apps/api/src/modules/sentinel-executor/services/owner-broker-session.provider.ts`
- Test: `apps/api/src/modules/sentinel-executor/services/owner-broker-session.provider.spec.ts`

**Interfaces:**
- Consumes: `UserFeedManager.warmRestClient` (Task 7), `PerUserBrokerSessionFactory.borrow`/`withSession` (Task 6), `CREDENTIAL_DECRYPTOR` + `CredentialDecryptor` (`apps/api/src/modules/credential-vault/execution/credential-decryptor.ts`), `SessionSource` (Task 2).
- Produces: `OwnerBrokerSessionProvider.withOwnerSession<T>(userId: string, fn: (s: UserBrokerSession, source: SessionSource) => Promise<T>): Promise<T>`.

If Stream A's Task 2 is not merged yet, temporarily declare `type SessionSource = 'user-feed' | 'ephemeral'` locally and switch to the import when merging (same literal union).

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/modules/sentinel-executor/services/owner-broker-session.provider.spec.ts
import { OwnerBrokerSessionProvider } from './owner-broker-session.provider';

function deps(warm: unknown) {
  const session = { placeOrder: jest.fn() };
  const userFeeds = { warmRestClient: jest.fn().mockReturnValue(warm) };
  const factory = {
    borrow: jest.fn(async (_c: unknown, _id: string, fn: any) => fn(session)),
    withSession: jest.fn(async (_creds: unknown, fn: any) => fn(session)),
  };
  const decryptor = {
    withDecryptedCredentials: jest.fn(async (_u: string, _ctx: unknown, use: any) => use({ clientId: 'C1' })),
  };
  const p = new OwnerBrokerSessionProvider(userFeeds as never, factory as never, decryptor as never);
  return { p, session, userFeeds, factory, decryptor };
}

describe('OwnerBrokerSessionProvider (ruling R1)', () => {
  it('prefers the warm per-user session: borrow, no decrypt, no login', async () => {
    const d = deps({ client: { tag: 'warm' }, clientId: 'C1' });
    const seen: string[] = [];
    await d.p.withOwnerSession('owner', async (_s, source) => { seen.push(source); });
    expect(seen).toEqual(['user-feed']);
    expect(d.factory.borrow).toHaveBeenCalledWith({ tag: 'warm' }, 'C1', expect.any(Function));
    expect(d.decryptor.withDecryptedCredentials).not.toHaveBeenCalled();
    expect(d.factory.withSession).not.toHaveBeenCalled();
  });

  it('falls back to an ephemeral ORDER-reason vault login only when no warm session exists', async () => {
    const d = deps(null);
    const seen: string[] = [];
    await d.p.withOwnerSession('owner', async (_s, source) => { seen.push(source); });
    expect(seen).toEqual(['ephemeral']);
    expect(d.decryptor.withDecryptedCredentials).toHaveBeenCalledWith('owner', { reason: 'ORDER' }, expect.any(Function));
    expect(d.factory.withSession).toHaveBeenCalledTimes(1);
  });

  it('an error inside the warm tier is NOT retried on the ephemeral tier (no double placement)', async () => {
    const d = deps({ client: {}, clientId: 'C1' });
    await expect(d.p.withOwnerSession('owner', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(d.factory.withSession).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `cd apps/api && npx jest src/modules/sentinel-executor/services/owner-broker-session.provider.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/modules/sentinel-executor/services/owner-broker-session.provider.ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { UserFeedManager } from '../../market-data/services/user-feed-manager.service';
import {
  PerUserBrokerSessionFactory,
  type UserBrokerSession,
  type UserSmartApiLike,
} from '../../auto-execution/services/per-user-broker-session.factory';
import {
  CREDENTIAL_DECRYPTOR,
  CredentialDecryptor,
} from '../../credential-vault/execution/credential-decryptor';
import type { SessionSource } from '../domain/auto-exit.types';

/**
 * Plan ruling R1. The owner's account already has a live Angel session — the
 * per-user feed session the market hub pins. A second login on the same client
 * code kills that session's stream, so the executor BORROWS it. Only when no warm
 * session exists does it log in (vault lease, reason ORDER), exactly like
 * auto-execution. AngelOneAuthService is never used: its credentials are
 * env-first and may belong to a different Angel account.
 *
 * The tier is chosen ONCE, before any broker call. An error inside a tier is
 * propagated, never retried on the other tier.
 */
@Injectable()
export class OwnerBrokerSessionProvider {
  private readonly logger = new Logger(OwnerBrokerSessionProvider.name);

  constructor(
    private readonly userFeeds: UserFeedManager,
    private readonly factory: PerUserBrokerSessionFactory,
    @Inject(CREDENTIAL_DECRYPTOR) private readonly decryptor: CredentialDecryptor,
  ) {}

  async withOwnerSession<T>(
    userId: string,
    fn: (session: UserBrokerSession, source: SessionSource) => Promise<T>,
  ): Promise<T> {
    const warm = this.userFeeds.warmRestClient(userId);
    if (warm) {
      return this.factory.borrow(warm.client as UserSmartApiLike, warm.clientId, (s) => fn(s, 'user-feed'));
    }
    this.logger.warn(`[ai-exit] no warm session for ${userId} — using an ephemeral login`);
    return this.decryptor.withDecryptedCredentials(userId, { reason: 'ORDER' }, (creds) =>
      this.factory.withSession(creds, (s) => fn(s, 'ephemeral')),
    );
  }
}
```

- [ ] **Step 4: Run it — expect PASS**

Run: `cd apps/api && npx jest src/modules/sentinel-executor/services/owner-broker-session.provider.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/sentinel-executor/services/owner-broker-session.provider.ts apps/api/src/modules/sentinel-executor/services/owner-broker-session.provider.spec.ts
git commit -m "feat(sentinel-executor): owner broker session provider (warm session first, no second login)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: `SentinelExitExecutor` — one verdict, end to end (Stream D)

**Files:**
- Create: `apps/api/src/modules/sentinel-executor/services/sentinel-exit-executor.service.ts`
- Test: `apps/api/src/modules/sentinel-executor/services/sentinel-exit-executor.service.spec.ts`

**Interfaces:**
- Consumes: Tasks 2–5, 8; `answeredPositions` from `apps/api/src/modules/trade-tracker/services/trade-tracker.service.ts` (used for both the positions and the order-book envelopes — same "answered ⇒ array, `data: null` ⇒ `[]`, else `null`" rule); `SessionClock` (`apps/api/src/modules/market-hub/session-clock.ts`); `PrismaService`.
- Produces:
  - `const AI_EXIT_SESSION_CLOCK = Symbol('AI_EXIT_SESSION_CLOCK')`, `const AI_EXIT_SLEEP = Symbol('AI_EXIT_SLEEP')`, `type Sleep = (ms: number) => Promise<void>`
  - `type AiExitOutcome = { status: AiExitStatus | 'DUPLICATE'; reason?: string }`
  - `SentinelExitExecutor.process(v: PendingVerdict, cfg: AutoExitConfig, now?: Date): Promise<AiExitOutcome>`

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/modules/sentinel-executor/services/sentinel-exit-executor.service.spec.ts
import { SentinelExitExecutor } from './sentinel-exit-executor.service';
import { parseAutoExitConfig } from '../domain/auto-exit.config';
import { aiExitOrderTag } from '../domain/exit-order';
import type { PendingVerdict } from '../repositories/ai-exit-execution.repository';

const NOW = new Date('2026-10-12T10:00:00Z');
const V: PendingVerdict = {
  id: 'cm9verdict000000000000001', userId: 'owner', trackerId: 't1',
  symbol: 'CRUDEOIL15OCT268950CE', reason: 'thesis broken', createdAt: new Date(NOW.getTime() - 5_000),
};
const LIVE = parseAutoExitConfig({ AI_AUTO_EXIT_ENABLED: 'true', AI_AUTO_EXIT_MODE: 'live', AI_AUTO_EXIT_USER_IDS: 'owner' });
const DRY = parseAutoExitConfig({ AI_AUTO_EXIT_ENABLED: 'true', AI_AUTO_EXIT_USER_IDS: 'owner' });

const posRow = (netqty: string, ltp = '50.25') => ({
  tradingsymbol: 'CRUDEOIL15OCT268950CE', symboltoken: '445566', exchange: 'MCX',
  producttype: 'CARRYFORWARD', netqty, ltp,
});
const env = (data: unknown) => ({ status: true, data });

function harness(opts: {
  positions?: unknown[];         // successive getPositionsEnvelope answers
  books?: unknown[];             // successive getOrderBookEnvelope answers
  place?: unknown[];             // successive placeOrder results
  claim?: string | null;
  tracker?: unknown;
  counted?: number;
  inFlight?: boolean;
  open?: boolean;
  tick?: number | null;
} = {}) {
  const calls: string[] = [];
  const queue = <T>(xs: T[] | undefined, dflt: T) => {
    const q = [...(xs ?? [])];
    return () => (q.length > 1 ? q.shift()! : q[0] ?? dflt);
  };
  const nextPos = queue(opts.positions, env([posRow('100')]));
  const nextBook = queue(opts.books, env([]));
  const nextPlace = queue(opts.place, { orderId: 'O1', status: 'PLACED', message: 'SUCCESS' });

  const session = {
    getPositionsEnvelope: jest.fn(async () => { calls.push('positions'); return nextPos(); }),
    getOrderBookEnvelope: jest.fn(async () => { calls.push('book'); return nextBook(); }),
    placeOrder: jest.fn(async (o: any, tag: string) => { calls.push(`place:${o.orderType}:${tag}`); return nextPlace(); }),
  };
  const repo = {
    claim: jest.fn(async () => { calls.push('claim'); return opts.claim === undefined ? 'row1' : opts.claim; }),
    update: jest.fn(async (_id: string, patch: any) => { calls.push(`update:${patch.status ?? '-'}`); }),
    countCountedSince: jest.fn(async () => opts.counted ?? 0),
    hasInFlight: jest.fn(async () => opts.inFlight ?? false),
  };
  const prisma = {
    tradeTracker: {
      findUnique: jest.fn(async () => (opts.tracker === undefined
        ? { id: 't1', userId: 'owner', status: 'OPEN', kind: 'POSITION', exchange: 'MCX', token: '445566', qty: 100 }
        : opts.tracker)),
    },
    instrument: { findFirst: jest.fn(async () => (opts.tick === undefined ? { tickSize: 10 } : opts.tick === null ? null : { tickSize: opts.tick })) },
  };
  const sessions = { withOwnerSession: jest.fn(async (_u: string, fn: any) => fn(session, 'user-feed')) };
  const clock = { isOpen: jest.fn(() => opts.open ?? true) };
  const sleep = jest.fn(async () => undefined);
  const ex = new SentinelExitExecutor(repo as never, prisma as never, sessions as never, clock as never, sleep);
  const lastPatch = () => repo.update.mock.calls.at(-1)?.[1];
  const patches = () => repo.update.mock.calls.map((c) => c[1]);
  return { ex, session, repo, prisma, sessions, calls, lastPatch, patches, sleep };
}

describe('SentinelExitExecutor', () => {
  it('claims BEFORE any broker call, and a lost claim makes no broker call at all', async () => {
    const h = harness();
    await h.ex.process(V, LIVE, NOW);
    expect(h.calls[0]).toBe('claim');
    expect(h.calls.indexOf('claim')).toBeLessThan(h.calls.findIndex((c) => c.startsWith('place')));

    const lost = harness({ claim: null });
    await expect(lost.ex.process(V, LIVE, NOW)).resolves.toEqual({ status: 'DUPLICATE' });
    expect(lost.sessions.withOwnerSession).not.toHaveBeenCalled();
    expect(lost.repo.update).not.toHaveBeenCalled();
  });

  it('dry-run reads the book, records the exact order, sends nothing', async () => {
    const h = harness();
    await expect(h.ex.process(V, DRY, NOW)).resolves.toEqual({ status: 'DRY_RUN', reason: expect.stringContaining('would SELL 100 CRUDEOIL15OCT268950CE (CARRYFORWARD) at MARKET') });
    expect(h.session.placeOrder).not.toHaveBeenCalled();
    expect(h.patches()).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionSource: 'user-feed' }),
      expect.objectContaining({ side: 'SELL', quantity: 100, productType: 'CARRYFORWARD', orderType: 'MARKET', exchange: 'MCX', token: '445566' }),
      expect.objectContaining({ status: 'DRY_RUN' }),
    ]));
  });

  it('live: exactly one MARKET order with the ordertag, then FILLED when the book is flat', async () => {
    const h = harness({
      positions: [env([posRow('100')]), env([posRow('0')])],
      books: [env([]), env([{ orderid: 'O1', status: 'complete', text: '', symboltoken: '445566', exchange: 'MCX' }])],
    });
    await expect(h.ex.process(V, LIVE, NOW)).resolves.toEqual({ status: 'FILLED' });
    expect(h.session.placeOrder).toHaveBeenCalledTimes(1);
    expect(h.session.placeOrder.mock.calls[0][1]).toBe(aiExitOrderTag(V.id, 'M'));
    expect(h.patches()).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'PLACED', brokerOrderId: 'O1' }),
      expect.objectContaining({ status: 'FILLED', orderStatus: 'complete' }),
    ]));
  });

  it('a short is closed with a BUY of |netqty|', async () => {
    const h = harness({
      tracker: { id: 't1', userId: 'owner', status: 'OPEN', kind: 'POSITION', exchange: 'MCX', token: '445566', qty: -100 },
      positions: [env([posRow('-100')]), env([posRow('0')])],
    });
    await h.ex.process(V, LIVE, NOW);
    expect(h.session.placeOrder.mock.calls[0][0]).toEqual(expect.objectContaining({ side: 'BUY', quantity: 100 }));
  });

  it('sync MARKET refusal → exactly one LIMIT at LTP − 2 % on the tick, tag leg L', async () => {
    const h = harness({
      place: [
        { orderId: '', status: 'REJECTED', message: 'Market orders are not allowed for this instrument' },
        { orderId: 'O2', status: 'PLACED', message: 'SUCCESS' },
      ],
      tick: 10, // paise → ₹0.10
    });
    await h.ex.process(V, LIVE, NOW);
    expect(h.session.placeOrder).toHaveBeenCalledTimes(2);
    const [, [limit, tag]] = h.session.placeOrder.mock.calls;
    expect(limit).toEqual(expect.objectContaining({ orderType: 'LIMIT', price: 49.2, quantity: 100, side: 'SELL' }));
    expect(tag.startsWith('axL')).toBe(true);
  });

  it('async MARKET refusal in the order book → one LIMIT; a refusal of the LIMIT never triggers another', async () => {
    const h = harness({
      positions: [env([posRow('100')]), env([posRow('100')]), env([posRow('100')])],
      books: [
        env([]),
        env([{ orderid: 'O1', status: 'rejected', text: 'MARKET orders are blocked, place a LIMIT order', symboltoken: '445566', exchange: 'MCX' }]),
        env([{ orderid: 'O1', status: 'rejected', text: '', symboltoken: '445566', exchange: 'MCX' }]),
        env([{ orderid: 'O2', status: 'rejected', text: 'Market orders are not allowed', symboltoken: '445566', exchange: 'MCX' }]),
      ],
      place: [{ orderId: 'O1', status: 'PLACED', message: 'ok' }, { orderId: 'O2', status: 'PLACED', message: 'ok' }],
    });
    await expect(h.ex.process(V, LIVE, NOW)).resolves.toEqual(expect.objectContaining({ status: 'REJECTED' }));
    expect(h.session.placeOrder).toHaveBeenCalledTimes(2);
    expect(h.patches()).toEqual(expect.arrayContaining([expect.objectContaining({ marketOrderId: 'O1', orderType: 'LIMIT' })]));
  });

  it('fallback aborts when the position changed between the two orders (never exceed)', async () => {
    const h = harness({
      positions: [env([posRow('100')]), env([posRow('50')])],
      place: [{ orderId: '', status: 'REJECTED', message: 'Market orders are not allowed' }],
    });
    await expect(h.ex.process(V, LIVE, NOW)).resolves.toEqual({ status: 'FAILED', reason: 'FALLBACK_ABORTED:POSITION_CHANGED' });
    expect(h.session.placeOrder).toHaveBeenCalledTimes(1);
  });

  it('any other rejection → REJECTED, no retry', async () => {
    const h = harness({ place: [{ orderId: '', status: 'REJECTED', message: 'Insufficient margin' }] });
    await expect(h.ex.process(V, LIVE, NOW)).resolves.toEqual({ status: 'REJECTED', reason: 'BROKER_REJECTED' });
    expect(h.session.placeOrder).toHaveBeenCalledTimes(1);
    expect(h.lastPatch()).toEqual(expect.objectContaining({ brokerMessage: 'Insufficient margin' }));
  });

  it('placeOrder FAILED (timeout) → ORDER_UNCERTAIN, one call, no fallback', async () => {
    const h = harness({ place: [{ orderId: '', status: 'FAILED', message: 'Angel One placeOrder timed out after 15000ms' }] });
    await expect(h.ex.process(V, LIVE, NOW)).resolves.toEqual({ status: 'FAILED', reason: 'ORDER_UNCERTAIN' });
    expect(h.session.placeOrder).toHaveBeenCalledTimes(1);
  });

  it('broker read not answered → FAILED: BROKER_READ, no order', async () => {
    const h = harness({ positions: [{ status: false, data: null }] });
    await expect(h.ex.process(V, LIVE, NOW)).resolves.toEqual({ status: 'FAILED', reason: 'BROKER_READ' });
    expect(h.session.placeOrder).not.toHaveBeenCalled();
  });

  it('an open order on the contract → SKIPPED: OPEN_ORDER_EXISTS (a second verdict while the first order rests)', async () => {
    const h = harness({ books: [env([{ orderid: 'O0', status: 'open', symboltoken: '445566', exchange: 'MCX' }])] });
    await expect(h.ex.process(V, LIVE, NOW)).resolves.toEqual({ status: 'SKIPPED', reason: 'OPEN_ORDER_EXISTS' });
    expect(h.session.placeOrder).not.toHaveBeenCalled();
  });

  it('already flat → SKIPPED: ALREADY_FLAT', async () => {
    const h = harness({ positions: [env([posRow('0')])] });
    await expect(h.ex.process(V, LIVE, NOW)).resolves.toEqual({ status: 'SKIPPED', reason: 'ALREADY_FLAT' });
  });

  it.each([
    ['stale verdict', { }, { ...V, createdAt: new Date(NOW.getTime() - 91_000) }, 'STALE_VERDICT'],
    ['closed exchange', { open: false }, V, 'EXCHANGE_CLOSED'],
    ['holding', { tracker: { id: 't1', userId: 'owner', status: 'OPEN', kind: 'HOLDING', exchange: 'NSE', token: '1', qty: 10 } }, V, 'NOT_POSITION'],
    ['cash equity position', { tracker: { id: 't1', userId: 'owner', status: 'OPEN', kind: 'POSITION', exchange: 'NSE', token: '1', qty: 10 } }, V, 'EXCHANGE_NOT_FNO'],
    ['daily cap', { counted: 5 }, V, 'DAILY_CAP'],
    ['in flight', { inFlight: true }, V, 'EXIT_IN_FLIGHT'],
  ])('%s → SKIPPED with no session at all', async (_n, opts, verdict, reason) => {
    const h = harness(opts as never);
    await expect(h.ex.process(verdict as PendingVerdict, LIVE, NOW)).resolves.toEqual({ status: 'SKIPPED', reason });
    expect(h.sessions.withOwnerSession).not.toHaveBeenCalled();
  });

  it('a session error is FAILED with a generic reason (no creds), never thrown', async () => {
    const h = harness();
    h.sessions.withOwnerSession.mockRejectedValueOnce(new Error('Angel One rejected the credentials for order placement'));
    await expect(h.ex.process(V, LIVE, NOW)).resolves.toEqual({ status: 'FAILED', reason: 'SESSION' });
    expect(h.lastPatch()).toEqual(expect.objectContaining({ brokerMessage: 'Angel One rejected the credentials for order placement' }));
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `cd apps/api && npx jest src/modules/sentinel-executor/services/sentinel-exit-executor.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/modules/sentinel-executor/services/sentinel-exit-executor.service.ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { OrderRequest } from '../../../common/interfaces/broker-adapter.interface';
import type { UserBrokerSession } from '../../auto-execution/services/per-user-broker-session.factory';
import { answeredPositions } from '../../trade-tracker/services/trade-tracker.service';
import type { SessionClock } from '../../market-hub/session-clock';
import type { AiExitStatus, AutoExitConfig } from '../domain/auto-exit.types';
import {
  aiExitOrderTag,
  findOrder,
  hasOpenOrderFor,
  isFlat,
  isMarketRefusal,
  isTerminalOrderStatus,
  istDayStartUtc,
  limitFallbackPrice,
  planExitOrder,
  tickRupees,
} from '../domain/exit-order';
import { evaluateGuards } from '../domain/guards';
import {
  AiExitExecutionRepository,
  type PendingVerdict,
} from '../repositories/ai-exit-execution.repository';
import { OwnerBrokerSessionProvider } from './owner-broker-session.provider';

export const AI_EXIT_SESSION_CLOCK = Symbol('AI_EXIT_SESSION_CLOCK');
export const AI_EXIT_SLEEP = Symbol('AI_EXIT_SLEEP');
export type Sleep = (ms: number) => Promise<void>;
export type AiExitOutcome = { status: AiExitStatus | 'DUPLICATE'; reason?: string };

/** Plan R10: order-book checks at +2 s, +5 s, +10 s after placing. */
const CONFIRM_STEPS_MS = [2_000, 3_000, 5_000];

type Tracker = { id: string; userId: string; status: string; kind: string; exchange: string; token: string; qty: number };
type PreCheck =
  | { kind: 'ok'; order: OrderRequest; ltp: number }
  | { kind: 'skip'; reason: string }
  | { kind: 'fail'; reason: string };

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Spec §5 for ONE verdict. Never throws: every path ends in exactly one terminal
 * row status and one `[ai-exit]` log line. Claim first, broker second.
 */
@Injectable()
export class SentinelExitExecutor {
  private readonly logger = new Logger(SentinelExitExecutor.name);
  private readonly capWarned = new Set<string>();

  constructor(
    private readonly repo: AiExitExecutionRepository,
    private readonly prisma: PrismaService,
    private readonly sessions: OwnerBrokerSessionProvider,
    @Inject(AI_EXIT_SESSION_CLOCK) private readonly clock: Pick<SessionClock, 'isOpen'>,
    @Inject(AI_EXIT_SLEEP) private readonly sleep: Sleep,
  ) {}

  async process(v: PendingVerdict, cfg: AutoExitConfig, now: Date = new Date()): Promise<AiExitOutcome> {
    // 1. CLAIM — the idempotency anchor. Nothing touches the broker before this.
    const id = await this.repo.claim(v, cfg.mode);
    if (!id) return { status: 'DUPLICATE' };

    // 2. GUARDS — DB + clock only.
    const tracker = (await this.prisma.tradeTracker.findUnique({ where: { id: v.trackerId } })) as Tracker | null;
    const [countedToday, inFlight] = await Promise.all([
      this.repo.countCountedSince(v.userId, istDayStartUtc(now)),
      this.repo.hasInFlight(v.trackerId, id, now),
    ]);
    const g = evaluateGuards({
      config: cfg, now, verdict: v, tracker, countedToday, inFlight,
      isOpen: (ex, at) => this.clock.isOpen(ex, at),
    });
    if (!g.ok) {
      if (g.reason === 'DAILY_CAP') this.warnCapOnce(v.userId, now);
      return this.finish(id, v, 'SKIPPED', g.reason);
    }
    const t = tracker as Tracker;

    // 3–7. BROKER — one session lease, tier chosen once (ruling R1).
    try {
      return await this.sessions.withOwnerSession(v.userId, async (s, source) => {
        await this.repo.update(id, { sessionSource: source });
        const pre = await this.preOrderCheck(s, t);
        if (pre.kind !== 'ok') return this.finish(id, v, pre.kind === 'skip' ? 'SKIPPED' : 'FAILED', pre.reason);
        const o = pre.order;
        await this.repo.update(id, {
          exchange: o.exchange, token: o.token, side: o.side, quantity: o.quantity,
          productType: o.positionType, orderType: 'MARKET',
        });

        if (cfg.mode === 'dry-run') {
          const what = `would ${o.side} ${o.quantity} ${o.symbol} (${o.positionType}) at MARKET`;
          this.logger.log(`[ai-exit] DRY-RUN ${what} — verdict ${v.id}: ${v.reason}`);
          await this.repo.update(id, { status: 'DRY_RUN', reason: what });
          return { status: 'DRY_RUN', reason: what };
        }

        const r = await s.placeOrder(o, aiExitOrderTag(v.id, 'M'));
        this.logger.log(`[ai-exit] LIVE MARKET ${o.side} ${o.quantity} ${o.symbol} → ${r.status} ${r.orderId || ''} (${r.message}) — verdict ${v.id}`);
        if (r.status === 'PLACED' && r.orderId) {
          await this.repo.update(id, { status: 'PLACED', brokerOrderId: r.orderId, brokerMessage: r.message });
          return this.confirm(s, id, v, o, r.orderId, 'M', cfg);
        }
        if (r.status === 'REJECTED' && isMarketRefusal(r.message)) {
          await this.repo.update(id, { brokerMessage: r.message });
          return this.fallback(s, id, v, o, cfg, null);
        }
        if (r.status === 'REJECTED') {
          return this.finish(id, v, 'REJECTED', 'BROKER_REJECTED', { brokerMessage: r.message });
        }
        // FAILED: threw or timed out — the order may or may not exist (ruling R9).
        return this.finish(id, v, 'FAILED', 'ORDER_UNCERTAIN', { brokerMessage: r.message });
      });
    } catch (err) {
      return this.finish(id, v, 'FAILED', 'SESSION', { brokerMessage: errText(err) });
    }
  }

  /** Ruling R3: fresh positions + order book, inside the lease, before EVERY order. */
  private async preOrderCheck(s: UserBrokerSession, t: Tracker): Promise<PreCheck> {
    const rows = answeredPositions(await s.getPositionsEnvelope());
    if (rows === null) return { kind: 'fail', reason: 'BROKER_READ' };
    // R16: this call is OUT OF DATE — see "Stream A deviations": pass lotSize + { mode, qtyUnit }.
    const plan = planExitOrder(rows, { exchange: t.exchange, token: t.token, trackerQty: t.qty });
    if (!plan.ok) return { kind: 'skip', reason: plan.reason };
    const book = answeredPositions(await s.getOrderBookEnvelope());
    if (book === null) return { kind: 'fail', reason: 'ORDER_BOOK_READ' };
    if (hasOpenOrderFor(book, plan.order.exchange, plan.order.token)) return { kind: 'skip', reason: 'OPEN_ORDER_EXISTS' };
    return { kind: 'ok', order: plan.order, ltp: plan.ltp };
  }

  /** Ruling R10. Places nothing except the single R2 fallback (MARKET leg only). */
  private async confirm(
    s: UserBrokerSession, id: string, v: PendingVerdict, o: OrderRequest,
    orderId: string, leg: 'M' | 'L', cfg: AutoExitConfig,
  ): Promise<AiExitOutcome> {
    let last: { status: string; text: string } | null = null;
    for (const step of CONFIRM_STEPS_MS) {
      await this.sleep(step);
      const book = answeredPositions(await s.getOrderBookEnvelope());
      last = book ? findOrder(book, orderId) : last;
      if (last && isTerminalOrderStatus(last.status)) break;
    }
    if (last?.status === 'rejected') {
      if (leg === 'M' && isMarketRefusal(last.text)) {
        await this.repo.update(id, { orderStatus: 'rejected', brokerMessage: last.text });
        return this.fallback(s, id, v, o, cfg, orderId);
      }
      return this.finish(id, v, 'REJECTED', 'BROKER_REJECTED', { orderStatus: 'rejected', brokerMessage: last.text });
    }
    if (last?.status === 'cancelled') {
      return this.finish(id, v, 'REJECTED', 'CANCELLED', { orderStatus: 'cancelled', brokerMessage: last.text });
    }
    const rows = answeredPositions(await s.getPositionsEnvelope());
    if (rows && isFlat(rows, o.exchange, o.token)) {
      return this.finish(id, v, 'FILLED', undefined, { orderStatus: last?.status ?? null });
    }
    await this.repo.update(id, { orderStatus: last?.status ?? null });
    this.logger.log(`[ai-exit] ${o.symbol} order ${orderId} still ${last?.status ?? 'unseen'} after 10 s — left PLACED`);
    return { status: 'PLACED' };
  }

  /** Ruling R2/R3/R5: exactly one LIMIT, same quantity, fresh checks first. */
  private async fallback(
    s: UserBrokerSession, id: string, v: PendingVerdict, first: OrderRequest,
    cfg: AutoExitConfig, marketOrderId: string | null,
  ): Promise<AiExitOutcome> {
    const tracker = { id: v.trackerId, userId: v.userId, status: 'OPEN', kind: 'POSITION',
      exchange: first.exchange, token: first.token, qty: first.side === 'SELL' ? first.quantity : -first.quantity };
    const pre = await this.preOrderCheck(s, tracker);
    if (pre.kind !== 'ok') return this.finish(id, v, 'FAILED', `FALLBACK_ABORTED:${pre.reason}`, { marketOrderId });
    if (pre.order.quantity !== first.quantity || pre.order.side !== first.side) {
      return this.finish(id, v, 'FAILED', 'FALLBACK_ABORTED:POSITION_CHANGED', { marketOrderId });
    }
    const inst = await this.prisma.instrument.findFirst({
      where: { exchange: first.exchange, token: first.token }, select: { tickSize: true },
    });
    const price = limitFallbackPrice(first.side, pre.ltp, cfg.limitFallbackPct, tickRupees(inst?.tickSize, first.exchange));
    if (price === null) return this.finish(id, v, 'REJECTED', 'NO_LTP_FOR_LIMIT', { marketOrderId });

    const limit: OrderRequest = { ...pre.order, orderType: 'LIMIT', price };
    await this.repo.update(id, { orderType: 'LIMIT', limitPrice: price, marketOrderId });
    const r = await s.placeOrder(limit, aiExitOrderTag(v.id, 'L'));
    this.logger.log(`[ai-exit] LIVE LIMIT ${limit.side} ${limit.quantity} ${limit.symbol} @ ${price} → ${r.status} ${r.orderId || ''} (${r.message}) — verdict ${v.id}`);
    if (r.status === 'PLACED' && r.orderId) {
      await this.repo.update(id, { status: 'PLACED', brokerOrderId: r.orderId, brokerMessage: r.message });
      return this.confirm(s, id, v, limit, r.orderId, 'L', cfg);
    }
    if (r.status === 'REJECTED') return this.finish(id, v, 'REJECTED', 'BROKER_REJECTED', { brokerMessage: r.message });
    return this.finish(id, v, 'FAILED', 'ORDER_UNCERTAIN', { brokerMessage: r.message });
  }

  private async finish(
    id: string, v: PendingVerdict, status: AiExitStatus, reason?: string,
    extra: { brokerMessage?: string; orderStatus?: string | null; marketOrderId?: string | null } = {},
  ): Promise<AiExitOutcome> {
    await this.repo.update(id, { status, reason: reason ?? null, ...extra });
    const line = `[ai-exit] ${status}${reason ? `: ${reason}` : ''} — ${v.symbol} verdict ${v.id}`;
    if (status === 'FAILED' || status === 'REJECTED') this.logger.warn(line);
    else this.logger.log(line);
    return reason ? { status, reason } : { status };
  }

  private warnCapOnce(userId: string, now: Date): void {
    const key = `${userId}|${istDayStartUtc(now).toISOString()}`;
    if (this.capWarned.has(key)) return;
    this.capWarned.add(key);
    this.logger.warn(`[ai-exit] daily cap reached for ${userId} — further EXIT_NOW verdicts are skipped today`);
  }
}
```

- [ ] **Step 4: Run it — expect PASS; fix the code, not the assertions**

Run: `cd apps/api && npx jest src/modules/sentinel-executor/services/sentinel-exit-executor.service.spec.ts`
Expected: PASS. If the async-refusal test sees three `placeOrder` calls, the LIMIT leg's `confirm` is reaching `fallback` — the `leg === 'M'` check is the fix.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/sentinel-executor/services/sentinel-exit-executor.service.ts apps/api/src/modules/sentinel-executor/services/sentinel-exit-executor.service.spec.ts
git commit -m "feat(sentinel-executor): claim-first exit executor with dry-run, one MARKET, one LIMIT fallback

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Poller, module wiring, env example (Stream D)

**Files:**
- Create: `apps/api/src/modules/sentinel-executor/services/sentinel-exit-poller.service.ts`
- Test: `apps/api/src/modules/sentinel-executor/services/sentinel-exit-poller.service.spec.ts`
- Create: `apps/api/src/modules/sentinel-executor/sentinel-executor.module.ts`
- Modify: `apps/api/src/app.module.ts` (import + add to `imports` next to `TradeSentinelModule`, ~lines 47 and 237)
- Modify: `deploy/env/api.env.example` (after the `SENTINEL_*` block, ~line 38)

**Interfaces:**
- Consumes: `parseAutoExitConfig` (Task 2), `AiExitExecutionRepository.pendingVerdicts/sweepInterrupted` (Task 5), `SentinelExitExecutor.process` (Task 9), `bootJobsEnabled`/`BOOT_JOBS_DISABLED`.
- Produces: `SentinelExitPoller` with `onModuleInit()`, `onModuleDestroy()`, `runOnce(now?: Date): Promise<void>`, `const AI_EXIT_POLL_MS = 5_000`; `SentinelExecutorModule`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/modules/sentinel-executor/services/sentinel-exit-poller.service.spec.ts
import { SentinelExitPoller, AI_EXIT_POLL_MS } from './sentinel-exit-poller.service';

const ENV_KEYS = ['AI_AUTO_EXIT_ENABLED', 'AI_AUTO_EXIT_MODE', 'AI_AUTO_EXIT_USER_IDS', 'BOOT_JOBS'];
function setEnv(e: Record<string, string>) {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, e);
}
function make() {
  const repo = { pendingVerdicts: jest.fn().mockResolvedValue([]), sweepInterrupted: jest.fn().mockResolvedValue(0) };
  const executor = { process: jest.fn().mockResolvedValue({ status: 'SKIPPED' }) };
  return { repo, executor, poller: new SentinelExitPoller(repo as never, executor as never) };
}

describe('SentinelExitPoller', () => {
  afterEach(() => { jest.useRealTimers(); setEnv({}); });

  it.each([
    ['disabled (default)', {}],
    ['BOOT_JOBS=false', { AI_AUTO_EXIT_ENABLED: 'true', AI_AUTO_EXIT_USER_IDS: 'owner', BOOT_JOBS: 'false' }],
    ['enabled with an empty allow-list', { AI_AUTO_EXIT_ENABLED: 'true' }],
  ])('%s → no timer, no query, no executor call', async (_n, env) => {
    jest.useFakeTimers();
    setEnv(env as Record<string, string>);
    const { poller, repo, executor } = make();
    poller.onModuleInit();
    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(10 * AI_EXIT_POLL_MS);
    await Promise.resolve();
    expect(repo.pendingVerdicts).not.toHaveBeenCalled();
    expect(repo.sweepInterrupted).not.toHaveBeenCalled();
    expect(executor.process).not.toHaveBeenCalled();
  });

  it('enabled: sweeps at start and again at 65 s, polls every 5 s with a 2× age look-back', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-12T10:00:00Z'));
    setEnv({ AI_AUTO_EXIT_ENABLED: 'true', AI_AUTO_EXIT_USER_IDS: 'owner' });
    const { poller, repo } = make();
    poller.onModuleInit();
    await Promise.resolve();
    expect(repo.sweepInterrupted).toHaveBeenCalledWith(new Date('2026-10-12T09:59:00Z'));
    jest.advanceTimersByTime(AI_EXIT_POLL_MS);
    await Promise.resolve();
    expect(repo.pendingVerdicts).toHaveBeenCalledWith(['owner'], new Date('2026-10-12T09:57:05Z'), 5);
    jest.advanceTimersByTime(65_000);
    expect(repo.sweepInterrupted).toHaveBeenCalledTimes(2);
    poller.onModuleDestroy();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('processes verdicts sequentially, oldest first, and a failing verdict does not stop the rest', async () => {
    setEnv({ AI_AUTO_EXIT_ENABLED: 'true', AI_AUTO_EXIT_USER_IDS: 'owner' });
    const { poller, repo, executor } = make();
    repo.pendingVerdicts.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
    executor.process.mockRejectedValueOnce(new Error('db blip')).mockResolvedValueOnce({ status: 'DRY_RUN' });
    poller.onModuleInit();
    await poller.runOnce();
    expect(executor.process.mock.calls.map((c) => c[0].id)).toEqual(['a', 'b']);
    poller.onModuleDestroy();
  });

  it('is single-flight: an overlapping pass does nothing', async () => {
    setEnv({ AI_AUTO_EXIT_ENABLED: 'true', AI_AUTO_EXIT_USER_IDS: 'owner' });
    const { poller, repo } = make();
    let release!: () => void;
    repo.pendingVerdicts.mockReturnValueOnce(new Promise((r) => { release = () => r([]); }));
    poller.onModuleInit();
    const first = poller.runOnce();
    await poller.runOnce();
    expect(repo.pendingVerdicts).toHaveBeenCalledTimes(1);
    release();
    await first;
    poller.onModuleDestroy();
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `cd apps/api && npx jest src/modules/sentinel-executor/services/sentinel-exit-poller.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the poller**

```ts
// apps/api/src/modules/sentinel-executor/services/sentinel-exit-poller.service.ts
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { BOOT_JOBS_DISABLED, bootJobsEnabled } from '../../../common/utils/boot-jobs';
import { parseAutoExitConfig } from '../domain/auto-exit.config';
import type { AutoExitConfig } from '../domain/auto-exit.types';
import { AiExitExecutionRepository } from '../repositories/ai-exit-execution.repository';
import { SentinelExitExecutor } from './sentinel-exit-executor.service';

export const AI_EXIT_POLL_MS = 5_000;
const CLAIM_STALE_MS = 60_000;
const SECOND_SWEEP_MS = 65_000;
const PER_PASS = 5;

/**
 * Spec §5.1. Disabled (the default), BOOT_JOBS=false, or an empty allow-list:
 * NOTHING runs — no timer, no query, no broker call. Enabled: crash sweep now and
 * at +65 s (ruling R8), then one indexed query every 5 s. No @Cron.
 */
@Injectable()
export class SentinelExitPoller implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SentinelExitPoller.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private sweepTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private cfg: AutoExitConfig | null = null;

  constructor(
    private readonly repo: AiExitExecutionRepository,
    private readonly executor: SentinelExitExecutor,
  ) {}

  onModuleInit(): void {
    const cfg = parseAutoExitConfig(process.env);
    for (const p of cfg.problems) this.logger.warn(`[ai-exit] ${p}`);
    if (!bootJobsEnabled()) {
      this.logger.log(BOOT_JOBS_DISABLED);
      return;
    }
    if (!cfg.enabled) {
      this.logger.log('[ai-exit] disabled (AI_AUTO_EXIT_ENABLED is not true)');
      return;
    }
    if (cfg.userIds.length === 0) {
      this.logger.error('[ai-exit] AI_AUTO_EXIT_ENABLED=true but AI_AUTO_EXIT_USER_IDS is empty — not starting');
      return;
    }
    this.cfg = cfg;
    this.logger.warn(
      `[ai-exit] ENABLED mode=${cfg.mode} users=${cfg.userIds.length} cap=${cfg.dailyCap}/day ` +
        `maxAge=${cfg.maxVerdictAgeSec}s fallback=${cfg.limitFallbackPct}%`,
    );
    void this.sweep();
    this.sweepTimer = setTimeout(() => void this.sweep(), SECOND_SWEEP_MS);
    this.sweepTimer.unref?.();
    this.timer = setInterval(() => void this.runOnce(), AI_EXIT_POLL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.sweepTimer) clearTimeout(this.sweepTimer);
    this.timer = null;
    this.sweepTimer = null;
  }

  async runOnce(now: Date = new Date()): Promise<void> {
    const cfg = this.cfg;
    if (!cfg || this.running) return;
    this.running = true;
    try {
      const since = new Date(now.getTime() - 2 * cfg.maxVerdictAgeSec * 1000);
      const verdicts = await this.repo.pendingVerdicts(cfg.userIds, since, PER_PASS);
      for (const v of verdicts) {
        try {
          await this.executor.process(v, cfg);
        } catch (err) {
          this.logger.error(`[ai-exit] verdict ${v.id} errored: ${err instanceof Error ? err.message : err}`);
        }
      }
    } catch (err) {
      this.logger.warn(`[ai-exit] poll failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      this.running = false;
    }
  }

  private async sweep(): Promise<void> {
    try {
      const n = await this.repo.sweepInterrupted(new Date(Date.now() - CLAIM_STALE_MS));
      if (n > 0) this.logger.warn(`[ai-exit] ${n} interrupted attempt(s) marked FAILED: INTERRUPTED (never re-sent)`);
    } catch (err) {
      this.logger.warn(`[ai-exit] sweep failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}
```

- [ ] **Step 4: Run it — expect PASS**

Run: `cd apps/api && npx jest src/modules/sentinel-executor/services/sentinel-exit-poller.service.spec.ts`
Expected: PASS.

- [ ] **Step 5: Wire the module**

```ts
// apps/api/src/modules/sentinel-executor/sentinel-executor.module.ts
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { MarketDataModule } from '../market-data/market-data.module';
import { CredentialDecryptorModule } from '../credential-vault/execution/credential-decryptor.module';
import { PerUserBrokerSessionFactory } from '../auto-execution/services/per-user-broker-session.factory';
import { MARKET_HOLIDAYS } from '../market-data/services/market-holidays.service';
import { SessionClock, parseLateClose } from '../market-hub/session-clock';
import { AiExitExecutionRepository } from './repositories/ai-exit-execution.repository';
import { OwnerBrokerSessionProvider } from './services/owner-broker-session.provider';
import {
  AI_EXIT_SESSION_CLOCK,
  AI_EXIT_SLEEP,
  SentinelExitExecutor,
} from './services/sentinel-exit-executor.service';
import { SentinelExitPoller } from './services/sentinel-exit-poller.service';
import { SentinelExecutorController } from './controllers/sentinel-executor.controller';

/**
 * Sentinel auto-exit (docs/superpowers/specs/2026-10-12-sentinel-auto-exit-design.md).
 * Separate from TradeSentinelModule by design: the two meet only in the database.
 * PerUserBrokerSessionFactory is provided locally (as TradeTrackerModule does) so
 * this module has no runtime dependency on AutoExecutionModule.
 */
@Module({
  imports: [PrismaModule, MarketDataModule, CredentialDecryptorModule],
  controllers: [SentinelExecutorController],
  providers: [
    AiExitExecutionRepository,
    OwnerBrokerSessionProvider,
    SentinelExitExecutor,
    SentinelExitPoller,
    PerUserBrokerSessionFactory,
    {
      provide: AI_EXIT_SESSION_CLOCK,
      useFactory: (config: ConfigService) =>
        new SessionClock({
          holidays: MARKET_HOLIDAYS,
          mcxLateClose: parseLateClose(config.get<string>('hub.mcxLateClose')),
        }),
      inject: [ConfigService],
    },
    { provide: AI_EXIT_SLEEP, useValue: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) },
  ],
})
export class SentinelExecutorModule {}
```

`SentinelExecutorController` arrives in Task 11; if Task 10 is committed first, register `controllers: []` here and add the controller in Task 11.

In `apps/api/src/app.module.ts`, add `import { SentinelExecutorModule } from './modules/sentinel-executor/sentinel-executor.module';` after the `TradeSentinelModule` import, and `SentinelExecutorModule,` directly after `TradeSentinelModule,` in `imports`.

Append to `deploy/env/api.env.example` after the `SENTINEL_*` lines:

```
# Sentinel auto-exit (docs/superpowers/specs/2026-10-12-sentinel-auto-exit-design.md).
# Places a closing order on Angel One when the sentinel says EXIT_NOW. OFF by default.
# Off = no timer, no query, no broker call. Turn off: AI_AUTO_EXIT_ENABLED=false + restart.
AI_AUTO_EXIT_ENABLED=false
# dry-run = everything except the order (rows status DRY_RUN). live = real orders.
AI_AUTO_EXIT_MODE=dry-run
# Comma-separated user ids allowed to be auto-exited (the owner only).
AI_AUTO_EXIT_USER_IDS=
AI_AUTO_EXIT_DAILY_CAP=5
AI_AUTO_EXIT_MAX_VERDICT_AGE_SEC=90
AI_AUTO_EXIT_LIMIT_FALLBACK_PCT=2
# Order quantity unit per exchange, EXCHANGE:units|lots (ruling R16). Empty = NFO/BFO units,
# MCX UNCONFIGURED (MCX exits are dry-run only until set, after the dry-run MCX check).
AI_AUTO_EXIT_QTY_UNITS=
```

- [ ] **Step 6: Typecheck and boot-shape check**

Run: `cd apps/api && npx tsc --noEmit -p tsconfig.json` → exit 0.
Run: `cd apps/api && npx jest src/modules/sentinel-executor src/modules/trade-sentinel src/common/schedule/cron-timezone.spec.ts`
Expected: PASS — the sentinel's structural specs and the cron ratchet are unchanged and green.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/sentinel-executor/services/sentinel-exit-poller.service.ts apps/api/src/modules/sentinel-executor/services/sentinel-exit-poller.service.spec.ts apps/api/src/modules/sentinel-executor/sentinel-executor.module.ts apps/api/src/app.module.ts deploy/env/api.env.example
git commit -m "feat(sentinel-executor): 5 s poller (inert unless enabled), module wiring, env example

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: Executions endpoint, DTO, structural isolation spec (Stream D)

**Files:**
- Create: `apps/api/src/modules/sentinel-executor/dto/ai-exit-execution.dto.ts`
- Create: `apps/api/src/modules/sentinel-executor/controllers/sentinel-executor.controller.ts`
- Test: `apps/api/src/modules/sentinel-executor/controllers/sentinel-executor.controller.spec.ts`
- Create: `apps/api/src/modules/sentinel-executor/sentinel-executor.structure.spec.ts`
- Modify (if Task 10 registered `controllers: []`): `apps/api/src/modules/sentinel-executor/sentinel-executor.module.ts`

**Interfaces:**
- Consumes: `AiExitExecutionRepository.listForUser` (Task 5), `parseAutoExitConfig` (Task 2), `CurrentUser`/`AuthenticatedUser` (`apps/api/src/common/decorators`).
- Produces (wire contract, copied into Task 12):

```ts
export interface AiExitExecutionDto {
  id: string;
  verdictId: string;
  trackerId: string;
  symbol: string;
  exchange: string | null;
  side: 'BUY' | 'SELL' | null;
  quantity: number | null;
  productType: string | null;
  orderType: 'MARKET' | 'LIMIT' | null;
  limitPrice: number | null;
  mode: 'dry-run' | 'live';
  status: 'CLAIMED' | 'SKIPPED' | 'DRY_RUN' | 'PLACED' | 'FILLED' | 'REJECTED' | 'FAILED';
  reason: string | null;
  sessionSource: 'user-feed' | 'ephemeral' | null;
  brokerOrderId: string | null;
  brokerMessage: string | null;
  orderStatus: string | null;
  marketOrderId: string | null;
  verdictReason: string;
  createdAt: string; // ISO
  updatedAt: string; // ISO
}
```

- `GET /api/sentinel-executor/executions?limit=N` (default 20, max 100) → `AiExitExecutionDto[]` newest first; 403 unless ADMIN or allow-listed (ruling R13).

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/modules/sentinel-executor/controllers/sentinel-executor.controller.spec.ts
import { ForbiddenException } from '@nestjs/common';
import { SentinelExecutorController } from './sentinel-executor.controller';

const row = {
  id: 'r1', userId: 'owner', verdictId: 'v1', trackerId: 't1', symbol: 'X', exchange: 'MCX', token: '1',
  side: 'SELL', quantity: 100, productType: 'CARRYFORWARD', orderType: 'MARKET', limitPrice: null,
  mode: 'dry-run', status: 'DRY_RUN', reason: 'would SELL', sessionSource: 'user-feed', brokerOrderId: null,
  brokerMessage: null, orderStatus: null, marketOrderId: null, verdictReason: 'thesis broken',
  createdAt: new Date('2026-10-12T10:00:00Z'), updatedAt: new Date('2026-10-12T10:00:01Z'),
};

describe('SentinelExecutorController', () => {
  const repo = { listForUser: jest.fn().mockResolvedValue([row]) };
  const ctl = new SentinelExecutorController(repo as never);
  afterEach(() => { delete process.env.AI_AUTO_EXIT_USER_IDS; repo.listForUser.mockClear(); });

  it('allow-listed user sees only their own rows, mapped to the DTO', async () => {
    process.env.AI_AUTO_EXIT_USER_IDS = 'owner';
    const out = await ctl.list({ userId: 'owner', role: 'USER', email: 'o@x' });
    expect(repo.listForUser).toHaveBeenCalledWith('owner', 20);
    expect(out[0]).toEqual(expect.objectContaining({ id: 'r1', status: 'DRY_RUN', createdAt: '2026-10-12T10:00:00.000Z' }));
    expect(out[0]).not.toHaveProperty('userId');
  });

  it('an admin not on the allow-list is allowed, still scoped to self', async () => {
    await ctl.list({ userId: 'admin1', role: 'ADMIN', email: 'a@x' });
    expect(repo.listForUser).toHaveBeenCalledWith('admin1', 20);
  });

  it('anyone else is 403 and nothing is read', async () => {
    process.env.AI_AUTO_EXIT_USER_IDS = 'owner';
    await expect(ctl.list({ userId: 'u2', role: 'USER', email: 'u@x' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(repo.listForUser).not.toHaveBeenCalled();
  });

  it('limit is clamped to 1..100', async () => {
    process.env.AI_AUTO_EXIT_USER_IDS = 'owner';
    await ctl.list({ userId: 'owner', role: 'USER', email: 'o@x' }, '1000');
    expect(repo.listForUser).toHaveBeenLastCalledWith('owner', 100);
    await ctl.list({ userId: 'owner', role: 'USER', email: 'o@x' }, 'abc');
    expect(repo.listForUser).toHaveBeenLastCalledWith('owner', 20);
  });
});
```

```ts
// apps/api/src/modules/sentinel-executor/sentinel-executor.structure.spec.ts
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const MODULES = join(__dirname, '..');
const IMPORT = /from\s+['"]([^'"]+)['"]/g;

function files(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) files(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}
const specifiers = (f: string) => [...readFileSync(f, 'utf8').matchAll(IMPORT)].map((m) => m[1]);

describe('sentinel-executor is decoupled from trade-sentinel (spec §4, plan R14)', () => {
  it('no executor file imports anything from trade-sentinel', () => {
    const own = files(__dirname);
    expect(own.length).toBeGreaterThan(8);
    const offenders = own.filter((f) => specifiers(f).some((s) => s.includes('trade-sentinel')));
    expect(offenders).toEqual([]);
  });

  it('no trade-sentinel file imports the executor', () => {
    const sentinel = files(join(MODULES, 'trade-sentinel'));
    expect(sentinel.length).toBeGreaterThan(10);
    const offenders = sentinel.filter((f) => specifiers(f).some((s) => s.includes('sentinel-executor')));
    expect(offenders).toEqual([]);
  });

  it('the sentinel shadow-mode spec this module relies on still exists', () => {
    expect(existsSync(join(MODULES, 'trade-sentinel', 'services', 'sentinel-cycle.service.spec.ts'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run them — expect FAIL**

Run: `cd apps/api && npx jest src/modules/sentinel-executor/controllers src/modules/sentinel-executor/sentinel-executor.structure.spec.ts`
Expected: controller spec FAILS (module not found); the structure spec may already PASS — that is fine (it is a guard).

- [ ] **Step 3: Implement**

```ts
// apps/api/src/modules/sentinel-executor/dto/ai-exit-execution.dto.ts
import type { AiExitExecution } from '@prisma/client';

export interface AiExitExecutionDto {
  id: string;
  verdictId: string;
  trackerId: string;
  symbol: string;
  exchange: string | null;
  side: 'BUY' | 'SELL' | null;
  quantity: number | null;
  productType: string | null;
  orderType: 'MARKET' | 'LIMIT' | null;
  limitPrice: number | null;
  mode: 'dry-run' | 'live';
  status: 'CLAIMED' | 'SKIPPED' | 'DRY_RUN' | 'PLACED' | 'FILLED' | 'REJECTED' | 'FAILED';
  reason: string | null;
  sessionSource: 'user-feed' | 'ephemeral' | null;
  brokerOrderId: string | null;
  brokerMessage: string | null;
  orderStatus: string | null;
  marketOrderId: string | null;
  verdictReason: string;
  createdAt: string;
  updatedAt: string;
}

export function toAiExitExecutionDto(r: AiExitExecution): AiExitExecutionDto {
  return {
    id: r.id,
    verdictId: r.verdictId,
    trackerId: r.trackerId,
    symbol: r.symbol,
    exchange: r.exchange,
    side: r.side as AiExitExecutionDto['side'],
    quantity: r.quantity,
    productType: r.productType,
    orderType: r.orderType as AiExitExecutionDto['orderType'],
    limitPrice: r.limitPrice,
    mode: r.mode as AiExitExecutionDto['mode'],
    status: r.status as AiExitExecutionDto['status'],
    reason: r.reason,
    sessionSource: r.sessionSource as AiExitExecutionDto['sessionSource'],
    brokerOrderId: r.brokerOrderId,
    brokerMessage: r.brokerMessage,
    orderStatus: r.orderStatus,
    marketOrderId: r.marketOrderId,
    verdictReason: r.verdictReason,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}
```

```ts
// apps/api/src/modules/sentinel-executor/controllers/sentinel-executor.controller.ts
import { Controller, ForbiddenException, Get, Query } from '@nestjs/common';
import { CurrentUser } from '../../../common/decorators';
import type { AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import { parseAutoExitConfig } from '../domain/auto-exit.config';
import { AiExitExecutionRepository } from '../repositories/ai-exit-execution.repository';
import { toAiExitExecutionDto, type AiExitExecutionDto } from '../dto/ai-exit-execution.dto';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * Read-only view of what the auto-exit did (spec §8). Global JWT guard; caller
 * must be ADMIN or allow-listed (ruling R13); rows are ALWAYS the caller's own.
 * Deliberately not on SentinelController, which must stay exit-free.
 */
@Controller('api/sentinel-executor')
export class SentinelExecutorController {
  constructor(private readonly repo: AiExitExecutionRepository) {}

  @Get('executions')
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('limit') limit?: string,
  ): Promise<AiExitExecutionDto[]> {
    const allowed = parseAutoExitConfig(process.env).userIds;
    if (user?.role !== 'ADMIN' && !allowed.includes(user?.userId)) {
      throw new ForbiddenException('AI exits are not enabled for this account');
    }
    const n = Number.parseInt(String(limit ?? ''), 10);
    const take = Number.isFinite(n) && n > 0 ? Math.min(n, MAX_LIMIT) : DEFAULT_LIMIT;
    const rows = await this.repo.listForUser(user.userId, take);
    return rows.map(toAiExitExecutionDto);
  }
}
```

Ensure `sentinel-executor.module.ts` lists `controllers: [SentinelExecutorController]`.

- [ ] **Step 4: Run them — expect PASS**

Run: `cd apps/api && npx jest src/modules/sentinel-executor src/modules/trade-sentinel/controllers/sentinel.controller.spec.ts src/modules/trade-sentinel/services/sentinel-cycle.service.spec.ts`
Expected: PASS (all executor specs; sentinel specs unchanged and green).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/sentinel-executor/dto/ai-exit-execution.dto.ts apps/api/src/modules/sentinel-executor/controllers/sentinel-executor.controller.ts apps/api/src/modules/sentinel-executor/controllers/sentinel-executor.controller.spec.ts apps/api/src/modules/sentinel-executor/sentinel-executor.structure.spec.ts apps/api/src/modules/sentinel-executor/sentinel-executor.module.ts
git commit -m "feat(sentinel-executor): GET executions (admin/allow-list, self-scoped) and isolation spec

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: "AI exits" list on the Charts page (Stream C)

**Files:**
- Create: `apps/web/src/components/charts/aiExitView.ts`
- Test: `apps/web/src/components/charts/aiExitView.test.ts`
- Create: `apps/web/src/hooks/useAiExits.ts`
- Create: `apps/web/src/components/charts/AiExitsList.tsx`
- Modify: `apps/web/src/pages/charts/ChartsPage.tsx` (~line 708, right after `<SentinelPanel …/>`)

**Interfaces:**
- Consumes: the `AiExitExecutionDto` wire contract from Task 11 (re-declared in the hook as `AiExitRow`), `agoLabel` from `./overnightPlanView`, `api` from `@/services/api` (`baseURL: '/api'`).
- Produces: `aiExitRowView(row: AiExitRow, now?: number): AiExitRowView`, `recentAiExits(rows: AiExitRow[], now?: number): AiExitRow[]`, `useAiExits(): { rows: AiExitRow[] }`, default export `AiExitsList`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/components/charts/aiExitView.test.ts
import { describe, it, expect } from 'vitest';
import { aiExitRowView, recentAiExits } from './aiExitView';
import type { AiExitRow } from '@/hooks/useAiExits';

const NOW = Date.parse('2026-10-12T10:05:00.000Z');
function row(over: Partial<AiExitRow> = {}): AiExitRow {
  return {
    id: 'r1', verdictId: 'v1', trackerId: 't1', symbol: 'CRUDEOIL15OCT268950CE', exchange: 'MCX',
    side: 'SELL', quantity: 100, productType: 'CARRYFORWARD', orderType: 'MARKET', limitPrice: null,
    mode: 'live', status: 'FILLED', reason: null, sessionSource: 'user-feed', brokerOrderId: '2610120001',
    brokerMessage: 'SUCCESS', orderStatus: 'complete', marketOrderId: null, verdictReason: 'thesis broken',
    createdAt: '2026-10-12T10:00:00.000Z', updatedAt: '2026-10-12T10:00:10.000Z', ...over,
  };
}

describe('aiExitRowView', () => {
  it('filled live MARKET', () => {
    expect(aiExitRowView(row(), NOW)).toEqual({
      label: 'FILLED', tone: 'emerald',
      line: 'SELL 100 CRUDEOIL15OCT268950CE (CARRYFORWARD) at MARKET',
      detail: 'order 2610120001 · thesis broken', ago: '5 min ago', dryRun: false,
    });
  });
  it('dry-run is labelled and muted', () => {
    const v = aiExitRowView(row({ mode: 'dry-run', status: 'DRY_RUN', brokerOrderId: null }), NOW);
    expect([v.label, v.tone, v.dryRun]).toEqual(['DRY RUN', 'muted', true]);
  });
  it('LIMIT fallback shows the price and the refused market order', () => {
    const v = aiExitRowView(row({ orderType: 'LIMIT', limitPrice: 49.2, marketOrderId: 'M1', status: 'PLACED' }), NOW);
    expect(v.line).toBe('SELL 100 CRUDEOIL15OCT268950CE (CARRYFORWARD) LIMIT 49.2');
    expect(v.detail).toContain('MARKET refused (M1)');
    expect(v.tone).toBe('amber');
  });
  it('skipped before planning has no order line, shows the reason', () => {
    const v = aiExitRowView(row({ status: 'SKIPPED', reason: 'EXCHANGE_CLOSED', side: null, quantity: null, orderType: null, brokerOrderId: null }), NOW);
    expect([v.label, v.tone, v.line]).toEqual(['SKIPPED', 'muted', 'CRUDEOIL15OCT268950CE — EXCHANGE_CLOSED']);
  });
  it('rejected / failed are red and carry the broker message', () => {
    const v = aiExitRowView(row({ status: 'REJECTED', reason: 'BROKER_REJECTED', brokerMessage: 'Insufficient margin', brokerOrderId: null }), NOW);
    expect([v.tone, v.detail]).toEqual(['red', 'BROKER_REJECTED: Insufficient margin · thesis broken']);
  });
});

describe('recentAiExits', () => {
  it('keeps the last 24 h, newest first, at most 10', () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      row({ id: `r${i}`, createdAt: new Date(NOW - i * 60_000).toISOString() }));
    rows.push(row({ id: 'old', createdAt: new Date(NOW - 25 * 3600_000).toISOString() }));
    const out = recentAiExits(rows, NOW);
    expect(out).toHaveLength(10);
    expect(out[0].id).toBe('r0');
    expect(out.some((r) => r.id === 'old')).toBe(false);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `cd apps/web && npx vitest run src/components/charts/aiExitView.test.ts`
Expected: FAIL — cannot resolve `./aiExitView` / `@/hooks/useAiExits`.

- [ ] **Step 3: Implement the hook, the view, the component, the page slot**

```ts
// apps/web/src/hooks/useAiExits.ts
import { useCallback, useEffect, useState } from 'react';
import api from '@/services/api';

/** Wire shape of GET /api/sentinel-executor/executions (api: AiExitExecutionDto). */
export interface AiExitRow {
  id: string;
  verdictId: string;
  trackerId: string;
  symbol: string;
  exchange: string | null;
  side: 'BUY' | 'SELL' | null;
  quantity: number | null;
  productType: string | null;
  orderType: 'MARKET' | 'LIMIT' | null;
  limitPrice: number | null;
  mode: 'dry-run' | 'live';
  status: 'CLAIMED' | 'SKIPPED' | 'DRY_RUN' | 'PLACED' | 'FILLED' | 'REJECTED' | 'FAILED';
  reason: string | null;
  sessionSource: 'user-feed' | 'ephemeral' | null;
  brokerOrderId: string | null;
  brokerMessage: string | null;
  orderStatus: string | null;
  marketOrderId: string | null;
  verdictReason: string;
  createdAt: string;
  updatedAt: string;
}

const POLL_MS = 30_000;

/**
 * What the auto-exit did. FAILS QUIET like useSentinelPositions: 403 (not the
 * owner), 404 (not deployed) or a cold API leaves the list empty and the page
 * looks exactly as before.
 */
export function useAiExits() {
  const [rows, setRows] = useState<AiExitRow[]>([]);
  const refresh = useCallback(async () => {
    try {
      const { data } = await api.get<AiExitRow[]>('/sentinel-executor/executions', { params: { limit: 20 } });
      setRows(Array.isArray(data) ? data : []);
    } catch {
      setRows([]);
    }
  }, []);
  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);
  return { rows };
}
```

```ts
// apps/web/src/components/charts/aiExitView.ts
import type { AiExitRow } from '@/hooks/useAiExits';
import { agoLabel } from './overnightPlanView';

export type AiExitTone = 'emerald' | 'amber' | 'red' | 'muted';
export interface AiExitRowView {
  label: string;
  tone: AiExitTone;
  line: string;
  detail: string;
  ago: string;
  dryRun: boolean;
}

const TONE: Record<AiExitRow['status'], AiExitTone> = {
  FILLED: 'emerald',
  PLACED: 'amber',
  CLAIMED: 'amber',
  DRY_RUN: 'muted',
  SKIPPED: 'muted',
  REJECTED: 'red',
  FAILED: 'red',
};

export function aiExitRowView(r: AiExitRow, now: number = Date.now()): AiExitRowView {
  const planned = r.side && r.quantity != null;
  const product = r.productType ? ` (${r.productType})` : '';
  const how = r.orderType === 'LIMIT' && r.limitPrice != null ? ` LIMIT ${r.limitPrice}` : ' at MARKET';
  const line = planned
    ? `${r.side} ${r.quantity} ${r.symbol}${product}${how}`
    : `${r.symbol} — ${r.reason ?? r.status}`;
  const parts: string[] = [];
  if (r.status === 'REJECTED' || r.status === 'FAILED') {
    parts.push(r.brokerMessage ? `${r.reason ?? r.status}: ${r.brokerMessage}` : r.reason ?? r.status);
  } else if (r.brokerOrderId) {
    parts.push(`order ${r.brokerOrderId}`);
  }
  if (r.marketOrderId) parts.push(`MARKET refused (${r.marketOrderId})`);
  parts.push(r.verdictReason);
  return {
    label: r.status === 'DRY_RUN' ? 'DRY RUN' : r.status,
    tone: TONE[r.status] ?? 'muted',
    line,
    detail: parts.join(' · '),
    ago: agoLabel(r.createdAt, now),
    dryRun: r.mode === 'dry-run',
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function recentAiExits(rows: AiExitRow[], now: number = Date.now()): AiExitRow[] {
  return rows
    .filter((r) => now - Date.parse(r.createdAt) <= DAY_MS)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, 10);
}
```

```tsx
// apps/web/src/components/charts/AiExitsList.tsx
import { Bot } from 'lucide-react';
import clsx from 'clsx';
import { useAiExits } from '@/hooks/useAiExits';
import { aiExitRowView, recentAiExits, type AiExitTone } from './aiExitView';

const TONE_CLS: Record<AiExitTone, string> = {
  emerald: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  amber: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
  red: 'bg-red-500/15 text-red-400 border-red-500/30',
  muted: 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)] border-[var(--color-border-subtle)]',
};

/**
 * What the sentinel auto-exit did in the last 24 h. Renders NOTHING when there
 * is nothing to show or the account is not enabled — a sibling of SentinelPanel
 * because an exited position no longer has a sentinel card (ruling R15).
 */
export default function AiExitsList() {
  const { rows } = useAiExits();
  const recent = recentAiExits(rows);
  if (recent.length === 0) return null;
  return (
    <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-card)] p-3 text-xs">
      <div className="mb-2 flex items-center gap-1.5 font-medium text-[var(--color-text-secondary)]">
        <Bot size={12} />
        AI exits
      </div>
      <ul className="flex flex-col gap-1.5">
        {recent.map((r) => {
          const v = aiExitRowView(r);
          return (
            <li key={r.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className={clsx('rounded border px-1.5 py-0.5 font-semibold', TONE_CLS[v.tone])}>{v.label}</span>
              <span className="text-[var(--color-text-primary)]">{v.line}</span>
              <span className="text-[var(--color-text-muted)]">{v.ago}</span>
              <span className="basis-full text-[11px] text-[var(--color-text-muted)]">{v.detail}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
```

In `apps/web/src/pages/charts/ChartsPage.tsx`: add `import AiExitsList from '@/components/charts/AiExitsList';` next to the `SentinelPanel` import (line 16), and directly after `{!isFullscreen && <SentinelPanel positions={sentinelHere} />}` (line 708) add:

```tsx
      {!isFullscreen && <AiExitsList />}
```

- [ ] **Step 4: Run tests and typecheck — expect PASS**

Run: `cd apps/web && npx vitest run src/components/charts/aiExitView.test.ts` → PASS.
Run: `cd apps/web && npx tsc --noEmit -p tsconfig.json` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/hooks/useAiExits.ts apps/web/src/components/charts/aiExitView.ts apps/web/src/components/charts/aiExitView.test.ts apps/web/src/components/charts/AiExitsList.tsx apps/web/src/pages/charts/ChartsPage.tsx
git commit -m "feat(web): AI exits list under the sentinel panel on Charts

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Task 13: Whole-branch verification (Stream D, after all merges)

**Files:** none new.

- [ ] **Step 1: Full API suite and typecheck**

Run: `cd apps/api && npx tsc --noEmit -p tsconfig.json && npx jest`
Expected: exit 0; every pre-existing spec still green, in particular `trade-sentinel/services/sentinel-cycle.service.spec.ts`, `trade-sentinel/controllers/sentinel.controller.spec.ts`, `trade-sentinel/trade-sentinel.module.spec.ts`, `market-hub/only-door.spec.ts`, `common/schedule/cron-timezone.spec.ts`.

- [ ] **Step 2: Web suite and typecheck**

Run: `cd apps/web && npx tsc --noEmit -p tsconfig.json && npx vitest run`
Expected: exit 0.

- [ ] **Step 3: Grep checks (each must print nothing)**

```bash
grep -rn "@Cron" apps/api/src/modules/sentinel-executor
grep -rn "trade-sentinel" apps/api/src/modules/sentinel-executor --include=*.ts | grep -v "structure.spec"
grep -rn "sentinel-executor" apps/api/src/modules/trade-sentinel
grep -rn "AngelOneAuthService" apps/api/src/modules/sentinel-executor
git diff main --stat -- apps/api/src/modules/trade-sentinel
```

- [ ] **Step 4: Migration is expand-only**

Run: `grep -niE "drop |alter table" prisma/migrations/20261012140000_sentinel_auto_exit/migration.sql`
Expected: exactly one line — `ALTER TABLE "ai_exit_executions" ADD CONSTRAINT ...` — and no `DROP`.

- [ ] **Step 5: Commit only if a fix was needed** (explicit pathspecs, same trailer). Otherwise nothing to commit.

---

## Production Gate

Deployment ships **inert** (`AI_AUTO_EXIT_ENABLED=false`): the migration applies, no timer starts. Then:

**A. Pre-flight (owner + operator, once)**
- [ ] The owner's vault Angel credentials use the **GrWW** app key (static IP 157.10.98.70). `ANGEL_ONE_API_KEY`/`ANGEL_ONE_CLIENT_ID` in `api.env` are unset or are the owner's same GrWW app (the executor never uses them, but the tracker's feed-account read does).
- [ ] `MARKET_HUB_ENABLED=true` and `HUB_OWNER_USER_ID=<owner userId>` (so tier 1 of R1 — the warm `user-feed` session — exists).
- [ ] `[trade-sentinel]` is producing verdicts (health endpoint `sentinel_verdicts MAX(createdAt)` fresh).

**B. Dry-run session (one full live NFO day and one MCX evening)**
- [ ] Set `AI_AUTO_EXIT_ENABLED=true`, `AI_AUTO_EXIT_MODE=dry-run`, `AI_AUTO_EXIT_USER_IDS=<owner userId>`; restart the API. Log shows `[ai-exit] ENABLED mode=dry-run users=1 cap=5/day …` and no `[ai-exit]` problem lines.
- [ ] For every `DRY_RUN` row (Charts → AI exits, or `GET /api/sentinel-executor/executions`): compare `side`, `quantity`, `productType`, `symbol` with the Angel app's position screen at that minute. **MCX check:** the row's `quantity` must equal the number Angel's own square-off would send for that MCX contract (confirms netqty and order quantity are in the same unit — see Open Questions).
- [ ] Every row has `sessionSource = user-feed`. Any `ephemeral` → stop and investigate before going live (a second login could disturb the hub session).
- [ ] No `FAILED: BROKER_READ` / `ORDER_BOOK_READ` rows; `SKIPPED` reasons make sense (`EXCHANGE_CLOSED` outside hours, `ALREADY_FLAT` after a manual exit, `OPEN_ORDER_EXISTS` when the owner had an order working).
- [ ] The daily cap behaves: the 6th `EXIT_NOW` of an IST day is `SKIPPED: DAILY_CAP` with one WARN.
- [ ] Live feed/hub unaffected during the session (charts tick, no hub reconnect storm in logs).

**C. Live switch**
- [ ] Owner says go. Set `AI_AUTO_EXIT_MODE=live`; restart. Log shows `mode=live`.
- [ ] First live `EXIT_NOW`: row goes `CLAIMED → PLACED → FILLED` (or a clear `REJECTED` with the broker text) within ~10 s; Angel order book shows exactly one order with `ordertag` starting `axM`; the tracker closes on the next reconcile.
- [ ] If a MARKET refusal occurs, verify exactly one `axL` LIMIT followed, at the logged price on the tick; tighten `isMarketRefusal` to Angel's exact wording in a follow-up if needed.

**Stop switch (any time):** `AI_AUTO_EXIT_ENABLED=false` + API restart. Nothing else changes; the sentinel keeps running in shadow.

## Open Questions for the Owner

1. **MCX quantity unit.** The executor sends `quantity = |netqty|` from Angel's own positions row. That is correct as long as Angel reports `netqty` and accepts order `quantity` in the same unit for MCX (lots vs units). The repo has no MCX order history to confirm it. The dry-run gate checks it (B, MCX check); live MCX exits should not be enabled until that check passes. **Resolved in code by R16:** MCX has no default unit, so live MCX exits are refused (`QTY_UNIT_UNCONFIGURED:MCX`) until the owner sets `AI_AUTO_EXIT_QTY_UNITS=MCX:units` or `MCX:lots` from the dry-run MCX check (dry-run rows for MCX are flagged unit-unverified and carry `|netqty|`).
