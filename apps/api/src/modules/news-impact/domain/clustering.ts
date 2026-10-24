/**
 * News impact layer 1a (2026-10-24): the same story across sources is ONE cluster.
 *
 * Rule (pure, no I/O): an article joins the best-matching open cluster whose time span is within
 * {@link CLUSTER_WINDOW_MS} (6 h) of the article, when
 *   - they share an instrument AND (title Jaccard ≥ 0.2 OR the same material kind), or
 *   - neither carries an instrument AND the titles are near-identical (Jaccard ≥ 0.5, or ≥ 0.6 of
 *     the shorter title's tokens contained in the other, with ≥ 4 tokens).
 * Boilerplate never merges (a routine filing is its own cluster and goes no further). Coverage —
 * the number of distinct sources — is a feature downstream.
 */
import { combineTypes, nseSubject, NSE_ANNOUNCEMENTS, type Classification, type MaterialType } from './announcement-classifier';

export const CLUSTER_WINDOW_MS = 6 * 3_600_000;
export const SHARED_INSTRUMENT_JACCARD = 0.2;
export const TITLE_ONLY_JACCARD = 0.5;
export const TITLE_ONLY_CONTAINMENT = 0.6;

const STOP = new Set(
  (
    'a an the and or of in on at to for from by with as is are was were be been has have had it its this that these ' +
    'over under into after before amid says said say will may can could would should not no new up down out about more ' +
    'than per vs via limited ltd company co inc india indian shares share stock stocks market markets news today report ' +
    'has informed exchange regarding intimation pursuant regulation sebi listing obligations disclosure requirements'
  ).split(' '),
);

/** Normalised title tokens: lower-case words ≥ 3 letters (or numbers), stop words dropped, a crude plural strip. */
export function titleTokens(title: string, source?: string): string[] {
  const text = source === NSE_ANNOUNCEMENTS ? nseSubject(title).subject + ' ' + nseSubject(title).text : title;
  const out = new Set<string>();
  for (const raw of text.toLowerCase().replace(/[’']/g, '').split(/[^a-z0-9₹%]+/)) {
    if (!raw || STOP.has(raw)) continue;
    if (!/\d/.test(raw) && raw.length < 3) continue;
    const w = raw.length > 4 && raw.endsWith('s') && !raw.endsWith('ss') ? raw.slice(0, -1) : raw;
    if (!STOP.has(w)) out.add(w);
  }
  return [...out];
}

export function jaccard(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const sb = new Set(b);
  let inter = 0;
  for (const t of new Set(a)) if (sb.has(t)) inter++;
  return inter / (new Set([...a, ...b]).size || 1);
}

export function containment(a: readonly string[], b: readonly string[]): number {
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  if (s.length === 0) return 0;
  const sl = new Set(l);
  return s.filter((t) => sl.has(t)).length / s.length;
}

export interface ClusterArticle {
  id: string;
  title: string;
  summary: string | null;
  source: string;
  publishedAt: Date;
  instruments: string[];
  sectors: string[];
  indices: string[];
  cls: Classification;
}

export interface ClusterState {
  /** null until persisted. */
  id: string | null;
  headline: string;
  headlineSource: string;
  instruments: string[];
  sectors: string[];
  indices: string[];
  sources: string[];
  articleIds: string[];
  titleTokens: string[];
  firstSeen: Date;
  lastSeen: Date;
  types: MaterialType[];
  materialType: MaterialType;
  material: boolean;
  boilerplate: boolean;
  /** Touched in this pass (needs a write). */
  dirty?: boolean;
}

/** The match score of an article against a cluster (0 = no match). */
export function matchScore(a: ClusterArticle, tokens: readonly string[], c: ClusterState): number {
  if (a.cls.boilerplate || c.boilerplate) return 0;
  const t = a.publishedAt.getTime();
  if (t < c.firstSeen.getTime() - CLUSTER_WINDOW_MS || t > c.lastSeen.getTime() + CLUSTER_WINDOW_MS) return 0;
  const j = jaccard(tokens, c.titleTokens);
  const ci = new Set(c.instruments);
  const shared = a.instruments.some((s) => ci.has(s));
  if (shared) {
    const sameKind = a.cls.material && c.material && c.types.includes(a.cls.type);
    if (j >= SHARED_INSTRUMENT_JACCARD || sameKind) return 1 + j + (sameKind ? 0.5 : 0);
    return 0;
  }
  if (a.instruments.length === 0 && c.instruments.length === 0) {
    if (j >= TITLE_ONLY_JACCARD) return j;
    if (Math.min(tokens.length, c.titleTokens.length) >= 4 && containment(tokens, c.titleTokens) >= TITLE_ONLY_CONTAINMENT) return j + 0.1;
  }
  return 0;
}

const uniq = (xs: Iterable<string>) => [...new Set(xs)];

export function newCluster(a: ClusterArticle, tokens: string[]): ClusterState {
  return {
    id: null,
    headline: a.title,
    headlineSource: a.source,
    instruments: uniq(a.instruments),
    sectors: uniq(a.sectors),
    indices: uniq(a.indices),
    sources: [a.source],
    articleIds: [a.id],
    titleTokens: tokens,
    firstSeen: a.publishedAt,
    lastSeen: a.publishedAt,
    types: [a.cls.type],
    materialType: a.cls.type,
    material: a.cls.material,
    boilerplate: a.cls.boilerplate,
    dirty: true,
  };
}

/** Add an article to a cluster (mutates and returns it). A press headline replaces an NSE-filing headline. */
export function absorb(c: ClusterState, a: ClusterArticle, tokens: string[]): ClusterState {
  if (!c.articleIds.includes(a.id)) c.articleIds.push(a.id);
  c.instruments = uniq([...c.instruments, ...a.instruments]);
  c.sectors = uniq([...c.sectors, ...a.sectors]);
  c.indices = uniq([...c.indices, ...a.indices]);
  c.sources = uniq([...c.sources, a.source]);
  c.titleTokens = uniq([...c.titleTokens, ...tokens]).slice(0, 60);
  if (a.publishedAt < c.firstSeen) c.firstSeen = a.publishedAt;
  if (a.publishedAt > c.lastSeen) c.lastSeen = a.publishedAt;
  if (c.headlineSource === NSE_ANNOUNCEMENTS && a.source !== NSE_ANNOUNCEMENTS) {
    c.headline = a.title;
    c.headlineSource = a.source;
  }
  c.types = uniq([...c.types, a.cls.type]) as MaterialType[];
  const combined = combineTypes(c.types);
  c.materialType = combined.type;
  c.material = combined.material;
  c.boilerplate = combined.boilerplate;
  c.dirty = true;
  return c;
}

/**
 * Assign each article (oldest first) to the best cluster in `open` or a new one. Mutates `open`
 * (appends new clusters) and returns, per article id, the cluster it went to.
 */
export function assignClusters(articles: readonly ClusterArticle[], open: ClusterState[]): Map<string, ClusterState> {
  const out = new Map<string, ClusterState>();
  for (const a of [...articles].sort((x, y) => x.publishedAt.getTime() - y.publishedAt.getTime())) {
    const tokens = titleTokens(a.title, a.source);
    let best: ClusterState | null = null;
    let bestScore = 0;
    for (const c of open) {
      const s = matchScore(a, tokens, c);
      if (s > bestScore) {
        best = c;
        bestScore = s;
      }
    }
    const c = best ? absorb(best, a, tokens) : newCluster(a, tokens);
    if (!best) open.push(c);
    out.set(a.id, c);
  }
  return out;
}
