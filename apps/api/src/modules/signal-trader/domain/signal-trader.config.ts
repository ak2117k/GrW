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
  /** SIGNAL_ENTRY_RETRY_MIN: a TAKE short of funds or just outside its price band keeps being tried this long. 0 = give up at once. */
  entryRetryMin: number;
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
  /**
   * PAPER learning mode (owner 2026-10-27, 'for some days'): every call is paper-traded whatever the AI
   * judge says, with no stop and no risk caps (exit at T1 / the close / the horizon rules), and the
   * judge's verdict is checked against the result. Paper only; SIGNAL_PAPER_LEARN=off ends it.
   */
  paperLearn: boolean;
  /**
   * SIGNAL_LIVE_UNDERLYINGS (2026-11-03, owner going live): comma list of underlyings a live TAKE may be
   * sent for; any other TAKE is paper-traded instead. Empty = every underlying (the old behaviour).
   */
  liveUnderlyings: string[];
  /**
   * SIGNAL_RISK_CAP_GATE (default on; 2026-11-03 owner: "silence the risk-reward for now"). off: a call whose
   * 1-lot risk breaks maxLossPerTrade is still taken at 1 lot (as paper does) — the loss is capped at the exit
   * by HARD_LOSS_EXIT_RUPEES instead (exit-discipline/hard-floor.ts).
   */
  riskCapGate: boolean;
  /**
   * SIGNAL_LIVE_KINDS (2026-11-03, owner: "live = options only"): the instrument kinds a live TAKE may be sent
   * for — OPT (= CE and PE), CE, PE, FUT, EQ; comma list. Default OPT. A live TAKE on any other kind (a future,
   * a cash share) is paper-traded on the learning path instead, never sent. Option WRITING stays refused by
   * allowOptionSell, so OPT means option buys.
   */
  liveKinds: SignalLiveKind[];
  /**
   * SIGNAL_LIVE_FROM_IST (2026-11-03, owner: opening swings / event days — the US election results land the
   * morning of 4 Nov): minutes after IST midnight before which a live TAKE is paper-traded instead of sent.
   * Default 09:45. Paper trading itself still runs from the open. One rule for every venue (MCX included).
   */
  liveFromIstMin: number;
  /**
   * SIGNAL_JUDGE_DEFAULT=take|skip (2026-11-04, owner approved). The judge's default when the evidence is
   * neither for nor against. Over 21 days the judge SKIPped 65 of 70 channel calls; its scored skips were
   * 11 right (−₹9.3k avoided) vs 13 wrong (+₹34.6k missed), and on 4 Nov it SKIPped a GOLD CE that ran +53%
   * citing unavailable chain/VIX and "mixed news".
   *   take (default): prompt signal-judge-v7-take — TAKE unless there is concrete evidence against; missing
   *                   data / mixed news are no reason to SKIP; the packet carries `events` (event days).
   *   skip: today's behaviour exactly — prompt signal-judge-v5 byte for byte, no `events` in the packet.
   * Rollback: SIGNAL_JUDGE_DEFAULT=skip + restart. A typo lands on skip (the conservative value, reported).
   */
  judgeDefault: SignalJudgeDefault;
  problems: string[];
}

export type SignalJudgeDefault = 'take' | 'skip';

/** SIGNAL_JUDGE_DEFAULT: unset = take; a value that is not take|skip = skip (fewer real orders), reported. */
export function parseJudgeDefault(raw: string | undefined, problems: string[]): SignalJudgeDefault {
  const v = String(raw ?? '').trim().toLowerCase();
  if (v === '') return 'take';
  if (v === 'take' || v === 'skip') return v;
  problems.push(`SIGNAL_JUDGE_DEFAULT=${raw} is not take|skip — using skip`);
  return 'skip';
}

/** The reader shape of the self-review tunables (self-review/tuning/tunables.ts TuningReader). */
export type SignalTuningReader = { get<T extends number | boolean>(target: string, fallback: T): T };

/**
 * Self-review overrides of the judge (2026-11-05 wrong-decision loop, S7): `signal.judgeMinConfidence`
 * (integer 50–80) and `signal.judgeDefaultTake` (boolean) — read from the SESSION-OPEN reader, so a change
 * lands at the next session's open. Bounded again here: a bad / throwing answer keeps the env value.
 * No reader, or no override ⇒ `cfg` itself (exactly SIGNAL_JUDGE_MIN_CONFIDENCE / SIGNAL_JUDGE_DEFAULT).
 */
export function withSignalTuning(cfg: SignalTraderConfig, tuning: SignalTuningReader | null | undefined): SignalTraderConfig {
  if (!tuning) return cfg;
  let minConf = cfg.judgeMinConfidence;
  let takeDefault = cfg.judgeDefault === 'take';
  try {
    const v = tuning.get('signal.judgeMinConfidence', cfg.judgeMinConfidence);
    if (Number.isInteger(v) && v >= 50 && v <= 80) minConf = v;
  } catch {
    /* keep the env value */
  }
  try {
    const v = tuning.get('signal.judgeDefaultTake', takeDefault);
    if (typeof v === 'boolean') takeDefault = v;
  } catch {
    /* keep the env value */
  }
  const judgeDefault: SignalJudgeDefault = takeDefault ? 'take' : 'skip';
  return minConf === cfg.judgeMinConfidence && judgeDefault === cfg.judgeDefault ? cfg : { ...cfg, judgeMinConfidence: minConf, judgeDefault };
}

/** The SIGNAL_LIVE_KINDS kinds (the token OPT expands to CE + PE). */
export type SignalLiveKind = 'CE' | 'PE' | 'FUT' | 'EQ';

/** Why a live-mode TAKE is paper-traded instead of sent (the live allowlists); null = it may be sent. */
export interface LiveRouteBlock {
  reason: 'live_underlying' | 'live_kind' | 'live_before_start' | 'delayed_no_room';
  detail: string;
}

/** Learning mode is on: paper trading with SIGNAL_PAPER_LEARN on. */
export function learning(cfg: Pick<SignalTraderConfig, 'mode' | 'paperLearn'>): boolean {
  return cfg.mode === 'paper' && cfg.paperLearn === true;
}

/** Live with SIGNAL_PAPER_LEARN on: a judge SKIP that passed the gate still opens its learning PAPER trade. */
export function liveLearning(cfg: Pick<SignalTraderConfig, 'mode' | 'paperLearn'>): boolean {
  return cfg.mode === 'live' && cfg.paperLearn === true;
}

/** May a live TAKE on this underlying be sent to the broker (SIGNAL_LIVE_UNDERLYINGS)? */
export function liveAllowedFor(cfg: Pick<SignalTraderConfig, 'liveUnderlyings'>, underlying: string): boolean {
  return cfg.liveUnderlyings.length === 0 || cfg.liveUnderlyings.includes(String(underlying ?? '').trim().toUpperCase());
}

const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

/** Minutes after IST midnight of `now`. */
export function istMinuteOfDay(now: Date): number {
  const m = Math.floor((now.getTime() + 330 * 60_000) / 60_000) % 1440;
  return m < 0 ? m + 1440 : m;
}

/**
 * May this live TAKE be sent to the broker? Pure. Asked in act() for a live-mode TAKE at the moment it would
 * be sent (a trigger that fires later is asked at its fire time): SIGNAL_LIVE_UNDERLYINGS, then
 * SIGNAL_LIVE_KINDS, then SIGNAL_LIVE_FROM_IST. A block routes the call to the paper path — never live — and
 * is recorded on the decision's judge record as `liveRouted`.
 */
export function liveRouteBlock(
  cfg: Pick<SignalTraderConfig, 'liveUnderlyings' | 'liveKinds' | 'liveFromIstMin'>,
  s: { underlying: string; instrumentKind: string },
  now: Date,
): LiveRouteBlock | null {
  if (!liveAllowedFor(cfg, s.underlying)) {
    return { reason: 'live_underlying', detail: `${s.underlying} is not on SIGNAL_LIVE_UNDERLYINGS (${cfg.liveUnderlyings.join(',')}) — paper-traded` };
  }
  const kind = String(s.instrumentKind ?? '').trim().toUpperCase();
  if (!(cfg.liveKinds as string[]).includes(kind)) {
    return { reason: 'live_kind', detail: `${kind || 'unknown kind'} is not on SIGNAL_LIVE_KINDS (${cfg.liveKinds.join(',')}) — paper-traded` };
  }
  const at = istMinuteOfDay(now);
  if (at < cfg.liveFromIstMin) {
    return { reason: 'live_before_start', detail: `${hhmm(at)} IST is before SIGNAL_LIVE_FROM_IST ${hhmm(cfg.liveFromIstMin)} — paper-traded` };
  }
  return null;
}

/** SIGNAL_LIVE_KINDS: OPT = CE + PE; an unknown token is reported and dropped; nothing usable = the default (OPT). */
export function parseLiveKinds(raw: string | undefined, problems: string[]): SignalLiveKind[] {
  const out = new Set<SignalLiveKind>();
  const tokens = String(raw ?? '').split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);
  for (const t of tokens) {
    if (t === 'OPT') {
      out.add('CE');
      out.add('PE');
    } else if (t === 'CE' || t === 'PE' || t === 'FUT' || t === 'EQ') out.add(t);
    else problems.push(`SIGNAL_LIVE_KINDS entry ${t} is not OPT|CE|PE|FUT|EQ — ignored`);
  }
  if (out.size > 0) return [...out];
  // Never wider than the default: a typo lands on options only, not on every kind.
  if (tokens.length > 0) problems.push(`SIGNAL_LIVE_KINDS=${raw} has no usable kind — using OPT`);
  return ['CE', 'PE'];
}

/** SIGNAL_LIVE_FROM_IST "HH:MM" → minutes after IST midnight; a bad value = the default 09:45 (reported). */
export function parseLiveFromIst(raw: string | undefined, problems: string[]): number {
  const v = String(raw ?? '').trim();
  const d = SIGNAL_DEFAULTS.liveFromIstMin;
  if (v === '') return d;
  const m = /^(\d{1,2}):(\d{2})$/.exec(v);
  if (m && Number(m[1]) <= 23 && Number(m[2]) <= 59) return Number(m[1]) * 60 + Number(m[2]);
  problems.push(`SIGNAL_LIVE_FROM_IST=${raw} is not HH:MM — using ${hhmm(d)}`);
  return d;
}

/** The boot line's view of the live allowlists. */
export function liveRouteSummary(cfg: Pick<SignalTraderConfig, 'liveUnderlyings' | 'liveKinds' | 'liveFromIstMin'>): string {
  return `liveUnderlyings=${cfg.liveUnderlyings.length ? cfg.liveUnderlyings.join(',') : 'all'} liveKinds=${cfg.liveKinds.join(',')} liveFrom=${hhmm(cfg.liveFromIstMin)} IST`;
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
  entryRetryMin: 5,
  judgeReuseMin: 10,
  engineSlOptionPct: 25,
  engineSlBufferPct: 0.15,
  lateMaxPct: 40,
  /** SIGNAL_LIVE_FROM_IST: 09:45 IST. */
  liveFromIstMin: 9 * 60 + 45,
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
    entryRetryMin: num(env, 'SIGNAL_ENTRY_RETRY_MIN', SIGNAL_DEFAULTS.entryRetryMin, (n) => int(n) && n >= 0 && n <= 10, problems),
    judgeReuseMin: num(env, 'SIGNAL_JUDGE_REUSE_MIN', SIGNAL_DEFAULTS.judgeReuseMin, (n) => n >= 0 && n <= 10, problems),
    engineSl: parseOnOff(env.SIGNAL_ENGINE_SL, true, 'SIGNAL_ENGINE_SL', problems),
    // Bounds: a typo can make the % stop neither absurdly wide nor zero.
    engineSlOptionPct: num(env, 'SIGNAL_ENGINE_SL_OPTION_PCT', SIGNAL_DEFAULTS.engineSlOptionPct, (n) => n >= 5 && n <= 50, problems),
    engineSlBufferPct: num(env, 'SIGNAL_ENGINE_SL_BUFFER_PCT', SIGNAL_DEFAULTS.engineSlBufferPct, (n) => n >= 0 && n <= 2, problems),
    lateEntry: parseOnOff(env.SIGNAL_LATE_ENTRY, true, 'SIGNAL_LATE_ENTRY', problems),
    lateMaxPct: num(env, 'SIGNAL_LATE_MAX_PCT', SIGNAL_DEFAULTS.lateMaxPct, (n) => n > 0 && n <= 100, problems),
    paperLearn: parseOnOff(env.SIGNAL_PAPER_LEARN, false, 'SIGNAL_PAPER_LEARN', problems),
    riskCapGate: parseOnOff(env.SIGNAL_RISK_CAP_GATE, true, 'SIGNAL_RISK_CAP_GATE', problems),
    liveUnderlyings: String(env.SIGNAL_LIVE_UNDERLYINGS ?? '').split(',').map((x) => x.trim().toUpperCase()).filter(Boolean),
    liveKinds: parseLiveKinds(env.SIGNAL_LIVE_KINDS, problems),
    liveFromIstMin: parseLiveFromIst(env.SIGNAL_LIVE_FROM_IST, problems),
    judgeDefault: parseJudgeDefault(env.SIGNAL_JUDGE_DEFAULT, problems),
    problems,
  };
}
