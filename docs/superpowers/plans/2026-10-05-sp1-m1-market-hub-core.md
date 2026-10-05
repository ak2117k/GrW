# SP1 · M1 — Market Hub Core (shadow) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Scope:** migration step **M1 only** of the SP1 spec — the hub core running in **shadow** (no existing
consumer switches). M2 (CandleStore), M3 (positions), M4 (browser), M5 (option chain/OI) and M6
(remaining consumers + deletion of the old stack) each get their own plan later.

**Goal:** Build `apps/api/src/modules/market-hub/` — SessionClock, PriceBook, WatchRegistry + slot
allocator, Governor, QuoteBatcher, a broker seam over the owner's existing per-user session,
LiveFeed, QuotePoller, the `MarketHubService` facade, `/healthz/detail` metrics, and the "only door"
architecture test — all behind `MARKET_HUB_ENABLED` (default `false`).

**Architecture:** Pure units (clock, book, registry, allocator, governor, batcher) are plain classes
tested with Jest fake timers and no SmartAPI. A `HubBroker` seam is implemented by
`ManagerHubBroker`, which **shares the owner's existing `UserFeedManager` session** through new
`pin`/`unpin` methods (a second Angel One login on the same client code kills the live feed — see
`trade-tracker.service.ts` `snapshotBook`). `HubEngine` wires the units; `MarketHubService` is the thin
NestJS wrapper that starts the engine without blocking boot.

**Tech Stack:** NestJS 10, TypeScript 5.7, Jest 29 (`ts-jest`, `isolatedModules`), pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-10-05-sp1-market-data-hub-design.md` (parent:
`docs/superpowers/specs/2026-09-30-ai-trading-core-architecture-design.md`)

**Test command (all tasks):** `pnpm --filter @td/api test -- <file-pattern>` — Jest `rootDir` is
`apps/api/src`, `testRegex` is `.*\.spec\.ts$`. Example:
`pnpm --filter @td/api test -- session-clock.spec`.

## Global Constraints

- The hub is the **only** component meant to request market data from Angel One; in M1 it runs in
  shadow and **no existing consumer switches** to it.
- **No shared "feed account".** The hub runs on the owner's per-user session (`HUB_OWNER_USER_ID`),
  shared with the browser feed through `UserFeedManager` — never a second login.
- Flag `MARKET_HUB_ENABLED`, default **false**. Disabled ⇒ zero broker calls from the hub.
- **2 GB host:** no new processes; every cache bounded (PriceBook ≤ 5000 entries, wait/latency
  samples ≤ 200, call/throttle timestamps pruned to 1 h).
- **Boot must not block:** nothing in `onModuleInit` awaits the network (repo rule from commits
  `d176a33`, `4422bf6`, `1fe709b`).
- Governor budgets (configurable): quote **5/s**, `getCandleData` **2.5/s**, `searchScrip` **0.8/s**,
  `optionGreek` **0.8/s**. Lanes: 0 Critical · 1 Interactive (deadline ~5 s → `busy`) · 2 Routine ·
  3 Background (only when lanes 0–2 are empty; during market hours ≤ 1 request / 5 s).
- Quote batching: **150 ms** window, **≤ 50 symbols per call**, grouped by exchange by the broker call.
- Throttle back-off per endpoint **1 s → 2 s → 4 s … cap 30 s**, surfaced as an explicit
  `Throttled { retryAfterMs }` — **never `[]` / empty map**.
- Every instrument is `{ exchange, token, symbol }`; keys are `EXCHANGE:token` (never token alone).
- PriceBook result is exactly one of `fresh | market-closed | stale | unavailable(reason)`.
- Price `at` = **receipt time** (when the hub learned the price is current), not the exchange's
  last-trade time.
- All session times are evaluated in **Asia/Kolkata**.
- Commits use explicit pathspecs (`git commit -- <paths>`), never bare `git commit` / `-a`.

## Review Focus

1. **A second Angel One login on the owner's account** would kill the browser's live feed — the hub must
   reuse the `UserFeedManager` session (`pin`), never build its own. (Task 6 test "pin on an existing
   user reuses the one session"; Task 7 `ManagerHubBroker` has no session factory at all.)
2. **The owner closes the browser tab** (`releaseUser`) — the hub's subscriptions must survive and the
   session must not idle-teardown. (Task 6 test "pins survive releaseUser and block idle teardown".)
3. **The same numeric token on two exchanges** (e.g. an MCX contract and an NSE stock) — must stay two
   keys, two subscriptions, two batches. (Task 5 `chunkRefs` test; Task 6 session key test.)
4. **A throttled quote call** must surface as `throttled`, not as "no prices". (Task 6
   `throwOnThrottle` test; Task 5 throttled-outcome test.)
5. **Hub enabled but owner unset, or the broker never answers at boot** — the API must still bind its
   port, and `/healthz/detail` must say why the hub is idle. (Task 10 tests "onModuleInit returns
   without awaiting the broker" and "enabled without an owner reports a reason".)

---

## File Structure

| Path | Responsibility |
|---|---|
| `market-hub/hub.types.ts` | `InstrumentRef`, `refKey`, `Priority`, `Lane`/`LANE`, `Endpoint`, `Price`, `PriceResult` |
| `market-hub/session-clock.ts` | Hours, pre-open, holidays, MCX late-close ranges, `nextOpen`, calendar gap |
| `market-hub/price-book.ts` | The one bounded price cache + result kinds |
| `market-hub/watch-registry.ts` | Who watches what, effective priority, TTL expiry |
| `market-hub/slot-allocator.ts` | Pure priority allocation of live slots |
| `market-hub/governor.ts` | Lanes, per-endpoint budgets, coalescing, deadlines, back-off, metrics |
| `market-hub/quote-batcher.ts` | 150 ms window, ≤ 50 per call, no duplicate token per call |
| `market-hub/hub-broker.ts` | `HubBroker` seam + `ManagerHubBroker` over `UserFeedManager` |
| `market-hub/testing/fake-broker.ts` | `FakeBroker` for tests |
| `market-hub/live-feed.ts` | Allocation → (un)subscribe; ticks → PriceBook |
| `market-hub/quote-poller.ts` | Near-live polling + WS-down critical polling |
| `market-hub/hub-engine.ts` | Wires the units; default watch set; status snapshot |
| `market-hub/market-hub.service.ts` | Nest facade; config; non-blocking start; position refresh |
| `market-hub/market-hub.module.ts` | Module wiring |
| `market-hub/only-door.spec.ts` | Architecture ratchet |
| Modify `market-data/services/user-feed-session.ts`, `user-feed.types.ts`, `user-feed-manager.service.ts` | NFO/BFO, exchange-keyed tokens, tick exchange, `throwOnThrottle`, `pin`/`unpin`, multi-listeners |
| Modify `common/interfaces/broker-adapter.interface.ts` | `TickData.exchange?` |
| Modify `market-data/services/market-holidays.service.ts` | export `MARKET_HOLIDAYS` |
| Modify `config/configuration.ts`, `app.module.ts`, `health/*`, `deploy/env/api.env.example` | flags, registration, `hub` signal, env keys |

All `market-hub/…` paths are under `apps/api/src/modules/`.

---

### Task 1: SessionClock

**Files:**
- Modify: `apps/api/src/modules/market-data/services/market-holidays.service.ts` (export the year map)
- Create: `apps/api/src/modules/market-hub/session-clock.ts`
- Test: `apps/api/src/modules/market-hub/session-clock.spec.ts`

**Interfaces:**
- Consumes: `sessionFor`, `SessionWindow` from `trade-sentinel/market-sessions.ts` (pure); `MarketHoliday` type.
- Produces: `class SessionClock` with `isTradingDay(ex, at?)`, `phase(ex, at?): SessionPhase`, `isOpen(ex, at?)`, `minutesToClose(ex, at?): number | null`, `nextOpen(ex, at?): Date | null`, `hasCalendarFor(year)`, `calendarGap(at?): number | null`; `type SessionPhase = 'pre-open' | 'open' | 'closed'`; `interface DateRange { from: string; to: string }`; `export const MARKET_HOLIDAYS`.

- [ ] **Step 1: Export the holiday table**

In `market-holidays.service.ts`, directly below the `HOLIDAYS_2026` array, add:

```ts
/**
 * Holiday lists by calendar year. The market hub's SessionClock reads this;
 * a year missing here is reported by `SessionClock.calendarGap` (and alerted
 * every December) instead of silently treating every day as a trading day.
 */
export const MARKET_HOLIDAYS: Readonly<Record<number, readonly MarketHoliday[]>> = {
  2026: HOLIDAYS_2026,
};
```

- [ ] **Step 2: Write the failing test**

`session-clock.spec.ts`:

```ts
import { SessionClock } from './session-clock';
import { MARKET_HOLIDAYS } from '../market-data/services/market-holidays.service';

// IST = UTC+5:30. Helper: build a UTC Date from an IST wall-clock time.
const ist = (isoLocal: string) => new Date(new Date(`${isoLocal}Z`).getTime() - 5.5 * 3600_000);

const clock = new SessionClock({ holidays: MARKET_HOLIDAYS });

describe('SessionClock', () => {
  it('opens NSE at 09:15 and closes it at 15:30 IST on a weekday', () => {
    expect(clock.phase('NSE', ist('2026-10-07T09:14:59'))).toBe('closed');
    expect(clock.phase('NSE', ist('2026-10-07T09:15:00'))).toBe('open');
    expect(clock.phase('NSE', ist('2026-10-07T15:29:59'))).toBe('open');
    expect(clock.phase('NSE', ist('2026-10-07T15:30:00'))).toBe('closed');
  });

  it('reports pre-open 09:00–09:08 for cash NSE/BSE only', () => {
    const t = ist('2026-10-07T09:05:00');
    expect(clock.phase('NSE', t)).toBe('pre-open');
    expect(clock.phase('BSE', t)).toBe('pre-open');
    expect(clock.phase('NFO', t)).toBe('closed');
    expect(clock.phase('MCX', t)).toBe('open'); // MCX opens 09:00
  });

  it('is closed on weekends and on listed holidays', () => {
    expect(clock.isOpen('NSE', ist('2026-10-10T10:00:00'))).toBe(false); // Saturday
    expect(clock.isTradingDay('NSE', ist('2026-10-20T10:00:00'))).toBe(false); // Dussehra
    expect(clock.isOpen('MCX', ist('2026-10-20T19:00:00'))).toBe(false);
  });

  it('treats BFO holidays as BSE holidays', () => {
    expect(clock.isTradingDay('BFO', ist('2026-10-20T10:00:00'))).toBe(false);
  });

  it('closes MCX at 23:30 unless the date is in a configured late-close range', () => {
    const t = ist('2026-11-12T23:40:00'); // Thursday
    expect(clock.isOpen('MCX', t)).toBe(false);
    const late = new SessionClock({
      holidays: MARKET_HOLIDAYS,
      mcxLateClose: [{ from: '2026-11-02', to: '2027-03-08' }],
    });
    expect(late.isOpen('MCX', t)).toBe(true);
    expect(late.minutesToClose('MCX', t)).toBe(15);
  });

  it('gives minutes to close only while open', () => {
    expect(clock.minutesToClose('NSE', ist('2026-10-07T15:00:00'))).toBe(30);
    expect(clock.minutesToClose('NSE', ist('2026-10-07T16:00:00'))).toBeNull();
  });

  it('finds the next open across a weekend and a holiday', () => {
    expect(clock.nextOpen('NSE', ist('2026-10-16T16:00:00'))?.toISOString()).toBe(
      ist('2026-10-19T09:15:00').toISOString(),
    );
    expect(clock.nextOpen('NSE', ist('2026-10-19T16:00:00'))?.toISOString()).toBe(
      ist('2026-10-21T09:15:00').toISOString(), // 20th is Dussehra
    );
  });

  it('reports a missing holiday calendar: this year always, next year from December', () => {
    expect(clock.calendarGap(ist('2026-10-07T10:00:00'))).toBeNull();
    expect(clock.calendarGap(ist('2026-12-02T10:00:00'))).toBe(2027);
    expect(clock.calendarGap(ist('2027-01-05T10:00:00'))).toBe(2027);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @td/api test -- session-clock.spec`
Expected: FAIL — `Cannot find module './session-clock'`.

- [ ] **Step 4: Write the implementation**

`session-clock.ts`:

```ts
import { sessionFor, type SessionWindow } from '../trade-sentinel/market-sessions';
import type { MarketHoliday } from '../market-data/services/market-holidays.service';

/**
 * The ONE answer to "is this exchange trading?" for the market hub.
 *
 * Builds on the pure, tested windows in trade-sentinel/market-sessions.ts and
 * adds what they deliberately leave out: holidays, the NSE/BSE pre-open, and
 * MCX's late close during the US-DST-linked window. A missing holiday list is
 * reported (calendarGap) rather than silently treating every day as trading.
 */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const PRE_OPEN: SessionWindow = { openMin: 9 * 60, closeMin: 9 * 60 + 8 };
const PRE_OPEN_VENUES = new Set(['NSE', 'BSE']);
const MCX_LATE_CLOSE_MIN = 23 * 60 + 55;

export type SessionPhase = 'pre-open' | 'open' | 'closed';
/** Inclusive IST calendar dates, YYYY-MM-DD. */
export interface DateRange {
  from: string;
  to: string;
}
export interface SessionClockOptions {
  holidays: Readonly<Record<number, readonly MarketHoliday[]>>;
  mcxLateClose?: readonly DateRange[];
}

interface IstParts {
  ymd: string;
  year: number;
  month: number;
  day: number;
  minutes: number;
}

function istParts(at: Date): IstParts {
  const d = new Date(at.getTime() + IST_OFFSET_MS);
  return {
    ymd: d.toISOString().slice(0, 10),
    year: d.getUTCFullYear(),
    month: d.getUTCMonth(),
    day: d.getUTCDay(),
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
  };
}

/** UTC instant of IST midnight `plusDays` after `at`'s IST date. */
function istMidnight(at: Date, plusDays: number): Date {
  const d = new Date(at.getTime() + IST_OFFSET_MS);
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + plusDays) - IST_OFFSET_MS,
  );
}

/** Holiday lists name NSE/BSE/MCX/NFO; BFO follows BSE. */
function holidayExchange(exchange: string): string {
  const ex = exchange.toUpperCase();
  return ex === 'BFO' ? 'BSE' : ex;
}

export class SessionClock {
  constructor(private readonly opts: SessionClockOptions) {}

  isTradingDay(exchange: string, at: Date = new Date()): boolean {
    const { ymd, year, day } = istParts(at);
    if (day === 0 || day === 6) return false;
    const ex = holidayExchange(exchange);
    const list = this.opts.holidays[year] ?? [];
    return !list.some((h) => h.date === ymd && (h.exchanges as readonly string[]).includes(ex));
  }

  phase(exchange: string, at: Date = new Date()): SessionPhase {
    if (!this.isTradingDay(exchange, at)) return 'closed';
    const { minutes } = istParts(at);
    const w = this.window(exchange, at);
    if (minutes >= w.openMin && minutes < w.closeMin) return 'open';
    if (
      PRE_OPEN_VENUES.has(exchange.toUpperCase()) &&
      minutes >= PRE_OPEN.openMin &&
      minutes < PRE_OPEN.closeMin
    ) {
      return 'pre-open';
    }
    return 'closed';
  }

  isOpen(exchange: string, at: Date = new Date()): boolean {
    return this.phase(exchange, at) === 'open';
  }

  minutesToClose(exchange: string, at: Date = new Date()): number | null {
    if (!this.isOpen(exchange, at)) return null;
    return this.window(exchange, at).closeMin - istParts(at).minutes;
  }

  /** Next session open strictly after `at`, searching 14 days ahead. */
  nextOpen(exchange: string, at: Date = new Date()): Date | null {
    for (let d = 0; d <= 14; d++) {
      const midnight = istMidnight(at, d);
      const open = new Date(midnight.getTime() + this.window(exchange, midnight).openMin * 60_000);
      if (open.getTime() > at.getTime() && this.isTradingDay(exchange, open)) return open;
    }
    return null;
  }

  hasCalendarFor(year: number): boolean {
    return (this.opts.holidays[year]?.length ?? 0) > 0;
  }

  /** The year whose holiday list is missing and needed now, or null. */
  calendarGap(at: Date = new Date()): number | null {
    const { year, month } = istParts(at);
    if (!this.hasCalendarFor(year)) return year;
    if (month === 11 && !this.hasCalendarFor(year + 1)) return year + 1;
    return null;
  }

  private window(exchange: string, at: Date): SessionWindow {
    const base = sessionFor(exchange);
    if (exchange.toUpperCase() !== 'MCX') return base;
    const { ymd } = istParts(at);
    const late = (this.opts.mcxLateClose ?? []).some((r) => ymd >= r.from && ymd <= r.to);
    return late ? { openMin: base.openMin, closeMin: MCX_LATE_CLOSE_MIN } : base;
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @td/api test -- session-clock.spec`
Expected: PASS, 8 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/market-hub/session-clock.ts apps/api/src/modules/market-hub/session-clock.spec.ts apps/api/src/modules/market-data/services/market-holidays.service.ts
git commit -m "feat(market-hub): one session clock with holidays, pre-open and MCX late close" -- apps/api/src/modules/market-hub/session-clock.ts apps/api/src/modules/market-hub/session-clock.spec.ts apps/api/src/modules/market-data/services/market-holidays.service.ts
```

---

### Task 2: Hub types and PriceBook

**Files:**
- Create: `apps/api/src/modules/market-hub/hub.types.ts`
- Create: `apps/api/src/modules/market-hub/price-book.ts`
- Test: `apps/api/src/modules/market-hub/price-book.spec.ts`

**Interfaces:**
- Produces: `HubExchange`, `InstrumentRef`, `refKey(ref)`, `Priority` (0–4), `Lane` + `LANE`, `Endpoint`, `Price`, `UnavailableReason`, `PriceResult`; `class PriceBook(maxEntries = 5000)` with `set(price)`, `markFailure(key, 'throttled' | 'no-session')`, `ageMs(key, now): number | undefined`, `get(ref, { maxAgeMs, now, isOpen, watched }): PriceResult`, `size()`.

- [ ] **Step 1: Write the types**

`hub.types.ts`:

```ts
/** Exchanges the hub speaks, as Angel One names them in REST calls. */
export type HubExchange = 'NSE' | 'BSE' | 'NFO' | 'BFO' | 'MCX';

export interface InstrumentRef {
  exchange: HubExchange;
  token: string;
  symbol: string;
}

/** EXCHANGE:token — never the token alone (tokens collide across exchanges). */
export function refKey(ref: Pick<InstrumentRef, 'exchange' | 'token'>): string {
  return `${ref.exchange}:${ref.token}`;
}

/** 0 open-position contract · 1 its underlying · 2 market context · 3 candidates/watchlist · 4 viewed chart */
export type Priority = 0 | 1 | 2 | 3 | 4;

export const LANE = { CRITICAL: 0, INTERACTIVE: 1, ROUTINE: 2, BACKGROUND: 3 } as const;
export type Lane = (typeof LANE)[keyof typeof LANE];

export type Endpoint = 'quote' | 'candles' | 'search' | 'greek';

export interface Price {
  ref: InstrumentRef;
  ltp: number;
  /** Receipt time (ms epoch): when the hub learned this price is current. */
  at: number;
  source: 'ws' | 'quote' | 'db';
  volume?: number;
  oi?: number;
}

export type UnavailableReason = 'not-watched' | 'never-priced' | 'throttled' | 'no-session';

export type PriceResult =
  | { kind: 'fresh'; price: Price }
  | { kind: 'market-closed'; price: Price }
  | { kind: 'stale'; price: Price; ageMs: number }
  | { kind: 'unavailable'; reason: UnavailableReason };
```

- [ ] **Step 2: Write the failing test**

`price-book.spec.ts`:

```ts
import { PriceBook } from './price-book';
import type { InstrumentRef } from './hub.types';

const A: InstrumentRef = { exchange: 'NSE', token: '1', symbol: 'A' };
const B: InstrumentRef = { exchange: 'NSE', token: '2', symbol: 'B' };
const C: InstrumentRef = { exchange: 'MCX', token: '1', symbol: 'C' }; // same token as A, other exchange
const open = () => true;
const closed = () => false;
const yes = () => true;
const no = () => false;

describe('PriceBook', () => {
  it('returns fresh within maxAge and stale (with age) beyond it', () => {
    const book = new PriceBook();
    book.set({ ref: A, ltp: 10, at: 1000, source: 'ws' });
    expect(book.get(A, { maxAgeMs: 5000, now: 4000, isOpen: open, watched: yes }).kind).toBe('fresh');
    expect(book.get(A, { maxAgeMs: 5000, now: 7000, isOpen: open, watched: yes })).toEqual({
      kind: 'stale',
      price: { ref: A, ltp: 10, at: 1000, source: 'ws' },
      ageMs: 6000,
    });
  });

  it('labels an old price as market-closed when the exchange is shut', () => {
    const book = new PriceBook();
    book.set({ ref: A, ltp: 10, at: 0, source: 'quote' });
    expect(book.get(A, { maxAgeMs: 5000, now: 40_000_000, isOpen: closed, watched: yes }).kind).toBe(
      'market-closed',
    );
  });

  it('distinguishes not-watched, never-priced and a recorded failure', () => {
    const book = new PriceBook();
    expect(book.get(A, { maxAgeMs: 1, now: 0, isOpen: open, watched: no })).toEqual({
      kind: 'unavailable',
      reason: 'not-watched',
    });
    expect(book.get(A, { maxAgeMs: 1, now: 0, isOpen: open, watched: yes })).toEqual({
      kind: 'unavailable',
      reason: 'never-priced',
    });
    book.markFailure('NSE:1', 'throttled');
    expect(book.get(A, { maxAgeMs: 1, now: 0, isOpen: open, watched: yes })).toEqual({
      kind: 'unavailable',
      reason: 'throttled',
    });
  });

  it('keeps the same token on two exchanges apart', () => {
    const book = new PriceBook();
    book.set({ ref: A, ltp: 10, at: 0, source: 'ws' });
    expect(book.get(C, { maxAgeMs: 10, now: 0, isOpen: open, watched: yes }).kind).toBe('unavailable');
  });

  it('is bounded: evicts the least recently set entry', () => {
    const book = new PriceBook(2);
    book.set({ ref: A, ltp: 1, at: 0, source: 'ws' });
    book.set({ ref: B, ltp: 2, at: 0, source: 'ws' });
    book.set({ ref: C, ltp: 3, at: 0, source: 'ws' });
    expect(book.size()).toBe(2);
    expect(book.ageMs('NSE:1', 0)).toBeUndefined();
    expect(book.ageMs('MCX:1', 5)).toBe(5);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @td/api test -- price-book.spec`
Expected: FAIL — `Cannot find module './price-book'`.

- [ ] **Step 4: Write the implementation**

`price-book.ts`:

```ts
import { refKey, type InstrumentRef, type Price, type PriceResult } from './hub.types';

export interface PriceQuery {
  maxAgeMs: number;
  now: number;
  isOpen: (exchange: string) => boolean;
  watched: (key: string) => boolean;
}

/**
 * The hub's one price cache. It never hands out an old price as if it were
 * current: every answer is fresh, market-closed, stale-with-age, or
 * unavailable-with-reason. Bounded (insertion-ordered Map as an LRU-by-write).
 */
export class PriceBook {
  private readonly prices = new Map<string, Price>();
  private readonly failures = new Map<string, 'throttled' | 'no-session'>();

  constructor(private readonly maxEntries = 5000) {}

  set(price: Price): void {
    const key = refKey(price.ref);
    this.prices.delete(key);
    this.prices.set(key, price);
    this.failures.delete(key);
    while (this.prices.size > this.maxEntries) {
      const oldest = this.prices.keys().next().value as string;
      this.prices.delete(oldest);
    }
  }

  markFailure(key: string, reason: 'throttled' | 'no-session'): void {
    this.failures.set(key, reason);
    if (this.failures.size > this.maxEntries) {
      this.failures.delete(this.failures.keys().next().value as string);
    }
  }

  ageMs(key: string, now: number): number | undefined {
    const p = this.prices.get(key);
    return p ? now - p.at : undefined;
  }

  size(): number {
    return this.prices.size;
  }

  get(ref: InstrumentRef, q: PriceQuery): PriceResult {
    const key = refKey(ref);
    const price = this.prices.get(key);
    if (!price) {
      const failure = this.failures.get(key);
      if (failure) return { kind: 'unavailable', reason: failure };
      return { kind: 'unavailable', reason: q.watched(key) ? 'never-priced' : 'not-watched' };
    }
    if (!q.isOpen(ref.exchange)) return { kind: 'market-closed', price };
    const ageMs = q.now - price.at;
    return ageMs <= q.maxAgeMs ? { kind: 'fresh', price } : { kind: 'stale', price, ageMs };
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @td/api test -- price-book.spec`
Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/market-hub/hub.types.ts apps/api/src/modules/market-hub/price-book.ts apps/api/src/modules/market-hub/price-book.spec.ts
git commit -m "feat(market-hub): price book that never serves an unlabelled stale price" -- apps/api/src/modules/market-hub/hub.types.ts apps/api/src/modules/market-hub/price-book.ts apps/api/src/modules/market-hub/price-book.spec.ts
```

---

### Task 3: WatchRegistry and slot allocator

**Files:**
- Create: `apps/api/src/modules/market-hub/watch-registry.ts`
- Create: `apps/api/src/modules/market-hub/slot-allocator.ts`
- Test: `apps/api/src/modules/market-hub/watch-registry.spec.ts`

**Interfaces:**
- Consumes: `InstrumentRef`, `refKey`, `Priority` (Task 2).
- Produces: `interface WatchEntry { ref; priority: Priority; firstAt: number }`; `class WatchRegistry` with `watch(ref, priority, owner, now, ttlMs?)`, `unwatch(ref, owner)`, `expire(now): boolean`, `has(key)`, `entries(): WatchEntry[]`, `size()`; `interface Allocation { live; nearLive; criticalOverflow: WatchEntry[]; demoted: number }`; `allocateSlots(entries, cap): Allocation`.

- [ ] **Step 1: Write the failing test**

`watch-registry.spec.ts`:

```ts
import { WatchRegistry } from './watch-registry';
import { allocateSlots } from './slot-allocator';
import type { InstrumentRef } from './hub.types';

const ref = (token: string, exchange: InstrumentRef['exchange'] = 'NSE'): InstrumentRef => ({
  exchange,
  token,
  symbol: `S${token}`,
});

describe('WatchRegistry', () => {
  it('uses the most urgent priority across owners', () => {
    const reg = new WatchRegistry();
    reg.watch(ref('1'), 3, 'ui', 0, 120_000);
    reg.watch(ref('1'), 0, 'positions', 0);
    expect(reg.entries()[0].priority).toBe(0);
    reg.unwatch(ref('1'), 'positions');
    expect(reg.entries()[0].priority).toBe(3);
  });

  it('expires TTL watches and reports the change', () => {
    const reg = new WatchRegistry();
    reg.watch(ref('1'), 4, 'chart', 0, 120_000);
    reg.watch(ref('2'), 2, 'context', 0); // no TTL: never expires
    expect(reg.expire(119_999)).toBe(false);
    expect(reg.expire(120_001)).toBe(true);
    expect(reg.entries().map((e) => e.ref.token)).toEqual(['2']);
  });

  it('renewing a TTL watch keeps it alive', () => {
    const reg = new WatchRegistry();
    reg.watch(ref('1'), 4, 'chart', 0, 120_000);
    reg.watch(ref('1'), 4, 'chart', 100_000, 120_000);
    expect(reg.expire(150_000)).toBe(false);
  });
});

describe('allocateSlots', () => {
  it('gives live slots by priority, then first-watch time', () => {
    const reg = new WatchRegistry();
    reg.watch(ref('viewed'), 4, 'chart', 0);
    reg.watch(ref('pos'), 0, 'positions', 5);
    reg.watch(ref('nifty'), 2, 'context', 1);
    const a = allocateSlots(reg.entries(), 2);
    expect(a.live.map((e) => e.ref.token)).toEqual(['pos', 'nifty']);
    expect(a.nearLive.map((e) => e.ref.token)).toEqual(['viewed']);
    expect(a.demoted).toBe(1);
    expect(a.criticalOverflow).toEqual([]);
  });

  it('reports P0/P1 entries that did not fit as critical overflow', () => {
    const reg = new WatchRegistry();
    reg.watch(ref('pos'), 0, 'positions', 0);
    reg.watch(ref('und'), 1, 'positions', 0);
    const a = allocateSlots(reg.entries(), 1);
    expect(a.live.map((e) => e.ref.token)).toEqual(['pos']);
    expect(a.criticalOverflow.map((e) => e.ref.token)).toEqual(['und']);
  });

  it('keeps the same token on two exchanges as two entries', () => {
    const reg = new WatchRegistry();
    reg.watch(ref('1', 'NSE'), 3, 'w', 0);
    reg.watch(ref('1', 'MCX'), 3, 'w', 0);
    expect(allocateSlots(reg.entries(), 50).live).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @td/api test -- watch-registry.spec`
Expected: FAIL — `Cannot find module './watch-registry'`.

- [ ] **Step 3: Write the implementation**

`watch-registry.ts`:

```ts
import { refKey, type InstrumentRef, type Priority } from './hub.types';

export interface WatchEntry {
  ref: InstrumentRef;
  priority: Priority;
  firstAt: number;
}

interface Holder {
  priority: Priority;
  expiresAt: number | null;
}

interface Slot {
  ref: InstrumentRef;
  firstAt: number;
  holders: Map<string, Holder>;
}

/**
 * Who is interested in which instrument, and how urgently. A watch is a
 * declaration of interest; the hub decides how to serve it. Screen watches
 * carry a TTL so forgotten symbols stop costing broker calls.
 */
export class WatchRegistry {
  private readonly slots = new Map<string, Slot>();

  watch(ref: InstrumentRef, priority: Priority, owner: string, now: number, ttlMs?: number): void {
    const key = refKey(ref);
    let slot = this.slots.get(key);
    if (!slot) {
      slot = { ref, firstAt: now, holders: new Map() };
      this.slots.set(key, slot);
    }
    slot.holders.set(owner, { priority, expiresAt: ttlMs === undefined ? null : now + ttlMs });
  }

  unwatch(ref: InstrumentRef, owner: string): void {
    const key = refKey(ref);
    const slot = this.slots.get(key);
    if (!slot) return;
    slot.holders.delete(owner);
    if (slot.holders.size === 0) this.slots.delete(key);
  }

  /** Drop expired holders; true when anything changed. */
  expire(now: number): boolean {
    let changed = false;
    for (const [key, slot] of this.slots) {
      for (const [owner, h] of slot.holders) {
        if (h.expiresAt !== null && now > h.expiresAt) {
          slot.holders.delete(owner);
          changed = true;
        }
      }
      if (slot.holders.size === 0) this.slots.delete(key);
    }
    return changed;
  }

  has(key: string): boolean {
    return this.slots.has(key);
  }

  size(): number {
    return this.slots.size;
  }

  entries(): WatchEntry[] {
    return [...this.slots.values()].map((s) => ({
      ref: s.ref,
      firstAt: s.firstAt,
      priority: Math.min(...[...s.holders.values()].map((h) => h.priority)) as Priority,
    }));
  }
}
```

`slot-allocator.ts`:

```ts
import { refKey } from './hub.types';
import type { WatchEntry } from './watch-registry';

export interface Allocation {
  live: WatchEntry[];
  nearLive: WatchEntry[];
  /** P0/P1 entries that did not get a live slot: polled on the Critical lane. */
  criticalOverflow: WatchEntry[];
  demoted: number;
}

/** Live slots by priority, then first-watch time, then key — never first come first served. */
export function allocateSlots(entries: readonly WatchEntry[], cap: number): Allocation {
  const sorted = [...entries].sort(
    (a, b) =>
      a.priority - b.priority ||
      a.firstAt - b.firstAt ||
      refKey(a.ref).localeCompare(refKey(b.ref)),
  );
  const live = sorted.slice(0, Math.max(0, cap));
  const nearLive = sorted.slice(Math.max(0, cap));
  return {
    live,
    nearLive,
    criticalOverflow: nearLive.filter((e) => e.priority <= 1),
    demoted: nearLive.length,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @td/api test -- watch-registry.spec`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/market-hub/watch-registry.ts apps/api/src/modules/market-hub/slot-allocator.ts apps/api/src/modules/market-hub/watch-registry.spec.ts
git commit -m "feat(market-hub): watch registry with TTLs and priority slot allocation" -- apps/api/src/modules/market-hub/watch-registry.ts apps/api/src/modules/market-hub/slot-allocator.ts apps/api/src/modules/market-hub/watch-registry.spec.ts
```

---

### Task 4: Governor

**Files:**
- Create: `apps/api/src/modules/market-hub/governor.ts`
- Test: `apps/api/src/modules/market-hub/governor.spec.ts`

**Interfaces:**
- Consumes: `Endpoint`, `Lane`, `LANE` (Task 2); `AngelThrottleError` from `market-data/services/angel-throttle.ts` (tests only).
- Produces: `type GovResult<T>`; `interface GovRequest<T> { endpoint; lane; key?; deadlineMs?; run }`; `interface GovernorOptions`; `DEFAULT_RATES`; `class Governor` with `submit<T>(req): Promise<GovResult<T>>`, `metrics(now?): GovernorMetrics`, `dispose()`; `interface GovernorMetrics { lanes: {depth; waitP50Ms; waitP95Ms}[]; endpoints: Record<Endpoint, {callsLastMin; throttlesLastHour; backoffMs}> }`.

- [ ] **Step 1: Write the failing test**

`governor.spec.ts`:

```ts
import { DEFAULT_RATES, Governor, type GovernorOptions } from './governor';
import { LANE } from './hub.types';
import { AngelThrottleError } from '../market-data/services/angel-throttle';

function opts(over: Partial<GovernorOptions> = {}): GovernorOptions {
  return {
    ratesPerSec: DEFAULT_RATES,
    interactiveDeadlineMs: 5000,
    backgroundTrickleMs: 5000,
    maxBackoffMs: 30_000,
    isMarketHours: () => false,
    isThrottle: (e) => e instanceof AngelThrottleError,
    ...over,
  };
}

describe('Governor', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(0);
  });
  afterEach(() => jest.useRealTimers());

  it('spaces calls to one endpoint by its budget (quote 5/s → 200 ms)', async () => {
    const gov = new Governor(opts());
    const at: number[] = [];
    const run = async () => {
      at.push(Date.now());
      return 1;
    };
    const all = Promise.all([0, 1, 2].map(() => gov.submit({ endpoint: 'quote', lane: LANE.ROUTINE, run })));
    await jest.advanceTimersByTimeAsync(1000);
    await all;
    expect(at).toEqual([0, 200, 400]);
  });

  it('serves a higher lane first when the endpoint frees up', async () => {
    const gov = new Governor(opts());
    const order: string[] = [];
    const sub = (name: string, lane: 0 | 1 | 2 | 3) =>
      gov.submit({ endpoint: 'quote', lane, run: async () => void order.push(name) });
    const a = sub('first', LANE.ROUTINE);
    const b = sub('routine', LANE.ROUTINE);
    const c = sub('critical', LANE.CRITICAL);
    await jest.advanceTimersByTimeAsync(1000);
    await Promise.all([a, b, c]);
    expect(order).toEqual(['first', 'critical', 'routine']);
  });

  it('merges identical in-flight requests into one broker call', async () => {
    const gov = new Governor(opts());
    const run = jest.fn(async () => 42);
    const req = { endpoint: 'candles' as const, lane: LANE.INTERACTIVE, key: 'NSE:1:1m', run };
    const [x, y] = await Promise.all([gov.submit(req), gov.submit(req)]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(x).toEqual({ kind: 'ok', value: 42 });
    expect(y).toEqual({ kind: 'ok', value: 42 });
  });

  it('backs off a throttled endpoint 1 s, then 2 s, and reports Throttled', async () => {
    const gov = new Governor(opts());
    const at: number[] = [];
    let n = 0;
    const run = async () => {
      at.push(Date.now());
      n++;
      if (n <= 2) throw new AngelThrottleError('rate');
      return 'ok';
    };
    const req = { endpoint: 'candles' as const, lane: LANE.ROUTINE, run };
    expect(await gov.submit(req)).toEqual({ kind: 'throttled', retryAfterMs: 1000 });
    const p2 = gov.submit(req);
    await jest.advanceTimersByTimeAsync(999);
    expect(at).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(await p2).toEqual({ kind: 'throttled', retryAfterMs: 2000 });
    const p3 = gov.submit(req);
    await jest.advanceTimersByTimeAsync(2000);
    expect(await p3).toEqual({ kind: 'ok', value: 'ok' });
    expect(at).toEqual([0, 1000, 3000]);
  });

  it('caps back-off at maxBackoffMs', async () => {
    const gov = new Governor(opts({ maxBackoffMs: 3000 }));
    const run = async () => {
      throw new AngelThrottleError('rate');
    };
    const req = { endpoint: 'greek' as const, lane: LANE.ROUTINE, run };
    const results: unknown[] = [];
    for (let i = 0; i < 4; i++) {
      const p = gov.submit(req);
      await jest.advanceTimersByTimeAsync(5000);
      results.push(await p);
    }
    expect(results.map((r: any) => r.retryAfterMs)).toEqual([1000, 2000, 3000, 3000]);
  });

  it('gives up on an interactive request after its deadline with busy', async () => {
    const gov = new Governor(opts({ ratesPerSec: { ...DEFAULT_RATES, quote: 0.1 } }));
    const run = jest.fn(async () => 1);
    await gov.submit({ endpoint: 'quote', lane: LANE.ROUTINE, run }); // occupies 10 s
    const waiting = gov.submit({ endpoint: 'quote', lane: LANE.INTERACTIVE, run });
    await jest.advanceTimersByTimeAsync(5000);
    expect(await waiting).toEqual({ kind: 'busy' });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('runs background work only when lanes 0–2 are empty, and trickles it in market hours', async () => {
    const gov = new Governor(opts({ isMarketHours: () => true }));
    const at: Record<string, number> = {};
    const mark = (name: string) => async () => void (at[name] = Date.now());
    const r1 = gov.submit({ endpoint: 'quote', lane: LANE.ROUTINE, run: mark('r1') }); // runs at 0
    const r2 = gov.submit({ endpoint: 'quote', lane: LANE.ROUTINE, run: mark('r2') }); // waits to 200
    const bg1 = gov.submit({ endpoint: 'candles', lane: LANE.BACKGROUND, run: mark('bg1') });
    const bg2 = gov.submit({ endpoint: 'candles', lane: LANE.BACKGROUND, run: mark('bg2') });
    await jest.advanceTimersByTimeAsync(10_000);
    await Promise.all([r1, r2, bg1, bg2]);
    expect(at.r2).toBe(200);
    expect(at.bg1).toBe(200); // only after r2 left the queue
    expect(at.bg2).toBe(5200); // trickle: ≤ 1 per 5 s in market hours
  });

  it('returns other failures as error without backing off', async () => {
    const gov = new Governor(opts());
    const boom = new Error('boom');
    const res = await gov.submit({
      endpoint: 'search',
      lane: LANE.ROUTINE,
      run: async () => {
        throw boom;
      },
    });
    expect(res).toEqual({ kind: 'error', error: boom });
    expect(gov.metrics().endpoints.search.backoffMs).toBe(0);
  });

  it('reports lane depth, waits and endpoint counters', async () => {
    const gov = new Governor(opts());
    const run = async () => 1;
    const all = Promise.all([0, 1].map(() => gov.submit({ endpoint: 'quote', lane: LANE.ROUTINE, run })));
    expect(gov.metrics().lanes[LANE.ROUTINE].depth).toBe(1);
    await jest.advanceTimersByTimeAsync(500);
    await all;
    const m = gov.metrics();
    expect(m.endpoints.quote.callsLastMin).toBe(2);
    expect(m.lanes[LANE.ROUTINE].waitP95Ms).toBe(200);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @td/api test -- governor.spec`
Expected: FAIL — `Cannot find module './governor'`.

- [ ] **Step 3: Write the implementation**

`governor.ts`:

```ts
import type { Endpoint, Lane } from './hub.types';

export type GovResult<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'throttled'; retryAfterMs: number }
  | { kind: 'busy' }
  | { kind: 'error'; error: unknown };

export interface GovRequest<T> {
  endpoint: Endpoint;
  lane: Lane;
  /** Identical keys in flight are merged into one broker call. */
  key?: string;
  /** Give up with `busy` after this long in the queue. Interactive defaults to interactiveDeadlineMs. */
  deadlineMs?: number;
  run: () => Promise<T>;
}

export interface GovernorOptions {
  ratesPerSec: Record<Endpoint, number>;
  interactiveDeadlineMs: number;
  backgroundTrickleMs: number;
  maxBackoffMs: number;
  isMarketHours: () => boolean;
  isThrottle: (err: unknown) => boolean;
}

/** Below Angel One's per-client limits (quote 10/s, candles 3/s, search 1/s, greeks 1/s). */
export const DEFAULT_RATES: Record<Endpoint, number> = {
  quote: 5,
  candles: 2.5,
  search: 0.8,
  greek: 0.8,
};

export interface GovernorMetrics {
  lanes: { depth: number; waitP50Ms: number; waitP95Ms: number }[];
  endpoints: Record<
    Endpoint,
    { callsLastMin: number; throttlesLastHour: number; backoffMs: number }
  >;
}

interface Pending {
  req: GovRequest<unknown>;
  enqueuedAt: number;
  deadlineAt: number | null;
  resolve: (r: GovResult<unknown>) => void;
}

interface EndpointState {
  nextAt: number;
  backoffMs: number;
  backoffUntil: number;
  calls: number[];
  throttles: number[];
}

const WAIT_SAMPLES = 200;
const HOUR_MS = 60 * 60 * 1000;

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

/**
 * Every REST request to Angel One for market data goes through here: four
 * strict-priority lanes, one budget per endpoint, merged duplicates,
 * deadlines, and throttle back-off that is REPORTED, never swallowed.
 */
export class Governor {
  private readonly lanes: Pending[][] = [[], [], [], []];
  private readonly waits: number[][] = [[], [], [], []];
  private readonly inflight = new Map<string, Promise<GovResult<unknown>>>();
  private readonly endpoints = new Map<Endpoint, EndpointState>();
  private lastBackgroundAt = Number.NEGATIVE_INFINITY;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(private readonly opts: GovernorOptions) {
    for (const ep of Object.keys(opts.ratesPerSec) as Endpoint[]) {
      this.endpoints.set(ep, { nextAt: 0, backoffMs: 0, backoffUntil: 0, calls: [], throttles: [] });
    }
  }

  submit<T>(req: GovRequest<T>): Promise<GovResult<T>> {
    if (this.disposed) return Promise.resolve({ kind: 'busy' });
    if (req.key) {
      const existing = this.inflight.get(req.key);
      if (existing) return existing as Promise<GovResult<T>>;
    }
    const now = Date.now();
    const deadline =
      req.deadlineMs ?? (req.lane === 1 ? this.opts.interactiveDeadlineMs : undefined);
    const promise = new Promise<GovResult<T>>((resolve) => {
      this.lanes[req.lane].push({
        req: req as GovRequest<unknown>,
        enqueuedAt: now,
        deadlineAt: deadline === undefined ? null : now + deadline,
        resolve: resolve as (r: GovResult<unknown>) => void,
      });
    });
    if (req.key) {
      const key = req.key;
      this.inflight.set(key, promise as Promise<GovResult<unknown>>);
      void promise.then(() => this.inflight.delete(key));
    }
    this.pump();
    return promise;
  }

  metrics(now: number = Date.now()): GovernorMetrics {
    const endpoints = {} as GovernorMetrics['endpoints'];
    for (const [ep, s] of this.endpoints) {
      s.calls = s.calls.filter((t) => t > now - HOUR_MS);
      s.throttles = s.throttles.filter((t) => t > now - HOUR_MS);
      endpoints[ep] = {
        callsLastMin: s.calls.filter((t) => t > now - 60_000).length,
        throttlesLastHour: s.throttles.length,
        backoffMs: Math.max(0, s.backoffUntil - now),
      };
    }
    return {
      lanes: this.lanes.map((q, i) => ({
        depth: q.length,
        waitP50Ms: percentile(this.waits[i], 50),
        waitP95Ms: percentile(this.waits[i], 95),
      })),
      endpoints,
    };
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const q of this.lanes) for (const p of q.splice(0)) p.resolve({ kind: 'busy' });
  }

  private pump(): void {
    if (this.disposed) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const now = Date.now();
    this.expireDeadlines(now);
    let started = true;
    while (started) {
      started = false;
      for (let lane = 0; lane < this.lanes.length; lane++) {
        const idx = this.lanes[lane].findIndex((p) => this.eligible(p, lane, now));
        if (idx >= 0) {
          const [p] = this.lanes[lane].splice(idx, 1);
          this.start(p, lane, now);
          started = true;
          break;
        }
      }
    }
    const wake = this.nextWake(now);
    if (wake !== null) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.pump();
      }, Math.max(1, wake - now));
    }
  }

  private eligible(p: Pending, lane: number, now: number): boolean {
    const ep = this.endpoints.get(p.req.endpoint);
    if (!ep || now < ep.nextAt || now < ep.backoffUntil) return false;
    if (lane === 3) {
      if (this.lanes[0].length + this.lanes[1].length + this.lanes[2].length > 0) return false;
      if (this.opts.isMarketHours() && now < this.lastBackgroundAt + this.opts.backgroundTrickleMs) {
        return false;
      }
    }
    return true;
  }

  private start(p: Pending, lane: number, now: number): void {
    const ep = this.endpoints.get(p.req.endpoint) as EndpointState;
    ep.nextAt = now + 1000 / this.opts.ratesPerSec[p.req.endpoint];
    ep.calls.push(now);
    const w = this.waits[lane];
    w.push(now - p.enqueuedAt);
    if (w.length > WAIT_SAMPLES) w.shift();
    if (lane === 3) this.lastBackgroundAt = now;

    Promise.resolve()
      .then(() => p.req.run())
      .then(
        (value) => {
          ep.backoffMs = 0;
          p.resolve({ kind: 'ok', value });
        },
        (error) => {
          if (this.opts.isThrottle(error)) {
            const t = Date.now();
            ep.backoffMs = ep.backoffMs
              ? Math.min(ep.backoffMs * 2, this.opts.maxBackoffMs)
              : Math.min(1000, this.opts.maxBackoffMs);
            ep.backoffUntil = t + ep.backoffMs;
            ep.throttles.push(t);
            p.resolve({ kind: 'throttled', retryAfterMs: ep.backoffMs });
          } else {
            p.resolve({ kind: 'error', error });
          }
        },
      )
      .finally(() => this.pump());
  }

  private expireDeadlines(now: number): void {
    for (const q of this.lanes) {
      for (let i = q.length - 1; i >= 0; i--) {
        const p = q[i];
        if (p.deadlineAt !== null && now >= p.deadlineAt) {
          q.splice(i, 1);
          p.resolve({ kind: 'busy' });
        }
      }
    }
  }

  private nextWake(now: number): number | null {
    let wake: number | null = null;
    const consider = (t: number) => {
      if (t > now && (wake === null || t < wake)) wake = t;
    };
    this.lanes.forEach((q, lane) => {
      for (const p of q) {
        const ep = this.endpoints.get(p.req.endpoint);
        if (ep) consider(Math.max(ep.nextAt, ep.backoffUntil));
        if (p.deadlineAt !== null) consider(p.deadlineAt);
        if (lane === 3 && this.opts.isMarketHours()) {
          consider(this.lastBackgroundAt + this.opts.backgroundTrickleMs);
        }
      }
    });
    return wake;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @td/api test -- governor.spec`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/market-hub/governor.ts apps/api/src/modules/market-hub/governor.spec.ts
git commit -m "feat(market-hub): governor with priority lanes, per-endpoint budgets and reported throttling" -- apps/api/src/modules/market-hub/governor.ts apps/api/src/modules/market-hub/governor.spec.ts
```

---

### Task 5: QuoteBatcher

**Files:**
- Create: `apps/api/src/modules/market-hub/quote-batcher.ts`
- Test: `apps/api/src/modules/market-hub/quote-batcher.spec.ts`

**Interfaces:**
- Consumes: `Governor`, `GovResult` (Task 4); `InstrumentRef`, `refKey`, `Lane`, `LANE` (Task 2); `TickData`.
- Produces: `type QuoteOutcome = ok(tick) | missing | throttled(retryAfterMs) | busy | error`; `type FetchQuotes = (refs) => Promise<Map<string /* token */, TickData>>`; `class QuoteBatcher(gov, fetchQuotes, opts?)` with `quote(ref, lane): Promise<QuoteOutcome>`; `chunkRefs(items, max)`.

- [ ] **Step 1: Write the failing test**

`quote-batcher.spec.ts`:

```ts
import { DEFAULT_RATES, Governor } from './governor';
import { chunkRefs, QuoteBatcher } from './quote-batcher';
import { LANE, type InstrumentRef } from './hub.types';
import { AngelThrottleError } from '../market-data/services/angel-throttle';
import type { TickData } from '../../common/interfaces/broker-adapter.interface';

const ref = (token: string, exchange: InstrumentRef['exchange'] = 'NSE'): InstrumentRef => ({
  exchange,
  token,
  symbol: token,
});
const tick = (token: string): TickData => ({
  token,
  symbol: token,
  ltp: 100,
  open: 0,
  high: 0,
  low: 0,
  close: 0,
  volume: 0,
  timestamp: new Date(0),
});
const gov = () =>
  new Governor({
    ratesPerSec: DEFAULT_RATES,
    interactiveDeadlineMs: 5000,
    backgroundTrickleMs: 5000,
    maxBackoffMs: 30_000,
    isMarketHours: () => false,
    isThrottle: (e) => e instanceof AngelThrottleError,
  });

describe('QuoteBatcher', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(0);
  });
  afterEach(() => jest.useRealTimers());

  it('combines quotes asked within 150 ms into one broker call', async () => {
    const fetch = jest.fn(async (refs: InstrumentRef[]) => new Map(refs.map((r) => [r.token, tick(r.token)])));
    const b = new QuoteBatcher(gov(), fetch);
    const all = Promise.all(['1', '2', '3'].map((t) => b.quote(ref(t), LANE.ROUTINE)));
    await jest.advanceTimersByTimeAsync(150);
    const out = await all;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0].map((r) => r.token)).toEqual(['1', '2', '3']);
    expect(out.every((o) => o.kind === 'ok')).toBe(true);
  });

  it('splits into calls of at most 50 symbols', async () => {
    const fetch = jest.fn(async (refs: InstrumentRef[]) => new Map(refs.map((r) => [r.token, tick(r.token)])));
    const b = new QuoteBatcher(gov(), fetch);
    const all = Promise.all(Array.from({ length: 120 }, (_, i) => b.quote(ref(String(i)), LANE.ROUTINE)));
    await jest.advanceTimersByTimeAsync(2000);
    await all;
    expect(fetch.mock.calls.map((c) => c[0].length)).toEqual([50, 50, 20]);
  });

  it('never puts the same token twice in one call (exchanges collide on tokens)', () => {
    const items = [{ ref: ref('1', 'NSE') }, { ref: ref('1', 'MCX') }, { ref: ref('2', 'NSE') }];
    expect(chunkRefs(items, 50).map((c) => c.map((i) => `${i.ref.exchange}:${i.ref.token}`))).toEqual([
      ['NSE:1', 'NSE:2'],
      ['MCX:1'],
    ]);
  });

  it('reports a token the broker did not quote as missing', async () => {
    const b = new QuoteBatcher(gov(), async () => new Map([['1', tick('1')]]));
    const both = Promise.all([b.quote(ref('1'), LANE.ROUTINE), b.quote(ref('2'), LANE.ROUTINE)]);
    await jest.advanceTimersByTimeAsync(150);
    const [one, two] = await both;
    expect(one.kind).toBe('ok');
    expect(two).toEqual({ kind: 'missing' });
  });

  it('passes a throttle through to every waiter', async () => {
    const b = new QuoteBatcher(gov(), async () => {
      throw new AngelThrottleError('rate');
    });
    const p = b.quote(ref('1'), LANE.ROUTINE);
    await jest.advanceTimersByTimeAsync(150);
    expect(await p).toEqual({ kind: 'throttled', retryAfterMs: 1000 });
  });

  it('submits the batch on the most urgent lane among its members', async () => {
    const g = gov();
    const spy = jest.spyOn(g, 'submit');
    const b = new QuoteBatcher(g, async () => new Map());
    const p = Promise.all([b.quote(ref('1'), LANE.ROUTINE), b.quote(ref('2'), LANE.CRITICAL)]);
    await jest.advanceTimersByTimeAsync(150);
    await p;
    expect(spy.mock.calls[0][0].lane).toBe(LANE.CRITICAL);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @td/api test -- quote-batcher.spec`
Expected: FAIL — `Cannot find module './quote-batcher'`.

- [ ] **Step 3: Write the implementation**

`quote-batcher.ts`:

```ts
import type { TickData } from '../../common/interfaces/broker-adapter.interface';
import type { Governor } from './governor';
import { refKey, type InstrumentRef, type Lane } from './hub.types';

export type QuoteOutcome =
  | { kind: 'ok'; tick: TickData }
  | { kind: 'missing' }
  | { kind: 'throttled'; retryAfterMs: number }
  | { kind: 'busy' }
  | { kind: 'error'; error: unknown };

/** One broker call for these refs; result keyed by token (Angel's shape). */
export type FetchQuotes = (refs: InstrumentRef[]) => Promise<Map<string, TickData>>;

interface Waiting {
  ref: InstrumentRef;
  lane: Lane;
  resolvers: Array<(o: QuoteOutcome) => void>;
}

export interface QuoteBatcherOptions {
  windowMs: number;
  maxPerCall: number;
}

/**
 * Chunks of at most `max`, and never the same token twice in one chunk:
 * the broker answers keyed by token alone, so two exchanges' identical tokens
 * in one call could not be told apart.
 */
export function chunkRefs<T extends { ref: InstrumentRef }>(items: readonly T[], max: number): T[][] {
  const chunks: { items: T[]; tokens: Set<string> }[] = [];
  for (const item of items) {
    let chunk = chunks.find((c) => c.items.length < max && !c.tokens.has(item.ref.token));
    if (!chunk) {
      chunk = { items: [], tokens: new Set() };
      chunks.push(chunk);
    }
    chunk.items.push(item);
    chunk.tokens.add(item.ref.token);
  }
  return chunks.map((c) => c.items);
}

/** Collects single-quote requests for a short window and sends them as ≤ 50-symbol calls. */
export class QuoteBatcher {
  private readonly pending = new Map<string, Waiting>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly gov: Governor,
    private readonly fetchQuotes: FetchQuotes,
    private readonly opts: QuoteBatcherOptions = { windowMs: 150, maxPerCall: 50 },
  ) {}

  quote(ref: InstrumentRef, lane: Lane): Promise<QuoteOutcome> {
    const key = refKey(ref);
    return new Promise<QuoteOutcome>((resolve) => {
      const existing = this.pending.get(key);
      if (existing) {
        existing.resolvers.push(resolve);
        if (lane < existing.lane) existing.lane = lane;
      } else {
        this.pending.set(key, { ref, lane, resolvers: [resolve] });
      }
      if (!this.timer) this.timer = setTimeout(() => this.flush(), this.opts.windowMs);
    });
  }

  private flush(): void {
    this.timer = null;
    const batch = [...this.pending.values()];
    this.pending.clear();
    for (const chunk of chunkRefs(batch, this.opts.maxPerCall)) void this.send(chunk);
  }

  private async send(chunk: Waiting[]): Promise<void> {
    const lane = Math.min(...chunk.map((w) => w.lane)) as Lane;
    const res = await this.gov.submit({
      endpoint: 'quote',
      lane,
      run: () => this.fetchQuotes(chunk.map((w) => w.ref)),
    });
    for (const w of chunk) {
      let out: QuoteOutcome;
      if (res.kind === 'ok') {
        const tick = res.value.get(w.ref.token);
        out = tick ? { kind: 'ok', tick } : { kind: 'missing' };
      } else {
        out = res;
      }
      for (const resolve of w.resolvers) resolve(out);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @td/api test -- quote-batcher.spec`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/market-hub/quote-batcher.ts apps/api/src/modules/market-hub/quote-batcher.spec.ts
git commit -m "feat(market-hub): quote batcher — 150 ms window, 50 per call, no token collisions" -- apps/api/src/modules/market-hub/quote-batcher.ts apps/api/src/modules/market-hub/quote-batcher.spec.ts
```

---

### Task 6: Broker seam fixes in market-data (session + manager)

**Files:**
- Modify: `apps/api/src/common/interfaces/broker-adapter.interface.ts` (`TickData`)
- Modify: `apps/api/src/modules/market-data/services/user-feed.types.ts`
- Modify: `apps/api/src/modules/market-data/services/user-feed-session.ts`
- Modify: `apps/api/src/modules/market-data/services/user-feed-manager.service.ts`
- Test: `apps/api/src/modules/market-data/services/user-feed-session.spec.ts` (append)
- Test: `apps/api/src/modules/market-data/services/user-feed-manager.service.spec.ts` (append)

**Interfaces:**
- Produces: `TickData.exchange?: string`; `UserFeedSessionLike.getQuotes(refs, opts?: { throwOnThrottle?: boolean })`; `UserFeedManager.pin(userId, tokens)`, `unpin(userId, tokens)`, `addTickListener(fn): () => void`, `addStateListener(fn): () => void`, `fetchQuotes(userId, refs, opts?)`.
- Behaviour kept: `setHandlers` (the gateway's single handler) still works; `getQuotes` without opts still returns an empty map on `data: null` (existing consumers unchanged in M1).

- [ ] **Step 1: Write the failing session tests** (append to `user-feed-session.spec.ts`; `makeDeps` already exists there)

```ts
import { AngelThrottleError } from './angel-throttle';

function makeSession(d = makeDeps()) {
  const s = new UserFeedSession('u1', {
    withDecryptedCreds: d.withCreds,
    smartApiFactory: () => d.smartApi as any,
    wsFactory: d.wsFactory as any,
  });
  return { s, d };
}

it('subscribes NFO and BFO tokens on their own exchange types', async () => {
  const { s, d } = makeSession();
  await s.subscribe([
    { token: '35001', exchange: 'NFO' },
    { token: '850001', exchange: 'BFO' },
  ]);
  const types = d.ws.fetchData.mock.calls.map((c: any[]) => c[0].exchangeType).sort();
  expect(types).toEqual([2, 4]);
});

it('treats the same token on two exchanges as two subscriptions', async () => {
  const { s } = makeSession();
  await s.subscribe([
    { token: '1', exchange: 'NSE' },
    { token: '1', exchange: 'MCX' },
  ]);
  expect(s.activeTokenCount()).toBe(2);
  await s.unsubscribe([{ token: '1', exchange: 'MCX' }]);
  expect(s.activeTokenCount()).toBe(1);
});

it('stamps each tick with its exchange from exchange_type', async () => {
  const { s, d } = makeSession();
  const ticks: any[] = [];
  s.onTick((t) => ticks.push(t));
  await s.ensureConnected();
  d.ws.handlers.tick({ token: '"35001"', exchange_type: 2, last_traded_price: 25050 });
  expect(ticks[0]).toMatchObject({ token: '35001', exchange: 'NFO', ltp: 250.5 });
});

it('getQuotes throws AngelThrottleError on data:null only when asked to', async () => {
  const d = makeDeps();
  d.smartApi.marketData.mockResolvedValue({ data: null, message: 'Access denied because of exceeding access rate' });
  const { s } = makeSession(d);
  await expect(s.getQuotes([{ token: '1', exchange: 'NSE' }])).resolves.toEqual(new Map());
  await expect(
    s.getQuotes([{ token: '1', exchange: 'NSE' }], { throwOnThrottle: true }),
  ).rejects.toBeInstanceOf(AngelThrottleError);
});
```

- [ ] **Step 2: Write the failing manager tests** (append to `user-feed-manager.service.spec.ts`; `fakeSession` already exists there)

```ts
describe('pins (the market hub shares the owner session)', () => {
  it('pin on an existing user reuses the one session', async () => {
    const factory = jest.fn(() => fakeSession());
    const mgr = new UserFeedManager(factory as any, { idleMs: 1000, maxSessions: 40 });
    await mgr.subscribe('owner', [{ token: '1', exchange: 'NSE' }]); // browser
    await mgr.pin('owner', [{ token: '2', exchange: 'NSE' }]); // hub
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('pins survive releaseUser and block idle teardown', async () => {
    jest.useFakeTimers();
    const s = fakeSession();
    const mgr = new UserFeedManager((() => s) as any, { idleMs: 1000, maxSessions: 40 });
    await mgr.pin('owner', [{ token: '2', exchange: 'NSE' }]);
    await mgr.subscribe('owner', [{ token: '1', exchange: 'NSE' }]);
    mgr.releaseUser('owner'); // browser tab closed
    jest.advanceTimersByTime(5000);
    await Promise.resolve();
    expect(s.dispose).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('subscribes a token once whether the browser, the hub or both hold it', async () => {
    const s = fakeSession();
    const mgr = new UserFeedManager((() => s) as any, { idleMs: 1000, maxSessions: 40 });
    const t = { token: '1', exchange: 'NSE' };
    await mgr.pin('owner', [t]);
    await mgr.subscribe('owner', [t]);
    expect(s.subscribe).toHaveBeenCalledTimes(1);
    await mgr.unsubscribe('owner', [t]); // browser leaves; hub still pins
    expect(s.unsubscribe).not.toHaveBeenCalled();
    await mgr.unpin('owner', [t]); // last holder
    expect(s.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('delivers ticks to extra listeners alongside the gateway handler', async () => {
    const s = fakeSession();
    const mgr = new UserFeedManager((() => s) as any, { idleMs: 1000, maxSessions: 40 });
    const gateway = jest.fn();
    const hub = jest.fn();
    mgr.setHandlers(gateway, jest.fn());
    const off = mgr.addTickListener(hub);
    await mgr.pin('owner', []);
    s.__listeners.tick({ token: '1', ltp: 5 });
    expect(gateway).toHaveBeenCalledWith('owner', { token: '1', ltp: 5 });
    expect(hub).toHaveBeenCalledWith('owner', { token: '1', ltp: 5 });
    off();
    s.__listeners.tick({ token: '1', ltp: 6 });
    expect(hub).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @td/api test -- user-feed-session.spec user-feed-manager.service.spec`
Expected: FAIL — exchangeType `[1, 1]` instead of `[2, 4]`; `activeTokenCount` `1`; `exchange` undefined; `pin is not a function`; `addTickListener is not a function`.

- [ ] **Step 4: Implement — `TickData` and types**

In `broker-adapter.interface.ts`, inside `interface TickData` after `oi?: number;`:

```ts
  /** Exchange of this tick ('NSE' | 'NFO' | 'BSE' | 'BFO' | 'MCX') when the feed reports it. */
  exchange?: string;
```

In `user-feed.types.ts`, replace the `getQuotes` member of `UserFeedSessionLike` with:

```ts
  /**
   * Batched FULL-mode quotes in ONE broker call, keyed by token. Tokens the
   * account can't quote are absent from the map rather than throwing. With
   * `throwOnThrottle`, Angel's throttle shape (`data: null`) rejects with
   * AngelThrottleError instead of returning an empty map.
   */
  getQuotes(refs: TokenRef[], opts?: { throwOnThrottle?: boolean }): Promise<Map<string, TickData>>;
```

- [ ] **Step 5: Implement — `user-feed-session.ts`**

1. Extend the exchange enum and add the reverse map (replace the `const enum ExchangeType {…}` block):

```ts
const enum ExchangeType {
  NSE_CM = 1,
  NSE_FO = 2,
  BSE_CM = 3,
  BSE_FO = 4,
  MCX_FO = 5,
}

/** WebSocketV2 `exchange_type` → the REST exchange name used everywhere else. */
const EXCHANGE_NAME_BY_TYPE: Record<number, string> = {
  1: 'NSE',
  2: 'NFO',
  3: 'BSE',
  4: 'BFO',
  5: 'MCX',
};

/** Tokens collide across exchanges; every local map keys on both. */
function tokenKey(t: TokenRef): string {
  return `${t.exchange.toUpperCase()}:${t.token}`;
}
```

2. In `subscribe`, `unsubscribe`: replace `this.activeTokens.has(t.token)` / `.set(t.token, t)` / `.delete(t.token)` with `tokenKey(t)`:

```ts
    const fresh = tokens.filter((t) => !this.activeTokens.has(tokenKey(t)));
    // …
    for (const t of fresh) this.activeTokens.set(tokenKey(t), t);
```
```ts
    const existing = tokens.filter((t) => this.activeTokens.has(tokenKey(t)));
    // …
    for (const t of existing) this.activeTokens.delete(tokenKey(t));
```

3. In `mapExchange`, add before `default`:

```ts
      case 'NFO':
        return ExchangeType.NSE_FO; // 2
      case 'BFO':
        return ExchangeType.BSE_FO; // 4
```

4. In `mapSingleTick`, add to the returned object (after `symbol`):

```ts
      exchange: EXCHANGE_NAME_BY_TYPE[Number(tick.exchange_type ?? tick.exchangeType)],
```

5. Change `getQuotes` signature and add the throttle check right after the `marketData` call:

```ts
  async getQuotes(
    refs: TokenRef[],
    opts: { throwOnThrottle?: boolean } = {},
  ): Promise<Map<string, TickData>> {
    // … existing guard + marketData call unchanged …
    if (opts.throwOnThrottle && response?.data == null) {
      throw new AngelThrottleError(
        `Angel One returned data:null for marketData (${refs.length} token(s)) — throttled or rejected`,
      );
    }
    // … rest unchanged …
```

and extend the import from `./angel-throttle` to `import { AngelThrottleError, fetchChunksResilient, rowsOrThrottle } from './angel-throttle';`.

- [ ] **Step 6: Implement — `user-feed-manager.service.ts`**

1. Add `pins: Map<string, TokenRef>;` to `UserFeedEntry`, and `pins: new Map(),` where the entry is created in `getOrCreateEntry`.
2. Add listener sets and fan-out (fields + `getOrCreateEntry` wiring):

```ts
  private readonly tickListeners = new Set<ManagerTickHandler>();
  private readonly stateListeners = new Set<ManagerStateHandler>();

  /** Extra tick consumers (the market hub) alongside the gateway's setHandlers. */
  addTickListener(fn: ManagerTickHandler): () => void {
    this.tickListeners.add(fn);
    return () => this.tickListeners.delete(fn);
  }

  addStateListener(fn: ManagerStateHandler): () => void {
    this.stateListeners.add(fn);
    return () => this.stateListeners.delete(fn);
  }
```

and in `getOrCreateEntry` replace the two `session.on…` lines with:

```ts
    session.onTick((tick) => {
      this.onTickHandler?.(userId, tick);
      for (const l of this.tickListeners) l(userId, tick);
    });
    session.onState((state) => {
      this.onStateHandler?.(userId, state);
      for (const l of this.stateListeners) l(userId, state);
    });
```

3. Make `subscribe`/`unsubscribe` pin-aware — in `subscribe`, change the fresh condition to `if (prev === 0 && !entry.pins.has(key))`; in `unsubscribe`, push to `dead` only when `!entry.pins.has(key)` (still delete the ref entry).
4. Count pins in `totalRefs`:

```ts
  private totalRefs(entry: UserFeedEntry): number {
    let sum = entry.pins.size;
    for (const n of entry.refs.values()) sum += n;
    return sum;
  }
```

5. In `releaseUser`, start the idle timer only when nothing is pinned:

```ts
    if (this.totalRefs(entry) === 0) this.startIdleTimer(userId, entry);
```

6. Add `pin`/`unpin` and widen `fetchQuotes`:

```ts
  /**
   * Hold tokens for a long-lived in-process consumer (the market hub). Pins
   * share the user's ONE session — a second Angel login on the same client
   * code would kill this session's stream — and they survive releaseUser()
   * (a closed browser tab) and block idle teardown.
   */
  async pin(userId: string, tokens: TokenRef[]): Promise<void> {
    const entry = this.getOrCreateEntry(userId);
    this.clearIdleTimer(entry);
    entry.lastActive = Date.now();
    await entry.session.ensureConnected();
    const fresh: TokenRef[] = [];
    for (const t of tokens) {
      const key = tokenKey(t);
      if (entry.pins.has(key)) continue;
      entry.pins.set(key, t);
      if ((entry.refs.get(key) ?? 0) === 0) fresh.push(t);
    }
    if (fresh.length > 0) await entry.session.subscribe(fresh);
  }

  async unpin(userId: string, tokens: TokenRef[]): Promise<void> {
    const entry = this.registry.get(userId);
    if (!entry) return;
    const dead: TokenRef[] = [];
    for (const t of tokens) {
      const key = tokenKey(t);
      const pinned = entry.pins.get(key);
      if (!pinned) continue;
      entry.pins.delete(key);
      if ((entry.refs.get(key) ?? 0) === 0) dead.push(pinned);
    }
    if (dead.length > 0) await entry.session.unsubscribe(dead);
    if (this.totalRefs(entry) === 0) this.startIdleTimer(userId, entry);
  }

  async fetchQuotes(userId: string, refs: TokenRef[], opts?: { throwOnThrottle?: boolean }) {
    const entry = this.getOrCreateEntry(userId);
    return entry.session.getQuotes(refs, opts);
  }
```

- [ ] **Step 7: Run tests to verify they pass, and the rest of market-data stays green**

Run: `pnpm --filter @td/api test -- user-feed-session.spec user-feed-manager.service.spec`
Expected: PASS (existing + 8 new).
Run: `pnpm --filter @td/api test -- market-data`
Expected: PASS — no regressions in the module (gateway, resolver, quotes util).

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/common/interfaces/broker-adapter.interface.ts apps/api/src/modules/market-data/services/user-feed.types.ts apps/api/src/modules/market-data/services/user-feed-session.ts apps/api/src/modules/market-data/services/user-feed-manager.service.ts apps/api/src/modules/market-data/services/user-feed-session.spec.ts apps/api/src/modules/market-data/services/user-feed-manager.service.spec.ts
git commit -m "fix(market-data): NFO/BFO subscriptions, exchange-keyed tokens, reported quote throttles, pinnable sessions" -- apps/api/src/common/interfaces/broker-adapter.interface.ts apps/api/src/modules/market-data/services/user-feed.types.ts apps/api/src/modules/market-data/services/user-feed-session.ts apps/api/src/modules/market-data/services/user-feed-manager.service.ts apps/api/src/modules/market-data/services/user-feed-session.spec.ts apps/api/src/modules/market-data/services/user-feed-manager.service.spec.ts
```

---

### Task 7: HubBroker seam, ManagerHubBroker, FakeBroker

**Files:**
- Create: `apps/api/src/modules/market-hub/hub-broker.ts`
- Create: `apps/api/src/modules/market-hub/testing/fake-broker.ts`
- Test: `apps/api/src/modules/market-hub/hub-broker.spec.ts`

**Interfaces:**
- Consumes: `UserFeedManager.pin/unpin/fetchQuotes/addTickListener/addStateListener` (Task 6); `InstrumentRef` (Task 2); `FeedState`, `TokenRef`.
- Produces: `interface HubBroker { connect(); subscribe(refs); unsubscribe(refs); quotes(refs): Promise<Map<string, TickData>>; onTick(fn); onState(fn) }`; `class ManagerHubBroker(manager, ownerUserId)`; `class FakeBroker implements HubBroker` with `subscribed: Set<string>`, `quoteCalls: InstrumentRef[][]`, `quoteImpl`, `emitTick(t)`, `emitState(s)`.

- [ ] **Step 1: Write the failing test**

`hub-broker.spec.ts`:

```ts
import { ManagerHubBroker } from './hub-broker';
import type { InstrumentRef } from './hub.types';

function fakeManager() {
  const tickListeners: any[] = [];
  const stateListeners: any[] = [];
  return {
    pin: jest.fn().mockResolvedValue(undefined),
    unpin: jest.fn().mockResolvedValue(undefined),
    fetchQuotes: jest.fn().mockResolvedValue(new Map()),
    addTickListener: jest.fn((fn) => (tickListeners.push(fn), () => undefined)),
    addStateListener: jest.fn((fn) => (stateListeners.push(fn), () => undefined)),
    tickListeners,
    stateListeners,
  };
}
const A: InstrumentRef = { exchange: 'NFO', token: '35001', symbol: 'NIFTY26OCT25000CE' };

describe('ManagerHubBroker', () => {
  it('subscribes by pinning on the owner session, never by logging in itself', async () => {
    const m = fakeManager();
    const b = new ManagerHubBroker(m as any, 'owner');
    await b.connect();
    await b.subscribe([A]);
    expect(m.pin).toHaveBeenNthCalledWith(1, 'owner', []);
    expect(m.pin).toHaveBeenNthCalledWith(2, 'owner', [{ token: '35001', exchange: 'NFO' }]);
    await b.unsubscribe([A]);
    expect(m.unpin).toHaveBeenCalledWith('owner', [{ token: '35001', exchange: 'NFO' }]);
  });

  it('asks for throttles to be thrown, not swallowed', async () => {
    const m = fakeManager();
    await new ManagerHubBroker(m as any, 'owner').quotes([A]);
    expect(m.fetchQuotes).toHaveBeenCalledWith('owner', [{ token: '35001', exchange: 'NFO' }], {
      throwOnThrottle: true,
    });
  });

  it('only passes on the owner’s ticks and states', () => {
    const m = fakeManager();
    const b = new ManagerHubBroker(m as any, 'owner');
    const ticks: any[] = [];
    const states: any[] = [];
    b.onTick((t) => ticks.push(t));
    b.onState((s) => states.push(s));
    m.tickListeners[0]('someone-else', { token: '1' });
    m.tickListeners[0]('owner', { token: '2' });
    m.stateListeners[0]('owner', 'live');
    expect(ticks).toEqual([{ token: '2' }]);
    expect(states).toEqual(['live']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @td/api test -- hub-broker.spec`
Expected: FAIL — `Cannot find module './hub-broker'`.

- [ ] **Step 3: Write the implementation**

`hub-broker.ts`:

```ts
import type { TickData } from '../../common/interfaces/broker-adapter.interface';
import type { UserFeedManager } from '../market-data/services/user-feed-manager.service';
import type { FeedState, TokenRef } from '../market-data/services/user-feed.types';
import type { InstrumentRef } from './hub.types';

/** Everything the hub needs from a broker session — and nothing else. */
export interface HubBroker {
  connect(): Promise<void>;
  subscribe(refs: InstrumentRef[]): Promise<void>;
  unsubscribe(refs: InstrumentRef[]): Promise<void>;
  /** One FULL-quote call, keyed by token. Rejects with AngelThrottleError when throttled. */
  quotes(refs: InstrumentRef[]): Promise<Map<string, TickData>>;
  onTick(fn: (tick: TickData) => void): void;
  onState(fn: (state: FeedState) => void): void;
}

const toTokenRef = (r: InstrumentRef): TokenRef => ({ token: r.token, exchange: r.exchange });

/**
 * The hub on the OWNER's existing per-user session. It pins tokens on the
 * UserFeedManager rather than creating a session: a second Angel One login
 * on the same client code would kill the browser's live stream.
 */
export class ManagerHubBroker implements HubBroker {
  constructor(
    private readonly manager: Pick<
      UserFeedManager,
      'pin' | 'unpin' | 'fetchQuotes' | 'addTickListener' | 'addStateListener'
    >,
    private readonly ownerUserId: string,
  ) {}

  connect(): Promise<void> {
    return this.manager.pin(this.ownerUserId, []);
  }

  subscribe(refs: InstrumentRef[]): Promise<void> {
    return this.manager.pin(this.ownerUserId, refs.map(toTokenRef));
  }

  unsubscribe(refs: InstrumentRef[]): Promise<void> {
    return this.manager.unpin(this.ownerUserId, refs.map(toTokenRef));
  }

  quotes(refs: InstrumentRef[]): Promise<Map<string, TickData>> {
    return this.manager.fetchQuotes(this.ownerUserId, refs.map(toTokenRef), {
      throwOnThrottle: true,
    });
  }

  onTick(fn: (tick: TickData) => void): void {
    this.manager.addTickListener((userId, tick) => {
      if (userId === this.ownerUserId) fn(tick);
    });
  }

  onState(fn: (state: FeedState) => void): void {
    this.manager.addStateListener((userId, state) => {
      if (userId === this.ownerUserId) fn(state);
    });
  }
}
```

`testing/fake-broker.ts`:

```ts
import type { TickData } from '../../../common/interfaces/broker-adapter.interface';
import type { FeedState } from '../../market-data/services/user-feed.types';
import type { HubBroker } from '../hub-broker';
import { refKey, type InstrumentRef } from '../hub.types';

/** In-memory broker for hub tests: records calls, emits ticks/states on demand. */
export class FakeBroker implements HubBroker {
  readonly subscribed = new Set<string>();
  readonly quoteCalls: InstrumentRef[][] = [];
  connected = false;
  quoteImpl: (refs: InstrumentRef[]) => Promise<Map<string, TickData>> = async (refs) =>
    new Map(refs.map((r) => [r.token, FakeBroker.tick(r.token, 100)]));
  private tickFns: Array<(t: TickData) => void> = [];
  private stateFns: Array<(s: FeedState) => void> = [];

  static tick(token: string, ltp: number, exchange?: string): TickData {
    return { token, symbol: token, ltp, open: 0, high: 0, low: 0, close: 0, volume: 0, timestamp: new Date(), exchange };
  }

  async connect(): Promise<void> {
    this.connected = true;
  }
  async subscribe(refs: InstrumentRef[]): Promise<void> {
    for (const r of refs) this.subscribed.add(refKey(r));
  }
  async unsubscribe(refs: InstrumentRef[]): Promise<void> {
    for (const r of refs) this.subscribed.delete(refKey(r));
  }
  quotes(refs: InstrumentRef[]): Promise<Map<string, TickData>> {
    this.quoteCalls.push(refs);
    return this.quoteImpl(refs);
  }
  onTick(fn: (t: TickData) => void): void {
    this.tickFns.push(fn);
  }
  onState(fn: (s: FeedState) => void): void {
    this.stateFns.push(fn);
  }
  emitTick(t: TickData): void {
    for (const fn of this.tickFns) fn(t);
  }
  emitState(s: FeedState): void {
    for (const fn of this.stateFns) fn(s);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @td/api test -- hub-broker.spec`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/market-hub/hub-broker.ts apps/api/src/modules/market-hub/hub-broker.spec.ts apps/api/src/modules/market-hub/testing/fake-broker.ts
git commit -m "feat(market-hub): broker seam over the owner's shared session, plus a fake broker" -- apps/api/src/modules/market-hub/hub-broker.ts apps/api/src/modules/market-hub/hub-broker.spec.ts apps/api/src/modules/market-hub/testing/fake-broker.ts
```

---

### Task 8: LiveFeed

**Files:**
- Create: `apps/api/src/modules/market-hub/live-feed.ts`
- Test: `apps/api/src/modules/market-hub/live-feed.spec.ts`

**Interfaces:**
- Consumes: `HubBroker`, `FakeBroker` (Task 7); `WatchRegistry`, `allocateSlots`, `Allocation` (Task 3); `PriceBook` (Task 2).
- Produces: `class LiveFeed({ broker, registry, book, cap })` with `reconcile(): Promise<Allocation>`, `allocation(): Allocation`, `get wsHealthy(): boolean`, `onPrice(fn): () => void`, `metrics(): { live; cap; demotionsTotal; criticalOverflow; socketUp }`.

- [ ] **Step 1: Write the failing test**

`live-feed.spec.ts`:

```ts
import { LiveFeed } from './live-feed';
import { WatchRegistry } from './watch-registry';
import { PriceBook } from './price-book';
import { FakeBroker } from './testing/fake-broker';
import type { InstrumentRef } from './hub.types';

const ref = (token: string, exchange: InstrumentRef['exchange'] = 'NSE'): InstrumentRef => ({
  exchange,
  token,
  symbol: token,
});

function setup(cap = 2) {
  const broker = new FakeBroker();
  const registry = new WatchRegistry();
  const book = new PriceBook();
  const feed = new LiveFeed({ broker, registry, book, cap });
  return { broker, registry, book, feed };
}

describe('LiveFeed', () => {
  it('subscribes the highest-priority watches up to the cap', async () => {
    const { broker, registry, feed } = setup(2);
    registry.watch(ref('pos'), 0, 'positions', 0);
    registry.watch(ref('nifty'), 2, 'context', 0);
    registry.watch(ref('chart'), 4, 'ui', 0);
    await feed.reconcile();
    expect([...broker.subscribed].sort()).toEqual(['NSE:nifty', 'NSE:pos']);
  });

  it('demotes the lowest priority when a more urgent watch arrives, and counts it', async () => {
    const { broker, registry, feed } = setup(2);
    registry.watch(ref('nifty'), 2, 'context', 0);
    registry.watch(ref('chart'), 4, 'ui', 0);
    await feed.reconcile();
    registry.watch(ref('pos'), 0, 'positions', 1);
    await feed.reconcile();
    expect(broker.subscribed.has('NSE:chart')).toBe(false);
    expect(feed.metrics().demotionsTotal).toBe(1);
  });

  it('writes ticks for live instruments into the price book with receipt time', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(50_000);
    const { broker, registry, book, feed } = setup();
    registry.watch(ref('35001', 'NFO'), 0, 'positions', 0);
    await feed.reconcile();
    broker.emitTick(FakeBroker.tick('35001', 250.5, 'NFO'));
    expect(book.ageMs('NFO:35001', 50_000)).toBe(0);
    jest.useRealTimers();
  });

  it('ignores ticks for tokens it did not subscribe (the browser shares the socket)', async () => {
    const { broker, book, feed } = setup();
    await feed.reconcile();
    broker.emitTick(FakeBroker.tick('999', 1, 'NSE'));
    expect(book.size()).toBe(0);
  });

  it('resolves a tick without an exchange by token when unambiguous', async () => {
    const { broker, registry, book, feed } = setup();
    registry.watch(ref('7'), 2, 'context', 0);
    await feed.reconcile();
    broker.emitTick(FakeBroker.tick('7', 10));
    expect(book.size()).toBe(1);
  });

  it('tracks socket health from broker states', () => {
    const { broker, feed } = setup();
    expect(feed.wsHealthy).toBe(false);
    broker.emitState('live');
    expect(feed.wsHealthy).toBe(true);
    broker.emitState('reconnecting');
    expect(feed.wsHealthy).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @td/api test -- live-feed.spec`
Expected: FAIL — `Cannot find module './live-feed'`.

- [ ] **Step 3: Write the implementation**

`live-feed.ts`:

```ts
import type { TickData } from '../../common/interfaces/broker-adapter.interface';
import type { HubBroker } from './hub-broker';
import { refKey, type InstrumentRef, type Price } from './hub.types';
import type { PriceBook } from './price-book';
import { allocateSlots, type Allocation } from './slot-allocator';
import type { WatchRegistry } from './watch-registry';

export interface LiveFeedDeps {
  broker: HubBroker;
  registry: WatchRegistry;
  book: PriceBook;
  cap: number;
}

const EMPTY: Allocation = { live: [], nearLive: [], criticalOverflow: [], demoted: 0 };

/** Turns the priority allocation into WebSocket subscriptions and ticks into prices. */
export class LiveFeed {
  private live = new Map<string, InstrumentRef>();
  private current: Allocation = EMPTY;
  private socketUp = false;
  private demotionsTotal = 0;
  private readonly priceListeners = new Set<(p: Price) => void>();

  constructor(private readonly d: LiveFeedDeps) {
    d.broker.onTick((t) => this.onTick(t));
    d.broker.onState((s) => {
      this.socketUp = s === 'live';
    });
  }

  get wsHealthy(): boolean {
    return this.socketUp;
  }

  allocation(): Allocation {
    return this.current;
  }

  onPrice(fn: (p: Price) => void): () => void {
    this.priceListeners.add(fn);
    return () => this.priceListeners.delete(fn);
  }

  async reconcile(): Promise<Allocation> {
    const alloc = allocateSlots(this.d.registry.entries(), this.d.cap);
    const want = new Map(alloc.live.map((e) => [refKey(e.ref), e.ref] as const));
    const add = [...want].filter(([k]) => !this.live.has(k)).map(([, r]) => r);
    const remove = [...this.live].filter(([k]) => !want.has(k)).map(([k, r]) => [k, r] as const);
    const stillWatched = new Set(alloc.nearLive.map((e) => refKey(e.ref)));
    this.demotionsTotal += remove.filter(([k]) => stillWatched.has(k)).length;
    if (remove.length > 0) await this.d.broker.unsubscribe(remove.map(([, r]) => r));
    if (add.length > 0) await this.d.broker.subscribe(add);
    this.live = want;
    this.current = alloc;
    return alloc;
  }

  metrics() {
    return {
      live: this.live.size,
      cap: this.d.cap,
      demotionsTotal: this.demotionsTotal,
      criticalOverflow: this.current.criticalOverflow.length,
      socketUp: this.socketUp,
    };
  }

  private onTick(t: TickData): void {
    const ref = t.exchange ? this.live.get(`${t.exchange}:${t.token}`) : this.byToken(t.token);
    if (!ref) return;
    const price: Price = {
      ref,
      ltp: t.ltp,
      at: Date.now(), // receipt time: the price is confirmed current NOW
      source: 'ws',
      volume: t.volume,
      oi: t.oi,
    };
    this.d.book.set(price);
    for (const fn of this.priceListeners) fn(price);
  }

  /** Fallback when a tick lacks its exchange: accept only an unambiguous token. */
  private byToken(token: string): InstrumentRef | undefined {
    const matches = [...this.live.values()].filter((r) => r.token === token);
    return matches.length === 1 ? matches[0] : undefined;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @td/api test -- live-feed.spec`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/market-hub/live-feed.ts apps/api/src/modules/market-hub/live-feed.spec.ts
git commit -m "feat(market-hub): live feed — priority subscriptions, receipt-timed prices" -- apps/api/src/modules/market-hub/live-feed.ts apps/api/src/modules/market-hub/live-feed.spec.ts
```

---

### Task 9: QuotePoller

**Files:**
- Create: `apps/api/src/modules/market-hub/quote-poller.ts`
- Test: `apps/api/src/modules/market-hub/quote-poller.spec.ts`

**Interfaces:**
- Consumes: `LiveFeed` (Task 8), `QuoteBatcher` + `QuoteOutcome` (Task 5), `PriceBook` (Task 2), `SessionClock` (Task 1), `LANE`.
- Produces: `class QuotePoller({ feed, book, batcher, clock, nearLiveTargetMs, criticalTargetMs })` with `pollNearLive(now?): number`, `pollCritical(now?): number`, `start()`, `stop()`.

- [ ] **Step 1: Write the failing test**

`quote-poller.spec.ts`:

```ts
import { QuotePoller } from './quote-poller';
import { LiveFeed } from './live-feed';
import { WatchRegistry } from './watch-registry';
import { PriceBook } from './price-book';
import { QuoteBatcher } from './quote-batcher';
import { DEFAULT_RATES, Governor } from './governor';
import { SessionClock } from './session-clock';
import { FakeBroker } from './testing/fake-broker';
import { MARKET_HOLIDAYS } from '../market-data/services/market-holidays.service';
import { AngelThrottleError } from '../market-data/services/angel-throttle';
import type { InstrumentRef } from './hub.types';

const IST = (local: string) => new Date(new Date(`${local}Z`).getTime() - 5.5 * 3600_000).getTime();
const ref = (token: string, exchange: InstrumentRef['exchange'] = 'NSE'): InstrumentRef => ({
  exchange,
  token,
  symbol: token,
});

async function setup(cap: number) {
  const broker = new FakeBroker();
  const registry = new WatchRegistry();
  const book = new PriceBook();
  const feed = new LiveFeed({ broker, registry, book, cap });
  const gov = new Governor({
    ratesPerSec: DEFAULT_RATES,
    interactiveDeadlineMs: 5000,
    backgroundTrickleMs: 5000,
    maxBackoffMs: 30_000,
    isMarketHours: () => true,
    isThrottle: (e) => e instanceof AngelThrottleError,
  });
  const batcher = new QuoteBatcher(gov, (refs) => broker.quotes(refs));
  const clock = new SessionClock({ holidays: MARKET_HOLIDAYS });
  const poller = new QuotePoller({ feed, book, batcher, clock, nearLiveTargetMs: 5000, criticalTargetMs: 2000 });
  return { broker, registry, book, feed, poller };
}

describe('QuotePoller', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(IST('2026-10-07T10:00:00')); // Wednesday, NSE open, MCX open
  });
  afterEach(() => jest.useRealTimers());

  it('polls watched instruments that did not get a live slot', async () => {
    const { broker, registry, feed, poller, book } = await setup(0);
    registry.watch(ref('1'), 3, 'w', 0);
    await feed.reconcile();
    expect(poller.pollNearLive()).toBe(1);
    await jest.advanceTimersByTimeAsync(200);
    expect(broker.quoteCalls).toHaveLength(1);
    expect(book.ageMs('NSE:1', Date.now())).toBe(0);
  });

  it('does not poll a closed exchange', async () => {
    jest.setSystemTime(IST('2026-10-07T16:00:00')); // NSE closed, MCX open
    const { registry, feed, poller } = await setup(0);
    registry.watch(ref('1', 'NSE'), 3, 'w', 0);
    registry.watch(ref('2', 'MCX'), 3, 'w', 0);
    await feed.reconcile();
    expect(poller.pollNearLive()).toBe(1);
  });

  it('does not re-poll a price that is still fresh', async () => {
    const { registry, feed, poller } = await setup(0);
    registry.watch(ref('1'), 3, 'w', 0);
    await feed.reconcile();
    poller.pollNearLive();
    await jest.advanceTimersByTimeAsync(200);
    expect(poller.pollNearLive()).toBe(0);
  });

  it('polls live P0/P1 instruments on the critical lane while the socket is down', async () => {
    const { broker, registry, feed, poller } = await setup(5);
    registry.watch(ref('pos'), 0, 'positions', 0);
    await feed.reconcile();
    broker.emitState('reconnecting');
    expect(poller.pollCritical()).toBe(1);
    broker.emitState('live');
    jest.setSystemTime(Date.now() + 10_000);
    expect(poller.pollCritical()).toBe(0);
  });

  it('records a throttle as an unavailable reason', async () => {
    const { broker, registry, feed, poller, book } = await setup(0);
    broker.quoteImpl = async () => {
      throw new AngelThrottleError('rate');
    };
    registry.watch(ref('1'), 3, 'w', 0);
    await feed.reconcile();
    poller.pollNearLive();
    await jest.advanceTimersByTimeAsync(200);
    expect(
      book.get(ref('1'), { maxAgeMs: 1, now: Date.now(), isOpen: () => true, watched: () => true }),
    ).toEqual({ kind: 'unavailable', reason: 'throttled' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @td/api test -- quote-poller.spec`
Expected: FAIL — `Cannot find module './quote-poller'`.

- [ ] **Step 3: Write the implementation**

`quote-poller.ts`:

```ts
import { LANE, refKey, type InstrumentRef, type Lane } from './hub.types';
import type { LiveFeed } from './live-feed';
import type { PriceBook } from './price-book';
import type { QuoteBatcher, QuoteOutcome } from './quote-batcher';
import type { SessionClock } from './session-clock';
import type { WatchEntry } from './watch-registry';

export interface QuotePollerDeps {
  feed: LiveFeed;
  book: PriceBook;
  batcher: QuoteBatcher;
  clock: SessionClock;
  nearLiveTargetMs: number;
  criticalTargetMs: number;
}

/**
 * The near-live tier (every ~5 s for watched instruments without a live slot)
 * and the safety net (every ~2 s, Critical lane, for P0/P1 when the socket is
 * down or they overflowed the cap). Never polls a closed exchange.
 */
export class QuotePoller {
  private timers: ReturnType<typeof setInterval>[] = [];

  constructor(private readonly d: QuotePollerDeps) {}

  pollNearLive(now: number = Date.now()): number {
    return this.poll(this.d.feed.allocation().nearLive, this.d.nearLiveTargetMs, LANE.ROUTINE, now);
  }

  pollCritical(now: number = Date.now()): number {
    const alloc = this.d.feed.allocation();
    const socketDown = this.d.feed.wsHealthy
      ? []
      : alloc.live.filter((e) => e.priority <= 1);
    return this.poll([...socketDown, ...alloc.criticalOverflow], this.d.criticalTargetMs, LANE.CRITICAL, now);
  }

  start(nearLiveEveryMs = 5000, criticalEveryMs = 2000): void {
    this.stop();
    const near = setInterval(() => this.pollNearLive(), nearLiveEveryMs);
    const crit = setInterval(() => this.pollCritical(), criticalEveryMs);
    near.unref?.();
    crit.unref?.();
    this.timers = [near, crit];
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  private poll(entries: readonly WatchEntry[], targetMs: number, lane: Lane, now: number): number {
    const at = new Date(now);
    let asked = 0;
    for (const e of entries) {
      if (!this.d.clock.isOpen(e.ref.exchange, at)) continue;
      const age = this.d.book.ageMs(refKey(e.ref), now);
      if (age !== undefined && age < targetMs) continue;
      asked++;
      void this.d.batcher.quote(e.ref, lane).then((o) => this.apply(e.ref, o));
    }
    return asked;
  }

  private apply(ref: InstrumentRef, o: QuoteOutcome): void {
    if (o.kind === 'ok') {
      this.d.book.set({
        ref,
        ltp: o.tick.ltp,
        at: Date.now(),
        source: 'quote',
        volume: o.tick.volume,
        oi: o.tick.oi,
      });
    } else if (o.kind === 'throttled') {
      this.d.book.markFailure(refKey(ref), 'throttled');
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @td/api test -- quote-poller.spec`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/market-hub/quote-poller.ts apps/api/src/modules/market-hub/quote-poller.spec.ts
git commit -m "feat(market-hub): near-live polling and a critical safety net when the socket drops" -- apps/api/src/modules/market-hub/quote-poller.ts apps/api/src/modules/market-hub/quote-poller.spec.ts
```

---

### Task 10: HubEngine, MarketHubService, module, config (shadow)

**Files:**
- Create: `apps/api/src/modules/market-hub/hub-engine.ts`
- Create: `apps/api/src/modules/market-hub/market-hub.service.ts`
- Create: `apps/api/src/modules/market-hub/market-hub.module.ts`
- Modify: `apps/api/src/config/configuration.ts` (add `hub` block)
- Modify: `apps/api/src/app.module.ts` (register `MarketHubModule` after `TradeTrackerModule`)
- Modify: `deploy/env/api.env.example` (document keys)
- Test: `apps/api/src/modules/market-hub/hub-engine.spec.ts`
- Test: `apps/api/src/modules/market-hub/market-hub.service.spec.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–9; `TradeTrackerService.openTrackerRefsByUser()` (returns `Map<userId, TokenRef[]>`); `INDICES` from `@td/shared/constants`; `UserFeedManager` (exported by `MarketDataModule`).
- Produces: `class HubEngine({ broker, clock, cap, defaults })` with `start()`, `stop()`, `watch(ref, priority, owner, ttlMs?)`, `unwatch(ref, owner)`, `setPositions(refs)`, `price(ref, { maxAgeMs })`, `prices(refs, opts)`, `onPrice(fn)`, `status(): HubStatus`; `interface HubStatus`; `@Injectable() class MarketHubService` with the same read API plus `status(): HubStatus | null` and `disabledReason(): string | null`; `MarketHubModule` exporting `MarketHubService`.

- [ ] **Step 1: Write the failing engine test**

`hub-engine.spec.ts`:

```ts
import { HubEngine } from './hub-engine';
import { SessionClock } from './session-clock';
import { FakeBroker } from './testing/fake-broker';
import { MARKET_HOLIDAYS } from '../market-data/services/market-holidays.service';
import type { InstrumentRef } from './hub.types';

const IST = (local: string) => new Date(new Date(`${local}Z`).getTime() - 5.5 * 3600_000).getTime();
const NIFTY: InstrumentRef = { exchange: 'NSE', token: '99926000', symbol: 'NIFTY' };
const POS: InstrumentRef = { exchange: 'NFO', token: '35001', symbol: 'NIFTY26OCT25000CE' };

function engine(broker = new FakeBroker()) {
  const e = new HubEngine({
    broker,
    clock: new SessionClock({ holidays: MARKET_HOLIDAYS }),
    cap: 50,
    defaults: [NIFTY],
  });
  return { e, broker };
}

describe('HubEngine', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(IST('2026-10-07T10:00:00'));
  });
  afterEach(() => jest.useRealTimers());

  it('connects and subscribes the default context set on start', async () => {
    const { e, broker } = engine();
    await e.start();
    expect(broker.connected).toBe(true);
    expect(broker.subscribed.has('NSE:99926000')).toBe(true);
    e.stop();
  });

  it('watches open positions at priority 0 and drops closed ones', async () => {
    const { e, broker } = engine();
    await e.start();
    await e.setPositions([POS]);
    expect(broker.subscribed.has('NFO:35001')).toBe(true);
    await e.setPositions([]);
    expect(broker.subscribed.has('NFO:35001')).toBe(false);
    e.stop();
  });

  it('answers price() from the book with the right result kind', async () => {
    const { e, broker } = engine();
    await e.start();
    expect(e.price(POS, { maxAgeMs: 5000 })).toEqual({ kind: 'unavailable', reason: 'not-watched' });
    await e.setPositions([POS]);
    broker.emitTick(FakeBroker.tick('35001', 250.5, 'NFO'));
    expect(e.price(POS, { maxAgeMs: 5000 }).kind).toBe('fresh');
    jest.setSystemTime(Date.now() + 6000);
    expect(e.price(POS, { maxAgeMs: 5000 }).kind).toBe('stale');
    e.stop();
  });

  it('reports a status snapshot with the oldest P0 price age and unpriced P0 count', async () => {
    const { e, broker } = engine();
    await e.start();
    await e.setPositions([POS]);
    let s = e.status();
    expect(s.prices.unpricedP0).toBe(1);
    broker.emitTick(FakeBroker.tick('35001', 250.5, 'NFO'));
    jest.setSystemTime(Date.now() + 1500);
    s = e.status();
    expect(s.prices.unpricedP0).toBe(0);
    expect(s.prices.oldestP0AgeMs).toBe(1500);
    expect(s.slots.live).toBe(2);
    expect(s.calendar.missingYear).toBeNull();
    e.stop();
  });
});
```

- [ ] **Step 2: Write the failing service test**

`market-hub.service.spec.ts`:

```ts
import { MarketHubService } from './market-hub.service';

function config(values: Record<string, unknown>) {
  return { get: jest.fn((k: string) => values[k]) };
}
function manager(pin: jest.Mock = jest.fn(() => new Promise<void>(() => undefined))) {
  return {
    pin,
    unpin: jest.fn().mockResolvedValue(undefined),
    fetchQuotes: jest.fn().mockResolvedValue(new Map()),
    addTickListener: jest.fn(() => () => undefined),
    addStateListener: jest.fn(() => () => undefined),
  };
}
const tracker = { openTrackerRefsByUser: jest.fn().mockResolvedValue(new Map()) };

describe('MarketHubService', () => {
  it('does nothing when disabled and says why', () => {
    const m = manager();
    const svc = new MarketHubService(config({ 'hub.enabled': false }) as any, m as any, tracker as any);
    svc.onModuleInit();
    expect(m.pin).not.toHaveBeenCalled();
    expect(svc.status()).toBeNull();
    expect(svc.disabledReason()).toMatch(/MARKET_HUB_ENABLED/);
    expect(svc.price({ exchange: 'NSE', token: '1', symbol: 'A' }, { maxAgeMs: 1 })).toEqual({
      kind: 'unavailable',
      reason: 'no-session',
    });
  });

  it('enabled without an owner reports a reason instead of starting', () => {
    const m = manager();
    const svc = new MarketHubService(
      config({ 'hub.enabled': true, 'hub.ownerUserId': '' }) as any,
      m as any,
      tracker as any,
    );
    svc.onModuleInit();
    expect(m.pin).not.toHaveBeenCalled();
    expect(svc.disabledReason()).toMatch(/HUB_OWNER_USER_ID/);
  });

  it('onModuleInit returns without awaiting the broker (boot must not block)', () => {
    const m = manager(); // pin never resolves
    const svc = new MarketHubService(
      config({ 'hub.enabled': true, 'hub.ownerUserId': 'owner', 'hub.slotCap': 50, 'hub.mcxLateClose': '' }) as any,
      m as any,
      tracker as any,
    );
    const result = svc.onModuleInit();
    expect(result).toBeUndefined();
    expect(m.pin).toHaveBeenCalledWith('owner', []);
    expect(svc.status()).not.toBeNull();
    svc.onModuleDestroy();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @td/api test -- hub-engine.spec market-hub.service.spec`
Expected: FAIL — `Cannot find module './hub-engine'` / `'./market-hub.service'`.

- [ ] **Step 4: Write `hub-engine.ts`**

```ts
import { DEFAULT_RATES, Governor, type GovernorMetrics } from './governor';
import type { HubBroker } from './hub-broker';
import { refKey, type InstrumentRef, type Price, type PriceResult, type Priority } from './hub.types';
import { LiveFeed } from './live-feed';
import { PriceBook } from './price-book';
import { QuoteBatcher } from './quote-batcher';
import { QuotePoller } from './quote-poller';
import type { SessionClock } from './session-clock';
import { WatchRegistry } from './watch-registry';
import { AngelThrottleError } from '../market-data/services/angel-throttle';

export interface HubEngineDeps {
  broker: HubBroker;
  clock: SessionClock;
  cap: number;
  /** Market-context instruments watched at priority 2 for as long as the hub runs. */
  defaults: readonly InstrumentRef[];
}

export interface HubStatus {
  socketUp: boolean;
  watched: number;
  slots: { live: number; cap: number; demotionsTotal: number; criticalOverflow: number };
  prices: {
    fresh: number;
    stale: number;
    marketClosed: number;
    unavailable: number;
    oldestP0AgeMs: number | null;
    unpricedP0: number;
  };
  governor: GovernorMetrics;
  calendar: { missingYear: number | null };
}

const POSITIONS = 'hub:positions';
const CONTEXT = 'hub:context';
const STATUS_MAX_AGE_MS = 5000;

/** Wires the hub's parts. No NestJS, no config — testable with a FakeBroker. */
export class HubEngine {
  readonly registry = new WatchRegistry();
  readonly book = new PriceBook();
  readonly governor: Governor;
  readonly feed: LiveFeed;
  private readonly poller: QuotePoller;
  private positions = new Map<string, InstrumentRef>();
  private expiryTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly d: HubEngineDeps) {
    this.governor = new Governor({
      ratesPerSec: DEFAULT_RATES,
      interactiveDeadlineMs: 5000,
      backgroundTrickleMs: 5000,
      maxBackoffMs: 30_000,
      isMarketHours: () => ['NSE', 'MCX'].some((ex) => d.clock.isOpen(ex)),
      isThrottle: (e) => e instanceof AngelThrottleError,
    });
    this.feed = new LiveFeed({ broker: d.broker, registry: this.registry, book: this.book, cap: d.cap });
    const batcher = new QuoteBatcher(this.governor, (refs) => d.broker.quotes(refs));
    this.poller = new QuotePoller({
      feed: this.feed,
      book: this.book,
      batcher,
      clock: d.clock,
      nearLiveTargetMs: 5000,
      criticalTargetMs: 2000,
    });
  }

  async start(): Promise<void> {
    await this.d.broker.connect();
    const now = Date.now();
    for (const ref of this.d.defaults) this.registry.watch(ref, 2, CONTEXT, now);
    await this.feed.reconcile();
    this.poller.start();
    this.expiryTimer = setInterval(() => {
      if (this.registry.expire(Date.now())) void this.feed.reconcile();
    }, 30_000);
    this.expiryTimer.unref?.();
  }

  stop(): void {
    this.poller.stop();
    if (this.expiryTimer) clearInterval(this.expiryTimer);
    this.expiryTimer = null;
    this.governor.dispose();
  }

  async watch(ref: InstrumentRef, priority: Priority, owner: string, ttlMs?: number): Promise<void> {
    this.registry.watch(ref, priority, owner, Date.now(), ttlMs);
    await this.feed.reconcile();
  }

  async unwatch(ref: InstrumentRef, owner: string): Promise<void> {
    this.registry.unwatch(ref, owner);
    await this.feed.reconcile();
  }

  /** Replace the set of open-position instruments (priority 0). */
  async setPositions(refs: readonly InstrumentRef[]): Promise<void> {
    const next = new Map(refs.map((r) => [refKey(r), r] as const));
    const now = Date.now();
    for (const [k, r] of this.positions) if (!next.has(k)) this.registry.unwatch(r, POSITIONS);
    for (const r of next.values()) this.registry.watch(r, 0, POSITIONS, now);
    this.positions = next;
    await this.feed.reconcile();
  }

  price(ref: InstrumentRef, opts: { maxAgeMs: number }): PriceResult {
    const now = Date.now();
    return this.book.get(ref, {
      maxAgeMs: opts.maxAgeMs,
      now,
      isOpen: (ex) => this.d.clock.isOpen(ex, new Date(now)),
      watched: (key) => this.registry.has(key),
    });
  }

  prices(refs: readonly InstrumentRef[], opts: { maxAgeMs: number }): Map<string, PriceResult> {
    return new Map(refs.map((r) => [refKey(r), this.price(r, opts)] as const));
  }

  onPrice(fn: (p: Price) => void): () => void {
    return this.feed.onPrice(fn);
  }

  status(): HubStatus {
    const now = Date.now();
    const counts = { fresh: 0, stale: 0, marketClosed: 0, unavailable: 0 };
    let oldestP0AgeMs: number | null = null;
    let unpricedP0 = 0;
    for (const e of this.registry.entries()) {
      const r = this.price(e.ref, { maxAgeMs: STATUS_MAX_AGE_MS });
      if (r.kind === 'fresh') counts.fresh++;
      else if (r.kind === 'stale') counts.stale++;
      else if (r.kind === 'market-closed') counts.marketClosed++;
      else counts.unavailable++;
      if (e.priority === 0) {
        const age = this.book.ageMs(refKey(e.ref), now);
        if (age === undefined) unpricedP0++;
        else if (oldestP0AgeMs === null || age > oldestP0AgeMs) oldestP0AgeMs = age;
      }
    }
    const m = this.feed.metrics();
    return {
      socketUp: m.socketUp,
      watched: this.registry.size(),
      slots: { live: m.live, cap: m.cap, demotionsTotal: m.demotionsTotal, criticalOverflow: m.criticalOverflow },
      prices: { ...counts, oldestP0AgeMs, unpricedP0 },
      governor: this.governor.metrics(now),
      calendar: { missingYear: this.d.clock.calendarGap(new Date(now)) },
    };
  }
}
```

- [ ] **Step 5: Write `market-hub.service.ts` and `market-hub.module.ts`**

`market-hub.service.ts`:

```ts
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { INDICES } from '@td/shared/constants';
import { UserFeedManager } from '../market-data/services/user-feed-manager.service';
import { MARKET_HOLIDAYS } from '../market-data/services/market-holidays.service';
import { TradeTrackerService } from '../trade-tracker/services/trade-tracker.service';
import { ManagerHubBroker } from './hub-broker';
import { HubEngine, type HubStatus } from './hub-engine';
import { refKey, type HubExchange, type InstrumentRef, type PriceResult, type Priority } from './hub.types';
import { SessionClock, type DateRange } from './session-clock';

const POSITION_REFRESH_MS = 60_000;
const CALENDAR_ALERT_MS = 24 * 60 * 60 * 1000;
const HUB_EXCHANGES = new Set<HubExchange>(['NSE', 'BSE', 'NFO', 'BFO', 'MCX']);

/** "2026-11-02:2027-03-08,2027-11-01:2028-03-13" → ranges. */
export function parseLateClose(raw: string | undefined): DateRange[] {
  return String(raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [from, to] = s.split(':');
      return { from, to };
    })
    .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.from) && /^\d{4}-\d{2}-\d{2}$/.test(r.to));
}

/**
 * SP1 market hub, M1: SHADOW. It prices a default context set and the owner's
 * open positions on the owner's shared session and reports metrics; no
 * existing consumer reads from it yet. Start is fire-and-forget: boot must
 * never wait on the broker.
 */
@Injectable()
export class MarketHubService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MarketHubService.name);
  readonly session: SessionClock;
  private engine: HubEngine | null = null;
  private reason: string | null = null;
  private timers: ReturnType<typeof setInterval>[] = [];

  constructor(
    private readonly config: ConfigService,
    private readonly manager: UserFeedManager,
    private readonly tracker: TradeTrackerService,
  ) {
    this.session = new SessionClock({
      holidays: MARKET_HOLIDAYS,
      mcxLateClose: parseLateClose(this.config.get<string>('hub.mcxLateClose')),
    });
  }

  onModuleInit(): void {
    if (!this.config.get<boolean>('hub.enabled')) {
      this.reason = 'disabled (MARKET_HUB_ENABLED is not true)';
      return;
    }
    const owner = this.config.get<string>('hub.ownerUserId');
    if (!owner) {
      this.reason = 'enabled but HUB_OWNER_USER_ID is not set';
      this.logger.error(`Market hub ${this.reason}`);
      return;
    }
    const defaults: InstrumentRef[] = [
      INDICES.NIFTY_50,
      INDICES.BANK_NIFTY,
      INDICES.FIN_NIFTY,
      INDICES.SENSEX,
    ].map((i) => ({ exchange: i.exchange as HubExchange, token: i.token, symbol: i.symbol }));
    const engine = new HubEngine({
      broker: new ManagerHubBroker(this.manager, owner),
      clock: this.session,
      cap: this.config.get<number>('hub.slotCap') ?? 50,
      defaults,
    });
    this.engine = engine;
    void engine
      .start()
      .then(() => this.refreshPositions(owner))
      .catch((err) => this.logger.error(`Market hub start failed: ${err?.message ?? err}`));
    const refresh = setInterval(() => void this.refreshPositions(owner), POSITION_REFRESH_MS);
    const calendar = setInterval(() => this.checkCalendar(), CALENDAR_ALERT_MS);
    refresh.unref?.();
    calendar.unref?.();
    this.timers = [refresh, calendar];
    this.checkCalendar();
  }

  onModuleDestroy(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.engine?.stop();
  }

  disabledReason(): string | null {
    return this.reason;
  }

  status(): HubStatus | null {
    return this.engine ? this.engine.status() : null;
  }

  price(ref: InstrumentRef, opts: { maxAgeMs: number }): PriceResult {
    return this.engine ? this.engine.price(ref, opts) : { kind: 'unavailable', reason: 'no-session' };
  }

  prices(refs: readonly InstrumentRef[], opts: { maxAgeMs: number }): Map<string, PriceResult> {
    return new Map(refs.map((r) => [refKey(r), this.price(r, opts)] as const));
  }

  watch(ref: InstrumentRef, priority: Priority, owner: string, ttlMs?: number): Promise<void> {
    return this.engine ? this.engine.watch(ref, priority, owner, ttlMs) : Promise.resolve();
  }

  unwatch(ref: InstrumentRef, owner: string): Promise<void> {
    return this.engine ? this.engine.unwatch(ref, owner) : Promise.resolve();
  }

  private async refreshPositions(owner: string): Promise<void> {
    if (!this.engine) return;
    try {
      const byUser = await this.tracker.openTrackerRefsByUser();
      const refs = (byUser.get(owner) ?? [])
        .filter((t) => HUB_EXCHANGES.has(t.exchange.toUpperCase() as HubExchange))
        .map((t) => ({
          exchange: t.exchange.toUpperCase() as HubExchange,
          token: t.token,
          symbol: t.token,
        }));
      await this.engine.setPositions(refs);
    } catch (err) {
      this.logger.warn(`Market hub position refresh failed: ${(err as Error)?.message ?? err}`);
    }
  }

  private checkCalendar(): void {
    const missing = this.session.calendarGap();
    if (missing !== null) {
      this.logger.error(
        `Market holiday list for ${missing} is missing — add it to MARKET_HOLIDAYS (market-holidays.service.ts)`,
      );
    }
  }
}
```

`market-hub.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { MarketDataModule } from '../market-data/market-data.module';
import { TradeTrackerModule } from '../trade-tracker/trade-tracker.module';
import { MarketHubService } from './market-hub.service';

/**
 * SP1 market data hub. M1 = shadow: running behind MARKET_HUB_ENABLED with
 * metrics, consumed by nobody yet. Imports MarketDataModule for the shared
 * per-user session (UserFeedManager) and TradeTrackerModule for open positions.
 */
@Module({
  imports: [MarketDataModule, TradeTrackerModule],
  providers: [MarketHubService],
  exports: [MarketHubService],
})
export class MarketHubModule {}
```

- [ ] **Step 6: Config, registration, env template**

In `apps/api/src/config/configuration.ts`, add after the `feed` block:

```ts
  hub: {
    // SP1 market data hub (shadow in M1). Off unless explicitly enabled.
    enabled: process.env.MARKET_HUB_ENABLED === 'true',
    // The user whose own Angel One session the hub shares (personal MVP: the owner).
    ownerUserId: process.env.HUB_OWNER_USER_ID || '',
    // WebSocket live-slot cap. Angel allows 1000 per connection; 50 keeps M1 conservative.
    slotCap: +(process.env.HUB_SLOT_CAP || 50),
    // MCX 23:55 close windows, "YYYY-MM-DD:YYYY-MM-DD" comma-separated (US-DST-linked).
    mcxLateClose: process.env.HUB_MCX_LATE_CLOSE || '',
  },
```

In `apps/api/src/app.module.ts`: add `import { MarketHubModule } from './modules/market-hub/market-hub.module';` and add `MarketHubModule,` to `imports` immediately after `TradeTrackerModule,`.

In `deploy/env/api.env.example`, append:

```bash
# SP1 market data hub — shadow mode in M1 (no consumer reads from it yet).
MARKET_HUB_ENABLED=false
# Your own GrW user id (users.id); the hub shares YOUR Angel One session.
HUB_OWNER_USER_ID=
HUB_SLOT_CAP=50
# MCX 23:55 close windows, e.g. 2026-11-02:2027-03-08
HUB_MCX_LATE_CLOSE=
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm --filter @td/api test -- hub-engine.spec market-hub.service.spec`
Expected: PASS, 7 tests.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/modules/market-hub/hub-engine.ts apps/api/src/modules/market-hub/hub-engine.spec.ts apps/api/src/modules/market-hub/market-hub.service.ts apps/api/src/modules/market-hub/market-hub.service.spec.ts apps/api/src/modules/market-hub/market-hub.module.ts apps/api/src/config/configuration.ts apps/api/src/app.module.ts deploy/env/api.env.example
git commit -m "feat(market-hub): engine and shadow service on the owner's session, off by default" -- apps/api/src/modules/market-hub/hub-engine.ts apps/api/src/modules/market-hub/hub-engine.spec.ts apps/api/src/modules/market-hub/market-hub.service.ts apps/api/src/modules/market-hub/market-hub.service.spec.ts apps/api/src/modules/market-hub/market-hub.module.ts apps/api/src/config/configuration.ts apps/api/src/app.module.ts deploy/env/api.env.example
```

---

### Task 11: `/healthz/detail` hub signal

**Files:**
- Modify: `apps/api/src/modules/health/health.types.ts` (token)
- Modify: `apps/api/src/modules/health/health-detail.service.ts`
- Modify: `apps/api/src/modules/health/health.module.ts`
- Test: `apps/api/src/modules/health/health-detail.service.spec.ts` (append)

**Interfaces:**
- Consumes: `MarketHubService.status()`, `disabledReason()` (Task 10); `HubStatus`.
- Produces: `HUB_STATUS_SOURCE` token; `HealthDetailPayload.hub: Signal<HubStatus>`.

- [ ] **Step 1: Write the failing test** (append inside `describe('HealthDetailService', …)`)

```ts
  it('reports the market hub status when it is running', async () => {
    const runs = { lastRunPerJob: jest.fn().mockResolvedValue([]) };
    const hub = { status: () => ({ socketUp: true, watched: 5 }), disabledReason: () => null };
    const svc = new HealthDetailService(makePrisma() as never, runs as never, null, hub as never);
    const out = await svc.check();
    expect(out.hub.available).toBe(true);
    if (out.hub.available) expect(out.hub.value.watched).toBe(5);
  });

  it('says why the hub is idle instead of hiding it', async () => {
    const runs = { lastRunPerJob: jest.fn().mockResolvedValue([]) };
    const hub = { status: () => null, disabledReason: () => 'enabled but HUB_OWNER_USER_ID is not set' };
    const svc = new HealthDetailService(makePrisma() as never, runs as never, null, hub as never);
    const out = await svc.check();
    expect(out.hub).toEqual({ available: false, reason: 'enabled but HUB_OWNER_USER_ID is not set' });
  });
```

(If `unavailable(reason)` in `health.types.ts` produces a different object shape, assert `out.hub.available === false` and the reason field it uses — read `health.types.ts:14-24` first.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @td/api test -- health-detail.service.spec`
Expected: FAIL — `out.hub` is undefined.

- [ ] **Step 3: Implement**

In `health.types.ts`, next to `FEED_STATUS_SOURCE`:

```ts
export const HUB_STATUS_SOURCE = 'HEALTH_HUB_STATUS_SOURCE';
```

In `health-detail.service.ts`:

```ts
import type { HubStatus } from '../market-hub/hub-engine';
import { FEED_STATUS_SOURCE, HUB_STATUS_SOURCE, present, unavailable, type Signal } from './health.types';

/** The narrow slice of MarketHubService this surface reads. */
export interface HubStatusSource {
  status(): HubStatus | null;
  disabledReason(): string | null;
}
```

Add `hub: Signal<HubStatus>;` to `HealthDetailPayload`; add a fourth constructor parameter

```ts
    @Optional()
    @Inject(HUB_STATUS_SOURCE)
    private readonly hub: HubStatusSource | null = null,
```

include `Promise.resolve(this.checkHub())` in `check()` (destructure `hub`, return it), and add:

```ts
  private checkHub(): Signal<HubStatus> {
    if (!this.hub) return unavailable('market hub not resolvable from this container');
    try {
      const s = this.hub.status();
      if (s) return present(s, 'MarketHubService.status');
      return unavailable(this.hub.disabledReason() ?? 'market hub not started');
    } catch (err) {
      return unavailable(describe(err));
    }
  }
```

In `health.module.ts`: add `MarketHubModule` to `imports` and the provider
`{ provide: HUB_STATUS_SOURCE, useExisting: MarketHubService }` (imports from
`../market-hub/market-hub.module`, `../market-hub/market-hub.service`, `./health.types`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @td/api test -- health`
Expected: PASS — all health specs including the 2 new ones.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/health/health.types.ts apps/api/src/modules/health/health-detail.service.ts apps/api/src/modules/health/health-detail.service.spec.ts apps/api/src/modules/health/health.module.ts
git commit -m "feat(health): market hub status on /healthz/detail, with the reason when idle" -- apps/api/src/modules/health/health.types.ts apps/api/src/modules/health/health-detail.service.ts apps/api/src/modules/health/health-detail.service.spec.ts apps/api/src/modules/health/health.module.ts
```

---

### Task 12: The "only door" architecture test

**Files:**
- Create: `apps/api/src/modules/market-hub/only-door.spec.ts`

**Interfaces:**
- Produces: a ratchet: fails if any non-test file outside `modules/market-hub/` calls a broker market-data method, unless it is on `KNOWN_VIOLATORS`; also fails if a listed file no longer violates (so the list only shrinks). M6 empties the list.

- [ ] **Step 1: Write the test with an EMPTY allow-list (it must fail and name today's violators)**

`only-door.spec.ts`:

```ts
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, sep } from 'path';

/**
 * THE ONLY DOOR. The market hub is the only component allowed to request
 * market data from Angel One. Today's code still has direct callers; they are
 * listed here and the list may only SHRINK — M6 empties it. Orders (placeOrder
 * etc.) are not market data and are out of scope.
 */
const SRC = join(__dirname, '..', '..');
const BROKER_DATA_CALL = /\.(getCandleData|marketData|searchScrip|optionGreek)\(|new WebSocketV2\(/;

export const KNOWN_VIOLATORS: readonly string[] = [];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts') && !p.endsWith('.spec.ts')) out.push(p);
  }
  return out;
}

function violators(): string[] {
  return walk(SRC)
    .map((p) => relative(SRC, p).split(sep).join('/'))
    .filter((rel) => !rel.startsWith('modules/market-hub/'))
    .filter((rel) => BROKER_DATA_CALL.test(readFileSync(join(SRC, rel), 'utf8')))
    .sort();
}

describe('only door to the broker for market data', () => {
  it('no file outside market-hub calls the broker for market data, except the shrinking list', () => {
    const unexpected = violators().filter((f) => !KNOWN_VIOLATORS.includes(f));
    expect(unexpected).toEqual([]);
  });

  it('every listed file still violates — remove it from the list once it is fixed', () => {
    const now = new Set(violators());
    expect(KNOWN_VIOLATORS.filter((f) => !now.has(f))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to see today's violators**

Run: `pnpm --filter @td/api test -- only-door.spec`
Expected: FAIL — `unexpected` lists exactly these 6 files (verified 2026-10-05):

```
modules/market-data/controllers/market-data.controller.ts
modules/market-data/market-data.module.ts
modules/market-data/services/angel-one-adapter.service.ts
modules/market-data/services/angel-one-websocket.service.ts
modules/market-data/services/user-feed-session.ts
modules/options-chain/services/options-chain.service.ts
```

If the list differs, use the list the test prints (code moved since this plan was written) and note it in the ledger.

- [ ] **Step 3: Fill the allow-list**

Replace `export const KNOWN_VIOLATORS: readonly string[] = [];` with:

```ts
export const KNOWN_VIOLATORS: readonly string[] = [
  // M2/M6: chart endpoints move to the hub's CandleStore; debug getCandleData endpoint deleted.
  'modules/market-data/controllers/market-data.controller.ts',
  // M6: WebSocketV2 construction moves into the hub's BrokerSession.
  'modules/market-data/market-data.module.ts',
  // M6: the shared "feed account" stack is deleted.
  'modules/market-data/services/angel-one-adapter.service.ts',
  'modules/market-data/services/angel-one-websocket.service.ts',
  // M6: the per-user session moves under modules/market-hub (it IS the hub's broker session).
  'modules/market-data/services/user-feed-session.ts',
  // M5: option chain served by the hub.
  'modules/options-chain/services/options-chain.service.ts',
];
```

- [ ] **Step 4: Run test to verify it passes, then prove it can fail**

Run: `pnpm --filter @td/api test -- only-door.spec`
Expected: PASS, 2 tests.

Mutation check: temporarily add `void (null as any)?.marketData({});` to any file under `modules/portfolio/` and rerun — Expected: FAIL naming that file. Revert the line.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/market-hub/only-door.spec.ts
git commit -m "test(market-hub): only-door ratchet — broker market-data calls outside the hub may only shrink" -- apps/api/src/modules/market-hub/only-door.spec.ts
```

---

### Task 13: Verify Angel One facts, then the whole suite

**Files:**
- Modify: `docs/superpowers/plans/2026-10-05-sp1-m1-market-hub-core.md` (fill the "Verified broker facts" section below)

- [ ] **Step 1: Verify and record broker facts**

Check each against the SmartAPI docs/forum (links below) and record the result — with the date and the source URL — in the table at the end of this plan:

| Fact | Plan assumption | Where to check |
|---|---|---|
| WebSocketV2 tokens per connection | 1000 per session; each (token, mode) counts once; duplicates ignored | forum topic 676 "How many tokens can be subscribed at a time in websocket?"; docs `/docs` WebSocket 2.0 |
| WebSocketV2 connections per client code | 3 concurrent | forum topic 4391 "WebSocket Streaming size and max connections" |
| Quote / candles / search / greeks limits | 10/s (50 symbols per call) · 3/s · 1/s · 1/s, per client code | forum topic 4387 "Changes in API Rate Limit"; topic 4056 (quote bulk) |
| Throttle response shape for `getCandleData` | HTTP 200, `data: null`, message "Access denied because of exceeding access rate" | `angel-throttle.ts` comment (empirical); forum topic 5639 |
| Throttle response shape for `marketData` | assumed the same `data: null` shape | forum search "marketData exceeding access rate"; if different, adjust `getQuotes(…, { throwOnThrottle })` in Task 6 and add a test for the real shape |

- [ ] **Step 2: Run the whole API suite and typecheck**

Run: `pnpm --filter @td/api test 2>&1 | tail -15`
Expected: all suites pass (record the totals in the ledger).
Run: `pnpm --filter @td/api exec tsc --noEmit -p tsconfig.json`
Expected: exit 0, no errors.

- [ ] **Step 3: Commit the recorded facts**

```bash
git add docs/superpowers/plans/2026-10-05-sp1-m1-market-hub-core.md
git commit -m "docs(plans): record verified Angel One limits for the market hub" -- docs/superpowers/plans/2026-10-05-sp1-m1-market-hub-core.md
```

---

## M1 production gate (after deploy, owner-run)

Set `MARKET_HUB_ENABLED=true` and `HUB_OWNER_USER_ID=<your users.id>` on the server, then during one
full NSE session read `/healthz/detail` → `hub`:

- `socketUp: true` for the session; `slots.live` ≈ 4 + open positions; `slots.criticalOverflow: 0`
- `prices.unpricedP0: 0` and `prices.oldestP0AgeMs` < 5000 while NSE/NFO is open
- `governor.endpoints.*.throttlesLastHour` ≈ 0; `governor.lanes[2].waitP95Ms` small
- `calendar.missingYear: null`
- RSS (`memory`) healthy on the 2 GB host

M1 is complete when this is observed in production, not when the tests pass (parent spec rule).

## Notes for M2–M6 (not in this plan)

- Underlyings of option/future positions (priority 1) need instrument-master parsing — M3.
- MCX context symbols (CRUDEOIL front month) roll monthly — add when the hub owns the roll (M6).
- `UserFeedSession` moves under `modules/market-hub/` and drops off `KNOWN_VIOLATORS` in M6.
- The gateway's `toTokenRef` NSE hard-code is fixed in M4.

## Verified broker facts

Seeded 2026-10-05 from search results; Task 13 confirms or corrects each line.

| Fact | Value | Source | Verified on |
|---|---|---|---|
| WebSocketV2 tokens per connection | 1000 (per token+mode; duplicates ignored) | https://smartapi.angelone.in/smartapi/forum/topic/676/how-many-tokens-can-be-subscribed-at-a-time-in-websocket | pending Task 13 |
| WebSocketV2 connections per client code | 3 | https://smartapi.angelone.in/smartapi/forum/topic/4391/websocket-streaming-size-and-max-connections | pending Task 13 |
| REST limits | quote 10/s (≤ 50 symbols), candles 3/s, search 1/s, greeks 1/s, per client code | https://smartapi.angelone.in/smartapi/forum/topic/4387/changes-in-api-rate-limit | pending Task 13 |
| Candle throttle shape | `data: null` + "Access denied because of exceeding access rate" | `apps/api/src/modules/market-data/services/angel-throttle.ts` (empirical) | pending Task 13 |
| Quote throttle shape | assumed `data: null` | — | pending Task 13 |
