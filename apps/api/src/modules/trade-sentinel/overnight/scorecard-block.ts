import type { Scorecard } from '../../overnight-scorecard/scorecard.types';
import { present, type Block } from '../services/context-packet.service';

/**
 * The compact `overnight.scorecard` block: the total, band and side, plus one
 * line of factors — `name:points value` each, `name:n/a` when the factor had
 * no data. The serialised value is held to SCORECARD_BLOCK_MAX_CHARS: factor
 * values are shortened first, then dropped, and only then is the line cut.
 */
export type ScorecardBrief = {
  side: Scorecard['side'];
  total: number;
  band: Scorecard['band'];
  window: Scorecard['window'];
  computedAt: string;
  factors: string;
};

export const SCORECARD_BLOCK_MAX_CHARS = 400;
export const SCORECARD_BLOCK_SOURCE = 'overnight-scorecard (deterministic, no LLM)';

const signed = (n: number) => (n > 0 ? `+${n}` : String(n));

function clip(s: string, max: number): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, Math.max(0, max - 1))}…`;
}

function factorLine(sc: Scorecard, valueMax: number): string {
  return sc.factors
    .map((f) => {
      if (!f.available) return `${f.name}:n/a`;
      const head = `${f.name}:${signed(f.points)}`;
      const value = valueMax > 0 ? clip(f.value, valueMax) : '';
      return value ? `${head} ${value}` : head;
    })
    .join('; ');
}

export function scorecardBrief(sc: Scorecard): ScorecardBrief {
  const base = { side: sc.side, total: sc.total, band: sc.band, window: sc.window, computedAt: sc.computedAt };
  const size = (factors: string) => JSON.stringify({ ...base, factors }).length;
  for (const valueMax of [60, 45, 32, 24, 16, 10, 0]) {
    const factors = factorLine(sc, valueMax);
    if (size(factors) <= SCORECARD_BLOCK_MAX_CHARS) return { ...base, factors };
  }
  // Still too long (an unusually large factor list): cut the line itself.
  const room = Math.max(1, SCORECARD_BLOCK_MAX_CHARS - size('') - 2);
  return { ...base, factors: clip(factorLine(sc, 0), room) };
}

export function scorecardBlock(sc: Scorecard): Block<ScorecardBrief> {
  return present(scorecardBrief(sc), SCORECARD_BLOCK_SOURCE, sc.computedAt);
}
