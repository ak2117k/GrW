/** Pure formatting helpers for the AI news panels (kept React-free for tests). */

import type { AiDirection } from '@/services/newsAi';

export type DirKey = 'bull' | 'bear' | 'mixed' | 'neutral';

/** The server's direction enum (BULL | BEAR | NEUTRAL | MIXED) as a display bucket; anything else reads neutral. */
export function dirKey(direction: AiDirection | null | undefined): DirKey {
  switch (direction) {
    case 'BULL':
      return 'bull';
    case 'BEAR':
      return 'bear';
    case 'MIXED':
      return 'mixed';
    default:
      return 'neutral';
  }
}

export const DIR_LABEL: Record<DirKey, string> = {
  bull: 'Bullish',
  bear: 'Bearish',
  mixed: 'Mixed',
  neutral: 'Neutral',
};

/** Chip colours, same palette as SentimentBadge (emerald / red / gray) + amber for mixed. */
export const DIR_CHIP: Record<DirKey, string> = {
  bull: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  bear: 'bg-red-500/15 text-red-400 border-red-500/30',
  mixed: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
  neutral: 'bg-gray-500/15 text-gray-400 border-gray-500/30',
};

export const DIR_TEXT: Record<DirKey, string> = {
  bull: 'text-emerald-400',
  bear: 'text-red-400',
  mixed: 'text-amber-400',
  neutral: 'text-gray-400',
};

export const DIR_BAR: Record<DirKey, string> = {
  bull: 'bg-emerald-400',
  bear: 'bg-red-400',
  mixed: 'bg-amber-400',
  neutral: 'bg-gray-400',
};

/** Clamp/round a -100..+100 sentiment score (the service already normalises the scale). */
export function scoreTo100(score: number | null | undefined): number {
  if (typeof score !== 'number' || !Number.isFinite(score)) return 0;
  return Math.max(-100, Math.min(100, Math.round(score)));
}

/** Same band as the server's sentiment-overview label (|score| < 15 reads NEUTRAL). */
export const SCORE_NEUTRAL_BAND = 15;

export function scoreLabel(score: number | null | undefined): string {
  const v = scoreTo100(score);
  if (v === 0) return '0';
  return v > 0 ? `+${v}` : `−${Math.abs(v)}`;
}

export function scoreDir(score: number | null | undefined): DirKey {
  const v = scoreTo100(score);
  if (v >= SCORE_NEUTRAL_BAND) return 'bull';
  if (v <= -SCORE_NEUTRAL_BAND) return 'bear';
  return 'neutral';
}

/** A 0..100 strength / importance as the server sends it, clamped and rounded. */
export function pct100(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0;
}

export function strengthLabel(strength: number): string {
  return `${pct100(strength)}/100`;
}

export function ageLabel(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return 'unknown';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return 'unknown';
  const min = Math.floor((now.getTime() - t) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function clockIst(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  return d.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** A brief older than this is shown as stale. */
export const BRIEF_STALE_MS = 3 * 60 * 60 * 1000;

export function isStale(iso: string | null | undefined, now: Date = new Date()): boolean {
  if (!iso) return true;
  const t = new Date(iso).getTime();
  return !Number.isFinite(t) || now.getTime() - t > BRIEF_STALE_MS;
}

/** DOM id of a news card, used by brief story links to scroll to it. */
export const newsCardDomId = (articleId: string) => `news-card-${articleId}`;

/**
 * Which ids still need a read request: never asked, or asked longer than
 * `retryMs` ago and still without a read (the server analyses async).
 */
export function idsToFetch(
  ids: string[],
  haveRead: (id: string) => boolean,
  requestedAt: Map<string, number>,
  now: number,
  retryMs: number,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (haveRead(id)) continue;
    const at = requestedAt.get(id);
    if (at === undefined || now - at >= retryMs) out.push(id);
  }
  return out;
}

export function chunk<T>(xs: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}
