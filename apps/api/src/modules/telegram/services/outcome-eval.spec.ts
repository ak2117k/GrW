import { evaluateLeveled, evaluateDirectional, resultPct } from './outcome-eval';

const bar = (high: number, low: number, t = '2026-07-20T05:00:00Z') =>
  ({ high, low, close: (high + low) / 2, timestamp: new Date(t) });

const leveled = (over: Partial<any> = {}) => ({
  side: 'LONG', signalType: 'LEVELED', entryLow: 100, entryHigh: 100, entryMode: 'NEAR',
  stopLoss: 95, slMode: 'NUMERIC', targets: [110], entryPrice: null, horizon: 'INTRADAY', ...over,
});

it('resultPct is signed by side', () => {
  expect(resultPct(100, 110, 'LONG')).toBeCloseTo(10);
  expect(resultPct(100, 90, 'SHORT')).toBeCloseTo(10);
});

it('fills entry then hits target', () => {
  const r = evaluateLeveled(leveled(), [bar(101, 99), bar(112, 108)]);
  expect(r.status).toBe('TARGET_HIT');
  expect(r.hitTargetIndex).toBe(0);
  expect(r.resultPct).toBeCloseTo(10);
});

it('SL-first tie-break: one bar touches both SL and target → SL_HIT', () => {
  const r = evaluateLeveled(leveled({ entryPrice: 100 }), [bar(112, 94)]); // already ACTIVE
  expect(r.status).toBe('SL_HIT');
  expect(r.resultPct).toBeCloseTo(-5);
});

it('never fills → EXPIRED', () => {
  const r = evaluateLeveled(leveled(), [bar(99, 97), bar(98, 96)]);
  expect(r.status).toBe('EXPIRED');
});

it('directional: +winPct before -lossPct → TARGET_HIT', () => {
  const sig = { side: 'LONG', signalType: 'DIRECTIONAL', entryPrice: 100, horizon: 'SWING' } as any;
  const r = evaluateDirectional(sig, [bar(105, 99), bar(109, 104)], { winPct: 8, lossPct: 5 });
  expect(r.status).toBe('TARGET_HIT');
});

it('directional: -lossPct first → SL_HIT', () => {
  const sig = { side: 'LONG', signalType: 'DIRECTIONAL', entryPrice: 100, horizon: 'SWING' } as any;
  const r = evaluateDirectional(sig, [bar(101, 94)], { winPct: 8, lossPct: 5 });
  expect(r.status).toBe('SL_HIT');
});
