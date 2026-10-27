import { buildupSeries, chainSummary, pickExpiry, renderResearch, researchIntent } from './research-data';

const names = ['IDEA', 'NIFTY', 'BANKNIFTY', 'GOLD', 'RELIANCE', 'KPITTECH'];

describe('advisor research intent', () => {
  it.each([
    ['can i ask you to do a reaasech over idea oi for the next month', { symbol: 'IDEA', expiry: 'next' }],
    ['what does the bank nifty option chain say', { symbol: 'BANKNIFTY', expiry: 'current' }],
    ['gold OI buildup this week', { symbol: 'GOLD', expiry: 'current' }],
    ['analyse KPIT TECH open interest for monthly expiry', { symbol: 'KPITTECH', expiry: 'next' }],
  ])('%s', (q, want) => {
    expect(researchIntent(q, names)).toEqual(want);
  });

  it.each([
    'how did my trades do today',
    'research something about the market',
    'what is the weather',
  ])('not a research question on one F&O name: %s', (q) => {
    expect(researchIntent(q, names)).toBeNull();
  });
});

describe('research summaries', () => {
  it('picks the current / next expiry from the live list', () => {
    expect(pickExpiry(['2026-11-25', '2026-10-28', '2026-12-30'], 'current')).toBe('2026-10-28');
    expect(pickExpiry(['2026-11-25', '2026-10-28', '2026-12-30'], 'next')).toBe('2026-11-25');
    expect(pickExpiry(['2026-10-28'], 'next')).toBe('2026-10-28');
    expect(pickExpiry([], 'current')).toBeNull();
  });

  it('chain: PCR, max pain, call walls above spot and put walls below it', () => {
    const rows = [
      { strike: 11, ceOi: 1_000, peOi: 9_000, ceLtp: 1.4, peLtp: 0.1 },
      { strike: 12, ceOi: 5_000, peOi: 6_000, ceLtp: 0.6, peLtp: 0.4 },
      { strike: 13, ceOi: 12_000, peOi: 2_000, ceLtp: 0.2, peLtp: 1.0 },
      { strike: 14, ceOi: 8_000, peOi: 500, ceLtp: 0.05, peLtp: 1.9 },
    ];
    const s = chainSummary(rows, 12.1);
    expect(s).toMatchObject({ strikes: 4, ceOi: 26_000, peOi: 17_500, pcr: 0.67, callWall: 13, putWall: 11, maxPain: 12 });
    expect(s.topCalls.map((x) => x.strike)).toEqual([13, 14]);
    expect(s.topPuts.map((x) => x.strike)).toEqual([11, 12]);
  });

  it('build-up: price vs OI per session', () => {
    const days = buildupSeries([
      { date: '2026-10-21', close: 12.0, oi: 100 },
      { date: '2026-10-22', close: 12.3, oi: 110 },
      { date: '2026-10-23', close: 12.1, oi: 120 },
      { date: '2026-10-24', close: 12.4, oi: 115 },
      { date: '2026-10-27', close: 12.2, oi: 105 },
      { date: '2026-10-28', close: 12.3, oi: 105.2 },
    ]);
    expect(days.map((d) => d.kind)).toEqual(['LONG_BUILDUP', 'SHORT_BUILDUP', 'SHORT_COVERING', 'LONG_UNWINDING', 'FLAT']);
  });

  it('renders the numbers and names what is missing', () => {
    const text = renderResearch({
      symbol: 'IDEA',
      expiry: '2026-11-25',
      spot: 12.11,
      spotSource: 'IDEA25NOV26FUT LTP',
      lotSize: 80000,
      chain: chainSummary([{ strike: 13, ceOi: 12_000, peOi: 2_000, ceLtp: 0.2, peLtp: 1 }], 12.11),
      futures: null,
      levels: null,
      news: [],
      missing: ['F&O ban list (not tracked by the app)'],
      at: '2026-10-27T10:30:00.000Z',
    });
    expect(text).toContain('symbol: IDEA | expiry: 2026-11-25');
    expect(text).toContain('call walls (resistance): 13');
    expect(text).toContain('NOT AVAILABLE (say so, do not guess): F&O ban list');
  });
});
