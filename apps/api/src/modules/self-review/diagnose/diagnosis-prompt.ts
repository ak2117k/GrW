/**
 * The one batched diagnosis call per self-review run: system prompt, user message builder
 * (with the contract's caps) and the strict reply validator. Pure — no I/O.
 */
import { clampText, isLessonKey, isLessonScope } from '../lessons/lessons.logic';
import { LESSON_TEXT_MAX, type LessonRecord } from '../lessons/types';
import { MISS_CATEGORIES, type DiagnosedMiss, type MissCategory, type MissInput } from './types';

/** Bump when the prompt text or the schema changes; stored on the run's diagnosis. */
export const DIAGNOSIS_PROMPT_VERSION = 'd1';

/** At most this many misses go into one call (contract). */
export const MAX_MISSES = 15;
/** Output budget (contract: ≤ ~3k). */
export const DIAGNOSIS_MAX_TOKENS = 3000;
/**
 * Input budget: ~30k tokens. At ~4 chars a token, the user message is held under 100k
 * chars, leaving room for the system prompt.
 */
export const USER_MESSAGE_MAX_CHARS = 100_000;
/** Per-miss caps, halved until the message fits. */
const INPUTS_EXCERPT_MAX = 6000;
const DETAILS_EXCERPT_MAX = 1200;
const CAUSE_MAX = 500;
const MAX_ACTIVE_LESSONS_SHOWN = 30;

export const DIAGNOSIS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['misses'],
  properties: {
    misses: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['refIds', 'cause', 'category'],
        properties: {
          refIds: { type: 'array', items: { type: 'string' } },
          cause: { type: 'string' },
          category: { type: 'string', enum: [...MISS_CATEGORIES] },
          lessonKey: { type: 'string' },
          lessonText: { type: 'string' },
          scope: { type: 'string', enum: ['SENTINEL_LIVE', 'SENTINEL_OVERNIGHT', 'NEWS_IDEAS', 'ALL'] },
          contradicts: { type: 'array', items: { type: 'string' } },
          proposalTarget: { type: 'string' },
          proposedValue: { anyOf: [{ type: 'number' }, { type: 'boolean' }] },
        },
      },
    },
  },
} as const;

export const DIAGNOSIS_SYSTEM_PROMPT = [
  'You review the WRONG calls an automated trading assistant for the Indian market made in one session, after the outcome is known.',
  'Each miss has: kind (SCORECARD_TOTAL, SCORECARD_FACTOR, OVERNIGHT_VERDICT, LIVE_EXIT, NEWS_IDEA, MBM_PREDICTION), refId, symbol, what was predicted, what actually happened, a signed score where meaningful, and an excerpt of the inputs the call was made from.',
  'You also get the lessons already in force (key, text, scope, right/wrong counts).',
  'For each miss, or group of misses with the same cause, return one entry:',
  '- refIds: the refIds it explains, copied exactly from the input.',
  '- cause: one or two sentences naming what in the inputs misled the call, or that the inputs could not have known (then category NOISE or DATA_MISSING).',
  `- category: one of ${MISS_CATEGORIES.join(', ')}.`,
  '- lessonKey (optional): a lowercase-hyphenated slug (3–60 chars) for a lesson that, had it been followed, would have avoided these misses. REUSE an existing key when the same pattern recurs; invent a new key only for a genuinely new pattern.',
  `- lessonText (optional, required for a NEW key): one or two imperative sentences under ${LESSON_TEXT_MAX} characters, specific enough to act on (name the factor, window or condition).`,
  '- scope (optional): which agent the lesson is for — SENTINEL_LIVE (intraday exits), SENTINEL_OVERNIGHT (overnight hold/exit verdicts), NEWS_IDEAS (news-driven trade ideas), or ALL.',
  '- contradicts (optional): keys of EXISTING lessons that these misses followed, or would have followed, and that were therefore wrong here.',
  '- proposalTarget / proposedValue (optional): a tunable you suspect should change, e.g. scorecard.factor.news.weight 0.5. These are suggestions only; code decides.',
  'Rules: no lesson for NOISE; never a lesson or proposal that loosens a hard risk limit (max daily loss, position size, kill switch, stop or green floor); do not invent data that is not in the input; one miss may be left without a lesson.',
  'Answer ONLY with JSON: {"misses":[{"refIds","cause","category","lessonKey?","lessonText?","scope?","contradicts?","proposalTarget?","proposedValue?"}]}.',
].join('\n');

function excerpt(value: unknown, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  let s: string;
  try {
    s = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    s = String(value);
  }
  return s.length <= max ? s : `${s.slice(0, max)}…[cut ${s.length - max} chars]`;
}

/** The misses actually sent: the cap keeps the largest |score| first (the costliest misses). */
export function capMisses(misses: readonly MissInput[], max = MAX_MISSES): { sent: MissInput[]; dropped: number } {
  const ranked = misses
    .map((m, i) => ({ m, i }))
    .sort((a, b) => Math.abs(b.m.score ?? 0) - Math.abs(a.m.score ?? 0) || a.i - b.i)
    .slice(0, max)
    .sort((a, b) => a.i - b.i)
    .map((x) => x.m);
  return { sent: ranked, dropped: Math.max(0, misses.length - ranked.length) };
}

export function buildDiagnosisUserMessage(misses: readonly MissInput[], lessons: readonly LessonRecord[]): string {
  const lessonList = lessons
    .filter((l) => l.status === 'ACTIVE')
    .slice(0, MAX_ACTIVE_LESSONS_SHOWN)
    .map((l) => ({ key: l.key, text: clampText(l.text), scope: l.scope, right: l.rightCount, wrong: l.wrongCount }));
  let inputsMax = INPUTS_EXCERPT_MAX;
  let detailsMax = DETAILS_EXCERPT_MAX;
  for (;;) {
    const msg = JSON.stringify({
      misses: misses.map((m) => ({
        kind: m.kind,
        refId: m.refId,
        session: m.sessionDate,
        symbol: m.symbol ?? undefined,
        subject: m.subject ?? undefined,
        predicted: excerpt(m.predicted, 400),
        actual: excerpt(m.actual, 400),
        score: m.score ?? undefined,
        details: excerpt(m.details, detailsMax),
        inputs: excerpt(m.inputs, inputsMax),
      })),
      activeLessons: lessonList,
    });
    if (msg.length <= USER_MESSAGE_MAX_CHARS || inputsMax < 200) return msg.slice(0, USER_MESSAGE_MAX_CHARS);
    inputsMax = Math.floor(inputsMax / 2);
    detailsMax = Math.floor(detailsMax / 2);
  }
}

/** Pull the first JSON object out of a reply (tolerates a ```json fence). */
export function extractJsonObject(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no JSON object in the reply');
  return JSON.parse(t.slice(start, end + 1));
}

const TARGET_RE = /^[A-Za-z0-9_.]{3,100}$/;

/**
 * Strict on the envelope, lenient per entry: a reply that is not `{misses: [...]}` throws;
 * an entry with no surviving refId, no cause or an unknown category is dropped; a bad
 * optional field (key, text, scope, target) is dropped from its entry alone. A lesson key
 * that is new needs `lessonText`; a key already active may come without it.
 */
export function validateDiagnosis(raw: unknown, sentRefIds: readonly string[], activeKeys: ReadonlySet<string>): DiagnosedMiss[] {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('diagnosis reply is not an object');
  const misses = (raw as { misses?: unknown }).misses;
  if (!Array.isArray(misses)) throw new Error('diagnosis reply has no misses array');
  const known = new Set(sentRefIds);
  const out: DiagnosedMiss[] = [];
  for (const m of misses) {
    if (m === null || typeof m !== 'object' || Array.isArray(m)) continue;
    const e = m as Record<string, unknown>;
    const refIds = Array.isArray(e.refIds) ? [...new Set(e.refIds.filter((r): r is string => typeof r === 'string' && known.has(r)))] : [];
    const cause = typeof e.cause === 'string' ? e.cause.trim() : '';
    const category = e.category;
    if (refIds.length === 0 || cause === '' || !(MISS_CATEGORIES as readonly unknown[]).includes(category)) continue;
    const d: DiagnosedMiss = { refIds, cause: clampText(cause, CAUSE_MAX), category: category as MissCategory };
    const text = typeof e.lessonText === 'string' && e.lessonText.trim() !== '' ? clampText(e.lessonText) : undefined;
    if (isLessonKey(e.lessonKey) && category !== 'NOISE' && (text || activeKeys.has(e.lessonKey))) {
      d.lessonKey = e.lessonKey;
      if (text) d.lessonText = text;
      if (isLessonScope(e.scope)) d.scope = e.scope;
    }
    if (Array.isArray(e.contradicts)) {
      const c = [...new Set(e.contradicts.filter((k): k is string => typeof k === 'string' && activeKeys.has(k) && k !== d.lessonKey))];
      if (c.length > 0) d.contradicts = c;
    }
    if (typeof e.proposalTarget === 'string' && TARGET_RE.test(e.proposalTarget) && (typeof e.proposedValue === 'boolean' || (typeof e.proposedValue === 'number' && Number.isFinite(e.proposedValue)))) {
      d.proposalTarget = e.proposalTarget;
      d.proposedValue = e.proposedValue;
    }
    out.push(d);
  }
  return out;
}
