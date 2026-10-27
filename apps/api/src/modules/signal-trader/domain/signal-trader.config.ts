/**
 * SIGNAL_* configuration (contract §Hard caps). Pure parse, never throws: a bad value falls back to
 * the SAFE default and is reported in `problems`, so a typo can neither stop boot nor widen a cap.
 *
 * The caps are code-enforced and never overridable by the AI judge or a channel: the judge may only
 * tighten (smaller qty, tighter SL); nothing here is read from a signal.
 */
export type SignalTradingMode = 'off' | 'shadow' | 'paper' | 'live';
export type SignalProduct = 'INTRADAY' | 'CARRYFORWARD';

export interface SignalTraderConfig {
  /**
   * off = ingest only (X does nothing); shadow = full pipeline, alert, no order; paper = full
   * pipeline, the judge on every planned call, and every TAKE opened as a paper trade (never the
   * broker; the risk cap / daily caps are warnings so each call is tested); live = orders.
   */
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
   * % of notional assumed as margin for futures / option writing — the FALLBACK estimate, used only
   * when the broker margin calculator (SmartAPI marginApi) cannot be read.
   */
  futMarginPct: number;
  /**
   * "BUY ABOVE x / SELL BELOW x" not reached yet: minutes a signal that passes every other check
   * waits (decision PENDING) for its trigger before SKIP('trigger_expired'). 0 = no waiting (SKIP at
   * once, the old behaviour). Never past the min-minutes-to-close cutoff.
   */
  triggerWaitMin: number;
  /** At most this many armed triggers at once (owner cap: 5). */
  triggerMaxPending: number;
  /** Seconds between LTP polls of one armed trigger (never below 5). */
  triggerPollSec: number;
  /** When a trigger fires, a judge verdict older than this (minutes) is asked again. */
  judgeReuseMin: number;
  /** Engine-derived SL when the channel hides it (level book → delta / premium % / ATR). */
  engineSl: boolean;
  /** Engine SL for options without level+delta: % of the premium. */
  engineSlOptionPct: number;
  /** Buffer beyond the protective level, % of the underlying price. */
  engineSlBufferPct: number;
  /**
   * The price already ran past the channel's entry (owner 2026-10-27): plan at the current price
   * and let the judge decide on the room left, instead of a hard "chasing" SKIP. Off = the old SKIP.
   */
  lateEntry: boolean;
  /** Beyond this % past the channel's entry the move is done (or the contract mistyped): SKIP. */
  lateMaxPct: number;
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
  triggerWaitMin: 30,
  triggerMaxPending: 5,
  triggerPollSec: 5,
  judgeReuseMin: 10,
  engineSlOptionPct: 25,
  engineSlBufferPct: 0.15,
  lateMaxPct: 40,
} as const;

function parseOnOff(raw: string | undefined, fallback: boolean, name: string, problems: string[]): boolean {
  const v = String(raw ?? '').trim().toLowerCase();
  if (v === '') return fallback;
  if (v === 'on' || v === 'true' || v === '1') return true;
  if (v === 'off' || v === 'false' || v === '0') return false;
  problems.push(`${name}=${raw} is not on|off — using ${fallback ? 'on' : 'off'}`);
  return fallback;
}

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
  if (v === 'off' || v === 'shadow' || v === 'paper' || v === 'live') return v;
  // A typo must never land on live.
  problems.push(`SIGNAL_TRADING=${raw} is not off|shadow|paper|live — using shadow`);
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
    triggerWaitMin: num(env, 'SIGNAL_TRIGGER_WAIT_MIN', SIGNAL_DEFAULTS.triggerWaitMin, (n) => int(n) && n >= 0 && n <= 120, problems),
    // Owner cap: never more than 5 watched at once.
    triggerMaxPending: num(env, 'SIGNAL_TRIGGER_MAX_PENDING', SIGNAL_DEFAULTS.triggerMaxPending, (n) => int(n) && n >= 1 && n <= 5, problems),
    triggerPollSec: num(env, 'SIGNAL_TRIGGER_POLL_SEC', SIGNAL_DEFAULTS.triggerPollSec, (n) => int(n) && n >= 5 && n <= 60, problems),
    judgeReuseMin: num(env, 'SIGNAL_JUDGE_REUSE_MIN', SIGNAL_DEFAULTS.judgeReuseMin, (n) => n >= 0 && n <= 10, problems),
    engineSl: parseOnOff(env.SIGNAL_ENGINE_SL, true, 'SIGNAL_ENGINE_SL', problems),
    // Bounds: a typo can make the % stop neither absurdly wide nor zero.
    engineSlOptionPct: num(env, 'SIGNAL_ENGINE_SL_OPTION_PCT', SIGNAL_DEFAULTS.engineSlOptionPct, (n) => n >= 5 && n <= 50, problems),
    engineSlBufferPct: num(env, 'SIGNAL_ENGINE_SL_BUFFER_PCT', SIGNAL_DEFAULTS.engineSlBufferPct, (n) => n >= 0 && n <= 2, problems),
    lateEntry: parseOnOff(env.SIGNAL_LATE_ENTRY, true, 'SIGNAL_LATE_ENTRY', problems),
    lateMaxPct: num(env, 'SIGNAL_LATE_MAX_PCT', SIGNAL_DEFAULTS.lateMaxPct, (n) => n > 0 && n <= 100, problems),
    problems,
  };
}
