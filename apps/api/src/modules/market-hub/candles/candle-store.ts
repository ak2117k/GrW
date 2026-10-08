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
