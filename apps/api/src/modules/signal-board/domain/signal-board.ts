/**
 * One trading day's signals in one list (owner 2026-10-28: "the Signals page should show what we get
 * by analysing everything at night, or anything we get in the day"). Pure: the repository hands raw
 * rows from four sources, this turns them into one shape, newest first.
 *
 *   NIGHT_SETUP  trade_setups for the session (built 23:50 / 08:50 from the news ideas)
 *   NEWS_IDEA    news_ideas of the night that did NOT become a setup (a NO_TRADE view is still a view)
 *   TELEGRAM     a channel call and what we did with it (latest signal_decisions row)
 *   WATCH        a breakout level from a channel post, still waiting (a fired one shows as its TELEGRAM call)
 */
export type BoardSource = 'NIGHT_SETUP' | 'NEWS_IDEA' | 'TELEGRAM' | 'WATCH';

/** A coarse state every source maps onto, so one filter works across them. */
export type BoardState = 'WAITING' | 'OPEN' | 'WON' | 'LOST' | 'FLAT' | 'SKIPPED' | 'VIEW';

export interface BoardItem {
  id: string;
  source: BoardSource;
  /** When it reached us (ISO). */
  at: string;
  symbol: string;
  /** The tradable contract when known (NIFTY28OCT2625000CE, SAIL23NOV26FUT). */
  instrument: string | null;
  side: 'BUY' | 'SELL' | null;
  entry: number | null;
  /** How the entry is taken (a setup's rule, "above 250", "breakout above 4330"). */
  entryNote: string | null;
  sl: number | null;
  slSource: 'channel' | 'engine' | 'setup' | null;
  targets: number[];
  targetSource: 'channel' | 'engine' | 'setup' | null;
  state: BoardState;
  /** The source's own status word (PAPER, SKIP judge_skip, TARGET1, NOT_TRIGGERED, WATCHING…). */
  status: string;
  /** Why: the setup's / idea's rationale, the judge's first reasons, the skip reason. */
  why: string[];
  /** Result once known: R for a setup, % move and ₹ for a paper call. */
  result: { r?: number; movePct?: number; pnl?: number } | null;
  /** Telegram channel (TELEGRAM / WATCH). */
  channel: string | null;
  /** TELEGRAM: was the AI judge right (learning mode, once the paper trade closed)? */
  aiCorrect: boolean | null;
}

export interface SetupRow {
  id: string;
  created_at: Date;
  symbol: string;
  instrument: string | null;
  side: string | null;
  entry_rule: string | null;
  entry_ref: number | null;
  stop: number | null;
  target1: number | null;
  target2: number | null;
  outcome_status: string | null;
  outcome_r: number | null;
  idea_rationale: string | null;
  /** The setup's paper call (setup-watch), when its range broke: the trader's latest decision. */
  decision?: string | null;
  skip_reason?: string | null;
  plan?: unknown;
  ai_check?: unknown;
}

export interface IdeaRow {
  id: string;
  created_at: Date;
  symbol: string;
  idea: string | null;
  rationale: string | null;
  what_to_do: string | null;
  move_bp: number | null;
}

export interface CallRow {
  signal_id: string;
  created_at: Date;
  channel: string | null;
  underlying: string;
  tradingsymbol: string | null;
  side: string | null;
  entry_type: string | null;
  entry_low: number | null;
  entry_high: number | null;
  sl: number | null;
  targets: unknown;
  raw_text: string | null;
  outcome_status: string | null;
  decision: string | null;
  skip_reason: string | null;
  plan: unknown;
  judge: unknown;
  ai_check: unknown;
}

export interface WatchRow {
  id: string;
  created_at: Date;
  channel: string | null;
  underlying: string;
  side: string | null;
  level: number;
  status: string;
  last_ltp: number | null;
  reason: string | null;
}

const num = (v: unknown): number | null => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const nums = (v: unknown): number[] => (Array.isArray(v) ? v.map(num).filter((x): x is number => x !== null && x > 0) : []);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const side = (v: string | null): 'BUY' | 'SELL' | null => {
  const s = (v ?? '').toUpperCase();
  return s === 'BUY' || s === 'LONG' ? 'BUY' : s === 'SELL' || s === 'SHORT' ? 'SELL' : null;
};
const text = (...xs: Array<string | null | undefined>) => xs.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim());

export function setupItem(r: SetupRow): BoardItem {
  const o = (r.outcome_status ?? '').toUpperCase();
  const R = num(r.outcome_r);
  // Before the after-close replay scores it, the live paper call (if the range broke) says where it is.
  const d = (r.decision ?? '').toUpperCase();
  const ai = obj(r.ai_check);
  const pnl = num(ai.pnl);
  const live: BoardState | null =
    d === '' ? null
    : pnl !== null ? (pnl > 0 ? 'WON' : pnl < 0 ? 'LOST' : 'FLAT')
    : d === 'PAPER' || d === 'TAKE' ? 'OPEN'
    : d === 'PENDING' ? 'WAITING'
    : 'SKIPPED';
  const state: BoardState =
    o === '' ? (live ?? 'WAITING')
    : o === 'NOT_TRIGGERED' ? 'SKIPPED'
    : o === 'STOP' ? 'LOST'
    : o.startsWith('TARGET') ? 'WON'
    : R !== null ? (R > 0.05 ? 'WON' : R < -0.05 ? 'LOST' : 'FLAT')
    : 'OPEN';
  return {
    id: `setup:${r.id}`,
    source: 'NIGHT_SETUP',
    at: r.created_at.toISOString(),
    symbol: r.symbol,
    instrument: r.instrument ? r.instrument.split(' ')[0] : null,
    side: side(r.side),
    entry: num(r.entry_ref),
    entryNote: r.entry_rule,
    sl: num(r.stop),
    slSource: num(r.stop) !== null ? 'setup' : null,
    targets: [num(r.target1), num(r.target2)].filter((x): x is number => x !== null),
    targetSource: 'setup',
    state,
    status: o || (d ? [`paper ${d}`, d === 'SKIP' ? r.skip_reason : null].filter(Boolean).join(' ') : 'PENDING'),
    why: text(r.idea_rationale),
    result: R !== null ? { r: R } : pnl !== null ? { pnl } : null,
    channel: null,
    aiCorrect: null,
  };
}

export function ideaItem(r: IdeaRow): BoardItem {
  const idea = (r.idea ?? '').toUpperCase();
  const s = idea.startsWith('CE') || idea === 'LONG' || idea === 'BUY' ? 'BUY' : idea.startsWith('PE') || idea === 'SHORT' || idea === 'SELL' ? 'SELL' : null;
  const bp = num(r.move_bp);
  return {
    id: `idea:${r.id}`,
    source: 'NEWS_IDEA',
    at: r.created_at.toISOString(),
    symbol: r.symbol,
    instrument: null,
    side: s,
    entry: null,
    entryNote: r.what_to_do,
    sl: null,
    slSource: null,
    targets: [],
    targetSource: null,
    state: 'VIEW',
    status: idea || 'IDEA',
    why: text(r.rationale),
    result: bp !== null ? { movePct: Math.round(bp) / 100 } : null,
    channel: null,
    aiCorrect: null,
  };
}

export function callItem(r: CallRow): BoardItem {
  const plan = obj(r.plan);
  const judge = obj(r.judge);
  const ai = obj(r.ai_check);
  const chT = nums(r.targets);
  const planT = nums(plan.targets);
  const planSl = num(plan.sl);
  const d = (r.decision ?? '').toUpperCase();
  const closed = typeof ai.correct === 'boolean' || num(ai.pnl) !== null;
  const pnl = num(ai.pnl);
  const state: BoardState =
    closed && pnl !== null ? (pnl > 0 ? 'WON' : pnl < 0 ? 'LOST' : 'FLAT')
    : d === 'PAPER' || d === 'TAKE' ? 'OPEN'
    : d === 'PENDING' || d === '' ? 'WAITING'
    : 'SKIPPED';
  const lo = num(r.entry_low);
  const hi = num(r.entry_high);
  const how = (r.entry_type ?? 'AT').toLowerCase();
  const reasons = Array.isArray(judge.reasons) ? judge.reasons.filter((x): x is string => typeof x === 'string').slice(0, 3) : [];
  const viaWatch = (r.raw_text ?? '').startsWith('[watch fired');
  return {
    id: `call:${r.signal_id}`,
    source: 'TELEGRAM',
    at: r.created_at.toISOString(),
    symbol: r.underlying,
    instrument: typeof plan.tradingsymbol === 'string' ? plan.tradingsymbol : r.tradingsymbol,
    side: side(r.side),
    entry: num(plan.limitPrice) ?? lo,
    entryNote: lo === null ? null : `${viaWatch ? 'breakout ' : ''}${how === 'range' && hi !== null && hi !== lo ? `${lo}–${hi}` : `${how} ${lo}`}`,
    sl: r.sl ?? (planSl !== null && planSl > 0 ? planSl : null),
    slSource: r.sl !== null ? 'channel' : planSl !== null && planSl > 0 ? 'engine' : null,
    targets: chT.length ? chT : planT,
    targetSource: chT.length ? 'channel' : planT.length ? (plan.targetSource === 'engine' ? 'engine' : 'channel') : null,
    state,
    status: [d || 'NEW', d === 'SKIP' ? r.skip_reason : null].filter(Boolean).join(' '),
    why: reasons.length ? reasons : text(r.skip_reason),
    result: closed ? { ...(num(ai.movePct) !== null ? { movePct: num(ai.movePct) as number } : {}), ...(pnl !== null ? { pnl } : {}) } : null,
    channel: r.channel,
    aiCorrect: typeof ai.correct === 'boolean' ? ai.correct : null,
  };
}

export function watchItem(r: WatchRow): BoardItem {
  const s = side(r.side);
  return {
    id: `watch:${r.id}`,
    source: 'WATCH',
    at: r.created_at.toISOString(),
    symbol: r.underlying,
    instrument: null,
    side: s,
    entry: num(r.level),
    entryNote: `breakout ${s === 'SELL' ? 'below' : 'above'} ${r.level}${r.last_ltp !== null ? ` (last ${r.last_ltp})` : ''}`,
    sl: null,
    slSource: null,
    targets: [],
    targetSource: null,
    state: r.status === 'ACTIVE' ? 'WAITING' : 'SKIPPED',
    status: r.status,
    why: text(r.reason),
    result: null,
    channel: r.channel,
    aiCorrect: null,
  };
}

export interface SignalBoard {
  session: string;
  items: BoardItem[];
  counts: Record<BoardSource, number>;
}

/** Merge, newest first. A news idea that became a setup is shown as the setup (its rationale rides along). */
export function buildBoard(session: string, i: { setups: SetupRow[]; ideas: IdeaRow[]; calls: CallRow[]; watches: WatchRow[]; ideaIdsWithSetup: Set<string> }): SignalBoard {
  const items = [
    ...i.setups.map(setupItem),
    ...i.ideas.filter((x) => !i.ideaIdsWithSetup.has(x.id)).map(ideaItem),
    ...i.calls.map(callItem),
    ...i.watches.map(watchItem),
  ].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const counts: Record<BoardSource, number> = { NIGHT_SETUP: 0, NEWS_IDEA: 0, TELEGRAM: 0, WATCH: 0 };
  for (const x of items) counts[x.source]++;
  return { session, items, counts };
}
