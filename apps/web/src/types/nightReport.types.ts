/**
 * Wire shape of `GET /api/night-report`, copied from
 * docs/superpowers/plans/2026-10-20-night-report-contract.md. The web builds
 * against this contract only, never against API internals. Times are ISO UTC.
 */

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
}

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
  mood: Section<MoodView>;
  jobs: Section<JobItem[]>;
}
