import { istMinutes, openingRange, setupBroken, setupLevel, setupLevels, setupSignal, type SetupForWatch } from './setup-watch';
import { evaluateSignalOutcome } from './outcome';

const setup = (over: Partial<SetupForWatch> = {}): SetupForWatch => ({
  id: 'ts1',
  sessionDate: '2026-10-28',
  symbol: 'CIPLA',
  instrumentKind: 'FUTURES',
  instrument: 'CIPLA23NOV26FUT (NFO futures, near month)',
  exchange: 'NFO',
  instrumentToken: '123',
  expiry: '2026-11-23',
  side: 'LONG',
  entryRule: 'Wait for the first 15-min candle (09:15–09:30 IST) to close; enter LONG only on a break of its high.',
  stop: 1321.36,
  target1: 1392.95,
  target2: 1420,
  stopDistance: 28.64,
  ...over,
});

describe('setup-watch', () => {
  it('reads the 09:15 IST bar as the opening range', () => {
    const bars = [
      { timestamp: new Date('2026-10-28T09:15:00+05:30'), high: 1355, low: 1342 },
      { timestamp: new Date('2026-10-28T09:30:00+05:30'), high: 1360, low: 1350 },
    ];
    expect(openingRange(bars, '2026-10-28')).toEqual({ high: 1355, low: 1342 });
    expect(openingRange(bars.slice(1), '2026-10-28')).toBeNull();
  });

  it('a LONG waits for the high, a SHORT for the low; only a break counts', () => {
    const r = { high: 1355, low: 1342 };
    expect(setupLevel('LONG', r)).toBe(1355);
    expect(setupLevel('SHORT', r)).toBe(1342);
    expect(setupBroken('LONG', 1355, 1355)).toBe(false);
    expect(setupBroken('LONG', 1355, 1355.5)).toBe(true);
    expect(setupBroken('SHORT', 1342, 1341.9)).toBe(true);
    expect(setupBroken('SHORT', 1342, null)).toBe(false);
  });

  it('a broken LONG future becomes an ABOVE call with the setup\'s stop and targets measured from the break', () => {
    const s = setupSignal(setup(), { at: new Date('2026-10-28T04:10:00Z'), ltp: 1356, level: 1355, range: { high: 1355, low: 1342 } });
    expect(s).toMatchObject({
      messageId: 'setup:ts1',
      channelId: 'night-setup',
      parser: 'setup',
      underlying: 'CIPLA',
      instrumentKind: 'FUT',
      expiry: '2026-11-23',
      tradingsymbol: 'CIPLA23NOV26FUT',
      side: 'BUY',
      entryType: 'ABOVE',
      entryLow: 1355,
      // 1 R = the setup's stopDistance 28.64: SL 1 R behind 1355, T1 1.5 R / T2 2.5 R beyond it.
      sl: 1326.36,
      targets: [1397.96, 1426.6],
      horizon: 'INTRADAY',
    });
    expect(s.rawText).toMatch(/^\[night setup: LONG CIPLA broke the first 15-min high 1355/);
  });

  it('a SHORT cash setup is a BELOW EQ call', () => {
    const s = setupSignal(setup({ side: 'SHORT', instrumentKind: 'CASH_MIS', instrument: 'CIPLA intraday cash (MIS)', exchange: 'NSE' }), { at: new Date(), ltp: 1341, level: 1342, range: { high: 1355, low: 1342 } });
    expect(s).toMatchObject({ instrumentKind: 'EQ', side: 'SELL', entryType: 'BELOW', expiry: null, tradingsymbol: null });
  });

  it('prod 2026-11-03 MARICO: a gapped-up break re-derives the levels — targets above the entry, never below', () => {
    // Night plan from the 798.57 close (R 17.21): SL 781.36, T1 824.38, T2 841.59. The future broke 851.2.
    const marico = setup({ symbol: 'MARICO', instrument: 'MARICO25NOV26FUT (NFO futures, near month)', stop: 781.36, target1: 824.38, target2: 841.59, stopDistance: 17.21 });
    const s = setupSignal(marico, { at: new Date('2026-11-03T04:05:00Z'), ltp: 851.5, level: 851.2, range: { high: 851.2, low: 840 } });
    expect(s.sl).toBe(833.99);
    expect(s.targets).toEqual([877.02, 894.23]);
    expect(s.targets.every((t) => t > 851.2)).toBe(true);
    // The trigger bar no longer "hits" a target below the entry.
    const o = evaluateSignalOutcome(
      { side: 'BUY', entryType: 'ABOVE', entryLow: 851.2, entryHigh: 851.2, sl: s.sl, targets: s.targets },
      [{ ts: 1, high: 852, low: 846, close: 850 }, { ts: 2, high: 860, low: 849, close: 858 }],
    );
    expect(o.status).toBe('NEITHER');
  });

  it('without an R (no stopDistance, T1 = T2) only right-side printed levels are kept', () => {
    expect(setupLevels({ side: 'LONG', stop: 781.36, target1: 824.38, target2: 824.38, stopDistance: null }, 851.2)).toEqual({ sl: 781.36, targets: [], r: null });
    expect(setupLevels({ side: 'SHORT', stop: 900, target1: 860, target2: 860 }, 851.2)).toEqual({ sl: 900, targets: [], r: null });
    // R from |T2 − T1| when the row was read without stopDistance; a SHORT mirrors it.
    expect(setupLevels({ side: 'SHORT', stop: 0, target1: 820, target2: 800, stopDistance: null }, 851.2)).toEqual({ sl: 871.2, targets: [821.2, 801.2], r: 20 });
  });

  it('IST minutes', () => {
    expect(istMinutes(new Date('2026-10-28T09:30:00+05:30'))).toBe(570);
  });
});
