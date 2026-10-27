import { AdvisorResearchService } from './research.service';

const NOW = new Date('2026-10-27T10:30:00Z');
// Angel scrip-master rows: strike ×100, expiry DDMMMYYYY.
const leg = (strike: number, t: 'CE' | 'PE', token: string, expiry = '25NOV2026') => ({
  name: 'IDEA', symbol: `IDEA25NOV26${strike}${t}`, token, exch_seg: 'NFO', instrumenttype: 'OPTSTK', expiry, strike: String(strike * 100), lotsize: '80000',
});
const master = [
  { name: 'IDEA', symbol: 'IDEA28OCT26FUT', token: 'F1', exch_seg: 'NFO', instrumenttype: 'FUTSTK', expiry: '28OCT2026', strike: '-1', lotsize: '80000' },
  { name: 'IDEA', symbol: 'IDEA25NOV26FUT', token: 'F2', exch_seg: 'NFO', instrumenttype: 'FUTSTK', expiry: '25NOV2026', strike: '-1', lotsize: '80000' },
  { ...leg(12, 'CE', 'C12', '28OCT2026'), symbol: 'IDEA28OCT2612CE' },
  leg(11, 'CE', 'C11'), leg(11, 'PE', 'P11'), leg(12, 'CE', 'C12N'), leg(12, 'PE', 'P12'), leg(13, 'CE', 'C13'), leg(13, 'PE', 'P13'),
];

function make() {
  const adapter = { getInstrumentMaster: jest.fn(async () => master) };
  const oi: Record<string, number> = { C11: 1000, P11: 9000, C12N: 5000, P12: 6000, C13: 12000, P13: 2000 };
  const feeds = {
    fetchQuote: jest.fn(async () => ({ ltp: 12.1, oi: 4_200_000_000 })),
    fetchQuotes: jest.fn(async (_u: string, refs: Array<{ token: string }>) => new Map(refs.map((r) => [r.token, { ltp: 0.5, oi: oi[r.token] ?? 0 }]))),
    fetchOIWindow: jest.fn(async () => [
      { ts: new Date('2026-10-23T04:00:00Z'), oi: 100 },
      { ts: new Date('2026-10-24T04:00:00Z'), oi: 110 },
    ]),
    fetchCandles: jest.fn(async () => [
      { timestamp: '2026-10-23T03:45:00Z', close: 12.0 },
      { timestamp: '2026-10-24T03:45:00Z', close: 12.3 },
    ]),
  };
  const levels = { structureFor: jest.fn(async () => ({ nearestSupport: 11.8, nearestResistance: 12.6, factorValues: { mtfTrend: -1 } })) };
  return { svc: new AdvisorResearchService(adapter as any, feeds as any, levels as any, undefined), feeds };
}

describe('AdvisorResearchService', () => {
  it('reads the asked expiry: its future as spot, its chain OI in one batch, the build-up and the level book', async () => {
    const t = make();
    expect(await t.svc.intentOf('research idea oi for next month')).toEqual({ symbol: 'IDEA', expiry: 'next' });
    const d = await t.svc.gather({ symbol: 'IDEA', expiry: 'next' }, 'owner', NOW);
    expect(d).toMatchObject({ symbol: 'IDEA', expiry: '2026-11-25', spot: 12.1, lotSize: 80000, levels: { support: 11.8, resistance: 12.6, trend: -1 } });
    expect(t.feeds.fetchQuote).toHaveBeenCalledWith('owner', 'F2', 'NFO');
    // Only November's legs are quoted (the October 12 CE is a different expiry).
    expect(t.feeds.fetchQuotes.mock.calls[0][1].map((r: { token: string }) => r.token).sort()).toEqual(['C11', 'C12N', 'C13', 'P11', 'P12', 'P13']);
    expect(d.chain).toMatchObject({ ceOi: 18000, peOi: 17000, callWall: 13, putWall: 11 });
    expect(d.futures).toMatchObject({ tradingsymbol: 'IDEA25NOV26FUT', days: [expect.objectContaining({ kind: 'LONG_BUILDUP' })] });
    expect(d.missing).toEqual(['F&O ban list (not tracked by the app)']);
  });

  it('a normal question is not research; a broker failure is named, not thrown', async () => {
    const t = make();
    expect(await t.svc.intentOf('how did my trades do today')).toBeNull();
    t.feeds.fetchQuotes.mockRejectedValueOnce(new Error('throttled'));
    const d = await t.svc.gather({ symbol: 'IDEA', expiry: 'next' }, 'owner', NOW);
    expect(d.chain).toBeNull();
    expect(d.missing).toContain('option chain quotes: throttled');
  });
});
