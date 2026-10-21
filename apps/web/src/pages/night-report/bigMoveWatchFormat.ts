import type { BigMoveWatchRow, BigMoveWatchView, StockMoveReading } from '@/types/nightReport.types';

export const NO_SCORE = 'no stock-move score yet';

/** "p 0.71" — the calibrated P(|5-session move| > 1.5 × ATR). */
export function pText(r: StockMoveReading | null): string {
  return r && Number.isFinite(r.pBig) ? `p ${r.pBig.toFixed(2)}` : '—';
}

/** Badge tone: TOP20 (a big move is likely) stands out; MID / BOTTOM20 stay quiet. */
export function bucketVariant(bucket: string | null | undefined): 'warning' | 'neutral' {
  return bucket === 'TOP20' ? 'warning' : 'neutral';
}

/** "results 2026-10-24 · in window" / "results 2026-11-12" / null when no date is known. */
export function resultsText(r: StockMoveReading | null): string | null {
  if (!r?.resultsDate) return null;
  return `results ${r.resultsDate}${r.resultsInWindow ? ' · in window' : ''}`;
}

/** "last: BIG 350 bp (as of 2026-10-14)" / "last: small 90 bp …" / "no resolved call yet". */
export function outcomeText(o: BigMoveWatchRow['lastOutcome']): string {
  if (!o) return 'no resolved call yet';
  const bp = o.retBp != null && Number.isFinite(o.retBp) ? ` ${Math.round(o.retBp)} bp` : '';
  return `last: ${o.big ? 'BIG' : 'small'}${bp} (as of ${o.asOf})`;
}

const SOURCE_LABELS: Record<string, string> = { HELD: 'held', NEWS_IDEA: 'news idea', TOP: 'top of the day' };

export function sourcesText(sources: readonly string[]): string {
  return sources.map((s) => SOURCE_LABELS[s] ?? s.toLowerCase()).join(' · ');
}

/** The header line: book date, names scored, and that it is shadow. */
export function bookLine(v: BigMoveWatchView): string {
  if (!v.asOf) return `${NO_SCORE} (the nightly model has not written a book)`;
  return `Book ${v.asOf} · ${v.scored} names scored · shadow (0 scorecard points)`;
}
