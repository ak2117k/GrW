import api from '@/services/api';

/** GET /api/signal-trader/overview (owner only). */
export interface GateCheckRow {
  name: string;
  ok: boolean | null;
  required: boolean;
  detail: string;
}

export interface SignalDecisionRow {
  id: string;
  signalId: string;
  evaluation: number;
  decidedAt: string;
  mode: string;
  status: string;
  channel: string | null;
  underlying: string | null;
  agreeCount: number | null;
  conflict: boolean | null;
  decision: 'TAKE' | 'SKIP' | null;
  skipReason: string | null;
  gate: GateCheckRow[] | null;
  judge: { verdict?: string; confidence?: number; effectiveConfidence?: number; reasons?: string[]; unavailable?: string; detail?: string; tightened?: string[] } | null;
  plan: { tradingsymbol?: string; side?: string; qty?: number; lots?: number; limitPrice?: number; sl?: number; targets?: number[]; riskRupees?: number } | null;
}

export interface SignalOrderRow {
  id: string;
  decisionId: string;
  tradingsymbol: string;
  side: string;
  qty: number;
  limitPrice: number;
  sl: number;
  targets: unknown;
  status: string;
  statusReason: string | null;
  fillPrice: number | null;
  filledAt: string | null;
  trackerStatus: string | null;
  lastLtp: number | null;
  pnl: number | null;
  createdAt: string;
}

export interface SignalOverview {
  mode: 'off' | 'shadow' | 'live';
  caps: { maxLots: number; maxLossPerTrade: number; maxTradesPerDay: number; dailyLossStop: number; entryTolerancePct: number; product: string };
  slEnforcement: { ok: boolean; detail: string };
  decisions: SignalDecisionRow[];
  orders: SignalOrderRow[];
  channels: Array<{ id: string; title: string; stats: unknown }>;
}

export async function getSignalOverview(): Promise<SignalOverview> {
  const { data } = await api.get<SignalOverview>('/signal-trader/overview');
  return data;
}

// ---- pure formatting ----

export function modeBadge(mode: string): { label: string; variant: 'danger' | 'warning' | 'neutral' } {
  if (mode === 'live') return { label: 'LIVE', variant: 'danger' };
  if (mode === 'shadow') return { label: 'SHADOW', variant: 'warning' };
  return { label: 'OFF', variant: 'neutral' };
}

const REASON_LABEL: Record<string, string> = {
  entry_tolerance: 'price outside entry band',
  sl_present: 'no stop-loss',
  sl_side: 'stop-loss already hit / wrong side',
  risk_cap: 'risk above cap',
  trades_today: 'daily trade cap reached',
  daily_signal_loss: 'daily loss stop reached',
  cluster_not_taken: 'cluster already traded',
  not_holding: 'already holding',
  kill_switch: 'kill switch',
  risk_manager: 'account risk manager',
  market_hours: 'market closed',
  instrument_resolved: 'contract not found',
  judge_unavailable: 'AI judge unavailable',
  judge_invalid: 'AI judge reply invalid',
  judge_skip: 'AI judge said skip',
  low_confidence: 'AI confidence too low',
  price_moved: 'price moved before sending',
  sl_enforceable: 'SL could not be enforced',
  live_trading_enabled: 'live trading disabled',
  side_allowed: 'option writing refused',
};

export function skipLabel(reason: string | null): string {
  if (!reason) return '';
  return REASON_LABEL[reason] ?? reason.replace(/_/g, ' ');
}

/** The one-line "why" for a decision: the failed check's detail, or the judge's top reasons. */
export function decisionWhy(d: SignalDecisionRow): string {
  if (d.decision === 'SKIP') {
    const failed = (d.gate ?? []).find((c) => c.name === d.skipReason);
    if (failed) return failed.detail;
    if (d.judge?.detail) return d.judge.detail;
    return d.judge?.reasons?.[0] ?? '';
  }
  return (d.judge?.reasons ?? []).slice(0, 2).join('; ');
}

export function planLine(p: SignalDecisionRow['plan']): string {
  if (!p?.tradingsymbol) return '';
  const t = Array.isArray(p.targets) && p.targets.length ? ` T ${p.targets.join('/')}` : '';
  return `${p.side ?? ''} ${p.tradingsymbol} x${p.qty ?? '?'} @ ${p.limitPrice ?? '?'} SL ${p.sl ?? '?'}${t} (risk ₹${p.riskRupees ?? '?'})`;
}

/** Open = filled with the tracker still open, or an order still working. */
export function openOrders(orders: SignalOrderRow[]): SignalOrderRow[] {
  return orders.filter((o) => ((o.status === 'FILLED' || o.status === 'PARTIAL') && o.trackerStatus !== 'CLOSED') || o.status === 'PLACED' || o.status === 'CLAIMED' || o.status === 'UNCERTAIN');
}

/** Channel stats are whatever the self-review publishes; show the common fields when present. */
export function channelStatsLine(stats: unknown): string {
  if (!stats || typeof stats !== 'object') return 'no stats yet';
  const s = stats as Record<string, unknown>;
  const n = typeof s.n === 'number' ? s.n : null;
  const hit = typeof s.hitRate === 'number' ? s.hitRate : null;
  const parts: string[] = [];
  if (hit !== null) parts.push(`hit ${Math.round(hit * 100)}%`);
  if (n !== null) parts.push(`n ${n}`);
  if (typeof s.right === 'number' && typeof s.wrong === 'number') parts.push(`${s.right}✓ ${s.wrong}✗`);
  return parts.length ? parts.join(' · ') : 'no stats yet';
}
