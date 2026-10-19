# Night Report — API ↔ web contract

Two parallel streams build against this. API: `apps/api/src/modules/night-report/`
(branch `feature/night-report`). Web: `apps/web` page `/night-report` (branch `feature/night-report-web`).

`GET /api/night-report` (JWT, scoped to the requesting user). Every section is either its payload or
`{ "error": "<message>" }` — the web renders the rest when one fails. Times are ISO UTC strings.

```ts
interface NightReport {
  generatedAt: string;
  window: { from: string; to: string; nextOpen: string | null; holidayNote: string | null };
  summary: { positions: number; exitAtOpen: number; tighten: number; held: number; newsOnPositions: number; eventsToday: number };
  positions: Section<PositionRow[]>;
  news: Section<{ onPositions: NewsGroup[]; market: NewsItem[] }>;
  events: Section<EventItem[]>;
  dailySetups: Section<SetupItem[]>;
  mood: Section<{ status: 'ok' | 'stale' | 'absent'; asOf: string | null;
                  horizons: Record<string, { p: number; regime: string; q25Bp: number | null; q75Bp: number | null }> }>;
  jobs: Section<JobItem[]>;
}
type Section<T> = T | { error: string };

interface SymbolRef { symbol: string; exchange: string; token: string | null; chartHref: string }
// chartHref: the web app's existing chart deep link for that symbol (API builds it so both sides agree;
// the API stream finds the format by grepping how pages link to ChartsPage).

interface VerdictView { verdict: string; confidence: string | null; risk: string; plan: string | null;
                        invalidation: string | null; at: string; window: string }   // window: OVERNIGHT_REVIEW | PRE_OPEN_REVIEW | PRE_OPEN_CHECK | LIVE

interface PositionRow {
  trackerId: string; instrument: SymbolRef; underlying: SymbolRef | null;   // underlying for options/futures
  kind: string; qty: number; entryPrice: number; ltp: number | null; pnl: number | null; pnlPct: number | null;
  held: boolean;                       // in AI_AUTO_EXIT_HOLD
  overnight: VerdictView | null; preOpen: VerdictView | null; live: VerdictView | null;
}

interface NewsItem { id: string; title: string; summary: string | null; source: string; url: string;
                     publishedAt: string; sentiment: string | null; sentimentScore: number | null; symbols: SymbolRef[] }
interface NewsGroup { symbol: SymbolRef; items: NewsItem[] }

interface EventItem { id: string; kind: string; title: string; startsAt: string; allDay: boolean;
                      impact: string | null; scope: string | null; touchesPositions: SymbolRef[] }

interface SetupItem { instrument: SymbolRef; setup: string; action: 'LONG_SETUP' | 'EXIT_OR_TIGHTEN_LONGS' | string;
                      signalDate: string; close: number; ret5dBp: number | null; ret10dBp: number | null; ret20dBp: number | null }

interface JobItem { name: string; status: 'ok' | 'stale' | 'missing'; at: string | null; detail: string }
```

Web types: copy these interfaces into the web app's API types (or `packages/shared` if the repo already shares API
types there — the web stream decides). The web stream develops against a fixture JSON of this shape and must not
depend on API internals.
