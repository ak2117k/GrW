import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MarketDataRepository } from '../../market-data/repositories/market-data.repository';
import { UserFeedManager } from '../../market-data/services/user-feed-manager.service';
import { YahooFinanceService } from '../../market-data/services/yahoo-finance.service';
import { AngelThrottleError, HISTORICAL_THROTTLE_RETRY_DELAYS_MS } from '../../market-data/services/angel-throttle';
import { TIMEFRAME_MAP } from '../../market-data/services/user-historical.util';
import { MARKET_HOLIDAYS } from '../../market-data/services/market-holidays.service';
import { SessionClock } from '../../market-hub/session-clock';
import { inBlackout } from '../../mbm/domain/oi-history';
import {
  MARKET_HOURS_CALL_GAP_MS,
  SESSION_CLOSE_MIN,
  SESSION_OPEN_MIN,
  callBudget,
  coverageOf,
  fetchIntervalFor,
  istMidnight,
  istMinutes,
  planWindows,
  readFetchCaps,
  type Bar,
  type FetchCaps,
  type Range,
  type StoreInterval,
} from '../data/backtest-data.domain';
import { INDEX_SYMBOLS, TOKEN_MAP, resolveInstrument } from '../data/instrument-resolve';
import { BacktestDataRepository } from '../repositories/backtest-data.repository';
import { BacktestDataService } from './backtest-data.service';

export const ACQUIRE_CLOCK = Symbol('ACQUIRE_CLOCK');
export const ACQUIRE_SLEEP = Symbol('ACQUIRE_SLEEP');

export interface AcquireRequest {
  symbol: string;
  exchange?: string;
  timeframe: string;
  from: Date;
  to: Date;
}

export type AcquireStatus = 'noop' | 'complete' | 'partial' | 'refused' | 'error';

export interface AcquireProgress {
  phase: 'planning' | 'fetching' | 'done';
  calls: number;
  budget: number;
  windowsDone: number;
  windowsTotal: number;
  rows: number;
}

export interface AcquireResult {
  status: AcquireStatus;
  provider?: 'angel' | 'yahoo';
  interval?: StoreInterval;
  calls: number;
  rows: number;
  message: string;
  coveredFrom?: Date | null;
  coveredTo?: Date | null;
  jobId?: string;
}

/** Daily bars from any provider are stamped with the IST session date at 09:15 IST. */
export function dailyStamp(d: Date): Date {
  return new Date(istMidnight(d) + SESSION_OPEN_MIN * 60_000);
}

/** Keep a window's bars: inside the window and, for intraday, inside the regular session. */
export function keepBars(bars: Bar[], w: Range, interval: StoreInterval): Bar[] {
  if (interval === '1d') return bars.map((b) => ({ ...b, timestamp: dailyStamp(b.timestamp) }));
  return bars.filter((b) => {
    const t = b.timestamp.getTime();
    const m = istMinutes(b.timestamp);
    return t >= w.from.getTime() && t <= w.to.getTime() && m >= SESSION_OPEN_MIN && m < SESSION_CLOSE_MIN;
  });
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Fills the backtest store for (symbol, timeframe, from, to) when the catalogue does not cover it.
 *
 * - Angel historical over the OWNER's existing session only (UserFeedManager → the session's 350 ms
 *   historical gate; never a second login). One call per NSE session for sub-hour intervals, wider
 *   windows for 1h / 1d (planWindows).
 * - Yahoo daily as the fallback for 1d equities / indices (and first choice when the held daily
 *   series came from Yahoo, so adjusted and unadjusted prices are never mixed in one series).
 * - Caps: BACKTEST_FETCH_MAX_CALLS per request (400), BACKTEST_FETCH_DAILY_CALLS per IST day (1500).
 * - Market hours (NSE trading day 08:30–15:45 IST, the OI backfill's blackout): ALLOWED but small and
 *   slow — at most BACKTEST_FETCH_MARKET_HOURS_CALLS (30) calls, 1.5 s apart — so live jobs keep the gate.
 * - Fetches extend the held span outward and stop cleanly on the budget: a later run continues.
 * - One acquisition at a time.
 */
@Injectable()
export class DataAcquisitionService {
  private readonly logger = new Logger(DataAcquisitionService.name);
  private readonly calendar: SessionClock;
  private readonly caps: FetchCaps;
  private busy = false;

  constructor(
    config: ConfigService,
    private readonly repo: BacktestDataRepository,
    private readonly data: BacktestDataService,
    private readonly instruments: MarketDataRepository,
    private readonly feeds: UserFeedManager,
    private readonly yahoo: YahooFinanceService,
    @Optional() @Inject(ACQUIRE_CLOCK) private readonly now: () => Date = () => new Date(),
    @Optional() @Inject(ACQUIRE_SLEEP) private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
  ) {
    this.calendar = new SessionClock({ holidays: MARKET_HOLIDAYS });
    this.caps = readFetchCaps({
      BACKTEST_FETCH_MAX_CALLS: config.get<string>('BACKTEST_FETCH_MAX_CALLS'),
      BACKTEST_FETCH_DAILY_CALLS: config.get<string>('BACKTEST_FETCH_DAILY_CALLS'),
      BACKTEST_FETCH_MARKET_HOURS_CALLS: config.get<string>('BACKTEST_FETCH_MARKET_HOURS_CALLS'),
    });
  }

  get limits(): FetchCaps {
    return { ...this.caps };
  }

  isBusy(): boolean {
    return this.busy;
  }

  async acquire(
    userId: string,
    req: AcquireRequest,
    onProgress?: (p: AcquireProgress) => void | Promise<void>,
  ): Promise<AcquireResult> {
    const symbol = req.symbol.trim().toUpperCase();
    const exchange = (req.exchange || 'NSE').trim().toUpperCase();
    const interval = fetchIntervalFor(req.timeframe);
    if (!interval) {
      return { status: 'refused', calls: 0, rows: 0, message: `timeframe ${req.timeframe} cannot be fetched (1m…1h, 1d)` };
    }
    if (req.to.getTime() <= req.from.getTime()) {
      return { status: 'refused', calls: 0, rows: 0, message: 'empty date range' };
    }
    const held = await this.data.coverage(symbol, exchange, req.timeframe, req.from, req.to);
    if (held.complete) {
      return {
        status: 'noop',
        interval,
        calls: 0,
        rows: 0,
        message: `already held (${held.dataset.interval}, ${held.dataset.source})`,
        coveredFrom: held.dataset.fromTs,
        coveredTo: held.dataset.toTs,
      };
    }
    if (this.busy) {
      return { status: 'refused', calls: 0, rows: 0, message: 'another data fetch is running — try again shortly' };
    }
    this.busy = true;
    try {
      return await this.run(userId, symbol, exchange, interval, req, onProgress);
    } finally {
      this.busy = false;
    }
  }

  private async run(
    userId: string,
    symbol: string,
    exchange: string,
    interval: StoreInterval,
    req: AcquireRequest,
    onProgress?: (p: AcquireProgress) => void | Promise<void>,
  ): Promise<AcquireResult> {
    const existing = await this.repo.findDataset(symbol, exchange, interval);
    const yahooFirst = interval === '1d' && !!existing && existing.source.includes('yahoo') && !existing.source.includes('angel');
    const job = await this.repo.createFetchJob({ userId, symbol, exchange, interval, fromTs: req.from, toTs: req.to });
    let result: AcquireResult;
    try {
      if (yahooFirst) {
        result = await this.viaYahoo(symbol, exchange, req);
      } else {
        result = await this.viaAngel(userId, symbol, exchange, interval, req, onProgress);
        const yahooOk = interval === '1d' && (exchange === 'NSE' || exchange === 'BSE');
        if (yahooOk && result.rows === 0 && (result.status === 'error' || result.status === 'refused' || result.status === 'partial')) {
          const y = await this.viaYahoo(symbol, exchange, req);
          if (y.rows > 0 || result.status !== 'partial') result = { ...y, calls: result.calls, message: `${result.message}; ${y.message}` };
        }
      }
    } catch (err) {
      result = { status: 'error', calls: 0, rows: 0, message: errText(err) };
    }
    const ds = await this.repo.findDataset(symbol, exchange, interval);
    if (ds) {
      const fresh = await this.repo.refreshStats(ds.id);
      result.coveredFrom = fresh.fromTs;
      result.coveredTo = fresh.toTs;
      if (result.status === 'partial' && coverageOf(fresh, req.from, req.to).complete) result.status = 'complete';
    }
    result.interval = interval;
    result.jobId = job.id;
    await this.repo.updateFetchJob(job.id, {
      status: result.status,
      provider: result.provider ?? undefined,
      calls: result.calls,
      rows: result.rows,
      message: result.message.slice(0, 1000),
      finishedAt: this.now(),
    });
    await onProgress?.({ phase: 'done', calls: result.calls, budget: result.calls, windowsDone: 0, windowsTotal: 0, rows: result.rows });
    this.logger.log(`[backtest-fetch] ${symbol} ${interval} ${result.status} provider=${result.provider ?? '-'} calls=${result.calls} rows=${result.rows}: ${result.message}`);
    return result;
  }

  private async viaAngel(
    userId: string,
    symbol: string,
    exchange: string,
    interval: StoreInterval,
    req: AcquireRequest,
    onProgress?: (p: AcquireProgress) => void | Promise<void>,
  ): Promise<AcquireResult> {
    const now = this.now();
    const marketHours = inBlackout(this.calendar, now);
    const usedToday = await this.repo.callsSince(new Date(istMidnight(now)));
    const budget = callBudget(this.caps, usedToday, marketHours);
    if (budget <= 0) {
      return {
        status: 'refused',
        provider: 'angel',
        calls: 0,
        rows: 0,
        message: `daily Angel fetch cap reached (${usedToday}/${this.caps.maxCallsPerDay} calls today)`,
      };
    }
    const rows = await this.instruments.searchInstruments(symbol, exchange).catch(() => []);
    const inst = resolveInstrument(rows as any[], symbol, exchange);
    if (inst.via === 'symbol') {
      return { status: 'refused', provider: 'angel', calls: 0, rows: 0, message: `no instrument token for ${symbol} on ${exchange}` };
    }
    const ds = await this.repo.ensureDataset(symbol, exchange, interval, 'angel');
    const pieces = coverageOf(ds, req.from, req.to).missing;
    const windows = pieces.flatMap((p) => planWindows(p, interval, this.calendar, exchange));
    const angelInterval = TIMEFRAME_MAP[interval];
    let calls = 0;
    let inserted = 0;
    let done = 0;
    let stop: string | null = null;
    await onProgress?.({ phase: 'planning', calls, budget, windowsDone: 0, windowsTotal: windows.length, rows: 0 });
    for (const w of windows) {
      if (calls >= budget) {
        stop = marketHours
          ? `market-hours limit (${budget} calls) reached — run again after 15:45 IST to continue`
          : `per-request cap (${budget} calls) reached — run again to continue`;
        break;
      }
      let bars: Bar[] | null = null;
      for (let attempt = 0; ; attempt++) {
        if (calls >= budget) break;
        calls++;
        try {
          bars = await this.feeds.fetchCandleWindow(userId, { token: inst.token, exchange: inst.exchange }, angelInterval, w.from, w.to);
          break;
        } catch (err) {
          const throttled = err instanceof AngelThrottleError || (err as Error)?.name === 'AngelThrottleError';
          if (throttled && attempt < HISTORICAL_THROTTLE_RETRY_DELAYS_MS.length) {
            await this.sleep(HISTORICAL_THROTTLE_RETRY_DELAYS_MS[attempt]);
            continue;
          }
          stop = throttled ? 'Angel kept throttling — stopped early, run again later' : `Angel error: ${errText(err)}`;
          break;
        }
      }
      if (stop) break;
      if (bars == null) continue; // the budget ran out mid-retry; the loop head reports it
      inserted += await this.repo.insertBars(ds.id, keepBars(bars, w, interval));
      done++;
      if (done % 10 === 0 || done === windows.length) {
        await onProgress?.({ phase: 'fetching', calls, budget, windowsDone: done, windowsTotal: windows.length, rows: inserted });
      }
      if (marketHours) await this.sleep(MARKET_HOURS_CALL_GAP_MS);
    }
    if (!stop && done < windows.length) stop = `budget reached after ${done}/${windows.length} windows — run again to continue`;
    const status: AcquireStatus = stop == null ? 'complete' : done > 0 ? 'partial' : stop.startsWith('Angel error') ? 'error' : 'partial';
    return {
      status,
      provider: 'angel',
      calls,
      rows: inserted,
      message: stop ?? `fetched ${done} window${done === 1 ? '' : 's'}`,
    };
  }

  private async viaYahoo(symbol: string, exchange: string, req: AcquireRequest): Promise<AcquireResult> {
    const token = TOKEN_MAP[symbol]?.token ?? '';
    if (INDEX_SYMBOLS.has(symbol) && !token) {
      return { status: 'refused', provider: 'yahoo', calls: 0, rows: 0, message: `no Yahoo symbol for index ${symbol}` };
    }
    const candles = await this.yahoo.getCandles(symbol, exchange, token, '1d', req.from, req.to);
    if (!candles || candles.length === 0) {
      return { status: 'error', provider: 'yahoo', calls: 1, rows: 0, message: `Yahoo returned no daily bars for ${symbol}` };
    }
    const ds = await this.repo.ensureDataset(symbol, exchange, '1d', 'yahoo');
    const bars = candles.map((c) => ({ ...c, timestamp: dailyStamp(c.timestamp) }));
    const rows = await this.repo.insertBars(ds.id, bars);
    return { status: 'complete', provider: 'yahoo', calls: 1, rows, message: `Yahoo daily: ${candles.length} bars` };
  }
}
