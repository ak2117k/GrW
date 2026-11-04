import { parseExitDisciplineConfig } from '../../exit-discipline/config';
import { floorNoiseUnit, solveCycleFloor, storedNoiseFloor } from './cycle-floor';

const CFG = parseExitDisciplineConfig({});
const BASE = { cfg: CFG, segment: 'OPT' as const, side: 'LONG' as const, entryPrice: 521.9, qty: 100,
  holdingHigh: 539.5, holdingLow: 518, nContract: 4.5, memory: { armed: false, level: null, entry: null }, last: undefined };

describe('storedNoiseFloor (durable half of the latch)', () => {
  it('reads an armed noise floor from the last live packet with the same entry', () => {
    const last = { packet: { position: { entryPrice: 521.9 }, money: { floorBasis: 'noise', greenFloorArmed: true, greenFloorPrice: 531 } } };
    expect(storedNoiseFloor(last, 521.9)).toEqual({ armed: true, level: 531 });
  });
  it.each([
    ['a fixed-basis packet', { position: { entryPrice: 521.9 }, money: { floorBasis: 'fixed', greenFloorArmed: true, greenFloorPrice: 524.85 } }],
    ['another entry price', { position: { entryPrice: 500 }, money: { floorBasis: 'noise', greenFloorArmed: true, greenFloorPrice: 531 } }],
    ['garbage', 'x'],
  ])('%s is no evidence', (_l, packet) => expect(storedNoiseFloor({ packet }, 521.9)).toEqual({ armed: false, level: null }));
});

describe('solveCycleFloor', () => {
  it('discipline off or N unknown ⇒ no noise floor (the fixed floor stays in charge), memory cleared', () => {
    expect(solveCycleFloor({ ...BASE, cfg: parseExitDisciplineConfig({ EXIT_DISCIPLINE_ENABLED: 'false' }) }).noiseFloor).toBeNull();
    expect(solveCycleFloor({ ...BASE, nContract: null })).toEqual({ noiseFloor: null, memory: { armed: false, level: null, entry: null } });
  });
  it('arms off the peak and trails it; memory keeps the armed level', () => {
    const r = solveCycleFloor(BASE);
    expect(r.noiseFloor).toMatchObject({ basis: 'noise', armed: true });
    expect(r.noiseFloor!.level).toBeCloseTo(539.5 - 9, 2);
    expect(r.memory).toEqual({ armed: true, level: r.noiseFloor!.level, entry: 521.9 });
  });
  it('tighten-only across ticks: a larger N later never lowers the level', () => {
    const first = solveCycleFloor(BASE);
    const later = solveCycleFloor({ ...BASE, nContract: 6, memory: first.memory });
    expect(later.noiseFloor!.level).toBe(first.noiseFloor!.level);
  });
  it('restart: the stored packet re-arms the latch', () => {
    const last = { packet: { position: { entryPrice: 521.9 }, money: { floorBasis: 'noise', greenFloorArmed: true, greenFloorPrice: 533 } } };
    expect(solveCycleFloor({ ...BASE, holdingHigh: 530, last }).noiseFloor).toMatchObject({ armed: true, level: 533 });
  });
  it('a changed entry price voids the memory', () => {
    const r = solveCycleFloor({ ...BASE, holdingHigh: 527, memory: { armed: true, level: 531, entry: 500 } });
    expect(r.noiseFloor).toMatchObject({ armed: false });
  });
  it('SPIKE BANK: a 1 N trail (cycle-spike.ts) trails the peak by 1 N; tighten-only keeps it when the latch arrives later', () => {
    const r = solveCycleFloor({ ...BASE, trailN: 1 });
    expect(r.noiseFloor!.level).toBeCloseTo(539.5 - 4.5, 2);
    const first = solveCycleFloor(BASE);
    const tightened = solveCycleFloor({ ...BASE, trailN: 1, memory: first.memory });
    expect(tightened.noiseFloor!.level).toBeGreaterThan(first.noiseFloor!.level);
    expect(solveCycleFloor({ ...BASE, trailN: 0 }).noiseFloor!.level).toBeCloseTo(539.5 - 9, 2);
  });

  it('SHORT reads holdingLow as the peak', () => {
    const r = solveCycleFloor({ ...BASE, side: 'SHORT', entryPrice: 100, holdingHigh: 103, holdingLow: 94, nContract: 2 });
    expect(r.noiseFloor).toMatchObject({ armed: true });
    expect(r.noiseFloor!.level).toBeLessThan(100);
  });
});

describe('floorNoiseUnit (2026-11-04 CRUDEOIL 8600 PE: no fixed ₹150 floor before the contract unit exists)', () => {
  it('the contract unit wins when measured', () => {
    expect(floorNoiseUnit(4.5, 13.5, 'CRUDEOIL17NOV268600PE')).toEqual({ n: 4.5, source: 'contract' });
  });
  it('unmeasured contract ⇒ the underlying unit × 0.5 for an option, × 1 otherwise', () => {
    expect(floorNoiseUnit(null, 13.5, 'CRUDEOIL17NOV268600PE')).toEqual({ n: 6.75, source: 'underlying-stand-in' });
    expect(floorNoiseUnit(undefined, 13.5, 'CRUDEOIL19NOV26FUT')).toEqual({ n: 13.5, source: 'underlying-stand-in' });
  });
  it('neither known ⇒ null (the fixed basis, as before)', () => {
    expect(floorNoiseUnit(null, null, 'CRUDEOIL17NOV268600PE')).toEqual({ n: null, source: 'none' });
  });
  it('the 18:05 entry 246.84 (qty 100) does not arm on the 18:06–18:08 blip to ~250', () => {
    const r = solveCycleFloor({ ...BASE, entryPrice: 246.84, holdingHigh: 250.5, holdingLow: 246.5, valueFactor: 1,
      nContract: floorNoiseUnit(null, 13.5, 'CRUDEOIL17NOV268600PE').n });
    expect(r.noiseFloor).not.toBeNull();
    expect(r.noiseFloor!.armed).toBe(false);
  });
});
