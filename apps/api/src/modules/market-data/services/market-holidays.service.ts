import { Injectable, Logger } from '@nestjs/common';
import { MCX_HOLIDAYS } from './mcx-holidays';

/** True only when MCX's own calendar shuts it for the whole day. */
function isMcxFullHoliday(ymd: string): boolean {
  const year = Number(ymd.slice(0, 4));
  return (MCX_HOLIDAYS[year] ?? []).some((h) => h.date === ymd && h.session === 'CLOSED');
}

export interface MarketHoliday {
  date: string; // YYYY-MM-DD
  name: string;
  exchanges: ('NSE' | 'BSE' | 'MCX' | 'NFO')[]; // Which exchanges are closed
}

export interface TradingDayInfo {
  date: string;
  dayOfWeek: string;
  isWeekend: boolean;
  isHoliday: boolean;
  holidayName?: string;
  /** Which exchanges are closed on this day (empty = all open) */
  closedExchanges: string[];
  /** Importance: 'normal' | 'expiry' | 'budget' | 'rbi-policy' | 'results-season' */
  importance: string;
  importanceLabel?: string;
}

/**
 * NSE/BSE/MCX market holidays for 2026.
 * Source: NSE circular published at start of year.
 * MCX is NOT listed here: it keeps its own calendar (mcx-holidays.ts), and on
 * most NSE holidays it still runs an evening session — marking MCX closed on
 * every NSE holiday left MCX positions unwatched through live evenings.
 * Update this list annually.
 */
const HOLIDAYS_2026: MarketHoliday[] = [
  // Weekday NSE closures per the NSE 2026 circular (corrected 2026-10-22: the earlier list had 9 days NSE
  // traded and missed 7 closures). Weekend holidays (Feb 15, Mar 21, Aug 15, Nov 8 Muhurat) cost no session.
  { date: '2026-01-15', name: 'Maharashtra municipal elections', exchanges: ['NSE', 'BSE', 'NFO'] },
  { date: '2026-01-26', name: 'Republic Day', exchanges: ['NSE', 'BSE', 'NFO'] },
  { date: '2026-03-03', name: 'Holi', exchanges: ['NSE', 'BSE', 'NFO'] },
  { date: '2026-03-26', name: 'Shri Ram Navami', exchanges: ['NSE', 'BSE', 'NFO'] },
  { date: '2026-03-31', name: 'Shri Mahavir Jayanti', exchanges: ['NSE', 'BSE', 'NFO'] },
  { date: '2026-04-03', name: 'Good Friday', exchanges: ['NSE', 'BSE', 'NFO'] },
  { date: '2026-04-14', name: 'Dr. Baba Saheb Ambedkar Jayanti', exchanges: ['NSE', 'BSE', 'NFO'] },
  { date: '2026-05-01', name: 'Maharashtra Day', exchanges: ['NSE', 'BSE', 'NFO'] },
  { date: '2026-05-28', name: 'Bakri Id', exchanges: ['NSE', 'BSE', 'NFO'] },
  { date: '2026-06-26', name: 'Muharram', exchanges: ['NSE', 'BSE', 'NFO'] },
  { date: '2026-09-14', name: 'Ganesh Chaturthi', exchanges: ['NSE', 'BSE', 'NFO'] },
  { date: '2026-10-02', name: 'Mahatma Gandhi Jayanti', exchanges: ['NSE', 'BSE', 'NFO'] },
  { date: '2026-10-20', name: 'Dussehra', exchanges: ['NSE', 'BSE', 'NFO'] },
  { date: '2026-11-10', name: 'Diwali Balipratipada', exchanges: ['NSE', 'BSE', 'NFO'] },
  { date: '2026-11-24', name: 'Prakash Gurpurb Sri Guru Nanak Dev', exchanges: ['NSE', 'BSE', 'NFO'] },
  { date: '2026-12-25', name: 'Christmas', exchanges: ['NSE', 'BSE', 'NFO'] },
];

/**
 * Holiday lists by calendar year. The market hub's SessionClock reads this;
 * a year missing here is reported by `SessionClock.calendarGap` (and alerted
 * every December) instead of silently treating every day as a trading day.
 */
export const MARKET_HOLIDAYS: Readonly<Record<number, readonly MarketHoliday[]>> = {
  2026: HOLIDAYS_2026,
};

/**
 * Important trading days — expiry days, budget, RBI policy, results season, etc.
 * These recur on specific patterns.
 */
interface ImportantDay {
  date: string;
  type: string;
  label: string;
}

/**
 * Generate weekly/monthly F&O expiry dates for 2026.
 * - Weekly expiry: every Thursday (NIFTY, BANKNIFTY)
 * - Monthly expiry: last Thursday of each month
 */
function generateExpiryDates(year: number): ImportantDay[] {
  const expiries: ImportantDay[] = [];
  const startDate = new Date(year, 0, 1);
  const endDate = new Date(year, 11, 31);

  const current = new Date(startDate);
  // Move to first Thursday
  while (current.getDay() !== 4) {
    current.setDate(current.getDate() + 1);
  }

  while (current <= endDate) {
    // Check if this is the last Thursday of the month
    const nextThursday = new Date(current);
    nextThursday.setDate(nextThursday.getDate() + 7);
    const isMonthlyExpiry = nextThursday.getMonth() !== current.getMonth();

    expiries.push({
      date: formatDate(current),
      type: isMonthlyExpiry ? 'monthly-expiry' : 'weekly-expiry',
      label: isMonthlyExpiry ? 'Monthly F&O Expiry' : 'Weekly Expiry',
    });

    current.setDate(current.getDate() + 7);
  }

  return expiries;
}

function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Known important dates for 2026 (non-expiry) */
const IMPORTANT_DATES_2026: ImportantDay[] = [
  { date: '2026-02-01', type: 'budget', label: 'Union Budget 2026' },
  { date: '2026-04-05', type: 'rbi-policy', label: 'RBI Monetary Policy' },
  { date: '2026-06-05', type: 'rbi-policy', label: 'RBI Monetary Policy' },
  { date: '2026-08-07', type: 'rbi-policy', label: 'RBI Monetary Policy' },
  { date: '2026-10-02', type: 'rbi-policy', label: 'RBI Monetary Policy' },
  { date: '2026-12-04', type: 'rbi-policy', label: 'RBI Monetary Policy' },
  // Results season windows (approximate)
  { date: '2026-01-15', type: 'results-season', label: 'Q3 Results Season Begins' },
  { date: '2026-04-15', type: 'results-season', label: 'Q4 Results Season Begins' },
  { date: '2026-07-15', type: 'results-season', label: 'Q1 Results Season Begins' },
  { date: '2026-10-15', type: 'results-season', label: 'Q2 Results Season Begins' },
];

@Injectable()
export class MarketHolidaysService {
  private readonly logger = new Logger(MarketHolidaysService.name);

  /** Holiday lookup by date string (YYYY-MM-DD). */
  private readonly holidayMap = new Map<string, MarketHoliday>();

  /** Important dates lookup. */
  private readonly importantDayMap = new Map<string, ImportantDay>();

  /** Expiry dates. */
  private readonly expiryDates: ImportantDay[];

  constructor() {
    for (const h of HOLIDAYS_2026) {
      this.holidayMap.set(h.date, h);
    }

    this.expiryDates = generateExpiryDates(2026);
    for (const e of this.expiryDates) {
      this.importantDayMap.set(e.date, e);
    }
    for (const d of IMPORTANT_DATES_2026) {
      this.importantDayMap.set(d.date, d);
    }

    this.logger.log(
      `Market holidays loaded: ${this.holidayMap.size} holidays, ${this.expiryDates.length} expiry dates`,
    );
  }

  /**
   * Check if a specific date is a holiday for a given exchange.
   */
  isHoliday(date: Date, exchange: string = 'NSE'): boolean {
    const dateStr = formatDate(date);
    // MCX: closed only on a full MCX holiday (an evening session is trading).
    if (exchange.toUpperCase() === 'MCX') return isMcxFullHoliday(dateStr);
    const holiday = this.holidayMap.get(dateStr);
    if (!holiday) return false;
    return holiday.exchanges.includes(exchange as any);
  }

  /**
   * Get holiday info for a date, or null if it's not a holiday.
   */
  getHoliday(date: Date): MarketHoliday | null {
    return this.holidayMap.get(formatDate(date)) ?? null;
  }

  /**
   * Check if today is a trading day for the given exchange
   * (not a weekend and not a holiday).
   */
  isTradingDay(date: Date, exchange: string = 'NSE'): boolean {
    const day = date.getDay();
    if (day === 0 || day === 6) return false; // Weekend
    return !this.isHoliday(date, exchange);
  }

  /**
   * Get trading day info for a specific date.
   */
  getDayInfo(date: Date): TradingDayInfo {
    const dateStr = formatDate(date);
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const day = date.getDay();
    const isWeekend = day === 0 || day === 6;
    const holiday = this.holidayMap.get(dateStr);
    const importantDay = this.importantDayMap.get(dateStr);

    const closedExchanges: string[] = [];
    if (isWeekend) {
      closedExchanges.push('NSE', 'BSE', 'MCX', 'NFO');
    } else if (holiday) {
      closedExchanges.push(...holiday.exchanges);
    }
    if (!isWeekend && isMcxFullHoliday(dateStr) && !closedExchanges.includes('MCX')) {
      closedExchanges.push('MCX');
    }

    return {
      date: dateStr,
      dayOfWeek: dayNames[day],
      isWeekend,
      isHoliday: !!holiday,
      holidayName: holiday?.name,
      closedExchanges,
      importance: importantDay?.type ?? 'normal',
      importanceLabel: importantDay?.label,
    };
  }

  /**
   * Get all trading day info for a given month.
   * Used by the calendar view.
   */
  getMonthCalendar(year: number, month: number): TradingDayInfo[] {
    const days: TradingDayInfo[] = [];
    const daysInMonth = new Date(year, month, 0).getDate();

    for (let d = 1; d <= daysInMonth; d++) {
      const date = new Date(year, month - 1, d);
      days.push(this.getDayInfo(date));
    }

    return days;
  }

  /**
   * Get all holidays for a given year.
   */
  getHolidays(year: number = 2026): MarketHoliday[] {
    const prefix = `${year}-`;
    return [...this.holidayMap.values()].filter((h) => h.date.startsWith(prefix));
  }

  /**
   * Get the next upcoming holiday from today.
   */
  getNextHoliday(): MarketHoliday | null {
    const today = formatDate(new Date());
    const upcoming = [...this.holidayMap.values()]
      .filter((h) => h.date >= today)
      .sort((a, b) => a.date.localeCompare(b.date));
    return upcoming[0] ?? null;
  }
}
