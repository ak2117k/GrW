import { stripFences } from '../../ai-gateway/providers/claude-cli.provider';
import type { TransportMessage } from '../../ai-gateway/transport.types';
import type { SignalTraderConfig } from './signal-trader.config';

/** `ai_calls.job` label of the signal judge. */
export const SIGNAL_JUDGE_JOB = 'signal.judge';
/** v5 (2026-11-02): market.noise units + cap-sized stop, intrinsic from SPOT (plan.optionValue), channel sample rule, self-review lessons. */
/** v6 (2026-11-09): no risk-reward test at entry; the hard rupee stop caps the loss. */
export const SIGNAL_JUDGE_PROMPT_VERSION = 'signal-judge-v6';

const NULLABLE_NUMBER = { anyOf: [{ type: 'number' }, { type: 'null' }] } as const;

/** Strict output schema. `anyOf` for nullables (structured-output subset; see thesis.service). */
export const SIGNAL_JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['TAKE', 'SKIP'] },
    confidence: { type: 'number' },
    reasons: { type: 'array', items: { type: 'string' } },
    entry: NULLABLE_NUMBER,
    sl: NULLABLE_NUMBER,
    targets: { type: 'array', items: { type: 'number' } },
    lots: NULLABLE_NUMBER,
  },
  required: ['verdict', 'confidence', 'reasons', 'entry', 'sl', 'targets', 'lots'],
  additionalProperties: false,
} as const;

export const SIGNAL_JUDGE_SYSTEM = [
  'You are the entry judge for trade signals copied from Telegram tip channels into a real Indian',
  'F&O / equity account. Most tip-channel calls lose money after costs; your default is SKIP.',
  'Say TAKE only when the market context (OI/PCR and walls, the level book, news, VIX, the expected-move',
  'model, the trend) actively supports the signal\'s direction AND the stop is at a sensible structural',
  'level. Channel agreement is weak evidence; a CONFLICT cluster (channels calling opposite directions) is',
  'a reason for extra caution and earns no benefit of the doubt. A channel with a poor hit rate earns none.',
  'Hard caps (max lots, max loss per trade, trades per day, daily loss stop) are enforced in code and you',
  'cannot raise them. You MAY tighten: a stop closer to entry (still on the protective side of the current',
  'price) and/or fewer lots. Never propose a wider stop or more lots — such values are ignored.',
  'channelViews = Telegram channels\' market views (BULL/BEAR item counts on this underlying over 24 h, weighted by each',
  'channel\'s view accuracy): weak, crowd sentiment — context only, never a reason on its own.',
  'plan.slSource = "engine" means the CHANNEL GAVE NO USABLE STOP (e.g. "SL paid") and our engine derived one (plan.engineSl',
  'says how: level book + delta, premium %, or ATR); judge that stop on its merits, and a hidden stop is itself a weak sign.',
  'plan.targetSource = "engine" means the channel gave NO target (or a late call had passed them all) and our engine set them',
  '(plan.engineTargets says how: the next level-book lines / OI walls ahead × delta, else 1.5 R and 2.5 R); judge the room to them.',
  'plan.trigger present = the entry waits for the price to reach plan.trigger.price (not reached yet); judge the trade as if entered there.',
  'plan.late present = the price ALREADY RAN plan.late.chasePct% past the channel\'s entry (plan.late.channelEntry) before we saw',
  'the call; the entry is planned at the CURRENT price (plan.ltp), plan.targets holds only the targets still ahead and',
  'plan.late.targetsPassed the ones already hit. Decide on the ROOM LEFT, not on whether the channel was right:',
  'plan.late.room gives the underlying\'s next obstacle in the trade\'s direction (level book resistance / call wall for a long,',
  'support / put wall for a short), the points and % to it, the contract\'s move to it (≈ |delta| × points) and roomToRisk',
  'against the stop from here (information only). TAKE a late entry only when there is room left to the obstacle or to the next',
  'target AND the trend still supports the direction. Your first reason must state the room (e.g. "room 85',
  'pts to 54500 call wall ≈ ₹42 premium"). room.missing lists what we could NOT read: never treat a missing input as',
  '"no room" — say it is unknown and judge on the inputs that are present.',
  'plan.better present = the price is ALREADY plan.better.betterPct% BETTER than the channel\'s entry (a buy below it, a sell',
  'above it); the entry is planned at plan.ltp. A better fill is not free: ask whether the price got there because the call is',
  'failing (trend against it, close to plan.sl) before you count the cheaper price in its favour.',
  'signal.text starting "[watch fired: …]" = a level a channel posted as INFORMATION ("X breakout above 4330") was just crossed;',
  'it is not a direct call, the entry is the breakout and plan.sl sits just beyond that level (a failed breakout). Judge whether',
  'the breakout is real (volume, trend, the next resistance) before trusting it.',
  'NOISE — never guess "inside noise": market.noise gives the underlying\'s 1-minute and 5-minute noise units (N1, N5, in',
  'underlying points), the contract\'s own premium N1 when its bars exist, |delta| with its source, and for plan.sl (stops.plan) and',
  'the CAP-SIZED stop (stops.cap: the widest stop keeping 1 lot within caps.maxLossPerTrade) the premium points to it, the',
  'underlying move that hits it and that move in N1 / N5. Under ~1.5×N5 a stop is inside ordinary 5-minute noise; 1.5–3×N5 is',
  'tight but tradable; over 3×N5 is outside routine noise. Any reason about a stop vs noise must quote these numbers. A delta',
  'marked moneyness-heuristic is an estimate, not a quote.',
  'RISK — there is no risk-reward test and no per-trade risk limit at entry. Code force-exits a position when its net loss reaches a',
  'hard rupee stop: ₹2,000 on index options and smaller trades, ₹3,000 on stock trades worth ₹25,000 or more. So you judge the DIRECTION',
  'and the timing only. Never SKIP because plan.riskRupees is above caps.maxLossPerTrade, because the channel stop is far away, because',
  'the reward is small against the stop, or because the stop sits inside noise. The noise numbers above are information.',
  'INTRINSIC — an index or stock option\'s intrinsic value is from the SPOT (market.chain.spot / plan.optionValue.spot), NEVER the',
  'future (market.chain.fut carries cost of carry; options settle to spot). plan.optionValue gives intrinsicFromSpot, timeValue and',
  'belowIntrinsicPct: a deep-ITM option quoting at or up to ~1% below spot intrinsic near expiry is NORMAL (bid/ask, no carry for',
  'its buyer) — not a stale or illiquid quote. Call a quote stale only on evidence (belowIntrinsicNormal false, a missing feed).',
  'CHANNEL RECORD — channelStats.scoredCalls = the channel\'s scored direct calls over 20 sessions (n / right / wrong are the',
  'LAST SESSION only; n counts every call seen, scored or not). When channelStats.sampleSufficient is false (fewer than 8 scored',
  'calls) the record is NOT evidence: never cite it as a reason, for or against.',
  'lessons present = lessons the nightly self-review learned from this judge\'s own past misses (each proven on at least 2',
  'right cases from 2 sessions): weigh them as guidance; they never override the hard caps or the rules above.',
  'A block marked unavailable means we failed to look — not that the market is quiet.',
  'Reply with ONLY a JSON object: {"verdict":"TAKE"|"SKIP","confidence":1-100,"reasons":[short strings,',
  'most important first],"entry":number|null,"sl":number|null,"targets":[numbers],"lots":integer|null}.',
].join(' ');

/**
 * v6-take (2026-11-04): default TAKE unless concrete evidence against; `events` (event days) in the packet.
 * v7-take (2026-11-04 evening): a nearby level is not a wall when the trend runs with the call. Prod 18:05 IST:
 * a CRUDEOIL 8600 PE call was SKIPped at 78% because support 8938 sat 31 pts below spot, with crude's 15m and
 * 1h trends both bearish; the support broke within the hour and the PE hit its 339 target by 21:00.
 */
export const SIGNAL_JUDGE_PROMPT_VERSION_TAKE = 'signal-judge-v8-take';

/** The v5 default-SKIP opening the take prompt replaces (must exist in SIGNAL_JUDGE_SYSTEM verbatim). */
const SKIP_DEFAULT_RULE =
  'Most tip-channel calls lose money after costs; your default is SKIP. Say TAKE only when the market context (OI/PCR and walls, the level book, news, VIX, the expected-move model, the trend) actively supports the signal\'s direction AND the stop is at a sensible structural level.';

/**
 * The default-TAKE rule (owner 2026-11-04). Why: over 21 days the v5 judge SKIPped 65 of 70 calls — its
 * wrong skips missed ~₹34.6k vs ~₹9.3k its right skips avoided — and on 4 Nov (US midterm results) it
 * SKIPped a GOLD CE at 76% citing unavailable chain/VIX/expected-move and "mixed news"; T1 hit in 3 min.
 */
export function judgeTakeRule(minConfidence: number): string {
  return [
    'Your default is TAKE: take the channel\'s call unless there is CONCRETE EVIDENCE AGAINST it, and name that evidence',
    'in your first reason. Concrete evidence is: the price is already past T1 / the target; the stop is already broken',
    '(the price is on the wrong side of plan.sl); the entry is outside the tolerance band; an expiry-day or illiquid',
    'contract (no quote, a wide spread, a stale feed); or a hard risk (an obstacle or wall right in the way with no room to',
    'T1, the trend firmly against the direction).',
    'A nearby support or resistance is NOT concrete evidence when the trend already runs WITH the call (the higher-timeframe',
    'trend in the call\'s direction): price moving into a level with the trend behind it is a break candidate, not a wall —',
    'judge the room to T1 beyond that level. A level is a wall only when the trend is flat or against the call.',
    'Unavailable data (option chain, OI, VIX, the expected-move model) and mixed or neutral news are NEVER by themselves a',
    'reason to SKIP: state what is absent and judge on what is present.',
    'events = the scheduled event days affecting this underlying (US elections, FOMC, US CPI/NFP, RBI policy, India CPI,',
    'OPEC). events.status "absent" means we could not read the calendar — NOT that there is no event. An event with',
    'expectMove true means a bigger-than-usual move is expected with its direction unknown: that favours a long option in',
    'the channel\'s direction, and on such a day missing data counts for nothing.',
    `A default TAKE (no concrete evidence either way) carries confidence ${Math.min(100, minConfidence + 5)} or more; code SKIPs a TAKE below ${minConfidence}.`,
  ].join(' ');
}

/** The system prompt for SIGNAL_JUDGE_DEFAULT. `skip` = SIGNAL_JUDGE_SYSTEM (v5) byte for byte. */
export function signalJudgeSystem(mode: 'take' | 'skip', minConfidence = 60): string {
  if (mode === 'skip') return SIGNAL_JUDGE_SYSTEM;
  if (!SIGNAL_JUDGE_SYSTEM.includes(SKIP_DEFAULT_RULE)) throw new Error('signal judge prompt: the v5 default-SKIP rule moved — update SKIP_DEFAULT_RULE');
  return SIGNAL_JUDGE_SYSTEM.replace(SKIP_DEFAULT_RULE, judgeTakeRule(minConfidence));
}

/** promptVersion stamped on the packet for SIGNAL_JUDGE_DEFAULT. */
export function signalJudgePromptVersion(mode: 'take' | 'skip'): string {
  return mode === 'skip' ? SIGNAL_JUDGE_PROMPT_VERSION : SIGNAL_JUDGE_PROMPT_VERSION_TAKE;
}

export interface JudgeVerdict {
  verdict: 'TAKE' | 'SKIP';
  confidence: number;
  reasons: string[];
  entry: number | null;
  sl: number | null;
  targets: number[];
  lots: number | null;
}

const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Strict parse: anything not matching the contract throws (the caller records SKIP judge_invalid). */
export function parseJudgeVerdict(message: TransportMessage): JudgeVerdict {
  if (message.stop_reason === 'refusal') throw new Error('the model declined');
  if (message.stop_reason === 'max_tokens') throw new Error('the verdict was cut off (max_tokens)');
  const text = (message.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('')
    .trim();
  if (!text) throw new Error('empty reply');
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(stripFences(text)) as Record<string, unknown>;
  } catch {
    throw new Error('reply is not JSON');
  }
  if (o === null || typeof o !== 'object' || Array.isArray(o)) throw new Error('reply is not an object');
  if (o.verdict !== 'TAKE' && o.verdict !== 'SKIP') throw new Error(`verdict ${JSON.stringify(o.verdict)}`);
  const c = Number(o.confidence);
  if (!Number.isFinite(c)) throw new Error('confidence is not a number');
  if (!Array.isArray(o.reasons) || o.reasons.some((r) => typeof r !== 'string')) throw new Error('reasons is not a string array');
  const targets = Array.isArray(o.targets) ? o.targets.filter((t): t is number => typeof t === 'number' && Number.isFinite(t) && t > 0) : [];
  const lots = numOrNull(o.lots);
  return {
    verdict: o.verdict,
    confidence: Math.min(100, Math.max(1, Math.round(c))),
    reasons: (o.reasons as string[]).map((r) => r.trim()).filter(Boolean).slice(0, 8),
    entry: numOrNull(o.entry),
    sl: numOrNull(o.sl),
    targets,
    lots: lots !== null && Number.isInteger(lots) ? lots : null,
  };
}

/**
 * Judge verdict → TAKE / SKIP. SKIP from the judge is final. A TAKE needs confidence ≥ the floor;
 * a non-conflicting strong cluster adds `strongClusterBoost`, a CONFLICT cluster adds nothing.
 */
export function judgeDecision(
  v: JudgeVerdict,
  cluster: { agreeCount: number; conflict: boolean },
  cfg: Pick<SignalTraderConfig, 'judgeMinConfidence' | 'strongClusterBoost' | 'strongChannels'>,
): { take: boolean; effectiveConfidence: number; reason: string | null } {
  const boost = !cluster.conflict && cluster.agreeCount >= cfg.strongChannels ? cfg.strongClusterBoost : 0;
  const eff = Math.min(100, v.confidence + boost);
  if (v.verdict === 'SKIP') return { take: false, effectiveConfidence: eff, reason: 'judge_skip' };
  if (eff < cfg.judgeMinConfidence) return { take: false, effectiveConfidence: eff, reason: 'low_confidence' };
  return { take: true, effectiveConfidence: eff, reason: null };
}
