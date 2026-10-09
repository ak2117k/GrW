# SP2 — Core Trade Lifecycle — Design

**Date:** 2026-10-09 · **Status:** approved in conversation (sections 1–6), pending written-spec review
**Parent:** `docs/superpowers/specs/2026-09-30-ai-trading-core-architecture-design.md` (§6.2, §7, §8.1, §11 SP2 row)
**Depends on:** SP1 market hub (M1–M3 merged: `hubFor(userId, consumer)`, P0 position pricing)

## 1. Purpose and success

Today seven strategy silos each own a private lifecycle (entry, stops, exits, paper fills, P&L) across
five table families and ~20 pollers. SP2 builds **one** lifecycle — strategy versions → Risk Wall →
Execution → Position Manager → Journal — that every strategy runs through. The old silos keep running
untouched beside it (approach A) until SP6 retires them.

**Done when:** Adaptive-Stop v1 runs in paper on real Chartink alerts for one full NSE session, every
entry passes the Risk Wall, fills realistically, exits by its rules, the journal is complete,
reconciliation is clean, and the kill switch has been exercised.

**Out of scope:** AI decision pipeline / ML score / LLM judge (SP3), news and regime guard rails (SP4),
nightly learning loop and proposals (SP5), retiring silos (SP6), live adapter and broker-side disaster
stop (SP7). `LIVE_TRADING_ENABLED` stays `false`; only the paper adapter is wired.

## 2. Owner decisions (2026-10-09)

| # | Decision |
|---|---|
| D1 | Approach A: a new core alongside the old silos; no old table or service is changed (except bug fixes) |
| D2 | Strategies are chosen from a **dropdown**; the owner can also **upload strategy docs** |
| D3 | A strategy doc becomes a **config**: the AI drafts a StrategyVersion from the existing building blocks; the owner approves in the UI; it then runs in paper. Rules the blocks can't express are flagged for development |
| D4 | **No hard-coded risk values** — every limit is configurable at any time |
| D5 | Limit changes: **tighten takes effect now, loosen takes effect next session** |
| D6 | Vehicles: **intraday cash, MTF, options buying** (all three) |

Refinement of parent §7.1 ("limits change only outside market hours"): D5 allows tightening intraday;
loosening is deferred to the next session open, which preserves the parent's intent.

## 3. Architecture and module layout

New module `apps/api/src/modules/trade-core/`:

| Part | Responsibility | Reuses |
|---|---|---|
| `strategies/` | Catalogue, immutable `StrategyVersion`s, owner selections (dropdown), strategy docs → draft | Existing evaluator classes (wrapped, not rewritten) |
| `risk-wall/` | Gate on every entry; editable limits with tighten/loosen rule; persistent kill switch | `common/audit` (`AuditService`, `audit-actions.ts`) |
| `execution/` | `ExecutionAdapter` interface; `PaperExecutionAdapter` (cash, MTF, options); orders, fills, cash ledger | `trade-sentinel/charges.ts`, `canFillAtPrice` (`trade-engine/services/paper-trade.service.ts`), `auto-execution/services/execution-claim.service.ts` |
| `lifecycle/` | Position state machine, exit rules, crash recovery | `market-hub/hub-prices.ts` (`hubFor(userId, 'positions')`), `market-hub/session-clock.ts` |
| `journal/` | Append-only decision journal, closed-trade summaries, reconciliation | `SessionClock` |

**Naming:** Prisma already has `Setup`/`setups` and the codebase has `PositionManagerService`. New code
uses the `Core` prefix (`CorePosition`, `CoreLifecycleService`, …) and `core_*` tables.

**Entry source:** Chartink alerts are processed today in `chartink/services/chartink-process.service.ts`
(`processOne`). After the existing silo handling, the alert is additionally handed to the core
(fan-out; the silo path is unchanged and a core failure never affects it). The core acts only for
StrategyVersions the user has selected and enabled. Code evaluators (existing `TradingStrategy`
classes) are a second entry source through the same `CoreEntryIntent` type.

**Tenant scoping:** the strategy catalogue (`core_strategies`) and its versions
(`core_strategy_versions`) are one global catalogue, managed by the admin (owner). Every other `core_*`
row carries `userId` and every query on it filters by it: selections, limits, kill switch, positions,
orders, fills, cash ledger, journal and trade summaries (owner decision 2026-10-09).

**Flow (one direction only):**
`alert/evaluator → CoreEntryIntent → RiskWall.check → ExecutionAdapter.placeOrder → fills → CoreLifecycle → exit intent → ExecutionAdapter → Journal`

## 4. Strategies, versions and docs

### 4.1 Building blocks

A strategy is a combination of typed blocks; a StrategyVersion is the block parameters. Each block
has a schema and is validated on save by one pure `validateBlocks` (unknown fields are rejected).
Percent fields are percent of price (1.5 = 1.5 %).

| Block | Variants |
|---|---|
| `entry` | `chartink` { scanName (null = any), match ANY/EXACT/CONTAINS, side BUY/SELL/BOTH, minScore (null, or { base, windows[{ fromHhmm, toHhmm, score }] }: the alert's Chartink score must reach `base`, or a window's score inside that IST window) } · `evaluator` { evaluatorKey, params, side } |
| `filters` | { staleEntry: null or { maxMovePct } (skip when price is already more than X % past the alert price) · cooldown: null or { minutes } (per symbol, after this strategy's last entry) · lastLoss: null or { window: SAME_IST_DAY } (skip when today's last closed trade on the symbol lost) · gates: [{ kind: evaluator, evaluatorKey, params }] (each must pass) } |
| `stop` | `fixedPct` { pct } · `atr` { period, timeframe, multiple, minPct, maxPct } |
| `target` | `fixedPct` { pct } · `rr` { ratio } |
| `trail` | `none` · `breakeven` { atPct } · `atr` { multiple, minPct, maxPct, startsAfter ENTRY/PARTIAL } (uses the ATR the stop measured at entry) |
| `timeExit` | `clock` { hhmm IST } · `holdDays` { n } (MTF/swing) |
| `partial` | `none` · `atTarget1` { fraction, atPct } |
| `sizing` | `riskRupees` { amount } · `notionalRupees` { amount } (both always capped by the Risk Wall) |
| `vehicle` | `CASH_INTRADAY` · `MTF` · `OPTIONS_BUY` { strike: ATM/ITMn/OTMn, expiry: nearest with ≥ N days, premiumStopPct, thetaStop { minMovePct, withinMinutes }, expiryDayExitHhmm } |

Adaptive-Stop and Ungated become two configurations of these blocks:
- **Adaptive-Stop v1:** entry chartink, any scan, BUY, minScore 47 (75 in 11:45–14:00 IST); filters
  stale-entry 1 %, cooldown 45 min, same-day last-loss, gate `adaptive-stop-decision-gate`; stop `atr`
  14 / 5m × 1.2, clamp 0.8–2.5 %; target 2 %; partial 50 % at +1 %; then trail `atr` × 1.0, clamp
  0.6–1.5 %, after the partial; sizing ₹800 risk; timeExit 15:15; CASH_INTRADAY.
- **Ungated v1:** entry chartink, Hull scanners only (scan name contains "hull"), BUY, no minScore;
  filters stale-entry 1 %, cooldown 45 min, same-day last-loss, no gates; stop `fixedPct` 1.5 %;
  target 3 %; no trail, no partial; sizing ₹2,00,000 notional; timeExit 15:25; CASH_INTRADAY.

These are seed data (a migration seed, inserted as `DRAFT` for the owner to approve), not code
constants. Values are copied from the silo code at implementation time, and the plan must cite the
source lines. The silos' two-strike stop confirmation and 2-minute stop grace (artifacts of 30-second
polling) are deliberately not carried into the core (owner decision 2026-10-09).

### 4.2 Tables

- `core_strategies` — id, key, name, description, allowedVehicles[], createdAt.
- `core_strategy_versions` — id, strategyId, version (int, unique per strategy), blocks (JSON,
  validated), status `DRAFT | PAPER | LIVE | RETIRED` (LIVE is unused until SP7), createdBy
  `OWNER | AI`, approvedBy, approvedAt, sourceDocId?, notes. **Immutable once approved**: any edit
  creates version n+1. Positions reference the version they entered under.
- `core_strategy_selections` — userId, strategyVersionId, enabled, capitalAllocation, updatedAt.
  Unique (userId, strategyId) — one active version per strategy per user.
- `core_strategy_docs` — id, userId, filename, mime, extractedText, uploadedAt.
- `core_strategy_gaps` — id, docId, ruleText, reason ("no block expresses this"), status
  `OPEN | PLANNED | DONE | WONTFIX`.

### 4.3 Dropdown

A strategy picker lists every strategy with its approved versions. Enabling a version creates or
updates a selection in paper mode. A new version always starts in `PAPER`, and only the owner
changes mode. This replaces, for the core only, the `VALID_STRATEGY_NAMES` whitelist in
`settings/services/settings.service.ts`, which silently discards choices. The old settings path is
not modified.

### 4.4 Doc → config (SP2 milestone 6)

1. Owner uploads a doc (txt / md / pdf → text).
2. The AI receives the extracted text and the block schema catalogue. It returns a **draft**
   `blocks` JSON plus a list of unsupported rules. Transport: the existing judge transport
   (`SENTINEL_JUDGE=api|cli`).
3. The draft is validated against the schemas. If invalid, it is shown with errors and never saved
   as approvable.
4. Owner reviews it in the UI (side-by-side doc ↔ fields), edits, and approves → version `PAPER`.
   **The AI can never approve.** Unsupported rules become `core_strategy_gaps`.
5. If the AI is unavailable, the same form is filled by hand.

## 5. Risk Wall

### 5.1 Contract

`RiskWall.check(intent, ctx) → { verdict: 'ALLOW' | 'REJECT' | 'RESIZE', qty?, reasons[] }`, a pure
function of the intent, the limits in force, and the user's live state (open positions, today's
realised + open P&L, trade count, capital deployed per vehicle, kill switch, data health).

- It may only allow, reject or **reduce** quantity, never increase it.
- **Exits are never checked or blocked.**
- **Fails closed:** any input it cannot compute (missing limit, stale price, unpriced open position)
  → REJECT with the reason.
- Every verdict is journaled, including the limits snapshot it used.
- Conflict rule (parent §6.3): never long and short on the same underlying; one open core position
  per symbol per user.

### 5.2 Limits (`core_risk_limits`, per user)

All configurable; initial values are copied from the user's current `UserSettings` where an
equivalent exists, otherwise seeded and shown to the owner as "default — please review".

| Key | Tighter direction |
|---|---|
| `maxDailyLoss` (₹, realised + open) | lower |
| `maxDailyLossPerStrategy` (₹) | lower |
| `maxTradesPerDay` | lower |
| `maxOpenPositions` (total, and per vehicle) | lower |
| `maxRiskPerTrade` (₹) | lower |
| `maxCapitalDeployed` (per vehicle: CASH_INTRADAY, MTF, OPTIONS_BUY) | lower |
| `mtfMaxLeverage`, `mtfMaxHoldDays` | lower |
| `optionsMaxPremiumPerTrade` (₹) | lower |
| `lastEntryTime` (per vehicle, IST) | earlier |
| `squareOffTime` (per vehicle, IST) | earlier |
| `dailyLossAction` | `BLOCK_ENTRIES` < `BLOCK_AND_SQUARE_OFF` (the latter is tighter) |

**Storage is append-only:** each change is a row with key, scope, value, `effectiveFrom`, setBy,
reason and createdAt. The limit in force is the latest row whose `effectiveFrom ≤ now`.

**Change rule (D5):**
- A change that is tighter by the key's direction gets `effectiveFrom = now`.
- A looser change gets `effectiveFrom` = the next session open, computed with `SessionClock` for the
  vehicle's exchange.
- Every change writes an `AuditService` entry (new actions in `audit-actions.ts`).

### 5.3 Daily loss

When `maxDailyLoss` is reached, new entries are rejected for the rest of the session. Open positions
keep their stops. If `dailyLossAction = BLOCK_AND_SQUARE_OFF`, all core positions are also exited.

### 5.4 Kill switch (`core_kill_switch`, per user)

- Persisted, so it survives restarts. Today's switch in `risk-manager.service.ts` is in memory only.
- Changed only by an explicit `POST` (with a reason); `GET` is read-only. Today's `GET kill-switch`
  mutates state, which this fixes for the core.
- **On:** immediate. Rejects all entries, cancels pending core orders, exits all core positions, and
  **also calls the old silos' square-off paths**, so one button stops everything.
- **Off:** a loosening (D5), so it takes effect at the next session open.
- Audited both ways.
- Telegram `/kill` (parent §7.1) is wired when Telegram alerts exist; not in SP2.

## 6. Execution

### 6.1 Interface

```ts
interface ExecutionAdapter {
  placeOrder(req: CoreOrderRequest): Promise<CoreOrder>;   // idempotent on req.idempotencyKey
  cancel(orderId: string): Promise<CoreOrder>;
  modify(orderId: string, patch: CoreOrderPatch): Promise<CoreOrder>;
  getOrder(orderId: string): Promise<CoreOrder>;
  getPositions(userId: string): Promise<CorePositionView[]>;
  getFunds(userId: string): Promise<CoreFunds>;
}
```

SP2 implements `PaperExecutionAdapter` only. Strategies and the lifecycle are written against the
interface, so SP7 swaps in a live adapter without changes.

### 6.2 Orders and fills

- `core_orders`: state `NEW → OPEN → PARTIAL → FILLED | CANCELLED | REJECTED`, plus
  `idempotencyKey` (unique), built on `ExecutionClaimService`.
- `core_fills`: price, qty, charges breakdown, time.

### 6.3 Paper fill model

| Order | Fill rule |
|---|---|
| Market | Against the opposite side of the hub's 5-level depth (ask for buy, bid for sell), walking levels for size. This can produce partial fills and a worse average price. Without depth: last price ± configurable slippage (bps, per vehicle) |
| Limit | Fills only when the market trades through the limit (`canFillAtPrice`); otherwise rests |
| Stop-loss market | Triggers at the stop, then fills as a market order; a gap through the stop fills at the gap price |

- Every order uses the first fresh price **after** submission.
- A price older than 15 s → REJECTED ("no fresh price").
- Lot-size multiples and option freeze quantity are enforced.
- Charges per fill come from `charges.ts` for the segment (EQ_INTRADAY, EQ_DELIVERY, OPT). All P&L is
  net of charges.

### 6.4 Paper funds (`core_cash_ledger`, per user)

Append-only entries: `DEPOSIT`, `MARGIN_BLOCK`, `MARGIN_RELEASE`, `REALISED_PNL`, `CHARGES`,
`MTF_INTEREST`. Starting paper capital is configurable. This replaces, for the core, the single
in-memory balance that `paper-trade.service.ts` shares across users.

### 6.5 Vehicles

- **CASH_INTRADAY:** margin = notional ÷ configurable leverage; squared off at the vehicle's
  `squareOffTime`.
- **MTF:** long only; funded share configurable; **interest accrues nightly** on the funded amount at
  a configurable annual rate; delivery charges plus a configurable pledge fee; forced exit at
  `mtfMaxHoldDays`.
- **OPTIONS_BUY:** buy only; full premium paid upfront; strike and expiry chosen by the version's
  vehicle block; lot size from the instrument master (options resolve on demand from the in-memory
  master).

## 7. Position Manager (lifecycle)

### 7.1 State machine (`core_positions`)

`PENDING_ENTRY → OPEN → PARTIAL → EXITING → CLOSED`, plus `PENDING_ENTRY → CANCELLED` if the entry
never fills (limit expiry or rejection). Each transition is journaled with its reason. A position
stores `strategyVersionId` and a frozen copy of its exit rules at entry.

### 7.2 How it watches

- **Price pushes (main path):** on OPEN, the lifecycle calls `hub.watch(ref, P0, 'core:<positionId>')`
  via `hubFor(userId, 'positions')`. P0 is never evicted. Each `onPrice` for a watched ref evaluates
  that position immediately, in memory.
- **1-second sweep (clock-driven rules):** time exits, square-off times, the options theta stop,
  expiry-day cutoffs and price freshness. These are rules no tick will trigger.
- **Feed stall:** the hub's QuotePoller keeps P0 priced over REST within the Governor's rate limit.
- **Blind position:** no fresh price for N s (configurable) → no decision on the stale price; mark it
  `blind`, journal it, and raise an alert. At square-off time a blind position exits at market
  anyway.

### 7.3 Exit priority (same-check conflicts)

1. Kill switch
2. Risk Wall square-off (daily loss)
3. Stop
4. Target
5. Trail
6. Time exit / theta stop
7. Vehicle square-off time

### 7.4 Tighten-only invariant

- A new stop is accepted only if it is closer to the current price (for a long, higher).
- "Hold" never ignores a stop.
- The one flexible move: turning a hit target into a trailing stop is allowed only after the stop has
  first moved to lock in at least the target's profit (parent §7.3).
- This is enforced in one function, `tightenStop(current, proposed, side)`, and covered by tests.
  SP3 and SP4 inherit it.

### 7.5 Vehicle rules

- **Options:** premium stop (X % below the entry premium); an optional stop on the underlying's price;
  the theta stop (no X % premium move within N minutes); exit by `expiryDayExitHhmm` on expiry day;
  never held into expiry.
- **MTF / swing:**
  - Held overnight; stops re-armed at the next open.
  - **Gap rule:** if the first tick at the open is past the stop, exit at market immediately.
  - Interest is posted nightly; forced exit at max hold days.
- **Partial:** an optional partial exit at target 1, with the rest trailed.

### 7.6 Crash recovery

On boot:
1. Load all `OPEN | PARTIAL | EXITING` positions for every user.
2. Re-watch them at P0.
3. Resume unfinished exits (same idempotency keys, so no duplicate orders).
4. If the first fresh price shows the stop was crossed while the server was down, exit immediately
   and journal it as `RECOVERY_STOP`.

## 8. Journal and reconciliation

### 8.1 Journal (`core_journal`)

Append-only rows. No update or delete path exists in the repository class.

- **Fields:** userId, positionId?, strategyVersionId?, type, payload (JSON), priceUsed, priceAgeMs,
  createdAt.
- **Types:** `ALERT_RECEIVED`, `INTENT_SKIPPED` (strategy disabled or conflict), `RISK_VERDICT` (with
  limits snapshot), `ORDER_PLACED`, `ORDER_STATE`, `FILL`, `STOP_MOVED`, `EXIT_DECIDED`,
  `POSITION_STATE`, `BLIND`, `RECOVERY_STOP`, `KILL_SWITCH`, `LIMIT_CHANGED`, `RECON_MISMATCH`.

**Skipped and rejected intents** also record what price did next (parent §8.1): a nightly job fills
`priceAfter30m` and `priceAfterClose` from candles.

### 8.2 Closed-trade summary (`core_trade_summaries`, one per closed position)

Contents:
- entry and exit prices and times, quantity, vehicle;
- gross P&L, charges, MTF interest, **net P&L**;
- R-multiple (net P&L ÷ initial risk);
- MFE and MAE (best and worst price during the trade);
- holding time, exit reason.

It is written at CLOSED from the position's fills and the price history the lifecycle saw.

### 8.3 Reconciliation

- **Every 5 minutes in session:**
  - each open position's fills sum to its quantity;
  - any order in `NEW | OPEN` for longer than N minutes is cancelled and flagged.
- **Nightly at 15:45 IST** (`@Cron` with `timeZone: 'Asia/Kolkata'`; the ratchet spec enforces it):
  - the cash ledger balance equals the sum of its entries;
  - no intraday position is open after its square-off time;
  - MTF interest is posted for every open MTF position;
  - fills ↔ orders ↔ positions are consistent.
- **On a mismatch:** a `RECON_MISMATCH` journal entry and an alert, and **new entries for the
  affected strategy are blocked until the owner acknowledges it** (a tightening).
- **SP7:** the same reconciler also compares against the broker via `ExecutionAdapter.getPositions`,
  every ~30 s and at startup (parent §7.2).

### 8.4 UI

- **Journal page:** a per-position timeline and a daily summary (net P&L, trades, win rate, charges as
  % of gross).
- **Comparison view:** the core result vs the old silo for the same Chartink alert.
- **Risk page:** limits with pending-loosen indicators; the kill switch.
- **Strategy page:** the dropdown and versions; doc upload and draft review.

## 9. Error handling

- A core failure on an alert never affects the silo path: the fan-out runs in its own try/catch and
  failures are journaled.
- The Risk Wall fails closed. Execution rejects on stale prices.
- The lifecycle never acts on stale prices, except at square-off time.
- All crons pin `timeZone: 'Asia/Kolkata'`.
- Everything is idempotent across restarts (idempotency keys, state machine guards).

## 10. Testing

- **Pure functions with unit tests:**
  - `RiskWall.check` (every limit, fail-closed, resize-only, exits pass);
  - the tighter/looser direction per key and `effectiveFrom`;
  - the fill model (depth walk, trade-through limit, gap-through stop, stale reject, lot rounding);
  - `tightenStop` and the target→trail rule;
  - exit priority;
  - the options theta stop, expiry cutoff and MTF gap rule;
  - charges and interest accrual.
- **Replay test:** a recorded tick stream plus a Chartink alert, run through the full chain to a
  journaled, reconciled closed trade.
- **Restart test:** an open position, then the service is torn down and recreated; recovery resumes
  correctly, including `RECOVERY_STOP`.
- **Tenant test:** user A's alerts, limits, kill switch and positions never affect user B.
- **Silo-isolation test:** a throwing core does not change the silo's handling of the same alert.

## 11. Milestones (each its own plan; M1 and M2 may overlap)

| M | Deliverable |
|---|---|
| M1 | Strategy catalogue, versions, selections, dropdown, seeds (Adaptive-Stop v1, Ungated v1) |
| M2 | Risk Wall, editable limits with tighten/loosen, persistent kill switch (+ silo square-off) |
| M3 | `ExecutionAdapter` + paper adapter (cash, MTF, options), orders/fills, cash ledger |
| M4 | Lifecycle: state machine, exit rules, options/MTF rules, crash recovery |
| M5 | Journal, trade summaries, reconciliation, Chartink fan-out, Adaptive-Stop end to end, UI pages. **SP2 done** |
| M6 | Strategy docs → AI draft → owner approval, gaps list |

## 12. Open items

- Default values for limits with no `UserSettings` equivalent are seeded at M2 and listed for the
  owner to review. They are never treated as constants.
- MTF interest rate, pledge fee and funded share are owner-entered (Angel's current terms); there are
  no built-in defaults beyond seed rows marked for review.
- Whether the kill switch may be released the same day (with a typed reason) is to be revisited at
  SP7 (live).
