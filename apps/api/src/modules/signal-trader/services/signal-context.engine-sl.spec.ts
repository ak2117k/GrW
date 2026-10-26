import { SignalContextService } from './signal-context.service';

/** Engine SL inputs when no fresh chain snapshot covers the underlying (prod 2026-10-26: every SL fell to 25%). */
const NOW = new Date('2026-10-26T06:24:00Z');

const contract = (over: Record<string, unknown> = {}) =>
  ({ exchange: 'NFO', token: '70913', tradingsymbol: 'DRREDDY27OCT261240CE', lotSize: 625, tickSize: 0.05, expiry: '2026-10-27', ...over }) as any;

function make(opts: {
  support?: number | null;
  quote?: number | null;
  greeks?: Array<{ strike: number; optionType: 'CE' | 'PE'; delta: number }>;
  future?: { token: string; exchange: string } | null;
  cash?: { token: string; exchange: string } | null;
}) {
  const levels = {
    structureFor: jest.fn().mockResolvedValue({ nearestSupport: opts.support ?? null, nearestResistance: null, reason: opts.support ? undefined : 'no level below price' }),
  };
  const marketCtx = { snapshot: jest.fn().mockResolvedValue({ spot: null }) };
  const feeds = {
    fetchQuote: jest.fn().mockResolvedValue(opts.quote === undefined ? null : opts.quote === null ? null : { ltp: opts.quote }),
    fetchOptionGreeks: jest.fn().mockResolvedValue(opts.greeks ?? []),
    fetchCandles: jest.fn().mockResolvedValue([]),
  };
  const instruments = {
    getInstrumentBySymbol: jest.fn().mockResolvedValue(opts.cash === undefined ? { token: '881', exchange: 'NSE' } : opts.cash),
    getNearestFuture: jest.fn().mockResolvedValue(opts.future === undefined ? { token: '447', exchange: 'MCX' } : opts.future),
  };
  const svc = new SignalContextService(undefined, marketCtx as any, levels as any, undefined, undefined, undefined, undefined, feeds as any, instruments as any);
  return { svc, levels, feeds, instruments };
}

const run = (svc: SignalContextService, sig: Record<string, unknown>, c = contract(), price = 50) =>
  svc.engineSl({ signal: { underlying: 'DRREDDY', instrumentKind: 'CE', side: 'BUY', strike: 1240, ...sig } as any, contract: c, price, ownerUserId: 'owner', now: NOW, optionPct: 25, bufferPct: 0.2 });

describe('SignalContextService.engineSl — underlying price and delta without a chain snapshot', () => {
  it('stock option: spot from the cash quote, delta from the broker greeks → a level stop, not 25%', async () => {
    const { svc, feeds, instruments } = make({ support: 1225, quote: 1248, greeks: [{ strike: 1240, optionType: 'CE', delta: 0.5 }] });
    const r = await run(svc, {});
    expect(instruments.getInstrumentBySymbol).toHaveBeenCalledWith('DRREDDY-EQ', 'NSE');
    expect(feeds.fetchQuote).toHaveBeenCalledWith('owner', '881', 'NSE');
    expect(feeds.fetchOptionGreeks).toHaveBeenCalledWith('owner', 'DRREDDY', '2026-10-27');
    expect(r.method).toBe('level_delta');
    // move to 1225 × (1 − 0.2%) = 1222.55 → 25.45 × 0.5 ≈ 12.7 below 50
    expect(r.sl).toBeGreaterThan(36);
    expect(r.sl).toBeLessThan(38);
  });

  it('MCX option: spot from the nearest future; no greeks call (Angel has none for MCX)', async () => {
    const { svc, feeds, instruments } = make({ support: null, quote: 10450 });
    const r = await run(svc, { underlying: 'CRUDEOIL', strike: 10500 }, contract({ exchange: 'MCX', token: '1', tradingsymbol: 'CRUDEOIL17NOV2610500CE', lotSize: 100, expiry: '2026-11-17' }), 270);
    expect(instruments.getNearestFuture).toHaveBeenCalledWith('CRUDEOIL', 'MCX', expect.any(Date));
    expect(feeds.fetchQuote).toHaveBeenCalledWith('owner', '447', 'MCX');
    expect(feeds.fetchOptionGreeks).not.toHaveBeenCalled();
    expect(r.method).toBe('premium_pct');
  });

  it('a 25% fallback says why: the spot it used and what the level book returned', async () => {
    const { svc } = make({ support: null, quote: 1248, greeks: [{ strike: 1240, optionType: 'CE', delta: 0.5 }] });
    const r = await run(svc, {});
    expect(r.method).toBe('premium_pct');
    expect(r.detail).toContain('spot 1248 (quote)');
    expect(r.detail).toContain('level book: no level below price');
  });

  it('no underlying price anywhere → the fallback says so', async () => {
    const { svc } = make({ quote: null, cash: null });
    const r = await run(svc, {});
    expect(r.method).toBe('premium_pct');
    expect(r.detail).toContain('no underlying price');
  });
});
