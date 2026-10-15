import { parseExitDisciplineConfig } from '../../exit-discipline/config';
import { solveCycleFloor, storedNoiseFloor } from './cycle-floor';

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
  it('SHORT reads holdingLow as the peak', () => {
    const r = solveCycleFloor({ ...BASE, side: 'SHORT', entryPrice: 100, holdingHigh: 103, holdingLow: 94, nContract: 2 });
    expect(r.noiseFloor).toMatchObject({ armed: true });
    expect(r.noiseFloor!.level).toBeLessThan(100);
  });
});
