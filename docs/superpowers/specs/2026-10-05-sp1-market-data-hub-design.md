# SP1 — Market Data Hub — Design

**Date:** 2026-10-05
**Status:** Approved in conversation (sections 1–6); awaiting review of this written spec
**Parent:** `docs/superpowers/specs/2026-09-30-ai-trading-core-architecture-design.md` (§5 Data path, §11 SP1)
**Host:** 2 GB monthly KVM VPS in Mumbai (see the parent spec's §10 amendment)

---

## 1. Problem

The owner's observation: *"everything is interconnected — if one thing gets delayed, everything gets delayed."*
A read-only map of the code (2026-10-04) shows why:

1. **Two broker stacks.** A shared singleton stack (`AngelOneAuthService` / `AngelOneAdapterService` /
   `AngelOneWebSocketService`) logs in with a "feed account" that does not exist in production; a
   per-user stack (`UserFeedManager` → `UserFeedSession`) uses each user's own credentials. Roughly
   half the consumers (all `*-track` pollers via `ExitPriceService`, watch-rescore scoring, depth,
   search, option chain, backfills, scanners) are on the shared stack and **silently get nothing**.
2. **No rate governance.** The 350 ms historical gate covers only the shared lane. Per-user calls,
   `seedQuoteCacheFromRest` (~30 concurrent quotes every 5 s), per-strike option quotes and chart
   fan-out hit Angel One unserialised. A throttle returns `[]`, indistinguishable from "no data".
3. **The same price fetched many times.** One open position is priced by ~6 loops (trade-tracker
   12 s, sentinel 30 s, track pollers 30 s, watch-backstop 30 s, stock-monitor 5 s) plus browser
   polls (quote 3 s, depth 2 s, live-edge candles 20 s, chart-context 60 s).
4. **Silent staleness.** `getLiveQuote` returns a cached tick of any age labelled fresh;
   `MarketFeedService.quoteCache` never expires; the option chain can serve a 7-day snapshot;
   `/quote` falls back to `spot || vwap || prevClose`.
5. **Candles.** Charts call the broker on every load (≈5–6 serial 350 ms calls for 15m). Intraday
   persistence is partial, tick volume is double-counted (cumulative day volume summed), three
   backfillers overlap on 1d, and TimescaleDB is installed but no hypertable exists.
6. **Session timing in 8 places**, none holiday-aware (`market-holidays.service.ts` is registered
   nowhere); three crons have no timezone.
7. **Exchange mapping bugs.** The gateway hard-codes `NSE` for every client token; `UserFeedSession`
   has no NFO mapping; shared unsubscribe always sends NSE_CM.

## 2. Goal and success criteria

One **Market Data Hub per broker session** that is the **only** component allowed to request market
data from Angel One. For the personal MVP there is exactly one hub, on the owner's own account.

| Criterion | Target (measured in production) |
|---|---|
| Open-position price age | ≤ 5 s all session; zero unpriced positions |
| Chart cold load | < 300 ms p95 (database read) |
| Option chain load | < 1 s, with its age shown |
| Throttles | ~0 per hour in normal operation; never surfaced as "no data" |
| Stale prices served without a label | 0 |
| Broker data calls outside the hub | 0 (enforced by a test) |
| Memory | healthy on the 2 GB host |

**Live set:** ~5 open positions + their underlyings + ~6 index/context symbols + ~5–10 candidates
and watchlist + 1–2 viewed charts ≈ 20–25 instruments.

**Decisions taken:**
- Approach A: a new `market-hub` module; consumers migrate one at a time; old paths deleted after.
- The shared "feed account" stack is **removed**. The hub runs on the owner's per-user session.
  Multi-tenant later = one hub per user's own broker session (data is never shared across users).

## 3. Components

```
MARKET HUB (one per broker session)
  1. BrokerSession   login, token refresh; owns the one WebSocket + REST client
  2. Governor        every REST call: priority lanes, per-endpoint budgets, coalescing, batching
  3. LiveFeed        WebSocket slots allocated by priority
  4. PriceBook       the one price cache; every price carries value, time, source
  5. QuotePoller     near-live tier: batched quotes for watched symbols without a live slot
  6. CandleStore     ticks → 1m candles → TimescaleDB; gap fill; nightly fix-up
  7. SessionClock    market hours + holidays per exchange; drives the hub's daily rhythm
  + OptionChain      chain + OI snapshots built on 2, 3, 4
```

`BrokerSession` is built from the existing `UserFeedSession` logic (login via vault lease, TOTP,
`generateSession`, WebSocketV2) and is the only holder of a SmartAPI client for market data.

### 3.1 Hub API (the only door)

Every instrument reference is `InstrumentRef = { exchange, token, symbol }` with exchange one of
`NSE | BSE | NFO | BFO | MCX`.

| Method | Behaviour |
|---|---|
| `watch(ref, priority, owner, ttlMs?)` / `unwatch(ref, owner)` | Declares interest. The hub chooses live slot or near-live polling. Watches with a TTL expire unless renewed (screens: 2 min). |
| `price(ref, { maxAgeMs })` | Returns a `PriceResult` (§5.3). Never an unlabelled stale price. |
| `prices(refs, { maxAgeMs })` | Bulk form of the above. |
| `candles(ref, timeframe, from, to, { lane })` | Database first; fills gaps via the Governor; returns `{ candles, incomplete?: Range[] }`. |
| `chain(underlying, expiry, { strikesAround })` | §7. |
| `session.isOpen(exchange)`, `phase(exchange)`, `minutesToClose(exchange)`, `isTradingDay(exchange, date)`, `nextOpen(exchange)` | §8. |
| `ticks$` (in-process event stream) | Live price updates for the Position Manager, gateway, level books. |

## 4. Governor

### 4.1 Lanes (strict priority)

| Lane | Callers | Rule |
|---|---|---|
| 0 Critical | open-position pricing, exits, stop checks, WS-down fallback for priorities 0–1 | always first |
| 1 Interactive | a user waiting on a screen: chart gap fill, quote, chain | next; deadline ~5 s, then fails with `busy` |
| 2 Routine | QuotePoller, strategy scans | remaining capacity |
| 3 Background | backfill, nightly fix-up, instrument master | only when lanes 0–2 are idle; during market hours limited to a trickle (≤ 1 request / 5 s) |

### 4.2 Per-endpoint budgets

Angel One limits are per client code, per endpoint (forum, 2026): quote 10/s with up to 50 symbols
per call; `getCandleData` 3/s; `searchScrip` 1/s; `optionGreek` 1/s. Order APIs (9/s combined) are
outside this hub. Hub budgets sit **below** the limits and are configurable:

| Endpoint | Default budget |
|---|---|
| quote (`marketData` LTP/FULL) | 5/s |
| `getCandleData` | 2.5/s |
| `searchScrip` | 0.8/s |
| `optionGreek` | 0.8/s |

### 4.3 Coalescing and batching
- Identical in-flight requests (same endpoint + parameters) are merged; all callers get the one result.
- Single-quote requests arriving within a 150 ms window are combined into one call of up to 50
  symbols (grouped by exchange as the API requires).

### 4.4 Throttling and errors
- A broker rate-limit response sets that endpoint into back-off (1 s → 2 s → 4 s … cap 30 s) and
  returns an explicit `Throttled { retryAfterMs }` to callers. **Never `[]`.**
- Auth failures surface as `NoSession`; the BrokerSession re-authenticates once, then alerts.

### 4.5 Metrics (`/healthz/detail`)
Per lane: queue depth, wait p50/p95. Per endpoint: calls/min, throttles/hour, back-off state.

## 5. Live tier, near-live tier, PriceBook

### 5.1 LiveFeed
- One WebSocketV2 on the owner's session. Slot cap configurable, default **50** (today's value);
  confirming Angel One's real per-connection limit is an implementation-plan task.
- Allocation by priority:

| P | Class | Never demoted |
|---|---|---|
| 0 | Open-position contracts | ✔ |
| 1 | Their underlyings | ✔ |
| 2 | Market context (NIFTY, BANKNIFTY, FINNIFTY, INDIA VIX, CRUDEOIL …) | |
| 3 | Active candidates + watchlist | |
| 4 | Viewed charts | |

- Over cap: the lowest priority is demoted to near-live and the demotion is counted. If P0+P1 alone
  exceed the cap, an alert fires.
- Subscriptions use the correct exchange type (NSE_CM, NSE_FO, BSE_CM, BSE_FO, MCX_FO). Option
  contracts subscribe in a mode that carries OI.
- **WS down:** P0–P1 switch to Critical-lane polling every ~2 s until reconnect; reconnect uses
  exponential back-off and re-subscribes the current allocation.
- Each tick: PriceBook update → CandleStore → `ticks$`.

### 5.2 QuotePoller
- Every ~5 s, batch-quotes watched instruments without a live slot whose price is older than the
  target (Routine lane, ≤ 50 per call).
- Polls only instruments with a live watch; never a closed exchange (SessionClock).

### 5.3 PriceBook
`Price = { ref, ltp, at, source: 'ws' | 'quote' | 'db', volume?, oi?, bid?, ask? }`

`price(ref, { maxAgeMs })` returns exactly one of:

| Result | Meaning |
|---|---|
| `Fresh(Price)` | age ≤ maxAgeMs |
| `MarketClosed(Price)` | exchange closed; last known price, labelled |
| `Stale(Price, ageMs)` | caller decides |
| `Unavailable(reason)` | `not-watched` · `throttled` · `no-session` · `never-priced` |

Standard maxAge: Position Manager 5 s, trading decisions 10 s, screens 15 s.
Bounded in memory (LRU, a few thousand entries). Empty after restart; refilled by the first poll
(~5 s) — no pre-restart prices are trusted.

## 6. CandleStore

### 6.1 Tables

| Table | Content | Source | Retention |
|---|---|---|---|
| `candles_1m` (hypertable, compressed after 7 days) | 1-minute OHLCV (+ OI where available) with `source: tick \| broker` | live ticks; broker for gaps and nightly fix-up | 180 days |
| `candles_1d` | daily OHLCV | Angel One official daily after close | permanent |
| 5m / 15m / 30m / 1h | continuous aggregates over `candles_1m` | TimescaleDB | as 1m |
| 1w / 1mo | aggregated on read from `candles_1d` | existing `aggregateCandles` | — |

- Primary key `(instrument_id, ts)` (TimescaleDB requires the time column in unique indexes).
  Hypertable, compression and retention are created by raw-SQL Prisma migrations.
- The legacy `candles` table remains until all readers have moved (M6); its rows are then copied
  into the new tables and it is retired.
- Size estimate: ~25 symbols × 375 min × 250 days ≈ 2.3 M rows/year; a few hundred MB compressed.

### 6.2 Building from ticks
- Per live instrument, the current minute is held in memory and written on minute close in batches.
- **Volume = difference of cumulative day volume between ticks** (fixes today's double count).
- Only live-tier instruments get tick-built candles; others are filled from the broker on demand.

### 6.3 Read path
1. Query the database (target 10–50 ms).
2. Compute expected trading minutes from the SessionClock; find gaps.
3. Fetch only missing ranges via the Governor (Interactive if a user waits, else Background);
   store; return.
4. If still missing, return what exists with `incomplete: [ranges]`.

The chart's live edge comes from `ticks$` instead of 20 s polling.

### 6.4 Nightly fix-up (after the last close, Background lane)
- Replace today's tick-built 1m candles for live-tier instruments with broker 1m data.
- Write official 1d candles.
- Replaces `DailyCandleBackfillCron`, `DailyBackfillWorker` and the GapDetector's 1d role.

## 7. Option chain and OI

`chain(underlying, expiry, { strikesAround = 10 })`:
1. Contracts from the instrument master in the database (no broker call).
2. All ~42 CE+PE contracts in one or two batched FULL quotes (LTP, OI, volume, bid/ask).
3. Greeks/IV via one `optionGreek` call per underlying+expiry, cached 60 s.
4. Refreshed every ~10 s only while watched (a screen open, or an option held on that underlying).

- Held option contracts are in the live tier with OI, so OI on positions is real-time.
- OI snapshots every 3 minutes in market hours for held/watched underlyings, kept 30 days
  (existing `OISnapshot` / `OiWallSnapshot` models); "OI change since open" is a database query.
- The NSE website scrape (`nse-options-chain.service.ts`) is removed; Angel One is the single source.
- Every chain carries `at`; a non-live snapshot is labelled with its timestamp.

## 8. SessionClock

Builds on the tested pure helpers in `trade-sentinel/market-sessions.ts`.

| Venue | Default hours (configurable) |
|---|---|
| NSE / BSE cash | pre-open 09:00–09:08, trading 09:15–15:30 |
| NFO / BFO | 09:15–15:30 |
| MCX | 09:00–23:30, or 23:55 during the US-DST-linked window (configurable dates) |

- Holidays and special sessions (e.g. Muhurat) per exchange per year, seeded from
  `market-holidays.service.ts` (2026). If the next year's list is absent on 1 December, an alert fires.
- API in §3.1. All times are evaluated in Asia/Kolkata.
- Daily rhythm: 08:45 login + warm; 09:00 MCX live set; 09:14 NSE live set; per-venue stop at close;
  nightly fix-up after the last close.
- The three crons without a timezone (`auto-trade.periodicSignalScan`, risk-guard EOD square-off,
  `sr-level-tracking.evaluateCron`) get `timeZone: 'Asia/Kolkata'` in this project.
- Out of scope: moving the other scheduled jobs onto the SessionClock (parent spec B2).

## 9. Migration

Each step ships independently; each consumer switch has a config flag to revert to the old path
for one session.

| Step | Scope | Done when (production) |
|---|---|---|
| M1 | Hub core (BrokerSession, Governor, PriceBook, SessionClock, LiveFeed, QuotePoller) running in shadow, no consumers | One session with watched prices fresh and throttles ~0 |
| M2 | CandleStore + new tables + nightly fix-up; `/candles` served by the hub | Chart cold load < 300 ms p95 |
| M3 | Trade-tracker, sentinel tick source, `ExitPriceService` → `hub.price()` | All open positions ≤ 5 s old all session; zero unpriced |
| M4 | Gateway ticks from `ticks$`; quote, depth, indices, watchlist via hub; browser 2–3 s polls removed; gateway `toTokenRef` NSE hard-code fixed | Badge Live all session; no polling storm |
| M5 | Option chain + OI snapshots on the hub; NSE scrape and per-strike quotes removed | Chain < 1 s with age |
| M6 | Remaining consumers (watch-rescore/chartink scoring, scanners, level books, backtest, ML triggers, patterns, search); then delete the shared stack, `MarketFeedService`, `wsTickCache`, controller candle cache, overlapping backfillers, raw `getCandleData` debug endpoint | "Only door" test green; no broker data calls outside the hub |

The seven strategy-track modules are not rewritten here: they change only their price source,
through `ExitPriceService`. Their retirement is parent-spec SP6.

## 10. Testing and verification

- **Unit (fake clock):** Governor priority order, budgets, coalescing, 150 ms batching, throttle
  back-off → `Throttled`; slot allocator priorities, demotion, P0/P1 never demoted; PriceBook result
  kinds; volume-difference; gap detection; SessionClock holidays, MCX DST window, boundary minutes.
- **"Only door" architecture test:** fails the build if any file outside `modules/market-hub`
  imports the SmartAPI client or calls a broker market-data method.
- **FakeBroker** implementing the BrokerSession interface for local end-to-end tests.
- **Tick recorder:** live ticks written to disk compressed, kept 30 days; a replay harness feeds a
  recorded session through the CandleStore deterministically.
- **Production evidence (`/healthz/detail`):** lane wait p95; throttles/hour; oldest open-position
  price age and unpriced count; chart load p95; unlabelled-stale count (must be 0); RSS.
- **Rule inherited from the parent spec:** a step is complete when production shows it working, not
  when tests pass.

## 11. Error handling summary

| Situation | Behaviour |
|---|---|
| Broker throttles | endpoint back-off; callers get `Throttled`; positions keep their Critical-lane priority |
| WebSocket drops | P0–P1 fast polling; reconnect with back-off; badge shows Stale |
| Broker session expired | one re-auth; then `NoSession` + alert |
| Candle gap cannot be filled | partial series with `incomplete` ranges |
| Exchange closed | `MarketClosed(last price)`; no polling |
| Next year's holidays missing | alert on 1 December |

## 12. Out of scope

Order execution (SP2), the Position Manager itself (SP2), AI decision layer (SP3), news (SP4),
migrating the remaining scheduled jobs onto the SessionClock (parent B2), retiring the strategy
silos (SP6), multi-tenant hub fan-out beyond "one hub per broker session".

## 13. Open items for the implementation plan

- Confirm Angel One's WebSocketV2 per-connection token limit and the exact rate-limit response shape.
- Confirm MCX US-DST session dates for the current year.
- Decide the tick recorder's on-disk format (e.g. gzipped JSON lines per day).
- Measure hub RSS under the live set on the 2 GB host during M1.
