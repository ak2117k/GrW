# Swing Daily OHLC — Design Spec

**Date:** 2026-06-14
**Status:** Approved (brainstorming) → implementation

## Goal

For every swing trade (any status — TRADED / TARGET_HIT / STOPPED / etc.), record the
underlying stock's **daily OHLC** (open, high, low, close) **day by day** across:

- the full holding period (entry day → exit day), and
- up to **60 post-exit trading days** after the trade closes.

Display it on the Swing page as an **expandable row** per trade.

## Data model

New Prisma model `SwingDailyOhlc` (table `swing_daily_ohlc`):

| field        | type     | notes |
|--------------|----------|-------|
| id           | String   | cuid |
| swingEntryId | String   | FK → `SwingEntry.id`, `onDelete: Cascade` |
| date         | DateTime | trading day |
| open/high/low/close | Float | the day's candle |
| phase        | String   | `HOLD` (on/before exit) or `POST_EXIT` (after exit) |
| createdAt    | DateTime | default now |

Constraints: `@@unique([swingEntryId, date])` (idempotent upsert), `@@index([swingEntryId])`.
`SwingEntry` gains `dailyOhlc SwingDailyOhlc[]`.

Schema applied via **`prisma db push`** (this repo never uses `migrate dev`).

## Source & recording

- Daily candles come from `AngelOneAdapterService.getCandleData(token, exchange, ONE_DAY, from, to)`
  (already TTL-cached + serially rate-paced for the 3 req/sec historical limit).
- **Backfill:** for a trade, fetch `enteredAt → today` daily candles and upsert rows.
- **EOD worker** (~16:00 IST, after NSE close): for every swing entry still **in window**,
  upsert today's candle.
  - *In window* = `status == 'TRADED'` (open → tracks every day) **or**
    the trade has fewer than **60 `POST_EXIT` rows** recorded.
  - Counting stored post-exit rows (not calendar days) makes "60 trading days" automatic —
    Angel only returns candles on trading days, so holidays/weekends never need a calendar.
- `phase` = `POST_EXIT` when `date > exitedAt` (exited trades), else `HOLD`.

### Error handling
- Historical fetch is throttle-prone. The worker paces trades serially and, on an empty/throttled
  day, **skips and retries next run** rather than storing partial data or crashing. Missing days
  fill in on a later run. Independent of the WS/session-expiry crashes.

## API

`GET /api/anand/swing/:id/daily-ohlc` → `{ entry: { id, symbol, enteredAt, exitedAt, status }, rows: SwingDailyOhlc[] }`
rows sorted by `date` asc, each tagged `phase`. (Lazy-loaded on expand.)

## UI

- Shared `EntryRow` (used by Open Book / Entries / Recent Exits) gains an expand caret `▾`.
- On expand, lazy hook `useSwingDailyOhlc(id)` fetches and renders an inline table:
  `Date · Open · High · Low · Close`, exit day marked `← exit`, later rows tagged `(post-exit)`.

## Out of scope (YAGNI)
- No intraday OHLC, no charts (table only — chart can come later).
- Intraday track unchanged (swing-only).
