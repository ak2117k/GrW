import { readPacketFacts } from './packet-facts';

const P = (patch: Record<string, unknown> = {}) => ({
  position: { symbol: 'CRUDEOIL17NOV269000CE', side: 'LONG', qty: 100, entryPrice: 521.9, ltp: 527.6, expiry: '2026-11-17',
    underlyingLtp: { available: true, value: 9003, source: 's', at: 'a' } },
  money: { grossPnl: 570, charges: 61, netPnl: 509, greenFloorPrice: 524.85, greenFloorArmed: true, mfe: 539.5, mae: 518 },
  thesis: { available: true, value: { direction: 'LONG', reason: 'r', levelPrice: 8960, targetPrice: 9100, invalidation: 8932, source: 'AGENT' }, source: 's', at: 'a' },
  structure: {
    levelBook: { available: true, value: { vwap: 9000, atr14: 13.5, interval: '15m' }, source: 's', at: 'a' },
    nearestSupport: { available: true, value: 8946, source: 's', at: 'a' },
    nearestResistance: { available: true, value: 9020, source: 's', at: 'a' },
  },
  flow: { volumeRatio: { available: false, reason: 'n/a' }, oiWalls: { available: false, reason: 'n/a' } },
  session: { nowUtc: '2026-10-14T11:00:30.000Z', minutesToClose: { available: true, value: 419, source: 's', at: 'a' } },
  ...patch,
});

describe('readPacketFacts', () => {
  it('reads a pre-v7 packet (no noiseUnit, no floorBasis ⇒ fixed)', () => {
    expect(readPacketFacts(P())).toEqual({
      symbol: 'CRUDEOIL17NOV269000CE', side: 'LONG', qty: 100, entryPrice: 521.9, ltp: 527.6, underlying: 9003,
      invalidation: 8932, vwap: 9000, levelBookAtr15m: 13.5, noise: null,
      floor: { price: 524.85, armed: true, basis: 'fixed' }, netPnl: 509, charges: 61, expiry: '2026-11-17',
      builtAt: '2026-10-14T11:00:30.000Z', minutesToClose: 419, support: 8946, resistance: 9020,
    });
  });

  it('reads a v7 packet: noise unit and noise floor basis', () => {
    const noise = { contract: { n: 4.5, method: 'atr14-1m', bars: 14, at: 'x' }, underlying: { n: 3.49, method: 'atr14-15m-scaled', bars: 0, at: 'y' } };
    const f = readPacketFacts(P({
      flow: { volumeRatio: { available: false, reason: 'n/a' }, oiWalls: { available: false, reason: 'n/a' }, noiseUnit: { available: true, value: noise, source: 's', at: 'a' } },
      money: { charges: 61, netPnl: 509, greenFloorPrice: 530.5, greenFloorArmed: true, floorBasis: 'noise' },
    }));
    expect(f).toMatchObject({ noise, floor: { price: 530.5, armed: true, basis: 'noise' } });
  });

  it('FLOOR_HARD_EXIT: reads money.anchors (the best point and arm point underlyings); absent ⇒ no key', () => {
    expect('anchors' in (readPacketFacts(P()) as object)).toBe(false);
    const money = { ...P().money, anchors: { best: { ltp: 539.5, underlying: 9018, at: 'x' }, floorArm: null, underlyingAgainst: {}, hardExitN: 2 } };
    expect(readPacketFacts(P({ money }))).toMatchObject({ anchors: { bestUnderlying: 9018, armUnderlying: null } });
    const junk = { ...P().money, anchors: { best: { underlying: 'x' }, floorArm: 7 } };
    expect(readPacketFacts(P({ money: junk }))).toMatchObject({ anchors: { bestUnderlying: null, armUnderlying: null } });
  });

  it.each([
    ['unavailable underlying', { position: { ...P().position, underlyingLtp: { available: false, reason: 'x' } } }, 'underlying', null],
    ['no thesis', { thesis: { available: false, reason: 'none' } }, 'invalidation', null],
    ['string where a number belongs', { structure: { ...P().structure, levelBook: { available: true, value: { vwap: 'n/a' } } } }, 'vwap', null],
    ['NaN-ish invalidation', { thesis: { available: true, value: { invalidation: null } } }, 'invalidation', null],
    ['minutesToClose absent', { session: { nowUtc: 'x', minutesToClose: { available: false, reason: 'closed' } } }, 'minutesToClose', null],
  ])('%s → null, never a throw', (_l, patch, key, value) => {
    expect((readPacketFacts(P(patch)) as Record<string, unknown>)[key]).toBe(value);
  });

  it.each([
    ['null', null], ['a string', 'packet'], ['no position', { money: {} }], ['side not LONG/SHORT', P({ position: { ...P().position, side: 'BUY' } })],
    ['non-finite ltp', P({ position: { ...P().position, ltp: 'x' } })], ['no money', P({ money: undefined })],
  ])('%s → unreadable', (_l, p) => {
    expect(readPacketFacts(p)).toEqual({ unreadable: expect.any(String) });
  });
});
