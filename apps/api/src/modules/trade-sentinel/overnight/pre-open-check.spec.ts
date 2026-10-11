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

describe('the 09:10 pre-open check window', () => {
  it('cron: 09:10, with a repeat at 09:11, weekdays', () => {
    expect(PRE_OPEN_CHECK_CRON).toBe('0 10,11 9 * * 1-5');
  });

  it('applies from 09:08 (after the pre-open match) until the 09:15 open, NSE venues only', () => {
    expect(reviewWindowIsClosed(PRE_OPEN_CHECK, 'NFO', ist(TUE, '09:10'))).toBe(true);
    expect(reviewWindowIsClosed(PRE_OPEN_CHECK, 'NFO', ist(TUE, '09:05'))).toBe(false);
    expect(reviewWindowIsClosed(PRE_OPEN_CHECK, 'NFO', ist(TUE, '09:15'))).toBe(false);
    expect(reviewWindowIsClosed(PRE_OPEN_CHECK, 'MCX', ist(TUE, '09:10'))).toBe(false);
  });

  it('skips holidays and weekends', () => {
    expect(reviewWindowIsClosed(PRE_OPEN_CHECK, 'NFO', ist('2026-10-20', '09:10'))).toBe(false);
    expect(reviewWindowIsClosed(PRE_OPEN_CHECK, 'NFO', ist('2026-10-10', '09:10'))).toBe(false);
  });

  it('has its own idempotency tag per day', () => {
    expect(windowTag(PRE_OPEN_CHECK, ist(TUE, '09:10'))).toBe(`window:PRE_OPEN_CHECK:EQUITY:${TUE}`);
    expect(windowTag(PRE_OPEN_CHECK, ist(TUE, '09:14'))).toBe(`window:PRE_OPEN_CHECK:EQUITY:${TUE}`);
  });

  it('the window itself never picks MCX or cash', () => {
    const ids = selectForWindow(BOOK, PRE_OPEN_CHECK, ist(TUE, '09:10')).map((e) => e.trackerId);
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

  it('checks only positions whose underlying has an IEP; no MCX, no cash', () => {
    const { checked } = selectForPreOpenCheck(BOOK, b, ist(TUE, '09:10'));
    expect(checked.map((p) => p.entry.trackerId)).toEqual(['rel-fut', 'rel-opt']);
  });

  it('skips — with the reason — every NSE F&O position whose IEP is unseen, index futures included', () => {
    const { skipped } = selectForPreOpenCheck(BOOK, b, ist(TUE, '09:10'));
    expect(skipped.map((s) => s.entry.trackerId)).toEqual(['nifty-opt', 'nifty-fut', 'sbin-opt']);
    expect(skipped.find((s) => s.entry.trackerId === 'nifty-fut')?.reason).toMatch(/no pre-open IEP for NIFTY/);
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

  it('with no book, nothing is checked and every NSE F&O position is skipped with the book’s reason', () => {
    const r = selectForPreOpenCheck(BOOK, null, ist(TUE, '09:10'), undefined, 'the NSE pre-open book is stale');
    expect(r.checked).toEqual([]);
    expect(r.skipped).toHaveLength(5);
    expect(r.skipped[0].reason).toMatch(/stale/);
  });

  it('nothing at 09:15 or later', () => {
    expect(selectForPreOpenCheck(BOOK, b, ist(TUE, '09:15'))).toEqual({ checked: [], skipped: [] });
  });
});
