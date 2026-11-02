/**
 * "Was this early exit justified?" — P(the position keeps going against us) at the moment an AI / floor
 * exit sold (owner 2026-11-02: "early exit will count only if there is more than 75% probability that
 * the holding will go into more loss — analyse the OI, news and other things"). RECORD / REVIEW ONLY:
 * nothing on a live exit path reads this. The self-review uses it to decide whether a premature exit is a
 * miss (p < {@link EXIT_JUSTIFIED_P}) or "justified, unlucky" (p ≥ it and the price recovered anyway).
 *
 * heuristic-v1 is a transparent log-odds sum: logit(p) = prior + Σ part contributions, clamped to
 * [{@link ADVERSE_P_V1.pMin}, {@link ADVERSE_P_V1.pMax}]. Each part is one of the exit noise read's
 * components (noise-read.ts) plus NEWS. A part with no data (NO_DATA) contributes 0. The weights are
 * judgement, NOT fitted (see ADVERSE_P_V1 for each one's reason): "75 %" means nothing until the model is
 * calibrated on scored exits ({@link fitAdverseModel}, ≥ {@link CALIBRATION_MIN_SAMPLE} of them). Pure.
 */
import { recapKind } from '../../news-impact/domain/recap';
import type { NoiseComponent, NoiseComponentName, Want } from './noise-read';

/** An exit is justified when P(adverse) at the exit was at least this (owner 2026-11-02). */
export const EXIT_JUSTIFIED_P = 0.75;
/** Under this many scored exits no logistic model is fitted (heuristic-v1 stays). */
export const CALIBRATION_MIN_SAMPLE = 50;

/**
 * heuristic-v1 weights, in log-odds (logit) units. +1 ≈ moves p from 0.50 to 0.73; reaching 0.75 needs
 * ≈ +1.1 of agreeing evidence, i.e. at least two parts must point against the position.
 */
export const ADVERSE_P_V1 = Object.freeze({
  /** No calibrated base rate yet: start at even odds so p ranks the evidence, not a guessed base rate. */
  prior: 0,
  /**
   * MOVE — the adverse move from the position's best point, in 1-minute noise units N. A large give-back
   * is more likely a trend than a wiggle (the read calls < 2 N NOISE, ≥ 3 N REAL), so the pivot sits
   * between them: contribution = perN × (moveN − pivotN), clamped. 1 N → −0.53, 2.5 N → 0, 4 N → +0.53,
   * ≥ 5.4 N → +1.0. The strongest single part: it is what every AI exit trigger fires on.
   */
  movePivotN: 2.5,
  movePerN: 0.35,
  moveMin: -0.7,
  moveMax: 1.0,
  /** MOVE by lean when the read has no moveN value. */
  moveLean: { NOISE: -0.5, NEUTRAL: 0, REAL: 0.7 },
  /**
   * CHAIN — near-money option OI flow, (ΔPE − ΔCE) / total over the ~9 min before the exit, signed for
   * the position (+ = support). Writers adding against the position = more adverse: contribution =
   * −perLean × forPosition, clamped; 1 % (the read's lean threshold) = ∓0.4, ≥ 2 % = ∓0.8. Equal in
   * size to MOVE at 2 % because the 10-30 SENSEX case (PE OI +3.1 % into the dip) was the motivating miss.
   */
  chainPerLean: 40,
  chainMax: 0.8,
  chainLean: { NOISE: -0.4, NEUTRAL: 0, REAL: 0.4 },
  /** FUTURES — price against + OI up = fresh positions against (+0.6); price against + OI down = unwinding (−0.6). */
  futuresLean: { NOISE: -0.6, NEUTRAL: 0, REAL: 0.6 },
  /**
   * VWAP — still on the position's side of VWAP (−0.4); beyond it by ≥ 0.5 N (+0.5); just beyond (+0.15).
   * Weaker than OI: VWAP is a level the market crosses many times a day.
   */
  vwapLean: { NOISE: -0.4, NEUTRAL: 0.15, REAL: 0.5 },
  /** VOLUME — dip on ≥ 1.5× volume (+0.4), on ≤ 0.8× (−0.3): thin dips revert more often than heavy ones. */
  volumeLean: { NOISE: -0.3, NEUTRAL: 0, REAL: 0.4 },
  /**
   * NEWS — same-underlying, directional, MED / HIGH, not priced in, non-recap impacts read in the
   * {@link ADVERSE_P_V1.newsWindowMin} min before the exit: each adds ± magnitude × (confidence / 0.5)
   * (+ against the position, − for it), total clamped to ± newsMax. Capped below MOVE + CHAIN because
   * the news-impact model's own hit rate is near a coin (self-review NEWS_IMPACT, 10-26 → 11-02).
   */
  newsWindowMin: 60,
  newsMagnitude: { MED: 0.4, HIGH: 0.7 },
  newsConfidenceDefault: 0.5,
  newsMax: 1.0,
  pMin: 0.05,
  pMax: 0.95,
});

export type AdversePartName = NoiseComponentName | 'NEWS';
export const ADVERSE_PARTS: readonly AdversePartName[] = ['MOVE', 'CHAIN', 'FUTURES', 'VWAP', 'VOLUME', 'NEWS'];

export interface AdversePart {
  name: AdversePartName;
  /** Log-odds added (+ = more adverse). 0 when not read. */
  contribution: number;
  /** The part had data (a read component with a lean, a fallback move, or ≥ 1 qualifying news item). */
  read: boolean;
  note: string;
}

/** A news-impact row as the review reads it (news_impacts ⋈ news_clusters). */
export interface NewsImpactLike {
  analysedAt: Date;
  direction: string; // BULL | BEAR | NEUTRAL
  magnitude: string; // LOW | MED | HIGH
  confidence: number | null;
  pricedIn: boolean;
  symbols: readonly string[];
  indexName: string | null;
  headline: string | null;
  oneLine: string | null;
}

/** A fitted model ({@link fitAdverseModel}): logit = intercept + Σ coef[part] × (heuristic contribution of the part). */
export interface AdverseModel {
  version: number;
  intercept: number;
  coef: Partial<Record<AdversePartName, number>>;
  n: number;
}

export interface AdverseInput {
  want: Want;
  exitAt: Date;
  /** The underlying's name (NIFTY, RELIANCE, CRUDEOIL) for the news match. */
  underlying: string | null;
  /** The exit noise read's components; null = no read was taken. */
  components: readonly NoiseComponent[] | null;
  /** No read: the adverse move from the best point in N, from candles_1m (the self-review fallback). */
  fallbackMoveN?: number | null;
  /** News impacts around the exit; null = news not read. */
  news: readonly NewsImpactLike[] | null;
  /** A calibrated model; absent = heuristic-v1. */
  model?: AdverseModel | null;
}

export type AdverseFrom = 'noise-read' | 'candles_1m' | 'news-only' | 'none';

export interface AdverseProbability {
  /** null = nothing could be read (no component, no fallback move, no qualifying news). */
  p: number | null;
  basis: 'heuristic-v1' | `calibrated-v${number}`;
  /** What the parts were read from. */
  from: AdverseFrom;
  parts: AdversePart[];
}

const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const num = (v: unknown): number | null => (fin(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
const blank = (name: AdversePartName, note: string): AdversePart => ({ name, contribution: 0, read: false, note });
const W = ADVERSE_P_V1;

function leanPart(name: AdversePartName, c: NoiseComponent, table: Record<'NOISE' | 'NEUTRAL' | 'REAL', number>): AdversePart {
  if (c.lean === null) return blank(name, `no data: ${c.note}`);
  return { name, contribution: table[c.lean], read: true, note: `${c.lean.toLowerCase()}: ${c.note}` };
}

export function movePart(c: NoiseComponent | null | undefined, fallbackMoveN?: number | null): AdversePart {
  const moveN = c && c.lean !== null ? num(c.values?.moveN) : null;
  const n = moveN ?? (c && c.lean !== null ? null : fin(fallbackMoveN) ? fallbackMoveN : null);
  if (n !== null) {
    const contribution = r3(clamp(W.movePerN * (n - W.movePivotN), W.moveMin, W.moveMax));
    const src = moveN !== null ? 'read' : 'candles_1m';
    return { name: 'MOVE', contribution, read: true, note: `${n} N from the best (${src})` };
  }
  if (c && c.lean !== null) return leanPart('MOVE', c, W.moveLean);
  return blank('MOVE', c ? `no data: ${c.note}` : 'no read and no candles_1m move');
}

export function chainPart(c: NoiseComponent | null | undefined, want: Want): AdversePart {
  if (!c) return blank('CHAIN', 'no read');
  if (c.lean === null) return blank('CHAIN', `no data: ${c.note}`);
  const lean = num(c.values?.leanPct);
  if (lean === null) return leanPart('CHAIN', c, W.chainLean);
  const forPosition = want === 'BULLISH' ? lean : -lean;
  return { name: 'CHAIN', contribution: r3(clamp(-W.chainPerLean * forPosition, -W.chainMax, W.chainMax)), read: true, note: `OI lean ${(forPosition * 100).toFixed(1)}% for the position: ${c.note}` };
}

/** Index impacts (index_name NIFTY / BANKNIFTY) are read for the indices that move with them. */
const INDEX_FAMILY: Readonly<Record<string, string>> = { NIFTY: 'NIFTY', SENSEX: 'NIFTY', FINNIFTY: 'NIFTY', NIFTYNXT50: 'NIFTY', BANKNIFTY: 'BANKNIFTY', BANKEX: 'BANKNIFTY' };

/** The impacts that count: same underlying, directional, MED / HIGH, not priced in, not a recap, read in the window before the exit. */
export function qualifyingNews(underlying: string | null, exitAt: Date, news: readonly NewsImpactLike[]): NewsImpactLike[] {
  const u = String(underlying ?? '').toUpperCase().trim();
  if (!u) return [];
  const family = INDEX_FAMILY[u] ?? null;
  const t = exitAt.getTime();
  const from = t - W.newsWindowMin * 60_000;
  return news.filter((x) => {
    const at = x.analysedAt.getTime();
    if (!(at >= from && at <= t)) return false;
    if (x.direction !== 'BULL' && x.direction !== 'BEAR') return false;
    if (x.magnitude !== 'MED' && x.magnitude !== 'HIGH') return false;
    if (x.pricedIn) return false;
    if (recapKind(x.headline) !== null || String(x.oneLine ?? '').startsWith('[recap]')) return false;
    const symbols = x.symbols.map((s) => String(s).toUpperCase());
    return symbols.includes(u) || (family !== null && String(x.indexName ?? '').toUpperCase() === family);
  });
}

export function newsPart(want: Want, underlying: string | null, exitAt: Date, news: readonly NewsImpactLike[] | null): AdversePart {
  if (news === null) return blank('NEWS', 'news not read');
  const q = qualifyingNews(underlying, exitAt, news);
  if (q.length === 0) return blank('NEWS', `no qualifying impact for ${underlying ?? '?'} in the ${W.newsWindowMin} min before the exit`);
  let sum = 0;
  const bits: string[] = [];
  for (const x of q) {
    const against = (want === 'BULLISH') === (x.direction === 'BEAR');
    const conf = fin(x.confidence) ? x.confidence : W.newsConfidenceDefault;
    const c = (against ? 1 : -1) * W.newsMagnitude[x.magnitude as 'MED' | 'HIGH'] * (conf / 0.5);
    sum += c;
    bits.push(`${x.direction} ${x.magnitude} ${conf} ${against ? 'against' : 'for'}: ${String(x.headline ?? x.oneLine ?? '').slice(0, 80)}`);
  }
  return { name: 'NEWS', contribution: r3(clamp(sum, -W.newsMax, W.newsMax)), read: true, note: `${q.length} impact(s): ${bits.join(' | ')}` };
}

/** The heuristic parts (the calibrated model rescales these same contributions). */
export function adverseParts(i: AdverseInput): AdversePart[] {
  const by = new Map((i.components ?? []).map((c) => [c.name, c]));
  const comp = (name: NoiseComponentName, table: Record<'NOISE' | 'NEUTRAL' | 'REAL', number>) => {
    const c = by.get(name);
    return c ? leanPart(name, c, table) : blank(name, i.components ? 'not in the read' : 'no read');
  };
  return [
    movePart(by.get('MOVE') ?? null, i.components ? null : i.fallbackMoveN),
    i.components ? chainPart(by.get('CHAIN') ?? null, i.want) : blank('CHAIN', 'no read'),
    comp('FUTURES', W.futuresLean),
    comp('VWAP', W.vwapLean),
    comp('VOLUME', W.volumeLean),
    newsPart(i.want, i.underlying, i.exitAt, i.news),
  ];
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

/** P(the position keeps going against us) at the exit. Pure; never throws. */
export function adverseProbability(i: AdverseInput): AdverseProbability {
  const parts = adverseParts(i);
  const model = i.model ?? null;
  const basis: AdverseProbability['basis'] = model ? `calibrated-v${model.version}` : 'heuristic-v1';
  const anyComponent = parts.some((p) => p.read && p.name !== 'NEWS');
  const from: AdverseFrom = i.components && parts.some((p) => p.read && p.name !== 'NEWS')
    ? 'noise-read'
    : !i.components && anyComponent
      ? 'candles_1m'
      : parts.some((p) => p.read)
        ? 'news-only'
        : 'none';
  if (from === 'none') return { p: null, basis, from, parts };
  const z = model
    ? model.intercept + parts.reduce((s, p) => s + (model.coef[p.name] ?? 0) * p.contribution, 0)
    : W.prior + parts.reduce((s, p) => s + p.contribution, 0);
  return { p: r3(clamp(sigmoid(z), W.pMin, W.pMax)), basis, from, parts };
}

/** p ≥ {@link EXIT_JUSTIFIED_P}; a null p is never justified. */
export function isJustified(p: number | null | undefined): boolean {
  return fin(p) && p >= EXIT_JUSTIFIED_P;
}

/** A stored read's components (exit_noise_reads.read JSONB); [] when unreadable. */
export function componentsOfRecord(read: unknown): NoiseComponent[] {
  const r = read && typeof read === 'object' && !Array.isArray(read) ? (read as { components?: unknown }).components : null;
  if (!Array.isArray(r)) return [];
  return r.flatMap((c) => {
    if (!c || typeof c !== 'object') return [];
    const x = c as Record<string, unknown>;
    if (!['MOVE', 'CHAIN', 'FUTURES', 'VWAP', 'VOLUME'].includes(String(x.name))) return [];
    const lean = x.lean === 'NOISE' || x.lean === 'REAL' || x.lean === 'NEUTRAL' ? x.lean : null;
    const values = x.values && typeof x.values === 'object' && !Array.isArray(x.values) ? (x.values as Record<string, number | string | null>) : undefined;
    return [{ name: x.name as NoiseComponentName, lean, note: typeof x.note === 'string' ? x.note : '', ...(values ? { values } : {}) }];
  });
}

// ─── Calibration ─────────────────────────────────────────────────────────────

export interface CalibrationSample {
  parts: readonly AdversePart[];
  /** The outcome: the underlying went on against the position (≥ 1 N within 30 min). */
  adverse: boolean;
}

/**
 * A tiny L2-regularised logistic model over the heuristic contributions (one coefficient per part +
 * intercept), by gradient descent. null under {@link CALIBRATION_MIN_SAMPLE} samples: the heuristic stays.
 */
export function fitAdverseModel(samples: readonly CalibrationSample[], version = 1, opts: { iterations?: number; rate?: number; l2?: number } = {}): AdverseModel | null {
  if (samples.length < CALIBRATION_MIN_SAMPLE) return null;
  const names = ADVERSE_PARTS;
  const X = samples.map((s) => names.map((n) => s.parts.find((p) => p.name === n)?.contribution ?? 0));
  const y = samples.map((s) => (s.adverse ? 1 : 0));
  const iterations = opts.iterations ?? 4000;
  const rate = opts.rate ?? 0.1;
  const l2 = opts.l2 ?? 0.01;
  let b = 0;
  const w = names.map(() => 1); // start from the heuristic (coef 1 = the heuristic weight as written)
  const m = samples.length;
  for (let it = 0; it < iterations; it++) {
    let gb = 0;
    const gw = names.map(() => 0);
    for (let k = 0; k < m; k++) {
      const err = sigmoid(b + X[k].reduce((s, x, j) => s + x * w[j], 0)) - y[k];
      gb += err;
      for (let j = 0; j < names.length; j++) gw[j] += err * X[k][j];
    }
    b -= (rate * gb) / m;
    for (let j = 0; j < names.length; j++) w[j] -= rate * (gw[j] / m + l2 * (w[j] - 1));
  }
  return { version, intercept: r3(b), coef: Object.fromEntries(names.map((n, j) => [n, r3(w[j])])), n: m };
}

/** Reliability buckets of p vs the outcome. */
export const RELIABILITY_BUCKETS: ReadonlyArray<{ label: string; lo: number; hi: number }> = [
  { label: '0–0.5', lo: 0, hi: 0.5 },
  { label: '0.5–0.75', lo: 0.5, hi: EXIT_JUSTIFIED_P },
  { label: '0.75–1', lo: EXIT_JUSTIFIED_P, hi: 1.000001 },
];

export function reliabilityTable(rows: ReadonlyArray<{ p: number | null; adverse: boolean | null }>): Array<{ bucket: string; n: number; adverse: number; rate: number | null; meanP: number | null }> {
  return RELIABILITY_BUCKETS.map((b) => {
    const xs = rows.filter((r): r is { p: number; adverse: boolean } => fin(r.p) && r.adverse !== null && r.p >= b.lo && r.p < b.hi);
    const adverse = xs.filter((r) => r.adverse).length;
    return { bucket: b.label, n: xs.length, adverse, rate: xs.length ? r3(adverse / xs.length) : null, meanP: xs.length ? r3(xs.reduce((s, r) => s + r.p, 0) / xs.length) : null };
  });
}
