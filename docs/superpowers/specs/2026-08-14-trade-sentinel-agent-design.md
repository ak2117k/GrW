# Trade Sentinel — Agentic Exit Monitor for Open Angel One Trades

**Date:** 2026-08-14
**Status:** Design approved in brainstorm; awaiting spec review before planning
**Module:** `apps/api/src/modules/trade-sentinel/` (new)
**Supersedes the open question in:** `docs/handoffs/2026-08-13-reverse-trade-detection-discovery.md`

---

## 1. Purpose

Give every open Angel One position a continuous, judgment-based watcher — one that
reads the live market the way a human would (price structure, OI, volume, FII/DII,
news, chart patterns) rather than scoring it against tuned numeric thresholds, and
closes the trade when it turns.

The previous application solved this with weighted numeric factors. The results were
not convincing. This design deliberately keeps numbers as **sensors and as hard safety
limits**, but removes them from the **decision seat**, which is handed to an LLM agent
reasoning over assembled evidence.

### The mandate, in one paragraph

Watch every open trade continuously using the full live picture. When the trade is in
profit beyond charges, defend that profit and exit green when the read turns. When the
trade is not in profit, keep working it — but close it on either the hard max-loss
limit, or a judgment that recovery is no longer realistically available.

### Non-goals

- The sentinel **never opens, adds to, averages down, or re-enters** a position. Its
  entire vocabulary is "exit or don't."
- It does not replace `watch-monitor`'s trailing stops or the `*-track` decision gates.
  Overlap policy is defined in §11.
- It does not close **holdings** (portfolio). It observes and explains them only.
  Close authority for holdings is a deliberately deferred decision.

---

## 2. Scope

| Subject | Watched | Close authority |
|---|---|---|
| Angel One open **positions** (manual or platform-opened) | Yes | **Yes** |
| Angel One **holdings** / portfolio | Yes (observe + explain) | **No — deferred** |
| Concurrent watched positions | **Max 5** | — |

**Over the cap:** a 6th position is listed as `UNWATCHED` with a prominent alert (UI
banner + Telegram). It is never silently ignored. Policy for handling more than 5 is an
explicitly deferred decision, not an oversight.

**Second broker:** out of scope. See §12.

---

## 3. Architecture

New NestJS module following the standard project module pattern. It **consumes**
`market-data`, `options-chain`, `news`, `signal-generator`, `trade-tracker`; it **calls
into** `trade-engine` to execute. It owns no data path that already exists.

```
trade-tracker poller (already running)
   │
   ▼
RosterService ──── selects ≤5 watched positions; holdings marked observe-only
   │
   ▼
TripwireService ── pure functions, one file per sensor:
   giveback-off-peak · level-break · oi-wall-shift ·
   volume-anomaly · news-hit · context-factor-flip
   │  (sensors only — they never decide)
   ├─ nothing fired and no heartbeat due ──▶ stop. Zero cost.
   ▼
ContextPacketService ── assembles the evidence bundle (§5)
   │
   ▼
SentinelAgentService ── LLM judgment ──▶ structured verdict (§6)
   │                     (pure function: evidence in, verdict out — no I/O, no tools)
   ▼
ExitExecutorService ── pre-flight gates · veto window · re-validate · order (§7)
```

### 3.1 Three invariants

1. **Tripwires are sensors, never judges.** They are pure, unit-testable functions
   returning "something changed, here is what." They are *allowed to be noisy* — their
   only job is "look at this," not "sell this." This is the mechanism by which
   thresholds stay out of the decision.
2. **A heartbeat runs regardless of tripwires.** Every watched trade gets an agent look
   on a slow timer, so a quiet grinding bleed cannot hide beneath every sensor's
   sensitivity.
3. **The agent never touches the broker.** It receives a packet and returns a verdict.
   No tools, no I/O, no order access. This makes it replayable and backtestable, and it
   places the hard risk limits *outside* the agent where they hold even if the agent
   malfunctions entirely (CLAUDE.md §9).

### 3.2 Proposed file layout

```
modules/trade-sentinel/
├── controllers/
│   └── sentinel.controller.ts          # list, veto, correct thesis, history
├── gateways/
│   └── sentinel.gateway.ts             # push verdicts + exit announcements to UI
├── services/
│   ├── roster.service.ts               # which ≤5 positions are watched
│   ├── tripwire.service.ts             # runs the sensors, aggregates fires
│   ├── context-packet.service.ts       # assembles evidence
│   ├── thesis.service.ts               # infer / store / correct entry thesis
│   ├── sentinel-agent.service.ts       # LLM call + schema validation
│   ├── challenge.service.ts            # adversarial second opinion (§6.4)
│   └── exit-executor.service.ts        # gates, veto window, order, state machine
├── tripwires/
│   ├── giveback-off-peak.tripwire.ts
│   ├── level-break.tripwire.ts
│   ├── oi-wall-shift.tripwire.ts
│   ├── volume-anomaly.tripwire.ts
│   ├── news-hit.tripwire.ts
│   └── context-factor-flip.tripwire.ts
├── repositories/
│   ├── sentinel-verdict.repository.ts  # verdicts + their packets
│   ├── sentinel-thesis.repository.ts
│   └── exit-intent.repository.ts       # persisted state machine
├── dto/
├── charges.ts                          # charge model + green floor math (pure)
└── trade-sentinel.module.ts
```

### 3.3 Open item — where the LLM call lives

Two options, to be settled during planning:

- **Directly from NestJS** (recommended) — removes a network hop on a latency-sensitive
  path and keeps the verdict close to the executor.
- **Via `ai-engine/`** — follows existing precedent (`telegram_parser_service.py`
  already calls Anthropic; `ANTHROPIC_API_KEY` is in `.env.example`), keeping all model
  access in one service.

Recommendation: NestJS for the live path, leaving `ai-engine` for batch/ML work.

---

## 4. The entry thesis

"Reversed" only has meaning relative to an expectation. Platform-opened trades have
their thesis on record. Manually placed trades appear as a bare position — symbol,
quantity, price — with no stated intent. Identical price action can confirm one thesis
and destroy another (a drop back into a range kills a breakout buy and *is* the setup
for a mean-reversion buy).

**Decision: the agent infers, and the user can correct.**

- On first sighting, the agent reads the chart at the entry price/time and states the
  thesis it believes was acted on: direction, the level acted from, the invalidation
  point, the apparent target.
- It renders this on the chart immediately and begins watching. **Nothing is ever
  unwatched pending user input.**
- One tap corrects it (UI or Telegram). Corrections are stored and are high-value
  feedback data.

---

## 5. The context packet

A single serialisable object assembled fresh per evaluation. It is the **only** thing
the agent sees.

| Block | Contents | Source |
|---|---|---|
| **Position** | symbol, instrument type, side, qty, entry price & time, expiry, lots | `trade-tracker` |
| **Money** | gross P&L, estimated charges, **net** P&L, green floor, MFE/MAE since entry | `computeTickPatch` (`holdingHigh`/`holdingLow`) + `charges.ts` |
| **Thesis** | inferred or corrected: direction, reason, invalidation level, target | `ThesisService` |
| **Structure** | nearest S/R + strength, trend fit, projection band, multi-timeframe alignment | `level-book.service`, `chart-context.service`, `strong-zone-detector`, `mtf-trend.factor` |
| **Flow** | volume vs average, OI + wall positions & shifts, greeks, IV | `oi-wall.service`, `oi-shift.factor`, `greeks.factor`, `volatility.factor` |
| **Macro** | FII/DII, sector behaviour, global cues | `fii`, `sector`, `nasdaq`, `gold`, `crude-oil` factors |
| **News** | recent items for symbol and sector | `modules/news` |
| **Session** | time to close, time to expiry, known session effects | `market-holidays`, clock |
| **Trigger** | which tripwires fired, with their evidence | `TripwireService` |
| **Memory** | this trade's own prior verdicts | `sentinel-verdict.repository` |

### 5.1 Four rules

1. **Digested, not raw.** "Volume 2.3× the 20-day average, concentrated in the last 15
   minutes" — not a candle array. Numbers become *facts about the market*, which is what
   a human reasons over, and it keeps the packet within a sane token budget.
2. **Every field carries a timestamp and a source.** Stale data must be visibly stale.
3. **Missing data is present in the packet as an explicit absence.** Never a silent zero
   or a quiet omission. This follows the convention established by commit `34e1268`
   ("make missing OI walls say why instead of failing silently"). The risk is sharper
   with an LLM: given a packet whose OI block is quietly absent, it will not say "I
   cannot see OI" — it will reason fluently and confidently from the blocks it *can*
   see.
4. **The packet is stored verbatim alongside its verdict.** This is what makes the agent
   replayable, diffable and backtestable.

### 5.2 Why "Memory" is in the packet

Without the trade's own prior verdicts, each evaluation is an independent opinion and
the agent will say HOLD at 10:15 and EXIT at 10:16 on near-identical data. Showing it
its own recent reasoning forces it either to stay consistent or to state explicitly what
changed — and "what changed" is exactly the signal worth having.

---

## 6. The exit decision

### 6.1 Verdict schema

The agent returns a structured object, never prose. Responses are schema-validated;
malformed responses are rejected and retried.

```
verdict:            HOLD | EXIT_ARMED | EXIT_NOW | ESCALATE
confidence:         low | medium | high
thesisStatus:       INTACT | WEAKENING | BROKEN
recoveryAvailable:  boolean (+ rationale)
reason:             one human sentence
evidence:           [cited packet fields]
invalidationPoint:  what would prove this verdict wrong
reviewIn:           seconds until next look
```

Two fields are non-negotiable:

- **`evidence` must cite actual packet fields.** A verdict that cannot point at what it
  saw is rejected as malformed. This makes hallucinated reasoning structurally difficult
  rather than merely discouraged.
- **`invalidationPoint`** forces the agent to commit in advance to what would change its
  mind. It is both the best available check on sloppy reasoning and precisely what gets
  rendered on the chart.

### 6.2 Green trades — the floor is a rule, the upside is judgment

This is how "exit in green including charges" is honoured without returning numbers to
the driver's seat. The **guarantee** is separated from the **optimisation**:

- **The floor is arithmetic and lives in the executor.** Once net P&L — after
  brokerage, STT, exchange fees, GST and stamp duty — clears the floor by a configured
  margin, the floor **arms and ratchets**. From that point the trade cannot return to
  red. No judgment, no agent vote; a hard backstop like max-loss.
- **Everything above the floor is the agent's call.** It decides when the read has
  turned and the profit should be taken, rather than riding it back down to the floor.

The green outcome is therefore guaranteed mechanically; the *size* of the green is what
the intelligence is for.

### 6.3 Red trades — two independent exits

Below the floor the agent keeps working the trade. Only two things close it:

1. **Max loss** — hard, executor-enforced, no agent vote (CLAUDE.md §9).
2. **"Recovery no longer available"** — pure judgment, gated as in §6.4.

### 6.4 The "recovery not available" gate

The most dangerous call in the system, because it is **permanent**: it realises the loss
and removes all optionality. A wrong HOLD is recoverable — the next evaluation is
seconds away. Decisions with asymmetric reversibility get asymmetric scrutiny.

It requires **all** of:

- `thesisStatus: BROKEN`
- `confidence: high`
- an explicit rationale
- a **challenge call** — a second, independent agent instance given the same packet and
  asked to argue the *opposite*: make the strongest case that this trade still recovers.
  The exit fires only if the challenger also fails to find one.

The challenger is briefed adversarially rather than asked to "double-check," because a
model shown a conclusion and asked to verify it tends to agree; you get confirmation,
not review.

Objective decay counts as legitimate evidence: an option hours from expiry and far OTM
genuinely has no recovery path, and that is arithmetic, not opinion.

### 6.5 Anti-flip-flop

- `EXIT_NOW` fires immediately on `high` confidence.
- `medium` confidence returns `EXIT_ARMED` — "one more confirmation and I go" — which
  shortens `reviewIn` rather than acting.

This keeps the agent fast on genuine breaks without letting it oscillate on noise.

---

## 7. Veto window & execution

### 7.1 Flow

```
EXIT_NOW
   │
   ▼  pre-flight gates (executor, agent-independent)
   │   kill switch off? · market open? · position still exists?
   │   qty unchanged? · no exit already in flight?
   ▼
ANNOUNCED ── Telegram (inline Veto button) + UI banner + chart marker
   │          countdown, default 30s, configurable
   ├── user vetoes ──▶ VETOED (+ cooldown, + stored as feedback)
   ▼  window expires
RE-VALIDATE ── re-check every gate; the world moved during the window
   │
   ▼
PLACED ──▶ FILLED | PARTIAL | FAILED
```

**Re-validation at fire time is mandatory.** Thirty seconds is long in a reversal: the
position may have been closed manually in the Angel One app, price may have run past the
level, the kill switch may have been hit. The countdown *authorises* the exit; it does
not blindly schedule it.

### 7.2 What the veto covers

Judgment exits get a veto window. **Mechanical backstops do not** — max-loss and the
armed green floor fire immediately and notify after the fact. These are the §9 limits
that automation may not override, and a limit that can be talked out of is not a limit.

A veto **suppresses re-fire for a cooldown**; otherwise the same tripwire re-fires
seconds later and the user spends the session vetoing one trade. Every veto is stored
**with its context packet** — the highest-value feedback the system will produce: a
labelled example of the agent being wrong in a situation the user judged well enough to
intervene in.

### 7.3 Order mechanics

Reuses `trade-engine`: `TradeExecutionService`, `order-tracker.service`, and
`paper-trade.service` for shadow/paper mode — the same code path in both.

- **Limit order with a slippage cap, escalating to market if unfilled.** On illiquid
  option strikes a naive limit can sit unfilled while price walks away — an exit that
  never happened but looks successful. A raw market order can fill badly on a wide
  spread. Escalation gets both properties.
- **Partial fills are a first-class state.** Remaining quantity stays watched with the
  exit intent live; the agent is told it now manages a reduced position.
- **Failures are loud.** Rejected order → alert, bounded retry, then escalate to the
  user. Never a swallowed exception: an exit that silently failed is worse than no agent
  at all, because the user believes they are flat when they are not.

### 7.4 Persistence and crash recovery

The exit intent is a **persisted state machine**, not an in-memory timer. If a 30-second
veto window lives in a `setTimeout`, a crash inside that window loses the exit silently:
no order, no error, no record, and a live position nobody is watching.

Each transition is persisted so the executor can resume on boot and determine whether an
exit was ever placed — CLAUDE.md §9's graceful-recovery rule applied where it matters
most. Idempotency requires distinguishing "I placed this" from "I was about to place
this"; getting it wrong means recovery re-sends an exit that already filled, leaving the
user **short a position they meant to close**.

---

## 8. Chart overlay

The agent's read renders on the stock chart so the user can see *what it sees*, not only
what it concluded. It reuses existing chart primitives — zone boxes, the projection band,
the direction arrow (`dad25ff`, `5b287cf`, `8f2aada`) — rather than adding a parallel
drawing layer.

| Layer | Renders | Default |
|---|---|---|
| **Entry** | fill price and time, net-of-charges P&L | on |
| **Thesis** | the level acted from, direction, target, invalidation line; one tap to correct | **on** |
| **Green floor** | charge-adjusted breakeven; once armed, a locked ratcheting line | **on** |
| **Max loss** | the hard backstop | on |
| **Verdict trail** | a marker per evaluation (HOLD/ARMED/EXIT); hover for reason + evidence | off |
| **Tripwires** | ticks where sensors fired — what woke the agent | off |

Plus a live panel: current verdict, confidence, thesis status, invalidation point, and
countdown to next look — with the **Veto button inline on the chart** during an announced
exit, so the user can act on the same screen where they are forming a judgment.

Six overlays on top of the level book and projection band is unreadable, and an
unreadable overlay is worse than none because it teaches the user to stop looking. Hence
the defaults above.

### 8.1 Transport and contracts

`sentinel.gateway` pushes live verdicts over WebSocket; REST serves history. All DTO
additions are **additive and optional** — `TradeTrackerDto`
(`apps/api/src/modules/trade-tracker/dto/trade-tracker.dto.ts`) is documented as a hard
frontend contract whose field names and types must not drift.

### 8.2 Why the verdict trail matters

It turns the chart from a monitor into a **review instrument**. Scrubbing back through a
session shows the agent's reasoning history laid against the price that actually
happened — "it armed here and was right; it held there and that cost money." That is the
loop that makes the next version better, and it is nearly free once verdicts are already
persisted with their packets.

---

## 9. Safety

Enforced in the executor, independent of any verdict:

| Limit | Detail |
|---|---|
| **Kill switch** | Always accessible, squares off everything, outranks all logic |
| **Max loss per trade / per day** | Follows the `RiskGuardService` pattern in `watch-monitor` (₹60,000 daily breaker, EOD square-off 15:25 IST) |
| **Watched cap** | 5; the 6th is `UNWATCHED` + alerted, never silently dropped |
| **Close authority** | Positions only; holdings observe-and-explain |
| **Direction of action** | Close only. Never open, add, average, or re-enter |
| **LLM cost ceiling** | Daily spend cap; on breach, degrade to notify-only rather than going blind |
| **Rate limits** | Angel One ≤10 req/sec respected via existing `angel-throttle.ts` |

---

## 10. Testing

### 10.1 Deterministic layers — ordinary TDD

The bulk of the system is normal testable code: tripwires (pure functions), the charge
and green-floor math, the exit state machine, and every executor gate. Test-driven
development applies throughout.

### 10.2 The agent layer

- **Golden packets.** A fixture library of real recorded context packets with known
  outcomes. Tests assert **properties, never prose**: "given `thesisStatus: BROKEN` and
  high confidence, the verdict must be an exit"; "the response must validate against the
  schema"; "every verdict must cite at least one real packet field."
- **Replay harness.** Because packets are persisted, historical packets can be re-run
  against a changed prompt or model and the verdicts diffed. Direct precedent: `322a21f`
  built this kind of accuracy harness for S/R levels.
- **Consistency and honesty probes.** The same packet twice must yield the same verdict.
  A packet with the OI block marked unavailable must produce an agent that *says* it
  cannot see OI rather than confabulating around the hole.

### 10.3 Metrics — judged against a baseline

"Exits green 80% of the time" is meaningless alone; a coin-flip exit at breakeven scores
well. The comparisons that matter are versus **holding to EOD** and versus the existing
**adaptive-stop** logic.

Tracked: green-exit rate net of charges · giveback from peak · veto rate · count of
exits that would have been better left open · agent cost per session.

---

## 11. Interaction with existing exit logic

`watch-monitor` (trailing stop, partial exit, risk guard) and the `*-track` modules
(`adaptive-stop`, `ungated`, `anand-dual`, `breakout-swing`, `sell-futures`) already
close trades they own. Two systems closing one position is a correctness hazard.

**Rule: one owner per trade.** A position already managed by `watch-monitor` or a
`*-track` module is watched by the sentinel in **observe-only** mode — it reasons and
renders, but the owning module retains close authority. The sentinel takes close
authority only for positions no other engine owns (i.e. manually placed trades, and
platform trades whose owning engine has released them).

Ownership is resolved in `RosterService` and displayed in the UI, so it is never
ambiguous who would close a given trade.

---

## 12. Deferred: second broker

A second broker account was considered as a way to raise data throughput. It is
**deferred to its own spec**, for three reasons:

1. **Execution cannot be split.** An Angel One position can only be closed through Angel
   One. A second broker can only ever be a read-only data plane — and the exit orders
   themselves, the one call that cannot move, are also the smallest traffic.
2. **Throughput is not the constraint.** With a cap of 5 watched positions and tripwires
   riding pollers that already run, the agent adds no broker calls. The ~50-token
   WebSocket ceiling bites when *scanning* hundreds of symbols for entries, not when
   monitoring five held positions.
3. **It is a product decision, not only an engineering one.** The feed is per-user; each
   user connects their own Angel credentials. "Add a second broker" means *every user
   must own and connect a second broker account*.

**But the seam is preserved.** The sentinel consumes a context-provider interface, not
`AngelOneAdapterService` directly — following `common/interfaces/broker-adapter.interface.ts`,
of which Angel One is currently the only implementation. Adding a second data-plane
adapter later is a new class plus a routing rule, with no change to the agent.

The stronger future argument for a second source is **redundancy**, not throughput: when
an Angel session dies mid-day or TOTP fails, the agent currently goes blind while holding
live positions. Precedent for a supplementary non-broker source already exists in
`yahoo-finance.service.ts`.

---

## 13. Rollout

| Stage | Behaviour | Gate to advance |
|---|---|---|
| **0 — Shadow** | Runs live, records verdicts and packets, places nothing | User reviews recorded calls against actual outcomes |
| **1 — Paper** | Executes via `paper-trade.service`; full path exercised | Clean execution, no state-machine faults |
| **2 — Live, narrow** | Real orders, veto window, 1 position, small size | User review |
| **3 — Live, full** | All 5 watched positions | — |

Stage 0 is not ceremony. Every other component can be proven correct before it runs; the
agent's judgment can only be proven correct *by running*. A shadow period produces the
labelled corpus that feeds the golden-packet fixtures and the replay harness. Without it
there is no baseline and no way to tell whether a prompt change improved anything.

Note that shadow mode costs the same in API calls as live mode — it is the full system
with the last wire cut, not a cheap rehearsal.

**Relationship to CLAUDE.md §9:** the user has chosen auto-close with a veto window as
the target behaviour. Stages 0–1 satisfy the paper-trading-default rule; live order
authority is reached at Stage 2 only after review.

---

## 14. Deferred decisions

Recorded so they are not mistaken for oversights:

- Policy for more than 5 concurrent positions (§2)
- Close authority for holdings / portfolio (§2)
- Second broker as data plane or redundancy source (§12)
- Whether the LLM call runs from NestJS or `ai-engine/` (§3.3)
- Exact charge model constants and the green-floor margin (§6.2) — to be set during
  planning against real Angel One contract notes

---

## 15. Open questions for planning

- Tripwire sensitivity defaults, and how they are tuned from shadow-run data.
- Heartbeat interval — likely instrument- and volatility-dependent rather than fixed.
- Model selection and token budget per evaluation, given the daily cost ceiling.
- Prompt versioning: verdicts must record which prompt version produced them, or the
  replay harness cannot attribute changes.
