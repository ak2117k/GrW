import { Link } from 'react-router-dom';
import type { DailyComparison } from '../../types/ungatedWatch.types';

export type StripTone = 'emerald' | 'red' | 'grey';

export interface StripState {
  hidden: boolean;
  tone: StripTone;
  edgeText: string;
}

export function computeStripState(c: DailyComparison): StripState {
  if (c.ungated.tradeCount === 0) return { hidden: true, tone: 'grey', edgeText: '' };
  // Compute diff from the actual net figures — gated.net > ungated.net means
  // the gate added value (positive diff → emerald).
  const diff = c.gated.net - c.ungated.net;
  const tone: StripTone =
    Math.abs(diff) < 100 ? 'grey' : diff > 0 ? 'emerald' : 'red';
  const sign = diff >= 0 ? '+' : '−';
  return { hidden: false, tone, edgeText: `EDGE ${sign}₹${Math.abs(diff).toFixed(0)}` };
}

const TONE_CLASS: Record<StripTone, string> = {
  emerald: 'text-emerald-400',
  red: 'text-red-400',
  grey: 'text-[var(--color-text-secondary)]',
};

export function ComparisonStrip({ data, date }: { data: DailyComparison; date: string }) {
  const s = computeStripState(data);
  if (s.hidden) return null;
  return (
    <Link
      to={`/ungated-watch?date=${date}`}
      className="mb-3 flex flex-wrap items-baseline gap-x-6 gap-y-1 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-tertiary)]/40 px-3 py-2 text-sm hover:bg-[var(--color-bg-tertiary)]/60 transition-colors"
      title={data.edge.verdict}
    >
      <span className="text-[10px] uppercase tracking-wider text-amber-300">A/B</span>
      <span><span className="text-[var(--color-text-muted)]">Gated </span>{data.gated.net >= 0 ? '+' : '−'}₹{Math.abs(data.gated.net).toFixed(0)} · {data.gated.tradeCount}t</span>
      <span><span className="text-[var(--color-text-muted)]">Ungated </span>{data.ungated.net >= 0 ? '+' : '−'}₹{Math.abs(data.ungated.net).toFixed(0)} · {data.ungated.tradeCount}t</span>
      <span className={`font-semibold ${TONE_CLASS[s.tone]}`}>{s.edgeText}</span>
    </Link>
  );
}
