import { horizonFromTags, paperExitDecision, paperProduct, paperTags } from './paper';

/** Swing picks are held overnight in paper (owner 2026-10-27). */
const base = { side: 'BUY', ltp: 800, sl: 765, target: 820 };
const entered = new Date('2026-10-27T06:00:00Z'); // Tue 11:30 IST

describe('carried (BTST / POSITIONAL) paper trades', () => {
  it('a swing call is DELIVERY for cash, CARRYFORWARD for a future / option; intraday keeps the configured product', () => {
    expect(paperProduct('EQ', 'POSITIONAL', 'INTRADAY')).toBe('DELIVERY');
    expect(paperProduct('FUT', 'BTST', 'INTRADAY')).toBe('CARRYFORWARD');
    expect(paperProduct('CE', 'POSITIONAL', 'INTRADAY')).toBe('CARRYFORWARD');
    expect(paperProduct('EQ', 'INTRADAY', 'INTRADAY')).toBe('INTRADAY');
    expect(paperProduct('EQ', undefined, 'INTRADAY')).toBe('INTRADAY');
  });

  it('the horizon rides on the trade tags', () => {
    expect(horizonFromTags(paperTags('d1', 'POSITIONAL'))).toBe('POSITIONAL');
    expect(paperTags('d1', 'INTRADAY')).toEqual(paperTags('d1'));
    expect(horizonFromTags(paperTags('d1'))).toBe('INTRADAY');
  });

  it('a carried trade is NOT squared off at the close; an intraday one is', () => {
    const closing = { ...base, minutesToClose: 3, now: new Date('2026-10-27T09:57:00Z'), entryTime: entered };
    expect(paperExitDecision({ ...closing, product: 'DELIVERY', horizon: 'POSITIONAL' })).toEqual({ exit: false });
    expect(paperExitDecision({ ...closing, product: 'INTRADAY' })).toMatchObject({ exit: true, tag: 'TIME_EXIT' });
  });

  it('SL and target still exit a carried trade first', () => {
    expect(paperExitDecision({ ...base, ltp: 760, product: 'DELIVERY', minutesToClose: 200, horizon: 'POSITIONAL', entryTime: entered })).toMatchObject({ exit: true, tag: 'STOPPED_OUT' });
    expect(paperExitDecision({ ...base, ltp: 825, product: 'DELIVERY', minutesToClose: 200, horizon: 'POSITIONAL', entryTime: entered })).toMatchObject({ exit: true, tag: 'HIT_TARGET', price: 820 });
  });

  it('BTST exits in the next session, not the same day', () => {
    const btst = { ...base, product: 'CARRYFORWARD', horizon: 'BTST' as const, entryTime: entered, minutesToClose: 200 };
    expect(paperExitDecision({ ...btst, now: new Date('2026-10-27T08:00:00Z') })).toEqual({ exit: false });
    expect(paperExitDecision({ ...btst, now: new Date('2026-10-28T04:00:00Z') })).toMatchObject({ exit: true, tag: 'TIME_EXIT', reason: expect.stringMatching(/BTST/) });
  });

  it('a future / option is closed on its expiry day; a positional one after the hold limit', () => {
    const expiry = new Date('2026-10-29T18:30:00Z'); // 30 Oct IST
    const carried = { ...base, product: 'CARRYFORWARD', horizon: 'POSITIONAL' as const, entryTime: entered, expiry };
    expect(paperExitDecision({ ...carried, minutesToClose: 3, now: new Date('2026-10-29T09:57:00Z') })).toEqual({ exit: false });
    expect(paperExitDecision({ ...carried, minutesToClose: 3, now: new Date('2026-10-30T09:57:00Z') })).toMatchObject({ exit: true, reason: expect.stringMatching(/expiry day/) });
    const cash = { ...base, product: 'DELIVERY', horizon: 'POSITIONAL' as const, entryTime: entered, minutesToClose: 3 };
    expect(paperExitDecision({ ...cash, now: new Date('2026-11-09T09:57:00Z') })).toEqual({ exit: false });
    expect(paperExitDecision({ ...cash, now: new Date('2026-11-10T09:57:00Z') })).toMatchObject({ exit: true, reason: expect.stringMatching(/14 days/) });
  });
});
