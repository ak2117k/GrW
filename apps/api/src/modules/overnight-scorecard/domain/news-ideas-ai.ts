/**
 * The one Sonnet call per news-ideas batch (design §4): the prompt, the JSON schema it must answer
 * in, and the strict validator. Any deviation rejects the WHOLE batch (the caller stores nothing).
 */
import type { InjectedLesson } from '../../self-review/lessons/types';
import type { IdeaKind, Scorecard } from '../scorecard.types';
import { compactScorecard } from './scoring';
import type { Candidate } from './shortlist';

export const IDEA_KINDS: readonly IdeaKind[] = ['CE_IDEA', 'PE_IDEA', 'NO_TRADE'];
export const IDEA_TEXT_MAX = 600;

export const NEWS_IDEAS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ideas'],
  properties: {
    ideas: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['symbol', 'idea', 'rationale', 'invalidation', 'whatToDo'],
        properties: {
          symbol: { type: 'string' },
          idea: { type: 'string', enum: [...IDEA_KINDS] },
          rationale: { type: 'string' },
          invalidation: { type: 'string' },
          whatToDo: { type: 'string' },
        },
      },
    },
  },
} as const;

export const NEWS_IDEAS_SYSTEM_PROMPT = [
  'You review overnight news on Indian F&O stocks for a discretionary options trader.',
  'For each candidate you get: the news (headline, source, sentiment) and a deterministic scorecard',
  '(factors oi, fii_dii, vix, expiry, news, indicators, mood = expected NIFTY move size via beta, never direction; each -2..+2 for the stated side; n/a = missing data).',
  'For EACH candidate write exactly one idea:',
  '- idea: CE_IDEA (bullish options idea), PE_IDEA (bearish), or NO_TRADE when news and scorecard disagree, data is thin, or the move is likely priced in.',
  '- rationale: one or two sentences reading the news against the scorecard; name the factors that decide it.',
  '- invalidation: the concrete condition (price level, OI change, event) that would kill the idea.',
  '- whatToDo: what the trader should do with this news at the open (watch, wait for confirmation, avoid).',
  'These are ideas for a human to analyse, never orders. Do not invent data that is not in the input.',
  `Answer ONLY with JSON: {"ideas":[{"symbol","idea","rationale","invalidation","whatToDo"}]}, one entry per candidate symbol, each text under ${IDEA_TEXT_MAX} characters.`,
].join('\n');

/**
 * Self-review lessons (SELF_REVIEW_LESSONS=on, scope NEWS_IDEAS): the line the system prompt
 * gains exactly when the user message carries `lessons`. Without lessons the prompt is
 * {@link NEWS_IDEAS_SYSTEM_PROMPT}, byte for byte.
 */
export const NEWS_IDEAS_LESSONS_LINE =
  'The input may carry "lessons" from the nightly self-review of past ideas, each with key, text, right and wrong (past cases where following it would have been right or wrong). They are evidence-counted guidance to weigh against the news and scorecards of this batch, never rules: a lesson never outweighs the data in front of you.';

/** The news-ideas system prompt: the lessons line goes before the "ideas, never orders" line. */
export function newsIdeasSystemPrompt(withLessons: boolean): string {
  if (!withLessons) return NEWS_IDEAS_SYSTEM_PROMPT;
  const anchor = '\nThese are ideas for a human to analyse';
  const at = NEWS_IDEAS_SYSTEM_PROMPT.indexOf(anchor);
  return at < 0
    ? `${NEWS_IDEAS_SYSTEM_PROMPT}\n${NEWS_IDEAS_LESSONS_LINE}`
    : `${NEWS_IDEAS_SYSTEM_PROMPT.slice(0, at)}\n${NEWS_IDEAS_LESSONS_LINE}${NEWS_IDEAS_SYSTEM_PROMPT.slice(at)}`;
}

export function buildNewsIdeasUserMessage(
  items: ReadonlyArray<{ candidate: Candidate; scorecard: Scorecard }>,
  lessons: readonly InjectedLesson[] = [],
): string {
  return JSON.stringify({
    candidates: items.map(({ candidate, scorecard }) => ({
      symbol: candidate.symbol,
      news: candidate.articles.slice(0, 3).map((a) => ({
        headline: a.title.slice(0, 300),
        source: a.source,
        sentiment: a.sentiment,
        score: a.sentimentScore,
        at: a.publishedAt.toISOString(),
      })),
      scorecardSide: scorecard.side,
      scorecard: compactScorecard(scorecard, 600),
    })),
    ...(lessons.length > 0 ? { lessons: lessons.map((l) => ({ key: l.key, text: l.text, right: l.right, wrong: l.wrong })) } : {}),
  });
}

export interface ValidIdea {
  symbol: string;
  idea: IdeaKind;
  rationale: string;
  invalidation: string;
  whatToDo: string;
}

/** Pull the first JSON object out of the model's text (tolerates a ```json fence). */
export function extractJsonText(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no JSON object in the reply');
  return JSON.parse(t.slice(start, end + 1));
}

/** Strict: exactly one well-formed idea per expected symbol, nothing else. Throws on any deviation. */
export function validateIdeas(raw: unknown, expected: readonly string[]): ValidIdea[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('reply is not an object');
  const keys = Object.keys(raw);
  if (keys.length !== 1 || keys[0] !== 'ideas') throw new Error('reply must have exactly the key "ideas"');
  const ideas = (raw as { ideas: unknown }).ideas;
  if (!Array.isArray(ideas)) throw new Error('"ideas" is not an array');
  const want = new Set(expected);
  const seen = new Set<string>();
  const out: ValidIdea[] = [];
  for (const [i, it] of ideas.entries()) {
    if (!it || typeof it !== 'object' || Array.isArray(it)) throw new Error(`ideas[${i}] is not an object`);
    const o = it as Record<string, unknown>;
    const extra = Object.keys(o).filter((k) => !['symbol', 'idea', 'rationale', 'invalidation', 'whatToDo'].includes(k));
    if (extra.length) throw new Error(`ideas[${i}] has unexpected keys ${extra.join(',')}`);
    const symbol = typeof o.symbol === 'string' ? o.symbol.trim().toUpperCase() : '';
    if (!want.has(symbol)) throw new Error(`ideas[${i}] symbol ${String(o.symbol)} was not a candidate`);
    if (seen.has(symbol)) throw new Error(`ideas[${i}] duplicates ${symbol}`);
    if (!IDEA_KINDS.includes(o.idea as IdeaKind)) throw new Error(`ideas[${i}] idea ${String(o.idea)} is not a known kind`);
    const text = (k: string) => {
      const v = o[k];
      if (typeof v !== 'string' || !v.trim()) throw new Error(`ideas[${i}].${k} is empty`);
      if (v.length > IDEA_TEXT_MAX) throw new Error(`ideas[${i}].${k} is over ${IDEA_TEXT_MAX} chars`);
      return v.trim();
    };
    out.push({ symbol, idea: o.idea as IdeaKind, rationale: text('rationale'), invalidation: text('invalidation'), whatToDo: text('whatToDo') });
    seen.add(symbol);
  }
  const missing = expected.filter((s) => !seen.has(s));
  if (missing.length) throw new Error(`no idea for ${missing.join(',')}`);
  return out;
}
