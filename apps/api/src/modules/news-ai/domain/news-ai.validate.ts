import {
  AFFECTED_DIRECTIONS,
  AFFECTED_KINDS,
  BRIEF_COMMODITIES,
  BRIEF_INDICES,
  DIRECTIONS,
  type AffectedDirection,
  type AffectedKind,
  type Direction,
} from './news-ai.schemas';

export interface AffectedItem {
  kind: AffectedKind;
  name: string;
  direction: AffectedDirection;
  why: string;
}

export interface NewsAiReadReply {
  direction: Direction;
  strength: number;
  importance: number;
  takeaway: string;
  affected: AffectedItem[];
}

export type Validated<T> = { ok: true; value: T } | { ok: false; error: string };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === 'string' && (list as readonly string[]).includes(v);
const text = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const score = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : NaN;
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return Math.round(n);
};
const MAX_AFFECTED = 15;

/** Upper-case, single-spaced instrument name. */
export function normaliseName(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, ' ');
}

/**
 * Validate one per-article reply. A reply that is not the documented shape (wrong enum, score
 * outside 0-100, empty takeaway, non-array affected) is REJECTED — never stored, the article is
 * retried. Individual malformed `affected` entries are dropped; the rest of the read is kept.
 */
export function validateReadReply(reply: unknown): Validated<NewsAiReadReply> {
  if (!isObj(reply)) return { ok: false, error: 'reply is not an object' };
  if (!oneOf(DIRECTIONS, reply.direction)) return { ok: false, error: `bad direction ${JSON.stringify(reply.direction)}` };
  const strength = score(reply.strength);
  if (strength === null) return { ok: false, error: `bad strength ${JSON.stringify(reply.strength)}` };
  const importance = score(reply.importance);
  if (importance === null) return { ok: false, error: `bad importance ${JSON.stringify(reply.importance)}` };
  const takeaway = text(reply.takeaway, 400);
  if (!takeaway) return { ok: false, error: 'empty takeaway' };
  if (!Array.isArray(reply.affected)) return { ok: false, error: 'affected is not an array' };
  const seen = new Set<string>();
  const affected: AffectedItem[] = [];
  for (const a of reply.affected) {
    if (!isObj(a) || !oneOf(AFFECTED_KINDS, a.kind) || !oneOf(AFFECTED_DIRECTIONS, a.direction)) continue;
    const name = text(a.name, 40);
    if (!name) continue;
    const key = `${a.kind}:${normaliseName(name)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    affected.push({ kind: a.kind, name: normaliseName(name), direction: a.direction, why: text(a.why, 300) ?? '' });
    if (affected.length >= MAX_AFFECTED) break;
  }
  return { ok: true, value: { direction: reply.direction, strength, importance, takeaway, affected } };
}

// ─── Brief ────────────────────────────────────────────────────────────────────

export interface BriefTone {
  direction: Direction;
  summary: string;
  articleIds: string[];
}
export interface BriefPoint extends BriefTone {
  name: string;
}
export interface BriefHolding extends BriefTone {
  symbol: string;
}
export interface BriefStory {
  articleId: string;
  headline: string;
  direction: Direction;
  whyItMatters: string;
}
export interface BriefWatch {
  item: string;
  articleIds: string[];
}
export interface NewsBriefBody {
  headline: string;
  indiaTone: BriefTone;
  globalTone: BriefTone;
  indices: BriefPoint[];
  sectors: BriefPoint[];
  commodities: BriefPoint[];
  holdings: BriefHolding[];
  topStories: BriefStory[];
  watchNext: BriefWatch[];
}

const citeList = (v: unknown, known: ReadonlySet<string>): string[] =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && known.has(x)))] : [];

function toneOf(v: unknown, known: ReadonlySet<string>): BriefTone | null {
  if (!isObj(v) || !oneOf(DIRECTIONS, v.direction)) return null;
  const summary = text(v.summary, 600);
  if (!summary) return null;
  return { direction: v.direction, summary, articleIds: citeList(v.articleIds, known) };
}

/** List points must cite at least one KNOWN article id; uncited points are dropped. */
function points(v: unknown, known: ReadonlySet<string>, names?: readonly string[], cap = 20): BriefPoint[] {
  if (!Array.isArray(v)) return [];
  const out: BriefPoint[] = [];
  const seen = new Set<string>();
  for (const p of v) {
    const t = toneOf(p, known);
    if (!t || t.articleIds.length === 0 || !isObj(p)) continue;
    const raw = text(p.name, 60);
    if (!raw) continue;
    const name = normaliseName(raw);
    if (names && !names.includes(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name, ...t });
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * Validate the brief. Structural failures (not an object, missing headline / tones, a list field that
 * is not an array) REJECT the reply. Citations are checked against the ids actually sent: unknown ids
 * are removed, and a list point left with no citation is dropped ("every point cites article ids").
 * Top stories are capped at 5.
 */
export function validateBriefReply(reply: unknown, knownIds: ReadonlySet<string>): Validated<NewsBriefBody> {
  if (!isObj(reply)) return { ok: false, error: 'reply is not an object' };
  const headline = text(reply.headline, 300);
  if (!headline) return { ok: false, error: 'empty headline' };
  const indiaTone = toneOf(reply.indiaTone, knownIds);
  if (!indiaTone) return { ok: false, error: 'bad indiaTone' };
  const globalTone = toneOf(reply.globalTone, knownIds);
  if (!globalTone) return { ok: false, error: 'bad globalTone' };
  for (const k of ['indices', 'sectors', 'commodities', 'holdings', 'topStories', 'watchNext'] as const) {
    if (!Array.isArray(reply[k])) return { ok: false, error: `${k} is not an array` };
  }
  const holdings: BriefHolding[] = [];
  for (const h of reply.holdings as unknown[]) {
    const t = toneOf(h, knownIds);
    const sym = isObj(h) ? text(h.symbol, 60) : null;
    if (t && sym && t.articleIds.length) holdings.push({ symbol: sym.toUpperCase(), ...t });
  }
  const topStories: BriefStory[] = [];
  const storySeen = new Set<string>();
  for (const s of reply.topStories as unknown[]) {
    if (!isObj(s) || typeof s.articleId !== 'string' || !knownIds.has(s.articleId) || storySeen.has(s.articleId)) continue;
    if (!oneOf(DIRECTIONS, s.direction)) continue;
    const h = text(s.headline, 300);
    const why = text(s.whyItMatters, 600);
    if (!h || !why) continue;
    storySeen.add(s.articleId);
    topStories.push({ articleId: s.articleId, headline: h, direction: s.direction, whyItMatters: why });
    if (topStories.length >= 5) break;
  }
  if (knownIds.size > 0 && topStories.length === 0) return { ok: false, error: 'no top story cites a known article' };
  const watchNext: BriefWatch[] = [];
  for (const w of reply.watchNext as unknown[]) {
    const item = isObj(w) ? text(w.item, 400) : null;
    const cites = isObj(w) ? citeList(w.articleIds, knownIds) : [];
    if (item && cites.length) watchNext.push({ item, articleIds: cites });
    if (watchNext.length >= 10) break;
  }
  return {
    ok: true,
    value: {
      headline,
      indiaTone,
      globalTone,
      indices: points(reply.indices, knownIds, BRIEF_INDICES),
      sectors: points(reply.sectors, knownIds),
      commodities: points(reply.commodities, knownIds, BRIEF_COMMODITIES),
      holdings,
      topStories,
      watchNext,
    },
  };
}
