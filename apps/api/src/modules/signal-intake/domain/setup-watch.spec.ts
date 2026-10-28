import { istMinutes, openingRange, setupBroken, setupLevel, setupSignal, type SetupForWatch } from './setup-watch';

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

  it('a broken LONG future becomes an ABOVE call with the setup\'s stop and targets', () => {
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
      sl: 1321.36,
      targets: [1392.95, 1420],
      horizon: 'INTRADAY',
    });
    expect(s.rawText).toMatch(/^\[night setup: LONG CIPLA broke the first 15-min high 1355/);
  });

  it('a SHORT cash setup is a BELOW EQ call', () => {
    const s = setupSignal(setup({ side: 'SHORT', instrumentKind: 'CASH_MIS', instrument: 'CIPLA intraday cash (MIS)', exchange: 'NSE' }), { at: new Date(), ltp: 1341, level: 1342, range: { high: 1355, low: 1342 } });
    expect(s).toMatchObject({ instrumentKind: 'EQ', side: 'SELL', entryType: 'BELOW', expiry: null, tradingsymbol: null });
  });

  it('IST minutes', () => {
    expect(istMinutes(new Date('2026-10-28T09:30:00+05:30'))).toBe(570);
  });
});
