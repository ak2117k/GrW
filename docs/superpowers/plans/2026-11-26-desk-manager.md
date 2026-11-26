# Desk Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One AI manager that sees the whole desk, decides entries/exits/tightening/pauses with evidence, acts only through the existing executors, under a code guard the AI cannot override.

**Architecture:** New NestJS module `apps/api/src/modules/desk-manager/`. Task 0 lays down the shared types, tables, config and the pure P&L-path function; Tasks 1–7 are independent workstreams that code against those types and run in parallel (separate worktrees); Task 8 wires everything together and runs the golden end-to-end tests.

**Tech Stack:** NestJS 10, Prisma (Postgres), Jest, React + Vite (web), Claude on Vertex via `directRecordedTransport`.

**Spec:** `docs/superpowers/specs/2026-11-26-desk-manager-design.md` (approved 2026-11-26). Read it before your task.

## Global Constraints

- Repo root `C:\Users\AryanKumar\Desktop\GrW-speed`; API code under `apps/api/src`; schema `prisma/schema.prisma`; migrations `prisma/migrations/<YYYYMMDDHHmm>_<name>/migration.sql`, hand-written, expand-only (new tables / new nullable columns; never alter or drop).
- Run tests from `apps/api`: `npx jest <path>`. Type errors that mention `@td/shared`, `@aws-sdk`, `razorpay` are pre-existing worktree noise; jest (ts-jest) compiling your files is the check.
- `DESK_MANAGER=off|shadow|live`, default `off`. Anything unknown = `off`.
- Owner account only: `HUB_OWNER_USER_ID`. Tables carry `userId`.
- Authority: owner > risk limits > manager > sentinel/workers > executor. Close beats hold; tighten beats loosen; never act on an `AI_AUTO_EXIT_HOLD` position; never loosen a stop.
- Manager entries: 1 lot, BUY only (CE / PE / FUT), max `DESK_MANAGER_MAX_ENTRIES` = 5 per IST day, none in the last 30 min of the venue, none before `SIGNAL_LIVE_FROM_IST` (default 09:45) on NSE/BFO, reward ≥ 1.2 × risk on the underlying.
- Per-trade max loss = class ceiling (`HARD_LOSS_CEILING_BY_CLASS`; defaults INDEX_OPT 5000, STOCK_OPT 3000, GOLD 7500, SILVER 7500, GOLD_MINI 4000, SILVER_MINI 4000, MCX 5000). Estimated loss above it ⇒ OPEN **refused**, never shrunk. The flat ₹2,000 hard-loss exit does not apply to manager-owned trackers.
- Guard defaults: drawdown from day peak ₹5,000, day loss ₹8,000, 3 losers in a row; counts **all** the owner's live trackers (IST day, NSE+MCX); blocks every **automatic live** entry (signal, reentry, manager), never the owner's own orders; paper entries are never blocked.
- AI: job `desk.manager`, agent `trading`, concurrency 1, timeout 120 000 ms, model `claude-opus-5-5`, effort high; ≤ `DESK_MANAGER_MAX_CALLS` = 400 calls per IST day.
- Cadence: every 3 min while a position is open or a proposal is < 30 min old, else every 10 min; events debounce 20 s; single-flight; a run > 150 s is abandoned.
- Nothing is decided on 1m bars; the packet uses 15m / daily / level book / ticks for current price only.
- Every `@Cron` with a fixed hour/day carries `timeZone: 'Asia/Kolkata'` (ratchet `common/schedule/cron-timezone.spec.ts`).
- Every instrument lookup by (exchange, token) goes through `common/instruments/contract-by-token` (ratchet `contract-by-token.ratchet.spec.ts`).
- Commit with explicit pathspecs only (`git commit -- <paths>`). Conventional commits, scope `desk-manager` (or the module touched). End messages with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push.

## Review Focus

1. **Guard counting the owner's manual trades** — a manual loser must count toward the streak and drawdown exactly like a signal loser (Task 1 test `counts a manual tracker`).
2. **AI reply that is malformed, partial, or cites no numbers** — the run records the error and acts on nothing (Task 4 tests `rejects a decision without evidence`, `malformed reply acts on nothing`).
3. **OPEN on an underlying that already has an open or pending position from any source** — refused (Task 5 test `refuses a second entry on the same underlying`).
4. **Venue closed / last 30 min / before live start** — OPEN refused with the reason; EXIT still allowed while the venue is open (Task 5 tests).
5. **Manager silent while a venue is open** — after 15 min with no completed run (idle cadence 10 + 5), an ops alert and manager OPENs blocked (Task 4 test `health blocks opens after silence`).

---

### Task 0: Foundation — types, tables, config, P&L path (done first, by the lead, before the team starts)

**Files:**
- Create: `apps/api/src/modules/desk-manager/domain/desk.types.ts`
- Create: `apps/api/src/modules/desk-manager/domain/pnl-path.ts` + `pnl-path.spec.ts`
- Create: `apps/api/src/modules/desk-manager/desk-manager.config.ts` + `desk-manager.config.spec.ts`
- Create: `apps/api/src/modules/desk-manager/desk-manager.module.ts` (empty providers; wired in Task 8)
- Modify: `prisma/schema.prisma` (5 models below); Create: `prisma/migrations/202611262300_desk_manager/migration.sql`

**Interfaces — Produces** (every other task imports these; names are final):

```ts
// desk.types.ts
export type DeskMode = 'off' | 'shadow' | 'live';
export interface Block<T> { status: 'present' | 'unavailable'; value?: T; reason?: string; source: string }
export interface ClosedTrade { trackerId: string; symbol: string; underlying: string | null; exitAt: Date; pnl: number; origin: TradeOrigin }
export type TradeOrigin = 'manual' | 'signal' | 'reentry' | 'manager' | 'engine' | 'setup' | 'unknown';
export interface DayPnlPath { realised: number; open: number; total: number; peak: number; drawdownFromPeak: number; lossStreak: number; closed: ClosedTrade[] }
export interface GuardState { blocked: boolean; reasons: string[]; path: DayPnlPath; pausedUntil: Date | null; pauseScope: 'all' | string | null }
export interface PositionView { trackerId: string; symbol: string; exchange: string; underlying: string | null; qty: number; entry: number; ltp: number | null; pnl: number | null; ageMin: number; origin: TradeOrigin; held: boolean; sentinel: { verdict: string; thesisStatus: string | null; reason: string; invalidation: number | null; at: string } | null; managerStop: number | null; managerTargets: number[] }
export interface RecentExit { trackerId: string; symbol: string; underlying: string | null; exitAt: string; pnl: number; lastSentinel: { verdict: string; thesisStatus: string | null; reason: string } | null; underlyingAtExit: number | null; underlyingNow: number | null }
export interface Proposal { ref: string; kind: 'reading' | 'setup' | 'signal_decision' | 'engine'; at: string; underlying: string | null; text: string; detail: Record<string, unknown> }
export interface InstrumentView { underlying: string; ltp: number | null; dayOpen: number | null; dayHigh: number | null; dayLow: number | null; vwap: number | null; trend15m: string | null; levels: number[]; chainWalls: { call: number | null; put: number | null } | null; missing: string[] }
export interface HealthView { notCheckableToday: number; notCheckableReasons: Record<string, number>; feed: string; agents: Record<string, string>; failedBlocks: string[] }
export interface MemoryView { today: Array<{ at: string; action: string; underlying: string | null; status: string; result: string | null }>; scorecard: Scorecard | null; lessons: string[] }
export interface Scorecard { sessions: number; opens: number; netPnl: number; winRate: number | null; best: string[]; worst: string[] }
export interface DeskPacket { at: string; mode: DeskMode; day: Block<{ ist: string; nseMinToClose: number | null; mcxMinToClose: number | null; liveFromIst: string }>; pnl: Block<DayPnlPath>; guard: Block<GuardState>; positions: Block<PositionView[]>; recentExits: Block<RecentExit[]>; proposals: Block<Proposal[]>; instruments: Block<Record<string, InstrumentView>>; health: Block<HealthView>; memory: Block<MemoryView> }

type Why = { reason: string; evidence: string[] };
export type ManagerDecision =
  | ({ action: 'OPEN'; underlying: string; side: 'BUY_CE' | 'BUY_PE' | 'BUY_FUT'; strikePolicy: 'ATM' | 'ITM1' | 'OTM1' | number; expiryPolicy: 'NEAREST' | 'NEXT';
       entry: { type: 'NOW' | 'ZONE' | 'BREAKOUT'; low?: number; high?: number; triggerAbove?: number; triggerBelow?: number; validMin: number };
       stop: { underlying: number }; targets: { underlying: number[] }; proposalRef?: string; confidence: 'low' | 'medium' | 'high' } & Why)
  | ({ action: 'EXIT' | 'BOOK'; trackerId: string } & Why)
  | ({ action: 'TIGHTEN'; trackerId: string; underlyingStop: number } & Why)
  | ({ action: 'PAUSE_ENTRIES'; scope: 'all' | string; minutes: number } & Why)
  | ({ action: 'RESUME' } & Why)
  | ({ action: 'WATCH'; underlying: string; note: string; recheckMin: number } & Why)
  | ({ action: 'FLAG_DATA_HOLE'; what: string; impact: string } & Why)
  | ({ action: 'NO_ACTION' } & Why);
export interface ManagerReply { summary: string; decisions: ManagerDecision[] }
export interface ActionResult { status: 'DONE' | 'PENDING' | 'REFUSED' | 'FAILED' | 'RECORDED'; detail: string; ref?: string }
export interface ActionContext { runId: string; decisionId: string; now: Date; packet: DeskPacket; cfg: DeskManagerConfig }
export interface DeskActionsPort { execute(d: ManagerDecision, ctx: ActionContext): Promise<ActionResult> }
export const DESK_ACTIONS = Symbol('DESK_ACTIONS');
export type WakeReason = 'cadence' | 'reading_call' | 'claim_on_open' | 'tracker_opened' | 'tracker_closed' | 'sentinel_exit' | 'sentinel_hold_loss' | 'judge_take_skipped' | 'guard_change' | 'target_crossed' | 'watch_recheck' | 'manual';
```

```ts
// desk-manager.config.ts
export interface DeskManagerConfig { mode: DeskMode; ownerUserId: string | null; model: string; maxEntries: number; maxExits: number; maxCalls: number; busyEveryMin: 3; idleEveryMin: 10; debounceMs: 20000; runTimeoutMs: 150000; noEntryLastMin: 30; minRewardRisk: 1.2;
  guard: { drawdownRupees: number; dayLossRupees: number; lossStreak: number }; ceilings: Record<string, number> }
export const DESK_MANAGER_CONFIG = Symbol('DESK_MANAGER_CONFIG');
export function parseDeskManagerConfig(env: Record<string, string | undefined>): DeskManagerConfig
```
Env: `DESK_MANAGER`, `HUB_OWNER_USER_ID`, `DESK_MANAGER_MODEL` (default `claude-opus-5-5`), `DESK_MANAGER_MAX_ENTRIES` (5, 0–20), `DESK_MANAGER_MAX_EXITS` (20, 0–100), `DESK_MANAGER_MAX_CALLS` (400, 0–2000), `DESK_GUARD_DRAWDOWN_RUPEES` (5000), `DESK_GUARD_DAY_LOSS_RUPEES` (8000), `DESK_GUARD_LOSS_STREAK` (3, 1–20), ceilings from `HARD_LOSS_CEILING_BY_CLASS` with the Global Constraints defaults.

```ts
// pnl-path.ts
export function dayPnlPath(closed: readonly ClosedTrade[], openPnl: number): DayPnlPath
```
Sorts `closed` by `exitAt`; `realised` = sum; `peak` = max(0, every running realised sum, realised + openPnl); `drawdownFromPeak` = peak − total; `lossStreak` = count of trailing consecutive `pnl < 0` (a `pnl === 0` ends the streak).

**Prisma models** (snake_case maps, `@db.Timestamptz(6)` on dates, `createdAt @default(now())`, `updatedAt @updatedAt`):
- `DeskManagerRun` → `desk_manager_runs`: id, userId, startedAt, finishedAt?, wakeReasons Json, mode, packet Json?, packetMs Int?, aiMs Int?, reply Json?, summary String?, error String?; @@index([userId, startedAt]).
- `DeskManagerDecision` → `desk_manager_decisions`: id, runId, userId, action, underlying?, trackerId?, payload Json, validation Json, status (VALID|INVALID|DONE|PENDING|REFUSED|FAILED|RECORDED), result Json?, orderRowId?, tradeId?, execId?, grade Json?; @@index([userId, createdAt]), @@index([action, status]).
- `DeskManagerPendingEntry` → `desk_manager_pending_entries`: id, decisionId @unique, userId, underlying, mode, decision Json, validUntil, status (PENDING|FILLED|EXPIRED|REFUSED|FAILED), result Json?, orderRowId?, tradeId?; @@index([status, validUntil]).
- `DeskGuardEvent` → `desk_guard_events`: id, userId, at, source, blocked Boolean, reasons Json, path Json; @@index([userId, at]).
- `DeskGuardState` → `desk_guard_state`: userId @id, day String, pausedUntil?, pauseScope?, resetAt?.

- [ ] Write `pnl-path.spec.ts`: `peak and drawdown` (closed −1000, +3000, −2500 with open −500 → realised −500, total −1000, peak 2000, drawdownFromPeak 3000, lossStreak 1); `trailing streak` (+500, −100, −200, −300 → lossStreak 3); `zero ends streak` (−100, 0 → 0); `empty day` (open −700 → peak 0, drawdown 700).
- [ ] Write `desk-manager.config.spec.ts`: defaults; `DESK_MANAGER=LIVE` → live; `paper` → off; out-of-range numbers fall back; ceilings parsed from `INDEX_OPT:5000,STOCK_OPT:3000`.
- [ ] Run both, see them fail; implement; see them pass.
- [ ] Add models + migration; `npx prisma validate` and `npx prisma generate` pass.
- [ ] Commit `feat(desk-manager): types, tables, config and day P&L path`.

---

### Task 1: Desk guard (code, AI cannot override)

**Files:** Create `desk-manager/domain/desk-guard.ts` (+spec), `desk-manager/services/desk-guard.service.ts` (+spec), `desk-manager/repositories/desk-day.repository.ts` (+spec). Modify `signal-trader/services/signal-executor.service.ts` (PlaceInput.source, guard check) and its spec.

**Interfaces:**
- Consumes: `dayPnlPath`, `GuardState`, `ClosedTrade`, `DeskManagerConfig` (Task 0).
- Produces:
  - `DeskDayRepository.closedToday(userId: string, now: Date): Promise<ClosedTrade[]>` and `.openPnl(userId, now): Promise<number>` — live `trade_trackers` (not `paper:`), IST day, `origin` from `signal_orders.source` by `tracker_id` (`signal`→signal, `reentry`→reentry, `manager`→manager, none→manual).
  - `evaluateGuard(path: DayPnlPath, cfg: DeskManagerConfig['guard'], pause: { until: Date | null; scope: string | null }, underlying: string | null, now: Date): GuardState` (pure).
  - `DeskGuardService.state(userId, now, underlying?: string | null): Promise<GuardState>`; `.check(userId, source: 'signal' | 'reentry' | 'manager', underlying: string | null, now): Promise<GuardState>` (writes a `desk_guard_events` row when blocked); `.pause(userId, scope, minutes, now)`; `.resume(userId, now)`; `.reset(userId, now)` (sets `resetAt`; trades closed before `resetAt` no longer count today).
  - `PlaceInput.source?: 'signal' | 'reentry' | 'manager'`; `PlaceInput.underlying?: string | null`.
  - `SignalExecutorService` gets an optional `@Optional() @Inject(DESK_GUARD) guard?: { check(...) }` (export `DESK_GUARD = Symbol('DESK_GUARD')` from desk-guard.service.ts). When present, `place()` calls `check` before the broker call and returns `{ kind: 'BLOCKED', orderRowId: <claimed row id>, reason: 'DESK_GUARD: <reasons>' }` when blocked. Absent provider = today's behaviour.

- [ ] Tests (`desk-guard.spec.ts`): `blocks at drawdown 5000` (path peak 6000 total 1000); `blocks at day loss 8000`; `blocks after 3 losers`; `allows at 2 losers`; `pause all blocks, pause NIFTY blocks only NIFTY`; `expired pause does not block`; reasons name the numbers (`drawdown ₹5000 ≥ ₹5000`).
- [ ] Tests (`desk-day.repository.spec.ts`, mocked prisma): `counts a manual tracker` (no signal_orders row → origin manual, included); `excludes paper: trackers`; `IST day boundary` (closed 23:50 IST yesterday excluded); `resetAt excludes earlier closes`.
- [ ] Tests (`signal-executor.service.spec.ts`): `guard blocked → BLOCKED with DESK_GUARD reason and no broker call`; `no guard provider → unchanged`.
- [ ] Implement; run `npx jest src/modules/desk-manager src/modules/signal-trader/services/signal-executor.service.spec.ts`; commit `feat(desk-manager): desk guard on every automatic live entry`.

---

### Task 2: Visibility fixes (vocabulary + reader reason codes)

**Files:** Modify `signal-intake/domain/prefilter.ts` (+spec), `message-reader/services/reader-packet.service.ts` (+spec), `message-reader/message-reader.config.ts`, `message-reader/domain/reader-prompt.ts`, `message-reader/services/message-reader.service.ts` (+spec).

**Interfaces:**
- Produces: claims in `message_readings.claims[]` may carry `reasonCode: 'NO_INSTRUMENT' | 'QUOTE_BUDGET' | 'STALE' | 'TIMEOUT' | 'FORWARD_LOOKING' | 'NO_BARS' | 'OTHER'` when `verdict === 'NOT_CHECKABLE'` (Task 3 counts them).
- Consumes: nothing from Task 0.

- [ ] Prefilter tests: `"BSE CASH ABOVE 3860"` → underlyings `['BSE']`; `"BSE 3894 modify support 3870"` → `['BSE']`; `"listed on BSE and NSE"` → `[]`; `"MCX GOLD 72000 target"` → `['GOLD']` only (MCX stays an exchange word when a commodity follows); existing prefilter specs still pass.
- [ ] Implement: an `AMBIGUOUS_SYMBOLS` token also counts when one of the next 2 tokens is in `{CASH, ABOVE, BELOW, CMP, SUPPORT, RESISTANCE, TARGET, TGT, SL, BUY, SELL}` or a number, and the token is not immediately followed by another vocabulary instrument.
- [ ] Reader packet tests: `breadth gets its own 6000 ms box` (config `breadthMs` default 6000, separate from `packetMs`); `second pass quotes an AI-named instrument the prefilter missed` (cap 3, reading re-asked once with the added block); `NOT_CHECKABLE claim gets a reasonCode` from the failed block's reason (`reader quote budget`→QUOTE_BUDGET, `stale quote`→STALE, `timed out`→TIMEOUT, `no instrument`→NO_INSTRUMENT); prompt asks the model to set `reasonCode`, code fills `OTHER` when missing.
- [ ] Implement; run `npx jest src/modules/signal-intake src/modules/message-reader`; commit `fix(message-reader): BSE-class names, own breadth time box, second pass, NOT_CHECKABLE reason codes`.

---

### Task 3: Desk packet (what the manager sees)

**Files:** Create `desk-manager/services/desk-state.service.ts` (+spec), `desk-manager/repositories/desk-state.repository.ts` (+spec), `desk-manager/domain/packet-blocks.ts` (+spec).

**Interfaces:**
- Consumes: Task 0 types; `DeskDayRepository` + `DeskGuardService.state` (Task 1 — import by name; if not merged yet, code against the signatures above).
- Produces: `DeskStateService.build(userId: string, now: Date, cfg: DeskManagerConfig): Promise<DeskPacket>`; `DeskStateRepository.busy(userId, now): Promise<boolean>` (open live/paper position, or a proposal < 30 min old) for Task 4's cadence; `DeskStateRepository.scorecard(userId, sessions: number, now): Promise<Scorecard | null>` reading `desk_manager_decisions.grade` (Task 6 writes it).

Block sources (each block time-boxed 3 s via the reader's `block()` pattern, `{status, value|reason, source}`):
- positions: open `trade_trackers` for the owner (live) + manager paper trades (`trades` with tag `desk-manager`), latest `sentinel_verdicts` per tracker (`paper_sentinel_looks` for paper), `AI_AUTO_EXIT_HOLD` via the sentinel-executor `isHeld`, manager stop/targets from the latest DONE OPEN/TIGHTEN decision for that tracker.
- recentExits: trackers closed in the last 90 min + last sentinel verdict before `exitTime` + underlying now.
- proposals (cap 40, last 2 h, newest first): `message_readings` kind CALL/UPDATE (with claims, `missed_by_rules`), `ai_setups`, `signal_decisions` (decision, skip_reason, judge summary ≤ 300 chars), entry-engine decisions.
- instruments (cap 8): for each underlying in positions/exits/proposals: hub LTP, day O/H/L and VWAP from the level book, 15m trend tag, 6 nearest level-book levels, chain walls from `oi_snapshots` if captured; `missing[]` lists what could not be read. Underlying refs via `market-hub/underlying.ts resolveUnderlying` / NSE cash ref. No broker call per run.
- health: `message_readings` NOT_CHECKABLE count today grouped by `reasonCode` (absent = `OTHER`), feed status, agent heartbeats, failed blocks.
- memory: today's `desk_manager_decisions` (≤ 30), `scorecard(5)`, self-review lessons whose text names `desk-manager`.

- [ ] Tests: `a failing block is unavailable with its reason, the rest present`; `proposals capped at 40 newest first`; `instruments capped at 8 with missing listed`; `positions mark a HOLD-list contract held`; `recentExits only within 90 min`; `packet JSON under 100 000 chars for a 10-position, 40-proposal fixture`; `busy true with an open position, false on an empty day`.
- [ ] Implement; run `npx jest src/modules/desk-manager`; commit `feat(desk-manager): desk packet from every worker's output`.

---

### Task 4: Manager brain and runner

**Files:** Create `desk-manager/domain/manager-prompt.ts`, `domain/manager-schema.ts` (+spec), `domain/decision-validate.ts` (+spec), `services/manager-llm.service.ts` (+spec), `services/manager-runner.service.ts` (+spec), `repositories/desk-manager.repository.ts` (+spec). Modify `config/ai-agents.json` (job `desk.manager`), `ai-gateway/agents/agent-registry.ts` (`TRADING_JOBS` += `'desk.manager'`).

**Interfaces:**
- Consumes: Task 0 types/config; `DeskStateService.build`, `DeskStateRepository.busy` (Task 3); `DESK_ACTIONS: DeskActionsPort` (Task 5 provides it; inject with `@Inject(DESK_ACTIONS)`).
- Produces: `ManagerRunnerService.wake(reason: WakeReason, now?: Date): void` (debounced 20 s; other modules call it — Task 8 wires the events); `ManagerRunnerService.runOnce(reasons: WakeReason[], now: Date): Promise<{ runId: string; decisions: number } | null>`; `ManagerRunnerService.lastCompletedAt(): Date | null`; `parseManagerReply(raw: unknown): { ok: true; reply: ManagerReply } | { ok: false; error: string }`; `validateDecision(d: ManagerDecision, packet: DeskPacket): string[]` (problems; empty = valid).

Runner behaviour: `setInterval` 30 s tick (no cron); runs when mode ≠ off, a venue is open (`isAnyVenueOpen`), and `now − lastRun ≥ (busy ? 3 : 10) min` or a wake is pending; single-flight; abandons at 150 s; counts calls per IST day and stops (ops alert `desk-manager-call-cap`) at `maxCalls`; if no run completed for `idleEveryMin + 5` min while a venue is open → `sendOpsAlert('desk-manager-silent', …)` and sets `openBlocked = true` (exported `ManagerRunnerService.opensBlocked(): boolean`, read by Task 5). Each run: build packet → LLM → parse → per decision `validateDecision` → store decision row (VALID/INVALID) → `actions.execute` for valid ones in order (EXIT/BOOK/TIGHTEN first, then PAUSE/RESUME, then OPEN) → store result.

Prompt: static part first (role, authority order, the Global Constraints rules, the decision JSON contract, "every decision cites numbers from the packet in `evidence`", "levels are on the underlying", "15m is the smallest unit", the class ceilings from `cfg.ceilings` with "pick a stop whose estimated 1-lot loss stays inside the ceiling, else NO_ACTION"), then the packet JSON last (prompt caching). LLM call mirrors `ai-setups/services/setup-llm.service.ts` (`directRecordedTransport`, `withAiCallContext({userId})`, job `desk.manager`, strict JSON).

`validateDecision` problems: empty `evidence`; OPEN with stop on the wrong side or reward < 1.2 × risk (risk = |entry ref − stop|, entry ref = NOW→instrument ltp, ZONE→mid, BREAKOUT→trigger; reward = first target distance); OPEN underlying absent from `packet.instruments`; EXIT/BOOK/TIGHTEN trackerId not in `packet.positions` or `held`; TIGHTEN that loosens (LONG CE/FUT: new stop ≤ current manager stop; PE: ≥); PAUSE minutes outside 1–390.

- [ ] Tests: `parseManagerReply` — `malformed reply acts on nothing` (non-JSON → ok false), `unknown action rejected`, `valid reply parsed`; `validateDecision` — `rejects a decision without evidence`, `rejects reward below 1.2`, `rejects stop on wrong side`, `rejects TIGHTEN that loosens`, `rejects EXIT on a held position`; runner — `cadence 3 min when busy, 10 when idle`, `wake debounces 20 s into one run`, `single-flight`, `call cap stops runs and alerts once`, `health blocks opens after silence`, `exits executed before opens`, `mode off never calls the LLM`.
- [ ] Implement; run `npx jest src/modules/desk-manager src/modules/ai-gateway/agents`; commit `feat(desk-manager): manager prompt, reply contract, validation and runner`.

---

### Task 5: Actions — OPEN and pending entries

**Files:** Create `desk-manager/services/desk-actions.service.ts` (+spec) — implements `DeskActionsPort` and delegates EXIT/BOOK/TIGHTEN to Task 7's `DeskExitActions`; `desk-manager/domain/premium-risk.ts` (+spec); `desk-manager/services/pending-entry-watch.service.ts` (+spec). Extract from `signal-trader/services/signal-trader.service.ts act()` the funds / MCX-mini / pre-send re-quote checks into `signal-trader/services/pre-send-checks.ts` (`preSendChecks(...)`) used by both `act()` and the manager (no behaviour change for signal-trader; its specs must still pass).

**Interfaces:**
- Consumes: Task 0 types/config; `DeskGuardService.check` (Task 1); `ManagerRunnerService.opensBlocked()` (Task 4, inject optional); `SignalExecutorService.place` with `source: 'manager'`, `underlying`; `EntryEnginePaperService.open` with `brand { strategy: 'DESK_MANAGER', source: 'desk-manager', tags: ['desk-manager', 'desk-decision:<id>'], label: 'Desk manager' }`; ai-setups helpers `engineContract`, `planEntry`, `contractValueFactor`, the setup-watch market (`master()`, `ltps()`); `DeskExitActions` (Task 7).
- Produces: `estimatePremiumLoss(i: { side: 'BUY_CE' | 'BUY_PE' | 'BUY_FUT'; strikePolicy; underlyingEntry: number; underlyingStop: number; lotQty: number; valueFactor: number; delta: number | null; spread: number }): number` — |entry − stop| × (delta ?? {ATM 0.5, ITM1 0.6, OTM1 0.4, FUT 1, numeric strike → 0.5}) × lotQty × valueFactor + spread × lotQty; `ceilingFor(underlying: string, exchange: string, symbol: string, cfg): number` (same classes as `common/utils/loss-limit.ts`).

OPEN steps: refuse if `opensBlocked()`, mode off, guard blocked (live), venue closed / last 30 min / before `SIGNAL_LIVE_FROM_IST` (NSE/BFO), entries today ≥ maxEntries, HOLD-list name, an open tracker or PENDING entry on the same underlying (any source: trackers' underlying via resolver, `desk_manager_pending_entries`, `signal_orders` in flight); resolve contract (strike/expiry policy → `engineContract`); premium SL = entry premium − estimated loss / lotQty (floored at one tick); refuse if estimated loss > ceiling; NOW → plan via `planEntry` and act; ZONE/BREAKOUT → insert PENDING row (`validUntil = now + validMin`), result PENDING.
Acting: live → `preSendChecks` → `place({ decisionId, source: 'manager', underlying, plan, ... })`; a refusal is recorded (REFUSED), **no paper fallback**; shadow → `EntryEnginePaperService.open`. After a fill, TIGHTEN to the manager stop via Task 7 (arms the underlying stop trigger).
`PendingEntryWatchService`: every 5 s, for PENDING rows, read underlying LTP; ZONE fires when low ≤ LTP ≤ high, BREAKOUT when LTP ≥ triggerAbove / ≤ triggerBelow; re-run every OPEN refusal check at fire time; expire at `validUntil`; claim the row (status update with `where status = PENDING`) before acting.

- [ ] Tests: `estimatePremiumLoss` BSE fixture (entry 3890, stop 3760, ATM, lot 375, factor 1, delta null, spread 1 → 130×0.5×375+375 = 24 750) and `refuses when above the STOCK_OPT ceiling 3000`; `refuses a second entry on the same underlying`; `refuses in the last 30 min`; `refuses before live start on NSE`; `refuses when guard blocked`; `refuses at 5 entries today`; `NOW live calls place with source manager and no paper fallback on REJECTED`; `NOW shadow opens paper with the DESK_MANAGER brand`; `ZONE creates PENDING and the watch fires inside the zone`; `BREAKOUT expires at validUntil`; `pending claim prevents double fire`; signal-trader specs unchanged and passing.
- [ ] Implement; run `npx jest src/modules/desk-manager src/modules/signal-trader`; commit `feat(desk-manager): OPEN — contract, ceiling check, live/shadow entry and pending entries`.

---

### Task 6: Learning — nightly grade

**Files:** Create `desk-manager/services/desk-grade.cron.ts` (+spec), `desk-manager/domain/desk-grade.ts` (+spec).

**Interfaces:**
- Consumes: Task 0 tables.
- Produces: `desk_manager_decisions.grade` JSON `{ kind: 'OPEN' | 'NO_ACTION' | 'EXIT' | 'PAUSE' | 'OTHER'; pnl: number | null; netPnl: number | null; hit: 'TARGET' | 'STOP' | 'NEITHER' | null; mfe: number | null; mae: number | null; vsHold60: number | null; note: string }` (Task 3 reads it).

Cron `@Cron('45 23 * * 1-5', { timeZone: 'Asia/Kolkata' })` (after MCX close). OPEN: P&L of its tracker/paper trade net of charges (reuse the charges helper used by paper P&L), MFE/MAE on the underlying from 15m hub bars between entry and exit, hit stop/target. EXIT/BOOK: underlying 60 min after vs at exit, signed for the position. NO_ACTION on a proposal with a concrete level: what the proposal's own entry/SL/target would have made on 15m bars (`hit` only). PAUSE: count of automatic entries blocked while it was in force (from `desk_guard_events`).
- [ ] Tests: `grades a winning OPEN with net pnl and TARGET`; `EXIT graded vs holding 60 min`; `NO_ACTION graded from the proposal's levels`; `missing bars → null fields with a note, never a throw`; `re-run does not overwrite an existing grade`.
- [ ] Implement; commit `feat(desk-manager): nightly grading of manager decisions`.

---

### Task 7: Actions — EXIT / BOOK / TIGHTEN, target lock, hard-loss exemption

**Files:** Create `desk-manager/services/desk-exit-actions.service.ts` (+spec), `desk-manager/services/target-watch.service.ts` (+spec). Modify `trade-sentinel/services/sentinel-cycle.service.ts` (hard-loss exemption) and its spec; `sentinel-executor/services/manual-exit.service.ts` (accept a system caller) and spec.

**Interfaces:**
- Consumes: Task 0 types; `ManualExitService.request`; the trigger arming path (`sentinel_verdicts` row with `exitTrigger`, armed by `TriggerWatchService.armPass`, validated tighten-only by `validateTrigger`); `ManagerRunnerService.wake` (Task 4, optional inject).
- Produces: `DeskExitActions.exit(trackerId: string, kind: 'EXIT' | 'BOOK', reason: string, ctx: ActionContext): Promise<ActionResult>`; `DeskExitActions.tighten(trackerId: string, underlyingStop: number, reason: string, ctx: ActionContext): Promise<ActionResult>`; `isManagerTracker(trackerId: string): Promise<boolean>` (signal_orders.source = 'manager').

- EXIT/BOOK live: `ManualExitService.request({ userId: owner, role: 'ADMIN', email: 'desk-manager' }, trackerId, { reason: 'DESK_MANAGER <kind>: <reason>' })` — add an optional `reason` to its opts stored on the execution row; it is the MANUAL trigger, so no thesis gate and no AI daily cap; count manager exits/day against `maxExits`. Shadow (paper trade) → close via the paper close path the AI setups use. Refused when the tracker is HOLD-listed.
- TIGHTEN: insert a `sentinel_verdicts` row `{ verdict: 'HOLD', confidence: 'high', reason: 'DESK_MANAGER TIGHTEN: …', triggeredBy: ['desk-manager'], promptVersion: 'desk-manager/1', exitTrigger: { instrument: 'UNDERLYING', op: LONG-CE/FUT ? 'BELOW' : 'ABOVE', price: underlyingStop } }` so the existing trigger watch arms it (tighten-only); result RECORDED with the verdict id; a later REJECTED proposal is visible to the next packet.
- Target lock (`TargetWatchService`, every 5 s): for manager trackers with targets, when the underlying crosses the next target → `wake('target_crossed')`; if no EXIT/BOOK/TIGHTEN decision for that tracker within 60 s → `tighten` to the previous target (or entry for the first), never looser.
- Hard-loss exemption: in the sentinel cycle's flat hard-loss path (`hardLossFor` / `rescueHardLoss`), skip `HARD_LOSS_EXIT_RUPEES` for `isManagerTracker` positions; the class catastrophe floor (`HARD_LOSS_CEILING_BY_CLASS`) still applies.
- [ ] Tests: `EXIT calls manual exit with the system caller and reason`; `EXIT refused on HOLD-listed tracker`; `exits capped at maxExits per day`; `TIGHTEN writes a HOLD verdict with an UNDERLYING BELOW trigger for a CE`; `PE gets ABOVE`; `target crossed wakes the manager and locks after 60 s`; `lock never loosens`; sentinel `manager tracker skips the flat 2000 exit but not the class ceiling`; `non-manager tracker unchanged`.
- [ ] Implement; run `npx jest src/modules/desk-manager src/modules/trade-sentinel src/modules/sentinel-executor`; commit `feat(desk-manager): exits, tightening, target lock; manager trades ride their own stop`.

---

### Task 8: Wiring, API, Desk page, golden tests (lead, after Tasks 1–7 merge)

**Files:** `desk-manager/desk-manager.module.ts`, `desk-manager/controllers/desk-manager.controller.ts` (+spec), `apps/api/src/app.module.ts`, event hooks (message-reader after a reading is stored; trade-tracker open/close; sentinel verdict record; signal-trader decision record) calling `ManagerRunnerService.wake` through an optional injected port `DESK_WAKE`; `deploy/env/api.env.example`; web `apps/web/src/pages/desk/DeskPage.tsx` + route + nav + `useDesk` hook; `desk-manager/desk-manager.golden.spec.ts`.

- API (owner/admin only, JWT): `GET /api/desk-manager/state` (latest run summary, guard state, opensBlocked, mode), `GET /api/desk-manager/decisions?date=YYYY-MM-DD`, `POST /api/desk-manager/guard/reset`, `POST /api/desk-manager/pause` `{scope, minutes}`, `POST /api/desk-manager/resume`.
- Desk page: manager summary + last run time; guard card (P&L path, peak, drawdown, streak, blocked reasons, reset button); decisions today (time, action, underlying, reason, evidence, status/result); data holes (NOT_CHECKABLE by reason). Polls every 20 s only while the page is visible.
- Owner alerts via `OWNER_ALERTS` for: every OPEN placed/refused, EXIT/BOOK, guard block, manager silent.
- Golden tests: `BSE morning 2026-11-26 packet → a valid OPEN BSE BUY_CE (stop 3863, the sentinel's invalidation, inside the STOCK_OPT ₹3,000 ceiling) passes validation and reaches place() in live mode with source manager` (LLM mocked to the expected reply; the point is the plumbing); `11-13-style day: third manual loser → guard blocks the next signal-trader live place`.
- [ ] Wire, run full `npx jest src/modules/desk-manager src/modules/signal-trader src/modules/trade-sentinel src/modules/sentinel-executor src/modules/message-reader src/modules/signal-intake src/common` and the web build `npm run build -w apps/web` (or the repo's web build script); commit `feat(desk-manager): wiring, API, Desk page, golden tests`.
