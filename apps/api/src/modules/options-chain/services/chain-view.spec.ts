import { legacyView, viewFromHub } from './chain-view';

const chain = { underlying: 'NIFTY', expiry: '2026-10-13', exchange: 'NFO' as const, spot: null, at: Date.parse('2026-10-12T04:40:00Z'), greeks: 'local' as const, entries: [] };

describe('chain views', () => {
  it('maps every hub result kind, keeping the chain time and a null spot', () => {
    const now = Date.parse('2026-10-12T04:40:05Z');
    expect(viewFromHub({ kind: 'fresh', chain }, now)).toEqual({ chain: [], spotPrice: null, at: '2026-10-12T04:40:00.000Z', source: 'hub', status: 'fresh', greeks: 'local' });
    expect(viewFromHub({ kind: 'stale', chain, ageMs: 5000 }, now).status).toBe('stale');
    expect(viewFromHub({ kind: 'market-closed', chain }, now).status).toBe('market-closed');
    expect(viewFromHub({ kind: 'unavailable', reason: 'throttled' }, now)).toEqual({ chain: [], spotPrice: null, at: '2026-10-12T04:40:05.000Z', source: 'hub', status: 'unavailable', unavailable: 'throttled' });
  });

  it("passes the 'none' Greeks label through", () => {
    const now = Date.parse('2026-10-12T04:40:05Z');
    expect(viewFromHub({ kind: 'fresh', chain: { ...chain, greeks: 'none' } }, now).greeks).toBe('none');
  });

  it('labels a legacy chain by its own age: ≤ 60 s fresh, older stale in market hours, market-closed outside', () => {
    const now = Date.parse('2026-10-12T05:00:00Z');
    const l = { chain: [], spotPrice: 25000, source: 'snapshot' as const, at: now - 30_000 };
    expect(legacyView(l, now, true).status).toBe('fresh');
    expect(legacyView({ ...l, at: now - 7 * 86_400_000 }, now, true).status).toBe('stale');
    expect(legacyView({ ...l, at: now - 7 * 86_400_000 }, now, false)).toEqual(expect.objectContaining({ status: 'market-closed', source: 'snapshot', spotPrice: 25000 }));
    expect(legacyView({ ...l, spotPrice: 0 }, now, true).spotPrice).toBeNull();
  });
});
