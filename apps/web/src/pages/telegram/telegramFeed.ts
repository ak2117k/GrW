import api from '@/services/api';
import { skipLabel } from '@/pages/signals-telegram/signalsTelegram';

/** GET /api/telegram/feed — every incoming Telegram message with what the reader made of it. */
export interface FeedCall {
  tradingsymbol: string | null;
  side: string | null;
  entryType: string | null;
  entryLow: number | null;
  entryHigh: number | null;
  sl: number | null;
  targets: number[];
  decision: string | null;
  skipReason: string | null;
  mode: string | null;
  /** The AI judge's reasons, most important first (absent from an older API / no judge ran). */
  judgeReasons?: string[];
  judgeConfidence?: number | null;
  /** Learning mode: the closed paper trade held against the judge's call. */
  aiCheck?: AiCheck | null;
  /** The decision's plan: the SL / targets actually traded and where they came from. */
  planSl?: number | null;
  planSlSource?: string | null;
  planTargets?: number[];
  planTargetSource?: string | null;
}

export interface AiCheck {
  aiDecision: 'TAKE' | 'SKIP' | 'NONE';
  movePct: number;
  pnl: number;
  exitTag: string;
  correct: boolean | null;
  at: string;
}

export interface AiScorecard {
  days: number;
  scored: number;
  right: number;
  wrong: number;
  accuracyPct: number | null;
  takeRight: number;
  takeWrong: number;
  skipRight: number;
  skipWrong: number;
  unscored: number;
}

export async function getAiScorecard(days = 14): Promise<AiScorecard> {
  return (await api.get<AiScorecard>('/telegram/ai-scorecard', { params: { days } })).data;
}

const EXIT: Record<string, string> = { HIT_TARGET: 'target', STOPPED_OUT: 'stop', TIME_EXIT: 'time exit' };

/** "AI said SKIP · paper +3.2% (target) → AI was wrong". */
export function aiLine(c: AiCheck): string {
  const said = c.aiDecision === 'NONE' ? 'AI gave no verdict' : `AI said ${c.aiDecision}`;
  const move = `${c.movePct >= 0 ? '+' : ''}${c.movePct}%`;
  const verdict = c.correct === null ? 'not scored' : c.correct ? 'AI was right' : 'AI was wrong';
  return `${said} · paper ${move} (${EXIT[c.exitTag] ?? c.exitTag.toLowerCase()}) → ${verdict}`;
}

/** "AI judge check, last 14 days: 7 right / 5 wrong (58%) · TAKE 4✓ 2✗ · SKIP 3✓ 3✗". */
export function scorecardLine(s: AiScorecard): string {
  if (s.scored === 0) return `AI judge check (learning mode, last ${s.days} days): no closed paper trades scored yet`;
  return `AI judge check, last ${s.days} days: ${s.right} right / ${s.wrong} wrong (${s.accuracyPct}%) · TAKE ${s.takeRight}✓ ${s.takeWrong}✗ · SKIP ${s.skipRight}✓ ${s.skipWrong}✗`;
}

/** "AI judge (82%):" heading for the reasons list, or null when the judge gave none. */
export function judgeHeading(c: FeedCall): string | null {
  if (!c.judgeReasons?.length) return null;
  const conf = c.judgeConfidence !== null && c.judgeConfidence !== undefined ? ` (${Math.round(c.judgeConfidence)}% sure)` : '';
  const verdict = c.decision === 'SKIP' && c.skipReason?.startsWith('judge') ? 'AI judge skipped it' : 'AI judge';
  return `${verdict}${conf}:`;
}

export interface FeedItem {
  id: string;
  channelId: string;
  channel: string;
  postedAt: string;
  receivedAt: string;
  lagSec: number;
  text: string;
  hasMedia: boolean;
  /** Classifier status (SIGNAL / INFO / NOISE / …); null = not classified yet. */
  status: string | null;
  reason: string | null;
  parser: string | null;
  call: FeedCall | null;
  /** Breakout levels from this post being watched; absent from an older API. */
  watches?: FeedWatch[];
}

/** A watched breakout level ("Radico breakout above 4330") and, once crossed, the trade decision. */
export interface FeedWatch {
  underlying: string;
  side: string;
  level: number;
  status: string;
  lastLtp: number | null;
  decision: string | null;
  skipReason: string | null;
}

/** "watching RADICO above 4330 (last 4312)" / "RADICO crossed 4330 → paper trade" / "… expired". */
export function watchLine(w: FeedWatch): string {
  const dir = w.side === 'SELL' ? 'below' : 'above';
  if (w.status === 'ACTIVE') return `watching ${w.underlying} ${dir} ${w.level}${w.lastLtp !== null ? ` (last ${w.lastLtp})` : ''}`;
  if (w.status === 'FIRED') {
    const what = !w.decision
      ? 'waiting for a trade decision'
      : w.decision === 'SKIP'
        ? `skipped: ${skipLabel(w.skipReason)}`
        : w.decision === 'PAPER'
          ? 'paper trade'
          : w.decision === 'TAKE'
            ? 'taken'
            : w.decision.toLowerCase();
    return `${w.underlying} crossed ${w.level} → ${what}`;
  }
  if (w.status === 'EXPIRED') return `${w.underlying} ${dir} ${w.level}: not crossed, watch expired`;
  return `${w.underlying} ${w.level}: not watched (no price line)`;
}

export async function getTelegramFeed(params: { channelId?: string; status?: string[]; limit?: number } = {}): Promise<FeedItem[]> {
  const query: Record<string, string | number> = { limit: params.limit ?? 150 };
  if (params.channelId) query.channelId = params.channelId;
  if (params.status?.length) query.status = params.status.join(',');
  return (await api.get<FeedItem[]>('/telegram/feed', { params: query })).data;
}

type Variant = 'success' | 'danger' | 'warning' | 'info' | 'neutral';

const CLASS: Record<string, { label: string; variant: Variant }> = {
  SIGNAL: { label: 'Call', variant: 'success' },
  UPDATE: { label: 'Update', variant: 'info' },
  UPDATE_ORPHAN: { label: 'Update', variant: 'info' },
  DUPLICATE: { label: 'Duplicate', variant: 'neutral' },
  INFO: { label: 'Information', variant: 'info' },
  VIEW: { label: 'Information', variant: 'info' },
  RECAP: { label: 'Result', variant: 'warning' },
  NOISE: { label: 'Noise', variant: 'neutral' },
  LLM_NOT_SIGNAL: { label: 'Not a call', variant: 'neutral' },
  LLM_PENDING: { label: 'Reading…', variant: 'warning' },
  LLM_FAILED: { label: 'Not read', variant: 'danger' },
  LLM_SKIPPED: { label: 'Not read', variant: 'danger' },
};

export function classLabel(status: string | null): { label: string; variant: Variant } {
  if (!status) return { label: 'Not classified', variant: 'neutral' };
  return CLASS[status] ?? { label: status, variant: 'neutral' };
}

/** The pre-filter's reason codes (signal-intake prefilter.ts) in plain words. */
const REASON: Record<string, string> = {
  'no-instrument': 'no stock, index or contract named',
  'no-action': 'no buy / sell / above / below word',
  'too-few-prices': 'not enough prices for a call',
  'sector-index': 'sector index (no options to trade)',
  ad: 'advert / promotion',
  recap: 'profit recap',
  llm: 'AI read it as not a call',
};

/** One line on why the reader classed the message this way (or, for a call, what was decided). */
export function whyLine(item: FeedItem): string {
  if (item.call) {
    const c = item.call;
    if (!c.decision) return 'waiting for a trade decision';
    const mode = c.mode ? ` (${c.mode})` : '';
    if (c.decision === 'SKIP') return `skipped${mode}: ${skipLabel(c.skipReason)}`;
    if (c.decision === 'TAKE') return `taken${mode}`;
    if (c.decision === 'PAPER') return `paper trade${mode}`;
    if (c.decision === 'PENDING') return `waiting for the trigger price${mode}`;
    return `${c.decision.toLowerCase()}${mode}`;
  }
  const r = item.reason ?? '';
  if (r === 'empty') return item.hasMedia ? 'image only, no text' : 'empty message';
  return REASON[r] ?? r;
}

const px = (v: number | null) => (v === null ? '—' : String(v));

export function callLine(c: FeedCall): string {
  const entry =
    c.entryLow !== null && c.entryHigh !== null && c.entryLow !== c.entryHigh ? `${c.entryLow}–${c.entryHigh}` : px(c.entryLow);
  const how = c.entryType === 'ABOVE' ? 'above' : c.entryType === 'BELOW' ? 'below' : c.entryType === 'RANGE' ? 'between' : 'at';
  // The channel's own SL / targets; when it gave none, the ones our engine assigned (marked "engine").
  const engineSl = c.sl === null && c.planSlSource === 'engine' && c.planSl ? c.planSl : null;
  const engineT = c.targets.length === 0 && c.planTargetSource === 'engine' && c.planTargets?.length ? c.planTargets : null;
  const sl = engineSl !== null ? `${engineSl} (engine)` : px(c.sl);
  const tgts = engineT ? `${engineT.join(' / ')} (engine)` : c.targets.length ? c.targets.join(' / ') : '—';
  return `${c.side ?? ''} ${c.tradingsymbol ?? ''} ${how} ${entry} · SL ${sl} · targets ${tgts}`.trim();
}

/** The reader's delay, shown only when it is slow enough to matter for a call. */
export function lagLabel(sec: number): string {
  if (sec < 15) return '';
  if (sec < 120) return `arrived ${sec}s late`;
  return `arrived ${Math.round(sec / 60)}m late`;
}

export const FILTERS: Array<{ key: string; label: string; statuses?: string[] }> = [
  { key: 'all', label: 'All' },
  { key: 'calls', label: 'Calls', statuses: ['SIGNAL'] },
  { key: 'updates', label: 'Updates', statuses: ['UPDATE', 'UPDATE_ORPHAN'] },
  { key: 'info', label: 'Information', statuses: ['INFO', 'VIEW'] },
  { key: 'results', label: 'Results', statuses: ['RECAP'] },
  { key: 'other', label: 'Noise / not a call', statuses: ['NOISE', 'LLM_NOT_SIGNAL', 'DUPLICATE', 'LLM_FAILED', 'LLM_SKIPPED', 'LLM_PENDING'] },
];
