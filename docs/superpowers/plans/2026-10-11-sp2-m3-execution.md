# SP2 M3 Execution (paper) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the execution layer every later SP2 milestone writes against: the `ExecutionAdapter` interface and a
`PaperExecutionAdapter` for CASH_INTRADAY, MTF and OPTIONS_BUY, with per-user orders (`core_orders`), append-only
fills (`core_fills`) and an append-only cash ledger (`core_cash_ledger`), a pure paper fill model, owner-editable
paper defaults (`core_paper_defaults`), an event-driven in-memory matcher fed by the market hub, nightly MTF
interest, and the M2 ports `RISK_STATE_PROVIDER` / `CORE_SQUARE_OFF` rebound to real data. Done when, for each
vehicle, an order placed through the adapter fills by the paper fill model, posts charges and margin to the
ledger, can be exited with realised P&L booked, and the ledger reconciles to its entries; the same idempotency
key twice returns the same order; open orders survive a restart; user A never affects user B. Nothing calls the
adapter in production until M5 (ships dark).

**Architecture:** A third part of `apps/api/src/modules/trade-core/`, `execution/`. Five pure modules carry the
rules: `order-state.ts` (transitions), `paper-settings.ts` (the defaults vocabulary, parsing, resolution),
`margin.ts` (margin per vehicle, proportional release), `ledger-math.ts` (money rounding, balances, average
price and realised P&L, MTF interest days) and `fill-model.ts` (freshness, depth walk, slippage, strict
trade-through limits, stop triggers, order validation). Thin repositories wrap Prisma; `CorePaperTx` runs one
transaction under a per-user advisory lock. `PaperLedgerService` owns every write (place, fill, close, modify,
interest) and every read (order, positions, funds) so the order row, its fill and its ledger rows always commit
together. `PaperMatcherService` holds open orders in memory keyed by `EXCHANGE:token`, watches each at
priority 0 through `hubFor(userId, 'positions')` with owner `core-order:<id>`, evaluates on hub price pushes and
a 1 s sweep, rejects orders that see no fresh price within `noPriceRejectMs`, and reloads open orders on boot.
`PaperExecutionAdapter` is the public face (validation, kill-switch and session gate, then the ledger service
and the matcher). `MtfInterestCron` posts interest at 15:35 IST through the job runner. Two small classes rebind
the M2 ports. Approach A: no old silo, table or service changes.

**Tech Stack:** NestJS 11, TypeScript 5.7, Prisma 6 (PostgreSQL) with `Prisma.Decimal` (decimal.js) for money,
`@nestjs/schedule` for the one cron, Jest 29 (`ts-jest`, `isolatedModules`) for the API; pnpm workspaces. The web
app is not touched in M3.

**Spec:** `docs/superpowers/specs/2026-10-11-sp2-m3-execution-design.md` (authoritative for M3; §1–§6), parent
`docs/superpowers/specs/2026-10-09-sp2-core-trade-lifecycle-design.md` (§3 layout and tenant scoping, §6
execution, §9 errors, §10 testing). Format precedent: `docs/superpowers/plans/2026-10-10-sp2-m2-risk-wall.md`.

**Branch:** `feature/sp2-m3-execution` (worktree `.claude/worktrees/sp2-m3-execution`), from `main` after the M2
merge (`17058f1`), HEAD `38ba410` when this plan was written.

**Test commands:** API Jest runs from `apps/api` (`rootDir` is `src`, `testRegex` `.*\.spec\.ts$`):
`cd apps/api && npx jest <path-or-pattern>`, e.g. `npx jest src/modules/trade-core/execution/order-state.spec.ts`.
The opt-in database test (Task 5) has its own config under `apps/api/test/sp2-m3/`. Web is not touched.

## Global Constraints

- **Fail closed:** an unpriceable, unsized, unfunded, unconfigured, out-of-session or kill-switched order is `REJECTED` with a reason; an open order is never pending forever (`noPriceRejectMs`) and never filled on a price older than 15 s or not strictly after its submission.
- **No hard-coded money or risk values (SP2 D4):** every key of spec §4.5 is a `core_paper_defaults` row (owner-editable, seeded "default — please review" except E1/E2); the only literals in new logic are shape bounds, `PRICE_MAX_AGE_MS = 15_000` (spec §4.3), the 1 s sweep, the 5 s settings cache and `charges.ts`' existing rate tables.
- **Approach A:** no old silo, table or service changes; outside `apps/api/src/modules/trade-core/` only `trade-sentinel/charges.ts` (behaviour-identical refactor, golden test), `prisma/schema.prisma` + the new migration, `common/tenant/tenant.constants.ts` and `common/audit/audit-actions.ts` (wiring and vocabulary, as in M2) change.
- **Per-user scoping:** every `core_orders`, `core_fills` and `core_cash_ledger` read and write names the userId taken from the caller (never a body); the only cross-user reads are two system scans (matcher boot reload, MTF interest) that then act per user; `core_paper_defaults` is the one global table; `CoreOrder`, `CoreFill`, `CoreCashLedger` join `TENANT_MODELS`.
- **Cron:** exactly one, `@Cron('0 35 15 * * 1-5', { name: 'core-mtf-interest', timeZone: 'Asia/Kolkata' })`; `common/schedule/cron-timezone.spec.ts` stays green and untouched.
- **`LIVE_TRADING_ENABLED` stays `false`** and is neither read nor written; nothing in production calls the adapter before M5.
- **Append-only:** `CoreFillRepository` and `CoreCashLedgerRepository` have no update or delete method, and a `BEFORE UPDATE` trigger (M2's `core_append_only_guard()`) refuses updates on `core_fills` and `core_cash_ledger`.
- **Money:** `Decimal(14,2)` for ledger amounts, `chargesTotal`, limit/trigger/ref prices and paper defaults; `Decimal(14,4)` for fill and average prices; all rupee arithmetic in `Prisma.Decimal`, rounded once per ledger row (`money()`, half-up; margin blocks round up).
- **Commits:** conventional commits with explicit pathspecs only (`git commit -m … -- <paths>`), never `git commit -a` or a bare commit (other agents share the tree); every message ends with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- **Typecheck:** new code adds no `tsc` error; compare the sorted error lists with `main` (Task 14), not the counts.

## Review Focus

1. **Depth present but one-sided, or with zero-quantity / non-positive levels.** A market BUY against a book with
   bids only must wait (no fill at a made-up price), zero-qty and zero-price levels must be skipped, and only a
   book with no usable level on either side may fall back to LTP ± slippage. (Task 4 tests "skips zero-quantity
   and non-positive levels", "a one-sided book waits instead of inventing a price", "an empty book, or none, falls back to LTP ±
   slippage".)
2. **A price whose `at` equals the order's `submittedAt` must never fill it (strictly after).** (Task 4 test "a
   price stamped exactly at submission is not after it"; Task 10 test "a push stamped at the submission instant
   does not fill; the next one does".)
3. **Partial fill then cancel releases exactly the unfilled margin, and the ledger stays equal to the sum of its
   rows with no rounding residue.** (Task 3 test "proportional releases add up to the block exactly"; Task 9
   test "a partial fill then a cancel releases exactly the unfilled part"; Task 11 tests "cash intraday: place →
   fill → exit → the ledger reconciles" and "partial fill, then cancel".)
4. **Restart mid-PARTIAL: the reloaded order is re-watched and filled for its remaining quantity only, once,
   even when a push and the sweep race.** (Task 10 tests "a recreated matcher reloads open orders, re-watches
   them and fills only what is left" and "a push and a sweep at once fill once".)
5. **MTF interest across a weekend and a missed night: one row per calendar day, caught up, never twice.**
   (Task 3 test "counts calendar days and catches up a weekend"; Task 12 tests "Monday's run posts Saturday,
   Sunday and Monday", "a second run the same day posts nothing" and "a missed night is caught up".)

## Seeded paper defaults (owner review, one place)

Every row lands in `core_paper_defaults` through the Task 5 migration's `-- SEED BEGIN/END` block and is
editable at any time by the owner through `PUT /api/trade-core/paper/defaults/:key/:scope` (Task 7). E1 and E2
are the owner's decisions; **every other number below is a conservative placeholder for the owner to verify
against Angel One's current terms and the current NSE circulars. None of them is authoritative.** Each is
seeded with the note "default — please review".

| Key @ scope | Seeded value | Source / rationale |
|---|---|---|
| `startingCapital@ALL` | ₹10,00,000.00 | Owner decision E1 (2026-10-11). |
| `intradayLeverage@CASH_INTRADAY` | 5.00 | Owner decision E2 (2026-10-11): margin = notional ÷ 5. |
| `slippageBps@CASH_INTRADAY` | 5 bps | default — please review. Used only when a price carries no depth; liquid NSE large caps quote a spread of a few bps, 5 is the wide end. |
| `slippageBps@MTF` | 5 bps | default — please review. Same NSE equities as cash. |
| `slippageBps@OPTIONS_BUY` | 50 bps | default — please review. Option spreads of ₹0.05–0.10 on ₹20–200 premiums are 2.5–50 bps; 50 is the wide end. |
| `noPriceRejectMs@ALL` | 30,000 ms | default — please review. Twice the 15 s freshness window before an unpriced order is rejected. |
| `mtfFundedShare@MTF` | 0.50 | default — please review. Funded share 0.50 = 2× leverage, the M2 `mtfMaxLeverage` default (2.00). Angel One's real funded share varies by stock. |
| `mtfAnnualRatePct@MTF` | 18.00 % a year | default — please review. Placeholder at the high end of commonly advertised MTF rates (≈0.05 % a day); verify Angel One's current rate. |
| `mtfPledgeFee@MTF` | ₹23.60 per MTF buy order | default — please review. Placeholder ₹20 + 18 % GST; verify Angel One's current pledge charge. |
| `maxLotsPerOrder@NIFTY` | 10 lots | default — please review (E4). Not an NSE freeze quantity: a deliberately small per-order cap. Option size is also bounded by M2's `optionsMaxPremiumPerTrade` (₹50,000). |
| `maxLotsPerOrder@BANKNIFTY` | 10 lots | default — please review (E4), as above. |
| `maxLotsPerOrder@FINNIFTY` | 10 lots | default — please review (E4), as above. |
| `maxLotsPerOrder@MIDCPNIFTY` | 10 lots | default — please review (E4), as above. |
| `maxLotsPerOrder@SENSEX` | 10 lots | default — please review (E4). SENSEX options trade on BFO, which is not a core venue yet (`VEHICLE_EXCHANGES.OPTIONS_BUY = ['NFO']`), so this row is inert until the owner adds BFO (Owner questions 1). |

The owner can add `maxLotsPerOrder@<UNDERLYING>` for any other underlying (stock options) with the same PUT; an
option order whose underlying has no row is rejected (fail closed).

## Planner rulings (where the code shaped the design)

1. **`cancel`, `modify` and `getOrder` take `userId`.** Spec §4.2 copies parent §6.1 (`cancel(orderId)`); parent §3
   requires every `core_*` query to filter by the user, so the M3 interface is `cancel(userId, orderId)`,
   `modify(userId, orderId, patch)`, `getOrder(userId, orderId)`. A foreign order id is a 404.
2. **`CoreOrderRequest` carries `refPrice`.** Spec §4.4 blocks margin "at the reference price"; a MARKET order has
   no price of its own, so the request carries the intent's `refPrice` (LIMIT blocks at its limit).
3. **One extra file, `paper-ledger.service.ts`.** The adapter needs the matcher (to track new orders) and the
   matcher needs to write fills; both go through `PaperLedgerService`, which owns every transaction. No cycle,
   and one place where order state, fill and ledger rows commit together (spec §5).
4. **Margin rows are split into a pending part and a filled part.** A `MARGIN_BLOCK`/`MARGIN_RELEASE` row with no
   `fillId` belongs to an order's unfilled qty; a row with a `fillId` belongs to the position. Each fill releases
   the pending part for its qty in proportion and blocks margin at the fill price (the "true-up" of spec §4.4);
   a cancel releases the order's pending rows exactly; an exit releases the position's rows in proportion and
   everything on the closing fill. No release ever recomputes a block from settings that may have changed, so
   no residue is left behind.
5. **One fill row per evaluation.** A depth walk across levels is one fill at the volume-weighted price, stored at
   4 dp and rounded against the trader (buy up, sell down); slippage prices round to the paisa against the
   trader. Charges are priced per fill as one executed leg (brokerage per fill: conservative for partial fills).
   The MTF pledge fee is charged once, on the first buy fill of an MTF order.
6. **Depth rules.** A depth with no usable level on either side counts as no depth (LTP ± slippage); a depth with
   usable levels only on the other side waits for the next price (it never invents a price); a book thinner than
   one lot waits. LIMIT fills the whole remainder at the limit on a strict trade-through (E3). An SL_MARKET order
   is "triggered" when the price reaches the trigger or once it has any fill, so a partly filled stop keeps
   filling as a market order.
7. **Placement gates.** Besides spec §4.3/§4.4, an order is `REJECTED` at placement when its exchange is out of
   session (`CORE_SESSION_CLOCK`) and an ENTRY when the user's core kill switch is on (an unreadable switch counts
   as on). Both are fail-closed defence in depth behind the Risk Wall.
8. **Malformed requests throw, business rejections persist.** A request with the wrong shape (unknown vehicle, qty
   not a positive integer, a 3-decimal price, LIMIT without a limit) is a programming error: `400`, nothing
   written. Every business rejection is a persisted `REJECTED` order with its reason, so the idempotency key
   keeps answering with it.
9. **The MTF interest uniqueness is a plain unique index plus a CHECK**, not a partial index: `(userId, token,
   interestDate)` is unique and `interestDate` is non-null exactly for `MTF_INTEREST` rows, so other rows (null
   date) never collide. Prisma models it, so the migration has no drift.
10. **MTF interest rule.** One row per IST calendar day from the holding's opening day (inclusive) through the run
    day, after the last posted day; the amount uses the holding's current funded amount for every day posted in
    that run. A holding closed before 15:35 is not charged for its exit day (Owner questions 3).
11. **`RISK_STATE_PROVIDER` still rejects every entry until M4.** It now reports real deployed capital per vehicle,
    open positions, today's net realised P&L and today's entries, but `openPnl` stays `null` (M4 marks positions
    to market) and every position is `priced: false`, so the wall answers `PNL_UNKNOWN` / `UNPRICED_POSITION`.
12. **`CORE_SQUARE_OFF` cancels through the ledger service and the matcher, not the adapter**, because the adapter
    injects `CoreKillSwitchService`, which injects `CORE_SQUARE_OFF` (a cycle). A partial cancellation throws so
    the kill-switch cascade reports `FAILED`, never a silent partial `OK`.
13. **The hub serves only the owner today** (`MarketHubService.hubFor`, `market-hub.service.ts:158-164`): another
    user's orders get no price and are rejected "no fresh price" after `noPriceRejectMs` (fail closed). Fills
    also need `HUB_PRICES_POSITIONS` on.
14. **The cron goes through `JobRunnerService`** (lease + `job_runs`, `onRedisError: 'run-anyway'`, safe because the
    unique index makes it idempotent). Adding it to `EXPECTED_JOBS` (`health-detail.service.ts:25`) is left to M5,
    because that file is outside `trade-core/`.

## File Structure

| Path | Responsibility |
|---|---|
| Modify `apps/api/src/modules/trade-sentinel/charges.ts` | Export `chargesForLeg` and `ChargeBreakdown`; `estimateCharges` rebuilt on the shared breakdown, bit-identical |
| Create `apps/api/src/modules/trade-core/execution/charges-golden.spec.ts`, `execution/testing/charges-golden.json` | Golden grid captured before the refactor |
| Create `apps/api/src/modules/trade-core/execution/charges-leg.spec.ts` | Per-leg charges |
| Create `apps/api/src/modules/trade-core/execution/execution.types.ts` | `ExecutionAdapter`, request/order/patch/fill/position/funds types, vocabularies |
| Create `apps/api/src/modules/trade-core/execution/order-state.ts` | Allowed transitions (pure) |
| Create `apps/api/src/modules/trade-core/execution/paper-settings.ts` | Defaults vocabulary, value parsing, `resolvePaperSettings` (pure) |
| Create `apps/api/src/modules/trade-core/execution/margin.ts` | Margin per vehicle, MTF funded amount, proportional release (pure) |
| Create `apps/api/src/modules/trade-core/execution/ledger-math.ts` | `money`, balances, position from fills, realised P&L, IST dates, MTF interest days (pure) |
| Create `apps/api/src/modules/trade-core/execution/fill-model.ts` | Freshness, `decideFill`, `validateOrder`, `requestProblems` (pure) |
| Create `apps/api/src/modules/trade-core/execution/testing/paper-fixtures.ts` | Seed rows, settings, requests, prices |
| Modify `prisma/schema.prisma` | `CoreOrder`, `CoreFill`, `CoreCashLedger`, `CorePaperDefault`; three `User` relation fields |
| Create `prisma/migrations/20261011120000_sp2_m3_execution/migration.sql` | Tables, CHECKs, append-only triggers, unique interest index, seed |
| Modify `apps/api/src/common/tenant/tenant.constants.ts` | Three tenant models |
| Create `apps/api/src/modules/trade-core/execution/core-paper-defaults.spec.ts` | Seed rows are valid, complete and labelled |
| Create `apps/api/test/sp2-m3/jest.config.js`, `apps/api/test/sp2-m3/core-execution.int.spec.ts` | Opt-in real-database test |
| Create `apps/api/src/modules/trade-core/execution/repositories/core-order.repository.ts` | Orders (guarded updates) |
| Create `apps/api/src/modules/trade-core/execution/repositories/core-fill.repository.ts` | Fills (append-only) |
| Create `apps/api/src/modules/trade-core/execution/repositories/core-cash-ledger.repository.ts` | Ledger (append-only, idempotent interest) |
| Create `apps/api/src/modules/trade-core/execution/repositories/core-paper-defaults.repository.ts` | Global defaults |
| Create `apps/api/src/modules/trade-core/execution/repositories/core-paper-tx.ts` | One transaction under the per-user lock |
| Modify `apps/api/src/common/audit/audit-actions.ts` | `paper` group |
| Create `apps/api/src/modules/trade-core/execution/services/core-paper-defaults.service.ts` | Cached settings, owner-only edit, audit |
| Create `apps/api/src/modules/trade-core/execution/controllers/core-paper-defaults.controller.ts` | `/api/trade-core/paper/defaults` |
| Create `apps/api/src/modules/trade-core/execution/paper-ledger.service.ts` | Every write and read of orders, fills and ledger |
| Create `apps/api/src/modules/trade-core/execution/testing/memory-paper-store.ts` | In-memory repositories + transaction for service tests |
| Create `apps/api/src/modules/trade-core/execution/paper-matcher.service.ts` | In-memory matching on hub pushes and a 1 s sweep |
| Create `apps/api/src/modules/trade-core/execution/testing/fake-hub.ts` | Fake `HubPrices` and source |
| Create `apps/api/src/modules/trade-core/execution/paper-execution.adapter.ts` | `ExecutionAdapter` implementation, `CORE_EXECUTION_ADAPTER` |
| Create `apps/api/src/modules/trade-core/execution/mtf-interest.cron.ts` | 15:35 IST interest job |
| Create `apps/api/src/modules/trade-core/execution/paper-risk-state.provider.ts` | `RISK_STATE_PROVIDER` binding |
| Create `apps/api/src/modules/trade-core/execution/paper-order-square-off.ts` | `CORE_SQUARE_OFF` binding |
| Modify `apps/api/src/modules/trade-core/trade-core.module.ts`, `trade-core.module.spec.ts` | Wiring |
| Create `apps/api/src/modules/trade-core/execution/execution-tenant.spec.ts` | Tenant isolation end to end |

---

### Task 1: Per-leg charges in `charges.ts`, proven behaviour-identical by a golden grid

**Files:**
- Create: `apps/api/src/modules/trade-core/execution/charges-golden.spec.ts`
- Create (generated, committed): `apps/api/src/modules/trade-core/execution/testing/charges-golden.json`
- Create: `apps/api/src/modules/trade-core/execution/charges-leg.spec.ts`
- Modify: `apps/api/src/modules/trade-sentinel/charges.ts`

**Interfaces:**
- Consumes: `Segment`, `Side`, `estimateCharges`, `RATES`, `legBrokerage`, `GST`, `DP_CHARGE_PER_SELL_RUPEES`
  (`trade-sentinel/charges.ts:24-195`).
- Produces (added to `charges.ts`; nothing existing changes its signature):

```typescript
export type LegSide = 'BUY' | 'SELL';
export interface ChargeBreakdown { brokerage: number; stt: number; exchangeTxn: number; stamp: number; sebi: number; dp: number; gst: number; total: number }
export interface LegChargeInput { segment: Segment; leg: LegSide; price: number; qty: number }
export function chargesForLeg(input: LegChargeInput): ChargeBreakdown;
export function estimateCharges(input: ChargeInput): number;   // unchanged signature, bit-identical outputs
```

The golden fixture must be captured from the **unchanged** `charges.ts` and committed before the file is edited.

- [ ] **Step 1: Write the golden spec**

Create `apps/api/src/modules/trade-core/execution/charges-golden.spec.ts`:

```typescript
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { estimateCharges, type Segment, type Side } from '../../trade-sentinel/charges';

/**
 * M3 refactors trade-sentinel/charges.ts into per-leg charges (spec §3). estimateCharges
 * feeds the sentinel's green floor, so its numbers must not move by one bit. The fixture
 * was captured from the UNCHANGED file with CAPTURE_CHARGES_GOLDEN=1 and is never
 * regenerated afterwards; JSON numbers round-trip doubles exactly, so Object.is is fair.
 */
const FIXTURE = join(__dirname, 'testing', 'charges-golden.json');
const SEGMENTS: Segment[] = ['EQ_DELIVERY', 'EQ_INTRADAY', 'FUT', 'OPT'];
const SIDES: Side[] = ['LONG', 'SHORT'];
const PRICES = [0.05, 1, 2.35, 99.95, 1234.5, 25000];
const QTYS = [1, 15, 75, 1000, 1800];
const ROWS = SEGMENTS.length * SIDES.length * PRICES.length * PRICES.length * QTYS.length;

interface GoldenInput {
  segment: Segment;
  side: Side;
  entryPrice: number;
  exitPrice: number;
  qty: number;
}
interface GoldenRow extends GoldenInput {
  charges: number;
}

function grid(): GoldenInput[] {
  const out: GoldenInput[] = [];
  for (const segment of SEGMENTS)
    for (const side of SIDES)
      for (const entryPrice of PRICES)
        for (const exitPrice of PRICES)
          for (const qty of QTYS) out.push({ segment, side, entryPrice, exitPrice, qty });
  return out;
}

describe('estimateCharges golden grid (M3 per-leg refactor)', () => {
  if (process.env.CAPTURE_CHARGES_GOLDEN === '1') {
    it('captures the fixture from the current charges.ts', () => {
      const rows: GoldenRow[] = grid().map((g) => ({ ...g, charges: estimateCharges(g) }));
      writeFileSync(FIXTURE, `${JSON.stringify(rows, null, 1)}\n`);
      expect(rows).toHaveLength(ROWS);
    });
    return;
  }

  it('returns exactly the captured number for every input', () => {
    expect(existsSync(FIXTURE)).toBe(true);
    const rows = JSON.parse(readFileSync(FIXTURE, 'utf8')) as GoldenRow[];
    expect(rows).toHaveLength(ROWS);
    const moved = rows.filter((r) => !Object.is(estimateCharges(r), r.charges));
    expect(moved).toEqual([]);
  });
});
```

- [ ] **Step 2: Capture the fixture from the unchanged file**

Confirm `git diff --stat -- apps/api/src/modules/trade-sentinel/charges.ts` is empty, then from `apps/api`:

Bash: `mkdir -p src/modules/trade-core/execution/testing && CAPTURE_CHARGES_GOLDEN=1 npx jest src/modules/trade-core/execution/charges-golden.spec.ts`
PowerShell: `New-Item -ItemType Directory -Force src/modules/trade-core/execution/testing; $env:CAPTURE_CHARGES_GOLDEN='1'; npx jest src/modules/trade-core/execution/charges-golden.spec.ts; Remove-Item Env:\CAPTURE_CHARGES_GOLDEN`

Expected: PASS (1 test, "captures the fixture"), and `src/modules/trade-core/execution/testing/charges-golden.json` exists with 1440 rows.

Run (without the variable): `npx jest src/modules/trade-core/execution/charges-golden.spec.ts`
Expected: PASS (1 test, "returns exactly the captured number").

- [ ] **Step 3: Commit the fixture before touching charges.ts**

```bash
git add -- apps/api/src/modules/trade-core/execution/charges-golden.spec.ts apps/api/src/modules/trade-core/execution/testing/charges-golden.json
git commit -m "test(trade-core): golden grid of estimateCharges captured before the per-leg refactor" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/api/src/modules/trade-core/execution/charges-golden.spec.ts apps/api/src/modules/trade-core/execution/testing/charges-golden.json
```

- [ ] **Step 4: Write the failing per-leg test**

Create `apps/api/src/modules/trade-core/execution/charges-leg.spec.ts`:

```typescript
import { chargesForLeg, estimateCharges, type ChargeBreakdown, type Segment } from '../../trade-sentinel/charges';

const parts = (b: ChargeBreakdown) => b.brokerage + b.stt + b.exchangeTxn + b.stamp + b.sebi + b.dp + b.gst;

describe('chargesForLeg (M3: charges per fill)', () => {
  it('an intraday buy leg pays stamp duty and no STT', () => {
    const b = chargesForLeg({ segment: 'EQ_INTRADAY', leg: 'BUY', price: 100, qty: 100 });
    expect(b.brokerage).toBe(20);
    expect(b.stt).toBe(0);
    expect(b.stamp).toBeCloseTo(0.3, 10);
    expect(b.exchangeTxn).toBeCloseTo(0.297, 10);
    expect(b.sebi).toBeCloseTo(0.01, 10);
    expect(b.dp).toBe(0);
    expect(b.gst).toBeCloseTo((20 + 0.297 + 0.01) * 0.18, 10);
    expect(b.total).toBeCloseTo(parts(b), 10);
  });

  it('an intraday sell leg pays STT and no stamp duty', () => {
    const s = chargesForLeg({ segment: 'EQ_INTRADAY', leg: 'SELL', price: 100, qty: 100 });
    expect(s.stt).toBeCloseTo(2.5, 10);
    expect(s.stamp).toBe(0);
    expect(s.total).toBeCloseTo(parts(s), 10);
  });

  it('delivery pays STT on both legs and the DP charge only on the sell leg', () => {
    const buy = chargesForLeg({ segment: 'EQ_DELIVERY', leg: 'BUY', price: 500, qty: 10 });
    const sell = chargesForLeg({ segment: 'EQ_DELIVERY', leg: 'SELL', price: 500, qty: 10 });
    expect(buy.stt).toBeCloseTo(5, 10);
    expect(sell.stt).toBeCloseTo(5, 10);
    expect(buy.brokerage).toBeCloseTo(5, 10);
    expect(buy.dp).toBe(0);
    expect(sell.dp).toBeCloseTo(15.93, 10);
  });

  it('options pay the flat ₹20 brokerage per leg even on a tiny premium', () => {
    expect(chargesForLeg({ segment: 'OPT', leg: 'BUY', price: 0.05, qty: 75 }).brokerage).toBe(20);
    expect(chargesForLeg({ segment: 'OPT', leg: 'SELL', price: 0.05, qty: 75 }).brokerage).toBe(20);
  });

  it('the two legs of a round trip add up to estimateCharges', () => {
    const cases: Array<[Segment, number, number, number]> = [
      ['EQ_INTRADAY', 500.7, 505, 100],
      ['EQ_DELIVERY', 1000.5, 1010, 10],
      ['OPT', 100, 110, 150],
      ['FUT', 24000, 23900, 75],
    ];
    for (const [segment, entry, exit, qty] of cases) {
      const legs = chargesForLeg({ segment, leg: 'BUY', price: entry, qty }).total + chargesForLeg({ segment, leg: 'SELL', price: exit, qty }).total;
      expect(legs).toBeCloseTo(estimateCharges({ segment, entryPrice: entry, exitPrice: exit, qty, side: 'LONG' }), 6);
    }
  });

  it('never returns a negative part', () => {
    for (const segment of ['EQ_DELIVERY', 'EQ_INTRADAY', 'FUT', 'OPT'] as Segment[]) {
      for (const leg of ['BUY', 'SELL'] as const) {
        const b = chargesForLeg({ segment, leg, price: 1, qty: 1 });
        expect(Object.values(b).every((v) => v >= 0)).toBe(true);
      }
    }
  });
});
```

- [ ] **Step 5: Run it to verify it fails**

Run: `npx jest src/modules/trade-core/execution/charges-leg.spec.ts`
Expected: FAIL with `chargesForLeg is not a function` (or TS2305 `has no exported member 'chargesForLeg'`).

- [ ] **Step 6: Refactor `charges.ts`**

In `apps/api/src/modules/trade-sentinel/charges.ts`, replace the whole `estimateCharges` function (the block that
starts `/** Total round-trip charges in rupees. Always >= 0. */` and ends with
`return brokerage + stt + exchange + stamp + sebi + dp + gst;\n}`) with:

```typescript
/** One executed order leg. SP2 M3 posts charges per fill, one leg at a time. */
export type LegSide = 'BUY' | 'SELL';

/** The parts of a charge, in rupees. `total` is their sum. */
export interface ChargeBreakdown {
  brokerage: number;
  stt: number;
  exchangeTxn: number;
  stamp: number;
  sebi: number;
  dp: number;
  gst: number;
  total: number;
}

/**
 * The charge parts for a buy turnover and a sell turnover. A round trip passes both
 * legs; a single leg passes the other turnover as 0 and its flag false (so the flat
 * options brokerage and the DP charge are not levied on a leg that did not happen).
 * The arithmetic is exactly the order estimateCharges always used, so its numbers are
 * bit-identical (trade-core/execution/charges-golden.spec.ts).
 */
function breakdown(segment: Segment, buyTurnover: number, sellTurnover: number, legs: { buy: boolean; sell: boolean }): ChargeBreakdown {
  const r = RATES[segment];
  const turnover = buyTurnover + sellTurnover;

  // Brokerage is per executed order, so price each leg on its own turnover.
  const brokerage = (legs.buy ? legBrokerage(segment, buyTurnover) : 0) + (legs.sell ? legBrokerage(segment, sellTurnover) : 0);

  const stt = sellTurnover * r.sttSell + buyTurnover * r.sttBuy;
  const exchangeTxn = turnover * r.exchangeTxn;
  const stamp = buyTurnover * r.stampBuy;
  const sebi = turnover * 0.000001;
  const dp = segment === 'EQ_DELIVERY' && legs.sell ? DP_CHARGE_PER_SELL_RUPEES : 0;
  const gst = (brokerage + exchangeTxn + sebi + dp) * GST;

  return { brokerage, stt, exchangeTxn, stamp, sebi, dp, gst, total: brokerage + stt + exchangeTxn + stamp + sebi + dp + gst };
}

export interface LegChargeInput {
  segment: Segment;
  leg: LegSide;
  price: number;
  qty: number;
}

/** Charges for one executed leg (SP2 M3: posted per fill). Every part >= 0. */
export function chargesForLeg({ segment, leg, price, qty }: LegChargeInput): ChargeBreakdown {
  const turnover = Math.abs(price * qty);
  return breakdown(segment, leg === 'BUY' ? turnover : 0, leg === 'SELL' ? turnover : 0, { buy: leg === 'BUY', sell: leg === 'SELL' });
}

/** Total round-trip charges in rupees. Always >= 0. */
export function estimateCharges({ segment, entryPrice, exitPrice, qty, side }: ChargeInput): number {
  const entryTurnover = Math.abs(entryPrice * qty);
  const exitTurnover = Math.abs(exitPrice * qty);

  // A LONG buys at entry and sells at exit; a SHORT does the reverse.
  const buyTurnover = side === 'LONG' ? entryTurnover : exitTurnover;
  const sellTurnover = side === 'LONG' ? exitTurnover : entryTurnover;

  return breakdown(segment, buyTurnover, sellTurnover, { buy: true, sell: true }).total;
}
```

Nothing else in `charges.ts` changes (`segmentFor`, `isDerivativeSegment`, `computeGreenFloor`, the rate tables).

- [ ] **Step 7: Run the per-leg test, the golden grid and the sentinel's own charges spec**

Run: `npx jest src/modules/trade-core/execution/charges-leg.spec.ts src/modules/trade-core/execution/charges-golden.spec.ts src/modules/trade-sentinel/charges.spec.ts src/modules/trade-sentinel/services/context-packet.service.spec.ts`
Expected: PASS (6 per-leg tests; 1 golden test with `moved` equal to `[]`; every existing sentinel test unchanged).
If the golden test lists any row, the refactor changed the arithmetic order: fix `breakdown`, never the fixture.

- [ ] **Step 8: Commit**

```bash
git add -- apps/api/src/modules/trade-sentinel/charges.ts apps/api/src/modules/trade-core/execution/charges-leg.spec.ts
git commit -m "refactor(trade-sentinel): per-leg charge breakdown; estimateCharges bit-identical (golden grid)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/api/src/modules/trade-sentinel/charges.ts apps/api/src/modules/trade-core/execution/charges-leg.spec.ts
```

---

### Task 2: Execution types and the order state machine

**Files:**
- Create: `apps/api/src/modules/trade-core/execution/execution.types.ts`
- Create: `apps/api/src/modules/trade-core/execution/order-state.ts`
- Test: `apps/api/src/modules/trade-core/execution/order-state.spec.ts`

**Interfaces:**
- Consumes: `Vehicle` (`strategies/blocks/block-types.ts:12`), `ChargeBreakdown`, `LegSide`, `Segment` (Task 1).
- Produces:

```typescript
// execution.types.ts
export const ORDER_STATES: readonly ['NEW', 'OPEN', 'PARTIAL', 'FILLED', 'CANCELLED', 'REJECTED'];
export type OrderState; export const ORDER_TYPES: readonly ['MARKET', 'LIMIT', 'SL_MARKET']; export type OrderType;
export type OrderSide = 'BUY' | 'SELL'; export type OrderPurpose = 'ENTRY' | 'EXIT';
export const LEDGER_TYPES: readonly ['DEPOSIT', 'MARGIN_BLOCK', 'MARGIN_RELEASE', 'REALISED_PNL', 'CHARGES', 'MTF_INTEREST']; export type LedgerType;
export interface CoreInstrument { exchange: string; token: string; symbol: string; lotSize: number; underlying: string | null }
export interface CoreOrderRequest { userId; idempotencyKey; vehicle: Vehicle; instrument: CoreInstrument; side: OrderSide; qty: number; type: OrderType; limitPrice: number | null; triggerPrice: number | null; refPrice: number; purpose: OrderPurpose; strategyVersionId: string | null }
export interface CoreOrderPatch { qty?: number; limitPrice?: number; triggerPrice?: number }
export interface CoreOrder { id; userId; idempotencyKey; vehicle; instrument; side; qty; filledQty; avgFillPrice: number | null; type; limitPrice: number | null; triggerPrice: number | null; refPrice: number; purpose; strategyVersionId: string | null; state: OrderState; rejectReason: string | null; submittedAt: Date; updatedAt: Date }
export interface FillCharges extends ChargeBreakdown { segment: Segment; leg: LegSide; pledgeFee: number }
export interface CorePositionView { key; vehicle; instrument; netQty; direction: 'LONG' | 'SHORT'; avgPrice: string; realisedPnl: string; blockedMargin: string; openedAt: Date }
export interface CoreFunds { userId; deposited; realisedPnl; charges; mtfInterest; cash; blockedMargin; freeCash: string; deployedByVehicle: Record<Vehicle, string> }
export interface ExecutionAdapter { placeOrder(req); cancel(userId, orderId); modify(userId, orderId, patch); getOrder(userId, orderId); getPositions(userId); getFunds(userId) }
// order-state.ts
export const ORDER_EVENTS: readonly ['ACCEPT', 'REJECT', 'PARTIAL_FILL', 'FILL', 'CANCEL']; export type OrderEvent;
export const OPEN_STATES: readonly OrderState[];            // NEW, OPEN, PARTIAL
export function isOpenState(s: OrderState): boolean;
export function nextState(from: OrderState, event: OrderEvent): OrderState | null;
export class IllegalOrderTransition extends Error {}
export function transition(from: OrderState, event: OrderEvent): OrderState;   // throws IllegalOrderTransition
```

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/modules/trade-core/execution/order-state.spec.ts`:

```typescript
import { ORDER_STATES } from './execution.types';
import { IllegalOrderTransition, isOpenState, nextState, OPEN_STATES, ORDER_EVENTS, transition } from './order-state';

describe('order state machine (spec §4.1: NEW → OPEN → PARTIAL → FILLED | CANCELLED | REJECTED)', () => {
  it('allows exactly these transitions', () => {
    const allowed: string[] = [];
    for (const s of ORDER_STATES) {
      for (const e of ORDER_EVENTS) {
        const n = nextState(s, e);
        if (n) allowed.push(`${s} -${e}-> ${n}`);
      }
    }
    expect(allowed.sort()).toEqual(
      [
        'NEW -ACCEPT-> OPEN',
        'NEW -REJECT-> REJECTED',
        'OPEN -CANCEL-> CANCELLED',
        'OPEN -FILL-> FILLED',
        'OPEN -PARTIAL_FILL-> PARTIAL',
        'OPEN -REJECT-> REJECTED',
        'PARTIAL -CANCEL-> CANCELLED',
        'PARTIAL -FILL-> FILLED',
        'PARTIAL -PARTIAL_FILL-> PARTIAL',
      ].sort(),
    );
  });

  it('terminal states accept no event', () => {
    for (const s of ['FILLED', 'CANCELLED', 'REJECTED'] as const) {
      expect(ORDER_EVENTS.map((e) => nextState(s, e))).toEqual(ORDER_EVENTS.map(() => null));
    }
  });

  it('transition returns the next state and throws on an illegal move', () => {
    expect(transition('NEW', 'ACCEPT')).toBe('OPEN');
    expect(() => transition('FILLED', 'CANCEL')).toThrow(IllegalOrderTransition);
    expect(() => transition('PARTIAL', 'REJECT')).toThrow('PARTIAL');
  });

  it('the open states are NEW, OPEN and PARTIAL', () => {
    expect(OPEN_STATES).toEqual(['NEW', 'OPEN', 'PARTIAL']);
    expect(ORDER_STATES.filter(isOpenState)).toEqual(['NEW', 'OPEN', 'PARTIAL']);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest src/modules/trade-core/execution/order-state.spec.ts`
Expected: FAIL with `Cannot find module './execution.types'`.

- [ ] **Step 3: Write the types**

Create `apps/api/src/modules/trade-core/execution/execution.types.ts`:

```typescript
import type { ChargeBreakdown, LegSide, Segment } from '../../trade-sentinel/charges';
import type { Vehicle } from '../strategies/blocks/block-types';

/**
 * SP2 M3 execution contracts (spec §4.2). Strategies and the lifecycle (M4/M5) write
 * against ExecutionAdapter; SP7 swaps in a live adapter. Prices on the request and the
 * order are rupees as numbers with at most 2 decimals (avgFillPrice 4); ledger money is
 * Prisma.Decimal inside the services and 2-dp strings on the views.
 */
export const ORDER_STATES = ['NEW', 'OPEN', 'PARTIAL', 'FILLED', 'CANCELLED', 'REJECTED'] as const;
export type OrderState = (typeof ORDER_STATES)[number];

export const ORDER_TYPES = ['MARKET', 'LIMIT', 'SL_MARKET'] as const;
export type OrderType = (typeof ORDER_TYPES)[number];

export type OrderSide = 'BUY' | 'SELL';
export type OrderPurpose = 'ENTRY' | 'EXIT';

export const LEDGER_TYPES = ['DEPOSIT', 'MARGIN_BLOCK', 'MARGIN_RELEASE', 'REALISED_PNL', 'CHARGES', 'MTF_INTEREST'] as const;
export type LedgerType = (typeof LEDGER_TYPES)[number];

/** A resolved contract (spec §3: the strike/expiry picker is M4/M5; the adapter takes what it is given). */
export interface CoreInstrument {
  exchange: string;
  token: string;
  symbol: string;
  /** 1 for cash and MTF; the contract lot size for options. */
  lotSize: number;
  /** Options: the index or stock the contract is on (maxLotsPerOrder is keyed by it). Null for cash and MTF. */
  underlying: string | null;
}

export interface CoreOrderRequest {
  userId: string;
  /** Unique across all orders; derived from CoreEntryIntent.intentId or the exit intent. */
  idempotencyKey: string;
  vehicle: Vehicle;
  instrument: CoreInstrument;
  side: OrderSide;
  /** Units (shares, or option units), a whole multiple of instrument.lotSize. */
  qty: number;
  type: OrderType;
  /** LIMIT only. */
  limitPrice: number | null;
  /** SL_MARKET only. */
  triggerPrice: number | null;
  /** ₹ per unit a MARKET or SL_MARKET entry blocks margin at (the intent's refPrice). LIMIT blocks at its limit. */
  refPrice: number;
  purpose: OrderPurpose;
  strategyVersionId: string | null;
}

/** What modify may change on an open order. */
export interface CoreOrderPatch {
  qty?: number;
  limitPrice?: number;
  triggerPrice?: number;
}

export interface CoreOrder {
  id: string;
  userId: string;
  idempotencyKey: string;
  vehicle: Vehicle;
  instrument: CoreInstrument;
  side: OrderSide;
  qty: number;
  filledQty: number;
  avgFillPrice: number | null;
  type: OrderType;
  limitPrice: number | null;
  triggerPrice: number | null;
  refPrice: number;
  purpose: OrderPurpose;
  strategyVersionId: string | null;
  state: OrderState;
  rejectReason: string | null;
  submittedAt: Date;
  updatedAt: Date;
}

/** The JSON stored on a fill: the per-leg breakdown plus the MTF pledge fee. `total` includes the fee. */
export interface FillCharges extends ChargeBreakdown {
  segment: Segment;
  leg: LegSide;
  pledgeFee: number;
}

/** A non-flat position on one (vehicle, token), derived from fills. */
export interface CorePositionView {
  /** `${vehicle}:${token}` */
  key: string;
  vehicle: Vehicle;
  instrument: CoreInstrument;
  /** Signed: positive long, negative short. */
  netQty: number;
  direction: 'LONG' | 'SHORT';
  /** 4 dp. */
  avgPrice: string;
  /** Gross realised P&L booked on this key so far, 2 dp. */
  realisedPnl: string;
  /** Margin the position holds, 2 dp. */
  blockedMargin: string;
  openedAt: Date;
}

/** The user's paper money (spec §4.4), every figure a 2-dp string. */
export interface CoreFunds {
  userId: string;
  deposited: string;
  realisedPnl: string;
  charges: string;
  mtfInterest: string;
  /** deposited + realisedPnl − charges − mtfInterest */
  cash: string;
  blockedMargin: string;
  /** cash − blockedMargin = the sum of every ledger row */
  freeCash: string;
  /** Margin held per vehicle: open positions plus the unfilled qty of open entry orders. */
  deployedByVehicle: Record<Vehicle, string>;
}

/**
 * Spec §4.2, with userId on the calls that name an existing order (plan ruling 1:
 * every core_* query is scoped to its user).
 */
export interface ExecutionAdapter {
  /** Idempotent on req.idempotencyKey. */
  placeOrder(req: CoreOrderRequest): Promise<CoreOrder>;
  cancel(userId: string, orderId: string): Promise<CoreOrder>;
  modify(userId: string, orderId: string, patch: CoreOrderPatch): Promise<CoreOrder>;
  getOrder(userId: string, orderId: string): Promise<CoreOrder>;
  getPositions(userId: string): Promise<CorePositionView[]>;
  getFunds(userId: string): Promise<CoreFunds>;
}
```

- [ ] **Step 4: Write the state machine**

Create `apps/api/src/modules/trade-core/execution/order-state.ts`:

```typescript
import type { OrderState } from './execution.types';

/**
 * The only place an order's state changes (spec §4.5: "State changes only through
 * order-state.ts"). A PARTIAL order has been priced, so it is never rejected for want
 * of a price; it can only fill further or be cancelled.
 */
export const ORDER_EVENTS = ['ACCEPT', 'REJECT', 'PARTIAL_FILL', 'FILL', 'CANCEL'] as const;
export type OrderEvent = (typeof ORDER_EVENTS)[number];

const TRANSITIONS: Readonly<Record<OrderState, Partial<Record<OrderEvent, OrderState>>>> = {
  NEW: { ACCEPT: 'OPEN', REJECT: 'REJECTED' },
  OPEN: { PARTIAL_FILL: 'PARTIAL', FILL: 'FILLED', CANCEL: 'CANCELLED', REJECT: 'REJECTED' },
  PARTIAL: { PARTIAL_FILL: 'PARTIAL', FILL: 'FILLED', CANCEL: 'CANCELLED' },
  FILLED: {},
  CANCELLED: {},
  REJECTED: {},
};

export const OPEN_STATES: readonly OrderState[] = ['NEW', 'OPEN', 'PARTIAL'];

export function isOpenState(s: OrderState): boolean {
  return OPEN_STATES.includes(s);
}

export function nextState(from: OrderState, event: OrderEvent): OrderState | null {
  return TRANSITIONS[from]?.[event] ?? null;
}

export class IllegalOrderTransition extends Error {
  constructor(from: OrderState, event: OrderEvent) {
    super(`an order in ${from} cannot take ${event}`);
    this.name = 'IllegalOrderTransition';
  }
}

export function transition(from: OrderState, event: OrderEvent): OrderState {
  const next = nextState(from, event);
  if (!next) throw new IllegalOrderTransition(from, event);
  return next;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx jest src/modules/trade-core/execution/order-state.spec.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add -- apps/api/src/modules/trade-core/execution/execution.types.ts apps/api/src/modules/trade-core/execution/order-state.ts apps/api/src/modules/trade-core/execution/order-state.spec.ts
git commit -m "feat(trade-core): execution contracts and the core order state machine" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/api/src/modules/trade-core/execution/execution.types.ts apps/api/src/modules/trade-core/execution/order-state.ts apps/api/src/modules/trade-core/execution/order-state.spec.ts
```

---

### Task 3: Paper settings, margin and ledger math (pure)

Ordered before the fill model (the suggested order had it after) because `validateOrder` reads `PaperSettings`.

**Files:**
- Create: `apps/api/src/modules/trade-core/execution/paper-settings.ts`
- Create: `apps/api/src/modules/trade-core/execution/margin.ts`
- Create: `apps/api/src/modules/trade-core/execution/ledger-math.ts`
- Create: `apps/api/src/modules/trade-core/execution/testing/paper-fixtures.ts`
- Test: `apps/api/src/modules/trade-core/execution/paper-settings.spec.ts`
- Test: `apps/api/src/modules/trade-core/execution/margin.spec.ts`
- Test: `apps/api/src/modules/trade-core/execution/ledger-math.spec.ts`

**Interfaces:**
- Consumes: `VEHICLES`, `Vehicle`; `CoreOrderRequest`, `LedgerType`, `OrderSide`, `OrderType` (Task 2); `Price`,
  `PriceDepth`, `HubExchange` (`market-hub/hub.types.ts`).
- Produces:

```typescript
// paper-settings.ts
export const PAPER_KEYS: readonly ['startingCapital', 'intradayLeverage', 'slippageBps', 'noPriceRejectMs', 'mtfFundedShare', 'mtfAnnualRatePct', 'mtfPledgeFee', 'maxLotsPerOrder']; export type PaperKey;
export const PAPER_KEY_SCOPES: Record<Exclude<PaperKey, 'maxLotsPerOrder'>, readonly string[]>;
export const UNDERLYING_SCOPE: RegExp;                       // /^[A-Z0-9&-]{1,30}$/
export const REQUIRED_PAPER_PAIRS: readonly string[];         // 9 "key@scope"
export function paperPairId(key: string, scope: string): string;
export function isPaperKey(k: string): k is PaperKey;
export function isPaperPair(key: string, scope: string): boolean;
export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };
export function parsePaperValue(key: PaperKey, raw: unknown): Parsed<Prisma.Decimal>;
export interface PaperSettings { startingCapital: Dec; intradayLeverage: Dec; slippageBps: Record<Vehicle, Dec>; noPriceRejectMs: number; mtfFundedShare: Dec; mtfAnnualRatePct: Dec; mtfPledgeFee: Dec; maxLotsPerOrder: Readonly<Record<string, number>> }
export interface PaperDefaultValue { key: string; scope: string; numValue: Prisma.Decimal }
export type PaperSettingsResult = { ok: true; settings: PaperSettings } | { ok: false; missing: string[] };
export function resolvePaperSettings(rows: readonly PaperDefaultValue[]): PaperSettingsResult;
// margin.ts
export function marginFor(vehicle: Vehicle, notional: Dec, s: Pick<PaperSettings, 'intradayLeverage' | 'mtfFundedShare'>): Dec;  // ROUND_UP to the paisa
export function mtfFunded(notional: Dec, s: Pick<PaperSettings, 'mtfFundedShare'>): Dec;
export function marginRefPrice(o: { type: OrderType; limitPrice: number | null; refPrice: number }): Dec;
export function proportionalRelease(held: Dec, qty: number, ofQty: number): Dec;
// ledger-math.ts
export const ZERO: Dec; export function money(v: string | number | Dec): Dec;
export interface LedgerAmount { type: LedgerType; amount: Dec }
export interface Balances { deposited; realisedPnl; charges; mtfInterest; cash; blockedMargin; freeCash: Dec }
export function balances(rows: readonly LedgerAmount[]): Balances;
export interface PositionFill { side: OrderSide; qty: number; price: Dec; at: Date }
export interface PositionState { netQty: number; avgPrice: Dec | null; realised: Dec; openedAt: Date | null }
export const FLAT: PositionState;
export function realisedOnReduce(avg: Dec, price: Dec, qty: number, direction: 1 | -1): Dec;
export function applyPositionFill(s: PositionState, f: PositionFill): { state: PositionState; realised: Dec | null };
export function positionFromFills(fills: readonly PositionFill[]): PositionState;
export function istDate(at: Date): string; export function nextDate(day: string): string;
export function mtfInterestDays(openedOn: string, lastPosted: string | null, upTo: string): string[];
export function dailyMtfInterest(funded: Dec, annualRatePct: Dec): Dec;
// testing/paper-fixtures.ts
export const NOW: Date; export const SEED_ROWS: PaperDefaultValue[]; export function paperSettings(over?): PaperSettings;
export function cashBuy(over?): CoreOrderRequest; export function mtfBuy(over?): CoreOrderRequest; export function optionBuy(over?): CoreOrderRequest;
export function depth(asks: Array<[number, number]>, bids?: Array<[number, number]>): PriceDepth;
export function hubPrice(req: Pick<CoreOrderRequest, 'instrument'>, ltp: number, at: number, book?: PriceDepth): Price;
```

- [ ] **Step 1: Write the fixtures**

Create `apps/api/src/modules/trade-core/execution/testing/paper-fixtures.ts`:

```typescript
import { Prisma } from '@prisma/client';
import type { HubExchange, Price, PriceDepth } from '../../../market-hub/hub.types';
import type { CoreOrderRequest } from '../execution.types';
import { resolvePaperSettings, type PaperDefaultValue, type PaperSettings } from '../paper-settings';

const D = (s: string) => new Prisma.Decimal(s);

/** Monday 2026-10-12, 10:30 IST. */
export const NOW = new Date('2026-10-12T05:00:00.000Z');

/** The Task 5 migration's seed rows, as values (core-paper-defaults.spec.ts checks they match). */
export const SEED_ROWS: PaperDefaultValue[] = [
  { key: 'startingCapital', scope: 'ALL', numValue: D('1000000.00') },
  { key: 'intradayLeverage', scope: 'CASH_INTRADAY', numValue: D('5.00') },
  { key: 'slippageBps', scope: 'CASH_INTRADAY', numValue: D('5.00') },
  { key: 'slippageBps', scope: 'MTF', numValue: D('5.00') },
  { key: 'slippageBps', scope: 'OPTIONS_BUY', numValue: D('50.00') },
  { key: 'noPriceRejectMs', scope: 'ALL', numValue: D('30000') },
  { key: 'mtfFundedShare', scope: 'MTF', numValue: D('0.50') },
  { key: 'mtfAnnualRatePct', scope: 'MTF', numValue: D('18.00') },
  { key: 'mtfPledgeFee', scope: 'MTF', numValue: D('23.60') },
  { key: 'maxLotsPerOrder', scope: 'NIFTY', numValue: D('10') },
  { key: 'maxLotsPerOrder', scope: 'BANKNIFTY', numValue: D('10') },
  { key: 'maxLotsPerOrder', scope: 'FINNIFTY', numValue: D('10') },
  { key: 'maxLotsPerOrder', scope: 'MIDCPNIFTY', numValue: D('10') },
  { key: 'maxLotsPerOrder', scope: 'SENSEX', numValue: D('10') },
];

export function paperSettings(over: Partial<PaperSettings> = {}): PaperSettings {
  const r = resolvePaperSettings(SEED_ROWS);
  if (!r.ok) throw new Error(`fixture settings incomplete: ${r.missing.join(', ')}`);
  return { ...r.settings, ...over };
}

export function cashBuy(over: Partial<CoreOrderRequest> = {}): CoreOrderRequest {
  return {
    userId: 'user_A',
    idempotencyKey: 'intent_cash_1:entry',
    vehicle: 'CASH_INTRADAY',
    instrument: { exchange: 'NSE', token: '2885', symbol: 'RELIANCE-EQ', lotSize: 1, underlying: null },
    side: 'BUY',
    qty: 100,
    type: 'MARKET',
    limitPrice: null,
    triggerPrice: null,
    refPrice: 500,
    purpose: 'ENTRY',
    strategyVersionId: 'ver_1',
    ...over,
  };
}

export function mtfBuy(over: Partial<CoreOrderRequest> = {}): CoreOrderRequest {
  return cashBuy({
    idempotencyKey: 'intent_mtf_1:entry',
    vehicle: 'MTF',
    instrument: { exchange: 'NSE', token: '1594', symbol: 'INFY-EQ', lotSize: 1, underlying: null },
    qty: 10,
    refPrice: 1000,
    ...over,
  });
}

export function optionBuy(over: Partial<CoreOrderRequest> = {}): CoreOrderRequest {
  return cashBuy({
    idempotencyKey: 'intent_opt_1:entry',
    vehicle: 'OPTIONS_BUY',
    instrument: { exchange: 'NFO', token: '43521', symbol: 'NIFTY13OCT2625000CE', lotSize: 75, underlying: 'NIFTY' },
    qty: 150,
    type: 'LIMIT',
    limitPrice: 100,
    refPrice: 100,
    ...over,
  });
}

export function depth(asks: Array<[number, number]>, bids: Array<[number, number]> = []): PriceDepth {
  return {
    asks: asks.map(([price, qty]) => ({ price, qty, orders: 1 })),
    bids: bids.map(([price, qty]) => ({ price, qty, orders: 1 })),
  };
}

export function hubPrice(req: Pick<CoreOrderRequest, 'instrument'>, ltp: number, at: number, book?: PriceDepth): Price {
  return {
    ref: { exchange: req.instrument.exchange as HubExchange, token: req.instrument.token, symbol: req.instrument.symbol },
    ltp,
    at,
    source: 'ws',
    ...(book ? { depth: book } : {}),
  };
}
```

- [ ] **Step 2: Write the failing tests**

Create `apps/api/src/modules/trade-core/execution/paper-settings.spec.ts`:

```typescript
import { Prisma } from '@prisma/client';
import { isPaperPair, parsePaperValue, REQUIRED_PAPER_PAIRS, resolvePaperSettings, type PaperKey } from './paper-settings';
import { SEED_ROWS } from './testing/paper-fixtures';

const ok = (key: PaperKey, v: unknown) => parsePaperValue(key, v).ok;

describe('paper settings vocabulary (spec §4.5)', () => {
  it('knows each fixed pair, and any upper-case underlying for maxLotsPerOrder', () => {
    expect(isPaperPair('startingCapital', 'ALL')).toBe(true);
    expect(isPaperPair('startingCapital', 'MTF')).toBe(false);
    expect(isPaperPair('slippageBps', 'OPTIONS_BUY')).toBe(true);
    expect(isPaperPair('intradayLeverage', 'MTF')).toBe(false);
    expect(isPaperPair('maxLotsPerOrder', 'NIFTY')).toBe(true);
    expect(isPaperPair('maxLotsPerOrder', 'M&M')).toBe(true);
    expect(isPaperPair('maxLotsPerOrder', 'nifty')).toBe(false);
    expect(isPaperPair('maxLotsPerOrder', 'ALL')).toBe(false);
    expect(isPaperPair('maxLotsPerOrder', 'MTF')).toBe(false);
    expect(isPaperPair('nope', 'ALL')).toBe(false);
  });

  it('parses each key within its shape bounds', () => {
    expect(ok('startingCapital', 1000000)).toBe(true);
    expect(ok('startingCapital', 0)).toBe(false);
    expect(ok('startingCapital', -5)).toBe(false);
    expect(ok('startingCapital', '1.234')).toBe(false);
    expect(ok('startingCapital', 'abc')).toBe(false);
    expect(ok('startingCapital', null)).toBe(false);
    expect(ok('intradayLeverage', 1)).toBe(true);
    expect(ok('intradayLeverage', 0.5)).toBe(false);
    expect(ok('slippageBps', 0)).toBe(true);
    expect(ok('slippageBps', 10001)).toBe(false);
    expect(ok('noPriceRejectMs', 30000)).toBe(true);
    expect(ok('noPriceRejectMs', 999)).toBe(false);
    expect(ok('noPriceRejectMs', '1500.5')).toBe(false);
    expect(ok('mtfFundedShare', 0.5)).toBe(true);
    expect(ok('mtfFundedShare', 1)).toBe(false);
    expect(ok('mtfAnnualRatePct', 18)).toBe(true);
    expect(ok('mtfAnnualRatePct', 100.01)).toBe(false);
    expect(ok('mtfPledgeFee', '23.60')).toBe(true);
    expect(ok('maxLotsPerOrder', 10)).toBe(true);
    expect(ok('maxLotsPerOrder', 0)).toBe(false);
    expect(ok('maxLotsPerOrder', 2.5)).toBe(false);
  });

  it('resolves the seed rows', () => {
    const r = resolvePaperSettings(SEED_ROWS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.settings.startingCapital.toFixed(2)).toBe('1000000.00');
    expect(r.settings.intradayLeverage.toFixed(2)).toBe('5.00');
    expect(Object.fromEntries(Object.entries(r.settings.slippageBps).map(([v, d]) => [v, d.toFixed(2)]))).toEqual({ CASH_INTRADAY: '5.00', MTF: '5.00', OPTIONS_BUY: '50.00' });
    expect(r.settings.noPriceRejectMs).toBe(30000);
    expect(r.settings.mtfFundedShare.toFixed(2)).toBe('0.50');
    expect(r.settings.maxLotsPerOrder).toEqual({ NIFTY: 10, BANKNIFTY: 10, FINNIFTY: 10, MIDCPNIFTY: 10, SENSEX: 10 });
  });

  it('fails closed, naming every missing or malformed required pair', () => {
    const rows = SEED_ROWS.filter((r) => r.key !== 'mtfPledgeFee').map((r) => (r.key === 'intradayLeverage' ? { ...r, numValue: new Prisma.Decimal('0.5') } : r));
    expect(resolvePaperSettings(rows)).toEqual({ ok: false, missing: ['intradayLeverage@CASH_INTRADAY', 'mtfPledgeFee@MTF'] });
    expect(resolvePaperSettings([])).toEqual({ ok: false, missing: [...REQUIRED_PAPER_PAIRS] });
  });

  it('an underlying with no maxLotsPerOrder row does not block the rest (its orders are rejected one by one)', () => {
    const r = resolvePaperSettings(SEED_ROWS.filter((row) => row.key !== 'maxLotsPerOrder'));
    expect(r.ok && r.settings.maxLotsPerOrder).toEqual({});
  });
});
```

Create `apps/api/src/modules/trade-core/execution/margin.spec.ts`:

```typescript
import { Prisma } from '@prisma/client';
import { marginFor, marginRefPrice, mtfFunded, proportionalRelease } from './margin';
import { paperSettings } from './testing/paper-fixtures';

const D = (s: string) => new Prisma.Decimal(s);
const s = paperSettings();

describe('margin (spec §4.4)', () => {
  it('cash intraday blocks notional ÷ intradayLeverage (E2)', () => {
    expect(marginFor('CASH_INTRADAY', D('50070'), s).toFixed(2)).toBe('10014.00');
  });

  it('MTF blocks the own share, notional × (1 − mtfFundedShare)', () => {
    expect(marginFor('MTF', D('10005'), s).toFixed(2)).toBe('5002.50');
    expect(mtfFunded(D('10005'), s).toFixed(2)).toBe('5002.50');
  });

  it('options block the full premium', () => {
    expect(marginFor('OPTIONS_BUY', D('15000'), s).toFixed(2)).toBe('15000.00');
  });

  it('rounds a block up to the paisa, never under-blocking', () => {
    expect(marginFor('CASH_INTRADAY', D('100.01'), s).toFixed(2)).toBe('20.01');
  });

  it('a LIMIT order blocks at its limit, anything else at refPrice', () => {
    expect(marginRefPrice({ type: 'LIMIT', limitPrice: 99.5, refPrice: 100 }).toFixed(2)).toBe('99.50');
    expect(marginRefPrice({ type: 'MARKET', limitPrice: null, refPrice: 100 }).toFixed(2)).toBe('100.00');
    expect(marginRefPrice({ type: 'SL_MARKET', limitPrice: null, refPrice: 95 }).toFixed(2)).toBe('95.00');
  });

  it('proportional releases add up to the block exactly, with nothing left over', () => {
    let held = D('10000.01');
    let released = D('0');
    for (const [qty, of] of [[3, 7], [2, 4], [2, 2]] as const) {
      const r = proportionalRelease(held, qty, of);
      released = released.plus(r);
      held = held.minus(r);
    }
    expect(released.toFixed(2)).toBe('10000.01');
    expect(held.toFixed(2)).toBe('0.00');
    expect(proportionalRelease(D('100'), 5, 5).toFixed(2)).toBe('100.00');
    expect(proportionalRelease(D('0'), 1, 2).toFixed(2)).toBe('0.00');
    expect(proportionalRelease(D('100'), 1, 0).toFixed(2)).toBe('0.00');
  });
});
```

Create `apps/api/src/modules/trade-core/execution/ledger-math.spec.ts`:

```typescript
import { Prisma } from '@prisma/client';
import type { LedgerType } from './execution.types';
import {
  applyPositionFill,
  balances,
  dailyMtfInterest,
  FLAT,
  istDate,
  money,
  mtfInterestDays,
  positionFromFills,
} from './ledger-math';
import { NOW } from './testing/paper-fixtures';

const D = (s: string) => new Prisma.Decimal(s);
const row = (type: LedgerType, amount: string) => ({ type, amount: D(amount) });
const at = (ms: number) => new Date(NOW.getTime() + ms);

describe('money and balances (spec §4.4)', () => {
  it('rounds half-up to the paisa', () => {
    expect(money('1.005').toFixed(2)).toBe('1.01');
    expect(money('-1.005').toFixed(2)).toBe('-1.01');
    expect(money('2.4669').toFixed(2)).toBe('2.47');
  });

  it('cash, blocked margin and free cash; free cash is the sum of every row', () => {
    const rows = [
      row('DEPOSIT', '1000000.00'),
      row('MARGIN_BLOCK', '-10000.00'),
      row('MARGIN_RELEASE', '10000.00'),
      row('MARGIN_BLOCK', '-10014.00'),
      row('CHARGES', '-26.92'),
    ];
    const open = balances(rows);
    expect(open.blockedMargin.toFixed(2)).toBe('10014.00');
    expect(open.cash.toFixed(2)).toBe('999973.08');
    expect(open.freeCash.toFixed(2)).toBe('989959.08');
    const closed = balances([...rows, row('REALISED_PNL', '430.00'), row('CHARGES', '-38.05'), row('MARGIN_RELEASE', '10014.00'), row('MTF_INTEREST', '-2.47')]);
    expect(closed.blockedMargin.toFixed(2)).toBe('0.00');
    expect(closed.charges.toFixed(2)).toBe('64.97');
    expect(closed.mtfInterest.toFixed(2)).toBe('2.47');
    expect(closed.cash.toFixed(2)).toBe('1000362.56');
    expect(closed.freeCash.toFixed(2)).toBe('1000362.56');
  });
});

describe('position from fills', () => {
  it('averages the entry price and books realised P&L on the exit', () => {
    const s1 = applyPositionFill(FLAT, { side: 'BUY', qty: 60, price: D('500.5'), at: at(0) });
    const s2 = applyPositionFill(s1.state, { side: 'BUY', qty: 40, price: D('501'), at: at(1) });
    expect(s2.state.netQty).toBe(100);
    expect(s2.state.avgPrice?.toFixed(4)).toBe('500.7000');
    expect(s2.state.openedAt).toEqual(at(0));
    const exit = applyPositionFill(s2.state, { side: 'SELL', qty: 100, price: D('505'), at: at(2) });
    expect(exit.realised?.toFixed(2)).toBe('430.00');
    expect(exit.state.netQty).toBe(0);
    expect(exit.state.avgPrice).toBeNull();
    expect(exit.state.openedAt).toBeNull();
    expect(exit.state.realised.toFixed(2)).toBe('430.00');
  });

  it('a short realises (entry − exit) × qty', () => {
    const s = positionFromFills([
      { side: 'SELL', qty: 10, price: D('200'), at: at(0) },
      { side: 'BUY', qty: 4, price: D('190'), at: at(1) },
    ]);
    expect(s.netQty).toBe(-6);
    expect(s.realised.toFixed(2)).toBe('40.00');
    expect(s.avgPrice?.toFixed(2)).toBe('200.00');
  });

  it('refuses a fill that would flip the position', () => {
    const long = applyPositionFill(FLAT, { side: 'BUY', qty: 5, price: D('10'), at: at(0) }).state;
    expect(() => applyPositionFill(long, { side: 'SELL', qty: 6, price: D('11'), at: at(1) })).toThrow('flip');
  });
});

describe('MTF interest days (spec §4.4)', () => {
  it('counts calendar days and catches up a weekend', () => {
    expect(mtfInterestDays('2026-10-09', '2026-10-09', '2026-10-12')).toEqual(['2026-10-10', '2026-10-11', '2026-10-12']);
  });

  it('charges the opening day on the first run, and nothing twice', () => {
    expect(mtfInterestDays('2026-10-12', null, '2026-10-12')).toEqual(['2026-10-12']);
    expect(mtfInterestDays('2026-10-09', '2026-10-12', '2026-10-12')).toEqual([]);
  });

  it('ignores a posting from an earlier holding of the same token, and crosses a month end', () => {
    expect(mtfInterestDays('2026-10-30', '2026-10-01', '2026-11-02')).toEqual(['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
  });

  it('a day of interest is funded × rate ÷ 100 ÷ 365, to the paisa', () => {
    expect(dailyMtfInterest(D('5002.50'), D('18')).toFixed(2)).toBe('2.47');
  });

  it('IST dates roll at 18:30 UTC', () => {
    expect(istDate(new Date('2026-10-11T18:29:59.999Z'))).toBe('2026-10-11');
    expect(istDate(new Date('2026-10-11T18:30:00.000Z'))).toBe('2026-10-12');
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx jest src/modules/trade-core/execution/paper-settings.spec.ts src/modules/trade-core/execution/margin.spec.ts src/modules/trade-core/execution/ledger-math.spec.ts`
Expected: FAIL with `Cannot find module './paper-settings'`, `'./margin'` and `'./ledger-math'`.

- [ ] **Step 4: Write `paper-settings.ts`**

```typescript
import { Prisma } from '@prisma/client';
import { VEHICLES, type Vehicle } from '../strategies/blocks/block-types';

const D = Prisma.Decimal;
type Dec = Prisma.Decimal;

/**
 * The paper settings vocabulary (spec §4.5). Values are rows in core_paper_defaults
 * (D4: never constants in code); this file only knows the keys, their scopes and each
 * key's admissible SHAPE. maxLotsPerOrder is scoped by option underlying (E4) and is
 * open-ended so the owner can add a stock's row without a migration.
 */
export const PAPER_KEYS = [
  'startingCapital',
  'intradayLeverage',
  'slippageBps',
  'noPriceRejectMs',
  'mtfFundedShare',
  'mtfAnnualRatePct',
  'mtfPledgeFee',
  'maxLotsPerOrder',
] as const;
export type PaperKey = (typeof PAPER_KEYS)[number];

export const PAPER_KEY_SCOPES: Readonly<Record<Exclude<PaperKey, 'maxLotsPerOrder'>, readonly string[]>> = {
  startingCapital: ['ALL'],
  intradayLeverage: ['CASH_INTRADAY'],
  slippageBps: VEHICLES,
  noPriceRejectMs: ['ALL'],
  mtfFundedShare: ['MTF'],
  mtfAnnualRatePct: ['MTF'],
  mtfPledgeFee: ['MTF'],
};

/** An option underlying as the instrument master names it (NIFTY, BANKNIFTY, M&M, BAJAJ-AUTO). */
export const UNDERLYING_SCOPE = /^[A-Z0-9&-]{1,30}$/;
const RESERVED_SCOPES: readonly string[] = ['ALL', ...VEHICLES];

export const paperPairId = (key: string, scope: string): string => `${key}@${scope}`;

/** Every order needs these; a missing one rejects every order (fail closed). */
export const REQUIRED_PAPER_PAIRS: readonly string[] = (Object.keys(PAPER_KEY_SCOPES) as Array<keyof typeof PAPER_KEY_SCOPES>).flatMap(
  (key) => PAPER_KEY_SCOPES[key].map((scope) => paperPairId(key, scope)),
);

export function isPaperKey(k: string): k is PaperKey {
  return (PAPER_KEYS as readonly string[]).includes(k);
}

export function isPaperPair(key: string, scope: string): boolean {
  if (!isPaperKey(key)) return false;
  if (key === 'maxLotsPerOrder') return UNDERLYING_SCOPE.test(scope) && !RESERVED_SCOPES.includes(scope);
  return PAPER_KEY_SCOPES[key].includes(scope);
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const fail = (error: string): Parsed<Dec> => ({ ok: false, error });
const okValue = (value: Dec): Parsed<Dec> => ({ ok: true, value });

/** Shape bounds only (no money or risk values): what a value of this key can be. Mirrors the migration's CHECK. */
export function parsePaperValue(key: PaperKey, raw: unknown): Parsed<Dec> {
  const text = typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : typeof raw === 'string' ? raw.trim() : null;
  if (text === null || !/^\d+(\.\d{1,2})?$/.test(text)) return fail('must be a number of 0 or more with at most 2 decimals');
  const v = new D(text);
  if (v.gt('999999999999.99')) return fail('is too large');
  switch (key) {
    case 'startingCapital':
      return v.gt(0) ? okValue(v) : fail('must be above 0');
    case 'intradayLeverage':
      return v.gte(1) ? okValue(v) : fail('must be at least 1');
    case 'slippageBps':
      return v.lte(10000) ? okValue(v) : fail('must be at most 10000 bps');
    case 'noPriceRejectMs':
      return v.isInteger() && v.gte(1000) ? okValue(v) : fail('must be a whole number of milliseconds, at least 1000');
    case 'mtfFundedShare':
      return v.lt(1) ? okValue(v) : fail('must be below 1 (the fraction of the notional the broker funds)');
    case 'mtfAnnualRatePct':
      return v.lte(100) ? okValue(v) : fail('must be at most 100 (percent a year)');
    case 'mtfPledgeFee':
      return okValue(v);
    case 'maxLotsPerOrder':
      return v.isInteger() && v.gte(1) ? okValue(v) : fail('must be a whole number of lots, at least 1');
  }
}

export interface PaperSettings {
  startingCapital: Dec;
  intradayLeverage: Dec;
  slippageBps: Record<Vehicle, Dec>;
  noPriceRejectMs: number;
  mtfFundedShare: Dec;
  mtfAnnualRatePct: Dec;
  mtfPledgeFee: Dec;
  /** Lots per order by option underlying; an underlying absent here rejects its orders. */
  maxLotsPerOrder: Readonly<Record<string, number>>;
}

export interface PaperDefaultValue {
  key: string;
  scope: string;
  numValue: Dec;
}

export type PaperSettingsResult = { ok: true; settings: PaperSettings } | { ok: false; missing: string[] };

/** The settings from the default rows (per-user overrides are a later milestone). Fails closed on any required pair. */
export function resolvePaperSettings(rows: readonly PaperDefaultValue[]): PaperSettingsResult {
  const valid = new Map<string, Dec>();
  for (const r of rows) {
    if (!isPaperPair(r.key, r.scope)) continue;
    const parsed = parsePaperValue(r.key as PaperKey, r.numValue.toString());
    if (parsed.ok) valid.set(paperPairId(r.key, r.scope), parsed.value);
  }
  const missing = REQUIRED_PAPER_PAIRS.filter((id) => !valid.has(id));
  if (missing.length > 0) return { ok: false, missing };
  const get = (key: string, scope: string) => valid.get(paperPairId(key, scope)) as Dec;
  const maxLotsPerOrder: Record<string, number> = {};
  for (const [id, v] of valid) {
    if (id.startsWith('maxLotsPerOrder@')) maxLotsPerOrder[id.slice('maxLotsPerOrder@'.length)] = v.toNumber();
  }
  return {
    ok: true,
    settings: {
      startingCapital: get('startingCapital', 'ALL'),
      intradayLeverage: get('intradayLeverage', 'CASH_INTRADAY'),
      slippageBps: Object.fromEntries(VEHICLES.map((v) => [v, get('slippageBps', v)])) as Record<Vehicle, Dec>,
      noPriceRejectMs: get('noPriceRejectMs', 'ALL').toNumber(),
      mtfFundedShare: get('mtfFundedShare', 'MTF'),
      mtfAnnualRatePct: get('mtfAnnualRatePct', 'MTF'),
      mtfPledgeFee: get('mtfPledgeFee', 'MTF'),
      maxLotsPerOrder,
    },
  };
}
```

- [ ] **Step 5: Write `margin.ts`**

```typescript
import { Prisma } from '@prisma/client';
import type { Vehicle } from '../strategies/blocks/block-types';
import type { OrderType } from './execution.types';
import type { PaperSettings } from './paper-settings';

const D = Prisma.Decimal;
type Dec = Prisma.Decimal;

function rawMargin(vehicle: Vehicle, notional: Dec, s: Pick<PaperSettings, 'intradayLeverage' | 'mtfFundedShare'>): Dec {
  if (vehicle === 'CASH_INTRADAY') return notional.div(s.intradayLeverage);
  if (vehicle === 'MTF') return notional.mul(new D(1).minus(s.mtfFundedShare));
  return notional; // OPTIONS_BUY: the full premium
}

/** Margin a notional blocks (spec §4.4), rounded UP to the paisa so a block is never short. */
export function marginFor(vehicle: Vehicle, notional: Dec, s: Pick<PaperSettings, 'intradayLeverage' | 'mtfFundedShare'>): Dec {
  return rawMargin(vehicle, notional, s).toDecimalPlaces(2, D.ROUND_UP);
}

/** The broker-funded part of an MTF notional: interest accrues on it (spec §4.4). */
export function mtfFunded(notional: Dec, s: Pick<PaperSettings, 'mtfFundedShare'>): Dec {
  return notional.mul(s.mtfFundedShare).toDecimalPlaces(2, D.ROUND_HALF_UP);
}

/** ₹ per unit an order's unfilled qty is blocked at: the limit for LIMIT, else refPrice (plan ruling 2). */
export function marginRefPrice(o: { type: OrderType; limitPrice: number | null; refPrice: number }): Dec {
  return new D(o.type === 'LIMIT' && o.limitPrice !== null ? o.limitPrice : o.refPrice);
}

/**
 * What releasing `qty` of `ofQty` frees from `held`: in proportion, rounded down, and
 * everything on the last part, so a sequence of releases never leaves a residue.
 */
export function proportionalRelease(held: Dec, qty: number, ofQty: number): Dec {
  if (ofQty <= 0 || qty <= 0 || held.lte(0)) return new D(0);
  if (qty >= ofQty) return held;
  return held.mul(qty).div(ofQty).toDecimalPlaces(2, D.ROUND_DOWN);
}
```

- [ ] **Step 6: Write `ledger-math.ts`**

```typescript
import { Prisma } from '@prisma/client';
import type { LedgerType, OrderSide } from './execution.types';

const D = Prisma.Decimal;
type Dec = Prisma.Decimal;

export const ZERO: Dec = new D(0);

/** One ledger amount: rupees to the paisa, half-up. Every ledger row is rounded exactly once, here. */
export function money(v: string | number | Dec): Dec {
  return new D(v).toDecimalPlaces(2, D.ROUND_HALF_UP);
}

export interface LedgerAmount {
  type: LedgerType;
  amount: Dec;
}

export interface Balances {
  deposited: Dec;
  realisedPnl: Dec;
  /** Positive: the charges paid. */
  charges: Dec;
  /** Positive: the interest paid. */
  mtfInterest: Dec;
  /** Money the user owns: deposits + realised P&L − charges − interest. */
  cash: Dec;
  /** −Σ margin rows. */
  blockedMargin: Dec;
  /** cash − blockedMargin, which is exactly Σ every row. */
  freeCash: Dec;
}

/**
 * Signs (the migration's CHECK enforces them): DEPOSIT +, MARGIN_BLOCK −, MARGIN_RELEASE +,
 * CHARGES −, MTF_INTEREST ≤ 0, REALISED_PNL either.
 */
export function balances(rows: readonly LedgerAmount[]): Balances {
  const sum = (types: readonly LedgerType[]) => rows.filter((r) => types.includes(r.type)).reduce((a, r) => a.plus(r.amount), ZERO);
  const deposited = sum(['DEPOSIT']);
  const realisedPnl = sum(['REALISED_PNL']);
  const charges = ZERO.minus(sum(['CHARGES']));
  const mtfInterest = ZERO.minus(sum(['MTF_INTEREST']));
  const cash = deposited.plus(realisedPnl).minus(charges).minus(mtfInterest);
  const blockedMargin = ZERO.minus(sum(['MARGIN_BLOCK', 'MARGIN_RELEASE']));
  return { deposited, realisedPnl, charges, mtfInterest, cash, blockedMargin, freeCash: cash.minus(blockedMargin) };
}

export interface PositionFill {
  side: OrderSide;
  qty: number;
  price: Dec;
  at: Date;
}

export interface PositionState {
  /** Signed: positive long, negative short. */
  netQty: number;
  avgPrice: Dec | null;
  /** Σ of the realised P&L booked so far, each part rounded as its ledger row was. */
  realised: Dec;
  /** When the current holding opened (its first fill since flat). */
  openedAt: Date | null;
}

export const FLAT: PositionState = { netQty: 0, avgPrice: null, realised: ZERO, openedAt: null };

/** Gross realised P&L of reducing `qty` at `price` (spec §4.4: (exit − average entry) × qty × direction). */
export function realisedOnReduce(avg: Dec, price: Dec, qty: number, direction: 1 | -1): Dec {
  return money(price.minus(avg).mul(qty).mul(direction));
}

/** Average-cost position arithmetic. A reducing fill realises; a fill that would flip the position throws. */
export function applyPositionFill(s: PositionState, f: PositionFill): { state: PositionState; realised: Dec | null } {
  const signed = f.side === 'BUY' ? f.qty : -f.qty;
  if (s.netQty === 0 || Math.sign(signed) === Math.sign(s.netQty)) {
    const held = Math.abs(s.netQty);
    const avgPrice = s.avgPrice === null || held === 0 ? f.price : s.avgPrice.mul(held).plus(f.price.mul(f.qty)).div(held + f.qty);
    return { state: { netQty: s.netQty + signed, avgPrice, realised: s.realised, openedAt: s.netQty === 0 ? f.at : s.openedAt }, realised: null };
  }
  if (f.qty > Math.abs(s.netQty)) throw new Error(`a ${f.side} of ${f.qty} would flip a position of ${s.netQty}`);
  const realised = realisedOnReduce(s.avgPrice as Dec, f.price, f.qty, s.netQty > 0 ? 1 : -1);
  const netQty = s.netQty + signed;
  return {
    state: { netQty, avgPrice: netQty === 0 ? null : s.avgPrice, realised: s.realised.plus(realised), openedAt: netQty === 0 ? null : s.openedAt },
    realised,
  };
}

export function positionFromFills(fills: readonly PositionFill[]): PositionState {
  return fills.reduce((s, f) => applyPositionFill(s, f).state, FLAT);
}

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** The IST calendar date, YYYY-MM-DD. */
export function istDate(at: Date): string {
  return new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

export function nextDate(day: string): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * The IST calendar days to charge (spec §4.4, plan ruling 10): from the day after the
 * last posting, or from the opening day when nothing of this holding was posted, through
 * upTo inclusive. A weekend or a missed night is caught up; a posted day never repeats.
 */
export function mtfInterestDays(openedOn: string, lastPosted: string | null, upTo: string): string[] {
  let day = lastPosted !== null && lastPosted >= openedOn ? nextDate(lastPosted) : openedOn;
  const out: string[] = [];
  while (day <= upTo) {
    out.push(day);
    day = nextDate(day);
  }
  return out;
}

/** One day's interest on the funded amount: funded × annual rate ÷ 100 ÷ 365, to the paisa. */
export function dailyMtfInterest(funded: Dec, annualRatePct: Dec): Dec {
  return money(funded.mul(annualRatePct).div(100).div(365));
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx jest src/modules/trade-core/execution/paper-settings.spec.ts src/modules/trade-core/execution/margin.spec.ts src/modules/trade-core/execution/ledger-math.spec.ts`
Expected: PASS (5 + 6 + 10 tests).

- [ ] **Step 8: Commit**

```bash
git add -- apps/api/src/modules/trade-core/execution/paper-settings.ts apps/api/src/modules/trade-core/execution/margin.ts apps/api/src/modules/trade-core/execution/ledger-math.ts apps/api/src/modules/trade-core/execution/testing/paper-fixtures.ts apps/api/src/modules/trade-core/execution/paper-settings.spec.ts apps/api/src/modules/trade-core/execution/margin.spec.ts apps/api/src/modules/trade-core/execution/ledger-math.spec.ts
git commit -m "feat(trade-core): paper settings vocabulary, margin per vehicle and ledger math" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/api/src/modules/trade-core/execution/paper-settings.ts apps/api/src/modules/trade-core/execution/margin.ts apps/api/src/modules/trade-core/execution/ledger-math.ts apps/api/src/modules/trade-core/execution/testing/paper-fixtures.ts apps/api/src/modules/trade-core/execution/paper-settings.spec.ts apps/api/src/modules/trade-core/execution/margin.spec.ts apps/api/src/modules/trade-core/execution/ledger-math.spec.ts
```

---

### Task 4: The paper fill model and order validation (pure)

**Files:**
- Create: `apps/api/src/modules/trade-core/execution/fill-model.ts`
- Test: `apps/api/src/modules/trade-core/execution/fill-model.spec.ts`

**Interfaces:**
- Consumes: `DepthLevel`, `PriceDepth` (`market-hub/hub.types.ts:31-41`); `VEHICLES`; `VEHICLE_EXCHANGES`
  (`risk-wall/session-open.ts:8`); `CoreOrderRequest`, `ORDER_TYPES`, `OrderSide`, `OrderType` (Task 2);
  `PaperSettings` (Task 3); fixtures (Task 3).
- Produces:

```typescript
export const PRICE_MAX_AGE_MS = 15_000;
export interface FillPrice { ltp: number; at: number; depth?: PriceDepth }
export interface FillableOrder { side: OrderSide; type: OrderType; qty: number; filledQty: number; instrument: { lotSize: number }; limitPrice: number | null; triggerPrice: number | null; submittedAt: Date }
export type FillDecision = { kind: 'NONE'; reason: string } | { kind: 'FILL'; qty: number; price: Prisma.Decimal; via: 'DEPTH' | 'SLIPPAGE' | 'LIMIT' };
export function priceProblem(p: FillPrice, submittedAtMs: number, now: number): string | null;
export function noPriceDeadline(submittedAtMs: number, trackedFromMs: number, noPriceRejectMs: number): number;
export function decideFill(order: FillableOrder, p: FillPrice, now: number, slippageBps: Prisma.Decimal): FillDecision;
export interface OrderCheckContext { settings: PaperSettings; position: { netQty: number }; pendingExitQty: number }
export function validateOrder(req: CoreOrderRequest, ctx: OrderCheckContext): string | null;
export function requestProblems(req: CoreOrderRequest): string[];
```

`CoreOrder` (Task 2) satisfies `FillableOrder` structurally, so the matcher passes orders straight in.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/modules/trade-core/execution/fill-model.spec.ts`:

```typescript
import { Prisma } from '@prisma/client';
import type { PriceDepth } from '../../market-hub/hub.types';
import {
  decideFill,
  noPriceDeadline,
  priceProblem,
  requestProblems,
  validateOrder,
  type FillableOrder,
  type FillDecision,
  type FillPrice,
  type OrderCheckContext,
} from './fill-model';
import { cashBuy, depth, mtfBuy, NOW, optionBuy, paperSettings } from './testing/paper-fixtures';

const D = (s: string) => new Prisma.Decimal(s);
const SUB = NOW.getTime();
const AT = SUB + 20;
const BPS5 = D('5');
const BPS0 = D('0');

const order = (over: Partial<FillableOrder> = {}): FillableOrder => ({
  side: 'BUY',
  type: 'MARKET',
  qty: 100,
  filledQty: 0,
  instrument: { lotSize: 1 },
  limitPrice: null,
  triggerPrice: null,
  submittedAt: NOW,
  ...over,
});
const px = (ltp: number, book?: PriceDepth, at = SUB + 10): FillPrice => ({ ltp, at, ...(book ? { depth: book } : {}) });
const shown = (d: FillDecision) => (d.kind === 'FILL' ? { qty: d.qty, price: d.price.toFixed(4), via: d.via } : d.kind);

describe('freshness (spec §4.3)', () => {
  it('a price stamped exactly at submission is not after it', () => {
    const at = decideFill(order(), px(500, undefined, SUB), AT, BPS5);
    expect(at).toEqual({ kind: 'NONE', reason: 'the price is not after the order was submitted' });
    expect(shown(decideFill(order(), px(500, undefined, SUB + 1), AT, BPS5))).toEqual({ qty: 100, price: '500.2500', via: 'SLIPPAGE' });
  });

  it('a price older than 15 s is stale; exactly 15 s is still fresh', () => {
    expect(priceProblem({ ltp: 500, at: SUB + 1 }, SUB, SUB + 1 + 15_000)).toBeNull();
    expect(priceProblem({ ltp: 500, at: SUB + 1 }, SUB, SUB + 1 + 15_001)).toBe('the price is 15001 ms old');
  });

  it('a non-positive price is never used', () => {
    expect(priceProblem({ ltp: 0, at: SUB + 1 }, SUB, SUB + 2)).toBe('the price is not positive');
  });

  it('the no-price deadline runs from submission, or from a later reload', () => {
    expect(noPriceDeadline(SUB, SUB, 30_000)).toBe(SUB + 30_000);
    expect(noPriceDeadline(SUB, SUB + 5_000, 30_000)).toBe(SUB + 35_000);
  });
});

describe('market orders', () => {
  it('a BUY walks the asks level by level', () => {
    expect(shown(decideFill(order(), px(500, depth([[500.5, 60], [501, 100]])), AT, BPS5))).toEqual({ qty: 100, price: '500.7000', via: 'DEPTH' });
  });

  it('a thin book fills part and leaves the rest open', () => {
    expect(shown(decideFill(order(), px(500, depth([[500, 40]])), AT, BPS5))).toEqual({ qty: 40, price: '500.0000', via: 'DEPTH' });
  });

  it('a SELL walks the bids best first, whatever order they arrive in', () => {
    const d = decideFill(order({ side: 'SELL', qty: 50 }), px(100, depth([], [[99, 30], [100, 30]])), AT, BPS5);
    expect(shown(d)).toEqual({ qty: 50, price: '99.6000', via: 'DEPTH' });
  });

  it('skips zero-quantity and non-positive levels', () => {
    const d = decideFill(order(), px(500, depth([[500, 0], [0, 50], [-1, 10], [501, 100]])), AT, BPS5);
    expect(shown(d)).toEqual({ qty: 100, price: '501.0000', via: 'DEPTH' });
  });

  it('a one-sided book waits instead of inventing a price', () => {
    expect(decideFill(order(), px(500, depth([], [[499, 500]])), AT, BPS5)).toEqual({ kind: 'NONE', reason: 'the book has no asks' });
    expect(decideFill(order({ side: 'SELL' }), px(500, depth([[501, 500]])), AT, BPS5)).toEqual({ kind: 'NONE', reason: 'the book has no bids' });
  });

  it('an empty book, or none, falls back to LTP ± slippage', () => {
    expect(shown(decideFill(order(), px(1000, depth([], [])), AT, BPS5))).toEqual({ qty: 100, price: '1000.5000', via: 'SLIPPAGE' });
    expect(shown(decideFill(order(), px(1000), AT, BPS5))).toEqual({ qty: 100, price: '1000.5000', via: 'SLIPPAGE' });
    expect(shown(decideFill(order({ side: 'SELL' }), px(1000), AT, BPS5))).toEqual({ qty: 100, price: '999.5000', via: 'SLIPPAGE' });
  });

  it('slippage rounds against the trader to the paisa', () => {
    expect(shown(decideFill(order(), px(100.03), AT, BPS5))).toEqual({ qty: 100, price: '100.0900', via: 'SLIPPAGE' });
    expect(shown(decideFill(order({ side: 'SELL' }), px(100.03), AT, BPS5))).toEqual({ qty: 100, price: '99.9700', via: 'SLIPPAGE' });
  });

  it('a volume-weighted price rounds against the trader at 4 dp', () => {
    expect(shown(decideFill(order({ qty: 3 }), px(100, depth([[100.05, 1], [100.1, 2]])), AT, BPS5))).toEqual({ qty: 3, price: '100.0834', via: 'DEPTH' });
    expect(shown(decideFill(order({ side: 'SELL', qty: 3 }), px(100, depth([], [[100.05, 1], [100.1, 2]])), AT, BPS5))).toEqual({ qty: 3, price: '100.0833', via: 'DEPTH' });
  });

  it('fills whole lots only', () => {
    const opt = order({ qty: 150, instrument: { lotSize: 75 } });
    expect(shown(decideFill(opt, px(100, depth([[100, 100]])), AT, BPS5))).toEqual({ qty: 75, price: '100.0000', via: 'DEPTH' });
    expect(decideFill(opt, px(100, depth([[100, 50]])), AT, BPS5)).toEqual({ kind: 'NONE', reason: 'the book holds less than one lot (50 < 75)' });
  });

  it('an order with nothing left does not fill', () => {
    expect(decideFill(order({ filledQty: 100 }), px(500), AT, BPS5)).toEqual({ kind: 'NONE', reason: 'nothing left to fill' });
  });
});

describe('limit orders (E3: strict trade-through, filled at the limit)', () => {
  const buy = order({ type: 'LIMIT', limitPrice: 100, qty: 150, instrument: { lotSize: 75 } });

  it('a BUY limit fills only below the limit', () => {
    expect(decideFill(buy, px(100), AT, BPS5)).toEqual({ kind: 'NONE', reason: 'the price 100 has not traded through the limit 100' });
    expect(shown(decideFill(buy, px(99.95), AT, BPS5))).toEqual({ qty: 150, price: '100.0000', via: 'LIMIT' });
  });

  it('a SELL limit fills only above the limit', () => {
    const sell = order({ side: 'SELL', type: 'LIMIT', limitPrice: 110, qty: 150, instrument: { lotSize: 75 } });
    expect(decideFill(sell, px(110), AT, BPS5).kind).toBe('NONE');
    expect(shown(decideFill(sell, px(110.05), AT, BPS5))).toEqual({ qty: 150, price: '110.0000', via: 'LIMIT' });
  });
});

describe('stop-loss market orders', () => {
  const sellStop = order({ side: 'SELL', type: 'SL_MARKET', triggerPrice: 95, qty: 10 });

  it('a SELL stop triggers at or below the trigger and fills as a market order', () => {
    expect(decideFill(sellStop, px(95.5), AT, BPS0)).toEqual({ kind: 'NONE', reason: 'the price 95.5 has not reached the trigger 95' });
    expect(shown(decideFill(sellStop, px(95), AT, BPS0))).toEqual({ qty: 10, price: '95.0000', via: 'SLIPPAGE' });
  });

  it('a gap through the trigger fills at the gap price, not the trigger', () => {
    expect(shown(decideFill(sellStop, px(90), AT, BPS0))).toEqual({ qty: 10, price: '90.0000', via: 'SLIPPAGE' });
    expect(shown(decideFill(sellStop, px(90, depth([], [[89.5, 10]])), AT, BPS0))).toEqual({ qty: 10, price: '89.5000', via: 'DEPTH' });
  });

  it('a BUY stop triggers at or above the trigger', () => {
    const buyStop = order({ type: 'SL_MARKET', triggerPrice: 105, qty: 10 });
    expect(decideFill(buyStop, px(104.95), AT, BPS0).kind).toBe('NONE');
    expect(shown(decideFill(buyStop, px(106), AT, BPS0))).toEqual({ qty: 10, price: '106.0000', via: 'SLIPPAGE' });
  });

  it('a partly filled stop keeps filling as a market order, even back across the trigger', () => {
    expect(shown(decideFill({ ...sellStop, filledQty: 4 }, px(96), AT, BPS0))).toEqual({ qty: 6, price: '96.0000', via: 'SLIPPAGE' });
  });
});

describe('validateOrder (business rules that REJECT)', () => {
  const ctx = (over: Partial<OrderCheckContext> = {}): OrderCheckContext => ({ settings: paperSettings(), position: { netQty: 0 }, pendingExitQty: 0, ...over });

  it('a vehicle trades only on its exchange', () => {
    const nfo = cashBuy({ instrument: { exchange: 'NFO', token: '2885', symbol: 'RELIANCE-EQ', lotSize: 1, underlying: null } });
    expect(validateOrder(nfo, ctx())).toBe('CASH_INTRADAY trades on NSE, not NFO');
  });

  it('qty must be a multiple of the lot size', () => {
    expect(validateOrder(optionBuy({ qty: 100 }), ctx())).toBe('qty 100 is not a multiple of the lot size 75');
  });

  it('options need an underlying with a maxLotsPerOrder row, and stay within it (E4)', () => {
    const inst = optionBuy().instrument;
    expect(validateOrder(optionBuy({ instrument: { ...inst, underlying: null } }), ctx())).toBe('an option order needs its underlying');
    expect(validateOrder(optionBuy({ instrument: { ...inst, underlying: 'TCS' } }), ctx())).toBe('no maxLotsPerOrder setting for TCS');
    expect(validateOrder(optionBuy({ qty: 825 }), ctx())).toBe('11 lots exceed the 10-lot limit per order for NIFTY');
    expect(validateOrder(optionBuy({ qty: 750 }), ctx())).toBeNull();
  });

  it('MTF and options open only with BUY; cash intraday may open short', () => {
    expect(validateOrder(mtfBuy({ side: 'SELL' }), ctx())).toBe('MTF opens only with BUY');
    expect(validateOrder(optionBuy({ side: 'SELL' }), ctx())).toBe('OPTIONS_BUY opens only with BUY');
    expect(validateOrder(cashBuy({ side: 'SELL' }), ctx())).toBeNull();
  });

  it('an ENTRY never reduces an open position', () => {
    expect(validateOrder(cashBuy({ side: 'SELL' }), ctx({ position: { netQty: 100 } }))).toBe('an ENTRY may not reduce the open position; place an EXIT');
  });

  it('an EXIT needs a position, the closing side and quantity not already being exited', () => {
    const exit = (over = {}) => cashBuy({ purpose: 'EXIT', side: 'SELL', ...over });
    expect(validateOrder(exit(), ctx())).toBe('no open position to exit');
    expect(validateOrder(exit({ side: 'BUY' }), ctx({ position: { netQty: 100 } }))).toBe('an exit of a long position must SELL');
    expect(validateOrder(exit(), ctx({ position: { netQty: 100 }, pendingExitQty: 40 }))).toBe('exit qty 100 exceeds the 60 units not already being exited');
    expect(validateOrder(exit({ qty: 60 }), ctx({ position: { netQty: 100 }, pendingExitQty: 40 }))).toBeNull();
    expect(validateOrder(exit({ side: 'BUY', qty: 50 }), ctx({ position: { netQty: -50 } }))).toBeNull();
  });
});

describe('requestProblems (a malformed request is a 400, not a REJECTED order)', () => {
  it('a well-formed request has none', () => {
    expect(requestProblems(cashBuy())).toEqual([]);
    expect(requestProblems(mtfBuy())).toEqual([]);
    expect(requestProblems(optionBuy())).toEqual([]);
  });

  it('lists every shape problem', () => {
    const bad = { ...cashBuy(), userId: '', vehicle: 'FUTURES', side: 'HOLD', qty: 0, refPrice: 100.123, limitPrice: 99 } as unknown as Parameters<typeof requestProblems>[0];
    expect(requestProblems(bad)).toEqual([
      'userId is required',
      'unknown vehicle FUTURES',
      'side must be BUY or SELL',
      'qty must be a whole number of 1 or more',
      'refPrice must be a price above 0 with at most 2 decimals',
      'limitPrice is only for LIMIT orders',
    ]);
  });

  it('LIMIT needs a limit and SL_MARKET a trigger', () => {
    expect(requestProblems(cashBuy({ type: 'LIMIT' }))).toEqual(['limitPrice must be a price above 0 with at most 2 decimals']);
    expect(requestProblems(cashBuy({ type: 'SL_MARKET' }))).toEqual(['triggerPrice must be a price above 0 with at most 2 decimals']);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest src/modules/trade-core/execution/fill-model.spec.ts`
Expected: FAIL with `Cannot find module './fill-model'`.

- [ ] **Step 3: Write `fill-model.ts`**

```typescript
import { Prisma } from '@prisma/client';
import type { DepthLevel, PriceDepth } from '../../market-hub/hub.types';
import { VEHICLE_EXCHANGES } from '../risk-wall/session-open';
import { VEHICLES } from '../strategies/blocks/block-types';
import { ORDER_TYPES, type CoreOrderRequest, type OrderSide, type OrderType } from './execution.types';
import type { PaperSettings } from './paper-settings';

const D = Prisma.Decimal;
type Dec = Prisma.Decimal;

/**
 * Spec §4.3 (parent §6.3): a price older than this is never filled on. A freshness rule
 * fixed by the spec, not a money or risk value.
 */
export const PRICE_MAX_AGE_MS = 15_000;

/** The parts of a hub Price the model reads (market-hub/hub.types.ts Price satisfies it). */
export interface FillPrice {
  ltp: number;
  /** Receipt time, ms epoch. */
  at: number;
  depth?: PriceDepth;
}

export interface FillableOrder {
  side: OrderSide;
  type: OrderType;
  qty: number;
  filledQty: number;
  instrument: { lotSize: number };
  limitPrice: number | null;
  triggerPrice: number | null;
  submittedAt: Date;
}

export type FillDecision =
  | { kind: 'NONE'; reason: string }
  | { kind: 'FILL'; qty: number; price: Dec; via: 'DEPTH' | 'SLIPPAGE' | 'LIMIT' };

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/** Null when `p` may be used for an order submitted at `submittedAtMs`: positive, STRICTLY after submission, ≤ 15 s old. */
export function priceProblem(p: FillPrice, submittedAtMs: number, now: number): string | null {
  if (!finite(p.ltp) || p.ltp <= 0) return 'the price is not positive';
  if (!finite(p.at) || p.at <= submittedAtMs) return 'the price is not after the order was submitted';
  if (now - p.at > PRICE_MAX_AGE_MS) return `the price is ${now - p.at} ms old`;
  return null;
}

/** When an order that has seen no usable price is rejected: noPriceRejectMs after submission, or after a reload. */
export function noPriceDeadline(submittedAtMs: number, trackedFromMs: number, noPriceRejectMs: number): number {
  return Math.max(submittedAtMs, trackedFromMs) + noPriceRejectMs;
}

/** Levels a fill can use: a positive price and a positive whole quantity. */
function usable(levels: readonly DepthLevel[] | undefined): DepthLevel[] {
  return (levels ?? []).filter((l) => finite(l.price) && l.price > 0 && Number.isSafeInteger(l.qty) && l.qty > 0);
}

/** Buys round up, sells round down: the paper fill is never better than the price allows. */
const againstTrader = (side: OrderSide, v: Dec, dp: number): Dec => v.toDecimalPlaces(dp, side === 'BUY' ? D.ROUND_CEIL : D.ROUND_FLOOR);

function marketFill(order: FillableOrder, p: FillPrice, remaining: number, slippageBps: Dec): FillDecision {
  const lot = order.instrument.lotSize;
  const bids = usable(p.depth?.bids);
  const asks = usable(p.depth?.asks);
  if (bids.length === 0 && asks.length === 0) {
    const shift = slippageBps.div(10_000);
    const factor = order.side === 'BUY' ? new D(1).plus(shift) : new D(1).minus(shift);
    const price = againstTrader(order.side, new D(p.ltp).mul(factor), 2);
    if (price.lte(0)) return { kind: 'NONE', reason: 'slippage leaves no positive price' };
    return { kind: 'FILL', qty: remaining, price, via: 'SLIPPAGE' };
  }
  const book = order.side === 'BUY' ? [...asks].sort((a, b) => a.price - b.price) : [...bids].sort((a, b) => b.price - a.price);
  if (book.length === 0) return { kind: 'NONE', reason: order.side === 'BUY' ? 'the book has no asks' : 'the book has no bids' };
  const available = book.reduce((n, l) => n + l.qty, 0);
  const qty = Math.min(remaining, Math.floor(available / lot) * lot);
  if (qty <= 0) return { kind: 'NONE', reason: `the book holds less than one lot (${available} < ${lot})` };
  let left = qty;
  let value = new D(0);
  for (const level of book) {
    if (left === 0) break;
    const take = Math.min(left, level.qty);
    value = value.plus(new D(level.price).mul(take));
    left -= take;
  }
  return { kind: 'FILL', qty, price: againstTrader(order.side, value.div(qty), 4), via: 'DEPTH' };
}

/**
 * Spec §4.3. MARKET walks the opposite side of the depth for the remaining qty (whole
 * lots), else LTP ± slippage when the price has no usable depth at all; a book with
 * levels only on the wrong side waits (plan ruling 6). LIMIT fills the whole remainder
 * at the limit on a strict trade-through (E3). SL_MARKET triggers at the trigger (BUY ≥,
 * SELL ≤), or stays triggered once it has a fill, and then fills as MARKET on this price.
 */
export function decideFill(order: FillableOrder, p: FillPrice, now: number, slippageBps: Dec): FillDecision {
  const problem = priceProblem(p, order.submittedAt.getTime(), now);
  if (problem) return { kind: 'NONE', reason: problem };
  const remaining = order.qty - order.filledQty;
  if (remaining <= 0) return { kind: 'NONE', reason: 'nothing left to fill' };
  if (order.type === 'LIMIT') {
    const limit = order.limitPrice as number;
    const through = order.side === 'BUY' ? p.ltp < limit : p.ltp > limit;
    if (!through) return { kind: 'NONE', reason: `the price ${p.ltp} has not traded through the limit ${limit}` };
    return { kind: 'FILL', qty: remaining, price: new D(limit), via: 'LIMIT' };
  }
  if (order.type === 'SL_MARKET' && order.filledQty === 0) {
    const trigger = order.triggerPrice as number;
    const hit = order.side === 'BUY' ? p.ltp >= trigger : p.ltp <= trigger;
    if (!hit) return { kind: 'NONE', reason: `the price ${p.ltp} has not reached the trigger ${trigger}` };
  }
  return marketFill(order, p, remaining, slippageBps);
}

export interface OrderCheckContext {
  settings: PaperSettings;
  /** The user's net position on the order's (vehicle, token): positive long, negative short. */
  position: { netQty: number };
  /** Units of open EXIT orders on the same key not yet filled. */
  pendingExitQty: number;
}

/** Business rules that REJECT a well-formed order (spec §4.3); null when it may rest. */
export function validateOrder(req: CoreOrderRequest, ctx: OrderCheckContext): string | null {
  const { lotSize } = req.instrument;
  const exchange = req.instrument.exchange.toUpperCase();
  const venues = VEHICLE_EXCHANGES[req.vehicle];
  if (!venues.includes(exchange)) return `${req.vehicle} trades on ${venues.join('/')}, not ${req.instrument.exchange}`;
  if (req.qty % lotSize !== 0) return `qty ${req.qty} is not a multiple of the lot size ${lotSize}`;
  if (req.vehicle === 'OPTIONS_BUY') {
    const underlying = (req.instrument.underlying ?? '').trim().toUpperCase();
    if (!underlying) return 'an option order needs its underlying';
    const maxLots = ctx.settings.maxLotsPerOrder[underlying];
    if (maxLots === undefined) return `no maxLotsPerOrder setting for ${underlying}`;
    const lots = req.qty / lotSize;
    if (lots > maxLots) return `${lots} lots exceed the ${maxLots}-lot limit per order for ${underlying}`;
  }
  const net = ctx.position.netQty;
  if (req.purpose === 'ENTRY') {
    if (req.vehicle !== 'CASH_INTRADAY' && req.side !== 'BUY') return `${req.vehicle} opens only with BUY`;
    if ((req.side === 'BUY' && net < 0) || (req.side === 'SELL' && net > 0)) return 'an ENTRY may not reduce the open position; place an EXIT';
    return null;
  }
  if (net === 0) return 'no open position to exit';
  const closing: OrderSide = net > 0 ? 'SELL' : 'BUY';
  if (req.side !== closing) return `an exit of a ${net > 0 ? 'long' : 'short'} position must ${closing}`;
  const free = Math.abs(net) - ctx.pendingExitQty;
  if (req.qty > free) return `exit qty ${req.qty} exceeds the ${free} units not already being exited`;
  return null;
}

const atMost2dp = (n: number): boolean => new D(n).decimalPlaces() <= 2;

/** Shape problems: a request with any is a programming error (400), never persisted (plan ruling 8). */
export function requestProblems(req: CoreOrderRequest): string[] {
  const out: string[] = [];
  const text = (v: unknown, name: string) => {
    if (typeof v !== 'string' || v.trim() === '') out.push(`${name} is required`);
  };
  const price = (v: unknown, name: string) => {
    if (!finite(v) || v <= 0 || !atMost2dp(v)) out.push(`${name} must be a price above 0 with at most 2 decimals`);
  };
  text(req.userId, 'userId');
  text(req.idempotencyKey, 'idempotencyKey');
  if (typeof req.idempotencyKey === 'string' && req.idempotencyKey.length > 200) out.push('idempotencyKey is longer than 200 characters');
  if (!(VEHICLES as readonly unknown[]).includes(req.vehicle)) out.push(`unknown vehicle ${String(req.vehicle)}`);
  text(req.instrument?.exchange, 'instrument.exchange');
  text(req.instrument?.token, 'instrument.token');
  text(req.instrument?.symbol, 'instrument.symbol');
  if (!Number.isSafeInteger(req.instrument?.lotSize) || req.instrument.lotSize < 1) out.push('instrument.lotSize must be a whole number of 1 or more');
  if (req.side !== 'BUY' && req.side !== 'SELL') out.push('side must be BUY or SELL');
  if (!(ORDER_TYPES as readonly unknown[]).includes(req.type)) out.push(`unknown order type ${String(req.type)}`);
  if (req.purpose !== 'ENTRY' && req.purpose !== 'EXIT') out.push('purpose must be ENTRY or EXIT');
  if (!Number.isSafeInteger(req.qty) || req.qty < 1) out.push('qty must be a whole number of 1 or more');
  price(req.refPrice, 'refPrice');
  if (req.type === 'LIMIT') price(req.limitPrice, 'limitPrice');
  else if (req.limitPrice !== null) out.push('limitPrice is only for LIMIT orders');
  if (req.type === 'SL_MARKET') price(req.triggerPrice, 'triggerPrice');
  else if (req.triggerPrice !== null) out.push('triggerPrice is only for SL_MARKET orders');
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/modules/trade-core/execution/fill-model.spec.ts`
Expected: PASS (29 tests).

- [ ] **Step 5: Commit**

```bash
git add -- apps/api/src/modules/trade-core/execution/fill-model.ts apps/api/src/modules/trade-core/execution/fill-model.spec.ts
git commit -m "feat(trade-core): paper fill model (depth walk, strict trade-through, stop gaps) and order validation" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/api/src/modules/trade-core/execution/fill-model.ts apps/api/src/modules/trade-core/execution/fill-model.spec.ts
```

---

### Task 5: Tables, CHECKs, append-only triggers, seed defaults, tenant models

**Files:**
- Modify: `prisma/schema.prisma` (three relation fields in `model User`; four models appended)
- Create: `prisma/migrations/20261011120000_sp2_m3_execution/migration.sql`
- Modify: `apps/api/src/common/tenant/tenant.constants.ts`
- Test: `apps/api/src/modules/trade-core/execution/core-paper-defaults.spec.ts`
- Test (opt-in, real database): `apps/api/test/sp2-m3/jest.config.js`, `apps/api/test/sp2-m3/core-execution.int.spec.ts`

**Interfaces:**
- Consumes: `REQUIRED_PAPER_PAIRS`, `isPaperPair`, `parsePaperValue`, `paperPairId`, `PaperKey` (Task 3); `SEED_ROWS`
  (Task 3 fixtures); M2's `core_append_only_guard()` (`prisma/migrations/20261010120000_sp2_m2_risk_wall/migration.sql:103`).
- Produces: Prisma models `CoreOrder` (`core_orders`), `CoreFill` (`core_fills`), `CoreCashLedger`
  (`core_cash_ledger`), `CorePaperDefault` (`core_paper_defaults`, id `key_scope`); `TENANT_MODELS` gains
  `'CoreOrder'`, `'CoreFill'`, `'CoreCashLedger'`; 14 default rows.

- [ ] **Step 1: Write the failing seed spec**

Create `apps/api/src/modules/trade-core/execution/core-paper-defaults.spec.ts`:

```typescript
import { readFileSync } from 'fs';
import { join } from 'path';
import { isPaperPair, paperPairId, parsePaperValue, REQUIRED_PAPER_PAIRS, type PaperKey } from './paper-settings';
import { SEED_ROWS } from './testing/paper-fixtures';

/**
 * The paper defaults are rows in the M3 migration (data, not code: SP2 D4). This spec
 * proves the seed block holds one valid row per required pair plus the five index
 * underlyings, that E1/E2 carry the owner's values, that every other row is labelled
 * "default — please review", and that the fixtures the other specs use equal the seed.
 */
const ROOT = join(__dirname, '..', '..', '..', '..', '..', '..');
const sql = readFileSync(join(ROOT, 'prisma', 'migrations', '20261011120000_sp2_m3_execution', 'migration.sql'), 'utf8');

interface SeedRow {
  key: string;
  scope: string;
  value: string;
  note: string;
}

function seedRows(): SeedRow[] {
  const seed = sql.slice(sql.indexOf('-- SEED BEGIN'), sql.indexOf('-- SEED END'));
  const re = /\('([A-Za-z]+)', '([A-Z0-9&_-]+)', (\d+(?:\.\d+)?), '([^']*)'\)/g;
  return [...seed.matchAll(re)].map((m) => ({ key: m[1], scope: m[2], value: m[3], note: m[4] }));
}

const UNDERLYINGS = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX'];

describe('M3 seed defaults (core_paper_defaults)', () => {
  const rows = seedRows();

  it('has one valid row per required pair plus the five index underlyings, inserted idempotently', () => {
    expect(rows.map((r) => paperPairId(r.key, r.scope))).toEqual([...REQUIRED_PAPER_PAIRS, ...UNDERLYINGS.map((u) => paperPairId('maxLotsPerOrder', u))]);
    for (const r of rows) {
      expect(isPaperPair(r.key, r.scope)).toBe(true);
      expect(parsePaperValue(r.key as PaperKey, r.value).ok).toBe(true);
    }
    expect(sql).toContain('ON CONFLICT ("key", "scope") DO NOTHING');
  });

  it('equals the fixture rows the other specs use', () => {
    expect(rows.map((r) => `${r.key}@${r.scope}=${Number(r.value).toFixed(2)}`)).toEqual(SEED_ROWS.map((r) => `${r.key}@${r.scope}=${r.numValue.toFixed(2)}`));
  });

  it('E1 and E2 carry the owner decisions; every other row says default — please review', () => {
    const byId = new Map(rows.map((r) => [paperPairId(r.key, r.scope), r]));
    expect(byId.get('startingCapital@ALL')?.value).toBe('1000000.00');
    expect(byId.get('startingCapital@ALL')?.note).toContain('owner decision E1');
    expect(byId.get('intradayLeverage@CASH_INTRADAY')?.value).toBe('5.00');
    expect(byId.get('intradayLeverage@CASH_INTRADAY')?.note).toContain('owner decision E2');
    for (const r of rows.filter((x) => !['startingCapital', 'intradayLeverage'].includes(x.key))) {
      expect(r.note.startsWith('default — please review')).toBe(true);
    }
  });

  it('the defaults pair CHECK names exactly the fixed pairs the code knows', () => {
    const check = sql.slice(sql.indexOf('"core_paper_defaults_pair_check"'), sql.indexOf('"core_paper_defaults_value_check"'));
    const pairs = [...check.matchAll(/\('([A-Za-z]+)', '([A-Z_]+)'\)/g)].map((m) => paperPairId(m[1], m[2]));
    expect(pairs).toEqual([...REQUIRED_PAPER_PAIRS]);
  });

  it('fills and the ledger are append-only through the M2 guard, which this migration does not redefine', () => {
    expect(sql).toContain('CREATE TRIGGER "core_fills_append_only"');
    expect(sql).toContain('CREATE TRIGGER "core_cash_ledger_append_only"');
    expect(sql.match(/EXECUTE FUNCTION core_append_only_guard\(\)/g)).toHaveLength(2);
    expect(sql).not.toContain('CREATE OR REPLACE FUNCTION');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest src/modules/trade-core/execution/core-paper-defaults.spec.ts`
Expected: FAIL with `ENOENT: no such file or directory … 20261011120000_sp2_m3_execution/migration.sql`.

- [ ] **Step 3: Add the models**

In `prisma/schema.prisma`, inside `model User { … }`, add after `coreKillSwitches       CoreKillSwitch[]`:

```prisma
  coreOrders             CoreOrder[]
  coreFills              CoreFill[]
  coreCashLedger         CoreCashLedger[]
```

Append at the end of `prisma/schema.prisma`:

```prisma
// ─── SP2 M3: paper execution (orders, fills, cash ledger, paper defaults) ───
// docs/superpowers/specs/2026-10-11-sp2-m3-execution-design.md §4.5.
// core_fills and core_cash_ledger are append-only (a trigger in the 20261011120000
// migration refuses UPDATE, reusing M2's core_append_only_guard()). CHECK constraints pin
// the vocabularies, the ledger signs and the default shapes.

/// One core order. State changes only through execution/order-state.ts.
model CoreOrder {
  id                String           @id @default(cuid())
  userId            String
  user              User             @relation(fields: [userId], references: [id], onDelete: Cascade)
  idempotencyKey    String           @unique
  vehicle           String // CASH_INTRADAY | MTF | OPTIONS_BUY
  exchange          String
  token             String
  symbol            String
  lotSize           Int
  underlying        String?
  side              String // BUY | SELL
  qty               Int
  filledQty         Int              @default(0)
  avgFillPrice      Decimal?         @db.Decimal(14, 4)
  type              String // MARKET | LIMIT | SL_MARKET
  limitPrice        Decimal?         @db.Decimal(14, 2)
  triggerPrice      Decimal?         @db.Decimal(14, 2)
  refPrice          Decimal          @db.Decimal(14, 2)
  purpose           String // ENTRY | EXIT
  strategyVersionId String?
  state             String // NEW | OPEN | PARTIAL | FILLED | CANCELLED | REJECTED
  rejectReason      String?
  submittedAt       DateTime
  updatedAt         DateTime         @updatedAt
  fills             CoreFill[]
  ledger            CoreCashLedger[]

  @@index([userId, state])
  @@index([state])
  @@index([userId, vehicle, token])
  @@map("core_orders")
}

/// One fill (append-only). `charges` is the per-leg breakdown; chargesTotal is it rounded to the paisa.
model CoreFill {
  id           String           @id @default(cuid())
  orderId      String
  order        CoreOrder        @relation(fields: [orderId], references: [id], onDelete: Cascade)
  userId       String
  user         User             @relation(fields: [userId], references: [id], onDelete: Cascade)
  price        Decimal          @db.Decimal(14, 4)
  qty          Int
  charges      Json
  chargesTotal Decimal          @db.Decimal(14, 2)
  priceAt      DateTime
  createdAt    DateTime         @default(now())
  ledger       CoreCashLedger[]

  @@index([userId, createdAt])
  @@index([orderId])
  @@map("core_fills")
}

/// One signed money movement (append-only). (userId, token, interestDate) is unique; interestDate is set only on MTF_INTEREST.
model CoreCashLedger {
  id           String     @id @default(cuid())
  userId       String
  user         User       @relation(fields: [userId], references: [id], onDelete: Cascade)
  type         String // DEPOSIT | MARGIN_BLOCK | MARGIN_RELEASE | REALISED_PNL | CHARGES | MTF_INTEREST
  amount       Decimal    @db.Decimal(14, 2)
  orderId      String?
  order        CoreOrder? @relation(fields: [orderId], references: [id], onDelete: Cascade)
  fillId       String?
  fill         CoreFill?  @relation(fields: [fillId], references: [id], onDelete: Cascade)
  token        String?
  interestDate DateTime?  @db.Date
  note         String
  createdAt    DateTime   @default(now())

  @@unique([userId, token, interestDate])
  @@index([userId, createdAt])
  @@index([orderId])
  @@map("core_cash_ledger")
}

/// Global paper settings (data, owner-editable; D4). Seeded "default — please review" except E1/E2.
model CorePaperDefault {
  key       String
  scope     String
  numValue  Decimal  @db.Decimal(14, 2)
  note      String
  updatedBy String? // the admin who last edited it (null = migration seed)
  updatedAt DateTime @default(now())

  @@id([key, scope])
  @@map("core_paper_defaults")
}
```

- [ ] **Step 4: Write the migration**

Create `prisma/migrations/20261011120000_sp2_m3_execution/migration.sql`:

```sql
-- SP2 M3 — paper execution: orders, fills, cash ledger, paper defaults
-- (docs/superpowers/specs/2026-10-11-sp2-m3-execution-design.md §4.5).
--
-- Expand-only: four new tables, CHECK constraints, two append-only triggers (reusing
-- M2's core_append_only_guard()) and 14 seed default rows. Drops and alters nothing
-- that exists.

CREATE TABLE "core_orders" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "vehicle" TEXT NOT NULL,
    "exchange" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "lotSize" INTEGER NOT NULL,
    "underlying" TEXT,
    "side" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "filledQty" INTEGER NOT NULL DEFAULT 0,
    "avgFillPrice" DECIMAL(14,4),
    "type" TEXT NOT NULL,
    "limitPrice" DECIMAL(14,2),
    "triggerPrice" DECIMAL(14,2),
    "refPrice" DECIMAL(14,2) NOT NULL,
    "purpose" TEXT NOT NULL,
    "strategyVersionId" TEXT,
    "state" TEXT NOT NULL,
    "rejectReason" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "core_orders_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "core_fills" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "price" DECIMAL(14,4) NOT NULL,
    "qty" INTEGER NOT NULL,
    "charges" JSONB NOT NULL,
    "chargesTotal" DECIMAL(14,2) NOT NULL,
    "priceAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "core_fills_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "core_cash_ledger" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "orderId" TEXT,
    "fillId" TEXT,
    "token" TEXT,
    "interestDate" DATE,
    "note" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "core_cash_ledger_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "core_paper_defaults" (
    "key" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "numValue" DECIMAL(14,2) NOT NULL,
    "note" TEXT NOT NULL,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "core_paper_defaults_pkey" PRIMARY KEY ("key","scope")
);

CREATE UNIQUE INDEX "core_orders_idempotencyKey_key" ON "core_orders"("idempotencyKey");
CREATE INDEX "core_orders_userId_state_idx" ON "core_orders"("userId", "state");
CREATE INDEX "core_orders_state_idx" ON "core_orders"("state");
CREATE INDEX "core_orders_userId_vehicle_token_idx" ON "core_orders"("userId", "vehicle", "token");
CREATE INDEX "core_fills_userId_createdAt_idx" ON "core_fills"("userId", "createdAt");
CREATE INDEX "core_fills_orderId_idx" ON "core_fills"("orderId");
CREATE UNIQUE INDEX "core_cash_ledger_userId_token_interestDate_key" ON "core_cash_ledger"("userId", "token", "interestDate");
CREATE INDEX "core_cash_ledger_userId_createdAt_idx" ON "core_cash_ledger"("userId", "createdAt");
CREATE INDEX "core_cash_ledger_orderId_idx" ON "core_cash_ledger"("orderId");

ALTER TABLE "core_orders" ADD CONSTRAINT "core_orders_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "core_fills" ADD CONSTRAINT "core_fills_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "core_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "core_fills" ADD CONSTRAINT "core_fills_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "core_cash_ledger" ADD CONSTRAINT "core_cash_ledger_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "core_cash_ledger" ADD CONSTRAINT "core_cash_ledger_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "core_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "core_cash_ledger" ADD CONSTRAINT "core_cash_ledger_fillId_fkey" FOREIGN KEY ("fillId") REFERENCES "core_fills"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Vocabularies and shapes (Prisma models them as String/Int/Decimal; its diff ignores CHECKs).
-- A REJECTED order keeps what was asked, so the lot-multiple rule binds only the others.
ALTER TABLE "core_orders" ADD CONSTRAINT "core_orders_vocab_check" CHECK (
    "vehicle" IN ('CASH_INTRADAY', 'MTF', 'OPTIONS_BUY')
    AND "side" IN ('BUY', 'SELL')
    AND "type" IN ('MARKET', 'LIMIT', 'SL_MARKET')
    AND "purpose" IN ('ENTRY', 'EXIT')
    AND "state" IN ('NEW', 'OPEN', 'PARTIAL', 'FILLED', 'CANCELLED', 'REJECTED'));
ALTER TABLE "core_orders" ADD CONSTRAINT "core_orders_shape_check" CHECK (
    "qty" > 0 AND "lotSize" > 0 AND "refPrice" > 0
    AND "filledQty" >= 0 AND "filledQty" <= "qty"
    AND ("state" = 'REJECTED' OR "qty" % "lotSize" = 0)
    AND ("type" <> 'LIMIT' OR ("limitPrice" IS NOT NULL AND "limitPrice" > 0))
    AND ("type" <> 'SL_MARKET' OR ("triggerPrice" IS NOT NULL AND "triggerPrice" > 0))
    AND ("state" <> 'FILLED' OR "filledQty" = "qty")
    AND ("state" <> 'REJECTED' OR length(btrim(coalesce("rejectReason", ''))) > 0));

ALTER TABLE "core_fills" ADD CONSTRAINT "core_fills_shape_check" CHECK (
    "qty" > 0 AND "price" > 0 AND "chargesTotal" >= 0);

-- Ledger signs (ledger-math.ts balances() relies on them) and links.
ALTER TABLE "core_cash_ledger" ADD CONSTRAINT "core_cash_ledger_type_check" CHECK (
    CASE "type"
      WHEN 'DEPOSIT' THEN "amount" > 0
      WHEN 'MARGIN_BLOCK' THEN "amount" < 0 AND "orderId" IS NOT NULL
      WHEN 'MARGIN_RELEASE' THEN "amount" > 0 AND "orderId" IS NOT NULL
      WHEN 'CHARGES' THEN "amount" < 0 AND "fillId" IS NOT NULL
      WHEN 'REALISED_PNL' THEN "fillId" IS NOT NULL
      WHEN 'MTF_INTEREST' THEN "amount" <= 0 AND "token" IS NOT NULL
      ELSE false
    END);
ALTER TABLE "core_cash_ledger" ADD CONSTRAINT "core_cash_ledger_interest_date_check" CHECK (
    ("type" = 'MTF_INTEREST') = ("interestDate" IS NOT NULL));
ALTER TABLE "core_cash_ledger" ADD CONSTRAINT "core_cash_ledger_note_check" CHECK (length(btrim("note")) > 0);

-- The fixed pairs must equal REQUIRED_PAPER_PAIRS in paper-settings.ts (core-paper-defaults.spec.ts
-- checks it); maxLotsPerOrder is scoped by any upper-case underlying name (E4).
ALTER TABLE "core_paper_defaults" ADD CONSTRAINT "core_paper_defaults_pair_check" CHECK (
    ("key", "scope") IN (
      ('startingCapital', 'ALL'), ('intradayLeverage', 'CASH_INTRADAY'),
      ('slippageBps', 'CASH_INTRADAY'), ('slippageBps', 'MTF'), ('slippageBps', 'OPTIONS_BUY'),
      ('noPriceRejectMs', 'ALL'), ('mtfFundedShare', 'MTF'), ('mtfAnnualRatePct', 'MTF'), ('mtfPledgeFee', 'MTF'))
    OR ("key" = 'maxLotsPerOrder' AND "scope" ~ '^[A-Z0-9&-]{1,30}$' AND "scope" NOT IN ('ALL', 'CASH_INTRADAY', 'MTF', 'OPTIONS_BUY')));
ALTER TABLE "core_paper_defaults" ADD CONSTRAINT "core_paper_defaults_value_check" CHECK (
    "numValue" >= 0 AND "numValue" <> 'NaN'::numeric AND
    CASE "key"
      WHEN 'startingCapital' THEN "numValue" > 0
      WHEN 'intradayLeverage' THEN "numValue" >= 1
      WHEN 'slippageBps' THEN "numValue" <= 10000
      WHEN 'noPriceRejectMs' THEN "numValue" >= 1000 AND "numValue" = trunc("numValue")
      WHEN 'mtfFundedShare' THEN "numValue" < 1
      WHEN 'mtfAnnualRatePct' THEN "numValue" <= 100
      WHEN 'mtfPledgeFee' THEN true
      WHEN 'maxLotsPerOrder' THEN "numValue" >= 1 AND "numValue" = trunc("numValue")
      ELSE false
    END);
ALTER TABLE "core_paper_defaults" ADD CONSTRAINT "core_paper_defaults_note_check" CHECK (length(btrim("note")) > 0);

-- Append-only (spec §4.5). UPDATE is refused; DELETE stays possible only so deleting a
-- user (or its orders) cascades. No repository has an update or delete method for these.
CREATE TRIGGER "core_fills_append_only"
    BEFORE UPDATE ON "core_fills"
    FOR EACH ROW EXECUTE FUNCTION core_append_only_guard();

CREATE TRIGGER "core_cash_ledger_append_only"
    BEFORE UPDATE ON "core_cash_ledger"
    FOR EACH ROW EXECUTE FUNCTION core_append_only_guard();

-- SEED BEGIN
-- Paper defaults are data (D4), idempotent (ON CONFLICT DO NOTHING) and owner-editable
-- (PUT /api/trade-core/paper/defaults/:key/:scope). E1/E2 are owner decisions; every other
-- value is a placeholder listed for review in docs/superpowers/plans/2026-10-11-sp2-m3-execution.md.
-- Notes contain no apostrophes or semicolons.
INSERT INTO "core_paper_defaults" ("key", "scope", "numValue", "note") VALUES
    ('startingCapital', 'ALL', 1000000.00, 'owner decision E1 (2026-10-11): starting paper capital per user'),
    ('intradayLeverage', 'CASH_INTRADAY', 5.00, 'owner decision E2 (2026-10-11): cash intraday margin is notional / 5'),
    ('slippageBps', 'CASH_INTRADAY', 5.00, 'default — please review: used only when a price has no depth, the wide end of large-cap NSE spreads'),
    ('slippageBps', 'MTF', 5.00, 'default — please review: same NSE equities as cash intraday'),
    ('slippageBps', 'OPTIONS_BUY', 50.00, 'default — please review: option spreads of 0.05 to 0.10 on premiums of 20 to 200, the wide end'),
    ('noPriceRejectMs', 'ALL', 30000, 'default — please review: twice the 15 s freshness window'),
    ('mtfFundedShare', 'MTF', 0.50, 'default — please review: placeholder, 2x leverage like the M2 mtfMaxLeverage default, verify the Angel One funded share'),
    ('mtfAnnualRatePct', 'MTF', 18.00, 'default — please review: placeholder at the high end of advertised MTF rates, verify the Angel One rate'),
    ('mtfPledgeFee', 'MTF', 23.60, 'default — please review: placeholder 20 plus 18 percent GST per MTF buy order, verify the Angel One pledge charge'),
    ('maxLotsPerOrder', 'NIFTY', 10, 'default — please review: owner cap per order (E4), not an NSE freeze quantity'),
    ('maxLotsPerOrder', 'BANKNIFTY', 10, 'default — please review: owner cap per order (E4), not an NSE freeze quantity'),
    ('maxLotsPerOrder', 'FINNIFTY', 10, 'default — please review: owner cap per order (E4), not an NSE freeze quantity'),
    ('maxLotsPerOrder', 'MIDCPNIFTY', 10, 'default — please review: owner cap per order (E4), not an NSE freeze quantity'),
    ('maxLotsPerOrder', 'SENSEX', 10, 'default — please review: owner cap per order (E4), not an NSE freeze quantity, inert until BFO is a core venue')
ON CONFLICT ("key", "scope") DO NOTHING;
-- SEED END
```

- [ ] **Step 5: Validate the schema, generate the client, run the seed spec**

```bash
cd apps/api && npx prisma validate --schema ../../prisma/schema.prisma && npx prisma generate --schema ../../prisma/schema.prisma
```

Expected: `The schema at ../../prisma/schema.prisma is valid`, then `Generated Prisma Client`.

Run: `npx jest src/modules/trade-core/execution/core-paper-defaults.spec.ts`
Expected: PASS (5 tests). If "equals the fixture rows" fails, the fixture and the seed differ: the migration is the
source; fix `testing/paper-fixtures.ts` to match it.

- [ ] **Step 6: Make the three per-user models tenant models**

In `apps/api/src/common/tenant/tenant.constants.ts`, add after `'CoreKillSwitch',` (the last entry of `TENANT_MODELS`):

```typescript
  // SP2 M3: per-user orders, fills and cash ledger. CorePaperDefault is global
  // settings data and deliberately absent.
  'CoreOrder',
  'CoreFill',
  'CoreCashLedger',
```

(Task 6's repository spec asserts this membership.)

- [ ] **Step 7: Write the opt-in database test**

Create `apps/api/test/sp2-m3/jest.config.js`:

```javascript
const path = require('path');

/**
 * Opt-in SQL tests for the SP2 M3 execution tables (seed, append-only triggers, CHECKs,
 * the MTF interest uniqueness, user cascade) against a THROWAWAY local Postgres on
 * 127.0.0.1 with every migration applied. The default apps/api Jest config (rootDir: src)
 * never finds these.
 *
 * Run from apps/api:
 *   DATABASE_URL_TEST=postgresql://postgres:password@127.0.0.1:55433/grw_sp2m3_test \
 *     npx jest --config test/sp2-m3/jest.config.js -i
 */
module.exports = {
  rootDir: path.resolve(__dirname, '../..'),
  roots: ['<rootDir>/test/sp2-m3'],
  moduleFileExtensions: ['js', 'json', 'ts'],
  testRegex: '.*\\.spec\\.ts$',
  transform: { '^.+\\.(t|j)s$': ['ts-jest', { isolatedModules: true }] },
  testEnvironment: 'node',
};
```

Create `apps/api/test/sp2-m3/core-execution.int.spec.ts`:

```typescript
import { readFileSync } from 'fs';
import { join } from 'path';
import { PrismaClient } from '@prisma/client';

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error('DATABASE_URL_TEST must point at a throwaway database with all migrations applied');
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(url)) throw new Error('refusing to run against a database that is not on 127.0.0.1');

const db = new PrismaClient({ datasources: { db: { url } } });
const MIGRATION = join(__dirname, '..', '..', '..', '..', 'prisma', 'migrations', '20261011120000_sp2_m3_execution', 'migration.sql');
const sql = readFileSync(MIGRATION, 'utf8');
const seedStatements = sql
  .slice(sql.indexOf('-- SEED BEGIN'), sql.indexOf('-- SEED END'))
  .split(';\n')
  .map((s) => s.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n').trim())
  .filter((s) => s.length > 0);

const run = `it${Date.now()}`;
const rid = () => Math.random().toString(36).slice(2, 10);

async function newUser(): Promise<string> {
  const id = `usr_${run}_${rid()}`;
  await db.$executeRawUnsafe(
    `INSERT INTO "users" ("id", "email", "passwordHash", "updatedAt") VALUES ($1, $1 || '@it.local', 'x', CURRENT_TIMESTAMP)`,
    id,
  );
  return id;
}

interface OrderOver {
  state?: string;
  qty?: number;
  lotSize?: number;
  type?: string;
  limitPrice?: string | null;
  filledQty?: number;
  rejectReason?: string | null;
}

async function insertOrder(userId: string, o: OrderOver = {}): Promise<string> {
  const id = `ord_${rid()}`;
  await db.$executeRawUnsafe(
    `INSERT INTO "core_orders" ("id", "userId", "idempotencyKey", "vehicle", "exchange", "token", "symbol", "lotSize", "side", "qty", "filledQty", "type", "limitPrice", "refPrice", "purpose", "state", "rejectReason", "submittedAt", "updatedAt")
     VALUES ($1, $2, $1, 'CASH_INTRADAY', 'NSE', '2885', 'RELIANCE-EQ', $3, 'BUY', $4, $5, $6, $7::numeric, 500, 'ENTRY', $8, $9, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    id, userId, o.lotSize ?? 1, o.qty ?? 100, o.filledQty ?? 0, o.type ?? 'MARKET', o.limitPrice ?? null, o.state ?? 'OPEN', o.rejectReason ?? null,
  );
  return id;
}

async function insertFill(userId: string, orderId: string): Promise<string> {
  const id = `fil_${rid()}`;
  await db.$executeRawUnsafe(
    `INSERT INTO "core_fills" ("id", "orderId", "userId", "price", "qty", "charges", "chargesTotal", "priceAt") VALUES ($1, $2, $3, 500.25, 100, '{}'::jsonb, 26.92, CURRENT_TIMESTAMP)`,
    id, orderId, userId,
  );
  return id;
}

interface LedgerOver {
  orderId?: string | null;
  fillId?: string | null;
  token?: string | null;
  interestDate?: string | null;
  note?: string;
}

function insertLedger(userId: string, type: string, amount: string, x: LedgerOver = {}) {
  return db.$executeRawUnsafe(
    `INSERT INTO "core_cash_ledger" ("id", "userId", "type", "amount", "orderId", "fillId", "token", "interestDate", "note") VALUES ($1, $2, $3, $4::numeric, $5, $6, $7, $8::date, $9)`,
    `led_${rid()}`, userId, type, amount, x.orderId ?? null, x.fillId ?? null, x.token ?? null, x.interestDate ?? null, x.note ?? 'it',
  );
}

afterAll(() => db.$disconnect());

describe('core execution tables (real database)', () => {
  it('has the 14 seed defaults, and re-running the seed block changes nothing', async () => {
    const count = async () => (await db.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM "core_paper_defaults"`))[0].n;
    expect(await count()).toBe(14);
    expect(seedStatements).toHaveLength(1);
    await db.$executeRawUnsafe(seedStatements[0]);
    expect(await count()).toBe(14);
  });

  it('refuses to update a fill or a ledger row (append-only)', async () => {
    const u = await newUser();
    const o = await insertOrder(u);
    const f = await insertFill(u, o);
    await insertLedger(u, 'CHARGES', '-26.92', { orderId: o, fillId: f });
    await expect(db.$executeRawUnsafe(`UPDATE "core_fills" SET "qty" = 1 WHERE "id" = $1`, f)).rejects.toThrow(/append-only/);
    await expect(db.$executeRawUnsafe(`UPDATE "core_cash_ledger" SET "amount" = -1 WHERE "userId" = $1`, u)).rejects.toThrow(/append-only/);
  });

  it('pins the ledger signs and links', async () => {
    const u = await newUser();
    const o = await insertOrder(u);
    const f = await insertFill(u, o);
    await expect(insertLedger(u, 'DEPOSIT', '0')).rejects.toThrow(/core_cash_ledger_type_check/);
    await expect(insertLedger(u, 'MARGIN_BLOCK', '100', { orderId: o })).rejects.toThrow(/core_cash_ledger_type_check/);
    await expect(insertLedger(u, 'MARGIN_BLOCK', '-100')).rejects.toThrow(/core_cash_ledger_type_check/);
    await expect(insertLedger(u, 'CHARGES', '-1', { orderId: o })).rejects.toThrow(/core_cash_ledger_type_check/);
    await expect(insertLedger(u, 'TIP', '-1')).rejects.toThrow(/core_cash_ledger_type_check/);
    await expect(insertLedger(u, 'MTF_INTEREST', '-1', { token: '1594' })).rejects.toThrow(/core_cash_ledger_interest_date_check/);
    await expect(insertLedger(u, 'DEPOSIT', '1', { interestDate: '2026-10-12' })).rejects.toThrow(/core_cash_ledger_interest_date_check/);
    await expect(insertLedger(u, 'DEPOSIT', '1', { note: ' ' })).rejects.toThrow(/core_cash_ledger_note_check/);
    await insertLedger(u, 'DEPOSIT', '1000000');
    await insertLedger(u, 'MARGIN_BLOCK', '-100', { orderId: o });
    await insertLedger(u, 'REALISED_PNL', '-5', { orderId: o, fillId: f });
    await insertLedger(u, 'MTF_INTEREST', '0', { token: '1594', interestDate: '2026-10-11' });
  });

  it('allows one MTF interest row per user, token and day; ON CONFLICT DO NOTHING makes the cron idempotent', async () => {
    const u = await newUser();
    await insertLedger(u, 'MTF_INTEREST', '-2.47', { token: '1594', interestDate: '2026-10-12' });
    await expect(insertLedger(u, 'MTF_INTEREST', '-2.47', { token: '1594', interestDate: '2026-10-12' })).rejects.toThrow(/core_cash_ledger_userId_token_interestDate_key/);
    const n = await db.$executeRawUnsafe(
      `INSERT INTO "core_cash_ledger" ("id", "userId", "type", "amount", "token", "interestDate", "note") VALUES ($1, $2, 'MTF_INTEREST', -2.47, '1594', '2026-10-12', 'it') ON CONFLICT ("userId", "token", "interestDate") DO NOTHING`,
      `led_${rid()}`, u,
    );
    expect(n).toBe(0);
    await insertLedger(u, 'DEPOSIT', '1', { token: '1594' });
    await insertLedger(u, 'DEPOSIT', '1', { token: '1594' });
  });

  it('pins the order shapes; a REJECTED order may keep a non-lot quantity', async () => {
    const u = await newUser();
    await expect(insertOrder(u, { qty: 100, lotSize: 75 })).rejects.toThrow(/core_orders_shape_check/);
    await insertOrder(u, { qty: 100, lotSize: 75, state: 'REJECTED', rejectReason: 'qty 100 is not a multiple of the lot size 75' });
    await expect(insertOrder(u, { state: 'REJECTED' })).rejects.toThrow(/core_orders_shape_check/);
    await expect(insertOrder(u, { type: 'LIMIT' })).rejects.toThrow(/core_orders_shape_check/);
    await expect(insertOrder(u, { state: 'FILLED', filledQty: 40 })).rejects.toThrow(/core_orders_shape_check/);
    await expect(insertOrder(u, { state: 'PENDING' })).rejects.toThrow(/core_orders_vocab_check/);
    await insertOrder(u, { type: 'LIMIT', limitPrice: '499.50' });
  });

  it('pins the default shapes; the owner may add a cap for a new underlying', async () => {
    const upd = (key: string, scope: string, v: string) =>
      db.$executeRawUnsafe(`UPDATE "core_paper_defaults" SET "numValue" = $3::numeric WHERE "key" = $1 AND "scope" = $2`, key, scope, v);
    await expect(upd('mtfFundedShare', 'MTF', '1')).rejects.toThrow(/core_paper_defaults_value_check/);
    await expect(upd('noPriceRejectMs', 'ALL', '999')).rejects.toThrow(/core_paper_defaults_value_check/);
    await expect(upd('maxLotsPerOrder', 'NIFTY', '2.5')).rejects.toThrow(/core_paper_defaults_value_check/);
    const add = (scope: string) =>
      db.$executeRawUnsafe(`INSERT INTO "core_paper_defaults" ("key", "scope", "numValue", "note") VALUES ('maxLotsPerOrder', $1, 4, 'it') ON CONFLICT DO NOTHING`, scope);
    await expect(add('reliance')).rejects.toThrow(/core_paper_defaults_pair_check/);
    await expect(add('MTF')).rejects.toThrow(/core_paper_defaults_pair_check/);
    await add('RELIANCE');
    await db.$executeRawUnsafe(`DELETE FROM "core_paper_defaults" WHERE "key" = 'maxLotsPerOrder' AND "scope" = 'RELIANCE'`);
  });

  it('deleting a user removes their orders, fills and ledger rows', async () => {
    const u = await newUser();
    const o = await insertOrder(u);
    const f = await insertFill(u, o);
    await insertLedger(u, 'DEPOSIT', '1000000');
    await insertLedger(u, 'CHARGES', '-26.92', { orderId: o, fillId: f });
    await db.$executeRawUnsafe(`DELETE FROM "users" WHERE "id" = $1`, u);
    const left = await db.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT ((SELECT count(*) FROM "core_orders" WHERE "userId" = $1) + (SELECT count(*) FROM "core_fills" WHERE "userId" = $1) + (SELECT count(*) FROM "core_cash_ledger" WHERE "userId" = $1))::int AS n`,
      u,
    );
    expect(left[0].n).toBe(0);
  });
});
```

- [ ] **Step 8: Run the opt-in test in a throwaway container, and check drift**

Start Docker Desktop if it is not running. Use a postgres image already present (`docker images postgres`; do not
pull if the disk is low), bound to 127.0.0.1 only, removed afterwards. From the repo root:

```bash
docker run -d --rm --name grw-sp2m3-it -e POSTGRES_PASSWORD=password -p 127.0.0.1:55433:5432 postgres:16-alpine
docker exec grw-sp2m3-it sh -c 'until pg_isready -U postgres; do sleep 1; done'
docker exec grw-sp2m3-it psql -U postgres -c "CREATE DATABASE grw_sp2m3_test" -c "CREATE DATABASE grw_sp2m3_shadow"
DATABASE_URL=postgresql://postgres:password@127.0.0.1:55433/grw_sp2m3_test DIRECT_URL=postgresql://postgres:password@127.0.0.1:55433/grw_sp2m3_test npx prisma migrate deploy --schema prisma/schema.prisma
cd apps/api && DATABASE_URL_TEST=postgresql://postgres:password@127.0.0.1:55433/grw_sp2m3_test npx jest --config test/sp2-m3/jest.config.js -i
```

Expected: `migrate deploy` lists `20261011120000_sp2_m3_execution` as applied; the suite PASSES (7 tests). If
`20261008120000_sp1_m2_candle_store` stops on its TimescaleDB step, that is SP1's deploy SQL, not this migration.

```bash
cd ../.. && npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url postgresql://postgres:password@127.0.0.1:55433/grw_sp2m3_shadow
docker stop grw-sp2m3-it
```

Expected: the only differences are the two pre-existing DESC indexes the M1/M2 ledgers recorded
(`candles_timestamp_idx`, `sentinel_verdicts_createdAt_idx`); nothing mentions `core_orders`, `core_fills`,
`core_cash_ledger` or `core_paper_defaults`. If an M3 object appears, make its table/index/FK SQL match what
Prisma expects (CHECKs and triggers are invisible to the diff and stay).

- [ ] **Step 9: Commit**

```bash
git add -- prisma/schema.prisma prisma/migrations/20261011120000_sp2_m3_execution/migration.sql apps/api/src/common/tenant/tenant.constants.ts apps/api/src/modules/trade-core/execution/core-paper-defaults.spec.ts apps/api/test/sp2-m3/jest.config.js apps/api/test/sp2-m3/core-execution.int.spec.ts
git commit -m "feat(trade-core): core orders, fills, cash ledger and paper defaults tables; append-only triggers; seed" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- prisma/schema.prisma prisma/migrations/20261011120000_sp2_m3_execution/migration.sql apps/api/src/common/tenant/tenant.constants.ts apps/api/src/modules/trade-core/execution/core-paper-defaults.spec.ts apps/api/test/sp2-m3/jest.config.js apps/api/test/sp2-m3/core-execution.int.spec.ts
```

---

### Task 6: Repositories, the per-user transaction and the `paper` audit group

**Files:**
- Create: `apps/api/src/modules/trade-core/execution/repositories/core-order.repository.ts`
- Create: `apps/api/src/modules/trade-core/execution/repositories/core-fill.repository.ts`
- Create: `apps/api/src/modules/trade-core/execution/repositories/core-cash-ledger.repository.ts`
- Create: `apps/api/src/modules/trade-core/execution/repositories/core-paper-defaults.repository.ts`
- Create: `apps/api/src/modules/trade-core/execution/repositories/core-paper-tx.ts`
- Modify: `apps/api/src/common/audit/audit-actions.ts`
- Test: `apps/api/src/modules/trade-core/execution/repositories/core-paper.repository.spec.ts`

**Interfaces:**
- Consumes: the Prisma models (Task 5), `PrismaService` (`common/prisma/prisma.service.ts`, global), `TENANT_MODELS`,
  `CoreOrder`, `FillCharges`, `LedgerType`, `OrderState` (Task 2), `OPEN_STATES` (Task 2).
- Produces:

```typescript
// core-order.repository.ts
export type PaperDb = Prisma.TransactionClient;
export interface NewOrderRow { userId; idempotencyKey; vehicle: Vehicle; exchange; token; symbol; lotSize; underlying: string | null; side: OrderSide; qty; type: OrderType; limitPrice: number | null; triggerPrice: number | null; refPrice: number; purpose: OrderPurpose; strategyVersionId: string | null; state: OrderState; rejectReason: string | null; submittedAt: Date }
export interface OrderUpdate { state?; filledQty?; avgFillPrice?: Prisma.Decimal | null; rejectReason?: string | null; qty?; limitPrice?: number | null; triggerPrice?: number | null }
export function toCoreOrder(r: CoreOrderRow): CoreOrder;
class CoreOrderRepository {
  findByKey(idempotencyKey, db?): Promise<CoreOrder | null>;
  findForUser(userId, id, db?): Promise<CoreOrder | null>;
  listForUser(userId, db?): Promise<CoreOrder[]>;
  listOpenForUser(userId, db?): Promise<CoreOrder[]>;
  listForPosition(userId, vehicle: Vehicle, token, db?): Promise<CoreOrder[]>;
  listOpenAll(): Promise<CoreOrder[]>;                                   // system scan: matcher boot
  listMtfHolders(): Promise<Array<{ userId: string; token: string }>>;   // system scan: interest cron
  create(data: NewOrderRow, db: PaperDb): Promise<CoreOrder>;
  update(userId, id, expect: { state: OrderState; filledQty: number }, data: OrderUpdate, db: PaperDb): Promise<CoreOrder | null>;
}
// core-fill.repository.ts
export interface FillRow { id; orderId; userId; price: Prisma.Decimal; qty; charges: FillCharges; chargesTotal: Prisma.Decimal; priceAt: Date; createdAt: Date }
export interface NewFillRow { orderId; userId; price: Prisma.Decimal; qty; charges: FillCharges; chargesTotal: Prisma.Decimal; priceAt: Date }
class CoreFillRepository { listForOrders(userId, orderIds, db?); listForUser(userId, db?); create(data, db) }
// core-cash-ledger.repository.ts
export interface LedgerEntry { id; userId; type: LedgerType; amount: Prisma.Decimal; orderId: string | null; fillId: string | null; token: string | null; interestDate: string | null; note; createdAt: Date }
export interface NewLedgerRow { userId; type: LedgerType; amount: Prisma.Decimal; orderId?; fillId?; token?; interestDate?: string | null; note }
class CoreCashLedgerRepository { listForUser(userId, db?); append(rows, db): Promise<void>; appendInterest(rows, db): Promise<number>; lastInterestDate(userId, token, db?): Promise<string | null> }
// core-paper-defaults.repository.ts
export interface PaperDefaultRow { key; scope; numValue: Prisma.Decimal; note; updatedBy: string | null; updatedAt: Date }
class CorePaperDefaultsRepository { list(): Promise<PaperDefaultRow[]>; upsert(key, scope, numValue, note, updatedBy, now): Promise<PaperDefaultRow> }
// core-paper-tx.ts
class CorePaperTx { run<T>(userId: string, fn: (db: PaperDb) => Promise<T>): Promise<T> }
// audit-actions.ts
AUDIT_ACTIONS.paper = { CORE_PAPER_DEFAULT_CHANGED: 'CORE_PAPER_DEFAULT_CHANGED' }
```

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/modules/trade-core/execution/repositories/core-paper.repository.spec.ts`:

```typescript
import { Prisma } from '@prisma/client';
import { AUDIT_ACTIONS } from '../../../../common/audit/audit-actions';
import type { PrismaService } from '../../../../common/prisma/prisma.service';
import { TENANT_MODELS } from '../../../../common/tenant/tenant.constants';
import { NOW } from '../testing/paper-fixtures';
import { CoreCashLedgerRepository } from './core-cash-ledger.repository';
import { CoreFillRepository } from './core-fill.repository';
import { CoreOrderRepository, toCoreOrder, type PaperDb } from './core-order.repository';
import { CorePaperDefaultsRepository } from './core-paper-defaults.repository';
import { CorePaperTx } from './core-paper-tx';

const D = (s: string) => new Prisma.Decimal(s);
const OPEN = { in: ['NEW', 'OPEN', 'PARTIAL'] };

function fakePrisma() {
  const prisma = {
    coreOrder: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    coreFill: { findMany: jest.fn().mockResolvedValue([]), create: jest.fn() },
    coreCashLedger: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      createMany: jest.fn().mockResolvedValue({ count: 2 }),
    },
    corePaperDefault: { findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn().mockResolvedValue({}) },
    $executeRaw: jest.fn().mockResolvedValue(1),
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(prisma));
  return prisma;
}

const orderRow = (over: Record<string, unknown> = {}) => ({
  id: 'ord_1', userId: 'user_A', idempotencyKey: 'k1', vehicle: 'OPTIONS_BUY', exchange: 'NFO', token: '43521',
  symbol: 'NIFTY13OCT2625000CE', lotSize: 75, underlying: 'NIFTY', side: 'BUY', qty: 150, filledQty: 75,
  avgFillPrice: D('100.0834'), type: 'LIMIT', limitPrice: D('100.00'), triggerPrice: null, refPrice: D('100.00'),
  purpose: 'ENTRY', strategyVersionId: 'ver_1', state: 'PARTIAL', rejectReason: null, submittedAt: NOW, updatedAt: NOW, ...over,
});

const methods = (cls: { prototype: object }) => Object.getOwnPropertyNames(cls.prototype).filter((n) => n !== 'constructor').sort();

describe('CoreOrderRepository', () => {
  it('every per-user read names the userId', async () => {
    const prisma = fakePrisma();
    const repo = new CoreOrderRepository(prisma as unknown as PrismaService);
    const order = [{ submittedAt: 'asc' }, { id: 'asc' }];
    await repo.findForUser('user_A', 'ord_1');
    expect(prisma.coreOrder.findFirst).toHaveBeenLastCalledWith({ where: { id: 'ord_1', userId: 'user_A' } });
    await repo.listForUser('user_A');
    expect(prisma.coreOrder.findMany).toHaveBeenLastCalledWith({ where: { userId: 'user_A' }, orderBy: order });
    await repo.listOpenForUser('user_A');
    expect(prisma.coreOrder.findMany).toHaveBeenLastCalledWith({ where: { userId: 'user_A', state: OPEN }, orderBy: order });
    await repo.listForPosition('user_A', 'CASH_INTRADAY', '2885');
    expect(prisma.coreOrder.findMany).toHaveBeenLastCalledWith({ where: { userId: 'user_A', vehicle: 'CASH_INTRADAY', token: '2885' }, orderBy: order });
  });

  it('looks an idempotency key up on its own (the service refuses a key of another user)', async () => {
    const prisma = fakePrisma();
    await new CoreOrderRepository(prisma as unknown as PrismaService).findByKey('k1');
    expect(prisma.coreOrder.findUnique).toHaveBeenCalledWith({ where: { idempotencyKey: 'k1' } });
  });

  it('the two system scans are the only cross-user reads', async () => {
    const prisma = fakePrisma();
    const repo = new CoreOrderRepository(prisma as unknown as PrismaService);
    await repo.listOpenAll();
    expect(prisma.coreOrder.findMany).toHaveBeenLastCalledWith({ where: { state: OPEN }, orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }] });
    prisma.coreOrder.findMany.mockResolvedValueOnce([{ userId: 'user_A', token: '1594' }]);
    expect(await repo.listMtfHolders()).toEqual([{ userId: 'user_A', token: '1594' }]);
    expect(prisma.coreOrder.findMany).toHaveBeenLastCalledWith({
      where: { vehicle: 'MTF', filledQty: { gt: 0 } }, select: { userId: true, token: true }, distinct: ['userId', 'token'],
    });
  });

  it('update is guarded by the state and filledQty it was read at; a lost race is null', async () => {
    const prisma = fakePrisma();
    const repo = new CoreOrderRepository(prisma as unknown as PrismaService);
    prisma.coreOrder.findFirst.mockResolvedValueOnce(orderRow({ filledQty: 150, state: 'FILLED' }));
    const out = await repo.update('user_A', 'ord_1', { state: 'PARTIAL', filledQty: 75 }, { state: 'FILLED', filledQty: 150 }, prisma as unknown as PaperDb);
    expect(prisma.coreOrder.updateMany).toHaveBeenCalledWith({
      where: { id: 'ord_1', userId: 'user_A', state: 'PARTIAL', filledQty: 75 }, data: { state: 'FILLED', filledQty: 150 },
    });
    expect(out?.state).toBe('FILLED');
    prisma.coreOrder.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await repo.update('user_A', 'ord_1', { state: 'PARTIAL', filledQty: 75 }, { state: 'FILLED' }, prisma as unknown as PaperDb)).toBeNull();
  });

  it('maps a row to the domain order with numeric prices', () => {
    const o = toCoreOrder(orderRow() as never);
    expect(o.instrument).toEqual({ exchange: 'NFO', token: '43521', symbol: 'NIFTY13OCT2625000CE', lotSize: 75, underlying: 'NIFTY' });
    expect([o.avgFillPrice, o.limitPrice, o.triggerPrice, o.refPrice]).toEqual([100.0834, 100, null, 100]);
  });
});

describe('append-only repositories', () => {
  it('fills: per-user reads; no update or delete method', async () => {
    const prisma = fakePrisma();
    const repo = new CoreFillRepository(prisma as unknown as PrismaService);
    await repo.listForOrders('user_A', ['ord_1', 'ord_2']);
    expect(prisma.coreFill.findMany).toHaveBeenLastCalledWith({ where: { userId: 'user_A', orderId: { in: ['ord_1', 'ord_2'] } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    prisma.coreFill.findMany.mockClear();
    expect(await repo.listForOrders('user_A', [])).toEqual([]);
    expect(prisma.coreFill.findMany).not.toHaveBeenCalled();
    expect(methods(CoreFillRepository)).toEqual(['create', 'listForOrders', 'listForUser']);
  });

  it('ledger: per-user reads; interest is skipDuplicates; dates are days; no update or delete method', async () => {
    const prisma = fakePrisma();
    const repo = new CoreCashLedgerRepository(prisma as unknown as PrismaService);
    await repo.listForUser('user_A');
    expect(prisma.coreCashLedger.findMany).toHaveBeenLastCalledWith({ where: { userId: 'user_A' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    const row = { userId: 'user_A', type: 'MTF_INTEREST' as const, amount: D('-2.47'), token: '1594', interestDate: '2026-10-12', note: 'n' };
    expect(await repo.appendInterest([row, { ...row, interestDate: '2026-10-13' }], prisma as unknown as PaperDb)).toBe(2);
    expect(prisma.coreCashLedger.createMany).toHaveBeenLastCalledWith({
      data: [
        { userId: 'user_A', type: 'MTF_INTEREST', amount: D('-2.47'), orderId: null, fillId: null, token: '1594', interestDate: new Date('2026-10-12T00:00:00.000Z'), note: 'n' },
        { userId: 'user_A', type: 'MTF_INTEREST', amount: D('-2.47'), orderId: null, fillId: null, token: '1594', interestDate: new Date('2026-10-13T00:00:00.000Z'), note: 'n' },
      ],
      skipDuplicates: true,
    });
    prisma.coreCashLedger.findFirst.mockResolvedValueOnce({ interestDate: new Date('2026-10-09T00:00:00.000Z') });
    expect(await repo.lastInterestDate('user_A', '1594')).toBe('2026-10-09');
    expect(prisma.coreCashLedger.findFirst).toHaveBeenLastCalledWith({
      where: { userId: 'user_A', token: '1594', type: 'MTF_INTEREST' }, orderBy: { interestDate: 'desc' }, select: { interestDate: true },
    });
    expect(methods(CoreCashLedgerRepository)).toEqual(['append', 'appendInterest', 'lastInterestDate', 'listForUser']);
  });

  it('append writes nothing for an empty list', async () => {
    const prisma = fakePrisma();
    await new CoreCashLedgerRepository(prisma as unknown as PrismaService).append([], prisma as unknown as PaperDb);
    expect(prisma.coreCashLedger.createMany).not.toHaveBeenCalled();
  });
});

describe('the paper transaction and the defaults', () => {
  it('takes the per-user paper lock before anything else', async () => {
    const prisma = fakePrisma();
    const seen: string[] = [];
    prisma.$executeRaw.mockImplementation(async () => { seen.push('lock'); return 1; });
    await new CorePaperTx(prisma as unknown as PrismaService).run('user_A', async () => { seen.push('work'); });
    expect(seen).toEqual(['lock', 'work']);
    const [strings, key] = prisma.$executeRaw.mock.calls[0];
    expect((strings as string[]).join('?')).toContain('pg_advisory_xact_lock');
    expect(key).toBe('core_paper:user_A');
  });

  it('upserts a default by (key, scope)', async () => {
    const prisma = fakePrisma();
    await new CorePaperDefaultsRepository(prisma as unknown as PrismaService).upsert('slippageBps', 'MTF', D('3'), 'why', 'usr_owner', NOW);
    expect(prisma.corePaperDefault.upsert).toHaveBeenCalledWith({
      where: { key_scope: { key: 'slippageBps', scope: 'MTF' } },
      create: { key: 'slippageBps', scope: 'MTF', numValue: D('3'), note: 'why', updatedBy: 'usr_owner', updatedAt: NOW },
      update: { numValue: D('3'), note: 'why', updatedBy: 'usr_owner', updatedAt: NOW },
    });
  });
});

describe('wiring constants', () => {
  it('the per-user execution models are tenant models; the global defaults are not', () => {
    for (const m of ['CoreOrder', 'CoreFill', 'CoreCashLedger']) expect(TENANT_MODELS.has(m)).toBe(true);
    expect(TENANT_MODELS.has('CorePaperDefault')).toBe(false);
  });

  it('the paper audit action exists', () => {
    expect(AUDIT_ACTIONS.paper).toEqual({ CORE_PAPER_DEFAULT_CHANGED: 'CORE_PAPER_DEFAULT_CHANGED' });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest src/modules/trade-core/execution/repositories/core-paper.repository.spec.ts`
Expected: FAIL with `Cannot find module './core-cash-ledger.repository'`.

- [ ] **Step 3: Add the audit group**

In `apps/api/src/common/audit/audit-actions.ts`, add a `paper` group after the `risk` group (inside `AUDIT_ACTIONS`,
before `} as const;`):

```typescript
  paper: {
    CORE_PAPER_DEFAULT_CHANGED: 'CORE_PAPER_DEFAULT_CHANGED',
  },
```

- [ ] **Step 4: Write the repositories**

Create `apps/api/src/modules/trade-core/execution/repositories/core-order.repository.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import type { CoreOrder as CoreOrderRow, Prisma } from '@prisma/client';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import type { Vehicle } from '../../strategies/blocks/block-types';
import type { CoreOrder, OrderPurpose, OrderSide, OrderState, OrderType } from '../execution.types';
import { OPEN_STATES } from '../order-state';

/** A transaction client, or PrismaService itself for reads outside one. */
export type PaperDb = Prisma.TransactionClient;

export interface NewOrderRow {
  userId: string;
  idempotencyKey: string;
  vehicle: Vehicle;
  exchange: string;
  token: string;
  symbol: string;
  lotSize: number;
  underlying: string | null;
  side: OrderSide;
  qty: number;
  type: OrderType;
  limitPrice: number | null;
  triggerPrice: number | null;
  refPrice: number;
  purpose: OrderPurpose;
  strategyVersionId: string | null;
  state: OrderState;
  rejectReason: string | null;
  submittedAt: Date;
}

export interface OrderUpdate {
  state?: OrderState;
  filledQty?: number;
  avgFillPrice?: Prisma.Decimal | null;
  rejectReason?: string | null;
  qty?: number;
  limitPrice?: number | null;
  triggerPrice?: number | null;
}

const num = (d: Prisma.Decimal | null): number | null => (d === null ? null : d.toNumber());

export function toCoreOrder(r: CoreOrderRow): CoreOrder {
  return {
    id: r.id,
    userId: r.userId,
    idempotencyKey: r.idempotencyKey,
    vehicle: r.vehicle as Vehicle,
    instrument: { exchange: r.exchange, token: r.token, symbol: r.symbol, lotSize: r.lotSize, underlying: r.underlying },
    side: r.side as OrderSide,
    qty: r.qty,
    filledQty: r.filledQty,
    avgFillPrice: num(r.avgFillPrice),
    type: r.type as OrderType,
    limitPrice: num(r.limitPrice),
    triggerPrice: num(r.triggerPrice),
    refPrice: r.refPrice.toNumber(),
    purpose: r.purpose as OrderPurpose,
    strategyVersionId: r.strategyVersionId,
    state: r.state as OrderState,
    rejectReason: r.rejectReason,
    submittedAt: r.submittedAt,
    updatedAt: r.updatedAt,
  };
}

const OLDEST_FIRST = [{ submittedAt: 'asc' as const }, { id: 'asc' as const }];

/**
 * core_orders. Every per-user query names the userId; the tenant extension adds the
 * same filter for non-admin requests. findByKey reads the globally unique key alone so
 * the service can refuse a key that belongs to another user (it never returns that
 * order). listOpenAll and listMtfHolders are the two system scans (plan Global
 * Constraints). Updates are guarded by the state and filledQty the caller read.
 */
@Injectable()
export class CoreOrderRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByKey(idempotencyKey: string, db: PaperDb = this.prisma): Promise<CoreOrder | null> {
    const r = await db.coreOrder.findUnique({ where: { idempotencyKey } });
    return r ? toCoreOrder(r) : null;
  }

  async findForUser(userId: string, id: string, db: PaperDb = this.prisma): Promise<CoreOrder | null> {
    const r = await db.coreOrder.findFirst({ where: { id, userId } });
    return r ? toCoreOrder(r) : null;
  }

  async listForUser(userId: string, db: PaperDb = this.prisma): Promise<CoreOrder[]> {
    return (await db.coreOrder.findMany({ where: { userId }, orderBy: OLDEST_FIRST })).map(toCoreOrder);
  }

  async listOpenForUser(userId: string, db: PaperDb = this.prisma): Promise<CoreOrder[]> {
    return (await db.coreOrder.findMany({ where: { userId, state: { in: [...OPEN_STATES] } }, orderBy: OLDEST_FIRST })).map(toCoreOrder);
  }

  async listForPosition(userId: string, vehicle: Vehicle, token: string, db: PaperDb = this.prisma): Promise<CoreOrder[]> {
    return (await db.coreOrder.findMany({ where: { userId, vehicle, token }, orderBy: OLDEST_FIRST })).map(toCoreOrder);
  }

  /** System scan (matcher boot): every user's open orders. */
  async listOpenAll(): Promise<CoreOrder[]> {
    return (await this.prisma.coreOrder.findMany({ where: { state: { in: [...OPEN_STATES] } }, orderBy: OLDEST_FIRST })).map(toCoreOrder);
  }

  /** System scan (interest cron): every (user, token) that has ever bought MTF. */
  listMtfHolders(): Promise<Array<{ userId: string; token: string }>> {
    return this.prisma.coreOrder.findMany({
      where: { vehicle: 'MTF', filledQty: { gt: 0 } },
      select: { userId: true, token: true },
      distinct: ['userId', 'token'],
    });
  }

  async create(data: NewOrderRow, db: PaperDb): Promise<CoreOrder> {
    return toCoreOrder(await db.coreOrder.create({ data }));
  }

  /** Applies `data` only if the row is still in `expect`; null when another writer got there first. */
  async update(userId: string, id: string, expect: { state: OrderState; filledQty: number }, data: OrderUpdate, db: PaperDb): Promise<CoreOrder | null> {
    const { count } = await db.coreOrder.updateMany({ where: { id, userId, state: expect.state, filledQty: expect.filledQty }, data });
    if (count !== 1) return null;
    return this.findForUser(userId, id, db);
  }
}
```

Create `apps/api/src/modules/trade-core/execution/repositories/core-fill.repository.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import type { CoreFill as CoreFillRow, Prisma } from '@prisma/client';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import type { FillCharges } from '../execution.types';
import type { PaperDb } from './core-order.repository';

export interface FillRow {
  id: string;
  orderId: string;
  userId: string;
  price: Prisma.Decimal;
  qty: number;
  charges: FillCharges;
  chargesTotal: Prisma.Decimal;
  priceAt: Date;
  createdAt: Date;
}

export interface NewFillRow {
  orderId: string;
  userId: string;
  price: Prisma.Decimal;
  qty: number;
  charges: FillCharges;
  chargesTotal: Prisma.Decimal;
  priceAt: Date;
}

const toFill = (r: CoreFillRow): FillRow => ({
  id: r.id,
  orderId: r.orderId,
  userId: r.userId,
  price: r.price,
  qty: r.qty,
  charges: r.charges as unknown as FillCharges,
  chargesTotal: r.chargesTotal,
  priceAt: r.priceAt,
  createdAt: r.createdAt,
});

const OLDEST_FIRST = [{ createdAt: 'asc' as const }, { id: 'asc' as const }];

/** core_fills: append-only (spec §4.5). No update or delete method; a trigger refuses UPDATE. */
@Injectable()
export class CoreFillRepository {
  constructor(private readonly prisma: PrismaService) {}

  async listForOrders(userId: string, orderIds: readonly string[], db: PaperDb = this.prisma): Promise<FillRow[]> {
    if (orderIds.length === 0) return [];
    return (await db.coreFill.findMany({ where: { userId, orderId: { in: [...orderIds] } }, orderBy: OLDEST_FIRST })).map(toFill);
  }

  async listForUser(userId: string, db: PaperDb = this.prisma): Promise<FillRow[]> {
    return (await db.coreFill.findMany({ where: { userId }, orderBy: OLDEST_FIRST })).map(toFill);
  }

  async create(data: NewFillRow, db: PaperDb): Promise<FillRow> {
    return toFill(await db.coreFill.create({ data: { ...data, charges: data.charges as unknown as Prisma.InputJsonValue } }));
  }
}
```

Create `apps/api/src/modules/trade-core/execution/repositories/core-cash-ledger.repository.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import type { CoreCashLedger as CoreCashLedgerRow, Prisma } from '@prisma/client';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import type { LedgerType } from '../execution.types';
import type { PaperDb } from './core-order.repository';

export interface LedgerEntry {
  id: string;
  userId: string;
  type: LedgerType;
  amount: Prisma.Decimal;
  orderId: string | null;
  fillId: string | null;
  token: string | null;
  /** YYYY-MM-DD, MTF_INTEREST only. */
  interestDate: string | null;
  note: string;
  createdAt: Date;
}

export interface NewLedgerRow {
  userId: string;
  type: LedgerType;
  amount: Prisma.Decimal;
  orderId?: string | null;
  fillId?: string | null;
  token?: string | null;
  interestDate?: string | null;
  note: string;
}

const dayOf = (d: Date | null): string | null => (d ? d.toISOString().slice(0, 10) : null);

const toEntry = (r: CoreCashLedgerRow): LedgerEntry => ({
  id: r.id,
  userId: r.userId,
  type: r.type as LedgerType,
  amount: r.amount,
  orderId: r.orderId,
  fillId: r.fillId,
  token: r.token,
  interestDate: dayOf(r.interestDate),
  note: r.note,
  createdAt: r.createdAt,
});

const toData = (r: NewLedgerRow) => ({
  userId: r.userId,
  type: r.type,
  amount: r.amount,
  orderId: r.orderId ?? null,
  fillId: r.fillId ?? null,
  token: r.token ?? null,
  interestDate: r.interestDate ? new Date(`${r.interestDate}T00:00:00.000Z`) : null,
  note: r.note,
});

/**
 * core_cash_ledger: append-only (spec §4.4). No update or delete method; a trigger
 * refuses UPDATE. appendInterest relies on the unique (userId, token, interestDate)
 * index to make the nightly posting idempotent.
 */
@Injectable()
export class CoreCashLedgerRepository {
  constructor(private readonly prisma: PrismaService) {}

  async listForUser(userId: string, db: PaperDb = this.prisma): Promise<LedgerEntry[]> {
    return (await db.coreCashLedger.findMany({ where: { userId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })).map(toEntry);
  }

  async append(rows: readonly NewLedgerRow[], db: PaperDb): Promise<void> {
    if (rows.length === 0) return;
    await db.coreCashLedger.createMany({ data: rows.map(toData) });
  }

  /** Inserts the interest days not yet posted; returns how many were new. */
  async appendInterest(rows: readonly NewLedgerRow[], db: PaperDb): Promise<number> {
    if (rows.length === 0) return 0;
    const { count } = await db.coreCashLedger.createMany({ data: rows.map(toData), skipDuplicates: true });
    return count;
  }

  async lastInterestDate(userId: string, token: string, db: PaperDb = this.prisma): Promise<string | null> {
    const r = await db.coreCashLedger.findFirst({
      where: { userId, token, type: 'MTF_INTEREST' },
      orderBy: { interestDate: 'desc' },
      select: { interestDate: true },
    });
    return dayOf(r?.interestDate ?? null);
  }
}
```

Create `apps/api/src/modules/trade-core/execution/repositories/core-paper-defaults.repository.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../common/prisma/prisma.service';

export interface PaperDefaultRow {
  key: string;
  scope: string;
  numValue: Prisma.Decimal;
  note: string;
  updatedBy: string | null;
  updatedAt: Date;
}

/** core_paper_defaults: global settings data, owner-edited (not append-only; its CHECKs pin the shapes). */
@Injectable()
export class CorePaperDefaultsRepository {
  constructor(private readonly prisma: PrismaService) {}

  list(): Promise<PaperDefaultRow[]> {
    return this.prisma.corePaperDefault.findMany({ orderBy: [{ key: 'asc' }, { scope: 'asc' }] });
  }

  upsert(key: string, scope: string, numValue: Prisma.Decimal, note: string, updatedBy: string, now: Date): Promise<PaperDefaultRow> {
    return this.prisma.corePaperDefault.upsert({
      where: { key_scope: { key, scope } },
      create: { key, scope, numValue, note, updatedBy, updatedAt: now },
      update: { numValue, note, updatedBy, updatedAt: now },
    });
  }
}
```

Create `apps/api/src/modules/trade-core/execution/repositories/core-paper-tx.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import type { PaperDb } from './core-order.repository';

/**
 * One transaction under the user's paper lock (spec §5: order state, fill and ledger
 * rows commit together). The lock serialises a user's placements, fills and closes, so
 * a free-cash check and the margin it blocks can never interleave with another write.
 */
@Injectable()
export class CorePaperTx {
  constructor(private readonly prisma: PrismaService) {}

  run<T>(userId: string, fn: (db: PaperDb) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`core_paper:${userId}`}, 0))`;
      return fn(tx);
    });
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx jest src/modules/trade-core/execution/repositories/core-paper.repository.spec.ts`
Expected: PASS (12 tests).

- [ ] **Step 6: Commit**

```bash
git add -- apps/api/src/modules/trade-core/execution/repositories apps/api/src/common/audit/audit-actions.ts
git commit -m "feat(trade-core): core order, fill, cash ledger and paper defaults repositories; per-user paper transaction" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/api/src/modules/trade-core/execution/repositories apps/api/src/common/audit/audit-actions.ts
```

---

### Task 7: Owner-editable paper defaults (service, controller, audit)

**Files:**
- Create: `apps/api/src/modules/trade-core/execution/services/core-paper-defaults.service.ts`
- Create: `apps/api/src/modules/trade-core/execution/controllers/core-paper-defaults.controller.ts`
- Test: `apps/api/src/modules/trade-core/execution/services/core-paper-defaults.service.spec.ts`
- Test: `apps/api/src/modules/trade-core/execution/controllers/core-paper-defaults.controller.spec.ts`

**Interfaces:**
- Consumes: `CorePaperDefaultsRepository` (Task 6), `PAPER_KEYS`, `isPaperKey`, `isPaperPair`, `parsePaperValue`,
  `resolvePaperSettings`, `PaperSettingsResult` (Task 3), `AuditService`, `AUDIT_ACTIONS.paper` (Task 6),
  `Actor` (`strategies/services/core-strategy-catalogue.service.ts:16`), `ChangeLimitDto`
  (`risk-wall/dto/core-risk.dto.ts:33`), `AdminOnly`, `CurrentUser`, `AuthenticatedUser` (`common/decorators`).
- Produces:

```typescript
export const PAPER_SETTINGS_CACHE_MS = 5_000;
export interface CorePaperDefaultView { key: PaperKey; scope: string; value: number; note: string; updatedBy: string | null; updatedAt: string }
export interface PaperDefaultChangeInput { key: string; scope: string; value: unknown; reason: string }
class CorePaperDefaultsService {
  settings(now?: number): Promise<PaperSettingsResult>;   // cached ≤ 5 s; a read error throws (callers fail closed) and is not cached
  list(): Promise<CorePaperDefaultView[]>;
  change(actor: Actor, input: PaperDefaultChangeInput, now?: Date): Promise<CorePaperDefaultView>;
}
// routes (class-level @AdminOnly)
GET /api/trade-core/paper/defaults               → { defaults: CorePaperDefaultView[] }
PUT /api/trade-core/paper/defaults/:key/:scope   { value, reason } → CorePaperDefaultView
```

Rules: owner only (route guard and a service re-check, like M2 decision 20); a change applies at once (a default is
not "in force" for anyone's open order: an order's margin is blocked with the settings of its placement and every
release is computed from ledger rows, plan ruling 4); the reason replaces the note; the settings cache is dropped
on every change; audited `CORE_PAPER_DEFAULT_CHANGED` with `{ key, scope, from, to, reason }` (2-dp strings).

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/modules/trade-core/execution/services/core-paper-defaults.service.spec.ts`:

```typescript
import { ForbiddenException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { AuditService } from '../../../../common/audit/audit.service';
import type { CorePaperDefaultsRepository, PaperDefaultRow } from '../repositories/core-paper-defaults.repository';
import { NOW, SEED_ROWS } from '../testing/paper-fixtures';
import { CorePaperDefaultsService } from './core-paper-defaults.service';

const OWNER = { userId: 'usr_owner', role: 'ADMIN' };
const USER = { userId: 'user_A', role: 'USER' };
const T = NOW.getTime();

function setup() {
  const store: { rows: PaperDefaultRow[] } = { rows: SEED_ROWS.map((r) => ({ ...r, note: 'seed', updatedBy: null, updatedAt: NOW })) };
  const repo = {
    list: jest.fn(async () => store.rows),
    upsert: jest.fn(async (key: string, scope: string, numValue: PaperDefaultRow['numValue'], note: string, updatedBy: string, now: Date) => {
      const row = { key, scope, numValue, note, updatedBy, updatedAt: now };
      store.rows = [...store.rows.filter((r) => !(r.key === key && r.scope === scope)), row];
      return row;
    }),
  };
  const audit = { append: jest.fn().mockResolvedValue({ seq: 1n, hash: 'h' }) };
  const svc = new CorePaperDefaultsService(repo as unknown as CorePaperDefaultsRepository, audit as unknown as AuditService);
  return { store, repo, audit, svc };
}

describe('CorePaperDefaultsService', () => {
  it('resolves the settings from the rows and caches them for 5 s', async () => {
    const { repo, svc } = setup();
    const a = await svc.settings(T);
    expect(a.ok && a.settings.noPriceRejectMs).toBe(30000);
    await svc.settings(T + 4_999);
    expect(repo.list).toHaveBeenCalledTimes(1);
    await svc.settings(T + 5_000);
    expect(repo.list).toHaveBeenCalledTimes(2);
  });

  it('an incomplete table fails closed with the missing pairs', async () => {
    const { store, svc } = setup();
    store.rows = store.rows.filter((r) => r.key !== 'startingCapital');
    expect(await svc.settings(T)).toEqual({ ok: false, missing: ['startingCapital@ALL'] });
  });

  it('an unreadable table throws and is not cached', async () => {
    const { repo, svc } = setup();
    repo.list.mockRejectedValueOnce(new Error('db down'));
    await expect(svc.settings(T)).rejects.toThrow('db down');
    expect((await svc.settings(T + 1)).ok).toBe(true);
  });

  it('lists every row in key order with its note', async () => {
    const { svc } = setup();
    const views = await svc.list();
    expect(views).toHaveLength(14);
    expect(views[0]).toEqual({ key: 'startingCapital', scope: 'ALL', value: 1000000, note: 'seed', updatedBy: null, updatedAt: NOW.toISOString() });
    expect(views.map((v) => v.key).slice(-5)).toEqual(Array(5).fill('maxLotsPerOrder'));
  });

  it('the owner changes a default at once; the reason becomes its note; it is audited; the cache is dropped', async () => {
    const { audit, svc } = setup();
    await svc.settings(T);
    const v = await svc.change(OWNER, { key: 'slippageBps', scope: 'OPTIONS_BUY', value: 30, reason: '  tighter fills  ' }, NOW);
    expect(v).toEqual({ key: 'slippageBps', scope: 'OPTIONS_BUY', value: 30, note: 'tighter fills', updatedBy: 'usr_owner', updatedAt: NOW.toISOString() });
    expect(audit.append).toHaveBeenCalledWith({
      action: 'CORE_PAPER_DEFAULT_CHANGED',
      userId: 'usr_owner',
      target: 'core_paper_default:slippageBps@OPTIONS_BUY',
      meta: { key: 'slippageBps', scope: 'OPTIONS_BUY', from: '50.00', to: '30.00', reason: 'tighter fills' },
    });
    const after = await svc.settings(T + 1);
    expect(after.ok && after.settings.slippageBps.OPTIONS_BUY.toFixed(2)).toBe('30.00');
  });

  it('the owner can add a cap for another underlying', async () => {
    const { audit, svc } = setup();
    await svc.change(OWNER, { key: 'maxLotsPerOrder', scope: 'RELIANCE', value: 4, reason: 'stock options' }, NOW);
    expect(audit.append.mock.calls[0][0].meta).toEqual({ key: 'maxLotsPerOrder', scope: 'RELIANCE', from: null, to: '4.00', reason: 'stock options' });
    const s = await svc.settings(T);
    expect(s.ok && s.settings.maxLotsPerOrder.RELIANCE).toBe(4);
  });

  it('only the owner may change a default, even if the route guard were bypassed; nothing is written', async () => {
    const { repo, audit, svc } = setup();
    await expect(svc.change(USER, { key: 'startingCapital', scope: 'ALL', value: 5, reason: 'mine' }, NOW)).rejects.toBeInstanceOf(ForbiddenException);
    expect(repo.upsert).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
  });

  it('an unknown key or scope is 404; a bad value is 422', async () => {
    const { svc } = setup();
    await expect(svc.change(OWNER, { key: 'nope', scope: 'ALL', value: 1, reason: 'why not' }, NOW)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.change(OWNER, { key: 'startingCapital', scope: 'MTF', value: 1, reason: 'why not' }, NOW)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.change(OWNER, { key: 'maxLotsPerOrder', scope: 'nifty', value: 1, reason: 'why not' }, NOW)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.change(OWNER, { key: 'mtfFundedShare', scope: 'MTF', value: 1, reason: 'why not' }, NOW)).rejects.toBeInstanceOf(UnprocessableEntityException);
  });
});
```

Create `apps/api/src/modules/trade-core/execution/controllers/core-paper-defaults.controller.spec.ts`:

```typescript
import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ROLES_KEY, type AuthenticatedUser } from '../../../../common/decorators';
import type { CorePaperDefaultsService } from '../services/core-paper-defaults.service';
import { CorePaperDefaultsController } from './core-paper-defaults.controller';

const OWNER: AuthenticatedUser = { userId: 'usr_owner', role: 'ADMIN', email: 'o@x' };

describe('CorePaperDefaultsController', () => {
  it('serves /api/trade-core/paper/defaults, the whole controller @AdminOnly', () => {
    expect(Reflect.getMetadata(PATH_METADATA, CorePaperDefaultsController)).toBe('api/trade-core/paper/defaults');
    expect(Reflect.getMetadata(ROLES_KEY, CorePaperDefaultsController)).toEqual(['ADMIN']);
    expect(Reflect.getMetadata(METHOD_METADATA, CorePaperDefaultsController.prototype.list)).toBe(RequestMethod.GET);
    expect(Reflect.getMetadata(METHOD_METADATA, CorePaperDefaultsController.prototype.change)).toBe(RequestMethod.PUT);
    expect(Reflect.getMetadata(PATH_METADATA, CorePaperDefaultsController.prototype.change)).toBe(':key/:scope');
  });

  it('passes the token user as the actor', async () => {
    const svc = { list: jest.fn().mockResolvedValue([]), change: jest.fn().mockResolvedValue({}) };
    const controller = new CorePaperDefaultsController(svc as unknown as CorePaperDefaultsService);
    expect(await controller.list()).toEqual({ defaults: [] });
    await controller.change(OWNER, 'slippageBps', 'MTF', { value: 3, reason: 'tighter fills' });
    expect(svc.change).toHaveBeenCalledWith({ userId: 'usr_owner', role: 'ADMIN' }, { key: 'slippageBps', scope: 'MTF', value: 3, reason: 'tighter fills' });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx jest src/modules/trade-core/execution/services/core-paper-defaults.service.spec.ts src/modules/trade-core/execution/controllers/core-paper-defaults.controller.spec.ts`
Expected: FAIL with `Cannot find module './core-paper-defaults.service'` and `'./core-paper-defaults.controller'`.

- [ ] **Step 3: Write the service and the controller**

Create `apps/api/src/modules/trade-core/execution/services/core-paper-defaults.service.ts`:

```typescript
import { ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { AuditService } from '../../../../common/audit/audit.service';
import { AUDIT_ACTIONS } from '../../../../common/audit/audit-actions';
import type { Actor } from '../../strategies/services/core-strategy-catalogue.service';
import { isPaperKey, isPaperPair, PAPER_KEYS, parsePaperValue, resolvePaperSettings, type PaperKey, type PaperSettingsResult } from '../paper-settings';
import { CorePaperDefaultsRepository, type PaperDefaultRow } from '../repositories/core-paper-defaults.repository';

/** How long resolved settings are reused (a bound on staleness after an edit by another instance). */
export const PAPER_SETTINGS_CACHE_MS = 5_000;

export interface CorePaperDefaultView {
  key: PaperKey;
  scope: string;
  value: number;
  note: string;
  updatedBy: string | null;
  updatedAt: string;
}

export interface PaperDefaultChangeInput {
  key: string;
  scope: string;
  value: unknown;
  reason: string;
}

const viewOf = (r: PaperDefaultRow): CorePaperDefaultView => ({
  key: r.key as PaperKey,
  scope: r.scope,
  value: r.numValue.toNumber(),
  note: r.note,
  updatedBy: r.updatedBy,
  updatedAt: r.updatedAt.toISOString(),
});

const keyRank = (k: string) => PAPER_KEYS.indexOf(k as PaperKey);

/**
 * The paper settings (spec §4.5): resolved from core_paper_defaults for every order,
 * fill and interest run, and edited by the owner only (mirrors M2's
 * CoreRiskDefaultsService). A read failure throws so every caller fails closed; it is
 * never cached.
 */
@Injectable()
export class CorePaperDefaultsService {
  private cache: { at: number; result: PaperSettingsResult } | null = null;

  constructor(
    private readonly repo: CorePaperDefaultsRepository,
    private readonly audit: AuditService,
  ) {}

  async settings(now: number = Date.now()): Promise<PaperSettingsResult> {
    if (this.cache && now - this.cache.at < PAPER_SETTINGS_CACHE_MS) return this.cache.result;
    const result = resolvePaperSettings(await this.repo.list());
    this.cache = { at: now, result };
    return result;
  }

  async list(): Promise<CorePaperDefaultView[]> {
    const rows = await this.repo.list();
    return [...rows].sort((a, b) => keyRank(a.key) - keyRank(b.key) || a.scope.localeCompare(b.scope)).map(viewOf);
  }

  async change(actor: Actor, input: PaperDefaultChangeInput, now: Date = new Date()): Promise<CorePaperDefaultView> {
    if (actor.role !== 'ADMIN') throw new ForbiddenException('only the owner edits the paper defaults');
    if (!isPaperKey(input.key)) throw new NotFoundException(`unknown paper setting ${input.key}`);
    if (!isPaperPair(input.key, input.scope)) {
      throw new NotFoundException(
        input.key === 'maxLotsPerOrder' ? 'maxLotsPerOrder is scoped by an upper-case underlying such as NIFTY' : `${input.key} has no ${input.scope} scope`,
      );
    }
    const parsed = parsePaperValue(input.key, input.value);
    if (!parsed.ok) throw new UnprocessableEntityException(`${input.key} ${parsed.error}`);
    const reason = input.reason.trim();

    const before = (await this.repo.list()).find((r) => r.key === input.key && r.scope === input.scope);
    const row = await this.repo.upsert(input.key, input.scope, parsed.value, reason, actor.userId, now);
    this.cache = null;
    await this.audit.append({
      action: AUDIT_ACTIONS.paper.CORE_PAPER_DEFAULT_CHANGED,
      userId: actor.userId,
      target: `core_paper_default:${input.key}@${input.scope}`,
      meta: { key: input.key, scope: input.scope, from: before ? before.numValue.toFixed(2) : null, to: parsed.value.toFixed(2), reason },
    });
    return viewOf(row);
  }
}
```

Create `apps/api/src/modules/trade-core/execution/controllers/core-paper-defaults.controller.ts`:

```typescript
import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AdminOnly, CurrentUser, type AuthenticatedUser } from '../../../../common/decorators';
import { ChangeLimitDto } from '../../risk-wall/dto/core-risk.dto';
import { CorePaperDefaultsService, type CorePaperDefaultView } from '../services/core-paper-defaults.service';

/** Owner-only editing of the paper defaults (spec §4.5). The service re-checks the role. UI is M5. */
@ApiTags('Trade core: paper defaults')
@AdminOnly()
@Controller('api/trade-core/paper/defaults')
export class CorePaperDefaultsController {
  constructor(private readonly defaults: CorePaperDefaultsService) {}

  @Get()
  async list(): Promise<{ defaults: CorePaperDefaultView[] }> {
    return { defaults: await this.defaults.list() };
  }

  @Put(':key/:scope')
  change(
    @CurrentUser() user: AuthenticatedUser,
    @Param('key') key: string,
    @Param('scope') scope: string,
    @Body() dto: ChangeLimitDto,
  ): Promise<CorePaperDefaultView> {
    return this.defaults.change({ userId: user.userId, role: user.role }, { key, scope, value: dto.value, reason: dto.reason });
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest src/modules/trade-core/execution/services/core-paper-defaults.service.spec.ts src/modules/trade-core/execution/controllers/core-paper-defaults.controller.spec.ts`
Expected: PASS (8 + 2 tests).

- [ ] **Step 5: Commit**

```bash
git add -- apps/api/src/modules/trade-core/execution/services apps/api/src/modules/trade-core/execution/controllers
git commit -m "feat(trade-core): owner-only, audited editing of the paper defaults with a cached settings reader" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/api/src/modules/trade-core/execution/services apps/api/src/modules/trade-core/execution/controllers
```

---

### Task 8: `PaperLedgerService` part 1 — place, close, reads (and the in-memory store)

**Files:**
- Create: `apps/api/src/modules/trade-core/execution/paper-ledger.service.ts`
- Create: `apps/api/src/modules/trade-core/execution/testing/memory-paper-store.ts`
- Test: `apps/api/src/modules/trade-core/execution/paper-ledger.service.spec.ts`

**Interfaces:**
- Consumes: repositories and `CorePaperTx` (Task 6), `CorePaperDefaultsService` (Task 7), `validateOrder` (Task 4),
  `marginFor`, `marginRefPrice` (Task 3), `balances`, `applyPositionFill`, `FLAT`, `istDate`, `money`, `ZERO`
  (Task 3), `transition`, `nextState`, `isOpenState` (Task 2).
- Produces:

```typescript
export interface PlaceContext { sessionOpen: boolean; killSwitchActive: boolean }
export interface PlaceResult { order: CoreOrder; created: boolean; settings: PaperSettings | null }
export interface PositionContext { orders: CoreOrder[]; fills: FillRow[]; state: PositionState; pendingExitQty: number; blocked: Prisma.Decimal }
export function heldMargin(rows: readonly LedgerEntry[], pick: (r: LedgerEntry) => boolean): Prisma.Decimal;
export function pendingMargin(rows: readonly LedgerEntry[], orderId: string): Prisma.Decimal;
export const positionKey: (o: Pick<CoreOrder, 'vehicle' | 'instrument'>) => string;   // `${vehicle}:${token}`
class PaperLedgerService {
  place(req: CoreOrderRequest, ctx: PlaceContext, now?: Date): Promise<PlaceResult>;
  close(userId: string, orderId: string, event: 'CANCEL' | 'REJECT', reason: string): Promise<CoreOrder>;
  getOrder(userId: string, orderId: string): Promise<CoreOrder>;           // 404 when not the user's
  findOrder(userId: string, orderId: string): Promise<CoreOrder | null>;
  openOrders(): Promise<CoreOrder[]>;                                      // system scan (matcher boot)
  openOrdersForUser(userId: string): Promise<CoreOrder[]>;
  funds(userId: string): Promise<CoreFunds>;
  dayStats(userId: string, now: Date): Promise<{ netPnlToday: Prisma.Decimal; entriesToday: number }>;
  positionContext(userId: string, vehicle: Vehicle, token: string, rows: readonly LedgerEntry[], db?: PaperDb): Promise<PositionContext>;
}
// testing/memory-paper-store.ts
export class MemoryPaperStore { orders; fills; ledger; txUsers; tx: CorePaperTx; orderRepo: CoreOrderRepository; fillRepo: CoreFillRepository; ledgerRepo: CoreCashLedgerRepository; constructor(clock?: () => Date) }
export function fakeDefaults(settings?: PaperSettings | null): CorePaperDefaultsService;
```

- [ ] **Step 1: Write the in-memory store**

Create `apps/api/src/modules/trade-core/execution/testing/memory-paper-store.ts`:

```typescript
import { Prisma } from '@prisma/client';
import type { Vehicle } from '../../strategies/blocks/block-types';
import type { CoreOrder, OrderState } from '../execution.types';
import { isOpenState } from '../order-state';
import type { PaperSettings } from '../paper-settings';
import type { CoreCashLedgerRepository, LedgerEntry, NewLedgerRow } from '../repositories/core-cash-ledger.repository';
import type { CoreFillRepository, FillRow, NewFillRow } from '../repositories/core-fill.repository';
import type { CoreOrderRepository, NewOrderRow, OrderUpdate } from '../repositories/core-order.repository';
import type { CorePaperTx } from '../repositories/core-paper-tx';
import type { CorePaperDefaultsService } from '../services/core-paper-defaults.service';
import { paperSettings } from './paper-fixtures';

const copy = (o: CoreOrder): CoreOrder => ({ ...o, instrument: { ...o.instrument } });

/**
 * One in-memory database behind the three repositories and the paper transaction, for
 * service tests. There is no rollback: the services write their guarded order update
 * before any fill or ledger row, so a lost race writes nothing here either.
 */
export class MemoryPaperStore {
  orders: CoreOrder[] = [];
  fills: FillRow[] = [];
  ledger: LedgerEntry[] = [];
  /** The userId of every transaction, in order. */
  txUsers: string[] = [];
  private seq = 0;

  constructor(private readonly clock: () => Date = () => new Date()) {}

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}_${this.seq}`;
  }

  readonly tx = {
    run: async <T>(userId: string, fn: (db: never) => Promise<T>): Promise<T> => {
      this.txUsers.push(userId);
      return fn(undefined as never);
    },
  } as unknown as CorePaperTx;

  readonly orderRepo = {
    findByKey: async (key: string) => {
      const o = this.orders.find((x) => x.idempotencyKey === key);
      return o ? copy(o) : null;
    },
    findForUser: async (userId: string, id: string) => {
      const o = this.orders.find((x) => x.id === id && x.userId === userId);
      return o ? copy(o) : null;
    },
    listForUser: async (userId: string) => this.orders.filter((o) => o.userId === userId).map(copy),
    listOpenForUser: async (userId: string) => this.orders.filter((o) => o.userId === userId && isOpenState(o.state)).map(copy),
    listForPosition: async (userId: string, vehicle: Vehicle, token: string) =>
      this.orders.filter((o) => o.userId === userId && o.vehicle === vehicle && o.instrument.token === token).map(copy),
    listOpenAll: async () => this.orders.filter((o) => isOpenState(o.state)).map(copy),
    listMtfHolders: async () => {
      const seen = new Map<string, { userId: string; token: string }>();
      for (const o of this.orders) {
        if (o.vehicle === 'MTF' && o.filledQty > 0) seen.set(`${o.userId}|${o.instrument.token}`, { userId: o.userId, token: o.instrument.token });
      }
      return [...seen.values()];
    },
    create: async (data: NewOrderRow) => {
      if (this.orders.some((o) => o.idempotencyKey === data.idempotencyKey)) {
        throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`idempotencyKey`)', { code: 'P2002', clientVersion: 'memory' });
      }
      const o: CoreOrder = {
        id: this.nextId('ord'),
        userId: data.userId,
        idempotencyKey: data.idempotencyKey,
        vehicle: data.vehicle,
        instrument: { exchange: data.exchange, token: data.token, symbol: data.symbol, lotSize: data.lotSize, underlying: data.underlying },
        side: data.side,
        qty: data.qty,
        filledQty: 0,
        avgFillPrice: null,
        type: data.type,
        limitPrice: data.limitPrice,
        triggerPrice: data.triggerPrice,
        refPrice: data.refPrice,
        purpose: data.purpose,
        strategyVersionId: data.strategyVersionId,
        state: data.state,
        rejectReason: data.rejectReason,
        submittedAt: data.submittedAt,
        updatedAt: this.clock(),
      };
      this.orders.push(o);
      return copy(o);
    },
    update: async (userId: string, id: string, expect: { state: OrderState; filledQty: number }, data: OrderUpdate) => {
      const o = this.orders.find((x) => x.id === id && x.userId === userId && x.state === expect.state && x.filledQty === expect.filledQty);
      if (!o) return null;
      if (data.state !== undefined) o.state = data.state;
      if (data.filledQty !== undefined) o.filledQty = data.filledQty;
      if (data.avgFillPrice !== undefined) o.avgFillPrice = data.avgFillPrice === null ? null : data.avgFillPrice.toNumber();
      if (data.rejectReason !== undefined) o.rejectReason = data.rejectReason;
      if (data.qty !== undefined) o.qty = data.qty;
      if (data.limitPrice !== undefined) o.limitPrice = data.limitPrice;
      if (data.triggerPrice !== undefined) o.triggerPrice = data.triggerPrice;
      o.updatedAt = this.clock();
      return copy(o);
    },
  } as unknown as CoreOrderRepository;

  readonly fillRepo = {
    listForOrders: async (userId: string, orderIds: readonly string[]) => this.fills.filter((f) => f.userId === userId && orderIds.includes(f.orderId)),
    listForUser: async (userId: string) => this.fills.filter((f) => f.userId === userId),
    create: async (data: NewFillRow) => {
      const f: FillRow = { ...data, id: this.nextId('fil'), createdAt: this.clock() };
      this.fills.push(f);
      return f;
    },
  } as unknown as CoreFillRepository;

  private entry(r: NewLedgerRow): LedgerEntry {
    return {
      id: this.nextId('led'),
      userId: r.userId,
      type: r.type,
      amount: r.amount,
      orderId: r.orderId ?? null,
      fillId: r.fillId ?? null,
      token: r.token ?? null,
      interestDate: r.interestDate ?? null,
      note: r.note,
      createdAt: this.clock(),
    };
  }

  readonly ledgerRepo = {
    listForUser: async (userId: string) => this.ledger.filter((r) => r.userId === userId),
    append: async (rows: readonly NewLedgerRow[]) => {
      for (const r of rows) this.ledger.push(this.entry(r));
    },
    appendInterest: async (rows: readonly NewLedgerRow[]) => {
      let n = 0;
      for (const r of rows) {
        const dup = this.ledger.some((x) => x.userId === r.userId && x.token === (r.token ?? null) && x.interestDate === (r.interestDate ?? null));
        if (dup) continue;
        this.ledger.push(this.entry(r));
        n += 1;
      }
      return n;
    },
    lastInterestDate: async (userId: string, token: string) => {
      const days = this.ledger.filter((r) => r.userId === userId && r.token === token && r.type === 'MTF_INTEREST').map((r) => r.interestDate as string);
      return days.length ? days.sort()[days.length - 1] : null;
    },
  } as unknown as CoreCashLedgerRepository;
}

/** A settings service answering the fixture settings, or "incomplete" for null. */
export function fakeDefaults(settings: PaperSettings | null = paperSettings()): CorePaperDefaultsService {
  return {
    settings: async () => (settings ? { ok: true as const, settings } : { ok: false as const, missing: ['startingCapital@ALL'] }),
  } as unknown as CorePaperDefaultsService;
}
```

- [ ] **Step 2: Write the failing test**

Create `apps/api/src/modules/trade-core/execution/paper-ledger.service.spec.ts`:

```typescript
import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PaperLedgerService, type PlaceContext } from './paper-ledger.service';
import type { PaperSettings } from './paper-settings';
import { fakeDefaults, MemoryPaperStore } from './testing/memory-paper-store';
import { cashBuy, mtfBuy, NOW, optionBuy, paperSettings } from './testing/paper-fixtures';

const OPEN: PlaceContext = { sessionOpen: true, killSwitchActive: false };

function setup(settings: PaperSettings | null = paperSettings()) {
  const store = new MemoryPaperStore(() => NOW);
  const svc = new PaperLedgerService(store.tx, store.orderRepo, store.fillRepo, store.ledgerRepo, fakeDefaults(settings));
  return { store, svc };
}

const shown = (store: MemoryPaperStore) => store.ledger.map((r) => [r.type, r.amount.toFixed(2), r.orderId !== null, r.fillId !== null]);
const total = (store: MemoryPaperStore, userId = 'user_A') =>
  store.ledger.filter((r) => r.userId === userId).reduce((a, r) => a.plus(r.amount), new Prisma.Decimal(0)).toFixed(2);

describe('PaperLedgerService.place', () => {
  it('the first order deposits the starting capital and blocks its margin, in one user transaction', async () => {
    const { store, svc } = setup();
    const r = await svc.place(cashBuy(), OPEN, NOW);
    expect(r.created).toBe(true);
    expect(r.settings).not.toBeNull();
    expect(r.order).toMatchObject({ userId: 'user_A', state: 'OPEN', qty: 100, filledQty: 0, rejectReason: null, submittedAt: NOW });
    expect(shown(store)).toEqual([
      ['DEPOSIT', '1000000.00', false, false],
      ['MARGIN_BLOCK', '-10000.00', true, false],
    ]);
    expect(store.txUsers).toEqual(['user_A']);
  });

  it('the same idempotency key twice returns the same order and writes nothing more', async () => {
    const { store, svc } = setup();
    const a = await svc.place(cashBuy(), OPEN, NOW);
    const b = await svc.place(cashBuy(), OPEN, NOW);
    expect(b).toEqual({ order: a.order, created: false, settings: null });
    expect(store.orders).toHaveLength(1);
    expect(store.ledger).toHaveLength(2);
  });

  it('a key that another request inserts between the read and the write returns that order', async () => {
    const { store, svc } = setup();
    const first = await svc.place(cashBuy(), OPEN, NOW);
    jest.spyOn(store.orderRepo, 'findByKey').mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    const raced = await svc.place(cashBuy(), OPEN, NOW);
    expect(raced).toEqual({ order: first.order, created: false, settings: null });
    expect(store.orders).toHaveLength(1);
    expect(store.ledger).toHaveLength(2);
  });

  it('a key already used by another user is refused, never returned', async () => {
    const { store, svc } = setup();
    await svc.place(cashBuy(), OPEN, NOW);
    await expect(svc.place(cashBuy({ userId: 'user_B' }), OPEN, NOW)).rejects.toBeInstanceOf(ConflictException);
    expect(store.orders.filter((o) => o.userId === 'user_B')).toEqual([]);
  });

  it('insufficient free cash rejects the order and blocks nothing', async () => {
    const { store, svc } = setup(paperSettings({ startingCapital: new Prisma.Decimal('1000') }));
    const r = await svc.place(cashBuy(), OPEN, NOW);
    expect(r.order.state).toBe('REJECTED');
    expect(r.order.rejectReason).toBe('insufficient free cash: the order blocks ₹10000.00, ₹1000.00 is free');
    expect(shown(store)).toEqual([['DEPOSIT', '1000.00', false, false]]);
  });

  it('an incomplete settings table rejects every order and deposits nothing', async () => {
    const { store, svc } = setup(null);
    const r = await svc.place(cashBuy(), OPEN, NOW);
    expect(r).toMatchObject({ created: true, settings: null, order: { state: 'REJECTED', rejectReason: 'paper settings are incomplete: startingCapital@ALL' } });
    expect(store.ledger).toEqual([]);
  });

  it('out of session, or an entry while the kill switch is on, is rejected; the kill switch never gates an exit', async () => {
    const { svc } = setup();
    expect((await svc.place(cashBuy({ idempotencyKey: 'k1' }), { sessionOpen: false, killSwitchActive: false }, NOW)).order.rejectReason).toBe('NSE is not in session');
    expect((await svc.place(cashBuy({ idempotencyKey: 'k2' }), { sessionOpen: true, killSwitchActive: true }, NOW)).order.rejectReason).toBe('the kill switch is on: no new entries');
    const exit = await svc.place(cashBuy({ idempotencyKey: 'k3', purpose: 'EXIT', side: 'SELL' }), { sessionOpen: true, killSwitchActive: true }, NOW);
    expect(exit.order.rejectReason).toBe('no open position to exit');
  });

  it('a business rejection is kept with its reason, and the key keeps answering with it', async () => {
    const { store, svc } = setup();
    const r = await svc.place(mtfBuy({ side: 'SELL' }), OPEN, NOW);
    expect(r.order).toMatchObject({ state: 'REJECTED', rejectReason: 'MTF opens only with BUY', side: 'SELL' });
    expect((await svc.place(mtfBuy({ side: 'SELL' }), OPEN, NOW)).order.id).toBe(r.order.id);
    expect(shown(store)).toEqual([['DEPOSIT', '1000000.00', false, false]]);
  });
});

describe('PaperLedgerService.close', () => {
  it('a cancel releases exactly the pending margin; cancelling again changes nothing', async () => {
    const { store, svc } = setup();
    const { order } = await svc.place(cashBuy(), OPEN, NOW);
    const c = await svc.close('user_A', order.id, 'CANCEL', 'not needed');
    expect(c.state).toBe('CANCELLED');
    expect(shown(store).slice(2)).toEqual([['MARGIN_RELEASE', '10000.00', true, false]]);
    expect(total(store)).toBe('1000000.00');
    expect(await svc.close('user_A', order.id, 'CANCEL', 'again')).toEqual(c);
    expect(store.ledger).toHaveLength(3);
  });

  it('a reject keeps its reason', async () => {
    const { svc } = setup();
    const { order } = await svc.place(cashBuy(), OPEN, NOW);
    const r = await svc.close('user_A', order.id, 'REJECT', 'no fresh price after submission (waited 30000 ms)');
    expect(r).toMatchObject({ state: 'REJECTED', rejectReason: 'no fresh price after submission (waited 30000 ms)' });
  });

  it("another user's order id is 404", async () => {
    const { svc } = setup();
    const { order } = await svc.place(cashBuy(), OPEN, NOW);
    await expect(svc.close('user_B', order.id, 'CANCEL', 'mine now')).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.getOrder('user_B', order.id)).rejects.toBeInstanceOf(NotFoundException);
    expect(await svc.findOrder('user_B', order.id)).toBeNull();
  });
});

describe('PaperLedgerService reads', () => {
  it('funds: cash, blocked margin, free cash and margin per vehicle', async () => {
    const { svc } = setup();
    await svc.place(cashBuy(), OPEN, NOW);
    await svc.place(optionBuy(), OPEN, NOW);
    expect(await svc.funds('user_A')).toEqual({
      userId: 'user_A',
      deposited: '1000000.00',
      realisedPnl: '0.00',
      charges: '0.00',
      mtfInterest: '0.00',
      cash: '1000000.00',
      blockedMargin: '25000.00',
      freeCash: '975000.00',
      deployedByVehicle: { CASH_INTRADAY: '10000.00', MTF: '0.00', OPTIONS_BUY: '15000.00' },
    });
  });

  it("dayStats counts today's accepted entries and today's net P&L", async () => {
    const { svc } = setup();
    await svc.place(cashBuy(), OPEN, NOW);
    await svc.place(optionBuy(), OPEN, NOW);
    await svc.place(mtfBuy({ side: 'SELL' }), OPEN, NOW);
    const d = await svc.dayStats('user_A', NOW);
    expect(d.entriesToday).toBe(2);
    expect(d.netPnlToday.toFixed(2)).toBe('0.00');
  });

  it("openOrders is every user's open orders; openOrdersForUser is one user's", async () => {
    const { svc } = setup();
    await svc.place(cashBuy(), OPEN, NOW);
    await svc.place(cashBuy({ userId: 'user_B', idempotencyKey: 'intent_b:entry' }), OPEN, NOW);
    expect((await svc.openOrders()).map((o) => o.userId)).toEqual(['user_A', 'user_B']);
    expect((await svc.openOrdersForUser('user_B')).map((o) => o.userId)).toEqual(['user_B']);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx jest src/modules/trade-core/execution/paper-ledger.service.spec.ts`
Expected: FAIL with `Cannot find module './paper-ledger.service'`.

- [ ] **Step 4: Write `paper-ledger.service.ts`**

```typescript
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { VEHICLES, type Vehicle } from '../strategies/blocks/block-types';
import type { CoreFunds, CoreOrder, CoreOrderRequest, OrderSide } from './execution.types';
import { validateOrder } from './fill-model';
import { applyPositionFill, balances, FLAT, istDate, money, ZERO, type PositionState } from './ledger-math';
import { marginFor, marginRefPrice } from './margin';
import { isOpenState, nextState, transition } from './order-state';
import type { PaperSettings, PaperSettingsResult } from './paper-settings';
import { CoreCashLedgerRepository, type LedgerEntry, type NewLedgerRow } from './repositories/core-cash-ledger.repository';
import { CoreFillRepository, type FillRow } from './repositories/core-fill.repository';
import { CoreOrderRepository, type PaperDb } from './repositories/core-order.repository';
import { CorePaperTx } from './repositories/core-paper-tx';
import { CorePaperDefaultsService } from './services/core-paper-defaults.service';

type Dec = Prisma.Decimal;

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const MARGIN_TYPES: ReadonlySet<string> = new Set(['MARGIN_BLOCK', 'MARGIN_RELEASE']);

export interface PlaceContext {
  /** CORE_SESSION_CLOCK.isOpen(exchange, now) at placement. */
  sessionOpen: boolean;
  /** The user's core kill switch (an unreadable switch is passed as true). */
  killSwitchActive: boolean;
}

export interface PlaceResult {
  order: CoreOrder;
  /** False when the idempotency key already had an order (returned as is). */
  created: boolean;
  /** The settings the order was checked with; null when it was not checked. */
  settings: PaperSettings | null;
}

/** One (vehicle, token) of one user, before the write being prepared. */
export interface PositionContext {
  orders: CoreOrder[];
  fills: FillRow[];
  state: PositionState;
  pendingExitQty: number;
  /** Margin the position holds: its margin rows that carry a fillId (plan ruling 4). */
  blocked: Dec;
}

/** −Σ of the margin rows `pick` selects: what they hold blocked. */
export function heldMargin(rows: readonly LedgerEntry[], pick: (r: LedgerEntry) => boolean): Dec {
  return rows.filter((r) => MARGIN_TYPES.has(r.type) && pick(r)).reduce((a, r) => a.minus(r.amount), ZERO);
}

/** What an order's unfilled qty holds: its margin rows with no fillId. */
export function pendingMargin(rows: readonly LedgerEntry[], orderId: string): Dec {
  return heldMargin(rows, (r) => r.orderId === orderId && r.fillId === null);
}

export const positionKey = (o: Pick<CoreOrder, 'vehicle' | 'instrument'>): string => `${o.vehicle}:${o.instrument.token}`;

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/**
 * Every write and read of core orders, fills and the cash ledger (spec §4.4–§4.5, §5).
 * Each write is one transaction under the user's paper lock, so the order row, its fill
 * and its ledger rows commit together. Margin is kept in two kinds of rows (plan ruling
 * 4): rows without a fillId hold an order's unfilled qty, rows with a fillId hold the
 * position. Every query names the user.
 */
@Injectable()
export class PaperLedgerService {
  constructor(
    private readonly tx: CorePaperTx,
    private readonly orders: CoreOrderRepository,
    private readonly fills: CoreFillRepository,
    private readonly ledger: CoreCashLedgerRepository,
    private readonly defaults: CorePaperDefaultsService,
  ) {}

  /**
   * Idempotent on the key. A business rejection is persisted as REJECTED with its reason;
   * an accepted ENTRY blocks margin for its qty at its reference price. The user's first
   * order also deposits the starting capital.
   */
  async place(req: CoreOrderRequest, ctx: PlaceContext, now: Date = new Date()): Promise<PlaceResult> {
    const prior = await this.orders.findByKey(req.idempotencyKey);
    if (prior) return { order: this.sameUser(prior, req.userId), created: false, settings: null };
    let loaded: PaperSettingsResult;
    try {
      loaded = await this.defaults.settings(now.getTime());
    } catch (err) {
      loaded = { ok: false, missing: [`unreadable (${errorText(err)})`] };
    }
    try {
      return await this.tx.run(req.userId, async (db) => {
        const again = await this.orders.findByKey(req.idempotencyKey, db);
        if (again) return { order: this.sameUser(again, req.userId), created: false, settings: null };
        const settings = loaded.ok ? loaded.settings : null;
        const rows = await this.ledger.listForUser(req.userId, db);
        const deposit: NewLedgerRow[] =
          rows.length === 0 && settings
            ? [{ userId: req.userId, type: 'DEPOSIT', amount: money(settings.startingCapital), note: 'starting paper capital (core_paper_defaults startingCapital)' }]
            : [];

        let reason: string | null = null;
        let block = ZERO;
        if (!settings) reason = `paper settings are incomplete: ${loaded.ok ? '' : loaded.missing.join(', ')}`;
        else if (!ctx.sessionOpen) reason = `${req.instrument.exchange.toUpperCase()} is not in session`;
        else if (req.purpose === 'ENTRY' && ctx.killSwitchActive) reason = 'the kill switch is on: no new entries';
        else {
          const pos = await this.positionContext(req.userId, req.vehicle, req.instrument.token, rows, db);
          reason = validateOrder(req, { settings, position: { netQty: pos.state.netQty }, pendingExitQty: pos.pendingExitQty });
          if (!reason && req.purpose === 'ENTRY') {
            block = marginFor(req.vehicle, marginRefPrice(req).mul(req.qty), settings);
            const free = balances([...rows, ...deposit.map((d) => ({ type: d.type, amount: d.amount }))]).freeCash;
            if (free.lt(block)) reason = `insufficient free cash: the order blocks ₹${block.toFixed(2)}, ₹${free.toFixed(2)} is free`;
          }
        }

        const order = await this.orders.create(
          {
            userId: req.userId,
            idempotencyKey: req.idempotencyKey,
            vehicle: req.vehicle,
            exchange: req.instrument.exchange.toUpperCase(),
            token: req.instrument.token,
            symbol: req.instrument.symbol,
            lotSize: req.instrument.lotSize,
            underlying: req.instrument.underlying ? req.instrument.underlying.trim().toUpperCase() : null,
            side: req.side,
            qty: req.qty,
            type: req.type,
            limitPrice: req.limitPrice,
            triggerPrice: req.triggerPrice,
            refPrice: req.refPrice,
            purpose: req.purpose,
            strategyVersionId: req.strategyVersionId,
            state: transition('NEW', reason ? 'REJECT' : 'ACCEPT'),
            rejectReason: reason,
            submittedAt: now,
          },
          db,
        );
        const entries = [...deposit];
        if (!reason && block.gt(0)) {
          entries.push({
            userId: req.userId,
            type: 'MARGIN_BLOCK',
            amount: ZERO.minus(block),
            orderId: order.id,
            token: order.instrument.token,
            note: `margin for ${req.side} ${req.qty} ${req.instrument.symbol} at ₹${marginRefPrice(req).toFixed(2)}`,
          });
        }
        await this.ledger.append(entries, db);
        return { order, created: true, settings };
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const raced = await this.orders.findByKey(req.idempotencyKey);
      if (!raced) throw err;
      return { order: this.sameUser(raced, req.userId), created: false, settings: null };
    }
  }

  /**
   * CANCEL or REJECT an open order and release its pending margin exactly (spec §4.4).
   * An order already closed is returned unchanged; a PARTIAL order is never rejected
   * for want of a price (it had one), so REJECT on PARTIAL also returns it unchanged.
   */
  async close(userId: string, orderId: string, event: 'CANCEL' | 'REJECT', reason: string): Promise<CoreOrder> {
    return this.tx.run(userId, async (db) => {
      const order = await this.orders.findForUser(userId, orderId, db);
      if (!order) throw new NotFoundException(`core order ${orderId} not found`);
      const state = nextState(order.state, event);
      if (!state) return order;
      const updated = await this.orders.update(
        userId,
        orderId,
        { state: order.state, filledQty: order.filledQty },
        { state, rejectReason: event === 'REJECT' ? reason : null },
        db,
      );
      if (!updated) throw new ConflictException(`core order ${orderId} changed while closing; retry`);
      if (order.purpose === 'ENTRY') {
        const release = pendingMargin(await this.ledger.listForUser(userId, db), orderId);
        if (release.gt(0)) {
          await this.ledger.append(
            [
              {
                userId,
                type: 'MARGIN_RELEASE',
                amount: release,
                orderId,
                token: order.instrument.token,
                note: `${event === 'CANCEL' ? 'cancelled' : 'rejected'}: margin for the ${order.qty - order.filledQty} unfilled units (${reason})`,
              },
            ],
            db,
          );
        }
      }
      return updated;
    });
  }

  async getOrder(userId: string, orderId: string): Promise<CoreOrder> {
    const o = await this.orders.findForUser(userId, orderId);
    if (!o) throw new NotFoundException(`core order ${orderId} not found`);
    return o;
  }

  findOrder(userId: string, orderId: string): Promise<CoreOrder | null> {
    return this.orders.findForUser(userId, orderId);
  }

  /** System scan for the matcher's boot reload. */
  openOrders(): Promise<CoreOrder[]> {
    return this.orders.listOpenAll();
  }

  openOrdersForUser(userId: string): Promise<CoreOrder[]> {
    return this.orders.listOpenForUser(userId);
  }

  async funds(userId: string): Promise<CoreFunds> {
    const [rows, orders] = await Promise.all([this.ledger.listForUser(userId), this.orders.listForUser(userId)]);
    const b = balances(rows);
    const vehicleOf = new Map(orders.map((o) => [o.id, o.vehicle]));
    const deployedByVehicle = Object.fromEntries(
      VEHICLES.map((v) => [v, heldMargin(rows, (r) => r.orderId !== null && vehicleOf.get(r.orderId) === v).toFixed(2)]),
    ) as Record<Vehicle, string>;
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

  /** Today's (IST) net realised P&L (realised − charges − interest) and accepted entries, for the Risk Wall. */
  async dayStats(userId: string, now: Date): Promise<{ netPnlToday: Dec; entriesToday: number }> {
    const day = istDate(now);
    const [rows, orders] = await Promise.all([this.ledger.listForUser(userId), this.orders.listForUser(userId)]);
    const netPnlToday = rows
      .filter((r) => (r.type === 'REALISED_PNL' || r.type === 'CHARGES' || r.type === 'MTF_INTEREST') && istDate(r.createdAt) === day)
      .reduce((a, r) => a.plus(r.amount), ZERO);
    const entriesToday = orders.filter((o) => o.purpose === 'ENTRY' && o.state !== 'REJECTED' && istDate(o.submittedAt) === day).length;
    return { netPnlToday, entriesToday };
  }

  /** The position on (vehicle, token) from its fills, and the margin it holds, from `rows`. */
  async positionContext(userId: string, vehicle: Vehicle, token: string, rows: readonly LedgerEntry[], db?: PaperDb): Promise<PositionContext> {
    const orders = await this.orders.listForPosition(userId, vehicle, token, db);
    const sideOf = new Map<string, OrderSide>(orders.map((o) => [o.id, o.side]));
    const fills = await this.fills.listForOrders(userId, orders.map((o) => o.id), db);
    const state = fills.reduce(
      (s, f) => applyPositionFill(s, { side: sideOf.get(f.orderId) as OrderSide, qty: f.qty, price: f.price, at: f.priceAt }).state,
      FLAT,
    );
    const pendingExitQty = orders.filter((o) => o.purpose === 'EXIT' && isOpenState(o.state)).reduce((n, o) => n + o.qty - o.filledQty, 0);
    const ids = new Set(orders.map((o) => o.id));
    const blocked = heldMargin(rows, (r) => r.orderId !== null && ids.has(r.orderId) && r.fillId !== null);
    return { orders, fills, state, pendingExitQty, blocked };
  }

  private sameUser(o: CoreOrder, userId: string): CoreOrder {
    if (o.userId !== userId) throw new ConflictException('this idempotency key is already used by another order');
    return o;
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx jest src/modules/trade-core/execution/paper-ledger.service.spec.ts`
Expected: PASS (14 tests).

- [ ] **Step 6: Commit**

```bash
git add -- apps/api/src/modules/trade-core/execution/paper-ledger.service.ts apps/api/src/modules/trade-core/execution/paper-ledger.service.spec.ts apps/api/src/modules/trade-core/execution/testing/memory-paper-store.ts
git commit -m "feat(trade-core): paper ledger service — idempotent placement with margin and deposit, close, funds" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/api/src/modules/trade-core/execution/paper-ledger.service.ts apps/api/src/modules/trade-core/execution/paper-ledger.service.spec.ts apps/api/src/modules/trade-core/execution/testing/memory-paper-store.ts
```

---

### Task 9: `PaperLedgerService` part 2 — fills (charges, margin true-up, realised P&L), modify, positions

**Files:**
- Modify: `apps/api/src/modules/trade-core/execution/paper-ledger.service.ts`
- Test: `apps/api/src/modules/trade-core/execution/paper-ledger.fills.spec.ts`

**Interfaces:**
- Consumes: `chargesForLeg`, `Segment` (Task 1), `proportionalRelease` (Task 3), `FillCharges`, `CoreOrderPatch`,
  `CorePositionView` (Task 2), everything Task 8 produced.
- Produces (added to `paper-ledger.service.ts`):

```typescript
export const SEGMENT_BY_VEHICLE: Readonly<Record<Vehicle, Segment>>;   // EQ_INTRADAY | EQ_DELIVERY | OPT
export function fillCharges(order: Pick<CoreOrder, 'vehicle' | 'side' | 'filledQty'>, qty: number, price: Prisma.Decimal, settings: Pick<PaperSettings, 'mtfPledgeFee'>): FillCharges;
export interface FillInput { qty: number; price: Prisma.Decimal; priceAt: Date }
// PaperLedgerService
applyFill(userId: string, orderId: string, expectFilledQty: number, fill: FillInput, now?: Date): Promise<CoreOrder | null>;  // null: lost race, closed, or no settings
modify(userId: string, orderId: string, patch: CoreOrderPatch, now?: Date): Promise<CoreOrder>;   // 404 / 409 / 422
positions(userId: string): Promise<CorePositionView[]>;
```

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/modules/trade-core/execution/paper-ledger.fills.spec.ts`:

```typescript
import { ConflictException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { chargesForLeg } from '../../trade-sentinel/charges';
import { money } from './ledger-math';
import { fillCharges, heldMargin, PaperLedgerService, pendingMargin, type PlaceContext } from './paper-ledger.service';
import type { PaperSettings } from './paper-settings';
import { fakeDefaults, MemoryPaperStore } from './testing/memory-paper-store';
import { cashBuy, mtfBuy, NOW, optionBuy, paperSettings } from './testing/paper-fixtures';

const D = (s: string) => new Prisma.Decimal(s);
const OPEN: PlaceContext = { sessionOpen: true, killSwitchActive: false };
const AT = new Date(NOW.getTime() + 10);

function setup(settings: PaperSettings | null = paperSettings()) {
  const store = new MemoryPaperStore(() => NOW);
  const svc = new PaperLedgerService(store.tx, store.orderRepo, store.fillRepo, store.ledgerRepo, fakeDefaults(settings));
  return { store, svc };
}

const rowsAfter = (store: MemoryPaperStore, n: number) => store.ledger.slice(n).map((r) => [r.type, r.amount.toFixed(2), r.fillId !== null]);
const total = (store: MemoryPaperStore) => store.ledger.reduce((a, r) => a.plus(r.amount), D('0')).toFixed(2);
const legTotal = (segment: 'EQ_INTRADAY' | 'EQ_DELIVERY' | 'OPT', leg: 'BUY' | 'SELL', price: number, qty: number) =>
  money(chargesForLeg({ segment, leg, price, qty }).total);

describe('PaperLedgerService.applyFill', () => {
  it('an entry fill posts its charges, frees the pending margin for its qty and blocks margin at the fill price', async () => {
    const { store, svc } = setup();
    const { order } = await svc.place(cashBuy(), OPEN, NOW);
    const out = await svc.applyFill('user_A', order.id, 0, { qty: 100, price: D('500.7'), priceAt: AT });
    expect(out).toMatchObject({ state: 'FILLED', filledQty: 100, avgFillPrice: 500.7 });
    expect(store.fills).toHaveLength(1);
    expect(store.fills[0].chargesTotal.toFixed(2)).toBe('26.92');
    expect(store.fills[0].charges).toMatchObject({ segment: 'EQ_INTRADAY', leg: 'BUY', pledgeFee: 0 });
    expect(rowsAfter(store, 2)).toEqual([
      ['CHARGES', '-26.92', true],
      ['MARGIN_RELEASE', '10000.00', false],
      ['MARGIN_BLOCK', '-10014.00', true],
    ]);
  });

  it('a partial fill, then a cancel, releases exactly the unfilled part', async () => {
    const { store, svc } = setup();
    const { order } = await svc.place(cashBuy(), OPEN, NOW);
    const p = await svc.applyFill('user_A', order.id, 0, { qty: 40, price: D('500'), priceAt: AT });
    expect(p).toMatchObject({ state: 'PARTIAL', filledQty: 40 });
    expect(rowsAfter(store, 3)).toEqual([
      ['MARGIN_RELEASE', '4000.00', false],
      ['MARGIN_BLOCK', '-4000.00', true],
    ]);
    await svc.close('user_A', order.id, 'CANCEL', 'rest not needed');
    expect(rowsAfter(store, 5)).toEqual([['MARGIN_RELEASE', '6000.00', false]]);
    expect(pendingMargin(store.ledger, order.id).toFixed(2)).toBe('0.00');
    expect(heldMargin(store.ledger, (r) => r.orderId === order.id).toFixed(2)).toBe('4000.00');
  });

  it('an exit books gross realised P&L and its own charges, releases margin in proportion, and all of it on the last fill', async () => {
    const { store, svc } = setup();
    const entry = (await svc.place(cashBuy(), OPEN, NOW)).order;
    await svc.applyFill('user_A', entry.id, 0, { qty: 100, price: D('500.7'), priceAt: AT });
    const exit = (await svc.place(cashBuy({ idempotencyKey: 'intent_cash_1:exit', purpose: 'EXIT', side: 'SELL', refPrice: 505 }), OPEN, NOW)).order;
    expect(exit.state).toBe('OPEN');
    const before = store.ledger.length;
    await svc.applyFill('user_A', exit.id, 0, { qty: 60, price: D('505'), priceAt: AT });
    expect(rowsAfter(store, before)).toEqual([
      ['CHARGES', legTotal('EQ_INTRADAY', 'SELL', 505, 60).neg().toFixed(2), true],
      ['REALISED_PNL', '258.00', true],
      ['MARGIN_RELEASE', '6008.40', true],
    ]);
    await svc.applyFill('user_A', exit.id, 60, { qty: 40, price: D('506'), priceAt: AT });
    expect(store.ledger.slice(-2).map((r) => [r.type, r.amount.toFixed(2)])).toEqual([
      ['REALISED_PNL', '212.00'],
      ['MARGIN_RELEASE', '4005.60'],
    ]);
    const charges = legTotal('EQ_INTRADAY', 'BUY', 500.7, 100).plus(legTotal('EQ_INTRADAY', 'SELL', 505, 60)).plus(legTotal('EQ_INTRADAY', 'SELL', 506, 40));
    const funds = await svc.funds('user_A');
    expect(funds.blockedMargin).toBe('0.00');
    expect(funds.freeCash).toBe(D('1000000').plus(258).plus(212).minus(charges).toFixed(2));
    expect(funds.freeCash).toBe(total(store));
  });

  it('MTF: delivery charges, the pledge fee once per buy order, the own share blocked', async () => {
    const { store, svc } = setup();
    const { order } = await svc.place(mtfBuy(), OPEN, NOW);
    expect(store.ledger[1].amount.toFixed(2)).toBe('-5000.00');
    await svc.applyFill('user_A', order.id, 0, { qty: 4, price: D('1000.5'), priceAt: AT });
    await svc.applyFill('user_A', order.id, 4, { qty: 6, price: D('1000.5'), priceAt: AT });
    expect(store.fills.map((f) => [f.charges.segment, f.charges.pledgeFee])).toEqual([['EQ_DELIVERY', 23.6], ['EQ_DELIVERY', 0]]);
    expect(store.fills[0].chargesTotal.toFixed(2)).toBe(money(chargesForLeg({ segment: 'EQ_DELIVERY', leg: 'BUY', price: 1000.5, qty: 4 }).total + 23.6).toFixed(2));
    expect(store.ledger.filter((r) => r.type.startsWith('MARGIN')).map((r) => r.amount.toFixed(2))).toEqual(['-5000.00', '2000.00', '-2001.00', '3000.00', '-3001.50']);
  });

  it('options: the full premium is blocked and the option schedule applies', async () => {
    const { store, svc } = setup();
    const { order } = await svc.place(optionBuy(), OPEN, NOW);
    await svc.applyFill('user_A', order.id, 0, { qty: 150, price: D('100'), priceAt: AT });
    expect(store.fills[0].charges).toMatchObject({ segment: 'OPT', leg: 'BUY', brokerage: 20 });
    expect(store.ledger.filter((r) => r.type.startsWith('MARGIN')).map((r) => r.amount.toFixed(2))).toEqual(['-15000.00', '15000.00', '-15000.00']);
  });

  it('a stale expectation (another writer filled first) writes nothing and returns null', async () => {
    const { store, svc } = setup();
    const { order } = await svc.place(cashBuy(), OPEN, NOW);
    expect(await svc.applyFill('user_A', order.id, 10, { qty: 100, price: D('500'), priceAt: AT })).toBeNull();
    expect(store.fills).toEqual([]);
    expect(store.ledger).toHaveLength(2);
  });

  it('no settings, no fill', async () => {
    const { store, svc } = setup();
    const { order } = await svc.place(cashBuy(), OPEN, NOW);
    const blind = new PaperLedgerService(store.tx, store.orderRepo, store.fillRepo, store.ledgerRepo, fakeDefaults(null));
    expect(await blind.applyFill('user_A', order.id, 0, { qty: 100, price: D('500'), priceAt: AT })).toBeNull();
    expect(store.fills).toEqual([]);
  });
});

describe('PaperLedgerService.modify', () => {
  it('more qty blocks more margin, less releases it; an unfunded increase or a closed order is refused', async () => {
    const { store, svc } = setup();
    const { order } = await svc.place(cashBuy(), OPEN, NOW);
    expect((await svc.modify('user_A', order.id, { qty: 150 })).qty).toBe(150);
    expect(rowsAfter(store, 2)).toEqual([['MARGIN_BLOCK', '-5000.00', false]]);
    await svc.modify('user_A', order.id, { qty: 50 });
    expect(rowsAfter(store, 3)).toEqual([['MARGIN_RELEASE', '10000.00', false]]);
    await expect(svc.modify('user_A', order.id, { qty: 100000 })).rejects.toThrow('insufficient free cash');
    await svc.close('user_A', order.id, 'CANCEL', 'done');
    await expect(svc.modify('user_A', order.id, { qty: 60 })).rejects.toBeInstanceOf(ConflictException);
  });

  it('a new limit re-blocks at the new limit; a wrong field or a bad qty is 422', async () => {
    const { store, svc } = setup();
    const { order } = await svc.place(optionBuy(), OPEN, NOW);
    expect((await svc.modify('user_A', order.id, { limitPrice: 90 })).limitPrice).toBe(90);
    expect(rowsAfter(store, 2)).toEqual([['MARGIN_RELEASE', '1500.00', false]]);
    await expect(svc.modify('user_A', order.id, { triggerPrice: 80 })).rejects.toThrow('only an SL_MARKET order has a trigger price');
    await expect(svc.modify('user_A', order.id, { qty: 100 })).rejects.toThrow('qty must be a whole multiple of the lot size 75');
    await expect(svc.modify('user_A', order.id, { qty: 900 })).rejects.toThrow('12 lots exceed the 10-lot limit per order for NIFTY');
    await expect(svc.modify('user_A', order.id, {})).rejects.toBeInstanceOf(UnprocessableEntityException);
  });
});

describe('PaperLedgerService.positions and fillCharges', () => {
  it('one view per non-flat (vehicle, token), with average, realised P&L and the margin it holds', async () => {
    const { svc } = setup();
    const entry = (await svc.place(cashBuy(), OPEN, NOW)).order;
    await svc.applyFill('user_A', entry.id, 0, { qty: 100, price: D('500.7'), priceAt: AT });
    const exit = (await svc.place(cashBuy({ idempotencyKey: 'x1', purpose: 'EXIT', side: 'SELL', refPrice: 505 }), OPEN, NOW)).order;
    await svc.applyFill('user_A', exit.id, 0, { qty: 60, price: D('505'), priceAt: AT });
    expect(await svc.positions('user_A')).toEqual([
      {
        key: 'CASH_INTRADAY:2885',
        vehicle: 'CASH_INTRADAY',
        instrument: { exchange: 'NSE', token: '2885', symbol: 'RELIANCE-EQ', lotSize: 1, underlying: null },
        netQty: 40,
        direction: 'LONG',
        avgPrice: '500.7000',
        realisedPnl: '258.00',
        blockedMargin: '4005.60',
        openedAt: AT,
      },
    ]);
    await svc.applyFill('user_A', exit.id, 60, { qty: 40, price: D('506'), priceAt: AT });
    expect(await svc.positions('user_A')).toEqual([]);
    expect(await svc.positions('user_B')).toEqual([]);
  });

  it('fillCharges prices one leg by vehicle and adds the pledge fee only to the first MTF buy fill', () => {
    const s = paperSettings();
    expect(fillCharges({ vehicle: 'CASH_INTRADAY', side: 'SELL', filledQty: 0 }, 60, D('505'), s)).toMatchObject({ segment: 'EQ_INTRADAY', leg: 'SELL', pledgeFee: 0 });
    expect(fillCharges({ vehicle: 'MTF', side: 'BUY', filledQty: 0 }, 4, D('1000.5'), s).pledgeFee).toBe(23.6);
    expect(fillCharges({ vehicle: 'MTF', side: 'BUY', filledQty: 4 }, 6, D('1000.5'), s).pledgeFee).toBe(0);
    expect(fillCharges({ vehicle: 'MTF', side: 'SELL', filledQty: 0 }, 10, D('1010'), s)).toMatchObject({ segment: 'EQ_DELIVERY', leg: 'SELL', pledgeFee: 0 });
    expect(fillCharges({ vehicle: 'OPTIONS_BUY', side: 'BUY', filledQty: 0 }, 75, D('100'), s).segment).toBe('OPT');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest src/modules/trade-core/execution/paper-ledger.fills.spec.ts`
Expected: FAIL with TS2305 `Module './paper-ledger.service' has no exported member 'fillCharges'`.

- [ ] **Step 3: Extend `paper-ledger.service.ts`**

Replace the import block at the top of `apps/api/src/modules/trade-core/execution/paper-ledger.service.ts` (every line
from `import { ConflictException` through `import { CorePaperDefaultsService } …;`) with:

```typescript
import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { chargesForLeg, type Segment } from '../../trade-sentinel/charges';
import { VEHICLES, type Vehicle } from '../strategies/blocks/block-types';
import type { CoreFunds, CoreOrder, CoreOrderPatch, CoreOrderRequest, CorePositionView, FillCharges, OrderSide } from './execution.types';
import { validateOrder } from './fill-model';
import { applyPositionFill, balances, FLAT, istDate, money, ZERO, type PositionState } from './ledger-math';
import { marginFor, marginRefPrice, proportionalRelease } from './margin';
import { isOpenState, nextState, transition } from './order-state';
import type { PaperSettings, PaperSettingsResult } from './paper-settings';
import { CoreCashLedgerRepository, type LedgerEntry, type NewLedgerRow } from './repositories/core-cash-ledger.repository';
import { CoreFillRepository, type FillRow } from './repositories/core-fill.repository';
import { CoreOrderRepository, type PaperDb } from './repositories/core-order.repository';
import { CorePaperTx } from './repositories/core-paper-tx';
import { CorePaperDefaultsService } from './services/core-paper-defaults.service';
```

Add after `export const positionKey = …;`:

```typescript
/** The charges schedule per vehicle (spec §4.4): MTF is delivery plus the pledge fee. */
export const SEGMENT_BY_VEHICLE: Readonly<Record<Vehicle, Segment>> = {
  CASH_INTRADAY: 'EQ_INTRADAY',
  MTF: 'EQ_DELIVERY',
  OPTIONS_BUY: 'OPT',
};

/**
 * One fill's charges: the fill priced as one executed leg (plan ruling 5), plus the MTF
 * pledge fee on the first buy fill of an MTF order. `total` includes the fee.
 */
export function fillCharges(
  order: Pick<CoreOrder, 'vehicle' | 'side' | 'filledQty'>,
  qty: number,
  price: Dec,
  settings: Pick<PaperSettings, 'mtfPledgeFee'>,
): FillCharges {
  const segment = SEGMENT_BY_VEHICLE[order.vehicle];
  const leg = chargesForLeg({ segment, leg: order.side, price: price.toNumber(), qty });
  const pledgeFee = order.vehicle === 'MTF' && order.side === 'BUY' && order.filledQty === 0 ? settings.mtfPledgeFee.toNumber() : 0;
  return { ...leg, segment, leg: order.side, pledgeFee, total: leg.total + pledgeFee };
}

export interface FillInput {
  qty: number;
  price: Dec;
  /** The market time of the price the fill came from. */
  priceAt: Date;
}
```

Add these methods inside the class, after `close(…)`:

```typescript
  /**
   * One fill (spec §4.4), guarded by the filledQty the caller decided on: null when the
   * order moved on (another fill, a cancel), is gone, or the settings are unavailable —
   * nothing is written then. The order update comes first, then the fill, then the rows:
   * CHARGES; for an ENTRY the pending margin for this qty is released and margin at the
   * fill price is blocked against the position; for an EXIT the gross realised P&L is
   * booked and the position's margin released in proportion (all of it on the last fill).
   */
  async applyFill(userId: string, orderId: string, expectFilledQty: number, fill: FillInput, now: Date = new Date()): Promise<CoreOrder | null> {
    const loaded = await this.defaults.settings(now.getTime());
    if (!loaded.ok) return null;
    const settings = loaded.settings;
    return this.tx.run(userId, async (db) => {
      const order = await this.orders.findForUser(userId, orderId, db);
      if (!order || !isOpenState(order.state) || order.filledQty !== expectFilledQty) return null;
      const remaining = order.qty - order.filledQty;
      if (!Number.isSafeInteger(fill.qty) || fill.qty <= 0 || fill.qty > remaining || fill.qty % order.instrument.lotSize !== 0) {
        throw new Error(`fill of ${fill.qty} does not fit order ${orderId} (${remaining} left, lot ${order.instrument.lotSize})`);
      }
      const rows = await this.ledger.listForUser(userId, db);
      const pos = order.purpose === 'EXIT' ? await this.positionContext(userId, order.vehicle, order.instrument.token, rows, db) : null;

      const newFilled = order.filledQty + fill.qty;
      const avg = order.avgFillPrice === null ? fill.price : new Prisma.Decimal(order.avgFillPrice).mul(order.filledQty).plus(fill.price.mul(fill.qty)).div(newFilled);
      const updated = await this.orders.update(
        userId,
        orderId,
        { state: order.state, filledQty: order.filledQty },
        { state: transition(order.state, newFilled === order.qty ? 'FILL' : 'PARTIAL_FILL'), filledQty: newFilled, avgFillPrice: avg.toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP) },
        db,
      );
      if (!updated) return null;

      const charges = fillCharges(order, fill.qty, fill.price, settings);
      const created = await this.fills.create(
        { orderId, userId, price: fill.price, qty: fill.qty, charges, chargesTotal: money(charges.total), priceAt: fill.priceAt },
        db,
      );
      const base = { userId, orderId, token: order.instrument.token };
      const what = `${order.side} ${fill.qty} ${order.instrument.symbol} at ₹${fill.price.toFixed(2)}`;
      const entries: NewLedgerRow[] = [];
      if (created.chargesTotal.gt(0)) entries.push({ ...base, type: 'CHARGES', amount: ZERO.minus(created.chargesTotal), fillId: created.id, note: `charges on ${what}` });
      if (order.purpose === 'ENTRY') {
        const freed = proportionalRelease(pendingMargin(rows, orderId), fill.qty, remaining);
        if (freed.gt(0)) entries.push({ ...base, type: 'MARGIN_RELEASE', amount: freed, note: `pending margin for the ${fill.qty} filled units` });
        const block = marginFor(order.vehicle, fill.price.mul(fill.qty), settings);
        if (block.gt(0)) entries.push({ ...base, type: 'MARGIN_BLOCK', amount: ZERO.minus(block), fillId: created.id, note: `margin at the fill price for ${what}` });
      } else {
        const position = pos as PositionContext;
        const { realised } = applyPositionFill(position.state, { side: order.side, qty: fill.qty, price: fill.price, at: fill.priceAt });
        entries.push({ ...base, type: 'REALISED_PNL', amount: realised ?? ZERO, fillId: created.id, note: `realised on ${what}` });
        const release = proportionalRelease(position.blocked, fill.qty, Math.abs(position.state.netQty));
        if (release.gt(0)) entries.push({ ...base, type: 'MARGIN_RELEASE', amount: release, fillId: created.id, note: `margin released in proportion to ${what}` });
      }
      await this.ledger.append(entries, db);
      return updated;
    });
  }

  /** Change qty, limit or trigger of an open order; its pending margin follows (blocked more only if funded). */
  async modify(userId: string, orderId: string, patch: CoreOrderPatch, now: Date = new Date()): Promise<CoreOrder> {
    const loaded = await this.defaults.settings(now.getTime());
    if (!loaded.ok) throw new UnprocessableEntityException(`paper settings are incomplete: ${loaded.missing.join(', ')}`);
    const settings = loaded.settings;
    return this.tx.run(userId, async (db) => {
      const order = await this.orders.findForUser(userId, orderId, db);
      if (!order) throw new NotFoundException(`core order ${orderId} not found`);
      if (!isOpenState(order.state)) throw new ConflictException(`core order ${orderId} is ${order.state}; it cannot be modified`);
      const next = {
        ...order,
        qty: patch.qty ?? order.qty,
        limitPrice: patch.limitPrice ?? order.limitPrice,
        triggerPrice: patch.triggerPrice ?? order.triggerPrice,
      };
      const rows = await this.ledger.listForUser(userId, db);
      const problem = await this.modifyProblem(order, patch, settings, rows, db);
      if (problem) throw new UnprocessableEntityException(problem);

      const entries: NewLedgerRow[] = [];
      if (order.purpose === 'ENTRY') {
        const target = marginFor(order.vehicle, marginRefPrice(next).mul(next.qty - next.filledQty), settings);
        const delta = target.minus(pendingMargin(rows, orderId));
        const base = { userId, orderId, token: order.instrument.token };
        if (delta.gt(0)) {
          const free = balances(rows).freeCash;
          if (free.lt(delta)) throw new UnprocessableEntityException(`insufficient free cash: the change blocks ₹${delta.toFixed(2)} more, ₹${free.toFixed(2)} is free`);
          entries.push({ ...base, type: 'MARGIN_BLOCK', amount: ZERO.minus(delta), note: 'margin for the modified order' });
        } else if (delta.lt(0)) {
          entries.push({ ...base, type: 'MARGIN_RELEASE', amount: ZERO.minus(delta), note: 'margin freed by the modified order' });
        }
      }
      const updated = await this.orders.update(
        userId,
        orderId,
        { state: order.state, filledQty: order.filledQty },
        { qty: next.qty, limitPrice: next.limitPrice, triggerPrice: next.triggerPrice },
        db,
      );
      if (!updated) throw new ConflictException(`core order ${orderId} changed while modifying; retry`);
      await this.ledger.append(entries, db);
      return updated;
    });
  }

  /** Every non-flat position of the user, from fills; margin from the ledger. */
  async positions(userId: string): Promise<CorePositionView[]> {
    const [orders, fills, rows] = await Promise.all([this.orders.listForUser(userId), this.fills.listForUser(userId), this.ledger.listForUser(userId)]);
    const byId = new Map(orders.map((o) => [o.id, o]));
    const groups = new Map<string, { latest: CoreOrder; ids: Set<string>; state: PositionState }>();
    for (const o of orders) {
      const key = positionKey(o);
      const g = groups.get(key) ?? { latest: o, ids: new Set<string>(), state: FLAT };
      g.latest = o;
      g.ids.add(o.id);
      groups.set(key, g);
    }
    for (const f of fills) {
      const o = byId.get(f.orderId);
      if (!o) continue;
      const g = groups.get(positionKey(o));
      if (!g) continue;
      g.state = applyPositionFill(g.state, { side: o.side, qty: f.qty, price: f.price, at: f.priceAt }).state;
    }
    const out: CorePositionView[] = [];
    for (const [key, g] of groups) {
      if (g.state.netQty === 0 || !g.state.avgPrice || !g.state.openedAt) continue;
      out.push({
        key,
        vehicle: g.latest.vehicle,
        instrument: g.latest.instrument,
        netQty: g.state.netQty,
        direction: g.state.netQty > 0 ? 'LONG' : 'SHORT',
        avgPrice: g.state.avgPrice.toFixed(4),
        realisedPnl: g.state.realised.toFixed(2),
        blockedMargin: heldMargin(rows, (r) => r.orderId !== null && g.ids.has(r.orderId) && r.fillId !== null).toFixed(2),
        openedAt: g.state.openedAt,
      });
    }
    return out;
  }

  private async modifyProblem(order: CoreOrder, patch: CoreOrderPatch, settings: PaperSettings, rows: readonly LedgerEntry[], db: PaperDb): Promise<string | null> {
    if (patch.qty === undefined && patch.limitPrice === undefined && patch.triggerPrice === undefined) return 'nothing to modify';
    if (patch.limitPrice !== undefined && order.type !== 'LIMIT') return 'only a LIMIT order has a limit price';
    if (patch.triggerPrice !== undefined && order.type !== 'SL_MARKET') return 'only an SL_MARKET order has a trigger price';
    for (const [name, v] of [['limitPrice', patch.limitPrice], ['triggerPrice', patch.triggerPrice]] as const) {
      if (v !== undefined && (!Number.isFinite(v) || v <= 0 || new Prisma.Decimal(v).decimalPlaces() > 2)) return `${name} must be a price above 0 with at most 2 decimals`;
    }
    if (patch.qty === undefined) return null;
    const lot = order.instrument.lotSize;
    if (!Number.isSafeInteger(patch.qty) || patch.qty % lot !== 0) return `qty must be a whole multiple of the lot size ${lot}`;
    if (patch.qty <= order.filledQty) return `qty must stay above the ${order.filledQty} units already filled`;
    if (order.vehicle === 'OPTIONS_BUY') {
      const underlying = order.instrument.underlying ?? '';
      const max = settings.maxLotsPerOrder[underlying];
      if (max === undefined) return `no maxLotsPerOrder setting for ${underlying}`;
      if (patch.qty / lot > max) return `${patch.qty / lot} lots exceed the ${max}-lot limit per order for ${underlying}`;
    }
    if (order.purpose === 'EXIT') {
      const pos = await this.positionContext(order.userId, order.vehicle, order.instrument.token, rows, db);
      const others = pos.pendingExitQty - (order.qty - order.filledQty);
      if (patch.qty - order.filledQty > Math.abs(pos.state.netQty) - others) return 'the exit would exceed the open position';
    }
    return null;
  }
```

- [ ] **Step 4: Run both ledger specs**

Run: `npx jest src/modules/trade-core/execution/paper-ledger.fills.spec.ts src/modules/trade-core/execution/paper-ledger.service.spec.ts`
Expected: PASS (11 + 14 tests).

- [ ] **Step 5: Commit**

```bash
git add -- apps/api/src/modules/trade-core/execution/paper-ledger.service.ts apps/api/src/modules/trade-core/execution/paper-ledger.fills.spec.ts
git commit -m "feat(trade-core): paper fills post charges, margin true-up and realised P&L; modify; positions" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/api/src/modules/trade-core/execution/paper-ledger.service.ts apps/api/src/modules/trade-core/execution/paper-ledger.fills.spec.ts
```

---

### Task 10: `PaperMatcherService` — event-driven, in-memory matching (approach A)

**Files:**
- Create: `apps/api/src/modules/trade-core/execution/paper-matcher.service.ts`
- Create: `apps/api/src/modules/trade-core/execution/testing/fake-hub.ts`
- Test: `apps/api/src/modules/trade-core/execution/paper-matcher.service.spec.ts`

**Interfaces:**
- Consumes: `HubPrices`, `HubPriceSource`, `lookupHubPrices` (`market-hub/hub-prices.ts:21-58`; `onPrice` and
  `watch(refs, priority, owner)` at `:29-33`), `refKey`, `isHubExchange`, `Price`, `Priority`
  (`market-hub/hub.types.ts`), `SessionClock.isOpen` (`market-hub/session-clock.ts:101`), `CORE_SESSION_CLOCK`
  (`risk-wall/ports.ts:11`), `decideFill`, `priceProblem`, `noPriceDeadline`, `PRICE_MAX_AGE_MS` (Task 4),
  `PaperLedgerService.applyFill` / `close` / `findOrder` / `openOrders` (Tasks 8–9), `CorePaperDefaultsService.settings`
  (Task 7).
- Produces:

```typescript
export const MATCHER_SWEEP_MS = 1_000;
export const coreOrderOwner: (orderId: string) => string;   // `core-order:${orderId}`
class PaperMatcherService implements OnModuleInit, OnModuleDestroy {
  track(order: CoreOrder, noPriceRejectMs: number, now?: number): void;
  refresh(order: CoreOrder): void;
  untrack(orderId: string): void;
  onPrice(hub: HubPrices, p: Price, now?: number): Promise<void>;
  sweep(now?: number): Promise<void>;
  reload(now?: number): Promise<void>;
  openCount(): number;
  isTracked(orderId: string): boolean;
}
// testing/fake-hub.ts
export class FakeHub implements HubPrices { watches; unwatches; setFresh(p: Price): void; push(p: Price): void; listenerCount(): number }
export function fakeHubSource(hubs: Readonly<Record<string, HubPrices>>): HubPriceSource;
export function fakeModuleRef(source: HubPriceSource | null): { get: () => HubPriceSource };
```

Rules (spec §4.6): open orders live in memory keyed by `EXCHANGE:token`; placing one watches its ref at priority 0
through `hubFor(userId, 'positions')` with owner `core-order:<id>`; a push evaluates that ref's orders priced by
the same hub; a 1 s sweep evaluates orders from `hub.price(ref, { maxAgeMs: 15_000 })` and rejects orders that saw
no usable price by their deadline; every change is written by `PaperLedgerService` (DB first) before memory changes;
on boot the first sweep reloads every open order and re-watches it; a missing hub leaves the order open until its
deadline ("no fresh price"). A per-order `busy` flag stops a push and the sweep evaluating the same order at once
inside one process; the guarded update in `applyFill` stops it across processes and restarts.

- [ ] **Step 1: Write the fake hub**

Create `apps/api/src/modules/trade-core/execution/testing/fake-hub.ts`:

```typescript
import type { HubPriceSource, HubPrices } from '../../../market-hub/hub-prices';
import { refKey, type InstrumentRef, type Price, type PriceResult, type Priority } from '../../../market-hub/hub.types';

/** A HubPrices for matcher tests: records watches, answers price() from setFresh, delivers push() to onPrice listeners. */
export class FakeHub implements HubPrices {
  readonly watches: Array<{ key: string; priority: Priority; owner: string }> = [];
  readonly unwatches: Array<{ key: string; owner: string }> = [];
  private readonly listeners = new Set<(p: Price) => void>();
  private readonly book = new Map<string, PriceResult>();

  price(ref: InstrumentRef, _opts: { maxAgeMs: number }): PriceResult {
    return this.book.get(refKey(ref)) ?? { kind: 'unavailable', reason: 'never-priced' };
  }

  prices(refs: readonly InstrumentRef[], opts: { maxAgeMs: number }): Map<string, PriceResult> {
    return new Map(refs.map((r) => [refKey(r), this.price(r, opts)] as const));
  }

  async watch(refs: readonly InstrumentRef[], priority: Priority, owner: string): Promise<void> {
    for (const r of refs) this.watches.push({ key: refKey(r), priority, owner });
  }

  async unwatch(refs: readonly InstrumentRef[], owner: string): Promise<void> {
    for (const r of refs) this.unwatches.push({ key: refKey(r), owner });
  }

  onPrice(fn: (p: Price) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  listenerCount(): number {
    return this.listeners.size;
  }

  /** What price() answers from now on (the sweep's view). */
  setFresh(p: Price): void {
    this.book.set(refKey(p.ref), { kind: 'fresh', price: p });
  }

  /** A push, as the hub's onPrice delivers it. */
  push(p: Price): void {
    for (const fn of [...this.listeners]) fn(p);
  }
}

/** hubFor answers the listed users only (today the real hub serves only the owner). */
export function fakeHubSource(hubs: Readonly<Record<string, HubPrices>>): HubPriceSource {
  return { hubFor: (userId) => (userId !== null && hubs[userId]) || null, record: () => undefined };
}

/** What lookupHubPrices(moduleRef) reads: ModuleRef.get(HUB_PRICE_SOURCE, { strict: false }). */
export function fakeModuleRef(source: HubPriceSource | null): { get: () => HubPriceSource } {
  return {
    get: () => {
      if (!source) throw new Error('no market hub in this container');
      return source;
    },
  };
}
```

- [ ] **Step 2: Write the failing test**

Create `apps/api/src/modules/trade-core/execution/paper-matcher.service.spec.ts`:

```typescript
import type { ModuleRef } from '@nestjs/core';
import type { CoreOrderRequest } from './execution.types';
import { PaperLedgerService, type PlaceContext } from './paper-ledger.service';
import { coreOrderOwner, PaperMatcherService } from './paper-matcher.service';
import type { CorePaperDefaultsService } from './services/core-paper-defaults.service';
import { FakeHub, fakeHubSource, fakeModuleRef } from './testing/fake-hub';
import { fakeDefaults, MemoryPaperStore } from './testing/memory-paper-store';
import { cashBuy, depth, hubPrice, NOW } from './testing/paper-fixtures';

const OPEN: PlaceContext = { sessionOpen: true, killSwitchActive: false };
const SUB = NOW.getTime();

function setup(opts: { open?: boolean } = {}) {
  const store = new MemoryPaperStore(() => NOW);
  const defaults = fakeDefaults();
  const ledger = new PaperLedgerService(store.tx, store.orderRepo, store.fillRepo, store.ledgerRepo, defaults);
  const hub = new FakeHub();
  const clock = { isOpen: jest.fn(() => opts.open ?? true) };
  const matcherWith = (h: FakeHub, d: CorePaperDefaultsService = defaults) =>
    new PaperMatcherService(ledger, d, fakeModuleRef(fakeHubSource({ user_A: h })) as unknown as ModuleRef, clock);
  const matcher = matcherWith(hub);
  const place = async (req: CoreOrderRequest = cashBuy(), at: Date = NOW) => {
    const r = await ledger.place(req, OPEN, at);
    matcher.track(r.order, 30_000, at.getTime());
    return r.order;
  };
  const stateOf = (id: string) => store.orders.find((o) => o.id === id);
  return { store, ledger, hub, clock, matcher, matcherWith, place, stateOf };
}

describe('PaperMatcherService', () => {
  it('tracks an open order: watches its ref at priority 0 as core-order:<id>, one price subscription per hub', async () => {
    const { hub, matcher, place } = setup();
    const a = await place();
    const b = await place(cashBuy({ idempotencyKey: 'k2' }));
    expect(hub.watches).toEqual([
      { key: 'NSE:2885', priority: 0, owner: coreOrderOwner(a.id) },
      { key: 'NSE:2885', priority: 0, owner: coreOrderOwner(b.id) },
    ]);
    expect(coreOrderOwner(a.id)).toBe(`core-order:${a.id}`);
    expect(hub.listenerCount()).toBe(1);
    expect(matcher.openCount()).toBe(2);
  });

  it('a push stamped at the submission instant does not fill; the next one does', async () => {
    const { hub, matcher, place, stateOf } = setup();
    const o = await place();
    await matcher.onPrice(hub, hubPrice(cashBuy(), 500, SUB, depth([[500, 100]])), SUB + 5);
    expect(stateOf(o.id)?.state).toBe('OPEN');
    await matcher.onPrice(hub, hubPrice(cashBuy(), 500, SUB + 1, depth([[500, 100]])), SUB + 6);
    expect(stateOf(o.id)).toMatchObject({ state: 'FILLED', filledQty: 100, avgFillPrice: 500 });
    expect(matcher.isTracked(o.id)).toBe(false);
    expect(hub.unwatches).toEqual([{ key: 'NSE:2885', owner: coreOrderOwner(o.id) }]);
  });

  it('a push delivered through the hub listener fills (the event-driven path)', async () => {
    const { hub, place, stateOf } = setup();
    const o = await place(cashBuy(), new Date(Date.now() - 1_000));
    hub.push(hubPrice(cashBuy(), 500, Date.now(), depth([[500, 100]])));
    await new Promise((resolve) => setImmediate(resolve));
    expect(stateOf(o.id)?.state).toBe('FILLED');
  });

  it("the sweep fills from the hub's book when no push came", async () => {
    const { hub, matcher, place, stateOf } = setup();
    const o = await place();
    hub.setFresh(hubPrice(cashBuy(), 500, SUB + 1, depth([[500, 100]])));
    await matcher.sweep(SUB + 10);
    expect(stateOf(o.id)?.state).toBe('FILLED');
  });

  it('a partial fill stays tracked and the next price fills the rest', async () => {
    const { store, hub, matcher, place, stateOf } = setup();
    const o = await place();
    await matcher.onPrice(hub, hubPrice(cashBuy(), 500, SUB + 1, depth([[500, 40]])), SUB + 2);
    expect(stateOf(o.id)).toMatchObject({ state: 'PARTIAL', filledQty: 40 });
    expect(matcher.isTracked(o.id)).toBe(true);
    await matcher.onPrice(hub, hubPrice(cashBuy(), 501, SUB + 3, depth([[501, 100]])), SUB + 4);
    expect(stateOf(o.id)).toMatchObject({ state: 'FILLED', filledQty: 100 });
    expect(store.fills.map((f) => f.qty)).toEqual([40, 60]);
  });

  it('a user the hub does not serve is rejected "no fresh price" at the deadline, and the margin comes back', async () => {
    const { store, matcher, place, stateOf } = setup();
    const o = await place(cashBuy({ userId: 'user_B', idempotencyKey: 'kb' }));
    await matcher.sweep(SUB + 29_999);
    expect(stateOf(o.id)?.state).toBe('OPEN');
    await matcher.sweep(SUB + 30_001);
    expect(stateOf(o.id)).toMatchObject({ state: 'REJECTED', rejectReason: 'no fresh price after submission (waited 30000 ms)' });
    expect(store.ledger.filter((r) => r.userId === 'user_B').reduce((a, r) => a + r.amount.toNumber(), 0)).toBe(1_000_000);
    expect(matcher.openCount()).toBe(0);
  });

  it('a stale price never fills; the order is rejected at the deadline', async () => {
    const { hub, matcher, place, stateOf } = setup();
    const o = await place();
    hub.setFresh(hubPrice(cashBuy(), 500, SUB + 1, depth([[500, 100]])));
    await matcher.sweep(SUB + 1 + 15_001);
    expect(stateOf(o.id)?.state).toBe('OPEN');
    await matcher.sweep(SUB + 30_001);
    expect(stateOf(o.id)?.state).toBe('REJECTED');
  });

  it('out of session nothing fills, even on a fresh push', async () => {
    const { hub, matcher, place, stateOf } = setup({ open: false });
    const o = await place();
    await matcher.onPrice(hub, hubPrice(cashBuy(), 500, SUB + 1, depth([[500, 100]])), SUB + 2);
    expect(stateOf(o.id)?.state).toBe('OPEN');
  });

  it('a push and a sweep at once fill once', async () => {
    const { store, hub, matcher, place, stateOf } = setup();
    const o = await place();
    const p = hubPrice(cashBuy(), 500, SUB + 1, depth([[500, 100]]));
    hub.setFresh(p);
    await Promise.all([matcher.onPrice(hub, p, SUB + 2), matcher.sweep(SUB + 2), matcher.onPrice(hub, p, SUB + 2)]);
    expect(store.fills).toHaveLength(1);
    expect(stateOf(o.id)?.state).toBe('FILLED');
  });

  it('a recreated matcher reloads open orders, re-watches them and fills only what is left', async () => {
    const { store, hub, matcher, matcherWith, place, stateOf } = setup();
    const o = await place();
    await matcher.onPrice(hub, hubPrice(cashBuy(), 500, SUB + 1, depth([[500, 40]])), SUB + 2);
    expect(stateOf(o.id)?.state).toBe('PARTIAL');

    const hub2 = new FakeHub();
    const restarted = matcherWith(hub2);
    await restarted.sweep(SUB + 3);
    expect(restarted.isTracked(o.id)).toBe(true);
    expect(hub2.watches).toEqual([{ key: 'NSE:2885', priority: 0, owner: coreOrderOwner(o.id) }]);
    hub2.setFresh(hubPrice(cashBuy(), 502, SUB + 4, depth([[502, 500]])));
    await restarted.sweep(SUB + 5);
    expect(stateOf(o.id)).toMatchObject({ state: 'FILLED', filledQty: 100 });

    // The old instance still holds the PARTIAL copy (filledQty 40): its fill is refused by the guard.
    await matcher.onPrice(hub, hubPrice(cashBuy(), 503, SUB + 6, depth([[503, 500]])), SUB + 7);
    expect(store.fills.map((f) => f.qty)).toEqual([40, 60]);
    expect(matcher.isTracked(o.id)).toBe(false);
  });

  it('the boot reload waits for the settings and never tracks without them', async () => {
    const { ledger, hub, matcherWith } = setup();
    await ledger.place(cashBuy(), OPEN, NOW);
    const blind = matcherWith(hub, fakeDefaults(null));
    await blind.sweep(SUB + 1);
    expect(blind.openCount()).toBe(0);
    const seeing = matcherWith(hub);
    await seeing.sweep(SUB + 1);
    expect(seeing.openCount()).toBe(1);
  });

  it('module destroy stops the sweep and unsubscribes from every hub', async () => {
    const { hub, matcher, place } = setup();
    matcher.onModuleInit();
    await place();
    expect(hub.listenerCount()).toBe(1);
    matcher.onModuleDestroy();
    expect(hub.listenerCount()).toBe(0);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx jest src/modules/trade-core/execution/paper-matcher.service.spec.ts`
Expected: FAIL with `Cannot find module './paper-matcher.service'`.

- [ ] **Step 4: Write `paper-matcher.service.ts`**

```typescript
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { lookupHubPrices, type HubPriceSource, type HubPrices } from '../../market-hub/hub-prices';
import { isHubExchange, refKey, type InstrumentRef, type Price } from '../../market-hub/hub.types';
import type { SessionClock } from '../../market-hub/session-clock';
import { CORE_SESSION_CLOCK } from '../risk-wall/ports';
import type { CoreOrder } from './execution.types';
import { decideFill, noPriceDeadline, priceProblem, PRICE_MAX_AGE_MS, type FillPrice } from './fill-model';
import { isOpenState } from './order-state';
import { PaperLedgerService } from './paper-ledger.service';
import { CorePaperDefaultsService } from './services/core-paper-defaults.service';

/** Spec §4.6: the sweep's period. */
export const MATCHER_SWEEP_MS = 1_000;

/** The hub watch owner of one core order (spec §4.6). */
export const coreOrderOwner = (orderId: string): string => `core-order:${orderId}`;

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

interface Tracked {
  order: CoreOrder;
  ref: InstrumentRef | null;
  key: string;
  hub: HubPrices | null;
  deadline: number;
  noPriceRejectMs: number;
  /** It has seen a usable price (fresh, after submission, in session): never rejected for want of one. */
  priced: boolean;
  /** An evaluation or a reject is in flight for it in this process. */
  busy: boolean;
}

/**
 * Approach A (E5, spec §4.6): open core orders in memory, keyed by EXCHANGE:token, and
 * evaluated on every hub price push for their ref and on a 1 s sweep. The DB is the
 * source of truth: every state change is written by PaperLedgerService first, and the
 * first sweep after boot reloads every open order. Fail closed: a missing hub, a closed
 * session, a stale price or missing settings never fills; an order that sees no usable
 * price by its deadline is rejected "no fresh price".
 */
@Injectable()
export class PaperMatcherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PaperMatcherService.name);
  private readonly tracked = new Map<string, Tracked>();
  private readonly byKey = new Map<string, Set<string>>();
  private readonly subscriptions = new Map<HubPrices, () => void>();
  private hubSourceRef: HubPriceSource | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private loaded = false;
  private sweeping = false;

  constructor(
    private readonly ledger: PaperLedgerService,
    private readonly defaults: CorePaperDefaultsService,
    private readonly moduleRef: ModuleRef,
    @Inject(CORE_SESSION_CLOCK) private readonly clock: Pick<SessionClock, 'isOpen'>,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.sweep(), MATCHER_SWEEP_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const unsubscribe of this.subscriptions.values()) unsubscribe();
    this.subscriptions.clear();
  }

  openCount(): number {
    return this.tracked.size;
  }

  isTracked(orderId: string): boolean {
    return this.tracked.has(orderId);
  }

  /** Start matching an open order (after placement, or on reload). Idempotent. */
  track(order: CoreOrder, noPriceRejectMs: number, now: number = Date.now()): void {
    if (!isOpenState(order.state) || this.tracked.has(order.id)) return;
    const exchange = order.instrument.exchange.toUpperCase();
    const ref: InstrumentRef | null = isHubExchange(exchange) ? { exchange, token: order.instrument.token, symbol: order.instrument.symbol } : null;
    const key = ref ? refKey(ref) : `${exchange}:${order.instrument.token}`;
    const t: Tracked = {
      order,
      ref,
      key,
      hub: null,
      deadline: noPriceDeadline(order.submittedAt.getTime(), now, noPriceRejectMs),
      noPriceRejectMs,
      priced: false,
      busy: false,
    };
    this.tracked.set(order.id, t);
    const ids = this.byKey.get(key) ?? new Set<string>();
    ids.add(order.id);
    this.byKey.set(key, ids);
    this.attachHub(t);
  }

  /** Replace the in-memory copy after a modify (the DB already holds it). */
  refresh(order: CoreOrder): void {
    const t = this.tracked.get(order.id);
    if (!t) return;
    if (!isOpenState(order.state)) this.untrack(order.id);
    else t.order = order;
  }

  untrack(orderId: string): void {
    const t = this.tracked.get(orderId);
    if (!t) return;
    this.tracked.delete(orderId);
    const ids = this.byKey.get(t.key);
    ids?.delete(orderId);
    if (ids && ids.size === 0) this.byKey.delete(t.key);
    if (t.hub && t.ref) void t.hub.unwatch([t.ref], coreOrderOwner(orderId));
  }

  /** A hub push: evaluate this ref's orders that this hub prices. Never throws into the hub. */
  onPrice(hub: HubPrices, p: Price, now: number = Date.now()): Promise<void> {
    const ids = this.byKey.get(refKey(p.ref));
    if (!ids) return Promise.resolve();
    const runs: Array<Promise<void>> = [];
    for (const id of [...ids]) {
      const t = this.tracked.get(id);
      if (t && t.hub === hub) runs.push(this.evaluate(t, p, now));
    }
    return Promise.all(runs).then(() => undefined);
  }

  /** Every second: reload once after boot, reject expired unpriced orders, evaluate the rest from the hub's book. */
  async sweep(now: number = Date.now()): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      if (!this.loaded) await this.reload(now);
      for (const t of [...this.tracked.values()]) {
        if (!this.tracked.has(t.order.id) || t.busy) continue;
        if (!t.priced && now > t.deadline) {
          await this.rejectNoPrice(t);
          continue;
        }
        this.attachHub(t);
        if (!t.hub || !t.ref) continue;
        const r = t.hub.price(t.ref, { maxAgeMs: PRICE_MAX_AGE_MS });
        if (r.kind === 'fresh') await this.evaluate(t, r.price, now);
      }
    } catch (err) {
      this.logger.error(`paper matcher sweep failed: ${errorText(err)}`);
    } finally {
      this.sweeping = false;
    }
  }

  /** Boot: every open order from the DB, re-watched. Without settings nothing is loaded (retried next sweep). */
  async reload(now: number = Date.now()): Promise<void> {
    const loaded = await this.defaults.settings(now);
    if (!loaded.ok) {
      this.logger.error(`paper settings are incomplete (${loaded.missing.join(', ')}); open core orders are not matched`);
      return;
    }
    const open = await this.ledger.openOrders();
    for (const o of open) this.track(o, loaded.settings.noPriceRejectMs, now);
    this.loaded = true;
    if (open.length > 0) this.logger.log(`reloaded ${open.length} open core order(s)`);
  }

  private hubSource(): HubPriceSource | null {
    if (!this.hubSourceRef) this.hubSourceRef = lookupHubPrices(this.moduleRef);
    return this.hubSourceRef;
  }

  /** Watch the order's ref at P0 on the user's hub and subscribe to that hub's pushes (once per hub). */
  private attachHub(t: Tracked): void {
    if (t.hub || !t.ref) return;
    const hub = this.hubSource()?.hubFor(t.order.userId, 'positions') ?? null;
    if (!hub) return;
    t.hub = hub;
    if (!this.subscriptions.has(hub)) this.subscriptions.set(hub, hub.onPrice((p) => void this.onPrice(hub, p)));
    void hub.watch([t.ref], 0, coreOrderOwner(t.order.id));
  }

  private async evaluate(t: Tracked, p: FillPrice, now: number): Promise<void> {
    if (t.busy) return;
    t.busy = true;
    try {
      if (!this.tracked.has(t.order.id)) return;
      if (priceProblem(p, t.order.submittedAt.getTime(), now) !== null) return;
      if (!this.clock.isOpen(t.order.instrument.exchange, new Date(now))) return;
      t.priced = true;
      const loaded = await this.defaults.settings(now);
      if (!loaded.ok) return;
      const decision = decideFill(t.order, p, now, loaded.settings.slippageBps[t.order.vehicle]);
      if (decision.kind !== 'FILL') return;
      const updated = await this.ledger.applyFill(
        t.order.userId,
        t.order.id,
        t.order.filledQty,
        { qty: decision.qty, price: decision.price, priceAt: new Date(p.at) },
        new Date(now),
      );
      const current = updated ?? (await this.ledger.findOrder(t.order.userId, t.order.id));
      if (!current || !isOpenState(current.state)) this.untrack(t.order.id);
      else t.order = current;
    } catch (err) {
      this.logger.error(`core order ${t.order.id}: evaluation failed: ${errorText(err)}`);
    } finally {
      t.busy = false;
    }
  }

  private async rejectNoPrice(t: Tracked): Promise<void> {
    t.busy = true;
    try {
      const o = await this.ledger.close(t.order.userId, t.order.id, 'REJECT', `no fresh price after submission (waited ${t.noPriceRejectMs} ms)`);
      if (!isOpenState(o.state)) this.untrack(t.order.id);
      else {
        t.order = o;
        t.priced = o.filledQty > 0;
      }
    } catch (err) {
      this.logger.error(`core order ${t.order.id}: no-price reject failed: ${errorText(err)}`);
    } finally {
      t.busy = false;
    }
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx jest src/modules/trade-core/execution/paper-matcher.service.spec.ts`
Expected: PASS (12 tests).

- [ ] **Step 6: Commit**

```bash
git add -- apps/api/src/modules/trade-core/execution/paper-matcher.service.ts apps/api/src/modules/trade-core/execution/paper-matcher.service.spec.ts apps/api/src/modules/trade-core/execution/testing/fake-hub.ts
git commit -m "feat(trade-core): paper matcher — hub P0 watches, push and 1 s sweep matching, no-price rejects, boot reload" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/api/src/modules/trade-core/execution/paper-matcher.service.ts apps/api/src/modules/trade-core/execution/paper-matcher.service.spec.ts apps/api/src/modules/trade-core/execution/testing/fake-hub.ts
```

---

### Task 11: `PaperExecutionAdapter` — the `ExecutionAdapter`, end to end per vehicle

**Files:**
- Create: `apps/api/src/modules/trade-core/execution/paper-execution.adapter.ts`
- Test: `apps/api/src/modules/trade-core/execution/paper-execution.adapter.spec.ts`

**Interfaces:**
- Consumes: `ExecutionAdapter` and types (Task 2), `requestProblems` (Task 4), `PaperLedgerService` (Tasks 8–9),
  `PaperMatcherService` (Task 10), `CoreKillSwitchService.isActive(userId, now)`
  (`risk-wall/services/core-kill-switch.service.ts:75`), `CORE_SESSION_CLOCK`.
- Produces:

```typescript
export const CORE_EXECUTION_ADAPTER: unique symbol;   // the token M4/M5 inject
class PaperExecutionAdapter implements ExecutionAdapter {
  placeOrder(req: CoreOrderRequest): Promise<CoreOrder>;            // 400 on a malformed request
  cancel(userId: string, orderId: string): Promise<CoreOrder>;     // 404 when not the user's
  modify(userId: string, orderId: string, patch: CoreOrderPatch): Promise<CoreOrder>;
  getOrder(userId: string, orderId: string): Promise<CoreOrder>;
  getPositions(userId: string): Promise<CorePositionView[]>;
  getFunds(userId: string): Promise<CoreFunds>;
}
```

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/modules/trade-core/execution/paper-execution.adapter.spec.ts`:

```typescript
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { ModuleRef } from '@nestjs/core';
import { Prisma } from '@prisma/client';
import { chargesForLeg } from '../../trade-sentinel/charges';
import type { CoreKillSwitchService } from '../risk-wall/services/core-kill-switch.service';
import type { CoreOrder, CoreOrderRequest } from './execution.types';
import { money } from './ledger-math';
import { PaperExecutionAdapter } from './paper-execution.adapter';
import { PaperLedgerService } from './paper-ledger.service';
import { coreOrderOwner, PaperMatcherService } from './paper-matcher.service';
import type { PaperSettings } from './paper-settings';
import { FakeHub, fakeHubSource, fakeModuleRef } from './testing/fake-hub';
import { fakeDefaults, MemoryPaperStore } from './testing/memory-paper-store';
import { cashBuy, depth, hubPrice, mtfBuy, optionBuy, paperSettings } from './testing/paper-fixtures';

const D = (s: string) => new Prisma.Decimal(s);

function setup(opts: { settings?: PaperSettings; kill?: boolean | 'throws'; open?: boolean } = {}) {
  const store = new MemoryPaperStore();
  const defaults = fakeDefaults(opts.settings ?? paperSettings());
  const ledger = new PaperLedgerService(store.tx, store.orderRepo, store.fillRepo, store.ledgerRepo, defaults);
  const hub = new FakeHub();
  const clock = { isOpen: () => opts.open ?? true };
  const matcher = new PaperMatcherService(ledger, defaults, fakeModuleRef(fakeHubSource({ user_A: hub, user_B: hub })) as unknown as ModuleRef, clock);
  const killSwitch = {
    isActive: jest.fn(async () => {
      if (opts.kill === 'throws') throw new Error('db down');
      return opts.kill === true;
    }),
  };
  const adapter = new PaperExecutionAdapter(ledger, matcher, killSwitch as unknown as CoreKillSwitchService, clock);
  /** Deliver a price stamped `ms` after the order's submission, evaluated 1 ms later. */
  const push = (o: CoreOrder, req: CoreOrderRequest, ltp: number, book?: ReturnType<typeof depth>, ms = 10) => {
    const at = o.submittedAt.getTime() + ms;
    return matcher.onPrice(hub, hubPrice(req, ltp, at, book), at + 1);
  };
  const sumRows = (userId = 'user_A') => store.ledger.filter((r) => r.userId === userId).reduce((a, r) => a.plus(r.amount), D('0')).toFixed(2);
  return { store, matcher, hub, adapter, killSwitch, push, sumRows };
}

describe('PaperExecutionAdapter, per vehicle (spec §1 done-when)', () => {
  it('cash intraday: place → fill → exit → the ledger reconciles', async () => {
    const { adapter, push, sumRows } = setup();
    const entryReq = cashBuy();
    const entry = await adapter.placeOrder(entryReq);
    expect(entry.state).toBe('OPEN');
    await push(entry, entryReq, 500, depth([[500.5, 60], [501, 100]]));
    expect(await adapter.getOrder('user_A', entry.id)).toMatchObject({ state: 'FILLED', avgFillPrice: 500.7 });
    const exitReq = cashBuy({ idempotencyKey: 'intent_cash_1:exit', purpose: 'EXIT', side: 'SELL', refPrice: 505 });
    const exit = await adapter.placeOrder(exitReq);
    await push(exit, exitReq, 505, depth([], [[505, 200]]));
    expect((await adapter.getOrder('user_A', exit.id)).state).toBe('FILLED');
    expect(await adapter.getPositions('user_A')).toEqual([]);
    expect(await adapter.getFunds('user_A')).toMatchObject({
      realisedPnl: '430.00',
      charges: '64.97',
      blockedMargin: '0.00',
      cash: '1000365.03',
      freeCash: '1000365.03',
    });
    expect(sumRows()).toBe('1000365.03');
  });

  it('MTF: fills at LTP + slippage without depth, pays the pledge fee once, exits with realised P&L', async () => {
    const { adapter, push, sumRows } = setup();
    const req = mtfBuy();
    const entry = await adapter.placeOrder(req);
    await push(entry, req, 1000);
    expect(await adapter.getOrder('user_A', entry.id)).toMatchObject({ state: 'FILLED', avgFillPrice: 1000.5 });
    expect((await adapter.getFunds('user_A')).deployedByVehicle.MTF).toBe('5002.50');
    const exitReq = mtfBuy({ idempotencyKey: 'intent_mtf_1:exit', purpose: 'EXIT', side: 'SELL', refPrice: 1010 });
    const exit = await adapter.placeOrder(exitReq);
    await push(exit, exitReq, 1010, depth([], [[1010, 10]]));
    const buy = money(chargesForLeg({ segment: 'EQ_DELIVERY', leg: 'BUY', price: 1000.5, qty: 10 }).total + 23.6);
    const sell = money(chargesForLeg({ segment: 'EQ_DELIVERY', leg: 'SELL', price: 1010, qty: 10 }).total);
    const funds = await adapter.getFunds('user_A');
    expect(funds).toMatchObject({ realisedPnl: '95.00', blockedMargin: '0.00', charges: buy.plus(sell).toFixed(2) });
    expect(funds.freeCash).toBe(D('1000095').minus(buy).minus(sell).toFixed(2));
    expect(sumRows()).toBe(funds.freeCash);
  });

  it('options: a LIMIT buy fills only on a strict trade-through, at the limit; the exit too', async () => {
    const { adapter, push } = setup();
    const req = optionBuy();
    const entry = await adapter.placeOrder(req);
    await push(entry, req, 100, undefined, 10);
    expect((await adapter.getOrder('user_A', entry.id)).state).toBe('OPEN');
    await push(entry, req, 99.95, undefined, 20);
    expect(await adapter.getOrder('user_A', entry.id)).toMatchObject({ state: 'FILLED', avgFillPrice: 100 });
    expect((await adapter.getFunds('user_A')).deployedByVehicle.OPTIONS_BUY).toBe('15000.00');
    const exitReq = optionBuy({ idempotencyKey: 'intent_opt_1:exit', purpose: 'EXIT', side: 'SELL', limitPrice: 110, refPrice: 110 });
    const exit = await adapter.placeOrder(exitReq);
    await push(exit, exitReq, 110, undefined, 10);
    expect((await adapter.getOrder('user_A', exit.id)).state).toBe('OPEN');
    await push(exit, exitReq, 110.05, undefined, 20);
    expect((await adapter.getOrder('user_A', exit.id)).state).toBe('FILLED');
    expect(await adapter.getFunds('user_A')).toMatchObject({ realisedPnl: '1500.00', blockedMargin: '0.00' });
  });

  it('the same idempotency key twice returns the same order: one order, one margin block', async () => {
    const { store, adapter } = setup();
    const a = await adapter.placeOrder(cashBuy());
    const b = await adapter.placeOrder(cashBuy());
    expect(b.id).toBe(a.id);
    expect(store.orders).toHaveLength(1);
    expect(store.ledger.filter((r) => r.type === 'MARGIN_BLOCK')).toHaveLength(1);
  });

  it('insufficient cash is a REJECTED order with nothing blocked and nothing watched', async () => {
    const { adapter, matcher } = setup({ settings: paperSettings({ startingCapital: D('1000') }) });
    const o = await adapter.placeOrder(optionBuy());
    expect(o).toMatchObject({ state: 'REJECTED', rejectReason: 'insufficient free cash: the order blocks ₹15000.00, ₹1000.00 is free' });
    expect(matcher.isTracked(o.id)).toBe(false);
    expect((await adapter.getFunds('user_A')).blockedMargin).toBe('0.00');
  });

  it('cancel releases the margin and stops watching', async () => {
    const { adapter, matcher, hub } = setup();
    const o = await adapter.placeOrder(optionBuy());
    const c = await adapter.cancel('user_A', o.id);
    expect(c.state).toBe('CANCELLED');
    expect((await adapter.getFunds('user_A')).freeCash).toBe('1000000.00');
    expect(matcher.isTracked(o.id)).toBe(false);
    expect(hub.unwatches).toEqual([{ key: 'NFO:43521', owner: coreOrderOwner(o.id) }]);
  });

  it('partial fill, then cancel: only the filled part stays blocked', async () => {
    const { adapter, push } = setup();
    const req = cashBuy();
    const o = await adapter.placeOrder(req);
    await push(o, req, 500, depth([[500, 40]]));
    const c = await adapter.cancel('user_A', o.id);
    expect(c).toMatchObject({ state: 'CANCELLED', filledQty: 40 });
    expect((await adapter.getFunds('user_A')).blockedMargin).toBe('4000.00');
    expect((await adapter.getPositions('user_A')).map((p) => [p.netQty, p.blockedMargin])).toEqual([[40, '4000.00']]);
  });

  it('the kill switch rejects an entry, an unreadable switch counts as on, and an exit never asks it', async () => {
    const on = setup({ kill: true });
    expect((await on.adapter.placeOrder(cashBuy())).rejectReason).toBe('the kill switch is on: no new entries');
    const unreadable = setup({ kill: 'throws' });
    expect((await unreadable.adapter.placeOrder(cashBuy())).rejectReason).toBe('the kill switch is on: no new entries');
    const exit = await on.adapter.placeOrder(cashBuy({ idempotencyKey: 'x', purpose: 'EXIT', side: 'SELL' }));
    expect(exit.rejectReason).toBe('no open position to exit');
    expect(on.killSwitch.isActive).toHaveBeenCalledTimes(1);
  });

  it('out of session is a REJECTED order', async () => {
    const { adapter } = setup({ open: false });
    expect((await adapter.placeOrder(cashBuy())).rejectReason).toBe('NSE is not in session');
  });

  it('a malformed request is a 400 and writes nothing', async () => {
    const { store, adapter } = setup();
    await expect(adapter.placeOrder(cashBuy({ qty: 0 }))).rejects.toBeInstanceOf(BadRequestException);
    expect(store.orders).toEqual([]);
    expect(store.ledger).toEqual([]);
  });

  it('modify moves the limit the matcher uses', async () => {
    const { adapter, push } = setup();
    const req = optionBuy();
    const o = await adapter.placeOrder(req);
    await adapter.modify('user_A', o.id, { limitPrice: 99 });
    await push(o, req, 99.5, undefined, 10);
    expect((await adapter.getOrder('user_A', o.id)).state).toBe('OPEN');
    await push(o, req, 98.95, undefined, 20);
    expect(await adapter.getOrder('user_A', o.id)).toMatchObject({ state: 'FILLED', avgFillPrice: 99 });
  });

  it("orders, positions and funds are the caller's own", async () => {
    const { adapter, push } = setup();
    const req = cashBuy();
    const o = await adapter.placeOrder(req);
    await push(o, req, 500, depth([[500, 100]]));
    await expect(adapter.getOrder('user_B', o.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(adapter.cancel('user_B', o.id)).rejects.toBeInstanceOf(NotFoundException);
    expect(await adapter.getPositions('user_B')).toEqual([]);
    expect(await adapter.getFunds('user_B')).toMatchObject({ deposited: '0.00', freeCash: '0.00', blockedMargin: '0.00' });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest src/modules/trade-core/execution/paper-execution.adapter.spec.ts`
Expected: FAIL with `Cannot find module './paper-execution.adapter'`.

- [ ] **Step 3: Write `paper-execution.adapter.ts`**

```typescript
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { SessionClock } from '../../market-hub/session-clock';
import { CORE_SESSION_CLOCK } from '../risk-wall/ports';
import { CoreKillSwitchService } from '../risk-wall/services/core-kill-switch.service';
import type { CoreFunds, CoreOrder, CoreOrderPatch, CoreOrderRequest, CorePositionView, ExecutionAdapter } from './execution.types';
import { requestProblems } from './fill-model';
import { isOpenState } from './order-state';
import { PaperLedgerService } from './paper-ledger.service';
import { PaperMatcherService } from './paper-matcher.service';

/** The token M4/M5 inject; SP7 binds a live adapter to it. */
export const CORE_EXECUTION_ADAPTER = Symbol('CORE_EXECUTION_ADAPTER');

/**
 * The paper ExecutionAdapter (spec §4.2) for CASH_INTRADAY, MTF and OPTIONS_BUY. A
 * malformed request is a 400 with nothing written; everything else is a persisted order
 * (REJECTED with its reason, or OPEN and tracked by the matcher). Entries are refused
 * while the user's core kill switch is on or unreadable (plan ruling 7). Nothing calls
 * this in production before M5.
 */
@Injectable()
export class PaperExecutionAdapter implements ExecutionAdapter {
  constructor(
    private readonly ledger: PaperLedgerService,
    private readonly matcher: PaperMatcherService,
    private readonly killSwitch: CoreKillSwitchService,
    @Inject(CORE_SESSION_CLOCK) private readonly clock: Pick<SessionClock, 'isOpen'>,
  ) {}

  async placeOrder(req: CoreOrderRequest): Promise<CoreOrder> {
    const problems = requestProblems(req);
    if (problems.length > 0) throw new BadRequestException(`malformed core order request: ${problems.join('; ')}`);
    const now = new Date();
    const killSwitchActive = req.purpose === 'ENTRY' ? await this.killSwitch.isActive(req.userId, now).catch(() => true) : false;
    const sessionOpen = this.clock.isOpen(req.instrument.exchange.toUpperCase(), now);
    const r = await this.ledger.place(req, { sessionOpen, killSwitchActive }, now);
    if (r.created && r.settings && isOpenState(r.order.state)) this.matcher.track(r.order, r.settings.noPriceRejectMs, now.getTime());
    return r.order;
  }

  async cancel(userId: string, orderId: string): Promise<CoreOrder> {
    const o = await this.ledger.close(userId, orderId, 'CANCEL', 'cancelled by the caller');
    if (!isOpenState(o.state)) this.matcher.untrack(orderId);
    return o;
  }

  async modify(userId: string, orderId: string, patch: CoreOrderPatch): Promise<CoreOrder> {
    const o = await this.ledger.modify(userId, orderId, patch);
    this.matcher.refresh(o);
    return o;
  }

  getOrder(userId: string, orderId: string): Promise<CoreOrder> {
    return this.ledger.getOrder(userId, orderId);
  }

  getPositions(userId: string): Promise<CorePositionView[]> {
    return this.ledger.positions(userId);
  }

  getFunds(userId: string): Promise<CoreFunds> {
    return this.ledger.funds(userId);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/modules/trade-core/execution/paper-execution.adapter.spec.ts`
Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

```bash
git add -- apps/api/src/modules/trade-core/execution/paper-execution.adapter.ts apps/api/src/modules/trade-core/execution/paper-execution.adapter.spec.ts
git commit -m "feat(trade-core): paper execution adapter — cash, MTF and options orders through the ledger and matcher" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/api/src/modules/trade-core/execution/paper-execution.adapter.ts apps/api/src/modules/trade-core/execution/paper-execution.adapter.spec.ts
```

---

### Task 12: Nightly MTF interest (15:35 IST)

**Files:**
- Modify: `apps/api/src/modules/trade-core/execution/paper-ledger.service.ts` (add `postMtfInterest`)
- Create: `apps/api/src/modules/trade-core/execution/mtf-interest.cron.ts`
- Test: `apps/api/src/modules/trade-core/execution/mtf-interest.spec.ts`

**Interfaces:**
- Consumes: `CoreOrderRepository.listMtfHolders`, `CoreCashLedgerRepository.lastInterestDate` / `appendInterest`
  (Task 6), `mtfInterestDays`, `dailyMtfInterest`, `istDate` (Task 3), `mtfFunded` (Task 3), `JobRunnerService`
  (`common/job-registry`, global; `run(jobName, { ttlMs, onRedisError }, fn)`), `@Cron` (`@nestjs/schedule`).
- Produces:

```typescript
// PaperLedgerService
postMtfInterest(today: string): Promise<{ holdings: number; posted: number }>;   // throws when settings are incomplete
// mtf-interest.cron.ts
export const MTF_INTEREST_JOB = 'core-mtf-interest';
class MtfInterestCron { nightly(): Promise<void>; run(now: Date): Promise<void> }
```

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/modules/trade-core/execution/mtf-interest.spec.ts`:

```typescript
import { readFileSync } from 'fs';
import { join } from 'path';
import { Prisma } from '@prisma/client';
import type { JobRunnerService } from '../../../common/job-registry';
import { MTF_INTEREST_JOB, MtfInterestCron } from './mtf-interest.cron';
import { PaperLedgerService, type PlaceContext } from './paper-ledger.service';
import type { PaperSettings } from './paper-settings';
import { fakeDefaults, MemoryPaperStore } from './testing/memory-paper-store';
import { cashBuy, mtfBuy, paperSettings } from './testing/paper-fixtures';

const D = (s: string) => new Prisma.Decimal(s);
const OPEN: PlaceContext = { sessionOpen: true, killSwitchActive: false };
/** Friday 2026-10-09, 10:30 IST. */
const FRI = new Date('2026-10-09T05:00:00.000Z');
const AT = new Date(FRI.getTime() + 10);

async function holding(settings: PaperSettings | null = paperSettings()) {
  const store = new MemoryPaperStore(() => FRI);
  const svc = new PaperLedgerService(store.tx, store.orderRepo, store.fillRepo, store.ledgerRepo, fakeDefaults(settings ?? paperSettings()));
  const { order } = await svc.place(mtfBuy(), OPEN, FRI);
  await svc.applyFill('user_A', order.id, 0, { qty: 10, price: D('1000.5'), priceAt: AT });
  const interest = (userId = 'user_A') => store.ledger.filter((r) => r.type === 'MTF_INTEREST' && r.userId === userId).map((r) => [r.interestDate, r.amount.toFixed(2), r.token]);
  return { store, svc, interest };
}

describe('PaperLedgerService.postMtfInterest (spec §4.4)', () => {
  it('the first run posts the opening day on the funded amount', async () => {
    const { svc, interest } = await holding();
    expect(await svc.postMtfInterest('2026-10-09')).toEqual({ holdings: 1, posted: 1 });
    expect(interest()).toEqual([['2026-10-09', '-2.47', '1594']]);
  });

  it("Monday's run posts Saturday, Sunday and Monday", async () => {
    const { svc, interest } = await holding();
    await svc.postMtfInterest('2026-10-09');
    expect(await svc.postMtfInterest('2026-10-12')).toEqual({ holdings: 1, posted: 3 });
    expect(interest().map((r) => r[0])).toEqual(['2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12']);
  });

  it('a second run the same day posts nothing', async () => {
    const { svc, interest } = await holding();
    await svc.postMtfInterest('2026-10-12');
    expect(await svc.postMtfInterest('2026-10-12')).toEqual({ holdings: 1, posted: 0 });
    expect(interest()).toHaveLength(4);
  });

  it('a missed night is caught up from the opening day', async () => {
    const { svc, interest } = await holding();
    expect((await svc.postMtfInterest('2026-10-13')).posted).toBe(5);
    expect(interest().map((r) => r[0])).toEqual(['2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13']);
  });

  it('a closed holding is not charged, and cash positions never are', async () => {
    const { svc, interest } = await holding();
    const exit = (await svc.place(mtfBuy({ idempotencyKey: 'exit', purpose: 'EXIT', side: 'SELL', refPrice: 1010 }), OPEN, FRI)).order;
    await svc.applyFill('user_A', exit.id, 0, { qty: 10, price: D('1010'), priceAt: AT });
    const cash = (await svc.place(cashBuy(), OPEN, FRI)).order;
    await svc.applyFill('user_A', cash.id, 0, { qty: 100, price: D('500'), priceAt: AT });
    expect(await svc.postMtfInterest('2026-10-12')).toEqual({ holdings: 0, posted: 0 });
    expect(interest()).toEqual([]);
  });

  it("one user's holding never posts interest for another", async () => {
    const { svc, interest } = await holding();
    const b = (await svc.place(mtfBuy({ userId: 'user_B', idempotencyKey: 'kb' }), OPEN, FRI)).order;
    await svc.applyFill('user_B', b.id, 0, { qty: 10, price: D('1000.5'), priceAt: AT });
    const bExit = (await svc.place(mtfBuy({ userId: 'user_B', idempotencyKey: 'kb-exit', purpose: 'EXIT', side: 'SELL' }), OPEN, FRI)).order;
    await svc.applyFill('user_B', bExit.id, 0, { qty: 10, price: D('1001'), priceAt: AT });
    expect(await svc.postMtfInterest('2026-10-09')).toEqual({ holdings: 1, posted: 1 });
    expect(interest('user_A')).toHaveLength(1);
    expect(interest('user_B')).toEqual([]);
  });

  it('without settings the run fails loudly and posts nothing', async () => {
    const { store } = await holding();
    const blind = new PaperLedgerService(store.tx, store.orderRepo, store.fillRepo, store.ledgerRepo, fakeDefaults(null));
    await expect(blind.postMtfInterest('2026-10-09')).rejects.toThrow('paper settings are incomplete');
    expect(store.ledger.filter((r) => r.type === 'MTF_INTEREST')).toEqual([]);
  });
});

describe('MtfInterestCron', () => {
  it('runs at 15:35 IST Monday to Friday, through the job runner, for the IST date', async () => {
    const src = readFileSync(join(__dirname, 'mtf-interest.cron.ts'), 'utf8');
    expect(src).toContain("@Cron('0 35 15 * * 1-5', { name: MTF_INTEREST_JOB, timeZone: 'Asia/Kolkata' })");
    const ledger = { postMtfInterest: jest.fn().mockResolvedValue({ holdings: 1, posted: 1 }) };
    const jobs = { run: jest.fn((_name: string, _opts: unknown, fn: () => Promise<unknown>) => fn()) };
    await new MtfInterestCron(ledger as unknown as PaperLedgerService, jobs as unknown as JobRunnerService).run(new Date('2026-10-12T10:05:00.000Z'));
    expect(jobs.run).toHaveBeenCalledWith(MTF_INTEREST_JOB, { ttlMs: 30 * 60 * 1000, onRedisError: 'run-anyway' }, expect.any(Function));
    expect(ledger.postMtfInterest).toHaveBeenCalledWith('2026-10-12');
  });

  it('a failing run is logged, never thrown into the scheduler', async () => {
    const ledger = { postMtfInterest: jest.fn().mockRejectedValue(new Error('db down')) };
    const jobs = { run: jest.fn((_name: string, _opts: unknown, fn: () => Promise<unknown>) => fn()) };
    await expect(new MtfInterestCron(ledger as unknown as PaperLedgerService, jobs as unknown as JobRunnerService).run(new Date())).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest src/modules/trade-core/execution/mtf-interest.spec.ts`
Expected: FAIL with `Cannot find module './mtf-interest.cron'`.

- [ ] **Step 3: Add `postMtfInterest` to the ledger service**

In `apps/api/src/modules/trade-core/execution/paper-ledger.service.ts`, replace

```typescript
import { applyPositionFill, balances, FLAT, istDate, money, ZERO, type PositionState } from './ledger-math';
import { marginFor, marginRefPrice, proportionalRelease } from './margin';
```

with

```typescript
import { applyPositionFill, balances, dailyMtfInterest, FLAT, istDate, money, mtfInterestDays, ZERO, type PositionState } from './ledger-math';
import { marginFor, marginRefPrice, mtfFunded, proportionalRelease } from './margin';
```

and add this method inside the class, after `positions(…)`:

```typescript
  /**
   * Nightly MTF interest (spec §4.4, plan ruling 10): for every open MTF holding, one
   * MTF_INTEREST row per IST calendar day from the day after the last posting (or the
   * opening day) through `today`, each funded amount × mtfAnnualRatePct ÷ 365. The
   * unique (userId, token, interestDate) index makes a rerun post nothing; a missed night
   * or a weekend is caught up. Fails loudly (the job run is recorded FAILED) without
   * settings.
   */
  async postMtfInterest(today: string): Promise<{ holdings: number; posted: number }> {
    const loaded = await this.defaults.settings();
    if (!loaded.ok) throw new Error(`paper settings are incomplete: ${loaded.missing.join(', ')}`);
    const settings = loaded.settings;
    let holdings = 0;
    let posted = 0;
    for (const { userId, token } of await this.orders.listMtfHolders()) {
      const r = await this.tx.run(userId, async (db) => {
        const { netQty, avgPrice, openedAt } = (await this.positionContext(userId, 'MTF', token, [], db)).state;
        if (netQty <= 0 || !avgPrice || !openedAt) return { held: 0, n: 0 };
        const days = mtfInterestDays(istDate(openedAt), await this.ledger.lastInterestDate(userId, token, db), today);
        const funded = mtfFunded(avgPrice.mul(netQty), settings);
        const amount = ZERO.minus(dailyMtfInterest(funded, settings.mtfAnnualRatePct));
        const note = `MTF interest on ₹${funded.toFixed(2)} funded at ${settings.mtfAnnualRatePct.toFixed(2)} percent a year`;
        const n = await this.ledger.appendInterest(
          days.map((interestDate) => ({ userId, type: 'MTF_INTEREST' as const, amount, token, interestDate, note })),
          db,
        );
        return { held: 1, n };
      });
      holdings += r.held;
      posted += r.n;
    }
    return { holdings, posted };
  }
```

- [ ] **Step 4: Write the cron**

Create `apps/api/src/modules/trade-core/execution/mtf-interest.cron.ts`:

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { JobRunnerService } from '../../../common/job-registry';
import { istDate } from './ledger-math';
import { PaperLedgerService } from './paper-ledger.service';

/** Job name in job_runs (M5 adds it to health-detail EXPECTED_JOBS with its reconciliation). */
export const MTF_INTEREST_JOB = 'core-mtf-interest';
/** Well above a run (one short transaction per holding), well under a day. */
const MTF_INTEREST_LEASE_MS = 30 * 60 * 1000;

/**
 * Spec §4.4: MTF interest at 15:35 IST, before M5's 15:45 reconciliation. Monday to
 * Friday; calendar days are posted, so the weekend is caught up on Monday. Leased and
 * recorded through the job runner; 'run-anyway' on a Redis outage is safe because the
 * posting is idempotent.
 */
@Injectable()
export class MtfInterestCron {
  private readonly logger = new Logger(MtfInterestCron.name);

  constructor(
    private readonly ledger: PaperLedgerService,
    private readonly jobs: JobRunnerService,
  ) {}

  @Cron('0 35 15 * * 1-5', { name: MTF_INTEREST_JOB, timeZone: 'Asia/Kolkata' })
  async nightly(): Promise<void> {
    await this.run(new Date());
  }

  async run(now: Date): Promise<void> {
    const day = istDate(now);
    try {
      await this.jobs.run(MTF_INTEREST_JOB, { ttlMs: MTF_INTEREST_LEASE_MS, onRedisError: 'run-anyway' }, async () => {
        const r = await this.ledger.postMtfInterest(day);
        this.logger.log(`MTF interest ${day}: ${r.holdings} open holding(s), ${r.posted} day row(s) posted`);
        return r;
      });
    } catch (err) {
      this.logger.error(`MTF interest ${day} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
```

- [ ] **Step 5: Run the tests, and the cron ratchet**

Run: `npx jest src/modules/trade-core/execution/mtf-interest.spec.ts src/common/schedule/cron-timezone.spec.ts src/modules/trade-core/execution/paper-ledger`
Expected: PASS (9 tests; the ratchet's 3 tests unchanged; both ledger specs still pass).

- [ ] **Step 6: Commit**

```bash
git add -- apps/api/src/modules/trade-core/execution/paper-ledger.service.ts apps/api/src/modules/trade-core/execution/mtf-interest.cron.ts apps/api/src/modules/trade-core/execution/mtf-interest.spec.ts
git commit -m "feat(trade-core): nightly MTF interest at 15:35 IST, one row per calendar day, idempotent catch-up" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/api/src/modules/trade-core/execution/paper-ledger.service.ts apps/api/src/modules/trade-core/execution/mtf-interest.cron.ts apps/api/src/modules/trade-core/execution/mtf-interest.spec.ts
```

---

### Task 13: Rebind the M2 ports and wire the module

**Files:**
- Create: `apps/api/src/modules/trade-core/execution/paper-risk-state.provider.ts`
- Create: `apps/api/src/modules/trade-core/execution/paper-order-square-off.ts`
- Modify: `apps/api/src/modules/trade-core/trade-core.module.ts`
- Modify: `apps/api/src/modules/trade-core/trade-core.module.spec.ts`
- Test: `apps/api/src/modules/trade-core/execution/execution-ports.spec.ts`

**Interfaces:**
- Consumes: `RiskStateProvider`, `CoreSquareOffPort`, `CoreSquareOffCause`, `CoreSquareOffResult`, the four tokens
  (`risk-wall/ports.ts`), `RiskLiveState`, `RiskOpenPosition` (`risk-wall/risk-wall.types.ts:59-92`), `exposureOf`
  (`risk-wall/risk-wall.ts:33`), `PaperLedgerService.funds` / `positions` / `dayStats` / `openOrdersForUser` /
  `close` (Tasks 8–9), `PaperMatcherService.untrack` (Task 10), every M3 provider.
- Produces:

```typescript
class PaperRiskStateProvider implements RiskStateProvider { liveState(userId: string, at: Date): Promise<RiskLiveState> }
class PaperOrderSquareOff implements CoreSquareOffPort { squareOffAll(userId: string, cause: CoreSquareOffCause, reason: string): Promise<CoreSquareOffResult> }
// TradeCoreModule: RISK_STATE_PROVIDER → PaperRiskStateProvider, CORE_SQUARE_OFF → PaperOrderSquareOff,
// CORE_EXECUTION_ADAPTER → PaperExecutionAdapter (exported), CorePaperDefaultsController, MtfInterestCron, PaperMatcherService.
```

What the state provider supplies (spec §4.7): `deployedCapital` per vehicle and `openPositions` from the ledger and
fills, `tradesToday` (accepted entries, IST day) and `realisedPnlToday` (net realised − charges − interest, IST day).
What stays fail-closed until M4: `openPnl: null` (no marks yet) and `priced: false` on every position, so the wall
rejects every entry with `PNL_UNKNOWN` (and `UNPRICED_POSITION` when a position is open); `pnlTodayByStrategy: {}` and
`strategyId: ''` (positions are not strategy-tagged before M4/M5); `dailyLossLatched: false` (M5 derives it).

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/modules/trade-core/execution/execution-ports.spec.ts`:

```typescript
import type { ModuleRef } from '@nestjs/core';
import { Prisma } from '@prisma/client';
import { checkRisk } from '../risk-wall/risk-wall';
import { ctxFixture, intentFixture } from '../risk-wall/testing/risk-fixtures';
import { PaperLedgerService, type PlaceContext } from './paper-ledger.service';
import { PaperMatcherService } from './paper-matcher.service';
import { PaperOrderSquareOff } from './paper-order-square-off';
import { PaperRiskStateProvider } from './paper-risk-state.provider';
import { FakeHub, fakeHubSource, fakeModuleRef } from './testing/fake-hub';
import { fakeDefaults, MemoryPaperStore } from './testing/memory-paper-store';
import { cashBuy, NOW, optionBuy } from './testing/paper-fixtures';

const OPEN: PlaceContext = { sessionOpen: true, killSwitchActive: false };
const AT = new Date(NOW.getTime() + 10);
const D = (s: string) => new Prisma.Decimal(s);

function setup() {
  const store = new MemoryPaperStore(() => NOW);
  const defaults = fakeDefaults();
  const ledger = new PaperLedgerService(store.tx, store.orderRepo, store.fillRepo, store.ledgerRepo, defaults);
  const matcher = new PaperMatcherService(ledger, defaults, fakeModuleRef(fakeHubSource({ user_A: new FakeHub() })) as unknown as ModuleRef, { isOpen: () => true });
  return { store, ledger, matcher, provider: new PaperRiskStateProvider(ledger), squareOff: new PaperOrderSquareOff(ledger, matcher) };
}

describe('RISK_STATE_PROVIDER (paper)', () => {
  it("reports deployed capital, open positions, today's net P&L and entries; P&L and pricing stay fail-closed", async () => {
    const { ledger, provider } = setup();
    const { order } = await ledger.place(cashBuy(), OPEN, NOW);
    await ledger.applyFill('user_A', order.id, 0, { qty: 100, price: D('500.7'), priceAt: AT });
    expect(await provider.liveState('user_A', NOW)).toEqual({
      asOf: NOW,
      openPositions: [
        { positionId: 'CASH_INTRADAY:2885', strategyId: '', vehicle: 'CASH_INTRADAY', symbol: 'RELIANCE-EQ', underlying: 'RELIANCE-EQ', direction: 'LONG', state: 'OPEN', priced: false },
      ],
      realisedPnlToday: -26.92,
      openPnl: null,
      pnlTodayByStrategy: {},
      tradesToday: 1,
      deployedCapital: { CASH_INTRADAY: 10014, MTF: 0, OPTIONS_BUY: 0 },
      dailyLossLatched: false,
    });
  });

  it('a bought PE is SHORT its underlying', async () => {
    const { ledger, provider } = setup();
    const req = optionBuy({ instrument: { exchange: 'NFO', token: '43522', symbol: 'NIFTY13OCT2625000PE', lotSize: 75, underlying: 'NIFTY' } });
    const { order } = await ledger.place(req, OPEN, NOW);
    await ledger.applyFill('user_A', order.id, 0, { qty: 150, price: D('100'), priceAt: AT });
    const [p] = (await provider.liveState('user_A', NOW)).openPositions;
    expect(p).toMatchObject({ vehicle: 'OPTIONS_BUY', underlying: 'NIFTY', direction: 'SHORT' });
  });

  it('with this state the Risk Wall still rejects every entry until M4 (P&L unknown)', async () => {
    const { provider } = setup();
    const v = checkRisk(intentFixture(), ctxFixture({ state: await provider.liveState('user_A', NOW) }));
    expect(v.verdict).toBe('REJECT');
    expect(v.reasons.map((r) => r.code)).toContain('PNL_UNKNOWN');
  });
});

describe('CORE_SQUARE_OFF (paper)', () => {
  it("cancels every pending core order of the user and nothing of another user's", async () => {
    const { store, ledger, matcher, squareOff } = setup();
    const a1 = (await ledger.place(cashBuy(), OPEN, NOW)).order;
    const a2 = (await ledger.place(optionBuy(), OPEN, NOW)).order;
    const b1 = (await ledger.place(cashBuy({ userId: 'user_B', idempotencyKey: 'kb' }), OPEN, NOW)).order;
    for (const o of [a1, a2, b1]) matcher.track(o, 30_000, NOW.getTime());
    expect(await squareOff.squareOffAll('user_A', 'KILL_SWITCH', 'stop everything')).toEqual({
      cancelledOrders: 2,
      exitsRequested: 0,
      detail: '2 pending core order(s) cancelled; open core positions are exited by the lifecycle (M4), none in M3',
    });
    expect(store.orders.map((o) => [o.userId, o.state])).toEqual([['user_A', 'CANCELLED'], ['user_A', 'CANCELLED'], ['user_B', 'OPEN']]);
    expect([a1, a2, b1].map((o) => matcher.isTracked(o.id))).toEqual([false, false, true]);
  });

  it('a failed cancellation makes the step fail, never a silent partial OK', async () => {
    const { ledger, squareOff } = setup();
    await ledger.place(cashBuy(), OPEN, NOW);
    await ledger.place(optionBuy(), OPEN, NOW);
    jest.spyOn(ledger, 'close').mockRejectedValueOnce(new Error('db down'));
    await expect(squareOff.squareOffAll('user_A', 'KILL_SWITCH', 'stop')).rejects.toThrow('cancelled 1 of 2 pending core orders; failed: ');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest src/modules/trade-core/execution/execution-ports.spec.ts`
Expected: FAIL with `Cannot find module './paper-order-square-off'`.

- [ ] **Step 3: Write the two port bindings**

Create `apps/api/src/modules/trade-core/execution/paper-risk-state.provider.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import type { RiskStateProvider } from '../risk-wall/ports';
import { exposureOf } from '../risk-wall/risk-wall';
import type { RiskLiveState, RiskOpenPosition } from '../risk-wall/risk-wall.types';
import { VEHICLES, type Vehicle } from '../strategies/blocks/block-types';
import { PaperLedgerService } from './paper-ledger.service';

/** An option tradingsymbol ends in its type, after the strike digit (trade-sentinel/charges.ts OPTION_SUFFIX). */
const OPTION_TYPE = /\d(CE|PE)$/;

/**
 * RISK_STATE_PROVIDER from the paper ledger (spec §4.7). Deployed capital, open
 * positions, today's entries and today's net realised P&L are real. Until M4 marks
 * positions to market, openPnl is null and every position is unpriced, so the Risk Wall
 * keeps rejecting entries (PNL_UNKNOWN): fail closed, and visibly so in every verdict.
 */
@Injectable()
export class PaperRiskStateProvider implements RiskStateProvider {
  constructor(private readonly ledger: PaperLedgerService) {}

  async liveState(userId: string, at: Date): Promise<RiskLiveState> {
    const [funds, positions, day] = await Promise.all([this.ledger.funds(userId), this.ledger.positions(userId), this.ledger.dayStats(userId, at)]);
    const openPositions: RiskOpenPosition[] = positions.map((p) => {
      const optionType = p.vehicle === 'OPTIONS_BUY' ? ((OPTION_TYPE.exec(p.instrument.symbol.toUpperCase())?.[1] as 'CE' | 'PE' | undefined) ?? null) : null;
      return {
        positionId: p.key,
        strategyId: '',
        vehicle: p.vehicle,
        symbol: p.instrument.symbol,
        underlying: p.instrument.underlying ?? p.instrument.symbol,
        direction: exposureOf(p.vehicle, p.direction === 'LONG' ? 'BUY' : 'SELL', optionType),
        state: 'OPEN',
        priced: false,
      };
    });
    return {
      asOf: at,
      openPositions,
      realisedPnlToday: day.netPnlToday.toNumber(),
      openPnl: null,
      pnlTodayByStrategy: {},
      tradesToday: day.entriesToday,
      deployedCapital: Object.fromEntries(VEHICLES.map((v) => [v, Number(funds.deployedByVehicle[v])])) as Record<Vehicle, number>,
      dailyLossLatched: false,
    };
  }
}
```

Create `apps/api/src/modules/trade-core/execution/paper-order-square-off.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import type { CoreSquareOffCause, CoreSquareOffPort, CoreSquareOffResult } from '../risk-wall/ports';
import { isOpenState } from './order-state';
import { PaperLedgerService } from './paper-ledger.service';
import { PaperMatcherService } from './paper-matcher.service';

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * CORE_SQUARE_OFF's order half (spec §4.7): cancels every pending core order of the
 * user, each through the ledger (margin released) and out of the matcher. Exits of open
 * core positions arrive with M4. It goes through the ledger and the matcher rather than
 * the adapter because the adapter injects CoreKillSwitchService, which injects this port
 * (plan ruling 12). Any failed cancellation throws after trying every order, so the kill
 * switch cascade reports FAILED rather than a partial OK.
 */
@Injectable()
export class PaperOrderSquareOff implements CoreSquareOffPort {
  constructor(
    private readonly ledger: PaperLedgerService,
    private readonly matcher: PaperMatcherService,
  ) {}

  async squareOffAll(userId: string, cause: CoreSquareOffCause, reason: string): Promise<CoreSquareOffResult> {
    const open = await this.ledger.openOrdersForUser(userId);
    const failures: string[] = [];
    let cancelled = 0;
    for (const o of open) {
      try {
        const c = await this.ledger.close(userId, o.id, 'CANCEL', `${cause}: ${reason}`);
        if (!isOpenState(c.state)) this.matcher.untrack(o.id);
        if (c.state === 'CANCELLED') cancelled += 1;
      } catch (err) {
        failures.push(`${o.id}: ${errorText(err)}`);
      }
    }
    if (failures.length > 0) {
      throw new Error(`cancelled ${cancelled} of ${open.length} pending core orders; failed: ${failures.join('; ')}`);
    }
    return {
      cancelledOrders: cancelled,
      exitsRequested: 0,
      detail: `${cancelled} pending core order(s) cancelled; open core positions are exited by the lifecycle (M4), none in M3`,
    };
  }
}
```

- [ ] **Step 4: Run the ports test**

Run: `npx jest src/modules/trade-core/execution/execution-ports.spec.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Wire the module (test first)**

Replace `apps/api/src/modules/trade-core/trade-core.module.spec.ts` with:

```typescript
import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ClsService } from 'nestjs-cls';
import { AuditService } from '../../common/audit/audit.service';
import { JobRunnerService } from '../../common/job-registry';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { SessionClock } from '../market-hub/session-clock';
import { TradeCoreModule } from './trade-core.module';
import { CoreStrategiesController } from './strategies/controllers/core-strategies.controller';
import { CoreStrategyCatalogueService } from './strategies/services/core-strategy-catalogue.service';
import { CoreStrategySelectionService } from './strategies/services/core-strategy-selection.service';
import { CoreRiskController } from './risk-wall/controllers/core-risk.controller';
import { CoreRiskDefaultsController } from './risk-wall/controllers/core-risk-defaults.controller';
import { CoreRiskDefaultsService } from './risk-wall/services/core-risk-defaults.service';
import { CORE_SESSION_CLOCK, CORE_SQUARE_OFF, LoggingRiskVerdictSink, RISK_STATE_PROVIDER, RISK_VERDICT_SINK } from './risk-wall/ports';
import { CoreKillSwitchReader } from './risk-wall/services/core-kill-switch.reader';
import { CoreKillSwitchService } from './risk-wall/services/core-kill-switch.service';
import { CoreRiskLimitService } from './risk-wall/services/core-risk-limit.service';
import { RiskWallService } from './risk-wall/services/risk-wall.service';
import { SiloSquareOffAdapter } from './risk-wall/services/silo-square-off.adapter';
import { CorePaperDefaultsController } from './execution/controllers/core-paper-defaults.controller';
import { MtfInterestCron } from './execution/mtf-interest.cron';
import { CORE_EXECUTION_ADAPTER, PaperExecutionAdapter } from './execution/paper-execution.adapter';
import { PaperLedgerService } from './execution/paper-ledger.service';
import { PaperMatcherService } from './execution/paper-matcher.service';
import { PaperOrderSquareOff } from './execution/paper-order-square-off';
import { PaperRiskStateProvider } from './execution/paper-risk-state.provider';
import { CorePaperDefaultsService } from './execution/services/core-paper-defaults.service';

/**
 * Stands in for the real @Global AuditModule, @Global JobRegistryModule, @Global
 * TenantModule and the global ClsModule.forRoot({ global: true }), which AppModule provides.
 */
@Global()
@Module({
  providers: [
    { provide: AuditService, useValue: { append: jest.fn() } },
    { provide: JobRunnerService, useValue: { run: jest.fn() } },
    { provide: TenantContextService, useValue: { runWithoutTenant: (fn: () => unknown) => fn() } },
    { provide: ClsService, useValue: { isActive: () => false } },
  ],
  exports: [AuditService, JobRunnerService, TenantContextService, ClsService],
})
class FakeAuditModule {}

async function compile() {
  return Test.createTestingModule({ imports: [FakeAuditModule, TradeCoreModule] })
    .overrideProvider(PrismaService)
    .useValue({})
    .compile();
}

describe('TradeCoreModule', () => {
  it('resolves the controller and both services', async () => {
    const mod = await compile();
    expect(mod.get(CoreStrategiesController)).toBeInstanceOf(CoreStrategiesController);
    expect(mod.get(CoreStrategyCatalogueService)).toBeInstanceOf(CoreStrategyCatalogueService);
    expect(mod.get(CoreStrategySelectionService)).toBeInstanceOf(CoreStrategySelectionService);
  });

  it('resolves the M2 risk parts', async () => {
    const mod = await compile();
    expect(mod.get(CoreRiskController)).toBeInstanceOf(CoreRiskController);
    expect(mod.get(RiskWallService)).toBeInstanceOf(RiskWallService);
    expect(mod.get(CoreRiskLimitService)).toBeInstanceOf(CoreRiskLimitService);
    expect(mod.get(CoreKillSwitchService)).toBeInstanceOf(CoreKillSwitchService);
    expect(mod.get(SiloSquareOffAdapter)).toBeInstanceOf(SiloSquareOffAdapter);
    expect(mod.get(CORE_SESSION_CLOCK)).toBeInstanceOf(SessionClock);
    expect(mod.get(RISK_VERDICT_SINK)).toBeInstanceOf(LoggingRiskVerdictSink);
    expect(mod.get(CoreRiskDefaultsController)).toBeInstanceOf(CoreRiskDefaultsController);
    expect(mod.get(CoreRiskDefaultsService)).toBeInstanceOf(CoreRiskDefaultsService);
    expect(mod.get(CoreKillSwitchReader)).toBeInstanceOf(CoreKillSwitchReader);
  });

  it('resolves the M3 execution parts and rebinds the M2 ports to them', async () => {
    const mod = await compile();
    expect(mod.get(RISK_STATE_PROVIDER)).toBeInstanceOf(PaperRiskStateProvider);
    expect(mod.get(CORE_SQUARE_OFF)).toBeInstanceOf(PaperOrderSquareOff);
    expect(mod.get(CORE_EXECUTION_ADAPTER)).toBe(mod.get(PaperExecutionAdapter));
    expect(mod.get(PaperLedgerService)).toBeInstanceOf(PaperLedgerService);
    expect(mod.get(PaperMatcherService)).toBeInstanceOf(PaperMatcherService);
    expect(mod.get(CorePaperDefaultsService)).toBeInstanceOf(CorePaperDefaultsService);
    expect(mod.get(CorePaperDefaultsController)).toBeInstanceOf(CorePaperDefaultsController);
    expect(mod.get(MtfInterestCron)).toBeInstanceOf(MtfInterestCron);
  });
});
```

Run: `npx jest src/modules/trade-core/trade-core.module.spec.ts`
Expected: FAIL (the third test: `RISK_STATE_PROVIDER` is still `UnavailableRiskStateProvider`, and `Nest could not find
CORE_EXECUTION_ADAPTER element`).

Replace `apps/api/src/modules/trade-core/trade-core.module.ts` with:

```typescript
import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { CoreStrategiesController } from './strategies/controllers/core-strategies.controller';
import { CoreStrategyRepository } from './strategies/repositories/core-strategy.repository';
import { CoreStrategySelectionRepository } from './strategies/repositories/core-strategy-selection.repository';
import { CoreStrategyCatalogueService } from './strategies/services/core-strategy-catalogue.service';
import { CoreStrategySelectionService } from './strategies/services/core-strategy-selection.service';
import { CoreRiskController } from './risk-wall/controllers/core-risk.controller';
import { CoreRiskDefaultsController } from './risk-wall/controllers/core-risk-defaults.controller';
import { CoreRiskDefaultsService } from './risk-wall/services/core-risk-defaults.service';
import { CORE_SESSION_CLOCK, CORE_SQUARE_OFF, createCoreSessionClock, LoggingRiskVerdictSink, RISK_STATE_PROVIDER, RISK_VERDICT_SINK } from './risk-wall/ports';
import { CoreKillSwitchRepository } from './risk-wall/repositories/core-kill-switch.repository';
import { CoreRiskLimitRepository } from './risk-wall/repositories/core-risk-limit.repository';
import { CoreKillSwitchReader } from './risk-wall/services/core-kill-switch.reader';
import { CoreKillSwitchService } from './risk-wall/services/core-kill-switch.service';
import { CoreRiskLimitService } from './risk-wall/services/core-risk-limit.service';
import { RiskWallService } from './risk-wall/services/risk-wall.service';
import { SiloSquareOffAdapter } from './risk-wall/services/silo-square-off.adapter';
import { CorePaperDefaultsController } from './execution/controllers/core-paper-defaults.controller';
import { MtfInterestCron } from './execution/mtf-interest.cron';
import { CORE_EXECUTION_ADAPTER, PaperExecutionAdapter } from './execution/paper-execution.adapter';
import { PaperLedgerService } from './execution/paper-ledger.service';
import { PaperMatcherService } from './execution/paper-matcher.service';
import { PaperOrderSquareOff } from './execution/paper-order-square-off';
import { PaperRiskStateProvider } from './execution/paper-risk-state.provider';
import { CoreCashLedgerRepository } from './execution/repositories/core-cash-ledger.repository';
import { CoreFillRepository } from './execution/repositories/core-fill.repository';
import { CoreOrderRepository } from './execution/repositories/core-order.repository';
import { CorePaperDefaultsRepository } from './execution/repositories/core-paper-defaults.repository';
import { CorePaperTx } from './execution/repositories/core-paper-tx';
import { CorePaperDefaultsService } from './execution/services/core-paper-defaults.service';

/**
 * SP2 trade core (docs/superpowers/specs/2026-10-09-sp2-core-trade-lifecycle-design.md).
 * M1: `strategies/` (catalogue, immutable versions, per-user selections).
 * M2: `risk-wall/` (the pure Risk Wall check, per-user limits with tighten-now /
 * loosen-next-session, the persistent kill switch and its silo cascade).
 * M3: `execution/` (the paper ExecutionAdapter for cash, MTF and options; orders, fills
 * and the cash ledger; the in-memory matcher fed by the market hub; nightly MTF
 * interest). M3 rebinds RISK_STATE_PROVIDER (still rejecting every entry until M4 marks
 * positions) and CORE_SQUARE_OFF (cancels pending core orders). Nothing calls the
 * adapter before M5. AuditService and JobRunnerService come from their @Global modules;
 * the market hub is reached lazily through ModuleRef (HUB_PRICE_SOURCE), and no silo
 * module is imported (approach A).
 */
@Module({
  imports: [PrismaModule],
  controllers: [CoreStrategiesController, CoreRiskController, CoreRiskDefaultsController, CorePaperDefaultsController],
  providers: [
    CoreStrategyRepository,
    CoreStrategySelectionRepository,
    CoreStrategyCatalogueService,
    CoreStrategySelectionService,
    CoreRiskLimitRepository,
    CoreKillSwitchRepository,
    CoreRiskLimitService,
    CoreRiskDefaultsService,
    CoreKillSwitchService,
    CoreKillSwitchReader,
    SiloSquareOffAdapter,
    RiskWallService,
    CoreOrderRepository,
    CoreFillRepository,
    CoreCashLedgerRepository,
    CorePaperDefaultsRepository,
    CorePaperTx,
    CorePaperDefaultsService,
    PaperLedgerService,
    PaperMatcherService,
    PaperExecutionAdapter,
    MtfInterestCron,
    { provide: CORE_EXECUTION_ADAPTER, useExisting: PaperExecutionAdapter },
    { provide: CORE_SESSION_CLOCK, useFactory: createCoreSessionClock },
    { provide: RISK_STATE_PROVIDER, useClass: PaperRiskStateProvider },
    { provide: RISK_VERDICT_SINK, useClass: LoggingRiskVerdictSink },
    { provide: CORE_SQUARE_OFF, useClass: PaperOrderSquareOff },
  ],
  exports: [
    CoreStrategyCatalogueService,
    CoreStrategySelectionService,
    RiskWallService,
    CoreRiskLimitService,
    CoreKillSwitchService,
    PaperExecutionAdapter,
    CORE_EXECUTION_ADAPTER,
  ],
})
export class TradeCoreModule {}
```

- [ ] **Step 6: Run the module spec and every trade-core spec**

Run: `npx jest src/modules/trade-core`
Expected: PASS: the module spec's 3 tests, every M1/M2 spec unchanged (`ports.spec.ts` still tests the M2 default
classes, which stay in `ports.ts`), and every M3 spec so far.

- [ ] **Step 7: Commit**

```bash
git add -- apps/api/src/modules/trade-core/execution/paper-risk-state.provider.ts apps/api/src/modules/trade-core/execution/paper-order-square-off.ts apps/api/src/modules/trade-core/execution/execution-ports.spec.ts apps/api/src/modules/trade-core/trade-core.module.ts apps/api/src/modules/trade-core/trade-core.module.spec.ts
git commit -m "feat(trade-core): rebind RISK_STATE_PROVIDER and CORE_SQUARE_OFF to the paper ledger; wire execution" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/api/src/modules/trade-core/execution/paper-risk-state.provider.ts apps/api/src/modules/trade-core/execution/paper-order-square-off.ts apps/api/src/modules/trade-core/execution/execution-ports.spec.ts apps/api/src/modules/trade-core/trade-core.module.ts apps/api/src/modules/trade-core/trade-core.module.spec.ts
```

---

### Task 14: Tenant isolation end to end, then the whole-suite verification

**Files:**
- Test: `apps/api/src/modules/trade-core/execution/execution-tenant.spec.ts`
- Modify: `docs/superpowers/plans/2026-10-11-sp2-m3-execution.md` (verification ledger)

**Interfaces:**
- Consumes: everything above. Produces: nothing new.

- [ ] **Step 1: Write the tenant test**

Create `apps/api/src/modules/trade-core/execution/execution-tenant.spec.ts`:

```typescript
import { ConflictException, NotFoundException } from '@nestjs/common';
import type { ModuleRef } from '@nestjs/core';
import type { CoreKillSwitchService } from '../risk-wall/services/core-kill-switch.service';
import type { CoreOrder, CoreOrderRequest } from './execution.types';
import { PaperExecutionAdapter } from './paper-execution.adapter';
import { PaperLedgerService } from './paper-ledger.service';
import { PaperMatcherService } from './paper-matcher.service';
import { FakeHub, fakeHubSource, fakeModuleRef } from './testing/fake-hub';
import { fakeDefaults, MemoryPaperStore } from './testing/memory-paper-store';
import { cashBuy, depth, hubPrice } from './testing/paper-fixtures';

function setup(served: string[] = ['user_A', 'user_B']) {
  const store = new MemoryPaperStore();
  const defaults = fakeDefaults();
  const ledger = new PaperLedgerService(store.tx, store.orderRepo, store.fillRepo, store.ledgerRepo, defaults);
  const hub = new FakeHub();
  const clock = { isOpen: () => true };
  const matcher = new PaperMatcherService(ledger, defaults, fakeModuleRef(fakeHubSource(Object.fromEntries(served.map((u) => [u, hub])))) as unknown as ModuleRef, clock);
  const adapter = new PaperExecutionAdapter(ledger, matcher, { isActive: async () => false } as unknown as CoreKillSwitchService, clock);
  const fill = async (o: CoreOrder, req: CoreOrderRequest, ltp: number) => {
    const at = o.submittedAt.getTime() + 10;
    await matcher.onPrice(hub, hubPrice(req, ltp, at, depth([[ltp, 1000]], [[ltp, 1000]])), at + 1);
  };
  return { store, matcher, adapter, fill };
}

describe("tenant isolation (spec §6: user A's orders, fills and ledger never appear for user B)", () => {
  it('two users trading the same symbol keep separate orders, fills, ledgers and positions', async () => {
    const { store, adapter, fill } = setup();
    const aReq = cashBuy();
    const bReq = cashBuy({ userId: 'user_B', idempotencyKey: 'intent_b:entry', qty: 10 });
    await fill(await adapter.placeOrder(aReq), aReq, 500);
    await fill(await adapter.placeOrder(bReq), bReq, 500);
    const aExit = cashBuy({ idempotencyKey: 'intent_a:exit', purpose: 'EXIT', side: 'SELL', refPrice: 510 });
    await fill(await adapter.placeOrder(aExit), aExit, 510);

    expect((await adapter.getPositions('user_A')).map((p) => p.netQty)).toEqual([]);
    expect((await adapter.getPositions('user_B')).map((p) => p.netQty)).toEqual([10]);
    expect((await adapter.getFunds('user_B')).realisedPnl).toBe('0.00');
    expect((await adapter.getFunds('user_A')).realisedPnl).toBe('1000.00');
    const ownerOf = new Map(store.orders.map((o) => [o.id, o.userId]));
    for (const f of store.fills) expect(ownerOf.get(f.orderId)).toBe(f.userId);
    for (const r of store.ledger) if (r.orderId) expect(ownerOf.get(r.orderId)).toBe(r.userId);
    expect(new Set(store.txUsers)).toEqual(new Set(['user_A', 'user_B']));
  });

  it("another user's idempotency key is refused, never answered with that user's order", async () => {
    const { adapter } = setup();
    await adapter.placeOrder(cashBuy());
    await expect(adapter.placeOrder(cashBuy({ userId: 'user_B' }))).rejects.toBeInstanceOf(ConflictException);
  });

  it("user B cannot read, cancel or modify user A's order", async () => {
    const { adapter } = setup();
    const o = await adapter.placeOrder(cashBuy({ type: 'LIMIT', limitPrice: 400 }));
    await expect(adapter.getOrder('user_B', o.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(adapter.cancel('user_B', o.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(adapter.modify('user_B', o.id, { limitPrice: 390 })).rejects.toBeInstanceOf(NotFoundException);
    expect((await adapter.getOrder('user_A', o.id)).state).toBe('OPEN');
  });

  it("a user the hub does not serve gets no fills, only a no-price reject, and the served user's order fills", async () => {
    const { matcher, adapter, fill } = setup(['user_A']);
    const aReq = cashBuy();
    const bReq = cashBuy({ userId: 'user_B', idempotencyKey: 'kb' });
    const a = await adapter.placeOrder(aReq);
    const b = await adapter.placeOrder(bReq);
    await fill(a, aReq, 500);
    await fill(b, bReq, 500);
    await matcher.sweep(b.submittedAt.getTime() + 30_001);
    expect((await adapter.getOrder('user_A', a.id)).state).toBe('FILLED');
    expect(await adapter.getOrder('user_B', b.id)).toMatchObject({ state: 'REJECTED', rejectReason: 'no fresh price after submission (waited 30000 ms)' });
    expect((await adapter.getFunds('user_B')).freeCash).toBe('1000000.00');
  });
});
```

Run: `npx jest src/modules/trade-core/execution/execution-tenant.spec.ts`
Expected: PASS (4 tests). If one fails, the failure is a real isolation hole in the code of Tasks 8–11: fix the code,
not the test.

- [ ] **Step 2: Commit the tenant test**

```bash
git add -- apps/api/src/modules/trade-core/execution/execution-tenant.spec.ts
git commit -m "test(trade-core): tenant isolation of core orders, fills, ledger and positions end to end" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/api/src/modules/trade-core/execution/execution-tenant.spec.ts
```

- [ ] **Step 3: Whole API suite**

Run (from `apps/api`): `npx jest 2>&1 | Select-Object -Last 15` (PowerShell) or `npx jest 2>&1 | tail -15` (bash).
Expected: every suite passes. M3 adds 18 API suites (`charges-golden`, `charges-leg`, `order-state`, `paper-settings`,
`margin`, `ledger-math`, `fill-model`, `core-paper-defaults`, `core-paper.repository`, `core-paper-defaults.service`,
`core-paper-defaults.controller`, `paper-ledger.service`, `paper-ledger.fills`, `paper-matcher.service`,
`paper-execution.adapter`, `mtf-interest`, `execution-ports`, `execution-tenant`), and `trade-core.module.spec` grows
by one test. Every existing trade-sentinel spec passes unchanged (charges are bit-identical). Record the totals.
A time-of-day silo failure (`adaptive-stop-watch.service.spec.ts:168`, 00:00–00:45 IST) is pre-existing: rerun it alone.

- [ ] **Step 4: Isolation (spec §6), schedule and literals**

Run:
`git diff main --name-only -- apps/api/src ':!apps/api/src/modules/trade-core'`
Expected exactly: `apps/api/src/common/audit/audit-actions.ts`, `apps/api/src/common/tenant/tenant.constants.ts`,
`apps/api/src/modules/trade-sentinel/charges.ts`.

Run: `git diff main --name-only -- apps/web packages apps/api/test ':!apps/api/test/sp2-m3'`
Expected: empty.

Run: `git diff main --name-only -- prisma`
Expected exactly: `prisma/migrations/20261011120000_sp2_m3_execution/migration.sql`, `prisma/schema.prisma`.

Run: `git diff main -- apps/api/src/common/schedule/cron-timezone.spec.ts`
Expected: empty.

PowerShell, from the repo root:

```powershell
Get-ChildItem -Recurse apps/api/src/modules/trade-core -Filter *.ts | Select-String -Pattern '@Cron\(|@Interval\(' | ForEach-Object { "$($_.Path):$($_.LineNumber)" }
```

Expected: exactly one line, `…\trade-core\execution\mtf-interest.cron.ts:<n>`.

```powershell
Get-ChildItem -Recurse apps/api/src/modules/trade-core -Filter *.ts | Select-String -Pattern 'LIVE_TRADING_ENABLED|@td/shared'
```

Expected: no output.

```powershell
Get-ChildItem -Recurse apps/api/src/modules/trade-core/execution -Filter *.ts | Where-Object { $_.Name -notlike '*.spec.ts' -and $_.FullName -notlike '*\testing\*' } | Select-String -Pattern '\b(1000000|30000|0\.50|18\.00|23\.60)\b|\bslippageBps\s*[:=]\s*\d'
```

Expected: no output (D4: the values live in `core_paper_defaults` rows).

- [ ] **Step 5: Typecheck (compare lists, not counts)**

Never check `main` out over the branch. From the repo root, in PowerShell:

```powershell
$base = Join-Path $env:TEMP 'grw-m3-base'
git worktree add $base main
Push-Location apps/api; npx tsc --noEmit -p tsconfig.json 2>&1 | Select-String 'error TS' | ForEach-Object { $_.Line } | Sort-Object | Set-Content -Encoding utf8 (Join-Path $env:TEMP 'tsc-m3.txt'); Pop-Location
Push-Location $base; pnpm install --frozen-lockfile | Out-Null; Push-Location apps/api; npx prisma generate --schema ../../prisma/schema.prisma | Out-Null; npx tsc --noEmit -p tsconfig.json 2>&1 | Select-String 'error TS' | ForEach-Object { $_.Line } | Sort-Object | Set-Content -Encoding utf8 (Join-Path $env:TEMP 'tsc-main.txt'); Pop-Location; Pop-Location
Compare-Object (Get-Content (Join-Path $env:TEMP 'tsc-main.txt')) (Get-Content (Join-Path $env:TEMP 'tsc-m3.txt'))
git worktree remove --force $base
```

Expected: `Compare-Object` prints nothing (same error list: the pre-existing `@td/shared` moduleResolution class). A
line that differs only in the order of union members in a message is the same error. No line may name a
`trade-core`, `trade-sentinel/charges`, `audit-actions` or `tenant.constants` file.

- [ ] **Step 6: Record and commit**

Fill in the verification ledger row below (date, suite totals, typecheck, the Task 5 opt-in test and drift result),
then:

```bash
git add -- docs/superpowers/plans/2026-10-11-sp2-m3-execution.md
git commit -m "docs(plans): SP2 M3 verification results" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- docs/superpowers/plans/2026-10-11-sp2-m3-execution.md
```

---

## M3 production gate (after deploy, owner-run)

Production is the Vyom VPS (Postgres in `grw-postgres`, API in `grw-api`). The API deploy's `prisma migrate deploy`
applies `20261011120000_sp2_m3_execution` (expand-only: four new tables, no existing table touched). No env var is
added. Nothing trades: no code path calls the adapter before M5.

**Database:**

```bash
docker exec -i grw-postgres psql -U grw -d grw <<'SQL'
SELECT "key", "scope", "numValue"::text, "note" FROM core_paper_defaults ORDER BY "key", "scope";
-- want: 14 rows, the values of the "Seeded paper defaults" table
SELECT tgname FROM pg_trigger WHERE tgname IN ('core_fills_append_only', 'core_cash_ledger_append_only') ORDER BY tgname;
-- want: two rows
SELECT count(*) FROM core_orders;
-- want: 0 (ships dark)
SQL
```

**API (owner token):** `GET /api/trade-core/paper/defaults` lists the 14 rows; `PUT
/api/trade-core/paper/defaults/slippageBps/MTF` with `{ "value": 5, "reason": "reviewed, unchanged" }` answers the
row with your reason as its note and writes one `CORE_PAPER_DEFAULT_CHANGED` audit row; a non-owner gets 403.

**Kill switch:** pressing it shows `Core: 0 pending core order(s) cancelled; open core positions are exited by the
lifecycle (M4), none in M3 …` in the cascade (it was "no core orders or positions exist yet" in M2).

**Cron:** after 15:35 IST on the next weekday, `SELECT "jobName", status, "startedAt" FROM job_runs WHERE "jobName" =
'core-mtf-interest' ORDER BY "startedAt" DESC LIMIT 1;` shows one `SUCCESS`, and `docker logs grw-api 2>&1 | grep
'MTF interest'` shows `0 open holding(s), 0 day row(s) posted`.

**Revert path:** revert the code commits. The tables, triggers and default rows stay (expand-only, inert with no
code reading them).

M3 is complete when this gate is observed in production, not when the tests pass (parent spec rule).

## Deviations from the spec

1. **The interface takes `userId` on `cancel`, `modify` and `getOrder`** (spec §4.2 vs parent §3 tenant scoping;
   ruling 1).
2. **`CoreOrderRequest.refPrice` is added** (spec §4.4 needs a reference price for a MARKET order; ruling 2).
3. **One more file than §4.1 lists, `paper-ledger.service.ts`**, which owns every write so the adapter and the matcher
   share it without a cycle (ruling 3); and two port classes, `paper-risk-state.provider.ts` and
   `paper-order-square-off.ts` (§4.7 says what they do, not where they live).
4. **MTF interest uniqueness is a plain unique index plus a CHECK**, equivalent to §4.5's "unique where type =
   MTF_INTEREST" (ruling 9).
5. **`core_orders.underlying`** is stored (the `maxLotsPerOrder` key needs it after a restart), and
   `core_fills.price` / `core_orders.avgFillPrice` are `Decimal(14,4)` (a depth-walk average is not a paisa amount).
6. **Placement rejects out of session and, for entries, while the kill switch is on** (ruling 7): stricter than §4.3.
7. **`maxLotsPerOrder` accepts any upper-case underlying as its scope** so stock options can be configured without a
   migration; only the five index rows are seeded (E4).
8. **"Isolation: no file outside `trade-core/` changes except `charges.ts` and module wiring"** is read, as in M2, to
   include `schema.prisma`, the migration, `tenant.constants.ts` and `audit-actions.ts`; Task 14 Step 4 lists them
   exactly.

## Notes for later milestones (not in this plan)

- **M4** binds `openPnl` and `priced` in `PaperRiskStateProvider` from hub marks (then entries can pass the wall),
  tags positions with their strategy (`strategyId`, `pnlTodayByStrategy`), and extends `PaperOrderSquareOff` to place
  EXIT orders for every open core position (`exitsRequested`). M4 places exits with `purpose: 'EXIT'` and the
  closing side; `validateOrder` already refuses over-exits.
- **M5** builds `CoreOrderRequest` from an ALLOW/RESIZE verdict (`idempotencyKey = intentId + ':entry'`), injects
  `CORE_EXECUTION_ADAPTER`, adds `'core-mtf-interest'` to `EXPECTED_JOBS` (`health-detail.service.ts:25`), and its
  15:45 reconciliation checks that every open MTF holding has an `MTF_INTEREST` row for the day. M5's paper defaults
  UI calls the Task 7 routes.
- **Multi-tenant hub:** when `hubFor` serves other users their own hub, nothing in M3 changes (the matcher subscribes
  per hub); until then only the owner's orders fill (ruling 13).
- **Request context:** the adapter is built for background callers (M5's fan-out runs with no tenant context). Called
  inside a non-admin request, the tenant extension also scopes `findByKey`, so a key already used by another user
  surfaces as the database's unique-violation error instead of a 409 — still never that user's order.
- **SP7** binds a live adapter to `CORE_EXECUTION_ADAPTER`; `LIVE_TRADING_ENABLED` stays false until then.

## Owner questions (each has a safe default already in the plan)

1. **SENSEX options trade on BFO**, which is not a core venue (`VEHICLE_EXCHANGES.OPTIONS_BUY = ['NFO']`, M2). The
   `maxLotsPerOrder@SENSEX` row is seeded but inert. Add BFO as an options venue (a one-line M2 venue change plus
   its session check)? Default: no, NFO only.
2. **Review every placeholder in "Seeded paper defaults"** against Angel One's current MTF rate, funded share and
   pledge charge, and choose the per-order lot caps; they are editable at any time without a deploy.
3. **MTF interest days:** the plan charges the opening day and every calendar day the holding is open at 15:35 IST;
   a holding sold before 15:35 is not charged for its exit day. Default: as planned (owner-adjustable later as a rule
   change, not a value).
4. **Charges per fill:** a partly filled order pays brokerage on each fill (conservative); the MTF pledge fee is paid
   once per buy order. Default: as planned.
5. **Only the owner's orders can fill** until the hub serves other users (ruling 13); other users' orders are
   rejected "no fresh price". Default: accept (M3 ships dark).

## Self-review

- **Spec coverage:** §4.1 layout (Tasks 2–13, ruling 3 for the extra files); §4.2 interface and request (Task 2,
  Task 11; rulings 1–2); §4.3 freshness and after-submission (Task 4, Task 10), noPriceRejectMs (Task 10), MARKET
  depth walk / partial / slippage (Task 4), LIMIT strict trade-through E3 (Task 4, Task 11), SL_MARKET trigger and gap
  (Task 4), lot multiple and max lots E4 with fail-closed missing setting (Task 4, Task 9 modify), vehicle side rules
  (Task 4); §4.4 ledger entry types and signs (Tasks 3, 5), lazy DEPOSIT E1 (Task 8), margin per vehicle E2 and MTF
  funded share (Task 3), block at placement / true-up per fill / release on cancel and reject / proportional on exit
  (Tasks 8–9, ruling 4), insufficient free cash (Task 8, Task 11), per-leg charges by vehicle with the MTF pledge fee
  (Tasks 1, 9), gross realised P&L with separate charge rows (Task 9), MTF interest at 15:35 IST, per calendar day,
  idempotent catch-up (Tasks 3, 12); §4.5 four tables, append-only triggers, CHECKs, seed with "default — please
  review" (Task 5), owner-only audited editing (Task 7); §4.6 approach A matcher (Task 10); §4.7 ports (Task 13); §5
  fail closed, idempotency, transactions, one cron with timeZone (Tasks 6, 8–12, Task 14 Step 4); §6 pure tests
  (Tasks 1–4), adapter per vehicle (Task 11), idempotency (Tasks 8, 11), restart (Task 10), MTF interest (Task 12),
  tenant (Task 14), isolation (Task 14 Step 4), golden charges (Task 1).
- **Placeholder scan:** every code step has the full code; every test step names its command and expected result;
  no TBD/TODO.
- **Type consistency:** `CoreOrderRequest`, `CoreOrder`, `CoreOrderPatch`, `CorePositionView`, `CoreFunds`,
  `FillCharges`, `PaperSettings`, `PaperSettingsResult`, `LedgerEntry`, `NewLedgerRow`, `FillRow`, `NewFillRow`,
  `NewOrderRow`, `OrderUpdate`, `PaperDb`, `PlaceContext`, `PlaceResult`, `PositionContext`, `FillInput` are named
  the same in every task; `place(req, ctx, now)`, `close(userId, orderId, event, reason)`, `applyFill(userId, orderId,
  expectFilledQty, fill, now)`, `track(order, noPriceRejectMs, now)`, `onPrice(hub, p, now)`, `sweep(now)` match
  between producers and consumers; `marginFor(vehicle, notional, s)`, `proportionalRelease(held, qty, ofQty)`,
  `decideFill(order, p, now, slippageBps)` likewise.
- **Review Focus tests are in their owning tasks:** 1 → Task 4; 2 → Tasks 4 and 10; 3 → Tasks 3, 9, 11; 4 → Task 10;
  5 → Tasks 3 and 12.

## Verification ledger

| Date | Whole suite (API) | Typecheck (error lists) | Opt-in DB test + drift | Notes |
|---|---|---|---|---|
| 2026-10-11 | 303 suites (302 pass), 3892 tests (3891 pass); the 1 failure is the pre-existing Windows path-separator case in `sentinel-cycle.service.spec.ts` ("cannot reach anything that places an order"); all 18 M3 suites + `trade-core.module.spec` pass; `execution-tenant` 7 tests | pending: controller runs the tsc list comparison in the coordinated window (shared Prisma client lacks M3 models) | pending: controller runs the opt-in DB test + drift check in the coordinated window | Step 4: one cron (`mtf-interest.cron.ts:27`, specs excluded per ruling P1); no `LIVE_TRADING_ENABLED`/`@td/shared` in trade-core; no hard-coded default literals; files outside trade-core since 17058f1 = exactly the permitted list; `cron-timezone.spec.ts` untouched |
