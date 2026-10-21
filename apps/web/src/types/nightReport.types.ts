/**
 * Wire shape of `GET /api/night-report`, copied from
 * docs/superpowers/plans/2026-10-20-night-report-contract.md. The web builds
 * against this contract only, never against API internals. Times are ISO UTC.
 */

import type { SelfReviewLatest } from './selfReview.types';

/** Every section is its payload or `{ error }`; the page renders the rest when one fails. */
export interface SectionError {
  error: string;
}
export type Section<T> = T | SectionError;

export interface SymbolRef {
  symbol: string;
  exchange: string;
  token: string | null;
  /** The web app's chart deep link for this symbol, built by the API. */
  chartHref: string;
}

export interface VerdictView {
  verdict: string;
  confidence: string | null;
  risk: string;
  plan: string | null;
  invalidation: string | null;
  at: string;
  /** OVERNIGHT_REVIEW | PRE_OPEN_REVIEW | PRE_OPEN_CHECK | LIVE */
  window: string;
}

export interface PositionRow {
  trackerId: string;
  instrument: SymbolRef;
  /** The underlying for options and futures. */
  underlying: SymbolRef | null;
  /** Tracker kind: `POSITION` (F&O, reviewed overnight) or `HOLDING` (delivery, never reviewed overnight). */
  kind: string;
  qty: number;
  entryPrice: number;
  ltp: number | null;
  pnl: number | null;
  pnlPct: number | null;
  /** In AI_AUTO_EXIT_HOLD. */
  held: boolean;
  overnight: VerdictView | null;
  preOpen: VerdictView | null;
  live: VerdictView | null;
  /** Latest overnight/pre-open scorecard for this position; null until one is computed. */
  scorecard: Scorecard | null;
}

// ---- Overnight scorecard + news ideas, copied from
// apps/api/src/modules/overnight-scorecard/scorecard.types.ts
// (docs/superpowers/plans/2026-10-20-overnight-scorecard-build.md).

export type FactorName = 'oi' | 'fii_dii' | 'vix' | 'expiry' | 'news' | 'indicators' | 'mood';
export interface FactorScore {
  name: FactorName;
  /** + supports the position's direction (long CE/long fut = bullish; long PE = bearish). */
  points: -2 | -1 | 0 | 1 | 2;
  /** Compact raw reading, e.g. "PCR 2.1 (5d med 1.3), put build +18% @1260". */
  value: string;
  reason: string;
  /** false ⇒ points 0 and reason says what was missing. */
  available: boolean;
}
/** ≤-4 | -3..-1 | 0 | 1..3 | ≥4 */
export type Band = 'STRONG_AGAINST' | 'AGAINST' | 'NEUTRAL' | 'SUPPORTS' | 'STRONG_SUPPORTS';
export type ScoreWindow = 'OVERNIGHT' | 'PRE_OPEN' | 'NEWS_IDEA';
export interface Scorecard {
  id?: string;
  userId: string | null;
  symbol: string;
  exchange: string;
  underlying: string;
  /** The direction the position/idea needs. */
  side: 'BULLISH' | 'BEARISH';
  window: ScoreWindow;
  computedAt: string;
  factors: FactorScore[];
  total: number;
  band: Band;
}
export type IdeaKind = 'CE_IDEA' | 'PE_IDEA' | 'NO_TRADE';
export interface NewsIdea {
  id?: string;
  createdAt: string;
  symbol: string;
  exchange: string;
  newsIds: string[];
  headline: string;
  idea: IdeaKind;
  rationale: string;
  invalidation: string;
  whatToDo: string;
  scorecardId: string | null;
}
/**
 * Outcome columns of `news_ideas` (next_open, next_close, move_bp, filled_at), filled the next
 * session. Not in the shared contract type, so all optional: the page shows an outcome only
 * when `filledAt` is set.
 */
export interface NewsIdeaOutcome {
  nextOpen?: number | null;
  nextClose?: number | null;
  moveBp?: number | null;
  filledAt?: string | null;
  /** Source article URL if the API sends one; linked only when it is http(s). */
  url?: string | null;
}
export type NewsIdeaRow = NewsIdea & NewsIdeaOutcome & { scorecard: Scorecard | null };

export interface NewsItem {
  id: string;
  title: string;
  summary: string | null;
  source: string;
  url: string;
  publishedAt: string;
  sentiment: string | null;
  sentimentScore: number | null;
  symbols: SymbolRef[];
}

export interface NewsGroup {
  symbol: SymbolRef;
  items: NewsItem[];
}

export interface EventItem {
  id: string;
  kind: string;
  title: string;
  startsAt: string;
  allDay: boolean;
  impact: string | null;
  scope: string | null;
  touchesPositions: SymbolRef[];
}

export interface SetupItem {
  instrument: SymbolRef;
  setup: string;
  action: 'LONG_SETUP' | 'EXIT_OR_TIGHTEN_LONGS' | string;
  signalDate: string;
  close: number;
  ret5dBp: number | null;
  ret10dBp: number | null;
  ret20dBp: number | null;
}

export interface MoodHorizon {
  p: number;
  regime: string;
  q25Bp: number | null;
  q75Bp: number | null;
}

export interface MoodView {
  status: 'ok' | 'stale' | 'absent';
  asOf: string | null;
  horizons: Record<string, MoodHorizon>;
}

/** Copied from apps/api night-report.types.ts (ModelRegimeStats … ModelScorecardView). Rates are 0..1. */
export interface ModelRegimeStats {
  predictions: number;
  resolved: number;
  hitRate: number | null;
  bigRate: number | null;
}

export interface ModelWindowStats {
  requestedSessions: number;
  sessions: number;
  fromDate: string | null;
  toDate: string | null;
  predictions: number;
  expected: number;
  coveragePct: number | null;
  resolved: number;
  hitRate: number | null;
  baseRate: number | null;
  brier: number | null;
  brierBase: number | null;
  skill: number | null;
  auc: number | null;
  aucNote: string | null;
  regimes: Record<string, ModelRegimeStats>;
  range: { n: number; medianActualBp: number | null; medianQ50Bp: number | null; insideIqrPct: number | null };
  models: Array<{ modelId: string; featureSet: string; predictions: number }>;
}

export interface ModelHorizonScorecard {
  /** Last session, rolling 5, rolling 20. */
  windows: ModelWindowStats[];
}

export interface ModelScorecardView {
  instrument: string;
  runsPerSession: number;
  lastSession: string | null;
  liveSince: string | null;
  horizons: Record<string, ModelHorizonScorecard>;
}

export interface JobItem {
  name: string;
  status: 'ok' | 'stale' | 'missing';
  at: string | null;
  detail: string;
}

export interface NightReportSummary {
  positions: number;
  exitAtOpen: number;
  tighten: number;
  held: number;
  newsOnPositions: number;
  eventsToday: number;
}

export interface NightReport {
  generatedAt: string;
  window: { from: string; to: string; nextOpen: string | null; holidayNote: string | null };
  summary: NightReportSummary;
  positions: Section<PositionRow[]>;
  news: Section<{ onPositions: NewsGroup[]; market: NewsItem[] }>;
  events: Section<EventItem[]>;
  dailySetups: Section<SetupItem[]>;
  /** Absent from responses built before the scorecard stream shipped; the page treats that as empty. */
  newsIdeas: Section<NewsIdeaRow[]>;
  mood: Section<MoodView>;
  /** Absent from responses built before the ML model scorecard shipped. */
  modelScorecard?: Section<ModelScorecardView>;
  /** Absent from responses built before the self-review loop shipped (2026-10-21 contract). */
  selfReview?: Section<SelfReviewLatest> | null;
  jobs: Section<JobItem[]>;
}
