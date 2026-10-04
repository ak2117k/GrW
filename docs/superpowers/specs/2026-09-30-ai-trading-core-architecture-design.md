# AI Trading Core — Target Architecture and Migration Roadmap — Design

**Date:** 2026-09-30
**Status:** Approved in conversation (sections 1–7); awaiting review of this written spec
**Scope:** Umbrella architecture for the whole platform plus the ordered sub-project roadmap.
Each sub-project (SP0–SP7) gets its own spec → plan → implementation cycle.
**Supersedes in part:** `2026-08-21-production-hardening-and-data-path-design.md` (see §10)

---

## 1. Why this exists

GrW grew by turning every trading experiment into a permanent module. Gated, ungated,
adaptive-stop, anand-dual, breakout-swing, sell-futures and the options watch each became a
vertical silo with its own tables, its own tick poller, its own stop/exit logic and its own
page. Measured on 2026-09-30:

| | Count |
|---|---|
| Backend modules | 33 |
| Frontend pages | 32 |
| Prisma models | 72 (five parallel trade/watch/paper-account families) |
| `@Cron` declarations | 41 |
| Modules that place orders | 3 (`trade-engine`, `auto-execution`, `trade-sentinel`) |

Consequences: a stop-loss fix must be made up to seven times; ~20 independent loops compete
for the feed slots and the 350 ms historical lane, so data goes missing intermittently; the
safety rules of `CLAUDE.md` §9 must be wired into every silo, and a silo missing one fails
silently; there is no single answer to "what are all my open trades and what is watching them".

Infrastructure compounds it: the API runs in Oregon, the database in Singapore, the broker and
the user in India, on free tiers that sleep and suspend. And since 2026-04-01 Angel One accepts
order placement only from a registered static IP, which the current host cannot provide.

## 2. Design brief

**What it is.** An AI-led, automated trading system — for the owner's own account first, sold
as a SaaS later.

**Stated by the user:**
- Trades whatever qualifies: intraday cash, MTF, or option buying. The instrument (vehicle) is
  chosen per setup.
- **The AI executes trades.** No per-trade human approval.
- The LLM learns from the journal: records every trade, analyses losses, and **proposes
  strategy changes that the user reviews and approves at night**. User and AI refine
  strategies together.
- **Strategies are guard rails.** Gates and conditions are inputs, not the architecture.
- **News and other factors are guard rails** on hold/exit decisions for open trades.
- AI scope over time: news scraping, stock analysis, next-day picks, commodity news.
- Minimal cost for the MVP; scale at launch.

**Agreed assumptions:**
- A **risk wall** in plain code that neither the AI nor a strategy can override.
- Host: **Oracle Cloud Always Free, Mumbai or Hyderabad**, API + Postgres + Redis on one box.
- Frontend stays on the Cloudflare Worker.
- SaaS features (billing, subscription, consent flows) are **frozen, not deleted**; tenant
  scoping stays in force.
- Live orders are **limit orders only**, from the registered static IP.
- LLM runs on the owner's **Claude subscription via the CLI transport** for this personal MVP;
  the API is a capped fallback. Multi-tenant/live-for-others means API only.

**Success criteria:**
1. Each morning the owner sees today's plan with the AI's reasoning.
2. Trades are entered, managed and exited automatically within the risk wall.
3. Prices reach decisions in < 100 ms and are never silently stale.
4. Every decision — taken or skipped — lands in one journal.
5. Each week the AI proposes evidence-backed strategy changes; approved ones run on paper,
   then are promoted to live by the owner.

## 3. Approach

**Build the new core alongside the old system, then migrate and retire silos one at a time.**

Rejected: refactoring silos in place (touches live money paths repeatedly and never converges
on one journal while five table families remain); rewriting from scratch (months with no usable
app, loses tested logic such as stop-hunt guards, charges and level books).

## 4. Architecture — nine layers, one-way flow

One NestJS monolith on one server. Internal discipline comes from module boundaries and typed
hand-off objects, not network hops.

```
1. MARKET DATA HUB     sole owner of broker data connections, feed slots, candles
2. CONTEXT             facts per symbol → EvidenceSnapshot
3. STRATEGIES          versioned rule sets evaluate evidence → Setup
4. DECISION (AI)       ML score → vehicle choice → LLM judge → TradeIntent
5. RISK WALL           plain code; sizes or rejects
6. EXECUTION           one order gateway: paper | live
7. POSITION MANAGER    one engine for all open trades; guard rails tighten or exit
8. JOURNAL             immutable record of every decision and outcome
9. LEARNING            nightly: analytics → lessons → proposals → owner approval

Cross-cutting: Session Orchestrator · Health spine · AI Gateway ·
               Postgres + TimescaleDB · Redis · Python ai-engine
```

**Hand-off objects, each persisted:**
`EvidenceSnapshot → Setup → TradeIntent → Order → Position → JournalEntry`.
Any trade can be replayed layer by layer.

**Authority order (enforced in code):**
> **Risk Wall > Strategy rules > AI judgement.** Guard rails and the AI may tighten a stop or
> exit; they may never widen a stop or add risk.

**Single-owner rules:**
1. Only the Market Data Hub requests market data from the broker.
2. Only Execution places, modifies or cancels orders.
3. Only the Position Manager manages open positions.

**Reused from today:** `signal-generator` strategies, level books and zone detectors (→ Context
and Strategies); `trade-charges.ts` and `risk-manager` (→ Decision and Risk Wall); the trade
sentinel (→ Position Manager guard rail); `ExecutionClaim` (→ Execution idempotency); the health
spine (unchanged); the sentinel's `MessagesTransport` (→ AI Gateway).

## 5. Data path

### 5.1 Three tiers

| Tier | Source | Contents | Freshness |
|---|---|---|---|
| Live | WebSocket | Open positions, their underlyings, indices, the AI's active candidates | real time |
| Near-live | Batched quote REST | Scan universe, next-day picks (rotated) | ~5–15 s |
| Stored | TimescaleDB | Candles built from ticks, backfilled after close | instant from disk |

**Live-slot priority:** open positions → their underlyings → indices/market context → active
candidates → symbols viewed in the UI. Overflow demotes the lowest priority to near-live and the
demotion is recorded (slot high-water and rejection counters already exist). The code cap is 50
(`angel-one-websocket.service.ts:32`); SP1 confirms Angel One's documented per-session limit.

### 5.2 Candle store

Ticks aggregate in process into 1-minute candles written to TimescaleDB; 5m/15m/1h/1d come from
continuous aggregates. One post-close job backfills gaps through the 350 ms historical lane —
its only routine use. Chart loads become database reads (< 100 ms target). Retention: 1-minute
≈ 6 months, daily permanent; exact windows fixed in the SP1 spec. Every new table ships with its
retention in the same change.

### 5.3 Freshness contract

Every price is `{value, at, source}`. Consumers declare their tolerance:
- Position Manager: ≤ 5 s. Falls back to a REST quote; if that fails the position is marked
  *unpriced*, new entries are blocked, and an alert fires. Never managed on an old price.
- Decision: no new entry on a symbol whose price is stale.
- UI: Live / Stale / Offline per price (the F1 badge).

### 5.4 Session Orchestrator

Knows NSE, BSE and MCX hours and holidays. 08:45 warm caches and subscribe tonight's picks;
09:14 subscribe the live set; wind down per venue (15:30 / 23:30). Replaces most of the 41
cron jobs. Nothing polls a closed market.

### 5.5 To the browser

Hub → Socket.IO → Cloudflare Tunnel → browser. Non-tick data via TanStack Query with refetch on
tab-return and reconnect (F2/F3). Expected end-to-end tick latency ≈ 100–150 ms, to be measured.

## 6. Strategies and Decision

### 6.1 Context

The Context layer produces an **EvidenceSnapshot** per symbol: named facts, each with value,
source and freshness. Producers: `indicators.ts`, level books, zones, OI walls, **news signals**,
**market regime** (index trend, VIX, breadth), **event flags** (results day, F&O ban, circuit
limits). Today's gates become facts that strategies read.

### 6.2 StrategyVersion

A stored JSON document, **immutable once it has traded**; every change creates a new version.
It references a named **evaluator** (code) plus parameters.

| Part | Changed by |
|---|---|
| Universe filter | AI proposes → owner approves |
| Entry rules (required facts + weighted score threshold) | AI proposes → owner approves |
| Stop / target method | AI proposes → owner approves |
| Allowed vehicles and their conditions | AI proposes → owner approves |
| Exit rules (trailing, time stop, partial, `sl-score-decay`) | AI proposes → owner approves |
| Guard-rail rules (news, regime) | AI proposes → owner approves |
| Budget (max concurrent, capital share) | **owner only** |
| Mode (paper / live) | **owner only** |

Existing strategy classes (`anand-sniper-v25`, `zone-reversal`, `levels-context`, …) become
evaluators. **The AI changes parameters and rules; it never edits code.** New evaluator logic
goes through normal development.

### 6.3 Decision pipeline (each 1-minute candle close)

1. **Setups** — each active StrategyVersion evaluates evidence.
2. **Conflicts** — one setup per symbol; never long and short on the same underlying.
3. **ML score** — ai-engine scorer: P(win), expected R. Rule score until the journal is large
   enough to train on.
4. **Vehicle** — plain code prices cash, MTF and option alternatives: expected P&L **after**
   charges, MTF interest, option theta over the horizon, spread and liquidity. Best or none.
5. **LLM judge** — top few only: take/skip, confidence, **thesis**, **invalidation conditions**.
6. **TradeIntent** → Risk Wall → Execution.

**Two paths around LLM latency (5–30 s):**
- **Pre-judged (fast path):** next-day picks were judged overnight with entry zone, stop, target,
  vehicle and thesis. When price reaches the zone the order goes out without an LLM call.
- **Discovered intraday:** a setup carries an entry zone and an expiry; if price has left the
  zone when the verdict returns, the setup is skipped. Always limit orders at the planned price.

**LLM unavailable:** per-strategy `llm_required` (default `true` for live). No LLM → no new live
entry; paper continues on rules; open positions are always managed.

## 7. Risk Wall, Execution, Position Manager

### 7.1 Risk Wall

Runs before every order. Checks: daily loss cap on realised + open P&L (soft level blocks
entries, hard level triggers the kill switch); max open positions; max capital per trade and
per sector; broker margin; instrument eligibility (F&O ban, MTF-approved list, circuit limits);
order rate well under the SEBI threshold; data health (stale symbol or any unpriced position
blocks entries).

- **Fails closed** — anything it cannot compute is a rejection.
- **Kill switch** — UI, Telegram `/kill`, or automatic at the hard cap. Cancels pending orders,
  exits all positions, halts all strategies until the owner re-enables them.
- **Limits change only by the owner, outside market hours, audited.** Nightly proposals cannot
  touch them.

### 7.2 Execution

- One `BrokerAdapter` interface; **Paper** and **Live** (Angel One) adapters. Promotion swaps the
  adapter only.
- Paper fills realistically: a limit fills only when live price crosses it, with slippage and
  full charges.
- Live: limit orders only, from the registered static IP; `ExecutionClaim` prevents duplicates.
- **Broker-side disaster stop** placed immediately on fill: a stop-limit at the broker, wider
  than the managed stop, so a crashed server or dropped network never leaves a position naked.
- **Reconciliation** against the broker's order book and positions every ~30 s and at every
  startup. The broker is the source of truth; mismatches alert.

### 7.3 Position Manager

State machine: `PENDING_ENTRY → OPEN → (PARTIAL) → EXITING → CLOSED`.

Checks per position on every tick, highest priority first:
1. Kill switch / risk wall → exit
2. Hard stop → exit
3. Guard rails → exit or tighten
4. Target, trailing, partial, time stop (90-min no-progress), `sl-score-decay`
5. End of session: intraday cash squares off 15:15; MTF holds overnight; options per the
   strategy horizon and expiry rule

| Guard rail | Trigger | Action |
|---|---|---|
| News | Strong negative item on the symbol, its sector or index | LLM re-checks thesis → exit or tighten |
| Market context | Index regime break, VIX spike | Tighten or exit per strategy |
| Thesis invalidation | Machine-checkable conditions written at entry (checked on ticks, no LLM cost) | Exit |
| Events | Results / ex-date inside the holding period | Exit before, unless the strategy allows holding |
| Sentinel review | Material change or 90-min heartbeat (existing gate) | Hold / tighten / exit |

**Tighten-only invariant:** a new stop is accepted only if it is closer to price. "Hold" never
means ignoring a stop. The one flexible move — converting a hit target into a trailing stop — is
allowed only after the stop first moves to lock at least the target's profit.

**Options** are managed on the underlying's levels (thesis), a premium stop (money), and a theta
time stop.

## 8. Journal and Learning

### 8.1 Journal

One immutable record per **decision**, including setups that were skipped:
strategy version and evaluator; full EvidenceSnapshot at entry; ML score; LLM verdict, thesis and
invalidations; vehicle alternatives with expected P&L each; risk-wall decisions; orders, fills,
slippage, charges; every management event; exit reason; net P&L after costs, R multiple,
MFE/MAE, holding time. **Skipped setups record what price did next**, so the AI's skip accuracy
is measurable.

### 8.2 Nightly loop (after close, on the subscription)

1. **Analytics (code)** — per strategy version, vehicle, exit reason and evidence band: win rate
   and expectancy after costs vs break-even; AI skip accuracy.
2. **Loss analysis (LLM)** — each loss classified: bad entry · stop too tight · wrong vehicle ·
   news missed · regime · **normal variance**.
3. **Lessons (LLM + statistics in code)** — a pattern qualifies only with a minimum sample
   (initially ≥ 20 trades) and a code-side check that it is not noise. Lessons are stored with
   links to their trades and fed into the judge's prompt.
4. **Proposals (LLM)** — a specific StrategyVersion change with reasoning and affected trades.
5. **Validation (code, backtest module)** — proposed vs current on recent history after costs;
   must also win on a held-out period it was not tuned on.
6. **Owner review** — see 8.3.

**Overfitting guards:** ≤ 1–2 proposals per strategy per week; one change at a time; minimum
samples; held-out win required; "normal variance" losses never trigger a proposal.

### 8.3 Nightly review

Each proposal is a card: change, reason, backtest before/after (including held-out result),
linked trades, and **Approve / Reject / Edit / Discuss with AI**. An approved version runs on
**paper beside the current live version** on the same setups; after at least 10 paper sessions and 20 trades that beat the current
version after costs (thresholds finalised in the SP5 spec), the
owner promotes it to live. Auto-promotion is a later option. A daily Telegram summary covers
P&L, trades, guard-rail actions and pending proposals.

## 9. AI jobs, news and cost

### 9.1 News funnel

Free RSS sources — NSE/BSE corporate announcements, Google News RSS queries (held/watched
symbols, sectors, indices, crude/gold/silver/natural gas), Moneycontrol, ET Markets and
Commodities — polled every 5 min in market hours and 30 min otherwise.
Dedup and symbol tagging (code) → sentiment (FinBERT, local, already in `ai-engine`) → **only for
symbols held or watched with strong sentiment**: full text (Jina Reader or self-hosted Crawl4AI)
→ LLM impact check (event type, materiality, direction, horizon) → NewsSignal facts into Context.

A scheduled-event calendar (RBI, Fed, CPI, EIA crude inventory, results dates) creates **event
windows** that strategies can reference.

### 9.2 Jobs

| Job | When | Output |
|---|---|---|
| Next-day picks | ~16:30 | Watchlist with pre-judged plan per pick |
| Pre-market check | 08:30 | Keep / drop / adjust picks → today's plan |
| Intraday judge | On a live setup | Take/skip + thesis |
| Position review | Material change / heartbeat / news hit | Hold / tighten / exit |
| News impact | On a relevant article | Materiality + direction |
| Nightly learning | ~16:00–20:00 | Loss analysis, lessons, proposals |
| ML scorer retrain | Weekly | XGBoost on the journal |

### 9.3 AI Gateway

The sentinel's `MessagesTransport` generalises into one gateway that every LLM call goes
through. It owns per-job routing (model, effort, transport), priority under capacity pressure
(position review > intraday judge > news > nightly), a budget meter with a hard daily ₹ cap on
the API fallback, and an audit trail linking every prompt and response to the journal.

### 9.4 Models and cost (personal MVP)

| Job | Model | Transport |
|---|---|---|
| Next-day picks, nightly learning | Opus 5.5 | CLI |
| Pre-market check | Sonnet 5.5 | CLI |
| News impact | Haiku 4.5 | CLI |
| Intraday judge | Sonnet 5.5 (Opus when stakes are high) | CLI → API fallback |
| Position review | Sonnet 5.5 → Opus on trigger | CLI → API fallback |

The API fallback exists so that subscription rate limits during market hours never leave a live
position unreviewed; it is capped (initially ₹100/day). Expected monthly cost: infrastructure
₹0, news/scraping/FinBERT/ML ₹0, subscription LLM ₹0 incremental, API fallback ₹0–3,000.

CLI constraints carried forward: the subscription's usage window is shared with the owner's own
Claude Code use; the CLI requests the output schema rather than enforcing it; the transport is
for the owner's own trades only. The headless server authenticates with a one-year
`CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`, rotated before expiry.

## 10. Infrastructure

> **Amendment 2026-10-04:** Oracle signup, capacity and card authorization all failed. The MVP
> runs on a 2 GB monthly Mumbai KVM VPS with Caddy + sslip.io (no domain) and images built by
> GitHub Actions — see the SP0 plan's amendment. Oracle (below) remains the target if it becomes
> available; the stack moves with the backup/restore scripts unchanged.

```
ORACLE A1 (2 OCPU · 12 GB · Mumbai/Hyderabad · static IP registered with Angel One)
└─ docker compose
   ├─ api          NestJS                ~2 GB
   ├─ ai-engine    FastAPI               ~2 GB
   ├─ postgres     + TimescaleDB         ~3 GB
   ├─ redis                              ~0.5 GB
   ├─ cloudflared  Cloudflare Tunnel — no public ports except key-only SSH
   └─ claude CLI   CLAUDE_CODE_OAUTH_TOKEN (env file, mode 600)
Frontend: Cloudflare Worker, proxying to the tunnel
```

- **Backups:** nightly `pg_dump` to Oracle Object Storage; weekly off-site copy (Cloudflare R2
  free tier); monthly restore test.
- **Deploy:** push to `main` → server pulls and builds natively on ARM → health check →
  automatic rollback on failure.
- **Outage during market hours:** external uptime ping → Telegram; broker-side disaster stops
  cover open positions meanwhile.
- **Oracle idle reclaim:** trading load should stay above thresholds; upgrade the account to
  pay-as-you-go as a guard.
- **Security:** SSH keys + fail2ban, no public ports, broker credentials encrypted at rest
  (existing), no secrets in git.

**Relation to the 2026-08-21 spec:** Phase 0 (evidence spine) and F1–F3 are kept as built.
B2 → Session Orchestrator (SP1); B4, B5, F4, F5 → SP1; B6 security → SP0; B-Phase 2 → SP2/SP6;
B1 (Render env vars) becomes moot when Render and Neon are retired in SP0. B3 (memory) is
relieved by 12 GB but the "less in RAM, more on disk with expiry" rule stays.

## 11. Migration roadmap

Each sub-project gets its own spec → plan → implementation. "Done" is verified in production.

| # | Sub-project | Delivers | Done when |
|---|---|---|---|
| SP0 | Foundation move | Oracle server, DB off Neon, Redis, tunnel, backups, deploy, static IP | App serves from India; latency measured; a backup restored |
| SP1 | Market Data Hub | Hub, tiers, slot priority, candle store, freshness contract, Session Orchestrator | Chart < 100 ms from DB; zero broker data calls outside the hub |
| SP2 | Core trade life cycle | New schema, Risk Wall, Execution (realistic paper), Position Manager (rules only), kill switch, reconciliation, **one strategy as an evaluator** | Paper trades flow end to end, fully journaled |
| SP3 | AI decision layer | AI Gateway, ML score, vehicle choice, LLM judge, pre-judged path, sentinel → guard rails | AI decisions and skipped setups journaled with outcomes |
| SP4 | News, events, picks | News funnel, event calendar, next-day picks, pre-market check | A news guard rail fires correctly in paper |
| SP5 | Learning loop | Analytics, loss analysis, lessons, proposals + backtest, nightly review, promotion | First proposal validated and approved |
| SP6 | Retire the silos | Remaining strategies → evaluators; old modules, tables, pages deleted; final UI | Old code gone; nothing depends on it |
| SP7 | Go live | Live adapter, broker disaster stops, small capital, one promoted version | 10 live sessions within risk limits, reconciliation clean |
| later | SaaS launch | API transport, billing unfrozen, scaling | — |

During SP2–SP6 the old silos keep running in paper on the new server; each evaluator is compared
against its silo before the silo is deleted.

**Frontend target — four screens,** built incrementally: **Today** (plan, picks, market context,
AI status) · **Trades** (live positions, guard-rail state, kill switch) · **Journal** (history,
per-trade replay) · **Review** (proposals, strategy versions, analytics). Risk limits live in
Settings.

## 12. Verification and error handling

- **Evidence rule:** a sub-project is complete when production shows it working, not when tests
  pass.
- **Unit tests** for pure logic; **property tests** for the money invariants: tighten-only,
  risk wall fails closed, authority order.
- **Tick recorder:** the live tick stream is written to disk so any session can be replayed
  through the pipeline deterministically — for backtests and for reproducing bugs.
- **Failure semantics:**
  - Entries fail closed — doubt means no trade.
  - Exits fail safe — a position is always managed (rules, REST price) even without the LLM.
  - The broker is the truth — reconciliation resolves disagreement.
  - No LLM → rules only; live entries blocked where `llm_required`.

## 13. Regulatory constraints

- Since 2026-04-01 Angel One SmartAPI accepts place/modify/cancel order and GTT calls only from
  a registered static IP.
- Market and IOC orders are prohibited for algorithmic orders; all orders are limit (disaster
  stops are stop-limit).
- A single-user system stays far below the orders-per-second threshold for algo registration;
  the Risk Wall's order-rate check keeps it there.

## 14. Decisions recorded

| Decision | Choice | Reason |
|---|---|---|
| Audience | Owner first, SaaS later | Prove profitability after costs before selling |
| Execution authority | AI executes automatically | Owner's choice; safety moves into code (risk wall, tighten-only, paper-first) |
| Human role | Nightly review of strategy proposals | Owner and AI refine strategies together |
| Strategy model | Versioned config over code evaluators | AI can change rules safely; code changes stay in normal development |
| Guard rails | News, context, thesis, events — tighten or exit only | "Hold" must never mean ignoring a stop |
| Migration | New core alongside, silos retired one by one | App stays usable; evidence at each step |
| Host | Oracle Always Free, India | Latency, memory, no sleep, static IP — at ₹0 |
| Database | Self-hosted Postgres + TimescaleDB on the same host | Neon has no India region; co-location removes network hops |
| LLM transport | Subscription CLI, capped API fallback | ₹0 incremental for a personal MVP |
| SaaS features | Frozen, not deleted | Tenant scoping is expensive to re-add |

## 15. Open items

- Confirm Angel One's documented WebSocket per-session token limit (SP1).
- Confirm Oracle A1 capacity in the chosen India region at signup; the home region cannot be
  changed later.
- Exact retention windows for candles and the tick recorder (SP1).
- Initial risk-wall values (daily loss cap, max positions, capital shares) — owner decision
  before SP2 goes to paper.
- Which strategy is migrated first in SP2 — owner decision, informed by the journal analysis
  (Ungated and Adaptive-Stop were gross-profitable before fees).
- Rotate the Neon password (outstanding since an earlier session) — moot once Neon is retired,
  but must happen if Neon remains as a fallback.
