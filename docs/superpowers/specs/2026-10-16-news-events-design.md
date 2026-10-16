# News & Events v2 — Design

**Date:** 2026-10-16 · **Status:** draft for owner review · **Trigger:** the sentinel judges every open position
(stocks, index options, MCX) but only sees headlines tagged to its exact underlying, has no idea that results, RBI
policy or the EIA inventory print are minutes away, and learns about a headline only on the next 30-s pass.

## 1. What is wrong today (evidence from the code)
- **Narrow tagging.** `news-sentiment.service.ts` tags `relatedSymbols` from tickers only (`extract-symbols.ts`:
  ALL-CAPS/Capitalised token ∩ the 18,949 listed base symbols) plus a hand list of 7 aliases
  (`underlying-news-aliases.ts`: CRUDEOIL, GOLD, SILVER, NATURALGAS, COPPER, NIFTY, BANKNIFTY). "Tata Motors
  recalls…" tags nothing; ZINC, ALUMINIUM, FINNIFTY, SENSEX… are reported "untaggable" (`newsKeyFor` → `key: null`).
- **One layer only in the live packet.** `SentinelNewsAdapter.recentFor` reads the exact symbol; sector, index and
  market headlines exist only in the overnight ladder (`overnight-evidence.adapter.ts:67-92`, scopes
  symbol → sector → index → macro, each a fresh DB query).
- **Window after the cap.** `NewsAggregatorService.getNewsForSymbol` is `orderBy publishedAt desc, take 20` with no
  date filter; every caller re-windows afterwards (`news.adapter.ts:47`, `tick-source.adapter.ts:802-814`), so
  `freshCount` saturates at 20 and correctness depends on each caller remembering. No GIN index on
  `relatedSymbols`, so each `has` lookup scans `news_articles`.
- **DB on the hot path.** Every packet build (`context-packet.service.ts:863-892`) and every 30-s tick
  (`freshNewsCount`) queries Postgres. Market cues already show the right shape: background fetch, `peek()` read.
- **`news-hit` is level-triggered and polled.** It fires on `freshNewsCount ≥ 1` (30-min window) every pass; a
  headline that lands at 10:00:05 is seen at the next pass, and the same headline re-fires for 30 minutes.
- **Sources rot silently.** Reuters Business, MarketWatch, LiveMint Companies, ET Stock News and ET Realty time out;
  MoneyControl returns 403; ET Earnings has a malformed URL (`…/rssfeeds/12aborede_2.cms`). `fetchFromSource`
  logs and returns `[]`, so a dead feed looks like a quiet one. (ET Commodities was added 2026-10-12.)
- **No events at all.** `fundamentals.service.ts` already parses Yahoo `nextEarningsDate`; nothing reads it.

## 2. Goals / non-goals / out of scope
**Goals:** every position, every venue, gets layered headlines (own → sector → index → market) and an `events`
block; **nothing is fetched or matched on the judgement path** (packet reads a pre-computed in-memory index,
~1 ms); a new headline on an open position or an imminent high-impact event wakes the judge within seconds;
dead sources are visible; flag off ⇒ byte-identical packets and prompts.
**Non-goals:** news never forces an exit, never changes the exit-discipline gate (§6 of the 2026-10-14 spec), never
places or cancels orders. Sentiment stays as is (AI-engine call, keyword fallback).
**Out of scope:** paid news / calendar APIs (Bloomberg, Refinitiv, Benzinga, TradingEconomics), ML sentiment or
LLM summarisation of articles, social media (X, Reddit, Telegram), full-article scraping, BSE announcements,
UI changes beyond what the existing news page already shows.

## 3. Shape: background everything, peek on the hot path
```
RSS (5 min) ─┐                       ┌─ NewsIndex (memory, per key) ── peek ──► packet.news (layered)
NSE ann. (3) ├─► ingest ─► tag-once ─┤                                └─ push ─► NewsWakeService ─► wakeForTick
Commodities ─┘     (DB write)        └─ news_articles (+tag columns)
NSE events / corp actions / macro config / EIA rules ─► EventsService (daily pre-open + refresh) ─ peek ─► packet.events
```
`NewsIndexService.peek(keys, now)` and `EventsService.peek(position, now)` are synchronous, no I/O, like
`MarketCuesService.peek()`. Both are rebuilt from the DB on boot and kept current by (a) an in-process push from
the ingester and (b) a 60-s delta poll on `fetchedAt > watermark` (covers a split worker process).

## 4. Sources and ingestion
1. **RSS** stays on the `news-fetch` Bull job (`NEWS_FETCH_CRONS`, every 5 min 08:00–23:30 IST). Fix ET Earnings to
   a valid ET earnings feed URL (verify 200 + `text/xml` in M0); re-test each failing feed from the VPS with a
   browser User-Agent and 15 s timeout — keep the ones that answer, **remove** the rest (no zombie entries); keep
   ET Commodities. Replacement candidates are verified, not assumed (Business Standard markets/companies, ET
   Markets stocks, Hindu BusinessLine markets/commodities, Investing.com commodities RSS).
2. **NSE corporate announcements** (new): `nseindia.com/api/corporate-announcements?index=equities` every 3 min
   09:00–17:30 IST on trading days, 15 min otherwise until 22:00. Each announcement becomes a `news_articles` row
   (`source='NSE Announcements'`, `category='company'`, `relatedSymbols=[symbol]` from the exchange's own field — no
   text matching needed), title = subject + description truncated. Dedupe by attachment URL (`url` is unique).
3. **Polite client** for every NSE call: the market-cues `guarded()` pattern — one request + one retry, browser UA,
   per-endpoint exponential backoff (base 60 s, max 30 min), never more often than the configured cadence, no
   parallel NSE calls (one shared NSE queue). If NSE requires a cookie (M0 spike), a homepage warm-up GET for
   `nseindia.com` only, cookie jar in memory, never logged — owner decision N4.
4. **Per-source health:** `{lastOkAt, lastError, consecutiveFailures, itemsLastFetch}` kept in memory and written to
   the log on change; a source with ≥ 6 consecutive failures is "down" and named in the packet's `news.asOf`.
5. **pubDate guard:** an item with a missing/unparseable date gets `publishedAt = fetchedAt` today, which can pass an
   old article off as fresh. v2 tags it `dateInferred=true` and keeps it out of `freshCount` and wakes.

## 5. Tag-once (at ingestion, never at read)
Each new article gets four tag sets, computed once and stored: **instruments**, **sectors**, **indices**, **markets**.
1. **Instruments — tickers:** `extractSymbols` unchanged (case rule, `AMBIGUOUS_SYMBOLS`, min length 3).
2. **Instruments — company names:** from NSE `EQUITY_L.csv` (SYMBOL, NAME OF COMPANY), refreshed daily by the
   08:00 IST `InstrumentMasterRefreshCron`. Aliases: the official name; the name stripped of Limited/Ltd/(India)/
   & Co; curated short forms in a checked-in file (`L&T`, `M&M`, `RIL`, `SBI`, `HUL`…). Guards: matching is
   case-sensitive on the alias as written; an alias shared by ≥ 2 symbols is dropped unless curated ("Tata",
   "Adani", "Bajaj" alone tag nothing; "Tata Motors" → TATAMOTORS); a single-word alias must be ≥ 6 letters and
   not on a common-word blocklist ("Bharat", "Indian", "National", "Gold", "Power"…); longest match wins, and a
   matched name **consumes its span** so commodity/index keywords inside it cannot fire ("Senco Gold",
   "Hindustan Zinc", "Coal India", "Oil India"). Compiled into one token-trie at build time — one pass per
   article, independent of alias count.
3. **Commodities and indices:** extend `UNDERLYING_NEWS_ALIASES` to every MCX underlying on the master (add ZINC,
   LEAD, ALUMINIUM, NICKEL, COTTON/KAPAS, MENTHAOIL, plus the minis in `PARENT`) and every index in
   `INDEX_UNDERLYINGS` (FINNIFTY, MIDCPNIFTY, NIFTYNXT50, SENSEX, BANKEX, SENSEX50). Guards in the same style:
   "lead" only as `LME lead` / `lead prices|futures`, never the verb; "nickel" not "nickel-plated"; "Sensex" fine.
   `newsKeyFor` then returns a key for every MCX/NFO underlying on the master; the "untaggable" reason remains for
   anything still missing, and a unit test fails if any active MCX underlying lacks a mapping.
4. **Sectors** (keys = NSE sectoral index names, the same ones `macro.sector` uses): the sector of each tagged
   company (symbol → sector map from `NseSectorIndexService`, rebuilt daily), the ET sector feed it came from
   (ET Auto → NIFTY AUTO, ET Tech → NIFTY IT, ET Pharma → NIFTY PHARMA, ET BFSI → NIFTY BANK/FIN SERVICE,
   ET Energy → NIFTY ENERGY), and a short sector phrase list ("PSU banks", "IT stocks", "auto sales"). MCX
   commodities group as `MCX ENERGY`, `MCX BULLION`, `MCX BASE METALS`, `MCX AGRI`.
5. **Markets:** `IN` (category `indian`, or RBI/SEBI/GST/India CPI keywords) and/or `GLOBAL` (category `global`,
   Fed/FOMC/US CPI/ECB/China keywords).
6. `tagVersion` is stored; when the matcher version bumps, a background job re-tags the last 48 h on boot.

## 6. The in-memory index
- Items: `{id, title ≤ 160 chars, source, sentiment, publishedAt, dateInferred, tags}`; keys `I:<symbol>`,
  `S:<sector>`, `X:<index>`, `M:IN|GLOBAL` → newest-first id lists.
- **Bounds:** keep 24 h (covers the MCX evening into the next pre-open); ≤ 50 ids per key; ≤ 5,000 items total
  (oldest evicted first). Estimated ≤ 5 MB for items + ≤ 2 MB for the alias trie; hard ceiling asserted by a test
  on synthetic load. Sized for 2× the busiest day in `news_articles` (measured in M0).
- Boot: one query for the last 24 h ordered by `publishedAt`; until it completes `peek` reports `warming` (absent
  with that reason — not "no news").

## 7. Layered headlines in the live packet
Ladder per position (the overnight ladder, read from the index): **instrument** (company / commodity benchmark via
`PARENT` / the index itself) → **sector** (stock: its NSE sector; MCX: its commodity group; BANKNIFTY: NIFTY BANK)
→ **index** (stock: NIFTY, plus NIFTY BANK for banks; skipped for MCX and for an index position) → **market**
(NSE/NFO: IN then GLOBAL; MCX: GLOBAL then IN). Rules: the **6 h window is applied first**, then dedupe by article
(an article keeps its highest layer), then fill in ladder order with per-layer ceilings instrument 8 / sector 3 /
index 2 / market 2, **total cap 8**. Each headline carries `layer`, `key`, `ageMin`. The block's `at` is the newest
headline (as today); its source string names the window, and `news.asOf` states the last successful ingestion and
any down sources. `freshCount` keeps its meaning (instrument layer, 30 min) but is read from the index, excludes
`dateInferred` items and no longer saturates. The packet build never waits on news: a missing index is an absence
with its reason.

## 8. Events
- **Company** (stocks and stock F&O): results / board meetings from NSE `event-calendar`; ex-dividend, split,
  bonus from NSE `corporates-corporateActions` (ex-date); Yahoo `nextEarningsDate` only as a fallback when NSE has
  nothing, labelled `source: yahoo (estimate)`.
- **Market-wide:** RBI MPC decision, FOMC decision, US CPI, India CPI (plus US NFP) from a checked-in schedule
  `config/market-events.json` (`kind, date, localTime, tz` IANA, `impact`, `sourceUrl`), maintained by us from the
  official calendars (₹0). Boot validates it; < 30 days of future entries logs a warning and the packet says
  "macro schedule ends <date>".
- **Commodity:** EIA weekly petroleum status — Wednesday 10:30 America/New_York (= 20:00 IST in US daylight time,
  21:00 IST in standard time), moved to Thursday after a US federal holiday (holiday list in the config file); EIA
  natural-gas storage — Thursday 10:30 ET; OPEC/OPEC+ meetings from the config file.
- **F&O expiry:** from the position's own contract expiry (already `tick.expiry`) with the venue's close time.
- All times converted with `Intl` IANA zones — no hand-coded offsets. Stored in `market_events`; built once daily
  at 08:15 IST and refreshed every 2 h (NSE sources under the §4.3 client); the rule-based ones are generated 14 days
  ahead.
- **Packet:** `events` block per position = the next ≤ 5 relevant events in the next 3 trading days
  (`{kind, scope, title, atIst, minutesAway, impact, source}`) plus `minutesToNextHighImpact` (number or null with
  reason). High impact by default: results/board meeting (own company), RBI, FOMC, US CPI, India CPI, EIA crude for
  CRUDEOIL, EIA gas for NATURALGAS, OPEC for CRUDEOIL, own expiry day.

## 9. Event-driven wakes (push, not poll)
- **News:** when the index adds an article whose **instrument** tag matches an open, watched position's own key,
  `NewsWakeService` calls the runner's wake path (as `wakeForTick` does) with a `news-hit` fire carrying the title.
  Edge-triggered: a per-tracker seen-set of article ids, so one headline wakes once. Sector/index/market headlines
  never wake on their own (they ride along in the next packet). Cooldown 5 min per tracker for news wakes; all
  existing caps apply (`WAKE_COOLDOWN_MS`, `JUDGE_CONCURRENCY = 2`, session gate).
- **Events:** a 1-min check fires `event-near` once per (tracker, event) when a high-impact event is ≤ 15 min away.
- The 30-s `newsHit` sensor becomes a fallback reading the index; with the flag on it de-dupes by article id.
- A wake asks the judge to look; it never forces EXIT_NOW, and the exit-discipline gate is unchanged — an event or
  headline is not a gate justification.

## 10. Prompt v9 and stamps
Adds: the four layers and how to weigh them (own > sector > index > market); `news.asOf` and stale sources mean
"we may not see", not "nothing happened"; the `events` block and `minutesToNextHighImpact`; **an event or headline
alone is not a reason for EXIT_NOW** — it may tighten a trigger or shorten `reviewIn`. Composed by the pure
`sentinelSystemPrompt({cues, triggers, discipline, news})`, hash-pinned, golden snapshots. Stamps (news off ⇒ the
existing 8, byte-identical):

| discipline | triggers | news | cues on | cues off |
|---|---|---|---|---|
| on | off | on | **v9** (target live) | v2.6 |
| off | off | on | v10 | v2.7 |
| off | on | on | v11 | v2.8 |
| on | on | on | v12 | v2.9 |

## 11. Data model (expand-only, one migration)
- `news_articles`: add `sectors String[] @default([])`, `indices String[] @default([])`, `markets String[]
  @default([])`, `tagVersion Int @default(0)`, `dateInferred Boolean @default(false)`; GIN indexes on
  `relatedSymbols`, `sectors`, `indices`; btree on `fetchedAt`.
- `instrument_name_aliases`: `symbol, alias, kind (official|derived|curated|blocked), source, updatedAt`,
  unique(`alias`, `symbol`).
- `market_events`: `scope (company|market|commodity|expiry), kind, key, title, startsAt timestamptz, allDay,
  impact (high|medium|low), source, sourceRef, fetchedAt`, unique(`kind`, `key`, `startsAt`), index (`key`,
  `startsAt`). Existing readers ignore all new columns.

## 12. Budgets
- **Latency:** packet news+events read < 5 ms p99 (target ~1 ms), asserted in a unit benchmark; zero DB/HTTP calls
  on the packet path with the flag on (spy test).
- **Memory:** index ≤ 10 MB total incl. trie and events (VPS); bounded by §6 caps, not by traffic.
- **Tokens:** ≤ 8 headlines × ~35 tokens + events ≤ 5 × ~25 ≈ 450 tokens worst case, ~+200 net over today's block;
  enforced by a packet-size test.

## 13. Failure modes
| Failure | Behaviour |
|---|---|
| A feed / NSE down | backoff; others continue; `news.asOf` names it; headlines still served |
| All ingestion stale > 30 min in session | headlines block marked `stale` with "news as of HH:MM"; never blocks |
| Index warming / crashed | absent with that reason ("cannot see"), not "no headlines" |
| Events source down | last stored events served with their `fetchedAt`; rule-based events unaffected |
| Macro config expired | events still shown for what is known + "schedule ends" note |
| Wake storm (busy tape) | edge-triggered ids + 5-min cooldown + existing concurrency caps |

## 14. Safety
News & events only add evidence and wakes. No component can place, modify or cancel an order, alter a price
trigger, or bypass/relax the exit-discipline gate or persistence; MANUAL and PRICE_TRIGGER exits are untouched.
NSE cookies (if any) and source URLs with tokens are never logged.

## 15. Configuration (`api.env`)
`NEWS_EVENTS_V2_ENABLED=false|observe|true` (master; `false` = today, nothing new runs), `NEWS_NSE_ANN_CADENCE_MIN=3`,
`NEWS_INDEX_HOURS=24`, `NEWS_INDEX_MAX_ITEMS=5000`, `NEWS_WAKE_COOLDOWN_MIN=5`, `EVENT_WAKE_LEAD_MIN=15`,
`EVENTS_HORIZON_TRADING_DAYS=3`.

## 16. Testing
Unit tables: name matching (Tata Motors → TATAMOTORS; "Tata" alone → none; "Senco Gold" → SENCO not GOLD;
"Hindustan Zinc" not ZINC; "lead the rally" not LEAD; "Coal India"/"Oil India" not CRUDEOIL; all-caps headline →
none); every active MCX underlying and index has a key; ladder fill/fallback for a stock, an index option and an
MCX future, window-before-cap, dedupe by highest layer; events incl. EIA across both 2026 DST switches (Mar 8, Nov 1)
and a US-holiday Thursday shift, FOMC landing after IST midnight; wakes edge-triggered once per article/event;
prompt flag-off identity (all 8 existing hashes unchanged) and new golden snapshots; packet flag-off identity
(replay stored packets, byte-equal JSON).

## 17. Rollout
**M0** source verification + NSE spike (cookie or not) + volume measurement. **M1** migration, tag-once, aliases,
index, events (flag `false` — nothing reads them). **M2** `observe`: ingestion, index, events and wakes computed and
logged (would-wake lines, would-be blocks stored beside the verdict) but packet/prompt unchanged — one week,
review false-positive tags and wake rate. **M3** `true` on the owner's shadow sentinel (prompt v9), then live.

## 18. Owner decisions (defaults)
- **N1** one master switch `NEWS_EVENTS_V2_ENABLED` with an `observe` step. *(yes)*
- **N2** macro schedule in `config/market-events.json`, maintained by us; no paid API. *(yes)*
- **N3** NSE announcements every 3 min in session, 15 min outside, under the backed-off client. *(yes)*
- **N4** if NSE needs a cookie, allow a homepage warm-up for `nseindia.com` only. *(yes)*
- **N5** source fixes (dead-feed removal, ET Earnings URL) ship in M0 regardless of the flag. *(yes — they change
  content, not the packet shape)*
- **N6** only instrument-layer headlines wake the judge; sector/index/market ride along. *(yes)*
- **N7** stamp table in §10 (live target v9 / v2.6). *(yes)*
- **N8** headline cap 8 total with layer ceilings 8/3/2/2; window 6 h. *(yes)*
- **N9** event wake lead 15 min; high-impact list as in §8. *(yes)*
