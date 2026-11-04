import { SPIKE_BANK_RISE_N, SPIKE_BANK_TRAIL_N, SPIKE_BANK_WINDOW_MIN, type ExitDisciplineConfig } from '../../exit-discipline/config';
import { spikeBankReading } from '../../exit-discipline/spike';
import type { MinuteBar, NoiseOpinion } from '../../exit-discipline/types';
import type { Side } from '../charges';

/**
 * `money.spike` (SPIKE BANK, exit-discipline/spike.ts). A `type` so it stays assignable to Prisma JSON.
 *  - latched: a fast new best was seen at this entry; the noise floor now trails by `trailN` (1 N).
 *  - at / from / to / riseN / n: the jump that latched it (window worst → new best, in contract N).
 *  - trailN: the trail in force; needRiseN / windowMin: the rule's thresholds.
 */
export type PacketSpike = {
  latched: boolean;
  at: string | null;
  from: number | null;
  to: number | null;
  riseN: number | null;
  n: number | null;
  trailN: number;
  needRiseN: number;
  windowMin: number;
};

type Latch = { at: string | null; from: number | null; to: number | null; riseN: number | null; n: number | null };
/** In-process memory, keyed to the entry it was taken against (a re-entry starts afresh). */
export type SpikeMemory = { entry: number | null; latch: Latch | null; prevBest: number | null; samples: Array<{ t: number; px: number }> };
export const EMPTY_SPIKE: SpikeMemory = { entry: null, latch: null, prevBest: null, samples: [] };

const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const WINDOW_MS = SPIKE_BANK_WINDOW_MIN * 60_000;
const r2 = (x: number) => Math.round(x * 100) / 100;

/**
 * The durable half of the latch (the same rule as `storedNoiseFloor`): a latched `money.spike` in the
 * last live packet at the same entry price. A restart therefore keeps the 1 N trail; the floor level
 * itself is restored from money.greenFloorPrice as before.
 */
export function storedSpike(last: { packet?: unknown } | undefined | null, entryPrice: number): Latch | null {
  const p = last?.packet as { position?: { entryPrice?: unknown }; money?: { spike?: Record<string, unknown> } } | undefined;
  const s = p && typeof p === 'object' ? p.money?.spike : undefined;
  if (!p || typeof p !== 'object' || p.position?.entryPrice !== entryPrice || !s || s.latched !== true) return null;
  const n = (x: unknown) => (fin(x) ? x : null);
  return { at: typeof s.at === 'string' ? s.at : null, from: n(s.from), to: n(s.to), riseN: n(s.riseN), n: n(s.n) };
}

/**
 * The cycle's spike bank: in-process memory (the previous best, the trailing window's pass prices) + the
 * last live packet (the latch). The window's worst premium is the worst of this window's pass prices and
 * of the contract's stored 1-minute bars that overlap it (lows for a long, highs for a short) — a dip
 * printed between two 30-s passes still counts. Pure; the caller owns the memory.
 * Off (discipline off, the hard floor off, or FLOOR_SPIKE_BANK=false) ⇒ no block and floorTrailN.
 */
export function solveCycleSpike(i: {
  cfg: ExitDisciplineConfig; side: Side; entryPrice: number; ltp: number; peak: number | null; nContract: number | null;
  bars: MinuteBar[] | null | undefined; now: Date; memory: SpikeMemory; last: { packet?: unknown } | undefined;
  /** The decision point's noise opinion (exit-discipline/spike.ts). Nothing supplies one today. */
  noise?: NoiseOpinion | null;
}): { block: PacketSpike | null; trailN: number; memory: SpikeMemory } {
  const on = i.cfg.enabled && i.cfg.floorHardExit && i.cfg.spikeBank;
  if (!on) return { block: null, trailN: i.cfg.floorTrailN, memory: EMPTY_SPIKE };
  const dir = i.side === 'LONG' ? 1 : -1;
  const t = i.now.getTime();
  const mem: SpikeMemory = i.memory.entry === i.entryPrice ? i.memory : { ...EMPTY_SPIKE, entry: i.entryPrice };

  const seen = [i.peak, i.ltp].filter((x): x is number => fin(x) && x > 0);
  const best = seen.length === 0 ? null : dir > 0 ? Math.max(...seen) : Math.min(...seen);
  const samples = [...mem.samples.filter((s) => s.t >= t - WINDOW_MS && s.t < t), ...(fin(i.ltp) && i.ltp > 0 ? [{ t, px: i.ltp }] : [])];
  const barPx = (i.bars ?? [])
    .filter((b) => b.ts + 60_000 > t - WINDOW_MS && b.ts <= t)
    .map((b) => (dir > 0 ? b.low : b.high))
    .filter((x) => fin(x) && x > 0);
  const all = [...samples.map((s) => s.px), ...barPx];
  const windowWorst = all.length === 0 ? null : dir > 0 ? Math.min(...all) : Math.max(...all);

  let latch = mem.latch ?? storedSpike(i.last, i.entryPrice);
  if (!latch) {
    const r = spikeBankReading({ side: i.side, prevBest: mem.prevBest, best, windowWorst, n: i.nContract, riseN: SPIKE_BANK_RISE_N, noise: i.noise ?? null });
    if (r.spike && best !== null && windowWorst !== null && fin(i.nContract)) {
      latch = { at: i.now.toISOString(), from: windowWorst, to: best, riseN: r.riseInN, n: r2(i.nContract) };
    }
  }
  // The previous best only ever moves to a better price (a missing read never resets it).
  const prevBest = best === null ? mem.prevBest : mem.prevBest === null ? best : dir > 0 ? Math.max(mem.prevBest, best) : Math.min(mem.prevBest, best);
  const trailN = latch ? Math.min(SPIKE_BANK_TRAIL_N, i.cfg.floorTrailN) : i.cfg.floorTrailN;
  const block: PacketSpike = {
    latched: latch !== null,
    at: latch?.at ?? null,
    from: latch?.from ?? null,
    to: latch?.to ?? null,
    riseN: latch?.riseN ?? null,
    n: latch?.n ?? null,
    trailN,
    needRiseN: SPIKE_BANK_RISE_N,
    windowMin: SPIKE_BANK_WINDOW_MIN,
  };
  return { block, trailN, memory: { entry: i.entryPrice, latch, prevBest, samples } };
}
