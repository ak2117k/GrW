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
  /** PAPER = TAKE the account could not fund → a paper trade instead; PENDING = waiting for its ABOVE/BELOW trigger. */
  decision: 'TAKE' | 'SKIP' | 'PAPER' | 'PENDING' | null;
  skipReason: string | null;
  gate: GateCheckRow[] | null;
  judge: { verdict?: string; confidence?: number; effectiveConfidence?: number; reasons?: string[]; unavailable?: string; detail?: string; tightened?: string[] } | null;
  plan: {
    tradingsymbol?: string;
    side?: string;
    qty?: number;
    lots?: number;
    limitPrice?: number;
    sl?: number;
    slSource?: string;
    /** Present when the channel hid its SL and the engine derived one. */
    engineSl?: { method: string; detail: string };
    trigger?: TriggerState;
    targets?: number[];
    riskRupees?: number;
  } | null;
}

export interface TriggerState {
  price: number;
  op: 'ABOVE' | 'BELOW';
  bandLow: number;
  bandHigh: number;
  armedAt: string;
  expiresAt: string;
  judgedAt: string | null;
  lastLtp: number | null;
  lastCheckAt: string | null;
}

/** An armed BUY ABOVE / SELL BELOW trigger. */
export interface PendingTriggerRow {
  id: string;
  channel: string | null;
  underlying: string | null;
  tradingsymbol: string | null;
  side: string | null;
  sl: number | null;
  slSource: string | null;
  engineSl: { method: string; detail: string } | null;
  trigger: TriggerState | null;
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

export interface TradeOutcomeSummary {
  n: number;
  open: number;
  closed: number;
  wins: number;
  losses: number;
  noTrade: number;
  pnl: number;
  realised: number;
  winRate: number | null;
}

/** Paper trades by the AI entry judge's call; `gross` = closed side × (exit − entry) × qty, charges left out. */
export interface JudgeBucket {
  n: number;
  closed: number;
  open: number;
  wins: number;
  losses: number;
  gross: number;
  openMark: number;
  winRate: number | null;
}
export type JudgeSplit = Record<'TAKE' | 'SKIP' | 'NONE', JudgeBucket>;

export interface PaperRow {
  decisionId: string;
  /** The AI entry judge's call (learning mode paper-trades SKIPs too). */
  aiDecision?: 'TAKE' | 'SKIP' | 'NONE';
  decidedAt: string;
  channel: string | null;
  underlying: string | null;
  plan: { tradingsymbol?: string; side?: string; qty?: number; limitPrice?: number; sl?: number; targets?: number[] } | null;
  funds: { available: number | null; required: number; ok: boolean | null; method: string } | null;
  trigger: 'funds_check' | 'broker_reject' | 'paper_mode' | null;
  paperError: string | null;
  trade: { id: string; status: string; entryPrice: number | null; exitPrice: number | null; pnl: number | null; exitReasonTag: string | null; exitTime: string | null } | null;
}

export interface SignalOverview {
  mode: 'off' | 'shadow' | 'live';
  /** Owner toggle, stored on the app settings row (user_settings.signalPaperOnNoFunds). */
  paperOnNoFunds?: { enabled: boolean; store: string };
  /** PAPER (no funds) decisions of the last `lookbackDays` with their outcomes, and live over the same window. */
  paper?: { lookbackDays: number; rows: PaperRow[]; summary: TradeOutcomeSummary; byJudge?: JudgeSplit; live: TradeOutcomeSummary };
  caps: { maxLots: number; maxLossPerTrade: number; maxTradesPerDay: number; dailyLossStop: number; entryTolerancePct: number; product: string; triggerWaitMin?: number; triggerMaxPending?: number; engineSl?: boolean };
  /** Armed triggers waiting for their price. */
  pending?: PendingTriggerRow[];
  slEnforcement: { ok: boolean; detail: string };
  decisions: SignalDecisionRow[];
  orders: SignalOrderRow[];
  channels: Array<{ id: string; title: string; stats: unknown }>;
}

export async function getSignalOverview(): Promise<SignalOverview> {
  const { data } = await api.get<SignalOverview>('/signal-trader/overview');
  return data;
}

/** POST /api/signal-trader/settings/paper-on-no-funds (owner only). */
export async function setPaperOnNoFunds(enabled: boolean): Promise<{ enabled: boolean }> {
  const { data } = await api.post<{ enabled: boolean }>('/signal-trader/settings/paper-on-no-funds', { enabled });
  return data;
}

// ---- pure formatting ----

export function modeBadge(mode: string): { label: string; variant: 'danger' | 'warning' | 'neutral' } {
  if (mode === 'live') return { label: 'LIVE', variant: 'danger' };
  if (mode === 'shadow') return { label: 'SHADOW', variant: 'warning' };
  if (mode === 'paper') return { label: 'PAPER', variant: 'warning' };
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
  insufficient_funds: 'not enough funds',
  trigger_expired: 'trigger price never reached',
};

export function skipLabel(reason: string | null): string {
  if (!reason) return '';
  return REASON_LABEL[reason] ?? reason.replace(/_/g, ' ');
}

/** The one-line "why" for a decision: the failed check's detail, or the judge's top reasons. */
export function decisionWhy(d: SignalDecisionRow): string {
  if (d.decision === 'PAPER') {
    const f = (d.gate ?? []).find((c) => c.name === 'broker_funds_reject') ?? (d.gate ?? []).find((c) => c.name === 'funds');
    return f ? `paper trade instead — ${f.detail}` : 'paper trade instead — not enough funds';
  }
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

const rupee = (n: number) => `${n < 0 ? '−' : ''}₹${Math.abs(Math.round(n)).toLocaleString('en-IN')}`;

/** "7 closed · 4W/3L · 1 open · P&L ₹1,250" — the same line for live and paper so they compare. */
export function outcomeLine(s: TradeOutcomeSummary | null | undefined): string {
  if (!s || s.n === 0) return 'none yet';
  const parts = [`${s.closed} closed`, `${s.wins}W/${s.losses}L`];
  if (s.open) parts.push(`${s.open} open`);
  parts.push(`P&L ${rupee(s.pnl)}`);
  return parts.join(' · ');
}

/** "3 trades · 2 closed · 1W/1L · gross ₹80 · 1 open (mark ₹30)" — one AI-judge bucket of the paper trades. */
export function judgeLine(b: JudgeBucket | null | undefined): string {
  if (!b || b.n === 0) return 'none';
  const parts = [`${b.n} trade${b.n === 1 ? '' : 's'}`, `${b.closed} closed`, `${b.wins}W/${b.losses}L`, `gross ${rupee(b.gross)}`];
  if (b.open) parts.push(`${b.open} open (mark ${rupee(b.openMark)})`);
  return parts.join(' · ');
}

/** One paper row's state: open with its mark, closed with its exit, or why it never opened. */
export function paperState(r: PaperRow): { label: string; tone: 'good' | 'bad' | 'neutral' } {
  if (!r.trade) return { label: r.paperError ? `not opened: ${r.paperError}` : 'no paper trade', tone: 'neutral' };
  const pnl = r.trade.pnl ?? 0;
  const tone = pnl > 0 ? 'good' : pnl < 0 ? 'bad' : 'neutral';
  if (r.trade.status === 'CLOSED') {
    const why = r.trade.exitReasonTag === 'HIT_TARGET' ? 'target' : r.trade.exitReasonTag === 'STOPPED_OUT' ? 'SL' : r.trade.exitReasonTag === 'MOVED_STOP' ? 'trailed SL' : r.trade.exitReasonTag === 'AI_EXIT' ? 'AI exit' : r.trade.exitReasonTag === 'TIME_EXIT' ? 'EOD' : 'closed';
    return { label: `${why} @ ${r.trade.exitPrice ?? '?'} · ${rupee(pnl)}`, tone };
  }
  return { label: `open @ ${r.trade.entryPrice ?? '?'} · ${rupee(pnl)}`, tone };
}

export function fundsLine(f: PaperRow['funds']): string {
  if (!f) return '';
  return `need ${rupee(f.required)}, available ${f.available === null ? '?' : rupee(f.available)}${f.method === 'estimate' ? ' (margin estimate)' : f.method === 'broker' ? ' (broker margin)' : ''}`;
}

/** "12:05 left" until an armed trigger expires; "expiring" once past. */
export function countdown(expiresAt: string | null | undefined, nowMs: number): string {
  const t = expiresAt ? Date.parse(expiresAt) : NaN;
  if (!Number.isFinite(t)) return '';
  const left = Math.floor((t - nowMs) / 1000);
  if (left <= 0) return 'expiring';
  const m = Math.floor(left / 60);
  const sec = String(left % 60).padStart(2, '0');
  return `${m}:${sec} left`;
}

const FUNDS_METHOD: Record<string, string> = { broker: 'broker margin', estimate: 'margin estimate', premium: 'premium', notional: 'notional' };

/** How the live funds check sized this decision (from the gate's funds record), or ''. */
export function fundsMethod(d: Pick<SignalDecisionRow, 'gate'>): string {
  const f = (d.gate ?? []).find((c) => c.name === 'funds' || c.name === 'broker_funds_reject') as (GateCheckRow & { funds?: { method?: string } }) | undefined;
  const m = f?.funds?.method;
  return m ? (FUNDS_METHOD[m] ?? m) : '';
}

/** Short label for the engine SL badge. */
export function engineSlLabel(e: { method: string } | null | undefined): string {
  if (!e) return '';
  const m: Record<string, string> = { level: 'level', level_fut: 'level', level_delta: 'level × delta', premium_pct: 'premium %', atr: 'ATR' };
  return `ENGINE SL · ${m[e.method] ?? e.method}`;
}
