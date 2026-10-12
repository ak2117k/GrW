# SP2 M3 — Execution (paper) — Design

**Date:** 2026-10-11 · **Status:** approved in conversation (approach A), pending written-spec review
**Parent:** `docs/superpowers/specs/2026-10-09-sp2-core-trade-lifecycle-design.md` §6 (this note refines it; where
they differ, this note wins for M3)
**Depends on:** SP2 M1 (strategy catalogue, `Vehicle`), SP2 M2 (Risk Wall: `CoreEntryIntent`, ports, defaults pattern)

## 1. Purpose and success

M3 builds the execution layer every later milestone writes against: the `ExecutionAdapter` interface and a
`PaperExecutionAdapter` for CASH_INTRADAY, MTF and OPTIONS_BUY, with per-user orders, fills and a cash ledger.

**Done when:** for each vehicle, an order placed through the adapter fills by the paper fill model, posts
charges and margin to the ledger, can be exited with realised P&L booked, and the ledger reconciles to its
entries; placing the same idempotency key twice returns the same order; open orders survive a restart; user A's
orders and ledger never affect user B. Nothing calls the adapter in production until M5's fan-out (ships dark).

**Out of scope:** position state machine and exit rules (M4); option strike/expiry picker (M4/M5, where intents
are built); Chartink fan-out, journal, UI (M5); live adapter (SP7).

## 2. Owner decisions (2026-10-11)

| # | Decision |
|---|---|
| E1 | Starting paper capital **₹10,00,000** per user (seeded default, owner-editable) |
| E2 | CASH_INTRADAY margin = notional ÷ **5** (seeded default, owner-editable) |
| E3 | Paper LIMIT orders fill only on a **strict trade-through** (buy: price < limit; sell: price > limit) |
| E4 | Large option orders are capped by an owner-set **max lots per order per underlying**, seeded for review; no guessed NSE freeze numbers |
| E5 | Matching approach A: event-driven and in memory, DB is the source of truth |

All paper settings follow M2's editable-defaults pattern: no hard-coded values (SP2 D4), seed rows labelled
"default — please review".

## 3. Corrections to the SP2 spec (found in code, 2026-10-11)

| Spec said | Code reality | M3 does |
|---|---|---|
| Charges "per fill" with a breakdown (§6.2–6.3) | `trade-sentinel/charges.ts` `estimateCharges` prices a whole round trip, returns one number; no MTF segment | Refactor `charges.ts` to export a per-leg breakdown; `estimateCharges` is rebuilt on it and its outputs stay identical (golden test). MTF = EQ_DELIVERY + pledge fee |
| Reuse `canFillAtPrice` | Private method on `PaperTradeService`; LIMIT fills on touch | New pure `fill-model.ts`; old service untouched |
| Orders "built on `ExecutionClaimService`" | Coupled to auto-execution (`entryId`, live table) | `core_orders.idempotencyKey` unique column, same P2002 pattern |
| Options "resolve from the in-memory master" | In-memory master is token-lookup only; contracts come from DB via `OptionsChainService` | Adapter accepts a resolved contract (token, lotSize); picker is M4/M5 |
| Enforce option freeze quantity | Freeze quantity exists nowhere | E4: owner-set max lots per underlying |

Confirmed as assumed: the hub `Price` carries `at` (receive time) and optional 5-level `depth` (bids/asks with
qty); `price(ref, { maxAgeMs: 15_000 })` gives fresh/stale. M3 uses the existing `'positions'` hub consumer.

## 4. Design

### 4.1 Module layout (`apps/api/src/modules/trade-core/execution/`)

| File | Role | I/O |
|---|---|---|
| `execution.types.ts` | `ExecutionAdapter`, `CoreOrderRequest`, `CoreOrder`, `CoreOrderPatch`, `CoreFill`, `CorePositionView`, `CoreFunds` | none |
| `fill-model.ts` | Decide a fill from (order, price, depth, now, settings) | pure |
| `order-state.ts` | Allowed transitions `NEW → OPEN → PARTIAL → FILLED \| CANCELLED \| REJECTED` | pure |
| `margin.ts` | Margin to block per vehicle | pure |
| `ledger-math.ts` | Net position, average price, realised P&L from fills; balance from entries | pure |
| `paper-settings.ts` | Resolve paper settings from defaults (+ per-user overrides later) | pure |
| `paper-execution.adapter.ts` | Implements `ExecutionAdapter`; persists; drives matching | DB, hub |
| `paper-matcher.service.ts` | Holds open orders in memory; evaluates on hub price pushes and a 1 s sweep; reloads open orders on boot | hub, DB |
| `mtf-interest.cron.ts` | Nightly MTF interest posting | DB |
| `repositories/` | `core-order`, `core-fill`, `core-cash-ledger`, `core-paper-defaults` | DB |

### 4.2 Interface

As SP2 §6.1:

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

`CoreOrderRequest`: userId, idempotencyKey (derived from `CoreEntryIntent.intentId` / exit intent), vehicle,
instrument { exchange, token, symbol, lotSize, underlying? }, side BUY/SELL, qty, type MARKET / LIMIT / SL_MARKET,
limitPrice?, triggerPrice?, purpose ENTRY/EXIT, strategyVersionId?.

### 4.3 Paper fill model (`fill-model.ts`)

- **Freshness:** an order is evaluated only against a price whose `at` is **after** the order's submission and
  no older than 15 s. If no such price arrives within the settings' `noPriceRejectMs` after submission, the
  order is REJECTED ("no fresh price").
- **MARKET:** walk the opposite side of `depth` (asks for BUY, bids for SELL), level by level, for the remaining
  qty; average price = Σ(price × qty) ÷ qty. Unfilled remainder stays open as PARTIAL and fills on the next
  fresh price. Without depth: LTP ± `slippageBps[vehicle]`.
- **LIMIT (E3):** fills only when LTP is strictly through the limit; fill price = the limit.
- **SL_MARKET:** triggers when LTP reaches the trigger (BUY ≥, SELL ≤), then fills as MARKET on that same price;
  a gap through the trigger fills at the gap price, not the trigger.
- **Quantity:** must be a positive multiple of `lotSize`, else REJECTED. Options: lots ≤
  `maxLotsPerOrder[underlying]` (E4), else REJECTED. Missing setting for an underlying → REJECTED (fail closed).
- **Vehicle side rules:** OPTIONS_BUY and MTF open only with BUY; SELL is accepted only to reduce an existing
  long. CASH_INTRADAY allows either side.

### 4.4 Money (`core_cash_ledger`, append-only)

Entry types: `DEPOSIT`, `MARGIN_BLOCK`, `MARGIN_RELEASE`, `REALISED_PNL`, `CHARGES`, `MTF_INTEREST`.

- First core order for a user with no ledger rows → `DEPOSIT` of `startingCapital` (E1), in the same transaction.
- **Margin (`margin.ts`):** CASH_INTRADAY notional ÷ `intradayLeverage` (E2); MTF notional × (1 − `mtfFundedShare`),
  where `mtfFundedShare` is the fraction the broker funds (interest accrues on notional × `mtfFundedShare`);
  OPTIONS_BUY full premium. Blocked at placement for the order's qty at the reference price; trued up to actual
  fill notional on each fill; released for any unfilled qty on cancel/reject and in proportion on exits.
- Placement with insufficient free cash → REJECTED (free cash = Σ entries − blocked margin).
- **Fills:** each fill posts `CHARGES` from the per-leg breakdown (segment by vehicle; MTF adds `mtfPledgeFee` on
  the buy leg). A reducing fill posts `REALISED_PNL` = (exit − average entry) × qty × direction, gross; charges
  are separate rows, so net = Σ.
- **MTF interest (`mtf-interest.cron.ts`):** `@Cron` at 15:35 IST with `timeZone: 'Asia/Kolkata'` (before M5's
  15:45 reconciliation, which checks interest is posted); for every open
  MTF holding, post one `MTF_INTEREST` row per calendar day held since the last posting (funded amount ×
  `mtfAnnualRatePct` ÷ 365). Unique (userId, instrument token, interestDate) makes it idempotent and lets a
  missed night catch up.

### 4.5 Tables (one migration)

- `core_orders` — id, userId, idempotencyKey (unique), vehicle, exchange, token, symbol, lotSize, side, qty,
  filledQty, avgFillPrice, type, limitPrice, triggerPrice, purpose, strategyVersionId, state, rejectReason,
  submittedAt, updatedAt. State changes only through `order-state.ts`.
- `core_fills` — id, orderId, userId, price, qty, charges (JSON breakdown), chargesTotal, priceAt, createdAt.
  Append-only (no update/delete path; DB trigger as in M2).
- `core_cash_ledger` — id, userId, type, amount (Decimal 14,2, signed), orderId?, fillId?, token?, interestDate?,
  note, createdAt. Append-only (trigger). Unique (userId, token, interestDate) where type = MTF_INTEREST.
- `core_paper_defaults` — key, scope, numValue, note, updatedBy, updatedAt, with CHECKs, seeded between
  `-- SEED BEGIN/END` with `ON CONFLICT DO NOTHING`. Keys: `startingCapital` 1000000; `intradayLeverage` 5;
  `slippageBps@{CASH_INTRADAY,MTF,OPTIONS_BUY}`; `noPriceRejectMs`; `mtfFundedShare`; `mtfAnnualRatePct`;
  `mtfPledgeFee`; `maxLotsPerOrder@{NIFTY,BANKNIFTY,FINNIFTY,MIDCPNIFTY,SENSEX}`. Every value except E1/E2 is
  seeded with a "default — please review" note; the plan lists each seeded number for the owner.
- Owner-only editing of these defaults, audited, mirroring `CoreRiskDefaultsService` (API only; UI is M5).

### 4.6 Matching (approach A)

`PaperMatcherService` keeps open orders (NEW/OPEN/PARTIAL) in memory keyed by token. On placement it
`watch`es the ref at P0 via `hubFor(userId, 'positions')` with owner `core-order:<id>`; each price push for a
watched token evaluates that token's orders; a 1 s sweep handles `noPriceRejectMs` expiry and orders whose ref
had no push. Every state change is written to the DB in a transaction before memory is updated; on boot it
reloads open orders and re-watches them. A missing hub (`hubFor` → null) leaves orders open until the reject
timeout, so they fail as "no fresh price" rather than filling on stale data.

### 4.7 M2 ports rebound

- `RISK_STATE_PROVIDER`: deployed capital per vehicle and open positions come from the adapter (ledger + fills)
  instead of the fail-closed default. Fields M3 cannot yet supply (strategy P&L before M4/M5) stay fail-closed.
- `CORE_SQUARE_OFF`: cancels every pending core order for the user (exits of open core positions arrive with M4).

## 5. Error handling

Fail closed throughout: unpriceable, unsized, unfunded or unconfigured orders are REJECTED with a reason, never
left pending forever and never filled on a stale price. Idempotency key collisions return the existing order.
All writes are transactional (order state + fill + ledger rows together). The only cron pins
`timeZone: 'Asia/Kolkata'` (ratchet spec).

## 6. Testing

- **Pure:** fill model (depth walk, partial, no-depth slippage, strict trade-through, SL trigger and gap, stale
  and after-submission rule, lot multiple, max lots, side rules); order transitions; margin per vehicle; ledger
  math (average price, realised P&L, balance); charges per-leg golden test proving `estimateCharges` unchanged.
- **Adapter, per vehicle:** place → fill → exit → ledger reconciles; insufficient cash; cancel releases margin.
- **Idempotency:** same key twice → one order. **Restart:** recreate the matcher → open orders reload and fill.
- **MTF interest:** posts once per day, catches up a missed night, never twice.
- **Tenant:** user A's orders, fills and ledger never appear for user B.
- **Isolation:** no file outside `trade-core/` changes except `charges.ts` (behaviour-identical) and module wiring.
