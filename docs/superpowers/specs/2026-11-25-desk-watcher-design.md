# Desk watcher — a supreme AI watcher, an AI agent per open trade, and fast execution

Date: 2026-11-25 · Status: DRAFT for owner approval · Area: `trade-sentinel`, `sentinel-executor`, `signal-trader`, `exit-discipline`, `ai-gateway`, new `desk-watcher`

## 1. Intent — why

The owner (2026-11-25): "there is a gap between the things happening inside the application … There is no
human kind of watcher who is continuously watching these and taking the decisions … there should be a
supreme watcher over everything … to close the day in green." Then: "once a trade is active, we assign an
[agent] to it, that will monitor it and report it to the supreme one", "consider the fast movements that
usually happen", "make the structure fast and reliable, can handle multiple calls and trades at a time",
and "with the AI in the loop we can reduce the dependency on the floor hard rule". Token cost is not a
constraint. The watcher must take the decisions "a human with emotion can't take", from verified data,
"to protect the day".

Evidence (live tracked positions, last 30 days, prod `trade_trackers`):

| Day | Best | Worst | Closed | Losers |
|---|---:|---:|---:|---|
| 11-09 | +₹9,644 | −₹13,424 | −₹11,230 | 8/11 |
| 11-20 | +₹5,428 | −₹6,649 | −₹6,374 | 11/17 |
| 11-17 | +₹16,938 | −₹2,790 | +₹7,923 | 11/22 |
| 11-13 | −₹7,148 | −₹23,747 | −₹23,747 | 11/13 |
| 11-18 | −₹205 | −₹12,184 | −₹12,184 | 12/14 |
| 11-25 | +₹378 | −₹10,844 | −₹10,844 (at 11:37) | 4/6 |

Two repeating shapes nothing in the app reacts to: **green days given back**, and **losing streaks traded
straight through**. Today each AI sees only its own piece (signal judge: one call; exit sentinel: one
position; entry engine; night review after the close). Day-level rules are fixed numbers only.

Broker-stop check (prod `floor_broker_sl_events`, 7 days, `FLOOR_BROKER_SL` unset = shadow): no real
stop order rests at Angel today. A resting stop at the armed noise floor would have exited better than the
app in 19 of 25 compared exits, but one GOLDM spike-and-recover would have cost ₹33,500 — net −₹19,224.
So a broker stop works as a **wide catastrophe floor**, not as the working stop.

## 2. Goals, non-goals, anti-goals

**Goals**
- G1. **Supreme watcher**: one AI that sees the whole desk (every open trade, today's P&L path, every
  Telegram call + judge verdict, verified market notes, entry-engine decisions, health of every agent)
  and makes day-level decisions: pause entries (all / per underlying / per channel), make the judge
  stricter for the day, tighten all, lock profit, close all, resume.
- G2. **Trade agent per open trade**: owns exactly one position from fill to exit; keeps the trade's
  story (why taken, what the judge said, how price behaved at each level, its own previous decisions);
  manages it (hold / tighten / take profit / exit); reports a one-line status to the watcher.
- G3. **Fast moves**: AI never sits on the critical path of a fast move. Agents pre-decide price levels;
  deterministic code executes them on every tick (milliseconds).
- G4. **Many at once**: calls, trades and the watcher run on separate AI capacity, in parallel; nothing
  queues behind anything else. Target: 10 open trades + 10 calls/min without delay.
- G5. **Reliable**: every live trade has a real resting stop at the broker (catastrophe floor); every
  agent heartbeat is monitored; every step timed; silent failure is impossible by design.
- G6. **Smarter floor**: the flat ₹2,000 hard-loss exit becomes an instrument-sized catastrophe floor,
  wider than normal noise, that fires only when the AI layer has failed or the market gaps.

**Non-goals**
- Not a new entry strategy. Entries stay with the signal judge / entry engine.
- No change to the daily max-loss limit, the kill switch, position caps or the Risk Wall.

**Anti-goals** (failure even if it "works")
- The watcher or a trade agent **opening a trade or adding size** (owner was told this is excluded;
  §8 records it as a call to confirm). Chasing losses late in the day is how 11-09 / 11-13 went red.
- Any AI decision that can **loosen** a stop or widen risk.
- An AI outage (e.g. the 2026-11-06/07 ~42 h CLI failure) leaving open trades unprotected.
- Two AIs fighting over one position with no rule for who wins.
- Optimising "close green" as a target — the watcher protects the day; it does not force it.

## 3. Constraints (from the code and prod)

- Safety order (2026-09-30 architecture): **Risk Wall > strategy > AI**; news/context may only tighten or
  exit. CLAUDE.md §9 non-negotiable: hard limits auto-trade cannot override.
- Exit machinery today: `trade-sentinel` (`SentinelCycleService`: routine looks Sonnet/medium, triggered
  looks Opus/high), `sentinel-executor` (AI auto-exit live on NFO/BFO/MCX, daily cap 15, owner HOLD list),
  AI price triggers (tighten-only, "REJECTED LOOSENS"), `exit-discipline` hard floor
  (`HARD_LOSS_EXIT_RUPEES=2000`, per-underlying caps e.g. GOLD ₹7,500), chart checks `EXIT_CHART_CONFIRM=act`,
  `FLOOR_BROKER_SL` (off|shadow|live; shadow today), exit-noise read (record only).
- AI capacity: Vertex, AI agents on (3 containers: trading/reading/background); global limiter 16 with a
  trading reserve of 6 (raise approved by owner 2026-11-25). Server: 1 vCPU / 2 GB VPS — agents only call
  Vertex, so per-trade agents are I/O, not CPU, but in-process state must stay small.
- Owner HOLD list (`AI_AUTO_EXIT_HOLD`) blocks AI, price-trigger **and** hard-floor exits for a named
  contract (e.g. MAZDOCK29DEC261760PE added 2026-11-25). The watcher must respect it and say so.
- Telegram owner alerts are not configured on prod; nothing in this design may rely on them for safety.
- Timeframes: nothing decided on 1m bars; 15m smallest decision unit (owner rule). Ticks are used only to
  *execute* pre-set levels, never to *decide*.
- Push = deploy; deploy only after 15:35 IST, never with an open-position decision pending.

## 4. Approaches considered

| | Approach | Trade-off |
|---|---|---|
| **A (recommended)** | **Evolve the exit sentinel into per-trade agents; add one watcher above; fast level-executor below.** Trade agent = today's sentinel cycle per tracker + persistent trade memory + structured report. Watcher = new module reading reports + desk state. | Reuses proven exit plumbing (executor, guards, HOLD, triggers); one owner per trade; smallest new surface. |
| B | New agent framework beside the sentinel (separate long-lived agent processes per trade). | Cleaner isolation, but two systems managing exits during transition — the silo pattern the 2026-09-30 decision forbids. |
| C | Watcher only, no per-trade agents (watcher reads raw positions). | Fastest to build; the watcher drowns in raw data with 8–10 trades and has no per-trade memory. Owner asked for per-trade agents. |

## 5. Design (approach A)

### 5.1 Layers and authority

```
 L0  Owner            kill switch · HOLD list · daily max loss · manual Exit now      (always wins)
 L1  Risk Wall / hard rules   daily max loss · position caps · catastrophe floor (broker stop)
 L2  Supreme watcher   day-level: pause entries · stricter judge · tighten all · lock profit · close all
 L3  Trade agents      one per open trade: hold · tighten · take profit · exit
 L4  Level executor    deterministic, per tick: fires the pre-set levels from L2/L3
```

Rules: a higher layer overrides a lower one; **close beats hold**; **tighten beats loosen**; no layer
above L0 can open a trade, add size or loosen a stop. A held (HOLD-list) position is reported but never
acted on by L2–L4.

### 5.2 Level executor (L4) — fast moves

- Every live trade carries a **level book**: ordered rules like `EXIT if LTP ≤ x`, `EXIT if underlying
  ≤ y`, `MOVE STOP to z if LTP ≥ w`, each with its author (agent / watcher) and time.
- Evaluated on every feed tick for the contract and its underlying (market hub ticks, in memory).
  Firing places the exit through the existing `sentinel-executor` path (same guards, HOLD, caps, audit).
- Target: tick → order sent < 500 ms (CLAUDE.md latency budget).
- After a level fires, the owning agent is woken to re-plan.
- Levels can only move in the protective direction once set (existing "REJECTED LOOSENS" rule).

### 5.3 Catastrophe floor (L1) — replaces the flat ₹2,000

- A real **STOPLOSS-LIMIT order rests at Angel** for every live F&O/MCX trade (turn `FLOOR_BROKER_SL`
  from shadow to live, placed at the catastrophe floor, not the noise floor).
- Floor distance per instrument = max(K × the instrument's 15m noise unit, the existing per-underlying ₹
  cap), K starting at 3 (to be fixed from the shadow data). This sits outside normal wiggle, so it fires
  on failure or a gap, not on noise (the GOLDM case).
- The flat `HARD_LOSS_EXIT_RUPEES` code exit stays as a second backstop at the same distance (works if the
  broker order is rejected).
- Every floor fire is graded nightly: "should the trade agent have exited first?" — a fire is a defect
  in L2/L3, not a normal exit.
- Gap risk: a stop-limit can gap past its limit; the existing backstop market exit stays.

### 5.4 Trade agent (L3) — one per open trade

- Created when a tracker opens (any source: signal, entry engine, manual); ends when it closes.
- **Memory** (persisted, restart-safe, table `trade_agent_state`): entry reason + judge reasons, the
  plan, levels touched, every previous decision with its reason, the current level book.
- **Cycle**: wakes on a schedule (every 2–5 min, by volatility) and on events (level near, giveback,
  volume spike, news, watcher order). Builds the packet the sentinel builds today + its memory.
- **Outputs**: a decision (HOLD / TIGHTEN / TAKE_PARTIAL / EXIT_NOW) and a **level book update**
  (pre-decided exits for the next fast move), and a **report** to the watcher:
  `{ tracker, pnl, thesis: INTACT|WEAKENING|BROKEN, nextRisk, levels, confidence, lastDecision }`.
- Model: Opus at high effort for triggered looks, Sonnet for routine (as today), on the trading agent
  with its own concurrency (raise trading reserve 6 → 12).
- Built by evolving `SentinelCycleService` (per-tracker cycle already exists); not a parallel system.

### 5.5 Supreme watcher (L2)

- One instance, Opus at high effort, on its own reserved slot (never starved by trade agents or reader).
- **Sees**: every trade agent's latest report; today's P&L path (realised + open, peak, drawdown from
  peak); every Telegram call + judge verdict + skip reason today; verified market notes (message reader);
  entry-engine decisions; agent/feed/broker health; HOLD list; time to close; the day's caps used.
- **Wakes**: every 5 min in market hours, and immediately on events — a trade closes, P&L drawdown from
  the day's peak crosses a threshold, a losing streak (N losers in a row), a CONTRADICTED market note on
  an open trade's underlying, an agent missing its heartbeat.
- **Orders** (each with reason + the numbers behind it, stored and shown):
  `PAUSE_ENTRIES{scope, until}`, `STRICTER_JUDGE{minConfidence, until}`, `TIGHTEN_ALL{to}`,
  `LOCK_PROFIT{floorRupees}`, `CLOSE_ALL`, `CLOSE{tracker}`, `RESUME`.
  Entry pauses are enforced in `signal-trader` and the entry engine as a gate check; tighten/close go to
  the level executor / executor.
- It can never: open, add, loosen, change L0/L1 limits, or act on a HOLD position.
- **Day memory**: the watcher keeps a running day log (its own decisions and why) and reads yesterday's
  night review at start of day.

### 5.6 Many at once

- Signal calls: each evaluation runs as its own task (today they run one after another through a serial
  queue); per-underlying lock only, so two calls on different instruments never wait on each other.
- Capacity per job class (Vertex, owner-approved raise): signal judge 6, trade agents 12, watcher 1
  reserved, message reader 8, background 4. Global limiter raised accordingly.
- Each layer degrades safely: watcher down → trade agents continue; trade agent down → level book +
  catastrophe floor still protect; AI down entirely → broker stops + hard backstop protect, entries pause
  automatically (no AI = no new risk).

### 5.7 Reliability and visibility

- Heartbeats: every agent and the watcher write a heartbeat; a missing heartbeat (> 2 cycles) wakes the
  watcher and raises an ops alert; > 3 cycles with an open trade → that trade's level book is tightened
  to cost by code.
- Every decision is timed (like the signal-trader timings) and stored with its packet.
- **Desk screen** (web): one row per open trade (agent's line, P&L, levels, last decision), the watcher's
  current orders and reasons, today's P&L path with peak and drawdown, health.
- Night review grades: every watcher order (what the day would have been without it), every agent exit vs
  holding, every catastrophe-floor fire.

### 5.8 Rollout

1. **Broker catastrophe floor live** first (smallest change, biggest safety gain), after one more week
   of shadow comparisons at the wider K distance.
2. Trade agents + level executor in **shadow** (decide + report, sentinel still acts) → graded 1 week.
3. Trade agents **on** (replace the sentinel cycle).
4. Watcher in **shadow** (orders recorded, not enforced) → graded against each day for 1–2 weeks.
5. Watcher **on**, starting with PAUSE_ENTRIES / STRICTER_JUDGE / TIGHTEN_ALL; CLOSE_ALL / LOCK_PROFIT
   enabled last.
Each step needs the owner's OK after its graded report.

## 6. Decided by the owner

- A supreme watcher above everything, AI-driven, no emotion, decides from verified data to protect the day.
- One AI agent per active trade, reporting to the watcher.
- Must handle fast moves, many calls and trades at once, fast and reliable.
- Token cost is not a constraint; Vertex capacity may be raised.
- Reduce dependence on the flat hard rule (designed here as: AI manages inside a wider, smarter floor).

### Decided 2026-11-25 (owner: "yes go ahead with both")

- **Never open or add.** The watcher and trade agents can only cut, tighten, close. Entries stay with
  the signal judge and the entry engine.
- **Catastrophe floor per trade** = 3 × the instrument's 15m noise unit, in rupees for the contract,
  clamped to **min ₹2,000** and **max ceiling**: index options ₹5,000; stock options ₹3,000 (changed after the replay, see below);
  GOLD / SILVER ₹7,500; CRUDE / NATURALGAS / other MCX ₹5,000. Daily max loss and kill switch unchanged,
  above everything. First rollout step: replay the last month's live trades under the new floor
  (how many ₹2,000 cuts recovered; how many trades would have lost more) before it goes live.

## 7. Open for the owner
- Thresholds to start with (watcher wake + orders): drawdown from day peak (e.g. 40% of peak or ₹5,000),
  losing streak (e.g. 3 in a row), lock-profit level. Proposed defaults in the plan; owner may set them.
- Catastrophe floor K = 3 and the ceilings above are confirmed or adjusted after the replay report.

## 8. Calls made in this design (owner to check)

- Approach A: evolve the sentinel into trade agents (no parallel exit system).
- Broker stop goes live as a **wide** catastrophe floor, not the working stop (GOLDM −₹33,500 shadow case).
- Flat ₹2,000 replaced by an instrument-sized floor; daily max loss + kill switch unchanged.
- AI never on the fast-move critical path; ticks only execute pre-set levels.
- No AI = entries pause automatically.
- Watcher and agents can only cut, tighten, close — never open or add.
- Rollout in five shadow-first steps, each gated by a graded report and the owner's OK.

### Settled after the builder check (calls, owner to check)

- **One desk, owner's account only** (the AI exit path is already owner-allowlisted; personal MVP first).
  Tables carry `userId` so a later multi-user desk is a data change, not a redesign.
- **Profit-side code rules stay as code.** GREEN_TO_RED, FLOOR_BREAK_GREEN, HWM_UNDERLYING_MOVE and the
  trailed noise-floor stop become **code-owned entries in the level book**: a trade agent or the watcher
  may tighten them but never remove or loosen them. "Reduce dependence on the hard rule" applies to the
  flat ₹2,000 loss exit only. Green trades keep a code-enforced lock when the AI is slow or down.
- **Missed heartbeat** (agent silent > 3 cycles): pause new entries for that underlying, raise an ops
  alert, and tighten a **green** trade's level book to cost. A **red** trade is left on its catastrophe
  floor (tightening to cost would close it at once). An AI-wide outage therefore pauses entries and
  locks green trades, but does not dump red ones.
- **TAKE_PARTIAL is out of v1** (signal trades are 1 lot; no partial-exit path exists). Decisions are
  HOLD / TIGHTEN / EXIT_NOW.
- **Capacity**: size every pool to the measured Vertex quota (first build step: a quota probe). Priority
  under contention: trade agents > watcher > signal judge > message reader > background. The 31-slot
  figure in §5.6 is the target, not an assumption.
- **The AI exit daily cap (15)** keeps limiting AI-initiated exits by trade agents, but **can never block
  a protective exit**: level-executor fires, catastrophe-floor fires and watcher CLOSE / CLOSE_ALL / TIGHTEN
  are counted separately and never refused by the cap.
- **"The day" spans NSE and MCX** on the IST calendar day; the watcher runs 09:00–23:30; streak / peak /
  drawdown count both. The deploy rule stays: no deploy while any trade agent holds an open position.
- **L4 extends the existing `TriggerBook`** (`sentinel-executor/services/trigger-watch.service.ts`, market
  hub price stream, tighten-only) rather than adding a new executor.

## 9. Left to the builder

Exact schemas (`trade_agent_state`, `watcher_orders`, `watcher_day_log`, level book), prompts, wake
thresholds' code shape, the desk screen layout, how signal-trader's serial queue becomes per-underlying
locks, migration of the sentinel cycle, test strategy (replays of 11-09, 11-13, 11-18, 11-20 as golden
days for the watcher).

### Replay result and final ceilings (owner 2026-11-25: "go with the recommendation")

Replay of 194 live trades, last 30 days (188 manual, 6 signal; HOLD excluded), 15m bars:
today's rule −₹56,330; new floor with stock options at ₹5,000 −₹52,222 (+₹4,109); with stock options at
₹3,000 **−₹48,402 (+₹7,929)**. By class: GOLD +₹5,008, MCX +₹2,654, index options +₹711, stock options
−₹4,265 at ₹5,000 / −₹445 at ₹3,000. 156 of 194 trades never reach the floor. Limits: one month; AI exits
after the real exit and the 11-23 chart gate not modelled; 15m resolution.

**Final ceilings:** INDEX_OPT ₹5,000 · STOCK_OPT ₹3,000 · GOLD/SILVER ₹7,500 · other MCX ₹5,000; band 3×N15
from ₹2,000. Env: `HARD_LOSS_CEILING_BY_CLASS=INDEX_OPT:5000,STOCK_OPT:3000,GOLD:7500,SILVER:7500,MCX:5000`.

**Broker stop live is blocked** until owner resting orders can no longer cancel/block it (executor
`OTHER_OPEN_ORDER`); same root as the resting-order exit fix (SENSEX 11-25).

**Minis (owner 2026-11-25):** GOLDM / SILVERM ceiling **₹4,000** (full GOLD / SILVER stay ₹7,500). Table:
`HARD_LOSS_CEILING_BY_CLASS=INDEX_OPT:5000,STOCK_OPT:3000,GOLD:7500,SILVER:7500,GOLD_MINI:4000,SILVER_MINI:4000,MCX:5000`.
