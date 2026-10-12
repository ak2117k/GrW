import type { AiExitRow } from '@/hooks/useAiExits';
import { agoLabel } from './overnightPlanView';

/** emerald = live FILLED; amber = live order working (PLACED/CLAIMED); red = REJECTED/FAILED; muted = DRY_RUN/SKIPPED. */
export type AiExitTone = 'emerald' | 'amber' | 'red' | 'muted';
export interface AiExitRowView {
  label: string;
  tone: AiExitTone;
  line: string;
  detail: string;
  ago: string;
  /** createdAt as `HH:mm IST` (24 h); '' when unparseable. */
  time: string;
  dryRun: boolean;
  /** Dry-run row whose quantity unit is not verified for the exchange (reason prefix `UNIT_UNVERIFIED:`, ruling R16). */
  unitUnverified: boolean;
}

const TONE: Record<AiExitRow['status'], AiExitTone> = {
  FILLED: 'emerald',
  PLACED: 'amber',
  CLAIMED: 'amber',
  DRY_RUN: 'muted',
  SKIPPED: 'muted',
  REJECTED: 'red',
  FAILED: 'red',
};

const IST_TIME = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export function istTime(iso: string): string {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? `${IST_TIME.format(t)} IST` : '';
}

export function aiExitRowView(r: AiExitRow, now: number = Date.now()): AiExitRowView {
  const planned = r.side != null && r.quantity != null;
  const product = r.productType ? ` (${r.productType})` : '';
  const how = r.orderType === 'LIMIT' && r.limitPrice != null ? ` LIMIT ${r.limitPrice}` : ' at MARKET';
  const line = planned
    ? `${r.side} ${r.quantity} ${r.symbol}${product}${how}`
    : `${r.symbol} — ${r.reason ?? r.status}`;

  const parts: string[] = [];
  if (r.status === 'REJECTED' || r.status === 'FAILED') {
    const why = r.reason ?? r.status;
    parts.push(r.brokerMessage ? `${why}: ${r.brokerMessage}` : why);
    if (r.brokerOrderId) parts.push(`order ${r.brokerOrderId}`);
  } else if (r.brokerOrderId) {
    parts.push(`order ${r.brokerOrderId}`);
  } else if (planned && r.reason) {
    // DRY_RUN ("would SELL …", possibly UNIT_UNVERIFIED) or a SKIPPED row after planning.
    parts.push(r.reason);
  }
  if (r.marketOrderId) parts.push(`MARKET refused (${r.marketOrderId})`);
  if (r.verdictReason) parts.push(r.verdictReason);

  return {
    label: r.status === 'DRY_RUN' ? 'DRY RUN' : r.status,
    tone: TONE[r.status] ?? 'muted',
    line,
    detail: parts.join(' · '),
    ago: agoLabel(r.createdAt, now),
    time: istTime(r.createdAt),
    dryRun: r.mode === 'dry-run',
    unitUnverified: r.status === 'DRY_RUN' && (r.reason ?? '').startsWith('UNIT_UNVERIFIED'),
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_ROWS = 10;

/** Newest 10 rows of the last 24 h (ruling R15). */
export function recentAiExits(rows: AiExitRow[], now: number = Date.now()): AiExitRow[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r) => {
      const t = Date.parse(r.createdAt);
      return Number.isFinite(t) && now - t <= DAY_MS;
    })
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, MAX_ROWS);
}
