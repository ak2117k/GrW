/** Reader health (no silent absence) and the owner's market-note alert text. Pure. */

import { istMinutes, istYmd } from '../../market-cues/fetchers/ist-dates';
import type { Claim, ClaimBias } from './reading.types';

/** Look-back of the dead-reader check. */
export const HEALTH_WINDOW_MS = 15 * 60_000;
/** Posts in the window that must have produced at least one READ. */
export const HEALTH_MIN_POSTS = 3;
const OPEN_MIN = 9 * 60 + 15;
const CLOSE_MIN = 15 * 60 + 30;
const ALERT_BIASES: ReadonlySet<ClaimBias> = new Set<ClaimBias>(['CAUTION', 'BEAR', 'BULL']);

const pad = (n: number) => String(n).padStart(2, '0');

function istHhMm(at: Date): string {
  const min = istMinutes(at);
  return `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
}

/** Posts kept arriving during market hours and the reader produced no READ row. */
export function readerUnhealthy(c: { posts15m: number; read15m: number; marketOpen: boolean }): boolean {
  return c.marketOpen && c.posts15m >= HEALTH_MIN_POSTS && c.read15m === 0;
}

/** 09:15–15:30 IST, both ends included (the trading-day check is the caller's). */
export function withinReaderWindow(now: Date): boolean {
  const min = istMinutes(now);
  return min >= OPEN_MIN && min <= CLOSE_MIN;
}

/** The ops alert for a dead reader; a last read from an earlier day carries its date. */
export function deadReaderText(c: { posts15m: number; lastReadAt: Date | null; lastError: string | null }, now: Date): string {
  const last = c.lastReadAt
    ? `${istYmd(c.lastReadAt) === istYmd(now) ? '' : `${istYmd(c.lastReadAt)} `}${istHhMm(c.lastReadAt)} IST`
    : 'never';
  return `message-reader: posts ${c.posts15m}, read 0 in 15 min; last read ${last}; last error ${c.lastError?.trim() || 'none'}`;
}

/** Market-wide (subject MARKET) claims the live data CONFIRMED, with a CAUTION / BEAR / BULL bias. */
export function marketNoteClaims(claims: readonly Claim[]): Claim[] {
  return claims.filter((c) => c.subject === 'MARKET' && c.verdict === 'CONFIRMED' && ALERT_BIASES.has(c.bias));
}

/** One line per claim: `<channel> HH:MM — <claim> → CONFIRMED (<fact value>, …)`; HH:MM is the post time in IST. */
export function marketNoteText(channelTitle: string, postedAt: Date, claims: readonly Claim[]): string {
  const at = istHhMm(postedAt);
  return claims
    .map((c) => `${channelTitle} ${at} — ${c.text} → CONFIRMED (${c.evidence.map((e) => `${e.fact} ${e.value}`).join(', ')})`)
    .join('\n');
}
