import { Injectable, Logger } from '@nestjs/common';

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
 * MCX follows NSE holidays with rare exceptions.
 * Update this list annually.
 */
const HOLIDAYS_2026: MarketHoliday[] = [
  // January
  { date: '2026-01-26', name: 'Republic Day', exchanges: ['NSE', 'BSE', 'MCX', 'NFO'] },

  // February
  { date: '2026-02-17', name: 'Mahashivratri', exchanges: ['NSE', 'BSE', 'MCX', 'NFO'] },

  // March
  { date: '2026-03-10', name: 'Holi', exchanges: ['NSE', 'BSE', 'MCX', 'NFO'] },
  { date: '2026-03-17', name: 'Id-ul-Fitr (Eid)', exchanges: ['NSE', 'BSE', 'MCX', 'NFO'] },
  { date: '2026-03-30', name: 'Ram Navami', exchanges: ['NSE', 'BSE', 'MCX', 'NFO'] },

  // April
  { date: '2026-04-03', name: 'Good Friday', exchanges: ['NSE', 'BSE', 'MCX', 'NFO'] },
  { date: '2026-04-14', name: 'Dr. Ambedkar Jayanti', exchanges: ['NSE', 'BSE', 'MCX', 'NFO'] },

  // May
  { date: '2026-05-01', name: 'Maharashtra Day / May Day', exchanges: ['NSE', 'BSE', 'MCX', 'NFO'] },
  { date: '2026-05-25', name: 'Buddha Purnima', exchanges: ['NSE', 'BSE', 'MCX', 'NFO'] },

  // June
  { date: '2026-06-24', name: 'Eid-ul-Adha (Bakrid)', exchanges: ['NSE', 'BSE', 'MCX', 'NFO'] },

  // July
  { date: '2026-07-10', name: 'Muharram', exchanges: ['NSE', 'BSE', 'MCX', 'NFO'] },

  // August
  { date: '2026-08-15', name: 'Independence Day', exchanges: ['NSE', 'BSE', 'MCX', 'NFO'] },
  { date: '2026-08-18', name: 'Janmashtami', exchanges: ['NSE', 'BSE', 'MCX', 'NFO'] },

  // September
  { date: '2026-09-08', name: 'Milad-un-Nabi', exchanges: ['NSE', 'BSE', 'MCX', 'NFO'] },

  // October
  { date: '2026-10-02', name: 'Mahatma Gandhi Jayanti', exchanges: ['NSE', 'BSE', 'MCX', 'NFO'] },
  { date: '2026-10-20', name: 'Dussehra', exchanges: ['NSE', 'BSE', 'MCX', 'NFO'] },

  // November
  { date: '2026-11-09', name: 'Diwali (Laxmi Puja)', exchanges: ['NSE', 'BSE', 'MCX', 'NFO'] },
  { date: '2026-11-10', name: 'Diwali (Balipratipada)', exchanges: ['NSE', 'BSE', 'MCX', 'NFO'] },
  { date: '2026-11-27', name: 'Guru Nanak Jayanti', exchanges: ['NSE', 'BSE', 'MCX', 'NFO'] },

  // December
  { date: '2026-12-25', name: 'Christmas', exchanges: ['NSE', 'BSE', 'MCX', 'NFO'] },
];

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
