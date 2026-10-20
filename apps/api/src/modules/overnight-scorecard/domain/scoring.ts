import type { Band, FactorName, FactorScore, Scorecard, ScoreWindow } from '../scorecard.types';

/** The design's §2 bands: ≤ −4 · −3…−1 · 0 · 1…3 · ≥ 4. */
export function bandOf(total: number): Band {
  if (total <= -4) return 'STRONG_AGAINST';
  if (total < 0) return 'AGAINST';
  if (total === 0) return 'NEUTRAL';
  if (total < 4) return 'SUPPORTS';
  return 'STRONG_SUPPORTS';
}

/** Round and clamp a raw vote into the −2…+2 points scale. */
export function clampPoints(raw: number): FactorScore['points'] {
  if (!Number.isFinite(raw)) return 0;
  const r = Math.round(raw);
  return (r > 2 ? 2 : r < -2 ? -2 : r === 0 ? 0 : r) as FactorScore['points'];
}

export type Side = 'BULLISH' | 'BEARISH';

/** A MARKET-direction vote (+ bullish) turned into a vote for the position's side. */
export function orient(marketVote: number, side: Side): FactorScore['points'] {
  return clampPoints(side === 'BULLISH' ? marketVote : -marketVote);
}

/** A factor whose data was missing: 0 points, and the reason names what was missing. */
export function unavailable(name: FactorName, missing: string): FactorScore {
  return { name, points: 0, value: 'n/a', reason: `unavailable: ${missing}`, available: false };
}

export function factor(name: FactorName, points: number, value: string, reason: string): FactorScore {
  return { name, points: clampPoints(points), value, reason, available: true };
}

export const FACTOR_ORDER: readonly FactorName[] = ['oi', 'fii_dii', 'vix', 'expiry', 'news', 'indicators', 'mood'];

export function assemble(input: {
  userId: string | null;
  symbol: string;
  exchange: string;
  underlying: string;
  side: Side;
  window: ScoreWindow;
  computedAt: Date;
  factors: FactorScore[];
}): Scorecard {
  const byName = new Map(input.factors.map((f) => [f.name, f]));
  const factors = FACTOR_ORDER.map((n) => byName.get(n) ?? unavailable(n, 'not computed'));
  const total = factors.reduce((s, f) => s + (f.available ? f.points : 0), 0);
  return {
    userId: input.userId,
    symbol: input.symbol,
    exchange: input.exchange,
    underlying: input.underlying,
    side: input.side,
    window: input.window,
    computedAt: input.computedAt.toISOString(),
    factors,
    total,
    band: bandOf(total),
  };
}

/** Compact one-line form, e.g. "oi:+2 PCR 2.1… | vix:-1 …" (≤ `max` chars). */
export function compactScorecard(sc: Scorecard, max = 400): string {
  const sign = (p: number) => (p > 0 ? `+${p}` : `${p}`);
  const body = sc.factors
    .map((f) => (f.available ? `${f.name}:${sign(f.points)} ${f.value}` : `${f.name}:n/a`))
    .join(' | ');
  const line = `total ${sign(sc.total)} ${sc.band} | ${body}`;
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
