# SP2 M5 Journal, Entries and Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Owner decisions needed (before execution starts)

M5 has **no design spec of its own**; this plan argues from the parent SP2 spec (§3 entry source, §8 journal and
reconciliation, §8.4 UI, §10 tests, §11 M5 row), the M1–M4 plans' "Notes for later milestones", the owner ruling of
2026-10-12 (realised loss alone breaches the daily limit) and the merged code. Every default below is one named place
in the code, so a different answer is a small change. Execution may start on the defaults; an owner change is folded
in before the task that owns it.

| # | Question | Default in this plan | Where it lives |
|---|---|---|---|
| O1 | Approve this plan's rulings (J1–J24) as the M5 design, or ask for a separate M5 spec first? | Approve the plan as the design | — |
| O2 | How are core entries switched on? | `CORE_ENTRIES_MODE` = `off` (**default**) \| `journal` (everything up to and including the Risk Wall verdict, journaled; **no order**) \| `paper` (paper positions). Plus `CORE_ENTRY_USER_IDS` (comma list; **empty = nobody**). Production gate: one session in `journal`, then `paper` | `intake/entry-config.ts` |
| O3 | Where does the Chartink fan-out hook in? | At the **end** of `ChartinkProcessService.processOne`, after every silo path, for **scored** hits only (unresolved, no-direction, market-closed and scoring-error hits never reach the core); fire-and-forget through a module-level registry (the kill-gate pattern), so no silo constructor or module changes | `intake/alert-handoff.ts`, one call in `chartink-process.service.ts` |
| O4 | `OPTIONS_BUY` versions (needs the strike/expiry picker, M4 drift D10) | **Deferred.** Such a version's matching alert is journaled `INTENT_SKIPPED VEHICLE_UNSUPPORTED`. No seeded strategy uses options | `intake/entry-rules.ts` `matchEntry` |
| O5 | Code-evaluator entries (`entry.kind = 'evaluator'`) and the signal-generator universe scanner as entry sources | **Deferred** to SP3's DecisionPipeline (SP3 spec §7). Chartink is M5's only entry source; an evaluator-entry version never matches a Chartink hit | `matchEntry` |
| O6 | The Adaptive-Stop decision gate cannot evaluate (too few 15m candles) | **Honour the version's `failOpen` param** (the seed says `true`: silo parity, M1 note) and journal `skipped: true` in the gate outcome | `intake/gate-evaluators.ts` |
| O7 | No usable ATR (hub candles off or too few bars) for a `stop.atr` version | **Stop at `stop.minPct`** (`resolveStopPct`'s floor, the silo's rule), journaled `atrSource: 'none'`. Alternative: skip the entry | `intake/core-entry-intake.service.ts` |
| O8 | `core_strategy_selections.capitalAllocation` | **Not enforced in M5** (journaled in `ALERT_RECEIVED`); the Risk Wall's `maxCapitalDeployed` per vehicle governs | intake |
| O9 | SP3 corpus: does M5 write `ai_decision_records`? | **Yes**, in `paper` mode: one `ENTRY_SETUP` row per core setup that matched a strategy's entry (taken or skipped), `source='core'`, `sourceId=intentId`; `outcome` filled at close (summary) and by the skipped-intent price follow-ups | `journal/core-corpus.writer.ts` |
| O10 | Reconciliation block scope and threshold | A finding tied to a position blocks **that strategy's** entries; a user-wide finding blocks **all** the user's core entries; both until the owner acknowledges (POST with a reason). "Stuck" = older than **2 × `noPriceRejectMs`** (no new setting) | `journal/recon-checks.ts`, `journal/core-reconciler.service.ts` |
| O11 | Alerts for `RECON_MISMATCH`, blind positions, the daily-loss latch | No owner push channel exists yet (same as the sentinel auto-exit spec §8): **journal row + `logger.error` + `GET /api/trade-core/journal/status`**, shown on the Core Journal page. Telegram later | controller + page |
| O12 | May the sentinel / AI act on **core** paper positions in M5? | **No.** The sentinel reviews broker `trade_trackers` and its executor acts on broker positions only. The bridge (sentinel verdict → `CoreLifecycleService.requestExit(…, 'GUARD_RAIL', …)` / `proposeStop`) is SP3 M6; the seam already exists | — (note for SP3 M6) |
| O13 | Daily-loss latch semantics (spec §5.3 "blocked for the rest of the session") | Latched the first time today's decision is `BREACHED` (any `dailyLossAction`, including the 2026-10-12 realised-only breach) or the wall rejects with `DAILY_LOSS`; lasts the IST day; there is no un-latch | `daily-loss.monitor.ts`, `journal-sinks.ts`, `journal-risk-reads.ts` |
| O14 | Skipped-intent price follow-ups (spec §8.1) | **16:10 IST Mon–Fri**, at most **300 distinct instruments a day** (a load bound, not a risk value) | `journal/skip-followup.cron.ts` |

## Preconditions (the controller checks these before dispatching)

- **P1 — the 2026-10-12 realised-loss ruling is in the base.** `fix/daily-loss-realised-breach` (`c26d613`: realised
  loss alone breaches `maxDailyLoss` when open P&L is unknown) is **not** in `release/auto-exit-sentinel-inputs @ 053da3a`.
  Tasks 14 and 16 edit `lifecycle/daily-loss.monitor.ts` and `risk-wall/risk-wall.ts`, and their code below is written
  against the **post-fix** files. Before Stream E starts: `git merge-base --is-ancestor c26d613 HEAD` on the M5
  integration branch; if it fails, the controller merges `fix/daily-loss-realised-breach` into `feature/sp2-m5` first
  (it is a reviewed owner ruling; no conflict with M5's foundation tasks, which touch neither file).
- **P2 — seeds are DRAFT.** `csv_adaptive_stop_v1` and `csv_ungated_v1` were seeded `DRAFT` (M1). Nothing trades until
  the owner approves Adaptive-Stop v1 into `PAPER` and enables its selection on Core Strategies (production gate step 2).

## Goal, architecture, stack

**Goal:** Finish SP2: the append-only `core_journal` (every verdict, order, fill, lifecycle transition, kill-switch and
limit change, skip and reconciliation finding), one `core_trade_summaries` row per closed position (net P&L after
charges and MTF interest, R-multiple, MFE/MAE, holding time, exit reason), reconciliation every 5 minutes in session
and nightly at 15:45 IST with an owner-acknowledged entry block, the persisted daily-loss latch, the Chartink fan-out
that turns alerts into `CoreEntryIntent`s for the user's enabled `PAPER` strategy versions (entry block, filters,
decision gate, ATR stop, sizing → Risk Wall → `openPosition`) behind a default-off switch, the skipped-intent price
follow-ups, the SP3 corpus rows, and the Core Journal page (timeline, daily summary, core-vs-silo comparison). **SP2 is
done** when Adaptive-Stop v1 runs in paper on real Chartink alerts for one full NSE session with a complete journal,
clean reconciliation and an exercised kill switch (spec §1) — the production gate below.

**Architecture:** Two new parts of `apps/api/src/modules/trade-core/`. `journal/` (spec §3) holds the journal and
summary stores, `CoreJournalService` (best-effort `record` with a bounded retry buffer, durable `recordNow`), the sinks
that rebind M2's `RISK_VERDICT_SINK` and M4's `LIFECYCLE_EVENT_SINK`, an `OrderJournaler` on the adapter's order-update
stream, the pure `summarizeTrade` and `CoreTradeSummaryService`, the corpus writer, the pure reconciliation checks and
`CoreReconciler`, the skipped-intent follow-up cron and the read API. `intake/` holds the pure entry rules, the
evaluator-gate registry, `EntryMarket` (hub price + hub candles) and `CoreEntryIntake`, reached from Chartink through
`handOffChartinkHit` (a module-level registry, like M2's kill gate). The flow is spec §3's, one direction:
`Chartink processOne → handOffChartinkHit → CoreEntryIntake (queue) → matchEntry/filters/gate/ATR/sizing →
RiskWallService.check → CoreLifecycleService.openPosition → (M3/M4) → JournalLifecycleSink → CoreTradeSummaryService`.
Approach A holds: the silo path is unchanged except one fire-and-forget call at the end of `processOne`.

**Tech Stack:** NestJS 11, TypeScript 5.7, Prisma 6 (PostgreSQL), Jest 29 (`ts-jest`, `isolatedModules`) for the API;
React 18 + Vite + TanStack Query + Vitest for the web page; pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-10-09-sp2-core-trade-lifecycle-design.md` (§1 done-when, §3 entry source and
tenant scoping, §4.1 blocks, §5.1/§5.3/§5.4, §8 journal, summaries and reconciliation, §8.4 UI, §9 errors, §10 tests,
§11 M5 row); parent `docs/superpowers/specs/2026-09-30-ai-trading-core-architecture-design.md` §7.1, §8.1; SP3
`docs/superpowers/specs/2026-10-11-sp3-ai-decision-layer-design.md` §5 (corpus) and §9 (guard rails, later). Prior
plans: `2026-10-09-sp2-m1-strategy-catalogue.md`, `2026-10-10-sp2-m2-risk-wall.md`, `2026-10-11-sp2-m3-execution.md`,
`2026-10-12-sp2-m4-lifecycle.md` (format, conventions, and the notes this plan implements).

**Branch:** integration branch `feature/sp2-m5` (worktree `.claude/worktrees/sp2-m5`) from
`release/auto-exit-sentinel-inputs` at `053da3a` (SP2 M4 + sentinel auto-exit merged) **plus P1**. Stream worktrees:
see "Parallel streams".

**Test commands:** API Jest runs from `apps/api` (`rootDir` is `src`, `testRegex` `.*\.spec\.ts$`):
`cd apps/api && npx jest <path-or-pattern>`. The opt-in database test has its own config under `apps/api/test/sp2-m5/`.
Web: `cd apps/web && npx vitest run <path>`.

## Global Constraints

- **Safety first, paper only:** the only adapter is M3's `PaperExecutionAdapter`; `LIVE_TRADING_ENABLED` stays `false`
  and is neither read nor written; `openPosition` still refuses a non-`PAPER` version.
- **Entries behind a default-off switch:** `CORE_ENTRIES_MODE` defaults to `off`; an unknown value is `off`; an empty
  `CORE_ENTRY_USER_IDS` admits nobody. Nothing else in M5 is behind a flag: journaling, summaries, reconciliation and
  the latch protect positions that exist and must always run.
- **Entries fail closed:** any input the intake cannot compute (no price source, no fresh price, paper settings
  missing, unknown gate evaluator, a closed trade with no summary yet, a journal that cannot record the verdict) skips
  the entry with a journaled reason. **Exits are never blocked**: no M5 code path cancels or delays an exit order, and a
  journal or summary failure never reaches a lifecycle decision.
- **Kill switch and daily loss:** unchanged priority-1/2 behaviour from M4; M5 adds the persisted latch (O13) and
  journals every kill-switch change (`KILL_SWITCH`) and limit change (`LIMIT_CHANGED`).
- **No hard-coded money or risk values (SP2 D4):** values come from version blocks, the verdict's limits snapshot, live
  limits or `core_paper_defaults`. New literals are cadences and load bounds only: `RECON_INTERVAL_MS = 300_000` (spec
  §8.3), `ENTRY_PRICE_WAIT_MS = 5_000`, `ENTRY_PRICE_POLL_MS = 250`, `ENTRY_WATCH_TTL_MS = 60_000`,
  `ATR_LOOKBACK_DAYS = 3` (the silo's), `DAILY_ATR_LOOKBACK_DAYS = 60`, `INTAKE_MAX_PENDING = 200`,
  `JOURNAL_BUFFER_MAX = 1_000`, `JOURNAL_RETRY_MS = 5_000`, `STOP_MOVED_COALESCE_MS = 30_000`,
  `FOLLOWUP_MAX_INSTRUMENTS = 300`.
- **`@Cron` must set `timeZone: 'Asia/Kolkata'`** (the `common/schedule/cron-timezone.spec.ts` ratchet stays green and
  untouched). M5 adds exactly two: `core-recon-nightly` at `0 45 15 * * 1-5` and `core-skip-followup` at
  `0 10 16 * * 1-5`, both through `JobRunnerService` (leased, recorded). The 5-minute reconciliation is a
  `setInterval` gated by `bootJobsEnabled()`, like M3's matcher and M4's sweep.
- **Migrations are expand-only and auto-applied** (`grw-deploy.timer` runs `prisma migrate deploy`): two new tables,
  their indexes, CHECKs, FKs and `BEFORE UPDATE` append-only triggers reusing M3's `core_append_only_guard()`. No
  `DROP`, no redefined function, no change to an existing table or CHECK. Reverting the code leaves them inert.
- **Approach A:** no old silo table or service changes, except the single fire-and-forget call at the end of
  `ChartinkProcessService.processOne` (and one import). Outside `apps/api/src/modules/trade-core/` only these change:
  `prisma/schema.prisma` + the M5 migration, `common/tenant/tenant.constants.ts` (two models),
  `common/audit/audit-actions.ts` (one `journal` group), `modules/chartink/services/chartink-process.service.ts` (one
  call), `modules/health/health-detail.service.ts` (`EXPECTED_JOBS`) + a new `expected-jobs.spec.ts`, and the web app (one page, one
  service, the route, the nav item).
- **Per-user scoping:** every `core_journal` and `core_trade_summaries` row carries `userId` and every per-user read
  names the caller's userId (never a body). The only cross-user reads are system scans that then act per user:
  `CoreStrategySelectionRepository.listEnabledPaper()` (intake), `CorePositionRepository.listUserIdsSince()`
  (reconciler), `CoreJournalRepository.listTypeOnDay()` (follow-ups); they lift tenant scoping with M4's
  `withoutTenant` pattern where the repository has it. `CoreJournal` and `CoreTradeSummary` join `TENANT_MODELS`.
- **Money:** ledger-derived money is `Prisma.Decimal`, summed exactly, stored `DECIMAL(14,2)` and exchanged as 2-dp
  strings (M3 convention); prices `DECIMAL(14,4)`.
- **Load (1 vCPU / 2 GB VPS, ~30 feed slots, 350 ms historical pacing):** at most one transient entry watch at a time
  (the intake is a single sequential queue), the historical lane only through the hub candle store, journal writes
  batched and the trailing `STOP_MOVED` rows coalesced. See "Load on the production VPS".
- **Commits:** conventional commits with explicit pathspecs only (`git commit -m … -- <paths>`), never `git add -A`,
  `git commit -a`, a bare commit or `git stash` (other agents share the tree; `node_modules` are junctions — never
  delete them); every message ends with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. No
  merge, push or SSH from a stream.
- **Typecheck:** new code adds no `tsc` error; compare sorted error lists with the base (Task 20), not counts.

## Review Focus

1. **A core failure never changes the silo's handling of the same alert.** A throwing or full intake, or no intake at
   all, leaves every silo call in `processOne` identical. (Task 8 test "a throwing core intake changes nothing in the
   silo path"; Task 7 test "a full backlog drops the hit and never throws".)
2. **The same Chartink hit processed twice (a Bull retry, or two scans firing for one stock) opens one position and
   journals one `ALERT_RECEIVED`.** The intent id is a hash of (user, strategy, alert, token); the intake returns
   `DUPLICATE` when a position already carries that intent; every writer is idempotent by `dedupeKey`. (Task 7 test
   "the same hit twice opens one position and journals once".)
3. **The journal database is down.** Entries fail closed (`JOURNAL_UNAVAILABLE` from the wall), exits and lifecycle
   decisions continue, lifecycle rows wait in a bounded buffer and are retried in order, and a drop is counted and
   shown in `/journal/status`. (Task 9 tests "a failed batch stays queued and is retried in order once the store is back", "a full
   buffer drops further rows and counts them", "a verdict that cannot be recorded throws to the wall".)
4. **A position closes while its summary cannot be written.** The `lastLoss` filter then says `HISTORY_UNKNOWN` (skip),
   never "no loss"; the 5-minute reconciliation repairs the summary and only a failed repair becomes a
   `RECON_MISMATCH`. (Task 11 test "a closed trade without a summary is UNKNOWN and is repaired on read"; Task 16 test
   "a missing summary is repaired, not flagged".)
5. **A mismatch found on every 5-minute run is journaled once a day, and blocks until acknowledged.** After the ack the
   same finding the next day blocks again; a finding on another strategy does not block this one. (Task 16 tests
   "the same finding twice in a day is one row", "an ack lifts the block", "a strategy finding blocks only that
   strategy; a user-wide finding blocks all".)

## Planner rulings (where the code shaped the design)

- **J1 Two new parts, `journal/` and `intake/`.** Spec §3 names `journal/`; the entry fan-out has no part in §3, so it
  gets its own (`intake/`) rather than living in `strategies/` or `lifecycle/`.
- **J2 Fan-out through a registry, at the end of `processOne` (O3).** `handOffChartinkHit` is synchronous, never
  throws and never awaits; `CoreEntryIntake.accept` queues. ChartinkModule imports nothing new (TradeCoreModule is not
  imported by it, so no module cycle), and the silo specs stay untouched.
- **J3 Chartink alerts are platform-wide; selections are per user.** The intake scans enabled selections whose version
  is `PAPER` (M1 note: "live only when enabled AND PAPER") and acts per selection, for users in `CORE_ENTRY_USER_IDS`.
- **J4 Deterministic intent ids.** `intentIdFor(userId, strategyId, alertId, token)` = `ci_` + 32 hex of SHA-256. With
  `core_positions.intentId` unique and every journal `dedupeKey`, a re-processed hit is a no-op (Review Focus 2).
- **J5 Order of the intake checks (cheap first):** entry match (scan, side, vehicle, `minScore` at processing time —
  M1 semantics: a window's score replaces `base`) → cooldown (this strategy's last **opened** position on the token) →
  same-day last loss (its last closed trade's **summary** net P&L ≤ 0) → fresh price (hub, wait ≤ 5 s) → stale entry
  (move past the alert price **in the trade direction**) → gates → paper settings → ATR → re-read price → sizing → Risk
  Wall → (`journal` mode stops here) → `openPosition`.
- **J6 Prices come from the hub only** (`hubFor(userId, 'positions')`, the same source the matcher and the lifecycle
  use). The intake watches the ref at priority 1 under `core-intake:<intentId>` with a 60 s TTL and unwatches it when
  the attempt ends; the position's own P0 watch (M4) takes over. A user the hub does not serve is `NO_PRICE_SOURCE`.
- **J7 Candles come from the hub candle store only** (`HUB_CANDLE_SOURCE`, through `CoreCandles`), never from the
  legacy `getHistoricalData` lane: one cache, one pacing gate. Off or failing → `unavailable` (O6/O7 decide the effect).
- **J8 Sizing:** `riskRupees` → `floor(amount ÷ |ref − stop|)` units; `notionalRupees` → `floor(amount ÷ ref)`; whole
  lots (cash/MTF lot = 1); 0 → `SIZE_ZERO`. The Risk Wall may only reduce it. `capitalPerUnit` is M3's `marginFor`;
  `mtfLeverage` = ref ÷ capitalPerUnit.
- **J9 `journal` mode runs the Risk Wall** (its `RISK_VERDICT` row is real and useful for the gate) and stops before
  `openPosition`, journaling `INTENT_SKIPPED ENTRIES_DRY_RUN` with the would-be quantity. No corpus row in `journal`
  mode.
- **J10 Journal writes:** `record()` (best effort, ordered, batched, bounded buffer, retried every 5 s, drops counted)
  for lifecycle, order, skip and alert rows; `recordNow()` (awaited, throws) where the caller must know: the Risk Wall
  verdict (so an unrecordable verdict rejects the entry — M2 already maps a sink failure to `JOURNAL_UNAVAILABLE`),
  the daily-loss latch, reconciliation findings and acks, and follow-ups.
- **J11 Idempotent writers by `dedupeKey`** (unique, `ON CONFLICT DO NOTHING`): `alert:<intentId>`, `skip:<intentId>`,
  `order:<id>:placed`, `order:<id>:<state>:<filledQty>`, `fill:<fillId>`, `latch:<userId>:<day>`,
  `recon:<day>:<fingerprint>`, `ack:<mismatchId>`, `followup:<skipRowId>`. Restarts and replays never duplicate.
- **J12 `RECON_ACK` is a journal type** (spec §8.3 says "until the owner acknowledges"; acknowledging needs a durable,
  append-only record). Blocked = an unacked `RECON_MISMATCH` (any day); the block is a new Risk Wall reason
  `RECON_BLOCKED` fed through `RiskLiveState.reconBlocked` (M2 note: "one more input to RiskContext").
- **J13 `DAILY_LOSS_LATCHED` is a journal type** (M2/M4 notes: "derive `dailyLossLatched` from the journal"). Written by
  `DailyLossMonitor` on any `BREACHED` decision and by the verdict sink on a `DAILY_LOSS` rejection; read by
  `CoreRiskStateProvider` for the IST day (O13). The 2026-10-12 ruling's realised-only `BREACHED` latches too.
- **J14 `PRICE_FOLLOWUP` rows instead of updating skipped rows** (spec §8.1 says "fills priceAfter30m and
  priceAfterClose"; the journal is append-only, so the follow-up is its own row keyed to the skip row).
- **J15 Trailing `STOP_MOVED` rows are coalesced** to at most one per position per 30 s (the newest held move is
  written before any other event of that position, so the journal never shows a stale order of events). Guard-rail
  stop moves (`why: 'GUARD_RAIL'`) are never coalesced. The live stop is always on `core_positions.stopPrice`.
- **J16 Summaries:** written when the lifecycle sink sees `POSITION_STATE → CLOSED` (through the `CORE_POSITION_CLOSED`
  port), repaired by the reconciler, and on demand by the `lastLoss` reader. Gross = Σ `REALISED_PNL` of the
  position's orders; charges = −Σ `CHARGES`; MTF interest = −Σ `MTF_INTEREST` on the token for interest days in
  [open day, close day]; net = gross − charges − interest; R = net ÷ (|entry − initial stop| × qty); MFE/MAE from M4's
  `highWater`/`lowWater` (prices the lifecycle saw), stored as price and rupees. `CANCELLED` positions get none.
- **J17 Reconciliation (spec §8.3) as pure checks over a per-user snapshot:** intraday — fills sum to each order's
  `filledQty`, the position row matches `reducePosition(orders)` (only when the newest order is older than the stuck
  threshold, so a fill the lifecycle has not re-read yet is not flagged), stuck `NEW|OPEN` orders (an **entry** is
  cancelled; an **exit is never cancelled**, only flagged), stuck `EXITING`, missing summaries (repaired); nightly adds
  intraday positions still open after square-off, MTF holdings with no interest row today, and margin left on the
  orders of closed or cancelled positions. Spec §8.3's "cash ledger balance equals the sum of its entries" has no
  stored balance to compare in M3 (drift D3); the margin check is its substantive form.
- **J18 Stuck threshold = 2 × `noPriceRejectMs`** (O10): M3 rejects a market order with no price after
  `noPriceRejectMs`, so anything open for twice that is a stuck matcher. Missing paper settings → `2 × PRICE_MAX_AGE_MS`
  (stricter).
- **J19 Ledger reads bounded (M4 note):** `dayStats` and `netPnlTodayByPosition` read only today's rows
  (`createdAt ≥ IST midnight`), and `funds` reads two SQL aggregates (sums by type; held margin by vehicle) instead of
  the user's whole ledger. The in-memory store computes the same with M3's own `balances`/`heldMargin`, and the
  opt-in DB test proves the SQL equals the full-history computation.
- **J20 Corpus (O9):** `ENTRY_SETUP` upserted first-write-wins; `outcome` merged with `jsonb ||` so the close and the
  follow-ups add keys without overwriting each other. A corpus failure is logged and never affects a trade.
- **J21 Comparison view (spec §8.4):** admin-only; for each of the caller's `ALERT_RECEIVED` rows of a day (the core
  setups), the core outcome (summary, open position, or skip reason) beside the silo's row for the same
  (alertId, token) — Adaptive-Stop ↔ `adaptive_stop_watch_entries`/`adaptive_stop_trades`, Ungated ↔
  `ungated_watch_entries`/`ungated_trades`. Read-only; the silo tables are not tenant-scoped (platform-wide).
- **J22 Health without touching the health module's DI:** `GET /api/trade-core/journal/status` reports entries mode,
  intake backlog and drops, journal buffer and drops, active / blind / exiting positions and unacked mismatches.
  Outside `trade-core/`, only `EXPECTED_JOBS` gains the three core jobs (M3 note for `core-mtf-interest`).
- **J23 Optional constructor parameters for the M2/M4 services M5 extends** (`CoreKillSwitchService`,
  `CoreRiskLimitService`, `DailyLossMonitor`, `CoreRiskStateProvider`): each new dependency is the last parameter,
  `@Optional()`, so every existing spec constructs them unchanged and an absent journal means M4 behaviour.
- **J24 The intake runs in the Chartink Bull worker** (no request, no CLS tenant context); its system scan of
  selections is therefore unscoped, and every per-user call after it names the selection's userId.

## Spec-vs-code drift found (and how this plan handles it)

| # | Spec says | Code is | This plan |
|---|---|---|---|
| D1 | §8.1 a nightly job "fills" `priceAfter30m`/`priceAfterClose` on skipped rows | `core_journal` is append-only (§8.1 itself) | `PRICE_FOLLOWUP` rows (J14) |
| D2 | §8.1 type list | No type for an acknowledgement or the latch | `RECON_ACK`, `DAILY_LOSS_LATCHED`, `PRICE_FOLLOWUP` added (J12–J14) |
| D3 | §8.3 "the cash ledger balance equals the sum of its entries" | M3 stores no balance; `funds` is computed from the entries | Margin-left-on-closed check (J17) |
| D4 | §3 the alert is handed to the core "after the existing silo handling" | `processOne` has early returns before scoring, and the core needs the score | Hook at the end of `processOne`, scored hits only (O3, J2) |
| D5 | §3 "the core acts only for StrategyVersions the user has selected" | Chartink alerts carry no userId (`chartink_alerts` is platform-wide) | Fan-out over enabled `PAPER` selections, allow-listed users (J3) |
| D6 | §5.3 "rejected for the rest of the session" | `dailyLossLatched` is hard `false` in `CoreRiskStateProvider` | Journal-derived latch (J13, O13) |
| D7 | §7.2 / M4 D7: per-user `hubFor` | The hub serves only `HUB_OWNER_USER_ID` | Other users' intents are `NO_PRICE_SOURCE` (fail closed) |
| D8 | §8.3 "every 5 minutes … any order NEW/OPEN for longer than N minutes is cancelled" | Cancelling an exit order would undo a square-off (M4 D4) | Entries cancelled, exits flagged only (J17) |
| D9 | §4.1 seed gate `adaptive-stop-decision-gate` with `failOpen: true` | M1 left evaluator keys shape-checked only | Registry with one evaluator wrapping the silo's pure `evaluateDecisionGate`; unknown key → `GATE_UNKNOWN` (O6) |
| D10 | §8.4 "Risk page" and "Strategy page" are M5 UI | Both exist (M1, M2) | M5 adds only the Journal page with the comparison view |
| D11 | M3 note: `core-mtf-interest` in `EXPECTED_JOBS` | Never added | Added with the two M5 jobs (Task 19) |
| D12 | M2 note: "M5 journals `LIMIT_CHANGED` and `KILL_SWITCH` from the audit events" | Audit is a separate hash-chained log with no subscription | The two services write the journal row directly after persisting (J23) |
| D13 | M4 note: "the summary reads a CLOSED position's fills" | Realised P&L, charges and interest live in the ledger, per order | Summary from the ledger rows of the position's orders (J16) |
| D14 | Spec §11 M5 row has no options picker; M4 D10 says "the opener (M5) passes a resolved contract" | No picker exists | Deferred (O4) |
| D15 | `fix/daily-loss-realised-breach` (owner ruling 2026-10-12) | Not in this base | Precondition P1 |

## Load on the production VPS (1 vCPU / 2 GB, ~30 feed slots, 350 ms historical pacing)

- **Feed slots:** at most **one** transient P1 watch (the intake handles one selection of one hit at a time; TTL 60 s,
  unwatched at the end of the attempt) plus M4's one P0 per open position, bounded by `maxOpenPositions` (seeded 5).
  Worst case 6 of ~30 slots, shared refs counted once. `/healthz/detail → hub.slots` is checked in the gate.
- **Historical lane:** only through the hub candle store, and only for hits that pass the cheap filters. Per such
  intent: one 15m read over 5 days (gate) and one 5m read over 3 days (ATR); both derive from the stored 1m series, so a
  cold symbol costs about one broker call and a warm one none. At the silo's historical rate of Adaptive-Stop setups
  (tens a day) that is well under 100 calls ≈ under 40 s of lane time a day. Follow-ups: ≤ 300 instruments × one 1m read
  after the close (16:10), when no exchange competes. With `HUB_SERVES_CHARTS` off, the lane is not used at all.
- **Intake queue:** sequential; each attempt waits ≤ 5 s for a price plus candle reads. A burst of 50 hits × 2
  strategies is ~100 attempts; most stop at the entry match (no I/O). The queue is capped at 200 hits; a full queue
  drops (counted, logged), never blocks Chartink.
- **DB:** per traded position ~30–40 journal rows (alert, verdict, order states, fills, transitions, exits) plus
  coalesced trailing moves (≤ 2 per minute while trailing); per skipped setup 2–3 rows; summaries 1 per trade. A busy
  paper day ≈ 1,000–3,000 rows ≈ 1–2 MB; ~0.5 GB a year at worst. Retention is the interim storage decision (revisit
  with the other retention rules). Reconciliation: every 5 min, per user with core activity today, ~4 small reads per
  position. Ledger reads per wall check and per 5 s daily-loss check become day-bounded or aggregated (J19).
- **CPU/RAM:** pure checks over tens of rows; buffers bounded (journal 1,000 rows, intake 200 hits). Idle cost with
  entries `off`: one 5-minute timer and two nightly crons.

## Parallel streams (worktrees)

| Stream | Tasks | Worktree / branch | Depends on | Files it owns |
|---|---|---|---|---|
| **A — foundation** | 1, 2, 3 | `.claude/worktrees/sp2-m5-foundation` / `feature/sp2-m5-foundation` | base (P1 not needed) | `prisma/*`, `test/sp2-m5/*`, `tenant.constants.ts`, `audit-actions.ts`, `journal/testing/fake-journal.ts`, `journal/journal.types.ts`, `journal/journal-ports.ts`, `journal/repositories/*`, `journal/testing/memory-journal-store.ts`, `journal/journal-migration.spec.ts`, `market/core-candles.ts`, the `lifecycle/repositories/core-position.repository.ts` + memory-store additions, `execution/*` read additions, `strategies/repositories/core-strategy-selection.repository.ts` addition |
| join A | — | `feature/sp2-m5` | A | merge A (then every stream branches from here) |
| **B — intake** | 4, 5, 6, 7, 8 | `.claude/worktrees/sp2-m5-intake` | join A | `intake/*`, `chartink/services/chartink-process.service.ts` (one call), `chartink/services/__tests__/chartink-core-handoff.spec.ts` |
| **C — journal writers** | 9, 10 | `.claude/worktrees/sp2-m5-writers` | join A | `journal/core-journal.service.ts`, `journal/journal-sinks.ts`, `journal/order-journaler.ts` + specs, the two M2 services' journal hook and their specs |
| **D — outcomes** | 11, 12, 13 | `.claude/worktrees/sp2-m5-outcomes` | join A | `journal/trade-summary.ts`, `journal/core-trade-summary.service.ts`, `journal/core-corpus.writer.ts`, `journal/skip-followup.cron.ts` + specs |
| **E — risk & recon** | 14, 15, 16 | `.claude/worktrees/sp2-m5-recon` | join A + **P1** | `lifecycle/daily-loss.monitor.ts`, `lifecycle/core-risk-state.provider.ts`, `risk-wall/risk-wall.ts`, `risk-wall/risk-wall.types.ts`, `journal/journal-risk-reads.ts`, `journal/recon-checks.ts`, `journal/core-reconciler.service.ts` + specs |
| **F — surfaces** | 17, 18 | `.claude/worktrees/sp2-m5-surfaces` | join A (codes against the interfaces below with fakes) | `journal/controllers/*`, `journal/dto/*`, `journal/daily-summary.ts`, `journal/silo-comparison.reader.ts`, `apps/web/*` |
| **G — wiring + proof** | 19, 20 | `feature/sp2-m5` | B + C + D + E + F | `trade-core.module.ts` (+spec), `health-detail.service.ts` + `health/expected-jobs.spec.ts`, `lifecycle/testing/lifecycle-harness.ts` (one option), `journal/testing/m5-harness.ts`, e2e specs, this plan's ledger |

B, C, D, E and F share no file. Each codes against the ports Task 1 defines (`CORE_JOURNAL`, `CORE_POSITION_CLOSED`,
`CORE_TRADE_HISTORY`, `CORE_CORPUS`) and the classes Task 2/3 add, with in-memory fakes; the real bindings meet in
Task 19. Interfaces a stream consumes from a sibling stream (F consumes `CoreReconciler.ack/status`,
`CoreEntryIntake.status`, `CoreJournalService.status`) are fixed in those tasks' **Interfaces** blocks and F uses
structural fakes. Suggested order: A → (B ∥ C ∥ D ∥ E ∥ F) → G. Critical path: A (3 tasks) → B (5 tasks) → G (2).
Each stream commits with explicit pathspecs on its own branch; the controller merges.

## File Structure

| Path | Responsibility |
|---|---|
| Modify `prisma/schema.prisma` | `CoreJournal`, `CoreTradeSummary`; `User` and `CorePosition` back-relations |
| Create `prisma/migrations/20261013120000_sp2_m5_journal/migration.sql` | Two tables, CHECKs, indexes, FKs, append-only triggers |
| Modify `apps/api/src/common/tenant/tenant.constants.ts` | `'CoreJournal'`, `'CoreTradeSummary'` |
| Create `apps/api/test/sp2-m5/jest.config.js`, `apps/api/test/sp2-m5/journal.int.spec.ts` | Opt-in real-database test |
| Create `trade-core/journal/journal.types.ts` | Journal vocabulary, entry/row types, `TradeSummary`, corpus outcome |
| Create `trade-core/journal/journal-ports.ts` | `CORE_JOURNAL`, `CORE_POSITION_CLOSED`, `CORE_TRADE_HISTORY`, `CORE_CORPUS` |
| Create `trade-core/journal/journal-migration.spec.ts` | The migration mirrors the vocabularies; expand-only |
| Create `trade-core/journal/repositories/core-journal.repository.ts` (+spec) | Append (dedupe), per-user reads, system scan |
| Create `trade-core/journal/repositories/core-trade-summary.repository.ts` (+spec) | Create-if-absent, reads |
| Create `trade-core/journal/testing/memory-journal-store.ts` (+spec), `journal/testing/fake-journal.ts` | In-memory twins of both repositories (with `port()`); the `CoreJournalPort` fake |
| Create `trade-core/market/core-candles.ts` (+spec) | Hub candle store reads, `unavailable` instead of throws |
| Modify `trade-core/lifecycle/repositories/core-position.repository.ts`, `lifecycle/testing/memory-position-store.ts` | `lastOpenedAt`, `listClosedSince`, `listUserIdsSince` |
| Modify `trade-core/strategies/repositories/core-strategy-selection.repository.ts` | `listEnabledPaper()` (system scan) |
| Modify `trade-core/execution/ledger-math.ts`, `execution/repositories/core-cash-ledger.repository.ts`, `execution/repositories/core-order.repository.ts`, `execution/paper-ledger.service.ts`, `execution/testing/memory-paper-store.ts` | Day-bounded and aggregate reads; per-position ledger rows, fills, margin, interest tokens |
| Create `trade-core/execution/paper-ledger.reads.spec.ts` | Parity of the bounded reads with the full-history ones |
| Create `trade-core/intake/alert-handoff.ts` (+spec) | `ChartinkHit`, the registry, `handOffChartinkHit` |
| Create `trade-core/intake/entry-rules.ts` (+spec) | `matchEntry`, filters, sizing, stop price, intent id (pure) |
| Create `trade-core/intake/gate-evaluators.ts` (+spec) | The gate registry and `runGates` |
| Create `trade-core/intake/entry-market.ts` (+spec) | `EntryMarket` (hub price wait, ATR, gate candles), `atrFrom` |
| Create `trade-core/intake/entry-config.ts` (+spec) | `readEntryConfig` |
| Create `trade-core/intake/core-entry-intake.service.ts` (+spec) | The queue and the per-selection pipeline |
| Create `trade-core/intake/testing/intake-fixtures.ts` | Hits, the seeded Adaptive-Stop blocks, fakes |
| Modify `modules/chartink/services/chartink-process.service.ts` | One `handOffChartinkHit` call at the end of `processOne` |
| Create `modules/chartink/services/__tests__/chartink-core-handoff.spec.ts` | The hand-off happens and never affects the silo |
| Create `trade-core/journal/core-journal.service.ts` (+spec) | `CoreJournalService` (buffer, retry, `recordNow`, status) |
| Create `trade-core/journal/journal-sinks.ts` (+spec) | `JournalLifecycleSink`, `JournalRiskVerdictSink` |
| Create `trade-core/journal/order-journaler.ts` (+spec) | `ORDER_PLACED`, `ORDER_STATE`, `FILL` rows |
| Modify `trade-core/risk-wall/services/core-kill-switch.service.ts`, `core-risk-limit.service.ts` (+ their existing specs) | `KILL_SWITCH`, `LIMIT_CHANGED` rows |
| Modify `apps/api/src/common/audit/audit-actions.ts` | `journal: { CORE_RECON_ACKNOWLEDGED }` |
| Create `trade-core/journal/trade-summary.ts` (+spec) | `summarizeTrade` (pure) |
| Create `trade-core/journal/core-trade-summary.service.ts` (+spec) | `writeFor`, `positionClosed`, `CoreTradeHistory` |
| Create `trade-core/journal/core-corpus.writer.ts` (+spec) | `ai_decision_records` writer |
| Create `trade-core/journal/skip-followup.cron.ts` (+spec) | `priceAt`, the 16:10 follow-up job |
| Create `trade-core/journal/journal-risk-reads.ts` (+spec) | `latched`, `reconBlock` for the risk provider |
| Modify `trade-core/lifecycle/daily-loss.monitor.ts` (+spec), `lifecycle/core-risk-state.provider.ts` (+spec) | The latch |
| Create `trade-core/journal/recon-checks.ts` (+spec) | Reconciliation checks and `reconBlockOf` (pure) |
| Create `trade-core/journal/core-reconciler.service.ts` (+spec) | 5-minute and nightly runs, repairs, findings, ack |
| Modify `trade-core/risk-wall/risk-wall.types.ts`, `risk-wall/risk-wall.ts` (+ `risk-wall.spec.ts`) | `RECON_BLOCKED` |
| Create `trade-core/journal/daily-summary.ts` (+spec) | Daily summary numbers (pure) |
| Create `trade-core/journal/silo-comparison.reader.ts` (+spec) | Core vs silo rows for a day |
| Create `trade-core/journal/controllers/core-journal.controller.ts` (+spec), `journal/dto/core-journal.dto.ts` | Day, position timeline, status, ack, comparison |
| Create `apps/web/src/services/coreJournal.ts` (+spec) | Wire client |
| Create `apps/web/src/pages/core-journal/core-journal.ts` (+spec), `CoreJournalPage.tsx` | Page logic and page |
| Modify `apps/web/src/App.tsx`, `apps/web/src/components/layout/navItems.ts` | Route and nav item |
| Modify `trade-core/trade-core.module.ts`, `trade-core.module.spec.ts` | Wiring and rebinding |
| Modify `modules/health/health-detail.service.ts`; create `modules/health/expected-jobs.spec.ts` | `EXPECTED_JOBS` |
| Modify `trade-core/lifecycle/testing/lifecycle-harness.ts` (a `teeSink` option); create `trade-core/journal/testing/m5-harness.ts`, `trade-core/journal/m5-e2e.spec.ts`, `trade-core/journal/m5-tenant.spec.ts` | End to end |

---

## Stream A — foundation

### Task 1: The two tables, the journal vocabulary and the ports

**Files:**
- Modify: `prisma/schema.prisma` (new models after `CorePosition`; back-relations on `User` beside `corePositions`, line ~1529, and on `CorePosition`)
- Create: `prisma/migrations/20261013120000_sp2_m5_journal/migration.sql`
- Modify: `apps/api/src/common/tenant/tenant.constants.ts` (after `'CorePosition'`)
- Modify: `apps/api/src/common/audit/audit-actions.ts` (one `journal` group, used by Task 16)
- Create: `apps/api/src/modules/trade-core/journal/journal.types.ts`
- Create: `apps/api/src/modules/trade-core/journal/journal-ports.ts`
- Test: `apps/api/src/modules/trade-core/journal/journal-migration.spec.ts`
- Create: `apps/api/test/sp2-m5/jest.config.js`, `apps/api/test/sp2-m5/journal.int.spec.ts`

**Interfaces:**
- Consumes: `EXIT_REASONS`, `ExitReason` (`lifecycle/lifecycle.types.ts`); `Vehicle`.
- Produces: `JOURNAL_TYPES`, `JournalType`, `SKIP_REASONS`, `SkipReason`, `JournalEntry`, `JournalRow`, `TradeSummary`,
  `NewTradeSummary`, `CorpusOutcome`, `CorpusSetup`; tokens `CORE_JOURNAL`, `CORE_POSITION_CLOSED`, `CORE_TRADE_HISTORY`,
  `CORE_CORPUS`; interfaces `CoreJournalPort { record(e): void; recordNow(e): Promise<void> }`,
  `PositionClosedListener { positionClosed(userId, positionId): Promise<void> }`,
  `CoreTradeHistory { intentSeen(intentId); lastOpenedAt(userId, strategyId, token); lastClosedNetToday(userId, strategyId, token, now) }`,
  `CoreCorpusPort { entrySetup(s): Promise<void>; outcome(intentId, patch, at): Promise<void> }`; `NoopCorpus`;
  `CORE_RECON_DESK` + `ReconDesk { ack(userId, mismatchId, reason); unacked(userId) }`, `CORE_INTAKE_STATUS` + `IntakeStatusSource`,
  `CORE_JOURNAL_STATUS` + `JournalStatusSource` (the journal API reads Streams B/C/E through these).

- [ ] **Step 1: Write the failing migration spec**

```ts
// apps/api/src/modules/trade-core/journal/journal-migration.spec.ts
import { readFileSync } from 'fs';
import { join } from 'path';
import { EXIT_REASONS } from '../lifecycle/lifecycle.types';
import { JOURNAL_TYPES } from './journal.types';

/** The M5 migration: expand-only, two append-only tables whose CHECKs mirror the code's vocabularies. */
const ROOT = join(__dirname, '..', '..', '..', '..', '..', '..');
const sql = readFileSync(join(ROOT, 'prisma', 'migrations', '20261013120000_sp2_m5_journal', 'migration.sql'), 'utf8');
const listAfter = (marker: string): string[] => {
  const start = sql.indexOf(marker);
  return [...sql.slice(start, sql.indexOf(')', start + marker.length)).matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
};

describe('M5 migration', () => {
  it('the journal type CHECK lists JOURNAL_TYPES exactly, in order', () => {
    expect(listAfter('"type" IN (')).toEqual([...JOURNAL_TYPES]);
  });

  it('the summary exit-reason CHECK lists EXIT_REASONS exactly', () => {
    expect(listAfter('"exitReason" IN (')).toEqual([...EXIT_REASONS]);
  });

  it('both tables are append-only through the M2 guard, which this migration does not redefine', () => {
    expect(sql).toContain('CREATE TRIGGER "core_journal_append_only"\n    BEFORE UPDATE ON "core_journal"');
    expect(sql).toContain('CREATE TRIGGER "core_trade_summaries_append_only"\n    BEFORE UPDATE ON "core_trade_summaries"');
    expect(sql.match(/EXECUTE FUNCTION core_append_only_guard\(\)/g)).toHaveLength(2);
  });

  it('is expand-only: drops nothing, redefines no function, alters no existing table', () => {
    expect(sql).not.toMatch(/DROP |CREATE OR REPLACE FUNCTION|ALTER TABLE "core_(positions|orders|fills|cash_ledger|paper_defaults|risk_limits|kill_switch)"/);
  });

  it('a dedupe key and a position summary are unique (idempotent writers rely on it)', () => {
    expect(sql).toContain('CREATE UNIQUE INDEX "core_journal_dedupeKey_key" ON "core_journal"("dedupeKey");');
    expect(sql).toContain('CREATE UNIQUE INDEX "core_trade_summaries_positionId_key" ON "core_trade_summaries"("positionId");');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx jest src/modules/trade-core/journal/journal-migration.spec.ts`
Expected: FAIL — `Cannot find module './journal.types'` (and the migration file does not exist).

- [ ] **Step 3: Write the types and ports**

```ts
// apps/api/src/modules/trade-core/journal/journal.types.ts
import type { ExitReason } from '../lifecycle/lifecycle.types';
import type { Vehicle } from '../strategies/blocks/block-types';

/**
 * Spec §8.1 journal types, plus three M5 rulings: RECON_ACK (J12), DAILY_LOSS_LATCHED (J13),
 * PRICE_FOLLOWUP (J14). The migration's CHECK mirrors this list (journal-migration.spec.ts).
 */
export const JOURNAL_TYPES = [
  'ALERT_RECEIVED',
  'INTENT_SKIPPED',
  'RISK_VERDICT',
  'ORDER_PLACED',
  'ORDER_STATE',
  'FILL',
  'STOP_MOVED',
  'EXIT_DECIDED',
  'POSITION_STATE',
  'BLIND',
  'RECOVERY_STOP',
  'KILL_SWITCH',
  'LIMIT_CHANGED',
  'RECON_MISMATCH',
  'RECON_ACK',
  'DAILY_LOSS_LATCHED',
  'PRICE_FOLLOWUP',
] as const;
export type JournalType = (typeof JOURNAL_TYPES)[number];

/** Why an intent did not become an order (INTENT_SKIPPED payload.reason). */
export const SKIP_REASONS = [
  'MIN_SCORE',
  'COOLDOWN',
  'LAST_LOSS',
  'HISTORY_UNKNOWN',
  'NO_PRICE_SOURCE',
  'NO_FRESH_PRICE',
  'STALE_ENTRY',
  'GATE',
  'GATE_UNKNOWN',
  'PAPER_SETTINGS_MISSING',
  'SIZE_ZERO',
  'VEHICLE_UNSUPPORTED',
  'RISK_REJECT',
  'OPEN_REFUSED',
  'ENTRIES_DRY_RUN',
  'INTERNAL_ERROR',
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

/** What a writer hands the journal. `at` is the event time (it also decides the IST day). */
export interface JournalEntry {
  userId: string;
  type: JournalType;
  at: Date;
  positionId?: string | null;
  strategyId?: string | null;
  strategyVersionId?: string | null;
  intentId?: string | null;
  symbol?: string | null;
  /** JSON-serialisable. */
  payload: Record<string, unknown>;
  priceUsed?: number | null;
  priceAgeMs?: number | null;
  /** Unique when set: a second write with the same key is skipped (J11). */
  dedupeKey?: string | null;
}

export interface JournalRow {
  id: string;
  userId: string;
  type: JournalType;
  positionId: string | null;
  strategyId: string | null;
  strategyVersionId: string | null;
  intentId: string | null;
  symbol: string | null;
  payload: Record<string, unknown>;
  priceUsed: number | null;
  priceAgeMs: number | null;
  dedupeKey: string | null;
  /** IST date, YYYY-MM-DD. */
  istDay: string;
  createdAt: Date;
}

/** Spec §8.2. Money is a 2-dp string (M3 convention), prices 4 dp; null where it cannot be computed. */
export interface TradeSummary {
  id: string;
  userId: string;
  positionId: string;
  intentId: string;
  strategyId: string;
  strategyVersionId: string;
  vehicle: Vehicle;
  exchange: string;
  token: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  qty: number;
  entryAvgPrice: string;
  exitAvgPrice: string;
  openedAt: Date;
  closedAt: Date;
  grossPnl: string;
  charges: string;
  mtfInterest: string;
  netPnl: string;
  initialRisk: string | null;
  rMultiple: string | null;
  mfePrice: string | null;
  maePrice: string | null;
  mfeRupees: string | null;
  maeRupees: string | null;
  holdMinutes: number;
  exitReason: ExitReason;
  /** IST date of the close, YYYY-MM-DD. */
  istDay: string;
  createdAt: Date;
}

export type NewTradeSummary = Omit<TradeSummary, 'id' | 'createdAt'>;

/** SP3 spec §5.1 outcome keys the close fills (numbers, rupees). */
export interface CorpusOutcome {
  netPnl: number;
  grossPnl: number;
  fees: number;
  win: boolean;
  rMultiple: number | null;
  mfe: number | null;
  mae: number | null;
  holdMins: number;
}

/** One core setup for ai_decision_records (SP3 spec §5.1), kind ENTRY_SETUP. */
export interface CorpusSetup {
  intentId: string;
  userId: string;
  decidedAt: Date;
  symbol: string;
  exchange: string;
  vehicle: Vehicle;
  direction: 'LONG' | 'SHORT';
  strategyKey: string;
  strategyVersionId: string;
  setupGroupKey: string;
  evidence: Record<string, unknown>;
  ruleScore: number | null;
  decision: { taken: boolean; reason: string };
}
```

```ts
// apps/api/src/modules/trade-core/journal/journal-ports.ts
import type { CorpusSetup, JournalEntry, JournalRow } from './journal.types';

/** J10: how every M5 writer reaches core_journal (bound to CoreJournalService in Task 19). */
export const CORE_JOURNAL = Symbol('CORE_JOURNAL');

export interface CoreJournalPort {
  /** Best effort: never throws; buffered, written in order, retried; a drop is counted. */
  record(e: JournalEntry): void;
  /** Durable: resolves once written (or skipped as a duplicate key), rejects otherwise. */
  recordNow(e: JournalEntry): Promise<void>;
}

/** J16: told when the lifecycle closes a position (bound to CoreTradeSummaryService). */
export const CORE_POSITION_CLOSED = Symbol('CORE_POSITION_CLOSED');

export interface PositionClosedListener {
  positionClosed(userId: string, positionId: string): Promise<void>;
}

/** J5: what the intake's duplicate, cooldown and last-loss checks read (bound to CoreTradeSummaryService). */
export const CORE_TRADE_HISTORY = Symbol('CORE_TRADE_HISTORY');

export interface CoreTradeHistory {
  /** A position already carries this intent id (Review Focus 2). */
  intentSeen(intentId: string): Promise<boolean>;
  /** When this strategy last opened (first fill) a position on the token for the user, or null. */
  lastOpenedAt(userId: string, strategyId: string, token: string): Promise<Date | null>;
  /**
   * Today's (IST) last closed trade of this strategy on the token: its net P&L in rupees; 'UNKNOWN' when that
   * position has no summary and none can be written now; null when there is none.
   */
  lastClosedNetToday(userId: string, strategyId: string, token: string, now: Date): Promise<number | 'UNKNOWN' | null>;
}

/** O9 / J20: the SP3 corpus (bound to CoreCorpusWriter). */
export const CORE_CORPUS = Symbol('CORE_CORPUS');

export interface CoreCorpusPort {
  entrySetup(s: CorpusSetup): Promise<void>;
  /** Merges `patch` into the record's outcome (jsonb ||) for (source 'core', sourceId intentId). */
  outcome(intentId: string, patch: Record<string, unknown>, at: Date): Promise<void>;
}

export class NoopCorpus implements CoreCorpusPort {
  async entrySetup(_s: CorpusSetup): Promise<void> {
    return undefined;
  }

  async outcome(_intentId: string, _patch: Record<string, unknown>, _at: Date): Promise<void> {
    return undefined;
  }
}

/*
 * What the journal API (Task 17) reads from Streams B, C and E, as tokens, so Stream F imports none of
 * them. Task 19 binds each with useExisting.
 */
export const CORE_RECON_DESK = Symbol('CORE_RECON_DESK');

export interface ReconDesk {
  ack(userId: string, mismatchId: string, reason: string): Promise<{ acknowledged: string }>;
  unacked(userId: string): Promise<JournalRow[]>;
}

export const CORE_INTAKE_STATUS = Symbol('CORE_INTAKE_STATUS');

export interface IntakeStatusSource {
  status(): { mode: 'off' | 'journal' | 'paper'; users: number; pending: number; dropped: number };
}

export const CORE_JOURNAL_STATUS = Symbol('CORE_JOURNAL_STATUS');

export interface JournalStatusSource {
  status(): { pending: number; written: number; dropped: number; failures: number; lastError: string | null };
}
```

- [ ] **Step 4: Write the Prisma models and the migration**

Add after `model CorePosition { … }` in `prisma/schema.prisma`:

```prisma
// ─── SP2 M5: the journal and closed-trade summaries ─────────────────────────
// docs/superpowers/specs/2026-10-09-sp2-core-trade-lifecycle-design.md §8. Both tables are
// append-only (a trigger refuses UPDATE; DELETE happens only through the cascades).

/// One journal row (spec §8.1). A set dedupeKey makes an idempotent writer's second write a no-op.
model CoreJournal {
  id                String   @id @default(cuid())
  userId            String
  user              User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  type              String
  positionId        String?
  strategyId        String?
  strategyVersionId String?
  intentId          String?
  symbol            String?
  payload           Json
  priceUsed         Decimal? @db.Decimal(14, 4)
  priceAgeMs        Int?
  dedupeKey         String?  @unique
  istDay            DateTime @db.Date
  createdAt         DateTime @default(now())

  @@index([userId, istDay, type])
  @@index([userId, positionId])
  @@index([intentId])
  @@index([type, istDay])
  @@map("core_journal")
}

/// One closed core position's result (spec §8.2), net of charges and MTF interest.
model CoreTradeSummary {
  id                String       @id @default(cuid())
  userId            String
  user              User         @relation(fields: [userId], references: [id], onDelete: Cascade)
  positionId        String       @unique
  position          CorePosition @relation(fields: [positionId], references: [id], onDelete: Cascade)
  intentId          String       @unique
  strategyId        String
  strategyVersionId String
  vehicle           String
  exchange          String
  token             String
  symbol            String
  side              String
  qty               Int
  entryAvgPrice     Decimal      @db.Decimal(14, 4)
  exitAvgPrice      Decimal      @db.Decimal(14, 4)
  openedAt          DateTime
  closedAt          DateTime
  grossPnl          Decimal      @db.Decimal(14, 2)
  charges           Decimal      @db.Decimal(14, 2)
  mtfInterest       Decimal      @db.Decimal(14, 2)
  netPnl            Decimal      @db.Decimal(14, 2)
  initialRisk       Decimal?     @db.Decimal(14, 2)
  rMultiple         Decimal?     @db.Decimal(12, 4)
  mfePrice          Decimal?     @db.Decimal(14, 4)
  maePrice          Decimal?     @db.Decimal(14, 4)
  mfeRupees         Decimal?     @db.Decimal(14, 2)
  maeRupees         Decimal?     @db.Decimal(14, 2)
  holdMinutes       Int
  exitReason        String
  istDay            DateTime     @db.Date
  createdAt         DateTime     @default(now())

  @@index([userId, istDay])
  @@index([userId, strategyId, token, closedAt])
  @@map("core_trade_summaries")
}
```

In `model User` beside `corePositions CorePosition[]`:

```prisma
  coreJournal            CoreJournal[]
  coreTradeSummaries     CoreTradeSummary[]
```

In `model CorePosition` beside `orders CoreOrder[]`:

```prisma
  summary           CoreTradeSummary?
```

```sql
-- prisma/migrations/20261013120000_sp2_m5_journal/migration.sql
-- SP2 M5 — the journal and closed-trade summaries (docs/superpowers/plans/2026-10-13-sp2-m5-journal-and-entries.md).
--
-- Expand-only: two new tables with their indexes, FKs, CHECKs and append-only triggers (the M2
-- function core_append_only_guard() is reused, not redefined). No existing table, column,
-- constraint or function is changed.
CREATE TABLE "core_journal" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "positionId" TEXT,
    "strategyId" TEXT,
    "strategyVersionId" TEXT,
    "intentId" TEXT,
    "symbol" TEXT,
    "payload" JSONB NOT NULL,
    "priceUsed" DECIMAL(14,4),
    "priceAgeMs" INTEGER,
    "dedupeKey" TEXT,
    "istDay" DATE NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "core_journal_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "core_journal_dedupeKey_key" ON "core_journal"("dedupeKey");
CREATE INDEX "core_journal_userId_istDay_type_idx" ON "core_journal"("userId", "istDay", "type");
CREATE INDEX "core_journal_userId_positionId_idx" ON "core_journal"("userId", "positionId");
CREATE INDEX "core_journal_intentId_idx" ON "core_journal"("intentId");
CREATE INDEX "core_journal_type_istDay_idx" ON "core_journal"("type", "istDay");
ALTER TABLE "core_journal" ADD CONSTRAINT "core_journal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Vocabulary (journal.types.ts JOURNAL_TYPES; journal-migration.spec.ts checks the list).
ALTER TABLE "core_journal" ADD CONSTRAINT "core_journal_type_check" CHECK (
    "type" IN ('ALERT_RECEIVED', 'INTENT_SKIPPED', 'RISK_VERDICT', 'ORDER_PLACED', 'ORDER_STATE', 'FILL', 'STOP_MOVED', 'EXIT_DECIDED', 'POSITION_STATE', 'BLIND', 'RECOVERY_STOP', 'KILL_SWITCH', 'LIMIT_CHANGED', 'RECON_MISMATCH', 'RECON_ACK', 'DAILY_LOSS_LATCHED', 'PRICE_FOLLOWUP'));
ALTER TABLE "core_journal" ADD CONSTRAINT "core_journal_shape_check" CHECK (
    ("priceAgeMs" IS NULL OR "priceAgeMs" >= 0)
    AND ("dedupeKey" IS NULL OR length("dedupeKey") BETWEEN 1 AND 200)
    AND jsonb_typeof("payload") = 'object');

CREATE TABLE "core_trade_summaries" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "positionId" TEXT NOT NULL,
    "intentId" TEXT NOT NULL,
    "strategyId" TEXT NOT NULL,
    "strategyVersionId" TEXT NOT NULL,
    "vehicle" TEXT NOT NULL,
    "exchange" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "entryAvgPrice" DECIMAL(14,4) NOT NULL,
    "exitAvgPrice" DECIMAL(14,4) NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3) NOT NULL,
    "grossPnl" DECIMAL(14,2) NOT NULL,
    "charges" DECIMAL(14,2) NOT NULL,
    "mtfInterest" DECIMAL(14,2) NOT NULL,
    "netPnl" DECIMAL(14,2) NOT NULL,
    "initialRisk" DECIMAL(14,2),
    "rMultiple" DECIMAL(12,4),
    "mfePrice" DECIMAL(14,4),
    "maePrice" DECIMAL(14,4),
    "mfeRupees" DECIMAL(14,2),
    "maeRupees" DECIMAL(14,2),
    "holdMinutes" INTEGER NOT NULL,
    "exitReason" TEXT NOT NULL,
    "istDay" DATE NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "core_trade_summaries_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "core_trade_summaries_positionId_key" ON "core_trade_summaries"("positionId");
CREATE UNIQUE INDEX "core_trade_summaries_intentId_key" ON "core_trade_summaries"("intentId");
CREATE INDEX "core_trade_summaries_userId_istDay_idx" ON "core_trade_summaries"("userId", "istDay");
CREATE INDEX "core_trade_summaries_userId_strategyId_token_closedAt_idx" ON "core_trade_summaries"("userId", "strategyId", "token", "closedAt");
ALTER TABLE "core_trade_summaries" ADD CONSTRAINT "core_trade_summaries_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "core_trade_summaries" ADD CONSTRAINT "core_trade_summaries_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "core_positions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Vocabularies (lifecycle.types.ts EXIT_REASONS; journal-migration.spec.ts checks the list).
ALTER TABLE "core_trade_summaries" ADD CONSTRAINT "core_trade_summaries_vocab_check" CHECK (
    "vehicle" IN ('CASH_INTRADAY', 'MTF', 'OPTIONS_BUY')
    AND "side" IN ('BUY', 'SELL')
    AND "exitReason" IN ('KILL_SWITCH', 'DAILY_LOSS', 'STOP', 'GAP_STOP', 'RECOVERY_STOP', 'UNDERLYING_STOP', 'GUARD_RAIL', 'MANUAL', 'TARGET', 'TRAIL', 'TIME_EXIT', 'THETA_STOP', 'EXPIRY_DAY', 'HOLD_LIMIT', 'SQUARE_OFF'));
ALTER TABLE "core_trade_summaries" ADD CONSTRAINT "core_trade_summaries_shape_check" CHECK (
    "qty" > 0 AND "holdMinutes" >= 0 AND "closedAt" >= "openedAt"
    AND "charges" >= 0 AND "mtfInterest" >= 0
    AND ("initialRisk" IS NULL OR "initialRisk" > 0));

-- Append-only (spec §8.1: "no update or delete path"). DELETE stays possible only so deleting a
-- user (or a position) cascades. No repository has an update or delete method for these.
CREATE TRIGGER "core_journal_append_only"
    BEFORE UPDATE ON "core_journal"
    FOR EACH ROW EXECUTE FUNCTION core_append_only_guard();

CREATE TRIGGER "core_trade_summaries_append_only"
    BEFORE UPDATE ON "core_trade_summaries"
    FOR EACH ROW EXECUTE FUNCTION core_append_only_guard();
```

In `apps/api/src/common/tenant/tenant.constants.ts`, after `'CorePosition',`:

```ts
  // SP2 M5: the per-user journal and closed-trade summaries.
  'CoreJournal',
  'CoreTradeSummary',
```

In `apps/api/src/common/audit/audit-actions.ts`, after the `lifecycle: { … },` group:

```ts
  journal: {
    CORE_RECON_ACKNOWLEDGED: 'CORE_RECON_ACKNOWLEDGED',
  },
```

Regenerate the client: `cd apps/api && npx prisma generate --schema ../../prisma/schema.prisma` (if the worktree's
`node_modules` junction points at the main checkout's client, generating there regenerates the shared client; never
delete the junction).

- [ ] **Step 5: Run the specs to verify they pass**

Run: `cd apps/api && npx jest src/modules/trade-core/journal/journal-migration.spec.ts src/common/tenant src/common/audit`
Expected: PASS (5 migration tests; the tenant specs stay green — if one asserts the exact `TENANT_MODELS` list against the
schema, the two names now satisfy it).

- [ ] **Step 6: Write the opt-in database test**

```js
// apps/api/test/sp2-m5/jest.config.js
const path = require('path');

/**
 * Opt-in SQL tests for the SP2 M5 tables (CHECKs, append-only triggers, dedupe, cascades) and the
 * bounded ledger reads, against a THROWAWAY local Postgres on 127.0.0.1 with every migration applied.
 * The default apps/api Jest config (rootDir: src) never finds these.
 *
 * Run from apps/api:
 *   DATABASE_URL_TEST=postgresql://postgres:password@127.0.0.1:55434/grw_sp2m5_test \
 *     npx jest --config test/sp2-m5/jest.config.js -i
 */
module.exports = {
  rootDir: path.resolve(__dirname, '../..'),
  roots: ['<rootDir>/test/sp2-m5'],
  moduleFileExtensions: ['js', 'json', 'ts'],
  testRegex: '.*\\.spec\\.ts$',
  transform: { '^.+\\.(t|j)s$': ['ts-jest', { isolatedModules: true }] },
  testEnvironment: 'node',
};
```

```ts
// apps/api/test/sp2-m5/journal.int.spec.ts
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

async function journal(userId: string, type: string, dedupeKey: string | null = null): Promise<string> {
  const id = `jr_${rid()}`;
  await db.$executeRawUnsafe(
    `INSERT INTO "core_journal" ("id", "userId", "type", "payload", "dedupeKey", "istDay") VALUES ($1, $2, $3, '{}'::jsonb, $4, CURRENT_DATE)`,
    id, userId, type, dedupeKey,
  );
  return id;
}

async function closedPosition(userId: string): Promise<string> {
  const id = `pos_${rid()}`;
  await db.$executeRawUnsafe(
    `INSERT INTO "core_positions" ("id", "userId", "intentId", "strategyId", "strategyVersionId", "vehicle", "exchange", "token", "symbol", "lotSize", "underlying", "side", "direction", "status", "requestedQty", "entryFilledQty", "exitFilledQty", "plan", "exitReason", "closedAt", "updatedAt")
     VALUES ($1, $2, $1, 'cs_x', 'csv_x', 'CASH_INTRADAY', 'NSE', '2885', 'RELIANCE-EQ', 1, 'RELIANCE', 'BUY', 'LONG', 'CLOSED', 100, 100, 100, '{}'::jsonb, 'TARGET', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    id, userId,
  );
  return id;
}

async function summary(userId: string, positionId: string, over: Record<string, string> = {}): Promise<void> {
  const v = { exitReason: 'TARGET', charges: '12.50', initialRisk: '750.00', ...over };
  await db.$executeRawUnsafe(
    `INSERT INTO "core_trade_summaries" ("id", "userId", "positionId", "intentId", "strategyId", "strategyVersionId", "vehicle", "exchange", "token", "symbol", "side", "qty", "entryAvgPrice", "exitAvgPrice", "openedAt", "closedAt", "grossPnl", "charges", "mtfInterest", "netPnl", "initialRisk", "holdMinutes", "exitReason", "istDay")
     VALUES ($1, $2, $3, $3, 'cs_x', 'csv_x', 'CASH_INTRADAY', 'NSE', '2885', 'RELIANCE-EQ', 'BUY', 100, 500, 515, CURRENT_TIMESTAMP - interval '1 hour', CURRENT_TIMESTAMP, 1500, $4::numeric, 0, 1487.50, $5::numeric, 60, $6, CURRENT_DATE)`,
    `sum_${rid()}`, userId, positionId, v.charges, v.initialRisk, v.exitReason,
  );
}

afterAll(async () => {
  await db.$executeRawUnsafe(`DELETE FROM "users" WHERE "id" LIKE $1`, `usr_${run}_%`);
  await db.$disconnect();
});

describe('core_journal (SP2 M5 migration)', () => {
  it('accepts a known type and refuses an unknown one', async () => {
    const u = await newUser();
    await expect(journal(u, 'FILL')).resolves.toMatch(/^jr_/);
    await expect(journal(u, 'GOSSIP')).rejects.toThrow(/core_journal_type_check/);
  });

  it('a dedupe key is unique and ON CONFLICT DO NOTHING skips the second write', async () => {
    const u = await newUser();
    const key = `fill:${rid()}`;
    await journal(u, 'FILL', key);
    await expect(journal(u, 'FILL', key)).rejects.toThrow(/core_journal_dedupeKey_key/);
    const n = await db.$executeRawUnsafe(
      `INSERT INTO "core_journal" ("id", "userId", "type", "payload", "dedupeKey", "istDay") VALUES ($1, $2, 'FILL', '{}'::jsonb, $3, CURRENT_DATE) ON CONFLICT DO NOTHING`,
      `jr_${rid()}`, u, key,
    );
    expect(n).toBe(0);
  });

  it('is append-only: UPDATE is refused, the user cascade still deletes', async () => {
    const u = await newUser();
    const id = await journal(u, 'BLIND');
    await expect(db.$executeRawUnsafe(`UPDATE "core_journal" SET "type" = 'FILL' WHERE "id" = $1`, id)).rejects.toThrow(/append-only/);
    await db.$executeRawUnsafe(`DELETE FROM "users" WHERE "id" = $1`, u);
    expect(await db.coreJournal.count({ where: { id } })).toBe(0);
  });
});

describe('core_trade_summaries (SP2 M5 migration)', () => {
  it('one summary per position; an unknown exit reason, negative charges or a zero risk are refused', async () => {
    const u = await newUser();
    const p = await closedPosition(u);
    await expect(summary(u, p, { exitReason: 'BORED' })).rejects.toThrow(/core_trade_summaries_vocab_check/);
    await expect(summary(u, p, { charges: '-1.00' })).rejects.toThrow(/core_trade_summaries_shape_check/);
    await expect(summary(u, p, { initialRisk: '0.00' })).rejects.toThrow(/core_trade_summaries_shape_check/);
    await summary(u, p);
    await expect(summary(u, p)).rejects.toThrow(/core_trade_summaries_positionId_key/);
  });

  it('is append-only, and deleting the position cascades', async () => {
    const u = await newUser();
    const p = await closedPosition(u);
    await summary(u, p);
    await expect(db.$executeRawUnsafe(`UPDATE "core_trade_summaries" SET "qty" = 1 WHERE "positionId" = $1`, p)).rejects.toThrow(/append-only/);
    await db.$executeRawUnsafe(`DELETE FROM "core_positions" WHERE "id" = $1`, p);
    expect(await db.coreTradeSummary.count({ where: { positionId: p } })).toBe(0);
  });
});
```

(Task 3 appends a `describe` for the bounded ledger reads to this file.)

- [ ] **Step 7: Commit**

```bash
git add -- prisma/migrations/20261013120000_sp2_m5_journal/migration.sql apps/api/src/modules/trade-core/journal/journal.types.ts apps/api/src/modules/trade-core/journal/journal-ports.ts apps/api/src/modules/trade-core/journal/journal-migration.spec.ts apps/api/test/sp2-m5/jest.config.js apps/api/test/sp2-m5/journal.int.spec.ts
git commit -m "feat(trade-core): SP2 M5 journal and trade-summary tables, vocabulary and ports" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- prisma/schema.prisma prisma/migrations/20261013120000_sp2_m5_journal/migration.sql apps/api/src/common/tenant/tenant.constants.ts apps/api/src/common/audit/audit-actions.ts apps/api/src/modules/trade-core/journal/journal.types.ts apps/api/src/modules/trade-core/journal/journal-ports.ts apps/api/src/modules/trade-core/journal/journal-migration.spec.ts apps/api/test/sp2-m5/jest.config.js apps/api/test/sp2-m5/journal.int.spec.ts
```

---

### Task 2: Repositories, their in-memory twins, the candle reader, and the scans M5 needs

**Files:**
- Create: `apps/api/src/modules/trade-core/journal/repositories/core-journal.repository.ts`
- Create: `apps/api/src/modules/trade-core/journal/repositories/core-trade-summary.repository.ts`
- Test: `apps/api/src/modules/trade-core/journal/repositories/core-journal.repository.spec.ts`
- Create: `apps/api/src/modules/trade-core/journal/testing/memory-journal-store.ts`
- Test: `apps/api/src/modules/trade-core/journal/testing/memory-journal-store.spec.ts`
- Create: `apps/api/src/modules/trade-core/journal/testing/fake-journal.ts` (the `CoreJournalPort` fake every stream's specs use)
- Create: `apps/api/src/modules/trade-core/market/core-candles.ts`
- Test: `apps/api/src/modules/trade-core/market/core-candles.spec.ts`
- Modify: `apps/api/src/modules/trade-core/lifecycle/repositories/core-position.repository.ts` (three methods)
- Modify: `apps/api/src/modules/trade-core/lifecycle/testing/memory-position-store.ts` (the same three) and its spec
- Modify: `apps/api/src/modules/trade-core/strategies/repositories/core-strategy-selection.repository.ts` (`listEnabledPaper`)
- Test: `apps/api/src/modules/trade-core/strategies/repositories/core-strategy-selection.repository.spec.ts` (new)

**Interfaces:**
- Consumes: Task 1 types; `PrismaService`, `TenantContextService`, `ClsService` (M4 pattern); `istDate`;
  `HUB_CANDLE_SOURCE`, `HubCandleSource`, `HubCandle`, `Timeframe`, `InstrumentRef`.
- Produces:
  - `CoreJournalRepository`: `append(entries): Promise<number>`; `listForPosition(userId, positionId): Promise<JournalRow[]>`;
    `listForDay(userId, day, types?): Promise<JournalRow[]>`; `findForUser(userId, id): Promise<JournalRow | null>`;
    `hasType(userId, day, type): Promise<boolean>`; `unackedMismatches(userId): Promise<JournalRow[]>`;
    `listTypeOnDay(type, day, take): Promise<JournalRow[]>` (system scan); exported `toJournalData(e)`, `toJournalRow(r)`.
  - `CoreTradeSummaryRepository`: `createIfAbsent(s): Promise<TradeSummary>`; `findByPosition(userId, positionId)`;
    `positionIdsWithSummary(userId, positionIds): Promise<Set<string>>`; `listForDay(userId, day): Promise<TradeSummary[]>`.
  - `MemoryJournalStore` with `rows`, `summaries`, `failWrites`, `.repo`, `.summaryRepo`, `port(): CoreJournalPort`, `sampleSummary(over)`
    (streams D and E use `port()` so they never depend on Stream C's `CoreJournalService`).
  - `FakeJournal implements CoreJournalPort` with `entries`, `failNow`, `types()`, `ofType(type)`.
  - `CoreCandles.read(ref, timeframe, from, to): Promise<CandleRead>`;
    `type CandleRead = { ok: true; candles: HubCandle[]; complete: boolean } | { ok: false; reason: string }`.
  - `CorePositionRepository.lastOpenedAt(userId, strategyId, token): Promise<Date | null>`,
    `listClosedSince(userId, strategyId, token, since): Promise<CorePosition[]>` (newest close first),
    `listUserIdsSince(since): Promise<string[]>` (system scan: active, or created or closed since).
  - `CoreStrategySelectionRepository.listEnabledPaper(): Promise<LiveSelection[]>` and `LiveSelection`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/modules/trade-core/journal/repositories/core-journal.repository.spec.ts
import { Prisma } from '@prisma/client';
import type { ClsService } from 'nestjs-cls';
import type { PrismaService } from '../../../../common/prisma/prisma.service';
import type { TenantContextService } from '../../../../common/tenant/tenant-context.service';
import { CoreJournalRepository, toJournalData } from './core-journal.repository';

function setup() {
  const prisma = {
    coreJournal: { createMany: jest.fn().mockResolvedValue({ count: 2 }), findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null) },
  };
  const tenant = { runWithoutTenant: jest.fn((fn: () => unknown) => fn()) };
  const cls = { isActive: jest.fn().mockReturnValue(true) };
  const repo = new CoreJournalRepository(prisma as unknown as PrismaService, tenant as unknown as TenantContextService, cls as unknown as ClsService);
  return { prisma, tenant, repo };
}

const AT = new Date('2026-10-13T04:00:00.000Z'); // 09:30 IST

describe('CoreJournalRepository (spec §8.1)', () => {
  it('maps an entry: IST day from `at`, createdAt = at, price as Decimal, age rounded and never negative', () => {
    const d = toJournalData({ userId: 'u', type: 'FILL', at: AT, payload: { a: 1 }, priceUsed: 500.25, priceAgeMs: -3.4, dedupeKey: 'fill:1' });
    expect(d).toMatchObject({ userId: 'u', type: 'FILL', payload: { a: 1 }, priceAgeMs: 0, dedupeKey: 'fill:1', createdAt: AT, positionId: null, intentId: null });
    expect(d.istDay.toISOString()).toBe('2026-10-13T00:00:00.000Z');
    expect((d.priceUsed as Prisma.Decimal).toString()).toBe('500.25');
  });

  it('the IST day of 23:59 IST is that day, of 00:01 IST the next', () => {
    expect(toJournalData({ userId: 'u', type: 'BLIND', at: new Date('2026-10-13T18:29:00.000Z'), payload: {} }).istDay.toISOString().slice(0, 10)).toBe('2026-10-13');
    expect(toJournalData({ userId: 'u', type: 'BLIND', at: new Date('2026-10-13T18:31:00.000Z'), payload: {} }).istDay.toISOString().slice(0, 10)).toBe('2026-10-14');
  });

  it('append writes in one createMany with skipDuplicates; nothing for none', async () => {
    const { prisma, repo } = setup();
    expect(await repo.append([])).toBe(0);
    expect(prisma.coreJournal.createMany).not.toHaveBeenCalled();
    expect(await repo.append([{ userId: 'u', type: 'FILL', at: AT, payload: {} }, { userId: 'u', type: 'FILL', at: AT, payload: {} }])).toBe(2);
    expect(prisma.coreJournal.createMany).toHaveBeenCalledWith({ data: expect.any(Array), skipDuplicates: true });
  });

  it('every per-user read names the userId; the day scan is the only system read and lifts tenant scoping', async () => {
    const { prisma, tenant, repo } = setup();
    await repo.listForPosition('u', 'pos_1');
    await repo.listForDay('u', '2026-10-13', ['FILL']);
    await repo.findForUser('u', 'jr_1');
    await repo.hasType('u', '2026-10-13', 'DAILY_LOSS_LATCHED');
    for (const call of [...prisma.coreJournal.findMany.mock.calls, ...prisma.coreJournal.findFirst.mock.calls]) {
      expect((call[0] as { where: { userId: string } }).where.userId).toBe('u');
    }
    expect(tenant.runWithoutTenant).not.toHaveBeenCalled();
    await repo.listTypeOnDay('INTENT_SKIPPED', '2026-10-13', 5000);
    expect(tenant.runWithoutTenant).toHaveBeenCalledTimes(1);
  });

  it('unacked mismatches: a RECON_MISMATCH whose ack:<id> row exists is left out', async () => {
    const { prisma, repo } = setup();
    const row = (id: string, type: string, dedupeKey: string | null) => ({
      id, userId: 'u', type, positionId: null, strategyId: null, strategyVersionId: null, intentId: null, symbol: null,
      payload: {}, priceUsed: null, priceAgeMs: null, dedupeKey, istDay: new Date('2026-10-13T00:00:00.000Z'), createdAt: AT,
    });
    prisma.coreJournal.findMany
      .mockResolvedValueOnce([row('m1', 'RECON_MISMATCH', 'recon:a'), row('m2', 'RECON_MISMATCH', 'recon:b')])
      .mockResolvedValueOnce([{ dedupeKey: 'ack:m1' }]);
    expect((await repo.unackedMismatches('u')).map((r) => r.id)).toEqual(['m2']);
  });

  it('has no update or delete method (append-only)', () => {
    const { repo } = setup();
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(repo)).filter((n) => /update|delete|remove|upsert/i.test(n))).toEqual([]);
  });
});
```

```ts
// apps/api/src/modules/trade-core/journal/testing/memory-journal-store.spec.ts
import { MemoryJournalStore } from './memory-journal-store';

const AT = new Date('2026-10-13T04:00:00.000Z');

describe('MemoryJournalStore (the repositories twin)', () => {
  it('dedupes by key, keeps order, and fails every write while failWrites is on', async () => {
    const s = new MemoryJournalStore();
    expect(await s.repo.append([{ userId: 'u', type: 'FILL', at: AT, payload: {}, dedupeKey: 'k' }, { userId: 'u', type: 'FILL', at: AT, payload: {}, dedupeKey: 'k' }])).toBe(1);
    s.failWrites = true;
    await expect(s.repo.append([{ userId: 'u', type: 'BLIND', at: AT, payload: {} }])).rejects.toThrow(/journal down/);
    expect(s.rows.map((r) => r.type)).toEqual(['FILL']);
  });

  it('summaries: one per position (first write wins), read back by user only', async () => {
    const s = new MemoryJournalStore();
    const base = s.sampleSummary({ userId: 'u', positionId: 'p1' });
    await s.summaryRepo.createIfAbsent(base);
    expect((await s.summaryRepo.createIfAbsent({ ...base, netPnl: '9.99' })).netPnl).toBe(base.netPnl);
    expect(s.summaries).toHaveLength(1);
    expect(await s.summaryRepo.findByPosition('other', 'p1')).toBeNull();
    expect((await s.summaryRepo.positionIdsWithSummary('u', ['p1', 'p2'])).has('p1')).toBe(true);
  });
});
```

```ts
// apps/api/src/modules/trade-core/market/core-candles.spec.ts
import type { ModuleRef } from '@nestjs/core';
import { HUB_CANDLE_SOURCE } from '../../market-hub/hub-candle-source';
import { CoreCandles } from './core-candles';

const REF = { exchange: 'NSE' as const, token: '2885', symbol: 'RELIANCE-EQ' };
const from = new Date('2026-10-10T03:45:00.000Z');
const to = new Date('2026-10-13T05:00:00.000Z');

function make(source: unknown, throws = false) {
  const moduleRef = {
    get: jest.fn((token: string) => {
      if (throws || token !== HUB_CANDLE_SOURCE) throw new Error('no market hub in this container');
      return source;
    }),
  };
  return new CoreCandles(moduleRef as unknown as ModuleRef);
}

describe('CoreCandles (ruling J7)', () => {
  it('reads the hub candle store and says whether the range is complete', async () => {
    const candles = jest.fn().mockResolvedValue({ candles: [{ ts: 1, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }], incomplete: [{ from: 0, to: 1, reason: 'throttled' }] });
    const r = await make({ servesCharts: () => true, candles }).read(REF, '5m', from, to);
    expect(r).toEqual({ ok: true, candles: [expect.objectContaining({ close: 1.5 })], complete: false });
    expect(candles).toHaveBeenCalledWith(REF, '5m', from, to);
  });

  it('no hub, candles off, or a failing read is a reason, never a throw', async () => {
    expect(await make(null, true).read(REF, '5m', from, to)).toEqual({ ok: false, reason: 'no market hub in this container' });
    expect(await make({ servesCharts: () => false, candles: jest.fn() }).read(REF, '5m', from, to)).toEqual({ ok: false, reason: 'hub candles are off (HUB_CANDLES_ENABLED / HUB_SERVES_CHARTS)' });
    expect(await make({ servesCharts: () => true, candles: jest.fn().mockRejectedValue(new Error('broker down')) }).read(REF, '5m', from, to)).toEqual({ ok: false, reason: 'broker down' });
  });
});
```

```ts
// apps/api/src/modules/trade-core/strategies/repositories/core-strategy-selection.repository.spec.ts
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../../../../common/prisma/prisma.service';
import { CoreStrategySelectionRepository } from './core-strategy-selection.repository';

describe('CoreStrategySelectionRepository.listEnabledPaper (M1 note: live = enabled AND PAPER)', () => {
  it('asks for enabled selections whose version is PAPER, with the strategy key and the blocks', async () => {
    const findMany = jest.fn().mockResolvedValue([
      {
        userId: 'u', strategyId: 'cs_adaptive_stop', strategyVersionId: 'csv_adaptive_stop_v1', capitalAllocation: new Prisma.Decimal('200000'),
        strategy: { key: 'adaptive-stop' }, strategyVersion: { blocks: { entry: { kind: 'chartink' } } },
      },
    ]);
    const repo = new CoreStrategySelectionRepository({ coreStrategySelection: { findMany } } as unknown as PrismaService);
    expect(await repo.listEnabledPaper()).toEqual([
      { userId: 'u', strategyId: 'cs_adaptive_stop', strategyKey: 'adaptive-stop', strategyVersionId: 'csv_adaptive_stop_v1', blocks: { entry: { kind: 'chartink' } }, capitalAllocation: '200000.00' },
    ]);
    expect(findMany).toHaveBeenCalledWith({
      where: { enabled: true, strategyVersion: { status: 'PAPER' } },
      include: { strategy: true, strategyVersion: true },
      orderBy: [{ userId: 'asc' }, { createdAt: 'asc' }],
    });
  });
});
```

Append to `apps/api/src/modules/trade-core/lifecycle/testing/memory-position-store.spec.ts` (import `cashPlan` from
`./lifecycle-fixtures` if it is not imported yet):

```ts
describe('M5 reads', () => {
  it('lastOpenedAt is the newest openedAt of this strategy on the token; closed-since is newest first; user ids since', async () => {
    const s = new MemoryPositionStore(() => new Date('2026-10-13T05:00:00.000Z'));
    const base = {
      userId: 'user_A', strategyId: 'cs_x', strategyVersionId: 'csv_x', vehicle: 'CASH_INTRADAY' as const,
      instrument: { exchange: 'NSE', token: '2885', symbol: 'RELIANCE-EQ', lotSize: 1, underlying: null },
      underlying: 'RELIANCE', side: 'BUY' as const, direction: 'LONG' as const, requestedQty: 10, plan: cashPlan(),
    };
    const a = await s.repo.createIfNoActive({ ...base, intentId: 'i1' });
    await s.repo.update('user_A', a.id, a.version, { openedAt: new Date('2026-10-13T04:00:00.000Z'), status: 'CLOSED', closedAt: new Date('2026-10-13T04:30:00.000Z') });
    const b = await s.repo.createIfNoActive({ ...base, intentId: 'i2' });
    await s.repo.update('user_A', b.id, b.version, { openedAt: new Date('2026-10-13T04:45:00.000Z'), status: 'CLOSED', closedAt: new Date('2026-10-13T04:50:00.000Z') });
    expect(await s.repo.lastOpenedAt('user_A', 'cs_x', '2885')).toEqual(new Date('2026-10-13T04:45:00.000Z'));
    expect(await s.repo.lastOpenedAt('user_A', 'cs_other', '2885')).toBeNull();
    expect((await s.repo.listClosedSince('user_A', 'cs_x', '2885', new Date('2026-10-12T18:30:00.000Z'))).map((p) => p.intentId)).toEqual(['i2', 'i1']);
    expect(await s.repo.listUserIdsSince(new Date('2026-10-12T18:30:00.000Z'))).toEqual(['user_A']);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/api && npx jest src/modules/trade-core/journal src/modules/trade-core/market src/modules/trade-core/strategies/repositories src/modules/trade-core/lifecycle/testing`
Expected: FAIL — modules not found / `s.repo.lastOpenedAt is not a function`.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/modules/trade-core/journal/repositories/core-journal.repository.ts
import { Injectable } from '@nestjs/common';
import { Prisma, type CoreJournal as CoreJournalDb } from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { TenantContextService } from '../../../../common/tenant/tenant-context.service';
import { istDate } from '../../execution/ledger-math';
import type { JournalEntry, JournalRow, JournalType } from '../journal.types';

const dayDate = (day: string): Date => new Date(`${day}T00:00:00.000Z`);
const OLDEST_FIRST = [{ createdAt: 'asc' as const }, { id: 'asc' as const }];
const finiteOrNull = (n: number | null | undefined): number | null => (typeof n === 'number' && Number.isFinite(n) ? n : null);

export function toJournalData(e: JournalEntry) {
  const price = finiteOrNull(e.priceUsed);
  const age = finiteOrNull(e.priceAgeMs);
  return {
    userId: e.userId,
    type: e.type,
    positionId: e.positionId ?? null,
    strategyId: e.strategyId ?? null,
    strategyVersionId: e.strategyVersionId ?? null,
    intentId: e.intentId ?? null,
    symbol: e.symbol ?? null,
    payload: e.payload as Prisma.InputJsonValue,
    priceUsed: price === null ? null : new Prisma.Decimal(price),
    priceAgeMs: age === null ? null : Math.max(0, Math.round(age)),
    dedupeKey: e.dedupeKey ?? null,
    istDay: dayDate(istDate(e.at)),
    createdAt: e.at,
  };
}

export function toJournalRow(r: CoreJournalDb): JournalRow {
  return {
    id: r.id,
    userId: r.userId,
    type: r.type as JournalType,
    positionId: r.positionId,
    strategyId: r.strategyId,
    strategyVersionId: r.strategyVersionId,
    intentId: r.intentId,
    symbol: r.symbol,
    payload: (r.payload ?? {}) as Record<string, unknown>,
    priceUsed: r.priceUsed === null ? null : r.priceUsed.toNumber(),
    priceAgeMs: r.priceAgeMs,
    dedupeKey: r.dedupeKey,
    istDay: r.istDay.toISOString().slice(0, 10),
    createdAt: r.createdAt,
  };
}

/**
 * core_journal (spec §8.1): append-only. No update or delete method exists (a trigger refuses
 * UPDATE too). Every per-user read names the userId; listTypeOnDay is the one system scan (the
 * follow-up job) and lifts tenant scoping like CorePositionRepository.listActive.
 */
@Injectable()
export class CoreJournalRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
    private readonly cls: ClsService,
  ) {}

  private withoutTenant<T>(fn: () => T): T {
    return this.cls.isActive() ? this.tenant.runWithoutTenant(fn) : fn();
  }

  /** In order; a row whose dedupeKey already exists is skipped. Returns how many were new. */
  async append(entries: readonly JournalEntry[]): Promise<number> {
    if (entries.length === 0) return 0;
    const { count } = await this.prisma.coreJournal.createMany({ data: entries.map(toJournalData), skipDuplicates: true });
    return count;
  }

  async listForPosition(userId: string, positionId: string): Promise<JournalRow[]> {
    return (await this.prisma.coreJournal.findMany({ where: { userId, positionId }, orderBy: OLDEST_FIRST })).map(toJournalRow);
  }

  async listForDay(userId: string, day: string, types?: readonly JournalType[]): Promise<JournalRow[]> {
    const where = { userId, istDay: dayDate(day), ...(types ? { type: { in: [...types] } } : {}) };
    return (await this.prisma.coreJournal.findMany({ where, orderBy: OLDEST_FIRST })).map(toJournalRow);
  }

  async findForUser(userId: string, id: string): Promise<JournalRow | null> {
    const r = await this.prisma.coreJournal.findFirst({ where: { userId, id } });
    return r ? toJournalRow(r) : null;
  }

  async hasType(userId: string, day: string, type: JournalType): Promise<boolean> {
    return (await this.prisma.coreJournal.findFirst({ where: { userId, istDay: dayDate(day), type }, select: { id: true } })) !== null;
  }

  /** Every RECON_MISMATCH of the user without its RECON_ACK (dedupeKey `ack:<mismatchId>`). */
  async unackedMismatches(userId: string): Promise<JournalRow[]> {
    const mismatches = await this.prisma.coreJournal.findMany({ where: { userId, type: 'RECON_MISMATCH' }, orderBy: OLDEST_FIRST });
    if (mismatches.length === 0) return [];
    const acks = await this.prisma.coreJournal.findMany({ where: { userId, type: 'RECON_ACK' }, select: { dedupeKey: true } });
    const acked = new Set(acks.map((a) => a.dedupeKey));
    return mismatches.filter((m) => !acked.has(`ack:${m.id}`)).map(toJournalRow);
  }

  /** System scan (follow-ups): every user's rows of one type on one IST day, oldest first, at most `take`. */
  async listTypeOnDay(type: JournalType, day: string, take: number): Promise<JournalRow[]> {
    const rows = await this.withoutTenant(() =>
      this.prisma.coreJournal.findMany({ where: { type, istDay: dayDate(day) }, orderBy: OLDEST_FIRST, take }),
    );
    return rows.map(toJournalRow);
  }
}
```

```ts
// apps/api/src/modules/trade-core/journal/repositories/core-trade-summary.repository.ts
import { Injectable } from '@nestjs/common';
import { Prisma, type CoreTradeSummary as CoreTradeSummaryDb } from '@prisma/client';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import type { ExitReason } from '../../lifecycle/lifecycle.types';
import type { Vehicle } from '../../strategies/blocks/block-types';
import type { NewTradeSummary, TradeSummary } from '../journal.types';

const dec = (s: string | null): Prisma.Decimal | null => (s === null ? null : new Prisma.Decimal(s));
const str = (d: Prisma.Decimal | null, dp: number): string | null => (d === null ? null : d.toFixed(dp));

export function toSummary(r: CoreTradeSummaryDb): TradeSummary {
  return {
    id: r.id,
    userId: r.userId,
    positionId: r.positionId,
    intentId: r.intentId,
    strategyId: r.strategyId,
    strategyVersionId: r.strategyVersionId,
    vehicle: r.vehicle as Vehicle,
    exchange: r.exchange,
    token: r.token,
    symbol: r.symbol,
    side: r.side as 'BUY' | 'SELL',
    qty: r.qty,
    entryAvgPrice: r.entryAvgPrice.toFixed(4),
    exitAvgPrice: r.exitAvgPrice.toFixed(4),
    openedAt: r.openedAt,
    closedAt: r.closedAt,
    grossPnl: r.grossPnl.toFixed(2),
    charges: r.charges.toFixed(2),
    mtfInterest: r.mtfInterest.toFixed(2),
    netPnl: r.netPnl.toFixed(2),
    initialRisk: str(r.initialRisk, 2),
    rMultiple: str(r.rMultiple, 4),
    mfePrice: str(r.mfePrice, 4),
    maePrice: str(r.maePrice, 4),
    mfeRupees: str(r.mfeRupees, 2),
    maeRupees: str(r.maeRupees, 2),
    holdMinutes: r.holdMinutes,
    exitReason: r.exitReason as ExitReason,
    istDay: r.istDay.toISOString().slice(0, 10),
    createdAt: r.createdAt,
  };
}

/** core_trade_summaries (spec §8.2): one per closed position, append-only (no update or delete method). */
@Injectable()
export class CoreTradeSummaryRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Writes the summary unless the position already has one, then returns the stored row (first write wins). */
  async createIfAbsent(s: NewTradeSummary): Promise<TradeSummary> {
    await this.prisma.coreTradeSummary.createMany({
      data: [
        {
          ...s,
          entryAvgPrice: new Prisma.Decimal(s.entryAvgPrice),
          exitAvgPrice: new Prisma.Decimal(s.exitAvgPrice),
          grossPnl: new Prisma.Decimal(s.grossPnl),
          charges: new Prisma.Decimal(s.charges),
          mtfInterest: new Prisma.Decimal(s.mtfInterest),
          netPnl: new Prisma.Decimal(s.netPnl),
          initialRisk: dec(s.initialRisk),
          rMultiple: dec(s.rMultiple),
          mfePrice: dec(s.mfePrice),
          maePrice: dec(s.maePrice),
          mfeRupees: dec(s.mfeRupees),
          maeRupees: dec(s.maeRupees),
          istDay: new Date(`${s.istDay}T00:00:00.000Z`),
        },
      ],
      skipDuplicates: true,
    });
    const row = await this.prisma.coreTradeSummary.findFirst({ where: { userId: s.userId, positionId: s.positionId } });
    if (!row) throw new Error(`the summary of ${s.positionId} was not stored`);
    return toSummary(row);
  }

  async findByPosition(userId: string, positionId: string): Promise<TradeSummary | null> {
    const r = await this.prisma.coreTradeSummary.findFirst({ where: { userId, positionId } });
    return r ? toSummary(r) : null;
  }

  async positionIdsWithSummary(userId: string, positionIds: readonly string[]): Promise<Set<string>> {
    if (positionIds.length === 0) return new Set();
    const rows = await this.prisma.coreTradeSummary.findMany({ where: { userId, positionId: { in: [...positionIds] } }, select: { positionId: true } });
    return new Set(rows.map((r) => r.positionId));
  }

  async listForDay(userId: string, day: string): Promise<TradeSummary[]> {
    const rows = await this.prisma.coreTradeSummary.findMany({
      where: { userId, istDay: new Date(`${day}T00:00:00.000Z`) },
      orderBy: [{ closedAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map(toSummary);
  }
}
```

```ts
// apps/api/src/modules/trade-core/journal/testing/memory-journal-store.ts
import { istDate } from '../../execution/ledger-math';
import type { CoreJournalPort } from '../journal-ports';
import type { CoreJournalRepository } from '../repositories/core-journal.repository';
import type { CoreTradeSummaryRepository } from '../repositories/core-trade-summary.repository';
import type { JournalEntry, JournalRow, JournalType, NewTradeSummary, TradeSummary } from '../journal.types';

/** In-memory twins of CoreJournalRepository and CoreTradeSummaryRepository for service tests. */
export class MemoryJournalStore {
  rows: JournalRow[] = [];
  summaries: TradeSummary[] = [];
  /** While true every write rejects (a journal outage). */
  failWrites = false;
  private seq = 0;

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}_${this.seq}`;
  }

  readonly repo = {
    append: async (entries: readonly JournalEntry[]) => {
      if (this.failWrites) throw new Error('journal down');
      let n = 0;
      for (const e of entries) {
        if (e.dedupeKey && this.rows.some((r) => r.dedupeKey === e.dedupeKey)) continue;
        this.rows.push({
          id: this.nextId('jr'),
          userId: e.userId,
          type: e.type,
          positionId: e.positionId ?? null,
          strategyId: e.strategyId ?? null,
          strategyVersionId: e.strategyVersionId ?? null,
          intentId: e.intentId ?? null,
          symbol: e.symbol ?? null,
          payload: JSON.parse(JSON.stringify(e.payload)) as Record<string, unknown>,
          priceUsed: e.priceUsed ?? null,
          priceAgeMs: e.priceAgeMs === null || e.priceAgeMs === undefined ? null : Math.max(0, Math.round(e.priceAgeMs)),
          dedupeKey: e.dedupeKey ?? null,
          istDay: istDate(e.at),
          createdAt: e.at,
        });
        n += 1;
      }
      return n;
    },
    listForPosition: async (userId: string, positionId: string) => this.rows.filter((r) => r.userId === userId && r.positionId === positionId),
    listForDay: async (userId: string, day: string, types?: readonly JournalType[]) =>
      this.rows.filter((r) => r.userId === userId && r.istDay === day && (!types || types.includes(r.type))),
    findForUser: async (userId: string, id: string) => this.rows.find((r) => r.userId === userId && r.id === id) ?? null,
    hasType: async (userId: string, day: string, type: JournalType) => this.rows.some((r) => r.userId === userId && r.istDay === day && r.type === type),
    unackedMismatches: async (userId: string) => {
      const acked = new Set(this.rows.filter((r) => r.userId === userId && r.type === 'RECON_ACK').map((r) => r.dedupeKey));
      return this.rows.filter((r) => r.userId === userId && r.type === 'RECON_MISMATCH' && !acked.has(`ack:${r.id}`));
    },
    listTypeOnDay: async (type: JournalType, day: string, take: number) => this.rows.filter((r) => r.type === type && r.istDay === day).slice(0, take),
  } as unknown as CoreJournalRepository;

  readonly summaryRepo = {
    createIfAbsent: async (s: NewTradeSummary) => {
      if (this.failWrites) throw new Error('journal down');
      const existing = this.summaries.find((x) => x.positionId === s.positionId);
      if (existing) return existing;
      const row: TradeSummary = { ...s, id: this.nextId('sum'), createdAt: s.closedAt };
      this.summaries.push(row);
      return row;
    },
    findByPosition: async (userId: string, positionId: string) => this.summaries.find((x) => x.userId === userId && x.positionId === positionId) ?? null,
    positionIdsWithSummary: async (userId: string, ids: readonly string[]) =>
      new Set(this.summaries.filter((x) => x.userId === userId && ids.includes(x.positionId)).map((x) => x.positionId)),
    listForDay: async (userId: string, day: string) => this.summaries.filter((x) => x.userId === userId && x.istDay === day),
  } as unknown as CoreTradeSummaryRepository;

  /** A CoreJournalPort writing straight to this store (record is fire-and-forget; recordNow awaits). */
  port(): CoreJournalPort {
    return {
      record: (e: JournalEntry) => {
        void this.repo.append([e]).catch(() => undefined);
      },
      recordNow: async (e: JournalEntry) => {
        await this.repo.append([e]);
      },
    };
  }

  /** Test data: a closed cash trade summary. */
  sampleSummary(over: Partial<NewTradeSummary> = {}): NewTradeSummary {
    return {
      userId: 'user_A', positionId: 'pos_1', intentId: 'int_1', strategyId: 'cs_ungated', strategyVersionId: 'csv_ungated_v1',
      vehicle: 'CASH_INTRADAY', exchange: 'NSE', token: '2885', symbol: 'RELIANCE-EQ', side: 'BUY', qty: 100,
      entryAvgPrice: '500.0000', exitAvgPrice: '515.0000', openedAt: new Date('2026-10-13T04:00:00.000Z'), closedAt: new Date('2026-10-13T05:00:00.000Z'),
      grossPnl: '1500.00', charges: '40.00', mtfInterest: '0.00', netPnl: '1460.00', initialRisk: '750.00', rMultiple: '1.9467',
      mfePrice: '516.0000', maePrice: '499.0000', mfeRupees: '1600.00', maeRupees: '-100.00', holdMinutes: 60, exitReason: 'TARGET', istDay: '2026-10-13',
      ...over,
    };
  }
}
```

```ts
// apps/api/src/modules/trade-core/journal/testing/fake-journal.ts
import type { CoreJournalPort } from '../journal-ports';
import type { JournalEntry, JournalType } from '../journal.types';

/** CoreJournalPort for unit specs: records what writers hand it; `failNow` makes recordNow reject. */
export class FakeJournal implements CoreJournalPort {
  readonly entries: JournalEntry[] = [];
  failNow = false;

  record(e: JournalEntry): void {
    this.entries.push(e);
  }

  async recordNow(e: JournalEntry): Promise<void> {
    if (this.failNow) throw new Error('journal down');
    this.entries.push(e);
  }

  types(): JournalType[] {
    return this.entries.map((e) => e.type);
  }

  ofType(type: JournalType): JournalEntry[] {
    return this.entries.filter((e) => e.type === type);
  }
}
```

```ts
// apps/api/src/modules/trade-core/market/core-candles.ts
import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { HubCandle, Timeframe } from '../../market-hub/candles/candle.types';
import { HUB_CANDLE_SOURCE, type HubCandleSource } from '../../market-hub/hub-candle-source';
import type { InstrumentRef } from '../../market-hub/hub.types';

export type CandleRead = { ok: true; candles: HubCandle[]; complete: boolean } | { ok: false; reason: string };

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Ruling J7: the core reads candles only from the hub's CandleStore (one cache, one pacing gate),
 * reached lazily as the market-data controller does. Every failure is a reason, never a throw.
 */
@Injectable()
export class CoreCandles {
  constructor(private readonly moduleRef: ModuleRef) {}

  async read(ref: InstrumentRef, timeframe: Timeframe, from: Date, to: Date): Promise<CandleRead> {
    let source: HubCandleSource | null;
    try {
      source = this.moduleRef.get<HubCandleSource>(HUB_CANDLE_SOURCE, { strict: false }) ?? null;
    } catch (err) {
      return { ok: false, reason: errorText(err) };
    }
    try {
      if (!source || !source.servesCharts()) return { ok: false, reason: 'hub candles are off (HUB_CANDLES_ENABLED / HUB_SERVES_CHARTS)' };
      const r = await source.candles(ref, timeframe, from, to);
      return { ok: true, candles: r.candles, complete: r.incomplete.length === 0 };
    } catch (err) {
      return { ok: false, reason: errorText(err) };
    }
  }
}
```

Add to `CorePositionRepository` (after `listForUser`):

```ts
  /** M5 cooldown (J5): when this strategy last opened (first fill) a position on the token. */
  async lastOpenedAt(userId: string, strategyId: string, token: string): Promise<Date | null> {
    const r = await this.prisma.corePosition.findFirst({
      where: { userId, strategyId, token, openedAt: { not: null } },
      orderBy: { openedAt: 'desc' },
      select: { openedAt: true },
    });
    return r?.openedAt ?? null;
  }

  /** M5 last-loss filter (J5): this strategy's CLOSED positions on the token closed since `since`, newest close first. */
  async listClosedSince(userId: string, strategyId: string, token: string, since: Date): Promise<CorePosition[]> {
    const rows = await this.prisma.corePosition.findMany({
      where: { userId, strategyId, token, status: 'CLOSED', closedAt: { gte: since } },
      orderBy: [{ closedAt: 'desc' }, { id: 'desc' }],
    });
    return rows.map(toCorePosition);
  }

  /** M5 reconciliation system scan: users with an active position, or one created or closed since `since`. */
  async listUserIdsSince(since: Date): Promise<string[]> {
    const rows = await this.withoutTenant(() =>
      this.prisma.corePosition.findMany({
        where: { OR: [{ status: { in: [...ACTIVE_STATUSES] } }, { createdAt: { gte: since } }, { closedAt: { gte: since } }] },
        select: { userId: true },
        distinct: ['userId'],
        orderBy: { userId: 'asc' },
      }),
    );
    return rows.map((r) => r.userId);
  }
```

Add to `MemoryPositionStore.repo` (beside `listForUser`; `copy`, `isActiveStatus` are already in that file):

```ts
    lastOpenedAt: async (userId: string, strategyId: string, token: string) => {
      const opened = this.rows
        .filter((p) => p.userId === userId && p.strategyId === strategyId && p.instrument.token === token && p.openedAt !== null)
        .map((p) => (p.openedAt as Date).getTime());
      return opened.length ? new Date(Math.max(...opened)) : null;
    },
    listClosedSince: async (userId: string, strategyId: string, token: string, since: Date) =>
      this.rows
        .filter((p) => p.userId === userId && p.strategyId === strategyId && p.instrument.token === token && p.status === 'CLOSED' && p.closedAt !== null && p.closedAt.getTime() >= since.getTime())
        .sort((a, b) => (b.closedAt as Date).getTime() - (a.closedAt as Date).getTime())
        .map(copy),
    listUserIdsSince: async (since: Date) =>
      [
        ...new Set(
          this.rows
            .filter((p) => isActiveStatus(p.status) || p.createdAt.getTime() >= since.getTime() || (p.closedAt !== null && p.closedAt.getTime() >= since.getTime()))
            .map((p) => p.userId),
        ),
      ].sort(),
```

Add to `core-strategy-selection.repository.ts` (with `import type { StrategyBlocks } from '../blocks/block-types';`):

```ts
/** One live selection for the M5 intake (M1 note: live = enabled AND its version is PAPER). */
export interface LiveSelection {
  userId: string;
  strategyId: string;
  strategyKey: string;
  strategyVersionId: string;
  blocks: StrategyBlocks;
  /** Exact rupees; journaled, not enforced in M5 (O8). */
  capitalAllocation: string;
}
```

and the method:

```ts
  /**
   * M5 intake system scan (ruling J24): every user's enabled selection whose version is PAPER. Called
   * from the Chartink worker, outside any request, so the tenant extension does not scope it.
   */
  async listEnabledPaper(): Promise<LiveSelection[]> {
    const rows = await this.prisma.coreStrategySelection.findMany({
      where: { enabled: true, strategyVersion: { status: 'PAPER' } },
      include: { strategy: true, strategyVersion: true },
      orderBy: [{ userId: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map((r) => ({
      userId: r.userId,
      strategyId: r.strategyId,
      strategyKey: r.strategy.key,
      strategyVersionId: r.strategyVersionId,
      blocks: r.strategyVersion.blocks as unknown as StrategyBlocks,
      capitalAllocation: r.capitalAllocation.toFixed(2),
    }));
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && npx jest src/modules/trade-core/journal src/modules/trade-core/market src/modules/trade-core/strategies src/modules/trade-core/lifecycle`
Expected: PASS (new tests green; every M1/M4 test unchanged and green).

- [ ] **Step 5: Commit**

```bash
git add -- apps/api/src/modules/trade-core/journal/repositories apps/api/src/modules/trade-core/journal/testing/memory-journal-store.ts apps/api/src/modules/trade-core/journal/testing/memory-journal-store.spec.ts apps/api/src/modules/trade-core/journal/testing/fake-journal.ts apps/api/src/modules/trade-core/market apps/api/src/modules/trade-core/strategies/repositories/core-strategy-selection.repository.spec.ts
git commit -m "feat(trade-core): M5 journal and summary repositories, hub candle reader, intake and recon scans" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/api/src/modules/trade-core/journal/repositories apps/api/src/modules/trade-core/journal/testing/memory-journal-store.ts apps/api/src/modules/trade-core/journal/testing/memory-journal-store.spec.ts apps/api/src/modules/trade-core/journal/testing/fake-journal.ts apps/api/src/modules/trade-core/market apps/api/src/modules/trade-core/lifecycle/repositories/core-position.repository.ts apps/api/src/modules/trade-core/lifecycle/testing/memory-position-store.ts apps/api/src/modules/trade-core/lifecycle/testing/memory-position-store.spec.ts apps/api/src/modules/trade-core/strategies/repositories/core-strategy-selection.repository.ts apps/api/src/modules/trade-core/strategies/repositories/core-strategy-selection.repository.spec.ts
```

---

### Task 3: Bounded ledger reads and the per-position reads M5 needs

**Files:**
- Modify: `apps/api/src/modules/trade-core/execution/ledger-math.ts` (`istDayStart`)
- Modify: `apps/api/src/modules/trade-core/execution/repositories/core-cash-ledger.repository.ts`
- Modify: `apps/api/src/modules/trade-core/execution/repositories/core-order.repository.ts`
- Modify: `apps/api/src/modules/trade-core/execution/paper-ledger.service.ts` (`funds`, `dayStats`, `netPnlTodayByPosition`; four new reads)
- Modify: `apps/api/src/modules/trade-core/execution/testing/memory-paper-store.ts`
- Test: `apps/api/src/modules/trade-core/execution/paper-ledger.reads.spec.ts`
- Modify: `apps/api/test/sp2-m5/journal.int.spec.ts` (SQL parity `describe`)

**Interfaces:**
- Consumes: M3 `balances`, `heldMargin`, `ZERO`, `istDate`; M4 `lifecycleHarness`, `openRequest`.
- Produces: `istDayStart(at): Date`; `PaperLedgerService.ledgerRowsForPosition(userId, orderIds, token, fromDay, toDay): Promise<LedgerEntry[]>`;
  `fillsFor(userId, orderIds): Promise<FillRow[]>`; `marginByOrder(userId, orderIds): Promise<Map<string, Prisma.Decimal>>`;
  `interestTokensOn(userId, day): Promise<Set<string>>`. `funds`, `dayStats`, `netPnlTodayByPosition` keep their
  signatures and results.

- [ ] **Step 1: Write the failing parity tests**

```ts
// apps/api/src/modules/trade-core/execution/paper-ledger.reads.spec.ts
import { Prisma } from '@prisma/client';
import { NOW } from '../lifecycle/testing/lifecycle-fixtures';
import { lifecycleHarness, openRequest } from '../lifecycle/testing/lifecycle-harness';
import { balances, istDate, istDayStart, ZERO } from './ledger-math';
import { heldMargin } from './paper-ledger.service';

beforeEach(() => jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] }));
afterEach(() => jest.useRealTimers());

const INFY = { exchange: 'NSE', token: '1594', symbol: 'INFY-EQ', lotSize: 1, underlying: null };

/** A closed RELIANCE trade (fill 500, exit at the 3 % target 515) and an open INFY position: real M3 ledger rows. */
async function tradedDay() {
  const h = lifecycleHarness();
  const closed = await h.lifecycle.openPosition(openRequest());
  await h.price(500); // fills the entry (the first fresh price after submission)
  await h.price(515); // the target is hit: the lifecycle places the exit
  await h.price(515); // fills the exit
  const open = await h.lifecycle.openPosition(openRequest({ instrument: INFY }, { intentId: 'int_2', symbol: 'INFY-EQ', underlying: 'INFY' }));
  await h.price(1500, { token: '1594', symbol: 'INFY-EQ' });
  return { h, closed, open };
}

describe('bounded ledger reads (ruling J19) equal the full-history ones', () => {
  it('istDayStart is IST midnight', () => {
    expect(istDayStart(new Date('2026-10-13T05:00:00.000Z')).toISOString()).toBe('2026-10-12T18:30:00.000Z');
  });

  it('funds from the aggregates equals balances() over every row, deployed margin per vehicle included', async () => {
    const { h } = await tradedDay();
    const all = h.paper.ledger.filter((r) => r.userId === 'user_A');
    const b = balances(all);
    const f = await h.ledger.funds('user_A');
    expect(f.cash).toBe(b.cash.toFixed(2));
    expect(f.blockedMargin).toBe(b.blockedMargin.toFixed(2));
    expect(f.realisedPnl).toBe(b.realisedPnl.toFixed(2));
    const vehicleOf = new Map(h.paper.orders.map((o) => [o.id, o.vehicle]));
    expect(f.deployedByVehicle.CASH_INTRADAY).toBe(heldMargin(all, (r) => r.orderId !== null && vehicleOf.get(r.orderId) === 'CASH_INTRADAY').toFixed(2));
  });

  it("dayStats and per-position P&L ignore rows before today's IST midnight", async () => {
    const { h } = await tradedDay();
    const before = await h.ledger.dayStats('user_A', new Date());
    const template = h.paper.ledger[h.paper.ledger.length - 1];
    h.paper.ledger.push({ ...template, id: 'led_old', type: 'REALISED_PNL', amount: new Prisma.Decimal('-999.00'), createdAt: new Date(istDayStart(new Date()).getTime() - 1) });
    const after = await h.ledger.dayStats('user_A', new Date());
    expect(after.netPnlToday.toFixed(2)).toBe(before.netPnlToday.toFixed(2));
    expect(after.entriesToday).toBe(2);
    // No MTF interest today, so the per-position nets (realised + charges) add up to the day's net.
    const perPosition = [...(await h.ledger.netPnlTodayByPosition('user_A', new Date())).values()].reduce((a, v) => a.plus(v), ZERO);
    expect(perPosition.toFixed(2)).toBe(before.netPnlToday.toFixed(2));
  });

  it("per-position reads: the position's ledger rows, its fills, margin per order, today's interest tokens", async () => {
    const { h, closed, open } = await tradedDay();
    const ids = h.ordersOf(closed.id).map((o) => o.id);
    const rows = await h.ledger.ledgerRowsForPosition('user_A', ids, '2885', istDate(new Date()), istDate(new Date()));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.orderId !== null && ids.includes(r.orderId))).toBe(true);
    expect(rows.some((r) => r.type === 'REALISED_PNL')).toBe(true);
    expect((await h.ledger.fillsFor('user_A', ids)).reduce((n, f) => n + f.qty, 0)).toBe(200);
    const openIds = h.ordersOf(open.id).map((o) => o.id);
    const margin = await h.ledger.marginByOrder('user_A', [...ids, ...openIds]);
    for (const id of ids) expect((margin.get(id) ?? ZERO).toFixed(2)).toBe('0.00');
    expect((margin.get(openIds[0]) ?? ZERO).gt(0)).toBe(true);
    expect(await h.ledger.interestTokensOn('user_A', istDate(new Date()))).toEqual(new Set());
  });
});
```

(The open-position read depends on the harness's INFY fill at 1500 and the default `paperSettings()`; the RELIANCE
expectations mirror the M4 e2e: 100 bought at 500 and 100 sold at the 515 target — an order fills on the first fresh price
**after** it is placed, hence the second 515 — and `entriesToday` is 2 across both.)

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx jest src/modules/trade-core/execution/paper-ledger.reads.spec.ts`
Expected: FAIL — `istDayStart is not a function` / `ledgerRowsForPosition is not a function`.

- [ ] **Step 3: Implement**

`ledger-math.ts`, after `istDate`:

```ts
/** IST midnight of `at`'s IST day (M5 ruling J19: day-bounded reads). */
export function istDayStart(at: Date): Date {
  return new Date(`${istDate(at)}T00:00:00.000+05:30`);
}
```

`CoreCashLedgerRepository` — change the first import to `import { Prisma, type CoreCashLedger as CoreCashLedgerRow } from '@prisma/client';`
and add after `listForUser`:

```ts
  /** M5 (J19): rows created at or after `since`. */
  async listForUserSince(userId: string, since: Date, db: PaperDb = this.prisma): Promise<LedgerEntry[]> {
    return (await db.coreCashLedger.findMany({ where: { userId, createdAt: { gte: since } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })).map(toEntry);
  }

  async listForOrders(userId: string, orderIds: readonly string[], db: PaperDb = this.prisma): Promise<LedgerEntry[]> {
    if (orderIds.length === 0) return [];
    return (await db.coreCashLedger.findMany({ where: { userId, orderId: { in: [...orderIds] } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })).map(toEntry);
  }

  /** MTF_INTEREST rows on `token` for interest days in [fromDay, toDay]. */
  async listInterest(userId: string, token: string, fromDay: string, toDay: string, db: PaperDb = this.prisma): Promise<LedgerEntry[]> {
    const rows = await db.coreCashLedger.findMany({
      where: { userId, token, type: 'MTF_INTEREST', interestDate: { gte: new Date(`${fromDay}T00:00:00.000Z`), lte: new Date(`${toDay}T00:00:00.000Z`) } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map(toEntry);
  }

  async interestTokensOn(userId: string, day: string): Promise<Set<string>> {
    const rows = await this.prisma.coreCashLedger.findMany({ where: { userId, type: 'MTF_INTEREST', interestDate: new Date(`${day}T00:00:00.000Z`) }, select: { token: true } });
    return new Set(rows.map((r) => r.token).filter((t): t is string => t !== null));
  }

  /** M5 (J19): Σ amount per type over the user's whole ledger, in SQL. */
  async sumsByType(userId: string): Promise<Array<{ type: LedgerType; amount: Prisma.Decimal }>> {
    const rows = await this.prisma.$queryRaw<Array<{ type: string; amount: Prisma.Decimal | string }>>`
      SELECT "type" AS "type", SUM("amount") AS "amount" FROM "core_cash_ledger" WHERE "userId" = ${userId} GROUP BY "type"`;
    return rows.map((r) => ({ type: r.type as LedgerType, amount: new Prisma.Decimal(r.amount) }));
  }

  /** M5 (J19): margin still held (−Σ MARGIN_BLOCK + MARGIN_RELEASE) per vehicle of the orders, in SQL. */
  async heldMarginByVehicle(userId: string): Promise<Map<string, Prisma.Decimal>> {
    const rows = await this.prisma.$queryRaw<Array<{ vehicle: string; held: Prisma.Decimal | string }>>`
      SELECT o."vehicle" AS "vehicle", -SUM(l."amount") AS "held"
      FROM "core_cash_ledger" l JOIN "core_orders" o ON o."id" = l."orderId"
      WHERE l."userId" = ${userId} AND l."type" IN ('MARGIN_BLOCK', 'MARGIN_RELEASE')
      GROUP BY o."vehicle"`;
    return new Map(rows.map((r) => [r.vehicle, new Prisma.Decimal(r.held)]));
  }
```

`CoreOrderRepository`, after `listForUser` (`toOrder` stands for the file's existing row mapper — use its real name):

```ts
  /** M5 (J19): orders submitted at or after `since`. */
  async listForUserSince(userId: string, since: Date, db: PaperDb = this.prisma): Promise<CoreOrder[]> {
    return (await db.coreOrder.findMany({ where: { userId, submittedAt: { gte: since } }, orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }] })).map(toOrder);
  }

  async listByIds(userId: string, ids: readonly string[], db: PaperDb = this.prisma): Promise<CoreOrder[]> {
    if (ids.length === 0) return [];
    return (await db.coreOrder.findMany({ where: { userId, id: { in: [...ids] } } })).map(toOrder);
  }
```

`PaperLedgerService` — add `istDayStart` to the `./ledger-math` import and `FillRow` to the `./repositories/core-fill.repository`
import; replace `funds`, `dayStats`, `netPnlTodayByPosition`; add four reads:

```ts
  async funds(userId: string): Promise<CoreFunds> {
    const [sums, held] = await Promise.all([this.ledger.sumsByType(userId), this.ledger.heldMarginByVehicle(userId)]);
    const b = balances(sums);
    const deployedByVehicle = Object.fromEntries(VEHICLES.map((v) => [v, (held.get(v) ?? ZERO).toFixed(2)])) as Record<Vehicle, string>;
    return {
      userId,
      deposited: b.deposited.toFixed(2),
      realisedPnl: b.realisedPnl.toFixed(2),
      charges: b.charges.toFixed(2),
      mtfInterest: b.mtfInterest.toFixed(2),
      cash: b.cash.toFixed(2),
      blockedMargin: b.blockedMargin.toFixed(2),
      freeCash: b.freeCash.toFixed(2),
      deployedByVehicle,
    };
  }

  /** Today's (IST) net realised P&L (realised − charges − interest) and accepted entries, for the Risk Wall. Day-bounded (J19). */
  async dayStats(userId: string, now: Date): Promise<{ netPnlToday: Dec; entriesToday: number }> {
    const since = istDayStart(now);
    const [rows, orders] = await Promise.all([this.ledger.listForUserSince(userId, since), this.orders.listForUserSince(userId, since)]);
    const netPnlToday = rows
      .filter((r) => r.type === 'REALISED_PNL' || r.type === 'CHARGES' || r.type === 'MTF_INTEREST')
      .reduce((a, r) => a.plus(r.amount), ZERO);
    const entriesToday = orders.filter((o) => o.purpose === 'ENTRY' && o.state !== 'REJECTED').length;
    return { netPnlToday, entriesToday };
  }

  /** SP2 M4/M5: today's (IST) net realised P&L per core position, from today's rows only (J19). */
  async netPnlTodayByPosition(userId: string, now: Date): Promise<Map<string, Dec>> {
    const rows = (await this.ledger.listForUserSince(userId, istDayStart(now))).filter(
      (r) => (r.type === 'REALISED_PNL' || r.type === 'CHARGES') && r.orderId !== null,
    );
    const orders = await this.orders.listByIds(userId, [...new Set(rows.map((r) => r.orderId as string))]);
    const positionOf = new Map(orders.filter((o) => o.positionId).map((o) => [o.id, o.positionId as string]));
    const out = new Map<string, Dec>();
    for (const r of rows) {
      const pid = positionOf.get(r.orderId as string);
      if (pid) out.set(pid, (out.get(pid) ?? ZERO).plus(r.amount));
    }
    return out;
  }

  /** M5 summaries (J16): the ledger rows of a position's orders plus MTF interest on its token over [fromDay, toDay]. */
  async ledgerRowsForPosition(userId: string, orderIds: readonly string[], token: string, fromDay: string, toDay: string): Promise<LedgerEntry[]> {
    const [own, interest] = await Promise.all([this.ledger.listForOrders(userId, orderIds), this.ledger.listInterest(userId, token, fromDay, toDay)]);
    return [...own, ...interest];
  }

  /** M5 journal and reconciliation: the fills of these orders. */
  async fillsFor(userId: string, orderIds: readonly string[]): Promise<FillRow[]> {
    return this.fills.listForOrders(userId, orderIds);
  }

  /** M5 reconciliation (J17): margin each order still holds (−Σ of its MARGIN_* rows). */
  async marginByOrder(userId: string, orderIds: readonly string[]): Promise<Map<string, Dec>> {
    const rows = await this.ledger.listForOrders(userId, orderIds);
    return new Map(orderIds.map((id) => [id, heldMargin(rows, (r) => r.orderId === id)]));
  }

  /** M5 nightly reconciliation: tokens with an MTF_INTEREST row for `day`. */
  async interestTokensOn(userId: string, day: string): Promise<Set<string>> {
    return this.ledger.interestTokensOn(userId, day);
  }
```

(Before: `entriesToday` filtered `istDate(o.submittedAt) === day`; `listForUserSince` now does that bound in the query. If
`dayStats` was the only user of `istDate` in that file, drop it from the import.)

`MemoryPaperStore` (import `Prisma` from `@prisma/client` and `LedgerType` from `../execution.types` if absent) — add to
`orderRepo`:

```ts
    listForUserSince: async (userId: string, since: Date, db?: PaperDb) => {
      this.read('listForUserSince', db);
      return this.orders.filter((o) => o.userId === userId && o.submittedAt.getTime() >= since.getTime()).map(copy);
    },
    listByIds: async (userId: string, ids: readonly string[], db?: PaperDb) => {
      this.read('listByIds', db);
      return this.orders.filter((o) => o.userId === userId && ids.includes(o.id)).map(copy);
    },
```

and to `ledgerRepo`:

```ts
    listForUserSince: async (userId: string, since: Date, db?: PaperDb) => {
      this.read('ledger listForUserSince', db);
      return this.ledger.filter((r) => r.userId === userId && r.createdAt.getTime() >= since.getTime()).map(copyEntry);
    },
    listForOrders: async (userId: string, orderIds: readonly string[], db?: PaperDb) => {
      this.read('ledger listForOrders', db);
      return this.ledger.filter((r) => r.userId === userId && r.orderId !== null && orderIds.includes(r.orderId)).map(copyEntry);
    },
    listInterest: async (userId: string, token: string, fromDay: string, toDay: string, db?: PaperDb) => {
      this.read('ledger listInterest', db);
      return this.ledger
        .filter((r) => r.userId === userId && r.type === 'MTF_INTEREST' && r.token === token && r.interestDate !== null && r.interestDate >= fromDay && r.interestDate <= toDay)
        .map(copyEntry);
    },
    interestTokensOn: async (userId: string, day: string) =>
      new Set(this.ledger.filter((r) => r.userId === userId && r.type === 'MTF_INTEREST' && r.interestDate === day && r.token !== null).map((r) => r.token as string)),
    sumsByType: async (userId: string) => {
      const sums = new Map<LedgerType, Prisma.Decimal>();
      for (const r of this.ledger.filter((x) => x.userId === userId)) sums.set(r.type, (sums.get(r.type) ?? new Prisma.Decimal(0)).plus(r.amount));
      return [...sums].map(([type, amount]) => ({ type, amount }));
    },
    heldMarginByVehicle: async (userId: string) => {
      const vehicleOf = new Map(this.orders.map((o) => [o.id, o.vehicle]));
      const held = new Map<string, Prisma.Decimal>();
      for (const r of this.ledger.filter((x) => x.userId === userId && (x.type === 'MARGIN_BLOCK' || x.type === 'MARGIN_RELEASE') && x.orderId !== null)) {
        const v = vehicleOf.get(r.orderId as string);
        if (v) held.set(v, (held.get(v) ?? new Prisma.Decimal(0)).minus(r.amount));
      }
      return held;
    },
```

Append to `apps/api/test/sp2-m5/journal.int.spec.ts` (imports at the top of the file):

```ts
import type { PrismaService } from '../../src/common/prisma/prisma.service';
import { balances } from '../../src/modules/trade-core/execution/ledger-math';
import { CoreCashLedgerRepository } from '../../src/modules/trade-core/execution/repositories/core-cash-ledger.repository';

describe('bounded ledger reads (J19) against SQL', () => {
  it('sumsByType through balances() equals balances() over every row; held margin per vehicle', async () => {
    const u = await newUser();
    const ord = `ord_${rid()}`;
    await db.$executeRawUnsafe(
      `INSERT INTO "core_orders" ("id", "userId", "idempotencyKey", "vehicle", "exchange", "token", "symbol", "lotSize", "side", "qty", "type", "refPrice", "purpose", "state", "updatedAt")
       VALUES ($1, $2, $1, 'CASH_INTRADAY', 'NSE', '2885', 'RELIANCE-EQ', 1, 'BUY', 10, 'MARKET', 500, 'ENTRY', 'CANCELLED', CURRENT_TIMESTAMP)`,
      ord, u,
    );
    for (const [type, amount, orderId] of [['DEPOSIT', '1000000.00', null], ['MARGIN_BLOCK', '-1000.00', ord], ['MARGIN_RELEASE', '1000.00', ord]] as const) {
      await db.$executeRawUnsafe(
        `INSERT INTO "core_cash_ledger" ("id", "userId", "type", "amount", "orderId", "note") VALUES ($1, $2, $3, $4::numeric, $5, 'it')`,
        `led_${rid()}`, u, type, amount, orderId,
      );
    }
    const repo = new CoreCashLedgerRepository(db as unknown as PrismaService);
    const full = balances(await repo.listForUser(u));
    const agg = balances(await repo.sumsByType(u));
    expect(agg.cash.toFixed(2)).toBe(full.cash.toFixed(2));
    expect(agg.blockedMargin.toFixed(2)).toBe(full.blockedMargin.toFixed(2));
    expect((await repo.heldMarginByVehicle(u)).get('CASH_INTRADAY')?.toFixed(2)).toBe('0.00');
  });
});
```

(Margin rows only: the M3 link CHECK requires a `fillId` on `REALISED_PNL`/`CHARGES`, which this SQL parity case avoids. If the
`core_orders` insert misses a NOT NULL column, copy the column list from `20261011120000_sp2_m3_execution/migration.sql`.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && npx jest src/modules/trade-core`
Expected: PASS — the new parity spec and every M3/M4 spec (the M4 e2e asserts `realisedPnl '375.00'` and per-position net
through these same methods).

- [ ] **Step 5: Commit**

```bash
git add -- apps/api/src/modules/trade-core/execution/paper-ledger.reads.spec.ts
git commit -m "perf(trade-core): day-bounded and aggregate ledger reads; per-position reads for M5" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/api/src/modules/trade-core/execution/ledger-math.ts apps/api/src/modules/trade-core/execution/repositories/core-cash-ledger.repository.ts apps/api/src/modules/trade-core/execution/repositories/core-order.repository.ts apps/api/src/modules/trade-core/execution/paper-ledger.service.ts apps/api/src/modules/trade-core/execution/testing/memory-paper-store.ts apps/api/src/modules/trade-core/execution/paper-ledger.reads.spec.ts apps/api/test/sp2-m5/journal.int.spec.ts
```

---

## Stream B — the intake (Chartink fan-out)

### Task 4: The hand-off registry and the pure entry rules

**Files:**
- Create: `apps/api/src/modules/trade-core/intake/alert-handoff.ts`
- Test: `apps/api/src/modules/trade-core/intake/alert-handoff.spec.ts`
- Create: `apps/api/src/modules/trade-core/intake/entry-rules.ts`
- Test: `apps/api/src/modules/trade-core/intake/entry-rules.spec.ts`
- Create: `apps/api/src/modules/trade-core/intake/testing/intake-fixtures.ts`

**Interfaces:**
- Consumes: `StrategyBlocks`, `EntryBlock`, `FiltersBlock`, `MinScore`, `SizingBlock` (`strategies/blocks/block-types.ts`);
  `round2` (`lifecycle/exit-plan.ts`); `istDate`; block fixtures `adaptiveBlocks`, `plainBlocks`.
- Produces:
  - `ChartinkHit { alertId; symbol (bare, as Chartink sends it); tradingSymbol; token; exchange: 'NSE'; hitPrice; scanName: string | null; side: 'BUY' | 'SELL'; score; receivedAt: Date }`;
    `CoreAlertIntake { accept(hit): void }`; `setCoreAlertIntake(next | null)`; `currentCoreAlertIntake()`; `handOffChartinkHit(hit): void`.
  - `istMinutes(at)`, `minScoreAt(minScore, at)`, `scanMatches(entry, scanName)`, `matchEntry(blocks, hit, at): EntryMatch`
    (`{ kind: 'NOT_MINE' } | { kind: 'SKIP'; reason: 'MIN_SCORE' | 'VEHICLE_UNSUPPORTED'; detail } | { kind: 'CANDIDATE' }`),
    `staleMovePct(side, alertPrice, live)`, `staleEntryFails(filter, side, alertPrice, live)`, `cooldownActive(filter, lastOpenedAt, now)`,
    `lastLossVerdict(filter, last): 'PASS' | 'BLOCK' | 'UNKNOWN'`, `stopPriceFor(side, ref, stopPct)`, `sizeQty(sizing, ref, stop, lotSize)`,
    `intentIdFor(userId, strategyId, alertId, token)`, `setupGroupKey(alertId, symbol, at)`.
  - Fixtures: `hit(over)`, `adaptiveSeedBlocks()` (the M1 seed JSON, full gate params), `ist(day, hhmm)`.

- [ ] **Step 1: Write the fixtures and the failing tests**

```ts
// apps/api/src/modules/trade-core/intake/testing/intake-fixtures.ts
import type { StrategyBlocks } from '../../strategies/blocks/block-types';
import { plainBlocks } from '../../strategies/testing/block-fixtures';
import type { ChartinkHit } from '../alert-handoff';

/** IST wall-clock → Date (test data). */
export const ist = (day: string, hhmm: string): Date => new Date(`${day}T${hhmm}:00.000+05:30`);

/** Tue 2026-10-13 10:30 IST, a Hull scan BUY on RELIANCE at 500, score 70. */
export function hit(over: Partial<ChartinkHit> = {}): ChartinkHit {
  return {
    alertId: 'alert_1',
    symbol: 'RELIANCE',
    tradingSymbol: 'RELIANCE-EQ',
    token: '2885',
    exchange: 'NSE',
    hitPrice: 500,
    scanName: 'Hull MA cross 15m',
    side: 'BUY',
    score: 70,
    receivedAt: ist('2026-10-13', '10:30'),
    ...over,
  };
}

/** Exactly the M1 seed csv_adaptive_stop_v1 blocks (20261009120000_sp2_m1_strategy_catalogue), full gate params. */
export function adaptiveSeedBlocks(): StrategyBlocks {
  return {
    entry: { kind: 'chartink', scanName: null, match: 'ANY', side: 'BUY', minScore: { base: 47, windows: [{ fromHhmm: '11:45', toHhmm: '14:00', score: 75 }] } },
    filters: {
      staleEntry: { maxMovePct: 1 },
      cooldown: { minutes: 45 },
      lastLoss: { window: 'SAME_IST_DAY' },
      gates: [
        {
          kind: 'evaluator',
          evaluatorKey: 'adaptive-stop-decision-gate',
          params: { nearSupportPct: 0.6, rsiHot: 70, vwapExtPct: 1.5, requireMacdBullish: true, srLookbackDays: 5, minCandles: 10, minSameDayCandles: 3, failOpen: true },
        },
      ],
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

export { plainBlocks };
```

```ts
// apps/api/src/modules/trade-core/intake/alert-handoff.spec.ts
import { currentCoreAlertIntake, handOffChartinkHit, setCoreAlertIntake } from './alert-handoff';
import { hit } from './testing/intake-fixtures';

afterEach(() => setCoreAlertIntake(null));

describe('handOffChartinkHit (ruling J2)', () => {
  it('does nothing when no intake is registered (entries off)', () => {
    expect(currentCoreAlertIntake()).toBeNull();
    expect(() => handOffChartinkHit(hit())).not.toThrow();
  });

  it('hands the hit to the registered intake, synchronously', () => {
    const accept = jest.fn();
    setCoreAlertIntake({ accept });
    handOffChartinkHit(hit());
    expect(accept).toHaveBeenCalledWith(hit());
  });

  it('never throws, even when the intake does', () => {
    setCoreAlertIntake({ accept: () => { throw new Error('core broke'); } });
    expect(() => handOffChartinkHit(hit())).not.toThrow();
  });
});
```

```ts
// apps/api/src/modules/trade-core/intake/entry-rules.spec.ts
import { adaptiveBlocks, plainBlocks } from '../strategies/testing/block-fixtures';
import { optionBlocks } from '../lifecycle/testing/lifecycle-fixtures';
import {
  cooldownActive, intentIdFor, istMinutes, lastLossVerdict, matchEntry, minScoreAt, scanMatches, setupGroupKey,
  sizeQty, staleEntryFails, staleMovePct, stopPriceFor,
} from './entry-rules';
import { hit, ist } from './testing/intake-fixtures';

const D = '2026-10-13';

describe('entry match (spec §4.1 entry.chartink; M1 minScore semantics)', () => {
  it('IST minutes of the day', () => {
    expect(istMinutes(ist(D, '11:45'))).toBe(705);
    expect(istMinutes(ist(D, '00:00'))).toBe(0);
  });

  it("minScore: a window's score replaces base inside [from, to); base outside; null means no gate", () => {
    const entry = adaptiveBlocks().entry;
    const m = entry.kind === 'chartink' ? entry.minScore : null;
    expect(minScoreAt(m, ist(D, '10:30'))).toBe(47);
    expect(minScoreAt(m, ist(D, '11:45'))).toBe(75);
    expect(minScoreAt(m, ist(D, '13:59'))).toBe(75);
    expect(minScoreAt(m, ist(D, '14:00'))).toBe(47);
    expect(minScoreAt(null, ist(D, '12:00'))).toBeNull();
  });

  it('scan match: ANY, EXACT and CONTAINS compare case-insensitively; no scan name never matches a named rule', () => {
    const contains = { kind: 'chartink' as const, scanName: 'hull', match: 'CONTAINS' as const, side: 'BUY' as const, minScore: null };
    expect(scanMatches(contains, 'Hull MA cross 15m')).toBe(true);
    expect(scanMatches(contains, 'EMA breakout')).toBe(false);
    expect(scanMatches(contains, null)).toBe(false);
    expect(scanMatches({ ...contains, match: 'EXACT', scanName: 'Hull MA cross 15m' }, 'hull ma cross 15m')).toBe(true);
    expect(scanMatches({ ...contains, match: 'ANY', scanName: null }, null)).toBe(true);
  });

  it('a hit that is not the strategy’s (scan or side) is NOT_MINE; an evaluator entry never matches Chartink (O5)', () => {
    expect(matchEntry(plainBlocks(), hit({ scanName: 'EMA breakout' }), ist(D, '10:30'))).toEqual({ kind: 'NOT_MINE' });
    expect(matchEntry(plainBlocks(), hit({ side: 'SELL' }), ist(D, '10:30'))).toEqual({ kind: 'NOT_MINE' });
    const evaluator = { ...plainBlocks(), entry: { kind: 'evaluator' as const, evaluatorKey: 'zone-reversal', params: {}, side: 'BOTH' as const } };
    expect(matchEntry(evaluator, hit(), ist(D, '10:30'))).toEqual({ kind: 'NOT_MINE' });
  });

  it('OPTIONS_BUY is VEHICLE_UNSUPPORTED (O4); a low score is MIN_SCORE; otherwise a CANDIDATE', () => {
    const opt = { ...optionBlocks(), entry: plainBlocks().entry };
    expect(matchEntry(opt, hit(), ist(D, '10:30'))).toMatchObject({ kind: 'SKIP', reason: 'VEHICLE_UNSUPPORTED' });
    expect(matchEntry(adaptiveBlocks(), hit({ scanName: 'anything', score: 70 }), ist(D, '12:00'))).toEqual({ kind: 'SKIP', reason: 'MIN_SCORE', detail: 'score 70 below 75 (11:45-14:00 IST window)' });
    expect(matchEntry(adaptiveBlocks(), hit({ score: 46 }), ist(D, '10:30'))).toEqual({ kind: 'SKIP', reason: 'MIN_SCORE', detail: 'score 46 below 47' });
    expect(matchEntry(adaptiveBlocks(), hit({ score: 47 }), ist(D, '10:30'))).toEqual({ kind: 'CANDIDATE' });
    expect(matchEntry(plainBlocks(), hit({ score: 0 }), ist(D, '12:00'))).toEqual({ kind: 'CANDIDATE' });
  });
});

describe('filters (spec §4.1 filters; the silo rules)', () => {
  it('stale entry is the move past the alert price in the trade direction, strictly over the limit', () => {
    expect(staleMovePct('BUY', 100, 101.5)).toBeCloseTo(1.5);
    expect(staleMovePct('SELL', 100, 98.9)).toBeCloseTo(1.1);
    expect(staleEntryFails({ maxMovePct: 1 }, 'BUY', 100, 101)).toBe(false);
    expect(staleEntryFails({ maxMovePct: 1 }, 'BUY', 100, 101.01)).toBe(true);
    expect(staleEntryFails({ maxMovePct: 1 }, 'SELL', 100, 101)).toBe(false);
    expect(staleEntryFails(null, 'BUY', 100, 150)).toBe(false);
  });

  it('cooldown: active while the last open is at most `minutes` ago', () => {
    const now = ist(D, '11:00');
    expect(cooldownActive({ minutes: 45 }, ist(D, '10:15'), now)).toBe(true);
    expect(cooldownActive({ minutes: 45 }, ist(D, '10:14'), now)).toBe(false);
    expect(cooldownActive({ minutes: 45 }, null, now)).toBe(false);
    expect(cooldownActive(null, ist(D, '10:59'), now)).toBe(false);
  });

  it('last loss: net ≤ 0 blocks, unknown is UNKNOWN (fail closed), none or a win passes', () => {
    const f = { window: 'SAME_IST_DAY' as const };
    expect(lastLossVerdict(f, -0.01)).toBe('BLOCK');
    expect(lastLossVerdict(f, 0)).toBe('BLOCK');
    expect(lastLossVerdict(f, 12.5)).toBe('PASS');
    expect(lastLossVerdict(f, null)).toBe('PASS');
    expect(lastLossVerdict(f, 'UNKNOWN')).toBe('UNKNOWN');
    expect(lastLossVerdict(null, -50)).toBe('PASS');
  });
});

describe('stop, sizing and ids (ruling J8, J4)', () => {
  it('stop price from the stop % on the reference, to the paisa', () => {
    expect(stopPriceFor('BUY', 500, 1.5)).toBe(492.5);
    expect(stopPriceFor('SELL', 500, 1.5)).toBe(507.5);
    expect(stopPriceFor('BUY', 1234.56, 0.8)).toBe(1224.68);
  });

  it('riskRupees sizes by the stop distance, notionalRupees by the price, whole lots, never negative', () => {
    expect(sizeQty({ kind: 'riskRupees', amount: 800 }, 500, 494, 1)).toBe(133);
    expect(sizeQty({ kind: 'notionalRupees', amount: 200000 }, 500, 492.5, 1)).toBe(400);
    expect(sizeQty({ kind: 'notionalRupees', amount: 200000 }, 500, 492.5, 75)).toBe(375);
    expect(sizeQty({ kind: 'riskRupees', amount: 800 }, 500, 500, 1)).toBe(0);
    expect(sizeQty({ kind: 'riskRupees', amount: 3 }, 500, 494, 1)).toBe(0);
    expect(sizeQty({ kind: 'notionalRupees', amount: 1000 }, 0, 0, 1)).toBe(0);
  });

  it('the intent id is deterministic per (user, strategy, alert, token) and differs across users', () => {
    const a = intentIdFor('user_A', 'cs_x', 'alert_1', '2885');
    expect(a).toMatch(/^ci_[0-9a-f]{32}$/);
    expect(intentIdFor('user_A', 'cs_x', 'alert_1', '2885')).toBe(a);
    expect(intentIdFor('user_B', 'cs_x', 'alert_1', '2885')).not.toBe(a);
    expect(intentIdFor('user_A', 'cs_y', 'alert_1', '2885')).not.toBe(a);
  });

  it('setup group key is the legacy corpus form alertId|symbol|IST day', () => {
    expect(setupGroupKey('alert_1', 'RELIANCE', ist(D, '23:59'))).toBe('alert_1|RELIANCE|2026-10-13');
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/api && npx jest src/modules/trade-core/intake`
Expected: FAIL — `Cannot find module './alert-handoff'` / `'./entry-rules'`.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/modules/trade-core/intake/alert-handoff.ts
import { Logger } from '@nestjs/common';

/**
 * Ruling J2: how ChartinkProcessService reaches the core without importing TradeCoreModule (the
 * kill-gate pattern). This file must stay free of runtime imports beyond @nestjs/common's Logger.
 */
export interface ChartinkHit {
  alertId: string;
  /** As Chartink sent it (bare, e.g. RELIANCE): the exposure underlying. */
  symbol: string;
  /** The instrument master's trading symbol (e.g. RELIANCE-EQ): the traded symbol. */
  tradingSymbol: string;
  token: string;
  exchange: 'NSE';
  hitPrice: number;
  scanName: string | null;
  /** The silo pipeline's direction (sector trend, stock-trend fallback). */
  side: 'BUY' | 'SELL';
  /** The silo pipeline's 0–100 Chartink score. */
  score: number;
  receivedAt: Date;
}

export interface CoreAlertIntake {
  /** Queues the hit. Must not block; may throw (the hand-off swallows it). */
  accept(hit: ChartinkHit): void;
}

const logger = new Logger('CoreAlertHandoff');
let intake: CoreAlertIntake | null = null;

export function setCoreAlertIntake(next: CoreAlertIntake | null): void {
  intake = next;
}

export function currentCoreAlertIntake(): CoreAlertIntake | null {
  return intake;
}

/** Fire-and-forget: never throws, never awaits. With no intake registered (entries off) it does nothing. */
export function handOffChartinkHit(hit: ChartinkHit): void {
  const target = intake;
  if (!target) return;
  try {
    target.accept(hit);
  } catch (err) {
    logger.warn(`core intake refused ${hit.symbol} from alert ${hit.alertId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
```

```ts
// apps/api/src/modules/trade-core/intake/entry-rules.ts
import { createHash } from 'crypto';
import { istDate } from '../execution/ledger-math';
import { round2 } from '../lifecycle/exit-plan';
import type { EntryBlock, FiltersBlock, MinScore, SizingBlock, StrategyBlocks } from '../strategies/blocks/block-types';
import type { ChartinkHit } from './alert-handoff';

/** Pure entry rules for the Chartink intake (spec §4.1; rulings J4, J5, J8). */
type ChartinkEntry = Extract<EntryBlock, { kind: 'chartink' }>;

const IST_OFFSET_MIN = 330;
const hhmmMinutes = (s: string): number => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));

export function istMinutes(at: Date): number {
  return Math.floor((at.getTime() / 60_000 + IST_OFFSET_MIN) % 1440);
}

/** M1 semantics: inside a window [from, to) the window's score replaces base; null = no score gate. */
export function minScoreAt(m: MinScore | null, at: Date): number | null {
  if (!m) return null;
  const t = istMinutes(at);
  const w = m.windows.find((x) => t >= hhmmMinutes(x.fromHhmm) && t < hhmmMinutes(x.toHhmm));
  return w ? w.score : m.base;
}

export function scanMatches(e: ChartinkEntry, scanName: string | null): boolean {
  if (e.match === 'ANY') return true;
  if (scanName === null || e.scanName === null) return false;
  const have = scanName.trim().toLowerCase();
  const want = e.scanName.trim().toLowerCase();
  return e.match === 'EXACT' ? have === want : have.includes(want);
}

export type EntryMatch =
  | { kind: 'NOT_MINE' }
  | { kind: 'SKIP'; reason: 'MIN_SCORE' | 'VEHICLE_UNSUPPORTED'; detail: string }
  | { kind: 'CANDIDATE' };

const NOT_MINE: EntryMatch = { kind: 'NOT_MINE' };

/** Is this hit a setup of this strategy, and does it pass the entry block? Order: source, scan, side, vehicle, score. */
export function matchEntry(blocks: StrategyBlocks, hit: ChartinkHit, at: Date): EntryMatch {
  const e = blocks.entry;
  if (e.kind !== 'chartink') return NOT_MINE;
  if (!scanMatches(e, hit.scanName)) return NOT_MINE;
  if (e.side !== 'BOTH' && e.side !== hit.side) return NOT_MINE;
  if (blocks.vehicle.kind === 'OPTIONS_BUY') {
    return { kind: 'SKIP', reason: 'VEHICLE_UNSUPPORTED', detail: 'OPTIONS_BUY entries need the strike and expiry picker, which is not built yet (M5 O4)' };
  }
  const need = minScoreAt(e.minScore, at);
  if (need !== null && !(hit.score >= need)) {
    const inWindow = e.minScore !== null && need !== e.minScore.base;
    const w = inWindow ? e.minScore?.windows.find((x) => x.score === need) : undefined;
    return { kind: 'SKIP', reason: 'MIN_SCORE', detail: `score ${hit.score} below ${need}${w ? ` (${w.fromHhmm}-${w.toHhmm} IST window)` : ''}` };
  }
  return { kind: 'CANDIDATE' };
}

/** % the live price has moved past the alert price in the trade direction (negative = moved against it). */
export function staleMovePct(side: 'BUY' | 'SELL', alertPrice: number, live: number): number {
  if (!(alertPrice > 0)) return 0;
  const move = ((live - alertPrice) / alertPrice) * 100;
  return side === 'BUY' ? move : -move;
}

/** The silo rule: skip when the move is strictly more than maxMovePct. */
export function staleEntryFails(f: FiltersBlock['staleEntry'], side: 'BUY' | 'SELL', alertPrice: number, live: number): boolean {
  return f !== null && staleMovePct(side, alertPrice, live) > f.maxMovePct;
}

/** The silo rule: the same token was opened by this strategy at most `minutes` ago. */
export function cooldownActive(f: FiltersBlock['cooldown'], lastOpenedAt: Date | null, now: Date): boolean {
  return f !== null && lastOpenedAt !== null && now.getTime() - lastOpenedAt.getTime() <= f.minutes * 60_000;
}

/** The silo rule: today's last closed trade lost (net ≤ 0) → block; an unknown result fails closed. */
export function lastLossVerdict(f: FiltersBlock['lastLoss'], last: number | 'UNKNOWN' | null): 'PASS' | 'BLOCK' | 'UNKNOWN' {
  if (f === null || last === null) return 'PASS';
  if (last === 'UNKNOWN') return 'UNKNOWN';
  return last <= 0 ? 'BLOCK' : 'PASS';
}

export function stopPriceFor(side: 'BUY' | 'SELL', ref: number, stopPct: number): number {
  return round2(side === 'BUY' ? ref * (1 - stopPct / 100) : ref * (1 + stopPct / 100));
}

/** J8: units from the sizing block, in whole lots; the Risk Wall may only reduce it. */
export function sizeQty(s: SizingBlock, ref: number, stop: number, lotSize: number): number {
  if (!(ref > 0) || !(lotSize >= 1)) return 0;
  const dist = Math.abs(ref - stop);
  const units = s.kind === 'riskRupees' ? (dist > 0 ? s.amount / dist : 0) : s.amount / ref;
  const lots = Math.floor(units / lotSize);
  return lots > 0 ? lots * lotSize : 0;
}

/** J4: one id per (user, strategy, alert, instrument); re-processing a hit yields the same id. */
export function intentIdFor(userId: string, strategyId: string, alertId: string, token: string): string {
  return `ci_${createHash('sha256').update(`${userId}|${strategyId}|${alertId}|${token}`).digest('hex').slice(0, 32)}`;
}

/** SP3 corpus dedup key, the legacy form (SP3 spec §5.1). */
export function setupGroupKey(alertId: string, symbol: string, at: Date): string {
  return `${alertId}|${symbol}|${istDate(at)}`;
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `cd apps/api && npx jest src/modules/trade-core/intake`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -- apps/api/src/modules/trade-core/intake/alert-handoff.ts apps/api/src/modules/trade-core/intake/alert-handoff.spec.ts apps/api/src/modules/trade-core/intake/entry-rules.ts apps/api/src/modules/trade-core/intake/entry-rules.spec.ts apps/api/src/modules/trade-core/intake/testing/intake-fixtures.ts
git commit -m "feat(trade-core): M5 Chartink hand-off registry and pure entry rules" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/api/src/modules/trade-core/intake/alert-handoff.ts apps/api/src/modules/trade-core/intake/alert-handoff.spec.ts apps/api/src/modules/trade-core/intake/entry-rules.ts apps/api/src/modules/trade-core/intake/entry-rules.spec.ts apps/api/src/modules/trade-core/intake/testing/intake-fixtures.ts
```

---

### Task 5: The evaluator-gate registry (Adaptive-Stop's decision gate)

**Files:**
- Create: `apps/api/src/modules/trade-core/intake/gate-evaluators.ts`
- Test: `apps/api/src/modules/trade-core/intake/gate-evaluators.spec.ts`

**Interfaces:**
- Consumes: `evaluateDecisionGate`, `GateCandle` (`adaptive-stop-track/adaptive-stop-decision-gate.ts`, pure, wrapped not
  rewritten — spec §3); `GateRef`, `EvaluatorParams`; `HubCandle`, `Timeframe`.
- Produces: `ADAPTIVE_GATE_KEY = 'adaptive-stop-decision-gate'`; `GateContext { entryPrice: number; now: Date; candles(tf: Timeframe, days: number): Promise<HubCandle[] | null> }`;
  `GateOutcome { key; pass; skipped; reason; detail }`; `GATE_EVALUATORS: ReadonlyMap<string, GateEvaluator>`;
  `runGates(gates, ctx): Promise<{ pass: boolean; unknown: string | null; outcomes: GateOutcome[] }>`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/modules/trade-core/intake/gate-evaluators.spec.ts
import * as gate from '../../adaptive-stop-track/adaptive-stop-decision-gate';
import type { HubCandle } from '../../market-hub/candles/candle.types';
import { ADAPTIVE_GATE_KEY, runGates } from './gate-evaluators';
import { adaptiveSeedBlocks, ist } from './testing/intake-fixtures';

const NOW = ist('2026-10-13', '10:30');
const seedGate = () => adaptiveSeedBlocks().filters.gates[0];
const ctx = (candles: HubCandle[] | null) => ({ entryPrice: 500, now: NOW, candles: jest.fn().mockResolvedValue(candles) });

afterEach(() => jest.restoreAllMocks());

describe('runGates (D9, O6)', () => {
  it('an unknown evaluator key fails closed and names the key', async () => {
    const r = await runGates([{ kind: 'evaluator', evaluatorKey: 'nope', params: {} }], ctx([]));
    expect(r).toEqual({ pass: false, unknown: 'nope', outcomes: [] });
  });

  it('incomplete params fail (never a guessed default)', async () => {
    const r = await runGates([{ kind: 'evaluator', evaluatorKey: ADAPTIVE_GATE_KEY, params: { nearSupportPct: 0.6, rsiHot: 70 } }], ctx([]));
    expect(r.pass).toBe(false);
    expect(r.outcomes[0].reason).toMatch(/params incomplete/);
  });

  it('reads 15m candles over srLookbackDays and passes the seed params and the entry price through', async () => {
    const spy = jest.spyOn(gate, 'evaluateDecisionGate');
    const c = ctx([{ ts: NOW.getTime() - 3_600_000, open: 1, high: 2, low: 1, close: 2, volume: 5 }]);
    await runGates([seedGate()], c);
    expect(c.candles).toHaveBeenCalledWith('15m', 5);
    expect(spy).toHaveBeenCalledWith(500, [expect.objectContaining({ high: 2, low: 1, close: 2, volume: 5, timestamp: new Date(NOW.getTime() - 3_600_000) })], NOW.getTime(), {
      nearSupportPct: 0.6, rsiHot: 70, vwapExtPct: 1.5, requireMacdBullish: true,
    });
  });

  it('a data gap passes as skipped when the version says failOpen (the seed, silo parity) and fails otherwise', async () => {
    const open = await runGates([seedGate()], ctx(null));
    expect(open.pass).toBe(true);
    expect(open.outcomes[0]).toMatchObject({ key: ADAPTIVE_GATE_KEY, pass: true, skipped: true });
    const strict = { ...seedGate(), params: { ...seedGate().params, failOpen: false } };
    const closed = await runGates([strict], ctx(null));
    expect(closed.pass).toBe(false);
    expect(closed.outcomes[0]).toMatchObject({ pass: false, skipped: true });
    expect(closed.outcomes[0].reason).toMatch(/failOpen is false/);
  });

  it('a gate that rejects stops the chain with its reason', async () => {
    jest.spyOn(gate, 'evaluateDecisionGate').mockReturnValue({
      pass: false, skipped: false, nearSupport: false, notExtended: true, macdBullish: true, reason: 'not at support',
      detail: { nearestSupport: 480, distSupportPct: 4.1, rsi: 55, vwapExtPct: 0.2, macdHist: 0.3 },
    });
    const r = await runGates([seedGate(), seedGate()], ctx([]));
    expect(r.pass).toBe(false);
    expect(r.outcomes).toHaveLength(1);
    expect(r.outcomes[0]).toMatchObject({ pass: false, reason: 'not at support', detail: expect.objectContaining({ nearestSupport: 480 }) });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx jest src/modules/trade-core/intake/gate-evaluators.spec.ts`
Expected: FAIL — `Cannot find module './gate-evaluators'`.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/modules/trade-core/intake/gate-evaluators.ts
import * as adaptiveGate from '../../adaptive-stop-track/adaptive-stop-decision-gate';
import type { HubCandle, Timeframe } from '../../market-hub/candles/candle.types';
import type { EvaluatorParams, GateRef } from '../strategies/blocks/block-types';

/**
 * Drift D9 / O6: the named code gates a version's filters.gates may reference. Each wraps an existing
 * pure evaluator (spec §3: wrapped, not rewritten). An unknown key fails closed (GATE_UNKNOWN).
 */
export const ADAPTIVE_GATE_KEY = 'adaptive-stop-decision-gate';

export interface GateContext {
  entryPrice: number;
  now: Date;
  /** Hub candles over the last `days` calendar days, or null when unavailable. */
  candles(tf: Timeframe, days: number): Promise<HubCandle[] | null>;
}

export interface GateOutcome {
  key: string;
  pass: boolean;
  /** The evaluator could not judge (data gap). */
  skipped: boolean;
  reason: string;
  detail: Record<string, unknown>;
}

interface GateEvaluator {
  evaluate(params: EvaluatorParams, ctx: GateContext): Promise<GateOutcome>;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

const toGateCandle = (c: HubCandle): adaptiveGate.GateCandle => ({ high: c.high, low: c.low, close: c.close, volume: c.volume, timestamp: new Date(c.ts) });

const adaptiveStopGate: GateEvaluator = {
  async evaluate(p, ctx) {
    const nearSupportPct = num(p.nearSupportPct);
    const rsiHot = num(p.rsiHot);
    const vwapExtPct = num(p.vwapExtPct);
    const days = num(p.srLookbackDays);
    if (nearSupportPct === null || rsiHot === null || vwapExtPct === null || days === null || days < 1 || typeof p.requireMacdBullish !== 'boolean' || typeof p.failOpen !== 'boolean') {
      return {
        key: ADAPTIVE_GATE_KEY, pass: false, skipped: false, detail: {},
        reason: 'gate params incomplete (need nearSupportPct, rsiHot, vwapExtPct, srLookbackDays, requireMacdBullish, failOpen)',
      };
    }
    const candles = await ctx.candles('15m', days);
    const r = adaptiveGate.evaluateDecisionGate(ctx.entryPrice, (candles ?? []).map(toGateCandle), ctx.now.getTime(), {
      nearSupportPct, rsiHot, vwapExtPct, requireMacdBullish: p.requireMacdBullish,
    });
    const detail = { ...r.detail, candles: candles === null ? null : candles.length, nearSupport: r.nearSupport, notExtended: r.notExtended, macdBullish: r.macdBullish };
    if (r.skipped && !p.failOpen) return { key: ADAPTIVE_GATE_KEY, pass: false, skipped: true, reason: `${r.reason}; failOpen is false`, detail };
    return { key: ADAPTIVE_GATE_KEY, pass: r.pass, skipped: r.skipped, reason: r.reason, detail };
  },
};

export const GATE_EVALUATORS: ReadonlyMap<string, GateEvaluator> = new Map([[ADAPTIVE_GATE_KEY, adaptiveStopGate]]);

/** Every gate must pass (spec §4.1); the first failure or unknown key stops the chain. */
export async function runGates(gates: readonly GateRef[], ctx: GateContext): Promise<{ pass: boolean; unknown: string | null; outcomes: GateOutcome[] }> {
  const outcomes: GateOutcome[] = [];
  for (const g of gates) {
    const evaluator = GATE_EVALUATORS.get(g.evaluatorKey);
    if (!evaluator) return { pass: false, unknown: g.evaluatorKey, outcomes };
    const o = await evaluator.evaluate(g.params, ctx);
    outcomes.push(o);
    if (!o.pass) return { pass: false, unknown: null, outcomes };
  }
  return { pass: true, unknown: null, outcomes };
}
```

(The namespace import `import * as adaptiveGate` is deliberate: `jest.spyOn(gate, 'evaluateDecisionGate')` in the spec
replaces the property the wrapper calls.)

- [ ] **Step 4: Run it to verify it passes**

Run: `cd apps/api && npx jest src/modules/trade-core/intake/gate-evaluators.spec.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add -- apps/api/src/modules/trade-core/intake/gate-evaluators.ts apps/api/src/modules/trade-core/intake/gate-evaluators.spec.ts
git commit -m "feat(trade-core): M5 gate registry wrapping the Adaptive-Stop decision gate" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/api/src/modules/trade-core/intake/gate-evaluators.ts apps/api/src/modules/trade-core/intake/gate-evaluators.spec.ts
```

---

### Task 6: `EntryMarket` — the entry price from the hub, ATR and gate candles from the hub candle store

**Files:**
- Create: `apps/api/src/modules/trade-core/intake/entry-market.ts`
- Test: `apps/api/src/modules/trade-core/intake/entry-market.spec.ts`

**Interfaces:**
- Consumes: `lookupHubPrices`, `HUB_PRICE_SOURCE` (`market-hub/hub-prices.ts`); `PRICE_MAX_AGE_MS`; `CoreCandles` (Task 2);
  `atr` (`signal-generator/strategies/indicators.ts`, the silo's ATR); `StopBlock`, `CandleTimeframe`; `FakeHub`, `fakeHubSource`.
- Produces: constants `ENTRY_PRICE_WAIT_MS`, `ENTRY_PRICE_POLL_MS`, `ENTRY_WATCH_TTL_MS`, `ATR_LOOKBACK_DAYS`,
  `DAILY_ATR_LOOKBACK_DAYS`; `intakeOwner(intentId)`; `PriceRead = { ok: true; ltp; at } | { ok: false; reason: 'NO_PRICE_SOURCE' | 'NO_FRESH_PRICE'; detail }`;
  `AtrRead { atr: number | null; source: 'hub' | 'none'; detail: string }`; `atrFrom(candles, period)`;
  `EntryMarket.freshPrice(userId, ref, owner, waitMs?)`, `.release(userId, ref, owner)`, `.atr(ref, stop, now)`,
  `.candlesFor(ref, tf, days, now)`; protected `sleep(ms)` (test seam).

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/modules/trade-core/intake/entry-market.spec.ts
import type { ModuleRef } from '@nestjs/core';
import type { HubCandle } from '../../market-hub/candles/candle.types';
import { HUB_PRICE_SOURCE } from '../../market-hub/hub-prices';
import { FakeHub, fakeHubSource } from '../execution/testing/fake-hub';
import type { CoreCandles } from '../market/core-candles';
import { atrFrom, ENTRY_PRICE_WAIT_MS, EntryMarket, intakeOwner } from './entry-market';
import { ist } from './testing/intake-fixtures';

const NOW = ist('2026-10-13', '10:30');
const REF = { exchange: 'NSE' as const, token: '2885', symbol: 'RELIANCE-EQ' };
const bar = (i: number, close: number): HubCandle => ({ ts: NOW.getTime() - (30 - i) * 300_000, open: close, high: close + 2, low: close - 2, close, volume: 100 });

function setup(opts: { served?: boolean; candles?: CoreCandles['read'] } = {}) {
  const hub = new FakeHub();
  const source = fakeHubSource(opts.served === false ? {} : { user_A: hub });
  const moduleRef = { get: (token: string) => (token === HUB_PRICE_SOURCE ? source : (() => { throw new Error('none'); })()) };
  const candles = { read: opts.candles ?? jest.fn().mockResolvedValue({ ok: false, reason: 'hub candles are off' }) } as unknown as CoreCandles;
  const market = new EntryMarket(moduleRef as unknown as ModuleRef, candles);
  // Test seam: sleeping advances the fake clock instead of waiting.
  Object.assign(market, { sleep: async (ms: number) => { jest.setSystemTime(Date.now() + ms); } });
  return { hub, market, candles };
}

beforeEach(() => jest.useFakeTimers({ now: NOW }));
afterEach(() => jest.useRealTimers());

describe('EntryMarket.freshPrice (ruling J6)', () => {
  it('a user the hub does not serve has no price source (fail closed)', async () => {
    const { market } = setup({ served: false });
    expect(await market.freshPrice('user_A', REF, intakeOwner('i1'))).toMatchObject({ ok: false, reason: 'NO_PRICE_SOURCE' });
  });

  it('watches the ref at priority 1 under core-intake:<intentId> and returns a fresh price at once', async () => {
    const { hub, market } = setup();
    hub.setFresh({ ref: REF, ltp: 501.5, at: Date.now(), source: 'ws' });
    expect(await market.freshPrice('user_A', REF, intakeOwner('i1'))).toEqual({ ok: true, ltp: 501.5, at: NOW.getTime() });
    expect(hub.watches).toEqual([{ key: 'NSE:2885', priority: 1, owner: 'core-intake:i1' }]);
  });

  it(`waits up to ${ENTRY_PRICE_WAIT_MS} ms for the first fresh price, then gives up`, async () => {
    const { hub, market } = setup();
    let polls = 0;
    Object.assign(market, {
      sleep: async (ms: number) => {
        polls += 1;
        jest.setSystemTime(Date.now() + ms);
        if (polls === 3) hub.setFresh({ ref: REF, ltp: 499, at: Date.now(), source: 'quote' });
      },
    });
    expect(await market.freshPrice('user_A', REF, 'o')).toMatchObject({ ok: true, ltp: 499 });
    const { market: never } = setup();
    expect(await never.freshPrice('user_A', REF, 'o')).toMatchObject({ ok: false, reason: 'NO_FRESH_PRICE' });
    expect(Date.now() - NOW.getTime()).toBeGreaterThanOrEqual(ENTRY_PRICE_WAIT_MS);
  });

  it('waitMs 0 answers from what the hub holds now; release unwatches the owner', async () => {
    const { hub, market } = setup();
    expect(await market.freshPrice('user_A', REF, 'o', 0)).toMatchObject({ ok: false, reason: 'NO_FRESH_PRICE' });
    market.release('user_A', REF, 'o');
    expect(hub.unwatches).toEqual([{ key: 'NSE:2885', owner: 'o' }]);
  });
});

describe('EntryMarket.atr (O7) and atrFrom', () => {
  it('a fixed stop needs no ATR; a timeframe the hub does not build is none', async () => {
    const { market } = setup();
    expect(await market.atr(REF, { kind: 'fixedPct', pct: 1.5 }, NOW)).toEqual({ atr: null, source: 'none', detail: 'fixed stop' });
    expect((await market.atr(REF, { kind: 'atr', period: 14, timeframe: '3m', multiple: 1, minPct: 0.5, maxPct: 2 }, NOW)).source).toBe('none');
  });

  it('unavailable candles are none with the reason; enough candles give the silo ATR over 3 days of 5m bars', async () => {
    const off = setup();
    expect(await off.market.atr(REF, { kind: 'atr', period: 14, timeframe: '5m', multiple: 1.2, minPct: 0.8, maxPct: 2.5 }, NOW)).toEqual({ atr: null, source: 'none', detail: 'hub candles are off' });
    const read = jest.fn().mockResolvedValue({ ok: true, candles: Array.from({ length: 30 }, (_, i) => bar(i, 500)), complete: true });
    const on = setup({ candles: read });
    const r = await on.market.atr(REF, { kind: 'atr', period: 14, timeframe: '5m', multiple: 1.2, minPct: 0.8, maxPct: 2.5 }, NOW);
    expect(r.source).toBe('hub');
    expect(r.atr).toBeCloseTo(4, 5); // every bar spans high − low = 4 with flat closes
    expect(read).toHaveBeenCalledWith(REF, '5m', new Date(NOW.getTime() - 3 * 86_400_000), NOW);
  });

  it('atrFrom needs period + 1 bars', () => {
    expect(atrFrom(Array.from({ length: 14 }, (_, i) => bar(i, 500)), 14)).toBeNull();
    expect(atrFrom(Array.from({ length: 15 }, (_, i) => bar(i, 500)), 14)).toBeCloseTo(4, 5);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx jest src/modules/trade-core/intake/entry-market.spec.ts`
Expected: FAIL — `Cannot find module './entry-market'`.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/modules/trade-core/intake/entry-market.ts
import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { HubCandle, Timeframe } from '../../market-hub/candles/candle.types';
import { lookupHubPrices, type HubPrices } from '../../market-hub/hub-prices';
import type { InstrumentRef } from '../../market-hub/hub.types';
import { atr } from '../../signal-generator/strategies/indicators';
import { PRICE_MAX_AGE_MS } from '../execution/fill-model';
import { CoreCandles } from '../market/core-candles';
import type { CandleTimeframe, StopBlock } from '../strategies/blocks/block-types';

/** Ruling J6: how long the intake waits for the first fresh price of a hit's instrument. */
export const ENTRY_PRICE_WAIT_MS = 5_000;
export const ENTRY_PRICE_POLL_MS = 250;
/** The intake's watch lapses on its own if an attempt dies before releasing it. */
export const ENTRY_WATCH_TTL_MS = 60_000;
/** The silo's ATR window (adaptive-stop-watch.service.ts atr5mFor: 3 days of 5m bars). */
export const ATR_LOOKBACK_DAYS = 3;
export const DAILY_ATR_LOOKBACK_DAYS = 60;

export const intakeOwner = (intentId: string): string => `core-intake:${intentId}`;

export type PriceRead = { ok: true; ltp: number; at: number } | { ok: false; reason: 'NO_PRICE_SOURCE' | 'NO_FRESH_PRICE'; detail: string };

export interface AtrRead {
  atr: number | null;
  source: 'hub' | 'none';
  detail: string;
}

/** The block timeframes the hub candle store builds. */
const HUB_TIMEFRAME: Partial<Record<CandleTimeframe, Timeframe>> = { '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1h', '1d': '1d' };

/** The silo's ATR (signal-generator indicators), over at least period + 1 bars; null when unusable. */
export function atrFrom(candles: readonly HubCandle[], period: number): number | null {
  if (candles.length < period + 1) return null;
  const a = atr(candles.map((c) => c.high), candles.map((c) => c.low), candles.map((c) => c.close), period);
  return a !== null && Number.isFinite(a) && a > 0 ? a : null;
}

/**
 * The intake's market inputs (rulings J6, J7): the entry price from the hub that prices the user's
 * positions, and candles from the hub candle store. No legacy lane, no second cache.
 */
@Injectable()
export class EntryMarket {
  constructor(
    private readonly moduleRef: ModuleRef,
    private readonly candles: CoreCandles,
  ) {}

  /** Test seam (the specs replace it to advance a fake clock). */
  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private hub(userId: string): HubPrices | null {
    return lookupHubPrices(this.moduleRef)?.hubFor(userId, 'positions') ?? null;
  }

  async freshPrice(userId: string, ref: InstrumentRef, owner: string, waitMs: number = ENTRY_PRICE_WAIT_MS): Promise<PriceRead> {
    const hub = this.hub(userId);
    if (!hub) return { ok: false, reason: 'NO_PRICE_SOURCE', detail: 'the market hub does not price this user (owner-only hub, HUB_PRICES_POSITIONS)' };
    void hub.watch([ref], 1, owner, ENTRY_WATCH_TTL_MS);
    const start = Date.now();
    for (;;) {
      const r = hub.price(ref, { maxAgeMs: PRICE_MAX_AGE_MS });
      if (r.kind === 'fresh' && r.price.ltp > 0) return { ok: true, ltp: r.price.ltp, at: r.price.at };
      if (Date.now() - start >= waitMs) return { ok: false, reason: 'NO_FRESH_PRICE', detail: `no fresh price within ${waitMs} ms (hub: ${r.kind})` };
      await this.sleep(ENTRY_PRICE_POLL_MS);
    }
  }

  release(userId: string, ref: InstrumentRef, owner: string): void {
    const hub = this.hub(userId);
    if (hub) void hub.unwatch([ref], owner);
  }

  async candlesFor(ref: InstrumentRef, tf: Timeframe, days: number, now: Date): Promise<HubCandle[] | null> {
    const r = await this.candles.read(ref, tf, new Date(now.getTime() - days * 86_400_000), now);
    return r.ok ? r.candles : null;
  }

  async atr(ref: InstrumentRef, stop: StopBlock, now: Date): Promise<AtrRead> {
    if (stop.kind !== 'atr') return { atr: null, source: 'none', detail: 'fixed stop' };
    const tf = HUB_TIMEFRAME[stop.timeframe];
    if (!tf) return { atr: null, source: 'none', detail: `the hub does not build ${stop.timeframe} candles` };
    const days = tf === '1d' ? DAILY_ATR_LOOKBACK_DAYS : ATR_LOOKBACK_DAYS;
    const r = await this.candles.read(ref, tf, new Date(now.getTime() - days * 86_400_000), now);
    if (!r.ok) return { atr: null, source: 'none', detail: r.reason };
    const a = atrFrom(r.candles, stop.period);
    if (a === null) return { atr: null, source: 'none', detail: `${r.candles.length} ${tf} candle(s); ATR(${stop.period}) needs ${stop.period + 1}` };
    return { atr: a, source: 'hub', detail: `ATR(${stop.period}) over ${r.candles.length} ${tf} candle(s)${r.complete ? '' : ' (range incomplete)'}` };
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd apps/api && npx jest src/modules/trade-core/intake/entry-market.spec.ts`
Expected: PASS. (If `atr()` in `indicators.ts` is Wilder-smoothed, flat closes with a constant 4-point range still give 4.)

- [ ] **Step 5: Commit**

```bash
git add -- apps/api/src/modules/trade-core/intake/entry-market.ts apps/api/src/modules/trade-core/intake/entry-market.spec.ts
git commit -m "feat(trade-core): M5 EntryMarket — hub entry price, ATR and gate candles" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/api/src/modules/trade-core/intake/entry-market.ts apps/api/src/modules/trade-core/intake/entry-market.spec.ts
```

---

### Task 7: `CoreEntryIntake` — the queue and the per-selection pipeline

**Files:**
- Create: `apps/api/src/modules/trade-core/intake/entry-config.ts`
- Test: `apps/api/src/modules/trade-core/intake/entry-config.spec.ts`
- Create: `apps/api/src/modules/trade-core/intake/core-entry-intake.service.ts`
- Test: `apps/api/src/modules/trade-core/intake/core-entry-intake.service.spec.ts`

**Interfaces:**
- Consumes: Task 4 (`ChartinkHit`, `setCoreAlertIntake`, entry rules), Task 5 (`runGates`), Task 6 (`EntryMarket`,
  `intakeOwner`, `PriceRead`, `AtrRead`), Task 2 (`LiveSelection`, `listEnabledPaper`, `FakeJournal`), Task 1 ports;
  M2 `RiskWallService.check(intent, now)`, `CoreEntryIntent`, `RiskVerdict`; M3 `marginFor`, `CorePaperDefaultsService.settings(nowMs)`;
  M4 `CoreLifecycleService.openPosition(req, now)`, `resolveStopPct`, `round2`.
- Produces:
  - `EntryMode = 'off' | 'journal' | 'paper'`; `EntryConfig { mode; userIds: ReadonlySet<string> }`; `CORE_ENTRY_CONFIG`;
    `readEntryConfig(env)`.
  - `INTAKE_MAX_PENDING = 200`; `IntakeOutcome = { kind: 'DUPLICATE'; intentId } | { kind: 'SKIPPED'; intentId; reason: SkipReason; detail } | { kind: 'DRY_RUN'; intentId; verdict; qty } | { kind: 'OPENED'; intentId; positionId; qty }`;
    `CoreEntryIntake.accept(hit)`, `.process(hit, now?) : Promise<IntakeOutcome[]>`, `.idle()`,
    `.status(): { mode; users: number; pending: number; dropped: number }` (Task 17 reads it).

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/modules/trade-core/intake/entry-config.spec.ts
import { readEntryConfig } from './entry-config';

describe('readEntryConfig (O2)', () => {
  it('defaults to off with nobody; an unknown mode is off (fail closed)', () => {
    expect(readEntryConfig({})).toEqual({ mode: 'off', userIds: new Set() });
    expect(readEntryConfig({ CORE_ENTRIES_MODE: 'live' }).mode).toBe('off');
  });

  it('reads journal / paper case-insensitively and a trimmed comma list of users', () => {
    expect(readEntryConfig({ CORE_ENTRIES_MODE: ' Paper ', CORE_ENTRY_USER_IDS: ' u1, ,u2 ' })).toEqual({ mode: 'paper', userIds: new Set(['u1', 'u2']) });
    expect(readEntryConfig({ CORE_ENTRIES_MODE: 'journal' }).mode).toBe('journal');
  });
});
```

```ts
// apps/api/src/modules/trade-core/intake/core-entry-intake.service.spec.ts
import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { marginFor } from '../execution/margin';
import type { CorePaperDefaultsService } from '../execution/services/core-paper-defaults.service';
import { paperSettings } from '../execution/testing/paper-fixtures';
import type { CoreTradeHistory } from '../journal/journal-ports';
import { FakeJournal } from '../journal/testing/fake-journal';
import type { CoreLifecycleService, CoreOpenRequest } from '../lifecycle/core-lifecycle.service';
import type { RiskVerdict } from '../risk-wall/risk-wall.types';
import type { RiskWallService } from '../risk-wall/services/risk-wall.service';
import { limitsFixture } from '../risk-wall/testing/risk-fixtures';
import type { StrategyBlocks } from '../strategies/blocks/block-types';
import type { CoreStrategySelectionRepository, LiveSelection } from '../strategies/repositories/core-strategy-selection.repository';
import { currentCoreAlertIntake, setCoreAlertIntake } from './alert-handoff';
import { CoreEntryIntake, INTAKE_MAX_PENDING } from './core-entry-intake.service';
import type { EntryMode } from './entry-config';
import type { AtrRead, EntryMarket, PriceRead } from './entry-market';
import { adaptiveSeedBlocks, hit, ist, plainBlocks } from './testing/intake-fixtures';

const NOW = ist('2026-10-13', '10:30');

function verdict(over: Partial<RiskVerdict> = {}): RiskVerdict {
  return {
    intentId: 'x', userId: 'user_A', intentKind: 'ENTRY', verdict: 'ALLOW', requestedQty: 400, qty: 400,
    reasons: [{ code: 'WITHIN_LIMITS', message: 'within limits' }], limits: limitsFixture(), state: null, dailyLoss: null,
    killSwitchActive: false, checkedAt: NOW.toISOString(), ...over,
  };
}

interface SetupOptions {
  mode?: EntryMode;
  users?: string[];
  blocks?: StrategyBlocks;
  strategyKey?: string;
  price?: PriceRead;
  atr?: AtrRead;
  verdict?: RiskVerdict;
  history?: Partial<CoreTradeHistory>;
  open?: jest.Mock;
}

function setup(o: SetupOptions = {}) {
  const sel: LiveSelection = {
    userId: 'user_A', strategyId: 'cs_x', strategyKey: o.strategyKey ?? 'ungated', strategyVersionId: 'csv_x_v1',
    blocks: o.blocks ?? plainBlocks(), capitalAllocation: '200000.00',
  };
  const selections = { listEnabledPaper: jest.fn().mockResolvedValue([sel]) };
  const wall = { check: jest.fn().mockResolvedValue(o.verdict ?? verdict()) };
  const opened = new Set<string>();
  const open = o.open ?? jest.fn(async (req: CoreOpenRequest) => {
    opened.add(req.intent.intentId);
    return { id: 'pos_1' };
  });
  const lifecycle = { openPosition: open };
  const defaults = { settings: jest.fn().mockResolvedValue({ ok: true, settings: paperSettings() }) };
  const price = o.price ?? { ok: true as const, ltp: 500, at: NOW.getTime() };
  const market = {
    freshPrice: jest.fn().mockResolvedValue(price),
    release: jest.fn(),
    atr: jest.fn().mockResolvedValue(o.atr ?? { atr: null, source: 'none', detail: 'fixed stop' }),
    candlesFor: jest.fn().mockResolvedValue(null),
  };
  const history: CoreTradeHistory = {
    intentSeen: jest.fn(async (id: string) => opened.has(id)),
    lastOpenedAt: jest.fn().mockResolvedValue(null),
    lastClosedNetToday: jest.fn().mockResolvedValue(null),
    ...o.history,
  };
  const journal = new FakeJournal();
  const corpus = { entrySetup: jest.fn().mockResolvedValue(undefined), outcome: jest.fn().mockResolvedValue(undefined) };
  const intake = new CoreEntryIntake(
    { mode: o.mode ?? 'paper', userIds: new Set(o.users ?? ['user_A']) },
    selections as unknown as CoreStrategySelectionRepository,
    wall as unknown as RiskWallService,
    lifecycle as unknown as CoreLifecycleService,
    defaults as unknown as CorePaperDefaultsService,
    market as unknown as EntryMarket,
    history,
    journal,
    corpus,
  );
  return { intake, selections, wall, open, defaults, market, history, journal, corpus };
}

beforeEach(() => jest.useFakeTimers({ now: NOW }));
afterEach(() => {
  jest.useRealTimers();
  setCoreAlertIntake(null);
});

describe('CoreEntryIntake — switch and scope (O2, J3)', () => {
  it('registers for the hand-off only when entries are not off', () => {
    const off = setup({ mode: 'off' });
    off.intake.onModuleInit();
    expect(currentCoreAlertIntake()).toBeNull();
    const on = setup({ mode: 'journal' });
    on.intake.onModuleInit();
    expect(currentCoreAlertIntake()).toBe(on.intake);
    on.intake.onModuleDestroy();
    expect(currentCoreAlertIntake()).toBeNull();
  });

  it('a user outside CORE_ENTRY_USER_IDS gets nothing: no journal, no price read', async () => {
    const s = setup({ users: ['someone_else'] });
    expect(await s.intake.process(hit())).toEqual([]);
    expect(s.journal.entries).toEqual([]);
    expect(s.market.freshPrice).not.toHaveBeenCalled();
  });

  it("a hit that is not the strategy's is silent; unreadable selections skip the hit without throwing", async () => {
    const s = setup();
    expect(await s.intake.process(hit({ scanName: 'EMA breakout' }))).toEqual([]);
    expect(s.journal.entries).toEqual([]);
    s.selections.listEnabledPaper.mockRejectedValueOnce(new Error('db down'));
    await expect(s.intake.process(hit())).resolves.toEqual([]);
  });
});

describe('CoreEntryIntake — the pipeline (J5)', () => {
  it('paper: an Ungated hit becomes an intent, passes the wall and opens a position; journaled and corpus-written', async () => {
    const s = setup();
    const [out] = await s.intake.process(hit(), NOW);
    expect(out).toMatchObject({ kind: 'OPENED', positionId: 'pos_1', qty: 400 });
    const intent = s.wall.check.mock.calls[0][0];
    expect(intent).toMatchObject({
      kind: 'ENTRY', userId: 'user_A', strategyId: 'cs_x', strategyVersionId: 'csv_x_v1', vehicle: 'CASH_INTRADAY', exchange: 'NSE',
      symbol: 'RELIANCE-EQ', underlying: 'RELIANCE', side: 'BUY', optionType: null, qty: 400, lotSize: 1, refPrice: 500, refPriceFresh: true,
      stopPrice: 492.5, capitalPerUnit: marginFor('CASH_INTRADAY', new Prisma.Decimal(500), paperSettings()).toNumber(), mtfLeverage: null,
    });
    expect(s.open).toHaveBeenCalledWith(
      { intent, qty: 400, instrument: { exchange: 'NSE', token: '2885', symbol: 'RELIANCE-EQ', lotSize: 1, underlying: null }, atr: null, limits: limitsFixture(), option: null },
      expect.any(Date),
    );
    expect(s.journal.types()).toEqual(['ALERT_RECEIVED']);
    expect(s.journal.entries[0]).toMatchObject({ dedupeKey: `alert:${intent.intentId}`, intentId: intent.intentId, strategyId: 'cs_x' });
    expect(s.corpus.entrySetup).toHaveBeenCalledWith(expect.objectContaining({
      intentId: intent.intentId, strategyKey: 'ungated', direction: 'LONG', ruleScore: 70, setupGroupKey: 'alert_1|RELIANCE|2026-10-13', decision: { taken: true, reason: 'opened pos_1 for 400' },
    }));
    expect(s.market.release).toHaveBeenCalledWith('user_A', { exchange: 'NSE', token: '2885', symbol: 'RELIANCE-EQ' }, `core-intake:${intent.intentId}`);
  });

  it('a RESIZE opens the verdict quantity, never the requested one', async () => {
    const s = setup({ verdict: verdict({ verdict: 'RESIZE', qty: 133 }) });
    await s.intake.process(hit(), NOW);
    expect(s.open.mock.calls[0][0].qty).toBe(133);
  });

  it('journal mode runs the wall, opens nothing and writes no corpus row (J9)', async () => {
    const s = setup({ mode: 'journal' });
    const [out] = await s.intake.process(hit(), NOW);
    expect(out).toMatchObject({ kind: 'DRY_RUN', verdict: 'ALLOW', qty: 400 });
    expect(s.wall.check).toHaveBeenCalledTimes(1);
    expect(s.open).not.toHaveBeenCalled();
    expect(s.corpus.entrySetup).not.toHaveBeenCalled();
    expect(s.journal.ofType('INTENT_SKIPPED')[0].payload).toMatchObject({ reason: 'ENTRIES_DRY_RUN' });
  });

  it('a wall REJECT is RISK_REJECT with the codes; the corpus records the skip', async () => {
    const s = setup({ verdict: verdict({ verdict: 'REJECT', qty: 0, reasons: [{ code: 'KILL_SWITCH', message: 'the kill switch is on: no new entries' }] }) });
    const [out] = await s.intake.process(hit(), NOW);
    expect(out).toMatchObject({ kind: 'SKIPPED', reason: 'RISK_REJECT', detail: 'KILL_SWITCH: the kill switch is on: no new entries' });
    expect(s.open).not.toHaveBeenCalled();
    expect(s.corpus.entrySetup).toHaveBeenCalledWith(expect.objectContaining({ decision: { taken: false, reason: 'RISK_REJECT: KILL_SWITCH: the kill switch is on: no new entries' } }));
  });

  it('MIN_SCORE is journaled before any price read (Adaptive-Stop at 12:00 needs 75)', async () => {
    const s = setup({ blocks: adaptiveSeedBlocks() });
    const [out] = await s.intake.process(hit({ scanName: 'any scan', score: 70 }), ist('2026-10-13', '12:00'));
    expect(out).toMatchObject({ kind: 'SKIPPED', reason: 'MIN_SCORE' });
    expect(s.journal.types()).toEqual(['ALERT_RECEIVED', 'INTENT_SKIPPED']);
    expect(s.market.freshPrice).not.toHaveBeenCalled();
  });

  it('cooldown and last loss are checked before the price; an unknown last trade fails closed', async () => {
    const cool = setup({ history: { lastOpenedAt: jest.fn().mockResolvedValue(ist('2026-10-13', '10:00')) } });
    expect((await cool.intake.process(hit(), NOW))[0]).toMatchObject({ reason: 'COOLDOWN' });
    expect(cool.market.freshPrice).not.toHaveBeenCalled();
    const lost = setup({ history: { lastClosedNetToday: jest.fn().mockResolvedValue(-120.5) } });
    expect((await lost.intake.process(hit(), NOW))[0]).toMatchObject({ reason: 'LAST_LOSS' });
    const unknown = setup({ history: { lastClosedNetToday: jest.fn().mockResolvedValue('UNKNOWN') } });
    expect((await unknown.intake.process(hit(), NOW))[0]).toMatchObject({ reason: 'HISTORY_UNKNOWN' });
  });

  it('no price source and a stale entry skip; the watch is always released', async () => {
    const none = setup({ price: { ok: false, reason: 'NO_PRICE_SOURCE', detail: 'owner-only hub' } });
    expect((await none.intake.process(hit(), NOW))[0]).toMatchObject({ reason: 'NO_PRICE_SOURCE' });
    expect(none.market.release).toHaveBeenCalledTimes(1);
    const stale = setup({ price: { ok: true, ltp: 505.5, at: NOW.getTime() } });
    expect((await stale.intake.process(hit(), NOW))[0]).toMatchObject({ reason: 'STALE_ENTRY', detail: 'moved 1.10% past the alert price ₹500 (max 1%)' });
    expect(stale.market.release).toHaveBeenCalledTimes(1);
  });

  it('Adaptive-Stop with no candles: the gate fails open as the seed says (O6) and the stop floors at minPct (O7)', async () => {
    const s = setup({ blocks: adaptiveSeedBlocks(), strategyKey: 'adaptive-stop', verdict: verdict({ qty: 200, requestedQty: 200 }) });
    const [out] = await s.intake.process(hit({ scanName: 'any scan', score: 70 }), NOW);
    expect(out).toMatchObject({ kind: 'OPENED', qty: 200 });
    expect(s.wall.check.mock.calls[0][0]).toMatchObject({ refPrice: 500, stopPrice: 496, qty: 200 }); // 0.8 % floor; ₹800 ÷ ₹4
    const setupRow = s.corpus.entrySetup.mock.calls[0][0];
    expect(setupRow.evidence).toMatchObject({ atrSource: 'none', stopPct: 0.8, gates: [expect.objectContaining({ pass: true, skipped: true })] });
  });

  it('an unknown gate key is GATE_UNKNOWN; settings missing is PAPER_SETTINGS_MISSING; a tiny budget is SIZE_ZERO', async () => {
    const blocks = { ...plainBlocks(), filters: { ...plainBlocks().filters, gates: [{ kind: 'evaluator' as const, evaluatorKey: 'nope', params: {} }] } };
    expect((await setup({ blocks }).intake.process(hit(), NOW))[0]).toMatchObject({ reason: 'GATE_UNKNOWN' });
    const noSettings = setup();
    noSettings.defaults.settings.mockResolvedValueOnce({ ok: false, missing: ['intradayLeverage@CASH_INTRADAY'] });
    expect((await noSettings.intake.process(hit(), NOW))[0]).toMatchObject({ reason: 'PAPER_SETTINGS_MISSING' });
    const tiny = { ...plainBlocks(), sizing: { kind: 'notionalRupees' as const, amount: 100 } };
    expect((await setup({ blocks: tiny }).intake.process(hit(), NOW))[0]).toMatchObject({ reason: 'SIZE_ZERO' });
  });

  it('openPosition refusing is OPEN_REFUSED; any throw inside the pipeline is INTERNAL_ERROR, never thrown', async () => {
    const refused = setup({ open: jest.fn().mockRejectedValue(new ConflictException('an active core position already exists')) });
    expect((await refused.intake.process(hit(), NOW))[0]).toMatchObject({ reason: 'OPEN_REFUSED' });
    const broken = setup({ history: { lastOpenedAt: jest.fn().mockRejectedValue(new Error('db down')) } });
    await expect(broken.intake.process(hit(), NOW)).resolves.toEqual([expect.objectContaining({ kind: 'SKIPPED', reason: 'INTERNAL_ERROR', detail: 'db down' })]);
  });
});

describe('CoreEntryIntake — idempotence and backpressure (Review Focus 1, 2)', () => {
  it('the same hit twice opens one position and journals once', async () => {
    const s = setup();
    await s.intake.process(hit(), NOW);
    const [again] = await s.intake.process(hit(), NOW);
    expect(again).toMatchObject({ kind: 'DUPLICATE' });
    expect(s.open).toHaveBeenCalledTimes(1);
    expect(s.journal.ofType('ALERT_RECEIVED')).toHaveLength(1);
  });

  it(`a full backlog (${INTAKE_MAX_PENDING}) drops the hit and never throws`, () => {
    const s = setup();
    s.selections.listEnabledPaper.mockReturnValue(new Promise(() => undefined)); // the first hit never finishes
    for (let i = 0; i < INTAKE_MAX_PENDING + 2; i += 1) expect(() => s.intake.accept(hit({ alertId: `a${i}` }))).not.toThrow();
    expect(s.intake.status()).toMatchObject({ pending: INTAKE_MAX_PENDING, dropped: 1 });
  });

  it('accepted hits are processed in order, one at a time', async () => {
    const s = setup();
    s.intake.accept(hit({ alertId: 'a1' }));
    s.intake.accept(hit({ alertId: 'a2', token: '1594', tradingSymbol: 'INFY-EQ', symbol: 'INFY' }));
    await s.intake.idle();
    expect(s.open.mock.calls.map((c) => c[0].intent.symbol)).toEqual(['RELIANCE-EQ', 'INFY-EQ']);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/api && npx jest src/modules/trade-core/intake/entry-config.spec.ts src/modules/trade-core/intake/core-entry-intake.service.spec.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/modules/trade-core/intake/entry-config.ts
/** O2: the entry switch. Read once at boot (a change is a restart, like every env flag). */
export type EntryMode = 'off' | 'journal' | 'paper';

export interface EntryConfig {
  mode: EntryMode;
  /** Users whose selections may produce entries. Empty = nobody. */
  userIds: ReadonlySet<string>;
}

export const CORE_ENTRY_CONFIG = Symbol('CORE_ENTRY_CONFIG');

/** Anything but `journal` or `paper` is `off` (fail closed). */
export function readEntryConfig(env: Record<string, string | undefined> = process.env): EntryConfig {
  const raw = (env.CORE_ENTRIES_MODE ?? 'off').trim().toLowerCase();
  const mode: EntryMode = raw === 'journal' || raw === 'paper' ? raw : 'off';
  const userIds = new Set((env.CORE_ENTRY_USER_IDS ?? '').split(',').map((s) => s.trim()).filter((s) => s.length > 0));
  return { mode, userIds };
}
```

```ts
// apps/api/src/modules/trade-core/intake/core-entry-intake.service.ts
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { InstrumentRef } from '../../market-hub/hub.types';
import { marginFor } from '../execution/margin';
import { CorePaperDefaultsService } from '../execution/services/core-paper-defaults.service';
import { CORE_CORPUS, CORE_JOURNAL, CORE_TRADE_HISTORY, type CoreCorpusPort, type CoreJournalPort, type CoreTradeHistory } from '../journal/journal-ports';
import type { SkipReason } from '../journal/journal.types';
import { CoreLifecycleService } from '../lifecycle/core-lifecycle.service';
import { resolveStopPct, round2 } from '../lifecycle/exit-plan';
import type { CoreEntryIntent, RiskVerdict, RiskVerdictKind } from '../risk-wall/risk-wall.types';
import { RiskWallService } from '../risk-wall/services/risk-wall.service';
import { CoreStrategySelectionRepository, type LiveSelection } from '../strategies/repositories/core-strategy-selection.repository';
import { setCoreAlertIntake, type ChartinkHit, type CoreAlertIntake } from './alert-handoff';
import { CORE_ENTRY_CONFIG, type EntryConfig } from './entry-config';
import { EntryMarket, intakeOwner } from './entry-market';
import { cooldownActive, intentIdFor, lastLossVerdict, matchEntry, setupGroupKey, sizeQty, staleEntryFails, staleMovePct, stopPriceFor } from './entry-rules';
import { runGates } from './gate-evaluators';

/** Load bound (Global Constraints): hits waiting for the sequential intake. */
export const INTAKE_MAX_PENDING = 200;

export type IntakeOutcome =
  | { kind: 'DUPLICATE'; intentId: string }
  | { kind: 'SKIPPED'; intentId: string; reason: SkipReason; detail: string }
  | { kind: 'DRY_RUN'; intentId: string; verdict: RiskVerdictKind; qty: number }
  | { kind: 'OPENED'; intentId: string; positionId: string; qty: number };

type AttemptOutcome = IntakeOutcome | { kind: 'NOT_MINE' };

interface Attempt {
  sel: LiveSelection;
  hit: ChartinkHit;
  intentId: string;
  at: Date;
  evidence: Record<string, unknown>;
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Spec §3 entry source (rulings J2–J9, J24): Chartink hits handed off by ChartinkProcessService are
 * queued and processed one at a time. For each enabled PAPER selection of an allow-listed user whose
 * entry block matches: filters (cheap first) → hub price → stale entry → gates → ATR → sizing →
 * RiskWallService.check → (paper) CoreLifecycleService.openPosition. Every skip is journaled with its
 * reason; nothing here throws back to Chartink, and nothing here touches an exit.
 */
@Injectable()
export class CoreEntryIntake implements CoreAlertIntake, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CoreEntryIntake.name);
  private readonly queue: ChartinkHit[] = [];
  private draining: Promise<void> | null = null;
  private dropped = 0;

  constructor(
    @Inject(CORE_ENTRY_CONFIG) private readonly config: EntryConfig,
    private readonly selections: CoreStrategySelectionRepository,
    private readonly wall: RiskWallService,
    private readonly lifecycle: CoreLifecycleService,
    private readonly defaults: CorePaperDefaultsService,
    private readonly market: EntryMarket,
    @Inject(CORE_TRADE_HISTORY) private readonly history: CoreTradeHistory,
    @Inject(CORE_JOURNAL) private readonly journal: CoreJournalPort,
    @Inject(CORE_CORPUS) private readonly corpus: CoreCorpusPort,
  ) {}

  onModuleInit(): void {
    if (this.config.mode === 'off') {
      this.logger.log('core entries are off (CORE_ENTRIES_MODE)');
      return;
    }
    setCoreAlertIntake(this);
    this.logger.warn(`core entries: ${this.config.mode} mode for ${this.config.userIds.size} user(s) (CORE_ENTRY_USER_IDS)`);
  }

  onModuleDestroy(): void {
    setCoreAlertIntake(null);
  }

  status(): { mode: EntryConfig['mode']; users: number; pending: number; dropped: number } {
    return { mode: this.config.mode, users: this.config.userIds.size, pending: this.queue.length, dropped: this.dropped };
  }

  /** The hand-off target: queue and return at once. A full queue drops the hit (counted, logged). */
  accept(hit: ChartinkHit): void {
    if (this.queue.length >= INTAKE_MAX_PENDING) {
      this.dropped += 1;
      this.logger.error(`core intake backlog full (${INTAKE_MAX_PENDING}): ${hit.symbol} from alert ${hit.alertId} dropped`);
      return;
    }
    this.queue.push(hit);
    if (!this.draining) this.draining = this.drain().finally(() => { this.draining = null; });
  }

  /** Resolves when the queue is empty (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.draining) await this.draining;
  }

  private async drain(): Promise<void> {
    for (let next = this.queue.shift(); next; next = this.queue.shift()) {
      try {
        await this.process(next);
      } catch (err) {
        this.logger.error(`core intake ${next.symbol} (alert ${next.alertId}) failed: ${errorText(err)}`);
      }
    }
  }

  async process(hit: ChartinkHit, now: Date = new Date()): Promise<IntakeOutcome[]> {
    let live: LiveSelection[];
    try {
      live = await this.selections.listEnabledPaper();
    } catch (err) {
      this.logger.error(`core intake: selections unreadable, ${hit.symbol} from alert ${hit.alertId} skipped: ${errorText(err)}`);
      return [];
    }
    const out: IntakeOutcome[] = [];
    for (const sel of live) {
      if (!this.config.userIds.has(sel.userId)) continue;
      const o = await this.attempt(sel, hit, now);
      if (o.kind !== 'NOT_MINE') out.push(o);
    }
    return out;
  }

  private async attempt(sel: LiveSelection, hit: ChartinkHit, now: Date): Promise<AttemptOutcome> {
    const m = matchEntry(sel.blocks, hit, now);
    if (m.kind === 'NOT_MINE') return m;
    const intentId = intentIdFor(sel.userId, sel.strategyId, hit.alertId, hit.token);
    if (await this.history.intentSeen(intentId)) return { kind: 'DUPLICATE', intentId };
    const a: Attempt = {
      sel, hit, intentId, at: now,
      evidence: { source: 'chartink', alertId: hit.alertId, scanName: hit.scanName, side: hit.side, score: hit.score, alertPrice: hit.hitPrice, capitalAllocation: sel.capitalAllocation },
    };
    this.journal.record({
      type: 'ALERT_RECEIVED', userId: sel.userId, at: now, strategyId: sel.strategyId, strategyVersionId: sel.strategyVersionId, intentId,
      symbol: hit.tradingSymbol, payload: { ...a.evidence, token: hit.token, exchange: hit.exchange, strategyKey: sel.strategyKey }, priceUsed: hit.hitPrice,
      dedupeKey: `alert:${intentId}`,
    });
    if (m.kind === 'SKIP') return this.skip(a, m.reason, m.detail);

    const ref: InstrumentRef = { exchange: hit.exchange, token: hit.token, symbol: hit.tradingSymbol };
    const owner = intakeOwner(intentId);
    let watched = false;
    try {
      const b = sel.blocks;
      if (b.filters.cooldown) {
        const last = await this.history.lastOpenedAt(sel.userId, sel.strategyId, hit.token);
        if (cooldownActive(b.filters.cooldown, last, now)) {
          return await this.skip(a, 'COOLDOWN', `opened ${hit.symbol} at ${last?.toISOString()}; cooldown ${b.filters.cooldown.minutes} min`);
        }
      }
      if (b.filters.lastLoss) {
        const last = await this.history.lastClosedNetToday(sel.userId, sel.strategyId, hit.token, now);
        const v = lastLossVerdict(b.filters.lastLoss, last);
        if (v === 'BLOCK') return await this.skip(a, 'LAST_LOSS', `today's last closed trade on ${hit.symbol} netted ₹${String(last)}`);
        if (v === 'UNKNOWN') return await this.skip(a, 'HISTORY_UNKNOWN', `today's last closed trade on ${hit.symbol} has no summary yet`);
      }

      watched = true;
      const p = await this.market.freshPrice(sel.userId, ref, owner);
      if (!p.ok) return await this.skip(a, p.reason, p.detail);
      a.evidence.ltp = p.ltp;
      if (staleEntryFails(b.filters.staleEntry, hit.side, hit.hitPrice, p.ltp)) {
        const moved = staleMovePct(hit.side, hit.hitPrice, p.ltp).toFixed(2);
        return await this.skip(a, 'STALE_ENTRY', `moved ${moved}% past the alert price ₹${hit.hitPrice} (max ${b.filters.staleEntry?.maxMovePct}%)`);
      }
      if (b.filters.gates.length > 0) {
        const g = await runGates(b.filters.gates, { entryPrice: p.ltp, now, candles: (tf, days) => this.market.candlesFor(ref, tf, days, now) });
        a.evidence.gates = g.outcomes;
        if (g.unknown) return await this.skip(a, 'GATE_UNKNOWN', `no evaluator is registered for ${g.unknown}`);
        if (!g.pass) return await this.skip(a, 'GATE', g.outcomes[g.outcomes.length - 1]?.reason ?? 'a gate failed');
      }
      const settings = await this.defaults.settings(now.getTime());
      if (!settings.ok) return await this.skip(a, 'PAPER_SETTINGS_MISSING', `missing paper defaults: ${settings.missing.join(', ')}`);

      const atr = await this.market.atr(ref, b.stop, now);
      const latest = await this.market.freshPrice(sel.userId, ref, owner, 0);
      const refPrice = latest.ok ? latest.ltp : p.ltp;
      const stopPct = resolveStopPct(b.stop, refPrice, atr.atr);
      const stopPrice = stopPriceFor(hit.side, refPrice, stopPct);
      const qty = sizeQty(b.sizing, refPrice, stopPrice, 1);
      Object.assign(a.evidence, { refPrice, atr: atr.atr, atrSource: atr.source, atrDetail: atr.detail, stopPct, stopPrice, qty });
      if (qty < 1) return await this.skip(a, 'SIZE_ZERO', `${b.sizing.kind} ₹${b.sizing.amount} buys no unit at ₹${refPrice} with the stop at ₹${stopPrice}`);

      const vehicle = b.vehicle.kind === 'MTF' ? 'MTF' : 'CASH_INTRADAY';
      const capitalPerUnit = marginFor(vehicle, new Prisma.Decimal(refPrice), settings.settings).toNumber();
      const intent: CoreEntryIntent = {
        kind: 'ENTRY',
        intentId,
        userId: sel.userId,
        strategyId: sel.strategyId,
        strategyVersionId: sel.strategyVersionId,
        vehicle,
        exchange: hit.exchange,
        symbol: hit.tradingSymbol,
        underlying: hit.symbol.trim().toUpperCase(),
        side: hit.side,
        optionType: null,
        qty,
        lotSize: 1,
        refPrice,
        refPriceFresh: latest.ok,
        stopPrice,
        capitalPerUnit,
        mtfLeverage: vehicle === 'MTF' && capitalPerUnit > 0 ? round2(refPrice / capitalPerUnit) : null,
      };
      const verdict = await this.wall.check(intent, new Date());
      a.evidence.verdict = { verdict: verdict.verdict, qty: verdict.qty, reasons: verdict.reasons.map((r) => r.code) };
      if (verdict.verdict === 'REJECT') return await this.skip(a, 'RISK_REJECT', verdict.reasons.map((r) => `${r.code}: ${r.message}`).join('; '));
      if (this.config.mode !== 'paper') return this.dryRun(a, verdict);

      let positionId: string;
      try {
        const pos = await this.lifecycle.openPosition(
          { intent, qty: verdict.qty, instrument: { exchange: hit.exchange, token: hit.token, symbol: hit.tradingSymbol, lotSize: 1, underlying: null }, atr: atr.atr, limits: verdict.limits, option: null },
          new Date(),
        );
        positionId = pos.id;
      } catch (err) {
        return await this.skip(a, 'OPEN_REFUSED', errorText(err));
      }
      await this.setup(a, true, `opened ${positionId} for ${verdict.qty}`);
      return { kind: 'OPENED', intentId, positionId, qty: verdict.qty };
    } catch (err) {
      return this.skip(a, 'INTERNAL_ERROR', errorText(err));
    } finally {
      if (watched) this.market.release(sel.userId, ref, owner);
    }
  }

  private skipEntry(a: Attempt, reason: SkipReason, detail: string, extra: Record<string, unknown> = {}) {
    const ltp = typeof a.evidence.ltp === 'number' ? a.evidence.ltp : null;
    return {
      type: 'INTENT_SKIPPED' as const,
      userId: a.sel.userId,
      at: new Date(),
      strategyId: a.sel.strategyId,
      strategyVersionId: a.sel.strategyVersionId,
      intentId: a.intentId,
      symbol: a.hit.tradingSymbol,
      payload: { reason, detail, token: a.hit.token, exchange: a.hit.exchange, side: a.hit.side, alertPrice: a.hit.hitPrice, ltp, ...extra },
      priceUsed: ltp,
      dedupeKey: `skip:${a.intentId}`,
    };
  }

  private async skip(a: Attempt, reason: SkipReason, detail: string): Promise<IntakeOutcome> {
    this.journal.record(this.skipEntry(a, reason, detail));
    if (this.config.mode === 'paper') await this.setup(a, false, `${reason}: ${detail}`);
    return { kind: 'SKIPPED', intentId: a.intentId, reason, detail };
  }

  private dryRun(a: Attempt, v: RiskVerdict): IntakeOutcome {
    const detail = `would open ${v.qty} (${v.verdict}); CORE_ENTRIES_MODE=${this.config.mode}`;
    this.journal.record(this.skipEntry(a, 'ENTRIES_DRY_RUN', detail, { verdict: a.evidence.verdict }));
    return { kind: 'DRY_RUN', intentId: a.intentId, verdict: v.verdict, qty: v.qty };
  }

  /** O9: the corpus row; a failure is logged and never affects the entry. */
  private async setup(a: Attempt, taken: boolean, reason: string): Promise<void> {
    try {
      await this.corpus.entrySetup({
        intentId: a.intentId,
        userId: a.sel.userId,
        decidedAt: a.at,
        symbol: a.hit.tradingSymbol,
        exchange: a.hit.exchange,
        vehicle: a.sel.blocks.vehicle.kind,
        direction: a.hit.side === 'BUY' ? 'LONG' : 'SHORT',
        strategyKey: a.sel.strategyKey,
        strategyVersionId: a.sel.strategyVersionId,
        setupGroupKey: setupGroupKey(a.hit.alertId, a.hit.symbol, a.at),
        evidence: a.evidence,
        ruleScore: a.hit.score,
        decision: { taken, reason },
      });
    } catch (err) {
      this.logger.warn(`corpus setup ${a.intentId} not written: ${errorText(err)}`);
    }
  }
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `cd apps/api && npx jest src/modules/trade-core/intake`
Expected: PASS (all intake specs).

- [ ] **Step 5: Commit**

```bash
git add -- apps/api/src/modules/trade-core/intake/entry-config.ts apps/api/src/modules/trade-core/intake/entry-config.spec.ts apps/api/src/modules/trade-core/intake/core-entry-intake.service.ts apps/api/src/modules/trade-core/intake/core-entry-intake.service.spec.ts
git commit -m "feat(trade-core): M5 CoreEntryIntake — Chartink hits to Risk Wall to paper positions, behind CORE_ENTRIES_MODE" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/api/src/modules/trade-core/intake/entry-config.ts apps/api/src/modules/trade-core/intake/entry-config.spec.ts apps/api/src/modules/trade-core/intake/core-entry-intake.service.ts apps/api/src/modules/trade-core/intake/core-entry-intake.service.spec.ts
```

---

### Task 8: The Chartink hand-off call (the only silo change)

**Files:**
- Modify: `apps/api/src/modules/chartink/services/chartink-process.service.ts` (one import; one call at the end of `processOne`)
- Test: `apps/api/src/modules/chartink/services/__tests__/chartink-core-handoff.spec.ts` (new; the existing silo spec is untouched)

**Interfaces:**
- Consumes: `handOffChartinkHit`, `setCoreAlertIntake`, `ChartinkHit` (Task 4).
- Produces: every scored hit reaches the registered intake once, after all silo paths.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/modules/chartink/services/__tests__/chartink-core-handoff.spec.ts
import { Test } from '@nestjs/testing';
import * as marketHours from '../../../../common/utils/market-hours';
import { AdaptiveStopWatchService } from '../../../adaptive-stop-track/services/adaptive-stop-watch.service';
import { AnandDualTrackService } from '../../../anand-dual-track/services/anand-dual-track.service';
import { BreakoutSwingService } from '../../../breakout-swing-track/services/breakout-swing.service';
import { MarketDataRepository } from '../../../market-data/repositories/market-data.repository';
import { AngelOneAdapterService } from '../../../market-data/services/angel-one-adapter.service';
import { NseSectorIndexService } from '../../../market-data/services/nse-sector-index.service';
import { SellFuturesRejectionRepository } from '../../../sell-futures-track/repositories/sell-futures-rejection.repository';
import { SellFuturesService } from '../../../sell-futures-track/services/sell-futures.service';
import { LevelBookService } from '../../../signal-generator/services/level-book.service';
import { setCoreAlertIntake } from '../../../trade-core/intake/alert-handoff';
import { UngatedRejectionRepository } from '../../../ungated-track/repositories/ungated-rejection.repository';
import { UngatedWatchService } from '../../../ungated-track/services/ungated-watch.service';
import { WatchService } from '../../../watch-monitor/services/watch.service';
import { ChartinkRepository } from '../../repositories/chartink.repository';
import { ChartinkProcessService } from '../chartink-process.service';
import { ChartinkScoringService } from '../chartink-scoring.service';

/** SP2 M5 (O3, J2): the core hand-off at the end of processOne, and its isolation from the silo paths. */
const UP = Array.from({ length: 50 }, (_, i) => ({ close: 100 + i, open: 100 + i, high: 100 + i, low: 100 + i, volume: 1000, timestamp: new Date() }));

async function build(candles: unknown[] = UP) {
  const mocks = {
    repo: { createAlertSetup: jest.fn().mockResolvedValue({ id: 'setup-row-1' }) },
    mdRepo: { getInstrumentBySymbol: jest.fn(), getInstrumentByToken: jest.fn().mockResolvedValue({ token: '99926019' }) },
    scoring: { score: jest.fn().mockResolvedValue({ score: 70, lotCount: 2, checks: [] }), scoreToLotCount: jest.fn() },
    angelOne: { getHistoricalData: jest.fn().mockResolvedValue(candles), resolveSymbolToken: jest.fn().mockResolvedValue({ token: '2885', tradingSymbol: 'RELIANCE-EQ' }) },
    nseSector: { getSectorIndexForSymbol: jest.fn().mockResolvedValue('99926019') },
    watch: { createFromAlert: jest.fn().mockResolvedValue({ id: 'w1' }) },
    ungated: { createFromAlert: jest.fn().mockResolvedValue({ id: 'uw1' }) },
    adaptive: { createFromAlert: jest.fn().mockResolvedValue({ id: 'as1' }) },
    ungatedRejections: { record: jest.fn().mockResolvedValue(undefined) },
    anand: { createEntries: jest.fn().mockResolvedValue(undefined) },
    breakout: { createFromAlert: jest.fn().mockResolvedValue({ id: 'bs1' }) },
    sellFutures: { createFromAlert: jest.fn().mockResolvedValue({ id: 'sf1' }) },
    sellFuturesRejections: { record: jest.fn().mockResolvedValue(undefined) },
    levelBook: { lazyLoad: jest.fn().mockResolvedValue(null) },
  };
  const moduleRef = await Test.createTestingModule({
    providers: [
      ChartinkProcessService,
      { provide: ChartinkRepository, useValue: mocks.repo },
      { provide: MarketDataRepository, useValue: mocks.mdRepo },
      { provide: ChartinkScoringService, useValue: mocks.scoring },
      { provide: AngelOneAdapterService, useValue: mocks.angelOne },
      { provide: NseSectorIndexService, useValue: mocks.nseSector },
      { provide: WatchService, useValue: mocks.watch },
      { provide: UngatedWatchService, useValue: mocks.ungated },
      { provide: AdaptiveStopWatchService, useValue: mocks.adaptive },
      { provide: UngatedRejectionRepository, useValue: mocks.ungatedRejections },
      { provide: AnandDualTrackService, useValue: mocks.anand },
      { provide: BreakoutSwingService, useValue: mocks.breakout },
      { provide: SellFuturesService, useValue: mocks.sellFutures },
      { provide: SellFuturesRejectionRepository, useValue: mocks.sellFuturesRejections },
      { provide: LevelBookService, useValue: mocks.levelBook },
    ],
  }).compile();
  return { service: moduleRef.get(ChartinkProcessService), mocks };
}

/** What the silo did, as comparable data. */
const siloCalls = (m: Awaited<ReturnType<typeof build>>['mocks']) => ({
  setups: m.repo.createAlertSetup.mock.calls,
  watch: m.watch.createFromAlert.mock.calls,
  ungated: m.ungated.createFromAlert.mock.calls,
  adaptive: m.adaptive.createFromAlert.mock.calls,
  sellFutures: m.sellFutures.createFromAlert.mock.calls,
});

beforeEach(() => {
  jest.useFakeTimers({ now: new Date('2026-05-19T04:30:00Z'), doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
  jest.spyOn(marketHours, 'isWithinEntryWindow').mockReturnValue(true);
});
afterEach(() => {
  setCoreAlertIntake(null);
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('ChartinkProcessService → core hand-off (SP2 M5)', () => {
  it('hands a scored hit to the core once, after the silo paths, with the trading symbol, side and score', async () => {
    const { service, mocks } = await build();
    const accept = jest.fn();
    setCoreAlertIntake({ accept });
    await service.processOne('alert_1', { symbol: 'RELIANCE', hitPrice: 100 }, 'Hull MA cross', 'INTRADAY');
    expect(accept).toHaveBeenCalledTimes(1);
    expect(accept).toHaveBeenCalledWith({
      alertId: 'alert_1', symbol: 'RELIANCE', tradingSymbol: 'RELIANCE-EQ', token: '2885', exchange: 'NSE', hitPrice: 100,
      scanName: 'Hull MA cross', side: 'BUY', score: 70, receivedAt: expect.any(Date),
    });
    expect(mocks.watch.createFromAlert.mock.invocationCallOrder[0]).toBeLessThan(accept.mock.invocationCallOrder[0]);
    expect(mocks.ungated.createFromAlert.mock.invocationCallOrder[0]).toBeLessThan(accept.mock.invocationCallOrder[0]);
  });

  it('a throwing core intake changes nothing in the silo path (Review Focus 1)', async () => {
    const plain = await build();
    await plain.service.processOne('alert_1', { symbol: 'RELIANCE', hitPrice: 100 }, 'Hull MA cross', 'INTRADAY');
    const throwing = await build();
    setCoreAlertIntake({ accept: () => { throw new Error('core broke'); } });
    await expect(throwing.service.processOne('alert_1', { symbol: 'RELIANCE', hitPrice: 100 }, 'Hull MA cross', 'INTRADAY')).resolves.toBeUndefined();
    expect(siloCalls(throwing.mocks)).toEqual(siloCalls(plain.mocks));
  });

  it('an unscored hit (no direction) never reaches the core', async () => {
    const { service } = await build([]);
    const accept = jest.fn();
    setCoreAlertIntake({ accept });
    await service.processOne('alert_1', { symbol: 'RELIANCE', hitPrice: 100 }, 'Hull MA cross', 'INTRADAY');
    expect(accept).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx jest src/modules/chartink/services/__tests__/chartink-core-handoff.spec.ts`
Expected: FAIL — `accept` was called 0 times (the first and third tests: the third passes already; the second passes trivially).

- [ ] **Step 3: Add the call**

In `chartink-process.service.ts`, add to the imports:

```ts
import { handOffChartinkHit } from '../../trade-core/intake/alert-handoff';
```

and at the very end of `processOne`, after the `// === 6. SELL-FUTURES shadow track` block and before the closing brace
(after the comment about the Anand dual-track):

```ts
    // === 7. SP2 core fan-out (docs/superpowers/plans/2026-10-13-sp2-m5-journal-and-entries.md, O3/J2). ===
    // After every silo path above: hand the scored hit to the trade core. Synchronous, never throws,
    // never awaited — the core only queues it, so nothing the core does can change the silo outcome.
    // With CORE_ENTRIES_MODE=off no intake is registered and this is a no-op.
    handOffChartinkHit({
      alertId,
      symbol: hit.symbol,
      tradingSymbol: resolved.tradingSymbol,
      token: instrument.token,
      exchange: 'NSE',
      hitPrice: hit.hitPrice,
      scanName: scanName ?? null,
      side,
      score: scoringResult.score,
      receivedAt: new Date(),
    });
```

- [ ] **Step 4: Run the chartink specs to verify they pass and nothing else moved**

Run: `cd apps/api && npx jest src/modules/chartink`
Expected: PASS — the new spec (3 tests) and the existing `chartink-process.service.spec.ts` unchanged and green (no
intake is registered there, so the call is a no-op).

- [ ] **Step 5: Commit**

```bash
git add -- apps/api/src/modules/chartink/services/__tests__/chartink-core-handoff.spec.ts
git commit -m "feat(chartink): hand scored hits to the SP2 core after the silo paths (fire-and-forget)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/api/src/modules/chartink/services/chartink-process.service.ts apps/api/src/modules/chartink/services/__tests__/chartink-core-handoff.spec.ts
```

---

## Stream C — the journal writers

### Task 9: `CoreJournalService` and the two sinks M2/M4 left as logging ports

**Files:**
- Create: `apps/api/src/modules/trade-core/journal/core-journal.service.ts`
- Test: `apps/api/src/modules/trade-core/journal/core-journal.service.spec.ts`
- Create: `apps/api/src/modules/trade-core/journal/journal-sinks.ts`
- Test: `apps/api/src/modules/trade-core/journal/journal-sinks.spec.ts`

**Interfaces:**
- Consumes: `CoreJournalRepository.append` (Task 2), `MemoryJournalStore`, `FakeJournal`; Task 1 ports;
  M4 `LifecycleEventSink`, `LifecycleEvent`; M2 `RiskVerdictSink`, `RiskVerdict`; `istDate`.
- Produces:
  - `JOURNAL_BUFFER_MAX = 1_000`, `JOURNAL_RETRY_MS = 5_000`, `JOURNAL_BATCH = 100`;
    `CoreJournalService implements CoreJournalPort` with `record`, `recordNow`, `flush(): Promise<void>`,
    `status(): { pending: number; written: number; dropped: number; failures: number; lastError: string | null }` (Task 17 reads it).
  - `STOP_MOVED_COALESCE_MS = 30_000`; `JournalLifecycleSink implements LifecycleEventSink` (constructor
    `(journal: CoreJournalPort, closed?: PositionClosedListener)`); `JournalRiskVerdictSink implements RiskVerdictSink`
    (constructor `(journal: CoreJournalPort)`); exported `lifecycleEntry(e: LifecycleEvent): JournalEntry`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/modules/trade-core/journal/core-journal.service.spec.ts
import { CoreJournalService, JOURNAL_BUFFER_MAX } from './core-journal.service';
import type { JournalEntry } from './journal.types';
import { MemoryJournalStore } from './testing/memory-journal-store';

const AT = new Date('2026-10-13T05:00:00.000Z');
const e = (type: JournalEntry['type'], dedupeKey: string | null = null): JournalEntry => ({ userId: 'user_A', type, at: AT, payload: {}, dedupeKey });

function setup() {
  const store = new MemoryJournalStore();
  return { store, journal: new CoreJournalService(store.repo) };
}

describe('CoreJournalService (ruling J10, Review Focus 3)', () => {
  it('record writes in the order given, batched, never throwing', async () => {
    const { store, journal } = setup();
    journal.record(e('ORDER_PLACED'));
    journal.record(e('ORDER_STATE'));
    journal.record(e('FILL'));
    await journal.flush();
    expect(store.rows.map((r) => r.type)).toEqual(['ORDER_PLACED', 'ORDER_STATE', 'FILL']);
    expect(journal.status()).toMatchObject({ pending: 0, written: 3, dropped: 0, failures: 0 });
  });

  it('a failed batch stays queued and is retried in order once the store is back', async () => {
    const { store, journal } = setup();
    store.failWrites = true;
    journal.record(e('BLIND'));
    journal.record(e('POSITION_STATE'));
    await journal.flush();
    expect(store.rows).toEqual([]);
    expect(journal.status()).toMatchObject({ pending: 2, failures: 1, lastError: 'journal down' });
    store.failWrites = false;
    await journal.flush();
    expect(store.rows.map((r) => r.type)).toEqual(['BLIND', 'POSITION_STATE']);
    expect(journal.status().pending).toBe(0);
  });

  it(`a full buffer (${JOURNAL_BUFFER_MAX}) drops further rows and counts them; it never throws`, async () => {
    const { store, journal } = setup();
    store.failWrites = true;
    for (let i = 0; i < JOURNAL_BUFFER_MAX + 3; i += 1) expect(() => journal.record(e('STOP_MOVED'))).not.toThrow();
    await journal.flush();
    expect(journal.status()).toMatchObject({ pending: JOURNAL_BUFFER_MAX, dropped: 3 });
  });

  it('recordNow resolves once written (a duplicate key is fine) and rejects when the store is down', async () => {
    const { store, journal } = setup();
    await journal.recordNow(e('DAILY_LOSS_LATCHED', 'latch:user_A:2026-10-13'));
    await expect(journal.recordNow(e('DAILY_LOSS_LATCHED', 'latch:user_A:2026-10-13'))).resolves.toBeUndefined();
    expect(store.rows).toHaveLength(1);
    store.failWrites = true;
    await expect(journal.recordNow(e('RISK_VERDICT'))).rejects.toThrow('journal down');
  });

  it('shutdown flushes what is queued', async () => {
    const { store, journal } = setup();
    journal.record(e('EXIT_DECIDED'));
    await journal.onModuleDestroy();
    expect(store.rows.map((r) => r.type)).toEqual(['EXIT_DECIDED']);
  });
});
```

```ts
// apps/api/src/modules/trade-core/journal/journal-sinks.spec.ts
import { limitsFixture } from '../risk-wall/testing/risk-fixtures';
import type { RiskVerdict } from '../risk-wall/risk-wall.types';
import type { LifecycleEvent } from '../lifecycle/lifecycle.types';
import { JournalLifecycleSink, JournalRiskVerdictSink, STOP_MOVED_COALESCE_MS } from './journal-sinks';
import { FakeJournal } from './testing/fake-journal';

const T0 = new Date('2026-10-13T05:00:00.000Z');
const ev = (type: LifecycleEvent['type'], payload: Record<string, unknown>, atMs = 0, positionId = 'pos_1'): LifecycleEvent => ({
  type, userId: 'user_A', positionId, strategyVersionId: 'csv_x', payload, priceUsed: 500, priceAgeMs: 12, at: new Date(T0.getTime() + atMs),
});

describe('JournalLifecycleSink (L12 rebound; J15, J16)', () => {
  it('writes each lifecycle event as a journal row with its price and age', async () => {
    const j = new FakeJournal();
    await new JournalLifecycleSink(j).record(ev('EXIT_DECIDED', { reason: 'STOP' }));
    expect(j.entries).toEqual([{ type: 'EXIT_DECIDED', userId: 'user_A', at: T0, positionId: 'pos_1', strategyVersionId: 'csv_x', payload: { reason: 'STOP' }, priceUsed: 500, priceAgeMs: 12 }]);
  });

  it('coalesces trailing stop moves to one per 30 s per position; the newest held move is written before the next other event', async () => {
    const j = new FakeJournal();
    const sink = new JournalLifecycleSink(j);
    await sink.record(ev('STOP_MOVED', { from: 490, to: 491, why: 'TRAIL' }, 0));
    await sink.record(ev('STOP_MOVED', { from: 491, to: 492, why: 'TRAIL' }, 1_000));
    await sink.record(ev('STOP_MOVED', { from: 492, to: 493, why: 'TRAIL' }, 2_000));
    await sink.record(ev('STOP_MOVED', { from: 0, to: 600, why: 'TRAIL' }, 3_000, 'pos_2'));
    expect(j.entries.map((x) => [x.positionId, x.payload.to])).toEqual([['pos_1', 491], ['pos_2', 600]]);
    await sink.record(ev('EXIT_DECIDED', { reason: 'TRAIL' }, 4_000));
    expect(j.entries.map((x) => [x.type, x.payload.to ?? x.payload.reason])).toEqual([['STOP_MOVED', 491], ['STOP_MOVED', 600], ['STOP_MOVED', 493], ['EXIT_DECIDED', 'TRAIL']]);
    await sink.record(ev('STOP_MOVED', { from: 493, to: 494, why: 'TRAIL' }, 3_000 + STOP_MOVED_COALESCE_MS));
    expect(j.entries[j.entries.length - 1].payload.to).toBe(494);
  });

  it('a guard-rail stop move is never coalesced', async () => {
    const j = new FakeJournal();
    const sink = new JournalLifecycleSink(j);
    await sink.record(ev('STOP_MOVED', { from: 490, to: 491, why: 'TRAIL' }, 0));
    await sink.record(ev('STOP_MOVED', { source: 'sentinel', from: 491, to: 495, why: 'GUARD_RAIL', accepted: true }, 1_000));
    expect(j.entries.map((x) => x.payload.to)).toEqual([491, 495]);
  });

  it('a close tells the summary writer; its failure is logged and never thrown', async () => {
    const j = new FakeJournal();
    const closed = { positionClosed: jest.fn().mockRejectedValueOnce(new Error('summary db down')).mockResolvedValue(undefined) };
    const sink = new JournalLifecycleSink(j, closed);
    await expect(sink.record(ev('POSITION_STATE', { from: 'EXITING', to: 'CLOSED' }))).resolves.toBeUndefined();
    await sink.record(ev('POSITION_STATE', { from: 'PENDING_ENTRY', to: 'CANCELLED' }, 0, 'pos_2'));
    expect(closed.positionClosed).toHaveBeenCalledTimes(1);
    expect(closed.positionClosed).toHaveBeenCalledWith('user_A', 'pos_1');
  });
});

describe('JournalRiskVerdictSink (M2 RISK_VERDICT_SINK rebound; J10, J13)', () => {
  const verdict = (over: Partial<RiskVerdict> = {}): RiskVerdict => ({
    intentId: 'ci_1', userId: 'user_A', intentKind: 'ENTRY', verdict: 'ALLOW', requestedQty: 10, qty: 10, reasons: [{ code: 'WITHIN_LIMITS', message: 'ok' }],
    limits: limitsFixture(), state: null, dailyLoss: null, killSwitchActive: false, checkedAt: T0.toISOString(), ...over,
  });

  it('writes the whole verdict (limits snapshot included) durably', async () => {
    const j = new FakeJournal();
    await new JournalRiskVerdictSink(j).record(verdict());
    expect(j.entries).toEqual([expect.objectContaining({ type: 'RISK_VERDICT', userId: 'user_A', intentId: 'ci_1', at: T0, payload: expect.objectContaining({ limits: limitsFixture() }) })]);
  });

  it('a verdict that cannot be recorded throws to the wall (which then rejects the entry: JOURNAL_UNAVAILABLE)', async () => {
    const j = new FakeJournal();
    j.failNow = true;
    await expect(new JournalRiskVerdictSink(j).record(verdict())).rejects.toThrow('journal down');
  });

  it('a DAILY_LOSS rejection also latches the day (idempotent per user and IST day)', async () => {
    const j = new FakeJournal();
    const dailyLoss = { status: 'BREACHED' as const, lossRupees: '5000.00', limitRupees: '5000.00', action: 'BLOCK_ENTRIES' as const, squareOffCore: false };
    await new JournalRiskVerdictSink(j).record(verdict({ verdict: 'REJECT', qty: 0, reasons: [{ code: 'DAILY_LOSS', message: 'x' }], dailyLoss }));
    expect(j.ofType('DAILY_LOSS_LATCHED')).toEqual([
      expect.objectContaining({ dedupeKey: 'latch:user_A:2026-10-13', payload: { day: '2026-10-13', source: 'RISK_VERDICT', lossRupees: '5000.00', limitRupees: '5000.00', action: 'BLOCK_ENTRIES' } }),
    ]);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/api && npx jest src/modules/trade-core/journal/core-journal.service.spec.ts src/modules/trade-core/journal/journal-sinks.spec.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/modules/trade-core/journal/core-journal.service.ts
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { CoreJournalPort } from './journal-ports';
import type { JournalEntry } from './journal.types';
import { CoreJournalRepository } from './repositories/core-journal.repository';

/** Load bounds (Global Constraints). */
export const JOURNAL_BUFFER_MAX = 1_000;
export const JOURNAL_RETRY_MS = 5_000;
export const JOURNAL_BATCH = 100;

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Ruling J10. `record` never throws and never blocks its caller (lifecycle decisions, order
 * updates, the intake): rows wait in an ordered, bounded buffer and are written in batches; a
 * failed batch stays at the head and is retried every 5 s; when the buffer is full further rows
 * are dropped and counted (the newest go, so a batch in flight stays aligned). `recordNow` is for
 * callers that must know the row exists (the Risk Wall verdict, the latch, recon, follow-ups).
 */
@Injectable()
export class CoreJournalService implements CoreJournalPort, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('CoreJournal');
  private readonly pending: JournalEntry[] = [];
  private flushing: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private written = 0;
  private dropped = 0;
  private failures = 0;
  private lastError: string | null = null;

  constructor(private readonly repo: CoreJournalRepository) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.flush(), JOURNAL_RETRY_MS);
    this.timer.unref?.();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
  }

  record(e: JournalEntry): void {
    if (this.pending.length >= JOURNAL_BUFFER_MAX) {
      this.dropped += 1;
      this.logger.error(`journal buffer full (${JOURNAL_BUFFER_MAX}): ${e.type} for ${e.userId} dropped (${this.dropped} so far)`);
      return;
    }
    this.pending.push(e);
    void this.flush();
  }

  async recordNow(e: JournalEntry): Promise<void> {
    try {
      this.written += await this.repo.append([e]);
    } catch (err) {
      this.failures += 1;
      this.lastError = errorText(err);
      throw err;
    }
  }

  flush(): Promise<void> {
    if (!this.flushing) this.flushing = this.drain().finally(() => { this.flushing = null; });
    return this.flushing;
  }

  status(): { pending: number; written: number; dropped: number; failures: number; lastError: string | null } {
    return { pending: this.pending.length, written: this.written, dropped: this.dropped, failures: this.failures, lastError: this.lastError };
  }

  private async drain(): Promise<void> {
    while (this.pending.length > 0) {
      const batch = this.pending.slice(0, JOURNAL_BATCH);
      try {
        this.written += await this.repo.append(batch);
        this.pending.splice(0, batch.length);
      } catch (err) {
        this.failures += 1;
        this.lastError = errorText(err);
        this.logger.error(`journal write failed; ${this.pending.length} row(s) kept for the next try: ${this.lastError}`);
        return;
      }
    }
  }
}
```

```ts
// apps/api/src/modules/trade-core/journal/journal-sinks.ts
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { istDate } from '../execution/ledger-math';
import type { LifecycleEventSink } from '../lifecycle/lifecycle-events';
import type { LifecycleEvent } from '../lifecycle/lifecycle.types';
import type { RiskVerdictSink } from '../risk-wall/ports';
import type { RiskVerdict } from '../risk-wall/risk-wall.types';
import { CORE_JOURNAL, CORE_POSITION_CLOSED, type CoreJournalPort, type PositionClosedListener } from './journal-ports';
import type { JournalEntry } from './journal.types';

/** Ruling J15: at most one trailing STOP_MOVED row per position in this window. */
export const STOP_MOVED_COALESCE_MS = 30_000;

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function lifecycleEntry(e: LifecycleEvent): JournalEntry {
  return {
    type: e.type,
    userId: e.userId,
    at: e.at,
    positionId: e.positionId,
    strategyVersionId: e.strategyVersionId,
    payload: e.payload,
    priceUsed: e.priceUsed,
    priceAgeMs: e.priceAgeMs,
  };
}

/** A rule-driven trailing move (breakeven / ATR trail / re-arm), not a guard-rail proposal. */
const isTrailMove = (e: LifecycleEvent): boolean => e.type === 'STOP_MOVED' && e.payload.why !== 'GUARD_RAIL' && e.payload.source === undefined;

/**
 * M4 ruling L12 rebound to core_journal. The lifecycle calls record() without awaiting it and
 * logs a rejection, so nothing here can delay a decision. A close (POSITION_STATE → CLOSED) is
 * handed to the summary writer (J16), whose failure is logged; the reconciler repairs it.
 */
@Injectable()
export class JournalLifecycleSink implements LifecycleEventSink {
  private readonly logger = new Logger(JournalLifecycleSink.name);
  private readonly lastStopAt = new Map<string, number>();
  private readonly heldStop = new Map<string, LifecycleEvent>();

  constructor(
    @Inject(CORE_JOURNAL) private readonly journal: CoreJournalPort,
    @Optional() @Inject(CORE_POSITION_CLOSED) private readonly closed?: PositionClosedListener,
  ) {}

  async record(e: LifecycleEvent): Promise<void> {
    if (isTrailMove(e)) {
      const last = this.lastStopAt.get(e.positionId);
      if (last !== undefined && e.at.getTime() - last < STOP_MOVED_COALESCE_MS) {
        this.heldStop.set(e.positionId, e);
        return;
      }
      this.heldStop.delete(e.positionId);
      this.lastStopAt.set(e.positionId, e.at.getTime());
    } else {
      this.flushHeld(e.positionId);
    }
    this.journal.record(lifecycleEntry(e));

    const to = e.type === 'POSITION_STATE' ? e.payload.to : null;
    if (to === 'CLOSED' || to === 'CANCELLED') {
      this.lastStopAt.delete(e.positionId);
      this.heldStop.delete(e.positionId);
    }
    if (to === 'CLOSED' && this.closed) {
      try {
        await this.closed.positionClosed(e.userId, e.positionId);
      } catch (err) {
        this.logger.error(`summary for closed position ${e.positionId} not written (the reconciler repairs it): ${errorText(err)}`);
      }
    }
  }

  private flushHeld(positionId: string): void {
    const held = this.heldStop.get(positionId);
    if (!held) return;
    this.heldStop.delete(positionId);
    this.lastStopAt.set(positionId, held.at.getTime());
    this.journal.record(lifecycleEntry(held));
  }
}

/**
 * M2's RISK_VERDICT_SINK rebound to core_journal (J10): awaited, so a verdict that cannot be
 * recorded rejects the entry (RiskWallService maps it to JOURNAL_UNAVAILABLE) while an exit
 * verdict's failure is only logged there. A DAILY_LOSS rejection latches the IST day (J13).
 */
@Injectable()
export class JournalRiskVerdictSink implements RiskVerdictSink {
  constructor(@Inject(CORE_JOURNAL) private readonly journal: CoreJournalPort) {}

  async record(v: RiskVerdict): Promise<void> {
    const at = new Date(v.checkedAt);
    await this.journal.recordNow({ type: 'RISK_VERDICT', userId: v.userId, at, intentId: v.intentId, payload: v as unknown as Record<string, unknown> });
    if (v.reasons.some((r) => r.code === 'DAILY_LOSS')) {
      const day = istDate(at);
      this.journal.record({
        type: 'DAILY_LOSS_LATCHED',
        userId: v.userId,
        at,
        intentId: v.intentId,
        payload: { day, source: 'RISK_VERDICT', lossRupees: v.dailyLoss?.lossRupees ?? null, limitRupees: v.dailyLoss?.limitRupees ?? null, action: v.dailyLoss?.action ?? null },
        dedupeKey: `latch:${v.userId}:${day}`,
      });
    }
  }
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `cd apps/api && npx jest src/modules/trade-core/journal`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -- apps/api/src/modules/trade-core/journal/core-journal.service.ts apps/api/src/modules/trade-core/journal/core-journal.service.spec.ts apps/api/src/modules/trade-core/journal/journal-sinks.ts apps/api/src/modules/trade-core/journal/journal-sinks.spec.ts
git commit -m "feat(trade-core): M5 CoreJournalService and the journal sinks for lifecycle events and risk verdicts" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/api/src/modules/trade-core/journal/core-journal.service.ts apps/api/src/modules/trade-core/journal/core-journal.service.spec.ts apps/api/src/modules/trade-core/journal/journal-sinks.ts apps/api/src/modules/trade-core/journal/journal-sinks.spec.ts
```

---

### Task 10: Order and fill rows; kill-switch and limit-change rows

**Files:**
- Create: `apps/api/src/modules/trade-core/journal/order-journaler.ts`
- Test: `apps/api/src/modules/trade-core/journal/order-journaler.spec.ts`
- Modify: `apps/api/src/modules/trade-core/risk-wall/services/core-kill-switch.service.ts` (optional journal; one `record` call)
- Modify: `apps/api/src/modules/trade-core/risk-wall/services/core-risk-limit.service.ts` (optional journal; one `record` call)
- Modify: `apps/api/src/modules/trade-core/risk-wall/services/core-kill-switch.service.spec.ts`, `core-risk-limit.service.spec.ts` (`setup` passes a `FakeJournal`; one new test each)

**Interfaces:**
- Consumes: `ExecutionAdapter.onOrderUpdate(fn): () => void` (M4), `CORE_EXECUTION_ADAPTER`, `CoreOrder`;
  `PaperLedgerService.fillsFor(userId, orderIds)` (Task 3); `CORE_JOURNAL`; M4 `lifecycleHarness`, `openRequest`.
- Produces: `OrderJournaler` (`onModuleInit` subscribes, `onOrder(o): Promise<void>`); `CoreKillSwitchService` and
  `CoreRiskLimitService` gain an `@Optional() @Inject(CORE_JOURNAL)` last constructor parameter (J23).

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/modules/trade-core/journal/order-journaler.spec.ts
import { NOW } from '../lifecycle/testing/lifecycle-fixtures';
import { lifecycleHarness, openRequest } from '../lifecycle/testing/lifecycle-harness';
import { OrderJournaler } from './order-journaler';
import { FakeJournal } from './testing/fake-journal';

beforeEach(() => jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] }));
afterEach(() => jest.useRealTimers());

async function settleJournaler() {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
}

describe('OrderJournaler (spec §8.1 ORDER_PLACED, ORDER_STATE, FILL)', () => {
  it('journals placement, each state and each fill once, keyed for idempotence, with the position', async () => {
    const h = lifecycleHarness();
    const journal = new FakeJournal();
    const oj = new OrderJournaler(h.adapter, h.ledger, journal);
    oj.onModuleInit();
    const p = await h.lifecycle.openPosition(openRequest());
    await h.price(500);
    await settleJournaler();
    const entry = h.ordersOf(p.id)[0];
    expect(journal.ofType('ORDER_PLACED')).toEqual([
      expect.objectContaining({ positionId: p.id, symbol: 'RELIANCE-EQ', dedupeKey: `order:${entry.id}:placed`, payload: expect.objectContaining({ orderId: entry.id, purpose: 'ENTRY', side: 'BUY', qty: 100 }) }),
    ]);
    expect(journal.ofType('ORDER_STATE').map((x) => x.payload.state)).toContain('FILLED');
    const fills = journal.ofType('FILL');
    // FakeJournal does not dedupe; the store does, by key — so one fill means one distinct key.
    const keys = [...new Set(fills.map((f) => f.dedupeKey))];
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^fill:/);
    expect(fills[0]).toMatchObject({ positionId: p.id, priceUsed: 500, payload: expect.objectContaining({ orderId: entry.id, qty: 100, price: '500.0000' }) });
    oj.onModuleDestroy();
  });

  it('a fill read failure is logged; the order rows are still written', async () => {
    const order: CoreOrder = {
      id: 'ord_x', userId: 'user_A', idempotencyKey: 'ci_1:entry', vehicle: 'CASH_INTRADAY',
      instrument: { exchange: 'NSE', token: '2885', symbol: 'RELIANCE-EQ', lotSize: 1, underlying: null },
      side: 'BUY', qty: 10, filledQty: 10, avgFillPrice: 500, type: 'MARKET', limitPrice: null, triggerPrice: null, refPrice: 500,
      purpose: 'ENTRY', strategyVersionId: 'csv_x', positionId: 'pos_1', state: 'FILLED', rejectReason: null,
      submittedAt: NOW, triggeredAt: null, updatedAt: NOW,
    };
    const journal = new FakeJournal();
    const adapter = { onOrderUpdate: jest.fn(() => () => undefined) };
    const ledger = { fillsFor: jest.fn().mockRejectedValue(new Error('db down')) };
    const oj = new OrderJournaler(adapter as unknown as ExecutionAdapter, ledger as unknown as PaperLedgerService, journal);
    await oj.onOrder(order);
    expect(journal.types()).toEqual(['ORDER_PLACED', 'ORDER_STATE']);
    expect(journal.entries[1]).toMatchObject({ dedupeKey: 'order:ord_x:FILLED:10', positionId: 'pos_1' });
  });
});
```

(Add `import type { CoreOrder, ExecutionAdapter } from '../execution/execution.types';` and
`import type { PaperLedgerService } from '../execution/paper-ledger.service';` to the spec's imports.)

Add to `core-kill-switch.service.spec.ts`: import `FakeJournal` from `../../journal/testing/fake-journal`; in `setup`
create `const journal = new FakeJournal();`, pass `journal` as the **last** constructor argument, and return it. Then:

```ts
  it('M5: every change writes a KILL_SWITCH journal row with the cascade (best effort)', async () => {
    const { service, journal } = setup();
    await service.set(A, { active: true, reason: 'stop now' }, NOW);
    expect(journal.ofType('KILL_SWITCH')).toEqual([
      expect.objectContaining({ userId: 'user_A', at: NOW, payload: expect.objectContaining({ active: true, wasActive: false, reason: 'stop now', cascade: expect.objectContaining({ core: expect.any(Object) }) }) }),
    ]);
  });
```

Add to `core-risk-limit.service.spec.ts`: the same `FakeJournal` in `setup` as the last constructor argument, returned. Then:

```ts
  it('M5: a limit change writes a LIMIT_CHANGED journal row with its direction and effective time', async () => {
    const { service, journal } = setup();
    await service.change('user_A', { key: 'maxTradesPerDay', scope: 'ALL', value: 3, reason: 'fewer' }, NOW);
    expect(journal.ofType('LIMIT_CHANGED')).toEqual([
      expect.objectContaining({ userId: 'user_A', payload: expect.objectContaining({ key: 'maxTradesPerDay', scope: 'ALL', direction: 'TIGHTER', reason: 'fewer' }) }),
    ]);
  });
```

(`maxTradesPerDay` seeded higher than 3 in `limitsFixture`, so 3 is TIGHTER; if the fixture's seed is ≤ 3, use a value
below it.)

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/api && npx jest src/modules/trade-core/journal/order-journaler.spec.ts src/modules/trade-core/risk-wall/services`
Expected: FAIL — `Cannot find module './order-journaler'`; the two new risk-wall tests find no rows.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/modules/trade-core/journal/order-journaler.ts
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { CoreOrder, ExecutionAdapter } from '../execution/execution.types';
import { CORE_EXECUTION_ADAPTER } from '../execution/paper-execution.adapter';
import { PaperLedgerService } from '../execution/paper-ledger.service';
import { CORE_JOURNAL, type CoreJournalPort } from './journal-ports';

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Spec §8.1 ORDER_PLACED / ORDER_STATE / FILL from the adapter's order-update stream (M4 L3). Every
 * row carries a dedupe key, so the repeated emissions of one order and a restart never duplicate.
 */
@Injectable()
export class OrderJournaler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OrderJournaler.name);
  private off: (() => void) | null = null;

  constructor(
    @Inject(CORE_EXECUTION_ADAPTER) private readonly adapter: ExecutionAdapter,
    private readonly ledger: PaperLedgerService,
    @Inject(CORE_JOURNAL) private readonly journal: CoreJournalPort,
  ) {}

  onModuleInit(): void {
    if (!this.off) this.off = this.adapter.onOrderUpdate((o) => void this.onOrder(o));
  }

  onModuleDestroy(): void {
    this.off?.();
    this.off = null;
  }

  async onOrder(o: CoreOrder): Promise<void> {
    const base = { userId: o.userId, positionId: o.positionId ?? null, strategyVersionId: o.strategyVersionId, symbol: o.instrument.symbol };
    this.journal.record({
      ...base, type: 'ORDER_PLACED', at: o.submittedAt, priceUsed: o.refPrice, dedupeKey: `order:${o.id}:placed`,
      payload: { orderId: o.id, idempotencyKey: o.idempotencyKey, purpose: o.purpose, side: o.side, qty: o.qty, type: o.type, vehicle: o.vehicle },
    });
    this.journal.record({
      ...base, type: 'ORDER_STATE', at: o.updatedAt, priceUsed: o.avgFillPrice, dedupeKey: `order:${o.id}:${o.state}:${o.filledQty}`,
      payload: { orderId: o.id, state: o.state, filledQty: o.filledQty, avgFillPrice: o.avgFillPrice, rejectReason: o.rejectReason },
    });
    if (o.filledQty === 0) return;
    try {
      for (const f of await this.ledger.fillsFor(o.userId, [o.id])) {
        this.journal.record({
          ...base, type: 'FILL', at: f.priceAt, priceUsed: f.price.toNumber(), priceAgeMs: Math.max(0, f.createdAt.getTime() - f.priceAt.getTime()), dedupeKey: `fill:${f.id}`,
          payload: { orderId: o.id, fillId: f.id, qty: f.qty, price: f.price.toFixed(4), charges: f.chargesTotal.toFixed(2) },
        });
      }
    } catch (err) {
      this.logger.warn(`fills of core order ${o.id} not journaled this time: ${errorText(err)}`);
    }
  }
}
```

`CoreKillSwitchService` — add imports `Optional` (from `@nestjs/common`) and
`import { CORE_JOURNAL, type CoreJournalPort } from '../../journal/journal-ports';`; constructor gains, as the last parameter:

```ts
    @Optional() @Inject(CORE_JOURNAL) private readonly journal?: CoreJournalPort,
```

and in `set`, right after `const cascade = input.active ? await this.cascade(actor, reason) : null;`:

```ts
    // SP2 M5 (D12): the journal row, best effort — the switch itself is already persisted.
    this.journal?.record({
      type: 'KILL_SWITCH',
      userId: actor.userId,
      at: now,
      payload: { active: input.active, wasActive, reason, effectiveFrom: effectiveFrom.toISOString(), rowId: row.id, cascade: cascade ? { core: cascade.core, silos: cascade.silos } : null },
    });
```

`CoreRiskLimitService` — same imports; constructor gains the same last parameter; in `change`, right after the `row`
append's `try/catch` and before `await this.audit.append(`:

```ts
    // SP2 M5 (D12): the journal row, best effort — the limit row is already persisted.
    this.journal?.record({
      type: 'LIMIT_CHANGED',
      userId,
      at: now,
      payload: { key, scope, from: current, to: parsed.value, direction, effectiveFrom: effectiveFrom.toISOString(), reason, rowId: row.id },
    });
```

- [ ] **Step 4: Run them to verify they pass**

Run: `cd apps/api && npx jest src/modules/trade-core`
Expected: PASS (all trade-core specs; the M2 specs that construct the services without the new argument still compile).

- [ ] **Step 5: Commit**

```bash
git add -- apps/api/src/modules/trade-core/journal/order-journaler.ts apps/api/src/modules/trade-core/journal/order-journaler.spec.ts
git commit -m "feat(trade-core): M5 journal rows for orders, fills, kill-switch and limit changes" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/api/src/modules/trade-core/journal/order-journaler.ts apps/api/src/modules/trade-core/journal/order-journaler.spec.ts apps/api/src/modules/trade-core/risk-wall/services/core-kill-switch.service.ts apps/api/src/modules/trade-core/risk-wall/services/core-risk-limit.service.ts apps/api/src/modules/trade-core/risk-wall/services/core-kill-switch.service.spec.ts apps/api/src/modules/trade-core/risk-wall/services/core-risk-limit.service.spec.ts
```

---

## Stream D — outcomes (summaries, corpus, follow-ups)

### Task 11: `summarizeTrade` and `CoreTradeSummaryService`

**Files:**
- Create: `apps/api/src/modules/trade-core/journal/trade-summary.ts`
- Test: `apps/api/src/modules/trade-core/journal/trade-summary.spec.ts`
- Create: `apps/api/src/modules/trade-core/journal/core-trade-summary.service.ts`
- Test: `apps/api/src/modules/trade-core/journal/core-trade-summary.service.spec.ts`

**Interfaces:**
- Consumes: `CorePosition`, `CoreOrder`, `LedgerEntry`; `istDate`, `istDayStart`, `ZERO`; `round2`;
  `CorePositionRepository.findForUser / findByIntent / lastOpenedAt / listClosedSince` (M4 + Task 2);
  `PaperLedgerService.listPositionOrders` (M4), `.ledgerRowsForPosition` (Task 3); `CoreTradeSummaryRepository` (Task 2);
  `CORE_CORPUS`; M4 `lifecycleHarness`, `openRequest`; `MemoryJournalStore`.
- Produces: `summarizeTrade(input): SummaryResult`; `outcomeOf(summary): CorpusOutcome`;
  `CoreTradeSummaryService implements PositionClosedListener, CoreTradeHistory` with `writeFor(userId, positionId): Promise<TradeSummary | null>`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/modules/trade-core/journal/trade-summary.spec.ts
import { Prisma } from '@prisma/client';
import type { CoreOrder } from '../execution/execution.types';
import type { LedgerEntry } from '../execution/repositories/core-cash-ledger.repository';
import { cashPlan, mtfPlan, positionFor } from '../lifecycle/testing/lifecycle-fixtures';
import { outcomeOf, summarizeTrade } from './trade-summary';

const ist = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00.000+05:30`);
const D = '2026-10-13';

function ord(id: string, purpose: 'ENTRY' | 'EXIT', filledQty: number, avg: number, side: 'BUY' | 'SELL' = purpose === 'ENTRY' ? 'BUY' : 'SELL'): CoreOrder {
  return {
    id, userId: 'user_A', idempotencyKey: id, vehicle: 'CASH_INTRADAY', instrument: { exchange: 'NSE', token: '2885', symbol: 'RELIANCE-EQ', lotSize: 1, underlying: null },
    side, qty: filledQty, filledQty, avgFillPrice: avg, type: 'MARKET', limitPrice: null, triggerPrice: null, refPrice: avg, purpose,
    strategyVersionId: 'csv_x', positionId: 'pos_1', state: 'FILLED', rejectReason: null, submittedAt: ist(D, '10:00'), triggeredAt: null, updatedAt: ist(D, '10:00'),
  };
}

function led(type: LedgerEntry['type'], amount: string, orderId: string | null, over: Partial<LedgerEntry> = {}): LedgerEntry {
  return { id: `led_${Math.random()}`, userId: 'user_A', type, amount: new Prisma.Decimal(amount), orderId, fillId: null, token: '2885', interestDate: null, note: 't', createdAt: ist(D, '11:00'), ...over };
}

const closedLong = () =>
  positionFor(cashPlan(), {
    id: 'pos_1', intentId: 'ci_1', status: 'CLOSED', side: 'BUY', direction: 'LONG', requestedQty: 100, entryFilledQty: 100, exitFilledQty: 100, openQty: 0,
    entryAvgPrice: 500, initialStopPrice: 492.5, highWater: 516, lowWater: 497, openedAt: ist(D, '10:00'), closedAt: ist(D, '11:30'), exitReason: 'TARGET',
  });

const ORDERS = [ord('o1', 'ENTRY', 100, 500), ord('o2', 'EXIT', 50, 510), ord('o3', 'EXIT', 50, 515)];
const LEDGER = [
  led('REALISED_PNL', '500.00', 'o2'), led('REALISED_PNL', '750.00', 'o3'),
  led('CHARGES', '-20.00', 'o1'), led('CHARGES', '-11.00', 'o2'), led('CHARGES', '-12.00', 'o3'),
  led('CHARGES', '-99.00', 'o_other'), // another position's row: ignored
];

describe('summarizeTrade (spec §8.2, ruling J16)', () => {
  it('a long cash trade: gross, charges, net, R, MFE/MAE, holding time, exit price average', () => {
    const r = summarizeTrade({ position: closedLong(), orders: ORDERS, ledger: LEDGER });
    expect(r).toEqual({
      ok: true,
      summary: expect.objectContaining({
        positionId: 'pos_1', intentId: 'ci_1', qty: 100, side: 'BUY', entryAvgPrice: '500.0000', exitAvgPrice: '512.5000',
        grossPnl: '1250.00', charges: '43.00', mtfInterest: '0.00', netPnl: '1207.00',
        initialRisk: '750.00', rMultiple: '1.6093', mfePrice: '516.0000', maePrice: '497.0000', mfeRupees: '1600.00', maeRupees: '-300.00',
        holdMinutes: 90, exitReason: 'TARGET', istDay: '2026-10-13', exchange: 'NSE', token: '2885', symbol: 'RELIANCE-EQ',
      }),
    });
  });

  it('a short trade: the best price is the low water mark', () => {
    const p = { ...closedLong(), side: 'SELL' as const, direction: 'SHORT' as const, highWater: 503, lowWater: 490 };
    const orders = [ord('o1', 'ENTRY', 100, 500, 'SELL'), ord('o2', 'EXIT', 100, 495, 'BUY')];
    const r = summarizeTrade({ position: p, orders, ledger: [led('REALISED_PNL', '500.00', 'o2')] });
    expect(r.ok && r.summary).toMatchObject({ mfePrice: '490.0000', maePrice: '503.0000', mfeRupees: '1000.00', maeRupees: '-300.00' });
  });

  it("MTF interest on the token over [open day, close day] is charged to the trade; a day before the open is not", () => {
    const p = { ...positionFor(mtfPlan(), {}), ...closedLong(), vehicle: 'MTF' as const, openedAt: ist('2026-10-12', '10:00'), closedAt: ist(D, '11:00') };
    const interest = [
      led('MTF_INTEREST', '-25.50', null, { interestDate: '2026-10-11' }),
      led('MTF_INTEREST', '-25.50', null, { interestDate: '2026-10-12' }),
      led('MTF_INTEREST', '-25.50', null, { interestDate: '2026-10-13' }),
      led('MTF_INTEREST', '-9.00', null, { interestDate: '2026-10-12', token: '1594' }),
    ];
    const r = summarizeTrade({ position: p, orders: ORDERS, ledger: [...LEDGER, ...interest] });
    expect(r.ok && r.summary).toMatchObject({ mtfInterest: '51.00', netPnl: '1156.00' });
  });

  it('no initial stop → no R; refuses a position that is not CLOSED or whose exits do not add up', () => {
    const noStop = summarizeTrade({ position: { ...closedLong(), initialStopPrice: null }, orders: ORDERS, ledger: LEDGER });
    expect(noStop.ok && noStop.summary).toMatchObject({ initialRisk: null, rMultiple: null });
    expect(summarizeTrade({ position: { ...closedLong(), status: 'EXITING' }, orders: ORDERS, ledger: LEDGER })).toEqual({ ok: false, error: 'position pos_1 is EXITING, not CLOSED' });
    expect(summarizeTrade({ position: closedLong(), orders: ORDERS.slice(0, 2), ledger: LEDGER })).toEqual({ ok: false, error: 'exits filled 50 of the 100 entered' });
  });

  it('the corpus outcome in SP3 keys and numbers', () => {
    const r = summarizeTrade({ position: closedLong(), orders: ORDERS, ledger: LEDGER });
    if (!r.ok) throw new Error(r.error);
    expect(outcomeOf(r.summary)).toEqual({ netPnl: 1207, grossPnl: 1250, fees: 43, win: true, rMultiple: 1.6093, mfe: 1600, mae: -300, holdMins: 90 });
  });
});
```

```ts
// apps/api/src/modules/trade-core/journal/core-trade-summary.service.spec.ts
import { NOW } from '../lifecycle/testing/lifecycle-fixtures';
import { lifecycleHarness, openRequest } from '../lifecycle/testing/lifecycle-harness';
import { CoreTradeSummaryService } from './core-trade-summary.service';
import { MemoryJournalStore } from './testing/memory-journal-store';

beforeEach(() => jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] }));
afterEach(() => jest.useRealTimers());

async function closedTrade() {
  const h = lifecycleHarness();
  const store = new MemoryJournalStore();
  const corpus = { entrySetup: jest.fn(), outcome: jest.fn().mockResolvedValue(undefined) };
  const svc = new CoreTradeSummaryService(h.positions.repo, h.ledger, store.summaryRepo, corpus);
  const p = await h.lifecycle.openPosition(openRequest());
  await h.price(500);
  await h.price(515); // the 3 % target: the exit is placed
  await h.price(515); // and filled
  return { h, store, corpus, svc, p };
}

describe('CoreTradeSummaryService (J16, Review Focus 4)', () => {
  it('writes one summary from the real ledger: gross and charges equal the funds, net = gross − charges', async () => {
    const { h, store, corpus, svc, p } = await closedTrade();
    const s = await svc.writeFor('user_A', p.id);
    const funds = await h.ledger.funds('user_A');
    expect(s).toMatchObject({ positionId: p.id, intentId: 'int_1', exitReason: 'TARGET', qty: 100, grossPnl: funds.realisedPnl, charges: funds.charges, mtfInterest: '0.00' });
    expect(Number(s?.netPnl)).toBeCloseTo(Number(funds.realisedPnl) - Number(funds.charges), 2);
    expect(s?.initialRisk).toBe('750.00');
    expect(corpus.outcome).toHaveBeenCalledWith('int_1', expect.objectContaining({ netPnl: Number(s?.netPnl), win: true, holdMins: expect.any(Number) }), s?.closedAt);
    await svc.writeFor('user_A', p.id);
    expect(store.summaries).toHaveLength(1);
  });

  it('an active or unknown position has no summary; another user cannot write or read it', async () => {
    const h = lifecycleHarness();
    const store = new MemoryJournalStore();
    const svc = new CoreTradeSummaryService(h.positions.repo, h.ledger, store.summaryRepo, { entrySetup: jest.fn(), outcome: jest.fn() });
    const p = await h.lifecycle.openPosition(openRequest());
    await h.price(500);
    expect(await svc.writeFor('user_A', p.id)).toBeNull();
    expect(await svc.writeFor('user_B', p.id)).toBeNull();
    expect(await svc.writeFor('user_A', 'nope')).toBeNull();
  });

  it('history: intentSeen, lastOpenedAt, and the last closed trade today (its net, or UNKNOWN when it cannot be summarised)', async () => {
    const { store, svc, p } = await closedTrade();
    expect(await svc.intentSeen('int_1')).toBe(true);
    expect(await svc.intentSeen('ci_other')).toBe(false);
    expect(await svc.lastOpenedAt('user_A', p.strategyId, '2885')).toEqual(expect.any(Date));
    expect(await svc.lastClosedNetToday('user_A', 'cs_none', '2885', new Date())).toBeNull();
    store.failWrites = true; // no summary yet, and none can be written now
    expect(await svc.lastClosedNetToday('user_A', p.strategyId, '2885', new Date())).toBe('UNKNOWN');
    store.failWrites = false; // repaired on read
    const net = await svc.lastClosedNetToday('user_A', p.strategyId, '2885', new Date());
    expect(typeof net).toBe('number');
    expect(store.summaries).toHaveLength(1);
  });

  it('positionClosed writes the summary (the lifecycle sink calls it)', async () => {
    const { store, svc, p } = await closedTrade();
    await svc.positionClosed('user_A', p.id);
    expect(store.summaries.map((s) => s.positionId)).toEqual([p.id]);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/api && npx jest src/modules/trade-core/journal/trade-summary.spec.ts src/modules/trade-core/journal/core-trade-summary.service.spec.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/modules/trade-core/journal/trade-summary.ts
import { Prisma } from '@prisma/client';
import type { CoreOrder, LedgerType } from '../execution/execution.types';
import { istDate, ZERO } from '../execution/ledger-math';
import type { LedgerEntry } from '../execution/repositories/core-cash-ledger.repository';
import { round2 } from '../lifecycle/exit-plan';
import type { CorePosition } from '../lifecycle/lifecycle.types';
import type { CorpusOutcome, NewTradeSummary, TradeSummary } from './journal.types';

const D = Prisma.Decimal;
type Dec = Prisma.Decimal;

export interface SummaryInput {
  position: CorePosition;
  /** The position's own orders (core_orders.positionId). */
  orders: readonly CoreOrder[];
  /** Ledger rows of those orders plus MTF_INTEREST rows on the token (PaperLedgerService.ledgerRowsForPosition). */
  ledger: readonly LedgerEntry[];
}

export type SummaryResult = { ok: true; summary: NewTradeSummary } | { ok: false; error: string };

const fail = (error: string): SummaryResult => ({ ok: false, error });
const sumOf = (rows: readonly LedgerEntry[], type: LedgerType): Dec => rows.filter((r) => r.type === type).reduce((a, r) => a.plus(r.amount), ZERO);

/**
 * Spec §8.2 / ruling J16. Ledger signs (M3): REALISED_PNL is signed, CHARGES and MTF_INTEREST are
 * negative, so charges = −ΣCHARGES and interest = −ΣMTF_INTEREST are costs ≥ 0. MFE/MAE use the
 * best and worst prices the lifecycle saw (M4 highWater/lowWater) against the entry average.
 */
export function summarizeTrade(i: SummaryInput): SummaryResult {
  const p = i.position;
  if (p.status !== 'CLOSED') return fail(`position ${p.id} is ${p.status}, not CLOSED`);
  if (p.entryAvgPrice === null || p.openedAt === null || p.closedAt === null || p.exitReason === null) {
    return fail(`closed position ${p.id} lacks its entry price, open or close time, or exit reason`);
  }
  const qty = p.entryFilledQty;
  const exits = i.orders.filter((o) => o.purpose === 'EXIT' && o.filledQty > 0);
  const exitQty = exits.reduce((n, o) => n + o.filledQty, 0);
  if (qty <= 0 || exitQty !== qty) return fail(`exits filled ${exitQty} of the ${qty} entered`);
  if (exits.some((o) => o.avgFillPrice === null)) return fail('an exit fill has no average price');
  const exitAvg = exits.reduce((a, o) => a.plus(new D(o.avgFillPrice as number).mul(o.filledQty)), ZERO).div(exitQty);

  const own = new Set(i.orders.map((o) => o.id));
  const rows = i.ledger.filter((r) => r.orderId !== null && own.has(r.orderId));
  const gross = sumOf(rows, 'REALISED_PNL');
  const charges = ZERO.minus(sumOf(rows, 'CHARGES'));
  const fromDay = istDate(p.openedAt);
  const toDay = istDate(p.closedAt);
  const interestRows = i.ledger.filter((r) => r.token === p.instrument.token && r.interestDate !== null && r.interestDate >= fromDay && r.interestDate <= toDay);
  const interest = ZERO.minus(sumOf(interestRows, 'MTF_INTEREST'));
  const net = gross.minus(charges).minus(interest);

  const entry = new D(p.entryAvgPrice);
  const dir = p.side === 'BUY' ? 1 : -1;
  const risk = p.initialStopPrice === null ? null : entry.minus(p.initialStopPrice).abs().mul(qty);
  const usableRisk = risk !== null && risk.gt(0) ? risk : null;
  const best = p.side === 'BUY' ? p.highWater : p.lowWater;
  const worst = p.side === 'BUY' ? p.lowWater : p.highWater;
  const rupees = (px: number | null): string | null => (px === null ? null : new D(px).minus(entry).mul(qty * dir).toFixed(2));

  return {
    ok: true,
    summary: {
      userId: p.userId,
      positionId: p.id,
      intentId: p.intentId,
      strategyId: p.strategyId,
      strategyVersionId: p.strategyVersionId,
      vehicle: p.vehicle,
      exchange: p.instrument.exchange,
      token: p.instrument.token,
      symbol: p.instrument.symbol,
      side: p.side,
      qty,
      entryAvgPrice: entry.toFixed(4),
      exitAvgPrice: exitAvg.toFixed(4),
      openedAt: p.openedAt,
      closedAt: p.closedAt,
      grossPnl: gross.toFixed(2),
      charges: charges.toFixed(2),
      mtfInterest: interest.toFixed(2),
      netPnl: net.toFixed(2),
      initialRisk: usableRisk ? usableRisk.toFixed(2) : null,
      rMultiple: usableRisk ? net.div(usableRisk).toFixed(4) : null,
      mfePrice: best === null ? null : new D(best).toFixed(4),
      maePrice: worst === null ? null : new D(worst).toFixed(4),
      mfeRupees: rupees(best),
      maeRupees: rupees(worst),
      holdMinutes: Math.max(0, Math.floor((p.closedAt.getTime() - p.openedAt.getTime()) / 60_000)),
      exitReason: p.exitReason,
      istDay: istDate(p.closedAt),
    },
  };
}

/** SP3 spec §5.1 outcome keys (rupees as numbers). */
export function outcomeOf(s: TradeSummary | NewTradeSummary): CorpusOutcome {
  const n = (x: string | null): number | null => (x === null ? null : Number(x));
  return {
    netPnl: Number(s.netPnl),
    grossPnl: Number(s.grossPnl),
    fees: round2(Number(s.charges) + Number(s.mtfInterest)),
    win: Number(s.netPnl) > 0,
    rMultiple: n(s.rMultiple),
    mfe: n(s.mfeRupees),
    mae: n(s.maeRupees),
    holdMins: s.holdMinutes,
  };
}
```

```ts
// apps/api/src/modules/trade-core/journal/core-trade-summary.service.ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { istDate, istDayStart } from '../execution/ledger-math';
import { PaperLedgerService } from '../execution/paper-ledger.service';
import { CorePositionRepository } from '../lifecycle/repositories/core-position.repository';
import { CORE_CORPUS, type CoreCorpusPort, type CoreTradeHistory, type PositionClosedListener } from './journal-ports';
import type { TradeSummary } from './journal.types';
import { CoreTradeSummaryRepository } from './repositories/core-trade-summary.repository';
import { outcomeOf, summarizeTrade } from './trade-summary';

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Spec §8.2 (J16): one summary per CLOSED position, from its orders and their ledger rows; first
 * write wins. Also the intake's trade history (J5): a closed trade without a summary is summarised
 * on read, and when that fails the answer is UNKNOWN (the intake then skips: fail closed).
 */
@Injectable()
export class CoreTradeSummaryService implements PositionClosedListener, CoreTradeHistory {
  private readonly logger = new Logger(CoreTradeSummaryService.name);

  constructor(
    private readonly positions: CorePositionRepository,
    private readonly ledger: PaperLedgerService,
    private readonly summaries: CoreTradeSummaryRepository,
    @Inject(CORE_CORPUS) private readonly corpus: CoreCorpusPort,
  ) {}

  async positionClosed(userId: string, positionId: string): Promise<void> {
    await this.writeFor(userId, positionId);
  }

  async writeFor(userId: string, positionId: string): Promise<TradeSummary | null> {
    const existing = await this.summaries.findByPosition(userId, positionId);
    if (existing) return existing;
    const p = await this.positions.findForUser(userId, positionId);
    if (!p || p.status !== 'CLOSED' || p.openedAt === null || p.closedAt === null) return null;
    const orders = await this.ledger.listPositionOrders(userId, positionId);
    const rows = await this.ledger.ledgerRowsForPosition(userId, orders.map((o) => o.id), p.instrument.token, istDate(p.openedAt), istDate(p.closedAt));
    const r = summarizeTrade({ position: p, orders, ledger: rows });
    if (!r.ok) throw new Error(r.error);
    const s = await this.summaries.createIfAbsent(r.summary);
    try {
      await this.corpus.outcome(p.intentId, { ...outcomeOf(s) }, s.closedAt);
    } catch (err) {
      this.logger.warn(`corpus outcome for ${p.intentId} not written: ${errorText(err)}`);
    }
    return s;
  }

  async intentSeen(intentId: string): Promise<boolean> {
    return (await this.positions.findByIntent(intentId)) !== null;
  }

  lastOpenedAt(userId: string, strategyId: string, token: string): Promise<Date | null> {
    return this.positions.lastOpenedAt(userId, strategyId, token);
  }

  async lastClosedNetToday(userId: string, strategyId: string, token: string, now: Date): Promise<number | 'UNKNOWN' | null> {
    const [last] = await this.positions.listClosedSince(userId, strategyId, token, istDayStart(now));
    if (!last) return null;
    try {
      const s = await this.writeFor(userId, last.id);
      return s ? Number(s.netPnl) : 'UNKNOWN';
    } catch (err) {
      this.logger.warn(`last trade ${last.id} cannot be summarised (entries on it fail closed): ${errorText(err)}`);
      return 'UNKNOWN';
    }
  }
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `cd apps/api && npx jest src/modules/trade-core/journal`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -- apps/api/src/modules/trade-core/journal/trade-summary.ts apps/api/src/modules/trade-core/journal/trade-summary.spec.ts apps/api/src/modules/trade-core/journal/core-trade-summary.service.ts apps/api/src/modules/trade-core/journal/core-trade-summary.service.spec.ts
git commit -m "feat(trade-core): M5 closed-trade summaries (net after costs, R, MFE/MAE) and the intake's trade history" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/api/src/modules/trade-core/journal/trade-summary.ts apps/api/src/modules/trade-core/journal/trade-summary.spec.ts apps/api/src/modules/trade-core/journal/core-trade-summary.service.ts apps/api/src/modules/trade-core/journal/core-trade-summary.service.spec.ts
```

---

### Task 12: `CoreCorpusWriter` — the SP3 `ai_decision_records` rows

**Files:**
- Create: `apps/api/src/modules/trade-core/journal/core-corpus.writer.ts`
- Test: `apps/api/src/modules/trade-core/journal/core-corpus.writer.spec.ts`
- Modify: `apps/api/test/sp2-m5/journal.int.spec.ts` (one SQL `describe`)

**Interfaces:**
- Consumes: `PrismaService` (`aiDecisionRecord`, unique `source_sourceId`); `CorpusSetup`, `CoreCorpusPort` (Task 1).
- Produces: `CoreCorpusWriter implements CoreCorpusPort`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/modules/trade-core/journal/core-corpus.writer.spec.ts
import type { PrismaService } from '../../../common/prisma/prisma.service';
import { CoreCorpusWriter } from './core-corpus.writer';
import type { CorpusSetup } from './journal.types';

const AT = new Date('2026-10-13T05:00:00.000Z');
const setup: CorpusSetup = {
  intentId: 'ci_1', userId: 'user_A', decidedAt: AT, symbol: 'RELIANCE-EQ', exchange: 'NSE', vehicle: 'CASH_INTRADAY', direction: 'LONG',
  strategyKey: 'adaptive-stop', strategyVersionId: 'csv_adaptive_stop_v1', setupGroupKey: 'alert_1|RELIANCE|2026-10-13',
  evidence: { score: 70, atrSource: 'none' }, ruleScore: 70, decision: { taken: false, reason: 'GATE: not at support' },
};

describe('CoreCorpusWriter (O9, J20)', () => {
  it("upserts one ENTRY_SETUP per intent (source 'core', sourceId = intentId); the first write wins", async () => {
    const upsert = jest.fn().mockResolvedValue({});
    const w = new CoreCorpusWriter({ aiDecisionRecord: { upsert } } as unknown as PrismaService);
    await w.entrySetup(setup);
    expect(upsert).toHaveBeenCalledWith({
      where: { source_sourceId: { source: 'core', sourceId: 'ci_1' } },
      create: {
        userId: 'user_A', source: 'core', sourceId: 'ci_1', kind: 'ENTRY_SETUP', decidedAt: AT, symbol: 'RELIANCE-EQ', exchange: 'NSE',
        direction: 'LONG', vehicle: 'CASH_INTRADAY', strategyKey: 'adaptive-stop', strategyVersionId: 'csv_adaptive_stop_v1',
        setupGroupKey: 'alert_1|RELIANCE|2026-10-13', evidence: { score: 70, atrSource: 'none' }, ruleScore: 70,
        decision: { taken: false, reason: 'GATE: not at support' },
      },
      update: {},
    });
  });

  it('merges an outcome patch into the existing outcome (jsonb ||) and stamps outcomeAt', async () => {
    const $executeRaw = jest.fn().mockResolvedValue(1);
    const w = new CoreCorpusWriter({ $executeRaw } as unknown as PrismaService);
    await w.outcome('ci_1', { priceAfter30m: 501.2 }, AT);
    const [sql, ...values] = $executeRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    expect(sql.join('?')).toContain('COALESCE("outcome", \'{}\'::jsonb) ||');
    expect(values).toEqual([JSON.stringify({ priceAfter30m: 501.2 }), AT, 'ci_1']);
  });
});
```

Append to `apps/api/test/sp2-m5/journal.int.spec.ts` (with `import type { PrismaService } …` already imported by Task 3, and
`import { CoreCorpusWriter } from '../../src/modules/trade-core/journal/core-corpus.writer';`):

```ts
describe('ai_decision_records from the core (O9) against SQL', () => {
  it('a setup is written once; outcome patches merge', async () => {
    const u = await newUser();
    const w = new CoreCorpusWriter(db as unknown as PrismaService);
    const intentId = `ci_${rid()}`;
    const s = {
      intentId, userId: u, decidedAt: new Date(), symbol: 'RELIANCE-EQ', exchange: 'NSE', vehicle: 'CASH_INTRADAY' as const, direction: 'LONG' as const,
      strategyKey: 'ungated', strategyVersionId: 'csv_ungated_v1', setupGroupKey: `a|RELIANCE|x`, evidence: {}, ruleScore: 50, decision: { taken: true, reason: 'opened' },
    };
    await w.entrySetup(s);
    await w.entrySetup({ ...s, decision: { taken: false, reason: 'second write ignored' } });
    await w.outcome(intentId, { netPnl: 12.5 }, new Date());
    await w.outcome(intentId, { priceAfterClose: 503 }, new Date());
    const row = await db.aiDecisionRecord.findUnique({ where: { source_sourceId: { source: 'core', sourceId: intentId } } });
    expect(row?.decision).toEqual({ taken: true, reason: 'opened' });
    expect(row?.outcome).toEqual({ netPnl: 12.5, priceAfterClose: 503 });
    await db.aiDecisionRecord.delete({ where: { id: row?.id as string } });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx jest src/modules/trade-core/journal/core-corpus.writer.spec.ts`
Expected: FAIL — `Cannot find module './core-corpus.writer'`.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/modules/trade-core/journal/core-corpus.writer.ts
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { CoreCorpusPort } from './journal-ports';
import type { CorpusSetup } from './journal.types';

/**
 * O9 / J20: the core's rows in SP3's provider-neutral decision corpus (SP3 spec §5.1). One ENTRY_SETUP
 * per intent (taken or skipped), first write wins; outcomes are merged key by key so the close (Task 11)
 * and the price follow-ups (Task 13) never overwrite each other. SP3's DecisionPipeline will write
 * the same (source, sourceId) for intents it produces; the upsert keeps whichever came first.
 */
@Injectable()
export class CoreCorpusWriter implements CoreCorpusPort {
  constructor(private readonly prisma: PrismaService) {}

  async entrySetup(s: CorpusSetup): Promise<void> {
    await this.prisma.aiDecisionRecord.upsert({
      where: { source_sourceId: { source: 'core', sourceId: s.intentId } },
      create: {
        userId: s.userId,
        source: 'core',
        sourceId: s.intentId,
        kind: 'ENTRY_SETUP',
        decidedAt: s.decidedAt,
        symbol: s.symbol,
        exchange: s.exchange,
        direction: s.direction,
        vehicle: s.vehicle,
        strategyKey: s.strategyKey,
        strategyVersionId: s.strategyVersionId,
        setupGroupKey: s.setupGroupKey,
        evidence: s.evidence as Prisma.InputJsonValue,
        ruleScore: s.ruleScore,
        decision: s.decision as unknown as Prisma.InputJsonValue,
      },
      update: {},
    });
  }

  async outcome(intentId: string, patch: Record<string, unknown>, at: Date): Promise<void> {
    await this.prisma.$executeRaw`UPDATE "ai_decision_records" SET "outcome" = COALESCE("outcome", '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb, "outcomeAt" = ${at} WHERE "source" = 'core' AND "sourceId" = ${intentId}`;
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd apps/api && npx jest src/modules/trade-core/journal/core-corpus.writer.spec.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add -- apps/api/src/modules/trade-core/journal/core-corpus.writer.ts apps/api/src/modules/trade-core/journal/core-corpus.writer.spec.ts
git commit -m "feat(trade-core): M5 corpus writer — core setups and outcomes into ai_decision_records" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/api/src/modules/trade-core/journal/core-corpus.writer.ts apps/api/src/modules/trade-core/journal/core-corpus.writer.spec.ts apps/api/test/sp2-m5/journal.int.spec.ts
```

---

### Task 13: Skipped-intent price follow-ups at 16:10 IST

**Files:**
- Create: `apps/api/src/modules/trade-core/journal/skip-followup.cron.ts`
- Test: `apps/api/src/modules/trade-core/journal/skip-followup.cron.spec.ts`

**Interfaces:**
- Consumes: `CoreJournalRepository.listTypeOnDay` (Task 2), `CORE_JOURNAL` (`recordNow`; the spec uses `MemoryJournalStore.port()`, not Stream C's service), `CoreCandles.read`
  (Task 2), `CORE_CORPUS`, `JobRunnerService.run(name, { ttlMs, onRedisError }, fn)`, `isHubExchange`, `istDate`.
- Produces: `CORE_SKIP_FOLLOWUP_JOB = 'core-skip-followup'`, `FOLLOWUP_MAX_INSTRUMENTS = 300`; `priceAt(candles, t)`,
  `sessionCloseMs(day)`; `SkipFollowupCron` with `nightly()` (`@Cron('0 10 16 * * 1-5', { timeZone: 'Asia/Kolkata' })`),
  `run(now)`, `followUp(day, now): Promise<{ skipped: number; instruments: number; written: number; unpriced: number }>`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/modules/trade-core/journal/skip-followup.cron.spec.ts
import type { JobRunnerService } from '../../../common/job-registry';
import type { HubCandle } from '../../market-hub/candles/candle.types';
import type { CoreCandles } from '../market/core-candles';
import { CORE_SKIP_FOLLOWUP_JOB, FOLLOWUP_MAX_INSTRUMENTS, priceAt, sessionCloseMs, SkipFollowupCron } from './skip-followup.cron';
import { MemoryJournalStore } from './testing/memory-journal-store';

const D = '2026-10-13';
const ist = (hhmm: string) => new Date(`${D}T${hhmm}:00.000+05:30`);
/** 1m bars from 09:15 to 15:29, close = 500 + minutes since the open (whole rupees: exact comparisons). */
const DAY: HubCandle[] = Array.from({ length: 375 }, (_, i) => ({ ts: ist('09:15').getTime() + i * 60_000, open: 0, high: 0, low: 0, close: 500 + i, volume: 1 }));

async function skipRow(store: MemoryJournalStore, at: Date, token = '2885', over: Record<string, unknown> = {}) {
  await store.repo.append([{
    type: 'INTENT_SKIPPED', userId: 'user_A', at, intentId: `ci_${token}_${at.getTime()}`, strategyId: 'cs_x', symbol: 'RELIANCE-EQ',
    payload: { reason: 'GATE', token, exchange: 'NSE', alertPrice: 499, ltp: 500, ...over },
  }]);
}

function setup(read?: CoreCandles['read']) {
  const store = new MemoryJournalStore();
  const journal = store.port();
  const candles = { read: read ?? jest.fn().mockResolvedValue({ ok: true, candles: DAY, complete: true }) } as unknown as CoreCandles;
  const corpus = { entrySetup: jest.fn(), outcome: jest.fn().mockResolvedValue(undefined) };
  const jobs = { run: jest.fn((_n: string, _o: unknown, fn: () => Promise<unknown>) => fn()) };
  const cron = new SkipFollowupCron(store.repo, journal, candles, corpus, jobs as unknown as JobRunnerService);
  return { store, cron, candles, corpus, jobs };
}

describe('priceAt', () => {
  it('is the close of the newest bar that ended at or before t; null before the first bar ends', () => {
    expect(priceAt(DAY, ist('09:15').getTime())).toBeNull();
    expect(priceAt(DAY, ist('09:16').getTime())).toBe(500);
    expect(priceAt(DAY, ist('10:45').getTime() + 30_000)).toBe(589);
    expect(priceAt(DAY, sessionCloseMs(D))).toBe(874);
  });
});

describe('SkipFollowupCron (spec §8.1, J14, O14)', () => {
  it('writes PRICE_FOLLOWUP for each skip of the day (30 min after it, and at the close) and merges them into the corpus', async () => {
    const s = setup();
    await skipRow(s.store, ist('10:15'));
    const r = await s.cron.followUp(D, ist('16:10'));
    expect(r).toEqual({ skipped: 1, instruments: 1, written: 1, unpriced: 0 });
    const f = s.store.rows.find((x) => x.type === 'PRICE_FOLLOWUP');
    expect(f).toMatchObject({ userId: 'user_A', strategyId: 'cs_x', payload: { reason: 'GATE', refPrice: 500, priceAfter30m: 589, priceAfterClose: 874 } });
    expect(s.corpus.outcome).toHaveBeenCalledWith(f?.intentId, { priceAfter30m: 589, priceAfterClose: 874 }, ist('16:10'));
  });

  it('reads each instrument once, is idempotent on a rerun, and counts what it could not price', async () => {
    const read = jest.fn().mockResolvedValueOnce({ ok: true, candles: DAY, complete: true }).mockResolvedValueOnce({ ok: false, reason: 'hub candles are off' }).mockResolvedValue({ ok: true, candles: DAY, complete: true });
    const s = setup(read);
    await skipRow(s.store, ist('10:15'));
    await skipRow(s.store, ist('11:00'));
    await skipRow(s.store, ist('11:30'), '1594');
    expect(await s.cron.followUp(D, ist('16:10'))).toEqual({ skipped: 3, instruments: 2, written: 2, unpriced: 1 });
    expect(read).toHaveBeenCalledTimes(2);
    await s.cron.followUp(D, ist('16:20'));
    expect(s.store.rows.filter((x) => x.type === 'PRICE_FOLLOWUP')).toHaveLength(3); // the rerun added only the 1594 one
  });

  it(`prices at most ${FOLLOWUP_MAX_INSTRUMENTS} instruments a day`, async () => {
    const s = setup();
    for (let i = 0; i < FOLLOWUP_MAX_INSTRUMENTS + 2; i += 1) await skipRow(s.store, ist('10:15'), String(10_000 + i));
    const r = await s.cron.followUp(D, ist('16:10'));
    expect(r).toMatchObject({ instruments: FOLLOWUP_MAX_INSTRUMENTS, unpriced: 2 });
  });

  it('runs through the job runner under its job name; a failure is logged, never thrown', async () => {
    const s = setup();
    await s.cron.run(ist('16:10'));
    expect(s.jobs.run).toHaveBeenCalledWith(CORE_SKIP_FOLLOWUP_JOB, expect.objectContaining({ onRedisError: 'run-anyway' }), expect.any(Function));
    s.jobs.run.mockRejectedValueOnce(new Error('lease lost'));
    await expect(s.cron.run(ist('16:10'))).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx jest src/modules/trade-core/journal/skip-followup.cron.spec.ts`
Expected: FAIL — `Cannot find module './skip-followup.cron'`.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/modules/trade-core/journal/skip-followup.cron.ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { JobRunnerService } from '../../../common/job-registry';
import type { HubCandle } from '../../market-hub/candles/candle.types';
import { isHubExchange } from '../../market-hub/hub.types';
import { istDate } from '../execution/ledger-math';
import { CoreCandles } from '../market/core-candles';
import { CORE_CORPUS, CORE_JOURNAL, type CoreCorpusPort, type CoreJournalPort } from './journal-ports';
import type { JournalRow } from './journal.types';
import { CoreJournalRepository } from './repositories/core-journal.repository';

export const CORE_SKIP_FOLLOWUP_JOB = 'core-skip-followup';
/** O14: a load bound on candle reads per night. */
export const FOLLOWUP_MAX_INSTRUMENTS = 300;
/** Shape bound on the rows one night reads. */
const FOLLOWUP_SCAN_TAKE = 20_000;
const FOLLOWUP_LEASE_MS = 60 * 60_000;
const BAR_MS = 60_000;

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The close of the newest 1m bar that ended at or before t (ms); null when none has. */
export function priceAt(candles: readonly HubCandle[], t: number): number | null {
  let best: HubCandle | null = null;
  for (const c of candles) if (c.ts + BAR_MS <= t && (best === null || c.ts > best.ts)) best = c;
  return best ? best.close : null;
}

export const sessionCloseMs = (day: string): number => Date.parse(`${day}T15:30:00.000+05:30`);

/**
 * Spec §8.1 / J14: what price did next for every intent the core skipped or rejected today, so skip
 * accuracy is measurable. After the close (no exchange competes for the historical lane), one 1m
 * read per instrument from the hub candle store, PRICE_FOLLOWUP rows keyed to the skip row
 * (idempotent), and the same two prices merged into the corpus outcome.
 */
@Injectable()
export class SkipFollowupCron {
  private readonly logger = new Logger(SkipFollowupCron.name);

  constructor(
    private readonly journalRepo: CoreJournalRepository,
    @Inject(CORE_JOURNAL) private readonly journal: CoreJournalPort,
    private readonly candles: CoreCandles,
    @Inject(CORE_CORPUS) private readonly corpus: CoreCorpusPort,
    private readonly jobs: JobRunnerService,
  ) {}

  @Cron('0 10 16 * * 1-5', { name: CORE_SKIP_FOLLOWUP_JOB, timeZone: 'Asia/Kolkata' })
  async nightly(): Promise<void> {
    await this.run(new Date());
  }

  async run(now: Date): Promise<void> {
    const day = istDate(now);
    try {
      await this.jobs.run(CORE_SKIP_FOLLOWUP_JOB, { ttlMs: FOLLOWUP_LEASE_MS, onRedisError: 'run-anyway' }, async () => {
        const r = await this.followUp(day, now);
        this.logger.log(`skip follow-ups ${day}: ${r.skipped} skip(s), ${r.instruments} instrument(s), ${r.written} written, ${r.unpriced} unpriced`);
        return r;
      });
    } catch (err) {
      this.logger.error(`skip follow-ups ${day} failed: ${errorText(err)}`);
    }
  }

  async followUp(day: string, now: Date): Promise<{ skipped: number; instruments: number; written: number; unpriced: number }> {
    const rows = await this.journalRepo.listTypeOnDay('INTENT_SKIPPED', day, FOLLOWUP_SCAN_TAKE);
    const groups = new Map<string, JournalRow[]>();
    for (const r of rows) {
      const exchange = typeof r.payload.exchange === 'string' ? r.payload.exchange : '';
      const token = typeof r.payload.token === 'string' ? r.payload.token : '';
      if (!exchange || !token) continue;
      const key = `${exchange}:${token}`;
      groups.set(key, [...(groups.get(key) ?? []), r]);
    }
    let instruments = 0;
    let written = 0;
    let unpriced = 0;
    const close = sessionCloseMs(day);
    for (const [key, group] of groups) {
      const [exchange, token] = key.split(':');
      if (instruments >= FOLLOWUP_MAX_INSTRUMENTS || !isHubExchange(exchange)) {
        unpriced += group.length;
        continue;
      }
      instruments += 1;
      const read = await this.candles.read({ exchange, token, symbol: group[0].symbol ?? token }, '1m', new Date(`${day}T09:15:00.000+05:30`), new Date(close));
      if (!read.ok || read.candles.length === 0) {
        unpriced += group.length;
        continue;
      }
      for (const r of group) {
        const refPrice = typeof r.payload.ltp === 'number' ? r.payload.ltp : typeof r.payload.alertPrice === 'number' ? r.payload.alertPrice : null;
        const priceAfter30m = priceAt(read.candles, r.createdAt.getTime() + 30 * 60_000);
        const priceAfterClose = priceAt(read.candles, close);
        try {
          await this.journal.recordNow({
            type: 'PRICE_FOLLOWUP', userId: r.userId, at: now, strategyId: r.strategyId, strategyVersionId: r.strategyVersionId, intentId: r.intentId, symbol: r.symbol,
            payload: { skipId: r.id, reason: r.payload.reason ?? null, refPrice, priceAfter30m, priceAfterClose }, priceUsed: priceAfterClose, dedupeKey: `followup:${r.id}`,
          });
          written += 1;
        } catch (err) {
          this.logger.warn(`follow-up for skip ${r.id} not written: ${errorText(err)}`);
          continue;
        }
        if (r.intentId) {
          try {
            await this.corpus.outcome(r.intentId, { priceAfter30m, priceAfterClose }, now);
          } catch (err) {
            this.logger.warn(`corpus follow-up for ${r.intentId} not written: ${errorText(err)}`);
          }
        }
      }
    }
    return { skipped: rows.length, instruments, written, unpriced };
  }
}
```

(`written` counts rows handed to `recordNow`; a duplicate on a rerun is skipped by the store's dedupe and still counted —
the rerun test therefore asserts the store's rows, not `written`.)

- [ ] **Step 4: Run it to verify it passes**

Run: `cd apps/api && npx jest src/modules/trade-core/journal/skip-followup.cron.spec.ts src/common/schedule/cron-timezone.spec.ts`
Expected: PASS — the follow-up spec and the cron-timezone ratchet (the new `@Cron` carries `timeZone`).

- [ ] **Step 5: Commit**

```bash
git add -- apps/api/src/modules/trade-core/journal/skip-followup.cron.ts apps/api/src/modules/trade-core/journal/skip-followup.cron.spec.ts
git commit -m "feat(trade-core): M5 skipped-intent price follow-ups at 16:10 IST" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/api/src/modules/trade-core/journal/skip-followup.cron.ts apps/api/src/modules/trade-core/journal/skip-followup.cron.spec.ts
```

---

## Stream E — risk and reconciliation (requires P1)

### Task 14: The persisted daily-loss latch

**Files:**
- Create: `apps/api/src/modules/trade-core/journal/journal-risk-reads.ts`
- Test: `apps/api/src/modules/trade-core/journal/journal-risk-reads.spec.ts`
- Modify: `apps/api/src/modules/trade-core/lifecycle/daily-loss.monitor.ts` (+ `daily-loss.monitor.spec.ts`)
- Modify: `apps/api/src/modules/trade-core/lifecycle/core-risk-state.provider.ts` (+ `core-risk-state.provider.spec.ts`)

**Interfaces:**
- Consumes: `CoreJournalRepository.hasType` (Task 2), `CORE_JOURNAL` / `FakeJournal`, `MemoryJournalStore`; M2 `decideDailyLoss`,
  `limitsFixture`, `stateFixture`, `positionFixture`; the post-P1 `DailyLossMonitor.checkUser` (computes `live`,
  `openPnlKnown`, `d`).
- Produces: `JOURNAL_RISK_READS`; `JournalRiskReadsPort { latched(userId, day): Promise<boolean> }` (Task 16 adds
  `reconBlock`); `JournalRiskReads`. `DailyLossMonitor` gains `@Optional() @Inject(CORE_JOURNAL)` as its last constructor
  parameter; `CoreRiskStateProvider` gains `@Optional() @Inject(JOURNAL_RISK_READS)` as its last (J23).

- [ ] **Step 0: Check P1**

Run: `git merge-base --is-ancestor c26d613 HEAD && echo P1-ok`
Expected: `P1-ok`. If not, stop and ask the controller to merge `fix/daily-loss-realised-breach` into this branch's base first.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/modules/trade-core/journal/journal-risk-reads.spec.ts
import { JournalRiskReads } from './journal-risk-reads';
import { MemoryJournalStore } from './testing/memory-journal-store';

describe('JournalRiskReads.latched (J13)', () => {
  it('is true only for the user and IST day that has a DAILY_LOSS_LATCHED row', async () => {
    const s = new MemoryJournalStore();
    await s.repo.append([{ type: 'DAILY_LOSS_LATCHED', userId: 'user_A', at: new Date('2026-10-13T05:00:00.000Z'), payload: {}, dedupeKey: 'latch:user_A:2026-10-13' }]);
    const r = new JournalRiskReads(s.repo);
    expect(await r.latched('user_A', '2026-10-13')).toBe(true);
    expect(await r.latched('user_A', '2026-10-14')).toBe(false);
    expect(await r.latched('user_B', '2026-10-13')).toBe(false);
  });
});
```

Append to `apps/api/src/modules/trade-core/lifecycle/daily-loss.monitor.spec.ts` (imports: `FakeJournal` from
`../journal/testing/fake-journal`; `limitsFixture`, `stateFixture`, `positionFixture` from `../risk-wall/testing/risk-fixtures`;
`AuditService`, `CoreSquareOffPort`, `RiskStateProvider`, `CoreRiskLimitService`, `CorePositionRepository` types as the file
already uses):

```ts
describe('DailyLossMonitor — the persisted latch (M5 J13, O13)', () => {
  const NOW_M5 = new Date('2026-10-13T05:00:00.000Z');
  function latchSetup(state: ReturnType<typeof stateFixture>, limits = limitsFixture()) {
    const journal = new FakeJournal();
    const squareOff = { squareOffAll: jest.fn().mockResolvedValue({ cancelledOrders: 0, exitsRequested: 0, detail: 'x' }) };
    const monitor = new DailyLossMonitor(
      { listActiveUserIds: async () => ['user_A'] } as unknown as CorePositionRepository,
      { liveState: async () => state } as unknown as RiskStateProvider,
      { inForce: async () => limits } as unknown as CoreRiskLimitService,
      squareOff as unknown as CoreSquareOffPort,
      { append: jest.fn().mockResolvedValue({ seq: 1n, hash: 'h' }) } as unknown as AuditService,
      journal,
    );
    return { journal, squareOff, monitor };
  }

  it('BLOCK_ENTRIES: a breach latches the IST day once and does not square off', async () => {
    const s = latchSetup(stateFixture({ realisedPnlToday: -6000, openPnl: 0 }));
    await s.monitor.runOnce(NOW_M5);
    await s.monitor.runOnce(NOW_M5);
    expect(s.journal.ofType('DAILY_LOSS_LATCHED')).toEqual([
      expect.objectContaining({ userId: 'user_A', dedupeKey: 'latch:user_A:2026-10-13', payload: expect.objectContaining({ day: '2026-10-13', source: 'DAILY_LOSS_MONITOR', action: 'BLOCK_ENTRIES' }) }),
    ]);
    expect(s.squareOff.squareOffAll).not.toHaveBeenCalled();
  });

  it('owner ruling 2026-10-12: a realised-only breach with a blind position latches too', async () => {
    const s = latchSetup(stateFixture({ realisedPnlToday: -5000, openPnl: null, openPositions: [positionFixture({ priced: false })] }));
    await s.monitor.runOnce(NOW_M5);
    expect(s.journal.ofType('DAILY_LOSS_LATCHED')).toHaveLength(1);
  });

  it('a latch that cannot be written is retried on the next check and never throws; under the limit nothing latches', async () => {
    const s = latchSetup(stateFixture({ realisedPnlToday: -6000, openPnl: 0 }));
    s.journal.failNow = true;
    await expect(s.monitor.runOnce(NOW_M5)).resolves.toBeUndefined();
    s.journal.failNow = false;
    await s.monitor.runOnce(NOW_M5);
    expect(s.journal.ofType('DAILY_LOSS_LATCHED')).toHaveLength(1);
    const ok = latchSetup(stateFixture({ realisedPnlToday: -100, openPnl: 0 }));
    await ok.monitor.runOnce(NOW_M5);
    expect(ok.journal.entries).toEqual([]);
  });
});
```

Append to `apps/api/src/modules/trade-core/lifecycle/core-risk-state.provider.spec.ts` (imports `lifecycleHarness` from
`./testing/lifecycle-harness` and `NOW` from `./testing/lifecycle-fixtures` if absent):

```ts
describe('CoreRiskStateProvider — dailyLossLatched from the journal (M5 J13)', () => {
  beforeEach(() => jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] }));
  afterEach(() => jest.useRealTimers());

  it("reports today's latch; without the reads binding it is false (M4 behaviour); a failing read throws (the wall rejects)", async () => {
    const h = lifecycleHarness();
    const latched = jest.fn().mockResolvedValue(true);
    expect((await new CoreRiskStateProvider(h.ledger, h.positions.repo, h.lifecycle, { latched } as never).liveState('user_A', new Date())).dailyLossLatched).toBe(true);
    expect(latched).toHaveBeenCalledWith('user_A', '2026-10-12');
    expect((await new CoreRiskStateProvider(h.ledger, h.positions.repo, h.lifecycle).liveState('user_A', new Date())).dailyLossLatched).toBe(false);
    const failing = { latched: jest.fn().mockRejectedValue(new Error('journal down')) };
    await expect(new CoreRiskStateProvider(h.ledger, h.positions.repo, h.lifecycle, failing as never).liveState('user_A', new Date())).rejects.toThrow('journal down');
  });
});
```

(`NOW` in the lifecycle fixtures is Mon 2026-10-12 10:30 IST, hence the day.)

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/api && npx jest src/modules/trade-core/journal/journal-risk-reads.spec.ts src/modules/trade-core/lifecycle/daily-loss.monitor.spec.ts src/modules/trade-core/lifecycle/core-risk-state.provider.spec.ts`
Expected: FAIL — `Cannot find module './journal-risk-reads'`; no latch rows; `dailyLossLatched` is `false`.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/modules/trade-core/journal/journal-risk-reads.ts
import { Injectable } from '@nestjs/common';
import { CoreJournalRepository } from './repositories/core-journal.repository';

/** What the Risk Wall's live state reads from the journal (J13; Task 16 adds the recon block). */
export const JOURNAL_RISK_READS = Symbol('JOURNAL_RISK_READS');

export interface JournalRiskReadsPort {
  /** The daily loss limit was reached earlier this IST day (spec §5.3). */
  latched(userId: string, day: string): Promise<boolean>;
}

@Injectable()
export class JournalRiskReads implements JournalRiskReadsPort {
  constructor(private readonly repo: CoreJournalRepository) {}

  latched(userId: string, day: string): Promise<boolean> {
    return this.repo.hasType(userId, day, 'DAILY_LOSS_LATCHED');
  }
}
```

`daily-loss.monitor.ts` — imports: add `Optional` to the `@nestjs/common` import and
`import { CORE_JOURNAL, type CoreJournalPort } from '../journal/journal-ports';`. Add a field and the last constructor parameter:

```ts
  private readonly latchedOn = new Map<string, string>();
```

```ts
    @Optional() @Inject(CORE_JOURNAL) private readonly journal?: CoreJournalPort,
```

In `checkUser`, immediately after the `try { … } catch { … }` that computes `d` and before
`if (d.status !== 'BREACHED' || !d.squareOffCore) return d;`:

```ts
    // SP2 M5 (J13, O13): any breach latches the IST day — entries stay blocked for the rest of the
    // session even if P&L recovers. Includes the 2026-10-12 realised-only breach.
    if (d.status === 'BREACHED') await this.latch(userId, day, d, now);
```

and the method:

```ts
  /** Once per user per IST day per process; a failed write is retried on the next check. Never throws. */
  private async latch(userId: string, day: string, d: DailyLossDecision, now: Date): Promise<void> {
    if (!this.journal || this.latchedOn.get(userId) === day) return;
    try {
      await this.journal.recordNow({
        type: 'DAILY_LOSS_LATCHED',
        userId,
        at: now,
        payload: { day, source: 'DAILY_LOSS_MONITOR', lossRupees: d.lossRupees, limitRupees: d.limitRupees, action: d.action },
        dedupeKey: `latch:${userId}:${day}`,
      });
      this.latchedOn.set(userId, day);
    } catch (err) {
      this.logger.error(`daily-loss latch for ${userId} not written; retried on the next check: ${errorText(err)}`);
    }
  }
```

`core-risk-state.provider.ts` — imports: add `Optional` and `import { JOURNAL_RISK_READS, type JournalRiskReadsPort } from '../journal/journal-risk-reads';`;
constructor gains the last parameter:

```ts
    @Optional() @Inject(JOURNAL_RISK_READS) private readonly reads?: JournalRiskReadsPort,
```

In `liveState`, extend the `Promise.all`:

```ts
    const [funds, day, rows, realisedByPosition, dailyLossLatched] = await Promise.all([
      this.ledger.funds(userId),
      this.ledger.dayStats(userId, at),
      this.positions.listForUser(userId, dayStart),
      this.ledger.netPnlTodayByPosition(userId, at),
      this.reads ? this.reads.latched(userId, istDate(at)) : Promise.resolve(false),
    ]);
```

and return `dailyLossLatched` (replacing the literal `dailyLossLatched: false`). Update the class comment's "The daily-loss
latch stays M5's (ruling L15)" to "M5: the daily-loss latch is read from the journal (J13)".

- [ ] **Step 4: Run them to verify they pass**

Run: `cd apps/api && npx jest src/modules/trade-core`
Expected: PASS (the existing monitor and provider specs construct them without the new argument and are unchanged).

- [ ] **Step 5: Commit**

```bash
git add -- apps/api/src/modules/trade-core/journal/journal-risk-reads.ts apps/api/src/modules/trade-core/journal/journal-risk-reads.spec.ts
git commit -m "feat(trade-core): M5 persisted daily-loss latch (journal-derived), incl. the realised-only breach" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/api/src/modules/trade-core/journal/journal-risk-reads.ts apps/api/src/modules/trade-core/journal/journal-risk-reads.spec.ts apps/api/src/modules/trade-core/lifecycle/daily-loss.monitor.ts apps/api/src/modules/trade-core/lifecycle/daily-loss.monitor.spec.ts apps/api/src/modules/trade-core/lifecycle/core-risk-state.provider.ts apps/api/src/modules/trade-core/lifecycle/core-risk-state.provider.spec.ts
```

---

### Task 15: The reconciliation checks (pure)

**Files:**
- Create: `apps/api/src/modules/trade-core/journal/recon-checks.ts`
- Test: `apps/api/src/modules/trade-core/journal/recon-checks.spec.ts`

**Interfaces:**
- Consumes: `CorePosition`, `CoreOrder`, `isActiveStatus`, `reducePosition` (M4); `istMinutesOf` (`risk-wall/session-open.ts`),
  `hhmmToMinutes` (`risk-wall/limits/limit-keys.ts`); `JournalRow`; M4 fixtures `cashPlan`, `mtfPlan`, `positionFor`.
- Produces: `RECON_CHECKS`, `ReconCheck`, `ReconFinding { check; fingerprint; strategyId; positionId; orderId; detail; repair: 'CANCEL_ENTRY' | 'WRITE_SUMMARY' | null }`,
  `ReconSnapshot`, `ReconBlock { all: boolean; strategyIds: readonly string[] }`, `intradayFindings(s)`, `nightlyFindings(s)`,
  `reconBlockOf(rows)`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/modules/trade-core/journal/recon-checks.spec.ts
import { Prisma } from '@prisma/client';
import type { CoreOrder } from '../execution/execution.types';
import type { CorePosition } from '../lifecycle/lifecycle.types';
import { cashPlan, mtfPlan, positionFor } from '../lifecycle/testing/lifecycle-fixtures';
import type { JournalRow } from './journal.types';
import { intradayFindings, nightlyFindings, reconBlockOf, type ReconSnapshot } from './recon-checks';

const ist = (hhmm: string) => new Date(`2026-10-13T${hhmm}:00.000+05:30`);
const STUCK = 60_000;

function ord(id: string, over: Partial<CoreOrder> = {}): CoreOrder {
  return {
    id, userId: 'user_A', idempotencyKey: id, vehicle: 'CASH_INTRADAY', instrument: { exchange: 'NSE', token: '2885', symbol: 'RELIANCE-EQ', lotSize: 1, underlying: null },
    side: 'BUY', qty: 100, filledQty: 100, avgFillPrice: 500, type: 'MARKET', limitPrice: null, triggerPrice: null, refPrice: 500, purpose: 'ENTRY',
    strategyVersionId: 'csv_x', positionId: 'pos_1', state: 'FILLED', rejectReason: null, submittedAt: ist('10:00'), triggeredAt: null, updatedAt: ist('10:00'), ...over,
  };
}

const openPos = (over: Partial<CorePosition> = {}) => positionFor(cashPlan(), { status: 'OPEN', entryFilledQty: 100, exitFilledQty: 0, openQty: 100, updatedAt: ist('10:00'), ...over });

function snap(positions: CorePosition[], orders: CoreOrder[], over: Partial<ReconSnapshot> = {}): ReconSnapshot {
  const ordersByPosition = new Map<string, CoreOrder[]>();
  for (const o of orders) ordersByPosition.set(o.positionId as string, [...(ordersByPosition.get(o.positionId as string) ?? []), o]);
  return {
    now: ist('11:00'), positions, ordersByPosition,
    fillQtyByOrder: new Map(orders.map((o) => [o.id, o.filledQty])),
    marginByOrder: new Map(), summarised: new Set(), interestTokensToday: new Set(), stuckAfterMs: STUCK, ...over,
  };
}

describe('intradayFindings (spec §8.3, J17)', () => {
  it('a consistent open position has no finding', () => {
    expect(intradayFindings(snap([openPos()], [ord('o1')]))).toEqual([]);
  });

  it("fills that do not sum to an order's filledQty", () => {
    const s = snap([openPos()], [ord('o1')], { fillQtyByOrder: new Map([['o1', 60]]) });
    expect(intradayFindings(s)).toEqual([expect.objectContaining({ check: 'FILLS_VS_ORDER', positionId: 'pos_1', orderId: 'o1', strategyId: 'cs_ungated', repair: null, fingerprint: 'FILLS_VS_ORDER:pos_1:o1' })]);
  });

  it('a position row that disagrees with its orders — only once the orders have been quiet past the stuck threshold', () => {
    const p = openPos({ entryFilledQty: 80, openQty: 80 });
    expect(intradayFindings(snap([p], [ord('o1', { updatedAt: ist('10:59') })], { now: new Date(ist('10:59').getTime() + 30_000) }))).toEqual([]);
    expect(intradayFindings(snap([p], [ord('o1')]))).toEqual([expect.objectContaining({ check: 'POSITION_VS_ORDERS' })]);
  });

  it('a stuck entry is cancelled; a stuck exit is only flagged (exits are never cancelled)', () => {
    const entry = ord('o1', { state: 'OPEN', filledQty: 0, avgFillPrice: null });
    const pending = positionFor(cashPlan(), { status: 'PENDING_ENTRY', entryFilledQty: 0, openQty: 0, updatedAt: ist('10:00') });
    expect(intradayFindings(snap([pending], [entry]))).toEqual([expect.objectContaining({ check: 'STUCK_ORDER', orderId: 'o1', repair: 'CANCEL_ENTRY' })]);
    const exit = ord('o2', { purpose: 'EXIT', side: 'SELL', state: 'NEW', filledQty: 0, avgFillPrice: null });
    const exiting = openPos({ status: 'EXITING', updatedAt: ist('10:00') });
    const found = intradayFindings(snap([exiting], [ord('o1'), exit]));
    expect(found).toEqual(expect.arrayContaining([expect.objectContaining({ check: 'STUCK_ORDER', orderId: 'o2', repair: null }), expect.objectContaining({ check: 'STUCK_EXITING', positionId: 'pos_1' })]));
  });

  it('a closed position without a summary is a WRITE_SUMMARY repair', () => {
    const closed = openPos({ status: 'CLOSED', exitFilledQty: 100, openQty: 0, closedAt: ist('10:30'), exitReason: 'TARGET' });
    const orders = [ord('o1'), ord('o2', { purpose: 'EXIT', side: 'SELL', avgFillPrice: 515 })];
    expect(intradayFindings(snap([closed], orders))).toEqual([expect.objectContaining({ check: 'SUMMARY_MISSING', repair: 'WRITE_SUMMARY' })]);
    expect(intradayFindings(snap([closed], orders, { summarised: new Set(['pos_1']) }))).toEqual([]);
  });
});

describe('nightlyFindings (15:45 IST)', () => {
  const at = ist('15:45');

  it('an intraday position still open after its square-off time', () => {
    expect(nightlyFindings(snap([openPos()], [ord('o1')], { now: at }))).toEqual([expect.objectContaining({ check: 'INTRADAY_OPEN_AFTER_SQUARE_OFF' })]);
  });

  it('an open MTF holding without an interest row today; with one it is clean', () => {
    const mtf = positionFor(mtfPlan(), { status: 'OPEN', entryFilledQty: 100, openQty: 100, updatedAt: ist('10:00') });
    const orders = [ord('o1', { vehicle: 'MTF' })];
    expect(nightlyFindings(snap([mtf], orders, { now: at }))).toEqual([expect.objectContaining({ check: 'MTF_INTEREST_MISSING' })]);
    expect(nightlyFindings(snap([mtf], orders, { now: at, interestTokensToday: new Set(['2885']) }))).toEqual([]);
  });

  it('margin left on the orders of a closed or cancelled position', () => {
    const closed = openPos({ status: 'CLOSED', exitFilledQty: 100, openQty: 0, closedAt: ist('10:30'), exitReason: 'STOP' });
    const orders = [ord('o1'), ord('o2', { purpose: 'EXIT', side: 'SELL' })];
    const s = snap([closed], orders, { now: at, summarised: new Set(['pos_1']), marginByOrder: new Map([['o1', new Prisma.Decimal('12.50')], ['o2', new Prisma.Decimal(0)]]) });
    expect(nightlyFindings(s)).toEqual([expect.objectContaining({ check: 'MARGIN_LEFT_ON_CLOSED', orderId: 'o1' })]);
  });
});

describe('reconBlockOf (O10)', () => {
  const row = (strategyId: string | null): JournalRow => ({
    id: 'm', userId: 'user_A', type: 'RECON_MISMATCH', positionId: null, strategyId, strategyVersionId: null, intentId: null, symbol: null,
    payload: {}, priceUsed: null, priceAgeMs: null, dedupeKey: null, istDay: '2026-10-13', createdAt: ist('11:00'),
  });

  it('no rows block nothing; strategy rows block those strategies; a user-wide row blocks all', () => {
    expect(reconBlockOf([])).toEqual({ all: false, strategyIds: [] });
    expect(reconBlockOf([row('cs_a'), row('cs_b'), row('cs_a')])).toEqual({ all: false, strategyIds: ['cs_a', 'cs_b'] });
    expect(reconBlockOf([row('cs_a'), row(null)])).toEqual({ all: true, strategyIds: ['cs_a'] });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx jest src/modules/trade-core/journal/recon-checks.spec.ts`
Expected: FAIL — `Cannot find module './recon-checks'`.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/modules/trade-core/journal/recon-checks.ts
import type { Prisma } from '@prisma/client';
import type { CoreOrder } from '../execution/execution.types';
import { isActiveStatus, type CorePosition } from '../lifecycle/lifecycle.types';
import { reducePosition } from '../lifecycle/position-state';
import { hhmmToMinutes } from '../risk-wall/limits/limit-keys';
import { istMinutesOf } from '../risk-wall/session-open';
import type { JournalRow } from './journal.types';

/** Spec §8.3 checks (ruling J17). */
export const RECON_CHECKS = [
  'FILLS_VS_ORDER',
  'POSITION_VS_ORDERS',
  'STUCK_ORDER',
  'STUCK_EXITING',
  'SUMMARY_MISSING',
  'INTRADAY_OPEN_AFTER_SQUARE_OFF',
  'MTF_INTEREST_MISSING',
  'MARGIN_LEFT_ON_CLOSED',
] as const;
export type ReconCheck = (typeof RECON_CHECKS)[number];

export interface ReconFinding {
  check: ReconCheck;
  /** Stable across runs: the same problem has the same fingerprint (J11 dedupe with the IST day). */
  fingerprint: string;
  /** The strategy whose entries a finding blocks; null = every strategy of the user (O10). */
  strategyId: string | null;
  positionId: string | null;
  orderId: string | null;
  detail: string;
  /** CANCEL_ENTRY: cancel a stuck entry order; WRITE_SUMMARY: write the missing summary. Exits are never repaired by cancelling. */
  repair: 'CANCEL_ENTRY' | 'WRITE_SUMMARY' | null;
}

/** One user's core state for today, as the reconciler reads it. */
export interface ReconSnapshot {
  now: Date;
  /** Active positions and those closed or cancelled today. */
  positions: readonly CorePosition[];
  ordersByPosition: ReadonlyMap<string, readonly CoreOrder[]>;
  /** Σ core_fills.qty per order. */
  fillQtyByOrder: ReadonlyMap<string, number>;
  /** Margin each order still holds. */
  marginByOrder: ReadonlyMap<string, Prisma.Decimal>;
  /** CLOSED positions that have a summary. */
  summarised: ReadonlySet<string>;
  /** Tokens with an MTF_INTEREST row for today. */
  interestTokensToday: ReadonlySet<string>;
  /** J18: 2 × noPriceRejectMs. */
  stuckAfterMs: number;
}

export interface ReconBlock {
  all: boolean;
  strategyIds: readonly string[];
}

const OPEN_ORDER_STATES: ReadonlySet<string> = new Set(['NEW', 'OPEN']);
const INTRADAY_VEHICLES: ReadonlySet<string> = new Set(['CASH_INTRADAY', 'OPTIONS_BUY']);
const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const minutes = (ms: number): number => Math.floor(ms / 60_000);

function finding(check: ReconCheck, f: Omit<ReconFinding, 'check' | 'fingerprint'>): ReconFinding {
  return { check, fingerprint: `${check}:${f.positionId ?? '-'}:${f.orderId ?? '-'}`, ...f };
}

export function intradayFindings(s: ReconSnapshot): ReconFinding[] {
  const out: ReconFinding[] = [];
  const now = s.now.getTime();
  for (const p of s.positions) {
    const orders = s.ordersByPosition.get(p.id) ?? [];
    const base = { strategyId: p.strategyId, positionId: p.id };
    for (const o of orders) {
      const filled = s.fillQtyByOrder.get(o.id) ?? 0;
      if (filled !== o.filledQty) {
        out.push(finding('FILLS_VS_ORDER', { ...base, orderId: o.id, repair: null, detail: `order ${o.id} says ${o.filledQty} filled; its fills sum to ${filled}` }));
      }
      if (OPEN_ORDER_STATES.has(o.state) && now - o.submittedAt.getTime() > s.stuckAfterMs) {
        out.push(finding('STUCK_ORDER', {
          ...base, orderId: o.id, repair: o.purpose === 'ENTRY' ? 'CANCEL_ENTRY' : null,
          detail: `${o.purpose} order ${o.id} has been ${o.state} for ${minutes(now - o.submittedAt.getTime())} min`,
        }));
      }
    }
    const newest = orders.reduce((m, o) => Math.max(m, o.updatedAt.getTime()), 0);
    if (orders.length > 0 && now - newest > s.stuckAfterMs) {
      try {
        const f = reducePosition(p.status, orders);
        if (f.entryFilledQty !== p.entryFilledQty || f.exitFilledQty !== p.exitFilledQty) {
          out.push(finding('POSITION_VS_ORDERS', {
            ...base, orderId: null, repair: null,
            detail: `position says entry ${p.entryFilledQty} / exit ${p.exitFilledQty}; its orders say ${f.entryFilledQty} / ${f.exitFilledQty}`,
          }));
        }
      } catch (err) {
        out.push(finding('POSITION_VS_ORDERS', { ...base, orderId: null, repair: null, detail: errorText(err) }));
      }
    }
    if (p.status === 'EXITING') {
      const lastExit = orders.filter((o) => o.purpose === 'EXIT').reduce((m, o) => Math.max(m, o.submittedAt.getTime()), 0);
      const since = lastExit > 0 ? lastExit : p.updatedAt.getTime();
      if (now - since > s.stuckAfterMs) {
        out.push(finding('STUCK_EXITING', { ...base, orderId: null, repair: null, detail: `EXITING with no new exit order for ${minutes(now - since)} min` }));
      }
    }
    if (p.status === 'CLOSED' && !s.summarised.has(p.id)) {
      out.push(finding('SUMMARY_MISSING', { ...base, orderId: null, repair: 'WRITE_SUMMARY', detail: `closed position ${p.id} has no trade summary` }));
    }
  }
  return out;
}

export function nightlyFindings(s: ReconSnapshot): ReconFinding[] {
  const out = intradayFindings(s);
  const nowMin = istMinutesOf(s.now);
  for (const p of s.positions) {
    const base = { strategyId: p.strategyId, positionId: p.id };
    if (isActiveStatus(p.status) && INTRADAY_VEHICLES.has(p.vehicle) && nowMin >= hhmmToMinutes(p.plan.squareOffHhmm)) {
      out.push(finding('INTRADAY_OPEN_AFTER_SQUARE_OFF', { ...base, orderId: null, repair: null, detail: `${p.vehicle} position is ${p.status} after its ${p.plan.squareOffHhmm} square-off` }));
    }
    if (p.vehicle === 'MTF' && isActiveStatus(p.status) && p.openQty > 0 && !s.interestTokensToday.has(p.instrument.token)) {
      out.push(finding('MTF_INTEREST_MISSING', { ...base, orderId: null, repair: null, detail: `no MTF interest row today for ${p.instrument.symbol}` }));
    }
    if (p.status === 'CLOSED' || p.status === 'CANCELLED') {
      for (const o of s.ordersByPosition.get(p.id) ?? []) {
        const m = s.marginByOrder.get(o.id);
        if (m && !m.isZero()) out.push(finding('MARGIN_LEFT_ON_CLOSED', { ...base, orderId: o.id, repair: null, detail: `order ${o.id} of a ${p.status} position still holds ₹${m.toFixed(2)} margin` }));
      }
    }
  }
  return out;
}

/** O10: unacknowledged findings → the entry block the Risk Wall applies (RECON_BLOCKED). */
export function reconBlockOf(rows: readonly JournalRow[]): ReconBlock {
  const ids: string[] = [];
  let all = false;
  for (const r of rows) {
    if (r.strategyId === null) all = true;
    else if (!ids.includes(r.strategyId)) ids.push(r.strategyId);
  }
  return { all, strategyIds: ids };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd apps/api && npx jest src/modules/trade-core/journal/recon-checks.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -- apps/api/src/modules/trade-core/journal/recon-checks.ts apps/api/src/modules/trade-core/journal/recon-checks.spec.ts
git commit -m "feat(trade-core): M5 reconciliation checks (pure)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/api/src/modules/trade-core/journal/recon-checks.ts apps/api/src/modules/trade-core/journal/recon-checks.spec.ts
```

---

### Task 16: `CoreReconciler`, the `RECON_BLOCKED` wall reason, and the acknowledgement

**Files:**
- Create: `apps/api/src/modules/trade-core/journal/core-reconciler.service.ts`
- Test: `apps/api/src/modules/trade-core/journal/core-reconciler.service.spec.ts`
- Modify: `apps/api/src/modules/trade-core/journal/journal-risk-reads.ts` (+ spec): `reconBlock(userId)`
- Modify: `apps/api/src/modules/trade-core/risk-wall/risk-wall.types.ts` (`RECON_BLOCKED`, `RiskLiveState.reconBlocked?`)
- Modify: `apps/api/src/modules/trade-core/risk-wall/risk-wall.ts` (one check in `evaluateEntry`) (+ `risk-wall.spec.ts`)
- Modify: `apps/api/src/modules/trade-core/lifecycle/core-risk-state.provider.ts` (+ spec): `reconBlocked`

**Interfaces:**
- Consumes: Task 15; Task 2 repositories, `listUserIdsSince`, `MemoryJournalStore`; Task 3 reads; `MemoryJournalStore.port()` (no Stream C dependency);
  a `PositionClosedListener` (Task 11 binds the real one in Task 19; the spec uses a fake); `ExecutionAdapter.cancel(userId, orderId)` (M3);
  `CorePaperDefaultsService.settings`; `CORE_SESSION_CLOCK`; `JobRunnerService`; `AUDIT_ACTIONS.journal.CORE_RECON_ACKNOWLEDGED` (Task 1).
- Produces: `RECON_INTERVAL_MS = 300_000`, `CORE_RECON_JOB = 'core-recon-nightly'`; `CoreReconciler` with `runIntraday(now?)`,
  `nightly()` (`@Cron('0 45 15 * * 1-5', { timeZone: 'Asia/Kolkata' })`), `runNightly(now)`,
  `reconcileUser(userId, kind, now): Promise<ReconFinding[]>`, `ack(userId, mismatchId, reason, now?): Promise<{ acknowledged: string }>`,
  `unacked(userId): Promise<JournalRow[]>` (Task 17 uses `ack` and `unacked`). `JournalRiskReadsPort.reconBlock(userId): Promise<ReconBlock>`.
  Risk reason `RECON_BLOCKED`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/modules/trade-core/journal/core-reconciler.service.spec.ts
import type { AuditService } from '../../../common/audit/audit.service';
import type { JobRunnerService } from '../../../common/job-registry';
import type { CoreOrder } from '../execution/execution.types';
import { cashPlan, NOW, positionFor } from '../lifecycle/testing/lifecycle-fixtures';
import { lifecycleHarness, openRequest } from '../lifecycle/testing/lifecycle-harness';
import { CORE_RECON_JOB, CoreReconciler } from './core-reconciler.service';
import { JournalRiskReads } from './journal-risk-reads';
import type { ReconSnapshot } from './recon-checks';
import { MemoryJournalStore } from './testing/memory-journal-store';

beforeEach(() => jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] }));
afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

function setup() {
  const h = lifecycleHarness();
  const store = new MemoryJournalStore();
  const journal = store.port();
  // Stream E does not depend on Task 11: a listener that writes a summary row is enough here.
  const closed = { positionClosed: jest.fn(async (userId: string, positionId: string) => void (await store.summaryRepo.createIfAbsent(store.sampleSummary({ userId, positionId, intentId: positionId })))) };
  const jobs = { run: jest.fn((_n: string, _o: unknown, fn: () => Promise<unknown>) => fn()) };
  const audit = { append: jest.fn().mockResolvedValue({ seq: 1n, hash: 'h' }) };
  const recon = new CoreReconciler(
    h.positions.repo, h.ledger, store.summaryRepo, store.repo, journal, closed, h.adapter, h.defaults,
    { isOpen: () => h.session.open }, jobs as unknown as JobRunnerService, audit as unknown as AuditService,
  );
  return { h, store, journal, closed, jobs, audit, recon, reads: new JournalRiskReads(store.repo) };
}

async function closeOne(s: ReturnType<typeof setup>) {
  const p = await s.h.lifecycle.openPosition(openRequest());
  await s.h.price(500);
  await s.h.price(515);
  await s.h.price(515);
  return p;
}

const mismatches = (s: ReturnType<typeof setup>) => s.store.rows.filter((r) => r.type === 'RECON_MISMATCH');

/** A snapshot with one stuck EXIT order: a finding that is never repaired automatically. */
function stuckExitSnapshot(now: Date): ReconSnapshot {
  const p = positionFor(cashPlan(), { status: 'EXITING', entryFilledQty: 100, openQty: 100, updatedAt: new Date(now.getTime() - 3_600_000) });
  const exit: CoreOrder = {
    id: 'o_exit', userId: 'user_A', idempotencyKey: 'int_1:exit:1', vehicle: 'CASH_INTRADAY', instrument: p.instrument, side: 'SELL', qty: 100, filledQty: 0,
    avgFillPrice: null, type: 'MARKET', limitPrice: null, triggerPrice: null, refPrice: 500, purpose: 'EXIT', strategyVersionId: p.strategyVersionId,
    positionId: p.id, state: 'NEW', rejectReason: null, submittedAt: new Date(now.getTime() - 3_600_000), triggeredAt: null, updatedAt: new Date(now.getTime() - 3_600_000),
  };
  return {
    now, positions: [p], ordersByPosition: new Map([[p.id, [exit]]]), fillQtyByOrder: new Map(), marginByOrder: new Map(),
    summarised: new Set(), interestTokensToday: new Set(), stuckAfterMs: 60_000,
  };
}

describe('CoreReconciler (spec §8.3, J17, Review Focus 4 and 5)', () => {
  it('a clean day has no finding and writes nothing', async () => {
    const s = setup();
    const p = await closeOne(s);
    await s.closed.positionClosed('user_A', p.id);
    expect(await s.recon.reconcileUser('user_A', 'INTRADAY', new Date())).toEqual([]);
    expect(mismatches(s)).toEqual([]);
  });

  it('a missing summary is repaired, not flagged', async () => {
    const s = setup();
    const p = await closeOne(s);
    expect(await s.recon.reconcileUser('user_A', 'INTRADAY', new Date())).toEqual([]);
    expect(s.closed.positionClosed).toHaveBeenCalledWith('user_A', p.id);
    expect(mismatches(s)).toEqual([]);
  });

  it('a repair that fails becomes a RECON_MISMATCH that blocks only that strategy', async () => {
    const s = setup();
    await closeOne(s);
    s.closed.positionClosed.mockRejectedValueOnce(new Error('summary db down'));
    const found = await s.recon.reconcileUser('user_A', 'INTRADAY', new Date());
    expect(found).toEqual([expect.objectContaining({ check: 'SUMMARY_MISSING' })]);
    expect(mismatches(s)).toEqual([expect.objectContaining({ userId: 'user_A', strategyId: 'cs_ungated', payload: expect.objectContaining({ check: 'SUMMARY_MISSING' }) })]);
    expect(await s.reads.reconBlock('user_A')).toEqual({ all: false, strategyIds: ['cs_ungated'] });
  });

  it('a stuck entry order is cancelled and flagged; the owner’s ack lifts the block, audited; another user cannot ack it', async () => {
    const s = setup();
    await s.h.lifecycle.openPosition(openRequest()); // no price ever arrives: the entry stays open
    const settings = await s.h.defaults.settings();
    if (!settings.ok) throw new Error('fixture settings');
    s.h.advance(2 * settings.settings.noPriceRejectMs + 1_000);
    expect(await s.recon.reconcileUser('user_A', 'INTRADAY', new Date())).toEqual([expect.objectContaining({ check: 'STUCK_ORDER', repair: 'CANCEL_ENTRY' })]);
    await s.h.settle();
    expect(s.h.paper.orders[0].state).toBe('CANCELLED');
    const [m] = mismatches(s);
    expect(await s.reads.reconBlock('user_A')).toEqual({ all: false, strategyIds: ['cs_ungated'] });
    await expect(s.recon.ack('user_B', m.id, 'not mine')).rejects.toThrow(/not found/);
    await s.recon.ack('user_A', m.id, 'matcher restarted; checked by hand');
    expect(await s.reads.reconBlock('user_A')).toEqual({ all: false, strategyIds: [] });
    expect(s.audit.append).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user_A', target: `core_journal:${m.id}`, meta: { reason: 'matcher restarted; checked by hand' } }));
  });

  it('an unrepairable finding is journaled once a day; after an ack it blocks again on a later day (Review Focus 5)', async () => {
    const s = setup();
    const day1 = new Date();
    const day2 = new Date(day1.getTime() + 86_400_000);
    const snapshot = jest.spyOn(CoreReconciler.prototype as unknown as { snapshot: (u: string, n: Date) => Promise<ReconSnapshot> }, 'snapshot');
    snapshot.mockImplementation(async (_u: string, now: Date) => stuckExitSnapshot(now));
    const cancel = jest.spyOn(s.h.adapter, 'cancel');
    await s.recon.reconcileUser('user_A', 'INTRADAY', day1);
    const perDay = mismatches(s).length; // STUCK_ORDER (the exit) and STUCK_EXITING
    expect(mismatches(s).map((m) => m.payload.check).sort()).toEqual(['STUCK_EXITING', 'STUCK_ORDER']);
    await s.recon.reconcileUser('user_A', 'INTRADAY', day1);
    expect(mismatches(s)).toHaveLength(perDay);
    expect(mismatches(s).find((m) => m.payload.check === 'STUCK_ORDER')?.payload).toMatchObject({ repair: null, orderId: 'o_exit' });
    expect(cancel).not.toHaveBeenCalled(); // an exit is never cancelled
    for (const m of mismatches(s)) await s.recon.ack('user_A', m.id, 'seen');
    expect((await s.reads.reconBlock('user_A')).strategyIds).toEqual([]);
    await s.recon.reconcileUser('user_A', 'INTRADAY', day2);
    expect(mismatches(s)).toHaveLength(2 * perDay);
    expect((await s.reads.reconBlock('user_A')).strategyIds).toEqual(['cs_ungated']);
  });

  it('the 5-minute run does nothing while NSE is closed; the nightly run goes through the job runner', async () => {
    const s = setup();
    await closeOne(s);
    s.h.session.open = false;
    const spy = jest.spyOn(s.recon, 'reconcileUser');
    await s.recon.runIntraday(new Date());
    expect(spy).not.toHaveBeenCalled();
    await s.recon.runNightly(new Date());
    expect(s.jobs.run).toHaveBeenCalledWith(CORE_RECON_JOB, expect.objectContaining({ onRedisError: 'run-anyway' }), expect.any(Function));
    expect(spy).toHaveBeenCalledWith('user_A', 'NIGHTLY', expect.any(Date));
  });

  it('an unreadable snapshot is logged, never a finding', async () => {
    const s = setup();
    await closeOne(s);
    jest.spyOn(s.h.ledger, 'listPositionOrders').mockRejectedValueOnce(new Error('db down'));
    await expect(s.recon.reconcileUser('user_A', 'INTRADAY', new Date())).resolves.toEqual([]);
    expect(mismatches(s)).toEqual([]);
  });
});
```

Append to `journal-risk-reads.spec.ts`:

```ts
describe('JournalRiskReads.reconBlock (O10)', () => {
  it('unacked findings block their strategies; a null-strategy finding blocks all; an ack lifts it', async () => {
    const s = new MemoryJournalStore();
    const at = new Date('2026-10-13T05:00:00.000Z');
    await s.repo.append([
      { type: 'RECON_MISMATCH', userId: 'user_A', at, strategyId: 'cs_a', payload: {} },
      { type: 'RECON_MISMATCH', userId: 'user_A', at, strategyId: null, payload: {} },
    ]);
    const r = new JournalRiskReads(s.repo);
    expect(await r.reconBlock('user_A')).toEqual({ all: true, strategyIds: ['cs_a'] });
    await s.repo.append([{ type: 'RECON_ACK', userId: 'user_A', at, payload: {}, dedupeKey: `ack:${s.rows[1].id}` }]);
    expect(await r.reconBlock('user_A')).toEqual({ all: false, strategyIds: ['cs_a'] });
    expect(await r.reconBlock('user_B')).toEqual({ all: false, strategyIds: [] });
  });
});
```

Append to `risk-wall.spec.ts`:

```ts
describe('checkRisk: reconciliation block (M5 J12, O10)', () => {
  it('blocks the blocked strategy only; a user-wide block blocks every strategy', () => {
    const blocked = ctxFixture({ state: stateFixture({ reconBlocked: { all: false, strategyIds: ['cs_ungated'] } }) });
    expect(codes(checkRisk(intentFixture({ strategyId: 'cs_ungated' }), blocked))).toEqual(['RECON_BLOCKED']);
    expect(checkRisk(intentFixture({ strategyId: 'cs_adaptive_stop', strategyVersionId: 'csv_adaptive_stop_v1' }), blocked).verdict).not.toBe('REJECT');
    const all = ctxFixture({ state: stateFixture({ reconBlocked: { all: true, strategyIds: [] } }) });
    expect(codes(checkRisk(intentFixture({ strategyId: 'cs_adaptive_stop' }), all))).toContain('RECON_BLOCKED');
  });
});
```

(`codes`, `ctxFixture`, `stateFixture`, `intentFixture` are the spec's existing helpers and fixtures. If `cs_adaptive_stop` trips
another limit in the fixture, assert `not.toContain('RECON_BLOCKED')` instead of the verdict.)

Append to `core-risk-state.provider.spec.ts` (inside the M5 `describe` from Task 14):

```ts
  it('reports the recon block from the journal', async () => {
    const h = lifecycleHarness();
    const reads = { latched: jest.fn().mockResolvedValue(false), reconBlock: jest.fn().mockResolvedValue({ all: false, strategyIds: ['cs_ungated'] }) };
    const state = await new CoreRiskStateProvider(h.ledger, h.positions.repo, h.lifecycle, reads).liveState('user_A', new Date());
    expect(state.reconBlocked).toEqual({ all: false, strategyIds: ['cs_ungated'] });
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/api && npx jest src/modules/trade-core/journal src/modules/trade-core/risk-wall/risk-wall.spec.ts src/modules/trade-core/lifecycle/core-risk-state.provider.spec.ts`
Expected: FAIL — `Cannot find module './core-reconciler.service'`; `reconBlock is not a function`; `RECON_BLOCKED` absent.

- [ ] **Step 3: Implement**

`risk-wall.types.ts`: append `'RECON_BLOCKED'` to `RISK_REASON_CODES` (after `'JOURNAL_UNAVAILABLE'`), and add to
`RiskLiveState`:

```ts
  /**
   * SP2 M5 (J12, O10): unacknowledged reconciliation findings. Absent = none (M2–M4 providers).
   * `all` blocks every strategy of the user; otherwise only the listed strategies.
   */
  reconBlocked?: { all: boolean; strategyIds: readonly string[] };
```

`risk-wall.ts`, in `evaluateEntry`, right after the `KILL_SWITCH` line:

```ts
  const rb = state.reconBlocked;
  if (rb && (rb.all || rb.strategyIds.includes(intent.strategyId))) {
    add('RECON_BLOCKED', `a reconciliation finding blocks new entries${rb.all ? '' : ' for this strategy'} until the owner acknowledges it`);
  }
```

`journal-risk-reads.ts` — add the import `import { reconBlockOf, type ReconBlock } from './recon-checks';`, the interface member
and the method:

```ts
  /** O10: what unacknowledged reconciliation findings block. */
  reconBlock(userId: string): Promise<ReconBlock>;
```

```ts
  async reconBlock(userId: string): Promise<ReconBlock> {
    return reconBlockOf(await this.repo.unackedMismatches(userId));
  }
```

`core-risk-state.provider.ts` — extend the `Promise.all` once more and return the block:

```ts
      this.reads ? this.reads.reconBlock(userId) : Promise.resolve({ all: false, strategyIds: [] as readonly string[] }),
```

(destructured as `reconBlocked`; add `reconBlocked` to the returned object.)

```ts
// apps/api/src/modules/trade-core/journal/core-reconciler.service.ts
import { Inject, Injectable, Logger, NotFoundException, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AUDIT_ACTIONS } from '../../../common/audit/audit-actions';
import { AuditService } from '../../../common/audit/audit.service';
import { JobRunnerService } from '../../../common/job-registry';
import { BOOT_JOBS_DISABLED, bootJobsEnabled } from '../../../common/utils/boot-jobs';
import type { SessionClock } from '../../market-hub/session-clock';
import type { CoreOrder, ExecutionAdapter } from '../execution/execution.types';
import { PRICE_MAX_AGE_MS } from '../execution/fill-model';
import { istDate, istDayStart } from '../execution/ledger-math';
import { CORE_EXECUTION_ADAPTER } from '../execution/paper-execution.adapter';
import { PaperLedgerService } from '../execution/paper-ledger.service';
import { CorePaperDefaultsService } from '../execution/services/core-paper-defaults.service';
import { CorePositionRepository } from '../lifecycle/repositories/core-position.repository';
import { CORE_SESSION_CLOCK } from '../risk-wall/ports';
import { CORE_JOURNAL, CORE_POSITION_CLOSED, type CoreJournalPort, type PositionClosedListener } from './journal-ports';
import type { JournalRow } from './journal.types';
import { intradayFindings, nightlyFindings, type ReconFinding, type ReconSnapshot } from './recon-checks';
import { CoreJournalRepository } from './repositories/core-journal.repository';
import { CoreTradeSummaryRepository } from './repositories/core-trade-summary.repository';

/** Spec §8.3: every 5 minutes in session. */
export const RECON_INTERVAL_MS = 300_000;
export const CORE_RECON_JOB = 'core-recon-nightly';
const RECON_LEASE_MS = 30 * 60_000;

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Spec §8.3 (J17, J18, O10). Every 5 minutes while NSE is open, and nightly at 15:45 IST, for each
 * user with core activity today: read a snapshot, run the pure checks, repair what is repairable
 * (a missing summary is written; a stuck ENTRY order is cancelled — an exit never is), and journal
 * the rest as RECON_MISMATCH (once per finding per IST day), which blocks the strategy's entries
 * until the owner acknowledges it. A snapshot that cannot be read is logged, never a finding.
 */
@Injectable()
export class CoreReconciler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CoreReconciler.name);
  private readonly flagged = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly positions: CorePositionRepository,
    private readonly ledger: PaperLedgerService,
    private readonly summaries: CoreTradeSummaryRepository,
    private readonly journalRepo: CoreJournalRepository,
    @Inject(CORE_JOURNAL) private readonly journal: CoreJournalPort,
    @Inject(CORE_POSITION_CLOSED) private readonly closed: PositionClosedListener,
    @Inject(CORE_EXECUTION_ADAPTER) private readonly adapter: ExecutionAdapter,
    private readonly defaults: CorePaperDefaultsService,
    @Inject(CORE_SESSION_CLOCK) private readonly clock: Pick<SessionClock, 'isOpen'>,
    private readonly jobs: JobRunnerService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    if (!bootJobsEnabled()) {
      this.logger.log(BOOT_JOBS_DISABLED);
      return;
    }
    this.timer = setInterval(() => void this.runIntraday(), RECON_INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runIntraday(now: Date = new Date()): Promise<void> {
    if (this.running || !this.clock.isOpen('NSE', now)) return;
    this.running = true;
    try {
      for (const userId of await this.positions.listUserIdsSince(istDayStart(now))) await this.reconcileUser(userId, 'INTRADAY', now);
    } catch (err) {
      this.logger.error(`reconciliation run failed: ${errorText(err)}`);
    } finally {
      this.running = false;
    }
  }

  @Cron('0 45 15 * * 1-5', { name: CORE_RECON_JOB, timeZone: 'Asia/Kolkata' })
  async nightly(): Promise<void> {
    await this.runNightly(new Date());
  }

  async runNightly(now: Date): Promise<void> {
    try {
      await this.jobs.run(CORE_RECON_JOB, { ttlMs: RECON_LEASE_MS, onRedisError: 'run-anyway' }, async () => {
        const users = await this.positions.listUserIdsSince(istDayStart(now));
        let findings = 0;
        for (const userId of users) findings += (await this.reconcileUser(userId, 'NIGHTLY', now)).length;
        this.logger.log(`nightly reconciliation ${istDate(now)}: ${users.length} user(s), ${findings} finding(s)`);
        return { users: users.length, findings };
      });
    } catch (err) {
      this.logger.error(`nightly reconciliation failed: ${errorText(err)}`);
    }
  }

  async reconcileUser(userId: string, kind: 'INTRADAY' | 'NIGHTLY', now: Date): Promise<ReconFinding[]> {
    let snap: ReconSnapshot;
    try {
      snap = await this.snapshot(userId, now);
    } catch (err) {
      this.logger.error(`reconciliation of ${userId} skipped (snapshot unreadable): ${errorText(err)}`);
      return [];
    }
    const remaining: ReconFinding[] = [];
    for (const found of kind === 'NIGHTLY' ? nightlyFindings(snap) : intradayFindings(snap)) {
      let f = found;
      if (f.repair === 'WRITE_SUMMARY' && f.positionId) {
        try {
          await this.closed.positionClosed(userId, f.positionId);
          if ((await this.summaries.positionIdsWithSummary(userId, [f.positionId])).has(f.positionId)) continue;
        } catch (err) {
          f = { ...f, detail: `${f.detail}; the repair failed: ${errorText(err)}` };
        }
      }
      if (f.repair === 'CANCEL_ENTRY' && f.orderId) {
        try {
          await this.adapter.cancel(userId, f.orderId);
          f = { ...f, detail: `${f.detail}; the entry was cancelled` };
        } catch (err) {
          f = { ...f, detail: `${f.detail}; the cancel failed: ${errorText(err)}` };
        }
      }
      remaining.push(f);
      const dedupeKey = `recon:${istDate(now)}:${f.fingerprint}`;
      try {
        await this.journal.recordNow({
          type: 'RECON_MISMATCH', userId, at: now, positionId: f.positionId, strategyId: f.strategyId,
          payload: { check: f.check, detail: f.detail, kind, fingerprint: f.fingerprint, orderId: f.orderId, repair: f.repair }, dedupeKey,
        });
        if (!this.flagged.has(dedupeKey)) {
          this.flagged.add(dedupeKey);
          this.logger.error(`RECON_MISMATCH ${userId} ${f.check}: ${f.detail} — entries for ${f.strategyId ?? 'every strategy'} blocked until acknowledged`);
        }
      } catch (err) {
        this.logger.error(`RECON_MISMATCH for ${userId} (${f.check}) not journaled: ${errorText(err)}`);
      }
    }
    return remaining;
  }

  /** The owner acknowledges a finding (O10): its entry block lifts. Audited; an audit failure never fails the ack. */
  async ack(userId: string, mismatchId: string, reason: string, now: Date = new Date()): Promise<{ acknowledged: string }> {
    const row = await this.journalRepo.findForUser(userId, mismatchId);
    if (!row || row.type !== 'RECON_MISMATCH') throw new NotFoundException(`reconciliation finding ${mismatchId} not found`);
    await this.journal.recordNow({
      type: 'RECON_ACK', userId, at: now, positionId: row.positionId, strategyId: row.strategyId,
      payload: { mismatchId, reason, check: row.payload.check ?? null }, dedupeKey: `ack:${mismatchId}`,
    });
    try {
      await this.audit.append({ action: AUDIT_ACTIONS.journal.CORE_RECON_ACKNOWLEDGED, userId, target: `core_journal:${mismatchId}`, meta: { reason } });
    } catch (err) {
      this.logger.error(`CORE_RECON_ACKNOWLEDGED audit failed for ${mismatchId} (the ack is journaled): ${errorText(err)}`);
    }
    return { acknowledged: mismatchId };
  }

  unacked(userId: string): Promise<JournalRow[]> {
    return this.journalRepo.unackedMismatches(userId);
  }

  private async snapshot(userId: string, now: Date): Promise<ReconSnapshot> {
    const settings = await this.defaults.settings(now.getTime());
    const stuckAfterMs = 2 * (settings.ok ? settings.settings.noPriceRejectMs : PRICE_MAX_AGE_MS);
    const positions = await this.positions.listForUser(userId, istDayStart(now));
    const ordersByPosition = new Map<string, CoreOrder[]>();
    for (const p of positions) ordersByPosition.set(p.id, await this.ledger.listPositionOrders(userId, p.id));
    const orderIds = [...ordersByPosition.values()].flat().map((o) => o.id);
    const [fills, marginByOrder, interestTokensToday, summarised] = await Promise.all([
      this.ledger.fillsFor(userId, orderIds),
      this.ledger.marginByOrder(userId, orderIds),
      this.ledger.interestTokensOn(userId, istDate(now)),
      this.summaries.positionIdsWithSummary(userId, positions.filter((p) => p.status === 'CLOSED').map((p) => p.id)),
    ]);
    const fillQtyByOrder = new Map<string, number>();
    for (const f of fills) fillQtyByOrder.set(f.orderId, (fillQtyByOrder.get(f.orderId) ?? 0) + f.qty);
    return { now, positions, ordersByPosition, fillQtyByOrder, marginByOrder, summarised, interestTokensToday, stuckAfterMs };
  }
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `cd apps/api && npx jest src/modules/trade-core src/common/schedule/cron-timezone.spec.ts`
Expected: PASS (the ratchet sees the new `@Cron` with `timeZone`).

- [ ] **Step 5: Commit**

```bash
git add -- apps/api/src/modules/trade-core/journal/core-reconciler.service.ts apps/api/src/modules/trade-core/journal/core-reconciler.service.spec.ts
git commit -m "feat(trade-core): M5 reconciliation (5-minute and 15:45 IST), RECON_BLOCKED entries until acknowledged" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/api/src/modules/trade-core/journal/core-reconciler.service.ts apps/api/src/modules/trade-core/journal/core-reconciler.service.spec.ts apps/api/src/modules/trade-core/journal/journal-risk-reads.ts apps/api/src/modules/trade-core/journal/journal-risk-reads.spec.ts apps/api/src/modules/trade-core/risk-wall/risk-wall.types.ts apps/api/src/modules/trade-core/risk-wall/risk-wall.ts apps/api/src/modules/trade-core/risk-wall/risk-wall.spec.ts apps/api/src/modules/trade-core/lifecycle/core-risk-state.provider.ts apps/api/src/modules/trade-core/lifecycle/core-risk-state.provider.spec.ts
```

---

## Stream F — surfaces (API and the Core Journal page)

### Task 17: The journal API — day, position timeline, status, acknowledgement, comparison

**Files:**
- Create: `apps/api/src/modules/trade-core/journal/daily-summary.ts`
- Test: `apps/api/src/modules/trade-core/journal/daily-summary.spec.ts`
- Create: `apps/api/src/modules/trade-core/journal/silo-comparison.reader.ts`
- Test: `apps/api/src/modules/trade-core/journal/silo-comparison.reader.spec.ts`
- Create: `apps/api/src/modules/trade-core/journal/dto/core-journal.dto.ts`
- Create: `apps/api/src/modules/trade-core/journal/controllers/core-journal.controller.ts`
- Test: `apps/api/src/modules/trade-core/journal/controllers/core-journal.controller.spec.ts`

**Interfaces:**
- Consumes: Task 2 repositories (`listForDay`, `listForPosition`, `findByPosition`, `listForDay` of summaries), `CorePositionRepository.findForUser / findByIntent / listForUser`;
  Task 1 tokens `CORE_RECON_DESK`, `CORE_INTAKE_STATUS`, `CORE_JOURNAL_STATUS`; `CurrentUser`, `AdminOnly`; `istDate`, `istDayStart`, `isActiveStatus`;
  `PrismaService` (`adaptiveStopWatchEntry`, `adaptiveStopTrade`, `ungatedWatchEntry`, `ungatedTrade`, read-only).
- Produces: `DailySummary`, `dailySummary(trades)`; `ComparisonRow`, `SiloComparisonReader.forDay(userId, day)`; routes under
  `api/trade-core/journal`: `GET day?day=`, `GET positions/:id`, `GET status`, `POST recon/:id/ack` `{ reason }`, `GET comparison?day=` (admin).
  Wire shapes (Task 18 mirrors them): `{ day, summary, trades, setups, skips, latched, notices }`, `{ position, events, summary }`,
  `{ entries, journal, positions: { active, blind, exiting }, mismatches }`, `{ acknowledged }`, `ComparisonRow[]`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/modules/trade-core/journal/daily-summary.spec.ts
import { dailySummary } from './daily-summary';
import { MemoryJournalStore } from './testing/memory-journal-store';

describe('dailySummary (spec §8.4: net P&L, trades, win rate, charges as % of gross)', () => {
  const s = new MemoryJournalStore();
  const t = (over: Parameters<MemoryJournalStore['sampleSummary']>[0]) => ({ ...s.sampleSummary(over), id: 'x', createdAt: new Date() });

  it('adds the day up; costs = charges + MTF interest; % of |gross|', () => {
    const win = t({ grossPnl: '1250.00', charges: '43.00', mtfInterest: '0.00', netPnl: '1207.00' });
    const loss = t({ positionId: 'p2', grossPnl: '-200.00', charges: '40.00', mtfInterest: '10.00', netPnl: '-250.00' });
    expect(dailySummary([win, loss])).toEqual({
      trades: 2, wins: 1, losses: 1, winRatePct: '50.0', grossPnl: '1050.00', costs: '93.00', netPnl: '957.00', costsPctOfGross: '8.9',
    });
  });

  it('an empty day has no rates', () => {
    expect(dailySummary([])).toEqual({ trades: 0, wins: 0, losses: 0, winRatePct: null, grossPnl: '0.00', costs: '0.00', netPnl: '0.00', costsPctOfGross: null });
  });
});
```

```ts
// apps/api/src/modules/trade-core/journal/silo-comparison.reader.spec.ts
import type { PrismaService } from '../../../common/prisma/prisma.service';
import type { CorePositionRepository } from '../lifecycle/repositories/core-position.repository';
import { SiloComparisonReader } from './silo-comparison.reader';
import { MemoryJournalStore } from './testing/memory-journal-store';

const AT = new Date('2026-10-13T05:00:00.000Z');

describe('SiloComparisonReader (spec §8.4, J21)', () => {
  it("pairs each core setup with the silo's entry for the same alert and token", async () => {
    const store = new MemoryJournalStore();
    const alert = (intentId: string, token: string, strategyKey: string) => ({
      type: 'ALERT_RECEIVED' as const, userId: 'user_A', at: AT, intentId, symbol: 'X-EQ', strategyId: `cs_${strategyKey}`, payload: { alertId: 'alert_1', token, strategyKey },
    });
    await store.repo.append([
      alert('ci_traded', '2885', 'adaptive-stop'),
      alert('ci_skipped', '1594', 'ungated'),
      { type: 'INTENT_SKIPPED', userId: 'user_A', at: AT, intentId: 'ci_skipped', payload: { reason: 'STALE_ENTRY' } },
      alert('ci_open', '3045', 'adaptive-stop'),
    ]);
    await store.summaryRepo.createIfAbsent(store.sampleSummary({ intentId: 'ci_traded', positionId: 'pos_t', netPnl: '1207.00', exitReason: 'TARGET', qty: 200, istDay: '2026-10-13' }));
    const prisma = {
      adaptiveStopWatchEntry: { findMany: jest.fn().mockResolvedValue([{ alertId: 'alert_1', token: '2885', status: 'EXECUTED', paperTradeId: 'ast_1' }]) },
      adaptiveStopTrade: { findMany: jest.fn().mockResolvedValue([{ id: 'ast_1', pnl: 900, fees: 40, exitReasonTag: 'TRAIL', status: 'CLOSED' }]) },
      ungatedWatchEntry: { findMany: jest.fn().mockResolvedValue([{ alertId: 'alert_1', token: '1594', status: 'EXECUTED', paperTradeId: 'ugt_1' }]) },
      ungatedTrade: { findMany: jest.fn().mockResolvedValue([{ id: 'ugt_1', pnl: -300, fees: 35, exitReasonTag: 'STOP', status: 'CLOSED' }]) },
    };
    const positions = { findByIntent: jest.fn(async (id: string) => (id === 'ci_open' ? { id: 'pos_o', status: 'OPEN', entryFilledQty: 100 } : null)) };
    const rows = await new SiloComparisonReader(prisma as unknown as PrismaService, store.repo, store.summaryRepo, positions as unknown as CorePositionRepository).forDay('user_A', '2026-10-13');
    expect(rows).toEqual([
      expect.objectContaining({ intentId: 'ci_traded', strategyKey: 'adaptive-stop', core: { outcome: 'TRADED', reason: 'TARGET', netPnl: '1207.00', qty: 200 }, silo: { track: 'adaptive-stop', status: 'EXECUTED', pnl: 900, fees: 40, exitReason: 'TRAIL' } }),
      expect.objectContaining({ intentId: 'ci_skipped', core: { outcome: 'SKIPPED', reason: 'STALE_ENTRY', netPnl: null, qty: null }, silo: expect.objectContaining({ track: 'ungated', pnl: -300 }) }),
      expect.objectContaining({ intentId: 'ci_open', core: { outcome: 'OPEN', reason: 'OPEN', netPnl: null, qty: 100 }, silo: null }),
    ]);
    expect(prisma.adaptiveStopWatchEntry.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { alertId: { in: ['alert_1'] } } }));
  });
});
```

```ts
// apps/api/src/modules/trade-core/journal/controllers/core-journal.controller.spec.ts
import { NotFoundException } from '@nestjs/common';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import type { CorePositionRepository } from '../../lifecycle/repositories/core-position.repository';
import { AckReconDto, JournalDayQueryDto } from '../dto/core-journal.dto';
import type { SiloComparisonReader } from '../silo-comparison.reader';
import { MemoryJournalStore } from '../testing/memory-journal-store';
import { CoreJournalController } from './core-journal.controller';

const AT = new Date('2026-10-13T05:00:00.000Z');

function setup() {
  const store = new MemoryJournalStore();
  const positions = {
    findForUser: jest.fn(async (userId: string, id: string) => (userId === 'user_A' && id === 'pos_1' ? { id: 'pos_1', intentId: 'ci_1', createdAt: AT, status: 'CLOSED' } : null)),
    listForUser: jest.fn().mockResolvedValue([{ status: 'OPEN', blindSince: AT }, { status: 'EXITING', blindSince: null }, { status: 'CLOSED', blindSince: null }]),
  };
  const desk = { ack: jest.fn().mockResolvedValue({ acknowledged: 'jr_9' }), unacked: jest.fn().mockResolvedValue([]) };
  const intake = { status: () => ({ mode: 'journal' as const, users: 1, pending: 0, dropped: 0 }) };
  const journalStatus = { status: () => ({ pending: 0, written: 10, dropped: 0, failures: 0, lastError: null }) };
  const comparison = { forDay: jest.fn().mockResolvedValue([]) };
  const c = new CoreJournalController(store.repo, store.summaryRepo, positions as unknown as CorePositionRepository, comparison as unknown as SiloComparisonReader, desk, intake, journalStatus);
  return { store, positions, desk, comparison, c };
}

describe('CoreJournalController (spec §8.4)', () => {
  it("day: the caller's summary, trades, setup count, skips by reason, the latch and notices", async () => {
    const { store, c } = setup();
    await store.summaryRepo.createIfAbsent(store.sampleSummary({ istDay: '2026-10-13' }));
    await store.repo.append([
      { type: 'ALERT_RECEIVED', userId: 'user_A', at: AT, intentId: 'ci_1', payload: {} },
      { type: 'INTENT_SKIPPED', userId: 'user_A', at: AT, intentId: 'ci_2', payload: { reason: 'GATE' } },
      { type: 'INTENT_SKIPPED', userId: 'user_A', at: AT, intentId: 'ci_3', payload: { reason: 'GATE' } },
      { type: 'DAILY_LOSS_LATCHED', userId: 'user_A', at: AT, payload: {} },
      { type: 'INTENT_SKIPPED', userId: 'user_B', at: AT, intentId: 'ci_b', payload: { reason: 'COOLDOWN' } },
    ]);
    const r = await c.day('user_A', { day: '2026-10-13' });
    expect(r).toMatchObject({ day: '2026-10-13', setups: 1, skips: { GATE: 2 }, latched: true, summary: { trades: 1, netPnl: '1460.00' } });
    expect(r.trades).toHaveLength(1);
  });

  it('a position timeline is its rows plus its intent’s alert and verdict; 404 for another user', async () => {
    const { store, c } = setup();
    await store.repo.append([
      { type: 'ALERT_RECEIVED', userId: 'user_A', at: AT, intentId: 'ci_1', payload: {} },
      { type: 'RISK_VERDICT', userId: 'user_A', at: new Date(AT.getTime() + 1), intentId: 'ci_1', payload: {} },
      { type: 'POSITION_STATE', userId: 'user_A', at: new Date(AT.getTime() + 2), positionId: 'pos_1', payload: { to: 'OPEN' } },
    ]);
    const r = await c.position('user_A', 'pos_1');
    expect(r.events.map((e) => e.type)).toEqual(['ALERT_RECEIVED', 'RISK_VERDICT', 'POSITION_STATE']);
    await expect(c.position('user_B', 'pos_1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('status: entries, journal health, active / blind / exiting, unacknowledged findings', async () => {
    const { c } = setup();
    expect(await c.status('user_A')).toEqual({
      entries: { mode: 'journal', users: 1, pending: 0, dropped: 0 },
      journal: { pending: 0, written: 10, dropped: 0, failures: 0, lastError: null },
      positions: { active: 2, blind: 1, exiting: 1 },
      mismatches: [],
    });
  });

  it('ack passes the trimmed reason for the caller; the body must say why; a day must be a date', async () => {
    const { desk, c } = setup();
    expect(await c.ack('user_A', 'jr_9', { reason: '  checked  ' })).toEqual({ acknowledged: 'jr_9' });
    expect(desk.ack).toHaveBeenCalledWith('user_A', 'jr_9', 'checked');
    expect(await validate(plainToInstance(AckReconDto, { reason: '   ' }))).toHaveLength(1);
    expect(await validate(plainToInstance(AckReconDto, { reason: 'checked' }))).toHaveLength(0);
    expect(await validate(plainToInstance(JournalDayQueryDto, { day: '13-10-2026' }))).toHaveLength(1);
    expect(await validate(plainToInstance(JournalDayQueryDto, {}))).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/api && npx jest src/modules/trade-core/journal/daily-summary.spec.ts src/modules/trade-core/journal/silo-comparison.reader.spec.ts src/modules/trade-core/journal/controllers`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/modules/trade-core/journal/daily-summary.ts
import { Prisma } from '@prisma/client';
import { ZERO } from '../execution/ledger-math';
import type { TradeSummary } from './journal.types';

const D = Prisma.Decimal;

/** Spec §8.4 daily summary. Costs = charges + MTF interest; their share of |gross| (null when gross is 0). */
export interface DailySummary {
  trades: number;
  wins: number;
  losses: number;
  winRatePct: string | null;
  grossPnl: string;
  costs: string;
  netPnl: string;
  costsPctOfGross: string | null;
}

export function dailySummary(trades: readonly TradeSummary[]): DailySummary {
  let gross = ZERO;
  let costs = ZERO;
  let net = ZERO;
  let wins = 0;
  for (const t of trades) {
    gross = gross.plus(t.grossPnl);
    costs = costs.plus(t.charges).plus(t.mtfInterest);
    net = net.plus(t.netPnl);
    if (new D(t.netPnl).gt(0)) wins += 1;
  }
  const n = trades.length;
  return {
    trades: n,
    wins,
    losses: n - wins,
    winRatePct: n > 0 ? ((wins / n) * 100).toFixed(1) : null,
    grossPnl: gross.toFixed(2),
    costs: costs.toFixed(2),
    netPnl: net.toFixed(2),
    costsPctOfGross: gross.isZero() ? null : costs.div(gross.abs()).mul(100).toFixed(1),
  };
}
```

```ts
// apps/api/src/modules/trade-core/journal/silo-comparison.reader.ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { CorePositionRepository } from '../lifecycle/repositories/core-position.repository';
import { CoreJournalRepository } from './repositories/core-journal.repository';
import { CoreTradeSummaryRepository } from './repositories/core-trade-summary.repository';

export interface ComparisonRow {
  alertId: string;
  symbol: string | null;
  token: string;
  strategyKey: string;
  intentId: string;
  core: { outcome: 'TRADED' | 'OPEN' | 'SKIPPED' | 'PENDING'; reason: string | null; netPnl: string | null; qty: number | null };
  silo: { track: 'adaptive-stop' | 'ungated'; status: string; pnl: number | null; fees: number | null; exitReason: string | null } | null;
}

type SiloEntry = { alertId: string | null; token: string; status: string; paperTradeId: string | null };
type SiloTrade = { id: string; pnl: number | null; fees: number; exitReasonTag: string | null; status: string };

/**
 * Spec §8.4 comparison view (J21): the core result beside the old silo's for the same Chartink alert.
 * Read-only on the silo tables (approach A), admin-only (they are platform-wide, not per user).
 */
@Injectable()
export class SiloComparisonReader {
  constructor(
    private readonly prisma: PrismaService,
    private readonly journal: CoreJournalRepository,
    private readonly summaries: CoreTradeSummaryRepository,
    private readonly positions: CorePositionRepository,
  ) {}

  async forDay(userId: string, day: string): Promise<ComparisonRow[]> {
    const rows = await this.journal.listForDay(userId, day, ['ALERT_RECEIVED', 'INTENT_SKIPPED']);
    const setups = rows.filter((r) => r.type === 'ALERT_RECEIVED' && r.intentId);
    if (setups.length === 0) return [];
    const skipOf = new Map(rows.filter((r) => r.type === 'INTENT_SKIPPED').map((r) => [r.intentId, r]));
    const tradeOf = new Map((await this.summaries.listForDay(userId, day)).map((s) => [s.intentId, s]));
    const alertIds = [...new Set(setups.map((r) => String(r.payload.alertId)))];
    const silo = {
      'adaptive-stop': await this.silo(alertIds, this.prisma.adaptiveStopWatchEntry, this.prisma.adaptiveStopTrade),
      ungated: await this.silo(alertIds, this.prisma.ungatedWatchEntry, this.prisma.ungatedTrade),
    } as const;
    const out: ComparisonRow[] = [];
    for (const r of setups) {
      const intentId = r.intentId as string;
      const alertId = String(r.payload.alertId);
      const token = String(r.payload.token);
      const strategyKey = String(r.payload.strategyKey ?? '');
      const trade = tradeOf.get(intentId);
      const skip = skipOf.get(intentId);
      let core: ComparisonRow['core'];
      if (trade) core = { outcome: 'TRADED', reason: trade.exitReason, netPnl: trade.netPnl, qty: trade.qty };
      else if (skip) core = { outcome: 'SKIPPED', reason: String(skip.payload.reason ?? 'UNKNOWN'), netPnl: null, qty: null };
      else {
        const pos = await this.positions.findByIntent(intentId);
        core = pos ? { outcome: 'OPEN', reason: pos.status, netPnl: null, qty: pos.entryFilledQty } : { outcome: 'PENDING', reason: null, netPnl: null, qty: null };
      }
      const track = strategyKey === 'adaptive-stop' || strategyKey === 'ungated' ? strategyKey : null;
      const s = track ? silo[track].get(`${alertId}|${token}`) : undefined;
      out.push({ alertId, symbol: r.symbol, token, strategyKey, intentId, core, silo: s && track ? { track, ...s } : null });
    }
    return out;
  }

  private async silo(
    alertIds: string[],
    entries: { findMany(args: unknown): Promise<unknown[]> },
    trades: { findMany(args: unknown): Promise<unknown[]> },
  ): Promise<Map<string, { status: string; pnl: number | null; fees: number | null; exitReason: string | null }>> {
    const es = (await entries.findMany({ where: { alertId: { in: alertIds } }, select: { alertId: true, token: true, status: true, paperTradeId: true } })) as SiloEntry[];
    const ids = es.map((e) => e.paperTradeId).filter((x): x is string => x !== null);
    const ts = ids.length ? ((await trades.findMany({ where: { id: { in: ids } }, select: { id: true, pnl: true, fees: true, exitReasonTag: true, status: true } })) as SiloTrade[]) : [];
    const tradeById = new Map(ts.map((t) => [t.id, t]));
    const out = new Map<string, { status: string; pnl: number | null; fees: number | null; exitReason: string | null }>();
    for (const e of es) {
      const t = e.paperTradeId ? tradeById.get(e.paperTradeId) : undefined;
      out.set(`${e.alertId}|${e.token}`, { status: String(e.status), pnl: t?.pnl ?? null, fees: t?.fees ?? null, exitReason: t?.exitReasonTag ?? null });
    }
    return out;
  }
}
```

(Core `reason` for a TRADED row is its exit reason; for an OPEN row, the position status. The `silo` row's `status` is the
silo entry's `WatchStatus`.)

```ts
// apps/api/src/modules/trade-core/journal/dto/core-journal.dto.ts
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class JournalDayQueryDto {
  /** IST date; today when absent. */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'day must be YYYY-MM-DD' })
  day?: string;
}

export class AckReconDto {
  @IsString()
  @MaxLength(500)
  @Matches(/\S/, { message: 'reason must say why' })
  reason!: string;
}
```

```ts
// apps/api/src/modules/trade-core/journal/controllers/core-journal.controller.ts
import { Body, Controller, Get, HttpCode, HttpStatus, Inject, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AdminOnly, CurrentUser } from '../../../../common/decorators';
import { istDate, istDayStart } from '../../execution/ledger-math';
import { isActiveStatus, type CorePosition } from '../../lifecycle/lifecycle.types';
import { CorePositionRepository } from '../../lifecycle/repositories/core-position.repository';
import { dailySummary, type DailySummary } from '../daily-summary';
import { AckReconDto, JournalDayQueryDto } from '../dto/core-journal.dto';
import {
  CORE_INTAKE_STATUS, CORE_JOURNAL_STATUS, CORE_RECON_DESK,
  type IntakeStatusSource, type JournalStatusSource, type ReconDesk,
} from '../journal-ports';
import type { JournalRow, TradeSummary } from '../journal.types';
import { CoreJournalRepository } from '../repositories/core-journal.repository';
import { CoreTradeSummaryRepository } from '../repositories/core-trade-summary.repository';
import { SiloComparisonReader, type ComparisonRow } from '../silo-comparison.reader';

const NOTICE_TYPES = new Set(['KILL_SWITCH', 'LIMIT_CHANGED', 'RECON_MISMATCH']);

/**
 * Spec §8.4 Journal page API. The caller's own rows only (the user comes from the token); the
 * comparison reads platform-wide silo tables and is admin-only. Read-only except the ack (O10).
 */
@ApiTags('Trade core: journal')
@Controller('api/trade-core/journal')
export class CoreJournalController {
  constructor(
    private readonly journal: CoreJournalRepository,
    private readonly summaries: CoreTradeSummaryRepository,
    private readonly positions: CorePositionRepository,
    private readonly comparisonReader: SiloComparisonReader,
    @Inject(CORE_RECON_DESK) private readonly desk: ReconDesk,
    @Inject(CORE_INTAKE_STATUS) private readonly intake: IntakeStatusSource,
    @Inject(CORE_JOURNAL_STATUS) private readonly journalStatus: JournalStatusSource,
  ) {}

  @Get('day')
  async day(
    @CurrentUser('userId') userId: string,
    @Query() q: JournalDayQueryDto,
  ): Promise<{ day: string; summary: DailySummary; trades: TradeSummary[]; setups: number; skips: Record<string, number>; latched: boolean; notices: JournalRow[] }> {
    const day = q.day ?? istDate(new Date());
    const [trades, rows] = await Promise.all([
      this.summaries.listForDay(userId, day),
      this.journal.listForDay(userId, day, ['ALERT_RECEIVED', 'INTENT_SKIPPED', 'DAILY_LOSS_LATCHED', 'KILL_SWITCH', 'LIMIT_CHANGED', 'RECON_MISMATCH']),
    ]);
    const skips: Record<string, number> = {};
    for (const r of rows) {
      if (r.type !== 'INTENT_SKIPPED') continue;
      const reason = String(r.payload.reason ?? 'UNKNOWN');
      skips[reason] = (skips[reason] ?? 0) + 1;
    }
    return {
      day,
      summary: dailySummary(trades),
      trades,
      setups: rows.filter((r) => r.type === 'ALERT_RECEIVED').length,
      skips,
      latched: rows.some((r) => r.type === 'DAILY_LOSS_LATCHED'),
      notices: rows.filter((r) => NOTICE_TYPES.has(r.type)),
    };
  }

  @Get('positions/:id')
  async position(@CurrentUser('userId') userId: string, @Param('id') id: string): Promise<{ position: CorePosition; events: JournalRow[]; summary: TradeSummary | null }> {
    const position = await this.positions.findForUser(userId, id);
    if (!position) throw new NotFoundException(`core position ${id} not found`);
    const [own, sameDay, summary] = await Promise.all([
      this.journal.listForPosition(userId, id),
      this.journal.listForDay(userId, istDate(position.createdAt), ['ALERT_RECEIVED', 'RISK_VERDICT']),
      this.summaries.findByPosition(userId, id),
    ]);
    const intentRows = sameDay.filter((r) => r.intentId === position.intentId && r.positionId === null);
    const events = [...intentRows, ...own].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    return { position, events, summary };
  }

  @Get('status')
  async status(@CurrentUser('userId') userId: string) {
    const [rows, mismatches] = await Promise.all([this.positions.listForUser(userId, istDayStart(new Date())), this.desk.unacked(userId)]);
    const active = rows.filter((p) => isActiveStatus(p.status));
    return {
      entries: this.intake.status(),
      journal: this.journalStatus.status(),
      positions: { active: active.length, blind: active.filter((p) => p.blindSince !== null).length, exiting: active.filter((p) => p.status === 'EXITING').length },
      mismatches,
    };
  }

  @Post('recon/:id/ack')
  @HttpCode(HttpStatus.OK)
  ack(@CurrentUser('userId') userId: string, @Param('id') id: string, @Body() dto: AckReconDto): Promise<{ acknowledged: string }> {
    return this.desk.ack(userId, id, dto.reason.trim());
  }

  @Get('comparison')
  @AdminOnly()
  comparison(@CurrentUser('userId') userId: string, @Query() q: JournalDayQueryDto): Promise<ComparisonRow[]> {
    return this.comparisonReader.forDay(userId, q.day ?? istDate(new Date()));
  }
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `cd apps/api && npx jest src/modules/trade-core/journal`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -- apps/api/src/modules/trade-core/journal/daily-summary.ts apps/api/src/modules/trade-core/journal/daily-summary.spec.ts apps/api/src/modules/trade-core/journal/silo-comparison.reader.ts apps/api/src/modules/trade-core/journal/silo-comparison.reader.spec.ts apps/api/src/modules/trade-core/journal/dto/core-journal.dto.ts apps/api/src/modules/trade-core/journal/controllers/core-journal.controller.ts apps/api/src/modules/trade-core/journal/controllers/core-journal.controller.spec.ts
git commit -m "feat(trade-core): M5 journal API — day summary, position timeline, status, recon ack, silo comparison" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/api/src/modules/trade-core/journal/daily-summary.ts apps/api/src/modules/trade-core/journal/daily-summary.spec.ts apps/api/src/modules/trade-core/journal/silo-comparison.reader.ts apps/api/src/modules/trade-core/journal/silo-comparison.reader.spec.ts apps/api/src/modules/trade-core/journal/dto/core-journal.dto.ts apps/api/src/modules/trade-core/journal/controllers/core-journal.controller.ts apps/api/src/modules/trade-core/journal/controllers/core-journal.controller.spec.ts
```

---

### Task 18: The Core Journal page (web)

**Files:**
- Create: `apps/web/src/services/coreJournal.ts`
- Test: `apps/web/src/services/coreJournal.spec.ts`
- Create: `apps/web/src/pages/core-journal/core-journal.ts`
- Test: `apps/web/src/pages/core-journal/core-journal.spec.ts`
- Create: `apps/web/src/pages/core-journal/CoreJournalPage.tsx`
- Modify: `apps/web/src/App.tsx` (import + one `<Route>` beside `core-risk`)
- Modify: `apps/web/src/components/layout/navItems.ts` (one item after Core Risk; `ScrollText` icon import)

**Interfaces:**
- Consumes: the Task 17 routes and wire shapes; `api` (`apps/web/src/services/api.ts`), `apiErrorMessage`
  (`pages/core-strategies/core-strategy-picker.ts`), `CARD`, `BUTTON`, `FIELD`, `LABEL`, `QUIET`, `TONE`
  (`pages/core-risk/core-risk-styles.ts`), `LoadingSkeleton`, `useAuthStore`.
- Produces: `getCoreJournalDay(day?)`, `getCorePositionTimeline(id)`, `getCoreJournalStatus()`, `ackReconFinding(id, reason)`,
  `getCoreComparison(day?)`; page helpers `istTime`, `rupees`, `pnlTone`, `eventLine`, `statusBanner`, `skipRows`, `ackPayload`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/web/src/services/coreJournal.spec.ts
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('./api', () => ({ default: { get: vi.fn(), post: vi.fn() } }));

import api from './api';
import { ackReconFinding, getCoreComparison, getCoreJournalDay, getCoreJournalStatus, getCorePositionTimeline } from './coreJournal';

describe('coreJournal wire client', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reads the day (optionally a given day), a position timeline (encoded id), the status and the comparison', async () => {
    (api.get as Mock).mockResolvedValue({ data: { ok: true } });
    await getCoreJournalDay();
    expect(api.get).toHaveBeenLastCalledWith('/trade-core/journal/day', { params: {} });
    await getCoreJournalDay('2026-10-13');
    expect(api.get).toHaveBeenLastCalledWith('/trade-core/journal/day', { params: { day: '2026-10-13' } });
    await getCorePositionTimeline('pos/1');
    expect(api.get).toHaveBeenLastCalledWith('/trade-core/journal/positions/pos%2F1');
    await getCoreJournalStatus();
    expect(api.get).toHaveBeenLastCalledWith('/trade-core/journal/status');
    await getCoreComparison('2026-10-13');
    expect(api.get).toHaveBeenLastCalledWith('/trade-core/journal/comparison', { params: { day: '2026-10-13' } });
  });

  it('acknowledges a finding with its reason', async () => {
    (api.post as Mock).mockResolvedValueOnce({ data: { acknowledged: 'jr_9' } });
    expect(await ackReconFinding('jr_9', 'checked')).toEqual({ acknowledged: 'jr_9' });
    expect(api.post).toHaveBeenCalledWith('/trade-core/journal/recon/jr_9/ack', { reason: 'checked' });
  });
});
```

```ts
// apps/web/src/pages/core-journal/core-journal.spec.ts
import { describe, expect, it } from 'vitest';
import type { CoreJournalRowView, CoreJournalStatusView } from '@/services/coreJournal';
import { ackPayload, eventLine, istTime, pnlTone, rupees, skipRows, statusBanner } from './core-journal';

const row = (type: string, payload: Record<string, unknown>, over: Partial<CoreJournalRowView> = {}): CoreJournalRowView => ({
  id: 'jr', type, positionId: null, strategyId: null, intentId: null, symbol: 'RELIANCE-EQ', payload, priceUsed: null, priceAgeMs: null, createdAt: '2026-10-13T05:00:05.000Z', ...over,
});

const status = (over: Partial<CoreJournalStatusView> = {}): CoreJournalStatusView => ({
  entries: { mode: 'paper', users: 1, pending: 0, dropped: 0 },
  journal: { pending: 0, written: 5, dropped: 0, failures: 0, lastError: null },
  positions: { active: 1, blind: 0, exiting: 0 },
  mismatches: [],
  ...over,
});

describe('Core Journal page logic', () => {
  it('formats IST time, rupees and the P&L tone', () => {
    expect(istTime('2026-10-13T05:00:05.000Z')).toBe('10:30:05');
    expect(rupees('1207.5')).toBe('₹1,207.50');
    expect(rupees(null)).toBe('—');
    expect(pnlTone('12.00')).toBe('ok');
    expect(pnlTone('-0.01')).toBe('danger');
    expect(pnlTone('0.00')).toBe('muted');
  });

  it('words each journal event for the timeline', () => {
    expect(eventLine(row('POSITION_STATE', { from: 'OPEN', to: 'EXITING' })).title).toBe('OPEN → EXITING');
    expect(eventLine(row('EXIT_DECIDED', { reason: 'TRAIL', detail: 'stop 504.95 crossed' })).title).toBe('Exit: TRAIL');
    expect(eventLine(row('FILL', { qty: 100, price: '500.0000' })).title).toBe('Fill 100 @ 500.0000');
    expect(eventLine(row('RISK_VERDICT', { verdict: 'RESIZE', qty: 133, reasons: [{ code: 'CAP_RISK_PER_TRADE' }] })).detail).toBe('CAP_RISK_PER_TRADE');
    expect(eventLine(row('INTENT_SKIPPED', { reason: 'GATE', detail: 'not at support' }))).toMatchObject({ title: 'Skipped: GATE', detail: 'not at support' });
    expect(eventLine(row('BLIND', { blind: true, noPriceForMs: 31000 })).title).toBe('No fresh price (blind)');
    expect(eventLine(row('UNKNOWN_TYPE', {})).title).toBe('UNKNOWN_TYPE');
  });

  it('the status banner is danger on findings or drops, warn on blind positions or a dry run, else ok', () => {
    expect(statusBanner(status()).tone).toBe('ok');
    expect(statusBanner(status({ entries: { mode: 'journal', users: 1, pending: 0, dropped: 0 } })).tone).toBe('warn');
    expect(statusBanner(status({ positions: { active: 2, blind: 1, exiting: 0 } })).tone).toBe('warn');
    expect(statusBanner(status({ journal: { pending: 3, written: 5, dropped: 2, failures: 1, lastError: 'db down' } })).tone).toBe('danger');
    expect(statusBanner(status({ mismatches: [row('RECON_MISMATCH', { check: 'STUCK_ORDER' })] })).lines).toContain('1 reconciliation finding(s) block entries until acknowledged');
  });

  it('skip reasons sorted by count with labels; an ack needs a reason', () => {
    expect(skipRows({ GATE: 2, MIN_SCORE: 5, NEW_REASON: 1 })).toEqual([
      { reason: 'MIN_SCORE', count: 5, label: 'Score below the strategy minimum' },
      { reason: 'GATE', count: 2, label: 'Decision gate said no' },
      { reason: 'NEW_REASON', count: 1, label: 'NEW_REASON' },
    ]);
    expect(ackPayload('  ')).toEqual({ ok: false, error: 'Say why you are acknowledging it' });
    expect(ackPayload(' checked ')).toEqual({ ok: true, value: { reason: 'checked' } });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/web && npx vitest run src/services/coreJournal.spec.ts src/pages/core-journal`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

```ts
// apps/web/src/services/coreJournal.ts
import api from './api';

/**
 * SP2 M5: the caller's core journal. Mirrors the wire shapes of
 * apps/api/src/modules/trade-core/journal/controllers/core-journal.controller.ts (the API does not import @td/shared).
 */
export interface CoreTradeSummaryView {
  positionId: string;
  intentId: string;
  strategyId: string;
  vehicle: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  qty: number;
  entryAvgPrice: string;
  exitAvgPrice: string;
  openedAt: string;
  closedAt: string;
  grossPnl: string;
  charges: string;
  mtfInterest: string;
  netPnl: string;
  initialRisk: string | null;
  rMultiple: string | null;
  mfeRupees: string | null;
  maeRupees: string | null;
  holdMinutes: number;
  exitReason: string;
}

export interface CoreJournalRowView {
  id: string;
  type: string;
  positionId: string | null;
  strategyId: string | null;
  intentId: string | null;
  symbol: string | null;
  payload: Record<string, unknown>;
  priceUsed: number | null;
  priceAgeMs: number | null;
  createdAt: string;
}

export interface CoreDailySummaryView {
  trades: number;
  wins: number;
  losses: number;
  winRatePct: string | null;
  grossPnl: string;
  costs: string;
  netPnl: string;
  costsPctOfGross: string | null;
}

export interface CoreJournalDayView {
  day: string;
  summary: CoreDailySummaryView;
  trades: CoreTradeSummaryView[];
  setups: number;
  skips: Record<string, number>;
  latched: boolean;
  notices: CoreJournalRowView[];
}

export interface CorePositionTimelineView {
  position: { id: string; status: string; side: 'BUY' | 'SELL'; instrument: { symbol: string }; exitReason: string | null };
  events: CoreJournalRowView[];
  summary: CoreTradeSummaryView | null;
}

export interface CoreJournalStatusView {
  entries: { mode: 'off' | 'journal' | 'paper'; users: number; pending: number; dropped: number };
  journal: { pending: number; written: number; dropped: number; failures: number; lastError: string | null };
  positions: { active: number; blind: number; exiting: number };
  mismatches: CoreJournalRowView[];
}

export interface CoreComparisonRowView {
  alertId: string;
  symbol: string | null;
  token: string;
  strategyKey: string;
  intentId: string;
  core: { outcome: 'TRADED' | 'OPEN' | 'SKIPPED' | 'PENDING'; reason: string | null; netPnl: string | null; qty: number | null };
  silo: { track: 'adaptive-stop' | 'ungated'; status: string; pnl: number | null; fees: number | null; exitReason: string | null } | null;
}

export async function getCoreJournalDay(day?: string): Promise<CoreJournalDayView> {
  return (await api.get<CoreJournalDayView>('/trade-core/journal/day', { params: day ? { day } : {} })).data;
}

export async function getCorePositionTimeline(id: string): Promise<CorePositionTimelineView> {
  return (await api.get<CorePositionTimelineView>(`/trade-core/journal/positions/${encodeURIComponent(id)}`)).data;
}

export async function getCoreJournalStatus(): Promise<CoreJournalStatusView> {
  return (await api.get<CoreJournalStatusView>('/trade-core/journal/status')).data;
}

export async function ackReconFinding(id: string, reason: string): Promise<{ acknowledged: string }> {
  return (await api.post<{ acknowledged: string }>(`/trade-core/journal/recon/${encodeURIComponent(id)}/ack`, { reason })).data;
}

export async function getCoreComparison(day?: string): Promise<CoreComparisonRowView[]> {
  return (await api.get<CoreComparisonRowView[]>('/trade-core/journal/comparison', { params: day ? { day } : {} })).data;
}
```

```ts
// apps/web/src/pages/core-journal/core-journal.ts
import type { CoreJournalRowView, CoreJournalStatusView } from '@/services/coreJournal';

/** Pure logic for the Core Journal page (spec §8.4). The server decides; these only word and format. */
export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

export function istTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false });
}

export function rupees(s: string | null): string {
  if (s === null) return '—';
  return `₹${Number(s).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function pnlTone(s: string | null): 'ok' | 'danger' | 'muted' {
  const n = s === null ? 0 : Number(s);
  return n > 0 ? 'ok' : n < 0 ? 'danger' : 'muted';
}

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

export function eventLine(r: CoreJournalRowView): { time: string; title: string; detail: string } {
  const p = r.payload;
  const time = istTime(r.createdAt);
  switch (r.type) {
    case 'ALERT_RECEIVED':
      return { time, title: `Alert: ${str(p.scanName) || 'Chartink'}`, detail: `score ${str(p.score)} at ₹${str(p.alertPrice)}` };
    case 'INTENT_SKIPPED':
      return { time, title: `Skipped: ${str(p.reason)}`, detail: str(p.detail) };
    case 'RISK_VERDICT': {
      const reasons = Array.isArray(p.reasons) ? (p.reasons as Array<{ code?: unknown }>).map((x) => str(x.code)).join(', ') : '';
      return { time, title: `Risk Wall: ${str(p.verdict)} ${str(p.qty)}`, detail: reasons };
    }
    case 'ORDER_PLACED':
      return { time, title: `${str(p.purpose)} order: ${str(p.side)} ${str(p.qty)}`, detail: str(p.orderId) };
    case 'ORDER_STATE':
      return { time, title: `Order ${str(p.state)}`, detail: `${str(p.filledQty)} filled${p.rejectReason ? ` — ${str(p.rejectReason)}` : ''}` };
    case 'FILL':
      return { time, title: `Fill ${str(p.qty)} @ ${str(p.price)}`, detail: `charges ₹${str(p.charges)}` };
    case 'POSITION_STATE':
      return { time, title: `${str(p.from) || 'NEW'} → ${str(p.to)}`, detail: str(p.reason ?? p.exitReason) };
    case 'EXIT_DECIDED':
      return { time, title: `Exit: ${str(p.reason)}`, detail: str(p.detail) };
    case 'STOP_MOVED':
      return { time, title: `Stop ${str(p.from)} → ${str(p.to ?? p.proposed)}`, detail: str(p.why ?? p.source) };
    case 'BLIND':
      return { time, title: p.blind ? 'No fresh price (blind)' : 'Priced again', detail: p.noPriceForMs ? `${Math.round(Number(p.noPriceForMs) / 1000)} s without a price` : '' };
    case 'RECOVERY_STOP':
      return { time, title: 'Stop crossed while the server was down', detail: str(p.detail) };
    default:
      return { time, title: r.type, detail: '' };
  }
}

export function statusBanner(s: CoreJournalStatusView): { tone: 'ok' | 'warn' | 'danger'; lines: string[] } {
  const lines: string[] = [];
  let tone: 'ok' | 'warn' | 'danger' = 'ok';
  const worse = (t: 'warn' | 'danger') => {
    if (t === 'danger' || tone === 'ok') tone = t;
  };
  if (s.mismatches.length > 0) {
    worse('danger');
    lines.push(`${s.mismatches.length} reconciliation finding(s) block entries until acknowledged`);
  }
  if (s.journal.dropped > 0 || s.entries.dropped > 0) {
    worse('danger');
    lines.push(`dropped: ${s.journal.dropped} journal row(s), ${s.entries.dropped} Chartink hit(s)`);
  }
  if (s.journal.pending > 0) {
    worse('warn');
    lines.push(`${s.journal.pending} journal row(s) waiting to be written${s.journal.lastError ? ` (${s.journal.lastError})` : ''}`);
  }
  if (s.positions.blind > 0) {
    worse('warn');
    lines.push(`${s.positions.blind} open position(s) without a fresh price`);
  }
  if (s.entries.mode !== 'paper') {
    worse('warn');
    lines.push(s.entries.mode === 'journal' ? 'Entries are a dry run (journal only, no orders)' : 'Core entries are off');
  }
  if (lines.length === 0) lines.push(`Paper entries on; ${s.positions.active} active position(s)`);
  return { tone, lines };
}

const SKIP_LABELS: Record<string, string> = {
  MIN_SCORE: 'Score below the strategy minimum',
  COOLDOWN: 'Cooldown after the last entry',
  LAST_LOSS: "Today's last trade on it lost",
  HISTORY_UNKNOWN: 'Last trade not summarised yet',
  NO_PRICE_SOURCE: 'No price source for this user',
  NO_FRESH_PRICE: 'No fresh price in time',
  STALE_ENTRY: 'Price already ran past the alert',
  GATE: 'Decision gate said no',
  GATE_UNKNOWN: 'Unknown gate',
  PAPER_SETTINGS_MISSING: 'Paper settings missing',
  SIZE_ZERO: 'Sizing gives no unit',
  VEHICLE_UNSUPPORTED: 'Vehicle not supported yet',
  RISK_REJECT: 'Risk Wall rejected',
  OPEN_REFUSED: 'Position could not open',
  ENTRIES_DRY_RUN: 'Dry run (journal mode)',
  INTERNAL_ERROR: 'Internal error',
};

export function skipRows(skips: Record<string, number>): Array<{ reason: string; count: number; label: string }> {
  return Object.entries(skips)
    .map(([reason, count]) => ({ reason, count, label: SKIP_LABELS[reason] ?? reason }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

export function ackPayload(reason: string): Parsed<{ reason: string }> {
  const r = reason.trim();
  return r ? { ok: true, value: { reason: r } } : { ok: false, error: 'Say why you are acknowledging it' };
}
```

```tsx
// apps/web/src/pages/core-journal/CoreJournalPage.tsx
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { ScrollText } from 'lucide-react';
import { LoadingSkeleton } from '@/components/common';
import {
  ackReconFinding,
  getCoreComparison,
  getCoreJournalDay,
  getCoreJournalStatus,
  getCorePositionTimeline,
} from '@/services/coreJournal';
import { apiErrorMessage } from '@/pages/core-strategies/core-strategy-picker';
import { BUTTON, CARD, FIELD, LABEL, QUIET, TONE } from '@/pages/core-risk/core-risk-styles';
import { useAuthStore } from '@/stores/auth-store';
import { ackPayload, eventLine, istTime, pnlTone, rupees, skipRows, statusBanner } from './core-journal';

const todayIst = (): string => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

/**
 * SP2 Core Journal (spec §8.4): status (entries mode, journal health, blind and exiting positions,
 * reconciliation findings with their acknowledgement), the day's summary and closed trades, a
 * per-position timeline, skip reasons, and — for the owner — the core-vs-silo comparison.
 */
export default function CoreJournalPage() {
  const qc = useQueryClient();
  const isOwner = useAuthStore((s) => s.user?.role) === 'ADMIN';
  const [day, setDay] = useState(todayIst());
  const [positionId, setPositionId] = useState<string | null>(null);
  const [ackFor, setAckFor] = useState<string | null>(null);
  const [ackReason, setAckReason] = useState('');

  const statusQ = useQuery({ queryKey: ['trade-core', 'journal', 'status'], queryFn: getCoreJournalStatus, refetchInterval: 15_000 });
  const dayQ = useQuery({ queryKey: ['trade-core', 'journal', 'day', day], queryFn: () => getCoreJournalDay(day) });
  const timelineQ = useQuery({ queryKey: ['trade-core', 'journal', 'position', positionId], queryFn: () => getCorePositionTimeline(positionId as string), enabled: positionId !== null });
  const comparisonQ = useQuery({ queryKey: ['trade-core', 'journal', 'comparison', day], queryFn: () => getCoreComparison(day), enabled: isOwner });

  const ack = useMutation({
    mutationFn: (a: { id: string; reason: string }) => ackReconFinding(a.id, a.reason),
    onSuccess: () => {
      toast.success('Acknowledged — entries for it are unblocked');
      setAckFor(null);
      setAckReason('');
      void qc.invalidateQueries({ queryKey: ['trade-core', 'journal'] });
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not acknowledge')),
  });

  if (statusQ.isLoading || dayQ.isLoading) return <LoadingSkeleton />;
  const status = statusQ.data;
  const d = dayQ.data;
  const banner = status ? statusBanner(status) : null;

  return (
    <div className="space-y-4 p-4">
      <header className="flex flex-wrap items-center gap-2">
        <ScrollText size={18} className="text-[var(--color-accent-blue)]" />
        <h1 className="text-lg font-semibold text-[var(--color-text-primary)]">Core Journal</h1>
        <span className="rounded bg-[var(--color-bg-tertiary)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Paper only</span>
        <label className={`${LABEL} ml-auto`}>
          Day
          <input type="date" className={FIELD} value={day} onChange={(e) => setDay(e.target.value)} />
        </label>
      </header>

      {banner && status && (
        <section className={`${CARD} border-2 ${banner.tone === 'danger' ? 'border-[var(--color-accent-red)]' : ''}`}>
          {banner.lines.map((l) => (
            <p key={l} className={`text-sm ${TONE[banner.tone === 'ok' ? 'ok' : banner.tone === 'warn' ? 'warn' : 'danger']}`}>{l}</p>
          ))}
          {status.mismatches.map((m) => (
            <div key={m.id} className="space-y-1 border-t border-[var(--color-border-default)] pt-2 text-xs">
              <p className="text-[var(--color-text-secondary)]">
                {istTime(m.createdAt)} · {String(m.payload.check)} · {String(m.payload.detail)}
              </p>
              {ackFor === m.id ? (
                <div className="flex flex-wrap gap-2">
                  <input className={FIELD} placeholder="Why is it safe to resume?" value={ackReason} onChange={(e) => setAckReason(e.target.value)} />
                  <button
                    type="button"
                    className={BUTTON}
                    disabled={ack.isPending}
                    onClick={() => {
                      const p = ackPayload(ackReason);
                      if (!p.ok) return toast.error(p.error);
                      ack.mutate({ id: m.id, reason: p.value.reason });
                    }}
                  >
                    Acknowledge
                  </button>
                  <button type="button" className={QUIET} onClick={() => setAckFor(null)}>Cancel</button>
                </div>
              ) : (
                <button type="button" className={QUIET} onClick={() => setAckFor(m.id)}>Acknowledge…</button>
              )}
            </div>
          ))}
        </section>
      )}

      {d && (
        <section className={CARD}>
          <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">
            {d.day}{d.latched ? ' · daily loss reached: entries blocked for the day' : ''}
          </h2>
          <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-5">
            <div>Net <span className={TONE[pnlTone(d.summary.netPnl)]}>{rupees(d.summary.netPnl)}</span></div>
            <div>Trades {d.summary.trades} ({d.summary.wins}W / {d.summary.losses}L)</div>
            <div>Win rate {d.summary.winRatePct ?? '—'}%</div>
            <div>Costs {rupees(d.summary.costs)} ({d.summary.costsPctOfGross ?? '—'}% of gross)</div>
            <div>Setups {d.setups}</div>
          </div>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-[var(--color-text-muted)]">
                <th>Closed</th><th>Symbol</th><th>Qty</th><th>Entry</th><th>Exit</th><th>Net</th><th>R</th><th>Exit reason</th>
              </tr>
            </thead>
            <tbody>
              {d.trades.map((t) => (
                <tr key={t.positionId} className="cursor-pointer hover:bg-[var(--color-bg-secondary)]" onClick={() => setPositionId(t.positionId)}>
                  <td>{istTime(t.closedAt)}</td><td>{t.symbol}</td><td>{t.qty}</td><td>{t.entryAvgPrice}</td><td>{t.exitAvgPrice}</td>
                  <td className={TONE[pnlTone(t.netPnl)]}>{rupees(t.netPnl)}</td><td>{t.rMultiple ?? '—'}</td><td>{t.exitReason}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {skipRows(d.skips).length > 0 && (
            <div className="text-xs text-[var(--color-text-secondary)]">
              Skipped: {skipRows(d.skips).map((s) => `${s.label} ${s.count}`).join(' · ')}
            </div>
          )}
        </section>
      )}

      {positionId && timelineQ.data && (
        <section className={CARD}>
          <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">
            {timelineQ.data.position.instrument.symbol} · {timelineQ.data.position.status}
            <button type="button" className={`${QUIET} ml-2`} onClick={() => setPositionId(null)}>Close</button>
          </h2>
          <ol className="space-y-1 text-xs">
            {timelineQ.data.events.map((e) => {
              const l = eventLine(e);
              return (
                <li key={e.id}>
                  <span className="text-[var(--color-text-muted)]">{l.time}</span> <span className="font-medium">{l.title}</span>
                  {l.detail && <span className="text-[var(--color-text-secondary)]"> — {l.detail}</span>}
                </li>
              );
            })}
          </ol>
        </section>
      )}

      {isOwner && comparisonQ.data && comparisonQ.data.length > 0 && (
        <section className={CARD}>
          <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">Core vs silo (same Chartink alert)</h2>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-[var(--color-text-muted)]"><th>Symbol</th><th>Strategy</th><th>Core</th><th>Core net</th><th>Silo</th><th>Silo P&amp;L</th></tr>
            </thead>
            <tbody>
              {comparisonQ.data.map((r) => (
                <tr key={r.intentId}>
                  <td>{r.symbol ?? r.token}</td><td>{r.strategyKey}</td>
                  <td>{r.core.outcome}{r.core.reason ? ` (${r.core.reason})` : ''}</td>
                  <td className={TONE[pnlTone(r.core.netPnl)]}>{rupees(r.core.netPnl)}</td>
                  <td>{r.silo ? `${r.silo.status}${r.silo.exitReason ? ` (${r.silo.exitReason})` : ''}` : '—'}</td>
                  <td>{r.silo?.pnl === null || r.silo?.pnl === undefined ? '—' : rupees(String(r.silo.pnl))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
```

`apps/web/src/App.tsx` — beside the Core Risk import and route:

```tsx
import CoreJournalPage from '@/pages/core-journal/CoreJournalPage';
```

```tsx
        <Route path="core-journal" element={<RequireRole role="ADMIN"><CoreJournalPage /></RequireRole>} />
```

`apps/web/src/components/layout/navItems.ts` — add `ScrollText` to the `lucide-react` import and, after the Core Risk item:

```ts
  { path: '/core-journal', label: 'Core Journal', icon: ScrollText, badge: 'SP2' },
```

- [ ] **Step 4: Run the web tests, typecheck and build**

Run: `cd apps/web && npx vitest run src/services/coreJournal.spec.ts src/pages/core-journal && npx tsc --noEmit -p tsconfig.json && npx vite build`
Expected: PASS; no new type errors (compare with the base's error list if the base has any); the build succeeds. (No
browser screenshots: the owner checks the page himself.)

- [ ] **Step 5: Commit**

```bash
git add -- apps/web/src/services/coreJournal.ts apps/web/src/services/coreJournal.spec.ts apps/web/src/pages/core-journal/core-journal.ts apps/web/src/pages/core-journal/core-journal.spec.ts apps/web/src/pages/core-journal/CoreJournalPage.tsx
git commit -m "feat(web): SP2 Core Journal page — status, day summary, timeline, recon ack, core-vs-silo" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/web/src/services/coreJournal.ts apps/web/src/services/coreJournal.spec.ts apps/web/src/pages/core-journal/core-journal.ts apps/web/src/pages/core-journal/core-journal.spec.ts apps/web/src/pages/core-journal/CoreJournalPage.tsx apps/web/src/App.tsx apps/web/src/components/layout/navItems.ts
```

---

## Stream G — wiring and proof

### Task 19: Module wiring, the rebound sinks, `EXPECTED_JOBS`

**Files:**
- Modify: `apps/api/src/modules/trade-core/trade-core.module.ts`
- Modify: `apps/api/src/modules/trade-core/trade-core.module.spec.ts`
- Modify: `apps/api/src/modules/health/health-detail.service.ts` (`EXPECTED_JOBS`)
- Test: `apps/api/src/modules/health/expected-jobs.spec.ts` (new)

**Interfaces:**
- Consumes: every M5 class and token above.
- Produces: the running M5 graph. `LIFECYCLE_EVENT_SINK` → `JournalLifecycleSink`; `RISK_VERDICT_SINK` → `JournalRiskVerdictSink`;
  `CORE_JOURNAL` and `CORE_JOURNAL_STATUS` → `CoreJournalService`; `CORE_CORPUS` → `CoreCorpusWriter`;
  `CORE_POSITION_CLOSED` and `CORE_TRADE_HISTORY` → `CoreTradeSummaryService`; `JOURNAL_RISK_READS` → `JournalRiskReads`;
  `CORE_RECON_DESK` → `CoreReconciler`; `CORE_INTAKE_STATUS` → `CoreEntryIntake`; `CORE_ENTRY_CONFIG` → `readEntryConfig(process.env)`.

- [ ] **Step 1: Write the failing tests**

In `trade-core.module.spec.ts`: change the two M2/M4 sink assertions and add an M5 test (new imports from the M5 files):

```ts
    // was: expect(mod.get(RISK_VERDICT_SINK)).toBeInstanceOf(LoggingRiskVerdictSink);
    expect(mod.get(RISK_VERDICT_SINK)).toBeInstanceOf(JournalRiskVerdictSink);
```

```ts
    // was: expect(mod.get(LIFECYCLE_EVENT_SINK)).toBeInstanceOf(LoggingLifecycleEventSink);
    expect(mod.get(LIFECYCLE_EVENT_SINK)).toBeInstanceOf(JournalLifecycleSink);
```

```ts
  it('resolves the M5 journal, outcomes, reconciliation and intake, one instance behind each port', async () => {
    const mod = await compile();
    const journal = mod.get(CoreJournalService);
    expect(mod.get(CORE_JOURNAL)).toBe(journal);
    expect(mod.get(CORE_JOURNAL_STATUS)).toBe(journal);
    const summaries = mod.get(CoreTradeSummaryService);
    expect(mod.get(CORE_POSITION_CLOSED)).toBe(summaries);
    expect(mod.get(CORE_TRADE_HISTORY)).toBe(summaries);
    expect(mod.get(CORE_CORPUS)).toBe(mod.get(CoreCorpusWriter));
    expect(mod.get(JOURNAL_RISK_READS)).toBe(mod.get(JournalRiskReads));
    expect(mod.get(CORE_RECON_DESK)).toBe(mod.get(CoreReconciler));
    expect(mod.get(CORE_INTAKE_STATUS)).toBe(mod.get(CoreEntryIntake));
    expect(mod.get(CORE_ENTRY_CONFIG)).toEqual({ mode: 'off', userIds: new Set() }); // the test env sets neither variable
    for (const cls of [OrderJournaler, SkipFollowupCron, SiloComparisonReader, EntryMarket, CoreCandles, CoreJournalRepository, CoreTradeSummaryRepository]) {
      expect(mod.get(cls)).toBeInstanceOf(cls);
    }
    expect(Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, TradeCoreModule)).toContain(CoreJournalController);
    expect((mod.get(RISK_STATE_PROVIDER) as unknown as { reads: unknown }).reads).toBe(mod.get(JournalRiskReads));
  });
```

```ts
// apps/api/src/modules/health/expected-jobs.spec.ts
import { MTF_INTEREST_JOB } from '../trade-core/execution/mtf-interest.cron';
import { CORE_RECON_JOB } from '../trade-core/journal/core-reconciler.service';
import { CORE_SKIP_FOLLOWUP_JOB } from '../trade-core/journal/skip-followup.cron';
import { EXPECTED_JOBS } from './health-detail.service';

describe('EXPECTED_JOBS (M3 note, M5 D11)', () => {
  it('lists the three trade-core jobs, so a job that never ran shows as stale on /healthz/detail', () => {
    expect(EXPECTED_JOBS).toEqual(expect.arrayContaining([MTF_INTEREST_JOB, CORE_RECON_JOB, CORE_SKIP_FOLLOWUP_JOB]));
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/api && npx jest src/modules/trade-core/trade-core.module.spec.ts src/modules/health/expected-jobs.spec.ts`
Expected: FAIL — the sinks are still the logging ones; M5 providers are unknown; the jobs are missing.

- [ ] **Step 3: Wire**

`trade-core.module.ts` — imports for every M5 class and token; then:

```ts
  controllers: [CoreStrategiesController, CoreRiskController, CoreRiskDefaultsController, CorePaperDefaultsController, CorePositionsController, CoreJournalController],
```

In `providers`, replace the two sink bindings:

```ts
    { provide: LIFECYCLE_EVENT_SINK, useClass: JournalLifecycleSink },
    { provide: RISK_VERDICT_SINK, useClass: JournalRiskVerdictSink },
```

and append:

```ts
    // SP2 M5: the journal (J10), its writers, summaries (J16), the corpus (O9), the latch and recon
    // block reads (J12, J13), reconciliation (J17), follow-ups (J14), the journal API and the intake.
    CoreCandles,
    CoreJournalRepository,
    CoreTradeSummaryRepository,
    CoreJournalService,
    { provide: CORE_JOURNAL, useExisting: CoreJournalService },
    { provide: CORE_JOURNAL_STATUS, useExisting: CoreJournalService },
    OrderJournaler,
    CoreCorpusWriter,
    { provide: CORE_CORPUS, useExisting: CoreCorpusWriter },
    CoreTradeSummaryService,
    { provide: CORE_POSITION_CLOSED, useExisting: CoreTradeSummaryService },
    { provide: CORE_TRADE_HISTORY, useExisting: CoreTradeSummaryService },
    SkipFollowupCron,
    JournalRiskReads,
    { provide: JOURNAL_RISK_READS, useExisting: JournalRiskReads },
    CoreReconciler,
    { provide: CORE_RECON_DESK, useExisting: CoreReconciler },
    SiloComparisonReader,
    EntryMarket,
    { provide: CORE_ENTRY_CONFIG, useFactory: () => readEntryConfig(process.env) },
    CoreEntryIntake,
    { provide: CORE_INTAKE_STATUS, useExisting: CoreEntryIntake },
```

Remove the now-unused `LoggingLifecycleEventSink` / `LoggingRiskVerdictSink` imports from the module (the classes stay in
their files: the M2/M4 specs and any revert use them). Extend the class comment:

```ts
 * M5: `journal/` (core_journal and the sinks that rebind RISK_VERDICT_SINK and LIFECYCLE_EVENT_SINK to it,
 * order/fill rows, closed-trade summaries, the SP3 corpus rows, the daily-loss latch and the
 * reconciliation block read by the Risk Wall, 5-minute and 15:45 IST reconciliation, 16:10 IST
 * skipped-intent follow-ups, the journal API) and `intake/` (Chartink hits → CoreEntryIntent → Risk
 * Wall → openPosition, behind CORE_ENTRIES_MODE=off|journal|paper and CORE_ENTRY_USER_IDS; reached from
 * ChartinkProcessService through the handOffChartinkHit registry, so ChartinkModule imports nothing new).
```

`health-detail.service.ts` — extend `EXPECTED_JOBS`:

```ts
  // SP2 M3/M5 trade-core jobs (plans 2026-10-11-sp2-m3-execution.md, 2026-10-13-sp2-m5-journal-and-entries.md).
  'core-mtf-interest',
  'core-recon-nightly',
  'core-skip-followup',
```

- [ ] **Step 4: Run them to verify they pass, then the whole API suite**

Run: `cd apps/api && npx jest src/modules/trade-core src/modules/health src/modules/chartink src/common`
Expected: PASS. If a DI cycle is reported, the cause is a new `@Inject` that reaches `CORE_EXECUTION_ADAPTER` from a
provider the adapter already depends on — none of the M5 providers is depended on by the adapter, so read the message and
fix the import, never with `forwardRef`.

- [ ] **Step 5: Commit**

```bash
git add -- apps/api/src/modules/health/expected-jobs.spec.ts
git commit -m "feat(trade-core): wire SP2 M5 — journal sinks, summaries, recon, follow-ups, intake; core jobs in EXPECTED_JOBS" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/api/src/modules/trade-core/trade-core.module.ts apps/api/src/modules/trade-core/trade-core.module.spec.ts apps/api/src/modules/health/health-detail.service.ts apps/api/src/modules/health/expected-jobs.spec.ts
```

---

### Task 20: End to end — Chartink alert to a reconciled, summarised paper trade; kill switch, latch, restart, tenants; then whole-suite verification

**Files:**
- Modify: `apps/api/src/modules/trade-core/lifecycle/testing/lifecycle-harness.ts` (one option: `teeSink`)
- Create: `apps/api/src/modules/trade-core/journal/testing/m5-harness.ts`
- Test: `apps/api/src/modules/trade-core/journal/m5-e2e.spec.ts`
- Test: `apps/api/src/modules/trade-core/journal/m5-tenant.spec.ts`
- Modify: `docs/superpowers/plans/2026-10-13-sp2-m5-journal-and-entries.md` (verification ledger)

**Interfaces:**
- Consumes: everything above; M4 `lifecycleHarness`, `VERSIONS`; `fakeHubSource`; `limitsFixture`.
- Produces: `m5Harness(opts)` returning `{ h, store, journal, corpus, summaries, wall, intake, recon, reads, monitor, pump(), hitAt(ltp, over) }`.

- [ ] **Step 1: Add the harness option and the M5 harness**

In `lifecycle-harness.ts`, `HarnessOptions` gains:

```ts
  /** Also hand every lifecycle event to this sink (M5: the journal sink), after the memory sink. */
  teeSink?: LifecycleEventSink;
```

and `make` passes a tee instead of `sink`:

```ts
  const tee: LifecycleEventSink = {
    record: async (e) => {
      await sink.record(e);
      if (opts.teeSink) await opts.teeSink.record(e);
    },
  };
  const make = () => new CoreLifecycleService(serviceRepo, adapter, strategies, defaults, limits, killReader, moduleRef, clock, tee);
```

```ts
// apps/api/src/modules/trade-core/journal/testing/m5-harness.ts
import type { ModuleRef } from '@nestjs/core';
import type { AuditService } from '../../../../common/audit/audit.service';
import type { JobRunnerService } from '../../../../common/job-registry';
import { HUB_PRICE_SOURCE } from '../../../market-hub/hub-prices';
import type { SessionClock } from '../../../market-hub/session-clock';
import { fakeHubSource } from '../../execution/testing/fake-hub';
import { CoreEntryIntake } from '../../intake/core-entry-intake.service';
import type { EntryMode } from '../../intake/entry-config';
import { EntryMarket } from '../../intake/entry-market';
import { adaptiveSeedBlocks, hit } from '../../intake/testing/intake-fixtures';
import type { CoreLifecycleService, CoreOpenRequest } from '../../lifecycle/core-lifecycle.service';
import { CoreRiskStateProvider } from '../../lifecycle/core-risk-state.provider';
import { DailyLossMonitor } from '../../lifecycle/daily-loss.monitor';
import { lifecycleHarness, VERSIONS } from '../../lifecycle/testing/lifecycle-harness';
import { CoreCandles } from '../../market/core-candles';
import type { CoreSquareOffPort } from '../../risk-wall/ports';
import type { LimitInForce } from '../../risk-wall/risk-wall.types';
import type { CoreKillSwitchService } from '../../risk-wall/services/core-kill-switch.service';
import type { CoreRiskLimitService } from '../../risk-wall/services/core-risk-limit.service';
import { RiskWallService } from '../../risk-wall/services/risk-wall.service';
import { limitsFixture } from '../../risk-wall/testing/risk-fixtures';
import { plainBlocks } from '../../strategies/testing/block-fixtures';
import type { CoreStrategySelectionRepository, LiveSelection } from '../../strategies/repositories/core-strategy-selection.repository';
import { CoreJournalService } from '../core-journal.service';
import { CoreReconciler } from '../core-reconciler.service';
import { CoreTradeSummaryService } from '../core-trade-summary.service';
import { JournalRiskReads } from '../journal-risk-reads';
import { JournalLifecycleSink, JournalRiskVerdictSink } from '../journal-sinks';
import { OrderJournaler } from '../order-journaler';
import { MemoryJournalStore } from './memory-journal-store';

// The seeded Adaptive-Stop v1, approved into PAPER (test catalogue only).
VERSIONS.csv_adaptive_stop_v1 = { strategyId: 'cs_adaptive_stop', status: 'PAPER', blocks: adaptiveSeedBlocks() };

export const SEL_UNGATED = (userId = 'user_A'): LiveSelection => ({ userId, strategyId: 'cs_ungated', strategyKey: 'ungated', strategyVersionId: 'csv_ungated_v1', blocks: plainBlocks(), capitalAllocation: '200000.00' });
export const SEL_ADAPTIVE = (userId = 'user_A'): LiveSelection => ({ userId, strategyId: 'cs_adaptive_stop', strategyKey: 'adaptive-stop', strategyVersionId: 'csv_adaptive_stop_v1', blocks: adaptiveSeedBlocks(), capitalAllocation: '200000.00' });

export interface M5Options {
  mode?: EntryMode;
  users?: string[];
  selections?: LiveSelection[];
  /** Users the hub prices (default only user_A, like production). */
  served?: string[];
  limits?: () => LimitInForce[];
}

/**
 * The whole SP2 core in memory: M3 ledger/matcher/adapter + M4 lifecycle (lifecycleHarness) + the real
 * M2 RiskWallService and CoreRiskStateProvider + every M5 part over a MemoryJournalStore. The hub
 * candle store is absent (candles unavailable: the gate fails open as seeded, ATR floors at minPct).
 */
export function m5Harness(o: M5Options = {}) {
  const store = new MemoryJournalStore();
  const journal = new CoreJournalService(store.repo);
  const corpus = { entrySetup: jest.fn().mockResolvedValue(undefined), outcome: jest.fn().mockResolvedValue(undefined) };
  const limits = o.limits ?? (() => limitsFixture());
  let summaries: CoreTradeSummaryService | null = null;
  const closed = { positionClosed: async (u: string, id: string) => void (await summaries?.writeFor(u, id)) };
  const h = lifecycleHarness({ served: o.served ?? ['user_A'], liveLimits: limits, teeSink: new JournalLifecycleSink(journal, closed) });
  summaries = new CoreTradeSummaryService(h.positions.repo, h.ledger, store.summaryRepo, corpus);
  const reads = new JournalRiskReads(store.repo);
  const clock = { isOpen: () => h.session.open } as unknown as SessionClock;
  // h.restart() swaps h.lifecycle; every consumer reaches it through these, as a real restart rebuilds them.
  const lifecycle = { openPosition: (r: CoreOpenRequest, n?: Date) => h.lifecycle.openPosition(r, n) } as unknown as CoreLifecycleService;
  const marks = { mark: (id: string) => h.lifecycle.mark(id) };
  const provider = new CoreRiskStateProvider(h.ledger, h.positions.repo, marks, reads);
  const limitService = { inForce: async () => limits() } as unknown as CoreRiskLimitService;
  const killSwitch = { isActive: async (u: string) => h.killOn.has(u) } as unknown as CoreKillSwitchService;
  const wall = new RiskWallService(limitService, killSwitch, provider, new JournalRiskVerdictSink(journal), clock);
  const hubSource = fakeHubSource(Object.fromEntries((o.served ?? ['user_A']).map((u) => [u, h.hub])));
  const moduleRef = { get: (token: string) => { if (token === HUB_PRICE_SOURCE) return hubSource; throw new Error('no market hub candles in this test'); } } as unknown as ModuleRef;
  const market = new EntryMarket(moduleRef, new CoreCandles(moduleRef));
  Object.assign(market, { sleep: async (ms: number) => { h.advance(ms); } });
  const selections = { listEnabledPaper: async () => o.selections ?? [SEL_UNGATED()] } as unknown as CoreStrategySelectionRepository;
  const intake = new CoreEntryIntake({ mode: o.mode ?? 'paper', userIds: new Set(o.users ?? ['user_A']) }, selections, wall, lifecycle, h.defaults, market, summaries, journal, corpus);
  const orders = new OrderJournaler(h.adapter, h.ledger, journal);
  orders.onModuleInit();
  const jobs = { run: jest.fn((_n: string, _o: unknown, fn: () => Promise<unknown>) => fn()) } as unknown as JobRunnerService;
  const audit = { append: jest.fn().mockResolvedValue({ seq: 1n, hash: 'h' }) } as unknown as AuditService;
  const recon = new CoreReconciler(h.positions.repo, h.ledger, store.summaryRepo, store.repo, journal, summaries, h.adapter, h.defaults, clock, jobs, audit);
  const squareOff = { squareOffAll: jest.fn(async (u: string, cause: 'KILL_SWITCH' | 'DAILY_LOSS', reason: string) => ({ cancelledOrders: 0, exitsRequested: (await h.lifecycle.exitAll(u, cause, reason)).exitsRequested, detail: 'test' })) } as unknown as CoreSquareOffPort;
  const monitor = new DailyLossMonitor(h.positions.repo, provider, limitService, squareOff, audit, journal);

  /** Let every queued write, order update and sink call finish. */
  async function pump(): Promise<void> {
    for (let i = 0; i < 4; i += 1) {
      await h.settle();
      for (let j = 0; j < 5; j += 1) await new Promise((r) => setImmediate(r));
      await journal.flush();
    }
  }

  /** A Chartink hit now, with a fresh hub price for its instrument first (the intake reads the hub). */
  function hitAt(ltp: number, over: Parameters<typeof hit>[0] = {}) {
    const x = hit({ receivedAt: new Date(), ...over });
    h.hub.setFresh({ ref: { exchange: 'NSE', token: x.token, symbol: x.tradingSymbol }, ltp, at: Date.now(), source: 'ws' });
    return x;
  }

  const types = (positionId?: string) => store.rows.filter((r) => !positionId || r.positionId === positionId).map((r) => r.type);

  return { h, store, journal, corpus, summaries, wall, intake, recon, reads, monitor, pump, hitAt, types };
}
```

- [ ] **Step 2: Write the end-to-end specs**

```ts
// apps/api/src/modules/trade-core/journal/m5-e2e.spec.ts
import { NOW } from '../lifecycle/testing/lifecycle-fixtures';
import { limitsFixture } from '../risk-wall/testing/risk-fixtures';
import { m5Harness, SEL_ADAPTIVE } from './testing/m5-harness';

beforeEach(() => jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] }));
afterEach(() => jest.useRealTimers());

describe('SP2 M5 end to end (spec §1 done-when, §10)', () => {
  it('replay: an Ungated Chartink hit → Risk Wall → paper fill → target exit → summary → clean reconciliation, fully journaled', async () => {
    const m = m5Harness();
    const [out] = await m.intake.process(m.hitAt(500));
    expect(out).toMatchObject({ kind: 'OPENED' });
    const positionId = out.kind === 'OPENED' ? out.positionId : '';
    await m.h.price(500); // the entry fills on the first price after it was placed
    await m.h.price(515); // +3 %: target
    await m.h.price(515); // the exit fills
    await m.pump();
    expect(m.h.positions.rows.find((p) => p.id === positionId)).toMatchObject({ status: 'CLOSED', exitReason: 'TARGET' });
    for (const t of ['ALERT_RECEIVED', 'RISK_VERDICT', 'ORDER_PLACED', 'ORDER_STATE', 'FILL', 'POSITION_STATE', 'EXIT_DECIDED'] as const) expect(m.types()).toContain(t);
    const [summary] = m.store.summaries;
    const funds = await m.h.ledger.funds('user_A');
    expect(summary).toMatchObject({ positionId, exitReason: 'TARGET', grossPnl: funds.realisedPnl, charges: funds.charges });
    expect(Number(summary.netPnl)).toBeCloseTo(Number(funds.realisedPnl) - Number(funds.charges), 2);
    expect(m.corpus.entrySetup).toHaveBeenCalledWith(expect.objectContaining({ decision: expect.objectContaining({ taken: true }) }));
    expect(m.corpus.outcome).toHaveBeenCalledWith(summary.intentId, expect.objectContaining({ netPnl: Number(summary.netPnl) }), summary.closedAt);
    expect(await m.recon.reconcileUser('user_A', 'INTRADAY', new Date())).toEqual([]);
    expect(await m.recon.reconcileUser('user_A', 'NIGHTLY', new Date())).toEqual([]);
  });

  it('Adaptive-Stop v1 (the seed): gate fails open without candles, 0.8 % stop, risk sizing; it closes and is summarised', async () => {
    const m = m5Harness({ selections: [SEL_ADAPTIVE()] });
    const [out] = await m.intake.process(m.hitAt(500, { scanName: 'any scan', score: 70 }));
    expect(out).toMatchObject({ kind: 'OPENED' });
    const verdict = m.store.rows.find((r) => r.type === 'RISK_VERDICT');
    expect(verdict?.payload).toMatchObject({ requestedQty: 200 }); // ₹800 ÷ (500 × 0.8 %)
    for (const ltp of [500, 505, 505, 508, 504.9, 504.9]) await m.h.price(ltp);
    if (m.h.positions.rows[0].status !== 'CLOSED') {
      // Whatever the trail did, the 15:15 time exit closes it (deterministic end of the replay).
      m.h.advance(new Date('2026-10-12T15:16:00.000+05:30').getTime() - Date.now());
      await m.h.sweep();
      await m.h.price(504);
      await m.h.price(504);
    }
    await m.pump();
    expect(m.h.positions.rows[0]).toMatchObject({ status: 'CLOSED', highWater: 508 });
    expect(m.store.summaries).toHaveLength(1);
    expect(await m.recon.reconcileUser('user_A', 'INTRADAY', new Date())).toEqual([]);
  });

  it('journal mode: everything up to the verdict, no order, no position', async () => {
    const m = m5Harness({ mode: 'journal' });
    const [out] = await m.intake.process(m.hitAt(500));
    expect(out).toMatchObject({ kind: 'DRY_RUN' });
    expect(m.h.paper.orders).toEqual([]);
    expect(m.h.positions.rows).toEqual([]);
    await m.pump();
    expect(m.types()).toEqual(expect.arrayContaining(['ALERT_RECEIVED', 'RISK_VERDICT', 'INTENT_SKIPPED']));
  });

  it('kill switch on: the next hit is a RISK_REJECT (KILL_SWITCH); exits of the open position still happen', async () => {
    const m = m5Harness();
    const [first] = await m.intake.process(m.hitAt(500));
    await m.h.price(500);
    m.h.killOn.add('user_A');
    const [second] = await m.intake.process(m.hitAt(1500, { alertId: 'alert_2', token: '1594', tradingSymbol: 'INFY-EQ', symbol: 'INFY' }));
    expect(second).toMatchObject({ kind: 'SKIPPED', reason: 'RISK_REJECT' });
    expect(second.kind === 'SKIPPED' && second.detail).toMatch(/KILL_SWITCH/);
    await m.h.lifecycle.exitAll('user_A', 'KILL_SWITCH', 'test');
    await m.h.price(499);
    await m.pump();
    expect(m.h.positions.rows.find((p) => first.kind === 'OPENED' && p.id === first.positionId)).toMatchObject({ status: 'CLOSED', exitReason: 'KILL_SWITCH' });
  });

  it('daily loss: a realised loss over the limit latches the day; the next hit is rejected DAILY_LOSS', async () => {
    const m = m5Harness({ limits: () => limitsFixture({ 'maxDailyLoss@ALL': '100.00' }) });
    await m.intake.process(m.hitAt(500));
    await m.h.price(500);
    await m.h.price(492); // through the 1.5 % stop
    await m.h.price(492);
    await m.pump();
    expect(m.h.positions.rows[0]).toMatchObject({ status: 'CLOSED', exitReason: 'STOP' });
    const [next] = await m.intake.process(m.hitAt(1500, { alertId: 'alert_2', token: '1594', tradingSymbol: 'INFY-EQ', symbol: 'INFY' }));
    expect(next.kind === 'SKIPPED' && next.detail).toMatch(/DAILY_LOSS/);
    await m.pump();
    expect(await m.reads.latched('user_A', '2026-10-12')).toBe(true);
  });

  it('restart mid-trade: the same alert re-processed is a DUPLICATE; the trade closes once and is summarised once', async () => {
    const m = m5Harness();
    const hit = m.hitAt(500);
    await m.intake.process(hit);
    await m.h.price(500);
    m.h.restart();
    await m.h.lifecycle.recover();
    expect((await m.intake.process(hit))[0]).toMatchObject({ kind: 'DUPLICATE' });
    await m.h.price(515);
    await m.h.price(515);
    await m.pump();
    expect(m.h.positions.rows).toHaveLength(1);
    expect(m.h.positions.rows[0].status).toBe('CLOSED');
    expect(m.store.summaries).toHaveLength(1);
  });
});
```

```ts
// apps/api/src/modules/trade-core/journal/m5-tenant.spec.ts
import { NOW } from '../lifecycle/testing/lifecycle-fixtures';
import { m5Harness, SEL_UNGATED } from './testing/m5-harness';

beforeEach(() => jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] }));
afterEach(() => jest.useRealTimers());

describe('SP2 M5 tenants (spec §3 tenant scoping, §10 tenant test)', () => {
  it("user A's hit opens A's position; user B (not priced by the hub) is NO_PRICE_SOURCE; journals and blocks never cross", async () => {
    const m = m5Harness({ users: ['user_A', 'user_B'], selections: [SEL_UNGATED('user_A'), SEL_UNGATED('user_B')] });
    const out = await m.intake.process(m.hitAt(500));
    expect(out).toEqual([expect.objectContaining({ kind: 'OPENED' }), expect.objectContaining({ kind: 'SKIPPED', reason: 'NO_PRICE_SOURCE' })]);
    await m.pump();
    expect(m.store.rows.filter((r) => r.userId === 'user_B').map((r) => r.type)).toEqual(['ALERT_RECEIVED', 'INTENT_SKIPPED']);
    await m.journal.recordNow({ type: 'RECON_MISMATCH', userId: 'user_A', at: new Date(), strategyId: null, payload: { check: 'FILLS_VS_ORDER' } });
    expect(await m.reads.reconBlock('user_A')).toEqual({ all: true, strategyIds: [] });
    expect(await m.reads.reconBlock('user_B')).toEqual({ all: false, strategyIds: [] });
    expect(await m.reads.latched('user_B', '2026-10-12')).toBe(false);
  });

  it('a user outside CORE_ENTRY_USER_IDS gets nothing at all', async () => {
    const m = m5Harness({ users: ['user_A'], selections: [SEL_UNGATED('user_B')] });
    expect(await m.intake.process(m.hitAt(500))).toEqual([]);
    expect(m.store.rows).toEqual([]);
  });
});
```

- [ ] **Step 3: Run them; fix only test wiring, never production rules, if they fail**

Run: `cd apps/api && npx jest src/modules/trade-core/journal/m5-e2e.spec.ts src/modules/trade-core/journal/m5-tenant.spec.ts`
Expected: PASS. A failure here means two tasks disagree on an interface; fix it in the task that owns the interface and
re-run that task's spec too.

- [ ] **Step 4: Whole-suite verification and drift checks**

```bash
cd apps/api && npx jest --ci                                                    # whole API suite
cd apps/api && npx tsc --noEmit -p tsconfig.json 2>&1 | sed -E 's/\([0-9]+,[0-9]+\)//' | sort > /tmp/m5-tsc.txt   # compare with the base's list, not counts
cd apps/web && npx vitest run && npx tsc --noEmit -p tsconfig.json && npx vite build
cd apps/api && DATABASE_URL_TEST=postgresql://postgres:password@127.0.0.1:55434/grw_sp2m5_test npx jest --config test/sp2-m5/jest.config.js -i   # opt-in, throwaway DB with all migrations
git diff --name-only 053da3a...HEAD | grep -v '^apps/api/src/modules/trade-core/' | sort
grep -rn "LIVE_TRADING_ENABLED" apps/api/src/modules/trade-core
grep -rn "@Cron(" apps/api/src/modules/trade-core
grep -rn "openPosition(" apps/api/src --include=*.ts | grep -v "\.spec\.ts" | grep -v "lifecycle/core-lifecycle.service.ts"
grep -rn "handOffChartinkHit(" apps/api/src --include=*.ts | grep -v "\.spec\.ts" | grep -v "intake/alert-handoff.ts"
```

Expected:
- Jest: all suites pass (note the known Windows-only `SentinelCycleService — shadow mode is structural` flake if it appears, as M4 did).
- `tsc`: the sorted error list equals the base's (`053da3a` + P1); none names an M5 file.
- Web: tests, typecheck and build pass.
- Opt-in DB test: passes (or recorded as not run, with the reason, and run before the production gate).
- Files outside `trade-core/`: exactly `apps/api/src/common/audit/audit-actions.ts`, `apps/api/src/common/tenant/tenant.constants.ts`,
  `apps/api/src/modules/chartink/services/chartink-process.service.ts`, `apps/api/src/modules/chartink/services/__tests__/chartink-core-handoff.spec.ts`,
  `apps/api/src/modules/health/health-detail.service.ts`, `apps/api/src/modules/health/expected-jobs.spec.ts`, `apps/api/test/sp2-m5/*`,
  `apps/web/src/App.tsx`, `apps/web/src/components/layout/navItems.ts`, `apps/web/src/pages/core-journal/*`,
  `apps/web/src/services/coreJournal*.ts`, `docs/superpowers/plans/2026-10-13-sp2-m5-journal-and-entries.md`, `prisma/schema.prisma`,
  `prisma/migrations/20261013120000_sp2_m5_journal/migration.sql` (plus P1's files if it was merged into this branch).
- `LIVE_TRADING_ENABLED`: only the pre-existing hit in `risk-wall/silo-entry-recheck.spec.ts`.
- `@Cron(`: three in trade-core — `mtf-interest.cron.ts`, `core-reconciler.service.ts`, `skip-followup.cron.ts` — each with `timeZone: 'Asia/Kolkata'`.
- `openPosition(` call sites: only `intake/core-entry-intake.service.ts`.
- `handOffChartinkHit(` call sites: only `chartink-process.service.ts`.

- [ ] **Step 5: Record the results in the verification ledger and commit**

Add one row to "Verification ledger" below with the date, branch and SHA range, the suite and test counts, the typecheck
comparison, the opt-in DB result, and the drift-check results (any deviation named).

```bash
git add -- apps/api/src/modules/trade-core/journal/testing/m5-harness.ts apps/api/src/modules/trade-core/journal/m5-e2e.spec.ts apps/api/src/modules/trade-core/journal/m5-tenant.spec.ts
git commit -m "test(trade-core): SP2 M5 end to end — Chartink to summarised, reconciled paper trade; kill switch, latch, restart, tenants" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/api/src/modules/trade-core/lifecycle/testing/lifecycle-harness.ts apps/api/src/modules/trade-core/journal/testing/m5-harness.ts apps/api/src/modules/trade-core/journal/m5-e2e.spec.ts apps/api/src/modules/trade-core/journal/m5-tenant.spec.ts
git commit -m "docs(plans): SP2 M5 verification results" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- docs/superpowers/plans/2026-10-13-sp2-m5-journal-and-entries.md
```

---

## M5 production gate — the first paper-trading sessions (owner-run)

Production is the Vyom VPS (Postgres in `grw-postgres`, API in `grw-api`). `grw-deploy.timer` runs `prisma migrate deploy`,
which applies `20261013120000_sp2_m5_journal` (expand-only: two tables). M5 is complete when Gate 2 is observed in
production, not when the tests pass (parent spec rule). Each gate is "has it actually run?", never "is the code there?"
(the silent-absence pattern).

**Gate 0 — deployed dark (`CORE_ENTRIES_MODE` unset = off).**

```bash
docker exec -i grw-postgres psql -U grw -d grw <<'SQL'
SELECT count(*) FROM core_journal;                                    -- small: only KILL_SWITCH / LIMIT_CHANGED rows if the owner changed them
SELECT count(*) FROM core_trade_summaries;                            -- 0
SELECT tgname FROM pg_trigger WHERE tgname LIKE 'core_%append_only' ORDER BY 1;  -- includes core_journal_append_only, core_trade_summaries_append_only
SQL
docker logs grw-api 2>&1 | grep -E 'core entries are off|lifecycle: recovered'
```

`GET /api/trade-core/journal/status` → `entries.mode = "off"`, `journal.dropped = 0`, `mismatches = []`. After 15:45 and 16:10 IST:
`/healthz/detail → jobs` shows `core-mtf-interest`, `core-recon-nightly`, `core-skip-followup` as recent successes (no-ops).

**Gate 1 — one session in `journal` mode (dry run).**

1. Owner decisions O1–O14 answered (or defaults accepted). P1 merged and deployed.
2. On Core Strategies: approve **Adaptive-Stop v1** into PAPER and enable its selection (Ungated too if wanted). On Core Risk:
   review every limit marked "default — please review" (`maxDailyLoss`, `maxOpenPositions`, `maxRiskPerTrade`,
   `maxCapitalDeployed@CASH_INTRADAY`, `lastEntryTime`, `squareOffTime@CASH_INTRADAY`, `dailyLossAction`); kill switch released.
3. Record the hub flags: `HUB_PRICES_POSITIONS` must be `true` (else every intent is `NO_PRICE_SOURCE`); note
   `HUB_CANDLES_ENABLED` / `HUB_SERVES_CHARTS` (off → ATR floors at 0.8 % and the gate fails open: O6/O7).
4. Set `CORE_ENTRIES_MODE=journal` and `CORE_ENTRY_USER_IDS=<owner user id>` in the API env; restart `grw-api`.
   Log shows `core entries: journal mode for 1 user(s)`.
5. During the session (a day Chartink fires):

```sql
SELECT type, count(*) FROM core_journal WHERE "istDay" = CURRENT_DATE GROUP BY 1 ORDER BY 1;
-- ALERT_RECEIVED > 0 (else: the hand-off never ran — stop and investigate), RISK_VERDICT > 0, INTENT_SKIPPED > 0
SELECT payload->>'reason' AS reason, count(*) FROM core_journal WHERE type = 'INTENT_SKIPPED' AND "istDay" = CURRENT_DATE GROUP BY 1 ORDER BY 2 DESC;
SELECT count(*) FROM core_orders WHERE "submittedAt"::date = CURRENT_DATE;   -- 0 (dry run)
```

   Compare `ALERT_RECEIVED` for adaptive-stop with today's `adaptive_stop_watch_entries` (same alerts). `/journal/status`:
   `entries.dropped = 0`, `journal.dropped = 0`. `/healthz/detail → hub.slots` within budget; API RSS within ~20 MB of the day before.
6. After 16:10: `SELECT count(*) FROM core_journal WHERE type = 'PRICE_FOLLOWUP' AND "istDay" = CURRENT_DATE;` > 0 (when hub candles are on).

**Gate 2 — the first paper session (SP2 done-when).**

1. Set `CORE_ENTRIES_MODE=paper`; restart before 09:15 IST. Pre-open: `/journal/status` shows `mode: "paper"`, no mismatches;
   Core Risk shows the kill switch off; `startingCapital@ALL` in `core_paper_defaults` is the intended paper capital (the
   ledger books it as the user's `DEPOSIT` row with the first order: `SELECT * FROM core_cash_ledger WHERE type = 'DEPOSIT';`).
2. During the session, on the Core Journal page and in SQL:

```sql
SELECT status, count(*) FROM core_positions WHERE "createdAt"::date = CURRENT_DATE GROUP BY 1;
SELECT "exitReason", count(*) FROM core_positions WHERE status = 'CLOSED' AND "closedAt"::date = CURRENT_DATE GROUP BY 1;
SELECT p.id FROM core_positions p LEFT JOIN core_trade_summaries s ON s."positionId" = p.id
 WHERE p.status = 'CLOSED' AND p."closedAt"::date = CURRENT_DATE AND s.id IS NULL;            -- empty within 5 min of each close
```

   Every entry has a `RISK_VERDICT` row; every closed position a summary; timelines read alert → verdict → order → fill →
   state changes → exit decided → fill → CLOSED.
3. **Exercise the kill switch** (spec §1) with at least one core position open, at a quiet moment (e.g. 14:30): press it on
   Core Risk with a reason. Expect: the cascade line shows core exits requested; the position goes `EXITING` → `CLOSED`
   with `exitReason = KILL_SWITCH`; later hits are `INTENT_SKIPPED RISK_REJECT` with `KILL_SWITCH`; a `KILL_SWITCH` journal
   row exists; the release is scheduled for the next open.
4. After 15:45 IST: `core-recon-nightly` succeeded and
   `SELECT count(*) FROM core_journal WHERE type = 'RECON_MISMATCH' AND "istDay" = CURRENT_DATE;` is **0** (clean
   reconciliation). Any finding: read it on the page, fix the cause, acknowledge it with a reason.
5. Net P&L check: the page's day net equals
   `SELECT sum("netPnl") FROM core_trade_summaries WHERE "istDay" = CURRENT_DATE;` and the ledger's
   `REALISED_PNL + CHARGES + MTF_INTEREST` for the day.
6. Corpus: `SELECT count(*) FROM ai_decision_records WHERE source = 'core' AND "decidedAt"::date = CURRENT_DATE;` equals the
   day's `ALERT_RECEIVED` count; closed ones have `outcome` set.
7. Comparison view: for each alert both tracks took, the core and silo results sit side by side.

**Revert path:** `CORE_ENTRIES_MODE=off` + restart stops new entries at once (open positions keep being managed, exits are
never behind the switch). A code revert leaves both tables and their rows inert (expand-only); the sinks fall back to the
logging ones in the reverted module.

## Deviations from the spec

1. **`PRICE_FOLLOWUP` rows** instead of filling skipped rows in place (D1, J14); **`RECON_ACK` and `DAILY_LOSS_LATCHED`**
   journal types (D2, J12, J13).
2. **Fan-out at the end of `processOne`, scored hits only**, through a registry (D4, O3, J2).
3. **"Cash ledger balance equals the sum of its entries"** is checked as "no margin left on closed or cancelled positions"
   (D3, J17); spec §8.3's stale-order cancel applies to **entry** orders only (D8).
4. **Reconciliation thresholds** derive from `noPriceRejectMs` (J18), not a new setting.
5. **Options entries and code-evaluator entries are not built** (O4, O5); Chartink is the only entry source in SP2.
6. **`capitalAllocation` is not enforced** (O8).
7. **Trailing `STOP_MOVED` rows are coalesced** to one per 30 s per position (J15).
8. **M5 writes SP3 corpus rows** for core setups (O9) ahead of SP3's DecisionPipeline.
9. **Alerts are journal + log + status endpoint**, no push channel (O11).
10. "No file outside `trade-core/` changes except wiring" is read, as in M2–M4, to include the schema, the migration,
    `tenant.constants.ts`, `audit-actions.ts`, one Chartink call, `EXPECTED_JOBS` and the web page; Task 20 Step 4 lists them.

## Notes for later milestones (not in this plan)

- **SP3 M6 guard rails on core positions (O12):** a sentinel review packet built from `core_positions` + their journal, and
  an executor that turns `EXIT_NOW` / tighten verdicts into `CoreLifecycleService.requestExit(userId, id, 'GUARD_RAIL', note)`
  and `proposeStop(...)` — never the adapter, never widening. The sentinel-executor module stays broker-only.
- **SP3 DecisionPipeline:** writes `ai_decision_records` for its own intents with the same `(source 'core', intentId)`
  key; the M5 writer's first-write-wins upsert and `outcome` merge already fit it. The corpus `features` for core rows are
  empty in M5 (the Chartink scoring breakdown is not passed to the core); pass `scoringResult.checks` through
  `ChartinkHit` when SP3 needs `fs1-legacy-checks` for core rows.
- **Options picker (D10/O4):** resolve strike/expiry from the hub's option chains (`hubFor(…, 'chain')`), then the
  existing `OptionOpen` path in `openPosition`.
- **Telegram alerts (O11):** `RECON_MISMATCH`, `BLIND`, `DAILY_LOSS_LATCHED`, `KILL_SWITCH` rows are the feed.
- **Retention:** `core_journal` grows ~1–3 k rows per paper day; revisit with the interim storage-retention decision.
- **Multi-tenant hub:** when `hubFor` serves other users, their intents stop being `NO_PRICE_SOURCE`; nothing in M5 changes.
- **SP6** retires the silos and the comparison view with them; **SP7** adds broker reconciliation to `CoreReconciler`
  (spec §8.3 last bullet) and a live adapter.
- **Opening the page to users:** add `/core-journal` to `USER_VISIBLE` and drop `RequireRole`; the API is per user except
  the admin-only comparison.

## Self-review

- **Spec coverage (§11 M5 row "Journal, trade summaries, reconciliation, Chartink fan-out, Adaptive-Stop end to end, UI
  pages"):** §8.1 journal table, append-only, every type (Tasks 1, 2, 9, 10, 14, 16; skipped-intent follow-ups Task 13);
  §8.2 summaries with net after charges and interest, R, MFE/MAE, holding time, exit reason (Task 11); §8.3 5-minute and
  nightly reconciliation, mismatch → journal + alert + strategy block until acknowledged (Tasks 15, 16); §3 Chartink
  fan-out after the silo, own try/catch, selected and enabled versions only (Tasks 4–8); §5.1 every verdict journaled with
  its limits snapshot (Task 9); §5.3 latch (Task 14); §5.4 kill-switch rows (Task 10); §8.4 Journal page with timeline,
  daily summary and comparison view (Tasks 17, 18; Risk and Strategy pages exist, D10); §9 failures never reach the silo
  (Task 8), fail closed (Tasks 7, 9), idempotent (J11); §10 replay, restart, tenant and silo-isolation tests (Tasks 8, 20);
  §1 done-when as the production gate. M1–M4 notes: PAPER-only live selections (Task 2), evaluator keys checked and the
  gate wrapped honouring `failOpen` (Task 5), minScore and filters before the wall with `INTENT_SKIPPED` per rule (Task 7),
  `RISK_VERDICT_SINK` and `LIFECYCLE_EVENT_SINK` rebound (Tasks 9, 19), latch from the journal (Task 14), recon block as a
  wall input (Task 16), `EXPECTED_JOBS` (Task 19), day-bounded ledger reads (Task 3), corpus `outcome` (Tasks 11–13),
  lifecycle counts on a status surface (Task 17).
- **Placeholder scan:** every code step carries its code; every test step names its command and expected result. Two
  steps tell the implementer to use an existing name where the base may differ (`toOrder` in `core-order.repository.ts`,
  the `core_orders` column list in the opt-in test) and say exactly what to look up.
- **Type consistency:** `JournalEntry`, `JournalRow`, `JournalType`, `SkipReason`, `TradeSummary`, `NewTradeSummary`,
  `CorpusSetup`, `CorpusOutcome`, `CoreJournalPort`, `PositionClosedListener`, `CoreTradeHistory`, `CoreCorpusPort`,
  `ReconDesk`, `IntakeStatusSource`, `JournalStatusSource`, `LiveSelection`, `ChartinkHit`, `EntryMatch`, `GateOutcome`,
  `PriceRead`, `AtrRead`, `EntryConfig`, `IntakeOutcome`, `ReconFinding`, `ReconSnapshot`, `ReconBlock`, `DailySummary`,
  `ComparisonRow` are named the same in every task; `record(e)`, `recordNow(e)`, `positionClosed(userId, positionId)`,
  `intentSeen(intentId)`, `lastOpenedAt(userId, strategyId, token)`, `lastClosedNetToday(userId, strategyId, token, now)`,
  `entrySetup(s)`, `outcome(intentId, patch, at)`, `listEnabledPaper()`, `freshPrice(userId, ref, owner, waitMs?)`,
  `atr(ref, stop, now)`, `candlesFor(ref, tf, days, now)`, `runGates(gates, ctx)`, `summarizeTrade(input)`,
  `writeFor(userId, positionId)`, `reconcileUser(userId, kind, now)`, `ack(userId, mismatchId, reason)`, `unacked(userId)`,
  `reconBlock(userId)`, `latched(userId, day)`, `fillsFor(userId, orderIds)`, `marginByOrder(userId, orderIds)`,
  `ledgerRowsForPosition(userId, orderIds, token, fromDay, toDay)`, `interestTokensOn(userId, day)` match between
  producers and consumers.
- **Review Focus tests are in their owning tasks:** 1 → Tasks 8 and 7; 2 → Task 7; 3 → Task 9; 4 → Tasks 11 and 16;
  5 → Task 16.

## Verification ledger

| Date | Whole suite (API) | Typecheck (error lists) | Opt-in DB test + drift | Notes |
|---|---|---|---|---|
