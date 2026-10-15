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
  /** What started the exit: a sentinel verdict, the owner's button, or a sentinel price trigger. */
  source: 'AI' | 'MANUAL' | 'PRICE_TRIGGER';
  /** Exit discipline: the gate's reason (AI rows), fill quality, and what the price did after. Null when absent. */
  gateLine: string | null;
  qualityLine: string | null;
  outcomeLine: string | null;
}

/** The scoring window the API uses by default (EXIT_OUTCOME_WINDOW_MIN=60). */
export const OUTCOME_WINDOW_LABEL = 'Next 60 min';

const GATE_HEAD: Record<NonNullable<AiExitRow['gate']>['outcome'], string> = {
  GATED_THESIS_INTACT: 'Held — thesis intact',
  AWAITING_CONFIRMATION: 'Held — awaiting a confirming EXIT_NOW',
  PASS: 'Gate passed',
  BYPASS: 'Gate bypassed',
};

/** The API summary minus its leading `OUTCOME: ` (the head says it in words). */
function gateLine(g: AiExitRow['gate']): string | null {
  if (!g || !GATE_HEAD[g.outcome]) return null;
  const rest = String(g.summary ?? '').replace(/^[A-Z_]+:\s*/, '').trim();
  const head = GATE_HEAD[g.outcome];
  if (!rest) return head;
  return g.outcome === 'PASS' || g.outcome === 'BYPASS' ? `${head} — ${rest}` : `${head}: ${rest}`;
}

function qualityLine(q: AiExitRow['quality']): string | null {
  if (!q) return null;
  if (q.fillPrice == null) return q.orderLtp != null ? `LTP at the check ${q.orderLtp}` : null;
  const parts = [`Filled ${q.fillPrice}`];
  if (q.costPerUnit != null && q.decisionLtp != null) parts.push(`cost ${q.costPerUnit}/unit vs decision ${q.decisionLtp}`);
  if (q.latencyMs != null && Number.isFinite(q.latencyMs)) parts.push(`${Math.round(q.latencyMs / 1000)} s`);
  return parts.join(' · ');
}

const inr = (x: number) => `₹${Math.round(Math.abs(x)).toLocaleString('en-IN')}`;

function outcomeLine(o: AiExitRow['outcome']): string | null {
  if (!o) return null;
  if (o.status === 'PENDING') {
    const at = istTime(o.windowEnd);
    return at ? `Scoring after ${at}` : 'Scoring after the window';
  }
  if (o.status === 'NO_DATA') return 'Not scored — no price data after the decision';
  const parts = [`${OUTCOME_WINDOW_LABEL}: missed ${inr(o.missedPnl ?? 0)}`, `saved ${inr(o.savedPnl ?? 0)}`];
  // A held (gated / awaiting) decision: what holding to the window end did.
  if ((o.kind === 'GATED' || o.kind === 'AWAITING') && o.netAtEnd != null) {
    parts.push(`holding ${o.netAtEnd < 0 ? '−' : '+'}${inr(o.netAtEnd)}`);
  }
  return parts.join(' · ');
}

const SOURCE_PREFIX: Record<AiExitRowView['source'], string> = { AI: '', MANUAL: 'MANUAL ', PRICE_TRIGGER: 'PRICE TRIGGER ' };

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

  const source = r.trigger ?? 'AI';
  return {
    // The owner's Exit button and price-trigger fires share this table; say so,
    // so neither is read as a judged AI decision.
    label: `${SOURCE_PREFIX[source] ?? ''}${r.status === 'DRY_RUN' ? 'DRY RUN' : r.status}`,
    source,
    tone: TONE[r.status] ?? 'muted',
    line,
    detail: parts.join(' · '),
    ago: agoLabel(r.createdAt, now),
    time: istTime(r.createdAt),
    dryRun: r.mode === 'dry-run',
    unitUnverified: r.status === 'DRY_RUN' && (r.reason ?? '').startsWith('UNIT_UNVERIFIED'),
    gateLine: gateLine(r.gate),
    qualityLine: qualityLine(r.quality),
    outcomeLine: outcomeLine(r.outcome),
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
