# Trade agent exit authority — design

Date: 2026-11-27 · Owner decisions in this conversation · Status: draft for owner approval

## 1. Intent (owner's words, summarised)

The desk was meant to be simple: the **supreme agent** (desk manager) finds and opens trades and puts
**one agent on each open trade**. That agent's only job is to manage its trade properly, save money and
close it in green. It verifies everything before it decides. Over time ~10 code rules were added that
sell a trade on their own (price trigger, floor, green lock, ladder/trail, hard loss, carry fallback,
target lock, broker stop). They have different exceptions, the chart check covers some and not others,
and the owner can no longer tell why a trade was closed. Example: 27 Nov BHARATFORG 1800CE was sold by
a PRICE_TRIGGER 1.3 points from price, with no chart review.

Owner decisions:
- The **trade agent is the only one allowed to close, book or hold**. Before it does, it **syncs with the
  supreme agent**, which holds the knowledge and skills (and gets improved over time).
- **No automatic sell at all.** Code never sells on its own — with exactly two owner-approved exceptions
  (§4.5a): the hard-loss limit when the AI and the owner are both unreachable, and the broker deadline.
- AI outage (as on 6–7 Nov, ~42 h) must be handled: **A + B** — (A) a backup chain of AI routes, and
  (B) if every route fails, or an alarm is unanswered ~2 min, the owner gets a Telegram alert with
  one-tap Exit / Hold.
- Build approach **1**: the existing sentinel becomes the trade agent (not a rewrite).

## 2. Goals, non-goals, anti-goals

Goals
- Every live exit/book of a manager or signal trade comes from a trade-agent decision (confirmed or
  overridden by the supreme), or from the owner. One place to look for "why was this closed".
- Code rules still watch the trade, but as **alarms** that wake the trade agent immediately with fresh
  chart data and the rule's reason.
- The agent never goes silent unnoticed: failover between AI routes, and owner escalation.

Non-goals
- No change to entries, the entry guard (drawdown/day-loss/streak block NEW trades), lot size, or the
  signal judge.
- No new ML/strategy. The agent's judgement is the existing sentinel prompt + packet, plus the supreme's brief.
- Paper trades: keep today's behaviour (paper rules may still close paper trades).

Anti-goals (a failure even if it "works")
- An alarm that silently does nothing (the app's known failure shape): every alarm must end in an
  agent decision, an owner alert, or a logged reason.
- A trade left unmanaged while losing with nobody told.
- Slower exits through needless calls on every routine HOLD.

## 3. Today (inventory, 27 Nov)

All sentinel-family broker calls go through `SentinelExitExecutor`. Live sellers without an LLM
decision for that exit:

| # | Path | Reason strings | Becomes |
|---|---|---|---|
| 1 | `sentinel-cycle` `recordHardFloorExit` (synthetic EXIT_NOW) | FLOOR_HARD_EXIT / MAX_LOSS (HARD_LOSS_EXIT_RUPEES=2000) | alarm (urgent) |
| 2 | `sentinel-cycle` `rescueHardLoss` (pass stuck/timed out) | MAX_LOSS fast guard | alarm (urgent) + escalation |
| 3 | `sentinel-cycle` `hardFloorFor` | GREEN_TO_RED, FLOOR_BREAK_GREEN, HWM_UNDERLYING_MOVE | alarm |
| 4 | `sentinel-cycle` `ladderExitFor` | TARGET_LADDER / TARGET_TRAIL / profit lock | alarm (profit) |
| 5 | `intraday-carry` `recordExit` | EXPIRY_DAY, NO_JUDGEMENT, CARRY not confirmed | alarm with a deadline |
| 6 | `trigger-watch` fire (ExitTrigger PRICE_TRIGGER, never gated) | PRICE_TRIGGER; levels from sentinel, signal SL, desk TIGHTEN, desk target-lock, desk initial stop | alarm |
| 7 | `floor-broker-sl` resting broker SL (prod: shadow) | broker STOPLOSS-LIMIT | stays off live; removed from the live path |
| 8 | `manual-exit` (MANUAL, ungated) | owner button; **desk manager EXIT/BOOK** | owner: unchanged. desk: see §4.4 |
| 9 | legacy `trade-engine` closeTrade via watch-monitor / signal-review worker | target/SL/trail/score-decay/EOD, post-trade REJECT | verify inert in prod; hard-disable for live |
| 10 | legacy `order-tracker` auto STOPLOSS_MARKET at entry fill | broker SL | verify inert; hard-disable for live |

Also: the exit gate (chart confirm, thesis intact, persistence) currently can *block* AI EXIT_NOW.
The poller cannot tell an LLM EXIT_NOW from a code-rule EXIT_NOW (only `promptVersion`/reason prefix).
There is no per-trade wake today (`wakeForTick` wakes a user's whole pass, and suppression still applies).

## 4. Design

### 4.1 Roles
- **Supreme agent** (desk manager, Opus): opens trades; writes a **trade brief** for each trade it
  opens (lead/source, plan, levels, what would make it wrong, any skills e.g. "breakout re-entry",
  "expiry day — premium decays fast"); confirms or overrides the trade agent's EXIT/BOOK; can ask a
  trade agent to exit (§4.4).
- **Trade agent** (the sentinel's per-trade judge): the only one that decides HOLD / BOOK / EXIT /
  TIGHTEN for its trade. Reads the brief every look.
- **Code**: watches prices and rules and raises **alarms**; executes only confirmed decisions; escalates.
- **Owner**: always above all — the app's Exit button and kill switch keep working unchanged.

### 4.2 Alarms instead of sellers
Each former seller (#1–6) writes an **alarm** for the tracker instead of an EXIT_NOW / instead of firing
an order: `{trackerId, rule, reason, urgency: normal|urgent|deadline, deadline?, facts}`. An alarm:
1. wakes **that trade's agent now** (new per-tracker wake that skips the normal re-judge suppression,
   min gap ~20 s per tracker; alarms raised while a look is running are coalesced into it);
2. is shown in the agent's packet as "ALARM: <rule> — <reason>" plus a fresh chart read (5m/15m closes,
   VWAP, N15, Supertrend — the existing chart-read), so the agent verifies before deciding;
3. is closed by the agent's decision (any of HOLD/BOOK/EXIT/TIGHTEN), recorded on the alarm row.

A price trigger stays armed as an alarm level: when crossed (same 2-tick/1 s confirmation) it raises an
alarm instead of selling. Desk target-lock: raises an alarm instead of tightening on its own.
Rules #1–2 (hard loss) are `urgent`; #5 carries `deadline` = the broker's square-off time minus a margin.

### 4.3 The decision flow (sync with supreme)
1. Trade agent decides.
2. HOLD / TIGHTEN → recorded and applied at once (TIGHTEN arms an alarm level, never a seller).
   The supreme sees all positions and their latest agent calls in its own packet every run.
3. EXIT / BOOK → a short **confirm call** to the supreme with the agent's decision, reasons, alarm and
   brief. Supreme answers CONFIRM, OVERRIDE→HOLD (with a reason the agent sees next look), or adds an
   instruction to the brief. Timeout **30 s**: no answer → the agent's decision stands.
4. A confirmed EXIT/BOOK goes to the executor through the normal guarded path (open-order handling,
   owner hold list, lot/qty checks). The **exit gate no longer blocks**: its chart/thesis facts go into
   the agent's packet instead (the agent decides; the gate's record is kept for review).
5. Disagreement rule: the **supreme wins** (it is the supreme).

### 4.4 Supreme-initiated exits
Today the desk manager's EXIT/BOOK goes straight to `manual-exit`. New: it becomes an **instruction
alarm** to the trade agent ("supreme asks EXIT: <reason>"). Because the supreme wins disagreements, the
agent may add its view but the exit proceeds unless the agent returns a stronger reason within its look;
that reason goes back to the supreme once (one round, no ping-pong).

### 4.5 Outage handling (A + B)
A. **AI route chain** for both the trade agent and the supreme: Vertex → server CLI, per call, with a
   health tracker so a route failing repeatedly is skipped for a few minutes. Built so a third route
   (direct Anthropic API) is added by setting `ANTHROPIC_API_KEY`; no key is on prod today (Vertex uses
   Google Cloud credentials, not an Anthropic key).
B. **Owner escalation** via Telegram, when:
   - all routes fail for a trade look that an alarm is waiting on, or
   - any alarm is unanswered for **2 min** (sooner for `urgent`: 60 s), or
   - a `deadline` alarm is within 10 min of its deadline with no decision.
   The message shows trade, P&L, the alarm and the agent's last view, with **Exit** / **Hold** buttons.
   Exit goes through the owner path (same as the app's Exit button). Hold silences that alarm for 15 min.
   Repeats every 5 min while unresolved; one message per trade (edited, not spammed).
   Requires the owner to create a Telegram bot and set `TELEGRAM_ALERT_*` (not configured on prod today).
- Telegram is **required**: `TRADE_AGENT_AUTHORITY=live` refuses to start (falls back to `off`, loud
  ERROR) unless the Telegram alert bot is configured and a test message succeeded at boot.

### 4.5a The only code sells left (owner decisions, 27 Nov)
1. **Hard-loss backstop, only when everyone is unreachable.** If every AI route is down (or the agent has
   not answered an `urgent` alarm) AND the owner has not answered the Telegram alert for **10 min**, AND the
   trade is past today's **hard-loss limit** (the existing per-trade limits: HARD_LOSS_EXIT_RUPEES ₹2,000,
   the per-underlying values and class ceilings, as configured today) → code exits. In normal operation
   the agent always decides; this path should almost never run, and each time it does the owner is told.
2. **Broker deadline.** A `deadline` alarm (Angel intraday square-off ~15:20 / contract expiry) with no
   agent decision by **deadline − 2 min** → code exits, so Angel's square-off at the bell never happens.
   The 10-min-before Telegram warning stays.

### 4.5b Owner's resting order blocks a confirmed exit
Never cancel the owner's order. A confirmed EXIT/BOOK that hits `OPEN_ORDER_EXISTS` → immediate Telegram
alert (trade, P&L, the resting order, the agent's reason) with **Exit** (owner path, which cancels it) /
**Hold**; repeats every 5 min while the block stands.

### 4.6 Switch and rollout
- One flag `TRADE_AGENT_AUTHORITY=off|live` (off = today's behaviour, so rollback is one env change and
  a container recreate).
- Every alarm records what the old rule would have done, so after a few days we can compare
  "old rule sold at X" vs "agent decided Y, price later Z" without a separate shadow phase.
- Push only with the owner's OK and not while an open-position decision is pending (push = deploy).

## 5. Approaches considered
1. **Sentinel becomes the trade agent; sellers become alarms; supreme confirms EXIT/BOOK** — chosen.
   Smallest change: agent, packet, chart read, executor and supreme exist and are tested; the work is
   the wiring, the per-trade wake, the confirm call, failover and escalation.
2. New per-trade agent module under the supreme, sentinel retired — cleaner names, but a rewrite of the
   most-tested part while live trades run; weeks, not days.
3. Supreme manages every trade itself, no per-trade agent — contradicts the owner's model; one big
   call gets slow with many positions.

## 6. Constraints
- Alarm → order latency: agent look ~10–30 s + confirm ≤30 s. Accepted by the owner's "no auto sell".
- Angel's own intraday square-off and expiry are outside our control → `deadline` alarms.
- Never log credentials; Telegram tokens live in api.env only.
- 15m is the smallest analysis unit (owner rule); the alarm's chart read uses closed 5m/15m bars + N15.

## 7. Calls made by Claude (owner can change)
- Routine HOLDs are not sent to the supreme for confirmation (cost and speed); only EXIT/BOOK are.
  The supreme still sees every HOLD in its regular run.
- Confirm timeout 30 s; escalation 2 min (60 s urgent); Hold-silence 15 min; repeat 5 min.
- The exit gate turns from blocker into packet facts.
- Paper trades keep today's rules.
- Broker-side floor SL (#7) stays out of the live path; legacy silo paths (#9, #10) are made unable to
  sell live.

- Supreme confirm = a separate one-off call with the supreme's system prompt/knowledge and the trade's
  packet + brief (not a request into the running manager cycle), so it answers within 30 s.
- Coverage: every LIVE trade the sentinel follows (manager, signal, owner-placed, MCX) except the owner
  hold list. Trades without a brief (signal/owner/pre-deploy) get one from the supreme at its next run;
  until then the agent works without one.
- Re-alarm: while a held alarm's condition stays true, re-raise only when the trade is ≥1 N15 worse, or
  every 5 min (2 min for `urgent`).
- §4.4: the agent gets one look on a supreme exit request; a HOLD reason goes back to the supreme once
  and its answer is final; if the agent's look fails or takes >60 s, the exit goes ahead.

## 8. Left to the builder
Alarm table shape, the per-tracker wake mechanics, prompt wording for alarms/brief/confirm, Telegram
bot transport (webhook vs polling), how alarms map onto existing verdict/execution rows, test layout.
