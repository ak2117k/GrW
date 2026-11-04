import { parseExitDisciplineConfig } from '../../exit-discipline/config';
import type { MinuteBar } from '../../exit-discipline/types';
import { EMPTY_SPIKE, solveCycleSpike, storedSpike, type SpikeMemory } from './cycle-spike';

const CFG = parseExitDisciplineConfig({});
const T = (hhmmss: string) => new Date(`2026-11-04T${hhmmss}+05:30`);
const bar = (hhmm: string, low: number, high: number): MinuteBar => ({ ts: T(`${hhmm}:00`).getTime(), open: low, high, low, close: high });
/** NIFTY09NOV2623650PE, prod 2026-11-04: the 1-minute lows / highs from candles_1m. */
const BARS = [bar('12:12', 138, 144.55), bar('12:13', 140.8, 147.95), bar('12:14', 142.55, 147), bar('12:15', 146.05, 158.2)];
const BASE = { cfg: CFG, side: 'LONG' as const, entryPrice: 136.8, nContract: 5.4, bars: BARS, last: undefined };
type Extra = Partial<Parameters<typeof solveCycleSpike>[0]>;

/** Walks the cycle's passes; returns the last result. */
function walk(steps: Array<{ at: string; ltp: number; peak: number }>, extra: Extra = {}, mem: SpikeMemory = EMPTY_SPIKE) {
  let r = solveCycleSpike({ ...BASE, ...extra, ltp: steps[0].ltp, peak: steps[0].peak, now: T(steps[0].at), memory: mem });
  for (const s of steps.slice(1)) r = solveCycleSpike({ ...BASE, ...extra, ltp: s.ltp, peak: s.peak, now: T(s.at), memory: r.memory });
  return r;
}

describe('solveCycleSpike (SPIKE_BANK, 2026-11-04)', () => {
  const PASSES = [
    { at: '12:13:00', ltp: 141.6, peak: 142.35 },
    { at: '12:14:00', ltp: 143.5, peak: 147.95 },
    { at: '12:15:30', ltp: 152, peak: 152 },
    { at: '12:16:00', ltp: 155.45, peak: 155.45 },
  ];

  it('regression 2026-11-04 23650 PE: a new best 14 points over the 3-minute low (2.6 N) latches the 1 N trail', () => {
    const r = walk(PASSES);
    expect(r.trailN).toBe(1);
    expect(r.block).toMatchObject({ latched: true, from: 138, to: 152, riseN: 2.59, n: 5.4, trailN: 1, needRiseN: 2.5, windowMin: 3 });
  });

  it('a slow climb (the same rise over more than three minutes) does not latch', () => {
    const slow = [
      { at: '12:00:00', ltp: 138, peak: 142.35 },
      { at: '12:04:00', ltp: 143, peak: 143 },
      { at: '12:08:00', ltp: 148, peak: 148 },
      { at: '12:12:00', ltp: 152, peak: 152 },
    ];
    expect(walk(slow, { bars: [] })).toMatchObject({ trailN: 2, block: { latched: false, trailN: 2 } });
  });

  it('the latch holds after the premium falls back (a latch, not a reading)', () => {
    const r = walk([...PASSES, { at: '12:17:00', ltp: 141, peak: 155.45 }, { at: '12:25:00', ltp: 139, peak: 155.45 }]);
    expect(r).toMatchObject({ trailN: 1, block: { latched: true } });
  });

  it("restart: the last packet's latched money.spike at the same entry keeps the 1 N trail", () => {
    const last = { packet: { position: { entryPrice: 136.8 }, money: { spike: { latched: true, at: '2026-11-04T06:46:00.000Z', from: 141.7, to: 152, riseN: 1.9, n: 5.4 } } } };
    const r = solveCycleSpike({ ...BASE, ltp: 145, peak: 155.45, now: T('12:18:00'), memory: EMPTY_SPIKE, last });
    expect(r).toMatchObject({ trailN: 1, block: { latched: true, from: 141.7 } });
    expect(storedSpike({ packet: { ...last.packet, position: { entryPrice: 140 } } }, 136.8)).toBeNull();
    expect(storedSpike({ packet: { position: { entryPrice: 136.8 }, money: { spike: { latched: false } } } }, 136.8)).toBeNull();
    expect(storedSpike({ packet: 'x' }, 136.8)).toBeNull();
  });

  it('a changed entry price voids the memory', () => {
    const r = walk(PASSES);
    const next = solveCycleSpike({ ...BASE, entryPrice: 150, ltp: 151, peak: 151, now: T('12:17:00'), memory: r.memory });
    expect(next.block!.latched).toBe(false);
  });

  it('off (FLOOR_SPIKE_BANK=false, or the hard floor off): no block, floorTrailN', () => {
    for (const env of [{ FLOOR_SPIKE_BANK: 'false' }, { FLOOR_HARD_EXIT: 'false' }]) {
      expect(walk(PASSES, { cfg: parseExitDisciplineConfig(env) })).toMatchObject({ block: null, trailN: 2 });
    }
  });

  it('unknown N never latches', () => {
    expect(walk(PASSES, { nContract: null }).block!.latched).toBe(false);
  });

  it('a REAL noise opinion vetoes the tightening; NOISE keeps the rule', () => {
    expect(walk(PASSES, { noise: { verdict: 'REAL', source: 'test' } }).trailN).toBe(2);
    expect(walk(PASSES, { noise: { verdict: 'NOISE', source: 'test' } }).trailN).toBe(1);
  });
});
