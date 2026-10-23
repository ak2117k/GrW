/**
 * SIGNAL_* configuration (contract §Hard caps). Pure parse, never throws: a bad value falls back to
 * the SAFE default and is reported in `problems`, so a typo can neither stop boot nor widen a cap.
 *
 * The caps are code-enforced and never overridable by the AI judge or a channel: the judge may only
 * tighten (smaller qty, tighter SL); nothing here is read from a signal.
 */
export type SignalTradingMode = 'off' | 'shadow' | 'live';
export type SignalProduct = 'INTRADAY' | 'CARRYFORWARD';

export interface SignalTraderConfig {
  /** off = ingest only (X does nothing); shadow = full pipeline, alert, no order; live = orders. */
  mode: SignalTradingMode;
  /** The owner whose Angel account trades the signals (HUB_OWNER_USER_ID). */
  ownerUserId: string | null;
  maxLots: number;
  /** ₹: (entry − SL) × qty must fit; resized DOWN to fit, 1 lot over → SKIP. */
  maxLossPerTrade: number;
  maxTradesPerDay: number;
  /** ₹: realised + open signal-trade loss today at or beyond this stops new signal trades. */
  dailyLossStop: number;
  /** ₹ notional cap for a cash-equity signal. */
  maxNotional: number;
  /** Lots taken when the signal states no quantity. */
  defaultLots: number;
  /** % band around the signal entry inside which we may still enter (no chasing). */
  entryTolerancePct: number;
  /** % over/under LTP for the marketable LIMIT (clamped inside the tolerance band). */
  limitBufferPct: number;
  /** Minimum minutes left in the session for a new entry. */
  minMinutesToClose: number;
  /** Judge: strong model id. */
  judgeModel: string;
  /** Judge: overall wait (slot wait + call) before SKIP('judge_unavailable'). */
  judgeTimeoutMs: number;
  /** Judge: how long to wait for a NON-reserved model slot. */
  judgeSlotWaitMs: number;
  /** Judge: confidence (1–100) a TAKE needs. */
  judgeMinConfidence: number;
  /** Confidence points a non-conflicting strong cluster adds (conflict clusters get none). */
  strongClusterBoost: number;
  /** agreeCount ≥ this = strong cluster (SIGNAL_STRONG_CHANNELS, shared with stream S). */
  strongChannels: number;
  /** How long a placed LIMIT may rest unfilled before it is cancelled. */
  fillWaitSec: number;
  product: SignalProduct;
  /** Option WRITING (SELL CE/PE) is refused unless explicitly allowed. */
  allowOptionSell: boolean;
  /** % added to the required funds for charges (funds check before a live entry). */
  fundsBufferPct: number;
  /**
   * % of notional assumed as margin for futures / option writing — a CONSERVATIVE ESTIMATE: the
   * codebase has no broker margin-calculator call wired.
   */
  futMarginPct: number;
  problems: string[];
}

export const SIGNAL_DEFAULTS = {
  maxLots: 2,
  maxLossPerTrade: 2000,
  maxTradesPerDay: 3,
  dailyLossStop: 10_000,
  maxNotional: 50_000,
  defaultLots: 1,
  entryTolerancePct: 3,
  limitBufferPct: 0.5,
  minMinutesToClose: 20,
  judgeModel: 'claude-opus-5',
  judgeTimeoutMs: 120_000,
  judgeSlotWaitMs: 45_000,
  judgeMinConfidence: 60,
  strongClusterBoost: 10,
  strongChannels: 3,
  fillWaitSec: 60,
  fundsBufferPct: 1,
  futMarginPct: 25,
} as const;

type Env = Record<string, string | undefined>;

function num(
  env: Env,
  name: string,
  fallback: number,
  ok: (n: number) => boolean,
  problems: string[],
): number {
  const raw = env[name];
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (Number.isFinite(n) && ok(n)) return n;
  problems.push(`${name}=${raw} is invalid — using ${fallback}`);
  return fallback;
}

export function parseSignalTradingMode(raw: string | undefined, problems: string[] = []): SignalTradingMode {
  const v = String(raw ?? '').trim().toLowerCase();
  if (v === '') return 'shadow';
  if (v === 'off' || v === 'shadow' || v === 'live') return v;
  // A typo must never land on live.
  problems.push(`SIGNAL_TRADING=${raw} is not off|shadow|live — using shadow`);
  return 'shadow';
}

export function parseSignalTraderConfig(env: Env): SignalTraderConfig {
  const problems: string[] = [];
  const int = (n: number) => Number.isInteger(n);
  const product = String(env.SIGNAL_PRODUCT ?? '').trim().toUpperCase();
  if (product !== '' && product !== 'INTRADAY' && product !== 'CARRYFORWARD') {
    problems.push(`SIGNAL_PRODUCT=${env.SIGNAL_PRODUCT} is not INTRADAY|CARRYFORWARD — using INTRADAY`);
  }
  return {
    mode: parseSignalTradingMode(env.SIGNAL_TRADING, problems),
    ownerUserId: (env.HUB_OWNER_USER_ID ?? '').trim() || null,
    // Upper bounds keep a typo ("20" for "2") from multiplying the exposure.
    maxLots: num(env, 'SIGNAL_MAX_LOTS', SIGNAL_DEFAULTS.maxLots, (n) => int(n) && n >= 1 && n <= 10, problems),
    maxLossPerTrade: num(env, 'SIGNAL_MAX_LOSS_PER_TRADE', SIGNAL_DEFAULTS.maxLossPerTrade, (n) => n > 0 && n <= 50_000, problems),
    maxTradesPerDay: num(env, 'SIGNAL_MAX_TRADES_PER_DAY', SIGNAL_DEFAULTS.maxTradesPerDay, (n) => int(n) && n >= 0 && n <= 20, problems),
    dailyLossStop: num(env, 'SIGNAL_DAILY_LOSS_STOP', SIGNAL_DEFAULTS.dailyLossStop, (n) => n > 0 && n <= 200_000, problems),
    maxNotional: num(env, 'SIGNAL_MAX_NOTIONAL', SIGNAL_DEFAULTS.maxNotional, (n) => n > 0 && n <= 1_000_000, problems),
    defaultLots: num(env, 'SIGNAL_DEFAULT_LOTS', SIGNAL_DEFAULTS.defaultLots, (n) => int(n) && n >= 1 && n <= 10, problems),
    entryTolerancePct: num(env, 'SIGNAL_ENTRY_TOLERANCE_PCT', SIGNAL_DEFAULTS.entryTolerancePct, (n) => n > 0 && n <= 10, problems),
    limitBufferPct: num(env, 'SIGNAL_LIMIT_BUFFER_PCT', SIGNAL_DEFAULTS.limitBufferPct, (n) => n >= 0 && n <= 3, problems),
    minMinutesToClose: num(env, 'SIGNAL_MIN_MINUTES_TO_CLOSE', SIGNAL_DEFAULTS.minMinutesToClose, (n) => int(n) && n >= 0 && n <= 240, problems),
    judgeModel: (env.SIGNAL_JUDGE_MODEL ?? '').trim() || (env.SENTINEL_MODEL_TRIGGERED ?? '').trim() || SIGNAL_DEFAULTS.judgeModel,
    judgeTimeoutMs: num(env, 'SIGNAL_JUDGE_TIMEOUT_MS', SIGNAL_DEFAULTS.judgeTimeoutMs, (n) => int(n) && n >= 5_000 && n <= 600_000, problems),
    judgeSlotWaitMs: num(env, 'SIGNAL_JUDGE_SLOT_WAIT_MS', SIGNAL_DEFAULTS.judgeSlotWaitMs, (n) => int(n) && n >= 1_000 && n <= 300_000, problems),
    judgeMinConfidence: num(env, 'SIGNAL_JUDGE_MIN_CONFIDENCE', SIGNAL_DEFAULTS.judgeMinConfidence, (n) => n >= 1 && n <= 100, problems),
    strongClusterBoost: num(env, 'SIGNAL_STRONG_CLUSTER_BOOST', SIGNAL_DEFAULTS.strongClusterBoost, (n) => n >= 0 && n <= 30, problems),
    strongChannels: num(env, 'SIGNAL_STRONG_CHANNELS', SIGNAL_DEFAULTS.strongChannels, (n) => int(n) && n >= 2 && n <= 20, problems),
    fillWaitSec: num(env, 'SIGNAL_FILL_WAIT_SEC', SIGNAL_DEFAULTS.fillWaitSec, (n) => int(n) && n >= 5 && n <= 900, problems),
    product: product === 'CARRYFORWARD' ? 'CARRYFORWARD' : 'INTRADAY',
    allowOptionSell: env.SIGNAL_ALLOW_OPTION_SELL === 'true',
    fundsBufferPct: num(env, 'SIGNAL_FUNDS_BUFFER_PCT', SIGNAL_DEFAULTS.fundsBufferPct, (n) => n >= 0 && n <= 10, problems),
    // The lower bound keeps a typo from under-estimating margin.
    futMarginPct: num(env, 'SIGNAL_FUT_MARGIN_PCT', SIGNAL_DEFAULTS.futMarginPct, (n) => n >= 5 && n <= 100, problems),
    problems,
  };
}
