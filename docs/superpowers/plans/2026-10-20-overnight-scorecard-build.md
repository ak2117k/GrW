# Overnight Scorecard + News Ideas — build contract (4 parallel streams)

Design: `docs/superpowers/specs/2026-10-20-overnight-scorecard-design.md` (read it). Every stream works
in its own worktree/branch, commits with explicit pathspecs, never pushes/merges/touches prod, adds no
new tsc errors (baseline 174), ends commits with
`Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. Flags default **off**.

## Shared types — `apps/api/src/modules/overnight-scorecard/scorecard.types.ts` (stream B creates it FIRST and commits it alone, first commit on its branch; others copy the same text into their branch if they need it before merge)

```ts
export type FactorName = 'oi' | 'fii_dii' | 'vix' | 'expiry' | 'news' | 'indicators' | 'mood';
export interface FactorScore {
  name: FactorName;
  points: -2 | -1 | 0 | 1 | 2;   // + supports the position's direction (long CE/long fut = bullish; long PE = bearish)
  value: string;                 // compact raw reading, e.g. "PCR 2.1 (5d med 1.3), put build +18% @1260"
  reason: string;                // one line
  available: boolean;            // false ⇒ points 0 and reason says what was missing
}
export type Band = 'STRONG_AGAINST' | 'AGAINST' | 'NEUTRAL' | 'SUPPORTS' | 'STRONG_SUPPORTS'; // ≤-4 | -3..-1 | 0 | 1..3 | ≥4
export type ScoreWindow = 'OVERNIGHT' | 'PRE_OPEN' | 'NEWS_IDEA';
export interface Scorecard {
  id?: string; userId: string | null; symbol: string; exchange: string; underlying: string;
  side: 'BULLISH' | 'BEARISH';   // the direction the position/idea needs
  window: ScoreWindow; computedAt: string; factors: FactorScore[]; total: number; band: Band;
}
export type IdeaKind = 'CE_IDEA' | 'PE_IDEA' | 'NO_TRADE';
export interface NewsIdea {
  id?: string; createdAt: string; symbol: string; exchange: string; newsIds: string[]; headline: string;
  idea: IdeaKind; rationale: string; invalidation: string; whatToDo: string; scorecardId: string | null;
}
```

## Database (stream B owns the one Prisma migration, expand-only)
`analysis_scorecards`: id (cuid), user_id (nullable), symbol, exchange, underlying, side, window, computed_at
timestamptz, factors jsonb, total int, band text, verdict_id text null, next_open double null, next_close
double null, move_bp double null, filled_at timestamptz null. Index (user_id, window, computed_at desc),
(symbol, computed_at desc).
`news_ideas`: id, created_at, symbol, exchange, news_ids text[], headline, idea, rationale, invalidation,
what_to_do, scorecard_id null, ai_call_id null, outcome fields (next_open, next_close, move_bp, filled_at).

## Streams

**A — per-symbol chain capture (apps/api/src/modules/mbm/…).** Extend the existing NIFTY chain capture
(`MBM_CHAIN_CAPTURE`, table `mbm_chain_snapshots`) with a **dynamic list**: underlyings of the owner's
open Angel F&O positions + symbols in a shortlist provider (interface `ChainWatchlist { symbols(): Promise<{symbol,exchange}[]> }`
— stream A defines it in `apps/api/src/modules/mbm/chain-watchlist.ts` with a positions-based default and an
`add(symbols, ttlHours)` method that stream B's news scan calls). Stocks: every 15 min in session + an EOD
snapshot at 15:30, nearest expiry ±10 strikes (index: unchanged). Flag `MBM_CHAIN_CAPTURE_STOCKS=off|on`.
Also export `latestChain(symbol)` / `chainHistory(symbol, sessions)` read helpers for stream B.

**B — scorecard engine + news ideas + storage + API (apps/api/src/modules/overnight-scorecard/).**
Factor computers per the design §2 (pure functions, unit-tested): OI (from A's read helpers; `available:false`
until data exists), FII/DII (`market-cues`), VIX, expiry, news (`news_articles`), indicators (daily+15m from
`candles`), mood (`MbmClient`). Jobs: 15:40 IST and 08:50 IST compute scorecards for the owner's **real Angel
overnight positions** (find how broker-synced trackers are told apart from app/paper ones: `live-broker-sync`,
`trade_trackers.kind/userId`), store rows; outcome filler next session. News-ideas batch at 23:30 and 08:40:
shortlist (F&O-eligible via instrument master, strong sentiment / material NSE announcement, not held, cap 5),
compute scorecards, register symbols with A's watchlist, **one Sonnet call per batch** through the existing
judge transport / AI gateway (find the Sonnet-tier call path the sentinel uses; respect `SENTINEL_JUDGE`),
strict JSON output → `news_ideas`. Flags: `SCORECARD_ENABLED=off|observe|on`, `NEWS_IDEAS_ENABLED=off|on`.
API for others: `ScorecardService.latestFor(userId, trackerId|symbol, window)` and extend
`GET /api/night-report` sections with `positions[].scorecard: Scorecard|null` and a new
`newsIdeas: Section<(NewsIdea & {scorecard: Scorecard|null})[]>` (update the night-report contract doc too).

**C — sentinel integration (apps/api/src/modules/trade-sentinel/…).** For OVERNIGHT_REVIEW / PRE_OPEN_REVIEW /
PRE_OPEN_CHECK windows only: an optional packet block `scorecard` (≤ ~400 chars/position: `oi:+2 PCR 2.1…`)
built from an injected `ScorecardProvider { latest(userId, trackerId): Promise<Scorecard|null> }` (define the
interface in C; B implements it — wire via a token so C builds and tests with a fake). Prompt line (overnight
prompt): base the verdict on the scorecard; if the verdict goes against the total, name the overriding
factor. Flag `SENTINEL_SCORECARD=off|on`; off ⇒ packet/prompt byte-identical (prove with existing golden
fixtures).

**D — web (apps/web, Night Report page).** Against the contract types with a fixture: each position row
expands to the scorecard table (factor · points as −2…+2 pips · value · reason; missing factors greyed), band
chip, and a **"disagrees with scorecard"** warning chip when the agent's verdict direction contradicts the
band. New **"News ideas"** section: headline (safe http(s) link) → symbol chip (SymbolChartLink) → scorecard
→ idea badge (CE/PE/No trade) + rationale + invalidation + what to do + outcome when filled. Mobile-first,
vitest for helpers + a render test.
