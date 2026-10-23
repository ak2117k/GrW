import { stripFences } from '../../ai-gateway/providers/claude-cli.provider';
import type { TransportMessage } from '../../ai-gateway/transport.types';
import type { SignalTraderConfig } from './signal-trader.config';

/** `ai_calls.job` label of the signal judge. */
export const SIGNAL_JUDGE_JOB = 'signal.judge';
export const SIGNAL_JUDGE_PROMPT_VERSION = 'signal-judge-v1';

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
  'A block marked unavailable means we failed to look — not that the market is quiet.',
  'Reply with ONLY a JSON object: {"verdict":"TAKE"|"SKIP","confidence":1-100,"reasons":[short strings,',
  'most important first],"entry":number|null,"sl":number|null,"targets":[numbers],"lots":integer|null}.',
].join(' ');

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
