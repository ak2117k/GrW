/** Which of today's checked channel claims the signal judge should see for one call. Pure. */

import { istMinutes, istYmd } from '../../market-cues/fetchers/ist-dates';
import { Claim, ClaimBias, Evidence, ReadScope } from './reading.types';

export interface ReadingRow {
  messageId: string;
  channelId: string;
  channelTitle: string;
  postedAt: Date;
  scope: ReadScope;
  claims: Claim[];
  summary: string | null;
}

export interface VerifiedNote {
  channel: string;
  /** HH:MM IST of the post. */
  at: string;
  scope: ReadScope;
  subject: string;
  claim: string;
  bias: ClaimBias;
  verdict: 'CONFIRMED' | 'CONTRADICTED';
  evidence: Evidence[];
}

const MAX_NOTES = 10;

const pad = (n: number) => String(n).padStart(2, '0');

function istHhMm(at: Date): string {
  const min = istMinutes(at);
  return `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
}

/**
 * Relevance by the CLAIM's subject (MARKET, the call's underlying, the call's sector), not the row's scope:
 * a MARKET-scope post can carry an instrument claim and vice versa. Agrees with the owner alert's
 * `subject === 'MARKET'` (reader-health marketNoteClaims).
 */
function relevant(subject: string, q: { underlying: string; sector: string | null }): boolean {
  const s = String(subject ?? '').trim().toUpperCase();
  if (!s) return false;
  if (s === 'MARKET') return true;
  if (s === q.underlying) return true;
  return q.sector !== null && s === q.sector;
}

/** Today's (IST session of `now`) CONFIRMED / CONTRADICTED claims about the market, the call's sector or its underlying; newest first, at most 10. */
export function selectVerifiedNotes(
  rows: ReadingRow[],
  q: { underlying: string; sector: string | null; now: Date },
): VerifiedNote[] {
  const today = istYmd(q.now);
  const nowMs = q.now.getTime();
  return rows
    .filter((r) => r.postedAt.getTime() <= nowMs && istYmd(r.postedAt) === today)
    .sort((a, b) => b.postedAt.getTime() - a.postedAt.getTime())
    .flatMap((r) =>
      r.claims
        .filter((c) => (c.verdict === 'CONFIRMED' || c.verdict === 'CONTRADICTED') && relevant(c.subject, q))
        .map(
          (c): VerifiedNote => ({
            channel: r.channelTitle,
            at: istHhMm(r.postedAt),
            scope: r.scope,
            subject: c.subject,
            claim: c.text,
            bias: c.bias,
            verdict: c.verdict as 'CONFIRMED' | 'CONTRADICTED',
            evidence: c.evidence,
          }),
        ),
    )
    .slice(0, MAX_NOTES);
}
