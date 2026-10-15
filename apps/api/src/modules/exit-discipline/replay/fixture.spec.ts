import { buildSyntheticCrudeFixture } from './synthetic-crude';
import { validateFixture } from './fixture';
import { noiseFromBars } from '../noise';
import type { MinuteBar } from '../types';

describe('ExitFixtureV1', () => {
  const fx = buildSyntheticCrudeFixture();

  it('the synthetic fixture validates and is deterministic', () => {
    expect(validateFixture(JSON.parse(JSON.stringify(fx)))).toEqual(fx);
    expect(buildSyntheticCrudeFixture()).toEqual(fx);
  });

  it('encodes the evidence: six flip-flops, the 16:31 sale at 527.1, a later 542', () => {
    expect(fx.verdicts.filter((v) => v.verdict === 'EXIT_NOW')).toHaveLength(4);
    expect(fx.meta.actualExit).toEqual({ verdictId: 'v-1631', price: 527.1, at: '2026-10-14T11:01:00.000Z' });
    expect(fx.meta.finalMark.price).toBe(542);
    expect(fx.meta).toMatchObject({ symbol: 'CRUDEOIL17NOV269000CE', token: '582930', side: 'LONG', qty: 100, entryPrice: 521.9, productType: 'CARRYFORWARD', maxLossPerTrade: 2000, source: 'synthetic' });
  });

  it('the bars hit the spec §1 knots and every packet mirrors its minute', () => {
    const at = (bars: MinuteBar[], iso: string) => bars.find((b) => b.ts === Date.parse(iso))!.close;
    expect(at(fx.contractBars, '2026-10-14T10:09:00Z')).toBe(521.9);
    expect(at(fx.contractBars, '2026-10-14T10:40:00Z')).toBe(539.5);
    expect(at(fx.contractBars, '2026-10-14T11:01:00Z')).toBe(527.1);
    expect(at(fx.underlyingBars, '2026-10-14T10:50:00Z')).toBe(8998);
    const v = fx.verdicts.find((x) => x.id === 'v-1631')!;
    expect(v.createdAt).toBe('2026-10-14T11:01:00.000Z');
    expect(v.packet).toMatchObject({
      position: { ltp: 527.1, underlyingLtp: { available: true, value: 9003 } },
      money: { charges: 61, greenFloorPrice: 524.85, greenFloorArmed: true },
      thesis: { available: true, value: { invalidation: 8932 } },
      structure: { levelBook: { value: { vwap: 8995, atr14: 316 } } }, // daily ATR, as the level book really stores it
      session: { nowUtc: '2026-10-14T11:00:30.000Z', minutesToClose: { available: true, value: 419 } },
    });
    expect((v.packet as { money: { netPnl: number } }).money.netPnl).toBeCloseTo((527.1 - 521.9) * 100 - 61, 6);
    expect((v.packet as { flow: Record<string, unknown> }).flow.noiseUnit).toBeUndefined(); // pre-v7
    // every synthetic underlying close stays above the VWAP (only the HOLD-anchored move can confirm a breach)
    expect(fx.underlyingBars.every((b) => b.close > 8995)).toBe(true);
  });

  it('the contract noise unit is in the spec range (N ≈ 4–7)', () => {
    const n = noiseFromBars(fx.contractBars.filter((b) => b.ts <= Date.parse('2026-10-14T11:01:00Z')))!.n;
    expect(n).toBeGreaterThan(4);
    expect(n).toBeLessThan(7);
  });

  it('breakAt pins the underlying and appends the breaking EXIT_NOW', () => {
    const b = buildSyntheticCrudeFixture({ breakAt: '16:45', breakTo: 8925 });
    expect(b.verdicts.at(-1)).toMatchObject({ id: 'v-break', verdict: 'EXIT_NOW', createdAt: '2026-10-14T11:15:00.000Z' });
    expect(b.verdicts.at(-1)!.packet).toMatchObject({ position: { underlyingLtp: { value: 8925 } } });
    expect(b.verdicts.some((v) => Date.parse(v.createdAt) > Date.parse('2026-10-14T11:15:00Z'))).toBe(false);
    expect(b.underlyingBars.at(-1)!.close).toBe(8925);
    expect(b.underlyingBars.filter((x) => x.ts >= Date.parse('2026-10-14T11:15:00Z')).every((x) => x.close === 8925)).toBe(true);
    expect(validateFixture(JSON.parse(JSON.stringify(b)))).toEqual(b);
  });

  it.each([
    ['wrong version', { ...fx, v: 2 }, /\bv\b/],
    ['no verdicts', { ...fx, verdicts: 'x' }, /verdicts/],
    ['bad side', { ...fx, meta: { ...fx.meta, side: 'BUY' } }, /meta\.side/],
    ['signed qty', { ...fx, meta: { ...fx.meta, qty: -100 } }, /meta\.qty/],
    ['bad bar', { ...fx, contractBars: [{ ...fx.contractBars[0], high: 'x' }] }, /contractBars\[0\]\.high/],
    ['verdicts out of order', { ...fx, verdicts: [...fx.verdicts].reverse() }, /oldest first/],
    // psql's json of a `timestamp without time zone` has no zone; Node would parse it as LOCAL time and the
    // replay would silently miss every bar (found on the real 2026-10-14 export).
    ['a zone-less verdict time', { ...fx, verdicts: [{ ...fx.verdicts[0], createdAt: '2026-10-14T10:13:40.194' }] }, /verdicts\[0\]\.createdAt.*time zone/],
    ['a zone-less entry time', { ...fx, meta: { ...fx.meta, entryAt: '2026-10-14T10:09:56.659' } }, /meta\.entryAt.*time zone/],
    ['not an object', null, /fixture/],
  ])('rejects %s, naming the field', (_l, bad, msg) => expect(() => validateFixture(bad)).toThrow(msg));

  it('accepts psql-style numeric strings and missing optionals', () => {
    const raw = JSON.parse(JSON.stringify(fx));
    raw.meta.qty = '100';
    delete raw.meta.maxLossPerTrade;
    raw.executions = [{ verdictId: 'v-1631', status: 'FILLED', createdAt: fx.meta.actualExit!.at }];
    const v = validateFixture(raw);
    expect(v.meta.qty).toBe(100);
    expect(v.meta.maxLossPerTrade).toBeNull();
    expect(v.executions[0]).toEqual({ verdictId: 'v-1631', status: 'FILLED', reason: null, createdAt: fx.meta.actualExit!.at, fillPrice: null, orderLtp: null });
  });
});
