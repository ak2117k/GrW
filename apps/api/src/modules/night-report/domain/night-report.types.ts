/**
 * Wire shapes of `GET /api/night-report`, exactly as agreed in
 * docs/superpowers/plans/2026-10-20-night-report-contract.md (the web copies
 * them; the API does not import @td/shared).
 *
 * Every section is fail-soft: either its payload or `{ error }`, so one broken
 * source never blanks the page. Times are ISO UTC strings.
 */

import type { NewsIdea, Scorecard } from '../../overnight-scorecard/scorecard.types';
import type { BigMoveWatchView } from '../../stock-move/stock-move.service';
import type { TradeSetupsView } from '../../trade-setup/domain/trade-setup.view';

export type { BigMoveWatchRow, BigMoveWatchView } from '../../stock-move/stock-move.service';
export type { TradeSetupView, TradeSetupsView } from '../../trade-setup/domain/trade-setup.view';

export type Section<T> = T | { error: string };

/**
 * A chart target. `chartHref` is the web's chart deep link
 * (`/charts?symbol=…&token=…&exchange=…`, see apps/web/src/utils/chartHref.ts);
 * `token` is omitted from the link when unknown and the web resolves it by search.
 */
export interface SymbolRef {
  symbol: string;
  exchange: string;
  token: string | null;
  chartHref: string;
}

export interface NightWindow {
  /** The last NSE session close (15:30 IST) at or before now. */
  from: string;
  to: string;
  /** The next NSE session open strictly after now. */
  nextOpen: string | null;
  /** e.g. "Today is an NSE holiday (Dussehra)"; null on an ordinary night. */
  holidayNote: string | null;
}

export interface NightSummary {
  positions: number;
  exitAtOpen: number;
  tighten: number;
  held: number;
  newsOnPositions: number;
  eventsToday: number;
}

/** OVERNIGHT_REVIEW | PRE_OPEN_REVIEW | PRE_OPEN_CHECK | LIVE */
export type VerdictWindow = 'OVERNIGHT_REVIEW' | 'PRE_OPEN_REVIEW' | 'PRE_OPEN_CHECK' | 'LIVE';

export interface VerdictView {
  verdict: string;
  confidence: string | null;
  /** The "OVERNIGHT RISK:" half of the reason (the whole reason for a live verdict). */
  risk: string;
  /** The "OPEN PLAN:" half; null when the reason carries none. */
  plan: string | null;
  invalidation: string | null;
  at: string;
  window: VerdictWindow;
}

export interface PositionRow {
  trackerId: string;
  instrument: SymbolRef;
  /** The contract's underlying; null for a cash position. */
  underlying: SymbolRef | null;
  /** Tracker kind: `POSITION` (F&O, reviewed overnight) or `HOLDING` (delivery, never reviewed overnight). */
  kind: string;
  qty: number;
  entryPrice: number;
  ltp: number | null;
  pnl: number | null;
  pnlPct: number | null;
  /** In AI_AUTO_EXIT_HOLD: the owner holds this position against the AI. */
  held: boolean;
  overnight: VerdictView | null;
  preOpen: VerdictView | null;
  live: VerdictView | null;
  /** The newest OVERNIGHT / PRE_OPEN scorecard since the last close; null when none or the read failed. */
  scorecard: Scorecard | null;
}

/**
 * One news idea (overnight-scorecard). The outcome fields and `url` (the headline article's url)
 * are null until known.
 */
export type NewsIdeaItem = NewsIdea & {
  scorecard: Scorecard | null;
  nextOpen: number | null;
  nextClose: number | null;
  moveBp: number | null;
  filledAt: string | null;
  url: string | null;
};

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

export interface NewsSection {
  onPositions: NewsGroup[];
  market: NewsItem[];
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

export interface MoodView {
  status: 'ok' | 'stale' | 'absent';
  asOf: string | null;
  horizons: Record<string, { p: number; regime: string; q25Bp: number | null; q75Bp: number | null }>;
}

/** One regime's slice of a scorecard window. Rates are 0..1; null when nothing resolved. */
export interface ModelRegimeStats {
  predictions: number;
  resolved: number;
  /** Share of resolved calls right at p ≥ 0.5 (a QUIET hit is "said small, was small"). */
  hitRate: number | null;
  /** Share of resolved outcomes that were big moves: the regime's own base rate. */
  bigRate: number | null;
}

/** The MBM move-size model over one window of sessions, for one horizon. */
export interface ModelWindowStats {
  /** 1, 5 or 20: what the window asks for. */
  requestedSessions: number;
  /** Sessions actually covered (fewer while the model is younger than the window). */
  sessions: number;
  fromDate: string | null;
  toDate: string | null;
  predictions: number;
  /** sessions × runs per session. */
  expected: number;
  /** predictions / expected × 100; below 100 means skipped (stale) runs. */
  coveragePct: number | null;
  resolved: number;
  hitRate: number | null;
  baseRate: number | null;
  brier: number | null;
  /** Brier of always predicting the window's base rate: baseRate × (1 − baseRate). */
  brierBase: number | null;
  /** 1 − brier / brierBase; > 0 beats the base rate. Null on one class. */
  skill: number | null;
  auc: number | null;
  /** Why `auc` is null ("n/a: one class only"); null when it is a number. */
  aucNote: string | null;
  /** ACTIVE / NORMAL / QUIET always; any unknown regime seen too. */
  regimes: Record<string, ModelRegimeStats>;
  /** Range calibration on resolved rows: median actual range vs median q50, share inside [q25, q75]. */
  range: { n: number; medianActualBp: number | null; medianQ50Bp: number | null; insideIqrPct: number | null };
  /** Models that wrote the window's rows, most rows first. */
  models: Array<{ modelId: string; featureSet: string; predictions: number }>;
}

export interface ModelHorizonScorecard {
  /** Last session, rolling 5, rolling 20 — in that order. */
  windows: ModelWindowStats[];
}

export interface ModelScorecardView {
  instrument: string;
  runsPerSession: number;
  /** IST date of the last closed NSE session. */
  lastSession: string | null;
  /** IST date of the first session with a prediction inside the widest window. */
  liveSince: string | null;
  horizons: Record<string, ModelHorizonScorecard>;
}

export type JobStatus = 'ok' | 'stale' | 'missing';

export interface JobItem {
  name: string;
  status: JobStatus;
  at: string | null;
  detail: string;
}

export interface NightReport {
  generatedAt: string;
  window: NightWindow;
  summary: NightSummary;
  positions: Section<PositionRow[]>;
  news: Section<NewsSection>;
  events: Section<EventItem[]>;
  dailySetups: Section<SetupItem[]>;
  mood: Section<MoodView>;
  /** Is the live NIFTY move-size model skilful? Last session + rolling 5 / 20, per horizon. */
  modelScorecard: Section<ModelScorecardView>;
  jobs: Section<JobItem[]>;
  /** News ideas created since the last NSE close, newest first. */
  newsIdeas: Section<NewsIdeaItem[]>;
  /**
   * The latest self-review run — the same shape as GET /api/self-review/latest
   * (`{ run, summary, misses, lessonsAdded, proposalsPending }`), `{ error }` on failure, null
   * when the self-review module is not loaded.
   */
  selfReview: Section<unknown> | null;
  /**
   * Big-move watch (stock big-move model, shadow): held stocks + news-idea stocks + the day's top 10
   * TOP20 names, each with p, bucket, results date and last outcome. `{ error }` on failure, null
   * when the stock-move module is not loaded. A row with `reading: null` has no stock-move score yet.
   */
  bigMoveWatch: Section<BigMoveWatchView> | null;
  /**
   * Next-morning trade setups (advisory only — the owner places any order): news idea + big-move model
   * agree → a futures or intraday-cash plan for the next NSE session. `{ error }` on failure, null when
   * the trade-setup module is not loaded.
   */
  tradeSetups: Section<TradeSetupsView> | null;
}
