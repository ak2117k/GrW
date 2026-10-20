/**
 * Wire shapes of `GET /api/night-report`, exactly as agreed in
 * docs/superpowers/plans/2026-10-20-night-report-contract.md (the web copies
 * them; the API does not import @td/shared).
 *
 * Every section is fail-soft: either its payload or `{ error }`, so one broken
 * source never blanks the page. Times are ISO UTC strings.
 */

import type { NewsIdea, Scorecard } from '../../overnight-scorecard/scorecard.types';

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
  jobs: Section<JobItem[]>;
  /** News ideas created since the last NSE close, newest first. */
  newsIdeas: Section<NewsIdeaItem[]>;
}
