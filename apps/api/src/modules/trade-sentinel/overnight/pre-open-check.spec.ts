import type { RosterEntry } from '../services/roster.service';
import type { PreOpenBook } from '../../market-cues/market-cues.types';
import {
  PRE_OPEN_CHECK,
  PRE_OPEN_CHECK_CRON,
  reviewWindowIsClosed,
  selectForWindow,
  windowTag,
} from './overnight-calendar';
import { derivativeUnderlying, preOpenMatchFor, selectForPreOpenCheck } from './pre-open-check';

const ist = (ymd: string, hhmm: string) => new Date(`${ymd}T${hhmm}:00+05:30`);
const TUE = '2026-10-13';

const entry = (id: string, over: Partial<RosterEntry> = {}): RosterEntry => ({
  userId: 'u1',
  trackerId: id,
  symbol: 'NIFTY13OCT2625000CE',
  exchange: 'NFO',
  kind: 'POSITION',
  ownership: 'SENTINEL',
  watched: true,
  reason: 'x',
  ...over,
});

const book = (entries: PreOpenBook['entries']): PreOpenBook => ({ date: TUE, entries });
const cash = (symbol: string, iep: number, previousClose: number) => ({
  symbol,
  instrument: 'CASH' as const,
  iep,
  previousClose,
  change: iep - previousClose,
  changePercent: null,
  at: ist(TUE, '09:08').toISOString(),
});

const BOOK: RosterEntry[] = [
  entry('nifty-opt'),
  entry('nifty-fut', { symbol: 'NIFTY27OCT26FUT' }),
  entry('rel-fut', { symbol: 'RELIANCE27OCT26FUT' }),
  entry('rel-opt', { symbol: 'RELIANCE27OCT261400CE' }),
  entry('sbin-opt', { symbol: 'SBIN27OCT26800PE' }),
  entry('mcx-fut', { exchange: 'MCX', symbol: 'GOLD05DEC26FUT' }),
  entry('mcx-opt', { exchange: 'MCX', symbol: 'CRUDEOIL16OCT265600CE' }),
  entry('cash', { exchange: 'NSE', symbol: 'RELIANCE-EQ' }),
];

describe('the 09:12 pre-open check window', () => {
  it('cron: 09:12, with repeats at 09:13 and 09:14, weekdays', () => {
    expect(PRE_OPEN_CHECK_CRON).toBe('0 12,13,14 9 * * 1-5');
  });

  it('applies from 09:08 (after the pre-open match) until the 09:15 open, NSE venues only', () => {
    expect(reviewWindowIsClosed(PRE_OPEN_CHECK, 'NFO', ist(TUE, '09:12'))).toBe(true);
    expect(reviewWindowIsClosed(PRE_OPEN_CHECK, 'NFO', ist(TUE, '09:05'))).toBe(false);
    expect(reviewWindowIsClosed(PRE_OPEN_CHECK, 'NFO', ist(TUE, '09:15'))).toBe(false);
    expect(reviewWindowIsClosed(PRE_OPEN_CHECK, 'MCX', ist(TUE, '09:12'))).toBe(false);
  });

  it('skips holidays and weekends', () => {
    expect(reviewWindowIsClosed(PRE_OPEN_CHECK, 'NFO', ist('2026-10-20', '09:12'))).toBe(false);
    expect(reviewWindowIsClosed(PRE_OPEN_CHECK, 'NFO', ist('2026-10-10', '09:12'))).toBe(false);
  });

  it('has its own idempotency tag per day', () => {
    expect(windowTag(PRE_OPEN_CHECK, ist(TUE, '09:12'))).toBe(`window:PRE_OPEN_CHECK:EQUITY:${TUE}`);
    expect(windowTag(PRE_OPEN_CHECK, ist(TUE, '09:14'))).toBe(`window:PRE_OPEN_CHECK:EQUITY:${TUE}`);
  });

  it('the window itself never picks MCX or cash', () => {
    const ids = selectForWindow(BOOK, PRE_OPEN_CHECK, ist(TUE, '09:12')).map((e) => e.trackerId);
    expect(ids).not.toContain('mcx-fut');
    expect(ids).not.toContain('mcx-opt');
    expect(ids).not.toContain('cash');
  });
});

describe('derivativeUnderlying', () => {
  it('reads futures and options', () => {
    expect(derivativeUnderlying('RELIANCE27OCT26FUT')).toBe('RELIANCE');
    expect(derivativeUnderlying('NIFTY13OCT2625000CE')).toBe('NIFTY');
    expect(derivativeUnderlying('M&M27OCT263000PE')).toBe('M&M');
    expect(derivativeUnderlying('RELIANCE-EQ')).toBeNull();
  });
});

describe('selectForPreOpenCheck — futures, and options whose underlying has an IEP', () => {
  const b = book({ RELIANCE: cash('RELIANCE', 1420, 1400) });

  it('every NSE future; options only when their underlying has an IEP; no MCX, no cash', () => {
    const picked = selectForPreOpenCheck(BOOK, b, ist(TUE, '09:12'));
    expect(picked.map((p) => p.entry.trackerId)).toEqual(['nifty-fut', 'rel-fut', 'rel-opt']);
  });

  it('a future without an IEP is still checked, and says why it has no gap', () => {
    const nifty = selectForPreOpenCheck(BOOK, b, ist(TUE, '09:12')).find((p) => p.entry.trackerId === 'nifty-fut');
    expect(nifty?.match).toBeNull();
  });

  it('labels an option’s figure as an underlying gap ESTIMATE, by what the IEP actually prices', () => {
    const opt = preOpenMatchFor(entry('o', { symbol: 'RELIANCE27OCT261400CE' }), b);
    expect(opt?.label).toMatch(/underlying cash pre-open IEP gap estimate/);
    const futBook = book({ RELIANCE: { ...cash('RELIANCE', 1420, 1400), instrument: 'FUTURE' } });
    expect(preOpenMatchFor(entry('o', { symbol: 'RELIANCE27OCT261400CE' }), futBook)?.label).toMatch(
      /^underlying future IEP gap estimate/,
    );
    expect(preOpenMatchFor(entry('f', { symbol: 'RELIANCE27OCT26FUT' }), futBook)?.label).toMatch(/^future IEP/);
  });

  it('with no book, only futures are picked', () => {
    expect(selectForPreOpenCheck(BOOK, null, ist(TUE, '09:12')).map((p) => p.entry.trackerId)).toEqual(['nifty-fut', 'rel-fut']);
  });

  it('nothing at 09:15 or later', () => {
    expect(selectForPreOpenCheck(BOOK, b, ist(TUE, '09:15'))).toEqual([]);
  });
});
