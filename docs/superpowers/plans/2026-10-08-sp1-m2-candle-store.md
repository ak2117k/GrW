# SP1 · M2 — CandleStore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Scope:** migration step **M2 only** of the SP1 spec: the hub's CandleStore, its tables, the nightly
fix-up, and `/candles` served by the hub behind a switch. M3–M6 get their own plans. The legacy
`candles` table, `CandleAggregatorService`, `DailyBackfillWorker`, `DailyCandleBackfillCron` and
`GapDetectorService` are **not touched** (they run on the dead shared feed account and are deleted in M6).

**Goal:** Charts read candles from our own database. Live-tier instruments get tick-built 1-minute
bars, missing ranges are filled once from Angel One through the Governor and remembered, the broker's
official bars replace tick-built ones every night, and `GET /api/market-data/instruments/:token/candles`
is answered by the hub when `HUB_SERVES_CHARTS=true`.

**Architecture:** Three tables keyed by `(exchange, token, ts)`: `candles_1m` (tick or broker
bars), `candles_1h` (Angel's native hourly bars, 365 days per call), `candles_1d` (official daily),
plus `candle_coverage` (which past days the broker has already been asked for, so an illiquid
instrument's genuinely empty minutes are never re-fetched). 5m/15m/30m (and today's 1h) are grouped
on read from `candles_1m` with Postgres `date_bin`, aligned to the session open; 1w/1mo roll up
`candles_1d` with the existing `aggregateCandles`. The migration turns `candles_1m` into a
TimescaleDB hypertable with compression and 180-day retention **where the database has TimescaleDB**
(the VPS), and leaves plain tables elsewhere (Neon), so the same `main` deploys to both. Pure units
(calendar, builder, store) are tested with an in-memory repository; the SQL is tested against a real
TimescaleDB in an opt-in integration suite.

**Tech Stack:** NestJS 10, TypeScript 5.7, Prisma 6 (raw SQL via `Prisma.sql`), PostgreSQL 16/17 +
TimescaleDB, Jest 29 (`ts-jest`, `isolatedModules`), `@nestjs/schedule` 5, pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-10-05-sp1-market-data-hub-design.md` (§6 CandleStore, §9 M2 row,
§10 testing). Builds on the M1 plan `docs/superpowers/plans/2026-10-05-sp1-m1-market-hub-core.md`.

**Test command (all tasks):** `pnpm --filter @td/api test -- <file-pattern>`. Jest `rootDir` is
`apps/api/src`, `testRegex` is `.*\.spec\.ts$`. Example: `pnpm --filter @td/api test -- trading-calendar.spec`.
The integration suite (Task 3) has its own config under `apps/api/test/sp1-m2/`.

## Decisions taken with the owner (2026-10-08), deviating from spec §6.1

1. **Storage = TimescaleDB where available, plain Postgres otherwise.** Production still runs on Neon
   until the Vyom VPS is live. Neon has only TimescaleDB's Apache-licensed subset (no compression,
   no continuous aggregates). The migration therefore enables hypertable/compression/retention only
   when the server has the full TimescaleDB, and never fails on plain Postgres.
2. **No continuous aggregates.** 5m/15m/30m are grouped on read with `date_bin`. Their windows are
   at most 30 days (≈ 26 k one-minute rows for MCX), which Postgres groups in milliseconds, and
   continuous aggregates cannot be created inside Prisma's per-migration transaction.
3. **A `candles_1h` table.** Angel truncates sub-hour requests to one day per call, so building 60 days
   of 1h history from 1m would cost 60 calls. Native hourly bars cost one call per 365 days.

## Global Constraints

- The hub is the only component meant to request market data from Angel One. New broker calls live in
  `modules/market-hub/` or in files already on `KNOWN_VIOLATORS` in `only-door.spec.ts` (the
  `user-feed-session.ts` addition is allowed; the list must not grow).
- **No shared "feed account".** Every candle fetch goes through `ManagerHubBroker` on the owner's
  per-user session (`HUB_OWNER_USER_ID`), never a second login.
- Flags: `HUB_CANDLES_ENABLED` (runs the CandleStore: tick bars, gap fill, nightly fix-up) and
  `HUB_SERVES_CHARTS` (the `/candles` switch), both default **false**, both need
  `MARKET_HUB_ENABLED=true`. With either off, behaviour is exactly M1's.
- Personal MVP: with `HUB_SERVES_CHARTS=true` the hub serves the chart to **every** user from the
  owner's session (one hub). Multi-tenant fan-out is out of scope (spec §12).
- Every broker candle call is ONE `getCandleData` window sent through `Governor.submit` with
  `endpoint: 'candles'` (budget 2.5/s). Window sizes per call: `ONE_MINUTE` 1 day, `ONE_HOUR`
  365 days, `ONE_DAY` 1800 days (`TIMEFRAME_MAX_RANGE_DAYS`, empirical).
- A throttle is `Throttled`, never `[]`: a failed fill is reported in `incomplete` and the day is
  **not** marked covered.
- Instruments are `{ exchange, token, symbol }`; every table and map is keyed by **exchange + token**,
  never token alone.
- Times: bars carry `ts` = bar start as **ms epoch** (UTC instant). IST is used only inside
  `trading-calendar.ts` and SQL (`AT TIME ZONE 'Asia/Kolkata'`, `date_bin` origin `+05:30`).
  Columns are `TIMESTAMPTZ(3)`. Every SQL timestamp parameter is an ISO string cast `::timestamptz`.
- Bar boundaries: 1m on the minute; 1h at session open + k·60 min (NSE 09:15, 10:15 … 15:15; MCX
  09:00 …); 1d at IST midnight (Angel's daily timestamp `YYYY-MM-DDT00:00:00+05:30`).
- Tick volume is cumulative for the day: bar volume = **difference** between ticks; the first tick of
  an instrument on a day is a baseline (volume 0).
- Source precedence in `candles_1m`: `broker` overwrites `tick`; `tick` never overwrites `broker`.
- A bar is stored only once it is complete (end ≤ the time the data was obtained). No forming bars in
  the database.
- **Migrations must be expand-only** (SP0 rule). This migration only creates tables.
- **2 GB host:** bounded memory: in-flight tick bars ≤ live instruments, pending tick writes ≤ 20 000
  bars, read-latency samples ≤ 200, today-coverage map pruned daily.
- **Boot must not block:** nothing in `onModuleInit` awaits the network or the database.
- Commits use explicit pathspecs (`git commit -- <paths>`), never bare `git commit` / `-a`.

## Review Focus

1. **An illiquid instrument with genuinely empty minutes** (no trades). The store must ask the broker
   for that day once, then never again, even though the day stays "short". (Task 5 test "fills a
   missing past day once and remembers it, even when the broker has fewer bars than expected".)
2. **A throttled or busy broker during a chart load** must come back as `incomplete` with a reason,
   leave the day uncovered, and be retried on the next load, never cached as "no data". (Task 5 test
   "a throttled fill is reported as incomplete and retried next time".)
3. **Forming bars.** A broker response that includes the current, unfinished minute, or a tick bar
   for a minute the broker already supplied, must not freeze a partial bar into history. (Task 5 test
   "today: drops the forming bar and re-fetches only after a new bar completes"; Task 3 integration
   test "broker overwrites tick, tick never overwrites broker".)
4. **The migration on Neon / plain Postgres** (no TimescaleDB) must succeed and create plain tables,
   so deploying `main` before the VPS move cannot break production. (Task 3 Step 9 applies all
   migrations to a plain `postgres:17` container.)
5. **Hub restart mid-session, and the first tick of the day.** The running day volume must not land in
   one minute as a giant spike. (Task 2 test "first tick of the day only sets the baseline".)

---

## File Structure

| Path | Responsibility |
|---|---|
| `market-hub/candles/candle.types.ts` | `Timeframe`, `CandleTable`, `HubCandle`, `IncompleteRange`, `CandlesResult`, `BrokerInterval`, lookup tables |
| `market-hub/candles/trading-calendar.ts` | IST day helpers; expected completed bars per day (`expectedPerDay`); `barEnd` |
| `market-hub/candles/candle-builder.ts` | Prices → 1-minute bars with volume difference |
| `market-hub/candles/candle-repository.ts` | `CandleRepo` interface + `PrismaCandleRepo` (raw SQL) |
| `market-hub/candles/candle-store.ts` | Read path: gaps → Governor fills → DB read; coverage; nightly `fixup` |
| `market-hub/candles/serve-chart.ts` | `/candles` decision + response mapping (legacy shape) |
| `market-hub/hub-candle-source.ts` | `HUB_CANDLE_SOURCE` token + `HubCandleSource` interface (no runtime imports) |
| `market-hub/testing/memory-candle-repo.ts` | In-memory `CandleRepo` for unit tests |
| Modify `market-hub/session-clock.ts` | `tradingWindow(exchange, at)` |
| Modify `market-hub/hub.types.ts` | `isHubExchange()` |
| Modify `market-hub/hub-broker.ts`, `testing/fake-broker.ts` | `candles(ref, interval, from, to)` |
| Modify `market-hub/hub-engine.ts` | Builder wiring, tick-bar writer, `candles()`, `runFixup()`, `status().candles` |
| Modify `market-hub/market-hub.service.ts`, `market-hub.module.ts` | Flags, Prisma repo, `servesCharts()`, `candles()`, nightly cron, token provider |
| Modify `market-data/services/angel-throttle.ts` | `throwForMissingData()` (shared with quotes) |
| Modify `market-data/services/user-feed-session.ts`, `user-feed-manager.service.ts` | One-window `getCandleWindow` / `fetchCandleWindow` |
| Modify `market-data/controllers/market-data.controller.ts` | Try the hub first in `getCandles` |
| Modify `config/configuration.ts`, `deploy/env/api.env.example` | `HUB_CANDLES_ENABLED`, `HUB_SERVES_CHARTS` |
| Create `prisma/migrations/20261008120000_sp1_m2_candle_store/migration.sql`; modify `prisma/schema.prisma` | Tables + guarded TimescaleDB setup |
| Create `apps/api/test/sp1-m2/jest.config.js`, `candle-repository.int.spec.ts` | Opt-in SQL tests on real TimescaleDB |

`market-hub/…`, `market-data/…` paths are under `apps/api/src/modules/`; `config/…` under `apps/api/src/`.

---

### Task 1: Trading calendar foundation

**Files:**
- Modify: `apps/api/src/modules/market-hub/session-clock.ts` (add `tradingWindow`)
- Modify: `apps/api/src/modules/market-hub/session-clock.spec.ts`
- Modify: `apps/api/src/modules/market-hub/hub.types.ts` (add `isHubExchange`)
- Create: `apps/api/src/modules/market-hub/candles/candle.types.ts`
- Create: `apps/api/src/modules/market-hub/candles/trading-calendar.ts`
- Test: `apps/api/src/modules/market-hub/candles/trading-calendar.spec.ts`

**Interfaces:**
- Consumes: `SessionClock` (M1), `SessionWindow` from `trade-sentinel/market-sessions.ts` (`{ openMin, closeMin }`, IST minutes).
- Produces:
  - `SessionClock.tradingWindow(exchange: string, at?: Date): SessionWindow | null`
  - `isHubExchange(x: string): x is HubExchange`
  - `candle.types.ts`: `Timeframe`, `isTimeframe`, `CandleTable`, `HubCandle`, `BrokerInterval`, `IncompleteReason`, `IncompleteRange`, `CandlesResult`, `BASE_TABLE`, `STEP_MIN`, `TABLE_BAR_MIN`, `TABLE_INTERVAL`, `TABLE_MAX_DAYS`
  - `trading-calendar.ts`: `istDay(ms): string`, `istMidnight(ymd): number`, `addDays(ymd, n): string`, `expectedPerDay(clock, exchange, table, from, to, asOf): Map<string, number>`, `barEnd(clock, exchange, table, start): number`

- [ ] **Step 1: Write the failing tests**

Append to `session-clock.spec.ts` inside `describe('SessionClock', …)` (the file already has `clock` and an `ist(...)` helper; this test builds its own instants):

```typescript
  it('exposes the trading window for a trading day and null otherwise', () => {
    const at = (s: string) => new Date(Date.parse(`${s}+05:30`));
    expect(clock.tradingWindow('NSE', at('2026-10-07T12:00:00'))).toEqual({ openMin: 555, closeMin: 930 });
    expect(clock.tradingWindow('NSE', at('2026-10-10T12:00:00'))).toBeNull(); // Saturday
    const late = new SessionClock({
      holidays: MARKET_HOLIDAYS,
      mcxLateClose: [{ from: '2026-11-02', to: '2027-03-08' }],
    });
    expect(late.tradingWindow('MCX', at('2026-11-04T12:00:00'))).toEqual({ openMin: 540, closeMin: 1435 });
  });
```

Create `candles/trading-calendar.spec.ts`:

```typescript
import { SessionClock } from '../session-clock';
import { addDays, barEnd, expectedPerDay, istDay, istMidnight } from './trading-calendar';

const ist = (s: string) => Date.parse(`${s}+05:30`);
const clock = new SessionClock({
  holidays: { 2026: [{ date: '2026-10-02', name: 'Gandhi Jayanti', exchanges: ['NSE', 'BSE', 'NFO', 'MCX'] }] },
  mcxLateClose: [{ from: '2026-11-02', to: '2027-03-08' }],
});
const day = (ymd: string) => ({ from: istMidnight(ymd), to: istMidnight(addDays(ymd, 1)) });

describe('trading calendar', () => {
  it('converts between instants and IST dates at the IST midnight boundary', () => {
    expect(istDay(Date.parse('2026-10-07T18:29:59Z'))).toBe('2026-10-07');
    expect(istDay(Date.parse('2026-10-07T18:30:00Z'))).toBe('2026-10-08');
    expect(istMidnight('2026-10-08')).toBe(Date.parse('2026-10-07T18:30:00Z'));
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-11-01', -1)).toBe('2026-10-31');
  });

  it('expects 375 one-minute, 7 hourly and 1 daily NSE bars on a full weekday', () => {
    const { from, to } = day('2026-10-07');
    const asOf = ist('2026-10-07T16:00:00');
    expect(expectedPerDay(clock, 'NSE', '1m', from, to, asOf)).toEqual(new Map([['2026-10-07', 375]]));
    expect(expectedPerDay(clock, 'NSE', '1h', from, to, asOf)).toEqual(new Map([['2026-10-07', 7]]));
    expect(expectedPerDay(clock, 'NSE', '1d', from, to, asOf)).toEqual(new Map([['2026-10-07', 1]]));
  });

  it('counts only completed bars', () => {
    const { from, to } = day('2026-10-07');
    // 10:00:30 → 09:15..09:59 are complete; the 10:00 bar ends at 10:01.
    expect(expectedPerDay(clock, 'NSE', '1m', from, to, ist('2026-10-07T10:00:30')).get('2026-10-07')).toBe(45);
    // The daily bar is complete only after the close.
    expect(expectedPerDay(clock, 'NSE', '1d', from, to, ist('2026-10-07T15:00:00')).size).toBe(0);
    // The last hourly bar (15:15) ends at the 15:30 close, not 16:15.
    expect(expectedPerDay(clock, 'NSE', '1h', from, to, ist('2026-10-07T15:30:00')).get('2026-10-07')).toBe(7);
  });

  it('omits weekends and holidays', () => {
    const from = istMidnight('2026-10-01'); // Thu
    const to = istMidnight('2026-10-06'); // Tue (exclusive)
    const asOf = ist('2026-10-07T00:00:00');
    // Thu 1, Fri 2 holiday, Sat 3, Sun 4, Mon 5
    expect([...expectedPerDay(clock, 'NSE', '1d', from, to, asOf).keys()]).toEqual(['2026-10-01', '2026-10-05']);
  });

  it('follows MCX hours, including the late-close window', () => {
    const asOf = ist('2026-11-06T00:00:00');
    expect(expectedPerDay(clock, 'MCX', '1m', day('2026-10-07').from, day('2026-10-07').to, asOf).get('2026-10-07')).toBe(870);
    expect(expectedPerDay(clock, 'MCX', '1m', day('2026-11-04').from, day('2026-11-04').to, asOf).get('2026-11-04')).toBe(895);
  });

  it('clips to the half-open range [from, to)', () => {
    const n = expectedPerDay(clock, 'NSE', '1m', ist('2026-10-07T10:00:00'), ist('2026-10-07T11:00:00'), ist('2026-10-08T00:00:00'));
    expect(n.get('2026-10-07')).toBe(60);
  });

  it('gives bar ends, clipped to the session close', () => {
    expect(barEnd(clock, 'NSE', '1m', ist('2026-10-07T10:00:00'))).toBe(ist('2026-10-07T10:01:00'));
    expect(barEnd(clock, 'NSE', '1h', ist('2026-10-07T15:15:00'))).toBe(ist('2026-10-07T15:30:00'));
    expect(barEnd(clock, 'NSE', '1d', istMidnight('2026-10-07'))).toBe(ist('2026-10-07T15:30:00'));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @td/api test -- session-clock.spec trading-calendar.spec`
Expected: FAIL. `tradingWindow is not a function`; `Cannot find module './trading-calendar'`.

- [ ] **Step 3: Implement**

In `session-clock.ts`, add this public method to `SessionClock` (directly after `isOpen`):

```typescript
  /** The trading window (IST minutes) on `at`'s IST date, or null when the exchange does not trade that day. */
  tradingWindow(exchange: string, at: Date = new Date()): SessionWindow | null {
    return this.isTradingDay(exchange, at) ? this.window(exchange, at) : null;
  }
```

In `hub.types.ts`, append:

```typescript
const HUB_EXCHANGES: ReadonlySet<string> = new Set<HubExchange>(['NSE', 'BSE', 'NFO', 'BFO', 'MCX']);

export function isHubExchange(x: string): x is HubExchange {
  return HUB_EXCHANGES.has(x);
}
```

Create `candles/candle.types.ts`:

```typescript
/** Chart timeframes the CandleStore serves (the strings the web client sends). */
export type Timeframe = '1m' | '5m' | '15m' | '30m' | '1h' | '1d' | '1w' | '1mo';
const TIMEFRAMES: ReadonlySet<string> = new Set<Timeframe>(['1m', '5m', '15m', '30m', '1h', '1d', '1w', '1mo']);
export function isTimeframe(x: string): x is Timeframe {
  return TIMEFRAMES.has(x);
}

/** The three stored series. */
export type CandleTable = '1m' | '1h' | '1d';

/** One bar. `ts` = bar start, ms epoch. Volume is the bar's own volume (never cumulative). */
export interface HubCandle {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  oi?: number;
}

export type BrokerInterval = 'ONE_MINUTE' | 'ONE_HOUR' | 'ONE_DAY';

/** Why a range is missing from a result. `deferred` = being filled in the background. */
export type IncompleteReason = 'throttled' | 'busy' | 'error' | 'deferred';
/** Half-open [from, to), ms epoch. */
export interface IncompleteRange {
  from: number;
  to: number;
  reason: IncompleteReason;
}

export interface CandlesResult {
  candles: HubCandle[];
  incomplete: IncompleteRange[];
}

/** Which stored series a timeframe reads (1h's history; today's 1h comes from 1m). */
export const BASE_TABLE: Record<Timeframe, CandleTable> = {
  '1m': '1m', '5m': '1m', '15m': '1m', '30m': '1m', '1h': '1h', '1d': '1d', '1w': '1d', '1mo': '1d',
};

/** Bucket width when a timeframe is grouped from 1-minute bars. */
export const STEP_MIN: Record<'5m' | '15m' | '30m' | '1h', number> = { '5m': 5, '15m': 15, '30m': 30, '1h': 60 };

export const TABLE_BAR_MIN: Record<CandleTable, number> = { '1m': 1, '1h': 60, '1d': 1440 };
export const TABLE_INTERVAL: Record<CandleTable, BrokerInterval> = { '1m': 'ONE_MINUTE', '1h': 'ONE_HOUR', '1d': 'ONE_DAY' };
/** Days per getCandleData call (Angel silently truncates wider sub-hour windows). */
export const TABLE_MAX_DAYS: Record<CandleTable, number> = { '1m': 1, '1h': 365, '1d': 1800 };
```

Create `candles/trading-calendar.ts`:

```typescript
import type { SessionClock } from '../session-clock';
import { TABLE_BAR_MIN, type CandleTable } from './candle.types';

/**
 * The CandleStore's notion of "which bars should exist". All IST arithmetic
 * for candles lives here; everything else passes ms epoch instants.
 */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60_000;

/** IST calendar date (YYYY-MM-DD) of an instant. */
export function istDay(ms: number): string {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** The instant of IST midnight that starts `ymd`. */
export function istMidnight(ymd: string): number {
  return Date.parse(`${ymd}T00:00:00.000Z`) - IST_OFFSET_MS;
}

export function addDays(ymd: string, n: number): string {
  return istDay(istMidnight(ymd) + n * DAY_MS);
}

/**
 * Per IST day in [from, to): how many COMPLETED bars (end ≤ asOf) the exchange
 * should have produced for `table`. Days with none (weekend, holiday, not yet
 * closed) are omitted. A bar's end is clipped to the session close (NSE's last
 * hourly bar is 15:15–15:30).
 */
export function expectedPerDay(
  clock: SessionClock,
  exchange: string,
  table: CandleTable,
  from: number,
  to: number,
  asOf: number,
): Map<string, number> {
  const out = new Map<string, number>();
  if (to <= from) return out;
  for (let ymd = istDay(from); istMidnight(ymd) < to; ymd = addDays(ymd, 1)) {
    const midnight = istMidnight(ymd);
    const w = clock.tradingWindow(exchange, new Date(midnight));
    if (!w) continue;
    const close = midnight + w.closeMin * MINUTE_MS;
    let n = 0;
    if (table === '1d') {
      if (midnight >= from && midnight < to && close <= asOf) n = 1;
    } else {
      const step = TABLE_BAR_MIN[table];
      for (let m = w.openMin; m < w.closeMin; m += step) {
        const start = midnight + m * MINUTE_MS;
        if (start < from || start >= to) continue;
        if (Math.min(start + step * MINUTE_MS, close) <= asOf) n++;
      }
    }
    if (n > 0) out.set(ymd, n);
  }
  return out;
}

/** When the bar starting at `start` is complete. Off-session bars end after their nominal width. */
export function barEnd(clock: SessionClock, exchange: string, table: CandleTable, start: number): number {
  const midnight = istMidnight(istDay(start));
  const w = clock.tradingWindow(exchange, new Date(midnight));
  const nominal = table === '1d' ? midnight + DAY_MS : start + TABLE_BAR_MIN[table] * MINUTE_MS;
  if (!w) return nominal;
  const close = midnight + w.closeMin * MINUTE_MS;
  return table === '1d' ? close : Math.min(nominal, close);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @td/api test -- session-clock.spec trading-calendar.spec`
Expected: PASS (all tests in both files).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/market-hub/session-clock.ts apps/api/src/modules/market-hub/session-clock.spec.ts apps/api/src/modules/market-hub/hub.types.ts apps/api/src/modules/market-hub/candles/candle.types.ts apps/api/src/modules/market-hub/candles/trading-calendar.ts apps/api/src/modules/market-hub/candles/trading-calendar.spec.ts
git commit -m "feat(market-hub): trading calendar for candles — expected completed bars per IST day" -- apps/api/src/modules/market-hub/session-clock.ts apps/api/src/modules/market-hub/session-clock.spec.ts apps/api/src/modules/market-hub/hub.types.ts apps/api/src/modules/market-hub/candles/candle.types.ts apps/api/src/modules/market-hub/candles/trading-calendar.ts apps/api/src/modules/market-hub/candles/trading-calendar.spec.ts
```

---

### Task 2: CandleBuilder (ticks → 1-minute bars)

**Files:**
- Create: `apps/api/src/modules/market-hub/candles/candle-builder.ts`
- Test: `apps/api/src/modules/market-hub/candles/candle-builder.spec.ts`

**Interfaces:**
- Consumes: `Price`, `InstrumentRef`, `refKey` (hub.types); `HubCandle` (Task 1); `istDay` (Task 1).
- Produces: `ClosedBar { ref: InstrumentRef; candle: HubCandle }`; `class CandleBuilder { constructor(graceMs = 2000); onPrice(p: Price): ClosedBar[]; closeDue(now: number): ClosedBar[]; stats(): { building: number; lateTicks: number } }`.

- [ ] **Step 1: Write the failing test**

```typescript
import type { InstrumentRef, Price } from '../hub.types';
import { CandleBuilder } from './candle-builder';

const ist = (s: string) => Date.parse(`${s}+05:30`);
const NIFTY: InstrumentRef = { exchange: 'NSE', token: '99926000', symbol: 'NIFTY' };
const p = (at: string, ltp: number, volume?: number, extra: Partial<Price> = {}): Price => ({
  ref: NIFTY, ltp, at: ist(at), source: 'ws', volume, ...extra,
});

describe('CandleBuilder', () => {
  it('builds OHLC within a minute and closes it on the next minute’s tick', () => {
    const b = new CandleBuilder();
    expect(b.onPrice(p('2026-10-07T10:00:05', 100))).toEqual([]);
    b.onPrice(p('2026-10-07T10:00:20', 103));
    b.onPrice(p('2026-10-07T10:00:40', 99));
    b.onPrice(p('2026-10-07T10:00:59', 101));
    const closed = b.onPrice(p('2026-10-07T10:01:01', 102));
    expect(closed).toEqual([
      { ref: NIFTY, candle: { ts: ist('2026-10-07T10:00:00'), open: 100, high: 103, low: 99, close: 101, volume: 0 } },
    ]);
    expect(b.stats().building).toBe(1);
  });

  it('first tick of the day only sets the baseline; volume is the difference after that', () => {
    const b = new CandleBuilder();
    b.onPrice(p('2026-10-07T10:00:05', 100, 1_000_000)); // hub (re)started mid-session: baseline
    b.onPrice(p('2026-10-07T10:00:30', 100, 1_000_200));
    b.onPrice(p('2026-10-07T10:00:50', 100, 1_000_500));
    const [bar] = b.onPrice(p('2026-10-07T10:01:10', 100, 1_000_600));
    expect(bar.candle.volume).toBe(500);
    const [next] = b.closeDue(ist('2026-10-07T10:02:03'));
    expect(next.candle.volume).toBe(100);
  });

  it('a new day re-baselines the cumulative volume', () => {
    const b = new CandleBuilder();
    b.onPrice(p('2026-10-07T15:29:10', 100, 9_000));
    b.onPrice(p('2026-10-07T15:29:40', 100, 9_500));
    b.onPrice(p('2026-10-08T09:15:05', 100, 40)); // lower: next day's running total
    const [yesterday, today] = b.closeDue(ist('2026-10-08T09:16:05'));
    expect(yesterday.candle.volume).toBe(500);
    expect(today.candle.volume).toBe(0);
  });

  it('closeDue closes a quiet bar only after its minute plus the grace period', () => {
    const b = new CandleBuilder(2000);
    b.onPrice(p('2026-10-07T10:00:05', 100));
    expect(b.closeDue(ist('2026-10-07T10:01:01'))).toEqual([]);
    expect(b.closeDue(ist('2026-10-07T10:01:02'))).toHaveLength(1);
    expect(b.stats().building).toBe(0);
  });

  it('ignores a late tick for an already-closed minute and counts it', () => {
    const b = new CandleBuilder();
    b.onPrice(p('2026-10-07T10:01:05', 100));
    expect(b.onPrice(p('2026-10-07T10:00:59', 50))).toEqual([]);
    const [bar] = b.closeDue(ist('2026-10-07T10:03:00'));
    expect(bar.candle.low).toBe(100);
    expect(b.stats().lateTicks).toBe(1);
  });

  it('ignores non-positive prices and keeps the last open interest', () => {
    const b = new CandleBuilder();
    b.onPrice(p('2026-10-07T10:00:05', 0));
    b.onPrice(p('2026-10-07T10:00:10', 100, undefined, { oi: 10 }));
    b.onPrice(p('2026-10-07T10:00:20', 101, undefined, { oi: 12 }));
    const [bar] = b.closeDue(ist('2026-10-07T10:02:00'));
    expect(bar.candle).toMatchObject({ open: 100, oi: 12 });
  });

  it('keeps the same token on two exchanges apart', () => {
    const b = new CandleBuilder();
    const mcx: InstrumentRef = { exchange: 'MCX', token: '99926000', symbol: 'X' };
    b.onPrice(p('2026-10-07T10:00:05', 100));
    b.onPrice({ ref: mcx, ltp: 7, at: ist('2026-10-07T10:00:06'), source: 'ws' });
    expect(b.closeDue(ist('2026-10-07T10:02:00')).map((c) => c.ref.exchange).sort()).toEqual(['MCX', 'NSE']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @td/api test -- candle-builder.spec`
Expected: FAIL with `Cannot find module './candle-builder'`.

- [ ] **Step 3: Implement**

```typescript
import { refKey, type InstrumentRef, type Price } from '../hub.types';
import type { HubCandle } from './candle.types';
import { istDay } from './trading-calendar';

export interface ClosedBar {
  ref: InstrumentRef;
  candle: HubCandle;
}

const MINUTE_MS = 60_000;

/**
 * Live ticks → 1-minute bars, for live-tier instruments only. Angel's tick
 * volume is the day's RUNNING TOTAL; a bar's volume is the difference between
 * ticks (summing it is the legacy double count). The first tick seen for an
 * instrument on a day only sets the baseline: the hub cannot know how much of
 * the running total traded in this minute. The nightly fix-up replaces these
 * bars with the broker's anyway.
 */
export class CandleBuilder {
  private readonly open = new Map<string, ClosedBar>();
  private readonly cumulative = new Map<string, { day: string; volume: number }>();
  private lateTicks = 0;

  constructor(private readonly graceMs = 2000) {}

  /** Returns the bar this tick closed (the instrument's previous minute), if any. */
  onPrice(p: Price): ClosedBar[] {
    if (!(p.ltp > 0)) return [];
    const key = refKey(p.ref);
    const minute = Math.floor(p.at / MINUTE_MS) * MINUTE_MS;
    const delta = this.volumeDelta(key, p);
    const closed: ClosedBar[] = [];
    const current = this.open.get(key);
    if (current && minute < current.candle.ts) {
      this.lateTicks++;
      return [];
    }
    if (current && minute > current.candle.ts) {
      closed.push(current);
      this.open.delete(key);
    }
    const bar = this.open.get(key);
    if (bar) {
      const c = bar.candle;
      c.high = Math.max(c.high, p.ltp);
      c.low = Math.min(c.low, p.ltp);
      c.close = p.ltp;
      c.volume += delta;
      if (p.oi !== undefined) c.oi = p.oi;
    } else {
      const candle: HubCandle = { ts: minute, open: p.ltp, high: p.ltp, low: p.ltp, close: p.ltp, volume: delta };
      if (p.oi !== undefined) candle.oi = p.oi;
      this.open.set(key, { ref: p.ref, candle });
    }
    return closed;
  }

  /** Close every bar whose minute ended more than `graceMs` ago (quiet instruments). */
  closeDue(now: number): ClosedBar[] {
    const out: ClosedBar[] = [];
    for (const [key, bar] of this.open) {
      if (bar.candle.ts + MINUTE_MS + this.graceMs <= now) {
        out.push(bar);
        this.open.delete(key);
      }
    }
    const today = istDay(now);
    for (const [key, c] of this.cumulative) if (c.day !== today && !this.open.has(key)) this.cumulative.delete(key);
    return out;
  }

  stats(): { building: number; lateTicks: number } {
    return { building: this.open.size, lateTicks: this.lateTicks };
  }

  private volumeDelta(key: string, p: Price): number {
    if (p.volume === undefined || !Number.isFinite(p.volume)) return 0;
    const day = istDay(p.at);
    const prev = this.cumulative.get(key);
    if (!prev || prev.day !== day) {
      this.cumulative.set(key, { day, volume: p.volume });
      return 0;
    }
    if (p.volume <= prev.volume) return 0; // out of order or unchanged: never negative
    const delta = p.volume - prev.volume;
    prev.volume = p.volume;
    return delta;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @td/api test -- candle-builder.spec`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/market-hub/candles/candle-builder.ts apps/api/src/modules/market-hub/candles/candle-builder.spec.ts
git commit -m "feat(market-hub): tick-built 1m bars with volume as the difference of the running total" -- apps/api/src/modules/market-hub/candles/candle-builder.ts apps/api/src/modules/market-hub/candles/candle-builder.spec.ts
```

---

### Task 3: Storage: tables, guarded TimescaleDB, repository

**Files:**
- Modify: `prisma/schema.prisma` (append four models)
- Create: `prisma/migrations/20261008120000_sp1_m2_candle_store/migration.sql`
- Create: `apps/api/src/modules/market-hub/candles/candle-repository.ts`
- Create: `apps/api/src/modules/market-hub/testing/memory-candle-repo.ts`
- Test: `apps/api/src/modules/market-hub/testing/memory-candle-repo.spec.ts`
- Create: `apps/api/test/sp1-m2/jest.config.js`
- Test: `apps/api/test/sp1-m2/candle-repository.int.spec.ts`

**Interfaces:**
- Consumes: `InstrumentRef`, `refKey` (hub.types); `CandleTable`, `HubCandle` (Task 1); `istDay` (Task 1).
- Produces:

```typescript
export interface CandleRepo {
  read(table: CandleTable, ref: InstrumentRef, from: number, to: number): Promise<HubCandle[]>;
  /** 1-minute bars grouped into `stepMin` buckets aligned to `originMinIst` (IST minutes after midnight). */
  readBucketed(ref: InstrumentRef, stepMin: number, originMinIst: number, from: number, to: number): Promise<HubCandle[]>;
  /** Stored bars per IST day in [from, to). */
  dayCounts(table: CandleTable, ref: InstrumentRef, from: number, to: number): Promise<Map<string, number>>;
  upsert(table: CandleTable, ref: InstrumentRef, candles: readonly HubCandle[], source: 'tick' | 'broker'): Promise<void>;
  coveredDays(table: CandleTable, ref: InstrumentRef, days: readonly string[]): Promise<Set<string>>;
  markCovered(table: CandleTable, ref: InstrumentRef, days: readonly string[]): Promise<void>;
  /** Instruments with tick-built 1m bars at or after `sinceMs`. */
  tickInstruments(sinceMs: number): Promise<Array<Pick<InstrumentRef, 'exchange' | 'token'>>>;
}
export class PrismaCandleRepo implements CandleRepo { constructor(db: Pick<PrismaClient, '$queryRaw' | '$executeRaw'>) }
export class MemoryCandleRepo implements CandleRepo { /* test double, same semantics */ }
```

- [ ] **Step 1: Write the failing in-memory repository test** (`testing/memory-candle-repo.spec.ts`)

These are the same semantics the integration test checks against real SQL in Step 6; the double must not drift from the real repository.

```typescript
import type { InstrumentRef } from '../hub.types';
import { MemoryCandleRepo } from './memory-candle-repo';

const ist = (s: string) => Date.parse(`${s}+05:30`);
const REF: InstrumentRef = { exchange: 'NSE', token: '2885', symbol: 'RELIANCE' };
const bar = (at: string, close: number, volume = 10) => ({ ts: ist(at), open: close, high: close + 1, low: close - 1, close, volume });

describe('MemoryCandleRepo', () => {
  it('broker overwrites tick; tick never overwrites broker', async () => {
    const r = new MemoryCandleRepo();
    await r.upsert('1m', REF, [bar('2026-10-07T10:00:00', 100)], 'tick');
    await r.upsert('1m', REF, [bar('2026-10-07T10:00:00', 200)], 'broker');
    await r.upsert('1m', REF, [bar('2026-10-07T10:00:00', 300)], 'tick');
    const [c] = await r.read('1m', REF, ist('2026-10-07T00:00:00'), ist('2026-10-08T00:00:00'));
    expect(c.close).toBe(200);
  });

  it('groups 1m bars into 30m buckets aligned to 09:15 IST', async () => {
    const r = new MemoryCandleRepo();
    const bars = Array.from({ length: 60 }, (_, i) => ({
      ts: ist('2026-10-07T09:15:00') + i * 60_000, open: 100 + i, high: 200 + i, low: 50 + i, close: 100 + i, volume: 1,
    }));
    await r.upsert('1m', REF, bars, 'broker');
    const out = await r.readBucketed(REF, 30, 555, ist('2026-10-07T00:00:00'), ist('2026-10-08T00:00:00'));
    expect(out).toEqual([
      { ts: ist('2026-10-07T09:15:00'), open: 100, high: 229, low: 50, close: 129, volume: 30 },
      { ts: ist('2026-10-07T09:45:00'), open: 130, high: 259, low: 80, close: 159, volume: 30 },
    ]);
  });

  it('counts per IST day, remembers coverage, lists tick instruments', async () => {
    const r = new MemoryCandleRepo();
    await r.upsert('1m', REF, [bar('2026-10-07T23:50:00', 1), bar('2026-10-08T00:10:00', 2)], 'tick');
    expect(await r.dayCounts('1m', REF, ist('2026-10-07T00:00:00'), ist('2026-10-09T00:00:00'))).toEqual(
      new Map([['2026-10-07', 1], ['2026-10-08', 1]]),
    );
    await r.markCovered('1m', REF, ['2026-10-06']);
    expect(await r.coveredDays('1m', REF, ['2026-10-06', '2026-10-05'])).toEqual(new Set(['2026-10-06']));
    expect(await r.tickInstruments(ist('2026-10-08T00:00:00'))).toEqual([{ exchange: 'NSE', token: '2885' }]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @td/api test -- memory-candle-repo.spec`
Expected: FAIL with `Cannot find module './memory-candle-repo'`.

- [ ] **Step 3: Implement the repository interface, the Prisma implementation and the double**

Create `candles/candle-repository.ts`:

```typescript
import { Prisma, type PrismaClient } from '@prisma/client';
import type { InstrumentRef } from '../hub.types';
import type { CandleTable, HubCandle } from './candle.types';

export interface CandleRepo {
  read(table: CandleTable, ref: InstrumentRef, from: number, to: number): Promise<HubCandle[]>;
  /** 1-minute bars grouped into `stepMin` buckets aligned to `originMinIst` (IST minutes after midnight). */
  readBucketed(ref: InstrumentRef, stepMin: number, originMinIst: number, from: number, to: number): Promise<HubCandle[]>;
  /** Stored bars per IST day in [from, to). */
  dayCounts(table: CandleTable, ref: InstrumentRef, from: number, to: number): Promise<Map<string, number>>;
  upsert(table: CandleTable, ref: InstrumentRef, candles: readonly HubCandle[], source: 'tick' | 'broker'): Promise<void>;
  coveredDays(table: CandleTable, ref: InstrumentRef, days: readonly string[]): Promise<Set<string>>;
  markCovered(table: CandleTable, ref: InstrumentRef, days: readonly string[]): Promise<void>;
  /** Instruments with tick-built 1m bars at or after `sinceMs`. */
  tickInstruments(sinceMs: number): Promise<Array<Pick<InstrumentRef, 'exchange' | 'token'>>>;
}

type Sql = Pick<PrismaClient, '$queryRaw' | '$executeRaw'>;

const TABLE: Record<CandleTable, Prisma.Sql> = {
  '1m': Prisma.raw('"candles_1m"'),
  '1h': Prisma.raw('"candles_1h"'),
  '1d': Prisma.raw('"candles_1d"'),
};
const BATCH = 1000;

interface Row {
  ts: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: bigint | number | null;
  oi: bigint | number | null;
}

const iso = (ms: number) => new Date(ms).toISOString();

function toCandle(r: Row): HubCandle {
  const c: HubCandle = {
    ts: r.ts.getTime(),
    open: Number(r.open),
    high: Number(r.high),
    low: Number(r.low),
    close: Number(r.close),
    volume: Number(r.volume ?? 0),
  };
  if (r.oi !== null && r.oi !== undefined) c.oi = Number(r.oi);
  return c;
}

/** date_bin origin: any past date at the IST session-open minute. */
export function bucketOrigin(originMinIst: number): string {
  const hh = String(Math.floor(originMinIst / 60)).padStart(2, '0');
  const mm = String(originMinIst % 60).padStart(2, '0');
  return `2000-01-03T${hh}:${mm}:00+05:30`;
}

/**
 * The CandleStore's tables, through raw SQL (Prisma's query builder has no
 * upsert-with-condition or date_bin). Every timestamp parameter is an ISO
 * string cast to timestamptz so the server's TimeZone setting cannot shift it.
 */
export class PrismaCandleRepo implements CandleRepo {
  constructor(private readonly db: Sql) {}

  async read(table: CandleTable, ref: InstrumentRef, from: number, to: number): Promise<HubCandle[]> {
    const oi = table === '1m' ? Prisma.sql`oi` : Prisma.sql`NULL::bigint AS oi`;
    const rows = await this.db.$queryRaw<Row[]>`
      SELECT ts, open, high, low, close, volume, ${oi}
      FROM ${TABLE[table]}
      WHERE exchange = ${ref.exchange} AND token = ${ref.token}
        AND ts >= ${iso(from)}::timestamptz AND ts < ${iso(to)}::timestamptz
      ORDER BY ts`;
    return rows.map(toCandle);
  }

  async readBucketed(ref: InstrumentRef, stepMin: number, originMinIst: number, from: number, to: number): Promise<HubCandle[]> {
    const rows = await this.db.$queryRaw<Row[]>`
      SELECT date_bin(${`${stepMin} minutes`}::interval, ts, ${bucketOrigin(originMinIst)}::timestamptz) AS ts,
             (array_agg(open ORDER BY ts))[1] AS open,
             max(high) AS high,
             min(low) AS low,
             (array_agg(close ORDER BY ts DESC))[1] AS close,
             sum(volume)::bigint AS volume,
             (array_agg(oi ORDER BY ts DESC) FILTER (WHERE oi IS NOT NULL))[1] AS oi
      FROM "candles_1m"
      WHERE exchange = ${ref.exchange} AND token = ${ref.token}
        AND ts >= ${iso(from)}::timestamptz AND ts < ${iso(to)}::timestamptz
      GROUP BY 1
      ORDER BY 1`;
    return rows.map(toCandle);
  }

  async dayCounts(table: CandleTable, ref: InstrumentRef, from: number, to: number): Promise<Map<string, number>> {
    const rows = await this.db.$queryRaw<Array<{ day: string; n: number }>>`
      SELECT to_char(ts AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS day, count(*)::int AS n
      FROM ${TABLE[table]}
      WHERE exchange = ${ref.exchange} AND token = ${ref.token}
        AND ts >= ${iso(from)}::timestamptz AND ts < ${iso(to)}::timestamptz
      GROUP BY 1`;
    return new Map(rows.map((r) => [r.day, Number(r.n)] as const));
  }

  async upsert(table: CandleTable, ref: InstrumentRef, candles: readonly HubCandle[], source: 'tick' | 'broker'): Promise<void> {
    for (let i = 0; i < candles.length; i += BATCH) {
      const chunk = candles.slice(i, i + BATCH);
      if (table === '1m') {
        const values = Prisma.join(
          chunk.map(
            (c) => Prisma.sql`(${ref.exchange}, ${ref.token}, ${iso(c.ts)}::timestamptz, ${c.open}::float8, ${c.high}::float8,
              ${c.low}::float8, ${c.close}::float8, ${Math.round(c.volume)}::bigint,
              ${c.oi === undefined ? null : Math.round(c.oi)}::bigint, ${source})`,
          ),
        );
        // broker always wins; a tick bar only replaces another tick bar.
        await this.db.$executeRaw`
          INSERT INTO "candles_1m" (exchange, token, ts, open, high, low, close, volume, oi, source)
          VALUES ${values}
          ON CONFLICT (exchange, token, ts) DO UPDATE SET
            open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low, close = EXCLUDED.close,
            volume = EXCLUDED.volume, oi = EXCLUDED.oi, source = EXCLUDED.source
          WHERE "candles_1m".source = 'tick' OR EXCLUDED.source = 'broker'`;
      } else {
        const values = Prisma.join(
          chunk.map(
            (c) => Prisma.sql`(${ref.exchange}, ${ref.token}, ${iso(c.ts)}::timestamptz, ${c.open}::float8, ${c.high}::float8,
              ${c.low}::float8, ${c.close}::float8, ${Math.round(c.volume)}::bigint)`,
          ),
        );
        await this.db.$executeRaw`
          INSERT INTO ${TABLE[table]} (exchange, token, ts, open, high, low, close, volume)
          VALUES ${values}
          ON CONFLICT (exchange, token, ts) DO UPDATE SET
            open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low, close = EXCLUDED.close,
            volume = EXCLUDED.volume`;
      }
    }
  }

  async coveredDays(table: CandleTable, ref: InstrumentRef, days: readonly string[]): Promise<Set<string>> {
    if (days.length === 0) return new Set();
    const rows = await this.db.$queryRaw<Array<{ day: string }>>`
      SELECT to_char(day, 'YYYY-MM-DD') AS day FROM "candle_coverage"
      WHERE exchange = ${ref.exchange} AND token = ${ref.token} AND tf = ${table}
        AND day = ANY(${[...days]}::date[])`;
    return new Set(rows.map((r) => r.day));
  }

  async markCovered(table: CandleTable, ref: InstrumentRef, days: readonly string[]): Promise<void> {
    if (days.length === 0) return;
    await this.db.$executeRaw`
      INSERT INTO "candle_coverage" (exchange, token, tf, day)
      SELECT ${ref.exchange}, ${ref.token}, ${table}, d FROM unnest(${[...days]}::date[]) AS d
      ON CONFLICT (exchange, token, tf, day) DO UPDATE SET fetched_at = now()`;
  }

  async tickInstruments(sinceMs: number): Promise<Array<Pick<InstrumentRef, 'exchange' | 'token'>>> {
    const rows = await this.db.$queryRaw<Array<{ exchange: string; token: string }>>`
      SELECT DISTINCT exchange, token FROM "candles_1m"
      WHERE source = 'tick' AND ts >= ${iso(sinceMs)}::timestamptz`;
    return rows.map((r) => ({ exchange: r.exchange as InstrumentRef['exchange'], token: r.token }));
  }
}
```

Create `testing/memory-candle-repo.ts`:

```typescript
import type { CandleRepo } from '../candles/candle-repository';
import { bucketOrigin } from '../candles/candle-repository';
import type { CandleTable, HubCandle } from '../candles/candle.types';
import { istDay } from '../candles/trading-calendar';
import { refKey, type HubExchange, type InstrumentRef } from '../hub.types';

type Row = HubCandle & { source?: 'tick' | 'broker' };

/** In-memory CandleRepo with the same semantics as PrismaCandleRepo (see its integration test). */
export class MemoryCandleRepo implements CandleRepo {
  readonly rows: Record<CandleTable, Map<string, Map<number, Row>>> = { '1m': new Map(), '1h': new Map(), '1d': new Map() };
  readonly coverage = new Set<string>();
  failWrites = false;

  async read(table: CandleTable, ref: InstrumentRef, from: number, to: number): Promise<HubCandle[]> {
    return this.range(table, ref, from, to);
  }

  async readBucketed(ref: InstrumentRef, stepMin: number, originMinIst: number, from: number, to: number): Promise<HubCandle[]> {
    const origin = Date.parse(bucketOrigin(originMinIst));
    const step = stepMin * 60_000;
    const buckets = new Map<number, HubCandle>();
    for (const r of this.range('1m', ref, from, to)) {
      const b = origin + Math.floor((r.ts - origin) / step) * step;
      const c = buckets.get(b);
      if (!c) {
        buckets.set(b, { ...r, ts: b });
      } else {
        c.high = Math.max(c.high, r.high);
        c.low = Math.min(c.low, r.low);
        c.close = r.close;
        c.volume += r.volume;
        if (r.oi !== undefined) c.oi = r.oi;
      }
    }
    return [...buckets.values()].sort((a, b) => a.ts - b.ts);
  }

  async dayCounts(table: CandleTable, ref: InstrumentRef, from: number, to: number): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    for (const r of this.range(table, ref, from, to)) out.set(istDay(r.ts), (out.get(istDay(r.ts)) ?? 0) + 1);
    return out;
  }

  async upsert(table: CandleTable, ref: InstrumentRef, candles: readonly HubCandle[], source: 'tick' | 'broker'): Promise<void> {
    if (this.failWrites) throw new Error('db down');
    const s = this.series(table, ref);
    for (const c of candles) {
      const existing = s.get(c.ts);
      if (table === '1m' && existing?.source === 'broker' && source === 'tick') continue;
      s.set(c.ts, table === '1m' ? { ...c, source } : { ...c });
    }
  }

  async coveredDays(table: CandleTable, ref: InstrumentRef, days: readonly string[]): Promise<Set<string>> {
    return new Set(days.filter((d) => this.coverage.has(`${table}:${refKey(ref)}:${d}`)));
  }

  async markCovered(table: CandleTable, ref: InstrumentRef, days: readonly string[]): Promise<void> {
    for (const d of days) this.coverage.add(`${table}:${refKey(ref)}:${d}`);
  }

  async tickInstruments(sinceMs: number): Promise<Array<Pick<InstrumentRef, 'exchange' | 'token'>>> {
    const out: Array<Pick<InstrumentRef, 'exchange' | 'token'>> = [];
    for (const [key, s] of this.rows['1m']) {
      if ([...s.values()].some((r) => r.source === 'tick' && r.ts >= sinceMs)) {
        const [exchange, token] = key.split(':');
        out.push({ exchange: exchange as HubExchange, token });
      }
    }
    return out;
  }

  private series(table: CandleTable, ref: InstrumentRef): Map<number, Row> {
    const key = refKey(ref);
    let s = this.rows[table].get(key);
    if (!s) {
      s = new Map();
      this.rows[table].set(key, s);
    }
    return s;
  }

  private range(table: CandleTable, ref: InstrumentRef, from: number, to: number): HubCandle[] {
    return [...this.series(table, ref).values()]
      .filter((r) => r.ts >= from && r.ts < to)
      .sort((a, b) => a.ts - b.ts)
      .map(({ source: _source, ...c }) => c);
  }
}
```

- [ ] **Step 4: Run the double's test**

Run: `pnpm --filter @td/api test -- memory-candle-repo.spec`
Expected: PASS (3 tests).

- [ ] **Step 5: Schema models and migration**

Append to `prisma/schema.prisma`:

```prisma
// ─── SP1 M2: market hub CandleStore ──────────────────────────────────────────
// Written and read through raw SQL in apps/api/src/modules/market-hub/candles/
// candle-repository.ts. candles_1m becomes a TimescaleDB hypertable (compressed
// after 7 days, kept 180 days) where the server has TimescaleDB; see the
// 20261008120000_sp1_m2_candle_store migration.

/// 1-minute bars: `tick` (built live) or `broker` (gap fill, nightly fix-up). broker beats tick.
model HubCandle1m {
  exchange String
  token    String
  ts       DateTime @db.Timestamptz(3)
  open     Float
  high     Float
  low      Float
  close    Float
  volume   BigInt   @default(0)
  oi       BigInt?
  source   String

  @@id([exchange, token, ts])
  @@map("candles_1m")
}

/// Angel One's native hourly bars (09:15, 10:15 … for NSE).
model HubCandle1h {
  exchange String
  token    String
  ts       DateTime @db.Timestamptz(3)
  open     Float
  high     Float
  low      Float
  close    Float
  volume   BigInt   @default(0)

  @@id([exchange, token, ts])
  @@map("candles_1h")
}

/// Official daily bars; ts = IST midnight.
model HubCandle1d {
  exchange String
  token    String
  ts       DateTime @db.Timestamptz(3)
  open     Float
  high     Float
  low      Float
  close    Float
  volume   BigInt   @default(0)

  @@id([exchange, token, ts])
  @@map("candles_1d")
}

/// Past IST days the broker has already been asked for, per series. A covered day
/// with fewer bars than the calendar expects is genuinely sparse (no trades).
model CandleCoverage {
  exchange  String
  token     String
  tf        String
  day       DateTime @db.Date
  fetchedAt DateTime @default(now()) @map("fetched_at") @db.Timestamptz(3)

  @@id([exchange, token, tf, day])
  @@map("candle_coverage")
}
```

Create `prisma/migrations/20261008120000_sp1_m2_candle_store/migration.sql`:

```sql
-- SP1 M2 — market hub CandleStore (docs/superpowers/specs/2026-10-05-sp1-market-data-hub-design.md §6).
--
-- WHY the TimescaleDB block is guarded: production runs on Neon until the VPS
-- move, and Neon offers only TimescaleDB's Apache-licensed subset (no
-- compression, no retention policies). The same migration must succeed there
-- (plain tables) and on the VPS's timescale/timescaledb image (hypertable +
-- compression + 180-day retention). Expand-only: creates tables, drops nothing.
--
-- create_default_indexes => FALSE: the primary key (exchange, token, ts) already
-- serves every query, and an extra ts index would show up as Prisma schema drift.

CREATE TABLE "candles_1m" (
    "exchange" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "ts" TIMESTAMPTZ(3) NOT NULL,
    "open" DOUBLE PRECISION NOT NULL,
    "high" DOUBLE PRECISION NOT NULL,
    "low" DOUBLE PRECISION NOT NULL,
    "close" DOUBLE PRECISION NOT NULL,
    "volume" BIGINT NOT NULL DEFAULT 0,
    "oi" BIGINT,
    "source" TEXT NOT NULL,

    CONSTRAINT "candles_1m_pkey" PRIMARY KEY ("exchange","token","ts")
);

CREATE TABLE "candles_1h" (
    "exchange" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "ts" TIMESTAMPTZ(3) NOT NULL,
    "open" DOUBLE PRECISION NOT NULL,
    "high" DOUBLE PRECISION NOT NULL,
    "low" DOUBLE PRECISION NOT NULL,
    "close" DOUBLE PRECISION NOT NULL,
    "volume" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "candles_1h_pkey" PRIMARY KEY ("exchange","token","ts")
);

CREATE TABLE "candles_1d" (
    "exchange" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "ts" TIMESTAMPTZ(3) NOT NULL,
    "open" DOUBLE PRECISION NOT NULL,
    "high" DOUBLE PRECISION NOT NULL,
    "low" DOUBLE PRECISION NOT NULL,
    "close" DOUBLE PRECISION NOT NULL,
    "volume" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "candles_1d_pkey" PRIMARY KEY ("exchange","token","ts")
);

CREATE TABLE "candle_coverage" (
    "exchange" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "tf" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "fetched_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "candle_coverage_pkey" PRIMARY KEY ("exchange","token","tf","day")
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'timescaledb') THEN
    BEGIN
      CREATE EXTENSION IF NOT EXISTS timescaledb;
      PERFORM create_hypertable('candles_1m', 'ts',
        chunk_time_interval => INTERVAL '7 days',
        create_default_indexes => FALSE,
        if_not_exists => TRUE);
      IF current_setting('timescaledb.license', TRUE) = 'timescale' THEN
        ALTER TABLE "candles_1m" SET (
          timescaledb.compress,
          timescaledb.compress_segmentby = 'exchange, token',
          timescaledb.compress_orderby = 'ts');
        PERFORM add_compression_policy('candles_1m', INTERVAL '7 days', if_not_exists => TRUE);
        PERFORM add_retention_policy('candles_1m', INTERVAL '180 days', if_not_exists => TRUE);
      ELSE
        RAISE NOTICE 'timescaledb is Apache-licensed here: candles_1m is a hypertable without compression or retention';
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'timescaledb unavailable (%): candles_1m stays a plain table', SQLERRM;
    END;
  ELSE
    RAISE NOTICE 'timescaledb not installed: candles_1m stays a plain table';
  END IF;
END
$$;
```

Run: `cd apps/api && npx prisma generate --schema ../../prisma/schema.prisma && npx prisma validate --schema ../../prisma/schema.prisma`
Expected: `The schema at ../../prisma/schema.prisma is valid`.

- [ ] **Step 6: Write the integration test (real SQL)**

Create `apps/api/test/sp1-m2/jest.config.js`:

```javascript
const path = require('path');

/**
 * Opt-in SQL tests for the SP1 M2 CandleStore against a real TimescaleDB.
 * The default apps/api Jest config (rootDir: src) never discovers these.
 *
 * Run from apps/api:
 *   DATABASE_URL_TEST=postgresql://postgres:password@127.0.0.1:5432/grw_m2_test \
 *     npx jest --config test/sp1-m2/jest.config.js -i
 */
module.exports = {
  rootDir: path.resolve(__dirname, '../..'),
  roots: ['<rootDir>/test/sp1-m2'],
  moduleFileExtensions: ['js', 'json', 'ts'],
  testRegex: '.*\\.spec\\.ts$',
  transform: { '^.+\\.(t|j)s$': ['ts-jest', { isolatedModules: true }] },
  testEnvironment: 'node',
};
```

Create `apps/api/test/sp1-m2/candle-repository.int.spec.ts`:

```typescript
import { PrismaClient } from '@prisma/client';
import { PrismaCandleRepo } from '../../src/modules/market-hub/candles/candle-repository';
import type { InstrumentRef } from '../../src/modules/market-hub/hub.types';

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error('DATABASE_URL_TEST must point at a throw-away database with all migrations applied');

const db = new PrismaClient({ datasources: { db: { url } } });
const repo = new PrismaCandleRepo(db);
const ist = (s: string) => Date.parse(`${s}+05:30`);
const REF: InstrumentRef = { exchange: 'NSE', token: '2885', symbol: 'RELIANCE' };
const MCX: InstrumentRef = { exchange: 'MCX', token: '2885', symbol: 'SAME-TOKEN' };
const bar = (at: string, close: number, volume = 10) => ({ ts: ist(at), open: close, high: close + 1, low: close - 1, close, volume });

beforeEach(async () => {
  await db.$executeRawUnsafe('TRUNCATE "candles_1m", "candles_1h", "candles_1d", "candle_coverage"');
});
afterAll(() => db.$disconnect());

describe('PrismaCandleRepo (real database)', () => {
  it('reads a half-open range ascending, with numbers and oi only when present', async () => {
    await repo.upsert('1m', REF, [bar('2026-10-07T10:01:00', 2), { ...bar('2026-10-07T10:00:00', 1, 3_000_000_000), oi: 5 }], 'broker');
    await repo.upsert('1m', REF, [bar('2026-10-07T10:02:00', 3)], 'broker');
    const out = await repo.read('1m', REF, ist('2026-10-07T10:00:00'), ist('2026-10-07T10:02:00'));
    expect(out).toEqual([
      { ts: ist('2026-10-07T10:00:00'), open: 1, high: 2, low: 0, close: 1, volume: 3_000_000_000, oi: 5 },
      { ts: ist('2026-10-07T10:01:00'), open: 2, high: 3, low: 1, close: 2, volume: 10 },
    ]);
  });

  it('broker overwrites tick, tick never overwrites broker, tick overwrites tick', async () => {
    const t = '2026-10-07T10:00:00';
    await repo.upsert('1m', REF, [bar(t, 100)], 'tick');
    await repo.upsert('1m', REF, [bar(t, 101)], 'tick');
    expect((await repo.read('1m', REF, ist(t), ist(t) + 60_000))[0].close).toBe(101);
    await repo.upsert('1m', REF, [bar(t, 200)], 'broker');
    await repo.upsert('1m', REF, [bar(t, 300)], 'tick');
    expect((await repo.read('1m', REF, ist(t), ist(t) + 60_000))[0].close).toBe(200);
  });

  it('keeps the same token on two exchanges apart', async () => {
    await repo.upsert('1d', REF, [bar('2026-10-07T00:00:00', 1)], 'broker');
    await repo.upsert('1d', MCX, [bar('2026-10-07T00:00:00', 2)], 'broker');
    expect((await repo.read('1d', MCX, ist('2026-10-07T00:00:00'), ist('2026-10-08T00:00:00')))[0].close).toBe(2);
  });

  it('groups 1m bars into 30m buckets aligned to 09:15 IST', async () => {
    const bars = Array.from({ length: 60 }, (_, i) => ({
      ts: ist('2026-10-07T09:15:00') + i * 60_000, open: 100 + i, high: 200 + i, low: 50 + i, close: 100 + i, volume: 1,
    }));
    await repo.upsert('1m', REF, bars, 'broker');
    const out = await repo.readBucketed(REF, 30, 555, ist('2026-10-07T00:00:00'), ist('2026-10-08T00:00:00'));
    expect(out).toEqual([
      { ts: ist('2026-10-07T09:15:00'), open: 100, high: 229, low: 50, close: 129, volume: 30 },
      { ts: ist('2026-10-07T09:45:00'), open: 130, high: 259, low: 80, close: 159, volume: 30 },
    ]);
  });

  it('counts per IST day (not UTC day)', async () => {
    await repo.upsert('1m', REF, [bar('2026-10-07T23:50:00', 1), bar('2026-10-08T00:10:00', 2)], 'tick');
    expect(await repo.dayCounts('1m', REF, ist('2026-10-07T00:00:00'), ist('2026-10-09T00:00:00'))).toEqual(
      new Map([['2026-10-07', 1], ['2026-10-08', 1]]),
    );
  });

  it('remembers coverage idempotently and lists tick instruments', async () => {
    await repo.markCovered('1m', REF, ['2026-10-06', '2026-10-05']);
    await repo.markCovered('1m', REF, ['2026-10-06']);
    expect(await repo.coveredDays('1m', REF, ['2026-10-06', '2026-10-01'])).toEqual(new Set(['2026-10-06']));
    expect(await repo.coveredDays('1h', REF, ['2026-10-06'])).toEqual(new Set());
    await repo.upsert('1m', REF, [bar('2026-10-07T10:00:00', 1)], 'tick');
    await repo.upsert('1m', MCX, [bar('2026-10-07T10:00:00', 1)], 'broker');
    expect(await repo.tickInstruments(ist('2026-10-07T00:00:00'))).toEqual([{ exchange: 'NSE', token: '2885' }]);
  });

  it('writes more than one batch', async () => {
    const bars = Array.from({ length: 1500 }, (_, i) => ({ ts: ist('2026-10-01T09:15:00') + i * 60_000, open: 1, high: 1, low: 1, close: 1, volume: 1 }));
    await repo.upsert('1m', REF, bars, 'broker');
    expect(await repo.read('1m', REF, ist('2026-10-01T00:00:00'), ist('2026-10-03T00:00:00'))).toHaveLength(1500);
  });

  it('candles_1m is a hypertable when TimescaleDB is installed', async () => {
    const ext = await db.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM pg_extension WHERE extname = 'timescaledb'`);
    if (ext[0].n === 0) return; // plain Postgres: covered by Step 9
    const ht = await db.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM timescaledb_information.hypertables WHERE hypertable_name = 'candles_1m'`,
    );
    expect(ht[0].n).toBe(1);
  });
});
```

- [ ] **Step 7: Prepare the test database and run the integration test**

Start Docker Desktop first if it is not running. From the repo root:

```bash
docker compose up -d postgres
docker exec td-postgres psql -U postgres -c "DROP DATABASE IF EXISTS grw_m2_test" -c "CREATE DATABASE grw_m2_test"
DATABASE_URL=postgresql://postgres:password@127.0.0.1:5432/grw_m2_test DIRECT_URL=postgresql://postgres:password@127.0.0.1:5432/grw_m2_test npx prisma migrate deploy --schema prisma/schema.prisma
cd apps/api && DATABASE_URL_TEST=postgresql://postgres:password@127.0.0.1:5432/grw_m2_test npx jest --config test/sp1-m2/jest.config.js -i
```

Expected: `migrate deploy` lists `20261008120000_sp1_m2_candle_store` as applied; the suite PASSES (8 tests).
If a test fails, fix `candle-repository.ts` (not the test) and keep `MemoryCandleRepo` semantics identical.

- [ ] **Step 8: Prove there is no schema drift**

```bash
docker exec td-postgres psql -U postgres -c "DROP DATABASE IF EXISTS grw_m2_shadow" -c "CREATE DATABASE grw_m2_shadow"
npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url postgresql://postgres:password@127.0.0.1:5432/grw_m2_shadow --exit-code
```

Expected: exit code 0 (`No difference detected.`). A non-zero exit means the models and the SQL disagree. Make the migration SQL match what Prisma expects, except the `DO $$` block.

- [ ] **Step 9: Prove the migration succeeds on plain Postgres (Neon-like)**

```bash
docker run -d --name grw-plainpg -e POSTGRES_PASSWORD=password -p 5433:5432 postgres:17-alpine
until docker exec grw-plainpg pg_isready -U postgres; do sleep 1; done
DATABASE_URL=postgresql://postgres:password@127.0.0.1:5433/postgres DIRECT_URL=postgresql://postgres:password@127.0.0.1:5433/postgres npx prisma migrate deploy --schema prisma/schema.prisma
docker exec grw-plainpg psql -U postgres -tAc "SELECT count(*) FROM information_schema.tables WHERE table_name IN ('candles_1m','candles_1h','candles_1d','candle_coverage')"
docker rm -f grw-plainpg
```

Expected: `migrate deploy` succeeds; the count prints `4`.

- [ ] **Step 10: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20261008120000_sp1_m2_candle_store/migration.sql apps/api/src/modules/market-hub/candles/candle-repository.ts apps/api/src/modules/market-hub/testing/memory-candle-repo.ts apps/api/src/modules/market-hub/testing/memory-candle-repo.spec.ts apps/api/test/sp1-m2/jest.config.js apps/api/test/sp1-m2/candle-repository.int.spec.ts
git commit -m "feat(market-hub): candle tables with TimescaleDB where available, plain Postgres elsewhere" -- prisma/schema.prisma prisma/migrations/20261008120000_sp1_m2_candle_store/migration.sql apps/api/src/modules/market-hub/candles/candle-repository.ts apps/api/src/modules/market-hub/testing/memory-candle-repo.ts apps/api/src/modules/market-hub/testing/memory-candle-repo.spec.ts apps/api/test/sp1-m2/jest.config.js apps/api/test/sp1-m2/candle-repository.int.spec.ts
```

---

### Task 4: Broker seam: one candle window per call

**Files:**
- Modify: `apps/api/src/modules/market-data/services/angel-throttle.ts` (add `throwForMissingData`)
- Modify: `apps/api/src/modules/market-data/services/user-feed-session.ts` (add `getCandleWindow`; `getQuotes` uses the helper)
- Modify: `apps/api/src/modules/market-data/services/user-feed-manager.service.ts` (add `fetchCandleWindow`)
- Modify: `apps/api/src/modules/market-hub/hub-broker.ts` (add `candles` to `HubBroker` + `ManagerHubBroker`)
- Modify: `apps/api/src/modules/market-hub/testing/fake-broker.ts`
- Test: `user-feed-session.spec.ts`, `user-feed-manager.service.spec.ts`, `market-hub/hub-broker.spec.ts`

**Interfaces:**
- Consumes: `AngelThrottleError`, `mapCandleRows`, `formatAngelDateTime`, `Candle` (market-data); `BrokerInterval`, `HubCandle` (Task 1); `TokenRef { token, exchange }`.
- Produces:
  - `throwForMissingData(response: unknown, what: string): never`
  - `UserFeedSession.getCandleWindow(token: string, exchange: string, interval: string, from: Date, to: Date): Promise<Candle[]>`
  - `UserFeedManager.fetchCandleWindow(userId: string, ref: TokenRef, interval: string, from: Date, to: Date): Promise<Candle[]>`
  - `HubBroker.candles(ref: InstrumentRef, interval: BrokerInterval, from: Date, to: Date): Promise<HubCandle[]>`
  - `FakeBroker.candleCalls: Array<{ ref: InstrumentRef; interval: BrokerInterval; from: Date; to: Date }>`, `FakeBroker.candlesImpl`

- [ ] **Step 1: Write the failing tests**

Append to `user-feed-session.spec.ts` (`makeDeps`, `makeSession` and the `AngelThrottleError` import already exist):

```typescript
it('getCandleWindow makes exactly ONE getCandleData call for the window', async () => {
  const { s, d } = makeSession();
  const from = new Date('2026-05-15T03:45:00.000Z'); // 09:15 IST
  const to = new Date('2026-05-15T10:00:00.000Z'); // 15:30 IST
  const candles = await s.getCandleWindow('111', 'NSE', 'ONE_MINUTE', from, to);
  expect(d.smartApi.getCandleData).toHaveBeenCalledTimes(1);
  expect(d.smartApi.getCandleData).toHaveBeenCalledWith({
    exchange: 'NSE',
    symboltoken: '111',
    interval: 'ONE_MINUTE',
    fromdate: '2026-05-15 09:15',
    todate: '2026-05-15 15:30',
  });
  expect(candles).toHaveLength(2);
});

it('getCandleWindow rejects a throttle with AngelThrottleError and never retries', async () => {
  const d = makeDeps();
  d.smartApi.getCandleData.mockResolvedValue({ data: null, message: 'Access denied because of exceeding access rate' });
  const { s } = makeSession(d);
  await expect(s.getCandleWindow('111', 'NSE', 'ONE_MINUTE', new Date(0), new Date(60_000))).rejects.toBeInstanceOf(AngelThrottleError);
  expect(d.smartApi.getCandleData).toHaveBeenCalledTimes(1);
});

it('getCandleWindow reports an SDK-resolved 401 as an error, and [] as genuinely empty', async () => {
  const d = makeDeps();
  d.smartApi.getCandleData.mockResolvedValueOnce({ status: 401, message: 'Unauthorized' });
  const { s } = makeSession(d);
  const err = await s.getCandleWindow('111', 'NSE', 'ONE_DAY', new Date(0), new Date(1)).catch((e) => e);
  expect(err).toBeInstanceOf(Error);
  expect(err).not.toBeInstanceOf(AngelThrottleError);
  d.smartApi.getCandleData.mockResolvedValueOnce({ data: [] });
  await expect(s.getCandleWindow('111', 'NSE', 'ONE_DAY', new Date(0), new Date(1))).resolves.toEqual([]);
});
```

Append to `user-feed-manager.service.spec.ts` (`fakeSession` already exists; add `getCandleWindow` to the object it returns: `getCandleWindow: jest.fn().mockResolvedValue([])`):

```typescript
it('fetchCandleWindow runs one window on the user’s own session', async () => {
  const s = fakeSession();
  const mgr = new UserFeedManager((() => s) as any, { idleMs: 120000, maxSessions: 40 });
  const from = new Date(0);
  const to = new Date(60_000);
  await mgr.fetchCandleWindow('u1', { token: '26000', exchange: 'NSE' }, 'ONE_HOUR', from, to);
  expect(s.getCandleWindow).toHaveBeenCalledWith('26000', 'NSE', 'ONE_HOUR', from, to);
});
```

Append to `market-hub/hub-broker.spec.ts`:

```typescript
it('candles() fetches one window on the owner’s session and maps to hub candles', async () => {
  const manager = {
    pin: jest.fn(), unpin: jest.fn(), fetchQuotes: jest.fn(), addTickListener: jest.fn(), addStateListener: jest.fn(),
    fetchCandleWindow: jest.fn().mockResolvedValue([
      { timestamp: new Date('2026-10-07T03:45:00.000Z'), open: 1, high: 2, low: 0.5, close: 1.5, volume: 42 },
    ]),
  };
  const b = new ManagerHubBroker(manager as any, 'owner');
  const from = new Date('2026-10-06T18:30:00.000Z');
  const to = new Date('2026-10-07T18:30:00.000Z');
  const out = await b.candles({ exchange: 'NFO', token: '35001', symbol: 'X' }, 'ONE_MINUTE', from, to);
  expect(manager.fetchCandleWindow).toHaveBeenCalledWith('owner', { token: '35001', exchange: 'NFO' }, 'ONE_MINUTE', from, to);
  expect(out).toEqual([{ ts: Date.parse('2026-10-07T03:45:00.000Z'), open: 1, high: 2, low: 0.5, close: 1.5, volume: 42 }]);
});
```

If `hub-broker.spec.ts` does not already import `ManagerHubBroker`, add `import { ManagerHubBroker } from './hub-broker';`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @td/api test -- user-feed-session.spec user-feed-manager.service.spec hub-broker.spec`
Expected: FAIL. `getCandleWindow is not a function`, `fetchCandleWindow is not a function`, `candles is not a function`.

- [ ] **Step 3: Implement**

In `angel-throttle.ts`, append:

```typescript
/**
 * smartapi-javascript RESOLVES HTTP errors as `{ status, message }` with no
 * `data`. Angel signals a rate limit with HTTP 403, an "exceeding access rate"
 * message, or a body without a truthy status; anything else (401 expired
 * session, 5xx) is a real error and must not be disguised as a throttle (it
 * would only trigger back-off). Call only when `response.data == null`.
 */
export function throwForMissingData(response: unknown, what: string): never {
  const r = response as { status?: unknown; message?: unknown } | null | undefined;
  const status = Number(r?.status);
  const message = String(r?.message ?? '');
  if (status === 403 || /exceed/i.test(message) || !r?.status) {
    throw new AngelThrottleError(`Angel One ${what} throttled: ${message || 'data:null'}`);
  }
  throw new Error(`Angel One ${what} failed: status ${status} ${message}`.trim());
}
```

In `user-feed-session.ts`, replace the body of the `if (opts.throwOnThrottle && response?.data == null) { … }` block in `getQuotes` with one call (keep the comment above it):

```typescript
    if (opts.throwOnThrottle && response?.data == null) {
      throwForMissingData(response, `marketData (${refs.length} token(s))`);
    }
```

add `throwForMissingData` to the existing import from `./angel-throttle`, and add this method directly after `getCandles`:

```typescript
  /**
   * ONE getCandleData call for one window, for the market hub's CandleStore:
   * the store sizes windows itself and sends each call through its Governor,
   * so there is no chunking, retry or pacing here. A throttle rejects with
   * AngelThrottleError (never []); a genuine "no bars" answer resolves [].
   */
  async getCandleWindow(token: string, exchange: string, interval: string, from: Date, to: Date): Promise<Candle[]> {
    await this.ensureConnected();
    if (!this.smartApi) {
      throw new Error('UserFeedSession has no SmartAPI client after connect');
    }
    const response: any = await this.smartApi.getCandleData({
      exchange,
      symboltoken: token,
      interval,
      fromdate: formatAngelDateTime(from),
      todate: formatAngelDateTime(to),
    });
    if (response?.data == null) {
      throwForMissingData(response, `getCandleData token=${token} interval=${interval}`);
    }
    return mapCandleRows(response.data);
  }
```

In `user-feed-manager.service.ts`, add directly after `fetchCandles`:

```typescript
  /** ONE getCandleData window over the user's OWN session (the market hub's CandleStore). */
  async fetchCandleWindow(userId: string, ref: TokenRef, interval: string, from: Date, to: Date) {
    const entry = this.getOrCreateEntry(userId);
    return entry.session.getCandleWindow(ref.token, ref.exchange, interval, from, to);
  }
```

(`TokenRef` is already imported in that file; if not, import it from `./user-feed.types`.)

In `hub-broker.ts`:
- add `import type { BrokerInterval, HubCandle } from './candles/candle.types';`
- add to `interface HubBroker`:

```typescript
  /** ONE getCandleData window. Rejects with AngelThrottleError when throttled; [] means no bars. */
  candles(ref: InstrumentRef, interval: BrokerInterval, from: Date, to: Date): Promise<HubCandle[]>;
```

- add `'fetchCandleWindow'` to the `Pick<UserFeedManager, …>` union in the `ManagerHubBroker` constructor;
- add to `ManagerHubBroker`:

```typescript
  async candles(ref: InstrumentRef, interval: BrokerInterval, from: Date, to: Date): Promise<HubCandle[]> {
    const rows = await this.manager.fetchCandleWindow(this.ownerUserId, toTokenRef(ref), interval, from, to);
    return rows.map((c) => ({
      ts: c.timestamp.getTime(),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: Number(c.volume),
    }));
  }
```

In `testing/fake-broker.ts`:
- add `import type { BrokerInterval, HubCandle } from '../candles/candle.types';`
- add fields and the method:

```typescript
  readonly candleCalls: Array<{ ref: InstrumentRef; interval: BrokerInterval; from: Date; to: Date }> = [];
  candlesImpl: (ref: InstrumentRef, interval: BrokerInterval, from: Date, to: Date) => Promise<HubCandle[]> = async () => [];

  candles(ref: InstrumentRef, interval: BrokerInterval, from: Date, to: Date): Promise<HubCandle[]> {
    this.candleCalls.push({ ref, interval, from, to });
    return this.candlesImpl(ref, interval, from, to);
  }
```

- [ ] **Step 4: Run tests to verify they pass, and that market-data and market-hub stay green**

Run: `pnpm --filter @td/api test -- user-feed-session.spec user-feed-manager.service.spec hub-broker.spec`
Expected: PASS.
Run: `pnpm --filter @td/api test -- market-data market-hub`
Expected: PASS (including the existing `getQuotes` throttle tests and `only-door.spec`).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/market-data/services/angel-throttle.ts apps/api/src/modules/market-data/services/user-feed-session.ts apps/api/src/modules/market-data/services/user-feed-session.spec.ts apps/api/src/modules/market-data/services/user-feed-manager.service.ts apps/api/src/modules/market-data/services/user-feed-manager.service.spec.ts apps/api/src/modules/market-hub/hub-broker.ts apps/api/src/modules/market-hub/hub-broker.spec.ts apps/api/src/modules/market-hub/testing/fake-broker.ts
git commit -m "feat(market-hub): one-window candle fetch on the owner's session, throttles reported" -- apps/api/src/modules/market-data/services/angel-throttle.ts apps/api/src/modules/market-data/services/user-feed-session.ts apps/api/src/modules/market-data/services/user-feed-session.spec.ts apps/api/src/modules/market-data/services/user-feed-manager.service.ts apps/api/src/modules/market-data/services/user-feed-manager.service.spec.ts apps/api/src/modules/market-hub/hub-broker.ts apps/api/src/modules/market-hub/hub-broker.spec.ts apps/api/src/modules/market-hub/testing/fake-broker.ts
```

---

### Task 5: CandleStore: read path, gap fill, coverage, nightly fix-up

**Files:**
- Create: `apps/api/src/modules/market-hub/candles/candle-store.ts`
- Test: `apps/api/src/modules/market-hub/candles/candle-store.spec.ts`

**Interfaces:**
- Consumes: `CandleRepo` (Task 3), `MemoryCandleRepo` (tests), `Governor.submit` + `GovResult` (M1), `SessionClock` (M1 + Task 1), `expectedPerDay`/`barEnd`/`istDay`/`istMidnight`/`addDays` (Task 1), `candle.types` (Task 1), `aggregateCandles`, `AGGREGATED_MIN_LOOKBACK_DAYS`, `Candle` from `market-data/services/user-historical.util.ts`, `sessionFor` from `trade-sentinel/market-sessions.ts`.
- Produces:

```typescript
export type CandleFetcher = (ref: InstrumentRef, interval: BrokerInterval, from: Date, to: Date) => Promise<HubCandle[]>;
export interface CandleStoreDeps {
  repo: CandleRepo; governor: Pick<Governor, 'submit'>; clock: SessionClock; fetch: CandleFetcher;
  interactiveCallBudget: number; now?: () => number;
}
export interface FixupReport { day: string; at: number; instruments: number; calls: number; failures: number }
export interface CandleStoreMetrics { reads: number; readP95Ms: number; dbReadP95Ms: number; deferredFills: number; fillErrors: number; lastError: string | null }
export class CandleStore {
  constructor(d: CandleStoreDeps);
  candles(ref: InstrumentRef, timeframe: Timeframe, from: number, to: number, opts: { lane: Lane }): Promise<CandlesResult>;
  fixup(day: string, refs: readonly InstrumentRef[]): Promise<FixupReport>;
  metrics(): CandleStoreMetrics;
}
```

- [ ] **Step 1: Write the failing test**

```typescript
import type { GovRequest, GovResult } from '../governor';
import { LANE, type InstrumentRef, type Lane } from '../hub.types';
import { SessionClock } from '../session-clock';
import { MemoryCandleRepo } from '../testing/memory-candle-repo';
import type { BrokerInterval, HubCandle } from './candle.types';
import { CandleStore } from './candle-store';
import { istMidnight } from './trading-calendar';

const ist = (s: string) => Date.parse(`${s}+05:30`);
const REF: InstrumentRef = { exchange: 'NSE', token: '2885', symbol: 'RELIANCE' };
const clock = new SessionClock({
  holidays: { 2026: [{ date: '2026-10-02', name: 'Gandhi Jayanti', exchanges: ['NSE', 'BSE', 'NFO', 'MCX'] }] },
});

/** NSE 1-minute bars on `ymd` for IST minutes [fromMin, toMin). */
function minutes(ymd: string, fromMin = 555, toMin = 930): HubCandle[] {
  const out: HubCandle[] = [];
  for (let m = fromMin; m < toMin; m++) {
    out.push({ ts: istMidnight(ymd) + m * 60_000, open: 100, high: 101, low: 99, close: 100, volume: 1 });
  }
  return out;
}

function setup(
  opts: {
    budget?: number;
    result?: (req: GovRequest<HubCandle[]>) => GovResult<HubCandle[]> | null;
    /** Hold Background-lane calls until release() so a test can read before they land. */
    holdBackground?: boolean;
  } = {},
) {
  let now = ist('2026-10-07T16:00:00');
  const repo = new MemoryCandleRepo();
  const calls: Array<{ interval: BrokerInterval; from: Date; to: Date }> = [];
  const lanes: Lane[] = [];
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let respond: (interval: BrokerInterval, from: Date, to: Date) => HubCandle[] = () => [];
  const fetch = async (_ref: InstrumentRef, interval: BrokerInterval, from: Date, to: Date) => {
    calls.push({ interval, from, to });
    return respond(interval, from, to);
  };
  const governor = {
    submit: async <T>(req: GovRequest<T>): Promise<GovResult<T>> => {
      lanes.push(req.lane);
      if (opts.holdBackground && req.lane === LANE.BACKGROUND) await held;
      const forced = opts.result?.(req as unknown as GovRequest<HubCandle[]>);
      if (forced) return forced as unknown as GovResult<T>;
      return { kind: 'ok', value: await req.run() };
    },
  };
  const store = new CandleStore({ repo, governor, clock, fetch, interactiveCallBudget: opts.budget ?? 6, now: () => now });
  return {
    store, repo, calls, lanes, release,
    setNow: (t: number) => { now = t; },
    respond: (fn: typeof respond) => { respond = fn; },
  };
}
const DAY = 86_400_000;
const day = (ymd: string) => [istMidnight(ymd), istMidnight(ymd) + DAY] as const;
/** Let chained promises (and setImmediate) run to completion. */
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

describe('CandleStore', () => {
  it('serves from the database without calling the broker when every bar is there', async () => {
    const t = setup();
    await t.repo.upsert('1m', REF, minutes('2026-10-06'), 'broker');
    const r = await t.store.candles(REF, '1m', ...day('2026-10-06'), { lane: LANE.INTERACTIVE });
    expect(r.candles).toHaveLength(375);
    expect(r.incomplete).toEqual([]);
    expect(t.calls).toHaveLength(0);
  });

  it('fills a missing past day once and remembers it, even when the broker has fewer bars than expected', async () => {
    const t = setup();
    t.respond(() => minutes('2026-10-06', 555, 855)); // illiquid: 300 of 375 minutes traded
    const first = await t.store.candles(REF, '1m', ...day('2026-10-06'), { lane: LANE.INTERACTIVE });
    expect(t.calls).toEqual([{ interval: 'ONE_MINUTE', from: new Date(istMidnight('2026-10-06')), to: new Date(istMidnight('2026-10-07')) }]);
    expect(first.candles).toHaveLength(300);
    const second = await t.store.candles(REF, '1m', ...day('2026-10-06'), { lane: LANE.INTERACTIVE });
    expect(t.calls).toHaveLength(1);
    expect(second.candles).toHaveLength(300);
  });

  it('a throttled fill is reported as incomplete and retried next time', async () => {
    let throttle = true;
    const t = setup({ result: () => (throttle ? { kind: 'throttled', retryAfterMs: 1000 } : null) });
    t.respond(() => minutes('2026-10-06'));
    const r = await t.store.candles(REF, '1m', ...day('2026-10-06'), { lane: LANE.INTERACTIVE });
    expect(r.candles).toEqual([]);
    expect(r.incomplete).toEqual([{ from: istMidnight('2026-10-06'), to: istMidnight('2026-10-07'), reason: 'throttled' }]);
    throttle = false;
    const again = await t.store.candles(REF, '1m', ...day('2026-10-06'), { lane: LANE.INTERACTIVE });
    expect(again.candles).toHaveLength(375);
    expect(again.incomplete).toEqual([]);
  });

  it('waits for at most the interactive budget, newest first, and fills the rest in the background', async () => {
    const t = setup({ budget: 2, holdBackground: true });
    t.setNow(ist('2026-10-10T12:00:00')); // Saturday: Mon 5 .. Fri 9 Oct are all complete
    // from + 5h30m = 00:00 UTC on the requested IST date, so this names the day asked for.
    t.respond((_i, from) => minutes(new Date(from.getTime() + 19_800_000).toISOString().slice(0, 10)));
    const r = await t.store.candles(REF, '30m', istMidnight('2026-10-05'), istMidnight('2026-10-10'), { lane: LANE.INTERACTIVE });
    expect(t.lanes).toEqual([LANE.INTERACTIVE, LANE.INTERACTIVE, LANE.BACKGROUND, LANE.BACKGROUND, LANE.BACKGROUND]);
    expect(t.calls.map((c) => c.from)).toEqual([new Date(istMidnight('2026-10-09')), new Date(istMidnight('2026-10-08'))]);
    expect(r.incomplete).toEqual([
      { from: istMidnight('2026-10-07'), to: istMidnight('2026-10-08'), reason: 'deferred' },
      { from: istMidnight('2026-10-06'), to: istMidnight('2026-10-07'), reason: 'deferred' },
      { from: istMidnight('2026-10-05'), to: istMidnight('2026-10-06'), reason: 'deferred' },
    ]);
    expect(r.candles.length).toBe(2 * 13); // two filled days × 13 thirty-minute bars (09:15 … 15:15)
    expect(t.store.metrics().deferredFills).toBe(3);
    t.release();
    await settle();
    expect(t.calls).toHaveLength(5);
    const after = await t.store.candles(REF, '30m', istMidnight('2026-10-05'), istMidnight('2026-10-10'), { lane: LANE.INTERACTIVE });
    expect(after.incomplete).toEqual([]);
    expect(after.candles.length).toBe(5 * 13);
    expect(t.calls).toHaveLength(5); // nothing re-fetched
  });

  it('today: drops the forming bar and re-fetches only after a new bar completes', async () => {
    const t = setup();
    t.setNow(ist('2026-10-07T10:00:30'));
    t.respond(() => minutes('2026-10-07', 555, 601)); // includes the forming 10:00 bar
    const r = await t.store.candles(REF, '1m', ...day('2026-10-07'), { lane: LANE.INTERACTIVE });
    expect(r.candles).toHaveLength(45); // 09:15 .. 09:59
    t.setNow(ist('2026-10-07T10:00:50'));
    await t.store.candles(REF, '1m', ...day('2026-10-07'), { lane: LANE.INTERACTIVE });
    expect(t.calls).toHaveLength(1);
    t.setNow(ist('2026-10-07T10:01:05'));
    await t.store.candles(REF, '1m', ...day('2026-10-07'), { lane: LANE.INTERACTIVE });
    expect(t.calls).toHaveLength(2);
    expect(t.calls[1].to).toEqual(new Date(ist('2026-10-07T10:01:05')));
  });

  it('1h: completed days from candles_1h, today grouped from 1m at 09:15', async () => {
    const t = setup();
    t.setNow(ist('2026-10-07T10:15:30'));
    const hourly = [555, 615, 675, 735, 795, 855, 915].map((m) => ({ ts: istMidnight('2026-10-06') + m * 60_000, open: 1, high: 1, low: 1, close: 1, volume: 60 }));
    await t.repo.upsert('1h', REF, hourly, 'broker');
    await t.repo.markCovered('1h', REF, ['2026-10-06']);
    await t.repo.upsert('1m', REF, minutes('2026-10-07', 555, 615), 'tick');
    const r = await t.store.candles(REF, '1h', istMidnight('2026-10-06'), ist('2026-10-07T10:15:30'), { lane: LANE.INTERACTIVE });
    expect(t.calls).toHaveLength(0);
    expect(r.candles).toHaveLength(8);
    expect(r.candles[7]).toMatchObject({ ts: ist('2026-10-07T09:15:00'), volume: 60 });
  });

  it('1w rolls up daily bars and widens the lower bound to five years', async () => {
    const t = setup();
    t.respond(() => []);
    const days = ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-05', '2026-10-06'];
    await t.repo.upsert('1d', REF, days.map((d, i) => ({ ts: istMidnight(d), open: i, high: 10 + i, low: i, close: i, volume: 1 })), 'broker');
    const to = istMidnight('2026-10-07');
    const r = await t.store.candles(REF, '1w', to - 7 * DAY, to, { lane: LANE.BACKGROUND });
    expect(r.candles.map((c) => c.volume)).toEqual([4, 2]); // Sep 28–Oct 1 (Oct 2 holiday), Oct 5–6
    // The fill reaches back ~5 years (first window starts at the first trading day on/after to − 1825 days).
    expect(Math.min(...t.calls.map((c) => c.from.getTime()))).toBeLessThanOrEqual(to - 1820 * DAY);
    expect(t.calls.length).toBe(2); // 1825 days > one 1800-day window
    expect(t.calls.every((c) => c.interval === 'ONE_DAY')).toBe(true);
  });

  it('ignores broker bars outside the window (Angel’s todate is inclusive)', async () => {
    const t = setup();
    t.respond(() => [
      { ts: istMidnight('2026-10-06'), open: 1, high: 1, low: 1, close: 1, volume: 1 },
      { ts: istMidnight('2026-10-07'), open: 9, high: 9, low: 9, close: 9, volume: 9 },
    ]);
    const r = await t.store.candles(REF, '1d', ...day('2026-10-06'), { lane: LANE.INTERACTIVE });
    expect(r.candles).toEqual([{ ts: istMidnight('2026-10-06'), open: 1, high: 1, low: 1, close: 1, volume: 1 }]);
    expect(await t.repo.read('1d', REF, istMidnight('2026-10-07'), istMidnight('2026-10-08'))).toEqual([]);
  });

  it('a weekend-only range needs no broker call and is not incomplete', async () => {
    const t = setup();
    const r = await t.store.candles(REF, '1m', istMidnight('2026-10-10'), istMidnight('2026-10-12'), { lane: LANE.INTERACTIVE });
    expect(r).toEqual({ candles: [], incomplete: [] });
    expect(t.calls).toHaveLength(0);
  });

  it('records read latency', async () => {
    const t = setup();
    await t.store.candles(REF, '1m', ...day('2026-10-10'), { lane: LANE.INTERACTIVE });
    expect(t.store.metrics()).toMatchObject({ reads: 1, fillErrors: 0, lastError: null });
  });

  it('nightly fix-up replaces tick bars with the broker’s for 1m, 1h and the last week of 1d', async () => {
    const t = setup();
    t.setNow(ist('2026-10-08T00:15:00'));
    await t.repo.upsert('1m', REF, [{ ts: ist('2026-10-07T10:00:00'), open: 1, high: 1, low: 1, close: 1, volume: 999 }], 'tick');
    t.respond((interval) =>
      interval === 'ONE_MINUTE' ? minutes('2026-10-07') :
      interval === 'ONE_HOUR' ? [{ ts: ist('2026-10-07T09:15:00'), open: 1, high: 1, low: 1, close: 1, volume: 1 }] :
      [{ ts: istMidnight('2026-10-07'), open: 1, high: 1, low: 1, close: 1, volume: 1 }],
    );
    const report = await t.store.fixup('2026-10-07', [REF]);
    expect(report).toMatchObject({ day: '2026-10-07', instruments: 1, calls: 3, failures: 0 });
    expect(t.calls.map((c) => c.interval)).toEqual(['ONE_MINUTE', 'ONE_HOUR', 'ONE_DAY']);
    expect(t.lanes).toEqual([LANE.BACKGROUND, LANE.BACKGROUND, LANE.BACKGROUND]);
    const [tenAm] = await t.repo.read('1m', REF, ist('2026-10-07T10:00:00'), ist('2026-10-07T10:01:00'));
    expect(tenAm.volume).toBe(1); // broker replaced the tick bar
    expect(await t.repo.coveredDays('1m', REF, ['2026-10-07'])).toEqual(new Set(['2026-10-07']));
  });

  it('nightly fix-up skips an instrument whose exchange did not trade that day', async () => {
    const t = setup();
    const report = await t.store.fixup('2026-10-02', [REF]); // holiday
    expect(report).toMatchObject({ instruments: 0, calls: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @td/api test -- candle-store.spec`
Expected: FAIL with `Cannot find module './candle-store'`.

- [ ] **Step 3: Implement**

```typescript
import {
  aggregateCandles,
  AGGREGATED_MIN_LOOKBACK_DAYS,
  type Candle,
} from '../../market-data/services/user-historical.util';
import { sessionFor } from '../../trade-sentinel/market-sessions';
import type { Governor } from '../governor';
import { LANE, refKey, type InstrumentRef, type Lane } from '../hub.types';
import type { SessionClock } from '../session-clock';
import type { CandleRepo } from './candle-repository';
import {
  BASE_TABLE,
  STEP_MIN,
  TABLE_INTERVAL,
  TABLE_MAX_DAYS,
  type BrokerInterval,
  type CandleTable,
  type CandlesResult,
  type HubCandle,
  type IncompleteRange,
  type IncompleteReason,
  type Timeframe,
} from './candle.types';
import { addDays, barEnd, expectedPerDay, istDay, istMidnight } from './trading-calendar';

export type CandleFetcher = (ref: InstrumentRef, interval: BrokerInterval, from: Date, to: Date) => Promise<HubCandle[]>;

export interface CandleStoreDeps {
  repo: CandleRepo;
  governor: Pick<Governor, 'submit'>;
  clock: SessionClock;
  fetch: CandleFetcher;
  /** Broker calls one waiting request may make; the rest are filled in the background. */
  interactiveCallBudget: number;
  now?: () => number;
}

export interface FixupReport {
  day: string;
  at: number;
  instruments: number;
  calls: number;
  failures: number;
}

export interface CandleStoreMetrics {
  reads: number;
  readP95Ms: number;
  dbReadP95Ms: number;
  deferredFills: number;
  fillErrors: number;
  lastError: string | null;
}

interface Part {
  table: CandleTable;
  from: number;
  to: number;
}
interface FetchWindow extends Part {
  /** The IST days this window was asked for (they get marked covered on success). */
  days: string[];
}

const DAY_MS = 86_400_000;
const SAMPLES = 200;
const MAX_TODAY_KEYS = 5000;

function p95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)];
}

/**
 * Charts read candles from the database. Missing bars are found by comparing
 * stored counts with the SessionClock's expected bars per IST day, fetched
 * from Angel One once through the Governor, stored, and remembered: a past day
 * the broker has answered for is never asked again (illiquid instruments have
 * genuinely empty minutes). Today is remembered in memory up to the moment of
 * the last fetch. Never returns a throttle as "no data": unfilled ranges come
 * back in `incomplete` with a reason.
 */
export class CandleStore {
  private readonly todayCoverage = new Map<string, { day: string; until: number }>();
  private readonly readMs: number[] = [];
  private readonly dbMs: number[] = [];
  private reads = 0;
  private deferredFills = 0;
  private fillErrors = 0;
  private lastError: string | null = null;

  constructor(private readonly d: CandleStoreDeps) {}

  private now(): number {
    return this.d.now ? this.d.now() : Date.now();
  }

  async candles(ref: InstrumentRef, timeframe: Timeframe, from: number, to: number, opts: { lane: Lane }): Promise<CandlesResult> {
    const started = this.now();
    let lo = from;
    if (timeframe === '1w' || timeframe === '1mo') {
      lo = Math.min(from, to - AGGREGATED_MIN_LOOKBACK_DAYS[timeframe] * DAY_MS);
    }
    const today = istMidnight(istDay(started));
    const parts: Part[] = [];
    if (timeframe === '1h' && to > today) {
      if (lo < today) parts.push({ table: '1h', from: lo, to: today });
      parts.push({ table: '1m', from: Math.max(lo, today), to });
    } else {
      parts.push({ table: BASE_TABLE[timeframe], from: lo, to });
    }

    const incomplete = await this.fill(ref, parts, opts.lane);
    const dbStarted = this.now();
    const candles = await this.readParts(ref, timeframe, parts);
    this.record(this.now() - started, this.now() - dbStarted);
    return { candles, incomplete };
  }

  /** Replace `day`'s bars with the broker's: 1m and 1h for the day, 1d for the week ending that day. */
  async fixup(day: string, refs: readonly InstrumentRef[]): Promise<FixupReport> {
    const report: FixupReport = { day, at: this.now(), instruments: 0, calls: 0, failures: 0 };
    const start = istMidnight(day);
    const end = istMidnight(addDays(day, 1));
    for (const ref of refs) {
      if (!this.d.clock.isTradingDay(ref.exchange, new Date(start))) continue;
      report.instruments++;
      const weekStart = istMidnight(addDays(day, -7));
      const dailyDays = [...expectedPerDay(this.d.clock, ref.exchange, '1d', weekStart, end, Number.MAX_SAFE_INTEGER).keys()];
      const windows: FetchWindow[] = [
        { table: '1m', from: start, to: end, days: [day] },
        { table: '1h', from: start, to: end, days: [day] },
        { table: '1d', from: weekStart, to: end, days: dailyDays },
      ];
      for (const w of windows) {
        report.calls++;
        if ((await this.fetchWindow(ref, w, LANE.BACKGROUND)) !== null) report.failures++;
      }
    }
    return report;
  }

  metrics(): CandleStoreMetrics {
    return {
      reads: this.reads,
      readP95Ms: p95(this.readMs),
      dbReadP95Ms: p95(this.dbMs),
      deferredFills: this.deferredFills,
      fillErrors: this.fillErrors,
      lastError: this.lastError,
    };
  }

  private async fill(ref: InstrumentRef, parts: Part[], lane: Lane): Promise<IncompleteRange[]> {
    const windows: FetchWindow[] = [];
    for (const p of parts) windows.push(...(await this.gapWindows(ref, p)));
    windows.sort((a, b) => b.from - a.from); // newest first: the live edge matters most
    const background = lane === LANE.BACKGROUND;
    const now = background ? windows : windows.slice(0, this.d.interactiveCallBudget);
    const later = background ? [] : windows.slice(this.d.interactiveCallBudget);

    const incomplete: IncompleteRange[] = [];
    const reasons = await Promise.all(now.map((w) => this.fetchWindow(ref, w, lane)));
    reasons.forEach((reason, i) => {
      if (reason) incomplete.push({ from: now[i].from, to: now[i].to, reason });
    });
    for (const w of later) {
      incomplete.push({ from: w.from, to: w.to, reason: 'deferred' });
      this.deferredFills++;
      void this.fetchWindow(ref, w, LANE.BACKGROUND);
    }
    return incomplete;
  }

  private async gapWindows(ref: InstrumentRef, p: Part): Promise<FetchWindow[]> {
    if (p.to <= p.from) return [];
    const now = this.now();
    const expected = expectedPerDay(this.d.clock, ref.exchange, p.table, p.from, p.to, now);
    if (expected.size === 0) return [];
    const have = await this.d.repo.dayCounts(p.table, ref, p.from, p.to);
    const today = istDay(now);
    const short = [...expected]
      .filter(([day, n]) => (have.get(day) ?? 0) < n)
      .map(([day]) => day)
      .filter((day) => day !== today || !this.todayCovered(ref, p, now));
    const past = short.filter((day) => day !== today);
    const covered = await this.d.repo.coveredDays(p.table, ref, past);
    return this.toWindows(p.table, short.filter((day) => !covered.has(day)).sort());
  }

  /** True when the last fetch for today already covered every bar completed since. */
  private todayCovered(ref: InstrumentRef, p: Part, now: number): boolean {
    const today = istDay(now);
    const c = this.todayCoverage.get(`${p.table}:${refKey(ref)}`);
    if (!c || c.day !== today) return false;
    const from = Math.max(p.from, istMidnight(today));
    const to = Math.min(p.to, istMidnight(addDays(today, 1)));
    const byNow = expectedPerDay(this.d.clock, ref.exchange, p.table, from, to, now).get(today) ?? 0;
    const byFetch = expectedPerDay(this.d.clock, ref.exchange, p.table, from, to, c.until).get(today) ?? 0;
    return byFetch >= byNow;
  }

  /** 1m: one call per day. 1h/1d: consecutive needed days merged up to the per-call limit. */
  private toWindows(table: CandleTable, days: string[]): FetchWindow[] {
    if (table === '1m') {
      return days.map((day) => ({ table, from: istMidnight(day), to: istMidnight(addDays(day, 1)), days: [day] }));
    }
    const out: FetchWindow[] = [];
    let cur: FetchWindow | null = null;
    for (const day of days) {
      const start = istMidnight(day);
      const end = istMidnight(addDays(day, 1));
      if (cur && end - cur.from <= TABLE_MAX_DAYS[table] * DAY_MS) {
        cur.to = end;
        cur.days.push(day);
      } else {
        cur = { table, from: start, to: end, days: [day] };
        out.push(cur);
      }
    }
    return out;
  }

  /** One broker call through the Governor. Returns null on success, else why it failed. */
  private async fetchWindow(ref: InstrumentRef, w: FetchWindow, lane: Lane): Promise<IncompleteReason | null> {
    const interval = TABLE_INTERVAL[w.table];
    const asked = this.now();
    const result = await this.d.governor.submit({
      endpoint: 'candles',
      lane,
      key: `candles:${refKey(ref)}:${interval}:${w.from}:${w.to}`,
      run: () => this.d.fetch(ref, interval, new Date(w.from), new Date(Math.min(w.to, asked))),
    });
    if (result.kind !== 'ok') {
      if (result.kind === 'error') this.noteError(result.error);
      return result.kind;
    }
    try {
      const todayStart = istMidnight(istDay(asked));
      const complete = result.value.filter(
        (c) =>
          c.ts >= w.from &&
          c.ts < w.to &&
          (c.ts < todayStart || barEnd(this.d.clock, ref.exchange, w.table, c.ts) <= asked),
      );
      await this.d.repo.upsert(w.table, ref, complete, 'broker');
      const today = istDay(asked);
      const past = w.days.filter((day) => day < today);
      if (past.length > 0) await this.d.repo.markCovered(w.table, ref, past);
      if (w.days.includes(today)) this.rememberToday(`${w.table}:${refKey(ref)}`, today, asked);
      return null;
    } catch (err) {
      this.noteError(err);
      return 'error';
    }
  }

  private rememberToday(key: string, day: string, until: number): void {
    if (this.todayCoverage.size >= MAX_TODAY_KEYS) {
      for (const [k, v] of this.todayCoverage) if (v.day !== day) this.todayCoverage.delete(k);
    }
    this.todayCoverage.set(key, { day, until });
  }

  private async readParts(ref: InstrumentRef, timeframe: Timeframe, parts: Part[]): Promise<HubCandle[]> {
    const out: HubCandle[] = [];
    const origin = sessionFor(ref.exchange).openMin;
    for (const p of parts) {
      if (p.to <= p.from) continue;
      if (p.table === '1m' && timeframe !== '1m') {
        const step = STEP_MIN[timeframe as keyof typeof STEP_MIN];
        out.push(...(await this.d.repo.readBucketed(ref, step, origin, p.from, p.to)));
      } else {
        out.push(...(await this.d.repo.read(p.table, ref, p.from, p.to)));
      }
    }
    if (timeframe !== '1w' && timeframe !== '1mo') return out;
    const daily: Candle[] = out.map((c) => ({
      timestamp: new Date(c.ts), open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
    }));
    return aggregateCandles(daily, timeframe === '1w' ? 'week' : 'month').map((c) => ({
      ts: c.timestamp.getTime(), open: c.open, high: c.high, low: c.low, close: c.close, volume: Number(c.volume),
    }));
  }

  private record(totalMs: number, dbMs: number): void {
    this.reads++;
    this.readMs.push(totalMs);
    this.dbMs.push(dbMs);
    if (this.readMs.length > SAMPLES) this.readMs.shift();
    if (this.dbMs.length > SAMPLES) this.dbMs.shift();
  }

  private noteError(err: unknown): void {
    this.fillErrors++;
    this.lastError = err instanceof Error ? err.message : String(err);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @td/api test -- candle-store.spec`
Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/market-hub/candles/candle-store.ts apps/api/src/modules/market-hub/candles/candle-store.spec.ts
git commit -m "feat(market-hub): CandleStore — database first, gaps filled once through the Governor, nightly fix-up" -- apps/api/src/modules/market-hub/candles/candle-store.ts apps/api/src/modules/market-hub/candles/candle-store.spec.ts
```

---

### Task 6: HubEngine wiring: tick bars, candles(), fix-up, status

**Files:**
- Modify: `apps/api/src/modules/market-hub/hub-engine.ts`
- Test: `apps/api/src/modules/market-hub/hub-engine.spec.ts`

**Interfaces:**
- Consumes: `CandleBuilder` (Task 2), `CandleRepo` (Task 3), `CandleStore`/`FixupReport` (Task 5), `HubBroker.candles` (Task 4).
- Produces (on `HubEngine`):
  - `HubEngineDeps.candles?: { repo: CandleRepo; interactiveCallBudget?: number }`
  - `get candlesEnabled(): boolean`
  - `candles(ref: InstrumentRef, timeframe: Timeframe, from: number, to: number, lane?: Lane): Promise<CandlesResult>` (rejects when candles are not enabled)
  - `runFixup(day: string): Promise<FixupReport>`
  - `HubStatus.candles: CandleStatus | null` with

```typescript
export interface CandleStatus {
  building: number;
  lateTicks: number;
  tickBarsWritten: number;
  tickBarsDropped: number;
  tickWriteFailures: number;
  lastTickWriteAt: number | null;
  reads: number;
  readP95Ms: number;
  dbReadP95Ms: number;
  deferredFills: number;
  fillErrors: number;
  lastError: string | null;
  lastFixup: FixupReport | null;
}
```

- [ ] **Step 1: Write the failing tests**

Append inside `describe('HubEngine', …)` in `hub-engine.spec.ts` (the file has `IST`, `NIFTY`, `engine()`, fake timers at 2026-10-07 10:00 IST). Add imports at the top: `import { MemoryCandleRepo } from './testing/memory-candle-repo';`.

```typescript
  function engineWithCandles(broker = new FakeBroker(), repo = new MemoryCandleRepo()) {
    const e = new HubEngine({
      broker,
      clock: new SessionClock({ holidays: MARKET_HOLIDAYS }),
      cap: 50,
      defaults: [NIFTY],
      candles: { repo },
    });
    return { e, broker, repo };
  }

  it('has no candle status and refuses candles() when candles are not enabled', async () => {
    const { e } = engine();
    await e.start();
    expect(e.status().candles).toBeNull();
    expect(e.candlesEnabled).toBe(false);
    await expect(e.candles(NIFTY, '1m', 0, 1)).rejects.toThrow(/not enabled/);
    e.stop();
  });

  it('turns live ticks into a tick-sourced 1m bar once the minute closes', async () => {
    const { e, broker, repo } = engineWithCandles();
    await e.start();
    jest.setSystemTime(IST('2026-10-07T10:00:10'));
    broker.emitTick({ ...FakeBroker.tick('99926000', 100, 'NSE'), volume: 1000 });
    jest.setSystemTime(IST('2026-10-07T10:00:40'));
    broker.emitTick({ ...FakeBroker.tick('99926000', 101, 'NSE'), volume: 1300 });
    jest.setSystemTime(IST('2026-10-07T10:01:05'));
    broker.emitTick({ ...FakeBroker.tick('99926000', 102, 'NSE'), volume: 1350 });
    await jest.advanceTimersByTimeAsync(5000);
    const bars = await repo.read('1m', NIFTY, IST('2026-10-07T10:00:00'), IST('2026-10-07T10:01:00'));
    expect(bars).toEqual([{ ts: IST('2026-10-07T10:00:00'), open: 100, high: 101, low: 100, close: 101, volume: 300 }]);
    expect(e.status().candles).toMatchObject({ tickBarsWritten: 1, tickWriteFailures: 0, building: 1 });
    e.stop();
  });

  it('counts a failed tick-bar write instead of throwing', async () => {
    const repo = new MemoryCandleRepo();
    repo.failWrites = true;
    const { e, broker } = engineWithCandles(new FakeBroker(), repo);
    await e.start();
    broker.emitTick(FakeBroker.tick('99926000', 100, 'NSE'));
    jest.setSystemTime(IST('2026-10-07T10:01:05'));
    broker.emitTick(FakeBroker.tick('99926000', 101, 'NSE'));
    await jest.advanceTimersByTimeAsync(5000);
    expect(e.status().candles).toMatchObject({ tickBarsWritten: 0, tickWriteFailures: 1 });
    e.stop();
  });

  it('candles() fills through the broker’s candles endpoint under the Governor', async () => {
    const { e, broker } = engineWithCandles();
    await e.start();
    const p = e.candles(NIFTY, '1m', IST('2026-10-06T00:00:00'), IST('2026-10-07T00:00:00'));
    await jest.advanceTimersByTimeAsync(1000);
    const r = await p;
    expect(r).toEqual({ candles: [], incomplete: [] });
    expect(broker.candleCalls.map((c) => c.interval)).toEqual(['ONE_MINUTE']);
    expect(e.status().governor.endpoints.candles.callsLastMin).toBe(1);
    e.stop();
  });

  it('runFixup covers tick instruments and watched instruments and records the report', async () => {
    const { e, broker, repo } = engineWithCandles();
    await e.start();
    await repo.upsert('1m', { exchange: 'NSE', token: '2885', symbol: '2885' }, [
      { ts: IST('2026-10-06T10:00:00'), open: 1, high: 1, low: 1, close: 1, volume: 1 },
    ], 'tick');
    const p = e.runFixup('2026-10-06');
    await jest.advanceTimersByTimeAsync(60_000);
    const report = await p;
    expect(report).toMatchObject({ day: '2026-10-06', instruments: 2, calls: 6 }); // NIFTY (watched) + 2885 (tick)
    expect(new Set(broker.candleCalls.map((c) => c.ref.token))).toEqual(new Set(['99926000', '2885']));
    expect(e.status().candles?.lastFixup).toEqual(report);
    e.stop();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @td/api test -- hub-engine.spec`
Expected: FAIL. `e.status().candles` is `undefined`; `candles is not a function`.

- [ ] **Step 3: Implement**

In `hub-engine.ts`:

Imports to add:

```typescript
import { CandleBuilder, type ClosedBar } from './candles/candle-builder';
import type { CandleRepo } from './candles/candle-repository';
import { CandleStore, type FixupReport } from './candles/candle-store';
import type { CandlesResult, Timeframe } from './candles/candle.types';
import { istMidnight } from './candles/trading-calendar';
import { LANE, type Lane } from './hub.types';
```

(merge `LANE`/`Lane` into the existing `./hub.types` import.)

Extend `HubEngineDeps`:

```typescript
  /** M2 CandleStore. Absent ⇒ no tick bars, no candle reads (M1 behaviour). */
  candles?: { repo: CandleRepo; interactiveCallBudget?: number };
```

Add `CandleStatus` (exact shape in Interfaces above) and `candles: CandleStatus | null;` to `HubStatus`.

Constants: `const TICK_FLUSH_MS = 5000;` and `const MAX_PENDING_BARS = 20_000;`.

Fields on `HubEngine`:

```typescript
  private readonly builder: CandleBuilder | null = null;
  private readonly store: CandleStore | null = null;
  private pendingBars: ClosedBar[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private tickBarsWritten = 0;
  private tickBarsDropped = 0;
  private tickWriteFailures = 0;
  private lastTickWriteAt: number | null = null;
  private lastFixup: FixupReport | null = null;
```

At the end of the constructor:

```typescript
    if (d.candles) {
      const builder = new CandleBuilder();
      this.builder = builder;
      this.store = new CandleStore({
        repo: d.candles.repo,
        governor: this.governor,
        clock: d.clock,
        fetch: (ref, interval, from, to) => d.broker.candles(ref, interval, from, to),
        interactiveCallBudget: d.candles.interactiveCallBudget ?? 6,
      });
      this.feed.onPrice((p) => this.queueBars(builder.onPrice(p)));
    }
```

(The `readonly` fields are assigned in the constructor; declare them without the `= null` initializer and assign `null` in an `else` branch if TypeScript complains.)

In `start()`, after the maintenance timer is created:

```typescript
    if (this.builder) {
      this.flushTimer = setInterval(() => void this.flushBars(Date.now()), TICK_FLUSH_MS);
      this.flushTimer.unref?.();
    }
```

In `stop()`, before `this.governor.dispose()`:

```typescript
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = null;
    if (this.builder) void this.flushBars(Number.MAX_SAFE_INTEGER); // best effort: partial minutes as tick bars
```

New methods:

```typescript
  get candlesEnabled(): boolean {
    return this.store !== null;
  }

  candles(ref: InstrumentRef, timeframe: Timeframe, from: number, to: number, lane: Lane = LANE.INTERACTIVE): Promise<CandlesResult> {
    if (!this.store) return Promise.reject(new Error('candle store is not enabled (HUB_CANDLES_ENABLED)'));
    return this.store.candles(ref, timeframe, from, to, { lane });
  }

  /** Nightly fix-up for `day` (IST YYYY-MM-DD): instruments with tick bars that day + everything watched. */
  async runFixup(day: string): Promise<FixupReport> {
    if (!this.store || !this.d.candles) throw new Error('candle store is not enabled (HUB_CANDLES_ENABLED)');
    const refs = new Map<string, InstrumentRef>();
    for (const t of await this.d.candles.repo.tickInstruments(istMidnight(day))) {
      refs.set(refKey(t), { exchange: t.exchange, token: t.token, symbol: t.token });
    }
    for (const e of this.registry.entries()) refs.set(refKey(e.ref), e.ref);
    const report = await this.store.fixup(day, [...refs.values()]);
    this.lastFixup = report;
    return report;
  }

  private queueBars(bars: ClosedBar[]): void {
    if (bars.length === 0) return;
    this.pendingBars.push(...bars);
    const over = this.pendingBars.length - MAX_PENDING_BARS;
    if (over > 0) {
      this.pendingBars.splice(0, over);
      this.tickBarsDropped += over;
    }
  }

  /** Close due bars and write everything pending as tick bars. Never throws (timer). */
  private async flushBars(now: number): Promise<void> {
    if (!this.builder || !this.d.candles) return;
    this.queueBars(this.builder.closeDue(now));
    if (this.pendingBars.length === 0) return;
    const batch = this.pendingBars;
    this.pendingBars = [];
    const byRef = new Map<string, ClosedBar[]>();
    for (const b of batch) {
      const k = refKey(b.ref);
      const list = byRef.get(k);
      if (list) list.push(b);
      else byRef.set(k, [b]);
    }
    for (const bars of byRef.values()) {
      try {
        await this.d.candles.repo.upsert('1m', bars[0].ref, bars.map((b) => b.candle), 'tick');
        this.tickBarsWritten += bars.length;
        this.lastTickWriteAt = Date.now();
      } catch {
        // The nightly fix-up rewrites the day from the broker; count, don't retry.
        this.tickWriteFailures++;
      }
    }
  }
```

In `status()`, add to the returned object:

```typescript
      candles: this.candleStatus(),
```

and the helper:

```typescript
  private candleStatus(): CandleStatus | null {
    if (!this.builder || !this.store) return null;
    const b = this.builder.stats();
    return {
      building: b.building,
      lateTicks: b.lateTicks,
      tickBarsWritten: this.tickBarsWritten,
      tickBarsDropped: this.tickBarsDropped,
      tickWriteFailures: this.tickWriteFailures,
      lastTickWriteAt: this.lastTickWriteAt,
      ...this.store.metrics(),
      lastFixup: this.lastFixup,
    };
  }
```

- [ ] **Step 4: Run tests to verify they pass, and the rest of the hub and health stay green**

Run: `pnpm --filter @td/api test -- hub-engine.spec`
Expected: PASS (all tests, old and new).
Run: `pnpm --filter @td/api test -- market-hub health`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/market-hub/hub-engine.ts apps/api/src/modules/market-hub/hub-engine.spec.ts
git commit -m "feat(market-hub): engine writes tick bars, serves candles and runs the fix-up; status reports both" -- apps/api/src/modules/market-hub/hub-engine.ts apps/api/src/modules/market-hub/hub-engine.spec.ts
```

---

### Task 7: MarketHubService: flags, Prisma repository, nightly cron, chart source token

**Files:**
- Create: `apps/api/src/modules/market-hub/hub-candle-source.ts`
- Modify: `apps/api/src/modules/market-hub/market-hub.service.ts`
- Modify: `apps/api/src/modules/market-hub/market-hub.service.spec.ts`
- Modify: `apps/api/src/modules/market-hub/market-hub.module.ts`
- Modify: `apps/api/src/config/configuration.ts`
- Modify: `deploy/env/api.env.example`

**Interfaces:**
- Consumes: `HubEngine` with `candles` deps, `candlesEnabled`, `candles()`, `runFixup()` (Task 6); `PrismaCandleRepo` (Task 3); `PrismaService` (`common/prisma/prisma.service.ts`, global module); `istDay` (Task 1).
- Produces:

```typescript
// hub-candle-source.ts: safe to import from anywhere (types + a string token only)
export const HUB_CANDLE_SOURCE = 'HUB_CANDLE_SOURCE';
export interface HubCandleSource {
  servesCharts(): boolean;
  candles(ref: InstrumentRef, timeframe: Timeframe, from: Date, to: Date): Promise<CandlesResult>;
}
// MarketHubService implements HubCandleSource; constructor(config, manager, tracker, prisma)
// MarketHubService.nightlyCandleFixup(): Promise<void>   (@Cron 00:15 IST Tue–Sat)
// config: hub.candlesEnabled, hub.servesCharts
```

- [ ] **Step 1: Write the failing tests**

In `market-hub.service.spec.ts`:
- add `const prisma = { $queryRaw: jest.fn().mockResolvedValue([]), $executeRaw: jest.fn().mockResolvedValue(0) };` next to `tracker`;
- pass `prisma as any` as a **fourth** constructor argument in every existing `new MarketHubService(…)` call;
- add imports `import { HubEngine } from './hub-engine';`;
- append:

```typescript
  const enabled = (extra: Record<string, unknown> = {}) =>
    config({ 'hub.enabled': true, 'hub.ownerUserId': 'owner', 'hub.slotCap': 50, 'hub.mcxLateClose': '', ...extra });

  it('runs no candle store unless HUB_CANDLES_ENABLED, and never serves charts then', () => {
    const svc = new MarketHubService(enabled({ 'hub.candlesEnabled': false, 'hub.servesCharts': true }) as any, manager() as any, tracker as any, prisma as any);
    svc.onModuleInit();
    expect(svc.status()?.candles).toBeNull();
    expect(svc.servesCharts()).toBe(false);
    svc.onModuleDestroy();
  });

  it('serves charts only when both candle flags are on', () => {
    const on = new MarketHubService(enabled({ 'hub.candlesEnabled': true, 'hub.servesCharts': true }) as any, manager() as any, tracker as any, prisma as any);
    on.onModuleInit();
    expect(on.status()?.candles).not.toBeNull();
    expect(on.servesCharts()).toBe(true);
    on.onModuleDestroy();
    const storeOnly = new MarketHubService(enabled({ 'hub.candlesEnabled': true, 'hub.servesCharts': false }) as any, manager() as any, tracker as any, prisma as any);
    storeOnly.onModuleInit();
    expect(storeOnly.servesCharts()).toBe(false);
    storeOnly.onModuleDestroy();
  });

  it('the nightly cron fixes up the previous IST day, and does nothing when candles are off', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(Date.parse('2026-10-08T00:15:00+05:30'));
    const spy = jest.spyOn(HubEngine.prototype, 'runFixup').mockResolvedValue({ day: '2026-10-07', at: 0, instruments: 0, calls: 0, failures: 0 });
    const off = new MarketHubService(enabled() as any, manager() as any, tracker as any, prisma as any);
    off.onModuleInit();
    await off.nightlyCandleFixup();
    expect(spy).not.toHaveBeenCalled();
    off.onModuleDestroy();
    const on = new MarketHubService(enabled({ 'hub.candlesEnabled': true }) as any, manager() as any, tracker as any, prisma as any);
    on.onModuleInit();
    await on.nightlyCandleFixup();
    expect(spy).toHaveBeenCalledWith('2026-10-07');
    on.onModuleDestroy();
    spy.mockRestore();
    jest.useRealTimers();
  });

  it('candles() rejects when the hub is not running', async () => {
    const svc = new MarketHubService(config({ 'hub.enabled': false }) as any, manager() as any, tracker as any, prisma as any);
    svc.onModuleInit();
    await expect(svc.candles({ exchange: 'NSE', token: '1', symbol: 'A' }, '1m', new Date(0), new Date(1))).rejects.toThrow(/not running/);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @td/api test -- market-hub.service.spec`
Expected: FAIL. `servesCharts is not a function`; `nightlyCandleFixup is not a function`.

- [ ] **Step 3: Implement**

Create `hub-candle-source.ts`:

```typescript
import type { CandlesResult, Timeframe } from './candles/candle.types';
import type { InstrumentRef } from './hub.types';

/**
 * How the market-data controller reaches the hub's CandleStore without a
 * module import cycle (MarketHubModule imports MarketDataModule). Resolve it
 * lazily with ModuleRef.get(HUB_CANDLE_SOURCE, { strict: false }).
 * This file must stay free of runtime imports.
 */
export const HUB_CANDLE_SOURCE = 'HUB_CANDLE_SOURCE';

export interface HubCandleSource {
  /** True only when the hub runs, HUB_CANDLES_ENABLED and HUB_SERVES_CHARTS are on. */
  servesCharts(): boolean;
  candles(ref: InstrumentRef, timeframe: Timeframe, from: Date, to: Date): Promise<CandlesResult>;
}
```

In `configuration.ts`, inside `hub: { … }` after `slotCap`:

```typescript
    // M2: run the CandleStore (tick-built 1m bars, gap fill, nightly fix-up). Needs MARKET_HUB_ENABLED.
    candlesEnabled: process.env.HUB_CANDLES_ENABLED === 'true',
    // M2 consumer switch: /candles answered by the hub. Turn off to put charts back on the legacy path.
    servesCharts: process.env.HUB_SERVES_CHARTS === 'true',
```

In `deploy/env/api.env.example`, under the SP1 hub block:

```bash
# SP1 M2 CandleStore: tick-built 1m bars + gap fill + nightly fix-up (needs MARKET_HUB_ENABLED=true).
HUB_CANDLES_ENABLED=false
# M2 switch: charts read candles from the hub. Set false to revert to the legacy path for a session.
HUB_SERVES_CHARTS=false
```

In `market-hub.service.ts`:
- imports: `import { Cron } from '@nestjs/schedule';`, `import { PrismaService } from '../../common/prisma/prisma.service';`, `import { PrismaCandleRepo } from './candles/candle-repository';`, `import type { CandlesResult, Timeframe } from './candles/candle.types';`, `import { istDay } from './candles/trading-calendar';`, `import type { HubCandleSource } from './hub-candle-source';`, and add `LANE` to the `./hub.types` import;
- `export class MarketHubService implements OnModuleInit, OnModuleDestroy, HubCandleSource`;
- constructor gains a fourth parameter `private readonly prisma: PrismaService`;
- in `onModuleInit`, pass candle deps to the engine:

```typescript
    const engine = new HubEngine({
      broker: new ManagerHubBroker(this.manager, owner),
      clock: this.session,
      cap: this.config.get<number>('hub.slotCap') ?? 50,
      defaults,
      candles: this.config.get<boolean>('hub.candlesEnabled')
        ? { repo: new PrismaCandleRepo(this.prisma) }
        : undefined,
    });
```

- new methods:

```typescript
  servesCharts(): boolean {
    return !!this.engine?.candlesEnabled && this.config.get<boolean>('hub.servesCharts') === true;
  }

  candles(ref: InstrumentRef, timeframe: Timeframe, from: Date, to: Date): Promise<CandlesResult> {
    if (!this.engine) return Promise.reject(new Error(`market hub is not running: ${this.reason ?? 'not started'}`));
    return this.engine.candles(ref, timeframe, from.getTime(), to.getTime(), LANE.INTERACTIVE);
  }

  /**
   * 00:15 IST Tue–Sat: replace the previous IST day's tick-built bars with the
   * broker's official 1m/1h/1d (spec §6.4). After the latest close (MCX 23:55),
   * with every exchange shut, so the Background lane runs at full budget.
   */
  @Cron('0 15 0 * * 2-6', { name: 'hub-candle-fixup', timeZone: 'Asia/Kolkata' })
  async nightlyCandleFixup(): Promise<void> {
    if (!this.engine?.candlesEnabled) return;
    const day = istDay(Date.now() - 24 * 60 * 60 * 1000);
    try {
      const r = await this.engine.runFixup(day);
      const log = r.failures > 0 ? this.logger.warn.bind(this.logger) : this.logger.log.bind(this.logger);
      log(`Candle fix-up ${day}: ${r.instruments} instrument(s), ${r.calls} call(s), ${r.failures} failure(s)`);
    } catch (err) {
      this.logger.error(`Candle fix-up ${day} failed: ${(err as Error)?.message ?? err}`);
    }
  }
```

In `market-hub.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { MarketDataModule } from '../market-data/market-data.module';
import { TradeTrackerModule } from '../trade-tracker/trade-tracker.module';
import { HUB_CANDLE_SOURCE } from './hub-candle-source';
import { MarketHubService } from './market-hub.service';

/**
 * SP1 market data hub. M1 = shadow prices; M2 = CandleStore behind
 * HUB_CANDLES_ENABLED, serving /candles behind HUB_SERVES_CHARTS through the
 * HUB_CANDLE_SOURCE token (the market-data controller resolves it lazily:
 * this module imports MarketDataModule, so a direct injection would cycle).
 */
@Module({
  imports: [MarketDataModule, TradeTrackerModule],
  providers: [MarketHubService, { provide: HUB_CANDLE_SOURCE, useExisting: MarketHubService }],
  exports: [MarketHubService, HUB_CANDLE_SOURCE],
})
export class MarketHubModule {}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @td/api test -- market-hub.service.spec`
Expected: PASS (old and new tests).
Run: `pnpm --filter @td/api test -- market-hub health config`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/market-hub/hub-candle-source.ts apps/api/src/modules/market-hub/market-hub.service.ts apps/api/src/modules/market-hub/market-hub.service.spec.ts apps/api/src/modules/market-hub/market-hub.module.ts apps/api/src/config/configuration.ts deploy/env/api.env.example
git commit -m "feat(market-hub): CandleStore behind HUB_CANDLES_ENABLED, nightly fix-up cron, chart source token" -- apps/api/src/modules/market-hub/hub-candle-source.ts apps/api/src/modules/market-hub/market-hub.service.ts apps/api/src/modules/market-hub/market-hub.service.spec.ts apps/api/src/modules/market-hub/market-hub.module.ts apps/api/src/config/configuration.ts deploy/env/api.env.example
```

---

### Task 8: `/candles` served by the hub (the M2 switch)

**Files:**
- Create: `apps/api/src/modules/market-hub/candles/serve-chart.ts`
- Test: `apps/api/src/modules/market-hub/candles/serve-chart.spec.ts`
- Modify: `apps/api/src/modules/market-data/controllers/market-data.controller.ts` (`getCandles`, constructor)

**Interfaces:**
- Consumes: `HubCandleSource`, `HUB_CANDLE_SOURCE` (Task 7); `isHubExchange` (Task 1); `isTimeframe`, `CandlesResult` (Task 1).
- Produces:

```typescript
export interface ChartRequest { token: string; exchange: string; symbol: string; timeframe: string; from: Date; to: Date }
export interface ChartResponse {
  token: string; symbol: string; timeframe: string;
  candles: Array<{ timestamp: Date; open: number; high: number; low: number; close: number; volume: number }>;
  count: number; source: 'hub';
  incomplete: Array<{ from: string; to: string; reason: string }>;
}
export function serveChartFromHub(hub: HubCandleSource | null, req: ChartRequest, warn: (msg: string) => void): Promise<ChartResponse | null>;
```

The response keeps the legacy shape (`timestamp` serialises to an ISO-8601 UTC string; the web client converts it to unix seconds), plus `incomplete`.

- [ ] **Step 1: Write the failing test**

```typescript
import type { HubCandleSource } from '../hub-candle-source';
import { serveChartFromHub, type ChartRequest } from './serve-chart';

const REQ: ChartRequest = {
  token: '2885', exchange: 'NSE', symbol: 'RELIANCE', timeframe: '15m',
  from: new Date('2026-10-06T18:30:00.000Z'), to: new Date('2026-10-07T18:30:00.000Z'),
};
function hub(over: Partial<HubCandleSource> = {}): HubCandleSource {
  return {
    servesCharts: () => true,
    candles: jest.fn().mockResolvedValue({
      candles: [{ ts: Date.parse('2026-10-07T03:45:00.000Z'), open: 1, high: 2, low: 0.5, close: 1.5, volume: 42 }],
      incomplete: [{ from: Date.parse('2026-10-06T18:30:00.000Z'), to: Date.parse('2026-10-07T18:30:00.000Z'), reason: 'deferred' }],
    }),
    ...over,
  };
}

describe('serveChartFromHub', () => {
  const warn = jest.fn();
  beforeEach(() => warn.mockReset());

  it('maps the hub result to the legacy /candles response, with incomplete ranges', async () => {
    const h = hub();
    const out = await serveChartFromHub(h, REQ, warn);
    expect(h.candles).toHaveBeenCalledWith({ exchange: 'NSE', token: '2885', symbol: 'RELIANCE' }, '15m', REQ.from, REQ.to);
    expect(out).toEqual({
      token: '2885', symbol: 'RELIANCE', timeframe: '15m',
      candles: [{ timestamp: new Date('2026-10-07T03:45:00.000Z'), open: 1, high: 2, low: 0.5, close: 1.5, volume: 42 }],
      count: 1, source: 'hub',
      incomplete: [{ from: '2026-10-06T18:30:00.000Z', to: '2026-10-07T18:30:00.000Z', reason: 'deferred' }],
    });
  });

  it('accepts a lower-case exchange', async () => {
    const h = hub();
    await serveChartFromHub(h, { ...REQ, exchange: 'nfo' }, warn);
    expect(h.candles).toHaveBeenCalledWith(expect.objectContaining({ exchange: 'NFO' }), '15m', REQ.from, REQ.to);
  });

  it('returns null (legacy path) when there is no hub, the switch is off, or the request is not hub-shaped', async () => {
    expect(await serveChartFromHub(null, REQ, warn)).toBeNull();
    expect(await serveChartFromHub(hub({ servesCharts: () => false }), REQ, warn)).toBeNull();
    expect(await serveChartFromHub(hub(), { ...REQ, exchange: 'CDS' }, warn)).toBeNull();
    expect(await serveChartFromHub(hub(), { ...REQ, timeframe: '4h' }, warn)).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('falls back to the legacy path, with a warning, when the hub throws', async () => {
    const out = await serveChartFromHub(hub({ candles: jest.fn().mockRejectedValue(new Error('db down')) }), REQ, warn);
    expect(out).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/db down/));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @td/api test -- serve-chart.spec`
Expected: FAIL with `Cannot find module './serve-chart'`.

- [ ] **Step 3: Implement**

Create `candles/serve-chart.ts`:

```typescript
import type { HubCandleSource } from '../hub-candle-source';
import { isHubExchange } from '../hub.types';
import { isTimeframe, type CandlesResult } from './candle.types';

export interface ChartRequest {
  token: string;
  exchange: string;
  symbol: string;
  timeframe: string;
  from: Date;
  to: Date;
}

export interface ChartResponse {
  token: string;
  symbol: string;
  timeframe: string;
  candles: Array<{ timestamp: Date; open: number; high: number; low: number; close: number; volume: number }>;
  count: number;
  source: 'hub';
  incomplete: Array<{ from: string; to: string; reason: string }>;
}

function toChartResponse(req: ChartRequest, r: CandlesResult): ChartResponse {
  return {
    token: req.token,
    symbol: req.symbol,
    timeframe: req.timeframe,
    candles: r.candles.map((c) => ({
      timestamp: new Date(c.ts), open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
    })),
    count: r.candles.length,
    source: 'hub',
    incomplete: r.incomplete.map((i) => ({
      from: new Date(i.from).toISOString(), to: new Date(i.to).toISOString(), reason: i.reason,
    })),
  };
}

/**
 * SP1 M2 switch for GET /api/market-data/instruments/:token/candles. Returns
 * the hub's answer, or null to mean "use the legacy path": no hub in this
 * container, HUB_SERVES_CHARTS off, an exchange/timeframe the hub does not
 * serve, or any hub failure (revert-safe by construction).
 */
export async function serveChartFromHub(
  hub: HubCandleSource | null,
  req: ChartRequest,
  warn: (msg: string) => void,
): Promise<ChartResponse | null> {
  const exchange = req.exchange.toUpperCase();
  if (!hub || !hub.servesCharts() || !isHubExchange(exchange) || !isTimeframe(req.timeframe)) return null;
  try {
    const result = await hub.candles({ exchange, token: req.token, symbol: req.symbol }, req.timeframe, req.from, req.to);
    return toChartResponse(req, result);
  } catch (err) {
    warn(
      `Hub candles failed for ${exchange}:${req.token} ${req.timeframe}: ` +
        `${err instanceof Error ? err.message : String(err)}; using the legacy path`,
    );
    return null;
  }
}
```

In `market-data.controller.ts`:
- imports: `import { ModuleRef } from '@nestjs/core';`, `import { HUB_CANDLE_SOURCE, type HubCandleSource } from '../../market-hub/hub-candle-source';`, `import { serveChartFromHub } from '../../market-hub/candles/serve-chart';`
- append `private readonly moduleRef: ModuleRef,` as the **last** constructor parameter;
- in `getCandles`, directly after the line `const symbol = instrument?.symbol ?? constantEntry?.symbol ?? token;` and before the `// Coalesce concurrent identical requests…` comment, insert:

```typescript
    // SP1 M2: the market hub's CandleStore answers when HUB_SERVES_CHARTS is on.
    // Database first, so the per-user promise cache below is not needed on this path.
    const fromHub = await serveChartFromHub(
      this.hubCandleSource(),
      { token, exchange, symbol, timeframe: query.timeframe, from, to },
      (msg) => this.logger.warn(msg),
    );
    if (fromHub) return fromHub;
```

- add the private helper to the controller class:

```typescript
  /** The hub's candle source, if this container has the market hub (resolved lazily: no module cycle). */
  private hubCandleSource(): HubCandleSource | null {
    try {
      return this.moduleRef.get<HubCandleSource>(HUB_CANDLE_SOURCE, { strict: false });
    } catch {
      return null;
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass, including the architecture ratchet**

Run: `pnpm --filter @td/api test -- serve-chart.spec only-door.spec market-data`
Expected: PASS. `only-door.spec` is unchanged: `market-data.controller.ts` is already listed and `serve-chart.ts` lives in `market-hub/`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/market-hub/candles/serve-chart.ts apps/api/src/modules/market-hub/candles/serve-chart.spec.ts apps/api/src/modules/market-data/controllers/market-data.controller.ts
git commit -m "feat(market-data): /candles answered by the hub's CandleStore behind HUB_SERVES_CHARTS" -- apps/api/src/modules/market-hub/candles/serve-chart.ts apps/api/src/modules/market-hub/candles/serve-chart.spec.ts apps/api/src/modules/market-data/controllers/market-data.controller.ts
```

---

### Task 9: Verification and production gate

**Files:**
- Modify: `docs/superpowers/plans/2026-10-08-sp1-m2-candle-store.md` (record results in the ledger section at the end)

- [ ] **Step 1: Whole API suite**

Run: `pnpm --filter @td/api test 2>&1 | tail -15`
Expected: every suite passes; record the totals below (M1 baseline: 234 suites / 2846 tests).

- [ ] **Step 2: Integration suite (real TimescaleDB), re-run from a fresh database**

Repeat Task 3 Step 7 (drop/create `grw_m2_test`, `migrate deploy`, run the suite).
Expected: PASS (8 tests).

- [ ] **Step 3: Typecheck the files this plan touched**

Run: `pnpm --filter @td/api exec tsc --noEmit -p tsconfig.json 2>&1 | grep -E "market-hub|user-feed|angel-throttle|market-data.controller|configuration" || echo "no errors in M2 files"`
Expected: `no errors in M2 files`, or only the pre-existing `@td/shared/constants` TS2307 line in `market-hub.service.ts` (environmental; recorded in the M1 ledger).

- [ ] **Step 4: Record and commit**

Fill in the ledger table below (date, totals, integration result), then:

```bash
git commit -m "docs(plans): SP1 M2 verification results" -- docs/superpowers/plans/2026-10-08-sp1-m2-candle-store.md
```

---

## M2 production gate (after deploy, owner-run)

Works on Neon (plain tables) or the VPS (hypertable). Apply the migration first
(`prisma migrate deploy`, out-of-band on Render; automatic in `deploy.sh` on the VPS). Then set
`MARKET_HUB_ENABLED=true`, `HUB_OWNER_USER_ID=<your users.id>`, `HUB_CANDLES_ENABLED=true`,
`HUB_SERVES_CHARTS=true` and, during one NSE session, use the charts normally and read
`/healthz/detail` → `hub.candles`:

- `dbReadP95Ms` < 300 (the spec's chart cold-load target is the database read)
- `tickBarsWritten` rising during the session; `tickWriteFailures: 0`; `tickBarsDropped: 0`
- `fillErrors` ≈ 0 and `governor.endpoints.candles.throttlesLastHour` ≈ 0
- the next morning: `lastFixup` shows the previous day with `failures: 0`
- charts show no holes after a reload; a chart opened for a new symbol fills within two reloads

Revert path: `HUB_SERVES_CHARTS=false` puts charts back on the legacy path without a deploy.
M2 is complete when this is observed in production, not when the tests pass (parent spec rule).

## Notes for later milestones (not in this plan)

- The chart's live edge still polls `/candles` every 20 s; switching it to `ticks$` is M4.
- Viewed charts are not yet `watch`ed at priority 4, so they get no tick-built bars; M4 adds the watch.
- The legacy `candles` table, `CandleAggregatorService` and the three backfillers are deleted in M6,
  after their readers (backtest, scanners, level books) move to the hub.
- If the 2 GB host is ever short of disk, compression/retention exist only on TimescaleDB; on plain
  Postgres `candles_1m` grows until the VPS move.

## Verification ledger

| Date | Whole suite | Integration suite | Notes |
|---|---|---|---|
| | | | |
