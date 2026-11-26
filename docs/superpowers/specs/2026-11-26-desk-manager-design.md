# Desk manager — one AI that runs the desk (decides entries, manages, books, re-enters)

Date: 2026-11-26 · Status: APPROVED by owner 2026-11-26 ("yes agree with both, go ahead with the build") · Revises: `2026-11-25-desk-watcher-design.md` (L2)
Area: new `desk-manager`, `signal-trader` (executor), `trade-engine` (guard), `signal-intake` (vocabulary),
`message-reader`, `sentinel-executor`, `ai-gateway`, web.

## 1. Intent — why

Owner, 2026-11-26, after the BSE trade: the supreme watcher "is responsible for taking the decisions, who
has the context of everything that is happening inside the application … think of it as a manager who has
the responsibility to manage different workers so that the company runs well and generates good returns —
here the company is our application. It's about how it is thinking and taking the decision."

What happened on 2026-11-26 (prod, IST):
- 09:20 *Stock Gainers*: "BSE CASH ABOVE 3860, support 3760, view 4000". The **message reader** read it in
  7 s as a **CALL the rules missed** (`missed_by_rules=true`, BUY BSE >3860, SL 3760, T 4000), but verdict
  NOT_CHECKABLE ("no BSE quote") and the reader is shadow, so nothing acted. The rule parser had dropped it
  because `BSE` is on `AMBIGUOUS_SYMBOLS` (`signal-intake/domain/vocabulary.ts:99`).
- The owner traded it by hand (3900CE 174.9 → 165.95; PE flip; 3900CE 182.2 → 170.25): −₹5,060 on BSE.
  The **sentinel** said HOLD each time on the call ("above VWAP, 15m/1h bullish, 3863 invalidation"); its
  4 hard-loss exits were refused `GATED_THESIS_INTACT`. **Re-entry** skipped BSE: `not-in-universe`.
- The 3900CE then ran 199 (10:30) → 205 (10:45) → ~220 (channel recap): ~+₹6k–9k for 1 lot.

Every worker was right about its own piece; no one owned "BSE today". The same day 41 of 81 reader claims
were NOT_CHECKABLE, and ~11 separate symbol lists decide what each part can see (BANKEX, BSE, token reuse
all had this shape). The manager is the one place that sees the whole desk, decides, and owns the result.

## 2. Goals, non-goals, anti-goals

**Goals**
- G1. **One manager AI** that sees the whole desk (§5.2) and **decides**: open, exit, tighten, pause, resume,
  watch, flag a data hole.
- G2. **Workers propose, the manager decides**: message-reader CALLs/claims, AI setups, signal-judge
  decisions (incl. skips), entry-engine decisions, sentinel verdicts, recent exits with thesis intact.
- G3. Opens trades **live** (mode switch), books profit, re-enters an intact thesis after a shake-out.
- G4. **Code guard** on entries the AI cannot override: no new entries past a drawdown or N losers in a row.
- G5. **Data holes are the manager's problem**: anything it wants to act on but cannot see is reported, and
  the BSE-class holes found on 11-26 are fixed at the source.
- G6. **Learns**: every decision graded nightly; its own scorecard is in its next packet.

**Non-goals (v1)**
- Per-trade agents with persistent memory and a multi-rule level book (desk-watcher §5.4 / §5.2). The
  sentinel keeps managing each position; the manager reads its verdicts and overrides by EXIT/TIGHTEN. v2.
- Replacing the signal judge: explicit channel calls keep their current live path in v1 (§5.7).
- Sizing above 1 lot, option selling, adding to a position.
- Changing daily max loss, kill switch, HOLD list, catastrophe floors, risk manager limits.

**Anti-goals** (failure even if it "works")
- Revenge trading: entries after the day turned (11-09, 11-13). The code guard exists for this.
- The manager on the fast-move critical path (it decides levels; code executes them).
- A decision without the numbers behind it.
- Silent absence: the manager not running, or blind, with nobody noticing.
- Two parts opening the same underlying at once.

## 3. Constraints

- Authority order: **Owner (L0) > risk limits (L1) > manager (L2) > sentinel / workers (L3) > executor (L4)**.
  Close beats hold; tighten beats loosen; the manager never loosens a stop or acts on a HOLD-list position.
- Live entries go through `SignalExecutorService.place` (`signal-trader/services/signal-executor.service.ts:86`),
  which already claims a `signal_orders` row and re-checks `isLiveTradingEnabled` + `coreEntryAllowed`.
  Paper opens go through `EntryEnginePaperService.open` (brand) → `TradeExecutionService.executeTrade`.
- No single "no new entries" choke point today; `place()` covers all live entries and `executeTrade()` all
  paper ones (note `isLearningPaper` bypass at `risk-manager.service.ts:95`).
- AI: Vertex, AI agents on; registry `config/ai-agents.json`; calls via `directRecordedTransport` +
  `withAiCallContext` (as `signal-judge.service.ts:43-98`); global limiter 16 / trading reserve 6.
- VPS 1 vCPU / 2 GB: the desk packet must be compact (target < 25k tokens) and built in < 5 s.
- Timeframes: 15m is the smallest decision unit; ticks only execute pre-set levels.
- Owner alerts (Telegram) are not configured on prod: nothing may depend on them for safety.
- Push = deploy; never with an open-position decision pending.

## 4. Approaches considered

| | Approach | Trade-off |
|---|---|---|
| **A (chosen)** | **Manager as a new module on top of the existing workers.** It reads their outputs (tables), decides, and acts only through the existing executors (`place`, paper open, exit executor, TriggerBook). Workers keep running. | Smallest new surface; reuses every guard; workers keep working if the manager is down. Two entry deciders coexist in v1 (manager + signal judge) — handled by one-open-per-underlying and the manager seeing every judge decision. |
| B | Manager replaces the decision steps of every worker (workers only gather and propose). | The clean end state, but rewires signal-trader, entry-engine, ai-setups, reentry at once — the risky big-bang the 09-30 architecture warns against. Becomes v2 step by step. |
| C | Extend the sentinel cycle to also decide entries. | The sentinel's cycle is per position; the desk view and entries don't fit it, and it would overload the most safety-critical loop. |

## 5. Design

### 5.1 Module and loop
- New module `apps/api/src/modules/desk-manager/` (controller, services, repository, domain, config).
- Config `DESK_MANAGER=off|shadow|live` (default off), parsed once like `parseSignalTraderConfig`.
  - **shadow**: decisions recorded; OPENs paper-traded (brand `DESK_MANAGER`); EXIT/TIGHTEN recorded only.
  - **live**: OPEN places real orders; EXIT/TIGHTEN act through the executors.
- **Wake**: every 3 min while any venue is open (`isAnyVenueOpen`, 09:00–23:30 IST incl. MCX), plus events:
  a new reading with kind CALL or `missed_by_rules`, a CONFIRMED/CONTRADICTED claim on an open underlying,
  a tracker opened/closed, a sentinel EXIT_NOW or HOLD-after-loss, a signal decision SKIP of a judge TAKE,
  a guard state change. Events debounce 20 s; one run at a time (single-flight); a run > 150 s is abandoned.
- Owner account only (`HUB_OWNER_USER_ID`), tables carry `userId`.

### 5.2 Desk packet (what the manager sees)
Built by `DeskStateService.build(now)` from existing tables, each block time-boxed with `{status, value|reason,
source}` (the reader's packet pattern), so a missing block is visible, never silent:
1. **Day**: IST time, minutes to NSE close / MCX close, live window (`SIGNAL_LIVE_FROM_IST`), guard state.
2. **P&L path**: realised + open (live trackers), day peak, drawdown from peak, closed trades with result,
   current losing streak; same for paper.
3. **Open positions**: each live/paper tracker: symbol, underlying, qty, entry, LTP, P&L, age, source
   (manual/signal/engine/setup/manager), latest sentinel verdict + thesis + invalidation, HOLD-list flag.
4. **Recent exits (last 90 min)** with the sentinel's last verdict at exit and the price since (re-entry candidates).
5. **Proposals**: today's message readings with kind CALL / UPDATE and their claims + verdicts (incl.
   `missed_by_rules`), AI setups (pending/filled/expired), signal decisions (TAKE/SKIP + reason + judge
   summary), entry-engine decisions, last 2 h, newest first, capped at 40 items.
6. **Instrument views** for every underlying in 3–5 (cap 8): LTP, day O/H/L, VWAP, 15m trend, nearest level-book
   levels, option-chain walls if captured — from the hub / level book, never a broker call per run.
7. **Health / data holes**: reader NOT_CHECKABLE count today and the reasons, agent heartbeats, feed status,
   blocks of this packet that failed.
8. **Memory**: the manager's own decisions today with outcomes so far; its scorecard for the last 5 sessions
   (from §5.8); yesterday's night-review lessons that name it.

### 5.3 Decisions (strict JSON, one call)
Model Opus 5.5, effort high, registry job `desk.manager` on the trading agent, concurrency 1, timeout 120 s,
added to `TRADING_JOBS`. Output: `{ summary, decisions: [...] }`, each decision with `reason` and `evidence`
(numbers cited from the packet; a decision without evidence is rejected by code):
- `OPEN {underlying, side BUY_CE|BUY_PE|BUY_FUT, strikePolicy ATM|ITM1|OTM1|strike, expiryPolicy NEAREST|NEXT,
  entry {type NOW|ZONE|BREAKOUT, low?, high?, triggerAbove?/triggerBelow?, validMin}, stop {underlying},
  targets {underlying[]}, proposalRef?, confidence}` — levels are on the **underlying**, the executor maps them.
- `EXIT {trackerId}` · `TIGHTEN {trackerId, underlyingStop}` · `BOOK {trackerId}` (take profit now = EXIT with
  reason profit) · `PAUSE_ENTRIES {scope all|underlying, minutes}` · `RESUME` · `WATCH {underlying, note,
  recheckMin}` (asks for a re-run with that underlying's view) · `FLAG_DATA_HOLE {what, impact}` · `NO_ACTION`.
- All decisions are stored in `desk_manager_decisions` (packet hash, raw reply, validation result, action
  result, timings).

### 5.4 Acting (code, deterministic)
- **OPEN**:
  1. Validate: underlying resolvable (`segmentFor` + contract resolver), not a HOLD-list name, no open
     position or pending entry on that underlying (any source), guard OK (§5.5), within the live window and
     not in the last 30 min of the venue, max `DESK_MANAGER_MAX_ENTRIES` (default 5) per day, stop and target
     on the right side, reward ≥ 1.2 × risk on the underlying.
  2. Resolve the contract (strike/expiry policy) with the signal-trader contract resolver; 1 lot.
  3. `NOW` → limit at the re-quoted ask (+ the signal-trader slippage rule). `ZONE`/`BREAKOUT` → a
     **pending entry** row watched every 5 s (the `SetupWatchService` pattern) until filled or `validMin`
     expires; re-validates step 1 at fire time.
  4. live → shared pre-send checks (funds, SL enforceability, MCX mini, re-quote — extracted from
     signal-trader `act()`), then `SignalExecutorService.place({source:'manager', ...})`; refusal → recorded, **no silent paper fallback** in live mode
     (shadow uses paper). Shadow → `EntryEnginePaperService.open({brand DESK_MANAGER})`.
  5. After a fill: arm a stop trigger on the underlying stop via the existing TriggerBook path (tighten-only)
     and record the targets; the sentinel picks the tracker up as for any position.
- **EXIT / BOOK**: through the sentinel-executor with trigger `MANAGER` (new value): same guards (HOLD,
  exchange, in-flight, open-order handling) but **not** `GATED_THESIS_INTACT` and **not** the AI daily cap
  (a manager exit is a protective/profit decision, counted separately, cap `DESK_MANAGER_MAX_EXITS` 20).
- **TIGHTEN**: arm/replace the tracker's trigger through `validateTrigger` (tighten-only); refusals recorded.
- **Targets**: when the underlying crosses a recorded target, the manager is woken immediately (event) to
  BOOK or TIGHTEN; if no decision within 60 s, code tightens the stop to the previous target / entry
  (profit lock), never loosens.
- **PAUSE_ENTRIES** is honoured by the desk guard for manager OPENs, signal-trader live, reentry live.

### 5.5 Desk guard (code, AI cannot override) — `DeskGuardService`
- Blocks new **live** entries from every path when, for the owner's live trades today (NSE+MCX, IST day):
  - drawdown from the day's peak P&L ≥ `DESK_GUARD_DRAWDOWN_RUPEES` (default ₹5,000), or
  - realised + open loss ≥ `DESK_GUARD_DAY_LOSS_RUPEES` (default ₹8,000, below the ₹10k signal stop), or
  - `DESK_GUARD_LOSS_STREAK` (default 3) losing closed trades in a row, or
  - a manager `PAUSE_ENTRIES` in force.
- Resets only on the next IST day or the owner's `POST /api/desk-manager/guard/reset`.
- Enforced in two places: `SignalExecutorService.place` (all live entries: signal, reentry, manager) and the
  manager's own OPEN validation. Paper/learning entries are not blocked (they are how we learn), but are
  tagged with the guard state.
- Guard state is in the packet; every block is recorded with the numbers (fix-ticket lesson: no silent blocks).

### 5.6 Visibility fixes found on 11-26 (part of v1)
- **Ambiguous symbols**: an `AMBIGUOUS_SYMBOLS` word also counts as an instrument when followed (within 2
  tokens) by a price-level phrase (`CASH`, `ABOVE`, `BELOW`, `CMP`, `SUPPORT`, `RESISTANCE`, `TARGET`, `SL`,
  `BUY`, `SELL`, or a number). Golden cases: "BSE CASH ABOVE 3860" → BSE; "listed on BSE and NSE" → none.
- **Reader packet**: an instrument the AI names that the prefilter missed is quoted on a second pass (cap 3);
  breadth/sectors get their own 6 s box (they timed out at 3 s); every NOT_CHECKABLE carries a machine
  reason code (`NO_INSTRUMENT`, `QUOTE_BUDGET`, `STALE`, `TIMEOUT`, `FORWARD_LOOKING`) counted in §5.2 block 7.
- **One shared "can we see it" check**: `desk-manager` keeps a daily `visibility` record per underlying it
  touched (quote? 15m bars? chain? level book?) so a hole shows up as data, not as a missed trade.
- Re-entry-watch universe stays as is: re-entries of stocks are the manager's decision now (§5.2 block 4).

### 5.7 Coexistence with the signal judge (v1)
- Explicit channel calls keep their live path (judge → place). The manager sees every decision; it may
  EXIT a judge trade or OPEN on a judge SKIP when it disagrees, but never the same underlying twice
  (one open/pending per underlying across all sources, checked in OPEN validation and in `place()` for
  source `manager`).
- v2 moves the judge, entry engine and AI setups to "propose only" once the manager has a record.

### 5.8 Learning
- Nightly (after MCX close, a prod cron): every OPEN graded (P&L net of charges, MFE/MAE on the underlying,
  hit stop/target); every NO_ACTION on a proposal graded by what the proposal would have made; EXIT/BOOK
  graded against holding 60 min; PAUSE graded against the entries it blocked.
- A 5-session scorecard and the 3 worst / 3 best decisions with reasons go into the next packet (§5.2 block 8).

### 5.9 Visibility for the owner
- `GET /api/desk-manager/state` (latest packet summary + guard), `GET /decisions?date=`, `POST /guard/reset`,
  `POST /pause`, `POST /resume`.
- Web: a **Desk** page — the manager's latest summary, its decisions today with reasons and results, guard
  state, data holes. Owner alerts sent through the existing `OWNER_ALERTS` port (works once Telegram is set).
- Health: if no manager run completes for 10 min while a venue is open and mode ≠ off → `sendOpsAlert` and
  the guard blocks manager OPENs (no blind entries); signal-trader keeps its own path.

## 6. Decided by the owner (2026-11-26)
- The supreme watcher is a **manager that decides**, including entries (reverses 11-25 "never open or add").
- Guard instead of "never open": inside the untouchable limits; no new entries past a drawdown or N losers
  in a row, enforced in code.
- Build now; **owner wants live directly**, final switch decided at deploy (`DESK_MANAGER=live`).
  CLAUDE.md "new strategies start in paper" is the owner's call at switch-on.
- Build fast with a team of agents.

### Decided after the builder check (owner 2026-11-26: "yes agree with both")
- **Per-trade max loss = the class ceiling** (`HARD_LOSS_CEILING_BY_CLASS`: INDEX_OPT ₹5,000, STOCK_OPT
  ₹3,000, GOLD/SILVER ₹7,500, GOLD_MINI/SILVER_MINI ₹4,000, other MCX ₹5,000). The manager's underlying stop
  is converted to an estimated premium loss for 1 lot (delta from the chain/greeks when captured, else
  0.5 for ATM, 0.6 ITM1, 0.4 OTM1; plus the spread); if it exceeds the ceiling the OPEN is **refused**,
  never shrunk. The flat ₹2,000 hard-loss exit does **not** cut manager trades; their stop is the
  manager's stop, and the class catastrophe floor stays as the backstop.
- **Desk guard counts every live trade of the owner** (manual, signal, re-entry, manager) from
  `trade_trackers` (live, owner, IST day, NSE+MCX), and blocks **every automatic live entry** (manager,
  signal judge, re-entry) — never the owner's own orders. Manager cap 5/day is separate from the signal
  cap 5/day (≤ 10 automatic live entries a day).

### Settled by the designer after the builder check (owner to check)
- **AI budget**: wake every 3 min while a position is open or a proposal is < 30 min old, else every
  10 min; packet ordered for prompt caching (static rules first, day state last); hard cap
  `DESK_MANAGER_MAX_CALLS` 400/day, after which the manager stops opening (exits by code rules continue)
  and an ops alert fires. The 10-min health alert uses the 10-min cadence + 5 min.
- **Shadow is a thin smoke test**: OPENs paper-traded, and EXIT/BOOK/TIGHTEN act on the manager's own
  paper trades (paper close / paper trigger), so grading scores the manager's own exits.
- `place()` needs a premium SL: the manager OPEN passes `EntryPlan.sl` = entry premium − estimated
  premium loss at the underlying stop (as above); the funds check / MCX mini swap / riskRupees checks that
  live in `signal-trader.service.ts act()` are extracted into a shared helper both use (not duplicated).

## 7. Calls made in this design (owner to check)
- Approach A: manager on top of existing workers, acting only through existing executors.
- v1 keeps the sentinel as the per-trade manager; per-trade agents with memory are v2.
- Guard defaults: drawdown ₹5,000 from peak, day loss ₹8,000, 3 losers in a row; reset next day or by owner.
- Manager entries: max 5/day, 1 lot, buy-side options/futures, not in the last 30 min, reward ≥ 1.2 × risk.
- Manager EXIT/BOOK bypass the thesis gate and the AI exit cap (own cap 20).
- No paper fallback for a refused live manager OPEN (it is recorded instead).
- Explicit channel calls keep the judge's live path in v1.

## 8. Left to the builder
Exact schemas (`desk_manager_decisions`, `desk_manager_pending_entries`, `desk_guard_events`), the prompt
text, packet block caps, event wiring, web layout, tests (golden: the 11-26 BSE morning as a packet →
expected OPEN; the 11-13 losing day → guard blocks after the 3rd loser).
