/**
 * Verification scorers (contract table "What gets verified"). PURE: rows in, drafts out. The
 * repository decides which rows belong to session S; these decide what "correct" means.
 */
import type { VerificationDraft } from '../self-review.types';

import { relativeCallCorrect } from '../../mbm/domain/relative-reading';
import { INDEX_UNDERLYINGS } from '../../market-hub/underlying';

const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;
const signText = (x: number) => (x > 0 ? `+${r1(x)}` : `${r1(x)}`);

/** +1 when the move went the call's way, −1 against, null when flat. */
function judged(directional: number): boolean | null {
  if (!Number.isFinite(directional) || directional === 0) return null;
  return directional > 0;
}

// ─── Scorecards ──────────────────────────────────────────────────────────────

export type Side = 'BULLISH' | 'BEARISH';

export interface ScorecardRow {
  id: string;
  symbol: string;
  underlying: string;
  side: Side | string;
  window: string;
  computedAt: Date;
  factors: unknown;
  total: number;
  band: string;
  moveBp: number;
  /** IST 'YYYY-MM-DD' of the session whose open→close is the outcome. */
  sessionDate: string;
}

/** The underlying's move expressed in the position's favour: + = the side the scorecard needs. */
export const sideMove = (side: string, moveBp: number): number => (side === 'BEARISH' ? -moveBp : moveBp);

/** Latest scorecard per (window, symbol) — re-computations in the same window supersede. */
export function latestPerWindowSymbol<T extends { window: string; symbol: string; computedAt: Date }>(rows: readonly T[]): T[] {
  const best = new Map<string, T>();
  for (const r of rows) {
    const k = `${r.window}|${r.symbol}`;
    const cur = best.get(k);
    if (!cur || r.computedAt.getTime() > cur.computedAt.getTime()) best.set(k, r);
  }
  return [...best.values()];
}

/** Band SUPPORTS/STRONG_SUPPORTS → +1, AGAINST/STRONG_AGAINST → −1, NEUTRAL → 0. */
export function bandDirection(band: string): -1 | 0 | 1 {
  if (band === 'SUPPORTS' || band === 'STRONG_SUPPORTS') return 1;
  if (band === 'AGAINST' || band === 'STRONG_AGAINST') return -1;
  return 0;
}

export function scoreScorecardTotal(row: ScorecardRow): VerificationDraft {
  const dir = bandDirection(row.band);
  const fav = sideMove(row.side, row.moveBp);
  const directional = dir * fav;
  return {
    sessionDate: row.sessionDate,
    kind: 'SCORECARD_TOTAL',
    refId: row.id,
    subject: row.window,
    symbol: row.symbol,
    predicted: `${row.band} (${row.total > 0 ? '+' : ''}${row.total}) for ${row.side}`,
    actual: `${row.underlying} ${signText(row.moveBp)} bp open→close`,
    correct: dir === 0 ? null : judged(directional),
    score: dir === 0 ? null : r1(directional),
    details: {
      window: row.window,
      side: row.side,
      total: row.total,
      band: row.band,
      moveBp: row.moveBp,
      underlying: row.underlying,
      // The points that made the band, so the diagnosis names a factor that was actually scored.
      factors: factorPoints(row.factors),
    },
  };
}

/** `{oi: 0, expiry: -2, …}` — every factor's signed points; unavailable factors are left out. */
export function factorPoints(raw: unknown): Record<string, number> {
  return Object.fromEntries(readFactors(raw).filter((f) => f.available).map((f) => [f.name, f.points]));
}

interface StoredFactor {
  name: string;
  points: number;
  /** Points before the self-review weight / confirmation rule (absent on rows scored before them). */
  rawPoints?: number;
  weight?: number;
  available: boolean;
  value?: string;
}

export function readFactors(raw: unknown): StoredFactor[] {
  if (!Array.isArray(raw)) return [];
  const out: StoredFactor[] = [];
  for (const f of raw) {
    if (!f || typeof f !== 'object') continue;
    const o = f as Record<string, unknown>;
    if (typeof o.name !== 'string' || typeof o.points !== 'number') continue;
    out.push({
      name: o.name,
      points: o.points,
      rawPoints: typeof o.rawPoints === 'number' ? o.rawPoints : undefined,
      weight: typeof o.weight === 'number' ? o.weight : undefined,
      available: o.available !== false,
      value: typeof o.value === 'string' ? o.value : undefined,
    });
  }
  return out;
}

/**
 * Would the news factor's positive vote survive `requireConfirmation`? Literal contract rule: it
 * needs indicators OR oi at ≥ 0 (available) in the same scorecard. Null when news is not positive.
 */
export function newsConfirmed(factors: readonly StoredFactor[]): boolean | null {
  const news = factors.find((f) => f.name === 'news');
  const pts = news ? news.rawPoints ?? news.points : 0;
  if (!news || !news.available || !(pts > 0)) return null;
  return factors.some((f) => (f.name === 'indicators' || f.name === 'oi') && f.available && (f.rawPoints ?? f.points) >= 0);
}

/**
 * Factors that never vote a direction (overnight-scorecard factors.ts §9): expiry only penalises a long
 * option's theta, mood is volatility context. Judging them on the underlying's direction measured whether
 * the TRADE was wrong, not the factor (2026-10-28: "expiry 42 %" was 24 penalties scored as bear calls).
 */
export const DIRECTION_FREE_FACTORS: ReadonlySet<string> = new Set(['expiry', 'mood']);
/** VIX votes a direction only for an index; on a stock option it is vega context. */
export const INDEX_ONLY_DIRECTION_FACTORS: ReadonlySet<string> = new Set(['vix']);
/** An open→close move smaller than this is noise, not a verdict (≈ a quiet session's drift). */
export const MIN_JUDGED_MOVE_BP = 25;

/** Why a factor vote is not judged on this move, or null when it is. */
export function factorNotJudged(name: string, underlying: string, moveBp: number): string | null {
  if (DIRECTION_FREE_FACTORS.has(name)) return 'direction-free factor';
  if (INDEX_ONLY_DIRECTION_FACTORS.has(name) && !(underlying in INDEX_UNDERLYINGS)) return 'no direction vote on a stock';
  if (!(Math.abs(moveBp) >= MIN_JUDGED_MOVE_BP)) return `move under ${MIN_JUDGED_MOVE_BP} bp`;
  return null;
}

/**
 * One draft per factor. Judged on the RAW points (before the self-review weight), so a factor whose
 * weight was cut keeps being measured and can earn its weight back.
 */
export function scoreScorecardFactors(row: ScorecardRow): VerificationDraft[] {
  const factors = readFactors(row.factors);
  const fav = sideMove(row.side, row.moveBp);
  const confirmed = newsConfirmed(factors);
  return factors.map((f) => {
    const pts = f.rawPoints ?? f.points;
    const skip = factorNotJudged(f.name, row.underlying, row.moveBp);
    const dir = skip || !f.available || pts === 0 ? 0 : pts > 0 ? 1 : -1;
    return {
      sessionDate: row.sessionDate,
      kind: 'SCORECARD_FACTOR' as const,
      refId: `${row.id}:${f.name}`,
      subject: f.name,
      symbol: row.symbol,
      predicted: f.available ? `${f.name} ${pts > 0 ? '+' : ''}${pts} for ${row.side}` : `${f.name} unavailable`,
      actual: `${row.underlying} ${signText(row.moveBp)} bp open→close`,
      correct: dir === 0 ? null : judged(dir * fav),
      score: dir === 0 ? null : r1(dir * fav),
      details: {
        window: row.window,
        side: row.side,
        points: pts,
        appliedPoints: f.points,
        ...(f.weight !== undefined ? { weight: f.weight } : {}),
        available: f.available,
        moveBp: row.moveBp,
        underlying: row.underlying,
        ...(skip ? { notJudged: skip } : {}),
        ...(f.name === 'news' && confirmed !== null ? { newsConfirmed: confirmed } : {}),
      },
    };
  });
}

// ─── Overnight verdicts ──────────────────────────────────────────────────────

export const OVERNIGHT_TAGS = ['OVERNIGHT_REVIEW', 'PRE_OPEN_REVIEW', 'PRE_OPEN_CHECK'] as const;

export interface VerdictRow {
  id: string;
  trackerId: string;
  symbol: string;
  verdict: string;
  confidence: string;
  createdAt: Date;
  triggeredBy: unknown;
}

export function windowKindOf(triggeredBy: unknown): string | null {
  if (!Array.isArray(triggeredBy)) return null;
  return (OVERNIGHT_TAGS as readonly string[]).find((t) => triggeredBy.includes(t)) ?? null;
}

/** Latest verdict per tracker per night; `reruns` = how many earlier verdicts the same night it superseded. */
export function pickNightVerdicts<T extends VerdictRow>(rows: readonly T[]): Array<{ row: T; reruns: number; windows: string[] }> {
  const groups = new Map<string, T[]>();
  for (const r of rows) {
    if (!windowKindOf(r.triggeredBy)) continue;
    groups.set(r.trackerId, [...(groups.get(r.trackerId) ?? []), r]);
  }
  return [...groups.values()].map((g) => {
    const sorted = [...g].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    return {
      row: sorted[sorted.length - 1],
      reruns: sorted.length - 1,
      windows: sorted.map((r) => windowKindOf(r.triggeredBy) as string),
    };
  });
}

/** |premium change| at or above this (option's own prices) makes a TIGHTEN_AT_OPEN judgeable. */
export const TIGHTEN_LARGE_PCT = 0.2;
/** …and this underlying move (bp) when only the proxy is available. */
export const TIGHTEN_LARGE_PROXY_BP = 100;

export interface OvernightInput {
  sessionDate: string;
  verdict: VerdictRow;
  reruns: number;
  windows: string[];
  /** Signed quantity (+ long, − short). */
  qty: number;
  side: Side;
  /** The option's (instrument's) own open and close of S. */
  prices: { open: number; close: number; source: string } | null;
  /** The underlying's open→close bp for S when the instrument's own prices are missing. */
  proxyMoveBp: number | null;
}

export function scoreOvernightVerdict(i: OvernightInput): VerificationDraft {
  const v = i.verdict.verdict;
  const base = {
    sessionDate: i.sessionDate,
    kind: 'OVERNIGHT_VERDICT' as const,
    refId: i.verdict.id,
    subject: v,
    symbol: i.verdict.symbol,
    predicted: `${v} (${i.verdict.confidence})`,
  };
  const flags = { reruns: i.reruns, rerun: i.reruns > 0, windows: i.windows, trackerId: i.verdict.trackerId };

  if (i.prices && i.prices.open > 0 && Number.isFinite(i.prices.close)) {
    const { open, close } = i.prices;
    const pnl = (close - open) * i.qty; // what holding open→close did, ₹
    const pct = (close - open) / open;
    let correct: boolean | null;
    let score: number | null;
    if (v === 'EXIT_AT_OPEN') {
      correct = judged(-pnl);
      score = r2(-pnl);
    } else if (v === 'HOLD_OVERNIGHT') {
      correct = judged(pnl);
      score = r2(pnl);
    } else {
      const large = Math.abs(pct) >= TIGHTEN_LARGE_PCT;
      correct = large ? judged(-pnl) : null;
      score = large ? r2(-pnl) : null;
    }
    return {
      ...base,
      actual: `${open} → ${close} (${signText(pct * 100)}%), hold ₹${Math.round(pnl)}`,
      correct,
      score,
      details: { ...flags, open, close, priceSource: i.prices.source, holdPnl: r2(pnl), qty: i.qty },
    };
  }

  if (i.proxyMoveBp !== null && Number.isFinite(i.proxyMoveBp)) {
    const fav = sideMove(i.side, i.proxyMoveBp);
    let correct: boolean | null;
    if (v === 'EXIT_AT_OPEN') correct = judged(-fav);
    else if (v === 'HOLD_OVERNIGHT') correct = judged(fav);
    else correct = Math.abs(i.proxyMoveBp) >= TIGHTEN_LARGE_PROXY_BP ? judged(-fav) : null;
    return {
      ...base,
      actual: `underlying ${signText(i.proxyMoveBp)} bp (proxy: no option prices)`,
      correct,
      score: null,
      details: { ...flags, proxy: 'underlying-move', proxyMoveBp: i.proxyMoveBp, side: i.side },
    };
  }

  return { ...base, actual: 'no price data for the session', correct: null, score: null, details: { ...flags, missing: 'prices' } };
}

/** First bar's open at/after the session open, last bar's close before the close. */
export function openClose(
  bars: ReadonlyArray<{ ts: number; open: number; close: number }>,
  openAt: number,
  closeAt: number,
): { open: number; close: number } | null {
  const inSession = bars.filter((b) => b.ts >= openAt && b.ts < closeAt && b.open > 0 && Number.isFinite(b.close)).sort((a, b) => a.ts - b.ts);
  if (inSession.length === 0) return null;
  // The first bar must be near the open and the last near the close, or this is not open→close.
  const first = inSession[0];
  const last = inSession[inSession.length - 1];
  if (first.ts - openAt > 30 * 60_000 || closeAt - last.ts > 30 * 60_000) return null;
  return { open: first.open, close: last.close };
}

// ─── Live exits ──────────────────────────────────────────────────────────────

export interface LiveExitRow {
  executionId: string;
  verdictId: string;
  symbol: string;
  positionSide: string; // LONG | SHORT
  qty: number;
  decisionPrice: number;
  decisionAt: Date;
  closeAt60: number | null;
  closeAtEnd: number | null;
  sessionDate: string;
  minutesSinceOpen: number | null;
}

/** Right if the instrument was worse for the position 60 min after the fill (window end if the close came first). */
export function scoreLiveExit(r: LiveExitRow): VerificationDraft {
  const after = r.closeAt60 ?? r.closeAtEnd;
  const long = r.positionSide !== 'SHORT';
  const base = {
    sessionDate: r.sessionDate,
    kind: 'LIVE_EXIT' as const,
    refId: r.executionId,
    subject: r.positionSide,
    symbol: r.symbol,
    predicted: `exit ${r.positionSide} at ${r.decisionPrice}`,
  };
  const details = {
    verdictId: r.verdictId,
    decisionPrice: r.decisionPrice,
    closeAt60: r.closeAt60,
    closeAtEnd: r.closeAtEnd,
    horizon: r.closeAt60 !== null ? '60m' : 'window-end',
    minutesSinceOpen: r.minutesSinceOpen,
  };
  if (after === null || !Number.isFinite(after)) return { ...base, actual: 'no after-price', correct: null, score: null, details };
  const saved = (r.decisionPrice - after) * r.qty * (long ? 1 : -1);
  return {
    ...base,
    actual: `${after} after ${details.horizon}`,
    correct: judged(saved),
    score: r2(saved),
    details: { ...details, savedPnl: r2(saved) },
  };
}

// ─── News ideas ──────────────────────────────────────────────────────────────

export interface NewsIdeaRow {
  id: string;
  symbol: string;
  idea: string;
  headline: string;
  moveBp: number;
  sessionDate: string;
  scorecardTotal: number | null;
  /** The headline article's sentiment: bullish | bearish | neutral | null. */
  sentiment: string | null;
  /** The symbol's average daily range in bp (the "1×ATR-equivalent"); null when unknown. */
  atrBp: number | null;
}

export function scoreNewsIdea(r: NewsIdeaRow): VerificationDraft {
  const base = {
    sessionDate: r.sessionDate,
    kind: 'NEWS_IDEA' as const,
    refId: r.id,
    subject: r.idea,
    symbol: r.symbol,
    predicted: `${r.idea}: ${r.headline.slice(0, 120)}`,
    actual: `${r.symbol} ${signText(r.moveBp)} bp open→close`,
  };
  const details: Record<string, unknown> = { moveBp: r.moveBp, atrBp: r.atrBp, sentiment: r.sentiment, scorecardTotal: r.scorecardTotal };
  if (r.idea === 'CE_IDEA' || r.idea === 'PE_IDEA') {
    const directional = r.idea === 'CE_IDEA' ? r.moveBp : -r.moveBp;
    return { ...base, correct: judged(directional), score: r1(directional), details };
  }
  // NO_TRADE: right when the move was small, or when the setup was weak and the tape faded the headline.
  if (r.atrBp === null || !(r.atrBp > 0)) return { ...base, correct: null, score: null, details: { ...details, unsure: 'no ATR' } };
  if (Math.abs(r.moveBp) < r.atrBp) return { ...base, correct: true, score: null, details: { ...details, rule: 'move < 1×ATR' } };
  const sent = r.sentiment === 'bullish' ? 1 : r.sentiment === 'bearish' ? -1 : 0;
  if (sent === 0) return { ...base, correct: null, score: null, details: { ...details, unsure: 'no headline direction' } };
  const withHeadline = Math.sign(r.moveBp) === sent;
  if (!withHeadline && r.scorecardTotal !== null && r.scorecardTotal <= 0) {
    return { ...base, correct: true, score: null, details: { ...details, rule: 'weak scorecard, move against the headline' } };
  }
  if (withHeadline) return { ...base, correct: false, score: r1(-Math.abs(r.moveBp)), details: { ...details, rule: '≥ 1×ATR move with the headline' } };
  return { ...base, correct: null, score: null, details: { ...details, unsure: 'move against the headline, scorecard positive' } };
}

// ─── MBM predictions ─────────────────────────────────────────────────────────

export interface MbmRow {
  id: string;
  instrument: string;
  horizon: string;
  asOf: Date;
  p: number;
  regime: string;
  outcomeBig: boolean;
  outcomeQuality: string | null;
  outcomeRangeBp: number | null;
  outcomeThresholdBp: number | null;
  sessionDate: string;
  /** Relative reading columns (null on rows before 2026-10-23). */
  q50Bp?: number | null;
  relRatio?: number | null;
  relLabel?: string | null;
  refRangeBp?: number | null;
}

export function scoreMbmPrediction(r: MbmRow): VerificationDraft {
  const callBig = r.p >= 0.5;
  const ok = (r.outcomeQuality ?? 'ok') === 'ok';
  return {
    sessionDate: r.sessionDate,
    kind: 'MBM_PREDICTION',
    refId: r.id,
    subject: r.horizon,
    symbol: r.instrument,
    predicted: `${callBig ? 'BIG' : 'small'} move p=${r2(r.p)} (${r.regime})`,
    actual: `${r.outcomeBig ? 'BIG' : 'small'} range ${r.outcomeRangeBp ?? '?'} bp vs ${r.outcomeThresholdBp ?? '?'}`,
    correct: ok ? callBig === r.outcomeBig : null,
    score: null,
    details: { p: r.p, regime: r.regime, horizon: r.horizon, asOf: r.asOf.toISOString(), quality: r.outcomeQuality, brier: r2((r.p - (r.outcomeBig ? 1 : 0)) ** 2) },
  };
}

/**
 * MBM_RELATIVE: was the realised range on the side of the 10-session reference the relative call said?
 * QUIETER → realised < ref; BUSIER / MUCH_BUSIER → realised > ref; NORMAL → realised within 0.8–1.25 × ref.
 * Null (no draft) for a row without a relative reading; a gap outcome is not judged. The realised range is
 * the outcome filler's (the same definition as the reference), so the comparison is like for like.
 */
export function scoreMbmRelative(r: MbmRow): VerificationDraft | null {
  if (!r.relLabel || r.refRangeBp == null || !Number.isFinite(r.refRangeBp) || r.refRangeBp <= 0) return null;
  const ok = (r.outcomeQuality ?? 'ok') === 'ok';
  const realised = r.outcomeRangeBp;
  const realisedRatio = realised != null && Number.isFinite(realised) ? realised / r.refRangeBp : null;
  return {
    sessionDate: r.sessionDate,
    kind: 'MBM_RELATIVE',
    refId: r.id,
    subject: r.horizon,
    symbol: r.instrument,
    predicted: `${r.relLabel} (q50 ${r.q50Bp == null ? '?' : r1(r.q50Bp)} bp = ${r.relRatio == null ? '?' : r2(r.relRatio)}× ref ${r1(r.refRangeBp)} bp)`,
    actual: `range ${realised == null ? '?' : r1(realised)} bp = ${realisedRatio == null ? '?' : r2(realisedRatio)}× ref`,
    correct: ok ? relativeCallCorrect(r.relLabel, realised, r.refRangeBp) : null,
    score: null,
    details: {
      relLabel: r.relLabel, relRatio: r.relRatio ?? null, refRangeBp: r.refRangeBp, realisedBp: realised,
      realisedRatio: realisedRatio === null ? null : r2(realisedRatio), horizon: r.horizon, asOf: r.asOf.toISOString(), quality: r.outcomeQuality,
    },
  };
}

// ─── Stock big-move model ────────────────────────────────────────────────────

export interface StockMoveVerifyRow {
  id: string;
  symbol: string;
  asOf: Date;
  horizonDays: number;
  pBig: number;
  rankPct: number;
  bucket: string;
  resultsInWindow: boolean;
  modelId: string;
  outcomeBig: boolean;
  outcomeRetBp: number | null;
  /** IST 'YYYY-MM-DD' of the session that closes the row's horizon (its outcome session). */
  sessionDate: string;
}

/**
 * Stock big-move model (2026-10-22 stock-move contract): correct = (bucket = TOP20) == outcome_big
 * for TOP20 and BOTTOM20 rows; MID makes no call (null). Never direction.
 */
export function scoreStockMove(r: StockMoveVerifyRow): VerificationDraft {
  const call = r.bucket === 'TOP20' || r.bucket === 'BOTTOM20';
  return {
    sessionDate: r.sessionDate,
    kind: 'STOCK_MOVE',
    refId: r.id,
    subject: r.bucket,
    symbol: r.symbol,
    predicted: `${r.bucket} p(big ${r.horizonDays}d)=${r2(r.pBig)}${r.resultsInWindow ? ' (results in window)' : ''}`,
    actual: `${r.outcomeBig ? 'BIG' : 'small'} move${r.outcomeRetBp !== null ? ` |ret| ${Math.round(r.outcomeRetBp)} bp` : ''} over ${r.horizonDays} sessions`,
    correct: call ? (r.bucket === 'TOP20') === r.outcomeBig : null,
    score: null,
    details: {
      bucket: r.bucket,
      pBig: r.pBig,
      rankPct: r.rankPct,
      outcomeBig: r.outcomeBig,
      outcomeRetBp: r.outcomeRetBp,
      asOf: r.asOf.toISOString().slice(0, 10),
      horizonDays: r.horizonDays,
      resultsInWindow: r.resultsInWindow,
      modelId: r.modelId,
    },
  };
}

// ─── Next-morning trade setups (advisory) ────────────────────────────────────

export interface TradeSetupVerifyRow {
  id: string;
  sessionDate: string;
  symbol: string;
  side: string;
  instrument: string;
  entryRef: number;
  stopDistance: number;
  outcomeStatus: string;
  outcomeR: number | null;
  outcomeHitT1: boolean | null;
  outcomeEntryPrice: number | null;
  outcomeExitPrice: number | null;
  entryRule?: string;
  atr?: number;
  /** The news idea the setup was built from (handed to the diagnosis with a miss). */
  newsIdea?: { headline: string; idea: string; rationale: string; invalidation: string } | null;
}

/** A 15:10 time exit inside ±this many R neither proved nor refuted the setup. */
export const SETUP_TIME_EXIT_R = 0.5;

function timeExitCorrect(R: number | null): boolean | null {
  if (R === null || !Number.isFinite(R)) return null;
  return R >= SETUP_TIME_EXIT_R ? true : R <= -SETUP_TIME_EXIT_R ? false : null;
}

/**
 * Trade setup (stream T): did the entry trigger next session, and did it reach target 1 (1.5R)
 * before the stop? correct = hit T1 first; the stop = wrong; the 15:10 time exit by how far it got
 * (≥ +0.5R right, ≤ −0.5R wrong, in between inconclusive — 2026-10-28: +0.28R / +0.37R time exits
 * were "wrong" and the diagnosis invented causes for them); not triggered / no bars = null.
 * `score` = the R multiple realised by the plan.
 */
export function scoreTradeSetup(r: TradeSetupVerifyRow): VerificationDraft {
  const judged = r.outcomeStatus === 'TARGET1' || r.outcomeStatus === 'STOP' || r.outcomeStatus === 'TIME_EXIT';
  const actual =
    r.outcomeStatus === 'NOT_TRIGGERED'
      ? 'entry never triggered'
      : r.outcomeStatus === 'NO_DATA'
        ? 'no intraday bars to judge'
        : `${r.outcomeStatus === 'TARGET1' ? 'hit T1' : r.outcomeStatus === 'STOP' ? 'stopped out' : 'time exit 15:10'}${r.outcomeR !== null ? ` (${r.outcomeR >= 0 ? '+' : ''}${r2(r.outcomeR)}R)` : ''}`;
  return {
    sessionDate: r.sessionDate,
    kind: 'TRADE_SETUP',
    refId: r.id,
    subject: r.side,
    symbol: r.symbol,
    predicted: `${r.side} ${r.instrument}: opening-range break, T1 1.5R before stop`,
    actual,
    correct: !judged ? null : r.outcomeStatus === 'TIME_EXIT' ? timeExitCorrect(r.outcomeR) : r.outcomeStatus === 'TARGET1',
    score: judged && r.outcomeR !== null ? r2(r.outcomeR) : null,
    details: {
      status: r.outcomeStatus,
      entryRef: r.entryRef,
      stopDistance: r.stopDistance,
      entryPrice: r.outcomeEntryPrice,
      exitPrice: r.outcomeExitPrice,
      hitT1: r.outcomeHitT1,
      ...(r.entryRule ? { entryRule: r.entryRule } : {}),
      ...(typeof r.atr === 'number' ? { atr: r.atr } : {}),
      ...(r.newsIdea ? { newsIdea: r.newsIdea } : {}),
    },
  };
}

// ─── Telegram channel tips (signal-intake, stream S) ─────────────────────────

export interface ChannelSignalVerifyRow {
  id: string;
  /** The session the outcome is scored on (signal-intake's outcomeSession). */
  sessionDate: string;
  channelId: string;
  underlying: string;
  instrumentKind: string;
  strike: number | null;
  side: string;
  entryType: string;
  entryLow: number;
  entryHigh: number;
  sl: number | null;
  targets: number[];
  horizon: string;
  parser: string;
  outcomeStatus: string;
}

const CHANNEL_ACTUAL: Record<string, string> = {
  TARGET1: 'target 1 before the SL',
  SL: 'SL before target 1',
  NEITHER: 'neither by the horizon end',
  NOT_TRIGGERED: 'entry never triggered',
  NO_DATA: 'no bars to judge',
  NO_LEVELS: 'no SL and no target in the call',
  UNRESOLVED: 'contract not resolved',
};

export interface ChannelInfoVerifyRow {
  id: string;
  /** The session the row's outcome is scored on (signal-intake's channel_infos.outcomeSession). */
  sessionDate: string;
  channelId: string;
  messageId: string;
  extractor: string;
  items: Array<{
    underlying: string;
    bias: string | null;
    levels: number[];
    targetLevel: number | null;
    condition: { driver: string; direction: string | null } | null;
    /** VIEW / CATALYST / WATCH / MACRO / MARKET (absent before 2026-10-27 = VIEW). */
    kind?: string;
    horizon: string | null;
  }>;
  outcomes: Array<{ status: string; session: string | null; ret: number | null; band: number | null; levelHit: boolean | null } | null>;
}

const INFO_ACTUAL: Record<string, string> = {
  NOT_JUDGED_MONTHS: 'horizon months: recorded, not judged',
  NO_DATA: 'no bars to judge',
};

/**
 * CHANNEL_INFO (2026-10-24): every directional (BULL / BEAR) item of a Telegram INFO post, judged by
 * signal-intake on the underlying's daily bars: the close-to-close move beyond ±0.3×ATR in the item's
 * direction → right, against → wrong, inside the band / not judgeable / MONTHS → null. refId =
 * `<channel_infos.id>:<item index>`, subject = channel id, details.levelHit = a level / target traded.
 */
export function scoreChannelInfo(r: ChannelInfoVerifyRow): VerificationDraft[] {
  const out: VerificationDraft[] = [];
  r.items.forEach((it, i) => {
    if (it.bias !== 'BULL' && it.bias !== 'BEAR') return;
    const o = r.outcomes[i] ?? null;
    const status = o?.status ?? 'NO_DATA';
    const correct = status === 'RIGHT' ? true : status === 'WRONG' ? false : null;
    const lv = it.levels.length ? ` levels ${it.levels.join('/')}` : '';
    const cond = it.condition ? ` if ${it.condition.driver} ${it.condition.direction ?? '?'}` : '';
    const actual =
      INFO_ACTUAL[status] ??
      (o && o.ret !== null && o.band !== null ? `close-to-close ${signText(o.ret)} vs band ±${r1(o.band)} (${status.toLowerCase()})` : status.toLowerCase());
    out.push({
      sessionDate: r.sessionDate,
      kind: 'CHANNEL_INFO',
      refId: `${r.id}:${i}`,
      subject: r.channelId,
      symbol: it.underlying,
      predicted: `${it.bias} ${it.underlying}${lv}${cond} (${it.horizon ?? 'next session'})`,
      actual,
      correct,
      score: correct === null ? null : correct ? 1 : -1,
      // infoKind (VIEW / CATALYST / WATCH / MACRO / MARKET) so accuracy can be read per kind of post.
      details: { status, ret: o?.ret ?? null, band: o?.band ?? null, levelHit: o?.levelHit ?? null, horizon: it.horizon, infoKind: it.kind ?? 'VIEW', extractor: r.extractor, messageId: r.messageId, channelId: r.channelId },
    });
  });
  return out;
}

/**
 * CHANNEL_SIGNAL (contract 2026-10-23 §Self-review): every parsed tip, traded or not, replayed on its
 * own contract's bars by signal-intake after the close. Target 1 before the SL → right; SL first →
 * wrong; neither by the horizon end, never triggered, no levels / bars / contract → null.
 * subject = channel id (the per-channel stats key), score = +1 / −1 / null.
 */
export function scoreChannelSignal(r: ChannelSignalVerifyRow): VerificationDraft {
  const correct = r.outcomeStatus === 'TARGET1' ? true : r.outcomeStatus === 'SL' ? false : null;
  const contract = `${r.underlying}${r.strike !== null ? ` ${r.strike}` : ''} ${r.instrumentKind}`;
  const entry = r.entryLow === r.entryHigh ? `${r.entryLow}` : `${r.entryLow}-${r.entryHigh}`;
  return {
    sessionDate: r.sessionDate,
    kind: 'CHANNEL_SIGNAL',
    refId: r.id,
    subject: r.channelId,
    symbol: r.underlying,
    predicted: `${r.side} ${contract} ${r.entryType} ${entry} SL ${r.sl ?? '-'} T1 ${r.targets[0] ?? '-'}`,
    actual: CHANNEL_ACTUAL[r.outcomeStatus] ?? r.outcomeStatus,
    correct,
    score: correct === null ? null : correct ? 1 : -1,
    details: { status: r.outcomeStatus, horizon: r.horizon, parser: r.parser, channelId: r.channelId },
  };
}
