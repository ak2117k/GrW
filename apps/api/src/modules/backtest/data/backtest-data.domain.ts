/**
 * Pure maths for the backtest data store: intervals, roll-ups, catalogue coverage, fetch windows
 * and call budgets. No I/O — see BacktestDataService / DataAcquisitionService for the wiring.
 *
 * Conventions (same as the MBM store and the importer, scripts/backtest-data/):
 *   - bar ts = bar START, UTC;
 *   - intraday buckets are anchored at 09:15 IST, regular session 09:15 ≤ IST < 15:30;
 *   - a daily bar is stamped with its IST session date at 09:15 IST (03:45Z).
 */

export const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;
export const SESSION_OPEN_MIN = 9 * 60 + 15;
export const SESSION_CLOSE_MIN = 15 * 60 + 30;

/** Intervals a dataset may be stored at. */
export const STORE_INTERVALS = ['1m', '5m', '15m', '1h', '1d'] as const;
export type StoreInterval = (typeof STORE_INTERVALS)[number];

/** A catalogue span is "complete" for a request when it reaches within this of each end (weekends, holidays). */
export const COVERAGE_SLACK_MS = 4 * DAY_MS;

export interface Bar {
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Range {
  from: Date;
  to: Date;
}

/** Minutes per bar for a timeframe string ('1m' … '1h', '1d'); null when unsupported (1w, 1mo, …). */
export function intervalMinutes(tf: string): number | null {
  const m = /^(\d+)(m|h|d)$/.exec((tf ?? '').trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isInteger(n) || n <= 0) return null;
  if (m[2] === 'm') return n < 375 ? n : null;
  if (m[2] === 'h') return n <= 6 ? n * 60 : null;
  return n === 1 ? 1440 : null;
}

/** True when bars stored at `base` can be rolled up into `target` bars (same interval included). */
export function canDerive(base: string, target: string): boolean {
  const b = intervalMinutes(base);
  const t = intervalMinutes(target);
  if (b == null || t == null) return false;
  if (t === 1440) return true; // a session's intraday bars make its daily bar
  if (b === 1440) return false;
  return t % b === 0;
}

/**
 * Store intervals that can serve `target`, best first: the exact interval, then the coarsest finer
 * one (fewest rows to read and roll up).
 */
export function servingIntervals(target: string): StoreInterval[] {
  const ok = STORE_INTERVALS.filter((i) => canDerive(i, target));
  const exact = ok.filter((i) => i === target);
  const rest = ok.filter((i) => i !== target).sort((a, b) => intervalMinutes(b)! - intervalMinutes(a)!);
  // Daily from intraday is a last resort (a gap-filled session reads as a full day).
  return [...exact, ...rest.filter((i) => i !== '1d')];
}

/** The interval to FETCH for a target timeframe: the coarsest store interval that divides it. */
export function fetchIntervalFor(target: string): StoreInterval | null {
  const t = intervalMinutes(target);
  if (t == null) return null;
  if (t === 1440) return '1d';
  const candidates = STORE_INTERVALS.filter((i) => i !== '1d' && t % intervalMinutes(i)! === 0);
  return candidates.length ? candidates[candidates.length - 1] : null;
}

/** IST minutes-of-day of an instant. */
export function istMinutes(at: Date): number {
  const ist = new Date(at.getTime() + IST_OFFSET_MS);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}

/** UTC instant of IST midnight for the IST day containing `at`. */
export function istMidnight(at: Date): number {
  const shifted = at.getTime() + IST_OFFSET_MS;
  return shifted - (((shifted % DAY_MS) + DAY_MS) % DAY_MS) - IST_OFFSET_MS;
}

/**
 * Roll bars (sorted ascending, regular session) up into `targetMinutes` bars. Intraday buckets are
 * anchored at 09:15 IST; 1440 makes one bar per IST session date stamped 09:15 IST. Bars outside
 * the regular session are dropped from intraday roll-ups.
 */
export function aggregateBars(bars: Bar[], targetMinutes: number): Bar[] {
  const out: Bar[] = [];
  let cur: Bar | null = null;
  let curKey = NaN;
  for (const b of bars) {
    let key: number;
    if (targetMinutes >= 1440) {
      key = istMidnight(b.timestamp) + SESSION_OPEN_MIN * 60_000;
    } else {
      const m = istMinutes(b.timestamp);
      if (m < SESSION_OPEN_MIN || m >= SESSION_CLOSE_MIN) continue;
      const offset = Math.floor((m - SESSION_OPEN_MIN) / targetMinutes) * targetMinutes;
      key = istMidnight(b.timestamp) + (SESSION_OPEN_MIN + offset) * 60_000;
    }
    if (cur && key === curKey) {
      cur.high = Math.max(cur.high, b.high);
      cur.low = Math.min(cur.low, b.low);
      cur.close = b.close;
      cur.volume += b.volume;
      continue;
    }
    if (cur) out.push(cur);
    cur = { timestamp: new Date(key), open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume };
    curKey = key;
  }
  if (cur) out.push(cur);
  return out;
}

// ── catalogue coverage ────────────────────────────────────────────────────────────────────────

export interface CatalogueSpan {
  fromTs: Date | null;
  toTs: Date | null;
}

export interface Coverage {
  /** The span reaches both ends of the request (within the slack). */
  complete: boolean;
  /** Pieces of the request NOT held, each adjacent to the held span (so filling them keeps it contiguous). */
  missing: Array<Range & { direction: 'backward' | 'forward' }>;
}

/**
 * What of [start, end] a catalogue span holds. A missing piece always touches the held span: a
 * request entirely after the span yields [span.to, end] (gap included) so a fetch that fills it
 * leaves one contiguous span. With nothing held, the whole request is one backward piece (fetched
 * newest first, so a capped fetch keeps the most recent history).
 */
export function coverageOf(span: CatalogueSpan | null, start: Date, end: Date, slackMs = COVERAGE_SLACK_MS): Coverage {
  if (end.getTime() <= start.getTime()) return { complete: true, missing: [] };
  if (!span?.fromTs || !span?.toTs) {
    return { complete: false, missing: [{ from: start, to: end, direction: 'backward' }] };
  }
  const missing: Coverage['missing'] = [];
  if (start.getTime() < span.fromTs.getTime() - slackMs) {
    missing.push({ from: start, to: span.fromTs, direction: 'backward' });
  }
  if (end.getTime() > span.toTs.getTime() + slackMs) {
    missing.push({ from: span.toTs, to: end, direction: 'forward' });
  }
  return { complete: missing.length === 0, missing };
}

// ── fetch windows ─────────────────────────────────────────────────────────────────────────────

/** The slice of SessionClock the planner needs (NSE holidays included). */
export interface TradingCalendar {
  isTradingDay(exchange: string, at?: Date): boolean;
}

/** Max calendar days per Angel getCandleData window (mirrors TIMEFRAME_MAX_RANGE_DAYS by store interval). */
export const ANGEL_WINDOW_DAYS: Record<StoreInterval, number> = {
  '1m': 1,
  '5m': 1,
  '15m': 1,
  '1h': 365,
  '1d': 1800,
};

/**
 * Angel windows for one missing piece, in fetch order. Sub-hour intervals get ONE window per NSE
 * trading session (09:15–15:30 IST): no call is spent on a weekend or holiday. Wider intervals are
 * sliced into ANGEL_WINDOW_DAYS spans. `forward` pieces run oldest→newest, `backward` newest→oldest,
 * so a fetch that stops on its budget still leaves the held span contiguous.
 */
export function planWindows(
  piece: Range & { direction: 'backward' | 'forward' },
  interval: StoreInterval,
  cal: TradingCalendar,
  exchange = 'NSE',
): Range[] {
  const from = piece.from.getTime();
  const to = piece.to.getTime();
  if (to <= from) return [];
  const windows: Range[] = [];
  if (ANGEL_WINDOW_DAYS[interval] <= 1) {
    for (let day = istMidnight(piece.from); day <= to; day += DAY_MS) {
      const open = day + SESSION_OPEN_MIN * 60_000;
      const close = day + SESSION_CLOSE_MIN * 60_000;
      if (close <= from || open >= to) continue;
      if (!cal.isTradingDay(exchange, new Date(day + 12 * 60 * 60_000))) continue;
      windows.push({ from: new Date(Math.max(open, from)), to: new Date(Math.min(close, to)) });
    }
  } else {
    const span = ANGEL_WINDOW_DAYS[interval] * DAY_MS;
    for (let cursor = from; cursor < to; ) {
      const end = Math.min(cursor + span, to);
      windows.push({ from: new Date(cursor), to: new Date(end) });
      cursor = end;
    }
  }
  return piece.direction === 'backward' ? windows.reverse() : windows;
}

// ── budgets ───────────────────────────────────────────────────────────────────────────────────

export interface FetchCaps {
  /** BACKTEST_FETCH_MAX_CALLS: Angel calls one request may spend. */
  maxCallsPerRequest: number;
  /** BACKTEST_FETCH_DAILY_CALLS: Angel calls per IST day across all requests. */
  maxCallsPerDay: number;
  /** BACKTEST_FETCH_MARKET_HOURS_CALLS: per-request ceiling inside the NSE blackout window. */
  marketHoursMaxCalls: number;
}

export const DEFAULT_FETCH_CAPS: FetchCaps = { maxCallsPerRequest: 400, maxCallsPerDay: 1500, marketHoursMaxCalls: 30 };

/** Extra pause between calls inside market hours (on top of the session's 350 ms gate). */
export const MARKET_HOURS_CALL_GAP_MS = 1_500;

/**
 * Calls this request may spend now. Market hours (NSE trading day 08:30–15:45 IST, the OI backfill's
 * blackout) do NOT refuse outright: a small fetch still runs, slowly, so the live jobs keep the gate.
 */
export function callBudget(caps: FetchCaps, usedToday: number, marketHours: boolean): number {
  const perRequest = marketHours ? Math.min(caps.maxCallsPerRequest, caps.marketHoursMaxCalls) : caps.maxCallsPerRequest;
  return Math.max(0, Math.min(perRequest, caps.maxCallsPerDay - usedToday));
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function readFetchCaps(env: Record<string, string | undefined>): FetchCaps {
  return {
    maxCallsPerRequest: positiveInt(env.BACKTEST_FETCH_MAX_CALLS, DEFAULT_FETCH_CAPS.maxCallsPerRequest),
    maxCallsPerDay: positiveInt(env.BACKTEST_FETCH_DAILY_CALLS, DEFAULT_FETCH_CAPS.maxCallsPerDay),
    marketHoursMaxCalls: positiveInt(env.BACKTEST_FETCH_MARKET_HOURS_CALLS, DEFAULT_FETCH_CAPS.marketHoursMaxCalls),
  };
}
