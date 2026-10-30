/**
 * Scoring a stored noise read (noise-read.ts) against what the underlying did in the 30 minutes after
 * the exit (filled by ExitNoiseFollowCron). Pure.
 *  - NOISE is RIGHT when the underlying recovered in the position's favour past its exit-time price by
 *    ≥ {@link NOISE_SCORE.minMoveN} N within 30 min (the exit was premature); WRONG otherwise.
 *  - REAL is RIGHT when it kept going against the position by ≥ 1 N within 30 min; WRONG otherwise.
 *  - MIXED / NO_DATA, a read not yet followed, or one without N are not scored (null).
 * "Within 30 min" is the excursion over the 30 one-minute bars (high / low) when the follow-up has it,
 * else the 15- and 30-minute closes.
 */
import type { NoiseVerdict, Want } from './noise-read';

export const NOISE_SCORE = Object.freeze({
  /** The recovery (NOISE) or continuation (REAL) that makes a read RIGHT, in the underlying's N. */
  minMoveN: 1,
  /** Under this many scored reads of a verdict the review says "insufficient sample". */
  minSample: 10,
});

export type ReadScore = 'RIGHT' | 'WRONG';

export interface ScorableRead {
  verdict: NoiseVerdict;
  want: Want;
  underlyingAtExit: number | null;
  n: number | null;
  after15m: number | null;
  after30m: number | null;
  /** Best excursion in the position's favour / against it over the 30 min, in underlying points (≥ 0). */
  maxFavour30m: number | null;
  maxAgainst30m: number | null;
}

const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const r2 = (x: number) => Math.round(x * 100) / 100;

/** + = in the position's favour, from the exit-time underlying. */
const favour = (want: Want, exit: number, later: number) => (want === 'BULLISH' ? later - exit : exit - later);

export function scoreNoiseRead(r: ScorableRead): { score: ReadScore | null; favourN: number | null; againstN: number | null } {
  const blank = { score: null, favourN: null, againstN: null };
  if (!fin(r.underlyingAtExit) || !fin(r.n) || !(r.n > 0)) return blank;
  const closes = [r.after15m, r.after30m].filter(fin).map((x) => favour(r.want, r.underlyingAtExit as number, x));
  const fav = fin(r.maxFavour30m) ? r.maxFavour30m : closes.length ? Math.max(0, ...closes) : null;
  const adv = fin(r.maxAgainst30m) ? r.maxAgainst30m : closes.length ? Math.max(0, ...closes.map((c) => -c)) : null;
  if (fav === null || adv === null) return blank;
  const favourN = r2(fav / r.n);
  const againstN = r2(adv / r.n);
  if (r.verdict === 'NOISE') return { score: favourN >= NOISE_SCORE.minMoveN ? 'RIGHT' : 'WRONG', favourN, againstN };
  if (r.verdict === 'REAL') return { score: againstN >= NOISE_SCORE.minMoveN ? 'RIGHT' : 'WRONG', favourN, againstN };
  return { score: null, favourN, againstN };
}

export interface NoiseReadStats {
  reads: number;
  byVerdict: Record<NoiseVerdict, number>;
  /** NOISE / REAL reads scored RIGHT or WRONG. */
  scored: number;
  /** NOISE / REAL reads not scored yet (no follow-up, or no N). */
  pending: number;
  noise: { scored: number; right: number };
  real: { scored: number; right: number };
}

export function noiseReadStats(rows: ReadonlyArray<{ verdict: NoiseVerdict; score: ReadScore | null }>): NoiseReadStats {
  const byVerdict: Record<NoiseVerdict, number> = { NOISE: 0, REAL: 0, MIXED: 0, NO_DATA: 0 };
  const noise = { scored: 0, right: 0 };
  const real = { scored: 0, right: 0 };
  let pending = 0;
  for (const r of rows) {
    byVerdict[r.verdict] += 1;
    if (r.verdict !== 'NOISE' && r.verdict !== 'REAL') continue;
    if (r.score === null) {
      pending += 1;
      continue;
    }
    const b = r.verdict === 'NOISE' ? noise : real;
    b.scored += 1;
    if (r.score === 'RIGHT') b.right += 1;
  }
  return { reads: rows.length, byVerdict, scored: noise.scored + real.scored, pending, noise, real };
}
