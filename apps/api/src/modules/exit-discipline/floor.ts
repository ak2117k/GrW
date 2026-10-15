import type { NoiseFloor, PositionSide } from './types';

const r2 = (x: number) => Math.round(x * 100) / 100;

/** R4 / spec §4. Pure; the caller owns both latches (armed, previous level). */
export function noiseAwareFloor(i: {
  side: PositionSide; breakeven: number; peak: number | null; n: number;
  armN: number; trailN: number; prevArmedLevel: number | null; latchedArmed: boolean;
}): NoiseFloor {
  const dir = i.side === 'LONG' ? 1 : -1;
  const armPrice = r2(i.breakeven + dir * i.armN * i.n);
  const peak = i.peak !== null && Number.isFinite(i.peak) ? i.peak : null;
  const excursion = peak === null ? -Infinity : (peak - i.breakeven) * dir;
  const armed = i.latchedArmed || excursion >= i.armN * i.n - 1e-9;
  if (!armed) return { basis: 'noise', armed: false, level: armPrice, armPrice, n: i.n };
  const trail = peak === null ? i.breakeven : peak - dir * i.trailN * i.n;
  let level = dir > 0 ? Math.max(i.breakeven, trail) : Math.min(i.breakeven, trail);
  if (i.prevArmedLevel !== null && Number.isFinite(i.prevArmedLevel)) {
    level = dir > 0 ? Math.max(i.prevArmedLevel, level) : Math.min(i.prevArmedLevel, level);
  }
  return { basis: 'noise', armed: true, level: r2(level), armPrice, n: i.n };
}
