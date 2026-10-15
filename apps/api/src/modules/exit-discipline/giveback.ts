import type { PositionSide } from './types';

/** Spec §5: fires only when the excursion >= armN·N AND the pullback from the peak >= givebackN·N. */
export function noiseGiveback(i: {
  side: PositionSide; entryPrice: number; ltp: number; peak: number | null; n: number; armN: number; givebackN: number;
}): { fire: boolean; excursion: number; pullback: number } | null {
  if (i.peak === null || ![i.peak, i.ltp, i.entryPrice, i.n].every(Number.isFinite) || i.n <= 0) return null;
  const dir = i.side === 'LONG' ? 1 : -1;
  const excursion = (i.peak - i.entryPrice) * dir;
  const pullback = (i.peak - i.ltp) * dir;
  return { fire: excursion >= i.armN * i.n && pullback >= i.givebackN * i.n, excursion, pullback };
}
