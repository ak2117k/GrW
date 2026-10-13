import { sessionFor, type SessionWindow } from '../trade-sentinel/market-sessions';
import type { MarketHoliday } from '../market-data/services/market-holidays.service';
import {
  MCX_DEFAULT_ON_NSE_HOLIDAY,
  MCX_EVENING_OPEN_MIN,
  MCX_HOLIDAYS,
  type McxHoliday,
  type McxHolidaySession,
} from '../market-data/services/mcx-holidays';

/**
 * The ONE answer to "is this exchange trading?" for the market hub.
 *
 * Builds on the pure, tested windows in trade-sentinel/market-sessions.ts and
 * adds what they deliberately leave out: holidays, the NSE/BSE pre-open, and
 * MCX's late close during the US-DST-linked window. MCX holidays come from
 * MCX's own calendar (mcx-holidays.ts): an NSE holiday is, by default, an MCX
 * EVENING session (17:00 → close), not a full close. A missing holiday list is
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

/** "2026-11-02:2027-03-08,2027-11-01:2028-03-13" → ranges (HUB_MCX_LATE_CLOSE). */
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

export interface SessionClockOptions {
  holidays: Readonly<Record<number, readonly MarketHoliday[]>>;
  mcxLateClose?: readonly DateRange[];
  /**
   * MCX's own holiday calendar (default: the shipped MCX_HOLIDAYS). MCX is
   * resolved separately from NSE — see mcx-holidays.ts for the rules.
   */
  mcxHolidays?: Readonly<Record<number, readonly McxHoliday[]>>;
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
    if (ex === 'MCX') return this.mcxDay(ymd, year) !== 'CLOSED';
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

  /** The trading window (IST minutes) on `at`'s IST date, or null when the exchange does not trade that day. */
  tradingWindow(exchange: string, at: Date = new Date()): SessionWindow | null {
    return this.isTradingDay(exchange, at) ? this.window(exchange, at) : null;
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

  /**
   * MCX's day on an IST date: 'CLOSED' all day, 'EVENING' (17:00 → close) or
   * 'NORMAL'. Order: the MCX list; a generic holiday that explicitly names MCX
   * (full close); an NSE holiday (MCX_DEFAULT_ON_NSE_HOLIDAY); else normal.
   */
  private mcxDay(ymd: string, year: number): McxHolidaySession | 'NORMAL' {
    const own = (this.opts.mcxHolidays ?? MCX_HOLIDAYS)[year]?.find((h) => h.date === ymd);
    if (own) return own.session;
    const generic = (this.opts.holidays[year] ?? []).filter((h) => h.date === ymd);
    if (generic.some((h) => (h.exchanges as readonly string[]).includes('MCX'))) return 'CLOSED';
    if (generic.some((h) => (h.exchanges as readonly string[]).includes('NSE'))) return MCX_DEFAULT_ON_NSE_HOLIDAY;
    return 'NORMAL';
  }

  private window(exchange: string, at: Date): SessionWindow {
    const base = sessionFor(exchange);
    if (exchange.toUpperCase() !== 'MCX') return base;
    const { ymd, year } = istParts(at);
    const late = (this.opts.mcxLateClose ?? []).some((r) => ymd >= r.from && ymd <= r.to);
    const openMin = this.mcxDay(ymd, year) === 'EVENING' ? MCX_EVENING_OPEN_MIN : base.openMin;
    return { openMin, closeMin: late ? MCX_LATE_CLOSE_MIN : base.closeMin };
  }
}
