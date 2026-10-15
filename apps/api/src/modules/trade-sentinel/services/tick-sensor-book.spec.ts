import { TickSensorBook, keyOf, sensorSeed, type SensorSeed } from './tick-sensor-book';

const seed = (over: Partial<SensorSeed> = {}): SensorSeed => ({
  userId: 'u1', trackerId: 't1', symbol: 'NIFTY28OCT2624000CE', segment: 'OPT', side: 'LONG', entryPrice: 100,
  contractKey: 'NFO:1', underlyingKey: 'NSE:99926000', nearestSupport: 24000, nearestResistance: 24200,
  holdingHigh: 130, holdingLow: 95, ltp: 120, underlyingLtp: 24050, ...over,
});

describe('TickSensorBook', () => {
  it('indexes a tracker under its contract AND underlying keys', () => {
    const b = new TickSensorBook();
    b.upsert(seed());
    expect(b.forKey('NFO:1').map((c) => c.trackerId)).toEqual(['t1']);
    expect(b.forKey('NSE:99926000').map((c) => c.trackerId)).toEqual(['t1']);
    expect(b.forKey('NSE:1')).toEqual([]);
  });

  it('an upsert refreshes levels but keeps the tick bookkeeping (lastEvalAt, firing)', () => {
    const b = new TickSensorBook();
    b.upsert(seed());
    const c = b.forKey('NFO:1')[0];
    c.lastEvalAt = 5;
    c.firing = true;
    b.upsert(seed({ nearestSupport: 24010, underlyingKey: null }));
    const d = b.forKey('NFO:1')[0];
    expect(d).toMatchObject({ nearestSupport: 24010, lastEvalAt: 5, firing: true });
    expect(b.forKey('NSE:99926000')).toEqual([]);   // old key unindexed
  });

  it('prune drops a user’s trackers that left the roster', () => {
    const b = new TickSensorBook();
    b.upsert(seed());
    b.upsert(seed({ trackerId: 't2', contractKey: 'NFO:2' }));
    b.prune('u1', new Set(['t2']));
    expect(b.forKey('NFO:1')).toEqual([]);
    expect(b.users()).toEqual(['u1']);
    b.prune('u1', new Set());
    expect(b.users()).toEqual([]);
  });

  it('keyOf upper-cases the exchange', () => expect(keyOf({ exchange: 'nfo', token: '1' })).toBe('NFO:1'));
});

describe('sensorSeed', () => {
  const tickBase = {
    segment: 'OPT', side: 'LONG', entryPrice: 100, qty: 50, ltp: 120, underlyingLtp: 24050,
    nearestSupport: 24000, nearestResistance: 24200, holdingHigh: 130, holdingLow: 95,
    contractRef: { exchange: 'NFO', token: '1', symbol: 'S' }, underlyingRef: { exchange: 'NSE', token: '99926000', symbol: 'NIFTY' },
  } as never;
  const entry = { userId: 'u1', trackerId: 't1', symbol: 'S' };

  it('derivative: contract + underlying keys', () => {
    expect(sensorSeed(entry, tickBase)).toMatchObject({ contractKey: 'NFO:1', underlyingKey: 'NSE:99926000' });
  });

  it('cash: the contract IS the underlying (both keys the same)', () => {
    const cash = { ...(tickBase as object), segment: 'EQ_INTRADAY', underlyingRef: null, contractRef: { exchange: 'NSE', token: '2885', symbol: 'RELIANCE-EQ' } } as never;
    expect(sensorSeed(entry, cash)).toMatchObject({ contractKey: 'NSE:2885', underlyingKey: 'NSE:2885' });
  });

  it('no contractRef → nothing to watch', () => {
    expect(sensorSeed(entry, { ...(tickBase as object), contractRef: null } as never)).toBeNull();
  });
});
