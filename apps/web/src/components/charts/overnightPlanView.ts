import type { SentinelOvernightView, SentinelPosition } from '@/hooks/useSentinelPositions';

/**
 * Pure view logic for the "Overnight plan" card in `SentinelPanel`. No React,
 * no DOM — Vitest runs this in node.
 *
 * The API stores an overnight verdict's risk and open plan in the row's
 * `reason` as two labelled lines ("OVERNIGHT RISK: …" / "OPEN PLAN: …"); the
 * level that would change the call is `invalidationPoint`.
 */

/** "4 min ago" — how stale a read is, which the user must be able to see. */
export function agoLabel(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return 'unknown';
  const mins = Math.floor((now - then) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/** Split the stored reason back into the risk and the open plan. Never invents a plan. */
export function parseOvernightReason(reason: string): { risk: string; plan: string | null } {
  const text = String(reason ?? '');
  const risk = /OVERNIGHT RISK:\s*([^\r\n]*)/.exec(text);
  const plan = /OPEN PLAN:\s*([^\r\n]*)/.exec(text);
  if (!risk && !plan) return { risk: text.trim(), plan: null };
  return { risk: (risk?.[1] ?? '').trim(), plan: plan ? plan[1].trim() || null : null };
}

export type OvernightTone = 'emerald' | 'amber' | 'red' | 'muted';

export interface OvernightPlanCard {
  title: 'Overnight plan';
  windowLabel: string;
  verdictLabel: string;
  tone: OvernightTone;
  risk: string;
  plan: string | null;
  changeMind: string | null;
  confidence: string;
  ago: string;
  /** A live verdict has been recorded since this plan: the live read is current. */
  superseded: boolean;
  /** Older than a day — a plan for an open that has come and gone. */
  stale: boolean;
}

const TONE: Record<string, OvernightTone> = {
  HOLD_OVERNIGHT: 'emerald',
  TIGHTEN_AT_OPEN: 'amber',
  EXIT_AT_OPEN: 'red',
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** The card to render beside the live verdict, or null when there has been no overnight review. */
export function overnightPlanCard(position: SentinelPosition, now: number = Date.now()): OvernightPlanCard | null {
  const o: SentinelOvernightView | null | undefined = position.overnight;
  if (!o) return null;
  const { risk, plan } = parseOvernightReason(o.reason);
  const at = Date.parse(o.at);
  const liveAt = position.verdict ? Date.parse(position.verdict.at) : Number.NaN;
  return {
    title: 'Overnight plan',
    windowLabel: o.kind === 'PRE_OPEN_REVIEW' ? 'Pre-open review' : 'After-close review',
    verdictLabel: o.verdict.replace(/_/g, ' '),
    tone: TONE[o.verdict] ?? 'muted',
    risk,
    plan,
    changeMind: o.invalidationPoint && o.invalidationPoint.trim() ? o.invalidationPoint.trim() : null,
    confidence: o.confidence,
    ago: agoLabel(o.at, now),
    superseded: Number.isFinite(liveAt) && Number.isFinite(at) && liveAt > at,
    stale: Number.isFinite(at) && now - at > DAY_MS,
  };
}
