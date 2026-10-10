import type { RosterEntry } from '../services/roster.service';
import {
  AFTER_CLOSE_EQUITY,
  AFTER_CLOSE_MCX,
  OVERNIGHT_CRON_EQUITY,
  OVERNIGHT_CRON_MCX,
  PRE_OPEN,
  PRE_OPEN_CRON,
  daysToExpiry,
  lastSessionClose,
  nextSessionOpen,
  selectForWindow,
  windowTag,
} from './overnight-calendar';

/** An IST wall-clock instant, written the way a trader says it. */
const ist = (ymd: string, hhmm: string) => new Date(`${ymd}T${hhmm}:00+05:30`);

const entry = (id: string, over: Partial<RosterEntry> = {}): RosterEntry => ({
  userId: 'u1',
  trackerId: id,
  symbol: 'NIFTY13OCT2625000CE',
  exchange: 'NFO',
  kind: 'POSITION',
  ownership: 'SENTINEL',
  watched: true,
  reason: 'unowned position — sentinel claims it',
  ...over,
});

const BOOK: RosterEntry[] = [
  entry('nfo-opt'),
  entry('bfo-opt', { exchange: 'BFO', symbol: 'SENSEX15OCT2682000PE' }),
  entry('nfo-fut', { symbol: 'BANKNIFTY27OCT26FUT' }),
  entry('mcx-opt', { exchange: 'MCX', symbol: 'CRUDEOIL16OCT265600CE' }),
  entry('mcx-fut', { exchange: 'MCX', symbol: 'GOLD05DEC26FUT' }),
  // Neither of these may ever be reviewed overnight.
  entry('holding', { kind: 'HOLDING', exchange: 'NSE', symbol: 'SUZLON-EQ', ownership: 'OBSERVE_ONLY' }),
  entry('cash', { exchange: 'NSE', symbol: 'RELIANCE-EQ' }),
];

const ids = (rows: RosterEntry[]) => rows.map((r) => r.trackerId);

describe('overnight review windows — which positions each window picks', () => {
  const monday = ist('2026-10-12', '15:45');

  it('the 15:45 window takes every NSE/NFO/BFO F&O position and no MCX one', () => {
    expect(ids(selectForWindow(BOOK, AFTER_CLOSE_EQUITY, monday))).toEqual([
      'nfo-opt',
      'bfo-opt',
      'nfo-fut',
    ]);
  });

  it('the 23:45 window takes every MCX F&O position and nothing on the equity venues', () => {
    expect(ids(selectForWindow(BOOK, AFTER_CLOSE_MCX, ist('2026-10-12', '23:45')))).toEqual([
      'mcx-opt',
      'mcx-fut',
    ]);
  });

  it('the 08:50 pre-open window takes every F&O position on every venue', () => {
    expect(ids(selectForWindow(BOOK, PRE_OPEN, ist('2026-10-12', '08:50')))).toEqual([
      'nfo-opt',
      'bfo-opt',
      'nfo-fut',
      'mcx-opt',
      'mcx-fut',
    ]);
  });

  it('never picks a holding or a cash-equity position, in any window', () => {
    for (const w of [AFTER_CLOSE_EQUITY, AFTER_CLOSE_MCX, PRE_OPEN]) {
      const picked = ids(selectForWindow(BOOK, w, ist('2026-10-12', '15:45')));
      expect(picked).not.toContain('holding');
      expect(picked).not.toContain('cash');
    }
  });
});

describe('overnight review windows — weekends and exchange holidays are skipped', () => {
  it('picks nothing on a Saturday or a Sunday', () => {
    expect(selectForWindow(BOOK, AFTER_CLOSE_EQUITY, ist('2026-10-10', '15:45'))).toEqual([]);
    expect(selectForWindow(BOOK, PRE_OPEN, ist('2026-10-11', '08:50'))).toEqual([]);
  });

  it('picks nothing on an exchange holiday (Dussehra, 2026-10-20)', () => {
    expect(selectForWindow(BOOK, AFTER_CLOSE_EQUITY, ist('2026-10-20', '15:45'))).toEqual([]);
    expect(selectForWindow(BOOK, AFTER_CLOSE_MCX, ist('2026-10-20', '23:45'))).toEqual([]);
    expect(selectForWindow(BOOK, PRE_OPEN, ist('2026-10-20', '08:50'))).toEqual([]);
  });

  it('the crons are weekday-only and land on the approved IST minutes', () => {
    // Six-field form: sec min hour dom mon dow. Repeated minutes are deliberate
    // — a fire lost to a restart is retried, and the run itself is idempotent.
    expect(OVERNIGHT_CRON_EQUITY).toBe('0 45,50,55 15 * * 1-5');
    expect(OVERNIGHT_CRON_MCX).toBe('0 45,50,55 23 * * 1-5');
    expect(PRE_OPEN_CRON).toBe('0 50,53,56 8 * * 1-5');
  });
});

describe('overnight review windows — the idempotency tag', () => {
  it('is one tag per window per IST session date, whatever minute the cron fired', () => {
    expect(windowTag(AFTER_CLOSE_EQUITY, ist('2026-10-12', '15:45'))).toBe(
      'window:OVERNIGHT_REVIEW:EQUITY:2026-10-12',
    );
    expect(windowTag(AFTER_CLOSE_EQUITY, ist('2026-10-12', '15:55'))).toBe(
      windowTag(AFTER_CLOSE_EQUITY, ist('2026-10-12', '15:45')),
    );
    expect(windowTag(AFTER_CLOSE_MCX, ist('2026-10-12', '23:45'))).toBe(
      'window:OVERNIGHT_REVIEW:MCX:2026-10-12',
    );
    expect(windowTag(PRE_OPEN, ist('2026-10-13', '08:50'))).toBe('window:PRE_OPEN_REVIEW:ALL:2026-10-13');
  });

  it('differs between days and between windows', () => {
    const a = windowTag(AFTER_CLOSE_EQUITY, ist('2026-10-12', '15:45'));
    expect(windowTag(AFTER_CLOSE_EQUITY, ist('2026-10-13', '15:45'))).not.toBe(a);
    expect(windowTag(AFTER_CLOSE_MCX, ist('2026-10-12', '15:45'))).not.toBe(a);
  });
});

describe('session arithmetic for the overnight packet', () => {
  it('the last close before a 15:45 review is the same afternoon', () => {
    expect(lastSessionClose('NFO', ist('2026-10-12', '15:45'))?.toISOString()).toBe(
      ist('2026-10-12', '15:30').toISOString(),
    );
  });

  it('the last close before a Monday pre-open is Friday’s, on each venue’s own clock', () => {
    expect(lastSessionClose('NFO', ist('2026-10-12', '08:50'))?.toISOString()).toBe(
      ist('2026-10-09', '15:30').toISOString(),
    );
    expect(lastSessionClose('MCX', ist('2026-10-12', '08:50'))?.toISOString()).toBe(
      ist('2026-10-09', '23:30').toISOString(),
    );
  });

  it('the last close skips a holiday', () => {
    // Wednesday after Dussehra (Tue 2026-10-20): the last close is Monday's.
    expect(lastSessionClose('NFO', ist('2026-10-21', '08:50'))?.toISOString()).toBe(
      ist('2026-10-19', '15:30').toISOString(),
    );
  });

  it('the next open after a Friday close is Monday’s, and skips a holiday', () => {
    expect(nextSessionOpen('NFO', ist('2026-10-09', '15:45'))?.toISOString()).toBe(
      ist('2026-10-12', '09:15').toISOString(),
    );
    expect(nextSessionOpen('MCX', ist('2026-10-19', '23:45'))?.toISOString()).toBe(
      ist('2026-10-21', '09:00').toISOString(),
    );
  });

  it('days to expiry counts calendar days and the trading sessions still ahead', () => {
    // Monday after the close, expiry Tuesday: one calendar day, one session (Tue).
    expect(daysToExpiry('2026-10-13', 'NFO', ist('2026-10-12', '15:45'))).toEqual({
      calendarDays: 1,
      tradingSessionsLeft: 1,
    });
    // Monday pre-open, same expiry: today's session is still ahead, so two.
    expect(daysToExpiry('2026-10-13', 'NFO', ist('2026-10-12', '08:50'))).toEqual({
      calendarDays: 1,
      tradingSessionsLeft: 2,
    });
    // Across Dussehra: Mon close -> expiry Thu 22nd = Wed + Thu only.
    expect(daysToExpiry('2026-10-22', 'NFO', ist('2026-10-19', '15:45'))).toEqual({
      calendarDays: 3,
      tradingSessionsLeft: 2,
    });
  });

  it('days to expiry is null for a missing or unreadable expiry, never zero', () => {
    expect(daysToExpiry(null, 'NFO', ist('2026-10-12', '15:45'))).toBeNull();
    expect(daysToExpiry('soon', 'NFO', ist('2026-10-12', '15:45'))).toBeNull();
  });
});
