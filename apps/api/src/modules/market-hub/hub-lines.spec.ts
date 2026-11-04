import { MARKET_HOLIDAYS } from '../market-data/services/market-holidays.service';
import {
  DEFAULT_LINE_FUTURES,
  LINE_STALE_MS,
  futureExchangeFor,
  mergeLines,
  parseLineFutures,
  positionUnderlyingLines,
  resolveLineFutures,
  staleLines,
} from './hub-lines';
import type { InstrumentRef } from './hub.types';
import { SessionClock } from './session-clock';

const IST = (local: string) => new Date(`${local}Z`).getTime() - 5.5 * 3600_000;
const CRUDE: InstrumentRef = { exchange: 'MCX', token: '573422', symbol: 'CRUDEOIL19NOV26FUT' };
const NIFTY_FUT: InstrumentRef = { exchange: 'NFO', token: '61471', symbol: 'NIFTY23NOV26FUT' };
const NIFTY: InstrumentRef = { exchange: 'NSE', token: '99926000', symbol: 'NIFTY' };

describe('hub lines', () => {
  it('parses HUB_LINE_FUTURES: default when unset, upper-cased and de-duplicated, none = no futures', () => {
    expect(parseLineFutures(undefined)).toEqual(DEFAULT_LINE_FUTURES.split(','));
    expect(parseLineFutures('  ')).toEqual(DEFAULT_LINE_FUTURES.split(','));
    expect(parseLineFutures('crudeoil, NIFTY,crudeoil,')).toEqual(['CRUDEOIL', 'NIFTY']);
    expect(parseLineFutures('none')).toEqual([]);
    expect(DEFAULT_LINE_FUTURES).toContain('CRUDEOIL');
  });

  it('pins full GOLD and SILVER near-month futures by default (2026-11-04: zero GOLD bars), not GOLDM', () => {
    const names = parseLineFutures(undefined);
    expect(names).toEqual(expect.arrayContaining(['GOLD', 'SILVER', 'CRUDEOIL']));
    expect(names).not.toContain('GOLDM');
    expect(futureExchangeFor('GOLD')).toBe('MCX');
    expect(futureExchangeFor('SILVER')).toBe('MCX');
  });

  it('GOLD rolls at expiry like CRUDEOIL: the nearest future on/after today is re-picked', async () => {
    const book = [
      { token: '495213', symbol: 'GOLD04DEC26FUT', expiry: IST('2026-12-04T00:00:00') },
      { token: '559933', symbol: 'GOLD05FEB27FUT', expiry: IST('2027-02-05T00:00:00') },
    ];
    const lookup = async (name: string, _ex: string, onOrAfter: Date) =>
      name === 'GOLD' ? book.find((f) => f.expiry >= onOrAfter.getTime()) ?? null : null;
    const before = await resolveLineFutures(['GOLD'], lookup, new Date(IST('2026-11-04T00:00:00')));
    expect(before.found.get('GOLD')).toEqual({ exchange: 'MCX', token: '495213', symbol: 'GOLD04DEC26FUT' });
    const after = await resolveLineFutures(['GOLD'], lookup, new Date(IST('2026-12-05T00:00:00')));
    expect(after.found.get('GOLD')).toEqual({ exchange: 'MCX', token: '559933', symbol: 'GOLD05FEB27FUT' });
  });

  describe('positionUnderlyingLines', () => {
    const LAURUS: InstrumentRef = { exchange: 'NSE', token: '19234', symbol: 'LAURUSLABS-EQ' };
    const GOLD_FUT: InstrumentRef = { exchange: 'MCX', token: '495213', symbol: 'GOLD04DEC26FUT' };
    const base = [NIFTY, CRUDE];

    it('an open stock option pins its cash underlying; an index / MCX underlying is not re-pinned', () => {
      expect(positionUnderlyingLines([LAURUS, NIFTY, GOLD_FUT], { base, positions: 3, cap: 30 })).toEqual([LAURUS]);
    });

    it('closing the position releases it (no underlyings in, none out)', () => {
      expect(positionUnderlyingLines([], { base, positions: 0, cap: 30 })).toEqual([]);
    });

    it('one slot per distinct underlying (two LAURUSLABS options pin it once)', () => {
      expect(positionUnderlyingLines([LAURUS, { ...LAURUS }], { base, positions: 2, cap: 30 })).toEqual([LAURUS]);
    });

    it('respects the slot budget (30): pinned underlyings never take a held contract’s slot', () => {
      const stocks = Array.from({ length: 20 }, (_, i): InstrumentRef => ({ exchange: 'NSE', token: String(1000 + i), symbol: `S${i}-EQ` }));
      const eleven = Array.from({ length: 11 }, (_, i): InstrumentRef => ({ exchange: 'NSE', token: String(99 + i), symbol: `L${i}` }));
      // 11 base lines + 15 position contracts → 4 slots left for underlyings.
      const out = positionUnderlyingLines(stocks, { base: eleven, positions: 15, cap: 30 });
      expect(out).toEqual(stocks.slice(0, 4));
      expect(eleven.length + 15 + out.length).toBeLessThanOrEqual(30);
      // A full book pins nothing.
      expect(positionUnderlyingLines(stocks, { base: eleven, positions: 19, cap: 30 })).toEqual([]);
    });
  });

  it('puts index futures on NFO / BFO and everything else on MCX', () => {
    expect(futureExchangeFor('NIFTY')).toBe('NFO');
    expect(futureExchangeFor('banknifty')).toBe('NFO');
    expect(futureExchangeFor('SENSEX')).toBe('BFO');
    expect(futureExchangeFor('CRUDEOIL')).toBe('MCX');
    expect(futureExchangeFor('CRUDEOILM')).toBe('MCX');
  });

  it('resolves each name’s near-month future; a missing or failing name is reported, never thrown', async () => {
    const today = new Date(IST('2026-11-03T00:00:00'));
    const lookup = jest.fn(async (name: string) => {
      if (name === 'CRUDEOIL') return { token: '573422', symbol: 'CRUDEOIL19NOV26FUT' };
      if (name === 'GOLD') throw new Error('db down');
      return null;
    });
    const r = await resolveLineFutures(['CRUDEOIL', 'GOLD', 'NOPE'], lookup, today);
    expect([...r.found.values()]).toEqual([CRUDE]);
    expect(r.missing).toEqual(['GOLD', 'NOPE']);
    expect(lookup).toHaveBeenCalledWith('CRUDEOIL', 'MCX', today);
  });

  it('merges index lines and futures, one entry per EXCHANGE:token', () => {
    expect(mergeLines([NIFTY], [CRUDE, NIFTY], [CRUDE])).toEqual([NIFTY, CRUDE]);
  });

  describe('staleLines', () => {
    const clock = new SessionClock({ holidays: MARKET_HOLIDAYS, mcxLateClose: [{ from: '2026-11-02', to: '2027-03-08' }] });

    it('in the MCX evening only the MCX line can be due (NSE / NFO are shut)', () => {
      const now = IST('2026-11-03T20:30:00');
      expect(staleLines([NIFTY, NIFTY_FUT, CRUDE], new Map(), clock, now)).toEqual([CRUDE]);
    });

    it('a line with no bar yet this process is due (heals the day after a restart)', () => {
      expect(staleLines([CRUDE], new Map(), clock, IST('2026-11-03T18:10:00'))).toEqual([CRUDE]);
    });

    it('is due once its newest bar ended more than LINE_STALE_MS ago, not before', () => {
      const bar = IST('2026-11-03T18:04:00');
      const last = new Map([['MCX:573422', bar]]);
      expect(staleLines([CRUDE], last, clock, bar + 60_000 + LINE_STALE_MS)).toEqual([]);
      expect(staleLines([CRUDE], last, clock, bar + 60_000 + LINE_STALE_MS + 1)).toEqual([CRUDE]);
    });

    it('stays due through the late MCX close (23:55 in the US-DST window) and stops after it', () => {
      const last = new Map([['MCX:573422', IST('2026-11-03T18:04:00')]]);
      expect(staleLines([CRUDE], last, clock, IST('2026-11-03T23:50:00'))).toEqual([CRUDE]);
      expect(staleLines([CRUDE], last, clock, IST('2026-11-03T23:56:00'))).toEqual([]);
    });
  });
});
