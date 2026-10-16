# News & Events v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every open sentinel position (stock, index option, MCX) layered headlines (own → sector → index → market) and an `events` block, read from pre-computed in-memory state in ~1 ms, and wake the judge within seconds of a new own-instrument headline or ≤ 15 min before a high-impact event — with `NEWS_EVENTS_V2_ENABLED=false` byte-identical to `main` and `observe` computing + logging everything without changing the packet or prompt.

**Architecture:** A new folder `apps/api/src/modules/news-events/` holds a pure core (config, types, keys, ingest bus, source-health book) plus four parts: **tagging** (tag-once at ingestion: tickers, company names from NSE `EQUITY_L`, commodity/index keywords, sectors, markets), **ingest** (NSE corporate announcements, re-tag job), **index** (`NewsIndexService`: in-memory, bounded, rebuilt from the DB on boot, fed by an in-process push and a 60-s delta poll, `peek()` synchronous) and **events** (`EventsService`: NSE event calendar + corporate actions, Yahoo fallback, `config/market-events.json` macro schedule, EIA rules, contract expiry; `peek()` synchronous). The sentinel reads both through two type-only ports (`NEWS_INDEX`, `MARKET_EVENTS`), so the cycle's import-graph walk never reaches the news module, Prisma or HTTP. Wakes go through the existing `SentinelRunnerService.wakeForTick`; the fire itself comes from the pass's tripwires (edge-triggered `news-hit`, new `event-near`).

**Tech Stack:** NestJS 11 + TypeScript, Prisma 6 (PostgreSQL/TimescaleDB), `@nestjs/schedule` crons, Node global `fetch`, `Intl` IANA time zones, Jest.

**Spec:** `docs/superpowers/specs/2026-10-16-news-events-design.md` (owner-approved 2026-10-16, N1–N9 defaults, `observe` period 2–3 trading days). Read it before any task. Background: `docs/superpowers/plans/2026-10-15-exit-discipline.md` (prompt-stamp + golden-attribution pattern this plan copies).

**Base:** `main` @ 7b976b3 (+ spec commits on `docs/news-events`).

---

## Owner Decisions (approved 2026-10-16)

| # | Decision | Status |
|---|---|---|
| N1 | One master switch `NEWS_EVENTS_V2_ENABLED=false\|observe\|true` | yes |
| N2 | Macro schedule in `config/market-events.json`, maintained by us; no paid API | yes |
| N3 | NSE announcements every 3 min in session, 15 min outside, under the backed-off client | yes |
| N4 | If NSE needs a cookie, homepage warm-up for `nseindia.com` only | yes |
| N5 | Source fixes (dead-feed removal, ET Earnings URL) ship in M0 regardless of the flag | yes |
| N6 | Only instrument-layer headlines wake the judge | yes |
| N7 | Stamps v9–v12 / v2.6–v2.9 (live target v9 / v2.6) | yes |
| N8 | Headline cap 8 total, layer ceilings 8/3/2/2, window 6 h | yes |
| N9 | Event wake lead 15 min; high-impact list as in spec §8 | yes |
| — | `observe` runs **2–3 trading days**, then `true` | yes |

## Global Constraints

- **Safety (spec §14).** Nothing in this feature can place, modify or cancel an order, alter a price trigger, or touch the exit-discipline gate or persistence (`sentinel-executor/`, `exit-discipline/` are not edited by any task). MANUAL and PRICE_TRIGGER exits are untouched. A wake only asks the judge to look; it never forces `EXIT_NOW`.
- **Flag off ⇒ byte-identical.** `NEWS_EVENTS_V2_ENABLED` unset/`false`/any typo: nothing new runs (no NSE call, no tagger, no index, no events build, no wake service), the live packet JSON and every prompt text are byte-identical to `main` (all 8 existing prompt hashes pinned; packet identity test). `observe`: everything is computed and logged, the would-be blocks are stored in `sentinel_verdicts.newsShadow`, but the packet, the prompt, the stamp and the tripwire inputs are exactly the `false` ones. Only `true` changes what the judge sees.
- **Hot path never awaits network or DB for news/events.** With the flag on, the packet's news/events read and the tick source's fresh count are synchronous `peek()` calls on in-memory state; the legacy `NewsShim.recentFor` / `getNewsForSymbol` are not called (spy tests).
- **Ports.** `trade-sentinel` reaches the new services only through `ports/news-index.port.ts` and `ports/events.port.ts` (types + DI tokens), bound in `trade-sentinel.module.ts` (composition root). The cycle reachability walk in `services/sentinel-cycle.service.spec.ts` stays green, and the new `services/news-wake.service.ts` is added to its `ENTRIES`. Files under `news-events/` that the sentinel imports (`types.ts`, `keys.ts`, `config.ts`) import nothing.
- **NSE politeness.** Every NSE call (announcements, `EQUITY_L.csv`, event calendar, corporate actions) goes through ONE shared `NseClient`: serial queue, one request + one retry, browser UA, per-endpoint exponential backoff base 60 s / max 30 min, cookie warm-up only for hosts ending in `nseindia.com` and only after a 401/403. Cookies and tokenised URLs are never logged.
- **Migration:** expand-only, one migration `prisma/migrations/20261016120000_news_events_v2/`. No change to an existing column, index or constraint. Existing readers ignore the new columns.
- **Config (`api.env`):** `NEWS_EVENTS_V2_ENABLED` is on only for the exact (trimmed, case-insensitive) words `observe` / `true`; anything else is `false` and is reported once at boot. Numeric keys: `NEWS_NSE_ANN_CADENCE_MIN=3` [1,60], `NEWS_INDEX_HOURS=24` [6,72], `NEWS_INDEX_MAX_ITEMS=5000` [500,20000], `NEWS_WAKE_COOLDOWN_MIN=5` [1,60], `EVENT_WAKE_LEAD_MIN=15` [1,120], `EVENTS_HORIZON_TRADING_DAYS=3` [1,10]; out of range ⇒ default + one boot warning.
- **Budgets (spec §12):** packet news+events read < 5 ms p99 (benchmarked), index ≤ 10 MB incl. trie and events (structural estimate test), headlines ≤ 8, events ≤ 5.
- **Logs:** `[news-events]` boot/config, `[news-source]` source health changes, `[nse-client]` NSE backoff/warm-up, `[news-tag]` alias/tagger/re-tag, `[news-ann]` NSE announcements, `[news-index]` index, `[market-events]` events build, `[news-wake]` wakes and would-wakes, `[news-shadow]` observe-mode per-verdict summary.
- **Tests:** `cd apps/api && npx jest <path> --ci --maxWorkers=2`; full suite **only** `cd apps/api && npx jest --ci --maxWorkers=2` (NEVER default workers — OOM). Typecheck `cd apps/api && npx tsc --noEmit -p tsconfig.json`: the baseline has **174 pre-existing env errors**; record the count before your first change and add none (`npx tsc --noEmit -p tsconfig.json 2>&1 | grep -c "error TS"`).
- **Commits:** Conventional Commits, scope `news-events` (or `trade-sentinel`, `news` for edits there); `git add <explicit paths>` and `git commit ... -- <paths>` only — never `git add -A`, `git commit -a`, `git stash`. Every message ends with a blank line and `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. No push, no merge from a stream branch.
- **Worktrees:** create with `git worktree add .claude/worktrees/<name> -b <branch> <base>` from the main checkout, then `node_modules` junctions with ABSOLUTE targets: `cmd /c mklink /J "<wt>\node_modules" "C:\Users\AryanKumar\Desktop\GrW\node_modules"`, same for `apps\api\node_modules`, `apps\web\node_modules`, `packages\shared\node_modules`. Never `npm install`; `rmdir` the junctions before `git worktree remove`. `npx prisma generate` is fine; never `prisma migrate dev/reset` against a shared DB. No production access from any task.

## Where the Code Differs from the Spec

1. **§5/§11 "instruments" go into `relatedSymbols` — but `observe` must not change the packet.** The live packet (flag `false`/`observe`) reads `relatedSymbols` through `NewsAggregatorService.getNewsForSymbol`. Writing name-matched tags or NSE-announcement symbols there would change legacy headlines and `freshCount` during `observe`. So v2 instrument tags go to a **new** column `news_articles.instruments` (GIN-indexed); `relatedSymbols` keeps exactly today's legacy tagging; NSE-announcement rows get `relatedSymbols = []`. The index reads only the v2 columns.
2. **§5.4 "the same sector keys `macro.sector` uses".** `macro.sector` is a stub (`absent(STUB_REASON)`, always unavailable). Sector keys are the NSE sectoral index names behind `NseSectorIndexService`'s tokens (`stock_sectors.sectorIndexToken`, e.g. `99926009` → `NIFTY BANK`), mapped by `SECTOR_TOKEN_NAME` in `news-events/keys.ts` and loaded by a new in-memory `SectorMapService`.
3. **§5.2 "refreshed daily by the 08:00 IST `InstrumentMasterRefreshCron`".** That cron lives in `market-data` and injects `AngelOneAdapterService` (a broker adapter). The alias refresh is its own cron in `news-events` at 08:05 IST (Mon–Fri), fetching `EQUITY_L.csv` through `NseClient`; it never touches the instrument master.
4. **§5.3 "a unit test fails if any active MCX underlying lacks a mapping".** A unit test cannot read the live master. The checked-in `MCX_UNDERLYINGS` list (reconciled once against the local master in Task A2) is test-pinned to have a keyword mapping for every name; at boot the tagger queries the real master and logs `[news-tag] MCX underlying(s) without a news mapping: …` for anything missing.
5. **§9 "calls the runner's wake path with a news-hit fire carrying the title".** `SentinelRunnerService.wakeForTick(userId, why, exchange)` carries no fire — it runs the user's ordinary sensor pass. The fire is produced inside that pass by `newsHit`, which with the flag `true` reads the index's fresh own-instrument ids minus the tracker's seen-set (edge-triggered, title in `detail`). `NewsWakeService` therefore only decides *when* to run the pass (push, 5-min cooldown per tracker).
6. **§9 "a 1-min check fires `event-near`".** The runner's 30-s cron pass already evaluates every open position in session; `event-near` is a tripwire evaluated in that pass (twice as often as specified, same session gate, same caps). No separate timer. An all-day event (results with no announced time) never fires `event-near`.
7. **§10 Prompt "it may tighten a trigger".** With `SENTINEL_TRIGGERS_ENABLED` off the packet has no trigger to tighten; the line names `exitTrigger` only in the triggers-on texts (already a stamp dimension).
8. **§12 Tokens "≈ 450 tokens worst case, ~+200 net".** Measured on the real block JSON (chars/4): 8 headlines × 160-char titles with `title, source, sentiment, publishedAt, layer, key, ageMin` + 5 events + provenance strings ≈ **1,240** worst case; a typical block (5 headlines × 90 chars, 2 events) ≈ **680**, against ≈ **450** for today's 8-headline legacy block — so the typical net is ~+230, close to the spec's +200, but the spec's worst case is ~2.7× low. The budget test pins worst ≤ 1,300 and typical ≤ 700 (Open Question 3 offers dropping `publishedAt` from headlines, −~80 tokens).
9. **§17 "would-be blocks stored beside the verdict".** Stored in a new nullable column `sentinel_verdicts.newsShadow` (JSONB) in the same expand-only migration (not listed in spec §11).
10. **§4.2 "15 min otherwise until 22:00".** The off-hours window is defined as 07:00–22:00 IST every calendar day; nothing is fetched 22:00–07:00.
11. **§8 "high impact … own expiry day".** The expiry event is computed at `peek` from the position's own `tick.expiry` and the venue's close (`SessionClock.tradingWindow(exchange, day).closeMin`); it is not stored in `market_events`.
12. **§8 EIA holiday rule.** Rule: weekly petroleum (Wed 10:30 ET) moves to Thursday 10:30 ET when a US federal holiday falls Mon–Wed of that week; natural-gas storage (Thu 10:30 ET) is not shifted by rule. Exceptions (e.g. Thanksgiving gas storage on Wednesday 12:00 ET) are explicit `eiaOverrides` in `config/market-events.json`.
13. **§4.1 "re-test each failing feed from the VPS".** No task has production access. Task A1 tests from the dev machine with the same UA/timeout and ships the result; the Production Gate re-runs `scripts/news-source-check.ts` on the VPS before `observe`.
14. **News-source health (§4.4) is updated in every mode** (memory + a log line on a state change only). It is never read by the packet unless the flag is `true`; it is part of N5's "dead sources are visible".
15. **Overnight review** (`overnight-evidence.adapter.ts`) keeps its own DB ladder; moving it onto the index is out of scope.

## Planner Rulings

- **R1 — Index keys.** `I:<SYMBOL>` (listed company base symbol, or MCX benchmark `CRUDEOIL`/`GOLD`/…), `S:<SECTOR>` (NSE sectoral index name, or `MCX ENERGY|MCX BULLION|MCX BASE METALS|MCX AGRI`), `X:<INDEX>` (index underlying name: `NIFTY`, `BANKNIFTY`, `FINNIFTY`, `MIDCPNIFTY`, `NIFTYNXT50`, `SENSEX`, `BANKEX`, `SENSEX50`), `M:IN` / `M:GLOBAL`. `LayeredHeadline.key` is the key without its prefix.
- **R2 — Ladder (spec §7).** STOCK: instrument `[I:SYM]` → sector `[S:<sectorOf(SYM)>]` (skipped when unknown) → index `[X:NIFTY]` (+ `X:BANKNIFTY` when the sector is `NIFTY BANK|NIFTY PSU BANK|NIFTY PVT BANK`) → market `[M:IN]`, `[M:GLOBAL]`. INDEX: instrument `[X:<idx>]` → sector (`BANKNIFTY`/`BANKEX` → `S:NIFTY BANK`, `FINNIFTY` → `S:NIFTY FIN SERVICE`, else skipped) → index skipped → market IN then GLOBAL. COMMODITY: instrument `[I:<benchmark>]` → sector `[S:<MCX group>]` → index skipped → market GLOBAL then IN.
- **R3 — Fill.** 6-h window first (`publishedAt ≥ now − 6 h`), then walk the rungs in order; every article seen in a rung is claimed by that rung (highest layer wins, even if the rung's ceiling hides it); take newest-first up to the rung ceiling (instrument 8 / sector 3 / index 2 / market 2) while the total is < 8. `freshCount` = instrument-rung articles with `publishedAt ≥ now − 30 min` and `!dateInferred`.
- **R4 — Edge-triggering.** The index emits `onAdded` only for article ids it has never held, and never during the boot rebuild. The pass keeps `newsSeen: Set<articleId>` and `eventsFired: Set<eventId>` per tracker (pruned each pass to ids still fresh / events still ahead). `NewsWakeService` keeps its own per-tracker seen-set + cooldown.
- **R5 — Observe.** `computing = mode !== 'false'`; `rendering = mode === 'true'`. Ingestion, tagging, index, events and the wake service run when `computing`; packet/prompt/tripwire inputs change only when `rendering`. In `observe` the wake service logs `[news-wake] observe: would wake …` and the pass logs would-be fires; nothing calls `wakeForTick`.
- **R6 — `dateInferred`.** v2 sets it (and `publishedAt = fetchedAt`) when the pubDate is missing, unparseable, or more than 10 min in the future; such items are indexed and shown in headlines but never counted in `freshCount` and never wake. With the flag `false` the insert is exactly today's.

## Review Focus

1. **A restart mid-session must not look like "no news" and must not wake on old news.** While the index is warming, the packet says the index is loading ("cannot see"), and the boot rebuild of the last 24 h emits nothing to `onAdded` — otherwise every deploy wakes every position on hours-old headlines. *Task B3 Step 1 (`rebuild emits nothing`, `warming peek`), Task D1 Step 1 (`warming → absent with reason`).*
2. **The same article arriving twice never wakes twice.** Push then delta-poll, a re-tag republish, or a duplicate RSS item across two feeds: `onAdded` once, `NewsWakeService` once per tracker, `news-hit` once per tracker. *Tasks B3, D2 Step 1.*
3. **Time-zone edges.** EIA across both 2026 US DST switches (Mar 8, Nov 1), the US-holiday Thursday shift, FOMC landing after IST midnight, an event exactly at `now`, an all-day event today, and an NSE holiday inside the 3-trading-day horizon. *Tasks C1, C3 Step 1.*
4. **A position the index cannot key (unknown MCX name, unresolved underlying) under `true`** shows all news blocks absent with the real reason — never `freshCount: 0`, never "no headlines". *Task D1 Step 1.*
5. **NSE answers 200 with an HTML block page, or 403 then nothing.** Counted as a failure (backoff, source health, `news.asOf` down list after 6), never as "0 announcements"; the cookie never appears in a log line. *Tasks F3, A6 Step 1.*

---

## File Structure

```
prisma/
  schema.prisma                                              (M) NewsArticle + 6 cols + 4 GIN/btree; InstrumentNameAlias; MarketEvent; SentinelVerdict.newsShadow   [F2]
  migrations/20261016120000_news_events_v2/migration.sql     (C)                                                                                                  [F2]

config/market-events.json                                    (C) macro schedule, US federal holidays, EIA overrides                                               [C1]
deploy/env/api.env.example                                   (M) NEWS_EVENTS_* block                                                                              [F1]
apps/api/scripts/news-source-check.ts                        (C) M0 feed/NSE probe (ts-node, prints a table)                                                      [A1]

apps/api/src/modules/news-events/                            (C)
  config.ts (+spec)                F1  parseNewsEventsConfig, constants, NEWS_EVENTS_CONFIG
  types.ts                         F1  every shared shape (see Interfaces)
  keys.ts (+spec)                  F1  index/MCX/sector tables, newsPositionOf, instrumentKeysOf, keysOfTags, toIndexedArticle
  ingest-bus.ts (+spec)            F1  NewsIngestBus, InProcessNewsIngestBus, NEWS_INGEST_BUS
  source-health.ts (+spec)         F1  SourceHealthBook, SOURCE_DOWN_AFTER
  news-events-core.module.ts       F1  config, bus, health, boot line (+ F3: NseClient, SectorMapService)
  testing.ts                       F1  fakeNewsIndex, fakeEvents, article() builders for other streams' tests
  nse-client.ts (+spec)            F3  NseClient
  sector-map.service.ts (+spec)    F3  SectorMapService, buildSectorMap
  __fixtures__/                    A6/C2 trimmed NSE JSON/CSV captures
  tagging/
    commodity-index-keywords.ts (+spec)  A2  V2 keyword patterns, keywordTags
    market-sector-rules.ts (+spec)       A2  marketTags, sectorPhraseTags, FEED_SECTOR
    curated-aliases.ts                   A3  CURATED_ALIASES, COMMON_WORD_BLOCKLIST, BLOCKED_ALIASES
    alias-derivation.ts (+spec)          A3  deriveAliases, parseEquityL
    name-matcher.ts (+spec)              A3  NameMatcher, blankSpans
    tag-article.ts (+spec)               A4  tagArticle (pure)
    tagger.service.ts (+spec)            A4  NewsTaggerService
    alias-loader.service.ts (+spec)      A4  AliasLoaderService (EQUITY_L → instrument_name_aliases, 08:05 IST)
  ingest/
    retag.service.ts (+spec)             A5  boot re-tag of the last 48 h
    nse-announcements.ts (+spec)         A6  parseAnnouncements, announcementsDue
    nse-announcements.service.ts (+spec) A6  NseAnnouncementsService (1-min cron, cadence gate)
  index/
    news-index.ts (+spec)                B1  NewsIndex (bounded structure)
    ladder.ts (+spec)                    B2  ladderFor, layeredHeadlines, freshInstrument
    news-index.service.ts (+spec)        B3  NewsIndexService (boot rebuild, push, 60-s poll, peek, onAdded)
    news-index.module.ts                 B3
  events/
    zoned-time.ts (+spec)                C1  zonedToUtc, tzOffsetMs, istLabel, ymdInTz
    rule-events.ts (+spec)               C1  eiaEvents
    macro-schedule.ts (+spec)            C1  validateMarketEventsFile, macroEvents, loadMarketEventsFile
    nse-events.ts (+spec)                C2  parseEventCalendar, parseCorporateActions, yahooEarningsEvent
    market-events.repository.ts (+spec)  C2  syncSource, listFrom
    events-builder.service.ts (+spec)    C2  EventsBuilderService.build
    events-select.ts (+spec)             C3  selectEvents, expiryEvent, horizonEnd (pure)
    events.service.ts (+spec)            C3  EventsService (crons, cache, peek)
    market-events.module.ts              C3

apps/api/src/modules/news/
  news.module.ts                         (M) A1/A4/A5/A6 providers, imports core module
  services/news-aggregator.service.ts    (M) A1 sources/UA/timeout/health/pubDate guard; A5 tag-once + publish
  services/news-sources.spec.ts          (M) A1
  services/news-aggregator.service.spec.ts (C) A1/A5
  services/underlying-news-aliases.ts    (M) A2 export AliasPattern + firstHit (no behaviour change)

apps/api/src/modules/trade-sentinel/
  ports/news-index.port.ts               (C) F1  NewsIndexReader, NEWS_INDEX
  ports/events.port.ts                   (C) F1  EventsReader, MARKET_EVENTS
  services/news-events-blocks.ts (+spec) (C) D1  newsBlocksV2, eventsBlocks (pure)
  services/context-packet.service.ts (+spec) (M) D1  `true` blocks, shadowNewsEvents, TickSnapshot.freshNews
  repositories/sentinel-verdict.repository.ts (+spec) (M) D1  newsShadow
  adapters/tick-source.adapter.ts (+spec)(M) D2  fresh count/ids from the index when `true`
  tripwires/types.ts                     (M) D2  newsUnseen?, eventNear?
  tripwires/news-hit.tripwire.ts (+spec) (M) D2  edge mode
  tripwires/event-near.tripwire.ts (+spec)(C) D2
  services/tripwire.service.ts           (M) D2  eventNear in ALL_TRIPWIRES
  services/news-watch-book.ts (+spec)    (C) D2
  services/news-wake.service.ts (+spec)  (C) D2
  services/sentinel-cycle.service.ts (+spec) (M) D1 newsShadow write; D2 seen-sets, eventNear, watch book
  prompts/sentinel-system-prompt.ts      (M) D3  v9–v12 / v2.6–v2.9
  services/sentinel-agent.service.ts (+spec) (M) D3  news option, hash pins
  golden/golden-fixtures.ts, golden/__snapshots__/… (M) D3  9 new scenarios, existing untouched
  trade-sentinel.module.ts (+spec)       (M) D2 NewsWatchBook/NewsWakeService; I1 module imports + port bindings
```

## Parallel Streams

| Stream | Worktree · branch | Tasks | Starts | Touches |
|---|---|---|---|---|
| F | `.claude/worktrees/ne-foundation` · `feature/ne-foundation` (from `docs/news-events`) | F1 → F2 → F3 | now | `news-events/{config,types,keys,ingest-bus,source-health,testing,nse-client,sector-map.service,news-events-core.module}`, `prisma/`, two sentinel ports, env example |
| A | `.claude/worktrees/ne-ingest` · `feature/ne-ingest` | A1, A2, A3 after F1; A4, A5, A6 after F2+F3 (`git merge feature/ne-foundation`) | after F1 | `news-events/tagging/`, `news-events/ingest/`, `news/` |
| B | `.claude/worktrees/ne-index` · `feature/ne-index` | B1, B2 after F1; B3 after F2+F3 | after F1 | `news-events/index/` |
| C | `.claude/worktrees/ne-events` · `feature/ne-events` | C1 after F1; C2, C3 after F2+F3 | after F1 | `news-events/events/`, `config/market-events.json` |
| D | `.claude/worktrees/ne-sentinel` · `feature/ne-sentinel` | D1 after F2; D2 after D1; D3 after F1 (independent of D1/D2 — may run first) | after F1 | `trade-sentinel/` only (plus nothing else) |
| — | integration `feature/news-events` | I1, I2 | all done | module wiring, e2e test, review |

Each stream branches from `feature/ne-foundation` at the F1 commit and merges `feature/ne-foundation` again (fast, no conflicts — F is append-only after F1) before the first task that needs F2/F3.

**Dependency graph**

```
            ┌──────────── F1 (config/types/keys/ports/bus/health) ────────────┐
            │                │                     │                │         │
           F2 (migration)   A1 A2 A3             B1 B2             C1        D3 (prompt)
            │                │                     │                │
           F3 (NseClient,    │                     │                │
            SectorMap)       │                     │                │
            ├──────► A4 → A5 → A6                  │                │
            ├──────────────────────────────► B3 ◄──┘                │
            ├────────────────────────────────────────────► C2 → C3 ◄┘
            └──► D1 → D2
                        all ──► I1 (merge F→A→B→C→D, wire modules, e2e) ──► I2 (full suite, review)
```

**Conflict map.** A and B never touch the same file (B only creates `news-events/index/*`). A owns `news/news.module.ts`; B and C each own their own Nest module file. D owns every `trade-sentinel/` file; nobody else edits one except I1 (`trade-sentinel.module.ts` imports + bindings). `news-events/news-events-core.module.ts`, `prisma/schema.prisma` and `deploy/env/api.env.example` are edited only by F. `news-events/keys.ts` is created by F1 and may be appended to ONLY by A2 (MCX names found by the reconcile); B, C and D read it. No other overlap is expected; I1 merges F → A → B → C → D.

---

## Interfaces (defined in F1 — every stream builds against these; stubs in `news-events/testing.ts`)

```ts
// apps/api/src/modules/news-events/config.ts — pure, imports nothing
export type NewsEventsMode = 'false' | 'observe' | 'true';
export const NEWS_EVENTS_CONFIG = 'NEWS_EVENTS_CONFIG';
export interface NewsEventsConfig {
  mode: NewsEventsMode;
  computing: boolean;            // mode !== 'false'
  rendering: boolean;            // mode === 'true'
  nseAnnCadenceMin: number;      // 3
  indexHours: number;            // 24
  indexMaxItems: number;         // 5000
  wakeCooldownMin: number;       // 5
  eventWakeLeadMin: number;      // 15
  eventsHorizonTradingDays: number; // 3
  problems: string[];
}
export function parseNewsEventsConfig(env: Record<string, string | undefined>): NewsEventsConfig;
export function newsEventsBootLine(c: NewsEventsConfig): string;
export const NEWS_WINDOW_MS = 6 * 3_600_000;
export const FRESH_WINDOW_MS = 30 * 60_000;
export const STALE_AFTER_MS = 30 * 60_000;
export const DELTA_POLL_MS = 60_000;
export const MAX_PER_KEY = 50;
export const LAYER_CAPS = { instrument: 8, sector: 3, index: 2, market: 2 } as const;
export const MAX_HEADLINES = 8;
export const MAX_EVENTS = 5;
export const TITLE_MAX = 160;
export const FUTURE_PUBDATE_TOLERANCE_MS = 10 * 60_000;
export const NSE_ANN_OFFHOURS_MIN = 15;
export const TAG_VERSION = 1;

// apps/api/src/modules/news-events/types.ts — pure, imports nothing
export type NewsLayer = 'instrument' | 'sector' | 'index' | 'market';
export type MarketTag = 'IN' | 'GLOBAL';
export interface ArticleTags { instruments: string[]; sectors: string[]; indices: string[]; markets: MarketTag[] }
export interface IndexedArticle {
  id: string; title: string; source: string; sentiment: string | null;
  publishedAt: number; fetchedAt: number; dateInferred: boolean; tags: ArticleTags;
}
export interface NewsRowLike {
  id: string; title: string; source: string; sentiment: string | null; publishedAt: Date; fetchedAt: Date;
  dateInferred: boolean; instruments: string[]; sectors: string[]; indices: string[]; markets: string[];
}
export type PositionKind = 'STOCK' | 'INDEX' | 'COMMODITY';
export interface NewsPosition { kind: PositionKind; underlying: string; key: string; exchange: string; expiry: string | null }
export type NewsPositionResult = NewsPosition | { unresolved: string };
export interface LayeredHeadline {
  title: string; source: string; sentiment: string | null; publishedAt: string;
  layer: NewsLayer; key: string; ageMin: number;
}
export interface NewsAsOf { lastIngestAt: string | null; downSources: string[]; stale: boolean }
export interface FreshItem { id: string; title: string }
export type NewsPeek =
  | { status: 'ok'; headlines: LayeredHeadline[]; newestAt: string | null; freshCount: number; fresh: FreshItem[]; asOf: NewsAsOf }
  | { status: 'warming' | 'unavailable'; reason: string };
export interface SectorLookup { sectorOf(symbol: string): string | null }
export interface SourceHealth { source: string; lastOkAt: string | null; lastError: string | null; consecutiveFailures: number; itemsLastFetch: number }
export type EventScope = 'company' | 'market' | 'commodity' | 'expiry';
export type EventImpact = 'high' | 'medium' | 'low';
export interface MarketEventInput {
  scope: EventScope; kind: string; key: string; title: string; startsAt: Date; allDay: boolean;
  impact: EventImpact; source: string; sourceRef: string | null;
}
export interface StoredMarketEvent extends MarketEventInput { id: string; fetchedAt: Date }
export interface PacketEvent { kind: string; scope: EventScope; title: string; atIst: string; minutesAway: number; impact: EventImpact; source: string }
export interface EventView extends PacketEvent { id: string; allDay: boolean }
export type EventsPeek =
  | { status: 'ok'; events: EventView[]; minutesToNextHighImpact: number | null; noHighImpactReason: string | null; notes: string[]; fetchedAt: string | null }
  | { status: 'warming' | 'unavailable'; reason: string };

// apps/api/src/modules/news-events/keys.ts — pure, imports only ./types and ./config
export const INDEX_UNDERLYINGS_V2: readonly string[];      // NIFTY BANKNIFTY FINNIFTY MIDCPNIFTY NIFTYNXT50 SENSEX BANKEX SENSEX50
export const MCX_BENCHMARKS_V2: readonly string[];          // CRUDEOIL NATURALGAS GOLD SILVER COPPER ZINC LEAD ALUMINIUM NICKEL COTTON MENTHAOIL
export const MCX_PARENT_V2: Readonly<Record<string, string>>;
export const MCX_UNDERLYINGS: readonly string[];
export const MCX_GROUP: Readonly<Record<string, string>>;  // benchmark → 'MCX ENERGY' | …
export const SECTOR_TOKEN_NAME: Readonly<Record<string, string>>;
export const BANK_SECTORS: ReadonlySet<string>;
export const INDEX_SECTOR: Readonly<Record<string, string>>;
export function baseSymbol(raw: string): string;
export function newsPositionOf(underlying: string | null, exchange: string | null, expiry: string | null): NewsPositionResult;
export function instrumentKeysOf(p: NewsPosition): string[];
export function keysOfTags(t: ArticleTags): string[];
export function toIndexedArticle(row: NewsRowLike): IndexedArticle;

// apps/api/src/modules/news-events/ingest-bus.ts
export const NEWS_INGEST_BUS = 'NEWS_INGEST_BUS';
export interface NewsIngestBus { publish(items: readonly IndexedArticle[]): void; subscribe(fn: (items: readonly IndexedArticle[]) => void): () => void }
export class InProcessNewsIngestBus implements NewsIngestBus { constructor(onError?: (err: unknown) => void) }

// apps/api/src/modules/news-events/source-health.ts
export const SOURCE_DOWN_AFTER = 6;
export class SourceHealthBook {
  constructor(log?: (line: string) => void);
  ok(source: string, items: number, at: Date): void;
  fail(source: string, error: string, at: Date): void;
  all(): SourceHealth[]; down(): string[]; lastOkAt(): string | null;
}

// apps/api/src/modules/news-events/nse-client.ts (F3)
export class NseClient {
  constructor(opts?: Partial<NseClientOptions>);
  getText(endpoint: string, url: string): Promise<string>;
  getJson(endpoint: string, url: string): Promise<unknown>;
  backoffState(): Record<string, { failures: number; until: string }>;
}
// apps/api/src/modules/news-events/sector-map.service.ts (F3)
export class SectorMapService implements SectorLookup { sectorOf(symbol: string): string | null; refresh(): Promise<number>; readonly ready: boolean }

// apps/api/src/modules/trade-sentinel/ports/news-index.port.ts
export interface NewsIndexReader {
  peek(position: NewsPosition, now: Date): NewsPeek;
  onAdded(listener: (items: readonly IndexedArticle[]) => void): () => void;
}
export const NEWS_INDEX = 'SENTINEL_NEWS_INDEX';
// apps/api/src/modules/trade-sentinel/ports/events.port.ts
export interface EventsReader { peek(position: NewsPosition, now: Date): EventsPeek }
export const MARKET_EVENTS = 'SENTINEL_MARKET_EVENTS';

// Produced later, consumed across streams:
// A4  NewsTaggerService.tag(input: TagInput): { tags: ArticleTags; version: number }      (A5, A6)
// B3  NewsIndexService implements NewsIndexReader                                          (I1 binds NEWS_INDEX)
// C3  EventsService implements EventsReader                                                (I1 binds MARKET_EVENTS)
```

---

## Task F1: Foundation — config, types, keys, bus, health, ports, core module (Stream F)

**Files:**
- Create: `apps/api/src/modules/news-events/{config.ts,config.spec.ts,types.ts,keys.ts,keys.spec.ts,ingest-bus.ts,ingest-bus.spec.ts,source-health.ts,source-health.spec.ts,news-events-core.module.ts,testing.ts,news-events.structure.spec.ts}`
- Create: `apps/api/src/modules/trade-sentinel/ports/news-index.port.ts`, `apps/api/src/modules/trade-sentinel/ports/events.port.ts`
- Modify: `deploy/env/api.env.example` (append block)

**Interfaces:** Produces everything in the "Interfaces" section above except `NseClient`/`SectorMapService` (F3). Consumes nothing.

- [ ] **Step 0: Worktree + tsc baseline**

```bash
cd C:/Users/AryanKumar/Desktop/GrW
git worktree add .claude/worktrees/ne-foundation -b feature/ne-foundation docs/news-events
# junctions (absolute targets) as in Global Constraints, then:
cd .claude/worktrees/ne-foundation/apps/api && npx prisma generate && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -c "error TS"
```
Expected: `174`. Every later `tsc` run in every stream must print the same number.

- [ ] **Step 1: Write the failing tests**

`apps/api/src/modules/news-events/config.spec.ts`:
```ts
import { parseNewsEventsConfig, newsEventsBootLine } from './config';

describe('parseNewsEventsConfig', () => {
  it.each([
    [undefined, 'false'], ['', 'false'], ['false', 'false'], [' TRUE ', 'true'], ['observe', 'observe'],
    ['Observe', 'observe'], ['yes', 'false'], ['1', 'false'], ['ture', 'false'],
  ])('NEWS_EVENTS_V2_ENABLED=%j → %s', (raw, mode) => {
    const c = parseNewsEventsConfig({ NEWS_EVENTS_V2_ENABLED: raw as string | undefined });
    expect(c.mode).toBe(mode);
    expect(c.computing).toBe(mode !== 'false');
    expect(c.rendering).toBe(mode === 'true');
  });

  it('a typo is reported, never widened', () => {
    const c = parseNewsEventsConfig({ NEWS_EVENTS_V2_ENABLED: 'ture' });
    expect(c.problems).toEqual([expect.stringMatching(/NEWS_EVENTS_V2_ENABLED="ture" is not false\|observe\|true/)]);
  });

  it('defaults', () => {
    expect(parseNewsEventsConfig({})).toEqual({
      mode: 'false', computing: false, rendering: false, nseAnnCadenceMin: 3, indexHours: 24, indexMaxItems: 5000,
      wakeCooldownMin: 5, eventWakeLeadMin: 15, eventsHorizonTradingDays: 3, problems: [],
    });
  });

  it('out-of-range and non-integer numbers fall back to the default and are reported', () => {
    const c = parseNewsEventsConfig({ NEWS_INDEX_HOURS: '2', NEWS_WAKE_COOLDOWN_MIN: '2.5', EVENT_WAKE_LEAD_MIN: '30' });
    expect(c.indexHours).toBe(24);
    expect(c.wakeCooldownMin).toBe(5);
    expect(c.eventWakeLeadMin).toBe(30);
    expect(c.problems).toHaveLength(2);
  });

  it('boot line names every value', () => {
    expect(newsEventsBootLine(parseNewsEventsConfig({ NEWS_EVENTS_V2_ENABLED: 'observe' }))).toBe(
      '[news-events] mode=observe nseAnn=3m index=24h/5000 wakeCooldown=5m eventLead=15m horizon=3 trading days',
    );
  });
});
```

`apps/api/src/modules/news-events/keys.spec.ts`:
```ts
import {
  BANK_SECTORS, INDEX_UNDERLYINGS_V2, MCX_BENCHMARKS_V2, MCX_GROUP, MCX_PARENT_V2, MCX_UNDERLYINGS, SECTOR_TOKEN_NAME,
  instrumentKeysOf, keysOfTags, newsPositionOf, toIndexedArticle,
} from './keys';

describe('keys', () => {
  it('every MCX underlying resolves to a benchmark with a group', () => {
    for (const u of MCX_UNDERLYINGS) {
      const p = newsPositionOf(u, 'MCX', null);
      expect('unresolved' in p ? p.unresolved : null).toBeNull();
      if (!('unresolved' in p)) expect(MCX_GROUP[p.key]).toBeDefined();
    }
    for (const b of MCX_BENCHMARKS_V2) expect(MCX_GROUP[b]).toMatch(/^MCX (ENERGY|BULLION|BASE METALS|AGRI)$/);
    for (const [mini, parent] of Object.entries(MCX_PARENT_V2)) {
      expect(MCX_BENCHMARKS_V2).toContain(parent);
      expect(MCX_UNDERLYINGS).toContain(mini);
    }
  });

  it('positions: stock, index, commodity mini, unknown MCX, unresolved', () => {
    expect(newsPositionOf('TATAMOTORS-EQ', 'NSE', null)).toEqual({ kind: 'STOCK', underlying: 'TATAMOTORS', key: 'TATAMOTORS', exchange: 'NSE', expiry: null });
    expect(newsPositionOf('BANKNIFTY', 'NFO', '2026-10-28')).toEqual({ kind: 'INDEX', underlying: 'BANKNIFTY', key: 'BANKNIFTY', exchange: 'NFO', expiry: '2026-10-28' });
    expect(newsPositionOf('GOLDM', 'MCX', '2026-11-05')).toEqual({ kind: 'COMMODITY', underlying: 'GOLDM', key: 'GOLD', exchange: 'MCX', expiry: '2026-11-05' });
    expect(newsPositionOf('STEELREBAR', 'MCX', null)).toEqual({ unresolved: expect.stringMatching(/STEELREBAR.*NOT a finding that nothing was published/) });
    expect(newsPositionOf(null, 'NFO', null)).toEqual({ unresolved: expect.stringMatching(/could not be resolved/) });
  });

  it('instrument keys and tag keys', () => {
    expect(instrumentKeysOf({ kind: 'STOCK', underlying: 'SBIN', key: 'SBIN', exchange: 'NSE', expiry: null })).toEqual(['I:SBIN']);
    expect(instrumentKeysOf({ kind: 'INDEX', underlying: 'NIFTY', key: 'NIFTY', exchange: 'NFO', expiry: null })).toEqual(['X:NIFTY']);
    expect(instrumentKeysOf({ kind: 'COMMODITY', underlying: 'CRUDEOILM', key: 'CRUDEOIL', exchange: 'MCX', expiry: null })).toEqual(['I:CRUDEOIL']);
    expect(keysOfTags({ instruments: ['SBIN'], sectors: ['NIFTY PSU BANK'], indices: ['BANKNIFTY'], markets: ['IN'] })).toEqual([
      'I:SBIN', 'S:NIFTY PSU BANK', 'X:BANKNIFTY', 'M:IN',
    ]);
  });

  it('sector tables', () => {
    expect(SECTOR_TOKEN_NAME['99926009']).toBe('NIFTY BANK');
    expect(Object.keys(SECTOR_TOKEN_NAME)).toHaveLength(15);
    expect([...BANK_SECTORS].sort()).toEqual(['NIFTY BANK', 'NIFTY PSU BANK', 'NIFTY PVT BANK']);
    expect(INDEX_UNDERLYINGS_V2).toEqual(['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'NIFTYNXT50', 'SENSEX', 'BANKEX', 'SENSEX50']);
  });

  it('toIndexedArticle truncates the title to 160 chars and keeps only known market tags', () => {
    const a = toIndexedArticle({
      id: 'a1', title: 'x'.repeat(200), source: 'ET', sentiment: null, publishedAt: new Date(1000), fetchedAt: new Date(2000),
      dateInferred: false, instruments: ['SBIN'], sectors: [], indices: [], markets: ['IN', 'MARS'],
    });
    expect(a.title).toHaveLength(160);
    expect(a.title.endsWith('…')).toBe(true);
    expect(a.tags.markets).toEqual(['IN']);
    expect(a.publishedAt).toBe(1000);
  });
});
```

`apps/api/src/modules/news-events/ingest-bus.spec.ts`:
```ts
import { InProcessNewsIngestBus } from './ingest-bus';
import { article } from './testing';

it('delivers to every subscriber, survives a throwing one, and unsubscribes', () => {
  const errors: unknown[] = [];
  const bus = new InProcessNewsIngestBus((e) => errors.push(e));
  const got: string[] = [];
  bus.subscribe(() => {
    throw new Error('boom');
  });
  const off = bus.subscribe((items) => items.forEach((i) => got.push(i.id)));
  bus.publish([article({ id: 'a' })]);
  off();
  bus.publish([article({ id: 'b' })]);
  expect(got).toEqual(['a']);
  expect(errors).toHaveLength(2);
});
```

`apps/api/src/modules/news-events/source-health.spec.ts`:
```ts
import { SOURCE_DOWN_AFTER, SourceHealthBook } from './source-health';

it('tracks failures, names a source down after 6, logs only on state changes', () => {
  const lines: string[] = [];
  const h = new SourceHealthBook((l) => lines.push(l));
  const t = (m: number) => new Date(Date.UTC(2026, 9, 16, 4, m));
  h.ok('ET', 12, t(0));
  for (let i = 1; i <= SOURCE_DOWN_AFTER; i++) h.fail('MoneyControl', 'HTTP 403', t(i));
  expect(h.down()).toEqual(['MoneyControl']);
  expect(h.lastOkAt()).toBe(t(0).toISOString());
  expect(lines).toEqual([
    '[news-source] ET OK (12 items)',
    '[news-source] MoneyControl failing (1 consecutive): HTTP 403',
    '[news-source] MoneyControl DOWN (6 consecutive): HTTP 403',
  ]);
  h.ok('MoneyControl', 3, t(9));
  expect(h.down()).toEqual([]);
  expect(lines[3]).toBe('[news-source] MoneyControl OK (3 items)');
  h.ok('ET', 10, t(10)); // no state change, no line
  expect(lines).toHaveLength(4);
  expect(h.lastOkAt()).toBe(t(10).toISOString());
});
```

`apps/api/src/modules/news-events/news-events.structure.spec.ts`:
```ts
import { readFileSync } from 'fs';
import { join } from 'path';

/** The files the sentinel imports must stay import-free, so the cycle walk never reaches Prisma, HTTP or the news module. */
it.each(['types.ts', 'config.ts'])('%s imports nothing', (f) => {
  expect(readFileSync(join(__dirname, f), 'utf8')).not.toMatch(/^\s*import\s/m);
});
it('keys.ts imports only ./types and ./config', () => {
  const specs = [...readFileSync(join(__dirname, 'keys.ts'), 'utf8').matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
  expect(specs.every((s) => s === './types' || s === './config')).toBe(true);
});
it.each(['news-index.port.ts', 'events.port.ts'])('the sentinel port %s is type-only', (f) => {
  const src = readFileSync(join(__dirname, '..', 'trade-sentinel', 'ports', f), 'utf8');
  for (const m of src.matchAll(/^import\s+(.*)$/gm)) expect(m[1]).toMatch(/^type\s/);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && npx jest src/modules/news-events --ci --maxWorkers=2`
Expected: FAIL — `Cannot find module './config'` (and siblings).

- [ ] **Step 3: Implement**

`apps/api/src/modules/news-events/config.ts`:
```ts
/**
 * News & events v2 (docs/superpowers/specs/2026-10-16-news-events-design.md §15).
 * PURE — imports nothing: the sentinel's cycle walk reads this file.
 * The master switch is on only for the exact words `observe` / `true`; a typo is `false`.
 */
export type NewsEventsMode = 'false' | 'observe' | 'true';
export const NEWS_EVENTS_CONFIG = 'NEWS_EVENTS_CONFIG';

export interface NewsEventsConfig {
  mode: NewsEventsMode;
  computing: boolean;
  rendering: boolean;
  nseAnnCadenceMin: number;
  indexHours: number;
  indexMaxItems: number;
  wakeCooldownMin: number;
  eventWakeLeadMin: number;
  eventsHorizonTradingDays: number;
  problems: string[];
}

export const NEWS_WINDOW_MS = 6 * 3_600_000;
export const FRESH_WINDOW_MS = 30 * 60_000;
export const STALE_AFTER_MS = 30 * 60_000;
export const DELTA_POLL_MS = 60_000;
export const MAX_PER_KEY = 50;
export const LAYER_CAPS = { instrument: 8, sector: 3, index: 2, market: 2 } as const;
export const MAX_HEADLINES = 8;
export const MAX_EVENTS = 5;
export const TITLE_MAX = 160;
export const FUTURE_PUBDATE_TOLERANCE_MS = 10 * 60_000;
export const NSE_ANN_OFFHOURS_MIN = 15;
export const TAG_VERSION = 1;

export function parseNewsEventsConfig(env: Record<string, string | undefined>): NewsEventsConfig {
  const problems: string[] = [];
  const raw = (env.NEWS_EVENTS_V2_ENABLED ?? '').trim().toLowerCase();
  let mode: NewsEventsMode = 'false';
  if (raw === 'true' || raw === 'observe') mode = raw;
  else if (raw !== '' && raw !== 'false') {
    problems.push(`NEWS_EVENTS_V2_ENABLED="${env.NEWS_EVENTS_V2_ENABLED}" is not false|observe|true — treated as false`);
  }
  const int = (key: string, def: number, min: number, max: number): number => {
    const v = env[key];
    if (v === undefined || v.trim() === '') return def;
    const n = Number(v.trim());
    if (!Number.isInteger(n) || n < min || n > max) {
      problems.push(`${key}=${v} is out of range [${min}, ${max}] — using ${def}`);
      return def;
    }
    return n;
  };
  return {
    mode,
    computing: mode !== 'false',
    rendering: mode === 'true',
    nseAnnCadenceMin: int('NEWS_NSE_ANN_CADENCE_MIN', 3, 1, 60),
    indexHours: int('NEWS_INDEX_HOURS', 24, 6, 72),
    indexMaxItems: int('NEWS_INDEX_MAX_ITEMS', 5000, 500, 20000),
    wakeCooldownMin: int('NEWS_WAKE_COOLDOWN_MIN', 5, 1, 60),
    eventWakeLeadMin: int('EVENT_WAKE_LEAD_MIN', 15, 1, 120),
    eventsHorizonTradingDays: int('EVENTS_HORIZON_TRADING_DAYS', 3, 1, 10),
    problems,
  };
}

export function newsEventsBootLine(c: NewsEventsConfig): string {
  return (
    `[news-events] mode=${c.mode} nseAnn=${c.nseAnnCadenceMin}m index=${c.indexHours}h/${c.indexMaxItems} ` +
    `wakeCooldown=${c.wakeCooldownMin}m eventLead=${c.eventWakeLeadMin}m horizon=${c.eventsHorizonTradingDays} trading days`
  );
}
```

`apps/api/src/modules/news-events/types.ts`: exactly the `types.ts` block from the Interfaces section, each type with a one-line doc comment. No imports.

`apps/api/src/modules/news-events/keys.ts`:
```ts
import type { ArticleTags, IndexedArticle, MarketTag, NewsPosition, NewsPositionResult, NewsRowLike } from './types';
import { TITLE_MAX } from './config';

/** Index underlyings (names as on the instrument master). R1: their index key is `X:<name>`. */
export const INDEX_UNDERLYINGS_V2: readonly string[] = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'NIFTYNXT50', 'SENSEX', 'BANKEX', 'SENSEX50'];

/** The benchmark each MCX contract family's headlines talk about. */
export const MCX_BENCHMARKS_V2: readonly string[] = [
  'CRUDEOIL', 'NATURALGAS', 'GOLD', 'SILVER', 'COPPER', 'ZINC', 'LEAD', 'ALUMINIUM', 'NICKEL', 'COTTON', 'MENTHAOIL',
];

/** Minis / micros / variants → benchmark. Superset of the v1 PARENT in underlying-news-aliases.ts. */
export const MCX_PARENT_V2: Readonly<Record<string, string>> = {
  CRUDEOILM: 'CRUDEOIL', NATGASMINI: 'NATURALGAS',
  GOLDM: 'GOLD', GOLDGUINEA: 'GOLD', GOLDPETAL: 'GOLD', GOLDTEN: 'GOLD',
  SILVERM: 'SILVER', SILVERMIC: 'SILVER', SILVER1000: 'SILVER',
  ZINCMINI: 'ZINC', LEADMINI: 'LEAD', ALUMINI: 'ALUMINIUM',
  COTTONCNDY: 'COTTON', KAPAS: 'COTTON',
};

/**
 * Every MCX underlying name the master carries (reconciled in Task A2 against
 * `SELECT DISTINCT name FROM instruments WHERE exchange='MCX' AND "isActive"`).
 * A name here without a keyword mapping fails commodity-index-keywords.spec.ts.
 */
export const MCX_UNDERLYINGS: readonly string[] = [
  ...MCX_BENCHMARKS_V2.filter((b) => b !== 'COTTON'),
  ...Object.keys(MCX_PARENT_V2),
];

export const MCX_GROUP: Readonly<Record<string, string>> = {
  CRUDEOIL: 'MCX ENERGY', NATURALGAS: 'MCX ENERGY',
  GOLD: 'MCX BULLION', SILVER: 'MCX BULLION',
  COPPER: 'MCX BASE METALS', ZINC: 'MCX BASE METALS', LEAD: 'MCX BASE METALS', ALUMINIUM: 'MCX BASE METALS', NICKEL: 'MCX BASE METALS',
  COTTON: 'MCX AGRI', MENTHAOIL: 'MCX AGRI',
};

/** `stock_sectors.sectorIndexToken` → NSE sectoral index name (tokens: nse-sector-index.service.ts SECTOR_TOKEN). */
export const SECTOR_TOKEN_NAME: Readonly<Record<string, string>> = {
  '99926009': 'NIFTY BANK', '99926011': 'NIFTY FIN SERVICE', '99926013': 'NIFTY IT', '99926015': 'NIFTY FMCG',
  '99926017': 'NIFTY PHARMA', '99926019': 'NIFTY ENERGY', '99926021': 'NIFTY AUTO', '99926023': 'NIFTY METAL',
  '99926027': 'NIFTY REALTY', '99926029': 'NIFTY INFRA', '99926031': 'NIFTY MEDIA', '99926033': 'NIFTY PSU BANK',
  '99926035': 'NIFTY PVT BANK', '99926041': 'NIFTY HEALTHCARE', '99926039': 'NIFTY CONSR DURBL',
};

export const BANK_SECTORS: ReadonlySet<string> = new Set(['NIFTY BANK', 'NIFTY PSU BANK', 'NIFTY PVT BANK']);

/** The sector layer of an index position (R2). */
export const INDEX_SECTOR: Readonly<Record<string, string>> = {
  BANKNIFTY: 'NIFTY BANK', BANKEX: 'NIFTY BANK', FINNIFTY: 'NIFTY FIN SERVICE',
};

export function baseSymbol(raw: string): string {
  return String(raw ?? '').trim().toUpperCase().replace(/^(.+)-[A-Z0-9]{1,3}$/, '$1');
}

const CANNOT_SEE = 'the news feed cannot see this underlying; this is NOT a finding that nothing was published';

export function newsPositionOf(underlying: string | null, exchange: string | null, expiry: string | null): NewsPositionResult {
  if (!underlying || !underlying.trim()) {
    return {
      unresolved:
        'the underlying behind this contract could not be resolved, so no news or events were looked up. ' +
        'This is a FAILURE TO LOOK, not a finding — do not read it as an absence in the market.',
    };
  }
  const ex = String(exchange ?? '').trim().toUpperCase();
  const base = baseSymbol(underlying);
  if (ex === 'MCX') {
    const key = MCX_PARENT_V2[base] ?? base;
    if (!MCX_GROUP[key]) return { unresolved: `no headline keyword mapping exists for the MCX underlying ${base} — ${CANNOT_SEE}` };
    return { kind: 'COMMODITY', underlying: base, key, exchange: ex, expiry };
  }
  if (INDEX_UNDERLYINGS_V2.includes(base)) return { kind: 'INDEX', underlying: base, key: base, exchange: ex, expiry };
  return { kind: 'STOCK', underlying: base, key: base, exchange: ex, expiry };
}

export function instrumentKeysOf(p: NewsPosition): string[] {
  return [p.kind === 'INDEX' ? `X:${p.key}` : `I:${p.key}`];
}

export function keysOfTags(t: ArticleTags): string[] {
  return [
    ...t.instruments.map((k) => `I:${k}`),
    ...t.sectors.map((k) => `S:${k}`),
    ...t.indices.map((k) => `X:${k}`),
    ...t.markets.map((k) => `M:${k}`),
  ];
}

const MARKETS: ReadonlySet<string> = new Set<MarketTag>(['IN', 'GLOBAL']);

export function toIndexedArticle(row: NewsRowLike): IndexedArticle {
  const title = row.title.length > TITLE_MAX ? `${row.title.slice(0, TITLE_MAX - 1)}…` : row.title;
  return {
    id: row.id,
    title,
    source: row.source,
    sentiment: row.sentiment,
    publishedAt: row.publishedAt.getTime(),
    fetchedAt: row.fetchedAt.getTime(),
    dateInferred: row.dateInferred,
    tags: {
      instruments: [...row.instruments],
      sectors: [...row.sectors],
      indices: [...row.indices],
      markets: row.markets.filter((m): m is MarketTag => MARKETS.has(m)),
    },
  };
}
```

`apps/api/src/modules/news-events/ingest-bus.ts`:
```ts
import type { IndexedArticle } from './types';

export const NEWS_INGEST_BUS = 'NEWS_INGEST_BUS';

/** In-process push from the ingesters to the index (spec §3 (a)). A throwing subscriber never blocks the others. */
export interface NewsIngestBus {
  publish(items: readonly IndexedArticle[]): void;
  subscribe(fn: (items: readonly IndexedArticle[]) => void): () => void;
}

export class InProcessNewsIngestBus implements NewsIngestBus {
  private readonly subs = new Set<(items: readonly IndexedArticle[]) => void>();
  constructor(private readonly onError: (err: unknown) => void = () => undefined) {}

  publish(items: readonly IndexedArticle[]): void {
    if (items.length === 0) return;
    for (const fn of [...this.subs]) {
      try {
        fn(items);
      } catch (err) {
        this.onError(err);
      }
    }
  }

  subscribe(fn: (items: readonly IndexedArticle[]) => void): () => void {
    this.subs.add(fn);
    return () => {
      this.subs.delete(fn);
    };
  }
}
```

`apps/api/src/modules/news-events/source-health.ts`:
```ts
import type { SourceHealth } from './types';

/** Spec §4.4: ≥ 6 consecutive failures ⇒ "down", named in news.asOf. */
export const SOURCE_DOWN_AFTER = 6;

/** In memory; logs only when a source changes state (first failure, down, recovered). */
export class SourceHealthBook {
  private readonly m = new Map<string, SourceHealth>();
  constructor(private readonly log: (line: string) => void = () => undefined) {}

  ok(source: string, items: number, at: Date): void {
    const prev = this.m.get(source);
    this.m.set(source, { source, lastOkAt: at.toISOString(), lastError: null, consecutiveFailures: 0, itemsLastFetch: items });
    if (!prev || prev.consecutiveFailures > 0) this.log(`[news-source] ${source} OK (${items} items)`);
  }

  fail(source: string, error: string, _at: Date): void {
    const prev = this.m.get(source);
    const n = (prev?.consecutiveFailures ?? 0) + 1;
    this.m.set(source, { source, lastOkAt: prev?.lastOkAt ?? null, lastError: error, consecutiveFailures: n, itemsLastFetch: 0 });
    if (n === 1 || n === SOURCE_DOWN_AFTER) {
      this.log(`[news-source] ${source} ${n >= SOURCE_DOWN_AFTER ? 'DOWN' : 'failing'} (${n} consecutive): ${error}`);
    }
  }

  all(): SourceHealth[] {
    return [...this.m.values()].map((h) => ({ ...h }));
  }

  down(): string[] {
    return [...this.m.values()].filter((h) => h.consecutiveFailures >= SOURCE_DOWN_AFTER).map((h) => h.source).sort();
  }

  lastOkAt(): string | null {
    let best: string | null = null;
    for (const h of this.m.values()) if (h.lastOkAt && (!best || h.lastOkAt > best)) best = h.lastOkAt;
    return best;
  }
}
```

`apps/api/src/modules/news-events/testing.ts` (used by every stream's specs; never imported by production code):
```ts
import type { EventsPeek, IndexedArticle, NewsPeek, NewsPosition } from './types';

export function article(over: Partial<IndexedArticle> & { id: string }): IndexedArticle {
  return {
    title: `headline ${over.id}`, source: 'ET', sentiment: 'neutral', publishedAt: Date.UTC(2026, 9, 16, 4, 30),
    fetchedAt: Date.UTC(2026, 9, 16, 4, 31), dateInferred: false,
    tags: { instruments: [], sectors: [], indices: [], markets: [] },
    ...over,
  };
}

export function fakeNewsIndex(peek: (p: NewsPosition, now: Date) => NewsPeek) {
  const listeners = new Set<(items: readonly IndexedArticle[]) => void>();
  return {
    peek: jest.fn(peek),
    onAdded: (fn: (items: readonly IndexedArticle[]) => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    emit: (items: IndexedArticle[]) => listeners.forEach((fn) => fn(items)),
  };
}

export function fakeEvents(peek: (p: NewsPosition, now: Date) => EventsPeek) {
  return { peek: jest.fn(peek) };
}
```

`apps/api/src/modules/trade-sentinel/ports/news-index.port.ts`:
```ts
/**
 * The live packet's and the wake service's read of the news index (news-events v2).
 * A PORT, type-only, for the reason market-cues.port.ts gives: the cycle's import
 * walk must never reach Prisma, HTTP or the news module. `peek` is synchronous and
 * does no I/O. `onAdded` fires only for article ids the index has never held, and
 * never during its boot rebuild.
 */
import type { IndexedArticle, NewsPeek, NewsPosition } from '../../news-events/types';

export interface NewsIndexReader {
  peek(position: NewsPosition, now: Date): NewsPeek;
  onAdded(listener: (items: readonly IndexedArticle[]) => void): () => void;
}

export const NEWS_INDEX = 'SENTINEL_NEWS_INDEX';
```

`apps/api/src/modules/trade-sentinel/ports/events.port.ts`:
```ts
/** The live packet's read of the events calendar. Type-only port; `peek` is synchronous, no I/O. */
import type { EventsPeek, NewsPosition } from '../../news-events/types';

export interface EventsReader {
  peek(position: NewsPosition, now: Date): EventsPeek;
}

export const MARKET_EVENTS = 'SENTINEL_MARKET_EVENTS';
```

`apps/api/src/modules/news-events/news-events-core.module.ts`:
```ts
import { Inject, Logger, Module, type OnModuleInit } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { NEWS_EVENTS_CONFIG, newsEventsBootLine, parseNewsEventsConfig, type NewsEventsConfig } from './config';
import { InProcessNewsIngestBus, NEWS_INGEST_BUS } from './ingest-bus';
import { SourceHealthBook } from './source-health';

const logger = new Logger('NewsEvents');

/**
 * News & events v2 shared singletons: the parsed config, the ingest bus and the
 * source-health book (F3 adds NseClient and SectorMapService). Imported by
 * NewsModule, NewsIndexModule, MarketEventsModule and TradeSentinelModule — Nest
 * keeps ONE instance of each provider.
 */
@Module({
  imports: [PrismaModule],
  providers: [
    { provide: NEWS_EVENTS_CONFIG, useFactory: () => parseNewsEventsConfig(process.env) },
    {
      provide: NEWS_INGEST_BUS,
      useFactory: () => new InProcessNewsIngestBus((e) => logger.error(`[news-events] bus subscriber threw: ${String(e)}`)),
    },
    { provide: SourceHealthBook, useFactory: () => new SourceHealthBook((line) => logger.log(line)) },
  ],
  exports: [NEWS_EVENTS_CONFIG, NEWS_INGEST_BUS, SourceHealthBook],
})
export class NewsEventsCoreModule implements OnModuleInit {
  constructor(@Inject(NEWS_EVENTS_CONFIG) private readonly cfg: NewsEventsConfig) {}

  onModuleInit(): void {
    logger.log(newsEventsBootLine(this.cfg));
    for (const p of this.cfg.problems) logger.warn(`[news-events] ${p}`);
  }
}
```

Append to `deploy/env/api.env.example`:
```
# ─── News & events v2 (docs/superpowers/specs/2026-10-16-news-events-design.md) ───
# false = today (nothing new runs) | observe = compute + log, packet/prompt unchanged | true = the judge sees it.
NEWS_EVENTS_V2_ENABLED=false
NEWS_NSE_ANN_CADENCE_MIN=3
NEWS_INDEX_HOURS=24
NEWS_INDEX_MAX_ITEMS=5000
NEWS_WAKE_COOLDOWN_MIN=5
EVENT_WAKE_LEAD_MIN=15
EVENTS_HORIZON_TRADING_DAYS=3
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd apps/api && npx jest src/modules/news-events --ci --maxWorkers=2` → PASS. `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -c "error TS"` → `174`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/news-events apps/api/src/modules/trade-sentinel/ports/news-index.port.ts apps/api/src/modules/trade-sentinel/ports/events.port.ts deploy/env/api.env.example
git commit -m "feat(news-events): foundation — config, types, keys, ingest bus, source health, sentinel ports" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/api/src/modules/news-events apps/api/src/modules/trade-sentinel/ports/news-index.port.ts apps/api/src/modules/trade-sentinel/ports/events.port.ts deploy/env/api.env.example
```
Report the commit hash to the coordinator: streams A, B, C, D branch from it.

---

## Task F2: Expand-only migration (Stream F)

**Files:**
- Modify: `prisma/schema.prisma` (`NewsArticle`, `SentinelVerdict`; new `InstrumentNameAlias`, `MarketEvent`)
- Create: `prisma/migrations/20261016120000_news_events_v2/migration.sql`
- Create: `apps/api/src/modules/news-events/schema.spec.ts`

**Interfaces:** Produces `prisma.instrumentNameAlias`, `prisma.marketEvent`, columns `NewsArticle.{instruments,sectors,indices,markets,tagVersion,dateInferred}`, `SentinelVerdict.newsShadow`.

- [ ] **Step 1: Write the failing test** — `apps/api/src/modules/news-events/schema.spec.ts`:
```ts
import { readFileSync } from 'fs';
import { join } from 'path';

const root = join(__dirname, '..', '..', '..', '..', '..');
const schema = readFileSync(join(root, 'prisma', 'schema.prisma'), 'utf8');
const sql = readFileSync(join(root, 'prisma', 'migrations', '20261016120000_news_events_v2', 'migration.sql'), 'utf8');

describe('news-events v2 migration is expand-only', () => {
  it('adds, never drops or alters an existing column', () => {
    expect(sql).not.toMatch(/\bDROP\b|ALTER COLUMN|RENAME/i);
    expect(sql).toMatch(/ADD COLUMN "instruments" TEXT\[\] NOT NULL DEFAULT ARRAY\[\]::TEXT\[\]/);
    expect(sql).toMatch(/ADD COLUMN "newsShadow" JSONB/);
    expect(sql).toMatch(/USING GIN \("relatedSymbols"\)/);
    expect(sql).toMatch(/CREATE TABLE "market_events"/);
    expect(sql).toMatch(/"startsAt" TIMESTAMPTZ\(3\) NOT NULL/);
  });
  it('the schema declares the same', () => {
    expect(schema).toMatch(/model InstrumentNameAlias \{[\s\S]*?@@unique\(\[alias, symbol\]\)[\s\S]*?@@map\("instrument_name_aliases"\)/);
    expect(schema).toMatch(/model MarketEvent \{[\s\S]*?@@unique\(\[kind, key, startsAt\]\)[\s\S]*?@@index\(\[key, startsAt\]\)/);
    expect(schema).toMatch(/newsShadow\s+Json\?/);
    expect(schema).toMatch(/@@index\(\[relatedSymbols\], type: Gin\)/);
  });
});
```

- [ ] **Step 2: Run** `cd apps/api && npx jest src/modules/news-events/schema.spec.ts --ci --maxWorkers=2` → FAIL (`ENOENT … migration.sql`).

- [ ] **Step 3: Implement.** In `prisma/schema.prisma`, replace the tail of `model NewsArticle` (from `fetchedAt` to `@@map`) with:
```prisma
  fetchedAt       DateTime @default(now())
  /// News & events v2 tag-once columns (spec §5/§11). `instruments` is separate from
  /// `relatedSymbols` so the legacy packet is unchanged in observe mode (plan "differs" 1).
  instruments     String[] @default([])
  sectors         String[] @default([])
  indices         String[] @default([])
  markets         String[] @default([])
  tagVersion      Int      @default(0)
  dateInferred    Boolean  @default(false)

  @@index([category, publishedAt])
  @@index([sentiment])
  @@index([relatedSymbols], type: Gin)
  @@index([instruments], type: Gin)
  @@index([sectors], type: Gin)
  @@index([indices], type: Gin)
  @@index([fetchedAt])
  @@map("news_articles")
}
```
In `model SentinelVerdict`, after `exitTrigger    Json?`:
```prisma
  /// News & events v2 OBSERVE mode: the {news, events} blocks the packet WOULD have
  /// carried; NULL unless NEWS_EVENTS_V2_ENABLED=observe.
  newsShadow     Json?
```
New models right after `NewsArticle`:
```prisma
/// Company-name aliases for news tagging (news-events v2 §5.2). kind: official|derived|curated|blocked.
model InstrumentNameAlias {
  id        String   @id @default(cuid())
  symbol    String
  alias     String
  kind      String
  source    String
  updatedAt DateTime @updatedAt

  @@unique([alias, symbol])
  @@index([symbol])
  @@map("instrument_name_aliases")
}

/// Scheduled events (news-events v2 §8). scope: company|market|commodity; impact: high|medium|low.
model MarketEvent {
  id        String   @id @default(cuid())
  scope     String
  kind      String
  key       String
  title     String
  startsAt  DateTime @db.Timestamptz(3)
  allDay    Boolean  @default(false)
  impact    String
  source    String
  sourceRef String?
  fetchedAt DateTime @default(now())

  @@unique([kind, key, startsAt])
  @@index([key, startsAt])
  @@map("market_events")
}
```
`prisma/migrations/20261016120000_news_events_v2/migration.sql`:
```sql
-- News & events v2 (docs/superpowers/specs/2026-10-16-news-events-design.md §11). Expand-only.
ALTER TABLE "news_articles"
  ADD COLUMN "instruments" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "sectors" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "indices" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "markets" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "tagVersion" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "dateInferred" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "news_articles_relatedSymbols_idx" ON "news_articles" USING GIN ("relatedSymbols");
CREATE INDEX "news_articles_instruments_idx" ON "news_articles" USING GIN ("instruments");
CREATE INDEX "news_articles_sectors_idx" ON "news_articles" USING GIN ("sectors");
CREATE INDEX "news_articles_indices_idx" ON "news_articles" USING GIN ("indices");
CREATE INDEX "news_articles_fetchedAt_idx" ON "news_articles"("fetchedAt");

CREATE TABLE "instrument_name_aliases" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "alias" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "instrument_name_aliases_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "instrument_name_aliases_alias_symbol_key" ON "instrument_name_aliases"("alias", "symbol");
CREATE INDEX "instrument_name_aliases_symbol_idx" ON "instrument_name_aliases"("symbol");

CREATE TABLE "market_events" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "startsAt" TIMESTAMPTZ(3) NOT NULL,
    "allDay" BOOLEAN NOT NULL DEFAULT false,
    "impact" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceRef" TEXT,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "market_events_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "market_events_kind_key_startsAt_key" ON "market_events"("kind", "key", "startsAt");
CREATE INDEX "market_events_key_startsAt_idx" ON "market_events"("key", "startsAt");

ALTER TABLE "sentinel_verdicts" ADD COLUMN "newsShadow" JSONB;
```

- [ ] **Step 4: Verify.** `npx prisma validate && npx prisma generate` → OK. Against a THROWAWAY database only (`SHADOW_URL`, a scratch DB on the local PG): `npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url "$SHADOW_URL"` → `No difference detected.` (if Prisma names an index differently, rename it in the SQL to Prisma's name — the schema is the source of truth, then re-run). The spec → PASS. `tsc` → 174.

- [ ] **Step 5: Commit**
```bash
git add prisma/schema.prisma prisma/migrations/20261016120000_news_events_v2/migration.sql apps/api/src/modules/news-events/schema.spec.ts
git commit -m "feat(news-events): expand-only migration — tag columns + GIN, aliases, market_events, verdict newsShadow" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- prisma/schema.prisma prisma/migrations/20261016120000_news_events_v2/migration.sql apps/api/src/modules/news-events/schema.spec.ts
```

---

## Task F3: Shared readers — `NseClient` and `SectorMapService` (Stream F)

**Files:**
- Create: `apps/api/src/modules/news-events/{nse-client.ts,nse-client.spec.ts,sector-map.service.ts,sector-map.service.spec.ts}`
- Modify: `apps/api/src/modules/news-events/news-events-core.module.ts`

**Interfaces:**
- Consumes: `NEWS_EVENTS_CONFIG`, `SECTOR_TOKEN_NAME`, `baseSymbol` (F1); `prisma.stockSector` (existing table `stock_sectors`).
- Produces: `NseClient.getText(endpoint, url): Promise<string>`, `NseClient.getJson(endpoint, url): Promise<unknown>`, `NseClient.backoffState()`; `SectorMapService.sectorOf(symbol): string | null`, `.refresh(): Promise<number>`, `.ready`; `buildSectorMap(rows)`.

- [ ] **Step 1: Write the failing tests** — `nse-client.spec.ts`:
```ts
import { NseClient, type NseFetch } from './nse-client';

type Reply = { status: number; body: string; setCookie?: string[] };
function fetchScript(replies: Reply[]) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const impl: NseFetch = async (url, init) => {
    calls.push({ url, headers: init.headers });
    const r = replies.shift();
    if (!r) throw new Error('no scripted reply');
    return {
      ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => r.body,
      headers: { get: () => null, getSetCookie: () => r.setCookie ?? [] },
    };
  };
  return { impl, calls };
}

describe('NseClient', () => {
  let now = 0;
  const make = (replies: Reply[], log: string[] = []) => {
    const f = fetchScript(replies);
    const c = new NseClient({ fetchImpl: f.impl, now: () => now, sleep: async () => undefined, log: (l) => log.push(l), retryDelayMs: 0 });
    return { c, calls: f.calls };
  };
  beforeEach(() => (now = Date.UTC(2026, 9, 16, 4, 0)));

  it('one request, JSON parsed, browser UA', async () => {
    const { c, calls } = make([{ status: 200, body: '[{"a":1}]' }]);
    await expect(c.getJson('ann', 'https://www.nseindia.com/api/x')).resolves.toEqual([{ a: 1 }]);
    expect(calls).toHaveLength(1);
    expect(calls[0].headers['User-Agent']).toMatch(/Mozilla/);
  });

  it('one retry, then a 60 s backoff during which the endpoint is not asked', async () => {
    const { c, calls } = make([{ status: 500, body: '' }, { status: 500, body: '' }]);
    await expect(c.getJson('ann', 'https://www.nseindia.com/api/x')).rejects.toThrow(/ann: HTTP 500/);
    expect(calls).toHaveLength(2);
    await expect(c.getJson('ann', 'https://www.nseindia.com/api/x')).rejects.toThrow(/in backoff/);
    expect(calls).toHaveLength(2);
    expect(c.backoffState().ann.until).toBe(new Date(now + 60_000).toISOString());
  });

  it('backoff doubles and caps at 30 min', async () => {
    const { c } = make(Array.from({ length: 40 }, () => ({ status: 503, body: '' })));
    const waits: number[] = [];
    for (let i = 0; i < 7; i++) {
      await c.getText('ev', 'https://www.nseindia.com/api/e').catch(() => undefined);
      const until = Date.parse(c.backoffState().ev.until);
      waits.push((until - now) / 60_000);
      now = until;
    }
    expect(waits).toEqual([1, 2, 4, 8, 16, 30, 30]);
  });

  it('a 200 HTML block page is a failure (counted, backed off), not data', async () => {
    const { c } = make([{ status: 200, body: '<html>Access Denied</html>' }]);
    await expect(c.getJson('ann', 'https://www.nseindia.com/api/x')).rejects.toThrow(/not JSON/);
    expect(c.backoffState().ann.failures).toBe(1);
  });

  it('401/403 on nseindia.com: homepage warm-up, cookie sent on the retry, never logged', async () => {
    const log: string[] = [];
    const { c, calls } = make(
      [{ status: 403, body: '' }, { status: 200, body: '<html/>', setCookie: ['nsit=SECRET1; Path=/', 'bm_sv=SECRET2; Path=/'] }, { status: 200, body: '[]' }],
      log,
    );
    await expect(c.getJson('ann', 'https://www.nseindia.com/api/x')).resolves.toEqual([]);
    expect(calls.map((x) => x.url)).toEqual(['https://www.nseindia.com/api/x', 'https://www.nseindia.com/', 'https://www.nseindia.com/api/x']);
    expect(calls[2].headers.Cookie).toBe('nsit=SECRET1; bm_sv=SECRET2');
    expect(log.join('\n')).not.toMatch(/SECRET/);
    expect(log).toContain('[nse-client] warm-up: 2 cookie(s) held in memory');
  });

  it('never warms up for, or sends the cookie to, a non-NSE host', async () => {
    const { c, calls } = make([{ status: 403, body: '' }, { status: 403, body: '' }]);
    await expect(c.getText('yahoo', 'https://query1.finance.yahoo.com/x')).rejects.toThrow(/HTTP 403/);
    expect(calls.map((x) => x.url)).toEqual(['https://query1.finance.yahoo.com/x', 'https://query1.finance.yahoo.com/x']);
    expect(calls[1].headers.Cookie).toBeUndefined();
  });

  it('serialises calls: never two requests in flight', async () => {
    let inFlight = 0;
    let max = 0;
    const impl: NseFetch = async () => {
      inFlight++;
      max = Math.max(max, inFlight);
      await new Promise((r) => setImmediate(r));
      inFlight--;
      return { ok: true, status: 200, text: async () => '[]', headers: { get: () => null } };
    };
    const c = new NseClient({ fetchImpl: impl, sleep: async () => undefined });
    await Promise.all([c.getJson('a', 'https://www.nseindia.com/1'), c.getJson('b', 'https://www.nseindia.com/2'), c.getJson('c', 'https://www.nseindia.com/3')]);
    expect(max).toBe(1);
  });
});
```
`sector-map.service.spec.ts`:
```ts
import { buildSectorMap, SectorMapService } from './sector-map.service';
import { parseNewsEventsConfig } from './config';

it('buildSectorMap: token → NSE sector name; unknown/null tokens skipped; series suffix stripped', () => {
  const m = buildSectorMap([
    { symbol: 'SBIN', sectorIndexToken: '99926033' },
    { symbol: 'TCS-EQ', sectorIndexToken: '99926013' },
    { symbol: 'XYZ', sectorIndexToken: null },
    { symbol: 'ABC', sectorIndexToken: '123' },
  ]);
  expect([...m.entries()]).toEqual([['SBIN', 'NIFTY PSU BANK'], ['TCS', 'NIFTY IT']]);
});

it('sectorOf is synchronous, null before the first load, served from memory after', async () => {
  const prisma = { stockSector: { findMany: jest.fn().mockResolvedValue([{ symbol: 'HDFCBANK', sectorIndexToken: '99926035' }]) } };
  const s = new SectorMapService(prisma as never, parseNewsEventsConfig({ NEWS_EVENTS_V2_ENABLED: 'observe' }));
  expect(s.sectorOf('HDFCBANK')).toBeNull();
  expect(s.ready).toBe(false);
  await expect(s.refresh()).resolves.toBe(1);
  expect(s.sectorOf('hdfcbank-eq')).toBe('NIFTY PVT BANK');
  expect(s.ready).toBe(true);
});

it('a failed refresh keeps the previous map', async () => {
  const prisma = {
    stockSector: {
      findMany: jest.fn().mockResolvedValueOnce([{ symbol: 'SBIN', sectorIndexToken: '99926033' }]).mockRejectedValueOnce(new Error('db down')),
    },
  };
  const s = new SectorMapService(prisma as never, parseNewsEventsConfig({ NEWS_EVENTS_V2_ENABLED: 'true' }));
  await s.refresh();
  await expect(s.refresh()).resolves.toBe(0);
  expect(s.sectorOf('SBIN')).toBe('NIFTY PSU BANK');
});
```

- [ ] **Step 2: Run** `cd apps/api && npx jest src/modules/news-events/nse-client.spec.ts src/modules/news-events/sector-map.service.spec.ts --ci --maxWorkers=2` → FAIL (module not found).

- [ ] **Step 3: Implement** — `nse-client.ts`:
```ts
/**
 * The ONE client for every NSE call in news-events v2 (spec §4.3): a serial queue
 * (never two requests in flight), one request + one retry, a browser UA, a
 * per-endpoint exponential backoff (60 s doubling, max 30 min) during which the
 * endpoint is not asked, and — owner decision N4 — a homepage warm-up for hosts
 * ending in nseindia.com ONLY, after a 401/403. The cookie jar lives in memory
 * and is never logged; log lines carry endpoint labels and HTTP status only.
 */
export interface NseFetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  headers: { get(name: string): string | null; getSetCookie?(): string[] };
}
export type NseFetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<NseFetchResponse>;

export interface NseClientOptions {
  userAgent: string;
  timeoutMs: number;
  retryDelayMs: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  fetchImpl: NseFetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
}

export const NSE_BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const NSE_HOME = 'https://www.nseindia.com/';

class NseHttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

export function isNseHost(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h === 'nseindia.com' || h.endsWith('.nseindia.com');
  } catch {
    return false;
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'AbortError') return 'request timed out';
    const cause = (err as { cause?: { code?: unknown } }).cause;
    return cause && typeof cause.code === 'string' ? `${err.message} (cause ${cause.code})` : err.message;
  }
  return String(err);
}

function splitSetCookie(header: string | null): string[] {
  return header ? header.split(/,(?=\s*[A-Za-z0-9_-]+=)/) : [];
}

export class NseClient {
  private readonly o: NseClientOptions;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly backoff = new Map<string, { failures: number; until: number }>();
  private cookie: string | null = null;

  constructor(opts: Partial<NseClientOptions> = {}) {
    this.o = {
      userAgent: NSE_BROWSER_UA,
      timeoutMs: 15_000,
      retryDelayMs: 2_000,
      backoffBaseMs: 60_000,
      backoffMaxMs: 30 * 60_000,
      fetchImpl: fetch as unknown as NseFetch,
      now: () => Date.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      log: () => undefined,
      ...opts,
    };
  }

  getText(endpoint: string, url: string): Promise<string> {
    return this.enqueue(endpoint, url, (body) => body);
  }

  getJson(endpoint: string, url: string): Promise<unknown> {
    return this.enqueue(endpoint, url, (body) => {
      try {
        return JSON.parse(body) as unknown;
      } catch {
        throw new Error(`response was not JSON (${body.slice(0, 40).replace(/\s+/g, ' ')}…)`);
      }
    });
  }

  backoffState(): Record<string, { failures: number; until: string }> {
    const out: Record<string, { failures: number; until: string }> = {};
    for (const [k, v] of this.backoff) out[k] = { failures: v.failures, until: new Date(v.until).toISOString() };
    return out;
  }

  private enqueue<T>(endpoint: string, url: string, parse: (body: string) => T): Promise<T> {
    const run = () => this.guarded(endpoint, url, parse);
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }

  private async guarded<T>(endpoint: string, url: string, parse: (body: string) => T): Promise<T> {
    const now = this.o.now();
    const b = this.backoff.get(endpoint);
    if (b && now < b.until) {
      throw new Error(`${endpoint} in backoff after ${b.failures} failure(s) until ${new Date(b.until).toISOString()}`);
    }
    try {
      const out = parse(await this.fetchWithRetry(url));
      this.backoff.delete(endpoint);
      return out;
    } catch (err) {
      const failures = (b?.failures ?? 0) + 1;
      const wait = Math.min(this.o.backoffBaseMs * 2 ** (failures - 1), this.o.backoffMaxMs);
      this.backoff.set(endpoint, { failures, until: now + wait });
      const why = describe(err);
      this.o.log(`[nse-client] ${endpoint} failed (${failures} consecutive): ${why}; next try after ${Math.round(wait / 1000)}s`);
      throw new Error(`${endpoint}: ${why}`);
    }
  }

  private async fetchWithRetry(url: string): Promise<string> {
    try {
      return await this.once(url);
    } catch (err) {
      if (err instanceof NseHttpError && (err.status === 401 || err.status === 403) && isNseHost(url)) await this.warmUp();
      else if (this.o.retryDelayMs > 0) await this.o.sleep(this.o.retryDelayMs);
      return this.once(url);
    }
  }

  private async once(url: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.o.timeoutMs);
    const headers: Record<string, string> = {
      'User-Agent': this.o.userAgent,
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
    };
    if (isNseHost(url)) {
      headers.Referer = NSE_HOME;
      if (this.cookie) headers.Cookie = this.cookie;
    }
    try {
      const res = await this.o.fetchImpl(url, { headers, signal: controller.signal });
      if (!res.ok) throw new NseHttpError(res.status);
      return await res.text();
    } finally {
      clearTimeout(timer);
    }
  }

  private async warmUp(): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.o.timeoutMs);
    try {
      const res = await this.o.fetchImpl(NSE_HOME, {
        headers: { 'User-Agent': this.o.userAgent, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' },
        signal: controller.signal,
      });
      const raw = res.headers.getSetCookie?.() ?? splitSetCookie(res.headers.get('set-cookie'));
      const pairs = raw.map((c) => c.split(';')[0].trim()).filter((p) => p.includes('='));
      if (pairs.length > 0) this.cookie = pairs.join('; ');
      this.o.log(`[nse-client] warm-up: ${pairs.length} cookie(s) held in memory`);
    } catch (err) {
      this.o.log(`[nse-client] warm-up failed: ${describe(err)}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
```
`sector-map.service.ts`:
```ts
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../common/prisma/prisma.service';
import { bootJobsEnabled } from '../../common/utils/boot-jobs';
import { NEWS_EVENTS_CONFIG, type NewsEventsConfig } from './config';
import { baseSymbol, SECTOR_TOKEN_NAME } from './keys';
import type { SectorLookup } from './types';

export function buildSectorMap(rows: Array<{ symbol: string; sectorIndexToken: string | null }>): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of rows) {
    const name = r.sectorIndexToken ? SECTOR_TOKEN_NAME[r.sectorIndexToken] : undefined;
    if (name) m.set(baseSymbol(r.symbol), name);
  }
  return m;
}

/**
 * Symbol → NSE sectoral index name, in memory, for tagging (§5.4) and the ladder (§7).
 * Built from `stock_sectors` (NseSectorIndexService refreshes it at 06:00 IST); reloaded
 * at 06:30 IST. `sectorOf` is synchronous. A failed reload keeps the previous map.
 */
@Injectable()
export class SectorMapService implements SectorLookup, OnModuleInit {
  private readonly logger = new Logger(SectorMapService.name);
  private map = new Map<string, string>();
  private loaded = false;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(NEWS_EVENTS_CONFIG) private readonly cfg: NewsEventsConfig,
  ) {}

  get ready(): boolean {
    return this.loaded;
  }

  onModuleInit(): void {
    if (!this.cfg.computing || !bootJobsEnabled()) return;
    void this.refresh();
  }

  @Cron('0 30 6 * * 1-5', { timeZone: 'Asia/Kolkata' })
  async daily(): Promise<void> {
    if (this.cfg.computing) await this.refresh();
  }

  async refresh(): Promise<number> {
    try {
      const rows = await this.prisma.stockSector.findMany({ select: { symbol: true, sectorIndexToken: true } });
      this.map = buildSectorMap(rows);
      this.loaded = true;
      this.logger.log(`[news-tag] sector map: ${this.map.size} symbols`);
      return this.map.size;
    } catch (err) {
      this.logger.warn(`[news-tag] sector map reload failed, keeping ${this.map.size} symbols: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }
  }

  sectorOf(symbol: string): string | null {
    return this.map.get(baseSymbol(symbol)) ?? null;
  }
}
```
In `news-events-core.module.ts`: import `NseClient` and `SectorMapService`; add to `providers`
```ts
    { provide: NseClient, useFactory: () => new NseClient({ log: (line) => logger.warn(line) }) },
    SectorMapService,
```
and add `NseClient, SectorMapService` to `exports`.

- [ ] **Step 4: Run** the two specs → PASS; `npx jest src/modules/news-events --ci --maxWorkers=2` → PASS; `tsc` → 174.

- [ ] **Step 5: Commit**
```bash
git add apps/api/src/modules/news-events/nse-client.ts apps/api/src/modules/news-events/nse-client.spec.ts apps/api/src/modules/news-events/sector-map.service.ts apps/api/src/modules/news-events/sector-map.service.spec.ts apps/api/src/modules/news-events/news-events-core.module.ts
git commit -m "feat(news-events): polite NSE client (queue, backoff, N4 warm-up) and in-memory sector map" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/api/src/modules/news-events/nse-client.ts apps/api/src/modules/news-events/nse-client.spec.ts apps/api/src/modules/news-events/sector-map.service.ts apps/api/src/modules/news-events/sector-map.service.spec.ts apps/api/src/modules/news-events/news-events-core.module.ts
```

---

## Task A1: M0 — source verification, RSS fixes, source health, pubDate guard (Stream A)

**Files:**
- Create: `apps/api/scripts/news-source-check.ts`
- Modify: `apps/api/src/modules/news/services/news-aggregator.service.ts`, `apps/api/src/modules/news/services/news-sources.spec.ts`, `apps/api/src/modules/news/news.module.ts`
- Create: `apps/api/src/modules/news/services/news-aggregator.service.spec.ts`

**Interfaces:**
- Consumes: `SourceHealthBook`, `NEWS_EVENTS_CONFIG`, `NewsEventsCoreModule` (F1); `NSE_BROWSER_UA` (F3 — if F3 is not merged yet, use the identical string literal and switch to the import after merging F).
- Produces: `RSS_SOURCES`, `REMOVED_SOURCES`, `RSS_FETCH_TIMEOUT_MS`, `pubDateGuard(raw, fetchedAt)`; `NewsAggregatorService` with health + guard.

- [ ] **Step 0: Worktree.** `git worktree add .claude/worktrees/ne-ingest -b feature/ne-ingest <F1 commit>`; junctions; `prisma generate`; tsc → 174.

- [ ] **Step 1: The M0 probe script** — `apps/api/scripts/news-source-check.ts`:
```ts
/**
 * M0 (news-events v2 §4.1/§17): probe every RSS source + replacement candidate with the
 * production UA and timeout, and (with --nse) the NSE endpoints, saving trimmed fixtures.
 * Usage: cd apps/api && npx ts-node scripts/news-source-check.ts [--nse]
 * Prints one row per URL; KEEP = HTTP 200 + XML + ≥1 <item> + newest pubDate within 7 days.
 */
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { rssSources } from '../src/modules/news/services/news-aggregator.service';
import { NseClient, NSE_BROWSER_UA } from '../src/modules/news-events/nse-client';

const CANDIDATES = [
  { name: 'Business Standard Markets', url: 'https://www.business-standard.com/rss/markets-106.rss' },
  { name: 'Business Standard Companies', url: 'https://www.business-standard.com/rss/companies-101.rss' },
  { name: 'ET Markets Stocks', url: 'https://economictimes.indiatimes.com/markets/stocks/rssfeeds/2146842.cms' },
  { name: 'Hindu BusinessLine Markets', url: 'https://www.thehindubusinessline.com/markets/feeder/default.rss' },
  { name: 'Hindu BusinessLine Commodities', url: 'https://www.thehindubusinessline.com/markets/commodities/feeder/default.rss' },
  { name: 'Investing.com Commodities', url: 'https://www.investing.com/rss/news_11.rss' },
];

async function probe(name: string, url: string): Promise<void> {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': NSE_BROWSER_UA, Accept: 'application/rss+xml, application/xml, text/xml' },
      signal: AbortSignal.timeout(15_000),
    });
    const body = await res.text();
    const items = (body.match(/<item[\s>]/gi) ?? []).length;
    const dates = [...body.matchAll(/<pubDate>([^<]+)<\/pubDate>/gi)].map((m) => Date.parse(m[1])).filter(Number.isFinite);
    const newest = dates.length ? new Date(Math.max(...dates)).toISOString() : '-';
    const xml = /xml/i.test(res.headers.get('content-type') ?? '') || /^\s*<\?xml|<rss/i.test(body);
    const fresh = dates.length > 0 && Date.now() - Math.max(...dates) < 7 * 86_400_000;
    const keep = res.status === 200 && xml && items > 0 && fresh;
    console.log([name, url, res.status, res.headers.get('content-type'), items, newest, `${Date.now() - t0}ms`, keep ? 'KEEP' : 'REMOVE'].join(' | '));
  } catch (err) {
    console.log([name, url, 'ERR', err instanceof Error ? err.message : String(err), 0, '-', `${Date.now() - t0}ms`, 'REMOVE'].join(' | '));
  }
}

async function nse(): Promise<void> {
  const dir = join(__dirname, '..', 'src', 'modules', 'news-events', '__fixtures__');
  mkdirSync(dir, { recursive: true });
  const c = new NseClient({ log: (l) => console.log(l) });
  const ddmmyyyy = (d: Date) => `${String(d.getUTCDate()).padStart(2, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${d.getUTCFullYear()}`;
  const now = new Date();
  const jobs: Array<[string, string, string]> = [
    ['nse-announcements.json', 'NSE corporate-announcements', 'https://www.nseindia.com/api/corporate-announcements?index=equities'],
    ['nse-event-calendar.json', 'NSE event-calendar', 'https://www.nseindia.com/api/event-calendar?index=equities'],
    ['nse-corporate-actions.json', 'NSE corporate-actions',
      `https://www.nseindia.com/api/corporates-corporateActions?index=equities&from_date=${ddmmyyyy(now)}&to_date=${ddmmyyyy(new Date(now.getTime() + 14 * 86_400_000))}`],
  ];
  for (const [file, label, url] of jobs) {
    try {
      const j = await c.getJson(label, url);
      const arr = Array.isArray(j) ? j : Array.isArray((j as { data?: unknown[] }).data) ? (j as { data: unknown[] }).data : [];
      writeFileSync(join(dir, file), JSON.stringify(arr.slice(0, 5), null, 2) + '\n');
      console.log(`${label}: ${arr.length} rows (5 saved to ${file})`);
    } catch (err) {
      console.log(`${label}: FAILED ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  try {
    const csv = await c.getText('NSE EQUITY_L', 'https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv');
    const lines = csv.split(/\r?\n/);
    writeFileSync(join(dir, 'equity-l.csv'), lines.slice(0, 6).join('\n') + '\n');
    console.log(`EQUITY_L: ${lines.length - 1} rows (header + 5 saved to equity-l.csv)`);
  } catch (err) {
    console.log(`EQUITY_L: FAILED ${err instanceof Error ? err.message : String(err)}`);
  }
}

(async () => {
  for (const s of rssSources()) await probe(s.name, s.url);
  for (const s of CANDIDATES) await probe(s.name, s.url);
  if (process.argv.includes('--nse')) await nse();
})();
```

- [ ] **Step 2: Run the probe and record the result.** `cd apps/api && npx ts-node scripts/news-source-check.ts --nse`. Paste the full table into this task's commit body. Find the real ET earnings feed: open `https://economictimes.indiatimes.com/rss.cms`, take the "Earnings" feed URL under Markets, add it as an extra `CANDIDATES` row and re-run. Decision rule (no judgement calls): a current source marked `REMOVE` is deleted from `RSS_SOURCES` and its name added to `REMOVED_SOURCES`; a candidate marked `KEEP` is added to `RSS_SOURCES` with category `indian` (markets/companies → `company`, commodities → `sector`); ET Earnings is replaced by the verified URL, or removed if none passes. If the NSE fixtures could not be captured from this machine (Akamai block), say so in the commit body — Tasks A6/C2 then use the documented shapes below and the Production Gate captures real ones on the VPS. Also measure volume on the local DB and paste it: `SELECT date_trunc('day',"fetchedAt") d, count(*) FROM news_articles GROUP BY 1 ORDER BY 2 DESC LIMIT 3;`.

- [ ] **Step 3: Write the failing tests.** Replace the third test of `news-sources.spec.ts` (`keeps every existing source`) with:
```ts
  it('M0: no removed source is fetched, every URL is https and unique, ET Earnings URL is not the malformed one', () => {
    const sources = rssSources({});
    for (const r of REMOVED_SOURCES) expect(sources.map((s) => s.name)).not.toContain(r);
    expect(new Set(sources.map((s) => s.url)).size).toBe(sources.length);
    for (const s of sources) expect(s.url).toMatch(/^https:\/\//);
    expect(sources.map((s) => s.url).join(' ')).not.toMatch(/12aborede/);
    expect(sources.length).toBeGreaterThanOrEqual(6);
  });
```
(import `REMOVED_SOURCES` beside `rssSources`). Create `news-aggregator.service.spec.ts`:
```ts
import { of, throwError } from 'rxjs';
import { NewsAggregatorService, pubDateGuard, RSS_FETCH_TIMEOUT_MS } from './news-aggregator.service';
import { SourceHealthBook } from '../../news-events/source-health';
import { parseNewsEventsConfig } from '../../news-events/config';

const NOW = new Date('2026-10-16T05:00:00.000Z');
const rss = (items: string) => `<?xml version="1.0"?><rss><channel>${items}</channel></rss>`;
const item = (title: string, link: string, pubDate?: string) =>
  `<item><title>${title}</title><link>${link}</link>${pubDate ? `<pubDate>${pubDate}</pubDate>` : ''}</item>`;

function harness(mode: string, bodies: Record<string, string | Error>) {
  const created: Array<Record<string, unknown>> = [];
  const http = {
    get: jest.fn((url: string, opts: { timeout: number; headers: Record<string, string> }) => {
      expect(opts.timeout).toBe(RSS_FETCH_TIMEOUT_MS);
      expect(opts.headers['User-Agent']).toMatch(/Mozilla/);
      const b = bodies[url];
      if (b === undefined) return throwError(() => new Error('timeout of 15000ms exceeded'));
      return b instanceof Error ? throwError(() => b) : of({ data: b });
    }),
  };
  const prisma = {
    newsArticle: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return { id: `id${created.length}`, fetchedAt: NOW, ...data };
      }),
    },
  };
  const sentiment = { analyzeSentiment: jest.fn().mockResolvedValue({ sentiment: 'neutral', score: 0, relatedSymbols: [] }) };
  const health = new SourceHealthBook();
  const svc = new NewsAggregatorService(prisma as never, http as never, sentiment as never, health, parseNewsEventsConfig({ NEWS_EVENTS_V2_ENABLED: mode }));
  svc.sourcesForTest = [
    { name: 'A', url: 'https://a.test/rss', category: 'indian' },
    { name: 'B', url: 'https://b.test/rss', category: 'global' },
  ];
  svc.clock = () => NOW;
  return { svc, created, health };
}

describe('pubDateGuard', () => {
  it.each([
    [null, true],
    ['not a date', true],
    ['Thu, 16 Oct 2026 10:00:00', true], // no zone: cannot be placed in time
    ['Thu, 16 Oct 2026 12:00:00 +0530', true], // 1 h 30 min in the future
    ['Thu, 16 Oct 2026 10:35:00 +0530', false], // 5 min in the future: clock skew, tolerated
    ['Thu, 16 Oct 2026 04:00:00 GMT', false],
  ])('%j → dateInferred %s', (raw, inferred) => {
    const g = pubDateGuard(raw, NOW);
    expect(g.dateInferred).toBe(inferred);
    if (inferred) expect(g.publishedAt).toEqual(NOW);
  });
});

describe('NewsAggregatorService — M0', () => {
  it('a failing source is recorded, not silently quiet; the others still save', async () => {
    const { svc, created, health } = harness('false', { 'https://a.test/rss': rss(item('Nifty ends higher', 'https://a.test/1', 'Thu, 16 Oct 2026 04:00:00 GMT')) });
    await svc.fetchAllNews();
    expect(created).toHaveLength(1);
    expect(health.all().find((h) => h.source === 'B')).toMatchObject({ consecutiveFailures: 1, lastError: expect.stringMatching(/timeout/) });
    expect(health.all().find((h) => h.source === 'A')).toMatchObject({ consecutiveFailures: 0, itemsLastFetch: 1 });
  });

  it('flag false: the insert is exactly today\'s (no v2 keys)', async () => {
    const { svc, created } = harness('false', { 'https://a.test/rss': rss(item('Gold rises', 'https://a.test/1')) });
    await svc.fetchAllNews();
    expect(Object.keys(created[0]).sort()).toEqual(
      ['category', 'publishedAt', 'relatedSymbols', 'sentiment', 'sentimentScore', 'source', 'summary', 'title', 'url'].sort(),
    );
  });

  it('flag observe: a missing pubDate is stored as fetchedAt with dateInferred=true', async () => {
    const { svc, created } = harness('observe', { 'https://a.test/rss': rss(item('Gold rises', 'https://a.test/1')) });
    await svc.fetchAllNews();
    expect(created[0]).toMatchObject({ publishedAt: NOW, dateInferred: true });
  });
});
```

- [ ] **Step 4: Run** `cd apps/api && npx jest src/modules/news/services --ci --maxWorkers=2` → FAIL (`pubDateGuard` / `REMOVED_SOURCES` not exported, constructor arity).

- [ ] **Step 5: Implement** in `news-aggregator.service.ts`:
  1. `RSS_SOURCES` per the Step 2 table; add
```ts
/** Removed in M0 (2026-10-16) after failing the probe — kept as a list so a test proves they stay gone. */
export const REMOVED_SOURCES: readonly string[] = [/* the names the Step 2 table marked REMOVE, e.g. 'Reuters Business' */];
export const RSS_FETCH_TIMEOUT_MS = 15_000;
```
  (the array literal holds exactly the removed names from your Step 2 table — the test reads it).
  2. Export the guard:
```ts
const ZONE_RE = /(?:[+-]\d{2}:?\d{2}|\b(?:GMT|UTC|UT|Z|[ECMP][SD]T|IST))\s*$/i;

/** R6: a pubDate we cannot place in time (missing, unparseable, zone-less, > 10 min ahead) is `fetchedAt` + inferred. */
export function pubDateGuard(raw: string | null, fetchedAt: Date): { publishedAt: Date; dateInferred: boolean } {
  const s = (raw ?? '').replace(/<!\[CDATA\[|\]\]>/g, '').trim();
  const ms = s ? Date.parse(s) : NaN;
  if (!s || !Number.isFinite(ms) || !ZONE_RE.test(s) || ms - fetchedAt.getTime() > FUTURE_PUBDATE_TOLERANCE_MS) {
    return { publishedAt: fetchedAt, dateInferred: true };
  }
  return { publishedAt: new Date(ms), dateInferred: false };
}
```
  3. Constructor gains, AFTER the existing three parameters: `@Optional() private readonly health?: SourceHealthBook`, `@Optional() @Inject(NEWS_EVENTS_CONFIG) private readonly cfg?: NewsEventsConfig`. Add test seams `sourcesForTest?: RSSSource[]` and `clock: () => Date = () => new Date()`; `fetchAllNews` uses `(this.sourcesForTest ?? rssSources())`.
  4. `fetchFromSource` uses `timeout: RSS_FETCH_TIMEOUT_MS`, `'User-Agent': NSE_BROWSER_UA`; on success `this.health?.ok(source.name, articles.length, this.clock())`, on failure `this.health?.fail(source.name, message, this.clock())` (still returns `[]`; the error log line stays).
  5. `ParsedArticle` gains `guard: { publishedAt: Date; dateInferred: boolean }`, set in `parseRSS` via `pubDateGuard(pubDate, fetchedAt)` where `fetchedAt = this.clock()` is taken once per `fetchAllNews`. The legacy `publishedAt` computation is unchanged.
  6. In the `create` call: `publishedAt: this.cfg?.computing ? article.guard.publishedAt : article.publishedAt,` and spread `...(this.cfg?.computing ? { dateInferred: article.guard.dateInferred } : {})` after it.
  7. `news.module.ts`: add `NewsEventsCoreModule` to `imports`.

- [ ] **Step 6: Run** `npx jest src/modules/news --ci --maxWorkers=2` → PASS; `npx jest src/modules/trade-sentinel/adapters/overnight-evidence.adapter.spec.ts --ci --maxWorkers=2` → PASS (constructor change is additive); tsc → 174.

- [ ] **Step 7: Commit** (body = the Step 2 table, the NSE capture result, the volume numbers):
```bash
git add apps/api/scripts/news-source-check.ts apps/api/src/modules/news/services/news-aggregator.service.ts apps/api/src/modules/news/services/news-aggregator.service.spec.ts apps/api/src/modules/news/services/news-sources.spec.ts apps/api/src/modules/news/news.module.ts apps/api/src/modules/news-events/__fixtures__
git commit -F <msgfile> -- apps/api/scripts/news-source-check.ts apps/api/src/modules/news/services/news-aggregator.service.ts apps/api/src/modules/news/services/news-aggregator.service.spec.ts apps/api/src/modules/news/services/news-sources.spec.ts apps/api/src/modules/news/news.module.ts apps/api/src/modules/news-events/__fixtures__
```
Subject: `fix(news): M0 — verified RSS sources, 15 s browser-UA fetch, per-source health, pubDate guard`.

---

## Task A2: Commodity/index keyword sets, market & sector rules (Stream A)

**Files:**
- Modify: `apps/api/src/modules/news/services/underlying-news-aliases.ts` (add `export` to `AliasPattern` and `firstHit` only)
- Modify (only if the reconcile finds names): `apps/api/src/modules/news-events/keys.ts` (`MCX_PARENT_V2`, `MCX_BENCHMARKS_V2`, `MCX_GROUP`)
- Create: `apps/api/src/modules/news-events/tagging/{commodity-index-keywords.ts,commodity-index-keywords.spec.ts,market-sector-rules.ts,market-sector-rules.spec.ts}`

**Interfaces:**
- Consumes: `INDEX_UNDERLYINGS_V2`, `MCX_BENCHMARKS_V2`, `MCX_PARENT_V2`, `MCX_UNDERLYINGS` (F1); v1 `UNDERLYING_NEWS_ALIASES`.
- Produces: `COMMODITY_KEYWORDS_V2`, `INDEX_KEYWORDS_V2`, `keywordTags(text): { commodities: string[]; indices: string[] }`; `marketTags(category, text): MarketTag[]`, `sectorPhraseTags(text): string[]`, `FEED_SECTOR`.

- [ ] **Step 1: Reconcile the MCX list** against the local master: `psql "$DATABASE_URL" -c "SELECT DISTINCT name FROM instruments WHERE exchange='MCX' AND \"isActive\" AND (expiry IS NULL OR expiry >= now()) ORDER BY 1"`. Every name not already in `MCX_UNDERLYINGS` is added to `keys.ts` — a mini/variant to `MCX_PARENT_V2` (pointing at its benchmark), a new benchmark to `MCX_BENCHMARKS_V2` + `MCX_GROUP` + a keyword entry in Step 4. Paste the query output into the commit body.

- [ ] **Step 2: Write the failing tests** — `commodity-index-keywords.spec.ts`:
```ts
import { COMMODITY_KEYWORDS_V2, INDEX_KEYWORDS_V2, keywordTags } from './commodity-index-keywords';
import { INDEX_UNDERLYINGS_V2, MCX_BENCHMARKS_V2, MCX_PARENT_V2, MCX_UNDERLYINGS } from '../keys';

const tag = (t: string) => keywordTags(t);

describe('completeness (spec §5.3)', () => {
  it('every MCX underlying on the (reconciled) master maps to a benchmark with keywords', () => {
    for (const u of MCX_UNDERLYINGS) expect(COMMODITY_KEYWORDS_V2[MCX_PARENT_V2[u] ?? u]?.length ?? 0).toBeGreaterThan(0);
    for (const b of MCX_BENCHMARKS_V2) expect(COMMODITY_KEYWORDS_V2[b]?.length ?? 0).toBeGreaterThan(0);
  });
  it('every index underlying has keywords', () => {
    for (const i of INDEX_UNDERLYINGS_V2) expect(INDEX_KEYWORDS_V2[i]?.length ?? 0).toBeGreaterThan(0);
  });
});

describe('new commodities and their guards', () => {
  it.each([
    ['LME lead prices climb on supply worries', ['LEAD'], []],
    ['Lead futures slip on MCX', ['LEAD'], []],
    ['Infosys to lead the rally in IT', [], []],
    ['HDFC Bank will lead the pack', [], []],
    ['Zinc rallies to a two-year high', ['ZINC'], []],
    ['Hindustan Zinc Q2 profit rises', [], []],
    ['Aluminium prices ease; aluminum stocks fall', ['ALUMINIUM'], []],
    ['Nickel jumps 4% on Indonesia curbs', ['NICKEL'], []],
    ['Company recalls nickel-plated fittings', [], []],
    ['Cotton prices firm on lower arrivals', ['COTTON'], []],
    ['Kapas futures hit upper circuit', ['COTTON'], []],
    ['Cotton shirts sell out', [], []],
    ['Mentha oil gains on export demand', ['MENTHAOIL'], []],
    ['Coal India shares rise; Oil India up 3%', [], []],
  ])('%s', (text, commodities, indices) => {
    expect(tag(text)).toEqual({ commodities, indices });
  });
});

describe('indices', () => {
  it.each([
    ['Sensex falls 500 points', [], ['SENSEX']],
    ['Sensex 50 constituents rejig', [], ['SENSEX50']],
    ['Bankex slips as lenders drag', [], ['BANKEX']],
    ['FinNifty weekly expiry today', [], ['FINNIFTY']],
    ['Nifty Midcap Select options volumes jump', [], ['MIDCPNIFTY']],
    ['Nifty Next 50 index rebalancing', [], ['NIFTYNXT50']],
    ['Nifty ends at record; Bank Nifty lags', [], ['NIFTY', 'BANKNIFTY']],
    ['a nifty little gadget', [], []],
  ])('%s', (text, commodities, indices) => {
    expect(tag(text)).toEqual({ commodities, indices });
  });
});
```
`market-sector-rules.spec.ts`:
```ts
import { FEED_SECTOR, marketTags, sectorPhraseTags } from './market-sector-rules';

it.each([
  ['indian', 'Markets open flat', ['IN']],
  ['global', 'Asian stocks mixed', ['GLOBAL']],
  ['sector', 'RBI holds repo rate; Fed signals a pause', ['IN', 'GLOBAL']],
  ['company', 'SEBI tightens F&O rules', ['IN']],
  ['company', 'China stimulus lifts metals', ['GLOBAL']],
  ['company', 'Tata Motors recalls 10,000 cars', []],
  ['sector', 'the fed-up investor', []],
])('marketTags(%s, %s)', (category, text, want) => {
  expect(marketTags(category, text)).toEqual(want);
});

it.each([
  ['PSU banks rally on merger talk', ['NIFTY PSU BANK']],
  ['IT stocks drag Nifty', ['NIFTY IT']],
  ['it stocks up', []],
  ['Auto sales rise 12% in September', ['NIFTY AUTO']],
  ['NBFCs face tighter norms', ['NIFTY FIN SERVICE']],
])('sectorPhraseTags(%s)', (text, want) => {
  expect(sectorPhraseTags(text)).toEqual(want);
});

it('feed → sector', () => {
  expect(FEED_SECTOR['ET BFSI']).toEqual(['NIFTY BANK', 'NIFTY FIN SERVICE']);
  expect(FEED_SECTOR['ET Auto']).toEqual(['NIFTY AUTO']);
});
```

- [ ] **Step 3: Run** `cd apps/api && npx jest src/modules/news-events/tagging --ci --maxWorkers=2` → FAIL (module not found).

- [ ] **Step 4: Implement.** In `underlying-news-aliases.ts` change `interface AliasPattern` → `export interface AliasPattern` and `function firstHit` → `export function firstHit` (no other edit; `underlying-news-aliases.spec.ts` must still pass unchanged). `tagging/commodity-index-keywords.ts`:
```ts
import { firstHit, UNDERLYING_NEWS_ALIASES, type AliasPattern } from '../../news/services/underlying-news-aliases';
import { INDEX_UNDERLYINGS_V2, MCX_BENCHMARKS_V2 } from '../keys';

/**
 * v2 commodity + index keywords (spec §5.3). The v1 map is reused verbatim for the
 * seven keys it has; the rest are new, each guarded the way v1 guards its own.
 * Run on text whose company-name spans are already blanked (name consumption), so
 * "Hindustan Zinc" and "Senco Gold" never reach these patterns.
 */
const V2_EXTRA: Readonly<Record<string, readonly AliasPattern[]>> = {
  ZINC: [{ re: /\bzinc\b/gi, notBefore: /\bHindustan\s+$/i }],
  // Never the verb: only the metal's market phrases.
  LEAD: [{ re: /\bLME lead\b/gi }, { re: /\blead (?:prices?|futures|contracts?)\b/gi }],
  ALUMINIUM: [{ re: /\balumin(?:i)?um\b/gi }],
  NICKEL: [{ re: /\bnickel\b/gi, notAfter: /^-?plated\b/i }],
  COTTON: [{ re: /\bcotton (?:prices?|futures|candy|arrivals|output|crop)\b/gi }, { re: /\bkapas\b/gi }],
  MENTHAOIL: [{ re: /\bmentha(?: oil)?\b/gi }],
  FINNIFTY: [{ re: /\bFin\s?Nifty\b/gi }, { re: /\bNifty Financial Services\b/gi }],
  MIDCPNIFTY: [{ re: /\bNifty Midcap Select\b/gi }, { re: /\bMIDCPNIFTY\b/g }],
  NIFTYNXT50: [{ re: /\bNifty Next 50\b/gi }],
  SENSEX: [{ re: /\b(?:Sensex|SENSEX)\b/g, notAfter: /^\s?50\b/ }],
  SENSEX50: [{ re: /\b(?:Sensex|SENSEX)\s?50\b/g }],
  BANKEX: [{ re: /\b(?:Bankex|BANKEX)\b/g }],
};

const ALL: Readonly<Record<string, readonly AliasPattern[]>> = { ...UNDERLYING_NEWS_ALIASES, ...V2_EXTRA };
const pick = (keys: readonly string[]) => Object.fromEntries(keys.filter((k) => ALL[k]).map((k) => [k, ALL[k]]));

export const COMMODITY_KEYWORDS_V2: Readonly<Record<string, readonly AliasPattern[]>> = pick(MCX_BENCHMARKS_V2);
export const INDEX_KEYWORDS_V2: Readonly<Record<string, readonly AliasPattern[]>> = pick(INDEX_UNDERLYINGS_V2);

function hits(text: string, table: Readonly<Record<string, readonly AliasPattern[]>>): string[] {
  const found: Array<{ key: string; at: number }> = [];
  for (const [key, patterns] of Object.entries(table)) {
    const at = patterns.map((p) => firstHit(text, p as AliasPattern)).filter((i) => i >= 0);
    if (at.length > 0) found.push({ key, at: Math.min(...at) });
  }
  return found.sort((a, b) => a.at - b.at).map((h) => h.key);
}

export function keywordTags(text: string): { commodities: string[]; indices: string[] } {
  if (!text || !text.trim()) return { commodities: [], indices: [] };
  return { commodities: hits(text, COMMODITY_KEYWORDS_V2), indices: hits(text, INDEX_KEYWORDS_V2) };
}
```
`tagging/market-sector-rules.ts`:
```ts
import type { MarketTag } from '../types';

const IN_RE = /\b(?:RBI|Reserve Bank of India|SEBI|GST|MPC|India(?:'s)? (?:CPI|inflation|GDP))\b/;
const GLOBAL_RE = /\b(?:Fed|FOMC|Federal Reserve|Powell|US (?:CPI|inflation|jobs|payrolls|GDP)|ECB|China|Treasury yields?|Wall Street)\b/;

/** Spec §5.5. Case-sensitive keywords: "the fed-up investor" is not the Fed. */
export function marketTags(category: string, text: string): MarketTag[] {
  const out: MarketTag[] = [];
  if (category === 'indian' || IN_RE.test(text)) out.push('IN');
  if (category === 'global' || GLOBAL_RE.test(text)) out.push('GLOBAL');
  return out;
}

/** The ET sector feeds (spec §5.4). Keys are RSS source names in news-aggregator.service.ts. */
export const FEED_SECTOR: Readonly<Record<string, readonly string[]>> = {
  'ET Auto': ['NIFTY AUTO'],
  'ET Tech': ['NIFTY IT'],
  'ET Pharma': ['NIFTY PHARMA'],
  'ET BFSI': ['NIFTY BANK', 'NIFTY FIN SERVICE'],
  'ET Energy': ['NIFTY ENERGY'],
};

const SECTOR_PHRASES: ReadonlyArray<{ re: RegExp; sector: string }> = [
  { re: /\bPSU banks?\b/i, sector: 'NIFTY PSU BANK' },
  { re: /\b(?:private|pvt) (?:sector )?banks?\b/i, sector: 'NIFTY PVT BANK' },
  { re: /\bbank(?:ing)? (?:stocks|shares|sector)\b/i, sector: 'NIFTY BANK' },
  { re: /\bIT (?:stocks|shares|sector|companies|services|majors)\b/, sector: 'NIFTY IT' },
  { re: /\bauto (?:sales|stocks|shares|sector)\b/i, sector: 'NIFTY AUTO' },
  { re: /\bpharma (?:stocks|shares|sector|companies)\b/i, sector: 'NIFTY PHARMA' },
  { re: /\bmetal (?:stocks|shares|sector)\b/i, sector: 'NIFTY METAL' },
  { re: /\bFMCG (?:stocks|shares|sector|companies)\b/i, sector: 'NIFTY FMCG' },
  { re: /\brealty (?:stocks|shares|sector)\b/i, sector: 'NIFTY REALTY' },
  { re: /\bNBFCs?\b/, sector: 'NIFTY FIN SERVICE' },
];

export function sectorPhraseTags(text: string): string[] {
  const out: string[] = [];
  for (const p of SECTOR_PHRASES) if (p.re.test(text) && !out.includes(p.sector)) out.push(p.sector);
  return out;
}
```

- [ ] **Step 5: Run** `npx jest src/modules/news-events src/modules/news/services/underlying-news-aliases.spec.ts --ci --maxWorkers=2` → PASS; tsc → 174.

- [ ] **Step 6: Commit** `feat(news-events): v2 commodity/index keywords with guards, market and sector rules` with the explicit paths above.

---

## Task A3: Company-name aliases and the name matcher (Stream A)

**Files:**
- Create: `apps/api/src/modules/news-events/tagging/{curated-aliases.ts,alias-derivation.ts,alias-derivation.spec.ts,name-matcher.ts,name-matcher.spec.ts}`

**Interfaces:**
- Consumes: `hasNoCaseSignal` from `news/services/extract-symbols.ts`.
- Produces: `AliasRow { symbol: string; alias: string; kind: 'official' | 'derived' | 'curated' | 'blocked' }`; `parseEquityL(csv): Array<{ symbol: string; name: string }>`; `deriveAliases(rows, curated?, blocklist?, blocked?): AliasRow[]`; `class NameMatcher { constructor(rows: AliasRow[]); match(text): { symbols: string[]; spans: Array<[number, number]> }; readonly size: number; approxBytes(): number }`; `blankSpans(text, spans): string`.

- [ ] **Step 1: Write the failing tests** — `alias-derivation.spec.ts`:
```ts
import { deriveAliases, parseEquityL } from './alias-derivation';

const rows = [
  { symbol: 'TATAMOTORS', name: 'Tata Motors Limited' },
  { symbol: 'TATASTEEL', name: 'Tata Steel Limited' },
  { symbol: 'HINDZINC', name: 'Hindustan Zinc Limited' },
  { symbol: 'COALINDIA', name: 'Coal India Limited' },
  { symbol: 'OIL', name: 'Oil India Limited' },
  { symbol: 'SENCO', name: 'Senco Gold Limited' },
  { symbol: 'INFY', name: 'Infosys Limited' },
  { symbol: 'WIPRO', name: 'Wipro Limited' },
  { symbol: 'BEL', name: 'Bharat Electronics Limited' },
  { symbol: 'BHARATX', name: 'Bharat Limited' },
  { symbol: 'ABC1', name: 'Twin Name Limited' },
  { symbol: 'ABC2', name: 'Twin Name Ltd.' },
  { symbol: 'GOLDCO', name: 'Gold Limited' },
];
const aliasesOf = (sym: string, out = deriveAliases(rows)) => out.filter((a) => a.symbol === sym).map((a) => a.alias);

it('official name and the suffix-stripped name', () => {
  expect(aliasesOf('TATAMOTORS')).toEqual(['Tata Motors', 'Tata Motors Limited']);
  expect(aliasesOf('HINDZINC')).toEqual(['Hindustan Zinc', 'Hindustan Zinc Limited']);
});
it('single-word aliases need ≥ 6 letters and must not be a common word', () => {
  expect(aliasesOf('INFY')).toEqual(['Infosys', 'Infosys Limited']);
  expect(aliasesOf('WIPRO')).toEqual(['Wipro Limited']);
  expect(aliasesOf('BHARATX')).toEqual(['Bharat Limited']);
  expect(aliasesOf('GOLDCO')).toEqual(['Gold Limited']);
});
it('an alias shared by two symbols is dropped (unless curated)', () => {
  const out = deriveAliases(rows);
  expect(out.filter((a) => a.alias === 'Twin Name')).toEqual([]);
  const cur = deriveAliases(rows, { 'Twin Name': 'ABC1' });
  expect(cur.filter((a) => a.alias === 'Twin Name')).toEqual([{ symbol: 'ABC1', alias: 'Twin Name', kind: 'curated' }]);
});
it('curated short forms are added; blocked aliases are removed', () => {
  const out = deriveAliases(rows, { 'L&T': 'LT' }, undefined, new Set(['Coal India']));
  expect(out).toContainEqual({ symbol: 'LT', alias: 'L&T', kind: 'curated' });
  expect(aliasesOf('COALINDIA', out)).toEqual(['Coal India Limited']);
});
it('parseEquityL reads the NSE header (with its leading spaces) and quoted names', () => {
  const csv = 'SYMBOL,NAME OF COMPANY, SERIES, DATE OF LISTING\n20MICRONS,"20 Microns, Limited",EQ,06-OCT-2008\nTATAMOTORS,Tata Motors Limited,EQ,22-JUL-1998\n';
  expect(parseEquityL(csv)).toEqual([
    { symbol: '20MICRONS', name: '20 Microns, Limited' },
    { symbol: 'TATAMOTORS', name: 'Tata Motors Limited' },
  ]);
});
```
`name-matcher.spec.ts` (the spec §16 table):
```ts
import { blankSpans, NameMatcher } from './name-matcher';
import { deriveAliases } from './alias-derivation';
import { CURATED_ALIASES } from './curated-aliases';

const m = new NameMatcher(
  deriveAliases(
    [
      { symbol: 'TATAMOTORS', name: 'Tata Motors Limited' },
      { symbol: 'TATASTEEL', name: 'Tata Steel Limited' },
      { symbol: 'SENCO', name: 'Senco Gold Limited' },
      { symbol: 'HINDZINC', name: 'Hindustan Zinc Limited' },
      { symbol: 'COALINDIA', name: 'Coal India Limited' },
      { symbol: 'OIL', name: 'Oil India Limited' },
      { symbol: 'IOC', name: 'Indian Oil Corporation Limited' },
      { symbol: 'LT', name: 'Larsen & Toubro Limited' },
    ],
    CURATED_ALIASES,
  ),
);

it.each([
  ['Tata Motors recalls 10,000 cars', ['TATAMOTORS']],
  ['Tata group shares mixed', []],
  ['Senco Gold Q2 profit doubles', ['SENCO']],
  ['Hindustan Zinc raises output', ['HINDZINC']],
  ['Coal India and Oil India rise', ['COALINDIA', 'OIL']],
  ['Indian Oil Corporation cuts prices', ['IOC']],
  ['L&T bags order; Larsen & Toubro shares up', ['LT']],
  ['tata motors (lower case) is not the alias as written', []],
  ['TATA MOTORS RECALLS CARS ACROSS INDIA TODAY', []],
])('%s', (text, want) => {
  expect(m.match(text).symbols).toEqual(want);
});

it('longest match wins and the span is consumed', () => {
  const text = 'Senco Gold jumps as gold prices rise';
  const r = m.match(text);
  expect(r.spans).toEqual([[0, 10]]);
  expect(blankSpans(text, r.spans)).toBe('           jumps as gold prices rise');
});

it('one pass regardless of alias count: 20k aliases match in < 2 ms per article', () => {
  const big = new NameMatcher(Array.from({ length: 20_000 }, (_, i) => ({ symbol: `S${i}`, alias: `Company${i} Industries`, kind: 'official' as const })));
  const text = 'Company19999 Industries reports results; '.repeat(10);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 100; i++) big.match(text);
  expect(Number(process.hrtime.bigint() - t0) / 1e6 / 100).toBeLessThan(2);
  expect(big.approxBytes()).toBeLessThan(2 * 1024 * 1024 * 2); // spec: ≤ 2 MB for ~2k real aliases; 20k synthetic stays < 4 MB
});
```

- [ ] **Step 2: Run** `cd apps/api && npx jest src/modules/news-events/tagging --ci --maxWorkers=2` → FAIL.

- [ ] **Step 3: Implement** — `curated-aliases.ts`:
```ts
/**
 * Hand-maintained short forms (spec §5.2) → NSE symbol. Curated aliases are kept
 * even when shared and regardless of length. Add only forms that, in Indian
 * financial copy, almost always mean the company.
 */
export const CURATED_ALIASES: Readonly<Record<string, string>> = {
  'L&T': 'LT',
  'M&M': 'M&M',
  RIL: 'RELIANCE',
  'Reliance Industries': 'RELIANCE',
  SBI: 'SBIN',
  HUL: 'HINDUNILVR',
  ITC: 'ITC',
  TCS: 'TCS',
  'HDFC Bank': 'HDFCBANK',
  'ICICI Bank': 'ICICIBANK',
  'Axis Bank': 'AXISBANK',
  'Kotak Mahindra Bank': 'KOTAKBANK',
  'Bajaj Finance': 'BAJFINANCE',
  'Bajaj Finserv': 'BAJAJFINSV',
  'Bajaj Auto': 'BAJAJ-AUTO',
  'Maruti Suzuki': 'MARUTI',
  'Sun Pharma': 'SUNPHARMA',
  "Dr Reddy's": 'DRREDDY',
  ONGC: 'ONGC',
  NTPC: 'NTPC',
  BPCL: 'BPCL',
  HPCL: 'HINDPETRO',
  IOC: 'IOC',
  GAIL: 'GAIL',
  BHEL: 'BHEL',
  HAL: 'HAL',
  BEL: 'BEL',
  'Adani Ports': 'ADANIPORTS',
  'Adani Enterprises': 'ADANIENT',
};

/** Single words that are company names AND ordinary words (spec §5.2 guard). Compared case-insensitively. */
export const COMMON_WORD_BLOCKLIST: ReadonlySet<string> = new Set([
  'bharat', 'indian', 'india', 'national', 'gold', 'power', 'global', 'capital', 'finance', 'energy', 'industries',
  'united', 'standard', 'general', 'premier', 'supreme', 'century', 'future', 'reliance', 'eastern', 'western',
  'southern', 'northern', 'central', 'oriental', 'universal', 'hindustan', 'pioneer', 'triveni', 'vision', 'galaxy',
  'phoenix', 'apollo', 'mangalam', 'shree', 'kingfisher', 'paramount', 'infinity', 'success', 'motors', 'steel',
]);

/** Aliases removed on review of observe-mode false positives (spec §17 M2). Exact text. */
export const BLOCKED_ALIASES: ReadonlySet<string> = new Set<string>([]);
```
`alias-derivation.ts`:
```ts
import { BLOCKED_ALIASES, COMMON_WORD_BLOCKLIST, CURATED_ALIASES } from './curated-aliases';

export type AliasKind = 'official' | 'derived' | 'curated' | 'blocked';
export interface AliasRow { symbol: string; alias: string; kind: AliasKind }

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

/** "Tata Motors Limited" → "Tata Motors"; "(India)", "Ltd.", "& Co" stripped, repeatedly. */
export function stripSuffixes(name: string): string {
  let s = clean(name);
  for (;;) {
    const next = clean(s.replace(/\s*\((?:India|I)\)\s*$/i, '').replace(/\s+(?:Limited|Ltd\.?)$/i, '').replace(/\s*&\s*Co\.?$/i, ''));
    if (next === s) return s;
    s = next;
  }
}

function admissible(alias: string, blocklist: ReadonlySet<string>): boolean {
  const words = alias.split(' ');
  if (!/[a-z]/.test(alias)) return false; // an all-caps "name" carries no case signal; tickers cover it
  if (words.length === 1) {
    const letters = alias.replace(/[^A-Za-z]/g, '');
    return letters.length >= 6 && !blocklist.has(alias.toLowerCase());
  }
  return true;
}

export function deriveAliases(
  rows: ReadonlyArray<{ symbol: string; name: string }>,
  curated: Readonly<Record<string, string>> = CURATED_ALIASES,
  blocklist: ReadonlySet<string> = COMMON_WORD_BLOCKLIST,
  blocked: ReadonlySet<string> = BLOCKED_ALIASES,
): AliasRow[] {
  const candidates: AliasRow[] = [];
  for (const r of rows) {
    const official = clean(r.name);
    const derived = stripSuffixes(official);
    if (official && admissible(official, blocklist)) candidates.push({ symbol: r.symbol, alias: official, kind: 'official' });
    if (derived && derived !== official && admissible(derived, blocklist)) candidates.push({ symbol: r.symbol, alias: derived, kind: 'derived' });
  }
  const owners = new Map<string, Set<string>>();
  for (const c of candidates) owners.set(c.alias, (owners.get(c.alias) ?? new Set()).add(c.symbol));
  const out = candidates.filter((c) => owners.get(c.alias)!.size === 1 && !blocked.has(c.alias) && curated[c.alias] === undefined);
  for (const [alias, symbol] of Object.entries(curated)) if (!blocked.has(alias)) out.push({ symbol, alias, kind: 'curated' });
  return out.sort((a, b) => (a.symbol === b.symbol ? a.alias.localeCompare(b.alias) : a.symbol.localeCompare(b.symbol)));
}

/** NSE EQUITY_L.csv → (symbol, name). Header names are trimmed (NSE pads them with spaces). */
export function parseEquityL(csv: string): Array<{ symbol: string; name: string }> {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length === 0) return [];
  const header = splitCsv(lines[0]).map((h) => h.trim().toUpperCase());
  const iSym = header.indexOf('SYMBOL');
  const iName = header.indexOf('NAME OF COMPANY');
  if (iSym < 0 || iName < 0) throw new Error(`EQUITY_L header not recognised: ${lines[0].slice(0, 80)}`);
  return lines.slice(1).map(splitCsv).filter((c) => c[iSym] && c[iName]).map((c) => ({ symbol: c[iSym].trim().toUpperCase(), name: clean(c[iName]) }));
}

function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}
```
(`deriveAliases` puts curated entries last and drops a derived/official candidate whose text is also curated, so a curated alias is never also "shared". The test expectation `['Tata Motors', 'Tata Motors Limited']` relies on the alias sort within a symbol.)

`name-matcher.ts`:
```ts
import { hasNoCaseSignal } from '../../news/services/extract-symbols';
import type { AliasRow } from './alias-derivation';

interface Node { next: Map<string, Node>; symbol?: string }
const TOKEN_RE = /[A-Za-z0-9]+(?:[&'’.][A-Za-z0-9]+)*/g;

function tokens(text: string): Array<{ t: string; start: number; end: number }> {
  const out: Array<{ t: string; start: number; end: number }> = [];
  for (const m of text.matchAll(TOKEN_RE)) out.push({ t: m[0].replace('’', "'"), start: m.index!, end: m.index! + m[0].length });
  return out;
}

/**
 * Company-name matcher (spec §5.2): one token-trie compiled at build time, one pass
 * per article, case-sensitive on the alias as written, longest match wins, and a
 * matched name CONSUMES its span (the caller blanks it before keyword matching).
 */
export class NameMatcher {
  private readonly root: Node = { next: new Map() };
  private count = 0;
  private bytes = 0;

  constructor(rows: readonly AliasRow[]) {
    for (const r of rows) {
      if (r.kind === 'blocked') continue;
      let n = this.root;
      for (const { t } of tokens(r.alias)) {
        let c = n.next.get(t);
        if (!c) {
          c = { next: new Map() };
          n.next.set(t, c);
          this.bytes += 64 + t.length * 2;
        }
        n = c;
      }
      if (n !== this.root && !n.symbol) {
        n.symbol = r.symbol;
        this.count++;
        this.bytes += r.symbol.length * 2;
      }
    }
  }

  get size(): number {
    return this.count;
  }

  /** Structural estimate for the spec §6/§12 memory ceiling (Map entry + node + string bytes). */
  approxBytes(): number {
    return this.bytes;
  }

  match(text: string): { symbols: string[]; spans: Array<[number, number]> } {
    const symbols: string[] = [];
    const spans: Array<[number, number]> = [];
    if (!text || hasNoCaseSignal(text)) return { symbols, spans };
    const tk = tokens(text);
    let i = 0;
    while (i < tk.length) {
      let n: Node | undefined = this.root;
      let best: { j: number; symbol: string } | null = null;
      for (let j = i; j < tk.length && n; j++) {
        n = n.next.get(tk[j].t);
        if (n?.symbol) best = { j, symbol: n.symbol };
      }
      if (best) {
        spans.push([tk[i].start, tk[best.j].end]);
        if (!symbols.includes(best.symbol)) symbols.push(best.symbol);
        i = best.j + 1;
      } else i++;
    }
    return { symbols, spans };
  }
}

export function blankSpans(text: string, spans: ReadonlyArray<[number, number]>): string {
  let out = text;
  for (const [s, e] of spans) out = out.slice(0, s) + ' '.repeat(e - s) + out.slice(e);
  return out;
}
```

- [ ] **Step 4: Run** → PASS; tsc → 174. If the `20k aliases` timing fails on a slow machine, do not loosen it beyond 5 ms — profile first.

- [ ] **Step 5: Commit** `feat(news-events): company-name aliases from EQUITY_L and a span-consuming name matcher` with explicit paths.

---

## Task A4: `tagArticle`, `NewsTaggerService`, `AliasLoaderService` (Stream A, after merging F2+F3)

**Files:**
- Create: `apps/api/src/modules/news-events/tagging/{tag-article.ts,tag-article.spec.ts,tagger.service.ts,tagger.service.spec.ts,alias-loader.service.ts,alias-loader.service.spec.ts}`
- Modify: `apps/api/src/modules/news/news.module.ts` (providers `NewsTaggerService`, `AliasLoaderService`)

**Interfaces:**
- Consumes: `NameMatcher`, `blankSpans`, `deriveAliases`, `parseEquityL`, `keywordTags`, `marketTags`, `sectorPhraseTags`, `FEED_SECTOR` (A2/A3); `extractSymbols` (legacy); `NewsSymbolIndexService.symbols()` (legacy); `SectorMapService`, `NseClient`, `NEWS_EVENTS_CONFIG`, `MCX_GROUP`, `MCX_UNDERLYINGS`, `TAG_VERSION` (F); `prisma.instrumentNameAlias`, `prisma.instrument` (F2/existing).
- Produces: `TagInput { title: string; summary: string; source: string; category: string; forceInstrument?: string }`; `tagArticle(a: TagInput, ctx: TagContext): ArticleTags`; `NewsTaggerService.tag(a: TagInput): Promise<{ tags: ArticleTags; version: number }>`, `.rebuild(rows: AliasRow[])`, `.ready`; `AliasLoaderService.refresh(): Promise<number>`, `.loadFromDb(): Promise<number>`.

- [ ] **Step 1: Write the failing tests** — `tag-article.spec.ts`:
```ts
import { tagArticle } from './tag-article';
import { NameMatcher } from './name-matcher';
import { deriveAliases } from './alias-derivation';

const ctx = {
  matcher: new NameMatcher(deriveAliases([
    { symbol: 'TATAMOTORS', name: 'Tata Motors Limited' },
    { symbol: 'SENCO', name: 'Senco Gold Limited' },
    { symbol: 'HINDZINC', name: 'Hindustan Zinc Limited' },
    { symbol: 'SBIN', name: 'State Bank of India' },
  ], {})),
  listed: new Set(['SBIN', 'TATAMOTORS', 'SENCO', 'HINDZINC', 'NMDC']),
  sectors: { sectorOf: (s: string) => ({ SBIN: 'NIFTY PSU BANK', TATAMOTORS: 'NIFTY AUTO' } as Record<string, string>)[s] ?? null },
};
const t = (title: string, source = 'ET', category = 'company', summary = '') => tagArticle({ title, summary, source, category }, ctx);

it('company by name, with its sector and no market tag for company news', () => {
  expect(t('Tata Motors recalls 10,000 cars')).toEqual({ instruments: ['TATAMOTORS'], sectors: ['NIFTY AUTO'], indices: [], markets: [] });
});
it('name span consumed: Senco Gold is SENCO, not GOLD; Hindustan Zinc is not ZINC', () => {
  expect(t('Senco Gold Q2 profit doubles').instruments).toEqual(['SENCO']);
  expect(t('Hindustan Zinc raises output').instruments).toEqual(['HINDZINC']);
});
it('tickers still work; commodity keyword adds the benchmark and its MCX group', () => {
  expect(t('NMDC raises iron ore prices').instruments).toEqual(['NMDC']);
  expect(t('Gold prices fall as dollar firms', 'ET Commodities', 'sector')).toEqual({ instruments: ['GOLD'], sectors: ['MCX BULLION'], indices: [], markets: [] });
});
it('index, feed sector, phrase sector and market tags', () => {
  expect(t('PSU banks lift Nifty; RBI keeps rates on hold', 'ET BFSI', 'indian')).toEqual({
    instruments: [], sectors: ['NIFTY BANK', 'NIFTY FIN SERVICE', 'NIFTY PSU BANK'], indices: ['NIFTY'], markets: ['IN'],
  });
});
it('forceInstrument (an NSE announcement\'s own symbol) is first and adds its sector', () => {
  expect(tagArticle({ title: 'Board meeting outcome', summary: '', source: 'NSE Announcements', category: 'company', forceInstrument: 'SBIN' }, ctx))
    .toEqual({ instruments: ['SBIN'], sectors: ['NIFTY PSU BANK'], indices: [], markets: [] });
});
it('an all-caps headline tags no company', () => {
  expect(t('TATA MOTORS RECALLS CARS ACROSS INDIA TODAY').instruments).toEqual([]);
});
```
`tagger.service.spec.ts`:
```ts
import { NewsTaggerService } from './tagger.service';
import { parseNewsEventsConfig } from '../config';

const cfg = parseNewsEventsConfig({ NEWS_EVENTS_V2_ENABLED: 'observe' });
const symbolIndex = { symbols: jest.fn().mockResolvedValue(new Set(['TATAMOTORS'])) };
const sectors = { sectorOf: () => null };

it('before aliases load: tickers/keywords only, version 0 (so the re-tag job fixes it later)', async () => {
  const s = new NewsTaggerService(cfg, symbolIndex as never, sectors as never, { instrument: { findMany: jest.fn().mockResolvedValue([]) } } as never);
  expect(s.ready).toBe(false);
  // The ticker rule still works; the company NAME cannot match yet.
  expect((await s.tag({ title: 'Tata Motors recalls cars', summary: '', source: 'ET', category: 'company' })).tags.instruments).toEqual([]);
  const r = await s.tag({ title: 'TATAMOTORS recalls cars', summary: '', source: 'ET', category: 'company' });
  expect(r).toEqual({ tags: expect.objectContaining({ instruments: ['TATAMOTORS'] }), version: 0 });
});

it('after rebuild: names match and the version is TAG_VERSION', async () => {
  const s = new NewsTaggerService(cfg, { symbols: jest.fn().mockResolvedValue(new Set()) } as never, sectors as never, { instrument: { findMany: jest.fn().mockResolvedValue([]) } } as never);
  s.rebuild([{ symbol: 'TATAMOTORS', alias: 'Tata Motors', kind: 'derived' }]);
  const r = await s.tag({ title: 'Tata Motors recalls cars', summary: '', source: 'ET', category: 'company' });
  expect(r).toEqual({ tags: expect.objectContaining({ instruments: ['TATAMOTORS'] }), version: 1 });
});

it('boot check names active MCX underlyings with no mapping', async () => {
  const warn = jest.fn();
  const prisma = { instrument: { findMany: jest.fn().mockResolvedValue([{ name: 'CRUDEOIL' }, { name: 'STEELREBAR' }]) } };
  const s = new NewsTaggerService(cfg, symbolIndex as never, sectors as never, prisma as never);
  (s as unknown as { logger: { warn: jest.Mock } }).logger.warn = warn;
  await s.checkMcxCoverage();
  expect(warn).toHaveBeenCalledWith('[news-tag] MCX underlying(s) without a news mapping: STEELREBAR');
});
```
`alias-loader.service.spec.ts`:
```ts
import { readFileSync } from 'fs';
import { join } from 'path';
import { AliasLoaderService, EQUITY_L_URL } from './alias-loader.service';
import { parseEquityL } from './alias-derivation';
import { parseNewsEventsConfig } from '../config';

const csv = 'SYMBOL,NAME OF COMPANY, SERIES\nTATAMOTORS,Tata Motors Limited,EQ\nINFY,Infosys Limited,EQ\n';

function harness(getText: jest.Mock) {
  const tx = { instrumentNameAlias: { deleteMany: jest.fn(), createMany: jest.fn() } };
  const prisma = {
    $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    instrumentNameAlias: { findMany: jest.fn().mockResolvedValue([{ symbol: 'X', alias: 'Xylo Corp', kind: 'derived' }]) },
  };
  const tagger = { rebuild: jest.fn() };
  const svc = new AliasLoaderService(parseNewsEventsConfig({ NEWS_EVENTS_V2_ENABLED: 'observe' }), { getText } as never, prisma as never, tagger as never);
  return { svc, tx, prisma, tagger };
}

it('refresh: EQUITY_L → aliases replaced in one transaction → matcher rebuilt', async () => {
  const getText = jest.fn().mockResolvedValue(csv);
  const { svc, tx, tagger } = harness(getText);
  await expect(svc.refresh()).resolves.toBeGreaterThan(2);
  expect(getText).toHaveBeenCalledWith('NSE EQUITY_L', EQUITY_L_URL);
  expect(tx.instrumentNameAlias.deleteMany).toHaveBeenCalledWith({ where: { source: { in: ['EQUITY_L', 'curated'] } } });
  expect(tx.instrumentNameAlias.createMany.mock.calls[0][0].data).toEqual(
    expect.arrayContaining([expect.objectContaining({ symbol: 'TATAMOTORS', alias: 'Tata Motors', kind: 'derived', source: 'EQUITY_L' })]),
  );
  expect(tagger.rebuild).toHaveBeenCalled();
});

it('a failed fetch keeps the table and the matcher; it falls back to the DB rows', async () => {
  const { svc, tx, tagger } = harness(jest.fn().mockRejectedValue(new Error('NSE EQUITY_L: HTTP 403')));
  await expect(svc.refresh()).resolves.toBe(0);
  expect(tx.instrumentNameAlias.deleteMany).not.toHaveBeenCalled();
  await expect(svc.loadFromDb()).resolves.toBe(1);
  expect(tagger.rebuild).toHaveBeenCalledWith([{ symbol: 'X', alias: 'Xylo Corp', kind: 'derived' }]);
});

it('the captured fixture parses (when M0 captured it)', () => {
  const p = join(__dirname, '..', '__fixtures__', 'equity-l.csv');
  let text: string | null = null;
  try { text = readFileSync(p, 'utf8'); } catch { /* not captured on this machine */ }
  if (text) expect(parseEquityL(text).length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run** `npx jest src/modules/news-events/tagging --ci --maxWorkers=2` → FAIL.

- [ ] **Step 3: Implement** — `tag-article.ts`:
```ts
import { extractSymbols } from '../../news/services/extract-symbols';
import { MCX_GROUP } from '../keys';
import type { ArticleTags, SectorLookup } from '../types';
import { keywordTags } from './commodity-index-keywords';
import { FEED_SECTOR, marketTags, sectorPhraseTags } from './market-sector-rules';
import { blankSpans, type NameMatcher } from './name-matcher';

export interface TagInput { title: string; summary: string; source: string; category: string; forceInstrument?: string }
export interface TagContext { matcher: NameMatcher; listed: ReadonlySet<string>; sectors: SectorLookup }

const uniq = (xs: Array<string | null | undefined>) => [...new Set(xs.filter((x): x is string => !!x))];

/** Spec §5: the four tag sets, computed ONCE at ingestion. Pure. */
export function tagArticle(a: TagInput, ctx: TagContext): ArticleTags {
  const text = `${a.title ?? ''} ${a.summary ?? ''}`;
  const names = ctx.matcher.match(text);
  const rest = blankSpans(text, names.spans);
  const tickers = extractSymbols(a.title, a.summary, ctx.listed);
  const kw = keywordTags(rest);
  const companies = uniq([a.forceInstrument, ...names.symbols, ...tickers]);
  return {
    instruments: uniq([...companies, ...kw.commodities]),
    sectors: uniq([
      ...companies.map((s) => ctx.sectors.sectorOf(s)),
      ...(FEED_SECTOR[a.source] ?? []),
      ...sectorPhraseTags(rest),
      ...kw.commodities.map((c) => MCX_GROUP[c]),
    ]),
    indices: kw.indices,
    markets: marketTags(a.category, rest),
  };
}
```
`tagger.service.ts`:
```ts
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { bootJobsEnabled } from '../../../common/utils/boot-jobs';
import { NewsSymbolIndexService } from '../../news/services/news-symbol-index.service';
import { NEWS_EVENTS_CONFIG, TAG_VERSION, type NewsEventsConfig } from '../config';
import { MCX_UNDERLYINGS } from '../keys';
import { SectorMapService } from '../sector-map.service';
import type { ArticleTags } from '../types';
import type { AliasRow } from './alias-derivation';
import { NameMatcher } from './name-matcher';
import { tagArticle, type TagInput } from './tag-article';

/** Holds the compiled matcher; `tag` is CPU-only except the cached listed-symbol set. */
@Injectable()
export class NewsTaggerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(NewsTaggerService.name);
  private matcher = new NameMatcher([]);
  private loaded = false;

  constructor(
    @Inject(NEWS_EVENTS_CONFIG) private readonly cfg: NewsEventsConfig,
    private readonly symbolIndex: NewsSymbolIndexService,
    private readonly sectors: SectorMapService,
    private readonly prisma: PrismaService,
  ) {}

  get ready(): boolean {
    return this.loaded;
  }

  onApplicationBootstrap(): void {
    if (this.cfg.computing && bootJobsEnabled()) void this.checkMcxCoverage();
  }

  rebuild(rows: AliasRow[]): void {
    this.matcher = new NameMatcher(rows);
    this.loaded = rows.length > 0;
    this.logger.log(`[news-tag] name matcher: ${this.matcher.size} aliases (~${Math.round(this.matcher.approxBytes() / 1024)} KB)`);
  }

  async tag(a: TagInput): Promise<{ tags: ArticleTags; version: number }> {
    const listed = await this.symbolIndex.symbols();
    return { tags: tagArticle(a, { matcher: this.matcher, listed, sectors: this.sectors }), version: this.loaded ? TAG_VERSION : 0 };
  }

  async checkMcxCoverage(): Promise<void> {
    try {
      const rows = await this.prisma.instrument.findMany({
        where: { exchange: 'MCX', isActive: true, OR: [{ expiry: null }, { expiry: { gte: new Date() } }] },
        select: { name: true },
        distinct: ['name'],
      });
      const missing = rows.map((r) => r.name.toUpperCase()).filter((n) => !MCX_UNDERLYINGS.includes(n)).sort();
      if (missing.length > 0) this.logger.warn(`[news-tag] MCX underlying(s) without a news mapping: ${missing.join(', ')}`);
    } catch (err) {
      this.logger.warn(`[news-tag] MCX coverage check failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
```
`alias-loader.service.ts`:
```ts
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { bootJobsEnabled } from '../../../common/utils/boot-jobs';
import { NEWS_EVENTS_CONFIG, type NewsEventsConfig } from '../config';
import { NseClient } from '../nse-client';
import { deriveAliases, parseEquityL, type AliasRow } from './alias-derivation';
import { NewsTaggerService } from './tagger.service';

export const EQUITY_L_URL = 'https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv';

/**
 * EQUITY_L.csv → instrument_name_aliases → the tagger's matcher (spec §5.2). Boot loads
 * the table (no network unless it is empty); 08:05 IST Mon–Fri refreshes from NSE.
 * A failed refresh leaves the table and the matcher exactly as they were.
 */
@Injectable()
export class AliasLoaderService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AliasLoaderService.name);

  constructor(
    @Inject(NEWS_EVENTS_CONFIG) private readonly cfg: NewsEventsConfig,
    private readonly nse: NseClient,
    private readonly prisma: PrismaService,
    private readonly tagger: NewsTaggerService,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.cfg.computing || !bootJobsEnabled()) return;
    void this.loadFromDb().then((n) => (n === 0 ? this.refresh() : n));
  }

  @Cron('0 5 8 * * 1-5', { timeZone: 'Asia/Kolkata' })
  async daily(): Promise<void> {
    if (this.cfg.computing) await this.refresh();
  }

  async loadFromDb(): Promise<number> {
    const rows = (await this.prisma.instrumentNameAlias.findMany({ select: { symbol: true, alias: true, kind: true } })) as AliasRow[];
    if (rows.length > 0) this.tagger.rebuild(rows);
    return rows.length;
  }

  async refresh(): Promise<number> {
    let rows: AliasRow[];
    try {
      rows = deriveAliases(parseEquityL(await this.nse.getText('NSE EQUITY_L', EQUITY_L_URL)));
    } catch (err) {
      this.logger.warn(`[news-tag] alias refresh failed, keeping the stored aliases: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.instrumentNameAlias.deleteMany({ where: { source: { in: ['EQUITY_L', 'curated'] } } });
      await tx.instrumentNameAlias.createMany({
        data: rows.map((r) => ({ ...r, source: r.kind === 'curated' ? 'curated' : 'EQUITY_L', updatedAt: now })),
        skipDuplicates: true,
      });
    });
    this.tagger.rebuild(rows);
    this.logger.log(`[news-tag] aliases refreshed from EQUITY_L: ${rows.length}`);
    return rows.length;
  }
}
```
`news.module.ts`: add `NewsTaggerService`, `AliasLoaderService` to `providers` and `NewsTaggerService` to `exports`.

- [ ] **Step 4: Run** `npx jest src/modules/news-events src/modules/news --ci --maxWorkers=2` → PASS; tsc → 174.

- [ ] **Step 5: Commit** `feat(news-events): tag-once tagger (names, tickers, keywords, sectors, markets) and the EQUITY_L alias loader`.

---

## Task A5: Tag-once at ingestion, push to the index, boot re-tag (Stream A)

**Files:**
- Modify: `apps/api/src/modules/news/services/news-aggregator.service.ts`, `news-aggregator.service.spec.ts`, `apps/api/src/modules/news/news.module.ts`
- Create: `apps/api/src/modules/news-events/ingest/{retag.service.ts,retag.service.spec.ts}`

**Interfaces:**
- Consumes: `NewsTaggerService.tag` (A4); `NEWS_INGEST_BUS`, `toIndexedArticle`, `TAG_VERSION` (F1).
- Produces: every new `news_articles` row (flag `observe|true`) carries `instruments/sectors/indices/markets/tagVersion/dateInferred` and is published on the bus right after its insert; `RetagService.run(now): Promise<number>`.

- [ ] **Step 1: Write the failing tests.** Extend `harness()` in `news-aggregator.service.spec.ts` with a tagger `{ tag: jest.fn().mockResolvedValue({ tags: { instruments: ['GOLD'], sectors: ['MCX BULLION'], indices: [], markets: [] }, version: 1 }) }` and a bus `{ publish: jest.fn(), subscribe: jest.fn() }` passed as the 6th/7th constructor arguments, then add:
```ts
  it('observe: v2 columns written and the row is published once, right after its insert', async () => {
    const { svc, created, bus } = harness('observe', { 'https://a.test/rss': rss(item('Gold rises', 'https://a.test/1', 'Thu, 16 Oct 2026 04:00:00 GMT')) });
    await svc.fetchAllNews();
    expect(created[0]).toMatchObject({ instruments: ['GOLD'], sectors: ['MCX BULLION'], indices: [], markets: [], tagVersion: 1, dateInferred: false });
    expect(created[0].relatedSymbols).toEqual([]); // legacy tagging untouched (sentiment fake returns [])
    expect(bus.publish).toHaveBeenCalledTimes(1);
    expect(bus.publish.mock.calls[0][0][0]).toMatchObject({ id: 'id1', tags: { instruments: ['GOLD'] } });
  });

  it('false: the tagger and the bus are never touched', async () => {
    const { svc, tagger, bus } = harness('false', { 'https://a.test/rss': rss(item('Gold rises', 'https://a.test/1')) });
    await svc.fetchAllNews();
    expect(tagger.tag).not.toHaveBeenCalled();
    expect(bus.publish).not.toHaveBeenCalled();
  });

  it('a tagger failure still saves the article (untagged, tagVersion 0) and publishes it', async () => {
    const { svc, created, tagger } = harness('observe', { 'https://a.test/rss': rss(item('Gold rises', 'https://a.test/1')) });
    tagger.tag.mockRejectedValueOnce(new Error('boom'));
    await svc.fetchAllNews();
    expect(created[0]).toMatchObject({ instruments: [], tagVersion: 0 });
  });
```
`ingest/retag.service.spec.ts`:
```ts
import { RetagService } from './retag.service';
import { parseNewsEventsConfig } from '../config';

it('re-tags rows of the last 48 h below TAG_VERSION, in pages, and republishes them', async () => {
  const now = new Date('2026-10-16T05:00:00Z');
  const row = (id: string) => ({ id, title: `t${id}`, summary: '', source: 'ET', category: 'company', sentiment: null, publishedAt: now, fetchedAt: now, dateInferred: false });
  const prisma = {
    newsArticle: {
      findMany: jest.fn().mockResolvedValueOnce([row('a'), row('b')]).mockResolvedValueOnce([]),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({ ...row(where.id), ...data })),
    },
  };
  const tagger = { ready: true, tag: jest.fn().mockResolvedValue({ tags: { instruments: ['X'], sectors: [], indices: [], markets: [] }, version: 1 }) };
  const bus = { publish: jest.fn() };
  const svc = new RetagService(parseNewsEventsConfig({ NEWS_EVENTS_V2_ENABLED: 'observe' }), prisma as never, tagger as never, bus as never);
  await expect(svc.run(now)).resolves.toBe(2);
  expect(prisma.newsArticle.findMany.mock.calls[0][0].where).toEqual({
    publishedAt: { gte: new Date('2026-10-14T05:00:00Z') }, tagVersion: { lt: 1 },
  });
  expect(prisma.newsArticle.update).toHaveBeenCalledTimes(2);
  expect(bus.publish).toHaveBeenCalledTimes(1);
  expect(bus.publish.mock.calls[0][0].map((a: { id: string }) => a.id)).toEqual(['a', 'b']);
});

it('does nothing while the tagger has no aliases (it would only re-stamp version 0)', async () => {
  const prisma = { newsArticle: { findMany: jest.fn() } };
  const svc = new RetagService(parseNewsEventsConfig({ NEWS_EVENTS_V2_ENABLED: 'true' }), prisma as never, { ready: false } as never, { publish: jest.fn() } as never);
  await expect(svc.run(new Date())).resolves.toBe(0);
  expect(prisma.newsArticle.findMany).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement.** Aggregator constructor gains (after `cfg`): `@Optional() private readonly tagger?: NewsTaggerService`, `@Optional() @Inject(NEWS_INGEST_BUS) private readonly bus?: NewsIngestBus`. In the save loop, when `this.cfg?.computing`:
```ts
        let v2: { tags: ArticleTags; version: number } = { tags: { instruments: [], sectors: [], indices: [], markets: [] }, version: 0 };
        if (this.tagger) {
          try {
            v2 = await this.tagger.tag({ title: article.title, summary: article.summary, source: article.source, category: article.category });
          } catch (err) {
            this.logger.warn(`[news-tag] tagging failed for "${article.title.slice(0, 60)}": ${err instanceof Error ? err.message : String(err)}`);
          }
        }
```
and the `create` data spreads `...(this.cfg?.computing ? { dateInferred: article.guard.dateInferred, instruments: v2.tags.instruments, sectors: v2.tags.sectors, indices: v2.tags.indices, markets: v2.tags.markets, tagVersion: v2.version } : {})`. After a successful `create` (inside the `try`): `if (this.cfg?.computing) this.bus?.publish([toIndexedArticle(saved)]);` where `saved` is the `create` result (it includes `id` and `fetchedAt`). The legacy branch (`computing` false) is byte-for-byte today's code path.

`ingest/retag.service.ts`:
```ts
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { bootJobsEnabled } from '../../../common/utils/boot-jobs';
import { NEWS_EVENTS_CONFIG, TAG_VERSION, type NewsEventsConfig } from '../config';
import { NEWS_INGEST_BUS, type NewsIngestBus } from '../ingest-bus';
import { toIndexedArticle } from '../keys';
import { NewsTaggerService } from '../tagging/tagger.service';
import type { IndexedArticle } from '../types';

export const RETAG_WINDOW_MS = 48 * 3_600_000;
const PAGE = 200;

/** Spec §5.6: on boot, re-tag the last 48 h with the current matcher version (waits up to 2 min for aliases). */
@Injectable()
export class RetagService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RetagService.name);

  constructor(
    @Inject(NEWS_EVENTS_CONFIG) private readonly cfg: NewsEventsConfig,
    private readonly prisma: PrismaService,
    private readonly tagger: NewsTaggerService,
    @Inject(NEWS_INGEST_BUS) private readonly bus: NewsIngestBus,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.cfg.computing || !bootJobsEnabled()) return;
    const started = Date.now();
    const timer = setInterval(() => {
      if (this.tagger.ready || Date.now() - started > 120_000) {
        clearInterval(timer);
        void this.run(new Date()).catch((err) => this.logger.warn(`[news-tag] re-tag failed: ${err instanceof Error ? err.message : String(err)}`));
      }
    }, 5_000);
    timer.unref?.();
  }

  async run(now: Date): Promise<number> {
    if (!this.tagger.ready) return 0;
    let done = 0;
    for (;;) {
      const rows = await this.prisma.newsArticle.findMany({
        where: { publishedAt: { gte: new Date(now.getTime() - RETAG_WINDOW_MS) }, tagVersion: { lt: TAG_VERSION } },
        select: { id: true, title: true, summary: true, source: true, category: true, sentiment: true, publishedAt: true, fetchedAt: true, dateInferred: true },
        orderBy: { publishedAt: 'asc' },
        take: PAGE,
      });
      if (rows.length === 0) break;
      const out: IndexedArticle[] = [];
      for (const r of rows) {
        const { tags, version } = await this.tagger.tag({ title: r.title, summary: r.summary ?? '', source: r.source, category: r.category });
        const saved = await this.prisma.newsArticle.update({ where: { id: r.id }, data: { ...tags, tagVersion: Math.max(version, TAG_VERSION) } });
        out.push(toIndexedArticle(saved));
      }
      this.bus.publish(out);
      done += rows.length;
    }
    if (done > 0) this.logger.log(`[news-tag] re-tagged ${done} article(s) from the last 48 h to v${TAG_VERSION}`);
    return done;
  }
}
```
(`tagVersion: Math.max(version, TAG_VERSION)` stops a row from looping forever if the matcher reports version 0 mid-run; the loop terminates because every page is stamped.) Register `RetagService` in `news.module.ts` providers.

- [ ] **Step 4: Run** `npx jest src/modules/news src/modules/news-events --ci --maxWorkers=2` → PASS; tsc → 174.

- [ ] **Step 5: Commit** `feat(news-events): tag once at ingestion, push each saved article to the index bus, boot re-tag of 48 h`.

---

## Task A6: NSE corporate announcements (Stream A)

**Files:**
- Create: `apps/api/src/modules/news-events/ingest/{nse-announcements.ts,nse-announcements.spec.ts,nse-announcements.service.ts,nse-announcements.service.spec.ts}`
- Create (if M0 could not capture): `apps/api/src/modules/news-events/__fixtures__/nse-announcements.json` with the documented shape below
- Modify: `apps/api/src/modules/news/news.module.ts` (provider)

**Interfaces:**
- Consumes: `NseClient`, `SourceHealthBook`, `NEWS_INGEST_BUS`, `toIndexedArticle`, `NSE_ANN_OFFHOURS_MIN` (F); `NewsTaggerService.tag` with `forceInstrument` (A4); `NewsSentimentService.analyzeSentiment` (legacy); `SessionClock`, `MARKET_HOLIDAYS`, `istMinutes`, `istDateTimeToIso` (existing).
- Produces: `parseAnnouncements(json): ParsedAnnouncement[]`, `announcementsDue(now, lastRunAt, cadenceMin, isTradingDay): boolean`, `NseAnnouncementsService.runOnce(now): Promise<number>`.

The documented row shape (`GET https://www.nseindia.com/api/corporate-announcements?index=equities` returns an array; the M0 fixture wins if it differs):
```json
[{ "symbol": "TATAMOTORS", "desc": "Outcome of Board Meeting", "dt": "16102026100512", "attchmntFile": "https://nsearchives.nseindia.com/corporate/TATAMOTORS_16102026100512_outcome.pdf", "sm_name": "Tata Motors Limited", "an_dt": "16-Oct-2026 10:05:12", "sort_date": "2026-10-16 10:05:12", "attchmntText": "Tata Motors has informed the Exchange about the outcome of the board meeting held on October 16, 2026" }]
```

- [ ] **Step 1: Write the failing tests** — `nse-announcements.spec.ts`:
```ts
import { announcementsDue, parseAnnouncements } from './nse-announcements';

const row = {
  symbol: 'TATAMOTORS', desc: 'Outcome of Board Meeting', attchmntFile: 'https://nsearchives.nseindia.com/corporate/a.pdf',
  sm_name: 'Tata Motors Limited', an_dt: '16-Oct-2026 10:05:12', sort_date: '2026-10-16 10:05:12',
  attchmntText: 'Tata Motors has informed the Exchange about the outcome of the board meeting',
};

it('maps a row to an article: title, summary, url, IST time, exchange symbol', () => {
  expect(parseAnnouncements([row])).toEqual([{
    symbol: 'TATAMOTORS',
    title: 'TATAMOTORS: Outcome of Board Meeting — Tata Motors has informed the Exchange about the outcome of the board meeting',
    summary: 'Tata Motors has informed the Exchange about the outcome of the board meeting',
    url: 'https://nsearchives.nseindia.com/corporate/a.pdf',
    publishedAt: new Date('2026-10-16T04:35:12.000Z'),
    dateInferred: false,
  }]);
});

it('accepts {data:[…]}, skips rows without a symbol, synthesises a stable url, flags a missing date', () => {
  const out = parseAnnouncements({ data: [{ ...row, attchmntFile: '', an_dt: '', sort_date: '' }, { desc: 'x' }] });
  expect(out).toHaveLength(1);
  expect(out[0].url).toMatch(/^https:\/\/www\.nseindia\.com\/companies-listing\/corporate-filings-announcements#TATAMOTORS-[0-9a-f]{12}$/);
  expect(out[0].dateInferred).toBe(true);
  const again = parseAnnouncements({ data: [{ ...row, attchmntFile: '', an_dt: '', sort_date: '' }] });
  expect(again[0].url).toBe(out[0].url); // stable across polls ⇒ the url-unique dedupe holds
});

it('a non-array, non-{data} body is an error (counted as a failure, never "0 announcements")', () => {
  expect(() => parseAnnouncements('<html>')).toThrow(/not an announcements list/);
});

it('titles are capped at 300 chars', () => {
  expect(parseAnnouncements([{ ...row, attchmntText: 'x'.repeat(1000) }])[0].title.length).toBeLessThanOrEqual(300);
});

describe('announcementsDue (N3: 3 min 09:00–17:30 on NSE trading days, 15 min 07:00–22:00 otherwise)', () => {
  const ist = (hhmm: string, day = '2026-10-16') => new Date(`${day}T${hhmm}:00+05:30`);
  it.each([
    ['09:30', null, true, true],
    ['09:30', '09:28', true, false],
    ['09:30', '09:27', true, true],
    ['18:00', '17:50', true, false],
    ['18:00', '17:45', true, true],
    ['06:30', null, true, false],
    ['22:30', null, true, false],
    ['10:00', '09:50', false, false], // a holiday: 15-min cadence
    ['10:00', '09:45', false, true],
  ])('%s last=%s tradingDay=%s → %s', (now, last, trading, want) => {
    expect(announcementsDue(ist(now), last ? ist(last) : null, 3, trading as boolean)).toBe(want);
  });
});
```
`nse-announcements.service.spec.ts`:
```ts
import { NseAnnouncementsService } from './nse-announcements.service';
import { SourceHealthBook } from '../source-health';
import { parseNewsEventsConfig } from '../config';

const row = { symbol: 'SBIN', desc: 'Press Release', attchmntFile: 'https://nsearchives.nseindia.com/corporate/s.pdf', an_dt: '16-Oct-2026 10:05:12', attchmntText: 'SBI raises funds' };

function harness(getJson: jest.Mock, existing: string[] = []) {
  const created: Array<Record<string, unknown>> = [];
  const prisma = {
    newsArticle: {
      findMany: jest.fn().mockResolvedValue(existing.map((url) => ({ url }))),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return { id: 'n1', fetchedAt: new Date(), ...data };
      }),
    },
  };
  const tagger = { tag: jest.fn().mockResolvedValue({ tags: { instruments: ['SBIN'], sectors: ['NIFTY PSU BANK'], indices: [], markets: [] }, version: 1 }) };
  const sentiment = { analyzeSentiment: jest.fn().mockResolvedValue({ sentiment: 'bullish', score: 0.4, relatedSymbols: ['SBIN', 'GOLD'] }) };
  const bus = { publish: jest.fn() };
  const health = new SourceHealthBook();
  const svc = new NseAnnouncementsService(parseNewsEventsConfig({ NEWS_EVENTS_V2_ENABLED: 'observe' }), { getJson } as never, prisma as never, tagger as never, sentiment as never, bus as never, health);
  return { svc, created, tagger, bus, health };
}

it('new announcements are saved with relatedSymbols [] (legacy readers unaffected), v2 tags forced to the symbol, and published', async () => {
  const { svc, created, tagger, bus, health } = harness(jest.fn().mockResolvedValue([row]));
  await expect(svc.runOnce(new Date('2026-10-16T05:00:00Z'))).resolves.toBe(1);
  expect(tagger.tag).toHaveBeenCalledWith(expect.objectContaining({ forceInstrument: 'SBIN', source: 'NSE Announcements', category: 'company' }));
  expect(created[0]).toMatchObject({ source: 'NSE Announcements', category: 'company', relatedSymbols: [], instruments: ['SBIN'], sentiment: 'bullish', tagVersion: 1 });
  expect(bus.publish).toHaveBeenCalledTimes(1);
  expect(health.all()[0]).toMatchObject({ source: 'NSE Announcements', consecutiveFailures: 0, itemsLastFetch: 1 });
});

it('already-stored urls are skipped', async () => {
  const { svc, created } = harness(jest.fn().mockResolvedValue([row]), [row.attchmntFile]);
  await expect(svc.runOnce(new Date())).resolves.toBe(0);
  expect(created).toHaveLength(0);
});

it('an NSE failure is a source failure, not an empty fetch', async () => {
  const { svc, health } = harness(jest.fn().mockRejectedValue(new Error('NSE corporate-announcements: response was not JSON (<html>…)')));
  await expect(svc.runOnce(new Date())).resolves.toBe(0);
  expect(health.all()[0]).toMatchObject({ source: 'NSE Announcements', consecutiveFailures: 1, lastError: expect.stringMatching(/not JSON/) });
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** — `ingest/nse-announcements.ts`:
```ts
import { createHash } from 'crypto';
import { istDateTimeToIso, istMinutes } from '../../market-cues/fetchers/ist-dates';
import { NSE_ANN_OFFHOURS_MIN } from '../config';

export const NSE_ANNOUNCEMENTS_URL = 'https://www.nseindia.com/api/corporate-announcements?index=equities';
const TITLE_CAP = 300;

export interface ParsedAnnouncement { symbol: string; title: string; summary: string; url: string; publishedAt: Date | null; dateInferred: boolean }

function str(v: unknown): string {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
}

function when(r: Record<string, unknown>): Date | null {
  const a = istDateTimeToIso(str(r.an_dt));
  if (a) return new Date(a);
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)$/.exec(str(r.sort_date));
  return m ? new Date(`${m[1]}T${m[2].length === 5 ? `${m[2]}:00` : m[2]}+05:30`) : null;
}

/** Spec §4.2. Throws on a body that is not a list — the caller records that as a source failure. */
export function parseAnnouncements(json: unknown): ParsedAnnouncement[] {
  const rows = Array.isArray(json) ? json : Array.isArray((json as { data?: unknown })?.data) ? (json as { data: unknown[] }).data : null;
  if (!rows) throw new Error('response is not an announcements list');
  const out: ParsedAnnouncement[] = [];
  for (const raw of rows) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const symbol = str(r.symbol).toUpperCase();
    const desc = str(r.desc);
    if (!symbol || !desc) continue;
    const text = str(r.attchmntText);
    const full = text ? `${symbol}: ${desc} — ${text}` : `${symbol}: ${desc}`;
    const title = full.length > TITLE_CAP ? `${full.slice(0, TITLE_CAP - 1)}…` : full;
    const at = when(r);
    const file = str(r.attchmntFile);
    const url = file || `https://www.nseindia.com/companies-listing/corporate-filings-announcements#${symbol}-${createHash('sha1').update(`${symbol}|${desc}|${text}|${str(r.sort_date)}`).digest('hex').slice(0, 12)}`;
    out.push({ symbol, title, summary: text.slice(0, 500), url, publishedAt: at, dateInferred: at === null });
  }
  return out;
}

export function announcementsDue(now: Date, lastRunAt: Date | null, cadenceMin: number, isTradingDay: boolean): boolean {
  const m = istMinutes(now);
  const inSession = isTradingDay && m >= 9 * 60 && m <= 17 * 60 + 30;
  const inOffHours = m >= 7 * 60 && m <= 22 * 60;
  if (!inSession && !inOffHours) return false;
  const every = (inSession ? cadenceMin : NSE_ANN_OFFHOURS_MIN) * 60_000;
  return lastRunAt === null || now.getTime() - lastRunAt.getTime() >= every - 5_000;
}
```
`ingest/nse-announcements.service.ts`:
```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { bootJobsEnabled } from '../../../common/utils/boot-jobs';
import { MARKET_HOLIDAYS } from '../../market-data/services/market-holidays.service';
import { SessionClock } from '../../market-hub/session-clock';
import { NewsSentimentService } from '../../news/services/news-sentiment.service';
import { NEWS_EVENTS_CONFIG, type NewsEventsConfig } from '../config';
import { NEWS_INGEST_BUS, type NewsIngestBus } from '../ingest-bus';
import { toIndexedArticle } from '../keys';
import { NseClient } from '../nse-client';
import { SourceHealthBook } from '../source-health';
import { NewsTaggerService } from '../tagging/tagger.service';
import { announcementsDue, NSE_ANNOUNCEMENTS_URL, parseAnnouncements } from './nse-announcements';

export const NSE_ANN_SOURCE = 'NSE Announcements';

@Injectable()
export class NseAnnouncementsService {
  private readonly logger = new Logger(NseAnnouncementsService.name);
  private readonly clock = new SessionClock({ holidays: MARKET_HOLIDAYS });
  private lastRunAt: Date | null = null;
  private running = false;

  constructor(
    @Inject(NEWS_EVENTS_CONFIG) private readonly cfg: NewsEventsConfig,
    private readonly nse: NseClient,
    private readonly prisma: PrismaService,
    private readonly tagger: NewsTaggerService,
    private readonly sentiment: NewsSentimentService,
    @Inject(NEWS_INGEST_BUS) private readonly bus: NewsIngestBus,
    private readonly health: SourceHealthBook,
  ) {}

  @Cron('0 * * * * *', { timeZone: 'Asia/Kolkata' })
  async tick(): Promise<void> {
    const now = new Date();
    if (!this.cfg.computing || !bootJobsEnabled() || this.running) return;
    if (!announcementsDue(now, this.lastRunAt, this.cfg.nseAnnCadenceMin, this.clock.isTradingDay('NSE', now))) return;
    this.running = true;
    this.lastRunAt = now;
    try {
      await this.runOnce(now);
    } finally {
      this.running = false;
    }
  }

  async runOnce(now: Date): Promise<number> {
    let parsed;
    try {
      parsed = parseAnnouncements(await this.nse.getJson('NSE corporate-announcements', NSE_ANNOUNCEMENTS_URL));
      this.health.ok(NSE_ANN_SOURCE, parsed.length, now);
    } catch (err) {
      this.health.fail(NSE_ANN_SOURCE, err instanceof Error ? err.message : String(err), now);
      return 0;
    }
    if (parsed.length === 0) return 0;
    const existing = new Set((await this.prisma.newsArticle.findMany({ where: { url: { in: parsed.map((p) => p.url) } }, select: { url: true } })).map((e) => e.url));
    let saved = 0;
    for (const a of parsed.filter((p) => !existing.has(p.url))) {
      try {
        const s = await this.sentiment.analyzeSentiment(a.title, a.summary);
        const { tags, version } = await this.tagger.tag({ title: a.title, summary: a.summary, source: NSE_ANN_SOURCE, category: 'company', forceInstrument: a.symbol });
        const row = await this.prisma.newsArticle.create({
          data: {
            title: a.title, summary: a.summary || null, source: NSE_ANN_SOURCE, url: a.url, category: 'company',
            sentiment: s.sentiment, sentimentScore: s.score,
            relatedSymbols: [], // plan "differs" 1: legacy readers never see v2-only rows
            publishedAt: a.publishedAt ?? now, dateInferred: a.dateInferred,
            instruments: tags.instruments, sectors: tags.sectors, indices: tags.indices, markets: tags.markets, tagVersion: version,
          },
        });
        this.bus.publish([toIndexedArticle(row)]);
        saved++;
      } catch (err) {
        this.logger.debug(`[news-ann] skipped ${a.symbol}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (saved > 0) this.logger.log(`[news-ann] ${saved} new NSE announcement(s)`);
    return saved;
  }
}
```
Register `NseAnnouncementsService` in `news.module.ts`.

- [ ] **Step 4: Run** `npx jest src/modules/news-events src/modules/news --ci --maxWorkers=2` → PASS; tsc → 174.

- [ ] **Step 5: Commit** `feat(news-events): NSE corporate announcements every 3 min in session under the polite client`.

---

## Task B1: `NewsIndex` — the bounded in-memory structure (Stream B)

**Files:**
- Create: `apps/api/src/modules/news-events/index/{news-index.ts,news-index.spec.ts}`

**Interfaces:**
- Consumes: `IndexedArticle`, `keysOfTags` (F1).
- Produces: `class NewsIndex { constructor(o: { horizonMs: number; maxItems: number; maxPerKey: number }); upsert(a: IndexedArticle, now: number): 'added' | 'updated' | 'ignored'; prune(now: number): number; list(key: string, sinceMs: number): readonly IndexedArticle[]; has(id: string): boolean; readonly size: number; readonly keyCount: number; newestFetchedAt(): number | null; approxBytes(): number }`.

- [ ] **Step 0: Worktree.** `git worktree add .claude/worktrees/ne-index -b feature/ne-index <F1 commit>`; junctions; `prisma generate`; tsc → 174.

- [ ] **Step 1: Write the failing test** — `index/news-index.spec.ts`:
```ts
import { NewsIndex } from './news-index';
import { article } from '../testing';

const NOW = Date.UTC(2026, 9, 16, 6, 0);
const H = 3_600_000;
const mk = (o: { horizonMs?: number; maxItems?: number; maxPerKey?: number } = {}) =>
  new NewsIndex({ horizonMs: o.horizonMs ?? 24 * H, maxItems: o.maxItems ?? 5000, maxPerKey: o.maxPerKey ?? 50 });
const tagged = (id: string, minsAgo: number, instruments: string[], markets: Array<'IN' | 'GLOBAL'> = []) =>
  article({ id, publishedAt: NOW - minsAgo * 60_000, fetchedAt: NOW - minsAgo * 60_000, tags: { instruments, sectors: [], indices: [], markets } });

describe('NewsIndex', () => {
  it('lists newest-first per key, within a window', () => {
    const ix = mk();
    ix.upsert(tagged('old', 400, ['SBIN']), NOW);
    ix.upsert(tagged('new', 5, ['SBIN']), NOW);
    ix.upsert(tagged('mid', 60, ['SBIN']), NOW);
    expect(ix.list('I:SBIN', NOW - 6 * H).map((a) => a.id)).toEqual(['new', 'mid']);
    expect(ix.list('I:SBIN', 0).map((a) => a.id)).toEqual(['new', 'mid', 'old']);
    expect(ix.list('I:NOPE', 0)).toEqual([]);
  });

  it('added / updated / ignored: re-publishing an id re-keys it and reports "updated"', () => {
    const ix = mk();
    expect(ix.upsert(tagged('a', 1, ['SBIN']), NOW)).toBe('added');
    expect(ix.upsert(tagged('a', 1, ['TCS']), NOW)).toBe('updated');
    expect(ix.list('I:SBIN', 0)).toEqual([]);
    expect(ix.list('I:TCS', 0).map((a) => a.id)).toEqual(['a']);
    expect(ix.upsert(tagged('untagged', 1, []), NOW)).toBe('ignored');
    expect(ix.upsert(tagged('ancient', 25 * 60, ['SBIN']), NOW)).toBe('ignored');
    expect(ix.has('untagged')).toBe(false);
  });

  it('≤ 50 ids per key; an article dropped from its only key leaves the index, one with another key stays', () => {
    const ix = mk();
    ix.upsert(tagged('shared', 120, ['SBIN'], ['IN']), NOW);
    for (let i = 0; i < 60; i++) ix.upsert(tagged(`s${i}`, i, ['SBIN']), NOW);
    expect(ix.list('I:SBIN', 0)).toHaveLength(50);
    expect(ix.has('s59')).toBe(false);
    expect(ix.has('shared')).toBe(true);
    expect(ix.list('M:IN', 0).map((a) => a.id)).toEqual(['shared']);
  });

  it('≤ maxItems in total, oldest evicted first', () => {
    const ix = mk({ maxItems: 100 });
    for (let i = 0; i < 150; i++) ix.upsert(tagged(`k${i}`, i, [`SYM${i}`]), NOW);
    expect(ix.size).toBeLessThanOrEqual(100);
    expect(ix.has('k0')).toBe(true);
    expect(ix.has('k149')).toBe(false);
  });

  it('prune drops everything older than the horizon', () => {
    const ix = mk({ horizonMs: 2 * H });
    ix.upsert(tagged('a', 30, ['SBIN']), NOW);
    ix.upsert(tagged('b', 90, ['SBIN']), NOW);
    expect(ix.prune(NOW + H)).toBe(1);
    expect(ix.list('I:SBIN', 0).map((a) => a.id)).toEqual(['a']);
    expect(ix.keyCount).toBe(1);
  });

  it('newestFetchedAt tracks the max', () => {
    const ix = mk();
    ix.upsert(tagged('a', 30, ['SBIN']), NOW);
    ix.upsert(tagged('b', 10, ['TCS']), NOW);
    expect(ix.newestFetchedAt()).toBe(NOW - 10 * 60_000);
  });

  it('memory ceiling (spec §6): 5,000 items, 160-char titles, 6 tags each ≤ 5 MB', () => {
    const ix = mk();
    for (let i = 0; i < 5000; i++) {
      ix.upsert(article({
        id: `c${String(i).padStart(24, '0')}`, title: 'x'.repeat(160), source: 'Economic Times Markets',
        publishedAt: NOW - (i % 1400) * 60_000, fetchedAt: NOW,
        tags: { instruments: [`SYM${i % 900}`, 'CRUDEOIL'], sectors: ['NIFTY BANK'], indices: ['NIFTY'], markets: ['IN', 'GLOBAL'] },
      }), NOW);
    }
    expect(ix.size).toBeLessThanOrEqual(5000);
    expect(ix.approxBytes()).toBeLessThanOrEqual(5 * 1024 * 1024);
  });
});
```

- [ ] **Step 2: Run** `cd apps/api && npx jest src/modules/news-events/index --ci --maxWorkers=2` → FAIL.

- [ ] **Step 3: Implement** — `index/news-index.ts`:
```ts
import { keysOfTags } from '../keys';
import type { IndexedArticle } from '../types';

export interface NewsIndexOptions { horizonMs: number; maxItems: number; maxPerKey: number }
export type UpsertResult = 'added' | 'updated' | 'ignored';

/** Newer first; ties broken by id so the order is total and stable. */
const newer = (x: IndexedArticle, y: IndexedArticle) => x.publishedAt > y.publishedAt || (x.publishedAt === y.publishedAt && x.id > y.id);

/**
 * Spec §6. Items keyed `I:/S:/X:/M:` → newest-first lists. Bounded by the horizon,
 * ≤ maxPerKey per key and ≤ maxItems total (oldest evicted first, in a batch down
 * to 95 % so a full index does not re-sort on every insert). No I/O.
 */
export class NewsIndex {
  private readonly items = new Map<string, { a: IndexedArticle; keys: string[] }>();
  private readonly byKey = new Map<string, IndexedArticle[]>();
  private maxFetched: number | null = null;

  constructor(private readonly o: NewsIndexOptions) {}

  get size(): number {
    return this.items.size;
  }

  get keyCount(): number {
    return this.byKey.size;
  }

  has(id: string): boolean {
    return this.items.has(id);
  }

  newestFetchedAt(): number | null {
    return this.maxFetched;
  }

  upsert(a: IndexedArticle, now: number): UpsertResult {
    if (a.publishedAt < now - this.o.horizonMs) return 'ignored';
    const prev = this.items.get(a.id);
    if (prev) this.detach(a.id, prev.keys);
    const keys = [...new Set(keysOfTags(a.tags))];
    if (keys.length === 0) {
      if (prev) this.items.delete(a.id);
      return prev ? 'updated' : 'ignored';
    }
    this.items.set(a.id, { a, keys: [...keys] });
    for (const k of keys) this.insert(k, a);
    this.maxFetched = Math.max(this.maxFetched ?? a.fetchedAt, a.fetchedAt);
    this.enforceTotal();
    if (!this.items.has(a.id)) return prev ? 'updated' : 'ignored';
    return prev ? 'updated' : 'added';
  }

  prune(now: number): number {
    const cutoff = now - this.o.horizonMs;
    let n = 0;
    for (const [id, e] of [...this.items]) {
      if (e.a.publishedAt < cutoff) {
        this.detach(id, e.keys);
        this.items.delete(id);
        n++;
      }
    }
    return n;
  }

  list(key: string, sinceMs: number): readonly IndexedArticle[] {
    const l = this.byKey.get(key);
    if (!l) return [];
    let end = 0;
    while (end < l.length && l[end].publishedAt >= sinceMs) end++;
    return l.slice(0, end);
  }

  /** Structural estimate (UTF-16 strings + per-object and per-reference overhead) for the spec §6 ceiling. */
  approxBytes(): number {
    let b = 0;
    for (const { a, keys } of this.items.values()) {
      b += 160 + 2 * (a.id.length + a.title.length + a.source.length + (a.sentiment?.length ?? 0));
      for (const t of [...a.tags.instruments, ...a.tags.sectors, ...a.tags.indices, ...a.tags.markets]) b += 16 + 2 * t.length;
      b += keys.length * (16 + 8); // the key list on the item + the reference in each per-key array
    }
    for (const k of this.byKey.keys()) b += 64 + 2 * k.length;
    return b;
  }

  private insert(key: string, a: IndexedArticle): void {
    let list = this.byKey.get(key);
    if (!list) {
      list = [];
      this.byKey.set(key, list);
    }
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (newer(list[mid], a)) lo = mid + 1;
      else hi = mid;
    }
    list.splice(lo, 0, a);
    while (list.length > this.o.maxPerKey) this.unref(list.pop()!.id, key);
  }

  private unref(id: string, key: string): void {
    const e = this.items.get(id);
    if (!e) return;
    e.keys = e.keys.filter((k) => k !== key);
    if (e.keys.length === 0) this.items.delete(id);
  }

  private detach(id: string, keys: readonly string[]): void {
    for (const k of keys) {
      const list = this.byKey.get(k);
      if (!list) continue;
      const i = list.findIndex((x) => x.id === id);
      if (i >= 0) list.splice(i, 1);
      if (list.length === 0) this.byKey.delete(k);
    }
  }

  private enforceTotal(): void {
    if (this.items.size <= this.o.maxItems) return;
    const target = Math.floor(this.o.maxItems * 0.95);
    const oldest = [...this.items.values()].sort((x, y) => x.a.publishedAt - y.a.publishedAt).slice(0, this.items.size - target);
    for (const e of oldest) {
      this.detach(e.a.id, e.keys);
      this.items.delete(e.a.id);
    }
  }
}
```
(Note the `≤ maxItems` test inserts newest-last with `i` minutes ago — `k0` is the newest; `k149` the oldest is evicted.)

- [ ] **Step 4: Run** → PASS; tsc → 174.

- [ ] **Step 5: Commit** `feat(news-events): bounded in-memory news index (24 h, 50/key, 5,000 items)` with explicit paths.

---

## Task B2: The ladder and the layered fill (Stream B)

**Files:**
- Create: `apps/api/src/modules/news-events/index/{ladder.ts,ladder.spec.ts}`

**Interfaces:**
- Consumes: `NewsIndex.list` (B1); `instrumentKeysOf`, `BANK_SECTORS`, `INDEX_SECTOR`, `MCX_GROUP`, `LAYER_CAPS`, `MAX_HEADLINES`, `NEWS_WINDOW_MS`, `FRESH_WINDOW_MS` (F1).
- Produces: `interface Rung { layer: NewsLayer; keys: string[] }`; `ladderFor(p: NewsPosition, sectors: SectorLookup): Rung[]`; `layeredHeadlines(ix: Pick<NewsIndex, 'list'>, rungs: Rung[], now: number): { headlines: LayeredHeadline[]; newestAt: string | null }`; `freshInstrument(ix, rungs, now): { count: number; fresh: FreshItem[] }`.

- [ ] **Step 1: Write the failing test** — `index/ladder.spec.ts`:
```ts
import { freshInstrument, ladderFor, layeredHeadlines } from './ladder';
import { NewsIndex } from './news-index';
import { article } from '../testing';
import type { ArticleTags, NewsPosition } from '../types';

const NOW = Date.UTC(2026, 9, 16, 6, 0);
const sectors = { sectorOf: (s: string) => ({ SBIN: 'NIFTY PSU BANK', TCS: 'NIFTY IT' } as Record<string, string>)[s] ?? null };
const stock = (key: string): NewsPosition => ({ kind: 'STOCK', underlying: key, key, exchange: 'NSE', expiry: null });
const ix = () => new NewsIndex({ horizonMs: 24 * 3_600_000, maxItems: 5000, maxPerKey: 50 });
const T = (t: Partial<ArticleTags>): ArticleTags => ({ instruments: [], sectors: [], indices: [], markets: [], ...t });
const put = (i: NewsIndex, id: string, minsAgo: number, tags: Partial<ArticleTags>, over: Record<string, unknown> = {}) =>
  i.upsert(article({ id, publishedAt: NOW - minsAgo * 60_000, fetchedAt: NOW, tags: T(tags), ...over }), NOW);

describe('ladderFor (R2)', () => {
  it('stock in a bank sector: own → sector → NIFTY + BANKNIFTY → IN, GLOBAL', () => {
    expect(ladderFor(stock('SBIN'), sectors)).toEqual([
      { layer: 'instrument', keys: ['I:SBIN'] },
      { layer: 'sector', keys: ['S:NIFTY PSU BANK'] },
      { layer: 'index', keys: ['X:NIFTY', 'X:BANKNIFTY'] },
      { layer: 'market', keys: ['M:IN', 'M:GLOBAL'] },
    ]);
  });
  it('stock with no known sector skips the sector rung', () => {
    expect(ladderFor(stock('ZZZ'), sectors).map((r) => r.layer)).toEqual(['instrument', 'index', 'market']);
  });
  it('index option: the index itself, its sector, no index rung', () => {
    expect(ladderFor({ kind: 'INDEX', underlying: 'BANKNIFTY', key: 'BANKNIFTY', exchange: 'NFO', expiry: null }, sectors)).toEqual([
      { layer: 'instrument', keys: ['X:BANKNIFTY'] },
      { layer: 'sector', keys: ['S:NIFTY BANK'] },
      { layer: 'market', keys: ['M:IN', 'M:GLOBAL'] },
    ]);
    expect(ladderFor({ kind: 'INDEX', underlying: 'NIFTY', key: 'NIFTY', exchange: 'NFO', expiry: null }, sectors).map((r) => r.layer)).toEqual(['instrument', 'market']);
  });
  it('MCX future: benchmark → commodity group → GLOBAL then IN', () => {
    expect(ladderFor({ kind: 'COMMODITY', underlying: 'CRUDEOILM', key: 'CRUDEOIL', exchange: 'MCX', expiry: null }, sectors)).toEqual([
      { layer: 'instrument', keys: ['I:CRUDEOIL'] },
      { layer: 'sector', keys: ['S:MCX ENERGY'] },
      { layer: 'market', keys: ['M:GLOBAL', 'M:IN'] },
    ]);
  });
});

describe('layeredHeadlines (R3)', () => {
  it('ceilings 8/3/2/2 under a total of 8', () => {
    const i = ix();
    for (let k = 0; k < 2; k++) put(i, `own${k}`, k, { instruments: ['SBIN'] });
    for (let k = 0; k < 5; k++) put(i, `sec${k}`, 10 + k, { sectors: ['NIFTY PSU BANK'] });
    for (let k = 0; k < 3; k++) put(i, `idx${k}`, 20 + k, { indices: ['NIFTY'] });
    for (let k = 0; k < 4; k++) put(i, `mkt${k}`, 30 + k, { markets: ['IN'] });
    const h = layeredHeadlines(i, ladderFor(stock('SBIN'), sectors), NOW).headlines;
    expect(h.map((x) => `${x.layer}:${x.key}`)).toEqual([
      'instrument:SBIN', 'instrument:SBIN', 'sector:NIFTY PSU BANK', 'sector:NIFTY PSU BANK', 'sector:NIFTY PSU BANK',
      'index:NIFTY', 'index:NIFTY', 'market:IN',
    ]);
  });
  it('a busy own key takes all 8 and nothing else is shown', () => {
    const i = ix();
    for (let k = 0; k < 12; k++) put(i, `own${k}`, k, { instruments: ['SBIN'] });
    put(i, 'mkt', 1, { markets: ['IN'] });
    const h = layeredHeadlines(i, ladderFor(stock('SBIN'), sectors), NOW).headlines;
    expect(h).toHaveLength(8);
    expect(h.every((x) => x.layer === 'instrument')).toBe(true);
  });
  it('the 6 h window is applied BEFORE the cap: old own headlines never starve fresh lower layers', () => {
    const i = ix();
    for (let k = 0; k < 20; k++) put(i, `old${k}`, 7 * 60 + k, { instruments: ['SBIN'] });
    put(i, 'fresh', 5, { instruments: ['SBIN'] });
    put(i, 'sec', 6, { sectors: ['NIFTY PSU BANK'] });
    const h = layeredHeadlines(i, ladderFor(stock('SBIN'), sectors), NOW).headlines;
    expect(h.map((x) => x.layer)).toEqual(['instrument', 'sector']);
  });
  it('an article keeps its highest layer only (dedupe)', () => {
    const i = ix();
    put(i, 'both', 3, { instruments: ['SBIN'], markets: ['IN'] });
    const h = layeredHeadlines(i, ladderFor(stock('SBIN'), sectors), NOW).headlines;
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ layer: 'instrument', key: 'SBIN', ageMin: 3 });
  });
  it('MCX: GLOBAL fills before IN in the market rung', () => {
    const i = ix();
    put(i, 'in1', 1, { markets: ['IN'] });
    put(i, 'in2', 2, { markets: ['IN'] });
    put(i, 'gl', 30, { markets: ['GLOBAL'] });
    const h = layeredHeadlines(i, ladderFor({ kind: 'COMMODITY', underlying: 'GOLD', key: 'GOLD', exchange: 'MCX', expiry: null }, sectors), NOW).headlines;
    // GLOBAL is taken first although two newer IN headlines exist; the cap of 2 leaves room for the newest IN.
    // Display order within a layer is newest-first.
    expect(h.map((x) => `${x.key}:${x.ageMin}`)).toEqual(['IN:1', 'GLOBAL:30']);
  });
  it('newestAt is the newest shown headline; empty index → no headlines', () => {
    const i = ix();
    expect(layeredHeadlines(i, ladderFor(stock('SBIN'), sectors), NOW)).toEqual({ headlines: [], newestAt: null });
    put(i, 'a', 12, { instruments: ['SBIN'] });
    expect(layeredHeadlines(i, ladderFor(stock('SBIN'), sectors), NOW).newestAt).toBe(new Date(NOW - 12 * 60_000).toISOString());
  });
});

describe('freshInstrument', () => {
  it('own layer only, last 30 min, inferred dates excluded, never saturates at 20', () => {
    const i = ix();
    for (let k = 0; k < 25; k++) put(i, `f${k}`, k, { instruments: ['SBIN'] });
    put(i, 'inferred', 1, { instruments: ['SBIN'] }, { dateInferred: true });
    put(i, 'late', 31, { instruments: ['SBIN'] });
    put(i, 'mkt', 1, { markets: ['IN'] });
    const f = freshInstrument(i, ladderFor(stock('SBIN'), sectors), NOW);
    expect(f.count).toBe(25);
    expect(f.fresh.map((x) => x.id)).not.toContain('inferred');
    expect(f.fresh[0]).toEqual({ id: 'f0', title: 'headline f0' });
  });
});
```
- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** — `index/ladder.ts`:
```ts
import { FRESH_WINDOW_MS, LAYER_CAPS, MAX_HEADLINES, NEWS_WINDOW_MS } from '../config';
import { BANK_SECTORS, INDEX_SECTOR, instrumentKeysOf, MCX_GROUP } from '../keys';
import type { FreshItem, IndexedArticle, LayeredHeadline, NewsLayer, NewsPosition, SectorLookup } from '../types';

export interface Rung { layer: NewsLayer; keys: string[] }
type Lister = { list(key: string, sinceMs: number): readonly IndexedArticle[] };

/** Spec §7 / R2. Keys inside a rung are in PRIORITY order (IN before GLOBAL for NSE, GLOBAL first for MCX). */
export function ladderFor(p: NewsPosition, sectors: SectorLookup): Rung[] {
  const rungs: Rung[] = [{ layer: 'instrument', keys: instrumentKeysOf(p) }];
  if (p.kind === 'STOCK') {
    const s = sectors.sectorOf(p.key);
    if (s) rungs.push({ layer: 'sector', keys: [`S:${s}`] });
    rungs.push({ layer: 'index', keys: s && BANK_SECTORS.has(s) ? ['X:NIFTY', 'X:BANKNIFTY'] : ['X:NIFTY'] });
    rungs.push({ layer: 'market', keys: ['M:IN', 'M:GLOBAL'] });
  } else if (p.kind === 'INDEX') {
    const s = INDEX_SECTOR[p.key];
    if (s) rungs.push({ layer: 'sector', keys: [`S:${s}`] });
    rungs.push({ layer: 'market', keys: ['M:IN', 'M:GLOBAL'] });
  } else {
    rungs.push({ layer: 'sector', keys: [`S:${MCX_GROUP[p.key]}`] });
    rungs.push({ layer: 'market', keys: ['M:GLOBAL', 'M:IN'] });
  }
  return rungs;
}

/** R3: window first, every article claimed by the highest rung that sees it, ceilings 8/3/2/2, total 8. */
export function layeredHeadlines(ix: Lister, rungs: readonly Rung[], now: number): { headlines: LayeredHeadline[]; newestAt: string | null } {
  const since = now - NEWS_WINDOW_MS;
  const claimed = new Set<string>();
  const headlines: LayeredHeadline[] = [];
  for (const r of rungs) {
    const cands: Array<{ a: IndexedArticle; key: string }> = [];
    for (const k of r.keys) {
      for (const a of ix.list(k, since)) {
        if (claimed.has(a.id)) continue;
        claimed.add(a.id);
        cands.push({ a, key: k.slice(2) });
      }
    }
    const room = Math.max(0, Math.min(LAYER_CAPS[r.layer], MAX_HEADLINES - headlines.length));
    const take = cands.slice(0, room).sort((x, y) => y.a.publishedAt - x.a.publishedAt);
    for (const { a, key } of take) {
      headlines.push({
        title: a.title, source: a.source, sentiment: a.sentiment, publishedAt: new Date(a.publishedAt).toISOString(),
        layer: r.layer, key, ageMin: Math.max(0, Math.floor((now - a.publishedAt) / 60_000)),
      });
    }
  }
  const newest = headlines.reduce<number | null>((m, h) => Math.max(m ?? 0, Date.parse(h.publishedAt)), null);
  return { headlines, newestAt: newest === null ? null : new Date(newest).toISOString() };
}

/** `freshCount` (spec §7): own layer, 30 min, inferred publish times excluded. Ids/titles feed the edge-triggered news-hit. */
export function freshInstrument(ix: Lister, rungs: readonly Rung[], now: number): { count: number; fresh: FreshItem[] } {
  const own = rungs.find((r) => r.layer === 'instrument');
  const seen = new Set<string>();
  const fresh: FreshItem[] = [];
  for (const k of own?.keys ?? []) {
    for (const a of ix.list(k, now - FRESH_WINDOW_MS)) {
      if (a.dateInferred || seen.has(a.id)) continue;
      seen.add(a.id);
      fresh.push({ id: a.id, title: a.title });
    }
  }
  return { count: fresh.length, fresh };
}
```
- [ ] **Step 4: Run** → PASS; tsc → 174.

- [ ] **Step 5: Commit** `feat(news-events): layered ladder (own → sector → index → market) with window-before-cap and dedupe`.

---

## Task B3: `NewsIndexService` — boot rebuild, push, 60-s delta poll, peek, onAdded (Stream B, after merging F2+F3)

**Files:**
- Create: `apps/api/src/modules/news-events/index/{news-index.service.ts,news-index.service.spec.ts,news-index.module.ts}`

**Interfaces:**
- Consumes: `NewsIndex` (B1), `ladderFor`/`layeredHeadlines`/`freshInstrument` (B2); `NEWS_EVENTS_CONFIG`, `NEWS_INGEST_BUS`, `SourceHealthBook`, `SectorMapService`, `toIndexedArticle`, `DELTA_POLL_MS`, `STALE_AFTER_MS`, `MAX_PER_KEY`, `NewsEventsCoreModule` (F); `NewsIndexReader` (port, F1).
- Produces: `NewsIndexService implements NewsIndexReader` with `start(): Promise<void>`, `rebuild()`, `poll()`, `ingest(items)`, `peek(position, now)`, `onAdded(fn)`, test seams `clock` and `now`; `NewsIndexModule` exporting it.

- [ ] **Step 1: Write the failing test** — `index/news-index.service.spec.ts`:
```ts
import { NewsIndexService } from './news-index.service';
import { InProcessNewsIngestBus } from '../ingest-bus';
import { SourceHealthBook } from '../source-health';
import { parseNewsEventsConfig } from '../config';
import { article } from '../testing';
import type { NewsPosition } from '../types';

const NOW = Date.UTC(2026, 9, 16, 6, 0);
const SBIN: NewsPosition = { kind: 'STOCK', underlying: 'SBIN', key: 'SBIN', exchange: 'NSE', expiry: null };
const row = (id: string, minsAgo: number, fetchedMinsAgo = minsAgo) => ({
  id, title: `t ${id}`, source: 'ET', sentiment: null, publishedAt: new Date(NOW - minsAgo * 60_000),
  fetchedAt: new Date(NOW - fetchedMinsAgo * 60_000), dateInferred: false, instruments: ['SBIN'], sectors: [], indices: [], markets: [],
});

function harness(mode = 'observe', boot = [row('b1', 120), row('b2', 10)]) {
  const findMany = jest.fn().mockResolvedValueOnce(boot);
  const prisma = { newsArticle: { findMany } };
  const bus = new InProcessNewsIngestBus();
  const health = new SourceHealthBook();
  const svc = new NewsIndexService(prisma as never, parseNewsEventsConfig({ NEWS_EVENTS_V2_ENABLED: mode }), bus, health, { sectorOf: () => null } as never);
  svc.now = () => NOW;
  svc.clock = { isOpen: () => true } as never;
  const added: string[][] = [];
  svc.onAdded((items) => added.push(items.map((i) => i.id)));
  return { svc, findMany, bus, health, added };
}

afterEach(() => jest.useRealTimers());

describe('NewsIndexService', () => {
  it('off: peek is unavailable and nothing is queried', () => {
    const { svc, findMany } = harness('false');
    svc.onApplicationBootstrap();
    expect(svc.peek(SBIN, new Date(NOW))).toEqual({ status: 'unavailable', reason: expect.stringMatching(/NEWS_EVENTS_V2_ENABLED/) });
    expect(findMany).not.toHaveBeenCalled();
  });

  it('warming before the rebuild completes says "cannot see", not "no news"', () => {
    const { svc } = harness();
    void svc.start();
    expect(svc.peek(SBIN, new Date(NOW))).toEqual({ status: 'warming', reason: expect.stringMatching(/NOT a finding that nothing was published/) });
    svc.onModuleDestroy();
  });

  it('the boot rebuild loads the last 24 h and emits NOTHING to onAdded (a restart must not wake on old news)', async () => {
    const { svc, findMany, added } = harness();
    await svc.start();
    expect(findMany.mock.calls[0][0]).toMatchObject({ where: { publishedAt: { gte: new Date(NOW - 24 * 3_600_000) } }, orderBy: { publishedAt: 'asc' } });
    expect(added).toEqual([]);
    const p = svc.peek(SBIN, new Date(NOW));
    expect(p.status).toBe('ok');
    if (p.status === 'ok') {
      expect(p.headlines.map((h) => h.title)).toEqual(['t b2', 't b1']);
      expect(p.freshCount).toBe(1);
      expect(p.fresh).toEqual([{ id: 'b2', title: 't b2' }]);
    }
    svc.onModuleDestroy();
  });

  it('push: a new id is emitted once; the same id again (push, poll or re-tag) never is', async () => {
    const { svc, bus, findMany, added } = harness();
    await svc.start();
    bus.publish([article({ id: 'n1', publishedAt: NOW - 60_000, fetchedAt: NOW, tags: { instruments: ['SBIN'], sectors: [], indices: [], markets: [] } })]);
    bus.publish([article({ id: 'n1', publishedAt: NOW - 60_000, fetchedAt: NOW, tags: { instruments: ['SBIN', 'TCS'], sectors: [], indices: [], markets: [] } })]);
    findMany.mockResolvedValueOnce([row('n1', 1, 0), row('n2', 2, 0)]);
    await svc.poll();
    expect(added).toEqual([['n1'], ['n2']]);
    svc.onModuleDestroy();
  });

  it('the delta poll asks only for rows fetched after the watermark', async () => {
    const { svc, findMany } = harness();
    await svc.start();
    findMany.mockResolvedValueOnce([]);
    await svc.poll();
    expect(findMany.mock.calls[1][0]).toMatchObject({ where: { fetchedAt: { gt: new Date(NOW - 10 * 60_000) } }, orderBy: { fetchedAt: 'asc' }, take: 500 });
    svc.onModuleDestroy();
  });

  it('a failed rebuild is "unavailable" with the reason, and the next poll retries it', async () => {
    const { svc, findMany } = harness();
    findMany.mockReset().mockRejectedValueOnce(new Error('db down')).mockResolvedValueOnce([row('b2', 10)]);
    await svc.start();
    expect(svc.peek(SBIN, new Date(NOW))).toEqual({ status: 'unavailable', reason: expect.stringMatching(/db down.*cannot see/) });
    await svc.poll();
    expect(svc.peek(SBIN, new Date(NOW)).status).toBe('ok');
    svc.onModuleDestroy();
  });

  it('asOf: last ingestion, down sources, stale after 30 min while the position\'s exchange is open', async () => {
    const { svc, health } = harness();
    await svc.start();
    health.ok('ET', 5, new Date(NOW - 45 * 60_000));
    for (let i = 0; i < 6; i++) health.fail('MoneyControl', 'HTTP 403', new Date(NOW));
    const p = svc.peek(SBIN, new Date(NOW));
    expect(p.status === 'ok' && p.asOf).toEqual({ lastIngestAt: new Date(NOW - 45 * 60_000).toISOString(), downSources: ['MoneyControl'], stale: true });
    svc.clock = { isOpen: () => false } as never;
    const q = svc.peek(SBIN, new Date(NOW));
    expect(q.status === 'ok' && q.asOf.stale).toBe(false);
    svc.onModuleDestroy();
  });

  it('peek p99 < 2 ms with a full index (spec §12)', async () => {
    const boot = Array.from({ length: 5000 }, (_, i) => ({ ...row(`r${i}`, i % 1400), instruments: [`S${i % 700}`, 'SBIN'].slice(i % 2), markets: ['IN'] }));
    const { svc } = harness('true', boot);
    await svc.start();
    const times: number[] = [];
    for (let i = 0; i < 1000; i++) {
      const t0 = process.hrtime.bigint();
      svc.peek(SBIN, new Date(NOW));
      times.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    times.sort((a, b) => a - b);
    expect(times[989]).toBeLessThan(2);
    svc.onModuleDestroy();
  });
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** — `index/news-index.service.ts`:
```ts
import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { bootJobsEnabled } from '../../../common/utils/boot-jobs';
import { MARKET_HOLIDAYS } from '../../market-data/services/market-holidays.service';
import { SessionClock } from '../../market-hub/session-clock';
import type { NewsIndexReader } from '../../trade-sentinel/ports/news-index.port';
import { DELTA_POLL_MS, MAX_PER_KEY, NEWS_EVENTS_CONFIG, STALE_AFTER_MS, type NewsEventsConfig } from '../config';
import { NEWS_INGEST_BUS, type NewsIngestBus } from '../ingest-bus';
import { toIndexedArticle } from '../keys';
import { SectorMapService } from '../sector-map.service';
import { SourceHealthBook } from '../source-health';
import type { IndexedArticle, NewsPeek, NewsPosition } from '../types';
import { freshInstrument, ladderFor, layeredHeadlines } from './ladder';
import { NewsIndex } from './news-index';

const ROW_SELECT = {
  id: true, title: true, source: true, sentiment: true, publishedAt: true, fetchedAt: true, dateInferred: true,
  instruments: true, sectors: true, indices: true, markets: true,
} as const;

const CANNOT_SEE = 'headlines exist that this process cannot see yet; this is NOT a finding that nothing was published';

/**
 * Spec §3/§6: the news index. Rebuilt from the DB on boot (emitting nothing),
 * kept current by the in-process bus (push) and a 60-s delta poll on
 * `fetchedAt > watermark` (a split worker process). `peek` is synchronous and
 * does no I/O; `onAdded` fires only for ids the index has never held.
 */
@Injectable()
export class NewsIndexService implements NewsIndexReader, OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(NewsIndexService.name);
  private readonly index: NewsIndex;
  private state: 'off' | 'warming' | 'ready' | 'failed' = 'off';
  private failReason = '';
  private watermark: Date;
  private readonly listeners = new Set<(items: readonly IndexedArticle[]) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsub: (() => void) | null = null;
  private polling = false;
  clock: Pick<SessionClock, 'isOpen'> = new SessionClock({ holidays: MARKET_HOLIDAYS });
  now: () => number = () => Date.now();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(NEWS_EVENTS_CONFIG) private readonly cfg: NewsEventsConfig,
    @Inject(NEWS_INGEST_BUS) private readonly bus: NewsIngestBus,
    private readonly health: SourceHealthBook,
    private readonly sectors: SectorMapService,
  ) {
    this.index = new NewsIndex({ horizonMs: cfg.indexHours * 3_600_000, maxItems: cfg.indexMaxItems, maxPerKey: MAX_PER_KEY });
    this.watermark = new Date(0);
  }

  onApplicationBootstrap(): void {
    if (!this.cfg.computing || !bootJobsEnabled()) return;
    void this.start();
  }

  start(): Promise<void> {
    this.state = 'warming';
    this.unsub = this.bus.subscribe((items) => this.ingest(items));
    this.timer = setInterval(() => void this.poll(), DELTA_POLL_MS);
    this.timer.unref?.();
    return this.rebuild();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsub?.();
    this.unsub = null;
  }

  onAdded(listener: (items: readonly IndexedArticle[]) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async rebuild(): Promise<void> {
    const t0 = this.now();
    const horizon = new Date(t0 - this.cfg.indexHours * 3_600_000);
    try {
      const rows = await this.prisma.newsArticle.findMany({ where: { publishedAt: { gte: horizon } }, orderBy: { publishedAt: 'asc' }, select: ROW_SELECT });
      let watermark = horizon;
      for (const r of rows) {
        this.index.upsert(toIndexedArticle(r), t0); // NOT ingest(): a rebuild emits nothing
        if (r.fetchedAt > watermark) watermark = r.fetchedAt;
      }
      this.watermark = watermark;
      this.state = 'ready';
      this.logger.log(`[news-index] ready: ${this.index.size} items, ${this.index.keyCount} keys, built in ${this.now() - t0}ms`);
    } catch (err) {
      this.state = 'failed';
      this.failReason = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[news-index] rebuild failed (retrying on the next poll): ${this.failReason}`);
    }
  }

  async poll(): Promise<void> {
    if (this.polling || this.state === 'off') return;
    this.polling = true;
    try {
      if (this.state !== 'ready') {
        await this.rebuild();
        return;
      }
      const rows = await this.prisma.newsArticle.findMany({
        where: { fetchedAt: { gt: this.watermark } }, orderBy: { fetchedAt: 'asc' }, take: 500, select: ROW_SELECT,
      });
      for (const r of rows) if (r.fetchedAt > this.watermark) this.watermark = r.fetchedAt;
      this.ingest(rows.map(toIndexedArticle));
      this.index.prune(this.now());
    } catch (err) {
      this.logger.warn(`[news-index] delta poll failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.polling = false;
    }
  }

  ingest(items: readonly IndexedArticle[]): void {
    const now = this.now();
    const added: IndexedArticle[] = [];
    for (const a of items) if (this.index.upsert(a, now) === 'added') added.push(a);
    if (added.length === 0) return;
    for (const fn of [...this.listeners]) {
      try {
        fn(added);
      } catch (err) {
        this.logger.error(`[news-index] onAdded listener threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  peek(p: NewsPosition, nowDate: Date): NewsPeek {
    if (this.state === 'off') {
      return { status: 'unavailable', reason: 'the news index is not running in this process (NEWS_EVENTS_V2_ENABLED is false)' };
    }
    if (this.state === 'warming') return { status: 'warming', reason: `the news index is still loading after a restart — ${CANNOT_SEE}` };
    if (this.state === 'failed') return { status: 'unavailable', reason: `the news index could not be loaded (${this.failReason}) — ${CANNOT_SEE}` };
    const now = nowDate.getTime();
    const rungs = ladderFor(p, this.sectors);
    const { headlines, newestAt } = layeredHeadlines(this.index, rungs, now);
    const { count, fresh } = freshInstrument(this.index, rungs, now);
    const newestFetched = this.index.newestFetchedAt();
    const lastIngestAt = this.health.lastOkAt() ?? (newestFetched === null ? null : new Date(newestFetched).toISOString());
    const open = this.clock.isOpen(p.exchange, nowDate);
    const stale = open && (lastIngestAt === null || now - Date.parse(lastIngestAt) > STALE_AFTER_MS);
    return { status: 'ok', headlines, newestAt, freshCount: count, fresh, asOf: { lastIngestAt, downSources: this.health.down(), stale } };
  }
}
```
`index/news-index.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { PrismaModule } from '../../../common/prisma/prisma.module';
import { NewsEventsCoreModule } from '../news-events-core.module';
import { NewsIndexService } from './news-index.service';

@Module({ imports: [NewsEventsCoreModule, PrismaModule], providers: [NewsIndexService], exports: [NewsIndexService] })
export class NewsIndexModule {}
```
(`news-index.service.ts` imports the sentinel port **type** only — that is the allowed direction: news-events → port types; the sentinel never imports this file.)

- [ ] **Step 4: Run** `npx jest src/modules/news-events/index --ci --maxWorkers=2` → PASS; tsc → 174.

- [ ] **Step 5: Commit** `feat(news-events): NewsIndexService — boot rebuild (silent), push + 60-s delta poll, warming, asOf, sync peek`.

---

## Task C1: Time zones, EIA rules and the macro schedule file (Stream C)

**Files:**
- Create: `apps/api/src/modules/news-events/events/{zoned-time.ts,zoned-time.spec.ts,rule-events.ts,rule-events.spec.ts,macro-schedule.ts,macro-schedule.spec.ts}`
- Create: `config/market-events.json`

**Interfaces:**
- Consumes: `MarketEventInput`, `EventImpact`, `EventScope` (F1).
- Produces: `zonedToUtc(ymd, hhmm, tz): Date`, `tzOffsetMs(ms, tz)`, `ymdInTz(ms, tz)`, `istLabel(d)`, `addDaysYmd(ymd, n)`, `weekdayOfYmd(ymd)`, `isValidTimeZone(tz)`; `EiaOverride`, `eiaEvents(fromYmd, days, usHolidays, overrides): MarketEventInput[]`; `MarketEventsFile`, `MacroEntry`, `validateMarketEventsFile(raw)`, `macroEvents(file)`, `scheduleEndsAt(file)`, `resolveMarketEventsPath()`, `loadMarketEventsFile(path?)`.

- [ ] **Step 0: Worktree.** `git worktree add .claude/worktrees/ne-events -b feature/ne-events <F1 commit>`; junctions; `prisma generate`; tsc → 174.

- [ ] **Step 1: Write the failing tests** — `events/zoned-time.spec.ts`:
```ts
import { addDaysYmd, istLabel, isValidTimeZone, weekdayOfYmd, ymdInTz, zonedToUtc } from './zoned-time';

describe('zonedToUtc — Intl only, no hand-coded offsets', () => {
  it.each([
    ['2026-03-04', '10:30', 'America/New_York', '2026-03-04T15:30:00.000Z'], // EST, before the Mar 8 switch
    ['2026-03-11', '10:30', 'America/New_York', '2026-03-11T14:30:00.000Z'], // EDT
    ['2026-10-28', '10:30', 'America/New_York', '2026-10-28T14:30:00.000Z'], // EDT, before the Nov 1 switch
    ['2026-11-04', '10:30', 'America/New_York', '2026-11-04T15:30:00.000Z'], // EST
    ['2026-12-09', '14:00', 'America/New_York', '2026-12-09T19:00:00.000Z'], // FOMC: 00:30 IST the next day
    ['2026-12-04', '10:00', 'Asia/Kolkata', '2026-12-04T04:30:00.000Z'],
  ])('%s %s %s → %s', (ymd, hhmm, tz, iso) => {
    expect(zonedToUtc(ymd, hhmm, tz).toISOString()).toBe(iso);
  });

  it('labels in IST and crosses IST midnight correctly', () => {
    expect(istLabel(zonedToUtc('2026-12-09', '14:00', 'America/New_York'))).toBe('2026-12-10 00:30 IST');
    expect(ymdInTz(Date.parse('2026-12-09T19:00:00Z'), 'Asia/Kolkata')).toBe('2026-12-10');
  });

  it('date helpers', () => {
    expect(addDaysYmd('2026-12-31', 1)).toBe('2027-01-01');
    expect(weekdayOfYmd('2026-10-14')).toBe(3);
    expect(isValidTimeZone('America/New_York')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
  });
});
```
`events/rule-events.spec.ts`:
```ts
import { eiaEvents } from './rule-events';

const HOL = ['2026-01-19', '2026-09-07', '2026-11-26'];
const OVR = [{ kind: 'eia_natgas' as const, originalDate: '2026-11-26', date: '2026-11-25', localTime: '12:00' }];
const at = (from: string, days: number, kind: string) =>
  eiaEvents(from, days, HOL, OVR).filter((e) => e.kind === kind).map((e) => e.startsAt.toISOString());

it('petroleum Wednesdays 10:30 ET across both 2026 DST switches (21:00 / 20:00 IST)', () => {
  expect(at('2026-03-02', 14, 'eia_petroleum')).toEqual(['2026-03-04T15:30:00.000Z', '2026-03-11T14:30:00.000Z']);
  expect(at('2026-10-26', 14, 'eia_petroleum')).toEqual(['2026-10-28T14:30:00.000Z', '2026-11-04T15:30:00.000Z']);
});

it('a US federal holiday Mon–Wed moves the petroleum report to Thursday', () => {
  expect(at('2026-01-19', 7, 'eia_petroleum')).toEqual(['2026-01-22T15:30:00.000Z']);
  expect(at('2026-09-07', 7, 'eia_petroleum')).toEqual(['2026-09-10T14:30:00.000Z']);
});

it('natural gas Thursdays 10:30 ET; an explicit override moves Thanksgiving to Wednesday noon', () => {
  expect(at('2026-10-26', 7, 'eia_natgas')).toEqual(['2026-10-29T14:30:00.000Z']);
  expect(at('2026-11-23', 7, 'eia_natgas')).toEqual(['2026-11-25T17:00:00.000Z']);
});

it('event shape', () => {
  const e = eiaEvents('2026-10-26', 7, [], [])[0];
  expect(e).toEqual({
    scope: 'commodity', kind: 'eia_petroleum', key: 'CRUDEOIL', title: 'EIA weekly petroleum status report',
    startsAt: new Date('2026-10-28T14:30:00.000Z'), allDay: false, impact: 'high',
    source: 'rule: EIA weekly petroleum status (Wed 10:30 ET)', sourceRef: 'eia_petroleum:2026-10-28',
  });
});
```
`events/macro-schedule.spec.ts`:
```ts
import { loadMarketEventsFile, macroEvents, resolveMarketEventsPath, scheduleEndsAt, validateMarketEventsFile } from './macro-schedule';

const good = {
  version: 1,
  usFederalHolidays: ['2026-11-26'],
  eiaOverrides: [],
  macro: [
    { kind: 'fomc', date: '2026-12-09', localTime: '14:00', tz: 'America/New_York', impact: 'high', sourceUrl: 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm' },
    { kind: 'rbi_mpc', date: '2026-12-04', localTime: '10:00', tz: 'Asia/Kolkata', impact: 'high', sourceUrl: 'https://www.rbi.org.in/' },
  ],
};

it('a valid file becomes events with the right keys and UTC instants', () => {
  const f = validateMarketEventsFile(good);
  expect(macroEvents(f)).toEqual([
    expect.objectContaining({ kind: 'fomc', key: 'US', scope: 'market', title: 'FOMC rate decision', startsAt: new Date('2026-12-09T19:00:00.000Z'), impact: 'high', source: 'config/market-events.json' }),
    expect.objectContaining({ kind: 'rbi_mpc', key: 'IN', startsAt: new Date('2026-12-04T04:30:00.000Z') }),
  ]);
  expect(scheduleEndsAt(f)).toBe('2026-12-09');
});

it('every problem is reported at once', () => {
  const bad = { ...good, macro: [{ kind: 'gdp', date: '2026-13-01', localTime: '25:00', tz: 'Mars/Olympus', impact: 'huge', sourceUrl: 'ftp://x' }] };
  expect(() => validateMarketEventsFile(bad)).toThrow(/kind "gdp".*date "2026-13-01".*localTime "25:00".*tz "Mars\/Olympus".*impact "huge".*sourceUrl/s);
  expect(() => validateMarketEventsFile({ version: 2 })).toThrow(/version/);
});

it('the checked-in config/market-events.json is valid and covers every macro kind', () => {
  const f = loadMarketEventsFile(resolveMarketEventsPath());
  const kinds = new Set(f.macro.map((m) => m.kind));
  for (const k of ['rbi_mpc', 'fomc', 'us_cpi', 'india_cpi', 'us_nfp', 'opec']) expect(kinds.has(k as never)).toBe(true);
  expect(f.usFederalHolidays.length).toBeGreaterThanOrEqual(20);
});
```

- [ ] **Step 2: Run** `cd apps/api && npx jest src/modules/news-events/events --ci --maxWorkers=2` → FAIL.

- [ ] **Step 3: Implement** — `events/zoned-time.ts`:
```ts
/** Spec §8: all times through Intl IANA zones — no hand-coded offsets. Pure. */
const cache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = cache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    cache.set(tz, f);
  }
  return f;
}

function parts(ms: number, tz: string): { y: number; m: number; d: number; hh: number; mm: number; ss: number } {
  const p = Object.fromEntries(fmt(tz).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), hh: Number(p.hour) % 24, mm: Number(p.minute), ss: Number(p.second) };
}

export function tzOffsetMs(ms: number, tz: string): number {
  const p = parts(ms, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss) - Math.floor(ms / 1000) * 1000;
}

/** The UTC instant of wall-clock `ymd hh:mm` in IANA zone `tz`. */
export function zonedToUtc(ymd: string, hhmm: string, tz: string): Date {
  const [y, m, d] = ymd.split('-').map(Number);
  const [hh, mi] = hhmm.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mi);
  const o1 = tzOffsetMs(guess, tz);
  let t = guess - o1;
  const o2 = tzOffsetMs(t, tz);
  if (o2 !== o1) t = guess - o2;
  return new Date(t);
}

export function ymdInTz(ms: number, tz: string): string {
  const p = parts(ms, tz);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

export function istLabel(d: Date): string {
  const p = parts(d.getTime(), 'Asia/Kolkata');
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${p.y}-${pad(p.m)}-${pad(p.d)} ${pad(p.hh)}:${pad(p.mm)} IST`;
}

export function addDaysYmd(ymd: string, n: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday, of the calendar date itself. */
export function weekdayOfYmd(ymd: string): number {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
```
`events/rule-events.ts`:
```ts
import type { MarketEventInput } from '../types';
import { addDaysYmd, weekdayOfYmd, zonedToUtc } from './zoned-time';

export interface EiaOverride { kind: 'eia_petroleum' | 'eia_natgas'; originalDate: string; date: string | null; localTime?: string }

const ET = 'America/New_York';
const SPEC = {
  eia_petroleum: { key: 'CRUDEOIL', title: 'EIA weekly petroleum status report', source: 'rule: EIA weekly petroleum status (Wed 10:30 ET)' },
  eia_natgas: { key: 'NATURALGAS', title: 'EIA weekly natural gas storage report', source: 'rule: EIA natural gas storage (Thu 10:30 ET)' },
} as const;

/**
 * Spec §8 + plan "differs" 12. Petroleum: Wednesday 10:30 ET, Thursday when a US federal
 * holiday falls Mon–Wed of that week. Natural gas: Thursday 10:30 ET. `overrides` (from
 * config/market-events.json) move or cancel a single release by its rule date.
 */
export function eiaEvents(fromYmd: string, days: number, usHolidays: readonly string[], overrides: readonly EiaOverride[]): MarketEventInput[] {
  const hol = new Set(usHolidays);
  const out: MarketEventInput[] = [];
  const push = (kind: keyof typeof SPEC, ruleDate: string, date: string, time: string) => {
    const o = overrides.find((x) => x.kind === kind && x.originalDate === ruleDate);
    if (o && o.date === null) return;
    const s = SPEC[kind];
    out.push({
      scope: 'commodity', kind, key: s.key, title: s.title,
      startsAt: zonedToUtc(o?.date ?? date, o?.localTime ?? time, ET), allDay: false, impact: 'high',
      source: s.source, sourceRef: `${kind}:${ruleDate}`,
    });
  };
  for (let i = 0; i < days; i++) {
    const ymd = addDaysYmd(fromYmd, i);
    const wd = weekdayOfYmd(ymd);
    if (wd === 3) {
      const shifted = [addDaysYmd(ymd, -2), addDaysYmd(ymd, -1), ymd].some((d) => hol.has(d));
      push('eia_petroleum', ymd, shifted ? addDaysYmd(ymd, 1) : ymd, '10:30');
    }
    if (wd === 4) push('eia_natgas', ymd, ymd, '10:30');
  }
  return out.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}
```
`events/macro-schedule.ts`:
```ts
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import type { EventImpact, EventScope, MarketEventInput } from '../types';
import type { EiaOverride } from './rule-events';
import { isValidTimeZone, zonedToUtc } from './zoned-time';

export const MACRO_KINDS = ['rbi_mpc', 'fomc', 'us_cpi', 'india_cpi', 'us_nfp', 'opec'] as const;
export type MacroKind = (typeof MACRO_KINDS)[number];
export interface MacroEntry { kind: MacroKind; date: string; localTime: string; tz: string; impact: EventImpact; sourceUrl: string; title?: string }
export interface MarketEventsFile { version: 1; macro: MacroEntry[]; usFederalHolidays: string[]; eiaOverrides: EiaOverride[] }

export const MACRO_META: Readonly<Record<MacroKind, { key: string; scope: EventScope; title: string }>> = {
  rbi_mpc: { key: 'IN', scope: 'market', title: 'RBI monetary policy decision' },
  india_cpi: { key: 'IN', scope: 'market', title: 'India CPI inflation release' },
  fomc: { key: 'US', scope: 'market', title: 'FOMC rate decision' },
  us_cpi: { key: 'US', scope: 'market', title: 'US CPI release' },
  us_nfp: { key: 'US', scope: 'market', title: 'US non-farm payrolls' },
  opec: { key: 'CRUDEOIL', scope: 'commodity', title: 'OPEC+ meeting' },
};

const YMD = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function validateMarketEventsFile(raw: unknown): MarketEventsFile {
  const f = (raw ?? {}) as Partial<MarketEventsFile>;
  const problems: string[] = [];
  if (f.version !== 1) problems.push(`version must be 1 (got ${JSON.stringify(f.version)})`);
  if (!Array.isArray(f.macro)) problems.push('macro must be an array');
  if (!Array.isArray(f.usFederalHolidays)) problems.push('usFederalHolidays must be an array');
  if (!Array.isArray(f.eiaOverrides)) problems.push('eiaOverrides must be an array');
  (f.macro ?? []).forEach((m, i) => {
    const at = `macro[${i}]`;
    if (!MACRO_KINDS.includes(m.kind)) problems.push(`${at}: kind "${m.kind}"`);
    if (!YMD.test(m.date ?? '')) problems.push(`${at}: date "${m.date}"`);
    if (!HHMM.test(m.localTime ?? '')) problems.push(`${at}: localTime "${m.localTime}"`);
    if (!isValidTimeZone(m.tz ?? '')) problems.push(`${at}: tz "${m.tz}"`);
    if (!['high', 'medium', 'low'].includes(m.impact)) problems.push(`${at}: impact "${m.impact}"`);
    if (!/^https:\/\//.test(m.sourceUrl ?? '')) problems.push(`${at}: sourceUrl must be https`);
  });
  (f.usFederalHolidays ?? []).forEach((d, i) => { if (!YMD.test(d)) problems.push(`usFederalHolidays[${i}]: "${d}"`); });
  (f.eiaOverrides ?? []).forEach((o, i) => {
    if (!['eia_petroleum', 'eia_natgas'].includes(o.kind) || !YMD.test(o.originalDate) || (o.date !== null && !YMD.test(o.date)) || (o.localTime !== undefined && !HHMM.test(o.localTime))) {
      problems.push(`eiaOverrides[${i}]: ${JSON.stringify(o)}`);
    }
  });
  if (problems.length > 0) throw new Error(`config/market-events.json is invalid: ${problems.join('; ')}`);
  return f as MarketEventsFile;
}

export function macroEvents(file: MarketEventsFile): MarketEventInput[] {
  return file.macro.map((m) => ({
    scope: MACRO_META[m.kind].scope, kind: m.kind, key: MACRO_META[m.kind].key, title: m.title ?? MACRO_META[m.kind].title,
    startsAt: zonedToUtc(m.date, m.localTime, m.tz), allDay: false, impact: m.impact,
    source: 'config/market-events.json', sourceRef: m.sourceUrl,
  }));
}

export function scheduleEndsAt(file: MarketEventsFile): string | null {
  return file.macro.reduce<string | null>((max, m) => (max === null || m.date > max ? m.date : max), null);
}

/** MARKET_EVENTS_CONFIG_PATH, else `config/market-events.json` found walking up from this file (as ai-gateway does). */
export function resolveMarketEventsPath(): string {
  const env = process.env.MARKET_EVENTS_CONFIG_PATH?.trim();
  if (env) return env;
  let dir = __dirname;
  for (;;) {
    const p = join(dir, 'config', 'market-events.json');
    if (existsSync(p)) return p;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`config/market-events.json not found above ${__dirname} (set MARKET_EVENTS_CONFIG_PATH)`);
    dir = parent;
  }
}

export function loadMarketEventsFile(path: string = resolveMarketEventsPath()): MarketEventsFile {
  return validateMarketEventsFile(JSON.parse(readFileSync(path, 'utf8')));
}
```
`config/market-events.json` — start from this (holidays from OPM, FOMC 2026 from the Fed), then **transcribe** every remaining entry from 2026-10-16 through **2027-03-31** from the official page named in its `sourceUrl`, one entry per release, and re-verify the two FOMC dates against the Fed page:
```json
{
  "version": 1,
  "usFederalHolidays": [
    "2026-01-01", "2026-01-19", "2026-02-16", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-10-12", "2026-11-11", "2026-11-26", "2026-12-25",
    "2027-01-01", "2027-01-18", "2027-02-15", "2027-05-31", "2027-06-18", "2027-07-05", "2027-09-06", "2027-10-11", "2027-11-11", "2027-11-25", "2027-12-24"
  ],
  "eiaOverrides": [
    { "kind": "eia_natgas", "originalDate": "2026-11-26", "date": "2026-11-25", "localTime": "12:00" },
    { "kind": "eia_natgas", "originalDate": "2027-11-25", "date": "2027-11-24", "localTime": "12:00" }
  ],
  "macro": [
    { "kind": "fomc", "date": "2026-10-28", "localTime": "14:00", "tz": "America/New_York", "impact": "high", "sourceUrl": "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm" },
    { "kind": "fomc", "date": "2026-12-09", "localTime": "14:00", "tz": "America/New_York", "impact": "high", "sourceUrl": "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm" }
  ]
}
```
Transcription sources (each entry's `sourceUrl` is the page it was read from): RBI MPC decisions — `https://www.rbi.org.in/Scripts/BS_PressReleaseDisplay.aspx` (the annual MPC schedule press release; `localTime` `10:00`, `tz` `Asia/Kolkata`, impact `high`); FOMC 2027 — the Fed page above (`14:00` New York, `high`); US CPI — `https://www.bls.gov/schedule/news_release/cpi.htm` (`08:30` New York, `high`); US NFP — `https://www.bls.gov/schedule/news_release/empsit.htm` (`08:30` New York, `medium`); India CPI — `https://www.mospi.gov.in/` advance release calendar (`16:00` Asia/Kolkata, `high`); OPEC/OPEC+ ministerial meetings — `https://www.opec.org/opec_web/en/press_room/` (`12:00` Europe/Vienna unless announced otherwise, `high`). The test requires at least one entry of every kind; the boot warning (C3) fires when fewer than 30 days of macro entries remain.

- [ ] **Step 4: Run** → PASS; tsc → 174.

- [ ] **Step 5: Commit** `feat(news-events): Intl time zones, EIA release rules (DST + holiday shift), checked-in macro schedule` (paths include `config/market-events.json`).

---

## Task C2: NSE event calendar + corporate actions, Yahoo fallback, repository, builder (Stream C, after merging F2+F3)

**Files:**
- Create: `apps/api/src/modules/news-events/events/{nse-events.ts,nse-events.spec.ts,market-events.repository.ts,market-events.repository.spec.ts,events-builder.service.ts,events-builder.service.spec.ts}`
- Create (if M0 could not capture): `news-events/__fixtures__/nse-event-calendar.json`, `nse-corporate-actions.json` with the documented shapes below

**Interfaces:**
- Consumes: C1; `NseClient`, `SourceHealthBook`, `NEWS_EVENTS_CONFIG`, `MarketEventInput`, `StoredMarketEvent` (F); `prisma.marketEvent` (F2); `FundamentalsService.get(symbol, 'NSE')` (existing, `nextEarningsDate?: string`); `nseDateToYmd`, `istAt`, `istYmd` (market-cues ist-dates).
- Produces: `parseEventCalendar(json)`, `parseCorporateActions(json)`, `yahooEarningsEvent(symbol, raw)`; `MarketEventsRepository.syncSource(source, from, to, rows, now)`, `.listFrom(from)`; `EventsBuilderService.build(now, wantedSymbols): Promise<BuildReport>`, `.scheduleEnds: string | null`.

Documented shapes (the M0 fixture wins if it differs):
```json
// GET https://www.nseindia.com/api/event-calendar?index=equities
[{ "symbol": "INFY", "company": "Infosys Limited", "purpose": "Financial Results", "bm_desc": "To consider and approve the financial results for the period ended September 30, 2026", "date": "16-Oct-2026" }]
// GET https://www.nseindia.com/api/corporates-corporateActions?index=equities&from_date=16-10-2026&to_date=30-10-2026
[{ "symbol": "ITC", "comp": "ITC Limited", "subject": "Interim Dividend - Rs 6.50 Per Share", "exDate": "22-Oct-2026", "recDate": "22-Oct-2026" }]
```

- [ ] **Step 1: Write the failing tests** — `events/nse-events.spec.ts`:
```ts
import { parseCorporateActions, parseEventCalendar, yahooEarningsEvent } from './nse-events';

it('event calendar: results vs board meeting, all-day at 09:15 IST, high impact, deduped', () => {
  const rows = [
    { symbol: 'INFY', purpose: 'Financial Results', bm_desc: 'approve results', date: '16-Oct-2026' },
    { symbol: 'INFY', purpose: 'Financial Results', bm_desc: 'approve results', date: '16-Oct-2026' },
    { symbol: 'TCS', purpose: 'Fund Raising', bm_desc: 'issue of NCDs', date: '20-Oct-2026' },
    { symbol: '', purpose: 'x', date: '20-Oct-2026' },
    { symbol: 'BAD', purpose: 'x', date: 'soon' },
  ];
  expect(parseEventCalendar({ data: rows })).toEqual([
    { scope: 'company', kind: 'results', key: 'INFY', title: 'INFY financial results: Financial Results', startsAt: new Date('2026-10-16T03:45:00.000Z'), allDay: true, impact: 'high', source: 'NSE event calendar', sourceRef: 'INFY|16-Oct-2026|Financial Results' },
    { scope: 'company', kind: 'board_meeting', key: 'TCS', title: 'TCS board meeting: Fund Raising', startsAt: new Date('2026-10-20T03:45:00.000Z'), allDay: true, impact: 'high', source: 'NSE event calendar', sourceRef: 'TCS|20-Oct-2026|Fund Raising' },
  ]);
});

it('corporate actions: ex-dividend / split / bonus by subject, medium impact', () => {
  expect(parseCorporateActions([
    { symbol: 'ITC', subject: 'Interim Dividend - Rs 6.50 Per Share', exDate: '22-Oct-2026' },
    { symbol: 'XYZ', subject: 'Face Value Split (Sub-Division) - From Rs 10/- To Rs 2/-', exDate: '23-Oct-2026' },
    { symbol: 'ABC', subject: 'Bonus 1:1', exDate: '24-Oct-2026' },
  ]).map((e) => `${e.key}:${e.kind}:${e.impact}`)).toEqual(['ITC:ex_dividend:medium', 'XYZ:split:medium', 'ABC:bonus:medium']);
});

it('a body that is not a list throws (a source failure, never "no events")', () => {
  expect(() => parseEventCalendar('<html>')).toThrow(/not a list/);
});

it('Yahoo estimate: labelled, high impact, only when the date parses', () => {
  expect(yahooEarningsEvent('INFY', '2026-10-30')).toMatchObject({ kind: 'results', key: 'INFY', source: 'yahoo (estimate)', impact: 'high', allDay: true, startsAt: new Date('2026-10-30T03:45:00.000Z') });
  expect(yahooEarningsEvent('INFY', undefined)).toBeNull();
  expect(yahooEarningsEvent('INFY', 'n/a')).toBeNull();
});
```
`events/market-events.repository.spec.ts`:
```ts
import { MarketEventsRepository } from './market-events.repository';

it('syncSource: upserts by (kind,key,startsAt) and deletes this source\'s rows in the window that vanished', async () => {
  const tx = {
    marketEvent: {
      findMany: jest.fn().mockResolvedValue([
        { id: 'keep', kind: 'results', key: 'INFY', startsAt: new Date('2026-10-16T03:45:00Z') },
        { id: 'gone', kind: 'results', key: 'TCS', startsAt: new Date('2026-10-17T03:45:00Z') },
      ]),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      upsert: jest.fn().mockResolvedValue({}),
    },
  };
  const prisma = { $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
  const repo = new MarketEventsRepository(prisma as never);
  const now = new Date('2026-10-16T02:00:00Z');
  const row = { scope: 'company' as const, kind: 'results', key: 'INFY', title: 'INFY results', startsAt: new Date('2026-10-16T03:45:00Z'), allDay: true, impact: 'high' as const, source: 'NSE event calendar', sourceRef: 'r' };
  await expect(repo.syncSource('NSE event calendar', now, new Date('2026-12-01'), [row], now)).resolves.toEqual({ upserted: 1, removed: 1 });
  expect(tx.marketEvent.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['gone'] } } });
  expect(tx.marketEvent.upsert.mock.calls[0][0].where).toEqual({ kind_key_startsAt: { kind: 'results', key: 'INFY', startsAt: row.startsAt } });
});
```
`events/events-builder.service.spec.ts`:
```ts
import { EventsBuilderService } from './events-builder.service';
import { SourceHealthBook } from '../source-health';
import { parseNewsEventsConfig } from '../config';

function harness(over: { getJson?: jest.Mock; get?: jest.Mock } = {}) {
  const repo = { syncSource: jest.fn().mockResolvedValue({ upserted: 0, removed: 0 }), listFrom: jest.fn() };
  const nse = { getJson: over.getJson ?? jest.fn().mockResolvedValue([]) };
  const fundamentals = { get: over.get ?? jest.fn().mockResolvedValue({ nextEarningsDate: '2026-10-30' }) };
  const health = new SourceHealthBook();
  const svc = new EventsBuilderService(parseNewsEventsConfig({ NEWS_EVENTS_V2_ENABLED: 'observe' }), nse as never, repo as never, health, fundamentals as never);
  svc.loadFile = () => ({ version: 1, usFederalHolidays: [], eiaOverrides: [], macro: [] });
  return { svc, repo, nse, fundamentals, health };
}
const NOW = new Date('2026-10-16T02:00:00Z');
const sources = (repo: { syncSource: jest.Mock }) => repo.syncSource.mock.calls.map((c) => c[0]);

it('syncs config, EIA rules, NSE calendar, NSE corporate actions; Yahoo only for wanted symbols NSE has nothing for', async () => {
  const getJson = jest.fn()
    .mockResolvedValueOnce([{ symbol: 'TCS', purpose: 'Financial Results', date: '20-Oct-2026' }])
    .mockResolvedValueOnce([]);
  const { svc, repo, fundamentals } = harness({ getJson });
  await svc.build(NOW, ['TCS', 'INFY']);
  expect(sources(repo)).toEqual(['config/market-events.json', 'rule:eia', 'NSE event calendar', 'NSE corporate actions', 'yahoo (estimate)']);
  expect(fundamentals.get).toHaveBeenCalledTimes(1);
  expect(fundamentals.get).toHaveBeenCalledWith('INFY', 'NSE');
  expect(getJson.mock.calls[1][1]).toMatch(/from_date=16-10-2026&to_date=30-10-2026$/);
});

it('an NSE failure skips that source (stored rows kept), marks health, and the rest still syncs', async () => {
  const { svc, repo, health } = harness({ getJson: jest.fn().mockRejectedValue(new Error('NSE event-calendar: HTTP 403')) });
  await svc.build(NOW, []);
  expect(sources(repo)).toEqual(['config/market-events.json', 'rule:eia']);
  expect(health.all().filter((h) => h.source.startsWith('NSE')).map((h) => [h.source, h.consecutiveFailures])).toEqual([
    ['NSE event calendar', 1], ['NSE corporate actions', 1],
  ]);
});

it('an invalid macro file keeps the stored macro rows, still generates EIA, and reports it', async () => {
  const { svc, repo, health } = harness();
  svc.loadFile = () => { throw new Error('config/market-events.json is invalid: macro[0]: tz "X"'); };
  await svc.build(NOW, []);
  expect(sources(repo)).toEqual(['rule:eia', 'NSE event calendar', 'NSE corporate actions']);
  expect(health.all().find((h) => h.source === 'market-events.json')?.consecutiveFailures).toBe(1);
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** — `events/nse-events.ts`:
```ts
import { istAt, nseDateToYmd } from '../../market-cues/fetchers/ist-dates';
import type { MarketEventInput } from '../types';

export const NSE_EVENT_CALENDAR_URL = 'https://www.nseindia.com/api/event-calendar?index=equities';
export const nseCorporateActionsUrl = (fromDdMmYyyy: string, toDdMmYyyy: string) =>
  `https://www.nseindia.com/api/corporates-corporateActions?index=equities&from_date=${fromDdMmYyyy}&to_date=${toDdMmYyyy}`;

const s = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');
function listOf(json: unknown): Array<Record<string, unknown>> {
  const rows = Array.isArray(json) ? json : Array.isArray((json as { data?: unknown })?.data) ? (json as { data: unknown[] }).data : null;
  if (!rows) throw new Error('response is not a list');
  return rows.map((r) => (r ?? {}) as Record<string, unknown>);
}
function dedupe(xs: MarketEventInput[]): MarketEventInput[] {
  const seen = new Set<string>();
  return xs.filter((e) => {
    const k = `${e.kind}|${e.key}|${e.startsAt.toISOString()}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
/** All-day company events sit at 09:15 IST of their date (the NSE open) — minutesAway is "today" from then on. */
const dayStart = (ymd: string) => istAt(ymd, 9, 15);

export function parseEventCalendar(json: unknown): MarketEventInput[] {
  const out: MarketEventInput[] = [];
  for (const r of listOf(json)) {
    const symbol = s(r.symbol).toUpperCase();
    const purpose = s(r.purpose);
    const ymd = nseDateToYmd(s(r.date));
    if (!symbol || !purpose || !ymd) continue;
    const results = /result/i.test(`${purpose} ${s(r.bm_desc)}`);
    out.push({
      scope: 'company', kind: results ? 'results' : 'board_meeting', key: symbol,
      title: `${symbol} ${results ? 'financial results' : 'board meeting'}: ${purpose}`.slice(0, 160),
      startsAt: dayStart(ymd), allDay: true, impact: 'high', source: 'NSE event calendar', sourceRef: `${symbol}|${s(r.date)}|${purpose}`,
    });
  }
  return dedupe(out);
}

export function parseCorporateActions(json: unknown): MarketEventInput[] {
  const out: MarketEventInput[] = [];
  for (const r of listOf(json)) {
    const symbol = s(r.symbol).toUpperCase();
    const subject = s(r.subject);
    const ymd = nseDateToYmd(s(r.exDate));
    if (!symbol || !subject || !ymd) continue;
    const kind = /dividend/i.test(subject) ? 'ex_dividend' : /split|sub-division/i.test(subject) ? 'split' : /bonus/i.test(subject) ? 'bonus' : 'corporate_action';
    out.push({
      scope: 'company', kind, key: symbol, title: `${symbol} ex-date: ${subject}`.slice(0, 160),
      startsAt: dayStart(ymd), allDay: true, impact: 'medium', source: 'NSE corporate actions', sourceRef: `${symbol}|${s(r.exDate)}|${subject}`,
    });
  }
  return dedupe(out);
}

export function yahooEarningsEvent(symbol: string, raw: string | undefined): MarketEventInput | null {
  const t = s(raw);
  const ymd = /^\d{4}-\d{2}-\d{2}/.test(t) ? t.slice(0, 10) : nseDateToYmd(t);
  if (!ymd) return null;
  return {
    scope: 'company', kind: 'results', key: symbol.toUpperCase(), title: `${symbol.toUpperCase()} results (estimate)`,
    startsAt: dayStart(ymd), allDay: true, impact: 'high', source: 'yahoo (estimate)', sourceRef: `yahoo:${symbol.toUpperCase()}:${ymd}`,
  };
}
```
`events/market-events.repository.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { EventImpact, EventScope, MarketEventInput, StoredMarketEvent } from '../types';

@Injectable()
export class MarketEventsRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Replace ONE source's rows inside [from, to]: upsert what it now says, delete what it no longer says. */
  async syncSource(source: string, from: Date, to: Date, rows: readonly MarketEventInput[], now: Date): Promise<{ upserted: number; removed: number }> {
    return this.prisma.$transaction(
      async (tx) => {
        const keep = new Set(rows.map((r) => `${r.kind}|${r.key}|${r.startsAt.toISOString()}`));
        const existing = await tx.marketEvent.findMany({ where: { source, startsAt: { gte: from, lte: to } }, select: { id: true, kind: true, key: true, startsAt: true } });
        const gone = existing.filter((e) => !keep.has(`${e.kind}|${e.key}|${e.startsAt.toISOString()}`)).map((e) => e.id);
        if (gone.length > 0) await tx.marketEvent.deleteMany({ where: { id: { in: gone } } });
        for (const r of rows) {
          const data = { scope: r.scope, title: r.title, allDay: r.allDay, impact: r.impact, source: r.source, sourceRef: r.sourceRef, fetchedAt: now };
          await tx.marketEvent.upsert({
            where: { kind_key_startsAt: { kind: r.kind, key: r.key, startsAt: r.startsAt } },
            create: { ...data, kind: r.kind, key: r.key, startsAt: r.startsAt },
            update: data,
          });
        }
        return { upserted: rows.length, removed: gone.length };
      },
      { timeout: 30_000 },
    );
  }

  async listFrom(from: Date): Promise<StoredMarketEvent[]> {
    const rows = await this.prisma.marketEvent.findMany({ where: { startsAt: { gte: from } }, orderBy: { startsAt: 'asc' } });
    return rows.map((r) => ({ ...r, scope: r.scope as EventScope, impact: r.impact as EventImpact }));
  }
}
```
`events/events-builder.service.ts`:
```ts
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { istYmd } from '../../market-cues/fetchers/ist-dates';
import { FundamentalsService } from '../../fundamentals/fundamentals.service';
import { NEWS_EVENTS_CONFIG, type NewsEventsConfig } from '../config';
import { NseClient } from '../nse-client';
import { SourceHealthBook } from '../source-health';
import type { MarketEventInput } from '../types';
import { MarketEventsRepository } from './market-events.repository';
import { loadMarketEventsFile, macroEvents, scheduleEndsAt, type MarketEventsFile } from './macro-schedule';
import { NSE_EVENT_CALENDAR_URL, nseCorporateActionsUrl, parseCorporateActions, parseEventCalendar, yahooEarningsEvent } from './nse-events';
import { eiaEvents } from './rule-events';
import { ymdInTz } from './zoned-time';

const DAY = 86_400_000;
const ddmmyyyy = (ymd: string) => `${ymd.slice(8, 10)}-${ymd.slice(5, 7)}-${ymd.slice(0, 4)}`;
export interface BuildReport { synced: string[]; failed: string[] }

/** Spec §8: builds market_events from every source; each source independent; a failure keeps that source's stored rows. */
@Injectable()
export class EventsBuilderService {
  private readonly logger = new Logger(EventsBuilderService.name);
  scheduleEnds: string | null = null;
  loadFile: () => MarketEventsFile = () => loadMarketEventsFile();

  constructor(
    @Inject(NEWS_EVENTS_CONFIG) private readonly cfg: NewsEventsConfig,
    private readonly nse: NseClient,
    private readonly repo: MarketEventsRepository,
    private readonly health: SourceHealthBook,
    @Optional() private readonly fundamentals?: FundamentalsService,
  ) {}

  async build(now: Date, wantedSymbols: readonly string[]): Promise<BuildReport> {
    const report: BuildReport = { synced: [], failed: [] };
    const sync = async (source: string, from: Date, to: Date, rows: MarketEventInput[]) => {
      await this.repo.syncSource(source, from, to, rows, now);
      report.synced.push(source);
    };
    let holidays: string[] = [];
    let overrides: MarketEventsFile['eiaOverrides'] = [];
    try {
      const file = this.loadFile();
      holidays = file.usFederalHolidays;
      overrides = file.eiaOverrides;
      this.scheduleEnds = scheduleEndsAt(file);
      await sync('config/market-events.json', new Date(now.getTime() - DAY), new Date(now.getTime() + 400 * DAY), macroEvents(file));
      this.health.ok('market-events.json', file.macro.length, now);
      if (this.scheduleEnds && Date.parse(this.scheduleEnds) - now.getTime() < 30 * DAY) {
        this.logger.warn(`[market-events] macro schedule ends ${this.scheduleEnds} — extend config/market-events.json`);
      }
    } catch (err) {
      this.health.fail('market-events.json', msg(err), now);
      report.failed.push('config/market-events.json');
    }
    await sync('rule:eia', new Date(now.getTime() - DAY), new Date(now.getTime() + 15 * DAY), eiaEvents(ymdInTz(now.getTime(), 'America/New_York'), 14, holidays, overrides));

    const today = istYmd(now);
    const company = new Set<string>();
    for (const [source, label, url, parse, days] of [
      ['NSE event calendar', 'NSE event-calendar', NSE_EVENT_CALENDAR_URL, parseEventCalendar, 60],
      ['NSE corporate actions', 'NSE corporate-actions', nseCorporateActionsUrl(ddmmyyyy(today), ddmmyyyy(istYmd(new Date(now.getTime() + 14 * DAY)))), parseCorporateActions, 14],
    ] as const) {
      try {
        const rows = parse(await this.nse.getJson(label, url));
        await sync(source, new Date(now.getTime() - DAY), new Date(now.getTime() + days * DAY), rows);
        for (const r of rows) if (r.kind === 'results' || r.kind === 'board_meeting') company.add(r.key);
        this.health.ok(source, rows.length, now);
      } catch (err) {
        this.health.fail(source, msg(err), now);
        report.failed.push(source);
      }
    }

    const need = wantedSymbols.filter((sym) => !company.has(sym.toUpperCase()));
    if (this.fundamentals && need.length > 0) {
      const rows: MarketEventInput[] = [];
      for (const sym of need) {
        try {
          const e = yahooEarningsEvent(sym, (await this.fundamentals.get(sym, 'NSE')).nextEarningsDate);
          if (e) rows.push(e);
        } catch (err) {
          this.logger.debug(`[market-events] yahoo earnings for ${sym} failed: ${msg(err)}`);
        }
      }
      await sync('yahoo (estimate)', new Date(now.getTime() - DAY), new Date(now.getTime() + 120 * DAY), rows);
    }
    this.logger.log(`[market-events] built: ${report.synced.join(', ')}${report.failed.length ? `; FAILED: ${report.failed.join(', ')}` : ''}`);
    return report;
  }
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
```
(The corporate-actions window is today → today + 14 days, both IST dates; the test pins `16-10-2026` → `30-10-2026`. `wantedSymbols` comes from C3's peek-driven set, so Yahoo is asked only for symbols someone actually holds.)

- [ ] **Step 4: Run** → PASS; tsc → 174.

- [ ] **Step 5: Commit** `feat(news-events): NSE event calendar + corporate actions, Yahoo estimate fallback, market_events sync`.

---

## Task C3: `EventsService` — schedule, cache, peek (Stream C)

**Files:**
- Create: `apps/api/src/modules/news-events/events/{events-select.ts,events-select.spec.ts,events.service.ts,events.service.spec.ts,market-events.module.ts}`

**Interfaces:**
- Consumes: C1, C2; `MAX_EVENTS`, `NEWS_EVENTS_CONFIG`, `SourceHealthBook`, `EventsPeek`, `EventView`, `NewsPosition`, `StoredMarketEvent` (F1); `SessionClock`, `MARKET_HOLIDAYS`, `istAt`, `istYmd`; `EventsReader` (port).
- Produces: `horizonEnd(exchange, now, n, clock): number`, `relevant(e, p): boolean`, `expiryEvent(p, clock): StoredMarketEvent | null`, `selectEvents(all, p, now, o): EventsPeek`; `EventsService implements EventsReader` with `refresh()`, `reload()`, `peek(p, now)`, `wanted: Set<string>`; `MarketEventsModule`.

- [ ] **Step 1: Write the failing tests** — `events/events-select.spec.ts`:
```ts
import { expiryEvent, horizonEnd, selectEvents } from './events-select';
import type { NewsPosition, StoredMarketEvent } from '../types';

const clock = {
  // 2026-10-16 is a Friday; 2026-10-20 is made an NSE holiday for the test.
  isTradingDay: (ex: string, at: Date) => {
    const ymd = new Date(at.getTime() + 19_800_000).toISOString().slice(0, 10);
    const wd = new Date(`${ymd}T00:00:00Z`).getUTCDay();
    return wd !== 0 && wd !== 6 && !(ex !== 'MCX' && ymd === '2026-10-20');
  },
  tradingWindow: (ex: string) => (ex === 'MCX' ? { openMin: 540, closeMin: 1410 } : { openMin: 555, closeMin: 930 }),
};
const NOW = new Date('2026-10-16T04:00:00Z'); // 09:30 IST Fri
const ev = (o: Partial<StoredMarketEvent>): StoredMarketEvent => ({
  id: o.id ?? `${o.kind}:${o.key}`, scope: 'market', kind: 'fomc', key: 'US', title: 'x', startsAt: new Date('2026-10-16T10:00:00Z'),
  allDay: false, impact: 'high', source: 's', sourceRef: null, fetchedAt: new Date('2026-10-16T02:45:00Z'), ...o,
});
const INFY: NewsPosition = { kind: 'STOCK', underlying: 'INFY', key: 'INFY', exchange: 'NSE', expiry: null };
const CRUDE: NewsPosition = { kind: 'COMMODITY', underlying: 'CRUDEOILM', key: 'CRUDEOIL', exchange: 'MCX', expiry: '2026-10-19' };
const opts = { horizonTradingDays: 3, clock, scheduleEndsAt: '2027-03-31', sourceNotes: [], fetchedAt: '2026-10-16T02:45:00.000Z' };

it('horizon = end of the 3rd trading day, skipping weekends and holidays (Fri, Mon, Wed)', () => {
  expect(new Date(horizonEnd('NSE', NOW, 3, clock)).toISOString()).toBe('2026-10-21T18:29:59.999Z');
  expect(new Date(horizonEnd('MCX', NOW, 3, clock)).toISOString()).toBe('2026-10-20T18:29:59.999Z');
});

it('relevance: own company, IN only for Indian venues, US for all, commodity by benchmark; past timed events dropped', () => {
  const all = [
    ev({ id: 'res', scope: 'company', kind: 'results', key: 'INFY', allDay: true, startsAt: new Date('2026-10-16T03:45:00Z') }),
    ev({ id: 'other', scope: 'company', kind: 'results', key: 'TCS', allDay: true, startsAt: new Date('2026-10-16T03:45:00Z') }),
    ev({ id: 'rbi', kind: 'rbi_mpc', key: 'IN', startsAt: new Date('2026-10-19T04:30:00Z') }),
    ev({ id: 'fomc', kind: 'fomc', key: 'US', startsAt: new Date('2026-10-21T18:00:00Z') }),
    ev({ id: 'eia', scope: 'commodity', kind: 'eia_petroleum', key: 'CRUDEOIL', startsAt: new Date('2026-10-16T14:30:00Z') }),
    ev({ id: 'past', kind: 'us_cpi', key: 'US', startsAt: new Date('2026-10-16T03:59:00Z') }),
    ev({ id: 'far', kind: 'us_cpi', key: 'US', startsAt: new Date('2026-10-23T12:30:00Z') }),
  ];
  const a = selectEvents(all, INFY, NOW, opts);
  expect(a.status === 'ok' && a.events.map((e) => e.id)).toEqual(['res', 'rbi', 'fomc']);
  const c = selectEvents(all, CRUDE, NOW, opts);
  expect(c.status === 'ok' && c.events.map((e) => e.id)).toEqual(['eia', 'expiry:CRUDEOIL:2026-10-19']);
});

it('minutesAway, IST labels, all-day "today" = 0, and minutesToNextHighImpact over TIMED events only', () => {
  const all = [
    ev({ id: 'res', scope: 'company', kind: 'results', key: 'INFY', title: 'INFY results', allDay: true, startsAt: new Date('2026-10-16T03:45:00Z') }),
    ev({ id: 'now', kind: 'us_cpi', key: 'US', title: 'US CPI', startsAt: NOW }),
    ev({ id: 'nfp', kind: 'us_nfp', key: 'US', impact: 'medium', startsAt: new Date('2026-10-16T05:00:00Z') }),
  ];
  const p = selectEvents(all, INFY, NOW, opts);
  if (p.status !== 'ok') throw new Error('expected ok');
  expect(p.events.map((e) => [e.id, e.minutesAway, e.atIst])).toEqual([
    ['res', 0, '2026-10-16 (time not announced)'],
    ['now', 0, '2026-10-16 09:30 IST'],
    ['nfp', 60, '2026-10-16 10:30 IST'],
  ]);
  expect(p.minutesToNextHighImpact).toBe(0);
});

it('no timed high-impact event: null with a reason naming an all-day one', () => {
  const p = selectEvents([ev({ id: 'res', scope: 'company', kind: 'results', key: 'INFY', title: 'INFY results', allDay: true, startsAt: new Date('2026-10-19T03:45:00Z') })], INFY, NOW, opts);
  expect(p.status === 'ok' && [p.minutesToNextHighImpact, p.noHighImpactReason]).toEqual([
    null, 'no timed high-impact event in the next 3 trading days; INFY results on 2026-10-19 (time not announced)',
  ]);
});

it('≤ 5 events; notes carry an expiring macro schedule and down sources', () => {
  const many = Array.from({ length: 9 }, (_, i) => ev({ id: `e${i}`, kind: 'us_cpi', startsAt: new Date(NOW.getTime() + (i + 1) * 3_600_000) }));
  const p = selectEvents(many, INFY, NOW, { ...opts, scheduleEndsAt: '2026-11-01', sourceNotes: ['NSE event calendar unavailable'] });
  expect(p.status === 'ok' && p.events).toHaveLength(5);
  expect(p.status === 'ok' && p.notes).toEqual(['macro schedule ends 2026-11-01', 'NSE event calendar unavailable']);
});

it('expiry event at the venue close (MCX 23:30 IST)', () => {
  expect(expiryEvent(CRUDE, clock)).toMatchObject({ kind: 'expiry', scope: 'expiry', impact: 'high', startsAt: new Date('2026-10-19T18:00:00.000Z') });
  expect(expiryEvent(INFY, clock)).toBeNull();
});
```
`events/events.service.spec.ts`:
```ts
import { EventsService } from './events.service';
import { SourceHealthBook } from '../source-health';
import { parseNewsEventsConfig } from '../config';
import type { NewsPosition } from '../types';

const INFY: NewsPosition = { kind: 'STOCK', underlying: 'INFY', key: 'INFY', exchange: 'NSE', expiry: null };
const NOW = new Date('2026-10-16T04:00:00Z');

function harness(mode = 'observe') {
  const repo = { listFrom: jest.fn().mockResolvedValue([]) };
  const builder = { build: jest.fn().mockResolvedValue({ synced: [], failed: [] }), scheduleEnds: '2027-03-31' };
  const svc = new EventsService(parseNewsEventsConfig({ NEWS_EVENTS_V2_ENABLED: mode }), repo as never, builder as never, new SourceHealthBook());
  return { svc, repo, builder };
}

it('off → unavailable; before the first load → warming', () => {
  expect(harness('false').svc.peek(INFY, NOW)).toEqual({ status: 'unavailable', reason: expect.stringMatching(/NEWS_EVENTS_V2_ENABLED/) });
  const { svc } = harness();
  svc.markWarming();
  expect(svc.peek(INFY, NOW)).toEqual({ status: 'warming', reason: expect.stringMatching(/cannot see/) });
});

it('peek never awaits: a new stock key is remembered for the next build (Yahoo fallback), the build runs in the background', async () => {
  const { svc, builder } = harness();
  await svc.reload(NOW);
  const p = svc.peek(INFY, NOW);
  expect(p.status).toBe('ok');
  expect(svc.wanted.has('INFY')).toBe(true);
  await svc.refresh(NOW);
  expect(builder.build).toHaveBeenCalledWith(NOW, ['INFY']);
});

it('refresh is single-flight', async () => {
  const { svc, builder } = harness();
  let release!: () => void;
  builder.build.mockReturnValueOnce(new Promise((r) => (release = () => r({ synced: [], failed: [] }))));
  const a = svc.refresh(NOW);
  const b = svc.refresh(NOW);
  release();
  await Promise.all([a, b]);
  expect(builder.build).toHaveBeenCalledTimes(1);
});

it('peek p99 < 2 ms with 2,000 stored events', async () => {
  const { svc, repo } = harness('true');
  repo.listFrom.mockResolvedValue(Array.from({ length: 2000 }, (_, i) => ({
    id: `e${i}`, scope: 'company', kind: 'results', key: `S${i % 400}`, title: 't', startsAt: new Date(NOW.getTime() + i * 600_000),
    allDay: false, impact: 'high', source: 's', sourceRef: null, fetchedAt: NOW,
  })));
  await svc.reload(NOW);
  const times: number[] = [];
  for (let i = 0; i < 1000; i++) {
    const t0 = process.hrtime.bigint();
    svc.peek({ ...INFY, key: 'S7', underlying: 'S7' }, NOW);
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  times.sort((x, y) => x - y);
  expect(times[989]).toBeLessThan(2);
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** — `events/events-select.ts`:
```ts
import { istAt, istYmd } from '../../market-cues/fetchers/ist-dates';
import type { SessionClock } from '../../market-hub/session-clock';
import { MAX_EVENTS } from '../config';
import type { EventView, EventsPeek, NewsPosition, StoredMarketEvent } from '../types';
import { addDaysYmd, istLabel } from './zoned-time';

type Clock = Pick<SessionClock, 'isTradingDay' | 'tradingWindow'>;
export interface SelectOptions { horizonTradingDays: number; clock: Clock; scheduleEndsAt: string | null; sourceNotes: string[]; fetchedAt: string | null }

const INDIAN = new Set(['NSE', 'BSE', 'NFO', 'BFO']);
const IMPACT_RANK = { high: 0, medium: 1, low: 2 } as const;

/** End (23:59:59.999 IST) of the n-th trading day of `exchange`, counting today when it is one. */
export function horizonEnd(exchange: string, now: Date, n: number, clock: Clock): number {
  const today = istYmd(now);
  let count = 0;
  for (let i = 0; i < 30; i++) {
    const day = addDaysYmd(today, i);
    if (clock.isTradingDay(exchange, istAt(day, 12))) {
      count++;
      if (count === n) return istAt(day, 23, 59).getTime() + 59_999;
    }
  }
  return now.getTime() + 7 * 86_400_000;
}

export function relevant(e: StoredMarketEvent, p: NewsPosition): boolean {
  if (e.scope === 'company') return p.kind === 'STOCK' && e.key === p.key;
  if (e.scope === 'commodity') return p.kind === 'COMMODITY' && e.key === p.key;
  if (e.scope === 'market') return e.key === 'US' || (e.key === 'IN' && INDIAN.has(p.exchange));
  return false;
}

export function expiryEvent(p: NewsPosition, clock: Clock): StoredMarketEvent | null {
  if (!p.expiry) return null;
  const closeMin = clock.tradingWindow(p.exchange, istAt(p.expiry, 12))?.closeMin ?? (p.exchange === 'MCX' ? 23 * 60 + 30 : 15 * 60 + 30);
  return {
    id: `expiry:${p.key}:${p.expiry}`, scope: 'expiry', kind: 'expiry', key: p.key,
    title: `${p.underlying} contract expiry (${p.exchange} close)`, startsAt: istAt(p.expiry, Math.floor(closeMin / 60), closeMin % 60),
    allDay: false, impact: 'high', source: 'position contract expiry', sourceRef: null, fetchedAt: new Date(0),
  };
}

export function selectEvents(all: readonly StoredMarketEvent[], p: NewsPosition, now: Date, o: SelectOptions): EventsPeek {
  const nowMs = now.getTime();
  const end = horizonEnd(p.exchange, now, o.horizonTradingDays, o.clock);
  const today = istYmd(now);
  const exp = expiryEvent(p, o.clock);
  const cands = [...all.filter((e) => relevant(e, p)), ...(exp ? [exp] : [])]
    .filter((e) => e.startsAt.getTime() <= end && (e.allDay ? istYmd(e.startsAt) >= today : e.startsAt.getTime() >= nowMs))
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime() || IMPACT_RANK[a.impact] - IMPACT_RANK[b.impact]);
  const view = (e: StoredMarketEvent): EventView => {
    const day = istYmd(e.startsAt);
    return {
      id: e.id, kind: e.kind, scope: e.scope, title: e.title, impact: e.impact, source: e.source, allDay: e.allDay,
      atIst: e.allDay ? `${day} (time not announced)` : istLabel(e.startsAt),
      minutesAway: e.allDay && day === today ? 0 : Math.max(0, Math.round((e.startsAt.getTime() - nowMs) / 60_000)),
    };
  };
  const timedHigh = cands.filter((e) => e.impact === 'high' && !e.allDay);
  const allDayHigh = cands.find((e) => e.impact === 'high' && e.allDay);
  const minutesToNextHighImpact = timedHigh.length ? Math.max(0, Math.round((timedHigh[0].startsAt.getTime() - nowMs) / 60_000)) : null;
  const notes = [
    ...(o.scheduleEndsAt && Date.parse(o.scheduleEndsAt) - nowMs < 30 * 86_400_000 ? [`macro schedule ends ${o.scheduleEndsAt}`] : []),
    ...o.sourceNotes,
  ];
  return {
    status: 'ok',
    events: cands.slice(0, MAX_EVENTS).map(view),
    minutesToNextHighImpact,
    noHighImpactReason: minutesToNextHighImpact !== null ? null
      : `no timed high-impact event in the next ${o.horizonTradingDays} trading days` +
        (allDayHigh ? `; ${allDayHigh.title} on ${istYmd(allDayHigh.startsAt)} (time not announced)` : ''),
    notes,
    fetchedAt: o.fetchedAt,
  };
}
```
`events/events.service.ts`:
```ts
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { bootJobsEnabled } from '../../../common/utils/boot-jobs';
import { MARKET_HOLIDAYS } from '../../market-data/services/market-holidays.service';
import { SessionClock } from '../../market-hub/session-clock';
import type { EventsReader } from '../../trade-sentinel/ports/events.port';
import { NEWS_EVENTS_CONFIG, type NewsEventsConfig } from '../config';
import { SourceHealthBook } from '../source-health';
import type { EventsPeek, NewsPosition, StoredMarketEvent } from '../types';
import { EventsBuilderService } from './events-builder.service';
import { selectEvents } from './events-select';
import { MarketEventsRepository } from './market-events.repository';

const EVENT_SOURCES = ['NSE event calendar', 'NSE corporate actions', 'market-events.json'];
const CANNOT_SEE = 'scheduled events exist that this process cannot see yet; this is NOT a finding that nothing is scheduled';

/** Spec §8: daily 08:15 IST build + every 2 h; in-memory cache; `peek` synchronous, no I/O. */
@Injectable()
export class EventsService implements EventsReader, OnApplicationBootstrap {
  private readonly logger = new Logger(EventsService.name);
  private all: StoredMarketEvent[] = [];
  private state: 'off' | 'warming' | 'ready' = 'off';
  private fetchedAt: string | null = null;
  private building: Promise<void> | null = null;
  private yahooTimer: ReturnType<typeof setTimeout> | null = null;
  readonly wanted = new Set<string>();
  clock = new SessionClock({ holidays: MARKET_HOLIDAYS });

  constructor(
    @Inject(NEWS_EVENTS_CONFIG) private readonly cfg: NewsEventsConfig,
    private readonly repo: MarketEventsRepository,
    private readonly builder: EventsBuilderService,
    private readonly health: SourceHealthBook,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.cfg.computing || !bootJobsEnabled()) return;
    this.markWarming();
    void this.reload(new Date()).then(() => this.refresh(new Date()));
  }

  markWarming(): void {
    this.state = 'warming';
  }

  @Cron('0 15 8 * * *', { timeZone: 'Asia/Kolkata' })
  async daily(): Promise<void> {
    if (this.cfg.computing) await this.refresh(new Date());
  }

  @Cron('0 15 10-22/2 * * *', { timeZone: 'Asia/Kolkata' })
  async every2h(): Promise<void> {
    if (this.cfg.computing) await this.refresh(new Date());
  }

  refresh(now: Date): Promise<void> {
    if (this.building) return this.building;
    this.building = (async () => {
      try {
        await this.builder.build(now, [...this.wanted]);
        await this.reload(now);
      } catch (err) {
        this.logger.warn(`[market-events] refresh failed, serving the stored events: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        this.building = null;
      }
    })();
    return this.building;
  }

  async reload(now: Date): Promise<void> {
    this.all = await this.repo.listFrom(new Date(now.getTime() - 86_400_000));
    this.fetchedAt = this.all.reduce<string | null>((m, e) => {
      const t = e.fetchedAt.toISOString();
      return m === null || t > m ? t : m;
    }, null);
    if (this.state !== 'off' || this.cfg.computing) this.state = 'ready';
  }

  peek(p: NewsPosition, now: Date): EventsPeek {
    if (!this.cfg.computing) return { status: 'unavailable', reason: 'the events calendar is not running in this process (NEWS_EVENTS_V2_ENABLED is false)' };
    if (this.state !== 'ready') return { status: 'warming', reason: `the events calendar is still loading after a restart — ${CANNOT_SEE}` };
    if (p.kind === 'STOCK' && !this.wanted.has(p.key)) {
      this.wanted.add(p.key);
      this.scheduleYahoo();
    }
    const sourceNotes = this.health.all()
      .filter((h) => EVENT_SOURCES.includes(h.source) && h.consecutiveFailures > 0)
      .map((h) => `${h.source} unavailable since ${h.lastOkAt ?? 'boot'} — showing the events stored before`);
    return selectEvents(this.all, p, now, {
      horizonTradingDays: this.cfg.eventsHorizonTradingDays, clock: this.clock, scheduleEndsAt: this.builder.scheduleEnds,
      sourceNotes, fetchedAt: this.fetchedAt,
    });
  }

  /** A newly held stock gets its Yahoo estimate within a minute, off the hot path. */
  private scheduleYahoo(): void {
    if (this.yahooTimer) return;
    this.yahooTimer = setTimeout(() => {
      this.yahooTimer = null;
      void this.refresh(new Date());
    }, 60_000);
    this.yahooTimer.unref?.();
  }
}
```
(In the `peek p99` test the `wanted` add fires `scheduleYahoo` once; the timer is `unref`'d and harmless — call `jest.useFakeTimers()` in that test if the runner complains about open handles.)

`events/market-events.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { PrismaModule } from '../../../common/prisma/prisma.module';
import { FundamentalsModule } from '../../fundamentals/fundamentals.module';
import { NewsEventsCoreModule } from '../news-events-core.module';
import { EventsBuilderService } from './events-builder.service';
import { EventsService } from './events.service';
import { MarketEventsRepository } from './market-events.repository';

@Module({
  imports: [NewsEventsCoreModule, PrismaModule, FundamentalsModule],
  providers: [MarketEventsRepository, EventsBuilderService, EventsService],
  exports: [EventsService],
})
export class MarketEventsModule {}
```

- [ ] **Step 4: Run** `npx jest src/modules/news-events/events --ci --maxWorkers=2` → PASS; tsc → 174.

- [ ] **Step 5: Commit** `feat(news-events): EventsService — 08:15 IST build + 2-hourly refresh, 3-trading-day horizon, sync peek`.

---

## Task D1: Packet — `true` blocks via peek, `observe` shadow beside the verdict, flag-off identity (Stream D, after merging F2)

**Files:**
- Create: `apps/api/src/modules/trade-sentinel/services/{news-events-blocks.ts,news-events-blocks.spec.ts,context-packet.news-events.spec.ts}`
- Modify: `apps/api/src/modules/trade-sentinel/services/context-packet.service.ts`
- Modify: `apps/api/src/modules/trade-sentinel/repositories/sentinel-verdict.repository.ts` (+ its spec)
- Modify: `apps/api/src/modules/trade-sentinel/services/sentinel-cycle.service.ts` (+ its spec)

**Interfaces:**
- Consumes: `NEWS_INDEX`/`NewsIndexReader`, `MARKET_EVENTS`/`EventsReader` (ports, F1); `NEWS_EVENTS_CONFIG`, `NewsEventsConfig`, `newsPositionOf`, `baseSymbol`, `NewsPeek`, `EventsPeek`, `FreshItem`, `fakeNewsIndex`, `fakeEvents` (F1); `sentinel_verdicts.newsShadow` (F2).
- Produces: `newsBlocksV2(peek, at): NewsBlocksV2`, `eventsBlocks(peek, at, horizonDays): EventsBlocksV2`, `allNewsAbsent(reason)`, `allEventsAbsent(reason)`, `shadowSummary(shadow)`; `ContextPacket.news.asOf?`, `ContextPacket.events?`; `TickSnapshot.freshNews?: FreshItem[] | null`; `ContextPacketService.shadowNewsEvents(entry, tick, now?): Prisma.InputJsonValue | null`; `RecordVerdictInput.newsShadow?`.

- [ ] **Step 0: Worktree.** `git worktree add .claude/worktrees/ne-sentinel -b feature/ne-sentinel <F1 commit>`, then `git merge feature/ne-foundation` once F2 is committed; junctions; `prisma generate`; tsc → 174.

- [ ] **Step 1: Pin today's packet, on UNMODIFIED code.** Create `services/context-packet.news-events.spec.ts` with only this content (the recorded hashes ARE `main`'s packets):
```ts
import { createHash } from 'crypto';
import { ContextPacketService, type TickSnapshot } from './context-packet.service';

const T0 = new Date('2026-10-16T05:00:00.000Z'); // 10:30 IST, a Friday
const entry = (exchange: string, symbol: string) => ({
  exchange, userId: 'u1', trackerId: 't1', symbol, kind: 'POSITION' as const, ownership: 'SENTINEL' as const, watched: true, reason: '',
});
const baseTick: TickSnapshot = {
  segment: 'EQ_INTRADAY', side: 'LONG', structureSymbol: 'INFY', entryPrice: 100, qty: 100, ltp: 120, underlyingLtp: 120,
  underlyingLtpAt: null, underlyingLtpSource: 'market-data (underlying spot — live feed tick)', underlyingLtpReason: null,
  nearestSupport: null, nearestResistance: null, structureReason: null, structureAt: null, structureSource: 'signal-generator.analyze (15m level book)',
  holdingHigh: 125, holdingLow: 98, entryTime: new Date('2026-10-16T04:00:00Z'), expiry: null, volumeRatio: null, freshNewsCount: 1,
  factorValues: {}, factorsReason: null, oiWallNow: null, oiWallPrev: null, oiWallsAt: null, greenFloorArmedLatched: false,
};
export const FIXTURES: Array<[string, ReturnType<typeof entry>, TickSnapshot]> = [
  ['cash INFY', entry('NSE', 'INFY'), baseTick],
  ['NFO NIFTY option', entry('NFO', 'NIFTY28OCT2625000CE'), { ...baseTick, segment: 'OPT', structureSymbol: 'NIFTY', expiry: '2026-10-28', underlyingLtp: 25100 }],
  ['MCX CRUDEOILM future', entry('MCX', 'CRUDEOILM19NOV26FUT'), { ...baseTick, segment: 'FUT', structureSymbol: 'CRUDEOILM', expiry: '2026-11-19', ltp: 5900, underlyingLtp: 5900 }],
  ['unresolved underlying', entry('NFO', 'XYZ28OCT26100CE'), { ...baseTick, segment: 'OPT', structureSymbol: null }],
];
export const legacyRecentFor = () =>
  jest.fn().mockResolvedValue({ value: [{ title: 'legacy headline' }], source: 'news-aggregator.service (published within 6h)', at: '2026-10-16T04:00:00.000Z' });
export const sha = (x: unknown) => createHash('sha256').update(JSON.stringify(x), 'utf8').digest('hex');

beforeEach(() => jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] }).setSystemTime(T0));
afterEach(() => jest.useRealTimers());

/** sha256(JSON) of each fixture's packet on main @ 7b976b3 — recorded in Task D1 Step 1, never re-recorded. */
const MAIN_PACKET_SHA256: Record<string, string> = {};

it('FLAG OFF IS MAIN, BYTE FOR BYTE (hashes recorded on main @ 7b976b3)', async () => {
  const out: Record<string, string> = {};
  for (const [name, e, t] of FIXTURES) {
    const svc = new ContextPacketService({ recentForTracker: jest.fn().mockResolvedValue([]) } as never, { levelsFor: jest.fn().mockResolvedValue(null) } as never, { recentFor: legacyRecentFor() } as never);
    out[name] = sha(await svc.build(e as never, t));
  }
  expect(out).toEqual(MAIN_PACKET_SHA256);
});
```
Run: `cd apps/api && npx jest src/modules/trade-sentinel/services/context-packet.news-events.spec.ts --ci --maxWorkers=2` → FAIL; the diff prints the four received hashes. Paste them into `MAIN_PACKET_SHA256` and re-run → PASS. Run it twice more to confirm the hashes are stable (fixed clock). This is the only record step; from here on the constant is never edited.

- [ ] **Step 2: Write the failing tests.** Append to `context-packet.news-events.spec.ts`:
```ts
import { parseNewsEventsConfig } from '../../news-events/config';
import { fakeEvents, fakeNewsIndex } from '../../news-events/testing';
import type { EventsPeek, NewsPeek } from '../../news-events/types';

const OK_NEWS: NewsPeek = {
  status: 'ok',
  headlines: [
    { title: 'Infosys wins $1.5bn deal', source: 'ET', sentiment: 'bullish', publishedAt: '2026-10-16T04:50:00.000Z', layer: 'instrument', key: 'INFY', ageMin: 10 },
    { title: 'IT stocks drag Nifty', source: 'LiveMint', sentiment: 'bearish', publishedAt: '2026-10-16T03:00:00.000Z', layer: 'sector', key: 'NIFTY IT', ageMin: 120 },
  ],
  newestAt: '2026-10-16T04:50:00.000Z', freshCount: 1, fresh: [{ id: 'a1', title: 'Infosys wins $1.5bn deal' }],
  asOf: { lastIngestAt: '2026-10-16T04:55:00.000Z', downSources: [], stale: false },
};
const OK_EVENTS: EventsPeek = {
  status: 'ok',
  events: [{ id: 'fomc:US:x', kind: 'fomc', scope: 'market', title: 'FOMC rate decision', atIst: '2026-10-29 00:30 IST', minutesAway: 42, impact: 'high', source: 'config/market-events.json', allDay: false }],
  minutesToNextHighImpact: 42, noHighImpactReason: null, notes: [], fetchedAt: '2026-10-16T02:45:00.000Z',
};
function make(mode: string | undefined, news: NewsPeek | (() => never) = OK_NEWS, events: EventsPeek | (() => never) = OK_EVENTS) {
  const recentFor = legacyRecentFor();
  const index = fakeNewsIndex(() => (typeof news === 'function' ? news() : news));
  const cal = fakeEvents(() => (typeof events === 'function' ? events() : events));
  const svc = new ContextPacketService(
    { recentForTracker: jest.fn().mockResolvedValue([]) } as never, { levelsFor: jest.fn().mockResolvedValue(null) } as never, { recentFor } as never,
    undefined, mode === undefined ? undefined : parseNewsEventsConfig({ NEWS_EVENTS_V2_ENABLED: mode }), index as never, cal as never,
  );
  return { svc, recentFor, index, cal };
}
const boom = (): never => {
  throw new Error('must not be called');
};

describe('news & events v2 in the live packet', () => {
  it.each(['false', 'observe', 'ture'])('NEWS_EVENTS_V2_ENABLED=%s builds exactly the flag-off packet and never peeks', async (mode) => {
    for (const [, e, t] of FIXTURES) {
      const off = await make(undefined).svc.build(e as never, t);
      const m = make(mode, boom, boom);
      expect(sha(await m.svc.build(e as never, t))).toBe(sha(off));
      expect(m.index.peek).not.toHaveBeenCalled();
      expect(m.cal.peek).not.toHaveBeenCalled();
    }
  });

  it('true: layered news + events replace the legacy blocks; the legacy news shim is never called; key order', async () => {
    const m = make('true');
    const p = await m.svc.build(FIXTURES[0][1] as never, FIXTURES[0][2]);
    expect(m.recentFor).not.toHaveBeenCalled();
    expect(Object.keys(p)).toEqual(['position', 'money', 'thesis', 'structure', 'flow', 'macro', 'news', 'events', 'session', 'trigger', 'memory']);
    expect(p.news.headlines).toEqual({ available: true, value: OK_NEWS.status === 'ok' ? OK_NEWS.headlines : [], source: 'news-index (own → sector → index → market, published within 6h)', at: '2026-10-16T04:50:00.000Z' });
    expect(p.news.freshCount).toMatchObject({ available: true, value: 1 });
    expect(p.news.asOf).toMatchObject({ available: true, value: { lastIngestAt: '2026-10-16T04:55:00.000Z', downSources: [], stale: false } });
    expect(p.events?.upcoming).toMatchObject({ available: true, value: [{ kind: 'fomc', scope: 'market', title: 'FOMC rate decision', atIst: '2026-10-29 00:30 IST', minutesAway: 42, impact: 'high', source: 'config/market-events.json' }] });
    expect((p.events?.upcoming as { value: Array<Record<string, unknown>> }).value[0]).not.toHaveProperty('id');
    expect(p.events?.minutesToNextHighImpact).toMatchObject({ available: true, value: 42 });
  });

  it('true: the peeks get the resolved position (index option, MCX mini → benchmark)', async () => {
    const m = make('true');
    await m.svc.build(FIXTURES[1][1] as never, FIXTURES[1][2]);
    expect(m.index.peek.mock.calls[0][0]).toEqual({ kind: 'INDEX', underlying: 'NIFTY', key: 'NIFTY', exchange: 'NFO', expiry: '2026-10-28' });
    const c = make('true');
    await c.svc.build(FIXTURES[2][1] as never, FIXTURES[2][2]);
    expect(c.cal.peek.mock.calls[0][0]).toMatchObject({ kind: 'COMMODITY', key: 'CRUDEOIL', expiry: '2026-11-19' });
  });

  it('true: an MCX underlying with no mapping → news absent WITH the reason (never 0), events still computed', async () => {
    const m = make('true');
    const p = await m.svc.build(entry('MCX', 'STEELREBAR19NOV26FUT') as never, { ...baseTick, segment: 'FUT', structureSymbol: 'STEELREBAR', expiry: '2026-11-19' });
    for (const b of [p.news.headlines, p.news.freshCount, p.news.asOf]) expect(b).toEqual({ available: false, reason: expect.stringMatching(/STEELREBAR.*NOT a finding/) });
    expect(m.index.peek).not.toHaveBeenCalled();
    expect(m.cal.peek.mock.calls[0][0]).toMatchObject({ kind: 'COMMODITY', key: 'STEELREBAR' });
  });

  it('true: an unresolved underlying → all five blocks absent, nothing peeked', async () => {
    const m = make('true');
    const p = await m.svc.build(FIXTURES[3][1] as never, FIXTURES[3][2]);
    for (const b of [p.news.headlines, p.news.freshCount, p.news.asOf, p.events?.upcoming, p.events?.minutesToNextHighImpact]) {
      expect(b).toEqual({ available: false, reason: expect.stringMatching(/could not be resolved/) });
    }
    expect(m.index.peek).not.toHaveBeenCalled();
  });

  it('true: a warming index is "cannot see" on every news block — freshCount is NOT 0', async () => {
    const m = make('true', { status: 'warming', reason: 'the news index is still loading after a restart — headlines exist that this process cannot see yet; this is NOT a finding that nothing was published' });
    const p = await m.svc.build(FIXTURES[0][1] as never, FIXTURES[0][2]);
    expect(p.news.freshCount).toEqual({ available: false, reason: expect.stringMatching(/still loading/) });
    expect(p.news.headlines).toEqual({ available: false, reason: expect.stringMatching(/still loading/) });
  });

  it('true: a throwing peek becomes an absence naming the failed read', async () => {
    const m = make('true', boom, boom);
    const p = await m.svc.build(FIXTURES[0][1] as never, FIXTURES[0][2]);
    expect(p.news.headlines).toEqual({ available: false, reason: 'news index could not be read: must not be called' });
    expect(p.events?.upcoming).toEqual({ available: false, reason: 'events calendar could not be read: must not be called' });
  });

  it('shadowNewsEvents: the would-be blocks in observe only', () => {
    const o = make('observe');
    expect(o.svc.shadowNewsEvents(FIXTURES[0][1] as never, FIXTURES[0][2], T0)).toMatchObject({ news: { freshCount: { value: 1 } }, events: { minutesToNextHighImpact: { value: 42 } } });
    for (const mode of [undefined, 'false', 'true']) expect(make(mode).svc.shadowNewsEvents(FIXTURES[0][1] as never, FIXTURES[0][2], T0)).toBeNull();
  });
});
```
`services/news-events-blocks.spec.ts`:
```ts
import { eventsBlocks, newsBlocksV2, shadowSummary } from './news-events-blocks';
import type { EventsPeek, NewsPeek } from '../../news-events/types';

const AT = '2026-10-16T05:00:00.000Z';
const headline = (i: number, titleLen: number) => ({
  title: 'T'.repeat(titleLen), source: 'Economic Times Markets', sentiment: 'bearish', publishedAt: '2026-10-16T04:50:00.000Z',
  layer: (['instrument', 'sector', 'index', 'market'] as const)[i % 4], key: 'NIFTY PSU BANK', ageMin: 120 + i,
});
const event = (i: number, titleLen: number) => ({
  id: `e${i}`, kind: 'eia_petroleum', scope: 'commodity' as const, title: 'E'.repeat(titleLen), atIst: '2026-10-16 20:00 IST',
  minutesAway: 1000 + i, impact: 'high' as const, source: 'rule: EIA weekly petroleum status (Wed 10:30 ET)', allDay: false,
});
const news = (n: number, len: number, asOf = { lastIngestAt: AT, downSources: ['MoneyControl', 'Reuters Business'], stale: true }): NewsPeek => ({
  status: 'ok', headlines: Array.from({ length: n }, (_, i) => headline(i, len)), newestAt: AT, freshCount: 3,
  fresh: [], asOf,
});
const events = (n: number, len: number): EventsPeek => ({
  status: 'ok', events: Array.from({ length: n }, (_, i) => event(i, len)), minutesToNextHighImpact: 1000, noHighImpactReason: null,
  notes: ['macro schedule ends 2026-11-01'], fetchedAt: AT,
});
const tokens = (x: unknown) => Math.ceil(JSON.stringify(x).length / 4);

it('token budget (spec §12, plan "differs" 8): worst case ≤ 1,300, typical ≤ 700 (chars/4)', () => {
  expect(tokens({ news: newsBlocksV2(news(8, 160), AT), events: eventsBlocks(events(5, 80), AT, 3) })).toBeLessThanOrEqual(1300);
  expect(tokens({ news: newsBlocksV2(news(5, 90, { lastIngestAt: AT, downSources: [], stale: false }), AT), events: eventsBlocks(events(2, 40), AT, 3) })).toBeLessThanOrEqual(700);
});

it('stale ingestion and down sources are named — in the source when there are headlines, in the reason when there are none', () => {
  expect(newsBlocksV2(news(1, 20), AT).headlines).toMatchObject({ source: expect.stringMatching(/STALE: news as of 10:30 IST$/) });
  expect(newsBlocksV2(news(0, 20), AT).headlines).toEqual({
    available: false,
    reason: expect.stringMatching(/no headline .* last 6 hours — but news ingestion is stale \(last at 10:30 IST\) and these sources are down: MoneyControl, Reuters Business, so this may be a failure to see/),
  });
});

it('events: none in the horizon is a stated absence naming the horizon and the notes', () => {
  expect(eventsBlocks({ status: 'ok', events: [], minutesToNextHighImpact: null, noHighImpactReason: 'no timed high-impact event in the next 3 trading days', notes: [], fetchedAt: null }, AT, 3)).toEqual({
    upcoming: { available: false, reason: 'no scheduled event relevant to this position in the next 3 trading days' },
    minutesToNextHighImpact: { available: false, reason: 'no timed high-impact event in the next 3 trading days' },
  });
});

it('shadowSummary is one short log line', () => {
  expect(shadowSummary({ news: newsBlocksV2(news(4, 20), AT), events: eventsBlocks(events(2, 20), AT, 3) })).toBe(
    'headlines=4 (instrument 1, sector 1, index 1, market 1) fresh=3 events=2 nextHigh=1000m stale=true down=[MoneyControl,Reuters Business]',
  );
});
```
Repository spec (`repositories/sentinel-verdict.repository.spec.ts`) — add:
```ts
  it('writes newsShadow only when given one (observe mode); otherwise the create data is unchanged', async () => {
    const create = jest.fn().mockResolvedValue({});
    const repo = new SentinelVerdictRepository({ sentinelVerdict: { create } } as never);
    await repo.record({ ...input, newsShadow: { news: {}, events: {} } });
    expect(create.mock.calls[0][0].data.newsShadow).toEqual({ news: {}, events: {} });
    await repo.record(input);
    expect('newsShadow' in create.mock.calls[1][0].data).toBe(false);
  });
```
(`input` = the spec's existing record-input fixture; if it has another name there, use that.) Cycle spec (`services/sentinel-cycle.service.spec.ts`) — append:
```ts
describe('news & events v2 observe — the shadow is stored beside the verdict, never in it', () => {
  it('records newsShadow when the packet service returns one', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([watched('t1')]);
    const shadow = {
      news: { headlines: { available: false, reason: 'x' }, freshCount: { available: true, value: 0, source: 's', at: 'a' }, asOf: { available: false, reason: 'x' } },
      events: { upcoming: { available: false, reason: 'y' }, minutesToNextHighImpact: { available: false, reason: 'y' } },
    };
    (t.svc as unknown as { packets: Record<string, unknown> }).packets.shadowNewsEvents = jest.fn().mockReturnValue(shadow);
    await t.svc.runForUser(USER);
    expect(t.record.mock.calls[0][0].newsShadow).toEqual(shadow);
  });

  it('flag off: the record carries no newsShadow key at all', async () => {
    const t = makeSvc();
    t.build.mockResolvedValue([watched('t1')]);
    await t.svc.runForUser(USER);
    expect('newsShadow' in t.record.mock.calls[0][0]).toBe(false);
  });
});
```

- [ ] **Step 3: Run** `cd apps/api && npx jest src/modules/trade-sentinel/services/context-packet.news-events.spec.ts src/modules/trade-sentinel/services/news-events-blocks.spec.ts src/modules/trade-sentinel/repositories/sentinel-verdict.repository.spec.ts src/modules/trade-sentinel/services/sentinel-cycle.service.spec.ts --ci --maxWorkers=2` → FAIL (constructor arity, missing module, missing method).

- [ ] **Step 4: Implement.** `services/news-events-blocks.ts`:
```ts
import type { Prisma } from '@prisma/client';
import type { EventsPeek, NewsPeek } from '../../news-events/types';
import type { Block } from './context-packet.service';

type J = Prisma.InputJsonValue;
const ok = <T>(value: T, source: string, at: string): Block<T> => ({ available: true, value, source, at });
const no = (reason: string): Block<never> => ({ available: false, reason });

export const NEWS_V2_SOURCE = 'news-index (own → sector → index → market, published within 6h)';
export const FRESH_V2_SOURCE = 'news-index (own-instrument headlines in the last 30 minutes; inferred publish times excluded)';
export const ASOF_SOURCE = 'news ingestion health (last successful fetch of any source; sources failing 6+ times in a row)';
export const EVENTS_SOURCE =
  'market-events (NSE event calendar and corporate actions, Yahoo estimates, config/market-events.json, EIA rules, contract expiry)';

export interface NewsBlocksV2 { headlines: Block<J>; freshCount: Block<number>; asOf: Block<J> }
export interface EventsBlocksV2 { upcoming: Block<J>; minutesToNextHighImpact: Block<number> }

const hhmmIst = (iso: string) => new Date(Date.parse(iso) + 19_800_000).toISOString().slice(11, 16);

export function allNewsAbsent(reason: string): NewsBlocksV2 {
  return { headlines: no(reason), freshCount: no(reason), asOf: no(reason) };
}
export function allEventsAbsent(reason: string): EventsBlocksV2 {
  return { upcoming: no(reason), minutesToNextHighImpact: no(reason) };
}

/** Spec §7: the layered headlines, the 30-min own count and the ingestion health. Pure. */
export function newsBlocksV2(peek: NewsPeek | null, at: string): NewsBlocksV2 {
  if (!peek) return allNewsAbsent('the news index is not wired into this process');
  if (peek.status !== 'ok') return allNewsAbsent(peek.reason);
  const { asOf } = peek;
  const asOfText = asOf.lastIngestAt ? `${hhmmIst(asOf.lastIngestAt)} IST` : 'never';
  const problems = [
    asOf.stale ? `news ingestion is stale (last at ${asOfText})` : null,
    asOf.downSources.length ? `these sources are down: ${asOf.downSources.join(', ')}` : null,
  ].filter((x): x is string => x !== null);
  const caveat = problems.length ? ` — but ${problems.join(' and ')}, so this may be a failure to see rather than a quiet market` : '';
  return {
    headlines: peek.headlines.length
      ? ok(peek.headlines.map((h) => ({ ...h })) as unknown as J, asOf.stale ? `${NEWS_V2_SOURCE} — STALE: news as of ${asOfText}` : NEWS_V2_SOURCE, peek.newestAt ?? at)
      : no(`no headline about this instrument, its sector, its index or the market was published in the last 6 hours${caveat}`),
    freshCount: ok(peek.freshCount, FRESH_V2_SOURCE, at),
    asOf: ok({ lastIngestAt: asOf.lastIngestAt, downSources: [...asOf.downSources], stale: asOf.stale } as J, ASOF_SOURCE, asOf.lastIngestAt ?? at),
  };
}

/** Spec §8: the next ≤ 5 events (7 fields each) and the minutes to the nearest timed high-impact one. Pure. */
export function eventsBlocks(peek: EventsPeek | null, at: string, horizonDays: number): EventsBlocksV2 {
  if (!peek) return allEventsAbsent('the events calendar is not wired into this process');
  if (peek.status !== 'ok') return allEventsAbsent(peek.reason);
  const notes = peek.notes.length ? ` — ${peek.notes.join('; ')}` : '';
  return {
    upcoming: peek.events.length
      ? ok(
          peek.events.map(({ kind, scope, title, atIst, minutesAway, impact, source }) => ({ kind, scope, title, atIst, minutesAway, impact, source })) as J,
          `${EVENTS_SOURCE}${notes}`,
          peek.fetchedAt ?? at,
        )
      : no(`no scheduled event relevant to this position in the next ${horizonDays} trading days${notes}`),
    minutesToNextHighImpact:
      peek.minutesToNextHighImpact !== null
        ? ok(peek.minutesToNextHighImpact, 'market-events (timed high-impact events only)', at)
        : no(peek.noHighImpactReason ?? `no timed high-impact event in the next ${horizonDays} trading days`),
  };
}

/** One line for `[news-shadow]` (observe mode). */
export function shadowSummary(s: { news: NewsBlocksV2; events: EventsBlocksV2 }): string {
  const h = s.news.headlines;
  let head: string;
  if (h.available) {
    const items = h.value as unknown as Array<{ layer: string }>;
    const by = ['instrument', 'sector', 'index', 'market'].map((l) => [l, items.filter((x) => x.layer === l).length] as const).filter(([, n]) => n > 0);
    head = `headlines=${items.length} (${by.map(([l, n]) => `${l} ${n}`).join(', ')})`;
  } else head = `headlines absent: ${h.reason.slice(0, 80)}`;
  const fresh = s.news.freshCount.available ? `fresh=${s.news.freshCount.value}` : 'fresh=absent';
  const ev = s.events.upcoming.available ? `events=${(s.events.upcoming.value as unknown as unknown[]).length}` : 'events=0';
  const next = s.events.minutesToNextHighImpact.available ? `nextHigh=${s.events.minutesToNextHighImpact.value}m` : 'nextHigh=none';
  const a = s.news.asOf.available ? (s.news.asOf.value as unknown as { stale: boolean; downSources: string[] }) : null;
  const asOf = a ? `stale=${a.stale} down=[${a.downSources.join(',')}]` : 'asOf=absent';
  return [head, fresh, ev, next, asOf].join(' ');
}
```
`context-packet.service.ts` (smallest diff; nothing else moves):
1. Imports:
```ts
import type { Prisma } from '@prisma/client'; // already imported — keep the existing line
import { NEWS_EVENTS_CONFIG, type NewsEventsConfig } from '../../news-events/config';
import { baseSymbol, newsPositionOf } from '../../news-events/keys';
import type { EventsPeek, FreshItem, NewsPeek, NewsPosition } from '../../news-events/types';
import { MARKET_EVENTS, type EventsReader } from '../ports/events.port';
import { NEWS_INDEX, type NewsIndexReader } from '../ports/news-index.port';
import { allEventsAbsent, allNewsAbsent, eventsBlocks, newsBlocksV2, type EventsBlocksV2, type NewsBlocksV2 } from './news-events-blocks';
```
2. `TickSnapshot` — after `freshNewsCount`:
```ts
  /**
   * News & events v2 (NEWS_EVENTS_V2_ENABLED=true only): the own-instrument headlines
   * of the last 30 minutes by id, for the edge-triggered `news-hit`. Absent otherwise.
   */
  freshNews?: FreshItem[] | null;
```
3. `ContextPacket` — in `news` after `freshCount`:
```ts
    /** News & events v2 (`true` only): ingestion health. Absent key ⇒ flag off (byte-identical packet). */
    asOf?: Block<Prisma.InputJsonValue>;
```
and after the `news` member:
```ts
  /** News & events v2 (`true` only): the next scheduled events. Absent key ⇒ flag off. */
  events?: {
    upcoming: Block<Prisma.InputJsonValue>;
    minutesToNextHighImpact: Block<number>;
  };
```
4. Constructor, after `macroCues`:
```ts
    /** News & events v2 — all three optional: absent ⇒ the flag-off packet. */
    @Optional() @Inject(NEWS_EVENTS_CONFIG) private readonly newsCfg?: NewsEventsConfig,
    @Optional() @Inject(NEWS_INDEX) private readonly newsIndex?: NewsIndexReader,
    @Optional() @Inject(MARKET_EVENTS) private readonly marketEvents?: EventsReader,
```
5. In `build`, right after `const untaggable = …`: `const v2 = this.newsCfg?.rendering === true;` and change the headlines promise to
```ts
          untaggable
            ? Promise.resolve(absent(untaggable))
            : v2
              ? Promise.resolve(absent('superseded by the news-events v2 blocks'))
              : this.safely(
                  () => this.news.recentFor(structureSymbol),
                  'news-aggregator.service',
                  at,
                  'news aggregator returned nothing for this symbol',
                ),
```
Just before `return {`: `const v2b = v2 ? this.v2Blocks(entry, tick, now, at) : null;`. Replace the `news: { … }` member with
```ts
      news: v2b
        ? v2b.news
        : {
            headlines,
            freshCount: untaggable
              ? absent(untaggable)
              : numberBlock(
                  tick.freshNewsCount,
                  'news-aggregator.service (headlines in the last 30 minutes)',
                  at,
                  'no 30-minute headline count available for this symbol',
                ),
          },
      ...(v2b ? { events: v2b.events } : {}),
```
6. New private + public methods (after `readMacro`):
```ts
  /** The `true`-mode blocks: two synchronous peeks of in-memory state, never a DB or HTTP call. */
  private v2Blocks(entry: RosterEntry, tick: TickSnapshot, now: Date, at: string): { news: NewsBlocksV2; events: EventsBlocksV2 } {
    const pos = newsPositionOf(tick.structureSymbol ?? null, entry.exchange, tick.expiry);
    // An MCX underlying with no headline mapping still has events (FOMC, its expiry).
    const evPos: NewsPosition | null = !('unresolved' in pos)
      ? pos
      : tick.structureSymbol && String(entry.exchange).toUpperCase() === 'MCX'
        ? { kind: 'COMMODITY', underlying: baseSymbol(tick.structureSymbol), key: baseSymbol(tick.structureSymbol), exchange: 'MCX', expiry: tick.expiry }
        : null;
    const read = <T>(label: string, fn: () => T | null): T | { status: 'unavailable'; reason: string } | null => {
      try {
        return fn();
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        this.logger.warn(`${label} peek failed while building packet: ${m}`);
        return { status: 'unavailable', reason: `${label} could not be read: ${m}` };
      }
    };
    const news = 'unresolved' in pos ? allNewsAbsent(pos.unresolved) : newsBlocksV2(read('news index', () => this.newsIndex?.peek(pos, now) ?? null) as NewsPeek | null, at);
    const events = evPos
      ? eventsBlocks(read('events calendar', () => this.marketEvents?.peek(evPos, now) ?? null) as EventsPeek | null, at, this.newsCfg?.eventsHorizonTradingDays ?? 3)
      : allEventsAbsent('unresolved' in pos ? pos.unresolved : 'no position to look events up for');
    return { news, events };
  }

  /** OBSERVE mode only: the blocks the packet WOULD carry with the flag on (stored in sentinel_verdicts.newsShadow). */
  shadowNewsEvents(entry: RosterEntry, tick: TickSnapshot, now: Date = new Date()): Prisma.InputJsonValue | null {
    if (this.newsCfg?.mode !== 'observe') return null;
    const b = this.v2Blocks(entry, tick, now, now.toISOString());
    return { news: b.news, events: b.events } as unknown as Prisma.InputJsonValue;
  }
```
`sentinel-verdict.repository.ts`: `RecordVerdictInput` gains `newsShadow?: Prisma.InputJsonValue | null;` and `record` spreads `...(input.newsShadow !== undefined && input.newsShadow !== null ? { newsShadow: input.newsShadow } : {}),` after the `exitTrigger` spread.

`sentinel-cycle.service.ts` `judgeAndRecord`: hold the tick passed to `build` in a const (`const packetTick = { ...tick, oiWallNow: walls.now, oiWallPrev: walls.prev, oiWallsAt: wallsAt, greenFloorArmedLatched };` and pass `packetTick`), then right after the `build` call:
```ts
    // News & events v2 OBSERVE: what the packet WOULD carry — stored beside the
    // verdict, never shown to the judge. Optional call: a packets double without it is "off".
    const newsShadow = this.packets.shadowNewsEvents?.(entry, packetTick, now) ?? null;
```
after the verdict comes back: `if (newsShadow) this.logger.log(`[news-shadow] ${entry.symbol} ${verdict.verdict}: ${shadowSummary(newsShadow as never)}`);` and in `verdicts.record({ … })` add `...(newsShadow ? { newsShadow } : {}),`. Import `shadowSummary` from `./news-events-blocks`.

- [ ] **Step 5: Run** Step 3's command → PASS (the MAIN_PACKET_SHA256 test included, its constant unchanged). Then `npx jest src/modules/trade-sentinel --ci --maxWorkers=2 --testPathIgnorePatterns golden` → PASS (existing packet tests untouched: the new constructor parameters are optional). tsc → 174.

- [ ] **Step 6: Commit** `feat(trade-sentinel): news & events v2 packet blocks via peek (true), shadow beside the verdict (observe), flag-off pinned`.

---

## Task D2: Tick freshness from the index, edge-triggered `news-hit`, `event-near`, push wakes (Stream D)

**Files:**
- Modify: `apps/api/src/modules/trade-sentinel/adapters/tick-source.adapter.ts` (+ spec)
- Modify: `apps/api/src/modules/trade-sentinel/tripwires/{types.ts,news-hit.tripwire.ts,news-hit.tripwire.spec.ts}`
- Create: `apps/api/src/modules/trade-sentinel/tripwires/{event-near.tripwire.ts,event-near.tripwire.spec.ts}`
- Modify: `apps/api/src/modules/trade-sentinel/services/tripwire.service.ts` (+ spec: seven sensors)
- Create: `apps/api/src/modules/trade-sentinel/services/{news-watch-book.ts,news-watch-book.spec.ts,news-wake.service.ts,news-wake.service.spec.ts}`
- Modify: `apps/api/src/modules/trade-sentinel/services/sentinel-cycle.service.ts` (+ spec, + `ENTRIES`)
- Modify: `apps/api/src/modules/trade-sentinel/trade-sentinel.module.ts` (+ spec)

**Interfaces:**
- Consumes: D1; `NEWS_INDEX`, `MARKET_EVENTS`, `NEWS_EVENTS_CONFIG`, `newsPositionOf`, `instrumentKeysOf`, `keysOfTags`, `FRESH_WINDOW_MS`, `NewsEventsCoreModule` (F1); `SentinelRunnerService.wakeForTick(userId, why, exchange)` (existing).
- Produces: `TripwireInput.newsUnseen?: FreshItem[]`, `TripwireInput.eventNear?: { id: string; title: string; minutesAway: number } | null`; `eventNear` tripwire (`'event-near'`); `NewsWatchBook { upsert(w: NewsWatch); prune(userId, live: Set<string>); matching(keys: Iterable<string>): NewsWatch[]; size(): number }`; `NewsWakeService.start(shadow: boolean): boolean`, `.onAdded(items, now)`.

- [ ] **Step 1: Write the failing tests.** `tripwires/news-hit.tripwire.spec.ts` — add:
```ts
describe('edge mode (news & events v2 true): newsUnseen present', () => {
  const base = { freshNewsCount: 4 } as never as TripwireInput;
  it('fires on unseen ids with the newest title; ignores the 30-min count', () => {
    expect(newsHit.check({ ...base, newsUnseen: [{ id: 'a', title: 'Infosys wins $1.5bn deal' }] })).toEqual({ name: 'news-hit', detail: 'new headline on this instrument: "Infosys wins $1.5bn deal"' });
    expect(newsHit.check({ ...base, newsUnseen: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }] })?.detail).toBe('2 new headlines on this instrument, newest: "A"');
  });
  it('an empty unseen list is silent even when the 30-min count is high (already fired on them)', () => {
    expect(newsHit.check({ ...base, newsUnseen: [] })).toBeNull();
  });
});
```
`tripwires/event-near.tripwire.spec.ts`:
```ts
import { eventNear } from './event-near.tripwire';
import type { TripwireInput } from './types';

it('fires only with an eventNear input, naming the event and the minutes', () => {
  expect(eventNear.check({} as TripwireInput)).toBeNull();
  expect(eventNear.check({ eventNear: null } as never)).toBeNull();
  expect(eventNear.check({ eventNear: { id: 'e', title: 'EIA weekly petroleum status report', minutesAway: 12 } } as never)).toEqual({
    name: 'event-near', detail: 'high-impact event in 12 min: EIA weekly petroleum status report',
  });
});
```
`services/tripwire.service.spec.ts` — rename the "six sensors" test to "seven" and add `eventNear: { id: 'e', title: 'x', minutesAway: 5 },` to `everything` and `'event-near'` to the expected sorted names (between `'context-factor-flip'` and `'giveback-off-peak'`).

`services/news-watch-book.spec.ts`:
```ts
import { NewsWatchBook } from './news-watch-book';

it('matches by instrument key, prunes per user', () => {
  const b = new NewsWatchBook();
  b.upsert({ trackerId: 't1', userId: 'u1', symbol: 'INFY', exchange: 'NSE', instrumentKeys: ['I:INFY'] });
  b.upsert({ trackerId: 't2', userId: 'u1', symbol: 'NIFTY28OCT2625000CE', exchange: 'NFO', instrumentKeys: ['X:NIFTY'] });
  b.upsert({ trackerId: 't3', userId: 'u2', symbol: 'INFY', exchange: 'NSE', instrumentKeys: ['I:INFY'] });
  expect(b.matching(['I:INFY', 'M:IN']).map((w) => w.trackerId).sort()).toEqual(['t1', 't3']);
  expect(b.matching(['S:NIFTY IT', 'M:IN'])).toEqual([]);
  b.prune('u1', new Set(['t2']));
  expect(b.matching(['I:INFY']).map((w) => w.trackerId)).toEqual(['t3']);
  expect(b.size()).toBe(2);
});
```
`services/news-wake.service.spec.ts`:
```ts
import { NewsWakeService } from './news-wake.service';
import { NewsWatchBook } from './news-watch-book';
import { parseNewsEventsConfig } from '../../news-events/config';
import { article, fakeNewsIndex } from '../../news-events/testing';

const NOW = Date.UTC(2026, 9, 16, 5, 0);
const own = (id: string, over: Record<string, unknown> = {}) =>
  article({ id, title: `INFY ${id}`, publishedAt: NOW - 60_000, tags: { instruments: ['INFY'], sectors: [], indices: [], markets: [] }, ...over });

function harness(mode: string) {
  const book = new NewsWatchBook();
  book.upsert({ trackerId: 't1', userId: 'u1', symbol: 'INFY', exchange: 'NSE', instrumentKeys: ['I:INFY'] });
  const runner = { wakeForTick: jest.fn() };
  const index = fakeNewsIndex(() => ({ status: 'warming', reason: 'x' }));
  const svc = new NewsWakeService(book, runner as never, index as never, parseNewsEventsConfig({ NEWS_EVENTS_V2_ENABLED: mode }));
  const log = jest.spyOn((svc as unknown as { logger: { log: (m: string) => void } }).logger, 'log').mockImplementation(() => undefined);
  return { svc, runner, index, log };
}

describe('NewsWakeService', () => {
  it('off, or the sentinel shadow off: does not subscribe', () => {
    expect(harness('false').svc.start(true)).toBe(false);
    expect(harness('true').svc.start(false)).toBe(false);
  });

  it('true: an own-instrument headline wakes the user once (per article), with the title', () => {
    const { svc, runner } = harness('true');
    svc.onAdded([own('a')], NOW);
    svc.onAdded([own('a')], NOW + 1000);
    expect(runner.wakeForTick).toHaveBeenCalledTimes(1);
    expect(runner.wakeForTick).toHaveBeenCalledWith('u1', 'news-hit on INFY: "INFY a"', 'NSE');
  });

  it('true: a second headline inside the 5-min cooldown does not wake; after it, it does', () => {
    const { svc, runner } = harness('true');
    svc.onAdded([own('a')], NOW);
    svc.onAdded([own('b')], NOW + 4 * 60_000);
    svc.onAdded([own('c', { publishedAt: NOW + 5 * 60_000 })], NOW + 5 * 60_000 + 1);
    expect(runner.wakeForTick.mock.calls.map((c) => c[1])).toEqual(['news-hit on INFY: "INFY a"', 'news-hit on INFY: "INFY c"']);
  });

  it('never wakes on sector/index/market-only headlines, inferred dates, or anything older than 30 min (re-tag, restart)', () => {
    const { svc, runner } = harness('true');
    svc.onAdded([
      article({ id: 's', publishedAt: NOW, tags: { instruments: [], sectors: ['NIFTY IT'], indices: ['NIFTY'], markets: ['IN'] } }),
      own('inf', { dateInferred: true }),
      own('old', { publishedAt: NOW - 31 * 60_000 }),
    ], NOW);
    expect(runner.wakeForTick).not.toHaveBeenCalled();
  });

  it('observe: logs a would-wake line, never wakes', () => {
    const { svc, runner, log } = harness('observe');
    svc.onAdded([own('a')], NOW);
    expect(runner.wakeForTick).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('[news-wake] observe: would wake u1 for INFY — "INFY a"');
  });

  it('start subscribes to the index and forwards its additions', () => {
    const { svc, runner, index } = harness('true');
    expect(svc.start(true)).toBe(true);
    index.emit([own('z', { publishedAt: Date.now() - 1000 })]);
    expect(runner.wakeForTick).toHaveBeenCalledTimes(1);
    svc.onModuleDestroy();
  });
});
```
`adapters/tick-source.adapter.spec.ts` — extend `make()` options with `news?: { mode: string; peek: jest.Mock }` passed as the 10th/11th constructor arguments (`parseNewsEventsConfig({ NEWS_EVENTS_V2_ENABLED: opts.news.mode })`, `{ peek: opts.news.peek, onAdded: jest.fn() }`), and add:
```ts
  describe('news & events v2: the fresh count comes from the index when true', () => {
    const okPeek = () => jest.fn().mockReturnValue({ status: 'ok', headlines: [], newestAt: null, freshCount: 2, fresh: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }], asOf: { lastIngestAt: null, downSources: [], stale: false } });
    it('true: count and ids from the index; the aggregator is never queried', async () => {
      const peek = okPeek();
      const t = make({ news: { mode: 'true', peek } });
      const tick = await t.svc.tickFor('t1');
      expect(tick.freshNewsCount).toBe(2);
      expect(tick.freshNews).toEqual([{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }]);
      expect(t.getNewsForSymbol).not.toHaveBeenCalled();
    });
    it('true + index warming: null (no reading), no ids', async () => {
      const t = make({ news: { mode: 'true', peek: jest.fn().mockReturnValue({ status: 'warming', reason: 'x' }) } });
      const tick = await t.svc.tickFor('t1');
      expect(tick.freshNewsCount).toBeNull();
      expect(tick).not.toHaveProperty('freshNews');
    });
    it('observe: exactly the legacy read, no freshNews key', async () => {
      const peek = okPeek();
      const t = make({ news: { mode: 'observe', peek } });
      const tick = await t.svc.tickFor('t1');
      expect(t.getNewsForSymbol).toHaveBeenCalled();
      expect(peek).not.toHaveBeenCalled();
      expect(tick).not.toHaveProperty('freshNews');
    });
  });
```
`services/sentinel-cycle.service.spec.ts` — extend `makeSvc(discipline?, news?: { cfg?: NewsEventsConfig; events?: unknown; watch?: NewsWatchBook })`, passing `news?.watch, news?.cfg, news?.events` as the 11th–13th constructor arguments, and append:
```ts
describe('news & events v2 in the sensor pass', () => {
  const cfg = (mode: string) => parseNewsEventsConfig({ NEWS_EVENTS_V2_ENABLED: mode });
  const near = (minutesAway: number, over: Record<string, unknown> = {}) => ({
    status: 'ok', events: [{ id: 'eia1', kind: 'eia_petroleum', scope: 'commodity', title: 'EIA weekly petroleum status report', atIst: 'x', minutesAway, impact: 'high', source: 's', allDay: false, ...over }],
    minutesToNextHighImpact: minutesAway, noHighImpactReason: null, notes: [], fetchedAt: null,
  });
  const fresh = [{ id: 'a', title: 'A' }];

  it('false: the sensor input has neither key (byte-for-byte today\'s input)', async () => {
    const t = makeSvc(undefined, { cfg: cfg('false'), events: { peek: jest.fn(() => near(10)) } });
    t.build.mockResolvedValue([watched('t1')]);
    t.tickFor.mockResolvedValue(tick({ freshNews: fresh }));
    await t.svc.runForUser(USER);
    expect(tripwireInput(t.evaluate)).not.toHaveProperty('newsUnseen');
    expect(tripwireInput(t.evaluate)).not.toHaveProperty('eventNear');
  });

  it('true: unseen ids go in; after a news-hit fire they are seen; the next fire waits out the 5-min cooldown', async () => {
    const t = makeSvc(undefined, { cfg: cfg('true') });
    t.build.mockResolvedValue([watched('t1')]);
    t.tickFor.mockResolvedValue(tick({ freshNews: fresh }));
    t.evaluate.mockReturnValueOnce({ fires: [{ name: 'news-hit', detail: 'x' }], heartbeat: false, shouldEvaluate: true, trigger: 'FIRE' });
    const t0 = new Date('2026-10-16T05:00:00Z');
    await t.svc.runForUser(USER, t0);
    expect(tripwireInput(t.evaluate, 0).newsUnseen).toEqual(fresh);
    t.tickFor.mockResolvedValue(tick({ freshNews: [...fresh, { id: 'b', title: 'B' }] }));
    await t.svc.runForUser(USER, new Date(t0.getTime() + 60_000));
    expect(tripwireInput(t.evaluate, 1).newsUnseen).toEqual([]); // b is new but inside the cooldown
    await t.svc.runForUser(USER, new Date(t0.getTime() + 5 * 60_000));
    expect(tripwireInput(t.evaluate, 2).newsUnseen).toEqual([{ id: 'b', title: 'B' }]);
  });

  it('true: a timed high-impact event ≤ 15 min away is passed once per (tracker, event); all-day and > 15 min never', async () => {
    const peek = jest.fn().mockReturnValue(near(12));
    const t = makeSvc(undefined, { cfg: cfg('true'), events: { peek } });
    t.build.mockResolvedValue([watched('t1')]);
    t.tickFor.mockResolvedValue(tick({ structureSymbol: 'CRUDEOILM', expiry: '2026-11-19' }));
    t.evaluate.mockReturnValueOnce({ fires: [{ name: 'event-near', detail: 'x' }], heartbeat: false, shouldEvaluate: true, trigger: 'FIRE' });
    await t.svc.runForUser(USER);
    expect(tripwireInput(t.evaluate, 0).eventNear).toEqual({ id: 'eia1', title: 'EIA weekly petroleum status report', minutesAway: 12 });
    await t.svc.runForUser(USER);
    expect(tripwireInput(t.evaluate, 1).eventNear).toBeNull();
    peek.mockReturnValue(near(20, { id: 'eia2' }));
    await t.svc.runForUser(USER);
    expect(tripwireInput(t.evaluate, 2).eventNear).toBeNull();
    peek.mockReturnValue(near(5, { id: 'res', allDay: true }));
    await t.svc.runForUser(USER);
    expect(tripwireInput(t.evaluate, 3).eventNear).toBeNull();
  });

  it('observe: no new input keys; a would-fire line for the event, once', async () => {
    const t = makeSvc(undefined, { cfg: cfg('observe'), events: { peek: jest.fn().mockReturnValue(near(12)) } });
    const log = jest.spyOn((t.svc as unknown as { logger: { log: (m: string) => void } }).logger, 'log').mockImplementation(() => undefined);
    t.build.mockResolvedValue([watched('t1')]);
    t.tickFor.mockResolvedValue(tick({ structureSymbol: 'CRUDEOILM', expiry: '2026-11-19' }));
    await t.svc.runForUser(USER);
    await t.svc.runForUser(USER);
    expect(tripwireInput(t.evaluate, 0)).not.toHaveProperty('eventNear');
    expect(log.mock.calls.filter((c) => String(c[0]).startsWith('[news-wake] observe: would fire event-near'))).toHaveLength(1);
  });

  it('feeds the news watch book for the wake service (computing modes only)', async () => {
    const watch = new NewsWatchBook();
    const t = makeSvc(undefined, { cfg: cfg('observe'), watch });
    t.build.mockResolvedValue([watched('t1')]);
    t.tickFor.mockResolvedValue(tick({ structureSymbol: 'INFY' }));
    await t.svc.runForUser(USER);
    expect(watch.matching(['I:INFY']).map((w) => w.trackerId)).toEqual(['t1']);
  });
});
```
(Import `parseNewsEventsConfig`, `NewsWatchBook`, `NewsEventsConfig` at the top of the spec. If the spec's `tick()` helper's default `structureSymbol` is not a stock symbol, pass `structureSymbol: 'INFY'` explicitly where the test above relies on a stock.) Also add `join(__dirname, 'news-wake.service.ts'),` to `ENTRIES` in the reachability walk, with the comment `// News & events v2: index additions wake the runner. A production entry point, so it is walked.`

`trade-sentinel.module.spec.ts` — add an assertion that `NewsWatchBook` and `NewsWakeService` are providers (mirror the file's existing provider assertions for `TickTripwireService`).

- [ ] **Step 2: Run** `cd apps/api && npx jest src/modules/trade-sentinel --ci --maxWorkers=2 --testPathIgnorePatterns golden` → FAIL (new modules/keys missing).

- [ ] **Step 3: Implement.**

`tripwires/types.ts` — import `import type { FreshItem } from '../../news-events/types';` and add to `TripwireInput`:
```ts
  /**
   * News & events v2 (`true` only): fresh own-instrument headlines this tracker has
   * not fired on yet. PRESENT ⇒ newsHit is edge-triggered on it and ignores
   * freshNewsCount; absent ⇒ today's level-triggered rule.
   */
  newsUnseen?: FreshItem[];
  /** News & events v2 (`true` only): the nearest timed high-impact event ≤ EVENT_WAKE_LEAD_MIN away, not yet fired for this tracker. */
  eventNear?: { id: string; title: string; minutesAway: number } | null;
```
`tripwires/news-hit.tripwire.ts` — at the top of `check` (destructure `newsUnseen` too):
```ts
    if (newsUnseen !== undefined) {
      if (newsUnseen.length === 0) return null;
      const newest = newsUnseen[0].title;
      return {
        name: 'news-hit',
        detail: newsUnseen.length === 1 ? `new headline on this instrument: "${newest}"` : `${newsUnseen.length} new headlines on this instrument, newest: "${newest}"`,
      };
    }
```
`tripwires/event-near.tripwire.ts`:
```ts
import type { Tripwire, TripwireFire, TripwireInput } from './types';

/**
 * A timed high-impact event (results time, RBI, FOMC, CPI, EIA, OPEC, own expiry) is
 * minutes away. Reports WHAT is coming — never what to do: an event alone is not a
 * reason for EXIT_NOW, and the exit-discipline gate does not accept it as one.
 */
export const eventNear: Tripwire = {
  name: 'event-near',
  check({ eventNear: e }: TripwireInput): TripwireFire | null {
    if (!e) return null;
    return { name: 'event-near', detail: `high-impact event in ${e.minutesAway} min: ${e.title}` };
  },
};
```
`services/tripwire.service.ts`: import `eventNear` and append it to `ALL_TRIPWIRES` (it is silent unless the input carries `eventNear`, i.e. only with the flag `true`).

`adapters/tick-source.adapter.ts`:
- imports: `NEWS_EVENTS_CONFIG`, `NewsEventsConfig` (config), `newsPositionOf` (keys), `FreshItem` type, `NEWS_INDEX`, `NewsIndexReader` (port).
- constructor, after `discipline`: `@Optional() @Inject(NEWS_EVENTS_CONFIG) private readonly newsCfg?: NewsEventsConfig, @Optional() @Inject(NEWS_INDEX) private readonly newsIndex?: NewsIndexReader,`
- before the `Promise.all`: `const v2News = this.newsCfg?.rendering === true && structureSymbol ? this.freshFromIndex(structureSymbol, row.exchange) : null;` and the second element becomes `structureSymbol ? (v2News ? Promise.resolve(v2News.count) : this.freshNewsCount(structureSymbol, row.exchange)) : Promise.resolve(null),`
- in the returned object after `freshNewsCount,`: `...(v2News?.fresh ? { freshNews: v2News.fresh } : {}),`
- new private method:
```ts
  /** News & events v2 (`true`): the 30-min own-instrument count and ids from the index — synchronous, no DB. */
  private freshFromIndex(symbol: string, exchange?: string | null): { count: number | null; fresh: FreshItem[] | null } {
    const pos = newsPositionOf(symbol, exchange ?? null, null);
    if ('unresolved' in pos || !this.newsIndex) return { count: null, fresh: null };
    try {
      const p = this.newsIndex.peek(pos, new Date());
      return p.status === 'ok' ? { count: p.freshCount, fresh: p.fresh } : { count: null, fresh: null };
    } catch (err) {
      this.logger.warn(`fresh-news (index) failed for ${symbol}: ${err instanceof Error ? err.message : String(err)}`);
      return { count: null, fresh: null };
    }
  }
```
`services/news-watch-book.ts`:
```ts
/** Which open, watched trackers each instrument key belongs to — fed by the cycle, read by NewsWakeService. Memory only. */
export interface NewsWatch { trackerId: string; userId: string; symbol: string; exchange: string; instrumentKeys: string[] }

export class NewsWatchBook {
  private readonly byTracker = new Map<string, NewsWatch>();

  upsert(w: NewsWatch): void {
    this.byTracker.set(w.trackerId, { ...w, instrumentKeys: [...w.instrumentKeys] });
  }

  prune(userId: string, live: Set<string>): void {
    for (const [id, w] of [...this.byTracker]) if (w.userId === userId && !live.has(id)) this.byTracker.delete(id);
  }

  matching(keys: Iterable<string>): NewsWatch[] {
    const k = new Set(keys);
    return [...this.byTracker.values()].filter((w) => w.instrumentKeys.some((x) => k.has(x)));
  }

  has(trackerId: string): boolean {
    return this.byTracker.has(trackerId);
  }

  size(): number {
    return this.byTracker.size;
  }
}
```
`services/news-wake.service.ts`:
```ts
import { Inject, Injectable, Logger, Optional, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { bootJobsEnabled } from '../../../common/utils/boot-jobs';
import { FRESH_WINDOW_MS, NEWS_EVENTS_CONFIG, type NewsEventsConfig } from '../../news-events/config';
import { keysOfTags } from '../../news-events/keys';
import type { IndexedArticle } from '../../news-events/types';
import { NEWS_INDEX, type NewsIndexReader } from '../ports/news-index.port';
import { NewsWatchBook } from './news-watch-book';
import { SentinelRunnerService } from './sentinel-runner.service';

const SEEN_CAP = 500;

/**
 * Spec §9 (push, not poll). A NEW article (index `onAdded`) whose instrument-layer
 * key matches an open watched position runs that user's ordinary sensor pass now
 * (`wakeForTick` — session gate, in-flight guard and every cap apply there); the
 * pass's edge-triggered news-hit produces the fire. Once per (tracker, article);
 * at most one wake per tracker per NEWS_WAKE_COOLDOWN_MIN. Sector/index/market
 * headlines never wake (N6). `observe` logs the wake it would have made.
 * It never places, modifies or cancels anything — it can only ask for a look.
 */
@Injectable()
export class NewsWakeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NewsWakeService.name);
  private off: (() => void) | null = null;
  private readonly lastWake = new Map<string, number>();
  private readonly seen = new Map<string, Set<string>>();

  constructor(
    private readonly book: NewsWatchBook,
    private readonly runner: SentinelRunnerService,
    @Optional() @Inject(NEWS_INDEX) private readonly index?: NewsIndexReader,
    @Optional() @Inject(NEWS_EVENTS_CONFIG) private readonly cfg?: NewsEventsConfig,
    @Optional() private readonly config?: ConfigService,
  ) {}

  onModuleInit(): void {
    this.start(this.config?.get<string>('SENTINEL_SHADOW_ENABLED') === 'true');
  }

  start(shadow: boolean): boolean {
    if (!this.cfg?.computing || !this.index || !shadow || !bootJobsEnabled()) return false;
    this.off = this.index.onAdded((items) => this.onAdded(items, Date.now()));
    this.logger.log(`[news-wake] ${this.cfg.mode}: own-instrument headlines ${this.cfg.rendering ? 'wake' : 'would wake'} the judge (cooldown ${this.cfg.wakeCooldownMin}m)`);
    return true;
  }

  onModuleDestroy(): void {
    this.off?.();
    this.off = null;
  }

  onAdded(items: readonly IndexedArticle[], now: number): void {
    const cfg = this.cfg;
    if (!cfg?.computing) return;
    for (const id of [...this.seen.keys()]) if (!this.book.has(id)) this.seen.delete(id);
    for (const a of items) {
      if (a.dateInferred || now - a.publishedAt > FRESH_WINDOW_MS) continue;
      const keys = keysOfTags({ instruments: a.tags.instruments, sectors: [], indices: a.tags.indices, markets: [] });
      for (const w of this.book.matching(keys)) {
        const seen = this.seen.get(w.trackerId) ?? new Set<string>();
        this.seen.set(w.trackerId, seen);
        if (seen.has(a.id)) continue;
        seen.add(a.id);
        if (seen.size > SEEN_CAP) seen.delete(seen.values().next().value as string);
        if (!cfg.rendering) {
          this.logger.log(`[news-wake] observe: would wake ${w.userId} for ${w.symbol} — "${a.title}"`);
          continue;
        }
        if (now - (this.lastWake.get(w.trackerId) ?? -Infinity) < cfg.wakeCooldownMin * 60_000) continue;
        this.lastWake.set(w.trackerId, now);
        this.runner.wakeForTick(w.userId, `news-hit on ${w.symbol}: "${a.title}"`, w.exchange);
      }
    }
  }
}
```
(`keysOfTags` with only instruments + indices = exactly the keys an instrument rung can hold: `I:<company|benchmark>` and `X:<index>`.)

`services/sentinel-cycle.service.ts`:
- imports: `NEWS_EVENTS_CONFIG`, `type NewsEventsConfig` (config); `instrumentKeysOf`, `newsPositionOf` (keys); `MARKET_EVENTS`, `type EventsReader` (port); `NewsWatchBook` (`./news-watch-book`); `type TripwireInput` if not imported.
- `TrackerState` gains optional `newsSeen?: Set<string>; eventsFired?: Set<string>; lastNewsFireAt?: number;` (each with a one-line doc: "News & events v2 edge-trigger memory (R4)").
- constructor, after `discipline`: `@Optional() private readonly newsWatch?: NewsWatchBook, @Optional() @Inject(NEWS_EVENTS_CONFIG) private readonly newsCfg?: NewsEventsConfig, @Optional() @Inject(MARKET_EVENTS) private readonly events?: EventsReader,`
- after the `sensorBook.upsert` line:
```ts
    // News & events v2: which open positions the push-wake service may wake (memory only).
    if (this.newsWatch && this.newsCfg?.computing && tick.structureSymbol) {
      const p = newsPositionOf(tick.structureSymbol, entry.exchange, tick.expiry);
      if (!('unresolved' in p)) {
        this.newsWatch.upsert({ trackerId: entry.trackerId, userId: entry.userId, symbol: entry.symbol, exchange: String(entry.exchange).toUpperCase(), instrumentKeys: instrumentKeysOf(p) });
      }
    }
```
- just before `const rawDecision = this.tripwires.evaluate(`: `const newsIn = this.newsInputs(entry, tick, this.stateFor(entry), now);` and inside the input object, after the `noise` spread: `...newsIn,`
- right after the `evaluate(...)` call:
```ts
    this.markNewsFired(this.stateFor(entry), rawDecision.fires, newsIn, now);
```
- new private methods:
```ts
  /**
   * News & events v2 sensor inputs (R4/R5). `true`: the unseen fresh own-instrument ids
   * (empty inside the news cooldown, so a busy tape cannot fire every pass) and the
   * nearest un-fired timed high-impact event ≤ EVENT_WAKE_LEAD_MIN. `observe`: no input
   * keys — the would-be event fire is logged once instead. `false`: {}.
   */
  private newsInputs(entry: RosterEntry, tick: TickReading, st: TrackerState, now: Date): Pick<TripwireInput, 'newsUnseen' | 'eventNear'> {
    const cfg = this.newsCfg;
    if (!cfg?.computing) return {};
    const out: Pick<TripwireInput, 'newsUnseen' | 'eventNear'> = {};
    if (cfg.rendering && tick.freshNews) {
      const seen = (st.newsSeen ??= new Set<string>());
      const live = new Set(tick.freshNews.map((f) => f.id));
      for (const id of [...seen]) if (!live.has(id)) seen.delete(id);
      const cooling = now.getTime() - (st.lastNewsFireAt ?? -Infinity) < cfg.wakeCooldownMin * 60_000;
      out.newsUnseen = cooling ? [] : tick.freshNews.filter((f) => !seen.has(f.id));
    }
    const near = this.nearEvent(entry, tick, st, now, cfg.eventWakeLeadMin);
    if (cfg.rendering) out.eventNear = near;
    else if (near) {
      st.eventsFired!.add(near.id);
      this.logger.log(`[news-wake] observe: would fire event-near on ${entry.symbol}: ${near.title} in ${near.minutesAway} min`);
    }
    return out;
  }

  private nearEvent(entry: RosterEntry, tick: TickReading, st: TrackerState, now: Date, leadMin: number): { id: string; title: string; minutesAway: number } | null {
    const fired = (st.eventsFired ??= new Set<string>());
    if (!this.events || !tick.structureSymbol) return null;
    const p = newsPositionOf(tick.structureSymbol, entry.exchange, tick.expiry);
    if ('unresolved' in p) return null;
    let peek;
    try {
      peek = this.events.peek(p, now);
    } catch {
      return null;
    }
    if (peek.status !== 'ok') return null;
    const live = new Set(peek.events.map((e) => e.id));
    for (const id of [...fired]) if (!live.has(id)) fired.delete(id);
    const e = peek.events.find((x) => x.impact === 'high' && !x.allDay && x.minutesAway <= leadMin && !fired.has(x.id));
    return e ? { id: e.id, title: e.title, minutesAway: e.minutesAway } : null;
  }

  private markNewsFired(st: TrackerState, fires: TripwireFire[], newsIn: Pick<TripwireInput, 'newsUnseen' | 'eventNear'>, now: Date): void {
    if (newsIn.newsUnseen?.length && fires.some((f) => f.name === 'news-hit')) {
      const seen = (st.newsSeen ??= new Set<string>());
      for (const f of newsIn.newsUnseen) seen.add(f.id);
      st.lastNewsFireAt = now.getTime();
    }
    if (newsIn.eventNear && fires.some((f) => f.name === 'event-near')) (st.eventsFired ??= new Set<string>()).add(newsIn.eventNear.id);
  }
```
- in `prune`: after the `sensorBook?.prune` line add `for (const u of owners) this.newsWatch?.prune(u, watched);`

`trade-sentinel.module.ts`: add `NewsEventsCoreModule` to `imports` (comment: "News & events v2 config + singletons; HTTP/DB-free from here"), and `NewsWatchBook`, `NewsWakeService` to `providers` (comment: "News & events v2 push wakes. The index is reached ONLY through the NEWS_INDEX port binding (I1)").

- [ ] **Step 4: Run** `npx jest src/modules/trade-sentinel --ci --maxWorkers=2 --testPathIgnorePatterns golden` → PASS, including the reachability walk with the new entry. tsc → 174.

- [ ] **Step 5: Commit** `feat(trade-sentinel): edge-triggered news-hit, event-near, push wakes from the news index (5-min cooldown)`.

---

## Task D3: Prompt v9–v12 / v2.6–v2.9, hash pins, golden scenarios with attribution (Stream D — may run first; depends only on F1)

**Files:**
- Modify: `apps/api/src/modules/trade-sentinel/prompts/sentinel-system-prompt.ts`
- Modify: `apps/api/src/modules/trade-sentinel/services/sentinel-agent.service.ts`, `sentinel-agent.service.spec.ts`
- Modify: `apps/api/src/modules/trade-sentinel/golden/golden-fixtures.ts`, `golden/sentinel-golden.spec.ts`, `golden/__snapshots__/sentinel-golden.spec.ts.snap` (additions only)
- Create: `apps/api/src/modules/trade-sentinel/golden/news-attribution.ts`

**Interfaces:**
- Consumes: `parseNewsEventsConfig` (F1).
- Produces: `SentinelPromptOptions.news?: boolean`; constants `PRE_V9_NEWS_FIELDS`, `V9_NEWS_FIELDS`, `PRE_V9_FRESHCOUNT_LINE`, `V9_FRESHCOUNT_LINE`, `V9_NEWS_READING_LINES`, `V9_NEWS_EXIT_LINE`, `V9_NEWS_EXIT_LINE_TRIGGERS`, `V9_BLOCKS_INSERT`; stamps v9/v2.6 (discipline on, triggers off), v10/v2.7 (both off), v11/v2.8 (triggers only), v12/v2.9 (both on).

- [ ] **Step 1: Record the four news-off hashes not yet pinned directly, on UNMODIFIED code:**
```bash
cd apps/api && npx ts-node -T -e "import {sentinelSystemPrompt as s} from './src/modules/trade-sentinel/prompts/sentinel-system-prompt'; import {createHash} from 'crypto'; for (const o of [{cues:true,triggers:false,discipline:true},{cues:false,triggers:false,discipline:true},{cues:true,triggers:true,discipline:true},{cues:false,triggers:true,discipline:true}]) { const t = s(o); console.log(JSON.stringify(o), t.length, createHash('sha256').update(t,'utf8').digest('hex')); }"
```
Paste the four `(length, sha256)` pairs into the Step 2 test as `MAIN_V7`, `MAIN_V2_4`, `MAIN_V8`, `MAIN_V2_5` with the comment `/** main @ 7b976b3, recorded in news-events Task D3 Step 1. */`.

- [ ] **Step 2: Write the failing tests.** Create `golden/news-attribution.ts` (ONE copy, imported by the agent spec and the golden spec; test support only):
```ts
import {
  PRE_V9_FRESHCOUNT_LINE, PRE_V9_NEWS_FIELDS, V9_BLOCKS_INSERT, V9_FRESHCOUNT_LINE, V9_NEWS_EXIT_LINE, V9_NEWS_EXIT_LINE_TRIGGERS,
  V9_NEWS_FIELDS, V9_NEWS_READING_LINES,
} from '../prompts/sentinel-system-prompt';

/** Undo the news & events v2 edits (v9..v12 → v7, v10 → v5, …). */
export function undoNews(p: string, triggers: boolean): string {
  return p
    .replace(V9_NEWS_FIELDS, PRE_V9_NEWS_FIELDS)
    .replace(`${V9_FRESHCOUNT_LINE}\n${V9_NEWS_READING_LINES}${triggers ? V9_NEWS_EXIT_LINE_TRIGGERS : V9_NEWS_EXIT_LINE}\n`, `${PRE_V9_FRESHCOUNT_LINE}\n`)
    .replace(V9_BLOCKS_INSERT, 'news.freshCount, ');
}
```
Then append to `services/sentinel-agent.service.spec.ts` (import `undoNews` from `../golden/news-attribution` and the `V9_*` / `PRE_V9_*` constants from the prompt module):
```ts
describe('prompt v9–v12 / v2.6–v2.9 (news & events v2)', () => {
  /** main @ 7b976b3, recorded in news-events Task D3 Step 1. */
  const MAIN_V7 = { len: 0 /* paste */, sha: '' /* paste */ };
  const MAIN_V2_4 = { len: 0, sha: '' };
  const MAIN_V8 = { len: 0, sha: '' };
  const MAIN_V2_5 = { len: 0, sha: '' };

  const OFF: Array<[SentinelPromptOptions, string]> = [
    [{ cues: true, triggers: false, discipline: false }, 'v5'],
    [{ cues: false, triggers: false, discipline: false }, 'v2.2'],
    [{ cues: true, triggers: true, discipline: false }, 'v6'],
    [{ cues: false, triggers: true, discipline: false }, 'v2.3'],
    [{ cues: true, triggers: false, discipline: true }, 'v7'],
    [{ cues: false, triggers: false, discipline: true }, 'v2.4'],
    [{ cues: true, triggers: true, discipline: true }, 'v8'],
    [{ cues: false, triggers: true, discipline: true }, 'v2.5'],
  ];
  const ON: Array<[SentinelPromptOptions, string]> = [
    [{ cues: true, triggers: false, discipline: true, news: true }, 'v9'],
    [{ cues: false, triggers: false, discipline: true, news: true }, 'v2.6'],
    [{ cues: true, triggers: false, discipline: false, news: true }, 'v10'],
    [{ cues: false, triggers: false, discipline: false, news: true }, 'v2.7'],
    [{ cues: true, triggers: true, discipline: false, news: true }, 'v11'],
    [{ cues: false, triggers: true, discipline: false, news: true }, 'v2.8'],
    [{ cues: true, triggers: true, discipline: true, news: true }, 'v12'],
    [{ cues: false, triggers: true, discipline: true, news: true }, 'v2.9'],
  ];

  it.each(ON)('%j is stamped %s', (o, stamp) => expect(sentinelPromptVersion(o)).toBe(stamp));

  it('NEWS OFF IS MAIN, BYTE FOR BYTE: all eight existing texts, hash-pinned', () => {
    for (const [o] of OFF) expect(sentinelSystemPrompt({ ...o, news: false })).toBe(sentinelSystemPrompt(o));
    const pin = (o: SentinelPromptOptions, p: { len: number; sha: string }) => {
      const t = sentinelSystemPrompt(o);
      expect([t.length, sha(t)]).toEqual([p.len, p.sha]);
    };
    pin({ cues: true, triggers: false, discipline: true }, MAIN_V7);
    pin({ cues: false, triggers: false, discipline: true }, MAIN_V2_4);
    pin({ cues: true, triggers: true, discipline: true }, MAIN_V8);
    pin({ cues: false, triggers: true, discipline: true }, MAIN_V2_5);
    // v5, v2.2, v6, v2.3 stay pinned by the v7 describe above (MAIN_V5_SHA256, MAIN_V2_2_SHA256, PT_V6_SHA256, PT_V2_3_SHA256).
  });

  it('sixteen distinct texts, sixteen distinct stamps', () => {
    const all = [...OFF, ...ON];
    expect(new Set(all.map(([o]) => sentinelSystemPrompt(o))).size).toBe(16);
    expect(new Set(all.map(([, v]) => v)).size).toBe(16);
  });

  it.each(ON)('%j differs from its news-off twin ONLY by the news edits', (o) => {
    expect(undoNews(sentinelSystemPrompt(o), o.triggers)).toBe(sentinelSystemPrompt({ ...o, news: false }));
  });

  it.each(ON)('%j: the reading lines once, the exit line matching the triggers switch, the field and block lists', (o) => {
    const p = sentinelSystemPrompt(o);
    expect(p.split(V9_NEWS_READING_LINES)).toHaveLength(2);
    expect(p).toContain(o.triggers ? V9_NEWS_EXIT_LINE_TRIGGERS : V9_NEWS_EXIT_LINE);
    expect(p).toMatch(/^- news: headlines, freshCount, asOf\.$/m);
    expect(p).toMatch(/^- events: upcoming, minutesToNextHighImpact\.$/m);
    expect(p).toMatch(/^- Blocks are .*news\.asOf, events\.upcoming, events\.minutesToNextHighImpact, /m);
    expect(p).toMatch(/never a reason for EXIT_NOW/);
    if (!o.triggers) expect(p).not.toMatch(/closer exitTrigger/);
  });

  it.each([
    [{ NEWS_EVENTS_V2_ENABLED: 'true', MARKET_CUES_ENABLED: 'true' }, 'v9'],
    [{ NEWS_EVENTS_V2_ENABLED: 'true' }, 'v2.6'],
    [{ NEWS_EVENTS_V2_ENABLED: 'observe', MARKET_CUES_ENABLED: 'true' }, 'v7'],
    [{ NEWS_EVENTS_V2_ENABLED: 'ture', MARKET_CUES_ENABLED: 'true' }, 'v7'],
    [{ NEWS_EVENTS_V2_ENABLED: 'true', MARKET_CUES_ENABLED: 'true', SENTINEL_TRIGGERS_ENABLED: 'true' }, 'v12'],
  ] as const)('the agent under %j stamps %s (observe and typos are off)', async (env, stamp) => {
    const c = jest.fn().mockResolvedValue(reply(validVerdict));
    const agent = new SentinelAgentService({ messages: { create: c } } as never, { get: (k: string) => (env as Record<string, string>)[k] } as never);
    await agent.judge(packet());
    expect(agent.promptVersion).toBe(`${stamp}/${THESIS_PROMPT_VERSION}`);
  });
});
```
Golden (`golden/golden-fixtures.ts`): add nine names to `SCENARIO_NAMES` (after `'judge-heartbeat-cues-off-discipline-triggers'`):
```ts
  // News & events v2 (Task D3): every news-on prompt variant, plus observe (must equal off).
  'judge-fire-cues-on-news-discipline',
  'judge-heartbeat-cues-off-news-discipline',
  'judge-fire-cues-on-news',
  'judge-heartbeat-cues-off-news',
  'judge-fire-cues-on-news-triggers',
  'judge-heartbeat-cues-off-news-triggers',
  'judge-fire-cues-on-news-discipline-triggers',
  'judge-heartbeat-cues-off-news-discipline-triggers',
  'judge-heartbeat-cues-off-news-observe',
```
two packets after `GOLDEN_PACKET_DISCIPLINE`:
```ts
const NEWS_V2_BLOCKS = {
  news: {
    headlines: present(
      [
        { title: 'Crude jumps 3% as OPEC+ signals deeper cuts', source: 'ET Commodities', sentiment: 'bullish', publishedAt: '2026-10-16T13:40:00.000Z', layer: 'instrument', key: 'CRUDEOIL', ageMin: 20 },
        { title: 'Fed minutes show officials split on December cut', source: 'CNBC World', sentiment: 'neutral', publishedAt: '2026-10-16T11:05:00.000Z', layer: 'market', key: 'GLOBAL', ageMin: 175 },
      ] as never,
      'news-index (own → sector → index → market, published within 6h)',
      '2026-10-16T13:40:00.000Z',
    ),
    freshCount: present(1, 'news-index (own-instrument headlines in the last 30 minutes; inferred publish times excluded)', AT),
    asOf: present({ lastIngestAt: '2026-10-16T13:55:00.000Z', downSources: [], stale: false } as never, 'news ingestion health (last successful fetch of any source; sources failing 6+ times in a row)', '2026-10-16T13:55:00.000Z'),
  },
  events: {
    upcoming: present(
      [{ kind: 'eia_petroleum', scope: 'commodity', title: 'EIA weekly petroleum status report', atIst: '2026-10-21 20:00 IST', minutesAway: 3420, impact: 'high', source: 'rule: EIA weekly petroleum status (Wed 10:30 ET)' }] as never,
      'market-events (NSE event calendar and corporate actions, Yahoo estimates, config/market-events.json, EIA rules, contract expiry)',
      '2026-10-16T02:45:00.000Z',
    ),
    minutesToNextHighImpact: present(3420, 'market-events (timed high-impact events only)', AT),
  },
};
export const GOLDEN_PACKET_NEWS: ContextPacket = { ...GOLDEN_PACKET, news: NEWS_V2_BLOCKS.news, events: NEWS_V2_BLOCKS.events };
export const GOLDEN_PACKET_NEWS_DISCIPLINE: ContextPacket = { ...GOLDEN_PACKET_DISCIPLINE, news: NEWS_V2_BLOCKS.news, events: NEWS_V2_BLOCKS.events };
```
(The spread keeps `events` AFTER `memory` in key order; that is fine for the fixture — the live packet's order is pinned by D1.) Nine `judgeScenario(...)` entries after the discipline-triggers one, e.g.
```ts
  judgeScenario('judge-fire-cues-on-news-discipline', { MARKET_CUES_ENABLED: 'true', EXIT_DISCIPLINE_ENABLED: 'true', NEWS_EVENTS_V2_ENABLED: 'true' }, 'FIRE', () => jsonReply(VALID_VERDICT), GOLDEN_PACKET_NEWS_DISCIPLINE),
  judgeScenario('judge-heartbeat-cues-off-news-discipline', { EXIT_DISCIPLINE_ENABLED: 'true', NEWS_EVENTS_V2_ENABLED: 'true' }, 'HEARTBEAT', () => jsonReply(VALID_VERDICT), GOLDEN_PACKET_NEWS_DISCIPLINE),
  judgeScenario('judge-fire-cues-on-news', { MARKET_CUES_ENABLED: 'true', NEWS_EVENTS_V2_ENABLED: 'true' }, 'FIRE', () => jsonReply(VALID_VERDICT), GOLDEN_PACKET_NEWS),
  judgeScenario('judge-heartbeat-cues-off-news', { NEWS_EVENTS_V2_ENABLED: 'true' }, 'HEARTBEAT', () => jsonReply(VALID_VERDICT), GOLDEN_PACKET_NEWS),
  judgeScenario('judge-fire-cues-on-news-triggers', { MARKET_CUES_ENABLED: 'true', SENTINEL_TRIGGERS_ENABLED: 'true', NEWS_EVENTS_V2_ENABLED: 'true' }, 'FIRE', () => jsonReply(VALID_VERDICT), GOLDEN_PACKET_NEWS),
  judgeScenario('judge-heartbeat-cues-off-news-triggers', { SENTINEL_TRIGGERS_ENABLED: 'true', NEWS_EVENTS_V2_ENABLED: 'true' }, 'HEARTBEAT', () => jsonReply(VALID_VERDICT), GOLDEN_PACKET_NEWS),
  judgeScenario('judge-fire-cues-on-news-discipline-triggers', { MARKET_CUES_ENABLED: 'true', EXIT_DISCIPLINE_ENABLED: 'true', SENTINEL_TRIGGERS_ENABLED: 'true', NEWS_EVENTS_V2_ENABLED: 'true' }, 'FIRE', () => jsonReply(VALID_VERDICT), GOLDEN_PACKET_NEWS_DISCIPLINE),
  judgeScenario('judge-heartbeat-cues-off-news-discipline-triggers', { EXIT_DISCIPLINE_ENABLED: 'true', SENTINEL_TRIGGERS_ENABLED: 'true', NEWS_EVENTS_V2_ENABLED: 'true' }, 'HEARTBEAT', () => jsonReply(VALID_VERDICT), GOLDEN_PACKET_NEWS_DISCIPLINE),
  judgeScenario('judge-heartbeat-cues-off-news-observe', { NEWS_EVENTS_V2_ENABLED: 'observe' }, 'HEARTBEAT', () => jsonReply(VALID_VERDICT)),
```
In `golden/sentinel-golden.spec.ts` add a NEW describe (never rename existing ones):
```ts
describe('news & events v2 — every new scenario is attributable to the news edits alone', () => {
  const TWIN: Record<string, [string, boolean]> = {
    'judge-fire-cues-on-news-discipline': ['judge-fire-cues-on-discipline', false],
    'judge-heartbeat-cues-off-news-discipline': ['judge-heartbeat-cues-off-discipline', false],
    'judge-fire-cues-on-news': ['judge-fire-cues-on', false],
    'judge-heartbeat-cues-off-news': ['judge-heartbeat-cues-off', false],
    'judge-fire-cues-on-news-triggers': ['judge-fire-cues-on-triggers', true],
    'judge-heartbeat-cues-off-news-triggers': ['judge-heartbeat-cues-off-triggers', true],
    'judge-fire-cues-on-news-discipline-triggers': ['judge-fire-cues-on-discipline-triggers', true],
    'judge-heartbeat-cues-off-news-discipline-triggers': ['judge-heartbeat-cues-off-discipline-triggers', true],
  };
  let byName: Map<string, GoldenRecord>;
  beforeAll(async () => {
    byName = new Map((await runGoldenScenarios((rec) => recordingClient(rec))).map((r) => [r.scenario, r]));
  });

  it.each(Object.entries(TWIN))('%s = %s + the news prompt lines + the news/events packet blocks, nothing else', (name, [twin, triggers]) => {
    const r = JSON.parse(JSON.stringify(byName.get(name)!.request));
    const b = byName.get(twin)!;
    const twinPacket = JSON.parse((b.request as { messages: Array<{ content: string }> }).messages[0].content);
    r.system[0].text = undoNews(r.system[0].text, triggers);
    const pkt = JSON.parse(r.messages[0].content);
    delete pkt.events;
    pkt.news = twinPacket.news;
    r.messages[0].content = JSON.stringify(pkt);
    expect(JSON.parse(r.messages[0].content)).toEqual(twinPacket);
    r.messages[0].content = (b.request as { messages: Array<{ content: string }> }).messages[0].content;
    expect(r).toEqual(b.request);
    expect(byName.get(name)!.result).toEqual(b.result);
    expect(byName.get(name)!.logs).toEqual(b.logs);
  });

  it('observe is exactly off: same request, result and logs as judge-heartbeat-cues-off', () => {
    const o = byName.get('judge-heartbeat-cues-off-news-observe')!;
    const off = byName.get('judge-heartbeat-cues-off')!;
    expect([o.request, o.result, o.logs]).toEqual([off.request, off.result, off.logs]);
  });
});
```
(Import `undoNews` from `./news-attribution`; `GoldenRecord`, `recordingClient`, `runGoldenScenarios` are already imported at the top of the file.)

- [ ] **Step 3: Run** `cd apps/api && npx jest src/modules/trade-sentinel/services/sentinel-agent.service.spec.ts --ci --maxWorkers=2` → FAIL (constants/stamps missing).

- [ ] **Step 4: Implement** in `prompts/sentinel-system-prompt.ts`:
```ts
export const PRE_V9_NEWS_FIELDS = '- news: headlines, freshCount.';
export const V9_NEWS_FIELDS = '- news: headlines, freshCount, asOf.\n- events: upcoming, minutesToNextHighImpact.';
export const PRE_V9_FRESHCOUNT_LINE = '- news.freshCount counts headlines in the last 30 minutes.';
export const V9_FRESHCOUNT_LINE =
  "- news.freshCount counts headlines about this position's own instrument published in the last 30 minutes; an article whose publication time had to be inferred is not counted.";
/** Inserted after the news.freshCount line with news on. Ends with a newline. */
export const V9_NEWS_READING_LINES = [
  '- news.headlines lists up to 8 headlines from the last 6 hours, each with its layer, key and ageMin (minutes since publication). Layer "instrument" is about this company, commodity or index itself; "sector" is its sector or commodity group; "index" is the index it belongs to; "market" is India or global news. Weigh them in that order: an instrument headline outweighs a sector headline, which outweighs index and market headlines.',
  '- news.asOf says when news was last ingested (lastIngestAt), names the sources that are down (downSources) and whether ingestion is stale. A stale or down source means you may not see a headline that exists — never read it as "nothing happened".',
  '- events.upcoming lists the scheduled events relevant to this position in the coming trading days — results and board meetings, ex-dates, central-bank decisions, inflation and jobs data, EIA inventory reports, OPEC meetings and this contract\'s expiry — each with atIst, minutesAway and impact; "(time not announced)" means only the date is known. events.minutesToNextHighImpact is the minutes until the nearest timed high-impact event, or unavailable with the reason.',
].join('\n') + '\n';
export const V9_NEWS_EXIT_LINE = '- A headline or an upcoming event alone is never a reason for EXIT_NOW. It may justify a shorter reviewIn.';
export const V9_NEWS_EXIT_LINE_TRIGGERS = '- A headline or an upcoming event alone is never a reason for EXIT_NOW. It may justify a closer exitTrigger or a shorter reviewIn.';
export const V9_BLOCKS_INSERT = 'news.freshCount, news.asOf, events.upcoming, events.minutesToNextHighImpact, ';
```
`SentinelPromptOptions` gains `/** NEWS_EVENTS_V2_ENABLED === 'true' (observe and typos are off): the v9 news & events lines. */ news?: boolean;`. Add
```ts
const VERSIONS_NEWS: Record<'off' | 'trg' | 'ed' | 'ed+trg', { cues: string; noCues: string }> = {
  off: { cues: 'v10', noCues: 'v2.7' },
  trg: { cues: 'v11', noCues: 'v2.8' },
  ed: { cues: 'v9', noCues: 'v2.6' },
  'ed+trg': { cues: 'v12', noCues: 'v2.9' },
};
```
and in `sentinelPromptVersion` pick `const table = o.news ? VERSIONS_NEWS : VERSIONS;`. In `renderPrompt` (signature becomes `Pick<SentinelPromptOptions, 'triggers' | 'discipline' | 'news'>`), make exactly three substitutions:
  1. the field-list line `- news: headlines, freshCount.` → `${o.news ? V9_NEWS_FIELDS : PRE_V9_NEWS_FIELDS}`;
  2. the blocks line → `${withNewsBlocks(o.discipline ? V7_BLOCKS_LINE : PRE_V7_BLOCKS_LINE, !!o.news)}` with `const withNewsBlocks = (line: string, on: boolean) => (on ? line.replace('news.freshCount, ', V9_BLOCKS_INSERT) : line);`
  3. the line `- news.freshCount counts headlines in the last 30 minutes.` → `${o.news ? V9_FRESHCOUNT_LINE : PRE_V9_FRESHCOUNT_LINE}` followed on the next template line by `${o.news ? `${V9_NEWS_READING_LINES}${o.triggers ? V9_NEWS_EXIT_LINE_TRIGGERS : V9_NEWS_EXIT_LINE}\n` : ''}` placed immediately before `- session.nowIst is IST wall-clock text…` (no extra newline when off).
Extend the version-history comment above `SENTINEL_PROMPT_VERSION` with the v9–v12 / v2.6–v2.9 rows (copy the spec §10 table) and one sentence: "news is ON only for NEWS_EVENTS_V2_ENABLED exactly `true`; `observe` and typos render the news-off text and stamp". `SENTINEL_PROMPT_VERSION` / `SENTINEL_SYSTEM_PROMPT` constants stay `v7` (the default deploy is news off).

`services/sentinel-agent.service.ts` `promptOptions` adds `news: parseNewsEventsConfig({ NEWS_EVENTS_V2_ENABLED: this.config?.get<string>('NEWS_EVENTS_V2_ENABLED') ?? undefined }).rendering,` (import `parseNewsEventsConfig` from `../../news-events/config`).

- [ ] **Step 5: Run** the agent spec → PASS (the eight existing hash/stamp tests unchanged). Then regenerate the golden snapshot with ADDITIONS ONLY:
```bash
cd apps/api && npx jest src/modules/trade-sentinel/golden --maxWorkers=2 -u
```
Expected: `9 snapshots written`, **0 updated, 0 removed**. Verify `git diff --stat apps/api/src/modules/trade-sentinel/golden/__snapshots__/` shows insertions only (`git diff -U0 … | grep '^-[^-]' | wc -l` → `0`). Then `npx jest src/modules/trade-sentinel/golden --ci --maxWorkers=2` → PASS, including the attribution describe. If any existing snapshot changes, STOP: something in the news-off path moved.

- [ ] **Step 6: Commit** with an attribution body:
```
feat(trade-sentinel): prompt v9–v12 / v2.6–v2.9 — layered news, asOf, events; an event alone is never EXIT_NOW

News is ON only for NEWS_EVENTS_V2_ENABLED=true (observe/typo = off). Stamps:
discipline on/triggers off v9 v2.6 (target), off/off v10 v2.7, triggers only
v11 v2.8, both v12 v2.9. News off: all eight existing texts byte-identical
(v5 v2.2 v6 v2.3 pinned before; v7 v2.4 v8 v2.5 now pinned: <paste the 4 hashes>).

Golden: 9 scenarios added, 0 existing snapshots changed. Attribution (test
"news & events v2 — every new scenario is attributable"): each news scenario
equals its twin after undoing exactly the news edits — field list (+asOf,
+events line), blocks line insert, freshCount line, 3 reading lines + 1 exit
line — and swapping only packet.news/packet.events. Observe scenario ==
judge-heartbeat-cues-off (request, result, logs).

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```

---

## Task I1: Integration — merge, wire the ports, end-to-end test (integration branch)

**Files:**
- Modify: `apps/api/src/modules/trade-sentinel/trade-sentinel.module.ts` (+ `trade-sentinel.module.spec.ts`)
- Create: `apps/api/src/modules/trade-sentinel/services/news-events.e2e.spec.ts`

**Interfaces:** Consumes everything; produces the production wiring `NEWS_INDEX → NewsIndexService`, `MARKET_EVENTS → EventsService`.

- [ ] **Step 1: Branch and merge, in dependency order.**
```bash
cd C:/Users/AryanKumar/Desktop/GrW
git worktree add .claude/worktrees/ne-integration -b feature/news-events docs/news-events
cd .claude/worktrees/ne-integration
git merge --no-ff feature/ne-foundation -m "Merge feature/ne-foundation (news-events F)"
git merge --no-ff feature/ne-ingest -m "Merge feature/ne-ingest (news-events A)"
git merge --no-ff feature/ne-index -m "Merge feature/ne-index (news-events B)"
git merge --no-ff feature/ne-events -m "Merge feature/ne-events (news-events C)"
git merge --no-ff feature/ne-sentinel -m "Merge feature/ne-sentinel (news-events D)"
```
(each merge message also ends with the Co-Authored-By line). Expected conflicts: none (Conflict map). If `keys.ts` conflicts (A2 appended MCX names), keep A2's version.

- [ ] **Step 2: Write the failing tests.** `trade-sentinel.module.spec.ts` — add, in the file's own style:
```ts
  it('binds the news & events v2 ports to the real services, through the composition root only', () => {
    const p = (token: string) => moduleMeta<Provider>('providers').find((x) => typeof x === 'object' && (x as { provide?: unknown }).provide === token) as { useExisting?: { name?: string } } | undefined;
    expect(p(NEWS_INDEX)?.useExisting?.name).toBe('NewsIndexService');
    expect(p(MARKET_EVENTS)?.useExisting?.name).toBe('EventsService');
    expect(moduleMeta<{ name?: string }>('imports').map((m) => m?.name)).toEqual(expect.arrayContaining(['NewsEventsCoreModule', 'NewsIndexModule', 'MarketEventsModule']));
  });
```
`services/news-events.e2e.spec.ts` (real index, real events service, real packet service — only Prisma is faked):
```ts
import { ContextPacketService } from './context-packet.service';
import { NewsIndexService } from '../../news-events/index/news-index.service';
import { EventsService } from '../../news-events/events/events.service';
import { InProcessNewsIngestBus } from '../../news-events/ingest-bus';
import { SourceHealthBook } from '../../news-events/source-health';
import { parseNewsEventsConfig } from '../../news-events/config';

const NOW = new Date('2026-10-16T05:00:00.000Z');
const cfg = parseNewsEventsConfig({ NEWS_EVENTS_V2_ENABLED: 'true' });
const row = (id: string, minsAgo: number, tags: Partial<Record<'instruments' | 'sectors' | 'indices' | 'markets', string[]>>) => ({
  id, title: `t ${id}`, source: 'ET', sentiment: 'neutral', publishedAt: new Date(NOW.getTime() - minsAgo * 60_000), fetchedAt: NOW, dateInferred: false,
  instruments: [], sectors: [], indices: [], markets: [], ...tags,
});

it('true, end to end: layered news and events from memory, zero DB reads while building, p99 < 5 ms', async () => {
  const newsFind = jest.fn().mockResolvedValueOnce([
    row('own', 5, { instruments: ['INFY'] }), row('sec', 30, { sectors: ['NIFTY IT'] }), row('idx', 40, { indices: ['NIFTY'] }), row('mkt', 50, { markets: ['GLOBAL'] }),
  ]);
  const health = new SourceHealthBook();
  health.ok('ET', 4, NOW);
  const index = new NewsIndexService({ newsArticle: { findMany: newsFind } } as never, cfg, new InProcessNewsIngestBus(), health, { sectorOf: (s: string) => (s === 'INFY' ? 'NIFTY IT' : null) } as never);
  index.now = () => NOW.getTime();
  await index.start();
  index.onModuleDestroy();
  const listFrom = jest.fn().mockResolvedValue([
    { id: 'r', scope: 'company', kind: 'results', key: 'INFY', title: 'INFY financial results: Financial Results', startsAt: new Date('2026-10-16T03:45:00Z'), allDay: true, impact: 'high', source: 'NSE event calendar', sourceRef: null, fetchedAt: NOW },
    { id: 'f', scope: 'market', kind: 'fomc', key: 'US', title: 'FOMC rate decision', startsAt: new Date('2026-10-16T05:42:00Z'), allDay: false, impact: 'high', source: 'config/market-events.json', sourceRef: null, fetchedAt: NOW },
  ]);
  const events = new EventsService(cfg, { listFrom } as never, { build: jest.fn(), scheduleEnds: '2027-03-31' } as never, health);
  await events.reload(NOW);
  const svc = new ContextPacketService(
    { recentForTracker: jest.fn().mockResolvedValue([]) } as never, { levelsFor: jest.fn().mockResolvedValue(null) } as never,
    { recentFor: jest.fn(() => { throw new Error('legacy news read on the hot path'); }) } as never,
    undefined, cfg, index, events,
  );
  const reads = newsFind.mock.calls.length + listFrom.mock.calls.length;
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] }).setSystemTime(NOW);
  const entry = { exchange: 'NSE', userId: 'u1', trackerId: 't1', symbol: 'INFY', kind: 'POSITION', ownership: 'SENTINEL', watched: true, reason: '' };
  const tick = { segment: 'EQ_INTRADAY', side: 'LONG', structureSymbol: 'INFY', entryPrice: 100, qty: 1, ltp: 101, underlyingLtp: 101, underlyingLtpAt: null,
    underlyingLtpSource: 's', underlyingLtpReason: null, nearestSupport: null, nearestResistance: null, structureReason: null, structureAt: null,
    structureSource: 's', holdingHigh: null, holdingLow: null, entryTime: NOW, expiry: null, volumeRatio: null, freshNewsCount: null,
    factorValues: {}, factorsReason: null, oiWallNow: null, oiWallPrev: null, oiWallsAt: null, greenFloorArmedLatched: false };
  const p = await svc.build(entry as never, tick as never);
  jest.useRealTimers();
  expect((p.news.headlines as { value: Array<{ layer: string }> }).value.map((h) => h.layer)).toEqual(['instrument', 'sector', 'index', 'market']);
  expect(p.news.freshCount).toMatchObject({ value: 1 });
  expect((p.events!.upcoming as { value: Array<{ kind: string }> }).value.map((e) => e.kind)).toEqual(['results', 'fomc']);
  expect(p.events!.minutesToNextHighImpact).toMatchObject({ value: 42 });
  expect(newsFind.mock.calls.length + listFrom.mock.calls.length).toBe(reads);

  const times: number[] = [];
  const v2 = (svc as unknown as { v2Blocks: (e: unknown, t: unknown, n: Date, a: string) => unknown }).v2Blocks.bind(svc);
  for (let i = 0; i < 1000; i++) {
    const t0 = process.hrtime.bigint();
    v2(entry, tick, NOW, NOW.toISOString());
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  times.sort((a, b) => a - b);
  expect(times[989]).toBeLessThan(5);
});
```

- [ ] **Step 3: Run** both specs → FAIL (ports unbound).

- [ ] **Step 4: Implement** in `trade-sentinel.module.ts`: import `NewsEventsCoreModule` (already from D2), `NewsIndexModule`, `MarketEventsModule`, `NewsIndexService`, `EventsService`, `NEWS_INDEX`, `MARKET_EVENTS`; add the two modules to `imports` (comment: "News & events v2 (docs/superpowers/specs/2026-10-16-news-events-design.md): the in-memory news index and events calendar. HTTP to news/NSE/Yahoo and DB reads live there; the cycle sees only the two ports below."), and to `providers`:
```ts
    // News & events v2: the packet, the tick source and the wake service read these
    // through type-only ports — `peek` is synchronous, no I/O.
    { provide: NEWS_INDEX, useExisting: NewsIndexService },
    { provide: MARKET_EVENTS, useExisting: EventsService },
```
Update the class comment's port list ("six interfaces" → name `NewsIndexReader` and `EventsReader` too).

- [ ] **Step 5: Verify.** `cd apps/api && npx prisma generate && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -c "error TS"` → **174**. `npx jest src/modules/news-events src/modules/news src/modules/trade-sentinel --ci --maxWorkers=2` → PASS. The module spec and the e2e spec are the wiring proof (no task boots the app against a database).

- [ ] **Step 6: Commit** `feat(trade-sentinel): wire NEWS_INDEX and MARKET_EVENTS to the news & events v2 services; end-to-end packet test` (explicit paths).

---

## Task I2: Full suite, whole-branch review, release notes (integration branch)

- [ ] **Step 1: Full suite** — `cd apps/api && npx jest --ci --maxWorkers=2` → all green (NEVER default workers). Record suites/tests counts before (on `main`) and after in the merge-review commit body. `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -c "error TS"` → 174. `cd apps/web && npx tsc --noEmit -p tsconfig.json` → unchanged (no web change in this plan).

- [ ] **Step 2: Safety greps** (paste outputs in the commit body):
```bash
git diff main...HEAD --stat -- apps/api/src/modules/sentinel-executor apps/api/src/modules/exit-discipline   # → empty
git diff main...HEAD -- apps/api/src | grep -E "^\+.*(placeOrder|cancelOrder|modifyOrder|squareOff)" # → empty
git diff main...HEAD -- apps/api/src | grep -nE "^\+.*(logger|console)\.[a-z]+\(.*(cookie|Cookie)" # → only the warm-up count line
```

- [ ] **Step 3: Whole-branch review.** Invoke `superpowers:requesting-code-review` on `main...feature/news-events` with the spec, this plan, and the Review Focus list. Reviewer must check, at minimum: flag-off byte identity (D1 hashes, D3 hashes, golden 0 updated), observe = off for packet/prompt/tripwire inputs, `rebuild emits nothing`, no `await` on the packet path, the import walk includes `news-wake.service.ts`, NSE politeness (single `NseClient` instance, serial queue, no cookie in logs), every new `@Cron` gated by `cfg.computing`, every new `setInterval` `unref`'d and cleared. Fix findings with `superpowers:receiving-code-review`; re-run Step 1.

- [ ] **Step 4: Release notes** in the final commit body: env keys, the three modes, log prefixes, what `observe` stores (`sentinel_verdicts.newsShadow`), rollback (`NEWS_EVENTS_V2_ENABLED=false` + restart; migration is expand-only and stays). Then `superpowers:finishing-a-development-branch` — do NOT push; the owner deploys.

---

## Production Gate

**Before deploy (lead + owner, on the VPS):**
1. Re-run the M0 probe from the server (its egress is what matters): `cd /opt/grw/app/apps/api && npx ts-node scripts/news-source-check.ts --nse`. Every source still in `RSS_SOURCES` must say `KEEP`; if one says `REMOVE`, drop it in a follow-up commit before `observe`. The NSE lines tell whether the announcements/calendar endpoints answer from the VPS (and whether the N4 warm-up was needed — look for `[nse-client] warm-up:`).
2. Volume: `SELECT date_trunc('day',"fetchedAt") d, count(*) FROM news_articles WHERE "fetchedAt" > now() - interval '30 days' GROUP BY 1 ORDER BY 2 DESC LIMIT 3;` — the busiest day × 2 must stay under `NEWS_INDEX_MAX_ITEMS` (5,000) over 24 h; if not, raise it (≤ 20,000) before `observe`.
3. `config/market-events.json` has macro entries at least 30 days ahead (boot warns otherwise).

**Deploy** (migration `20261016120000_news_events_v2` runs via the normal `prisma migrate deploy`). Verify:
```sql
SELECT column_name FROM information_schema.columns WHERE table_name='news_articles' AND column_name IN ('instruments','sectors','indices','markets','tagVersion','dateInferred'); -- 6 rows
SELECT to_regclass('market_events'), to_regclass('instrument_name_aliases');                                                                -- both non-null
SELECT column_name FROM information_schema.columns WHERE table_name='sentinel_verdicts' AND column_name='newsShadow';                      -- 1 row
```
With the flag still `false`, the only new boot line is `[news-events] mode=false …`; nothing else in this feature logs.

**Switch to `observe`** — add to `/opt/grw/env/api.env` (explicit, even where equal to defaults) and restart:
```
NEWS_EVENTS_V2_ENABLED=observe
NEWS_NSE_ANN_CADENCE_MIN=3
NEWS_INDEX_HOURS=24
NEWS_INDEX_MAX_ITEMS=5000
NEWS_WAKE_COOLDOWN_MIN=5
EVENT_WAKE_LEAD_MIN=15
EVENTS_HORIZON_TRADING_DAYS=3
```
Boot lines to see (and NO `[news-events] … is out of range` / `is not false|observe|true` warning):
- `[news-events] mode=observe nseAnn=3m index=24h/5000 wakeCooldown=5m eventLead=15m horizon=3 trading days`
- `[news-tag] sector map: N symbols` (N ≈ 500), `[news-tag] name matcher: N aliases (~K KB)` (after `[news-tag] aliases refreshed from EQUITY_L: N` on first boot), no `[news-tag] MCX underlying(s) without a news mapping` line (if present: add the names, Task A2 rule)
- `[news-index] ready: N items, K keys, built in Xms`
- `[market-events] built: config/market-events.json, rule:eia, NSE event calendar, NSE corporate actions[, yahoo (estimate)]` — a `FAILED:` suffix names a source to investigate
- `[news-wake] observe: own-instrument headlines would wake the judge (cooldown 5m)`
- `[news-tag] re-tagged N article(s) from the last 48 h to v1` (first boot only)

**Observe for 2–3 trading days** — check daily:
- Ingestion health: `[news-source] … DOWN (6 consecutive)` lines (a source down all day → remove it); `[news-ann] N new NSE announcement(s)` during 09:00–17:30; `[nse-client] … failed` lines should be rare and back off (never more than one per endpoint per backoff window).
- Tag quality (false positives are the risk): `SELECT title, instruments, sectors, indices, markets FROM news_articles WHERE "fetchedAt" > now() - interval '1 day' AND "tagVersion" = 1 ORDER BY random() LIMIT 50;` — read every row; any wrong company tag → add the alias to `BLOCKED_ALIASES` (Task A3 file) in a follow-up; any wrong commodity/index tag → tighten its pattern + a test.
- Would-wakes: `[news-wake] observe: would wake …` and `[news-wake] observe: would fire event-near …` — expect a handful per position per day; a storm (dozens/hour on one position) means a tagging problem, not news.
- Would-be blocks: `SELECT "createdAt", symbol, "newsShadow"->'news'->'headlines'->'available' AS h, jsonb_array_length(COALESCE("newsShadow"->'news'->'headlines'->'value','[]')) AS n, "newsShadow"->'events'->'minutesToNextHighImpact' AS next FROM sentinel_verdicts WHERE "newsShadow" IS NOT NULL ORDER BY "createdAt" DESC LIMIT 30;` and the `[news-shadow] SYMBOL VERDICT: headlines=… fresh=… events=… nextHigh=… stale=… down=[…]` lines — headlines present on most positions in session, `stale=false` in session, events present for results/expiry days.
- Packet/prompt unchanged in observe: `SELECT DISTINCT "promptVersion" FROM sentinel_verdicts WHERE "createdAt" > now() - interval '1 day';` → still `v7/t1` (or `v2.4/t1`); `SELECT count(*) FROM sentinel_verdicts WHERE "createdAt" > now() - interval '1 day' AND packet->'events' IS NOT NULL;` → 0.
- Memory: the API container's RSS should not grow by more than ~10–15 MB vs before (`docker stats`).

**Switch to `true`** (owner's shadow sentinel first): set `NEWS_EVENTS_V2_ENABLED=true`, restart. See `[news-wake] true: own-instrument headlines wake the judge (cooldown 5m)`; `promptVersion` becomes `v9/t1` (cues on, discipline on, triggers off) or the matching stamp from spec §10; `packet->'events'` present; `[sentinel-tick] waking <user>: news-hit on SYMBOL: "…"` lines appear for own-instrument headlines; `triggeredBy` contains `news-hit` / `event-near` on some verdicts. Rollback: `NEWS_EVENTS_V2_ENABLED=false` + restart (packet/prompt return to v7 byte-for-byte; the tables stay).

## Open Questions (defaults stated)

1. **NSE-announcement rows carry `relatedSymbols = []`** so the legacy packet never changes in `observe`; the news page's symbol filter therefore does not show them. *Default: accept; after `true` has run a week, a follow-up may also write the symbol into `relatedSymbols`.*
2. **`event-near` runs in the 30-s pass, not a separate 1-min timer** (plan "differs" 6) — same session gate, twice as often. *Default: accept.*
3. **Token budget** is ~1,240 worst case (plan "differs" 8). *Default: keep `publishedAt` on headlines (replay/evidence); dropping it saves ~80 tokens if the owner prefers.*
4. **Pass-level news cooldown.** The 5-min cooldown applies to the push wake AND to the pass's `news-hit` (a busy tape fires at most once per 5 min per position; unseen headlines wait and are all named in the next fire). *Default: accept — otherwise a busy tape fires every 30 s.*
5. **Macro schedule upkeep** is manual (N2): someone must extend `config/market-events.json` before its last entry; the boot warning starts 30 days ahead. *Default: owner, quarterly.*
