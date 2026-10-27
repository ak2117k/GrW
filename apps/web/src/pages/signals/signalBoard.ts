import api from '@/services/api';

/** GET /api/signal-board — one session's signals from every source (night setups, ideas, Telegram calls, watches). */
export type BoardSource = 'NIGHT_SETUP' | 'NEWS_IDEA' | 'TELEGRAM' | 'WATCH';
export type BoardState = 'WAITING' | 'OPEN' | 'WON' | 'LOST' | 'FLAT' | 'SKIPPED' | 'VIEW';

export interface BoardItem {
  id: string;
  source: BoardSource;
  at: string;
  symbol: string;
  instrument: string | null;
  side: 'BUY' | 'SELL' | null;
  entry: number | null;
  entryNote: string | null;
  sl: number | null;
  slSource: 'channel' | 'engine' | 'setup' | null;
  targets: number[];
  targetSource: 'channel' | 'engine' | 'setup' | null;
  state: BoardState;
  status: string;
  why: string[];
  result: { r?: number; movePct?: number; pnl?: number } | null;
  channel: string | null;
  aiCorrect: boolean | null;
}

export interface SignalBoard {
  session: string;
  items: BoardItem[];
  counts: Record<BoardSource, number>;
}

export async function getSignalBoard(date?: string): Promise<SignalBoard> {
  const { data } = await api.get<SignalBoard>('/signal-board', { params: date ? { date } : {} });
  return data;
}

export const SOURCE_LABEL: Record<BoardSource, string> = {
  NIGHT_SETUP: 'Night setup',
  NEWS_IDEA: 'News idea',
  TELEGRAM: 'Telegram',
  WATCH: 'Breakout watch',
};

export const STATE_LABEL: Record<BoardState, string> = {
  WAITING: 'waiting',
  OPEN: 'open',
  WON: 'won',
  LOST: 'lost',
  FLAT: 'flat',
  SKIPPED: 'skipped',
  VIEW: 'view',
};

export const STATE_VARIANT: Record<BoardState, 'success' | 'danger' | 'warning' | 'info' | 'neutral'> = {
  WAITING: 'info',
  OPEN: 'warning',
  WON: 'success',
  LOST: 'danger',
  FLAT: 'neutral',
  SKIPPED: 'neutral',
  VIEW: 'neutral',
};

export type BoardFilter = 'all' | 'actionable' | BoardSource;

/** "actionable" = something to act on or watch now: waiting or open. */
export function filterBoard(items: BoardItem[], f: BoardFilter): BoardItem[] {
  if (f === 'all') return items;
  if (f === 'actionable') return items.filter((x) => x.state === 'WAITING' || x.state === 'OPEN');
  return items.filter((x) => x.source === f);
}

const mark = (src: BoardItem['slSource']) => (src === 'engine' ? ' (engine)' : '');

/** "entry 251 (at 250) · SL 230 (engine) · T 290 / 320 (engine)" — only the parts that exist. */
export function levelsLine(x: BoardItem): string {
  const parts: string[] = [];
  if (x.entry !== null) parts.push(`entry ${x.entry}${x.entryNote && x.source === 'TELEGRAM' ? ` (${x.entryNote})` : ''}`);
  if (x.sl !== null) parts.push(`SL ${x.sl}${mark(x.slSource)}`);
  if (x.targets.length) parts.push(`T ${x.targets.join(' / ')}${mark(x.targetSource)}`);
  return parts.join(' · ');
}

/** "+1.5 R", "+12.5% · ₹3,100", "" when no result yet. */
export function resultLine(x: BoardItem): string {
  const r = x.result;
  if (!r) return '';
  const sign = (n: number) => (n > 0 ? '+' : '');
  const out: string[] = [];
  if (typeof r.r === 'number') out.push(`${sign(r.r)}${r.r} R`);
  if (typeof r.movePct === 'number') out.push(`${sign(r.movePct)}${r.movePct}%`);
  if (typeof r.pnl === 'number') out.push(`${r.pnl < 0 ? '-' : ''}₹${Math.abs(r.pnl).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`);
  return out.join(' · ');
}

/** Today in IST as YYYY-MM-DD (the board's default session). */
export function istToday(now = new Date()): string {
  return new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10);
}
